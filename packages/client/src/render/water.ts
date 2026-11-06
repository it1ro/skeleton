import {
  ClampToEdgeWrapping,
  Color,
  DataTexture,
  HalfFloatType,
  LinearFilter,
  Mesh,
  NodeMaterial,
  PlaneGeometry,
  RedFormat,
  Vector3,
  type Scene,
} from 'three/webgpu';
import type { Node } from 'three/webgpu';
import { WATER_LEVEL } from '@skeleton/shared';
import {
  WATER_FIELD_DEEP,
  WATER_FIELD_HALF,
  WATER_FIELD_SIZE,
  toHalf,
} from './water-field.ts';
import {
  Fn,
  cameraPosition,
  cos,
  dot,
  length,
  max,
  min,
  mix,
  modelWorldMatrix,
  mx_noise_float,
  normalize,
  oneMinus,
  positionGeometry,
  positionView,
  positionWorld,
  pow,
  reflect,
  sin,
  smoothstep,
  step,
  texture,
  time,
  uniform,
  vec2,
  vec3,
} from 'three/tsl';
import { clampVision } from './vision.ts';

/** Grid resolution of the global water plane (9.4 m cells over 1200 m): enough for the vertex waves near the camera. */
const WATER_SEGMENTS = 128;
/** Full waves/ripple/fresnel inside this radius; flat color + fog beyond. */
const WATER_NEAR = 30;
const WATER_FAR = 60;
/** Overall swell height, meters. The spectrum below sums to ~1, so this is the crest of the swell. */
const WAVE_AMPLITUDE = 0.7; // m
/** Procedural ripple: scrolling 2D Perlin noise, no textures (VRAM 0). */
const RIPPLE_SCALE = 0.9; // 1/m
const RIPPLE_SPEED = 0.15; // 1/s
/** Fresnel and sun glint: a sharp core plus a wide halo, so the sun lays a path, not a dot. */
const FRESNEL_POWER = 3;
const SPECULAR_SHARP = 420;
const SPECULAR_WIDE = 70;
const SPECULAR_STRENGTH = 1.3;
/** The glint sees a rougher sea than the fresnel: the same slope tilted more, so a low sun lays a path. */
const GLINT_ROUGHNESS = 2.2;
/** Night glint: cold and weak, only under a moon that is above the horizon. */
const MOON_GLINT = 0.22;
/** The water's own fog repeats the scene's smoothstep and turns its last pixels into a horizon line. */
const HORIZON_START = 0.9;
const HORIZON_DARK = 0.12;
/** Detail fades out with distance: a 0.8 m ripple at 200 m is sub-pixel and would shimmer. */
const DETAIL_FADE_NEAR = 120;
const DETAIL_FADE_FAR = 260;
/** The sun glint fades a little later: the path should reach the horizon without sparkling. */
const GLINT_FADE_NEAR = 150;
const GLINT_FADE_FAR = 320;
/** Water quality axis: 0 = dead water (murky, opaque), 1 = live water (clear, transparent). */
const WATER_DEAD = new Color(0x3f5146);
const WATER_LIVE = new Color(0x1c6e83);
const WATER_OPACITY_DEAD = 0.9;
const WATER_OPACITY_LIVE = 0.66;
const WATER_DEFAULT_QUALITY = 0.6;
/** Unlit deep-water brightness: ambient floor + day gain, so the sea darkens at night. */
const WATER_AMBIENT = 0.25;
const WATER_DAY_GAIN = 0.75;
/** Shallow water: the sea reads its bottom near the shore. Dead water is grey-green, live water teal. */
const WATER_SHALLOW_DEAD = new Color(0x556052);
const WATER_SHALLOW_LIVE = new Color(0x5aa79a);
/** Depth at which the body color is fully "deep", meters. */
const WATER_SHORE_DEPTH = 6;
/** Alpha at the water's edge: thin water over sand, so the wet bottom shows through. */
const WATER_MIN_OPACITY = 0.62;
/** Depth at which the body reaches its full opacity, meters: the first metres are clear, then water wins. */
const WATER_CLEAR_DEPTH = 0.35;
/** Surf: foam colour, the swash period and the band width along the shore, meters. */
const FOAM_COLOR = new Color(0xd3d9d8);
const SURF_SPEED = 0.9; // rad/s → ~7 s per wave set
const FOAM_WIDTH_MIN = 1.5;
const FOAM_WIDTH_MAX = 4.0;
/** Breakers: the band sits this many meters off the waterline, at any bottom slope. */
const BREAK_NEAR = 3.0;
const BREAK_FAR = 8.0;
/** Foam fades with distance: a 1 m band at 200 m is sub-pixel and would shimmer. */
const FOAM_FADE_NEAR = 60;
const FOAM_FADE_FAR = 160;
/** How much of the open-sea wave survives at the waterline: the rest becomes the thin swash sheet. */
const SHORE_AMPLITUDE = 0.2;
/** Swash: the horizontal run-up the eye should see on the sand, meters, at any bottom slope. */
const SWASH_RUNUP_MIN = 1.0;
const SWASH_RUNUP_MAX = 2.0;
/** Vertical crest at the waterline, meters: a flat shelf keeps its 1–2 m swash, a bank does not get a bore. */
const SWASH_AMP_MIN = 0.004;
const SWASH_AMP_MAX = 0.3;
/** Shallows: a stylized broken sky on ripple facets — a flat facet keeps the body colour (that was the film). */
const SHALLOW_SHEEN = 0.18;
/** The broken-sky patches are ~4 m wide: smaller reads as video noise, larger as a flat tint. */
const SKY_PATCH_SCALE = 0.25;
/** Crest light / trough shade: what makes a still frame read as a surface and not a tinted plane. */
const SURFACE_SHADE = 0.09;
const SHALLOW_FACET_MIN = 0.02;
const SHALLOW_FACET_MAX = 0.12;
/**
 * Foam lace: a ~2 m tear, a ~6 m hole mask and a ~0.4 m crumb. Isotropic on purpose — a coordinate stretched
 * along ∇d fans out wherever the shoreline curves (∇d turns with every seabed bump) and reads as combed hair.
 */
