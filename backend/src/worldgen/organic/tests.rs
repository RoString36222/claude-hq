//! The organic worlds (version 2): the Commons and a personal island.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::OnceLock;
use std::time::Instant;

use super::super::noise::{isqrt, ONE};
use super::super::profile::district;
use super::super::*;
use super::blocks::KERB_CM;
use super::geom::{area2, centroid, inside, nearest_on, rise, seg_dist2, simple, P};
use super::zoning::character;

/// The Commons, generated once for the whole test run.
fn commons() -> &'static WorldDoc {
    static W: OnceLock<WorldDoc> = OnceLock::new();
    W.get_or_init(|| generate("claude-hq@2", &[]).unwrap())
}

/// The fingerprint of the Commons. Everyone's tower (and every HQ's lot) is stored
/// against this world, so a change here MOVES THINGS FOR EVERYONE: only update it on
/// purpose, with a new generator version once the world is live.
// re-pinned 2026-10 for the island (island.rs): the coast and the sea, the highways ending at the ring, a dock and a port;
// again for the ring road kept inside the coast (roads::graded out_r);
// again (HQ 3.1) for the river (river.rs): its water and banks carved before the streets grow, the
// bridges, the dock on its bank by the plaza and the port on its basin, the sea 4 m down as an island's;
// the bank rising to a metre over the sea at the water's edge, the dock and the port at their backs' height,
// the HQ pool taking the lots that hold an HQ's box first;
// again (HQ 3.2) for the multi-storey vehicle garage (civic "carpark", placed last of the services);
// again (HQ 3.10) for wider roads (organic/widen.rs): the same lots, ranks and sites (wider_roads_move_no_lot),
// the streets paved wider into the blocks' and lots' road-side strip, highways and the ring wider
const CLAUDE_HQ_2: &str = "b0d9fec9d1d46c1e";

const ISLAND: &str = "user:0b6f2a3c-1d4e-4f5a-9b8c-7d6e5f4a3b2c@2";

/// Seeds every invariant is checked on besides claude-hq: the generator must not need luck.
const SEEDS: [&str; 8] = ["a", "b", "zzz", "123", "daily:2026-10-19", "seed-42", "arena:city", "s86"];
const ISLANDS: [&str; 4] = [
    "user:00000000-0000-4000-8000-000000000000",
    "user:9f1c2d3e-4b5a-4c6d-8e7f-a1b2c3d4e5f6",
    "user:5e6f7a8b-9c0d-4e1f-a2b3-c4d5e6f7a8b9",
    "user:deadbeef-0000-4abc-9def-123456789abc",
];

#[test]
fn the_commons_is_pinned() {
    assert_eq!(commons().hashes.world, CLAUDE_HQ_2, "claude-hq@2 changed: see CLAUDE_HQ_2");
}

#[test]
fn the_same_id_is_the_same_world() {
    assert_eq!(generate("claude-hq@2", &[]).unwrap().hashes, commons().hashes);
    assert_eq!(generate(ISLAND, &[]).unwrap().hashes, generate(ISLAND, &[]).unwrap().hashes);
}

#[test]
fn versions_and_profiles() {
    for id in ["claude-hq@1", "claude-hq@2", ISLAND, "user:abc@1"] {
        assert!(parse_id(id).is_ok(), "{id}");
    }
    for bad in ["claude-hq@0", "claude-hq@4", "claude-hq@"] {
        assert!(parse_id(bad).is_err(), "{bad}");
    }
    assert_eq!(profile_for("claude-hq", 1).name, "city");
    assert_eq!(profile_for("claude-hq", 2).name, "commons");
    assert_eq!(profile_for("user:x", 2).name, "island");
    assert_eq!(profile_for("user:x", 1).name, "city");
    assert_eq!(commons().profile, "commons");
    assert_ne!(commons().hashes.world, generate("claude-hq@1", &[]).unwrap().hashes.world);
}

