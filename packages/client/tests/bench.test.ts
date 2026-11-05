import { describe, expect, it } from 'vitest';
import { frameStats } from '../src/bench/stats.ts';

describe('frameStats', () => {
  it('summarizes frame times', () => {
    const stats = frameStats([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    expect(stats.frames).toBe(10);
    expect(stats.durationMs).toBe(145);
    expect(stats.fps).toBeCloseTo(1000 / 14.5, 6);
    expect(stats.p50).toBe(15);
    expect(stats.p95).toBe(19);
    expect(stats.fpsP95).toBeCloseTo(1000 / 19, 6);
    expect(stats.min).toBe(10);
    expect(stats.max).toBe(19);
  });

  it('returns zeros for an empty run', () => {
    expect(frameStats([])).toEqual({
      frames: 0,
      durationMs: 0,
      fps: 0,
      fpsP95: 0,
      p50: 0,
      p95: 0,
      min: 0,
      max: 0,
    });
  });

  it('turns a 60 Hz frame into 60 fps', () => {
    const stats = frameStats([1000 / 60]);
    expect(stats.fps).toBeCloseTo(60, 6);
    expect(stats.p50).toBeCloseTo(1000 / 60, 6);
  });
});
