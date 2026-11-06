/**
 * Tree silhouettes for the procedural forest. Each (kind, variant) is one merged, non-indexed geometry
 * with baked vertex colors, drawn in a single instanced draw call. Variants break the "clone army" look;
 * drooping tiers, bent trunks and a dappled crown color are all baked in, so nothing here costs at runtime.
 */

import {
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  Float32BufferAttribute,
  IcosahedronGeometry,
  MeshStandardNodeMaterial,
} from 'three/webgpu';
import { Fn, float, instanceIndex, positionLocal, sin, time, uniform, vec3 } from 'three/tsl';
import { TREE_KINDS, type TreeKind } from '@skeleton/shared';

export type Rgb = [number, number, number];
export type ColorFn = (x: number, y: number, z: number) => Rgb;

export interface Part {
  geometry: BufferGeometry;
  color: ColorFn;
}

const BARK_DARK = new Color(0x33251a);
const BARK = new Color(0x4a3a2a);

const SPRUCE_DARK = new Color(0x18201a);
const SPRUCE_LIGHT = new Color(0x3a4632);

const BIRCH_BARK = new Color(0xe8e4d8);
const BIRCH_MARK = new Color(0x3a3a34);
const BIRCH_BRANCH = new Color(0x5a4a3a);
const BIRCH_DARK = new Color(0x5f7040);
const BIRCH_LIGHT = new Color(0xa8b86a);

const DEAD_DARK = new Color(0x463628);
const DEAD_LIGHT = new Color(0x7a6a58);

export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

export function mix(a: Color, b: Color, t: number): Color {
  const k = clamp01(t);
  return new Color(a.r + (b.r - a.r) * k, a.g + (b.g - a.g) * k, a.b + (b.b - a.b) * k);
}

/** Deterministic 0..1 hash of a position, so duplicated seam vertices move together. */
export function hash(x: number, y: number, z: number, seed: number): number {
  const v = Math.sin(x * 127.1 + y * 311.7 + z * 74.7 + seed * 19.19) * 43758.5453;
  return v - Math.floor(v);
}

/** Pushes each vertex by a position-hashed amount: breaks the perfect cone without cracking seams. */
export function jitter(geometry: BufferGeometry, amount: number, seed: number): void {
  const pos = geometry.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    pos.setXYZ(
      i,
      x + (hash(x, y, z, seed) - 0.5) * amount,
      y + (hash(x, y, z, seed + 1) - 0.5) * amount * 0.5,
      z + (hash(x, y, z, seed + 2) - 0.5) * amount,
    );
  }
  pos.needsUpdate = true;
}

/**
 * Leans and curves a centered cylinder (height `height`, y in −h/2..+h/2) so trunks are not straight
 * clones. The crown sits close enough to the top that a small lean does not detach it.
 */
function bend(geometry: BufferGeometry, height: number, seed: number, lean: number): void {
  const pos = geometry.getAttribute('position');
  const dir = Math.sin(seed * 12.9898) * lean;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const t = (y + height / 2) / height;
    const s = dir * t * t + Math.sin(y * 0.7 + seed) * lean * 0.4 * t;
    pos.setXYZ(i, pos.getX(i) + s, y, pos.getZ(i));
  }
  pos.needsUpdate = true;
}

/**
 * Flares a centered cone's base outward and down: `amount` fades with height, so the profile curves
 * instead of a straight edge — a drooping spruce skirt, not a party hat.
 */
function flareCone(geometry: BufferGeometry, height: number, amount: number): void {
  const pos = geometry.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const t = (y + height / 2) / height; // 0 base .. 1 tip
    const r = Math.hypot(x, z);
    if (r < 1e-4) continue; // the tip
    const grow = (1 - t) * amount;
    const k = (r + grow) / r;
    pos.setXYZ(i, x * k, y - grow * 0.7, z * k);
  }
  pos.needsUpdate = true;
}

/** Expands every part to non-indexed triangles and concatenates positions, normals and vertex colors. */
export function mergeParts(parts: Part[]): BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  for (const part of parts) {
    const source = part.geometry;
    const geometry = source.index ? source.toNonIndexed() : source;
    const pos = geometry.getAttribute('position');
    const nor = geometry.getAttribute('normal');
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      positions.push(x, y, z);
      if (nor) normals.push(nor.getX(i), nor.getY(i), nor.getZ(i));
      const color = part.color(x, y, z);
      colors.push(color[0], color[1], color[2]);
    }
    if (geometry !== source) geometry.dispose();
    source.dispose();
  }
  const merged = new BufferGeometry();
  merged.setAttribute('position', new Float32BufferAttribute(positions, 3));
  if (normals.length > 0) merged.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  merged.setAttribute('color', new Float32BufferAttribute(colors, 3));
  merged.computeBoundingSphere();
  return merged;
}

