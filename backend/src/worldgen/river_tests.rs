//! The river (@2): its course from the coast to its basin, its water at sea level,
//! nothing built in it but bridges, the dock and the port, and the city still one
//! network across it at every tier.

use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::sync::OnceLock;

use super::super::island::{Coast, RADII_CM};
use super::super::noise::ONE;
use super::super::organic::geom::{area2, dist2, dot, inside, len, nearest_on, seg_dist2, simple, P};
use super::super::roads::segments_touch;
use super::super::*;
use super::{River, BANK_CM, SLOPE_CM};

const ISLAND: &str = "user:0b6f2a3c-1d4e-4f5a-9b8c-7d6e5f4a3b2c@2";
/// Worlds every property is checked on besides the Commons and ISLAND: a river must not need luck.
const MORE: [&str; 9] = [
    "a@2",
    "zzz@2",
    "daily:2026-10-19@2",
    "s86@2",
    "user:00000000-0000-4000-8000-000000000000@2",
    "user:9f1c2d3e-4b5a-4c6d-8e7f-a1b2c3d4e5f6@2",
    "user:5e6f7a8b-9c0d-4e1f-a2b3-c4d5e6f7a8b9@2",
    "user:deadbeef-0000-4abc-9def-123456789abc@2",
    "user:f0e1d2c3-b4a5-4968-8776-655443322110@2",
];

/// Arena City's fingerprint (worldgen/tests.rs CLAUDE_HQ_1): the river must not move it.
const CLAUDE_HQ_1: &str = "0c165b2f78e5de77";

/// The Commons, ISLAND and MORE, generated once for the whole run.
fn worlds() -> &'static [WorldDoc] {
    static W: OnceLock<Vec<WorldDoc>> = OnceLock::new();
    W.get_or_init(|| ["claude-hq@2", ISLAND].into_iter().chain(MORE).map(|id| generate(id, &[]).unwrap_or_else(|e| panic!("{id}: {e}"))).collect())
}

fn seed_of(w: &WorldDoc) -> (u64, profile::Profile) {
    let (seed, v) = parse_id(&w.id).unwrap();
    (rng::fnv1a64(seed.as_bytes()), profile_for(seed, v))
}

fn river_of(w: &WorldDoc) -> River {
    let (seed, p) = seed_of(w);
    River::new(seed, &p).unwrap().unwrap()
}

fn pts(v: &[[i64; 2]]) -> Vec<P> {
    v.iter().map(|q| (q[0], q[1])).collect()
}

/// The squared distance (cm2) from a polygon to the water's outline: 0 when they touch
/// or one holds a point of the other.
fn to_water(water: &[P], poly: &[P]) -> i64 {
    if poly.iter().any(|&q| inside(q, water)) || water.iter().any(|&q| inside(q, poly)) {
        return 0;
    }
    let (n, m) = (poly.len(), water.len());
    (0..n).flat_map(|i| (0..m).map(move |j| seg_dist2(poly[i], poly[(i + 1) % n], water[j], water[(j + 1) % m]))).min().unwrap()
}

/// Does segment ab cross the water (touch its outline, or lie in it)?
fn wet(water: &[P], a: P, b: P) -> bool {
    let m = water.len();
    inside(a, water) || inside(b, water) || (0..m).any(|j| segments_touch(a, b, water[j], water[(j + 1) % m]))
}

