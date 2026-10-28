/**
 * Bevy 0.20 cannot read EXT_meshopt_compression, KHR_mesh_quantization or EXT_texture_webp,
 * which the game's .glb files require. This writes plain copies into assets/:
 * decoded buffers, float vertex attributes, PNG textures.
 *
 *   npx tsx spikes/rust-bevy/tools/unpack-glb.ts
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dequantize, textureCompress } from '@gltf-transform/functions';
import { MeshoptDecoder } from 'meshoptimizer';
import sharp from 'sharp';

const SRC = new URL('../../../packages/client/src/assets/models/', import.meta.url);
const OUT = new URL('../assets/', import.meta.url);

await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });

for (const name of ['player.glb', 'anims_humanoid.glb']) {
  const doc = await io.read(new URL(name, SRC).pathname);
  await doc.transform(dequantize(), textureCompress({ encoder: sharp, targetFormat: 'png' }));
  for (const ext of doc.getRoot().listExtensionsUsed()) ext.dispose();
  await io.write(new URL(name, OUT).pathname, doc);
  console.log(name, 'ok');
}
