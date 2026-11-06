/**
 * The one wind of the world. Trees read it as a whole: one direction, one clock, one strength axis, so
 * the forest moves as one weather instead of a thousand independent pendulums.
 *
 * The clock is a plain uniform, not the renderer's `time`, so a frame can be frozen: `?windt=2.2` puts
 * the wind at that second and holds it, which is how the bench photographs a pose and compares it with
 * another. Without the freeze two screenshots always catch different phases and cannot prove anything.
 */

import { Vector2 } from 'three/webgpu';
import { uniform } from 'three/tsl';

/** Prevailing wind, blowing toward the south-east: the direction every tree leans. */
export const WIND_DIRECTION = new Vector2(0.93, 0.36).normalize();

/** Sway at the crown as a share of the tree's own height. Conifers in a steady wind: ~2.5%. */
export const TREE_SWAY = 0.025;

/** 0..1. The debug axis: `?wind=0` plants the forest, `?wind=1` is the reference wind. */
export const WIND_STRENGTH = uniform(1);

/** Seconds of wind. `?windt=` freezes it so two frames show the same pose. */
export const WIND_CLOCK = uniform(0);

let frozen = false;

/** Ticks the wind clock; `dt` is clamped like the game loop, so a tab that wakes up does not jump. */
export function updateWind(dt: number): void {
  if (frozen) return;
  WIND_CLOCK.value += Math.min(dt, 0.1);
}

/** Sets the strength axis, returns the value actually stored. */
export function setWindStrength(value: number): number {
  const clamped = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 1;
  WIND_STRENGTH.value = clamped;
  return clamped;
}

/** Freezes the wind at `seconds`; `null` resumes it. Returns the clock. */
export function setWindTime(seconds: number | null): number {
  if (seconds === null || !Number.isFinite(seconds)) {
    frozen = false;
    return WIND_CLOCK.value;
  }
  frozen = true;
  WIND_CLOCK.value = Math.max(0, seconds);
  return WIND_CLOCK.value;
}