/// @2 keeps @1's district names and adds its own after them.
#[test]
fn the_legend_extends_version_1s() {
    let legend = &commons().layers.districts.legend;
    assert_eq!(&legend[..district::NAMES.len()], &district::NAMES[..]);
    for (k, name) in [(district::OLDTOWN, "oldtown"), (district::DOWNTOWN, "downtown"), (district::SUBURB, "suburb"), (district::OFFICE, "office"),
                      (district::TECH, "tech"), (district::STUDIO, "studio"), (district::WATER, "water")] {
        assert_eq!(legend[k as usize], name);
    }
}

/// A loose bound that holds with every other test running alongside: the 300 ms
/// release budget is the ignored bench's, run on its own.
#[test]
fn the_commons_generates_in_time() {
    let t0 = Instant::now();
    generate("claude-hq@2", &[]).unwrap();
    let ms = t0.elapsed().as_millis();
    let limit = if cfg!(debug_assertions) { 15_000 } else { 1_500 };
    assert!(ms < limit, "claude-hq@2 took {ms} ms");
}

/// `cargo test --release --bin arena -- --ignored commons_bench`: under 300 ms in
/// release, best of 5.
#[test]
#[ignore]
fn commons_bench() {
    let ms = (0..5)
        .map(|_| {
            let t0 = Instant::now();
            generate("claude-hq@2", &[]).unwrap();
            t0.elapsed().as_millis()
        })
        .min()
        .unwrap();
    eprintln!("claude-hq@2: {ms} ms");
    assert!(cfg!(debug_assertions) || ms < 300, "claude-hq@2 took {ms} ms (budget 300)");
}

#[test]
fn the_commons_holds_its_invariants() {
    check(commons());
}

#[test]
fn other_seeds_hold_them_too() {
    let mut seen = BTreeSet::new();
    for seed in SEEDS {
        let w = generate(&format!("{seed}@2"), &[]).unwrap_or_else(|e| panic!("{seed}@2: {e}"));
        check(&w);
        assert!(seen.insert(w.hashes.world.clone()), "{seed}@2 repeats another world");
    }
}

#[test]
fn an_island_generates() {
    let w = generate(ISLAND, &[]).unwrap();
    assert_eq!((w.profile, w.size_cm), ("island", 180_000));
    check(&w);
    let p = profile::island();
    let coast = p.coast_r_cm.unwrap();
    let l = &w.layers;
    // no highways or ring: nowhere to drive to
    assert!(l.roads.edges.iter().all(|e| !roads::is_graded(e.class)));
    for n in &l.roads.nodes {
        assert!(isqrt(n.x * n.x + n.z * n.z) < coast, "node {} is in the sea", n.id);
    }
    assert_eq!(l.districts.at(0, coast + 2_000), district::WATER);
    for id in ISLANDS {
        let w = generate(&format!("{id}@2"), &[]).unwrap_or_else(|e| panic!("{id}@2: {e}"));
        check(&w);
    }
}

