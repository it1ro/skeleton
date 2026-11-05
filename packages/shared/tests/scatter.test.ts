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
      tx: 0,
      tz: -1,
      grassCount: 445,
      flowerCount: 52,
      grassMatrixHash: '536be12cb9c337c8a1860f7e9c606d66d0c44fed09417a432b1a8d95219d183f',
      grassColorHash: '087cc21609726d531649ae5d4e638d00711fbbc95e8e50ad8870590f68c99a1b',
      flowerMatrixHash: 'c6358782de378d8533af2151348c45f1d1eb027f0b397c5330e86497e8fdce5c',
      flowerColorHash: '34d65d5ae06341ae35f99aa0103570bf63bd3f7f7e3abf5a843d9f1bd0296e3b',
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
});
