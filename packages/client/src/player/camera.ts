import type { PerspectiveCamera } from 'three/webgpu';
import type { Terrain } from '@skeleton/shared';
import type { Input } from './input.ts';

const SENSITIVITY = 0.0025;
const EYE_HEIGHT = 1.6;
const MIN_DISTANCE = 2.5;
const MAX_DISTANCE = 16;

/** Third-person orbit camera that does not dip under the ground. */
export class OrbitCamera {
  yaw = 0;
  pitch = -0.25;
  distance = 6;

  constructor(
    private readonly camera: PerspectiveCamera,
    private readonly terrain: Terrain,
  ) {}

  update(input: Input, x: number, y: number, z: number): void {
    this.yaw -= input.lookX * SENSITIVITY;
    this.pitch = Math.max(-1.3, Math.min(0.9, this.pitch - input.lookY * SENSITIVITY));
    this.distance = Math.max(MIN_DISTANCE, Math.min(MAX_DISTANCE, this.distance * (1 + input.zoom * 0.1)));

    const tx = x;
    const ty = y + EYE_HEIGHT;
    const tz = z;
    const horizontal = Math.cos(this.pitch) * this.distance;
    let cx = tx + Math.sin(this.yaw) * horizontal;
    let cy = ty - Math.sin(this.pitch) * this.distance;
    let cz = tz + Math.cos(this.yaw) * horizontal;
    const floor = this.terrain.heightAt(cx, cz) + 0.4;
    if (cy < floor) cy = floor;

    this.camera.position.set(cx, cy, cz);
    this.camera.lookAt(tx, ty, tz);
  }
}
