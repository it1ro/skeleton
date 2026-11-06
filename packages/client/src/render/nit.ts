/**
 * The нить (мера): a cold, glowing thread that leads the eye to the landmark. This is a placeholder for the
 * real thread — an unlit additive tube, so it reads as the one glowing thing in the gray first frame.
 */

import {
  AdditiveBlending,
  CatmullRomCurve3,
  Color,
  Group,
  Mesh,
  MeshBasicMaterial,
  TubeGeometry,
  Vector3,
} from 'three/webgpu';

const NIT_COLOR = new Color(0xa8d8e8);

/**
 * A short glowing thread from the origin toward a world-space XZ target. The group is meant to be positioned
 * at the spawn and its first point sits just above the ground, so the thread runs over the earth toward the
 * landmark (a mound and its cross).
 */
export function createNit(tx: number, tz: number): Group {
  const group = new Group();
  const len = Math.hypot(tx, tz) || 1;
  const dir = new Vector3(tx / len, 0, tz / len);
  const perp = new Vector3(-dir.z, 0, dir.x);
  const up = new Vector3(0, 1, 0);

  const points = [
    new Vector3(0, 0.12, 0),
    dir.clone().multiplyScalar(1.4).add(perp.clone().multiplyScalar(0.5)).add(up.clone().multiplyScalar(0.16)),
    dir.clone().multiplyScalar(2.7).add(perp.clone().multiplyScalar(-0.45)).add(up.clone().multiplyScalar(0.3)),
    dir.clone().multiplyScalar(4.2).add(up.clone().multiplyScalar(0.42)),
  ];

  const geometry = new TubeGeometry(new CatmullRomCurve3(points), 32, 0.02, 6, false);
  const material = new MeshBasicMaterial({
    color: NIT_COLOR,
    blending: AdditiveBlending,
    transparent: true,
    opacity: 0.95,
    depthWrite: false,
    fog: false,
  });
  const thread = new Mesh(geometry, material);
  thread.frustumCulled = false;
  group.add(thread);
  return group;
}