const FOAM_LACE_SCALE = 1.4;
const FOAM_HOLE_SCALE = 0.16;
const FOAM_CRUMB_SCALE = 4.0;
/**
 * The foam band is where the water is thinner than a crest or so: on a bumpy 0.2 m flat a width in metres
 * computed from |∇d| alone swells to 40 m, because |∇d| sees the seabed bumps, not the beach grade.
 */
const FOAM_CREST = 1.25;
/** Far water: a slow tone that survives the fog; 30–60 m folds never shimmer at 720p. */
const FAR_TONE_NEAR = 140;
const FAR_TONE_FAR = 380;
const FAR_TONE_STRENGTH = 0.09;
/** Stylized sun path: an azimuthal accent, gated by sun height (sine of elevation) so noon has none. */
const PATH_STRENGTH = 0.32;
const PATH_LOW = 0.1;
const PATH_FULL = 0.17;
const PATH_HIGH = 0.4;
const PATH_GONE = 0.55;
/** The plane snaps to this grid so it does not swim with the camera. */
const WATER_SNAP = 50;
/** The baked depth field spans [-half, +half] on both axes; UV 0..1 is that square. */
const FIELD_SPAN = WATER_FIELD_HALF * 2;

/**
 * The swell: four components blown by one wind (45 m swell, 27 m, 15 m chop crossing it, 9 m ripples on
 * its back). The directions fan around the wind, so crests are long and directional instead of a shimmer.
 * Each component is `height = a·sin(k·(d·xz) + ω·t)`; the slopes are its analytic derivative.
 * Returns vec3(height, slopeX, slopeZ); height sums to ±1.
 */
const waveField = Fn(([wxz]: [Node<'vec2'>]) => {
  const t = time;
  const p0 = wxz.x.mul(0.94).add(wxz.y.mul(0.34)).mul(0.14).add(t.mul(0.8));
  const p1 = wxz.x.mul(0.82).add(wxz.y.mul(0.57)).mul(0.23).add(t.mul(1.1));
  const p2 = wxz.x.mul(0.62).add(wxz.y.mul(0.78)).mul(0.42).add(t.mul(1.5));
  const p3 = wxz.x.mul(1.0).add(wxz.y.mul(-0.12)).mul(0.7).add(t.mul(2.1));
  const h = sin(p0).mul(0.42).add(sin(p1).mul(0.26)).add(sin(p2).mul(0.2)).add(sin(p3).mul(0.12));
  const sx = cos(p0).mul(0.055).add(cos(p1).mul(0.049)).add(cos(p2).mul(0.052)).add(cos(p3).mul(0.084));
  const sz = cos(p0).mul(0.02).add(cos(p1).mul(0.034)).add(cos(p2).mul(0.066)).add(cos(p3).mul(-0.01));
  return vec3(h, sx, sz);
});

