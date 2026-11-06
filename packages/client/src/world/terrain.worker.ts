/// <reference lib="webworker" />
import {
  CHUNK_SEGMENTS,
  CHUNK_SIZE,
  PROP_KINDS,
  TREE_KINDS,
  buildScatterData,
  createTerrain,
  groundColorBlend,
  type BiomeBlend,
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
  /** Density-LOD multiplier in 0..1: lowers the instance count with distance, not the geometry. */
  density: number;
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
  /** x, y, z, scale, rotation, kind index per tree, relative to the chunk origin. */
  trees: Float32Array;
  /** x, y, z, scale, rotation, kind index per Погост prop, relative to the chunk origin. */
  props: Float32Array;
}

export interface ScatterResult extends ScatterData {
  type: 'scatter';
}

export type WorkerResponse = ChunkData | ScatterResult;

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

  // Height cache on a (n+2)×(n+2) grid: one heightAt per point feeds positions and normals, instead of
  // 5 heightAt calls per vertex (self + 4 normal neighbours).
  const heights = new Float32Array(N * N);
  for (let gj = 0; gj < N; gj++) {
    const wz = oz + (gj - 1) * step;
    for (let gi = 0; gi < N; gi++) {
      const wx = ox + (gi - 1) * step;
      heights[gj * N + gi] = t.heightAt(wx, wz);
    }
  }
  // Scratch for the per-vertex biome blend: the worker builds thousands of vertices, no allocation.
  const blend: BiomeBlend = { biome: 'meadows', mixWith: 'meadows', mix: 0 };

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
      const wx = ox + lx;
      const wz = oz + lz;
      t.biomeBlendAt(wx, wz, blend, h);
      // Ground color: muted biome base (mixed with the neighbour at a feathered soil edge) plus
      // moss/earth/ash/puddle patches by noise, slope and height.
      const c = groundColorBlend(blend.biome, blend.mixWith, blend.mix, h, slope, wx, wz);
      // Small world-space jitter breaks up flat color areas; world-space so chunk borders don't seam.
      const jr = Math.sin((ox + lx) * 127.1 + (oz + lz) * 311.7) * 43758.5453;
      const jitter = 0.92 + (jr - Math.floor(jr)) * 0.16;
      colors[k] = c[0] * jitter;
      colors[k + 1] = c[1] * jitter;
      colors[k + 2] = c[2] * jitter;
    }
  }

  const spots = t.treesInChunk(cx, cz);
  const trees = new Float32Array(spots.length * 6);
  spots.forEach((s, i) =>
    trees.set([s.x - ox, s.y, s.z - oz, s.scale, s.rotation, TREE_KINDS.indexOf(s.kind)], i * 6),
  );

  const propsSpots = t.propsInChunk(cx, cz);
  const props = new Float32Array(propsSpots.length * 6);
  propsSpots.forEach((s, i) =>
    props.set([s.x - ox, s.y, s.z - oz, s.scale, s.rotation, PROP_KINDS.indexOf(s.kind)], i * 6),
  );

  return { type: 'chunk', cx, cz, positions, normals, colors, uvs, trees, props };
}

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  if (!terrain || terrain.seed !== msg.seed) terrain = createTerrain(msg.seed);
  const t = terrain;

  if (msg.type === 'chunk') {
    const data = buildChunk(t, msg.cx, msg.cz);
    self.postMessage(data, [data.positions.buffer, data.normals.buffer, data.colors.buffer, data.uvs.buffer, data.trees.buffer, data.props.buffer]);
  } else {
    const data = buildScatterData(t, msg.tx, msg.tz, msg.seed, msg.density);
    const response: ScatterResult = { type: 'scatter', ...data };
    self.postMessage(response, [
      data.grass.matrices.buffer,
      data.grass.colors.buffer,
      data.flowers.matrices.buffer,
      data.flowers.colors.buffer,
    ]);
  }
};
