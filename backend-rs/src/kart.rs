//! Kart Racing for the Valley (g = "kart"): the tracks, the grid, the race
//! referee and the game's lobby. A port of `backend/app/kart.py` plus the kart
//! branch of `backend/app/valley.py` (Rust has no other Valley games yet).
//!
//! Each player drives their own car in the browser (games/kart.js) and streams
//! where it is; the server runs a fixed-rate tick (`realtime.rs`) that checks
//! every position, keeps the standings and sends one batched snapshot to the
//! lobby per tick. The server does not simulate the cars: it checks that each
//! move is on the road and no faster than a car can go, counts laps in order
//! around the track, and times the finish.
//!
//! Tracks are compiled from `backend/app/kart_tracks.json`, embedded at build
//! time with `include_str!` -- the same file the Python reads (itself a byte
//! copy of games/kart/tracks.json), so there is no third copy to drift. A track
//! is a loop of 10 m tiles written as letters from the start line, driving
//! north first: F the finish straight, S a straight, L/R a 90-degree corner. A
//! straight's road is 9 m wide between its barriers; a corner is a quarter ring
//! around the tile corner it turns about, from radius 0.5 to 9.5 m (centre line 5 m).
//!
//! Units on the wire: x, z in centimetres, yaw in whole degrees, speed in
//! decimetres/s, the sender's clock in centiseconds (q).
//!
//! Protocol: in `{"type":"game","g":"kart","op":...}`, out
//! `{"type":"game","g":"kart","ev":...}`. Ops: join, leave, invite, view, car,
//! start, end, pos. Events: lobby, kart, car, go, snap, fix, finish, dnf, done,
//! invite, invited, error.

// point_at / on_road / Track::name are the geometry API the tests (and the
// Python's) drive the referee with; the server itself only needs locate.
#![cfg_attr(not(test), allow(dead_code))]

use crate::realtime::{Clock, Registry, Ticker};
use crate::rooms::{Member, RoomManager};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, LazyLock, Mutex};

pub const TILE: f64 = 10.0;
pub const HALF: f64 = TILE / 2.0;
pub const ROAD_HALF: f64 = 4.5; // straight: road from -4.5 to 4.5 m across
#[allow(dead_code)] // documents the corner ring (inner edge); the referee bounds by ROAD_HALF
pub const R_IN: f64 = 0.5;
pub const R_MID: f64 = 5.0;
#[allow(dead_code)]
pub const R_OUT: f64 = 9.5;
pub const MARGIN: f64 = 1.2; // off the road by more than this (m): not a real position
pub const MAX_SPEED: f64 = 30.0; // m/s; the browser's car tops out at 26
pub const SLACK: f64 = 2.5; // m allowed on top of MAX_SPEED x dt (bunched frames)
pub const CLOCK_LEAD: f64 = 0.6; // s a sender's clock may run ahead of ours, summed over the race
pub const MAX_STEP_TILES: f64 = 3.0; // one update may move the track distance at most this far
pub const HZ: f64 = 15.0; // server ticks per second while a race is on
pub const COUNTDOWN: f64 = 4.0; // seconds from "start" to "go"
pub const FINISH_GRACE: f64 = 30.0; // after the winner crosses the line, the rest get this long
pub const MAX_RACE: f64 = 600.0; // a race is called after 10 minutes whatever happens
pub const GRACE: f64 = 20.0; // a dropped racer's car waits this long for a rejoin
pub const POS_RATE: f64 = 25.0; // position frames per second per player (clients send 20)
pub const POS_BURST: f64 = 10.0;
pub const FIX_GAP: f64 = 0.5; // at most one "back to the road" correction per this long
pub const MAX_PLAYERS: usize = 8;
pub const CARS: i64 = 5; // four trucks and a motorcycle
pub const MIN_LAPS: f64 = 1.0;
pub const MAX_LAPS: f64 = 5.0;
/// Headings: north (-z), east, south, west.
pub const DIRS: [(i64, i64); 4] = [(0, -1), (1, 0), (0, 1), (-1, 0)];

// Lobby (valley.py)
pub const GAME: &str = "kart";
pub const GAME_NAME: &str = "Kart Racing";
pub const MAX_LOBBY: usize = 8;
/// A host back from a socket drop this soon is host again (valley.HOST_GRACE = golf.GRACE).
pub const HOST_GRACE: f64 = 15.0;

pub const TRACKS_JSON: &str = include_str!("../../backend/app/kart_tracks.json");

