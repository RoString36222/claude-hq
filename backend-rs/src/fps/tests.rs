//! Ported from backend/tests/test_fps.py: the arena map, the shared geometry,
//! the shot rules, lag compensation, movement checks, an 8-player match under
//! simulated lag, and matches through the room + lobby layer.

use super::*;
use crate::realtime::{Registry, MAX_TICKERS, ROOM_BYTES_PER_SEC};
use rand::{rngs::StdRng, Rng, SeedableRng};
use std::collections::BinaryHeap;
use std::time::Duration;
use tokio::sync::mpsc;

fn pubv(uid: &str) -> Value {
    json!({"userId": uid, "handle": uid, "displayName": uid, "avatarUrl": ""})
}

fn members(n: usize, prefix: &str) -> Vec<(String, Value)> {
    (0..n).map(|i| (format!("{prefix}{i}"), pubv(&format!("{prefix}{i}")))).collect()
}

fn frame(x: f64, y: f64, z: f64, q: Option<i64>) -> Value {
    let mut m = json!({"x": cm(x), "y": cm(y), "z": cm(z), "r": 0, "p": 0});
    if let Some(q) = q {
        m["q"] = json!(q);
    }
    m
}

fn aim(o: [f64; 3], t: [f64; 3]) -> (f64, f64) {
    let (dx, dy, dz) = (t[0] - o[0], t[1] - o[1], t[2] - o[2]);
    (dx.atan2(-dz).to_degrees(), dy.atan2(dx.hypot(dz)).to_degrees())
}

/// A fire op from eye o at target, pre-corrected for the spread of shot n.
fn shot(o: [f64; 3], target: [f64; 3], q: i64, w: usize, ip: i64, n: i64) -> Value {
    let (yaw, pitch) = aim(o, target);
    let (dy, dp) = spread_of(n, w);
    json!({"w": w, "ox": cm(o[0]), "oy": cm(o[1]), "oz": cm(o[2]),
           "r": ((yaw - dy) * 100.0).round() as i64, "p": ((pitch - dp) * 100.0).round() as i64, "q": q, "ip": ip})
}

fn started(n: usize, t0: f64) -> (Fps, f64) {
    let mut f = Fps::new();
    assert_eq!(f.start(&members(n, "u"), &json!(5), &json!(20), t0), None);
    f.tick(t0 + COUNTDOWN, true);
    assert_eq!(f.phase, Phase::Round);
    (f, t0 + COUNTDOWN)
}

fn put(f: &mut Fps, uid: &str, x: f64, y: f64, z: f64, t: f64, q: Option<i64>) {
    let p = f.player_mut(uid).unwrap();
    p.x = x;
    p.y = y;
    p.z = z;
    p.hist = VecDeque::from([(t, x, y, z)]);
    p.protect = 0.0;
    p.spawn_t = t - 5.0;
    if let Some(q) = q {
        p.q = Some(q);
        p.q0 = q;
        p.t0 = t;
        p.qmax = Some(q);
        p.off = Some(t - q as f64 / 100.0);
    }
}

fn eye(f: &Fps, uid: &str) -> [f64; 3] {
    let p = f.player(uid).unwrap();
    [p.x, p.y + EYE, p.z]
}

fn chest(f: &Fps, uid: &str) -> [f64; 3] {
    let p = f.player(uid).unwrap();
    [p.x, p.y + 1.0, p.z]
}

fn slot(f: &Fps, uid: &str) -> i64 {
    f.player(uid).unwrap().slot
}

// --------------------------------------------------------------------- map --
#[test]
fn the_map_file_is_the_python_one() {
    let py = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../backend/app/fps_map.json")).unwrap();
    assert_eq!(py, MAP_JSON);
}

#[test]
fn map_is_sane() {
    let m = &*MAP;
    assert!(m.spawns.len() >= 8 && m.boxes.len() >= 20);
    for s in &m.spawns {
        assert!(overlaps(m, s[0], s[1], s[2], 0.0).is_none(), "spawn inside a wall {s:?}");
        assert!(overlaps(m, s[0], s[1] - 0.05, s[2], 0.0).is_some(), "spawn not on the ground {s:?}");
        assert_eq!(top_under(m, s[0], s[1] - 0.05, s[2]), Some(s[1]));
    }
    for p in &m.pickups {
        assert!(overlaps(m, p.at[0], p.at[1], p.at[2], 0.0).is_none());
    }
    assert_eq!(m.pickups.len(), 5);
    assert!(compile_map(&json!({"boxes": [[0, 0, 0, 0, 1, 1, "x"]]})).is_err());
}

// ---------------------------------------------------------------- geometry --
#[test]
fn rays_dirs_and_spread() {
    let b = [-1.0, -1.0, -1.0, 1.0, 1.0, 1.0];
    assert!((ray_box([-5.0, 0.0, 0.0], [1.0, 0.0, 0.0], &b).unwrap() - 4.0).abs() < 1e-12);
    assert_eq!(ray_box([5.0, 0.0, 0.0], [1.0, 0.0, 0.0], &b), None);
    assert_eq!(ray_box([0.0, 0.0, 0.0], [0.0, 1.0, 0.0], &b), Some(0.0));
    assert_eq!(ray_box([-5.0, 0.0, 0.0], [0.0, 0.0, 1.0], &b), None);
    let d = dir_of(90.0, 0.0);
    assert!((d[0] - 1.0).abs() < 1e-12 && d[2].abs() < 1e-12);
    let (t, head) = ray_player([0.0, EYE, 10.0], dir_of(0.0, (1.65f64 - EYE).atan2(10.0).to_degrees()), 0.0, 0.0, 0.0, 100.0).unwrap();
    assert!(head && t < 10.0);
    // the same mulberry32 draws as the Python and the browser
    assert!((mb32(0) - 0.26642920868471265).abs() < 1e-15);
    for w in 0..2 {
        for n in 1..300 {
            let (a, b) = spread_of(n, w);
            assert!(a.abs() <= WEAPONS[w].spread && b.abs() <= WEAPONS[w].spread);
        }
    }
}

