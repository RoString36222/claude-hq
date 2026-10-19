//! Islands (@2): the coast round both organic worlds, the sea outside it, and a
//! personal city that grows into its island by tier without moving anything.

use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::sync::OnceLock;

use super::super::organic::geom::{area2, len, simple, P};
use super::super::profile::district;
use super::super::*;
use super::{radius_by_tier, road_at, Coast, RADII_CM, REACH_CM};

const ISLAND: &str = "user:0b6f2a3c-1d4e-4f5a-9b8c-7d6e5f4a3b2c@2";
/// The personal islands every property is checked on besides ISLAND: growth must not need luck.
const USERS: [&str; 6] = [
    "user:00000000-0000-4000-8000-000000000000@2",
    "user:9f1c2d3e-4b5a-4c6d-8e7f-a1b2c3d4e5f6@2",
    "user:5e6f7a8b-9c0d-4e1f-a2b3-c4d5e6f7a8b9@2",
    "user:deadbeef-0000-4abc-9def-123456789abc@2",
    "user:1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d@2",
    "user:f0e1d2c3-b4a5-4968-8776-655443322110@2",
];

/// Arena City's fingerprint (worldgen/tests.rs CLAUDE_HQ_1): islands must not move it.
const CLAUDE_HQ_1: &str = "0c165b2f78e5de77";

fn commons() -> &'static WorldDoc {
    static W: OnceLock<WorldDoc> = OnceLock::new();
    W.get_or_init(|| generate("claude-hq@2", &[]).unwrap())
}

/// ISLAND and USERS, generated once for the whole run.
fn islands() -> &'static [WorldDoc] {
    static W: OnceLock<Vec<WorldDoc>> = OnceLock::new();
    W.get_or_init(|| std::iter::once(ISLAND).chain(USERS).map(|id| generate(id, &[]).unwrap_or_else(|e| panic!("{id}: {e}"))).collect())
}

fn worlds() -> Vec<&'static WorldDoc> {
    std::iter::once(commons()).chain(islands()).collect()
}

fn coast_of(w: &WorldDoc) -> Coast {
    let (seed, v) = parse_id(&w.id).unwrap();
    Coast::new(rng::fnv1a64(seed.as_bytes()), &profile_for(seed, v)).unwrap()
}

fn pts(v: &[[i64; 2]]) -> Vec<P> {
    v.iter().map(|q| (q[0], q[1])).collect()
}

/// Everything present at tier `t`, by a key, with all it says about where it stands.
fn at_tier(w: &WorldDoc, t: u8) -> BTreeMap<String, String> {
    let l = &w.layers;
    let mut out = BTreeMap::new();
    for e in l.roads.edges.iter().filter(|e| e.min_tier.unwrap() <= t) {
        out.insert(format!("edge {}", e.id), format!("{} {} {:?}", e.a, e.b, e.points.iter().map(|q| (q[0], q[2])).collect::<Vec<_>>()));
    }
    for b in l.blocks.iter().filter(|b| b.min_tier.unwrap() <= t) {
        out.insert(format!("block {}", b.id), format!("{} {:?}", b.district, b.poly));
    }
    for x in l.lots.iter().filter(|x| x.min_tier.unwrap() <= t) {
        out.insert(format!("lot {}", x.id), format!("{} {} {} {:?} {:?} {:?}", x.kind, x.x, x.z, x.door, x.poly, x.front));
    }
    for s in l.sites.iter().filter(|s| s.tier.unwrap() <= t) {
        out.insert(format!("site {}", s.id), format!("{} {} {:?} {:?}", s.x, s.z, s.poly, s.front));
    }
    out
}

/// The road nodes the plaza reaches at tier t by the roads present then.
fn reachable(w: &WorldDoc, t: u8) -> BTreeSet<u32> {
    let r = &w.layers.roads;
    let start = r.nodes.iter().min_by_key(|n| (n.x * n.x + n.z * n.z, n.id)).unwrap().id;
    let mut adj: BTreeMap<u32, Vec<u32>> = BTreeMap::new();
    for e in r.edges.iter().filter(|e| e.min_tier.unwrap() <= t) {
        adj.entry(e.a).or_default().push(e.b);
        adj.entry(e.b).or_default().push(e.a);
    }
    let mut seen = BTreeSet::from([start]);
    let mut queue = VecDeque::from([start]);
    while let Some(u) = queue.pop_front() {
        for &v in adj.get(&u).map_or(&[][..], |v| &v[..]) {
            if seen.insert(v) {
                queue.push_back(v);
            }
        }
    }
    seen
}

