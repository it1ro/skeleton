import { DEFAULT_SEED, TICK_DT, TICK_RATE, createTerrain, moveMode, spawnState, type Skeleton, type Terrain } from '@skeleton/shared';
import { connectLocal, connectServer, type Connection } from './net/connection.ts';
import { createView } from './render/renderer.ts';
import { Environment } from './render/environment.ts';
import { createNit } from './render/nit.ts';
import { ChunkManager, MOUND_RADIUS } from './world/chunks.ts';
import { GrassField } from './world/grass.ts';
import { Avatar, RemotePlayers, preloadAvatars } from './world/avatars.ts';
import { preload } from './assets/models.ts';
import { Input } from './player/input.ts';
import { OrbitCamera } from './player/camera.ts';
import { LocalPlayer } from './player/local.ts';
import { PovituhaFigure } from './npc/figure.ts';
import { Neodobudka } from './npc/neodobudka.ts';
import { TalkPanel } from './npc/panel.ts';
import { createBench } from './bench/bench.ts';
import { loadWaterField } from './render/water-field-source.ts';
import { startTelemetry, type TelemetryAudio } from './telemetry/telemetry.ts';
import { Mixer, type AudioDebug, type LevelsPatch } from './audio/mixer.ts';
import { startWind } from './audio/wind.ts';
import { Music, type MusicDebug } from './audio/music.ts';
import {
  BANYA_ENTER,
  GuardScene,
  MusicZones,
  cycleTrackAt,
  isMusicTrack,
  parseMusicMode,
  pickTrack,
  type MusicMode,
  type MusicTrack,
} from './audio/selection.ts';
import type { AudioLevels } from './audio/levels.ts';

const canvas = document.getElementById('view') as HTMLCanvasElement;
const menu = document.getElementById('menu')!;
const form = document.getElementById('join') as HTMLFormElement;
const nameInput = document.getElementById('name') as HTMLInputElement;
const status = document.getElementById('status')!;
const hud = document.getElementById('hud')!;

/** The nearest grave mound to the spawn: the landmark the first frame looks at. */
function nearestMound(terrain: Terrain): { x: number; y: number; z: number; scale: number } {
  let best = { x: 12, y: terrain.heightAt(12, 0), z: 0, scale: 1 };
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let cx = -3; cx <= 3; cx++) {
    for (let cz = -3; cz <= 3; cz++) {
      for (const prop of terrain.propsInChunk(cx, cz)) {
        if (prop.kind !== 'mound') continue;
        const d = prop.x * prop.x + prop.z * prop.z;
        if (d < bestDistance) {
          bestDistance = d;
          best = { x: prop.x, y: prop.y, z: prop.z, scale: prop.scale };
        }
      }
    }
  }
  return best;
}

/**
 * Недобудка sits at the foot of the barrow, on the spawn side and facing the spawn: the thread of the first frame
 * leads to her, and the grave stays behind her back. The mound instance is much wider than its unit geometry
 * (`MOUND_RADIUS`), so the raw scale would bury her inside the hill.
 */
function guardSpot(mound: { x: number; z: number; scale: number }): { x: number; z: number } {
  const length = Math.hypot(mound.x, mound.z) || 1;
  const distance = MOUND_RADIUS * mound.scale + 1.2;
  return { x: mound.x - (mound.x / length) * distance, z: mound.z - (mound.z / length) * distance };
}

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
        scene:
          benchSceneParam === 'trees' ||
          benchSceneParam === 'water' ||
          benchSceneParam === 'shore' ||
          benchSceneParam === 'surf' ||
          benchSceneParam === 'edge' ||
          benchSceneParam === 'sky' ||
          benchSceneParam === 'sun'
            ? benchSceneParam
            : 'spawn',
      });

