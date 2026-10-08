//! Platformer Rush for the Valley (g = "plat"): the levels, the start, the
//! referee and the game's lobby. A port of `backend/app/platformer.py` plus the
//! plat branch of `backend/app/valley.py`.
//!
//! Run, jump and double-jump through floating islands to the flag, collecting
//! coins. Two modes for up to 8 players: a race (the flag only counts once every
//! checkpoint has been touched, in order) and co-op (the lobby shares one coin
//! goal and wins together before the timer runs out).
//!
//! Each player runs their own character in the browser (games/platformer.js) and
//! streams where it is; the server runs a fixed-rate tick (`realtime.rs`) that
//! checks every position, owns the checkpoints, the coins and the finish, and
//! sends one batched snapshot to the lobby per tick. It does not simulate the
//! characters: it checks that each move stays inside the level, is no faster than
//! a character runs, rises and falls no faster than a jump and gravity allow, never
//! ends inside a platform, and never climbs higher above the last platform stood on
//! than a jump plus a double jump can reach in the time since. A failing frame gets
//! a "fix" back to the last place the player stood on solid ground.
//!
//! Levels come from `backend/app/platformer_levels.json`, embedded with
//! `include_str!` (the same file the Python reads, itself a byte copy of
//! games/platformer/levels.json).
//!
//! Units on the wire: x, y, z in centimetres (y = the feet), yaw in whole degrees,
//! an animation id, the sender's clock in centiseconds (q).
//!
//! Protocol: in `{"type":"game","g":"plat","op":...}`, out
//! `{"type":"game","g":"plat","ev":...}`. Ops: join, leave, invite, view, char,
//! start, end, pos, respawn. Events: lobby, plat, char, go, snap, fix, spawn, cp,
//! coin, finish, dnf, done, invite, invited, error.

// The geometry helpers are the API the tests (and the Python's) drive the referee with.
#![cfg_attr(not(test), allow(dead_code))]

use crate::kart::{Lobby, Out, To};
use crate::realtime::{Clock, Registry, Ticker};
use crate::results::Recorder;
use crate::rooms::{Member, RoomManager};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::{Arc, LazyLock, Mutex};

// -- shared with games/platformer.js (PLAT-LEVEL block) --
pub const PR: f64 = 0.3;
#[allow(dead_code)] // the browser's character height (PLAT-LEVEL block); documents the shape
pub const PH: f64 = 0.9;
pub const CENTER: f64 = 0.45;

// -- the referee's limits --
pub const MAX_RUN: f64 = 8.0;
pub const SLACK_H: f64 = 1.2;
pub const MAX_RISE: f64 = 10.0;
pub const MAX_FALL: f64 = 24.0;
pub const SLACK_V: f64 = 1.0;
pub const S_JUMP: f64 = 9.0;
pub const S_DJUMP: f64 = 8.2;
pub const S_GRAV: f64 = 24.0;
pub const ENV_W: f64 = 0.3;
pub const ENV_SLACK: f64 = 0.5;
pub const SUPPORT_M: f64 = PR + 0.2;
pub const SUPPORT_TOL: f64 = 0.6;
pub const CLOCK_LEAD: f64 = 0.6;
pub const CP_R: f64 = 2.0;
pub const COIN_R: f64 = 1.0;
pub const FLAG_R: f64 = 1.6;
pub const HZ: f64 = 15.0;
pub const COUNTDOWN: f64 = 4.0;
pub const FINISH_GRACE: f64 = 30.0;
pub const MAX_RUN_SECS: f64 = 420.0;
pub const GRACE: f64 = 20.0;
pub const POS_RATE: f64 = 25.0;
pub const POS_BURST: f64 = 10.0;
pub const FIX_GAP: f64 = 0.5;
pub const RESPAWN_GAP: f64 = 0.5;
pub const MAX_PLAYERS: usize = 8;
pub const CHARS: i64 = 6;
pub const ANIMS: f64 = 5.0;

// Lobby (valley.py)
pub const GAME: &str = "plat";
pub const GAME_NAME: &str = "Platformer Rush";
pub const MAX_LOBBY: usize = 8;
pub const HOST_GRACE: f64 = 15.0;

pub const LEVELS_JSON: &str = include_str!("../../backend/app/platformer_levels.json");

/// name -> (round?, width x, depth z, height) before scale and rotation.
pub fn model(name: &str) -> Option<(bool, f64, f64, f64)> {
    Some(match name {
        "platform" => (false, 2.0, 2.0, 0.5),
        "platform-medium" => (false, 3.0, 3.0, 0.5),
        "platform-large" => (false, 5.0, 5.0, 0.5),
        "platform-falling" => (false, 2.2, 2.2, 0.5),
        "platform-grass-large-round" => (true, 5.0, 5.0, 0.5),
        "brick" | "block-coin" => (false, 1.0, 1.0, 1.0),
        _ => return None,
    })
}

