import { hash3, mulberry32 } from './rng.ts';
import type { Terrain } from './terrain.ts';

/** Square scatter tile in meters. The field covers a ring of tiles around the player and follows them. */
export const SCATTER_TILE = 16;
export const GRASS_STEP = 0.5;
export const GRASS_KEEP = 0.55;
export const FLOWER_STEP = 1.6;
export const FLOWER_KEEP = 0.65;

/** Salt for the per-tile grass RNG stream. Do not change: determinism of placement depends on it. */
const GRASS_SALT = 0x51ed270b;
/** Salt for the per-tile flower RNG stream. Do not change: determinism of placement depends on it. */
const FLOWER_SALT = 0x2f6a88d1;

/** Precomposed instance data for one scatter type (grass or flowers). */
export interface ScatterBlock {
  /** 16 floats per instance: world-space transform, column-major like a three.js `Matrix4`. */
  matrices: Float32Array;
  /** 3 floats per instance: linear-space RGB. */
  colors: Float32Array;
}

/** One tile's scatter, split into the two instanced meshes (tufts and flowers). */
export interface ScatterData {
  tx: number;
  tz: number;
  grass: ScatterBlock;
  flowers: ScatterBlock;
}

/** sRGB→linear transfer, bit-identical to three.js `ColorManagement.SRGBToLinear`. */
function srgbToLinear(c: number): number {
  return c < 0.04045 ? c * 0.0773993808 : Math.pow(c * 0.9478672986 + 0.0521327014, 2.4);
}

/** Flower palette: the hexes the renderer used, converted to linear like three.js `new Color(hex)`. */
const FLOWER_PALETTE: readonly (readonly [number, number, number])[] = [
  [srgbToLinear(0xff / 255), srgbToLinear(0xe0 / 255), srgbToLinear(0x7a / 255)], // 0xffe07a
  [srgbToLinear(0xf4 / 255), srgbToLinear(0xf1 / 255), srgbToLinear(0xe0 / 255)], // 0xf4f1e0
  [srgbToLinear(0x9a / 255), srgbToLinear(0xa8 / 255), srgbToLinear(0xff / 255)], // 0x9aa8ff
  [srgbToLinear(0xe8 / 255), srgbToLinear(0x9c / 255), srgbToLinear(0xb4 / 255)], // 0xe89cb4
];

/**
 * Writes a world-space instance matrix (translation, Y-rotation, uniform scale) into `out` at `at`.
 * A direct port of three.js `Quaternion.setFromAxisAngle((0,1,0), rotation)` + `Matrix4.compose`,
 * so the floats match `composeInstance` bit-for-bit without importing three here (the worker and
 * server must stay free of the renderer).
 */
export function composeScatterMatrix(
  out: Float32Array,
  at: number,
  x: number,
  y: number,
  z: number,
  rotation: number,
  scale: number,
): void {
  // Quaternion.setFromAxisAngle((0,1,0), rotation): q = (0, sin(θ/2), 0, cos(θ/2)).
  const halfAngle = rotation / 2;
  const s = Math.sin(halfAngle);
  const w = Math.cos(halfAngle);
  // Matrix4.compose with qx=qz=0 and uniform scale. Only yy/wy survive the zero components.
  const y2 = s + s;
  const yy = s * y2; // y * y2
  const wy = w * y2; // w * y2
  const sx = scale;

  const k = at * 16;
  out[k + 0] = (1 - yy) * sx; // (1 - (yy + zz)) * sx, zz = 0
  out[k + 1] = 0; // (xy + wz) * sx
  out[k + 2] = -wy * sx; // (xz - wy) * sx, xz = 0
  out[k + 3] = 0;
  out[k + 4] = 0; // (xy - wz) * sy
  out[k + 5] = sx; // (1 - (xx + zz)) * sy, xx = zz = 0
  out[k + 6] = 0; // (yz + wx) * sy
  out[k + 7] = 0;
  out[k + 8] = wy * sx; // (xz + wy) * sz, xz = 0
  out[k + 9] = 0; // (yz - wx) * sz
  out[k + 10] = (1 - yy) * sx; // (1 - (xx + yy)) * sz, xx = 0
  out[k + 11] = 0;
  out[k + 12] = x;
  out[k + 13] = y;
  out[k + 14] = z;
  out[k + 15] = 1;
}

