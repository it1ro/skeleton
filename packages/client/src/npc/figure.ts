import {
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  SphereGeometry,
  Vector3,
  type PerspectiveCamera,
  type Scene,
} from 'three/webgpu';
import type { Terrain } from '@skeleton/shared';

/**
 * A greybox Повитуха: half bone, half cloth, hunched over a staff. No model yet, but enough
 * silhouette to find her at the spawn and tell her apart from a player.
 */
export class PovituhaFigure {
  readonly root = new Group();
  readonly x: number;
  readonly z: number;
  private readonly label = document.createElement('div');

  constructor(terrain: Terrain, scene: Scene, x: number, z: number) {
    this.x = x;
    this.z = z;

    const cloth = new MeshStandardMaterial({ color: 0x3b332a, roughness: 1 });
    const pale = new MeshStandardMaterial({ color: 0xc9bda3, roughness: 0.95 });
    const bone = new MeshStandardMaterial({ color: 0xd9d3c2, roughness: 0.6 });
    const scarf = new MeshStandardMaterial({ color: 0x6d3b32, roughness: 1 });
    const wood = new MeshStandardMaterial({ color: 0x4a3524, roughness: 1 });

    const body = new Mesh(new CylinderGeometry(0.27, 0.42, 1.08, 10), cloth);
    body.position.y = 0.56;
    body.rotation.x = 0.1;

    const head = new Mesh(new SphereGeometry(0.21, 12, 10), pale);
    head.position.set(0.02, 1.3, -0.04);

    const kerchief = new Mesh(new SphereGeometry(0.24, 12, 10), scarf);
    kerchief.position.set(0, 1.36, 0.04);
    kerchief.scale.set(1, 0.85, 1);

    this.root.add(body, head, kerchief);

    for (const side of [-1, 1]) {
      const arm = new Mesh(new CylinderGeometry(0.055, 0.06, 0.72, 6), cloth);
      arm.position.set(side * 0.3, 0.95, 0);
      arm.rotation.z = side * 0.35;
      arm.rotation.x = 0.2;
      this.root.add(arm);
    }

    const skirt = new Mesh(new CylinderGeometry(0.075, 0.09, 0.55, 6), cloth);
    skirt.position.set(0.14, 0.3, 0);
    const shin = new Mesh(new CylinderGeometry(0.045, 0.05, 0.62, 6), bone);
    shin.position.set(-0.14, 0.32, 0);
    const staff = new Mesh(new CylinderGeometry(0.028, 0.035, 1.72, 6), wood);
    staff.position.set(-0.48, 0.84, 0.02);
    staff.rotation.z = 0.1;
    this.root.add(skirt, shin, staff);

    this.root.traverse((object) => {
      if (object instanceof Mesh) object.castShadow = true;
    });
    this.root.position.set(x, terrain.heightAt(x, z), z);
    // Face the spawn: the model's forward is -Z.
    this.root.rotation.y = Math.atan2(x, z);
    scene.add(this.root);

    this.label.textContent = 'Повитуха';
    document.getElementById('labels')!.append(this.label);
  }

  distanceTo(x: number, z: number): number {
    return Math.hypot(this.x - x, this.z - z);
  }

  updateLabel(camera: PerspectiveCamera, width: number, height: number): void {
    const p = new Vector3(0, 2.15, 0).add(this.root.position).project(camera);
    const visible = p.z < 1 && Math.abs(p.x) < 1.1 && Math.abs(p.y) < 1.1;
    this.label.style.display = visible ? '' : 'none';
    if (visible) {
      this.label.style.left = `${((p.x + 1) / 2) * width}px`;
      this.label.style.top = `${((1 - p.y) / 2) * height}px`;
    }
  }
}
