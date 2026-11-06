/**
 * One AudioContext for the whole game and the three buses of ADR-0002:
 *
 *   master ─ score   the score, plays from the first minute, untouched by the body
 *          ├ world   the world through the body's ears (muffled, spatial, quieter)
 *          └ head    otherworld voices: in the head, past the ears, never spatial
 *
 * The mixer is created on the "Play" click, because browsers only start audio inside a
 * gesture. Everything else — sources, filters — plugs into a bus and never touches the
 * context directly.
 */

import {
  BUSES,
  loadLevels,
  mergeLevels,
  saveLevels,
  type AudioBus,
  type AudioLevels,
} from './levels.ts';

export type LevelsPatch = Partial<Record<keyof AudioLevels, unknown>>;

export interface AudioDebug {
  state: AudioContextState | 'off';
  levels: AudioLevels;
  rms: number;
  sampleRate: number;
}

export class Mixer {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private buses: Record<AudioBus, GainNode> | null = null;
  private levels: AudioLevels;
  private resumeOnGesture: (() => void) | null = null;

  constructor(levels: AudioLevels = loadLevels()) {
    this.levels = levels;
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  get audioContext(): AudioContext | null {
    return this.context;
  }

  /** The otherworld bus, where `Speech` connects: Повитуха, the dead, the spirits. */
  get head(): GainNode | null {
    return this.buses?.head ?? null;
  }

  /** Call inside a user gesture (the Play button): creates the context and starts it. */
  unlock(): void {
    if (!this.context) this.create();
    const context = this.context;
    if (!context) return;
    void context.resume().catch(() => {});
    if (context.state !== 'running') this.armGesture();
  }

  bus(name: AudioBus): GainNode | null {
    return this.buses?.[name] ?? null;
  }

  getLevels(): AudioLevels {
    return { ...this.levels };
  }

  setLevels(patch: LevelsPatch): AudioLevels {
    this.levels = mergeLevels(this.levels, patch);
    saveLevels(this.levels);
    this.apply();
    return this.getLevels();
  }

  setMuted(muted: boolean): AudioLevels {
    return this.setLevels({ muted });
  }

  /** What `__audio.state()` shows: the context, the levels and the master RMS. */
  debug(): AudioDebug {
    const context = this.context;
    const levels = this.getLevels();
    if (!context || !this.analyser) {
      return { state: 'off', levels, rms: 0, sampleRate: 0 };
    }
    const data = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(data);
    let sum = 0;
    for (const sample of data) sum += sample * sample;
    return {
      state: context.state,
      levels,
      rms: context.state === 'running' ? Math.sqrt(sum / data.length) : 0,
      sampleRate: context.sampleRate,
    };
  }

  private create(): void {
    const global = globalThis as typeof globalThis & { webkitAudioContext?: typeof AudioContext };
    const Ctor = global.AudioContext ?? global.webkitAudioContext;
    if (!Ctor) return;
    try {
      const context = new Ctor();
      const master = context.createGain();
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      master.connect(analyser);
      analyser.connect(context.destination);
      const buses: Record<AudioBus, GainNode> = {
        score: context.createGain(),
        world: context.createGain(),
        head: context.createGain(),
      };
      for (const name of BUSES) buses[name].connect(master);
      this.context = context;
      this.master = master;
      this.analyser = analyser;
      this.buses = buses;
      this.apply(true);
    } catch {
      // No Web Audio (old browser, private mode): the game stays silent.
    }
  }

  private apply(immediate = false): void {
    const context = this.context;
    if (!context || !this.master || !this.buses) return;
    const now = context.currentTime;
    this.setGain(this.master, this.levels.muted ? 0 : this.levels.master, now, immediate);
    for (const name of BUSES) this.setGain(this.buses[name], this.levels[name], now, immediate);
  }

  private setGain(node: GainNode, value: number, now: number, immediate: boolean): void {
    node.gain.cancelScheduledValues(now);
    if (immediate) node.gain.value = value;
    else node.gain.setTargetAtTime(value, now, 0.02);
  }

  /** Browsers may ignore `resume()` outside a gesture; retry on the next one and stop then. */
  private armGesture(): void {
    if (this.resumeOnGesture) return;
    const resume = (): void => {
      const context = this.context;
      if (!context) return;
      void context
        .resume()
        .then(() => {
          if (context.state === 'running') this.disarmGesture();
        })
        .catch(() => {});
    };
    this.resumeOnGesture = resume;
    window.addEventListener('pointerdown', resume);
    window.addEventListener('keydown', resume);
  }

  private disarmGesture(): void {
    const resume = this.resumeOnGesture;
    if (!resume) return;
    window.removeEventListener('pointerdown', resume);
    window.removeEventListener('keydown', resume);
    this.resumeOnGesture = null;
  }

  /** A hidden tab is not a reason to keep the score and the wind running. */
  private readonly onVisibility = (): void => {
    const context = this.context;
    if (!context) return;
    if (document.hidden) void context.suspend().catch(() => {});
    else void context.resume().catch(() => {});
  };
}
