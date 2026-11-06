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
  OctahedronGeometry,
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
const MOSS = new Color(0x3f4a32);

const SPRUCE_DARK = new Color(0x33402f);
const SPRUCE_LIGHT = new Color(0x6b7758);

const BIRCH_BARK = new Color(0xd9d4c4);
const BIRCH_MARK = new Color(0x3a3a34);
const BIRCH_BRANCH = new Color(0x5a4a3a);
const BIRCH_DARK = new Color(0x5a6a48);
const BIRCH_LIGHT = new Color(0xa9b56e);
const BIRCH_WARM = new Color(0xb8b072);

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

/** A root buttress lying outward and down from the trunk base: no tree ends in a cut cylinder. */
function rootParts(radius: number, seed: number, count: number, color: Color): Part[] {
  const parts: Part[] = [];
  for (let i = 0; i < count; i++) {
    const yaw = (i / count) * Math.PI * 2 + hash(i, 0, 0, seed) * 1.3;
    const length = radius * (2.0 + hash(i, 1, 0, seed) * 1.6);
    const geometry = new ConeGeometry(radius * 0.6, length, 5, 1);
    geometry.translate(0, length / 2, 0);
    geometry.rotateZ(-Math.PI / 2 - 0.3);
    geometry.rotateY(yaw);
    geometry.scale(1, 0.75, 1);
    geometry.translate(0, radius * 1.2, 0);
    jitter(geometry, radius * 0.45, seed + i * 19);
    geometry.computeVertexNormals();
    parts.push({ geometry, color: () => [color.r, color.g, color.b] });
  }
  return parts;
}

interface SpruceSpec {
  /** Height of the lowest whorl and of the tip, meters. */
  start: number;
  top: number;
  radius: number;
  tiers: number;
  paws: number;
  droop: number;
  /** Share of paws skipped per whorl: a ragged, aging spruce. */
  gap: number;
}

/**
 * Four silhouettes. A spruce is not a smooth cone: each whorl is a ring of separate drooping paws with
 * sky between them, so the outline is ragged at every tier and reads as a tree against the dawn sky.
 */
const SPRUCE_VARIANTS: readonly SpruceSpec[] = [
  { start: 0.55, top: 8.6, radius: 2.1, tiers: 14, paws: 6, droop: 0.3, gap: 0.05 },
  { start: 0.5, top: 7.4, radius: 2.6, tiers: 13, paws: 7, droop: 0.38, gap: 0.03 },
  { start: 0.7, top: 9.2, radius: 2.3, tiers: 15, paws: 5, droop: 0.26, gap: 0.22 },
  { start: 0.45, top: 5.8, radius: 1.7, tiers: 8, paws: 5, droop: 0.36, gap: 0.02 },
];