/**
 * The sea: one plane at `WATER_LEVEL` with stylized waves, fresnel and a sun glint (issue #39).
 *
 * Vertex waves + procedural ripple + fresnel, gated by distance; no reflections and no refraction. The
 * colors are raw: the environment's output node applies `visionState` once, like grass.
 */
export class Water {
  private readonly material = new NodeMaterial();
  private readonly mesh: Mesh;
  /** Quality (0 dead→1 live), fresnel reflection sky, sun direction and the day factor. */
  private readonly qualityUniform = uniform(WATER_DEFAULT_QUALITY);
  private readonly skyUniform = uniform(new Color(0xffffff));
  private readonly zenithUniform = uniform(new Color(0xffffff));
  /** Direction to the visible body: the sun by day, the moon by night. Disc and glint share it. */
  private readonly bodyDirectionUniform = uniform(new Vector3(0, 1, 0));
  /** The body's height above the water, 0..1: gates the weak lunar glint. */
  private readonly bodyElevationUniform = uniform(0);
  private readonly dayUniform = uniform(1);
  /** Scene fog, mirrored in this material: the water gets a horizon line instead of melting into the sky. */
  private readonly fogColorUniform = uniform(new Color(0xffffff));
  private readonly fogNearUniform = uniform(60);
  private readonly fogFarUniform = uniform(380);
  /** Depth of the sea under the surface, in meters (`WATER_LEVEL - height`), baked from the terrain. */
  private readonly depthTexture: DataTexture;
  /** 1 turns the water into a depth map for checking the field; 0 in normal play. */
  private readonly debugUniform = uniform(0);
  private qualityValue = WATER_DEFAULT_QUALITY;

  /**
   * @param sky the horizon colour the fresnel reflects, @param zenith the top of the sky, @param fogColor the
   * scene fog colour. The environment mutates all three in place every frame, so the sea follows for free.
   */
  constructor(scene: Scene, sky: Color, zenith: Color, fogColor: Color) {
    this.skyUniform.value = sky;
    this.zenithUniform.value = zenith;
    this.fogColorUniform.value = fogColor;
    // The scene fog would wash the water into the sky at 380 m; the material does its own, with a horizon line.
    this.material.fog = false;
    // Deep by default: until the worker's field arrives the whole sea reads as deep water, not as a shore.
    const deep = new Uint16Array(WATER_FIELD_SIZE * WATER_FIELD_SIZE).fill(toHalf(WATER_FIELD_DEEP));
    this.depthTexture = new DataTexture(deep, WATER_FIELD_SIZE, WATER_FIELD_SIZE, RedFormat, HalfFloatType);
    this.depthTexture.minFilter = LinearFilter;
    this.depthTexture.magFilter = LinearFilter;
    this.depthTexture.wrapS = ClampToEdgeWrapping;
    this.depthTexture.wrapT = ClampToEdgeWrapping;
    this.depthTexture.needsUpdate = true;
    this.buildMaterial();
    this.mesh = new Mesh(
      new PlaneGeometry(1200, 1200, WATER_SEGMENTS, WATER_SEGMENTS).rotateX(-Math.PI / 2),
      this.material,
    );
    this.mesh.position.y = WATER_LEVEL;
    scene.add(this.mesh);
  }

  /** 0 — мёртвая вода (мутная, плотная), 1 — живая (чистая, прозрачная). Clamped like `visionState`. */
  get quality(): number {
    return this.qualityValue;
  }

  set quality(value: number) {
    this.qualityValue = clampVision(value);
    this.qualityUniform.value = this.qualityValue;
  }

  /** Uploads the baked depth field: half-float meters, row-major from the north-west corner. */
  setDepthField(data: Uint16Array): void {
    this.depthTexture.image.data = data;
    this.depthTexture.needsUpdate = true;
  }

  /** Debug view: 1 paints the depth field, 2 paints the foam; 0 is normal play. */
  set debugDepth(mode: number) {
    this.debugUniform.value = mode;
  }

