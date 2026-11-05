import { takeHitches } from '../bench/hitches.ts';

declare const __COMMIT__: string;

export interface TelemetryOptions {
  seed: number;
  backend: string;
  pixelRatio: number;
}

/** The latest scene counters, read once per sample. */
export interface TelemetryScene {
  chunks: number;
  grassTiles: number;
  grassPending: number;
  chunkQueue: number;
  calls: number;
  triangles: number;
  x: number;
  z: number;
  biome: string;
  speed: number;
}

interface Sample {
  ts: string;
  fps: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  frames: number;
  hitches: number;
  chunks: number | null;
  grassTiles: number | null;
  grassPending: number | null;
  chunkQueue: number | null;
  calls: number | null;
  triangles: number | null;
  heapMb: number | null;
  x: number | null;
  z: number | null;
  biome: string | null;
  speed: number | null;
}

interface TelemetryEvent {
  ts: string;
  kind: string;
  ms: number;
  data: Record<string, unknown>;
}

const SAMPLE_MS = 1000;
const FLUSH_MS = 5000;

function gpuName(): string {
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
  if (!gl) return 'no webgl';
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'unknown';
}

function heapMb(): number | null {
  const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
  return memory ? Math.round((memory.usedJSHeapSize / 1048576) * 10) / 10 : null;
}

/**
 * Local play telemetry: one sample per second, a POST every five seconds and a beacon on exit.
 * Enabled only with `?telemetry`, so the GitHub Pages demo and the benchmark stay clean.
 */
export function startTelemetry(options: TelemetryOptions) {
  if (!new URLSearchParams(location.search).has('telemetry')) return null;

  const session = {
    id: crypto.randomUUID(),
    kind: 'play',
    seed: options.seed,
    commit: typeof __COMMIT__ === 'string' && __COMMIT__ ? __COMMIT__ : null,
    backend: options.backend,
    gpu: gpuName(),
    width: window.innerWidth,
    height: window.innerHeight,
    pixelRatio: options.pixelRatio,
    userAgent: navigator.userAgent,
    startedAt: new Date().toISOString(),
  };

  let scene: TelemetryScene | null = null;
  const times: number[] = [];
  const samples: Sample[] = [];
  const events: TelemetryEvent[] = [];
  let last = 0;
  let sampleStart = performance.now();
  let batchStart = sampleStart;

  function addEvent(kind: string, ms: number, data: Record<string, unknown>): void {
    events.push({ ts: new Date().toISOString(), kind, ms, data });
  }

  function sample(): void {
    if (times.length === 0) return;
    const sorted = [...times].sort((a, b) => a - b);
    const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)))];
    const mean = times.reduce((sum, value) => sum + value, 0) / times.length;

    const hitches = takeHitches();
    for (const hitch of hitches) {
      addEvent('hitch', hitch.ms, { kind: hitch.kind, x: scene?.x ?? null, z: scene?.z ?? null });
    }

    samples.push({
      ts: new Date().toISOString(),
      fps: mean > 0 ? 1000 / mean : 0,
      p50: at(0.5),
      p95: at(0.95),
      p99: at(0.99),
      max: sorted[sorted.length - 1],
      frames: times.length,
      hitches: hitches.length,
      chunks: scene?.chunks ?? null,
      grassTiles: scene?.grassTiles ?? null,
      grassPending: scene?.grassPending ?? null,
      chunkQueue: scene?.chunkQueue ?? null,
      calls: scene?.calls ?? null,
      triangles: scene?.triangles ?? null,
      heapMb: heapMb(),
      x: scene?.x ?? null,
      z: scene?.z ?? null,
      biome: scene?.biome ?? null,
      speed: scene?.speed ?? null,
    });
    times.length = 0;
  }

  function flush(beacon = false): void {
    if (samples.length === 0 && events.length === 0) return;
    const payload = JSON.stringify({
      session: { ...session, endedAt: beacon ? new Date().toISOString() : null },
      samples: samples.splice(0),
      events: events.splice(0),
    });
    batchStart = performance.now();
    if (beacon && navigator.sendBeacon) {
      navigator.sendBeacon('/ingest', new Blob([payload], { type: 'application/json' }));
      return;
    }
    fetch('/ingest', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
      keepalive: true,
    }).catch(() => {
      // Telemetry is best-effort; the game must not care if the collector is down.
    });
  }

  function frame(now: number, _dt: number): void {
    if (last > 0) times.push(now - last);
    last = now;
    if (now - sampleStart >= SAMPLE_MS) {
      sample();
      sampleStart = now;
    }
    if (now - batchStart >= FLUSH_MS) flush();
  }

  function setScene(next: TelemetryScene): void {
    scene = next;
  }

  window.addEventListener('error', (event) => {
    addEvent('error', 0, { message: event.message, source: event.filename, line: event.lineno });
  });
  window.addEventListener('unhandledrejection', (event) => {
    addEvent('error', 0, { message: String(event.reason) });
  });
  document.getElementById('view')?.addEventListener('webglcontextlost', () => addEvent('contextlost', 0, {}));
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        addEvent('longtask', entry.duration, {
          chunks: scene?.chunks ?? null,
          grassTiles: scene?.grassTiles ?? null,
          grassPending: scene?.grassPending ?? null,
          chunkQueue: scene?.chunkQueue ?? null,
          x: scene?.x ?? null,
          z: scene?.z ?? null,
        });
      }
    }).observe({ type: 'longtask' });
  } catch {
    // Not every browser exposes longtask.
  }
  window.addEventListener('pagehide', () => flush(true));

  return { frame, setScene, event: addEvent, flush };
}
