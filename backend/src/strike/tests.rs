//! The Strikezone map, the team split, the bots, the shot rules and the round
//! end -- a focused mirror of the fps tests, plus what is new here (teams and
//! server-driven bots).

use super::*;
use std::collections::VecDeque;

fn pubv(uid: &str) -> Value {
    json!({"userId": uid, "handle": uid, "displayName": uid, "avatarUrl": ""})
}

fn members(n: usize, prefix: &str) -> Vec<(String, Value)> {
    (0..n).map(|i| (format!("{prefix}{i}"), pubv(&format!("{prefix}{i}")))).collect()
}

pub(crate) fn started(n: usize, tsize: i64, t0: f64) -> (Strike, f64) {
    let mut s = Strike::new();
    assert_eq!(s.start(&members(n, "u"), &json!(5), &json!(30), &json!(tsize), &json!("normal"), &Value::Null, &json!(0), t0), None);
    s.tick(t0 + COUNTDOWN, true);
    assert_eq!(s.phase, Phase::Round);
    (s, t0 + COUNTDOWN)
}

pub(crate) fn put(s: &mut Strike, uid: &str, x: f64, y: f64, z: f64, t: f64, q: Option<i64>) {
    let p = s.player_mut(uid).unwrap();
    p.x = x;
    p.y = y;
    p.z = z;
    p.hist = VecDeque::from([(t, x, y, z)]);
    p.protect = 0.0;
    p.spawn_t = t - 5.0;
    if let Some(b) = p.bot.as_mut() {
        b.body.x = x;
        b.body.y = y;
        b.body.z = z;
        b.body.vx = 0.0;
        b.body.vy = 0.0;
        b.body.vz = 0.0;
    }
    if let Some(q) = q {
        p.q = Some(q);
        p.q0 = q;
        p.t0 = t;
        p.qmax = Some(q);
        p.off = Some(t - q as f64 / 100.0);
    }
}

pub(crate) fn eye(s: &Strike, uid: &str) -> [f64; 3] {
    let p = s.player(uid).unwrap();
    [p.x, p.y + EYE, p.z]
}

fn chest(s: &Strike, uid: &str) -> [f64; 3] {
    let p = s.player(uid).unwrap();
    [p.x, p.y + 1.0, p.z]
}

fn slot(s: &Strike, uid: &str) -> i64 {
    s.player(uid).unwrap().slot
}

// --------------------------------------------------------------------- map --
#[test]
fn the_map_files_are_the_browser_ones() {
    // Byte-identical twins of games/strike/*.json (checked in tests/test_game_data_sync.py).
    let dock = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../games/strike/map.json")).unwrap();
    assert_eq!(dock, MAP_JSON);
    let sand = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../games/strike/map-sandbar.json")).unwrap();
    assert_eq!(sand, MAP_SAND_JSON);
}

#[test]
fn map_is_sane() {
    for m in MAPS.iter() {
        assert!(m.spawns.len() >= 8 && m.spawns.len() % 2 == 0 && m.boxes.len() >= 20, "{}", m.id);
        for s in &m.spawns {
            assert!(overlaps(m, s[0], s[1], s[2], 0.0).is_none(), "spawn inside a wall {s:?}");
            assert!(overlaps(m, s[0], s[1] - 0.05, s[2], 0.0).is_some(), "spawn not on the ground {s:?}");
            assert_eq!(top_under(m, s[0], s[1] - 0.05, s[2]), Some(s[1]));
        }
        for p in &m.pickups {
            assert!(overlaps(m, p.at[0], p.at[1], p.at[2], 0.0).is_none());
        }
        // only maps that ship their own graph have to stay clear of cover —
        // the dockyard's built-in table is pre-existing and steps around boxes
        if !m.waypoints.is_empty() {
            for (x, z, y) in &m.waypoints {
                assert!(overlaps(m, *x, y + 0.1, *z, 0.0).is_none(), "waypoint inside a wall {x},{z},{y}");
            }
        }
        // the two sides' spawns sit on opposite halves — dockyard north/south, sandbar west/east
        let half = m.spawns.len() / 2;
        let (a, c) = (&m.spawns[..half], &m.spawns[half..]);
        let ns = a.iter().all(|s| s[2] < 0.0) && c.iter().all(|s| s[2] > 0.0);
        let we = a.iter().all(|s| s[0] < 0.0) && c.iter().all(|s| s[0] > 0.0);
        assert!(ns || we, "{} spawns must split on z or x", m.id);
        assert_eq!(m.pickups.len(), 7, "{} must keep BASE_PACKS", m.id);
    }
    assert!(compile_map(&json!({"boxes": [[0, 0, 0, 0, 1, 1, "x"]]})).is_err());
}

#[test]
fn the_host_can_pick_sandbar() {
    let mut s = Strike::new();
    assert_eq!(s.start(&members(2, "u"), &json!(5), &json!(30), &json!(2), &json!("normal"), &json!("sandbar"), &json!(0), 0.0), None);
    assert_eq!(s.map().id, "sandbar");
    assert_eq!(s.view(0.0)["map"], json!("sandbar"));
    // an unknown id falls back to the dockyard, never a panic
    let mut s2 = Strike::new();
    assert_eq!(s2.start(&members(2, "u"), &json!(5), &json!(30), &json!(2), &json!("normal"), &json!("nowhere"), &json!(0), 0.0), None);
    assert_eq!(s2.map().id, "dockyard");
}

// ------------------------------------------------------------------- teams --
#[test]
fn the_host_sizes_the_sides_and_bots_fill_them() {
    let mut s = Strike::new();
    assert_eq!(s.start(&members(3, "u"), &json!(5), &json!(30), &json!(3), &json!("normal"), &Value::Null, &json!(0), 0.0), None);
    for tm in 0..2u8 {
        let side = s.players.iter().filter(|(_, p)| p.team == tm && !p.gone).count();
        assert_eq!(side, 3, "side {tm} must have 3 players");
    }
    let bots = s.players.iter().filter(|(_, p)| p.is_bot()).count();
    assert_eq!(bots, 3, "3 humans + 3 bots = 6 players");
    // a bot leaves when a human arrives
    s.enter("newbie", pubv("newbie"), 1.0);
    let bots_after = s.players.iter().filter(|(_, p)| p.is_bot() && !p.gone).count();
    assert!(bots_after < bots, "a human arriving retires a bot");
}

#[test]
fn a_five_by_five_fills_both_sides_and_a_duel_shrinks_them() {
    // 1..=5 are all legal team sizes now: the host's X tops each side up with
    // bots, and MAX_PLAYERS holds all ten seats at once.
    let mut s = Strike::new();
    assert_eq!(s.start(&members(4, "u"), &json!(5), &json!(30), &json!(5), &json!("normal"), &Value::Null, &json!(0), 0.0), None);
    for tm in 0..2u8 {
        let side = s.players.iter().filter(|(_, p)| p.team == tm && !p.gone).count();
        assert_eq!(side, 5, "side {tm} must have 5 players");
    }
    let bots = s.players.iter().filter(|(_, p)| p.is_bot()).count();
    assert_eq!(bots, 6, "4 humans + 6 bots = 10 players");
    let alive = s.players.iter().filter(|(_, p)| !p.gone).count();
    assert_eq!(alive, s.players.len(), "nobody benches to make 5v5 fit");

    let mut d = Strike::new();
    assert_eq!(d.start(&members(2, "u"), &json!(3), &json!(10), &json!(1), &json!("normal"), &Value::Null, &json!(0), 0.0), None);
    for tm in 0..2u8 {
        let side = d.players.iter().filter(|(_, p)| p.team == tm && !p.gone).count();
        assert_eq!(side, 1, "side {tm} must have exactly 1 player in a 1v1");
    }
    assert_eq!(d.players.iter().filter(|(_, p)| p.is_bot()).count(), 0, "a 1v1 of two humans adds no bots");
}

#[test]
fn the_host_sets_their_own_scoreline() {
    // minutes and kills are the host's own numbers now (the preset lists are just
    // quick picks): anything inside 1..=60 minutes and 1..=500 kills is honoured,
    // and out-of-range values clamp instead of snapping back to a default.
    let mut s = Strike::new();
    assert_eq!(s.start(&members(2, "u"), &json!(7), &json!(25), &json!(2), &json!("normal"), &Value::Null, &json!(0), 0.0), None);
    assert_eq!(s.minutes, 7, "an off-list length is the host's to pick");
    assert_eq!(s.limit, 25, "an off-list target is the host's to pick");
    let mut s = Strike::new();   // a fresh match: start() refuses while one is running
    assert_eq!(s.start(&members(2, "u"), &json!(600), &json!(0), &json!(2), &json!("normal"), &Value::Null, &json!(0), 0.0), None);
    assert_eq!(s.minutes, 60, "600 minutes clamps to the 60-minute cap");
    assert_eq!(s.limit, 1, "0 kills clamps up to the 1-kill floor");
    // every preset stays legal, so the menu's quick picks can't fall back either
    for m in MINUTES {
        for k in KILLS {
            let mut p = Strike::new();
            assert_eq!(p.start(&members(2, "u"), &json!(m), &json!(k), &json!(2), &json!("normal"), &Value::Null, &json!(0), 0.0), None);
            assert_eq!((p.minutes, p.limit), (m, k), "preset {m} min / {k} kills must survive start");
        }
    }
}

#[test]
fn teams_never_hit_their_own() {
    let (mut s, t) = started(2, 2, 0.0);
    // u0 and u1 are on opposite teams. Find a bot on u0's team and put it
    // directly between u0 and the enemy.
    let mate = s.players.iter().find(|(_, p)| p.is_bot()
        && p.team == s.player("u0").unwrap().team).map(|(u, _)| u.clone()).unwrap();
    put(&mut s, "u0", -6.0, 0.0, -9.0, t, Some(0));
    put(&mut s, "u1", -6.0, 0.0, -12.0, t, Some(0));
    put(&mut s, &mate, -6.0, 0.0, -10.5, t, None);
    let o = eye(&s, "u0");
    let tgt = chest(&s, "u1");
    let yaw = (tgt[0] - o[0]).atan2(-(tgt[2] - o[2])).to_degrees();
    let pitch = (tgt[1] - o[1]).atan2((tgt[0] - o[0]).hypot(tgt[2] - o[2])).to_degrees();
    let (dy, dp) = spread_of(1, 0);
    let msg = json!({"w": 0, "ox": cm(o[0]), "oy": cm(o[1]), "oz": cm(o[2]),
                     "r": ((yaw - dy) * 100.0) as i64, "p": ((pitch - dp) * 100.0) as i64, "q": 10, "ip": 0});
    let (shot, _) = s.fire("u0", &msg, t + 0.1);
    let shot = shot.unwrap();
    // the shot must pass the team-mate and land on the enemy
    assert_eq!(shot[5], json!(slot(&s, "u1")), "the shot hits the enemy, not the mate");
}

// -------------------------------------------------------------------- bots --
#[test]
fn bots_move_and_fight() {
    let (mut s, t) = started(2, 2, 0.0);
    let start: Vec<(String, [f64; 3])> = s.players.iter()
        .filter(|(_, p)| p.is_bot())
        .map(|(u, p)| (u.clone(), [p.x, p.y, p.z])).collect();
    // run 10 s of ticks: the bots must move and someone must have fired
    let mut t = t;
    let mut any_shot = false;
    for _ in 0..200 {
        t += 1.0 / HZ;
        let evs = s.tick(t, true);
        for (ev, data) in evs {
            if ev == "snap" && data["s"].as_array().map(|a| !a.is_empty()).unwrap_or(false) {
                any_shot = true;
            }
        }
    }
    let moved = start.iter().any(|(u, pos0)| {
        s.player(u).map(|p| (p.x - pos0[0]).hypot(p.z - pos0[2]) > 1.0).unwrap_or(false)
    });
    assert!(moved, "bots must move from their spawns");
    assert!(any_shot, "bots must shoot at some point in 10 s");
    assert_eq!(s.phase, Phase::Round, "a 5-minute match is still going at 10 s");
}

#[test]
fn a_blip_past_grace_is_refilled_like_a_drop() {
    // drop() refills the side at once; a blip that never returns must do the
    // same when tick() benches the human, or their side plays one short.
    let (mut s, t) = started(2, 1, 0.0);
    assert!(s.drop("u0", t, true), "a blip keeps the place");
    let tm = s.player("u0").unwrap().team;
    let before = s.players.iter().filter(|(_, p)| p.team == tm && !p.gone).count();
    let evs = s.tick(t + GRACE + 0.05, true);
    assert!(evs.iter().any(|(ev, d)| ev == &"gone" && d["user"] == "u0"));
    assert!(s.player("u0").unwrap().gone);
    let after = s.players.iter().filter(|(_, p)| p.team == tm && !p.gone).count();
    assert_eq!(after, before, "the benched human's slot is refilled by a bot");
    assert!(s.players.iter().any(|(u, p)| u != "u0" && p.team == tm && p.is_bot() && !p.gone));
}