#[test]
fn the_runner_collides_steps_and_jumps() {
    let m = &*MAP;
    let mut s = Body { x: 8.0, g: true, ..Default::default() };
    for _ in 0..400 {
        step(m, &mut s, -1.0, 0.0, false, 1.0 / 120.0);
        if s.x < 2.0 {
            break;
        }
    }
    assert_eq!(s.y, 1.5);
    s.vx = 0.0;
    step(m, &mut s, 0.0, 0.0, true, 1.0 / 120.0);
    let mut top = 0.0f64;
    for _ in 0..240 {
        step(m, &mut s, 0.0, 0.0, false, 1.0 / 120.0);
        top = top.max(s.y);
    }
    assert!(top > 2.5 && top < 2.8 && s.y == 1.5 && s.g);
    let mut s = Body { x: 12.0, z: -14.6, g: true, ..Default::default() };
    for _ in 0..240 {
        step(m, &mut s, 1.0, 0.0, false, 1.0 / 120.0);
    }
    assert_eq!(s.y, 0.0); // a 2.5 m wall is not a step
}

// ------------------------------------------------------------------ referee --
#[test]
fn a_hit_kill_respawn_and_protection() {
    let (mut f, mut t) = started(2, 100.0);
    put(&mut f, "u0", 5.0, 0.0, 16.0, t, None);
    put(&mut f, "u1", 5.0, 0.0, 9.0, t, None);
    let mut n = 0;
    while !f.player("u1").unwrap().dead {
        n += 1;
        t += 0.11;
        let (s, sync) = f.fire("u0", &shot(eye(&f, "u0"), chest(&f, "u1"), (t * 100.0) as i64, 0, 100, n), t);
        assert_eq!(s.unwrap()[5], json!(slot(&f, "u1")));
        assert!(sync.is_none());
    }
    assert_eq!(n, 9);
    assert_eq!((f.player("u0").unwrap().kills, f.player("u1").unwrap().deaths), (1, 1));
    let evs = f.tick(t + 0.01, true);
    let kill = &evs.iter().find(|e| e.0 == "kill").unwrap().1;
    assert_eq!((kill["k"].as_str(), kill["v"].as_str()), (Some("u0"), Some("u1")));
    assert_eq!(f.pos("u1", &frame(5.0, 0.0, 9.2, None), t + 0.1), (false, None));
    let evs = f.tick(t + RESPAWN + 0.01, true);
    let sp = &evs.iter().find(|e| e.0 == "spawn").unwrap().1;
    assert_eq!(sp["e"], 2);
    let far = MAP.spawns.iter().copied()
        .max_by(|a, b| dist3([a[0], a[1], a[2]], [5.0, 0.0, 16.0]).partial_cmp(&dist3([b[0], b[1], b[2]], [5.0, 0.0, 16.0])).unwrap())
        .unwrap();
    assert_eq!((sp["x"].as_i64().unwrap(), sp["z"].as_i64().unwrap()), (cm(far[0]), cm(far[2])));
    let t2 = t + RESPAWN + 0.05;
    put(&mut f, "u1", 5.0, 0.0, 9.0, t2, None);
    f.player_mut("u1").unwrap().protect = t2 + PROTECT;
    let (s, _) = f.fire("u0", &shot(eye(&f, "u0"), chest(&f, "u1"), (t2 * 100.0) as i64 + 10, 0, 100, n + 1), t2 + 0.1);
    assert_eq!(s.unwrap()[5], json!(slot(&f, "u1")));
    assert_eq!(f.player("u1").unwrap().hp, 100);
}

#[test]
fn fire_rate_ammo_reload_and_origin() {
    let (mut f, mut t) = started(2, 100.0);
    put(&mut f, "u0", -10.0, 0.0, 18.0, t, None);
    put(&mut f, "u1", 10.0, 0.0, -18.0, t, None);
    let tgt = [-10.0, 1.0, 10.0];
    let mut q = (t * 100.0) as i64;
    let mut ok = 0;
    for _ in 0..40 {
        q += 5;
        t += 0.05;
        f.player_mut("u0").unwrap().fb = (99.0, t);
        if f.fire("u0", &shot(eye(&f, "u0"), tgt, q, 0, 100, 1), t).0.is_some() {
            ok += 1;
        }
    }
    assert_eq!(ok, 20);
    assert_eq!(f.player("u0").unwrap().mag[0], 10);
    for _ in 0..10 {
        q += 10;
        t += 0.1;
        assert!(f.fire("u0", &shot(eye(&f, "u0"), tgt, q, 0, 100, 1), t).0.is_some());
    }
    q += 10;
    t += 0.1;
    let (s, sync) = f.fire("u0", &shot(eye(&f, "u0"), tgt, q, 0, 100, 1), t);
    assert!(s.is_none());
    assert_eq!(sync.unwrap(), json!({"w": 0, "mag": [0, 6], "res": [90, 18], "reloading": false}));
    assert!(f.reload("u0", &json!({"q": q}), t));
    assert!(!f.reload("u0", &json!({"q": q + 1}), t));
    assert!(f.fire("u0", &shot(eye(&f, "u0"), tgt, q + 100, 0, 100, 1), t + 1.0).0.is_none());
    assert!(f.fire("u0", &shot(eye(&f, "u0"), tgt, q + 170, 0, 100, 1), t + 1.7).0.is_some());
    assert_eq!((f.player("u0").unwrap().mag[0], f.player("u0").unwrap().res[0]), (29, 60));
    let bad = f.player("u0").unwrap().bad;
    assert!(f.fire("u0", &shot([5.0, 1.6, 5.0], tgt, q + 700, 0, 100, 1), t + 7.0).0.is_none());
    assert_eq!(f.player("u0").unwrap().bad, bad + 1);
    // weapon switch delay, then the heavy blaster's rate
    assert!(f.weapon("u0", &json!({"w": 1, "q": q + 800}), t + 8.0));
    assert!(f.fire("u0", &shot(eye(&f, "u0"), tgt, q + 810, 1, 100, 1), t + 8.1).0.is_none());
    assert!(f.fire("u0", &shot(eye(&f, "u0"), tgt, q + 830, 1, 100, 1), t + 8.3).0.is_some());
    assert!(f.fire("u0", &shot(eye(&f, "u0"), tgt, q + 860, 1, 100, 1), t + 8.6).0.is_none());
}

