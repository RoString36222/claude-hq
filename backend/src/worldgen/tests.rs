use std::sync::OnceLock;

use super::city::{rise, Facing};
use super::profile::{city, district};
use super::*;

/// Arena City, generated once for the whole test run.
fn world() -> &'static WorldDoc {
    static W: OnceLock<WorldDoc> = OnceLock::new();
    W.get_or_init(|| generate("claude-hq@1", &[]).unwrap())
}

/// The fingerprint of Arena City. Everyone's city (and every HQ's lot) is
/// stored against this world, so a change here MOVES THINGS FOR EVERYONE: only
/// update it on purpose, with a new generator VERSION if the world was live.
const CLAUDE_HQ_1: &str = "5b3be76a93184d80";

#[test]
fn arena_city_is_pinned() {
    assert_eq!(world().hashes.world, CLAUDE_HQ_1, "claude-hq@1 changed: see CLAUDE_HQ_1");
}

#[test]
fn the_same_id_is_the_same_world() {
    let again = generate("claude-hq@1", &[]).unwrap();
    assert_eq!(again.hashes, world().hashes);
}

#[test]
fn other_seeds_are_other_worlds() {
    let mut seen = std::collections::BTreeSet::new();
    for seed in ["claude-hq", "a", "b", "test-1", "daily:2026-10-19"] {
        let w = generate(&format!("{seed}@1"), &[]).unwrap();
        assert!(seen.insert(w.hashes.world.clone()), "{seed} repeats another world");
    }
}

#[test]
fn world_ids_are_checked() {
    assert!(parse_id("claude-hq@1").is_ok());
    for bad in ["claude-hq", "@1", "claude-hq@2", "claude-hq@x", "has space@1", "a/b@1", &format!("{}@1", "x".repeat(65))] {
        assert!(parse_id(bad).is_err(), "{bad} should be refused");
    }
}

#[test]
fn every_seed_tried_generates_a_valid_world() {
    // the invariants below, on a spread of seeds: the generator must not need luck
    for seed in ["a", "b", "c", "zzz", "123", "daily:2026-10-19", "daily:2026-10-20"] {
        let w = generate(&format!("{seed}@1"), &[]).unwrap_or_else(|e| panic!("{seed}: {e}"));
        check_world(&w);
    }
}

#[test]
fn arena_city_holds_its_invariants() {
    check_world(world());
}

