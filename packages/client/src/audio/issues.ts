/**
 * Audio problems on their way to the telemetry. The mixer and the score start on the Play click, but the
 * collector starts a moment later with the loaded world, so the first failures are buffered here — and
 * thrown away when the session runs without `?telemetry`.
 */

export interface AudioIssue extends Record<string, unknown> {
  /** `state`, `resume`, `error`, `decode`, `start`, `wind` or `unsupported`. */
  subtype: string;
}

export class IssueLog {
  /** Enough for a startup burst; the game must not grow a leak when the collector is away. */
  private static readonly LIMIT = 50;

  private sink: ((issue: AudioIssue) => void) | null = null;
  private pending: AudioIssue[] = [];

  /** `null` drops what comes: telemetry is off, and the queue is pointless. */
  setSink(sink: ((issue: AudioIssue) => void) | null): void {
    this.sink = sink;
    if (!sink) {
      this.pending.length = 0;
      return;
    }
    for (const issue of this.pending.splice(0)) sink(issue);
  }

  push(issue: AudioIssue): void {
    if (this.sink) {
      this.sink(issue);
      return;
    }
    if (this.pending.length < IssueLog.LIMIT) this.pending.push(issue);
  }
}
