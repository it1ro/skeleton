/// <reference lib="webworker" />
import {
  CHUNK_SEGMENTS,
  CHUNK_SIZE,
  buildScatterData,
  createTerrain,
  type Biome,
  type ScatterData,
  type Terrain,
} from '@skeleton/shared';

export interface ChunkRequest {
  type: 'chunk';
  seed: number;
  cx: number;
  cz: number;
}

export interface ScatterRequest {
  type: 'scatter';
  seed: number;
  tx: number;
  tz: number;
}

export type WorkerRequest = ChunkRequest | ScatterRequest;

export interface ChunkData {
  type: 'chunk';
  cx: number;
  cz: number;
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  /** World-space UVs for the ground texture; 1 unit is 4 m, so the texture tiles seamlessly across chunks. */
  uvs: Float32Array;
  /** x, y, z, scale, rotation per tree, relative to the chunk origin. */
  trees: Float32Array;
}

export interface ScatterResult extends ScatterData {
  type: 'scatter';
}

export type WorkerResponse = ChunkData | ScatterResult;

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const rgb = (hex: number): [number, number, number] => [
  toLinear(((hex >> 16) & 255) / 255),
  toLinear(((hex >> 8) & 255) / 255),
  toLinear((hex & 255) / 255),
];

const PALETTE: Record<Biome | 'rock' | 'snow', [number, number, number]> = {
  ocean: rgb(0x6b6146),
  beach: rgb(0xc9b58a),
  meadows: rgb(0x6f9a3a),
  forest: rgb(0x3f6a2c),
  mountain: rgb(0x8d8a84),
  rock: rgb(0x6e6a63),
  snow: rgb(0xeef2f5),
};

/** Ground texture tile in meters. The meadow blades are strokes on the texture; near grass is separate. */
const TEXTURE_TILE = 4;

let terrain: Terrain | null = null;

/** Builds the ground mesh + tree data for one chunk, sampling each height once via a halo grid. */
function buildChunk(t: Terrain, cx: number, cz: number): ChunkData {
  const n = CHUNK_SEGMENTS + 1;
  const N = n + 2; // + 1-cell halo on each side
  const step = CHUNK_SIZE / CHUNK_SEGMENTS;
  const ox = cx * CHUNK_SIZE;
  const oz = cz * CHUNK_SIZE;

  // Height/biome cache on a (n+2)×(n+2) grid: one heightAt per point feeds positions, normals and
  // biome, instead of 5 heightAt calls per vertex (self + 4 normal neighbours).
  const heights = new Float32Array(N * N);
  const biomes = new Array<Biome>(N * N);
  for (let gj = 0; gj < N; gj++) {
    const wz = oz + (gj - 1) * step;
    for (let gi = 0; gi < N; gi++) {
      const wx = ox + (gi - 1) * step;
      const h = t.heightAt(wx, wz);
      heights[gj * N + gi] = h;
      biomes[gj * N + gi] = t.biomeAt(wx, wz, h);
    }
  }

  const positions = new Float32Array(n * n * 3);
  const normals = new Float32Array(n * n * 3);
  const colors = new Float32Array(n * n * 3);
  const uvs = new Float32Array(n * n * 2);

  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const gi = i + 1;
      const gj = j + 1;
      const lx = i * step;
      const lz = j * step;
      const h = heights[gj * N + gi];
      const k = (j * n + i) * 3;
      positions[k] = lx;
      positions[k + 1] = h;
      positions[k + 2] = lz;

      const uv = (j * n + i) * 2;
      uvs[uv] = (ox + lx) / TEXTURE_TILE;
      uvs[uv + 1] = (oz + lz) / TEXTURE_TILE;

      // Normals from the height function, not from the mesh: no seams between chunks.
      const nx = heights[gj * N + (gi - 1)] - heights[gj * N + (gi + 1)];
      const nz = heights[(gj - 1) * N + gi] - heights[(gj + 1) * N + gi];
      const ny = 2 * step;
      const len = Math.hypot(nx, ny, nz);
      normals[k] = nx / len;
      normals[k + 1] = ny / len;
      normals[k + 2] = nz / len;

      const slope = 1 - ny / len;
      const biome = biomes[gj * N + gi];
      let c: [number, number, number] = PALETTE[biome];
      if (h > 62) c = PALETTE.snow;
      else if (slope > 0.25 && biome !== 'ocean') c = PALETTE.rock;
      else if (biome === 'meadows') {
        // Broad light and dark patches: the far field reads as a meadow even without near grass.
        const patch = Math.sin((ox + lx) * 0.045) * Math.cos((oz + lz) * 0.038);
        const tone = 0.9 + patch * 0.1;
        c = [c[0] * tone, c[1] * (tone + 0.03), c[2] * tone];
      }
      // Small per-vertex jitter breaks up flat color areas.
      const jitter = 0.92 + (((i * 73856093) ^ (j * 19349663) ^ (cx * 83492791) ^ (cz * 2971215073)) & 255) / 255 * 0.16;
      colors[k] = c[0] * jitter;
      colors[k + 1] = c[1] * jitter;
      colors[k + 2] = c[2] * jitter;
    }
  }

  const spots = t.treesInChunk(cx, cz);
  const trees = new Float32Array(spots.length * 5);
  spots.forEach((s, i) => trees.set([s.x - ox, s.y, s.z - oz, s.scale, s.rotation], i * 5));

  return { type: 'chunk', cx, cz, positions, normals, colors, uvs, trees };
}

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  if (!terrain || terrain.seed !== msg.seed) terrain = createTerrain(msg.seed);
  const t = terrain;

  if (msg.type === 'chunk') {
    const data = buildChunk(t, msg.cx, msg.cz);
    self.postMessage(data, [data.positions.buffer, data.normals.buffer, data.colors.buffer, data.uvs.buffer, data.trees.buffer]);
  } else {
    const data = buildScatterData(t, msg.tx, msg.tz, msg.seed);
    const response: ScatterResult = { type: 'scatter', ...data };
    self.postMessage(response, [
      data.grass.matrices.buffer,
      data.grass.colors.buffer,
      data.flowers.matrices.buffer,
      data.flowers.colors.buffer,
    ]);
  }
};
