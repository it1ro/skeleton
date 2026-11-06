import { Group, type Scene } from 'three/webgpu';
import type { Terrain } from '@skeleton/shared';
import { loadModel } from '../assets/models.ts';

/**
 * Недобудка asleep at her barrow (docs/characters.md). The Meshy model is static: the pose is baked into the mesh,
 * there is no rig and no clips, so the figure only stands where it is put and faces the spawn. The guard's
 * mechanics — sneak up, take the eyes — are not here yet; this is the landmark the first frame looks at.
 *
 * The root is placed and turned immediately, before the file loads, so the spot does not jump when it arrives.
 */
export class Neodobudka {
  readonly root = new Group();
  readonly x: number;
  readonly z: number;

  constructor(terrain: Terrain, scene: Scene, x: number, z: number) {
    this.x = x;
    this.z = z;
    this.root.position.set(x, terrain.heightAt(x, z), z);
    // Face the spawn: the game's forward is -Z, the model is turned inside the root.
    this.root.rotation.y = Math.atan2(x, z);
    scene.add(this.root);

    loadModel('neodobudka').then((model) => {
      if (!model) {
        // A missing file is a build error, not a reason to lose the barrow's landmark silently.
        console.warn('neodobudka: model is missing, the barrow stays empty');
        return;
      }
      // Meshy characters face +Z (Blender's -Y front), the game's forward is -Z; same turn as npc/figure.ts.
      model.scene.rotation.y = Math.PI;
      this.root.add(model.scene);
    });
  }
}
