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
/// SINK is tuned so DROP_HEIGHT/SINK (≈2.89 s) lands inside DROP_TIME: the steer
/// window, the air let-up and the drop shield must all still be up at touchdown.
/// A sink that outlasted the window left the glider exposed mid-air — a camper then
/// deleted them and the next life dropped again (the "sky loop").
pub const DROP_SINK: f64 = 3.8;
pub const DROP_DRIFT: f64 = 4.5;
/// Extra canopy time past DROP_TIME before the judge abandons a glide that never
/// touched down (a floor gap). Then the fall is normal and the shield drops.
pub const DROP_LAND_GRACE: f64 = 1.5;
pub const ACCEL: f64 = 12.0;
pub const AIR_ACCEL: f64 = 3.0;
pub const GRAVITY: f64 = 18.0;
pub const JUMP_V: f64 = 6.5;
pub const FALL_MAX: f64 = 25.0;
// the movement totems' multipliers (shared with games/strike.js FS)
pub const LEAP_MULT: f64 = 3.0;   // the leap totem: Space-bar jumps this much taller
pub const SPEED_MULT: f64 = 2.0;  // the speed totem: plain WASD at this multiple of sprint pace
// ---- Wave F: the joke totems (Banana / Lava / Goose / Reverse / Black Hole /
// Weapon Roulette). Every number here is judged on both sides. Twins: the same
// names in games/strike.js FS.
pub const BANANA_N: usize = 10;
pub const BANANA_R: f64 = 14.0;
pub const BANANA_SLIP: f64 = 1.1;
pub const BANANA_SLIDE: f64 = 9.0;
pub const BANANA_SPIN: f64 = 2.2;
pub const LAVA_ZONES: usize = 5;
pub const LAVA_R: f64 = 3.2;
pub const LAVA_HOLD: f64 = 1.4;
pub const LAVA_DMG: i64 = 12;
pub const LAVA_LAUNCH: f64 = 8.0;
pub const GOOSE_SPEED: f64 = 11.0;
pub const GOOSE_HIT_R: f64 = 1.3;
pub const GOOSE_DMG: i64 = 18;
pub const GOOSE_KNOCK: f64 = 6.0;
pub const HOLE_R: f64 = 2.2;
pub const HOLE_PULL: f64 = 14.0;
/// How far the pull reaches. The help promises "everything and everyone", so this has
/// to cover the whole arena — never a bubble of HOLE_R * k. Twin: HOLE_REACH in JS.
pub const HOLE_REACH: f64 = 56.0;
pub const ROULETTE_GAP: f64 = 2.0;
// ---- Wave G: the trap-and-gadget totems (Mini Turret / Explosive Barrels /
// Laser Grid / Jump Pad / Death Lottery). Every number here is judged on both
// sides. Twins: the same names in games/strike.js FS.
pub const TURRET_N: usize = 3;
pub const TURRET_HP: i64 = 60;
pub const TURRET_RANGE: f64 = 14.0;
pub const TURRET_DMG: i64 = 8;
pub const TURRET_GAP: f64 = 0.7;
/// the body a bullet has to find
pub const TURRET_R: f64 = 0.55;
pub const BARREL_N: usize = 3;
pub const BARREL_HP: i64 = 40;
pub const BARREL_R: f64 = 12.0;
pub const BARREL_DMG: i64 = 750;
pub const BARREL_MIN: i64 = 250;
pub const BARREL_DIRECT: i64 = 1200;
/// the body a bullet has to find
pub const BARREL_RAD: f64 = 0.7;
/// the sky it drops from
pub const BARREL_FALL: f64 = 18.0;
pub const LASER_N: usize = 8;
pub const LASER_Y: f64 = 0.85;
pub const LASER_HALF: f64 = 0.32;
pub const LASER_LEN: f64 = 12.0;
pub const LASER_CLEAR: f64 = 1.15;
pub const PAD_N: usize = 3;
pub const PAD_R: f64 = 1.6;
pub const PAD_LAUNCH: f64 = 22.0;
pub const PAD_COOL: f64 = 2.5;
pub const LOTTERY_HEAL: i64 = 100;

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
// The Arena serves all four guns plus the grappling gun, launcher included: its rocket
// is a real missile the server flies in tick() (ROCKETS) and resolves as a blast
// (blast_damage), matching the browser's solo simulation (FS.MISSILE_V & co in
// games/strike.js). The grapple does zero damage — it hooks a match drone (swing) or a
// foe (drag + trigger lock). Real players only.
pub const NW: usize = 5;
pub const LAUNCH_W: usize = 3;
pub const GRAPPLE_W: usize = 4;
/// Bots roll a weapon in `0..BOT_WEAPON_MAX` (never the grapple).
pub const BOT_WEAPON_MAX: usize = 4;
pub const WEAPONS: [Weapon; NW] = [
    Weapon { id: "rapid", interval: 0.1, damage: 12, head: 18, mag: 30, reserve: 90, reload: 1.6, spread: 1.2,
             range: 60.0, pack: 60 },
    Weapon { id: "marksman", interval: 0.8, damage: 75, head: 112, mag: 5, reserve: 15, reload: 2.2, spread: 0.3,
             range: 120.0, pack: 10 },
    Weapon { id: "revolver", interval: 0.5, damage: 50, head: 75, mag: 6, reserve: 24, reload: 2.2, spread: 0.5,
             range: 70.0, pack: 12 },
    Weapon { id: "launcher", interval: 1.2, damage: 120, head: 120, mag: 1, reserve: 5, reload: 2.5, spread: 0.0,
             range: 60.0, pack: 2 },
    Weapon { id: "grapple", interval: 0.9, damage: 0, head: 0, mag: 5, reserve: 5, reload: 2.2, spread: 0.0,
             range: 40.0, pack: 5 },
];
// Match flight drones (grapple anchors) + the grappling gun's movement windows.
// Twins: GRAPPLE_W / DRONE_* / GRAPPLE_* in games/strike.js (STRIKE-SHARED).
pub const DRONE_Y: f64 = 7.5;
pub const DRONE_R: f64 = 0.8;
pub const DRONE_N: usize = 8;
pub const DRONE_PHASE: f64 = 1.3;
pub const GRAPPLE_TIME: f64 = 2.5;
pub const GRAPPLE_SWING: f64 = 11.0;
pub const GRAPPLE_UP: f64 = 6.0;
pub const GRAPPLE_PULL: f64 = 18.0;
pub const HOOK_LOCK: f64 = 2.0;
/// A shot-down match drone is a wreck for this long (its hull blocks nothing).
/// Twin: DRONE_DOWN_SECS in games/strike.js.
pub const DRONE_DOWN_SECS: f64 = 6.0;
/// How many non-disaster totems a falling drone scatters on the wreck.
/// Twin: DRONE_TOTEMS in games/strike.js.
pub const DRONE_TOTEMS: usize = 3;
pub const GRAPPLE_RISE: f64 = 4.0;
/// Snapshot flag: hooked by a grappling gun (cannot shoot). Next free bit under 2^31.
pub const FLAG_HOOK: i64 = 67_108_864;
/// Snapshot flag: the Big Head totem is live arena-wide (every skull doubled).
/// Repeated on every living player's row so the existing per-row decode just works.
pub const FLAG_BIGHEAD: i64 = 134_217_728;
/// Snapshot flag: this player is disco-dancing (the Disco totem's victim) and cannot
/// shoot. Per-player — the taker never carries it. Twin: FLAG_DISCO in games/strike.js.
pub const FLAG_DISCO: i64 = 268_435_456;
/// Reverse Controls totem is live arena-wide (everyone's WASD is reversed).
/// Twin: FLAG_REVERSE in games/strike.js. Repeated on every living player's row.
pub const FLAG_REVERSE: i64 = 536_870_912;
/// Weapon Roulette totem is live arena-wide (everyone's gun re-rolls every 2 s).
/// Twin: FLAG_ROULETTE in games/strike.js. Repeated on every living player's row.
pub const FLAG_ROULETTE: i64 = 1_073_741_824;
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

/// Match flight drones: DRONE_N ping-pong lanes drawn from the map bounds so every
/// shipped / user map gets anchors without a new JSON field. Twin: grappleRoutes.
pub fn grapple_routes(b: [f64; 6]) -> Vec<([f64; 3], [f64; 3], f64)> {
    let (x0, z0, x1, z1) = (b[0], b[2], b[3], b[5]);
    let (x0, x1) = if x1 > x0 + 1.0 { (x0, x1) } else { (x0, x0 + 84.0) };
    let (z0, z1) = if z1 > z0 + 1.0 { (z0, z1) } else { (z0, z0 + 60.0) };
    let y = DRONE_Y;
    let inset = 5.0;
    let (xs, mut xe) = (x0 + inset, x1 - inset);
    let (zs, mut ze) = (z0 + inset, z1 - inset);
    if xe < xs {
        xe = xs + 1.0;
    }
    if ze < zs {
        ze = zs + 1.0;
    }
    let xq = xs + (xe - xs) / 3.0;
    let xq2 = xs + (xe - xs) * 2.0 / 3.0;
    let zq = zs + (ze - zs) / 3.0;
    let zq2 = zs + (ze - zs) * 2.0 / 3.0;
    // eight slow sky lanes — each drone on its own path (twin of grappleRoutes)
    vec![
        ([xs, y, zs], [xe, y, zs], 3.2),
        ([xs, y, zq], [xe, y, zq], 3.6),
        ([xs, y, zq2], [xe, y, zq2], 3.0),
        ([xs, y, ze], [xe, y, ze], 3.4),
        ([xq, y, zs], [xq, y, ze], 3.5),
        ([xq2, y, zs], [xq2, y, ze], 3.1),
        ([xs, y, zs], [xe, y, ze], 3.3),
        ([xe, y, zs], [xs, y, ze], 3.7),
    ]
}

/// A match drone's centre at match-clock `t` (ping-pong along its lane). Twin: targetAt.
pub fn drone_at(tg: &([f64; 3], [f64; 3], f64), t: f64) -> [f64; 3] {
    let (a, b, s) = tg;
    let ln = (((b[0] - a[0]).powi(2) + (b[1] - a[1]).powi(2) + (b[2] - a[2]).powi(2)).sqrt()).max(1e-6);
    let ph = ((t * s / ln) % 2.0 + 2.0) % 2.0;
    let u = if ph <= 1.0 { ph } else { 2.0 - ph };
    [
        a[0] + (b[0] - a[0]) * u,
        a[1] + (b[1] - a[1]) * u,
        a[2] + (b[2] - a[2]) * u,
    ]
}

/// Squared distance from a ground point to a 2D segment (laser tripwire).
/// Twin: segDist2 in games/strike.js.
pub fn seg_dist2(px: f64, pz: f64, ax: f64, az: f64, bx: f64, bz: f64) -> f64 {
    let dx = bx - ax;
    let dz = bz - az;
    let l2 = dx * dx + dz * dz;
    let u = if l2 > 0.0 {
        ((px - ax) * dx + (pz - az) * dz) / l2
    } else {
        0.0
    };
    let u = u.clamp(0.0, 1.0);
    let qx = ax + dx * u - px;
    let qz = az + dz * u - pz;
    qx * qx + qz * qz
}

/// The body a bullet has to find. Twin: barrelBox in games/strike.js.
pub fn barrel_box(x: f64, y: f64, z: f64) -> Box3 {
    [
        x - BARREL_RAD,
        y - BARREL_RAD,
        z - BARREL_RAD,
        x + BARREL_RAD,
        y + BARREL_RAD * 1.6,
        z + BARREL_RAD,
    ]
}

/// The body a bullet has to find. Twin: turretBox in games/strike.js.
pub fn turret_box(x: f64, y: f64, z: f64) -> Box3 {
    [
        x - TURRET_R,
        y - TURRET_R,
        z - TURRET_R,
        x + TURRET_R,
        y + TURRET_R * 1.8,
        z + TURRET_R,
    ]
}

