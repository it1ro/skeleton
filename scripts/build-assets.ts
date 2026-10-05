/**
 * Builds game-ready .glb files from the Quaternius source packs in assets-src/ (see assets-src/README.md).
 *
 *   npm run assets
 *
 * Output goes to packages/client/src/assets/models/ and is committed, so the packs are needed only to rebuild.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join as joinPath } from 'node:path';
import { NodeIO, type Document, type Node, type Primitive, type Scene } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import {
  compactPrimitive,
  dedup,
  joinPrimitives,
  meshopt,
  mergeDocuments,
  prune,
  resample,
  simplifyPrimitive,
  textureCompress,
  unpartition,
  weld,
} from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';

const SRC = 'assets-src/quaternius';
const OUT = 'packages/client/src/assets/models';
const UBC = `${SRC}/Universal Base Characters[Standard]`;
const OUTFITS = `${SRC}/Modular Character Outfits - Fantasy[Standard]/Exports/glTF (Godot-Unreal)`;
const UAL = `${SRC}/Universal Animation Library[Standard]/Unreal-Godot`;

const PATHS = {
  outfit: `${OUTFITS}/Outfits/Male_Ranger.gltf`,
  base: `${UBC}/Base Characters/Godot - UE/Superhero_Male_FullBody.gltf`,
  beard: `${UBC}/Hairstyles/Rigged to Head Bone/glTF (Godot -Unreal)/Hair_Beard.gltf`,
  anims: `${UAL}/UAL1_Standard.glb`,
  animsRootMotion: `${UAL}/UAL1_Standard_RM.glb`,
};

/** Game name → UAL clip. The client plays clips by the game name (see world/animator.ts). */
const CLIPS: Record<string, string> = {
  Idle: 'Idle_Loop',
  Walk: 'Walk_Loop',
  Jog: 'Jog_Fwd_Loop',
  Sprint: 'Sprint_Loop',
  JumpStart: 'Jump_Start',
  JumpLoop: 'Jump_Loop',
  JumpLand: 'Jump_Land',
  SwimIdle: 'Swim_Idle_Loop',
  Swim: 'Swim_Fwd_Loop',
};

/** Bones that make up the head, used to cut the head out of the full-body base mesh. */
const HEAD_BONES = new Set(['Head', 'neck_01']);
const TEXTURE_SIZE: [number, number] = [1024, 1024];
/** Over-detailed parts of the free pack: share of triangles to keep. */
const SIMPLIFY: Record<string, number> = {
  Male_Ranger_Feet_Boots: 0.25,
  Male_Ranger_Arms_Bracer: 0.4,
};

const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder });

/**
 * Reads a .gltf/.glb. Some pack files point to textures under a wrong name (`T_Hair_1_Normal_png.png`
 * instead of `T_Hair_1_Normal.png`): such links are fixed, and links to absent files are dropped.
 */
async function read(path: string): Promise<Document> {
  if (!path.endsWith('.gltf')) return io.read(path);
  const dir = dirname(path);
  const json = JSON.parse(readFileSync(path, 'utf8')) as { images?: { uri?: string }[]; buffers?: { uri?: string }[] };
  const resources: Record<string, Uint8Array<ArrayBuffer>> = {};
  for (const ref of [...(json.images ?? []), ...(json.buffers ?? [])]) {
    if (!ref.uri || ref.uri.startsWith('data:')) continue;
    const uri = decodeURIComponent(ref.uri);
    const fixed = [uri, uri.replace(/_png\.png$/, '.png')].find((u) => existsSync(joinPath(dir, u)));
    if (!fixed) {
      console.warn(`  ${path}: no ${uri}, texture skipped`);
      delete ref.uri;
      continue;
    }
    ref.uri = fixed;
    resources[fixed] = new Uint8Array(readFileSync(joinPath(dir, fixed)));
  }
  return io.readJSON({ json: json as never, resources });
}

function sceneNodes(scene: Scene): Node[] {
  const nodes: Node[] = [];
  scene.traverse((n) => nodes.push(n));
  return nodes;
}

function findNode(doc: Document, name: string): Node {
  const node = doc.getRoot().listNodes().find((n) => n.getName() === name);
  if (!node) throw new Error(`No node "${name}"`);
  return node;
}

/**
 * Copies skinned meshes from another file of the same rig into `doc`, binds them to the skin of `doc`
 * and drops the rest of the source (its armature, skin, scene).
 */
