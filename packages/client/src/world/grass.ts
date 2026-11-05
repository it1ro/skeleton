import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
} from 'three/webgpu';
import { hash3, mulberry32, type Terrain } from '@skeleton/shared';
import { recordHitch } from '../bench/hitches.ts';

/** Square grass tile in meters. The field covers a ring of tiles around the player and follows them. */
const TILE = 16;
/** Tiles from the center in each direction: 7 tiles is a 112 m radius. Beyond it the ground texture takes over. */
const RADIUS = 7;
const GRASS_STEP = 0.5;
const GRASS_KEEP = 0.55;
const FLOWER_STEP = 1.6;
const FLOWER_KEEP = 0.65;

interface Tile {
  group: Group;
  grass: InstancedMesh | null;
  flowers: InstancedMesh | null;
}

const key = (tx: number, tz: number) => `${tx},${tz}`;

/**
 * A tuft of crossed tapered quads with vertex colors. No texture and no alpha: the blades are solid,
 * so there is no sorting and no alpha-test overdraw. Five blades read as a clump from any direction.
 */
function tuftGeometry(blades: number, height: number, width: number): BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const base = new Color(0x2d5522);
  const tip = new Color(0x9ac455);
  const topScale = 0.2;

  for (let b = 0; b < blades; b++) {
    const angle = (b / blades) * Math.PI;
    const dx = Math.cos(angle);
    const dz = Math.sin(angle);
    const px = -dz;
    const pz = dx;
    const h = height * (0.8 + 0.35 * (b % 3));
    const lean = 0.15;
    const start = positions.length / 3;
    const points: [number, number, number][] = [
      [-px * width, 0, -pz * width],
      [px * width, 0, pz * width],
      [dx * lean - px * width * topScale, h, dz * lean - pz * width * topScale],
      [dx * lean + px * width * topScale, h, dz * lean + pz * width * topScale],
    ];
    points.forEach(([x, y, z], index) => {
      positions.push(x, y, z);
      normals.push(0, 1, 0);
      const color = index < 2 ? base : tip;
      colors.push(color.r, color.g, color.b);
    });
    indices.push(start, start + 1, start + 2, start + 2, start + 1, start + 3);
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3));
  geometry.setAttribute('color', new BufferAttribute(new Float32Array(colors), 3));
  geometry.setIndex(indices);
  return geometry;
}

/** A flower is a thin stem and a flat bloom, so it reads as a dot of color instead of a colored cone. */
function flowerMeshGeometry(): BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const stem = new Color(0x4a6b2a);
  const petal = new Color(0xffffff);
  const height = 0.18;
  const stemWidth = 0.008;
  const bloom = 0.05;

  const stemPoints: [number, number, number][] = [
    [-stemWidth, 0, 0],
    [stemWidth, 0, 0],
    [-stemWidth * 0.7, height, 0],
    [stemWidth * 0.7, height, 0],
  ];
  for (const [x, y, z] of stemPoints) {
    positions.push(x, y, z);
    normals.push(0, 1, 0);
    colors.push(stem.r, stem.g, stem.b);
  }
  indices.push(0, 1, 2, 2, 1, 3);

  const bloomPoints: [number, number, number][] = [
    [-bloom, height, -bloom],
    [bloom, height, -bloom],
    [-bloom, height, bloom],
    [bloom, height, bloom],
  ];
  for (const [x, y, z] of bloomPoints) {
    positions.push(x, y, z);
    normals.push(0, 1, 0);
    colors.push(petal.r, petal.g, petal.b);
  }
  indices.push(4, 6, 5, 6, 7, 5);

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3));
  geometry.setAttribute('color', new BufferAttribute(new Float32Array(colors), 3));
  geometry.setIndex(indices);
  return geometry;
}

/** Grass and flowers in a ring around the player. Kept out of the terrain chunks: the field moves independently. */
export class GrassField {
  readonly root = new Group();
  private readonly tiles = new Map<string, Tile>();
  private readonly grassGeometry = tuftGeometry(5, 0.45, 0.03);
  private readonly flowerGeometry = flowerMeshGeometry();
  private readonly grassMaterial = new MeshStandardMaterial({ vertexColors: true, roughness: 0.95 });
  private readonly flowerMaterial = new MeshStandardMaterial({ vertexColors: true, roughness: 0.9 });
  private readonly flowerPalette = [new Color(0xffe07a), new Color(0xf4f1e0), new Color(0x9aa8ff), new Color(0xe89cb4)];
  private center = { tx: Number.NaN, tz: Number.NaN };

  constructor(
    private readonly terrain: Terrain,
    private readonly seed: number,
  ) {}

  get tileCount(): number {
    return this.tiles.size;
  }

