//! Hero from player.glb, clips from anims_humanoid.glb (both on the UAL skeleton), clip choice by speed
//! through an AnimationGraph, and greybox body parts parented to UAL bones.

use std::time::Duration;

use bevy::animation::{AnimatedBy, AnimationTargetId};
use bevy::gltf::Gltf;
use bevy::prelude::*;
use bevy::world_serialization::WorldInstanceReady;

use crate::sim::Player;

pub struct HeroPlugin;

impl Plugin for HeroPlugin {
    fn build(&self, app: &mut App) {
        app.add_systems(PostStartup, load)
            .add_systems(Update, (build_graph, pick_clip, toggle_greybox));
    }
}

/// Clip names in anims_humanoid.glb, with the speed (m/s) at which each looped clip has no foot sliding.
/// Same values as SPEEDS in client/src/world/animator.ts.
const CLIPS: [(&str, f32); 5] = [
    ("Idle", 0.0),
    ("Walk", 0.85),
    ("Jog", 4.66),
    ("Sprint", 7.17),
    ("JumpLoop", 0.0),
];
const FADE: Duration = Duration::from_millis(200);

#[derive(Resource)]
struct Anims(Handle<Gltf>);

/// Set on the player once its model is spawned: the entity that plays the clips.
#[derive(Component)]
struct Rig {
    armature: Entity,
}

#[derive(Component)]
struct Clips {
    nodes: Vec<AnimationNodeIndex>,
    current: usize,
}

/// The skinned mesh, hidden while the greybox is on.
#[derive(Component)]
struct Skin;

#[derive(Component)]
struct Greybox;

fn load(mut commands: Commands, assets: Res<AssetServer>, player: Single<Entity, With<Player>>) {
    commands.insert_resource(Anims(assets.load("anims_humanoid.glb")));
    let model = assets.load(GltfAssetLabel::Scene(0).from_asset("player.glb"));
    // The model faces +Z, the sim's facing 0 is -Z.
    let child = commands
        .spawn((
            WorldAssetRoot(model),
            Transform::from_rotation(Quat::from_rotation_y(std::f32::consts::PI)),
        ))
        .observe(on_model_ready)
        .id();
    commands.entity(*player).add_child(child);
}

/// The model file has no clips, so its bones have no animation targets. Give every node under
/// `Armature` the path id the loader gave the clip curves in anims_humanoid.glb, then add the greybox.
fn on_model_ready(
    ready: On<WorldInstanceReady>,
    mut commands: Commands,
    children: Query<&Children>,
    names: Query<&Name>,
    transforms: Query<&Transform>,
    player: Single<Entity, With<Player>>,
    mut meshes: ResMut<Assets<Mesh>>,
    mut materials: ResMut<Assets<StandardMaterial>>,
) {
    let named = |e: Entity, n: &str| names.get(e).is_ok_and(|name| name.as_str() == n);
    let Some(armature) = children
        .iter_descendants(ready.entity)
        .find(|&e| named(e, "Armature"))
    else {
        error!("player.glb: no Armature");
        return;
    };
    let mut stack = vec![(armature, Vec::<Name>::new())];
    while let Some((entity, mut path)) = stack.pop() {
        let Ok(name) = names.get(entity) else {
            continue;
        };
        path.push(name.clone());
        commands.entity(entity).insert((
            AnimationTargetId::from_names(path.iter()),
            AnimatedBy(armature),
        ));
        if name.as_str() == "Hero" {
            commands.entity(entity).insert((Skin, Visibility::Hidden));
        }
        for &child in children.get(entity).into_iter().flatten() {
            stack.push((child, path.clone()));
        }
    }
    commands.entity(*player).insert(Rig { armature });
    info!("model ready");

    // Greybox: a capsule per bone, from its joint to the child joint.
    let bone = |n: &str| children.iter_descendants(armature).find(|&e| named(e, n));
    let skin = materials.add(Color::srgb(0.75, 0.8, 0.7));
    let head = materials.add(Color::srgb(0.7, 0.3, 0.25));
    let limbs = [
        ("upperarm_l", "lowerarm_l"),
        ("lowerarm_l", "hand_l"),
        ("upperarm_r", "lowerarm_r"),
        ("lowerarm_r", "hand_r"),
        ("thigh_l", "calf_l"),
        ("calf_l", "foot_l"),
        ("thigh_r", "calf_r"),
        ("calf_r", "foot_r"),
        ("spine_01", "spine_02"),
        ("spine_02", "spine_03"),
        ("spine_03", "neck_01"),
        ("neck_01", "Head"),
    ];
    for (from, to) in limbs {
        let (Some(b), Some(end)) = (bone(from), bone(to).and_then(|e| transforms.get(e).ok()))
        else {
            warn!("greybox: no bone {from} -> {to}");
            continue;
        };
        let end = end.translation;
        let len = end.length();
        let r = if from.starts_with("spine") {
            0.12
        } else {
            0.06
        };
        commands.entity(b).with_child((
            Greybox,
            Visibility::Visible,
            Mesh3d(meshes.add(Capsule3d::new(r, (len - r).max(0.01)))),
            MeshMaterial3d(skin.clone()),
            Transform::from_translation(end / 2.0)
                .with_rotation(Quat::from_rotation_arc(Vec3::Y, end / len)),
        ));
    }
    if let Some(b) = bone("Head") {
        commands.entity(b).with_child((
            Greybox,
            Visibility::Visible,
            Mesh3d(meshes.add(Cuboid::new(0.22, 0.26, 0.24))),
            MeshMaterial3d(head),
            Transform::from_xyz(0.0, 0.1, 0.0),
        ));
    }
}

