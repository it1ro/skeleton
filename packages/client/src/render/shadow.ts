/**
 * Shadow quality axis: one number picks the shadow map resolution and how far from the player the light
 * covers. The map is what the GPU pays for every frame: a 2048² depth pass is four times the work of a
 * 1024² one. Coverage is the half-extent of the orthographic light camera; it also bounds which trees
 * need to cast at all (see `world/chunks.ts`).
 *
 * There is no "shadows off" step: in three 0.186 flipping `light.castShadow` at runtime leaves a disposed
 * shadow node in the graph, and its `updateBefore` throws one frame later before the materials rebuild.
 * The regulator only ever changes the map and the box, which is safe to do live.
 */

export interface ShadowSettings {
  /** Shadow map edge in texels, a power of two. */
  mapSize: number;
  /** Half-extent of the shadow camera box, meters. */
  coverage: number;
}

/** From the cheapest usable map to the reference look: quality 1 is the last level. */
export const SHADOW_LEVELS: readonly ShadowSettings[] = [
  { mapSize: 512, coverage: 40 },
  { mapSize: 1024, coverage: 55 },
  { mapSize: 2048, coverage: 70 },
];

/** The reference look (2048 texels over ±70 m); the default when nothing is set. */
export const DEFAULT_SHADOW: ShadowSettings = SHADOW_LEVELS[SHADOW_LEVELS.length - 1];

/**
 * Maps a quality in [0, 1] to a level; a broken value counts as 0, the cheapest map, like `clampVision`.
 * The axis is coarse on purpose: each step halves the map, which is exactly the GPU cost it changes.
 */
export function shadowSettings(quality: number): ShadowSettings {
  const q = Number.isFinite(quality) ? Math.min(1, Math.max(0, quality)) : 0;
  return SHADOW_LEVELS[Math.min(SHADOW_LEVELS.length - 1, Math.floor(q * SHADOW_LEVELS.length))];
}
