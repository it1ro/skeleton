import { describe, expect, it } from 'vitest';
import { groundColor } from '../src/ground-color.ts';
import type { Biome } from '../src/terrain.ts';

/** Linear → sRGB, for appearance checks (neon, luma). */
const lin2srgb = (c: number): number => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

const sat = ([r, g, b]: readonly number[]): number => {
  const R = lin2srgb(r);
  const G = lin2srgb(g);
  const B = lin2srgb(b);
  const mx = Math.max(R, G, B);
  const mn = Math.min(R, G, B);
  return mx === 0 ? 0 : (mx - mn) / mx;
};

const luma = ([r, g, b]: readonly number[]): number =>
  0.2126 * lin2srgb(r) + 0.7152 * lin2srgb(g) + 0.0722 * lin2srgb(b);

/** A representative grid of world positions over meadow/forest land. */
function sampleLand(biome: Biome, slope: number): ReturnType<typeof groundColor>[] {
  const out: ReturnType<typeof groundColor>[] = [];
  for (let i = 0; i < 40; i++) {
    for (let j = 0; j < 40; j++) {
      const wx = -120 + i * 6;
      const wz = -120 + j * 6;
      out.push(groundColor(biome, 6, slope, wx, wz));
    }
  }
  return out;
}

describe('groundColor', () => {
  it('is deterministic: same inputs give the same color', () => {
    expect(groundColor('meadows', 6, 0, 12.3, -45.6)).toEqual(groundColor('meadows', 6, 0, 12.3, -45.6));
    expect(groundColor('forest', 10, 0.4, 0, 0)).toEqual(groundColor('forest', 10, 0.4, 0, 0));
  });

  it('is not neon: land colors stay muted (low saturation)', () => {
    for (const biome of ['meadows', 'forest'] as Biome[]) {
      for (const slope of [0, 0.1, 0.2, 0.3, 0.5]) {
        const maxSat = Math.max(...sampleLand(biome, slope).map(sat));
        expect(maxSat).toBeLessThan(0.5);
      }
    }
  });

  it('reads in gray: patches differ enough in brightness', () => {
    for (const biome of ['meadows', 'forest'] as Biome[]) {
      const lumas = sampleLand(biome, 0).map(luma);
      const range = Math.max(...lumas) - Math.min(...lumas);
      expect(range).toBeGreaterThan(0.15);
    }
  });

  it('exposes earth on a slope and rock on a cliff', () => {
    // On a steep slope the moss/puddle/ash patches are overridden by earth: brown, not green.
    const earth = groundColor('meadows', 6, 0.45, 40, 40);
    expect(earth[0]).toBeGreaterThan(earth[1]); // r > g: brown, not moss

    const rock = groundColor('meadows', 6, 0.8, 40, 40);
    // Rock is near-neutral: red, green and blue are close.
    expect(Math.abs(rock[0] - rock[1])).toBeLessThan(0.08);
    expect(Math.abs(rock[1] - rock[2])).toBeLessThan(0.08);
  });

  it('snows above the snow line, sand at the beach, murk in the ocean', () => {
    const snow = groundColor('mountain', 70, 0.2, 0, 0);
    expect(luma(snow)).toBeGreaterThan(0.8);

    const beach = groundColor('beach', 1, 0, 0, 0);
    expect(beach[0]).toBeGreaterThan(beach[2]); // sandy: red > blue

    const ocean = groundColor('ocean', -2, 0, 0, 0);
    expect(luma(ocean)).toBeLessThan(0.5); // murky, not bright
    expect(luma(ocean)).toBeLessThan(luma(beach)); // darker than the shore
  });
});