/// HQ 3.10 (widen.rs): the roads are paved wider than the layout, and nothing the
/// layout placed moves: the same lots (ids, blocks, districts, kinds, HQ ranks, growth
/// ranks, centres, fronts) as at the layout widths, each lot's door at most 2.5 m back
/// and every site at most 2.5 m; most roads at least 30% wider.
#[test]
fn wider_roads_move_no_lot() {
    for id in ["claude-hq@2", ISLAND] {
        let (seed_str, version) = parse_id(id).unwrap();
        let seed = rng::fnv1a64(seed_str.as_bytes());
        let p = profile_for(seed_str, version);
        let mut laid = profile_for(seed_str, version);
        (laid.paved_road_cm, laid.paved_avenue_cm) = (laid.road_cm, laid.avenue_cm);
        assert!(p.paved_road_cm * 100 >= p.road_cm * 130 && p.paved_avenue_cm * 100 >= p.avenue_cm * 125, "{id}: not much wider");
        let run = |p: &profile::Profile| {
            let river = river::River::new(seed, p).unwrap();
            let base = terrain::generate_with(seed, p, river.as_ref());
            super::generate(seed, p, &base, river.as_ref()).unwrap()
        };
        let ((was, r0, _), (now, r1, _)) = (run(&laid), run(&p));
        assert_eq!(was.lots.len(), now.lots.len(), "{id}: lots");
        for (a, b) in was.lots.iter().zip(&now.lots) {
            assert_eq!(
                (a.id, a.block, a.district, a.kind, a.rank, a.grow, a.x, a.z, a.front, a.floors),
                (b.id, b.block, b.district, b.kind, b.rank, b.grow, b.x, b.z, b.front, b.floors),
                "{id}: lot {} changed",
                a.id
            );
            let back = isqrt((a.door[0] - b.door[0]).pow(2) + (a.door[2] - b.door[2]).pow(2));
            assert!(back <= 250, "{id}: lot {}'s door moved {back} cm", a.id);
        }
        assert_eq!(was.sites.len(), now.sites.len(), "{id}: sites");
        for (a, b) in was.sites.iter().zip(&now.sites) {
            assert_eq!((&a.id, a.block, a.front), (&b.id, b.block, b.front), "{id}: site {}", a.id);
            let moved = isqrt((a.x - b.x).pow(2) + (a.z - b.z).pow(2));
            assert!(moved <= 250, "{id}: {} moved {moved} cm", a.id);
        }
        // the same streets, paved wider: all but a few (kept at the layout width where a lot
        // could not give way) at the profile's paved width
        assert_eq!(r0.edges.len(), r1.edges.len(), "{id}: roads");
        let city = r1.edges.iter().filter(|e| matches!(e.class, "local" | "arterial")).count();
        let wide = r1.edges.iter().filter(|e| e.width == if e.class == "arterial" { p.paved_avenue_cm } else { p.paved_road_cm }).count();
        assert!(wide * 100 >= city * 90, "{id}: {wide} of {city} streets paved wide");
    }
}

#[test]
fn edits_move_the_ground_not_the_layout() {
    let w0 = commons();
    let lot = w0.layers.lots.iter().find(|l| l.kind == "hq").unwrap();
    let edits = [Edit::Raise { x: lot.door[0], z: lot.door[2], r: 6_000, cm: 300 }];
    let w = generate("claude-hq@2", &edits).unwrap();
    assert_eq!(w.hashes.blocks, w0.hashes.blocks);
    assert_eq!(w.hashes.districts, w0.hashes.districts);
    let xz = |w: &WorldDoc| -> Vec<(i64, i64)> { w.layers.roads.edges.iter().flat_map(|e| e.points.iter().map(|q| (q[0], q[2]))).collect() };
    assert_eq!(xz(&w), xz(w0));
    let moved = &w.layers.lots[lot.id as usize];
    assert_eq!((moved.x, moved.z, &moved.poly, moved.door[0], moved.door[2]), (lot.x, lot.z, &lot.poly, lot.door[0], lot.door[2]));
    assert!(moved.door[1] > lot.door[1] + 250, "the door rose {} cm", moved.door[1] - lot.door[1]);
    assert_ne!(w.hashes.world, w0.hashes.world);
}

