/** Summary of frame times, all times in milliseconds. */
export interface FrameStats {
  frames: number;
  /** Sum of the measured frame times, not wall-clock time. */
  durationMs: number;
  fps: number;
  /** Frame time at the 95th percentile: the slow tail, not the average. */
  fpsP95: number;
  p50: number;
  p95: number;
  min: number;
  max: number;
}

export function frameStats(times: number[]): FrameStats {
  if (times.length === 0) {
    return { frames: 0, durationMs: 0, fps: 0, fpsP95: 0, p50: 0, p95: 0, min: 0, max: 0 };
  }
  const sorted = [...times].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)))];
  const total = times.reduce((sum, time) => sum + time, 0);
  const mean = total / times.length;
  const p50 = at(0.5);
  const p95 = at(0.95);
  return {
    frames: times.length,
    durationMs: total,
    fps: mean > 0 ? 1000 / mean : 0,
    fpsP95: p95 > 0 ? 1000 / p95 : 0,
    p50,
    p95,
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}
