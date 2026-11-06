import {
  MAX_MINUTES,
  MAX_PATIENCE,
  POVITUHA,
  buildVoicePrompt,
  interpret,
  startTalk,
  talk,
  type TalkState,
} from '@skeleton/shared';
import { Speech, type SpeechOutput } from './speech.ts';
import { voiceLine, type VoiceReply } from './voice.ts';

type Who = 'her' | 'me' | 'note';

const FACT_LABEL: Record<string, string> = { test: 'испытание', debt: 'долг', insult: 'обида' };

/** A session's model spend, shown next to the meters so a conversation has a price. */
interface Totals {
  calls: number;
  ms: number;
  costUsd: number;
  priced: boolean;
}

function formatMs(ms: number): string {
  return ms < 1000 ? `${ms} мс` : `${(ms / 1000).toFixed(1)} с`;
}

function formatCost(usd: number): string {
  if (usd === 0) return '$0';
  return usd < 0.01 ? `$${usd.toPrecision(2)}` : `$${usd.toFixed(3)}`;
}

export interface TalkOptions {
  /** Re-voice the authored line through the local proxy. Off by default: the game stays offline. */
  llm: boolean;
  onClose: () => void;
  /** The mixer's `head` bus: otherworld voices are heard past the ears. */
  audio?: SpeechOutput;
}

/**
 * The conversation panel. The state and the rules live in `shared/src/npc`; this only shows them
 * and passes free text through the act interpreter.
 */
export class TalkPanel {
  private readonly root: HTMLDivElement;
  private readonly logEl: HTMLDivElement;
  private readonly factsEl: HTMLDivElement;
  private readonly patienceEl: HTMLElement;
  private readonly clockEl: HTMLElement;
  private readonly totalEl: HTMLElement;
  private readonly textarea: HTMLTextAreaElement;
  private readonly form: HTMLFormElement;
  private readonly send: HTMLButtonElement;
  private readonly history: string[] = [];
  private readonly totals: Totals = { calls: 0, ms: 0, costUsd: 0, priced: false };
  private readonly speech: Speech;
  private metricEl: HTMLElement | null = null;
  private metricBase = '';
  private turnAudioMs = 0;
  private state: TalkState | null = null;
  private visible = false;
  private busy = false;
  private ended = false;

