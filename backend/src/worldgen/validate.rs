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
//!                  width excepted; a street a tram runs down off its own tram street has no median; a tram
//!                  street's tram version (phase 9): its raised centre bed, the median and the tram's
//!                  width, or its lanes, the tram in them)
//!   junction       (hard, phase 3) a junction of town roads without the control its roads
//!                  call for (roads.rs `junction_kinds`: give way, a mini or full roundabout,
//!                  signals), or a full roundabout without room on every arm
//!   bend           (phase 4) a town street still turning over 20 degrees where it runs on
//!                  through a bend (its arc kept within the kerb's 25 cm: a sharp corner)
//!   curve          (phase 4) a curve on a v4 road tighter than its class's design speed
//!                  allows (classes.rs `min_radius_cm`), measured over three points 2 m+ apart
//!   class-step     (hard, phase 2) where a town road runs on through a bend (a node of
//!                  two roads), its two sides more than one class apart; where a highway
//!                  or the ring is one of them, listed (`class-step-graded`) for the
//!                  junction and interchange phases
//!   ramps          (hard, phase 6) an interchange's ramp that is not one way, or a node
//!                  where its ramps meet without as many of the traffic sim's lanes in as
//!                  out (interchange.rs `sim_lanes`)
//!   deck-grade     (hard, phase 6) a flyover or ramp steeper than 6 % over any 8 m
//!   tunnel         (hard, phase 7) a road tunnel less than 6.5 m under the land over it, a
//!                  cutting steeper than 6 %, or a metro or rail track within 4 m of either
//!                  (in plan, past the road's half width) and 8 m of its level (a bored
//!                  tunnel's crown 5 m over the rails, its slab 1 m under the road: 2 m between)
//!   rail-pier      (hard, phase 8) a viaduct's pier (railway.rs `piers`) on a carriageway, a
//!                  footpath, a lot, a site or the water, i.e. not in a boulevard's median
//!                  (its column 0.25 m inside it) nor on clear ground; one on clear ground
//!                  away from its line's stations (the elevated line runs only along a
//!                  boulevard, but where it leaves Central over the hub or reaches the
//!                  airport over its landside); or a span longer than a crossing's 60 m
//!   rail-corridor  (phase 8) a City Line with no boulevard under it (corridor.rs could not
//!                  cut one: an HQ's lot, a civic site or a graded road in its way), its
//!                  piers then the client's own
//!   tram           (hard, phase 9) on a world with tram streets: a tram line on a road that is
//!                  not a tram version (`Edge::tram`), a station's 40 m by 3 m platform not
//!                  on a straight run of its track (within 1 m of the chord) clear of every
//!                  junction's box (the widest road crossing it, and 3 m), or a line whose track
//!                  ends mid-block: not at a junction, its street's end or one of its stations
//!   tram-station   (phase 9) a tram stop with no room on its line for a 40 m platform (side
//!                  streets every 24 to 48 m), left at the kerb as before
//!   clearance      (hard, phase 6) a flyover or ramp crossing a road it does not meet
//!                  less than 7 m over it (5.5 m clear and its deck), or a road crossing
//!                  another at grade with no junction (listed: `road-overlap`)
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
    junctions(l, &mut out);
    curves(l, &mut out);
    decks(l, &mut out);
    tunnels(l, &mut out);
    piers(l, &mut out);
    trams(l, &mut out);
    out
}