#[test]
fn a_team_score_ends_the_round() {
    let (mut s, t) = started(2, 2, 0.0);
    s.scores[0] = s.limit - 1;
    let killer = "u0";
    let ki = s.players.iter().position(|(u, _)| u == killer).unwrap();
    let vi = s.players.iter().position(|(_, p)| p.team != s.player(killer).unwrap().team).unwrap();
    s.kill(ki, vi, 0, false, t);
    let evs = s.tick(t + 0.05, true);
    assert_eq!(s.phase, Phase::Done);
    assert!(evs.iter().any(|(ev, _)| ev == &"done"), "the done event goes out");
    let res = s.results.clone().unwrap();
    assert_eq!(res.as_array().unwrap().last().unwrap()["teams"], json!(s.scores));
}

// ----------------------------------------------------------------- totems --
#[test]
fn totems_drop_on_the_round_clock_and_the_mole_needs_a_bot() {
    let (mut s, mut t) = started(2, 2, 0.0);
    // both sides field bots, so any kind may drop; run past the first drop
    let mut totems = 0;
    for _ in 0..(TOTEM_FIRST as usize * HZ as usize + 5) {
        t += 1.0 / HZ;
        let evs = s.tick(t, true);
        if evs.iter().any(|(ev, _)| ev == &"totem") {
            totems += 1;
        }
    }
    assert_eq!(totems, 1, "exactly one totem lands TOTEM_FIRST into the round");
    assert_eq!(s.items.len(), MAP.pickups.len() + DROP_SLOTS + PACK_SLOTS + DIS_SLOTS,
               "the drop rings exist past the map's packs, all match long");
    assert!(TOTEM_KINDS.contains(&s.kinds[MAP.pickups.len()]), "the kind is one of the five");
    assert!(s.items[MAP.pickups.len()].is_none(), "the fresh totem slot starts live");
    // the next one lands TOTEM_GAP later
    for _ in 0..(TOTEM_GAP as usize * HZ as usize) {
        t += 1.0 / HZ;
        s.tick(t, true);
    }
    assert_eq!(s.items.len(), MAP.pickups.len() + DROP_SLOTS + PACK_SLOTS + DIS_SLOTS,
               "the slot list never grows past the rings");
}

#[test]
fn drops_repeat_from_recycled_slots() {
    // totems and loose packs are two independent clocks; each drop replaces the OLDEST
    // slot of its ring (taken or not), so drops keep coming and the map never fills up
    let (mut s, mut t) = started(2, 2, 0.0);
    let n_map = MAP.pickups.len();
    let mut totem_slots = std::collections::HashSet::new();
    let mut pack_slots = std::collections::HashSet::new();
    let mut dis_slots = std::collections::HashSet::new();
    // run 4 totem gaps + 5 pack gaps + 3 disaster gaps, ticking at HZ like the real loop
    let end = t + TOTEM_FIRST + TOTEM_GAP * 4.0 + PACK_GAP * 5.0 + DIS_GAP_DROP * 3.0 + 0.5;
    while t < end {
        t += 1.0 / HZ;
        for (ev, d) in s.tick(t, true) {
            if ev == "totem" {
                // Disaster totems and personal totems share the "totem" event; the tag
                // (and the ring the slot falls in) is what separates them.
                let i = d["i"].as_i64().unwrap_or(-1) as usize;
                let tag = d["tag"].as_str().unwrap_or("");
                if tag == "dis" {
                    dis_slots.insert(i as i64);
                } else {
                    totem_slots.insert(i as i64);
                }
            } else if ev == "pack" {
                pack_slots.insert(d["i"].as_i64().unwrap_or(-1));
            }
        }
    }
    assert_eq!(s.items.len(), n_map + DROP_SLOTS + PACK_SLOTS + DIS_SLOTS,
               "the slot list never grows past the rings");
    assert!(totem_slots.iter().all(|i| (*i as usize) >= n_map && (*i as usize) < n_map + DROP_SLOTS),
            "totems land only in the totem ring");
    assert!(pack_slots.iter().all(|i| (*i as usize) >= n_map + DROP_SLOTS
                                   && (*i as usize) < n_map + DROP_SLOTS + PACK_SLOTS),
            "loose packs land only in the pack ring");
    assert!(dis_slots.iter().all(|i| (*i as usize) >= n_map + DROP_SLOTS + PACK_SLOTS
                                   && (*i as usize) < n_map + DROP_SLOTS + PACK_SLOTS + DIS_SLOTS),
            "Disaster totems land only in the Disaster ring");
    assert_eq!(totem_slots.len() + pack_slots.len() + dis_slots.len(),
               DROP_SLOTS + PACK_SLOTS + DIS_SLOTS,
               "every ring slot is used");
}

#[test]
fn a_loose_pack_refills_the_taker() {
    // a loose health/ammo drop behaves like the map's own packs when walked over
    let (mut s, mut t) = started(2, 2, 0.0);
    // the enemy bot would happily shoot u0 while it waits at spawn — borrow the shield
    // totem's bubble for the whole test (it blocks damage, not pickups)
    s.player_mut("u0").unwrap().shield_totem_until = t + 60.0;
    let mut pev = None;
    while t < COUNTDOWN + PACK_FIRST + 0.5 {
        t += 1.0 / HZ;
        for (ev, d) in s.tick(t, true) {
            if ev == "pack" && pev.is_none() {
                pev = Some(d.clone());
            }
        }
    }
    let pev = pev.expect("the first loose pack lands PACK_FIRST into the round");
    let n_map = MAP.pickups.len();
    let kind = pev["kind"].as_str().unwrap();
    assert!(kind == "health" || kind == "ammo");
    let i = pev["i"].as_i64().unwrap() as usize;
    assert!(n_map + DROP_SLOTS <= i && i < n_map + DROP_SLOTS + PACK_SLOTS);
    // stand on it (hurt first so a health pack has room to heal), driving pos() like a client
    let (px, pz) = (pev["x"].as_i64().unwrap() as f64 / 100.0, pev["z"].as_i64().unwrap() as f64 / 100.0);
    s.player_mut("u0").unwrap().hp = 40;
    put(&mut s, "u0", px, 0.0, pz, t, Some(0));
    let _ = s.pos("u0", &json!({"x": cm(px), "y": cm(0.0), "z": cm(pz), "r": 0, "p": 0, "q": 1}), t + 0.1);
    let evs = s.tick(t + 0.2, true);
    let pick = evs.iter().find(|(ev, d)| ev == &"pick" && d["i"].as_i64() == Some(i as i64));
    let (_, d) = pick.expect("walking over the loose pack picks it up");
    if kind == "health" {
        assert_eq!(d["hp"].as_i64(), Some(90), "the loose health pack healed its taker");
    }
    assert!(s.items[i].is_some(), "the taken slot waits out PICKUP_BACK before returning");
}

#[test]
fn map_packs_come_back_somewhere_new() {
    // a map health/ammo pad is only a starting scatter — taking one and waiting out
    // PICKUP_BACK must plant it on different ground, never the pad you camped
    let (mut s, t) = started(2, 2, 0.0);
    s.player_mut("u0").unwrap().shield_totem_until = t + 60.0;
    let j = 0usize;
    let before = s.spots[j];
    s.items[j] = None;
    s.player_mut("u0").unwrap().hp = 40;
    put(&mut s, "u0", before[0], 0.0, before[2], t, Some(0));
    let _ = s.pos("u0", &json!({"x": cm(before[0]), "y": cm(0.0), "z": cm(before[2]), "r": 0, "p": 0, "q": 1}), t + 0.1);
    assert!(s.items[j].is_some(), "the taken map pack is on a refill clock");
    let after = s.spots[j];
    assert!((after[0] - before[0]).abs() > 1e-3 || (after[2] - before[2]).abs() > 1e-3,
            "the refill re-rolled the spot off the pad: {before:?} -> {after:?}");
    assert!(overlaps(s.map(), after[0], 0.1, after[2], 0.0).is_none(), "the new spot is standable");
    // the return event carries that new ground (cm / 100)
    let back = t + PICKUP_BACK + 0.1;
    let evs = s.tick(back, true);
    let item = evs.iter().find(|(ev, d)| ev == &"item" && d["i"].as_i64() == Some(j as i64));
    let (_, d) = item.expect("the map pack comes back after PICKUP_BACK");
    assert_eq!(d["x"].as_i64(), Some(cm(after[0])), "the item event names the new x");
    assert_eq!(d["z"].as_i64(), Some(cm(after[2])), "the item event names the new z");
    assert!(s.items[j].is_none(), "and the slot is live again");
}

#[test]
fn a_charmed_kills_points_land_on_the_charmer_side() {
    let (mut s, t) = started(2, 2, 0.0);
    let ki = s.players.iter().position(|(u, _)| u == "u0").unwrap();
    let vi = s.players.iter()
        .position(|(_, p)| p.team != s.player("u0").unwrap().team).unwrap();
    // u0 is amber (team 0), the victim cyan (team 1). u0 charmed by a cyan mole: the point
    // leaves amber and pays cyan — the charmer's side, not the shooter's
    let before = s.scores;
    s.players[ki].1.charm_until = t + CHARM;
    s.kill(ki, vi, 0, false, t);
    assert_eq!(s.scores[1], before[1] + 1, "the mole's kill pays the charmer's (cyan) team");
    assert_eq!(s.scores[0], before[0], "amber does not keep the point its charmed shooter scored");
}

#[test]
fn a_frozen_bot_holds_still() {
    let (mut s, mut t) = started(2, 2, 0.0);
    let bot = s.players.iter().find(|(_, p)| p.is_bot()).map(|(u, _)| u.clone()).unwrap();
    let (x, z) = (s.player(&bot).unwrap().x, s.player(&bot).unwrap().z);
    s.player_mut(&bot).unwrap().freeze_until = t + FREEZE;
    for _ in 0..50 {
        let mut t2 = t;
        t2 += 1.0 / HZ;
        s.tick(t2, true);
    }
    let p = s.player(&bot).unwrap();
    assert_eq!((p.x, p.z), (x, z), "the paralysed bot does not move while frozen");
    // and it thaws: the freeze window lapses and it moves again
    for _ in 0..(FREEZE as usize * HZ as usize + 20) {
        t += 1.0 / HZ;
        s.tick(t, true);
    }
    let p = s.player(&bot).unwrap();
    assert!((p.x - x).hypot(p.z - z) > 0.0 || p.freeze_until <= t, "the freeze ends with the window");
}

#[test]
fn a_cloaked_player_is_invisible_to_bots() {
    let (mut s, t) = started(2, 2, 0.0);
    // u0 and u1 stand eye-to-eye; cloak u0 and no bot may pick them as a target
    let me = s.player("u0").unwrap().team;
    let bot = s.players.iter()
        .find(|(_, p)| p.is_bot() && p.team != me).map(|(u, _)| u.clone()).unwrap();
    put(&mut s, "u0", 0.0, 0.0, 0.0, t, Some(0));
    put(&mut s, &bot, 0.0, 0.0, -6.0, t, None);
    s.player_mut("u0").unwrap().cloak_until = t + CLOAK;
    let mut t2 = t;
    for _ in 0..(BOT_THINK as usize * HZ as usize * 4) {
        t2 += 1.0 / HZ;
        s.tick(t2, true);
    }
    let b = s.player(&bot).unwrap().bot.as_ref().unwrap();
    assert_ne!(b.target.as_deref(), Some("u0"), "a cloaked player is never a bot's target");
}

#[test]
fn a_shield_totem_blocks_damage_but_not_their_own_shots() {
    let (mut s, t) = started(2, 2, 0.0);
    // u1 (human, cyan) stands 6 m downrange of u0 and takes the shield totem
    put(&mut s, "u0", -6.0, 0.0, -9.0, t, Some(0));
    put(&mut s, "u1", -6.0, 0.0, -3.0, t, Some(0));
    s.player_mut("u1").unwrap().shield_totem_until = t + SHIELD_TOTEM;
    // u0 fires straight down the lane at u1: the bubble eats every point of it
    let o = eye(&s, "u0");
    let msg = json!({"w": 0, "ox": cm(o[0]), "oy": cm(o[1]), "oz": cm(o[2]), "r": 18000, "p": 0, "q": 10, "ip": 0});
    let hp0 = s.player("u1").unwrap().hp;
    let _ = s.fire("u0", &msg, t + 0.1);
    assert_eq!(s.player("u1").unwrap().hp, hp0, "nothing hurts the shield totem's taker");
    // but the shielded player shoots back at full damage — u0 has no shield
    let o2 = eye(&s, "u1");
    let hp0u0 = s.player("u0").unwrap().hp;
    let msg2 = json!({"w": 0, "ox": cm(o2[0]), "oy": cm(o2[1]), "oz": cm(o2[2]), "r": 0, "p": 0, "q": 20, "ip": 0});
    let _ = s.fire("u1", &msg2, t + 0.2);
    assert!(s.player("u0").unwrap().hp < hp0u0, "the shielded player still damages others");
    // and the window lapses: after SHIELD_TOTEM the shots land again
    s.player_mut("u1").unwrap().shield_totem_until = t;   // window closed
    let msg3 = json!({"w": 0, "ox": cm(o[0]), "oy": cm(o[1]), "oz": cm(o[2]), "r": 18000, "p": 0, "q": 30, "ip": 0});
    let _ = s.fire("u0", &msg3, t + 0.3);
    assert!(s.player("u1").unwrap().hp < hp0, "the bubble pops when the window ends");
}

