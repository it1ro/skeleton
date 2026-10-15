/**
 * Builds game-ready .glb files from the sources in assets-src/ (see assets-src/README.md).
 *
 *   npm run assets
 *
 * Output goes to packages/client/src/assets/models/ and is committed, so the sources are needed only to rebuild.
 */
import { existsSync } from 'node:fs';
import { join as joinPath } from 'node:path';
import { NodeIO, type Document, type Node, type Primitive, type Scene, type vec3 } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, meshopt, mergeDocuments, prune, resample, textureCompress, unpartition } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import sharp from 'sharp';
import { Matrix4, Vector3 } from 'three';

const OUT = 'packages/client/src/assets/models';
const UAL = 'assets-src/quaternius/Universal Animation Library[Standard]/Unreal-Godot';

const PATHS = {
  hero: 'assets-src/meshy/skeleton.glb',
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

/**
 * Joints of the hero mesh in T-pose, metres, glTF axes (+Y up, +Z forward, +X the hero's left). Measured on the
 * mesh; the right side mirrors the left. The mannequin's joints move here and keep their rotations, so the clips
 * still fit. Joints not listed (fingers, toe tips) move with their parent.
 */
const HERO_JOINTS: Record<string, vec3> = {
  pelvis: [0, 0.795, -0.06],
  spine_01: [0, 0.98, -0.05],
  spine_02: [0, 1.12, -0.06],
  spine_03: [0, 1.27, -0.07],
  neck_01: [0, 1.43, -0.06],
  Head: [0, 1.53, -0.03],
  clavicle_l: [0.02, 1.41, -0.04],
  upperarm_l: [0.2, 1.383, -0.067],
  lowerarm_l: [0.51, 1.383, -0.067],
  hand_l: [0.72, 1.383, -0.067],
  thigh_l: [0.105, 0.81, -0.06],
  calf_l: [0.125, 0.43, -0.07],
  foot_l: [0.135, 0.1, -0.08],
  ball_l: [0.135, 0.02, 0.03],
};

/**
 * Bones that carry the hero's vertices, each with the joint where its segment ends (null: straight up).
 * A vertex follows the nearest segment. Fingers stay with the hand: the mesh has them held together.
 */
const SEGMENTS: Record<string, string | null> = {
  pelvis: 'spine_01',
  spine_01: 'spine_02',
  spine_02: 'spine_03',
  spine_03: 'neck_01',
  neck_01: 'Head',
  Head: null,
  clavicle_l: 'upperarm_l',
  upperarm_l: 'lowerarm_l',
  lowerarm_l: 'hand_l',
  hand_l: 'middle_04_leaf_l',
  thigh_l: 'calf_l',
  calf_l: 'foot_l',
  foot_l: 'ball_l',
  ball_l: 'ball_leaf_l',
};
const ARM_BONES = new Set(['upperarm', 'lowerarm', 'hand']);
const LEG_BONES = new Set(['thigh', 'calf', 'foot', 'ball']);
/** Distance over which a vertex is shared between two bones, m. Bones are rigid: keep it small. */
const BLEND = 0.01;
const TEXTURE_SIZE: [number, number] = [1024, 1024];

const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder });

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

/** Left-side table plus its mirror: `_l` names become `_r` with X negated. */
function mirrored<T>(table: Record<string, T>, flip: (value: T) => T): Map<string, T> {
  const out = new Map<string, T>();
  for (const [name, value] of Object.entries(table)) {
    out.set(name, value);
    if (name.endsWith('_l')) out.set(name.replace(/_l$/, '_r'), flip(value));
  }
  return out;
}

function worldPosition(node: Node): Vector3 {
  return new Vector3().setFromMatrixPosition(new Matrix4().fromArray(node.getWorldMatrix()));
}

/** Moves the mannequin's joints to the hero's, parents first, and rebinds the skin there. */
function fitJoints(doc: Document): void {
  const skin = doc.getRoot().listSkins()[0];
  const joints = skin.listJoints();
  const targets = mirrored(HERO_JOINTS, ([x, y, z]): vec3 => [-x, y, z]);
  const depth = (n: Node): number => (n.getParentNode() ? depth(n.getParentNode()!) + 1 : 0);
  for (const joint of [...joints].sort((a, b) => depth(a) - depth(b))) {
    const target = targets.get(joint.getName());
    if (!target) continue;
    const parent = new Matrix4().fromArray(joint.getParentNode()!.getWorldMatrix());
    const local = new Vector3(...target).applyMatrix4(parent.invert());
    joint.setTranslation(local.toArray());
  }
  const ibm = skin.getInverseBindMatrices()!;
  joints.forEach((joint, i) => ibm.setElement(i, new Matrix4().fromArray(joint.getWorldMatrix()).invert().toArray()));
}

function segmentDistance(p: Vector3, a: Vector3, b: Vector3): number {
  const ab = b.clone().sub(a);
  const t = Math.max(0, Math.min(1, p.clone().sub(a).dot(ab) / ab.lengthSq()));
  return p.distanceTo(a.clone().addScaledVector(ab, t));
}

/**
 * Gives each vertex up to four bones, by distance to their segments. Limbs take only vertices on their own side
 * and beyond the shoulder or below the hip, so ribs do not follow the arms and the pelvis does not follow a leg.
 */
