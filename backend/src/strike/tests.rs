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
                               0.0, 0.0, 0.0, 100.0, 1.0).unwrap();
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
fn a_live_canopy_is_never_fix_slapped_back_to_the_sky() {
    // The sky-fall loop: a refused frame mid-glide answered with "fix" placeMe()'d the
    // client back to the judge's copy, which also cleared its V.dropUntil — so the
    // canopy died, the body fell again, every later frame was refused, and the next
    // "fix" repeated it. A live drop owns the body until it lands: no correction.
    let (mut s, t) = started(2, 2, 0.0);
    put(&mut s, "u0", 0.0, 0.0, -8.0, t, Some(0));
    {
        let p = s.player_mut("u0").unwrap();
        p.y = DROP_HEIGHT;
        p.drop = true;
        p.drop_t = t;
        p.spawn_t = t;
        p.air_at = t;
        p.hist = VecDeque::from([(t, p.x, p.y, p.z)]);
    }
    // a frame that is wildly off (teleport-sized) is refused — but while the canopy is
    // up the referee must stay silent, never rubber-band a glide to the floor.
    let (ok, fix) = s.pos("u0", &json!({"x": cm(20.0), "y": cm(DROP_HEIGHT), "z": cm(20.0),
                                        "r": 0, "p": 0, "q": 50}), t + 0.2);
    assert!(!ok, "the teleport-sized step is still refused");
    assert!(fix.is_none(), "a live canopy is never corrected: {fix:?}");
    // past the canopy the same frame is corrected again (the ordinary rubber-band).
    // FIX_GAP throttles corrections to one every 0.5 s, so wait it out first.
    {
        let p = s.player_mut("u0").unwrap();
        p.drop = false;
        p.drop_t = 0.0;
    }
    let (_ok, fix) = s.pos("u0", &json!({"x": cm(20.0), "y": cm(DROP_HEIGHT), "z": cm(20.0),
                                         "r": 0, "p": 0, "q": 60}), t + 0.8);
    assert!(fix.is_some(), "once the canopy is over the referee corrects again");
}

#[test]
fn a_refused_frame_still_takes_the_totem_under_your_feet() {
    // Pickups used to run only on an accepted "pos", against the judge's own copy of
    // the body. A refused frame froze that copy, so the totem under the player's boots
    // was "not taken" — and then shipped in a bulk once an accepted frame landed again.
    // The claim (the body the client just named) is what the take is judged against.
    let (mut s, t) = started(2, 2, 0.0);
    let n_map = MAP.pickups.len();
    // the judge's copy is 2 m short of the totem (a previous refusal left it there)
    put(&mut s, "u0", 0.0, 0.0, -10.0, t, Some(0));
    s.items[n_map] = None;
    s.kinds[n_map] = "wings";
    s.spots[n_map] = [0.0, 0.0, -8.0];
    s.player_mut("u0").unwrap().air_at = t;
    // a refused frame naming the real body — standing on the totem. The step is 2 m in
    // 0.01 s of clock, so the speed cap refuses it; the claim is still believed, and
    // the take lands on that same frame (not "later, in a bulk").
    let (ok, _) = s.pos("u0", &json!({"x": cm(0.0), "y": cm(0.0), "z": cm(-8.0),
                                      "r": 0, "p": 0, "q": 1}), t + 0.3);
    assert!(!ok, "the overspeed frame is refused");
    assert!(s.items[n_map].is_some(), "the take lands on the refused frame itself");
    let evs = s.tick(t + 0.35, true);
    assert!(evs.iter().any(|(ev, d)| ev == &"pick" && d["i"].as_i64() == Some(n_map as i64)),
            "the pick reaches the client on the next tick");
}

#[test]
fn a_walk_over_always_takes_even_when_the_totem_has_no_target() {
    // Solo: a mole with no enemy bots still takes ("nothing eligible"). MP used to
    // refuse, leaving the totem under the player's feet for later — "not taken, then
    // bulk". A walk-over is a take; a target-less effect simply does nothing.
    let (mut s, t) = started(2, 2, 0.0);
    let i0 = s.players.iter().position(|(u, _)| u == "u0").unwrap();
    // nobody else is up: every bot and the other human is out of the round
    for (u, p) in s.players.iter_mut() {
        if u != "u0" {
            p.dead = true;
            p.gone = true;
        }
    }
    assert!(s.take_totem(i0, "mole", t), "a mole with nobody to turn is still taken");
    assert!(s.take_totem(i0, "freeze", t), "a paralyser with nobody to freeze is still taken");
    assert!(s.take_totem(i0, "fate", t), "a fate splitter with nobody to link is still taken");
    assert!(s.take_totem(i0, "bodyswap", t), "a body swap with nobody to swap is still taken");
    assert!(s.take_totem(i0, "disco", t), "a disco with nobody to dance is still taken");
    assert!(s.take_totem(i0, "lottery", t), "a death lottery with nobody home is still taken");
}

#[test]
fn a_canopy_from_the_sky_sees_the_deck_under_it() {
    // The "through the floor" respawn: top_under needs the body to already overlap a
    // box, so a probe from DROP_HEIGHT never matches — floor = None, the whole
    // descent sank at DROP_SINK and only normal gravity brought the body back up.
    // deck_under scans the boxes by XZ alone.
    let m = &MAP;
    // the dockyard floor at a spawn
    assert_eq!(top_under(m, 0.0, 11.0, -12.0), None, "a canopy cannot see the floor");
    assert_eq!(deck_under(m, 0.0, -12.0), Some(0.0), "the deck probe finds it from the sky");
    // a raised catwalk: same story, and it must land ON the catwalk, not y=0
    let (cx, cz) = (-30.0, -26.8);
    assert_eq!(top_under(m, cx, DROP_HEIGHT, cz), None);
    assert_eq!(deck_under(m, cx, cz), Some(2.5), "the catwalk top, not the floor below it");
    // a real gap (off the map box) is None — never a phantom y=0 floor over water
    assert_eq!(deck_under(m, 100.0, 100.0), None, "no box under this XZ: keep the void clock");
    // the same 0.6 XZ pad holeGroundY uses: a body hanging just off the catwalk rim
    // still lands on the catwalk, not on the floor a metre below it
    assert_eq!(deck_under(m, cx, -25.5), Some(2.5), "the rim pad still finds the catwalk");
}

#[test]
fn a_walk_through_a_cluster_takes_every_totem_on_the_same_pass() {
    // Solo's local take is a square of half-extent PICK_R; the judge used a circle,
    // which is strictly smaller — a diagonal sweep left the corner totems standing and
    // they flushed later in bulk. Both pickup bodies use the square reach now.
    let (mut s, t) = started(2, 2, 0.0);
    let n_map = MAP.pickups.len();
    put(&mut s, "u0", 0.0, 0.0, -12.0, t, Some(0));
    // a 2x2 cluster of drop totems, centres 1.0 m apart, so the corner sits at
    // (dx, dz) = (1.0, 1.0): inside the square (1.0 <= PICK_R), outside any circle
    // of radius PICK_R (hypot(1,1) ≈ 1.414 > 1.1).
    let cluster = [("wings", [0.0, 0.0, -12.0]), ("speed", [1.0, 0.0, -12.0]),
                   ("leap", [0.0, 0.0, -11.0]), ("cloak", [1.0, 0.0, -11.0])];
    for (k, (kind, at)) in cluster.iter().enumerate() {
        let j = n_map + k;
        while s.items.len() <= j {
            s.items.push(None);
            s.kinds.push("");
            s.spots.push([0.0, 0.0, 0.0]);
            s.cursed.push(false);
        }
        s.items[j] = None;
        s.kinds[j] = kind;
        s.spots[j] = *at;
    }
    s.player_mut("u0").unwrap().air_at = t;
    // one walk-over at the cluster's centre-left: the square reach must take all four
    s.pickups(0, t);
    for (k, (kind, _)) in cluster.iter().enumerate() {
        let j = n_map + k;
        assert!(s.items[j].is_some(), "{kind} left standing in the cluster");
    }
    let picks = s.pending.iter().filter(|(ev, d)| *ev == "pick" && d["i"].as_i64().is_some()
        && d["i"].as_i64().unwrap() >= n_map as i64).count();
    assert_eq!(picks, cluster.len(), "every take lands on the same pass, not in a bulk later");
}

#[test]
fn a_live_claim_outside_the_judges_leash_still_takes_the_totem_under_it() {
    // The starvation the player kept hitting: the judge's copy freezes on a speed-cap
    // / canopy / token-bucket refusal, the walk keeps going, and the moment the claim
    // sat more than CLAIM_R from that frozen copy it was thrown away -- so neither body
    // was near the totem and the take never landed ("even going through them they are
    // left behind"). A LIVE claim (rewritten every pos frame) is the walk itself and is
    // believed at the body the player named, wherever our copy happens to be.
    let (mut s, t) = started(2, 2, 0.0);
    let n_map = MAP.pickups.len();
    // the judge's copy is parked 8 m short of the totem and has been there a while
    put(&mut s, "u0", 0.0, 0.0, -12.0, t, Some(0));
    s.items[n_map] = None;
    s.kinds[n_map] = "wings";
    s.spots[n_map] = [0.0, 0.0, -8.0];
    {
        let p = s.player_mut("u0").unwrap();
        p.air_at = t;
        p.at = t;
        p.claim = None;
    }
    // one fresh "pos" naming the body the player is actually standing in: 8 m from our
    // copy (past CLAIM_R), same totem. The frame is overspeed so the referee refuses
    // the MOVE -- but the claim is what the take is judged against.
    let (ok, _) = s.pos("u0", &json!({"x": cm(0.0), "y": cm(0.0), "z": cm(-8.0),
                                      "r": 0, "p": 0, "q": 1}), t + 0.05);
    assert!(!ok, "the overspeed frame is refused (the judge's copy does not move)");
    assert!(s.items[n_map].is_some(), "the take lands anyway -- the live claim is the walk");
}

#[test]
fn a_stale_claim_far_from_the_judges_copy_cannot_take_from_across_the_map() {
    // Anti-teleport: a live claim is the walk, but a STALLING one (nobody has sent a
    // frame for CLAIM_R_SECS) is only believed near our own copy. A single far-off
    // "pos" that never follows up must not harvest a totem across the arena.
    let (mut s, t) = started(2, 2, 0.0);
    let n_map = MAP.pickups.len();
    // the judge's copy sits at the far end of the dockyard; the totem is 20 m away
    put(&mut s, "u0", 0.0, 0.0, 0.0, t, Some(0));
    s.items[n_map] = None;
    s.kinds[n_map] = "wings";
    s.spots[n_map] = [0.0, 0.0, -20.0];
    {
        let p = s.player_mut("u0").unwrap();
        p.air_at = t;
        p.at = t;
        // a claim already old (past CLAIM_FRESH) and 20 m from our copy: a stall
        p.claim = Some((0.0, 0.0, -20.0, t - 0.5));
    }
    s.pickups(0, t + 0.4);
    assert!(s.items[n_map].is_none(), "a stalled far-off claim does not take");
    // the same claim, young (a live walk), does take — the walk is what the player is in
    s.player_mut("u0").unwrap().claim = Some((0.0, 0.0, -20.0, t + 0.4));
    s.pickups(0, t + 0.42);
    assert!(s.items[n_map].is_some(), "the live walk at the same body does take");
}

#[test]
fn a_claim_out_of_the_arena_is_never_believed() {
    // A far-off "pos" naming a body outside the map bounds is rejected outright: the
    // claim is the player's own name for where they stand, but it must still be a
    // place a body can stand in THIS arena.
    let (mut s, t) = started(2, 2, 0.0);
    let n_map = MAP.pickups.len();
    put(&mut s, "u0", 0.0, 0.0, -12.0, t, Some(0));
    s.items[n_map] = None;
    s.kinds[n_map] = "wings";
    s.spots[n_map] = [0.0, 0.0, -8.0];
    {
        let p = s.player_mut("u0").unwrap();
        p.air_at = t;
        // a fresh claim, but the body is named as sitting on the moon
        p.claim = Some((0.0, 0.0, -5000.0, t));
    }
    s.pickups(0, t + 0.02);
    assert!(s.items[n_map].is_none(), "a claim outside the arena never takes a totem");
}

#[test]
fn a_bucket_dropped_frame_still_writes_the_claim() {
    // The token bucket used to return before the claim write, so a burst of frames
    // left the claim stale at the OLD body while the player had already walked on --
    // and the totem under the new boots was "not taken". Every frame of the current
    // life names the body; the bucket only decides whether the MOVE is accepted.
    let (mut s, t) = started(2, 2, 0.0);
    put(&mut s, "u0", 0.0, 0.0, -12.0, t, Some(0));
    {
        let p = s.player_mut("u0").unwrap();
        p.air_at = t;
        p.claim = None;
    }
    // a burst far past POS_RATE + POS_BURST: the later frames are bucket-dropped
    let mut accepted = 0;
    for k in 0..40 {
        let (ok, _) = s.pos("u0", &json!({"x": cm(0.0), "y": cm(0.0), "z": cm(-11.0),
                                          "r": 0, "p": 0, "q": k + 1}), t + k as f64 * 0.01);
        if ok { accepted += 1; }
    }
    assert!(accepted < 40, "the bucket really did drop some frames");
    let claim = s.player("u0").unwrap().claim;
    assert!(claim.is_some(), "every current-life frame writes the claim, bucket or not");
    let (cx, cy, cz, _ct) = claim.unwrap();
    assert_eq!((cx, cy, cz), (0.0, 0.0, -11.0), "the claim is the last named body, not the last accepted one");
}