#[test]
fn no_hits_through_walls() {
    let (mut f, t) = started(2, 100.0);
    put(&mut f, "u0", 0.0, 0.0, 8.0, t, None);
    put(&mut f, "u1", 0.0, 0.0, -8.0, t, None);
    let (s, _) = f.fire("u0", &shot(eye(&f, "u0"), chest(&f, "u1"), (t * 100.0) as i64, 0, 100, 1), t);
    assert_eq!(s.unwrap()[5], json!(-1));
    put(&mut f, "u0", -12.0, 0.0, -12.0, t, None);
    put(&mut f, "u1", -17.0, 0.0, -17.0, t, None);
    let (s, _) = f.fire("u0", &shot(eye(&f, "u0"), chest(&f, "u1"), (t * 100.0) as i64 + 20, 0, 100, 2), t + 0.2);
    assert_eq!(s.unwrap()[5], json!(-1));
    put(&mut f, "u1", -12.0, 0.0, -4.0, t, None);
    let (s, _) = f.fire("u0", &shot(eye(&f, "u0"), chest(&f, "u1"), (t * 100.0) as i64 + 40, 0, 100, 3), t + 0.4);
    assert_eq!(s.unwrap()[5], json!(slot(&f, "u1")));
}

fn run_target(f: &mut Fps, uid: &str, t0: f64, t1: f64, x0: f64, x1: f64, z: f64) -> f64 {
    let steps = ((t1 - t0) * 20.0).round() as i64;
    for i in 1..=steps {
        let t = t0 + i as f64 / 20.0;
        let x = x0 + (x1 - x0) * i as f64 / steps as f64;
        assert!(f.pos(uid, &frame(x, 0.0, z, Some((t * 100.0).round() as i64)), t).0, "{x}");
    }
    t1
}

fn lagged_target() -> (Fps, f64) {
    let (mut f, t) = started(2, 100.0);
    let q = (t * 100.0).round() as i64;
    put(&mut f, "u0", -6.0, 0.0, 16.0, t, Some(q));
    put(&mut f, "u1", -9.0, 0.0, 6.0, t, Some(q));
    let t = run_target(&mut f, "u1", t, t + 1.0, -9.0, -3.0, 6.0);
    (f, t)
}

#[test]
fn lag_compensation_hits_what_the_shooter_saw() {
    let (mut f, t) = lagged_target();
    let seen = f.player("u1").unwrap().where_at(t - 0.1);
    assert!((seen.0 - f.player("u1").unwrap().x).abs() > 0.5);
    let q = (t * 100.0).round() as i64;
    let (s, _) = f.fire("u0", &shot(eye(&f, "u0"), [seen.0, 1.0, seen.2], q, 0, 100, 1), t);
    assert_eq!(s.unwrap()[5], json!(slot(&f, "u1")));
    let (mut f2, t2) = lagged_target();
    let (s, _) = f2.fire("u0", &shot(eye(&f2, "u0"), [seen.0, 1.0, seen.2], (t2 * 100.0).round() as i64, 0, 0, 1), t2);
    assert_eq!(s.unwrap()[5], json!(-1)); // no compensation, no hit
}

#[test]
fn an_impossible_rewind_is_clamped_and_misses() {
    let (mut f, t) = lagged_target();
    let old = f.player("u1").unwrap().where_at(t - 0.8);
    let q = (t * 100.0).round() as i64;
    let (s, _) = f.fire("u0", &shot(eye(&f, "u0"), [old.0, 1.0, old.2], q, 0, 800, 1), t);
    assert_eq!(s.unwrap()[5], json!(-1));
    let (s, _) = f.fire("u0", &shot(eye(&f, "u0"), [old.0, 1.0, old.2], q - 80, 0, 100, 2), t + 0.1);
    assert!(s.is_none()); // an old clock buys no rewind
}

#[test]
fn the_round_trip_is_measured_from_acks() {
    let (mut f, mut t) = started(2, 100.0);
    let lat = 0.15;
    put(&mut f, "u0", -6.0, 0.0, 16.0, t, None);
    put(&mut f, "u1", -9.0, 0.0, 6.0, t, Some((t * 100.0).round() as i64));
    let mut sent: Vec<(i64, f64)> = Vec::new();
    let mut x = -9.0;
    for _ in 0..20 {
        t += 0.05;
        x += 0.3;
        f.pos("u1", &frame(x, 0.0, 6.0, Some((t * 100.0).round() as i64)), t);
        for (ev, d) in f.tick(t, true) {
            if ev == "snap" {
                sent.push((d["k"].as_i64().unwrap(), t));
            }
        }
        let at = t - lat;
        let ack = sent.iter().filter(|(_, s)| *s <= at - lat + 1e-9).max_by_key(|(k, _)| *k).copied();
        let mut m = frame(-6.0, 0.0, 16.0, Some((at * 100.0).round() as i64));
        if let Some((k, s)) = ack {
            m["k"] = json!(k);
            m["kq"] = json!(((s + lat) * 100.0).round() as i64);
        }
        f.pos("u0", &m, t);
    }
    let rtt = f.player("u0").unwrap().rtt;
    assert!((rtt - 2.0 * lat).abs() < 0.03, "{rtt}");
    let fire_at = t - lat;
    let seen = f.player("u1").unwrap().where_at(fire_at - lat - 0.1);
    let (s, _) = f.fire("u0", &shot(eye(&f, "u0"), [seen.0, 1.0, seen.2], (fire_at * 100.0).round() as i64, 0, 100, 1), t);
    assert_eq!(s.unwrap()[5], json!(slot(&f, "u1")));
}