// ------------------------------------------------------------------ tracks --
#[derive(Clone, Debug, PartialEq)]
pub struct Tile {
    pub col: i64,
    pub row: i64,
    /// 'F', 'S' or 'C' (a corner).
    pub kind: char,
    /// Heading the tile is entered with.
    pub d: usize,
    /// Heading it is left with.
    pub o: usize,
    /// A corner's pivot, tile-local.
    pub pivot: Option<(f64, f64)>,
}

#[derive(Clone, Debug)]
pub struct Track {
    pub id: String,
    pub name: String,
    pub laps: i64,
    pub tiles: Vec<Tile>,
    pub cells: HashMap<(i64, i64), usize>,
    pub n: usize,
}

/// The tile loop for a path string: cells in order, each with its kind, the
/// heading it is entered with (d) and left with (o), and a corner's pivot.
pub fn compile_track(path: &str) -> Result<(Vec<Tile>, HashMap<(i64, i64), usize>), String> {
    let (mut col, mut row) = (0i64, 0i64);
    let mut d = 0usize;
    let mut tiles = Vec::new();
    let mut cells = HashMap::new();
    for (i, ch) in path.chars().enumerate() {
        if !"FSLR".contains(ch) || cells.contains_key(&(col, row)) {
            return Err(format!("bad track at tile {i}"));
        }
        let o = match ch {
            'R' => (d + 1) % 4,
            'L' => (d + 3) % 4,
            _ => d,
        };
        let corner = ch == 'L' || ch == 'R';
        let pivot = corner.then(|| {
            let (ex, ez) = DIRS[(d + 2) % 4]; // the side we came in through
            let (ox, oz) = DIRS[o]; // the side we leave by
            ((ex + ox) as f64 * HALF, (ez + oz) as f64 * HALF)
        });
        cells.insert((col, row), i);
        tiles.push(Tile { col, row, kind: if corner { 'C' } else { ch }, d, o, pivot });
        d = o;
        col += DIRS[d].0;
        row += DIRS[d].1;
    }
    if (col, row) != (0, 0) || d != 0 || !path.starts_with('F') {
        return Err("track does not close on its start line".into());
    }
    Ok((tiles, cells))
}

pub static TRACKS: LazyLock<Vec<Track>> = LazyLock::new(|| {
    let data: Value = serde_json::from_str(TRACKS_JSON).expect("kart_tracks.json parses");
    data["tracks"]
        .as_array()
        .expect("kart_tracks.json has tracks")
        .iter()
        .map(|t| {
            let path = t["path"].as_str().expect("track path");
            let (tiles, cells) = compile_track(path).expect("track compiles");
            Track {
                id: t["id"].as_str().expect("track id").to_string(),
                name: t["name"].as_str().unwrap_or("").to_string(),
                laps: t.get("laps").and_then(Value::as_f64).map(|l| l as i64).unwrap_or(3),
                n: tiles.len(),
                tiles,
                cells,
            }
        })
        .collect()
});

pub fn track(id: &str) -> Option<&'static Track> {
    TRACKS.iter().find(|t| t.id == id)
}

pub fn cell_of(v: f64) -> i64 {
    ((v + HALF) / TILE).floor() as i64
}

/// (tile index, distance along it 0..1, metres off the centre line) for a point
/// on the track's tiles, else None.
pub fn locate(tr: &Track, x: f64, z: f64) -> Option<(usize, f64, f64)> {
    let i = *tr.cells.get(&(cell_of(x), cell_of(z)))?;
    let t = &tr.tiles[i];
    let (lx, lz) = (x - t.col as f64 * TILE, z - t.row as f64 * TILE);
    let Some((px, pz)) = t.pivot else {
        let (hx, hz) = (DIRS[t.d].0 as f64, DIRS[t.d].1 as f64);
        let along = lx * hx + lz * hz;
        let lat = lx * -hz + lz * hx;
        return Some((i, ((along + HALF) / TILE).clamp(0.0, 1.0), lat));
    };
    let (vx, vz) = (lx - px, lz - pz);
    let r = vx.hypot(vz);
    let (ax, az) = (-DIRS[t.o].0 as f64, -DIRS[t.o].1 as f64); // pivot -> entry edge
    let ang = (ax * vz - az * vx).atan2(ax * vx + az * vz).abs();
    Some((i, (ang / (std::f64::consts::PI / 2.0)).clamp(0.0, 1.0), r - R_MID))
}