// ------------------------------------------------------------------ levels --
#[derive(Clone, Debug)]
pub struct Solid {
    pub m: String,
    pub x0: f64,
    pub x1: f64,
    pub y0: f64,
    pub y1: f64,
    pub z0: f64,
    pub z1: f64,
    pub cx: f64,
    pub cz: f64,
    /// > 0: a cylinder of this radius (the round platform).
    pub r: f64,
}

#[derive(Clone, Debug)]
pub struct Level {
    pub id: String,
    pub name: String,
    pub kill: f64,
    pub solids: Vec<Solid>,
    pub spawns: Vec<[f64; 3]>,
    pub cps: Vec<[f64; 3]>,
    pub coins: Vec<[f64; 3]>,
    pub flag: [f64; 3],
    pub goal: i64,
    pub secs: f64,
    pub bounds: [f64; 6],
    /// [x, y, z] + 'w' | 'j' | 'd'
    pub route: Vec<([f64; 3], char)>,
}

fn f(v: &Value) -> f64 {
    v.as_f64().unwrap_or(0.0)
}

fn p3(v: &Value) -> [f64; 3] {
    [f(&v[0]), f(&v[1]), f(&v[2])]
}

pub fn solid_of(b: &Value) -> Solid {
    let m = b["m"].as_str().unwrap_or("");
    let (round, mut w, mut d, h) = model(m).expect("a known model");
    let s = b.get("s").and_then(Value::as_f64).unwrap_or(1.0);
    if b.get("r").and_then(Value::as_i64).unwrap_or(0).rem_euclid(180) == 90 {
        std::mem::swap(&mut w, &mut d);
    }
    let (x, y, z) = (f(&b["x"]), f(&b["y"]), f(&b["z"]));
    Solid {
        m: m.to_string(),
        x0: x - w * s / 2.0,
        x1: x + w * s / 2.0,
        y0: y,
        y1: y + h * s,
        z0: z - d * s / 2.0,
        z1: z + d * s / 2.0,
        cx: x,
        cz: z,
        r: if round { w * s / 2.0 } else { 0.0 },
    }
}

pub fn compile_level(lv: &Value) -> Level {
    let solids: Vec<Solid> = lv["solids"].as_array().expect("solids").iter().map(solid_of).collect();
    let top = solids.iter().map(|s| s.y1).fold(f64::MIN, f64::max);
    let kill = f(&lv["kill"]);
    let list = |k: &str| lv[k].as_array().map(|a| a.iter().map(p3).collect()).unwrap_or_default();
    let mn = |g: fn(&Solid) -> f64| solids.iter().map(g).fold(f64::MAX, f64::min);
    let mx = |g: fn(&Solid) -> f64| solids.iter().map(g).fold(f64::MIN, f64::max);
    Level {
        id: lv["id"].as_str().unwrap_or("").to_string(),
        name: lv["name"].as_str().unwrap_or("").to_string(),
        kill,
        spawns: list("spawns"),
        cps: list("cps"),
        coins: list("coins"),
        flag: p3(&lv["flag"]),
        goal: lv.get("coopGoal").and_then(Value::as_i64).unwrap_or(0),
        secs: lv.get("coopSecs").and_then(Value::as_f64).unwrap_or(180.0),
        bounds: [mn(|s| s.x0) - 12.0, mx(|s| s.x1) + 12.0, kill - 6.0, top + 10.0,
                 mn(|s| s.z0) - 12.0, mx(|s| s.z1) + 12.0],
        route: lv["route"]
            .as_array()
            .map(|a| a.iter().map(|p| (p3(p), p[3].as_str().and_then(|s| s.chars().next()).unwrap_or('w'))).collect())
            .unwrap_or_default(),
        solids,
    }
}

pub static LEVELS: LazyLock<Vec<Level>> = LazyLock::new(|| {
    let data: Value = serde_json::from_str(LEVELS_JSON).expect("platformer_levels.json parses");
    data["levels"].as_array().expect("levels").iter().map(compile_level).collect()
});

pub fn level(id: &str) -> Option<&'static Level> {
    LEVELS.iter().find(|l| l.id == id)
}

/// (x, z) over the solid's footprint grown by m (shrunk if m < 0).
pub fn in_foot(s: &Solid, x: f64, z: f64, m: f64) -> bool {
    if s.r > 0.0 {
        let (dx, dz) = (x - s.cx, z - s.cz);
        return dx * dx + dz * dz <= (s.r + m) * (s.r + m);
    }
    s.x0 - m <= x && x <= s.x1 + m && s.z0 - m <= z && z <= s.z1 + m
}

