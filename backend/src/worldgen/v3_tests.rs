//! Generator version 3 (HQ 3.15 transport revamp): the pins that keep @1 and @2 byte
//! for byte as they were, and the @3 world's invariants (water.rs has its own).

use std::sync::OnceLock;

use super::organic::geom::{inside, seg_dist2, P};
use super::*;

/// Recorded on 2026-10-23 BEFORE any @3 change (the release `worldgen` bin): each
/// world's fingerprint (`hashes.world`) and the FNV-1a 64 and length of its whole JSON
/// document. @1 and @2 worlds are live or stored against: these must never move.
const PINS: [(&str, &str, &str, usize); 4] = [
    ("claude-hq@1", "0c165b2f78e5de77", "c57be5e26e5e5a3e", 1_086_761),
    ("claude-hq@2", "b0d9fec9d1d46c1e", "48a4072e5d681357", 786_011),
    ("user:0b8e4c1a-3f2d-4e5b-9a6c-7d8e9f0a1b2c@2", "0469d14ee5f0b692", "feb5b13b09310546", 1_608_676),
    ("user:11111111-2222-4333-8444-555555555555@2", "0255a55afdb106d1", "3c5c9695adf799df", 1_512_977),
];

/// The Commons' @2 airport (the runway platform the airfield's keep-out capsule and
/// timetable are built round): x, z, w, d, front. @3 keeps it exactly.
const COMMONS_AIRPORT: (i64, i64, i64, i64, [i64; 2]) = (-62_000, 0, 4_000, 16_000, [65_536, 0]);

const COMMONS3: &str = "claude-hq@3";
const ISLAND3: &str = "user:0b8e4c1a-3f2d-4e5b-9a6c-7d8e9f0a1b2c@3";

pub(super) fn commons3() -> &'static WorldDoc {
    static W: OnceLock<WorldDoc> = OnceLock::new();
    W.get_or_init(|| generate(COMMONS3, &[]).unwrap())
}

pub(super) fn island3() -> &'static WorldDoc {
    static W: OnceLock<WorldDoc> = OnceLock::new();
    W.get_or_init(|| generate(ISLAND3, &[]).unwrap())
}

fn pts(v: &[[i64; 2]]) -> Vec<P> {
    v.iter().map(|q| (q[0], q[1])).collect()
}

#[test]
fn v1_and_v2_worlds_are_pinned_forever() {
    for (id, world, doc, len) in PINS {
        let w = generate(id, &[]).unwrap();
        assert_eq!(w.hashes.world, world, "{id}: fingerprint moved");
        let bytes = serde_json::to_vec(&w).unwrap();
        assert_eq!((format!("{:016x}", rng::fnv1a64(&bytes)), bytes.len()), (doc.to_string(), len), "{id}: document bytes moved");
        assert!(w.layers.water.is_none() && w.layers.metro.is_none() && w.layers.rail.is_none() && w.layers.gondola.is_none());
    }
}

#[test]
fn version_3_is_generated() {
    assert_eq!(VERSION, [1, 2, 3]);
    assert!(parse_id(COMMONS3).is_ok() && parse_id(ISLAND3).is_ok() && parse_id("claude-hq@4").is_err());
    assert_eq!(profile_for("claude-hq", 3).name, "commons");
    assert_eq!(profile_for("user:x", 3).name, "island");
    assert!(profile_for("claude-hq", 3).water && profile_for("user:x", 3).water);
    assert!(!profile_for("claude-hq", 2).water && !profile_for("user:x", 2).water && !profile_for("claude-hq", 1).water);
}

#[test]
fn v3_is_deterministic_and_seeded() {
    let again = generate(COMMONS3, &[]).unwrap();
    assert_eq!(serde_json::to_vec(&again).unwrap(), serde_json::to_vec(commons3()).unwrap());
    let other = generate("user:11111111-2222-4333-8444-555555555555@3", &[]).unwrap();
    assert_ne!(other.hashes.world, island3().hashes.world);
    assert_ne!(commons3().hashes.world, PINS[1].1, "@3 is a new world");
    for w in [commons3(), island3()] {
        let h = w.hashes.water.as_ref().expect("@3 hashes its water");
        assert_eq!(h, &format!("{:016x}", rng::fnv1a64(&serde_json::to_vec(w.layers.water.as_ref().unwrap()).unwrap())));
    }
}

