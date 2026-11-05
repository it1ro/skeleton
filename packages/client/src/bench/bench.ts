import type { Terrain } from '@skeleton/shared';
import type { OrbitCamera } from '../player/camera.ts';
import type { View } from '../render/renderer.ts';
import type { ChunkManager } from '../world/chunks.ts';
import { frameStats, type FrameStats } from './stats.ts';

/** A fixed camera turning slowly around the spawn: the same view on every machine and every run. */
export interface BenchOptions {
  seconds?: number;
  name?: string;
  warmupMs?: number;
  /** Chunks in each direction that must be built before the measurement starts. */
  chunksReady?: number;
}

export interface BenchResult extends FrameStats {
  name: string;
  seed: number;
  backend: string;
  gpu: string;
  width: number;
  height: number;
  pixelRatio: number;
  chunks: number;
  timestamp: string;
}

export interface BenchScene {
  view: View;
  chunks: ChunkManager;
  orbit: OrbitCamera;
  terrain: Terrain;
  seed: number;
}

declare global {
  interface Window {
    __bench?: BenchResult;
  }
}

const ORBIT_START = Math.PI / 4;
/** Radians per millisecond: a full turn in about 50 seconds, slow enough not to hide popping. */
const ORBIT_SPEED = 0.00013;
const ORBIT_DISTANCE = 9;

export function createBench(options: BenchOptions = {}) {
  const seconds = Math.max(1, options.seconds ?? 10);
  const name = options.name ?? 'spawn';
  const warmupMs = options.warmupMs ?? 2000;
  const chunksReady = options.chunksReady ?? 4;

  let scene: BenchScene | null = null;
  let phase: 'idle' | 'waiting' | 'warmup' | 'measuring' | 'done' = 'idle';
  let readyAt = 0;
  let measureAt = 0;
  let lastNow = 0;
  const times: number[] = [];

  function gpuName(): string {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    if (!gl) return 'no webgl';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'unknown';
  }

  function finish(): void {
    phase = 'done';
    const view = scene!.view;
    const result: BenchResult = {
      name,
      seed: scene!.seed,
      backend: view.backend,
      gpu: gpuName(),
      width: window.innerWidth,
      height: window.innerHeight,
      pixelRatio: view.renderer.getPixelRatio(),
      chunks: scene!.chunks.loaded,
      timestamp: new Date().toISOString(),
      ...frameStats(times),
    };
    window.__bench = result;
    document.title = `BENCH ${result.fps.toFixed(1)} fps · ${name}`;

    const old = document.getElementById('bench-result');
    const line = [
      `${result.fps.toFixed(1)} fps · p50 ${result.p50.toFixed(1)} ms · p95 ${result.p95.toFixed(1)} ms`,
      `${result.frames} frames · ${result.width}×${result.height} @${result.pixelRatio} · ${result.chunks} chunks`,
    ].join('\n');
    if (old) old.textContent = line;
    else {
      const el = document.createElement('pre');
      el.id = 'bench-result';
      el.textContent = line;
      document.body.append(el);
    }
    console.info('[bench]', result);
  }

  return {
    attach(next: BenchScene): void {
      scene = next;
      phase = 'waiting';
      next.chunks.whenReady(chunksReady).then(() => {
        next.orbit.distance = ORBIT_DISTANCE;
        next.orbit.pitch = -0.16;
        next.orbit.yaw = ORBIT_START;
        readyAt = performance.now();
        phase = 'warmup';
      });
    },

    /** Called every frame after the camera update and before the render. */
    update(now: number, _dt: number): void {
      if (phase === 'idle' || phase === 'waiting' || phase === 'done' || !scene) return;
      if (phase === 'measuring' && lastNow > 0) times.push(now - lastNow);
      lastNow = now;

      // The camera takes this yaw on the next frame; one frame of lag does not matter for a benchmark.
      scene.orbit.yaw = ORBIT_START + (now - readyAt) * ORBIT_SPEED;
      scene.orbit.pitch = -0.16;

      if (phase === 'warmup' && now - readyAt >= warmupMs) {
        phase = 'measuring';
        measureAt = now;
        lastNow = 0;
        times.length = 0;
      } else if (phase === 'measuring' && now - measureAt >= seconds * 1000) {
        finish();
      }
    },
  };
}
