import { createReadStream, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { extname, join, normalize, resolve, sep } from 'node:path';
import os from 'node:os';
import pg from 'pg';

const { Pool } = pg;

const PORT = Number(process.env.PORT ?? 18010);
const DIST = resolve(process.env.DIST ?? '/app/dist');
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://skeleton:skeleton@db:5432/skeleton';
const NVIDIA_SMI = process.env.NVIDIA_SMI ?? '/usr/bin/nvidia-smi';
const COMMIT = process.env.COMMIT ?? '';
const HOST_SAMPLE_MS = Number(process.env.HOST_SAMPLE_MS ?? 1000);
const MAX_BODY = 2 * 1024 * 1024;

const pool = new Pool({ connectionString: DATABASE_URL, max: 4 });

const MIME = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.glb', 'model/gltf-binary'],
  ['.gltf', 'model/gltf+json'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
  ['.svg', 'image/svg+xml'],
  ['.ico', 'image/x-icon'],
  ['.map', 'application/json; charset=utf-8'],
]);

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((ok, fail) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        fail(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => ok(Buffer.concat(chunks).toString('utf8')));
    req.on('error', fail);
  });
}

async function serveStatic(req, res, url) {
  const pathname = decodeURIComponent(url.pathname);
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = resolve(DIST, normalize(relative));
  if (file !== DIST && !file.startsWith(DIST + sep)) {
    json(res, 403, { error: 'forbidden' });
    return;
  }
  if (!existsSync(file)) {
    json(res, 404, { error: 'not found' });
    return;
  }
  const info = await stat(file);
  if (!info.isFile()) {
    json(res, 404, { error: 'not found' });
    return;
  }
  const isIndex = file === join(DIST, 'index.html');
  res.writeHead(200, {
    'content-type': MIME.get(extname(file)) ?? 'application/octet-stream',
    'content-length': info.size,
    'cache-control': isIndex ? 'no-store' : 'public, max-age=31536000, immutable',
  });
  createReadStream(file).pipe(res);
}

const SESSION_SQL = `
INSERT INTO sessions (id, kind, started_at, ended_at, seed, commit, backend, gpu, width, height, pixel_ratio, user_agent)
VALUES ($1, $2, COALESCE($3::timestamptz, now()), $4, $5, $6, $7, $8, $9, $10, $11, $12)
ON CONFLICT (id) DO UPDATE SET
  ended_at = COALESCE(EXCLUDED.ended_at, sessions.ended_at),
  commit = COALESCE(EXCLUDED.commit, sessions.commit)`;

const SAMPLE_SQL = `
INSERT INTO samples (session_id, ts, fps, p50, p95, p99, max, frames, hitches, chunks, grass_tiles,
                     grass_pending, chunk_queue, calls, triangles, heap_mb, x, z, biome, speed)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`;

const EVENT_SQL = `
INSERT INTO events (session_id, ts, kind, ms, data)
VALUES ($1,$2,$3,$4,$5::jsonb)`;

