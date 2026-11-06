import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Group,
  LinearFilter,
  LinearMipmapLinearFilter,
  Mesh,
  MeshStandardMaterial,
  RepeatWrapping,
  SRGBColorSpace,
} from 'three/webgpu';
import { CHUNK_SEGMENTS, CHUNK_SIZE, PROP_KINDS, TREE_KINDS, type ScatterData } from '@skeleton/shared';
import { recordHitch } from '../bench/hitches.ts';
import { composeInstance, InstancedPool, type PoolBlock } from './instanced-pool.ts';
import {
  createTreeGeometry,
  createTreeMaterial,
  treeVariantCount,
  TREE_POOLS,
  TREE_POOL_START,
} from './trees.ts';
import { createPropGeometry, createPropMaterial } from './props.ts';
import type { ChunkData, WorkerRequest, WorkerResponse } from './terrain.worker.ts';

const VIEW_RADIUS = 5; // chunks (~320 m): the far ring is fully fogged, so it is silhouette, not geometry
const UNLOAD_RADIUS = VIEW_RADIUS + 2;
const WORKERS = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));
/** Chunk requests in flight per worker. Keeps the queue sorted by distance as the player moves. */
const IN_FLIGHT_PER_WORKER = 2;
/** Every chunk that can be loaded at once: the unload square is `2*UNLOAD_RADIUS+1` chunks wide. */
const MAX_LOADED_CHUNKS = (UNLOAD_RADIUS * 2 + 1) ** 2;
/** `treesInChunk` attempts at most 70 trees per chunk (see shared/terrain.ts). */
const TREES_PER_CHUNK = 70;
const TREE_CAPACITY = MAX_LOADED_CHUNKS * TREES_PER_CHUNK;
/** Погост props are bounded by the ~140 m radius around the spawn, far below the chunked trees. */
const PROP_CAPACITY = 512;

/**
 * The grave mound is a unit hemisphere stretched wide and low: 4.2 half-widths and 2.6 heights per unit of the
 * prop's scale. Callers that need to stand or sit beside a mound use the radius, not the raw scale.
 */
export const MOUND_RADIUS = 4.2;
export const MOUND_HEIGHT = 2.6;

interface Chunk {
  group: Group;
  ready: boolean;
  /** Per-kind tree matrix/color blocks in world space; `null` when the chunk has no trees. */
  trees: PoolBlock[] | null;
  /** Per-kind prop matrix/color blocks in world space; `null` when the chunk has no props. */
  props: PoolBlock[] | null;
}

const key = (cx: number, cz: number) => `${cx},${cz}`;

/** Deterministic 0..1 from a world position: per-tree color variation without extra wire data. */
function hash01(x: number, z: number): number {
  const v = Math.sin(x * 127.1 + z * 311.7) * 43758.5453;
  return v - Math.floor(v);
}

function gridIndex(): Uint16Array {
  const n = CHUNK_SEGMENTS + 1;
  const idx = new Uint16Array(CHUNK_SEGMENTS * CHUNK_SEGMENTS * 6);
  let k = 0;
  for (let j = 0; j < CHUNK_SEGMENTS; j++) {
    for (let i = 0; i < CHUNK_SEGMENTS; i++) {
      const a = j * n + i;
      const b = a + 1;
      const c = a + n;
      const d = c + 1;
      idx.set([a, c, b, b, c, d], k);
      k += 6;
    }
  }
  return idx;
}

/**
 * A small tiling texture for the ground: near-white with thin grass strokes and mottling.
 * Vertex colors carry the biome, so the texture only adds tooth and breaks up flat color.
 */
function groundTexture(): CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const context = canvas.getContext('2d')!;
  context.fillStyle = '#f2f0e2';
  context.fillRect(0, 0, size, size);

  let state = 0x9e3779b9;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  for (let i = 0; i < 1400; i++) {
    const x = random() * size;
    const y = random() * size;
    const length = 1 + random() * 6;
    const lean = (random() - 0.5) * 2.5;
    context.strokeStyle = random() > 0.5 ? 'rgba(72, 94, 42, 0.1)' : 'rgba(255, 252, 220, 0.1)';
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(x, y);
    context.lineTo(x + lean, y - length);
    context.stroke();
  }
  for (let i = 0; i < 90; i++) {
    context.fillStyle = random() > 0.5 ? 'rgba(60, 80, 36, 0.05)' : 'rgba(255, 255, 220, 0.05)';
    context.beginPath();
    context.ellipse(random() * size, random() * size, 3 + random() * 9, 2 + random() * 6, random() * Math.PI, 0, Math.PI * 2);
    context.fill();
  }

  const texture = new CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = RepeatWrapping;
  texture.colorSpace = SRGBColorSpace;
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.anisotropy = 4;
  return texture;
}