/// (x, z, yaw in degrees) at track distance u (tiles from the start of tile 0,
/// any lap), `lat` metres right of the centre line. Yaw 0 = north (-z), 90 = east.
pub fn point_at(tr: &Track, u: f64, lat: f64) -> (f64, f64, f64) {
    let n = tr.n;
    let w = u.rem_euclid(n as f64);
    let i = (n - 1).min(w as usize);
    let s = w - i as f64;
    let t = &tr.tiles[i];
    let (cx, cz) = (t.col as f64 * TILE, t.row as f64 * TILE);
    let Some((px, pz)) = t.pivot else {
        let (hx, hz) = (DIRS[t.d].0 as f64, DIRS[t.d].1 as f64);
        let x = cx + hx * (s * TILE - HALF) - hz * lat;
        let z = cz + hz * (s * TILE - HALF) + hx * lat;
        return (x, z, hx.atan2(-hz).to_degrees().rem_euclid(360.0));
    };
    let (a0x, a0z) = (-DIRS[t.o].0 as f64, -DIRS[t.o].1 as f64);
    let (a1x, a1z) = (DIRS[t.d].0 as f64, DIRS[t.d].1 as f64);
    let th = s * std::f64::consts::PI / 2.0;
    let turn = if t.o == (t.d + 1) % 4 { 1.0 } else { -1.0 }; // right turns: "right" is towards the pivot
    let rad = R_MID - lat * turn;
    let (vx, vz) = (a0x * th.cos() + a1x * th.sin(), a0z * th.cos() + a1z * th.sin());
    let (tx, tz) = (-a0x * th.sin() + a1x * th.cos(), -a0z * th.sin() + a1z * th.cos());
    (cx + px + vx * rad, cz + pz + vz * rad, tx.atan2(-tz).to_degrees().rem_euclid(360.0))
}

pub fn on_road(tr: &Track, x: f64, z: f64, margin: f64) -> bool {
    locate(tr, x, z).map(|l| l.2.abs() <= ROAD_HALF + margin).unwrap_or(false)
}

/// Start position k (0 = pole) behind the line in the middle of tile 0, two
/// abreast, facing north. The line is at z = 0; the grid runs back into the tile behind it.
pub fn grid_slot(_tr: &Track, k: usize) -> (f64, f64) {
    let x = if k % 2 == 0 { -2.0 } else { 2.0 };
    (x, 3.0 + (k / 2) as f64 * 3.2 + if k % 2 == 1 { 1.6 } else { 0.0 })
}

/// A finite JSON number (not a bool), clamped to [lo, hi].
pub fn as_num(v: Option<&Value>, lo: f64, hi: f64) -> Option<f64> {
    let f = v?.as_number()?.as_f64()?;
    if !f.is_finite() {
        return None;
    }
    Some(f.max(lo).min(hi))
}

/// Python truthiness of a JSON value.
fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().map(|f| f != 0.0).unwrap_or(true),
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(a)) => !a.is_empty(),
        Some(Value::Object(o)) => !o.is_empty(),
    }
}

// ----------------------------------------------------------------- referee --
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Idle,
    Grid,
    Race,
    Done,
}

impl Phase {
    pub fn as_str(self) -> &'static str {
        match self {
            Phase::Idle => "idle",
            Phase::Grid => "grid",
            Phase::Race => "race",
            Phase::Done => "done",
        }
    }
}

#[derive(Clone, Debug)]
pub struct Player {
    pub user: Value,
    pub slot: usize,
    pub car: i64,
    pub x: i64,
    pub z: i64,
    pub r: i64,
    pub s: i64,
    pub dr: i64,
    /// The sender's clock (centiseconds) on the last frame taken.
    pub q: Option<i64>,
    pub q0: i64,
    pub t0: f64,
    /// Unwrapped track distance in tiles.
    pub u: f64,
    pub at: f64,
    pub lap_at: Vec<i64>,
    pub fin: Option<i64>,
    pub dnf: bool,
    pub away: Option<f64>,
    /// (tokens, last refill)
    pub bucket: (f64, f64),
    pub fix_at: f64,
    pub bad: u32,
    pub told: bool,
}

fn lap_of_u(u: f64, laps: i64, n: usize) -> i64 {
    (((u - 0.5) / n as f64).floor() as i64 + 1).min(laps).max(1)
}

/// One room's race. idle -> grid (countdown) -> race -> done; the host starts
/// the next one from done or idle.
#[derive(Debug)]
pub struct Kart {
    pub track: Option<String>,
    pub laps: i64,
    pub phase: Phase,
    pub go_at: f64,
    pub first_at: Option<f64>, // when the winner finished
    pub players: Vec<(String, Player)>, // in grid order
    pub cars: BTreeMap<String, i64>, // user_id -> vehicle, kept between races
    pub results: Option<Value>,
    pub dirty: Vec<String>, // a set, kept in insertion order
    pub order_sig: Vec<String>,
}