  update(x: number, z: number): void {
    const tx = Math.floor(x / TILE);
    const tz = Math.floor(z / TILE);
    if (tx === this.center.tx && tz === this.center.tz) return;
    this.center = { tx, tz };

    const wanted = new Set<string>();
    for (let dz = -RADIUS; dz <= RADIUS; dz++) {
      for (let dx = -RADIUS; dx <= RADIUS; dx++) {
        if (dx * dx + dz * dz > (RADIUS + 0.5) ** 2) continue;
        wanted.add(key(tx + dx, tz + dz));
      }
    }
    for (const [k, tile] of this.tiles) {
      if (wanted.has(k)) continue;
      this.root.remove(tile.group);
      tile.grass?.dispose();
      tile.flowers?.dispose();
      this.tiles.delete(k);
    }
    for (const k of wanted) {
      if (this.tiles.has(k)) continue;
      const [x0, z0] = k.split(',').map(Number);
      const tile = this.buildTile(x0, z0);
      this.tiles.set(k, tile);
      this.root.add(tile.group);
    }
  }

  private buildTile(tx: number, tz: number): Tile {
    const startedAt = performance.now();
    const ox = tx * TILE;
    const oz = tz * TILE;
    const group = new Group();
    group.position.set(ox, 0, oz);

    const rnd = mulberry32(hash3(tx, tz, this.seed ^ 0x51ed270b));
    const grass: number[] = [];
    const count = Math.ceil(TILE / GRASS_STEP);
    for (let j = 0; j < count; j++) {
      for (let i = 0; i < count; i++) {
        const x = ox + (i + rnd()) * GRASS_STEP;
        const z = oz + (j + rnd()) * GRASS_STEP;
        if (rnd() > GRASS_KEEP) continue;
        if (this.terrain.biomeAt(x, z) !== 'meadows') continue;
        grass.push(x - ox, this.terrain.heightAt(x, z), z - oz, rnd() * Math.PI * 2, 0.7 + rnd() * 1.0, rnd());
      }
    }

    const flowerRnd = mulberry32(hash3(tx, tz, this.seed ^ 0x2f6a88d1));
    const flowers: number[] = [];
    const flowerCount = Math.ceil(TILE / FLOWER_STEP);
    for (let j = 0; j < flowerCount; j++) {
      for (let i = 0; i < flowerCount; i++) {
        const x = ox + (i + flowerRnd()) * FLOWER_STEP;
        const z = oz + (j + flowerRnd()) * FLOWER_STEP;
        if (flowerRnd() > FLOWER_KEEP) continue;
        if (Math.sin(x * 0.11) + Math.cos(z * 0.09) < 0.2) continue;
        if (this.terrain.biomeAt(x, z) !== 'meadows') continue;
        flowers.push(x - ox, this.terrain.heightAt(x, z), z - oz, flowerRnd() * Math.PI * 2, 1 + flowerRnd() * 0.6, flowerRnd());
      }
    }

    const grassMesh = this.makeInstanced(this.grassGeometry, this.grassMaterial, grass, (shade, out) =>
      out.setRGB(0.7 + shade * 0.45, 0.8 + shade * 0.3, 0.45 + shade * 0.3),
    );
    const flowersMesh = flowers.length
      ? this.makeInstanced(this.flowerGeometry, this.flowerMaterial, flowers, (shade, out) =>
          out.copy(this.flowerPalette[Math.min(this.flowerPalette.length - 1, Math.floor(shade * this.flowerPalette.length))]),
        )
      : null;
    if (grassMesh) group.add(grassMesh);
    if (flowersMesh) group.add(flowersMesh);
    recordHitch('grass', startedAt);
    return { group, grass: grassMesh, flowers: flowersMesh };
  }

  private makeInstanced(
    geometry: BufferGeometry,
    material: MeshStandardMaterial,
    data: number[],
    tint: (shade: number, out: Color) => void,
  ): InstancedMesh | null {
    const stride = 6;
    const count = data.length / stride;
    if (count === 0) return null;
    const mesh = new InstancedMesh(geometry, material, count);
    const position = new Vector3();
    const quaternion = new Quaternion();
    const scale = new Vector3();
    const up = new Vector3(0, 1, 0);
    const matrix = new Matrix4();
    const color = new Color();
    for (let i = 0; i < count; i++) {
      const at = i * stride;
      position.set(data[at], data[at + 1], data[at + 2]);
      quaternion.setFromAxisAngle(up, data[at + 3]);
      scale.setScalar(data[at + 4]);
      matrix.compose(position, quaternion, scale);
      mesh.setMatrixAt(i, matrix);
      tint(data[at + 5], color);
      mesh.setColorAt(i, color);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.receiveShadow = true;
    mesh.computeBoundingSphere();
    return mesh;
  }
}