async function graft(doc: Document, path: string, pick: (node: Node) => boolean): Promise<Node[]> {
  const target = doc.getRoot().listSkins()[0];
  const armature = findNode(doc, 'Armature');
  const src = await read(path);
  const srcJoints = src.getRoot().listSkins()[0].listJoints().map((j) => j.getName());
  const dstJoints = target.listJoints().map((j) => j.getName());
  if (srcJoints.join() !== dstJoints.join()) throw new Error(`${path}: different skeleton`);

  const map = mergeDocuments(doc, src);
  const scene = map.get(src.getRoot().listScenes()[0]) as Scene;
  const moved: Node[] = [];
  for (const node of sceneNodes(scene)) {
    if (node.getMesh() && node.getSkin() && pick(node)) {
      node.setSkin(target);
      armature.addChild(node);
      moved.push(node);
    }
  }
  for (const node of sceneNodes(scene)) if (!moved.includes(node)) node.dispose();
  scene.dispose();
  return moved;
}

/** Keeps only the triangles whose vertices all follow the head bones. */
function keepHead(prim: Primitive, joints: string[]): void {
  const indices = prim.getIndices()!;
  const jointsAttr = prim.getAttribute('JOINTS_0')!;
  const weightsAttr = prim.getAttribute('WEIGHTS_0')!;
  const j = [0, 0, 0, 0];
  const w = [0, 0, 0, 0];
  const isHead = (v: number) => {
    jointsAttr.getElement(v, j);
    weightsAttr.getElement(v, w);
    let best = 0;
    for (let k = 1; k < 4; k++) if (w[k] > w[best]) best = k;
    return HEAD_BONES.has(joints[j[best]]);
  };
  const src = indices.getArray()!;
  const kept: number[] = [];
  for (let i = 0; i < src.length; i += 3) {
    if (isHead(src[i]) && isHead(src[i + 1]) && isHead(src[i + 2])) kept.push(src[i], src[i + 1], src[i + 2]);
  }
  indices.setArray(new Uint32Array(kept));
  compactPrimitive(prim);
}

async function buildPlayer(): Promise<void> {
  const doc = await read(PATHS.outfit);
  const joints = doc.getRoot().listSkins()[0].listJoints().map((n) => n.getName());
  const skinMaterial = doc.getRoot().listMaterials().find((m) => m.getName() === 'MI_Regular_Male');
  if (!skinMaterial) throw new Error('No MI_Regular_Male in the outfit');

  // The free outfit has no head: take it from the full-body base character, plus eyes and eyebrows.
  const [body] = await graft(doc, PATHS.base, (n) => n.getName() === 'SuperHero_Male');
  body.setName('Head');
  for (const prim of body.getMesh()!.listPrimitives()) {
    keepHead(prim, joints);
    prim.setMaterial(skinMaterial); // Same skin texture as the outfit's hands.
  }
  await graft(doc, PATHS.base, (n) => n.getName() === 'Eyes' || n.getName() === 'Eyebrows');
  await graft(doc, PATHS.beard, () => true);

  await doc.transform(weld());
  for (const node of doc.getRoot().listNodes()) {
    const ratio = SIMPLIFY[node.getName()];
    if (!ratio) continue;
    for (const prim of node.getMesh()!.listPrimitives()) {
      simplifyPrimitive(prim, { simplifier: MeshoptSimplifier, ratio, error: 0.002 });
    }
  }

  joinByMaterial(doc);
  await doc.transform(
    prune(),
    dedup(),
    textureCompress({ encoder: sharp, targetFormat: 'webp', resize: TEXTURE_SIZE, quality: 85 }),
    meshopt({ encoder: MeshoptEncoder, level: 'medium' }),
  );
  await write(doc, 'player.glb');
}

/**
 * One mesh per material instead of one per clothing part: ~4 draw calls per character instead of ~15.
 * gltf-transform's join() skips skinned meshes, so this does it for a single-skin character.
 */
function joinByMaterial(doc: Document): void {
  const armature = findNode(doc, 'Armature');
  const skin = doc.getRoot().listSkins()[0];
  const nodes = doc.getRoot().listNodes().filter((n) => n.getMesh() && n.getSkin() === skin);
  const groups = new Map<string, Primitive[]>();
  for (const node of nodes) {
    for (const prim of node.getMesh()!.listPrimitives()) {
      // Only primitives with the same material and the same vertex layout can share a buffer.
      const layout = prim.listSemantics().sort().map((name) => {
        const a = prim.getAttribute(name)!;
        return `${name}:${a.getType()}:${a.getComponentType()}:${a.getNormalized()}`;
      });
      const key = `${prim.getMaterial()!.getName()}|${layout.join()}`;
      groups.set(key, [...(groups.get(key) ?? []), prim]);
    }
  }
  for (const prims of groups.values()) {
    const material = prims[0].getMaterial()!;
    const joined = prims.length > 1 ? joinPrimitives(prims) : prims[0];
    const mesh = doc.createMesh(material.getName()).addPrimitive(joined);
    armature.addChild(doc.createNode(material.getName()).setMesh(mesh).setSkin(skin));
  }
  for (const node of nodes) node.dispose();
}

