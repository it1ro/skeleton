import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SNAPSHOT_EVERY,
  TICK_RATE,
  createSim,
  runTicks,
  type PlayerInput,
  type ServerMessage,
} from '../src/index.ts';

const forward = (seq: number): PlayerInput => ({ seq, forward: 1, right: 0, yaw: 0, jump: false, sprint: false });

function join(sim: ReturnType<typeof createSim>, name: string) {
  const inbox: ServerMessage[] = [];
  const client = sim.connect((msg) => inbox.push(msg));
  client.receive({ t: 'hello', name });
  return { client, inbox };
}

describe('sim', () => {
  it('welcomes a player with the world seed', () => {
    const { inbox } = join(createSim(42), 'Ivan');
    expect(inbox).toEqual([{ t: 'welcome', id: 1, seed: 42, tick: 0 }]);
  });

  it('applies inputs and acknowledges them in snapshots', () => {
    const sim = createSim(1337);
    const { client, inbox } = join(sim, 'Ivan');
    client.receive({ t: 'input', inputs: [forward(1), forward(2)] });
    for (let i = 0; i < SNAPSHOT_EVERY; i++) sim.step();

    const snapshot = inbox.at(-1);
    expect(snapshot?.t).toBe('snapshot');
    if (snapshot?.t !== 'snapshot') return;
    expect(snapshot.ack).toBe(2);
    expect(snapshot.players).toHaveLength(1);
    expect(snapshot.players[0]).toMatchObject({ id: 1, name: 'Ivan' });
    expect(snapshot.players[0].z).toBeLessThan(0);
  });

  it('tells the others when a player leaves', () => {
    const sim = createSim(1337);
    const a = join(sim, 'A');
    const b = join(sim, 'B');
    b.client.leave();
    b.client.leave();
    expect(a.inbox.filter((m) => m.t === 'leave')).toEqual([{ t: 'leave', id: 2 }]);
    sim.step();
    sim.step();
    const snapshot = a.inbox.at(-1);
    expect(snapshot?.t === 'snapshot' && snapshot.players.map((p) => p.id)).toEqual([1]);
  });
});

describe('runTicks', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('keeps to real time and caps the catch-up after a stall', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    /** Real time passes, then the interval fires once. */
    const wait = (ms: number) => {
      now += ms;
      vi.advanceTimersToNextTimer();
    };
    let ticks = 0;
    const stop = runTicks(() => ticks++);

    for (let i = 0; i < 100; i++) wait(10);
    expect(ticks).toBeGreaterThanOrEqual(TICK_RATE - 1);
    expect(ticks).toBeLessThanOrEqual(TICK_RATE);

    // A stall, like a sleeping laptop: one late callback runs at most one second of ticks.
    ticks = 0;
    wait(10_000);
    expect(ticks).toBeGreaterThanOrEqual(TICK_RATE - 1);
    expect(ticks).toBeLessThanOrEqual(TICK_RATE + 1);

    stop();
    ticks = 0;
    wait(1000);
    expect(ticks).toBe(0);
  });
});
