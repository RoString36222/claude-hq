use std::collections::{BTreeMap, BTreeSet};
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
// re-pinned 2026-10 for road classes highway/ring, sidewalks, city carve, 45-degree turn limit (3D City spec)
const CLAUDE_HQ_1: &str = "0c165b2f78e5de77";

/// The seeds every invariant is checked on (besides claude-hq): the generator must not need luck.
/// s26 and s283 route a ring piece by the fallback (and s283 snaps); s86's highway passes a
/// corner street node.
const SEEDS: [&str; 18] = [
    "a", "b", "c", "zzz", "123", "daily:2026-10-19", "daily:2026-10-20",
    "claude-hq-2", "x", "y", "test-1", "seed-42", "hq", "daily:2026-10-21", "arena:city",
    "s26", "s283", "s86",
];

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
    assert!(parse_id("claude-hq@1").is_ok() && parse_id("claude-hq@2").is_ok());
    for bad in ["claude-hq", "@1", "claude-hq@4", "claude-hq@x", "has space@1", "a/b@1", &format!("{}@1", "x".repeat(65))] {
        assert!(parse_id(bad).is_err(), "{bad} should be refused");
    }
}

/// The client fixture (tools/world_fixture.py) must be of the pinned world. Read at
/// run time, not include_str!: the Docker build context has no tests/.
#[test]
fn fixture_matches_pin() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../tests/fixtures/claude-hq@1.samples.json");
    let Ok(text) = std::fs::read_to_string(path) else {
        eprintln!("fixture_matches_pin: skipped, {path} is not here");
        return;
    };
    let v: serde_json::Value = serde_json::from_str(&text).expect("the samples fixture is JSON");
    assert_eq!(v["world"].as_str(), Some(CLAUDE_HQ_1), "tests/fixtures is stale: run python3 tools/world_fixture.py");
}