function skinPrimitive(doc: Document, prim: Primitive): void {
  const skin = doc.getRoot().listSkins()[0];
  const joints = skin.listJoints();
  const index = new Map(joints.map((j, i) => [j.getName(), i]));
  const at = (name: string) => worldPosition(joints[index.get(name)!]);
  const bones = [...mirrored(SEGMENTS, (end) => end?.replace(/_l$/, '_r') ?? null)].map(([name, end]) => {
    const a = at(name);
    const b = end ? at(end) : a.clone().add(new Vector3(0, 0.25, 0));
    const side = name.endsWith('_l') ? 1 : name.endsWith('_r') ? -1 : 0;
    const kind = name.replace(/_[lr]$/, '');
    return { joint: index.get(name)!, a, b, side, arm: ARM_BONES.has(kind), leg: LEG_BONES.has(kind) };
  });
  const shoulderX = at('upperarm_l').x;
  const hip = at('thigh_l');

  const pos = prim.getAttribute('POSITION')!;
  const count = pos.getCount();
  const jointsOut = new Uint8Array(count * 4);
  const weightsOut = new Float32Array(count * 4);
  const p = new Vector3();
  const v = [0, 0, 0];
  for (let i = 0; i < count; i++) {
    p.fromArray(pos.getElement(i, v));
    const sideOk = (side: number) => side === 0 || p.x * side > -0.01;
    const near = bones
      .filter((b) => sideOk(b.side))
      .filter((b) => !b.arm || Math.abs(p.x) >= shoulderX)
      .filter((b) => !b.leg || (p.y < hip.y && (p.y < hip.y - 0.1 || Math.abs(p.x) > hip.x / 2)))
      .map((b) => ({ joint: b.joint, d: segmentDistance(p, b.a, b.b) }))
      .sort((x, y) => x.d - y.d)
      .slice(0, 4);
    const w = near.map((n) => Math.exp(-(n.d - near[0].d) / BLEND));
    const sum = w.reduce((s, x) => s + x, 0);
    near.forEach((n, k) => {
      jointsOut[i * 4 + k] = n.joint;
      weightsOut[i * 4 + k] = w[k] / sum;
    });
  }
  const buffer = doc.getRoot().listBuffers()[0];
  prim.setAttribute('JOINTS_0', doc.createAccessor().setType('VEC4').setArray(jointsOut).setBuffer(buffer));
  prim.setAttribute('WEIGHTS_0', doc.createAccessor().setType('VEC4').setArray(weightsOut).setBuffer(buffer));
}

/** What the clips need to know about the hero: its rest pelvis and how long its legs are next to the mannequin's. */
interface HeroRig {
  pelvis: vec3;
  legScale: number;
}

/** The Meshy mesh on the UAL mannequin's armature. */
async function buildPlayer(): Promise<HeroRig> {
  const doc = await io.read(PATHS.anims);
  for (const anim of doc.getRoot().listAnimations()) {
    for (const sampler of anim.listSamplers()) sampler.dispose();
    anim.dispose();
  }
  for (const node of doc.getRoot().listNodes()) if (node.getMesh()) node.dispose();
  const mannequinHip = worldPosition(findNode(doc, 'thigh_l')).y;
  fitJoints(doc);

  const hero = await io.read(PATHS.hero);
  const scene = mergeDocuments(doc, hero).get(hero.getRoot().listScenes()[0]) as Scene;
  const armature = findNode(doc, 'Armature');
  const skin = doc.getRoot().listSkins()[0];
  for (const node of sceneNodes(scene)) {
    if (!node.getMesh()) continue;
    if (!new Matrix4().fromArray(node.getWorldMatrix()).equals(new Matrix4())) throw new Error(`${PATHS.hero}: ${node.getName()} is moved, apply transforms`);
    for (const prim of node.getMesh()!.listPrimitives()) skinPrimitive(doc, prim);
    node.setSkin(skin).setName('Hero');
    armature.addChild(node);
  }
  for (const node of sceneNodes(scene)) node.dispose();
  scene.dispose();

  // Meshy bakes a metal-roughness map; the game's style is matte and flat.
  for (const material of doc.getRoot().listMaterials()) {
    material.setMetallicFactor(0).setRoughnessFactor(0.9).setMetallicRoughnessTexture(null);
  }

  await doc.transform(
    prune(),
    dedup(),
    textureCompress({ encoder: sharp, targetFormat: 'webp', resize: TEXTURE_SIZE, quality: 85 }),
    meshopt({ encoder: MeshoptEncoder, level: 'medium' }),
  );
  await write(doc, 'player.glb');
  return {
    pelvis: findNode(doc, 'pelvis').getTranslation(),
    legScale: worldPosition(findNode(doc, 'thigh_l')).y / mannequinHip,
  };
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

async function buildAnimations(hero: HeroRig): Promise<void> {
  const doc = await io.read(PATHS.anims);
  const animPelvis = findNode(doc, 'pelvis').getTranslation();

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
        // Hips move as on the mannequin, scaled to the hero's legs, so the feet stay on the ground.
        const out = channel.getSampler()!.getOutput()!;
        const v = [0, 0, 0];
        for (let i = 0; i < out.getCount(); i++) {
          out.getElement(i, v);
          out.setElement(i, v.map((x, k) => hero.pelvis[k] + (x - animPelvis[k]) * hero.legScale));
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

  // Shorter legs take shorter steps: the clip's speed scales with them.
  const speeds = await measureSpeeds();
  console.log('Clip speeds for the hero, m/s (for SPEEDS in world/animator.ts):');
  for (const [game, ual] of Object.entries(CLIPS)) {
    if (speeds[ual]) console.log(`  ${game.padEnd(10)} ${(speeds[ual] * hero.legScale).toFixed(2)}`);
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
    console.error(`Missing ${p}\nGet the sources first: see assets-src/README.md`);
    process.exit(1);
  }
}
await MeshoptEncoder.ready;
await buildAnimations(await buildPlayer());
