/// <reference lib="webworker" />
import { WATER_FIELD_SPEC, bakeWaterField, toHalf } from './water-field.ts';

export interface WaterFieldRequest {
  seed: number;
}

export interface WaterFieldMessage {
  type: 'field';
  size: number;
  halfExtent: number;
  /** Half-float depth in meters, row-major from the north-west corner. */
  data: Uint16Array;
}

/**
 * Bakes the shallow-water field off the main thread. The bake is ~1M `heightAt` calls at full size, cut down
 * by the coarse skip in `bakeWaterField`; the result travels back zero-copy as a half-float buffer.
 */
self.onmessage = (event: MessageEvent<WaterFieldRequest>) => {
  const field = bakeWaterField(event.data.seed, WATER_FIELD_SPEC);
  const data = new Uint16Array(field.length);
  for (let i = 0; i < field.length; i++) data[i] = toHalf(field[i]);
  const message: WaterFieldMessage = {
    type: 'field',
    size: WATER_FIELD_SPEC.size,
    halfExtent: WATER_FIELD_SPEC.halfExtent,
    data,
  };
  (self as unknown as Worker).postMessage(message, [data.buffer]);
};
