//! One 64×64 m heightmap chunk around the origin, 2 m quads, colored by height.

use bevy::asset::RenderAssetUsages;
use bevy::mesh::{Indices, PrimitiveTopology};
use bevy::prelude::*;

use crate::terrain::Terrain;

pub const CHUNK_SIZE: f32 = 64.0;
const SEGMENTS: u32 = 32;

pub fn chunk_mesh(terrain: &Terrain, cx: i32, cz: i32) -> Mesh {
    let n = SEGMENTS + 1;
    let step = CHUNK_SIZE / SEGMENTS as f32;
    let mut positions = Vec::with_capacity((n * n) as usize);
    let mut colors = Vec::with_capacity((n * n) as usize);
    for j in 0..n {
        for i in 0..n {
            let x = cx as f32 * CHUNK_SIZE + i as f32 * step;
            let z = cz as f32 * CHUNK_SIZE + j as f32 * step;
            let y = terrain.height_at(x as f64, z as f64) as f32;
            positions.push([x, y, z]);
            let t = ((y - 2.0) / 20.0).clamp(0.0, 1.0);
            colors.push(
                LinearRgba::from(Color::srgb(0.25 + 0.3 * t, 0.5 - 0.1 * t, 0.2 + 0.2 * t))
                    .to_f32_array(),
            );
        }
    }
    let mut indices = Vec::with_capacity((SEGMENTS * SEGMENTS * 6) as usize);
    for j in 0..SEGMENTS {
        for i in 0..SEGMENTS {
            let a = j * n + i;
            let (b, c, d) = (a + 1, a + n, a + n + 1);
            indices.extend([a, c, b, b, c, d]);
        }
    }
    Mesh::new(
        PrimitiveTopology::TriangleList,
        RenderAssetUsages::RENDER_WORLD,
    )
    .with_inserted_attribute(Mesh::ATTRIBUTE_POSITION, positions)
    .with_inserted_attribute(Mesh::ATTRIBUTE_COLOR, colors)
    .with_inserted_indices(Indices::U32(indices))
    .with_computed_smooth_normals()
}
