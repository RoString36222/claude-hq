//! Civic sites, industry zones and transit lines on fully grown @2 worlds: the Commons
//! and personal islands. Distances "by road" are measured on the generated doc's city
//! streets (no highways or ring), door to door, as a fire engine would drive.

use std::cmp::Reverse;
use std::collections::{BTreeMap, BTreeSet, BinaryHeap};
use std::sync::OnceLock;

use super::super::city::{Lot, Site};
use super::super::noise::{isqrt, ONE};
use super::super::organic::geom::{inside, len, nearest_on, seg_dist2, P};
use super::super::profile::district;
use super::super::roads::{is_graded, Roads};
use super::super::*;
use super::{Place, CIVIC, VIEWS};

const ISLAND: &str = "user:0b6f2a3c-1d4e-4f5a-9b8c-7d6e5f4a3b2c@2";
const ISLANDS: [&str; 4] = [
    "user:00000000-0000-4000-8000-000000000000@2",
    "user:9f1c2d3e-4b5a-4c6d-8e7f-a1b2c3d4e5f6@2",
    "user:5e6f7a8b-9c0d-4e1f-a2b3-c4d5e6f7a8b9@2",
    "user:deadbeef-0000-4abc-9def-123456789abc@2",
];

/// Arena City's fingerprint (worldgen/tests.rs CLAUDE_HQ_1): version 2 must not move it.
const CLAUDE_HQ_1: &str = "0c165b2f78e5de77";

fn commons() -> &'static WorldDoc {
    static W: OnceLock<WorldDoc> = OnceLock::new();
    W.get_or_init(|| generate("claude-hq@2", &[]).unwrap())
}

fn island() -> &'static WorldDoc {
    static W: OnceLock<WorldDoc> = OnceLock::new();
    W.get_or_init(|| generate(ISLAND, &[]).unwrap())
}

/// The Commons, the island, and the other islands.
fn worlds() -> Vec<&'static WorldDoc> {
    static MORE: OnceLock<Vec<WorldDoc>> = OnceLock::new();
    let more = MORE.get_or_init(|| ISLANDS.iter().map(|id| generate(id, &[]).unwrap_or_else(|e| panic!("{id}: {e}"))).collect());
    let mut out = vec![commons(), island()];
    out.extend(more.iter());
    out
}

fn pts(v: &[[i64; 2]]) -> Vec<P> {
    v.iter().map(|q| (q[0], q[1])).collect()
}

fn door(l: &Lot) -> P {
    (l.door[0], l.door[2])
}

/// Road distance on a doc's city streets.
struct Net {
    pos: Vec<P>,
    /// (a, b) of each city edge, straight between its nodes.
    edges: Vec<(u32, u32)>,
    adj: Vec<Vec<(u32, i64)>>,
}

impl Net {
    fn new(r: &Roads) -> Self {
        let pos: Vec<P> = r.nodes.iter().map(|n| (n.x, n.z)).collect();
        let mut adj = vec![Vec::new(); pos.len()];
        let mut edges = Vec::new();
        for e in r.edges.iter().filter(|e| !is_graded(e.class)) {
            let l = len((pos[e.b as usize].0 - pos[e.a as usize].0, pos[e.b as usize].1 - pos[e.a as usize].1));
            adj[e.a as usize].push((e.b, l));
            adj[e.b as usize].push((e.a, l));
            edges.push((e.a, e.b));
        }
        Net { pos, edges, adj }
    }

    /// The street nearest q: (edge, way to a, way to b, way across).
    fn attach(&self, q: P) -> (usize, i64, i64, i64) {
        let (d2, k, n) = self.edges.iter().enumerate().map(|(k, &(a, b))| {
            let (n, d2) = nearest_on(q, self.pos[a as usize], self.pos[b as usize]);
            (d2, k, n)
        }).min().unwrap();
        let (a, b) = self.edges[k];
        let l = |p: P, o: P| len((p.0 - o.0, p.1 - o.1));
        (k, l(n, self.pos[a as usize]), l(n, self.pos[b as usize]), isqrt(d2))
    }

