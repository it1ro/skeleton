import { describe, expect, it } from 'vitest';
import { createTerrain, type PropSpot } from '../src/index.ts';

/** Collects every prop in the chunks covering the Погост (radius 140 m) plus a chunk of margin. */
function allProps(seed: number): PropSpot[] {
  const terrain = createTerrain(seed);
  const props: PropSpot[] = [];
  for (let cx = -4; cx <= 4; cx++) {
    for (let cz = -4; cz <= 4; cz++) {
      props.push(...terrain.propsInChunk(cx, cz));
    }
  }
  return props;
}

const POGOST = 140;

describe('propsInChunk', () => {
  it('is deterministic and emits each prop exactly once across chunks', () => {
    const a = allProps(42);
    const b = allProps(42);
    expect(a.length).toBe(b.length);
    expect(a.length).toBeGreaterThan(0);
    expect(a).toEqual(b);

    const keys = new Set(a.map((p) => `${p.kind}:${p.x.toFixed(3)},${p.z.toFixed(3)}`));
    expect(keys.size).toBe(a.length);
  });

  it('keeps mounds and bones inside the Погост and mounds on meadows', () => {
    const terrain = createTerrain(42);
    const props = allProps(42);
    for (const p of props) {
      if (p.kind === 'cross') continue; // crosses may spill a few meters past an edge mound
      expect(p.x * p.x + p.z * p.z).toBeLessThanOrEqual(POGOST * POGOST);
      if (p.kind === 'mound') {
        expect(terrain.biomeAt(p.x, p.z)).toBe('meadows');
      }
    }
  });

  it('ties every cross to a mound nearby', () => {
    const props = allProps(42);
    const mounds = props.filter((p) => p.kind === 'mound');
    const crosses = props.filter((p) => p.kind === 'cross');
    expect(mounds.length).toBeGreaterThan(0);
    expect(crosses.length).toBeGreaterThan(0);
    for (const c of crosses) {
      const near = mounds.some((m) => Math.hypot(m.x - c.x, m.z - c.z) < 8);
      expect(near).toBe(true);
    }
  });

  it('populates the Погост with all three kinds', () => {
    const props = allProps(1337);
    const kinds = new Set(props.map((p) => p.kind));
    expect(kinds).toEqual(new Set(['mound', 'cross', 'bone']));
    for (const kind of ['mound', 'cross', 'bone'] as const) {
      expect(props.filter((p) => p.kind === kind).length).toBeGreaterThan(0);
    }
  });
});
