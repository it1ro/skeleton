import {
  AdditiveBlending,
  AmbientLight,
  CanvasTexture,
  Color,
  DirectionalLight,
  Fog,
  HemisphereLight,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
  type Scene,
} from 'three/webgpu';
import type { Node } from 'three/webgpu';
import { BIOMES, DAY_LENGTH, TICK_DT, WATER_LEVEL, type Biome } from '@skeleton/shared';
import { applyVision, clampVision } from './vision.ts';
import { DEFAULT_SHADOW, shadowSettings, type ShadowSettings } from './shadow.ts';
import { Water } from './water.ts';
import {
  Fn,
  cameraWorldMatrix,
  mix,
  output,
  positionViewDirection,
  smoothstep,
  transformDirection,
  uniform,
  vec3,
  vec4,
} from 'three/tsl';

const SKY_DAY = new Color(0xa8bcc4);
const SKY_DUSK = new Color(0xd88a5a);
const SKY_NIGHT = new Color(0x2a3852);
/** Richer zenith colors: the top of the sky is more saturated than the foggy horizon. */
const ZENITH_DAY = new Color(0x5c7480);
const ZENITH_DUSK = new Color(0x8a4a6e);
const ZENITH_NIGHT = new Color(0x182436);
const SUN_DAY = new Color(0xfff1d6);
const SUN_DUSK = new Color(0xffa060);
const MOON = new Color(0x6f86b8);
const HEMI_SKY = new Color(0xbfd8ff);
const HEMI_GROUND = new Color(0x4a3f2c);
const AMBIENT = new Color(0x404860);

/** Server tick 0 starts at this time of day (0 = midnight, 0.25 = sunrise): pre-dawn, the sun rises as the player gathers themselves. */
const START_TIME = 0.21;
/** Share of the light and sky brightness left at vision 0: the gray start is dim and foggy, not just colorless. */
const VISION_DIM = 0.75;
/** The disc sits inside the camera far plane but past the fog far; its material turns fog off. */
const DISC_DISTANCE = 850;
const DISC_SIZE_SUN = 80;
const DISC_SIZE_MOON = 55;
/** Subtle final S-curve contrast (0 = off). */
const CURVE_CONTRAST = 0.2;
/** How much the night grade darkens the final image (0 = off, 1 = fully dark). */
const CURVE_NIGHT_GAIN = 0.86;

// --- Fog ---------------------------------------------------------------------
/** Soft blobs hugging the ground (0–2 m): hide the grass ring and LOD seams, not a full-screen effect. */
const FOG_BLOBS = 5;
const FOG_BLOB_OPACITY = 0.32;

/** A soft white radial disc: a bright core fading to transparent. Additive blending turns it into a glow. */
function makeDiscTexture(): CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const half = size / 2;
  const gradient = ctx.createRadialGradient(half, half, 0, half, half, half);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.4, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.75, 'rgba(255,255,255,0.3)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

