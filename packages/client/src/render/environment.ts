import {
  AmbientLight,
  Color,
  DirectionalLight,
  Fog,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  type Scene,
} from 'three/webgpu';
import { DAY_LENGTH, TICK_DT, WATER_LEVEL } from '@skeleton/shared';
import { applyVision, clampVision } from './vision.ts';

const SKY_DAY = new Color(0x9cc4e4);
const SKY_DUSK = new Color(0xd88a5a);
const SKY_NIGHT = new Color(0x0c1424);
const SUN_DAY = new Color(0xfff1d6);
const SUN_DUSK = new Color(0xffa060);
const MOON = new Color(0x6f86b8);
const HEMI_SKY = new Color(0xbfd8ff);
const HEMI_GROUND = new Color(0x4a3f2c);
const AMBIENT = new Color(0x404860);
const WATER = new Color(0x2c5d78);
/** Server tick 0 starts at this time of day (0 = midnight, 0.25 = sunrise). */
const START_TIME = 0.3;
const SHADOW_SIZE = 70;
/** Share of the light and sky brightness left at vision 0: the gray start is dim and foggy, not just colorless. */
const VISION_DIM = 0.75;

/**
 * Sun, moon, sky color, fog and water. Time of day comes from the server tick, so all players share it.
 *
 * `visionState` is the single gray→color hook: every color below is faded through it, and the grass and the
 * water shader read it later instead of each fading on its own.
 */
export class Environment {
  readonly sun = new DirectionalLight(SUN_DAY, 3);
  private readonly hemi = new HemisphereLight(HEMI_SKY, HEMI_GROUND, 1);
  private readonly ambient = new AmbientLight(AMBIENT, 0.3);
  private readonly fog = new Fog(SKY_DAY.clone(), 60, 380);
  private readonly sky = SKY_DAY.clone();
  /** Sky color from the time of day before `visionState` fades it. */
  private readonly skyBase = SKY_DAY.clone();
  private readonly waterMaterial = new MeshStandardMaterial({
    color: WATER,
    roughness: 0.15,
    metalness: 0.1,
    transparent: true,
    opacity: 0.82,
  });
  private readonly water = new Mesh(new PlaneGeometry(1200, 1200).rotateX(-Math.PI / 2), this.waterMaterial);
  timeOfDay = START_TIME;
  private vision = 1;

  /** 0 — gray world before the eyes, 1 — the normal world. Clamped, so the caller cannot break the colors. */
  get visionState(): number {
    return this.vision;
  }

  set visionState(value: number) {
    this.vision = clampVision(value);
  }

  constructor(scene: Scene) {
    scene.background = this.sky;
    scene.fog = this.fog;
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const cam = this.sun.shadow.camera;
    cam.left = cam.bottom = -SHADOW_SIZE;
    cam.right = cam.top = SHADOW_SIZE;
    cam.near = 1;
    cam.far = 400;
    this.sun.shadow.bias = -0.0005;
    this.sun.shadow.normalBias = 0.05;
    this.water.position.y = WATER_LEVEL;
    this.water.receiveShadow = true;
    scene.add(this.sun, this.sun.target, this.hemi, this.ambient, this.water);
  }

  update(serverTick: number, focusX: number, focusY: number, focusZ: number): void {
    this.timeOfDay = (START_TIME + (serverTick * TICK_DT) / DAY_LENGTH) % 1;
    const angle = (this.timeOfDay - 0.25) * Math.PI * 2; // 0 at sunrise
    const height = Math.sin(angle); // -1..1
    const day = smooth(-0.1, 0.25, height);
    const dusk = 1 - Math.min(1, Math.abs(height) / 0.3);
    const vision = this.vision;
    const dim = VISION_DIM + (1 - VISION_DIM) * vision;

    // Light follows the sun by day and the moon by night, so there is always one shadow caster.
    const dirX = Math.cos(angle);
    const dirY = Math.max(0.15, Math.abs(height));
    this.sun.position.set(focusX + dirX * 150, focusY + dirY * 150, focusZ + 60);
    this.sun.target.position.set(focusX, focusY, focusZ);
    this.sun.color.copy(MOON).lerp(SUN_DUSK, day).lerp(SUN_DAY, day * (1 - dusk));
    applyVision(this.sun.color, vision);
    this.sun.intensity = (0.35 + day * 2.6) * dim;
    this.hemi.color.copy(HEMI_SKY);
    this.hemi.groundColor.copy(HEMI_GROUND);
    applyVision(this.hemi.color, vision);
    applyVision(this.hemi.groundColor, vision);
    this.hemi.intensity = (0.25 + day * 0.9) * dim;
    this.ambient.color.copy(AMBIENT);
    applyVision(this.ambient.color, vision);
    this.ambient.intensity = 0.3 * dim;

    this.skyBase.copy(SKY_NIGHT).lerp(SKY_DUSK, Math.min(1, day * 2)).lerp(SKY_DAY, day * (1 - dusk * 0.7));
    this.sky.copy(this.skyBase);
    applyVision(this.sky, vision);
    this.sky.multiplyScalar(dim);
    this.fog.color.copy(this.sky);

    this.waterMaterial.color.copy(WATER);
    applyVision(this.waterMaterial.color, vision);

    // Snap to a grid so the water plane does not swim with the camera.
    this.water.position.x = Math.round(focusX / 50) * 50;
    this.water.position.z = Math.round(focusZ / 50) * 50;
  }

  get clock(): string {
    const minutes = Math.floor(this.timeOfDay * 24 * 60);
    return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  }
}

function smooth(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