    /// The road distance from the nearest of `from` to each of `to` (cm).
    fn distances(&self, from: &[P], to: &[P]) -> Vec<i64> {
        let src: Vec<_> = from.iter().map(|&q| self.attach(q)).collect();
        let mut dist = vec![i64::MAX; self.pos.len()];
        let mut heap = BinaryHeap::new();
        for &(k, da, db, off) in &src {
            for (n, d) in [(self.edges[k].0, off + da), (self.edges[k].1, off + db)] {
                if d < dist[n as usize] {
                    dist[n as usize] = d;
                    heap.push(Reverse((d, n)));
                }
            }
        }
        while let Some(Reverse((d, n))) = heap.pop() {
            if d > dist[n as usize] {
                continue;
            }
            for &(m, l) in &self.adj[n as usize] {
                if d + l < dist[m as usize] {
                    dist[m as usize] = d + l;
                    heap.push(Reverse((d + l, m)));
                }
            }
        }
        to.iter()
            .map(|&q| {
                let (k, da, db, off) = self.attach(q);
                let (a, b) = self.edges[k];
                let mut best = dist[a as usize].saturating_add(da).min(dist[b as usize].saturating_add(db));
                for s in src.iter().filter(|s| s.0 == k) {
                    best = best.min(s.3 + (s.1 - da).abs());
                }
                best.saturating_add(off)
            })
            .collect()
    }
}

fn sites<'a>(w: &'a WorldDoc, kind: &str) -> Vec<&'a Site> {
    w.layers.sites.iter().filter(|s| s.kind == kind).collect()
}

/// Road distance from the nearest site of `kind` to each lot.
fn by_road(w: &WorldDoc, kind: &str) -> Vec<i64> {
    let from: Vec<P> = sites(w, kind).iter().map(|s| transit::door(s)).collect();
    assert!(!from.is_empty(), "{}: no {kind}", w.id);
    let to: Vec<P> = w.layers.lots.iter().map(door).collect();
    Net::new(&w.layers.roads).distances(&from, &to)
}

#[test]
fn every_lot_is_within_800_m_of_a_fire_station_by_road() {
    for w in worlds() {
        for (l, d) in w.layers.lots.iter().zip(by_road(w, "fire")) {
            assert!(d <= 80_000, "{}: lot {} is {} m from a fire station", w.id, l.id, d / 100);
        }
    }
}

#[test]
fn a_clinic_is_within_600_m_of_nine_lots_in_ten() {
    for w in worlds() {
        let ds = by_road(w, "clinic");
        let near = ds.iter().filter(|&&d| d <= 60_000).count();
        assert!(near * 10 >= ds.len() * 9, "{}: {near} of {} lots within 600 m of a clinic", w.id, ds.len());
        // on arterials, 300 m apart
        let cs = sites(w, "clinic");
        for (k, a) in cs.iter().enumerate() {
            for b in &cs[k + 1..] {
                assert!((a.x - b.x).pow(2) + (a.z - b.z).pow(2) >= 30_000i64.pow(2), "{}: {} and {} are close", w.id, a.id, b.id);
            }
            assert!(on_arterial(w, a), "{}: {} is not on an arterial", w.id, a.id);
        }
        assert_eq!(sites(w, "hospital").len(), 1);
        assert_eq!(sites(w, "hospital")[0].tier, Some(3));
    }
}

/// Lots without a tier (a fully grown city) count as tier 2 and up.
#[test]
fn every_tier_2_lot_is_within_250_m_of_a_bus_stop() {
    for w in worlds() {
        for (l, d) in w.layers.lots.iter().zip(by_road(w, "busstop")) {
            if l.min_tier.unwrap_or(2) >= 2 {
                assert!(d <= 25_000, "{}: lot {} is {} m from a bus stop", w.id, l.id, d / 100);
            }
        }
        // most stops are on the arterials
        let stops = sites(w, "busstop");
        assert!(stops.iter().all(|s| at_tier(w, s, 2)));
        let on = stops.iter().filter(|s| on_arterial(w, s)).count();
        // (a full-size personal island is mostly suburb, its lanes reached from their own streets: 3 in 5)
        let share = if w.profile == "island" { (3, 5) } else { (3, 4) };
        assert!(on * share.1 >= stops.len() * share.0, "{}: {on} of {} bus stops on arterials", w.id, stops.len());
    }
}

/// Is the site at the table's tier? On a personal island a site opens at its ring's
/// tier if that is later (island.rs checks the exact rule).
fn at_tier(w: &WorldDoc, s: &Site, tier: u8) -> bool {
    if w.profile != "island" {
        return s.tier == Some(tier);
    }
    s.tier.is_some_and(|t| t >= tier)
}