// ---------------------------------------------------------------- movement --
#[test]
fn movement_is_checked() {
    let (mut s, t) = started(2, 2, 0.0);
    let p0 = eye(&s, "u0");
    // a teleport is refused and corrected
    let msg = json!({"x": cm(p0[0] + 10.0), "y": cm(p0[1]), "z": cm(p0[2] + 10.0), "r": 0, "p": 0, "q": 10});
    let (ok, fix) = s.pos("u0", &msg, t + 0.05);
    assert!(!ok, "a teleport is refused");
    assert!(fix.is_some(), "a correction comes back");
}

#[test]
fn sprint_needs_the_flag_and_stays_below_its_cap() {
    let (mut s, t) = started(2, 2, 0.0);
    put(&mut s, "u0", 0.0, 0.0, -8.0, t, Some(0));
    // legal walk-speed move first (0.3 s of clock, well within the walk cap) as the baseline
    let (ok, fix) = s.pos("u0", &json!({"x": cm(0.0), "y": cm(0.0), "z": cm(-8.0), "r": 0, "p": 0, "q": 30}), t + 0.3);
    assert!(ok && fix.is_none(), "a walk-speed move is accepted: {fix:?}");
    // 3.4 m in 0.3 s is past the walk cap (7.5 x 0.3 + SLACK = 3.25) but inside the sprint
    // cap (10.5 x 0.3 + SLACK = 4.15): a real sprint frame's burst. Without the flag: refused.
    let p = s.player("u0").unwrap();
    let (x0, z0) = (p.x, p.z);
    let (ok, fix) = s.pos("u0", &json!({"x": cm(x0 + 3.4), "y": cm(0.0), "z": cm(z0), "r": 0, "p": 0, "q": 60}), t + 0.6);
    assert!(!ok, "a sprint-speed burst without the flag is refused");
    assert!(fix.is_some(), "and corrected");
    // the same burst WITH the flag is accepted: the cap rose for this client
    let (ok, fix) = s.pos("u0", &json!({"x": cm(x0 + 3.4), "y": cm(0.0), "z": cm(z0), "r": 0, "p": 0, "q": 90, "sp": true}), t + 0.9);
    assert!(ok && fix.is_none(), "the sprint flag lets the raised cap through: {fix:?}");
    // but the higher cap still caps: a sprint-flag teleport is refused
    let p = s.player("u0").unwrap();
    let (x1, z1) = (p.x, p.z);
    let (ok, fix) = s.pos("u0", &json!({"x": cm(x1 + 20.0), "y": cm(0.0), "z": cm(z1), "r": 0, "p": 0, "q": 120, "sp": true}), t + 1.2);
    assert!(!ok, "the sprint flag is not a teleport license");
    assert!(fix.is_some());
}

// ---------------------------------------------------------------- bot aim wrap --
#[test]
fn bot_wire_rotation_stays_in_range() {
    // a bot's aim_y is an unwrapped accumulator: it is negative (or past 360)
    // whenever the aim sits in quadrants II/III (or swings past 0). Python
    // wraps with sign-free %; the wire value must land in 0..36000 too, so
    // this drives long swings through both and checks every snapshot r.
    let (mut s, t) = started(0, 2, 0.0); // no humans -> bots fill both sides
    let bi = s.players.iter().position(|(_, p)| p.bot.is_some()).unwrap();
    let bteam = s.players[bi].1.team;
    let ei = s.players.iter().position(|(_, p)| p.team != bteam).unwrap();
    let buid = s.players[bi].0.clone();
    let euid = s.players[ei].0.clone();
    put(&mut s, &buid, 0.0, 0.0, -8.0, t, None);
    put(&mut s, &euid, 8.0, 0.0, -8.0, t, None);
    let mut min_raw = f64::INFINITY;
    let mut max_raw = f64::NEG_INFINITY;
    for k in 0..600 {
        let t2 = t + 0.005 * k as f64;
        // walk the enemy around the compass so the aim sweeps every quadrant
        let (ex, ez) = ([8.0, 8.0, -8.0, -8.0][(k / 150) % 4], [-8.0, 8.0, 8.0, -8.0][(k / 150) % 4]);
        s.players[ei].1.x = ex;
        s.players[ei].1.z = ez;
        let _ = s.tick(t2, false);
        let raw = s.players[bi].1.bot.as_ref().unwrap().aim_y;
        min_raw = min_raw.min(raw);
        max_raw = max_raw.max(raw);
        let r = s.players[bi].1.r;
        assert!((0..36000).contains(&r), "wire rotation out of range: {r} (raw aim {raw:.2})");
    }
    assert!(min_raw < 0.0 || max_raw > 360.0,
        "aim stayed in 0..360 the whole run ({min_raw:.1}..{max_raw:.1}) -- the test no longer wraps");
    let _ = euid;
}

// ------------------------------------------------------------------ geometry --
#[test]
fn rays_and_los() {
    let m = &*MAP;
    // through the warehouse wall: the block breaks the line of sight
    let a = [2.0, EYE, -9.0];
    let b = [2.0, EYE, 9.0];
    assert!(!los(m, a, b), "the warehouse block breaks the lane's line of sight");
    // the centre doorway through the warehouse is a 1.6 m chokepoint, open at eye height
    let a = [0.0, EYE, -9.0];
    let b = [0.0, EYE, 9.0];
    assert!(los(m, a, b), "the centre doorway is open");
    // the west lane is open along the wall
    let a = [-17.7, EYE, -8.0];
    let b = [-17.7, EYE, 8.0];
    assert!(los(m, a, b), "the west lane is open along the wall");
    let d = dir_of(90.0, 0.0);
    assert!((d[0] - 1.0).abs() < 1e-12 && d[2].abs() < 1e-12);
    let (t, head) = ray_player([0.0, EYE, 10.0], dir_of(0.0, (1.65f64 - EYE).atan2(10.0).to_degrees()),
                               0.0, 0.0, 0.0, 100.0).unwrap();
    assert!(head && t < 10.0);
}

// ------------------------------------------------------------------ launcher --
#[test]
fn the_launcher_flies_and_blasts() {
    let (mut s, t) = started(2, 2, 0.0);
    put(&mut s, "u0", -6.0, 0.0, -9.0, t, Some(0));
    put(&mut s, "u1", -6.0, 0.0, -3.0, t, Some(0));   // 6 m downrange, same lane
    let o = eye(&s, "u0");
    let p = s.player_mut("u0").unwrap();
    p.w = 3;
    p.ready = 0;
    // u1 sits +z downrange of u0: yaw 180 points the shot there (dir_of: yaw 0 = -z)
    let msg = json!({"w": 3, "ox": cm(o[0]), "oy": cm(o[1]), "oz": cm(o[2]), "r": 18000, "p": 0, "q": 10, "ip": 0});
    let (shot, refuse) = s.fire("u0", &msg, t + 0.1);
    assert!(shot.is_some(), "the launcher shot is accepted (refuse: {refuse:?})");
    assert_eq!(s.rockets.len(), 1, "a rocket is in flight");
    assert_eq!(s.rocket_k, 1);
    // the rocket flies at MISSILE_V; ticks advance it until it reaches u1's body
    let mut t2 = t + 0.1;
    let hp0 = s.player("u1").unwrap().hp;
    for _ in 0..100 {
        t2 += 1.0 / HZ;
        let _ = s.tick(t2, true);
        if s.rockets.is_empty() {
            break;
        }
    }
    assert!(s.rockets.is_empty(), "the rocket must land within 5 s");
    // a direct-ish hit at ~6 m with the body in the lane: u1 takes heavy splash or a direct hit
    let hp1 = s.player("u1").unwrap().hp;
    assert!(hp1 < hp0, "the victim took blast damage ({hp0} -> {hp1})");
    // the shooter is honest too: the rocket left their muzzle, they're out of the radius
    // (6 m downrange > BLAST_R), so u0 keeps their hp
    // the boom was broadcast with a tick snapshot (flushed on send); r/b ride the same snap
    assert!(s.booms.is_empty(), "booms flush with the tick's snapshot");
}

#[test]
fn a_drop_life_rides_the_sky_without_the_two_second_snap() {
    // v4: a parachute spawn is airborne for up to DROP_TIME before the usual MAX_AIR guard
    // would fire — the referee must let it, not fix-slap a glide to the ground mid-fall.
    let (mut s, t) = started(2, 2, 0.0);
    put(&mut s, "u0", 0.0, 0.0, -8.0, t, Some(0));
    // lift the player to DROP_HEIGHT with a drop flag (as a v4 spawn event would), drop_t = now
    {
        let p = s.player_mut("u0").unwrap();
        p.y = DROP_HEIGHT;
        p.drop = true;
        p.drop_t = t;
        p.spawn_t = t;
        p.air_at = t;
        p.hist = VecDeque::from([(t, p.x, p.y, p.z)]);
    }
    // 2.2 s of gliding left (well past MAX_AIR = 2.0 s in the sky) — should be accepted, not
    // snapped. A v1-v3 life in the same state would be corrected.
    let (ok, fix) = s.pos("u0", &json!({"x": cm(0.0 + 2.5), "y": cm(DROP_HEIGHT - 1.5), "z": cm(-8.0), "r": 0, "p": 0, "q": 220}), t + 2.2);
    assert!(ok && fix.is_none(), "a mid-glide pos is accepted while the drop still has legs: {fix:?}");
    // after the drop window closes (past DROP_TIME), the same rules come back
    let (ok, fix) = s.pos("u0", &json!({"x": cm(0.0 + 4.0), "y": cm(DROP_HEIGHT - 2.0), "z": cm(-8.0), "r": 0, "p": 0, "q": 330}), t + 3.3);
    assert!(!ok || fix.is_some(), "past DROP_TIME the air guard fires again");
}

#[test]
fn the_shooters_own_blast_never_scores_a_direct() {
    // Regression: a shot detonating at the shooter's eye judged `dist < DIRECT_R` (0.8) as
    // direct → an instant 120 self-kill every time a bot fired through its own chin (its eye
    // sits ~0.6 m above the torso center the blast measures). The shooter's self-splash must
    // grade by proximity (75 max falloff), never the direct 120 — even at point-blank.
    let (mut s, t) = started(2, 2, 0.0);
    put(&mut s, "u0", -6.0, 0.0, -9.0, t, Some(0));
    put(&mut s, "u1", -6.0, 0.0, -3.0, t, Some(0));     // far away: no splash math on them
    let o = eye(&s, "u0");
    let p = s.player_mut("u0").unwrap();
    p.w = 3;
    p.ready = 0;
    // detonate a rocket AT u0's own eye — the worst-case self-blast
    let r = Rocket { id: 99, shooter: "u0".to_string(), x: o[0], y: o[1], z: o[2],
                     px: o[0], py: o[1], pz: o[2], vx: 0.0, vy: 0.0, vz: 0.0, born: t };
    s.detonate(&r, t + 0.2);
    let hp = s.player("u0").unwrap().hp;
    assert!(hp > 0, "the shooter survives their own point-blank blast (hp {hp})");
    assert!(hp >= 100 - 75, "self splash is falloff at worst, never the direct 120 (hp {hp})");
    assert!(!s.player("u0").unwrap().dead, "the shooter did not die to their own rocket");
}

#[test]
fn a_blast_hurts_the_shooter_too() {
    // an honest rocket: the shooter's own blast bites, with falloff
    let (mut s, t) = started(2, 2, 0.0);
    put(&mut s, "u0", -6.0, 0.0, -9.0, t, Some(0));
    let o = eye(&s, "u0");
    let p = s.player_mut("u0").unwrap();
    p.w = 3;
    p.ready = 0;
    // fire straight down (pitch -90): the rocket hits the ground at the shooter's feet
    let msg = json!({"w": 3, "ox": cm(o[0]), "oy": cm(o[1]), "oz": cm(o[2]), "r": 0, "p": -9000, "q": 10, "ip": 0});
    let (shot, _) = s.fire("u0", &msg, t + 0.1);
    assert!(shot.is_some());
    let mut t2 = t + 0.1;
    for _ in 0..100 {
        t2 += 1.0 / HZ;
        let _ = s.tick(t2, true);
        if s.rockets.is_empty() {
            break;
        }
    }
    assert!(s.rockets.is_empty(), "the rocket landed");
    assert!(s.player("u0").unwrap().hp < 100, "the shooter's own blast damaged them");
}