/// The road nodes the plaza reaches at tier t by the roads present then (all of them on
/// the Commons, which is fully grown).
fn reachable(w: &WorldDoc, t: u8) -> BTreeSet<u32> {
    let r = &w.layers.roads;
    let start = r.nodes.iter().min_by_key(|n| (n.x * n.x + n.z * n.z, n.id)).unwrap().id;
    let mut adj: BTreeMap<u32, Vec<u32>> = BTreeMap::new();
    for e in r.edges.iter().filter(|e| e.min_tier.unwrap_or(1) <= t) {
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

/// The course: from a mouth on the coast to the basin's centre, the water one simple
/// counter-clockwise outline closed out at sea, the basin a disc 2.2 widths across
/// 25-45% of the city's radius out, clear of the plaza block.
#[test]
fn the_mouth_is_on_the_coast_and_the_water_is_simple() {
    for w in worlds() {
        let id = &w.id;
        let (seed, p) = seed_of(w);
        let coast = Coast::new(seed, &p).unwrap();
        let r = w.layers.river.as_ref().unwrap_or_else(|| panic!("{id}: no river"));
        let center = pts(&r.center);
        let mouth = center[0];
        assert!((len(mouth) - coast.radius_at(mouth)).abs() <= 100, "{id}: the mouth is {} m off the coast", (len(mouth) - coast.radius_at(mouth)) / 100);
        assert!(center[1..].iter().all(|&q| coast.land(q)), "{id}: the river leaves the island upstream of its mouth");
        assert_eq!(*center.last().unwrap(), (r.basin.x, r.basin.z), "{id}: the centre line ends off the basin's centre");
        assert_eq!((r.width_cm, r.basin.r), (p.river_cm.unwrap(), p.river_cm.unwrap() * 11 / 10), "{id}: width and basin");
        let rb = len((r.basin.x, r.basin.z));
        assert!((p.city_r_cm / 4..=p.city_r_cm * 45 / 100).contains(&rb), "{id}: the basin is {} m out", rb / 100);
        let water = pts(&r.poly);
        assert!(area2(&water) > 0 && simple(&water), "{id}: the water is not a simple counter-clockwise outline");
        let out = water.iter().map(|&q| len(q) - coast.radius_at(q)).max().unwrap();
        assert!(out >= 2_500, "{id}: the water reaches only {} m past the coast", out / 100);
        let plaza = pts(w.layers.blocks[0].poly.as_ref().unwrap());
        assert!(to_water(&water, &plaza) > 0, "{id}: the river runs into the plaza block");
        // through the town: in from past the city's edge, passing the plaza nearer than its basin
        assert!(len(mouth) > p.city_r_cm, "{id}: the mouth is in town");
        let nearest = center.iter().map(|&q| len(q)).min().unwrap();
        assert!(nearest < rb, "{id}: the river comes no nearer the plaza than {} m", nearest / 100);
    }
}

/// Nothing stands in the river or on the 4 m bank beside it: no street (bar the
/// bridges), block, lot or site (bar the dock and the port, out over the water).
#[test]
fn nothing_stands_in_the_river() {
    for w in worlds() {
        let id = &w.id;
        let l = &w.layers;
        let water = pts(&l.river.as_ref().unwrap().poly);
        let (x0, x1, z0, z1) = water.iter().fold((i64::MAX, i64::MIN, i64::MAX, i64::MIN), |m, q| (m.0.min(q.0), m.1.max(q.0), m.2.min(q.1), m.3.max(q.1)));
        let far = |poly: &[P], reach: i64| poly.iter().all(|q| q.0 < x0 - reach || q.0 > x1 + reach || q.1 < z0 - reach || q.1 > z1 + reach);
        for e in l.roads.edges.iter().filter(|e| e.bridge.is_none()) {
            let clear = e.width / 2 + 400;
            for s in e.points.windows(2) {
                let seg = [(s[0][0], s[0][2]), (s[1][0], s[1][2])];
                if far(&seg, clear) {
                    continue;
                }
                let m = water.len();
                let d2 = if wet(&water, seg[0], seg[1]) { 0 } else { (0..m).map(|j| seg_dist2(seg[0], seg[1], water[j], water[(j + 1) % m])).min().unwrap() };
                assert!(d2 >= (clear - 2) * (clear - 2), "{id}: {} ({}, edge {}) is {} m from the water", e.name, e.class, e.id, d2.isqrt() / 100);
            }
        }
        let polys = l.blocks.iter().map(|b| (format!("block {}", b.id), b.poly.as_ref()))
            .chain(l.lots.iter().map(|x| (format!("lot {}", x.id), x.poly.as_ref())))
            .chain(l.sites.iter().filter(|s| !matches!(s.kind, "dock" | "port")).map(|s| (s.id.clone(), s.poly.as_ref())));
        for (what, poly) in polys {
            let poly = pts(poly.unwrap());
            if !far(&poly, 400) {
                assert!(to_water(&water, &poly) >= 400 * 400, "{id}: {what} is within 4 m of the water");
            }
        }
    }
}

/// Every road edge whose centre line crosses the water is a bridge, and every bridge
/// crosses it: straight over (an arterial, the ring road or a highway, never a local
/// street), level, its deck a metre over the higher of its banks.
#[test]
fn every_crossing_is_a_bridge() {
    for w in worlds() {
        let id = &w.id;
        let (seed, p) = seed_of(w);
        let base = terrain::generate(seed, &p);
        let l = &w.layers;
        let water = pts(&l.river.as_ref().unwrap().poly);
        let mut bridges = 0;
        for e in &l.roads.edges {
            let crosses = e.points.windows(2).any(|s| wet(&water, (s[0][0], s[0][2]), (s[1][0], s[1][2])));
            assert_eq!(crosses, e.bridge == Some(true), "{id}: {} ({}, edge {}) crosses the water: {crosses}, bridge: {:?}", e.name, e.class, e.id, e.bridge);
            if e.bridge.is_none() {
                continue;
            }
            bridges += 1;
            assert!(matches!(e.class, "arterial" | "ring" | "highway"), "{id}: a {} bridge", e.class);
            let (a, b) = (e.points[0], e.points[e.points.len() - 1]);
            for q in &e.points {
                let off = (b[0] - a[0]) as i128 * (q[2] - a[2]) as i128 - (b[2] - a[2]) as i128 * (q[0] - a[0]) as i128;
                let span = len((b[0] - a[0], b[2] - a[2])) as i128;
                assert!(off.abs() <= 2 * span, "{id}: {} bends over the water", e.name);
                assert_eq!(q[1], a[1], "{id}: {} is not level", e.name);
            }
            let bank = base.height_at(a[0], a[2]).max(base.height_at(b[0], b[2]));
            assert!(a[1] >= bank + 100, "{id}: {}'s deck is {} cm over its higher bank", e.name, a[1] - bank);
        }
        assert!(bridges >= 1, "{id}: no bridge");
    }
}

/// The streets that meet a bridge climb to its deck no steeper than a city street may.
#[test]
fn streets_ramp_up_to_the_bridges() {
    for w in worlds() {
        let (_, p) = seed_of(w);
        for e in w.layers.roads.edges.iter().filter(|e| matches!(e.class, "arterial" | "local")) {
            for q in e.points.windows(2) {
                let run = len((q[1][0] - q[0][0], q[1][2] - q[0][2])).max(1);
                assert!((q[1][1] - q[0][1]).abs() * 1000 / run <= p.city_grade_pm, "{}: {} is steep by a bridge", w.id, e.name);
            }
        }
    }
}

/// The dock stands on the river's bank by the plaza (on a personal island inside the
/// tier-1 ring, its quay a tier-1 road the plaza reaches); the port on the basin. Both
/// straddle the water's edge, their fronts out over it, and `island.docks` lists them.
#[test]
fn the_dock_and_the_port_are_on_the_river() {
    for w in worlds() {
        let id = &w.id;
        let l = &w.layers;
        let r = l.river.as_ref().unwrap();
        let water = pts(&r.poly);
        let site = |kind: &str| l.sites.iter().find(|s| s.kind == kind).unwrap_or_else(|| panic!("{id}: no {kind}"));
        for kind in ["dock", "port"] {
            let s = site(kind);
            let poly = pts(s.poly.as_ref().unwrap());
            assert!(poly.iter().any(|&q| inside(q, &water)) && poly.iter().any(|&q| !inside(q, &water)), "{id}: the {kind} does not stand at the water's edge");
            assert!(inside(transit::door(s), &water), "{id}: the {kind} faces away from the water");
            assert!(l.island.as_ref().unwrap().docks.contains(&s.id), "{id}: {} is not in the docks", s.id);
        }
        let port = pts(site("port").poly.as_ref().unwrap());
        let (b, rb) = ((r.basin.x, r.basin.z), r.basin.r);
        assert!(port.iter().any(|&q| dist2(q, b) < rb * rb) && port.iter().any(|&q| dist2(q, b) > rb * rb), "{id}: the port is not on the basin's edge");
        let dock = site("dock");
        let back = (dock.x - dock.front.unwrap()[0] * (dock.d / 2 + 100) / ONE, dock.z - dock.front.unwrap()[1] * (dock.d / 2 + 100) / ONE);
        let rd = &l.roads;
        let quay = rd
            .edges
            .iter()
            .filter(|e| e.bridge.is_none())
            .min_by_key(|e| e.points.windows(2).map(|s| nearest_on(back, (s[0][0], s[0][2]), (s[1][0], s[1][2])).1).min().unwrap())
            .unwrap();
        let gap = quay.points.windows(2).map(|s| nearest_on(back, (s[0][0], s[0][2]), (s[1][0], s[1][2])).1).min().unwrap().isqrt();
        assert!(gap <= BANK_CM, "{id}: the dock's nearest road ({}) is {} m from its back", quay.name, gap / 100);
        if w.profile == "island" {
            assert!(len((dock.x, dock.z)) <= RADII_CM[0], "{id}: the dock is {} m out, past the first ring", len((dock.x, dock.z)) / 100);
            assert_eq!(dock.tier, Some(1), "{id}: the dock");
            assert_eq!(quay.min_tier, Some(1), "{id}: the dock's road {} opens at tier {:?}", quay.name, quay.min_tier);
            let net = reachable(w, 1);
            assert!(net.contains(&quay.a) && net.contains(&quay.b), "{id}: the plaza does not reach the dock at tier 1");
        }
    }
}

/// One network across the river at every tier: each bridge present at a tier joins
/// roads the plaza reaches then (the Commons: always).
#[test]
fn the_network_crosses_the_river_at_every_tier() {
    for w in worlds() {
        for t in 1..=5u8 {
            let net = reachable(w, t);
            let present: Vec<_> = w.layers.roads.edges.iter().filter(|e| e.min_tier.unwrap_or(1) <= t).collect();
            for e in &present {
                assert!(net.contains(&e.a) && net.contains(&e.b), "{}: edge {} ({}) is cut off at tier {t}", w.id, e.id, e.name);
            }
        }
    }
}

/// The water is at sea level: the base terrain sinks below the sea inside it, the bank
/// rises above it, and past the bank's slope the land is its own.
#[test]
fn the_water_is_below_the_sea_and_the_bank_above_it() {
    for w in worlds() {
        let id = &w.id;
        let (seed, p) = seed_of(w);
        let r = river_of(w);
        let sea = p.sea_cm.unwrap();
        let (with, without) = (terrain::generate(seed, &p), terrain::generate_with(seed, &p, None));
        let coast = Coast::new(seed, &p).unwrap();
        let water = pts(&r.poly);
        let m = water.len();
        let (mut wet, mut bank) = (0, 0);
        for iz in 0..with.n {
            for ix in 0..with.n {
                let q = with.vertex_pos(ix, iz);
                if !r.bank.holds(q) {
                    assert_eq!(with.heights[iz * with.n + ix], without.heights[iz * with.n + ix], "{id}: the land at {q:?} is not its own");
                    continue;
                }
                let h = with.heights[iz * with.n + ix] as i64;
                let d = (0..m).map(|j| nearest_on(q, water[j], water[(j + 1) % m]).1).min().unwrap().isqrt();
                if inside(q, &water) {
                    assert!(h <= sea - 100, "{id}: the river at {q:?} is {h} cm, the sea {sea}");
                    wet += 1;
                } else if coast.land(q) && d > 100 {
                    assert!(h >= sea + 100, "{id}: the bank at {q:?} is {h} cm, the sea {sea}");
                    if d >= SLOPE_CM + 100 {
                        assert_eq!(h, without.heights[iz * with.n + ix] as i64, "{id}: the land past the bank's slope at {q:?}");
                    }
                    bank += 1;
                }
            }
        }
        assert!(wet > 0 && bank > 0, "{id}: {wet} wet vertices, {bank} on the bank");
    }
}

/// The same id gives the same river; @1 has none and serialises no bridge.
#[test]
fn the_same_id_is_the_same_river_and_version_1_has_none() {
    let a = generate(ISLAND, &[]).unwrap();
    assert_eq!(a.hashes.river, worlds()[1].hashes.river);
    assert!(a.hashes.river.is_some());
    assert_eq!(serde_json::to_string(&a.layers.river).unwrap(), serde_json::to_string(&worlds()[1].layers.river).unwrap());
    let rivers: BTreeSet<&String> = worlds().iter().map(|w| w.hashes.river.as_ref().unwrap()).collect();
    assert_eq!(rivers.len(), worlds().len(), "two worlds share a river");
    let v1 = generate("claude-hq@1", &[]).unwrap();
    assert_eq!(v1.hashes.world, CLAUDE_HQ_1);
    assert!(v1.layers.river.is_none() && v1.hashes.river.is_none());
    let json = serde_json::to_string(&v1).unwrap();
    for key in ["\"river\"", "\"bridge\""] {
        assert!(!json.contains(key), "claude-hq@1 serialises {key}");
    }
    assert!(River::new(1, &profile::city()).unwrap().is_none());
}

/// The bank's outline is the water's, `BANK_CM` out: nine points in ten that far from
/// the water (or farther, round the port's apron), none nearer than half of it (where
/// the channel bends, widens into the bay or meets the basin: still past the bank's
/// slope), and the quay's vertex behind the dock.
#[test]
fn the_bank_is_round_the_water() {
    for w in worlds() {
        let r = river_of(w);
        let water = pts(&r.poly);
        let m = water.len();
        let near = |q: P| (0..m).map(|j| nearest_on(q, water[j], water[(j + 1) % m]).1).min().unwrap().isqrt();
        let off: Vec<i64> = r.bank.poly.iter().map(|&q| near(q)).collect();
        let true_off = off.iter().filter(|&&d| d >= BANK_CM - 100).count();
        assert!(true_off * 10 >= off.len() * 9, "{}: {true_off} of {} bank points are {} m off the water", w.id, off.len(), BANK_CM / 100);
        assert!(off.iter().all(|&d| d >= BANK_CM / 2), "{}: the bank comes within {} m of the water", w.id, off.iter().min().unwrap() / 100);
        let q = r.bank.poly[r.quay];
        assert!(dot((r.dock.1 .0, r.dock.1 .1), (r.dock.0 .0 - q.0, r.dock.0 .1 - q.1)) > 0, "{}: the quay is not behind the dock", w.id);
    }
}
