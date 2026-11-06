import type { WaterFieldMessage } from './water-field.worker.ts';

/**
 * Bakes the shallow-water field in a worker and resolves when it is ready. `null` means the bake failed:
 * the sea keeps its flat look instead of blocking the first frame or crashing the game.
 */
export function loadWaterField(seed: number): Promise<WaterFieldMessage | null> {
  return new Promise((resolve) => {
    try {
      const worker = new Worker(new URL('./water-field.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (event: MessageEvent<WaterFieldMessage>) => {
        worker.terminate();
        resolve(event.data);
      };
      worker.onerror = () => {
        worker.terminate();
        resolve(null);
      };
      worker.postMessage({ seed });
    } catch {
      resolve(null);
    }
  });
}