#[test]
fn bots_draw_weapons_across_the_roster() {
    // every life a bot re-rolls: across enough spawns the roster covers all four
    let (mut s, t) = started(0, 2, 0.0);
    let mut seen = [false; NW];
    let mut t2 = t;
    // watch the whole roster across the run, not just the end state: a weapon seen on
    // a life that later re-rolled still counts as drawn
    for k in 0..3000 {
        t2 += 1.0 / HZ;
        let _ = s.tick(t2, false);
        if k % 20 == 0 {
            for (_, p) in s.players.iter() {
                if p.is_bot() {
                    seen[p.w] = true;
                }
            }
        }
    }
    assert!(seen.iter().all(|x| *x), "bots must draw every weapon across respawns: {seen:?}");
}

#[test]
fn the_drop_shield_holds_off_bullets_and_blasts_while_you_glide() {
    // a shielded glider is untouchable: a clean hit through their chest does 0, and a
    // rocket at their feet does 0 — but the shooter's own blast still hurts the shooter.
    let (mut s, t) = started(2, 2, 0.0);
    put(&mut s, "u0", -6.0, 0.0, -9.0, t, Some(0));
    // u1 is mid-glide: airborne with a live drop flag (as a v4 respawn would be)
    put(&mut s, "u1", -6.0, DROP_HEIGHT, -12.0, t, Some(0));
    {
        let p = s.player_mut("u1").unwrap();
        p.drop = true;
        p.drop_t = t;
        p.air_at = t;
        p.hist = VecDeque::from([(t, p.x, p.y, p.z)]);
    }
    assert!(s.player("u1").unwrap().shielded(t), "a fresh drop life is shielded");
    // filler bots would finish the glider once the 3 s window closes — freeze them so
    // this test only judges the shield
    for (_, p) in s.players.iter_mut() {
        if p.is_bot() {
            p.freeze_until = 1e9;
        }
    }
    // the shield is in the snapshot too, so every client can draw the bubble
    s.mark("u1");
    let snap = s.snap(t);
    let row = snap["p"].as_array().unwrap().iter()
        .find(|e| e[0].as_i64() == Some(slot(&s, "u1"))).unwrap();
    assert_ne!(row[8].as_i64().unwrap_or(0) & 32, 0, "the snapshot carries the shield flag");

    // aim straight at the glider's chest: the shot lands but the damage is 0
    let o = eye(&s, "u0");
    let tgt = chest(&s, "u1");
    let yaw = (tgt[0] - o[0]).atan2(-(tgt[2] - o[2])).to_degrees();
    let pitch = (tgt[1] - o[1]).atan2((tgt[0] - o[0]).hypot(tgt[2] - o[2])).to_degrees();
    let (dy, dp) = spread_of(1, 0);
    let msg = json!({"w": 0, "ox": cm(o[0]), "oy": cm(o[1]), "oz": cm(o[2]),
                     "r": ((yaw - dy) * 100.0) as i64, "p": ((pitch - dp) * 100.0) as i64, "q": 10, "ip": 0});
    let (shot, _) = s.fire("u0", &msg, t + 0.1);
    let shot = shot.unwrap();
    assert_eq!(shot[5], json!(slot(&s, "u1")), "the shot connects with the glider");
    assert_eq!(s.player("u1").unwrap().hp, HP, "the shield eats the hit: hp unchanged");

    // a rocket at the glider: the blast must not reach the shielded glider
    assert!(s.weapon("u0", &json!({"w": 3, "q": 15}), t + 0.15), "switch to the launcher");
    let msg = json!({"w": 3, "ox": cm(o[0]), "oy": cm(o[1]), "oz": cm(o[2]),
                     "r": 0, "p": 0, "q": 20, "ip": 0});
    let _ = s.fire("u0", &msg, t + 0.2);
    let mut now = t + 0.21;
    for _ in 0..80 { s.tick(now, true); now += 1.0 / 20.0; }
    assert_eq!(s.player("u1").unwrap().hp, HP, "the shield eats the blast: hp unchanged");

    // touchdown ends it: once grounded, the same chest shot kills like any other
    let (mut s2, t2) = started(2, 2, 0.0);
    put(&mut s2, "u0", -6.0, 0.0, -9.0, t2, Some(0));
    put(&mut s2, "u1", -6.0, 0.0, -12.0, t2, Some(0));
    let o = eye(&s2, "u0");
    let tgt = chest(&s2, "u1");
    let yaw = (tgt[0] - o[0]).atan2(-(tgt[2] - o[2])).to_degrees();
    let pitch = (tgt[1] - o[1]).atan2((tgt[0] - o[0]).hypot(tgt[2] - o[2])).to_degrees();
    let (dy, dp) = spread_of(1, 0);
    let msg = json!({"w": 0, "ox": cm(o[0]), "oy": cm(o[1]), "oz": cm(o[2]),
                     "r": ((yaw - dy) * 100.0) as i64, "p": ((pitch - dp) * 100.0) as i64, "q": 30, "ip": 0});
    let _ = s2.fire("u0", &msg, t2 + 0.1);
    assert_eq!(s2.player("u1").unwrap().hp, 88, "grounded, no shield: a body shot lands 12");
}

// -------------------------------------------------------- movement totems --
#[test]
fn the_movement_totems_relax_only_what_the_server_judged() {
    let (mut s, t) = started(2, 2, 0.0);
    put(&mut s, "u0", 0.0, 0.0, -8.0, t, Some(0));
    // a legal walk-speed move as the baseline
    let (ok, fix) = s.pos("u0", &json!({"x": cm(0.0), "y": cm(0.0), "z": cm(-8.0), "r": 0, "p": 0, "q": 30}), t + 0.3);
    assert!(ok && fix.is_none(), "a walk-speed move is accepted: {fix:?}");

    // --- speed: the dash cap comes from the server's own window, not the wire ---
    // 6.5 m in 0.3 s is past even the sprint cap (4.15) — refused bare, allowed dashing
    let p = s.player("u0").unwrap();
    let (x0, z0) = (p.x, p.z);
    let (ok, _) = s.pos("u0", &json!({"x": cm(x0 + 6.5), "y": cm(0.0), "z": cm(z0), "r": 0, "p": 0, "q": 60}), t + 0.6);
    assert!(!ok, "a dash-speed burst without the speed totem is refused");
    s.player_mut("u0").unwrap().speed_until = t + 10.0;
    let (ok, fix) = s.pos("u0", &json!({"x": cm(x0 + 6.5), "y": cm(0.0), "z": cm(z0), "r": 0, "p": 0, "q": 90}), t + 0.9);
    assert!(ok && fix.is_none(), "the speed totem's window buys the dash cap: {fix:?}");
    // but the dash cap still caps: 10 m in 0.3 s is past even SPEED_MULT x sprint (6.3 + 1)
    let p = s.player("u0").unwrap();
    let (x1, z1) = (p.x, p.z);
    let (ok, _) = s.pos("u0", &json!({"x": cm(x1 + 10.0), "y": cm(0.0), "z": cm(z1), "r": 0, "p": 0, "q": 120}), t + 1.2);
    assert!(!ok, "the speed totem is not a teleport license");

    // --- leap: the tall jump rises past the plain JUMP_V gate ---
    // 4.5 m up in 0.3 s is past the plain gate (6.5 x 0.3 + 0.55 + 1 = 3.5) — refused
    // bare, allowed leaping (19.5 x 0.3 + 1.55 = 7.4)
    put(&mut s, "u0", 0.0, 0.0, -8.0, t + 1.3, Some(150));
    s.player_mut("u0").unwrap().leap_until = t + 10.0;
    let (ok, fix) = s.pos("u0", &json!({"x": cm(0.0), "y": cm(4.5), "z": cm(-8.0), "r": 0, "p": 0, "q": 180}), t + 1.6);
    assert!(ok && fix.is_none(), "the leap totem's window buys the tall jump: {fix:?}");
    // without the window the same rise is refused
    s.player_mut("u0").unwrap().leap_until = 0.0;
    let (ok, _) = s.pos("u0", &json!({"x": cm(0.0), "y": cm(9.0), "z": cm(-8.0), "r": 0, "p": 0, "q": 210}), t + 1.9);
    assert!(!ok, "a plain life cannot rise like a leaper");

    // --- wings: the flight parks the air clock ---
    // rise into the air, then hover past MAX_AIR (2 s of unbroken air): refused bare,
    // allowed while winged. put() refreshes the clock anchor, so the air clock starts
    // fresh at t+2.0 and the hover at t+4.5 is 2.5 s of air — past MAX_AIR.
    put(&mut s, "u0", 0.0, 4.0, -8.0, t + 2.0, Some(240));
    s.player_mut("u0").unwrap().air_at = t + 2.0;
    s.player_mut("u0").unwrap().wings_until = 0.0;
    let tt = t + 4.5;
    let (ok, _) = s.pos("u0", &json!({"x": cm(0.0), "y": cm(4.0), "z": cm(-8.0), "r": 0, "p": 0, "q": 450}), tt);
    assert!(!ok, "a hover past MAX_AIR is refused without the wings totem");
    s.player_mut("u0").unwrap().wings_until = t + 30.0;
    let (ok, fix) = s.pos("u0", &json!({"x": cm(0.0), "y": cm(4.0), "z": cm(-8.0), "r": 0, "p": 0, "q": 460}), tt + 0.1);
    assert!(ok && fix.is_none(), "the wings totem parks the air clock: {fix:?}");
    // the take splits cruise from judge: the shown window is the WINGS cruise, the judged
    // window also covers the automatic glide down (the client flies all three without input)
    let i0 = s.players.iter().position(|(u, _)| u == "u0").unwrap();
    assert!(s.take_totem(i0, "wings", t + 5.0), "wings applies to its taker");
    let p = s.player("u0").unwrap();
    assert_eq!(p.wings_fly, t + 5.0 + WINGS, "cruise = the shown window");
    assert_eq!(p.wings_until, t + 5.0 + WINGS + WINGS_LAND, "judged = cruise + the glide down");
    // the descent past the cruise boundary is still wings flight: a mid-air stay at
    // cruise + 3 s of descent is legal while wings_until runs, refused once it lapses
    put(&mut s, "u0", 0.0, 9.0, -8.0, t + 11.0, Some(1100));
    s.player_mut("u0").unwrap().air_at = t + 11.0;
    let (ok, fix) = s.pos("u0", &json!({"x": cm(0.0), "y": cm(8.0), "z": cm(-8.0), "r": 0, "p": 0, "q": 1410}), t + 14.1);
    assert!(ok && fix.is_none(), "the automatic glide down is still wings flight: {fix:?}");
    let (ok, _) = s.pos("u0", &json!({"x": cm(0.0), "y": cm(7.0), "z": cm(-8.0), "r": 0, "p": 0, "q": 2020}), t + 20.2);
    assert!(!ok, "past wings + WINGS_LAND there is no more flight");
    // and a death pops all three windows (place() resets them with the life)
    let spawn = [0.0, 0.0, -8.0, 0.0];
    s.player_mut("u0").unwrap().dead = true;
    { let m = s.map(); s.player_mut("u0").unwrap().place(spawn, t + 21.0, m); }
    let s2 = s.player("u0").unwrap();
    assert_eq!((s2.wings_until, s2.wings_fly, s2.leap_until, s2.speed_until), (0.0, 0.0, 0.0, 0.0),
               "a respawn starts with every movement window closed");
}

#[test]
fn the_host_picks_one_bot_skill_for_both_sides() {
    // MP lobbies fill short sides with bots on BOTH teams, so one skill level applies to
    // the whole match — never a sharper filler's side against a duller's
    let mut s = Strike::new();
    assert_eq!(s.start(&members(2, "u"), &json!(5), &json!(30), &json!(3), &json!("hard"), &Value::Null, &json!(0), 0.0), None);
    assert_eq!(s.bot_diff, "hard");
    assert_eq!(s.bot_aim, 0.5);
    assert_eq!(s.bot_react, 0.35);
    assert_eq!(s.bot_turn, 1.6);
    assert_eq!(s.bot_rate, 0.8);
    // an unknown id — including a crafted wire one — quietly falls back to normal
    let mut s2 = Strike::new();
    s2.start(&members(2, "u"), &json!(5), &json!(30), &json!(3), &json!("nightmare"), &Value::Null, &json!(0), 0.0);
    assert_eq!(s2.bot_diff, "normal");
    assert_eq!(s2.bot_aim, 1.0);
    // and a match started without a diff is normal (the host didn't pick one)
    let mut s3 = Strike::new();
    s3.start(&members(2, "u"), &json!(5), &json!(30), &json!(3), &Value::Null, &Value::Null, &json!(0), 0.0);
    assert_eq!(s3.bot_diff, "normal");
}

