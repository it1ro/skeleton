import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  ConeGeometry,
  CylinderGeometry,
  Group,
  InstancedMesh,
  LinearFilter,
  LinearMipmapLinearFilter,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Quaternion,
  RepeatWrapping,
  SRGBColorSpace,
  Vector3,
} from 'three/webgpu';
import { CHUNK_SEGMENTS, CHUNK_SIZE } from '@skeleton/shared';
import { recordHitch } from '../bench/hitches.ts';
import type { ChunkData, ChunkRequest } from './terrain.worker.ts';

const VIEW_RADIUS = 6; // chunks
const UNLOAD_RADIUS = VIEW_RADIUS + 2;
const WORKERS = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));
/** Chunk requests in flight per worker. Keeps the queue sorted by distance as the player moves. */
const IN_FLIGHT_PER_WORKER = 2;

interface Chunk {
  group: Group;
  ready: boolean;
}

const key = (cx: number, cz: number) => `${cx},${cz}`;

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
  private readonly trunkGeometry = new CylinderGeometry(0.22, 0.35, 3, 6).translate(0, 1.5, 0);
  private readonly crownGeometry = new ConeGeometry(1.9, 6, 7).translate(0, 5.5, 0);
  private readonly trunkMaterial = new MeshStandardMaterial({ color: 0x5a3d26, roughness: 1 });
  private readonly crownMaterial = new MeshStandardMaterial({ color: 0x2f5a2a, roughness: 1, flatShading: true });
  private center = { cx: Number.NaN, cz: Number.NaN };
  private waiters: { radius: number; resolve: () => void }[] = [];
  private readonly queue: ChunkData[] = [];
  /** Before the first `whenReady` everything is built at once; after it, chunks wait in the queue. */
  private streaming = false;

  constructor(private readonly seed: number) {
    for (let w = 0; w < WORKERS; w++) {
      const worker = new Worker(new URL('./terrain.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (e: MessageEvent<ChunkData>) => {
        this.busy[w]--;
        this.onChunk(e.data);
        this.pump();
      };
      this.workers.push(worker);
      this.busy.push(0);
    }
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
      this.chunks.set(key(x, z), { group: new Group(), ready: false });
      const req: ChunkRequest = { seed: this.seed, cx: x, cz: z };
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

    const count = data.trees.length / 5;
    if (count > 0) {
      const trunks = new InstancedMesh(this.trunkGeometry, this.trunkMaterial, count);
      const crowns = new InstancedMesh(this.crownGeometry, this.crownMaterial, count);
      const m = new Matrix4();
      const q = new Quaternion();
      const up = new Vector3(0, 1, 0);
      for (let i = 0; i < count; i++) {
        const [x, y, z, s, r] = data.trees.subarray(i * 5, i * 5 + 5);
        m.compose(new Vector3(x, y - 0.3, z), q.setFromAxisAngle(up, r), new Vector3(s, s, s));
        trunks.setMatrixAt(i, m);
        crowns.setMatrixAt(i, m);
      }
      for (const mesh of [trunks, crowns]) {
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.computeBoundingSphere();
        chunk.group.add(mesh);
      }
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
      if (child instanceof InstancedMesh) child.dispose();
      else if (child instanceof Mesh) child.geometry.dispose();
    }
  }
}
