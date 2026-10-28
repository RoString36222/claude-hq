//! Tests for the @3 line planners (metro.rs, railway.rs, gondola.rs), on real worlds: the
//! @2 Commons and islands (their roads, lots, sites, terrain, river and coast, the planners
//! run on them here) and the @3 ones (the generator lays the lines itself).

use std::sync::OnceLock;

use super::lines::{dist, length, min_radius, pts, rect, Claim, Ctx, P, MIN_RADIUS_CM};
use super::organic::geom::{inside, nearest_on, seg_dist2};
use super::{generate, gondola, metro, parse_id, profile_for, railway, WorldDoc, VERSION};

const FIXTURE_ISLAND: &str = "user:0b8e4c1a-3f2d-4e5b-9a6c-7d8e9f0a1b2c";
const WORLDS: [&str; 3] = ["claude-hq@2", "user:0b8e4c1a-3f2d-4e5b-9a6c-7d8e9f0a1b2c@2", "user:5f1d2c3b-aaaa-4bbb-8ccc-0123456789ab@2"];

struct Planned {
    m: metro::Metro,
    r: railway::Rail,
    g: gondola::Gondola,
    claims: Vec<Claim>,
}

fn water_of(w: &WorldDoc) -> Vec<Vec<[i64; 2]>> {
    let mut v: Vec<Vec<[i64; 2]>> = w.layers.water.as_ref().map_or(Vec::new(), |x| x.bodies.iter().map(|b| b.poly.clone()).collect());
    v.extend(w.layers.river.iter().map(|r| r.poly.clone()));
    v
}

/// Run the three planners on a world as worldgen does (without applying the claims).
fn plan(w: &WorldDoc) -> Planned {
    let (seed, v) = parse_id(&w.id).unwrap();
    let p = profile_for(seed, v);
    let l = &w.layers;
    let water = water_of(w);
    let c = Ctx {
        seed: super::rng::fnv1a64(seed.as_bytes()),
        profile: &p,
        terrain: &l.terrain,
        roads: &l.roads,
        lots: &l.lots,
        sites: &l.sites,
        river: l.river.as_ref(),
        water: &water,
        coast: l.island.as_ref().map(|i| i.coast.as_slice()),
    };
    let (m, mut claims) = metro::plan(&c).unwrap();
    let (r, rc) = railway::plan(&c, &m, None).unwrap();
    claims.extend(rc);
    let (g, gc) = gondola::plan(&c, &claims).unwrap();
    claims.extend(gc);
    Planned { m, r, g, claims }
}

/// Every world under test, planned once: (doc, its lines, whether the generator laid them).
fn worlds() -> &'static [(WorldDoc, Planned, bool)] {
    static W: OnceLock<Vec<(WorldDoc, Planned, bool)>> = OnceLock::new();
    W.get_or_init(|| {
        let mut out: Vec<(WorldDoc, Planned, bool)> = WORLDS
            .iter()
            .map(|id| {
                let w = generate(id, &[]).unwrap();
                let p = plan(&w);
                (w, p, false)
            })
            .collect();
        if VERSION.contains(&3) {
            for id in ["claude-hq@3".to_string(), format!("{FIXTURE_ISLAND}@3")] {
                let w = generate(&id, &[]).unwrap();
                let l = &w.layers;
                let kinds = ["metro", "metro-entrance", "depot", "rail", "gondola"];
                let claims = l
                    .sites
                    .iter()
                    .filter(|s| kinds.contains(&s.kind))
                    .map(|s| Claim { kind: s.kind, id: s.id.clone(), x: s.x, z: s.z, poly: s.poly.clone().unwrap_or_default(), front: s.front.unwrap_or([0, 0]), tier: s.tier.unwrap_or(0), lot: None })
                    .collect();
                let p = Planned { m: l.metro.clone().expect("@3 has a metro"), r: l.rail.clone().expect("@3 has a railway"), g: l.gondola.clone().expect("@3 has a gondola"), claims };
                out.push((w, p, true));
            }
        }
        out
    })
}

fn wet(w: &WorldDoc, q: P) -> bool {
    if let Some(i) = &w.layers.island {
        if !inside(q, &pts(&i.coast)) {
            return true;
        }
    }
    water_of(w).iter().any(|p| inside(q, &pts(p)))
}

/// Is the footprint off every road's full width (or, `carriage`, off its carriageway)?
fn off_roads(w: &WorldDoc, poly: &[P], carriage: bool) -> bool {
    let n = poly.len();
    w.layers.roads.edges.iter().all(|e| {
        let half = if carriage { e.width / 2 - e.walk } else { e.width / 2 };
        e.points.windows(2).all(|s| {
            let (a, b) = ((s[0][0], s[0][2]), (s[1][0], s[1][2]));
            if n == 1 {
                return nearest_on(poly[0], a, b).1 >= half * half;
            }
            !inside(a, poly) && (0..n).all(|k| seg_dist2(poly[k], poly[(k + 1) % n], a, b) >= half * half)
        })
    })
}