/// PROPERTY: what a personal city has at tier t it still has at tier t + 1, standing
/// exactly where it stood (growth never moves a lot), and tier 5 is the whole city.
/// At every tier the roads present are one network from the plaza, every lot and site
/// present has its road, and every lot its block.
#[test]
fn growth_only_adds() {
    for w in islands() {
        let id = &w.id;
        let views: Vec<BTreeMap<String, String>> = (1..=5).map(|t| at_tier(w, t)).collect();
        for t in 0..4 {
            for (k, v) in &views[t] {
                assert_eq!(views[t + 1].get(k), Some(v), "{id}: {k} at tier {} is not the same at tier {}", t + 1, t + 2);
            }
            assert!(views[t].len() < views[t + 1].len(), "{id}: nothing grows at tier {}", t + 2);
        }
        let l = &w.layers;
        assert_eq!(views[4].len(), l.roads.edges.len() + l.blocks.len() + l.lots.len() + l.sites.len(), "{id}: tier 5 is not the whole city");
        // the same view from the same id
        let again = generate(id, &[]).unwrap();
        assert_eq!(at_tier(&again, 3), views[2], "{id}: tier 3 differs between runs");

        for t in 1..=5u8 {
            let net = reachable(w, t);
            for e in l.roads.edges.iter().filter(|e| e.min_tier.unwrap() <= t) {
                assert!(net.contains(&e.a) || net.contains(&e.b), "{id}: edge {} is cut off at tier {t}", e.id);
            }
            let road = |q: P| road_at(&l.roads, q, REACH_CM).map(|e| l.roads.edges[e].min_tier.unwrap());
            for x in l.lots.iter().filter(|x| x.min_tier.unwrap() <= t) {
                assert!(road((x.door[0], x.door[2])).is_some_and(|rt| rt <= t), "{id}: lot {} has no road at tier {t}", x.id);
                assert!(l.blocks[x.block as usize].min_tier.unwrap() <= t, "{id}: lot {} has no block at tier {t}", x.id);
            }
            for s in l.sites.iter().filter(|s| s.tier.unwrap() <= t) {
                assert!(road(transit::door(s)).is_none_or(|rt| rt <= t), "{id}: {} has no road at tier {t}", s.id);
            }
        }
    }
}

/// The tier-1 city: a town hall, a clinic, a market, the owner's HQ lot (rank 0) and a
/// dock, with a road from the plaza to each. Its other lots are inside the first ring.
#[test]
fn the_tier_1_city() {
    for w in islands() {
        let id = &w.id;
        let l = &w.layers;
        let isl = l.island.as_ref().unwrap();
        let net = reachable(w, 1);
        // the road nearest it, however far: a dock stands past the streets' end
        let reached = |q: P| {
            let e = road_at(&l.roads, q, w.size_cm).unwrap();
            let e = &l.roads.edges[e];
            e.min_tier == Some(1) && (net.contains(&e.a) || net.contains(&e.b))
        };
        for kind in ["townhall", "clinic", "market", "dock"] {
            let s = l.sites.iter().find(|s| s.kind == kind && s.tier == Some(1)).unwrap_or_else(|| panic!("{id}: no {kind} at tier 1"));
            assert!(reached(transit::door(s)), "{id}: no tier-1 road to {}", s.id);
        }
        let hq = l.lots.iter().find(|x| x.kind == "hq" && x.rank == Some(0)).unwrap();
        assert_eq!(hq.min_tier, Some(1), "{id}: the owner's HQ lot");
        assert!(reached((hq.door[0], hq.door[2])), "{id}: no tier-1 road to the HQ");
        let dock = l.sites.iter().find(|s| s.kind == "dock" && s.tier == Some(1)).unwrap();
        assert!(isl.docks.contains(&dock.id), "{id}: {} is not in the docks", dock.id);
        let r1 = isl.radius_by_tier[0];
        for x in l.lots.iter().filter(|x| x.min_tier == Some(1) && x.kind != "hq") {
            assert!(len((x.x, x.z)) <= r1, "{id}: tier-1 lot {} is {} m out", x.id, len((x.x, x.z)) / 100);
        }
    }
}

