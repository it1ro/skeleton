import { TICK_DT, stepPlayer, type PlayerInput, type PlayerState, type Terrain } from '@skeleton/shared';

/** Visual correction after a server mismatch fades out over this time (s). */
const CORRECTION_TIME = 0.15;

/**
 * Client-side prediction: the local player moves at once with the shared movement code,
 * then rewinds to the server state on each snapshot and replays the inputs the server has not seen yet.
 */
export class LocalPlayer {
  state: PlayerState;
  private prev: PlayerState;
  private seq = 0;
  private pending: PlayerInput[] = [];
  private outbox: PlayerInput[] = [];
  private readonly correction = { x: 0, y: 0, z: 0 };
  /** Horizontal speed, for the walk animation. */
  speed = 0;

  constructor(
    private readonly terrain: Terrain,
    spawn: PlayerState,
  ) {
    this.state = { ...spawn };
    this.prev = { ...spawn };
  }

  step(intent: Omit<PlayerInput, 'seq'>): void {
    const input: PlayerInput = { ...intent, seq: ++this.seq };
    this.prev = { ...this.state };
    stepPlayer(this.state, input, TICK_DT, this.terrain);
    this.speed = Math.hypot(this.state.x - this.prev.x, this.state.z - this.prev.z) / TICK_DT;
    this.pending.push(input);
    this.outbox.push(input);
  }

  /** Inputs to send to the server since the last call. */
  takeOutbox(): PlayerInput[] {
    const out = this.outbox;
    this.outbox = [];
    return out;
  }

  reconcile(server: Pick<PlayerState, 'x' | 'y' | 'z' | 'yaw' | 'vy' | 'grounded'>, ack: number): void {
    const before = { ...this.state };
    this.pending = this.pending.filter((i) => i.seq > ack);
    const s: PlayerState = { ...server };
    for (const input of this.pending) stepPlayer(s, input, TICK_DT, this.terrain);
    this.state = s;

    const dx = before.x - s.x;
    const dy = before.y - s.y;
    const dz = before.z - s.z;
    if (Math.hypot(dx, dy, dz) > 5) return; // Teleport: no smoothing.
    this.correction.x += dx;
    this.correction.y += dy;
    this.correction.z += dz;
    this.prev.x -= dx;
    this.prev.y -= dy;
    this.prev.z -= dz;
  }

  /** Position to draw: between the last two fixed steps, plus the fading correction. */
  renderPosition(alpha: number, dt: number): { x: number; y: number; z: number } {
    const k = Math.exp(-dt / CORRECTION_TIME);
    this.correction.x *= k;
    this.correction.y *= k;
    this.correction.z *= k;
    return {
      x: this.prev.x + (this.state.x - this.prev.x) * alpha + this.correction.x,
      y: this.prev.y + (this.state.y - this.prev.y) * alpha + this.correction.y,
      z: this.prev.z + (this.state.z - this.prev.z) * alpha + this.correction.z,
    };
  }
}
