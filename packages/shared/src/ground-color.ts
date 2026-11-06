/**
 * Ground vertex color: the earth as a canvas, not a flat green field.
 *
 * The color of a terrain vertex is a pure, deterministic function of its biome, height, slope and world
 * position. It is seed-independent (like the biome palette), so two worlds with different seeds share the
 * same material feel and the same chunk colors meet without a seam. This is the first pass of
 * `docs/graphics.md` «Палитра и земля»: muted moss/olive greens, patches of moss, earth, ash and puddles
 * instead of one saturated meadow.
 *
 * Rules from `docs/graphics.md`:
 * - **Пятна, не ковёр.** Patches by noise, not a uniform carpet.
 * - **Значение важнее оттенка.** Moss, earth, ash and puddles differ in brightness, so the frame reads
 *   in gray (`?vision=0`).
 * - **Земля на склоне.** Flat ground grows moss, a slope exposes earth, a cliff exposes rock.
 */

import type { Biome } from './terrain.ts';

/** sRGB→linear, bit-identical to three.js `ColorManagement.SRGBToLinear`. */
function srgbToLinear(c: number): number {
  return c < 0.04045 ? c * 0.0773993808 : Math.pow(c * 0.9478672986 + 0.0521327014, 2.4);
}

type Rgb = readonly [number, number, number];

/** Linear RGB from an sRGB hex, like three.js `new Color(hex)`. */
const rgb = (hex: number): Rgb => [
  srgbToLinear(((hex >> 16) & 255) / 255),
  srgbToLinear(((hex >> 8) & 255) / 255),
  srgbToLinear((hex & 255) / 255),
];

/** Above this height the world is snow. Matches the previous worker threshold. */
const SNOW_LINE = 62;

/** Biome base colors, muted toward moss and olive (`docs/graphics.md` «Палитра»). */
const BIOME: Record<Biome, Rgb> = {
  ocean: rgb(0x6b6146),
  beach: rgb(0xc9b58a),
  meadows: rgb(0x6a7a4a), // was 0x6f9a3a — grass-olive, not neon
  forest: rgb(0x3f4a32), // was 0x3f6a2c — moss
  mountain: rgb(0x8d8a84),
};

/** Ground patch colors (`docs/graphics.md` «Палитра»). */
const MOSS = rgb(0x3f4a32);
const EARTH = rgb(0x4a3a2a);
const ASH = rgb(0x6a6a62); // «старые кострища»; ash around mounds joins with the mound pass
const PUDDLE = rgb(0x26302c); // dark wet hollows
const ROCK = rgb(0x6e6a63);
const SNOW = rgb(0xeef2f5);

const mix = (a: Rgb, b: Rgb, t: number): Rgb => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (a: number, b: number, x: number): number => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/** Deterministic 0..1 hash of an integer lattice point. */
function hash2(x: number, z: number): number {
  const s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/** 2D value noise, 0..1, smooth across cell borders. */
function valueNoise(x: number, z: number): number {
  const xi = Math.floor(x);
  const zi = Math.floor(z);
  const xf = x - xi;
  const zf = z - zi;
  const u = xf * xf * (3 - 2 * xf);
  const v = zf * zf * (3 - 2 * zf);
  const a = hash2(xi, zi);
  const b = hash2(xi + 1, zi);
  const c = hash2(xi, zi + 1);
  const d = hash2(xi + 1, zi + 1);
  return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v;
}

/** Fractal value noise, 0..1: broad patches dominate, finer octaves add ragged edges. */
function fbm(x: number, z: number, octaves: number): number {
  let sum = 0;
  let amp = 1;
  let freq = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += valueNoise(x * freq, z * freq) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

/**
 * Widens the fbm distribution. Averaged octaves cluster around 0.5 (measured ~[0.3, 0.7]); a smoothstep
 * remap spreads that back toward 0..1 so the patch thresholds below mean a stable share of the ground.
 */
function spread(f: number): number {
  return smoothstep(0.15, 0.85, f);
}

/**
 * Three decorrelated fields in world space (seed-independent, so chunk seams match):
 * `moist` is a moisture gradient — low means wet hollows, high means dry ridge; `mossN` and `ashN`
 * are independent coverage fields for moss patches and rare fire-pit spots.
 */
function fields(wx: number, wz: number): { moist: number; mossN: number; ashN: number } {
  const moist = spread(fbm(wx * 0.018 + 100.3, wz * 0.018 - 40.7, 3));
  const mossN = spread(fbm(wx * 0.025 - 70.1, wz * 0.025 + 130.9, 3));
  const ashN = spread(fbm(wx * 0.04 + 37.1, wz * 0.04 + 211.9, 2));
  return { moist, mossN, ashN };
}

/**
 * The vertex color in linear RGB.
 *
 * @param biome  biome at the vertex
 * @param height world height in meters
 * @param slope  0 = flat, 1 = vertical wall (the worker computes it as `1 - ny/len`)
 * @param wx     world X
 * @param wz     world Z
 */
export function groundColor(biome: Biome, height: number, slope: number, wx: number, wz: number): Rgb {
  if (height > SNOW_LINE) return SNOW;
  if (biome === 'ocean') return BIOME.ocean;
  if (biome === 'beach') return BIOME.beach;
  if (biome === 'mountain') return mix(BIOME.mountain, ROCK, smoothstep(0.25, 0.55, slope));

  // Land (meadows/forest): grass is the base, and the moisture/coverage fields paint patches on top.
  const { moist, mossN, ashN } = fields(wx, wz);
  const base = BIOME[biome];

  const earthT = smoothstep(0.1, 0.34, slope);
  const rockT = smoothstep(0.34, 0.6, slope);

  // Wet hollows on the low tail of the moisture field; dry ridges on the high tail.
  const puddleT = 1 - smoothstep(0.12, 0.22, moist);
  const dryT = smoothstep(0.86, 0.95, moist);
  // Moss patches and ash (old fire pits) are independent, rare-ish coverage fields.
  const mossT = smoothstep(0.6, 0.78, mossN);
  const ashT = smoothstep(0.82, 0.95, ashN);

  let c = base;
  c = mix(c, MOSS, mossT * 0.9);
  c = mix(c, EARTH, dryT);
  c = mix(c, ASH, ashT * 0.7);
  c = mix(c, PUDDLE, puddleT);
  c = mix(c, EARTH, earthT);
  c = mix(c, ROCK, rockT);
  return c;
}