/// First match-drone hit along the ray: (dist, index). Twin: droneHit.
/// `downed`/`now` skip hulls that are currently shot down — a wreck blocks nothing
/// and cannot be hooked. `now` is the server clock, matching `downed[i]`.
pub fn drone_hit(
    o: [f64; 3],
    d: [f64; 3],
    routes: &[([f64; 3], [f64; 3], f64)],
    t: f64,
    maxd: f64,
    downed: &[f64],
    now: f64,
) -> Option<(f64, usize)> {
    let mut best: Option<(f64, usize)> = None;
    for (i, tg) in routes.iter().enumerate() {
        if downed.get(i).copied().unwrap_or(0.0) > now {
            continue;
        }
        let c = drone_at(tg, t);
        let b = [
            c[0] - DRONE_R,
            c[1] - DRONE_R * 0.7,
            c[2] - DRONE_R,
            c[0] + DRONE_R,
            c[1] + DRONE_R * 0.7,
            c[2] + DRONE_R,
        ];
        if let Some(h) = ray_box(o, d, &b) {
            if h < maxd && best.map(|(bd, _)| h < bd).unwrap_or(true) {
                best = Some((h, i));
            }
        }
    }
    best
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
/// Time Rewind travels this far back. Twin of FS.REWIND_S in games/strike.js.
pub const REWIND_S: f64 = 3.0;
/// How much of the body's trail the judge keeps. It has to cover the longest rewind
/// (a 1.2 s window cannot serve a 3 s rewind — the old code silently travelled 1.2 s).
pub const HIST_S: f64 = 3.0;
pub const COUNTDOWN: f64 = 4.0;
pub const RESPAWN: f64 = 3.0;
pub const PROTECT: f64 = 1.5;
/// The void: below the deck (or off the map box) with nothing to stand on. A fall-out
/// used to be an endless free-fall with no way back — VOID_SECS later the referee puts
/// you back under a canopy (that wait IS the penalty).
pub const VOID_Y: f64 = -2.0;
pub const VOID_SECS: f64 = 10.0;
/// Pickup half-extent, applied as a square on X and Z (not a circle): a walk-through
/// takes every slot in a cluster on the same pass, same as the solo client's local
/// `Math.abs(V.me.x - pk.at[0]) > 1.1` test. Twin: the literal 1.1 in
/// games/strike.js's `MAP.pickups.forEach`.
pub const PICK_R: f64 = 1.1;
pub const PICKUP_BACK: f64 = 15.0;
/// How far a client's claimed body may sit from the referee's own copy and still be
/// believed for a pickup once the claim is no longer fresh: one correction's walk.
/// A live walk refreshes the claim every pos frame, so those are always within
/// CLAIM_FRESH and are taken at the body the player is actually in — the judge's
/// copy freezes on a speed-cap / canopy / token-bucket refusal, and a 4 m leash to
/// that frozen copy used to throw the claim away mid-walk ("I went through it and
/// it was left behind"). Anti-teleport: an older claim must sit near our own copy.
pub const CLAIM_R: f64 = 4.0;
/// How fast the judge's copy falls behind a walk it is refusing to accept (m/s of
/// lag). A live walk at sprint pace is ~10 m/s; when our copy is frozen the claim
/// may legitimately sit that far from it one second later. The leash grows with the
/// lag and is capped at CLAIM_R_MAX.
pub const SPEED_CARRY: f64 = 12.0;
/// The hard ceiling on the claim leash: the most a body can legitimately be ahead of
/// the judge's copy in CLAIM_R_SECS at the fastest legal pace. Beyond this, the judge's
/// copy alone is the truth (anti-teleport).
pub const CLAIM_R_MAX: f64 = 14.0;
/// A claim younger than this is the walk itself (every "pos" frame rewrites one) and
/// is believed at the named body even when the referee's copy lags. Older than this
/// and it is a stall: only near the lag-scaled reach of our copy. A couple of send
/// intervals.
pub const CLAIM_FRESH: f64 = 0.2;
pub const CLAIM_R_SECS: f64 = 1.0;
pub const GRACE: f64 = 15.0;
// --- totems (the "hack" pickups): one drops every TOTEM_GAP during a round; the mole only
// appears when the other side fields a bot (it can't turn a human). Durations mirror
// games/strike.js TOTEMS, which is the client's word for what each gem does.
pub const TOTEM_GAP: f64 = 10.0;
pub const TOTEM_FIRST: f64 = 8.0;
/// The Big Head totem: every head in the arena doubles for this long (the taker too).
/// Twin: TOTEMS.bighead.dur / BIG_HEAD_S in games/strike.js.
pub const BIG_HEAD: f64 = 10.0;
/// The Big Head totem's head scale (1.0 = ordinary). The head AABB grows outward and
/// upward only. Twin: BIG_HEAD_S in games/strike.js.
pub const BIG_HEAD_S: f64 = 2.0;
/// The Disco totem: everyone except the taker dances and cannot shoot for this long.
/// Twin: TOTEMS.disco.dur in games/strike.js.
pub const DISCO: f64 = 8.0;
// ---- Wave F: the joke world totems (arena-wide, both sides suffer) ----
/// Banana Panic: peels scatter; anyone stepping on one slips, spins and slides.
/// Twin: TOTEMS.banana.dur in games/strike.js.
pub const BANANA: f64 = 10.0;
/// Floor Is Lava: random floor patches turn dangerous; standing too long launches
/// you upward with health loss. Twin: TOTEMS.lava.dur in games/strike.js.
pub const LAVA: f64 = 8.0;
/// Goose Attack: an angry goose chases the nearest player and headbutts them.
/// Twin: TOTEMS.goose.dur in games/strike.js.
pub const GOOSE: f64 = 10.0;
/// Reverse Controls: everyone's WASD is reversed. Twin: TOTEMS.reverse.dur in games/strike.js.
pub const REVERSE: f64 = 8.0;
/// Black Hole: a tiny black hole at the arena centre sucks everything in.
/// Twin: TOTEMS.blackhole.dur in games/strike.js.
pub const BLACKHOLE: f64 = 6.0;
/// Weapon Roulette: every 2 s everyone's weapon randomly switches.
/// Twin: TOTEMS.roulette.dur in games/strike.js.
pub const ROULETTE: f64 = 10.0;
// ---- Wave G: the trap-and-gadget set ----
/// Mini Turret: 3 turrets drop in and cover you. Twin: TOTEMS.turret.dur.
pub const TURRET: f64 = 10.0;
/// Explosive Barrels: instant — three barrels fall from the sky. Twin: TOTEMS.barrel.dur.
pub const BARREL: f64 = 0.0;
/// Laser Grid: tripwires criss-cross the floor. Twin: TOTEMS.laser.dur.
pub const LASER: f64 = 8.0;
/// Jump Pad: 3 launch pads on the ground. Twin: TOTEMS.jumppad.dur.
pub const JUMPPAD: f64 = 10.0;
/// Death Lottery: instant — one living enemy heals to full or drops dead. Twin: TOTEMS.lottery.dur.
pub const LOTTERY: f64 = 0.0;
pub const TOTEM_KINDS: [&str; 60] = [
    "mole", "freeze", "decoy", "cloak", "shield", "wings", "leap", "speed", "teleport",
    // Wave C — the unique set from the brainstorm (Time Freeze ≈ Paralyser and
    // Clone Army ≈ Decoy are deliberately skipped as repeats)
    "rift", "mirror", "gravflip", "rewind", "shock", "magnet", "chain", "trap",
    "mark", "blink", "bubble", "wallrun", "secondwind", "fakedeath", "ghost",
    "cluster", "overclock", "ricochet", "infchamber", "bodyswap", "rally",
    "meteor", "chaos", "phoenix", "pocket", "fate", "king", "radarjam",
    // Wave E — the joke power-ups. Big Head is arena-wide like a disaster but it
    // helps every shooter, so it rides the personal roster, not the disaster ring.
    // Disco is the other joke: a personal stun that hits everyone else.
    "bighead", "disco",
    // Wave F — the joke world totems (arena-wide, both sides suffer).
    "banana", "lava", "goose", "reverse", "blackhole", "roulette",
    // Wave G — the trap-and-gadget set (turrets / barrels / lasers / pads / lottery).
    "turret", "barrel", "laser", "jumppad", "lottery",
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
pub const DIS_MAX: usize = 6;    // concurrent disasters before the oldest is shed
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
/// Hurricane vortex: a caught body is taken up and spun around the column with no
/// way to walk out. Twin: DD_WIND_CATCH_* in games/strike.js.
pub const DD_WIND_CATCH_R: f64 = 3.6;
pub const DD_WIND_TOP: f64 = 4.2;
pub const DD_WIND_LIFT: f64 = 3.2;
pub const DD_WIND_SPIN: f64 = 2.6;
pub const DD_WIND_CATCH: f64 = 1.6;
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
// disaster-totem drops stop, and only the Warden calls disasters. The Warden never
// hurts a dragon; gunfire and disasters always do.
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
// hit volumes, in local space around (warden.x, warden.gy, warden.z): (half_w, half_d) + y span
pub const WARDEN_BOX_WAIST: (f64, f64, f64, f64) = (5.4, 3.6, 0.0, 4.8);   // (hw, hd, y0, y1)
pub const WARDEN_BOX_CHEST: (f64, f64, f64, f64) = (6.6, 3.9, 4.8, 11.4);
pub const WARDEN_BOX_HEAD: (f64, f64, f64, f64) = (2.7, 2.7, 11.4, 15.6); // no crit — body damage only
pub const WARDEN_BOX_ARM: (f64, f64, f64, f64) = (1.8, 1.8, 0.0, 15.0);    // each arm; x offset ±8.7
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
/// Aim / LOS probe heights (arm, chest, waist) and the laser-eye origin, all
/// measured from the deck under the boss (Warden.gy). Never prefer the head —
/// it is no weak point and must not be the default aim.
pub const WARDEN_SEE_HEAD: f64 = 13.5;
pub const WARDEN_SEE_CHEST: f64 = 7.8;
pub const WARDEN_SEE_WAIST: f64 = 3.6;
pub const WARDEN_SEE_ARM: f64 = 10.2;
/// Ground-warning lead: the ring paints this long before the slam lands.
pub const WARDEN_SLAB_WIRE: f64 = 0.9;
/// Roman numerals for the three health checkpoints (feed text).
pub const WARDEN_CHECK_NAMES: [&str; 4] = ["", "I", "II", "III"];

// ---- The Warden's dragons ----
// Six elemental drift-wyrms land with the boss. Press G to mount; the rider's
// ONLY attack is the breath. Untaken dragons roam the deck and bite. A disaster
// deals them DOUBLE what it deals a fighter; gunfire always hurts one. The
// Warden cannot hurt a dragon at all — only disasters and gunfire bring one
// down mid-fight. There is no out-of-bounds on a dragon: the sky is open.
// Twin: the WARDEN_DRAGON_* / DRAGON_* block in games/strike.js.
pub const WARDEN_DRAGON_N: usize = 6;
/// the elemental roster, Fire → Golden. Twin: WARDEN_DRAGON_TIERS in strike.js.
pub const WARDEN_DRAGON_TIERS: [&str; 6] = ["fire", "crystal", "storm", "ice", "shadow", "golden"];
pub const DRAGON_HP: i64 = 300;
/// damage per second the breath deals
pub const DRAGON_BREATH_DPS: i64 = 30;
/// how long one spray lasts
pub const DRAGON_BREATH_SECS: f64 = 4.0;
/// the reload between sprays
pub const DRAGON_INHALE_SECS: f64 = 4.0;
/// how far the breath reaches (a widening cone)
pub const DRAGON_BREATH_LEN: f64 = 15.0;
/// its half-width at the tip
pub const DRAGON_BREATH_W: f64 = 2.2;
/// rider's cruise speed (between run and sprint)
pub const DRAGON_SPEED: f64 = 8.0;
/// an untaken dragon's walk
pub const DRAGON_ROAM_SPEED: f64 = 3.0;
pub const DRAGON_BITE_R: f64 = 2.4;
pub const DRAGON_BITE_DMG: i64 = 14;
pub const DRAGON_BITE_CD: f64 = 1.4;
/// reserved — a dragon has no map edge or ceiling
pub const DRAGON_CAT: f64 = 2.0;
/// how close you must be to press G (the body is long)
pub const DRAGON_MOUNT_R: f64 = 6.0;
/// a bot claims an idle dragon after this long
pub const DRAGON_BOT_MOUNT: f64 = 12.0;
/// rider's feet above the mount (the camera adds EYE 1.6). Twin: DRAGON_SEAT in strike.js.
pub const DRAGON_SEAT: f64 = 0.42;
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
/// Rift totem: a standing ring you walk through. Twin of FS.RIFT_R / FS.RIFT_FRONT /
/// FS.RIFT_COOL in games/strike.js.
pub const RIFT_R: f64 = 1.15;
pub const RIFT_FRONT: f64 = 2.4;
pub const RIFT_COOL: f64 = 0.45;
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

/// The deck height at a point: the top of the highest box under it (0 if none).
/// FS.topUnder / top_under probe a full player body, so a probe at deck level never
/// sees a thin platform — this scans the boxes directly and takes the top. Used to
/// plant The Warden (and the Black Hole) ON the deck: the dockyard centre is a
/// raised platform, not y=0. Twin: holeGroundY in games/strike.js.
pub fn ground_y(m: &Map, x: f64, z: f64) -> f64 {
    let mut top = 0.0f64;
    for b in &m.boxes {
        if x > b[0] - 0.6 && x < b[3] + 0.6 && z > b[2] - 0.6 && z < b[5] + 0.6 && b[4] > top {
            top = b[4];
        }
    }
    top
}

/// The deck under a canopy: the top of the highest box whose XZ covers (x, z), or
/// `None` when nothing is there at all (a real floor gap — keep sinking into the void
/// clock). `top_under` needs the body to already overlap a box, so a probe from
/// `DROP_HEIGHT` never sees the floor and the whole descent sinks below the map; this
/// scans the boxes by XZ alone. Unlike `ground_y` it does NOT default to 0, so a drop
/// over water cannot plant the body on a floor that isn't. Twin: `deckUnder` in
/// `games/strike.js`.
pub fn deck_under(m: &Map, x: f64, z: f64) -> Option<f64> {
    let mut best: Option<f64> = None;
    for b in &m.boxes {
        if x > b[0] - 0.6 && x < b[3] + 0.6 && z > b[2] - 0.6 && z < b[5] + 0.6
            && best.map(|v| b[4] > v).unwrap_or(true)
        {
            best = Some(b[4]);
        }
    }
    best
}

/// The Warden's plant height. It is NOT the platform top: the golem's skirt is 18.6 m
/// wide and the dockyard's raised centre is only 8 m across, so parking the mesh on the
/// platform leaves most of the skirt hanging in mid-air — the "floating" look. Plant the
/// base at the lowest ground under the skirt's footprint, so the whole silhouette is on
/// the floor; the centre platform then passes through the skirt, which is exactly what a
/// colossal golem standing on the map would look like. Twin: wardenGroundY in
/// games/strike.js.
pub fn warden_ground_y(m: &Map, x: f64, z: f64) -> f64 {
    // skirt half-extents (part(18.6, 2.4, 12.0, …) in wardenBuild): 9.3 x 6.0, plus a margin
    const RX: f64 = 9.5;
    const RZ: f64 = 6.2;
    let g = ground_y(m, x, z);
    let a = ground_y(m, x - RX, z - RZ);
    let b = ground_y(m, x + RX, z - RZ);
    let c = ground_y(m, x - RX, z + RZ);
    let d = ground_y(m, x + RX, z + RZ);
    g.min(a).min(b).min(c).min(d)
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

/// The Big Head totem's head scale. `hs` of 1 (or anything <= 0) is an ordinary head;
/// the head box grows OUTWARD and UPWARD only — the body box never moves — so a chest
/// shot can never become a headshot, only a near-miss can. Twin: `hitBoxes` in games/strike.js.
pub fn hit_boxes(x: f64, y: f64, z: f64, hs: f64) -> (Box3, Box3) {
    let s = if hs > 0.0 { hs } else { 1.0 };
    let hr = HEAD_R * s;
    let ht = BODY_H + (HEAD_TOP - BODY_H) * s;
    ([x - BODY_R, y, z - BODY_R, x + BODY_R, y + BODY_H, z + BODY_R],
     [x - hr, y + BODY_H, z - hr, x + hr, y + ht, z + hr])
}

/// (distance, head?) where the ray first meets a player at (x, y, z), nearer than maxd.
/// `hs` is the Big Head totem's head scale (1.0 when heads are ordinary).
pub fn ray_player(o: [f64; 3], d: [f64; 3], x: f64, y: f64, z: f64, maxd: f64, hs: f64) -> Option<(f64, bool)> {
    let (body, head) = hit_boxes(x, y, z, hs);
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
/// `gy` is the deck under the boss (see [`ground_y`]) — every height is measured from it.
pub fn warden_aim(wx: f64, wz: f64, slot: usize, core: bool, gy: f64) -> (f64, f64, f64) {
    // open core: every bot focuses the exposed chest (still never the head)
    if core {
        return (wx, gy + WARDEN_SEE_CHEST, wz);
    }
    let side = if slot.is_multiple_of(2) { -1.0 } else { 1.0 };
    (wx + side * WARDEN_ARM_X, gy + WARDEN_SEE_ARM, wz)
}

/// The Warden is huge and centre cover hides its chest — return a hit height the
/// shooter can actually see. Prefer the arm (least damage); never the head.
/// `None` = fully covered. `gy` is the deck under the boss.
fn warden_see(m: &Map, o: [f64; 3], wx: f64, wz: f64, slot: usize, core: bool, gy: f64) -> Option<f64> {
    let side = if slot.is_multiple_of(2) { -1.0 } else { 1.0 };
    let pts: [(f64, f64); 4] = if core {
        [
            (wx, gy + WARDEN_SEE_CHEST),
            (wx + side * WARDEN_ARM_X, gy + WARDEN_SEE_ARM),
            (wx - side * WARDEN_ARM_X, gy + WARDEN_SEE_ARM),
            (wx, gy + WARDEN_SEE_WAIST),
        ]
    } else {
        [
            (wx + side * WARDEN_ARM_X, gy + WARDEN_SEE_ARM),
            (wx - side * WARDEN_ARM_X, gy + WARDEN_SEE_ARM),
            (wx, gy + WARDEN_SEE_CHEST),
            (wx, gy + WARDEN_SEE_WAIST),
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

/// A rift pair (Rift totem): two linked standing rings. Walking into one exits the
/// other; a projectile entering one does the same. `yaw` is the ring's facing in degrees.
#[derive(Clone, Debug)]
pub struct Portal {
    pub id: i64,
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub yaw: f64,
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

/// A Banana Panic peel on the deck. Anyone stepping on one slips, spins and slides.
#[derive(Clone, Debug)]
pub struct BananaPeel {
    pub id: i64,
    pub x: f64,
    pub z: f64,
}

/// A Floor Is Lava dangerous patch. Stand too long → launched up + burned.
#[derive(Clone, Debug)]
pub struct LavaZone {
    pub id: i64,
    pub x: f64,
    pub z: f64,
    pub r: f64,
}

/// The Goose Attack angry goose. Chases the nearest player; headbutts on contact.
#[derive(Clone, Debug)]
pub struct Goose {
    pub id: i64,
    pub x: f64,
    pub z: f64,
    pub until: f64,
}

/// One of the Warden's six elemental drift-wyrms. Press G to mount; the rider's
/// only attack is the breath (30 dps, 4 s spray, 4 s inhale). Untaken dragons
/// roam the deck and bite. The Warden never hurts a dragon; disasters deal one
/// the same damage they deal a fighter; gunfire always can. No out-of-bounds.
/// Twin: the dragon object in games/strike.js (`V.dragons`).
#[derive(Clone, Debug)]
pub struct Dragon {
    pub id: i64,
    /// roster tier index into WARDEN_DRAGON_TIERS (fire → golden)
    pub tier: usize,
    pub hp: i64,
    pub max: i64,
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub yaw: f64,
    /// who is riding it ("" = unmounted). Snapshot sends the player's slot.
    pub rider: String,
    /// seconds of breath left in this spray (DRAGON_BREATH_SECS when full)
    pub breath_left: f64,
    /// server clock at which the inhale ends and the breath refills
    pub recharge_at: f64,
    /// server clock until which the breath is actively spraying
    pub spray_until: f64,
    /// next bite when roaming
    pub bite_at: f64,
    /// when the bot-mount timer started (claim after DRAGON_BOT_MOUNT)
    pub idle_at: f64,
}

/// The Black Hole. Sucks everything toward its centre until it disappears.
#[derive(Clone, Debug)]
pub struct BlackHole {
    pub id: i64,
    pub x: f64,
    pub z: f64,
    pub until: f64,
}

/// A Mini Turret: stationary, tracks and shoots the nearest enemy in range.
/// Shoot it down (TURRET_HP) or wait out its window. Twin: V.turrets entries.
#[derive(Clone, Debug)]
pub struct Turret {
    pub id: i64,
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub team: u8,
    pub owner: String,
    pub hp: i64,
    pub until: f64,
    pub next: f64,
    pub yaw: f64,
}

/// An Explosive Barrel that fell out of the sky. Shooting it (or blasting it)
/// detonates a 10× launcher blast and chains the next barrel in radius.
#[derive(Clone, Debug)]
pub struct Barrel {
    pub id: i64,
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub hp: i64,
    pub landed: bool,
    /// Fall velocity (twin: BO.vy in games/strike.js). Starts at 0 and the tick
    /// drops it 28 m/s² until the barrel lands.
    pub vy: f64,
}

/// One Laser Grid tripwire. Walk into it and you die; jump clean over it
/// (y >= LASER_CLEAR) or walk beside it and you live.
#[derive(Clone, Debug)]
pub struct Laser {
    pub id: i64,
    pub ax: f64,
    pub az: f64,
    pub bx: f64,
    pub bz: f64,
    pub until: f64,
}

/// A Jump Pad. Step on it (y near the deck, inside PAD_R) and it throws you up.
#[derive(Clone, Debug)]
pub struct JumpPad {
    pub id: i64,
    pub x: f64,
    pub z: f64,
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
/// `overhead` marks the two that a shed roof stops. `dis` names the disaster that
/// warned it, so the client can attribute the mark (and its FX group) correctly
/// while several disasters run at once.
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
    pub dis: &'static str,
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
    /// The deck under the boss — every hit volume and LOS probe is measured from
    /// here, never from y=0 (the dockyard centre is a raised platform).
    pub gy: f64,
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
    /// Disco: the boss grooves until this clock and holds every attack.
    /// Twin: Warden.danceUntil / wardenDanceOn in games/strike.js.
    pub dance_until: f64,
}

impl Warden {
    /// The three torso volumes as axis-aligned boxes (waist, chest, head) plus
    /// the two arm volumes. `x`/`z` are the Warden's map centre and `gy` is the
    /// deck it stands on. Box3 is `[lo_x, lo_y, lo_z, hi_x, hi_y, hi_z]`.
    pub fn boxes(&self) -> [Box3; 5] {
        let (wx, wz, gy) = (self.x, self.z, self.gy);
        let vol = |hw: f64, hd: f64, y0: f64, y1: f64, cx: f64| {
            [cx - hw, gy + y0, wz - hd, cx + hw, gy + y1, wz + hd]
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
    /// Fractional heal not yet paid out as a whole hp (rally's 6 hp/s is 0.3 a tick
    /// at 20 Hz — truncating it every tick means hp never moves).
    pub hp_acc: f64,
    /// Fractional dragon-breath damage not yet paid out as a whole hp (30 dps is 1.5
    /// a tick at 20 Hz — rounding it every tick means the spray hits for 40 dps).
    /// Twin: `breathAcc` on the JS side (games/strike.js dragonBreathStep).
    pub breath_acc: f64,
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
    /// Last body the client itself claimed (x, y, z, server t), kept even when the
    /// frame is refused. Pickups test it as well as the judge's own copy so a
    /// rubber-band cannot miss a totem the player is standing on.
    pub claim: Option<(f64, f64, f64, f64)>,
    /// O(1) dirty gate: set by Strike::mark, cleared in snap(). The dirty Vec keeps
    /// snapshot order without a per-call scan of every player id.
    pub dirty: bool,
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
    /// A disco dancer holds still and cannot shoot until dance_until (the Disco totem's
    /// victim — the taker never carries it).
    pub charm_until: f64,
    pub freeze_until: f64,
    pub dance_until: f64,
    /// Banana Panic: slipped on a peel — spinning and sliding forward until slip_until.
    pub slip_until: f64,
    /// The slide direction the slip locked in (unit × BANANA_SLIDE). Re-asserted every
    /// step so a bot's wish cannot steer out of the slide. Twin: slipVx/slipVz in JS.
    pub slip_vx: f64,
    pub slip_vz: f64,
    /// Hurricane vortex: lifted and spun around the walking column until vortex_until.
    /// The orbit is re-asserted every tick so a body cannot walk out of it.
    /// Twin: V.me.vortex / ai.body.vortex in games/strike.js.
    pub vortex_until: f64,
    /// The column centre the grip is riding (it walks, so this follows it).
    pub vortex_x: f64,
    pub vortex_z: f64,
    /// Orbit angle and radius. Twin: `phase` / `rad` on the JS vortex window.
    pub vortex_phase: f64,
    pub vortex_rad: f64,
    /// Floor Is Lava: seconds spent standing on a live lava patch (reset on leaving it).
    pub lava_hold: f64,
    /// Black Hole: the referee lets a pulled body through at slide speed for a moment
    /// after the drag, so the drag is never rubber-banded. Twin: V.holeDrag in JS.
    pub hole_drag: f64,
    /// Jump Pad cool-down (server clock) — the pad throws you, then waits PAD_COOL
    /// before it can throw you again. Twin: B.padCool in games/strike.js.
    pub pad_cool: f64,
    /// Riding one of the Warden's dragons (the saddle: guns stowed, breath only).
    /// Twin: dragonRiding in games/strike.js. The mount op sets it; dragon_kill clears it.
    pub dragon_rider: bool,
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
    /// Grappling-gun windows: hooked (cannot shoot) and a drone-swing let-up.
    pub hook_until: f64,
    /// While hooked on a foe: (shooter x, z) we are being dragged toward.
    pub hook_pull: Option<(f64, f64)>,
    /// A live drone swing (also a air-guard let-up, like the wings totem).
    pub swing_until: f64,
    /// Climb target for a drone hook (the drone altitude). The client eases up to it
    /// like WING_RISE; the referee records it and never snaps `y`.
    pub swing_y: f64,
    /// Which match drone (index into `drones`) this player is swinging from.
    /// A shoot-down of that drone detaches them — they fall as if it never existed.
    pub hook_drone: Option<usize>,
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
            hp_acc: 0.0, breath_acc: 0.0, hp_original: HP, w: 0,
            mag: std::array::from_fn(|i| WEAPONS[i].mag), res: std::array::from_fn(|i| WEAPONS[i].reserve),
            last: std::array::from_fn(|_| VecDeque::new()), ready: -(1 << 30), reload: None, n: 0,
            kills: 0, deaths: 0, dead: false, respawn_at: 0.0, life: 0, spawn_t: t, protect: 0.0,
            void_at: 0.0,
            dirty: false,
            drop: false, drop_t: 0.0,
            away: None, gone: false, q: None, q0: 0, t0: t, off: None, qmax: None, at: t, air_at: t,
            claim: None,
            pb: (POS_BURST, t), fb: (FIRE_BURST, t), ob: (OP_BURST, t), fix_at: -1e9, sync_at: -1e9, bad: 0,
            hist: VecDeque::new(), rtts: VecDeque::new(), rtt: 0.0,
            charm_until: 0.0, freeze_until: 0.0, dance_until: 0.0, cloak_until: 0.0, shield_totem_until: 0.0,
            slip_until: 0.0, slip_vx: 0.0, slip_vz: 0.0, lava_hold: 0.0, hole_drag: 0.0, pad_cool: 0.0,
            vortex_until: 0.0, vortex_x: 0.0, vortex_z: 0.0, vortex_phase: 0.0, vortex_rad: 0.0,
            dragon_rider: false,
            wings_until: 0.0, wings_fly: 0.0, leap_until: 0.0, speed_until: 0.0,
            overclock_until: 0.0, infchamber_until: 0.0, magnet_until: 0.0, wallrun_until: 0.0,
            rally_until: 0.0, fake_until: 0.0, pocket_until: 0.0, fate_until: 0.0,
            king_until: 0.0, hunter_until: 0.0, hunter_by: String::new(), chaos_until: 0.0,
            chaos_next: 0.0, phoenix_until: 0.0, second_wind: false, fate_share: 0.0,
            blink_left: 0, ghost_left: 0, rico_left: 0, cluster_left: 0, chain_left: 0,
            swap_cd: 0.0, radarjam_until: 0.0, grav_until: 0.0, flag_extra: 0,
            slow_until: 0.0, blind_until: 0.0,
            hook_until: 0.0, hook_pull: None, swing_until: 0.0, swing_y: 0.0,
            hook_drone: None,
        }
    }

    fn is_bot(&self) -> bool {
        self.bot.is_some()
    }

    /// The drop shield: a parachute glide in flight. Nothing hurts a glider (they can
    /// still shoot out) until the boots touch. DROP_TIME is only the steer window; the
    /// shield holds for the whole canopy (steer + sink), with DROP_LAND_GRACE as a
    /// backstop so a glide that never lands cannot stay shielded forever.
    /// The shield totem grants the same untouchable bubble for SHIELD_TOTEM seconds.
    fn shielded(&self, t: f64) -> bool {
        (self.drop && self.drop_t > 0.0 && (t - self.drop_t) < DROP_TIME + DROP_LAND_GRACE)
            || self.shield_totem_until > t
            || self.pocket_until > t
            || (self.fake_until > t && self.fake_until - t > FAKE - 0.35)
    }
    /// The Phoenix / Second Wind pre-death check: true means the kill is cancelled.
    fn cheat_death(&mut self, t: f64) -> bool {
        if self.second_wind {
            self.second_wind = false;
            self.hp = (HP / 2).max(1);
            self.hp_acc = 0.0;
            self.breath_acc = 0.0;
            self.fake_until = t + 1.2;
            return true;
        }
        if self.phoenix_until > t {
            self.phoenix_until = 0.0;
            self.hp = HP;
            self.hp_acc = 0.0;
            self.breath_acc = 0.0;
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
        self.hp_acc = 0.0;
        self.breath_acc = 0.0;
        self.hp_original = HP;
        self.dead = false;
        self.mag = std::array::from_fn(|i| WEAPONS[i].mag);
        self.res = std::array::from_fn(|i| WEAPONS[i].reserve);
        // a bot draws a fresh weapon every life, launcher included (like the solo match).
        // The grappling gun is players-only — never rolled.
        if self.bot.is_some() {
            self.w = (mb32((self.slot as u32).wrapping_mul(131)
                .wrapping_add((t * 1000.0) as i64 as u32) & 0xFFFF) * BOT_WEAPON_MAX as f64)
                as usize;
        }
        self.reload = None;
        self.spawn_t = t;
        // Spawn cover starts when the boots touch, not when the canopy opens: a
        // glide rides the sky for DROP_TIME (and a sink at DROP_SINK can outlast
        // that window), so a clock started here is already spent before landing —
        // a camper then deletes you mid-air and the next life drops again. Mirror
        // the client (`V.protUntil = dropping ? 0 : t + 1.5`).
        self.protect = if self.drop { 0.0 } else { t + PROTECT };
        self.air_at = t;
        self.void_at = 0.0;   // a place is back on the map
        // A new life is never still in a saddle. Leaving this set skipped the void
        // rescue forever (it is gated on !dragon_rider) and kept the flight caps
        // relaxed after the mount was gone.
        self.dragon_rider = false;
        self.slow_until = 0.0;
        self.blind_until = 0.0;
        self.hook_until = 0.0;
        self.hook_pull = None;
        self.swing_until = 0.0;
        self.swing_y = 0.0;
        self.hook_drone = None;
        self.n = 0; // the spread sequence restarts each life
        self.charm_until = 0.0;
        self.freeze_until = 0.0;
        self.dance_until = 0.0;   // a dancer stands back up un-stunned
        self.slip_until = 0.0;
        self.hole_drag = 0.0;
        self.pad_cool = 0.0;
        self.slip_vx = 0.0;
        self.slip_vz = 0.0;
        self.vortex_until = 0.0;
        self.vortex_x = 0.0;
        self.vortex_z = 0.0;
        self.vortex_phase = 0.0;
        self.vortex_rad = 0.0;
        self.lava_hold = 0.0;
        self.shield_totem_until = 0.0;   // a death pops the shield totem's bubble too
        self.wings_until = 0.0;
        self.wings_fly = 0.0;
        self.leap_until = 0.0;
        self.speed_until = 0.0;
        self.life += 1;
        // a new life is a new body: drop the old claim so a respawn cannot take a
        // totem standing at the previous life's boots
        self.claim = None;
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
    // ---- Wave F: the joke world totems ----
    pub bananas: Vec<BananaPeel>,
    pub lava_zones: Vec<LavaZone>,
    /// LISTS — several geese / holes can run at once and each one stacks (never replaces).
    pub geese: Vec<Goose>,
    pub blackholes: Vec<BlackHole>,
    // ---- Wave G: the trap-and-gadget set ----
    pub turrets: Vec<Turret>,
    pub barrels: Vec<Barrel>,
    pub lasers: Vec<Laser>,
    pub pads: Vec<JumpPad>,
    /// Jump Pad / Laser Grid / Mini Turret windows (server clock) — arena-wide lists.
    pub turret_until: f64,
    pub laser_until: f64,
    pub pad_until: f64,
    /// The Warden's six elemental dragons (summoned with the boss). Twin: V.dragons.
    pub dragons: Vec<Dragon>,
    /// Reverse Controls totem window (server clock) — arena-wide, not per-player.
    pub reverse_until: f64,
    /// Weapon Roulette totem window (server clock) — arena-wide, not per-player.
    pub roulette_until: f64,
    /// Next Weapon Roulette re-roll (server clock).
    pub roulette_next: f64,
    pub fate: Option<FateLink>,
    pub event: Option<ArenaEvent>,
    pub event_at: Option<f64>,
    /// ---- Wave D: Arena Disasters ----
    /// Every live disaster (several can run at once — a new one never stops the old),
    /// and when the clock may start another. Cap DIS_MAX entries; oldest is shed.
    pub disasters: Vec<Disaster>,
    pub disaster_at: Option<f64>,
    /// Impacts the disaster has warned about (rings/markers) — drained at `hit_at`.
    pub warns: Vec<WarnMark>,
    pub capture: Option<CaptureCrate>,
    pub hot_at: Option<f64>,
    pub fuse_at: Option<f64>,
    pub world_k: i64,
    /// Big Head totem window (server clock): while live, every skull in the arena is
    /// BIG_HEAD_S wide/tall and the head hitbox matches. Arena-wide — not per-player.
    pub big_head_until: f64,
    /// The host's "Summon the Warden" option (half-score mid-match boss).
    pub warden_opt: bool,
    /// Set once the Warden has risen this match — it is a one-shot, not a recurring event.
    pub warden_done: bool,
    /// Match flight drones (grapple anchors): lanes from the map bounds, stepped in tick().
    pub drones: Vec<([f64; 3], [f64; 3], f64)>,
    /// Per-lane shoot-down clock (server `t` until which that hull is a wreck; 0.0 = up).
    /// Parallel to `drones`. Twin: `downUntil` on a JS match-drone.
    pub drone_down: Vec<f64>,
    /// The Warden, while it lives. None before it is summoned and after it dies.
    pub warden: Option<Warden>,
    /// ms_left frozen at the summon (the clock is parked here until it dies).
    pub warden_frozen_ms: i64,
    /// Players whose snapshot row changed since the last snap, in mark() order.
    /// mark() is O(1) via `Player.dirty` — the old Vec+scan was O(n²) in disaster loops.
    pub dirty: Vec<String>,
    /// A world list changed (turret / pad / banana / dragon / …) with no player row —
    /// forces a snap without dirtying every body in the arena.
    pub world_dirty: bool,
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
            world_dirty: false,
            kinds: Vec::new(), spots: Vec::new(), cursed: Vec::new(),
            totem_at: None, totem_k: 0, pack_at: None, pack_k: 0, dis_at: None, dis_k: 0,
            portals: Vec::new(), mines: Vec::new(), meteors: Vec::new(), beacons: Vec::new(),
            bubbles: Vec::new(), fate: None, event: None, event_at: None, capture: None,
            bananas: Vec::new(), lava_zones: Vec::new(), geese: Vec::new(), blackholes: Vec::new(),
            turrets: Vec::new(), barrels: Vec::new(), lasers: Vec::new(), pads: Vec::new(),
            turret_until: 0.0, laser_until: 0.0, pad_until: 0.0,
            dragons: Vec::new(),
            reverse_until: 0.0, roulette_until: 0.0, roulette_next: 0.0,
            hot_at: None, fuse_at: None, world_k: 0, big_head_until: 0.0,
            disasters: Vec::new(), disaster_at: None, warns: Vec::new(),
            warden_opt: true, warden_done: false, warden: None, warden_frozen_ms: 0,
            drones: Vec::new(), drone_down: Vec::new(),
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

    /// Bubble Fortress: true when (x, y, z) sits inside a live bubble defending `team`.
    /// Twin of `inBubble` in games/strike.js.
    fn in_bubble(&self, x: f64, y: f64, z: f64, team: u8, t: f64) -> bool {
        self.bubbles.iter().any(|b| {
            b.until > t && b.team == team && dist3([x, y, z], [b.x, b.y, b.z]) <= b.r
        })
    }

    /// King (×0.6) and Rally near its beacon (×0.7) shorten a reload.
    /// Twin of `reloadMult` in games/strike.js.
    fn reload_mult(&self, team: u8, x: f64, z: f64, t: f64) -> f64 {
        let mut m = 1.0;
        if self.players.iter().any(|(_, p)| p.team == team && p.king_until > t) {
            m *= 0.6;
        }
        if self.players.iter().any(|(_, p)| p.team == team && p.rally_until > t)
            && self.beacons.iter().any(|b| {
                b.kind == "rally" && b.until > t && b.team == team
                    && (x - b.x).hypot(z - b.z) < 10.0
            })
        {
            m *= 0.7;
        }
        m
    }

    fn mark(&mut self, uid: &str) {
        // O(1): the per-player bit is the membership test, the Vec keeps snapshot order.
        if let Some((_, p)) = self.players.iter_mut().find(|(u, _)| u == uid) {
            if !p.dirty {
                p.dirty = true;
                self.dirty.push(uid.to_string());
            }
        }
    }

    /// mark() by roster index — the disaster loops hold `j`, not the uid.
    fn mark_idx(&mut self, j: usize) {
        let uid = match self.players.get_mut(j) {
            Some((u, p)) => {
                if p.dirty {
                    return;
                }
                p.dirty = true;
                u.clone()
            }
            None => return,
        };
        self.dirty.push(uid);
    }

    fn mark_all(&mut self) {
        for (u, p) in self.players.iter_mut() {
            if !p.dirty {
                p.dirty = true;
                self.dirty.push(u.clone());
            }
        }
    }

    /// A world list (turrets / pads / dragons / …) changed with no player row to ship —
    /// forces the next snap without dirtying every body in the arena.
    fn mark_world(&mut self) {
        self.world_dirty = true;
    }

    /// The Big Head totem's live head scale (BIG_HEAD_S while the arena-wide window is
    /// open, else 1.0). Twin: the `hs` the solo client passes into FS.rayPlayer.
    fn head_scale(&self, t: f64) -> f64 {
        if self.big_head_until > t { BIG_HEAD_S } else { 1.0 }
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
        self.drones = grapple_routes(self.map().bounds());
        self.drone_down = vec![0.0; self.drones.len()];
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
        self.disasters.clear();
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
        for (_, p) in self.players.iter_mut() {
            p.dirty = true;
        }
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
        self.disasters.clear();
        self.disaster_at = None;
        self.dis_at = None;
        self.warns.clear();
        self.warden = None;
        self.warden_done = false;
        self.warden_frozen_ms = 0;
        // match teardown clears the summons (the Warden falling does not)
        self.dragon_dismiss();
        // …and the Wave G trap-and-gadget lists
        self.turrets.clear();
        self.barrels.clear();
        self.lasers.clear();
        self.pads.clear();
        self.turret_until = 0.0;
        self.laser_until = 0.0;
        self.pad_until = 0.0;
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
        let mut release_seat = false;
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
                // a rejoin is a new life — free any saddle the last one left behind,
                // or the void rescue (gated on !dragon_rider) never runs again
                p.dragon_rider = false;
                release_seat = true;
            }
            self.mark(uid);
            self.fill_bots(t);
            if release_seat {
                self.dragon_release(uid);
            }
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

    fn ack(sent: &VecDeque<(i64, f64)>, p: &mut Player, msg: &Value, q: Option<i64>, t: f64) {
        let (Some(kk), Some(q), Some(off)) = (as_num(msg.get("k"), 0.0, (1u64 << 30) as f64), q, p.off) else {
            return;
        };
        let kk = kk as i64;
        let arrived = as_num(msg.get("kq"), 0.0, ((1u64 << 30) - 1) as f64)
            .map(|v| v as i64)
            .filter(|kq| q - 100 <= *kq && *kq <= q)
            .unwrap_or(q);
        let mapped = arrived as f64 / 100.0 + off;
        for &(tick, at) in sent.iter().rev() {
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
    /// Borrows the body in place — the old `Player::new` swap allocated a whole Player
    /// (hist, rtts, nine weapon deques, a Bot) 25×/s per human and was the hottest
    /// allocation on the match's hot path.
    pub fn pos(&mut self, uid: &str, msg: &Value, t: f64) -> (bool, Option<Value>) {
        let Some(i) = self.idx(uid) else { return (false, None) };
        if self.phase != Phase::Round || self.players[i].1.is_bot() {
            return (false, None);
        }
        // Hoist the world state pos_inner reads (disjoint from `players`) so the body
        // can be mutably borrowed in place.
        let m = self.map();
        let nosprint = self.event.as_ref().map(|e| e.kind == "nosprint" && e.until > t).unwrap_or(false);
        let abs_zero = self.disaster_live("absolutezero", t);
        let portals = &self.portals;
        let sent = &self.sent;
        let res = Self::pos_inner(&mut self.players[i].1, msg, t, m, portals, sent, nosprint, abs_zero);
        if res.0 {
            self.mark(uid);
        }
        // Pickups run on every frame, accepted or refused. A refused frame still names
        // a body the player is standing in (claim), and the totem under their boots
        // must not wait for the next accepted move — that is the "taken later in a bulk".
        if !self.players[i].1.dead && !self.players[i].1.gone {
            self.pickups(i, t);
        }
        res
    }

    // (the world state pos_inner reads, split out of &self so the body can be
    // mutably borrowed in place — the Player::new swap was the hot-path alloc)
    #[allow(clippy::too_many_arguments)]
    fn pos_inner(
        p: &mut Player, msg: &Value, t: f64, m: &'static Map,
        portals: &[Portal], sent: &VecDeque<(i64, f64)>, nosprint: bool, abs_zero: bool,
    ) -> (bool, Option<Value>) {
        if p.dead || p.gone {
            return (false, None);
        }
        let g = |k: &str| as_num(msg.get(k), -1e6, 1e6);
        let (Some(x), Some(y), Some(z), Some(r)) = (g("x"), g("y"), g("z"), g("r")) else { return (false, None); };
        let pt = as_num(msg.get("p"), -9000.0, 9000.0);
        let (xm, ym, zm) = (x / 100.0, y / 100.0, z / 100.0);
        // A frame from a previous life names a body that no longer exists — never claim
        // with it (place() already dropped the old claim).
        if !p.this_life(msg) {
            return (false, None);
        }
        // Every pos frame of the CURRENT life names a body the client is standing in,
        // whether or not the referee accepts the move and whether or not the token
        // bucket drops the frame. Remember it (with our own t) so pickups() can test
        // the floor the player is actually on: a dropped frame used to leave the claim
        // stale, the judge's copy stayed frozen, and the totem under their boots was
        // "not taken".
        p.claim = Some((xm, ym, zm, t));
        if !bucket(&mut p.pb, POS_RATE, POS_BURST, t) {
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
            && !nosprint
            // Absolute Zero: everything is ice, so the ground barely bites — the ref
            // refuses the tall acceleration exactly like it refuses an overspeed dash
            && !abs_zero;
        // the movement totems buy room while their windows run (the server itself judged
        // them, so a raised cap can't be claimed by just sending the flag): the speed
        // totem's dash outranks the sprint flag, the leap totem's jumps rise taller
        // a banana slip slides at 9 m/s and is not a cheat — the ref lets it through.
        // Same for the Black Hole: its drag is an arena force, not a speed claim.
        // A hurricane grip is the same: the orbit is the column's motion, not a dash.
        let speed_cap = if p.slip_until > t || p.hole_drag > t || p.vortex_until > t {
            SPRINT_MAX_SPEED
        }
            else if p.speed_until > t { SPRINT_MAX_SPEED * SPEED_MULT }
            else if sprint { SPRINT_MAX_SPEED } else { MAX_SPEED };
        // Disaster slowness (quake throw / toxic choke / sink stumble / wind footing) bites
        // the same way Absolute Zero's ice does: the ref refuses the tall step.
        let speed_cap = if p.slow_until > t { speed_cap * DD_SLOW_MULT } else { speed_cap };
        let up_cap = if p.leap_until > t { JUMP_V * LEAP_MULT } else { JUMP_V };
        // a dragon rider's pose is the mount's pose: the flight cap, not the walk cap.
        // (twin: dragonTick in games/strike.js — the saddle moves at DRAGON_SPEED.)
        let (speed_cap, up_cap) = if p.dragon_rider {
            (DRAGON_SPEED * 1.35, DRAGON_SPEED * 1.35)
        } else {
            (speed_cap, up_cap)
        };
        let b = m.bounds();
        // A dragon rider flies anywhere: no map box, no ceiling, no fall cap. The
        // saddle pose is the mount's pose and the sky is open (twin: dragonTick).
        let mut ok = if p.dragon_rider {
            dt >= 0.0
        } else {
            dt >= 0.0 && b[0] <= xm && xm <= b[3] && b[1] <= ym && ym <= b[4] && b[2] <= zm && zm <= b[5]
        };
        // Rift walk-in: a body standing in one opening may hop to the other. That step is
        // a legal move (the same pair the Rift totem planted) so the referee doesn't
        // rubber-band the prediction back across the map. The hop lands just outside the
        // far ring's RIFT_R, so the next pos cannot re-enter on the way out.
        let mut rift_hop = false;
        if ok {
            for q in portals.iter() {
                if q.until <= t {
                    continue;
                }
                if (p.x - q.x).hypot(p.z - q.z) > RIFT_R || p.y.abs() > 1.3 {
                    continue;
                }
                let Some(o) = portals.iter().find(|o| o.id == q.pair && o.until > t) else {
                    continue;
                };
                // step-out past the far ring along the pair's own axis (entered -> exit),
                // the same rule as FS.riftHop in games/strike.js
                let (mut ax, mut az) = (o.x - q.x, o.z - q.z);
                let mut aln = ax.hypot(az);
                if aln <= 0.01 {
                    ax = q.yaw.to_radians().sin();
                    az = -(q.yaw.to_radians().cos());
                    aln = 1.0;
                }
                ax /= aln;
                az /= aln;
                let (ex, ez) = (o.x + ax * (RIFT_R + 0.35), o.z + az * (RIFT_R + 0.35));
                if (xm - ex).hypot(zm - ez) <= 0.7 && ym.abs() <= 1.3 {
                    rift_hop = true;
                    break;
                }
            }
        }
        if ok && !rift_hop && !p.dragon_rider {
            let across = (xm - p.x).hypot(zm - p.z);
            let dy = ym - p.y;
            ok = across <= speed_cap * dt + SLACK && dy <= up_cap * dt + STEP_H + SLACK
                && -dy <= FALL_MAX * dt + SLACK && overlaps(m, xm, ym, zm, SHRINK).is_none();
        } else if rift_hop {
            ok = overlaps(m, xm, ym, zm, SHRINK).is_none();
        }
        let mut grounded = false;
        if ok {
            grounded = overlaps(m, xm, ym - 0.1, zm, 0.0).is_some();
            // v4: a parachute-dropping life legitimately rides the sky for DROP_TIME after its
            // spawn — buy it the fall instead of snapping it back to the ground mid-glide.
            // Measured on OUR clock t, never the client's `clock`: p.off is a best-case RTT
            // sample and can run ahead of the server, which expired the let-up early and
            // then "fix"ed a live glide back to the spawn height (the sky-drop loop).
            let air_let_up = p.drop && p.drop_t > 0.0 && (t - p.drop_t) < DROP_TIME;
            // the wings totem parks the air clock too: a flyer is off the ground by design.
            // A grappling-gun drone swing is the same kind of let-up. A dragon saddle is
            // the same: the mount flies, so the rider is allowed to stay up with it.
            // A hurricane grip holds you in the air on purpose — the updraught is not a fall.
            let swing_let_up = p.swing_until > t;
            let ride_let_up = p.dragon_rider;
            let vortex_let_up = p.vortex_until > t;
            // a Jump Pad throw is a deliberate launch — buy the flight, like a wing.
            let pad_let_up = p.pad_cool > t;
            if !grounded && !air_let_up && !swing_let_up && !ride_let_up && !vortex_let_up
                && !pad_let_up && p.wings_until <= t
                && t - p.air_at > MAX_AIR
            {
                ok = false;
            }
            if p.drop && p.drop_t > 0.0 {
                // Touchdown (or a canopy that will never land) ends the glide and
                // starts spawn cover HERE — a clock begun at place() is already spent
                // before the boots touch, so a camper deletes you mid-air and the
                // next life drops again. Twin: `V.protUntil = dropping ? 0 : t + 1.5`.
                if grounded {
                    p.drop = false;
                    p.drop_t = 0.0;
                    p.protect = t + PROTECT;
                    p.air_at = t;
                } else if t - p.drop_t >= DROP_TIME + DROP_LAND_GRACE {
                    // never touched down (a floor gap under the canopy): end the glide
                    // on a timer so the shield cannot stick forever
                    p.drop = false;
                    p.drop_t = 0.0;
                    p.protect = t + PROTECT;
                    p.air_at = t;
                }
            }
        }
        if !ok {
            // A body that has really left the map must keep falling in the judge's
            // books. Returning the stale last legal floor here is what produced the
            // endless fall/fix loop: the client placeMe'd back onto the deck (which
            // also clears V.voidAt), fell off again, and the void clock never ran on
            // either side. Adopt the reported fall so in_void() sees it and the
            // rescue at VOID_SECS can fire; never accept a teleport out of one.
            if in_void(m, xm, ym, zm) {
                p.x = xm;
                p.y = ym;
                p.z = zm;
                p.at = t;
                p.hist.push_back((t, xm, ym, zm));
                while p.hist.len() > 2 && t - p.hist[0].0 > HIST_S {
                    p.hist.pop_front();
                }
                return (false, None);
            }
            if in_void(m, p.x, p.y, p.z) {
                return (false, None);
            }
            p.bad += 1;
            // A live parachute owns the body until it lands (or the canopy times out).
            // "fix" placeMe()s the client back to our copy, and placeMe clears the
            // client's V.dropUntil — so a correction mid-glide cut the canopy, dropped
            // the player again, and every following frame was refused until the next
            // "fix". That is the endless sky-fall loop. Let the glide finish first.
            if p.drop && p.drop_t > 0.0 && t - p.drop_t < DROP_TIME + DROP_LAND_GRACE {
                return (false, None);
            }
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
            p.air_at = t;
        }
        p.x = xm;
        p.y = ym;
        p.z = zm;
        p.r = (r as i64).rem_euclid(36000);
        p.pt = pt.map(|v| v as i64).unwrap_or(0);
        p.at = t;
        p.hist.push_back((mapped, xm, ym, zm));
        while p.hist.len() > 2 && mapped - p.hist[0].0 > HIST_S {
            p.hist.pop_front();
        }
        Self::ack(sent, p, msg, q, t);
        (true, None)
    }

    /// Grappling-gun drag: while a hook is live, haul the victim toward the shooter.
    /// Bots get the same pull from bot_fire; this covers human victims.
    fn hook_pull_step(&mut self, t: f64) {
        let n = self.players.len();
        for j in 0..n {
            let hooked = self.players[j].1.hook_until > t;
            if !hooked {
                continue;
            }
            let Some((hx, hz)) = self.players[j].1.hook_pull else { continue };
            let (px, pz) = (self.players[j].1.x, self.players[j].1.z);
            let (dx, dz) = (hx - px, hz - pz);
            let dist = (dx * dx + dz * dz).sqrt().max(1e-6);
            let sp = GRAPPLE_PULL.min(dist * 4.0);
            let p = &mut self.players[j].1;
            p.vx = dx / dist * sp;
            p.vz = dz / dist * sp;
            if dist < 1.2 {
                p.hook_pull = None;
            }
        }
    }

    fn pickups(&mut self, i: usize, t: f64) {
        let n_map = self.map().pickups.len();
        let uid = self.players[i].0.clone();
        // Two bodies to judge against: the referee's own copy, and the position the
        // client last claimed (kept even when the frame was refused or dropped by the
        // token bucket / this-life gate). A rejected "pos" leaves the judge's copy
        // frozen; the player is still standing on the totem, so the claim is what makes
        // the take land when they expect it.
        //
        // A LIVE walk rewrites the claim every pos frame, so a claim younger than
        // CLAIM_FRESH is the walk itself and is believed at the body the player named --
        // NOT leashed to our copy, which freezes on a speed-cap / canopy / token-bucket
        // refusal and used to throw the claim away mid-walk ("I went through it and it
        // was left behind"). A stalled claim is only believed near our own copy: that is
        // the anti-teleport, and a single far-off "pos" is also rejected unless it names
        // a body inside the arena.
        let (jx, jy, jz) = (self.players[i].1.x, self.players[i].1.y, self.players[i].1.z);
        let b = self.map().bounds();
        // how far the judge's copy has been left behind (0 while it is keeping up).
        // A rubber-band walk may sit more than one correction's step from our copy
        // (a speed-cap refusal, a canopy glide, a token-bucket drop) — that gap is
        // exactly what used to throw the claim away mid-walk. The leash grows with
        // how long we have been refusing to accept the move, so it still cannot
        // cross the map in one frame.
        let lag = (t - self.players[i].1.at).max(0.0);
        let reach = (CLAIM_R + SPEED_CARRY * lag).min(CLAIM_R_MAX);
        let claimed = self.players[i].1.claim.filter(|(cx, cy, cz, ct)| {
            let age = t - *ct;
            if !(0.0..CLAIM_R_SECS).contains(&age) {
                return false;
            }
            if *cx < b[0] - 1.0 || *cx > b[3] + 1.0 || *cy < b[1] - 2.0 || *cy > b[4] + 8.0
                || *cz < b[2] - 1.0 || *cz > b[5] + 1.0 {
                return false;
            }
            if age <= CLAIM_FRESH {
                return true;
            }
            (*cx - jx).hypot(*cz - jz) <= reach && (*cy - jy).abs() <= reach
        });
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
                // Horizontal only: drops land at y=0 and a ledge/crate taker is still standing
                // over it. The old hard 1.2 m Y window rejected every ground drop from a raised
                // deck (the dockyard centre tops out near y=3.5), so a totem sat there forever
                // while you walked through it. Mirror the client: only test Y when the pack
                // itself is elevated.
                // Square reach, same as the solo client's local take: a walk-through
                // takes every slot in the cluster on the same pass. A circular
                // hypot(1.1) is strictly smaller, so a diagonal sweep left the corner
                // totems standing and they flushed later in bulk.
                let near = |x: f64, y: f64, z: f64| -> bool {
                    if (x - at[0]).abs() > PICK_R || (z - at[2]).abs() > PICK_R {
                        return false;
                    }
                    if at[1] > 1.5 && (y - at[1]).abs() > 2.2 {
                        return false;
                    }
                    true
                };
                if !near(jx, jy, jz) && !claimed.map(|(cx, cy, cz, _)| near(cx, cy, cz)).unwrap_or(false) {
                    continue;
                }
                // Cursed Drop: the power is the same, but the taker pays 15 hp up front
                if self.cursed.get(j).copied().unwrap_or(false) {
                    let p = &mut self.players[i].1;
                    p.hp = (p.hp - 15).max(1);
                    p.hp_acc = 0.0;
                    p.breath_acc = 0.0;
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
                    self.mark(&uid);
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
                self.mark(&uid);
                continue;
            }
            let at = self.spots[j];
            let is_health = self.map().pickups[j].health;
            // same dual-body test as the drop slots above — square reach, like solo
            let near = |x: f64, y: f64, z: f64| -> bool {
                if (x - at[0]).abs() > PICK_R || (z - at[2]).abs() > PICK_R {
                    return false;
                }
                if at[1] > 1.5 && (y - at[1]).abs() > 2.2 {
                    return false;
                }
                true
            };
            if !near(jx, jy, jz) && !claimed.map(|(cx, cy, cz, _)| near(cx, cy, cz)).unwrap_or(false) {
                continue;
            }
            let p = &mut self.players[i].1;
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
            self.mark(&uid);
        }
    }

    /// Pick up a totem slot (kind != ""): the effect is server-judged in MP, exactly what
    /// the solo client's totemApply() does locally. A walk-over is ALWAYS taken — if the
    /// effect has no eligible target it fires at nobody, the same as the solo client's
    /// "nothing eligible" take. Refusing used to leave the totem under the player's feet
    /// ("I walked through it and it was not taken"), then ship it later in a bulk.
    fn take_totem(&mut self, i: usize, kind: &str, t: f64) -> bool {
        let me = self.players[i].0.clone();
        let my_team = self.players[i].1.team;
        match kind {
            "mole" => {
                // the first living enemy bot in slot order turns on its own side
                let vid = self.players.iter()
                    .filter(|(u, v)| u.as_str() != me && v.is_bot() && !v.dead && !v.gone && v.team != my_team)
                    .min_by_key(|(_, v)| v.slot).map(|(u, _)| u.to_string());
                if let Some(vid) = vid {
                    self.player_mut(&vid).unwrap().charm_until = t + CHARM;
                    self.mark(&vid);
                }
                true
            }
            "freeze" => {
                // the nearest living enemy bot holds still
                let (x, z) = (self.players[i].1.x, self.players[i].1.z);
                let vid = self.players.iter()
                    .filter(|(u, v)| u.as_str() != me && v.is_bot() && !v.dead && !v.gone && v.team != my_team)
                    .min_by(|a, b| ((a.1.x - x).hypot(a.1.z - z)).total_cmp(&(b.1.x - x).hypot(b.1.z - z)))
                    .map(|(u, _)| u.to_string());
                if let Some(vid) = vid {
                    self.player_mut(&vid).unwrap().freeze_until = t + FREEZE;
                    self.mark(&vid);
                }
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
                // A standing portal ring a couple of metres in front of the taker, and
                // its twin somewhere random on the map. Walk into either, come out the
                // other. Rockets hop the same pair.
                self.world_k += 1;
                let (x, _y, z, yaw) = {
                    let p = &self.players[i].1;
                    (p.x, p.y, p.z, p.r as f64 / 100.0)
                };
                let vx = yaw.to_radians().sin();
                let vz = -(yaw.to_radians().cos());
                let id = self.world_k;
                // near ring: just ahead, nudged off any box
                let (mut nx, mut nz) = (x + vx * RIFT_FRONT, z + vz * RIFT_FRONT);
                for n in 0..20 {
                    if overlaps(self.map(), nx, 0.1, nz, 0.2).is_none() {
                        break;
                    }
                    nx = x + vx * (RIFT_FRONT + n as f64 * 0.3);
                    nz = z + vz * (RIFT_FRONT + n as f64 * 0.3);
                }
                // far ring: the same hashed open-spot scatter drops use
                self.totem_k += 1;
                let seed = (self.totem_k as u32)
                    .wrapping_mul(0x9E37_79B9)
                    .wrapping_add(0x51FE_2703)
                    .wrapping_add(self.k as u32);
                let (fx, fz) = self.open_spot(seed);
                // far-ring facing = atan2(nx-fx, -(nz-fz)) — the same derivation as
                // FS.riftPair in games/strike.js, so the hop's step-out lands where the
                // client's prediction put it and pos() does not rubber-band.
                let fyaw = (nx - fx).atan2(-(nz - fz)).to_degrees().rem_euclid(360.0);
                self.portals.push(Portal {
                    id, x: nx, y: 0.0, z: nz, yaw,
                    pair: id + 1, owner: me.clone(), until: t + RIFT,
                });
                self.portals.push(Portal {
                    id: id + 1, x: fx, y: 0.0, z: fz, yaw: fyaw,
                    pair: id, owner: me.clone(), until: t + RIFT,
                });
                {
                    let a = &self.portals[self.portals.len() - 2];
                    let b = &self.portals[self.portals.len() - 1];
                    self.pending.push(("rift", json!({"id": id, "x": cm(a.x), "z": cm(a.z),
                                                      "x2": cm(b.x), "z2": cm(b.z),
                                                      "ya": cm(a.yaw),
                                                      "yb": cm(b.yaw)})));
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
                    p.where_at(t - REWIND_S)
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
                    self.mark_idx(j);
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
                // Hunter's Mark: every enemy is painted for your side — and their
                // cloaks drop, so "they can't hide" is literally true (twin of JS).
                let team = self.players[i].1.team;
                for (_, v) in self.players.iter_mut() {
                    if v.team != team && !v.dead && !v.gone {
                        v.hunter_until = t + HUNTER;
                        v.hunter_by = me.clone();
                        v.cloak_until = 0.0;
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
                    return true;   // walked over on cooldown: taken, no swap
                }
                let (x, z) = (self.players[i].1.x, self.players[i].1.z);
                let team = self.players[i].1.team;
                let vid = self.players.iter()
                    .filter(|(u, v)| u.as_str() != me && !v.dead && !v.gone && v.team != team)
                    .min_by(|a, b| ((a.1.x - x).hypot(a.1.z - z)).total_cmp(&(b.1.x - x).hypot(b.1.z - z)))
                    .map(|(u, _)| u.to_string());
                let Some(vid) = vid else { return true };   // no enemy to swap with: taken, nothing happens
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
                // the taker's HUD clock (FLAG_RALLY) — the beacon itself drives the
                // shared reload / heal for anyone on the side near it
                self.players[i].1.rally_until = t + RALLY;
                self.world_k += 1;
                self.beacons.push(Beacon {
                    id: self.world_k, x, y, z, kind: "rally",
                    team, owner: me.clone(), until: t + RALLY,
                });
                self.mark_all();
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
                let Some(vid) = vid else { return true };   // nobody to link with: taken, no link
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
                // King: reserve ammo up (royalty is well-supplied) and faster reloads
                // via reload_mult (twin of the JS totemApply)
                {
                    let p = &mut self.players[i].1;
                    for wi in 0..WEAPONS.len() {
                        let cap = WEAPONS[wi].reserve * 2;
                        p.res[wi] = (p.res[wi] + WEAPONS[wi].reserve).min(cap);
                    }
                }
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
            "bighead" => {
                // Every skull in the arena doubles — both teams, bots included, the
                // taker too. It's a world joke, not a power-up: it does not pop on death.
                self.big_head_until = t + BIG_HEAD;
                self.mark_all();
                true
            }
            "disco" => {
                // Everyone EXCEPT the taker dances and cannot shoot. Per-player clocks
                // (the taker is the one who stays armed); a dancer's own death pops it.
                // The Warden dances too when it is up: same window, attacks held.
                let mut any = false;
                for (u, v) in self.players.iter_mut() {
                    if u.as_str() != me && !v.dead && !v.gone {
                        v.dance_until = t + DISCO;
                        any = true;
                    }
                }
                if let Some(wd) = self.warden.as_mut() {
                    wd.dance_until = t + DISCO;
                    // the boss grooves instead of attacking: drop any in-flight telegraph
                    wd.slab_arm = 0.0;
                    wd.slab_land = 0.0;
                    wd.laser_warn = 0.0;
                    wd.laser_on = 0.0;
                    wd.grip_warn = 0.0;
                    wd.grip_on = 0.0;
                    any = true;
                }
                if any {
                    self.mark_all();
                }
                true   // walked over: taken. With nobody up it simply does nothing.
            }
            // ---- Wave F: the joke world totems (arena-wide, both sides suffer) ----
            "banana" => {
                // Banana peels scatter across the arena. Deterministic scatter from the
                // world counter — never Math.random() (a user must see the same peels
                // every time). Twin: the JS totemApply "banana" arm.
                self.world_k += 1;
                let seed = (self.world_k as u32)
                    .wrapping_mul(2_654_435_761)
                    .wrapping_add((t * 1000.0) as u32);
                let (mx, mz) = {
                    let p = &self.players[i].1;
                    (p.x, p.z)
                };
                for bi in 0..BANANA_N {
                    let salt = (bi as u32).wrapping_mul(7).wrapping_add(1);
                    let ang = (seed.wrapping_add(bi as u32).wrapping_mul(0x9e37_79b9)) as f64 * 0.001;
                    let rad = 3.0 + hash_match(seed, salt) * BANANA_R;
                    let bx = mx + ang.cos() * rad;
                    let bz = mz + ang.sin() * rad;
                    self.bananas.push(BananaPeel {
                        id: self.world_k * 100 + bi as i64,
                        x: bx,
                        z: bz,
                    });
                }
                self.mark_world();
                true
            }
            "lava" => {
                // Floor Is Lava: random floor patches turn dangerous. Stand too long →
                // launched up + burned. Higher ground saves you.
                self.world_k += 1;
                let seed = (self.world_k as u32)
                    .wrapping_mul(2_654_435_761)
                    .wrapping_add((t * 1000.0) as u32);
                let (mx, mz) = {
                    let p = &self.players[i].1;
                    (p.x, p.z)
                };
                for li in 0..LAVA_ZONES {
                    let salt = (li as u32).wrapping_mul(11).wrapping_add(3);
                    let ang = (seed.wrapping_add(li as u32).wrapping_mul(0x9e37_79b9)) as f64 * 0.001;
                    let rad = 4.0 + hash_match(seed, salt) * LAVA_R;
                    let lx = mx + ang.cos() * rad;
                    let lz = mz + ang.sin() * rad;
                    self.lava_zones.push(LavaZone {
                        id: self.world_k * 100 + li as i64,
                        x: lx,
                        z: lz,
                        r: LAVA_R,
                    });
                }
                self.mark_world();
                true
            }
            "goose" => {
                // An angry goose spawns and chases the nearest player at top speed.
                // It headbutts anyone it catches. LISTS: a second goose stacks — it
                // never replaces the first.
                self.world_k += 1;
                let (mx, mz) = {
                    let p = &self.players[i].1;
                    (p.x, p.z)
                };
                self.geese.push(Goose {
                    id: self.world_k,
                    x: mx + 4.0,
                    z: mz + 4.0,
                    until: t + GOOSE,
                });
                self.mark_world();
                true
            }
            "reverse" => {
                // Everyone's WASD is reversed for the window. Arena-wide, both teams,
                // bots too. Twin: V.reverseUntil in games/strike.js.
                self.reverse_until = t + REVERSE;
                self.mark_all();
                true
            }
            "blackhole" => {
                // A tiny black hole opens at the centre of the arena and sucks
                // everything in until it disappears. Twin: totemApply in games/strike.js.
                // LISTS: a second hole stacks — it never replaces the first.
                self.world_k += 1;
                self.blackholes.push(BlackHole {
                    id: self.world_k,
                    x: 0.0,
                    z: 0.0,
                    until: t + BLACKHOLE,
                });
                self.mark_world();
                true
            }
            "roulette" => {
                // Every 2 s everyone's weapon randomly switches. Arena-wide, both teams.
                self.roulette_until = t + ROULETTE;
                self.roulette_next = t + ROULETTE_GAP;
                self.mark_all();
                true
            }
            // ---- Wave G: the trap-and-gadget set ----
            "turret" => {
                self.world_k += 1;
                let (team, owner) = {
                    let p = &self.players[i].1;
                    (p.team, self.players[i].0.clone())
                };
                // a ring around the TAKER (twin of the Trapmaster mines), not a
                // scatter across the map — these are meant to cover you, so they
                // have to be in the fight you are already in. never rand: the
                // angle comes from the world counter.
                let (ox, oz) = {
                    let p = &self.players[i].1;
                    (p.x, p.z)
                };
                for ti in 0..TURRET_N {
                    let ang = (self.world_k as f64) * 2.399 + (ti as f64) * 2.1;
                    let (mut tx, mut tz) = (ox + ang.cos() * 1.8, oz + ang.sin() * 1.8);
                    for n in 0..16 {
                        if overlaps(self.map(), tx, 0.1, tz, 0.2).is_none() {
                            break;
                        }
                        tx = ox + ang.cos() * (1.8 + n as f64 * 0.3);
                        tz = oz + ang.sin() * (1.8 + n as f64 * 0.3);
                    }
                    self.turrets.push(Turret {
                        id: self.world_k * 100 + ti as i64,
                        x: tx,
                        y: 0.0,
                        z: tz,
                        team,
                        owner: owner.clone(),
                        hp: TURRET_HP,
                        until: t + TURRET,
                        next: t,
                        yaw: 0.0,
                    });
                }
                self.turret_until = t + TURRET;
                self.mark_world();
                true
            }
            "barrel" => {
                // Instant: three big barrels crash down from the sky. Shoot one and it
                // goes up in a 10× launcher blast, and the blast chains the next barrel.
                self.world_k += 1;
                let seed = (self.world_k as u32)
                    .wrapping_mul(2_654_435_761)
                    .wrapping_add((t * 1000.0) as u32);
                for br in 0..BARREL_N {
                    let (bx, bz) = self.dis_spot(seed.wrapping_add(br as u32).wrapping_mul(0x9e37_79b9), br as u32);
                    self.barrels.push(Barrel {
                        id: self.world_k * 100 + br as i64,
                        x: bx,
                        y: BARREL_FALL,
                        z: bz,
                        hp: BARREL_HP,
                        landed: false,
                        vy: 0.0,
                    });
                }
                self.mark_world();
                true
            }
            "laser" => {
                self.world_k += 1;
                let seed = (self.world_k as u32)
                    .wrapping_mul(2_654_435_761)
                    .wrapping_add((t * 1000.0) as u32);
                for lg in 0..LASER_N {
                    let (ax, az) = self.dis_spot(seed.wrapping_add(lg as u32).wrapping_mul(0x9e37_79b9), lg as u32);
                    let ang = hash_match(seed, (lg as u32).wrapping_mul(13).wrapping_add(5)) * std::f64::consts::PI * 2.0;
                    let half = LASER_LEN * 0.5;
                    self.lasers.push(Laser {
                        id: self.world_k * 100 + lg as i64,
                        ax: ax - ang.cos() * half,
                        az: az - ang.sin() * half,
                        bx: ax + ang.cos() * half,
                        bz: az + ang.sin() * half,
                        until: t + LASER,
                    });
                }
                self.laser_until = t + LASER;
                self.mark_world();
                true
            }
            "jumppad" => {
                self.world_k += 1;
                let seed = (self.world_k as u32)
                    .wrapping_mul(2_654_435_761)
                    .wrapping_add((t * 1000.0) as u32);
                for pi in 0..PAD_N {
                    let (px, pz) = self.dis_spot(seed.wrapping_add(pi as u32).wrapping_mul(0x9e37_79b9), pi as u32);
                    self.pads.push(JumpPad {
                        id: self.world_k * 100 + pi as i64,
                        x: px,
                        z: pz,
                        until: t + JUMPPAD,
                    });
                }
                self.pad_until = t + JUMPPAD;
                self.mark_world();
                true
            }
            "lottery" => {
                // Instant: one living ENEMY is chosen by the world counter (never
                // Math.random). They either heal to full or drop dead on the spot.
                self.world_k += 1;
                let seed = (self.world_k as u32)
                    .wrapping_mul(2_654_435_761)
                    .wrapping_add((t * 1000.0) as u32);
                let taker_team = self.players[i].1.team;
                let pool: Vec<usize> = (0..self.players.len())
                    .filter(|&j| {
                        j != i
                            && !self.players[j].1.dead
                            && self.players[j].1.team != taker_team
                    })
                    .collect();
                if pool.is_empty() {
                    return true;   // nobody home: the ticket voids itself — still taken
                }
                let pick = pool[(((seed >> 8) as usize) % pool.len() + pool.len()) % pool.len()];
                if hash_match(seed, 3) < 0.5 {
                    self.players[pick].1.hp = LOTTERY_HEAL;
                } else {
                    self.env_kill(pick, "lottery", t);
                }
                self.mark_idx(pick);
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
    /// Several disasters can run at once — a new one NEVER stops an old one. The
    /// oldest is shed only past DIS_MAX. Returns false only for an unknown kind.
    pub fn start_disaster(&mut self, kind: &'static str, t: f64) -> bool {
        if !DISASTERS.contains(&kind) {
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
        self.disasters.push(Disaster {
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
        while self.disasters.len() > DIS_MAX {
            self.disasters.remove(0);
        }
        self.pending.push((
            "disaster",
            json!({
                "kind": kind,
                "id": kind,
                "warn": (DIS_WARN * 1000.0) as i64,
                "dur": (hold * 1000.0) as i64,
            }),
        ));
        self.mark_world();
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
        // the summons STAY: untaken dragons now roam and bite anyone; ridden ones
        // stay under their rider (breath only). Twin: wardenDeath in strike.js.
        self.mark_world();
    }

    /// Full match teardown only: every rider is set down beside its mount
    /// (never killed) and the roster clears so a
    /// leftover body cannot sit in the post-match firing lane. The Warden falling
    /// does NOT call this. Twin: dragonDismiss in games/strike.js.
    fn dragon_dismiss(&mut self) {
        let mut hops: Vec<(String, f64, f64, f64)> = Vec::new(); // uid, nx, nz, ny
        for d in &self.dragons {
            let rider = d.rider.clone();
            if rider.is_empty() {
                continue;
            }
            let (nx, nz) = (d.x + d.yaw.sin() * 2.2, d.z + d.yaw.cos() * 2.2);
            let ny = ground_y(self.map(), nx, nz);
            hops.push((rider, nx, nz, ny));
        }
        for (uid, nx, nz, ny) in hops {
            if let Some(j) = self.players.iter().position(|(u, _)| u == &uid) {
                let p = &mut self.players[j].1;
                p.dragon_rider = false;
                p.x = nx;
                p.z = nz;
                p.y = ny;
                p.vx = 0.0;
                p.vz = 0.0;
            }
        }
        self.dragons.clear();
    }

    /// A body that comes back is never still in a saddle. `place()` already clears the
    /// player's own `dragon_rider` flag; this frees the dragon's `rider` slot so the
    /// mount can be claimed again — a ghost seat left `dragon_rider` set on the next
    /// life and the void rescue (gated on `!dragon_rider`) never ran.
    fn dragon_release(&mut self, uid: &str) {
        for d in self.dragons.iter_mut() {
            if d.rider == uid {
                d.rider.clear();
            }
        }
    }

    // ---- The Warden's dragons ----
    // Twin: the dragon module in games/strike.js. Every entry here mirrors a
    // named helper over there so the two judges cannot drift apart silently.

    /// The dragon's body as three world AABBs (wings / body / neck).
    /// Twin: dragonBoxes in games/strike.js.
    fn dragon_boxes(d: &Dragon) -> [Box3; 3] {
        let (c, s) = (d.yaw.cos(), d.yaw.sin());
        let bb = |hw: f64, hd: f64, y0: f64, y1: f64| -> Box3 {
            let ex = (hw * c).abs() + (hd * s).abs();
            let ez = (hw * s).abs() + (hd * c).abs();
            [d.x - ex, d.y + y0, d.z - ez, d.x + ex, d.y + y1, d.z + ez]
        };
        [bb(4.4, 5.2, 1.6, 3.0), bb(3.6, 1.4, 0.2, 3.4), bb(1.6, 1.1, 1.0, 3.2)]
    }

    /// Nearest dragon along a shot ray, or None. Twin: dragonScanHit in strike.js.
    fn dragon_scan_hit(&self, o: [f64; 3], d: [f64; 3], reach: f64) -> Option<(usize, f64)> {
        let mut best: Option<(usize, f64)> = None;
        let mut best_t = reach;
        for (i, dr) in self.dragons.iter().enumerate() {
            if dr.hp <= 0 {
                continue;
            }
            for b in Self::dragon_boxes(dr).iter() {
                if let Some(t) = ray_box(o, d, b) {
                    if t < best_t {
                        best_t = t;
                        best = Some((i, t));
                    }
                }
            }
        }
        best
    }

    /// Damage a dragon. No disaster multiplier — a disaster deals a dragon the SAME
    /// damage it deals a fighter. `cause` names what fell it so the feed can say
    /// ("meteorshower", "gunfire", …). Twin: dragonHurt in strike.js.
    fn dragon_hurt(&mut self, i: usize, dmg: i64, cause: &'static str, t: f64) {
        let dead = {
            let Some(dr) = self.dragons.get_mut(i) else { return };
            let dealt = dmg.max(0);
            dr.hp = (dr.hp - dealt).max(0);
            dr.hp <= 0
        };
        self.mark_world();
        if dead {
            self.dragon_kill(i, cause, t);
        }
    }

    /// A dragon dies: the rider (if any) dies with it. The kill feed names what
    /// brought the mount down ("dragon:<cause>"), so the rider's death reads
    /// "Your dragon · <cause>". Twin: dragonKill in strike.js.
    fn dragon_kill(&mut self, i: usize, cause: &'static str, t: f64) {
        let Some(dr) = self.dragons.get_mut(i) else { return };
        dr.hp = 0;
        let rider = std::mem::take(&mut dr.rider);
        if rider.is_empty() {
            return;
        }
        if let Some(j) = self.players.iter().position(|(u, _)| u == &rider) {
            self.players[j].1.dragon_rider = false;
            if !self.players[j].1.dead && !self.players[j].1.gone {
                // "dragon:<cause>" so the feed reads "Your dragon · <cause> · You"
                self.env_kill(j, &format!("dragon:{cause}"), t);
            }
        }
    }

    /// Press G: mount the nearest idle dragon, or dismount the one you are on.
    /// Twin: dragonTryMount in strike.js. Called from the "mount" op.
    pub fn mount(&mut self, uid: &str, _msg: &Value, _t: f64) -> bool {
        if self.phase != Phase::Round {
            return false;
        }
        let Some(i) = self.players.iter().position(|(u, _)| u == uid) else {
            return false;
        };
        if self.players[i].1.dead || self.players[i].1.gone || self.players[i].1.is_bot() {
            return false;
        }
        // already riding one? step off
        if let Some(k) = self.dragons.iter().position(|d| d.rider == uid) {
            let (dx, dz, yaw) = {
                let d = &mut self.dragons[k];
                let (dx, dz, yaw) = (d.x, d.z, d.yaw);
                d.rider.clear();
                (dx, dz, yaw)
            };
            let (nx, nz) = (dx + yaw.sin() * 2.2, dz + yaw.cos() * 2.2);
            let ny = ground_y(self.map(), nx, nz);
            let p = &mut self.players[i].1;
            p.dragon_rider = false;
            p.x = nx;
            p.z = nz;
            p.y = ny;
            p.vx = 0.0;
            p.vz = 0.0;
            self.mark(uid);
            return true;
        }
        // else hop on the closest idle one in reach
        let (px, pz) = (self.players[i].1.x, self.players[i].1.z);
        let mut best: Option<usize> = None;
        let mut best_d = DRAGON_MOUNT_R;
        for (k, d) in self.dragons.iter().enumerate() {
            if d.hp <= 0 || !d.rider.is_empty() {
                continue;
            }
            let dd = (d.x - px).hypot(d.z - pz);
            if dd < best_d {
                best_d = dd;
                best = Some(k);
            }
        }
        if let Some(k) = best {
            self.dragons[k].rider = uid.to_string();
            self.dragons[k].breath_left = DRAGON_BREATH_SECS;
            self.dragons[k].recharge_at = 0.0;
            self.dragons[k].spray_until = 0.0;
            self.players[i].1.dragon_rider = true;
            self.mark(uid);
            return true;
        }
        false
    }

    /// Hold the trigger on a mount: the breath sprays until the tank runs dry.
    /// Twin: dragonBreathe in games/strike.js (sent as the "breathe" op while held).
    pub fn breathe(&mut self, uid: &str, _msg: &Value, t: f64) -> bool {
        if self.phase != Phase::Round {
            return false;
        }
        for d in self.dragons.iter_mut() {
            if d.rider != uid || d.hp <= 0 {
                continue;
            }
            if d.recharge_at > 0.0 && t < d.recharge_at {
                return false;
            }
            if d.breath_left <= 0.0 {
                if d.recharge_at <= t {
                    d.recharge_at = t + DRAGON_INHALE_SECS;
                    d.spray_until = 0.0;
                }
                return false;
            }
            // a short self-renewing window — dragon_tick drains the tank while it runs
            d.spray_until = t + 0.3;
            self.mark_world();
            return true;
        }
        false
    }

    /// One tick of every dragon: the rider flies it, an untaken one roams and
    /// bites, and the breath cone deals damage while it is spraying.
    /// Twin: dragonTick / dragonRoam / dragonBreathStep in strike.js.
    fn dragon_tick(&mut self, dt: f64, t: f64) {
        if self.dragons.is_empty() {
            return;
        }
        // mounted flight + breath
        for i in 0..self.dragons.len() {
            let rider = self.dragons[i].rider.clone();
            if rider.is_empty() {
                continue;
            }
            // refill after the inhale
            if self.dragons[i].recharge_at > 0.0 && t >= self.dragons[i].recharge_at {
                self.dragons[i].breath_left = DRAGON_BREATH_SECS;
                self.dragons[i].recharge_at = 0.0;
            }
            // the rider's body rides the dragon
            if let Some(j) = self.players.iter().position(|(u, _)| u == &rider) {
                let is_bot = self.players[j].1.is_bot();
                let p = &mut self.players[j].1;
                if p.dead || p.gone {
                    self.dragons[i].rider.clear();
                    continue;
                }
                if is_bot {
                    // a bot has no client: seat it on the mount and leave the body there
                    p.x = self.dragons[i].x;
                    p.y = self.dragons[i].y + DRAGON_SEAT;
                    p.z = self.dragons[i].z;
                } else {
                    // the rider flies it: the client owns the saddle pose and sends it
                    // through "pos" (pos_inner relaxes the flight caps while `dragon_rider`
                    // is set), so the mount follows its rider instead of rubber-banding
                    // them back onto a frozen body.
                    self.dragons[i].x = p.x;
                    self.dragons[i].y = p.y - DRAGON_SEAT;
                    self.dragons[i].z = p.z;
                    // player look yaw is (sin, -cos); the pet build is +z forward (sin, cos)
                    self.dragons[i].yaw = std::f64::consts::PI - (p.r as f64 / 100.0).to_radians();
                }
            }
            // the breath: a widening cone from the head. No spray can hit anyone
            // while the boss is up — the fight is Warden-only.
            if self.dragons[i].spray_until > t && self.dragons[i].breath_left > 0.0 {
                self.dragons[i].breath_left = (self.dragons[i].breath_left - dt).max(0.0);
                if self.dragons[i].breath_left <= 0.0 {
                    self.dragons[i].recharge_at = t + DRAGON_INHALE_SECS;
                    self.dragons[i].spray_until = 0.0;
                }
                if self.warden.is_none() {
                    let (hx, _hy, hz, hyaw) = (
                        self.dragons[i].x + self.dragons[i].yaw.sin() * 3.2,
                        self.dragons[i].y + 1.6,
                        self.dragons[i].z + self.dragons[i].yaw.cos() * 3.2,
                        self.dragons[i].yaw,
                    );
                    let (fx, gz) = (hyaw.sin(), hyaw.cos());
                    let mut hits: Vec<usize> = Vec::new();
                    for (j, (_u, q)) in self.players.iter().enumerate() {
                        if q.dead || q.gone {
                            continue;
                        }
                        if !rider.is_empty() && self.players[j].0 == rider {
                            continue; // never burn your own saddle
                        }
                        let (dx, dz) = (q.x - hx, q.z - hz);
                        let along = dx * fx + dz * gz;
                        if !(0.0..=DRAGON_BREATH_LEN).contains(&along) {
                            continue;
                        }
                        let side = (dx * -gz + dz * fx).abs();
                        if side > DRAGON_BREATH_W * (0.35 + 0.65 * (along / DRAGON_BREATH_LEN)) {
                            continue;
                        }
                        hits.push(j);
                    }
                    for j in hits {
                        let dead_now = {
                            let p = &mut self.players[j].1;
                            if p.protect > t || p.shielded(t) {
                                continue;
                            }
                            // 30 dps across the tick: carry the fraction so 20 Hz ticks
                            // pay exactly 30/s instead of rounding 1.5 up to 2 (40 dps).
                            p.breath_acc += (DRAGON_BREATH_DPS as f64) * dt;
                            let dmg = p.breath_acc.floor() as i64;
                            if dmg <= 0 {
                                continue;
                            }
                            p.breath_acc -= dmg as f64;
                            p.hp = (p.hp - dmg).max(0);
                            p.hp <= 0
                        };
                        self.mark_idx(j);
                        if dead_now {
                            self.env_kill(j, "dragon-breath", t);
                        }
                    }
                }
            }
            // No out-of-bounds: the sky is open and the map edge is not a wall.
        }
        // untaken dragons roam the deck and bite anything that comes close
        for i in 0..self.dragons.len() {
            if self.dragons[i].hp <= 0 || !self.dragons[i].rider.is_empty() {
                continue;
            }
            let mut best: Option<usize> = None;
            let mut best_d = 22.0f64;
            // While the Warden lives a summons is a calm pet: patrol, never chase or bite.
            if self.warden.is_none() {
                for (j, (_u, q)) in self.players.iter().enumerate() {
                    if q.dead || q.gone {
                        continue;
                    }
                    if q.y > self.dragons[i].y + 2.2 {
                        continue;
                    }
                    let dd = (q.x - self.dragons[i].x).hypot(q.z - self.dragons[i].z);
                    if dd < best_d {
                        best_d = dd;
                        best = Some(j);
                    }
                }
            }
            if let Some(j) = best {
                let (tx, tz) = (self.players[j].1.x, self.players[j].1.z);
                let (dx, dz) = (tx - self.dragons[i].x, tz - self.dragons[i].z);
                let ln = dx.hypot(dz).max(1e-6);
                self.dragons[i].yaw = dx.atan2(dz);
                if ln > DRAGON_BITE_R * 0.85 {
                    self.dragons[i].x += dx / ln * DRAGON_ROAM_SPEED * dt;
                    self.dragons[i].z += dz / ln * DRAGON_ROAM_SPEED * dt;
                } else if t >= self.dragons[i].bite_at {
                    self.dragons[i].bite_at = t + DRAGON_BITE_CD;
                    let dead_now = {
                        let p = &mut self.players[j].1;
                        if p.protect > t || p.shielded(t) {
                            false
                        } else {
                            p.hp = (p.hp - DRAGON_BITE_DMG).max(0);
                            p.vx = dx / ln * 4.0;
                            p.vz = dz / ln * 4.0;
                            if let Some(bb) = p.bot.as_mut() {
                                bb.body.vx = dx / ln * 4.0;
                                bb.body.vz = dz / ln * 4.0;
                            }
                            p.hp <= 0
                        }
                    };
                    self.mark_idx(j);
                    if dead_now {
                        self.env_kill(j, "dragon", t);
                    }
                }
            } else {
                // idle wander: a slow deterministic patrol so it never freezes
                let w = hash_match((self.dragons[i].id as u32) ^ 0x9E37, ((t * 0.2) as i64) as u32)
                    * std::f64::consts::TAU;
                let y0 = self.dragons[i].yaw;
                let mut yd = (w - y0 + std::f64::consts::PI * 3.0) % (std::f64::consts::TAU)
                    - std::f64::consts::PI;
                yd *= 1.0_f64.min(dt * 1.2);
                self.dragons[i].yaw = y0 + yd;
                self.dragons[i].x += self.dragons[i].yaw.sin() * DRAGON_ROAM_SPEED * 0.45 * dt;
                self.dragons[i].z += self.dragons[i].yaw.cos() * DRAGON_ROAM_SPEED * 0.45 * dt;
            }
            // keep the body on whatever is under it
            let gy = ground_y(self.map(), self.dragons[i].x, self.dragons[i].z);
            self.dragons[i].y = gy;
        }
        // bots claim an idle dragon after DRAGON_BOT_MOUNT seconds — but only once
        // the boss is gone. While the Warden lives nobody claims a mount. Twin:
        // dragonTick's claim block in strike.js.
        if self.warden.is_some() {
            self.mark_world();
            return;
        }
        let bot_at = self.dragons.iter()
            .filter(|d| d.hp > 0 && d.rider.is_empty())
            .map(|d| d.id)
            .collect::<Vec<_>>();
        for did in bot_at {
            let Some(di) = self.dragons.iter().position(|d| d.id == did) else { continue };
            if t < self.dragons[di].idle_at + DRAGON_BOT_MOUNT {
                continue;
            }
            // nearest living bot on the ground
            let mut best: Option<usize> = None;
            let mut best_d = DRAGON_MOUNT_R;
            for (j, (_u, q)) in self.players.iter().enumerate() {
                if !q.is_bot() || q.dead || q.gone || q.dragon_rider {
                    continue;
                }
                let dd = (q.x - self.dragons[di].x).hypot(q.z - self.dragons[di].z);
                if dd < best_d {
                    best_d = dd;
                    best = Some(j);
                }
            }
            if let Some(j) = best {
                let uid = self.players[j].0.clone();
                self.dragons[di].rider = uid;
                self.dragons[di].breath_left = DRAGON_BREATH_SECS;
                self.players[j].1.dragon_rider = true;
                self.mark_idx(j);
            }
        }
        self.mark_world();
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
        let gy = warden_ground_y(self.map(), cx, cz); // stand on the FLOOR — the skirt is wider than the centre platform
        self.warden_frozen_ms = self.ms_left(t);
        self.warden = Some(Warden {
            hp: max,
            max,
            x: cx,
            z: cz,
            gy,
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
            dance_until: 0.0,
        });
        // the elemental roster lands with the boss — six drift-wyrms, Fire → Golden
        self.dragons.clear();
        let b = self.map().bounds();
        let cxr = (b[0] + b[3]) * 0.5;
        let czr = (b[2] + b[5]) * 0.5;
        let rx = (b[3] - b[0]) * 0.5 * 0.72;
        let rz = (b[5] - b[2]) * 0.5 * 0.72;
        for i in 0..WARDEN_DRAGON_N {
            let a = ((i as f64) / (WARDEN_DRAGON_N as f64)) * std::f64::consts::TAU
                - std::f64::consts::FRAC_PI_2;
            let x = cxr + a.cos() * rx;
            let z = czr + a.sin() * rz;
            let y = ground_y(self.map(), x, z);
            self.dragons.push(Dragon {
                id: i as i64,
                tier: i.min(WARDEN_DRAGON_TIERS.len().saturating_sub(1)),
                hp: DRAGON_HP,
                max: DRAGON_HP,
                x,
                y,
                z,
                yaw: 0.0,
                rider: String::new(),
                breath_left: DRAGON_BREATH_SECS,
                recharge_at: 0.0,
                spray_until: 0.0,
                bite_at: 0.0,
                idle_at: t,
            });
        }
        self.mark_world();
        // already grooving: if a Disco window is live when the boss rises, it joins it
        if let Some(wd) = self.warden.as_mut() {
            let mut left = 0.0f64;
            for (_, p) in self.players.iter() {
                if p.dance_until > t && p.dance_until > left {
                    left = p.dance_until;
                }
            }
            if left > t {
                wd.dance_until = left;
            }
        }
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
        self.mark_world();
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
        // --- Disco: the boss grooves and holds every attack for the window ---
        {
            let Some(wd) = self.warden.as_mut() else { return };
            if wd.dance_until > t {
                return;
            }
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
                        dis: "",
                    });
                }
                let mut victims: Vec<usize> = Vec::new();
                let mut blasts: Vec<(usize, f64, f64, f64)> = Vec::new(); // (j, x, z, dsl)
                for (j, (_, v)) in self.players.iter().enumerate() {
                    if v.dead || v.gone {
                        continue;
                    }
                    // the fist hits the DECK — a rider is up on a saddle, not a ground target
                    if v.dragon_rider {
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
                            dis: "",
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
        let beam = self.warden.as_ref().and_then(|wd| {
            if wd.laser_on > t && t >= wd.laser_warn {
                // ground laser: the eye looks down and the beam slants to the floor
                let eye = [wd.x, wd.gy + WARDEN_SEE_HEAD, wd.z];
                let dir = [wd.laser_yaw.cos(), 0.0, wd.laser_yaw.sin()];
                let run_k = map_laser_run(self.map(), wd.x, wd.z, wd.laser_yaw);
                Some((eye, dir, run_k))
            } else {
                None
            }
        });
        if let Some((eye, dir, run_k)) = beam {
            let mut victims: Vec<usize> = Vec::new();
            for (j, (_, v)) in self.players.iter().enumerate() {
                if v.dead || v.gone {
                    continue;
                }
                if self.disaster_immune(j, t) {
                    continue;
                }
                // a fighter up in a saddle is not a ground target: the mount
                // soaks the beam (its own half-life bite below), never the rider
                if v.dragon_rider {
                    continue;
                }
                let ppos = [v.x, v.y + 0.9, v.z];
                let px = ppos[0] - eye[0];
                let pz = ppos[2] - eye[2];
                let along = px * dir[0] + pz * dir[2];
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
            // The Warden cannot hurt a dragon at all. Disasters and gunfire are the
            // only ways to bring one down mid-fight — the beam goes right past them.
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
                let (gx, gz, gy) = (wd.x, wd.z, wd.gy);
                let mut acts: Vec<(usize, bool, f64, f64)> = Vec::new();
                for (j, (_, v)) in self.players.iter().enumerate() {
                    if v.dead || v.gone || self.disaster_immune(j, t) {
                        continue;
                    }
                    // the open hand pulls ground fighters — a saddle flies on
                    if v.dragon_rider {
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
                    if !los(self.map(), [gx, gy + WARDEN_SEE_CHEST, gz], [v.x, v.y + 0.9, v.z]) {
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
        // The newest joke set (Big Head … Death Lottery) is FEATURED: half the rolls come
        // from it, so a player actually meets them inside a match instead of waiting
        // on a 1-in-45 roll. Twin: totemSpawn's FEAT bias in games/strike.js.
        let feat: [&'static str; 13] = [
            "bighead", "disco", "banana", "lava", "goose", "reverse", "blackhole", "roulette",
            "turret", "barrel", "laser", "jumppad", "lottery",
        ];
        let kind: &'static str = if hash_match(seed, 5) < 0.5 {
            feat[((hash_match(seed, 6) * feat.len() as f64) as usize) % feat.len()]
        } else {
            kinds[(hash_match(seed, 1) * kinds.len() as f64) as usize % kinds.len()]
        };
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

    /// Land at most DRONE_TOTEMS personal totems ON a wreck, not on a fresh open spot.
    /// The three fan out from (x, z) on a hashed angle/radius so they don't stack on one
    /// pixel. They get their own one-shot slots appended PAST the drop rings (the Warden
    /// loot rule), never the recycled totem ring: a later drone appends more, it never
    /// overwrites an unclaimed wreck's totems — they stay until someone takes them.
    /// Twin: droneTotemDrop in games/strike.js.
    fn drone_totem_drop(&mut self, x: f64, z: f64, seed: u32, t: f64) {
        if self.warden.is_some() {
            return;
        }
        self.ensure_drop_slots();
        let kinds: Vec<&'static str> = TOTEM_KINDS
            .iter()
            .copied()
            .filter(|k| !DISASTERS.contains(k))
            .collect();
        for i in 0..DRONE_TOTEMS {
            let tok = (seed
                ^ (((i as u32) + 1).wrapping_mul(0x9E37_79B9))
                ^ (((t * 1000.0) as i64 & 0xFFFF) as u32))
                .wrapping_add(0);
            let kind = kinds[(tok as usize) % kinds.len()];
            let mut ang = hash_match(tok, 71) * std::f64::consts::TAU;
            let mut rad = 1.4 + hash_match(tok, 73) * 1.8;
            let (mut tx, mut tz) = (x + ang.cos() * rad, z + ang.sin() * rad);
            for k in 0..16 {
                if overlaps(self.map(), tx, 0.1, tz, 0.0).is_none() {
                    break;
                }
                let s2 = tok.wrapping_add(((k as u32) + 1).wrapping_mul(2654435761));
                ang = hash_match(s2, 71) * std::f64::consts::TAU;
                rad = 1.4 + hash_match(s2, 73) * 1.8;
                tx = x + ang.cos() * rad;
                tz = z + ang.sin() * rad;
            }
            let idx = self.kinds.len();
            self.items.push(None);
            self.kinds.push(kind);
            self.spots.push([tx, 0.0, tz]);
            self.cursed.push(false);
            self.pending.push((
                "totem",
                json!({"i": idx, "kind": kind, "x": cm(tx), "z": cm(tz), "tag": ""}),
            ));
        }
    }

    /// Detach every swinger hooked to this drone index and drop them to the ground, as
    /// if the drone were never there (the swing window dies with the hull).
    /// Twin: droneDetach in games/strike.js.
    fn drone_detach(&mut self, di: usize, t: f64) {
        for (_, p) in self.players.iter_mut() {
            if p.hook_drone != Some(di) {
                continue;
            }
            p.swing_until = 0.0;
            p.swing_y = 0.0;
            p.hook_until = 0.0;
            p.hook_pull = None;
            p.hook_drone = None;
            if !p.dead {
                // fall as if there had never been a drone: the air clock restarts here,
                // so the ground under them (or VOID_SECS) is what catches them.
                p.air_at = t;
                p.void_at = 0.0;
            }
        }
    }

    /// A shot-down match drone: the hull goes dark for DRONE_DOWN_SECS, everyone swinging
    /// on it falls to the ground, three non-disaster totems land where it fell, and the
    /// arena takes a random disaster (added to whatever is already running).
    /// Twin: droneShootDown in games/strike.js. Returns the wreck spot when it went down.
    pub fn drone_down(&mut self, di: usize, pos: [f64; 3], t: f64) -> Option<(f64, f64)> {
        if di >= self.drones.len() {
            return None;
        }
        if self.drone_down.len() <= di {
            self.drone_down.resize(self.drones.len(), 0.0);
        }
        if self.drone_down[di] > t {
            return None;
        }
        self.drone_down[di] = t + DRONE_DOWN_SECS;
        let (x, z) = (pos[0], pos[2]);
        self.drone_detach(di, t);
        let seed = (((t * 1000.0) as u32) ^ ((di as u32).wrapping_mul(0x9E37_79B9))) | 1;
        self.drone_totem_drop(x, z, seed, t);
        let dkind = DISASTERS[dis_kind(seed, 19, DISASTERS.len())];
        self.start_disaster(dkind, t);
        self.booms.push(json!([cm(x), cm(0.3), cm(z)]));
        Some((x, z))
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
        // (fire_inner still needs &self for the world, so the body comes out for the call —
        // same swap fire() has always used. pos() is the hot path and no longer does this.)
        let mut p = std::mem::replace(&mut self.players[i].1, Player::new(Value::Null, 0, 0, t, 0));
        let res = self.fire_inner(&mut p, msg, t);
        self.players[i].1 = p;
        let Some((w, o, d, reach, protect_ended)) = res.0 else { return (None, res.1) };
        if protect_ended {
            self.mark(uid);
        }
        let hs = self.head_scale(t);
        // the grappling gun: zero damage. Hook a match drone (swing) or a foe (drag +
        // trigger lock). Never damages the Warden — a live Warden just means no foe hook.
        if w == GRAPPLE_W {
            let routes = self.drones.clone();
            let downed = self.drone_down.clone();
            let reach = ray_map(self.map(), o, d, WEAPONS[GRAPPLE_W].range);
            if let Some((_hd, di)) = drone_hit(o, d, &routes, t - self.go_at, reach, &downed, t) {
                let c = drone_at(&routes[di], t - self.go_at);
                {
                    let p = &mut self.players[i].1;
                    // ease up to the drone on the client (wings-style WING_RISE).
                    // Never snap y here — a teleport is what the player sees as rubber-band.
                    p.swing_y = c[1];
                    p.vx = d[0] * GRAPPLE_SWING;
                    p.vz = d[2] * GRAPPLE_SWING;
                    p.swing_until = t + GRAPPLE_TIME;
                    p.hook_drone = Some(di);
                    p.air_at = t;
                    p.void_at = 0.0;
                }
                let shot = json!([self.players[i].1.slot, w, cm(o[0]), cm(o[1]), cm(o[2]), -1, 0]);
                self.shots.push(shot.clone());
                self.mark(uid);
                return (Some(shot), None);
            }
            if self.warden.is_none() {
                let team = self.players[i].1.team;
                let mut victim: Option<usize> = None;
                let mut victim_h = f64::INFINITY;
                for (j, (vuid, v)) in self.players.iter().enumerate() {
                    if *vuid == uid || v.dead || v.gone || v.team == team {
                        continue;
                    }
                    if v.protect > t {
                        continue;
                    }
                    if let Some(h) = ray_player(o, d, v.x, v.y, v.z, reach, hs) {
                        if h.0 < victim_h {
                            victim_h = h.0;
                            victim = Some(j);
                        }
                    }
                }
                if let Some(j) = victim {
                    let (shx, shz) = (self.players[i].1.x, self.players[i].1.z);
                    let vuid2 = self.players[j].0.clone();
                    {
                        let v = &mut self.players[j].1;
                        v.hook_until = t + HOOK_LOCK;
                        v.hook_pull = Some((shx, shz));
                    }
                    self.mark(&vuid2);
                    let shot = json!([self.players[i].1.slot, w, cm(o[0]), cm(o[1]), cm(o[2]),
                                      self.players[j].1.slot, 0]);
                    self.shots.push(shot.clone());
                    self.mark(uid);
                    return (Some(shot), None);
                }
            }
            let shot = json!([self.players[i].1.slot, w, cm(o[0]), cm(o[1]), cm(o[2]), -1, 0]);
            self.shots.push(shot.clone());
            self.mark(uid);
            return (Some(shot), None);
        }
        // the launcher: don't judge a ray — spawn a rocket; tick() flies it and resolves the blast
        if w == LAUNCH_W {
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
        // Match flight drones: a bullet knocks one out of the sky. The hull blocks the
        // shot — nobody behind it is hit. Twin of the JS fire() match-drone ray test.
        if !self.drones.is_empty() {
            let downed = self.drone_down.clone();
            let routes = self.drones.clone();
            let mut best: Option<(f64, usize, [f64; 3])> = None;
            for (di, tg) in routes.iter().enumerate() {
                if downed.get(di).copied().unwrap_or(0.0) > t {
                    continue;
                }
                let c = drone_at(tg, t - self.go_at);
                let b = [
                    c[0] - DRONE_R, c[1] - DRONE_R * 0.7, c[2] - DRONE_R,
                    c[0] + DRONE_R, c[1] + DRONE_R * 0.7, c[2] + DRONE_R,
                ];
                if let Some(h) = ray_box(o, d, &b) {
                    if h < reach && best.map(|(bh, _, _)| h < bh).unwrap_or(true) {
                        best = Some((h, di, c));
                    }
                }
            }
            if let Some((end, di, c)) = best {
                self.drone_down(di, c, t);
                let shot = json!([self.players[i].1.slot, w, cm(o[0] + d[0] * end),
                                  cm(o[1] + d[1] * end), cm(o[2] + d[2] * end), -1, 0]);
                self.shots.push(shot.clone());
                self.mark(uid);
                return (Some(shot), None);
            }
        }
        // Wave G destructibles: a turret or barrel in the way eats the bullet (and only it)
        if let Some((end, kind, idx)) = self.waveg_ray(o, d, reach) {
            let dmg = WEAPONS[w].damage;
            let shooter = self.players[i].0.clone();
            self.waveg_hit(kind, idx, dmg, &shooter, t);
            let shot = json!([self.players[i].1.slot, w, cm(o[0] + d[0] * end),
                              cm(o[1] + d[1] * end), cm(o[2] + d[2] * end), -1, 0]);
            self.shots.push(shot.clone());
            self.mark(uid);
            return (Some(shot), None);
        }
        let team = self.players[i].1.team;
        let t_view = res.2;
        // The nearer body takes the bullet: a summon standing in front of the boss
        // eats it, one behind the boss does not. Gunfire always hurts a dragon, and
        // the Warden is always a valid target while it lives.
        let dh = self.dragon_scan_hit(o, d, reach);
        let wt = self
            .warden
            .as_ref()
            .and_then(|wd| wd.hit_index(o, d, reach))
            .map(|(_, th)| th);
        if let Some((di, th)) = dh {
            if wt.map(|wth| th < wth).unwrap_or(true) {
                let dmg = WEAPONS[w].damage;
                self.dragon_hurt(di, dmg, "gunfire", t);
                let shooter_slot = self.players[i].1.slot;
                let shot = json!([shooter_slot, w, cm(o[0] + d[0] * th), cm(o[1] + d[1] * th),
                                  cm(o[2] + d[2] * th), -1, 0]);
                self.shots.push(shot.clone());
                self.mark(uid);
                return (Some(shot), None);
            }
        }
        // The Warden: while it lives, fighters cannot hurt each other — only the
        // Warden takes damage. Shots still draw a tracer; disasters still hurt.
        if self.warden.is_some() {
            let w_end = wt.unwrap_or(reach);
            let end = w_end;
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
                self.mark_world();
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
            if let Some((th, head)) = ray_player(o, d, vx, vy, vz, reach, hs) {
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
            for (k, (ku, kv)) in self.players.iter().enumerate() {
                if k == j || k == i || ku == uid || kv.dead || kv.gone
                    || kv.team == team || kv.magnet_until <= t
                {
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
                    if let Some((th, head)) = ray_player(o, d, vx, vy, vz, reach, hs) {
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
                let (sx, sy, sz) = {
                    let sh = &self.players[i].1;
                    (sh.x, sh.y + 0.9, sh.z)
                };
                let shield = v.protect > t || v.shielded(t)
                    || (self.in_bubble(v.x, v.y + 0.9, v.z, v.team, t)
                        && !self.in_bubble(sx, sy, sz, team, t));
                (u.to_string(), v.slot, v.hp, shield, v.fate_until > t)
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
                        let (pp_x, pp_y, pp_z, pp_team, pp_dead, pp_shield) = {
                            let pp = &self.players[pi].1;
                            (pp.x, pp.y + 0.9, pp.z, pp.team, pp.dead, pp.shielded(t))
                        };
                        let bubble_safe = self.in_bubble(pp_x, pp_y, pp_z, pp_team, t)
                            && !self.in_bubble(o[0], o[1], o[2], team, t);
                        let pp = &mut self.players[pi].1;
                        if !pp_dead && !pp_shield && !bubble_safe {
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
        if p.dead || p.gone || p.is_bot() || p.hook_until > t || p.dance_until > t || p.dragon_rider
            || !bucket(&mut p.fb, FIRE_RATE, FIRE_BURST, t)
        {
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
        Self::ack(&self.sent, p, msg, Some(q), t);
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
            let scatter = self.disaster_scatter(t);
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
    // ---- Wave G: destructible world objects (turrets / barrels) ----
    /// Nearest of [turret, barrel] along the ray: (dist, kind, index) or None.
    /// Twin: wavegRay in games/strike.js. `kind` is 0 = turret, 1 = barrel.
    fn waveg_ray(&self, o: [f64; 3], d: [f64; 3], maxd: f64) -> Option<(f64, u8, usize)> {
        let mut best: Option<(f64, u8, usize)> = None;
        for (i, tu) in self.turrets.iter().enumerate() {
            if tu.hp <= 0 {
                continue;
            }
            if let Some(h) = ray_box(o, d, &turret_box(tu.x, tu.y + ground_y(self.map(), tu.x, tu.z), tu.z)) {
                if h < maxd && best.map(|(bd, _, _)| h < bd).unwrap_or(true) {
                    best = Some((h, 0, i));
                }
            }
        }
        for (i, bo) in self.barrels.iter().enumerate() {
            if bo.hp <= 0 {
                continue;
            }
            if let Some(h) = ray_box(o, d, &barrel_box(bo.x, bo.y + ground_y(self.map(), bo.x, bo.z), bo.z)) {
                if h < maxd && best.map(|(bd, _, _)| h < bd).unwrap_or(true) {
                    best = Some((h, 1, i));
                }
            }
        }
        best
    }

    /// 10× a launcher: the direct hit is BARREL_DIRECT, the falloff curve is the
    /// launcher's own scaled out to BARREL_R. Chains the next barrel inside the radius.
    fn barrel_blast(&mut self, idx: usize, shooter: &str, t: f64) {
        if idx >= self.barrels.len() || self.barrels[idx].hp <= 0 {
            return;
        }
        let (x, y, z) = {
            let b = &self.barrels[idx];
            (b.x, b.y + ground_y(self.map(), b.x, b.z) + 0.5, b.z)
        };
        self.barrels[idx].hp = 0;
        self.booms.push(json!([cm(x), cm(y), cm(z)]));
        // pass 1 (read-only): who is in range
        let hits: Vec<(usize, i64)> = self
            .players
            .iter()
            .enumerate()
            .filter(|(_, (_, v))| !v.dead && !v.gone)
            .map(|(j, (_, v))| {
                let dist = dist3([v.x, v.y + 0.9, v.z], [x, y, z]);
                let dmg = if dist < DIRECT_R {
                    BARREL_DIRECT
                } else if dist < BARREL_R {
                    (BARREL_DMG as f64 - (BARREL_DMG - BARREL_MIN) as f64 * (dist / BARREL_R)).round() as i64
                } else {
                    0
                };
                let dmg = if v.protect > t || v.shielded(t) { 0 } else { dmg };
                (j, dmg)
            })
            .filter(|(_, dmg)| *dmg > 0)
            .collect();
        for (j, dmg) in hits {
            let (vid, killed) = {
                let (vid, v) = &mut self.players[j];
                v.hp = (v.hp - dmg).max(0);
                v.hp_original = v.hp + dmg;
                (vid.clone(), v.hp <= 0)
            };
            self.mark(&vid);
            if killed {
                if let Some(si) = self.players.iter().position(|(u, _)| u.as_str() == shooter) {
                    self.kill(si, j, LAUNCH_W, false, t);
                } else {
                    self.env_kill(j, "barrel", t);
                }
            }
        }
        // chain: a barrel inside the blast goes off too (with the same credit)
        let chain: Vec<usize> = self
            .barrels
            .iter()
            .enumerate()
            .filter(|(i, b)| *i != idx && b.hp > 0 && (b.x - x).hypot(b.z - z) <= BARREL_R)
            .map(|(i, _)| i)
            .collect();
        for ci in chain {
            self.barrel_blast(ci, shooter, t);
        }
    }

    /// A bullet (or blast) finds a turret / barrel. `kind` is 0 = turret, 1 = barrel.
    fn waveg_hit(&mut self, kind: u8, idx: usize, dmg: i64, shooter: &str, t: f64) {
        if kind == 1 {
            if idx >= self.barrels.len() {
                return;
            }
            let was = self.barrels[idx].hp;
            if was <= 0 {
                return;
            }
            if was - dmg <= 0 {
                // barrel_blast zeroes hp itself; zeroing here first would make its
                // "already spent" guard swallow the detonation.
                self.barrel_blast(idx, shooter, t);
            } else {
                self.barrels[idx].hp = was - dmg;
                self.mark_world();
            }
            return;
        }
        if idx >= self.turrets.len() {
            return;
        }
        self.turrets[idx].hp = (self.turrets[idx].hp - dmg).max(0);
        if self.turrets[idx].hp <= 0 {
            self.turrets[idx].hp = 0;
        }
        self.mark_world();
    }

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
        // The Warden: the blast still rings off its body, and still bites a dragon —
        // gunfire always hurts a summon. Fighters and bots stay safe while it lives.
        if self.warden.is_some() {
            self.warden_blast(at, t);
        }
        // the blast also bites the beasts (twin: detonate in games/strike.js)
        {
            let mut hits: Vec<(usize, i64)> = Vec::new();
            for (i, dr) in self.dragons.iter().enumerate() {
                if dr.hp <= 0 {
                    continue;
                }
                let dist = dist3([dr.x, dr.y + 1.6, dr.z], at);
                let dmg = blast_damage(dist, dist < DIRECT_R);
                if dmg > 0 {
                    hits.push((i, dmg));
                }
            }
            for (i, dmg) in hits {
                self.dragon_hurt(i, dmg, "gunfire", t);
            }
        }
        // while The Warden lives, the blast only bruised the boss and a summon —
        // fighters and bots take nothing from it (twin: detonate in games/strike.js)
        if self.warden.is_some() {
            return;
        }
        // Wave G destructibles: the blast bruises turrets and detonates barrels in radius
        {
            let t_hits: Vec<(usize, i64)> = self
                .turrets
                .iter()
                .enumerate()
                .filter(|(_, tu)| tu.hp > 0)
                .map(|(i, tu)| {
                    let dist = dist3([tu.x, tu.y + ground_y(self.map(), tu.x, tu.z) + 0.6, tu.z], at);
                    (i, blast_damage(dist, dist < DIRECT_R))
                })
                .filter(|(_, dmg)| *dmg > 0)
                .collect();
            for (i, dmg) in t_hits {
                self.waveg_hit(0, i, dmg, &shooter, t);
            }
            let b_chain: Vec<usize> = self
                .barrels
                .iter()
                .enumerate()
                .filter(|(_, b)| b.hp > 0 && (b.x - at[0]).hypot(b.z - at[2]) < BARREL_R)
                .map(|(i, _)| i)
                .collect();
            for bi in b_chain {
                self.barrel_blast(bi, &shooter, t);
            }
        }
        // pass 1 (read-only): who is in range, and how hard it hits them
        let (sh_x, sh_y, sh_z, sh_team) = self.players.iter()
            .find(|(u, _)| *u == shooter)
            .map(|(_, p)| (p.x, p.y + 0.9, p.z, p.team))
            .unwrap_or((at[0], at[1] + 0.9, at[2], 0));
        let hits: Vec<(usize, i64)> = self.players.iter().enumerate()
            .filter(|(_, (_, v))| !v.dead && !v.gone)
            .map(|(j, (u, v))| {
                let dist = dist3([v.x, v.y + 0.9, v.z], at);
                // honest-but-fair, mirrors the client: the shooter's own blast grades by
                // proximity (75 falloff), never the 120 "direct" — a rocket launched from the
                // eye detonates ~0.6 m above the shooter's torso, which would otherwise be
                // an instant self-kill the moment anyone fires near a wall or their own feet.
                let direct = *u != shooter && dist < DIRECT_R;
                let bubble_safe = self.in_bubble(v.x, v.y + 0.9, v.z, v.team, t)
                    && !self.in_bubble(sh_x, sh_y, sh_z, sh_team, t);
                let dmg = if v.protect > t || v.shielded(t) || bubble_safe { 0 } else { blast_damage(dist, direct) };
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
                    self.kill(si, j, LAUNCH_W, false, t);
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
                    let vlife = v.life;
                    self.pending.push(("kill", json!({"k": null, "v": vid, "w": LAUNCH_W, "hs": 0,
                        "kills": 0, "deaths": deaths, "team": team, "scores": self.scores, "e": vlife})));
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
                self.shots.push(json!([p.slot, LAUNCH_W, cm(at[0]), cm(at[1]), cm(at[2]),
                                       vslot, 0, applied]));
            }
        }
    }

    fn kill(&mut self, i: usize, j: usize, w: usize, head: bool, t: f64) {
        // Already down: a second killing blow must not book another death or
        // rewind the respawn clock (a laser/barrel chain would otherwise park
        // the body in limbo past the first death's respawn). Twin: endBotLife's
        // one-shot latch in games/strike.js.
        if self.players[j].1.dead {
            return;
        }
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
        let (vid, deaths, vlife) = {
            let (vid, v) = &mut self.players[j];
            v.dead = true;
            v.deaths += 1;
            v.respawn_at = t + RESPAWN;
            v.reload = None;
            (vid.clone(), v.deaths, v.life)
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
        // "e" is the victim's life at the killing blow. A kill can share a tick with
        // the respawn ("spawn" carries the new life) — the client drops a kill whose
        // e does not match V.life, so a late feed row can never re-latch death on a
        // body that just came back.
        let ev = json!({"k": uid, "v": vid, "w": w, "hs": if head { 1 } else { 0 }, "kills": p.kills,
                        "deaths": deaths, "team": team, "scores": scores, "e": vlife});
        self.pending.push(("kill", ev));
    }

    /// The map itself killed someone (an Arena Disaster). No shooter, no team point —
    /// the feed names the disaster instead of a weapon. Second Wind / Phoenix still fire.
    fn env_kill(&mut self, j: usize, dis: &str, t: f64) {
        // Already down: one death, one respawn clock. A laser grid or a barrel
        // chain re-contacting the body must not restart the countdown (twin of
        // the endBotLife latch in games/strike.js).
        if self.players[j].1.dead {
            return;
        }
        if self.players[j].1.cheat_death(t) {
            let vuid = self.players[j].0.clone();
            let slot = self.players[j].1.slot;
            let hp = self.players[j].1.hp;
            self.mark(&vuid);
            self.pending.push(("cheat", json!({"i": slot, "hp": hp})));
            return;
        }
        let (vid, deaths, vlife) = {
            let (vid, v) = &mut self.players[j];
            v.dead = true;
            v.deaths += 1;
            v.respawn_at = t + RESPAWN;
            v.reload = None;
            v.wings_until = 0.0;
            v.wings_fly = 0.0;
            v.leap_until = 0.0;
            v.speed_until = 0.0;
            (vid.clone(), v.deaths, v.life)
        };
        let scores = self.scores;
        self.pending.push((
            "kill",
            json!({"k": null, "v": vid, "w": -1, "hs": 0, "kills": 0,
                   "deaths": deaths, "team": 0, "scores": scores,
                   "dis": dis, "how": dis, "e": vlife}),
        ));
        self.mark(&vid);
    }

    /// True when a disaster cannot touch this player: the Shield totem (or the drop
    /// shield / Pocket Universe, which the same predicate covers) or spawn cover.
    fn disaster_immune(&self, i: usize, t: f64) -> bool {
        let p = &self.players[i].1;
        p.dead || p.gone || p.shielded(t) || p.protect > t
    }

    /// Is ANY disaster of `kind` past its warn and inside its hold right now?
    /// Twin: disKindLive in games/strike.js.
    fn disaster_live(&self, kind: &str, t: f64) -> bool {
        self.disasters.iter().any(|d| d.kind == kind && t >= d.warn_at && t < d.until)
    }

    /// The highest aim-scatter any live disaster is applying (degrees of yaw).
    /// Twin: disAimScatter in games/strike.js.
    fn disaster_scatter(&self, t: f64) -> f64 {
        let mut s = 0.0;
        for d in &self.disasters {
            if t < d.warn_at || d.until <= t {
                continue;
            }
            let v = match d.kind {
                "hurricane" => DD_WIND_SCATTER,
                "sandstorm" => DD_SAND_SCATTER,
                "emp" => DD_EMP_SCATTER,
                _ => 0.0,
            };
            if v > s {
                s = v;
            }
        }
        s
    }

    /// Bot aim error multiplier under a disaster (EMP ×3, hurricane ×2 — wild aim) and
    /// while a bolt / flash has blinded them (×4 — spray). Several can run at once, so
    /// the WORST live modifier wins. Twin: the aimX line in games/strike.js bot turn/aim.
    fn bot_aim_mult(&self, t: f64, blind: bool) -> f64 {
        let mut base = 1.0f64;
        for d in &self.disasters {
            if t < d.warn_at || d.until <= t {
                continue;
            }
            let v = match d.kind {
                "emp" => 3.0,
                "hurricane" => 2.0,
                _ => 1.0,
            };
            if v > base {
                base = v;
            }
        }
        if blind {
            base * 4.0
        } else {
            base
        }
    }

    /// Hurricane vortex: a caught body is taken up, spun around the column and held
    /// there with no way to walk out. Twin: inWindCatch in games/strike.js.
    /// `dt` is the frame step; `spin` / `lift` are DD_WIND_SPIN / DD_WIND_LIFT.
    /// Returns true while the grip is holding.
    fn wind_catch(p: &mut Player, t: f64, cx: f64, cz: f64, dt: f64, spin: f64, lift: f64) -> bool {
        if t >= p.vortex_until {
            return false;
        }
        // the column walks — pull a caught body back onto the orbit it is already riding
        let want = DD_WIND_CATCH_R;
        let dd = (p.x - cx).hypot(p.z - cz);
        let dd = if dd > 0.05 { dd } else { 1.0 };
        let mut rad = dd + (want - dd) * (1.4 * dt).min(1.0);
        rad = rad.clamp(0.35, DD_WIND_R);
        p.vortex_rad = rad;
        p.vortex_phase += spin * dt;
        p.x = cx + p.vortex_phase.cos() * rad;
        p.z = cz + p.vortex_phase.sin() * rad;
        p.y = (p.y + lift * dt).min(DD_WIND_TOP);
        true
    }

    /// Every live Arena Disaster's worth of world upkeep. Called from tick() every
    /// frame. Several can run at once — each entry is stepped in turn and a new one
    /// NEVER stops an old one. Twin: the worldTick disaster block in games/strike.js.
    fn disaster_tick(&mut self, t: f64) {
        // the disaster clock: independent of the totems and of the small Arena Events.
        // It no longer refuses to fire while one is live — concurrency is the point.
        if self.disaster_at.map(|at| t >= at).unwrap_or(false) {
            self.disaster_at = Some(t + DIS_GAP);
            self.world_k += 1;
            let kind = DISASTERS[dis_kind(self.world_k as u32, 11, DISASTERS.len())];
            self.start_disaster(kind, t);
        }
        // expire finished disasters one at a time (never wipe the list)
        let mut gone: Vec<&'static str> = Vec::new();
        self.disasters.retain(|d| {
            if d.until <= t {
                gone.push(d.kind);
                false
            } else {
                true
            }
        });
        for kind in gone {
            // drop only THIS disaster's pending marks — a concurrent one keeps its own
            self.warns.retain(|w| w.dis != kind);
            self.pending.push(("disaster", json!({"kind": "clear", "id": kind})));
            self.mark_world();
        }
        if self.disasters.is_empty() {
            return;
        }
        // step every live disaster in turn (clone-out / write-back: Disaster is small)
        let n = self.disasters.len();
        for i in 0..n {
            let mut d = self.disasters[i].clone();
            // warning window: the banner is up, nothing hurts yet
            if t < d.warn_at {
                self.disasters[i] = d;
                continue;
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
                        dis: d.kind,
                    });
                }
            }
            "hurricane" => {
                // area system: a wind column walks the map on a hashed diagonal and
                // takes anyone it reaches — lifted off the deck and spun around the
                // core with no way to walk out. Twin: inWindCatch in games/strike.js.
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
                    let held = self.players[j].1.vortex_until > t;
                    let dx = px - wx;
                    let dz = pz - wz;
                    let dd = dx.hypot(dz);
                    if !held && dd > DD_WIND_R {
                        continue;
                    }
                    {
                        let p = &mut self.players[j].1;
                        if !held {
                            // start the orbit where the body already stands — no teleport
                            p.vortex_phase = (p.z - wz).atan2(p.x - wx);
                            p.vortex_rad = (dx * dx + dz * dz).sqrt().max(0.35);
                        }
                        // the grip is held a beat after the body leaves the column, so
                        // the spin does not staccato as the column walks
                        if p.vortex_until < t + DD_WIND_CATCH {
                            p.vortex_until = t + DD_WIND_CATCH;
                        }
                        p.vortex_x = wx;
                        p.vortex_z = wz;
                        Self::wind_catch(p, t, wx, wz, 0.05, DD_WIND_SPIN, DD_WIND_LIFT);
                        p.x = p.x.clamp(-200.0, 200.0);
                        p.z = p.z.clamp(-200.0, 200.0);
                        p.hist.push_back((t, p.x, p.y, p.z));
                        // loose footing in the column (help text: "Wild aim")
                        if p.slow_until < t + DD_WIND_SLOW {
                            p.slow_until = t + DD_WIND_SLOW;
                        }
                    }
                    self.mark_idx(j);
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
                        self.mark_idx(j);
                        if dead_now {
                            self.env_kill(j, d.kind, t);
                        }
                    }
                    // the wind also chips the dragons — same rate as a fighter
                    let n = self.dragons.len();
                    for i in 0..n {
                        self.dragon_hurt(i, DD_WIND_DMG, d.kind, t);
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
                    self.mark_idx(j);
                    if dead_now {
                        self.env_kill(j, d.kind, t);
                    }
                }
                // the ring bites the dragons too (once each, same rate as a fighter)
                let n = self.dragons.len();
                for i in 0..n {
                    let key = format!("drg{}", self.dragons[i].id);
                    if d.hit.iter().any(|h| h == &key) {
                        continue;
                    }
                    let (dx, dz) = (self.dragons[i].x - ox, self.dragons[i].z - oz);
                    let dd = dx.hypot(dz);
                    if (dd - r).abs() > 1.6 {
                        continue;
                    }
                    d.hit.push(key);
                    self.dragon_hurt(i, DD_SHOCK_DMG, d.kind, t);
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
                            self.mark_idx(j);
                            if dead_now {
                                self.env_kill(j, d.kind, t);
                            }
                        }
                        // the green gas chips the dragons too — same rate as a fighter
                        let n = self.dragons.len();
                        for i in 0..n {
                            self.dragon_hurt(i, DD_TOXIC_CHIP_DMG, d.kind, t);
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
                                self.mark_idx(j);
                                if dead_now {
                                    self.env_kill(j, d.kind, t);
                                }
                            }
                            // the clouds bite the dragons too
                            let n = self.dragons.len();
                            for i in 0..n {
                                let dd = (self.dragons[i].x - zx).hypot(self.dragons[i].z - zz);
                                if dd > DD_TOXIC_R {
                                    continue;
                                }
                                self.dragon_hurt(i, DD_TOXIC_DMG, d.kind, t);
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
                            self.mark_idx(j);
                            if dead_now {
                                self.env_kill(j, d.kind, t);
                            }
                        }
                        // the pit pulls the dragons in too
                        let n = self.dragons.len();
                        for i in 0..n {
                            let dd = (self.dragons[i].x - zx).hypot(self.dragons[i].z - zz);
                            if dd < DD_SINK_R {
                                self.dragon_hurt(i, DD_SINK_DMG, d.kind, t);
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
                    self.mark_idx(j);
                    if dead_now {
                        self.env_kill(j, d.kind, t);
                    }
                }
                // the same chip bites the dragons — same rate as a fighter
                let n = self.dragons.len();
                for i in 0..n {
                    self.dragon_hurt(i, chip, d.kind, t);
                }
            }
            _ => {}
        }
            self.disasters[i] = d;
        }
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
                let dis = if w.dis.is_empty() { "meteorshower" } else { w.dis };
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
                self.mark_idx(j);
                if dead_now {
                    self.env_kill(j, dis, t);
                }
            }
            // A disaster bite on a dragon is the SAME damage it deals a fighter
            // (twin: the mark loop in games/strike.js). A Warden slam mark carries
            // no `dis` — it is a boss attack, and the Warden never hurts a dragon,
            // so an empty-cause mark never reaches the roster.
            if w.dis.is_empty() {
                continue;
            }
            let cause: &'static str = w.dis;
            let nd = self.dragons.len();
            for di in 0..nd {
                let dd = (self.dragons[di].x - w.x).hypot(self.dragons[di].z - w.z);
                if dd > w.r {
                    continue;
                }
                if w.overhead
                    && has_roof(self.map(), self.dragons[di].x, self.dragons[di].y + 1.8, self.dragons[di].z)
                {
                    continue;
                }
                self.dragon_hurt(di, mark_damage(dd, w.r, w.dmg), cause, t);
            }
        }
    }

    pub fn reload(&mut self, uid: &str, msg: &Value, t: f64) -> bool {
        let phase = self.phase;
        // Absolute Zero: fingers are numb, every reload crawls. Read the flag BEFORE
        // player_mut() so the immutable borrow of self.disaster is done with first.
        let zmult = if self.disaster_live("absolutezero", t) {
            1.5
        } else {
            1.0
        };
        // the mutable borrow ends at the block; reload_mult needs a read-only &self
        let (w, q, px, pz, pteam) = {
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
            (w, q, p.x, p.z, p.team)
        };
        let rmult = self.reload_mult(pteam, px, pz, t);
        let Some(p) = self.player_mut(uid) else { return false };
        p.reload = Some((w, q, q + (WEAPONS[w].reload * zmult * rmult * 100.0).round() as i64));
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
        // the Disco totem: a dancing bot holds still and holds its fire too
        if self.players[i].1.dance_until > t {
            return;
        }
        // a sandstorm halves how far a bot can see (the dust is up) — the small arena
        // event and the arena-wide disaster both count
        let bot_range = if self.event.as_ref().map(|e| e.kind == "storm" && e.until > t).unwrap_or(false)
            || self.disaster_live("sandstorm", t)
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
                let see_y = warden_see(self.map(), [x, y + EYE, z], wx, wz, i, core_open, wd.gy);
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
                let aim = warden_aim(wx, wz, i, core_open, wd.gy);
                b.lost_x = aim.0;
                b.lost_z = aim.2;
                b.lost_y = see_y.unwrap_or(wd.gy + WARDEN_SEE_ARM);
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
            let (ax, ty, az) = warden_aim(wx, wz, i, core_open, wd.gy);
            let ty = warden_see(self.map(), [x, y + EYE, z], wx, wz, i, core_open, wd.gy).unwrap_or(ty);
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
        // Banana Panic: a slipped bot can't steer — the slide holds at BANANA_SLIDE and
        // the whole body spins at BANANA_SPIN until the window ends. Twin: the JS
        // slipMe / slipB holds in update() and botsStep().
        // A hurricane grip is the same kind of lock: no wish reaches the feet.
        let slipped_now = self.players[i].1.slip_until > t;
        let vortexed_now = self.players[i].1.vortex_until > t;
        if slipped_now || vortexed_now {
            wx = 0.0;
            wz = 0.0;
        }
        // Reverse Controls totem: a bot's wish is reversed too (the window is arena-wide)
        if self.reverse_until > t {
            wx = -wx;
            wz = -wz;
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
            let (svx, svz) = (p.slip_vx, p.slip_vz);
            let b = p.bot.as_mut().unwrap();
            b.body.x = p.x;
            b.body.y = p.y;
            b.body.z = p.z;
            // v4: a parachute-dropping bot doesn't run physics — it floats the same canopy
            // descent a human client gets, then hands control back to step() on landing
            let dropping = p.drop && (t - p.drop_t) < DROP_TIME + DROP_LAND_GRACE;
            if dropping {
                // the deck under the canopy, not a body-overlap probe: a bot at
                // DROP_HEIGHT does not overlap the floor, so top_under would return
                // None and the whole descent would sink below the map (the human
                // client's "through the floor" bug). A genuine gap falls to 0 and
                // lands — bots have no void clock to save them.
                let floor = deck_under(m, b.body.x, b.body.z).unwrap_or(0.0);
                b.body.y = (b.body.y - DROP_SINK * dt).max(floor);
                if b.body.y <= floor {
                    p.drop = false;
                    p.drop_t = 0.0;
                    p.protect = t + PROTECT;
                }
            } else if vortexed_now {
                // a hurricane grip owns the body — disaster_tick already flew the orbit,
                // so no step() and no gravity here (twin: the JS swirling branch).
                b.body.vx = 0.0;
                b.body.vz = 0.0;
                if p.slow_until < t + DD_WIND_SLOW {
                    p.slow_until = t + DD_WIND_SLOW;
                }
                aim_y = (aim_y + DD_WIND_SPIN.to_degrees() * dt).rem_euclid(360.0);
                b.aim_y = aim_y;
            } else {
                if p.drop {
                    p.drop = false;
                    p.drop_t = 0.0;
                    p.protect = t + PROTECT;
                }
                step(m, &mut b.body, wx, wz, false, dt);
                if slipped_now {
                    // the slide holds against whatever friction the step applied
                    b.body.vx = svx;
                    b.body.vz = svz;
                    // …and the body spins (aim_y is what writes p.r below)
                    aim_y = (aim_y + BANANA_SPIN.to_degrees() * dt).rem_euclid(360.0);
                    b.aim_y = aim_y;
                }
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
            while p.hist.len() > 2 && t - p.hist[0].0 > HIST_S {
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
                            (d, warden_see(self.map(), [x, y + EYE, z], wd.x, wd.z, i, core_open, wd.gy).is_some())
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
            let (px, pz, pteam) = {
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
                    (p.x, p.z, p.team)
                } else {
                    (0.0, 0.0, 0)
                }
            };
            // only start a new reload when the block above left one pending
            let needs = {
                let p = &self.players[i].1;
                p.mag[p.w] <= 0 && p.reload.is_none() && p.res[p.w] > 0
            };
            if needs {
                let zmult = if self.disaster_live("absolutezero", t) {
                    1.5
                } else {
                    1.0
                };
                let rmult = self.reload_mult(pteam, px, pz, t);
                let p = &mut self.players[i].1;
                let w = p.w;
                p.reload = Some((w, (t * 100.0) as i64,
                                 ((t + WEAPONS[w].reload * zmult * rmult) * 100.0).round() as i64));
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
        // the Disco totem: a dancing bot cannot shoot (the Paralyser's freeze gate is
        // up in bot_step; this one also stops the trigger mid-window)
        if self.players[i].1.dance_until > t {
            return None;
        }
        // the guns are stowed on a saddle — the breath is the only attack
        if self.players[i].1.dragon_rider {
            return None;
        }
        let hs = self.head_scale(t);
        let w = self.players[i].1.w;
        let b = self.players[i].1.bot.as_ref()?;
        // bot_rate is the host-picked MP skill stretching (or tightening) a bot's own gap
        // between shots beyond the weapon's interval — plain carry-over from the DIFFS table
        if t < b.fire_at + WEAPONS[w].interval * self.bot_rate - 0.01 {
            return None;
        }
        let (aim_y, aim_p) = (b.aim_y, b.aim_p);
        // a bot with the launcher fires rockets like a player would, one at a time
        if w == LAUNCH_W {
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
        // hooked by a grappling gun: the trigger is locked (and the body is dragged)
        if self.players[i].1.hook_until > t {
            if let Some((hx, hz)) = self.players[i].1.hook_pull {
                let (px, pz) = (self.players[i].1.x, self.players[i].1.z);
                let (dx, dz) = (hx - px, hz - pz);
                let dist = (dx * dx + dz * dz).sqrt().max(1e-6);
                let sp = GRAPPLE_PULL.min(dist * 4.0);
                let p = &mut self.players[i].1;
                p.vx = dx / dist * sp;
                p.vz = dz / dist * sp;
                if dist < 1.2 {
                    p.hook_pull = None;
                }
            }
            return None;
        }
        if w == GRAPPLE_W {
            return None;
        }
        let scatter = self.disaster_scatter(t);
        let p = &mut self.players[i].1;
        if p.mag[w] <= 0 || p.reload.is_some() {
            return None;
        }
        let o = [p.x, p.y + EYE, p.z];
        p.n += 1;
        let (dy, dp) = spread_of(p.n, w);
        let d = {
            dir_of(aim_y + dy + scatter, (aim_p + dp + scatter * 0.6).clamp(-89.0, 89.0))
        };
        if p.protect > t {
            p.protect = t;
        }
        let team = p.team;
        let reach = ray_map(self.map(), o, d, WEAPONS[w].range);
        // While The Warden lives a bot's bullet is for the boss alone — it will not
        // spend a shot on a summon, even one sitting on the line of fire. You can
        // still shoot a dragon yourself; the bots just have a bigger target.
        if self.warden.is_some() {
            let w_end = self
                .warden
                .as_ref()
                .and_then(|wd| wd.hit_index(o, d, reach))
                .map(|(_, th)| th)
                .unwrap_or(reach);
            let end = w_end;
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
                self.mark_world();
            }
            let shot = Value::Array(shot);
            self.shots.push(shot.clone());
            self.players[i].1.bot.as_mut().unwrap().fire_at = t;
            self.players[i].1.mag[w] -= 1;
            return Some(shot);
        }
        // No boss up: a summon in the way eats the bullet (gunfire always hurts a dragon).
        if let Some((di, th)) = self.dragon_scan_hit(o, d, reach) {
            let dmg = WEAPONS[w].damage;
            self.dragon_hurt(di, dmg, "gunfire", t);
            let shooter_slot = self.players[i].1.slot;
            let shot = json!([shooter_slot, w, cm(o[0] + d[0] * th), cm(o[1] + d[1] * th),
                              cm(o[2] + d[2] * th), -1, 0]);
            self.shots.push(shot.clone());
            self.players[i].1.bot.as_mut().unwrap().fire_at = t;
            self.players[i].1.mag[w] -= 1;
            return Some(shot);
        }
        // Wave G destructibles: a turret or barrel in the way eats the bullet (and only it)
        if let Some((th, kind, idx)) = self.waveg_ray(o, d, reach) {
            let dmg = WEAPONS[w].damage;
            let shooter = self.players[i].0.clone();
            self.waveg_hit(kind, idx, dmg, &shooter, t);
            let shooter_slot = self.players[i].1.slot;
            let shot = json!([shooter_slot, w, cm(o[0] + d[0] * th), cm(o[1] + d[1] * th),
                              cm(o[2] + d[2] * th), -1, 0]);
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
            if let Some(th) = ray_player(o, d, dc.x, dc.y, dc.z, decoy_d, hs).map(|h| h.0) {
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
            if let Some((th, head)) = ray_player(o, d, v.x, v.y, v.z, reach, hs) {
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
            // snapshot both bodies first — the bubble check borrows `self` read-only
            let (vid, slot, vx, vy, vz, vteam, vprotect, vshield) = {
                let (vid, v) = &self.players[j];
                (vid.clone(), v.slot, v.x, v.y + 0.9, v.z, v.team, v.protect > t, v.shielded(t))
            };
            let (sx, sy, sz, steam) = {
                let sh = &self.players[i].1;
                (sh.x, sh.y + 0.9, sh.z, sh.team)
            };
            let bubble_safe = self.in_bubble(vx, vy, vz, vteam, t)
                && !self.in_bubble(sx, sy, sz, steam, t);
            shot[5] = json!(slot);
            shot[6] = json!(if head { 1 } else { 0 });
            let dmg = if vprotect || vshield || bubble_safe {
                0
            } else if head {
                WEAPONS[w].head
            } else {
                WEAPONS[w].damage
            };
            let killed = {
                let v = &mut self.players[j].1;
                v.hp = (v.hp - dmg).max(0);
                dmg > 0 && v.hp <= 0
            };
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
            for (_, p) in self.players.iter_mut() {
                p.dirty = true;
            }
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
        // The Warden's dragons: mount, breathe, roam, out-of-bounds.
        self.dragon_tick(dt, t);
        if self.phase != Phase::Round {
            return evs;
        }
        // Drain queued events BEFORE any spawn this tick. A kill booked alongside a
        // respawn must reach the client first: delivered after the "spawn" it re-latches
        // V.dead on a body that just came back (the endless sky-drop loop). Anything the
        // rest of the tick queues is flushed at the end, after the spawns.
        evs.append(&mut self.pending);
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
                self.dragon_release(&uid);
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
            if !self.players[i].1.dead && !self.players[i].1.gone
                && !self.players[i].1.dragon_rider
            {
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
                            // (release below — p is borrowed mutably here)
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
                    self.dragon_release(&uid2);
                    self.mark(&uid2);
                    evs.push(("spawn", ev));
                }
            }
            // Pickups are judged on the tick, not only on an accepted "pos" frame. A frame
            // the air guard / speed cap / POS_RATE bucket rejects used to skip the take
            // entirely, so a totem sat under your feet for several frames (or until the
            // next accepted frame) — "I walked through it and it was not taken". The
            // tick pass runs every 50 ms on the judge's own copy of the body, so a
            // standing taker never waits on the network. (pos() also calls this on an
            // accepted frame for the lowest latency; the slot is consumed either way.)
            if !is_bot && !self.players[i].1.dead {
                self.pickups(i, t);
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
                self.dragon_release(&uid);
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
                    // the same aperture the player walks: a vertical ring at q.y+0.9
                    let dxz = (r.px - q.x).hypot(r.pz - q.z);
                    if dxz <= RIFT_R && (r.py - (q.y + 0.9)).abs() <= RIFT_R {
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
                    let hs = self.head_scale(t);
                    let steam = self.players.iter().find(|(u, _)| *u == r.shooter).map(|(_, p)| p.team);
                    for (_, v) in self.players.iter() {
                        if v.dead || v.gone || Some(v.team) == steam {
                            continue;
                        }
                        let (body, head) = hit_boxes(v.x, v.y, v.z, hs);
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
        // ---- Wave F: joke world totems (Banana / Lava / Goose / Black Hole / Roulette) ----
        // Banana Panic: peels scatter; anyone stepping on one slips, spins and slides.
        let mut slipped: Vec<usize> = Vec::new();
        let mut slip_data: Vec<(usize, f64, f64, f64)> = Vec::new(); // (j, sx, sz, spin_deg)
        for bp in self.bananas.clone() {
            for (j, (_u, v)) in self.players.iter().enumerate() {
                if v.dead || v.gone || v.slip_until > t {
                    continue;
                }
                if (v.x - bp.x).hypot(v.z - bp.z) > BANANA_SLIP {
                    continue;
                }
                // spin + slide forward in the direction they were moving (or facing)
                let (mut sx, mut sz) = (v.vx, v.vz);
                if sx.abs() < 0.01 && sz.abs() < 0.01 {
                    let yaw = (v.r as f64 / 100.0).to_radians();
                    sx = yaw.sin();
                    sz = -(yaw.cos());
                }
                let ln = sx.hypot(sz).max(1e-6);
                slip_data.push((j, sx / ln * BANANA_SLIDE, sz / ln * BANANA_SLIDE, BANANA_SPIN.to_degrees() * 100.0));
            }
        }
        for (j, sx, sz, spin) in slip_data {
            let p = &mut self.players[j].1;
            p.slip_until = t + 1.2;
            p.slip_vx = sx;
            p.slip_vz = sz;
            p.vx = sx;
            p.vz = sz;
            p.r = ((p.r as f64 + spin) as i64).rem_euclid(36000);
            // a bot's physics body owns its motion — bot_step copies body → p every tick
            if let Some(b) = p.bot.as_mut() {
                b.body.vx = sx;
                b.body.vz = sz;
            }
            slipped.push(j);
        }
        for &j in &slipped {
            self.mark_idx(j);
        }
        // Floor Is Lava: standing on a dangerous patch too long launches you up + burns.
        let mut lava_hits: Vec<usize> = Vec::new();
        let mut lava_reset: Vec<usize> = Vec::new();
        let mut lava_step: Vec<usize> = Vec::new();
        for (j, (_u, v)) in self.players.iter().enumerate() {
            if v.dead || v.gone || v.y > 1.5 {
                // higher ground saves you
                lava_reset.push(j);
                continue;
            }
            let mut on = false;
            for lz in self.lava_zones.iter() {
                if (v.x - lz.x).hypot(v.z - lz.z) <= lz.r {
                    on = true;
                    break;
                }
            }
            if !on {
                lava_reset.push(j);
                continue;
            }
            lava_step.push(j);
        }
        for j in lava_reset {
            self.players[j].1.lava_hold = 0.0;
        }
        for j in lava_step {
            let p = &mut self.players[j].1;
            p.lava_hold += dt;
            if p.lava_hold >= LAVA_HOLD {
                p.lava_hold = 0.0;
                p.y += 0.1;
                p.hp = (p.hp - LAVA_DMG).max(0);
                lava_hits.push(j);
            }
        }
        for j in lava_hits {
            self.mark_idx(j);
            if self.players[j].1.hp <= 0 && !self.players[j].1.dead {
                self.env_kill(j, "lava", t);
            }
        }
        // Goose Attack: chases the nearest player and headbutts anyone it catches.
        // LISTS — several geese can run at once and each one stacks (never replaces).
        let mut geese_keep: Vec<Goose> = Vec::with_capacity(self.geese.len());
        let geese_in = std::mem::take(&mut self.geese);
        for mut g in geese_in {
            if g.until <= t {
                continue;
            }
            // pick nearest living player
            let mut best: Option<usize> = None;
            let mut best_d = f64::MAX;
            for (j, (_u, v)) in self.players.iter().enumerate() {
                if v.dead || v.gone {
                    continue;
                }
                let d = (v.x - g.x).hypot(v.z - g.z);
                if d < best_d {
                    best_d = d;
                    best = Some(j);
                }
            }
            if let Some(j) = best {
                let (tx, tz) = (self.players[j].1.x, self.players[j].1.z);
                let (dx, dz) = (tx - g.x, tz - g.z);
                let ln = dx.hypot(dz).max(1e-6);
                g.x += dx / ln * GOOSE_SPEED * dt;
                g.z += dz / ln * GOOSE_SPEED * dt;
                if ln < GOOSE_HIT_R {
                    // one headbutt and the goose is satisfied
                    let dead_now = {
                        let p = &mut self.players[j].1;
                        p.hp = (p.hp - GOOSE_DMG).max(0);
                        p.vx = dx / ln * GOOSE_KNOCK;
                        p.vz = dz / ln * GOOSE_KNOCK;
                        if let Some(b) = p.bot.as_mut() {
                            b.body.vx = dx / ln * GOOSE_KNOCK;
                            b.body.vz = dz / ln * GOOSE_KNOCK;
                        }
                        p.hp <= 0
                    };
                    self.mark_idx(j);
                    if dead_now {
                        self.env_kill(j, "goose", t);
                    }
                    continue;
                }
            }
            geese_keep.push(g);
        }
        self.geese = geese_keep;
        // Black Hole: sucks everything toward its centre until it disappears.
        // LISTS — several holes can run at once and each one stacks (never replaces).
        self.blackholes.retain(|bh| bh.until > t);
        if !self.blackholes.is_empty() {
            self.mark_world();
        }
        for bh in self.blackholes.clone() {
            for (_u, p) in self.players.iter_mut() {
                if p.dead || p.gone {
                    continue;
                }
                let (dx, dz) = (bh.x - p.x, bh.z - p.z);
                let ln = dx.hypot(dz).max(1e-6);
                if ln > HOLE_REACH {
                    continue;
                }
                // a gravity well bites harder the closer you are: full pull at the rim,
                // a shove in the throat (and a hard clamp so you end up ON the hole, not
                // orbiting it for the rest of the window)
                let pull = (HOLE_PULL * dt) * (0.55 + 0.45 * (ln / HOLE_REACH).min(1.0));
                let px = (dx / ln * pull).clamp(-ln, ln);
                let pz = (dz / ln * pull).clamp(-ln, ln);
                p.x += px;
                p.z += pz;
                p.hole_drag = t + 0.4;   // the ref lets this step through at slide speed
                // a bot's physics body owns its position mid-tick — bot_step seeds body
                // from p at entry, so write both
                if let Some(b) = p.bot.as_mut() {
                    b.body.x += px;
                    b.body.z += pz;
                }
            }
        }
        // ---- Wave G world tick: turrets / barrels / laser grid / jump pads ----
        // Turrets: track and shoot the nearest ENEMY in range (never a team-mate).
        self.turrets.retain(|tu| tu.hp > 0 && tu.until > t);
        if !self.turrets.is_empty() {
            self.mark_world();
        }
        for ti in 0..self.turrets.len() {
            if t < self.turrets[ti].next {
                continue;
            }
            self.turrets[ti].next = t + TURRET_GAP;
            let (tx, tz, tteam) = {
                let tu = &self.turrets[ti];
                (tu.x, tu.z, tu.team)
            };
            let mut best: Option<(usize, f64)> = None;
            let mut best_d = TURRET_RANGE;
            for (j, (_u, v)) in self.players.iter().enumerate() {
                if v.dead || v.gone || v.team == tteam {
                    continue;
                }
                let d = (v.x - tx).hypot(v.z - tz);
                if d <= best_d {
                    best_d = d;
                    best = Some((j, d));
                }
            }
            let Some((j, _d)) = best else { continue };
            let (vx, vz) = {
                let v = &self.players[j].1;
                (v.x, v.z)
            };
            self.turrets[ti].yaw = (vx - tx).atan2(vz - tz);
            self.mark_world();
            let dead_now = {
                let p = &mut self.players[j].1;
                p.hp = (p.hp - TURRET_DMG).max(0);
                p.hp <= 0
            };
            if dead_now {
                // a world object has no shooter in the feed — name the turret
                self.env_kill(j, "turret", t);
            }
        }
        // Barrels: they fall out of the sky and land. Once landed they wait for a
        // bullet (or another barrel's blast) — see barrel_blast().
        for bo in self.barrels.iter_mut() {
            if bo.landed {
                continue;
            }
            bo.vy -= 28.0 * dt;
            bo.y += bo.vy * dt;
            if bo.y <= 0.0 {
                bo.y = 0.0;
                bo.vy = 0.0;
                bo.landed = true;
            }
        }
        // Laser Grid: a thick tripwire. Walk into it and you die; jump clean over it
        // (y >= LASER_CLEAR) or walk beside it and you live.
        self.lasers.retain(|lz| lz.until > t);
        if !self.lasers.is_empty() {
            self.mark_world();
            let mut zap: Vec<usize> = Vec::new();
            for (j, (_u, v)) in self.players.iter().enumerate() {
                if v.dead || v.gone || v.dragon_rider {
                    continue;
                }
                // the beam is planted ON the deck under you (ground_y), so the clear
                // check is height ABOVE that deck — an absolute y would treat a walker
                // on the dockyard's raised centre (top 3.5) as "already jumped clean
                // over" and let them through.
                if v.y - ground_y(self.map(), v.x, v.z) >= LASER_CLEAR {
                    continue;   // jumped clean over the beam
                }
                for lz in &self.lasers {
                    if seg_dist2(v.x, v.z, lz.ax, lz.az, lz.bx, lz.bz) > LASER_HALF * LASER_HALF {
                        continue;
                    }
                    zap.push(j);
                    break;
                }
            }
            for j in zap {
                self.env_kill(j, "laser", t);
            }
        }
        // Jump Pads: step on one and it throws you sky-high. Anyone can use them.
        self.pads.retain(|pd| pd.until > t);
        if !self.pads.is_empty() {
            self.mark_world();
            let m = self.map();
            for (_u, p) in self.players.iter_mut() {
                if p.dead || p.gone || p.y - ground_y(m, p.x, p.z) > 0.35 {
                    continue;
                }
                if p.pad_cool > t {
                    continue;
                }
                for pd in &self.pads {
                    if (p.x - pd.x).hypot(p.z - pd.z) > PAD_R {
                        continue;
                    }
                    p.y += 0.12;
                    if let Some(b) = p.bot.as_mut() {
                        b.body.y = p.y;
                        b.body.vy = PAD_LAUNCH;
                        b.body.g = false;
                    }
                    p.pad_cool = t + PAD_COOL;
                    break;
                }
            }
        }
        // Weapon Roulette: every 2 s everyone's weapon randomly switches.
        if self.roulette_until > t && t >= self.roulette_next {
            self.roulette_next = t + ROULETTE_GAP;
            self.world_k += 1;
            let seed = (self.world_k as u32)
                .wrapping_mul(2_654_435_761)
                .wrapping_add((t * 1000.0) as u32);
            for (j, (_u, p)) in self.players.iter_mut().enumerate() {
                if p.dead || p.gone {
                    continue;
                }
                let cap = if p.bot.is_some() {
                    BOT_WEAPON_MAX
                } else {
                    NW
                };
                let rw = (seed.wrapping_add((j as u32).wrapping_mul(131)) % cap as u32) as usize;
                p.w = rw;
                // refill the mag on each switch so the roulette is a joke, not a death sentence
                let mag = WEAPONS[rw].mag;
                p.mag[rw] = mag;
                p.reload = None;
            }
            self.mark_all();
        }
        // ---- Wave C world tick: mines, meteors, bubbles, beacons, portals, events, crate ----
        self.portals.retain(|p| p.until > t);
        self.bubbles.retain(|b| b.until > t);
        self.beacons.retain(|b| b.until > t);
        // Rally: the beacon heals your side slowly near it (6 hp/s, twin of the JS tick)
        for b in &self.beacons {
            if b.kind != "rally" || b.until <= t {
                continue;
            }
            let team = b.team;
            for (_, p) in self.players.iter_mut() {
                if p.team != team || p.dead || p.gone {
                    continue;
                }
                if (p.x - b.x).hypot(p.z - b.z) <= 10.0 {
                    // 6 hp/s is 0.3 a tick at 20 Hz; truncating every tick never heals.
                    // Accumulate the fraction, pay out whole points (twin of V.hpAcc).
                    p.hp_acc += 6.0 * dt;
                    if p.hp_acc >= 1.0 {
                        let whole = p.hp_acc.floor() as i64;
                        p.hp_acc -= whole as f64;
                        p.hp = (p.hp + whole).min(HP);
                    }
                }
            }
        }
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
                self.mark_idx(j);
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
                self.mark_idx(j);
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
                self.mark_idx(j);
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
                // `y` is the half that was consumed into the Chaos Core. Clients used to
                // get only the survivor (`i`/`kind`), so slot y stayed painted as a
                // takeable gem forever — the judge had already booked it and would never
                // send a "pick", which is exactly "I go through them and they are left
                // behind". `j` is the slot to clear on every client.
                self.pending.push(("fused", json!({"i": x, "kind": "chaos", "j": y})));
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
        self.hook_pull_step(t);
        if send && (!self.dirty.is_empty() || self.world_dirty || !self.shots.is_empty()
                    || !self.booms.is_empty() || !self.rockets.is_empty()) {
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
                | if p.slow_until > t { FLAG_SLOW } else { 0 }   // disaster crawl
                | if p.hook_until > t { FLAG_HOOK } else { 0 }  // grappling-gun lock
                | if p.dance_until > t { FLAG_DISCO } else { 0 }  // disco dance (cannot shoot)
                | if self.big_head_until > t { FLAG_BIGHEAD } else { 0 }  // arena-wide skull scale
                | if self.reverse_until > t { FLAG_REVERSE } else { 0 }  // WASD reversed
                | if self.roulette_until > t { FLAG_ROULETTE } else { 0 };  // weapon roulette
            let when = p.hist.back().map(|h| self.ms(h.0)).unwrap_or(-1);
            ents.push(json!([p.slot, cm(p.x), cm(p.y), cm(p.z), p.r, p.pt, p.hp, p.w, f, when]));
        }
        // "r": [id, cm x, cm y, cm z, vx*100, vy*100, vz*100, shooter_slot]. Index 7 is
        // the shooter — old clients ignore it. The shooter's own gate ("one rocket in
        // the air") must not fire on somebody else's rocket.
        let rockets: Vec<Value> = self.rockets.iter()
            .map(|r| {
                let slot = self.players.iter()
                    .find(|(u, _)| u == &r.shooter)
                    .map(|(_, p)| p.slot)
                    .unwrap_or(-1);
                json!([r.id, cm(r.x), cm(r.y), cm(r.z), (r.vx * 100.0) as i64,
                       (r.vy * 100.0) as i64, (r.vz * 100.0) as i64, slot])
            }).collect();
        // decoys: the full list while any lives (id, x, y, z, ms left, yaw in centidegrees)
        let decoys: Vec<Value> = self.decoys.iter()
            .map(|dc| json!([dc.id, cm(dc.x), cm(dc.y), cm(dc.z),
                             ((dc.until - t) * 1000.0) as i64, (dc.yaw * 100.0) as i64])).collect();
        // match flight drones (grapple anchors): [id, cm_x, cm_y, cm_z, downMs]
        // downMs is how long the hull stays a wreck (0 = up). Old clients ignore index 4.
        let mt = (t - self.go_at).max(0.0);
        let drone_rows: Vec<Value> = self.drones.iter().enumerate().map(|(i, tg)| {
            let c = drone_at(tg, mt);
            let down_ms = self
                .drone_down
                .get(i)
                .map(|d| ((d - t).max(0.0) * 1000.0) as i64)
                .unwrap_or(0);
            json!([i, cm(c[0]), cm(c[1]), cm(c[2]), down_ms])
        }).collect();
        // live grapple pulls: [victim_slot, cm_shooter_x, cm_shooter_z]
        let hook_rows: Vec<Value> = self.players.iter().filter_map(|(_, p)| {
            if p.hook_until <= t {
                return None;
            }
            let (hx, hz) = p.hook_pull?;
            Some(json!([p.slot, cm(hx), cm(hz)]))
        }).collect();
        // Wave C world extras (additive keys — an old client just ignores them)
        let portals: Vec<Value> = self.portals.iter()
            .map(|q| json!([q.id, cm(q.x), cm(q.z), ((q.until - t) * 1000.0) as i64, cm(q.yaw)])).collect();
        let mines: Vec<Value> = self.mines.iter()
            .map(|q| json!([q.id, cm(q.x), cm(q.z), q.team])).collect();
        let meteors: Vec<Value> = self.meteors.iter()
            .map(|q| json!([q.id, cm(q.x), cm(q.z), ((q.hit_at - t) * 1000.0) as i64])).collect();
        let beacons: Vec<Value> = self.beacons.iter()
            .map(|q| json!([q.id, cm(q.x), cm(q.z), q.kind, q.team, ((q.until - t) * 1000.0) as i64])).collect();
        let bubbles: Vec<Value> = self.bubbles.iter()
            .map(|q| json!([q.id, cm(q.x), cm(q.y), cm(q.z), cm(q.r), q.team, ((q.until - t) * 1000.0) as i64])).collect();
        // Wave F world objects (additive keys — an old client just ignores them)
        let bananas: Vec<Value> = self.bananas.iter()
            .map(|q| json!([q.id, cm(q.x), cm(q.z)])).collect();
        let lava_rows: Vec<Value> = self.lava_zones.iter()
            .map(|q| json!([q.id, cm(q.x), cm(q.z), cm(q.r)])).collect();
        // gs / bh are LISTs of rows (several geese / holes stack). Each row is
        // [id, cm x, cm z, ms left] — same row shape as the old single-slot value.
        let goose_rows: Vec<Value> = self.geese.iter()
            .map(|g| json!([g.id, cm(g.x), cm(g.z), ((g.until - t).max(0.0) * 1000.0) as i64]))
            .collect();
        let hole_rows: Vec<Value> = self.blackholes.iter()
            .map(|h| json!([h.id, cm(h.x), cm(h.z), ((h.until - t).max(0.0) * 1000.0) as i64]))
            .collect();
        // Wave G world objects (additive keys — an old client just ignores them).
        // tr / br / lg / pd are LISTs of rows, same shape as gs / bh.
        let turret_rows: Vec<Value> = self.turrets.iter()
            .map(|q| json!([q.id, cm(q.x), cm(q.z), q.team, q.hp,
                            ((q.until - t).max(0.0) * 1000.0) as i64,
                            (q.yaw.to_degrees() * 100.0).round() as i64]))
            .collect();
        let barrel_rows: Vec<Value> = self.barrels.iter()
            .map(|q| json!([q.id, cm(q.x), cm(q.y), cm(q.z), q.hp]))
            .collect();
        let laser_rows: Vec<Value> = self.lasers.iter()
            .map(|q| json!([q.id, cm(q.ax), cm(q.az), cm(q.bx), cm(q.bz), ((q.until - t).max(0.0) * 1000.0) as i64]))
            .collect();
        let pad_rows: Vec<Value> = self.pads.iter()
            .map(|q| json!([q.id, cm(q.x), cm(q.z), ((q.until - t).max(0.0) * 1000.0) as i64]))
            .collect();
        // "drg": the Warden's dragons. Each row is
        // [id, tier, cm x, cm y, cm z, yaw_cdeg, hp, max, mount_slot, breath_ms,
        //  recharge_ms, spray_ms].
        // mount_slot is -1 when nobody is riding. spray_ms is how long the jet is still
        // open (> 0 only while the trigger is held) — WITHOUT it a client has no way to
        // tell a spraying dragon from a full tank, and paints flame and damage numbers
        // on every idle mount. Twin: the "drg" parse in games/strike.js.
        let dragon_rows: Vec<Value> = self.dragons.iter().map(|dr| {
            let mount_slot = self.players.iter()
                .find(|(u, _)| !dr.rider.is_empty() && u.as_str() == dr.rider.as_str())
                .map(|(_, p)| p.slot)
                .unwrap_or(-1);
            json!([
                dr.id,
                WARDEN_DRAGON_TIERS[dr.tier.min(WARDEN_DRAGON_TIERS.len() - 1)],
                cm(dr.x),
                cm(dr.y),
                cm(dr.z),
                (dr.yaw.to_degrees() * 100.0).round() as i64,
                dr.hp,
                dr.max,
                mount_slot,
                (dr.breath_left.max(0.0) * 1000.0) as i64,
                if dr.recharge_at > t { ((dr.recharge_at - t) * 1000.0) as i64 } else { 0 },
                if dr.spray_until > t {
                    ((dr.spray_until - t).min(DRAGON_BREATH_SECS) * 1000.0).round() as i64
                } else {
                    0
                }
            ])
        }).collect();
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
        // Wave D/E: the LIVE disasters ("di" — never "ev", which Out::msg() owns) and the
        // impact marks they warned about ("dm"), both ms from the client clock.
        // di is now a LIST of rows (several disasters can run at once):
        //   [kind, ms-to-warn-end, ms-to-hold-end, cm ring, ms-to-NEXT-auto, seed, zones, pit]
        // di[0][4] is always the ms until the NEXT automatic disaster — the top-bar clock —
        // even when nothing is live (the list is then [[null, 0, 0, 0, ms-to-next]]).
        // dm rows gain a trailing disaster-kind string at index 8 so the client can
        // attribute each mark to its parent disaster.
        let dis_next = self
            .disaster_at
            .map(|at| ((at - t).max(0.0) * 1000.0) as i64)
            .unwrap_or(0);
        let dis_row: Value = if self.disasters.is_empty() {
            if self.disaster_at.is_some() {
                json!([[Value::Null, 0, 0, 0, dis_next]])
            } else {
                Value::Null
            }
        } else {
            let rows: Vec<Value> = self
                .disasters
                .iter()
                .map(|d| {
                    json!([
                        d.kind,
                        ((d.warn_at - t).max(0.0) * 1000.0) as i64,
                        ((d.until - t).max(0.0) * 1000.0) as i64,
                        cm(d.ring),
                        dis_next,
                        d.seed,
                        d.zones.iter().map(|z| json!([cm(z.0), cm(z.1)])).collect::<Vec<_>>(),
                        [cm(d.pit.0), cm(d.pit.1)]
                    ])
                })
                .collect();
            json!(rows)
        };
        let marks: Vec<Value> = self
            .warns
            .iter()
            .map(|w| {
                json!([
                    w.id,
                    cm(w.x),
                    cm(w.z),
                    ((w.hit_at - t).max(0.0) * 1000.0) as i64,
                    cm(w.r),
                    if w.overhead { 1 } else { 0 },
                    w.dmg,
                    w.quake as i64,
                    w.dis
                ])
            })
            .collect();
        // The Warden ("wd" — never "ev"): [hp, max, cm x, cm z,
        // ms-to-slab-arm, ms-to-slab-land, ms-to-laser-warn, laser-on-ms,
        // laser-yaw-cdeg, ms-to-dis, ck-bitmask, yaw-cdeg,
        // ms-core, ms-grip-warn, ms-grip-on, ms-grip-at, ms-dance].
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
                if wd.grip_at > t { ms(wd.grip_at) } else { 0 },
                if wd.dance_until > t { ms(wd.dance_until) } else { 0 }
            ])
        });
        // Sparse snapshot: an empty world list is OMITTED entirely, not sent as [].
        // At 20 Hz × ~20 world keys the empty arrays were the bulk of every frame even
        // in a quiet arena — the single biggest bandwidth/parse cost in MP. The client
        // already guards every key with Array.isArray(...) and every list that can go
        // from "something" to "nothing" has an MP else-clear branch, so an absent key
        // means "empty" and nothing sticks on screen. (Twin: onSnap in games/strike.js.)
        let mut snap = json!({"k": self.k, "ts": self.ms(t), "ms": self.ms_left(t), "sc": self.scores,
                          "p": ents, "di": dis_row});
        let obj = snap.as_object_mut().unwrap();
        if !self.shots.is_empty() { obj.insert("s".into(), Value::Array(self.shots.clone())); }
        if !rockets.is_empty() { obj.insert("r".into(), Value::Array(rockets)); }
        if !self.booms.is_empty() { obj.insert("b".into(), Value::Array(self.booms.clone())); }
        if !decoys.is_empty() { obj.insert("d".into(), Value::Array(decoys)); }
        if !drone_rows.is_empty() { obj.insert("dr".into(), Value::Array(drone_rows)); }
        if !hook_rows.is_empty() { obj.insert("hk".into(), Value::Array(hook_rows)); }
        if !portals.is_empty() { obj.insert("po".into(), Value::Array(portals)); }
        if !mines.is_empty() { obj.insert("mi".into(), Value::Array(mines)); }
        if !meteors.is_empty() { obj.insert("me".into(), Value::Array(meteors)); }
        if !beacons.is_empty() { obj.insert("bc".into(), Value::Array(beacons)); }
        if !bubbles.is_empty() { obj.insert("bu".into(), Value::Array(bubbles)); }
        if !bananas.is_empty() { obj.insert("bn".into(), Value::Array(bananas)); }
        if !lava_rows.is_empty() { obj.insert("lz".into(), Value::Array(lava_rows)); }
        if !goose_rows.is_empty() { obj.insert("gs".into(), Value::Array(goose_rows)); }
        if !hole_rows.is_empty() { obj.insert("bh".into(), Value::Array(hole_rows)); }
        if !turret_rows.is_empty() { obj.insert("tr".into(), Value::Array(turret_rows)); }
        if !barrel_rows.is_empty() { obj.insert("br".into(), Value::Array(barrel_rows)); }
        if !laser_rows.is_empty() { obj.insert("lg".into(), Value::Array(laser_rows)); }
        if !pad_rows.is_empty() { obj.insert("pd".into(), Value::Array(pad_rows)); }
        if !dragon_rows.is_empty() { obj.insert("drg".into(), Value::Array(dragon_rows)); }
        // "dm" always ships (empty or not) — the judge tests pin it as a contract key
        obj.insert("dm".into(), Value::Array(marks));
        if let Some(r) = fate_row { obj.insert("fa".into(), r); }
        if let Some(r) = ev_row { obj.insert("ae".into(), r); }
        if let Some(r) = crate_row { obj.insert("cr".into(), r); }
        if let Some(r) = warden_row { obj.insert("wd".into(), r); }
        self.dirty.clear();
        self.world_dirty = false;
        for (_, p) in self.players.iter_mut() {
            p.dirty = false;
        }
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
            "mount" => {
                sm.mount(uid, msg, t);
            }
            "breathe" => {
                sm.breathe(uid, msg, t);
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
