import {
  Color,
  InstancedMesh,
  Matrix4,
  Quaternion,
  Vector3,
  type BufferGeometry,
  type Material,
} from 'three/webgpu';

const _matrix = new Matrix4();
const _quaternion = new Quaternion();
const _position = new Vector3();
const _scale = new Vector3();
const _up = new Vector3(0, 1, 0);
const _white = new Color(1, 1, 1);

/**
 * Composes a world-space instance matrix (translation, Y-rotation, non-uniform scale) into `out` at
 * instance `at`. `scaleXZ` sizes the footprint, `scaleY` the height, so a tree can be tall and thin
 * or short and wide without a second geometry.
 */
export function composeInstance(
  out: Float32Array,
  at: number,
  x: number,
  y: number,
  z: number,
  rotation: number,
  scaleXZ: number,
  scaleY: number = scaleXZ,
): void {
  _position.set(x, y, z);
  _quaternion.setFromAxisAngle(_up, rotation);
  _scale.set(scaleXZ, scaleY, scaleXZ);
  _matrix.compose(_position, _quaternion, _scale);
  out.set(_matrix.elements, at * 16);
}

/** Precomposed instance data for one pool range: a matrix block and, for colored types, a color block. */
export interface PoolBlock {
  /** 16 floats per instance. */
  matrix: Float32Array;
  /** 3 floats per instance; `null` when the material has no per-instance color. */
  color: Float32Array | null;
}

/**
 * One preallocated `InstancedMesh` that owns a fixed-size instance buffer and is written in place.
 * Appends upload only the new range; removal rewrites the whole buffer. Never created or disposed
 * per tile/chunk, so the GPU instance buffer stays allocated for the lifetime of the world.
 */
export class InstancedPool {
  readonly mesh: InstancedMesh;
  readonly matrix: Float32Array;
  readonly color: Float32Array | null;
  private used = 0;

  constructor(geometry: BufferGeometry, material: Material, capacity: number, colored: boolean) {
    this.mesh = new InstancedMesh(geometry, material, capacity);
    this.matrix = this.mesh.instanceMatrix.array as Float32Array;
    if (colored) {
      // Allocates `instanceColor` sized to `capacity` (via instanceMatrix.count).
      this.mesh.setColorAt(0, _white);
      this.color = this.mesh.instanceColor!.array as Float32Array;
    } else {
      this.color = null;
    }
    // One mesh spans the whole world; per-instance frustum culling is not worth it here.
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
  }

  /** Number of active instances (== drawn instance count). */
  get count(): number {
    return this.used;
  }

  /** Appends precomposed data and schedules a partial GPU upload for just the new range. */
  append(block: PoolBlock): void {
    const instances = block.matrix.length / 16;
    if (instances === 0) return;
    const start = this.used;
    this.matrix.set(block.matrix, start * 16);
    if (this.color && block.color) this.color.set(block.color, start * 3);
    this.used += instances;
    this.mesh.count = this.used;
    this.mesh.instanceMatrix.addUpdateRange(start * 16, instances * 16);
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.color) {
      this.mesh.instanceColor!.addUpdateRange(start * 3, instances * 3);
      this.mesh.instanceColor!.needsUpdate = true;
    }
  }

  /** Rewrites the whole buffer from an ordered list of blocks and schedules a full GPU upload. */
  rewrite(blocks: PoolBlock[]): void {
    let used = 0;
    for (const block of blocks) {
      const instances = block.matrix.length / 16;
      this.matrix.set(block.matrix, used * 16);
      if (this.color && block.color) this.color.set(block.color, used * 3);
      used += instances;
    }
    this.used = used;
    this.mesh.count = used;
    this.mesh.instanceMatrix.clearUpdateRanges();
    this.mesh.instanceMatrix.addUpdateRange(0, used * 16);
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.color) {
      this.mesh.instanceColor!.clearUpdateRanges();
      this.mesh.instanceColor!.addUpdateRange(0, used * 3);
      this.mesh.instanceColor!.needsUpdate = true;
    }
  }
}
