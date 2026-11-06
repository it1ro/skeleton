import { describe, expect, it } from 'vitest';
import {
  BIOME_NAMES,
  BIOME_ORDER,
  BIOMES,
  FOREST_EDGE_WIDTH,
  TREE_KINDS,
  forestShare,
  pickTreeKind,
  selectBiome,
  type Biome,
} from '../src/biomes.ts';
import { WATER_LEVEL } from '../src/constants.ts';
import { createTerrain, type BiomeBlend } from '../src/terrain.ts';

const noForest = (): number => 0;
const allForest = (): number => 1;

describe('biome registry', () => {
  it('describes every biome exactly once and keeps the resolution order complete', () => {
    expect([...BIOME_NAMES].sort()).toEqual(Object.keys(BIOMES).sort());
    expect([...BIOME_ORDER].sort()).toEqual([...BIOME_NAMES].sort());
    expect(new Set(BIOME_ORDER).size).toBe(BIOME_ORDER.length);
    // The fallback must stay last, or a point could fall through without a biome.
    expect(BIOME_ORDER[BIOME_ORDER.length - 1]).toBe('meadows');
  });

  it('keeps tree mixes total and in wire order', () => {
    for (const biome of BIOME_NAMES) {
      const { mix } = BIOMES[biome].trees;
      expect(mix.length).toBeGreaterThan(0);
      expect(mix[mix.length - 1].until).toBe(1);
      for (const share of mix) {
        expect(TREE_KINDS).toContain(share.kind);
        expect(share.until).toBeGreaterThan(0);
        expect(share.until).toBeLessThanOrEqual(1);
      }
    }
  });

  it('keeps the noise scale positive where a biome uses forest noise', () => {
    for (const biome of BIOME_NAMES) {
      const noise = BIOMES[biome].when.forestNoise;
      if (noise) expect(noise.scale).toBeGreaterThan(0);
    }
  });

  it('keeps far fog ordered near < far, and open wider than the Погост', () => {
    for (const biome of BIOME_NAMES) {
      const [near, far] = BIOMES[biome].fog;
      expect(near).toBeGreaterThan(0);
      expect(far).toBeGreaterThan(near);
    }
    const [meadowNear, meadowFar] = BIOMES.meadows.fog;
    const [mountainNear, mountainFar] = BIOMES.mountain.fog;
    expect(mountainNear).toBeGreaterThan(meadowNear);
    expect(mountainFar).toBeGreaterThan(meadowFar);
  });

  it('grows grass and flowers only where the biome allows it', () => {
    for (const biome of BIOME_NAMES) {
      const { grass, flowers } = BIOMES[biome].scatter;
      // Flowers never grow without grass; today both only on the meadows.
      if (flowers) expect(grass).toBe(true);
    }
    expect(BIOMES.meadows.scatter).toEqual({ grass: true, flowers: true });
  });
});

describe('forest edge', () => {
  it('puts the forest share at 0.5 on the threshold and saturates over the edge width', () => {
    expect(forestShare(-1)).toBe(0);
    expect(forestShare(0.1 - FOREST_EDGE_WIDTH)).toBe(0);
    expect(forestShare(0.1)).toBeCloseTo(0.5, 12);
    expect(forestShare(0.1 + FOREST_EDGE_WIDTH)).toBe(1);
    expect(forestShare(0.2)).toBe(1);
  });

  it('is the only feathered pair: two soil biomes', () => {
    expect(BIOME_NAMES.filter((name) => BIOMES[name].surface === 'soil')).toEqual(['meadows', 'forest']);
  });
});

describe('selectBiome', () => {
  it('matches the sea below the waterline and the shore above it', () => {
    expect(selectBiome(WATER_LEVEL - 0.6, allForest, 0, 0)).toBe('ocean');
    expect(selectBiome(WATER_LEVEL - 0.5, allForest, 0, 0)).toBe('beach');
    expect(selectBiome(WATER_LEVEL, allForest, 0, 0)).toBe('beach');
    expect(selectBiome(WATER_LEVEL + 1.5, allForest, 0, 0)).toBe('forest');
  });

  it('matches peaks strictly above the mountain line', () => {
    expect(selectBiome(38, allForest, 0, 0)).toBe('forest');
    expect(selectBiome(38.1, noForest, 0, 0)).toBe('mountain');
  });

  it('splits land into forest and meadows by the forest noise', () => {
    expect(selectBiome(10, allForest, 0, 0)).toBe('forest');
    expect(selectBiome(10, noForest, 0, 0)).toBe('meadows');
  });

  it('samples the forest noise only on land, never over sea or peaks', () => {
    let calls = 0;
    const counted = (): number => {
      calls++;
      return 1;
    };
    selectBiome(-5, counted, 0, 0);
    selectBiome(100, counted, 0, 0);
    expect(calls).toBe(0);
    selectBiome(10, counted, 0, 0);
    expect(calls).toBe(1);
  });
});