/// Each district grows in its own character: old town's lots are small, downtown's
/// large; suburbs have cul-de-sacs; there are 4 to 8 main roads.
#[test]
fn districts_have_character() {
    let l = &commons().layers;
    let mean = |d: u8| {
        let a: Vec<i64> = l.lots.iter().filter(|x| x.district == d).map(|x| area2(&pts(x.poly.as_ref().unwrap())) / 2).collect();
        assert!(!a.is_empty(), "no {} lots", l.districts.legend[d as usize]);
        a.iter().sum::<i64>() / a.len() as i64
    };
    assert!(mean(district::OLDTOWN) * 2 < mean(district::DOWNTOWN), "old town {} vs downtown {}", mean(district::OLDTOWN), mean(district::DOWNTOWN));
    assert!(mean(district::OFFICE) < mean(district::STUDIO));
    assert!(mean(district::SUBURB) < mean(district::INDUSTRIAL));
    assert!(character(district::SUBURB).end_pm > 0 && character(district::SUBURB).bend != 0);
    // dead ends: local streets with an end no other road meets, in the suburbs
    let r = &l.roads;
    let mut degree = vec![0; r.nodes.len()];
    for e in &r.edges {
        degree[e.a as usize] += 1;
        degree[e.b as usize] += 1;
    }
    let culs = r.nodes.iter().filter(|n| degree[n.id as usize] == 1 && l.districts.at(n.x, n.z) != district::WATER).count();
    assert!(culs > 0, "no cul-de-sacs");
    let mains: BTreeSet<&str> = r.edges.iter().filter(|e| e.class == "arterial").map(|e| e.name.as_str()).collect();
    assert!((4..=8).contains(&mains.len()), "{} arterials: {mains:?}", mains.len());
}

fn pts(v: &[[i64; 2]]) -> Vec<P> {
    v.iter().map(|q| (q[0], q[1])).collect()
}

