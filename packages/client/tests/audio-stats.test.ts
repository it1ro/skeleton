import { describe, expect, it } from 'vitest';
import { IssueLog, type AudioIssue } from '../src/audio/issues.ts';
import {
  AudioStats,
  SILENCE_DB,
  amplitudeDb,
  type AnalyserLike,
  type AudioContextLike,
  type PlaybackStatsLike,
} from '../src/audio/stats.ts';

interface Harness {
  audio: AudioStats;
  context: AudioContextLike & { state: AudioContextState };
  stats: PlaybackStatsLike & {
    underrunDuration: number;
    underrunEvents: number;
    totalDuration: number;
    averageLatency: number;
  };
}

function harness(options: {
  state?: AudioContextState;
  outputLatency?: number;
  withStats?: boolean;
  signal?: number[];
} = {}): Harness {
  const counters = {
    underrunDuration: 0,
    underrunEvents: 0,
    totalDuration: 0,
    averageLatency: 0,
    minimumLatency: 0,
    maximumLatency: 0,
  };
  const context = {
    state: options.state ?? 'running',
    sampleRate: 48000,
    outputLatency: options.outputLatency ?? 0.04,
    ...(options.withStats === false ? {} : { playbackStats: counters }),
  };
  const signal = options.signal ?? new Array<number>(1024).fill(0.5);
  const analyser: AnalyserLike = {
    fftSize: signal.length,
    getFloatTimeDomainData: (data: Float32Array) => data.set(signal),
  };
  return { audio: new AudioStats(context, analyser), context, stats: counters };
}

describe('amplitudeDb', () => {
  it('maps full scale to 0 dBFS and half scale to −6 dBFS', () => {
    expect(amplitudeDb(1)).toBe(0);
    expect(amplitudeDb(0.5)).toBe(-6);
    expect(amplitudeDb(0.1)).toBe(-20);
  });

  it('floors silence and rejects junk instead of returning −∞', () => {
    expect(amplitudeDb(0)).toBe(SILENCE_DB);
    expect(amplitudeDb(-0.5)).toBe(SILENCE_DB);
    expect(amplitudeDb(Number.NaN)).toBe(SILENCE_DB);
  });
});

describe('AudioStats', () => {
  it('reports the state, the rate and the device latency', () => {
    const { audio } = harness({ state: 'running' });
    const pulse = audio.read();
    expect(pulse.state).toBe('running');
    expect(pulse.rate).toBe(48000);
    expect(pulse.latencyMs).toBe(40);
    expect(pulse.stats).toBe(true);
  });

  it('prefers the tracked average latency over outputLatency', () => {
    const { audio, stats } = harness();
    stats.averageLatency = 0.02;
    expect(audio.read().latencyMs).toBe(20);
  });

  it('turns cumulative counters into one-second deltas', () => {
    const { audio, stats } = harness();
    stats.totalDuration = 1;
    stats.underrunDuration = 0.012;
    stats.underrunEvents = 1;
    const first = audio.read();
    expect(first.playedMs).toBe(1000);
    expect(first.underrunMs).toBe(12);
    expect(first.underrunEvents).toBe(1);

    stats.totalDuration = 2;
    const second = audio.read();
    expect(second.playedMs).toBe(1000);
    expect(second.underrunMs).toBe(0);
    expect(second.underrunEvents).toBe(0);
  });

  it('never reports a negative second when the counters reset', () => {
    const { audio, stats } = harness();
    stats.totalDuration = 10;
    audio.read();
    stats.totalDuration = 0;
    expect(audio.read().playedMs).toBe(0);
  });

  it('marks the underruns as not measured without playbackStats', () => {
    const { audio } = harness({ withStats: false });
    const pulse = audio.read();
    expect(pulse.stats).toBe(false);
    expect(pulse.underrunMs).toBeNull();
    expect(pulse.underrunEvents).toBeNull();
    expect(pulse.playedMs).toBeNull();
    expect(pulse.latencyMs).toBe(40);
  });

  it('reads the master level in dBFS', () => {
    const { audio } = harness({ signal: new Array<number>(1024).fill(0.5) });
    const pulse = audio.read();
    expect(pulse.rmsDb).toBe(-6);
    expect(pulse.peakDb).toBe(-6);
  });

  it('floors a silent master instead of writing −∞', () => {
    const { audio } = harness({ signal: new Array<number>(1024).fill(0) });
    expect(audio.read().rmsDb).toBe(SILENCE_DB);
  });

  it('has no level while the context does not run', () => {
    const { audio } = harness({ state: 'suspended' });
    const pulse = audio.read();
    expect(pulse.rmsDb).toBeNull();
    expect(pulse.peakDb).toBeNull();
  });
});

describe('IssueLog', () => {
  it('buffers issues until the telemetry is listening', () => {
    const log = new IssueLog();
    log.push({ subtype: 'decode', track: 'pogost' });
    const seen: AudioIssue[] = [];
    log.setSink((issue) => seen.push(issue));
    expect(seen).toEqual([{ subtype: 'decode', track: 'pogost' }]);
    log.push({ subtype: 'start' });
    expect(seen.map((issue) => issue.subtype)).toEqual(['decode', 'start']);
  });

  it('drops the queue when the session runs without telemetry', () => {
    const log = new IssueLog();
    log.push({ subtype: 'resume' });
    log.setSink(null);
    const seen: AudioIssue[] = [];
    log.setSink((issue) => seen.push(issue));
    expect(seen).toEqual([]);
  });

  it('caps the queue so a missing collector cannot grow it', () => {
    const log = new IssueLog();
    for (let i = 0; i < 80; i++) log.push({ subtype: 'state', i });
    const seen: AudioIssue[] = [];
    log.setSink((issue) => seen.push(issue));
    expect(seen).toHaveLength(50);
  });
});
