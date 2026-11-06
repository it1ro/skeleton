import {
  AnimationMixer,
  Group,
  Vector3,
  type AnimationAction,
  type PerspectiveCamera,
  type Scene,
} from 'three/webgpu';
import type { Terrain } from '@skeleton/shared';
import { loadModel } from '../assets/models.ts';

/** Crossfade between the standing idle and the talking gesture, seconds. */
const FADE = 0.25;
/** She notices the skeleton this far away and turns to him. */
const TURN_RADIUS = 8;
/** Share of the remaining angle turned per second: an old woman does not snap around. */
const TURN_SPEED = 3.5;

/**
 * Повитуха at the spawn: the Meshy model with its own rig (docs/assets.md, «Свои клипы Meshy»). She stands in
 * `Idle` and switches to the talking gesture while the dialogue panel is open. She has no walk clips, so she only
 * turns: toward the skeleton when he comes close, back to the spawn when he leaves.
 */
export class PovituhaFigure {
  readonly root = new Group();
  readonly x: number;
  readonly z: number;
  private readonly label = document.createElement('div');
  /** Yaw that faces the spawn: her resting direction. */
  private readonly restYaw: number;
  private facing: number;
  private mixer: AnimationMixer | null = null;
  private idle: AnimationAction | null = null;
  private talk: AnimationAction | null = null;
  private talking = false;

  constructor(terrain: Terrain, scene: Scene, x: number, z: number) {
    this.x = x;
    this.z = z;
    this.root.position.set(x, terrain.heightAt(x, z), z);
    // Face the spawn: the game's forward is -Z, the model is turned inside the root.
    this.restYaw = Math.atan2(x, z);
    this.facing = this.restYaw;
    this.root.rotation.y = this.facing;
    scene.add(this.root);

    loadModel('povituha').then((model) => {
      if (!model) {
        // A missing file is a build error, not a reason to hide the spawn's only character silently.
        console.warn('povituha: model is missing, the figure stays empty');
        return;
      }
      // Meshy characters face +Z (Blender's -Y front), the game's forward is -Z; same turn as world/avatars.ts.
      model.scene.rotation.y = Math.PI;
      this.root.add(model.scene);
      this.mixer = new AnimationMixer(model.scene);
      const clips = new Map(model.animations.map((clip) => [clip.name, clip]));
      const idle = clips.get('Idle');
      const talk = clips.get('Talk');
      if (idle) this.idle = this.mixer.clipAction(idle).play();
      if (talk) this.talk = this.mixer.clipAction(talk);
      // Pose the first frame before it is drawn: the bind pose is a T-pose, not a standing old woman.
      this.mixer.update(0);
      if (this.talking) this.crossFade();
    });

    this.label.textContent = 'Повитуха';
    document.getElementById('labels')!.append(this.label);
  }

  /** Standing or talking; before the model loads the wish is remembered and applied when it does. */
  setTalking(on: boolean): void {
    if (this.talking === on) return;
    this.talking = on;
    this.crossFade();
  }

  private crossFade(): void {
    if (!this.idle || !this.talk) return;
    const [from, to] = this.talking ? [this.idle, this.talk] : [this.talk, this.idle];
    to.reset().fadeIn(FADE).play();
    from.fadeOut(FADE);
  }

  update(dt: number): void {
    this.mixer?.update(dt);
  }

  /**
   * Turns the figure: toward the skeleton while he is near, back to the spawn when he walks away. The game's
   * forward is -Z (the model is turned by π inside the root), so facing the player is `atan2(-dx, -dz)`.
   */
  look(towardX: number, towardZ: number, dt: number): void {
    const dx = towardX - this.x;
    const dz = towardZ - this.z;
    const distance = Math.hypot(dx, dz);
    // Dead centre has no direction: keep the current one instead of snapping to atan2(0, 0).
    const target =
      distance < 0.3 ? this.facing : distance < TURN_RADIUS ? Math.atan2(-dx, -dz) : this.restYaw;
    const diff = Math.atan2(Math.sin(target - this.facing), Math.cos(target - this.facing));
    this.facing += diff * Math.min(1, dt * TURN_SPEED);
    this.root.rotation.y = this.facing;
  }

  distanceTo(x: number, z: number): number {
    return Math.hypot(this.x - x, this.z - z);
  }

  updateLabel(camera: PerspectiveCamera, width: number, height: number): void {
    // She is 1.62 m: the label sits a little above the kerchief, not at the old placeholder's staff height.
    const p = new Vector3(0, 1.95, 0).add(this.root.position).project(camera);
    const visible = p.z < 1 && Math.abs(p.x) < 1.1 && Math.abs(p.y) < 1.1;
    this.label.style.display = visible ? '' : 'none';
    if (visible) {
      this.label.style.left = `${((p.x + 1) / 2) * width}px`;
      this.label.style.top = `${((1 - p.y) / 2) * height}px`;
    }
  }
}
