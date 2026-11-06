import { describe, expect, it } from 'vitest';
import { bendWeight } from '../src/world/tree-bend.ts';

describe('bendWeight', () => {
  it('plants the root: nothing at or below the base moves', () => {
    expect(bendWeight(0, 9, 1)).toBe(0);
    expect(bendWeight(-0.4, 9, 1)).toBe(0);
  });

  it('reaches the kind stiffness at the top and clamps above it', () => {
    expect(bendWeight(9, 9, 0.85)).toBeCloseTo(0.85, 6);
    expect(bendWeight(12, 9, 0.85)).toBeCloseTo(0.85, 6);
  });

  it('grows with height squared, the shape of a cantilever', () => {
    expect(bendWeight(4.5, 9, 1)).toBeCloseTo(0.25, 6);
    expect(bendWeight(3, 9, 1)).toBeCloseTo(1 / 9, 6);
  });

  it('never decreases with height', () => {
    let previous = 0;
    for (let y = 0; y <= 10; y += 0.5) {
      const current = bendWeight(y, 9, 1);
      expect(current).toBeGreaterThanOrEqual(previous);
      previous = current;
    }
  });

  it('survives a degenerate tree instead of dividing by zero', () => {
    expect(bendWeight(1, 0, 1)).toBe(0);
    expect(bendWeight(1, -2, 1)).toBe(0);
    expect(bendWeight(1, 5, 0)).toBe(0);
  });
});
