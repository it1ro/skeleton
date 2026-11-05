/**
 * Builds game-ready characters from the models Meshy rigged and animated itself.
 *
 *   npm run assets:rig
 *
 * The sources are `assets-src/meshy/rigged_m.glb` and `rigged_f.glb`: Meshy exports made with the UE5 Mannequin
 * skeleton template, one file per character, each with the clips added in the Meshy animation library. Unlike
 * `build-assets.ts`, nothing is skinned here: the mesh arrives bound to its own skeleton, so the build only cleans
 * the file up for the game. Output goes to packages/client/src/assets/models/ and is committed.
 */
import { existsSync } from 'node:fs';
import { join as joinPath } from 'node:path';
import {
  NodeIO,
  type Animation,
  type AnimationChannel,
  type Document,
  type Node,
} from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import {
  dedup,
  meshopt,
  prune,
  textureCompress,
  transformPrimitive,
  unpartition,
} from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import sharp from 'sharp';
import { Matrix4, Quaternion, Vector3 } from 'three';

const OUT = 'packages/client/src/assets/models';
const TEXTURE_SIZE: [number, number] = [1024, 1024];

/** A game clip cut out of a Meshy library action. */
interface Clip {
  /** Action name in Meshy, as it comes in the exported file. */
  source: string;
  /** Seconds to cut out of it; the whole action by default. */
  from?: number;
  to?: number;
  /** Keep the pelvis on the spot: forward travel is the game's job, not the clip's. */
  still?: boolean;
  /** Keep the pelvis at the standing height: the height of a jump is the game's job too. */
  level?: boolean;
}

interface Character {
  /** Suffix of the built file: `m` gives `player_rig_m.glb`. */
  id: string;
  /** For logs and errors. */
  title: string;
  source: string;
  /**
   * Uniform scale of the rig. Meshy rigs a character at the height given in the rig dialog, and the default is
   * 1.70; the male skeleton is designed at 1.80, so his whole file is scaled up.
   */
  scale: number;
  /** Game clip name → where it comes from. The client plays clips by the game name (world/animator.ts). */
  clips: Record<string, Clip>;
}

/**
 * The Meshy actions `Regular_Jump` carries three phases the game wants apart: the crouch and the push, the pose in
 * the air, and the landing. Seconds are picked on the pelvis height curve, the same in both files.
 */
const JUMP_START = { from: 0, to: 0.45 } as const;
const JUMP_LOOP = { from: 0.63, to: 0.9, still: true, level: true } as const;
const JUMP_LAND = { from: 1.05, to: 1.5 } as const;

/** What both characters have in common: the same actions, except the idle and the walk they differ in. */
const SHARED: Record<string, Clip> = {
  Jog: { source: 'Running' },
  Sprint: { source: 'RunFast' },
  JumpStart: { source: 'Regular_Jump', ...JUMP_START },
  JumpLoop: { source: 'Regular_Jump', ...JUMP_LOOP },
  JumpLand: { source: 'Regular_Jump', ...JUMP_LAND },
  SwimIdle: { source: 'Swim_Idle' },
  Swim: { source: 'Swim_Forward', still: true },
  Sneak: { source: 'Sneaky_Walk_inplace' },
  Crouch: { source: 'Cautious_Crouch_Walk_Forward_inplace' },
};

const MALE: Character = {
  id: 'm',
  title: 'male skeleton',
  source: 'assets-src/meshy/rigged_m.glb',
  scale: 1.8 / 1.7,
  clips: {
    Idle: { source: 'Idle_11' },
    Walk: { source: 'Walking' },
    ...SHARED,
  },
};

const FEMALE: Character = {
  id: 'f',
  title: 'female skeleton',
  source: 'assets-src/meshy/rigged_f.glb',
  scale: 1,
  clips: {
    // She has a walk of her own and a long idle; the rest is the same set.
    Idle: { source: 'Idle_4' },
    Walk: { source: 'Walking_Woman' },
    ...SHARED,
  },
};

const CHARACTERS = [MALE, FEMALE];

const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder });

/** The matrix type glTF Transform takes from its own matrix library, which the repo does not depend on. */
type Matrix4Array = Parameters<typeof transformPrimitive>[1];

/** A node's transform relative to its parent, and the chain of them up to the scene root. */
function localMatrix(node: Node): Matrix4 {
  return new Matrix4().compose(
    new Vector3().fromArray(node.getTranslation()),
    new Quaternion().fromArray(node.getRotation()),
    new Vector3().fromArray(node.getScale()),
  );
}