#[test]
fn movement_is_checked() {
    let (mut f, t) = started(1, 100.0);
    let q = (t * 100.0).round() as i64;
    put(&mut f, "u0", -6.0, 0.0, 16.0, t, Some(q));
    let life = f.player("u0").unwrap().life;
    let (ok, fix) = f.pos("u0", &frame(-6.0, 0.0, 10.0, Some(q + 5)), t + 0.05);
    assert!(!ok);
    assert_eq!(fix.unwrap(), json!({"x": -600, "y": 0, "z": 1600, "e": life}));
    assert!(f.pos("u0", &frame(-6.0, 0.0, 15.5, Some(q + 70)), t + 0.7).0);
    assert!(!f.pos("u0", &frame(0.0, 0.5, 0.0, Some(q + 300)), t + 3.0).0); // inside the keep
    assert!(!f.pos("u0", &frame(0.0, 0.0, 30.0, Some(q + 900)), t + 9.0).0); // out of the arena
    // stale frames and frames from an earlier life are dropped quietly
    let bad = f.player("u0").unwrap().bad;
    assert_eq!(f.pos("u0", &frame(-6.0, 0.0, 15.5, Some(q + 60)), t + 9.1), (false, None));
    let mut m = frame(-6.0, 0.0, 15.4, Some(q + 1000));
    m["e"] = json!(life - 1);
    assert_eq!(f.pos("u0", &m, t + 10.0), (false, None));
    assert_eq!(f.player("u0").unwrap().bad, bad);
    // hovering
    let mut y = 0.0;
    let mut took = 0;
    for i in 1..60 {
        y = f64::min(3.0, y + 0.1);
        if f.pos("u0", &frame(-6.0, y, 15.5, Some(q + 1100 + i * 5)), t + 11.0 + i as f64 * 0.05).0 {
            took += 1;
        }
    }
    assert!(took < 50 && f.player("u0").unwrap().bad >= bad + 4);
}

#[test]
fn a_fast_clock_buys_no_speed() {
    let (mut f, mut t) = started(1, 100.0);
    put(&mut f, "u0", -18.0, 0.0, 19.0, t, Some(10000));
    let (mut x, mut q) = (-18.0, 10000);
    for _ in 0..40 {
        x += 0.25;
        t += 0.05;
        q += 5;
        assert!(f.pos("u0", &frame(x, 0.0, 19.0, Some(q)), t).0);
    }
    let mut caught = false;
    for _ in 0..40 {
        x += 0.75;
        t += 0.05;
        q += 15;
        let (ok, fix) = f.pos("u0", &frame(x.min(20.0), 0.0, 19.0, Some(q)), t);
        if !ok {
            caught = fix.is_some();
            break;
        }
    }
    assert!(caught && f.player("u0").unwrap().bad == 1);
}

#[test]
fn frames_are_rate_limited_and_pickups_work() {
    let (mut f, t) = started(2, 100.0);
    put(&mut f, "u0", -18.0, 0.0, 12.0, t, None);
    let took = (0..50).filter(|_| f.pos("u0", &frame(-18.0, 0.0, 12.0, None), t).0).count();
    assert!(took as f64 <= POS_BURST);
    let h = MAP.pickups[1].at;
    f.player_mut("u0").unwrap().hp = 30;
    put(&mut f, "u0", h[0] + 3.0, h[1], h[2], t + 1.0, None);
    f.player_mut("u0").unwrap().pb = (POS_BURST, t + 1.0);
    assert!(f.pos("u0", &frame(h[0] + 0.5, h[1], h[2], None), t + 1.6).0);
    assert_eq!(f.player("u0").unwrap().hp, 80);
    let evs = f.tick(t + 1.7, true);
    assert_eq!(evs.iter().find(|e| e.0 == "pick").unwrap().1["i"], 1);
    let back: Vec<_> = f.tick(t + 1.7 + PICKUP_BACK, true).into_iter().filter(|e| e.0 == "item").collect();
    assert_eq!(back, vec![("item", json!({"i": 1, "on": 1}))]);
}

#[test]
fn rounds_end_on_kills_time_and_leavers() {
    let mut f = Fps::new();
    f.start(&members(3, "p"), &json!(3), &json!(10), 0.0);
    assert_eq!((f.minutes, f.limit), (3, 10));
    f.tick(COUNTDOWN, true);
    for (i, k) in [9, 3, 3].iter().enumerate() {
        f.players[i].1.kills = *k;
    }
    f.players[1].1.deaths = 4;
    f.players[2].1.deaths = 4;
    f.tick(COUNTDOWN + 1.0, true);
    assert_eq!(f.phase, Phase::Round);
    f.players[0].1.kills = 10;
    assert_eq!(f.tick(COUNTDOWN + 2.0, true).last().unwrap().0, "done");
    let places: Vec<i64> = f.results.as_ref().unwrap().as_array().unwrap().iter().map(|r| r["place"].as_i64().unwrap()).collect();
    assert_eq!(places, [1, 2, 2]);
    let (mut f, t) = started(2, 0.0);
    assert!(f.tick(t + 299.9, true).iter().all(|e| e.0 != "done"));
    assert_eq!(f.tick(t + 300.01, true).last().unwrap().0, "done");
    // drops, rejoins, drop-ins
    let (mut f, t) = started(3, 0.0);
    f.player_mut("u1").unwrap().kills = 4;
    assert!(f.drop("u1", t, true));
    assert!(f.enter("u1", pubv("u1"), t + 3.0));
    assert_eq!(f.player("u1").unwrap().kills, 4);
    f.drop("u1", t + 4.0, true);
    assert!(f.tick(t + 4.0 + GRACE + 0.1, true).iter().any(|e| e.0 == "gone"));
    assert!(f.enter("u1", pubv("u1"), t + 30.0));
    assert!(f.player("u1").unwrap().dead && f.player("u1").unwrap().kills == 4);
    assert!(f.enter("u9", pubv("u9"), t + 31.0));
    assert_eq!(f.player("u9").unwrap().slot, 3);
    let spawned: Vec<Value> = f.tick(t + 31.1, true).into_iter().filter(|e| e.0 == "spawn").map(|e| e.1["user"].clone()).collect();
    assert!(spawned.contains(&json!("u9")) && spawned.contains(&json!("u1")));
    f.drop("u0", t + 32.0, false);
    f.drop("u1", t + 32.0, false);
    f.tick(t + 32.05, true);
    assert_eq!(f.phase, Phase::Round);
    f.drop("u9", t + 32.0, false);
    assert_eq!(f.tick(t + 32.1, true).last().unwrap().0, "done");
}

// --------------------------------------------- 8 players under simulated lag --
fn gauss(rng: &mut StdRng, mu: f64, sigma: f64) -> f64 {
    let u1: f64 = 1.0 - rng.gen::<f64>();
    let u2: f64 = rng.gen();
    mu + sigma * (-2.0 * u1.ln()).sqrt() * (2.0 * std::f64::consts::PI * u2).cos()
}

