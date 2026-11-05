/** A main-thread build longer than half a 60 fps frame, recorded for the moving benchmark. */
export interface Hitch {
  /** `performance.now()` when the build finished. */
  at: number;
  ms: number;
  kind: string;
}

const hitches: Hitch[] = [];
const THRESHOLD_MS = 8;

export function recordHitch(kind: string, startedAt: number): void {
  const ms = performance.now() - startedAt;
  if (ms < THRESHOLD_MS) return;
  hitches.push({ at: performance.now(), ms, kind });
}

export function takeHitches(): Hitch[] {
  return hitches.splice(0, hitches.length);
}