fn on_hq_lot(w: &WorldDoc, poly: &[P]) -> bool {
    w.layers.lots.iter().filter(|l| l.kind == "hq").any(|l| {
        let h = pts(l.poly.as_ref().unwrap());
        super::lines::polys_meet(poly, &h, 0)
    })
}

fn path2(p: &[[i64; 3]]) -> Vec<P> {
    p.iter().map(|q| (q[0], q[2])).collect()
}

/// The path index nearest q.
fn index_of(path: &[P], q: P) -> usize {
    (0..path.len()).min_by_key(|&i| dist(path[i], q)).unwrap()
}

#[test]
fn lines_are_deterministic() {
    let w = generate(WORLDS[0], &[]).unwrap();
    let (a, b) = (plan(&w), plan(&w));
    assert_eq!(serde_json::to_vec(&a.m).unwrap(), serde_json::to_vec(&b.m).unwrap());
    assert_eq!(serde_json::to_vec(&a.r).unwrap(), serde_json::to_vec(&b.r).unwrap());
    assert_eq!(serde_json::to_vec(&a.g).unwrap(), serde_json::to_vec(&b.g).unwrap());
    assert_eq!(a.claims, b.claims);
    // and the generator's own @3 doc is byte-stable
    if VERSION.contains(&3) {
        let (x, y) = (generate("claude-hq@3", &[]).unwrap(), generate("claude-hq@3", &[]).unwrap());
        assert_eq!(x.hashes, y.hashes);
    }
}

#[test]
fn lines_metro_crosses_at_central() {
    for (w, p, _) in worlds() {
        let m = &p.m;
        let ids: Vec<&str> = m.lines.iter().map(|l| l.id.as_str()).collect();
        assert_eq!(ids, ["M1", "M2"], "{}: metro lines", w.id);
        let hub = w.layers.sites.iter().find(|s| s.kind == "transit").unwrap();
        let central: Vec<&metro::Station> = m.stations.iter().filter(|s| s.lines.len() == 2).collect();
        assert_eq!(central.len(), 2, "{}: Central has a record per line", w.id);
        let (a, b) = (central[0], central[1]);
        assert_eq!((a.x, a.z), (b.x, b.z), "{}: the lines cross at one point", w.id);
        assert!(dist((a.x, a.z), super::transit::door(hub)) <= 20_000, "{}: Central is at the hub", w.id);
        let dot = a.along[0] as i128 * b.along[0] as i128 + a.along[1] as i128 * b.along[1] as i128;
        assert!(dot.abs() <= (1i128 << 32) / 50, "{}: Central's platforms cross at right angles ({dot})", w.id);
        assert!(a.y != b.y && a.lines[1] == b.lines[0] && b.lines[1] == a.lines[0], "{}: interchange at two depths", w.id);
        assert!(a.platform == "island" && b.platform == "island");
        for l in &m.lines {
            assert!(l.stations.iter().any(|s| s == &a.id || s == &b.id), "{}: {} calls at Central", w.id, l.id);
        }
    }
}

#[test]
fn lines_metro_stations_spacing_curves_and_depth() {
    for (w, p, _) in worlds() {
        // 4-8 stations a line; a small island whose streets hold no four-station line gets
        // three on it (Central and one each side), never on both lines
        let least = if w.profile == "commons" { 4 } else { 3 };
        assert!(p.m.lines.iter().any(|l| l.stations.len() >= 4), "{}: no four-station line", w.id);
        for l in &p.m.lines {
            let n = l.stations.len();
            assert!((least..=8).contains(&n), "{}: {} has {n} stations", w.id, l.id);
            let path = path2(&l.path);
            assert_eq!(l.kinds.len(), path.len() - 1, "{}: a kind per segment", w.id);
            assert!(min_radius(&path, 1) >= MIN_RADIUS_CM && min_radius(&path, 2) >= MIN_RADIUS_CM, "{}: {} curves under 150 m", w.id, l.id);
            let at: Vec<usize> = l.stations.iter().map(|id| p.m.stations.iter().find(|s| &s.id == id).unwrap()).map(|s| index_of(&path, (s.x, s.z))).collect();
            for k in at.windows(2) {
                let gap = length(&path[k[0].min(k[1])..=k[0].max(k[1])]);
                assert!((45_000..=80_000).contains(&gap), "{}: {} stations {gap} cm apart", w.id, l.id);
            }
            for (i, &k) in l.kinds.iter().enumerate() {
                assert!(["bored", "cutcover", "portal", "open"].contains(&k));
                if k == "bored" || k == "cutcover" {
                    for j in [i, i + 1] {
                        let d = w.layers.terrain.height_at(path[j].0, path[j].1) - l.path[j][1];
                        assert!((1_200..=1_600).contains(&d), "{}: {} rail {d} cm under the ground at {j}", w.id, l.id);
                    }
                }
            }
            assert!(l.kinds.contains(&"portal") && l.kinds.contains(&"open") && l.depot.is_some(), "{}: {} surfaces at a depot", w.id, l.id);
            assert_eq!(p.m.portals.iter().filter(|x| x.line == l.id).count(), 1, "{}: one portal for {}", w.id, l.id);
        }
        for s in &p.m.stations {
            assert_eq!(s.len, 9_000);
            assert!(s.hall_y > s.y, "{}: the hall is over the platforms", w.id);
        }
    }
}

