/**
 * The shallow-water field: depth of the sea (meters) on a square grid, baked once from the terrain.
 *
 * The water shader needs one number it cannot cheaply compute itself — how deep the sea is under a pixel.
 * `heightAt` is ~16 noise lookups, so it stays on the CPU: the field is baked in a worker, uploaded as a
 * half-float texture and sampled per fragment. Colors, transparency, foam and wave damping all read it.
 *
 * The field is a square of `size²` texels over `[-halfExtent, +halfExtent]`; texel centers sit at
 * `-half + (i + 0.5) * cell`, so the shader maps a world point with `uv = (world.xz + half) / (2 * half)`.
 *
 * Baking skips the deep sea and the high land: a coarse pass at `COARSE_DIVISOR` resolution fills those
 * texels with the clamp values, and only the coastal band is sampled exactly. That keeps ~1M texels down to
 * the few hundred thousand noise calls that actually matter.
 */
import { WATER_LEVEL, createTerrain } from '@skeleton/shared';

/** Texels per side of the baked field. 1024 over 1536 m is 1.5 m per texel. */
export const WATER_FIELD_SIZE = 1024;
/** Half-extent of the field, meters: the square covers ±768 m around the spawn. */
export const WATER_FIELD_HALF = 768;
/** Everything deeper is clamped: the shader treats the clamp as "deep sea". */
export const WATER_FIELD_DEEP = 12;
/** Land above the waterline is clamped here; foam and shallow tint never need more. */
export const WATER_FIELD_LAND = -4;
/** The coarse pre-pass: 1/8 of the field resolution, 12 m cells. */
const COARSE_DIVISOR = 8;

export interface WaterFieldSpec {
  size: number;
  halfExtent: number;
}

export const WATER_FIELD_SPEC: WaterFieldSpec = { size: WATER_FIELD_SIZE, halfExtent: WATER_FIELD_HALF };

const clamp = (value: number, min: number, max: number): number =>
  value < min ? min : value > max ? max : value;

/**
 * Bakes the depth field: `WATER_LEVEL - heightAt`, clamped to `[WATER_FIELD_LAND, WATER_FIELD_DEEP]`.
 * Row-major from the north-west corner: index `j * size + i` is `x = -half + (i + 0.5) * cell`,
 * `z = -half + (j + 0.5) * cell`.
 */
export function bakeWaterField(seed: number, spec: WaterFieldSpec = WATER_FIELD_SPEC): Float32Array {
  const { size, halfExtent } = spec;
  const terrain = createTerrain(seed);
  const cell = (2 * halfExtent) / size;

  // Coarse pass: 1 coarse cell = COARSE_DIVISOR field cells. Deep sea and high land are filled from it.
  const coarse = Math.max(2, Math.ceil(size / COARSE_DIVISOR));
  const coarseCell = (2 * halfExtent) / coarse;
  const coarseHeight = new Float32Array(coarse * coarse);
  for (let j = 0; j < coarse; j++) {
    const z = -halfExtent + (j + 0.5) * coarseCell;
    for (let i = 0; i < coarse; i++) {
      coarseHeight[j * coarse + i] = terrain.heightAt(-halfExtent + (i + 0.5) * coarseCell, z);
    }
  }

  const data = new Float32Array(size * size);
  for (let j = 0; j < size; j++) {
    const z = -halfExtent + (j + 0.5) * cell;
    const cj = Math.min(coarse - 1, Math.floor(j / COARSE_DIVISOR));
    for (let i = 0; i < size; i++) {
      const ci = Math.min(coarse - 1, Math.floor(i / COARSE_DIVISOR));
      const coarseH = coarseHeight[cj * coarse + ci];
      let depth: number;
      if (coarseH < WATER_LEVEL - WATER_FIELD_DEEP) {
        depth = WATER_FIELD_DEEP;
      } else if (coarseH > WATER_LEVEL - WATER_FIELD_LAND) {
        depth = WATER_FIELD_LAND;
      } else {
        const x = -halfExtent + (i + 0.5) * cell;
        depth = WATER_LEVEL - terrain.heightAt(x, z);
        depth = clamp(depth, WATER_FIELD_LAND, WATER_FIELD_DEEP);
      }
      data[j * size + i] = depth;
    }
  }
  return data;
}

/** Depth at a field index, in meters. `NaN` outside the grid. */
export function depthAt(field: Float32Array, spec: WaterFieldSpec, i: number, j: number): number {
  if (i < 0 || j < 0 || i >= spec.size || j >= spec.size) return Number.NaN;
  return field[j * spec.size + i];
}

// --- half float -------------------------------------------------------------
// `DataTexture` with `HalfFloatType` needs 16-bit halves; `three`'s converter would drag the whole library
// into the worker bundle, and our range (−4..12 m) is normal floats, so a compact converter is enough.

const floatView = new Float32Array(1);
const intView = new Int32Array(floatView.buffer);

/** IEEE-754 float32 → half float bits, round-to-nearest. Values are normal in our range, no subnormals. */
export function toHalf(value: number): number {
  floatView[0] = value;
  const bits = intView[0];
  const sign = (bits >> 16) & 0x8000;
  let exponent = ((bits >> 23) & 0xff) - 127 + 15;
  if (exponent <= 0) return sign;
  if (exponent >= 31) return sign | 0x7c00;
  let mantissa = (bits & 0x7fffff) + 0x1000; // round
  let half = mantissa >> 13;
  if (half === 0x400) {
    half = 0;
    exponent += 1;
    if (exponent >= 31) return sign | 0x7c00;
  }
  return sign | (exponent << 10) | half;
}

/** Half float bits → number. Used by the tests and for debugging the field. */
export function fromHalf(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >> 10) & 0x1f;
  const mantissa = bits & 0x3ff;
  if (exponent === 0) return sign * mantissa * 2 ** -24;
  if (exponent === 31) return sign * Infinity;
  return sign * (1 + mantissa / 1024) * 2 ** (exponent - 15);
}
