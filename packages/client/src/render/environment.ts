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

const SKY_DAY = new Color(0x9cc4e4);
const SKY_DUSK = new Color(0xd88a5a);
const SKY_NIGHT = new Color(0x0c1424);
const SUN_DAY = new Color(0xfff1d6);
const SUN_DUSK = new Color(0xffa060);
const MOON = new Color(0x6f86b8);
/** Server tick 0 starts at this time of day (0 = midnight, 0.25 = sunrise). */
const START_TIME = 0.3;
const SHADOW_SIZE = 70;

/** Sun, moon, sky color, fog and water. Time of day comes from the server tick, so all players share it. */
export class Environment {
  readonly sun = new DirectionalLight(SUN_DAY, 3);
  private readonly hemi = new HemisphereLight(0xbfd8ff, 0x4a3f2c, 1);
  private readonly ambient = new AmbientLight(0x404860, 0.3);
  private readonly fog = new Fog(SKY_DAY.clone(), 60, 380);
  private readonly sky = SKY_DAY.clone();
  private readonly water = new Mesh(
    new PlaneGeometry(1200, 1200).rotateX(-Math.PI / 2),
    new MeshStandardMaterial({ color: 0x2c5d78, roughness: 0.15, metalness: 0.1, transparent: true, opacity: 0.82 }),
  );
  timeOfDay = START_TIME;

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

    // Light follows the sun by day and the moon by night, so there is always one shadow caster.
    const dirX = Math.cos(angle);
    const dirY = Math.max(0.15, Math.abs(height));
    this.sun.position.set(focusX + dirX * 150, focusY + dirY * 150, focusZ + 60);
    this.sun.target.position.set(focusX, focusY, focusZ);
    this.sun.color.copy(MOON).lerp(SUN_DUSK, day).lerp(SUN_DAY, day * (1 - dusk));
    this.sun.intensity = 0.35 + day * 2.6;
    this.hemi.intensity = 0.25 + day * 0.9;

    this.sky.copy(SKY_NIGHT).lerp(SKY_DUSK, Math.min(1, day * 2)).lerp(SKY_DAY, day * (1 - dusk * 0.7));
    this.fog.color.copy(this.sky);

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
