import { describe, expect, it } from 'vitest';
import { TREE_KINDS } from '@skeleton/shared';
import { TREE_STIFFNESS, createTreeGeometry, treeVariantCount } from '../src/world/trees.ts';

describe('tree geometry wind weight', () => {
  it('bakes a weight that is zero at the root and reaches the kind stiffness at the top', () => {
    for (const kind of TREE_KINDS) {
      for (let variant = 0; variant < treeVariantCount(kind); variant++) {
        const geometry = createTreeGeometry(kind, variant);
        const position = geometry.getAttribute('position');
        const bend = geometry.getAttribute('bend');
        expect(bend, `${kind}/${variant} has no bend weight`).toBeDefined();
        expect(bend.count).toBe(position.count);

        let top = 0;
        for (let i = 0; i < position.count; i++) top = Math.max(top, position.getY(i));
        // The height the chunk builder multiplies by the instance scale must be the real crown height.
        expect(geometry.userData.top as number).toBeCloseTo(top, 6);

        let peak = 0;
        for (let i = 0; i < position.count; i++) {
          const y = position.getY(i);
          const weight = bend.getX(i);
          expect(Number.isFinite(weight)).toBe(true);
          expect(weight).toBeGreaterThanOrEqual(0);
          if (y <= 0) expect(weight, `${kind}/${variant} root moves at y=${y}`).toBe(0);
          peak = Math.max(peak, weight);
        }
        expect(peak).toBeCloseTo(TREE_STIFFNESS[kind], 5);
        geometry.dispose();
      }
    }
  });
});