function spruce(seed: number, variant: number): BufferGeometry {
  const spec = SPRUCE_VARIANTS[variant] ?? SPRUCE_VARIANTS[0];
  const parts: Part[] = [];

  const trunkHeight = spec.top + 0.2;
  const trunk = new CylinderGeometry(0.07, 0.28, trunkHeight, 7, 5);
  bend(trunk, trunkHeight, seed, 0.05);
  trunk.translate(0, trunkHeight / 2, 0);
  parts.push({
    geometry: trunk,
    color: (_x, y) => {
      // Below the first whorl the trunk is bark; above it fades into the needle mass, never a lit stripe.
      const bark = mix(BARK_DARK, BARK, clamp01(y / 6) * 0.6);
      const c = mix(bark, SPRUCE_DARK, clamp01((y - 1.1) / 1.6));
      return [c.r, c.g, c.b];
    },
  });
  parts.push(...rootParts(0.3, seed + 3, 4, BARK_DARK));

  for (let tier = 0; tier < spec.tiers; tier++) {
    const t = spec.tiers === 1 ? 0 : tier / (spec.tiers - 1); // 0 bottom .. 1 top
    const y = spec.start + (spec.top - spec.start) * t;
    // Reach shrinks faster near the tip than linearly: the classic spruce profile.
    const reach = spec.radius * Math.pow(1 - t, 0.72) + 0.28;
    const count = Math.max(3, Math.round(spec.paws - t * (spec.paws - 3)));
    const baseYaw = hash(tier, 0, 0, seed) * Math.PI * 2;
    // Upper whorls catch the sky, lower ones sit in their own shade: baked, not per-light cost.
    const tierTint = 0.86 + t * 0.3;

    for (let b = 0; b < count; b++) {
      if (b > 0 && hash(tier, b, 1, seed) < spec.gap) continue; // a missing branch, not a hole in a cone
      const yaw = baseYaw + (b / count) * Math.PI * 2 + (hash(tier, b, 2, seed) - 0.5) * 0.55;
      const length = reach * (0.82 + hash(tier, b, 3, seed) * 0.4);
      const droop = spec.droop * (0.7 + hash(tier, b, 4, seed) * 0.7);
      // Needle mass of one branch: a wide, flattened cone, widest low on the tree.
      const width = length * (0.4 - t * 0.13) * (0.82 + hash(tier, b, 5, seed) * 0.36);

      const paw = new ConeGeometry(width, length, 4, 1);
      // Base at the trunk, apex outward: a tapering branch, not a cone cap.
      paw.translate(0, length / 2, 0);
      paw.rotateZ(-Math.PI / 2 - droop);
      paw.rotateY(yaw);
      paw.scale(1, 0.62, 1);
      paw.translate(0, y, 0);
      jitter(paw, width * 0.7, seed + tier * 13 + b);
      paw.computeVertexNormals();

      parts.push({
        geometry: paw,
        color: (x, py, z) => {
          const r = Math.hypot(x, z);
          const out = clamp01(r / length);
          // Dark where a paw meets the trunk, lighter at its tips and underside.
          const inner = 0.72 + 0.28 * Math.min(1, r * 2.2);
          const under = py < y - width * 0.5 ? 0.86 : 1;
          const k = tierTint * inner * under;
          const c = mix(SPRUCE_DARK, SPRUCE_LIGHT, 0.1 + 0.9 * out);
          const dapple = 0.92 + 0.16 * hash(x, py * 0.6, z, seed + 777);
          return [c.r * k * dapple, c.g * k * dapple, c.b * k * dapple];
        },
      });
    }
  }

  // A thin leader above the last whorl; without it the tip looks chopped.
  const leader = new ConeGeometry(0.11, 0.75, 5, 1);
  leader.translate(0, spec.top + 0.3, 0);
  leader.computeVertexNormals();
  parts.push({
    geometry: leader,
    color: () => [SPRUCE_LIGHT.r, SPRUCE_LIGHT.g, SPRUCE_LIGHT.b],
  });

  return mergeParts(parts);
}

interface BirchSpec {
  /** Height of the fork: below it one trunk, above it several leaders. */
  fork: number;
  /** Total height, used only to size the crown. */
  height: number;
  /** Crown half-width, meters. */
  crown: number;
  leaders: readonly { yaw: number; tilt: number; length: number }[];
  branches: number;
  lean: number;
}

/**
 * A birch is a fork, not a pole: the trunk splits into two or three leaders, thin branches leave them at
 * a droop, and the crown is a loose, wider-than-tall cloud of small clumps with sky through it.
 */
