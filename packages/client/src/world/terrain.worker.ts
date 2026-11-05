/// <reference lib="webworker" />
import { CHUNK_SEGMENTS, CHUNK_SIZE, createTerrain, type Biome, type Terrain } from '@skeleton/shared';

export interface ChunkRequest {
  seed: number;
  cx: number;
  cz: number;
}

export interface ChunkData {
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

self.onmessage = (e: MessageEvent<ChunkRequest>) => {
  const { seed, cx, cz } = e.data;
  if (!terrain || terrain.seed !== seed) terrain = createTerrain(seed);
  const t = terrain;

  const n = CHUNK_SEGMENTS + 1;
  const step = CHUNK_SIZE / CHUNK_SEGMENTS;
  const ox = cx * CHUNK_SIZE;
  const oz = cz * CHUNK_SIZE;
  const positions = new Float32Array(n * n * 3);
  const normals = new Float32Array(n * n * 3);
  const colors = new Float32Array(n * n * 3);
  const uvs = new Float32Array(n * n * 2);

  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const lx = i * step;
      const lz = j * step;
      const wx = ox + lx;
      const wz = oz + lz;
      const h = t.heightAt(wx, wz);
      const k = (j * n + i) * 3;
      positions[k] = lx;
      positions[k + 1] = h;
      positions[k + 2] = lz;

      const uv = (j * n + i) * 2;
      uvs[uv] = wx / TEXTURE_TILE;
      uvs[uv + 1] = wz / TEXTURE_TILE;

      // Normals from the height function, not from the mesh: no seams between chunks.
      const nx = t.heightAt(wx - step, wz) - t.heightAt(wx + step, wz);
      const nz = t.heightAt(wx, wz - step) - t.heightAt(wx, wz + step);
      const ny = 2 * step;
      const len = Math.hypot(nx, ny, nz);
      normals[k] = nx / len;
      normals[k + 1] = ny / len;
      normals[k + 2] = nz / len;

      const slope = 1 - ny / len;
      const biome = t.biomeAt(wx, wz);
      let c: [number, number, number] = PALETTE[biome];
      if (h > 62) c = PALETTE.snow;
      else if (slope > 0.25 && biome !== 'ocean') c = PALETTE.rock;
      else if (biome === 'meadows') {
        // Broad light and dark patches: the far field reads as a meadow even without near grass.
        const patch = Math.sin(wx * 0.045) * Math.cos(wz * 0.038);
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

  const data: ChunkData = { cx, cz, positions, normals, colors, uvs, trees };
  self.postMessage(data, [positions.buffer, normals.buffer, colors.buffer, uvs.buffer, trees.buffer]);
};