function worldMatrix(node: Node): Matrix4 {
  const chain: Node[] = [];
  for (let n: Node | null = node; n; n = n.getParentNode()) chain.unshift(n);
  return chain.reduce((matrix, n) => matrix.multiply(localMatrix(n)), new Matrix4());
}

/**
 * Scales the whole character at once: vertices, bone lengths and bind matrices. Meshy rigs at the height given in
 * the rig dialog, and the default is 1.70; the male skeleton is designed at 1.80.
 *
 * A scale on the armature node would be shorter to write, but three.js binds skinned meshes with an identity bind
 * matrix and multiplies the mesh's own world matrix on top, so a scaled armature would count twice.
 */
function scaleRig(doc: Document, factor: number): void {
  if (factor === 1) return;
  const root = doc.getRoot();
  const matrix = new Matrix4().makeScale(factor, factor, factor).toArray() as unknown as Matrix4Array;
  for (const mesh of root.listMeshes()) for (const prim of mesh.listPrimitives()) transformPrimitive(prim, matrix);
  for (const node of root.listNodes()) {
    const [x, y, z] = node.getTranslation();
    node.setTranslation([x * factor, y * factor, z * factor]);
  }
  // Bone lengths changed, so the bind matrices no longer describe the rest pose.
  const skin = root.listSkins()[0];
  const bind = skin.getInverseBindMatrices()!;
  skin.listJoints().forEach((joint, i) => bind.setElement(i, worldMatrix(joint).invert().toArray()));
  // The pelvis rides in the clips. Every other translation channel is dropped later, on the way into the game.
  for (const anim of root.listAnimations()) {
    for (const channel of anim.listChannels()) {
      if (channel.getTargetPath() !== 'translation') continue;
      const out = channel.getSampler()!.getOutput()!;
      const v = [0, 0, 0];
      for (let i = 0; i < out.getCount(); i++) {
        out.getElement(i, v);
        out.setElement(i, v.map((x) => x * factor));
      }
    }
  }
}

/** The game's bone names are UAL's; Meshy's UE5 template writes the head in lower case. */
function renameBones(doc: Document): void {
  const head = doc.getRoot().listNodes().find((n) => n.getName() === 'head');
  head?.setName('Head');
}

/**
 * Squares every bone with the game: rotations all the way down, a pelvis position, nothing else. Meshy writes
 * translation and scale for all 66 joints on every frame, which is most of the file.
 */
function trimChannels(anim: Animation): void {
  for (const channel of anim.listChannels()) {
    const path = channel.getTargetPath();
    const name = channel.getTargetNode()?.getName();
    if (path === 'scale' || (path === 'translation' && name !== 'pelvis')) {
      // Samplers keep their accessors alive for prune(), so they go explicitly.
      channel.getSampler()?.dispose();
      channel.dispose();
    }
  }
}

function pelvisChannel(anim: Animation): AnimationChannel | undefined {
  return anim
    .listChannels()
    .find((c) => c.getTargetPath() === 'translation' && c.getTargetNode()?.getName() === 'pelvis');
}

/** Reads the pelvis position of the first frame of an action: the height a standing character has. */
function pelvisStart(anim: Animation): [number, number, number] {
  const channel = pelvisChannel(anim);
  if (!channel) throw new Error(`${anim.getName()}: no pelvis translation`);
  const out = channel.getSampler()!.getOutput()!;
  return out.getElement(0, [0, 0, 0]) as [number, number, number];
}

