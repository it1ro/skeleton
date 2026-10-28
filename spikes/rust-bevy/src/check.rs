//! Hands-free checks, native only. `SPIKE_SCRIPT=1` drives the player by a timeline (walk, sprint,
//! jump, stop, greybox on), saves screenshots to shots/, dumps the event log and exits.

use bevy::prelude::*;
use bevy::render::view::screenshot::{Screenshot, save_to_disk};

pub struct CheckPlugin;

impl Plugin for CheckPlugin {
    fn build(&self, app: &mut App) {
        if std::env::var_os("SPIKE_SCRIPT").is_some() {
            app.add_systems(PreUpdate, script.after(bevy::input::InputSystems));
        }
    }
}

/// (seconds, action)
const TIMELINE: [(f32, &str); 10] = [
    (3.0, "shot idle"),
    (3.5, "walk"),
    (5.5, "shot walk"),
    (6.0, "sprint"),
    (8.0, "shot sprint"),
    (8.1, "shot sprint2"),
    (8.2, "jump"),
    (8.4, "shot jump"),
    (9.5, "stop skin"),
    (11.0, "shot skin"),
];

fn script(
    mut commands: Commands,
    time: Res<Time>,
    mut keys: ResMut<ButtonInput<KeyCode>>,
    mut next: Local<usize>,
    mut exit: MessageWriter<AppExit>,
) {
    let t = time.elapsed_secs();
    while let Some(&(at, action)) = TIMELINE.get(*next) {
        if t < at {
            break;
        }
        *next += 1;
        info!("script {t:.2}s: {action}");
        let mut words = action.split(' ');
        match words.next() {
            Some("shot") => {
                let name = words.next().unwrap_or("shot");
                commands
                    .spawn(Screenshot::primary_window())
                    .observe(save_to_disk(format!("shots/{name}.png")));
            }
            Some("walk") => keys.press(KeyCode::KeyW),
            Some("sprint") => keys.press(KeyCode::ShiftLeft),
            Some("jump") => keys.press(KeyCode::Space),
            Some("stop") => {
                keys.release(KeyCode::KeyW);
                keys.release(KeyCode::ShiftLeft);
                keys.press(KeyCode::KeyG);
                keys.press(KeyCode::KeyL);
            }
            _ => {}
        }
    }
    // Taps last one frame.
    if *next > 0 && TIMELINE[*next - 1].0 + 0.1 < t {
        keys.release(KeyCode::Space);
        keys.release(KeyCode::KeyG);
        keys.release(KeyCode::KeyL);
    }
    if *next == TIMELINE.len() && t > 12.0 {
        exit.write(AppExit::Success);
    }
}