/// Phase 9: the tram lines' roads, stations and ends.
fn trams(l: &Layers, out: &mut Vec<Violation>) {
    use super::transit::{track, PLATFORM_BOW_CM, PLATFORM_JUNCTION_CM, PLATFORM_LEN_CM, PLATFORM_W_CM};
    let r = &l.roads;
    if !r.edges.iter().any(|e| e.tram.is_some()) {
        return;
    }
    let Some(t) = l.transit.as_ref() else { return };
    let mut deg: BTreeMap<u32, usize> = BTreeMap::new();
    for e in &r.edges {
        *deg.entry(e.a).or_default() += 1;
        *deg.entry(e.b).or_default() += 1;
    }
    let junction = |n: u32| deg.get(&n).copied().unwrap_or(0) >= 3;
    let node = |n: u32| r.nodes.get(n as usize).map_or((0, 0), |q| (q.x, q.z));
    let mut soft = Vec::new();
    for line in t.lines.iter().filter(|x| x.kind == "tram") {
        let mut put = |what: String, at: P| out.push(Violation { rule: "tram", hard: true, what: format!("{}: {what}", line.id), at: [at.0, at.1] });
        for w in line.path.windows(2) {
            if !r.edges.iter().any(|e| ((e.a == w[0] && e.b == w[1]) || (e.a == w[1] && e.b == w[0])) && e.tram.is_some()) {
                put(format!("runs off its tram street between nodes {} and {}", w[0], w[1]), node(w[0]));
            }
        }
        let (pts, _) = track(r, &line.path);
        let stations: Vec<&super::city::Site> = l.sites.iter().filter(|s| line.stops.contains(&s.id)).collect();
        for s in &stations {
            let c = (s.x, s.z);
            let f = s.front.unwrap_or([0, 0]);
            let u = (-f[1], f[0]);
            let ends = ((c.0 + u.0 * s.w / 2 / 65_536, c.1 + u.1 * s.w / 2 / 65_536), (c.0 - u.0 * s.w / 2 / 65_536, c.1 - u.1 * s.w / 2 / 65_536));
            if s.w != PLATFORM_LEN_CM || s.d != PLATFORM_W_CM {
                soft.push(Violation { rule: "tram-station", hard: false, what: format!("{}: {} is a stop at the kerb, no room for a platform", line.id, s.id), at: [c.0, c.1] });
                continue;
            }
            // straight: its track beside it within the bow of the platform's axis
            let chord = super::lines::dist(ends.0, ends.1).max(1);
            let near: Vec<P> = pts.iter().copied().filter(|&q| seg_dist2(q, q, ends.0, ends.1) < 1_500 * 1_500).collect();
            let bent = near.iter().any(|&q| {
                let cross = ((q.0 - ends.0 .0) as i128 * (ends.1 .1 - ends.0 .1) as i128 - (q.1 - ends.0 .1) as i128 * (ends.1 .0 - ends.0 .0) as i128).abs() / chord as i128;
                let along = ((q.0 - ends.0 .0) as i128 * (ends.1 .0 - ends.0 .0) as i128 + (q.1 - ends.0 .1) as i128 * (ends.1 .1 - ends.0 .1) as i128) / chord as i128;
                along > 0 && along < chord as i128 && (cross - near_off(&near, ends)).abs() > PLATFORM_BOW_CM as i128 + 50
            });
            if bent {
                put(format!("{} on a bend", s.id), c);
            }
            for (&n, _) in deg.iter().filter(|x| *x.1 >= 3) {
                let reach = r.edges.iter().filter(|e| (e.a == n || e.b == n) && e.tram.is_none()).map(|e| e.width / 2).max().unwrap_or(0) + PLATFORM_JUNCTION_CM - 100;
                if r.edges.iter().any(|e| (e.a == n || e.b == n) && e.tram.is_some()) && seg_dist2(node(n), node(n), ends.0, ends.1) < reach * reach {
                    put(format!("{} in junction {n}'s box", s.id), c);
                }
            }
        }
        // its track ends at a junction or one of its stations
        for &n in [line.path.first(), line.path.last()].into_iter().flatten() {
            let q = node(n);
            if !junction(n) && deg.get(&n) != Some(&1) && !stations.iter().any(|s| super::lines::dist((s.x, s.z), q) <= s.w / 2 + 3_000) {
                put(format!("its track ends mid-block at node {n}"), q);
            }
        }
    }
    out.extend(soft);
}