impl Default for Kart {
    fn default() -> Self {
        Self::new()
    }
}

impl Kart {
    pub fn new() -> Self {
        Self {
            track: None,
            laps: 3,
            phase: Phase::Idle,
            go_at: 0.0,
            first_at: None,
            players: Vec::new(),
            cars: BTreeMap::new(),
            results: None,
            dirty: Vec::new(),
            order_sig: Vec::new(),
        }
    }

    // -- views --
    pub fn tr(&self) -> Option<&'static Track> {
        self.track.as_deref().and_then(track)
    }

    pub fn player(&self, uid: &str) -> Option<&Player> {
        self.players.iter().find(|(u, _)| u == uid).map(|(_, p)| p)
    }

    fn player_mut(&mut self, uid: &str) -> Option<&mut Player> {
        self.players.iter_mut().find(|(u, _)| u == uid).map(|(_, p)| p)
    }

    pub fn ms(&self, t: f64) -> i64 {
        ((t - self.go_at) * 1000.0).round_ties_even().max(0.0) as i64
    }

    pub fn lap_of(&self, p: &Player) -> i64 {
        lap_of_u(p.u, self.laps, self.tr().map(|t| t.n).unwrap_or(1))
    }

    /// Standings: finishers by time, then by distance covered, dropped racers last.
    pub fn order(&self) -> Vec<String> {
        fn key(p: &Player) -> (i32, i64, f64) {
            match p.fin {
                Some(f) => (0, f, 0.0),
                None => (if p.dnf { 2 } else { 1 }, 0, -p.u),
            }
        }
        let mut v: Vec<&(String, Player)> = self.players.iter().collect();
        v.sort_by(|a, b| key(&a.1).partial_cmp(&key(&b.1)).unwrap_or(std::cmp::Ordering::Equal));
        v.into_iter().map(|(u, _)| u.clone()).collect()
    }

    pub fn view(&self, t: f64) -> Value {
        let Some(track) = &self.track else { return Value::Null };
        let order = self.order();
        let players: Vec<Value> = self
            .players
            .iter()
            .map(|(uid, p)| {
                json!({"user": p.user, "slot": p.slot, "car": p.car, "lap": self.lap_of(p),
                       "place": order.iter().position(|u| u == uid).unwrap_or(0) + 1,
                       "fin": p.fin, "dnf": p.dnf, "away": p.away, "x": p.x, "z": p.z, "r": p.r})
            })
            .collect();
        json!({"track": track, "laps": self.laps, "phase": self.phase.as_str(),
               "goInMs": if self.phase == Phase::Grid { (((self.go_at - t) * 1000.0) as i64).max(0) } else { 0 },
               "raceMs": if self.phase == Phase::Race { self.ms(t) } else { 0 },
               "players": players, "results": self.results, "cars": self.cars})
    }

    // -- ops --
    pub fn car(&mut self, uid: &str, msg: &Value) -> Option<i64> {
        let c = as_num(msg.get("car"), -1.0, CARS as f64)?;
        if c != c.trunc() || !(0.0..CARS as f64).contains(&c) {
            return None;
        }
        let c = c as i64;
        self.cars.insert(uid.to_string(), c);
        let phase = self.phase;
        if let Some(p) = self.player_mut(uid) {
            if matches!(phase, Phase::Idle | Phase::Grid | Phase::Done) {
                p.car = c;
            }
        }
        Some(c)
    }

    /// `members`: the lobby in join order. Returns an error for the host, or None.
    pub fn start(&mut self, members: &[(String, Value)], track_id: &Value, laps: &Value, t: f64)
        -> Option<String>
    {
        if matches!(self.phase, Phase::Grid | Phase::Race) {
            return Some("a race is already on: the host can end it first".into());
        }
        let Some(tr) = track_id.as_str().and_then(track) else {
            return Some("pick a track".into());
        };
        let n_laps = as_num(Some(laps), MIN_LAPS, MAX_LAPS);
        self.track = Some(tr.id.clone());
        self.laps = n_laps.map(|l| l as i64).unwrap_or(tr.laps);
        self.phase = Phase::Grid;
        self.go_at = t + COUNTDOWN;
        self.first_at = None;
        self.results = None;
        self.players = Vec::new();
        for (k, (uid, pubv)) in members.iter().take(MAX_PLAYERS).enumerate() {
            let (gx, gz) = grid_slot(tr, k);
            self.players.push((uid.clone(), Player {
                user: pubv.clone(),
                slot: k,
                car: self.cars.get(uid).copied().unwrap_or(k as i64 % CARS),
                x: (gx * 100.0) as i64,
                z: (gz * 100.0) as i64,
                r: 0,
                s: 0,
                dr: 0,
                q: None,
                q0: 0,
                t0: t,
                u: 0.5 - gz / TILE,
                at: t,
                lap_at: Vec::new(),
                fin: None,
                dnf: false,
                away: None,
                bucket: (POS_BURST, t),
                fix_at: 0.0,
                bad: 0,
                told: false,
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
    }

    fn mark_dirty(&mut self, uid: &str) {
        if !self.dirty.iter().any(|u| u == uid) {
            self.dirty.push(uid.to_string());
        }
    }

    /// A position frame from a driver. Returns (accepted, correction to send back).
    /// Before the green light, and after you finish, frames are ignored.
    pub fn pos(&mut self, uid: &str, msg: &Value, t: f64) -> (bool, Option<Value>) {
        let Some(tr) = self.tr() else { return (false, None) };
        if self.phase != Phase::Race {
            return (false, None);
        }
        let (laps, go_at) = (self.laps, self.go_at);
        let ms = |t: f64| ((t - go_at) * 1000.0).round_ties_even().max(0.0) as i64;
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
        let z = as_num(msg.get("z"), -1e7, 1e7);
        let r = as_num(msg.get("r"), -100000.0, 100000.0);
        let s = as_num(msg.get("s"), -1000.0, 1000.0);
        let (Some(x), Some(z), Some(r)) = (x, z, r) else { return (false, None) };
        let q = as_num(msg.get("q"), 0.0, ((1i64 << 30) - 1) as f64).map(|q| q as i64);
        // Elapsed time between this frame and the last one we took. Frames arrive
        // bunched and out of order (jitter), so the sender's own clock (q,
        // centiseconds) is the honest measure; an older frame than the last one
        // taken is just stale. A client can't buy speed by running its clock fast:
        // since its first frame, its clock may never get more than CLOCK_LEAD
        // seconds ahead of ours.
        let dt = match (q, p.q) {
            (Some(q), Some(pq)) => {
                if q <= pq {
                    return (false, None);
                }
                if (q - p.q0) as f64 / 100.0 > (t - p.t0) + CLOCK_LEAD {
                    -1.0
                } else {
                    (q - pq) as f64 / 100.0
                }
            }
            _ => (t - p.at).max(0.0),
        };
        let (xm, zm) = (x / 100.0, z / 100.0);
        let loc = locate(tr, xm, zm);
        let moved = (xm - p.x as f64 / 100.0).hypot(zm - p.z as f64 / 100.0);
        let mut delta = 0.0;
        let mut ok = dt >= 0.0
            && loc.map(|l| l.2.abs() <= ROAD_HALF + MARGIN).unwrap_or(false)
            && moved <= MAX_SPEED * dt + SLACK;
        if ok {
            let n = tr.n as f64;
            let (i, along, _) = loc.unwrap();
            delta = (i as f64 + along - p.u).rem_euclid(n);
            if delta >= n / 2.0 {
                delta -= n;
            }
            ok = delta.abs() <= MAX_STEP_TILES;
        }
        if !ok {
            p.bad += 1;
            if t - p.fix_at < FIX_GAP {
                return (false, None);
            }
            p.fix_at = t;
            return (false, Some(json!({"x": p.x, "z": p.z, "r": p.r})));
        }
        let before = lap_of_u(p.u, laps, tr.n);
        p.u += delta;
        p.x = x as i64;
        p.z = z as i64;
        p.r = (r as i64).rem_euclid(360);
        p.s = s.map(|s| s as i64).unwrap_or(0);
        p.dr = if truthy(msg.get("dr")) { 1 } else { 0 };
        if let (Some(q), None) = (q, p.q) {
            p.q0 = q;
            p.t0 = t;
        }
        p.q = q;
        p.at = t;
        let after = lap_of_u(p.u, laps, tr.n);
        if after > before {
            p.lap_at.push(ms(t));
        }
        let mut finished = false;
        if p.u >= 0.5 + (laps as usize * tr.n) as f64 {
            let f = ms(t);
            p.fin = Some(f);
            p.lap_at.push(f);
            finished = true;
        }
        self.mark_dirty(uid);
        if finished && self.first_at.is_none() {
            self.first_at = Some(t);
        }
        (true, None)
    }

    /// Advance the race clock; returns the events for the lobby, in order.
    pub fn tick(&mut self, t: f64, send: bool) -> Vec<(&'static str, Value)> {
        let mut evs = Vec::new();
        if self.phase == Phase::Grid && t >= self.go_at {
            self.phase = Phase::Race;
            for (_, p) in self.players.iter_mut() {
                p.at = t;
                p.bucket = (POS_BURST, t);
            }
            evs.push(("go", json!({"track": self.track})));
        }
        if self.phase != Phase::Race {
            return evs;
        }
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
                evs.push(("finish", json!({"user": uid, "ms": fin, "place": place, "laps": p.lap_at})));
                self.players[i].1.told = true;
            }
        }
        let racing = self.players.iter().any(|(_, p)| p.fin.is_none() && !p.dnf);
        let late = self.first_at.map(|f| t - f >= FINISH_GRACE).unwrap_or(false);
        if !racing || late || t - self.go_at >= MAX_RACE || self.players.is_empty() {
            self.phase = Phase::Done;
            let order = self.order();
            let results: Vec<Value> = order
                .iter()
                .enumerate()
                .map(|(i, u)| {
                    let p = self.player(u).expect("ordered player");
                    json!({"user": p.user, "place": i + 1, "ms": p.fin, "dnf": p.fin.is_none(),
                           "laps": p.lap_at})
                })
                .collect();
            self.results = Some(Value::Array(results));
            evs.push(("done", json!({"results": self.results, "track": self.track})));
            return evs;
        }
        let order = self.order();
        if send && (!self.dirty.is_empty() || order != self.order_sig) {
            let mut cars = Vec::new();
            for (uid, p) in &self.players {
                if !self.dirty.contains(uid) {
                    continue;
                }
                let mut c = json!({"u": uid, "x": p.x, "z": p.z, "r": p.r, "s": p.s, "lap": self.lap_of(p)});
                if p.dr != 0 {
                    c["dr"] = json!(1);
                }
                if let Some(q) = p.q {
                    c["q"] = json!(q);
                }
                cars.push(c);
            }
            evs.push(("snap", json!({"ms": self.ms(t), "cars": cars, "order": order})));
            self.dirty.clear();
            self.order_sig = order;
        }
        evs
    }

    pub fn running(&self) -> bool {
        matches!(self.phase, Phase::Grid | Phase::Race)
    }

    /// A racer left. Mid-race a dropped socket (blip) keeps their car on track for
    /// GRACE seconds; an explicit leave is a DNF. On the grid they just go.
    pub fn drop(&mut self, uid: &str, t: f64, blip: bool) -> bool {
        let phase = self.phase;
        let Some(p) = self.player_mut(uid) else { return false };
        if phase == Phase::Race && p.fin.is_none() && !p.dnf {
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
        p.q = None; // a reloaded page starts a new clock
        p.bucket = (POS_BURST, p.at);
        true
    }
}

// ------------------------------------------------------------------- lobby --
#[derive(Debug, Default)]
pub struct Lobby {
    /// user_id -> public profile, in join order.
    pub members: Vec<(String, Value)>,
    pub host: Option<String>,
    /// (user_id, when) of a host whose socket dropped: a quick rejoin takes the host back.
    pub prev_host: Option<(String, f64)>,
    /// user_id -> when their socket dropped: a quick rejoin is a reconnect, not a "joined" toast.
    pub blips: HashMap<String, f64>,
}

impl Lobby {
    pub fn has(&self, uid: &str) -> bool {
        self.members.iter().any(|(u, _)| u == uid)
    }

    pub fn ids(&self) -> Vec<String> {
        self.members.iter().map(|(u, _)| u.clone()).collect()
    }

    pub fn roster(&self) -> Value {
        Value::Array(
            self.members
                .iter()
                .map(|(uid, p)| {
                    let mut p = p.clone();
                    if let Some(o) = p.as_object_mut() {
                        o.insert("host".into(), json!(self.host.as_deref() == Some(uid)));
                    }
                    p
                })
                .collect(),
        )
    }

    fn put(&mut self, uid: &str, pubv: Value) {
        match self.members.iter_mut().find(|(u, _)| u == uid) {
            Some(slot) => slot.1 = pubv,
            None => self.members.push((uid.to_string(), pubv)),
        }
    }

    fn pop(&mut self, uid: &str) -> Option<Value> {
        let i = self.members.iter().position(|(u, _)| u == uid)?;
        Some(self.members.remove(i).1)
    }
}

/// One room's kart state: the lobby and the race.
#[derive(Debug, Default)]
pub struct KartRoom {
    pub lobby: Lobby,
    pub kart: Kart,
}

/// Who a message goes to.
#[derive(Debug, Clone)]
pub enum To {
    /// Every socket in the room.
    All,
    /// One socket.
    Conn(u64),
    /// The sockets of these users, optionally not back to one user.
    Users(Vec<String>, Option<String>),
}

/// Messages to send after a rule ran (valley.Out).
#[derive(Debug, Default)]
pub struct Out {
    pub g: String,
    pub items: Vec<(To, Value)>,
}

impl Out {
    pub fn new(g: &str) -> Self {
        Self { g: g.to_string(), items: Vec::new() }
    }

    fn msg(&self, ev: &str, data: Value) -> Value {
        let mut m = Map::new();
        m.insert("type".into(), json!("game"));
        m.insert("g".into(), json!(self.g));
        m.insert("ev".into(), json!(ev));
        if let Value::Object(d) = data {
            m.extend(d);
        }
        Value::Object(m)
    }

    pub fn push(&mut self, to: To, ev: &str, data: Value) {
        let m = self.msg(ev, data);
        self.items.push((to, m));
    }

    pub fn err(&mut self, conn: u64, error: &str) {
        self.push(To::Conn(conn), "error", json!({"error": error}));
    }
}

/// The kart game for every room: lobby, referee and the per-room tick loop.
#[derive(Clone)]
pub struct KartHub {
    inner: Arc<HubInner>,
}

struct HubInner {
    rooms: RoomManager,
    reg: Arc<Registry>,
    clock: Clock,
    state: Mutex<HashMap<String, KartRoom>>,
}

fn tick_key(room_id: &str) -> String {
    format!("kart:{room_id}")
}

impl KartHub {
    pub fn new(rooms: RoomManager, reg: Arc<Registry>, clock: Clock) -> Self {
        Self { inner: Arc::new(HubInner { rooms, reg, clock, state: Mutex::new(HashMap::new()) }) }
    }

    pub fn now(&self) -> f64 {
        (self.inner.clock)()
    }

    pub fn registry(&self) -> &Arc<Registry> {
        &self.inner.reg
    }

    /// Look at (or change) a room's kart state, if it has any.
    pub fn with_room<R>(&self, room_id: &str, f: impl FnOnce(&mut KartRoom) -> R) -> Option<R> {
        self.inner.state.lock().unwrap().get_mut(room_id).map(f)
    }

    /// A `{"type": "game", ...}` message from one socket.
    pub async fn handle(&self, room_id: &str, conn: u64, member: &Member, msg: &Value) {
        let g = msg.get("g").and_then(Value::as_str);
        let op = msg.get("op").and_then(Value::as_str);
        let (Some(GAME), Some(op)) = (g, op) else {
            let mut out = Out::new(g.unwrap_or("?"));
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
                        lobby.put(uid, member.public());
                        let ph = lobby.prev_host.clone();
                        let host_gone = lobby.host.as_deref().map(|h| !lobby.has(h)).unwrap_or(true);
                        let host_back = ph.as_ref().map(|(h, at)| h == uid && t - at < HOST_GRACE).unwrap_or(false);
                        if host_gone || host_back {
                            lobby.host = Some(uid.to_string()); // first in, or the host back from a blip
                        }
                        if ph.map(|(h, at)| h == uid || t - at >= HOST_GRACE).unwrap_or(false) {
                            lobby.prev_host = None;
                        }
                        let joined = if fresh && !returning { member.public() } else { Value::Null };
                        out.push(To::All, "lobby",
                                 json!({"members": lobby.roster(), "joined": joined, "name": GAME_NAME}));
                        if v.kart.restore(uid, member.public()) {
                            out.push(To::Users(v.lobby.ids(), None), "kart",
                                     json!({"race": v.kart.view(t), "back": uid}));
                        } else {
                            out.push(To::Conn(conn), "kart", json!({"race": v.kart.view(t)}));
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
                _ => self.kart_op(room_id, v, conn, member, op, msg, &mut out, t),
            }
        }
        if let Some(to) = invite {
            let payload = json!({"type": "game", "g": GAME, "ev": "invite", "from": member.public(),
                                 "room": room_id, "name": GAME_NAME});
            let delivered = self.inner.rooms.deliver_to_user(&to, payload.to_string()).await;
            out.push(To::Conn(conn), "invited", json!({"to": to, "delivered": delivered}));
        }
        self.flush(room_id, out).await;
    }

    /// Kart Racing: position frames feed the room's tick loop; everything else
    /// goes to this game's lobby at once.
    #[allow(clippy::too_many_arguments)]
    fn kart_op(&self, room_id: &str, v: &mut KartRoom, conn: u64, member: &Member, op: &str,
               msg: &Value, out: &mut Out, t: f64) {
        let uid = member.user_id.as_str();
        let ids = v.lobby.ids();
        let km = &mut v.kart;
        match op {
            "pos" => {
                if let (_, Some(fix)) = km.pos(uid, msg, t) {
                    out.push(To::Conn(conn), "fix", fix);
                }
            }
            "view" => out.push(To::Conn(conn), "kart", json!({"race": km.view(t)})),
            "car" => match km.car(uid, msg) {
                None => out.err(conn, "pick a car"),
                Some(c) => out.push(To::Users(ids, None), "car", json!({"user": uid, "car": c})),
            },
            "start" | "end" => {
                if v.lobby.host.as_deref() != Some(uid) {
                    out.err(conn, "only the host can do that");
                    return;
                }
                v.lobby.prev_host = None;
                let km = &mut v.kart;
                if op == "start" {
                    let null = Value::Null;
                    let mut err = km.start(&v.lobby.members, msg.get("track").unwrap_or(&null),
                                           msg.get("laps").unwrap_or(&null), t);
                    if err.is_none() && !self.tick_on(room_id) {
                        km.end();
                        err = Some("the Arena is busy right now: try again in a minute".into());
                    }
                    match err {
                        Some(e) => out.err(conn, &e),
                        None => out.push(To::Users(ids, None), "kart",
                                         json!({"race": km.view(t), "by": member.public()})),
                    }
                } else {
                    km.end();
                    self.inner.reg.stop(&tick_key(room_id));
                    out.push(To::Users(ids, None), "kart", json!({"race": km.view(t)}));
                }
            }
            _ => {}
        }
    }

    /// Start the room's race loop (a no-op if it runs). False: no slot under the budget.
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
            if !v.kart.running() {
                return false;
            }
            let mut ids = v.lobby.ids();
            for (u, _) in &v.kart.players {
                if !v.lobby.has(u) {
                    ids.push(u.clone());
                }
            }
            let mut out = Out::new(GAME);
            for (ev, data) in v.kart.tick(t, send) {
                out.push(To::Users(ids.clone(), None), ev, data);
            }
            let running = v.kart.running();
            if !running {
                out.push(To::Users(ids.clone(), None), "kart", json!({"race": v.kart.view(t)}));
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
            return; // the same person is still here on another socket
        }
        let mut out = Out::new(GAME);
        let t = self.now();
        self.with_room(room_id, |v| leave_lobby(v, &uid, &mut out, true, t));
        self.flush(room_id, out).await;
        if !self.inner.rooms.other_conn(room_id, conn, |_| true).await {
            // Nobody else is in the room: forget its game and stop its loop.
            self.inner.state.lock().unwrap().remove(room_id);
            self.inner.reg.stop(&tick_key(room_id));
        }
    }

    async fn flush(&self, room_id: &str, out: Out) {
        let rooms = &self.inner.rooms;
        for (to, payload) in out.items {
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

/// Leave the kart lobby. disconnected: the socket dropped rather than an explicit
/// leave, so the page will most likely rejoin within seconds: the host is handed
/// back on a quick return and the car waits on the track for GRACE.
fn leave_lobby(v: &mut KartRoom, uid: &str, out: &mut Out, disconnected: bool, t: f64) {
    let lobby = &mut v.lobby;
    let Some(who) = lobby.pop(uid) else { return };
    if disconnected {
        lobby.blips.insert(uid.to_string(), t);
    }
    if lobby.host.as_deref() == Some(uid) {
        lobby.host = lobby.members.first().map(|(u, _)| u.clone());
        lobby.prev_host = if disconnected && lobby.host.is_some() { Some((uid.to_string(), t)) } else { None };
    }
    if v.kart.drop(uid, t, disconnected) {
        out.push(To::Users(v.lobby.ids(), None), "kart", json!({"race": v.kart.view(t), "left": uid}));
    }
    out.push(To::All, "lobby", json!({"members": v.lobby.roster(), "left": who, "name": GAME_NAME}));
}

#[cfg(test)]
mod tests;
