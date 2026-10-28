/** Reference heights from the TS terrain, to check the Rust port: `npx tsx spikes/rust-bevy/tools/heights.ts`. */
import { createTerrain } from '../../../packages/shared/src/terrain.ts';

const points: [number, number][] = [[0, 0], [10, -5], [63.5, 12.25], [-200, 300], [1000, -750], [-3333.3, 4444.4], [5000, 5000]];
for (const seed of [1337, 42]) {
  const t = createTerrain(seed);
  for (const [x, z] of points) console.log(`(${seed}, ${x}, ${z}, ${t.heightAt(x, z)}),`);
}