/** A tiered spruce: a visible trunk and stacked, drooping, jittered cone layers. */
function spruce(seed: number, variant: number): BufferGeometry {
  const parts: Part[] = [];

  const trunk = new CylinderGeometry(0.14, 0.26, 4.4, 6, 2);
  bend(trunk, 4.4, seed, 0.12);
  trunk.translate(0, 2.2, 0);
  parts.push({
    geometry: trunk,
    color: (_x, y) => {
      const c = mix(BARK_DARK, BARK, y / 3);
      return [c.r, c.g, c.b];
    },
  });

  const tiers =
    variant === 0
      ? [
          { base: 1.2, height: 3.4, radius: 1.95, angle: 0.0 },
          { base: 2.8, height: 2.9, radius: 1.55, angle: 0.5 },
          { base: 4.2, height: 2.4, radius: 1.15, angle: 0.2 },
          { base: 5.4, height: 1.9, radius: 0.8, angle: 0.8 },
          { base: 6.4, height: 1.5, radius: 0.5, angle: 0.35 },
        ]
      : [
          { base: 1.0, height: 3.8, radius: 2.15, angle: 0.6 },
          { base: 2.7, height: 3.1, radius: 1.6, angle: 0.1 },
          { base: 4.2, height: 2.5, radius: 1.1, angle: 0.9 },
          { base: 5.5, height: 1.8, radius: 0.65, angle: 0.3 },
        ];

  tiers.forEach((tier, index) => {
    const geometry = new ConeGeometry(tier.radius, tier.height, 7, 3);
    flareCone(geometry, tier.height, tier.radius * 0.22);
    geometry.rotateY(tier.angle);
    geometry.translate(0, tier.base + tier.height / 2, 0);
    jitter(geometry, tier.radius * 0.16, seed + index * 7);
    geometry.computeVertexNormals();
    const tint = 0.92 + index * 0.03;
    parts.push({
      geometry,
      color: (x, y, z) => {
        const t = clamp01((y - tier.base) / tier.height);
        const c = mix(SPRUCE_DARK, SPRUCE_LIGHT, t * t);
        const dapple = 0.9 + 0.2 * hash(x, y * 0.35, z, seed + 777);
        return [c.r * tint * dapple, c.g * tint * dapple, c.b * tint * dapple];
      },
    });
  });

  return mergeParts(parts);
}

/** A birch: a pale, bent trunk with marks, branches, and a loose crown of jittered blobs. */
function birch(seed: number, variant: number): BufferGeometry {
  const parts: Part[] = [];

  const trunk = new CylinderGeometry(0.12, 0.21, 6.2, 7, 8);
  bend(trunk, 6.2, seed, 0.16);
  trunk.translate(0, 3.1, 0);
  parts.push({
    geometry: trunk,
    color: (x, y, z) => {
      const angle = Math.atan2(z, x);
      const bands = Math.sin(y * 3.7 + angle * 2.3) + Math.sin(y * 8.3 - angle * 1.7);
      let c = bands > 1.15 ? BIRCH_MARK : BIRCH_BARK;
      if (y < 0.7) c = mix(BIRCH_MARK, BIRCH_BARK, y / 0.7);
      return [c.r, c.g, c.b];
    },
  });

  const blobs =
    variant === 0
      ? [
          { x: 0, y: 5.8, z: 0, r: 1.55 },
          { x: 1.25, y: 5.2, z: 0.25, r: 1.15 },
          { x: -1.2, y: 5.5, z: -0.35, r: 1.2 },
          { x: 0.35, y: 6.9, z: -0.55, r: 1.0 },
          { x: -0.45, y: 6.6, z: 0.85, r: 0.95 },
          { x: 0.95, y: 4.5, z: -0.9, r: 0.75 },
          { x: -0.95, y: 4.4, z: 0.55, r: 0.7 },
          { x: 0.15, y: 7.4, z: 0.15, r: 0.7 },
          { x: -0.2, y: 4.9, z: -1.1, r: 0.65 },
          { x: 1.35, y: 5.9, z: -0.6, r: 0.7 },
        ]
      : [
          { x: 0.2, y: 5.6, z: -0.2, r: 1.7 },
          { x: 1.35, y: 5.0, z: 0.4, r: 1.1 },
          { x: -1.3, y: 5.3, z: 0.1, r: 1.15 },
          { x: -0.4, y: 6.8, z: -0.8, r: 0.95 },
          { x: 0.5, y: 6.6, z: 0.9, r: 0.9 },
          { x: -0.9, y: 4.3, z: -0.6, r: 0.7 },
          { x: 0.8, y: 4.2, z: 0.7, r: 0.65 },
          { x: -0.1, y: 7.5, z: -0.1, r: 0.7 },
        ];

  const branches =
    variant === 0
      ? [
          { y: 5.0, length: 1.3, radius: 0.05, tilt: -0.85, turn: 0.5 },
          { y: 5.6, length: 1.2, radius: 0.045, tilt: -0.95, turn: 2.6 },
          { y: 4.6, length: 1.1, radius: 0.04, tilt: -0.8, turn: 4.4 },
        ]
      : [
          { y: 5.1, length: 1.4, radius: 0.05, tilt: -0.9, turn: 1.3 },
          { y: 4.7, length: 1.0, radius: 0.04, tilt: -0.75, turn: 3.9 },
        ];

  branches.forEach((branch, index) => {
    const geometry = new CylinderGeometry(branch.radius * 0.5, branch.radius, branch.length, 5, 1);
    geometry.translate(0, branch.length / 2, 0);
    geometry.rotateZ(branch.tilt);
    geometry.rotateY(branch.turn);
    geometry.translate(0, branch.y, 0);
    jitter(geometry, branch.radius * 0.8, seed + 100 + index);
    geometry.computeVertexNormals();
    parts.push({
      geometry,
      color: () => [BIRCH_BRANCH.r, BIRCH_BRANCH.g, BIRCH_BRANCH.b],
    });
  });

  blobs.forEach((blob, index) => {
    const geometry = new IcosahedronGeometry(blob.r, 0);
    geometry.scale(1, 0.74, 1);
    geometry.translate(blob.x, blob.y, blob.z);
    jitter(geometry, blob.r * 0.24, seed + index * 11);
    geometry.computeVertexNormals();
    const tint = 0.92 + (index % 4) * 0.03;
    parts.push({
      geometry,
      color: (x, y, z) => {
        const t = clamp01((y - (blob.y - blob.r)) / (blob.r * 2));
        const c = mix(BIRCH_DARK, BIRCH_LIGHT, 0.25 + 0.75 * t);
        const dapple = 0.9 + 0.2 * hash(x, y * 0.4, z, seed + 555);
        return [c.r * tint * dapple, c.g * tint * dapple, c.b * tint * dapple];
      },
    });
  });

  return mergeParts(parts);
}