/** Average speed of the root bone in the root-motion version of a clip, m/s. */
async function measureSpeeds(): Promise<Record<string, number>> {
  const doc = await io.read(PATHS.animsRootMotion);
  const speeds: Record<string, number> = {};
  for (const anim of doc.getRoot().listAnimations()) {
    const channel = anim.listChannels().find((c) => c.getTargetNode()?.getName() === 'root' && c.getTargetPath() === 'translation');
    const sampler = channel?.getSampler();
    if (!sampler) continue;
    const times = sampler.getInput()!.getArray()!;
    const out = sampler.getOutput()!;
    const a = out.getElement(0, [0, 0, 0]);
    const b = out.getElement(out.getCount() - 1, [0, 0, 0]);
    const duration = times[times.length - 1] - times[0];
    speeds[anim.getName()] = duration > 0 ? Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) / duration : 0;
  }
  return speeds;
}

async function buildAnimations(): Promise<void> {
  const doc = await io.read(PATHS.anims);
  const character = await read(PATHS.outfit);
  const restPelvis = findNode(character, 'pelvis').getTranslation();
  const animPelvis = findNode(doc, 'pelvis').getTranslation();
  const offset = restPelvis.map((v, i) => v - animPelvis[i]);

  // Only the armature is needed: the mannequin mesh goes.
  for (const node of doc.getRoot().listNodes()) {
    if (node.getMesh()) node.dispose();
  }
  for (const skin of doc.getRoot().listSkins()) skin.dispose();

  const wanted = new Map(Object.entries(CLIPS).map(([game, ual]) => [ual, game]));
  for (const anim of doc.getRoot().listAnimations()) {
    const game = wanted.get(anim.getName());
    if (!game) {
      // Samplers keep their accessors alive for prune(), so they go explicitly.
      for (const sampler of anim.listSamplers()) sampler.dispose();
      anim.dispose();
      continue;
    }
    anim.setName(game);
    for (const channel of anim.listChannels()) {
      const name = channel.getTargetNode()?.getName();
      const path = channel.getTargetPath();
      if (path === 'scale' || (path === 'translation' && name !== 'pelvis')) {
        // Bone lengths come from the character, not from the mannequin.
        channel.getSampler()?.dispose();
        channel.dispose();
      } else if (path === 'translation') {
        // Mannequin hips are a bit lower than the character's: shift so the feet stay on the ground.
        const out = channel.getSampler()!.getOutput()!;
        const v = [0, 0, 0];
        for (let i = 0; i < out.getCount(); i++) {
          out.getElement(i, v);
          out.setElement(i, [v[0] + offset[0], v[1] + offset[1], v[2] + offset[2]]);
        }
      }
    }
  }
  const missing = Object.values(CLIPS).filter((ual) => !doc.getRoot().listAnimations().some((a) => a.getName() === wanted.get(ual)));
  if (missing.length) throw new Error(`Missing clips: ${missing.join(', ')}`);

  await doc.transform(
    resample(),
    prune({ keepLeaves: true }),
    dedup(),
    meshopt({ encoder: MeshoptEncoder, level: 'medium' }),
  );
  await write(doc, 'anims_humanoid.glb');

  const speeds = await measureSpeeds();
  console.log('Clip speeds from root motion, m/s (for SPEEDS in world/animator.ts):');
  for (const [game, ual] of Object.entries(CLIPS)) {
    if (speeds[ual]) console.log(`  ${game.padEnd(10)} ${speeds[ual].toFixed(2)}`);
  }
}

async function write(doc: Document, name: string): Promise<void> {
  await doc.transform(unpartition()); // Merged files bring their own buffers; a .glb holds one.
  const path = joinPath(OUT, name);
  await io.write(path, doc);
  const bytes = (await io.writeBinary(doc)).byteLength;
  console.log(`${path}: ${(bytes / 1024).toFixed(0)} KB`);
}

for (const p of Object.values(PATHS)) {
  if (!existsSync(p)) {
    console.error(`Missing ${p}\nDownload the Quaternius packs first: see assets-src/README.md`);
    process.exit(1);
  }
}
await Promise.all([MeshoptEncoder.ready, MeshoptSimplifier.ready]);
await buildPlayer();
await buildAnimations();
