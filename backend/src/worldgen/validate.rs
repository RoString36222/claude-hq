//! The world validator (City Gen v4): checks a generated world's layers against the
//! plan's rules and lists every place one is broken. Phase 1 holds the airport's claim
//! (claims.rs) as a hard rule: no road, track, cable, pier, lake, block, lot or other
//! site in it. The rest are listed, not yet enforced, so each later phase can see what it
//! must fix and then make its own rules hard:
//!
//!   airport        (hard) anything but the airport in the airport's claim (water only
//!                  where the airport must be dry: not its landside pieces), and anything
//!                  but the ring road in its corridor behind the terminal
//!   airport-water  the airport's landside (forecourt, car park, tower) over water
//!   site-overlap   two sites' footprints overlap
//!   lot-site       a lot and a site overlap
//!   road-site      a road's carriageway runs through a site (stops and entrances, which
//!                  stand on the pavement by design, excepted)
//!   road-water     a road that is no bridge runs over a lake, canal or the marina
//!   class-width    (hard, phase 2) a v4 road whose carriageway, lanes or median are not
//!                  its class's, or whose footpaths are narrower (a lane at its layout
//!                  width excepted; a street a tram runs down has no median until phase 8)
//!   class-step     (hard, phase 2) where a town road runs on through a bend (a node of
//!                  two roads), its two sides more than one class apart; where a highway
//!                  or the ring is one of them, listed (`class-step-graded`) for the
//!                  junction and interchange phases
//!
//! `cargo run --release --bin worldgen -- <id> --validate` prints the report.

use std::collections::BTreeMap;

use super::claims::Airport;
use super::organic::geom::{inside, seg_dist2, P};
use super::Layers;

/// One broken rule.
#[derive(Clone, Debug)]
pub struct Violation {
    pub rule: &'static str,
    /// A hard rule fails the world; the others are listed for the phases to come.
    pub hard: bool,
    /// What broke it, e.g. "road 412 Ring Road 5".
    pub what: String,
    /// Where (cm).
    pub at: [i64; 2],
}

/// Every rule a world breaks.
pub fn check(l: &Layers) -> Vec<Violation> {
    let mut out = Vec::new();
    if let Some(a) = Airport::of(&l.sites) {
        airport(l, &a, &mut out);
    }
    overlaps(l, &mut out);
    classes(l, &mut out);
    out
}

fn classes(l: &Layers, out: &mut Vec<Violation>) {
    use super::classes::{class, one_step};
    let mut at: BTreeMap<u32, Vec<&super::roads::Edge>> = BTreeMap::new();
    let mut tram = std::collections::BTreeSet::new();
    for line in l.transit.iter().flat_map(|t| &t.lines).filter(|x| x.kind == "tram") {
        for w in line.path.windows(2) {
            tram.insert((w[0].min(w[1]), w[0].max(w[1])));
        }
    }
    for e in &l.roads.edges {
        let Some(name) = e.v4 else { continue };
        let median = if tram.contains(&(e.a.min(e.b), e.a.max(e.b))) { e.median.or(class(name).map(|c| c.median_cm).filter(|&m| m > 0)) } else { e.median };
        let p = e.points.first().map_or([0, 0], |q| [q[0], q[2]]);
        let ok = class(name).is_some_and(|c| {
            let carriageway = e.width - 2 * e.walk - median.unwrap_or(0);
            // (a class with no footpaths has shoulders: its whole width, no walk)
            let width = if c.walk { (carriageway == c.carriageway_cm() && e.walk >= c.side_cm) || (name == "lane" && e.width < c.total_cm) } else { e.width == c.total_cm && e.walk == 0 };
            width && e.lanes == c.lanes && median.unwrap_or(0) == c.median_cm
        });
        if !ok {
            out.push(Violation { rule: "class-width", hard: true, what: format!("road {} {} ({name}, {} cm)", e.id, e.name, e.width), at: p });
        }
        at.entry(e.a).or_default().push(e);
        at.entry(e.b).or_default().push(e);
    }
    let deg: BTreeMap<u32, usize> = l.roads.edges.iter().flat_map(|e| [e.a, e.b]).fold(BTreeMap::new(), |mut m, n| {
        *m.entry(n).or_default() += 1;
        m
    });
    for (n, es) in &at {
        if deg.get(n) == Some(&2) && es.len() == 2 && !one_step(es[0].v4.unwrap(), es[1].v4.unwrap()) {
            let q = &l.roads.nodes[*n as usize];
            let graded = es.iter().any(|e| super::roads::is_graded(e.class));
            let rule = if graded { "class-step-graded" } else { "class-step" };
            out.push(Violation { rule, hard: !graded, what: format!("{} ({}) runs on as {} ({})", es[0].name, es[0].v4.unwrap(), es[1].name, es[1].v4.unwrap()), at: [q.x, q.z] });
        }
    }
}