const BIRCH_VARIANTS: readonly BirchSpec[] = [
  {
    fork: 3.2, height: 8.8, crown: 2.6, branches: 10, lean: 0.16,
    leaders: [
      { yaw: 0.4, tilt: 0.22, length: 5.0 },
      { yaw: 2.8, tilt: 0.34, length: 4.4 },
      { yaw: 5.0, tilt: 0.16, length: 4.0 },
    ],
  },
  {
    fork: 2.7, height: 8.0, crown: 2.9, branches: 11, lean: 0.2,
    leaders: [
      { yaw: 1.2, tilt: 0.3, length: 4.7 },
      { yaw: 4.1, tilt: 0.22, length: 4.7 },
    ],
  },
  {
    fork: 3.6, height: 9.2, crown: 2.5, branches: 9, lean: 0.24,
    leaders: [
      { yaw: 2.2, tilt: 0.18, length: 5.2 },
      { yaw: 5.4, tilt: 0.36, length: 4.2 },
    ],
  },
  {
    fork: 2.1, height: 6.4, crown: 2.0, branches: 8, lean: 0.12,
    leaders: [
      { yaw: 0.9, tilt: 0.26, length: 3.8 },
      { yaw: 3.6, tilt: 0.32, length: 3.4 },
    ],
  },
];

interface Clump {
  x: number;
  y: number;
  z: number;
  r: number;
}