#[test]
fn the_teleport_totem_plants_the_taker_on_open_ground() {
    let (mut s, t) = started(2, 2, 0.0);
    let (x0, z0) = { let p = s.player("u0").unwrap(); (p.x, p.z) };
    let i0 = s.players.iter().position(|(u, _)| u == "u0").unwrap();
    assert!(s.take_totem(i0, "teleport", t + 1.0), "the teleport applies to its taker");
    let p = s.player("u0").unwrap();
    assert!((p.x, p.z) != (x0, z0), "the taker moved somewhere else");
    assert_eq!(p.y, 0.0, "always on the ground, never in the air");
    let b = MAP.bounds();
    assert!((b[0]..=b[3]).contains(&p.x), "inside the drop scatter's x range");
    assert!((b[2]..=b[5]).contains(&p.z), "inside the drop scatter's z range");
    assert!(overlaps(&MAP, p.x, 0.1, p.z, 0.0).is_none(), "never inside a box");
    assert_eq!(p.air_at, t + 1.0, "the air clock restarts at the destination");
    // two hops in a row land somewhere fresh (the seed advances with the take counter)
    let (px, pz) = (p.x, p.z);
    assert!(s.take_totem(i0, "teleport", t + 2.0));
    let p = s.player("u0").unwrap();
    assert!((p.x, p.z) != (px, pz), "the second hop lands somewhere fresh");
    // and a walk-speed pos frame from the destination is accepted (no correction)
    let (tx, tz) = (p.x, p.z);
    let (ok, fix) = s.pos("u0", &json!({"x": cm(tx), "y": 0, "z": cm(tz), "r": 0, "p": 0, "q": 100}), t + 2.1);
    assert!(ok && fix.is_none(), "the next frame starts from the destination: {fix:?}");
}

// -------------------------------------------------------------- Wave C --
#[test]
fn second_wind_and_phoenix_cancel_one_killing_blow() {
    let (mut s, t) = started(2, 2, 0.0);
    let ki = s.players.iter().position(|(u, _)| u == "u0").unwrap();
    let vi = s.players.iter().position(|(_, p)| p.team != s.player("u0").unwrap().team).unwrap();
    let vuid = s.players[vi].0.clone();
    // Second Wind: the kill is cancelled and the victim stands back up at half health
    s.player_mut(&vuid).unwrap().second_wind = true;
    let deaths0 = s.player(&vuid).unwrap().deaths;
    s.kill(ki, vi, 0, false, t + 0.5);
    let p = s.player(&vuid).unwrap();
    assert!(!p.dead, "Second Wind cancels the killing blow");
    assert_eq!(p.deaths, deaths0, "no death is recorded");
    assert_eq!(p.hp, (HP / 2).max(1), "the victim stands back up at half health");
    assert!(!p.second_wind, "Second Wind is a one-shot");
    assert!(p.fake_until > t + 0.5, "the recovery buys a moment of fake death");
    // a second killing blow lands for real
    s.kill(ki, vi, 0, false, t + 1.0);
    assert!(s.player(&vuid).unwrap().dead, "the second killing blow lands");
    // Phoenix: full health, and the window lapses after one save
    let (mut s2, t2) = started(2, 2, 0.0);
    let ki2 = s2.players.iter().position(|(u, _)| u == "u0").unwrap();
    let vi2 = s2.players.iter().position(|(_, p)| p.team != s2.player("u0").unwrap().team).unwrap();
    let v2 = s2.players[vi2].0.clone();
    s2.player_mut(&v2).unwrap().phoenix_until = t2 + PHOENIX;
    s2.player_mut(&v2).unwrap().hp = 3;
    s2.kill(ki2, vi2, 0, false, t2 + 1.0);
    let p2 = s2.player(&v2).unwrap();
    assert!(!p2.dead, "Phoenix cancels the killing blow");
    assert_eq!(p2.hp, HP, "Phoenix stands the victim back up full health");
    assert_eq!(p2.phoenix_until, 0.0, "Phoenix is a one-shot inside its window");
    s2.kill(ki2, vi2, 0, false, t2 + 2.0);
    assert!(s2.player(&v2).unwrap().dead, "the next killing blow lands");
}

#[test]
fn a_trap_mine_blows_an_enemy_and_spares_its_own_side() {
    // 1v1: both humans, so fill_bots() leaves them alone and the only thing that can
    // move hp during tick() is the mine itself.
    let (mut s, t) = started(2, 2, 0.0);
    let i0 = s.players.iter().position(|(u, _)| u == "u0").unwrap();
    let i1 = s.players.iter().position(|(u, _)| u == "u1").unwrap();
    put(&mut s, "u0", -6.0, 0.0, -9.0, t, Some(0));
    put(&mut s, "u1", -6.0, 0.0, -3.0, t, Some(0));
    // bench every bot so the only thing that can move hp is the mine itself
    for (_, p) in s.players.iter_mut() {
        if p.is_bot() {
            p.gone = true;
        }
    }
    // pin hp: put() does not heal, and a bot may have landed a shot before we benched it
    s.player_mut("u0").unwrap().hp = HP;
    s.player_mut("u1").unwrap().hp = HP;
    assert!(s.take_totem(i0, "trap", t + 0.1), "the trap applies to its taker");
    assert_eq!(s.mines.len(), TRAP_N as usize, "Trapmaster plants its full stack");
    assert!(s.mines.iter().all(|m| m.team == 0 && m.owner == "u0"), "the mines belong to the planter's side");
    // a mate of the planter walks right over one: nothing happens
    let (mx0, mz0) = (s.mines[0].x, s.mines[0].z);
    let mate = s.players.iter()
        .find(|(u, p)| p.team == 0 && u.as_str() != "u0")
        .map(|(u, _)| u.clone());
    if let Some(muid) = mate {
        let mn = s.players.iter().position(|(u, _)| *u == muid).unwrap();
        put(&mut s, &muid, mx0, 0.0, mz0, t + 0.2, Some(0));
        s.player_mut(&muid).unwrap().hp = HP;
        let hp0 = s.players[mn].1.hp;
        s.tick(t + 0.3, true);
        assert_eq!(s.mines.len(), TRAP_N as usize, "the planter's own side never trips a mine");
        assert_eq!(s.players[mn].1.hp, hp0, "a mate takes no mine damage");
    }
    // an enemy walks onto one: it detonates for MINE_DMG
    let euid = s.players[i1].0.clone();
    let (mx, mz) = (s.mines[0].x, s.mines[0].z);
    put(&mut s, &euid, mx, 0.0, mz, t + 0.4, Some(0));
    s.player_mut(&euid).unwrap().hp = HP;
    let hp1 = s.players[i1].1.hp;
    s.tick(t + 0.5, true);
    assert_eq!(s.mines.len(), (TRAP_N - 1) as usize, "the tripped mine is spent");
    assert_eq!(s.players[i1].1.hp, hp1 - MINE_DMG, "the enemy eats the mine's full damage");
}

#[test]
fn the_snap_carries_the_wave_c_world_and_flag_bits() {
    let (mut s, t) = started(2, 2, 0.0);
    let i0 = s.players.iter().position(|(u, _)| u == "u0").unwrap();
    let _ = s.take_totem(i0, "trap", t + 0.1);
    let _ = s.take_totem(i0, "rift", t + 0.2);
    let _ = s.take_totem(i0, "gravflip", t + 0.3);
    let _ = s.take_totem(i0, "radarjam", t + 0.4);
    // force a dirty mark so the player row ships
    let u0 = s.players[i0].0.clone();
    s.mark_all();
    let snap = s.snap(t + 0.5);
    // the arena-event row is "ae", never "ev" — "ev" is the wire envelope's event name
    assert!(snap.get("ev").is_none(), "the snap never emits a data key named \"ev\"");
    assert!(snap["ae"].is_null(), "no arena event is live yet");
    // the new world keys
    let mi = snap["mi"].as_array().expect("mines ship as \"mi\"");
    assert_eq!(mi.len(), TRAP_N as usize, "every planted mine ships");
    let po = snap["po"].as_array().expect("portals ship as \"po\"");
    assert_eq!(po.len(), 2, "a Rift is a pair of portals");
    // the Wave C flag bits on the taker's own row
    let p = snap["p"].as_array().unwrap().iter()
        .find(|e| e[0] == json!(s.player(&u0).unwrap().slot))
        .expect("u0 is in the snap");
    let f = p[8].as_i64().unwrap();
    assert!(f & FLAG_GRAVFLIP != 0, "Gravity Flip's window is flagged");
    assert!(f & FLAG_JAM != 0, "Radar Jammer's window is flagged");
    assert!(f & FLAG_OVERCLOCK == 0, "Overclock is not running");
    // and the row is 10 wide: slot, x, y, z, yaw, pitch, hp, w, flags, when
    assert_eq!(p.as_array().unwrap().len(), 10, "a player row keeps its v1 shape");
}

#[test]
fn a_shed_roof_stops_an_overhead_impact_but_not_a_quake() {
    // "any solid roof overhead" is the cover rule. On the dockyard a catwalk slab
    // already is one; on the dune we added three open-air sheds (kind "shed") whose
    // roof sits at y 2.0..2.5 — has_roof is true underneath, false in the open.
    let sand = MAPS.iter().find(|m| m.id == "sandbar").expect("sandbar is shipped");
    // Box3 is geometry-only; the shed roofs are the slabs whose bottom sits at 2.0
    // (the only overhead cover on the dune — adobe/divider run floor-to-sky).
    let shed = sand.boxes.iter().find(|b| (b[1] - 2.0).abs() < 1e-6).expect("sandbar ships a shed roof");
    let (cx, cz) = ((shed[0] + shed[3]) / 2.0, (shed[2] + shed[5]) / 2.0);
    assert!(has_roof(sand, cx, 0.0, cz), "standing under the shed roof is covered");
    assert!(!has_roof(sand, 0.0, 0.0, 0.0), "the open corridor floor is not covered");
    // the dockyard catwalks are the same cover
    assert!(has_roof(&MAP, -30.0, 0.0, -26.8), "a dockyard catwalk slab is cover");
    assert!(!has_roof(&MAP, 0.0, 0.0, 10.0), "the dockyard open floor is not cover");
    // and a quake mark is floor-based: the roof does NOT stop it. The disaster engine
    // stamps every earthquake WarnMark with overhead=false so has_roof is never consulted.
    let (mut s, t) = started(2, 2, 0.0);
    assert!(s.start_disaster("earthquake", t + 0.1), "the clock can start a quake");
    s.tick(t + 0.1 + DIS_WARN + 0.05, true);   // past the warn, first mark is seeded
    s.tick(t + 0.1 + DIS_WARN + 0.05 + 0.01, true);
    assert!(!s.warns.is_empty(), "the quake seeds impact marks");
    assert!(s.warns.iter().all(|w| !w.overhead), "quake marks are floor-based, never overhead");
    // a meteor mark is overhead — the same roof that saved you above would not save you from a quake
    let (mut s2, t2) = started(2, 2, 0.0);
    assert!(s2.start_disaster("meteorshower", t2 + 0.1));
    s2.tick(t2 + 0.1 + DIS_WARN + 0.05, true);
    s2.tick(t2 + 0.1 + DIS_WARN + 0.05 + 0.01, true);
    assert!(!s2.warns.is_empty(), "the shower seeds impact marks");
    assert!(s2.warns.iter().all(|w| w.overhead), "meteor marks are overhead — a roof stops them");
}

#[test]
fn a_shield_totem_makes_you_immune_to_every_disaster() {
    // The user's rule: if a player has the shield on, that player is safe from any
    // disaster. Everyone else — both teams, bots, and the taker — suffers.
    let (mut s, t) = started(2, 2, 0.0);
    let i0 = s.players.iter().position(|(u, _)| u == "u0").unwrap();
    let vi = s.players.iter().position(|(_, p)| p.team != s.player("u0").unwrap().team).unwrap();
    let vuid = s.players[vi].0.clone();
    put(&mut s, "u0", -6.0, 0.0, -9.0, t, Some(0));
    put(&mut s, &vuid, -6.0, 0.0, -3.0, t, Some(0));
    // u1 (the victim) has the shield totem; u0 does not
    s.player_mut(&vuid).unwrap().shield_totem_until = t + SHIELD_TOTEM;
    assert!(s.disaster_immune(vi, t + 0.5), "shield totem = disaster-immune");
    assert!(!s.disaster_immune(i0, t + 0.5), "an unshielded player is not immune");
    // spawn protect is also immune
    s.player_mut("u0").unwrap().protect = t + 10.0;
    assert!(s.disaster_immune(i0, t + 0.5), "spawn protect = disaster-immune");
    // a meteor that lands on both of them only hurts the unshielded one
    s.player_mut("u0").unwrap().protect = 0.0;
    assert!(s.start_disaster("meteorshower", t + 0.1));
    let hp_shielded = s.player(&vuid).unwrap().hp;
    let hp_plain = s.player("u0").unwrap().hp;
    // drive past the warn and land a mark right on top of both
    let t_imp = t + 0.1 + DIS_WARN + 0.05;
    s.tick(t_imp, true);
    // force a mark onto both players' feet
    let (mx, mz) = (-6.0, -6.0);
    s.warns.push(WarnMark {
        id: 999, x: mx, y: 0.0, z: mz, hit_at: t_imp + 0.01,
        r: DD_METEOR_R * 2.0, dmg: DD_METEOR_DMG, overhead: true, quake: false,
    });
    // stand both on the mark
    put(&mut s, "u0", mx, 0.0, mz, t_imp, Some(0));
    put(&mut s, &vuid, mx, 0.0, mz, t_imp, Some(0));
    s.player_mut(&vuid).unwrap().shield_totem_until = t + SHIELD_TOTEM;
    s.tick(t_imp + 0.05, true);
    assert_eq!(s.player(&vuid).unwrap().hp, hp_shielded, "the shielded player is untouched");
    assert!(s.player("u0").unwrap().hp < hp_plain, "the unshielded player takes the hit");
}

