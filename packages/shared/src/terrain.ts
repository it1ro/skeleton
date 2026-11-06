import { createNoise2D, type NoiseFunction2D } from 'simplex-noise';
import { CHUNK_SIZE, WATER_LEVEL } from './constants.ts';
import { hash3, mulberry32 } from './rng.ts';

export type Biome = 'ocean' | 'beach' | 'meadows' | 'forest' | 'mountain';

/** Tree silhouettes the client can draw. The order is the wire format: `kind` is packed as this index. */
export const TREE_KINDS = ['spruce', 'birch', 'dead'] as const;

export type TreeKind = (typeof TREE_KINDS)[number];

export interface TreeSpot {
  x: number;
  y: number;
  z: number;
  scale: number;
  rotation: number;
  kind: TreeKind;
}

/** Prop silhouettes of the Погост. The order is the wire format: `kind` is packed as this index. */
export const PROP_KINDS = ['mound', 'cross', 'bone'] as const;

export type PropKind = (typeof PROP_KINDS)[number];

export interface PropSpot {
  x: number;
  y: number;
  z: number;
  scale: number;
  rotation: number;
  kind: PropKind;
}

/** Which silhouette grows in a biome. Roll is 0..1; the same seed always gives the same forest. */
function kindFor(biome: Biome, roll: number): TreeKind {
  if (biome === 'forest') return roll < 0.62 ? 'spruce' : roll < 0.88 ? 'birch' : 'dead';
  if (biome === 'meadows') return roll < 0.45 ? 'birch' : roll < 0.8 ? 'spruce' : 'dead';
  if (biome === 'mountain') return roll < 0.5 ? 'dead' : 'spruce';
  return 'spruce';
}

/**
 * Procedural world from a seed. Pure functions only: the server and every client
 * build the same world, so only player changes (deltas) need saving or sending.
 */
export interface Terrain {
  readonly seed: number;
  heightAt(x: number, z: number): number;
  /** Pass `height` when the caller already sampled it; avoids a second expensive noise lookup. */
  biomeAt(x: number, z: number, height?: number): Biome;
  treesInChunk(cx: number, cz: number): TreeSpot[];
  /** Погост props: grave mounds, their crosses, and scattered bones. */
  propsInChunk(cx: number, cz: number): PropSpot[];
}

const SPAWN_RADIUS = 260;
/** Around the origin the land flattens into low meadows: a calm start, like Valheim. */
const MEADOW_RADIUS = 160;
/** The Погост: grave mounds, crosses and bones cluster in the low meadows around the spawn. */
const POGOST_RADIUS = 140;
/** Mound lattice spacing, meters. Jitter keeps mounds ~30–50 m apart instead of a grid. */
const MOUND_SPACING = 40;
/** Bone lattice spacing, meters; keep-probability thins it to a scatter every ~15–25 m. */
const BONE_SPACING = 16;
const BONE_KEEP = 0.45;

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

  function biomeAt(x: number, z: number, height?: number): Biome {
    const h = height === undefined ? heightAt(x, z) : height;
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
      const h = heightAt(x, z);
      const biome = biomeAt(x, z, h);
      const density = biome === 'forest' ? 0.55 : biome === 'meadows' ? 0.04 : 0;
      if (roll >= density) continue;
      // Keep the spawn point clear.
      if (x * x + z * z < 12 * 12) continue;
      const kind = kindFor(biome, r());
      trees.push({ x, y: h, z, scale, rotation, kind });
    }
    return trees;
  }

  /** True when a world point lies inside the Погост: low meadows around the spawn, spawn itself kept clear. */
  function inPogost(x: number, z: number): boolean {
    if (x * x + z * z > POGOST_RADIUS * POGOST_RADIUS) return false;
    if (x * x + z * z < 14 * 14) return false;
    const h = heightAt(x, z);
    return biomeAt(x, z, h) === 'meadows';
  }

  /**
   * Погост props for one chunk, deterministic and world-space: each prop is emitted exactly once, by the
   * chunk that contains its center, so chunk seams never duplicate or drop a prop. Mounds sit on a jittered
   * lattice and own their crosses; bones are an independent sparse scatter.
   */
  function propsInChunk(cx: number, cz: number): PropSpot[] {
    const props: PropSpot[] = [];
    const x0 = cx * CHUNK_SIZE;
    const z0 = cz * CHUNK_SIZE;

    // Mounds and their crosses.
    const mStartX = Math.floor(x0 / MOUND_SPACING) - 1;
    const mEndX = Math.floor((x0 + CHUNK_SIZE) / MOUND_SPACING) + 1;
    const mStartZ = Math.floor(z0 / MOUND_SPACING) - 1;
    const mEndZ = Math.floor((z0 + CHUNK_SIZE) / MOUND_SPACING) + 1;
    for (let mi = mStartX; mi <= mEndX; mi++) {
      for (let mj = mStartZ; mj <= mEndZ; mj++) {
        const r = mulberry32(hash3(mi, mj, seed ^ 0x9e3779b9));
        const mx = (mi + 0.5 + (r() - 0.5) * 0.3) * MOUND_SPACING;
        const mz = (mj + 0.5 + (r() - 0.5) * 0.3) * MOUND_SPACING;
        if (mx < x0 || mx >= x0 + CHUNK_SIZE || mz < z0 || mz >= z0 + CHUNK_SIZE) continue;
        if (!inPogost(mx, mz)) continue;
        const h = heightAt(mx, mz);
        props.push({ x: mx, y: h, z: mz, scale: 0.85 + r() * 0.5, rotation: r() * Math.PI * 2, kind: 'mound' });
        // 2–4 crosses around the mound.
        const crosses = 2 + Math.floor(r() * 3);
        for (let k = 0; k < crosses; k++) {
          const a = r() * Math.PI * 2;
          const d = 2.5 + r() * 3.5;
          const cx2 = mx + Math.cos(a) * d;
          const cz2 = mz + Math.sin(a) * d;
          props.push({ x: cx2, y: heightAt(cx2, cz2), z: cz2, scale: 0.8 + r() * 0.5, rotation: r() * Math.PI * 2, kind: 'cross' });
        }
      }
    }

    // Bones: a sparse, jittered scatter.
    const bStartX = Math.floor(x0 / BONE_SPACING) - 1;
    const bEndX = Math.floor((x0 + CHUNK_SIZE) / BONE_SPACING) + 1;
    const bStartZ = Math.floor(z0 / BONE_SPACING) - 1;
    const bEndZ = Math.floor((z0 + CHUNK_SIZE) / BONE_SPACING) + 1;
    for (let bi = bStartX; bi <= bEndX; bi++) {
      for (let bj = bStartZ; bj <= bEndZ; bj++) {
        const r = mulberry32(hash3(bi, bj, seed ^ 0x51ed270b));
        if (r() >= BONE_KEEP) continue;
        const bx = (bi + 0.5 + (r() - 0.5) * 0.7) * BONE_SPACING;
        const bz = (bj + 0.5 + (r() - 0.5) * 0.7) * BONE_SPACING;
        if (bx < x0 || bx >= x0 + CHUNK_SIZE || bz < z0 || bz >= z0 + CHUNK_SIZE) continue;
        if (!inPogost(bx, bz)) continue;
        props.push({ x: bx, y: heightAt(bx, bz), z: bz, scale: 0.8 + r() * 0.6, rotation: r() * Math.PI * 2, kind: 'bone' });
      }
    }

    return props;
  }

  return { seed, heightAt, biomeAt, treesInChunk, propsInChunk };
}
