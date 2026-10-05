import { AnimationMixer, LoopOnce, type AnimationAction, type AnimationClip, type Object3D } from 'three/webgpu';
import type { MoveMode } from '@skeleton/shared';

/**
 * Clip names in anims_humanoid.glb (scripts/build-assets.ts, CLIPS). Own animations from Blender
 * must use the same names to replace these.
 */
type Clip = 'Idle' | 'Walk' | 'Jog' | 'Sprint' | 'JumpStart' | 'JumpLoop' | 'JumpLand' | 'SwimIdle' | 'Swim';

/** Speed (m/s) at which each looped move clip has no foot sliding. Measured by `npm run assets`. */
const SPEEDS: Partial<Record<Clip, number>> = { Walk: 0.97, Jog: 5.36, Sprint: 8.25, Swim: 2.18 };
const FADE = 0.2;
const IDLE_BELOW = 0.3;
const WALK_BELOW = 2.5;
const SPRINT_ABOVE = 6.8;
/** Landing pose plays only when the player stops; while moving it would freeze the legs. */
const LAND_BELOW = 1;

/** Picks and blends the clips of one character from its movement. */
export class Animator {
  private readonly mixer: AnimationMixer;
  private readonly actions = new Map<Clip, AnimationAction>();
  private current: Clip | null = null;
  /** One-shot clip in progress, locomotion waits for it. */
  private oneShot: Clip | null = null;
  private mode: MoveMode = 'ground';

  constructor(root: Object3D, clips: AnimationClip[]) {
    this.mixer = new AnimationMixer(root);
    for (const clip of clips) {
      const action = this.mixer.clipAction(clip);
      if (clip.name === 'JumpStart' || clip.name === 'JumpLand') {
        action.setLoop(LoopOnce, 1);
        action.clampWhenFinished = true;
      }
      this.actions.set(clip.name as Clip, action);
    }
    this.mixer.addEventListener('finished', (e) => {
      if (this.oneShot && e.action === this.actions.get(this.oneShot)) this.oneShot = null;
    });
  }

  update(mode: MoveMode, speed: number, dt: number): void {
    if (mode !== this.mode) {
      if (mode === 'air') this.play('JumpStart', 1.4, true);
      else if (this.mode === 'air' && mode === 'ground' && speed < LAND_BELOW) this.play('JumpLand', 1.2, true);
      else this.oneShot = null;
      this.mode = mode;
    }
    if (!this.oneShot) this.play(...this.pick(mode, speed));
    this.mixer.update(dt);
  }

  private pick(mode: MoveMode, speed: number): [Clip, number] {
    if (mode === 'swim') return speed > IDLE_BELOW ? ['Swim', this.rate('Swim', speed)] : ['SwimIdle', 1];
    if (mode === 'air') return ['JumpLoop', 1];
    if (speed < IDLE_BELOW) return ['Idle', 1];
    if (speed < WALK_BELOW) return ['Walk', this.rate('Walk', speed)];
    if (speed < SPRINT_ABOVE) return ['Jog', this.rate('Jog', speed)];
    return ['Sprint', this.rate('Sprint', speed)];
  }

  private rate(clip: Clip, speed: number): number {
    const natural = SPEEDS[clip];
    return natural ? Math.max(0.5, Math.min(2, speed / natural)) : 1;
  }

  private play(clip: Clip, timeScale: number, once = false): void {
    const action = this.actions.get(clip);
    if (!action) return;
    action.timeScale = timeScale;
    if (once) this.oneShot = clip;
    if (clip === this.current && !once) return;
    const prev = this.current ? this.actions.get(this.current) : undefined;
    action.reset().fadeIn(FADE).play();
    if (prev && prev !== action) prev.fadeOut(FADE);
    this.current = clip;
  }
}