/// The track's usual distance (cm) from a platform's axis (an island 0, a kerb's platform
/// beside it), from the points near it: the median of their offsets.
fn near_off(near: &[P], ends: (P, P)) -> i128 {
    let chord = super::lines::dist(ends.0, ends.1).max(1) as i128;
    let mut offs: Vec<i128> = near
        .iter()
        .map(|q| ((q.0 - ends.0 .0) as i128 * (ends.1 .1 - ends.0 .1) as i128 - (q.1 - ends.0 .1) as i128 * (ends.1 .0 - ends.0 .0) as i128).abs() / chord)
        .collect();
    offs.sort();
    offs.get(offs.len() / 2).copied().unwrap_or(0)
}

/// Phase 8: the viaducts' piers, where they stand and how far apart.
fn piers(l: &Layers, out: &mut Vec<Violation>) {
    use super::railway::{pier_at, SPAN_LONG_CM};
    let Some(rail) = l.rail.as_ref() else { return };
    let wet = |q: P| {
        l.river.as_ref().is_some_and(|r| r.wet(q))
            || l.water.as_ref().is_some_and(|w| w.bodies.iter().any(|b| inside(q, &b.poly.iter().map(|a| (a[0], a[1])).collect::<Vec<P>>())))
    };
    for line in rail.lines.iter().filter(|x| x.kind == "city" && x.piers.is_empty()) {
        let at = line.path.first().map_or([0, 0], |q| [q[0], q[2]]);
        out.push(Violation { rule: "rail-corridor", hard: false, what: format!("{}: no boulevard under it", line.id), at });
    }
    for line in rail.lines.iter().filter(|x| !x.piers.is_empty()) {
        let stations: Vec<&super::railway::Station> = rail.stations.iter().filter(|s| line.stations.contains(&s.id)).collect();
        for (k, p) in line.piers.iter().enumerate() {
            let q = (p.x, p.z);
            let at = [p.x, p.z];
            // (off the boulevard only by a station, or bridging water: within 40 m of it)
            const DIRS: [(i64, i64); 8] = [(10, 0), (7, 7), (0, 10), (-7, 7), (-10, 0), (-7, -7), (0, -10), (7, -7)];
            let by_water = wet(q) || (1..=4).any(|r: i64| DIRS.iter().any(|d| wet((q.0 + d.0 * r * 1_000 / 10, q.1 + d.1 * r * 1_000 / 10))));
            match pier_at(&l.roads, &l.lots, &l.sites, q) {
                None => out.push(Violation { rule: "rail-pier", hard: true, what: format!("{} pier {k}: on a road, lot or site", line.id), at }),
                Some(false) if !by_water && !stations.iter().any(|s| super::lines::dist((s.x, s.z), q) <= s.len / 2 + 3_000) => {
                    out.push(Violation { rule: "rail-pier", hard: true, what: format!("{} pier {k}: off the boulevard, away from a station", line.id), at })
                }
                _ => {}
            }
            if let Some(n) = line.piers.get(k + 1) {
                if super::lines::dist(q, (n.x, n.z)) > SPAN_LONG_CM + 100 {
                    out.push(Violation { rule: "rail-pier", hard: true, what: format!("{} span {k}: longer than 60 m", line.id), at });
                }
            }
        }
    }
}

