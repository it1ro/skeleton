import { DEFAULT_SEED, TICK_DT, TICK_RATE, createTerrain, moveMode, spawnState, type Skeleton } from '@skeleton/shared';
import { connectLocal, connectServer, type Connection } from './net/connection.ts';
import { createView } from './render/renderer.ts';
import { Environment } from './render/environment.ts';
import { ChunkManager } from './world/chunks.ts';
import { GrassField } from './world/grass.ts';
import { Avatar, RemotePlayers, preloadAvatars } from './world/avatars.ts';
import { Input } from './player/input.ts';
import { OrbitCamera } from './player/camera.ts';
import { LocalPlayer } from './player/local.ts';
import { PovituhaFigure } from './npc/figure.ts';
import { TalkPanel } from './npc/panel.ts';
import { createBench } from './bench/bench.ts';
import { startTelemetry } from './telemetry/telemetry.ts';

const canvas = document.getElementById('view') as HTMLCanvasElement;
const menu = document.getElementById('menu')!;
const form = document.getElementById('join') as HTMLFormElement;
const nameInput = document.getElementById('name') as HTMLInputElement;
const status = document.getElementById('status')!;
const hud = document.getElementById('hud')!;

const NAME_KEY = 'skeleton.name';
const FIGURE_KEY = 'skeleton.figure';
// Single player by default. `?online` joins the co-op server, `?seed=42` picks the single player world.
const params = new URLSearchParams(location.search);
const online = params.has('online');
const seedParam = Number(params.get('seed') ?? Number.NaN);
const localSeed = Number.isFinite(seedParam) ? seedParam : DEFAULT_SEED;

// `?bench` starts the game without the menu and measures a fixed camera path. See `scripts/bench-aio.ts`.
const benchParam = params.get('bench');
const benchRun = params.has('benchRun');
const benchSceneParam = params.get('benchScene');
const benchSeconds = benchParam && Number.isFinite(Number(benchParam)) ? Number(benchParam) : 10;
const bench =
  benchParam === null
    ? null
    : createBench({
        seconds: benchSeconds,
        name: params.get('benchName') ?? (benchRun ? 'run' : 'spawn'),
        run: benchRun,
        scene: benchSceneParam === 'water' || benchSceneParam === 'sky' ? benchSceneParam : 'spawn',
      });

declare global {
  interface Window {
    /** Console handle for the gray→color hook: `__vision(0)` grays the world, `__vision(1)` restores it. */
    __vision?: (vision: number) => number;
    /** Console handle for the water quality axis: `__water(0)` dead/murky, `__water(1)` live/clear. */
    __water?: (quality: number) => number;
    /** Console handle for the shadow axis: `__shadow(0)` cheapest map, `__shadow(1)` the reference look. */
    __shadow?: (quality: number) => number;
  }
}
try {
  nameInput.value = localStorage.getItem(NAME_KEY) ?? '';
} catch {
  // Storage blocked: start with an empty name.
}

/** The figure picked in the menu: saved next to the name and sent to the simulation on join. */
const figureButtons = [...document.querySelectorAll<HTMLButtonElement>('#figure [data-skeleton]')];
let figure: Skeleton = 'm';
try {
  figure = localStorage.getItem(FIGURE_KEY) === 'f' ? 'f' : 'm';
} catch {
  // Storage blocked: the male skeleton.
}

function showFigure(): void {
  for (const button of figureButtons) {
    const selected = button.dataset.skeleton === figure;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-pressed', String(selected));
  }
}

for (const button of figureButtons) {
  button.addEventListener('click', () => {
    figure = button.dataset.skeleton === 'f' ? 'f' : 'm';
    showFigure();
  });
}
showFigure();

/** Chunks around the spawn, in each direction, built before the game shows: no holes under the feet at start. */
const START_CHUNKS = 2;

// The character loads while the player types a name, so the game usually starts at once.
const avatarsLoaded = preloadAvatars();

const input = new Input(canvas);
let started = false;
/** The menu stays up while the world loads, even with the pointer locked. */
let loaded = false;
/** The talk panel is open: the menu must stay hidden even though the pointer is unlocked. */
let dialogueOpen = false;

function syncMenu(): void {
  menu.classList.toggle('hidden', ((input.locked || dialogueOpen) && loaded) || bench !== null);
}