/// Each tier's radius is a personal island's; the Commons scales them to its city and
/// is fully grown (no `min_tier`, the civic table's tiers).
#[test]
fn tiers_have_their_radii() {
    for w in islands() {
        assert_eq!(w.layers.island.as_ref().unwrap().radius_by_tier, RADII_CM);
    }
    let w = commons();
    let p = profile_for("claude-hq", 2);
    let radii = w.layers.island.as_ref().unwrap().radius_by_tier;
    assert_eq!((radii, radii[4]), (radius_by_tier(&p), p.city_r_cm));
    assert!(radii.windows(2).all(|r| r[0] < r[1]));
    let l = &w.layers;
    assert!(l.roads.edges.iter().all(|e| e.min_tier.is_none()) && l.blocks.iter().all(|b| b.min_tier.is_none()));
    assert!(l.lots.iter().all(|x| x.min_tier.is_none()));
}

/// The coast is a simple counter-clockwise polygon round the plaza, the one `Coast`
/// draws, between its radii and clear of the city (and the Commons' ring road); a
/// point is on land exactly when it is inside the polygon.
#[test]
fn the_coast_is_a_simple_polygon() {
    for w in worlds() {
        let id = &w.id;
        let isl = w.layers.island.as_ref().unwrap();
        let c = coast_of(w);
        let poly = pts(&isl.coast);
        assert_eq!(poly, c.poly, "{id}: the coast is not the one drawn");
        assert!(area2(&poly) > 0 && simple(&poly), "{id}: the coast is not simple and counter-clockwise");
        let (seed, v) = parse_id(id).unwrap();
        let p = profile_for(seed, v);
        assert!(c.lo >= p.city_r_cm.max(p.ring_r_cm) + 1_500 && c.hi < w.size_cm / 2, "{id}: coast radii {}..{}", c.lo, c.hi);
        for &q in &poly {
            assert!((c.lo..=c.hi).contains(&len(q)), "{id}: a coast vertex is {} m out", len(q) / 100);
        }
        let mut wobble = poly.iter().map(|&q| len(q));
        let (lo, hi) = wobble.clone().fold((i64::MAX, 0), |m, r| (m.0.min(r), m.1.max(r)));
        assert!(hi - lo > (c.hi - c.lo) / 4, "{id}: the coast is a circle ({lo}..{hi})");
        assert!(wobble.all(|r| r > 0));
        for iz in -40..=40i64 {
            for ix in -40..=40i64 {
                let q = (ix * w.size_cm / 80, iz * w.size_cm / 80);
                if (len(q) - c.radius_at(q)).abs() > 100 {
                    assert_eq!(c.land(q), super::super::organic::geom::inside(q, &poly), "{id}: {q:?}");
                }
            }
        }
    }
}

/// The base terrain: above the sea inside the coast, below it outside; the district
/// map's water is the sea (cells more than 16 m from the coast either way).
#[test]
fn the_sea_is_water() {
    for w in worlds() {
        let id = &w.id;
        let (seed, v) = parse_id(id).unwrap();
        let base = terrain::generate(rng::fnv1a64(seed.as_bytes()), &profile_for(seed, v));
        let c = coast_of(w);
        for iz in 0..base.n {
            for ix in 0..base.n {
                let q = base.vertex_pos(ix, iz);
                let h = base.heights[iz * base.n + ix] as i64;
                if c.land(q) {
                    assert!(h >= c.sea_cm + 100, "{id}: land at {q:?} is {h} cm");
                } else {
                    assert!(h <= c.sea_cm - 100, "{id}: the sea at {q:?} is {h} cm");
                }
            }
        }
        let d = &w.layers.districts;
        assert_eq!(d.legend[district::WATER as usize], "water");
        let (mut sea, mut land) = (0, 0);
        for iz in 0..d.n {
            for ix in 0..d.n {
                let q = (d.origin_cm + ix as i64 * d.cell_cm + d.cell_cm / 2, d.origin_cm + iz as i64 * d.cell_cm + d.cell_cm / 2);
                let off = len(q) - c.radius_at(q);
                let k = d.kinds[iz * d.n + ix];
                if off > 1_600 {
                    assert_eq!(k, district::WATER, "{id}: sea cell {q:?}");
                    sea += 1;
                } else if off < -1_600 {
                    assert_ne!(k, district::WATER, "{id}: land cell {q:?} is water");
                    land += 1;
                }
            }
        }
        assert!(sea > 0 && land > sea, "{id}: {sea} sea cells, {land} land");
    }
}