/** A soft, wide fog blob: a gentle falloff that reads as haze when tinted by the fog color. */
function makeFogTexture(): CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const half = size / 2;
  const gradient = ctx.createRadialGradient(half, half, 0, half, half, half);
  gradient.addColorStop(0, 'rgba(255,255,255,0.8)');
  gradient.addColorStop(0.5, 'rgba(255,255,255,0.35)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

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
  /** Sky color from the time of day before `visionState` fades it; also the fog and the gradient horizon. */
  private readonly sky = SKY_DAY.clone();
  private readonly skyBase = SKY_DAY.clone();
  /** Saturated zenith color of the gradient, from the time of day before `visionState` fades it. */
  private readonly zenith = ZENITH_DAY.clone();
  private readonly zenithBase = ZENITH_DAY.clone();
  /** The sea: its own module (`render/water.ts`), fed the sky color and the sun here. */
  readonly water: Water;
  private readonly disc: Sprite;
  /** Low ground fog: a few soft planes that hug the terrain and follow the player. */
  private readonly fogBlobs: Mesh[] = [];
  /** Final color curve, applied inline by the render pipeline. */
  readonly outputNode: Node;
  private readonly curveVision = uniform(1);
  private readonly curveContrast = uniform(CURVE_CONTRAST);
  private readonly curveGain = uniform(1);
  timeOfDay = START_TIME;
  /** Days added to the shared clock: the `?time=` hook for screenshots and benches, 0 in normal play. */
  timeOffset = 0;
  /**
   * 0 — the gray world before the eyes, 1 — the normal world. Colored by default: the gray start waits for the
   * eyes in the body and the прозрение scene, `?vision=0` shows it (docs/graphics.md, «Прозрение»).
   */
  private vision = 1;
  private shadowQualityValue = 1;
  /** The shadow level in force. */
  private shadow: ShadowSettings = DEFAULT_SHADOW;

  /** 0 — gray world before the eyes, 1 — the normal world. Clamped, so the caller cannot break the colors. */
  get visionState(): number {
    return this.vision;
  }

  set visionState(value: number) {
    this.vision = clampVision(value);
  }

  /** 0 — the cheapest 512² map over ±40 m, 1 — the reference 2048² over ±70 m. Clamped like `visionState`. */
  get shadowQuality(): number {
    return this.shadowQualityValue;
  }

  set shadowQuality(value: number) {
    this.shadowQualityValue = clampVision(value);
    this.applyShadow(shadowSettings(this.shadowQualityValue));
  }

  /** Half-extent of the shadow camera box, meters: casters farther away cannot reach into it. */
  get shadowCoverage(): number {
    return this.shadow.coverage;
  }

  /** 0 — мёртвая вода (мутная, плотная), 1 — живая (чистая, прозрачная). Clamped like `visionState`. */
  get waterQuality(): number {
    return this.water.quality;
  }

  set waterQuality(value: number) {
    this.water.quality = value;
  }

  /** Ground height under a world point: the low fog hugs the terrain instead of floating at eye level. */
  private readonly heightAt: (x: number, z: number) => number;

  constructor(scene: Scene, heightAt: (x: number, z: number) => number = () => WATER_LEVEL) {
    this.heightAt = heightAt;
    this.water = new Water(scene, this.skyBase, this.zenithBase);
    // Sky gradient: horizon matches the fog color so there is no seam where the two meet. Both are fed the
    // same raw color values and go through the same tone mapping, so they stay in lock-step.
    const horizon = uniform(this.sky);
    const zenithUniform = uniform(this.zenith);
    scene.backgroundNode = Fn(() => {
      const worldDir = transformDirection(positionViewDirection, cameraWorldMatrix);
      const t = smoothstep(0.0, 0.6, worldDir.y);
      return mix(horizon, zenithUniform, t);
    })();

    // Sun/moon disc: a billboard quad that follows the sun by day and the moon (opposite) by night.
    this.disc = new Sprite(
      new SpriteMaterial({
        map: makeDiscTexture(),
        blending: AdditiveBlending,
        transparent: true,
        depthWrite: false,
        fog: false,
      }),
    );
    this.disc.scale.set(DISC_SIZE_SUN, DISC_SIZE_SUN, 1);

    // Low ground fog: a few soft planes that hug the terrain and follow the player, not a full-screen effect.
    const fogTexture = makeFogTexture();
    const blobSizes = [48, 64, 80, 56, 72];
    for (let i = 0; i < FOG_BLOBS; i++) {
      const material = new MeshBasicMaterial({
        map: fogTexture,
        transparent: true,
        opacity: FOG_BLOB_OPACITY,
        depthWrite: false,
        fog: false,
      });
      const blob = new Mesh(new PlaneGeometry(1, 1), material);
      blob.rotateX(-Math.PI / 2);
      blob.scale.set(blobSizes[i], blobSizes[i], 1);
      this.fogBlobs.push(blob);
      scene.add(blob);
    }

    // Color curve: desaturate toward gray as vision falls, then a subtle S-curve and a night gain.
    this.outputNode = Fn(() => {
      const c = output.rgb;
      const luma = c.r.mul(0.2126).add(c.g.mul(0.7152)).add(c.b.mul(0.0722));
      let col = mix(vec3(luma), c, this.curveVision);
      const x = col.clamp(0.0, 1.0);
      const s = x.mul(x).mul(3.0).sub(x.mul(x).mul(x).mul(2.0));
      col = mix(col, s, this.curveContrast);
      col = col.mul(this.curveGain);
      return vec4(col, output.a);
    })();

    this.sun.castShadow = true;
    const cam = this.sun.shadow.camera;
    cam.near = 1;
    cam.far = 400;
    this.sun.shadow.bias = -0.0005;
    this.sun.shadow.normalBias = 0.05;
    // Map size and coverage are the runtime axis (render/shadow.ts), so a bench or the player can trade
    // shadow sharpness for frame time without a rebuild.
    this.applyShadow(DEFAULT_SHADOW);
    scene.add(this.sun, this.sun.target, this.hemi, this.ambient, this.disc);
    // Fog: near flat far water and the far ring of terrain/trees, so the horizon melts into the sky.
    scene.fog = this.fog;
  }

  /** Applies a shadow level: map resolution and box. Safe to call live, the shadow node follows the light. */
  private applyShadow(settings: ShadowSettings): void {
    this.shadow = settings;
    const cam = this.sun.shadow.camera;
    cam.left = cam.bottom = -settings.coverage;
    cam.right = cam.top = settings.coverage;
    cam.updateProjectionMatrix();
    // The shadow node reallocates the map on the next shadow render when the size changes.
    this.sun.shadow.mapSize.set(settings.mapSize, settings.mapSize);
  }

  update(serverTick: number, focusX: number, focusY: number, focusZ: number, biome: Biome): void {
    this.timeOfDay = (START_TIME + this.timeOffset + (serverTick * TICK_DT) / DAY_LENGTH) % 1;
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
    this.sun.intensity = (0.6 + day * 2.35) * dim;
    this.hemi.color.copy(HEMI_SKY);
    this.hemi.groundColor.copy(HEMI_GROUND);
    applyVision(this.hemi.color, vision);
    applyVision(this.hemi.groundColor, vision);
    this.hemi.intensity = (1.0 + day * 0.15) * dim;
    this.ambient.color.copy(AMBIENT);
    applyVision(this.ambient.color, vision);
    this.ambient.intensity = (0.7 - day * 0.4) * dim;

    // Horizon (fog) and zenith colors: the gradient reads these uniforms, so they update in lock-step.
    this.skyBase.copy(SKY_NIGHT).lerp(SKY_DUSK, Math.min(1, day * 2)).lerp(SKY_DAY, day * (1 - dusk * 0.7));
    this.sky.copy(this.skyBase);
    applyVision(this.sky, vision);
    this.sky.multiplyScalar(dim);
    this.fog.color.copy(this.sky);
    // Far fog follows the biome: dense over the Погост, open in the mountains. Lerped so biome crossings
    // breathe instead of snapping.
    const [fogNear, fogFar] = BIOMES[biome].fog;
    this.fog.near += (fogNear - this.fog.near) * 0.04;
    this.fog.far += (fogFar - this.fog.far) * 0.04;

    this.zenithBase.copy(ZENITH_NIGHT).lerp(ZENITH_DUSK, Math.min(1, day * 2)).lerp(ZENITH_DAY, day * (1 - dusk * 0.7));
    this.zenith.copy(this.zenithBase);
    applyVision(this.zenith, vision);
    this.zenith.multiplyScalar(dim);

    // The water reads the raw sky and the sun; `visionState` reaches it through the global output node.
    this.water.update(focusX, focusZ, dirX, dirY, day);

    // Sun/moon disc: the visible body is above the horizon; the sun by day, the moon by night.
    const sunElev = Math.sin(angle);
    const discElev = Math.abs(sunElev);
    const discAz = sunElev >= 0 ? Math.cos(angle) : -Math.cos(angle);
    const discFade = smooth(0.0, 0.12, discElev);
    this.disc.position.set(focusX + discAz * DISC_DISTANCE, focusY + discElev * DISC_DISTANCE, focusZ);
    const discSize = DISC_SIZE_MOON + (DISC_SIZE_SUN - DISC_SIZE_MOON) * day;
    this.disc.scale.set(discSize, discSize, 1);
    this.disc.material.color.copy(MOON).lerp(SUN_DUSK, day).lerp(SUN_DAY, day * (1 - dusk));
    applyVision(this.disc.material.color, vision);
    this.disc.material.opacity = discFade * dim * 0.7;

    // Final color curve: vision drives the gray, night (1 - day) darkens the frame a touch.
    this.curveVision.value = vision;
    this.curveContrast.value = CURVE_CONTRAST;
    this.curveGain.value = 1 - (1 - CURVE_NIGHT_GAIN) * (1 - day);

    // Low fog hugs the ground around the player and drifts slowly. Each blob sits on the terrain under it,
    // not at eye level: a flat sheet at `focusY + 0.4` reads as a grey puddle on a beach and as a cloud bank
    // over the sea. Over water the low fog is skipped (the water plane would cut through it anyway).
    const simT = serverTick * TICK_DT;
    for (let i = 0; i < this.fogBlobs.length; i++) {
      const blob = this.fogBlobs[i];
      const a = (i / this.fogBlobs.length) * Math.PI * 2 + simT * 0.02;
      const r = 12 + (i % 3) * 16;
      const bx = focusX + Math.cos(a) * r;
      const bz = focusZ + Math.sin(a) * r;
      const groundY = this.heightAt(bx, bz);
      blob.visible = groundY > WATER_LEVEL - 0.2;
      blob.position.set(bx, groundY + 0.35 + Math.sin(simT * 0.15 + i * 1.9) * 0.2, bz);
      (blob.material as MeshBasicMaterial).color.copy(this.fog.color);
      (blob.material as MeshBasicMaterial).opacity = FOG_BLOB_OPACITY * dim;
    }
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