/** Streams terrain chunks around the player. Geometry is built in Web Workers. */
export class ChunkManager {
  readonly root = new Group();
  private readonly chunks = new Map<string, Chunk>();
  private readonly workers: Worker[] = [];
  private readonly busy: number[] = [];
  /** One index array for all chunks; each chunk wraps it in its own attribute, so disposing a chunk frees only its buffers. */
  private readonly index = gridIndex();
  private readonly groundMaterial = new MeshStandardMaterial({
    vertexColors: true,
    map: groundTexture(),
    roughness: 1,
    metalness: 0,
  });
  /** One instanced pool per tree kind; each is a single merged, vertex-colored geometry. */
  private readonly treePools: InstancedPool[] = [];
  /** Instances at the front of each sorted tree pool that lie within `shadowDistance`. */
  private readonly treeCasters: number[] = [];
  /** One instanced pool per prop kind (mound, cross, bone); order irrelevant, no shadow prefix. */
  private readonly propPools: InstancedPool[] = [];
  private center = { cx: Number.NaN, cz: Number.NaN };
  private waiters: { radius: number; resolve: () => void }[] = [];
  private readonly queue: ChunkData[] = [];
  /** Before the first `whenReady` everything is built at once; after it, chunks wait in the queue. */
  private streaming = false;
  /** Trees farther than this (chunk distance, meters) stay out of the shadow pass: they cannot reach the box. */
  private shadowDistance = Number.POSITIVE_INFINITY;
  /** Scatter requests in flight per worker; at most one, and only while the worker has no pending chunk. */
  private readonly scatterBusy: number[] = [];
  private scatterSource: (() => [number, number, number] | null) | null = null;
  private scatterSink: ((data: ScatterData) => void) | null = null;

