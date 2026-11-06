/**
 * The biome registry: one table describing every biome of the world.
 *
 * A biome is data, not a chain of `if`s: its height/noise condition (`when`), the ground surface and base
 * color, the trees it grows, whether grass and flowers grow in it, its far fog, and whether the Погост
 * layer (mounds, crosses, bones) belongs to it. `selectBiome` walks `BIOME_ORDER` and returns the first
 * match, so that list is the priority: sea below the waterline, the shore, the peaks, the forest by its
 * noise, and meadows as the fallback that must stay last.
 *
 * The `Biome` name is the wire/telemetry format (`biome` in telemetry and the HUD), so renaming one is
 * cheap but not free. This table's behavior is pinned by `packages/shared/tests/biomes.test.ts` and by the
 * world snapshot in `docs/prompts/biome-registry-refactor.md`.
 */
import { WATER_LEVEL } from './constants.ts';

/** Biome names. The order here is only the canonical list; resolution order is `BIOME_ORDER`. */
export const BIOME_NAMES = ['ocean', 'beach', 'meadows', 'forest', 'mountain'] as const;

export type Biome = (typeof BIOME_NAMES)[number];

/** Tree silhouettes the client can draw. The order is the wire format: `kind` is packed as this index. */
export const TREE_KINDS = ['spruce', 'birch', 'dead'] as const;

export type TreeKind = (typeof TREE_KINDS)[number];

/** One silhouette of a biome's tree mix: a tree is this kind when the 0..1 roll is below `until`. */
export interface TreeShare {
  readonly kind: TreeKind;
  /** Cumulative threshold, 0..1. The last share of a mix has `until: 1`. */
  readonly until: number;
}

/** How a biome paints its ground vertex color (`ground-color.ts`). */
export type GroundSurface = 'water' | 'sand' | 'rock' | 'soil';

/**
 * Where a point belongs to a biome. Every bound is exclusive, matching the branches this table replaced:
 * `height < below`, `height > above`, `forestNoise > above`.
 */
export interface BiomeWhen {
  /** Below this world height (exclusive), meters. */
  readonly below?: number;
  /** Above this world height (exclusive), meters. */
  readonly above?: number;
  /** Forest noise at `scale` meters must be above this threshold (exclusive). */
  readonly forestNoise?: { readonly scale: number; readonly above: number };
}

export interface BiomeDef {
  /** Placement condition; `{}` matches everything (the fallback). */
  readonly when: BiomeWhen;
  readonly surface: GroundSurface;
  /** Base ground color, sRGB hex (`docs/graphics.md` «Палитра»). */
  readonly ground: number;
  /** Per-attempt tree probability in `treesInChunk`, and the silhouette mix rolled once per kept tree. */
  readonly trees: { readonly density: number; readonly mix: readonly TreeShare[] };
  /** Which scatter grows here: grass tufts and flowers (`scatter.ts`). */
  readonly scatter: { readonly grass: boolean; readonly flowers: boolean };
  /** Far fog `[near, far]` in meters: the Погост hides close, the mountains open up. */
  readonly fog: readonly [number, number];
  /** true when the Погост layer (mounds, crosses, bones) grows here. */
  readonly pogost: boolean;
}

/** The forest noise field: 300 m features, threshold 0.1. Shared by the table and the feathered edge. */
const FOREST_FIELD = { scale: 300, above: 0.1 } as const;

/** Noise scale of the forest field, meters. */
export const FOREST_NOISE_SCALE = FOREST_FIELD.scale;

/**
 * Half-width of the feathered forest edge, in noise units. The field's slope near the threshold is
 * roughly 0.01–0.02 per meter, so 0.03 is a 3–6 m band one way — a soft edge, not a wash.
 */
export const FOREST_EDGE_WIDTH = 0.03;

/**
 * Share of the forest side at a forest-noise value: 0 = meadows, 0.5 = the border itself, 1 = forest.
 * The two soil biomes are the only pair whose border feathers; water, shore and peaks keep hard edges.
 */
export function forestShare(noise: number): number {
  const t = (noise - (FOREST_FIELD.above - FOREST_EDGE_WIDTH)) / (2 * FOREST_EDGE_WIDTH);
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
  return clamped * clamped * (3 - 2 * clamped);
}

/** Sea, shore and peaks grow no trees; the mix only keeps `pickTreeKind` total. */
const NO_TREES: readonly TreeShare[] = [{ kind: 'spruce', until: 1 }];