/// A message in flight: the heap pops the earliest arrival first.
struct InFlight(f64, u64, usize, &'static str, Value);
impl PartialEq for InFlight {
    fn eq(&self, o: &Self) -> bool {
        self.0 == o.0 && self.1 == o.1
    }
}
impl Eq for InFlight {}
impl PartialOrd for InFlight {
    fn partial_cmp(&self, o: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(o))
    }
}
impl Ord for InFlight {
    fn cmp(&self, o: &Self) -> std::cmp::Ordering {
        o.0.partial_cmp(&self.0).unwrap().then(o.1.cmp(&self.1))
    }
}

/// A bot's picture of one other player (games/fps.js's snapshot interpolation).
#[derive(Default)]
struct View {
    snaps: Vec<(f64, f64, f64, f64)>,
    last: i64,
    jit: f64,
    seen: f64,
    dead: bool,
    life_at: f64,
}
const INTERP: f64 = 0.1;
const JIT_MAX: f64 = 0.25;

impl View {
    fn push(&mut self, e: &Value, now: f64, off: f64) {
        let flags = e[8].as_i64().unwrap();
        if flags & 1 == 1 {
            self.dead = true;
        } else if self.dead {
            self.dead = false;
            self.life_at = now;
            self.snaps.clear();
        }
        let key = e[9].as_i64().unwrap();
        if key < 0 || key <= self.last {
            return;
        }
        self.last = key;
        let late = (now - (key as f64 / 1000.0 + off)).clamp(0.0, JIT_MAX);
        self.jit += (late - self.jit) * if late > self.jit { 0.3 } else { 0.02 };
        let f = |i: usize| e[i].as_f64().unwrap() / 100.0;
        self.snaps.push((key as f64 / 1000.0, f(1), f(2), f(3)));
        if self.snaps.len() > 12 {
            self.snaps.remove(0);
        }
    }

    fn at(&mut self, now: f64, off: f64, back: f64) -> Option<[f64; 3]> {
        let sn = &self.snaps;
        let (first, last) = (sn.first()?, sn.last()?);
        let rt = now - off - INTERP - self.jit - back;
        self.seen = rt;
        if rt <= first.0 {
            return if back == 0.0 { Some([first.1, first.2, first.3]) } else { None };
        }
        if rt >= last.0 {
            self.seen = last.0;
            return Some([last.1, last.2, last.3]);
        }
        for i in (1..sn.len()).rev() {
            if sn[i - 1].0 <= rt {
                let (a, b) = (sn[i - 1], sn[i]);
                let u = (rt - a.0) / if b.0 == a.0 { 1.0 } else { b.0 - a.0 };
                return Some([a.1 + (b.1 - a.1) * u, a.2 + (b.2 - a.2) * u, a.3 + (b.3 - a.3) * u]);
            }
        }
        None
    }
}

struct Bot {
    s: Body,
    clk: f64,
    goal: (f64, f64),
    views: HashMap<i64, View>,
    k: Option<i64>,
    kq: i64,
    off: Option<f64>,
    life: i64,
    dead: bool,
    n: i64,
    mag: i64,
    res: i64,
    reload_until: f64,
    next_shot: f64,
    sent_at: f64,
    last: (f64, f64),
}

fn open_points() -> Vec<(f64, f64)> {
    let mut pts = Vec::new();
    for x in (-20..=20).step_by(2) {
        for z in (-20..=20).step_by(2) {
            let (x, z) = (x as f64, z as f64);
            if overlaps(&MAP, x, 0.31, z, -0.3).is_none() && overlaps(&MAP, x, -0.05, z, 0.0).is_some() {
                pts.push((x, z));
            }
        }
    }
    pts
}

#[derive(Debug, Default)]
struct Counts {
    expected: i64,
    registered: i64,
    stale: i64,
    stale_hits: i64,
    kills_seen: i64,
}