/// The hard rules a world breaks.
pub fn hard(l: &Layers) -> Vec<Violation> {
    check(l).into_iter().filter(|v| v.hard).collect()
}

/// A count per rule, and the first few of each: the report.
pub fn report(v: &[Violation]) -> String {
    let mut by: BTreeMap<&str, Vec<&Violation>> = BTreeMap::new();
    for x in v {
        by.entry(x.rule).or_default().push(x);
    }
    if by.is_empty() {
        return "  clean: no rule broken\n".to_string();
    }
    let mut s = String::new();
    for (rule, xs) in by {
        let tag = if xs[0].hard { "HARD" } else { "list" };
        s += &format!("  {rule:<13} {tag}  {}\n", xs.len());
        for x in xs.iter().take(6) {
            s += &format!("      {} at ({}, {}) m\n", x.what, x.at[0] / 100, x.at[1] / 100);
        }
        if xs.len() > 6 {
            s += &format!("      ... and {} more\n", xs.len() - 6);
        }
    }
    s
}

fn pts(p: &[[i64; 2]]) -> Vec<P> {
    p.iter().map(|q| (q[0], q[1])).collect()
}

/// A rectangle `len` along the Q16 unit `f` from `c` (centred) and `w` across.
fn quad(c: P, f: [i64; 2], len: i64, w: i64) -> Vec<P> {
    let one = super::noise::ONE;
    let (fx, fz) = (f[0], f[1]);
    let at = |a: i64, b: i64| (c.0 + (a * fx - b * fz) / one, c.1 + (a * fz + b * fx) / one);
    vec![at(-len / 2, -w / 2), at(len / 2, -w / 2), at(len / 2, w / 2), at(-len / 2, w / 2)]
}

