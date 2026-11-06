import { describe, expect, it } from 'vitest';
import { WATER_LEVEL, createTerrain } from '@skeleton/shared';
import {
  WATER_FIELD_DEEP,
  WATER_FIELD_LAND,
  bakeWaterField,
  depthAt,
  fromHalf,
  toHalf,
} from '../src/render/water-field.ts';

/** A small field over the spawn island: 8 m texels, fast enough to bake inside a test. */
const SPEC = { size: 128, halfExtent: 512 };

const texelCenter = (index: number): number => -SPEC.halfExtent + (index + 0.5) * ((2 * SPEC.halfExtent) / SPEC.size);

describe('water field', () => {
  it('bakes depth inside the clamp range everywhere', () => {
    const field = bakeWaterField(42, SPEC);
    expect(field).toHaveLength(SPEC.size * SPEC.size);
    for (const depth of field) {
      expect(depth).toBeGreaterThanOrEqual(WATER_FIELD_LAND);
      expect(depth).toBeLessThanOrEqual(WATER_FIELD_DEEP);
    }
  });

  it('samples the coastal band exactly and clamps deep sea and high land', () => {
    const terrain = createTerrain(42);
    const field = bakeWaterField(42, SPEC);
    const cell = (2 * SPEC.halfExtent) / SPEC.size;
    const coarse = Math.max(2, Math.ceil(SPEC.size / 8));
    const coarseCell = (2 * SPEC.halfExtent) / coarse;
    let coastal = 0;
    let deep = 0;
    let land = 0;
    for (let j = 0; j < SPEC.size; j++) {
      for (let i = 0; i < SPEC.size; i++) {
        const depth = depthAt(field, SPEC, i, j);
        // Replicate the coarse pre-pass: its cell decides between the clamp and an exact sample.
        const coarseH = terrain.heightAt(
          -SPEC.halfExtent + (Math.floor(i / 8) + 0.5) * coarseCell,
          -SPEC.halfExtent + (Math.floor(j / 8) + 0.5) * coarseCell,
        );
        const height = terrain.heightAt(texelCenter(i), texelCenter(j));
        if (coarseH < WATER_LEVEL - WATER_FIELD_DEEP) {
          expect(depth).toBe(WATER_FIELD_DEEP);
          deep++;
        } else if (coarseH > WATER_LEVEL - WATER_FIELD_LAND) {
          expect(depth).toBe(WATER_FIELD_LAND);
          land++;
        } else {
          const exact = Math.min(WATER_FIELD_DEEP, Math.max(WATER_FIELD_LAND, WATER_LEVEL - height));
          expect(depth).toBeCloseTo(exact, 4);
          coastal++;
        }
      }
    }
    // The window must actually contain all three cases, or the test proves nothing.
    expect(coastal).toBeGreaterThan(0);
    expect(deep).toBeGreaterThan(0);
    expect(land).toBeGreaterThan(0);
    expect(cell).toBeGreaterThan(0);
  });

  it('is deep outside the field', () => {
    const field = bakeWaterField(42, SPEC);
    expect(depthAt(field, SPEC, -1, 0)).toBeNaN();
    expect(depthAt(field, SPEC, SPEC.size, 0)).toBeNaN();
  });

  it('round-trips depth through half floats within a centimeter', () => {
    for (const value of [WATER_FIELD_LAND, -3.3, -0.25, 0, 0.4, 2.5, 7.75, WATER_FIELD_DEEP]) {
      expect(fromHalf(toHalf(value))).toBeCloseTo(value, 2);
    }
    expect(toHalf(0)).toBe(0);
    expect(fromHalf(toHalf(-4))).toBe(-4);
  });
});