fn lagged_match(seed: u64) -> (Fps, Counts, HashMap<i64, usize>) {
    let mut rng = StdRng::seed_from_u64(seed);
    let mut f = Fps::new();
    let ms = members(8, "bot");
    let t0 = 1000.0;
    assert_eq!(f.start(&ms, &json!(3), &json!(30), t0), None);
    let pts = open_points();
    let uid = |i: usize| format!("bot{i}");
    let slot_of: Vec<i64> = (0..8).map(|i| f.player(&uid(i)).unwrap().slot).collect();
    let mut bots: Vec<Bot> = (0..8).map(|i| {
        let p = f.player(&uid(i)).unwrap();
        Bot { s: Body { x: p.x, y: p.y, z: p.z, g: true, ..Default::default() }, clk: rng.gen_range(-500.0..500.0),
              goal: pts[rng.gen_range(0..pts.len())], views: HashMap::new(), k: None, kq: 0, off: None,
              life: p.life, dead: true, n: 0, mag: 30, res: 90, reload_until: 0.0, next_shot: 0.0, sent_at: 0.0,
              last: (p.x, p.z) }
    }).collect();
    let (mut up, mut down): (BinaryHeap<InFlight>, BinaryHeap<InFlight>) = (BinaryHeap::new(), BinaryHeap::new());
    let mut seq = 0u64;
    let mut bytes: HashMap<i64, usize> = HashMap::new();
    let mut c = Counts::default();
    let mut pending: HashMap<(usize, i64), i64> = HashMap::new(); // -> target slot, or -2: stale
    let mut t = t0;
    let dt = 1.0 / 60.0;
    let mut next_tick = t0;
    let lag = |rng: &mut StdRng| gauss(rng, 0.12, 0.06).clamp(0.0, 0.24);
    while f.phase != Phase::Done && t < t0 + COUNTDOWN + 60.0 {
        t = ((t + dt) * 1e9).round() / 1e9;
        while up.peek().map(|m| m.0 <= t).unwrap_or(false) {
            let InFlight(at, _, i, op, msg) = up.pop().unwrap();
            match op {
                "pos" => {
                    f.pos(&uid(i), &msg, at);
                }
                "reload" => {
                    f.reload(&uid(i), &msg, at);
                }
                _ => {
                    let n = msg["_n"].as_i64().unwrap();
                    let me = f.player(&uid(i)).unwrap();
                    let was_dead = me.dead || msg["e"].as_i64() != Some(me.life);
                    let mut want = pending.remove(&(i, n));
                    if let Some(w) = want.filter(|w| *w >= 0) {
                        let tid = slot_of.iter().position(|s| *s == w).unwrap();
                        if f.player(&uid(tid)).unwrap().dead {
                            c.expected -= 1; // killed by someone else meanwhile: can't count
                            want = None;
                        }
                    }
                    let (s, _) = f.fire(&uid(i), &msg, at);
                    match s {
                        None => {
                            assert!(was_dead, "an honest shot was refused: {msg}");
                            match want {
                                Some(-2) => c.stale -= 1,
                                Some(_) => c.expected -= 1,
                                None => {}
                            }
                        }
                        Some(s) => {
                            let hit = s[5].as_i64().unwrap();
                            match want {
                                Some(-2) => c.stale_hits += (hit >= 0) as i64,
                                Some(w) => c.registered += (hit == w) as i64,
                                None => {}
                            }
                        }
                    }
                }
            }
        }
        while next_tick <= t {
            for (ev, data) in f.tick(next_tick, true) {
                let mut m = json!({"type": "game", "g": "fps", "ev": ev});
                m.as_object_mut().unwrap().extend(data.as_object().unwrap().clone());
                *bytes.entry(next_tick as i64).or_default() += m.to_string().len() * 8;
                if ev == "kill" {
                    c.kills_seen += 1;
                }
                for i in 0..8 {
                    seq += 1;
                    down.push(InFlight(next_tick + lag(&mut rng), seq, i, ev, data.clone()));
                }
            }
            next_tick += 1.0 / HZ;
        }
        while down.peek().map(|m| m.0 <= t).unwrap_or(false) {
            let InFlight(at, _, i, ev, data) = down.pop().unwrap();
            let b = &mut bots[i];
            let local = at + b.clk;
            match ev {
                "go" => b.dead = false,
                "snap" => {
                    let k = data["k"].as_i64().unwrap();
                    if b.k.map(|bk| k > bk).unwrap_or(true) {
                        b.k = Some(k);
                        b.kq = (local * 100.0) as i64;
                    }
                    let o = local - data["ts"].as_f64().unwrap() / 1000.0;
                    let off = if b.off.map(|bo| o < bo).unwrap_or(true) { o } else { b.off.unwrap() };
                    b.off = Some(off);
                    for e in data["p"].as_array().unwrap() {
                        let sl = e[0].as_i64().unwrap();
                        if sl != slot_of[i] {
                            b.views.entry(sl).or_default().push(e, local, off);
                        }
                    }
                }
                "kill" if data["v"] == json!(uid(i)) => b.dead = true,
                "spawn" if data["user"] == json!(uid(i)) => {
                    b.dead = false;
                    b.life = data["e"].as_i64().unwrap();
                    b.n = 0;
                    let g = |k: &str| data[k].as_f64().unwrap() / 100.0;
                    b.s = Body { x: g("x"), y: g("y"), z: g("z"), g: true, ..Default::default() };
                }
                _ => {}
            }
        }
        if f.phase != Phase::Round {
            continue;
        }
        for i in 0..8 {
            let b = &mut bots[i];
            if b.dead {
                continue;
            }
            let (dx, dz) = (b.goal.0 - b.s.x, b.goal.1 - b.s.z);
            let d = dx.hypot(dz);
            if d < 1.0 {
                b.goal = pts[rng.gen_range(0..pts.len())];
            }
            let (wx, wz) = if d > 1e-6 { (dx / d, dz / d) } else { (0.0, 0.0) };
            let jump = rng.gen::<f64>() < 0.004;
            step(&MAP, &mut b.s, wx, wz, jump, dt);
            let local = t + b.clk;
            let q = (local * 100.0) as i64;
            if t - b.sent_at >= 0.05 {
                b.sent_at = t;
                if (b.s.x - b.last.0).hypot(b.s.z - b.last.1) < 0.05 {
                    b.goal = pts[rng.gen_range(0..pts.len())];
                }
                b.last = (b.s.x, b.s.z);
                let mut m = frame(b.s.x, b.s.y, b.s.z, Some(q));
                m["e"] = json!(b.life);
                if let Some(k) = b.k {
                    m["k"] = json!(k);
                    m["kq"] = json!(b.kq);
                }
                seq += 1;
                up.push(InFlight(t + lag(&mut rng), seq, i, "pos", m));
            }
            if t < b.next_shot {
                continue;
            }
            if b.mag == 0 {
                if b.reload_until == 0.0 && b.res > 0 {
                    b.reload_until = t + WEAPONS[0].reload + 0.02;
                    seq += 1;
                    up.push(InFlight(t + lag(&mut rng), seq, i, "reload", json!({"q": q, "e": b.life})));
                } else if b.reload_until > 0.0 && t >= b.reload_until {
                    let take = b.res.min(30);
                    b.mag = take;
                    b.res -= take;
                    b.reload_until = 0.0;
                }
                continue;
            }
            let o = [b.s.x, b.s.y + EYE, b.s.z];
            let Some(off) = b.off else { continue };
            let mut best: Option<(f64, i64, [f64; 3])> = None;
            for (sl, vw) in b.views.iter_mut() {
                if vw.dead || local - vw.life_at < 0.8 {
                    continue;
                }
                let Some(pos) = vw.at(local, off, 0.0) else { continue };
                let cc = [pos[0], pos[1] + 1.0, pos[2]];
                let dist = dist3(o, cc);
                if dist > 22.0 {
                    continue;
                }
                let dd = [(cc[0] - o[0]) / dist, (cc[1] - o[1]) / dist, (cc[2] - o[2]) / dist];
                if ray_map(&MAP, o, dd, dist) < dist {
                    continue;
                }
                if best.map(|bb| dist < bb.0).unwrap_or(true) {
                    best = Some((dist, *sl, pos));
                }
            }
            let Some((_, sl, pos)) = best else { continue };
            let vw = b.views.get_mut(&sl).unwrap();
            let stale = rng.gen::<f64>() < 0.12;
            let (aim_at, ip) = if stale {
                let Some(old) = vw.at(local, off, 0.8) else { continue };
                if (old[0] - pos[0]).hypot(old[2] - pos[2]) < 1.6 {
                    continue;
                }
                ([old[0], old[1] + 1.0, old[2]], 1100)
            } else {
                vw.at(local, off, 0.0);
                ([pos[0], pos[1] + 1.0, pos[2]], ((local - off - vw.seen) * 1000.0).round() as i64)
            };
            b.n += 1;
            b.mag -= 1;
            b.next_shot = t + 0.25;
            let (yaw, pitch) = aim(o, aim_at);
            let (dy, dp) = spread_of(b.n, 0);
            let d3 = dir_of(yaw + dy, (pitch + dp).clamp(-89.0, 89.0));
            let reach = ray_map(&MAP, o, d3, WEAPONS[0].range);
            if stale {
                pending.insert((i, b.n), -2);
                c.stale += 1;
            } else if ray_player(o, d3, pos[0], pos[1], pos[2], reach).is_some() {
                pending.insert((i, b.n), sl);
                c.expected += 1;
            }
            let mut m = json!({"w": 0, "ox": cm(o[0]), "oy": cm(o[1]), "oz": cm(o[2]),
                               "r": (yaw * 100.0).round() as i64, "p": (pitch * 100.0).round() as i64, "q": q,
                               "ip": ip, "kq": b.kq, "e": b.life, "_n": b.n});
            if let Some(k) = b.k {
                m["k"] = json!(k);
            }
            seq += 1;
            up.push(InFlight(t + lag(&mut rng), seq, i, "fire", m));
        }
    }
    (f, c, bytes)
}