document.addEventListener('pointerlockchange', syncMenu);

if (bench) {
  menu.classList.add('hidden');
  started = true;
  status.textContent = 'Загрузка мира…';
  start('Bench', figure).catch((err: unknown) => {
    started = false;
    status.textContent = err instanceof Error ? err.message : String(err);
    menu.classList.remove('hidden');
  });
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  input.lock();
  if (started) return;
  started = true;
  const name = nameInput.value.trim();
  try {
    localStorage.setItem(NAME_KEY, name);
    localStorage.setItem(FIGURE_KEY, figure);
  } catch {
    // Not critical.
  }
  status.textContent = 'Загрузка мира…';
  start(name, figure).catch((err: unknown) => {
    started = false;
    status.textContent = err instanceof Error ? err.message : String(err);
    document.exitPointerLock();
  });
});

async function start(name: string, skeleton: Skeleton): Promise<void> {
  const conn: Connection = online ? await connectServer(name, skeleton) : connectLocal(name, localSeed, skeleton);
  const { id: selfId, seed } = conn.welcome;
  const terrain = createTerrain(seed);
  const view = await createView(canvas);
  const { renderer, scene, camera } = view;
  if (params.get('pixels') === '0') view.togglePixels();

  const env = new Environment(scene);
  view.setOutputNode(env.outputNode);
  // `?vision=0` opens the game in the gray start; `__vision(1)` in the console brings the color back.
  const visionParam = Number(params.get('vision'));
  if (params.has('vision') && Number.isFinite(visionParam)) env.visionState = visionParam;
  window.__vision = (vision: number) => {
    env.visionState = vision;
    return env.visionState;
  };
  // `?water=0.5` tunes the water quality axis (dead→live); `__water(q)` does it live in the console.
  const waterParam = Number(params.get('water'));
  if (params.has('water') && Number.isFinite(waterParam)) env.waterQuality = waterParam;
  window.__water = (quality: number) => {
    env.waterQuality = quality;
    return env.waterQuality;
  };
  // `?shadow=0.5` sets the shadow quality axis (0 — cheapest 512² over ±40 m, 1 — 2048² over ±70 m); `__shadow(q)` live.
  const shadowParam = Number(params.get('shadow'));
  if (params.has('shadow') && Number.isFinite(shadowParam)) env.shadowQuality = shadowParam;
  const chunks = new ChunkManager(seed);
  // Trees outside the light's box cannot cast into it, so the chunk manager keeps them out of the shadow pass.
  chunks.setShadowDistance(env.shadowCoverage);
  window.__shadow = (quality: number) => {
    env.shadowQuality = quality;
    chunks.setShadowDistance(env.shadowCoverage);
    return env.shadowQuality;
  };
  const grass = new GrassField(terrain, seed, chunks);
  const remotes = new RemotePlayers(terrain);
  const local = new LocalPlayer(terrain, spawnState(terrain));
  const orbit = new OrbitCamera(camera, terrain);
  chunks.update(local.state.x, local.state.z);
  await Promise.all([avatarsLoaded, chunks.whenReady(START_CHUNKS)]);
  const me = new Avatar(name || 'Я', 0xd9a441, skeleton);
  scene.add(chunks.root, remotes.root, me.root, grass.root);
  grass.update(local.state.x, local.state.z, true);
  if (bench) bench.attach({ view, chunks, orbit, terrain, seed });
  const telemetry = bench ? null : startTelemetry({ seed, backend: view.backend, pixelRatio: renderer.getPixelRatio() });
  const povituha = new PovituhaFigure(terrain, scene, 3.4, -4.6);
  const talk = new TalkPanel({
    llm: params.get('npc') === 'llm',
    onClose: () => {
      dialogueOpen = false;
      input.lock();
      syncMenu();
    },
  });
  const talkPrompt = document.createElement('div');
  talkPrompt.id = 'talk-prompt';
  talkPrompt.textContent = 'E — говорить';
  talkPrompt.className = 'hidden';
  document.body.append(talkPrompt);

  loaded = true;
  status.textContent = '';
  nameInput.hidden = true;
  form.querySelector('button[type="submit"]')!.textContent = 'Продолжить';
  syncMenu();

  let snapTick = conn.welcome.tick;
  let snapTime = performance.now();
  let last = performance.now();
  let accumulator = 0;
  let prevPos = { x: local.state.x, y: local.state.y, z: local.state.z };
  let frames = 0;
  let fps = 0;
  let hudTime = 0;

  renderer.setAnimationLoop(() => {
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;

    for (const msg of conn.drain()) {
      if (msg.t === 'snapshot') {
        snapTick = msg.tick;
        snapTime = now;
        const self = msg.players.find((p) => p.id === selfId);
        if (self) local.reconcile({ ...self, vy: msg.vy, grounded: msg.grounded }, msg.ack);
        remotes.push(msg.tick, msg.players, selfId);
      } else if (msg.t === 'leave') {
        remotes.remove(msg.id);
      }
    }
    const serverTick = snapTick + ((now - snapTime) / 1000) * TICK_RATE;

    if (input.consume('KeyP')) view.togglePixels();
    const autoRun = bench?.autoRun ?? false;
    const moveYaw = autoRun ? (bench?.yaw ?? orbit.yaw) : orbit.yaw;
    accumulator += dt;
    while (accumulator >= TICK_DT) {
      accumulator -= TICK_DT;
      local.step({
        forward: autoRun ? 1 : input.axis('KeyS', 'KeyW'),
        right: autoRun ? 0 : input.axis('KeyA', 'KeyD'),
        yaw: moveYaw,
        jump: autoRun ? false : input.down('Space'),
        sprint: autoRun || input.down('ShiftLeft') || input.down('ShiftRight'),
      });
    }
    const outbox = local.takeOutbox();
    if (outbox.length) conn.send({ t: 'input', inputs: outbox });

    const pos = local.renderPosition(accumulator / TICK_DT, dt);
    me.place(pos.x, pos.y, pos.z, pos.x - prevPos.x, pos.z - prevPos.z, local.speed, moveMode(pos.x, pos.y, pos.z, terrain), dt);
    prevPos = pos;

    const near = povituha.distanceTo(pos.x, pos.z) < 3.6;
    talkPrompt.classList.toggle('hidden', !near || talk.isOpen);
    if (near && !talk.isOpen && input.consume('KeyE')) {
      dialogueOpen = true;
      document.exitPointerLock();
      syncMenu();
      talk.open();
    }

    orbit.update(input, pos.x, pos.y, pos.z);
    bench?.placeCamera(pos);
    chunks.update(pos.x, pos.z);
    grass.update(pos.x, pos.z);
    env.update(serverTick, pos.x, pos.y, pos.z);
    remotes.update(serverTick, dt, camera, window.innerWidth, window.innerHeight);
    me.updateLabel(camera, window.innerWidth, window.innerHeight);
    povituha.updateLabel(camera, window.innerWidth, window.innerHeight);

    const renderStart = performance.now();
    view.render(scene, camera);
    const renderMs = performance.now() - renderStart;
    bench?.update(now, dt, {
      renderMs,
      calls: renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
      casters: chunks.shadowCasters,
    });
    input.endFrame();

    if (telemetry) {
      telemetry.setScene({
        chunks: chunks.loaded,
        grassTiles: grass.tileCount,
        grassPending: grass.pendingCount,
        chunkQueue: chunks.queueCount,
        calls: renderer.info.render.calls,
        triangles: renderer.info.render.triangles,
        x: pos.x,
        z: pos.z,
        biome: terrain.biomeAt(pos.x, pos.z),
        speed: local.speed,
      });
      telemetry.frame(now, dt);
    }

    frames++;
    hudTime += dt;
    if (hudTime >= 0.5) {
      fps = Math.round(frames / hudTime);
      frames = 0;
      hudTime = 0;
      hud.textContent = [
        `${fps} fps · ${view.backend}${conn.open ? '' : ' · НЕТ СВЯЗИ'}`,
        `онлайн: ${remotes.count + 1} · ${env.clock}`,
        `x ${pos.x.toFixed(0)} y ${pos.y.toFixed(1)} z ${pos.z.toFixed(0)} · ${terrain.biomeAt(pos.x, pos.z)}`,
        `чанки: ${chunks.loaded} · seed ${seed}`,
      ].join('\n');
    }
  });
}