/// Is the site's door at an arterial's kerb?
fn on_arterial(w: &WorldDoc, s: &Site) -> bool {
    let r = &w.layers.roads;
    let d = transit::door(s);
    r.edges.iter().filter(|e| e.class == "arterial").any(|e| {
        let (a, b) = ((r.nodes[e.a as usize].x, r.nodes[e.a as usize].z), (r.nodes[e.b as usize].x, r.nodes[e.b as usize].z));
        let reach = e.width / 2 + 200;
        nearest_on(d, a, b).1 <= reach * reach
    })
}

#[test]
fn no_site_overlaps_an_hq_lot_or_a_road() {
    for w in worlds() {
        let l = &w.layers;
        let hq: Vec<Vec<P>> = l.lots.iter().filter(|x| x.kind == "hq").map(|x| pts(x.poly.as_ref().unwrap())).collect();
        let (seed, v) = parse_id(&w.id).unwrap();
        assert_eq!(hq.len() as i64, profile_for(seed, v).hq_lots, "{}: the HQ pool lost lots", w.id);
        for s in &l.sites {
            let poly = pts(s.poly.as_ref().unwrap());
            let n = poly.len();
            for e in &l.roads.edges {
                for q in e.points.windows(2) {
                    let (a, b) = ((q[0][0], q[0][2]), (q[1][0], q[1][2]));
                    for k in 0..n {
                        assert!(seg_dist2(poly[k], poly[(k + 1) % n], a, b) >= (e.width / 2).pow(2), "{}: {} is on {} ({})", w.id, s.id, e.name, e.class);
                    }
                }
            }
            for h in &hq {
                let m = h.len();
                let apart = !poly.iter().any(|&q| inside(q, h))
                    && !h.iter().any(|&q| inside(q, &poly))
                    && (0..n).all(|i| (0..m).all(|j| seg_dist2(poly[i], poly[(i + 1) % n], h[j], h[(j + 1) % m]) > 0));
                assert!(apart, "{}: {} is on an HQ lot", w.id, s.id);
            }
        }
    }
}

/// Every civic kind the table places is there, at its tier; the shore's only where
/// there is a shore. The town hall looks across at the plaza; the school and the
/// university are in residential districts; power and water stand in industry where
/// the city has some.
#[test]
fn every_civic_kind_is_placed_by_its_rule() {
    for w in worlds() {
        let (seed, v) = parse_id(&w.id).unwrap();
        let p = profile_for(seed, v);
        for row in CIVIC {
            let got = sites(w, row.kind);
            let want = match row.place {
                Place::Shore => p.coast_r_cm.or(p.sea_cm).is_some(),
                // a personal island's city fills it at full size: no open land is left for a runway
                Place::Edge if w.profile == "island" => !got.is_empty(),
                _ => true,
            };
            assert_eq!(!got.is_empty(), want, "{}: {} placed: {}", w.id, row.kind, got.len());
            for s in got {
                assert!(at_tier(w, s, row.tier), "{}: {} at tier {:?}", w.id, s.id, s.tier);
            }
        }
        for kind in ["townhall", "police", "library", "post", "market", "school", "transit", "bank", "hospital", "mall", "university", "power", "water", "stadium", "airport"] {
            let n = sites(w, kind).len();
            assert!(n == 1 || (kind == "airport" && n == 0 && w.profile == "island"), "{}: {n} {kind}", w.id);
        }
        let th = sites(w, "townhall")[0];
        let f = th.front.unwrap();
        let toward = -(th.x as i128 * f[0] as i128 + th.z as i128 * f[1] as i128);
        assert!(toward * 10 >= 7 * len((th.x, th.z)) as i128 * ONE as i128, "{}: the town hall turns its back on the plaza", w.id);
        for kind in ["police", "transit", "hospital"] {
            assert!(on_arterial(w, sites(w, kind)[0]), "{}: the {kind} is not on an arterial", w.id);
        }
        let lots_of = |d: u8| w.layers.blocks.iter().any(|b| b.district == d);
        for kind in ["school", "university"] {
            let b = &w.layers.blocks[sites(w, kind)[0].block as usize];
            assert!([district::SUBURB, district::OLDTOWN].contains(&b.district), "{}: the {kind} is in {}", w.id, b.district);
        }
        if lots_of(district::INDUSTRIAL) {
            for kind in ["power", "water"] {
                assert_eq!(w.layers.blocks[sites(w, kind)[0].block as usize].district, district::INDUSTRIAL, "{}: {kind}", w.id);
            }
        }
        assert!(sites(w, "view-building").is_empty());
    }
}

