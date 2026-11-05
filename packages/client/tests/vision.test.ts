import { describe, expect, it } from 'vitest';
import { applyVision, clampVision, type Rgb } from '../src/render/vision.ts';

function rgb(r: number, g: number, b: number): Rgb {
  const color = {
    r,
    g,
    b,
    setRGB(r: number, g: number, b: number) {
      color.r = r;
      color.g = g;
      color.b = b;
      return color;
    },
  };
  return color;
}

describe('clampVision', () => {
  it('keeps values inside [0, 1]', () => {
    expect(clampVision(0)).toBe(0);
    expect(clampVision(0.4)).toBe(0.4);
    expect(clampVision(1)).toBe(1);
    expect(clampVision(-2)).toBe(0);
    expect(clampVision(5)).toBe(1);
  });

  it('treats a broken value as gray, not as color', () => {
    expect(clampVision(Number.NaN)).toBe(0);
    expect(clampVision(Number.POSITIVE_INFINITY)).toBe(1);
  });
});

describe('applyVision', () => {
  it('leaves the color alone at vision 1', () => {
    const color = rgb(0.6, 0.75, 0.9);
    applyVision(color, 1);
    expect([color.r, color.g, color.b]).toEqual([0.6, 0.75, 0.9]);
  });

  it('turns the color into its own gray at vision 0', () => {
    const color = rgb(0.6, 0.75, 0.9);
    applyVision(color, 0);
    const gray = 0.6 * 0.2126 + 0.75 * 0.7152 + 0.9 * 0.0722;
    expect(color.r).toBeCloseTo(gray, 10);
    expect(color.g).toBeCloseTo(gray, 10);
    expect(color.b).toBeCloseTo(gray, 10);
  });

  it('moves gradually between gray and color', () => {
    const gray = rgb(0.6, 0.75, 0.9);
    applyVision(gray, 0);
    const half = rgb(0.6, 0.75, 0.9);
    applyVision(half, 0.5);
    expect(half.r).toBeCloseTo((gray.r + 0.6) / 2, 10);
    expect(half.g).toBeCloseTo((gray.g + 0.75) / 2, 10);
    expect(half.b).toBeCloseTo((gray.b + 0.9) / 2, 10);
  });
});
