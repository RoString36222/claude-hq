//! Strikezone for the Valley (g = "strike"): a team FPS for up to 8, two sides
//! of 2-4 players each, with server-driven bots filling the side that is short.
//! A port of `backend/app/strike.py` plus the strike branch of
//! `backend/app/valley.py`, on the same tick and budgets as Blaster Arena
//! (`fps.rs`), with its own hub so each game keeps its own lobby.
//!
//! Each human runs and aims in the browser (games/strike.js) and streams where
//! they are; the server runs a 20 Hz tick that checks every move, judges every
//! shot, keeps the score and sends the lobby one batched snapshot per tick.
//! Shots are judged with the same lag compensation as Blaster Arena (see
//! `fps.rs` for the full description); the only difference is that a shot never
//! hits a team-mate.
//!
//! Teams: players are split amber (0) / cyan (1). The host picks the side size
//! (2-4) at start; both sides are filled with bots until each has that many,
//! and a bot leaves first when a human takes its place. A team scores when any
//! of its members makes a kill; the round ends at the score limit, at the time,
//! or when one side has no active members left.
//!
//! Bots: a bot is a player in the match vector like any other, flagged in the
//! snapshot (flags bit 16); the client draws it exactly like a human. Every
//! tick the referee thinks for each bot: pick a goal (a living enemy when one
//! is in sight, else a waypoint of the patrol graph), walk there with the same
//! step() physics the clients use, and fire through its own adjudication (no
//! rewind is needed - the bot is on the server). Bots never send network
//! frames and never have clocks of their own.
//!
//! Arenas live in `backend/data/strike_map*.json`, embedded at build time with
//! `include_str!` -- byte copies of games/strike/map.json and
//! games/strike/map-sandbar.json. The host picks which one the match runs on
//! (default "dockyard"); every geometry call uses that map.
//!
//! Units on the wire: x, y, z in centimetres, yaw and pitch in hundredths of a
//! degree, the sender's clock in centiseconds (q).
//!
//! Protocol: in `{"type":"game","g":"strike","op":...}`, out
//! `{"type":"game","g":"strike","ev":...}`. Ops: join, leave, invite, view,
//! char, start, end, pos, fire, reload, weapon. Events: lobby, strike, char,
//! go, snap, fix, ammo, kill, spawn, pick, item, gone, done, invite, invited,
//! error.

// target_at and a few constants are the shared geometry the tests drive (and
// the browser's practice range uses); the hub runtime is exercised through
// main.rs, which the test target does not compile -- hence the wide allow.
#![allow(dead_code)]

use crate::kart::{Lobby, Out, To};
use crate::realtime::{Clock, Registry, Ticker};
use crate::results::Recorder;
use crate::rooms::{Member, RoomManager};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::sync::{Arc, LazyLock, Mutex};

// --- movement (shared with games/strike.js) ---
pub const R: f64 = 0.35;
pub const H: f64 = 1.8;
pub const EYE: f64 = 1.6;
pub const STEP_H: f64 = 0.55;
pub const RUN: f64 = 6.0;
pub const SPRINT: f64 = 1.35;
/// Sprint stamina constants (client-side; the referee only watches raw speed).
pub const STAMINA_MAX: f64 = 100.0;
pub const STAMINA_DRAIN: f64 = 12.5;
pub const STAMINA_REGEN: f64 = 14.0;
pub const SPRINT_SLOW: f64 = 0.015;
/// v4: parachute drops — a spawn may lift the player and they glide down (`drop` hint)
pub const DROP_HEIGHT: f64 = 11.0;
pub const DROP_TIME: f64 = 3.0;
pub const DROP_SINK: f64 = 2.8;
pub const DROP_DRIFT: f64 = 4.5;
pub const ACCEL: f64 = 12.0;
pub const AIR_ACCEL: f64 = 3.0;
pub const GRAVITY: f64 = 18.0;
pub const JUMP_V: f64 = 6.5;
pub const FALL_MAX: f64 = 25.0;
// the movement totems' multipliers (shared with games/strike.js FS)
pub const LEAP_MULT: f64 = 3.0;   // the leap totem: Space-bar jumps this much taller
pub const SPEED_MULT: f64 = 2.0;  // the speed totem: plain WASD at this multiple of sprint pace

// --- weapons (shared with games/strike.js) ---
pub struct Weapon {
    #[allow(dead_code)] // kept in step with games/strike.js weapon ids
    pub id: &'static str,
    pub interval: f64,
    pub damage: i64,
    pub head: i64,
    pub mag: i64,
    pub reserve: i64,
    pub reload: f64,
    pub spread: f64,
    pub range: f64,
    pub pack: i64,
}
// The Arena serves all four, launcher included: its rocket is a real missile the
// server flies in tick() (ROCKETS) and resolves as a blast (blast_damage), matching
// the browser's solo simulation (FS.MISSILE_V & co in games/strike.js).
pub const NW: usize = 4;
pub const WEAPONS: [Weapon; NW] = [
    Weapon { id: "rapid", interval: 0.1, damage: 12, head: 18, mag: 30, reserve: 90, reload: 1.6, spread: 1.2,
             range: 60.0, pack: 60 },
    Weapon { id: "marksman", interval: 0.8, damage: 75, head: 112, mag: 5, reserve: 15, reload: 2.2, spread: 0.3,
             range: 120.0, pack: 10 },
    Weapon { id: "revolver", interval: 0.5, damage: 50, head: 75, mag: 6, reserve: 24, reload: 2.2, spread: 0.5,
             range: 70.0, pack: 12 },
    Weapon { id: "launcher", interval: 1.2, damage: 120, head: 120, mag: 1, reserve: 5, reload: 2.5, spread: 0.0,
             range: 60.0, pack: 2 },
];
// --- the launcher's rocket (shared with games/strike.js) ---
pub const MISSILE_V: f64 = 22.0;   // launch speed (m/s)
pub const MISSILE_G: f64 = 6.0;    // gravity on the rocket (gentler than a body)
pub const MISSILE_TTL: f64 = 3.5;  // s before it fizzles mid-air
pub const BLAST_R: f64 = 4.0;      // splash radius, falloff 75 -> 25
pub const DIRECT_R: f64 = 0.8;     // inside this, a direct hit (120)

/// Splash damage by distance from the explosion (mirrors FS.blastDamage).
pub fn blast_damage(dist: f64, direct: bool) -> i64 {
    if direct {
        return 120;
    }
    if dist >= BLAST_R {
        return 0;
    }
    (75.0 - (75.0 - 25.0) * (dist / BLAST_R)).round() as i64
}
/// Proximity crush for disaster marks (Meteor / Thunder / Quake): the blast you stand
/// under is the one that hurts. Twin: markDamage in games/strike.js.
pub fn mark_damage(dist: f64, r: f64, dmg: i64) -> i64 {
    let r = if r > 0.0 { r } else { 1.0 };
    let u = (dist.max(0.0) / r).min(1.0);
    let (near, min) = (DD_NEAR_R, DD_NEAR_MIN);
    let k = if u <= near {
        1.0
    } else {
        min + (1.0 - min) * (1.0 - (u - near) / (1.0 - near))
    };
    ((dmg as f64 * k).round() as i64).max(1)
}
pub const SWITCH: f64 = 0.25;
pub const HP: i64 = 100;
pub const HEAL: i64 = 50;
pub const BODY_R: f64 = 0.4;
pub const BODY_H: f64 = 1.4;
pub const HEAD_R: f64 = 0.25;
pub const HEAD_TOP: f64 = 1.9;

// --- referee ---
pub const HZ: f64 = 20.0;
pub const MAX_SPEED: f64 = 7.5;
pub const SLACK: f64 = 1.0;
pub const SPRINT_MAX_SPEED: f64 = 10.5;
pub const SHRINK: f64 = 0.05;
pub const MAX_AIR: f64 = 2.0;
pub const CLOCK_LEAD: f64 = 0.6;
pub const POS_RATE: f64 = 25.0;
pub const POS_BURST: f64 = 10.0;
pub const FIRE_RATE: f64 = 15.0;
pub const FIRE_BURST: f64 = 6.0;
pub const OP_RATE: f64 = 6.0;
pub const OP_BURST: f64 = 4.0;
pub const FIX_GAP: f64 = 0.5;
pub const ORIGIN_SLACK: f64 = 1.0;
pub const FIRE_LATE: f64 = 0.5;
pub const IP_CAP: f64 = 0.35;
pub const RTT_CAP: f64 = 0.4;
pub const RTT_WINDOW: f64 = 3.0;
pub const HISTORY: f64 = 1.2;
pub const COUNTDOWN: f64 = 4.0;
pub const RESPAWN: f64 = 3.0;
pub const PROTECT: f64 = 1.5;
/// The void: below the deck (or off the map box) with nothing to stand on. A fall-out
/// used to be an endless free-fall with no way back — VOID_SECS later the referee puts
/// you back under a canopy (that wait IS the penalty).
pub const VOID_Y: f64 = -2.0;
pub const VOID_SECS: f64 = 10.0;
pub const PICK_R: f64 = 1.1;
pub const PICKUP_BACK: f64 = 15.0;
pub const GRACE: f64 = 15.0;
// --- totems (the "hack" pickups): one drops every TOTEM_GAP during a round; the mole only
// appears when the other side fields a bot (it can't turn a human). Durations mirror
// games/strike.js TOTEMS, which is the client's word for what each gem does.
pub const TOTEM_GAP: f64 = 10.0;
pub const TOTEM_FIRST: f64 = 8.0;
pub const TOTEM_KINDS: [&str; 47] = [
    "mole", "freeze", "decoy", "cloak", "shield", "wings", "leap", "speed", "teleport",
    // Wave C — the unique set from the brainstorm (Time Freeze ≈ Paralyser and
    // Clone Army ≈ Decoy are deliberately skipped as repeats)
    "rift", "mirror", "gravflip", "rewind", "shock", "magnet", "chain", "trap",
    "mark", "blink", "bubble", "wallrun", "secondwind", "fakedeath", "ghost",
    "cluster", "overclock", "ricochet", "infchamber", "bodyswap", "rally",
    "meteor", "chaos", "phoenix", "pocket", "fate", "king", "radarjam",
    // Wave D — Arena Disasters: arena-wide, BOTH sides suffer, and the taker suffers too.
    // ("meteorshower" not "meteor": that name is already the personal Meteor Call.)
    "sandstorm", "meteorshower", "hurricane", "thunder", "earthquake",
    "shockring", "toxicfog", "absolutezero", "sinkhole", "emp",
];
// --- the drop rings: past the map's own packs (the first MAP.pickups.len() slots) sit a
// fixed pool of totem slots then pack slots, reused round-robin so slot indices stay
// stable while the drops themselves keep coming — fresh kind, fresh spot, repeats allowed.
// Loose packs (health/ammo) are their own clock, independent of the totems.
pub const DROP_SLOTS: usize = 3;   // recycled totem slots
pub const PACK_SLOTS: usize = 2;   // recycled loose-pack slots
pub const PACK_GAP: f64 = 8.0;     // s between loose-pack drops
pub const PACK_FIRST: f64 = 6.0;   // s into the round before the first loose pack
// ---- Wave D: Arena Disasters (everyone suffers — including whoever set one off) ----
/// The 10 arena-wide disasters. A totem can start any one of them; so can the clock.
pub const DISASTERS: [&str; 10] = [
    "sandstorm", "meteorshower", "hurricane", "thunder", "earthquake",
    "shockring", "toxicfog", "absolutezero", "sinkhole", "emp",
];
// Wave E: Disaster totems are NOT mixed into the personal roster — they have their own
// ring and their own clock, same "somewhere random, recycled slots" rule as the others.
pub const DIS_SLOTS: usize = 2;       // recycled Disaster-totem slots
pub const DIS_GAP_DROP: f64 = 16.0;   // s between Disaster-totem drops
pub const DIS_FIRST_DROP: f64 = 12.0; // s into the round before the first Disaster totem
/// The auto-disaster clock (independent of the totems, the Disaster totems, and Arena Events).
pub const DIS_GAP: f64 = 45.0;   // s between automatic disasters
pub const DIS_FIRST: f64 = 30.0;      // first auto-disaster ~30 s into the round
/// One disaster at a time: 2s of warning everyone can read, then the hold.
pub const DIS_WARN: f64 = 2.0;
pub const DIS_SANDSTORM: f64 = 12.0;
pub const DIS_METEOR: f64 = 10.0;
pub const DIS_HURRICANE: f64 = 10.0;
pub const DIS_THUNDER: f64 = 8.0;
pub const DIS_EARTHQUAKE: f64 = 8.0;
pub const DIS_SHOCKRING: f64 = 5.0;   // one expanding wave, not a hold
pub const DIS_TOXICFOG: f64 = 12.0;
pub const DIS_ZERO: f64 = 10.0;
pub const DIS_SINKHOLE: f64 = 8.0;
pub const DIS_EMP: f64 = 5.0;
/// Overhead impacts (Meteor Shower / Thunder) skip anyone under a shed roof.
pub const DD_METEOR_R: f64 = 3.5;
pub const DD_METEOR_DMG: i64 = 45;
pub const DD_METEOR_WARN: f64 = 1.0;
pub const DD_METEOR_GAP: f64 = 0.55;
pub const DD_THUNDER_R: f64 = 2.8;
pub const DD_THUNDER_DMG: i64 = 55;
pub const DD_THUNDER_WARN: f64 = 0.7;
pub const DD_THUNDER_GAP: f64 = 0.45;
pub const DD_QUAKE_R: f64 = 2.5;
pub const DD_QUAKE_DMG: i64 = 25;
pub const DD_QUAKE_WARN: f64 = 0.8;
pub const DD_QUAKE_GAP: f64 = 0.7;
pub const DD_SHOCK_R: f64 = 28.0;    // how far the ring gets before it fades
pub const DD_SHOCK_DMG: i64 = 30;
pub const DD_SHOCK_KNOCK: f64 = 12.0;
pub const DD_TOXIC_R: f64 = 5.0;
pub const DD_TOXIC_DMG: i64 = 8;     // per second inside a cloud
pub const DD_TOXIC_ZONES: usize = 3;
pub const DD_TOXIC_CHIP_DMG: i64 = 3; // the green gas fills the arena — everyone chips
pub const DD_SINK_R: f64 = 4.5;
pub const DD_SINK_DMG: i64 = 12;     // per second in the pit
pub const DD_SINK_PULL: f64 = 4.0;
pub const DD_WIND_R: f64 = 6.0;
pub const DD_WIND_PUSH: f64 = 7.5;
pub const DD_WIND_DMG: i64 = 3;
/// Exposure bites for the modifier disasters — every disaster has a visual AND
/// an impact (sandstorm grit / frostbite / EMP overload / hurricane blast).
/// Twin: DD_*_DMG in games/strike.js.
pub const DD_SAND_DMG: i64 = 3;
pub const DD_ZERO_DMG: i64 = 4;
pub const DD_EMP_DMG: i64 = 2;
/// proximity crush (shared mark_damage): peak at the centre, DD_NEAR_MIN of the peak at the rim
pub const DD_NEAR_R: f64 = 0.35;
pub const DD_NEAR_MIN: f64 = 0.45;
/// non-HP disaster impacts (seconds). Twin: the same windows in games/strike.js.
pub const DD_THUNDER_BLIND: f64 = 0.45;
pub const DD_METEOR_BLIND: f64 = 0.35;
pub const DD_SHOCK_BLIND: f64 = 0.55;
pub const DD_QUAKE_SLOW: f64 = 1.2;
pub const DD_TOXIC_SLOW: f64 = 0.75;
pub const DD_SINK_SLOW: f64 = 0.65;
pub const DD_WIND_SLOW: f64 = 0.7;
pub const DD_SAND_SCATTER: f64 = 1.2;
pub const DD_WIND_SCATTER: f64 = 2.4;
pub const DD_EMP_SCATTER: f64 = 1.0;
/// walk speed while a disaster slow is on (quake / toxic / sink / wind)
pub const DD_SLOW_MULT: f64 = 0.65;

// ---- The Warden: a mid-match giant torso god summoned at half the kill limit ----
// Twin: WARDEN_* in games/strike.js. While it lives the clock and the scores freeze,
// nobody can hurt each other (only the Warden takes damage), normal totem / pack /
// disaster-totem drops stop, and only the Warden calls disasters.
pub const WARDEN_TRIGGER: f64 = 0.5;   // half the kill limit
pub const WARDEN_HP_PER: i64 = 2000;   // max HP = this * fighters on the field at summon
pub const WARDEN_MIN_HP: i64 = 4000;
pub const WARDEN_MAX_HP: i64 = 24000;
pub const WARDEN_SLAB_R: f64 = 3.2;    // ground warning radius of an arm slam
pub const WARDEN_SLAB_ARM: f64 = 1.2;  // s the arms lift (telegraph) before the slam
pub const WARDEN_SLAB_R_HIT: f64 = 4.5; // everyone inside this is instantly dead
pub const WARDEN_SLAB_KNOCK: f64 = 10.0; // blast ring: blown away + hurt, not instant
pub const WARDEN_SLAB_KNOCK_PUSH: f64 = 8.0;
pub const WARDEN_SLAB_BLAST_DMG: i64 = 25;
pub const WARDEN_SLAB_CD: f64 = 7.0;
pub const WARDEN_LOOT_R0: f64 = 18.0;
pub const WARDEN_LOOT_RSPAN: f64 = 12.0;
pub const WARDEN_LOOT_RMIN: f64 = 16.0;
pub const WARDEN_LASER_WARN: f64 = 1.0;
pub const WARDEN_LASER_HOLD: f64 = 4.0;
pub const WARDEN_LASER_CD: f64 = 9.0;
pub const WARDEN_LASER_YAW0: f64 = 0.35; // rad/s the head sweeps while the beam runs
pub const WARDEN_LASER_W: f64 = 0.55;    // m half-width of the beam (instant kill)
pub const WARDEN_DIS_CD: f64 = 14.0;     // the Warden calls a random disaster this often
pub const WARDEN_CKPT: usize = 3;        // health checkpoints (75% / 50% / 25%)
/// Silhouette scale: the boss (and its hit volumes) are 3× the first cut.
pub const WARDEN_SCALE: f64 = 3.0;
// hit volumes, in local space around (warden.x, 0, warden.z): (half_w, half_d) + y span
pub const WARDEN_BOX_WAIST: (f64, f64, f64, f64) = (5.4, 3.6, 0.0, 4.8);   // (hw, hd, y0, y1)
pub const WARDEN_BOX_CHEST: (f64, f64, f64, f64) = (6.6, 3.9, 4.8, 11.4);
pub const WARDEN_BOX_HEAD: (f64, f64, f64, f64) = (2.7, 2.7, 11.4, 15.6); // no crit — body damage only
pub const WARDEN_BOX_ARM: (f64, f64, f64, f64) = (1.8, 1.8, 5.4, 15.0);    // each arm; x offset ±8.7
pub const WARDEN_ARM_X: f64 = 8.7;
pub const WARDEN_ARM_DMG_MULT: f64 = 0.35; // arms take 35% of a torso shot
pub const WARDEN_ARM_HP: i64 = 2000;       // each arm; 0 = that arm is disabled
/// Exposed Core: torso is plated until a slam (or checkpoint II) opens the chest.
pub const WARDEN_CORE_EXPOSE: f64 = 3.0;
pub const WARDEN_CORE_COVER_MULT: f64 = 0.2;
pub const WARDEN_CORE_HIT_MULT: f64 = 3.0;
pub const WARDEN_CK2_EXPOSE: f64 = 6.0;
/// Gravity Grip: open-hand pull toward the torso (cover / dash breaks it).
pub const WARDEN_GRIP_CD: f64 = 16.0;
pub const WARDEN_GRIP_WARN: f64 = 1.0;
pub const WARDEN_GRIP_HOLD: f64 = 2.0;
pub const WARDEN_GRIP_PULL: f64 = 5.0;
pub const WARDEN_GRIP_R: f64 = 28.0;
pub const WARDEN_GRIP_MIN: f64 = 2.2;
pub const WARDEN_GRIP_SWEEP_DMG: i64 = 18;
pub const WARDEN_CK1_PUSH: f64 = 12.0;
/// Aim / LOS probe heights (arm, chest, waist) and the laser-eye origin.
/// Never prefer the head — it is no weak point and must not be the default aim.
pub const WARDEN_SEE_HEAD: f64 = 13.5;
pub const WARDEN_SEE_CHEST: f64 = 7.8;
pub const WARDEN_SEE_WAIST: f64 = 3.6;
pub const WARDEN_SEE_ARM: f64 = 10.2;
/// Ground-warning lead: the ring paints this long before the slam lands.
pub const WARDEN_SLAB_WIRE: f64 = 0.9;
/// Roman numerals for the three health checkpoints (feed text).
pub const WARDEN_CHECK_NAMES: [&str; 4] = ["", "I", "II", "III"];
pub const CHARM: f64 = 8.0;    // s a mole-turned bot shoots its own side
pub const FREEZE: f64 = 5.0;   // s a paralysed bot can't move or fire
pub const DECOY: f64 = 10.0;   // s a decoy ghost stands and eats shots
pub const CLOAK: f64 = 12.0;   // s enemy bots can't see the cloaked player
pub const SHIELD_TOTEM: f64 = 10.0;   // s the shield totem's bubble holds (they still shoot)
pub const WINGS: f64 = 10.0;      // s the wings totem lets the taker fly (auto rise, glide, auto land)
/// s beyond WINGS the descent is still judged as wings flight (9 m at WING_SINK 2.0, rounded up)
pub const WINGS_LAND: f64 = 5.0;
pub const LEAP: f64 = 10.0;       // s the leap totem's boosted Space-bar jumps
pub const SPEED: f64 = 6.0;       // s the speed totem's double-sprint dash on plain WASD
// Wave C windows (server clock). Short one-shots use a charge count instead of a clock.
pub const RIFT: f64 = 6.0;
pub const MIRROR: f64 = 10.0;
pub const GRAVFLIP: f64 = 8.0;
pub const MAGNET: f64 = 8.0;
pub const BUBBLE: f64 = 8.0;
pub const WALLRUN: f64 = 10.0;
pub const FAKE: f64 = 6.0;
pub const OVERCLOCK: f64 = 8.0;
pub const INFCHAMBER: f64 = 10.0;
pub const RALLY: f64 = 10.0;
pub const CHAOS: f64 = 12.0;
pub const POCKET: f64 = 5.0;
pub const FATE: f64 = 8.0;
pub const KING: f64 = 15.0;
pub const HUNTER: f64 = 12.0;
pub const PHOENIX: f64 = 12.0;
pub const RADARJAM: f64 = 10.0;
pub const SHOCK_R: f64 = 6.0;
pub const MINE_R: f64 = 1.3;
pub const MINE_DMG: i64 = 60;
pub const METEOR_R: f64 = 5.0;
pub const METEOR_DMG: i64 = 80;
pub const TRAP_N: i64 = 2;
pub const MIRROR_N: i64 = 3;
pub const BLINK_N: i64 = 3;
pub const BLINK_D: f64 = 6.0;
pub const GHOST_N: i64 = 3;
pub const RICO_N: i64 = 3;
pub const CLUSTER_N: i64 = 5;
pub const CHAIN_N: i64 = 2;
pub const CHAIN_R: f64 = 8.0;
pub const CURSED_PCT: i64 = 15;   // hash percent of drops that are Cursed (purple)
pub const HOT_PCT: i64 = 12;
pub const EVENT_GAP: f64 = 45.0;
pub const EVENT_WARN: f64 = 3.0;
pub const EVENT_DUR: f64 = 12.0;
pub const CRATE_CLAIM: f64 = 3.0;
pub const FUSE_R: f64 = 3.0;
pub const HUNT_HOLD: f64 = 10.0;
// snap flag bits (v6): stay under 2^31 so the client's bitwise ops stay exact
pub const FLAG_GRAVFLIP: i64 = 2048;
pub const FLAG_OVERCLOCK: i64 = 4096;
pub const FLAG_INFCHAMBER: i64 = 8192;
pub const FLAG_MAGNET: i64 = 16384;
pub const FLAG_WALLRUN: i64 = 32768;
pub const FLAG_FAKE: i64 = 65536;
pub const FLAG_POCKET: i64 = 131072;
pub const FLAG_RALLY: i64 = 262144;
pub const FLAG_KING: i64 = 524288;
pub const FLAG_HUNTER: i64 = 1048576;
pub const FLAG_FATE: i64 = 2097152;
pub const FLAG_PHOENIX: i64 = 4194304;
pub const FLAG_JAM: i64 = 8388608;
// disaster sense (thunder / meteor flash, shockring; quake / toxic / sink / wind crawl)
pub const FLAG_BLIND: i64 = 16777216;
pub const FLAG_SLOW: i64 = 33554432;
/// The quick presets the menu offers. The host's own minutes/kills (1..=60, 1..=500)
/// are accepted too — `start` clamps, it doesn't check these lists.
pub const MINUTES: [i64; 3] = [3, 5, 10];
pub const KILLS: [i64; 4] = [10, 20, 30, 50];
pub const TEAM_SIZES: [i64; 5] = [1, 2, 3, 4, 5];
pub const MAX_PLAYERS: usize = 10;
pub const CHARS: i64 = 6;

// --- bots ---
pub const BOT_THINK: f64 = 0.25;    // s between a bot's decisions
pub const BOT_TURN: f64 = 9.0;      // how fast a bot swings its aim (radians/s)
pub const BOT_AIM: f64 = 0.04;      // radians of aim error a bot lets itself (they miss)
pub const BOT_RANGE: f64 = 45.0;    // m at which a bot will start shooting
/// A sandstorm arena event halves that: bots squint through the dust.
pub const STORM_RANGE: f64 = 22.0;
pub const BOT_REACT: f64 = 0.35;    // s a bot takes to open fire once a target is in sight
pub const BOT_NAMES: [&str; 8] = ["Vex", "Rook", "Piston", "Mako", "Juno", "Crow", "Dart", "Onyx"];
/// Per-team colours (amber, cyan) as [r, g, b] in 0..1, for the roster.
pub const BOT_COLORS: [[f64; 3]; 2] = [[0.86, 0.55, 0.20], [0.25, 0.72, 0.80]];
/// Patrol waypoints: (x, z, standY). Fallback when a map ships none
/// (both shipped arenas carry their own list now). standY is the deck height a
/// body stands at on that point — 0 on the ground, 2.5 on a catwalk, 3.5 on the
/// warehouse roof.
pub const WAYPOINTS: [(f64, f64, f64); 333] = [
    (-28.0, -24.0, 0.0),
    (-20.0, -24.0, 0.0),
    (-12.0, -24.0, 0.0),
    (-4.0, -24.0, 0.0),
    (4.0, -24.0, 0.0),
    (12.0, -24.0, 0.0),
    (20.0, -24.0, 0.0),
    (28.0, -24.0, 0.0),
    (-36.0, -16.0, 0.0),
    (-28.0, -16.0, 0.0),
    (-20.0, -16.0, 0.0),
    (-12.0, -16.0, 0.0),
    (-4.0, -16.0, 0.0),
    (4.0, -16.0, 0.0),
    (12.0, -16.0, 0.0),
    (20.0, -16.0, 0.0),
    (28.0, -16.0, 0.0),
    (36.0, -16.0, 0.0),
    (-36.0, -8.0, 0.0),
    (-28.0, -8.0, 0.0),
    (-20.0, -8.0, 0.0),
    (-4.0, -8.0, 0.0),
    (4.0, -8.0, 0.0),
    (20.0, -8.0, 0.0),
    (28.0, -8.0, 0.0),
    (36.0, -8.0, 0.0),
    (-28.0, 0.0, 0.0),
    (-20.0, 0.0, 0.0),
    (-12.0, 0.0, 0.0),
    (12.0, 0.0, 0.0),
    (20.0, 0.0, 0.0),
    (28.0, 0.0, 0.0),
    (-36.0, 8.0, 0.0),
    (-28.0, 8.0, 0.0),
    (-20.0, 8.0, 0.0),
    (-4.0, 8.0, 0.0),
    (4.0, 8.0, 0.0),
    (20.0, 8.0, 0.0),
    (28.0, 8.0, 0.0),
    (36.0, 8.0, 0.0),
    (-36.0, 16.0, 0.0),
    (-28.0, 16.0, 0.0),
    (-20.0, 16.0, 0.0),
    (-12.0, 16.0, 0.0),
    (-4.0, 16.0, 0.0),
    (4.0, 16.0, 0.0),
    (12.0, 16.0, 0.0),
    (20.0, 16.0, 0.0),
    (28.0, 16.0, 0.0),
    (36.0, 16.0, 0.0),
    (-28.0, 24.0, 0.0),
    (-20.0, 24.0, 0.0),
    (-12.0, 24.0, 0.0),
    (-4.0, 24.0, 0.0),
    (4.0, 24.0, 0.0),
    (12.0, 24.0, 0.0),
    (20.0, 24.0, 0.0),
    (28.0, 24.0, 0.0),
    (0.0, -20.0, 0.0),
    (0.0, 20.0, 0.0),
    (-30.0, -10.0, 0.0),
    (30.0, 10.0, 0.0),
    (-30.0, 10.0, 0.0),
    (30.0, -10.0, 0.0),
    (0.0, -8.0, 0.0),
    (0.0, 8.0, 0.0),
    (0.0, -16.0, 0.0),
    (0.0, 16.0, 0.0),
    (-36.0, -20.2, 0.0),
    (-36.0, 20.2, 0.0),
    (36.0, -20.2, 0.0),
    (36.0, 20.2, 0.0),
    (-36.0, -21.75, 0.5),
    (-36.0, 21.75, 0.5),
    (36.0, -21.75, 0.5),
    (36.0, 21.75, 0.5),
    (-36.0, -22.85, 1.0),
    (-36.0, 22.85, 1.0),
    (36.0, -22.85, 1.0),
    (36.0, 22.85, 1.0),
    (-36.0, -23.95, 1.5),
    (-36.0, 23.95, 1.5),
    (36.0, -23.95, 1.5),
    (36.0, 23.95, 1.5),
    (-36.0, -25.05, 2.0),
    (-36.0, 25.05, 2.0),
    (36.0, -25.05, 2.0),
    (36.0, 25.05, 2.0),
    (-36.0, -25.95, 2.5),
    (-36.0, 25.95, 2.5),
    (36.0, -25.95, 2.5),
    (36.0, 25.95, 2.5),
    (-24.0, -20.2, 0.0),
    (-24.0, 20.2, 0.0),
    (24.0, -20.2, 0.0),
    (24.0, 20.2, 0.0),
    (-24.0, -21.75, 0.5),
    (-24.0, 21.75, 0.5),
    (24.0, -21.75, 0.5),
    (24.0, 21.75, 0.5),
    (-24.0, -22.85, 1.0),
    (-24.0, 22.85, 1.0),
    (24.0, -22.85, 1.0),
    (24.0, 22.85, 1.0),
    (-24.0, -23.95, 1.5),
    (-24.0, 23.95, 1.5),
    (24.0, -23.95, 1.5),
    (24.0, 23.95, 1.5),
    (-24.0, -25.05, 2.0),
    (-24.0, 25.05, 2.0),
    (24.0, -25.05, 2.0),
    (24.0, 25.05, 2.0),
    (-24.0, -25.95, 2.5),
    (-24.0, 25.95, 2.5),
    (24.0, -25.95, 2.5),
    (24.0, 25.95, 2.5),
    (-14.0, -20.2, 0.0),
    (-14.0, 20.2, 0.0),
    (14.0, -20.2, 0.0),
    (14.0, 20.2, 0.0),
    (-14.0, -21.75, 0.5),
    (-14.0, 21.75, 0.5),
    (14.0, -21.75, 0.5),
    (14.0, 21.75, 0.5),
    (-14.0, -22.85, 1.0),
    (-14.0, 22.85, 1.0),
    (14.0, -22.85, 1.0),
    (14.0, 22.85, 1.0),
    (-14.0, -23.95, 1.5),
    (-14.0, 23.95, 1.5),
    (14.0, -23.95, 1.5),
    (14.0, 23.95, 1.5),
    (-14.0, -25.05, 2.0),
    (-14.0, 25.05, 2.0),
    (14.0, -25.05, 2.0),
    (14.0, 25.05, 2.0),
    (-14.0, -25.95, 2.5),
    (-14.0, 25.95, 2.5),
    (14.0, -25.95, 2.5),
    (14.0, 25.95, 2.5),
    (-2.0, -20.2, 0.0),
    (-2.0, 20.2, 0.0),
    (2.0, -20.2, 0.0),
    (2.0, 20.2, 0.0),
    (-2.0, -21.75, 0.5),
    (-2.0, 21.75, 0.5),
    (2.0, -21.75, 0.5),
    (2.0, 21.75, 0.5),
    (-2.0, -22.85, 1.0),
    (-2.0, 22.85, 1.0),
    (2.0, -22.85, 1.0),
    (2.0, 22.85, 1.0),
    (-2.0, -23.95, 1.5),
    (-2.0, 23.95, 1.5),
    (2.0, -23.95, 1.5),
    (2.0, 23.95, 1.5),
    (-2.0, -25.05, 2.0),
    (-2.0, 25.05, 2.0),
    (2.0, -25.05, 2.0),
    (2.0, 25.05, 2.0),
    (-2.0, -25.95, 2.5),
    (-2.0, 25.95, 2.5),
    (2.0, -25.95, 2.5),
    (2.0, 25.95, 2.5),
    (-30.0, -26.8, 2.5),
    (-30.0, 26.8, 2.5),
    (30.0, -26.8, 2.5),
    (30.0, 26.8, 2.5),
    (-8.0, -26.8, 2.5),
    (-8.0, 26.8, 2.5),
    (8.0, -26.8, 2.5),
    (8.0, 26.8, 2.5),
    (-19.0, -26.8, 2.5),
    (-19.0, 26.8, 2.5),
    (19.0, -26.8, 2.5),
    (19.0, 26.8, 2.5),
    (0.0, -26.8, 2.5),
    (0.0, 26.8, 2.5),
    (10.0, 16.0, 0.0),
    (10.0, -16.0, 0.0),
    (-10.0, 16.0, 0.0),
    (-10.0, -16.0, 0.0),
    (10.0, 14.5, 0.5),
    (10.0, -14.5, 0.5),
    (-10.0, 14.5, 0.5),
    (-10.0, -14.5, 0.5),
    (10.0, 13.5, 1.0),
    (10.0, -13.5, 1.0),
    (-10.0, 13.5, 1.0),
    (-10.0, -13.5, 1.0),
    (10.0, 12.5, 1.5),
    (10.0, -12.5, 1.5),
    (-10.0, 12.5, 1.5),
    (-10.0, -12.5, 1.5),
    (10.0, 11.65, 1.5),
    (10.0, -11.65, 1.5),
    (-10.0, 11.65, 1.5),
    (-10.0, -11.65, 1.5),
    (10.0, 10.0, 1.5),
    (10.0, -10.0, 1.5),
    (-10.0, 10.0, 1.5),
    (-10.0, -10.0, 1.5),
    (11.4, 0.0, 0.0),
    (-11.4, 0.0, 0.0),
    (9.94, 0.0, 0.5),
    (-9.94, 0.0, 0.5),
    (9.03, 0.0, 1.0),
    (-9.03, 0.0, 1.0),
    (8.11, 0.0, 1.5),
    (-8.11, 0.0, 1.5),
    (7.2, 0.0, 2.0),
    (-7.2, 0.0, 2.0),
    (6.29, 0.0, 2.5),
    (-6.29, 0.0, 2.5),
    (5.37, 0.0, 3.0),
    (-5.37, 0.0, 3.0),
    (4.46, 0.0, 3.5),
    (-4.46, 0.0, 3.5),
    (3.65, 0.0, 3.5),
    (-3.65, 0.0, 3.5),
    (0.0, 0.0, 3.5),
    (0.0, -2.0, 3.5),
    (0.0, 2.0, 3.5),
    (2.2, 0.0, 3.5),
    (-2.2, 0.0, 3.5),
    (40.0, 0.0, 0.0),
    (-40.0, 0.0, 0.0),
    (38.55, 0.0, 0.5),
    (-38.55, 0.0, 0.5),
    (37.65, 0.0, 1.0),
    (-37.65, 0.0, 1.0),
    (36.75, 0.0, 1.5),
    (-36.75, 0.0, 1.5),
    (35.85, 0.0, 2.0),
    (-35.85, 0.0, 2.0),
    (35.05, 0.0, 2.5),
    (-35.05, 0.0, 2.5),
    (34.2, 0.0, 2.5),
    (-34.2, 0.0, 2.5),
    (14.2, 15.5, 0.0),
    (14.2, -15.5, 0.0),
    (-14.2, 15.5, 0.0),
    (-14.2, -15.5, 0.0),
    (14.2, 14.0, 0.5),
    (14.2, -14.0, 0.5),
    (-14.2, 14.0, 0.5),
    (-14.2, -14.0, 0.5),
    (14.2, 13.0, 1.0),
    (14.2, -13.0, 1.0),
    (-14.2, 13.0, 1.0),
    (-14.2, -13.0, 1.0),
    (14.2, 12.0, 1.5),
    (14.2, -12.0, 1.5),
    (-14.2, 12.0, 1.5),
    (-14.2, -12.0, 1.5),
    (14.2, 11.0, 2.0),
    (14.2, -11.0, 2.0),
    (-14.2, 11.0, 2.0),
    (-14.2, -11.0, 2.0),
    (14.2, 10.15, 2.5),
    (14.2, -10.15, 2.5),
    (-14.2, 10.15, 2.5),
    (-14.2, -10.15, 2.5),
    (14.2, 7.5, 2.5),
    (14.2, -7.5, 2.5),
    (-14.2, 7.5, 2.5),
    (-14.2, -7.5, 2.5),
    (34.2, 15.5, 0.0),
    (34.2, -15.5, 0.0),
    (-34.2, 15.5, 0.0),
    (-34.2, -15.5, 0.0),
    (34.2, 14.0, 0.5),
    (34.2, -14.0, 0.5),
    (-34.2, 14.0, 0.5),
    (-34.2, -14.0, 0.5),
    (34.2, 13.0, 1.0),
    (34.2, -13.0, 1.0),
    (-34.2, 13.0, 1.0),
    (-34.2, -13.0, 1.0),
    (34.2, 12.0, 1.5),
    (34.2, -12.0, 1.5),
    (-34.2, 12.0, 1.5),
    (-34.2, -12.0, 1.5),
    (34.2, 11.0, 2.0),
    (34.2, -11.0, 2.0),
    (-34.2, 11.0, 2.0),
    (-34.2, -11.0, 2.0),
    (34.2, 10.15, 2.5),
    (34.2, -10.15, 2.5),
    (-34.2, 10.15, 2.5),
    (-34.2, -10.15, 2.5),
    (34.2, 7.5, 2.5),
    (34.2, -7.5, 2.5),
    (-34.2, 7.5, 2.5),
    (-34.2, -7.5, 2.5),
    (23.0, 18.5, 0.0),
    (23.0, -18.5, 0.0),
    (-23.0, 18.5, 0.0),
    (-23.0, -18.5, 0.0),
    (21.55, 18.5, 0.5),
    (21.55, -18.5, 0.5),
    (-21.55, 18.5, 0.5),
    (-21.55, -18.5, 0.5),
    (20.65, 18.5, 1.0),
    (20.65, -18.5, 1.0),
    (-20.65, 18.5, 1.0),
    (-20.65, -18.5, 1.0),
    (19.75, 18.5, 1.5),
    (19.75, -18.5, 1.5),
    (-19.75, 18.5, 1.5),
    (-19.75, -18.5, 1.5),
    (18.85, 18.5, 2.0),
    (18.85, -18.5, 2.0),
    (-18.85, 18.5, 2.0),
    (-18.85, -18.5, 2.0),
    (18.05, 18.5, 2.5),
    (18.05, -18.5, 2.5),
    (-18.05, 18.5, 2.5),
    (-18.05, -18.5, 2.5),
    (17.2, 18.5, 2.5),
    (17.2, -18.5, 2.5),
    (-17.2, 18.5, 2.5),
    (-17.2, -18.5, 2.5),
    (14.2, 0.0, 2.5),
    (-14.2, 0.0, 2.5),
    (14.2, 3.75, 2.5),
    (14.2, -3.75, 2.5),
    (-14.2, 3.75, 2.5),
    (-14.2, -3.75, 2.5),
    (34.2, 3.75, 2.5),
    (34.2, -3.75, 2.5),
    (-34.2, 3.75, 2.5),
    (-34.2, -3.75, 2.5),
];