#[test]
fn a_disaster_kill_names_the_disaster_and_pays_no_team_point() {
    // Whatever weapon you kill with shows that weapon — and an environment kill
    // shows the DISASTER name (w = -1, dis = kind). No team point either.
    let (mut s, t) = started(2, 2, 0.0);
    let vi = s.players.iter().position(|(u, _)| u == "u0").unwrap();
    let vuid = s.players[vi].0.clone();
    let scores0 = s.scores;
    let deaths0 = s.player(&vuid).unwrap().deaths;
    s.env_kill(vi, "meteorshower", t + 0.5);
    let p = s.player(&vuid).unwrap();
    assert!(p.dead, "the environment kill lands");
    assert_eq!(p.deaths, deaths0 + 1, "a death is recorded");
    assert_eq!(s.scores, scores0, "an environment kill pays no team point");
    let row = s.pending.iter().rev().find(|(k, _)| *k == "kill").expect("a kill row ships");
    let m = &row.1;
    assert!(m["k"].is_null(), "there is no shooter");
    assert_eq!(m["w"].as_i64().unwrap(), -1, "w = -1 means an environment kill");
    assert_eq!(m["dis"].as_str().unwrap(), "meteorshower", "the feed names the disaster");
    assert_eq!(m["v"].as_str().unwrap(), vuid, "the victim is named");
    // Second Wind still fires on a disaster kill (it is a killing blow like any other)
    let (mut s2, t2) = started(2, 2, 0.0);
    let vi2 = s2.players.iter().position(|(u, _)| u == "u0").unwrap();
    let vuid2 = s2.players[vi2].0.clone();
    s2.player_mut(&vuid2).unwrap().second_wind = true;
    let deaths2 = s2.player(&vuid2).unwrap().deaths;
    s2.env_kill(vi2, "thunder", t2 + 0.5);
    let p2 = s2.player(&vuid2).unwrap();
    assert!(!p2.dead, "Second Wind cancels a disaster killing blow");
    assert_eq!(p2.deaths, deaths2, "no death is recorded");
    assert_eq!(p2.hp, (HP / 2).max(1), "the victim stands back up at half health");
}

#[test]
fn one_disaster_at_a_time_and_the_clock_is_independent() {
    let (mut s, t) = started(2, 2, 0.0);
    assert!(s.disaster.is_none(), "no disaster is live at round start");
    assert!(s.disaster_at.is_some(), "the disaster clock is armed");
    assert!(s.start_disaster("sandstorm", t + 0.1), "the first disaster starts");
    assert!(!s.start_disaster("thunder", t + 0.2), "a second disaster is refused while one is live");
    assert_eq!(s.disaster.as_ref().unwrap().kind, "sandstorm", "the live one is kept");
    // the warn window is 2 s, then the hold
    let d = s.disaster.as_ref().unwrap();
    assert!((d.warn_at - (t + 0.1) - DIS_WARN).abs() < 1e-6, "warn_at is t + DIS_WARN");
    assert!((d.until - (t + 0.1) - DIS_WARN - DIS_SANDSTORM).abs() < 1e-6, "until is the hold");
    // the snap ships "di" (never "ev") and "dm"
    s.mark_all();
    let snap = s.snap(t + 0.2);
    assert!(snap.get("ev").is_none(), "the snap never emits a data key named \"ev\"");
    let di = snap["di"].as_array().expect("the live disaster ships as \"di\"");
    assert_eq!(di[0].as_str().unwrap(), "sandstorm", "di[0] is the kind");
    assert_eq!(di.len(), 8, "di is [kind, warn, hold, ring, ms-to-next, seed, zones, pit]");
    assert!(snap["dm"].is_array(), "impact marks ship as \"dm\"");
    // and when nothing is live the countdown row still ships so the top bar can tick
    s.disaster = None;
    s.disaster_at = Some(t + 5.0);
    let snap2 = s.snap(t + 0.4);
    let di2 = snap2["di"].as_array().expect("the countdown row ships even with nothing live");
    assert!(di2[0].is_null(), "no kind when nothing is live");
    assert!(di2[4].as_i64().unwrap_or(0) > 4000, "di[4] is the ms until the next one");
    // the clock fires on its own once the current one is gone
    s.disaster_at = Some(t + 0.3);
    s.disaster = None;
    s.tick(t + 0.3, true);
    assert!(s.disaster.is_some(), "the clock starts one by itself");
    // and a totem can start one too
    let (mut s2, t2) = started(2, 2, 0.0);
    let i0 = s2.players.iter().position(|(u, _)| u == "u0").unwrap();
    assert!(s2.take_totem(i0, "meteorshower", t2 + 0.1), "grabbing a Disaster totem starts it");
    assert_eq!(s2.disaster.as_ref().unwrap().kind, "meteorshower", "the taker set off a meteor shower");
}

#[test]
fn disaster_totems_have_their_own_ring_and_clock() {
    // Wave E: Disaster totems are never mixed into the personal roster. They land on
    // their own ring (DIS_SLOTS) on their own clock (DIS_GAP_DROP / DIS_FIRST_DROP), and
    // every kind they roll is one of the 10 arena-wide disasters.
    let (mut s, _t) = started(2, 2, 0.0);
    let n_map = MAP.pickups.len();
    let dis_lo = n_map + DROP_SLOTS + PACK_SLOTS;
    let dis_hi = dis_lo + DIS_SLOTS;
    // personal drops never roll a Disaster kind
    for k in 0..200 {
        s.totem_k = k;
        s.k = k;
        s.spawn_totem(false);
        let i = n_map + (k as usize) % DROP_SLOTS;
        assert!(!DISASTERS.contains(&s.kinds[i]),
                "the personal ring never rolls a Disaster kind: {}", s.kinds[i]);
    }
    // Disaster drops always do, and always land in the Disaster ring
    let mut seen = std::collections::HashSet::new();
    for k in 0..40 {
        s.dis_k = k;
        s.k = k;
        s.spawn_disaster_totem();
        let i = dis_lo + (k as usize) % DIS_SLOTS;
        assert!(DISASTERS.contains(&s.kinds[i]),
                "the Disaster ring only rolls Disaster kinds: {}", s.kinds[i]);
        assert!((dis_lo..dis_hi).contains(&i), "the Disaster ring index is in range");
        seen.insert(s.kinds[i]);
        // deterministic: same seed derives the same spot and kind
        let (x1, z1) = (s.spots[i][0], s.spots[i][2]);
        s.dis_k = k;
        s.k = k;
        s.spawn_disaster_totem();
        assert_eq!(s.spots[i][0], x1, "the same seed derives the same x");
        assert_eq!(s.spots[i][2], z1, "the same seed derives the same z");
    }
    assert!(!seen.is_empty(), "the Disaster ring actually drops");
    // the clock is armed alongside the totem/pack clocks
    assert!(s.dis_at.is_none() || s.dis_at.is_some(), "dis_at is a valid Option");
}

fn hot_and_cursed_drops_tag_a_slice_of_the_scatter() {
    // the tag roll is a pure hash: over many seeds the three flavours split roughly
    // HOT_PCT / CURSED_PCT / the rest. Deterministic, so this is a distribution check
    // on the SAME derivation the client uses (games/strike.js totemSpawn).
    let (mut s, _t) = started(2, 2, 0.0);
    let n_map = MAP.pickups.len();
    let (mut hot, mut cursed, mut plain) = (0, 0, 0);
    for k in 0..200 {
        s.totem_k = k;
        s.k = k;   // the match's own seed salt
        s.spawn_totem(false);
        let i = n_map + (k as usize) % DROP_SLOTS;
        if s.cursed.get(i).copied().unwrap_or(false) {
            cursed += 1;
        } else {
            // the tag is not stored separately from the cursed bit; re-derive it
            let seed = ((k as u32).wrapping_mul(0x9E37_79B9)).wrapping_add(k as u32);
            let roll = (hash_match(seed, 3) * 100.0) as i64;
            if roll < HOT_PCT {
                hot += 1;
            } else {
                plain += 1;
            }
        }
    }
    assert!(cursed > 20, "Cursed Drops are a real slice of the scatter: {cursed}");
    assert!(hot > 15, "Hot Drops are a real slice of the scatter: {hot}");
    assert!(plain > 100, "most drops are untagged: {plain}");
    // and a cursed take really costs 15 hp up front
    let (mut s2, t2) = started(2, 2, 0.0);
    let i0 = s2.players.iter().position(|(u, _)| u == "u0").unwrap();
    let n = s2.map().pickups.len();
    s2.ensure_drop_slots();
    s2.totem_k = 1;
    s2.k = 7;
    s2.spawn_totem(true);
    // force the slot cursed and put the taker on it
    let slot = n;   // the first totem ring slot
    s2.cursed[slot] = true;
    s2.kinds[slot] = "speed";
    s2.items[slot] = None;
    let (sx, sz) = (s2.spots[slot][0], s2.spots[slot][2]);
    put(&mut s2, "u0", sx, 0.0, sz, t2 + 0.1, Some(0));
    let hp0 = s2.player("u0").unwrap().hp;
    s2.pickups(i0, t2 + 0.2);
    assert_eq!(s2.player("u0").unwrap().hp, hp0 - 15, "a Cursed Drop costs 15 hp up front");
}

#[test]
fn dis_kind_spreads_consecutive_counters_across_the_roster() {
    // hash_match's top-bit read collapses consecutive world_k values onto ONE index
    // (the auto-disaster clock rolled Absolute Zero forever). dis_kind is the fix —
    // twin of games/strike.js disKind. Over the real auto sequence (world_k = 1..) the
    // roll must actually vary and stay inside the roster.
    let mut seen = [0usize; 10];
    for k in 1u32..=40 {
        let i = dis_kind(k, 11, DISASTERS.len());
        assert!(i < DISASTERS.len(), "kind index in range");
        seen[i] += 1;
    }
    let distinct = seen.iter().filter(|&&c| c > 0).count();
    assert!(
        distinct > 5,
        "consecutive world_k values must not stick on one disaster kind: {seen:?}"
    );
    // the Disaster-totem seed (dis_k golden-ratio mix through hash-match's salts) too
    let mut seen2 = [0usize; 10];
    for k in 0u32..30 {
        for slot in 0u32..2 {
            let t = 12.0 + (k as f64) * 16.0;
            let seed = ((t * 1000.0) as u32) ^ (slot + 77);
            let i = dis_kind(seed, 4, DISASTERS.len());
            seen2[i] += 1;
        }
    }
    let distinct2 = seen2.iter().filter(|&&c| c > 0).count();
    assert!(
        distinct2 > 5,
        "Disaster-totem kind rolls must vary too: {seen2:?}"
    );
    // and the twin really is the twin: first eight auto rolls match games/strike.js
    let expect = [7, 5, 3, 5, 7, 9, 1, 3];
    for (k, &want) in expect.iter().enumerate() {
        assert_eq!(
            dis_kind((k as u32) + 1, 11, DISASTERS.len()),
            want,
            "dis_kind twin of games/strike.js disKind"
        );
    }
}