function birch(seed: number, variant: number): BufferGeometry {
  const spec = BIRCH_VARIANTS[variant] ?? BIRCH_VARIANTS[0];
  const parts: Part[] = [];
  const bark = (_x: number, y: number, z: number): Rgb => {
    const angle = Math.atan2(z, _x);
    const bands = Math.sin(y * 3.7 + angle * 2.3) + Math.sin(y * 8.3 - angle * 1.7);
    let c = bands > 1.15 ? BIRCH_MARK : BIRCH_BARK;
    if (y < 0.7) c = mix(BIRCH_MARK, BIRCH_BARK, y / 0.7);
    const silver = 0.94 + 0.08 * hash(_x, y * 0.5, z, seed + 91);
    return [c.r * silver, c.g * silver, c.b * silver];
  };

  const trunk = new CylinderGeometry(0.13, 0.26, spec.fork, 7, 6);
  bend(trunk, spec.fork, seed, spec.lean);
  trunk.translate(0, spec.fork / 2, 0);
  parts.push({ geometry: trunk, color: bark });

  const rootBark = mix(BIRCH_BARK, BIRCH_MARK, 0.35);
  parts.push(...rootParts(0.18, seed + 7, 3, rootBark));

  const forkY = spec.fork;
  const clumps: Clump[] = [];

  spec.leaders.forEach((leader, index) => {
    // One leader continues the trunk; the others leave it at the fork.
    const leaderGeom = new CylinderGeometry(0.055, 0.13, leader.length, 6, 5);
    bend(leaderGeom, leader.length, seed + index * 3, 0.12);
    leaderGeom.translate(0, leader.length / 2, 0);
    leaderGeom.rotateZ(-leader.tilt);
    leaderGeom.rotateY(leader.yaw);
    leaderGeom.translate(0, forkY - 0.15, 0);
    parts.push({ geometry: leaderGeom, color: bark });

    // A cap at the leader tip keeps a bare stick from poking through the crown.
    const tipX = Math.sin(leader.tilt) * Math.cos(leader.yaw) * leader.length;
    const tipZ = -Math.sin(leader.tilt) * Math.sin(leader.yaw) * leader.length;
    const tipY = forkY - 0.15 + Math.cos(leader.tilt) * leader.length;
    clumps.push({ x: tipX, y: tipY, z: tipZ, r: 0.4 + hash(index, 2, 0, seed) * 0.2 });
  });

  // Branches: from a point along a leader, outward and down, each ending in a couple of clumps.
  for (let b = 0; b < spec.branches; b++) {
    const leader = spec.leaders[b % spec.leaders.length];
    const cosYaw = Math.cos(leader.yaw);
    const sinYaw = Math.sin(leader.yaw);
    const dx = Math.sin(leader.tilt) * cosYaw;
    const dz = -Math.sin(leader.tilt) * sinYaw;
    const s = 0.5 + (b / spec.branches) * 0.42;
    const fromY = forkY - 0.15 + Math.cos(leader.tilt) * leader.length * s;
    const fx = dx * leader.length * s;
    const fz = dz * leader.length * s;
    const yaw = hash(b, 7, 0, seed) * Math.PI * 2;
    const droop = 0.45 + hash(b, 8, 0, seed) * 0.5;
    const length = (0.9 + hash(b, 9, 0, seed) * 0.8) * (spec.crown / 2.6);

    const branch = new CylinderGeometry(0.018, 0.045, length, 5, 2);
    branch.translate(0, length / 2, 0);
    branch.rotateZ(-Math.PI / 2 - droop);
    branch.rotateY(yaw);
    branch.translate(fx, fromY, fz);
    jitter(branch, 0.03, seed + b * 5);
    branch.computeVertexNormals();
    parts.push({
      geometry: branch,
      color: () => [BIRCH_BRANCH.r, BIRCH_BRANCH.g, BIRCH_BRANCH.b],
    });

  }

  // The crown is one loose cloud, wider than tall: a few big masses set the shape, many small clumps
  // break the outline, and the rim is sampled outward so the edge is ragged, never an egg.
  const crownBase = forkY + 0.35;
  const crownTop = spec.height;
  const cy = (crownBase + crownTop) / 2;
  const ry = (crownTop - crownBase) / 2;
  const rx = spec.crown;

  for (let i = 0; i < 5; i++) {
    const theta = (i / 5) * Math.PI * 2 + hash(i, 50, 0, seed) * 0.8;
    const rad = 0.4 + hash(i, 51, 0, seed) * 0.25;
    clumps.push({
      x: Math.cos(theta) * rx * rad,
      y: cy + (hash(i, 52, 0, seed) - 0.5) * ry * 0.9,
      z: Math.sin(theta) * rx * rad,
        r: 0.34 + hash(i, 53, 0, seed) * 0.14,
    });
  }

  // A Fibonacci sphere keeps the shell evenly covered, then jitter and radius noise break the order:
  // an even distribution is what stops an airy crown from falling apart into separate baubles.
  const grains = 150;
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < grains; i++) {
    const phi = Math.acos(1 - (2 * (i + 0.5)) / grains) + (hash(i, 61, 0, seed) - 0.5) * 0.22;
    const theta = i * golden + (hash(i, 60, 0, seed) - 0.5) * 0.55;
    const rad = 0.78 + hash(i, 62, 0, seed) * 0.22;
    const ring = Math.sin(phi);
    // Lobes and a domed top keep the cloud from reading as a sphere.
    const bulge = 1 + 0.14 * Math.sin(theta * 3 + seed) + 0.08 * Math.cos(phi * 2.2);
    clumps.push({
      x: Math.cos(theta) * ring * rad * rx * bulge,
      y: Math.max(crownBase - 0.25, cy + Math.cos(phi) * rad * ry),
      z: Math.sin(theta) * ring * rad * rx * bulge,
      r: 0.2 + hash(i, 63, 0, seed) * 0.15,
    });
  }
  // A sparse inner layer closes the see-through gaps without thickening the rim.
  for (let i = 0; i < 40; i++) {
    const theta = hash(i, 80, 0, seed) * Math.PI * 2;
    const up = hash(i, 81, 0, seed) * 2 - 1;
    const rad = 0.25 + hash(i, 82, 0, seed) * 0.4;
    const ring = Math.sqrt(Math.max(0, 1 - up * up));
    clumps.push({
      x: Math.cos(theta) * ring * rad * rx,
      y: Math.max(crownBase - 0.2, cy + up * rad * ry),
      z: Math.sin(theta) * ring * rad * rx,
      r: 0.26 + hash(i, 83, 0, seed) * 0.16,
    });
  }

  // Drooping tufts under the rim: birches hang, they do not wear a ball.
  for (let i = 0; i < 3; i++) {
    const theta = hash(i, 70, 0, seed) * Math.PI * 2;
    clumps.push({
      x: Math.cos(theta) * rx * 0.62,
      y: crownBase - 0.1,
      z: Math.sin(theta) * rx * 0.62,
      r: 0.3 + hash(i, 71, 0, seed) * 0.14,
    });
  }

  // Crown metrics for baked occlusion: clumps deep inside the cloud are darker than the rim.
  let minY = Infinity;
  let maxY = -Infinity;
  let sumX = 0;
  let sumZ = 0;
  for (const clump of clumps) {
    minY = Math.min(minY, clump.y);
    maxY = Math.max(maxY, clump.y);
    sumX += clump.x;
    sumZ += clump.z;
  }
  const cx = sumX / clumps.length;
  const cz = sumZ / clumps.length;
  let crownR = 1;
  for (const clump of clumps) crownR = Math.max(crownR, Math.hypot(clump.x - cx, clump.z - cz));
  const spanY = Math.max(0.001, maxY - minY);

  clumps.forEach((clump, index) => {
    // Small faceted clumps, not boulders: many of them read as a leaf mass at arm's length and
    // still merge into one crown at a hundred meters.
    const geometry = new OctahedronGeometry(clump.r, 0);
    geometry.scale(1, 0.8, 1);
    // Tumble each clump: aligned facets read as a tiled ball, tumbled ones as foliage.
    geometry.rotateX(hash(clump.x, clump.z, clump.y, seed + 71) * Math.PI);
    geometry.rotateY(hash(clump.x, clump.y, clump.z, seed + index) * Math.PI * 2);
    geometry.rotateZ(hash(clump.y, clump.x, clump.z, seed + 73) * Math.PI);
    geometry.translate(clump.x, clump.y, clump.z);
    jitter(geometry, clump.r * 0.26, seed + index * 11);
    geometry.computeVertexNormals();

    const inner = clamp01(1 - Math.hypot(clump.x - cx, clump.z - cz) / (crownR * 1.05));
    const height = clamp01((clump.y - minY) / spanY);
    const openness = clamp01(0.5 + 0.4 * height - 0.4 * inner);
    const warm = hash(clump.x, clump.y, clump.z, seed + 42);
    const c = mix(mix(BIRCH_DARK, BIRCH_LIGHT, 0.25 + 0.75 * openness), BIRCH_WARM, warm * 0.35);
    // Each tuft a slightly different leaf tone: a flat canopy reads as plastic.
    const tint = 0.84 + hash(clump.x, clump.y, clump.z, seed + 99) * 0.26;

    parts.push({
      geometry,
      color: (x, y, z) => {
        const local = clamp01((y - (clump.y - clump.r)) / (clump.r * 2));
        const k = (0.9 + 0.15 * local) * tint; // underside in its own shade
        const dapple = 0.88 + 0.24 * hash(x, y * 0.4, z, seed + 555);
        return [c.r * k * dapple, c.g * k * dapple, c.b * k * dapple];
      },
    });
  });

  return mergeParts(parts);
}