fn check_world(w: &WorldDoc) {
    let p = city();
    let l = &w.layers;
    let half = p.size_cm / 2;

    // everything is inside the world
    for n in &l.roads.nodes {
        assert!(n.x.abs() <= half && n.z.abs() <= half, "node {} outside the world", n.id);
    }

    // one road network: every node reachable from every other
    let mut parent: Vec<usize> = (0..l.roads.nodes.len()).collect();
    fn find(p: &mut [usize], x: usize) -> usize {
        let mut r = x;
        while p[r] != r {
            r = p[r];
        }
        let mut x = x;
        while p[x] != r {
            let next = p[x];
            p[x] = r;
            x = next;
        }
        r
    }
    for e in &l.roads.edges {
        let (a, b) = (find(&mut parent, e.a as usize), find(&mut parent, e.b as usize));
        parent[a] = b;
    }
    let root = find(&mut parent, 0);
    for k in 0..l.roads.nodes.len() {
        assert_eq!(find(&mut parent, k), root, "{}: road node {k} is cut off", w.id);
    }

    // no road is steeper than its class allows
    for e in &l.roads.edges {
        let max = if e.class == "country" { p.country_grade_pm } else { p.city_grade_pm };
        for q in e.points.windows(2) {
            let run = noise::isqrt((q[1][0] - q[0][0]).pow(2) + (q[1][2] - q[0][2]).pow(2)).max(1);
            let grade = (q[1][1] - q[0][1]).abs() * 1000 / run;
            assert!(grade <= max, "{}: {} ({}) is {grade} per mille steep", w.id, e.name, e.class);
        }
        assert!(!e.name.is_empty());
    }

    // lots sit inside their block, clear of every city road, with the door on a road
    let city_roads: Vec<_> = l.roads.edges.iter().filter(|e| e.class != "country").collect();
    let strip = |e: &roads::Edge| {
        let (a, b) = (e.points[0], e.points[1]);
        (a[0].min(b[0]) - e.width / 2, a[0].max(b[0]) + e.width / 2, a[2].min(b[2]) - e.width / 2, a[2].max(b[2]) + e.width / 2)
    };
    let overlaps = |r: (i64, i64, i64, i64), x: i64, z: i64, w: i64, d: i64| {
        x - w / 2 < r.1 && x + w / 2 > r.0 && z - d / 2 < r.3 && z + d / 2 > r.2
    };
    for lot in &l.lots {
        let b = &l.blocks[lot.block as usize];
        assert!((lot.x - b.x).abs() + lot.w / 2 <= b.w / 2 && (lot.z - b.z).abs() + lot.d / 2 <= b.d / 2, "lot {} leaves its block", lot.id);
        for e in &city_roads {
            assert!(!overlaps(strip(e), lot.x, lot.z, lot.w, lot.d), "lot {} is on {}", lot.id, e.name);
        }
        let on_road = city_roads.iter().any(|e| {
            let r = strip(e);
            lot.door[0] >= r.0 && lot.door[0] <= r.1 && lot.door[2] >= r.2 - 50 && lot.door[2] <= r.3 + 50
        });
        assert!(on_road, "lot {}'s door is not on a road", lot.id);
        let side = if lot.facing == Facing::North { lot.z + lot.d / 2 } else { lot.z - lot.d / 2 };
        assert_eq!(lot.door[2], side, "lot {}'s door is not on its front", lot.id);
    }

    // country roads keep out of the blocks
    for e in l.roads.edges.iter().filter(|e| e.class == "country") {
        for q in &e.points {
            for b in &l.blocks {
                assert!(!((q[0] - b.x).abs() < b.w / 2 && (q[2] - b.z).abs() < b.d / 2), "{} runs through block {}", e.name, b.id);
            }
        }
    }

    // the HQ pool: the profile's count, ranked by distance from the plaza, tiered
    let hq: Vec<_> = l.lots.iter().filter(|x| x.kind == "hq").collect();
    assert_eq!(hq.len() as i64, p.hq_lots);
    let mut last = -1i64;
    for (k, lot) in hq.iter().enumerate() {
        assert_eq!(lot.rank, Some(k as u32));
        assert_eq!(lot.tier, Some(k as u32 / p.hq_tier as u32));
        let d = lot.x * lot.x + lot.z * lot.z;
        assert!(d >= last, "HQ lot {k} is nearer the plaza than lot {}", k - 1);
        last = d;
        assert!(rise(&l.terrain, lot.x, lot.z, lot.w, lot.d) <= p.site_flat_cm * 2, "HQ lot {k} is on a slope");
    }

    // every site the profile reserves is placed: in its block, on flat ground, not on another
    for s in &p.sites {
        assert_eq!(l.sites.iter().filter(|x| x.kind == s.kind).count() as i64, s.count, "{} placed", s.kind);
    }
    for (k, s) in l.sites.iter().enumerate() {
        let b = &l.blocks[s.block as usize];
        assert!((s.x - b.x).abs() + s.w / 2 <= b.w / 2 && (s.z - b.z).abs() + s.d / 2 <= b.d / 2, "{} leaves its block", s.id);
        assert!(rise(&l.terrain, s.x, s.z, s.w, s.d) <= p.site_flat_cm, "{} is on a slope", s.id);
        for o in &l.sites[k + 1..] {
            let apart = (s.x - o.x).abs() * 2 >= s.w + o.w || (s.z - o.z).abs() * 2 >= s.d + o.d;
            assert!(apart || s.kind == "spawn" || o.kind == "spawn", "{} overlaps {}", s.id, o.id);
        }
    }
    assert_eq!(l.blocks[0].district, district::PLAZA);
    assert_eq!(l.districts.at(l.blocks[0].x, l.blocks[0].z), district::PLAZA);
    assert!(l.districts.at(half - 100, half - 100) <= district::FOREST, "the world's corner is countryside");
}

// --- terrain edits -----------------------------------------------------------

