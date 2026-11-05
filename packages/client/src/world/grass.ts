import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  MeshStandardMaterial,
} from 'three/webgpu';
import { SCATTER_TILE, GRASS_STEP, FLOWER_STEP, buildScatterData, type ScatterData, type Terrain } from '@skeleton/shared';
import { InstancedPool, type PoolBlock } from './instanced-pool.ts';
import type { ChunkManager } from './chunks.ts';

/** Square grass tile in meters. The field covers a ring of tiles around the player and follows them. */
const TILE = SCATTER_TILE;
/** Tiles from the center in each direction: 7 tiles is a 112 m radius. Beyond it the ground texture takes over. */
const RADIUS = 7;
/** Linear fog near/far of the environment (render/environment.ts): the density-LOD follows the fog. */
const FOG_NEAR = 60; // m
const FOG_RANGE = 320; // m (far − near)

/**
 * Density-LOD by fog: full grass up to the fog near, fading with the fog amount toward 0 at the fog
 * far, and nothing past the 112 m ring (the meadow ground texture reads as grass there).
 */
function grassDensity(distance: number): number {
  if (distance > RADIUS * TILE) return 0;
  const fog = Math.max(0, Math.min(1, (distance - FOG_NEAR) / FOG_RANGE));
  return 1 - fog;
}

/** Ceiling on instances a single tile can emit; the pool is sized to the whole ring. */
const GRASS_PER_TILE = Math.ceil(TILE / GRASS_STEP) ** 2;
const FLOWER_PER_TILE = Math.ceil(TILE / FLOWER_STEP) ** 2;
const TILE_COUNT = (() => {
  let n = 0;
  const r = RADIUS + 0.5;
  for (let dz = -RADIUS; dz <= RADIUS; dz++) {
    for (let dx = -RADIUS; dx <= RADIUS; dx++) {
      if (dx * dx + dz * dz <= r * r) n++;
    }
  }
  return n;
})();

interface Tile {
  grass: PoolBlock | null;
  flowers: PoolBlock | null;
}

const key = (tx: number, tz: number) => `${tx},${tz}`;

/**
 * A tuft of crossed tapered quads with vertex colors. No texture and no alpha: the blades are solid,
 * so there is no sorting and no alpha-test overdraw. Five blades read as a clump from any direction.
 */
function tuftGeometry(blades: number, height: number, width: number): BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const base = new Color(0x2d5522);
  const tip = new Color(0x9ac455);
  const topScale = 0.2;

  for (let b = 0; b < blades; b++) {
    const angle = (b / blades) * Math.PI;
    const dx = Math.cos(angle);
    const dz = Math.sin(angle);
    const px = -dz;
    const pz = dx;
    const h = height * (0.8 + 0.35 * (b % 3));
    const lean = 0.15;
    const start = positions.length / 3;
    const points: [number, number, number][] = [
      [-px * width, 0, -pz * width],
      [px * width, 0, pz * width],
      [dx * lean - px * width * topScale, h, dz * lean - pz * width * topScale],
      [dx * lean + px * width * topScale, h, dz * lean + pz * width * topScale],
    ];
    points.forEach(([x, y, z], index) => {
      positions.push(x, y, z);
      normals.push(0, 1, 0);
      const color = index < 2 ? base : tip;
      colors.push(color.r, color.g, color.b);
    });
    indices.push(start, start + 1, start + 2, start + 2, start + 1, start + 3);
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3));
  geometry.setAttribute('color', new BufferAttribute(new Float32Array(colors), 3));
  geometry.setIndex(indices);
  return geometry;
}

/** A flower is a thin stem and a flat bloom, so it reads as a dot of color instead of a colored cone. */
function flowerMeshGeometry(): BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const stem = new Color(0x4a6b2a);
  const petal = new Color(0xffffff);
  const height = 0.18;
  const stemWidth = 0.008;
  const bloom = 0.05;

  const stemPoints: [number, number, number][] = [
    [-stemWidth, 0, 0],
    [stemWidth, 0, 0],
    [-stemWidth * 0.7, height, 0],
    [stemWidth * 0.7, height, 0],
  ];
  for (const [x, y, z] of stemPoints) {
    positions.push(x, y, z);
    normals.push(0, 1, 0);
    colors.push(stem.r, stem.g, stem.b);
  }
  indices.push(0, 1, 2, 2, 1, 3);

  const bloomPoints: [number, number, number][] = [
    [-bloom, height, -bloom],
    [bloom, height, -bloom],
    [-bloom, height, bloom],
    [bloom, height, bloom],
  ];
  for (const [x, y, z] of bloomPoints) {
    positions.push(x, y, z);
    normals.push(0, 1, 0);
    colors.push(petal.r, petal.g, petal.b);
  }
  indices.push(4, 6, 5, 6, 7, 5);

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3));
  geometry.setAttribute('color', new BufferAttribute(new Float32Array(colors), 3));
  geometry.setIndex(indices);
  return geometry;
}

