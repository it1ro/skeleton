import { DEFAULT_SEED, TICK_DT, TICK_RATE, createTerrain, moveMode, spawnState } from '@skeleton/shared';
import { connectLocal, connectServer, type Connection } from './net/connection.ts';
import { createView } from './render/renderer.ts';
import { Environment } from './render/environment.ts';
import { ChunkManager } from './world/chunks.ts';
import { Avatar, RemotePlayers } from './world/avatars.ts';
import { Input } from './player/input.ts';
import { OrbitCamera } from './player/camera.ts';
import { LocalPlayer } from './player/local.ts';

const canvas = document.getElementById('view') as HTMLCanvasElement;
const menu = document.getElementById('menu')!;
const form = document.getElementById('join') as HTMLFormElement;
const nameInput = document.getElementById('name') as HTMLInputElement;
const status = document.getElementById('status')!;
const hud = document.getElementById('hud')!;

const NAME_KEY = 'skeleton.name';
// Single player by default. `?online` joins the co-op server, `?seed=42` picks the single player world.
const params = new URLSearchParams(location.search);
const online = params.has('online');
const seedParam = Number(params.get('seed') ?? Number.NaN);
const localSeed = Number.isFinite(seedParam) ? seedParam : DEFAULT_SEED;
try {
  nameInput.value = localStorage.getItem(NAME_KEY) ?? '';
} catch {
  // Storage blocked: start with an empty name.
}

const input = new Input(canvas);
let started = false;

document.addEventListener('pointerlockchange', () => menu.classList.toggle('hidden', input.locked));

form.addEventListener('submit', (e) => {
  e.preventDefault();
  input.lock();
  if (started) return;
  started = true;
  const name = nameInput.value.trim();
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    // Not critical.
  }
  status.textContent = 'Подключение…';
  start(name).catch((err: unknown) => {
    started = false;
    status.textContent = err instanceof Error ? err.message : String(err);
    document.exitPointerLock();
  });
});

async function start(name: string): Promise<void> {
  const conn: Connection = online ? await connectServer(name) : connectLocal(name, localSeed);
  const { id: selfId, seed } = conn.welcome;
  const terrain = createTerrain(seed);
  const view = await createView(canvas);
  const { renderer, scene, camera } = view;
  status.textContent = '';
  nameInput.hidden = true;
  form.querySelector('button')!.textContent = 'Продолжить';

  const env = new Environment(scene);
  const chunks = new ChunkManager(seed);
  const remotes = new RemotePlayers(terrain);
  const local = new LocalPlayer(terrain, spawnState(terrain));
  const me = new Avatar(name || 'Я', 0xd9a441);
  const orbit = new OrbitCamera(camera, terrain);
  scene.add(chunks.root, remotes.root, me.root);

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
    accumulator += dt;
    while (accumulator >= TICK_DT) {
      accumulator -= TICK_DT;
      local.step({
        forward: input.axis('KeyS', 'KeyW'),
        right: input.axis('KeyA', 'KeyD'),
        yaw: orbit.yaw,
        jump: input.down('Space'),
        sprint: input.down('ShiftLeft') || input.down('ShiftRight'),
      });
    }
    const outbox = local.takeOutbox();
    if (outbox.length) conn.send({ t: 'input', inputs: outbox });

    const pos = local.renderPosition(accumulator / TICK_DT, dt);
    me.place(pos.x, pos.y, pos.z, pos.x - prevPos.x, pos.z - prevPos.z, local.speed, moveMode(pos.x, pos.y, pos.z, terrain), dt);
    prevPos = pos;
    orbit.update(input, pos.x, pos.y, pos.z);
    chunks.update(pos.x, pos.z);
    env.update(serverTick, pos.x, pos.y, pos.z);
    remotes.update(serverTick, dt, camera, window.innerWidth, window.innerHeight);
    me.updateLabel(camera, window.innerWidth, window.innerHeight);

    renderer.render(scene, camera);
    input.endFrame();

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