// `?audio=0` disables sound, and the bench never creates it: the reference run measures the frame, not the mix.
const audio = !bench && params.get('audio') !== '0' ? new Mixer() : null;
const music = audio ? new Music(audio) : null;
const eqParam = params.get('eq');
if (eqParam === '0' || eqParam === 'off') music?.setEq(false);
let musicMode: MusicMode = parseMusicMode(params.get('music'));
let musicCycleStart = performance.now();

/** One read of the mix for the telemetry sample; `null` without sound (`?audio=0`, the bench). */
function audioTelemetry(): TelemetryAudio | null {
  if (!audio) return null;
  return { ...audio.pulse(), track: music?.debug().track ?? null };
}

declare global {
  interface Window {
    /** Console handle for the gray→color hook: `__vision(0)` grays the world, `__vision(1)` restores it. */
    __vision?: (vision: number) => number;
    /** Console handle for the water quality axis: `__water(0)` dead/murky, `__water(1)` live/clear. */
    __water?: (quality: number) => number;
    /** Console handle for the shadow axis: `__shadow(0)` cheapest map, `__shadow(1)` the reference look. */
    __shadow?: (quality: number) => number;
    /** Console handle for the mix: `__audio.state()`, `__audio.set({ world: 0 })`, `__audio.mute()`. */
    __audio?: {
      state: () => AudioDebug | null;
      set: (patch: LevelsPatch) => AudioLevels | null;
      mute: (on?: boolean) => AudioLevels | null;
    };
    /** Console handle for the score: `__music.state()`, `__music.play('banya')`, `__music.auto()`, `__music.off()`. */
    __music?: {
      state: () => (MusicDebug & { mode: MusicMode }) | null;
      play: (track: MusicTrack) => MusicTrack | null;
      auto: () => MusicMode;
      cycle: () => MusicMode;
      off: () => MusicMode;
      eq: (on?: boolean) => boolean;
      navь: (depth?: number) => number;
    };
  }
}

window.__audio = {
  state: () => audio?.debug() ?? null,
  set: (patch) => {
    const next = audio?.setLevels(patch) ?? null;
    if (next) showLevels(next);
    return next;
  },
  mute: (on = true) => {
    const next = audio?.setMuted(on) ?? null;
    if (next) showLevels(next);
    return next;
  },
};
window.__music = {
  state: () => (music ? { ...music.debug(), mode: musicMode } : null),
  play: (track) => {
    if (!isMusicTrack(track)) return null;
    musicMode = track;
    music?.setTrack(track, true);
    return track;
  },
  auto: () => {
    musicMode = 'auto';
    return musicMode;
  },
  cycle: () => {
    musicMode = 'cycle';
    musicCycleStart = performance.now();
    return musicMode;
  },
  off: () => {
    musicMode = 'off';
    music?.setTrack(null);
    return musicMode;
  },
  eq: (on = true) => {
    music?.setEq(on);
    const value = music?.debug().eq ?? false;
    showEq(value);
    return value;
  },
  navь: (depth) => {
    if (depth !== undefined) music?.setNavь(depth);
    return music?.debug().navь ?? 0;
  },
};

const LEVEL_KEYS = ['master', 'world', 'head', 'score'] as const;
const soundPanel = document.getElementById('sound') as HTMLFieldSetElement | null;
const levelInputs = Object.fromEntries(
  LEVEL_KEYS.map((key) => [key, document.getElementById(`level-${key}`) as HTMLInputElement]),
) as Record<(typeof LEVEL_KEYS)[number], HTMLInputElement>;
const eqInput = document.getElementById('level-eq') as HTMLInputElement;
const muteInput = document.getElementById('level-mute') as HTMLInputElement;

function showLevels(levels: AudioLevels): void {
  for (const key of LEVEL_KEYS) levelInputs[key].value = String(levels[key]);
  muteInput.checked = levels.muted;
}

function showEq(on: boolean): void {
  eqInput.checked = on;
}