/** Grass and flowers in a ring around the player, drawn as one instanced mesh per type. */
export class GrassField {
  readonly root = new Group();
  private readonly tiles = new Map<string, Tile>();
  private readonly grassGeometry = tuftGeometry(5, 0.45, 0.03);
  private readonly flowerGeometry = flowerMeshGeometry();
  private readonly grassMaterial = new MeshStandardMaterial({ vertexColors: true, roughness: 0.95 });
  private readonly flowerMaterial = new MeshStandardMaterial({ vertexColors: true, roughness: 0.9 });
  private readonly grassPool: InstancedPool;
  private readonly flowerPool: InstancedPool;
  private readonly wanted = new Set<string>();
  private pending: [number, number][] = [];
  private center = { tx: Number.NaN, tz: Number.NaN };

  constructor(
    private readonly terrain: Terrain,
    private readonly seed: number,
    private readonly chunks: ChunkManager,
  ) {
    this.grassPool = new InstancedPool(this.grassGeometry, this.grassMaterial, TILE_COUNT * GRASS_PER_TILE, true);
    this.flowerPool = new InstancedPool(this.flowerGeometry, this.flowerMaterial, TILE_COUNT * FLOWER_PER_TILE, true);
    this.grassPool.mesh.receiveShadow = true;
    this.flowerPool.mesh.receiveShadow = true;
    this.root.add(this.grassPool.mesh, this.flowerPool.mesh);

    this.chunks.setScatterHandlers(
      () => this.nextScatter(),
      (data) => this.placeScatter(data),
    );
  }

  get tileCount(): number {
    return this.tiles.size;
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  update(x: number, z: number, immediate = false): void {
    const tx = Math.floor(x / TILE);
    const tz = Math.floor(z / TILE);
    let removed = false;
    if (tx !== this.center.tx || tz !== this.center.tz) {
      this.center = { tx, tz };
      this.wanted.clear();
      for (let dz = -RADIUS; dz <= RADIUS; dz++) {
        for (let dx = -RADIUS; dx <= RADIUS; dx++) {
          if (dx * dx + dz * dz > (RADIUS + 0.5) ** 2) continue;
          this.wanted.add(key(tx + dx, tz + dz));
        }
      }
      for (const [k] of this.tiles) {
        if (this.wanted.has(k)) continue;
        this.tiles.delete(k);
        removed = true;
      }
      this.pending = this.pending.filter(([px, pz]) => this.wanted.has(key(px, pz)));
      const queued = new Set(this.pending.map(([px, pz]) => key(px, pz)));
      for (const k of this.wanted) {
        if (this.tiles.has(k) || queued.has(k)) continue;
        const [px, pz] = k.split(',').map(Number);
        this.pending.push([px, pz]);
      }
    }
    if (immediate) {
      // Bootstrap: the initial ring is built synchronously before the world shows, exactly as before.
      while (this.pending.length > 0) {
        const [px, pz] = this.pending.shift()!;
        this.placeScatter(buildScatterData(this.terrain, px, pz, this.seed, this.densityAt(px, pz)));
      }
    } else {
      // Streaming: workers pick up pending tiles, chunks first (see ChunkManager.pumpScatter).
      this.chunks.submitScatter();
    }
    // Removed tiles leave gaps in the pool; rebuild it compactly once per tile-ring shift.
    if (removed) this.rewrite();
  }

  /** Density-LOD factor for a tile, from its tile-center distance to the player. */
  private densityAt(tx: number, tz: number): number {
    return grassDensity(Math.hypot(tx - this.center.tx, tz - this.center.tz) * TILE);
  }

  /** Pulled by a free worker: the next wanted tile still waiting for scatter, dropping stale entries. */
  private nextScatter(): [number, number, number] | null {
    while (this.pending.length > 0) {
      const [tx, tz] = this.pending.shift()!;
      if (this.wanted.has(key(tx, tz))) return [tx, tz, this.densityAt(tx, tz)];
    }
    return null;
  }

  private placeScatter(data: ScatterData): void {
    const k = key(data.tx, data.tz);
    if (!this.wanted.has(k) || this.tiles.has(k)) return; // Stale or already placed.
    const tile: Tile = {
      grass: data.grass.matrices.length ? { matrix: data.grass.matrices, color: data.grass.colors } : null,
      flowers: data.flowers.matrices.length ? { matrix: data.flowers.matrices, color: data.flowers.colors } : null,
    };
    this.tiles.set(k, tile);
    if (tile.grass) this.grassPool.append(tile.grass);
    if (tile.flowers) this.flowerPool.append(tile.flowers);
  }

  private rewrite(): void {
    const grass: PoolBlock[] = [];
    const flowers: PoolBlock[] = [];
    for (const tile of this.tiles.values()) {
      if (tile.grass) grass.push(tile.grass);
      if (tile.flowers) flowers.push(tile.flowers);
    }
    this.grassPool.rewrite(grass);
    this.flowerPool.rewrite(flowers);
  }
}