/** Cuts `[from, to]` seconds out of an action into a new one, times rebased to zero. */
function slice(doc: Document, source: Animation, name: string, { from = 0, to = Infinity }: Clip): Animation {
  const root = doc.getRoot();
  const buffer = root.listBuffers()[0];
  const anim = doc.createAnimation(name);
  for (const channel of source.listChannels()) {
    const sampler = channel.getSampler()!;
    const times = sampler.getInput()!.getArray()!;
    const keys: number[] = [];
    for (let i = 0; i < times.length; i++) if (times[i] >= from - 1e-6 && times[i] <= to + 1e-6) keys.push(i);
    if (keys.length < 2) throw new Error(`${name}: no keys in [${from}, ${to}]`);
    const out = sampler.getOutput()!;
    const size = out.getElementSize();
    const data = out.getArray()!;
    const newTimes = new Float32Array(keys.length);
    const newData = new Float32Array(keys.length * size);
    keys.forEach((key, k) => {
      newTimes[k] = times[key] - times[keys[0]];
      for (let c = 0; c < size; c++) newData[k * size + c] = data[key * size + c];
    });
    const input = doc.createAccessor().setType('SCALAR').setArray(newTimes).setBuffer(buffer);
    const output = doc.createAccessor().setType(out.getType()).setArray(newData).setBuffer(buffer);
    const sliced = doc.createAnimationSampler().setInput(input).setOutput(output).setInterpolation(sampler.getInterpolation());
    anim.addSampler(sliced).addChannel(
      doc
        .createAnimationChannel()
        .setTargetNode(channel.getTargetNode()!)
        .setTargetPath(channel.getTargetPath()!)
        .setSampler(sliced),
    );
  }
  return anim;
}

/** Pins the pelvis where the game expects it: on the spot, at the standing height, or both. */
function pinPelvis(anim: Animation, { still, level }: Clip, standing: [number, number, number]): void {
  if (!still && !level) return;
  const out = pelvisChannel(anim)!.getSampler()!.getOutput()!;
  const v = [0, 0, 0];
  out.getElement(0, v);
  const [x, , z] = v;
  for (let i = 0; i < out.getCount(); i++) {
    out.getElement(i, v);
    if (still) {
      v[0] = x;
      v[2] = z;
    }
    if (level) v[1] = standing[1];
    out.setElement(i, v);
  }
}

async function build(character: Character): Promise<void> {
  const doc = await io.read(character.source);
  const root = doc.getRoot();
  renameBones(doc);

  scaleRig(doc, character.scale);

  const sources = new Map(root.listAnimations().map((a) => [a.getName(), a]));
  const built: Animation[] = [];
  for (const [name, clip] of Object.entries(character.clips)) {
    const source = sources.get(clip.source);
    if (!source) throw new Error(`${character.title}: no action "${clip.source}" for clip "${name}"`);
    const standing = pelvisStart(source);
    const anim = slice(doc, source, name, clip);
    trimChannels(anim);
    pinPelvis(anim, clip, standing);
    built.push(anim);
  }
  for (const source of sources.values()) {
    for (const sampler of source.listSamplers()) sampler.dispose();
    source.dispose();
  }

  // Meshy's textures are PBR: a normal map and a metal-roughness map on top of the colour. The game's style is
  // matte and flat, and one map is a third of the file.
  for (const material of root.listMaterials()) {
    material.setMetallicFactor(0).setRoughnessFactor(0.9).setMetallicRoughnessTexture(null).setNormalTexture(null);
  }

  // Measured before the export: meshopt quantizes positions, and the accessors then hold packed integers.
  let bottom = Infinity;
  let top = -Infinity;
  for (const node of root.listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION')!;
      bottom = Math.min(bottom, pos.getMin([])[1]);
      top = Math.max(top, pos.getMax([])[1]);
    }
  }

  await doc.transform(
    prune(),
    dedup(),
    textureCompress({ encoder: sharp, targetFormat: 'webp', resize: TEXTURE_SIZE, quality: 85 }),
    meshopt({ encoder: MeshoptEncoder, level: 'medium' }),
  );
  await write(doc, `player_rig_${character.id}.glb`);

  console.log(`${character.title}: ${built.length} clips, height ${(top - bottom).toFixed(2)} m`);
  for (const anim of built) {
    console.log(`  ${anim.getName().padEnd(10)} ${lastKey(anim).toFixed(2)} s`);
  }
}

/** Length of a clip in seconds. */
function lastKey(anim: Animation): number {
  let end = 0;
  for (const sampler of anim.listSamplers()) end = Math.max(end, sampler.getInput()!.getMax([])[0]);
  return end;
}

async function write(doc: Document, name: string): Promise<void> {
  await doc.transform(unpartition());
  const path = joinPath(OUT, name);
  await io.write(path, doc);
  const bytes = (await io.writeBinary(doc)).byteLength;
  console.log(`${path}: ${(bytes / 1024).toFixed(0)} KB`);
}

for (const character of CHARACTERS) {
  if (!existsSync(character.source)) {
    console.error(`Missing ${character.source}\nGet the sources first: see assets-src/README.md`);
    process.exit(1);
  }
}
await MeshoptEncoder.ready;
for (const character of CHARACTERS) await build(character);