#[test]
fn eight_players_with_lag_hits_register_and_nothing_honest_is_refused() {
    for seed in [7, 8] {
        let (f, c, bytes) = lagged_match(seed);
        assert_eq!(f.players.iter().map(|(_, p)| p.bad).sum::<u32>(), 0, "{c:?}");
        assert!(c.expected > 150, "{c:?}");
        assert!(c.registered as f64 / c.expected as f64 >= 0.9, "{c:?}");
        assert!(c.stale > 10 && c.stale_hits as f64 / c.stale as f64 <= 0.15, "{c:?}");
        let kills: i64 = f.players.iter().map(|(_, p)| p.kills).sum();
        let deaths: i64 = f.players.iter().map(|(_, p)| p.deaths).sum();
        assert!(kills == deaths && kills == c.kills_seen && kills > 5, "{kills} {deaths} {c:?}");
        assert!(*bytes.values().max().unwrap() < ROOM_BYTES_PER_SEC);
    }
}

#[test]
fn eight_player_tick_is_cheap() {
    let (mut f, t) = started(8, 100.0);
    let pts = open_points();
    for i in 0..8 {
        let (x, z) = pts[(i * 7) % pts.len()];
        put(&mut f, &format!("u{i}"), x, 0.0, z, t, None);
    }
    let start = std::time::Instant::now();
    for k in 0..20 * 30 {
        let tt = t + k as f64 * 0.05;
        for j in 0..8 {
            let uid = format!("u{j}");
            let p = f.player(&uid).unwrap();
            if p.dead {
                continue;
            }
            let (x, y, z) = (p.x + if k % 40 < 20 { 0.2 } else { -0.2 }, p.y, p.z);
            f.pos(&uid, &frame(x, y, z, None), tt);
            if k % 3 == j % 3 {
                let o = eye(&f, &uid);
                f.fire(&uid, &json!({"w": 0, "ox": cm(o[0]), "oy": cm(o[1]), "oz": cm(o[2]), "r": j * 4500,
                                     "p": 0, "q": (tt * 100.0) as i64, "ip": 100}), tt);
            }
            let p = f.player_mut(&uid).unwrap();
            if p.mag[0] == 0 {
                p.mag[0] = 30;
            }
        }
        f.tick(tt, true);
    }
    let per_second = start.elapsed().as_secs_f64() / 30.0;
    assert!(per_second < 0.05, "{per_second}"); // < 5% of one core per room (debug build)
}

// ------------------------------------------- through the room + lobby layer --
struct Env {
    hub: FpsHub,
    rooms: RoomManager,
    clock: Arc<Mutex<f64>>,
}

fn env(max_tickers: usize) -> Env {
    let rooms = RoomManager::new();
    let clock = Arc::new(Mutex::new(1000.0));
    let c = clock.clone();
    let hub = FpsHub::new(rooms.clone(), Registry::new(max_tickers), Arc::new(move || *c.lock().unwrap()));
    Env { hub, rooms, clock }
}

impl Env {
    fn advance(&self, dt: f64) {
        *self.clock.lock().unwrap() += dt;
    }
    fn now(&self) -> f64 {
        *self.clock.lock().unwrap()
    }
    async fn connect(&self, room: &str, conn: u64, uid: &str) -> (Member, mpsc::Receiver<String>) {
        let m = Member { user_id: uid.into(), handle: uid.into(), display_name: uid.into(), avatar_url: String::new() };
        let (_rx, drx, _, _) = self.rooms.join_direct(room, conn, m.clone()).await.unwrap();
        (m, drx)
    }
    async fn send(&self, room: &str, conn: u64, m: &Member, op: &str, extra: Value) {
        let mut msg = json!({"type": "game", "g": "fps", "op": op});
        if let Value::Object(e) = extra {
            msg.as_object_mut().unwrap().extend(e);
        }
        self.hub.handle(room, conn, m, &msg).await;
    }
}

async fn until_where(rx: &mut mpsc::Receiver<String>, ev: &str, pick: impl Fn(&Value) -> bool) -> Value {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        let m = tokio::time::timeout_at(deadline, rx.recv()).await.unwrap_or_else(|_| panic!("no {ev} event"))
            .expect("queue open");
        let v: Value = serde_json::from_str(&m).unwrap();
        if v["type"] == "game" && v["g"] == "fps" && v["ev"] == ev && pick(&v) {
            return v;
        }
    }
}

async fn until(rx: &mut mpsc::Receiver<String>, ev: &str) -> Value {
    until_where(rx, ev, |_| true).await
}