interface DeadSpec {
  height: number;
  branches: number;
  lean: number;
  /** A snapped top instead of a standing trunk. */
  broken: boolean;
}

const DEAD_VARIANTS: readonly DeadSpec[] = [
  { height: 5.6, branches: 10, lean: 0.14, broken: false },
  { height: 3.4, branches: 5, lean: 0.34, broken: true },
];

/** A dead trunk: bare, tapered, root-flared, with broken branches instead of a crown. */
function dead(seed: number, variant: number): BufferGeometry {
  const spec = DEAD_VARIANTS[variant] ?? DEAD_VARIANTS[0];
  const parts: Part[] = [];
  const wood = (x: number, y: number, z: number): Rgb => {
    // Moss creeps up from the ground on one side: color, not a second material.
    const moss = clamp01((1.1 - y) / 0.9) * clamp01(0.5 + 0.5 * hash(x * 0.7, 0, z * 0.7, seed + 31));
    const c = mix(DEAD_DARK, DEAD_LIGHT, clamp01(y / 4.5));
    const lit = mix(c, MOSS, moss * 0.55);
    return [lit.r, lit.g, lit.b];
  };

  const trunk = new CylinderGeometry(0.08, 0.24, spec.height, 6, 5);
  bend(trunk, spec.height, seed, spec.lean);
  trunk.translate(0, spec.height / 2, 0);
  parts.push({ geometry: trunk, color: wood });
  parts.push(...rootParts(0.16, seed + 13, 3, DEAD_DARK));

  for (let b = 0; b < spec.branches; b++) {
    // Branches crowd the top and thin out below, the way a snag dies from the crown down.
    const t = (b + 1) / (spec.branches + 1);
    const y = 0.8 + (1 - t * t) * (spec.height - 1.2);
    const yaw = hash(b, 1, 0, seed) * Math.PI * 2;
    const droop = 0.35 + hash(b, 2, 0, seed) * 0.9;
    const length = (0.6 + hash(b, 3, 0, seed) * 1.2) * (spec.height / 5.2) * (0.7 + t * 0.5);
    const radius = 0.03 + hash(b, 4, 0, seed) * 0.03;
    const geometry = new CylinderGeometry(radius * 0.35, radius, length, 5, 2);
    // A slight bend keeps dead branches from looking like nails.
    bend(geometry, length, seed + b * 7, 0.12);
    geometry.translate(0, length / 2, 0);
    geometry.rotateZ(-Math.PI / 2 - droop);
    geometry.rotateY(yaw);
    geometry.translate(0, y, 0);
    jitter(geometry, radius * 1.4, seed + b * 3);
    geometry.computeVertexNormals();
    parts.push({ geometry, color: wood });
  }

  // Broken-off stubs: the trunk is not a clean pole.
  for (let i = 0; i < 3; i++) {
    const stub = new ConeGeometry(0.06, 0.35 + hash(i, 20, 0, seed) * 0.3, 4, 1);
    stub.translate(0, 0.25, 0);
    stub.rotateZ(-Math.PI / 2 - 0.2);
    stub.rotateY(hash(i, 21, 0, seed) * Math.PI * 2);
    stub.translate(0, 1.2 + i * (spec.height - 2) * 0.32, 0);
    jitter(stub, 0.08, seed + i * 37);
    stub.computeVertexNormals();
    parts.push({ geometry: stub, color: wood });
  }

  if (spec.broken) {
    // Splinters at the break: three short shards fanned out of the stump.
    for (let i = 0; i < 3; i++) {
      const shard = new ConeGeometry(0.05, 0.55, 4, 1);
      shard.translate(0, 0.27, 0);
      shard.rotateZ(-0.15 - hash(i, 6, 0, seed) * 0.35);
      shard.rotateY(hash(i, 7, 0, seed) * Math.PI * 2);
      shard.translate(0, spec.height - 0.1, 0);
      jitter(shard, 0.12, seed + i * 23);
      shard.computeVertexNormals();
      parts.push({ geometry: shard, color: wood });
    }
  } else {
    // A snapped top: one leaning splinter and a jagged cap, not a fork.
    const stub = new ConeGeometry(0.08, 0.9, 4, 1);
    stub.translate(0, 0.4, 0);
    stub.rotateZ(-0.3);
    stub.rotateY(hash(3, 9, 0, seed) * Math.PI * 2);
    stub.translate(0, spec.height - 0.2, 0);
    jitter(stub, 0.16, seed + 29);
    stub.computeVertexNormals();
    parts.push({ geometry: stub, color: wood });
  }

  return mergeParts(parts);
}

/** How many geometry variants a kind has; the client derives the variant from a position hash. */
export function treeVariantCount(kind: TreeKind): number {
  return kind === 'dead' ? DEAD_VARIANTS.length : kind === 'birch' ? BIRCH_VARIANTS.length : SPRUCE_VARIANTS.length;
}

export function createTreeGeometry(kind: TreeKind, variant: number): BufferGeometry {
  const seed = (kind === 'spruce' ? 11 : kind === 'birch' ? 23 : 37) + variant * 31;
  if (kind === 'spruce') return spruce(seed, variant);
  if (kind === 'birch') return birch(seed, variant);
  return dead(seed, variant);
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