function number(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

async function ingest(payload) {
  const session = payload?.session;
  if (!session?.id) throw new Error('session.id is required');

  await pool.query(SESSION_SQL, [
    String(session.id),
    String(session.kind ?? 'play'),
    session.startedAt ?? null,
    session.endedAt ?? null,
    number(session.seed),
    session.commit ?? COMMIT ?? null,
    session.backend ?? null,
    session.gpu ?? null,
    number(session.width),
    number(session.height),
    number(session.pixelRatio),
    session.userAgent ?? null,
  ]);

  const samples = Array.isArray(payload.samples) ? payload.samples.slice(0, 600) : [];
  for (const s of samples) {
    if (!s?.ts) continue;
    await pool.query(SAMPLE_SQL, [
      String(session.id),
      s.ts,
      number(s.fps),
      number(s.p50),
      number(s.p95),
      number(s.p99),
      number(s.max),
      number(s.frames),
      number(s.hitches),
      number(s.chunks),
      number(s.grassTiles),
      number(s.grassPending),
      number(s.chunkQueue),
      number(s.calls),
      number(s.triangles),
      number(s.heapMb),
      number(s.x),
      number(s.z),
      s.biome ?? null,
      number(s.speed),
    ]);
  }

  const events = Array.isArray(payload.events) ? payload.events.slice(0, 200) : [];
  for (const e of events) {
    if (!e?.ts || !e?.kind) continue;
    await pool.query(EVENT_SQL, [
      String(session.id),
      e.ts,
      String(e.kind).slice(0, 80),
      number(e.ms),
      JSON.stringify(e.data ?? {}),
    ]);
  }

  return { samples: samples.length, events: events.length };
}

function readGpu() {
  return new Promise((ok) => {
    if (!existsSync(NVIDIA_SMI)) {
      ok(null);
      return;
    }
    execFile(
      NVIDIA_SMI,
      ['--query-gpu=utilization.gpu,memory.used,temperature.gpu', '--format=csv,noheader,nounits'],
      { timeout: 800 },
      (error, stdout) => {
        if (error || !stdout) {
          ok(null);
          return;
        }
        const [util, mem, temp] = stdout.trim().split('\n')[0].split(',').map((v) => Number(v.trim()));
        ok({ util, mem, temp });
      },
    );
  });
}

async function sampleHost() {
  const gpu = readGpu();
  const load = os.loadavg()[0];
  const memUsed = Math.round((os.totalmem() - os.freemem()) / 1024 / 1024);
  const sample = await gpu;
  await pool.query(
    `INSERT INTO host_samples (ts, gpu_util, gpu_mem_mb, gpu_temp, cpu_load, mem_used_mb)
     VALUES (now(), $1, $2, $3, $4, $5)`,
    [sample?.util ?? null, sample?.mem ?? null, sample?.temp ?? null, load, memUsed],
  );
}

async function handle(req, res) {
  const url = new URL(req.url ?? '/', 'http://localhost');

  if (req.method === 'GET' && url.pathname === '/health') {
    const db = await pool.query('SELECT 1 AS ok').then(() => true).catch(() => false);
    json(res, db ? 200 : 503, { ok: db, commit: COMMIT, dist: existsSync(join(DIST, 'index.html')) });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/sessions') {
    const rows = await pool.query(
      `SELECT id, kind, started_at, ended_at, seed, commit, backend, gpu, samples, fps, p95, max, hitches
       FROM session_summary ORDER BY started_at DESC LIMIT 50`,
    );
    json(res, 200, rows.rows);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/ingest') {
    const body = await readBody(req);
    const payload = body ? JSON.parse(body) : {};
    const counts = await ingest(payload);
    json(res, 200, { ok: true, ...counts });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/ingest/bench') {
    const body = await readBody(req);
    const run = body ? JSON.parse(body) : {};
    await pool.query(
      `INSERT INTO bench_runs (name, scene, commit, fps, p50, p95, max, chunks, result)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
      [
        run.name ?? null,
        run.scene ?? null,
        run.commit ?? null,
        number(run.fps),
        number(run.p50),
        number(run.p95),
        number(run.max),
        number(run.chunks),
        JSON.stringify(run),
      ],
    );
    json(res, 200, { ok: true });
    return;
  }

  if (req.method === 'GET') {
    await serveStatic(req, res, url);
    return;
  }

  json(res, 405, { error: 'method not allowed' });
}

const server = createServer((req, res) => {
  handle(req, res).catch((error) => {
    json(res, 400, { error: error instanceof Error ? error.message : String(error) });
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`collector listening on :${PORT}, dist=${DIST}, commit=${COMMIT || 'unknown'}`);
});

const hostTimer = setInterval(() => {
  sampleHost().catch((error) => console.error('host sample failed:', error.message));
}, HOST_SAMPLE_MS);
hostTimer.unref();

async function shutdown() {
  clearInterval(hostTimer);
  await pool.end().catch(() => {});
  server.close(() => process.exit(0));
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