fn check(w: &WorldDoc) {
    let id = &w.id;
    let (seed, version) = parse_id(id).unwrap();
    let p = profile_for(seed, version);
    // flatness is the generator's promise on the base ground (a road's carve can reach a lot's corners)
    let base = terrain::generate(rng::fnv1a64(seed.as_bytes()), &p);
    let l = &w.layers;
    let r = &l.roads;
    // a personal island grows by tier (island.rs); the Commons is always fully grown
    let grows = |t: Option<u8>| if p.name == "island" { t.is_some_and(|t| (1..=5).contains(&t)) } else { t.is_none() };

    // classes and widths
    for e in &r.edges {
        let (width, walk) = match e.class {
            "arterial" => (p.paved_avenue_cm, p.avenue_walk_cm),
            "local" => (p.paved_road_cm, p.street_walk_cm),
            "highway" => (p.highway_cm, 0),
            "ring" => (p.ring_cm, 0),
            c => panic!("{id}: edge {} has class {c}", e.id),
        };
        // (a road a lot could not give way to keeps its layout width, organic/widen.rs)
        let layout = match e.class {
            "arterial" => p.avenue_cm,
            "local" => p.road_cm,
            _ => width,
        };
        assert!((e.width, e.walk) == (width, walk) || (e.width, e.walk) == (layout, walk * layout / width), "{id}: edge {}", e.id);
        assert!(!e.name.is_empty() && grows(e.min_tier), "{id}: edge {} at tier {:?}", e.id, e.min_tier);
        let (na, nb) = (&r.nodes[e.a as usize], &r.nodes[e.b as usize]);
        assert_eq!((e.points[0], e.points[e.points.len() - 1]), ([na.x, na.y, na.z], [nb.x, nb.y, nb.z]), "{id}: edge {} ends", e.id);
    }

    // one network
    let mut parent: Vec<usize> = (0..r.nodes.len()).collect();
    fn find(p: &mut [usize], x: usize) -> usize {
        let mut x = x;
        while p[x] != x {
            p[x] = p[p[x]];
            x = p[x];
        }
        x
    }
    for e in &r.edges {
        let (a, b) = (find(&mut parent, e.a as usize), find(&mut parent, e.b as usize));
        parent[a] = b;
    }
    let root = find(&mut parent, 0);
    for k in 0..r.nodes.len() {
        assert_eq!(find(&mut parent, k), root, "{id}: road node {k} is cut off");
    }

    // no road steeper than the grade cap
    for e in &r.edges {
        let max = if roads::is_graded(e.class) { p.country_grade_pm } else { p.city_grade_pm };
        for q in e.points.windows(2) {
            let run = isqrt((q[1][0] - q[0][0]).pow(2) + (q[1][2] - q[0][2]).pow(2)).max(1);
            let grade = (q[1][1] - q[0][1]).abs() * 1000 / run;
            assert!(grade <= max, "{id}: {} ({}) is {grade} per mille steep", e.name, e.class);
        }
    }

    // roads meet only at nodes: no two segments touch but at an end they share
    let segs: Vec<(P, P, u32, i64)> = r
        .edges
        .iter()
        .flat_map(|e| e.points.windows(2).map(move |q| ((q[0][0], q[0][2]), (q[1][0], q[1][2]), e.id, e.width)))
        .collect();
    let cell = 2_000;
    let mut grid: BTreeMap<(i64, i64), Vec<usize>> = BTreeMap::new();
    for (k, s) in segs.iter().enumerate() {
        for cz in s.0 .1.min(s.1 .1).div_euclid(cell)..=s.0 .1.max(s.1 .1).div_euclid(cell) {
            for cx in s.0 .0.min(s.1 .0).div_euclid(cell)..=s.0 .0.max(s.1 .0).div_euclid(cell) {
                grid.entry((cx, cz)).or_default().push(k);
            }
        }
    }
    let node_at: BTreeSet<P> = r.nodes.iter().map(|n| (n.x, n.z)).collect();
    for ks in grid.values() {
        for (i, &a) in ks.iter().enumerate() {
            for &b in &ks[i + 1..] {
                let (s, t) = (segs[a], segs[b]);
                if s.2 == t.2 || !roads::segments_touch(s.0, s.1, t.0, t.1) {
                    continue;
                }
                let shared = [s.0, s.1].into_iter().find(|v| (*v == t.0 || *v == t.1) && node_at.contains(v));
                let ok = shared.is_some_and(|v| {
                    let (u, w) = (if s.0 == v { s.1 } else { s.0 }, if t.0 == v { t.1 } else { t.0 });
                    let (u, w) = ((u.0 - v.0, u.1 - v.1), (w.0 - v.0, w.1 - v.1));
                    u.0 as i128 * w.1 as i128 - u.1 as i128 * w.0 as i128 != 0 || u.0 * w.0 + u.1 * w.1 < 0
                });
                assert!(ok, "{id}: edges {} and {} cross at {:?}-{:?} / {:?}-{:?}", s.2, t.2, s.0, s.1, t.0, t.1);
            }
        }
    }

    // blocks: counter-clockwise simple footprints, the plaza first
    assert_eq!(l.blocks[0].district, district::PLAZA);
    assert_eq!(l.districts.at(0, 0), district::PLAZA);
    for b in &l.blocks {
        let poly = pts(b.poly.as_ref().unwrap_or_else(|| panic!("{id}: block {} has no footprint", b.id)));
        assert!(area2(&poly) > 0 && simple(&poly), "{id}: block {}'s footprint", b.id);
    }

    // lots: inside their block, clear of every city road, the door at a road's kerb with
    // the front facing it; an HQ lot or a building
    let city: Vec<&(P, P, u32, i64)> = segs.iter().filter(|s| !roads::is_graded(r.edges[s.2 as usize].class)).collect();
    let near = |q: P, reach: i64| city.iter().filter(move |s| nearest_on(q, s.0, s.1).1 <= reach * reach);
    for lot in &l.lots {
        let poly = pts(lot.poly.as_ref().unwrap_or_else(|| panic!("{id}: lot {} has no footprint", lot.id)));
        assert!(area2(&poly) > 0 && simple(&poly), "{id}: lot {}'s footprint", lot.id);
        assert!(lot.kind == "hq" || lot.kind == "building");
        let block = pts(l.blocks[lot.block as usize].poly.as_ref().unwrap());
        assert!(inside(centroid(&poly), &block), "{id}: lot {} leaves block {}", lot.id, lot.block);
        let n = poly.len();
        for s in near(centroid(&poly), 30_000) {
            for k in 0..n {
                // (less a centimetre or two: an edge's resampled points are rounded off its straight line)
                assert!(seg_dist2(poly[k], poly[(k + 1) % n], s.0, s.1) >= (s.3 / 2 - 2).pow(2), "{id}: lot {} is on edge {}", lot.id, s.2);
            }
        }
        let f = lot.front.unwrap_or_else(|| panic!("{id}: lot {} has no front", lot.id));
        assert!((isqrt(f[0] * f[0] + f[1] * f[1]) - ONE).abs() <= 2, "{id}: lot {}'s front is not a unit vector", lot.id);
        let door = (lot.door[0], lot.door[2]);
        let front = near(door, 2_000).find(|s| {
            let (q, d2) = nearest_on(door, s.0, s.1);
            let r = s.3 / 2 + KERB_CM + 60;
            d2 <= r * r && (q.0 - door.0) * f[0] + (q.1 - door.1) * f[1] > 0
        });
        assert!(front.is_some(), "{id}: lot {} has no road frontage at {door:?}", lot.id);
        assert!(lot.grow.is_some() && grows(lot.min_tier), "{id}: lot {} at tier {:?}", lot.id, lot.min_tier);
    }

    // growth: every lot a rank, nearest the core first
    let mut grow: Vec<(u32, i64)> = l.lots.iter().map(|x| (x.grow.unwrap(), x.x * x.x + x.z * x.z)).collect();
    grow.sort();
    for (k, g) in grow.iter().enumerate() {
        assert_eq!(g.0, k as u32, "{id}: growth ranks are not 0..{}", grow.len());
        assert!(k == 0 || grow[k - 1].1 <= g.1, "{id}: lot of growth rank {k} is nearer the core than {}", k - 1);
    }

    // the HQ pool: the profile's count, ranked by distance to the plaza, tiered, flat
    let mut hq: Vec<&city::Lot> = l.lots.iter().filter(|x| x.kind == "hq").collect();
    hq.sort_by_key(|x| x.rank);
    assert_eq!(hq.len() as i64, p.hq_lots, "{id}: the HQ pool");
    let mut last = -1;
    for (k, lot) in hq.iter().enumerate() {
        assert_eq!((lot.rank, lot.tier), (Some(k as u32), Some(k as u32 / p.hq_tier as u32)));
        let d = lot.x * lot.x + lot.z * lot.z;
        assert!(d >= last, "{id}: HQ lot {k} is nearer the plaza than lot {}", k - 1);
        last = d;
        let poly = pts(lot.poly.as_ref().unwrap());
        assert!(area2(&poly) >= 2 * p.hq_min_m2 * 10_000, "{id}: HQ lot {k} is small");
        assert!(rise(&base, &poly) <= p.site_flat_cm * 2, "{id}: HQ lot {k} is on a slope");
    }

    // sites: every one the profile reserves, inside its block, flat, apart; a tier each.
    // The shore's sites and the airport stand outside the city (civic.rs)
    for s in &p.sites {
        assert_eq!(l.sites.iter().filter(|x| x.kind == s.kind).count() as i64, s.count, "{id}: {} placed", s.kind);
    }
    for (k, s) in l.sites.iter().enumerate() {
        let poly = pts(s.poly.as_ref().unwrap());
        let block = pts(l.blocks[s.block as usize].poly.as_ref().unwrap());
        let off = matches!(s.kind, "dock" | "port" | "airport" | "stadium");
        assert!(off || poly.iter().all(|&q| inside(q, &block)), "{id}: {} leaves its block", s.id);
        assert!(s.tier.is_some_and(|t| (1..=5).contains(&t)), "{id}: {} has tier {:?}", s.id, s.tier);
        assert!(off || rise(&base, &poly) <= p.site_flat_cm, "{id}: {} is on a slope", s.id);
        for o in &l.sites[k + 1..] {
            let other = pts(o.poly.as_ref().unwrap());
            let apart = !poly.iter().any(|&q| inside(q, &other)) && !other.iter().any(|&q| inside(q, &poly));
            assert!(apart || s.kind == "spawn" || o.kind == "spawn", "{id}: {} overlaps {}", s.id, o.id);
        }
    }
}