#[test]
fn lines_metro_entrances_holes_portals_and_depots_stand_clear() {
    for (w, p, _) in worlds() {
        let m = &p.m;
        for s in &m.stations {
            let ents: Vec<&metro::Entrance> = s.entrances.iter().map(|id| m.entrances.iter().find(|e| &e.id == id).unwrap()).collect();
            assert!((2..=4).contains(&ents.len()), "{}: {} has {} entrances", w.id, s.id, ents.len());
            assert!(ents.iter().any(|e| e.kind == "lift"), "{}: {} has no lift", w.id, s.id);
        }
        let mut holes = 0;
        for e in &m.entrances {
            let foot = pts(&rect((e.x, e.z), (e.front[0], e.front[1]), e.d + 2, e.w + 2));
            assert!(e.hole.iter().all(|&q| inside((q[0], q[1]), &foot)), "{}: {}'s hole is outside it", w.id, e.id);
            assert!(m.holes.contains(&e.hole));
            assert!(off_roads(w, &foot, false), "{}: {} is on a road", w.id, e.id);
            assert!(!foot.iter().any(|&q| wet(w, q)) && !on_hq_lot(w, &foot), "{}: {} on water or an HQ lot", w.id, e.id);
            holes += 1;
        }
        for x in &m.portals {
            assert!(m.holes.contains(&x.hole), "{}: {}'s hole is not cut", w.id, x.id);
            let h = pts(&x.hole);
            assert!(off_roads(w, &h, false) && !h.iter().any(|&q| wet(w, q)) && !on_hq_lot(w, &h), "{}: {} stands badly", w.id, x.id);
            holes += 1;
        }
        assert_eq!(holes, m.holes.len(), "{}: a hole for each entrance and portal", w.id);
        for d in &m.depots {
            let poly = pts(&d.poly);
            assert!(off_roads(w, &poly, false) && !poly.iter().any(|&q| wet(w, q)) && !on_hq_lot(w, &poly), "{}: {} stands badly", w.id, d.id);
            assert!((3..=4).contains(&d.tracks.len()));
        }
    }
}

#[test]
fn lines_city_line_reaches_the_airport_and_island_link_the_sea() {
    for (w, p, _) in worlds() {
        let r = &p.r;
        let target = ["airport", "port"].iter().find_map(|k| w.layers.sites.iter().find(|s| s.kind == *k));
        if let Some(t) = target {
            let cl = r.lines.iter().find(|l| l.id == "CL").unwrap_or_else(|| panic!("{}: no City Line", w.id));
            assert_eq!(cl.kind, "city");
            let path = path2(&cl.path);
            assert!(min_radius(&path, 1) >= MIN_RADIUS_CM, "{}: CL curves under 150 m", w.id);
            let last = r.stations.iter().find(|s| &s.id == cl.stations.last().unwrap()).unwrap();
            let poly = pts(t.poly.as_ref().unwrap());
            let d = (0..poly.len()).map(|k| nearest_on((last.x, last.z), poly[k], poly[(k + 1) % poly.len()]).1).min().unwrap();
            assert!(inside((last.x, last.z), &poly) || d <= 20_000 * 20_000, "{}: CL ends {} m from the {}", w.id, super::noise::isqrt(d) / 100, t.kind);
            for id in &cl.stations {
                let s = r.stations.iter().find(|s| &s.id == id).unwrap();
                assert!(s.kind == "elevated" && (2..=4).contains(&s.stairs.len()), "{}: {} stairs", w.id, s.id);
                for f in &s.stairs {
                    assert!(off_roads(w, &[(f[0], f[1])], true) && !wet(w, (f[0], f[1])), "{}: {}'s stairs on a carriageway", w.id, s.id);
                }
            }
        }
        if let Some(i) = &w.layers.island {
            let il = r.lines.iter().find(|l| l.id == "IL").unwrap_or_else(|| panic!("{}: no Island Link", w.id));
            let sea = r.sea.unwrap_or_else(|| panic!("{}: no sea abutment", w.id));
            let last = il.path.last().unwrap();
            assert_eq!((last[0], last[2]), (sea.x, sea.z), "{}: IL ends at the abutment", w.id);
            let c = pts(&i.coast);
            let to_coast = (0..c.len()).map(|k| nearest_on((sea.x, sea.z), c[k], c[(k + 1) % c.len()]).1).min().unwrap();
            assert!(to_coast <= 1_000 * 1_000, "{}: the abutment is not on the coast", w.id);
            let st = r.stations.iter().find(|s| s.id == il.stations[0]).unwrap();
            let want = if w.profile == "commons" { ("terminal", 6) } else { ("underground", 2) };
            assert_eq!((st.kind, st.platforms), want, "{}: IL station", w.id);
            let deepest_metro = p.m.stations.iter().filter(|s| s.lines.len() == 2).map(|s| s.y).min().unwrap();
            assert!(st.y < deepest_metro, "{}: IL platforms under the metro", w.id);
            assert!(il.kinds.contains(&"tunnel") && il.kinds.contains(&"portal"));
            assert!(!r.holes.is_empty() && r.holes.iter().all(|h| off_roads(w, &pts(h), false) && !on_hq_lot(w, &pts(h))), "{}: IL portal hole", w.id);
        }
    }
}