/// The top of the highest solid under (x, z) that feet at y stand on or hover at
/// most `tol` above.
pub fn support(lv: &Level, x: f64, y: f64, z: f64, m: f64, tol: f64) -> Option<f64> {
    let mut best: Option<f64> = None;
    for s in &lv.solids {
        if s.y1 - 0.05 <= y && y <= s.y1 + tol && in_foot(s, x, z, m) && best.map(|b| s.y1 > b).unwrap_or(true) {
            best = Some(s.y1);
        }
    }
    best
}

/// Feet at (x, y, z) are inside a solid.
pub fn inside(lv: &Level, x: f64, y: f64, z: f64) -> bool {
    lv.solids.iter().any(|s| s.y0 + 0.1 < y && y < s.y1 - 0.15 && in_foot(s, x, z, -0.05))
}

/// Distance from p to the segment a-b.
pub fn seg_dist(a: [f64; 3], b: [f64; 3], p: [f64; 3]) -> f64 {
    let ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    let ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
    let l = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
    let u = if l <= 1e-12 { 0.0 } else { ((ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / l).clamp(0.0, 1.0) };
    let d = [ap[0] - ab[0] * u, ap[1] - ab[1] * u, ap[2] - ab[2] * u];
    (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt()
}

/// The highest the feet can be above the top they left, tau seconds after.
pub fn lift_max(tau: f64) -> f64 {
    if tau <= 0.0 {
        return 0.0;
    }
    let s = tau.min(((tau + (S_JUMP - S_DJUMP) / S_GRAV) / 2.0).max(0.0));
    let r = tau - s;
    S_JUMP * s - S_GRAV * s * s / 2.0 + S_DJUMP * r - S_GRAV * r * r / 2.0
}

pub const T_APEX: f64 = (S_JUMP + S_DJUMP) / S_GRAV;

pub fn lift_bound(tau: f64) -> f64 {
    lift_max(T_APEX.max(tau - ENV_W).min(tau + ENV_W)) + ENV_SLACK
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
    Grid,
    Run,
    Done,
}

impl Phase {
    pub fn as_str(self) -> &'static str {
        match self {
            Phase::Idle => "idle",
            Phase::Grid => "grid",
            Phase::Run => "run",
            Phase::Done => "done",
        }
    }
}

#[derive(Clone, Debug)]
pub struct Player {
    pub user: Value,
    pub slot: usize,
    pub chr: i64,
    pub x: i64,
    pub y: i64,
    pub z: i64,
    pub r: i64,
    pub a: i64,
    pub q: Option<i64>,
    pub q0: i64,
    pub t0: f64,
    pub at: f64,
    /// Top of the last solid stood on, and (sender) time then.
    pub base: f64,
    pub air: Option<f64>,
    /// Last place stood on solid ground: where a fix sends you.
    pub safe: [f64; 3],
    pub cp: usize,
    pub cp_at: Vec<i64>,
    pub got: BTreeSet<usize>,
    pub fin: Option<i64>,
    pub dnf: bool,
    pub away: Option<f64>,
    pub told: bool,
    pub bucket: (f64, f64),
    pub fix_at: f64,
    pub spawn_at: f64,
    pub bad: u32,
    pub tp: bool,
}

/// One room's run. idle -> grid (countdown) -> run -> done.
#[derive(Debug)]
pub struct Plat {
    pub level: Option<String>,
    pub mode: String,
    pub phase: Phase,
    pub go_at: f64,
    pub first_at: Option<f64>,
    pub players: Vec<(String, Player)>,
    pub chars: BTreeMap<String, i64>,
    pub results: Option<Value>,
    pub taken: Vec<usize>,
    pub win: Option<bool>,
    pub dirty: Vec<String>,
    pub order_sig: Vec<String>,
    pub pending: Vec<(&'static str, Value)>,
}

impl Default for Plat {
    fn default() -> Self {
        Self::new()
    }
}

impl Plat {
    pub fn new() -> Self {
        Self {
            level: None,
            mode: "race".into(),
            phase: Phase::Idle,
            go_at: 0.0,
            first_at: None,
            players: Vec::new(),
            chars: BTreeMap::new(),
            results: None,
            taken: Vec::new(),
            win: None,
            dirty: Vec::new(),
            order_sig: Vec::new(),
            pending: Vec::new(),
        }
    }

    pub fn lv(&self) -> Option<&'static Level> {
        self.level.as_deref().and_then(level)
    }

    pub fn player(&self, uid: &str) -> Option<&Player> {
        self.players.iter().find(|(u, _)| u == uid).map(|(_, p)| p)
    }

    pub fn player_mut(&mut self, uid: &str) -> Option<&mut Player> {
        self.players.iter_mut().find(|(u, _)| u == uid).map(|(_, p)| p)
    }

    pub fn ms(&self, t: f64) -> i64 {
        ((t - self.go_at) * 1000.0).round_ties_even().max(0.0) as i64
    }

    fn coop(&self) -> bool {
        self.mode == "coop"
    }

    pub fn limit(&self) -> f64 {
        match (self.coop(), self.lv()) {
            (true, Some(l)) => l.secs,
            _ => MAX_RUN_SECS,
        }
    }

    fn target(&self, p: &Player) -> [f64; 3] {
        let Some(l) = self.lv() else { return [0.0; 3] };
        if p.cp < l.cps.len() { l.cps[p.cp] } else { l.flag }
    }

    /// Standings. Race: finishers by time, then checkpoints, then distance to the
    /// next one; dropped players last. Co-op: by coins.
    pub fn order(&self) -> Vec<String> {
        let mut v: Vec<(&String, (i64, i64, i64, f64))> = self
            .players
            .iter()
            .map(|(u, p)| {
                let k = if self.coop() {
                    (if p.dnf { 1 } else { 0 }, -(p.got.len() as i64), p.slot as i64, 0.0)
                } else if let Some(f) = p.fin {
                    (0, f, 0, 0.0)
                } else {
                    let tg = self.target(p);
                    let d = ((p.x as f64 / 100.0 - tg[0]).powi(2) + (p.y as f64 / 100.0 - tg[1]).powi(2)
                        + (p.z as f64 / 100.0 - tg[2]).powi(2))
                    .sqrt();
                    (if p.dnf { 2 } else { 1 }, 0, -(p.cp as i64), (d * 1000.0).round_ties_even() / 1000.0)
                };
                (u, k)
            })
            .collect();
        v.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
        v.into_iter().map(|(u, _)| u.clone()).collect()
    }

    pub fn view(&self, t: f64) -> Value {
        let Some(l) = self.lv() else { return Value::Null };
        let order = self.order();
        let players: Vec<Value> = self
            .players
            .iter()
            .map(|(uid, p)| {
                let got: Vec<usize> = if self.coop() { Vec::new() } else { p.got.iter().copied().collect() };
                json!({"user": p.user, "slot": p.slot, "char": p.chr, "cp": p.cp, "coins": p.got.len(), "got": got,
                       "place": order.iter().position(|u| u == uid).unwrap_or(0) + 1, "fin": p.fin, "dnf": p.dnf,
                       "away": p.away, "x": p.x, "y": p.y, "z": p.z, "r": p.r})
            })
            .collect();
        json!({"level": self.level, "mode": self.mode, "phase": self.phase.as_str(),
               "goInMs": if self.phase == Phase::Grid { (((self.go_at - t) * 1000.0) as i64).max(0) } else { 0 },
               "runMs": if self.phase == Phase::Run { self.ms(t) } else { 0 },
               "limitMs": (self.limit() * 1000.0) as i64, "goal": l.goal, "taken": self.taken,
               "players": players, "results": self.results, "win": self.win, "chars": self.chars})
    }

    // -- ops --
    pub fn char(&mut self, uid: &str, msg: &Value) -> Option<i64> {
        let c = as_num(msg.get("char"), -1.0, CHARS as f64)?;
        if c != c.trunc() || !(0.0..CHARS as f64).contains(&c) {
            return None;
        }
        let c = c as i64;
        self.chars.insert(uid.to_string(), c);
        let phase = self.phase;
        if let Some(p) = self.player_mut(uid) {
            if matches!(phase, Phase::Idle | Phase::Grid | Phase::Done) {
                p.chr = c;
            }
        }
        Some(c)
    }

    pub fn start(&mut self, members: &[(String, Value)], level_id: &Value, mode: &Value, t: f64) -> Option<String> {
        if matches!(self.phase, Phase::Grid | Phase::Run) {
            return Some("a run is already on: the host can end it first".into());
        }
        let Some(l) = level_id.as_str().and_then(level) else { return Some("pick a level".into()) };
        let mode = match mode {
            Value::Null => "race",
            Value::String(s) if s == "race" || s == "coop" => s.as_str(),
            _ => return Some("pick race or co-op".into()),
        };
        self.level = Some(l.id.clone());
        self.mode = mode.to_string();
        self.phase = Phase::Grid;
        self.go_at = t + COUNTDOWN;
        self.first_at = None;
        self.results = None;
        self.win = None;
        self.taken = Vec::new();
        self.pending = Vec::new();
        self.players = Vec::new();
        for (k, (uid, pubv)) in members.iter().take(MAX_PLAYERS).enumerate() {
            let s = l.spawns[k % l.spawns.len()];
            self.players.push((uid.clone(), Player {
                user: pubv.clone(),
                slot: k,
                chr: self.chars.get(uid).copied().unwrap_or(k as i64 % CHARS),
                x: cm(s[0]),
                y: cm(s[1]),
                z: cm(s[2]),
                r: 0,
                a: 0,
                q: None,
                q0: 0,
                t0: t,
                at: t,
                base: s[1],
                air: None,
                safe: s,
                cp: 0,
                cp_at: Vec::new(),
                got: BTreeSet::new(),
                fin: None,
                dnf: false,
                away: None,
                told: false,
                bucket: (POS_BURST, t),
                fix_at: 0.0,
                spawn_at: -1.0,
                bad: 0,
                tp: false,
            }));
        }
        self.dirty = self.players.iter().map(|(u, _)| u.clone()).collect();
        self.order_sig = Vec::new();
        None
    }

    pub fn end(&mut self) {
        self.phase = Phase::Idle;
        self.players = Vec::new();
        self.results = None;
        self.first_at = None;
        self.pending = Vec::new();
    }

    fn mark_dirty(&mut self, uid: &str) {
        if !self.dirty.iter().any(|u| u == uid) {
            self.dirty.push(uid.to_string());
        }
    }

    fn place(p: &mut Player, at: [f64; 3]) {
        p.x = cm(at[0]);
        p.y = cm(at[1]);
        p.z = cm(at[2]);
        p.base = at[1];
        p.air = None;
        p.tp = true;
    }

    /// A position frame. Returns (accepted, correction to send back).
    pub fn pos(&mut self, uid: &str, msg: &Value, t: f64) -> (bool, Option<Value>) {
        let Some(l) = self.lv() else { return (false, None) };
        if self.phase != Phase::Run {
            return (false, None);
        }
        let Some(p) = self.player_mut(uid) else { return (false, None) };
        if p.fin.is_some() || p.dnf {
            return (false, None);
        }
        p.bucket.0 = POS_BURST.min(p.bucket.0 + (t - p.bucket.1) * POS_RATE);
        p.bucket.1 = t;
        if p.bucket.0 < 1.0 {
            return (false, None);
        }
        p.bucket.0 -= 1.0;
        let x = as_num(msg.get("x"), -1e7, 1e7);
        let y = as_num(msg.get("y"), -1e7, 1e7);
        let z = as_num(msg.get("z"), -1e7, 1e7);
        let r = as_num(msg.get("r"), -100000.0, 100000.0);
        let (Some(x), Some(y), Some(z), Some(r)) = (x, y, z, r) else { return (false, None) };
        let a = as_num(msg.get("a"), 0.0, ANIMS - 1.0);
        let q = as_num(msg.get("q"), 0.0, ((1i64 << 30) - 1) as f64).map(|q| q as i64);
        // Elapsed time on the sender's clock; an older frame is just stale, and the
        // clock may never run more than CLOCK_LEAD ahead of ours.
        let dt = match (q, p.q) {
            (Some(q), Some(pq)) => {
                if q <= pq {
                    return (false, None);
                }
                if (q - p.q0) as f64 / 100.0 > (t - p.t0) + CLOCK_LEAD { -1.0 } else { (q - pq) as f64 / 100.0 }
            }
            _ => (t - p.at).max(0.0),
        };
        let clock = q.map(|q| q as f64 / 100.0).unwrap_or(t);
        let (xm, ym, zm) = (x / 100.0, y / 100.0, z / 100.0);
        let (px, py, pz) = (p.x as f64 / 100.0, p.y as f64 / 100.0, p.z as f64 / 100.0);
        let b = l.bounds;
        let tau = p.air.map(|a| clock - a).unwrap_or(0.0);
        let ok = dt >= 0.0
            && b[0] <= xm && xm <= b[1] && b[2] <= ym && ym <= b[3] && b[4] <= zm && zm <= b[5]
            && (xm - px).hypot(zm - pz) <= MAX_RUN * dt + SLACK_H
            && ym - py <= MAX_RISE * dt + SLACK_V
            && py - ym <= MAX_FALL * dt + SLACK_V
            && ym - p.base <= lift_bound(tau)
            && !inside(l, xm, ym, zm);
        if !ok {
            p.bad += 1;
            if t - p.fix_at < FIX_GAP {
                return (false, None);
            }
            p.fix_at = t;
            let safe = p.safe;
            Self::place(p, safe);
            return (false, Some(json!({"x": p.x, "y": p.y, "z": p.z})));
        }
        if let Some(top) = support(l, xm, ym, zm, SUPPORT_M, SUPPORT_TOL) {
            p.base = top;
            p.air = Some(clock);
            if (ym - top).abs() < 0.08 {
                p.safe = [xm, top, zm];
            }
        } else if p.air.is_none() {
            p.air = Some(clock);
        }
        let a0 = [px, py + CENTER, pz];
        let a1 = [xm, ym + CENTER, zm];
        p.x = x as i64;
        p.y = y as i64;
        p.z = z as i64;
        p.r = (r as i64).rem_euclid(360);
        p.a = a.map(|a| a as i64).unwrap_or(0);
        if let (Some(q), None) = (q, p.q) {
            p.q0 = q;
            p.t0 = t;
        }
        p.q = q;
        p.at = t;
        self.mark_dirty(uid);
        self.reach(uid, l, a0, a1, t);
        (true, None)
    }

    /// What the move a0 -> a1 (the character's centre) touched.
    fn reach(&mut self, uid: &str, l: &Level, a0: [f64; 3], a1: [f64; 3], t: f64) {
        let ms = self.ms(t);
        let coop = self.coop();
        let mut evs: Vec<(&'static str, Value)> = Vec::new();
        let mut finished = false;
        let mut taken = std::mem::take(&mut self.taken);
        {
            let p = self.player_mut(uid).expect("a player");
            if p.cp < l.cps.len() {
                let c = l.cps[p.cp];
                if seg_dist(a0, a1, [c[0], c[1] + CENTER, c[2]]) <= CP_R {
                    p.cp += 1;
                    p.cp_at.push(ms);
                    p.safe = c;
                    evs.push(("cp", json!({"user": uid, "cp": p.cp, "ms": ms})));
                }
            }
            let lo = [a0[0].min(a1[0]) - COIN_R, a0[1].min(a1[1]) - COIN_R, a0[2].min(a1[2]) - COIN_R];
            let hi = [a0[0].max(a1[0]) + COIN_R, a0[1].max(a1[1]) + COIN_R, a0[2].max(a1[2]) + COIN_R];
            for (i, c) in l.coins.iter().enumerate() {
                if !(lo[0] <= c[0] && c[0] <= hi[0] && lo[1] <= c[1] && c[1] <= hi[1] && lo[2] <= c[2] && c[2] <= hi[2]) {
                    continue;
                }
                if (coop && taken.contains(&i)) || p.got.contains(&i) {
                    continue;
                }
                if seg_dist(a0, a1, *c) <= COIN_R {
                    p.got.insert(i);
                    let mut ev = json!({"user": uid, "id": i, "n": p.got.len()});
                    if coop {
                        taken.push(i);
                        ev["room"] = json!(taken.len());
                    }
                    evs.push(("coin", ev));
                }
            }
            if !coop && p.cp >= l.cps.len() {
                let fl = l.flag;
                if seg_dist(a0, a1, [fl[0], fl[1] + CENTER, fl[2]]) <= FLAG_R {
                    p.fin = Some(ms);
                    finished = true;
                }
            }
        }
        self.taken = taken;
        self.pending.extend(evs);
        if finished && self.first_at.is_none() {
            self.first_at = Some(t);
        }
    }

    /// Back to the last checkpoint passed (or the start) after a fall.
    pub fn respawn(&mut self, uid: &str, t: f64) -> Option<Value> {
        let l = self.lv()?;
        if self.phase != Phase::Run {
            return None;
        }
        let p = self.player_mut(uid)?;
        if p.fin.is_some() || p.dnf || t - p.spawn_at < RESPAWN_GAP {
            return None;
        }
        p.spawn_at = t;
        let at = if p.cp > 0 { l.cps[p.cp - 1] } else { l.spawns[p.slot % l.spawns.len()] };
        Self::place(p, at);
        p.safe = at;
        p.a = 0;
        let out = json!({"x": p.x, "y": p.y, "z": p.z, "cp": p.cp});
        self.mark_dirty(uid);
        Some(out)
    }

    fn results_now(&self) -> Value {
        let order = self.order();
        Value::Array(
            order
                .iter()
                .enumerate()
                .map(|(i, u)| {
                    let p = self.player(u).expect("ordered player");
                    if self.coop() {
                        json!({"user": p.user, "place": i + 1, "coins": p.got.len(), "dnf": p.dnf})
                    } else {
                        json!({"user": p.user, "place": i + 1, "ms": p.fin, "dnf": p.fin.is_none(),
                               "coins": p.got.len(), "cp": p.cp, "cps": p.cp_at})
                    }
                })
                .collect(),
        )
    }

    /// Advance the run clock; returns the events for the lobby, in order.
    pub fn tick(&mut self, t: f64, send: bool) -> Vec<(&'static str, Value)> {
        let mut evs = Vec::new();
        if self.phase == Phase::Grid && t >= self.go_at {
            self.phase = Phase::Run;
            for (_, p) in self.players.iter_mut() {
                p.at = t;
                p.bucket = (POS_BURST, t);
            }
            evs.push(("go", json!({"level": self.level, "mode": self.mode})));
        }
        if self.phase != Phase::Run {
            return evs;
        }
        evs.append(&mut self.pending);
        for i in 0..self.players.len() {
            let uid = self.players[i].0.clone();
            {
                let p = &mut self.players[i].1;
                if let Some(away) = p.away {
                    if !p.dnf && p.fin.is_none() && t - away >= GRACE {
                        p.dnf = true;
                        evs.push(("dnf", json!({"user": uid})));
                    }
                }
            }
            let p = &self.players[i].1;
            if let (Some(fin), false) = (p.fin, p.told) {
                let place = self.order().iter().position(|u| *u == uid).unwrap_or(0) + 1;
                evs.push(("finish", json!({"user": uid, "ms": fin, "place": place, "coins": p.got.len(),
                                           "cps": p.cp_at})));
                self.players[i].1.told = true;
            }
        }
        let l = self.lv();
        let active = self.players.iter().any(|(_, p)| p.fin.is_none() && !p.dnf);
        let mut over = t - self.go_at >= self.limit() || self.players.is_empty() || !active;
        if self.coop() {
            let win = l.map(|l| self.taken.len() as i64 >= l.goal).unwrap_or(false);
            self.win = Some(win);
            over = over || win;
        } else {
            over = over || self.first_at.map(|f| t - f >= FINISH_GRACE).unwrap_or(false);
        }
        if over {
            self.phase = Phase::Done;
            self.results = Some(self.results_now());
            let mut done = json!({"results": self.results, "level": self.level, "mode": self.mode});
            if self.coop() {
                done["win"] = json!(self.win.unwrap_or(false));
                done["total"] = json!(self.taken.len());
                done["goal"] = json!(l.map(|l| l.goal).unwrap_or(0));
                done["ms"] = json!(self.ms(t));
            }
            evs.push(("done", done));
            return evs;
        }
        let order = self.order();
        if send && (!self.dirty.is_empty() || order != self.order_sig) {
            let mut ps = Vec::new();
            let dirty = std::mem::take(&mut self.dirty);
            for (uid, p) in self.players.iter_mut() {
                if !dirty.contains(uid) {
                    continue;
                }
                let mut c = json!({"u": uid, "x": p.x, "y": p.y, "z": p.z, "r": p.r, "a": p.a, "cp": p.cp});
                if let Some(q) = p.q {
                    c["q"] = json!(q);
                }
                if p.tp {
                    c["tp"] = json!(1);
                    p.tp = false;
                }
                ps.push(c);
            }
            evs.push(("snap", json!({"ms": self.ms(t), "ps": ps, "order": order})));
            self.order_sig = order;
        }
        evs
    }

    pub fn running(&self) -> bool {
        matches!(self.phase, Phase::Grid | Phase::Run)
    }

    pub fn drop(&mut self, uid: &str, t: f64, blip: bool) -> bool {
        let phase = self.phase;
        let Some(p) = self.player_mut(uid) else { return false };
        if phase == Phase::Run && p.fin.is_none() && !p.dnf {
            if blip {
                p.away = Some(t);
            } else {
                p.dnf = true;
            }
            return true;
        }
        if phase == Phase::Grid {
            self.players.retain(|(u, _)| u != uid);
        }
        true
    }

    pub fn restore(&mut self, uid: &str, pubv: Value) -> bool {
        let Some(p) = self.player_mut(uid) else { return false };
        if p.away.is_none() || p.dnf {
            return false;
        }
        p.away = None;
        p.user = pubv;
        p.q = None;
        p.bucket = (POS_BURST, p.at);
        true
    }
}

// ------------------------------------------------------------------- lobby --
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

/// One room's platformer state: the lobby and the run.
#[derive(Debug, Default)]
pub struct PlatRoom {
    pub lobby: Lobby,
    pub plat: Plat,
}

/// The platformer for every room: lobby, referee and the per-room tick loop.
#[derive(Clone)]
pub struct PlatHub {
    inner: Arc<HubInner>,
}

struct HubInner {
    rooms: RoomManager,
    reg: Arc<Registry>,
    clock: Clock,
    /// Where a finished game is written down. Empty in the unit tests.
    results: Recorder,
    state: Mutex<HashMap<String, PlatRoom>>,
}

fn tick_key(room_id: &str) -> String {
    format!("plat:{room_id}")
}

impl PlatHub {
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

    pub fn with_room<R>(&self, room_id: &str, f: impl FnOnce(&mut PlatRoom) -> R) -> Option<R> {
        self.inner.state.lock().unwrap().get_mut(room_id).map(f)
    }

    /// A `{"type": "game", "g": "plat", ...}` message from one socket.
    pub async fn handle(&self, room_id: &str, conn: u64, member: &Member, msg: &Value) {
        let op = msg.get("op").and_then(Value::as_str);
        let mut out = Out::new(GAME);
        let Some(op) = op else {
            out.err(conn, "unknown game");
            self.flush(room_id, out).await;
            return;
        };
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
                        out.push(To::All, "lobby", json!({"members": lobby.roster(), "joined": joined, "name": GAME_NAME}));
                        if v.plat.restore(uid, member.public()) {
                            out.push(To::Users(v.lobby.ids(), None), "plat", json!({"run": v.plat.view(t), "back": uid}));
                        } else {
                            out.push(To::Conn(conn), "plat", json!({"run": v.plat.view(t)}));
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
                _ => self.plat_op(room_id, v, conn, member, op, msg, &mut out, t),
            }
        }
        if let Some(to) = invite {
            let payload = json!({"type": "game", "g": GAME, "ev": "invite", "pv": crate::protocol::version(GAME), "from": member.public(),
                                 "room": room_id, "name": GAME_NAME});
            let delivered = self.inner.rooms.deliver_to_user(&to, payload.to_string()).await;
            out.push(To::Conn(conn), "invited", json!({"to": to, "delivered": delivered}));
        }
        self.flush(room_id, out).await;
    }

    #[allow(clippy::too_many_arguments)]
    fn plat_op(&self, room_id: &str, v: &mut PlatRoom, conn: u64, member: &Member, op: &str, msg: &Value,
               out: &mut Out, t: f64) {
        let uid = member.user_id.as_str();
        let ids = v.lobby.ids();
        let pm = &mut v.plat;
        match op {
            "pos" => {
                if let (_, Some(fix)) = pm.pos(uid, msg, t) {
                    out.push(To::Conn(conn), "fix", fix);
                }
            }
            "respawn" => {
                if let Some(sp) = pm.respawn(uid, t) {
                    out.push(To::Conn(conn), "spawn", sp);
                }
            }
            "view" => out.push(To::Conn(conn), "plat", json!({"run": pm.view(t)})),
            "char" => match pm.char(uid, msg) {
                None => out.err(conn, "pick a character"),
                Some(c) => out.push(To::Users(ids, None), "char", json!({"user": uid, "char": c})),
            },
            "start" | "end" => {
                if v.lobby.host.as_deref() != Some(uid) {
                    out.err(conn, "only the host can do that");
                    return;
                }
                v.lobby.prev_host = None;
                let pm = &mut v.plat;
                if op == "start" {
                    let null = Value::Null;
                    let mut err = pm.start(&v.lobby.members, msg.get("level").unwrap_or(&null),
                                           msg.get("mode").unwrap_or(&null), t);
                    if err.is_none() && !self.tick_on(room_id) {
                        pm.end();
                        err = Some("the Arena is busy right now: try again in a minute".into());
                    }
                    match err {
                        Some(e) => out.err(conn, &e),
                        None => out.push(To::Users(ids, None), "plat", json!({"run": pm.view(t), "by": member.public()})),
                    }
                } else {
                    pm.end();
                    self.inner.reg.stop(&tick_key(room_id));
                    out.push(To::Users(ids, None), "plat", json!({"run": pm.view(t)}));
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
            if !v.plat.running() {
                return false;
            }
            let mut ids = v.lobby.ids();
            for (u, _) in &v.plat.players {
                if !v.lobby.has(u) {
                    ids.push(u.clone());
                }
            }
            let mut out = Out::new(GAME);
            for (ev, data) in v.plat.tick(t, send) {
                out.push(To::Users(ids.clone(), None), ev, data);
            }
            let running = v.plat.running();
            if !running {
                out.push(To::Users(ids.clone(), None), "plat", json!({"run": v.plat.view(t)}));
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
    /// the lobby as a dropped socket (blip). Call before `RoomManager::leave`.
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

fn leave_lobby(v: &mut PlatRoom, uid: &str, out: &mut Out, disconnected: bool, t: f64) {
    let lobby = &mut v.lobby;
    let Some(who) = lobby_pop(lobby, uid) else { return };
    if disconnected {
        lobby.blips.insert(uid.to_string(), t);
    }
    if lobby.host.as_deref() == Some(uid) {
        lobby.host = lobby.members.first().map(|(u, _)| u.clone());
        lobby.prev_host = if disconnected && lobby.host.is_some() { Some((uid.to_string(), t)) } else { None };
    }
    if v.plat.drop(uid, t, disconnected) {
        out.push(To::Users(v.lobby.ids(), None), "plat", json!({"run": v.plat.view(t), "left": uid}));
    }
    out.push(To::All, "lobby", json!({"members": v.lobby.roster(), "left": who, "name": GAME_NAME}));
}

#[cfg(test)]
mod tests;