// Lobby (valley.py)
pub const GAME: &str = "strike";
pub const GAME_NAME: &str = "Strikezone";
pub const MAX_LOBBY: usize = 8;
pub const HOST_GRACE: f64 = 15.0;

pub const MAP_JSON: &str = include_str!("../data/strike_map.json");
pub const MAP_SAND_JSON: &str = include_str!("../data/strike_map_sandbar.json");

pub type Box3 = [f64; 6];

pub struct Pickup {
    #[allow(dead_code)] // mirrors the map JSON; read by tests and the client
    pub id: String,
    pub health: bool,
    pub at: [f64; 3],
}

pub struct Map {
    pub id: String,
    bounds_field: Box3,
    pub boxes: Vec<Box3>,
    pub spawns: Vec<[f64; 4]>,
    pub pickups: Vec<Pickup>,
    #[allow(dead_code)] // practice drones: the client animates them from target_at
    pub targets: Vec<([f64; 3], [f64; 3], f64)>,
    /// Patrol graph for the bots: (x, z, standY). Maps may ship their
    /// own list; dockyard falls back to the built-in table.
    pub waypoints: Vec<(f64, f64, f64)>,
    /// Walkable adjacency over `patrol()` — which waypoints a bot can reach without
    /// clipping a wall. Built once at compile time so bots can path rooms/passages
    /// instead of walking a straight line into adobe.
    pub nav: Vec<Vec<usize>>,
}

impl Map {
    pub fn bounds(&self) -> Box3 {
        self.bounds_field
    }

    /// The bot patrol graph for this arena (map waypoints, else the dockyard table).
    pub fn patrol(&self) -> &[(f64, f64, f64)] {
        if !self.waypoints.is_empty() {
            &self.waypoints
        } else {
            &WAYPOINTS
        }
    }

    /// Next walkable hop from (x, z, y) toward (tx, tz, ty): follow the nav graph
    /// through rooms and passages. Falls back to a straight walk when this body can
    /// already see the destination, the graph is empty, or the graph cannot reach it
    /// (the stuck-slide will peel the bot off the wall). y/ty are stand heights.
    pub fn nav_next(&self, x: f64, z: f64, tx: f64, tz: f64, y: f64, ty: f64) -> (f64, f64) {
        let wps = self.patrol();
        if wps.is_empty() || self.nav.len() != wps.len() {
            return (tx, tz);
        }
        // only cut to the destination when THIS body can see it at our height — a hop
        // that sees it is not enough, or the bot walks the wall between here and there
        if (y - ty).abs() <= STEP_H && los(self, [x, y + 0.9, z], [tx, ty + 0.9, tz]) {
            return (tx, tz);
        }
        let a = nearest_wp(self, wps, x, z, y);
        let b = nearest_wp(self, wps, tx, tz, ty);
        match bfs_wp(&self.nav, a, b) {
            Some(path) if path.len() >= 2 => {
                let mut hop = 1;
                while hop + 1 < path.len()
                    && (wps[path[hop]].0 - x).hypot(wps[path[hop]].1 - z) < 1.4
                {
                    hop += 1;
                }
                (wps[path[hop]].0, wps[path[hop]].1)
            }
            _ => (tx, tz),
        }
    }
}

fn nearest_wp(m: &Map, wps: &[(f64, f64, f64)], x: f64, z: f64, y: f64) -> usize {
    // prefer the nearest waypoint we can actually see at our own height — through a
    // wall the Euclidean nearest lives in the next room, and a deck point under our
    // feet is not a hop we can walk
    let mut best = 0usize;
    let mut bd = f64::INFINITY;
    let mut vis: Option<usize> = None;
    let mut bvd = f64::INFINITY;
    for (i, w) in wps.iter().enumerate() {
        let wy = w.2;
        let d = (w.0 - x).powi(2) + (w.1 - z).powi(2) + (wy - y).powi(2);
        if d < bd {
            bd = d;
            best = i;
        }
        if d < bvd
            && (wy - y).abs() <= STEP_H + 0.05
            && los(m, [x, y + 0.9, z], [w.0, wy + 0.9, w.1])
        {
            bvd = d;
            vis = Some(i);
        }
    }
    vis.unwrap_or(best)
}

fn bfs_wp(adj: &[Vec<usize>], a: usize, b: usize) -> Option<Vec<usize>> {
    if a == b {
        return Some(vec![a]);
    }
    let mut prev: Vec<Option<usize>> = vec![None; adj.len()];
    let mut q = std::collections::VecDeque::from([a]);
    prev[a] = Some(a);
    while let Some(u) = q.pop_front() {
        if u == b {
            let mut path = Vec::new();
            let mut cur = b;
            loop {
                path.push(cur);
                let p = prev[cur]?;
                if p == cur {
                    break;
                }
                cur = p;
            }
            path.reverse();
            return Some(path);
        }
        for &v in &adj[u] {
            if prev[v].is_none() {
                prev[v] = Some(u);
                q.push_back(v);
            }
        }
    }
    None
}

fn build_nav(m: &Map) -> Vec<Vec<usize>> {
    // A hop is walkable when the rise is a step-up (<= STEP_H) and the eye-to-eye
    // ray is clear at each point's own height, so stair chains link ground to deck
    // and a deck never bridges straight down to the floor.
    let wps = m.patrol();
    let n = wps.len();
    let mut adj = vec![Vec::new(); n];
    for i in 0..n {
        for j in (i + 1)..n {
            let d = (wps[i].0 - wps[j].0).hypot(wps[i].1 - wps[j].1);
            if d > 12.0 {
                continue;
            }
            let (yi, yj) = (wps[i].2, wps[j].2);
            if (yi - yj).abs() > STEP_H {
                continue;
            }
            if los(
                m,
                [wps[i].0, yi + 0.9, wps[i].1],
                [wps[j].0, yj + 0.9, wps[j].1],
            ) {
                adj[i].push(j);
                adj[j].push(i);
            }
        }
    }
    adj
}

fn nums<const N: usize>(v: &Value) -> [f64; N] {
    let mut out = [0.0; N];
    for (i, o) in out.iter_mut().enumerate() {
        *o = v[i].as_f64().expect("a number");
    }
    out
}

pub fn compile_map(d: &Value) -> Result<Map, String> {
    let boxes: Vec<Box3> = d["boxes"].as_array().ok_or("no boxes")?.iter().map(nums::<6>).collect();
    if boxes.iter().any(|b| !(b[0] < b[3] && b[1] < b[4] && b[2] < b[5])) {
        return Err("box with no volume".into());
    }
    let mut map = Map {
        id: d["id"].as_str().unwrap_or("").to_string(),
        bounds_field: nums::<6>(&d["bounds"]),
        boxes,
        spawns: d["spawns"].as_array().ok_or("no spawns")?.iter().map(nums::<4>).collect(),
        pickups: d["pickups"].as_array().ok_or("no pickups")?.iter()
            .map(|p| Pickup { id: p["id"].as_str().unwrap_or("").into(), health: p["kind"] == "health",
                              at: nums::<3>(&p["at"]) })
            .collect(),
        targets: d["targets"].as_array().map(|a| a.iter()
            .map(|t| (nums::<3>(&t["a"]), nums::<3>(&t["b"]), t["s"].as_f64().unwrap_or(1.0))).collect())
            .unwrap_or_default(),
        waypoints: d["waypoints"].as_array().map(|a| a.iter()
            .map(|w| (w[0].as_f64().unwrap_or(0.0), w[1].as_f64().unwrap_or(0.0),
                      w.get(2).and_then(|v| v.as_f64()).unwrap_or(0.0))).collect())
            .unwrap_or_default(),
        nav: Vec::new(),
    };
    map.nav = build_nav(&map);
    Ok(map)
}

/// The two shipped arenas, compiled once at startup. `MAP` stays the default
/// (Harbor Dockyard) so geometry helpers and the existing tests keep one handle.
pub static MAPS: LazyLock<[Map; 2]> = LazyLock::new(|| {
    [
        compile_map(&serde_json::from_str(MAP_JSON).expect("strike_map.json parses"))
            .expect("strike_map.json compiles"),
        compile_map(&serde_json::from_str(MAP_SAND_JSON).expect("strike_map_sandbar.json parses"))
            .expect("strike_map_sandbar.json compiles"),
    ]
});

pub static MAP: LazyLock<Map> = LazyLock::new(|| {
    compile_map(&serde_json::from_str(MAP_JSON).expect("strike_map.json parses"))
        .expect("strike_map.json compiles")
});

/// Look up a shipped arena by id. Unknown ids return None; callers fall back
/// to Harbor Dockyard rather than a half-built map.
pub fn map_by_id(id: &str) -> Option<&'static Map> {
    MAPS.iter().find(|m| m.id == id)
}

/// How far a ground beam can run before it leaves the arena (never off the map).
/// Twin: mapLaserRun in games/strike.js.
pub fn map_laser_run(map: &Map, wx: f64, wz: f64, yaw: f64) -> f64 {
    let b = map.bounds();
    let dx = yaw.cos();
    let dz = yaw.sin();
    let mut run: f64 = 200.0;
    if dx > 1e-6 {
        run = run.min((b[3] - 0.5 - wx) / dx);
    } else if dx < -1e-6 {
        run = run.min((b[0] + 0.5 - wx) / dx);
    }
    if dz > 1e-6 {
        run = run.min((b[5] - 0.5 - wz) / dz);
    } else if dz < -1e-6 {
        run = run.min((b[2] + 0.5 - wz) / dz);
    }
    run.clamp(4.0, 80.0)
}

// ------------------------------------------------------- shared geometry --
/// Index of the first solid box a player standing at (x, y, z) is inside.
pub fn overlaps(m: &Map, x: f64, y: f64, z: f64, shrink: f64) -> Option<usize> {
    let (x0, x1) = (x - R + shrink, x + R - shrink);
    let (y0, y1) = (y + shrink, y + H - shrink);
    let (z0, z1) = (z - R + shrink, z + R - shrink);
    m.boxes.iter().position(|b| x1 > b[0] && x0 < b[3] && y1 > b[1] && y0 < b[4] && z1 > b[2] && z0 < b[5])
}

/// The highest box top among the boxes a player at (x, y, z) overlaps.
pub fn top_under(m: &Map, x: f64, y: f64, z: f64) -> Option<f64> {
    let mut best: Option<f64> = None;
    for b in &m.boxes {
        if x + R > b[0] && x - R < b[3] && y + H > b[1] && y < b[4] && z + R > b[2] && z - R < b[5]
            && best.map(|v| b[4] > v).unwrap_or(true)
        {
            best = Some(b[4]);
        }
    }
    best
}

/// True when this body is in the void: off the map box, under the deck with no slab
/// to land on, or already past VOID_Y. (A gap in the floor — Sandbar's water — counts.)
pub fn in_void(m: &Map, x: f64, y: f64, z: f64) -> bool {
    if !x.is_finite() || !y.is_finite() || !z.is_finite() {
        return true;
    }
    if y < VOID_Y {
        return true;
    }
    let b = m.bounds();
    if x < b[0] - 2.0 || x > b[3] + 2.0 || z < b[2] - 2.0 || z > b[5] + 2.0 {
        return true;
    }
    if y < 0.05 && top_under(m, x, y - 0.2, z).is_none() {
        return true;
    }
    false
}

/// True when a solid slab sits overhead — a shed roof, a container top, a catwalk.
/// This is the cover that keeps an overhead impact (Meteor Shower, Thunder) off you.
/// A crate or a step you stand beside does NOT count: the slab must be above your head.
pub fn has_roof(m: &Map, x: f64, y: f64, z: f64) -> bool {
    const HEAD: f64 = 1.45;
    for b in &m.boxes {
        if b[1] > y + HEAD && b[1] <= y + 5.0
            && x + 0.25 > b[0] && x - 0.25 < b[3]
            && z + 0.25 > b[2] && z - 0.25 < b[5]
        {
            return true;
        }
    }
    false
}

/// The runner's state for [`step`]: position, velocity, on the ground.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Body {
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub vx: f64,
    pub vy: f64,
    pub vz: f64,
    pub g: bool,
    /// Gravity multiplier (1.0 default). The low-gravity arena event drives this under 1.
    pub gm: f64,
}

/// One step of the runner (strike.move): axis by axis against the solid boxes,
/// a low ledge stepped onto while on the ground.
pub fn step(m: &Map, s: &mut Body, wx: f64, wz: f64, jump: bool, dt: f64) {
    let k = (dt * if s.g { ACCEL } else { AIR_ACCEL }).min(1.0);
    s.vx += (wx * RUN - s.vx) * k;
    s.vz += (wz * RUN - s.vz) * k;
    if jump && s.g {
        s.vy = JUMP_V;
        s.g = false;
    }
    s.vy = (s.vy - GRAVITY * s.gm.max(0.05) * dt).max(-FALL_MAX);
    for ax in 0..2 {
        let old = if ax == 0 { s.x } else { s.z };
        let v = if ax == 0 { s.vx } else { s.vz };
        if ax == 0 { s.x = old + v * dt } else { s.z = old + v * dt }
        if let Some(i) = overlaps(m, s.x, s.y, s.z, 0.0) {
            let top = m.boxes[i][4];
            if s.g && top - s.y > 0.0 && top - s.y <= STEP_H && overlaps(m, s.x, top, s.z, 0.0).is_none() {
                s.y = top;
            } else if ax == 0 {
                s.x = old;
                s.vx = 0.0;
            } else {
                s.z = old;
                s.vz = 0.0;
            }
        }
    }
    let ny = s.y + s.vy * dt;
    if overlaps(m, s.x, ny, s.z, 0.0).is_none() {
        s.y = ny;
        s.g = false;
    } else if s.vy <= 0.0 {
        if let Some(top) = top_under(m, s.x, ny, s.z) {
            if top <= s.y + 1e-9 {
                s.y = top;
            }
        }
        s.vy = 0.0;
        s.g = true;
    } else {
        s.vy = 0.0;
    }
}

/// Unit view direction for yaw/pitch in degrees (yaw 0 = -z, 90 = +x; pitch up +).
pub fn dir_of(yaw: f64, pitch: f64) -> [f64; 3] {
    let (y, p) = (yaw.to_radians(), pitch.to_radians());
    let cp = p.cos();
    [y.sin() * cp, p.sin(), -y.cos() * cp]
}

/// The yaw (degrees) that looks along (dx, dz) - dir_of's inverse on the plane.
pub fn yaw_of(dx: f64, dz: f64) -> f64 {
    dx.atan2(-dz).to_degrees()
}

/// mulberry32, one draw.
pub fn mb32(a: u32) -> f64 {
    let a = a.wrapping_add(0x6D2B_79F5);
    let mut t = (a ^ (a >> 15)).wrapping_mul(1 | a);
    t = (t.wrapping_add((t ^ (t >> 7)).wrapping_mul(61 | t))) ^ t;
    (t ^ (t >> 14)) as f64 / 4294967296.0
}

/// The totem drop rng (games/strike.js hashMatch): one salted draw from a seed.
pub fn hash_match(seed: u32, salt: u32) -> f64 {
    let x = seed ^ salt.wrapping_mul(0x9E37_79B9);
    x as f64 / 4294967295.0
}

/// Pick one of `n` kinds from a small counter/seed (games/strike.js `disKind`).
/// `hash_match`'s /2^32 output reads the TOP bits, so consecutive `world_k` values
/// (1, 2, 3, …) collapse onto one index — the auto-disaster clock rolled the same
/// disaster forever. Golden-ratio mix (`0x9E37_79B9`) plus a xor-fold so the low
/// bits survive. Deterministic, twin of `disKind` in games/strike.js.
pub fn dis_kind(seed: u32, salt: u32, n: usize) -> usize {
    let n = if n == 0 { 1 } else { n };
    let mut x = seed.wrapping_mul(0x9E37_79B9) ^ salt.wrapping_mul(0x85EB_CA6B);
    x ^= x >> 15;
    (x as usize) % n
}

/// The deterministic spread (degrees of yaw, pitch) of a player's n-th shot.
pub fn spread_of(n: i64, w: usize) -> (f64, f64) {
    let s = WEAPONS[w].spread;
    let seed = ((n as u64).wrapping_mul(2654435761).wrapping_add(w as u64 * 40503) & 0xFFFF_FFFF) as u32;
    ((mb32(seed) * 2.0 - 1.0) * s, (mb32(seed ^ 0x5BD1_E995) * 2.0 - 1.0) * s)
}

/// Distance along o + t d (t >= 0) to the box; 0 if o is inside; None: a miss.
pub fn ray_box(o: [f64; 3], d: [f64; 3], b: &Box3) -> Option<f64> {
    let (mut tmin, mut tmax) = (0.0f64, f64::INFINITY);
    for a in 0..3 {
        if d[a].abs() < 1e-12 {
            if o[a] < b[a] || o[a] > b[a + 3] {
                return None;
            }
        } else {
            let inv = 1.0 / d[a];
            let (mut t1, mut t2) = ((b[a] - o[a]) * inv, (b[a + 3] - o[a]) * inv);
            if t1 > t2 {
                std::mem::swap(&mut t1, &mut t2);
            }
            if t1 > tmin {
                tmin = t1;
            }
            if t2 < tmax {
                tmax = t2;
            }
            if tmin > tmax {
                return None;
            }
        }
    }
    Some(tmin)
}

/// Distance to the first solid box along the ray, or maxd.
pub fn ray_map(m: &Map, o: [f64; 3], d: [f64; 3], maxd: f64) -> f64 {
    m.boxes.iter().filter_map(|b| ray_box(o, d, b)).fold(maxd, f64::min)
}

pub fn hit_boxes(x: f64, y: f64, z: f64) -> (Box3, Box3) {
    ([x - BODY_R, y, z - BODY_R, x + BODY_R, y + BODY_H, z + BODY_R],
     [x - HEAD_R, y + BODY_H, z - HEAD_R, x + HEAD_R, y + HEAD_TOP, z + HEAD_R])
}

/// (distance, head?) where the ray first meets a player at (x, y, z), nearer than maxd.
pub fn ray_player(o: [f64; 3], d: [f64; 3], x: f64, y: f64, z: f64, maxd: f64) -> Option<(f64, bool)> {
    let (body, head) = hit_boxes(x, y, z);
    let mut best = ray_box(o, d, &body).filter(|t| *t < maxd).map(|t| (t, false));
    if let Some(th) = ray_box(o, d, &head).filter(|t| *t < maxd) {
        if best.map(|b| th < b.0).unwrap_or(true) {
            best = Some((th, true));
        }
    }
    best
}

/// A practice drone's centre at time t: back and forth between a and b.
#[allow(dead_code)] // parity with the Python backend; exercised by tests
pub fn target_at(a: [f64; 3], b: [f64; 3], s: f64, t: f64) -> [f64; 3] {
    let ln = ((b[0] - a[0]).powi(2) + (b[1] - a[1]).powi(2) + (b[2] - a[2]).powi(2)).sqrt();
    let ln = if ln == 0.0 { 1.0 } else { ln };
    let ph = (t * s / ln).rem_euclid(2.0);
    let u = if ph <= 1.0 { ph } else { 2.0 - ph };
    [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u]
}

fn dist3(a: [f64; 3], b: [f64; 3]) -> f64 {
    ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2)).sqrt()
}

/// Line of sight between two eye points: True when no solid box is in the way.
pub fn los(m: &Map, a: [f64; 3], b: [f64; 3]) -> bool {
    let d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    let ln = d[0].hypot(d[1]).hypot(d[2]);
    if ln < 1e-9 {
        return true;
    }
    let u = [d[0] / ln, d[1] / ln, d[2] / ln];
    ray_map(m, a, u, ln) >= ln - 1e-6
}

/// Preferred aim point on The Warden: the near arm (least damage). Never the head.
pub fn warden_aim(wx: f64, wz: f64, slot: usize, core: bool) -> (f64, f64, f64) {
    // open core: every bot focuses the exposed chest (still never the head)
    if core {
        return (wx, WARDEN_SEE_CHEST, wz);
    }
    let side = if slot.is_multiple_of(2) { -1.0 } else { 1.0 };
    (wx + side * WARDEN_ARM_X, WARDEN_SEE_ARM, wz)
}

/// The Warden is huge and centre cover hides its chest — return a hit height the
/// shooter can actually see. Prefer the arm (least damage); never the head.
/// `None` = fully covered.
fn warden_see(m: &Map, o: [f64; 3], wx: f64, wz: f64, slot: usize, core: bool) -> Option<f64> {
    let side = if slot.is_multiple_of(2) { -1.0 } else { 1.0 };
    let pts: [(f64, f64); 4] = if core {
        [
            (wx, WARDEN_SEE_CHEST),
            (wx + side * WARDEN_ARM_X, WARDEN_SEE_ARM),
            (wx - side * WARDEN_ARM_X, WARDEN_SEE_ARM),
            (wx, WARDEN_SEE_WAIST),
        ]
    } else {
        [
            (wx + side * WARDEN_ARM_X, WARDEN_SEE_ARM),
            (wx - side * WARDEN_ARM_X, WARDEN_SEE_ARM),
            (wx, WARDEN_SEE_CHEST),
            (wx, WARDEN_SEE_WAIST),
        ]
    };
    pts
    .into_iter()
    .find(|&(x, y)| los(m, o, [x, y, wz]))
    .map(|(_, y)| y)
}

/// A finite JSON number (not a bool), clamped to [lo, hi].
pub fn as_num(v: Option<&Value>, lo: f64, hi: f64) -> Option<f64> {
    let f = v?.as_number()?.as_f64()?;
    if !f.is_finite() {
        return None;
    }
    Some(f.max(lo).min(hi))
}

fn cm(v: f64) -> i64 {
    (v * 100.0).round_ties_even() as i64
}

// ----------------------------------------------------------------- referee --
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Idle,
    Warmup,
    Round,
    Done,
}

impl Phase {
    pub fn as_str(self) -> &'static str {
        match self {
            Phase::Idle => "idle",
            Phase::Warmup => "warmup",
            Phase::Round => "round",
            Phase::Done => "done",
        }
    }
}

/// A bot's working state. None on a human.
#[derive(Clone, Debug, Default)]
pub struct Bot {
    pub goal: Option<(f64, f64)>,
    pub wpi: usize,
    pub think_at: f64,
    pub target: Option<String>,
    pub seen_at: Option<f64>,
    pub aim_y: f64,
    pub aim_p: f64,
    pub err_y: f64,
    pub err_p: f64,
    pub err_at: f64,
    pub fire_at: f64,
    pub body: Body,
    /// Last place the bot actually moved, so a wall-press can be detected and broken.
    pub stuck_at: f64,
    pub stuck_x: f64,
    pub stuck_z: f64,
    /// A pending sidestep owns the goal until this clock (so think does not yank it back).
    pub slide_until: f64,
    /// Hunt: where the target last vanished (x, z, standY), and until when we still
    /// bother to look. The stand height keeps a bot from pathing to a deck point
    /// while it is still on the ground under the stairs.
    pub lost_x: f64,
    pub lost_z: f64,
    pub lost_y: f64,
    pub lost_until: f64,
    /// Last seen stand height of the current chase target (for nav_next's ty).
    pub target_y: f64,
    /// The decoy this bot is currently baited by (strike.decoys index); None = a real target.
    pub decoy: Option<usize>,
}

/// A launcher rocket in flight, flown by the server in tick(). The shooter's
/// uid resolves the kill credit; born is the match clock it launched at.
#[derive(Clone, Debug)]
pub struct Rocket {
    pub id: i64,
    pub shooter: String,
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub px: f64,
    pub py: f64,
    pub pz: f64,
    pub vx: f64,
    pub vy: f64,
    pub vz: f64,
    pub born: f64,
}

/// One decoy ghost (the Doppelganger totem): a bot-bait copy standing where its owner faced.
#[derive(Clone, Debug)]
pub struct Decoy {
    pub id: i64,
    pub x: f64,
    pub y: f64,
    pub z: f64,
    /// Yaw in degrees — the direction the owner faced when they dropped it.
    pub yaw: f64,
    pub owner: String,
    pub until: f64,
}

/// A rift pair (Rift totem): two linked openings; a projectile entering one exits the other.
#[derive(Clone, Debug)]
pub struct Portal {
    pub id: i64,
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub pair: i64,
    pub owner: String,
    pub until: f64,
}

/// A Trapmaster mine on the deck. Owner's side is immune; the first enemy walks it.
#[derive(Clone, Debug)]
pub struct Mine {
    pub id: i64,
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub team: u8,
    pub owner: String,
}

/// A dropped Meteor Call crater warning: the mark, then the hit.
#[derive(Clone, Debug)]
pub struct MeteorMark {
    pub id: i64,
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub team: u8,
    pub owner: String,
    pub hit_at: f64,
}

/// A Rally / Kingmaker beacon on the deck.
#[derive(Clone, Debug)]
pub struct Beacon {
    pub id: i64,
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub kind: &'static str,
    pub team: u8,
    pub owner: String,
    pub until: f64,
}

/// A Bubble Fortress / Pocket Universe sphere (defends `team`).
#[derive(Clone, Debug)]
pub struct Bubble {
    pub id: i64,
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub r: f64,
    pub team: u8,
    pub owner: String,
    pub until: f64,
}

/// The shared Fate Splitter link between two players.
#[derive(Clone, Debug)]
pub struct FateLink {
    pub a: String,
    pub b: String,
    pub until: f64,
}

/// One arena event (low gravity / sandstorm / no sprint) on its own clock.
#[derive(Clone, Debug)]
pub struct ArenaEvent {
    pub kind: &'static str,
    pub until: f64,
}

/// An Arena Disaster: the map itself turns on everybody — both teams, bots included,
/// and whoever set it off. `until` is the end of the hold; `hit_at` is the next impact.
/// Hazard spots (`seed` / `zones` / `pit`) are frozen when it starts so the FX the
/// client paints and the damage this judge applies sit on the same geometry.
#[derive(Clone, Debug)]
pub struct Disaster {
    pub kind: &'static str,
    /// end of the 2s warning (the hold starts here)
    pub warn_at: f64,
    /// end of the hold
    pub until: f64,
    /// next overhead / ground impact, or the next per-second pulse
    pub hit_at: f64,
    /// Shockwave Apocalypse's ring radius (grows until it fades)
    pub ring: f64,
    /// Who Shockwave Apocalypse has already hit (once each, like the totem)
    pub hit: Vec<String>,
    /// Frozen seed for every hazard spot this disaster draws / hits (twin: V.disasterSeed)
    pub seed: u32,
    /// Toxic Fog's sticky cloud centres — visual and damage share these
    pub zones: Vec<(f64, f64)>,
    /// Sinkhole's pit centre — the mesh the client paints and the pull both use it
    pub pit: (f64, f64),
    /// Snapshot counter for impact marks (never reuses `world_k`, which moves every tick)
    pub mark_k: i64,
}

/// One overhead / ground impact about to land (Meteor, Thunder, Quake).
/// `overhead` marks the two that a shed roof stops.
#[derive(Clone, Debug)]
pub struct WarnMark {
    pub id: i64,
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub hit_at: f64,
    pub r: f64,
    pub dmg: i64,
    pub overhead: bool,
    pub quake: bool,
}

/// The Warden: a giant torso-only totem god summoned at half the kill limit.
/// While it lives the clock and the scores freeze, fighters cannot hurt each
/// other, normal drops stop and only the Warden calls disasters. It fights
/// back with arm slams (instant kill in the warning circle), laser eyes
/// (instant kill on the beam, cover saves you) and its own disasters.
#[derive(Clone, Debug)]
pub struct Warden {
    pub hp: i64,
    pub max: i64,
    pub x: f64,
    pub z: f64,
    /// When the arm-lift telegraph ends and the slam lands (0 = idle).
    pub slab_arm: f64,
    pub slab_land: f64,
    pub slab_at: f64,
    /// Laser: when the warn ends (eyes glow) and the beam runs (0 = idle).
    pub laser_warn: f64,
    pub laser_on: f64,
    pub laser_yaw: f64,
    pub laser_at: f64,
    /// Body facing (radians). The torso turns around; laser_yaw is the beam.
    pub yaw: f64,
    /// Next disaster call (0 = none).
    pub dis_at: f64,
    /// Checkpoints fired (75% / 50% / 25%).
    pub ck: [bool; WARDEN_CKPT],
    /// Each arm's remaining HP; 0 = that arm is disabled and skips its next slam.
    pub arm_l: i64,
    pub arm_r: i64,
    /// Which arm the next slam uses (0 left, 1 right, 2 both).
    pub slam_arm: u8,
    pub born: f64,
    /// Exposed Core: chest is open until this clock (0 = plated / covered).
    pub core_until: f64,
    /// Gravity Grip: warn ends, pull runs until grip_on, next cast at grip_at.
    pub grip_warn: f64,
    pub grip_on: f64,
    pub grip_at: f64,
}

