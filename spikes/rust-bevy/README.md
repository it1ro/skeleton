# Spike: Rust + Bevy 0.20

A one-day throwaway test of Bevy as a native stack for the game. Not part of npm workspaces; nothing here is used by the game.

## Run

```bash
npx tsx spikes/rust-bevy/tools/unpack-glb.ts       # once: plain copies of player.glb and anims_humanoid.glb in assets/
cd spikes/rust-bevy
cargo run --features dev                           # native, dynamic linking
SPIKE_SCRIPT=1 cargo run --features dev            # scripted walk/sprint/jump, screenshots in shots/, exits
trunk build --release                              # WASM in dist/ (needs ~16 GB free RAM for fat LTO; built on aio)
```

Controls: WASD, Shift sprint, Space jump, right mouse drag orbit, wheel zoom, G greybox/model, L dump event log.

## Results (2026-10-28)

| Measure | Value | Where |
| --- | --- | --- |
| Cold native build, dynamic_linking | 28 min 37 s, target dir 3.2 GB | tpad, load ~19 |
| Incremental native build | 0.8–1.8 s (up to 6–8 s when a new module is added) | tpad |
| Edit to hero on screen | 1.9–2.0 s (state is lost, no hot reload) | tpad |
| Cold WASM release build (opt-level z, fat LTO) | 8 min 06 s + tool download, 9.5 min total | aio |
| Incremental WASM release build | 4 min 41 s (4:00 cargo + 0:40 wasm-opt) | aio |
| Cold WASM dev build (`trunk build index-dev.html`, no LTO, no wasm-opt) | 9 min 42 s | aio |
| Incremental WASM dev build | 25 s (2.2 s cargo, the rest wasm-bindgen on a 142 MB .wasm) | aio |
| Dev .wasm | 142.6 MB, 21.6 MB gzip; runs at 59–68 fps in headless Chrome | |
| .wasm before wasm-opt | 63.3 MB, 10.8 MB gzip | |
| .wasm after wasm-opt -Oz | 24.0 MB, 7.6 MB gzip | |
| Assets (unpacked glb) | 3.0 MB, 2.3 MB gzip | |
| Native fps, 1263×1383 | 40–50 | tpad UHD 620, Vulkan |
| Web fps, 1280×720 | 65–80 after ~3 s of shader compile at ~1 fps | headless Chrome, WebGL2 via ANGLE/Vulkan, UHD 620 |
| Terrain port vs TS | 14 points, 2 seeds, within 1e-9, not bit-exact | `rustc --test src/terrain.rs` |

## Pitfalls

- Bevy's glTF loader supports none of `EXT_meshopt_compression`, `KHR_mesh_quantization`, `EXT_texture_webp`,
  which the game's files require. `tools/unpack-glb.ts` writes plain copies; player.glb grows from 0.54 to 2.8 MB.
- A model file without clips gets no `AnimationTargetId` on its bones, so clips from anims_humanoid.glb do not bind.
  `hero.rs` adds them by hashing the name path from `Armature`; it breaks if the hierarchy above a bone differs.
- `Visibility::toggle_visible_hidden` does nothing on `Inherited`.
- `Time<Virtual>` clamps long frames, so a stall (first shader compile) silently drops sim ticks.
- Fat LTO for WASM ran out of memory on tpad (16 GB with a browser open).
