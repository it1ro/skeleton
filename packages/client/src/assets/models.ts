import type { AnimationClip, Object3D } from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone } from 'three/addons/utils/SkeletonUtils.js';

/**
 * Models from Blender: drop `<name>.glb` into `src/assets/models/` (see docs/assets.md).
 * Vite finds them at build time, so a missing model is no 404, just the placeholder.
 */
const urls = import.meta.glob<string>('./models/*.glb', { query: '?url', import: 'default', eager: true });

export interface Model {
  scene: Object3D;
  animations: AnimationClip[];
}

const loader = new GLTFLoader();
const cache = new Map<string, Promise<Model>>();

export function hasModel(name: string): boolean {
  return `./models/${name}.glb` in urls;
}

/** A fresh copy of the model (skinned meshes included), or null if there is no such file. */
export async function loadModel(name: string): Promise<Model | null> {
  const url = urls[`./models/${name}.glb`];
  if (!url) return null;
  let pending = cache.get(name);
  if (!pending) {
    pending = loader.loadAsync(url).then((gltf) => ({ scene: gltf.scene as Object3D, animations: gltf.animations as AnimationClip[] }));
    cache.set(name, pending);
  }
  const model = await pending;
  const scene = clone(model.scene as never) as unknown as Object3D;
  scene.traverse((o) => {
    o.castShadow = true;
    o.receiveShadow = true;
  });
  return { scene, animations: model.animations };
}
