import { describe, expect, it } from 'vitest';
import { DEFAULT_SHADOW, SHADOW_LEVELS, shadowSettings } from '../src/render/shadow.ts';

describe('shadowSettings', () => {
  it('keeps the reference look at quality 1', () => {
    expect(shadowSettings(1)).toEqual({ mapSize: 2048, coverage: 70 });
    expect(DEFAULT_SHADOW).toEqual({ mapSize: 2048, coverage: 70 });
  });

  it('steps the map down as quality falls', () => {
    expect(shadowSettings(0.5)).toEqual({ mapSize: 1024, coverage: 55 });
    expect(shadowSettings(0.1)).toEqual({ mapSize: 512, coverage: 40 });
  });

  it('clamps the ends and treats a broken value as the cheapest map', () => {
    expect(shadowSettings(0)).toEqual({ mapSize: 512, coverage: 40 });
    expect(shadowSettings(-1)).toEqual({ mapSize: 512, coverage: 40 });
    expect(shadowSettings(Number.NaN)).toEqual({ mapSize: 512, coverage: 40 });
    expect(shadowSettings(5)).toEqual({ mapSize: 2048, coverage: 70 });
  });

  it('always returns a level from the list', () => {
    for (const quality of [0, 0.01, 0.33, 0.5, 0.66, 0.99, 1]) {
      expect(SHADOW_LEVELS).toContainEqual(shadowSettings(quality));
    }
  });
});
