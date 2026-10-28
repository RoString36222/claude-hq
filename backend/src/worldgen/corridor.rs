//! City Gen v4, phase 8: the City Line's corridor. The plan's elevated line runs only along a
//! boulevard (classes.rs: 36.5 m, a 7.5 m planted median), its piers in the median. No street
//! is laid out as one along the line (the line's alignment comes off the streets, smoothed to
//! its 150 m curves), and laying one before the lots would move every lot (and HQ) behind it,
//! so the corridor is cut through the town once its lots are drawn: a boulevard under the
//! alignment from Central to the line's last stop.
//!
//! Every street within the boulevard's reach goes. Each street the cut leaves meets the
//! boulevard at a T (a junction at most every `GAP_CM`, none under a station), or ends short
//! of it where no junction may stand. The lots the boulevard reaches are retired, as the
//! lines' claims retire theirs; never an HQ's: a world whose line would need one (or would
//! cross water or a graded road) keeps the line on its streets, without a corridor.
//! railway.rs then lays the line on this alignment, its piers in the median.

use std::collections::BTreeSet;

use super::city::City;
use super::claims::Airport;
use super::classes::class;
use super::lines::{dist, resample, P};
use super::organic::geom::{inside, nearest_on, seg_dist2};
use super::railway::{Cl, CL_PLATFORM_CM};
use super::roads::{is_graded, Edge, Node, Roads, NAMES, STEP_CM};
use super::terrain::Terrain;

/// The least run (cm) of boulevard between two of its junctions.
pub const GAP_CM: i64 = 5_000;
/// How far (cm) past a station's platform ends a junction keeps.
const STATION_CLEAR_CM: i64 = 1_500;
/// A junction this close (cm) to an end of the boulevard moves onto the end.
const END_SNAP_CM: i64 = 1_500;
/// Samples along a street (cm), finding where the boulevard reaches it.
pub const SAMPLE_CM: i64 = 200;
/// The shortest piece (cm) of a cut street kept.
const PIECE_CM: i64 = 400;
/// Stubs closer (cm) than this are one junction's.
const MERGE_CM: i64 = 600;
/// How far (cm) back from the water a run of boulevard stops (the line bridges on).
const BANK_CM: i64 = 1_500;

/// The corridor cut: the line's alignment, the boulevard's edges and junctions.
pub struct Corridor {
    pub cl: Cl,
    /// Where (cm along the line) each run of boulevard starts and ends: past Central's station
    /// building, short of the airport's land, back from the water's banks.
    pub runs: Vec<(i64, i64)>,
    pub edges: Vec<u32>,
    pub junctions: Vec<u32>,
}

/// The polyline the boulevard follows, measured along.
struct Line {
    pts: Vec<P>,
    at: Vec<i64>,
}

impl Line {
    fn new(pts: &[P]) -> Line {
        let mut at = vec![0i64; pts.len()];
        for k in 1..pts.len() {
            at[k] = at[k - 1] + dist(pts[k - 1], pts[k]);
        }
        Line { pts: pts.to_vec(), at }
    }
    fn len(&self) -> i64 {
        *self.at.last().unwrap_or(&0)
    }
    /// The distance (cm) along it of the point nearest q, and the squared distance to it.
    fn proj(&self, q: P) -> (i64, i64) {
        let mut best = (0, i64::MAX);
        for k in 0..self.pts.len().saturating_sub(1) {
            let (p, d2) = nearest_on(q, self.pts[k], self.pts[k + 1]);
            if d2 < best.1 {
                best = (self.at[k] + dist(self.pts[k], p), d2);
            }
        }
        best
    }
    /// Does segment ab come within r (cm) of it?
    fn near(&self, a: P, b: P, r: i64) -> bool {
        self.pts.windows(2).any(|w| seg_dist2(w[0], w[1], a, b) < r * r)
    }
    fn point(&self, s: i64) -> P {
        point_at(&self.pts, &self.at, s)
    }
    /// Its points from s0 to s1, both ends exact.
    fn slice(&self, s0: i64, s1: i64) -> Vec<P> {
        let mut out = vec![self.point(s0)];
        for (k, &q) in self.pts.iter().enumerate() {
            if self.at[k] > s0 + 50 && self.at[k] < s1 - 50 {
                out.push(q);
            }
        }
        out.push(self.point(s1));
        out
    }
}