impl Warden {
    /// The three torso volumes as axis-aligned boxes (waist, chest, head) plus
    /// the two arm volumes. `x`/`z` are the Warden's map centre. Box3 is
    /// `[lo_x, lo_y, lo_z, hi_x, hi_y, hi_z]`.
    pub fn boxes(&self) -> [Box3; 5] {
        let (wx, wz) = (self.x, self.z);
        let vol = |hw: f64, hd: f64, y0: f64, y1: f64, cx: f64| {
            [cx - hw, y0, wz - hd, cx + hw, y1, wz + hd]
        };
        let (bw, bd, by0, by1) = WARDEN_BOX_WAIST;
        let (ch, cd, cy0, cy1) = WARDEN_BOX_CHEST;
        let (hh, hd, hy0, hy1) = WARDEN_BOX_HEAD;
        let (ah, ad, ay0, ay1) = WARDEN_BOX_ARM;
        [
            vol(bw, bd, by0, by1, wx),
            vol(ch, cd, cy0, cy1, wx),
            vol(hh, hd, hy0, hy1, wx),
            vol(ah, ad, ay0, ay1, wx - WARDEN_ARM_X),
            vol(ah, ad, ay0, ay1, wx + WARDEN_ARM_X),
        ]
    }

    /// Index of the volume a shot hit (0 waist, 1 chest, 2 head, 3 left arm,
    /// 4 right arm). Disabled arms are not hit volumes — the shot passes to
    /// the torso behind. Head is no crit.
    pub fn hit_index(&self, o: [f64; 3], d: [f64; 3], maxd: f64) -> Option<(usize, f64)> {
        let bs = self.boxes();
        let mut best: Option<(usize, f64)> = None;
        for (i, b) in bs.iter().enumerate() {
            if i == 3 && self.arm_l <= 0 {
                continue;
            }
            if i == 4 && self.arm_r <= 0 {
                continue;
            }
            if let Some(th) = ray_box(o, d, b) {
                if th <= maxd && best.map(|bt| th < bt.1).unwrap_or(true) {
                    best = Some((i, th));
                }
            }
        }
        best
    }

    /// Is this volume the crit box (the head)?
    pub fn is_head(i: usize) -> bool {
        i == 2
    }

    pub fn is_arm(i: usize) -> bool {
        i == 3 || i == 4
    }
}

/// Torso damage while the core is plated vs exposed (arms use their own mult).
/// Twin: wardenBodyMult in games/strike.js.
fn warden_body_mult(wd: &Warden, vol: usize, t: f64) -> f64 {
    if wd.core_until <= t {
        return WARDEN_CORE_COVER_MULT;
    }
    if vol == 1 {
        WARDEN_CORE_HIT_MULT
    } else {
        1.0
    }
}

/// The Contested Capture crate: hold it CRATE_CLAIM seconds (damage interrupts).
#[derive(Clone, Debug)]
pub struct CaptureCrate {
    pub id: i64,
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub who: Option<String>,
    pub since: f64,
}

#[derive(Clone, Debug)]
pub struct Player {
    pub user: Value,
    pub slot: i64,
    pub team: u8,
    pub bot: Option<Bot>,
    pub ch: i64,
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub vx: f64,
    pub vz: f64,
    pub r: i64,
    pub pt: i64,
    pub hp: i64,
    /// The hp before this tick's blast damage (detonate's echoes report the delta).
    pub hp_original: i64,
    pub w: usize,
    pub mag: [i64; NW],
    pub res: [i64; NW],
    pub last: [VecDeque<i64>; NW],
    pub ready: i64,
    /// (weapon, started at, done at) on the player's clock.
    pub reload: Option<(usize, i64, i64)>,
    pub n: i64,
    pub kills: i64,
    pub deaths: i64,
    pub dead: bool,
    pub respawn_at: f64,
    /// When this living body first left the map (0 = on the map). VOID_SECS later the
    /// referee parachutes them back — an endless free-fall is never a soft-lock.
    pub void_at: f64,
    pub life: i64,
    pub spawn_t: f64,
    pub protect: f64,
    /// v4: this life parachute-drops — the referee lets it ride the sky for DROP_TIME after spawn.
    pub drop: bool,
    pub drop_t: f64,
    pub away: Option<f64>,
    pub gone: bool,
    pub q: Option<i64>,
    pub q0: i64,
    pub t0: f64,
    pub off: Option<f64>,
    pub qmax: Option<i64>,
    pub at: f64,
    pub air_at: f64,
    pub pb: (f64, f64),
    pub fb: (f64, f64),
    pub ob: (f64, f64),
    pub fix_at: f64,
    pub sync_at: f64,
    pub bad: u32,
    /// (server time, x, y, z)
    pub hist: VecDeque<(f64, f64, f64, f64)>,
    pub rtts: VecDeque<(f64, f64)>,
    pub rtt: f64,
    /// Totem windows (server clock): a charmed bot shoots its own side until charm_until,
    /// a paralysed one holds still until freeze_until, enemy bots can't see a cloaked player,
    /// and the shield totem's bubble holds until shield_totem_until (they still shoot).
    pub charm_until: f64,
    pub freeze_until: f64,
    pub cloak_until: f64,
    pub shield_totem_until: f64,
    /// the three movement totems' windows (server clock): wings flight, leap jumps and
    /// the speed dash — all pop on death, like the shield totem's bubble
    pub wings_until: f64,
    /// the wings totem's cruise boundary (rise+hover — the shown window); the totem's
    /// judged window (wings_until) runs past it while the flyer glides back down
    pub wings_fly: f64,
    pub leap_until: f64,
    pub speed_until: f64,
    // ---- Wave C windows / charges (server clock) ----
    pub overclock_until: f64,
    pub infchamber_until: f64,
    pub magnet_until: f64,
    pub wallrun_until: f64,
    pub rally_until: f64,
    pub fake_until: f64,
    pub pocket_until: f64,
    pub fate_until: f64,
    pub king_until: f64,
    pub hunter_until: f64,
    pub hunter_by: String,
    pub chaos_until: f64,
    pub chaos_next: f64,
    pub phoenix_until: f64,
    pub second_wind: bool,
    pub fate_share: f64,
    pub blink_left: i64,
    pub ghost_left: i64,
    pub rico_left: i64,
    pub cluster_left: i64,
    pub chain_left: i64,
    pub swap_cd: f64,
    pub radarjam_until: f64,
    /// Disaster sense clocks (server clock): walk speed × DD_SLOW_MULT while slow_until
    /// is live, and the local white-out window the client paints from the same timers.
    pub slow_until: f64,
    pub blind_until: f64,
    pub grav_until: f64,
    /// Snapshot flag bits beyond 1024 (JS bitwise is 32-bit, so stay under 2^31).
    pub flag_extra: i64,
}

fn bucket(b: &mut (f64, f64), rate: f64, burst: f64, t: f64) -> bool {
    b.0 = burst.min(b.0 + (t - b.1) * rate);
    b.1 = t;
    if b.0 < 1.0 {
        return false;
    }
    b.0 -= 1.0;
    true
}

impl Player {
    fn new(user: Value, slot: i64, ch: i64, t: f64, team: u8) -> Self {
        Self {
            user, slot, team, bot: None, ch, x: 0.0, y: 0.0, z: 0.0, vx: 0.0, vz: 0.0, r: 0, pt: 0, hp: HP,
            hp_original: HP, w: 0,
            mag: std::array::from_fn(|i| WEAPONS[i].mag), res: std::array::from_fn(|i| WEAPONS[i].reserve),
            last: std::array::from_fn(|_| VecDeque::new()), ready: -(1 << 30), reload: None, n: 0,
            kills: 0, deaths: 0, dead: false, respawn_at: 0.0, life: 0, spawn_t: t, protect: 0.0,
            void_at: 0.0,
            drop: false, drop_t: 0.0,
            away: None, gone: false, q: None, q0: 0, t0: t, off: None, qmax: None, at: t, air_at: t,
            pb: (POS_BURST, t), fb: (FIRE_BURST, t), ob: (OP_BURST, t), fix_at: -1e9, sync_at: -1e9, bad: 0,
            hist: VecDeque::new(), rtts: VecDeque::new(), rtt: 0.0,
            charm_until: 0.0, freeze_until: 0.0, cloak_until: 0.0, shield_totem_until: 0.0,
            wings_until: 0.0, wings_fly: 0.0, leap_until: 0.0, speed_until: 0.0,
            overclock_until: 0.0, infchamber_until: 0.0, magnet_until: 0.0, wallrun_until: 0.0,
            rally_until: 0.0, fake_until: 0.0, pocket_until: 0.0, fate_until: 0.0,
            king_until: 0.0, hunter_until: 0.0, hunter_by: String::new(), chaos_until: 0.0,
            chaos_next: 0.0, phoenix_until: 0.0, second_wind: false, fate_share: 0.0,
            blink_left: 0, ghost_left: 0, rico_left: 0, cluster_left: 0, chain_left: 0,
            swap_cd: 0.0, radarjam_until: 0.0, grav_until: 0.0, flag_extra: 0,
            slow_until: 0.0, blind_until: 0.0,
        }
    }

    fn is_bot(&self) -> bool {
        self.bot.is_some()
    }

    /// The drop shield: a parachute glide in flight. Nothing hurts a glider (they can
    /// still shoot out); landing or the DROP_TIME window closes it. The shield totem
    /// grants the same untouchable bubble for SHIELD_TOTEM seconds.
    fn shielded(&self, t: f64) -> bool {
        (self.drop && self.drop_t > 0.0 && (t - self.drop_t) < DROP_TIME)
            || self.shield_totem_until > t
            || self.pocket_until > t
            || (self.fake_until > t && self.fake_until - t > FAKE - 0.35)
    }
    /// The Phoenix / Second Wind pre-death check: true means the kill is cancelled.
    fn cheat_death(&mut self, t: f64) -> bool {
        if self.second_wind {
            self.second_wind = false;
            self.hp = (HP / 2).max(1);
            self.fake_until = t + 1.2;
            return true;
        }
        if self.phoenix_until > t {
            self.phoenix_until = 0.0;
            self.hp = HP;
            self.fake_until = t + 1.2;
            return true;
        }
        false
    }

    fn place(&mut self, s: [f64; 4], t: f64, m: &Map) {
        self.x = s[0];
        self.y = s[1];
        self.z = s[2];
        // v4: a life starting well above the ground is a parachute drop — the referee lets
        // it ride the sky for DROP_TIME instead of snapping it mid-glide, and clears that
        // flag once it touches down (regular ground respawns land instantly anyway).
        self.drop = s[1] > 0.5;
        self.drop_t = if self.drop { t } else { 0.0 };
        self.r = ((s[3] * 100.0) as i64).rem_euclid(36000);
        self.pt = 0;
        self.hp = HP;
        self.hp_original = HP;
        self.dead = false;
        self.mag = std::array::from_fn(|i| WEAPONS[i].mag);
        self.res = std::array::from_fn(|i| WEAPONS[i].reserve);
        // a bot draws a fresh weapon every life, launcher included (like the solo match)
        if self.bot.is_some() {
            self.w = (mb32((self.slot as u32).wrapping_mul(131)
                .wrapping_add((t * 1000.0) as i64 as u32) & 0xFFFF) * NW as f64) as usize;
        }
        self.reload = None;
        self.spawn_t = t;
        self.protect = t + PROTECT;
        self.air_at = t;
        self.void_at = 0.0;   // a place is back on the map
        self.slow_until = 0.0;
        self.blind_until = 0.0;
        self.n = 0; // the spread sequence restarts each life
        self.charm_until = 0.0;
        self.freeze_until = 0.0;
        self.shield_totem_until = 0.0;   // a death pops the shield totem's bubble too
        self.wings_until = 0.0;
        self.wings_fly = 0.0;
        self.leap_until = 0.0;
        self.speed_until = 0.0;
        self.life += 1;
        self.hist = VecDeque::from([(t, s[0], s[1], s[2])]);
        if let Some(b) = &mut self.bot {
            b.goal = None;
            b.target = None;
            b.seen_at = None;
            b.fire_at = -1e9;
            b.aim_y = s[3];
            b.aim_p = 0.0;
            b.err_y = 0.0;
            b.err_p = 0.0;
            b.err_at = 0.0;
            b.stuck_at = 0.0;
            b.stuck_x = s[0];
            b.stuck_z = s[2];
            b.slide_until = 0.0;
            b.lost_x = 0.0;
            b.lost_z = 0.0;
            b.lost_y = 0.0;
            b.target_y = 0.0;
            b.lost_until = 0.0;
            b.body = Body { x: s[0], y: s[1], z: s[2], vx: 0.0, vy: 0.0, vz: 0.0, g: true, gm: 1.0 };
            // start the patrol from the waypoint nearest this spawn
            let wps = m.patrol();
            let nearest = wps.iter().enumerate()
                .min_by(|(_, a), (_, c)| ((a.0 - s[0]).powi(2) + (a.1 - s[2]).powi(2))
                    .total_cmp(&((c.0 - s[0]).powi(2) + (c.1 - s[2]).powi(2))))
                .map(|(i, _)| i).unwrap_or(0);
            // a small per-bot offset so a squad does not all stack on the same first stop
            b.wpi = if wps.is_empty() { 0 } else { (nearest + self.slot as usize) % wps.len() };
        }
    }

    /// The sender's clock may never get more than CLOCK_LEAD ahead of ours.
    fn lead_ok(&mut self, q: i64, t: f64) -> bool {
        if self.qmax.is_none() {
            self.q0 = q;
            self.t0 = t;
            self.qmax = Some(q);
            return true;
        }
        (q - self.q0) as f64 / 100.0 <= (t - self.t0) + CLOCK_LEAD
    }

    fn seen(&mut self, q: i64, t: f64) {
        let sample = t - q as f64 / 100.0;
        if self.off.map(|o| sample < o).unwrap_or(true) {
            self.off = Some(sample);
        }
        if self.qmax.map(|m| q > m).unwrap_or(true) {
            self.qmax = Some(q);
        }
    }

    fn this_life(&self, msg: &Value) -> bool {
        as_num(msg.get("e"), 0.0, (1u64 << 30) as f64).map(|e| e as i64 == self.life).unwrap_or(true)
    }

    fn finish_reload(&mut self, q: i64) {
        if let Some((w, _, end)) = self.reload {
            if q >= end {
                let take = (WEAPONS[w].mag - self.mag[w]).min(self.res[w]);
                self.mag[w] += take;
                self.res[w] -= take;
                self.reload = None;
            }
        }
    }

