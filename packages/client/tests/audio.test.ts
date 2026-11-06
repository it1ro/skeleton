import { describe, expect, it } from 'vitest';
import {
  AUDIO_KEY,
  DEFAULT_LEVELS,
  clampLevel,
  loadLevels,
  mergeLevels,
  parseLevels,
  saveLevels,
  volumeOf,
} from '../src/audio/levels.ts';

function storage(initial: Record<string, string> = {}): Storage {
  const data = new Map(Object.entries(initial));
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key: string) => data.get(key) ?? null,
    key: (index: number) => [...data.keys()][index] ?? null,
    removeItem: (key: string) => {
      data.delete(key);
    },
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  } as Storage;
}

describe('clampLevel', () => {
  it('keeps a level inside [0, 1]', () => {
    expect(clampLevel(0)).toBe(0);
    expect(clampLevel(0.45)).toBe(0.45);
    expect(clampLevel(1)).toBe(1);
    expect(clampLevel(-3)).toBe(0);
    expect(clampLevel(4)).toBe(1);
  });

  it('rejects everything that is not a finite number', () => {
    expect(clampLevel(Number.NaN)).toBeUndefined();
    expect(clampLevel(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(clampLevel('0.5')).toBeUndefined();
    expect(clampLevel(null)).toBeUndefined();
    expect(clampLevel(undefined)).toBeUndefined();
  });
});

describe('parseLevels', () => {
  it('falls back to defaults without saved data', () => {
    expect(parseLevels(null)).toEqual(DEFAULT_LEVELS);
  });

  it('survives broken and foreign JSON', () => {
    expect(parseLevels('{')).toEqual(DEFAULT_LEVELS);
    expect(parseLevels('null')).toEqual(DEFAULT_LEVELS);
    expect(parseLevels('[1, 2]')).toEqual(DEFAULT_LEVELS);
    expect(parseLevels('{"nope": true}')).toEqual(DEFAULT_LEVELS);
  });

  it('reads the known keys and ignores the rest', () => {
    const levels = parseLevels('{"master": 0.5, "world": 0.25, "alien": 9, "head": "loud"}');
    expect(levels.master).toBe(0.5);
    expect(levels.world).toBe(0.25);
    expect(levels.head).toBe(DEFAULT_LEVELS.head);
    expect(levels.score).toBe(DEFAULT_LEVELS.score);
  });

  it('clamps saved levels instead of trusting them', () => {
    const levels = parseLevels('{"master": 2, "world": -1, "head": 0.3}');
    expect(levels.master).toBe(1);
    expect(levels.world).toBe(0);
    expect(levels.head).toBe(0.3);
  });

  it('keeps a saved mute', () => {
    expect(parseLevels('{"muted": true}').muted).toBe(true);
    expect(parseLevels('{"muted": "yes"}').muted).toBe(false);
  });
});

describe('mergeLevels', () => {
  it('does not mutate the base', () => {
    const base = { ...DEFAULT_LEVELS };
    const next = mergeLevels(base, { score: 0.1 });
    expect(next.score).toBe(0.1);
    expect(base.score).toBe(DEFAULT_LEVELS.score);
  });

  it('keeps the old value for an invalid patch', () => {
    const next = mergeLevels(DEFAULT_LEVELS, { world: 'quiet' });
    expect(next.world).toBe(DEFAULT_LEVELS.world);
  });
});

describe('volumeOf', () => {
  it('silences every bus while muted', () => {
    const levels = { ...DEFAULT_LEVELS, muted: true };
    expect(volumeOf(levels, 'score')).toBe(0);
    expect(volumeOf(levels, 'world')).toBe(0);
    expect(volumeOf(levels, 'head')).toBe(0);
  });

  it('returns the bus level otherwise', () => {
    expect(volumeOf(DEFAULT_LEVELS, 'head')).toBe(DEFAULT_LEVELS.head);
  });
});

describe('storage', () => {
  it('round-trips the levels', () => {
    const store = storage();
    saveLevels({ ...DEFAULT_LEVELS, world: 0.33 }, store);
    expect(loadLevels(store).world).toBe(0.33);
    expect(JSON.parse(store.getItem(AUDIO_KEY) ?? '{}').world).toBe(0.33);
  });

  it('treats a blocked storage as missing, not as an error', () => {
    const blocked = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    } as unknown as Storage;
    expect(loadLevels(blocked)).toEqual(DEFAULT_LEVELS);
    expect(() => saveLevels(DEFAULT_LEVELS, blocked)).not.toThrow();
  });
});