/// Phase 7: the road tunnels' depth, their cuttings' grade, and the metro and rail kept off them.
fn tunnels(l: &Layers, out: &mut Vec<Violation>) {
    use super::tunnels::{DEPTH_CM, MAX_PM};
    let unders: Vec<&super::roads::Edge> = l.roads.edges.iter().filter(|e| e.under.is_some()).collect();
    for e in &unders {
        let at = [e.points[0][0], e.points[0][2]];
        if e.under == Some("tunnel") && e.points.iter().any(|q| l.terrain.height_at(q[0], q[2]) - q[1] < DEPTH_CM - 50) {
            out.push(Violation { rule: "tunnel", hard: true, what: format!("road {} {}: too shallow", e.id, e.name), at });
        }
        let rise = (e.points[0][1] - e.points[e.points.len() - 1][1]).abs();
        if rise * 1000 > (MAX_PM + 2) * super::roads::path_len(&e.points) {
            out.push(Violation { rule: "tunnel", hard: true, what: format!("road {} {}: steeper than 6 %", e.id, e.name), at });
        }
    }
    let tracks = l.metro.iter().flat_map(|m| m.lines.iter().map(|x| &x.path)).chain(l.rail.iter().flat_map(|r| r.lines.iter().map(|x| &x.path)));
    for path in tracks {
        for q in path.iter() {
            if let Some(e) = unders.iter().find(|e| {
                let r = e.width / 2 + 400;
                e.points.windows(2).any(|w| seg_dist2((w[0][0], w[0][2]), (w[1][0], w[1][2]), (q[0], q[2]), (q[0], q[2])) < r * r && ((w[0][1] + w[1][1]) / 2 - q[1]).abs() < 800)
            }) {
                out.push(Violation { rule: "tunnel", hard: true, what: format!("a track meets road {} {}", e.id, e.name), at: [q[0], q[2]] });
                break;
            }
        }
    }
}

/// Phase 6: the interchanges' ramps, their grades and the clearance under every deck.
fn decks(l: &Layers, out: &mut Vec<Violation>) {
    use super::interchange::{sim_lanes, LIFT_CM, MAX_PM};
    use super::roads::deck_road;
    let r = &l.roads;
    let at = |n: u32| r.nodes.get(n as usize).map_or([0, 0], |q| [q.x, q.z]);
    // lanes in and out at every node a ramp or flyover meets
    let mut flow: BTreeMap<u32, (i64, i64, bool)> = BTreeMap::new();
    for e in &r.edges {
        let k = sim_lanes(e);
        let one = e.oneway == Some(true);
        if e.v4 == Some("ramp") && !one {
            out.push(Violation { rule: "ramps", hard: true, what: format!("road {} {} runs both ways", e.id, e.name), at: at(e.a) });
        }
        let d = deck_road(e);
        let fa = flow.entry(e.a).or_insert((0, 0, false));
        *fa = (fa.0 + if one { 0 } else { k }, fa.1 + k, fa.2 || d);
        let fb = flow.entry(e.b).or_insert((0, 0, false));
        *fb = (fb.0 + k, fb.1 + if one { 0 } else { k }, fb.2 || d);
    }
    for (n, (i, o, d)) in flow {
        if d && i != o {
            out.push(Violation { rule: "ramps", hard: true, what: format!("node {n}: {i} lanes in, {o} out"), at: at(n) });
        }
    }
    // grades over 8 m or more of road (along it)
    for e in r.edges.iter().filter(|e| deck_road(e)) {
        let p = &e.points;
        let (mut j, mut run) = (0, 0);
        for i in 1..p.len() {
            run += super::noise::isqrt((p[i][0] - p[i - 1][0]).pow(2) + (p[i][2] - p[i - 1][2]).pow(2));
            if run < 800 {
                continue;
            }
            if (p[i][1] - p[j][1]).abs() * 1000 > (MAX_PM + 2) * run {
                out.push(Violation { rule: "deck-grade", hard: true, what: format!("road {} {}: {} per mille", e.id, e.name, (p[i][1] - p[j][1]).abs() * 1000 / run), at: [p[i][0], p[i][2]] });
                break;
            }
            (j, run) = (i, 0);
        }
    }
    // crossings: two roads that meet at no node whose carriageways overlap
    let segs: Vec<(usize, [i64; 3], [i64; 3], i64)> = r.edges.iter().enumerate().flat_map(|(k, e)| e.points.windows(2).map(move |w| (k, w[0], w[1], (e.width / 2 - e.walk).max(100)))).collect();
    let mut grid: BTreeMap<(i64, i64), Vec<usize>> = BTreeMap::new();
    const CELL: i64 = 4_000;
    for (s, (_, a, b, _)) in segs.iter().enumerate() {
        for gx in a[0].min(b[0]).div_euclid(CELL) - 1..=a[0].max(b[0]).div_euclid(CELL) + 1 {
            for gz in a[2].min(b[2]).div_euclid(CELL) - 1..=a[2].max(b[2]).div_euclid(CELL) + 1 {
                grid.entry((gx, gz)).or_default().push(s);
            }
        }
    }
    let meet = |x: &super::roads::Edge, y: &super::roads::Edge| x.a == y.a || x.a == y.b || x.b == y.a || x.b == y.b;
    let mut seen = std::collections::BTreeSet::new();
    for cell in grid.values() {
        for (i, &s) in cell.iter().enumerate() {
            for &t in &cell[i + 1..] {
                let ((ka, a0, a1, ha), (kb, b0, b1, hb)) = (segs[s], segs[t]);
                if ka == kb || seen.contains(&(ka.min(kb), ka.max(kb))) {
                    continue;
                }
                let (ea, eb) = (&r.edges[ka], &r.edges[kb]);
                if meet(ea, eb) || ea.bridge.is_some() || eb.bridge.is_some() {
                    continue;
                }
                let (p0, p1, q0, q1) = ((a0[0], a0[2]), (a1[0], a1[2]), (b0[0], b0[2]), (b1[0], b1[2]));
                if seg_dist2(p0, p1, q0, q1) >= (ha + hb).pow(2) {
                    continue;
                }
                seen.insert((ka.min(kb), ka.max(kb)));
                let gap = (a0[1] + a1[1] - b0[1] - b1[1]).abs() / 2;
                // (a road crossing over a tunnel 7 m down is no meeting; one crossing a cutting is)
                let decked = super::roads::deck_road(ea) || super::roads::deck_road(eb) || ea.under.is_some() || eb.under.is_some();
                if decked && gap < LIFT_CM - 50 {
                    out.push(Violation { rule: "clearance", hard: true, what: format!("{} over {}: {} cm", ea.name, eb.name, gap), at: [p0.0, p0.1] });
                } else if !decked && gap < LIFT_CM - 50 {
                    out.push(Violation { rule: "road-overlap", hard: false, what: format!("{} and {}", ea.name, eb.name), at: [p0.0, p0.1] });
                }
            }
        }
    }
}