fn airport(l: &Layers, a: &Airport, out: &mut Vec<Violation>) {
    let mut wet = Vec::new();
    let mut put = |what: String, at: P| out.push(Violation { rule: "airport", hard: true, what, at: [at.0, at.1] });
    for e in &l.roads.edges {
        let ring = e.class == "ring";
        if let Some(s) = e.points.windows(2).find(|s| {
            let (p, q) = ((s[0][0], s[0][2]), (s[1][0], s[1][2]));
            a.meets_seg(p, q, e.width / 2) || (!ring && a.in_corridor(p, q, e.width / 2))
        }) {
            put(format!("road {} {} ({})", e.id, e.name, e.class), (s[0][0], s[0][2]));
        }
    }
    // track: underground anywhere (a tunnel, or 3 m of ground over the rails, whatever the
    // segment is called); over the landside and the corridor (an airport station's viaduct
    // at the kerb) only up in the air; on or over the airside and the runway's zones, never
    let landside: Vec<Vec<P>> = a.polys[..a.landside].iter().cloned().chain([a.corridor.clone()]).collect();
    let (landside, air) = (&landside[..], &a.polys[a.landside..]);
    let buried = |p: [i64; 3], q: [i64; 3]| {
        let m = ((p[0] + q[0]) / 2, (p[2] + q[2]) / 2);
        l.terrain.height_at(m.0, m.1) - (p[1] + q[1]) / 2 >= 300
    };
    let track = |path: &[[i64; 3]], kinds: &[&str], under: &[&str]| {
        (0..path.len().saturating_sub(1))
            .find(|&k| {
                let kind = kinds.get(k).copied().unwrap_or("");
                if buried(path[k], path[k + 1]) {
                    return false;
                }
                let s = [(path[k][0], path[k][2]), (path[k + 1][0], path[k + 1][2])];
                let meets = |ps: &[Vec<P>]| ps.iter().any(|p| Airport::polys_meet(p, &s, 400));
                !under.contains(&kind) && (meets(air) || (meets(landside) && !matches!(kind, "viaduct" | "bridge")))
            })
            .map(|k| (path[k][0], path[k][2]))
    };
    if let Some(r) = &l.rail {
        for line in &r.lines {
            if let Some(q) = track(&line.path, &line.kinds, &["tunnel"]) {
                put(format!("rail {}", line.id), q);
            }
        }
    }
    if let Some(m) = &l.metro {
        for line in &m.lines {
            if let Some(q) = track(&line.path, &line.kinds, &["bored", "cutcover"]) {
                put(format!("metro {}", line.id), q);
            }
        }
    }
    if let Some(g) = &l.gondola {
        for line in &g.lines {
            // the stations and towers, and the cable between them
            let mut stops: Vec<P> = line.stations.iter().map(|s| (s.x, s.z)).collect();
            stops.splice(1..1, line.towers.iter().map(|t| (t.x, t.z)));
            if let Some(s) = stops.windows(2).find(|s| a.meets_seg(s[0], s[1], 0)) {
                put(format!("gondola {}", line.id), s[0]);
            }
        }
    }
    if let Some(w) = &l.water {
        for p in &w.piers {
            if a.meets_poly(&quad((p.x, p.z), p.front, p.len, p.w), 0) {
                put(format!("pier {}", p.id), (p.x, p.z));
            }
        }
        for b in &w.bodies {
            let q = pts(&b.poly);
            if a.polys[a.landside..].iter().any(|p| Airport::polys_meet(p, &q, 0)) {
                put(format!("water {}", b.id), (b.poly[0][0], b.poly[0][1]));
            } else if a.polys[..a.landside].iter().any(|p| Airport::polys_meet(p, &q, 0)) {
                wet.push(Violation { rule: "airport-water", hard: false, what: format!("the landside over {}", b.id), at: [b.poly[0][0], b.poly[0][1]] });
            }
        }
    }
    let held = |p: &[P]| a.meets_poly(p, 0) || Airport::polys_meet(p, &a.corridor, 0);
    for b in &l.blocks {
        if b.poly.as_ref().is_some_and(|p| held(&pts(p))) {
            put(format!("block {}", b.id), (b.x, b.z));
        }
    }
    for t in &l.lots {
        if t.poly.as_ref().is_some_and(|p| held(&pts(p))) {
            put(format!("lot {}", t.id), (t.x, t.z));
        }
    }
    for s in l.sites.iter().filter(|s| s.id != a.site) {
        if s.poly.as_ref().is_some_and(|p| held(&pts(p))) {
            put(format!("site {}", s.id), (s.x, s.z));
        }
    }
    out.extend(wet);
}

/// Do two polygons overlap (not just touch)?
fn overlap(p: &[P], q: &[P]) -> bool {
    let (n, m) = (p.len(), q.len());
    let crossing = (0..n).any(|i| (0..m).any(|j| crosses(p[i], p[(i + 1) % n], q[j], q[(j + 1) % m])));
    crossing || p.iter().any(|&a| inside(a, q) && !on_edge(a, q)) || q.iter().any(|&a| inside(a, p) && !on_edge(a, p))
}

