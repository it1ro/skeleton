/**
 * How far a vertex at height `y` moves when the tree bends, as a share of the crown's sway.
 *
 * The weight is zero at and below the root, so the trunk can never slide over the ground: a tree bends
 * from its base, it does not travel. Above the root it grows with height squared, the shape of a
 * cantilever, and `stiffness` lets the kinds differ without a second material: a birch whips, a spruce
 * holds, a dead trunk barely moves.
 *
 * This is deliberately a pure function of the geometry's own height, never of the world height: the
 * shader receives world-space positions after instancing, and using those made sway grow with terrain
 * elevation (trees on a 38 m hill dragged their roots 3.6 m across the ground).
 */
export function bendWeight(y: number, top: number, stiffness: number): number {
  if (!(top > 0) || !(stiffness > 0)) return 0;
  const t = y <= 0 ? 0 : y >= top ? 1 : y / top;
  return t * t * stiffness;
}
