/**
 * Погост props: a grave mound, a tilted wooden cross and a scatter of bones. Each kind is one merged,
 * non-indexed geometry with baked vertex colors, drawn in a single instanced draw call — the same scheme
 * as the trees, so nothing here costs at runtime.
 */

import {
  BoxGeometry,
  Color,
  CylinderGeometry,
  MeshStandardMaterial,
  SphereGeometry,
  type BufferGeometry,
} from 'three/webgpu';
import { clamp01, hash, mergeParts, mix, type Part, type Rgb } from './trees.ts';

const EARTH = new Color(0x4a3a2a);
const MOSS = new Color(0x3f4a32);
const GRASS = new Color(0x5a6a3a);
const WOOD_DARK = new Color(0x4a3520);
const WOOD = new Color(0x6a4a2a);
const BONE_DARK = new Color(0xb0a488);
const BONE = new Color(0xd8d2c4);

const smooth = (a: number, b: number, x: number): number => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/** A low-poly grave hill: a hemisphere, earth at the skirt, moss mid-slope, grass on the crown. */
function moundGeometry(): BufferGeometry {
  const parts: Part[] = [
    {
      geometry: new SphereGeometry(1, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2),
      color: (_x, y, z) => {
        const t = clamp01(y);
        let c = mix(EARTH, MOSS, smooth(0.05, 0.35, t));
        c = mix(c, GRASS, smooth(0.4, 0.75, t));
        const dapple = 0.92 + 0.16 * hash(_x, y * 0.4, z, 11);
        return [c.r * dapple, c.g * dapple, c.b * dapple];
      },
    },
  ];
  return mergeParts(parts);
}

/** A weathered wooden cross, leaning a few degrees from its base. */
function crossGeometry(): BufferGeometry {
  const vertical = new BoxGeometry(0.16, 2.2, 0.16);
  vertical.translate(0, 1.1, 0);
  const horizontal = new BoxGeometry(1.1, 0.16, 0.16);
  horizontal.translate(0, 1.5, 0);

  const wood = (_x: number, y: number, z: number): Rgb => {
    const c = mix(WOOD_DARK, WOOD, clamp01(y / 2.2));
    const d = 0.9 + 0.2 * hash(_x, y * 0.5, z, 23);
    return [c.r * d, c.g * d, c.b * d];
  };

  const merged = mergeParts([
    { geometry: vertical, color: wood },
    { geometry: horizontal, color: wood },
  ]);
  merged.rotateZ(0.16); // baked lean; the base stays planted, the top tilts
  return merged;
}

/** A skull with a few ribs and finger bones, bone-colored, reads as a scatter of a burial. */
function boneGeometry(): BufferGeometry {
  const parts: Part[] = [];
  const boneColor = (_x: number, y: number, z: number): Rgb => {
    const c = mix(BONE_DARK, BONE, clamp01(y * 1.6));
    const d = 0.9 + 0.2 * hash(_x, y * 0.5, z, 37);
    return [c.r * d, c.g * d, c.b * d];
  };

  const cranium = new SphereGeometry(0.15, 10, 7);
  cranium.scale(1, 0.9, 1);
  cranium.translate(0, 0.16, 0);
  parts.push({ geometry: cranium, color: boneColor });

  const jaw = new BoxGeometry(0.14, 0.07, 0.11);
  jaw.translate(0, 0.04, 0.05);
  parts.push({ geometry: jaw, color: boneColor });

  // Three ribs fanned to the side.
  for (let i = 0; i < 3; i++) {
    const rib = new CylinderGeometry(0.02, 0.02, 0.22, 5);
    rib.rotateZ((i - 1) * 0.5);
    rib.translate(0.24 + i * 0.05, 0.05, -0.05 + i * 0.03);
    parts.push({ geometry: rib, color: boneColor });
  }

  // A couple of finger bones.
  for (let i = 0; i < 2; i++) {
    const finger = new CylinderGeometry(0.012, 0.012, 0.09, 5);
    finger.rotateY(i * 0.8);
    finger.translate(-0.1 + i * 0.1, 0.02, 0.18);
    parts.push({ geometry: finger, color: boneColor });
  }

  return mergeParts(parts);
}

/** One material for all props: flat-shaded low-poly, vertex colors carry the material. */
export function createPropMaterial(): MeshStandardMaterial {
  return new MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.95, metalness: 0 });
}

export function createPropGeometry(kind: 'mound' | 'cross' | 'bone'): BufferGeometry {
  if (kind === 'mound') return moundGeometry();
  if (kind === 'cross') return crossGeometry();
  return boneGeometry();
}
