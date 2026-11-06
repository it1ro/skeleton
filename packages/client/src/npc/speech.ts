/**
 * Повитуха's voice. Text arrives in pieces while the model talks, so the speech splits into
 * phrases, every phrase is synthesized as soon as it is complete, and playback schedules them
 * back to back: the first phrase sounds while the rest are still being made.
 *
 * Audio is optional by design: any failure just leaves the text on screen.
 */

import { readClip, writeClip } from './tts-cache.ts';

const SENTENCE_END = '.!?…';
const PAUSE = ',—:;';
const MIN_SENTENCE = 6;
const MIN_PAUSE = 24;
const MAX_CLAUSE = 160;
const CACHE_LIMIT = 64;

export interface SpeechEvents {
  /** Time from `begin()` to the first audibly scheduled phrase. */
  onFirstAudio?: (ms: number) => void;
}

/**
 * Where the voice goes. The mixer gives the game's single context and its `head` bus:
 * Повитуха is otherworld, so she is heard past the ears and never muffled. Without an
 * output `Speech` owns a context, which keeps it usable on its own.
 */
export interface SpeechOutput {
  context: AudioContext;
  output: AudioNode;
}

export class Speech {
  private context: AudioContext | null = null;
  private gain: GainNode | null = null;
  private pending = '';
  private order: string[] = [];
  private ready = new Map<number, AudioBuffer>();
  private next = 0;
  private nextStart = 0;
  private sources: AudioBufferSourceNode[] = [];
  private cache = new Map<string, AudioBuffer>();
  /** The proxy has no key: stay silent for the rest of the session instead of asking again. */
  private muted = false;
  /** Earlier lines, so the voice follows the conversation and not just the sentence. */
  private previous: string[] = [];
  /** The voice the clips belong to, from the proxy: a different voice must not reuse old files. */
  private voice = '';
  private voiceRequest: Promise<string> | null = null;
  private startedAt = 0;
  private first = 0;
  /** Bumped on every stop: a clip that arrives late belongs to a line nobody waits for anymore. */
  private generation = 0;

  constructor(
    private readonly events: SpeechEvents = {},
    /**
     * `undefined` — Speech owns a context (standalone use); a value — the mixer's output;
     * `null` — sound is off for this session, stay silent instead of opening a second context.
     */
    private readonly external?: SpeechOutput | null,
  ) {}

  get firstAudioMs(): number {
    return this.first;
  }

  /** A new reply: drop whatever was scheduled and start the clock. */
  begin(previous: string[] = []): void {
    this.stop();
    this.previous = previous;
    this.startedAt = performance.now();
    this.first = 0;
    this.muted = false;
  }

  feed(chunk: string): void {
    if (this.muted || this.external === null) return;
    this.pending += chunk;
    for (;;) {
      const cut = breakAt(this.pending);
      if (cut <= 0) return;
      const clause = this.pending.slice(0, cut).trim();
      this.pending = this.pending.slice(cut);
      if (clause) this.enqueue(clause);
    }
  }

  /** The reply is over: speak whatever is left without a closing punctuation mark. */
  flush(): void {
    const rest = this.pending.trim();
    this.pending = '';
    if (rest) this.enqueue(rest);
  }

  /** A whole line at once: the authored replies that never went through a model. */
  say(line: string): void {
    this.begin();
    this.feed(line);
    this.flush();
  }

  stop(): void {
    this.generation += 1;
    for (const source of this.sources) {
      try {
        source.stop();
      } catch {
        // Already stopped.
      }
    }
    this.sources = [];
    this.ready.clear();
    this.order = [];
    this.pending = '';
    this.next = 0;
    this.nextStart = 0;
  }

  private enqueue(text: string): void {
    const index = this.order.length;
    this.order.push(text);
    void this.prepare(index, text);
  }

  private async prepare(index: number, text: string): Promise<void> {
    const generation = this.generation;
    const cached = this.cache.get(text);
    if (cached) {
      this.ready.set(index, cached);
      this.play();
      return;
    }

    try {
      const context = this.ensureContext();
      const key = `${await this.signature()}|${text}`;

      const stored = await readClip(key);
      if (generation !== this.generation) return;
      if (stored) {
        const buffer = await context.decodeAudioData(stored.slice(0));
        if (generation !== this.generation) return;
        this.remember(text, buffer);
        this.ready.set(index, buffer);
        this.play();
        return;
      }

      const response = await fetch('/npc/tts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, context: this.previous }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) {
        if (response.status === 503) this.muted = true;
        if (generation === this.generation) this.skip(index);
        return;
      }
      const bytes = await response.arrayBuffer();
      const buffer = await context.decodeAudioData(bytes.slice(0));
      if (generation !== this.generation) return;
      void writeClip(key, bytes);
      this.remember(text, buffer);
      this.ready.set(index, buffer);
      this.play();
    } catch {
      if (generation === this.generation) this.skip(index);
    }
  }

  /** A phrase that never arrived must not stall the ones after it. */
  private skip(index: number): void {
    const context = this.context;
    if (!context) return;
    this.ready.set(index, context.createBuffer(1, 1, context.sampleRate));
    this.play();
  }

  private play(): void {
    const context = this.context;
    const gain = this.gain;
    if (!context || !gain) return;

    while (this.ready.has(this.next)) {
      const buffer = this.ready.get(this.next);
      this.ready.delete(this.next);
      if (!buffer) break;

      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(gain);
      const at = Math.max(context.currentTime + 0.03, this.nextStart);
      source.start(at);
      this.nextStart = at + buffer.duration;
      this.sources.push(source);
      this.next += 1;

      if (!this.first && buffer.duration > 0.05) {
        this.first = Math.round(performance.now() - this.startedAt);
        this.events.onFirstAudio?.(this.first);
      }
    }
  }

  /** One health call per session: the signature changes only when the voice does. */
  private async signature(): Promise<string> {
    if (!this.voiceRequest) {
      this.voiceRequest = fetch('/npc/health')
        .then((response) => response.json())
        .then((data: { ttsKey?: unknown }) => (typeof data.ttsKey === 'string' ? data.ttsKey : ''))
        .catch(() => '');
    }
    this.voice = await this.voiceRequest;
    return this.voice;
  }

  private ensureContext(): AudioContext {
    if (!this.context) {
      const context = this.external?.context ?? new AudioContext();
      this.context = context;
      this.gain = context.createGain();
      this.gain.gain.value = 0.9;
      this.gain.connect(this.external?.output ?? context.destination);
    }
    void this.context.resume().catch(() => {});
    return this.context;
  }

  private remember(text: string, buffer: AudioBuffer): void {
    if (this.cache.size >= CACHE_LIMIT) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(text, buffer);
  }
}

/** Where the pending text can be cut so each phrase sounds finished. */
export function breakAt(text: string): number {
  for (let i = MIN_SENTENCE; i < text.length; i++) {
    const char = text[i];
    const endsHere = i + 1 === text.length || /\s/.test(text[i + 1]);
    if (!endsHere) continue;
    if (SENTENCE_END.includes(char)) return i + 1;
    if (PAUSE.includes(char) && i >= MIN_PAUSE) return i + 1;
  }
  if (text.length > MAX_CLAUSE) {
    const space = text.lastIndexOf(' ', MAX_CLAUSE);
    return space > MIN_PAUSE ? space : MAX_CLAUSE;
  }
  return 0;
}