  constructor(private readonly seed: number) {
    const treeMaterial = createTreeMaterial();
    TREE_POOLS.forEach(({ kind, variant }, index) => {
      const pool = new InstancedPool(createTreeGeometry(kind, variant), treeMaterial, TREE_CAPACITY, true, true);
      this.treePools.push(pool);
      this.treeCasters.push(Number.POSITIVE_INFINITY);
      pool.mesh.castShadow = true;
      pool.mesh.receiveShadow = true;
      // The pools hold every loaded tree; the shadow pass draws only the near prefix, because a tree outside
      // the shadow box cannot cast into it. These hooks bracket that one render, so the color pass draws all.
      pool.mesh.onBeforeShadow = () => {
        pool.mesh.count = Math.min(this.treeCasters[index], pool.count);
      };
      pool.mesh.onAfterShadow = () => {
        pool.mesh.count = pool.count;
      };
      this.root.add(pool.mesh);
    });

    const propMaterial = createPropMaterial();
    PROP_KINDS.forEach((kind) => {
      const pool = new InstancedPool(createPropGeometry(kind), propMaterial, PROP_CAPACITY, true);
      // Mounds and crosses cast; bones only receive (they are small, near-ground detail).
      pool.mesh.castShadow = kind !== 'bone';
      pool.mesh.receiveShadow = true;
      this.propPools.push(pool);
      this.root.add(pool.mesh);
    });

    for (let w = 0; w < WORKERS; w++) {
      const worker = new Worker(new URL('./terrain.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
        const data = e.data;
        if (data.type === 'chunk') {
          this.busy[w]--;
          this.onChunk(data);
        } else {
          this.scatterBusy[w]--;
          this.scatterSink?.(data);
        }
        this.pump();
      };
      this.workers.push(worker);
      this.busy.push(0);
      this.scatterBusy.push(0);
    }
  }

  /** Registers the grass field's pull/push callbacks: a tile source for free workers and a result sink. */
  setScatterHandlers(source: () => [number, number, number] | null, sink: (data: ScatterData) => void): void {
    this.scatterSource = source;
    this.scatterSink = sink;
  }

  /** Tells free workers to pick up any scatter tiles the grass field is waiting for. */
  submitScatter(): void {
    this.pumpScatter();
  }

  /** Resolves once every chunk within `radius` chunks of the current center is built. Call after `update`. */
  whenReady(radius: number): Promise<void> {
    return new Promise((resolve) => {
      this.waiters.push({ radius, resolve });
      this.checkWaiters();
    });
  }

  private checkWaiters(): void {
    this.waiters = this.waiters.filter((w) => {
      if (!this.readyAround(w.radius)) return true;
      this.streaming = true;
      w.resolve();
      return false;
    });
  }

  private readyAround(radius: number): boolean {
    const { cx, cz } = this.center;
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (dx * dx + dz * dz > (radius + 0.5) ** 2) continue;
        if (!this.chunks.get(key(cx + dx, cz + dz))?.ready) return false;
      }
    }
    return true;
  }

  get loaded(): number {
    let n = 0;
    for (const c of this.chunks.values()) if (c.ready) n++;
    return n;
  }

  get queueCount(): number {
    return this.queue.length;
  }

  /** Tree instances the shadow pass draws: the near prefix of the pools, not every loaded tree. */
  get shadowCasters(): number {
    return this.treePools.reduce(
      (sum, pool, index) => sum + Math.min(this.treeCasters[index], pool.count),
      0,
    );
  }

  update(x: number, z: number): void {
    this.drain();
    const cx = Math.floor(x / CHUNK_SIZE);
    const cz = Math.floor(z / CHUNK_SIZE);
    if (cx === this.center.cx && cz === this.center.cz) return;
    this.center = { cx, cz };

    for (const [k, chunk] of this.chunks) {
      const [x0, z0] = k.split(',').map(Number);
      if (Math.max(Math.abs(x0 - cx), Math.abs(z0 - cz)) > UNLOAD_RADIUS) {
        this.dispose(chunk);
        this.chunks.delete(k);
      }
    }
    this.pump();
    // Re-sort on every chunk move: the shadow pass draws the near prefix of the pools, so the order matters.
    this.rewriteTrees();
    this.rewriteProps();
  }

  /** Builds one queued chunk per frame, nearest first: a chunk boundary no longer lands in a single frame. */
  private drain(): void {
    if (this.queue.length === 0) return;
    const { cx, cz } = this.center;
    let best = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let i = 0; i < this.queue.length; i++) {
      const dx = this.queue[i].cx - cx;
      const dz = this.queue[i].cz - cz;
      const distance = dx * dx + dz * dz;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = i;
      }
    }
    const [data] = this.queue.splice(best, 1);
    this.build(data);
  }

  /** Sends the nearest missing chunks to free workers. */
  private pump(): void {
    const { cx, cz } = this.center;
    const wanted: [number, number, number][] = [];
    for (let dz = -VIEW_RADIUS; dz <= VIEW_RADIUS; dz++) {
      for (let dx = -VIEW_RADIUS; dx <= VIEW_RADIUS; dx++) {
        if (dx * dx + dz * dz > (VIEW_RADIUS + 0.5) ** 2) continue;
        if (!this.chunks.has(key(cx + dx, cz + dz))) wanted.push([cx + dx, cz + dz, dx * dx + dz * dz]);
      }
    }
    wanted.sort((a, b) => a[2] - b[2]);
    for (const [x, z] of wanted) {
      const w = this.busy.indexOf(Math.min(...this.busy));
      if (this.busy[w] >= IN_FLIGHT_PER_WORKER) break;
      this.busy[w]++;
      this.chunks.set(key(x, z), { group: new Group(), ready: false, trees: null, props: null });
      const req: WorkerRequest = { type: 'chunk', seed: this.seed, cx: x, cz: z };
      this.workers[w].postMessage(req);
    }
    this.pumpScatter();
  }

  /** Submits scatter tiles to workers that have no pending chunk and no scatter in flight. */
  private pumpScatter(): void {
    if (!this.scatterSource) return;
    for (let w = 0; w < WORKERS; w++) {
      if (this.busy[w] > 0 || this.scatterBusy[w] > 0) continue;
      const tile = this.scatterSource();
      if (!tile) break;
      const [tx, tz, density] = tile;
      this.scatterBusy[w]++;
      const req: WorkerRequest = { type: 'scatter', seed: this.seed, tx, tz, density };
      this.workers[w].postMessage(req);
    }
  }

  private onChunk(data: ChunkData): void {
    if (this.streaming) {
      this.queue.push(data);
      return;
    }
    this.build(data);
  }

  private build(data: ChunkData): void {
    const chunk = this.chunks.get(key(data.cx, data.cz));
    if (!chunk) return; // Unloaded while it was being built.
    const startedAt = performance.now();

    const geometry = new BufferGeometry();
    geometry.setIndex(new BufferAttribute(this.index, 1));
    geometry.setAttribute('position', new BufferAttribute(data.positions, 3));
    geometry.setAttribute('normal', new BufferAttribute(data.normals, 3));
    geometry.setAttribute('color', new BufferAttribute(data.colors, 3));
    geometry.setAttribute('uv', new BufferAttribute(data.uvs, 2));
    geometry.computeBoundingSphere();
    const ground = new Mesh(geometry, this.groundMaterial);
    ground.receiveShadow = true;
    chunk.group.add(ground);

    const count = data.trees.length / 6;
    if (count > 0) {
      const ox = data.cx * CHUNK_SIZE;
      const oz = data.cz * CHUNK_SIZE;
      const byPool: number[][] = TREE_POOLS.map(() => []);
      for (let i = 0; i < count; i++) {
        const base = i * 6;
        const kind = data.trees[base + 5] | 0;
        const x = data.trees[base];
        const z = data.trees[base + 2];
        const variant = Math.floor(hash01(x, z) * treeVariantCount(TREE_KINDS[kind]));
        byPool[TREE_POOL_START[kind] + variant].push(i);
      }
      const blocks = byPool.map((indices, index) => {
        const matrix = new Float32Array(indices.length * 16);
        const color = new Float32Array(indices.length * 3);
        const wind = new Float32Array(indices.length * 4);
        // The geometry's own height, so the per-instance amplitude follows the tree's real size.
        const top = this.treePools[index].mesh.geometry.userData.top as number;
        indices.forEach((tree, at) => {
          const base = tree * 6;
          const x = data.trees[base];
          const y = data.trees[base + 1];
          const z = data.trees[base + 2];
          const scale = data.trees[base + 3];
          const rotation = data.trees[base + 4];
          // Three independent sizes: footprint from the wire scale, height and width by hashes.
          const height = scale * (0.85 + hash01(z, x) * 0.4);
          const spreadX = scale * (0.88 + hash01(x + 3.1, z) * 0.24);
          const spreadZ = scale * (0.88 + hash01(x, z + 5.7) * 0.24);
          // No trunk stands plumb: a degree or two of lean, planted at the same base point.
          const tiltX = (hash01(x + 11.3, z) - 0.5) * 0.11;
          const tiltZ = (hash01(x, z + 7.7) - 0.5) * 0.11;
          composeInstance(matrix, at, x + ox, y - 0.35, z + oz, rotation, spreadX, height, spreadZ, tiltX, tiltZ);
          const tint = 0.9 + hash01(x, z) * 0.2;
          // A hint of hue drift: some trees yellow, some blue-green, none of them the same.
          color[at * 3] = tint * (0.97 + hash01(x + 1.7, z + 2.3) * 0.06);
          color[at * 3 + 1] = tint;
          color[at * 3 + 2] = tint * (0.94 + hash01(z + 4.1, x + 5.9) * 0.08);
          // Wind: base (a gust reaches the whole crown at once), a phase stable across chunk rewrites,
          // and the world height the shader scales the sway by.
          wind[at * 4] = x + ox;
          wind[at * 4 + 1] = z + oz;
          wind[at * 4 + 2] = hash01(x + 41.7, z + 13.1) * Math.PI * 2;
          wind[at * 4 + 3] = top * height;
        });
        return { matrix, color, wind };
      });
      chunk.trees = blocks;
      blocks.forEach((block, index) => this.treePools[index].append(block));
      // Appends land at the end, so a chunk built inside the shadow box has to be sorted into the prefix.
      if (this.withinShadow(data.cx, data.cz)) this.rewriteTrees();
    }

    const propCount = data.props.length / 6;
    if (propCount > 0) {
      const ox = data.cx * CHUNK_SIZE;
      const oz = data.cz * CHUNK_SIZE;
      const byKind: number[][] = PROP_KINDS.map(() => []);
      for (let i = 0; i < propCount; i++) {
        byKind[data.props[i * 6 + 5] | 0].push(i);
      }
      const blocks = byKind.map((indices, kind) => {
        const matrix = new Float32Array(indices.length * 16);
        const color = new Float32Array(indices.length * 3);
        const propKind = PROP_KINDS[kind];
        indices.forEach((prop, at) => {
          const base = prop * 6;
          const x = data.props[base];
          const y = data.props[base + 1];
          const z = data.props[base + 2];
          const scale = data.props[base + 3];
          const rotation = data.props[base + 4];
          if (propKind === 'mound') {
            // A wide, low hill: the geometry is a unit hemisphere, sized and sunk so the skirt meets the ground.
            composeInstance(matrix, at, x + ox, y - 0.3, z + oz, rotation, MOUND_RADIUS * scale, MOUND_HEIGHT * scale);
          } else {
            // Crosses and bones carry real proportions in the geometry; uniform scale only.
            composeInstance(matrix, at, x + ox, y, z + oz, rotation, scale);
          }
          const tint = 0.9 + hash01(x, z) * 0.2;
          color[at * 3] = tint;
          color[at * 3 + 1] = tint;
          color[at * 3 + 2] = tint;
        });
        return { matrix, color };
      });
      chunk.props = blocks;
      blocks.forEach((block, kind) => this.propPools[kind].append(block));
    }

    chunk.group.position.set(data.cx * CHUNK_SIZE, 0, data.cz * CHUNK_SIZE);
    chunk.ready = true;
    this.root.add(chunk.group);
    this.checkWaiters();
    recordHitch('chunk', startedAt);
  }

  private dispose(chunk: Chunk): void {
    this.root.remove(chunk.group);
    for (const child of chunk.group.children) {
      if (child instanceof Mesh) child.geometry.dispose();
    }
  }

  /** Sets the radius of tree shadows: the light's coverage plus a chunk of slack for the chunk-granular rebuild. */
  setShadowDistance(coverage: number): void {
    const next = Number.isFinite(coverage) ? Math.max(0, coverage) + CHUNK_SIZE : Number.POSITIVE_INFINITY;
    if (next === this.shadowDistance) return;
    this.shadowDistance = next;
    if (this.chunks.size > 0) this.rewriteTrees();
  }

  /** True when the chunk lies close enough to the player to hold shadow casters. */
  private withinShadow(cx: number, cz: number): boolean {
    if (!Number.isFinite(this.center.cx)) return false;
    return Math.max(Math.abs(cx - this.center.cx), Math.abs(cz - this.center.cz)) * CHUNK_SIZE <= this.shadowDistance;
  }

  /**
   * Rewrites the tree pools compactly, nearest chunk first, and counts the prefix inside `shadowDistance`.
   * The shadow pass draws only that prefix: far trees are not where the light's box is, so drawing them into
   * the shadow map is pure vertex work.
   */
  private rewriteTrees(): void {
    const { cx, cz } = this.center;
    const chunks: { distance: number; blocks: PoolBlock[] }[] = [];
    for (const [k, chunk] of this.chunks) {
      if (!chunk.trees) continue;
      const [x, z] = k.split(',').map(Number);
      const distance = Number.isFinite(cx) ? Math.max(Math.abs(x - cx), Math.abs(z - cz)) * CHUNK_SIZE : 0;
      chunks.push({ distance, blocks: chunk.trees });
    }
    chunks.sort((a, b) => a.distance - b.distance);
    this.treePools.forEach((pool, index) => {
      pool.rewrite(chunks.map((chunk) => chunk.blocks[index]));
      this.treeCasters[index] = 0;
    });
    for (const chunk of chunks) {
      if (chunk.distance > this.shadowDistance) break;
      this.treePools.forEach((_, index) => {
        this.treeCasters[index] += chunk.blocks[index].matrix.length / 16;
      });
    }
  }

  /** Rewrites the prop pools compactly. Order is irrelevant (no shadow prefix), so it only compacts. */
  private rewriteProps(): void {
    const blocks: PoolBlock[][] = this.propPools.map(() => []);
    for (const chunk of this.chunks.values()) {
      if (!chunk.props) continue;
      chunk.props.forEach((block, kind) => blocks[kind].push(block));
    }
    this.propPools.forEach((pool, kind) => pool.rewrite(blocks[kind]));
  }
}
