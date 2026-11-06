import { WATER_LEVEL, type Terrain } from '@skeleton/shared';
import type { OrbitCamera } from '../player/camera.ts';
import type { View } from '../render/renderer.ts';
import type { ChunkManager } from '../world/chunks.ts';
import { frameStats, type FrameStats } from './stats.ts';
import { takeHitches, type Hitch } from './hitches.ts';

/** Where the fixed camera looks: the spawn meadow, a nearby tree, open water, or up at the sky. */
export type BenchSceneKind = 'spawn' | 'trees' | 'water' | 'sky';

export interface BenchOptions {
  seconds?: number;
  name?: string;
  warmupMs?: number;
  /** Chunks in each direction that must be built before the measurement starts. */
  chunksReady?: number;
  /** Run forward instead of standing still: exercises chunk and grass streaming while measuring. */
  run?: boolean;
  /** Camera target; `run` is ignored for `water` and `sky` (the player stands still). */
  scene?: BenchSceneKind;
}

/** Per-frame metrics captured in main.ts right after `renderer.render`. */
export interface BenchFrame {
  /** `renderer.render` duration in ms: the main-thread cost of submitting the frame. */
  renderMs: number;
  calls: number;
  triangles: number;
  /** Tree instances drawn into the shadow map: the near trees only, not every loaded tree. */
  casters: number;
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
  scene: BenchSceneKind;
  run: boolean;
  /** Main-thread work before `renderer.render` (sim, streaming, camera, env), p50/p95 in ms. */
  cpuP50: number;
  cpuP95: number;
  /** `renderer.render` submission time, p50/p95 in ms. */
  renderP50: number;
  renderP95: number;
  /** Draw calls and triangles of the last measured frame. */
  calls: number;
  triangles: number;
  /** Tree instances the shadow pass drew in the last measured frame. */
  casters: number;
  /** Main-thread builds at or above 8 ms during the measured window. */
  hitches: Hitch[];
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
const ORBIT_PITCH = -0.16;
const ORBIT_DISTANCE = 9;

/** Closest tree to the spawn: the `trees` scene frames a birch if one is near, else whatever stands. */
function findTree(terrain: Terrain): { x: number; y: number; z: number } | null {
  let best: { x: number; y: number; z: number } | null = null;
  let bestScore = Infinity;
  for (let cx = -2; cx <= 2; cx++) {
    for (let cz = -2; cz <= 2; cz++) {
      for (const spot of terrain.treesInChunk(cx, cz)) {
        const distance = Math.hypot(spot.x, spot.z);
        if (distance < 10) continue;
        const score = distance + (spot.kind === 'birch' ? 0 : 12);
        if (score < bestScore) {
          bestScore = score;
          best = { x: spot.x, y: spot.y, z: spot.z };
        }
      }
    }
  }
  return best;
}

/** First open-ocean cell along +x: the island is finite, so this always finds water. */
function findOcean(terrain: Terrain): { x: number; z: number } {
  for (let d = 64; d < 8192; d += 16) {
    if (terrain.heightAt(d, 0) < WATER_LEVEL - 0.5) return { x: d, z: 0 };
  }
  return { x: 512, z: 0 };
}

export function createBench(options: BenchOptions = {}) {
  const seconds = Math.max(1, options.seconds ?? 10);
  const name = options.name ?? 'spawn';
  const warmupMs = options.warmupMs ?? 2000;
  const chunksReady = options.chunksReady ?? 4;
  const run = options.run ?? false;
  const scene: BenchSceneKind = options.scene ?? 'spawn';

  let target: BenchScene | null = null;
  let phase: 'idle' | 'waiting' | 'warmup' | 'measuring' | 'done' = 'idle';
  let readyAt = 0;
  let measureAt = 0;
  let lastNow = 0;
  let calls = 0;
  let triangles = 0;
  let casters = 0;
  let ocean: { x: number; z: number } | null = null;
  let tree: { x: number; y: number; z: number } | null = null;
  let treeSearched = false;
  const times: number[] = [];
  const cpuTimes: number[] = [];
  const renderTimes: number[] = [];

  function gpuName(): string {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    if (!gl) return 'no webgl';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'unknown';
  }

  function finish(): void {
    phase = 'done';
    const view = target!.view;
    const cpu = frameStats(cpuTimes);
    const render = frameStats(renderTimes);
    const result: BenchResult = {
      name,
      seed: target!.seed,
      backend: view.backend,
      gpu: gpuName(),
      width: window.innerWidth,
      height: window.innerHeight,
      pixelRatio: view.renderer.getPixelRatio(),
      chunks: target!.chunks.loaded,
      scene,
      run,
      cpuP50: cpu.p50,
      cpuP95: cpu.p95,
      renderP50: render.p50,
      renderP95: render.p95,
      calls,
      triangles,
      casters,
      hitches: takeHitches(),
      timestamp: new Date().toISOString(),
      ...frameStats(times),
    };
    window.__bench = result;
    document.title = `BENCH ${result.fps.toFixed(1)} fps · ${name}`;

    const line = [
      `${result.fps.toFixed(1)} fps · p50 ${result.p50.toFixed(1)} ms · p95 ${result.p95.toFixed(1)} ms`,
      `cpu p95 ${result.cpuP95.toFixed(1)} ms · render p95 ${result.renderP95.toFixed(1)} ms`,
      `${result.frames} frames · ${result.width}×${result.height} @${result.pixelRatio} · ${result.chunks} chunks`,
      `calls ${result.calls} · triangles ${result.triangles} · casters ${result.casters} · ${scene}${run ? ' (run)' : ''}`,
    ].join('\n');
    const old = document.getElementById('bench-result');
    if (old) old.textContent = line;
    else {
      const el = document.createElement('pre');
      el.id = 'bench-result';
      el.textContent = line;
      document.body.append(el);
    }
    console.info('[bench]', result);
  }

  /** Positions the camera for the current frame for `water` and `sky`; `spawn` goes through the orbit. */
  function placeCameraImpl(pos: { x: number; y: number; z: number }): void {
    if (!target || scene === 'spawn') return;
    if (scene === 'trees') {
      if (!treeSearched) {
        tree = findTree(target.terrain);
        treeSearched = true;
      }
      if (!tree) return;
      const cam = target.view.camera;
      const side = 13;
      const distance = Math.hypot(tree.x, tree.z) || 1;
      // Stand on the far side, looking back toward the spawn: the reference sun rises behind that view,
      // so the tree is front-lit instead of a silhouette.
      const bx = (tree.x / distance) * side;
      const bz = (tree.z / distance) * side;
      cam.position.set(tree.x + bx + side * 0.4, tree.y + 3.2, tree.z + bz - side * 0.4);
      cam.lookAt(tree.x, tree.y + 4.4, tree.z);
      return;
    }
    if (scene === 'sky') {
      const cam = target.view.camera;
      cam.position.set(pos.x, pos.y + 1.6, pos.z);
      cam.lookAt(pos.x, pos.y + 500, pos.z);
      return;
    }
    if (!ocean) ocean = findOcean(target.terrain);
    const cam = target.view.camera;
    cam.position.set(ocean.x, WATER_LEVEL + 1.2, ocean.z);
    cam.lookAt(ocean.x + 200, WATER_LEVEL, ocean.z);
  }

  return {
    get running(): boolean {
      return phase === 'warmup' || phase === 'measuring';
    },

    /** The player runs only in run mode; water/sky and idle stand still. */
    get autoRun(): boolean {
      return (phase === 'warmup' || phase === 'measuring') && run;
    },

    /** Direction the player runs in run mode; the camera stays behind it. */
    get yaw(): number {
      return ORBIT_START;
    },

    attach(next: BenchScene): void {
      target = next;
      phase = 'waiting';
      next.chunks.whenReady(chunksReady).then(() => {
        next.orbit.distance = ORBIT_DISTANCE;
        next.orbit.pitch = ORBIT_PITCH;
        next.orbit.yaw = ORBIT_START;
        readyAt = performance.now();
        phase = 'warmup';
      });
    },

    /** Positions the camera for the current frame; call before `renderer.render`. */
    placeCamera(pos: { x: number; y: number; z: number }): void {
      placeCameraImpl(pos);
    },

    /** Called every frame after the render, with the frame's render cost and draw stats. */
    update(now: number, _dt: number, frame: BenchFrame): void {
      if (phase === 'idle' || phase === 'waiting' || phase === 'done' || !target) return;
      if (phase === 'measuring' && lastNow > 0) {
        const total = now - lastNow;
        times.push(total);
        renderTimes.push(frame.renderMs);
        cpuTimes.push(Math.max(0, total - frame.renderMs));
        calls = frame.calls;
        triangles = frame.triangles;
        casters = frame.casters;
      }
      lastNow = now;

      // `spawn`/`run`: the orbit takes these on the next frame (one frame of lag is fine for a benchmark).
      if (scene === 'spawn') {
        target.orbit.yaw = ORBIT_START;
        target.orbit.pitch = ORBIT_PITCH;
      }

      if (phase === 'warmup' && now - readyAt >= warmupMs) {
        phase = 'measuring';
        measureAt = now;
        lastNow = 0;
        times.length = 0;
        cpuTimes.length = 0;
        renderTimes.length = 0;
        // The warm-up covers the initial loads; measure only the moving window.
        takeHitches();
      } else if (phase === 'measuring' && now - measureAt >= seconds * 1000) {
        finish();
      }
    },
  };
}
