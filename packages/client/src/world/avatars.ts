import {
  AnimationMixer,
  BoxGeometry,
  CapsuleGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  Vector3,
  type AnimationAction,
  type PerspectiveCamera,
} from 'three/webgpu';
import { SNAPSHOT_EVERY, type PlayerSnapshot } from '@skeleton/shared';
import { loadModel } from '../assets/models.ts';

/** Remote players are drawn this far in the past, so there are two snapshots to blend between. */
const INTERP_DELAY_TICKS = SNAPSHOT_EVERY * 2;
const RUN_SPEED = 7;

const body = new CapsuleGeometry(0.35, 1.1, 4, 8).translate(0, 0.9, 0);
const nose = new BoxGeometry(0.2, 0.15, 0.3).translate(0, 1.45, -0.35);

/**
 * One player's figure. Uses `player.glb` when the friend's model is in src/assets/models,
 * with optional `Idle` / `Walk` / `Run` clips; a capsule until then.
 */
export class Avatar {
  readonly root = new Group();
  private readonly label = document.createElement('div');
  private mixer: AnimationMixer | null = null;
  private actions: Partial<Record<'Idle' | 'Walk' | 'Run', AnimationAction>> = {};
  private current: AnimationAction | null = null;
  private facing = 0;

  constructor(name: string, color: number) {
    const material = new MeshStandardMaterial({ color, roughness: 0.8 });
    const placeholder = new Group();
    placeholder.add(new Mesh(body, material), new Mesh(nose, material));
    placeholder.traverse((o) => (o.castShadow = true));
    this.root.add(placeholder);

    this.label.textContent = name;
    document.getElementById('labels')!.append(this.label);

    void loadModel('player').then((model) => {
      if (!model) return;
      this.root.remove(placeholder);
      // Blender characters face -Y (front view), which glTF turns into +Z; the game's forward is -Z.
      model.scene.rotation.y = Math.PI;
      this.root.add(model.scene);
      this.mixer = new AnimationMixer(model.scene);
      for (const clip of model.animations) {
        if (clip.name === 'Idle' || clip.name === 'Walk' || clip.name === 'Run') {
          this.actions[clip.name] = this.mixer.clipAction(clip);
        }
      }
    });
  }

  /** Turns the figure toward its movement, like Valheim: the camera stays free. */
  place(x: number, y: number, z: number, dx: number, dz: number, speed: number, dt: number): void {
    if (Math.hypot(dx, dz) > 1e-3) {
      const target = Math.atan2(-dx, -dz);
      let diff = target - this.facing;
      diff = Math.atan2(Math.sin(diff), Math.cos(diff));
      this.facing += diff * Math.min(1, dt * 12);
    }
    this.root.position.set(x, y, z);
    this.root.rotation.y = this.facing;
    this.animate(speed, dt);
  }

  private animate(speed: number, dt: number): void {
    if (!this.mixer) return;
    const next = speed > RUN_SPEED ? this.actions.Run : speed > 0.5 ? this.actions.Walk : this.actions.Idle;
    if (next && next !== this.current) {
      next.reset().fadeIn(0.2).play();
      this.current?.fadeOut(0.2);
      this.current = next;
    }
    this.mixer.update(dt);
  }

  updateLabel(camera: PerspectiveCamera, width: number, height: number): void {
    const p = new Vector3(0, 2.2, 0).add(this.root.position).project(camera);
    const visible = p.z < 1 && Math.abs(p.x) < 1.1 && Math.abs(p.y) < 1.1;
    this.label.style.display = visible ? '' : 'none';
    if (visible) {
      this.label.style.left = `${((p.x + 1) / 2) * width}px`;
      this.label.style.top = `${((1 - p.y) / 2) * height}px`;
    }
  }

  dispose(): void {
    this.label.remove();
    this.root.removeFromParent();
  }
}

interface Sample {
  tick: number;
  snap: PlayerSnapshot;
}

/** Other players: snapshot buffer, drawn with interpolation. */
export class RemotePlayers {
  readonly root = new Group();
  private readonly players = new Map<number, { avatar: Avatar; samples: Sample[]; last: Vector3 }>();

  get count(): number {
    return this.players.size;
  }

  push(tick: number, snaps: PlayerSnapshot[], selfId: number): void {
    const seen = new Set<number>();
    for (const snap of snaps) {
      if (snap.id === selfId) continue;
      seen.add(snap.id);
      let p = this.players.get(snap.id);
      if (!p) {
        p = { avatar: new Avatar(snap.name, snap.color), samples: [], last: new Vector3(snap.x, snap.y, snap.z) };
        this.players.set(snap.id, p);
        this.root.add(p.avatar.root);
      }
      p.samples.push({ tick, snap });
      if (p.samples.length > 20) p.samples.shift();
    }
    for (const id of this.players.keys()) if (!seen.has(id)) this.remove(id);
  }

  remove(id: number): void {
    this.players.get(id)?.avatar.dispose();
    this.players.delete(id);
  }

  /** `serverTick` is the client's estimate of the current server tick (fractional). */
  update(serverTick: number, dt: number, camera: PerspectiveCamera, width: number, height: number): void {
    const t = serverTick - INTERP_DELAY_TICKS;
    for (const p of this.players.values()) {
      const s = p.samples;
      let a = s[0];
      let b = s[s.length - 1];
      for (let i = 0; i < s.length - 1; i++) {
        if (s[i].tick <= t && s[i + 1].tick >= t) {
          a = s[i];
          b = s[i + 1];
          break;
        }
      }
      const k = b.tick === a.tick ? 1 : Math.max(0, Math.min(1, (t - a.tick) / (b.tick - a.tick)));
      const x = a.snap.x + (b.snap.x - a.snap.x) * k;
      const y = a.snap.y + (b.snap.y - a.snap.y) * k;
      const z = a.snap.z + (b.snap.z - a.snap.z) * k;
      p.avatar.place(x, y, z, x - p.last.x, z - p.last.z, b.snap.speed, dt);
      p.last.set(x, y, z);
      p.avatar.updateLabel(camera, width, height);
    }
  }
}