    /// Where this player was at server time `at`, from the history.
    pub fn where_at(&self, at: f64) -> (f64, f64, f64) {
        let h = &self.hist;
        let (Some(first), Some(last)) = (h.front(), h.back()) else { return (self.x, self.y, self.z) };
        if at <= first.0 {
            return (first.1, first.2, first.3);
        }
        if at >= last.0 {
            return (last.1, last.2, last.3);
        }
        let (mut lo, mut hi) = (0usize, h.len() - 1);
        while hi - lo > 1 {
            let mid = (lo + hi) / 2;
            if h[mid].0 <= at {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        let (a, b) = (h[lo], h[hi]);
        let span = b.0 - a.0;
        let u = (at - a.0) / if span == 0.0 { 1.0 } else { span };
        (a.1 + (b.1 - a.1) * u, a.2 + (b.2 - a.2) * u, a.3 + (b.3 - a.3) * u)
    }
}

/// The spawn indices of one side: the first half of the list is amber's, the
/// rest cyan's.
/// v4: a respawn isn't the spawn corner the life started in — it's a parachute drop over a
/// randomly-chosen spawn point's XZ (deterministic via the life/slot seed, never rand()),
/// lifted to DROP_HEIGHT so the player glides down and steers for the DROP_TIME window.
fn drop_spawn(slot: i64, life: i64, m: &Map) -> [f64; 4] {
    let seed = ((slot as u32).wrapping_mul(131).wrapping_add((life * 1000) as u32)) & 0xFFFF;
    let k = (mb32(seed) * m.spawns.len() as f64) as usize;
    let mut s = m.spawns[k.min(m.spawns.len() - 1)];
    s[1] = DROP_HEIGHT;
    s
}

fn side_spawns(m: &Map, team: u8) -> std::ops::Range<usize> {
    let n = m.spawns.len();
    let half = n / 2;
    if team == 0 { 0..half } else { half..n }
}

/// One room's match. idle -> warmup (countdown) -> round -> done.
#[derive(Debug)]
pub struct Strike {
    /// Id of the arena this match runs on (see [`map_by_id`]).
    map_id: &'static str,
    pub phase: Phase,
    pub minutes: i64,
    pub limit: i64,
    /// The host's X in "X vs X".
    pub tsize: i64,
    /// The host-picked MP bot skill. Every bot on BOTH sides plays at this — bot-filled
    /// teams are how uneven humans meet a fair lobby, so one side can't get sharper
    /// filler bots than the other. Resolved at start() into the multipliers below.
    pub bot_diff: &'static str,
    /// aim error multiplier (higher = dumber), reaction multiplier (higher = slower).
    pub bot_aim: f64,
    pub bot_react: f64,
    /// turn multiplier (higher = snappier aim swing) and refire multiplier (higher = longer
    /// gaps between the bot's own shots — plain seconds, the client DIFFS use multipliers
    /// on the weapon interval).
    pub bot_turn: f64,
    pub bot_rate: f64,
    /// Team kill totals [amber, cyan].
    pub scores: [i64; 2],
    pub go_at: f64,
    pub ends_at: f64,
    pub players: Vec<(String, Player)>,
    pub chars: BTreeMap<String, i64>,
    pub results: Option<Value>,
    pub items: Vec<Option<f64>>,
    /// Totem slots appended to the map's pickups this round: kind per slot ("" = a map pack).
    /// Mirrors the client: base slots are health/ammo from the map JSON, totems append at
    /// runtime and reset each match, so the map file itself never changes.
    pub kinds: Vec<&'static str>,
    /// Where each appended totem slot sits (index-aligned with kinds, base slots empty).
    pub spots: Vec<[f64; 3]>,
    /// Per drop-slot cursed tag (the purple Cursed Drop drawback).
    pub cursed: Vec<bool>,
    /// When the next totem drops (round clock); None until a round starts.
    pub totem_at: Option<f64>,
    /// Totem drop counter: the seed, so every observer derives the same spot and kind.
    pub totem_k: i64,
    /// When the next loose pack drops (its own clock, independent of the totems).
    pub pack_at: Option<f64>,
    /// Loose-pack drop counter: the seed, same derivation as the totems.
    pub pack_k: i64,
    /// When the next Disaster totem drops (its own clock and ring, never mixed in).
    pub dis_at: Option<f64>,
    /// Disaster-totem drop counter: the seed, same derivation as the others.
    pub dis_k: i64,
    /// Decoy ghosts in flight: id, where it stands, whose view it copied, until when.
    pub decoys: Vec<Decoy>,
    // ---- Wave C world ----
    pub portals: Vec<Portal>,
    pub mines: Vec<Mine>,
    pub meteors: Vec<MeteorMark>,
    pub beacons: Vec<Beacon>,
    pub bubbles: Vec<Bubble>,
    pub fate: Option<FateLink>,
    pub event: Option<ArenaEvent>,
    pub event_at: Option<f64>,
    /// ---- Wave D: Arena Disasters ----
    /// The live disaster (one at a time), and when the clock may start another.
    pub disaster: Option<Disaster>,
    pub disaster_at: Option<f64>,
    /// Impacts the disaster has warned about (rings/markers) — drained at `hit_at`.
    pub warns: Vec<WarnMark>,
    pub capture: Option<CaptureCrate>,
    pub hot_at: Option<f64>,
    pub fuse_at: Option<f64>,
    pub world_k: i64,
    /// The host's "Summon the Warden" option (half-score mid-match boss).
    pub warden_opt: bool,
    /// Set once the Warden has risen this match — it is a one-shot, not a recurring event.
    pub warden_done: bool,
    /// The Warden, while it lives. None before it is summoned and after it dies.
    pub warden: Option<Warden>,
    /// ms_left frozen at the summon (the clock is parked here until it dies).
    pub warden_frozen_ms: i64,
    pub dirty: Vec<String>,
    pub shots: Vec<Value>,
    /// Blast points since the last snapshot ("b" rows): [x, y, z] in cm.
    pub booms: Vec<Value>,
    /// detonate()'s pending shot echoes, flushed by flush_echoes().
    detonate_echoes: Vec<(String, [f64; 3], i64, i64)>,
    /// Rockets in flight, flown in tick(); snap() copies them to "r" rows.
    pub rockets: Vec<Rocket>,
    /// Next rocket id (also the index the client reconciles by).
    pub rocket_k: i64,
    pub pending: Vec<(&'static str, Value)>,
    pub k: i64,
    pub sent: VecDeque<(i64, f64)>,
}

impl Default for Strike {
    fn default() -> Self {
        Self::new()
    }
}

impl Strike {
    pub fn new() -> Self {
        Self {
            map_id: "dockyard",
            phase: Phase::Idle, minutes: 5, limit: 30, tsize: 2, scores: [0, 0], go_at: 0.0, ends_at: 0.0,
            bot_diff: "normal", bot_aim: 1.0, bot_react: 1.0, bot_turn: 1.0, bot_rate: 1.0,
            players: Vec::new(), chars: BTreeMap::new(), results: None, items: Vec::new(), dirty: Vec::new(),
            kinds: Vec::new(), spots: Vec::new(), cursed: Vec::new(),
            totem_at: None, totem_k: 0, pack_at: None, pack_k: 0, dis_at: None, dis_k: 0,
            portals: Vec::new(), mines: Vec::new(), meteors: Vec::new(), beacons: Vec::new(),
            bubbles: Vec::new(), fate: None, event: None, event_at: None, capture: None,
            hot_at: None, fuse_at: None, world_k: 0,
            disaster: None, disaster_at: None, warns: Vec::new(),
            warden_opt: true, warden_done: false, warden: None, warden_frozen_ms: 0,
            decoys: Vec::new(),
            shots: Vec::new(), booms: Vec::new(), detonate_echoes: Vec::new(), rockets: Vec::new(),
            rocket_k: 0, pending: Vec::new(), k: 0, sent: VecDeque::new(),
        }
    }

    /// Apply one MP bot-skill level to every bot the match will field (aim/reaction/turn
    /// are multipliers on the BOT_* constants; rate multiplies the gap between a bot's own
    /// shots). An unknown id — including one a crafted wire message could carry — quietly
    /// falls back to normal, never to a custom super/woozy bot.
    pub fn set_bot_diff(&mut self, id: &str) {
        let (aim, react, turn, rate) = match id {
            "easy" => (3.0, 2.0, 0.5, 1.6),
            "hard" => (0.5, 0.35, 1.6, 0.8),
            "sweaty" => (0.22, 0.22, 2.2, 0.7),
            _ => (1.0, 1.0, 1.0, 1.0),
        };
        self.bot_diff = match id {
            "easy" => "easy",
            "hard" => "hard",
            "sweaty" => "sweaty",
            _ => "normal",
        };
        self.bot_aim = aim;
        self.bot_react = react;
        self.bot_turn = turn;
        self.bot_rate = rate;
    }

    /// The arena this match runs on. Always one of the shipped maps.
    pub fn map(&self) -> &'static Map {
        map_by_id(self.map_id).unwrap_or(&MAP)
    }

    pub fn player(&self, uid: &str) -> Option<&Player> {
        self.players.iter().find(|(u, _)| u == uid).map(|(_, p)| p)
    }

    pub fn player_mut(&mut self, uid: &str) -> Option<&mut Player> {
        self.players.iter_mut().find(|(u, _)| u == uid).map(|(_, p)| p)
    }

    fn idx(&self, uid: &str) -> Option<usize> {
        self.players.iter().position(|(u, _)| u == uid)
    }

    fn mark(&mut self, uid: &str) {
        if !self.dirty.iter().any(|u| u == uid) {
            self.dirty.push(uid.to_string());
        }
    }

    fn mark_all(&mut self) {
        let all: Vec<String> = self.players.iter().map(|(u, _)| u.to_string()).collect();
        for u in all {
            self.mark(&u);
        }
    }

    pub fn ms_left(&self, t: f64) -> i64 {
        match self.phase {
            Phase::Round => {
                // The Warden freezes the round clock where it stood at the summon.
                if self.warden.is_some() {
                    self.warden_frozen_ms.max(0)
                } else {
                    (((self.ends_at - t) * 1000.0) as i64).max(0)
                }
            }
            Phase::Warmup => self.minutes * 60000,
            _ => 0,
        }
    }

    fn ms(&self, at: f64) -> i64 {
        ((at - self.go_at) * 1000.0).round_ties_even() as i64
    }

    pub fn view(&self, t: f64) -> Value {
        let players: Vec<Value> = self.players.iter().map(|(_, p)| json!({
            "user": p.user, "slot": p.slot, "team": p.team, "bot": if p.is_bot() { 1 } else { 0 },
            "char": p.ch, "kills": p.kills, "deaths": p.deaths, "hp": p.hp,
            "dead": p.dead, "away": p.away.is_some(), "gone": p.gone, "w": p.w, "x": cm(p.x), "y": cm(p.y),
            "z": cm(p.z), "r": p.r, "e": p.life})).collect();
        json!({"map": self.map().id, "phase": self.phase.as_str(), "minutes": self.minutes, "limit": self.limit,
               "tsize": self.tsize, "scores": self.scores,
               "goInMs": if self.phase == Phase::Warmup { (((self.go_at - t) * 1000.0) as i64).max(0) } else { 0 },
               "msLeft": self.ms_left(t), "players": players,
               "items": self.items.iter().map(|a| if a.is_none() { 1 } else { 0 }).collect::<Vec<_>>(),
               "kinds": self.kinds.iter().map(|k| if k.is_empty() { "" } else { *k }).collect::<Vec<_>>(),
               "spots": self.spots.iter().map(|a| [cm(a[0]), cm(a[1]), cm(a[2])]).collect::<Vec<_>>(),
               "results": self.results, "chars": self.chars})
    }

    pub fn order(&self) -> Vec<String> {
        let mut v: Vec<&(String, Player)> = self.players.iter().collect();
        v.sort_by_key(|(_, p)| (p.team, -p.kills, p.deaths, p.slot));
        v.into_iter().map(|(u, _)| u.to_string()).collect()
    }

    pub fn char(&mut self, uid: &str, msg: &Value) -> Option<i64> {
        let c = as_num(msg.get("c"), -1.0, CHARS as f64)?;
        if c != c.trunc() || !(0.0..CHARS as f64).contains(&c) {
            return None;
        }
        let c = c as i64;
        self.chars.insert(uid.to_string(), c);
        if let Some(p) = self.player_mut(uid) {
            p.ch = c;
        }
        Some(c)
    }

    /// Top each side up to the host's X with bots; retire bots when humans
    /// abound (the most recently added first).
    fn fill_bots(&mut self, t: f64) {
        for team in 0u8..2 {
            let want = self.tsize.max(0) as usize;
            let mut count = self.players.iter().filter(|(_, p)| p.team == team && !p.gone).count();
            while count > want {
                let pick = self.players.iter()
                    .filter(|(_, p)| p.team == team && !p.gone && p.is_bot())
                    .map(|(_, p)| p.slot).max();
                let Some(slot) = pick else { break };
                if let Some(p) = self.players.iter_mut().find(|(_, p)| p.team == team && p.slot == slot) {
                    p.1.gone = true;
                }
                count -= 1;
            }
            let mut k = 0usize;
            while count < want {
                let uid = format!("bot-{}-{}", team, k);
                if self.idx(&uid).is_some() {
                    k += 1;
                    continue;
                }
                let slot = 1 + self.players.iter().map(|(_, p)| p.slot).max().unwrap_or(-1);
                let name = BOT_NAMES[(team as usize * 4 + k) % BOT_NAMES.len()];
                let col = BOT_COLORS[(team % 2) as usize];
                let pubv = json!({"id": uid, "name": name, "color": col, "bot": 1});
                let spawns: Vec<usize> = side_spawns(self.map(), team).collect();
                let mut p = Player::new(pubv, slot, slot % CHARS, t, team);
                p.bot = Some(Bot { think_at: t + BOT_THINK, fire_at: -1e9, ..Bot::default() });
                p.place(self.map().spawns[spawns[k % spawns.len()]], t, self.map());
                self.players.push((uid.clone(), p));
                self.mark(&uid);
                count += 1;
                k += 1;
            }
        }
    }

    /// The side a joining human takes: the short one (bots there get retired).
    fn human_side(&self, uid: &str) -> u8 {
        if let Some(p) = self.player(uid) {
            return p.team;
        }
        let mut counts = [0usize; 2];
        for (_, p) in &self.players {
            if !p.is_bot() && !p.gone {
                counts[p.team as usize] += 1;
            }
        }
        if counts[0] <= counts[1] { 0 } else { 1 }
    }

    #[allow(clippy::too_many_arguments)] // one per start option the lobby sends, plus the clock
    pub fn start(&mut self, members: &[(String, Value)], minutes: &Value, kills: &Value, tsize: &Value,
                 diff: &Value, map: &Value, warden: &Value, t: f64) -> Option<String> {
        if self.running() {
            return Some("a match is already on: the host can end it first".into());
        }
        // one skill for every bot on BOTH sides — bot-filled teams are how uneven humans
        // meet a fair lobby, so no team may get sharper fillers than the other
        self.set_bot_diff(diff.as_str().unwrap_or("normal"));
        // the host's arena: an unknown id (or none) is Harbor Dockyard, never a panic
        self.map_id = map_by_id(map.as_str().unwrap_or("dockyard")).map(|m| m.id.as_str()).unwrap_or("dockyard");
        // teams stay on the list (5 is the roster cap); minutes and kills are the host's
        // own scoreline now — any value inside the clamps, the lists are just presets
        let pick = |v: &Value, opts: &[i64], dflt: i64| {
            as_num(Some(v), 0.0, 1000.0).map(|f| f as i64).filter(|f| opts.contains(f)).unwrap_or(dflt)
        };
        let clamp_to = |v: &Value, lo: i64, hi: i64, dflt: i64| {
            // absent or unusable falls back to the default; a present value clamps into [lo, hi]
            as_num(Some(v), lo as f64, hi as f64).map(|f| f as i64).unwrap_or(dflt)
        };
        self.minutes = clamp_to(minutes, 1, 60, 5);
        self.limit = clamp_to(kills, 1, 500, 30);
        self.tsize = pick(tsize, &TEAM_SIZES, 2);
        self.phase = Phase::Warmup;
        self.go_at = t + COUNTDOWN;
        self.results = None;
        self.players = Vec::new();
        self.scores = [0, 0];
        // nothing is on the map at the start: the fixed packs stay dark (1e9 = past any
        // round, so the refill timer never lights them) and every item arrives mid-match
        // from a drop clock — totems every TOTEM_GAP, packs every PACK_GAP, each running
        // regardless of whether the previous drop was taken
        self.items = vec![Some(1e9); self.map().pickups.len()];
        self.kinds = vec![""; self.map().pickups.len()];
        self.cursed = vec![false; self.map().pickups.len()];
        self.spots = (0..self.map().pickups.len())
            .map(|j| {
                let (x, z) = self.open_spot((j as u32).wrapping_mul(2654435761).wrapping_add(17));
                [x, 0.0, z]
            })
            .collect();
        self.totem_at = None;
        self.totem_k = 0;
        self.pack_at = None;
        self.pack_k = 0;
        self.dis_at = None;
        self.dis_k = 0;
        self.event_at = Some(t + EVENT_GAP);
        self.event = None;
        self.hot_at = Some(t + 22.0);
        self.fuse_at = Some(t + 30.0);
        self.capture = None;
        self.disaster = None;
        self.disaster_at = Some(t + DIS_FIRST);
        // The Warden: opt-in from the host ("Summon the Warden" next to Map view 2D).
        self.warden_opt = warden.as_i64().map(|v| v != 0).unwrap_or(warden.as_bool().unwrap_or(true));
        self.warden = None;
        self.warden_done = false;
        self.warden_frozen_ms = 0;
        self.warns.clear();
        self.portals.clear();
        self.mines.clear();
        self.meteors.clear();
        self.beacons.clear();
        self.bubbles.clear();
        self.fate = None;
        self.world_k = 0;
        self.ensure_drop_slots();   // the recycled drop slots exist (empty) for the whole match
        self.decoys.clear();
        self.shots.clear();
        self.booms.clear();
        self.rockets.clear();
        self.pending.clear();
        self.sent.clear();
        // humans first, split evenly across the two sides
        for (k, (uid, pubv)) in members.iter().take(MAX_PLAYERS).enumerate() {
            let team = (k % 2) as u8;
            let ch = self.chars.get(uid).copied().unwrap_or(k as i64 % CHARS);
            let mut p = Player::new(pubv.clone(), k as i64, ch, t, team);
            let spawns: Vec<usize> = side_spawns(self.map(), team).collect();
            p.place(self.map().spawns[spawns[(k / 2) % spawns.len()]], t, self.map());
            self.players.push((uid.clone(), p));
        }
        self.fill_bots(t);
        self.dirty = self.players.iter().map(|(u, _)| u.to_string()).collect();
        None
    }

    pub fn end(&mut self) {
        self.phase = Phase::Idle;
        self.players.clear();
        self.results = None;
        self.shots.clear();
        self.booms.clear();
        self.rockets.clear();
        self.pending.clear();
        self.disaster = None;
        self.disaster_at = None;
        self.dis_at = None;
        self.warns.clear();
        self.warden = None;
        self.warden_done = false;
        self.warden_frozen_ms = 0;
    }

    pub fn running(&self) -> bool {
        matches!(self.phase, Phase::Warmup | Phase::Round)
    }

    pub fn active(&self) -> usize {
        self.players.iter().filter(|(_, p)| !p.gone).count()
    }

    /// A lobby member (re)joined while a match is on: a dropped player gets
    /// their score back; someone new drops in. True if the match changed.
    pub fn enter(&mut self, uid: &str, pubv: Value, t: f64) -> bool {
        if !self.running() {
            return false;
        }
        let phase = self.phase;
        if let Some(p) = self.player_mut(uid) {
            let was_gone = p.gone;
            p.away = None;
            p.gone = false;
            p.user = pubv;
            p.q = None; // a reloaded page starts a new clock
            p.off = None;
            p.qmax = None;
            p.rtts.clear();
            p.pb = (POS_BURST, t);
            p.fb = (FIRE_BURST, t);
            p.ob = (OP_BURST, t);
            if was_gone && phase == Phase::Round && !p.dead {
                p.dead = true;
                p.respawn_at = t;
            }
            self.mark(uid);
            self.fill_bots(t);
            return true;
        }
        let humans = self.players.iter().filter(|(_, p)| !p.is_bot() && !p.gone).count();
        if humans >= MAX_PLAYERS {
            return false;
        }
        let team = self.human_side(uid);
        let slot = 1 + self.players.iter().map(|(_, p)| p.slot).max().unwrap_or(-1);
        let ch = self.chars.get(uid).copied().unwrap_or(slot % CHARS);
        let mut p = Player::new(pubv, slot, ch, t, team);
        if phase == Phase::Warmup {
            let spawns: Vec<usize> = side_spawns(self.map(), team).collect();
            p.place(self.map().spawns[spawns[(slot as usize * 5) % spawns.len()]], t, self.map());
        } else {
            p.dead = true;
            p.respawn_at = t;
        }
        self.players.push((uid.to_string(), p));
        self.mark(uid);
        self.fill_bots(t);
        true
    }

    /// A player left: a blip keeps their place for GRACE, an explicit leave benches them.
    pub fn drop(&mut self, uid: &str, t: f64, blip: bool) -> bool {
        let running = self.running();
        let Some(p) = self.player_mut(uid) else { return false };
        if !running || p.gone {
            return false;
        }
        if blip {
            p.away = Some(t);
        } else {
            p.gone = true;
        }
        self.mark(uid);
        self.fill_bots(t);
        true
    }

    fn ack(&self, p: &mut Player, msg: &Value, q: Option<i64>, t: f64) {
        let (Some(kk), Some(q), Some(off)) = (as_num(msg.get("k"), 0.0, (1u64 << 30) as f64), q, p.off) else {
            return;
        };
        let kk = kk as i64;
        let arrived = as_num(msg.get("kq"), 0.0, ((1u64 << 30) - 1) as f64)
            .map(|v| v as i64)
            .filter(|kq| q - 100 <= *kq && *kq <= q)
            .unwrap_or(q);
        let mapped = arrived as f64 / 100.0 + off;
        for &(tick, at) in self.sent.iter().rev() {
            if tick == kk {
                p.rtts.push_back((t, (mapped - at).max(0.0)));
                break;
            }
            if tick < kk {
                break;
            }
        }
        while p.rtts.front().map(|r| t - r.0 > RTT_WINDOW).unwrap_or(false) {
            p.rtts.pop_front();
        }
        if !p.rtts.is_empty() {
            p.rtt = p.rtts.iter().map(|r| r.1).fold(f64::INFINITY, f64::min);
        }
    }

    /// A position frame. Returns (accepted, correction to send back).
    pub fn pos(&mut self, uid: &str, msg: &Value, t: f64) -> (bool, Option<Value>) {
        let Some(i) = self.idx(uid) else { return (false, None) };
        if self.phase != Phase::Round || self.players[i].1.is_bot() {
            return (false, None);
        }
        let mut p = std::mem::replace(&mut self.players[i].1, Player::new(Value::Null, 0, 0, t, 0));
        let res = self.pos_inner(&mut p, msg, t);
        self.players[i].1 = p;
        if res.0 {
            self.mark(uid);
            self.pickups(i, t);
        }
        res
    }

    fn pos_inner(&self, p: &mut Player, msg: &Value, t: f64) -> (bool, Option<Value>) {
        if p.dead || p.gone || !bucket(&mut p.pb, POS_RATE, POS_BURST, t) {
            return (false, None);
        }
        let g = |k: &str| as_num(msg.get(k), -1e6, 1e6);
        let (Some(x), Some(y), Some(z), Some(r)) = (g("x"), g("y"), g("z"), g("r")) else { return (false, None) };
        let pt = as_num(msg.get("p"), -9000.0, 9000.0);
        if !p.this_life(msg) {
            return (false, None);
        }
        let q = as_num(msg.get("q"), 0.0, ((1u64 << 30) - 1) as f64).map(|q| q as i64);
        let dt = match (q, p.q) {
            (Some(q), Some(pq)) => {
                if q <= pq {
                    return (false, None); // older than what we have: stale, not cheating
                }
                if p.lead_ok(q, t) { (q - pq) as f64 / 100.0 } else { -1.0 }
            }
            _ => {
                if let Some(q) = q {
                    p.lead_ok(q, t);
                }
                (t - p.at).max(0.0)
            }
        };
        let sprint = msg.get("sp").is_some_and(|v| v.as_bool().unwrap_or(false))
            && !self.event.as_ref().map(|e| e.kind == "nosprint" && e.until > t).unwrap_or(false)
            // Absolute Zero: everything is ice, so the ground barely bites — the ref
            // refuses the tall acceleration exactly like it refuses an overspeed dash
            && !self.disaster.as_ref().map(|d| d.kind == "absolutezero" && t >= d.warn_at && d.until > t).unwrap_or(false);
        // the movement totems buy room while their windows run (the server itself judged
        // them, so a raised cap can't be claimed by just sending the flag): the speed
        // totem's dash outranks the sprint flag, the leap totem's jumps rise taller
        let speed_cap = if p.speed_until > t { SPRINT_MAX_SPEED * SPEED_MULT }
            else if sprint { SPRINT_MAX_SPEED } else { MAX_SPEED };
        // Disaster slowness (quake throw / toxic choke / sink stumble / wind footing) bites
        // the same way Absolute Zero's ice does: the ref refuses the tall step.
        let speed_cap = if p.slow_until > t { speed_cap * DD_SLOW_MULT } else { speed_cap };
        let up_cap = if p.leap_until > t { JUMP_V * LEAP_MULT } else { JUMP_V };
        let (xm, ym, zm) = (x / 100.0, y / 100.0, z / 100.0);
        let b = self.map().bounds();
        let mut ok = dt >= 0.0 && b[0] <= xm && xm <= b[3] && b[1] <= ym && ym <= b[4] && b[2] <= zm && zm <= b[5];
        if ok {
            let across = (xm - p.x).hypot(zm - p.z);
            let dy = ym - p.y;
            ok = across <= speed_cap * dt + SLACK && dy <= up_cap * dt + STEP_H + SLACK
                && -dy <= FALL_MAX * dt + SLACK && overlaps(self.map(), xm, ym, zm, SHRINK).is_none();
        }
        let clock = match (q, p.off) {
            (Some(q), Some(off)) => q as f64 / 100.0 + off,
            _ => t,
        };
        let mut grounded = false;
        if ok {
            grounded = overlaps(self.map(), xm, ym - 0.1, zm, 0.0).is_some();
            // v4: a parachute-dropping life legitimately rides the sky for DROP_TIME after its
            // spawn — buy it the fall instead of snapping it back to the ground mid-glide.
            let air_let_up = p.drop && p.drop_t > 0.0 && (clock - p.drop_t) < DROP_TIME;
            // the wings totem parks the air clock too: a flyer is off the ground by design
            if !grounded && !air_let_up && p.wings_until <= t && clock - p.air_at > MAX_AIR {
                ok = false;
            }
            if grounded && p.drop && (clock - p.drop_t) >= 0.0 {
                p.drop = false;
                p.drop_t = 0.0;
            }
        }
        if !ok {
            p.bad += 1;
            if t - p.fix_at < FIX_GAP {
                return (false, None);
            }
            p.fix_at = t;
            return (false, Some(json!({"x": cm(p.x), "y": cm(p.y), "z": cm(p.z), "e": p.life})));
        }
        let mapped = match q {
            Some(q) => {
                p.seen(q, t);
                p.q = Some(q);
                q as f64 / 100.0 + p.off.unwrap_or(0.0)
            }
            None => t,
        };
        if grounded {
            p.air_at = mapped;
        }
        p.x = xm;
        p.y = ym;
        p.z = zm;
        p.r = (r as i64).rem_euclid(36000);
        p.pt = pt.map(|v| v as i64).unwrap_or(0);
        p.at = t;
        p.hist.push_back((mapped, xm, ym, zm));
        while p.hist.len() > 2 && mapped - p.hist[0].0 > HISTORY {
            p.hist.pop_front();
        }
        self.ack(p, msg, q, t);
        (true, None)
    }

    fn pickups(&mut self, i: usize, t: f64) {
        let n_map = self.map().pickups.len();
        let uid = self.players[i].0.clone();
        for j in 0..self.items.len() {
            if self.items[j].is_some() {
                continue;
            }
            // a drop slot (past the map's own packs): its spot came with the "totem"/"pack"
            // event. Loose packs refill like the map's own; totems are judged here, exactly
            // like the solo client's local take
            if j >= n_map {
                let kind = self.kinds[j];
                if kind.is_empty() {
                    continue;
                }
                let at = self.spots[j];
                let (x, y, z) = (self.players[i].1.x, self.players[i].1.y, self.players[i].1.z);
                if (x - at[0]).hypot(z - at[2]) > PICK_R || (y - at[1]).abs() > 1.2 {
                    continue;
                }
                // Cursed Drop: the power is the same, but the taker pays 15 hp up front
                if self.cursed.get(j).copied().unwrap_or(false) {
                    let p = &mut self.players[i].1;
                    p.hp = (p.hp - 15).max(1);
                }
                if kind == "health" || kind == "ammo" {
                    let p = &mut self.players[i].1;
                    if kind == "health" {
                        if p.hp >= HP {
                            continue;
                        }
                        p.hp = HP.min(p.hp + HEAL);
                    } else {
                        if (0..NW).all(|w| p.res[w] >= WEAPONS[w].reserve * 2) {
                            continue;
                        }
                        for w in 0..NW {
                            p.res[w] = (WEAPONS[w].reserve * 2).min(p.res[w] + WEAPONS[w].pack);
                        }
                    }
                    // a taken ring slot does NOT respawn in place: the drop clock replaces
                    // it with a fresh drop (new kind, new spot) within one gap — push its
                    // return past any round length so no "item" event resurrects it
                    self.items[j] = Some(t + 1e9);
                    let p = &self.players[i].1;
                    self.pending.push(("pick", json!({"i": j, "user": uid, "hp": p.hp, "res": p.res,
                                                       "kind": kind})));
                    continue;
                }
                if !self.take_totem(i, kind, t) {
                    continue;
                }
                // same for a taken totem slot: the ring replaces it, not the refill timer
                self.items[j] = Some(t + 1e9);
                let p = &self.players[i].1;
                let mut ev = json!({"i": j, "user": uid, "hp": p.hp, "res": p.res, "kind": kind});
                if kind == "teleport" {
                    // the destination, so the taker's client snaps its prediction there
                    ev["tx"] = json!(cm(p.x));
                    ev["tz"] = json!(cm(p.z));
                }
                self.pending.push(("pick", ev));
                continue;
            }
            let (x, y, z) = (self.players[i].1.x, self.players[i].1.y, self.players[i].1.z);
            let at = self.spots[j];
            let is_health = self.map().pickups[j].health;
            let p = &mut self.players[i].1;
            if (x - at[0]).hypot(z - at[2]) > PICK_R || (y - at[1]).abs() > 1.2 {
                continue;
            }
            if is_health {
                if p.hp >= HP {
                    continue;
                }
                p.hp = HP.min(p.hp + HEAL);
            } else {
                if (0..NW).all(|w| p.res[w] >= WEAPONS[w].reserve * 2) {
                    continue;
                }
                for w in 0..NW {
                    p.res[w] = (WEAPONS[w].reserve * 2).min(p.res[w] + WEAPONS[w].pack);
                }
            }
            let ev = json!({"i": j, "user": uid, "hp": p.hp, "res": p.res});
            self.items[j] = Some(t + PICKUP_BACK);
            // coming back must not be the pad you just took — re-roll the spot now so the
            // "item" event can hand clients the new ground. Mix the clock hard: a plain
            // add leaves the hash sitting on the start-of-match scatter.
            let seed = ((t * 1000.0) as u32)
                .wrapping_mul(2654435761)
                .wrapping_add((j as u32).wrapping_mul(0x9E37_79B9))
                .wrapping_add(17);
            let (nx, nz) = self.open_spot(seed);
            self.spots[j] = [nx, 0.0, nz];
            self.pending.push(("pick", ev));
        }
    }

    /// Pick up a totem slot (kind != ""): the effect is server-judged in MP, exactly what
    /// the solo client's totemApply() does locally. Returns false when nothing was eligible
    /// (the slot stays for someone it can help).
    fn take_totem(&mut self, i: usize, kind: &str, t: f64) -> bool {
        let me = self.players[i].0.clone();
        let my_team = self.players[i].1.team;
        match kind {
            "mole" => {
                // the first living enemy bot in slot order turns on its own side
                let vid = self.players.iter()
                    .filter(|(u, v)| u.as_str() != me && v.is_bot() && !v.dead && !v.gone && v.team != my_team)
                    .min_by_key(|(_, v)| v.slot).map(|(u, _)| u.to_string());
                let Some(vid) = vid else { return false };
                self.player_mut(&vid).unwrap().charm_until = t + CHARM;
                self.mark(&vid);
                true
            }
            "freeze" => {
                // the nearest living enemy bot holds still
                let (x, z) = (self.players[i].1.x, self.players[i].1.z);
                let vid = self.players.iter()
                    .filter(|(u, v)| u.as_str() != me && v.is_bot() && !v.dead && !v.gone && v.team != my_team)
                    .min_by(|a, b| ((a.1.x - x).hypot(a.1.z - z)).total_cmp(&(b.1.x - x).hypot(b.1.z - z)))
                    .map(|(u, _)| u.to_string());
                let Some(vid) = vid else { return false };
                self.player_mut(&vid).unwrap().freeze_until = t + FREEZE;
                self.mark(&vid);
                true
            }
            "decoy" => {
                // a ghost of the taker, three metres ahead of where they stand
                let (x, z, yaw) = {
                    let p = &self.players[i].1;
                    (p.x, p.z, p.r as f64 / 100.0)
                };
                let vx = yaw.to_radians().sin();
                let vz = -(yaw.to_radians().cos());
                let (mut gx, mut gz) = (x + vx * 3.0, z + vz * 3.0);
                for k in 0..20 {
                    if overlaps(self.map(), gx, 0.1, gz, 0.2).is_none() {
                        break;
                    }
                    gx = x + vx * (3.0 + k as f64 * 0.3);
                    gz = z + vz * (3.0 + k as f64 * 0.3);
                }
                self.decoys.push(Decoy { id: self.totem_k, x: gx, y: 0.0, z: gz, yaw,
                                         owner: me.clone(), until: t + DECOY });
                true
            }
            "cloak" => {
                self.players[i].1.cloak_until = t + CLOAK;
                true
            }
            "shield" => {
                // the drop shield, bottled: nothing hurts the taker while they keep shooting
                self.players[i].1.shield_totem_until = t + SHIELD_TOTEM;
                true
            }
            "wings" => {
                // the window the referee judges covers the whole flight: rise, cruise, then
                // the automatic glide back down — the client flies all three without input.
                // The shown "wings on" bit and the cruise physics use the shorter cruise
                // boundary; the extra WINGS_LAND only relaxes the air clock while gliding.
                self.players[i].1.wings_until = t + WINGS + WINGS_LAND;
                self.players[i].1.wings_fly = t + WINGS;
                true
            }
            "leap" => {
                self.players[i].1.leap_until = t + LEAP;
                true
            }
            "speed" => {
                self.players[i].1.speed_until = t + SPEED;
                true
            }
            "teleport" => {
                // instant: a random open ground spot. Seed it with the golden-ratio
                // multiplier plus a teleport-only salt — a bare `k * 2654435761`
                // collides with hash_match's own salt lattice (k=2 lands on the
                // same x as the retry chain) and two hops pile up in one spot.
                self.totem_k += 1;
                let seed = (self.totem_k as u32)
                    .wrapping_mul(0x9E37_79B9)
                    .wrapping_add(0x51ED_2701)
                    .wrapping_add(self.k as u32);
                let (tx, tz) = self.open_spot(seed);
                let p = &mut self.players[i].1;
                p.x = tx;
                p.y = 0.0;
                p.z = tz;
                p.hist = VecDeque::from([(t, tx, 0.0, tz)]);
                p.air_at = t;
                p.wings_until = 0.0;
                p.wings_fly = 0.0;
                true
            }
            // ---- Wave C ----
            "rift" => {
                // a linked pair of openings a few metres ahead; projectiles may re-exit
                self.world_k += 1;
                let (x, _y, z, yaw) = {
                    let p = &self.players[i].1;
                    (p.x, p.y + 0.9, p.z, p.r as f64 / 100.0)
                };
                let vx = yaw.to_radians().sin();
                let vz = -(yaw.to_radians().cos());
                let id = self.world_k;
                for k in 0..2 {
                    let off = if k == 0 { 2.0 } else { 8.0 };
                    let (mut gx, mut gz) = (x + vx * off, z + vz * off);
                    for n in 0..20 {
                        if overlaps(self.map(), gx, 0.1, gz, 0.2).is_none() {
                            break;
                        }
                        gx = x + vx * (off + n as f64 * 0.3);
                        gz = z + vz * (off + n as f64 * 0.3);
                    }
                    self.portals.push(Portal {
                        id: id + k as i64, x: gx, y: 0.0, z: gz,
                        pair: id + (1 - k) as i64, owner: me.clone(), until: t + RIFT,
                    });
                }
                {
                    let a = &self.portals[self.portals.len() - 2];
                    let b = &self.portals[self.portals.len() - 1];
                    self.pending.push(("rift", json!({"id": id, "x": cm(a.x), "z": cm(a.z),
                                                      "x2": cm(b.x), "z2": cm(b.z)})));
                }
                true
            }
            "mirror" => {
                // three decoy copies fanned out ahead — a Mirror Army of one
                let (x, z, yaw) = {
                    let p = &self.players[i].1;
                    (p.x, p.z, p.r as f64 / 100.0)
                };
                let base = yaw.to_radians();
                for k in 0..MIRROR_N as usize {
                    let a = base + (k as f64 - 1.0) * 0.7;
                    let (mut gx, mut gz) = (x + a.sin() * 3.5, z - a.cos() * 3.5);
                    for n in 0..20 {
                        if overlaps(self.map(), gx, 0.1, gz, 0.2).is_none() {
                            break;
                        }
                        gx = x + a.sin() * (3.5 + n as f64 * 0.3);
                        gz = z - a.cos() * (3.5 + n as f64 * 0.3);
                    }
                    self.world_k += 1;
                    self.decoys.push(Decoy {
                        id: self.world_k, x: gx, y: 0.0, z: gz,
                        yaw: yaw + (k as f64 - 1.0) * 40.0,
                        owner: me.clone(), until: t + MIRROR,
                    });
                }
                true
            }
            "gravflip" => {
                // low gravity on YOU: big soft hops for GRAVFLIP seconds
                self.players[i].1.grav_until = t + GRAVFLIP;
                self.players[i].1.flag_extra |= FLAG_GRAVFLIP;
                true
            }
            "rewind" => {
                // 3s rewind, plus a one-shot death undo for 8s
                let (tx, ty, tz) = {
                    let p = &self.players[i].1;
                    p.where_at(t - 3.0)
                };
                {
                    let p = &mut self.players[i].1;
                    p.x = tx;
                    p.y = ty;
                    p.z = tz;
                    p.vx = 0.0;
                    p.vz = 0.0;
                    p.hist = VecDeque::from([(t, tx, ty, tz)]);
                    p.air_at = t;
                    p.second_wind = true;
                }
                self.mark(&me);
                true
            }
            "shock" => {
                // a local blast that knocks living enemies away and tags them
                let (x, y, z) = {
                    let p = &self.players[i].1;
                    (p.x, p.y + 0.9, p.z)
                };
                self.booms.push(json!([cm(x), cm(y), cm(z)]));
                let team = self.players[i].1.team;
                let mut victims = Vec::new();
                for (j, (u, v)) in self.players.iter().enumerate() {
                    if u.as_str() == me || v.dead || v.gone || v.team == team {
                        continue;
                    }
                    let d = dist3([v.x, v.y + 0.9, v.z], [x, y, z]);
                    if d <= SHOCK_R {
                        victims.push(j);
                    }
                }
                for j in victims {
                    let (vx, vz) = {
                        let v = &self.players[j].1;
                        let dx = v.x - x;
                        let dz = v.z - z;
                        let ln = (dx * dx + dz * dz).sqrt().max(0.01);
                        (dx / ln, dz / ln)
                    };
                    let dead_now = {
                        let p = &mut self.players[j].1;
                        p.x = (p.x + vx * 3.0).clamp(-200.0, 200.0);
                        p.z = (p.z + vz * 3.0).clamp(-200.0, 200.0);
                        p.hist.push_back((t, p.x, p.y, p.z));
                        p.hp = (p.hp - 35).max(0);
                        p.hp <= 0
                    };
                    self.mark_all();
                    if dead_now {
                        self.kill(i, j, 3, false, t);
                    }
                }
                true
            }
            "magnet" => {
                self.players[i].1.magnet_until = t + MAGNET;
                true
            }
            "chain" => {
                self.players[i].1.chain_left += CHAIN_N;
                true
            }
            "trap" => {
                let team = self.players[i].1.team;
                let (x, z) = {
                    let p = &self.players[i].1;
                    (p.x, p.z)
                };
                for k in 0..TRAP_N as usize {
                    let a = (self.world_k as f64 + k as f64) * 2.399963;
                    let (mut gx, mut gz) = (x + a.cos() * 1.5, z + a.sin() * 1.5);
                    for n in 0..16 {
                        if overlaps(self.map(), gx, 0.1, gz, 0.2).is_none() {
                            break;
                        }
                        gx = x + a.cos() * (1.5 + n as f64 * 0.25);
                        gz = z + a.sin() * (1.5 + n as f64 * 0.25);
                    }
                    self.world_k += 1;
                    self.mines.push(Mine {
                        id: self.world_k, x: gx, y: 0.0, z: gz,
                        team, owner: me.clone(),
                    });
                }
                true
            }
            "mark" => {
                // Hunter's Mark: every enemy is painted for your side
                let team = self.players[i].1.team;
                for (_, v) in self.players.iter_mut() {
                    if v.team != team && !v.dead && !v.gone {
                        v.hunter_until = t + HUNTER;
                        v.hunter_by = me.clone();
                    }
                }
                self.mark_all();
                true
            }
            "blink" => {
                self.players[i].1.blink_left += BLINK_N;
                true
            }
            "bubble" => {
                let team = self.players[i].1.team;
                let (x, y, z) = {
                    let p = &self.players[i].1;
                    (p.x, p.y + 0.9, p.z)
                };
                self.world_k += 1;
                self.bubbles.push(Bubble {
                    id: self.world_k, x, y, z, r: 4.0,
                    team, owner: me.clone(), until: t + BUBBLE,
                });
                true
            }
            "wallrun" => {
                self.players[i].1.wallrun_until = t + WALLRUN;
                true
            }
            "secondwind" => {
                self.players[i].1.second_wind = true;
                true
            }
            "fakedeath" => {
                self.players[i].1.fake_until = t + FAKE;
                true
            }
            "ghost" => {
                self.players[i].1.ghost_left += GHOST_N;
                true
            }
            "cluster" => {
                self.players[i].1.cluster_left += CLUSTER_N;
                true
            }
            "overclock" => {
                self.players[i].1.overclock_until = t + OVERCLOCK;
                true
            }
            "ricochet" => {
                self.players[i].1.rico_left += RICO_N;
                true
            }
            "infchamber" => {
                self.players[i].1.infchamber_until = t + INFCHAMBER;
                true
            }
            "bodyswap" => {
                if t < self.players[i].1.swap_cd {
                    return false;
                }
                let (x, z) = (self.players[i].1.x, self.players[i].1.z);
                let team = self.players[i].1.team;
                let vid = self.players.iter()
                    .filter(|(u, v)| u.as_str() != me && !v.dead && !v.gone && v.team != team)
                    .min_by(|a, b| ((a.1.x - x).hypot(a.1.z - z)).total_cmp(&(b.1.x - x).hypot(b.1.z - z)))
                    .map(|(u, _)| u.to_string());
                let Some(vid) = vid else { return false };
                let (ax, ay, az, bx, by, bz) = {
                    let a = &self.players[i].1;
                    let b = self.player(&vid).unwrap();
                    (a.x, a.y, a.z, b.x, b.y, b.z)
                };
                {
                    let a = &mut self.players[i].1;
                    a.x = bx;
                    a.y = by;
                    a.z = bz;
                    a.hist = VecDeque::from([(t, bx, by, bz)]);
                    a.swap_cd = t + 8.0;
                }
                if let Some(b) = self.player_mut(&vid) {
                    b.x = ax;
                    b.y = ay;
                    b.z = az;
                    b.hist = VecDeque::from([(t, ax, ay, az)]);
                }
                self.mark_all();
                true
            }
            "rally" => {
                let team = self.players[i].1.team;
                let (x, y, z) = {
                    let p = &self.players[i].1;
                    (p.x, p.y, p.z)
                };
                self.world_k += 1;
                self.beacons.push(Beacon {
                    id: self.world_k, x, y, z, kind: "rally",
                    team, owner: me.clone(), until: t + RALLY,
                });
                true
            }
            "meteor" => {
                // paint a crater on the nearest enemy, or dead ahead
                let (x, z) = (self.players[i].1.x, self.players[i].1.z);
                let team = self.players[i].1.team;
                let mut mx = x;
                let mut mz = z;
                let mut best = f64::INFINITY;
                for (_, v) in self.players.iter() {
                    if v.team == team || v.dead || v.gone {
                        continue;
                    }
                    let d = (v.x - x).hypot(v.z - z);
                    if d < best {
                        best = d;
                        mx = v.x;
                        mz = v.z;
                    }
                }
                if best > 200.0 {
                    let yaw = self.players[i].1.r as f64 / 100.0;
                    let vx = yaw.to_radians().sin();
                    let vz = -(yaw.to_radians().cos());
                    mx = x + vx * 8.0;
                    mz = z + vz * 8.0;
                }
                self.world_k += 1;
                self.meteors.push(MeteorMark {
                    id: self.world_k, x: mx, y: 0.0, z: mz,
                    team, owner: me.clone(), hit_at: t + 1.6,
                });
                true
            }
            "chaos" => {
                self.players[i].1.chaos_until = t + CHAOS;
                self.players[i].1.chaos_next = t + 1.5;
                true
            }
            "phoenix" => {
                self.players[i].1.phoenix_until = t + PHOENIX;
                true
            }
            "pocket" => {
                self.players[i].1.pocket_until = t + POCKET;
                true
            }
            "fate" => {
                // share half of every wound with the nearest other player (any team)
                let (x, z) = (self.players[i].1.x, self.players[i].1.z);
                let vid = self.players.iter()
                    .filter(|(u, v)| u.as_str() != me && !v.dead && !v.gone)
                    .min_by(|a, b| ((a.1.x - x).hypot(a.1.z - z)).total_cmp(&(b.1.x - x).hypot(b.1.z - z)))
                    .map(|(u, _)| u.to_string());
                let Some(vid) = vid else { return false };
                self.players[i].1.fate_until = t + FATE;
                if let Some(b) = self.player_mut(&vid) {
                    b.fate_until = t + FATE;
                }
                self.fate = Some(FateLink { a: me.clone(), b: vid, until: t + FATE });
                self.mark_all();
                true
            }
            "king" => {
                let team = self.players[i].1.team;
                for (_, v) in self.players.iter_mut() {
                    if v.team == team && !v.dead && !v.gone {
                        v.king_until = t + KING;
                    }
                }
                self.world_k += 1;
                let (x, y, z) = {
                    let p = &self.players[i].1;
                    (p.x, p.y, p.z)
                };
                self.beacons.push(Beacon {
                    id: self.world_k, x, y, z, kind: "king",
                    team, owner: me.clone(), until: t + KING,
                });
                self.mark_all();
                true
            }
            "radarjam" => {
                let team = self.players[i].1.team;
                for (_, v) in self.players.iter_mut() {
                    if v.team == team {
                        v.radarjam_until = t + RADARJAM;
                    }
                }
                self.mark_all();
                true
            }
            // ---- Wave D: Arena Disasters. Everyone suffers, the taker included.
            // Taking one unleashes the matching map-wide hazard; a Shield totem holder
            // is the one person a disaster cannot touch (shielded() is checked per hit).
            k if DISASTERS.contains(&k) => {
                // DISASTERS members are 'static; hand the table's copy over
                let dis = *DISASTERS.iter().find(|d| **d == k).unwrap();
                self.start_disaster(dis, t)
            }
            _ => false,
        }
    }

    /// Unleash an arena-wide disaster. `taker` may be "" for a clock-started one.
    /// Returns false when another disaster is already running (one at a time).
    pub fn start_disaster(&mut self, kind: &'static str, t: f64) -> bool {
        if !DISASTERS.contains(&kind) {
            return false;
        }
        if self.disaster.as_ref().map(|d| d.until > t).unwrap_or(false) {
            return false;
        }
        let hold = match kind {
            "sandstorm" => DIS_SANDSTORM,
            "meteorshower" => DIS_METEOR,
            "hurricane" => DIS_HURRICANE,
            "thunder" => DIS_THUNDER,
            "earthquake" => DIS_EARTHQUAKE,
            "shockring" => DIS_SHOCKRING,
            "toxicfog" => DIS_TOXICFOG,
            "absolutezero" => DIS_ZERO,
            "sinkhole" => DIS_SINKHOLE,
            _ => DIS_EMP,
        };
        self.world_k += 1;
        let seed = (self.world_k as u32).wrapping_mul(0x9E37_79B9).wrapping_add(17);
        let zones = if kind == "toxicfog" {
            self.dis_zones_near(seed, DD_TOXIC_ZONES, &self.live_spots())
        } else {
            Vec::new()
        };
        let pit = if kind == "sinkhole" {
            self.dis_spot(seed.wrapping_mul(2654435761).wrapping_add(47), 5)
        } else {
            (0.0, 0.0)
        };
        self.disaster = Some(Disaster {
            kind,
            warn_at: t + DIS_WARN,
            until: t + DIS_WARN + hold,
            hit_at: t + DIS_WARN,
            ring: 0.0,
            hit: Vec::new(),
            seed,
            zones,
            pit,
            mark_k: 0,
        });
        self.pending.push((
            "disaster",
            json!({
                "kind": kind,
                "warn": (DIS_WARN * 1000.0) as i64,
                "dur": (hold * 1000.0) as i64,
            }),
        ));
        self.mark_all();
        true
    }

    /// The drop-slot layout: [first totem slot, first pack slot, end). Past the map's own
    /// packs — fixed all match, so a drop's index means the same thing everywhere.
    fn drop_rings(&self) -> (usize, usize, usize, usize) {
        let n_map = self.map().pickups.len();
        (n_map, n_map + DROP_SLOTS, n_map + DROP_SLOTS + PACK_SLOTS,
         n_map + DROP_SLOTS + PACK_SLOTS + DIS_SLOTS)
    }

    /// The drop-slot entries exist (kind "" = empty) for the whole round; drops rewrite
    /// them round-robin. Called at start and before any drop lands.
    fn ensure_drop_slots(&mut self) {
        let end = self.drop_rings().3;
        while self.kinds.len() < end {
            self.items.push(None);
            self.kinds.push("");
            self.spots.push([0.0, 0.0, 0.0]);
            self.cursed.push(false);
        }
    }

    /// A random open spot for a drop: hashed from the seed across the arena bounds,
    /// nudged off any box. Never a fixed pad — every drop / refill lands somewhere new.
    fn open_spot(&self, seed: u32) -> (f64, f64) {
        let b = self.map().bounds();
        let pad = 2.0;
        let x0 = b[0] + pad;
        let z0 = b[2] + pad;
        let w = ((b[3] - pad) - x0).max(1.0);
        let d = ((b[5] - pad) - z0).max(1.0);
        let mut x = x0 + hash_match(seed, 2) * w;
        let mut z = z0 + hash_match(seed, 3) * d;
        for k in 0..60 {
            // standable, not just "fits a shrunk probe": the taker's body (shrink 0)
            // must not clip a crate, or pos() rejects the take. Rehash with an
            // avalanche step — XORing the low bits of `k` barely moves the sample.
            // (k+1: k=0 would re-hash the seed we just rejected.)
            if overlaps(self.map(), x, 0.1, z, 0.0).is_none() {
                break;
            }
            let s2 = seed.wrapping_add(((k as u32) + 1).wrapping_mul(2654435761));
            x = x0 + hash_match(s2, 2) * w;
            z = z0 + hash_match(s2, 3) * d;
        }
        (x, z)
    }

    /// A disaster hazard spot (toxic cloud, sinkhole pit, impact mark) hashed from the
    /// disaster's own frozen seed. Twin: disSpot in games/strike.js. The FX paints THIS
    /// point and the judge damages THIS point — one geometry, both sides.
    fn dis_spot(&self, seed: u32, salt: u32) -> (f64, f64) {
        let b = self.map().bounds();
        let pad = 2.0;
        let x0 = b[0] + pad;
        let z0 = b[2] + pad;
        let w = ((b[3] - pad) - x0).max(1.0);
        let d = ((b[5] - pad) - z0).max(1.0);
        let mut x = x0 + hash_match(seed, salt) * w;
        let mut z = z0 + hash_match(seed, salt + 100) * d;
        for k in 0..60 {
            if overlaps(self.map(), x, 0.1, z, 0.0).is_none() {
                break;
            }
            let s2 = seed.wrapping_add(((k as u32) + 1).wrapping_mul(2654435761));
            x = x0 + hash_match(s2, salt) * w;
            z = z0 + hash_match(s2, salt + 100) * d;
        }
        (x, z)
    }

    /// Sticky hazard spots near live bodies so a disaster can actually connect: the
    /// first few sit on players (offset by the seed, never random), the rest scatter.
    /// Frozen at start_disaster — the clouds you see are the clouds that hurt.
    fn dis_zones_near(&self, seed: u32, n: usize, pts: &[(f64, f64)]) -> Vec<(f64, f64)> {
        let mut out = Vec::with_capacity(n);
        for i in 0..n {
            if !pts.is_empty() && i < pts.len() + 2 {
                let (px, pz) = pts[i % pts.len()];
                out.push((
                    px + (hash_match(seed, 200 + i as u32) - 0.5) * 5.0,
                    pz + (hash_match(seed, 300 + i as u32) - 0.5) * 5.0,
                ));
            } else {
                out.push(self.dis_spot(seed, 40 + i as u32));
            }
        }
        out
    }

    /// Live bodies as (x, z) — every player still in the round (bots included).
    fn live_spots(&self) -> Vec<(f64, f64)> {
        self.players
            .iter()
            .filter(|(_, p)| !p.dead && !p.gone)
            .map(|(_, p)| (p.x, p.z))
            .collect()
    }

    /// True while the mid-match boss is on the field. PvP is off, scores and the
    /// round clock are frozen, and the drop / auto-disaster clocks are suspended.
    pub fn warden_live(&self) -> bool {
        self.warden.is_some()
    }

    /// Apply one shot to the Warden. Arms soak at WARDEN_ARM_DMG_MULT on their own
    /// pool (0 = disabled, shots then pass to the torso). The head is no weak point:
    /// never apply the weapon head-crit here.
    fn warden_hit(&mut self, w: usize, o: [f64; 3], d: [f64; 3], reach: f64, t: f64) -> Option<(i64, bool)> {
        let (head, arm_side, dmg) = {
            let wd = self.warden.as_ref()?;
            let (vol, _th) = wd.hit_index(o, d, reach)?;
            let head = false;
            let arm_side = if vol == 3 { Some(0u8) } else if vol == 4 { Some(1u8) } else { None };
            let base = WEAPONS[w].damage;
            // arms soak on their own pool; the torso is plated until the core opens
            let dmg = if arm_side.is_some() {
                ((base as f64) * WARDEN_ARM_DMG_MULT).round() as i64
            } else {
                ((base as f64) * warden_body_mult(wd, vol, t)).round() as i64
            };
            (head, arm_side, dmg.max(0))
        };
        if dmg <= 0 {
            return Some((0, head));
        }
        if let Some(side) = arm_side {
            let wd = self.warden.as_mut()?;
            if side == 0 {
                wd.arm_l = (wd.arm_l - dmg).max(0);
            } else {
                wd.arm_r = (wd.arm_r - dmg).max(0);
            }
        } else if let Some(wd) = self.warden.as_mut() {
            wd.hp = (wd.hp - dmg).max(0);
        }
        self.warden_after_damage(t);
        Some((dmg, head))
    }

    /// Launcher splash on the Warden: the nearest live volume takes blast_damage
    /// from the detonation point. Players take nothing while the Warden lives.
    fn warden_blast(&mut self, at: [f64; 3], t: f64) {
        let mut best: Option<(usize, bool, i64)> = None;
        {
            let Some(wd) = self.warden.as_ref() else { return };
            for (i, b) in wd.boxes().iter().enumerate() {
                if i == 3 && wd.arm_l <= 0 {
                    continue;
                }
                if i == 4 && wd.arm_r <= 0 {
                    continue;
                }
                let cx = at[0].clamp(b[0], b[3]);
                let cy = at[1].clamp(b[1], b[4]);
                let cz = at[2].clamp(b[2], b[5]);
                let dist = dist3(at, [cx, cy, cz]);
                if dist > BLAST_R {
                    continue;
                }
                let direct = dist < DIRECT_R;
                let dmg = blast_damage(dist, direct);
                if dmg > 0 && best.map(|bd| dmg > bd.2).unwrap_or(true) {
                    best = Some((i, Warden::is_head(i), dmg));
                }
            }
        }
        let Some((vol, _head, dmg)) = best else { return };
        if dmg <= 0 {
            return;
        }
        if Warden::is_arm(vol) {
            let Some(wd) = self.warden.as_mut() else { return };
            if vol == 3 {
                wd.arm_l = (wd.arm_l - dmg).max(0);
            } else {
                wd.arm_r = (wd.arm_r - dmg).max(0);
            }
        } else if let Some(wd) = self.warden.as_mut() {
            let dealt = ((dmg as f64) * warden_body_mult(wd, vol, t)).round() as i64;
            wd.hp = (wd.hp - dealt).max(0);
        }
        self.warden_after_damage(t);
    }

    /// After any Warden damage: fire the 75/50/25 checkpoints (loot ring) and death.
    fn warden_after_damage(&mut self, t: f64) {
        let Some(wd) = self.warden.as_ref() else { return };
        let (hp, max) = (wd.hp, wd.max);
        let mut fire_ck: Option<usize> = None;
        if let Some(wd) = self.warden.as_mut() {
            const FRACS: [f64; WARDEN_CKPT] = [0.75, 0.50, 0.25];
            for (i, f) in FRACS.iter().enumerate() {
                if !wd.ck[i] && (hp as f64) <= (max as f64 * *f) {
                    wd.ck[i] = true;
                    fire_ck = Some(i);
                    break;
                }
            }
        }
        if let Some(ck) = fire_ck {
            self.pending.push((
                "warden",
                json!({"ev": "warden", "phase": "ckpt", "ck": ck, "name": WARDEN_CHECK_NAMES[ck + 1],
                       "hp": hp, "max": max}),
            ));
            self.warden_loot(ck, t);
            // checkpoint identities: I shoves everyone clear, II cracks the core open
            if ck == 0 {
                self.warden_shock(t);
            } else if ck == 1 {
                if let Some(wd) = self.warden.as_mut() {
                    wd.core_until = wd.core_until.max(t + WARDEN_CK2_EXPOSE);
                }
            }
            self.warden_after_damage(t);
            return;
        }
        if hp <= 0 {
            self.warden_death(t);
        }
    }

    /// Checkpoint I: a shockwave shoves every fighter clear of the body (not a slam).
    fn warden_shock(&mut self, t: f64) {
        let Some(wd) = self.warden.as_ref() else { return };
        let (gx, gz) = (wd.x, wd.z);
        let mut shoves: Vec<(usize, f64, f64)> = Vec::new();
        for (j, (_, v)) in self.players.iter().enumerate() {
            if v.dead || v.gone || self.disaster_immune(j, t) {
                continue;
            }
            let (dx, dz) = (v.x - gx, v.z - gz);
            let d = (dx * dx + dz * dz).sqrt().max(0.15);
            shoves.push((j, dx / d, dz / d));
        }
        for (j, kx, kz) in shoves {
            let p = &mut self.players[j].1;
            p.x = (p.x + kx * WARDEN_CK1_PUSH).clamp(-200.0, 200.0);
            p.z = (p.z + kz * WARDEN_CK1_PUSH).clamp(-200.0, 200.0);
            p.hist.push_back((t, p.x, p.y, p.z));
        }
    }

    /// Checkpoint loot: one of each non-disaster totem plus a health pack, scattered
    /// away from the body (r = 12..20, hashed angles). One-shot slots.
    fn warden_loot(&mut self, ckpt: usize, t: f64) {
        let _ = t;
        let Some(wd) = self.warden.as_ref() else { return };
        let (wx, wz) = (wd.x, wd.z);
        let born = wd.born as u32;
        let mut kinds: Vec<&'static str> = TOTEM_KINDS
            .iter()
            .copied()
            .filter(|k| !DISASTERS.contains(k))
            .collect();
        kinds.push("health");
        self.ensure_drop_slots();
        // one-shot loot ring lives past the recycled drop slots (never round-robined)
        let base = self.kinds.len();
        for k in kinds.iter() {
            self.items.push(None);
            self.kinds.push(k);
            self.spots.push([0.0, 0.0, 0.0]);
            self.cursed.push(false);
        }
        let seed = born
            .wrapping_mul(0x9E37_79B9)
            .wrapping_add(0x57A7_1001)
            .wrapping_add((ckpt as u32).wrapping_mul(64));
        for (i, kind) in kinds.iter().enumerate() {
            let salt = 200 + (ckpt as u32) * 64 + i as u32;
            // scatter clear of the body (fists land at |x|≈8.7, chest half-width 6.6) —
            // even slots bias +Z, odd −Z so the burst fans both ways
            let side_z = if i % 2 == 0 { 1.0 } else { -1.0 };
            let mut ang = side_z * (std::f64::consts::PI * 0.5)
                + (hash_match(seed, salt) - 0.5) * std::f64::consts::PI * 1.4;
            let mut rad = WARDEN_LOOT_R0 + hash_match(seed, salt.wrapping_add(17)) * WARDEN_LOOT_RSPAN;
            let mut x = wx + ang.cos() * rad;
            let mut z = wz + ang.sin() * rad;
            for k in 0..24 {
                if (x - wx).hypot(z - wz) >= WARDEN_LOOT_RMIN
                    && overlaps(self.map(), x, 0.1, z, 0.0).is_none()
                {
                    break;
                }
                let s2 = seed
                    .wrapping_add(((k as u32) + 1).wrapping_mul(2654435761))
                    .wrapping_add(i as u32);
                ang = side_z * (std::f64::consts::PI * 0.5)
                    + (hash_match(s2, salt) - 0.5) * std::f64::consts::PI * 1.4;
                rad = WARDEN_LOOT_R0 + hash_match(s2, salt.wrapping_add(17)) * WARDEN_LOOT_RSPAN;
                x = wx + ang.cos() * rad;
                z = wz + ang.sin() * rad;
            }
            let slot = base + i;
            self.spots[slot] = [x, 0.0, z];
            self.items[slot] = None;
            if self.cursed.len() <= slot {
                self.cursed.resize(slot + 1, false);
            }
            self.cursed[slot] = false;
            let tag = if *kind == "health" { "warden-pack" } else { "warden" };
            if *kind == "health" {
                self.pending.push((
                    "pack",
                    json!({"i": slot, "kind": "health", "x": cm(x), "z": cm(z), "tag": tag}),
                ));
            } else {
                self.pending.push((
                    "totem",
                    json!({"i": slot, "kind": kind, "x": cm(x), "z": cm(z), "tag": tag}),
                ));
            }
        }
    }

    /// The Warden dies: the match is back on — clocks restart, the score and the
    /// round clock unfreeze.
    fn warden_death(&mut self, t: f64) {
        let Some(wd) = self.warden.take() else { return };
        self.pending.push((
            "warden",
            json!({"ev": "warden", "phase": "dead", "hp": 0, "max": wd.max}),
        ));
        self.totem_at = Some(t + TOTEM_GAP);
        self.pack_at = Some(t + PACK_GAP);
        self.dis_at = Some(t + DIS_GAP_DROP);
        self.disaster_at = Some(t + DIS_FIRST);
        self.ends_at = t + (self.warden_frozen_ms as f64) / 1000.0;
        self.warden_frozen_ms = 0;
        self.warden_done = true;
        self.mark_all();
    }

    /// Summon the Warden at map centre. Max HP scales with the fighters on the
    /// field; the round clock freezes and every drop / auto-disaster clock stops.
    fn warden_summon(&mut self, t: f64) {
        let fighters = self
            .players
            .iter()
            .filter(|(_, p)| !p.dead && !p.gone)
            .count() as i64;
        let max = (WARDEN_HP_PER * fighters).clamp(WARDEN_MIN_HP, WARDEN_MAX_HP);
        let b = self.map().bounds();
        let cx = (b[0] + b[3]) * 0.5;
        let cz = (b[2] + b[5]) * 0.5;
        self.warden_frozen_ms = self.ms_left(t);
        self.warden = Some(Warden {
            hp: max,
            max,
            x: cx,
            z: cz,
            slab_arm: 0.0,
            slab_land: 0.0,
            slab_at: t + 2.5,
            laser_warn: 0.0,
            laser_on: 0.0,
            laser_yaw: 0.0,
            laser_at: t + WARDEN_LASER_CD,
            yaw: 0.0,
            dis_at: t + WARDEN_DIS_CD,
            ck: [false; WARDEN_CKPT],
            arm_l: WARDEN_ARM_HP,
            arm_r: WARDEN_ARM_HP,
            slam_arm: 0,
            born: t,
            core_until: 0.0,
            grip_warn: 0.0,
            grip_on: 0.0,
            grip_at: t + 8.0,
        });
        // suspend the normal drops and the auto-disaster clock — only the Warden
        // may drop non-disaster loot or call a disaster while it lives
        self.totem_at = None;
        self.pack_at = None;
        self.dis_at = None;
        self.disaster_at = None;
        self.pending.push((
            "warden",
            json!({"ev": "warden", "phase": "rise", "hp": max, "max": max,
                   "x": cm(cx), "z": cm(cz),
                   "armL": WARDEN_ARM_HP, "armR": WARDEN_ARM_HP}),
        ));
        self.mark_all();
    }

    /// One tick of the Warden: summon at half the kill limit, then slam / laser /
    /// disaster attacks and the checkpoint / death bookkeeping.
    #[allow(clippy::too_many_lines)]
    fn warden_tick(&mut self, t: f64) {
        if self.warden.is_none() {
            if !self.warden_opt || self.warden_done {
                return;
            }
            let half = ((self.limit as f64) * WARDEN_TRIGGER).ceil() as i64;
            if self.scores[0] >= half || self.scores[1] >= half {
                self.warden_summon(t);
            }
            return;
        }
        // --- body turn: the torso faces around the arena (twin of JS wardenTick) ---
        {
            let Some(wd) = self.warden.as_mut() else { return };
            if wd.laser_on > 0.0 && t >= wd.laser_warn {
                wd.yaw = wd.laser_yaw;
            } else {
                let turn_n = ((t - wd.born) / 6.0).floor() as u32;
                let t_yaw = hash_match(wd.born as u32 ^ 0xB0D9, 40 + turn_n) * std::f64::consts::TAU;
                let y0 = wd.yaw;
                let mut yd = (t_yaw - y0 + std::f64::consts::PI * 3.0) % (std::f64::consts::TAU)
                    - std::f64::consts::PI;
                if yd < -std::f64::consts::PI {
                    yd += std::f64::consts::TAU;
                }
                let dt = 1.0 / HZ;
                wd.yaw = y0 + yd * (dt / 2.0).min(1.0);
            }
        }
        // --- slam telegraph / land ---
        {
            let Some(wd) = self.warden.as_mut() else { return };
            if wd.slab_arm > 0.0 && t >= wd.slab_arm {
                // the slam lands: everyone inside each active arm's circle dies
                let (wx, wz) = (wd.x, wd.z);
                let arm = wd.slam_arm;
                let (al, ar) = (wd.arm_l, wd.arm_r);
                wd.slab_arm = 0.0;
                wd.slab_land = 0.0;
                let mut pts: Vec<(f64, f64)> = Vec::new();
                if (arm == 0 || arm == 2) && al > 0 {
                    pts.push((wx - WARDEN_ARM_X, wz));
                }
                if (arm == 1 || arm == 2) && ar > 0 {
                    pts.push((wx + WARDEN_ARM_X, wz));
                }
                self.world_k += 1;
                for (sx, sz) in &pts {
                    self.warns.push(WarnMark {
                        id: self.world_k,
                        x: *sx,
                        y: 0.0,
                        z: *sz,
                        hit_at: t,
                        r: WARDEN_SLAB_R,
                        dmg: 0,
                        overhead: false,
                        quake: true,
                    });
                }
                let mut victims: Vec<usize> = Vec::new();
                let mut blasts: Vec<(usize, f64, f64, f64)> = Vec::new(); // (j, x, z, dsl)
                for (j, (_, v)) in self.players.iter().enumerate() {
                    if v.dead || v.gone {
                        continue;
                    }
                    for (sx, sz) in &pts {
                        let dsl = (v.x - *sx).hypot(v.z - *sz);
                        if dsl <= WARDEN_SLAB_R_HIT {
                            victims.push(j);
                            break;
                        }
                        if dsl <= WARDEN_SLAB_KNOCK {
                            // the blast blows everyone near the smash away and hurts
                            blasts.push((j, *sx, *sz, dsl));
                            break;
                        }
                    }
                }
                for (j, sx, sz, dsl) in blasts {
                    let lnsl = dsl.max(0.05);
                    let (px, pz) = {
                        let v = &self.players[j].1;
                        ((v.x - sx) / lnsl, (v.z - sz) / lnsl)
                    };
                    let dead_now = {
                        let p = &mut self.players[j].1;
                        p.x = (p.x + px * WARDEN_SLAB_KNOCK_PUSH).clamp(-200.0, 200.0);
                        p.z = (p.z + pz * WARDEN_SLAB_KNOCK_PUSH).clamp(-200.0, 200.0);
                        p.hist.push_back((t, p.x, p.y, p.z));
                        p.hp = (p.hp - WARDEN_SLAB_BLAST_DMG).max(0);
                        p.hp <= 0
                    };
                    if dead_now {
                        victims.push(j);
                    }
                }
                for j in victims {
                    self.env_kill(j, "warden-slam", t);
                }
                // the slam staggers the torso and cracks the chest core open
                if let Some(wd) = self.warden.as_mut() {
                    wd.core_until = t + WARDEN_CORE_EXPOSE;
                }
                return;
            }
        }
        // start a slam telegraph (arm-lift) when the CD is up
        {
            let Some(wd) = self.warden.as_mut() else { return };
            if wd.slab_arm <= 0.0 && wd.slab_land <= 0.0 && t >= wd.slab_at {
                let slam_n = ((t - wd.born) / WARDEN_SLAB_CD.max(0.1)) as u32;
                let mut arm: u8 = if (slam_n + 1).is_multiple_of(3) {
                    2
                } else if hash_match(wd.born as u32 ^ 0x57A9, 90 + slam_n) < 0.5 {
                    0
                } else {
                    1
                };
                // a disabled arm skips its slam; both disabled = no slam
                if arm == 0 && wd.arm_l <= 0 {
                    arm = if wd.arm_r > 0 { 1 } else { 9 };
                } else if arm == 1 && wd.arm_r <= 0 {
                    arm = if wd.arm_l > 0 { 0 } else { 9 };
                } else if arm == 2 {
                    if wd.arm_l <= 0 && wd.arm_r <= 0 {
                        arm = 9;
                    } else if wd.arm_l <= 0 {
                        arm = 1;
                    } else if wd.arm_r <= 0 {
                        arm = 0;
                    }
                }
                if arm == 9 {
                    wd.slab_at = t + 1.0;
                } else {
                    let (wx, wz) = (wd.x, wd.z);
                    wd.slam_arm = arm;
                    wd.slab_arm = t + WARDEN_SLAB_ARM;
                    wd.slab_land = t + WARDEN_SLAB_ARM;
                    wd.slab_at = t + WARDEN_SLAB_ARM + WARDEN_SLAB_CD;
                    let wire_at = t + (WARDEN_SLAB_ARM - WARDEN_SLAB_WIRE).max(0.0);
                    self.world_k += 1;
                    let mut pts: Vec<(f64, f64)> = Vec::new();
                    if arm == 0 || arm == 2 {
                        pts.push((wx - WARDEN_ARM_X, wz));
                    }
                    if arm == 1 || arm == 2 {
                        pts.push((wx + WARDEN_ARM_X, wz));
                    }
                    for (sx, sz) in pts {
                        self.warns.push(WarnMark {
                            id: self.world_k,
                            x: sx,
                            y: 0.0,
                            z: sz,
                            hit_at: wire_at.max(t + 0.05),
                            r: WARDEN_SLAB_R,
                            dmg: 0,
                            overhead: false,
                            quake: true,
                        });
                    }
                }
            }
        }
        // --- laser eyes ---
        let dt = 1.0 / HZ;
        {
            let Some(wd) = self.warden.as_mut() else { return };
            if wd.laser_on > 0.0 && t >= wd.laser_on {
                wd.laser_warn = 0.0;
                wd.laser_on = 0.0;
            }
            if wd.laser_on > 0.0 && t >= wd.laser_warn {
                wd.laser_yaw = (wd.laser_yaw + WARDEN_LASER_YAW0 * dt) % (std::f64::consts::TAU);
            } else if wd.laser_on <= 0.0 && t >= wd.laser_at {
                let flip = hash_match(wd.born as u32 ^ 0x1A5E, 80 + ((t - wd.born) as u32));
                wd.laser_yaw = if flip < 0.5 { 0.0 } else { std::f64::consts::PI };
                wd.laser_warn = t + WARDEN_LASER_WARN;
                wd.laser_on = t + WARDEN_LASER_WARN + WARDEN_LASER_HOLD;
                wd.laser_at = t + WARDEN_LASER_WARN + WARDEN_LASER_HOLD + WARDEN_LASER_CD;
            }
        }
        // beam damage: anyone the ground laser touches (and that has no cover) dies
        if let Some(wd) = self.warden.as_ref() {
            if wd.laser_on > t && t >= wd.laser_warn {
                // ground laser: the eye looks down and the beam slants to the floor
                let eye = [wd.x, WARDEN_SEE_HEAD, wd.z];
                let dir = [wd.laser_yaw.cos(), 0.0, wd.laser_yaw.sin()];
                let mut victims: Vec<usize> = Vec::new();
                for (j, (_, v)) in self.players.iter().enumerate() {
                    if v.dead || v.gone {
                        continue;
                    }
                    if self.disaster_immune(j, t) {
                        continue;
                    }
                    let ppos = [v.x, v.y + 0.9, v.z];
                    let px = ppos[0] - eye[0];
                    let pz = ppos[2] - eye[2];
                    let along = px * dir[0] + pz * dir[2];
                    // stay on the map: the beam stops at the arena edge
                    let run_k = map_laser_run(self.map(), wd.x, wd.z, wd.laser_yaw);
                    if along < 0.0 || along > run_k {
                        continue;
                    }
                    let cx = eye[0] + dir[0] * along;
                    let cz = eye[2] + dir[2] * along;
                    let lat = (ppos[0] - cx).hypot(ppos[2] - cz);
                    if lat > WARDEN_LASER_W + 0.3 {
                        continue;
                    }
                    // cover saves: hide behind something
                    if !los(self.map(), eye, ppos) {
                        continue;
                    }
                    victims.push(j);
                }
                for j in victims {
                    self.env_kill(j, "warden-laser", t);
                }
            }
        }
        // --- the Warden calls a disaster ---
        {
            let mut call: Option<&'static str> = None;
            if let Some(wd) = self.warden.as_mut() {
                if t >= wd.dis_at {
                    wd.dis_at = t + WARDEN_DIS_CD;
                    let k = ((t - wd.born) / WARDEN_DIS_CD.max(0.1)) as u32;
                    call = Some(DISASTERS[dis_kind(wd.born as u32 ^ 0xD15A, k, DISASTERS.len())]);
                }
            }
            if let Some(kind) = call {
                self.start_disaster(kind, t);
            }
        }
        // --- Gravity Grip: open-hand pull toward the torso (cover / dash breaks it) ---
        {
            let dt = 1.0 / HZ;
            let mut grip_live = false;
            let mut grip_warn = false;
            if let Some(wd) = self.warden.as_mut() {
                if wd.grip_warn > 0.0 && t >= wd.grip_warn {
                    wd.grip_warn = 0.0;
                    wd.grip_on = t + WARDEN_GRIP_HOLD;
                }
                if wd.grip_on > 0.0 && t >= wd.grip_on {
                    wd.grip_on = 0.0;
                }
                grip_live = wd.grip_on > 0.0 && t < wd.grip_on;
                grip_warn = wd.grip_warn > 0.0;
                if !grip_warn && !grip_live && t >= wd.grip_at {
                    wd.grip_warn = t + WARDEN_GRIP_WARN;
                    wd.grip_at = t + WARDEN_GRIP_WARN + WARDEN_GRIP_CD;
                    grip_warn = true;
                }
            }
            let _ = grip_warn;
            if grip_live {
                let Some(wd) = self.warden.as_ref() else { return };
                let (gx, gz) = (wd.x, wd.z);
                let mut acts: Vec<(usize, bool, f64, f64)> = Vec::new();
                for (j, (_, v)) in self.players.iter().enumerate() {
                    if v.dead || v.gone || self.disaster_immune(j, t) {
                        continue;
                    }
                    // dash / spawn cover breaks the pull
                    if v.speed_until > t || v.protect > t {
                        continue;
                    }
                    let (dx, dz) = (gx - v.x, gz - v.z);
                    let d = (dx * dx + dz * dz).sqrt();
                    if d > WARDEN_GRIP_R {
                        continue;
                    }
                    if !los(self.map(), [gx, WARDEN_SEE_CHEST, gz], [v.x, v.y + 0.9, v.z]) {
                        continue;
                    }
                    if d <= WARDEN_GRIP_MIN {
                        // too close: the free arm sweeps you out
                        let (sx, sz) = (v.x - gx, v.z - gz);
                        let sl = (sx * sx + sz * sz).sqrt().max(0.15);
                        acts.push((j, true, sx / sl, sz / sl));
                    } else {
                        acts.push((j, false, dx, dz));
                    }
                }
                let mut victims: Vec<usize> = Vec::new();
                for (j, sweep, ux, uz) in acts {
                    let dead_now = {
                        let p = &mut self.players[j].1;
                        if sweep {
                            p.x = (p.x + ux * 6.0).clamp(-200.0, 200.0);
                            p.z = (p.z + uz * 6.0).clamp(-200.0, 200.0);
                            p.hist.push_back((t, p.x, p.y, p.z));
                            p.hp = (p.hp - WARDEN_GRIP_SWEEP_DMG).max(0);
                            p.hp <= 0
                        } else {
                            let ln = (ux * ux + uz * uz).sqrt().max(0.05);
                            let step = ln.min(WARDEN_GRIP_PULL * dt);
                            p.x = (p.x + (ux / ln) * step).clamp(-200.0, 200.0);
                            p.z = (p.z + (uz / ln) * step).clamp(-200.0, 200.0);
                            p.hist.push_back((t, p.x, p.y, p.z));
                            false
                        }
                    };
                    if dead_now {
                        victims.push(j);
                    }
                }
                for j in victims {
                    self.env_kill(j, "warden-grip", t);
                }
            }
        }
    }

    /// Drop one totem: a fresh kind and spot derived from the drop counter, landing in
    /// the OLDEST totem slot of the ring (replacing whatever sat there, taken or not),
    /// announced to the room by the "totem" event tick() emits. (can_mole: the mole only
    /// drops when the other side fields a bot — it can't turn a human. Repetitions
    /// allowed: kinds repeat by chance.)
    fn spawn_totem(&mut self, can_mole: bool) {
        if self.warden.is_some() {
            return;
        }
        self.ensure_drop_slots();
        let a = self.drop_rings().0;
        self.totem_k += 1;
        let seed = (self.totem_k as u32).wrapping_mul(0x9E37_79B9).wrapping_add(self.k as u32);
        // personal roster only — Disaster totems live in spawn_disaster_totem on their
        // own ring (matches games/strike.js totemSpawn's ALL).
        let kinds: Vec<&'static str> = TOTEM_KINDS
            .iter()
            .copied()
            .filter(|k| !DISASTERS.contains(k))
            .filter(|k| can_mole || *k != "mole")
            .collect();
        let kind: &'static str =
            kinds[(hash_match(seed, 1) * kinds.len() as f64) as usize % kinds.len()];
        let (x, z) = self.open_spot(seed);
        let i = a + (self.totem_k as usize - 1) % DROP_SLOTS;
        // Hot Drop / Cursed Drop flavours: same scatter rule, a visible tag so the
        // client can beam it and show the drawback. Cursed is purple and comes with a
        // small cost on take (already applied in pickups for "cursed" kinds).
        let roll = (hash_match(seed, 3) * 100.0) as i64;
        let mut tag = "";
        if roll < HOT_PCT {
            tag = "hot";
        } else if roll < HOT_PCT + CURSED_PCT {
            tag = "cursed";
        }
        self.items[i] = None;
        self.kinds[i] = kind;
        self.spots[i] = [x, 0.0, z];
        if self.cursed.len() <= i {
            self.cursed.resize(i + 1, false);
        }
        self.cursed[i] = tag == "cursed";
        self.pending.push(("totem", json!({"i": i, "kind": kind, "x": cm(x), "z": cm(z), "tag": tag})));
    }

    /// Disaster totems: their own ring, their own clock, never mixed into the personal
    /// roster. Tagged "dis" so the beacon reads as an arena-wide event, not a power-up.
    fn spawn_disaster_totem(&mut self) {
        if self.warden.is_some() {
            return;
        }
        self.ensure_drop_slots();
        let d = self.drop_rings().2;   // the Disaster ring starts where the pack ring ends
        self.dis_k += 1;
        let seed = (self.dis_k as u32).wrapping_mul(0x9E37_79B9).wrapping_add(self.k as u32)
            .wrapping_add(0xD15A_57E5);
        let kind: &'static str =
            DISASTERS[dis_kind(seed, 4, DISASTERS.len())];
        let (x, z) = self.open_spot(seed);
        let i = d + (self.dis_k as usize - 1) % DIS_SLOTS;
        self.items[i] = None;
        self.kinds[i] = kind;
        self.spots[i] = [x, 0.0, z];
        if self.cursed.len() <= i {
            self.cursed.resize(i + 1, false);
        }
        self.cursed[i] = false;
        self.pending.push(("totem", json!({"i": i, "kind": kind, "x": cm(x), "z": cm(z), "tag": "dis"})));
    }

    /// Drop one loose pack (health or ammo, even odds): its own clock, independent of the
    /// totems — same recycled-slot ring, same fresh random spot each time.
    fn spawn_pack(&mut self) {
        if self.warden.is_some() {
            return;
        }
        self.ensure_drop_slots();
        let b = self.drop_rings().1;
        self.pack_k += 1;
        let seed = (self.pack_k as u32).wrapping_mul(0x9E37_79B9).wrapping_add(self.k as u32)
            .wrapping_add(0x5F35_6495);
        let kind = if hash_match(seed, 4) >= 0.5 { "ammo" } else { "health" };
        let (x, z) = self.open_spot(seed);
        let i = b + (self.pack_k as usize - 1) % PACK_SLOTS;
        self.items[i] = None;
        self.kinds[i] = kind;
        self.spots[i] = [x, 0.0, z];
        self.pending.push(("pack", json!({"i": i, "kind": kind, "x": cm(x), "z": cm(z)})));
    }

    fn sync(p: &mut Player, t: f64) -> Option<Value> {
        if t - p.sync_at < FIX_GAP {
            return None;
        }
        p.sync_at = t;
        Some(json!({"w": p.w, "mag": p.mag, "res": p.res, "reloading": p.reload.is_some()}))
    }

    fn clock(p: &mut Player, msg: &Value, t: f64) -> Option<i64> {
        let q = as_num(msg.get("q"), 0.0, ((1u64 << 30) - 1) as f64)? as i64;
        if !p.lead_ok(q, t) {
            p.bad += 1;
            return None;
        }
        if p.qmax.map(|m| q < m - (FIRE_LATE * 100.0) as i64).unwrap_or(false) {
            return None;
        }
        p.seen(q, t);
        Some(q)
    }

    /// A shot. Returns (the judged shot, or None if refused; the shooter's ammo to
    /// send back when it was refused for ammo).
    pub fn fire(&mut self, uid: &str, msg: &Value, t: f64) -> (Option<Value>, Option<Value>) {
        let Some(i) = self.idx(uid) else { return (None, None) };
        if self.phase != Phase::Round {
            return (None, None);
        }
        let mut p = std::mem::replace(&mut self.players[i].1, Player::new(Value::Null, 0, 0, t, 0));
        let res = self.fire_inner(&mut p, msg, t);
        self.players[i].1 = p;
        let Some((w, o, d, reach, protect_ended)) = res.0 else { return (None, res.1) };
        if protect_ended {
            self.mark(uid);
        }
        // the launcher: don't judge a ray — spawn a rocket; tick() flies it and resolves the blast
        if w == NW - 1 {
            self.rocket_k += 1;
            let rocket = Rocket {
                id: self.rocket_k, shooter: uid.to_string(),
                x: o[0], y: o[1], z: o[2], px: o[0], py: o[1], pz: o[2],
                vx: d[0] * MISSILE_V, vy: d[1] * MISSILE_V, vz: d[2] * MISSILE_V, born: t,
            };
            self.rockets.push(rocket);
            let shot = json!([self.players[i].1.slot, w, cm(o[0]), cm(o[1]), cm(o[2]), -1, 0]);
            self.shots.push(shot.clone());
            return (Some(shot), None);
        }
        let team = self.players[i].1.team;
        let t_view = res.2;
        // The Warden: while it lives, fighters cannot hurt each other — only the
        // Warden takes damage. Shots still draw a tracer; disasters still hurt.
        if self.warden.is_some() {
            let end = self
                .warden
                .as_ref()
                .and_then(|wd| wd.hit_index(o, d, reach))
                .map(|(_, th)| th)
                .unwrap_or(reach);
            let shooter_slot = self.players[i].1.slot;
            let mut shot = vec![
                json!(shooter_slot),
                json!(w),
                json!(cm(o[0] + d[0] * end)),
                json!(cm(o[1] + d[1] * end)),
                json!(cm(o[2] + d[2] * end)),
                json!(-1),
                json!(0),
            ];
            if let Some((_dmg, head)) = self.warden_hit(w, o, d, reach, t) {
                shot[6] = json!(if head { 1 } else { 0 });
                self.mark_all();
            }
            let shot = Value::Array(shot);
            self.shots.push(shot.clone());
            return (Some(shot), None);
        }
        let mut best: Option<(usize, f64, bool)> = None;
        for (j, (vid, v)) in self.players.iter().enumerate() {
            if vid == uid || v.dead || v.gone || v.team == team || v.spawn_t > t_view {
                continue;
            }
            let (vx, vy, vz) = v.where_at(t_view);
            if let Some((th, head)) = ray_player(o, d, vx, vy, vz, reach) {
                if best.map(|b| th < b.1).unwrap_or(true) {
                    best = Some((j, th, head));
                }
            }
        }
        let end = best.map(|b| b.1).unwrap_or(reach);
        let shooter_slot = self.players[i].1.slot;
        let mut shot = vec![json!(shooter_slot), json!(w), json!(cm(o[0] + d[0] * end)),
                            json!(cm(o[1] + d[1] * end)), json!(cm(o[2] + d[2] * end)), json!(-1), json!(0)];
        // Bullet Magnet: incoming fire near a magnet-holder curves into the bubble owner's
        // threat (here: the magnet owner steals the hit if they are closer to the line).
        if let Some((j, th, head)) = best {
            let hx = o[0] + d[0] * th;
            let hy = o[1] + d[1] * th;
            let hz = o[2] + d[2] * th;
            for (k, (_ku, kv)) in self.players.iter().enumerate() {
                if k == j || k == i || kv.dead || kv.gone || kv.magnet_until <= t {
                    continue;
                }
                let dist = dist3([kv.x, kv.y + 0.9, kv.z], [hx, hy, hz]);
                if dist < 3.5 {
                    best = Some((k, th, head));
                    break;
                }
            }
        }
        let mut hit_list: Vec<(usize, bool)> = Vec::new();
        if let Some((j, _, head)) = best {
            hit_list.push((j, head));
            // Ghost Bullets: the shot keeps going and may hit one more body behind
            if self.players[i].1.ghost_left > 0 {
                self.players[i].1.ghost_left -= 1;
                let mut second: Option<(usize, f64, bool)> = None;
                for (k, (ku, kv)) in self.players.iter().enumerate() {
                    if k == hit_list[0].0 || ku == uid || kv.dead || kv.gone || kv.team == team
                        || kv.spawn_t > t_view {
                        continue;
                    }
                    let (vx, vy, vz) = kv.where_at(t_view);
                    if let Some((th, head)) = ray_player(o, d, vx, vy, vz, reach) {
                        if second.map(|b| th < b.1).unwrap_or(true) {
                            second = Some((k, th, head));
                        }
                    }
                }
                if let Some((k, _, head)) = second {
                    hit_list.push((k, head));
                }
            }
            // Chain Lightning: one extra enemy near the impact jumps
            if self.players[i].1.chain_left > 0 {
                self.players[i].1.chain_left -= 1;
                let (j0, h0) = hit_list[0];
                let (hx, hy, hz) = {
                    let v = &self.players[j0].1;
                    (v.x, v.y + 0.9, v.z)
                };
                let mut chain: Option<usize> = None;
                let mut bestc = f64::INFINITY;
                for (k, (ku, kv)) in self.players.iter().enumerate() {
                    if k == j0 || ku == uid || kv.dead || kv.gone || kv.team == team {
                        continue;
                    }
                    let d2 = dist3([kv.x, kv.y + 0.9, kv.z], [hx, hy, hz]);
                    if d2 <= CHAIN_R && d2 < bestc {
                        bestc = d2;
                        chain = Some(k);
                    }
                }
                if let Some(k) = chain {
                    hit_list.push((k, h0));
                    self.booms.push(json!([cm(hx), cm(hy), cm(hz)]));
                }
            }
            // Ricochet: a second victim near the first
            if self.players[i].1.rico_left > 0 {
                self.players[i].1.rico_left -= 1;
                let (j0, h0) = hit_list[0];
                let (hx, hy, hz) = {
                    let v = &self.players[j0].1;
                    (v.x, v.y + 0.9, v.z)
                };
                let mut rico: Option<usize> = None;
                let mut beste = f64::INFINITY;
                for (k, (ku, kv)) in self.players.iter().enumerate() {
                    if k == j0 || ku == uid || kv.dead || kv.gone || kv.team == team {
                        continue;
                    }
                    let d2 = dist3([kv.x, kv.y + 0.9, kv.z], [hx, hy, hz]);
                    if d2 <= 7.0 && d2 < beste {
                        beste = d2;
                        rico = Some(k);
                    }
                }
                if let Some(k) = rico {
                    hit_list.push((k, h0));
                }
            }
        }
        // Cluster Shot: the volley splits into nearby extra hits from the muzzle
        if self.players[i].1.cluster_left > 0 && hit_list.is_empty() {
            // a miss still splits: tag up to 2 enemies near the ray's end point
            self.players[i].1.cluster_left -= 1;
            let ex = o[0] + d[0] * end;
            let ey = o[1] + d[1] * end;
            let ez = o[2] + d[2] * end;
            let mut n = 0;
            for (k, (ku, kv)) in self.players.iter().enumerate() {
                if n >= 2 { break; }
                if ku == uid || kv.dead || kv.gone || kv.team == team {
                    continue;
                }
                if dist3([kv.x, kv.y + 0.9, kv.z], [ex, ey, ez]) < 4.5 {
                    hit_list.push((k, false));
                    n += 1;
                }
            }
        } else if self.players[i].1.cluster_left > 0 {
            self.players[i].1.cluster_left -= 1;
        }
        let mut first = true;
        for (j, head) in hit_list {
            // read-only snapshot of the victim first — the apply pass needs &mut self
            let (vid, slot, hp0, shield, fate_on) = {
                let (u, v) = &self.players[j];
                (u.to_string(), v.slot, v.hp, v.protect > t || v.shielded(t), v.fate_until > t)
            };
            if first {
                shot[5] = json!(slot);
                shot[6] = json!(if head { 1 } else { 0 });
                first = false;
            }
            let base = if shield { 0 } else if head { WEAPONS[w].head } else { WEAPONS[w].damage };
            if base <= 0 {
                self.mark(&vid);
                continue;
            }
            // Fate Splitter: half the wound lands on the partner
            let partner: Option<String> = if fate_on {
                self.fate.as_ref().filter(|f| f.until > t).and_then(|f| {
                    if f.a == vid { Some(f.b.clone()) } else if f.b == vid { Some(f.a.clone()) } else { None }
                })
            } else {
                None
            };
            let half = base / 2;
            let mut dmg = base;
            if let Some(pid) = partner {
                dmg -= half;
                if let Some(pi) = self.idx(&pid) {
                    let dead_p = {
                        let pp = &mut self.players[pi].1;
                        if !pp.dead && !pp.shielded(t) {
                            pp.hp = (pp.hp - half).max(0);
                            pp.hp <= 0
                        } else {
                            false
                        }
                    };
                    self.mark(&pid);
                    if dead_p {
                        self.kill(i, pi, w, false, t);
                    }
                }
            }
            let killed = {
                let v = &mut self.players[j].1;
                v.hp = (hp0 - dmg).max(0);
                v.hp <= 0
            };
            self.mark(&vid);
            if killed {
                self.kill(i, j, w, head, t);
            }
        }
        let shot = Value::Array(shot);
        self.shots.push(shot.clone());
        (Some(shot), None)
    }

    /// The shooter-side rules of a shot. Ok: (weapon, origin, direction, reach,
    /// protection ended) and the rewind time.
    #[allow(clippy::type_complexity)]
    fn fire_inner(&self, p: &mut Player, msg: &Value, t: f64)
        -> (Option<(usize, [f64; 3], [f64; 3], f64, bool)>, Option<Value>, f64)
    {
        let none = (None, None, 0.0);
        if p.dead || p.gone || p.is_bot() || !bucket(&mut p.fb, FIRE_RATE, FIRE_BURST, t) {
            return none;
        }
        let w = as_num(msg.get("w"), -1.0, 99.0);
        let g = |k: &str| as_num(msg.get(k), -1e6, 1e6);
        let (Some(w), Some(ox), Some(oy), Some(oz), Some(yaw), Some(pitch)) =
            (w, g("ox"), g("oy"), g("oz"), g("r"), as_num(msg.get("p"), -9000.0, 9000.0)) else { return none };
        if w != w.trunc() || !(0.0..WEAPONS.len() as f64).contains(&w) {
            return none;
        }
        let w = w as usize;
        if !p.this_life(msg) {
            return none;
        }
        let Some(q) = Self::clock(p, msg, t) else { return none };
        self.ack(p, msg, Some(q), t);
        let wp = &WEAPONS[w];
        p.finish_reload(q);
        let reloading = p.reload.map(|r| r.1 <= q).unwrap_or(false);
        if w != p.w || q < p.ready || reloading || p.mag[w] <= 0 {
            return (None, Self::sync(p, t), 0.0);
        }
        // the fire rate, on the shooter's clock, whatever order shots arrived in
        let mut gap = (wp.interval * 100.0).round() as i64 - 1;
        if p.overclock_until > t {
            gap = (gap as f64 * 0.55) as i64;   // Overclock: fire noticeably faster
        }
        if p.last[w].iter().any(|lq| (q - lq).abs() < gap) {
            return none;
        }
        // Infinite Chamber: the mag never runs dry (reload is a no-op refill)
        if p.infchamber_until > t {
            p.mag[w] = wp.mag;
        }
        let o = [ox / 100.0, oy / 100.0, oz / 100.0];
        let lag = p.q.map(|pq| (q - pq).abs() as f64 / 100.0).unwrap_or(0.0);
        // SPRINT_MAX_SPEED here (playing can sprint mid-lag-window, and the complaint
        // is only meaningful when the origin is beyond even a sprinter's drift)
        if dist3(o, [p.x, p.y + EYE, p.z]) > ORIGIN_SLACK + SPRINT_MAX_SPEED * lag.min(FIRE_LATE) {
            p.bad += 1;
            return none;
        }
        p.mag[w] -= 1;
        p.last[w].push_back(q);
        while p.last[w].len() > 8 {
            p.last[w].pop_front();
        }
        p.n += 1;
        let protect_ended = p.protect > t;
        if protect_ended {
            p.protect = t;
        }
        let (dy, dp) = spread_of(p.n, w);
        let d = {
            // disaster scatter: grit in the sights / wild wind / EMP electronics (shared rule)
            // read BEFORE the shot ray — `p` is still a live mut borrow of a player
            let scatter = self.disaster.as_ref().map(|d| {
                if t < d.warn_at || d.until <= t {
                    0.0
                } else {
                    match d.kind {
                        "hurricane" => DD_WIND_SCATTER,
                        "sandstorm" => DD_SAND_SCATTER,
                        "emp" => DD_EMP_SCATTER,
                        _ => 0.0,
                    }
                }
            }).unwrap_or(0.0);
            dir_of(yaw / 100.0 + dy + scatter, (pitch / 100.0 + dp + scatter * 0.6).clamp(-89.0, 89.0))
        };
        // lag compensation: where was everyone when the shooter pulled the trigger,
        // as the shooter saw them?
        let t_fire = t.min((t - FIRE_LATE).max(q as f64 / 100.0 + p.off.unwrap_or(t - q as f64 / 100.0)));
        let ip = as_num(msg.get("ip"), 0.0, 1e6).unwrap_or(0.0);
        let t_view = (t_fire - p.rtt.min(RTT_CAP) - (ip / 1000.0).min(IP_CAP)).max(t - HISTORY);
        let reach = ray_map(self.map(), o, d, wp.range);
        (Some((w, o, d, reach, protect_ended)), None, t_view)
    }

    /// A rocket's blast at r's position: falloff damage on every living player —
    /// team-mates and the shooter included (an honest rocket) — with a shot echo
    /// per victim so the shooter's screen floats the damage the server applied.
    fn detonate(&mut self, r: &Rocket, t: f64) {
        let at = [r.x, r.y, r.z];
        // Cluster Shot: the rocket splits into smaller follow-up blasts on detonate
        if let Some((si, left)) = self.players.iter().enumerate()
            .find(|(_, (u, _))| u.as_str() == r.shooter)
            .map(|(si, (_, p))| (si, p.cluster_left))
        {
            if left > 0 {
                self.players[si].1.cluster_left = left - 1;
                for n in 0..3 {
                    let ang = n as f64 * 2.094;
                    self.booms.push(json!([cm(at[0] + ang.cos() * 2.2), cm(at[1]), cm(at[2] + ang.sin() * 2.2)]));
                }
            }
        }
        self.booms.push(json!([cm(at[0]), cm(at[1]), cm(at[2])]));
        let shooter = r.shooter.clone();
        // The Warden: the blast cannot touch fighters — only the Warden volume.
        if self.warden.is_some() {
            self.warden_blast(at, t);
            return;
        }
        // pass 1 (read-only): who is in range, and how hard it hits them
        let hits: Vec<(usize, i64)> = self.players.iter().enumerate()
            .filter(|(_, (_, v))| !v.dead && !v.gone)
            .map(|(j, (u, v))| {
                let dist = dist3([v.x, v.y + 0.9, v.z], at);
                // honest-but-fair, mirrors the client: the shooter's own blast grades by
                // proximity (75 falloff), never the 120 "direct" — a rocket launched from the
                // eye detonates ~0.6 m above the shooter's torso, which would otherwise be
                // an instant self-kill the moment anyone fires near a wall or their own feet.
                let direct = *u != shooter && dist < DIRECT_R;
                let dmg = if v.protect > t || v.shielded(t) { 0 } else { blast_damage(dist, direct) };
                (j, dmg)
            })
            .filter(|(_, dmg)| *dmg > 0)
            .collect();
        // pass 2 (mutable): apply, mark, credit kills, queue the echoes
        for (j, dmg) in hits {
            let (vid, hp0, vslot) = {
                let (vid, v) = &mut self.players[j];
                let hp0 = v.hp;
                v.hp = (v.hp - dmg).max(0);
                v.hp_original = hp0;
                (vid.clone(), hp0, v.slot)
            };
            let killed = self.players[j].1.hp <= 0;
            self.mark(&vid);
            if killed {
                let si = self.players.iter().position(|(u, _)| *u == shooter);
                if let Some(si) = si {
                    self.kill(si, j, NW - 1, false, t);
                } else {
                    // the shooter left: credit no one, but the death still counts
                    let (vid2, v) = &mut self.players[j];
                    let _ = vid2;
                    v.dead = true;
                    v.deaths += 1;
                    v.respawn_at = t + RESPAWN;
                    v.reload = None;
                    let deaths = v.deaths;
                    let team = v.team;
                    self.pending.push(("kill", json!({"k": null, "v": vid, "w": NW - 1, "hs": 0,
                        "kills": 0, "deaths": deaths, "team": team, "scores": self.scores})));
                }
            }
            let applied = hp0.saturating_sub(self.players[j].1.hp);
            self.detonate_echoes.push((shooter.clone(), at, vslot, applied));
        }
    }

    /// Flush detonate()'s echoes as shot rows once its borrows are done.
    /// [shooter_slot, launcher, x, y, z, victim_slot, head, dmg_applied]
    fn flush_echoes(&mut self) {
        let echoes = std::mem::take(&mut self.detonate_echoes);
        for (shooter, at, vslot, applied) in echoes {
            if let Some((_, p)) = self.players.iter().find(|(u, _)| *u == shooter) {
                self.shots.push(json!([p.slot, NW - 1, cm(at[0]), cm(at[1]), cm(at[2]),
                                       vslot, 0, applied]));
            }
        }
    }

    fn kill(&mut self, i: usize, j: usize, w: usize, head: bool, t: f64) {
        // Second Wind / Phoenix: the death is cancelled the first time
        if self.players[j].1.cheat_death(t) {
            let vuid = self.players[j].0.clone();
            let slot = self.players[j].1.slot;
            let hp = self.players[j].1.hp;
            self.mark(&vuid);
            self.pending.push(("cheat", json!({"i": slot, "hp": hp})));
            return;
        }
        // Fate Splitter: half the wound landed on the partner already; the kill still counts
        let (vid, deaths) = {
            let (vid, v) = &mut self.players[j];
            v.dead = true;
            v.deaths += 1;
            v.respawn_at = t + RESPAWN;
            v.reload = None;
            (vid.clone(), v.deaths)
        };
        let (uid, p) = &mut self.players[i];
        p.kills += 1;
        // the mole's twist: a charmed killer's point lands on the OTHER side (the charmer's)
        let charmed = p.charm_until > t;
        let team = if charmed { 1 - p.team } else { p.team };
        // The Warden freezes the scoreline — kills still count on the board, but
        // no team point is awarded until it falls.
        if self.warden.is_none() {
            self.scores[team as usize] += 1;
        }
        let scores = self.scores;
        let ev = json!({"k": uid, "v": vid, "w": w, "hs": if head { 1 } else { 0 }, "kills": p.kills,
                        "deaths": deaths, "team": team, "scores": scores});
        self.pending.push(("kill", ev));
    }

    /// The map itself killed someone (an Arena Disaster). No shooter, no team point —
    /// the feed names the disaster instead of a weapon. Second Wind / Phoenix still fire.
    fn env_kill(&mut self, j: usize, dis: &'static str, t: f64) {
        if self.players[j].1.cheat_death(t) {
            let vuid = self.players[j].0.clone();
            let slot = self.players[j].1.slot;
            let hp = self.players[j].1.hp;
            self.mark(&vuid);
            self.pending.push(("cheat", json!({"i": slot, "hp": hp})));
            return;
        }
        let (vid, deaths) = {
            let (vid, v) = &mut self.players[j];
            v.dead = true;
            v.deaths += 1;
            v.respawn_at = t + RESPAWN;
            v.reload = None;
            v.wings_until = 0.0;
            v.wings_fly = 0.0;
            v.leap_until = 0.0;
            v.speed_until = 0.0;
            (vid.clone(), v.deaths)
        };
        let scores = self.scores;
        self.pending.push((
            "kill",
            json!({"k": null, "v": vid, "w": -1, "hs": 0, "kills": 0,
                   "deaths": deaths, "team": 0, "scores": scores,
                   "dis": dis, "how": dis}),
        ));
        self.mark(&vid);
    }

    /// True when a disaster cannot touch this player: the Shield totem (or the drop
    /// shield / Pocket Universe, which the same predicate covers) or spawn cover.
    fn disaster_immune(&self, i: usize, t: f64) -> bool {
        let p = &self.players[i].1;
        p.dead || p.gone || p.shielded(t) || p.protect > t
    }

    /// Extra shot scatter (degrees of yaw) while a disaster is chewing the sights.
    /// Twin: disAimScatter in games/strike.js.
    fn disaster_scatter(&self, t: f64) -> f64 {
        let Some(d) = self.disaster.as_ref() else { return 0.0 };
        if t < d.warn_at || d.until <= t {
            return 0.0;
        }
        match d.kind {
            "hurricane" => DD_WIND_SCATTER,
            "sandstorm" => DD_SAND_SCATTER,
            "emp" => DD_EMP_SCATTER,
            _ => 0.0,
        }
    }

    /// Bot aim error multiplier under a disaster (EMP ×3, hurricane ×2 — wild aim) and
    /// while a bolt / flash has blinded them (×4 — spray). Twin: the aimX line in
    /// games/strike.js bot turn/aim.
    fn bot_aim_mult(&self, t: f64, blind: bool) -> f64 {
        let base = match self.disaster.as_ref() {
            Some(d) if t >= d.warn_at && t < d.until => match d.kind {
                "emp" => 3.0,
                "hurricane" => 2.0,
                _ => 1.0,
            },
            _ => 1.0,
        };
        if blind {
            base * 4.0
        } else {
            base
        }
    }

    /// One Arena Disaster's worth of world upkeep. Called from tick() every frame.
    fn disaster_tick(&mut self, t: f64) {
        // the disaster clock: independent of the totems and of the small Arena Events
        if self.disaster_at.map(|at| t >= at).unwrap_or(false) {
            self.disaster_at = Some(t + DIS_GAP);
            if !self.disaster.as_ref().map(|d| d.until > t).unwrap_or(false) {
                self.world_k += 1;
                let kind = DISASTERS[dis_kind(self.world_k as u32, 11, DISASTERS.len())];
                self.start_disaster(kind, t);
            }
        }
        if self.disaster.is_none() {
            if !self.warns.is_empty() {
                self.warns.clear();
            }
            return;
        }
        let mut d = self.disaster.take().unwrap();
        if d.until <= t {
            self.warns.clear();
            self.pending.push(("disaster", json!({"kind": "clear"})));
            self.mark_all();
            return;
        }
        // warning window: the banner is up, nothing hurts yet
        if t < d.warn_at {
            self.disaster = Some(d);
            return;
        }
        let m = self.map();
        let b = m.bounds();
        let (cx0, cz0, cx1, cz1) = (b[0], b[2], b[3], b[5]);
        match d.kind {
            "meteorshower" | "thunder" | "earthquake" => {
                // impact system: warning marker, then a radial hit. Meteor and Thunder
                // come from the sky and a shed roof stops them; a quake is the floor.
                let (gap, warn, r, dmg, overhead, quake) = if d.kind == "meteorshower" {
                    (DD_METEOR_GAP, DD_METEOR_WARN, DD_METEOR_R, DD_METEOR_DMG, true, false)
                } else if d.kind == "thunder" {
                    (DD_THUNDER_GAP, DD_THUNDER_WARN, DD_THUNDER_R, DD_THUNDER_DMG, true, false)
                } else {
                    (DD_QUAKE_GAP, DD_QUAKE_WARN, DD_QUAKE_R, DD_QUAKE_DMG, false, true)
                };
                if t >= d.hit_at {
                    d.hit_at = t + gap;
                    d.mark_k += 1;
                    // Aim the next mark at a live body (hashed offset) so a shower can
                    // actually connect; the rest scatter on the same frozen seed.
                    let pts = self.live_spots();
                    let (x, z) = if !pts.is_empty() && d.mark_k % 3 == 1 {
                        let (px, pz) = pts[(d.mark_k as usize) % pts.len()];
                        (
                            (px + (hash_match(d.seed, 500 + d.mark_k as u32) - 0.5) * 4.0)
                                .clamp(cx0, cx1),
                            (pz + (hash_match(d.seed, 600 + d.mark_k as u32) - 0.5) * 4.0)
                                .clamp(cz0, cz1),
                        )
                    } else {
                        self.dis_spot(d.seed.wrapping_mul(2654435761).wrapping_add(13), 7 + d.mark_k as u32)
                    };
                    self.warns.push(WarnMark {
                        id: self.world_k + d.mark_k,
                        x,
                        y: 0.0,
                        z,
                        hit_at: t + warn,
                        r,
                        dmg,
                        overhead,
                        quake,
                    });
                }
            }
            "hurricane" => {
                // area system: a wind column walks the map on a hashed diagonal and
                // shoves / lifts anyone it reaches
                let span = (d.until - d.warn_at).max(0.1);
                let u = ((t - d.warn_at) / span).clamp(0.0, 1.0);
                let (ax, az) = (hash_match(d.seed, 21), hash_match(d.seed, 22));
                let (bx, bz) = (hash_match(d.seed, 23), hash_match(d.seed, 24));
                let sx = cx0 + ax * (cx1 - cx0);
                let sz = cz0 + az * (cz1 - cz0);
                let ex = cx0 + bx * (cx1 - cx0);
                let ez = cz0 + bz * (cz1 - cz0);
                let wx = sx + (ex - sx) * u;
                let wz = sz + (ez - sz) * u;
                for j in 0..self.players.len() {
                    if self.disaster_immune(j, t) {
                        continue;
                    }
                    let (px, pz) = (self.players[j].1.x, self.players[j].1.z);
                    let dx = px - wx;
                    let dz = pz - wz;
                    let dd = dx.hypot(dz);
                    if dd > DD_WIND_R {
                        continue;
                    }
                    let ln = dd.max(0.05);
                    let shove = DD_WIND_PUSH * (1.0 - dd / DD_WIND_R);
                    {
                        let p = &mut self.players[j].1;
                        p.x = (p.x + (dx / ln) * shove * 0.15).clamp(-200.0, 200.0);
                        p.z = (p.z + (dz / ln) * shove * 0.15).clamp(-200.0, 200.0);
                        p.hist.push_back((t, p.x, p.y, p.z));
                        // loose footing in the column (help text: "Loose footing, wild aim")
                        if p.slow_until < t + DD_WIND_SLOW {
                            p.slow_until = t + DD_WIND_SLOW;
                        }
                    }
                    self.mark_all();
                }
                // the wind also chips once a second (every disaster has a real impact)
                if t >= d.hit_at {
                    d.hit_at = t + 1.0;
                    for j in 0..self.players.len() {
                        if self.disaster_immune(j, t) {
                            continue;
                        }
                        let dead_now = {
                            let p = &mut self.players[j].1;
                            p.hp = (p.hp - DD_WIND_DMG).max(0);
                            p.hp <= 0
                        };
                        self.mark_all();
                        if dead_now {
                            self.env_kill(j, d.kind, t);
                        }
                    }
                }
            }
            "shockring" => {
                // one expanding wave from the map centre: knocked and hurt once each
                let span = (d.until - d.warn_at).max(0.1);
                let u = ((t - d.warn_at) / span).clamp(0.0, 1.0);
                let r = DD_SHOCK_R * u;
                d.ring = r;
                let ox = (cx0 + cx1) * 0.5;
                let oz = (cz0 + cz1) * 0.5;
                for j in 0..self.players.len() {
                    if self.disaster_immune(j, t) {
                        continue;
                    }
                    let uid = self.players[j].0.clone();
                    if d.hit.iter().any(|h| h == &uid) {
                        continue;
                    }
                    let (px, pz) = (self.players[j].1.x, self.players[j].1.z);
                    let dx = px - ox;
                    let dz = pz - oz;
                    let dd = dx.hypot(dz);
                    // the ring is a 1.6 m thick band
                    if (dd - r).abs() > 1.6 {
                        continue;
                    }
                    d.hit.push(uid);
                    let ln = dd.max(0.05);
                    let dead_now = {
                        let p = &mut self.players[j].1;
                        p.x = (p.x + (dx / ln) * DD_SHOCK_KNOCK).clamp(-200.0, 200.0);
                        p.z = (p.z + (dz / ln) * DD_SHOCK_KNOCK).clamp(-200.0, 200.0);
                        p.hist.push_back((t, p.x, p.y, p.z));
                        p.hp = (p.hp - DD_SHOCK_DMG).max(0);
                        // the blast knocks the wind out of you
                        if p.blind_until < t + DD_SHOCK_BLIND {
                            p.blind_until = t + DD_SHOCK_BLIND;
                        }
                        p.hp <= 0
                    };
                    self.mark_all();
                    if dead_now {
                        self.env_kill(j, d.kind, t);
                    }
                }
            }
            "toxicfog" | "sinkhole" => {
                // area system: standing zones that pulse once a second
                if t >= d.hit_at {
                    d.hit_at = t + 1.0;
                    if d.kind == "toxicfog" {
                        // the green gas fills the whole arena — everyone out in it chips
                        for j in 0..self.players.len() {
                            if self.disaster_immune(j, t) {
                                continue;
                            }
                            let dead_now = {
                                let p = &mut self.players[j].1;
                                p.hp = (p.hp - DD_TOXIC_CHIP_DMG).max(0);
                                p.hp <= 0
                            };
                            self.mark_all();
                            if dead_now {
                                self.env_kill(j, d.kind, t);
                            }
                        }
                        // the three clouds are frozen at start_disaster — the same
                        // centres the client paints, so what you see is what hurts
                        for &(zx, zz) in d.zones.clone().iter() {
                            for j in 0..self.players.len() {
                                if self.disaster_immune(j, t) {
                                    continue;
                                }
                                let (px, pz) = (self.players[j].1.x, self.players[j].1.z);
                                if (px - zx).hypot(pz - zz) > DD_TOXIC_R {
                                    continue;
                                }
                                let dead_now = {
                                    let p = &mut self.players[j].1;
                                    p.hp = (p.hp - DD_TOXIC_DMG).max(0);
                                    // choking inside a cloud
                                    if p.slow_until < t + DD_TOXIC_SLOW {
                                        p.slow_until = t + DD_TOXIC_SLOW;
                                    }
                                    p.hp <= 0
                                };
                                self.mark_all();
                                if dead_now {
                                    self.env_kill(j, d.kind, t);
                                }
                            }
                        }
                    } else {
                        // the pit is frozen at start_disaster (the mesh the client paints)
                        let (zx, zz) = d.pit;
                        for j in 0..self.players.len() {
                            if self.disaster_immune(j, t) {
                                continue;
                            }
                            let (px, pz) = (self.players[j].1.x, self.players[j].1.z);
                            let dx = zx - px;
                            let dz = zz - pz;
                            let dd = dx.hypot(dz);
                            if dd > DD_SINK_R * 1.4 {
                                continue;
                            }
                            let ln = dd.max(0.05);
                            let pull = DD_SINK_PULL * (1.0 - (dd / (DD_SINK_R * 1.4)).min(1.0));
                            let in_pit = dd < DD_SINK_R;
                            let dead_now = {
                                let p = &mut self.players[j].1;
                                p.x = (p.x + (dx / ln) * pull * 0.12).clamp(-200.0, 200.0);
                                p.z = (p.z + (dz / ln) * pull * 0.12).clamp(-200.0, 200.0);
                                p.hist.push_back((t, p.x, p.y, p.z));
                                // stumbling toward the pit
                                if p.slow_until < t + DD_SINK_SLOW {
                                    p.slow_until = t + DD_SINK_SLOW;
                                }
                                if in_pit {
                                    p.hp = (p.hp - DD_SINK_DMG).max(0);
                                    p.hp <= 0
                                } else {
                                    false
                                }
                            };
                            self.mark_all();
                            if dead_now {
                                self.env_kill(j, d.kind, t);
                            }
                        }
                    }
                }
            }
            // "sandstorm" / "absolutezero" / "emp" are global modifiers — fog / slide /
            // HUD cut — AND they chip once a second. Every disaster must have a visual
            // and an impact; shield / spawn-protect still skip it.
            "sandstorm" | "absolutezero" | "emp" if t >= d.hit_at => {
                d.hit_at = t + 1.0;
                let chip = if d.kind == "sandstorm" {
                    DD_SAND_DMG
                } else if d.kind == "absolutezero" {
                    DD_ZERO_DMG
                } else {
                    DD_EMP_DMG
                };
                for j in 0..self.players.len() {
                    if self.disaster_immune(j, t) {
                        continue;
                    }
                    let dead_now = {
                        let p = &mut self.players[j].1;
                        p.hp = (p.hp - chip).max(0);
                        p.hp <= 0
                    };
                    self.mark_all();
                    if dead_now {
                        self.env_kill(j, d.kind, t);
                    }
                }
            }
            _ => {}
        }
        self.disaster = Some(d);
        // fire the impacts whose warning just ended
        let mut boom: Vec<WarnMark> = Vec::new();
        self.warns.retain(|w| {
            if w.hit_at > t {
                true
            } else {
                boom.push(w.clone());
                false
            }
        });
        for w in boom {
            self.booms.push(json!([cm(w.x), cm(0.3), cm(w.z)]));
            for j in 0..self.players.len() {
                if self.disaster_immune(j, t) {
                    continue;
                }
                let (px, py, pz) = (self.players[j].1.x, self.players[j].1.y, self.players[j].1.z);
                let dd = (px - w.x).hypot(pz - w.z);
                if dd > w.r {
                    continue;
                }
                // a shed roof keeps the sky's gifts off your head
                if w.overhead && has_roof(self.map(), px, py, pz) {
                    continue;
                }
                let dis = self.disaster.as_ref().map(|d| d.kind).unwrap_or("meteorshower");
                // proximity crush: more damage near the strike (mark_damage twin of markDamage)
                let hit = mark_damage(dd, w.r, w.dmg);
                let dead_now = {
                    let p = &mut self.players[j].1;
                    p.hp = (p.hp - hit).max(0);
                    // the flash and the blast: a bolt under your feet whites out the view
                    if dis == "thunder" && p.blind_until < t + DD_THUNDER_BLIND {
                        p.blind_until = t + DD_THUNDER_BLIND;
                    } else if dis == "meteorshower" && p.blind_until < t + DD_METEOR_BLIND {
                        p.blind_until = t + DD_METEOR_BLIND;
                    } else if dis == "earthquake" && p.slow_until < t + DD_QUAKE_SLOW {
                        p.slow_until = t + DD_QUAKE_SLOW;
                    }
                    p.hp <= 0
                };
                self.mark_all();
                if dead_now {
                    self.env_kill(j, dis, t);
                }
            }
        }
    }

    pub fn reload(&mut self, uid: &str, msg: &Value, t: f64) -> bool {
        let phase = self.phase;
        // Absolute Zero: fingers are numb, every reload crawls. Read the flag BEFORE
        // player_mut() so the immutable borrow of self.disaster is done with first.
        let zmult = if self.disaster.as_ref().map(|d| d.kind == "absolutezero" && t >= d.warn_at && d.until > t).unwrap_or(false) {
            1.5
        } else {
            1.0
        };
        let Some(p) = self.player_mut(uid) else { return false };
        if p.is_bot() || phase != Phase::Round || p.dead || p.gone
            || !bucket(&mut p.ob, OP_RATE, OP_BURST, t) || !p.this_life(msg) {
            return false;
        }
        let Some(q) = Self::clock(p, msg, t) else { return false };
        p.finish_reload(q);
        let w = p.w;
        if p.reload.is_some() || p.mag[w] >= WEAPONS[w].mag || p.res[w] <= 0 {
            return false;
        }
        p.reload = Some((w, q, q + (WEAPONS[w].reload * zmult * 100.0).round() as i64));
        true
    }

    pub fn weapon(&mut self, uid: &str, msg: &Value, t: f64) -> bool {
        let running = self.running();
        let Some(p) = self.player_mut(uid) else { return false };
        if p.is_bot() || !running || p.gone || !bucket(&mut p.ob, OP_RATE, OP_BURST, t) {
            return false;
        }
        let Some(w) = as_num(msg.get("w"), -1.0, 99.0) else { return false };
        if w != w.trunc() || !(0.0..WEAPONS.len() as f64).contains(&w) {
            return false;
        }
        let q = if msg.get("q").map(|v| !v.is_null()).unwrap_or(false) { Self::clock(p, msg, t) } else { None };
        if w as usize == p.w {
            return false;
        }
        p.w = w as usize;
        p.reload = None;
        p.ready = q.or(p.qmax).unwrap_or(0) + (SWITCH * 100.0) as i64;
        self.mark(uid);
        true
    }


    // -- bots --
    /// Think and move for one bot this tick. Movement runs through the same
    /// step() physics the clients run; shooting runs through its own
    /// adjudication (no rewind: the bot is on the server).
    fn bot_step(&mut self, i: usize, dt: f64, t: f64) {
        if self.players[i].1.dead {
            return;
        }
        // the Paralyser: a frozen bot holds still and holds its fire
        if self.players[i].1.freeze_until > t {
            return;
        }
        // a sandstorm halves how far a bot can see (the dust is up) — the small arena
        // event and the arena-wide disaster both count
        let bot_range = if self.event.as_ref().map(|e| e.kind == "storm" && e.until > t).unwrap_or(false)
            || self.disaster.as_ref().map(|d| d.kind == "sandstorm" && t >= d.warn_at && d.until > t).unwrap_or(false)
        {
            STORM_RANGE
        } else {
            BOT_RANGE
        };
        let team = self.players[i].1.team;
        let (x, y, z) = (self.players[i].1.x, self.players[i].1.y, self.players[i].1.z);
        // -- decide a goal (at most every BOT_THINK) --
        let think = self.players[i].1.bot.as_ref().map(|b| t >= b.think_at).unwrap_or(false);
        if think {
            // The Warden: while it lives, every bot targets it (no PVP).
            if let Some(wd) = self.warden.as_ref() {
                let (wx, wz, core_open) = (wd.x, wd.z, wd.core_until > t);
                let see_y = warden_see(self.map(), [x, y + EYE, z], wx, wz, i, core_open);
                let clear = see_y.is_some();
                let m = self.map();
                let b = self.players[i].1.bot.as_mut().unwrap();
                b.think_at = t + BOT_THINK;
                b.decoy = None;
                // keep the first sighting: restamping seen_at every think starves
                // the BOT_REACT gate and the bot never opens fire
                let fresh = b.target.as_deref() != Some("warden");
                b.target = Some("warden".to_string());
                if fresh {
                    b.seen_at = Some(t);
                }
                let aim = warden_aim(wx, wz, i, core_open);
                b.lost_x = aim.0;
                b.lost_z = aim.2;
                b.lost_y = see_y.unwrap_or(WARDEN_SEE_ARM);
                b.lost_until = 0.0;
                b.goal = if clear {
                    None
                } else if (wx - x).hypot(wz - z) > 14.0 {
                    Some(m.nav_next(x, z, wx, wz, y, 2.5))
                } else {
                    let ang = (b.wpi as f64) * 2.399 + t * 0.7;
                    Some(m.nav_next(x, z, wx + ang.cos() * 8.0, wz + ang.sin() * 8.0, y, 2.5))
                };
            } else {
            // the mole: a charmed bot sees its own side as the enemy and its old enemy as home
            let charmed = self.players[i].1.charm_until > t;
            // the closest visible enemy, resolved to its uid without holding a borrow
            let mut closest: Option<String> = None;
            let mut best = f64::INFINITY;
            for (u, v) in self.players.iter() {
                let mut foe = v.team != team;
                if charmed {
                    foe = !foe;
                }
                if !foe || v.dead || v.gone || v.shielded(t) {
                    continue;   // a shielded glider isn't worth a bullet until the canopy's packed
                }
                if v.cloak_until > t {
                    continue;   // the cloak: a cloaked player is invisible to bots
                }
                let d = (v.x - x).hypot(v.z - z);
                if d < best && d <= bot_range && los(self.map(), [x, y + EYE, z], [v.x, v.y + EYE, v.z]) {
                    best = d;
                    closest = Some(u.clone());
                }
            }
            // the decoy: a standing ghost is just as tempting as the player it copies — the
            // nearest visible one wins the target only when no body is nearer (same rule as
            // the client's pool, weight aside)
            let mut decoy_target: Option<usize> = None;
            for (dj, dc) in self.decoys.iter().enumerate() {
                if dc.until <= t || dc.owner == self.players[i].0 {
                    continue;
                }
                let d = (dc.x - x).hypot(dc.z - z);
                if d < best && d <= bot_range && los(self.map(), [x, y + EYE, z], [dc.x, 1.0 + EYE, dc.z]) {
                    best = d;
                    decoy_target = Some(dj);
                    closest = None;
                }
            }
            // where the chosen enemy stands (resolved before the mutable borrow on the bot)
            let target_pos = closest.as_ref()
                .and_then(|tu| self.players.iter().find(|(u, _)| u == tu).map(|(_, p)| (p.x, p.z, p.y)));
            let m = self.map();
            // snapshot the other bots' current goals before we mutably borrow ours
            // (so a squad can fan out instead of stacking on the same stop)
            let mate_goals: Vec<(f64, f64)> = self.players.iter().enumerate()
                .filter(|(k, _)| *k != i)
                .filter_map(|(_, (_u, q))| q.bot.as_ref().and_then(|qb| qb.goal))
                .collect();
            let b = self.players[i].1.bot.as_mut().unwrap();
            b.think_at = t + BOT_THINK;
            b.decoy = decoy_target;
            match closest {
                Some(ref tu) => {
                    b.target = Some(tu.clone());
                    if b.seen_at.is_none() {
                        b.seen_at = Some(t);
                    }
                    if let Some((vx, vz, vy)) = target_pos {
                        b.lost_x = vx;
                        b.lost_z = vz;
                        b.lost_y = vy;
                        b.target_y = vy;
                        b.lost_until = 0.0;
                    }
                }
                None => {
                    // hunting a trail: remember where they vanished for a few seconds
                    if b.target.is_some() {
                        b.lost_until = t + HUNT_HOLD;   // chase the trail longer
                    }
                    b.target = None;
                    b.seen_at = None;
                }
            }
            if decoy_target.is_some() && b.seen_at.is_none() {
                b.seen_at = Some(t);
            }
            if let Some(dj) = decoy_target {
                b.goal = if (self.decoys[dj].x - x).hypot(self.decoys[dj].z - z) > 18.0 {
                    Some((self.decoys[dj].x, self.decoys[dj].z))
                } else {
                    None
                };
            }
            if b.target.is_none() && decoy_target.is_none() {
                // a pending sidestep owns the goal — the next think tick must not yank
                // it back into the wall it is peeling off of
                if b.slide_until > t {
                    // keep b.goal
                } else if t < b.lost_until {
                    // hunt: walk the room/passage graph to where the target vanished
                    let near = (b.lost_x - x).hypot(b.lost_z - z) <= 2.0;
                    if !near {
                        let (gx, gz) = m.nav_next(x, z, b.lost_x, b.lost_z, y, b.lost_y);
                        b.goal = Some((gx, gz));
                    } else {
                        // arrived: sweep a little around the last sighting
                        let ang = (b.wpi as f64) * 2.399 + t * 0.7;
                        let rad = 2.5 + (b.wpi % 3) as f64;
                        let (gx, gz) = m.nav_next(x, z, b.lost_x + ang.cos() * rad, b.lost_z + ang.sin() * rad, y, b.lost_y);
                        b.goal = Some((gx, gz));
                        if t >= b.lost_until - 0.25 {
                            b.lost_until = 0.0;
                        }
                    }
                } else {
                    // walk the room/passage graph: never aim through a wall at the next point
                    let wps = m.patrol();
                    if !wps.is_empty() {
                        let (wx, wz, wy) = wps[b.wpi % wps.len()];
                        if (x - wx).hypot(z - wz) < 1.5 && (y - wy).abs() < 0.7 {
                            b.wpi += 1;
                        }
                        let (nx, nz, ny) = wps[b.wpi % wps.len()];
                        // if a squad-mate already owns this stop, take the next one
                        let mut guard = 0;
                        let mut n = (nx, nz, ny);
                        while guard < 4 {
                            let owned = mate_goals.iter().any(|(gx, gz)| (gx - n.0).hypot(gz - n.1) < 1.2);
                            if !owned {
                                break;
                            }
                            b.wpi = b.wpi.wrapping_add(1);
                            n = wps[b.wpi % wps.len()];
                            guard += 1;
                        }
                        let (gx, gz) = m.nav_next(x, z, n.0, n.1, y, n.2);
                        b.goal = Some((gx, gz));
                    }
                }
            } else if b.target.is_some() {
                // stalkers close on a seen target — do NOT freeze at 18 m and wait under fire
                // fight from where we stand: close a little on a far target, through the graph
                b.goal = match target_pos {
                    Some((vx, vz, vy)) if (vx - x).hypot(vz - z) > 18.0 => {
                        let (gx, gz) = m.nav_next(x, z, vx, vz, y, vy);
                        Some((gx, gz))
                    }
                    _ => None,
                };
            }
            }
        }
        // -- turn and aim --
        let bait = self.players[i].1.bot.as_ref().and_then(|b| b.decoy)
            .filter(|dj| self.decoys.get(*dj).map(|dc| dc.until > t).unwrap_or(false));
        let ti = self.players[i].1.bot.as_ref().and_then(|b| b.target.as_ref())
            .and_then(|tu| self.players.iter().position(|(u, _)| u == tu));
        let (mut aim_y, mut aim_p) = self.players[i].1.bot.as_ref()
            .map(|b| (b.aim_y, b.aim_p)).unwrap_or((0.0, 0.0));
        let mut target_alive = false;
        if let Some(dj) = bait {
            // aim at the ghost: a still target at chest height, same turn/error rules
            let dc = &self.decoys[dj];
            let tx = dc.x;
            let tz = dc.z;
            let ty = 1.0;
            let mut want_yaw = yaw_of(tx - x, tz - z);
            let flat = (tx - x).hypot(tz - z).max(0.1);
            let mut want_pitch = ((ty - (y + EYE)) / flat).atan().to_degrees();
            let err_due = t - self.players[i].1.bot.as_ref().map(|b| b.err_at).unwrap_or(0.0) >= BOT_THINK;
            if err_due {
                let seed = (t * 1000.0) as i64 as u32 & 0xFFFF;
                // EMP Apocalypse: electronic sights go haywire, so bots spray.
                // Hurricane: the wind shreds their sights too ("wild aim").
                // A bolt / flash also blinds them (×4 spray).
                let blind = self.players[i].1.blind_until > t;
                let aim_x = BOT_AIM * self.bot_aim * self.bot_aim_mult(t, blind);
                let ey = (mb32(seed) * 2.0 - 1.0) * aim_x.to_degrees();
                let ep = (mb32(seed.wrapping_add(7919) & 0xFFFF) * 2.0 - 1.0) * aim_x.to_degrees();
                let b = self.players[i].1.bot.as_mut().unwrap();
                b.err_at = t;
                b.err_y = ey;
                b.err_p = ep;
            }
            let b = self.players[i].1.bot.as_ref().unwrap();
            want_yaw += b.err_y;
            want_pitch = want_pitch.clamp(-89.0, 89.0) + b.err_p;
            let step_deg = (BOT_TURN * self.bot_turn).to_degrees() * dt;
            let dy = (want_yaw - aim_y + 540.0).rem_euclid(360.0) - 180.0;
            aim_y += dy.clamp(-step_deg, step_deg);
            let dp = want_pitch - aim_p;
            aim_p += dp.clamp(-step_deg, step_deg);
            let b = self.players[i].1.bot.as_mut().unwrap();
            b.aim_y = aim_y;
            b.aim_p = aim_p;
            target_alive = true;
        }
        if let Some(ti) = ti {
            let v = &self.players[ti].1;
            if !v.dead && !v.gone && bait.is_none() {
                target_alive = true;
                // lead a little by their speed
                let lead = (v.x - x).hypot(v.z - z) / WEAPONS[self.players[i].1.w].range;
                let lead = 0.25f64.min(lead);
                let tx = v.x + v.vx * lead;
                let tz = v.z + v.vz * lead;
                // alternate head and chest shots (strike.py:902 -- the next shot's index)
                let ty = v.y + if (self.players[i].1.n + 1) % 3 == 0 { 1.35 } else { 1.0 };
                let mut want_yaw = yaw_of(tx - x, tz - z);
                let flat = (tx - x).hypot(tz - z).max(0.1);
                let mut want_pitch = ((ty - (y + EYE)) / flat).atan().to_degrees();
                // a fresh error every BOT_THINK (they are not aimbots)
                let err_due = t - self.players[i].1.bot.as_ref().map(|b| b.err_at).unwrap_or(0.0) >= BOT_THINK;
                if err_due {
                    let seed = (t * 1000.0) as i64 as u32 & 0xFFFF; // strike.py:909's & 0xFFFF
                    // EMP Apocalypse: electronic sights go haywire, so bots spray.
                    // Hurricane: the wind shreds their sights too ("wild aim").
                    // A bolt / flash also blinds them (×4 spray).
                    let blind = self.players[i].1.blind_until > t;
                    let aim_x = BOT_AIM * self.bot_aim * self.bot_aim_mult(t, blind);
                    let ey = (mb32(seed) * 2.0 - 1.0) * aim_x.to_degrees();
                    let ep = (mb32(seed.wrapping_add(7919) & 0xFFFF) * 2.0 - 1.0) * aim_x.to_degrees();
                    let b = self.players[i].1.bot.as_mut().unwrap();
                    b.err_at = t;
                    b.err_y = ey;
                    b.err_p = ep;
                }
                let b = self.players[i].1.bot.as_ref().unwrap();
                want_yaw += b.err_y;
                want_pitch = want_pitch.clamp(-89.0, 89.0) + b.err_p;
                // swing the aim at BOT_TURN rad/s
                let step_deg = (BOT_TURN * self.bot_turn).to_degrees() * dt;
                let dy = (want_yaw - aim_y + 540.0).rem_euclid(360.0) - 180.0;
                aim_y += dy.clamp(-step_deg, step_deg);
                let dp = want_pitch - aim_p;
                aim_p += dp.clamp(-step_deg, step_deg);
                let b = self.players[i].1.bot.as_mut().unwrap();
                b.aim_y = aim_y;
                b.aim_p = aim_p;
            }
        }
        // The Warden: aim at its arm (least damage) while it lives (bait/decoy still wins).
        if bait.is_none() {
            if let Some(wd) = self.warden.as_ref() {
            let (wx, wz, core_open) = (wd.x, wd.z, wd.core_until > t);
            target_alive = true;
            let (ax, ty, az) = warden_aim(wx, wz, i, core_open);
            let ty = warden_see(self.map(), [x, y + EYE, z], wx, wz, i, core_open).unwrap_or(ty);
            let mut want_yaw = yaw_of(ax - x, az - z);
            let flat = (ax - x).hypot(az - z).max(0.1);
            let mut want_pitch = ((ty - (y + EYE)) / flat).atan().to_degrees();
            let err_due =
                t - self.players[i].1.bot.as_ref().map(|b| b.err_at).unwrap_or(0.0) >= BOT_THINK;
            if err_due {
                let seed = (t * 1000.0) as i64 as u32 & 0xFFFF;
                let blind = self.players[i].1.blind_until > t;
                let aim_x = BOT_AIM * self.bot_aim * self.bot_aim_mult(t, blind);
                let ey = (mb32(seed) * 2.0 - 1.0) * aim_x.to_degrees();
                let ep = (mb32(seed.wrapping_add(7919) & 0xFFFF) * 2.0 - 1.0) * aim_x.to_degrees();
                let b = self.players[i].1.bot.as_mut().unwrap();
                b.err_at = t;
                b.err_y = ey;
                b.err_p = ep;
            }
            let b = self.players[i].1.bot.as_ref().unwrap();
            want_yaw += b.err_y;
            want_pitch = want_pitch.clamp(-89.0, 89.0) + b.err_p;
            let step_deg = (BOT_TURN * self.bot_turn).to_degrees() * dt;
            let dy = (want_yaw - aim_y + 540.0).rem_euclid(360.0) - 180.0;
            aim_y += dy.clamp(-step_deg, step_deg);
            let dp = want_pitch - aim_p;
            aim_p += dp.clamp(-step_deg, step_deg);
            let b = self.players[i].1.bot.as_mut().unwrap();
            b.aim_y = aim_y;
            b.aim_p = aim_p;
            }
        }
        if !target_alive {
            // walk the patrol: face the way we are going
            let goal = self.players[i].1.bot.as_ref().and_then(|b| b.goal);
            if let Some((gx, gz)) = goal {
                let want_yaw = yaw_of(gx - x, gz - z);
                let step_deg = (BOT_TURN * self.bot_turn).to_degrees() * dt;
                let dy = (want_yaw - aim_y + 540.0).rem_euclid(360.0) - 180.0;
                aim_y += dy.clamp(-step_deg, step_deg);
                let b = self.players[i].1.bot.as_mut().unwrap();
                b.aim_y = aim_y;
            }
        }
        // -- move (same physics as the clients) --
        let goal = self.players[i].1.bot.as_ref().and_then(|b| b.goal);
        let (mut wx, mut wz): (f64, f64) = (0.0, 0.0);
        if let Some((gx, gz)) = goal {
            let (dx, dz) = (gx - x, gz - z);
            let ln = dx.hypot(dz);
            if ln > 0.3 {
                wx = dx / ln;
                wz = dz / ln;
            }
        }
        // stuck against a wall/corner? aim a sidestep goal and hop the patrol
        {
            let mut slide: Option<(f64, f64)> = None;
            let mut hop = false;
            {
                let b = self.players[i].1.bot.as_mut().unwrap();
                let moved = (x - b.stuck_x).hypot(z - b.stuck_z);
                if wx.abs() + wz.abs() > 0.1 {
                    if b.stuck_at <= 0.0 {
                        b.stuck_at = t;
                        b.stuck_x = x;
                        b.stuck_z = z;
                    } else if moved < 0.12 && t - b.stuck_at > 0.40 {
                        // a fixed side per bot: two mates peeling off the same wall go opposite ways
                        let side = if b.wpi.is_multiple_of(2) { 1.0 } else { -1.0 };
                        // walk 3.5 m along the wall instead of into it, and hop: a 0.55
                        // ledge is the usual reason a bot grinds to a stop on Dockyard
                        slide = Some((x + (-wz) * side * 3.5, z + (wx) * side * 3.5));
                        b.slide_until = t + 1.1;
                        b.stuck_at = t;
                        b.stuck_x = x;
                        b.stuck_z = z;
                        hop = true;
                    }
                } else {
                    b.stuck_at = 0.0;
                    b.stuck_x = x;
                    b.stuck_z = z;
                }
            }
            if let Some((sx, sz)) = slide {
                if let Some(b) = self.players[i].1.bot.as_mut() {
                    b.goal = Some((sx, sz));
                    if hop {
                        b.wpi = b.wpi.wrapping_add(1);
                    }
                }
                let (dx, dz) = (sx - x, sz - z);
                let ln = dx.hypot(dz);
                if ln > 0.3 {
                    wx = dx / ln;
                    wz = dz / ln;
                }
            }
        }
        {
            let m = self.map();
            let p = &mut self.players[i].1;
            let b = p.bot.as_mut().unwrap();
            b.body.x = p.x;
            b.body.y = p.y;
            b.body.z = p.z;
            // v4: a parachute-dropping bot doesn't run physics — it floats the same canopy
            // descent a human client gets, then hands control back to step() on landing
            let dropping = p.drop && (t - p.drop_t) < DROP_TIME;
            if dropping {
                let floor = top_under(m, b.body.x, b.body.y, b.body.z).unwrap_or(0.0);
                b.body.y = (b.body.y - DROP_SINK * dt).max(floor);
                if b.body.y <= floor {
                    p.drop = false;
                    p.drop_t = 0.0;
                }
            } else {
                if p.drop {
                    p.drop = false;
                    p.drop_t = 0.0;
                }
                step(m, &mut b.body, wx, wz, false, dt);
            }
            p.x = b.body.x;
            p.y = b.body.y;
            p.z = b.body.z;
            p.vx = b.body.vx;
            p.vz = b.body.vz;
            p.r = ((aim_y * 100.0) as i64).rem_euclid(36000);
            p.pt = (aim_p * 100.0) as i64;
            p.at = t;
            p.hist.push_back((t, p.x, p.y, p.z));
            while p.hist.len() > 2 && t - p.hist[0].0 > HISTORY {
                p.hist.pop_front();
            }
        }
        // -- shoot (its own adjudication: no clock, no rewind) --
        if target_alive {
            let b = self.players[i].1.bot.as_ref().unwrap();
            if b.seen_at.map(|s| t - s >= BOT_REACT * self.bot_react).unwrap_or(false) {
                // baited: the ghost stands where it stands, no need to resolve a target
                let (d, clear) = match bait {
                    Some(dj) => {
                        let dc = &self.decoys[dj];
                        let d = (dc.x - x).hypot(dc.z - z);
                        (d, los(self.map(), [x, y + EYE, z], [dc.x, 1.0 + EYE, dc.z]))
                    }
                    None => match self.warden.as_ref() {
                        Some(wd) => {
                            let d = (wd.x - x).hypot(wd.z - z);
                            let core_open = wd.core_until > t;
                            (d, warden_see(self.map(), [x, y + EYE, z], wd.x, wd.z, i, core_open).is_some())
                        }
                        None => {
                            let tgt = b.target.as_ref().unwrap();
                            let v = self.players.iter().find(|(u, _)| u == tgt).map(|(_, p)| p).unwrap();
                            let d = (v.x - x).hypot(v.z - z);
                            (d, los(self.map(), [x, y + EYE, z], [v.x, v.y + EYE, v.z]))
                        }
                    }
                };
                // only fire when the target is actually exposed right now (like the client)
                if d <= bot_range && clear {
                    self.bot_fire(i, t);
                }
            }
        }
        // -- reload --
        {
            let p = &mut self.players[i].1;
            let w = p.w;
            if let Some((rw, _, end)) = p.reload {
                if (t * 100.0) as i64 >= end {
                    let take = (WEAPONS[rw].mag - p.mag[rw]).min(p.res[rw]);
                    p.mag[rw] += take;
                    p.res[rw] -= take;
                    p.reload = None;
                }
            }
            if p.mag[w] <= 0 && p.reload.is_none() && p.res[w] > 0 {
                let zmult = if self.disaster.as_ref().map(|d| d.kind == "absolutezero" && t >= d.warn_at && d.until > t).unwrap_or(false) {
                    1.5
                } else {
                    1.0
                };
                p.reload = Some((w, (t * 100.0) as i64,
                                 ((t + WEAPONS[w].reload * zmult) * 100.0).round() as i64));
            }
        }
        let uid = self.players[i].0.clone();
        self.mark(&uid);
    }

    /// A bot's shot: the same hit rules as a human's fire op, but with no
    /// sender clock and no lag compensation (the bot is on the server, so what
    /// it sees is what we see). Returns the judged shot, if any.
    fn bot_fire(&mut self, i: usize, t: f64) -> Option<Value> {
        if self.phase != Phase::Round {
            return None;
        }
        let w = self.players[i].1.w;
        let b = self.players[i].1.bot.as_ref()?;
        // bot_rate is the host-picked MP skill stretching (or tightening) a bot's own gap
        // between shots beyond the weapon's interval — plain carry-over from the DIFFS table
        if t < b.fire_at + WEAPONS[w].interval * self.bot_rate - 0.01 {
            return None;
        }
        let (aim_y, aim_p) = (b.aim_y, b.aim_p);
        // a bot with the launcher fires rockets like a player would, one at a time
        if w == NW - 1 {
            if self.rockets.iter().any(|r| r.shooter == self.players[i].0) {
                return None;
            }
            let uid = self.players[i].0.clone();
            let (slot, ok) = {
                let p = &mut self.players[i].1;
                if p.mag[w] <= 0 || p.reload.is_some() {
                    (p.slot, false)
                } else {
                    (p.slot, true)
                }
            };
            if !ok {
                return None;
            }
            let o = {
                let p = &mut self.players[i].1;
                let o = [p.x, p.y + EYE, p.z];
                p.n += 1;
                if p.protect > t {
                    p.protect = t;
                }
                o
            };
            let d = dir_of(aim_y, aim_p.clamp(-89.0, 89.0));
            self.rocket_k += 1;
            self.rockets.push(Rocket {
                id: self.rocket_k, shooter: uid,
                x: o[0], y: o[1], z: o[2], px: o[0], py: o[1], pz: o[2],
                vx: d[0] * MISSILE_V, vy: d[1] * MISSILE_V, vz: d[2] * MISSILE_V, born: t,
            });
            let shot = json!([slot, w, cm(o[0]), cm(o[1]), cm(o[2]), -1, 0]);
            self.shots.push(shot.clone());
            self.players[i].1.mag[w] -= 1;
            self.players[i].1.bot.as_mut().unwrap().fire_at = t;
            return Some(shot);
        }
        let p = &mut self.players[i].1;
        if p.mag[w] <= 0 || p.reload.is_some() {
            return None;
        }
        let o = [p.x, p.y + EYE, p.z];
        p.n += 1;
        let (dy, dp) = spread_of(p.n, w);
        let d = {
            let scatter = self.disaster.as_ref().map(|d| {
                if t < d.warn_at || d.until <= t {
                    0.0
                } else {
                    match d.kind {
                        "hurricane" => DD_WIND_SCATTER,
                        "sandstorm" => DD_SAND_SCATTER,
                        "emp" => DD_EMP_SCATTER,
                        _ => 0.0,
                    }
                }
            }).unwrap_or(0.0);
            dir_of(aim_y + dy + scatter, (aim_p + dp + scatter * 0.6).clamp(-89.0, 89.0))
        };
        if p.protect > t {
            p.protect = t;
        }
        let team = p.team;
        let reach = ray_map(self.map(), o, d, WEAPONS[w].range);
        // The Warden: only it takes bot fire while it lives.
        if self.warden.is_some() {
            let end = self
                .warden
                .as_ref()
                .and_then(|wd| wd.hit_index(o, d, reach))
                .map(|(_, th)| th)
                .unwrap_or(reach);
            let shooter_slot = self.players[i].1.slot;
            let mut shot = vec![
                json!(shooter_slot),
                json!(w),
                json!(cm(o[0] + d[0] * end)),
                json!(cm(o[1] + d[1] * end)),
                json!(cm(o[2] + d[2] * end)),
                json!(-1),
                json!(0),
            ];
            if let Some((_dmg, head)) = self.warden_hit(w, o, d, reach, t) {
                shot[6] = json!(if head { 1 } else { 0 });
                self.mark_all();
            }
            let shot = Value::Array(shot);
            self.shots.push(shot.clone());
            self.players[i].1.bot.as_mut().unwrap().fire_at = t;
            self.players[i].1.mag[w] -= 1;
            return Some(shot);
        }
        // the decoy: a ghost standing in the line of fire swallows the shot (bots only fall
        // for it while it stands — the client marks the same dismiss-on-hit)
        let mut decoy_hit: Option<usize> = None;
        let mut decoy_d = reach;
        for (dj, dc) in self.decoys.iter().enumerate() {
            if dc.until <= t {
                continue;
            }
            if let Some(th) = ray_player(o, d, dc.x, dc.y, dc.z, decoy_d).map(|h| h.0) {
                decoy_hit = Some(dj);
                decoy_d = th;
            }
        }
        let mut best: Option<(usize, f64, bool)> = None;
        let charmed = self.players[i].1.charm_until > t;
        for (j, (vid, v)) in self.players.iter().enumerate() {
            if vid == &self.players[i].0 || v.dead || v.gone {
                continue;
            }
            let mut foe = v.team != team;
            if charmed {
                foe = !foe;
            }
            if !foe || v.cloak_until > t {
                continue;
            }
            if let Some((th, head)) = ray_player(o, d, v.x, v.y, v.z, reach) {
                if best.map(|bb| th < bb.1).unwrap_or(true) {
                    best = Some((j, th, head));
                }
            }
        }
        // the ghost wins only when it stands nearer than any body it masks
        if let Some(dj) = decoy_hit {
            let nearer = best.map(|b| b.1 > decoy_d).unwrap_or(true);
            if nearer {
                self.decoys[dj].until = t;   // one hit retires the ghost
                let shooter_slot = self.players[i].1.slot;
                let shot = vec![json!(shooter_slot), json!(w),
                                json!(cm(o[0] + d[0] * decoy_d)), json!(cm(o[1] + d[1] * decoy_d)),
                                json!(cm(o[2] + d[2] * decoy_d)), json!(-1), json!(0)];
                let shot = Value::Array(shot);
                self.shots.push(shot.clone());
                self.players[i].1.bot.as_mut().unwrap().fire_at = t;
                self.players[i].1.mag[w] -= 1;
                return Some(shot);
            }
        }
        let end = best.map(|b| b.1).unwrap_or(reach);
        let shooter_slot = self.players[i].1.slot;
        let mut shot = vec![json!(shooter_slot), json!(w), json!(cm(o[0] + d[0] * end)),
                            json!(cm(o[1] + d[1] * end)), json!(cm(o[2] + d[2] * end)), json!(-1), json!(0)];
        if let Some((j, _, head)) = best {
            let (vid, v) = &mut self.players[j];
            let vid = vid.clone();
            shot[5] = json!(v.slot);
            shot[6] = json!(if head { 1 } else { 0 });
            let dmg = if v.protect > t || v.shielded(t) { 0 } else if head { WEAPONS[w].head } else { WEAPONS[w].damage };
            v.hp = (v.hp - dmg).max(0);
            let killed = dmg > 0 && v.hp <= 0;
            self.mark(&vid);
            if killed {
                self.kill(i, j, w, head, t);
            }
        }
        let shot = Value::Array(shot);
        self.shots.push(shot.clone());
        self.players[i].1.bot.as_mut().unwrap().fire_at = t;
        self.players[i].1.mag[w] -= 1;
        Some(shot)
    }

    // -- the clock --
    /// The spawn point of this player's side farthest from every living opponent.
    pub fn spawn_for(&self, uid: &str) -> usize {
        let team = self.player(uid).map(|p| p.team).unwrap_or(0);
        let foes: Vec<[f64; 3]> = self.players.iter()
            .filter(|(_, v)| v.team != team && !v.dead && !v.gone).map(|(_, v)| [v.x, v.y, v.z]).collect();
        let spawns: Vec<usize> = side_spawns(self.map(), team).collect();
        let start = self.player(uid).map(|p| p.slot as usize * 5).unwrap_or(0);
        let (mut best, mut best_d) = (spawns[0], -1.0f64);
        for j in 0..spawns.len() {
            let i = spawns[(start + j) % spawns.len()];
            let s = self.map().spawns[i];
            let dmin = foes.iter().map(|f| dist3([s[0], s[1], s[2]], *f)).fold(1e9, f64::min);
            if dmin > best_d + 1e-9 {
                best = i;
                best_d = dmin;
            }
        }
        best
    }

    /// Advance the match clock; returns the events for the lobby, in order.
    pub fn tick(&mut self, t: f64, send: bool) -> Vec<(&'static str, Value)> {
        let mut evs = Vec::new();
        self.k += 1;
        let dt = 1.0 / HZ;
        if self.phase == Phase::Warmup && t >= self.go_at {
            self.phase = Phase::Round;
            self.ends_at = self.go_at + (self.minutes * 60) as f64;
            // the round's own drop clocks: the first totem lands TOTEM_FIRST in, the
            // first loose pack PACK_FIRST in — two independent clocks
            self.totem_at = Some(t + TOTEM_FIRST);
            self.pack_at = Some(t + PACK_FIRST);
            self.dis_at = Some(t + DIS_FIRST_DROP);
            for (_, p) in self.players.iter_mut() {
                p.at = t;
                p.air_at = t;
                p.protect = t + PROTECT;
                p.pb = (POS_BURST, t);
                p.fb = (FIRE_BURST, t);
                p.ob = (OP_BURST, t);
            }
            self.dirty = self.players.iter().map(|(u, _)| u.to_string()).collect();
            evs.push(("go", json!({"msLeft": self.ms_left(t)})));
        }
        if self.phase != Phase::Round {
            return evs;
        }
        // The Warden: summon / attacks / checkpoints / death (pauses the clock).
        self.warden_tick(t);
        if self.phase != Phase::Round {
            return evs;
        }
        for i in 0..self.players.len() {
            let uid = self.players[i].0.clone();
            let is_bot = self.players[i].1.is_bot();
            let p = &self.players[i].1;
            if p.gone {
                continue;
            }
            if p.away.map(|a| t - a >= GRACE).unwrap_or(false) {
                self.players[i].1.gone = true;
                self.mark(&uid);
                evs.push(("gone", json!({"user": uid})));
                continue;
            }
            if is_bot {
                if !p.dead {
                    self.bot_step(i, dt, t);
                }
            } else if p.dead && t >= p.respawn_at {
                let life = self.players[i].1.life + 1;
                let slot = self.players[i].1.slot;
                let m = self.map();
                let s = drop_spawn(slot, life, m);  // v4: parachute drop at a random spawn point
                let p = &mut self.players[i].1;
                p.place(s, t, m);
                let ev = json!({"user": uid, "x": cm(p.x), "y": cm(p.y), "z": cm(p.z), "r": p.r, "e": p.life, "drop": true});
                self.mark(&uid);
                evs.push(("spawn", ev));
            } else if p.protect != 0.0 && t >= p.protect {
                self.players[i].1.protect = 0.0;
                self.mark(&uid);
            }
            // Void rescue: a fall-out is not a death — after VOID_SECS in the void the
            // referee parachutes every living body back (humans and bots). An endless
            // free-fall used to soft-lock the match with no way to respawn.
            if !self.players[i].1.dead && !self.players[i].1.gone {
                let m = self.map();
                let uid2 = self.players[i].0.clone();
                let rescued = {
                    let p = &mut self.players[i].1;
                    if in_void(m, p.x, p.y, p.z) {
                        if p.void_at <= 0.0 {
                            p.void_at = t;
                            None
                        } else if t - p.void_at >= VOID_SECS {
                            let slot = p.slot;
                            let life = p.life + 1;
                            let s = drop_spawn(slot, life, m);
                            p.place(s, t, m);
                            Some(json!({"user": uid2, "x": cm(p.x), "y": cm(p.y), "z": cm(p.z),
                                        "r": p.r, "e": p.life, "drop": true}))
                        } else {
                            None
                        }
                    } else {
                        p.void_at = 0.0;
                        None
                    }
                };
                if let Some(ev) = rescued {
                    self.mark(&uid2);
                    evs.push(("spawn", ev));
                }
            }
        }
        // bots respawn too
        for i in 0..self.players.len() {
            if self.players[i].1.is_bot() && self.players[i].1.dead && !self.players[i].1.gone
                && t >= self.players[i].1.respawn_at {
                let uid = self.players[i].0.clone();
                let life = self.players[i].1.life + 1;
                let slot = self.players[i].1.slot;
                let m = self.map();
                let s = drop_spawn(slot, life, m);
                self.players[i].1.place(s, t, m);  // bots glide too, same canopy physics as a human
                self.mark(&uid);
            }
        }
        // the launcher's rockets: fly, hit, blast. One at a time per segment, the same
        // segment test the browser's solo missilesStep runs, and the same falloff.
        for ri in (0..self.rockets.len()).rev() {
            let mut r = self.rockets[ri].clone();
            r.vy -= MISSILE_G * dt;
            // Rift: a projectile entering one opening exits the other (6s pair)
            if r.born + 0.05 < t {
                let mut hop: Option<(f64, f64, f64)> = None;
                for q in self.portals.iter() {
                    if q.until <= t {
                        continue;
                    }
                    let d = ((r.px - q.x).hypot(r.pz - q.z)).hypot((r.py - (q.y + 0.9)) * 0.5);
                    if d <= 0.9 {
                        let other = self.portals.iter().find(|o| o.id == q.pair && o.until > t);
                        if let Some(o) = other {
                            hop = Some((o.x, o.y + 0.9, o.z));
                            break;
                        }
                    }
                }
                if let Some((hx, hy, hz)) = hop {
                    r.x = hx;
                    r.y = hy;
                    r.z = hz;
                    r.px = hx;
                    r.py = hy;
                    r.pz = hz;
                    r.born = t;   // a fresh ttl from the exit, so a long pair still works
                    self.rockets[ri] = r;
                    continue;
                }
            }
            let (nx, ny, nz) = (r.px + r.vx * dt, r.py + r.vy * dt, r.pz + r.vz * dt);
            let d3 = [nx - r.px, ny - r.py, nz - r.pz];
            let ln = d3[0].hypot(d3[1]).hypot(d3[2]);
            let mut hit = [nx, ny, nz];
            let mut stopped = false;
            if ln > 1e-9 {
                let u = [d3[0] / ln, d3[1] / ln, d3[2] / ln];
                let reach = ray_map(self.map(), [r.px, r.py, r.pz], u, ln);
                if reach < ln {
                    stopped = true;
                    hit = [r.px + u[0] * reach, r.py + u[1] * reach, r.pz + u[2] * reach];
                } else {
                    // an enemy body blocks it (the shooter's own side is skipped, exactly
                    // like the browser's solo flight: it leaves your own head's box)
                    let steam = self.players.iter().find(|(u, _)| *u == r.shooter).map(|(_, p)| p.team);
                    for (_, v) in self.players.iter() {
                        if v.dead || v.gone || Some(v.team) == steam {
                            continue;
                        }
                        let (body, head) = hit_boxes(v.x, v.y, v.z);
                        if ray_box([r.px, r.py, r.pz], u, &body).map(|h| h <= ln).unwrap_or(false)
                            || ray_box([r.px, r.py, r.pz], u, &head).map(|h| h <= ln).unwrap_or(false) {
                            stopped = true;
                            hit = [r.px + u[0] * ln, r.py + u[1] * ln, r.pz + u[2] * ln];
                            break;
                        }
                    }
                }
            }
            if !stopped && hit[1] <= 0.05 {
                stopped = true;
                hit[1] = 0.05;
            }
            r.x = hit[0];
            r.y = hit[1];
            r.z = hit[2];
            r.px = r.x;
            r.py = r.y;
            r.pz = r.z;
            self.rockets[ri] = r.clone();
            if stopped || t - r.born > MISSILE_TTL {
                self.rockets.remove(ri);
                self.detonate(&r, t);
            }
        }
        self.flush_echoes();
        // the two drop clocks, independent of each other: a fresh random totem every
        // TOTEM_GAP (the mole only when a side fields a bot — it can't turn a human) and
        // a fresh random health/ammo pack every PACK_GAP. Each replaces the oldest slot
        // of its ring, so drops keep coming whether or not anyone took the last one.
        // Drop clocks are suspended while the Warden lives — only it drops loot.
        if self.warden.is_none() {
            if self.totem_at.map(|at| t >= at).unwrap_or(false) {
                self.totem_at = Some(t + TOTEM_GAP);
                let can_mole = self.players.iter().any(|(_, v)| v.is_bot() && !v.dead && !v.gone);
                self.spawn_totem(can_mole);
            }
            if self.pack_at.map(|at| t >= at).unwrap_or(false) {
                self.pack_at = Some(t + PACK_GAP);
                self.spawn_pack();
            }
            if self.dis_at.map(|at| t >= at).unwrap_or(false) {
                self.dis_at = Some(t + DIS_GAP_DROP);
                self.spawn_disaster_totem();
            }
        }
        // decoys expire silently (the client's render pass drops the mesh when its window ends)
        self.decoys.retain(|dc| dc.until > t);
        // ---- Wave C world tick: mines, meteors, bubbles, beacons, portals, events, crate ----
        self.portals.retain(|p| p.until > t);
        self.bubbles.retain(|b| b.until > t);
        self.beacons.retain(|b| b.until > t);
        if self.fate.as_ref().map(|f| f.until <= t).unwrap_or(false) {
            self.fate = None;
        }
        // meteors: warn then hit
        let mut boom_at = Vec::new();
        self.meteors.retain(|m| {
            if m.hit_at > t {
                return true;
            }
            boom_at.push((m.x, m.y, m.z, m.team, m.owner.clone()));
            false
        });
        for (mx, my, mz, mteam, mowner) in boom_at {
            self.booms.push(json!([cm(mx), cm(my + 0.3), cm(mz)]));
            self.world_k += 1;
            let hits: Vec<usize> = self.players.iter().enumerate()
                .filter(|(_, (u, v))| !v.dead && !v.gone && u.as_str() != mowner
                    && dist3([v.x, v.y + 0.9, v.z], [mx, my + 0.3, mz]) < METEOR_R)
                .map(|(j, _)| j)
                .collect();
            let shooter_i = self.players.iter().position(|(u, _)| u.as_str() == mowner).unwrap_or(0);
            for j in hits {
                let dead_now = {
                    let p = &mut self.players[j].1;
                    p.hp = (p.hp - METEOR_DMG).max(0);
                    p.hp <= 0
                };
                self.mark_all();
                if dead_now {
                    self.kill(shooter_i, j, 3, false, t);
                }
            }
            let _ = mteam;
        }
        // mines
        let mut fired = Vec::new();
        for mi in 0..self.mines.len() {
            let m = self.mines[mi].clone();
            let mut who: Option<usize> = None;
            for (j, (u, v)) in self.players.iter().enumerate() {
                if v.dead || v.gone || u.as_str() == m.owner || v.team == m.team {
                    continue;
                }
                if (v.x - m.x).hypot(v.z - m.z) < MINE_R && (v.y - m.y).abs() < 1.5 {
                    who = Some(j);
                    break;
                }
            }
            if let Some(j) = who {
                fired.push((mi, j, m.x, m.y, m.z, m.owner.clone()));
            }
        }
        for (mi, j, mx, my, mz, mowner) in fired.into_iter().rev() {
            self.mines.remove(mi);
            self.booms.push(json!([cm(mx), cm(my + 0.1), cm(mz)]));
            let shooter_i = self.players.iter().position(|(u, _)| u.as_str() == mowner).unwrap_or(0);
            if !self.players[j].1.dead {
                let dead_now = {
                    let p = &mut self.players[j].1;
                    p.hp = (p.hp - MINE_DMG).max(0);
                    p.hp <= 0
                };
                self.mark_all();
                if dead_now {
                    self.kill(shooter_i, j, 3, false, t);
                }
            }
        }
        // Chaos Core: a free blast every 1.5s on the holder
        let chaos_ids: Vec<usize> = (0..self.players.len())
            .filter(|&i| self.players[i].1.chaos_until > t && self.players[i].1.chaos_next <= t
                && !self.players[i].1.dead)
            .collect();
        for i in chaos_ids {
            self.players[i].1.chaos_next = t + 1.5;
            let (cx, cy, cz) = {
                let p = &self.players[i].1;
                (p.x, p.y + 0.5, p.z)
            };
            let my_team = self.players[i].1.team;
            self.booms.push(json!([cm(cx), cm(cy), cm(cz)]));
            let hits: Vec<usize> = self.players.iter().enumerate()
                .filter(|(j, (_u, v))| *j != i && !v.dead && !v.gone && v.team != my_team
                    && dist3([v.x, v.y + 0.9, v.z], [cx, cy, cz]) < 3.5)
                .map(|(j, _)| j)
                .collect();
            for j in hits {
                let dead_now = {
                    let p = &mut self.players[j].1;
                    p.hp = (p.hp - 20).max(0);
                    p.hp <= 0
                };
                self.mark_all();
                if dead_now {
                    self.kill(i, j, 3, false, t);
                }
            }
        }
        // arena events: warn then hold
        if self.event_at.map(|at| t >= at).unwrap_or(false) {
            self.event_at = Some(t + EVENT_GAP);
            self.world_k += 1;
            let pick = (hash_match(self.world_k as u32, 7) * 3.0) as usize % 3;
            let kind = ["lowg", "storm", "nosprint"][pick];
            self.pending.push(("event", json!({"kind": kind, "warn": (EVENT_WARN * 1000.0) as i64,
                                                    "dur": (EVENT_DUR * 1000.0) as i64})));
            self.event = Some(ArenaEvent { kind, until: t + EVENT_WARN + EVENT_DUR });
        }
        if self.event.as_ref().map(|e| e.until <= t).unwrap_or(false) {
            self.event = None;
            self.pending.push(("event", json!({"kind": "clear"})));
        }
        // Wave D: the arena-wide disasters (one at a time; both sides suffer)
        self.disaster_tick(t);
        // Contested Capture crate: spawn occasionally, claim by standing on it
        if self.capture.is_none() && self.hot_at.map(|at| t >= at).unwrap_or(false) {
            self.hot_at = Some(t + 50.0);
            self.world_k += 1;
            let (x, z) = self.open_spot((self.world_k as u32).wrapping_mul(2654435761).wrapping_add(9));
            self.capture = Some(CaptureCrate { id: self.world_k, x, y: 0.0, z, who: None, since: 0.0 });
            self.pending.push(("crate", json!({"x": cm(x), "z": cm(z), "id": self.world_k})));
        }
        if self.capture.is_some() {
            let mut done = false;
            let mut winner: Option<usize> = None;
            {
                let cr = self.capture.as_ref().unwrap();
                let mut stand = None;
                for (j, (_, v)) in self.players.iter().enumerate() {
                    if v.dead || v.gone {
                        continue;
                    }
                    if (v.x - cr.x).hypot(v.z - cr.z) < 2.0 && (v.y - cr.y).abs() < 1.5 {
                        stand = Some(j);
                        break;
                    }
                }
                // claim progress resets when the standee changes or leaves
                let need = match stand {
                    None => {
                        if self.capture.as_ref().unwrap().who.is_some() {
                            self.capture.as_mut().unwrap().who = None;
                            self.capture.as_mut().unwrap().since = 0.0;
                        }
                        false
                    }
                    Some(j) => {
                        let uid = self.players[j].0.clone();
                        let cr = self.capture.as_mut().unwrap();
                        if cr.who.as_deref() != Some(uid.as_str()) {
                            cr.who = Some(uid);
                            cr.since = t;
                        }
                        t - cr.since >= CRATE_CLAIM
                    }
                };
                if need {
                    done = true;
                    winner = stand;
                }
            }
            if done {
                let w = winner.unwrap_or(0);
                self.players[w].1.res.iter_mut().for_each(|r| *r = (*r + 20).min(200));
                self.players[w].1.hp = HP.min(self.players[w].1.hp + 25);
                self.pending.push(("captured", json!({"i": self.players[w].1.slot})));
                self.capture = None;
            }
        }
        // Totem Fusion: two unclaimed totems within FUSE_R merge into one stronger drop
        if self.fuse_at.map(|at| t >= at).unwrap_or(false) {
            self.fuse_at = Some(t + 18.0);
            let (a0, a1, _, _) = self.drop_rings();
            let mut pair: Option<(usize, usize)> = None;
            for x in a0..a1 {
                if self.items[x].is_some() || self.kinds[x].is_empty() { continue; }
                for y in (x + 1)..a1 {
                    if self.items[y].is_some() || self.kinds[y].is_empty() { continue; }
                    let d = (self.spots[x][0] - self.spots[y][0]).hypot(self.spots[x][2] - self.spots[y][2]);
                    if d <= FUSE_R {
                        pair = Some((x, y));
                        break;
                    }
                }
                if pair.is_some() { break; }
            }
            if let Some((x, y)) = pair {
                self.kinds[x] = "chaos";
                self.items[x] = None;
                self.kinds[y] = "";
                self.items[y] = Some(t + 1e9);
                self.pending.push(("fused", json!({"i": x, "kind": "chaos"})));
            }
        }
        // gravflip / event low-gravity: stamp body.gm for bot bodies
        let lowg = self.event.as_ref().map(|e| e.kind == "lowg" && e.until > t).unwrap_or(false);
        for (_, p) in self.players.iter_mut() {
            let g = if p.grav_until > t || lowg { 0.42 } else { 1.0 };
            if let Some(b) = p.bot.as_mut() {
                b.body.gm = g;
            }
        }
        for i in 0..self.items.len() {
            if self.items[i].map(|b| t >= b).unwrap_or(false) {
                self.items[i] = None;
                // a map pack coming back carries its fresh spot (cm / 100), never the
                // pad it left; drop-ring slots are replaced by the drop clocks instead
                let mut ev = json!({"i": i, "on": 1});
                if i < self.map().pickups.len() {
                    ev["x"] = json!(cm(self.spots[i][0]));
                    ev["z"] = json!(cm(self.spots[i][2]));
                }
                evs.push(("item", ev));
            }
        }
        // Disaster sense clocks: when a blind / slow window ends, ship the flag going
        // away (snap bits FLAG_BLIND / FLAG_SLOW) so the client drops its veil / crawl.
        for i in 0..self.players.len() {
            let mut drop = false;
            if self.players[i].1.blind_until > 0.0 && self.players[i].1.blind_until <= t {
                self.players[i].1.blind_until = 0.0;
                drop = true;
            }
            if self.players[i].1.slow_until > 0.0 && self.players[i].1.slow_until <= t {
                self.players[i].1.slow_until = 0.0;
                drop = true;
            }
            if drop {
                let u = self.players[i].0.clone();
                self.mark(&u);
            }
        }
        evs.append(&mut self.pending);
        // same fill as drop(): a blips-past-GRACE human is replaced too
        self.fill_bots(t);
        // over at the score limit, at the time, or when a side is empty of active players
        let empty0 = !self.players.iter().any(|(_, p)| p.team == 0 && !p.gone
            && p.away.map(|a| t - a < GRACE).unwrap_or(true));
        let empty1 = !self.players.iter().any(|(_, p)| p.team == 1 && !p.gone
            && p.away.map(|a| t - a < GRACE).unwrap_or(true));
        // While the Warden lives the clock and the scoreline are frozen: the round
        // can only end early by emptying a side.
        let warden_live = self.warden.is_some();
        let over_score = !warden_live && (self.scores[0] >= self.limit || self.scores[1] >= self.limit);
        let over_time = !warden_live && t >= self.ends_at;
        if over_score || over_time || empty0 || empty1 {
            self.phase = Phase::Done;
            let mut results = Vec::new();
            let (mut prev, mut place) = (None, 0usize);
            for (i, u) in self.order().iter().enumerate() {
                let p = self.player(u).expect("ordered player");
                let key = (p.team, p.kills, p.deaths);
                if Some(key) != prev {
                    place = i + 1;
                    prev = Some(key);
                }
                results.push(json!({"user": p.user, "place": place, "team": p.team,
                                    "bot": if p.is_bot() { 1 } else { 0 },
                                    "kills": p.kills, "deaths": p.deaths, "left": p.gone}));
            }
            results.push(json!({"teams": self.scores}));
            self.results = Some(Value::Array(results));
            if !self.shots.is_empty() || !self.booms.is_empty() || !self.rockets.is_empty() {
                evs.push(("snap", self.snap(t)));
            }
            evs.push(("done", json!({"results": self.results})));
            return evs;
        }
        if send && (!self.dirty.is_empty() || !self.shots.is_empty() || !self.booms.is_empty()
                    || !self.rockets.is_empty()) {
            evs.push(("snap", self.snap(t)));
        }
        evs
    }

    /// One snapshot: each changed player as [slot, x, y, z, yaw, pitch, hp,
    /// weapon, flags, when] (when: the server time of that position on the
    /// match clock; flags bit 16 = a bot), the shots judged since the last
    /// one, and ts = when it left.
    fn snap(&mut self, t: f64) -> Value {
        let mut ents = Vec::new();
        for uid in &self.dirty {
            let Some(p) = self.player(uid) else { continue };
            let f = (p.dead as i64) | if p.protect > t { 2 } else { 0 } | if p.away.is_some() { 4 } else { 0 }
                | if p.gone { 8 } else { 0 } | if p.is_bot() { 16 } else { 0 }
                | if p.shielded(t) { 32 } else { 0 }   // the drop shield or the shield totem's bubble
                | if p.charm_until > t { 64 } else { 0 }   // the mole's gold mark
                | if p.freeze_until > t { 128 } else { 0 }   // the paralyser's violet mark
                | if p.wings_fly > t { 256 } else { 0 }   // the wings totem's cruise window (rise+hover — bit off while gliding down)
                | if p.leap_until > t { 512 } else { 0 }   // the leap totem's jump window
                | if p.speed_until > t { 1024 } else { 0 }   // the speed totem's dash window
                | if p.grav_until > t { FLAG_GRAVFLIP } else { 0 }
                | if p.overclock_until > t { FLAG_OVERCLOCK } else { 0 }
                | if p.infchamber_until > t { FLAG_INFCHAMBER } else { 0 }
                | if p.magnet_until > t { FLAG_MAGNET } else { 0 }
                | if p.wallrun_until > t { FLAG_WALLRUN } else { 0 }
                | if p.fake_until > t { FLAG_FAKE } else { 0 }
                | if p.pocket_until > t { FLAG_POCKET } else { 0 }
                | if p.rally_until > t { FLAG_RALLY } else { 0 }
                | if p.king_until > t { FLAG_KING } else { 0 }
                | if p.hunter_until > t { FLAG_HUNTER } else { 0 }
                | if p.fate_until > t { FLAG_FATE } else { 0 }
                | if p.phoenix_until > t { FLAG_PHOENIX } else { 0 }
                | if p.radarjam_until > t { FLAG_JAM } else { 0 }
                | if p.blind_until > t { FLAG_BLIND } else { 0 }   // white-out veil
                | if p.slow_until > t { FLAG_SLOW } else { 0 };  // disaster crawl
            let when = p.hist.back().map(|h| self.ms(h.0)).unwrap_or(-1);
            ents.push(json!([p.slot, cm(p.x), cm(p.y), cm(p.z), p.r, p.pt, p.hp, p.w, f, when]));
        }
        let rockets: Vec<Value> = self.rockets.iter()
            .map(|r| json!([r.id, cm(r.x), cm(r.y), cm(r.z), (r.vx * 100.0) as i64,
                            (r.vy * 100.0) as i64, (r.vz * 100.0) as i64])).collect();
        // decoys: the full list while any lives (id, x, y, z, ms left, yaw in centidegrees)
        let decoys: Vec<Value> = self.decoys.iter()
            .map(|dc| json!([dc.id, cm(dc.x), cm(dc.y), cm(dc.z),
                             ((dc.until - t) * 1000.0) as i64, (dc.yaw * 100.0) as i64])).collect();
        // Wave C world extras (additive keys — an old client just ignores them)
        let portals: Vec<Value> = self.portals.iter()
            .map(|q| json!([q.id, cm(q.x), cm(q.z), ((q.until - t) * 1000.0) as i64])).collect();
        let mines: Vec<Value> = self.mines.iter()
            .map(|q| json!([q.id, cm(q.x), cm(q.z), q.team])).collect();
        let meteors: Vec<Value> = self.meteors.iter()
            .map(|q| json!([q.id, cm(q.x), cm(q.z), ((q.hit_at - t) * 1000.0) as i64])).collect();
        let beacons: Vec<Value> = self.beacons.iter()
            .map(|q| json!([q.id, cm(q.x), cm(q.z), q.kind, q.team, ((q.until - t) * 1000.0) as i64])).collect();
        let bubbles: Vec<Value> = self.bubbles.iter()
            .map(|q| json!([q.id, cm(q.x), cm(q.y), cm(q.z), cm(q.r), q.team, ((q.until - t) * 1000.0) as i64])).collect();
        // "ae" not "ev": Out::msg() writes the event name under "ev", and a data key of
        // that name would clobber it (so the frame would claim to be an array and the
        // client would drop the whole snapshot). fa/ae/di durations are milliseconds.
        let fate_row = self.fate.as_ref().map(|f| json!([((f.until - t).max(0.0) * 1000.0) as i64]));
        let ev_row = self.event.as_ref().map(|e| json!([e.kind, ((e.until - t).max(0.0) * 1000.0) as i64]));
        let crate_row = self.capture.as_ref().map(|c| {
            let prog = c.who.as_ref().map(|_| {
                let cr = self.capture.as_ref().unwrap();
                ((t - cr.since) / CRATE_CLAIM * 100.0).clamp(0.0, 100.0) as i64
            }).unwrap_or(0);
            json!([cm(c.x), cm(c.z), prog])
        });
        // Wave D/E: the live disaster ("di" — never "ev", which Out::msg() owns) and the
        // impact marks it has warned about ("dm"), both ms from the client clock.
        // di = [kind, ms to warn-end, ms to hold-end, cm ring, ms to NEXT auto-disaster].
        // di[4] is always present so the top bar can count the next one down even when
        // nothing is live (the row is then [null, 0, 0, 0, ms-to-next]).
        let dis_next = self
            .disaster_at
            .map(|at| ((at - t).max(0.0) * 1000.0) as i64)
            .unwrap_or(0);
        let dis_row = self.disaster.as_ref().map(|d| {
            json!([d.kind, ((d.warn_at - t).max(0.0) * 1000.0) as i64,
                   ((d.until - t).max(0.0) * 1000.0) as i64, cm(d.ring), dis_next,
                   d.seed, d.zones.iter().map(|z| json!([cm(z.0), cm(z.1)])).collect::<Vec<_>>(),
                   [cm(d.pit.0), cm(d.pit.1)]])
        }).or_else(|| {
            // no live disaster: still ship the countdown row so the top bar ticks
            if self.disaster_at.is_some() {
                Some(json!([Value::Null, 0, 0, 0, dis_next]))
            } else {
                None
            }
        });
        let marks: Vec<Value> = self.warns.iter()
            .map(|w| json!([w.id, cm(w.x), cm(w.z), ((w.hit_at - t).max(0.0) * 1000.0) as i64,
                            cm(w.r), if w.overhead { 1 } else { 0 }, w.dmg, w.quake as i64]))
            .collect();
        // The Warden ("wd" — never "ev"): [hp, max, cm x, cm z,
        // ms-to-slab-arm, ms-to-slab-land, ms-to-laser-warn, laser-on-ms,
        // laser-yaw-cdeg, ms-to-dis, ck-bitmask, yaw-cdeg,
        // ms-core, ms-grip-warn, ms-grip-on, ms-grip-at].
        let warden_row = self.warden.as_ref().map(|wd| {
            let mut ck = 0i64;
            for (i, c) in wd.ck.iter().enumerate() {
                if *c {
                    ck |= 1 << i;
                }
            }
            let ms = |at: f64| ((at - t).max(0.0) * 1000.0) as i64;
            json!([
                wd.hp,
                wd.max,
                cm(wd.x),
                cm(wd.z),
                if wd.slab_arm > 0.0 { ms(wd.slab_arm) } else { 0 },
                if wd.slab_land > 0.0 { ms(wd.slab_land) } else { 0 },
                if wd.laser_warn > 0.0 { ms(wd.laser_warn) } else { 0 },
                if wd.laser_on > t { ((wd.laser_on - t) * 1000.0) as i64 } else { 0 },
                (wd.laser_yaw.to_degrees() * 100.0).round() as i64,
                if wd.dis_at > t { ms(wd.dis_at) } else { 0 },
                ck,
                (wd.yaw.to_degrees() * 100.0).round() as i64,
                if wd.core_until > t { ms(wd.core_until) } else { 0 },
                if wd.grip_warn > 0.0 { ms(wd.grip_warn) } else { 0 },
                if wd.grip_on > t { ms(wd.grip_on) } else { 0 },
                if wd.grip_at > t { ms(wd.grip_at) } else { 0 }
            ])
        });
        let snap = json!({"k": self.k, "ts": self.ms(t), "ms": self.ms_left(t), "sc": self.scores,
                          "p": ents, "s": self.shots, "r": rockets, "b": self.booms, "d": decoys,
                          "po": portals, "mi": mines, "me": meteors, "bc": beacons, "bu": bubbles,
                          "fa": fate_row, "ae": ev_row, "cr": crate_row,
                          "di": dis_row, "dm": marks, "wd": warden_row});
        self.dirty.clear();
        self.shots.clear();
        self.booms.clear();
        self.sent.push_back((self.k, t));
        while self.sent.front().map(|s| t - s.1 > RTT_WINDOW + 1.0).unwrap_or(false) {
            self.sent.pop_front();
        }
        snap
    }
}

// --------------------------------------------------------------------- hub --
/// One room's strike state: the lobby and the match.
#[derive(Debug, Default)]
pub struct StrikeRoom {
    pub lobby: Lobby,
    pub strike: Strike,
}

fn lobby_put(l: &mut Lobby, uid: &str, pubv: Value) {
    match l.members.iter_mut().find(|(u, _)| u == uid) {
        Some(slot) => slot.1 = pubv,
        None => l.members.push((uid.to_string(), pubv)),
    }
}

fn lobby_pop(l: &mut Lobby, uid: &str) -> Option<Value> {
    let i = l.members.iter().position(|(u, _)| u == uid)?;
    Some(l.members.remove(i).1)
}

/// The arena game for every room: lobby, referee and the per-room tick loop.
#[derive(Clone)]
pub struct StrikeHub {
    inner: Arc<HubInner>,
}

struct HubInner {
    rooms: RoomManager,
    reg: Arc<Registry>,
    clock: Clock,
    /// Where a finished game is written down. Empty in the unit tests.
    results: Recorder,
    state: Mutex<HashMap<String, StrikeRoom>>,
}

fn tick_key(room_id: &str) -> String {
    format!("strike:{room_id}")
}

impl StrikeHub {
    pub fn new(
        rooms: RoomManager, reg: Arc<Registry>, clock: Clock, results: Recorder,
    ) -> Self {
        Self {
            inner: Arc::new(HubInner {
                rooms, reg, clock, results, state: Mutex::new(HashMap::new()),
            }),
        }
    }

    pub fn now(&self) -> f64 {
        (self.inner.clock)()
    }

    pub fn registry(&self) -> &Arc<Registry> {
        &self.inner.reg
    }

    pub fn with_room<R>(&self, room_id: &str, f: impl FnOnce(&mut StrikeRoom) -> R) -> Option<R> {
        self.inner.state.lock().unwrap().get_mut(room_id).map(f)
    }

    /// A `{"type": "game", "g": "strike", ...}` message from one socket.
    pub async fn handle(&self, room_id: &str, conn: u64, member: &Member, msg: &Value) {
        let Some(op) = msg.get("op").and_then(Value::as_str) else {
            let mut out = Out::new(GAME);
            out.err(conn, "unknown game");
            self.flush(room_id, out).await;
            return;
        };
        let mut out = Out::new(GAME);
        let mut invite: Option<String> = None;
        {
            let t = self.now();
            let uid = member.user_id.as_str();
            let mut st = self.inner.state.lock().unwrap();
            let v = st.entry(room_id.to_string()).or_default();
            match op {
                "join" => {
                    let lobby = &mut v.lobby;
                    if !lobby.has(uid) && lobby.members.len() >= MAX_LOBBY {
                        out.err(conn, "this game's lobby is full");
                    } else {
                        let fresh = !lobby.has(uid);
                        let blip = lobby.blips.remove(uid);
                        let returning = blip.map(|b| t - b < HOST_GRACE).unwrap_or(false);
                        lobby.blips.retain(|_, b| t - *b < HOST_GRACE);
                        lobby_put(lobby, uid, member.public());
                        let ph = lobby.prev_host.clone();
                        let host_gone = lobby.host.as_deref().map(|h| !lobby.has(h)).unwrap_or(true);
                        let host_back = ph.as_ref().map(|(h, at)| h == uid && t - at < HOST_GRACE).unwrap_or(false);
                        if host_gone || host_back {
                            lobby.host = Some(uid.to_string());
                        }
                        if ph.map(|(h, at)| h == uid || t - at >= HOST_GRACE).unwrap_or(false) {
                            lobby.prev_host = None;
                        }
                        let joined = if fresh && !returning { member.public() } else { Value::Null };
                        out.push(To::All, "lobby",
                                 json!({"members": lobby.roster(), "joined": joined, "name": GAME_NAME}));
                        if v.strike.enter(uid, member.public(), t) {
                            out.push(To::Users(v.lobby.ids(), None), "strike",
                                     json!({"match": v.strike.view(t), "back": uid}));
                        } else {
                            out.push(To::Conn(conn), "strike", json!({"match": v.strike.view(t)}));
                        }
                    }
                }
                "leave" => leave_lobby(v, uid, &mut out, false, t),
                "invite" => {
                    let to = msg.get("to").and_then(Value::as_str).unwrap_or("");
                    if !v.lobby.has(uid) {
                        out.err(conn, "join the lobby first");
                    } else if to.is_empty() || to == uid {
                        out.err(conn, "invite someone else");
                    } else {
                        invite = Some(to.to_string());
                    }
                }
                _ if !v.lobby.has(uid) => out.err(conn, "join the lobby first"),
                _ => self.strike_op(room_id, v, conn, member, op, msg, &mut out, t),
            }
        }
        if let Some(to) = invite {
            let payload = json!({"type": "game", "g": GAME, "ev": "invite", "pv": crate::protocol::version(GAME),
                                 "from": member.public(), "room": room_id, "name": GAME_NAME});
            let delivered = self.inner.rooms.deliver_to_user(&to, payload.to_string()).await;
            out.push(To::Conn(conn), "invited", json!({"to": to, "delivered": delivered}));
        }
        self.flush(room_id, out).await;
    }

    #[allow(clippy::too_many_arguments)]
    fn strike_op(&self, room_id: &str, v: &mut StrikeRoom, conn: u64, member: &Member, op: &str, msg: &Value,
                 out: &mut Out, t: f64) {
        let uid = member.user_id.as_str();
        let ids = v.lobby.ids();
        let sm = &mut v.strike;
        match op {
            "pos" => {
                if let (_, Some(fix)) = sm.pos(uid, msg, t) {
                    out.push(To::Conn(conn), "fix", fix);
                }
            }
            "fire" => {
                if let (_, Some(sync)) = sm.fire(uid, msg, t) {
                    out.push(To::Conn(conn), "ammo", sync);
                }
            }
            "reload" => {
                sm.reload(uid, msg, t);
            }
            "weapon" => {
                sm.weapon(uid, msg, t);
            }
            "view" => out.push(To::Conn(conn), "strike", json!({"match": sm.view(t)})),
            "char" => match sm.char(uid, msg) {
                None => out.err(conn, "pick a character"),
                Some(c) => out.push(To::Users(ids, None), "char", json!({"user": uid, "c": c})),
            },
            "start" | "end" => {
                if v.lobby.host.as_deref() != Some(uid) {
                    out.err(conn, "only the host can do that");
                    return;
                }
                v.lobby.prev_host = None;
                let sm = &mut v.strike;
                if op == "start" {
                    let null = Value::Null;
                    let mut err = sm.start(&v.lobby.members, msg.get("minutes").unwrap_or(&null),
                                           msg.get("kills").unwrap_or(&null),
                                           msg.get("tsize").unwrap_or(&null),
                                           msg.get("diff").unwrap_or(&null),
                                           msg.get("map").unwrap_or(&null),
                                           msg.get("warden").unwrap_or(&null), t);
                    if err.is_none() && !self.tick_on(room_id) {
                        sm.end();
                        err = Some("the Arena is busy right now: try again in a minute".into());
                    }
                    match err {
                        Some(e) => out.err(conn, &e),
                        None => out.push(To::Users(ids, None), "strike",
                                         json!({"match": sm.view(t), "by": member.public()})),
                    }
                } else {
                    sm.end();
                    self.inner.reg.stop(&tick_key(room_id));
                    out.push(To::Users(ids, None), "strike", json!({"match": sm.view(t)}));
                }
            }
            _ => {}
        }
    }

    fn tick_on(&self, room_id: &str) -> bool {
        let hub = self.clone();
        let rid = room_id.to_string();
        let clock = self.inner.clock.clone();
        let step = move |t: f64, send: bool, tk: Arc<Ticker>| {
            let hub = hub.clone();
            let rid = rid.clone();
            async move { hub.step(&rid, t, send, &tk).await }
        };
        self.inner.reg.start(&tick_key(room_id), HZ, step, clock).is_some()
    }

    async fn step(&self, room_id: &str, t: f64, send: bool, tk: &Ticker) -> bool {
        if !self.inner.rooms.exists(room_id).await {
            return false;
        }
        let (out, ids, running) = {
            let mut st = self.inner.state.lock().unwrap();
            let Some(v) = st.get_mut(room_id) else { return false };
            if !v.strike.running() {
                return false;
            }
            let mut ids = v.lobby.ids();
            for (u, _) in &v.strike.players {
                if !v.lobby.has(u) {
                    ids.push(u.to_string());
                }
            }
            let mut out = Out::new(GAME);
            for (ev, data) in v.strike.tick(t, send) {
                out.push(To::Users(ids.clone(), None), ev, data);
            }
            let running = v.strike.running();
            if !running {
                out.push(To::Users(ids.clone(), None), "strike", json!({"match": v.strike.view(t)}));
            }
            (out, ids, running)
        };
        if !out.items.is_empty() {
            let n = self.inner.rooms.count_where(room_id, |m| ids.contains(&m.user_id)).await;
            let bytes: usize = out.items.iter().map(|(_, p)| p.to_string().len()).sum();
            tk.count(bytes * n.max(1));
            self.flush(room_id, out).await;
        }
        running
    }

    /// A socket went away: if that was the user's last socket in the room, leave
    /// the lobby as a blip. Call before `RoomManager::leave`.
    pub async fn on_disconnect(&self, room_id: &str, conn: u64, member: &Member) {
        if self.with_room(room_id, |_| ()).is_none() {
            return;
        }
        let uid = member.user_id.clone();
        if self.inner.rooms.other_conn(room_id, conn, |m| m.user_id == uid).await {
            return;
        }
        let mut out = Out::new(GAME);
        let t = self.now();
        self.with_room(room_id, |v| leave_lobby(v, &uid, &mut out, true, t));
        self.flush(room_id, out).await;
        if !self.inner.rooms.other_conn(room_id, conn, |_| true).await {
            self.inner.state.lock().unwrap().remove(room_id);
            self.inner.reg.stop(&tick_key(room_id));
        }
    }

    async fn flush(&self, room_id: &str, out: Out) {
        let rooms = &self.inner.rooms;
        for (to, payload) in out.items {
            // A finished game is written down from the event the server itself
            // sends the lobby or the room -- once per game, never from a
            // client. The Python records at the same point, in valley._flush.
            if matches!(to, To::All | To::Users(..)) {
                if let Some(g) = crate::results::is_done(&payload) {
                    self.inner.results.record_later(g, &payload);
                }
            }
            let s = payload.to_string();
            match to {
                To::All => {
                    rooms.send_where(room_id, |_| true, s).await;
                }
                To::Conn(c) => {
                    rooms.send_conn(room_id, c, s).await;
                }
                To::Users(ids, skip) => {
                    rooms.send_where(room_id, |m| ids.contains(&m.user_id)
                                     && skip.as_deref() != Some(m.user_id.as_str()), s).await;
                }
            }
        }
    }
}

fn leave_lobby(v: &mut StrikeRoom, uid: &str, out: &mut Out, disconnected: bool, t: f64) {
    let lobby = &mut v.lobby;
    let Some(who) = lobby_pop(lobby, uid) else { return };
    if disconnected {
        lobby.blips.insert(uid.to_string(), t);
    }
    if lobby.host.as_deref() == Some(uid) {
        lobby.host = lobby.members.first().map(|(u, _)| u.to_string());
        lobby.prev_host = if disconnected && lobby.host.is_some() { Some((uid.to_string(), t)) } else { None };
    }
    if v.strike.drop(uid, t, disconnected) {
        out.push(To::Users(v.lobby.ids(), None), "strike", json!({"match": v.strike.view(t), "left": uid}));
    }
    out.push(To::All, "lobby", json!({"members": v.lobby.roster(), "left": who, "name": GAME_NAME}));
}

#[cfg(test)]
mod tests;