#[tokio::test]
async fn a_match_through_the_room_and_lobby() {
    let e = env(MAX_TICKERS);
    let (a, mut wa) = e.connect("fpsroom", 1, "fps-a").await;
    let (b, mut wb) = e.connect("fpsroom", 2, "fps-b").await;
    e.send("fpsroom", 1, &a, "join", json!({})).await;
    assert_eq!(until(&mut wa, "fps").await["match"]["phase"], "idle");
    e.send("fpsroom", 2, &b, "join", json!({})).await;
    until(&mut wb, "fps").await;
    e.send("fpsroom", 2, &b, "start", json!({"minutes": 3, "kills": 10})).await;
    assert_eq!(until(&mut wb, "error").await["error"], "only the host can do that");
    e.send("fpsroom", 1, &a, "char", json!({"c": 4})).await;
    assert_eq!(until(&mut wb, "char").await["c"], 4);
    e.send("fpsroom", 1, &a, "start", json!({"minutes": 3, "kills": 10})).await;
    let m = until_where(&mut wb, "fps", |m| m["match"]["phase"] == "warmup").await["match"].clone();
    assert_eq!((m["minutes"].as_i64(), m["limit"].as_i64()), (Some(3), Some(10)));
    assert_eq!(m["players"].as_array().unwrap().len(), 2);
    assert!(e.hub.registry().get("fps:fpsroom").is_some());
    e.advance(COUNTDOWN + 0.01);
    until(&mut wa, "go").await;
    until(&mut wb, "go").await;
    let t = e.now();
    e.hub.with_room("fpsroom", |v| {
        put(&mut v.fps, "fps-a", 5.0, 0.0, 16.0, t, None);
        put(&mut v.fps, "fps-b", 5.0, 0.0, 9.0, t, None);
    });
    let mut q = 5000;
    for n in 1..10 {
        q += 11;
        e.advance(0.11);
        e.send("fpsroom", 1, &a, "fire", shot([5.0, EYE, 16.0], [5.0, 1.0, 9.0], q, 0, 100, n)).await;
    }
    let kill = until(&mut wb, "kill").await;
    assert_eq!((kill["k"].as_str(), kill["v"].as_str(), kill["kills"].as_i64()), (Some("fps-a"), Some("fps-b"), Some(1)));
    until_where(&mut wa, "snap", |m| m["s"].as_array().unwrap().iter().any(|s| s[5].as_i64().unwrap() >= 0)).await;
    e.advance(RESPAWN + 0.05);
    let sp = until(&mut wb, "spawn").await;
    assert_eq!((sp["user"].as_str(), sp["e"].as_i64()), (Some("fps-b"), Some(2)));
    e.send("fpsroom", 2, &b, "leave", json!({})).await; // alone now: the round is over
    let done = until(&mut wa, "done").await;
    assert_eq!(done["results"][0]["user"]["userId"], "fps-a");
    assert_eq!(done["results"][0]["kills"], 1);
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(e.hub.registry().get("fps:fpsroom").is_none(), "the loop stops with the match");
}

#[tokio::test]
async fn a_teleport_gets_a_fix_end_stops_the_loop_and_a_full_arena_says_so() {
    let e = env(MAX_TICKERS);
    let (a, mut wa) = e.connect("fpsfix", 1, "a").await;
    e.send("fpsfix", 1, &a, "join", json!({})).await;
    until(&mut wa, "fps").await;
    e.send("fpsfix", 1, &a, "start", json!({})).await;
    until_where(&mut wa, "fps", |m| m["match"]["phase"] == "warmup").await;
    e.advance(COUNTDOWN + 0.01);
    until(&mut wa, "go").await;
    e.send("fpsfix", 1, &a, "pos", frame(15.0, 0.0, 15.0, None)).await;
    let fix = until(&mut wa, "fix").await;
    assert!(fix.get("x").is_some() && fix.get("e").is_some());
    e.send("fpsfix", 1, &a, "end", json!({})).await;
    assert_eq!(until(&mut wa, "fps").await["match"]["phase"], "idle");
    assert!(e.hub.registry().get("fps:fpsfix").is_none());
    let e = env(0);
    let (a, mut wa) = e.connect("busy", 1, "a").await;
    e.send("busy", 1, &a, "join", json!({})).await;
    e.send("busy", 1, &a, "start", json!({})).await;
    assert_eq!(until(&mut wa, "error").await["error"], "the Arena is busy right now: try again in a minute");
}

#[tokio::test]
async fn a_dropped_socket_keeps_the_score_and_a_rejoin_drops_back_in() {
    let e = env(MAX_TICKERS);
    let (a, mut wa) = e.connect("blip", 1, "a").await;
    let (b, _wb) = e.connect("blip", 2, "b").await;
    let (c, _wc) = e.connect("blip", 3, "c").await;
    for (conn, m) in [(1, &a), (2, &b), (3, &c)] {
        e.send("blip", conn, m, "join", json!({})).await;
    }
    e.send("blip", 1, &a, "start", json!({})).await;
    e.advance(COUNTDOWN + 0.01);
    until(&mut wa, "go").await;
    e.hub.with_room("blip", |v| v.fps.player_mut("b").unwrap().kills = 3);
    e.hub.on_disconnect("blip", 2, &b).await;
    e.rooms.leave("blip", 2).await;
    let left = until_where(&mut wa, "fps", |m| m["left"] == "b").await;
    let pb = left["match"]["players"].as_array().unwrap().iter().find(|p| p["user"]["userId"] == "b").unwrap().clone();
    assert_eq!((pb["away"].as_bool(), pb["kills"].as_i64()), (Some(true), Some(3)));
    let (b2, _wb2) = e.connect("blip", 4, "b").await;
    e.send("blip", 4, &b2, "join", json!({})).await;
    let back = until_where(&mut wa, "fps", |m| m["back"] == "b").await;
    let pb = back["match"]["players"].as_array().unwrap().iter().find(|p| p["user"]["userId"] == "b").unwrap().clone();
    assert_eq!((pb["away"].as_bool(), pb["kills"].as_i64()), (Some(false), Some(3)));
    assert_eq!(e.hub.with_room("blip", |v| v.fps.players.len()), Some(3));
}