  constructor(private readonly opts: TalkOptions) {
    this.speech = new Speech({ onFirstAudio: (ms) => this.onFirstAudio(ms) }, opts.audio ?? null);
    this.root = document.createElement('div');
    this.root.id = 'talk';
    this.root.className = 'hidden';
    this.root.innerHTML = `
      <div class="talk-head">
        <div class="talk-name"><b>Повитуха</b><span>принимает мёртвых в жизнь</span></div>
        <div class="talk-meters">
          <span class="talk-patience"></span>
          <span class="talk-clock"></span>
          <span class="talk-total"></span>
          <button type="button" class="talk-close" aria-label="Уйти">×</button>
        </div>
      </div>
      <div class="talk-log"></div>
      <div class="talk-facts"></div>
      <form class="talk-input">
        <textarea rows="1" maxlength="400" placeholder="Скажи по делу…"></textarea>
        <button type="submit">Сказать</button>
      </form>
      <div class="talk-hint">Enter — сказать · Shift+Enter — новая строка · Esc — уйти · чем короче речь, тем жарче баня</div>
    `;
    document.body.append(this.root);

    this.logEl = this.root.querySelector('.talk-log') as HTMLDivElement;
    this.factsEl = this.root.querySelector('.talk-facts') as HTMLDivElement;
    this.patienceEl = this.root.querySelector('.talk-patience') as HTMLElement;
    this.clockEl = this.root.querySelector('.talk-clock') as HTMLElement;
    this.totalEl = this.root.querySelector('.talk-total') as HTMLElement;
    this.textarea = this.root.querySelector('textarea') as HTMLTextAreaElement;
    this.form = this.root.querySelector('.talk-input') as HTMLFormElement;
    this.send = this.root.querySelector('.talk-input button') as HTMLButtonElement;

    this.form.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.submit();
    });
    this.textarea.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        this.form.requestSubmit();
      }
    });
    (this.root.querySelector('.talk-close') as HTMLButtonElement).addEventListener('click', () => this.close());
    window.addEventListener('keydown', (event) => {
      if (event.code === 'Escape' && this.visible) {
        event.preventDefault();
        this.close();
      }
    });
  }

  get isOpen(): boolean {
    return this.visible;
  }

  open(): void {
    this.visible = true;
    this.root.classList.remove('hidden');
    if (!this.state) {
      const opening = startTalk();
      this.state = opening.state;
      this.push('note', 'Она слышит мёртвых — слова тебе пока не нужны.');
      this.push('her', opening.line);
      // Her first line is known before any model call: say it at once, and warm the voice connection.
      this.speech.say(opening.line);
      this.history.push(`Повитуха: ${opening.line}`);
    }
    this.renderMeters();
    this.renderFacts();
    if (this.ended) this.renderEnd();
    this.scroll();
    if (!this.ended) setTimeout(() => this.textarea.focus(), 0);
  }

  close(): void {
    if (!this.visible) return;
    this.visible = false;
    this.root.classList.add('hidden');
    this.speech.stop();
    this.opts.onClose();
  }

  private async submit(): Promise<void> {
    if (!this.state || this.busy || this.ended) return;
    const text = this.textarea.value.trim();
    if (!text) return;

    this.textarea.value = '';
    this.push('me', text);
    this.setBusy(true);
    this.turnAudioMs = 0;
    this.metricEl = null;
    this.speech.begin(this.history.slice(-4));

    const beat = talk(this.state, interpret(text));
    this.state = beat.state;

    let line = beat.line;
    let reply: VoiceReply | null = null;
    let elapsed = 0;
    let firstMs = 0;
    // A holder, not a plain local: the closure assigns it while the reply streams.
    const streamed: { el: HTMLElement | null } = { el: null };
    if (this.opts.llm) {
      const started = performance.now();
      reply = await voiceLine(buildVoicePrompt(POVITUHA, beat.state, beat, text, this.history.slice(-6)), (delta) => {
        // The first delta is the moment the player hears her: measure it, then let the line grow.
        if (!streamed.el) {
          streamed.el = this.push('her', '');
          firstMs = Math.round(performance.now() - started);
        }
        streamed.el.textContent += delta;
        this.speech.feed(delta);
        this.scroll();
      });
      elapsed = Math.round(performance.now() - started);
      if (reply) line = reply.text;
    } else {
      // A short pause reads as thought; the authored line does not need to appear instantly.
      await new Promise((resolve) => setTimeout(resolve, 320));
    }

    if (reply) {
      this.speech.flush();
      if (streamed.el) streamed.el.textContent = reply.text;
      else this.push('her', line);
      this.meter(elapsed, reply, firstMs);
    } else if (streamed.el) {
      this.push('note', 'Связь оборвалась — реплика не дописана.');
    } else {
      if (this.opts.llm) this.push('note', 'Модель не ответила — реплика авторская.');
      this.push('her', line);
      this.speech.say(line);
    }
    this.history.push(`Герой: ${text}`, `Повитуха: ${line}`);
    this.setBusy(false);
    this.renderMeters();
    this.renderFacts();
    if (beat.end) {
      this.ended = true;
      this.renderEnd();
    }
    this.scroll();
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    if (this.ended) {
      this.renderEnd();
      return;
    }
    this.textarea.disabled = busy;
    this.send.disabled = busy;
    this.textarea.placeholder = busy ? 'Повитуха молчит…' : 'Скажи по делу…';
    if (!busy && this.visible) this.textarea.focus();
  }

  private renderEnd(): void {
    this.textarea.disabled = true;
    this.send.disabled = true;
    this.textarea.placeholder = 'Разговор окончен';
  }

  private renderMeters(): void {
    const patience = Math.max(0, Math.min(MAX_PATIENCE, this.state?.patience ?? MAX_PATIENCE));
    this.patienceEl.textContent = `терпение ${'●'.repeat(patience)}${'○'.repeat(MAX_PATIENCE - patience)}`;
    const minutes = this.state?.minutes ?? 0;
    this.clockEl.textContent = `баня ${minutes}/${MAX_MINUTES} мин`;
    this.clockEl.classList.toggle('cold', minutes >= MAX_MINUTES * 0.6);
  }

  private renderFacts(): void {
    const facts = this.state?.facts ?? [];
    this.factsEl.replaceChildren(
      ...facts.map((fact) => {
        const chip = document.createElement('span');
        chip.textContent = `${FACT_LABEL[fact.kind] ?? fact.kind}: ${fact.text}`;
        return chip;
      }),
    );
  }

  private push(who: Who, text: string): HTMLElement {
    const line = document.createElement('div');
    line.className = `talk-line ${who}`;
    line.textContent = text;
    this.logEl.append(line);
    this.scroll();
    return line;
  }

  private scroll(): void {
    if (this.visible) this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  /** The first phrase is audible: the metric appeared before the voice did, so fill it in now. */
  private onFirstAudio(ms: number): void {
    this.turnAudioMs = ms;
    this.paintMetric();
  }

  private paintMetric(): void {
    if (!this.metricEl) return;
    const sound = this.turnAudioMs > 0 ? ` · звук ${formatMs(this.turnAudioMs)}` : '';
    this.metricEl.textContent = this.metricBase + sound;
  }

  /** Dev-only: how long the model took and what the line cost. Hidden without a model. */
  private meter(ms: number, reply: VoiceReply, firstMs: number): void {
    const metric = document.createElement('div');
    metric.className = 'talk-metric';
    const cost = reply.priced ? ` · ${formatCost(reply.costUsd)}` : '';
    // Streamed replies show both moments: the first phrase, then the finished line.
    const time = firstMs > 0 ? `${formatMs(firstMs)} → ${formatMs(ms)}` : formatMs(ms);
    this.metricBase = `${time} · ${reply.tokensIn}→${reply.tokensOut} ток${cost}`;
    this.metricEl = metric;
    this.paintMetric();
    this.logEl.append(metric);
    this.scroll();

    this.totals.calls += 1;
    this.totals.ms += ms;
    this.totals.costUsd += reply.costUsd;
    this.totals.priced = this.totals.priced || reply.priced;
    const average = Math.round(this.totals.ms / this.totals.calls);
    this.totalEl.textContent = [
      `${this.totals.calls} репл.`,
      `ср. ${formatMs(average)}`,
      this.totals.priced ? formatCost(this.totals.costUsd) : '',
    ]
      .filter(Boolean)
      .join(' · ');
  }
}
