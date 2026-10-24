//! water.rs: the @3 bodies of water, piers, network and routes, checked on the fixture
//! worlds and a spread of other seeds (the generator must not need luck).

use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::sync::OnceLock;

use super::super::organic::geom::{area2, inside, seg_dist2, simple, P};
use super::super::{generate, WorldDoc};

/// The fixture worlds and others: two Commons-profile seeds, five personal islands.
const IDS: [&str; 8] = [
    "claude-hq@3",
    "user:0b8e4c1a-3f2d-4e5b-9a6c-7d8e9f0a1b2c@3",
    "user:11111111-2222-4333-8444-555555555555@3",
    "user:9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a@3",
    "user:00000000-0000-4000-8000-000000000001@3",
    "user:abcdefab-cdef-4abc-9def-abcdefabcdef@3",
    "test-1@3",
    "a@3",
];

fn worlds() -> &'static Vec<WorldDoc> {
    static W: OnceLock<Vec<WorldDoc>> = OnceLock::new();
    W.get_or_init(|| {
        std::thread::scope(|s| {
            let hs: Vec<_> = IDS.iter().map(|id| s.spawn(move || generate(id, &[]).unwrap_or_else(|e| panic!("{id}: {e}")))).collect();
            hs.into_iter().map(|h| h.join().unwrap()).collect()
        })
    })
}

fn pts(v: &[[i64; 2]]) -> Vec<P> {
    v.iter().map(|q| (q[0], q[1])).collect()
}

struct View<'a> {
    w: &'a WorldDoc,
    coast: Vec<P>,
    river: Vec<P>,
    bodies: Vec<(String, Vec<P>, Vec<Vec<P>>)>,
}

