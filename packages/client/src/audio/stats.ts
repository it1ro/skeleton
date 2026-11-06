/**
 * Audio health for the telemetry: the state of the one `AudioContext`, the level on the master bus and
 * the playback statistics of Chrome's `AudioContext.playbackStats` — the seconds that underran, the
 * number of underrun events and how much audio actually played.
 *
 * `playbackStats` counters are cumulative for the context, so `read()` returns the delta since the
 * previous read: one telemetry sample carries what happened in its own second. Browsers without the
 * API (Firefox, Safari) get `stats: false` and null underrun fields: "not measured", never "clean".
 */

/** The counters of `AudioPlaybackStats`, all in seconds except `underrunEvents`. */
export interface PlaybackStatsLike {
  readonly underrunDuration: number;
  readonly underrunEvents: number;
  readonly totalDuration: number;
  readonly averageLatency: number;
  readonly minimumLatency: number;
  readonly maximumLatency: number;
}

/** The slice of `AudioContext` the stats need, so a test can fake it in node. */
export interface AudioContextLike {
  readonly state: AudioContextState;
  readonly sampleRate: number;
  readonly outputLatency?: number;
  readonly playbackStats?: PlaybackStatsLike;
}

/** The slice of `AnalyserNode` the stats need. */
export interface AnalyserLike {
  readonly fftSize: number;
  getFloatTimeDomainData(data: Float32Array): void;
}

export interface AudioPulse {
  /** `running`, `suspended`, `interrupted`, `closed`, or `off` when the game has no context at all. */
  state: AudioContextState | 'off';
  /** Device sample rate, Hz. */
  rate: number;
  /** Output latency, ms; from the playback stats when they track it, else `outputLatency`. */
  latencyMs: number | null;
  /** Audible glitch time since the previous read, ms; 0 is clean, null is not measured. */
  underrunMs: number | null;
  /** New glitch episodes since the previous read; 0 is clean, null is not measured. */
  underrunEvents: number | null;
  /** Audio that really played since the previous read, ms: the denominator of the glitch share. */
  playedMs: number | null;
  /** `playbackStats` exists, so the underrun fields mean something. */
  stats: boolean;
  /** Master-bus level in dBFS, −100 for silence; null while the context does not run. */
  rmsDb: number | null;
  /** Master-bus peak in dBFS; null while the context does not run. */
  peakDb: number | null;
}

/** A digital silence is exactly 0, and log(0) is −∞: the floor keeps the SQL column real. */
export const SILENCE_DB = -100;

/** Linear amplitude → dBFS, floored at {@link SILENCE_DB} and rounded to 0.1 dB. */
export function amplitudeDb(value: number): number {
  if (!(value > 0)) return SILENCE_DB;
  return Math.max(SILENCE_DB, Math.round(20 * Math.log10(value) * 10) / 10);
}

/** The pulse of a game without sound (`?audio=0`, the bench): "off", not "broken". */
export const OFF_PULSE: AudioPulse = {
  state: 'off',
  rate: 0,
  latencyMs: null,
  underrunMs: null,
  underrunEvents: null,
  playedMs: null,
  stats: false,
  rmsDb: null,
  peakDb: null,
};

function round(value: number, digits = 1): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function latencyMsOf(stats: PlaybackStatsLike | undefined, context: AudioContextLike): number | null {
  const tracked = stats && stats.averageLatency > 0 ? stats.averageLatency : 0;
  const seconds = tracked > 0 ? tracked : (context.outputLatency ?? 0);
  return seconds > 0 ? round(seconds * 1000) : null;
}

export class AudioStats {
  private readonly context: AudioContextLike;
  private readonly analyser: AnalyserLike;
  private readonly data: Float32Array;
  /** The cumulative counters at the previous read; the deltas are what a sample stores. */
  private played = 0;
  private glitched = 0;
  private episodes = 0;

  constructor(context: AudioContextLike, analyser: AnalyserLike) {
    this.context = context;
    this.analyser = analyser;
    this.data = new Float32Array(analyser.fftSize);
  }

  /** `playbackStats` is behind a newer spec; browsers without it still get state, level and latency. */
  get supported(): boolean {
    return this.context.playbackStats !== undefined;
  }

  read(): AudioPulse {
    const context = this.context;
    const stats = context.playbackStats;
    const level = context.state === 'running' ? this.measure() : null;
    return {
      state: context.state,
      rate: context.sampleRate,
      latencyMs: latencyMsOf(stats, context),
      underrunMs: stats ? round(this.take('glitched', stats.underrunDuration) * 1000) : null,
      underrunEvents: stats ? this.take('episodes', stats.underrunEvents) : null,
      playedMs: stats ? round(this.take('played', stats.totalDuration) * 1000) : null,
      stats: stats !== undefined,
      rmsDb: level ? amplitudeDb(level.rms) : null,
      peakDb: level ? amplitudeDb(level.peak) : null,
    };
  }

  /** A counter that only grows: a reset or a stale read must not produce a negative second. */
  private take(counter: 'played' | 'glitched' | 'episodes', value: number): number {
    const previous = this[counter];
    this[counter] = value;
    return Math.max(0, value - previous);
  }

  private measure(): { rms: number; peak: number } {
    this.analyser.getFloatTimeDomainData(this.data);
    let sum = 0;
    let peak = 0;
    for (const value of this.data) {
      sum += value * value;
      const magnitude = Math.abs(value);
      if (magnitude > peak) peak = magnitude;
    }
    return { rms: Math.sqrt(sum / this.data.length), peak };
  }
}
