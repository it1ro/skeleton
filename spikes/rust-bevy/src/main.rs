mod check;
mod chunk;
mod hero;
mod sim;
mod terrain;

use bevy::asset::AssetMetaCheck;
use bevy::diagnostic::{FrameTimeDiagnosticsPlugin, LogDiagnosticsPlugin};
use bevy::input::mouse::{AccumulatedMouseMotion, AccumulatedMouseScroll};
use bevy::prelude::*;

const SEED: u32 = 1337;

fn main() {
    App::new()
        .add_plugins((
            DefaultPlugins
                .set(WindowPlugin {
                    primary_window: Some(Window {
                        canvas: Some("#bevy".into()),
                        fit_canvas_to_parent: true,
                        ..default()
                    }),
                    ..default()
                })
                // No .meta files next to the assets; on the web each check is a 404.
                .set(AssetPlugin {
                    meta_check: AssetMetaCheck::Never,
                    ..default()
                }),
            FrameTimeDiagnosticsPlugin::default(),
            LogDiagnosticsPlugin::default(),
        ))
        .insert_resource(Land(terrain::Terrain::new(SEED)))
        .add_plugins((sim::SimPlugin, hero::HeroPlugin, check::CheckPlugin))
        .add_systems(Startup, setup)
        .add_systems(Update, orbit_camera.after(sim::interpolate))
        .run();
}

#[derive(Resource)]
pub struct Land(pub terrain::Terrain);

/// What the camera looks at.
#[derive(Component)]
struct Focus;

/// Third-person orbit: yaw and pitch from the mouse (right button held), distance from the wheel.
#[derive(Component)]
pub struct OrbitCamera {
    pub yaw: f32,
    pitch: f32,
    distance: f32,
}

fn setup(
    mut commands: Commands,
    world: Res<Land>,
    mut meshes: ResMut<Assets<Mesh>>,
    mut materials: ResMut<Assets<StandardMaterial>>,
) {
    let ground = materials.add(StandardMaterial {
        perceptual_roughness: 0.9,
        ..default()
    });
    // A 2×2 block of chunks so the spawn at the origin is not on an edge.
    for (cx, cz) in [(-1, -1), (0, -1), (-1, 0), (0, 0)] {
        commands.spawn((
            Mesh3d(meshes.add(chunk::chunk_mesh(&world.0, cx, cz))),
            MeshMaterial3d(ground.clone()),
        ));
    }
    commands.spawn((
        Focus,
        sim::Player::spawn(&world.0),
        Transform::default(),
        Visibility::default(),
    ));
    commands.spawn((
        DirectionalLight {
            shadow_maps_enabled: true,
            ..default()
        },
        Transform::from_xyz(4.0, 8.0, 3.0).looking_at(Vec3::ZERO, Vec3::Y),
    ));
    commands.spawn((
        Camera3d::default(),
        OrbitCamera {
            yaw: 0.0,
            pitch: -0.3,
            distance: 6.0,
        },
    ));
}

fn orbit_camera(
    motion: Res<AccumulatedMouseMotion>,
    scroll: Res<AccumulatedMouseScroll>,
    buttons: Res<ButtonInput<MouseButton>>,
    focus: Single<&Transform, (With<Focus>, Without<OrbitCamera>)>,
    camera: Single<(&mut Transform, &mut OrbitCamera)>,
) {
    let (mut transform, mut orbit) = camera.into_inner();
    if buttons.pressed(MouseButton::Right) {
        orbit.yaw -= motion.delta.x * 0.005;
        orbit.pitch = (orbit.pitch - motion.delta.y * 0.005).clamp(-1.4, 0.4);
    }
    orbit.distance = (orbit.distance - scroll.delta.y * 0.5).clamp(2.0, 30.0);
    let rotation = Quat::from_euler(EulerRot::YXZ, orbit.yaw, orbit.pitch, 0.0);
    let target = focus.translation + Vec3::Y * 0.8;
    transform.translation = target + rotation * Vec3::new(0.0, 0.0, orbit.distance);
    transform.look_at(target, Vec3::Y);
}
