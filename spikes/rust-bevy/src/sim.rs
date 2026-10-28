//! Movement at a fixed 30 Hz (port of stepPlayer from shared/src/movement.ts, no swimming),
//! render interpolation between ticks, and an in-memory event log dumped as JSON.

use bevy::prelude::*;
use serde::Serialize;

use crate::OrbitCamera;
use crate::terrain::Terrain;

pub const TICK_RATE: f64 = 30.0;
const WALK_SPEED: f64 = 5.0;
const SPRINT_SPEED: f64 = 8.5;
const JUMP_SPEED: f64 = 8.0;
const GRAVITY: f64 = 25.0;
const MAX_CLIMB: f64 = 1.2;

pub struct SimPlugin;

impl Plugin for SimPlugin {
    fn build(&self, app: &mut App) {
        app.insert_resource(Time::<Fixed>::from_hz(TICK_RATE))
            .init_resource::<Tick>()
            .init_resource::<Intent>()
            .init_resource::<EventLog>()
            .add_systems(FixedUpdate, step)
            .add_systems(Update, (read_input, interpolate, dump_log));
    }
}

#[derive(Resource, Default)]
pub struct Tick(pub u64);

#[derive(Clone, Copy, Default)]
pub struct PlayerState {
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub vy: f64,
    pub grounded: bool,
}

/// Sim state of the player: current tick and the one before, for interpolation.
#[derive(Component)]
pub struct Player {
    pub state: PlayerState,
    pub prev: PlayerState,
    /// Horizontal speed over the last tick, m/s. Drives the animation.
    pub speed: f32,
    pub facing: f32,
}

impl Player {
    pub fn spawn(terrain: &Terrain) -> Self {
        let state = PlayerState {
            y: terrain.height_at(0.0, 0.0),
            grounded: true,
            ..default()
        };
        Self {
            state,
            prev: state,
            speed: 0.0,
            facing: 0.0,
        }
    }
}

/// Input collected each frame, consumed by the next tick. Jump is latched so a short press is not lost.
#[derive(Resource, Default)]
struct Intent {
    forward: f64,
    right: f64,
    yaw: f64,
    sprint: bool,
    jump: bool,
}

#[derive(Serialize)]
struct LogEvent {
    tick: u64,
    kind: &'static str,
    x: f64,
    y: f64,
    z: f64,
}

#[derive(Resource, Default, Serialize)]
struct EventLog {
    events: Vec<LogEvent>,
}

fn read_input(
    keys: Res<ButtonInput<KeyCode>>,
    camera: Single<&OrbitCamera>,
    mut intent: ResMut<Intent>,
) {
    let axis = |pos: KeyCode, neg: KeyCode| {
        keys.pressed(pos) as i32 as f64 - keys.pressed(neg) as i32 as f64
    };
    intent.forward = axis(KeyCode::KeyW, KeyCode::KeyS);
    intent.right = axis(KeyCode::KeyD, KeyCode::KeyA);
    intent.yaw = camera.yaw as f64;
    intent.sprint = keys.pressed(KeyCode::ShiftLeft);
    intent.jump |= keys.just_pressed(KeyCode::Space);
}

fn step(
    terrain: Res<crate::Land>,
    mut tick: ResMut<Tick>,
    mut intent: ResMut<Intent>,
    mut log: ResMut<EventLog>,
    mut player: Single<&mut Player>,
) {
    tick.0 += 1;
    let p = &mut *player;
    p.prev = p.state;
    let jumped = step_player(&mut p.state, &intent, 1.0 / TICK_RATE, &terrain.0);
    intent.jump = false;
    let (dx, dz) = (p.state.x - p.prev.x, p.state.z - p.prev.z);
    p.speed = (dx.hypot(dz) * TICK_RATE) as f32;
    if p.speed > 0.1 {
        // The model faces -Z at facing 0, like yaw.
        p.facing = (-dx).atan2(-dz) as f32;
    }
    if tick.0 % 15 == 0 && std::env::var_os("SPIKE_SCRIPT").is_some() {
        info!(
            "tick {} z {:.2} speed {:.2} grounded {} fwd {} sprint {}",
            tick.0, p.state.z, p.speed, p.state.grounded, intent.forward, intent.sprint
        );
    }
    if jumped {
        let s = p.state;
        log.events.push(LogEvent {
            tick: tick.0,
            kind: "jump",
            x: s.x,
            y: s.y,
            z: s.z,
        });
    }
}

/// stepPlayer from movement.ts without water. Returns true on a jump.
fn step_player(s: &mut PlayerState, input: &Intent, dt: f64, terrain: &Terrain) -> bool {
    let (mut fwd, mut right) = (input.forward, input.right);
    let len = fwd.hypot(right);
    if len > 1.0 {
        fwd /= len;
        right /= len;
    }
    let ground = terrain.height_at(s.x, s.z);
    let speed = if input.sprint {
        SPRINT_SPEED
    } else {
        WALK_SPEED
    };
    let (sin, cos) = input.yaw.sin_cos();
    let dx = (-sin * fwd + cos * right) * speed * dt;
    let dz = (-cos * fwd - sin * right) * speed * dt;
    let next_ground = terrain.height_at(s.x + dx, s.z + dz);
    let step = dx.hypot(dz);
    let too_steep = s.grounded && step > 0.0 && (next_ground - ground) / step > MAX_CLIMB;
    if !too_steep {
        s.x += dx;
        s.z += dz;
    }
    let jumped = input.jump && s.grounded;
    if jumped {
        s.vy = JUMP_SPEED;
        s.grounded = false;
    }
    s.vy -= GRAVITY * dt;
    s.y += s.vy * dt;
    let floor = terrain.height_at(s.x, s.z);
    if s.y <= floor {
        s.y = floor;
        s.vy = 0.0;
        s.grounded = true;
    } else if s.grounded && s.vy <= 0.0 && s.y - floor < 0.6 {
        s.y = floor;
        s.vy = 0.0;
    } else {
        s.grounded = false;
    }
    jumped
}

/// Render position between the last two ticks.
pub fn interpolate(time: Res<Time<Fixed>>, player: Single<(&Player, &mut Transform)>) {
    let (p, mut transform) = player.into_inner();
    let a = time.overstep_fraction_f64();
    let lerp = |from: f64, to: f64| (from + (to - from) * a) as f32;
    transform.translation = Vec3::new(
        lerp(p.prev.x, p.state.x),
        lerp(p.prev.y, p.state.y),
        lerp(p.prev.z, p.state.z),
    );
    let target = Quat::from_rotation_y(p.facing);
    transform.rotation = transform.rotation.slerp(target, 0.2);
}

/// L dumps the log as JSON: to the console, and to events.json natively.
fn dump_log(keys: Res<ButtonInput<KeyCode>>, log: Res<EventLog>) {
    if !keys.just_pressed(KeyCode::KeyL) {
        return;
    }
    let json = serde_json::to_string_pretty(&*log).expect("log serializes");
    info!("event log:\n{json}");
    #[cfg(not(target_arch = "wasm32"))]
    if let Err(e) = std::fs::write("events.json", &json) {
        warn!("events.json: {e}");
    }
}