interface ScatterSpec {
  step: number;
  keep: number;
  salt: number;
  flower: boolean;
}

const GRASS: ScatterSpec = { step: GRASS_STEP, keep: GRASS_KEEP, salt: GRASS_SALT, flower: false };
const FLOWERS: ScatterSpec = { step: FLOWER_STEP, keep: FLOWER_KEEP, salt: FLOWER_SALT, flower: true };

function scatterOne(
  terrain: Terrain,
  tx: number,
  tz: number,
  ox: number,
  oz: number,
  seed: number,
  spec: ScatterSpec,
  density: number,
): ScatterBlock {
  const perSide = Math.ceil(SCATTER_TILE / spec.step);
  const matrices = new Float32Array(perSide * perSide * 16);
  const colors = new Float32Array(perSide * perSide * 3);
  // Density-LOD: scale the keep probability, never the tuft geometry. Deterministic for a given density.
  const keep = spec.keep * density;
  let n = 0;
  const rnd = mulberry32(hash3(tx, tz, seed ^ spec.salt));
  for (let j = 0; j < perSide; j++) {
    for (let i = 0; i < perSide; i++) {
      const x = ox + (i + rnd()) * spec.step;
      const z = oz + (j + rnd()) * spec.step;
      if (rnd() > keep) continue;
      if (spec.flower && Math.sin(x * 0.11) + Math.cos(z * 0.09) < 0.2) continue;
      const h = terrain.heightAt(x, z);
      if (terrain.biomeAt(x, z, h) !== 'meadows') continue;
      const rotation = rnd() * Math.PI * 2;
      const scale = spec.flower ? 1 + rnd() * 0.6 : 0.7 + rnd() * 1.0;
      const shade = rnd();
      composeScatterMatrix(matrices, n, x, h, z, rotation, scale);
      if (spec.flower) {
        const [r, g, b] = FLOWER_PALETTE[Math.min(FLOWER_PALETTE.length - 1, Math.floor(shade * FLOWER_PALETTE.length))];
        colors[n * 3] = r;
        colors[n * 3 + 1] = g;
        colors[n * 3 + 2] = b;
      } else {
        colors[n * 3] = 0.7 + shade * 0.45;
        colors[n * 3 + 1] = 0.8 + shade * 0.3;
        colors[n * 3 + 2] = 0.45 + shade * 0.3;
      }
      n++;
    }
  }
  return { matrices: matrices.slice(0, n * 16), colors: colors.slice(0, n * 3) };
}

/**
 * Builds the scatter (grass tufts and flowers) for one tile as precomposed instance blocks.
 * Pure and deterministic: the same `seed` always gives the same placement, matching the previous
 * main-thread `GrassField.buildTile` exactly (rnd order, salts and matrix floats are unchanged).
 *
 * `density` (0..1) is the density-LOD multiplier: it lowers the keep probability and therefore the
 * instance count. The tuft geometry is untouched and the result is deterministic; `density = 1`
 * reproduces the golden placement exactly. Defaults to full density.
 */
export function buildScatterData(
  terrain: Terrain,
  tx: number,
  tz: number,
  seed: number,
  density = 1,
): ScatterData {
  const ox = tx * SCATTER_TILE;
  const oz = tz * SCATTER_TILE;
  return {
    tx,
    tz,
    grass: scatterOne(terrain, tx, tz, ox, oz, seed, GRASS, density),
    flowers: scatterOne(terrain, tx, tz, ox, oz, seed, FLOWERS, density),
  };
}