  /**
   * Visible body direction (unit, sun by day / moon by night), the 0..1 day factor, the scene fog range and the
   * focus point the plane snaps to. One vector feeds both the disc (environment) and the glint.
   */
  update(
    focusX: number,
    focusZ: number,
    body: Vector3,
    day: number,
    fogNear: number,
    fogFar: number,
  ): void {
    this.bodyDirectionUniform.value.copy(body);
    this.bodyElevationUniform.value = Math.max(0, body.y);
    this.dayUniform.value = day;
    this.fogNearUniform.value = fogNear;
    this.fogFarUniform.value = fogFar;
    this.mesh.position.x = Math.round(focusX / WATER_SNAP) * WATER_SNAP;
    this.mesh.position.z = Math.round(focusZ / WATER_SNAP) * WATER_SNAP;
  }

  /** Rest depth (m) under the still surface at a world xz: positive at sea, negative on land. */
  private depthNode(wxz: Node<'vec2'>) {
    const uv = wxz.mul(1 / FIELD_SPAN).add(0.5);
    const inside = step(0.0, uv.x)
      .mul(step(uv.x, 1.0))
      .mul(step(0.0, uv.y))
      .mul(step(uv.y, 1.0));
    const sampled = texture(this.depthTexture, uv.clamp(0.0, 1.0)).r;
    return mix(WATER_FIELD_DEEP, sampled, inside);
  }

  /**
   * Depth gradient ∇d (m/m) from four field taps at half a texel. Two diagonal taps would only see the
   * derivative along one diagonal; a shore perpendicular to it would read as flat. Four taps stay cheap.
   */
  private depthGradient(wxz: Node<'vec2'>) {
    const e = 0.75;
    const dx = this.depthNode(wxz.add(vec2(e, 0.0))).sub(this.depthNode(wxz.sub(vec2(e, 0.0))));
    const dz = this.depthNode(wxz.add(vec2(0.0, e))).sub(this.depthNode(wxz.sub(vec2(0.0, e))));
    return vec2(dx, dz).mul(1 / (2 * e));
  }

  /**
   * Swash phase 0..1, led along the shore by low-frequency noise: one slow set every ~7 s, but the line
   * breathes in sections instead of as one rigid sheet.
   */
  private swashPhase(wxz: Node<'vec2'>) {
    const along = mx_noise_float(wxz.mul(0.035)).mul(0.5).add(0.5);
    return sin(time.mul(SURF_SPEED).add(along.mul(6.283185))).mul(0.5).add(0.5);
  }

  /**
   * Displacement amplitude at a depth: open sea offshore, a thin sheet at the waterline so the swell runs up
   * the sand by a metre rather than flooding it, and dead water barely moves.
   *
   * The run-up the eye sees is metres of vertical crest over the bottom slope, so the shore crest is picked
   * *from* the slope: 1–2 m of swash on a 0.02 shelf and on a 0.18 bank alike. A fixed amplitude drowns the
   * flat shelf by 7 m and deadens the bank. Only past ~1.5 m of depth does the open-sea swell take over.
   */
  private waveAmp(
    depth: Node<'float'>,
    gate: Node<'float'>,
    slope: Node<'float'>,
    swash: Node<'float'>,
  ) {
    const open = mix(SHORE_AMPLITUDE, 1.0, smoothstep(0.0, WATER_SHORE_DEPTH, depth)).mul(WAVE_AMPLITUDE);
    const shore = mix(SWASH_RUNUP_MIN, SWASH_RUNUP_MAX, swash)
      .mul(slope)
      .clamp(SWASH_AMP_MIN, SWASH_AMP_MAX);
    const live = mix(0.35, 1.0, this.qualityUniform);
    return mix(shore, open, smoothstep(0.15, 1.5, depth)).mul(gate).mul(live);
  }

  /**
   * Shading amplitude: the *normals* keep the full swell in the shallows even where the silhouette is
   * damped. A flat mirror at a grazing angle is what made the water read as wet concrete.
   */
  private surfaceAmp() {
    return mix(0.35, 1.0, this.qualityUniform).mul(WAVE_AMPLITUDE);
  }

