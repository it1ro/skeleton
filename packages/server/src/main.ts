import { WebSocketServer, type WebSocket } from 'ws';
import {
  SERVER_PORT,
  SNAPSHOT_EVERY,
  TICK_DT,
  TICK_RATE,
  createTerrain,
  decode,
  encode,
  spawnState,
  stepPlayer,
  type ClientMessage,
  type PlayerInput,
  type PlayerSnapshot,
  type PlayerState,
  type ServerMessage,
} from '@skeleton/shared';

/** Inputs applied per player per tick. Above 1 absorbs network jitter, the cap blocks speed hacks. */
const MAX_INPUTS_PER_TICK = 3;
const MAX_QUEUED_INPUTS = TICK_RATE;
const MAX_NAME = 24;

interface Client {
  id: number;
  socket: WebSocket;
  name: string;
  color: number;
  state: PlayerState;
  inputs: PlayerInput[];
  ack: number;
  speed: number;
  joined: boolean;
}

const seed = Number(process.env.SEED ?? 1337);
const port = Number(process.env.PORT ?? SERVER_PORT);
const terrain = createTerrain(seed);
const clients = new Map<number, Client>();
let nextId = 1;
let tick = 0;

const wss = new WebSocketServer({ port, path: '/ws' });

wss.on('connection', (socket) => {
  const id = nextId++;
  const client: Client = {
    id,
    socket,
    name: `Viking ${id}`,
    color: Math.floor(Math.random() * 0xffffff),
    state: spawnState(terrain),
    inputs: [],
    ack: 0,
    speed: 0,
    joined: false,
  };
  clients.set(id, client);

  socket.on('message', (raw) => {
    const msg = decode<ClientMessage>(raw.toString());
    if (!msg) return;
    switch (msg.t) {
      case 'hello':
        if (client.joined) return;
        client.joined = true;
        if (typeof msg.name === 'string' && msg.name.trim()) client.name = msg.name.trim().slice(0, MAX_NAME);
        send(client, { t: 'welcome', id, seed, tick });
        console.log(`+ ${client.name} (#${id}), online: ${clients.size}`);
        break;
      case 'input':
        if (!client.joined || !Array.isArray(msg.inputs)) return;
        for (const input of msg.inputs) {
          if (typeof input?.seq === 'number' && input.seq > client.ack) client.inputs.push(input);
        }
        if (client.inputs.length > MAX_QUEUED_INPUTS) client.inputs.splice(0, client.inputs.length - MAX_QUEUED_INPUTS);
        break;
    }
  });

  socket.on('close', () => {
    clients.delete(id);
    broadcast({ t: 'leave', id });
    if (client.joined) console.log(`- ${client.name} (#${id}), online: ${clients.size}`);
  });
});

function send(client: Client, msg: ServerMessage): void {
  if (client.socket.readyState === client.socket.OPEN) client.socket.send(encode(msg));
}

function broadcast(msg: ServerMessage): void {
  for (const client of clients.values()) if (client.joined) send(client, msg);
}

function update(): void {
  tick++;
  for (const client of clients.values()) {
    const before = { x: client.state.x, z: client.state.z };
    const batch = client.inputs.splice(0, MAX_INPUTS_PER_TICK);
    for (const input of batch) {
      stepPlayer(client.state, input, TICK_DT, terrain);
      client.ack = input.seq;
    }
    const moved = Math.hypot(client.state.x - before.x, client.state.z - before.z);
    client.speed = batch.length ? moved / (batch.length * TICK_DT) : 0;
  }

  if (tick % SNAPSHOT_EVERY !== 0) return;
  const players: PlayerSnapshot[] = [];
  for (const c of clients.values()) {
    if (!c.joined) continue;
    const { x, y, z, yaw } = c.state;
    players.push({ id: c.id, name: c.name, color: c.color, x, y, z, yaw, speed: c.speed });
  }
  for (const client of clients.values()) {
    if (!client.joined) continue;
    send(client, {
      t: 'snapshot',
      tick,
      ack: client.ack,
      vy: client.state.vy,
      grounded: client.state.grounded,
      players,
    });
  }
}

setInterval(update, 1000 / TICK_RATE);
console.log(`Server: ws://localhost:${port}/ws, seed ${seed}, ${TICK_RATE} Hz`);
