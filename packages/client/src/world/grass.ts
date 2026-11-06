import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  MeshStandardMaterial,
  MeshStandardNodeMaterial,
} from 'three/webgpu';
import { Fn, attribute, positionLocal, sin, time, uniform, vec3 } from 'three/tsl';
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

/** Deterministic 0..1 from a seed, so each blade in a tuft gets its own size and lean. */
function hash01(seed: number): number {
  const v = Math.sin(seed * 12.9898) * 43758.5453;
  return v - Math.floor(v);
}

const TAU = Math.PI * 2;
const BLADE_BASE = new Color(0x3a4a2a);
const BLADE_TIP = new Color(0x9aa86a);
/** A few blades dry out: a warm shift at the tip keeps the meadow from reading as one flat green. */
const BLADE_DRY = new Color(0xb9a45c);
const BLADE_BASE_DRY = new Color(0x4a4626);

/** Width multiplier along a blade: narrow root, broadest in the lower third, then a long taper to a point. */
function bladeWidth(t: number): number {
  const root = 0.6 + 0.4 * Math.min(1, t / 0.3);
  const tip = t < 0.6 ? 1 : 1 - 0.92 * Math.pow((t - 0.6) / 0.4, 0.85);
  return root * tip;
}

/**
 * A tuft of blades bent along arcs, with vertex colors. No texture and no alpha: the blades are solid,
 * so there is no sorting and no alpha-test overdraw.
 *
 * Each blade is a ribbon of `segments` quads whose centerline follows an arc with a tangent that turns
 * faster toward the tip: the root stands up, the tip arches over and on long blades falls back below
 * its own high point. Arc length, root lean, total bend and azimuth are hashed per blade, so a tuft is
 * a ragged clump with blades curved to different degrees — not a star of straight slivers.
 *
 * Normals stay up (0, 1, 0): a blade lit by its own face would flicker from dark to light as it turns,
 * while an upward normal keeps the meadow evenly lit and lets the baked color do the volume.
 */
export function tuftGeometry(blades: number, height: number, width: number, segments = 2): BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const weights: number[] = [];
  const indices: number[] = [];
  const step = 1 / segments;

  for (let b = 0; b < blades; b++) {
    const s = b * 13.7;
    const azimuth = hash01(s + 0.5) * TAU;
    const dx = Math.cos(azimuth);
    const dz = Math.sin(azimuth);
    const px = -dz;
    const pz = dx;
    // Roots sit on a small disc, not on one point: the blades splay from a clump instead of a star.
    const rootR = 0.006 + hash01(s + 1) * 0.026;
    const length = height * (0.5 + hash01(s + 2) * 0.85);
    const rootLean = 0.04 + hash01(s + 3) * 0.3;
    const bend = 0.18 + Math.pow(hash01(s + 4), 1.5) * 1.6;
    const w0 = width * (0.6 + hash01(s + 5) * 0.9);
    const dry = hash01(s + 6);
    const light = 0.88 + hash01(s + 7) * 0.24;
    const baseColor = BLADE_BASE.clone().lerp(BLADE_BASE_DRY, dry * 0.35).multiplyScalar(light);
    const tipColor = BLADE_TIP.clone().lerp(BLADE_DRY, dry * 0.5).multiplyScalar(light);

    // Centerline: midpoint integration of the arc, one segment per row. The tangent turns with `t^1.7`,
    // so the lower half stays upright and the upper half does most of the bending.
    const centre: [number, number][] = [];
    let cx = 0;
    let cy = 0;
    for (let r = 0; r <= segments; r++) {
      centre.push([cx, cy]);
      const angle = rootLean + bend * Math.pow((r + 0.5) * step, 1.7);
      cx += length * step * Math.sin(angle);
      cy += length * step * Math.cos(angle);
    }

    const start = positions.length / 3;
    for (let r = 0; r <= segments; r++) {
      const t = r / segments;
      const [ox, oy] = centre[r];
      const w = w0 * bladeWidth(t);
      const x = dx * (rootR + ox);
      const z = dz * (rootR + ox);
      positions.push(x - px * w, oy, z - pz * w, x + px * w, oy, z + pz * w);
      normals.push(0, 1, 0, 0, 1, 0);
      // Wind weight: 0 at the root, ~1 at the tip of a nominal-height blade. The shader reads it after
      // instancing, where `positionLocal` is already world space and the root height is gone.
      weights.push(oy / height, oy / height);
      const color = baseColor.clone().lerp(tipColor, Math.pow(t, 0.85));
      colors.push(color.r, color.g, color.b, color.r, color.g, color.b);
    }
    for (let r = 0; r < segments; r++) {
      const i = start + r * 2;
      indices.push(i, i + 1, i + 2, i + 2, i + 1, i + 3);
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3));
  geometry.setAttribute('color', new BufferAttribute(new Float32Array(colors), 3));
  geometry.setAttribute('blade', new BufferAttribute(new Float32Array(weights), 1));
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

/**
 * One material for all grass. Wind is a vertex displacement that grows with the blade weight squared:
 * the root stays planted, the tip sways a few centimetres.
 *
 * The phase comes from the world position, not from `instanceIndex`: gusts then travel across the
 * meadow, and the field does not jump when a tile ring shift rewrites the instance order. Note that
 * `positionLocal` is already world space here — three applies the instance transform before
 * `positionNode` — so the sway direction is shared by the whole meadow and the root height must come
 * from the baked `blade` weight.
 */
function createGrassMaterial(): MeshStandardNodeMaterial {
  const material = new MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.95 });
  const wind = uniform(0.05); // metres of sway at the tip of a full-height blade

  material.positionNode = Fn(() => {
    const p = positionLocal;
    // Two waves with different lengths, drifting in the same direction: a gust, not a shudder.
    const wave = sin(time.mul(1.7).sub(p.x.mul(0.55)).sub(p.z.mul(0.3)))
      .mul(0.7)
      .add(sin(time.mul(2.4).sub(p.x.mul(1.2)).sub(p.z.mul(0.8))).mul(0.3));
    const weight = attribute('blade', 'float').pow(2);
    const sway = wave.mul(weight).mul(wind);
    return p.add(vec3(sway, 0, sway.mul(0.4)));
  })();

  return material;
}

/** Grass and flowers in a ring around the player, drawn as one instanced mesh per type. */
export class GrassField {
  readonly root = new Group();
  private readonly tiles = new Map<string, Tile>();
  // Two segments per blade: 5 blades × 4 triangles = 20 triangles per tuft (10 with the old straight quads).
  private readonly grassGeometry = tuftGeometry(5, 0.45, 0.03);
  private readonly flowerGeometry = flowerMeshGeometry();
  private readonly grassMaterial = createGrassMaterial();
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