/// The 13 HQ tabs each open from one civic site in the Commons, and the list is the
/// client's (games/hqbase.js VIEWS, in order).
#[test]
fn every_hq_tab_has_a_door() {
    let w = commons();
    for (view, kind) in VIEWS {
        let with: Vec<&Site> = w.layers.sites.iter().filter(|s| s.view == Some(view)).collect();
        assert_eq!(with.len(), 1, "tab {view}");
        assert_eq!((with[0].kind, with[0].id.as_str()), (kind, format!("{kind}:0").as_str()), "tab {view}");
    }
    assert_eq!(w.layers.sites.iter().filter(|s| s.view.is_some()).count(), VIEWS.len());
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../games/hqbase.js");
    let Ok(js) = std::fs::read_to_string(path) else {
        eprintln!("every_hq_tab_has_a_door: the client check skipped, {path} is not here");
        return;
    };
    let block = &js[js.find("var VIEWS = [").expect("hqbase.js has VIEWS")..];
    let block = &block[..block.find("];").unwrap()];
    let tabs: Vec<&str> = block.split("{view: \"").skip(1).map(|t| &t[..t.find('"').unwrap()]).collect();
    assert_eq!(tabs, VIEWS.iter().map(|v| v.0).collect::<Vec<_>>());
}

#[test]
fn zones_export_their_jobs() {
    for w in worlds() {
        let zs = w.layers.zones.as_ref().unwrap();
        assert!(!zs.is_empty(), "{}: no industry", w.id);
        assert_eq!(zs.iter().filter(|z| z.specialty).count(), 1, "{}: one specialty", w.id);
        for z in zs {
            let ind = zones::industry(z.district).unwrap();
            assert_eq!((z.kind, z.tier, z.good), (ind.kind, ind.tier, ind.good));
            assert!(!z.jobs.is_empty() && z.jobs.iter().map(|j| j.share_pm as u32).sum::<u32>() <= 1000, "{}: {}'s jobs", w.id, z.kind);
            for j in z.jobs {
                assert!(j.start_min < 1440 && j.end_min < 1440 && j.start_min != j.end_min && j.share_pm > 0, "{}: {}", z.kind, j.job);
            }
            // its zone buildings stand on its blocks, at its tier
            let zb = sites(w, z.kind);
            assert!(!zb.is_empty(), "{}: no {} building", w.id, z.kind);
            for s in zb {
                assert_eq!(w.layers.blocks[s.block as usize].district, z.district, "{}: {}", w.id, s.id);
                assert!(at_tier(w, s, z.tier), "{}: {} at tier {:?}", w.id, s.id, s.tier);
            }
        }
    }
    // the Commons has its office district, tech campus and film studio
    let ds: BTreeSet<u8> = commons().layers.zones.as_ref().unwrap().iter().map(|z| z.district).collect();
    assert!([district::OFFICE, district::TECH, district::STUDIO].iter().all(|d| ds.contains(d)), "{ds:?}");
    // islands differ in their specialty
    let goods: BTreeSet<&str> = worlds()[1..].iter().map(|w| w.layers.zones.as_ref().unwrap().iter().find(|z| z.specialty).unwrap().good).collect();
    assert!(goods.len() > 1, "every island makes {goods:?}");
}

/// How near a line's path comes to a stop's door, and how near it should: as near as the
/// door's own street (the city street nearest it, any class) plus KERB_SLACK. The path
/// must drive along that street past the door, not just reach a node near it.
fn kerb(r: &Roads, s: &Site, path: &[u32]) -> (i64, i64) {
    let d = transit::door(s);
    let at = |n: u32| (r.nodes[n as usize].x, r.nodes[n as usize].z);
    let near = |a: u32, b: u32| isqrt(nearest_on(d, at(a), at(b)).1);
    let own = r.edges.iter().filter(|e| !is_graded(e.class)).min_by_key(|e| near(e.a, e.b)).unwrap();
    let pass = path.windows(2).map(|q| near(q[0], q[1])).min().unwrap_or(i64::MAX);
    (pass, near(own.a, own.b) + KERB_SLACK)
}

