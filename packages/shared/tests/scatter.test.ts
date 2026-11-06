import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildScatterData, createTerrain } from '../src/index.ts';

/** SHA-256 over the raw IEEE-754 bytes, so two scatter runs match only if every float is identical. */
const hashOf = (a: Float32Array): string =>
  createHash('sha256').update(Buffer.from(a.buffer, a.byteOffset, a.byteLength)).digest('hex');

/**
 * Golden placement captured from the previous main-thread `GrassField.buildTile` (three.js
 * `composeInstance` + `Color`) for seed 1337. The new shared `buildScatterData` must reproduce it
 * bit-for-bit: same rnd order, same salts, same matrix floats, same colors.
 */
const GOLDEN = {
  seed: 1337,
  tiles: [
    {
      tx: 0,
      tz: 0,
      grassCount: 559,
      flowerCount: 60,
      grassMatrixHash: '8ab69f6b5663ffe68cda0c2e905e19ff03107263676928cd0bd4742a4fed1678',
      grassColorHash: '2e145ff1dd035324f5eeb867a37a7bc7d843383cb28b5da7ef0e39514b78dde4',
      flowerMatrixHash: '5071e09d599a65ab6cf9a4259671b9f8d00251abe7e90fb26c359f257a225a93',
      flowerColorHash: 'b0e5e2bf5de03878641dc079385d6e4ac76ec41b93d9990a2411f43bc8d14d05',
    },
    {
      tx: 1,
      tz: 0,
      grassCount: 559,
      flowerCount: 61,
      grassMatrixHash: '0e587148e39bedb7ae3dfa4deb93f378efeadebcf1594190d4bc876af7c4cccf',
      grassColorHash: 'b9a64f05b4dbd76b5e29af321bbd18c077786f41fa1ef977dcbf6469cbeedac5',
      flowerMatrixHash: '3a0eee2020428e0203029e7845e383914866b6e34ed8fe01f98375f3404df868',
      flowerColorHash: 'ae4a5aae25aa9712a3b92fbac47cc71524007e82b680a6e0c60239860f5996ab',
    },
    {
      // The forest edge starts ~6 m north of spawn, so this tile is the only golden tile that changed:
      // the feathered edge thins six tufts. Tiles 0,0 and 1,0 are bit-identical to the old placement.
      tx: 0,
      tz: -1,
      grassCount: 451,
      flowerCount: 52,
      grassMatrixHash: '9f0936514c7a0035897c69580a1dd9e0a14e30d2c4a553103b23453f5321b687',
      grassColorHash: 'e8c9a3f59cca3653f9a5121e0a5f1faf1a4de211bc91aa88e85d4eb2990272c2',
      flowerMatrixHash: '5bcde144e65a929b2f26a5669184b6777aaa2e0674f2e75d608894426f2f38f0',
      flowerColorHash: 'ab9891515d149165fcc1bf5f199c4ceac0e8c8789b29b3c8adf42bc25e28cb5b',
    },
  ],
};

describe('buildScatterData', () => {
  it('reproduces the golden placement for the reference seed', () => {
    const terrain = createTerrain(GOLDEN.seed);
    for (const tile of GOLDEN.tiles) {
      const data = buildScatterData(terrain, tile.tx, tile.tz, GOLDEN.seed);
      expect(data.tx).toBe(tile.tx);
      expect(data.tz).toBe(tile.tz);
      expect(data.grass.matrices.length / 16).toBe(tile.grassCount);
      expect(data.flowers.matrices.length / 16).toBe(tile.flowerCount);
      expect(hashOf(data.grass.matrices)).toBe(tile.grassMatrixHash);
      expect(hashOf(data.grass.colors)).toBe(tile.grassColorHash);
      expect(hashOf(data.flowers.matrices)).toBe(tile.flowerMatrixHash);
      expect(hashOf(data.flowers.colors)).toBe(tile.flowerColorHash);
    }
  });

  it('is deterministic across calls and differs between seeds', () => {
    const a = createTerrain(1337);
    const b = createTerrain(1337);
    const first = buildScatterData(a, 2, 3, 1337);
    const second = buildScatterData(b, 2, 3, 1337);
    expect(hashOf(first.grass.matrices)).toBe(hashOf(second.grass.matrices));

    const other = buildScatterData(createTerrain(42), 2, 3, 42);
    expect(hashOf(other.grass.matrices)).not.toBe(hashOf(first.grass.matrices));
  });

  it('density-LOD lowers the instance count deterministically', () => {
    const terrain = createTerrain(1337);
    const full = buildScatterData(terrain, 0, 0, 1337);
    const half = buildScatterData(terrain, 0, 0, 1337, 0.5);
    const halfAgain = buildScatterData(createTerrain(1337), 0, 0, 1337, 0.5);
    const none = buildScatterData(terrain, 0, 0, 1337, 0);

    expect(half.grass.matrices.length).toBeLessThan(full.grass.matrices.length);
    expect(half.flowers.matrices.length).toBeLessThan(full.flowers.matrices.length);
    // Same seed + density → identical placement; density 0 emits no instances at all.
    expect(hashOf(half.grass.matrices)).toBe(hashOf(halfAgain.grass.matrices));
    expect(none.grass.matrices.length).toBe(0);
    expect(none.flowers.matrices.length).toBe(0);
  });
});