#[test]
fn every_seed_tried_generates_a_valid_world() {
    // the invariants below, on a spread of seeds: the generator must not need luck
    for seed in SEEDS {
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
        let max = if roads::is_graded(e.class) { p.country_grade_pm } else { p.city_grade_pm };
        for q in e.points.windows(2) {
            let run = noise::isqrt((q[1][0] - q[0][0]).pow(2) + (q[1][2] - q[0][2]).pow(2)).max(1);
            let grade = (q[1][1] - q[0][1]).abs() * 1000 / run;
            assert!(grade <= max, "{}: {} ({}) is {grade} per mille steep", w.id, e.name, e.class);
        }
        assert!(!e.name.is_empty());
    }

    // lots sit inside their block, clear of every city road, with the door on a road
    let city_roads: Vec<_> = l.roads.edges.iter().filter(|e| !roads::is_graded(e.class)).collect();
    let strip = |e: &roads::Edge| {
        let (a, b) = (e.points[0], e.points[e.points.len() - 1]);
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

    // graded roads keep their full width off the blocks (and so off every lot in them)
    // and off the city's street surfaces, along every segment, not only at their
    // points; a highway may flare over the streets that meet at its own city node, on
    // steps leaving within roads::FLARE cells of it
    let mut keep: Vec<(String, (i64, i64, i64, i64), Vec<(i64, i64)>)> =
        l.blocks.iter().map(|b| (format!("block {}", b.id), (b.x - b.w / 2, b.x + b.w / 2, b.z - b.d / 2, b.z + b.d / 2), vec![])).collect();
    for e in &city_roads {
        let (a, b, h) = (e.points[0], e.points[e.points.len() - 1], e.width / 2);
        let r = (a[0].min(b[0]) - h, a[0].max(b[0]) + h, a[2].min(b[2]) - h, a[2].max(b[2]) + h);
        keep.push((format!("{} (edge {})", e.name, e.id), r, vec![(a[0], a[2]), (b[0], b[2])]));
    }
    for e in l.roads.edges.iter().filter(|e| roads::is_graded(e.class)) {
        let own = [e.points[0], e.points[e.points.len() - 1]].map(|q| (q[0], q[2]));
        for s in e.points.windows(2) {
            let (a, b) = ((s[0][0], s[0][2]), (s[1][0], s[1][2]));
            let near = |n: (i64, i64), q: (i64, i64)| (q.0 - n.0).abs().max((q.1 - n.1).abs()) <= roads::FLARE * p.cell_cm;
            for (what, r, ends) in &keep {
                let far = |u: i64, v: i64, lo: i64, hi: i64| u.min(v) - e.width > hi || u.max(v) + e.width < lo;
                let flare = own.iter().any(|&n| ends.contains(&n) && (near(n, a) || near(n, b)));
                if far(a.0, b.0, r.0, r.1) || far(a.1, b.1, r.2, r.3) || flare {
                    continue;
                }
                let d = segment_rect_distance(a, b, *r);
                assert!(d >= e.width as f64 / 2.0, "{}: {} (edge {}) passes {d:.0} cm from {what} at {a:?}-{b:?}", w.id, e.name, e.id);
            }
        }
    }

    check_roads(w);

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

/// Distance (cm) from segment ab to the rectangle (x0, x1, z0, z1): 0 when they meet.
/// Floating point on purpose: an independent check of the generator's integer one.
fn segment_rect_distance(a: (i64, i64), b: (i64, i64), r: (i64, i64, i64, i64)) -> f64 {
    let (x0, x1, z0, z1) = (r.0 as f64, r.1 as f64, r.2 as f64, r.3 as f64);
    let (ax, az, bx, bz) = (a.0 as f64, a.1 as f64, b.0 as f64, b.1 as f64);
    // the distance is convex along the segment: ternary search, then the ends
    let at = |t: f64| {
        let (x, z) = (ax + (bx - ax) * t, az + (bz - az) * t);
        let (dx, dz) = ((x0 - x).max(0.0).max(x - x1), (z0 - z).max(0.0).max(z - z1));
        (dx * dx + dz * dz).sqrt()
    };
    let (mut lo, mut hi) = (0.0f64, 1.0f64);
    for _ in 0..100 {
        let (m1, m2) = (lo + (hi - lo) / 3.0, hi - (hi - lo) / 3.0);
        if at(m1) <= at(m2) {
            hi = m2;
        } else {
            lo = m1;
        }
    }
    at(lo).min(at(0.0)).min(at(1.0))
}

/// Road classes, widths, refs, junctions and point spacing.
fn check_roads(w: &WorldDoc) {
    let p = city();
    let r = &w.layers.roads;
    let id = &w.id;
    let pos = |q: &[i64; 3]| (q[0], q[2]);

    for e in &r.edges {
        // both ends are the nodes', heights included
        let (na, nb) = (&r.nodes[e.a as usize], &r.nodes[e.b as usize]);
        let (first, last) = (e.points[0], e.points[e.points.len() - 1]);
        assert!(e.points.len() >= 2 && e.a != e.b, "{id}: edge {} is degenerate", e.id);
        assert_eq!(first, [na.x, na.y, na.z], "{id}: edge {} does not start on node {}", e.id, e.a);
        assert_eq!(last, [nb.x, nb.y, nb.z], "{id}: edge {} does not end on node {}", e.id, e.b);
        assert!(e.walk * 2 < e.width && e.lanes == 1, "{id}: edge {} lanes/sidewalks", e.id);
        let (width, walk) = match e.class {
            "street" => (p.road_cm, p.street_walk_cm),
            "avenue" => (p.avenue_cm, p.avenue_walk_cm),
            "highway" => (p.highway_cm, 0),
            "ring" => (p.ring_cm, 0),
            c => panic!("{id}: edge {} has class {c}", e.id),
        };
        assert_eq!((e.width, e.walk), (width, walk), "{id}: edge {} ({})", e.id, e.class);
        match e.class {
            "highway" => assert!(e.route.as_deref().is_some_and(|k| (1..=p.gates).any(|g| k == format!("H{g}"))), "{id}: highway {} ref", e.id),
            "ring" => assert_eq!(e.route.as_deref(), Some("R1")),
            _ => assert_eq!(e.route, None),
        }
        // city edges: straight, in equal steps of at most 8 m
        if !roads::is_graded(e.class) {
            let steps: Vec<i64> = e.points.windows(2).map(|q| noise::isqrt((q[1][0] - q[0][0]).pow(2) + (q[1][2] - q[0][2]).pow(2))).collect();
            for s in &steps {
                assert!((1..=roads::STEP_CM).contains(s), "{id}: edge {} steps {s} cm", e.id);
            }
            assert!(steps.iter().max().unwrap() - steps.iter().min().unwrap() <= 1, "{id}: edge {} steps are uneven: {steps:?}", e.id);
            assert!(first[0] == last[0] || first[2] == last[2], "{id}: edge {} is not axis-aligned", e.id);
        }
    }
    let count = |c: &str| r.edges.iter().filter(|e| e.class == c).count() as i64;
    assert!(count("highway") >= 2 * p.gates && count("ring") >= p.gates, "{id}: {} highway, {} ring edges", count("highway"), count("ring"));

    // roads meet only at nodes: no point inside one edge is a point of another
    let mut on: BTreeMap<(i64, i64), BTreeSet<u32>> = BTreeMap::new();
    for e in &r.edges {
        for q in &e.points {
            on.entry(pos(q)).or_default().insert(e.id);
        }
    }
    for e in &r.edges {
        for q in &e.points[1..e.points.len() - 1] {
            assert_eq!(on[&pos(q)].len(), 1, "{id}: ({}, {}) is inside edge {} and on edges {:?}", q[0], q[2], e.id, on[&pos(q)]);
        }
    }

    // graded roads cross each other, and the city's roads, only at a node they share
    let graded: Vec<&roads::Edge> = r.edges.iter().filter(|e| roads::is_graded(e.class)).collect();
    let city: Vec<&roads::Edge> = r.edges.iter().filter(|e| !roads::is_graded(e.class)).collect();
    let bbox = |e: &roads::Edge| e.points.iter().fold((i64::MAX, i64::MIN, i64::MAX, i64::MIN), |b, q| (b.0.min(q[0]), b.1.max(q[0]), b.2.min(q[2]), b.3.max(q[2])));
    for (k, e) in graded.iter().enumerate() {
        let be = bbox(e);
        for f in graded[k + 1..].iter().chain(city.iter()) {
            let bf = bbox(f);
            if be.1 < bf.0 || bf.1 < be.0 || be.3 < bf.2 || bf.3 < be.2 {
                continue;
            }
            let shared: Vec<(i64, i64)> = [e.a, e.b].iter().filter(|n| **n == f.a || **n == f.b).map(|&n| (r.nodes[n as usize].x, r.nodes[n as usize].z)).collect();
            for s in e.points.windows(2) {
                for t in f.points.windows(2) {
                    let (a, b, c, d) = (pos(&s[0]), pos(&s[1]), pos(&t[0]), pos(&t[1]));
                    if !roads::segments_touch(a, b, c, d) {
                        continue;
                    }
                    let at = [a, b].into_iter().find(|v| (*v == c || *v == d) && shared.contains(v));
                    let ok = at.is_some_and(|v| {
                        // touching at a shared end, and not running along each other from it
                        let (u, w) = (if a == v { b } else { a }, if c == v { d } else { c });
                        let (ux, uz, wx, wz) = ((u.0 - v.0) as i128, (u.1 - v.1) as i128, (w.0 - v.0) as i128, (w.1 - v.1) as i128);
                        ux * wz - uz * wx != 0 || ux * wx + uz * wz < 0
                    });
                    assert!(ok, "{id}: {} (edge {}) and {} (edge {}) cross at {a:?}-{b:?} / {c:?}-{d:?}", e.name, e.id, f.name, f.id);
                }
            }
        }
    }

    // graded roads bend gently: inside an edge (its exact ends aside) no step turns more
    // than 45 degrees from the last, so no hairpin is tighter than the road is wide
    for e in &graded {
        let q: Vec<(i64, i64)> = e.points.iter().map(pos).collect();
        for k in 3..q.len().saturating_sub(1) {
            let (u, v) = ((q[k - 1].0 - q[k - 2].0, q[k - 1].1 - q[k - 2].1), (q[k].0 - q[k - 1].0, q[k].1 - q[k - 1].1));
            let (dot, l2) = ((u.0 * v.0 + u.1 * v.1) as f64, ((u.0 * u.0 + u.1 * u.1) as f64 * (v.0 * v.0 + v.1 * v.1) as f64).sqrt());
            assert!(dot >= l2 * 0.7, "{id}: {} (edge {}) turns sharply at ({}, {})", e.name, e.id, q[k - 1].0, q[k - 1].1);
        }
    }

    // a graded road never comes back within its own width: two stretches of one route
    // more than its width apart along it are at least its width apart on the ground
    let seg_d = |a: (i64, i64), b: (i64, i64), c: (i64, i64), d: (i64, i64)| {
        if roads::segments_touch(a, b, c, d) {
            return 0.0;
        }
        let pd = |q: (i64, i64), u: (i64, i64), v: (i64, i64)| {
            let (dx, dz, qx, qz) = ((v.0 - u.0) as f64, (v.1 - u.1) as f64, (q.0 - u.0) as f64, (q.1 - u.1) as f64);
            let f = ((qx * dx + qz * dz) / (dx * dx + dz * dz).max(1.0)).clamp(0.0, 1.0);
            ((qx - f * dx).powi(2) + (qz - f * dz).powi(2)).sqrt()
        };
        pd(a, c, d).min(pd(b, c, d)).min(pd(c, a, b)).min(pd(d, a, b))
    };
    // each graded edge's segments with the distance along it to their start
    let segs = |e: &roads::Edge| {
        let mut at = 0.0;
        e.points
            .windows(2)
            .map(|q| {
                let s = (pos(&q[0]), pos(&q[1]), at);
                at += (((q[1][0] - q[0][0]).pow(2) + (q[1][2] - q[0][2]).pow(2)) as f64).sqrt();
                s
            })
            .collect::<Vec<_>>()
    };
    for (k, e) in graded.iter().enumerate() {
        let (se, w) = (segs(e), e.width as f64);
        let le = se.last().map_or(0.0, |s| s.2 + ((s.1 .0 - s.0 .0).pow(2) as f64 + (s.1 .1 - s.0 .1).pow(2) as f64).sqrt());
        for f in graded[k..].iter().filter(|f| f.name == e.name) {
            let sf = if f.id == e.id { se.clone() } else { segs(f) };
            let lf = sf.last().map_or(0.0, |s| s.2 + ((s.1 .0 - s.0 .0).pow(2) as f64 + (s.1 .1 - s.0 .1).pow(2) as f64).sqrt());
            for (i, s) in se.iter().enumerate() {
                for t in &sf {
                    // apart along the road: same edge by arc, else through a shared node
                    let gap = if f.id == e.id {
                        if t.2 <= s.2 {
                            continue;
                        }
                        t.2 - (s.2 + ((s.1 .0 - s.0 .0).pow(2) as f64 + (s.1 .1 - s.0 .1).pow(2) as f64).sqrt())
                    } else {
                        let (ea, eb) = (s.2 + 0.0, le - s.2 - ((s.1 .0 - s.0 .0).pow(2) as f64 + (s.1 .1 - s.0 .1).pow(2) as f64).sqrt());
                        let (fa, fb) = (t.2, lf - t.2 - ((t.1 .0 - t.0 .0).pow(2) as f64 + (t.1 .1 - t.0 .1).pow(2) as f64).sqrt());
                        let mut g = f64::INFINITY;
                        for (ne, de) in [(e.a, ea), (e.b, eb)] {
                            for (nf, df) in [(f.a, fa), (f.b, fb)] {
                                if ne == nf {
                                    g = g.min(de + df);
                                }
                            }
                        }
                        g
                    };
                    if gap <= 2.0 * w {
                        continue;
                    }
                    let d = seg_d(s.0, s.1, t.0, t.1);
                    assert!(d >= w, "{id}: {} comes back within {d:.0} cm of itself (edges {} seg {i} / {}, {gap:.0} cm apart along it) at {:?}", e.name, e.id, f.id, s.0);
                }
            }
        }
    }

    // graded junctions are real: a node only graded roads meet is a gate (degree 1) or
    // a junction (3+), never a bare split; and two junctions are at least 2 cells apart
    let mut degree = vec![(0usize, false); r.nodes.len()];
    for e in &r.edges {
        for n in [e.a, e.b] {
            degree[n as usize].0 += 1;
            degree[n as usize].1 |= !roads::is_graded(e.class);
        }
    }
    for (n, &(d, city)) in degree.iter().enumerate() {
        assert!(city || d != 2, "{id}: graded node {n} only splits a road");
    }
    for e in &graded {
        let len: i64 = e.points.windows(2).map(|q| noise::isqrt((q[1][0] - q[0][0]).pow(2) + (q[1][2] - q[0][2]).pow(2))).sum();
        let junction = |n: u32| degree[n as usize].0 >= 3 && !degree[n as usize].1;
        assert!(len >= 2 * p.cell_cm || !(junction(e.a) && junction(e.b)), "{id}: {} (edge {}) is {len} cm between two junctions", e.name, e.id);
    }

    // gate numbers go round the compass: H1..H<gates> by atan2(x, z) ascending from -PI
    let half = p.size_cm / 2;
    let mut gates: Vec<(f64, String)> = r
        .edges
        .iter()
        .filter(|e| e.class == "highway")
        .flat_map(|e| [e.a, e.b].map(|n| (&r.nodes[n as usize], e.route.clone().unwrap())))
        .filter(|(n, _)| n.x.abs() >= half - 2 * p.cell_cm || n.z.abs() >= half - 2 * p.cell_cm)
        .map(|(n, k)| ((n.x as f64).atan2(n.z as f64), k))
        .collect();
    gates.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
    gates.dedup();
    let refs: Vec<String> = gates.into_iter().map(|g| g.1).collect();
    assert_eq!(refs, (1..=p.gates).map(|g| format!("H{g}")).collect::<Vec<_>>(), "{id}: gates out of compass order");

    // the highways' names are not any grid street's
    let stem = |n: &str| n.rsplit_once(' ').map(|x| x.0.to_string()).unwrap_or_default();
    let city: BTreeSet<String> = r.edges.iter().filter(|e| !roads::is_graded(e.class)).map(|e| stem(&e.name)).collect();
    let ways: BTreeSet<String> = r.edges.iter().filter(|e| e.class == "highway").map(|e| e.name.clone()).collect();
    assert_eq!(ways.len() as i64, p.gates, "{id}: highways share a name");
    for n in &ways {
        assert!(!city.contains(&stem(n)), "{id}: {n} repeats a street's name");
    }
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