impl<'a> View<'a> {
    fn new(w: &'a WorldDoc) -> View<'a> {
        let water = w.layers.water.as_ref().expect("@3 has water");
        View {
            w,
            coast: pts(&w.layers.island.as_ref().unwrap().coast),
            river: pts(&w.layers.river.as_ref().unwrap().poly),
            bodies: water.bodies.iter().map(|b| (b.id.clone(), pts(&b.poly), b.islands.iter().map(|i| pts(i)).collect())).collect(),
        }
    }

    fn in_body(&self, id: &str, q: P) -> bool {
        if id == "river" {
            return inside(q, &self.river);
        }
        self.bodies.iter().any(|(b, poly, isl)| b == id && inside(q, poly) && !isl.iter().any(|i| inside(q, i)))
    }

    /// On any water: a body (off its islands), the river, or the sea.
    fn wet(&self, q: P) -> bool {
        !inside(q, &self.coast) || inside(q, &self.river) || self.bodies.iter().any(|(_, poly, isl)| inside(q, poly) && !isl.iter().any(|i| inside(q, i)))
    }
}

#[test]
fn every_world_has_its_water() {
    for w in worlds() {
        let water = w.layers.water.as_ref().unwrap();
        let count = |k: &str| water.bodies.iter().filter(|b| b.kind == k).count();
        assert!((1..=2).contains(&count("lake")), "{}: {} lakes", w.id, count("lake"));
        assert!((1..=3).contains(&count("canal")), "{}: {} canals", w.id, count("canal"));
        assert_eq!(count("marina"), 1, "{}: no marina", w.id);
        let mut ids = BTreeSet::new();
        for b in &water.bodies {
            assert!(ids.insert(&b.id), "{}: {} twice", w.id, b.id);
            let poly = pts(&b.poly);
            assert!(area2(&poly) > 0 && simple(&poly), "{}: {} is no ccw simple outline", w.id, b.id);
            assert_eq!(b.tier, 1);
            match b.kind {
                "lake" => assert!(b.joins.is_none() && b.edge == "bank" && (200..=300).contains(&b.bed)),
                "canal" => assert!(b.joins.as_deref() == Some("river") && b.edge == "quay"),
                _ => assert!(b.joins.as_deref() == Some("sea") && b.edge == "quay"),
            }
        }
        // the park lake (the first) is 1-3 ha, give or take its outline's wobble
        let lake = water.bodies.iter().find(|b| b.id == "lake:0").unwrap();
        let ha = area2(&pts(&lake.poly)) / 2 / 100_000_000;
        assert!((0..=3).contains(&ha), "{}: the park lake is {ha} ha", w.id);
        let m2 = area2(&pts(&lake.poly)) / 2 / 10_000;
        assert!((8_000..=34_000).contains(&m2), "{}: the park lake is {m2} m2", w.id);
        // the Commons-profile worlds (highways) have an upland lake too
        assert_eq!(count("lake") == 2, w.profile == "commons", "{}", w.id);
    }
}

#[test]
fn lakes_stand_apart_and_the_marina_opens_to_the_sea() {
    for w in worlds() {
        let v = View::new(w);
        for (id, poly, _) in &v.bodies {
            let kind = id.split(':').next().unwrap();
            let at_sea = poly.iter().filter(|&&q| !inside(q, &v.coast)).count();
            match kind {
                "lake" => {
                    assert_eq!(at_sea, 0, "{}: {id} reaches the sea", w.id);
                    assert!(!poly.iter().any(|&q| inside(q, &v.river)) && !v.river.iter().any(|&q| inside(q, poly)), "{}: {id} meets the river", w.id);
                    for (other, op, _) in &v.bodies {
                        if other != id {
                            assert!(!poly.iter().any(|&q| inside(q, op)), "{}: {id} meets {other}", w.id);
                        }
                    }
                }
                "marina" => assert!(at_sea > 0, "{}: the marina does not reach the sea", w.id),
                _ => {
                    // a canal opens off the river: its mouth inside it, the rest on land
                    assert!(inside(poly[0], &v.river) || inside(poly[poly.len() - 1], &v.river), "{}: {id} does not join the river", w.id);
                    assert_eq!(at_sea, 0, "{}: {id} reaches the sea", w.id);
                }
            }
        }
    }
}

#[test]
fn the_water_is_carved_into_the_ground() {
    for w in worlds() {
        let t = &w.layers.terrain;
        let water = w.layers.water.as_ref().unwrap();
        for b in &water.bodies {
            let poly = pts(&b.poly);
            let isl: Vec<Vec<P>> = b.islands.iter().map(|i| pts(i)).collect();
            let mut n = 0;
            for iz in 0..t.n {
                for ix in 0..t.n {
                    let q = t.vertex_pos(ix, iz);
                    if !inside(q, &poly) || isl.iter().any(|i| inside(q, i)) {
                        continue;
                    }
                    n += 1;
                    let h = t.heights[iz * t.n + ix] as i64;
                    assert!(h < b.level, "{}: {} ground {h} at {q:?} is not under its water ({})", w.id, b.id, b.level);
                }
            }
            assert!(n > 0, "{}: {} covers no terrain vertex", w.id, b.id);
            if b.kind == "lake" {
                assert!(b.level > w.layers.island.as_ref().unwrap().sea_cm, "{}: {} is below the sea", w.id, b.id);
            }
        }
    }
}

#[test]
fn piers_reach_from_land_out_over_their_water() {
    for w in worlds() {
        let v = View::new(w);
        let water = w.layers.water.as_ref().unwrap();
        let bus = water.piers.iter().filter(|p| p.kind == "waterbus").count();
        assert!((3..=6).contains(&bus), "{}: {bus} water-bus piers", w.id);
        for kind in ["launch", "hire", "fuel"] {
            assert!(water.piers.iter().any(|p| p.kind == kind), "{}: no {kind} pier", w.id);
        }
        for (k, p) in water.piers.iter().enumerate() {
            assert_eq!(p.id, format!("pier:{k}"));
            let f = (p.front[0], p.front[1]);
            let l = isqrt(f.0 * f.0 + f.1 * f.1);
            assert!((l - 65_536).abs() <= 2, "{}: {} front is no unit", w.id, p.id);
            let root = (p.x - f.0 * p.len / 2 / 65_536, p.z - f.1 * p.len / 2 / 65_536);
            let head = (p.x + f.0 * p.len / 2 / 65_536, p.z + f.1 * p.len / 2 / 65_536);
            assert!(!v.wet(root) && inside(root, &v.coast), "{}: {} root {root:?} is not on land", w.id, p.id);
            assert!(v.in_body(&p.body, head), "{}: {} head {head:?} is not on {}", w.id, p.id, p.body);
            // nothing built on a pier
            for l in &w.layers.lots {
                let lp = pts(l.poly.as_ref().unwrap());
                let n = lp.len();
                assert!((0..n).all(|k| seg_dist2(root, head, lp[k], lp[(k + 1) % n]) > 0) && !inside(root, &lp), "{}: {} runs into lot {}", w.id, p.id, l.id);
            }
        }
        for b in &water.berths {
            assert!(v.in_body(&b.body, (b.x, b.z)), "{}: a berth at ({}, {}) is not on {}", w.id, b.x, b.z, b.body);
        }
        if let (Some(bw), Some(lh)) = (&water.breakwater, &water.lighthouse) {
            assert_eq!(bw.last(), Some(lh));
            assert!(bw.iter().all(|q| !inside((q[0], q[1]), &v.coast)), "{}: the breakwater is on land", w.id);
        } else {
            panic!("{}: the marina has no breakwater", w.id);
        }
        let office = water.office.as_ref().expect("a harbour office");
        let s = w.layers.sites.iter().find(|s| &s.id == office).expect("the office is a site");
        assert!(pts(s.poly.as_ref().unwrap()).iter().all(|&q| !v.wet(q)), "{}: the office stands in the water", w.id);
    }
}

#[test]
fn the_network_stays_on_the_water_and_the_routes_on_the_network() {
    for w in worlds() {
        let v = View::new(w);
        let water = w.layers.water.as_ref().unwrap();
        let net = &water.net;
        let node = |k: u32| (net.nodes[k as usize][0], net.nodes[k as usize][1]);
        let mut adj: BTreeMap<u32, BTreeSet<u32>> = BTreeMap::new();
        for e in &net.edges {
            let (a, b) = (node(e[0]), node(e[1]));
            for s in 0..=16 {
                let q = (a.0 + (b.0 - a.0) * s / 16, a.1 + (b.1 - a.1) * s / 16);
                assert!(v.wet(q), "{}: net edge {e:?} leaves the water at {q:?}", w.id);
            }
            adj.entry(e[0]).or_default().insert(e[1]);
            adj.entry(e[1]).or_default().insert(e[0]);
        }
        // the lake's network never reaches the sea; the marina's does, and the river's
        let reach = |from: u32| {
            let mut seen = BTreeSet::from([from]);
            let mut q = VecDeque::from([from]);
            while let Some(u) = q.pop_front() {
                for &x in adj.get(&u).into_iter().flatten() {
                    if seen.insert(x) {
                        q.push_back(x);
                    }
                }
            }
            seen
        };
        let at_sea = |k: &u32| !inside(node(*k), &v.coast);
        let lake = water.bodies.iter().find(|b| b.id == "lake:0").unwrap();
        let lp = pts(&lake.poly);
        let in_lake = (0..net.nodes.len() as u32).find(|&k| inside(node(k), &lp)).expect("the lake has its loop");
        assert!(!reach(in_lake).iter().any(at_sea), "{}: the lake is joined to the sea", w.id);
        let marina = water.bodies.iter().find(|b| b.kind == "marina").unwrap();
        let mp = pts(&marina.poly);
        let in_marina = (0..net.nodes.len() as u32).find(|&k| inside(node(k), &mp)).unwrap();
        let sea = reach(in_marina);
        assert!(sea.iter().any(at_sea), "{}: the marina does not reach the sea", w.id);
        for b in water.bodies.iter().filter(|b| b.kind == "canal") {
            let cp = pts(&b.poly);
            let k = (0..net.nodes.len() as u32).find(|&k| inside(node(k), &cp) && !inside(node(k), &v.river)).unwrap();
            assert!(sea.contains(&k), "{}: {} is cut off from the marina", w.id, b.id);
        }

        // routes: every pier on its path, every hop an edge
        let ids: BTreeSet<&str> = water.routes.iter().map(|r| r.id.as_str()).collect();
        assert!(ids.contains("W1") && ids.contains("L1"), "{}: routes {ids:?}", w.id);
        for r in &water.routes {
            assert!(r.path.windows(2).all(|h| adj.get(&h[0]).is_some_and(|s| s.contains(&h[1]))), "{}: {} hops off the net", w.id, r.id);
            for pid in &r.piers {
                let p = water.piers.iter().find(|p| &p.id == pid).unwrap();
                assert_eq!(p.kind, r.kind, "{}: {} calls at a {} pier", w.id, r.id, p.kind);
                let head = (p.x + p.front[0] * p.len / 2 / 65_536, p.z + p.front[1] * p.len / 2 / 65_536);
                // the pier's head is a node of the route (to the centimetre or so: the doc
                // gives the pier's middle, the net its head)
                assert!(r.path.iter().any(|&k| seg_dist2(node(k), node(k), head, head) <= 100 * 100), "{}: {} does not call at {pid}", w.id, r.id);
            }
            assert_eq!(r.looped, r.kind == "launch");
            assert_eq!(r.tier, if r.kind == "launch" { 1 } else { 2 });
        }
        // every water-bus pier is served
        for p in water.piers.iter().filter(|p| p.kind == "waterbus") {
            assert!(water.routes.iter().any(|r| r.piers.contains(&p.id)), "{}: {} has no water bus", w.id, p.id);
        }
    }
}

#[test]
fn nothing_is_built_on_any_body() {
    for w in worlds() {
        let v = View::new(w);
        let meets = |poly: &[P]| {
            let n = poly.len();
            v.bodies.iter().any(|(_, b, _)| {
                let m = b.len();
                poly.iter().any(|&q| inside(q, b)) || b.iter().any(|&q| inside(q, poly)) || (0..n).any(|i| (0..m).any(|j| seg_dist2(poly[i], poly[(i + 1) % n], b[j], b[(j + 1) % m]) == 0))
            })
        };
        for l in &w.layers.lots {
            assert!(!meets(&pts(l.poly.as_ref().unwrap())), "{}: lot {} is on the water", w.id, l.id);
        }
        for s in w.layers.sites.iter().filter(|s| !matches!(s.kind, "dock" | "port" | "airport")) {
            if let Some(p) = &s.poly {
                assert!(!meets(&pts(p)), "{}: site {} is on the water", w.id, s.id);
            }
        }
        for b in &w.layers.blocks {
            let poly = pts(b.poly.as_ref().unwrap());
            assert!(!v.bodies.iter().any(|(_, bp, _)| inside(super::super::organic::geom::centroid(bp), &poly)), "{}: block {} covers a body", w.id, b.id);
        }
        for e in w.layers.roads.edges.iter().filter(|e| e.bridge.is_none()) {
            for q in &e.points {
                assert!(!v.bodies.iter().any(|(_, b, _)| inside((q[0], q[2]), b)), "{}: road {} ({}) is on the water at {q:?}", w.id, e.id, e.name);
            }
        }
    }
}

#[test]
fn an_island_generates_in_time() {
    let t0 = std::time::Instant::now();
    generate("user:11111111-2222-4333-8444-555555555555@3", &[]).unwrap();
    let ms = t0.elapsed().as_millis();
    // ~2 s in a release build; a debug build is far slower
    let limit = if cfg!(debug_assertions) { 60_000 } else { 2_000 };
    assert!(ms < limit, "{ms} ms");
}

fn isqrt(n: i64) -> i64 {
    super::super::noise::isqrt(n)
}
