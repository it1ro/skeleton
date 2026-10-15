import { SNAPSHOT_EVERY, TICK_DT, TICK_RATE } from './constants.ts';
import { spawnState, stepPlayer, type PlayerInput, type PlayerState } from './movement.ts';
import type { ClientMessage, PlayerSnapshot, ServerMessage } from './protocol.ts';
import { createTerrain } from './terrain.ts';

/** Inputs applied per player per tick. Above 1 absorbs network jitter, the cap blocks speed hacks. */
const MAX_INPUTS_PER_TICK = 3;
const MAX_QUEUED_INPUTS = TICK_RATE;
const MAX_NAME = 24;
/** Ticks the loop may run at once to catch up after a stall (sleep, background tab). */
const MAX_CATCH_UP = TICK_RATE;

/** One player's link to the simulation, whatever carries the messages: a WebSocket or a direct call. */
export interface SimClient {
  receive(msg: ClientMessage): void;
  leave(): void;
}

/**
 * The authoritative game: players, their inputs and movement, snapshots. It knows nothing about the network,
 * so the same code runs in the browser for single player and on the server for co-op.
 */
export interface Sim {
  readonly seed: number;
  /** Adds a player. `send` gets every message for this player, starting with `welcome` after `hello`. */
  connect(send: (msg: ServerMessage) => void): SimClient;
  /** One fixed step of TICK_DT. */
  step(): void;
}

interface Player {
  id: number;
  send: (msg: ServerMessage) => void;
  name: string;
  color: number;
  state: PlayerState;
  inputs: PlayerInput[];
  ack: number;
  speed: number;
  joined: boolean;
}

export function createSim(seed: number, log: (line: string) => void = () => {}): Sim {
  const terrain = createTerrain(seed);
  const players = new Map<number, Player>();
  let nextId = 1;
  let tick = 0;

  function broadcast(msg: ServerMessage): void {
    for (const p of players.values()) if (p.joined) p.send(msg);
  }

  function connect(send: (msg: ServerMessage) => void): SimClient {
    const id = nextId++;
    const player: Player = {
      id,
      send,
      name: `Viking ${id}`,
      color: Math.floor(Math.random() * 0xffffff),
      state: spawnState(terrain),
      inputs: [],
      ack: 0,
      speed: 0,
      joined: false,
    };
    players.set(id, player);

    return {
      receive(msg) {
        switch (msg.t) {
          case 'hello':
            if (player.joined) return;
            player.joined = true;
            if (typeof msg.name === 'string' && msg.name.trim()) player.name = msg.name.trim().slice(0, MAX_NAME);
            send({ t: 'welcome', id, seed, tick });
            log(`+ ${player.name} (#${id}), online: ${players.size}`);
            break;
          case 'input':
            if (!player.joined || !Array.isArray(msg.inputs)) return;
            for (const input of msg.inputs) {
              if (typeof input?.seq === 'number' && input.seq > player.ack) player.inputs.push(input);
            }
            if (player.inputs.length > MAX_QUEUED_INPUTS) player.inputs.splice(0, player.inputs.length - MAX_QUEUED_INPUTS);
            break;
        }
      },
      leave() {
        if (!players.delete(id)) return;
        broadcast({ t: 'leave', id });
        if (player.joined) log(`- ${player.name} (#${id}), online: ${players.size}`);
      },
    };
  }

  function step(): void {
    tick++;
    for (const p of players.values()) {
      const before = { x: p.state.x, z: p.state.z };
      const batch = p.inputs.splice(0, MAX_INPUTS_PER_TICK);
      for (const input of batch) {
        stepPlayer(p.state, input, TICK_DT, terrain);
        p.ack = input.seq;
      }
      const moved = Math.hypot(p.state.x - before.x, p.state.z - before.z);
      p.speed = batch.length ? moved / (batch.length * TICK_DT) : 0;
    }

    if (tick % SNAPSHOT_EVERY !== 0) return;
    const snapshot: PlayerSnapshot[] = [];
    for (const p of players.values()) {
      if (!p.joined) continue;
      const { x, y, z, yaw } = p.state;
      snapshot.push({ id: p.id, name: p.name, color: p.color, x, y, z, yaw, speed: p.speed });
    }
    for (const p of players.values()) {
      if (!p.joined) continue;
      p.send({ t: 'snapshot', tick, ack: p.ack, vy: p.state.vy, grounded: p.state.grounded, players: snapshot });
    }
  }

  return { seed, connect, step };
}

/**
 * Calls `step` TICK_RATE times per second of real time. A bare setInterval drifts, and the clock of the day
 * runs on ticks; the accumulator keeps the count to real time. Returns a function that stops the loop.
 */
export function runTicks(step: () => void): () => void {
  const ms = 1000 / TICK_RATE;
  let last = performance.now();
  let accumulator = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    accumulator = Math.min(accumulator + now - last, ms * MAX_CATCH_UP);
    last = now;
    while (accumulator >= ms) {
      accumulator -= ms;
      step();
    }
  }, ms / 2);
  return () => clearInterval(timer);
}