#[test]
fn lines_gondola_clears_the_ground() {
    for (w, p, _) in worlds() {
        let g = &p.g;
        assert_eq!(g.lines.len(), 1, "{}: one gondola", w.id);
        let l = &g.lines[0];
        assert!(["summit", "crossing"].contains(&l.kind));
        let (a, b) = (&l.stations[0], &l.stations[1]);
        let mut sup: Vec<(P, i64)> = vec![((a.x, a.z), a.y)];
        sup.extend(l.towers.iter().map(|t| ((t.x, t.z), t.y + t.h)));
        sup.push(((b.x, b.z), b.y));
        let sea = w.layers.island.as_ref().map_or(0, |i| i.sea_cm);
        for s in sup.windows(2) {
            let ((p0, y0), (p1, y1)) = (s[0], s[1]);
            let span = dist(p0, p1);
            assert!(span <= gondola::SPAN_MAX_CM, "{}: a {span} cm span", w.id);
            let sag = span * gondola::SAG_PM / 1000;
            for k in 0..=100 {
                let q = (p0.0 + (p1.0 - p0.0) * k / 100, p0.1 + (p1.1 - p0.1) * k / 100);
                let y = y0 + (y1 - y0) * k / 100 - 4 * sag * k * (100 - k) / 10_000;
                let mut ground = w.layers.terrain.height_at(q.0, q.1);
                if wet(w, q) {
                    ground = ground.max(sea);
                }
                assert!(y - ground >= gondola::CLEAR_CM - 5, "{}: the cable is {} cm over the ground", w.id, y - ground);
            }
        }
        for t in &l.towers {
            let q = (t.x, t.z);
            assert!(off_roads(w, &[q], false) && !wet(w, q) && !w.layers.lots.iter().any(|lot| inside(q, &pts(lot.poly.as_ref().unwrap()))), "{}: a tower stands badly", w.id);
        }
    }
}

#[test]
fn lines_claims_never_take_an_hq_lot_or_a_road() {
    for (w, p, generated) in worlds() {
        let mut ids: Vec<&str> = p.claims.iter().map(|c| c.id.as_str()).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), p.claims.len(), "{}: claim ids repeat", w.id);
        for c in &p.claims {
            let poly = pts(&c.poly);
            assert!(!poly.is_empty() && !on_hq_lot(w, &poly), "{}: {} takes an HQ lot", w.id, c.id);
            assert!(off_roads(w, &poly, false), "{}: {} is on a road", w.id, c.id);
            if !generated {
                if let Some(id) = c.lot {
                    let lot = w.layers.lots.iter().find(|l| l.id == id).unwrap();
                    assert_ne!(lot.kind, "hq");
                }
            }
        }
        if *generated {
            let (seed, v) = parse_id(&w.id).unwrap();
            assert_eq!(w.layers.lots.iter().filter(|l| l.kind == "hq").count() as i64, profile_for(seed, v).hq_lots, "{}: HQ lots kept", w.id);
        }
    }
}

/// Sizes of the layers (bytes of JSON), for the report.
#[test]
fn lines_layer_sizes() {
    for (w, p, _) in worlds() {
        eprintln!(
            "{}: metro {} B, rail {} B, gondola {} B, {} claims",
            w.id,
            serde_json::to_vec(&p.m).unwrap().len(),
            serde_json::to_vec(&p.r).unwrap().len(),
            serde_json::to_vec(&p.g).unwrap().len(),
            p.claims.len()
        );
    }
}
