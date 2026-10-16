import type { AnimationClip, Object3D } from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { clone } from 'three/addons/utils/SkeletonUtils.js';

/**
 * Models: `<name>.glb` in `src/assets/models/` (see docs/assets.md). Vite finds them at build time,
 * so a missing model is no 404, just null and the placeholder.
 */
const urls = import.meta.glob<string>('./models/*.glb', { query: '?url', import: 'default', eager: true });

export interface Model {
  scene: Object3D;
  animations: AnimationClip[];
}

const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
const cache = new Map<string, Promise<Model>>();

function load(name: string): Promise<Model> | null {
  const url = urls[`./models/${name}.glb`];
  if (!url) return null;
  let pending = cache.get(name);
  if (!pending) {
    pending = loader.loadAsync(url).then((gltf) => ({ scene: gltf.scene as Object3D, animations: gltf.animations as AnimationClip[] }));
    cache.set(name, pending);
  }
  return pending;
}

/** Starts loading the files. Resolves when they are in memory or failed; a failure shows up again on use. */
export async function preload(...names: string[]): Promise<void> {
  await Promise.allSettled(names.map((name) => load(name)));
}

/** A fresh copy of the model (skinned meshes included), or null if there is no such file. */
export async function loadModel(name: string): Promise<Model | null> {
  const model = await load(name);
  if (!model) return null;
  const scene = clone(model.scene as never) as unknown as Object3D;
  scene.traverse((o) => {
    o.castShadow = true;
    o.receiveShadow = true;
  });
  return { scene, animations: model.animations };
}

/** Clips from an animation-only file. Clips are shared: they bind to bones by name. */
export async function loadAnimations(name: string): Promise<AnimationClip[]> {
  return (await load(name))?.animations ?? [];
}
