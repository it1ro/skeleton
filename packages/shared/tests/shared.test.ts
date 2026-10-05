import { describe, expect, it } from 'vitest';
import {
  TICK_DT,
  WATER_LEVEL,
  createTerrain,
  spawnState,
  stepPlayer,
  type PlayerInput,
} from '../src/index.ts';

const input = (seq: number, patch: Partial<PlayerInput> = {}): PlayerInput => ({
  seq,
  forward: 0,
  right: 0,
  yaw: 0,
  jump: false,
  sprint: false,
  ...patch,
});

describe('terrain', () => {
  it('is the same for the same seed', () => {
    const a = createTerrain(42);
    const b = createTerrain(42);
    for (let i = 0; i < 100; i++) {
      const x = i * 37.3 - 1800;
      const z = i * -21.7 + 900;
      expect(a.heightAt(x, z)).toBe(b.heightAt(x, z));
    }
    expect(a.treesInChunk(3, -2)).toEqual(b.treesInChunk(3, -2));
  });

  it('differs between seeds', () => {
    expect(createTerrain(1).heightAt(500, 500)).not.toBe(createTerrain(2).heightAt(500, 500));
  });

  it('puts the spawn in low meadows or forest for many seeds', () => {
    for (let seed = 1; seed <= 50; seed++) {
      const t = createTerrain(seed);
      expect(t.heightAt(0, 0)).toBeGreaterThan(WATER_LEVEL + 1);
      expect(['meadows', 'forest']).toContain(t.biomeAt(0, 0));
    }
  });
});

describe('movement', () => {
  const terrain = createTerrain(1337);

  it('replays to the same state from the same inputs', () => {
    const inputs = Array.from({ length: 300 }, (_, i) =>
      input(i + 1, { forward: 1, right: Math.sin(i / 20), yaw: i / 50, jump: i % 45 === 0, sprint: i > 150 }),
    );
    const a = spawnState(terrain);
    const b = spawnState(terrain);
    for (const inp of inputs) stepPlayer(a, inp, TICK_DT, terrain);
    for (const inp of inputs) stepPlayer(b, inp, TICK_DT, terrain);
    expect(a).toEqual(b);
  });

  it('walks at walk speed and stays on the ground', () => {
    const s = spawnState(terrain);
    for (let i = 1; i <= 30; i++) stepPlayer(s, input(i, { forward: 1 }), TICK_DT, terrain);
    expect(s.y).toBeCloseTo(Math.max(terrain.heightAt(s.x, s.z), WATER_LEVEL - 1.3), 5);
    expect(Math.hypot(s.x, s.z)).toBeLessThanOrEqual(5 + 1e-9);
  });

  it('jumps and lands', () => {
    const s = spawnState(terrain);
    stepPlayer(s, input(1, { jump: true }), TICK_DT, terrain);
    expect(s.grounded).toBe(false);
    for (let i = 2; i < 60; i++) stepPlayer(s, input(i), TICK_DT, terrain);
    expect(s.grounded).toBe(true);
  });

  it('ignores out-of-range input', () => {
    const s = spawnState(terrain);
    stepPlayer(s, input(1, { forward: 1e9, right: Number.NaN }), TICK_DT, terrain);
    expect(Math.hypot(s.x, s.z)).toBeLessThanOrEqual(5 * TICK_DT + 1e-9);
  });
});