fn door_lot() -> &'static city::Lot {
    world().layers.lots.iter().find(|l| l.kind == "hq").unwrap()
}

#[test]
fn edits_move_the_ground_not_the_layout() {
    let lot = door_lot();
    let edits = [Edit::Raise { x: lot.door[0], z: lot.door[2], r: 6_000, cm: 300 }];
    let w = generate("claude-hq@1", &edits).unwrap();
    // layout untouched: same blocks, same lots (bar the door's height), same sites and road routes
    assert_eq!(w.hashes.blocks, world().hashes.blocks);
    assert_eq!(w.hashes.districts, world().hashes.districts);
    let xz = |w: &WorldDoc| -> Vec<(i64, i64)> { w.layers.roads.edges.iter().flat_map(|e| e.points.iter().map(|q| (q[0], q[2]))).collect() };
    assert_eq!(xz(&w), xz(world()));
    let moved = &w.layers.lots[lot.id as usize];
    assert_eq!((moved.x, moved.z, moved.door[0], moved.door[2]), (lot.x, lot.z, lot.door[0], lot.door[2]));
    // the ground under it rose, and the door with it
    // full strength at the brush's centre, a touch less a few cm off it (the door is between grid vertices)
    assert!((lot.door[1] + 280..=lot.door[1] + 300).contains(&moved.door[1]), "door rose {}", moved.door[1] - lot.door[1]);
    assert_ne!(w.hashes.terrain, world().hashes.terrain);
    assert_ne!(w.hashes.world, world().hashes.world);
}

#[test]
fn the_same_edits_give_the_same_world() {
    let edits = vec![
        Edit::Raise { x: 30_000, z: -20_000, r: 8_000, cm: -400 },
        Edit::Smooth { x: 30_000, z: -20_000, r: 8_000, passes: 2 },
        Edit::Flatten { x: -60_000, z: 60_000, r: 5_000, y: 1_000 },
    ];
    assert_eq!(generate("claude-hq@1", &edits).unwrap().hashes, generate("claude-hq@1", &edits).unwrap().hashes);
}

#[test]
fn flatten_levels_the_ground() {
    let (x, z) = (-70_400, 70_400); // a grid vertex: the brush is exact there
    let w = generate("claude-hq@1", &[Edit::Flatten { x, z, r: 6_000, y: 1_234 }]).unwrap();
    assert_eq!(w.layers.terrain.height_at(x, z), 1_234);
    assert!(rise(&w.layers.terrain, x, z, 1_600, 1_600) < rise(&world().layers.terrain, x, z, 1_600, 1_600).max(1));
}

#[test]
fn bad_edits_are_refused() {
    let half = city().size_cm / 2;
    for e in [
        Edit::Raise { x: 0, z: 0, r: 0, cm: 100 },
        Edit::Raise { x: 0, z: 0, r: terrain::MAX_RADIUS_CM + 1, cm: 100 },
        Edit::Raise { x: half + 1, z: 0, r: 100, cm: 100 },
        Edit::Raise { x: 0, z: 0, r: 100, cm: 20_001 },
        Edit::Smooth { x: 0, z: 0, r: 100, passes: 0 },
        Edit::Flatten { x: 0, z: 0, r: 100, y: 100_001 },
    ] {
        assert!(generate("claude-hq@1", std::slice::from_ref(&e)).is_err(), "{e:?} should be refused");
    }
    let many = vec![Edit::Raise { x: 0, z: 0, r: 100, cm: 1 }; terrain::MAX_EDITS + 1];
    assert!(generate("claude-hq@1", &many).is_err());
}

#[test]
fn edits_round_trip_as_json() {
    let e: Vec<Edit> = serde_json::from_str(r#"[{"op":"raise","x":1,"z":2,"r":300,"cm":-50},{"op":"smooth","x":0,"z":0,"r":800,"passes":3}]"#).unwrap();
    assert_eq!(e[0], Edit::Raise { x: 1, z: 2, r: 300, cm: -50 });
    assert!(serde_json::from_str::<Vec<Edit>>(r#"[{"op":"dig","x":0,"z":0,"r":1}]"#).is_err());
}