if (!audio) {
  if (soundPanel) soundPanel.hidden = true;
} else {
  showLevels(audio.getLevels());
  showEq(music?.debug().eq ?? true);
  for (const key of LEVEL_KEYS) {
    const input = levelInputs[key];
    input.addEventListener('input', () => {
      audio.setLevels({ [key]: input.valueAsNumber } as LevelsPatch);
    });
  }
  muteInput.addEventListener('change', () => audio.setMuted(muteInput.checked));
  eqInput.addEventListener('change', () => music?.setEq(eqInput.checked));
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

// The characters load while the player types a name, so the game usually starts at once.
const avatarsLoaded = preloadAvatars();
const povituhaLoaded = preload('povituha');
const neodobudkaLoaded = preload('neodobudka');

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
  start('Bench', figure, null).catch((err: unknown) => {
    started = false;
    status.textContent = err instanceof Error ? err.message : String(err);
    menu.classList.remove('hidden');
  });
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  // Browsers only start audio inside a gesture; the Play button is that gesture.
  audio?.unlock();
  music?.unlock();
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
  start(name, figure, audio).catch((err: unknown) => {
    started = false;
    status.textContent = err instanceof Error ? err.message : String(err);
    document.exitPointerLock();
  });
});

async function start(name: string, skeleton: Skeleton, sound: Mixer | null): Promise<void> {
  const conn: Connection = online ? await connectServer(name, skeleton) : connectLocal(name, localSeed, skeleton);
  const { id: selfId, seed } = conn.welcome;
  const terrain = createTerrain(seed);
  const mound = nearestMound(terrain);
  const view = await createView(canvas);
  const { renderer, scene, camera } = view;
  // Full resolution is the default; `?pixels=1` forces the half-resolution pixel look, `?pixels=0` the smooth one.
  const pixelsParam = params.get('pixels');
  if (pixelsParam === '1') view.setPixels(true);
  else if (pixelsParam === '0') view.setPixels(false);

  // The low fog hugs the ground, so it needs the world height field, not eye level.
  const env = new Environment(scene, (x, z) => terrain.heightAt(x, z));
  view.setOutputNode(env.outputNode);
  // `?time=10` (hours, 0..24) starts the shared clock at that hour: screenshots and benches at daylight
  // instead of waiting for the pre-dawn start to roll around.
  const timeParam = Number(params.get('time'));
  if (params.has('time') && Number.isFinite(timeParam)) env.timeOffset = timeParam / 24 - env.timeOfDay;
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
  // `?waterdebug=1` paints the baked depth field instead of the sea: red land, green shallow, blue deep.
  const waterDebug = Number(params.get('waterdebug'));
  if (Number.isFinite(waterDebug) && waterDebug > 0) env.water.debugDepth = waterDebug;
  // The depth field is baked off-thread; until it lands the sea stays deep and flat, the first frame is never blocked.
  void loadWaterField(seed).then((field) => {
    if (field) env.water.setDepthField(field.data);
  });
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
  await Promise.all([avatarsLoaded, povituhaLoaded, neodobudkaLoaded, chunks.whenReady(START_CHUNKS)]);
  const me = new Avatar(name || 'Я', 0xd9a441, skeleton);
  scene.add(chunks.root, remotes.root, me.root, grass.root);
  // The first frame: a cold thread leading the eye from the spawn toward the landmark.
  const nit = createNit(mound.x, mound.z);
  nit.position.set(0, terrain.heightAt(0, 0), 0);
  scene.add(nit);
  grass.update(local.state.x, local.state.z, true);
  if (bench) bench.attach({ view, chunks, orbit, terrain, seed });
  const telemetry = bench
    ? null
    : startTelemetry({ seed, backend: view.backend, pixelRatio: renderer.getPixelRatio(), audio: audioTelemetry });
  // The mix starts on the Play click, before the world: the mixer buffered its failures until now.
  if (sound) sound.issues.setSink(telemetry ? (issue) => telemetry.event('audio', 0, issue) : null);
  const povituha = new PovituhaFigure(terrain, scene, 3.4, -4.6);
  // The sleeping guard at the foot of the barrow the first frame looks at: static, the pose is baked into the mesh.
  const spot = guardSpot(mound);
  new Neodobudka(terrain, scene, spot.x, spot.z);
  const zones = new MusicZones();
  const guardScene = new GuardScene();
  // The single context and the head bus for Повитуха; without sound the panel keeps its own.
  const audioContext = sound?.audioContext ?? null;
  const audioHead = sound?.head ?? null;
  const speechAudio = audioContext && audioHead ? { context: audioContext, output: audioHead } : undefined;
  if (sound) void startWind(sound).catch((error: unknown) => console.warn('wind', error));
  const talk = new TalkPanel({
    llm: params.get('npc') === 'llm',
    audio: speechAudio,
    onClose: () => {
      dialogueOpen = false;
      povituha.setTalking(false);
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
  musicCycleStart = performance.now();
  if (musicMode !== 'off') music?.prefetch(['banya', 'nedobudka', 'nedobudka-wake']);
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
  // The scripted first frame: the camera lies 30 cm above the ground at the spawn, looking at the landmark.
  const INTRO_MS = 4000;
  const introStart = performance.now();

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
    povituha.update(dt);
    povituha.look(pos.x, pos.z, dt);
    prevPos = pos;
    const biome = terrain.biomeAt(pos.x, pos.z);
    // Fog is about the view, not the avatar: from the beach the sea must not drown in meadow fog.
    const viewBiome = terrain.biomeAt(camera.position.x, camera.position.z);
    const guardDistance = Math.hypot(pos.x - spot.x, pos.z - spot.z);
    const banyaDistance = povituha.distanceTo(pos.x, pos.z);
    zones.update(dt, guardDistance, banyaDistance, dialogueOpen);

    const near = banyaDistance < BANYA_ENTER;
    talkPrompt.classList.toggle('hidden', !near || talk.isOpen);
    if (near && !talk.isOpen && input.consume('KeyE')) {
      dialogueOpen = true;
      document.exitPointerLock();
      syncMenu();
      povituha.setTalking(true);
      talk.open();
    }

    if (musicMode !== 'auto') guardScene.reset();
    const guard = musicMode === 'auto' ? guardScene.update(zones.nearGuard, guardDistance) : null;
    if (guard?.wake) music?.playCue('nedobudka-wake', () => guardScene.wakeEnded());
    const musicTrack =
      guard?.silence === true
        ? null
        : (guard?.override ??
          pickTrack(
            musicMode,
            { biome, nearGuard: zones.nearGuard, nearBanya: dialogueOpen || zones.nearBanya },
            musicMode === 'cycle' ? cycleTrackAt((now - musicCycleStart) / 1000) : undefined,
          ));
    music?.setTrack(musicTrack);
    music?.setDucked(dialogueOpen);

    if (!bench && now - introStart < INTRO_MS) {
      // Scripted first frame: camera at 30 cm, looking at the landmark through the low fog.
      const groundY = terrain.heightAt(0, 0);
      camera.position.set(0, groundY + 0.3, 0);
      camera.lookAt(mound.x, mound.y, mound.z);
    } else {
      orbit.update(input, pos.x, pos.y, pos.z);
    }
    bench?.placeCamera(pos, env.body);
    // A bench camera can stand far from the player: stream and snap the world around the view, not the body.
    const focus = bench ? bench.focus : pos;
    chunks.update(focus.x, focus.z);
    grass.update(focus.x, focus.z);
    env.update(serverTick, focus.x, focus.y, focus.z, viewBiome, camera.position);
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
        biome,
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
        `x ${pos.x.toFixed(0)} y ${pos.y.toFixed(1)} z ${pos.z.toFixed(0)} · ${biome}`,
        `чанки: ${chunks.loaded} · seed ${seed}`,
      ].join('\n');
    }
  });
}
