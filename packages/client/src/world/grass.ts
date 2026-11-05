import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  MeshStandardMaterial,
} from 'three/webgpu';
import { hash3, mulberry32, type Terrain } from '@skeleton/shared';
import { recordHitch } from '../bench/hitches.ts';
import { composeInstance, InstancedPool, type PoolBlock } from './instanced-pool.ts';

/** Square grass tile in meters. The field covers a ring of tiles around the player and follows them. */
const TILE = 16;
/** Tiles from the center in each direction: 7 tiles is a 112 m radius. Beyond it the ground texture takes over. */
const RADIUS = 7;
const GRASS_STEP = 0.5;
const GRASS_KEEP = 0.55;
const FLOWER_STEP = 1.6;
const FLOWER_KEEP = 0.65;
/** Milliseconds per frame spent building new tiles while the player moves. */
const BUDGET_MS = 4;

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

const _shade = new Color();

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
  private readonly flowerPalette = [new Color(0xffe07a), new Color(0xf4f1e0), new Color(0x9aa8ff), new Color(0xe89cb4)];
  private readonly grassPool: InstancedPool;
  private readonly flowerPool: InstancedPool;
  private readonly wanted = new Set<string>();
  private pending: [number, number][] = [];
  private center = { tx: Number.NaN, tz: Number.NaN };

  constructor(
    private readonly terrain: Terrain,
    private readonly seed: number,
  ) {
    this.grassPool = new InstancedPool(this.grassGeometry, this.grassMaterial, TILE_COUNT * GRASS_PER_TILE, true);
    this.flowerPool = new InstancedPool(this.flowerGeometry, this.flowerMaterial, TILE_COUNT * FLOWER_PER_TILE, true);
    this.grassPool.mesh.receiveShadow = true;
    this.flowerPool.mesh.receiveShadow = true;
    this.root.add(this.grassPool.mesh, this.flowerPool.mesh);
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
    this.drain(immediate);
    // Removed tiles leave gaps in the pool; rebuild it compactly once per tile-ring shift.
    if (removed) this.rewrite();
  }

  /** Builds at most `BUDGET_MS` of new tiles per frame; the leading edge catches up over a few frames. */
  private drain(immediate: boolean): void {
    if (this.pending.length === 0) return;
    if (immediate) {
      while (this.pending.length > 0) this.addTile(this.pending.shift()!);
      return;
    }
    const deadline = performance.now() + BUDGET_MS;
    do {
      this.addTile(this.pending.shift()!);
    } while (this.pending.length > 0 && performance.now() < deadline);
  }

  private addTile([tx, tz]: [number, number]): void {
    const k = key(tx, tz);
    if (this.tiles.has(k)) return;
    const tile = this.buildTile(tx, tz);
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

  private buildTile(tx: number, tz: number): Tile {
    const startedAt = performance.now();
    const ox = tx * TILE;
    const oz = tz * TILE;

    const grassMatrix = new Float32Array(GRASS_PER_TILE * 16);
    const grassColor = new Float32Array(GRASS_PER_TILE * 3);
    let g = 0;
    const rnd = mulberry32(hash3(tx, tz, this.seed ^ 0x51ed270b));
    const grassCount = Math.ceil(TILE / GRASS_STEP);
    for (let j = 0; j < grassCount; j++) {
      for (let i = 0; i < grassCount; i++) {
        const x = ox + (i + rnd()) * GRASS_STEP;
        const z = oz + (j + rnd()) * GRASS_STEP;
        if (rnd() > GRASS_KEEP) continue;
        const h = this.terrain.heightAt(x, z);
        if (this.terrain.biomeAt(x, z, h) !== 'meadows') continue;
        const rotation = rnd() * Math.PI * 2;
        const scale = 0.7 + rnd() * 1.0;
        const shade = rnd();
        composeInstance(grassMatrix, g, x, h, z, rotation, scale);
        _shade.setRGB(0.7 + shade * 0.45, 0.8 + shade * 0.3, 0.45 + shade * 0.3);
        _shade.toArray(grassColor, g * 3);
        g++;
      }
    }

    const flowerMatrix = new Float32Array(FLOWER_PER_TILE * 16);
    const flowerColor = new Float32Array(FLOWER_PER_TILE * 3);
    let f = 0;
    const flowerRnd = mulberry32(hash3(tx, tz, this.seed ^ 0x2f6a88d1));
    const flowerCount = Math.ceil(TILE / FLOWER_STEP);
    for (let j = 0; j < flowerCount; j++) {
      for (let i = 0; i < flowerCount; i++) {
        const x = ox + (i + flowerRnd()) * FLOWER_STEP;
        const z = oz + (j + flowerRnd()) * FLOWER_STEP;
        if (flowerRnd() > FLOWER_KEEP) continue;
        if (Math.sin(x * 0.11) + Math.cos(z * 0.09) < 0.2) continue;
        const h = this.terrain.heightAt(x, z);
        if (this.terrain.biomeAt(x, z, h) !== 'meadows') continue;
        const rotation = flowerRnd() * Math.PI * 2;
        const scale = 1 + flowerRnd() * 0.6;
        const shade = flowerRnd();
        composeInstance(flowerMatrix, f, x, h, z, rotation, scale);
        _shade.copy(this.flowerPalette[Math.min(this.flowerPalette.length - 1, Math.floor(shade * this.flowerPalette.length))]);
        _shade.toArray(flowerColor, f * 3);
        f++;
      }
    }

    recordHitch('grass', startedAt);
    return {
      grass: g ? { matrix: grassMatrix.slice(0, g * 16), color: grassColor.slice(0, g * 3) } : null,
      flowers: f ? { matrix: flowerMatrix.slice(0, f * 16), color: flowerColor.slice(0, f * 3) } : null,
    };
  }
}