export const BIOMES: Record<Biome, BiomeDef> = {
  ocean: {
    when: { below: WATER_LEVEL - 0.5 },
    surface: 'water',
    ground: 0x6b6146,
    trees: { density: 0, mix: NO_TREES },
    scatter: { grass: false, flowers: false },
    fog: [60, 380],
    pogost: false,
  },
  beach: {
    when: { below: WATER_LEVEL + 1.5 },
    surface: 'sand',
    ground: 0xc9b58a,
    trees: { density: 0, mix: NO_TREES },
    scatter: { grass: false, flowers: false },
    fog: [50, 320],
    pogost: false,
  },
  mountain: {
    when: { above: 38 },
    surface: 'rock',
    ground: 0x8d8a84,
    trees: {
      density: 0,
      mix: [
        { kind: 'dead', until: 0.5 },
        { kind: 'spruce', until: 1 },
      ],
    },
    scatter: { grass: false, flowers: false },
    fog: [90, 400],
    pogost: false,
  },
  forest: {
    when: { forestNoise: FOREST_FIELD },
    surface: 'soil',
    ground: 0x3f4a32, // was 0x3f6a2c — moss
    trees: {
      density: 0.55,
      mix: [
        { kind: 'spruce', until: 0.62 },
        { kind: 'birch', until: 0.88 },
        { kind: 'dead', until: 1 },
      ],
    },
    scatter: { grass: false, flowers: false },
    fog: [35, 220],
    pogost: false,
  },
  meadows: {
    when: {},
    surface: 'soil',
    ground: 0x6a7a4a, // was 0x6f9a3a — grass-olive, not neon
    trees: {
      density: 0.04,
      mix: [
        { kind: 'birch', until: 0.45 },
        { kind: 'spruce', until: 0.8 },
        { kind: 'dead', until: 1 },
      ],
    },
    scatter: { grass: true, flowers: true },
    fog: [30, 200],
    pogost: true,
  },
};

/**
 * Resolution order: first match wins. Sea first (below the waterline), then the shore, the peaks, the
 * forest by its noise, and meadows as the fallback — `meadows` must stay last.
 */
export const BIOME_ORDER: readonly Biome[] = ['ocean', 'beach', 'mountain', 'forest', 'meadows'];

/**
 * The registry compiled into a flat, monomorphic list once at import: `biomeAt` runs per terrain vertex,
 * so it must not pay for string-keyed lookups or array iterators. Sentinels: `below: Infinity` /
 * `above: -Infinity` mean "no bound", `forestScale: 0` means "no forest noise".
 */
interface BiomeRule {
  readonly name: Biome;
  readonly below: number;
  readonly above: number;
  readonly forestScale: number;
  readonly forestAbove: number;
}

const RULES: readonly BiomeRule[] = BIOME_ORDER.map((name) => {
  const { below, above, forestNoise } = BIOMES[name].when;
  return {
    name,
    below: below ?? Infinity,
    above: above ?? -Infinity,
    forestScale: forestNoise ? forestNoise.scale : 0,
    forestAbove: forestNoise ? forestNoise.above : Infinity,
  };
});

/**
 * The biome at a point, given its height and the forest noise sampler.
 *
 * `forestNoise` is called only when the walk reaches a biome that needs it, so the noise lookup happens
 * exactly where it did before this table existed: on land, once, never over sea or peaks.
 */
export function selectBiome(
  height: number,
  forestNoise: (x: number, z: number) => number,
  x: number,
  z: number,
): Biome {
  for (let i = 0; i < RULES.length; i++) {
    const rule = RULES[i];
    if (height >= rule.below || height <= rule.above) continue;
    if (
      rule.forestScale !== 0 &&
      forestNoise(x / rule.forestScale, z / rule.forestScale) <= rule.forestAbove
    ) {
      continue;
    }
    return rule.name;
  }
  // Unreachable while the last entry has `when: {}`, but it keeps the function total.
  return BIOME_ORDER[BIOME_ORDER.length - 1];
}

/** Picks a silhouette from a biome mix: the first share whose `until` is above the 0..1 roll. */
export function pickTreeKind(mix: readonly TreeShare[], roll: number): TreeKind {
  for (const share of mix) {
    if (roll < share.until) return share.kind;
  }
  return mix[mix.length - 1].kind;
}
