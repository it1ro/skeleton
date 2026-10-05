import { createNoise2D, type NoiseFunction2D } from 'simplex-noise';
import { CHUNK_SIZE, WATER_LEVEL } from './constants.ts';
import { hash3, mulberry32 } from './rng.ts';

export type Biome = 'ocean' | 'beach' | 'meadows' | 'forest' | 'mountain';

export interface TreeSpot {
  x: number;
  y: number;
  z: number;
  scale: number;
  rotation: number;
}

/**
 * Procedural world from a seed. Pure functions only: the server and every client
 * build the same world, so only player changes (deltas) need saving or sending.
 */
export interface Terrain {
  readonly seed: number;
  heightAt(x: number, z: number): number;
  biomeAt(x: number, z: number): Biome;
  treesInChunk(cx: number, cz: number): TreeSpot[];
}

const SPAWN_RADIUS = 260;
/** Around the origin the land flattens into low meadows: a calm start, like Valheim. */
const MEADOW_RADIUS = 160;

function fbm(noise: NoiseFunction2D, x: number, z: number, octaves: number): number {
  let sum = 0;
  let amp = 1;
  let freq = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += noise(x * freq, z * freq) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

export function createTerrain(seed: number): Terrain {
  const rnd = mulberry32(seed);
  const continentNoise = createNoise2D(rnd);
  const hillNoise = createNoise2D(rnd);
  const ridgeNoise = createNoise2D(rnd);
  const forestNoise = createNoise2D(rnd);

  /** -1..1, > 0 is land. Origin is always an island so players spawn on land. */
  function continent(x: number, z: number): number {
    const spawn = Math.exp(-(x * x + z * z) / (SPAWN_RADIUS * SPAWN_RADIUS));
    return Math.max(-1, Math.min(1, fbm(continentNoise, x / 1100, z / 1100, 3) * 1.4 + spawn * 0.9 - 0.15));
  }

  function heightAt(x: number, z: number): number {
    const c = continent(x, z);
    const hills = fbm(hillNoise, x / 160, z / 160, 4);
    const ridge = 1 - Math.abs(fbm(ridgeNoise, x / 420, z / 420, 3));
    const mountain = Math.max(0, c - 0.35) * ridge * ridge * 140;
    const land = Math.max(0, c);
    const wild = c * 26 + 2 + hills * (2 + land * 9) + mountain;
    const calm = Math.exp(-(x * x + z * z) / (MEADOW_RADIUS * MEADOW_RADIUS));
    return wild * (1 - calm) + (6 + hills * 4) * calm;
  }

  function biomeAt(x: number, z: number): Biome {
    const h = heightAt(x, z);
    if (h < WATER_LEVEL - 0.5) return 'ocean';
    if (h < WATER_LEVEL + 1.5) return 'beach';
    if (h > 38) return 'mountain';
    return forestNoise(x / 300, z / 300) > 0.1 ? 'forest' : 'meadows';
  }

  function treesInChunk(cx: number, cz: number): TreeSpot[] {
    const r = mulberry32(hash3(cx, cz, seed));
    const trees: TreeSpot[] = [];
    const attempts = 70;
    for (let i = 0; i < attempts; i++) {
      const x = (cx + r()) * CHUNK_SIZE;
      const z = (cz + r()) * CHUNK_SIZE;
      const scale = 0.7 + r() * 0.6;
      const rotation = r() * Math.PI * 2;
      const roll = r();
      const biome = biomeAt(x, z);
      const density = biome === 'forest' ? 0.55 : biome === 'meadows' ? 0.04 : 0;
      if (roll >= density) continue;
      // Keep the spawn point clear.
      if (x * x + z * z < 12 * 12) continue;
      trees.push({ x, y: heightAt(x, z), z, scale, rotation });
    }
    return trees;
  }

  return { seed, heightAt, biomeAt, treesInChunk };
}