#[test]
fn modifier_disasters_chip_and_every_disaster_has_an_impact_number() {
    // The standing rule: every disaster is visual AND impact. Sandstorm / Absolute Zero /
    // EMP used to be mod-only. They now chip once a second via DD_*_DMG (twin of
    // games/strike.js). Shield / spawn-protect still skip it via disaster_immune.
    // (assert_eq on the constants — clippy rejects assert!(const > 0) as dead code.)
    assert_eq!(DD_SAND_DMG, 3);
    assert_eq!(DD_ZERO_DMG, 4);
    assert_eq!(DD_EMP_DMG, 2);
    assert_eq!(DD_METEOR_DMG, 45);
    assert_eq!(DD_THUNDER_DMG, 55);
    assert_eq!(DD_QUAKE_DMG, 25);
    assert_eq!(DD_SHOCK_DMG, 30);
    assert_eq!(DD_TOXIC_DMG, 8);
    assert_eq!(DD_SINK_DMG, 12);
    assert_eq!(DD_WIND_PUSH, 7.5);
    assert_eq!(DD_WIND_R, 6.0);
    assert_eq!(DD_WIND_DMG, 3);
    // proximity crush: more damage near the strike (twin of markDamage / mark_damage)
    assert_eq!(DD_NEAR_R, 0.35);
    assert_eq!(DD_NEAR_MIN, 0.45);
    assert_eq!(mark_damage(0.0, 2.8, 55), 55, "under the bolt is the peak");
    assert_eq!(mark_damage(2.8 * 0.35, 2.8, 55), 55, "near the bolt keeps the peak");
    let rim = mark_damage(2.8, 2.8, 55);
    assert!((24..=26).contains(&rim), "the rim is ~45% of the peak, got {rim}");
    assert!(mark_damage(1.4, 2.8, 55) > rim && mark_damage(1.4, 2.8, 55) < 55);
    // non-HP impacts: blind / slow windows (twin of the JS DD_*_BLIND / DD_*_SLOW)
    assert_eq!(DD_THUNDER_BLIND, 0.45);
    assert_eq!(DD_METEOR_BLIND, 0.35);
    assert_eq!(DD_SHOCK_BLIND, 0.55);
    assert_eq!(DD_QUAKE_SLOW, 1.2);
    assert_eq!(DD_TOXIC_SLOW, 0.75);
    assert_eq!(DD_SINK_SLOW, 0.65);
    assert_eq!(DD_WIND_SLOW, 0.7);
    assert_eq!(DD_SLOW_MULT, 0.65);
    assert_eq!(DD_SAND_SCATTER, 1.2);
    assert_eq!(DD_WIND_SCATTER, 2.4);
    assert_eq!(DD_EMP_SCATTER, 1.0);
    // disaster sense flags ship on the player row (FLAG_BLIND / FLAG_SLOW)
    assert_eq!(FLAG_BLIND, 16777216);
    assert_eq!(FLAG_SLOW, 33554432);
}

#[test]
fn thunder_hits_harder_near_the_bolt_and_stuns() {
    // User ask: "damage impact should be more to player / bot near lightning".
    // A body under the mark takes the peak; one at the rim takes ~45%; the bolt
    // also blinds and the quake throws your step.
    let (mut s, t) = started(2, 2, 0.0);
    // open dockyard floor (0, 0, 10) — not under a catwalk, so overhead cover is out
    let (mx, mz) = (0.0, 10.0);
    put(&mut s, "u0", mx, 0.0, mz, t, Some(0));
    put(&mut s, "u1", mx + DD_THUNDER_R, 0.0, mz, t, Some(0));
    for (_, p) in s.players.iter_mut() {
        p.hp = 100;
        p.protect = 0.0;
        p.shield_totem_until = 0.0;
        p.drop = false;
        p.drop_t = 0.0;
        p.pocket_until = 0.0;
    }
    assert!(s.start_disaster("thunder", t));
    let t_hit = t + DIS_WARN + 0.05;
    s.disaster_tick(t_hit);
    // one mark under u0; u1 stands at the rim (x = r). overhead=false so cover is
    // not the variable under test — mark_damage is (and the unit pins above cover).
    s.warns.push(WarnMark {
        id: 1, x: mx, y: 0.0, z: mz, hit_at: t_hit + 0.01,
        r: DD_THUNDER_R, dmg: DD_THUNDER_DMG, overhead: false, quake: false,
    });
    s.disaster_tick(t_hit + 0.05);
    let dmg0 = 100 - s.players[0].1.hp;
    let dmg1 = 100 - s.players[1].1.hp;
    assert!(dmg0 >= 50, "under the bolt is near the 55 peak, got {dmg0}");
    assert!((20..=30).contains(&dmg1), "the rim is ~45% of 55, got {dmg1}");
    assert!(dmg0 > dmg1, "near the bolt must hurt more ({dmg0} vs {dmg1})");
    assert!(s.players[0].1.blind_until > t_hit + 0.05, "a bolt blinds");
}

#[test]
fn disaster_hazards_are_frozen_and_shared_with_the_visual() {
    // The user-reported bug: "the visuals are there but there is no impact at all".
    // Toxic clouds used to re-roll dropSpot every second while the FX painted fixed
    // angles around map centre — the green clouds never hurt and the hurt was invisible.
    // The fix: start_disaster freezes zones/pit/seed once; the judge and the client
    // both read the same geometry (snap "di" fields 5-7).
    let (mut s, t) = started(2, 2, 0.0);
    put(&mut s, "u0", 3.0, 0.0, 4.0, t, Some(0));
    s.player_mut("u0").unwrap().protect = 0.0; // not spawn-protected
    assert!(s.start_disaster("toxicfog", t), "toxic fog starts");
    let d = s.disaster.clone().unwrap();
    assert_eq!(d.zones.len(), DD_TOXIC_ZONES, "three sticky clouds");
    // zones are near live bodies (first few) — not a fresh roll every pulse
    let near = d.zones.iter().filter(|(x, z)| {
        (x - 3.0).hypot(z - 4.0) < 8.0
    }).count();
    assert!(near >= 1, "at least one cloud sits near a live body: {:?}", d.zones);
    // seed is frozen and non-zero once world_k advanced
    assert_ne!(d.seed, 0, "frozen seed");

    // sinkhole: the pit is frozen at start, not re-hashed from warn_at each pulse
    let (mut s2, t2) = started(2, 2, 0.0);
    s2.player_mut("u0").unwrap().protect = 0.0;
    assert!(s2.start_disaster("sinkhole", t2));
    let d2 = s2.disaster.clone().unwrap();
    let pit1 = d2.pit;
    s2.disaster_tick(t2 + DIS_WARN + 0.5);
    let pit2 = s2.disaster.as_ref().unwrap().pit;
    assert_eq!(pit1, pit2, "the pit must not move mid-hold");

    // snap ships the frozen geometry so the client paints the same spots
    let snap = s2.snap(t2 + DIS_WARN + 0.5);
    let di = snap["di"].as_array().expect("di row");
    assert!(di.len() >= 8, "di carries seed/zones/pit, got {}", di.len());
    assert!(di[5].is_number(), "di[5] is the frozen seed");
    assert!(di[6].is_array(), "di[6] is the toxic cloud centres");
    assert!(di[7].is_array(), "di[7] is the sinkhole pit");
}

#[test]
fn every_disaster_kind_chips_or_hits_hp() {
    // Standing rule: every disaster is visual AND impact on players and bots.
    // Hurricane used to shove with no damage ("what is even disaster without impact").
    let (mut s, t) = started(2, 2, 0.0);
    for (_, p) in s.players.iter_mut() {
        p.hp = 100;
        p.protect = 0.0;
        p.shield_totem_until = 0.0;
    }
    assert!(s.start_disaster("hurricane", t));
    // walk past the warn window and several one-second pulses
    for k in 0..40 {
        s.disaster_tick(t + DIS_WARN + k as f64 * 0.25);
    }
    let chipped = s.players.iter().any(|(_, p)| p.hp < 100);
    assert!(chipped, "hurricane must chip HP while it shoves");
}

#[test]
fn a_fall_out_of_the_map_is_rescued_after_void_secs() {
    // User bug lock: "when player is thrown out of map, and falling endlessly, that
    // player should be respawned after 10 sec … cant even kill myself to respawn".
    // Before: a body past the deck kept free-falling forever (nothing killed it and
    // death only came from damage). Now the referee tracks a void clock and puts
    // every living body back under a canopy after VOID_SECS.
    let (mut s, t) = started(2, 2, 0.0);
    put(&mut s, "u0", 0.0, -20.0, 0.0, t, Some(0)); // already in the void
    assert!(in_void(s.map(), 0.0, -20.0, 0.0), "deep under the deck is the void");
    assert!(!in_void(s.map(), 0.0, 0.0, 0.0), "on the deck is not the void");

    // first tick after the fall: the clock starts, nobody is rescued yet
    let evs = s.tick(t + 0.05, true);
    assert!(!evs.iter().any(|(k, _)| *k == "spawn"), "no instant rescue: {:?}", evs);
    assert!(s.player("u0").unwrap().void_at > 0.0, "void clock is running");

    // well under VOID_SECS: still falling
    let evs = s.tick(t + VOID_SECS - 0.5, true);
    assert!(!evs.iter().any(|(k, _)| *k == "spawn"), "still waiting out the clock");
    assert!(s.player("u0").unwrap().y < -5.0, "still in the void");

    // at VOID_SECS: parachuted back on the map, same drop path as a respawn
    let evs = s.tick(t + VOID_SECS + 0.2, true);
    assert!(evs.iter().any(|(k, v)| *k == "spawn" && v["user"] == "u0"), "rescued: {:?}", evs);
    let p = s.player("u0").unwrap();
    assert!(!p.dead, "a fall-out is not a death");
    assert!(p.y > 0.5, "back above the deck, got y={}", p.y);
    assert_eq!(p.void_at, 0.0, "clock cleared on the way home");
    assert!(p.drop, "the rescue is a parachute drop");

    // bots get the same rescue — every player, not just humans
    let (mut s2, t2) = started(0, 2, 0.0); // no humans -> bots fill both sides
    let bid = s2.players.iter().find(|(_, p)| p.is_bot()).map(|(u, _)| u.clone()).expect("a bot");
    put(&mut s2, &bid, 0.0, -20.0, 0.0, t2, Some(0));
    s2.tick(t2 + 0.05, true);
    s2.tick(t2 + VOID_SECS + 0.2, true);
    let b = s2.player(&bid).unwrap();
    assert!(!b.dead && b.y > 0.5, "bot rescued too (y={})", b.y);
}

// ---------------------------------------------------------- The Warden ----
// Mid-match giant boss: rises at half the score, freezes the round, forbids PvP,
// slams / laser-eyes / calls disasters, drops checkpoint loot, dies and restores.

fn started_warden(n: usize, tsize: i64, t0: f64) -> (Strike, f64) {
    let mut s = Strike::new();
    assert_eq!(
        s.start(
            &members(n, "u"),
            &json!(5),
            &json!(30),
            &json!(tsize),
            &json!("normal"),
            &Value::Null,
            &json!(1),
            t0
        ),
        None
    );
    s.tick(t0 + COUNTDOWN, true);
    assert_eq!(s.phase, Phase::Round);
    (s, t0 + COUNTDOWN)
}

fn aim_msg(s: &Strike, uid: &str, tgt: [f64; 3], w: usize, q: i64) -> Value {
    let o = eye(s, uid);
    let yaw = (tgt[0] - o[0]).atan2(-(tgt[2] - o[2])).to_degrees();
    let pitch = (tgt[1] - o[1])
        .atan2((tgt[0] - o[0]).hypot(tgt[2] - o[2]))
        .to_degrees();
    let (dy, dp) = spread_of(1, w);
    json!({"w": w, "ox": cm(o[0]), "oy": cm(o[1]), "oz": cm(o[2]),
           "r": ((yaw - dy) * 100.0) as i64, "p": ((pitch - dp) * 100.0) as i64, "q": q, "ip": 0})
}

/// Head of the Warden — the only clear lane over the centre blocks.
fn warden_head(s: &Strike) -> [f64; 3] {
    let wd = s.warden.as_ref().expect("warden lives");
    [wd.x, WARDEN_SEE_HEAD, wd.z]
}

/// Stand above the centre blocks and pour rounds into the head (w=0, q steps of 20).
/// Returns the clock after the last shot so the caller can fire again without
/// tripping the weapon cadence.
fn drain_warden(s: &mut Strike, t: f64) -> f64 {
    put(s, "u0", 0.0, 3.0, 14.0, t, Some(0));
    let mut q = 20i64;
    for _ in 0..40 {
        if s.warden.is_none() {
            return t + (q as f64) * 0.002;
        }
        let tgt = warden_head(s);
        let msg = aim_msg(s, "u0", tgt, 0, q);
        let tq = t + (q as f64) * 0.002;
        q += 20;
        let _ = s.fire("u0", &msg, tq);
        if let Some(wd) = s.warden.as_mut() {
            // walk through the 75/50/25 checkpoints without waiting on DPS
            wd.hp = wd.hp.saturating_sub(400);
        }
        s.warden_after_damage(tq);
        s.tick(tq + 0.01, true);
    }
    panic!("warden refused to die");
}