/// Do segments ab and cd cross properly (each strictly either side of the other)?
fn crosses(a: P, b: P, c: P, d: P) -> bool {
    let o = |p: P, q: P, r: P| ((q.0 - p.0) as i128 * (r.1 - p.1) as i128 - (q.1 - p.1) as i128 * (r.0 - p.0) as i128).signum();
    o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0
}

fn on_edge(a: P, q: &[P]) -> bool {
    (0..q.len()).any(|k| seg_dist2(a, a, q[k], q[(k + 1) % q.len()]) == 0)
}

fn bbox(p: &[P]) -> (i64, i64, i64, i64) {
    p.iter().fold((i64::MAX, i64::MIN, i64::MAX, i64::MIN), |b, q| (b.0.min(q.0), b.1.max(q.0), b.2.min(q.1), b.3.max(q.1)))
}

fn boxes_meet(a: (i64, i64, i64, i64), b: (i64, i64, i64, i64), m: i64) -> bool {
    a.0 <= b.1 + m && b.0 <= a.1 + m && a.2 <= b.3 + m && b.2 <= a.3 + m
}

/// Sites that stand on the street or pavement by design.
const ON_STREET: [&str; 4] = ["busstop", "tramstop", "metro-entrance", "spawn"];

fn overlaps(l: &Layers, out: &mut Vec<Violation>) {
    let sites: Vec<(&super::city::Site, Vec<P>)> = l.sites.iter().filter_map(|s| s.poly.as_ref().map(|p| (s, pts(p)))).collect();
    let sbox: Vec<_> = sites.iter().map(|(_, p)| bbox(p)).collect();
    for i in 0..sites.len() {
        for j in i + 1..sites.len() {
            if boxes_meet(sbox[i], sbox[j], 0) && overlap(&sites[i].1, &sites[j].1) {
                let (a, b) = (sites[i].0, sites[j].0);
                out.push(Violation { rule: "site-overlap", hard: false, what: format!("{} and {}", a.id, b.id), at: [a.x, a.z] });
            }
        }
    }
    for t in &l.lots {
        let Some(p) = t.poly.as_ref().map(|p| pts(p)) else { continue };
        let b = bbox(&p);
        for (k, (s, q)) in sites.iter().enumerate() {
            if boxes_meet(b, sbox[k], 0) && overlap(&p, q) {
                out.push(Violation { rule: "lot-site", hard: false, what: format!("lot {} and {}", t.id, s.id), at: [t.x, t.z] });
            }
        }
    }
    for e in &l.roads.edges {
        let segs: Vec<(P, P)> = e.points.windows(2).map(|s| ((s[0][0], s[0][2]), (s[1][0], s[1][2]))).collect();
        let half = (e.width - 2 * e.walk).max(e.width / 2) / 2;
        let ebox = bbox(&e.points.iter().map(|q| (q[0], q[2])).collect::<Vec<P>>());
        for (k, (s, q)) in sites.iter().enumerate() {
            if ON_STREET.contains(&s.kind) || !boxes_meet(ebox, sbox[k], half) {
                continue;
            }
            if let Some(&(a, _)) = segs.iter().find(|&&(a, b)| inside(a, q) || inside(b, q) || (0..q.len()).any(|i| seg_dist2(a, b, q[i], q[(i + 1) % q.len()]) < half * half)) {
                out.push(Violation { rule: "road-site", hard: false, what: format!("road {} {} through {}", e.id, e.name, s.id), at: [a.0, a.1] });
            }
        }
        if e.bridge == Some(true) {
            continue;
        }
        if let Some(w) = &l.water {
            for b in &w.bodies {
                let q = pts(&b.poly);
                if let Some(&(a, _)) = segs.iter().find(|&&(a, _)| inside(a, &q)) {
                    out.push(Violation { rule: "road-water", hard: false, what: format!("road {} {} over {}", e.id, e.name, b.id), at: [a.0, a.1] });
                }
            }
        }
    }
}