  /**
   * The sea: depth-tinted body, transparent shallows, a breathing foam band at the waterline, fresnel sky
   * and a sun glint. The wave normals are analytic; the vertex stage only displaces the silhouette.
   */
  private buildMaterial(): void {
    const waterDead = uniform(new Color(WATER_DEAD));
    const waterLive = uniform(new Color(WATER_LIVE));
    const shallowDead = uniform(new Color(WATER_SHALLOW_DEAD));
    const shallowLive = uniform(new Color(WATER_SHALLOW_LIVE));
    const foamUniform = uniform(new Color(FOAM_COLOR));
    this.material.transparent = true;

    // Shared field samples: rest depth, the bottom slope under it, the displaced surface and its thickness.
    const worldPos = positionWorld;
    const depth = this.depthNode(worldPos.xz);
    const gate = smoothstep(WATER_FAR, WATER_NEAR, length(cameraPosition.sub(worldPos)));
    const field = waveField(worldPos.xz);
    const gradient = this.depthGradient(worldPos.xz);
    // The floor only guards a perfectly flat bed; the width stays in meters even when the slope is tiny.
    const slopeLen = max(length(gradient), 0.005);
    const swash = this.swashPhase(worldPos.xz);
    const amp = this.waveAmp(depth, gate, slopeLen, swash);
    const waterDepth = depth.add(field.x.mul(amp));
    const shadeAmp = this.surfaceAmp();
    const light = this.dayUniform.mul(WATER_DAY_GAIN).add(WATER_AMBIENT);

    // Surf: the foam band is a width along the shore (1.5–4 m), not a depth. A depth threshold stretches on a
    // flat shelf into a snow field; the field's gradient converts meters on the shore into meters of depth.
    const width = mix(FOAM_WIDTH_MIN, FOAM_WIDTH_MAX, swash);
    // Meters of band over the shore gradient, but never more than ~a crest: the wave, not the seabed noise,
    // decides how far the foam reaches.
    const bandDepth = min(width.mul(slopeLen), amp.mul(FOAM_CREST)).clamp(0.006, 0.5);
    const ragged = mx_noise_float(worldPos.xz.mul(0.9).add(vec2(time.mul(0.04), time.mul(-0.025))));
    // Breakup: a ~2 m tear with ~6 m holes and a fine crumb on the edge. Sharp masks keep a boundary; the holes
    // are what stop the band from turning back into a sheet.
    const lace = mx_noise_float(worldPos.xz.mul(FOAM_LACE_SCALE).add(vec2(time.mul(0.03), time.mul(-0.02))))
      .mul(0.5)
      .add(0.5);
    const holes = mx_noise_float(worldPos.xz.mul(FOAM_HOLE_SCALE).add(vec2(time.mul(0.015), time.mul(0.01))))
      .mul(0.5)
      .add(0.5);
    const crumb = mx_noise_float(worldPos.xz.mul(FOAM_CRUMB_SCALE).add(vec2(time.mul(0.12), time.mul(-0.08))))
      .mul(0.5)
      .add(0.5);
    const foamFade = oneMinus(smoothstep(FOAM_FADE_NEAR, FOAM_FADE_FAR, length(cameraPosition.sub(worldPos))));
    // Edge foam at the waterline; the ragged edge moves along the shore in meters, so it tears the same on a
    // gentle shelf. Breakers sit a fixed distance off the waterline instead of at a fixed depth.
    const raggedDepth = ragged.mul(bandDepth).mul(0.55);
    const torn = waterDepth.add(raggedDepth);
    // The leading edge is nearly solid — the eye needs a boundary, and it is what hides the 2 m terrain
    // polygon — while the body behind it is lace with holes.
    const edgeFoam = oneMinus(smoothstep(0.0, bandDepth.mul(0.55), torn));
    const bodyFoam = oneMinus(smoothstep(bandDepth.mul(0.55), bandDepth, torn));
    const crest = smoothstep(0.55, 0.9, field.x.mul(0.5).add(0.5));
    const breakNear = slopeLen.mul(BREAK_NEAR);
    const breakFar = slopeLen.mul(BREAK_FAR);
    const breakBand = smoothstep(breakNear, breakNear.mul(1.35), depth).mul(
      smoothstep(breakFar, breakFar.mul(0.8), depth),
    );
    // Waves do not break on a flat sandbar: without this gate a 0.02 shelf gets a 20–100 m white sheet.
    const breaking = breakBand.mul(crest).mul(0.35).mul(smoothstep(0.05, 0.1, slopeLen));
    // Whitecaps: a steep crest in open water tears white. Sparse by design — a sea of foam reads fake.
    const steep = smoothstep(0.14, 0.24, length(vec2(field.y, field.z)).mul(shadeAmp));
    const whitecap = steep.mul(crest).mul(smoothstep(2.0, 4.0, depth)).mul(0.3);
    // The lace cuts the body, the holes open it, the crumb frays the edge: a band, not a sheet.
    const laceMask = smoothstep(0.42, 0.56, lace)
      .mul(mix(0.35, 1.0, smoothstep(0.2, 0.5, holes)))
      .mul(smoothstep(0.3, 0.5, crumb).mul(0.5).add(0.5));
    const foam = max(
      edgeFoam,
      max(max(bodyFoam, breaking), whitecap).mul(laceMask),
    )
      .mul(foamFade)
      .mul(smoothstep(0.2, 0.55, this.qualityUniform));

    // Vertex waves: displace the plane by the same field the fragment shades, damped at the waterline. The
    // slope comes from the same four field taps, so the silhouette breathes by 1–2 m on a flat shelf as well.
    this.material.positionNode = Fn(() => {
      const vertexWorld = modelWorldMatrix.mul(positionGeometry).xyz;
      const vertexGate = smoothstep(WATER_FAR, WATER_NEAR, length(vertexWorld.xz.sub(cameraPosition.xz)));
      const vertexSlope = length(this.depthGradient(vertexWorld.xz));
      const vertexSwash = this.swashPhase(vertexWorld.xz);
      const vertexAmp = this.waveAmp(this.depthNode(vertexWorld.xz), vertexGate, vertexSlope, vertexSwash);
      const h = waveField(vertexWorld.xz).x.mul(vertexAmp);
      return positionGeometry.add(vec3(0.0, h, 0.0));
    })();

    // Fragment: shallows by depth, foam at the waterline, fresnel sky and sun glint over it.
    this.material.colorNode = Fn(() => {
      const eyeDir = normalize(cameraPosition.sub(worldPos));

      // Ripple detail: a scrolling noise gradient, stronger in the shallows where the swell is flattened —
      // small chop is what tells the eye "water" when the surface is seen almost edge-on.
      const cameraDistance = length(cameraPosition.sub(worldPos));
      const detailFade = oneMinus(smoothstep(DETAIL_FADE_NEAR, DETAIL_FADE_FAR, cameraDistance));
      const rippleUv = worldPos.xz.mul(1.2).add(vec2(time.mul(0.06), time.mul(0.04)));
      const eps = 0.2;
      const r0 = mx_noise_float(rippleUv);
      const rx = mx_noise_float(rippleUv.add(vec2(eps, 0.0)));
      const rz = mx_noise_float(rippleUv.add(vec2(0.0, eps)));
      const detail = oneMinus(smoothstep(0.0, 14.0, depth)).mul(0.6).add(0.4).mul(detailFade);
      const rippleSlope = vec2(rx.sub(r0), rz.sub(r0)).mul(0.25).mul(detail);

      const slope = vec2(field.y, field.z).mul(shadeAmp).add(rippleSlope);
      const normal = normalize(vec3(slope.x.negate(), 1.0, slope.y.negate()));

      const scroll = time.mul(RIPPLE_SPEED);
      const ripple = mx_noise_float(worldPos.xz.mul(RIPPLE_SCALE).add(vec2(scroll, scroll.mul(0.6))));

      const ndv = max(dot(normal, eyeDir), 0.0);
      // Shallows: the physical fresnel at a 20° view is ~2 %, so a flat facet is body colour only — that is the
      // turquoise film. The 0.2 clamp stays for flat facets, but a ripple-tilted facet may mirror the sky, so the
      // reflection breaks into moving patches instead of a grey sheet over the sand.
      const facet = smoothstep(SHALLOW_FACET_MIN, SHALLOW_FACET_MAX, length(slope));
      const shallow = oneMinus(smoothstep(0.5, 4.0, depth));
      const reflectivity = mix(mix(0.2, 1.0, facet), 1.0, smoothstep(0.0, 4.0, depth));
      const fresnel = pow(oneMinus(ndv), FRESNEL_POWER)
        .mul(0.97)
        .add(0.03)
        .mul(oneMinus(ripple.mul(0.3)))
        .mul(reflectivity);

      // The reflection is the sky gradient, not one flat colour: wave slopes pick the darker zenith and leave
      // pale streaks where they mirror the horizon — that is what gives the sea texture at a distance.
      const skyReflect = reflect(eyeDir.negate(), normal);
      const skyColor = mix(this.skyUniform, this.zenithUniform, smoothstep(0.0, 0.3, skyReflect.y));

      const body = mix(
        mix(shallowDead, shallowLive, this.qualityUniform),
        mix(waterDead, waterLive, this.qualityUniform),
        smoothstep(0.0, WATER_SHORE_DEPTH, depth),
      );

      // The glint looks at a rougher sea than the fresnel: tilting the same slope gives the sun facets to catch
      // at a 1.2 m eye, where the mirror image itself is below the frame.
      // The swell gives the path its direction; the extra high-frequency chop gives it sparkle instead of a film.
      const glintSlope = slope.add(rippleSlope.mul(GLINT_ROUGHNESS));
      const glintNormal = normalize(vec3(glintSlope.x.negate(), 1.0, glintSlope.y.negate()));
      const ref = reflect(this.bodyDirectionUniform.negate(), glintNormal);
      const sunDot = max(dot(ref, eyeDir), 0.0);
      const glint = pow(sunDot, SPECULAR_SHARP).mul(2.6).add(pow(sunDot, SPECULAR_WIDE).mul(0.6));
      const glintFade = oneMinus(smoothstep(GLINT_FADE_NEAR, GLINT_FADE_FAR, cameraDistance));
      const sunSpec = glint
        .mul(SPECULAR_STRENGTH)
        .mul(this.dayUniform)
        .mul(glintFade)
        .mul(oneMinus(foam))
        .mul(vec3(1.0, 0.95, 0.86));
      // The moon gets its own cold, weak specular under the same vector; the sun term is zero at night.
      const moonFade = oneMinus(smoothstep(0.05, 0.25, this.dayUniform)).mul(
        smoothstep(0.02, 0.12, this.bodyElevationUniform),
      );
      const moonSpec = glint
        .mul(MOON_GLINT)
        .mul(moonFade)
        .mul(glintFade)
        .mul(oneMinus(foam))
        .mul(vec3(0.55, 0.68, 0.95));
      // Stylized path (б): a warm band along the sun's bearing, laid over the physical glint. Elevation gates
      // make it full at 7:00 and gone by noon; the dot gate drops it behind the camera, the noise keeps it from a
      // ruler. The moon keeps its own cold glint untouched.
      const toPoint = worldPos.xz.sub(cameraPosition.xz);
      const toPointDir = toPoint.div(max(length(toPoint), 0.001));
      const sunAz = normalize(vec2(this.bodyDirectionUniform.x, this.bodyDirectionUniform.z));
      const azCross = toPointDir.x.mul(sunAz.y).sub(toPointDir.y.mul(sunAz.x));
      const pathBand = oneMinus(smoothstep(0.0, 0.012, azCross.mul(azCross))).mul(
        smoothstep(0.2, 0.5, dot(toPointDir, sunAz)),
      );
      const pathHeight = smoothstep(PATH_LOW, PATH_FULL, this.bodyElevationUniform).mul(
        oneMinus(smoothstep(PATH_HIGH, PATH_GONE, this.bodyElevationUniform)),
      );
      const pathBreak = mx_noise_float(
        worldPos.xz.mul(0.18).add(vec2(time.mul(0.05), time.mul(0.03))),
      )
        .mul(0.5)
        .add(0.5);
      const pathAccent = pathBand
        .mul(pathHeight)
        .mul(pathBreak)
        .mul(this.dayUniform)
        .mul(glintFade)
        .mul(oneMinus(foam))
        .mul(PATH_STRENGTH);
      const spec = sunSpec.add(moonSpec).add(pathAccent.mul(vec3(1.0, 0.93, 0.8)));

      // Wet sheen: at a 1.8 m eye the first metres sit at 20–40° where physics mirrors almost nothing. So the
      // sky is laid on in ripple-sized patches — a broken mirror, not a uniform film — and gated by day so the
      // shallows do not glow at night.
      const sheenPatch = smoothstep(
        0.3,
        0.75,
        mx_noise_float(
          worldPos.xz.mul(SKY_PATCH_SCALE).add(vec2(time.mul(0.04), time.mul(0.02))),
        )
          .mul(0.5)
          .add(0.5),
      );
      const sheen = skyColor
        .mul(shallow.mul(sheenPatch))
        .mul(SHALLOW_SHEEN)
        .mul(mix(0.35, 1.0, this.dayUniform));

      // A wave is not flat: crests catch light, troughs sink. Without this the body is one tint and the first
      // metres read as a coloured film at a high sun.
      const bodyLight = body.mul(light).mul(field.x.mul(SURFACE_SHADE).add(1.0));
      const waterColor = bodyLight
        .add(skyColor.mul(fresnel))
        .add(sheen)
        .add(spec);
      // A dark wet line right at the waterline: the eye needs a boundary, foam alone reads as milk, and this is
      // what hides the 2 m terrain polygon. Ten centimetres of depth is ~1.5 m on a beach; the lace only varies
      // its strength, never breaks it — a broken line would expose the polygon it is hiding.
      const edgeBand = oneMinus(smoothstep(0.0, 0.1, waterDepth)).mul(lace.mul(0.3).add(0.7));
      const shaded = mix(waterColor, waterColor.mul(0.45), edgeBand.mul(0.7));
      const color = mix(shaded, foamUniform.mul(light), foam);

      // Own fog: the same smoothstep as the scene (near/far follow the biome), then a 12 % darker rim at the
      // very horizon. The sea keeps a line against the sky instead of melting into it; the shore seam stays.
      const viewDepth = positionView.z.negate();
      const fog = smoothstep(this.fogNearUniform, this.fogFarUniform, viewDepth);
      const horizon = smoothstep(HORIZON_START, 1.0, fog).mul(HORIZON_DARK);
      const fogged = mix(color, this.fogColorUniform, fog).mul(oneMinus(horizon));

      // Far water: 100–400 m under the fog is a flat band. A slow tone (30–60 m folds) multiplies the fogged
      // colour, so it survives the fog instead of fighting it; the folds are far larger than a pixel at 720p.
      const farGate = smoothstep(FAR_TONE_NEAR, FAR_TONE_FAR, cameraDistance);
      const farTone = sin(dot(worldPos.xz, vec2(0.021, 0.013)).add(time.mul(0.05)))
        .add(sin(dot(worldPos.xz, vec2(-0.011, 0.026)).sub(time.mul(0.037))))
        .mul(0.5)
        .mul(FAR_TONE_STRENGTH)
        .mul(farGate);
      const farFogged = fogged.mul(farTone.add(1.0));

      // Depth debug: red is land, white shallow, dark blue deep, with a contour line every 2 m of depth.
      // Off (0) in normal play.
      const t = depth.div(WATER_FIELD_DEEP).clamp(0.0, 1.0);
      const band = depth.mul(0.5).fract();
      const line = step(band, 0.08).mul(0.45);
      const ramp = mix(vec3(0.85, 0.95, 0.95), vec3(0.05, 0.2, 0.7), t).mul(oneMinus(line));
      const debugColor = mix(vec3(0.8, 0.15, 0.1), ramp, step(0.0, depth));
      const depthMode = step(0.5, this.debugUniform).mul(step(this.debugUniform, 1.5));
      const foamMode = step(1.5, this.debugUniform);
      const depthView = mix(farFogged, debugColor, depthMode);
      return mix(depthView, vec3(foam, foam.mul(0.15), foam.mul(0.1)), foamMode);
    })();

    // Alpha by instantaneous depth: thin and clear at the edge, the body's opacity by 6 m, foam is opaque.
    // Far water turns opaque as it fogs, so the horizon rim keeps its contrast over the sky behind it.
    const bodyAlpha = mix(WATER_OPACITY_DEAD, WATER_OPACITY_LIVE, this.qualityUniform);
    const alpha = mix(
      mix(WATER_MIN_OPACITY, bodyAlpha, smoothstep(0.0, WATER_CLEAR_DEPTH, waterDepth)),
      1.0,
      foam,
    );
    const fog = smoothstep(this.fogNearUniform, this.fogFarUniform, positionView.z.negate());
    const horizonAlpha = mix(alpha, 1.0, smoothstep(0.75, 1.0, fog));
    this.material.opacityNode = mix(horizonAlpha, 1.0, this.debugUniform);
  }
}