/** A dead trunk: bare, tapered, with a few broken branches instead of a crown. */
function dead(seed: number): BufferGeometry {
  const parts: Part[] = [];
  const wood = (_x: number, y: number): Rgb => {
    const c = mix(DEAD_DARK, DEAD_LIGHT, clamp01(y / 4.5));
    return [c.r, c.g, c.b];
  };

  const trunk = new CylinderGeometry(0.1, 0.3, 4.4, 6, 3);
  bend(trunk, 4.4, seed, 0.14);
  trunk.translate(0, 2.2, 0);
  parts.push({ geometry: trunk, color: wood });

  const branches = [
    { y: 1.9, length: 1.6, radius: 0.07, tilt: -1.0, turn: 0.3 },
    { y: 2.8, length: 1.9, radius: 0.07, tilt: -1.15, turn: 2.4 },
    { y: 3.5, length: 1.4, radius: 0.05, tilt: -0.9, turn: 4.1 },
    { y: 4.0, length: 1.0, radius: 0.04, tilt: -1.2, turn: 5.2 },
    { y: 4.2, length: 0.7, radius: 0.06, tilt: 0.3, turn: 0 },
  ];

  branches.forEach((branch, index) => {
    const geometry = new CylinderGeometry(branch.radius * 0.5, branch.radius, branch.length, 5, 1);
    geometry.translate(0, branch.length / 2, 0);
    geometry.rotateZ(branch.tilt);
    geometry.rotateY(branch.turn);
    geometry.translate(0, branch.y, 0);
    jitter(geometry, branch.radius * 0.8, seed + index);
    geometry.computeVertexNormals();
    parts.push({ geometry, color: wood });
  });

  return mergeParts(parts);
}

/** How many geometry variants a kind has; the client derives the variant from a position hash. */
export function treeVariantCount(kind: TreeKind): number {
  return kind === 'dead' ? 1 : 2;
}

export function createTreeGeometry(kind: TreeKind, variant: number): BufferGeometry {
  const seed = (kind === 'spruce' ? 11 : kind === 'birch' ? 23 : 37) + variant * 31;
  if (kind === 'spruce') return spruce(seed, variant);
  if (kind === 'birch') return birch(seed, variant);
  return dead(seed);
}

/** Flat list of (kind, variant) pools, in wire order, plus the starting index of each kind. */
export const TREE_POOLS: { kind: TreeKind; variant: number }[] = [];
export const TREE_POOL_START: number[] = [];
{
  let acc = 0;
  for (const kind of TREE_KINDS) {
    TREE_POOL_START.push(acc);
    const count = treeVariantCount(kind);
    for (let variant = 0; variant < count; variant++) TREE_POOLS.push({ kind, variant });
    acc += count;
  }
}

/**
 * One material for all trees. Wind is a vertex displacement that grows with height squared: the trunk
 * base stays planted, the crown sways. `instanceIndex` gives every tree its own phase.
 */
export function createTreeMaterial(): MeshStandardNodeMaterial {
  const material = new MeshStandardNodeMaterial({
    vertexColors: true,
    roughness: 1,
    metalness: 0,
    flatShading: true,
  });

  const wind = uniform(0.16);
  const phase = float(instanceIndex).mul(12.9898).sin().mul(43758.5453).fract().mul(6.283);

  material.positionNode = Fn(() => {
    const p = positionLocal;
    const wave = sin(time.mul(1.1).add(phase))
      .mul(0.65)
      .add(sin(time.mul(1.7).add(phase.mul(1.7))).mul(0.35));
    const height = p.y.mul(0.125).pow(2);
    const sway = wave.mul(height).mul(wind);
    return p.add(vec3(sway, 0, sway.mul(0.4)));
  })();

  return material;
}