describe('pickTreeKind', () => {
  it('respects the cumulative thresholds of each mix', () => {
    expect(pickTreeKind(BIOMES.forest.trees.mix, 0)).toBe('spruce');
    expect(pickTreeKind(BIOMES.forest.trees.mix, 0.61)).toBe('spruce');
    expect(pickTreeKind(BIOMES.forest.trees.mix, 0.62)).toBe('birch');
    expect(pickTreeKind(BIOMES.forest.trees.mix, 0.87)).toBe('birch');
    expect(pickTreeKind(BIOMES.forest.trees.mix, 0.88)).toBe('dead');

    expect(pickTreeKind(BIOMES.meadows.trees.mix, 0.44)).toBe('birch');
    expect(pickTreeKind(BIOMES.meadows.trees.mix, 0.45)).toBe('spruce');
    expect(pickTreeKind(BIOMES.meadows.trees.mix, 0.8)).toBe('dead');

    expect(pickTreeKind(BIOMES.mountain.trees.mix, 0.49)).toBe('dead');
    expect(pickTreeKind(BIOMES.mountain.trees.mix, 0.5)).toBe('spruce');
  });

  it('falls back to the last share for a roll of 1', () => {
    for (const biome of BIOME_NAMES) {
      const mix = BIOMES[biome].trees.mix;
      expect(TREE_KINDS).toContain(pickTreeKind(mix, 1));
    }
  });
});

describe('biomeBlendAt', () => {
  it('blends only the soil pair, never water, shore or peaks, and never more than half', () => {
    const terrain = createTerrain(1337);
    const blend: BiomeBlend = { biome: 'meadows', mixWith: 'meadows', mix: 0 };
    let mixed = 0;
    for (let z = -600; z <= 600; z += 7) {
      for (let x = -600; x <= 600; x += 7) {
        terrain.biomeBlendAt(x, z, blend);
        if (blend.mix === 0) {
          expect(blend.mixWith).toBe(blend.biome);
          continue;
        }
        mixed++;
        expect(blend.biome === 'forest' || blend.biome === 'meadows').toBe(true);
        expect(blend.mixWith).not.toBe(blend.biome);
        expect(blend.mix).toBeGreaterThan(0);
        expect(blend.mix).toBeLessThanOrEqual(0.5);
      }
    }
    expect(mixed).toBeGreaterThan(0);
  });

  it('crosses the edge smoothly, without a step', () => {
    const terrain = createTerrain(1337);
    const blend: BiomeBlend = { biome: 'meadows', mixWith: 'meadows', mix: 0 };
    let prev = 0;
    let maxStep = 0;
    let sawEdge = false;
    // The forest starts ~6 m north of spawn, so this line crosses the edge once.
    for (let z = 0; z >= -60; z -= 0.5) {
      terrain.biomeBlendAt(0, z, blend);
      maxStep = Math.max(maxStep, Math.abs(blend.mix - prev));
      if (blend.mix > 0.4) sawEdge = true;
      prev = blend.mix;
    }
    expect(sawEdge).toBe(true);
    expect(maxStep).toBeLessThan(0.3);
  });

  it('keeps the assignment itself crisp: biomeAt and blend agree on the biome', () => {
    const terrain = createTerrain(1337);
    const blend: BiomeBlend = { biome: 'meadows', mixWith: 'meadows', mix: 0 };
    for (let z = -200; z <= 200; z += 11) {
      for (let x = -200; x <= 200; x += 13) {
        terrain.biomeBlendAt(x, z, blend);
        expect(blend.biome).toBe(terrain.biomeAt(x, z));
      }
    }
  });
});

describe('world biomes through the terrain', () => {
  it('spawns in a biome that carries the Погост layer', () => {
    const terrain = createTerrain(1337);
    expect(BIOMES[terrain.biomeAt(0, 0)].pogost).toBe(true);
  });

  it('grows no trees on sea and peaks', () => {
    for (const biome of ['ocean', 'beach', 'mountain'] as Biome[]) {
      expect(BIOMES[biome].trees.density).toBe(0);
    }
  });
});