/// 3 m: integer rounding, and a door by a corner, where the crossing street is about as
/// near as its own and the line may turn there instead.
const KERB_SLACK: i64 = 300;

#[test]
fn transit_lines_run_on_the_streets() {
    for w in worlds() {
        let r = &w.layers.roads;
        let lines = &w.layers.transit.as_ref().unwrap().lines;
        let mut between: BTreeMap<(u32, u32), &str> = BTreeMap::new();
        for e in r.edges.iter().filter(|e| !is_graded(e.class)) {
            between.insert((e.a.min(e.b), e.a.max(e.b)), e.class);
        }
        let by_id: BTreeMap<&str, &Site> = w.layers.sites.iter().map(|s| (s.id.as_str(), s)).collect();
        let mut served = BTreeSet::new();
        let buses: Vec<_> = lines.iter().filter(|l| l.kind == "bus").collect();
        let trams: Vec<_> = lines.iter().filter(|l| l.kind == "tram").collect();
        assert!((1..=2).contains(&buses.len()), "{}: {} bus loops", w.id, buses.len());
        assert!((1..=2).contains(&trams.len()), "{}: {} tram lines", w.id, trams.len());
        assert_eq!(buses.len() + trams.len(), lines.len());
        for l in lines {
            assert!(l.path.len() >= 2 && l.stops.len() >= 2, "{}: {} is empty", w.id, l.id);
            for q in l.path.windows(2) {
                let class = between.get(&(q[0].min(q[1]), q[0].max(q[1]))).unwrap_or_else(|| panic!("{}: {} jumps {} -> {}", w.id, l.id, q[0], q[1]));
                assert!(l.kind == "bus" || *class == "arterial", "{}: {} leaves the arterials", w.id, l.id);
            }
            for id in &l.stops {
                let s = by_id.get(id.as_str()).unwrap_or_else(|| panic!("{}: {} calls at {id}, no such site", w.id, l.id));
                let (d, far) = kerb(r, s, &l.path);
                assert!(d <= far, "{}: {} comes no nearer {id} than {} m (kerb {} m)", w.id, l.id, d / 100, far / 100);
                served.insert(id.as_str());
            }
            // (on a personal island a line runs from the tier all its stops and streets exist in: island.rs)
            match l.kind {
                "bus" => {
                    assert!(l.tier == 2 || (w.profile == "island" && l.tier > 2), "{}: {} at tier {}", w.id, l.id, l.tier);
                    assert_eq!(l.stops[0], "transit:0", "{}: {} does not start at the hub", w.id, l.id);
                    assert_eq!(l.path.first(), l.path.last(), "{}: {} is not a loop", w.id, l.id);
                    assert!(l.stops[1..].iter().all(|s| s.starts_with("busstop:")));
                }
                _ => {
                    assert!(l.tier == 4 || (w.profile == "island" && l.tier > 4), "{}: {} at tier {}", w.id, l.id, l.tier);
                    assert!(l.stops.iter().all(|s| s.starts_with("tramstop:")));
                }
            }
        }
        for s in sites(w, "busstop") {
            assert!(served.contains(s.id.as_str()), "{}: no bus calls at {}", w.id, s.id);
        }
    }
}

#[test]
fn the_same_id_is_the_same_city() {
    for id in ["claude-hq@2", ISLAND] {
        let (a, b) = (generate(id, &[]).unwrap(), generate(id, &[]).unwrap());
        assert_eq!(a.hashes, b.hashes);
        assert_eq!(serde_json::to_vec(&a).unwrap(), serde_json::to_vec(&b).unwrap());
        assert!(a.hashes.transit.is_some());
    }
}

/// Version 1 is untouched: the same fingerprint, and none of version 2's fields.
#[test]
fn arena_city_is_unchanged() {
    let w = generate("claude-hq@1", &[]).unwrap();
    assert_eq!(w.hashes.world, CLAUDE_HQ_1);
    assert!(w.layers.zones.is_none() && w.layers.transit.is_none() && w.hashes.transit.is_none());
    let json = String::from_utf8(serde_json::to_vec(&w).unwrap()).unwrap();
    for field in ["\"zones\"", "\"transit\"", "\"view\""] {
        assert!(!json.contains(field), "claude-hq@1 serialises {field}");
    }
}
