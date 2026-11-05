/**
 * The gray-to-color hook: how much of the world's color the player sees.
 *
 * `vision` comes from the game (0 before the eyes, 1 after them) and is applied here, so the sky, the fog,
 * the light, the grass and the water all read one number instead of each fading on its own.
 */

/** Rec. 709 luma weights: a desaturated color keeps the brightness it had in color. */
const LUMA_R = 0.2126;
const LUMA_G = 0.7152;
const LUMA_B = 0.0722;

/** Anything that can act like a color: `Color` from three, or a plain object in tests. */
export interface Rgb {
  r: number;
  g: number;
  b: number;
  setRGB(r: number, g: number, b: number): unknown;
}

/** Clamps vision to [0, 1]; anything that is not a finite number counts as 0 (gray), the state the world starts in. */
export function clampVision(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** Fades `color` toward its own gray as `vision` goes to 0. At `vision` 1 the color is left as it was. */
export function applyVision<T extends Rgb>(color: T, vision: number): T {
  const v = clampVision(vision);
  if (v >= 1) return color;
  const gray = color.r * LUMA_R + color.g * LUMA_G + color.b * LUMA_B;
  color.setRGB(gray + (color.r - gray) * v, gray + (color.g - gray) * v, gray + (color.b - gray) * v);
  return color;
}