/// Builds the graph once the clips are loaded and the rig exists.
fn build_graph(
    mut commands: Commands,
    anims: Res<Anims>,
    gltfs: Res<Assets<Gltf>>,
    mut graphs: ResMut<Assets<AnimationGraph>>,
    rig: Option<Single<(Entity, &Rig), Without<Clips>>>,
) {
    let (Some(rig), Some(gltf)) = (rig, gltfs.get(&anims.0)) else {
        return;
    };
    let (player, rig) = *rig;
    let clips: Option<Vec<_>> = CLIPS
        .iter()
        .map(|(name, _)| gltf.named_animations.get(*name).cloned())
        .collect();
    let Some(clips) = clips else {
        error!("anims_humanoid.glb: missing clips");
        return;
    };
    let (graph, nodes) = AnimationGraph::from_clips(clips);
    let mut anim = AnimationPlayer::default();
    let mut transitions = AnimationTransitions::new();
    transitions
        .play(&mut anim, nodes[0], Duration::ZERO)
        .repeat();
    commands.entity(rig.armature).insert((
        anim,
        transitions,
        AnimationGraphHandle(graphs.add(graph)),
    ));
    commands.entity(player).insert(Clips { nodes, current: 0 });
}

/// Same thresholds as animator.ts: idle below 0.3 m/s, walk below 2.5, jog below 6.8, sprint above.
fn pick_clip(
    player: Option<Single<(&Player, &Rig, &mut Clips)>>,
    mut anims: Query<(&mut AnimationPlayer, &mut AnimationTransitions)>,
) {
    let Some(player) = player else { return };
    let (p, rig, mut clips) = player.into_inner();
    let Ok((mut anim, mut transitions)) = anims.get_mut(rig.armature) else {
        return;
    };
    let speed = p.speed;
    let pick = match speed {
        _ if !p.state.grounded => 4,
        s if s < 0.3 => 0,
        s if s < 2.5 => 1,
        s if s < 6.8 => 2,
        _ => 3,
    };
    if pick != clips.current {
        clips.current = pick;
        transitions
            .play(&mut anim, clips.nodes[pick], FADE)
            .repeat();
    }
    let natural = CLIPS[pick].1;
    let rate = if natural > 0.0 {
        (speed / natural).clamp(0.5, 2.0)
    } else {
        1.0
    };
    if let Some(active) = anim.animation_mut(clips.nodes[pick]) {
        active.set_speed(rate);
    }
}

/// G swaps the greybox parts (shown first) and the skinned model. Both start Visible/Hidden, not
/// Inherited: `toggle_visible_hidden` leaves Inherited as is.
fn toggle_greybox(
    keys: Res<ButtonInput<KeyCode>>,
    mut skin: Query<&mut Visibility, (With<Skin>, Without<Greybox>)>,
    mut parts: Query<&mut Visibility, With<Greybox>>,
) {
    if !keys.just_pressed(KeyCode::KeyG) {
        return;
    }
    for mut v in skin.iter_mut().chain(parts.iter_mut()) {
        v.toggle_visible_hidden();
    }
}
