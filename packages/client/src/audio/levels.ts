/**
 * Bus levels for the game mix. Pure data: the mixer applies them, the settings screen will
 * edit them, and `__audio` in the console reads them. Kept apart from Web Audio so it is
 * testable in node and survives a failed `AudioContext` (private mode, old browser).
 */

export type AudioBus = 'score' | 'world' | 'head';

export interface AudioLevels {
  master: number;
  /** The score: plays from the first minute and is not touched by the body. ADR-0002. */
  score: number;
  /** The world: everything the body hears through its ears — muffled, spatial, quieter. */
  world: number;
  /** Otherworld voices: in the head, past the ears, never spatial. ADR-0002. */
  head: number;
  muted: boolean;
}

export const AUDIO_KEY = 'skeleton.audio';

export const BUSES: readonly AudioBus[] = ['score', 'world', 'head'];

export const DEFAULT_LEVELS: AudioLevels = {
  master: 0.8,
  score: 0.7,
  world: 0.8,
  head: 0.9,
  muted: false,
};

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    // Storage blocked by the browser: the game plays at defaults.
    return null;
  }
}

/** A level is a number in [0, 1]; anything else is not a level. */
export function clampLevel(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.min(1, Math.max(0, value));
}

/** Reads saved levels, ignoring unknown keys and broken values. */
export function parseLevels(raw: string | null): AudioLevels {
  const levels: AudioLevels = { ...DEFAULT_LEVELS };
  if (!raw) return levels;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return levels;
  }
  if (!data || typeof data !== 'object') return levels;
  return mergeLevels(levels, data as Partial<Record<keyof AudioLevels, unknown>>);
}

/** Applies a partial patch without touching the caller's object. */
export function mergeLevels(
  base: AudioLevels,
  patch: Partial<Record<keyof AudioLevels, unknown>>,
): AudioLevels {
  const next: AudioLevels = { ...base };
  for (const key of ['master', ...BUSES] as const) {
    const value = clampLevel(patch[key]);
    if (value !== undefined) next[key] = value;
  }
  if (typeof patch.muted === 'boolean') next.muted = patch.muted;
  return next;
}

/** The gain a bus actually gets: mute silences everything, not just the world. */
export function volumeOf(levels: AudioLevels, bus: AudioBus): number {
  return levels.muted ? 0 : levels[bus];
}

export function loadLevels(from: Storage | null = storage()): AudioLevels {
  try {
    return parseLevels(from?.getItem(AUDIO_KEY) ?? null);
  } catch {
    return { ...DEFAULT_LEVELS };
  }
}

export function saveLevels(levels: AudioLevels, to: Storage | null = storage()): void {
  try {
    to?.setItem(AUDIO_KEY, JSON.stringify(levels));
  } catch {
    // A full or blocked storage is not a reason to stop the game.
  }
}