/// Every lot, every road and every site off the shore stands on the island.
#[test]
fn everything_is_on_land() {
    for w in worlds() {
        let id = &w.id;
        let c = coast_of(w);
        let l = &w.layers;
        for x in &l.lots {
            for q in pts(x.poly.as_ref().unwrap()) {
                assert!(c.land(q), "{id}: lot {} reaches into the sea", x.id);
            }
        }
        for e in &l.roads.edges {
            for q in &e.points {
                assert!(c.land((q[0], q[2])), "{id}: {} ({}) runs into the sea", e.name, e.class);
            }
        }
        for s in l.sites.iter().filter(|s| !matches!(s.kind, "dock" | "port")) {
            for q in pts(s.poly.as_ref().unwrap()) {
                assert!(c.land(q), "{id}: {} stands in the sea", s.id);
            }
        }
    }
}

/// Docks: a dock (tier 1) and the port (tier 3) on the shore, half in the water, on the
/// coast nearest the city; `island.docks` lists them.
#[test]
fn docks_are_on_the_shore() {
    for w in worlds() {
        let id = &w.id;
        let c = coast_of(w);
        let l = &w.layers;
        let isl = l.island.as_ref().unwrap();
        let want: Vec<&str> = l.sites.iter().filter(|s| matches!(s.kind, "dock" | "port")).map(|s| s.id.as_str()).collect();
        assert_eq!(isl.docks, want, "{id}: the docks");
        for (kind, tier) in [("dock", 1), ("port", 3)] {
            let s = l.sites.iter().find(|s| s.kind == kind).unwrap_or_else(|| panic!("{id}: no {kind}"));
            assert_eq!(s.tier, Some(tier), "{id}: {}", s.id);
            let poly = pts(s.poly.as_ref().unwrap());
            assert!(poly.iter().any(|&q| c.land(q)) && poly.iter().any(|&q| !c.land(q)), "{id}: {} is not on the shore", s.id);
        }
        // near the core: the dock's stretch of coast is no farther out than the coast's middle
        let dock = l.sites.iter().find(|s| s.kind == "dock").unwrap();
        assert!(c.radius_at((dock.x, dock.z)) <= (c.lo + c.hi) / 2 + 2_000, "{id}: the dock is on a far shore");
    }
}

/// On the Commons the highways end at the ring: no highway runs out to a dead end.
#[test]
fn the_highways_end_at_the_ring() {
    let r = &commons().layers.roads;
    let mut degree = vec![0; r.nodes.len()];
    for e in &r.edges {
        degree[e.a as usize] += 1;
        degree[e.b as usize] += 1;
    }
    assert!(r.edges.iter().any(|e| e.class == "highway") && r.edges.iter().any(|e| e.class == "ring"));
    for e in r.edges.iter().filter(|e| e.class == "highway") {
        assert!(degree[e.a as usize] > 1 && degree[e.b as usize] > 1, "{} ends nowhere", e.name);
    }
    for (k, n) in r.nodes.iter().enumerate() {
        assert_eq!(n.id as usize, k);
    }
    assert!(r.edges.iter().enumerate().all(|(k, e)| e.id as usize == k));
}

#[test]
fn the_same_id_is_the_same_island() {
    let a = generate(ISLAND, &[]).unwrap();
    assert_eq!(a.hashes, islands()[0].hashes);
    assert!(a.hashes.island.is_some());
    assert_eq!(serde_json::to_string(&a).unwrap(), serde_json::to_string(&islands()[0]).unwrap());
    let coasts: BTreeSet<String> = worlds().iter().map(|w| w.hashes.island.clone().unwrap()).collect();
    assert_eq!(coasts.len(), worlds().len(), "two worlds share an island");
}

/// Version 1 is untouched: no island, no tiers, the pinned fingerprint.
#[test]
fn version_1_is_untouched() {
    let w = generate("claude-hq@1", &[]).unwrap();
    assert_eq!(w.hashes.world, CLAUDE_HQ_1);
    assert!(w.layers.island.is_none() && w.hashes.island.is_none());
    let json = serde_json::to_string(&w).unwrap();
    for key in ["\"island\"", "\"min_tier\"", "\"coast\"", "\"docks\""] {
        assert!(!json.contains(key), "claude-hq@1 serialises {key}");
    }
    assert!(Coast::new(1, &profile::city()).is_none());
}
