/**
 * Offline preview: rasterizes tree geometries with the same flat shading they get in game,
 * so silhouettes and baked vertex colors can be judged without a browser.
 * Usage: tsx /tmp/tree-preview.ts [out.png]
 */
import sharp from 'sharp';
import { createTreeGeometry, TREE_POOLS } from '../packages/client/src/world/trees.ts';

type V3 = [number, number, number];

const W = 1400;
const H = 900;
const SS = 2; // supersampling

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

const light = norm([-0.55, 0.75, 0.6]);
const sky: V3 = [0.42, 0.5, 0.62];
const ambient = 0.22;

function render(geometry: { getAttribute: (n: string) => any }, box: { minX: number; spanX: number; minY: number; spanY: number; cx: number; cy: number; scale: number; w: number; h: number; ox: number; oy: number }): { rgba: Buffer; w: number; h: number } {
  const pos = geometry.getAttribute('position');
  const col = geometry.getAttribute('color');
  const w = box.w * SS;
  const h = box.h * SS;
  const rgba = Buffer.alloc(w * h * 4);
  const zbuf = new Float32Array(w * h).fill(-Infinity);

  // Simple perspective: camera on +Z, looking at -Z. Slight elevation by tilting world.
  const camZ = 14;
  const tilt = 0.1;
  const project = (p: V3) => {
    const y = p[1];
    const yy = y * Math.cos(tilt) - p[2] * Math.sin(tilt);
    const zz = y * Math.sin(tilt) + p[2] * Math.cos(tilt);
    const z = zz + camZ;
    const f = 3.6 / z;
    return [p[0] * f, yy * f, z] as V3;
  };

  const toScreen = (p: V3): [number, number, number] => [
    box.cx + p[0] * box.scale,
    box.cy - p[1] * box.scale,
    p[2],
  ];

  for (let i = 0; i < pos.count; i += 3) {
    const a: V3 = [pos.getX(i), pos.getY(i), pos.getZ(i)];
    const b: V3 = [pos.getX(i + 1), pos.getY(i + 1), pos.getZ(i + 1)];
    const c: V3 = [pos.getX(i + 2), pos.getY(i + 2), pos.getZ(i + 2)];
    const n = norm(cross(sub(b, a), sub(c, a)));
    const ca: V3 = [col.getX(i), col.getY(i), col.getZ(i)];
    const cb: V3 = [col.getX(i + 1), col.getY(i + 1), col.getZ(i + 1)];
    const cc: V3 = [col.getX(i + 2), col.getY(i + 2), col.getZ(i + 2)];

    // Two-sided: crowns are closed, but back faces still read better than holes.
    const nd = Math.abs(dot(n, light));
    const skyK = 0.5 + 0.5 * n[1];
    const shade = ambient + nd * 0.85;
    const tint = (k: number) => [
      (ca[k] * (shade + sky[0] * skyK * 0.25)),
      (cb[k] * (shade + sky[1] * skyK * 0.25)),
      (cc[k] * (shade + sky[2] * skyK * 0.25)),
    ];

    const p0 = toScreen(project(a));
    const p1 = toScreen(project(b));
    const p2 = toScreen(project(c));

    const minX = Math.max(0, Math.floor(Math.min(p0[0], p1[0], p2[0])));
    const maxX = Math.min(w - 1, Math.ceil(Math.max(p0[0], p1[0], p2[0])));
    const minY = Math.max(0, Math.floor(Math.min(p0[1], p1[1], p2[1])));
    const maxY = Math.min(h - 1, Math.ceil(Math.max(p0[1], p1[1], p2[1])));
    const area = (p1[0] - p0[0]) * (p2[1] - p0[1]) - (p2[0] - p0[0]) * (p1[1] - p0[1]);
    if (Math.abs(area) < 1e-6) continue;

    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const px = x + 0.5;
        const py = y + 0.5;
        const w0 = ((p1[0] - px) * (p2[1] - py) - (p2[0] - px) * (p1[1] - py)) / area;
        const w1 = ((p2[0] - px) * (p0[1] - py) - (p0[0] - px) * (p2[1] - py)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const z = w0 * p0[2] + w1 * p1[2] + w2 * p2[2];
        if (z <= zbuf[y * w + x]) continue;
        zbuf[y * w + x] = z;
        const r = w0 * tint(0)[0] + w1 * tint(0)[1] + w2 * tint(0)[2];
        const g = w0 * tint(1)[0] + w1 * tint(1)[1] + w2 * tint(1)[2];
        const bl = w0 * tint(2)[0] + w1 * tint(2)[1] + w2 * tint(2)[2];
        const o = (y * w + x) * 4;
        const gamma = (v: number) => Math.min(255, Math.max(0, Math.round(255 * Math.pow(v, 1 / 2.2))));
        rgba[o] = gamma(r);
        rgba[o + 1] = gamma(g);
        rgba[o + 2] = gamma(bl);
        rgba[o + 3] = 255;
      }
    }
  }
  return { rgba, w, h };
}

async function main() {
  const out = process.argv[2] ?? '/tmp/trees.png';
  const cols = 5;
  const rows = Math.max(1, Math.ceil(TREE_POOLS.length / cols));
  const cellW = W / cols;
  const cellH = H / rows;
  const cells: Buffer[] = [];
  const cellW2 = cellW * SS;
  const cellH2 = cellH * SS;

  // Two rows: near (front) and far (back) each variant.
  for (let row = 0; row < rows; row++) {
    for (let i = 0; i < cols; i++) {
      const pool = TREE_POOLS[row * cols + i];
      if (!pool) {
        cells.push(Buffer.alloc(cellW2 * cellH2 * 4));
        continue;
      }
      const geometry = createTreeGeometry(pool.kind, pool.variant);
      const pos = geometry.getAttribute('position');
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (let v = 0; v < pos.count; v++) {
        minX = Math.min(minX, pos.getX(v));
        maxX = Math.max(maxX, pos.getX(v));
        minY = Math.min(minY, pos.getY(v));
        maxY = Math.max(maxY, pos.getY(v));
      }
      const f = 3.6 / 14;
      const scale = (0.8 * cellH2) / ((maxY - minY) * f);
      const box = {
        w: cellW,
        h: cellH,
        cx: cellW2 / 2 - ((minX + maxX) / 2) * f * scale,
        cy: cellH2 * 0.93,
        scale,
        minX: 0,
        spanX: 0,
        minY: 0,
        spanY: 0,
        ox: 0,
        oy: 0,
      };
      cells.push(render(geometry, box).rgba);
    }
  }

  const full = Buffer.alloc(cellW2 * cols * cellH2 * rows * 4);
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const src = cells[row * cols + col];
      for (let y = 0; y < cellH2; y++) {
        const dstRow = row * cellH2 + y;
        src.copy(full, (dstRow * cellW2 * cols + col * cellW2) * 4, y * cellW2 * 4, (y + 1) * cellW2 * 4);
      }
    }
  }

  const outW = cellW2 * cols;
  const outH = cellH2 * rows;
  const bg: [number, number, number] = [214, 220, 214];
  for (let i = 0; i < outW * outH; i++) {
    const a = full[i * 4 + 3] / 255;
    for (let c = 0; c < 3; c++) {
      full[i * 4 + c] = Math.round(full[i * 4 + c] * a + bg[c] * (1 - a));
    }
    full[i * 4 + 3] = 255;
  }
  await sharp(full, { raw: { width: outW, height: outH, channels: 4 } })
    .resize(W, H, { kernel: 'lanczos3' })
    .png()
    .toFile(out);
  console.log('wrote', out);
}

main();