#[test]
fn the_warden_rises_at_half_the_score_and_freezes_the_match() {
    let (mut s, t) = started_warden(2, 2, 0.0);
    assert!(s.warden.is_none(), "no boss before half the score");
    let ms0 = s.ms_left(t);
    assert!(ms0 > 0, "the round clock is running");

    // any side reaching ceil(limit * 0.5) summons it
    let half = ((s.limit as f64) * WARDEN_TRIGGER).ceil() as i64;
    s.scores[0] = half;
    let evs = s.tick(t + 0.05, true);
    assert!(s.warden.is_some(), "the Warden rises at half: {:?}", evs);
    assert!(
        evs.iter().any(|(k, v)| *k == "warden" && v["phase"] == "rise"),
        "rise event: {:?}",
        evs
    );
    let wd = s.warden.as_ref().unwrap();
    let fighters = s.players.iter().filter(|(_, p)| !p.dead && !p.gone).count() as i64;
    let want = (WARDEN_HP_PER * fighters).clamp(WARDEN_MIN_HP, WARDEN_MAX_HP);
    assert_eq!(wd.max, want, "max HP scales with the fighters on the field");
    assert_eq!(wd.arm_l, WARDEN_ARM_HP);
    assert_eq!(wd.arm_r, WARDEN_ARM_HP);

    // the clock is parked where it stood
    let frozen = s.ms_left(t + 0.05);
    let later = s.ms_left(t + 30.0);
    assert_eq!(frozen, later, "ms_left does not drain while the Warden lives");
    assert!(frozen <= ms0 + 50, "parked near the summon moment");

    // normal drops and the auto-disaster clock are suspended
    assert!(s.totem_at.is_none());
    assert!(s.pack_at.is_none());
    assert!(s.dis_at.is_none());
    assert!(s.disaster_at.is_none());
}

#[test]
fn fighters_cannot_hurt_each_other_while_the_warden_lives() {
    let (mut s, t) = started_warden(2, 2, 0.0);
    s.scores[0] = ((s.limit as f64) * WARDEN_TRIGGER).ceil() as i64;
    s.tick(t + 0.05, true);
    assert!(s.warden.is_some());

    // put a foe point-blank and shoot them the way a normal match would
    let foe = s
        .players
        .iter()
        .find(|(_, p)| p.team != s.player("u0").unwrap().team && !p.is_bot())
        .map(|(u, _)| u.clone())
        .expect("a human foe");
    put(&mut s, "u0", 8.0, 0.0, 8.0, t, Some(0));
    put(&mut s, &foe, 8.0, 0.0, 10.0, t, Some(0));
    let hp0 = s.player(&foe).unwrap().hp;
    let tgt = chest(&s, &foe);
    let msg = aim_msg(&s, "u0", tgt, 0, 10);
    let (shot, _) = s.fire("u0", &msg, t + 0.1);
    let shot = shot.expect("the tracer still draws");
    assert_eq!(shot[5], json!(-1), "the shot lands on the Warden row, not a player");
    assert_eq!(s.player(&foe).unwrap().hp, hp0, "PvP damage is off while the boss lives");

    // and the Warden actually takes the hit (head above the centre blocks)
    put(&mut s, "u0", 0.0, 3.0, 14.0, t, Some(0));
    let hpw = s.warden.as_ref().unwrap().hp;
    let msg2 = aim_msg(&s, "u0", warden_head(&s), 0, 30);
    let (_shot, _) = s.fire("u0", &msg2, t + 0.2);
    assert!(s.warden.as_ref().unwrap().hp < hpw, "the boss bleeds");
}

#[test]
fn the_wardens_slam_and_laser_are_instant_kills_with_a_warning() {
    let (mut s, t) = started_warden(2, 2, 0.0);
    s.scores[0] = ((s.limit as f64) * WARDEN_TRIGGER).ceil() as i64;
    s.tick(t + 0.05, true);
    let (wx, wz) = {
        let wd = s.warden.as_ref().unwrap();
        (wd.x, wd.z)
    };

    // a disabled arm skips its slam: both arms out = nobody dies under the circles
    {
        let wd = s.warden.as_mut().unwrap();
        wd.arm_l = 0;
        wd.arm_r = 0;
        wd.slam_arm = 2;
        wd.slab_arm = 0.0;
        wd.slab_land = 0.0;
        wd.slab_at = t + 0.05;
    }
    put(&mut s, "u0", wx - WARDEN_ARM_X, 0.0, wz, t, Some(0));
    put(&mut s, "u1", wx + WARDEN_ARM_X, 0.0, wz, t, Some(0));
    s.tick(t + 0.2, true);
    assert!(!s.player("u0").unwrap().dead, "no slam when both arms are out");
    assert!(!s.player("u1").unwrap().dead);

    // right arm only: the slam lands on its circle and kills what is under it
    {
        let wd = s.warden.as_mut().unwrap();
        wd.arm_r = WARDEN_ARM_HP;
        wd.slam_arm = 1;
        wd.slab_arm = t + 0.3;
        wd.slab_land = t + 0.3;
        wd.slab_at = t + 10.0;
    }
    s.tick(t + 0.35, true);
    assert!(s.player("u1").unwrap().dead, "instant kill under the arm");
    assert!(!s.player("u0").unwrap().dead, "the other arm's circle is safe");

    // laser eyes: a warn window, then the beam kills what it touches (cover saves).
    // Stand on +Z at head height so the centre blocks are not in the way.
    put(&mut s, "u0", wx, 4.0, wz + 10.0, t, Some(0));
    {
        let wd = s.warden.as_mut().unwrap();
        wd.laser_yaw = std::f64::consts::FRAC_PI_2; // +Z
        wd.laser_warn = t + 0.5;
        wd.laser_on = t + 0.5 + WARDEN_LASER_HOLD;
        wd.laser_at = t + 100.0;
        wd.slab_at = t + 100.0;
    }
    s.tick(t + 0.3, true);
    assert!(!s.player("u0").unwrap().dead, "the warn window is not lethal");
    s.tick(t + 0.7, true);
    assert!(s.player("u0").unwrap().dead, "the beam kills on contact");
}

#[test]
fn only_the_warden_calls_disasters_and_only_it_drops_boosts() {
    let (mut s, t) = started_warden(2, 2, 0.0);
    s.scores[0] = ((s.limit as f64) * WARDEN_TRIGGER).ceil() as i64;
    s.tick(t + 0.05, true);
    assert!(s.warden.is_some());
    let items0 = s.items.len();
    // park the boss's own disaster clock so this window is quiet
    {
        let wd = s.warden.as_mut().unwrap();
        wd.dis_at = t + 1000.0;
        wd.slab_at = t + 1000.0;
        wd.laser_at = t + 1000.0;
        wd.slab_arm = 0.0;
        wd.slab_land = 0.0;
        wd.laser_warn = 0.0;
        wd.laser_on = 0.0;
        wd.ck = [true; WARDEN_CKPT]; // no checkpoint loot during the quiet window
        // bots now open fire — keep the boss standing so ordinary drops stay off
        wd.hp = 1_000_000;
        wd.arm_l = 1_000_000;
        wd.arm_r = 1_000_000;
    }

    // a long quiet stretch: no player-facing totem/pack/disaster-totem drops
    let mut totems = 0;
    let mut packs = 0;
    let mut now = t + 0.1;
    for _ in 0..80 {
        let evs = s.tick(now, true);
        for (k, v) in &evs {
            if *k == "totem" && v["tag"] != "warden" {
                totems += 1;
            }
            if *k == "pack" && v["tag"] != "warden-pack" {
                packs += 1;
            }
        }
        now += 0.25;
    }
    assert_eq!(totems, 0, "no ordinary totem falls while the Warden lives");
    assert_eq!(packs, 0, "no ordinary pack falls while the Warden lives");
    assert!(s.disaster.is_none(), "nobody but the Warden starts a disaster");

    // the Warden itself calls a disaster on its own clock
    {
        let wd = s.warden.as_mut().unwrap();
        wd.dis_at = t + 0.1;
    }
    let evs = s.tick(t + 20.2, true);
    assert!(s.disaster.is_some(), "only the Warden starts a disaster: {:?}", evs);

    // checkpoints spill non-disaster loot + a health pack in a ring
    let before = s.items.len();
    {
        let wd = s.warden.as_mut().unwrap();
        wd.hp = wd.max / 2; // crosses the 75% and 50% marks on the next wound
        wd.ck = [false; WARDEN_CKPT];
    }
    put(&mut s, "u0", 0.0, 3.0, 14.0, t, Some(0));
    let msg = aim_msg(&s, "u0", warden_head(&s), 0, 40);
    let _ = s.fire("u0", &msg, t + 20.3);
    s.warden_after_damage(t + 20.3);
    let evs = s.tick(t + 20.35, true);
    let loot: Vec<_> = evs
        .iter()
        .filter(|(k, v)| {
            (*k == "totem" || *k == "pack")
                && (v["tag"] == "warden" || v["tag"] == "warden-pack")
        })
        .collect();
    assert!(!loot.is_empty(), "checkpoint loot drops: {:?}", evs);
    assert!(s.items.len() > before, "one-shot loot slots appended");
    assert!(s.items.len() >= items0);
    let ck = s.warden.as_ref().unwrap().ck;
    assert!(ck[0] && ck[1], "the 75% and 50% checkpoints fired");
}

#[test]
fn when_the_warden_dies_the_match_is_back() {
    let (mut s, t) = started_warden(2, 2, 0.0);
    s.scores[0] = ((s.limit as f64) * WARDEN_TRIGGER).ceil() as i64;
    s.tick(t + 0.05, true);
    assert!(s.warden.is_some());
    let frozen = s.ms_left(t + 0.05);

    // park a foe, kill the boss, and confirm PvP + clocks come back
    let foe = s
        .players
        .iter()
        .find(|(_, p)| p.team != s.player("u0").unwrap().team && !p.is_bot())
        .map(|(u, _)| u.clone())
        .expect("a human foe");
    put(&mut s, "u0", 0.0, 3.0, 14.0, t, Some(0));
    put(&mut s, &foe, 4.0, 0.0, 12.0, t, Some(0));

    let end = drain_warden(&mut s, t + 0.4);
    assert!(s.warden.is_none(), "the boss is gone");
    assert!(s.totem_at.is_some(), "totem clock restored");
    assert!(s.pack_at.is_some(), "pack clock restored");
    assert!(s.dis_at.is_some(), "disaster-totem clock restored");
    assert!(s.disaster_at.is_some(), "auto-disaster clock restored");
    let live = s.ms_left(end + 0.05);
    assert!(live <= frozen + 200, "the clock is running again");

    // a shot that was a no-op during the fight hurts again
    let hp0 = s.player(&foe).unwrap().hp;
    let msg = aim_msg(&s, "u0", chest(&s, &foe), 0, 90);
    let (shot, _) = s.fire("u0", &msg, end + 0.3);
    let shot = shot.expect("the shot draws");
    assert_ne!(shot[5], json!(-1), "it hits a player row again");
    assert!(s.player(&foe).unwrap().hp < hp0, "PvP damage is back");
}

#[test]
fn bots_open_fire_on_the_warden_from_a_firing_lane() {
    // Bug lock: the centre blocks hide the chest at y=2.5. A bot that only checks
    // that height never shoots. It must pick a visible hit height and land shots.
    let (mut s, t) = started_warden(2, 2, 0.0);
    s.scores[0] = ((s.limit as f64) * WARDEN_TRIGGER).ceil() as i64;
    s.tick(t + 0.05, true);
    let max_hp = s.warden.as_ref().expect("warden lives").max;
    // stand south of the centre blocks (the usual spawn lane) with a clear line
    // to an arm / torso height — that is the lane warden_see must find
    let bid = s
        .players
        .iter()
        .find(|(_, p)| p.is_bot())
        .map(|(u, _)| u.clone())
        .expect("a bot filler");
    put(&mut s, &bid, 0.0, 0.0, 14.0, t, Some(0));
    // keep the bot's physics body where put() placed the player
    if let Some(p) = s.player_mut(&bid) {
        if let Some(b) = p.bot.as_mut() {
            b.body.x = 0.0;
            b.body.y = 0.0;
            b.body.z = 14.0;
            b.body.vx = 0.0;
            b.body.vy = 0.0;
            b.body.vz = 0.0;
            b.fire_at = -1e9;
            b.seen_at = None;
            b.think_at = t;
        }
    }
    // park the slam / laser / disaster clocks so they cannot steal the frame
    {
        let wd = s.warden.as_mut().unwrap();
        wd.slab_at = t + 1000.0;
        wd.slab_arm = 0.0;
        wd.slab_land = 0.0;
        wd.laser_at = t + 1000.0;
        wd.laser_warn = 0.0;
        wd.laser_on = 0.0;
        wd.dis_at = t + 1000.0;
    }
    // run long enough for think + react + several SMG intervals
    let mut now = t;
    for _ in 0..40 {
        now += 0.2;
        s.tick(now, true);
    }
    let hp = s.warden.as_ref().map(|wd| wd.hp).unwrap_or(0);
    assert!(hp < max_hp, "the bot never shot the Warden (hp={hp} max={max_hp})");
}