/// The points every `SAMPLE_CM` along a path, from its start: where `cut` asks after the water.
pub fn samples(path: &[P]) -> Vec<P> {
    let line = Line::new(path);
    (0..=line.len() / SAMPLE_CM).map(|i| line.point(i * SAMPLE_CM)).collect()
}

fn point_at(pts: &[P], at: &[i64], s: i64) -> P {
    let k = at.partition_point(|&a| a <= s).clamp(1, pts.len() - 1);
    let (a, b) = (pts[k - 1], pts[k]);
    let l = (at[k] - at[k - 1]).max(1);
    let f = (s - at[k - 1]).clamp(0, l);
    (a.0 + (b.0 - a.0) * f / l, a.1 + (b.1 - a.1) * f / l)
}

fn along(points: &[[i64; 3]]) -> Vec<i64> {
    let p: Vec<P> = points.iter().map(|q| (q[0], q[2])).collect();
    Line::new(&p).at
}

/// The boulevard's runs, each with where (cm along the line) it starts.
struct Band {
    runs: Vec<(i64, Line)>,
}

impl Band {
    fn near(&self, a: P, b: P, r: i64) -> bool {
        self.runs.iter().any(|x| x.1.near(a, b, r))
    }
    /// The run nearest q, the distance along it and the squared distance to it.
    fn proj(&self, q: P) -> (usize, i64, i64) {
        self.runs.iter().enumerate().map(|(k, x)| {
            let (s, d2) = x.1.proj(q);
            (k, s, d2)
        }).min_by_key(|x| (x.2, x.0)).unwrap_or((0, 0, i64::MAX))
    }
}

/// Where a cut street ends at the boulevard's reach: its piece, which end, the point and the
/// distance along the boulevard nearest it, and how far off the boulevard's centre it is.
struct Stub {
    /// The node it ends at, and the road whose kind its join to the boulevard takes.
    from: u32,
    proto: Edge,
    run: usize,
    q: P,
    s: i64,
    off: i64,
}

/// A road's width (cm) without its tram's (phase 9): a tram street paved as its class's tram version
/// may be paved back when no line runs there, so the cut reaches it as its class.
fn bare(e: &Edge) -> i64 {
    e.v4.and_then(class).and_then(|c| c.tram).filter(|t| Some(t.layout.name()) == e.tram).map_or(e.width, |t| e.width - t.added_cm)
}