#[test]
fn commons3_keeps_64_ranked_hq_lots_and_its_airport() {
    let w = commons3();
    let mut ranks: Vec<u32> = w.layers.lots.iter().filter(|l| l.kind == "hq").map(|l| l.rank.unwrap()).collect();
    ranks.sort();
    assert_eq!(ranks, (0..64).collect::<Vec<u32>>());
    let a = w.layers.sites.iter().find(|s| s.kind == "airport").expect("the Commons has its airport");
    let (x, z, wd, d, f) = COMMONS_AIRPORT;
    assert_eq!((a.x, a.z, a.w, a.d, a.front), (x, z, wd, d, Some(f)), "the airport moved");
}

#[test]
fn island3_keeps_its_hq() {
    let hq: Vec<_> = island3().layers.lots.iter().filter(|l| l.kind == "hq").collect();
    assert_eq!(hq.len(), 1);
    assert_eq!(hq[0].rank, Some(0));
}

/// Nothing built stands on the water: no lot, no site (bar those meant to reach over it),
/// no road bar a bridge.
#[test]
fn nothing_is_built_on_the_water() {
    for w in [commons3(), island3()] {
        let water = w.layers.water.as_ref().unwrap();
        let bodies: Vec<Vec<P>> = water.bodies.iter().map(|b| pts(&b.poly)).collect();
        let wet = |q: P| bodies.iter().any(|b| inside(q, b));
        let meets = |poly: &[P]| {
            let n = poly.len();
            poly.iter().any(|&q| wet(q))
                || bodies.iter().any(|b| {
                    let m = b.len();
                    b.iter().any(|&q| inside(q, poly)) || (0..n).any(|i| (0..m).any(|j| seg_dist2(poly[i], poly[(i + 1) % n], b[j], b[(j + 1) % m]) == 0))
                })
        };
        for l in &w.layers.lots {
            assert!(!meets(&pts(l.poly.as_ref().unwrap())), "{}: lot {} ({}) is on the water", w.id, l.id, l.kind);
        }
        for s in &w.layers.sites {
            if matches!(s.kind, "dock" | "port" | "airport") {
                continue; // reach out over the river or the sea, as at @2
            }
            if let Some(p) = &s.poly {
                assert!(!meets(&pts(p)), "{}: site {} is on the water", w.id, s.id);
            }
        }
        for e in w.layers.roads.edges.iter().filter(|e| e.bridge.is_none()) {
            for q in &e.points {
                assert!(!wet((q[0], q[2])), "{}: road {} ({}) runs on the water at {:?}", w.id, e.id, e.name, q);
            }
        }
    }
}

#[test]
fn v3_docs_stay_small_and_fast() {
    for w in [commons3(), island3()] {
        let n = serde_json::to_vec(w).unwrap().len();
        assert!(n < 1_900_000, "{}: {} bytes", w.id, n);
    }
}

/// City Gen v4 (phase 2): every town street is paved by a road class of the plan (the
/// validator holds each to its class's carriageway, lanes and median, a bend to one class
/// at a time); the Commons has every town class but the service road and the boulevard
/// (none of its main roads has 50 m blocks all along: a boulevard's junctions need them),
/// and few lanes left at the layout width.
#[test]
fn v3_streets_are_paved_by_v4_class() {
    use std::collections::BTreeMap;
    for w in [commons3(), island3()] {
        let mut by: BTreeMap<&str, usize> = BTreeMap::new();
        let (mut city, mut layout) = (0, 0);
        for e in w.layers.roads.edges.iter().filter(|e| matches!(e.class, "local" | "arterial")) {
            let c = e.v4.unwrap_or_else(|| panic!("{}: edge {} has no class", w.id, e.id));
            *by.entry(c).or_default() += 1;
            city += 1;
            layout += (c == "lane" && e.width < 900) as usize;
        }
        assert!(validate::hard(&w.layers).iter().all(|v| !v.rule.starts_with("class")), "{}", w.id);
        assert!(layout * 100 <= city * 4, "{}: {layout} of {city} streets at the layout width", w.id);
        if w.id == COMMONS3 {
            for c in ["shared", "lane", "local", "collector", "avenue"] {
                assert!(by.get(c).is_some_and(|&n| n > 0), "{}: no {c} in {by:?}", w.id);
            }
            assert!(by["avenue"] >= by["collector"] / 2, "{}: main roads {by:?}", w.id);
        }
    }
}
