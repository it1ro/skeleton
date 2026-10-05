import { describe, expect, it } from 'vitest';
import { TICK_DT, createTerrain, spawnState, stepPlayer } from '@skeleton/shared';
import { LocalPlayer } from '../src/player/local.ts';

const terrain = createTerrain(1337);
const intent = (i: number) => ({ forward: 1, right: 0, yaw: i / 30, jump: i % 25 === 0, sprint: i > 20 });

describe('LocalPlayer prediction', () => {
  it('matches the server after a delayed ack, with no visible correction', () => {
    const local = new LocalPlayer(terrain, spawnState(terrain));
    for (let i = 1; i <= 40; i++) local.step(intent(i));
    const sent = local.takeOutbox();
    expect(sent).toHaveLength(40);

    // The server has applied only the first 25 inputs so far.
    const server = spawnState(terrain);
    for (const input of sent.slice(0, 25)) stepPlayer(server, input, TICK_DT, terrain);

    const predicted = { ...local.state };
    local.reconcile(server, 25);
    expect(local.state).toEqual(predicted);
    expect(local.renderPosition(1, 0)).toEqual({ x: predicted.x, y: predicted.y, z: predicted.z });
  });

  it('accepts a server correction and fades it out on screen', () => {
    const local = new LocalPlayer(terrain, spawnState(terrain));
    for (let i = 1; i <= 10; i++) local.step(intent(i));
    const sent = local.takeOutbox();
    const server = spawnState(terrain);
    for (const input of sent) stepPlayer(server, input, TICK_DT, terrain);
    const drawnBefore = local.renderPosition(1, 0);

    server.x += 1; // The server disagrees, e.g. the player was pushed.
    local.reconcile(server, 10);
    expect(local.state.x).toBeCloseTo(server.x, 9);
    // No jump on screen right after the correction...
    expect(local.renderPosition(1, 0).x).toBeCloseTo(drawnBefore.x, 9);
    // ...and the drawn position reaches the server state soon after.
    expect(local.renderPosition(1, 1).x).toBeCloseTo(server.x, 2);
  });
});