#[test]
fn a_respawn_drops_the_old_life_claim() {
    // place() bumps life and clears the claim: a totem at the previous life's boots
    // must not be taken by the new life's first frame arriving from across the map.
    let (mut s, t) = started(2, 2, 0.0);
    let n_map = MAP.pickups.len();
    put(&mut s, "u0", 0.0, 0.0, -12.0, t, Some(0));
    s.items[n_map] = None;
    s.kinds[n_map] = "wings";
    s.spots[n_map] = [0.0, 0.0, -8.0];
    {
        let p = s.player_mut("u0").unwrap();
        p.air_at = t;
        // the previous life was standing on the totem
        p.claim = Some((0.0, 0.0, -8.0, t));
    }
    let life0 = s.player("u0").unwrap().life;
    // respawn elsewhere on the map
    { let m = s.map(); s.player_mut("u0").unwrap().place([0.0, 0.0, -20.0, 0.0], t + 1.0, m); }
    let life1 = s.player("u0").unwrap().life;
    assert_eq!(life1, life0 + 1, "place() bumps the life");
    assert!(s.player("u0").unwrap().claim.is_none(), "place() drops the old life's claim");
    // the new life's first pickup pass cannot take the totem the old life stood on
    s.pickups(0, t + 1.0);
    assert!(s.items[n_map].is_none(), "a respawn does not take at the previous life's body");
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
    // every life a bot re-rolls: across enough spawns the roster covers every bot
    // weapon (0..BOT_WEAPON_MAX). The grappling gun is players-only — never a bot roll.
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
    assert!(
        seen[..BOT_WEAPON_MAX].iter().all(|x| *x),
        "bots must draw every bot weapon across respawns: {seen:?}"
    );
    assert!(!seen[GRAPPLE_W], "bots must never draw the grappling gun");
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
fn a_rift_is_a_standing_portal_pair_you_walk_through() {
    // User bug: "i see rifft create 1 purple circle in ground and nothing happens in that".
    // The Rift totem now plants a STANDING ring in front of the taker and its twin
    // somewhere random on the map; walking into either exits the other. pos() must
    // accept that hop (otherwise the referee rubber-bands the prediction back).
    let (mut s, t) = started(2, 2, 0.0);
    let i0 = s.players.iter().position(|(u, _)| u == "u0").unwrap();
    let u0 = s.players[i0].0.clone();
    // stand u0 at a known spot facing -Z, then plant the pair
    put(&mut s, &u0, 0.0, 0.0, 0.0, t, Some(0));
    assert!(s.take_totem(i0, "rift", t + 0.1), "the rift totem applies");
    assert_eq!(s.portals.len(), 2, "a Rift is a pair of standing rings");
    let near = s.portals[0].clone();
    let far = s.portals[1].clone();
    // the near ring stands in FRONT of the taker (not 8 m ahead as a flat disc)
    let nd = (near.x - 0.0).hypot(near.z - 0.0);
    assert!((nd - RIFT_FRONT).abs() < 0.6, "the near ring is ~RIFT_FRONT ahead: {nd}");
    // the far ring is a hashed open spot, not a second disc a few metres further on
    let span = (far.x - near.x).hypot(far.z - near.z);
    assert!(span > 4.0, "the far ring is somewhere across the map: {span}");
    // stand in the near ring, then hop to the far ring's step-out (past it, along the
    // pair axis) — pos() must accept that as a legal move
    put(&mut s, &u0, near.x, 0.0, near.z, t + 0.2, Some(0));
    let (mut ax, mut az) = (far.x - near.x, far.z - near.z);
    let aln = ax.hypot(az);
    assert!(aln > 0.01);
    ax /= aln;
    az /= aln;
    let (ex, ez) = (far.x + ax * (RIFT_R + 0.35), far.z + az * (RIFT_R + 0.35));
    let (ok, fix) = s.pos(&u0, &json!({"x": cm(ex), "y": cm(0.0), "z": cm(ez), "r": 0, "p": 0, "q": 30}), t + 0.3);
    assert!(ok, "the walk-in hop is a legal move (fix={:?})", fix);
    let p = s.player(&u0).unwrap();
    // cm() carries two decimals, so the wire rounds the hop to 0.01 m
    assert!((p.x - ex).abs() < 0.011 && (p.z - ez).abs() < 0.011,
            "the body is at the exit: got ({}, {}) want ({}, {}); near=({}, {}) far=({}, {})",
            p.x, p.z, ex, ez, near.x, near.z, far.x, far.z);
    // the same jump WITHOUT standing in a ring is still refused
    let (ok2, _) = s.pos(&u0, &json!({"x": cm(0.0), "y": cm(0.0), "z": cm(0.0), "r": 0, "p": 0, "q": 60}), t + 0.6);
    assert!(!ok2, "a teleport with no ring under you is still refused");
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
        dis: "meteorshower",
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
fn several_disasters_run_at_once_and_the_clock_is_independent() {
    // 3.37.2: "there is no thing that only 1 disaster can happen at a time, multiple
    // can happen too at same time". A new disaster ADDS to the list — it never stops
    // the old one — and the snap ships one row per live disaster so the client can
    // paint and log every one of them.
    let (mut s, t) = started(2, 2, 0.0);
    assert!(s.disasters.is_empty(), "no disaster is live at round start");
    assert!(s.disaster_at.is_some(), "the disaster clock is armed");
    assert!(s.start_disaster("sandstorm", t + 0.1), "the first disaster starts");
    assert!(s.start_disaster("thunder", t + 0.2), "a second disaster starts alongside the first");
    assert_eq!(s.disasters.len(), 2, "both are live at once");
    assert_eq!(s.disasters[0].kind, "sandstorm", "the first is kept");
    assert_eq!(s.disasters[1].kind, "thunder", "the second joins it");
    // past the warn window both count as live (disaster_live = inside the hold)
    assert!(s.disaster_live("sandstorm", t + 0.1 + DIS_WARN + 0.5), "sandstorm is still live");
    assert!(s.disaster_live("thunder", t + 0.2 + DIS_WARN + 0.5), "thunder is live too");
    // the warn window is 2 s, then the hold
    let d = &s.disasters[0];
    assert!((d.warn_at - (t + 0.1) - DIS_WARN).abs() < 1e-6, "warn_at is t + DIS_WARN");
    assert!((d.until - (t + 0.1) - DIS_WARN - DIS_SANDSTORM).abs() < 1e-6, "until is the hold");
    // the snap ships "di" (never "ev") as a LIST of rows — one per live disaster
    s.mark_all();
    let snap = s.snap(t + 0.3);
    assert!(snap.get("ev").is_none(), "the snap never emits a data key named \"ev\"");
    let di = snap["di"].as_array().expect("live disasters ship as \"di\"");
    assert_eq!(di.len(), 2, "one row per live disaster");
    let r0 = di[0].as_array().expect("row");
    assert_eq!(r0[0].as_str().unwrap(), "sandstorm", "row[0] is the kind");
    assert_eq!(r0.len(), 8, "row is [kind, warn, hold, ring, ms-to-next, seed, zones, pit]");
    assert!(di[1].as_array().expect("row")[0].as_str().unwrap() == "thunder", "the second row is thunder");
    assert!(snap["dm"].is_array(), "impact marks ship as \"dm\"");
    // and when nothing is live the countdown row still ships so the top bar can tick
    s.disasters.clear();
    s.disaster_at = Some(t + 5.0);
    let snap2 = s.snap(t + 0.4);
    let di2 = snap2["di"].as_array().expect("the countdown row ships even with nothing live");
    assert_eq!(di2.len(), 1, "just the countdown row");
    assert!(di2[0].as_array().expect("row")[0].is_null(), "no kind when nothing is live");
    assert!(di2[0].as_array().expect("row")[4].as_i64().unwrap_or(0) > 4000, "row[4] is the ms until the next one");
    // the clock fires on its own once the current one is gone — and does not need
    // the list to be empty to do so
    s.disaster_at = Some(t + 0.3);
    s.start_disaster("hurricane", t + 0.35);
    s.tick(t + 0.5, true);
    assert!(!s.disasters.is_empty(), "the clock starts one by itself alongside what is live");
    // and a totem can start one too — without stopping whatever is already running
    let (mut s2, t2) = started(2, 2, 0.0);
    assert!(s2.start_disaster("sandstorm", t2 + 0.1));
    let i0 = s2.players.iter().position(|(u, _)| u == "u0").unwrap();
    assert!(s2.take_totem(i0, "meteorshower", t2 + 0.1), "grabbing a Disaster totem starts it");
    assert_eq!(s2.disasters.len(), 2, "the totem ADDS a disaster, it does not replace");
    assert!(s2.disaster_live("meteorshower", t2 + 0.1 + DIS_WARN + 0.5), "the taker set off a meteor shower");
    assert!(s2.disaster_live("sandstorm", t2 + 0.1 + DIS_WARN + 0.5), "and the first one is still running");
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
    // hurricane vortex: taken up, spun around the core, held off the deck
    assert_eq!(DD_WIND_CATCH_R, 3.6);
    assert_eq!(DD_WIND_TOP, 4.2);
    assert_eq!(DD_WIND_LIFT, 3.2);
    assert_eq!(DD_WIND_SPIN, 2.6);
    assert_eq!(DD_WIND_CATCH, 1.6);
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
        dis: "thunder",
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
    let d = s.disasters.last().unwrap().clone();
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
    let d2 = s2.disasters.last().unwrap().clone();
    let pit1 = d2.pit;
    s2.disaster_tick(t2 + DIS_WARN + 0.5);
    let pit2 = s2.disasters.last().unwrap().pit;
    assert_eq!(pit1, pit2, "the pit must not move mid-hold");

    // snap ships the frozen geometry so the client paints the same spots
    let snap = s2.snap(t2 + DIS_WARN + 0.5);
    let di = snap["di"].as_array().expect("di list");
    assert_eq!(di.len(), 1, "one live disaster ships one row");
    let row = di[0].as_array().expect("di row");
    assert!(row.len() >= 8, "di row carries seed/zones/pit, got {}", row.len());
    assert!(row[5].is_number(), "di[5] is the frozen seed");
    assert!(row[6].is_array(), "di[6] is the toxic cloud centres");
    assert!(row[7].is_array(), "di[7] is the sinkhole pit");
}

#[test]
fn every_disaster_kind_chips_or_hits_hp() {
    // Standing rule: every disaster is visual AND impact on players and bots.
    // Hurricane used to shove with no damage ("what is even disaster without impact").
    // Every one of the ten kinds must chip or hit — not just the one we used to test.
    // Local hazards (quake cracks, the sinkhole pit, toxic clouds) only connect with
    // a body standing on them, so put one there; global ones (sand / wind / EMP / …)
    // reach everyone.
    for kind in DISASTERS {
        let (mut s, t) = started(2, 2, 0.0);
        for (_, p) in s.players.iter_mut() {
            p.hp = 100;
            p.protect = 0.0;
            p.shield_totem_until = 0.0;
            p.slow_until = 0.0;
            p.blind_until = 0.0;
        }
        assert!(s.start_disaster(kind, t), "{kind} starts");
        // stand a body on this kind's frozen hazard, if it has one
        if kind == "sinkhole" {
            let pit = s.disasters.last().unwrap().pit;
            let p = s.player_mut("u0").unwrap();
            p.x = pit.0;
            p.z = pit.1;
            p.protect = 0.0;
        } else if kind == "toxicfog" {
            let zone = s.disasters.last().unwrap().zones.first().copied();
            if let Some((zx, zz)) = zone {
                let p = s.player_mut("u0").unwrap();
                p.x = zx;
                p.z = zz;
                p.protect = 0.0;
            }
        }
        // walk past the warn window and several one-second pulses
        for k in 0..40 {
            if kind == "earthquake" || kind == "meteorshower" || kind == "thunder" {
                let mark = s.warns.first().cloned();
                if let Some(w) = mark {
                    let p = s.player_mut("u0").unwrap();
                    p.x = w.x;
                    p.z = w.z;
                }
            }
            s.disaster_tick(t + DIS_WARN + k as f64 * 0.25);
        }
        let chipped = s.players.iter().any(|(_, p)| {
            p.hp < 100 || p.slow_until > t || p.blind_until > t
        });
        assert!(chipped, "{kind} must chip HP, slow or blind");
    }
}

#[test]
fn a_hurricane_vortex_lifts_and_spins_without_letting_go() {
    // User ask: "anyone who goes inside it … should be revolving around hurricane,
    // lifted in air, not able to control at all". The column must take the body:
    // orbit the core, rise off the deck, and hold the grip across frames.
    let (mut s, t) = started(2, 2, 0.0);
    {
        let p = s.player_mut("u0").unwrap();
        p.hp = 100;
        p.protect = 0.0;
        p.shield_totem_until = 0.0;
        p.slow_until = 0.0;
        p.y = 0.0;
    }
    assert!(s.start_disaster("hurricane", t));
    let t0 = t + DIS_WARN + 0.05;
    // put the body right on the walking column so the catch is immediate
    let d = s.disasters.last().unwrap().clone();
    let span = (d.until - d.warn_at).max(0.1);
    let u = ((t0 - d.warn_at) / span).clamp(0.0, 1.0);
    let b = s.map().bounds();
    let (cx0, cz0, cx1, cz1) = (b[0], b[2], b[3], b[5]);
    let wx = cx0 + hash_match(d.seed, 21) * (cx1 - cx0)
        + ((cx0 + hash_match(d.seed, 23) * (cx1 - cx0)) - (cx0 + hash_match(d.seed, 21) * (cx1 - cx0))) * u;
    let wz = cz0 + hash_match(d.seed, 22) * (cz1 - cz0)
        + ((cz0 + hash_match(d.seed, 24) * (cz1 - cz0)) - (cz0 + hash_match(d.seed, 22) * (cz1 - cz0))) * u;
    {
        let p = s.player_mut("u0").unwrap();
        p.x = wx;
        p.z = wz;
        p.y = 0.0;
    }
    s.disaster_tick(t0);
    let (x0, z0, y0) = {
        let p = s.player("u0").unwrap();
        assert!(p.vortex_until > t0, "standing in the column must catch you");
        assert!(p.slow_until > t0, "loose footing while gripped");
        (p.x, p.z, p.y)
    };
    // several frames later: still gripped, higher up, and NOT standing still
    for k in 1..=8 {
        s.disaster_tick(t0 + k as f64 * 0.05);
    }
    let p = s.player("u0").unwrap();
    assert!(p.vortex_until > t0 + 0.4, "the grip holds across frames");
    assert!(p.y > y0 + 0.05, "the updraught lifts you off the deck");
    assert!(p.y <= DD_WIND_TOP + 1e-6, "…but only up to the top of the column");
    let moved = ((p.x - x0).powi(2) + (p.z - z0).powi(2)).sqrt();
    assert!(moved > 0.2, "you revolve around the core, not stand still (moved {moved})");
    // and the body stays inside the column's reach
    let dd = (p.x - p.vortex_x).hypot(p.z - p.vortex_z);
    assert!(dd <= DD_WIND_R + 1e-6, "the orbit stays inside the column (dd {dd})");
}

#[test]
fn a_earthquake_crack_hits_and_throws_your_step() {
    // User report: "earthquake … i dont see any visual effect or health effect".
    // The health half must never be optional: a crack that lands on you is
    // DD_QUAKE_DMG of proximity crush plus DD_QUAKE_SLOW of a thrown step.
    let (mut s, t) = started(2, 2, 0.0);
    {
        let p = s.player_mut("u0").unwrap();
        p.hp = 100;
        p.protect = 0.0;
        p.shield_totem_until = 0.0;
        p.slow_until = 0.0;
    }
    assert!(s.start_disaster("earthquake", t));
    // park the body on the next mark's spot so the strike connects
    let mut hit = false;
    for k in 0..60 {
        let now = t + DIS_WARN + k as f64 * 0.25;
        // put the player on whatever mark is about to land
        let mark = s.warns.first().cloned();
        {
            let p = s.player_mut("u0").unwrap();
            if let Some(w) = mark {
                p.x = w.x;
                p.z = w.z;
            }
        }
        s.disaster_tick(now);
        let p = s.player("u0").unwrap();
        if p.hp < 100 {
            assert!(p.slow_until > now, "a quake throw slows you at {now}");
            assert!(p.hp <= 100 - (DD_QUAKE_DMG as f64 * 0.4) as i64, "a crack underfoot hurts");
            hit = true;
            break;
        }
    }
    assert!(hit, "a quake must connect with a live body at least once in 15s");
}

#[test]
fn a_sinkhole_pulls_and_bites_at_the_frozen_pit() {
    // User report: "sink hole … i dont see any visual effect or health effect".
    // The judge's pit is the geometry the FX paints (frozen at start_disaster); a
    // body standing on that point must be pulled, slowed and bitten DD_SINK_DMG.
    let (mut s, t) = started(2, 2, 0.0);
    {
        let p = s.player_mut("u0").unwrap();
        p.hp = 100;
        p.protect = 0.0;
        p.shield_totem_until = 0.0;
        p.slow_until = 0.0;
    }
    assert!(s.start_disaster("sinkhole", t));
    let pit = s.disasters.last().unwrap().pit;
    // stand ON the frozen pit — the point the FX mesh sits at
    {
        let p = s.player_mut("u0").unwrap();
        p.x = pit.0;
        p.z = pit.1;
        p.protect = 0.0;
        p.hp = 100;
        p.slow_until = 0.0;
    }
    for k in 0..24 {
        s.disaster_tick(t + DIS_WARN + k as f64 * 0.25);
    }
    let p = s.player("u0").unwrap();
    assert!(p.hp < 100, "standing in the pit must bite, got hp={}", p.hp);
    assert!(p.hp <= 100 - DD_SINK_DMG, "the bite is DD_SINK_DMG={DD_SINK_DMG}, hp={}", p.hp);
    assert!(p.slow_until > t + DIS_WARN, "stumbling toward the pit slows you");
    // the pull drags you toward the pit centre (you are already on it, so it holds)
    assert!(
        (p.x - pit.0).abs() < 0.5,
        "the pull holds you at the pit, got x={} vs {}",
        p.x,
        pit.0
    );
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
    [wd.x, wd.gy + WARDEN_SEE_HEAD, wd.z]
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
    assert!(s.disasters.is_empty(), "nobody but the Warden starts a disaster");

    // the Warden itself calls a disaster on its own clock
    {
        let wd = s.warden.as_mut().unwrap();
        wd.dis_at = t + 0.1;
    }
    let evs = s.tick(t + 20.2, true);
    assert!(!s.disasters.is_empty(), "only the Warden starts a disaster: {:?}", evs);

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
    // the summons stay after the boss — pull them out of this firing lane so the
    // PvP check is about fighters, not about a beast eating the shot
    for d in s.dragons.iter_mut() {
        d.x = 200.0;
        d.z = 200.0;
    }

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

// ------------------------------------------------ grappling gun + drones --
#[test]
fn grapple_routes_stay_inside_the_map_bounds() {
    let b = MAP.bounds();
    let routes = grapple_routes(b);
    assert_eq!(routes.len(), DRONE_N);
    for (a, e, s) in &routes {
        assert!(*s > 0.0);
        for pt in [a, e] {
            assert!(pt[0] >= b[0] - 0.01 && pt[0] <= b[3] + 0.01, "drone x out of bounds");
            assert!(pt[2] >= b[2] - 0.01 && pt[2] <= b[5] + 0.01, "drone z out of bounds");
            assert!((pt[1] - DRONE_Y).abs() < 0.01);
        }
        assert!((a[0] - e[0]).abs() + (a[2] - e[2]).abs() > 1.0, "lane must fly somewhere");
    }
}

fn hold_grapple(s: &mut Strike, uid: &str) {
    let p = s.player_mut(uid).unwrap();
    p.w = GRAPPLE_W;
    p.mag[GRAPPLE_W] = WEAPONS[GRAPPLE_W].mag;
}

#[test]
fn the_grapple_does_no_damage_but_locks_a_foe_trigger() {
    let (mut s, t) = started(2, 1, 0.0);
    put(&mut s, "u0", 0.0, 0.0, 0.0, t, None);
    put(&mut s, "u1", 0.0, 0.0, -10.0, t, None);
    hold_grapple(&mut s, "u0");
    let hp1 = s.player("u1").unwrap().hp;
    let o = [0.0, EYE, 0.0];
    let msg = json!({"w": GRAPPLE_W, "ox": cm(o[0]), "oy": cm(o[1]), "oz": cm(o[2]),
                     "r": 0, "p": 0, "q": 10, "ip": 0});
    let (shot, _) = s.fire("u0", &msg, t + 0.1);
    assert!(shot.is_some(), "the hook fires");
    assert_eq!(s.player("u1").unwrap().hp, hp1, "the grappling gun does no damage");
    assert!(s.player("u1").unwrap().hook_until > t, "the victim is hooked");
    // while hooked the trigger is locked — a real gun's fire is refused
    let refuse = json!({"w": 0, "ox": cm(o[0]), "oy": cm(o[1]), "oz": cm(o[2]),
                        "r": 0, "p": 0, "q": 20, "ip": 0});
    let (refused, _) = s.fire("u1", &refuse, t + 0.2);
    assert!(refused.is_none(), "a hooked fighter cannot shoot");
    // the hook also earns FLAG_HOOK on the snap row, and a "hk" pull row
    s.mark("u1");
    let snap = s.snap(t + 0.3);
    let rows = snap["p"].as_array().unwrap();
    let flagged = rows.iter().any(|r| r[8].as_i64().unwrap_or(0) & FLAG_HOOK != 0);
    assert!(flagged, "FLAG_HOOK rides the snap row");
    let hk = snap["hk"].as_array().cloned().unwrap_or_default();
    assert!(!hk.is_empty(), "the pull rides the snap hk rows");
}

#[test]
fn a_drone_hook_lifts_and_starts_a_swing() {
    let (mut s, t) = started(1, 1, 0.0);
    let routes = s.drones.clone();
    assert!(!routes.is_empty());
    // the judge samples the drone at (t + 0.1) - go_at
    let mt = 0.1;
    let c = drone_at(&routes[0], mt);
    // stand 2 m south of it with eyes at drone altitude, looking north (yaw 0 -> -z)
    put(&mut s, "u0", c[0], c[1] - EYE, c[2] + 2.0, t, None);
    hold_grapple(&mut s, "u0");
    let o = [c[0], c[1], c[2] + 2.0];
    let msg = json!({"w": GRAPPLE_W, "ox": cm(o[0]), "oy": cm(o[1]), "oz": cm(o[2]),
                     "r": 0, "p": 0, "q": 10, "ip": 0});
    let (shot, _) = s.fire("u0", &msg, t + 0.1);
    assert!(shot.is_some(), "the hook fires at the drone");
    let p = s.player("u0").unwrap();
    assert!(p.swing_until > t, "the shooter is swinging");
    assert!(p.hook_drone.is_some(), "the hook names the hull it is on: {:?}", p.hook_drone);
    assert!((p.swing_y - c[1]).abs() < 0.05, "climb target is the drone ({} vs {})", p.swing_y, c[1]);
    assert!(p.y < c[1] - 0.2, "altitude eases up — no teleport ({} -> {})", p.y, c[1]);
    assert!(p.hook_until <= t, "the swinger is not trigger-locked");
}

#[test]
fn shooting_a_drone_down_drops_loot_detaches_the_swing_and_starts_a_disaster() {
    // 3.37.2 user ask: "the drones can be shot just like in blaster arena, but when
    // shot down, then any player who was attached to it while swinging should be
    // detached and brought down in ground like there was no drone. / on shooting down
    // drone it should fall down 3 non disaster totems where that drone was shot down,
    // also any drone is shot down any random disaster should happen in game arena"
    let (mut s, t) = started(2, 2, 0.0);
    let routes = s.drones.clone();
    assert!(!routes.is_empty());
    let mt = 0.1;
    let c = drone_at(&routes[0], mt);
    // u0 swings on drone 0
    put(&mut s, "u0", c[0], c[1] - EYE, c[2] + 2.0, t, None);
    hold_grapple(&mut s, "u0");
    let o = [c[0], c[1], c[2] + 2.0];
    let hook_msg = json!({"w": GRAPPLE_W, "ox": cm(o[0]), "oy": cm(o[1]), "oz": cm(o[2]),
                          "r": 0, "p": 0, "q": 10, "ip": 0});
    let (shot, _) = s.fire("u0", &hook_msg, t + 0.1);
    assert!(shot.is_some(), "the hook fires");
    assert!(s.player("u0").unwrap().swing_until > t, "u0 is swinging");
    let hooked = s.player("u0").unwrap().hook_drone.expect("the hook names its hull");

    // u1 stands south of the drone and shoots THAT hull down (weapon 0)
    let hc = drone_at(&routes[hooked], mt);
    put(&mut s, "u1", hc[0], 0.0, hc[2] + 8.0, t, Some(0));
    {
        let p = s.player_mut("u1").unwrap();
        p.w = 0;
        p.mag[0] = WEAPONS[0].mag;
        p.protect = 0.0;
    }
    let n_dis0 = s.disasters.len();
    let totem_lo = s.drop_rings().0;
    let totem_hi = totem_lo + DROP_SLOTS;
    let o1 = eye(&s, "u1");
    let yaw = (hc[0] - o1[0]).atan2(-(hc[2] - o1[2])).to_degrees();
    let pitch = (hc[1] - o1[1]).atan2((hc[0] - o1[0]).hypot(hc[2] - o1[2])).to_degrees();
    let (dy, dp) = spread_of(1, 0);
    let fire_msg = json!({"w": 0, "ox": cm(o1[0]), "oy": cm(o1[1]), "oz": cm(o1[2]),
                          "r": ((yaw - dy) * 100.0) as i64, "p": ((pitch - dp) * 100.0) as i64,
                          "q": 20, "ip": 0});
    let (bullet, _) = s.fire("u1", &fire_msg, t + 0.2);
    assert!(bullet.is_some(), "the bullet goes out");
    assert!(s.drone_down[hooked] > t + 0.2, "the hooked hull is a wreck");
    // the swinger is detached and falling, as if the drone had never existed
    let p = s.player("u0").unwrap();
    assert!(p.swing_until <= t + 0.2, "the swing dies with the hull");
    assert!(p.hook_drone.is_none(), "no hook_drone left");
    assert_eq!(p.swing_y, 0.0, "the climb target is cleared");
    // 3 non-disaster totems land in their own one-shot slots PAST the drop rings,
    // never in the recycled totem ring (a second drone must not overwrite these)
    let mut n_drops = 0;
    for i in totem_hi..s.kinds.len() {
        if !s.kinds[i].is_empty() {
            assert!(!DISASTERS.contains(&s.kinds[i]),
                    "a drone drop is never a disaster kind: {}", s.kinds[i]);
            n_drops += 1;
        }
    }
    assert_eq!(n_drops, DRONE_TOTEMS, "exactly {} totems fall", DRONE_TOTEMS);
    for i in totem_lo..totem_hi {
        assert!(s.kinds[i].is_empty(), "the recycled totem ring is untouched by drone loot");
    }
    // and a random disaster joins whatever is already running
    assert_eq!(s.disasters.len(), n_dis0 + 1, "the shoot-down starts one disaster");
    // the wreck is un-hookable and blocks nothing: a grapple at it now is a miss
    let (shot2, _) = s.fire("u0", &hook_msg, t + 0.5);
    // (u0 is on the ground now; the point is the hull is skipped)
    assert!(s.drone_down[hooked] > t + 0.5, "still a wreck");
    let _ = shot2;
    // and it comes back after DRONE_DOWN_SECS
    s.tick(t + DRONE_DOWN_SECS + 0.2, true);
    assert!(s.drone_down[hooked] <= t + DRONE_DOWN_SECS + 0.2, "the hull is back after DRONE_DOWN_SECS");
}

#[test]
fn a_second_drone_shot_down_leaves_the_first_wrecks_loot_alone() {
    // User bug: "when i destroy any drone, it drops totems, then when i destroy another
    // drone, old totems (dropped by previous drone) are removed" — drone loot used to
    // round-robin into the 3-slot recycled totem ring, so a later drone overwrote an
    // earlier one's unclaimed totems. They must stay until someone takes them.
    let (mut s, t) = started(2, 2, 0.0);
    let routes = s.drones.clone();
    assert!(routes.len() >= 2);

    // shoot drone 0 down at t+0.2 (the judge samples the hull at t_fire - go_at)
    let f0 = t + 0.2;
    let c0 = drone_at(&routes[0], f0 - t);
    put(&mut s, "u1", c0[0], 0.0, c0[2] + 8.0, t, Some(0));
    {
        let p = s.player_mut("u1").unwrap();
        p.w = 0;
        p.mag[0] = WEAPONS[0].mag;
        p.protect = 0.0;
    }
    let o0 = eye(&s, "u1");
    let yaw0 = (c0[0] - o0[0]).atan2(-(c0[2] - o0[2])).to_degrees();
    let pitch0 = (c0[1] - o0[1]).atan2((c0[0] - o0[0]).hypot(c0[2] - o0[2])).to_degrees();
    let (dy0, dp0) = spread_of(1, 0);
    let msg0 = json!({"w": 0, "ox": cm(o0[0]), "oy": cm(o0[1]), "oz": cm(o0[2]),
                      "r": ((yaw0 - dy0) * 100.0) as i64, "p": ((pitch0 - dp0) * 100.0) as i64,
                      "q": 20, "ip": 0});
    let (b0, _) = s.fire("u1", &msg0, f0);
    assert!(b0.is_some(), "the first bullet goes out");
    assert!(s.drone_down[0] > f0, "drone 0 is a wreck");
    let ring = s.drop_rings();
    let mut first: Vec<String> = Vec::new();
    for i in ring.3..s.kinds.len() {
        if !s.kinds[i].is_empty() {
            first.push(s.kinds[i].to_string());
        }
    }
    assert_eq!(first.len(), DRONE_TOTEMS, "the first drone drops {} totems", DRONE_TOTEMS);

    // knock drone 1 down a moment later (the fire path is covered by the test above;
    // what matters here is that the SECOND wreck's loot lands past the first's)
    let f1 = t + 1.5;
    let c1 = drone_at(&routes[1], f1 - t);
    assert!(s.drone_down(1, c1, f1).is_some(), "drone 1 comes apart");
    assert!(s.drone_down[1] > f1, "drone 1 is a wreck too");
    assert!(s.drone_down[0] > f1, "drone 0 is still a wreck — its loot must survive");

    // every totem the first drone dropped is still sitting there, unclaimed
    for i in ring.3..ring.3 + first.len() {
        assert_eq!(s.kinds[i], first[i - ring.3].as_str(),
                   "the first drone's totem {} is still there after the second shoot-down", i);
        assert!(s.items[i].is_none(), "and it is still live");
    }
    // and the second drone dropped its own three PAST them
    let mut n_new = 0;
    for i in ring.3 + first.len()..s.kinds.len() {
        if !s.kinds[i].is_empty() { n_new += 1; }
    }
    assert_eq!(n_new, DRONE_TOTEMS, "the second drone appends {} more", DRONE_TOTEMS);
}

#[test]
fn no_foe_hook_while_the_warden_lives() {
    let (mut s, t) = started(2, 1, 0.0);
    s.warden_opt = true;
    s.warden_done = false;
    s.warden_summon(t);
    assert!(s.warden.is_some(), "the Warden is up");
    put(&mut s, "u0", 0.0, 0.0, 0.0, t, None);
    put(&mut s, "u1", 0.0, 0.0, -8.0, t, None);
    hold_grapple(&mut s, "u0");
    let hp_before = s.warden.as_ref().unwrap().hp;
    let o = [0.0, EYE, 0.0];
    let msg = json!({"w": GRAPPLE_W, "ox": cm(o[0]), "oy": cm(o[1]), "oz": cm(o[2]),
                     "r": 0, "p": 0, "q": 10, "ip": 0});
    let (shot, _) = s.fire("u0", &msg, t + 0.1);
    assert!(shot.is_some(), "the hook still fires");
    assert!(s.player("u1").unwrap().hook_until <= t, "no foe hook while The Warden lives");
    assert_eq!(s.warden.as_ref().unwrap().hp, hp_before, "zero damage to The Warden");
}

// ------------------------------------------------ the "nothing happens" totems --
// User report: "nothing happens in gravity flip and time rewind, not sure if bullet
// magnet, hunter mark, bubble fortress, rally, kingmaker ... do anything in game".
// Each test drives the real judge (fire / tick / take_totem) and asserts a number.

#[test]
fn time_rewind_travels_a_full_three_seconds() {
    // the old code took hist[len-3] = 3 FRAMES (~0.05 s); the help promises 3 s
    let (mut s, t) = started(1, 1, 0.0);
    // one put() to place the body, then feed the trail directly — put() resets
    // hist every call, so it cannot be the loop's transport
    put(&mut s, "u0", 0.0, 0.0, 0.0, t, None);
    let mut x = 0.0f64;
    let mut tt = t;
    for _ in 0..32 {
        x += 0.6;   // ~6 m/s
        tt += 0.1;
        let p = s.player_mut("u0").unwrap();
        p.x = x;
        p.y = 0.0;
        p.z = 0.0;
        p.hist.push_back((tt, x, 0.0, 0.0));
        while p.hist.len() > 2 && tt - p.hist[0].0 > HIST_S {
            p.hist.pop_front();
        }
    }
    let before = s.player("u0").unwrap().x;
    assert!(before > 15.0, "the body walked a real distance: {before}");
    assert!(s.player("u0").unwrap().hist.len() > 10, "the trail is real");
    let i0 = s.players.iter().position(|(u, _)| u == "u0").unwrap();
    assert!(s.take_totem(i0, "rewind", tt + 0.05), "the rewind totem applies");
    let p = s.player("u0").unwrap();
    let back = before - p.x;
    // 3 s at ~6 m/s is ~18 m; cm() rounding lets us land within 0.5 m
    assert!(back > 15.0, "Time Rewind travels ~3 s of movement ({back} m back from {before})");
    assert!(back < 22.0, "and it does not overshoot the promised window ({back} m)");
    assert!(p.second_wind, "the next killing blow is cancelled too");
}

#[test]
fn bubble_fortress_blocks_incoming_fire_but_not_outgoing() {
    // a live bubble on u1's side eats u0's shot; u1 still shoots out
    let (mut s, t) = started(2, 2, 0.0);
    put(&mut s, "u0", -6.0, 0.0, -9.0, t, Some(0));
    put(&mut s, "u1", -6.0, 0.0, -3.0, t, Some(0));
    for (_, p) in s.players.iter_mut() {
        if p.is_bot() {
            p.gone = true;
        }
    }
    // u1 takes bubble: a sphere around u1's own position
    let i1 = s.players.iter().position(|(u, _)| u == "u1").unwrap();
    assert!(s.take_totem(i1, "bubble", t + 0.1), "the bubble totem applies");
    assert_eq!(s.bubbles.len(), 1, "one sphere is planted");
    let b = s.bubbles[0].clone();
    assert!((b.r - 4.0).abs() < 0.01, "the sphere is the 4 m radius the help promises");
    assert_eq!(b.team, s.player("u1").unwrap().team, "it defends the taker's side");

    // u0 fires straight at u1: the bubble eats it
    let o = eye(&s, "u0");
    let tgt = chest(&s, "u1");
    let yaw = (tgt[0] - o[0]).atan2(-(tgt[2] - o[2])).to_degrees();
    let pitch = (tgt[1] - o[1]).atan2((tgt[0] - o[0]).hypot(tgt[2] - o[2])).to_degrees();
    let (dy, dp) = spread_of(1, 0);
    let msg = json!({"w": 0, "ox": cm(o[0]), "oy": cm(o[1]), "oz": cm(o[2]),
                     "r": ((yaw - dy) * 100.0) as i64, "p": ((pitch - dp) * 100.0) as i64, "q": 10, "ip": 0});
    let hp1 = s.player("u1").unwrap().hp;
    let _ = s.fire("u0", &msg, t + 0.15);
    assert_eq!(s.player("u1").unwrap().hp, hp1, "the bubble eats the incoming shot");

    // u1 fires back out at u0 (u0 is outside their sphere): the shot lands
    let o2 = eye(&s, "u1");
    let tgt2 = chest(&s, "u0");
    let yaw2 = (tgt2[0] - o2[0]).atan2(-(tgt2[2] - o2[2])).to_degrees();
    let pitch2 = (tgt2[1] - o2[1]).atan2((tgt2[0] - o2[0]).hypot(tgt2[2] - o2[2])).to_degrees();
    let (dy2, dp2) = spread_of(2, 0);
    let msg2 = json!({"w": 0, "ox": cm(o2[0]), "oy": cm(o2[1]), "oz": cm(o2[2]),
                      "r": ((yaw2 - dy2) * 100.0) as i64, "p": ((pitch2 - dp2) * 100.0) as i64, "q": 20, "ip": 0});
    let hp0 = s.player("u0").unwrap().hp;
    let _ = s.fire("u1", &msg2, t + 0.25);
    assert!(s.player("u0").unwrap().hp < hp0, "the bubble does not trap your own fire");
}

#[test]
fn kings_reserve_is_topped_up_and_the_window_is_flagged() {
    let (mut s, t) = started(2, 2, 0.0);
    put(&mut s, "u0", -6.0, 0.0, -9.0, t, Some(0));
    for (_, p) in s.players.iter_mut() {
        if p.is_bot() {
            p.gone = true;
        }
    }
    // burn some reserve first so the top-up is visible
    {
        let p = s.player_mut("u0").unwrap();
        p.res = [10, 2, 4, 1, 1];
    }
    let i0 = s.players.iter().position(|(u, _)| u == "u0").unwrap();
    assert!(s.take_totem(i0, "king", t + 0.1), "the king totem applies");
    let p = s.player("u0").unwrap();
    assert!(p.king_until > t, "the window is live");
    assert!(p.res[0] > 10, "reserve ammo is topped up ({} > 10)", p.res[0]);
    assert!(p.res[0] <= WEAPONS[0].reserve * 2, "and it never exceeds 2x reserve");
    assert_eq!(s.beacons.len(), 1, "a king beacon is planted");
    assert_eq!(s.beacons[0].kind, "king");
    // the whole side gets the window
    let team = p.team;
    assert!(s.players.iter().all(|(_, q)| q.team != team || q.gone || q.king_until > t),
            "every living mate is royalty");
    // the flag rides the snap
    s.mark_all();
    let snap = s.snap(t + 0.2);
    let rows = snap["p"].as_array().unwrap();
    let flagged = rows.iter().any(|r| r[8].as_i64().unwrap_or(0) & FLAG_KING != 0);
    assert!(flagged, "FLAG_KING rides the snap row");
}

#[test]
fn rally_drops_a_beacon_that_heals_and_flags_its_taker() {
    let (mut s, t) = started(2, 2, 0.0);
    put(&mut s, "u0", -6.0, 0.0, -9.0, t, Some(0));
    for (_, p) in s.players.iter_mut() {
        if p.is_bot() {
            p.gone = true;
        }
    }
    {
        let p = s.player_mut("u0").unwrap();
        p.hp = 50;
    }
    let i0 = s.players.iter().position(|(u, _)| u == "u0").unwrap();
    assert!(s.take_totem(i0, "rally", t + 0.1), "the rally totem applies");
    assert_eq!(s.beacons.len(), 1, "a rally beacon is planted");
    assert_eq!(s.beacons[0].kind, "rally");
    assert!(s.player("u0").unwrap().rally_until > t, "the taker's FLAG_RALLY window is set");
    // the beacon heals the side near it: 6 hp/s for one second of ticks
    for k in 0..20 {
        s.tick(t + 0.1 + (k as f64) * 0.05, true);
    }
    let p = s.player("u0").unwrap();
    assert!(p.hp > 50, "the beacon heals slowly (hp {} > 50)", p.hp);
    assert!(p.hp <= 100, "and it never overheals");
}

#[test]
fn hunters_mark_strips_cloak_and_flags_the_enemy() {
    let (mut s, t) = started(2, 2, 0.0);
    put(&mut s, "u0", -6.0, 0.0, -9.0, t, Some(0));
    put(&mut s, "u1", -6.0, 0.0, -3.0, t, Some(0));
    for (_, p) in s.players.iter_mut() {
        if p.is_bot() {
            p.gone = true;
        }
    }
    // u1 is cloaked
    {
        let p = s.player_mut("u1").unwrap();
        p.cloak_until = t + CLOAK;
    }
    let i0 = s.players.iter().position(|(u, _)| u == "u0").unwrap();
    assert!(s.take_totem(i0, "mark", t + 0.1), "the mark totem applies");
    let p = s.player("u1").unwrap();
    assert!(p.hunter_until > t, "the enemy is painted for the window");
    assert!(p.cloak_until <= t, "their cloak is stripped — they can't hide");
    // the flag rides the snap
    s.mark_all();
    let snap = s.snap(t + 0.2);
    let rows = snap["p"].as_array().unwrap();
    let flagged = rows.iter().any(|r| r[8].as_i64().unwrap_or(0) & FLAG_HUNTER != 0);
    assert!(flagged, "FLAG_HUNTER rides the snap row");
}

#[test]
fn bullet_magnet_steals_the_hit() {
    // A magnet-holder on the victim's side, standing near the line, takes the hit
    // instead of the aimed mate. (The holder cannot be on the shooter's side:
    // both twins skip the shooter's own team.)
    // teams are k % 2: u0 -> 0, u1 -> 1, u2 -> 0, u3 -> 1. So u0 shoots, u1 is
    // the aimed victim, u3 is the magnet-holder on the same side as u1.
    let (mut s, t) = started(4, 2, 0.0);
    put(&mut s, "u0", -6.0, 0.0, -9.0, t, Some(0));
    put(&mut s, "u1", -6.0, 0.0, -3.0, t, Some(0));
    put(&mut s, "u2", -30.0, 0.0, -30.0, t, Some(0));
    put(&mut s, "u3", -6.0, 0.0, -3.4, t, Some(0));
    for (_, p) in s.players.iter_mut() {
        if p.is_bot() {
            p.gone = true;
        }
    }
    assert_eq!(s.player("u0").unwrap().team, 0);
    assert_eq!(s.player("u1").unwrap().team, 1);
    assert_eq!(s.player("u3").unwrap().team, 1, "the holder shares the victim's side");
    // give the holder the magnet window
    let i3 = s.players.iter().position(|(u, _)| u == "u3").unwrap();
    assert!(s.take_totem(i3, "magnet", t + 0.1), "the magnet totem applies");
    assert!(s.player("u3").unwrap().magnet_until > t, "the holder's window is live");
    // u0 fires straight at u1 — the bullet should land on u3
    let o = eye(&s, "u0");
    let tgt = chest(&s, "u1");
    let yaw = (tgt[0] - o[0]).atan2(-(tgt[2] - o[2])).to_degrees();
    let pitch = (tgt[1] - o[1]).atan2((tgt[0] - o[0]).hypot(tgt[2] - o[2])).to_degrees();
    let (dy, dp) = spread_of(1, 0);
    let msg = json!({"w": 0, "ox": cm(o[0]), "oy": cm(o[1]), "oz": cm(o[2]),
                     "r": ((yaw - dy) * 100.0) as i64, "p": ((pitch - dp) * 100.0) as i64, "q": 30, "ip": 0});
    let hp1 = s.player("u1").unwrap().hp;
    let hp3 = s.player("u3").unwrap().hp;
    let _ = s.fire("u0", &msg, t + 0.15);
    assert_eq!(s.player("u1").unwrap().hp, hp1, "the aimed mate is untouched");
    assert!(s.player("u3").unwrap().hp < hp3, "the magnet-holder took the hit instead");
    // and the flag ships on the snap
    s.mark_all();
    let snap = s.snap(t + 0.2);
    let rows = snap["p"].as_array().unwrap();
    let flagged = rows.iter().any(|r| r[8].as_i64().unwrap_or(0) & FLAG_MAGNET != 0);
    assert!(flagged, "FLAG_MAGNET rides the snap row");
}

#[test]
fn reload_mult_shortens_the_clock_under_king_and_rally() {
    let (mut s, t) = started(1, 1, 0.0);
    put(&mut s, "u0", 0.0, 0.0, 0.0, t, None);
    // baseline: 1.0
    assert!((s.reload_mult(0, 0.0, 0.0, t) - 1.0).abs() < 1e-9, "no buffs: plain reload");
    // king alone: 0.6
    s.player_mut("u0").unwrap().king_until = t + 15.0;
    assert!((s.reload_mult(0, 0.0, 0.0, t) - 0.6).abs() < 1e-9, "king is a 0.6x reload");
    // rally near its beacon: 0.7
    s.player_mut("u0").unwrap().king_until = 0.0;
    s.player_mut("u0").unwrap().rally_until = t + 10.0;
    s.world_k += 1;
    s.beacons.push(Beacon {
        id: s.world_k, x: 1.0, y: 0.0, z: 0.0, kind: "rally",
        team: 0, owner: "u0".into(), until: t + 10.0,
    });
    assert!((s.reload_mult(0, 0.0, 0.0, t) - 0.7).abs() < 1e-9, "rally near its beacon is 0.7x");
    // far from the beacon: no bonus
    assert!((s.reload_mult(0, 50.0, 50.0, t) - 1.0).abs() < 1e-9, "rally is local to the beacon");
    // both together: 0.42
    s.player_mut("u0").unwrap().king_until = t + 15.0;
    assert!((s.reload_mult(0, 0.0, 0.0, t) - 0.42).abs() < 1e-9, "king and rally stack");
}

// ------------------------------------------------------------- Big Head totem --
#[test]
fn the_big_head_totem_doubles_every_skull_in_the_arena() {
    // The geometry: the head AABB grows outward and upward only, the body box never
    // moves. A chest shot must not become a headshot; a near-miss must.
    let (body1, head1) = hit_boxes(0.0, 0.0, 0.0, 1.0);
    let (body2, head2) = hit_boxes(0.0, 0.0, 0.0, BIG_HEAD_S);
    assert_eq!(body1, body2, "the body box never moves");
    assert_eq!(head1[3] - head1[0], 0.5, "ordinary head is 0.5 m wide");
    assert_eq!(head2[3] - head2[0], 1.0, "the big head is 1.0 m wide");
    assert_eq!(head1[4], HEAD_TOP, "ordinary top is 1.9");
    assert_eq!(head2[4], 2.4, "the big top is 2.4");
    assert_eq!(head2[1], BODY_H, "the head still starts at BODY_H");
    // a near-miss: 0.40 m off-centre at head height
    let o = [0.40, 1.65, 10.0];
    let d = [0.0, 0.0, -1.0];
    assert!(ray_player(o, d, 0.0, 0.0, 0.0, 20.0, 1.0).is_none(), "misses an ordinary head");
    let (th, head) = ray_player(o, d, 0.0, 0.0, 0.0, 20.0, BIG_HEAD_S).unwrap();
    assert!(head, "the same shot is a headshot on a big head");
    assert!(th > 9.0 && th < 10.0);
    // a chest shot stays a body shot at both scales
    for hs in [1.0, BIG_HEAD_S] {
        let (_t, head) = ray_player([0.0, 1.0, 10.0], [0.0, 0.0, -1.0], 0.0, 0.0, 0.0, 20.0, hs).unwrap();
        assert!(!head, "a chest shot is never a headshot (hs={hs})");
    }
}

#[test]
fn the_big_head_totem_is_arena_wide_and_rides_the_snapshot() {
    let (mut s, t) = started(4, 2, 0.0);
    for (i, u) in ["u0", "u1", "u2", "u3"].iter().enumerate() {
        put(&mut s, u, 0.0, 0.0, -8.0 + i as f64, t, None);
    }
    let i0 = s.players.iter().position(|(u, _)| u == "u0").unwrap();
    assert!(s.take_totem(i0, "bighead", t + 0.1), "the totem applies");
    assert_eq!(s.big_head_until, t + 0.1 + BIG_HEAD, "the world clock is set for everyone");
    assert!((s.head_scale(t + 0.2) - BIG_HEAD_S).abs() < 1e-9, "live window: big heads");
    assert!((s.head_scale(t + 0.1 + BIG_HEAD + 0.1) - 1.0).abs() < 1e-9, "past the window: ordinary");
    // every living player's snap row carries FLAG_BIGHEAD (the taker included)
    s.mark_all();
    let snap = s.snap(t + 0.2);
    let rows = snap["p"].as_array().unwrap();
    assert_eq!(rows.len(), 4);
    for r in rows {
        let f = r[8].as_i64().unwrap_or(0);
        assert!(f & FLAG_BIGHEAD != 0, "FLAG_BIGHEAD rides every living row");
    }
    // and it leaves when the window does
    s.big_head_until = t;
    s.mark_all();
    let snap = s.snap(t + 0.3);
    for r in snap["p"].as_array().unwrap() {
        let f = r[8].as_i64().unwrap_or(0);
        assert!(f & FLAG_BIGHEAD == 0, "the flag drops with the window");
    }
}

#[test]
fn the_big_head_window_makes_the_judge_call_near_misses_headshots() {
    // End to end through fire(): a shot that misses an ordinary skull lands as a
    // headshot while the window is open. Same muzzle, same aim, different hs.
    //
    // Aim geometry: the victim stands on the centreline; the SHOT is aimed 0.38 m
    // beside their head — outside the ordinary half-width 0.25, inside the big 0.50.
    // Marksman spread is 0.3 deg (0.05 m at 10 m), so the jitter stays in that gap:
    // the ray passes x in [0.33, 0.43] whatever spread_of rolls.
    // The match clock only ever runs forward (lead_ok / qmax), so the two shots are
    // given two rising q anchors and the second is fired far enough later that the
    // marksman's 0.8 s fire-rate gap has closed.
    let (mut s, t) = started(2, 1, 0.0);
    put(&mut s, "u0", 0.0, 0.0, 0.0, t, Some(0));
    put(&mut s, "u1", 0.0, 0.0, -10.0, t, Some(0));   // 10 m downrange, on the centreline
    s.player_mut("u1").unwrap().hp = 200;             // room for a 112 headshot, not a clamp
    let o = eye(&s, "u0");
    let off = 0.38f64;
    let yaw = off.atan2(10.0).to_degrees();
    let pitch = ((1.65 - o[1]) / 10.0).atan().to_degrees();
    let p = s.player_mut("u0").unwrap();
    p.w = 1;            // marksman: spread 0.3 deg
    p.ready = 0;
    p.mag[1] = 5;

    // --- shot 1: no window, must miss ---
    let msg = json!({"w": 1, "ox": cm(o[0]), "oy": cm(o[1]), "oz": cm(o[2]),
                     "r": (yaw * 100.0) as i64, "p": (pitch * 100.0) as i64, "q": 0, "ip": 0});
    let hp0 = s.player("u1").unwrap().hp;
    let (shot, refuse) = s.fire("u0", &msg, t + 0.1);
    assert!(shot.is_some(), "the first shot is accepted (refuse: {refuse:?})");
    assert_eq!(s.player("u1").unwrap().hp, hp0,
               "an ordinary skull is missed by {:.2} m at 10 m", off);

    // --- shot 2: window open, same aim, must land as a headshot ---
    s.big_head_until = t + 100.0;
    let p = s.player_mut("u0").unwrap();
    p.ready = 0;
    let msg2 = json!({"w": 1, "ox": cm(o[0]), "oy": cm(o[1]), "oz": cm(o[2]),
                      "r": (yaw * 100.0) as i64, "p": (pitch * 100.0) as i64,
                      "q": 200, "ip": 0});   // q=2.00 s, 2 s past the first
    let (shot, refuse) = s.fire("u0", &msg2, t + 2.2);
    assert!(shot.is_some(), "the second shot is accepted (refuse: {refuse:?})");
    let p1 = s.player("u1").unwrap();
    assert!(p1.hp < hp0, "the big skull ate the shot (hp {} -> {})", hp0, p1.hp);
    let dealt = hp0 - p1.hp;
    assert_eq!(dealt, WEAPONS[1].head, "a headshot pays the head number");
}

// ------------------------------------------------------------- Disco totem --
#[test]
fn the_disco_totem_puts_the_whole_arena_on_the_floor_but_the_taker() {
    // Everyone except the taker dances and cannot shoot. Both teams, bots included.
    // The taker keeps their gun.
    let (mut s, t) = started(4, 2, 0.0);
    for (i, u) in ["u0", "u1", "u2", "u3"].iter().enumerate() {
        put(&mut s, u, 0.0, 0.0, -8.0 + i as f64, t, None);
    }
    let i0 = s.players.iter().position(|(u, _)| u == "u0").unwrap();
    assert!(s.take_totem(i0, "disco", t + 0.1), "the totem applies");
    assert_eq!(s.player("u0").unwrap().dance_until, 0.0, "the taker never dances");
    for u in ["u1", "u2", "u3"] {
        let p = s.player(u).unwrap();
        assert!((p.dance_until - (t + 0.1 + DISCO)).abs() < 1e-9, "{u} dances for DISCO seconds");
        assert!(p.dance_until > t + 0.1, "{u} is still dancing a moment later");
    }
    // the window lapses
    let late = t + 0.1 + DISCO + 0.1;
    for u in ["u1", "u2", "u3"] {
        assert!(s.player(u).unwrap().dance_until <= late, "{u} stops dancing with the window");
    }
}

#[test]
fn the_disco_totem_rides_the_snapshot_and_leaves_with_the_window() {
    let (mut s, t) = started(4, 2, 0.0);
    for (i, u) in ["u0", "u1", "u2", "u3"].iter().enumerate() {
        put(&mut s, u, 0.0, 0.0, -8.0 + i as f64, t, Some(i as i64));
    }
    let i0 = s.players.iter().position(|(u, _)| u == "u0").unwrap();
    assert!(s.take_totem(i0, "disco", t + 0.1));
    s.mark_all();
    let snap = s.snap(t + 0.2);
    let rows = snap["p"].as_array().unwrap();
    let mut dancing = 0;
    for r in rows {
        let f = r[8].as_i64().unwrap_or(0);
        if f & FLAG_DISCO != 0 {
            dancing += 1;
        }
    }
    assert_eq!(dancing, 3, "the taker's row is the only one without FLAG_DISCO");
    // and it leaves when the window does
    for (_, v) in s.players.iter_mut() {
        v.dance_until = t;
    }
    s.mark_all();
    let snap = s.snap(t + 0.3);
    for r in snap["p"].as_array().unwrap() {
        let f = r[8].as_i64().unwrap_or(0);
        assert!(f & FLAG_DISCO == 0, "the flag drops with the window");
    }
}

#[test]
fn a_dancing_player_cannot_pull_the_trigger() {
    // End to end through fire(): the taker's gun still works, the dancer's does not.
    // The match clock only runs forward (lead_ok / qmax) and the marksman's 0.8 s
    // fire-rate gap must be closed before each of the three shots, so each is given
    // its own rising q anchor 2 s past the last (the same shape the Big Head test uses).
    let (mut s, t) = started(2, 1, 0.0);
    put(&mut s, "u0", 0.0, 0.0, 0.0, t, Some(0));
    put(&mut s, "u1", 0.0, 0.0, -6.0, t, Some(0));
    let o = eye(&s, "u0");
    let shot = |q: i64| json!({"w": 1, "ox": cm(o[0]), "oy": cm(o[1]), "oz": cm(o[2]),
                               "r": 0, "p": 0, "q": q, "ip": 0});
    s.player_mut("u0").unwrap().w = 1;
    s.player_mut("u0").unwrap().mag[1] = 5;
    s.player_mut("u0").unwrap().ready = 0;

    // --- shot 1: free, must fire ---
    let (a, refuse) = s.fire("u0", &shot(0), t + 0.1);
    assert!(a.is_some(), "the taker still shoots (refuse: {refuse:?})");

    // --- shot 2: the Disco landed on u0, the trigger must be locked ---
    s.player_mut("u0").unwrap().dance_until = t + DISCO;
    s.player_mut("u0").unwrap().ready = 0;
    let (b, _) = s.fire("u0", &shot(200), t + 2.2);   // 2 s past the first: the gap is closed
    assert!(b.is_none(), "a dancer cannot pull the trigger");

    // --- shot 3: the dance window has lapsed, the trigger comes back ---
    s.player_mut("u0").unwrap().dance_until = t;
    s.player_mut("u0").unwrap().ready = 0;
    let (c, refuse) = s.fire("u0", &shot(400), t + 4.3);   // 2 s past the locked attempt
    assert!(c.is_some(), "the trigger comes back when the dance ends (refuse: {refuse:?})");
}

#[test]
fn a_dancing_bot_holds_still_and_holds_its_fire() {
    let (mut s, mut t) = started(2, 2, 0.0);
    let bot = s.players.iter().find(|(_, p)| p.is_bot()).map(|(u, _)| u.clone()).unwrap();
    let (x, z) = (s.player(&bot).unwrap().x, s.player(&bot).unwrap().z);
    s.player_mut(&bot).unwrap().dance_until = t + DISCO;
    for _ in 0..50 {
        t += 1.0 / HZ;
        s.tick(t, true);
    }
    let p = s.player(&bot).unwrap();
    assert_eq!((p.x, p.z), (x, z), "a dancing bot does not move");
    // and it recovers
    for _ in 0..(DISCO as usize * HZ as usize + 20) {
        t += 1.0 / HZ;
        s.tick(t, true);
    }
    let p = s.player(&bot).unwrap();
    assert!((p.x - x).hypot(p.z - z) > 0.0 || p.dance_until <= t, "the dance ends with the window");
}

#[test]
fn the_warden_dances_too_when_the_disco_totem_hits() {
    // If the boss is up, a Disco window puts it on the floor: same clock as the
    // players, every attack held, and the snap carries it as ms-dance.
    let (mut s, t) = started_warden(2, 2, 0.0);
    let half = ((s.limit as f64) * WARDEN_TRIGGER).ceil() as i64;
    s.scores[0] = half;
    s.tick(t + 0.05, true);
    assert!(s.warden.is_some(), "the boss is up");

    let i0 = s.players.iter().position(|(u, _)| u == "u0").unwrap();
    let td = t + 0.2;
    assert!(s.take_totem(i0, "disco", td), "the totem applies");
    let wd = s.warden.as_ref().unwrap();
    assert!(
        (wd.dance_until - (td + DISCO)).abs() < 1e-9,
        "the boss dances for the same window"
    );
    assert_eq!(wd.slab_arm, 0.0, "no slam telegraph survives the groove");
    assert_eq!(wd.laser_on, 0.0, "no laser survives the groove");
    assert_eq!(wd.grip_on, 0.0, "no grip survives the groove");

    // while it dances the attack clocks never advance
    let (slab0, laser0, grip0) = {
        let wd = s.warden.as_ref().unwrap();
        (wd.slab_at, wd.laser_at, wd.grip_at)
    };
    for k in 1..20 {
        s.tick(td + f64::from(k) / HZ, true);
    }
    let wd = s.warden.as_ref().unwrap();
    assert_eq!(wd.slab_at, slab0, "no slam is scheduled mid-groove");
    assert_eq!(wd.laser_at, laser0, "no laser is scheduled mid-groove");
    assert_eq!(wd.grip_at, grip0, "no grip is scheduled mid-groove");

    // the snap carries the dance clock (ms-dance, index 16)
    s.mark_all();
    let snap = s.snap(td + 0.1);
    let row = snap["wd"].as_array().unwrap();
    assert!(row.len() > 16, "wd row carries ms-dance: {:?}", row.len());
    assert!(row[16].as_i64().unwrap_or(0) > 0, "ms-dance is live: {:?}", row[16]);

    // and the groove ends with the window
    s.player_mut("u1").unwrap().dance_until = 0.0;
    if let Some(wd) = s.warden.as_mut() {
        wd.dance_until = td + 0.5;
    }
    s.tick(td + 1.0, true);
    let wd = s.warden.as_ref().unwrap();
    assert!(wd.dance_until <= td + 1.0, "the dance ends with the window");
}

// ---------------------------------------------------------- Dragons ----
// Six elemental mounts the Warden summons (fire → golden). Players ride them and
// breathe; the only attack is the breath (30 dps, 4 s spray, 4 s inhale). Untaken
// dragons roam and bite. The Warden never hurts a dragon; disasters deal one the
// same damage they deal a fighter (1x); gunfire always can. Out of bounds kills
// mount + rider. The feed names what fell the mount. Snapshot carries "drg".

#[test]
fn the_warden_summons_six_dragons_on_the_bounds_ring() {
    let (mut s, t) = started_warden(2, 2, 0.0);
    let half = ((s.limit as f64) * WARDEN_TRIGGER).ceil() as i64;
    s.scores[0] = half;
    s.tick(t + 0.05, true);
    assert!(s.warden.is_some(), "the boss is up");
    assert_eq!(s.dragons.len(), WARDEN_DRAGON_N, "six dragons ride in with the boss");
    // one of each tier, fire → golden
    let mut seen = [false; 6];
    for d in &s.dragons {
        assert!(d.tier < WARDEN_DRAGON_TIERS.len(), "tier in range");
        seen[d.tier] = true;
        assert_eq!(d.hp, DRAGON_HP, "fresh dragon, full tank");
        assert_eq!(d.max, DRAGON_HP);
        assert!(d.rider.is_empty(), "nobody is on it yet");
        assert_eq!(d.breath_left, DRAGON_BREATH_SECS, "the breath starts full");
    }
    assert!(seen.iter().all(|&b| b), "one of each tier: {:?}", seen);
    // they stand on the ring, not on the boss
    let b = s.map().bounds();
    let (cx, cz) = ((b[0] + b[3]) * 0.5, (b[2] + b[5]) * 0.5);
    for d in &s.dragons {
        let dd = (d.x - cx).hypot(d.z - cz);
        assert!(dd > 10.0, "on the ring, not at the feet: {dd}");
    }
    // the snap carries them
    let snap = s.snap(t + 0.1);
    let rows = snap["drg"].as_array().expect("drg rows");
    assert_eq!(rows.len(), WARDEN_DRAGON_N, "one row per dragon");
    let r0 = rows[0].as_array().unwrap();
    assert!(r0.len() >= 11, "drg row shape: {:?}", r0.len());
    assert_eq!(r0[8].as_i64().unwrap(), -1, "mount_slot -1 when idle");
}

#[test]
fn a_rider_mounts_and_dismounts_a_dragon() {
    let (mut s, t) = started_warden(2, 2, 0.0);
    let half = ((s.limit as f64) * WARDEN_TRIGGER).ceil() as i64;
    s.scores[0] = half;
    s.tick(t + 0.05, true);
    assert_eq!(s.dragons.len(), WARDEN_DRAGON_N);
    // park a dragon under u0
    let (dx, dz) = (s.dragons[0].x, s.dragons[0].z);
    put(&mut s, "u0", dx + 1.0, 0.0, dz, t + 0.1, Some(0));
    assert!(s.mount("u0", &Value::Null, t + 0.2), "mount in reach");
    assert_eq!(s.dragons[0].rider, "u0", "u0 is in the saddle");
    assert!(s.player("u0").unwrap().dragon_rider, "the rider flag is set");
    // the snap names the saddle
    let snap = s.snap(t + 0.3);
    let rows = snap["drg"].as_array().unwrap();
    let slot0 = s.player("u0").unwrap().slot;
    let mount_slots: Vec<i64> = rows.iter().map(|r| r[8].as_i64().unwrap()).collect();
    assert!(mount_slots.contains(&slot0), "mount_slot carries the rider: {mount_slots:?}");
    // guns are stowed — fire refuses
    let (shot, _) = s.fire("u0", &json!({"w": 0, "ox": 0, "oy": 0, "oz": 0, "r": 0, "p": 0, "q": 1, "ip": 0}), t + 0.4);
    assert!(shot.is_none(), "the guns are stowed on a saddle");
    // dismount steps off to the side
    assert!(s.mount("u0", &Value::Null, t + 0.5), "dismount");
    assert!(s.dragons[0].rider.is_empty(), "the saddle is free");
    assert!(!s.player("u0").unwrap().dragon_rider, "the rider flag clears");
}

#[test]
fn the_breath_sprays_then_inhales() {
    let (mut s, t) = started_warden(2, 2, 0.0);
    let half = ((s.limit as f64) * WARDEN_TRIGGER).ceil() as i64;
    s.scores[0] = half;
    s.tick(t + 0.05, true);
    // the breath is a weapon only after the boss: while the Warden lives a
    // summons is a calm pet and its spray can hit nobody (twin: dragon_tick).
    let t = drain_warden(&mut s, t + 0.1);
    assert!(s.warden.is_none(), "the boss is gone — the breath is armed");
    // everyone else leaves the field so no bot can claim a mount or wander in
    let others: Vec<String> = s
        .players
        .iter()
        .map(|(u, _)| u.clone())
        .filter(|u| u != "u0" && u != "u1")
        .collect();
    for u in &others {
        if let Some(p) = s.player_mut(u) {
            p.dead = true;
            p.gone = true;
        }
    }
    let (dx, dz) = (s.dragons[0].x, s.dragons[0].z);
    put(&mut s, "u0", dx + 1.0, 0.0, dz, t + 0.1, Some(0));
    assert!(s.mount("u0", &Value::Null, t + 0.2), "mount in reach");
    let di = s
        .dragons
        .iter()
        .position(|d| d.rider == "u0")
        .expect("u0 is in a saddle");
    // The mount now takes its pose from the rider (the client flies it), so aim the
    // RIDE, not a frozen dragon. Pet-space forward is (sin, cos): look yaw PI →
    // pet yaw 0 → the head points along +z. Twin: dragon_tick's `PI - r` copy.
    if let Some(p) = s.player_mut("u0") {
        p.r = 18000;
    }
    s.dragons[di].yaw = 0.0;
    // after the first tick the dragon sits on the rider (dx+1, -DRAGON_SEAT, dz),
    // its head 3.2 m along +z
    put(&mut s, "u1", dx + 1.0, 0.0, dz + 8.2, t + 0.3, Some(0));
    let bot_hp0 = s.player("u1").unwrap().hp;
    // hold the trigger every frame — JS renews sprayUntil while the mouse is down,
    // and the judge twin does the same through a "breathe" op per tick
    assert!(s.breathe("u0", &Value::Null, t + 0.3), "the breath opens");
    let mut now = t + 0.3;
    for _ in 0..20 {
        now += 1.0 / HZ;
        s.breathe("u0", &Value::Null, now);
        s.tick(now, true);
    }
    let hp_after = s.player("u1").unwrap().hp;
    assert!(hp_after < bot_hp0, "the cone bites: {hp_after} < {bot_hp0}");
    let left = s.dragons[di].breath_left;
    assert!(left < DRAGON_BREATH_SECS, "the tank drains while spraying: {left}");
    // keep holding until the tank empties (DRAGON_BREATH_SECS at HZ frames a second)
    let hold = (DRAGON_BREATH_SECS * HZ) as usize + 10;
    for _ in 0..hold {
        now += 1.0 / HZ;
        s.breathe("u0", &Value::Null, now);
        s.tick(now, true);
    }
    assert!(s.dragons[di].breath_left <= 0.0, "the tank is dry");
    assert!(s.dragons[di].recharge_at > now, "the inhale is running");
    // and refills after the inhale
    now = s.dragons[di].recharge_at + 0.05;
    s.tick(now, true);
    assert!(
        (s.dragons[di].breath_left - DRAGON_BREATH_SECS).abs() < 1e-9,
        "the tank refills after the inhale"
    );
}

#[test]
fn disasters_deal_normal_damage_to_a_dragon() {
    // No 2x. A disaster hits a dragon for exactly what it hits a fighter for,
    // and gunfire hits it for the weapon's own damage. Twin: dragonHurt in strike.js.
    let (mut s, t) = started_warden(2, 2, 0.0);
    let half = ((s.limit as f64) * WARDEN_TRIGGER).ceil() as i64;
    s.scores[0] = half;
    s.tick(t + 0.05, true);
    let hp0 = s.dragons[0].hp;
    s.dragon_hurt(0, 10, "meteorshower", t + 0.1);
    assert_eq!(s.dragons[0].hp, hp0 - 10, "a disaster deals the same 10 a fighter takes");
    let hp1 = s.dragons[0].hp;
    s.dragon_hurt(0, 10, "gunfire", t + 0.2);
    assert_eq!(s.dragons[0].hp, hp1 - 10, "a bullet is the same 10");
    let hp2 = s.dragons[0].hp;
    s.dragon_hurt(0, 25, "thunder", t + 0.3);
    assert_eq!(s.dragons[0].hp, hp2 - 25, "a thunder strike is 25, not 50");
}

#[test]
fn the_warden_never_hurts_a_dragon() {
    // The Warden cannot hurt a dragon at all. The laser sweeps, the arm slams and
    // the gravity grip all leave a summon untouched — only disasters and gunfire
    // bring one down mid-fight. Twin: wardenTick in games/strike.js.
    let (mut s, t) = started_warden(2, 2, 0.0);
    let half = ((s.limit as f64) * WARDEN_TRIGGER).ceil() as i64;
    s.scores[0] = half;
    s.tick(t + 0.05, true);
    assert!(s.warden.is_some(), "the boss is up");
    assert_eq!(s.dragons[0].hp, DRAGON_HP, "full hp at the summons");
    // park every Warden attack except the ones under test, and point the beam
    // straight at dragon 0 so a laser that COULD bite would.
    let (bx, bz) = (s.dragons[0].x, s.dragons[0].z);
    for i in 1..s.dragons.len() {
        s.dragons[i].x = bx + 40.0;
        s.dragons[i].z = bz + 40.0;
    }
    {
        let wd = s.warden.as_mut().unwrap();
        wd.dis_at = t + 1000.0;
        wd.laser_yaw = (bz - wd.z).atan2(bx - wd.x);
        wd.laser_warn = t + 0.2;
        wd.laser_on = t + 0.2 + WARDEN_LASER_HOLD;
        wd.laser_at = t + 1000.0;
    }
    let mut now = t + 0.1;
    for _ in 0..((WARDEN_LASER_HOLD * HZ) as usize + 20) {
        now += 1.0 / HZ;
        s.tick(now, true);
    }
    assert_eq!(
        s.dragons[0].hp, DRAGON_HP,
        "the laser goes right past a dragon — the Warden never hurts one"
    );
    // an arm slam and a gravity grip leave it just as untouched
    {
        let wd = s.warden.as_mut().unwrap();
        wd.laser_on = 0.0;
        wd.laser_at = now + 1000.0;
        wd.slab_at = now + 0.1;
        wd.grip_at = now + 0.1;
        wd.grip_warn = 0.0;
    }
    for _ in 0..(HZ as usize) {
        now += 1.0 / HZ;
        s.tick(now, true);
    }
    assert_eq!(
        s.dragons[0].hp, DRAGON_HP,
        "the fist and the open hand hit the DECK, never a summon"
    );
    // gunfire still brings one down
    s.dragon_hurt(0, DRAGON_HP, "gunfire", now + 0.1);
    assert_eq!(s.dragons[0].hp, 0, "gunfire kills a dragon");
}

#[test]
fn a_rider_in_the_saddle_is_not_a_ground_target() {
    // A floor beam, an arm slam and the gravity grip are DECK attacks. The mount
    // soaks them; they must never delete the rider out of the saddle. The Warden
    // does not hurt the dragon either — the skip is about the RIDER, not the beast.
    let (mut s, t) = started_warden(2, 2, 0.0);
    let half = ((s.limit as f64) * WARDEN_TRIGGER).ceil() as i64;
    s.scores[0] = half;
    s.tick(t + 0.05, true);
    let (dx, dz) = (s.dragons[0].x, s.dragons[0].z);
    put(&mut s, "u0", dx + 1.0, 0.0, dz, t + 0.1, Some(0));
    assert!(s.mount("u0", &Value::Null, t + 0.2), "board the mount");
    assert!(s.player("u0").unwrap().dragon_rider, "in the saddle");
    let deaths0 = s.player("u0").unwrap().deaths;
    let hp0 = s.player("u0").unwrap().hp;
    // park the arm/disaster clocks, then run a full laser sweep across the pair
    {
        let wd = s.warden.as_mut().unwrap();
        wd.dis_at = t + 1000.0;
        wd.slab_at = t + 1000.0;
        wd.slab_arm = 0.0;
        wd.slab_land = 0.0;
        wd.grip_at = t + 1000.0;
        wd.grip_warn = 0.0;
        wd.grip_on = 0.0;
        wd.laser_yaw = (dz - wd.z).atan2(dx - wd.x);
        wd.laser_warn = t + 0.3;
        wd.laser_on = t + 0.3 + WARDEN_LASER_HOLD;
        wd.laser_at = t + 1000.0;
    }
    let mut now = t + 0.25;
    for _ in 0..((WARDEN_LASER_HOLD * HZ) as usize + 20) {
        now += 1.0 / HZ;
        s.tick(now, true);
    }
    assert!(
        !s.player("u0").unwrap().dead,
        "the floor laser must not delete a rider out of the saddle"
    );
    assert_eq!(s.player("u0").unwrap().deaths, deaths0, "no death counted");
    assert_eq!(s.player("u0").unwrap().hp, hp0, "the rider is untouched");
    assert!(s.player("u0").unwrap().dragon_rider, "still in the saddle");
    // and the mount is untouched too — the Warden cannot hurt a dragon
    assert_eq!(s.dragons[0].hp, DRAGON_HP, "the Warden never hurts a dragon");
}

#[test]
fn a_dragon_can_fly_anywhere_with_no_out_of_bounds() {
    // The sky is open: no map edge, no ceiling. A rider who flies the mount past
    // the arena keeps flying — the pair is neither killed nor rubber-banded home.
    // Twin: dragonTick in games/strike.js (client flies the mount).
    let (mut s, t) = started_warden(2, 2, 0.0);
    let half = ((s.limit as f64) * WARDEN_TRIGGER).ceil() as i64;
    s.scores[0] = half;
    s.tick(t + 0.05, true);
    let (dx, dz) = (s.dragons[0].x, s.dragons[0].z);
    put(&mut s, "u0", dx + 1.0, 0.0, dz, t + 0.1, Some(0));
    assert!(s.mount("u0", &Value::Null, t + 0.2), "board the mount");
    // fling the RIDER past the map edge and up over the old ceiling
    let deaths0 = s.player("u0").unwrap().deaths;
    let (b0, b3, b4) = {
        let b = s.map().bounds();
        (b[0], b[3], b[4])
    };
    let fling_x = b0 - 30.0;
    let fling_y = b4 + 40.0;
    if let Some(p) = s.player_mut("u0") {
        p.x = fling_x;
        p.y = fling_y;
        p.z = 100.0;
    }
    s.tick(t + 0.3, true);
    assert_eq!(s.dragons[0].hp, DRAGON_HP, "no out-of-bounds damage");
    assert!(!s.player("u0").unwrap().dead, "the rider is still alive");
    assert_eq!(s.player("u0").unwrap().deaths, deaths0, "no death counted");
    assert_eq!(s.dragons[0].rider, "u0", "still in the saddle");
    // the mount followed the rider off the map
    assert!(s.dragons[0].x < b0 - 10.0, "the mount is outside the map edge");
    assert!(s.dragons[0].y > b4 + 10.0, "the mount is above the old ceiling");
    // and a far-side fling is the same — the other edge is not a wall either
    if let Some(p) = s.player_mut("u0") {
        p.x = b3 + 50.0;
        p.y = 0.0;
        p.z = -120.0;
    }
    s.tick(t + 0.5, true);
    assert_eq!(s.dragons[0].hp, DRAGON_HP, "still no out-of-bounds damage");
    assert!(!s.player("u0").unwrap().dead, "still alive at the far edge");
    assert_eq!(s.dragons[0].rider, "u0", "still in the saddle");
}

#[test]
fn an_untaken_dragon_roams_and_bites() {
    let (mut s, t) = started_warden(2, 2, 0.0);
    let half = ((s.limit as f64) * WARDEN_TRIGGER).ceil() as i64;
    s.scores[0] = half;
    s.tick(t + 0.05, true);
    // roaming + biting is a post-boss behaviour: while the Warden lives the
    // summons only patrol (twin: dragonRoam / dragon_tick's roam gate).
    let t = drain_warden(&mut s, t + 0.1);
    assert!(s.warden.is_none(), "the boss is gone — the beasts are loose");
    // every other fighter is out of the hunt so u1 is the only target, and u1
    // starts outside bite range so the beast has to walk in before it can bite
    let (dx, dz, dy) = (s.dragons[0].x, s.dragons[0].z, s.dragons[0].y);
    let others: Vec<String> = s.players.iter().map(|(u, _)| u.clone()).filter(|u| u != "u1").collect();
    for u in &others {
        if let Some(p) = s.player_mut(u) {
            p.dead = true;
            p.gone = true;
        }
    }
    put(&mut s, "u1", dx + 8.0, dy, dz, t + 0.1, Some(0));
    let hp0 = s.player("u1").unwrap().hp;
    let mut now = t + 0.1;
    for _ in 0..60 {
        now += 1.0 / HZ;
        s.tick(now, true);
    }
    assert!(s.player("u1").unwrap().hp < hp0, "the beast bites");
    // and the bones walk
    assert!((s.dragons[0].x - dx).hypot(s.dragons[0].z - dz) > 0.5, "it prowls");
}

#[test]
fn while_the_warden_lives_nobody_hurts_a_dragon_and_a_dragon_hurts_nobody() {
    // The Warden never touches a dragon, but anyone with a gun can — gunfire is
    // the one attack that always bites a summon. A summons is still a calm pet
    // until the boss falls (it does not bite back mid-fight).
    let (mut s, t) = started_warden(2, 2, 0.0);
    let half = ((s.limit as f64) * WARDEN_TRIGGER).ceil() as i64;
    s.scores[0] = half;
    s.tick(t + 0.05, true);
    assert!(s.warden.is_some(), "the boss is up");
    let hp0 = s.dragons[0].hp;
    // a human can still open up on a summon — gunfire hurts a dragon even while
    // the Warden lives (twin: fire_inner picks the NEARER of dragon / boss).
    // Bots never spend a shot on a summon mid-fight; that has its own test.
    let (dx, dz, dy) = (s.dragons[0].x, s.dragons[0].z, s.dragons[0].y);
    put(&mut s, "u1", dx + 2.0, dy, dz, t + 0.1, Some(0));
    let tgt = [dx, dy + 1.6, dz];
    let msg = aim_msg(&s, "u1", tgt, 0, 30);
    let _ = s.fire("u1", &msg, t + 0.2);
    s.tick(t + 0.25, true);
    assert!(s.dragons[0].hp < hp0, "gunfire hurts a summons even while the boss lives");
    // and the summons cannot bite anyone
    let u1_hp = s.player("u1").unwrap().hp;
    put(&mut s, "u1", dx + 2.0, dy, dz, t + 0.3, Some(0));
    let mut now = t + 0.3;
    for _ in 0..60 {
        now += 1.0 / HZ;
        s.tick(now, true);
    }
    assert_eq!(s.player("u1").unwrap().hp, u1_hp, "no bite while the boss lives");
    // the roster is still there after the boss
    let _end = drain_warden(&mut s, now + 0.1);
    assert!(s.warden.is_none(), "the boss is gone");
    assert_eq!(s.dragons.len(), WARDEN_DRAGON_N, "the summons stay after the boss");
}

#[test]
fn a_bot_spends_no_shot_on_a_summon_while_the_warden_lives() {
    // While the boss lives a bot's bullet is for the boss alone — it will not
    // spend a shot on a summon, even one sitting on the line of fire. The
    // human-fire path still picks the nearer body. Twin: bot_fire in strike.js
    // botJudge.
    let (mut s, t) = started_warden(2, 2, 0.0);
    let half = ((s.limit as f64) * WARDEN_TRIGGER).ceil() as i64;
    s.scores[0] = half;
    s.tick(t + 0.05, true);
    assert!(s.warden.is_some(), "the boss is up");
    let hp0 = s.dragons[0].hp;
    // park the slam / laser / disaster clocks so they cannot steal the frame
    {
        let wd = s.warden.as_mut().unwrap();
        wd.dis_at = t + 1000.0;
        wd.laser_at = t + 1000.0;
        wd.laser_warn = 0.0;
        wd.laser_on = 0.0;
        wd.slab_at = t + 1000.0;
    }
    // put a bot right where it can shoot the summon, and aim it at the summon
    let bid = s
        .players
        .iter()
        .find(|(_, p)| p.is_bot())
        .map(|(u, _)| u.clone())
        .expect("a bot filler");
    let (dx, dz, dy) = (s.dragons[0].x, s.dragons[0].z, s.dragons[0].y);
    put(&mut s, &bid, dx + 2.0, dy, dz, t + 0.1, Some(0));
    {
        let p = s.player_mut(&bid).unwrap();
        if let Some(b) = p.bot.as_mut() {
            b.body.x = dx + 2.0;
            b.body.y = dy;
            b.body.z = dz;
            b.body.vx = 0.0;
            b.body.vy = 0.0;
            b.body.vz = 0.0;
            b.fire_at = -1e9;
            b.think_at = t;
            b.seen_at = Some(t);
            // aim the bot straight at the summon's body — the OLD rule would
            // have eaten the shot on the dragon here
            let tgt = [dx, dy + 1.6, dz];
            let o = [dx + 2.0, dy + EYE, dz];
            b.aim_y = (tgt[0] - o[0]).atan2(-(tgt[2] - o[2])).to_degrees();
            b.aim_p = (tgt[1] - o[1]).atan2((tgt[0] - o[0]).hypot(tgt[2] - o[2])).to_degrees();
        }
    }
    let mut now = t + 0.1;
    for _ in 0..20 {
        now += 1.0 / HZ;
        s.tick(now, true);
    }
    assert_eq!(
        s.dragons[0].hp, hp0,
        "a bot spends no shot on a summon while the boss lives"
    );
}

#[test]
fn the_roster_stays_after_the_warden_falls() {
    let (mut s, t) = started_warden(2, 2, 0.0);
    let half = ((s.limit as f64) * WARDEN_TRIGGER).ceil() as i64;
    s.scores[0] = half;
    s.tick(t + 0.05, true);
    let end = drain_warden(&mut s, t + 0.1);
    assert!(s.warden.is_none(), "the boss is gone");
    assert_eq!(s.dragons.len(), WARDEN_DRAGON_N, "the roster stays after the boss");
    // a ridden dragon stays under its rider
    let (dx, dz) = (s.dragons[0].x, s.dragons[0].z);
    put(&mut s, "u0", dx + 1.0, 0.0, dz, end + 0.1, Some(0));
    assert!(s.mount("u0", &Value::Null, end + 0.2), "mount after the boss");
    assert_eq!(s.dragons[0].rider, "u0", "the saddle is yours");
    // match teardown is what clears it
    s.end();
    assert!(s.dragons.is_empty(), "teardown clears the roster");
}

// -------------------------------------------------- Wave F: joke world totems --
#[test]
fn banana_panic_scatters_deterministic_peels() {
    // The peels come from the world counter + clock, never Math.random — the same
    // seed always paints the same ten peels. Twin: the JS totemApply "banana" arm.
    let (mut s, t) = started(2, 1, 0.0);
    put(&mut s, "u0", 0.0, 0.0, 0.0, t, None);
    put(&mut s, "u1", 0.0, 0.0, -4.0, t, None);
    let i0 = s.players.iter().position(|(u, _)| u == "u0").unwrap();
    assert!(s.take_totem(i0, "banana", t + 0.1), "the totem applies");
    assert_eq!(s.bananas.len(), BANANA_N, "BANANA_N peels land");
    // a second take with the same clock is a different world_k — still BANANA_N peels
    let before: Vec<_> = s.bananas.iter().map(|b| (b.x, b.z)).collect();
    assert!(s.take_totem(i0, "banana", t + 0.1));
    assert_eq!(s.bananas.len(), 2 * BANANA_N, "the second take appends, never replaces");
    assert_ne!(s.bananas[BANANA_N].x, before[0].0, "a fresh world_k scatters fresh peels");
    // the snapshot carries them
    let snap = s.snap(t + 0.2);
    assert_eq!(snap["bn"].as_array().unwrap().len(), 2 * BANANA_N, "snap key bn");
}

#[test]
fn a_banana_slip_locks_the_slide_and_spins_the_body() {
    // Stepping on a peel: slip_until opens, the slide direction is locked, and the
    // bot's physics body (not just the rendered copy) is the thing that moves.
    let (mut s, t) = started(2, 2, 0.0);
    let bot = s.players.iter().find(|(_, p)| p.is_bot()).map(|(u, _)| u.clone()).unwrap();
    put(&mut s, &bot, 2.0, 0.0, 2.0, t, None);
    // plant a peel right under the bot and force a slip
    s.world_k += 1;
    s.bananas.push(BananaPeel { id: 1, x: 2.0, z: 2.0 });
    let t2 = t + 0.2;
    s.tick(t2, true);
    let p = s.player(&bot).unwrap();
    assert!(p.slip_until > t2, "the slip window opens");
    assert!(p.slip_vx.abs() > 0.01 || p.slip_vz.abs() > 0.01, "the slide direction is locked");
    let b = p.bot.as_ref().unwrap();
    assert!((b.body.vx - p.vx).abs() < 1e-9, "the body carries the slide, not just the row");
    assert!((b.body.vz - p.vz).abs() < 1e-9, "the body carries the slide, not just the row");
    // the spin writes aim_y, which is what p.r is made from
    let r0 = p.r;
    for _ in 0..10 {
        s.tick(t2 + 0.1, true);
    }
    let p = s.player(&bot).unwrap();
    assert!(p.r != r0, "the slipped body spins");
}

#[test]
fn floor_is_lava_launches_and_burns_but_higher_ground_saves() {
    let (mut s, t) = started(2, 1, 0.0);
    put(&mut s, "u0", 0.0, 0.0, 0.0, t, None);
    put(&mut s, "u1", 5.0, 3.0, 5.0, t, None);   // up on a ledge
    let i0 = s.players.iter().position(|(u, _)| u == "u0").unwrap();
    assert!(s.take_totem(i0, "lava", t + 0.1), "the totem applies");
    assert_eq!(s.lava_zones.len(), LAVA_ZONES, "LAVA_ZONES patches land");
    // force a patch right under u0
    s.lava_zones.push(LavaZone { id: 99, x: 0.0, z: 0.0, r: LAVA_R });
    let hp0 = s.player("u0").unwrap().hp;
    let mut t2 = t + 0.2;
    for _ in 0..((LAVA_HOLD as usize + 2) * HZ as usize) {
        t2 += 1.0 / HZ;
        s.tick(t2, true);
    }
    let p = s.player("u0").unwrap();
    assert!(p.hp < hp0, "standing in the lava burns ({} -> {})", hp0, p.hp);
    assert!(p.y > 0.0, "and it launches you upward");
    let q = s.player("u1").unwrap();
    assert_eq!(q.hp, HP, "higher ground saves you");
}

#[test]
fn the_goose_chases_the_nearest_and_headbutts_once() {
    let (mut s, t) = started(2, 2, 0.0);
    put(&mut s, "u0", 0.0, 0.0, 0.0, t, None);
    put(&mut s, "u1", 20.0, 0.0, 20.0, t, None);
    let i0 = s.players.iter().position(|(u, _)| u == "u0").unwrap();
    assert!(s.take_totem(i0, "goose", t + 0.1), "the totem applies");
    let g = s.geese.first().cloned().expect("a goose spawns");
    assert!(g.until > t + 0.1, "the goose lives for GOOSE seconds");
    let hp0 = s.player("u0").unwrap().hp;
    let mut t2 = t + 0.2;
    for _ in 0..(GOOSE_SPEED as usize * HZ as usize * 2) {
        t2 += 1.0 / HZ;
        s.tick(t2, true);
        if s.geese.is_empty() {
            break;
        }
    }
    let p = s.player("u0").unwrap();
    assert!(
        p.hp < hp0 || s.geese.iter().all(|g| g.until <= t2),
        "the nearest player eats a headbutt"
    );
    // one headbutt and the goose is satisfied
    assert!(
        s.geese.is_empty() || s.geese.iter().all(|g| g.until <= t2),
        "the goose stands down"
    );
}

#[test]
fn reverse_controls_flips_the_bot_wish_and_the_snapshot_flag() {
    let (mut s, t) = started(2, 2, 0.0);
    let bot = s.players.iter().find(|(_, p)| p.is_bot()).map(|(u, _)| u.clone()).unwrap();
    put(&mut s, &bot, 0.0, 0.0, 0.0, t, None);
    let i0 = s.players.iter().position(|(u, _)| u == "u0").unwrap();
    assert!(s.take_totem(i0, "reverse", t + 0.1), "the totem applies");
    assert!(s.reverse_until > t + 0.1, "the arena-wide window opens");
    s.mark_all();
    let snap = s.snap(t + 0.2);
    let mut flagged = 0;
    for r in snap["p"].as_array().unwrap() {
        if r[8].as_i64().unwrap_or(0) & FLAG_REVERSE != 0 {
            flagged += 1;
        }
    }
    assert_eq!(flagged, s.players.len(), "FLAG_REVERSE rides every living row");
    // and the window closes
    s.reverse_until = t;
    s.mark_all();
    let snap = s.snap(t + 0.3);
    for r in snap["p"].as_array().unwrap() {
        assert!(r[8].as_i64().unwrap_or(0) & FLAG_REVERSE == 0, "the flag drops with the window");
    }
}

#[test]
fn the_black_hole_sucks_bodies_toward_the_centre() {
    let (mut s, t) = started(2, 1, 0.0);
    put(&mut s, "u0", 8.0, 0.0, 0.0, t, None);
    put(&mut s, "u1", -8.0, 0.0, 0.0, t, None);
    let i0 = s.players.iter().position(|(u, _)| u == "u0").unwrap();
    assert!(s.take_totem(i0, "blackhole", t + 0.1), "the totem applies");
    let h = s.blackholes.first().cloned().expect("a hole opens");
    assert!(h.until > t + 0.1, "it lives for BLACKHOLE seconds");
    assert!((h.x).abs() < 1e-9 && (h.z).abs() < 1e-9, "it sits at the arena centre");
    let x0 = s.player("u0").unwrap().x;
    let mut t2 = t + 0.2;
    for _ in 0..(2 * HZ as usize) {
        t2 += 1.0 / HZ;
        s.tick(t2, true);
    }
    let x1 = s.player("u0").unwrap().x;
    assert!(x1.abs() < x0.abs(), "u0 is pulled inward ({} -> {})", x0, x1);
    // and the bot body goes with it (not just the rendered copy)
    let bot = s.players.iter().find(|(_, p)| p.is_bot()).map(|(u, _)| u.clone());
    if let Some(bid) = bot {
        let p = s.player(&bid).unwrap();
        if let Some(b) = p.bot.as_ref() {
            assert!((b.body.x - p.x).abs() < 1e-6, "the body tracks the pull");
        }
    }
}

/// User bug: "black hole doesn't seem to be working". The pull was capped at
/// `HOLE_R * 8` = 17.6 m from the centre — on the dockyard map (84 x 60 m) that is a
/// bubble nobody spawns inside, so the totem did nothing. The help promises
/// "everything and everyone", so the reach has to cover the whole arena. Someone
/// standing 30 m out must still feel it.
#[test]
fn the_black_hole_reaches_across_the_whole_arena() {
    let (mut s, t) = started(2, 1, 0.0);
    put(&mut s, "u0", 8.0, 0.0, 0.0, t, None);
    // a long way out — past the old 17.6 m bubble, well inside HOLE_REACH
    put(&mut s, "u1", 30.0, 0.0, 10.0, t, None);
    let i0 = s.players.iter().position(|(u, _)| u == "u0").unwrap();
    assert!(s.take_totem(i0, "blackhole", t + 0.1), "the totem applies");
    let far0 = s.player("u1").unwrap().x.hypot(s.player("u1").unwrap().z);
    let mut t2 = t + 0.2;
    for _ in 0..(2 * HZ as usize) {
        t2 += 1.0 / HZ;
        s.tick(t2, true);
    }
    let p1 = s.player("u1").unwrap();
    let far1 = p1.x.hypot(p1.z);
    assert!(
        far1 < far0,
        "a body 30 m out is still pulled in ({} -> {}) — the reach must cover the arena",
        far0,
        far1
    );
}

#[test]
fn weapon_roulette_re_rolls_and_refills_the_mag() {
    let (mut s, t) = started(2, 1, 0.0);
    put(&mut s, "u0", 0.0, 0.0, 0.0, t, None);
    put(&mut s, "u1", 0.0, 0.0, -4.0, t, None);
    let i0 = s.players.iter().position(|(u, _)| u == "u0").unwrap();
    assert!(s.take_totem(i0, "roulette", t + 0.1), "the totem applies");
    assert!(s.roulette_until > t + 0.1, "the arena-wide window opens");
    // park everyone on weapon 0 with an empty mag so a switch is visible
    for (_, p) in s.players.iter_mut() {
        p.w = 0;
        p.mag[0] = 0;
    }
    let mut t2 = t + 0.1 + ROULETTE_GAP - 0.05;
    s.tick(t2, true);
    t2 = t + 0.1 + ROULETTE_GAP + 0.05;
    s.tick(t2, true);
    let mut any_swapped = false;
    for (_, p) in s.players.iter() {
        if p.w != 0 {
            any_swapped = true;
        }
        assert!(p.mag[p.w] == WEAPONS[p.w].mag, "the mag is refilled on every switch");
    }
    assert!(any_swapped, "every gun re-rolls");
    // FLAG_ROULETTE rides every row while the window runs
    s.mark_all();
    let snap = s.snap(t2 + 0.05);
    let mut flagged = 0;
    for r in snap["p"].as_array().unwrap() {
        if r[8].as_i64().unwrap_or(0) & FLAG_ROULETTE != 0 {
            flagged += 1;
        }
    }
    assert_eq!(flagged, s.players.len(), "FLAG_ROULETTE rides every living row");
}

// -------------------------------------------------- Wave G: trap-and-gadget set --
#[test]
fn mini_turret_drops_three_and_shoots_the_nearest_enemy() {
    // TURRET_N turrets scatter from world_k (never Math.random), hold the taker's
    // team, and fire TURRET_DMG every TURRET_GAP at the nearest ENEMY in range.
    let (mut s, t) = started(4, 2, 0.0);
    put(&mut s, "u0", 0.0, 0.0, 0.0, t, None);
    put(&mut s, "u2", 1.0, 0.0, 0.0, t, None);   // team-mate (team 0)
    put(&mut s, "u1", 4.0, 0.0, 0.0, t, None);   // enemy near
    put(&mut s, "u3", 30.0, 0.0, 0.0, t, None);  // enemy far (beyond TURRET_RANGE)
    let i0 = s.players.iter().position(|(u, _)| u == "u0").unwrap();
    assert!(s.take_totem(i0, "turret", t + 0.1), "the totem applies");
    assert_eq!(s.turrets.len(), TURRET_N, "TURRET_N turrets drop in");
    assert!(s.turret_until > t + 0.1, "the window opens");
    for tu in &s.turrets {
        assert_eq!(tu.team, 0, "they hold the taker's side");
        assert_eq!(tu.hp, TURRET_HP, "and start at TURRET_HP");
    }
    // a second take stacks, never replaces
    assert!(s.take_totem(i0, "turret", t + 0.1));
    assert_eq!(s.turrets.len(), 2 * TURRET_N, "the second take appends");
    // the snapshot carries them under "tr"
    let snap = s.snap(t + 0.2);
    assert_eq!(snap["tr"].as_array().unwrap().len(), 2 * TURRET_N, "snap key tr");
    // now let the turrets work: only the NEAR enemy should lose hp, and never the team-mate
    let hp_u2 = s.player("u2").unwrap().hp;
    let hp_u3 = s.player("u3").unwrap().hp;
    let mut t2 = t + 0.2;
    for _ in 0..(HZ as usize) {
        t2 += 1.0 / HZ;
        s.tick(t2, true);
    }
    let p2 = s.player("u2").unwrap();
    let p3 = s.player("u3").unwrap();
    assert_eq!(p2.hp, hp_u2, "a turret never shoots a team-mate");
    assert_eq!(p3.hp, hp_u3, "nor anyone beyond TURRET_RANGE");
    assert!(s.player("u1").unwrap().hp < HP, "the near enemy is taking fire");
}

#[test]
fn mini_turret_is_destructible_by_gunfire() {
    // A turret has TURRET_HP of life; a bullet (waveg_hit) bruises it and a big
    // enough hit puts it out. Twin: wavegHit / fire() in games/strike.js.
    let (mut s, t) = started(2, 1, 0.0);
    put(&mut s, "u0", 0.0, 0.0, 0.0, t, None);
    put(&mut s, "u1", 0.0, 0.0, -4.0, t, None);
    let i0 = s.players.iter().position(|(u, _)| u == "u0").unwrap();
    assert!(s.take_totem(i0, "turret", t + 0.1));
    assert_eq!(s.turrets.len(), TURRET_N);
    let hp0 = s.turrets[0].hp;
    s.waveg_hit(0, 0, 10, "u0", t + 0.2);
    assert_eq!(s.turrets[0].hp, hp0 - 10, "a hit takes hp off the turret");
    s.waveg_hit(0, 0, TURRET_HP, "u0", t + 0.2);
    assert_eq!(s.turrets[0].hp, 0, "enough damage puts it out");
}

#[test]
fn explosive_barrels_fall_from_the_sky_and_go_up_10x_a_launcher() {
    // BARREL_N barrels crash down from BARREL_FALL and land. The blast is the
    // launcher's own curve scaled 10x: 1200 direct, 750 -> 250 out to BARREL_R.
    let (mut s, t) = started(2, 1, 0.0);
    put(&mut s, "u0", 0.0, 0.0, 0.0, t, None);
    put(&mut s, "u1", 0.0, 0.0, -4.0, t, None);
    let i0 = s.players.iter().position(|(u, _)| u == "u0").unwrap();
    assert!(s.take_totem(i0, "barrel", t + 0.1), "the totem applies");
    assert_eq!(s.barrels.len(), BARREL_N, "BARREL_N barrels land");
    for b in &s.barrels {
        assert!((b.y - BARREL_FALL).abs() < 1e-9, "they start in the sky");
        assert!(!b.landed, "and are still falling");
    }
    // the 10x lock: the barrel curve is exactly ten times the launcher's own,
    // stretched out to BARREL_R (the launcher only reaches BLAST_R).
    assert_eq!(BARREL_DIRECT, 1200);
    assert_eq!(blast_damage(0.0, true) * 10, BARREL_DIRECT, "direct is 10x a launcher");
    assert_eq!(BARREL_DMG, 750);
    assert_eq!(BARREL_MIN, 250);
    for (dist, want) in [(0.0f64, 1200i64), (0.4, 1200), (3.0, 625), (6.0, 500), (11.0, 292)] {
        let got = if dist < DIRECT_R {
            BARREL_DIRECT
        } else if dist < BARREL_R {
            (BARREL_DMG as f64 - (BARREL_DMG - BARREL_MIN) as f64 * (dist / BARREL_R)).round() as i64
        } else {
            0
        };
        assert_eq!(got, want, "the falloff at {} m", dist);
    }
    assert_eq!(blast_damage(0.0, true), 120);
    assert_eq!(blast_damage(0.0, false), 75);
    assert_eq!(blast_damage(2.0, false), 50);
    assert_eq!(blast_damage(3.9, false), 26);
    assert_eq!(blast_damage(BLAST_R, false), 0);
    // they fall and land
    let mut t2 = t + 0.1;
    for _ in 0..(3 * HZ as usize) {
        t2 += 1.0 / HZ;
        s.tick(t2, true);
    }
    for b in &s.barrels {
        assert!(b.landed, "the barrels land");
        assert!((b.y).abs() < 1e-6, "and sit on the deck");
    }
}

#[test]
fn shooting_a_barrel_detonates_it_and_chains_the_next() {
    // One bullet (waveg_hit) on a barrel fires barrel_blast; a barrel inside
    // BARREL_R goes off too, with the same kill credit. Twin: barrelBlast().
    let (mut s, t) = started(2, 1, 0.0);
    put(&mut s, "u0", 20.0, 0.0, 20.0, t, None);   // the shooter stands clear (floor)
    // the victim stands ON the deck under barrel 0 — the blast centre is that deck
    // (ground_y) + 0.5, so an absolute y=0 would put them 3.5 m underground.
    let deck = ground_y(s.map(), 0.0, 0.0);
    put(&mut s, "u1", 0.6, deck, 0.0, t, None);     // victim in DIRECT_R of barrel 0
    let i0 = s.players.iter().position(|(u, _)| u == "u0").unwrap();
    assert!(s.take_totem(i0, "barrel", t + 0.1));
    // park two barrels side by side on the deck and clear the third away
    for b in s.barrels.iter_mut() {
        b.y = 0.0;
        b.landed = true;
    }
    s.barrels[0].x = 0.0;
    s.barrels[0].z = 0.0;
    s.barrels[1].x = 1.0;
    s.barrels[1].z = 0.0;
    s.barrels[2].x = 40.0;
    s.barrels[2].z = 40.0;
    let hp1 = s.player("u1").unwrap().hp;
    s.waveg_hit(1, 0, BARREL_HP, "u0", t + 0.2);
    // the victim stood inside DIRECT_R of barrel 0's blast → BARREL_DIRECT
    assert_eq!(s.player("u1").unwrap().hp, (hp1 - BARREL_DIRECT).max(0),
               "the direct hit is BARREL_DIRECT");
    assert_eq!(s.barrels[0].hp, 0, "the shot barrel is gone");
    assert_eq!(s.barrels[1].hp, 0, "and it chained the one beside it");
    assert_eq!(s.barrels[2].hp, BARREL_HP, "the far barrel is untouched");
}

#[test]
fn the_laser_grid_kills_on_touch_but_a_jump_saves_you() {
    // A tripwire is a thick segment (LASER_HALF) at LASER_Y. Walk into it and you
    // die; height ABOVE THE DECK >= LASER_CLEAR is a clean jump and you live.
    // The gate is ground-relative: the dockyard's origin is a raised platform
    // (top 3.5), so an absolute world y would let a walker straight through.
    let (mut s, t) = started(2, 1, 0.0);
    put(&mut s, "u0", 0.0, 0.0, 20.0, t, None);
    put(&mut s, "u1", 0.0, 0.0, -20.0, t, None);
    let i0 = s.players.iter().position(|(u, _)| u == "u0").unwrap();
    assert!(s.take_totem(i0, "laser", t + 0.1), "the totem applies");
    assert_eq!(s.lasers.len(), LASER_N, "LASER_N tripwires criss-cross");
    assert!(s.laser_until > t + 0.1, "the window opens");
    // plant one wire straight through the origin and stand a body on it
    s.lasers.clear();
    s.lasers.push(Laser { id: 1, ax: -10.0, az: 0.0, bx: 10.0, bz: 0.0, until: t + 10.0 });
    let deck = ground_y(s.map(), 0.0, 0.0);
    // 1. standing on the wire at deck height → instant death
    put(&mut s, "u1", 0.0, deck + 0.2, 0.0, t + 0.2, None);
    let mut t2 = t + 0.2;
    s.tick(t2 + 1.0 / HZ, true);
    assert!(s.player("u1").unwrap().dead, "walking into the beam kills you");
    // 2. jumping clean over it (height above the deck >= LASER_CLEAR) → you live
    put(&mut s, "u1", 0.0, deck + LASER_CLEAR + 0.4, 0.0, t + 1.0, None);
    s.player_mut("u1").unwrap().dead = false;
    s.player_mut("u1").unwrap().hp = HP;
    s.player_mut("u1").unwrap().respawn_at = 0.0;
    t2 = t + 1.0;
    s.tick(t2 + 1.0 / HZ, true);
    assert!(!s.player("u1").unwrap().dead, "jumping over the beam saves you");
    // 3. standing BESIDE it (clear of LASER_HALF) → you live
    put(&mut s, "u1", 0.0, deck, LASER_HALF + 0.5, t + 2.0, None);
    s.player_mut("u1").unwrap().dead = false;
    s.player_mut("u1").unwrap().hp = HP;
    s.player_mut("u1").unwrap().respawn_at = 0.0;
    t2 = t + 2.0;
    s.tick(t2 + 1.0 / HZ, true);
    assert!(!s.player("u1").unwrap().dead, "walking beside the beam saves you");
    let snap = s.snap(t + 2.1);
    assert_eq!(snap["lg"].as_array().unwrap().len(), 1, "snap key lg");
}

#[test]
fn the_laser_gate_is_height_above_the_deck_not_world_y() {
    // THE walk-through bug: the beams are planted ON the deck under you
    // (ground_y), but the old gate read an absolute world y. On the dockyard's
    // raised centre (top 3.5) a walking player stands at y≈3.5, which passes
    // "y >= LASER_CLEAR" and walks straight through every beam.
    let (mut s, t) = started(2, 1, 0.0);
    put(&mut s, "u0", 0.0, 0.0, 20.0, t, None);
    put(&mut s, "u1", 0.0, 0.0, -20.0, t, None);
    s.lasers.clear();
    s.lasers.push(Laser { id: 1, ax: -10.0, az: 0.0, bx: 10.0, bz: 0.0, until: t + 10.0 });
    let deck = ground_y(s.map(), 0.0, 0.0);
    assert!(deck >= 3.0, "the origin is the raised centre (deck {})", deck);
    assert!(deck >= LASER_CLEAR, "and its top is above LASER_CLEAR — the old gate would treat a walker as jumped");
    // 1. a WALKER on the raised deck (world y = deck+0.2) is still cut down
    put(&mut s, "u1", 0.0, deck + 0.2, 0.0, t + 0.2, None);
    s.tick(t + 0.2 + 1.0 / HZ, true);
    assert!(s.player("u1").unwrap().dead, "a walker on the raised deck is zapped");
    // 2. only a jump that clears LASER_CLEAR ABOVE that deck saves you
    s.player_mut("u1").unwrap().dead = false;
    s.player_mut("u1").unwrap().hp = HP;
    s.player_mut("u1").unwrap().respawn_at = 0.0;
    put(&mut s, "u1", 0.0, deck + LASER_CLEAR + 0.1, 0.0, t + 1.0, None);
    s.tick(t + 1.0 + 1.0 / HZ, true);
    assert!(!s.player("u1").unwrap().dead, "a real jump off the raised deck saves you");
    // 3. on the flat deck the old numbers still work
    let flat = ground_y(s.map(), 0.0, 20.0);
    assert!(flat < 0.5, "z=20 is the floor ({}), not the platform", flat);
    s.lasers.push(Laser { id: 2, ax: -10.0, az: 20.0, bx: 10.0, bz: 20.0, until: t + 10.0 });
    s.player_mut("u1").unwrap().dead = false;
    s.player_mut("u1").unwrap().hp = HP;
    s.player_mut("u1").unwrap().respawn_at = 0.0;
    put(&mut s, "u1", 0.0, flat + 0.2, 20.0, t + 2.0, None);
    s.tick(t + 2.0 + 1.0 / HZ, true);
    assert!(s.player("u1").unwrap().dead, "on the floor a walker is still zapped");
    s.player_mut("u1").unwrap().dead = false;
    s.player_mut("u1").unwrap().hp = HP;
    s.player_mut("u1").unwrap().respawn_at = 0.0;
    put(&mut s, "u1", 0.0, flat + LASER_CLEAR + 0.1, 20.0, t + 3.0, None);
    s.tick(t + 3.0 + 1.0 / HZ, true);
    assert!(!s.player("u1").unwrap().dead, "and on the floor a jump still saves you");
    // the same gate class: a jump pad planted on the raised deck still fires
    // for a body standing on it (the pad gate is height-above-deck too).
    s.lasers.clear();
    s.pads.clear();
    s.pads.push(JumpPad { id: 1, x: 0.0, z: 0.0, until: t + 10.0 });
    s.player_mut("u1").unwrap().dead = false;
    s.player_mut("u1").unwrap().hp = HP;
    s.player_mut("u1").unwrap().respawn_at = 0.0;
    put(&mut s, "u1", 0.0, deck + 0.1, 0.0, t + 4.0, None);
    s.player_mut("u1").unwrap().pad_cool = 0.0;
    s.tick(t + 4.0 + 1.0 / HZ, true);
    let p1 = s.player("u1").unwrap();
    assert!(p1.pad_cool > t + 4.0, "the pad on the raised deck fires for a walker on it");
}

#[test]
fn a_jump_pad_throws_you_into_the_sky_then_waits() {
    // PAD_N pads scatter on the ground. Step on one (y near the deck, inside PAD_R)
    // and your body gets PAD_LAUNCH; PAD_COOL is both the re-launch lock and the
    // air let-up that lets the judge buy the flight.
    let (mut s, t) = started(2, 1, 0.0);
    put(&mut s, "u0", 0.0, 0.0, 0.0, t, None);
    put(&mut s, "u1", 0.0, 0.0, -4.0, t, None);
    let i0 = s.players.iter().position(|(u, _)| u == "u0").unwrap();
    assert!(s.take_totem(i0, "jumppad", t + 0.1), "the totem applies");
    assert_eq!(s.pads.len(), PAD_N, "PAD_N pads drop in");
    assert!(s.pad_until > t + 0.1, "the window opens");
    // plant one pad under u1
    s.pads.clear();
    s.pads.push(JumpPad { id: 1, x: 0.0, z: -4.0, until: t + 10.0 });
    let bot = s.players.iter().find(|(_, p)| p.is_bot()).map(|(u, _)| u.clone());
    if let Some(bid) = bot {
        put(&mut s, &bid, 0.0, 0.0, -4.0, t + 0.2, None);
        s.player_mut(&bid).unwrap().y = 0.0;
        s.tick(t + 0.2 + 1.0 / HZ, true);
        let p = s.player(&bid).unwrap();
        assert!(p.pad_cool > t + 0.2, "the cool-down opens");
        let b = p.bot.as_ref().unwrap();
        assert!((b.body.vy - PAD_LAUNCH).abs() < 1e-9, "the body gets PAD_LAUNCH");
    }
    // a second step inside PAD_COOL does not re-launch
    if let Some(bid) = s.players.iter().find(|(_, p)| p.is_bot()).map(|(u, _)| u.clone()) {
        let cool = s.player(&bid).unwrap().pad_cool;
        s.tick(t + 0.3, true);
        let p = s.player(&bid).unwrap();
        assert!(p.pad_cool <= cool + 1e-9, "the cool-down holds the pad down");
    }
    // airborne bodies (y > 0.35) are ignored
    if let Some(bid) = s.players.iter().find(|(_, p)| p.is_bot()).map(|(u, _)| u.clone()) {
        let p = s.player_mut(&bid).unwrap();
        p.pad_cool = 0.0;
        p.y = 2.0;
        if let Some(b) = p.bot.as_mut() {
            b.body.y = 2.0;
            b.body.vy = 0.0;
        }
        s.tick(t + 0.4, true);
        let p = s.player(&bid).unwrap();
        assert_eq!(p.pad_cool, 0.0, "a body in the air does not trigger the pad");
    }
    let snap = s.snap(t + 0.5);
    assert_eq!(snap["pd"].as_array().unwrap().len(), 1, "snap key pd");
}

#[test]
fn the_death_lottery_picks_one_living_enemy_and_never_a_team_mate() {
    // Instant: one living ENEMY is chosen by world_k (never Math.random) and
    // either heals to LOTTERY_HEAL or drops dead. The taker and their side are
    // never in the pool.
    let (mut s, t) = started(4, 2, 0.0);
    put(&mut s, "u0", 0.0, 0.0, 0.0, t, None);
    put(&mut s, "u2", 2.0, 0.0, 0.0, t, None);   // team-mate of u0 (team 0)
    put(&mut s, "u1", -2.0, 0.0, 0.0, t, None);  // enemy (team 1)
    put(&mut s, "u3", -6.0, 0.0, 0.0, t, None);  // enemy (team 1)
    let i0 = s.players.iter().position(|(u, _)| u == "u0").unwrap();
    let mut healed = 0;
    let mut killed = 0;
    for n in 0..16 {
        // put everyone back on their feet so the pool stays the same shape
        for uid in ["u1", "u3"] {
            let p = s.player_mut(uid).unwrap();
            p.dead = false;
            p.hp = HP;
            p.respawn_at = 0.0;
        }
        let hp_before: Vec<i64> = ["u0", "u1", "u2", "u3"].iter()
            .map(|u| s.player(u).unwrap().hp).collect();
        assert!(s.take_totem(i0, "lottery", t + 0.1 + n as f64 * 0.01),
                "the totem applies on take {}", n);
        // never the taker, never a team-mate
        assert_eq!(s.player("u0").unwrap().hp, hp_before[0], "the taker is never picked");
        assert_eq!(s.player("u2").unwrap().hp, hp_before[2], "a team-mate is never picked");
        let p1 = s.player("u1").unwrap();
        let p3 = s.player("u3").unwrap();
        let one_healed = p1.hp == LOTTERY_HEAL || p3.hp == LOTTERY_HEAL;
        let one_dead = p1.dead || p3.dead;
        assert!(one_healed || one_dead, "the ticket is always honoured");
        if one_healed {
            healed += 1;
        }
        if one_dead {
            killed += 1;
        }
    }
    assert!(healed > 0, "the lottery does heal ({} heals)", healed);
    assert!(killed > 0, "and it does kill ({} kills)", killed);
}
