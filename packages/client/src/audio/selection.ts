/**
 * Which score track belongs to a place. Pure data: no Audio, no DOM, so the rules are testable in node
 * and the player can be asked for a track without touching the Web Audio graph.
 *
 * The score is a sound of the place first: the Погост bed plays in the meadows, the guard takes the score
 * when the skeleton comes close to her, and the bathhouse keeper takes it when he comes to talk. «Ирий» has
 * no scene yet — it is reachable through `?music=iriy`, `?music=cycle` and `__music.play('iriy')`.
 */
import type { Biome } from '@skeleton/shared';

/** The four Suno tracks, in cycle order. The order is also the `?music=cycle` set list. */
export const MUSIC_TRACKS = ['pogost', 'banya', 'iriy', 'nedobudka'] as const;

export type MusicTrack = (typeof MUSIC_TRACKS)[number];

/** `auto` follows the place, a track name pins the score, `cycle` auditions all four, `off` is silence. */
export type MusicMode = 'auto' | 'off' | 'cycle' | MusicTrack;

/** Seconds each track stays on in `cycle` mode: enough to recognise it, short enough to hear all four. */
export const CYCLE_SECONDS = 45;

/** Scene radii: the player must come this close to enter, and this far to leave. */
export const GUARD_ENTER = 10;
export const GUARD_EXIT = 13;
export const BANYA_ENTER = 3.6;
export const BANYA_EXIT = 5.5;

/** A zone change is held this long, so running past a character does not start a track. */
export const ZONE_ENTER_DWELL = 0.5;
export const ZONE_EXIT_DWELL = 1.5;

export interface MusicPlace {
  readonly biome: Biome;
  /** Недобудка is close enough to take the score. */
  readonly nearGuard: boolean;
  /** Повитуха is close, or the dialogue is open; the bathhouse itself is not built yet. */
  readonly nearBanya: boolean;
}

export function isMusicTrack(value: unknown): value is MusicTrack {
  return typeof value === 'string' && (MUSIC_TRACKS as readonly string[]).includes(value);
}

/** `?music=` and `__music.play()` share this parse: an unknown value falls back to `auto`. */
export function parseMusicMode(raw: string | null | undefined): MusicMode {
  if (!raw || raw === 'auto') return 'auto';
  if (raw === 'off' || raw === 'cycle') return raw;
  return isMusicTrack(raw) ? raw : 'auto';
}

/** Which track `cycle` mode plays after `seconds` since it started. */
export function cycleTrackAt(seconds: number): MusicTrack {
  const step = Math.max(0, Math.floor(seconds / CYCLE_SECONDS));
  return MUSIC_TRACKS[step % MUSIC_TRACKS.length];
}

/**
 * The score for a place. The guard scene is the most specific, then the bathhouse, then the Погост bed.
 * Outside the meadows there is no track yet: the other rings get their own music later.
 */
export function pickTrack(
  mode: MusicMode,
  place: MusicPlace,
  cycleTrack: MusicTrack = MUSIC_TRACKS[0],
): MusicTrack | null {
  if (mode === 'off') return null;
  if (mode === 'cycle') return cycleTrack;
  if (mode !== 'auto') return mode;
  if (place.nearGuard) return 'nedobudka';
  if (place.nearBanya) return 'banya';
  if (place.biome === 'meadows') return 'pogost';
  return null;
}

/**
 * Hysteresis and dwell for the two scene radii. A plain `distance < 3.6` flips every frame on the border,
 * and each flip restarts the track with a crossfade; this latch enters only after the player is inside for
 * `ZONE_ENTER_DWELL`, leaves only after `ZONE_EXIT_DWELL`, and uses a wider radius to leave.
 */
class Latch {
  private on = false;
  private timer = 0;

  constructor(
    private readonly enterDistance: number,
    private readonly exitDistance: number,
  ) {}

  get active(): boolean {
    return this.on;
  }

  update(dt: number, distance: number, forced: boolean): void {
    const inside = forced || distance < (this.on ? this.exitDistance : this.enterDistance);
    if (inside === this.on) {
      this.timer = 0;
      return;
    }
    this.timer += dt;
    if (this.timer < (inside ? ZONE_ENTER_DWELL : ZONE_EXIT_DWELL)) return;
    this.timer = 0;
    this.on = inside;
  }
}

/** Which scene zones the player is in, with hysteresis and a dwell. The choices stay in `pickTrack`. */
export class MusicZones {
  private readonly guard = new Latch(GUARD_ENTER, GUARD_EXIT);
  private readonly banya = new Latch(BANYA_ENTER, BANYA_EXIT);

  update(dt: number, guardDistance: number, banyaDistance: number, dialogueOpen: boolean): void {
    // A frame stall must not switch a zone as if the player had stood there for a second.
    const step = Math.min(Math.max(dt, 0), 0.25);
    this.guard.update(step, guardDistance, false);
    this.banya.update(step, banyaDistance, dialogueOpen);
  }

  get nearGuard(): boolean {
    return this.guard.active;
  }

  get nearBanya(): boolean {
    return this.banya.active;
  }
}

/** The player is close enough to wake Недобудка; the wake is a one-shot, not a loop. */
export const WAKE_RADIUS = 5;

export type GuardPhase = 'idle' | 'armed' | 'wake' | 'done';

export interface GuardCue {
  /** Start the wake one-shot this frame. */
  readonly wake: boolean;
  /** While the wake is playing, the score must stay on it instead of the approach loop. */
  readonly override: 'nedobudka-wake' | null;
  /** The wake has ended and the player is still in the guard zone: no score until he leaves. */
  readonly silence: boolean;
}

/**
 * The guard's musical scene: the approach loop plays while she is near; inside `WAKE_RADIUS` the wake
 * one-shot is requested once. After it ends the scene is silent until the player leaves the guard zone;
 * a new visit arms it again. There is no guard mechanic yet — this is the music of the planned scene.
 */
export class GuardScene {
  private phase: GuardPhase = 'idle';

  get current(): GuardPhase {
    return this.phase;
  }

  update(nearGuard: boolean, guardDistance: number): GuardCue {
    if (!nearGuard) {
      this.phase = 'idle';
      return { wake: false, override: null, silence: false };
    }
    if (this.phase === 'idle') this.phase = 'armed';
    if (this.phase === 'armed' && guardDistance < WAKE_RADIUS) {
      this.phase = 'wake';
      return { wake: true, override: 'nedobudka-wake', silence: false };
    }
    if (this.phase === 'wake') return { wake: false, override: 'nedobudka-wake', silence: false };
    if (this.phase === 'done') return { wake: false, override: null, silence: true };
    return { wake: false, override: null, silence: false };
  }

  /** Called by the music when the wake one-shot ends; a later call is a no-op. */
  wakeEnded(): void {
    if (this.phase === 'wake') this.phase = 'done';
  }

  reset(): void {
    this.phase = 'idle';
  }
}