/// Cut the corridor. `wet`: whether the alignment is over water every `SAMPLE_CM` along it (the
/// boulevard runs on each stretch of land long enough, the line bridging the water between).
/// On Err (the reason) nothing is changed.
pub fn cut(roads: &mut Roads, city: &mut City, t: &Terrain, cl: &Cl, wet: &[bool], airport: Option<&Airport>) -> Result<Corridor, String> {
    let c = class("boulevard").ok_or("no boulevard class")?;
    let half = c.total_cm / 2;
    let full = Line::new(&cl.path);
    // the line leaves Central over its station building (the transit hub): the boulevard
    // starts where its reach clears the hub, the line before it on the station's own frame
    let hubs: Vec<Vec<P>> = city.sites.iter().filter(|s| s.kind == "transit").filter_map(|s| s.poly.as_ref()).map(|p| p.iter().map(|q| (q[0], q[1])).collect()).collect();
    let mut s0 = 0;
    for poly in &hubs {
        let reach = |s: i64| {
            let tail = Line::new(&full.slice(s, full.len()));
            (0..poly.len()).any(|k| tail.near(poly[k], poly[(k + 1) % poly.len()], half)) || tail.pts.iter().any(|&q| inside(q, poly))
        };
        while s0 < full.len() && reach(s0) {
            s0 += SAMPLE_CM;
        }
    }
    // and it ends where its reach would enter the airport's land, the line on to its airport
    // station over the landside, as an airport's viaduct may be (claims.rs)
    let mut s1 = full.len();
    if let Some(a) = airport {
        let enters = |s: i64| Line::new(&full.slice(s0, s)).pts.windows(2).any(|w| a.meets_seg(w[0], w[1], half) || a.in_corridor(w[0], w[1], half));
        while s1 > s0 && enters(s1) {
            s1 -= SAMPLE_CM;
        }
    }
    // the stretches of land, `BANK_CM` back from the water
    let dry = |s: i64| !wet.get((s / SAMPLE_CM) as usize).copied().unwrap_or(false);
    let mut spans: Vec<(i64, i64)> = Vec::new();
    let mut s = s0;
    while s <= s1 {
        if !dry(s) {
            s += SAMPLE_CM;
            continue;
        }
        let a = s;
        while s + SAMPLE_CM <= s1 && dry(s + SAMPLE_CM) {
            s += SAMPLE_CM;
        }
        let (lo, hi) = (if a > s0 { a + BANK_CM } else { a }, if s < s1 { s - BANK_CM } else { s });
        if hi - lo >= 2 * GAP_CM {
            spans.push((lo, hi));
        }
        s += SAMPLE_CM;
    }
    if spans.is_empty() {
        return Err(if wet.iter().any(|&w| w) { "no land long enough between the water" } else { "too short" }.into());
    }
    let band = Band { runs: spans.iter().map(|&(a, b)| (a, Line::new(&full.slice(a, b)))).collect() };
    // what it may not take: an HQ's lot, a site, a graded road (they keep the line on the streets)
    let mut gone = BTreeSet::new();
    for l in &city.lots {
        let Some(poly) = l.poly.as_ref() else { continue };
        let poly: Vec<P> = poly.iter().map(|q| (q[0], q[1])).collect();
        let hit = (0..poly.len()).any(|k| band.near(poly[k], poly[(k + 1) % poly.len()], half)) || band.runs.iter().any(|r| r.1.pts.iter().any(|&q| inside(q, &poly)));
        if hit {
            if l.kind == "hq" {
                return Err(format!("HQ lot {}", l.id));
            }
            gone.insert(l.id);
        }
    }
    // (a kerb's stop on a street the boulevard takes goes with it: the bus routes are drawn
    // after, from the stops left)
    let mut stops_gone = BTreeSet::new();
    for s in city.sites.iter().filter(|s| s.kind != "transit") {
        let Some(poly) = s.poly.as_ref() else { continue };
        let poly: Vec<P> = poly.iter().map(|q| (q[0], q[1])).collect();
        if (0..poly.len()).any(|k| band.near(poly[k], poly[(k + 1) % poly.len()], half)) {
            if !matches!(s.kind, "busstop" | "tramstop") {
                return Err(format!("site {}", s.id));
            }
            stops_gone.insert(s.id.clone());
        }
    }
    for e in &roads.edges {
        let fast = is_graded(e.class) || matches!(e.v4, Some("expressway") | Some("ramp") | Some("flyover")) || e.under.is_some();
        if fast && e.points.windows(2).any(|w| band.near((w[0][0], w[0][2]), (w[1][0], w[1][2]), half + bare(e) / 2)) {
            return Err(format!("graded road {}", e.id));
        }
    }

    // the streets: each cut where the boulevard reaches it, its pieces kept
    let mut nodes: Vec<Node> = roads.nodes.clone();
    let node = |nodes: &mut Vec<Node>, q: P| {
        let id = nodes.len() as u32;
        nodes.push(Node { id, x: q.0, y: t.height_at(q.0, q.1), z: q.1, junction: None, island: None });
        id
    };
    let mut kept: Vec<Edge> = Vec::new();
    let mut pieces: Vec<Edge> = Vec::new();
    let mut stubs: Vec<Stub> = Vec::new();
    for e in &roads.edges {
        let reach = half + bare(e) / 2;
        if !e.points.windows(2).any(|w| band.near((w[0][0], w[0][2]), (w[1][0], w[1][2]), reach)) {
            kept.push(e.clone());
            continue;
        }
        let at = along(&e.points);
        let len = *at.last().unwrap();
        let pts: Vec<P> = e.points.iter().map(|q| (q[0], q[2])).collect();
        let n = (len / SAMPLE_CM).max(1);
        let samples: Vec<(i64, bool)> = (0..=n)
            .map(|i| {
                let s = len * i / n;
                (s, band.proj(point_at(&pts, &at, s)).2 >= reach * reach)
            })
            .collect();
        // the runs of samples out of its reach
        let mut i = 0;
        while i < samples.len() {
            if !samples[i].1 {
                i += 1;
                continue;
            }
            let mut j = i;
            while j + 1 < samples.len() && samples[j + 1].1 {
                j += 1;
            }
            let (s0, s1) = (samples[i].0, samples[j].0);
            let (from_a, to_b) = (i == 0, j == samples.len() - 1);
            if s1 - s0 >= PIECE_CM || (from_a && to_b) {
                let (q0, q1) = (point_at(&pts, &at, s0), point_at(&pts, &at, s1));
                let a = if from_a { e.a } else { node(&mut nodes, q0) };
                let b = if to_b { e.b } else { node(&mut nodes, q1) };
                let mut p: Vec<[i64; 3]> = vec![[q0.0, 0, q0.1]];
                for (k, q) in e.points.iter().enumerate() {
                    if at[k] > s0 + 50 && at[k] < s1 - 50 {
                        p.push(*q);
                    }
                }
                p.push([q1.0, 0, q1.1]);
                for (n, cutq) in [(a, (!from_a).then_some(q0)), (b, (!to_b).then_some(q1))] {
                    if let Some(q) = cutq {
                        let (run, s, d2) = band.proj(q);
                        stubs.push(Stub { from: n, proto: e.clone(), q, run, s, off: super::noise::isqrt(d2) });
                    }
                }
                pieces.push(Edge { id: 0, a, b, points: p, ..e.clone() });
            }
            i = j + 1;
        }
    }

    // a node the cut left at the end of one road, which ran on into the band (its next road
    // wholly in it, so nothing was cut at it), joins the boulevard as a cut street does
    // (and so does a main road left ending where side streets still meet it: the cars' network
    // is the main roads')
    let count = |es: &mut dyn Iterator<Item = &Edge>, main: bool, len: usize| {
        let mut d = vec![0u32; len];
        for e in es.filter(|e| !main || e.class == "arterial") {
            d[e.a as usize] += 1;
            d[e.b as usize] += 1;
        }
        d
    };
    for main in [true, false] {
        let was = count(&mut roads.edges.iter(), main, roads.nodes.len());
        let now = count(&mut kept.iter().chain(&pieces), main, nodes.len());
        for (n, &w) in was.iter().enumerate() {
            if w < 2 || now[n] != 1 || stubs.iter().any(|st| st.from == n as u32) {
                continue;
            }
            let q = (roads.nodes[n].x, roads.nodes[n].z);
            let (run, s, d2) = band.proj(q);
            let reach = half + 3_000;
            if d2 < reach * reach {
                let proto = kept.iter().chain(&pieces).filter(|e| !main || e.class == "arterial").find(|e| e.a == n as u32 || e.b == n as u32).cloned().expect("a road at it");
                stubs.push(Stub { from: n as u32, proto, q, run, s, off: super::noise::isqrt(d2) });
            }
        }
    }

    // two stubs a few metres apart (a side street that met the cut road just inside the band)
    // are one place: the lesser's road is joined to the other's end, which alone meets the boulevard
    let mut merged = vec![false; stubs.len()];
    for i in 0..stubs.len() {
        for j in 0..stubs.len() {
            if i == j || merged[i] || merged[j] || dist(stubs[i].q, stubs[j].q) >= MERGE_CM {
                continue;
            }
            let rank = |k: usize| (stubs[k].proto.class == "arterial", stubs[k].proto.width, std::cmp::Reverse(k));
            if rank(i) < rank(j) {
                continue;
            }
            // j onto i
            let (from, to, q) = (stubs[j].from, stubs[i].from, stubs[i].q);
            for e in kept.iter_mut().chain(pieces.iter_mut()) {
                if e.a == from {
                    e.a = to;
                    e.points[0] = [q.0, 0, q.1];
                }
                if e.b == from {
                    e.b = to;
                    let n = e.points.len() - 1;
                    e.points[n] = [q.0, 0, q.1];
                }
            }
            merged[j] = true;
        }
    }
    let stubs: Vec<Stub> = stubs.into_iter().zip(merged).filter(|x| !x.1).map(|x| x.0).collect();

    // per run of boulevard: its junctions (at most one every GAP_CM, none under a station, each
    // stub meeting it at 45 degrees or squarer, else ending where it was cut), then the
    // boulevard end to end through them and the streets' ends joined to it
    let name = NAMES.iter().find(|n| !roads.edges.iter().any(|e| e.name.split(' ').next() == Some(**n))).map_or("City".to_string(), |n| n.to_string());
    let mut boulevard: Vec<Edge> = Vec::new();
    let mut joins: Vec<Edge> = Vec::new();
    let mut ids: Vec<u32> = Vec::new();
    for (r, (from, line)) in band.runs.iter().enumerate() {
        let total = line.len();
        let windows: Vec<(i64, i64)> = cl.at.iter().map(|&k| full.at[k] - from).map(|s| (s - CL_PLATFORM_CM / 2 - STATION_CLEAR_CM, s + CL_PLATFORM_CM / 2 + STATION_CLEAR_CM)).collect();
        let place = |s: i64| -> i64 {
            let mut s = s.clamp(0, total);
            for &(lo, hi) in &windows {
                if s > lo && s < hi {
                    s = if s - lo < hi - s { lo } else { hi };
                }
            }
            if s < END_SNAP_CM {
                0
            } else if s > total - END_SNAP_CM {
                total
            } else {
                s.clamp(0, total)
            }
        };
        // the main roads' stubs first: each gets its junction, at any angle (the road runs on as
        // the boulevard there), so the cars' network (traffic.js: arterials) stays whole; then the
        // side streets', each joining a junction within GAP_CM at 45 degrees or squarer, or a new
        // one GAP_CM clear of the rest, else ending where it was cut
        let main = |k: usize| stubs[k].proto.class == "arterial";
        let mut order: Vec<usize> = (0..stubs.len()).filter(|&k| stubs[k].run == r).collect();
        order.sort_by_key(|&k| (!main(k), stubs[k].s, k));
        let mut fixed: Vec<(i64, Vec<usize>)> = Vec::new();
        for k in order {
            let st = &stubs[k];
            let s = place(st.s);
            let square = |sj: i64| (sj - st.s).abs() <= st.off;
            let near = fixed.iter().enumerate().filter(|(_, j)| (j.0 - s).abs() < GAP_CM).min_by_key(|(_, j)| (j.0 - s).abs()).map(|(i, _)| i);
            match near {
                Some(i) if main(k) || square(fixed[i].0) => fixed[i].1.push(k),
                Some(_) => {}
                None if main(k) || square(s) => fixed.push((s, vec![k])),
                None => {}
            }
        }
        fixed.sort_by_key(|j| j.0);
        // (at an end of the run a side street alone would make a bend of two roads more than a
        // class apart: it ends short instead; a main road meets it as an avenue)
        fixed.retain(|j| (j.0 > 0 && j.0 < total) || j.1.len() >= 2 || j.1.iter().any(|&k| main(k)));
        let mut stops: Vec<i64> = vec![0];
        stops.extend(fixed.iter().map(|j| j.0).filter(|&s| s > 0 && s < total));
        stops.push(total);
        stops.dedup();
        let at: Vec<u32> = stops.iter().map(|&s| node(&mut nodes, line.point(s))).collect();
        for w in 0..stops.len() - 1 {
            let pts = resample(&line.slice(stops[w], stops[w + 1]), STEP_CM);
            boulevard.push(
                Edge {
                    id: 0, a: at[w], b: at[w + 1], class: "arterial", width: c.total_cm, walk: c.side_cm, lanes: 1, route: None,
                    name: format!("{name} Boulevard"), points: pts.iter().map(|q| [q.0, 0, q.1]).collect(), min_tier: None,
                    bridge: None, v4: None, median: None, oneway: None, under: None, tram: None, bed: None,
                }
                .classed(Some("boulevard")),
            );
        }
        for (sj, list) in &fixed {
            let i = stops.iter().position(|s| s == sj).unwrap_or(0);
            let (jid, jq) = (at[i], line.point(stops[i]));
            for &k in list {
                let st = &stubs[k];
                let p = &st.proto;
                let pts = resample(&[st.q, jq], STEP_CM);
                let mut j = Edge { id: 0, a: st.from, b: jid, points: pts.iter().map(|q| [q.0, 0, q.1]).collect(), bridge: None, under: None, oneway: None, tram: None, bed: None, ..p.clone() };
                // (a join is its street's class as it is, never its tram version: no tram crosses the
                // boulevard)
                if let Some(k) = p.tram.and(p.v4).and_then(class) {
                    j = Edge { width: k.total_cm, walk: k.side_cm, median: None, ..j }.classed(Some(k.name));
                }
                // (a main road narrower than an avenue meets the boulevard as one: no bend of
                // two roads more than a class apart)
                if p.class == "arterial" && p.v4 != Some("avenue") {
                    if let Some(av) = class("avenue") {
                        j = Edge { width: av.total_cm, walk: av.side_cm, ..j }.classed(Some("avenue"));
                    }
                }
                joins.push(j);
            }
        }
        ids.extend(at);
    }

    // the roads as they now are, numbered again; the nodes nothing uses go
    let mut edges = kept;
    edges.extend(pieces);
    edges.extend(joins);
    let first = edges.len();
    edges.extend(boulevard);
    for q in edges.iter_mut().flat_map(|e| e.points.iter_mut()) {
        q[1] = t.height_at(q[0], q[2]);
    }
    let mut used = vec![false; nodes.len()];
    for e in &edges {
        used[e.a as usize] = true;
        used[e.b as usize] = true;
    }
    let mut renum = vec![u32::MAX; nodes.len()];
    let mut out = Vec::new();
    for (k, nd) in nodes.into_iter().enumerate() {
        if used[k] {
            renum[k] = out.len() as u32;
            out.push(Node { id: out.len() as u32, ..nd });
        }
    }
    for (k, e) in edges.iter_mut().enumerate() {
        e.id = k as u32;
        (e.a, e.b) = (renum[e.a as usize], renum[e.b as usize]);
    }
    let junctions = ids.iter().map(|&i| renum[i as usize]).collect();
    // (a pier must find room at least every crossing's span along the whole line, as railway.rs
    // will look for it: else a join comes in too shallow, down the median, and the line keeps to
    // its streets)
    let cut = Roads { nodes: out, edges };
    let lots: Vec<super::city::Lot> = city.lots.iter().filter(|l| !gone.contains(&l.id)).cloned().collect();
    let sites: Vec<super::city::Site> = city.sites.iter().filter(|s| !stops_gone.contains(&s.id)).cloned().collect();
    let ok: Vec<i64> = (0..=full.len() / SAMPLE_CM).map(|i| i * SAMPLE_CM).filter(|&s| super::railway::pier_ok(&cut, &lots, &sites, full.point(s))).collect();
    if ok.windows(2).any(|w| w[1] - w[0] > super::railway::SPAN_LONG_CM) {
        return Err("no room for the piers".into());
    }
    let Roads { nodes: out, edges } = cut;
    roads.nodes = out;
    roads.edges = edges;
    super::retire_lots(city, &gone);
    city.sites.retain(|s| !stops_gone.contains(&s.id));
    Ok(Corridor { cl: cl.clone(), runs: spans, edges: (first as u32..roads.edges.len() as u32).collect(), junctions })
}