/// The radius (cm) of the circle through a, b, c (i64::MAX when they are in line).
fn radius3(a: P, b: P, c: P) -> i64 {
    let (ab, bc, ca) = (seg_dist2(a, a, b, b), seg_dist2(b, b, c, c), seg_dist2(c, c, a, a));
    let cross = ((b.0 - a.0) as i128 * (c.1 - a.1) as i128 - (b.1 - a.1) as i128 * (c.0 - a.0) as i128).abs();
    if cross == 0 {
        return i64::MAX;
    }
    let num = ((ab as f64) * (bc as f64) * (ca as f64)).sqrt();
    (num / (2.0 * cross as f64)) as i64
}

fn curves(l: &Layers, out: &mut Vec<Violation>) {
    let mut at: BTreeMap<u32, Vec<&super::roads::Edge>> = BTreeMap::new();
    for e in &l.roads.edges {
        at.entry(e.a).or_default().push(e);
        at.entry(e.b).or_default().push(e);
        let Some(c) = e.v4.and_then(super::classes::class) else { continue };
        let min = c.min_radius_cm(false);
        let pts: Vec<P> = e.points.iter().map(|q| (q[0], q[2])).collect();
        if let Some(i) = (1..pts.len().saturating_sub(1)).find(|&i| {
            let (a, b, d) = (pts[i - 1], pts[i], pts[i + 1]);
            seg_dist2(a, a, b, b) >= 40_000 && seg_dist2(b, b, d, d) >= 40_000 && radius3(a, b, d) < min
        }) {
            out.push(Violation { rule: "curve", hard: false, what: format!("road {} {} ({})", e.id, e.name, c.name), at: [pts[i].0, pts[i].1] });
        }
    }
    for (n, es) in &at {
        if es.len() != 2 || es.iter().any(|e| super::roads::is_graded(e.class) || e.bridge.is_some()) {
            continue;
        }
        let dir = |e: &super::roads::Edge| {
            let p = &e.points;
            let (q0, q1) = if e.a == *n { (p[0], p[1]) } else { (p[p.len() - 1], p[p.len() - 2]) };
            (q1[0] - q0[0], q1[2] - q0[2])
        };
        let (u, v) = (dir(es[0]), dir(es[1]));
        // turning over 20 degrees: the two ways out are less than 160 degrees apart (cos > cos 160)
        let dot = u.0 as f64 * v.0 as f64 + u.1 as f64 * v.1 as f64;
        let lens = ((u.0 as f64).hypot(u.1 as f64)) * ((v.0 as f64).hypot(v.1 as f64));
        if lens > 0.0 && dot / lens > -0.9397 {
            let q = &l.roads.nodes[*n as usize];
            out.push(Violation { rule: "bend", hard: false, what: format!("{} turns at node {}", es[0].name, n), at: [q.x, q.z] });
        }
    }
}

fn junctions(l: &Layers, out: &mut Vec<Violation>) {
    let Some(t) = &l.transit else { return };
    // (against every lot and site: a lot a line takes later becomes a site in its place, and the lines keep off the
    // circles, so what blocked a roundabout still does)
    let clear: Vec<Vec<P>> = l.lots.iter().filter_map(|x| x.poly.as_ref()).chain(l.sites.iter().filter_map(|s| s.poly.as_ref())).map(|p| pts(p)).collect();
    let want = l.roads.junction_kinds(t, &clear);
    // (only where the world carries junction controls: phase 3 on)
    if !l.roads.nodes.iter().any(|n| n.junction.is_some()) {
        return;
    }
    for n in &l.roads.nodes {
        let w = want.get(&n.id).copied();
        let bad = n.junction != w
            || (n.junction == Some("roundabout")
                && l.roads.edges.iter().filter(|e| e.a == n.id || e.b == n.id).any(|e| super::roads::path_len(&e.points) < super::roads::ROUNDABOUT_ARM_CM));
        if bad {
            out.push(Violation { rule: "junction", hard: true, what: format!("node {} is {:?}, its roads call for {:?}", n.id, n.junction, w), at: [n.x, n.z] });
        }
    }
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
        // (phase 9: a tram street's tram version: its bed down the middle, or its lanes widened)
        let ok = class(name).is_some_and(|c| {
            if let Some(layout) = e.tram {
                let added = c.tram.map_or(0, |t| t.added_cm);
                let carriageway = e.width - 2 * e.walk - e.bed.unwrap_or(0) - e.median.unwrap_or(0);
                let lanes = e.lanes == c.lanes && e.walk >= c.side_cm;
                return lanes
                    && if layout == "centre-bed" {
                        e.median.is_none() && e.bed == Some(c.median_cm + added) && carriageway == c.carriageway_cm()
                    } else {
                        e.bed.is_none() && e.median.unwrap_or(0) == c.median_cm && (carriageway == c.carriageway_cm() || carriageway == c.carriageway_cm() + added || (name == "lane" && e.width < c.total_cm + added))
                    };
            }
            let carriageway = e.width - 2 * e.walk - median.unwrap_or(0);
            // (a class with no footpaths has shoulders: its whole width, no walk)
            let width = if c.walk { (carriageway == c.carriageway_cm() && e.walk >= c.side_cm) || (name == "lane" && e.width < c.total_cm) } else { e.width == c.total_cm && e.walk == 0 };
            // (phase 6: an expressway between an interchange's two ramp junctions has a lane fewer each way, the
            // lane its exit took and its entrance gives back)
            let ramps = |n: u32| l.roads.nodes.get(n as usize).is_some_and(|q| q.junction == Some("ramps"));
            let lanes = e.lanes == c.lanes || (name == "expressway" && e.lanes + 1 == c.lanes && ramps(e.a) && ramps(e.b));
            width && lanes && median.unwrap_or(0) == c.median_cm
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
