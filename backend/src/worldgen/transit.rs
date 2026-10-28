//! Public transport (@2): `layers.transit`, the lines buses and trams run on the city's
//! streets. A line is its stops (civic sites, in the order it calls at them) and its
//! path (road node ids, consecutive nodes joined by a street); clients run the
//! timetable from these alone (a pure function of the doc and the clock).
//!
//!   bus   (tier 2) one loop from the transit hub round every bus stop, or two once
//!         there are a dozen stops (the inner half and the outer), each calling at the
//!         stops in compass order round the plaza and passing the node nearest each
//!         of its districts' centres; it prefers the arterials. Its path ends where it began.
//!   tram  (tier 4) one line per tram street: its stops in order along it, end to end
//!         (trams run back and forth), on the arterials only, keeping to its street.
//!
//! A stop is served on the street its door is on (the city street nearest it): the line
//! drives that street end to end, entering from the end nearer the call before, so it
//! passes the door whatever class of street the stop stands on.

use std::cmp::Reverse;
use std::collections::{BTreeMap, BinaryHeap};

use serde::Serialize;

use super::city::{Lot, Site};
use super::noise::{isqrt, ONE};
use super::roads::{is_graded, Edge, Roads};

#[derive(Serialize)]
pub struct Transit {
    pub lines: Vec<Line>,
}

#[derive(Serialize)]
pub struct Line {
    pub id: String,
    /// "bus" or "tram".
    pub kind: &'static str,
    /// The first city tier it runs in.
    pub tier: u8,
    /// Site ids, in calling order.
    pub stops: Vec<String>,
    /// Road node ids, end to end.
    pub path: Vec<u32>,
}

pub const BUS_TIER: u8 = 2;
pub const TRAM_TIER: u8 = 4;

type P = (i64, i64);

fn d2(a: P, b: P) -> i64 {
    (a.0 - b.0).pow(2) + (a.1 - b.1).pow(2)
}

/// The squared distance from q to segment ab.
fn seg_d2(q: P, a: P, b: P) -> i64 {
    let (ab, aq) = ((b.0 - a.0, b.1 - a.1), (q.0 - a.0, q.1 - a.1));
    let l2 = ab.0 as i128 * ab.0 as i128 + ab.1 as i128 * ab.1 as i128;
    if l2 == 0 {
        return d2(q, a);
    }
    let t = (aq.0 as i128 * ab.0 as i128 + aq.1 as i128 * ab.1 as i128).clamp(0, l2);
    let p = (a.0 + (ab.0 as i128 * t / l2) as i64, a.1 + (ab.1 as i128 * t / l2) as i64);
    d2(q, p)
}

/// A pseudo-angle round the plaza from integers only (no trig): 0 at +x, rising
/// toward +z, 4 << 20 a full turn.
fn angle(q: P) -> i64 {
    const K: i64 = 1 << 20;
    let (x, z) = q;
    match (x >= 0, z >= 0) {
        _ if x == 0 && z == 0 => 0,
        (true, true) => z * K / (x + z),
        (false, true) => K + -x * K / (-x + z),
        (false, false) => 2 * K + -z * K / (-x - z),
        (true, false) => 3 * K + x * K / (x - z),
    }
}

/// The city's streets (no highways or ring) as a graph.
struct Net<'a> {
    r: &'a Roads,
    adj: Vec<Vec<u32>>,
}

impl<'a> Net<'a> {
    fn new(r: &'a Roads) -> Self {
        let mut adj = vec![Vec::new(); r.nodes.len()];
        for e in r.edges.iter().filter(|e| !is_graded(e.class)) {
            adj[e.a as usize].push(e.id);
            adj[e.b as usize].push(e.id);
        }
        Net { r, adj }
    }

    fn pos(&self, n: u32) -> P {
        let n = &self.r.nodes[n as usize];
        (n.x, n.z)
    }

    /// The city road nearest q among those `ok` keeps (ties to the lower id).
    fn nearest(&self, q: P, ok: impl Fn(&Edge) -> bool) -> Option<&'a Edge> {
        self.r.edges.iter().filter(|e| !is_graded(e.class) && ok(e)).min_by_key(|e| (seg_d2(q, self.pos(e.a), self.pos(e.b)), e.id))
    }

    /// The node nearer q of the road nearest it.
    fn node_at(&self, q: P, ok: impl Fn(&Edge) -> bool) -> Option<u32> {
        self.nearest(q, ok).map(|e| if d2(q, self.pos(e.a)) <= d2(q, self.pos(e.b)) { e.a } else { e.b })
    }

    /// The nodes a line must pass, in calling order: a waypoint's node, or both ends of a
    /// stop's street, entered from the end nearer the node before (the first call: from
    /// the end farther from the next call), so the line drives past the door.
    fn via(&self, calls: &[Call]) -> Vec<u32> {
        let at = |c: &Call| match *c {
            Call::Node(n) => self.pos(n),
            Call::Street(a, b) => {
                let (pa, pb) = (self.pos(a), self.pos(b));
                ((pa.0 + pb.0) / 2, (pa.1 + pb.1) / 2)
            }
        };
        let mut out: Vec<u32> = Vec::new();
        for (k, c) in calls.iter().enumerate() {
            match *c {
                Call::Node(n) => out.push(n),
                Call::Street(a, b) => {
                    let a_first = match (out.last(), calls.get(k + 1)) {
                        (Some(&p), _) => d2(self.pos(p), self.pos(a)) <= d2(self.pos(p), self.pos(b)),
                        (None, Some(next)) => d2(at(next), self.pos(a)) >= d2(at(next), self.pos(b)),
                        (None, None) => true,
                    };
                    out.extend(if a_first { [a, b] } else { [b, a] });
                }
            }
        }
        out.dedup();
        out
    }

    /// The cheapest way from a to b: `cost(e)` per mille of each street's length, None
    /// where it may not go. Nodes from a to b inclusive.
    fn path(&self, a: u32, b: u32, cost: &impl Fn(&Edge) -> Option<i64>) -> Option<Vec<u32>> {
        let mut dist = vec![i64::MAX; self.r.nodes.len()];
        let mut prev = vec![u32::MAX; self.r.nodes.len()];
        let mut heap = BinaryHeap::new();
        dist[a as usize] = 0;
        heap.push(Reverse((0i64, a)));
        while let Some(Reverse((d, n))) = heap.pop() {
            if n == b {
                break;
            }
            if d > dist[n as usize] {
                continue;
            }
            for &e in &self.adj[n as usize] {
                let edge = &self.r.edges[e as usize];
                let Some(c) = cost(edge) else { continue };
                let m = if edge.a == n { edge.b } else { edge.a };
                let nd = d + isqrt(d2(self.pos(n), self.pos(m))) * c / 1000;
                if nd < dist[m as usize] || (nd == dist[m as usize] && n < prev[m as usize]) {
                    dist[m as usize] = nd;
                    prev[m as usize] = n;
                    heap.push(Reverse((nd, m)));
                }
            }
        }
        if dist[b as usize] == i64::MAX {
            return None;
        }
        let mut out = vec![b];
        while *out.last().unwrap() != a {
            out.push(prev[*out.last().unwrap() as usize]);
        }
        out.reverse();
        Some(out)
    }

    /// The path through `via` in order, the legs joined end to start. Nodes a street
    /// joins (a stop's street) take that street.
    fn through(&self, via: &[u32], cost: &impl Fn(&Edge) -> Option<i64>) -> Vec<u32> {
        let mut out: Vec<u32> = via.first().copied().into_iter().collect();
        for w in via.windows(2) {
            let street = self.adj[w[0] as usize].iter().map(|&e| &self.r.edges[e as usize]).any(|e| (e.a == w[1] || e.b == w[1]) && cost(e).is_some());
            if street {
                out.push(w[1]);
            } else if let Some(leg) = self.path(w[0], w[1], cost) {
                out.extend_from_slice(&leg[1..]);
            }
        }
        out
    }
}

/// Where a site's door is: a metre in front of its footprint, as the generator stood it.
pub fn door(s: &Site) -> P {
    let f = s.front.unwrap_or([0, ONE]);
    let back = s.d / 2 + 100;
    (s.x + f[0] * back / ONE, s.z + f[1] * back / ONE)
}

/// A call on a line: a waypoint node, or a stop's street (its two end nodes).
enum Call {
    Node(u32),
    Street(u32, u32),
}


/// `inner_cm`: a personal island's town at tier 2 (island::RADII_CM[1]); its first bus
/// loop keeps inside it, so the island has a bus from tier 2 while the city grows.
pub fn generate(r: &Roads, sites: &[Site], lots: &[Lot], inner_cm: Option<i64>) -> Transit {
    let net = Net::new(r);
    let mut lines = Vec::new();

    // bus loops; an inner loop pays heavily for a street that leaves its town
    let out = |e: &Edge| inner_cm.is_some_and(|r| [e.a, e.b].iter().any(|&n| d2(net.pos(n), (0, 0)) > r * r));
    let bus = |e: &Edge| Some(if e.class == "arterial" { 1000 } else { 1500 });
    let hub = sites.iter().find(|s| s.kind == "transit");
    let stops: Vec<&Site> = sites.iter().filter(|s| s.kind == "busstop").collect();
    if !stops.is_empty() {
        let at = |s: &Site| net.nearest(door(s), |_| true).map(|e| Call::Street(e.a, e.b));
        let start = hub.map_or(angle(door(stops[0])), |h| angle(door(h)));
        let mut rs: Vec<i64> = stops.iter().map(|s| d2(door(s), (0, 0))).collect();
        rs.sort();
        let split = match inner_cm {
            Some(r) => r * r,
            None if stops.len() >= 12 => rs[rs.len() / 2],
            None => i64::MAX,
        };
        // the districts' centres: the mean of their lots' doors
        let mut sum: BTreeMap<u8, (i64, i64, i64)> = BTreeMap::new();
        for l in lots {
            let s = sum.entry(l.district).or_insert((0, 0, 0));
            *s = (s.0 + l.door[0], s.1 + l.door[2], s.2 + 1);
        }
        let centres: Vec<P> = sum.values().map(|s| (s.0 / s.2, s.1 / s.2)).collect();
        for inner in [true, false] {
            let side = |q: P| (d2(q, (0, 0)) <= split) == inner;
            // (compass order from the hub, a stop's id or none for a waypoint, the node)
            let mut calls: Vec<(i64, Option<&str>, Call)> = Vec::new();
            for s in stops.iter().filter(|s| side(door(s))) {
                if let Some(n) = at(s) {
                    calls.push(((angle(door(s)) - start).rem_euclid(4 << 20), Some(s.id.as_str()), n));
                }
            }
            if calls.is_empty() {
                continue;
            }
            for &c in centres.iter().filter(|&&c| side(c)) {
                if let Some(n) = net.node_at(c, |_| true) {
                    calls.push(((angle(c) - start).rem_euclid(4 << 20), None, Call::Node(n)));
                }
            }
            calls.sort_by_key(|c| (c.0, c.1));
            let mut ids: Vec<String> = Vec::new();
            let mut order: Vec<Call> = Vec::new();
            if let Some(c) = hub.and_then(at) {
                ids.push(hub.unwrap().id.clone());
                order.push(c);
            }
            for (_, id, c) in calls {
                ids.extend(id.map(str::to_string));
                order.push(c);
            }
            let mut via = net.via(&order);
            via.push(via[0]);
            via.dedup();
            let path = if inner && inner_cm.is_some() {
                net.through(&via, &|e: &Edge| bus(e).map(|c| if out(e) { c * 50 } else { c }))
            } else {
                net.through(&via, &bus)
            };
            lines.push(Line { id: format!("bus:{}", lines.len()), kind: "bus", tier: BUS_TIER, stops: ids, path });
        }
    }

    // trams: the stops grouped by the street their doors are on. (City Gen v4 phase 8: never a
    // boulevard, whose median the City Line's piers stand in, until trams get their own beds)
    // (phase 9: where the streets are tram versions, a tram runs on those alone)
    let paved = r.edges.iter().any(|e| e.tram.is_some());
    let tram_street = |e: &Edge| e.class == "arterial" && e.v4 != Some("boulevard") && (!paved || e.tram.is_some());
    let cut = r.edges.iter().any(|e| e.v4 == Some("boulevard"));
    let mut by_street: BTreeMap<&str, Vec<&Site>> = BTreeMap::new();
    for s in sites.iter().filter(|s| s.kind == "tramstop") {
        if let Some(e) = net.nearest(door(s), tram_street) {
            by_street.entry(e.name.as_str()).or_default().push(s);
        }
    }
    let mut n = 0;
    for (name, group) in by_street {
        if group.len() < 2 {
            continue;
        }
        // in order along the street: from the stop farthest from the others' middle, each next the nearest left
        let mid = (group.iter().map(|s| door(s).0).sum::<i64>() / group.len() as i64, group.iter().map(|s| door(s).1).sum::<i64>() / group.len() as i64);
        let mut left: Vec<&Site> = group.clone();
        let first = (0..left.len()).max_by_key(|&k| (d2(door(left[k]), mid), Reverse(k))).unwrap();
        let mut order = vec![left.remove(first)];
        while !left.is_empty() {
            let last = door(order[order.len() - 1]);
            let k = (0..left.len()).min_by_key(|&k| (d2(door(left[k]), last), k)).unwrap();
            order.push(left.remove(k));
        }
        let on_street = |e: &Edge| e.name == name;
        let tram = |e: &Edge| tram_street(e).then_some(if e.name == name { 1000 } else { 4000 });
        let called: Vec<(&Site, Call)> = order.iter().filter_map(|s| net.nearest(door(s), |e| on_street(e) && tram_street(e)).map(|e| (*s, Call::Street(e.a, e.b)))).collect();
        // (City Gen v4 phase 8: where the City Line's boulevard cut its street, a line each side
        // of the cut, each keeping to its own street, the stops of a side alone none)
        let own = |e: &Edge| (on_street(e) && tram_street(e)).then_some(1000);
        let mut parts: Vec<Vec<(&Site, Call)>> = vec![Vec::new()];
        for (k, c) in called.into_iter().enumerate() {
            if k > 0 && cut {
                let joined = match (&parts.last().unwrap().last().unwrap().1, &c.1) {
                    (Call::Street(a, _), Call::Street(b, _)) => net.path(*a, *b, &own).is_some(),
                    _ => true,
                };
                if !joined {
                    parts.push(Vec::new());
                }
            }
            parts.last_mut().unwrap().push(c);
        }
        for part in parts.into_iter().filter(|p| p.len() >= 2) {
            let calls: Vec<Call> = part.iter().map(|x| match x.1 { Call::Street(a, b) => Call::Street(a, b), Call::Node(m) => Call::Node(m) }).collect();
            let via = net.via(&calls);
            let mut path = net.through(&via, &tram);
            // (City Gen v4 phase 9: the track runs on along its street past each end station to
            // the next junction, so it ends at one, never mid-block, with room for the platform)
            if cut || r.edges.iter().any(|e| e.tram.is_some()) {
                // (along its own street, else on along the main road it runs into: roads.rs
                // `tram_on` makes that a tram road, the tram in its lanes)
                let main = |e: &Edge| (e.class == "arterial" && e.v4 != Some("boulevard")).then_some(1000);
                run_on(&net, &mut path, &own, &main);
            }
            lines.push(Line {
                id: format!("tram:{n}"), kind: "tram", tier: TRAM_TIER,
                stops: part.iter().map(|x| x.0.id.clone()).collect(),
                path,
            });
            n += 1;
        }
    }
    Transit { lines }
}

/// City Gen v4 (phase 9): how far (cm) a tram line's track runs on past an end station to reach
/// a junction (three roads or more) or its street's end, along its own street.
const RUN_ON_CM: i64 = 100_000;

/// Run a line's path on at each end along its own street (`own`) to the nearest junction within
/// `RUN_ON_CM`, if there is one.
fn run_on(net: &Net, path: &mut Vec<u32>, own: &impl Fn(&Edge) -> Option<i64>, main: &impl Fn(&Edge) -> Option<i64>) {
    // (no there-and-back spur: a tram reverses only at its ends)
    let mut k = 1;
    while k + 1 < path.len() {
        if path[k - 1] == path[k + 1] {
            path.drain(k..k + 2);
            k = k.saturating_sub(1).max(1);
        } else {
            k += 1;
        }
    }
    run_on_by(net, path, own);
    run_on_by(net, path, main);
    // (a main road that runs on as a side street: on along that, the tram in its lanes)
    let town = |e: &Edge| (!is_graded(e.class) && e.v4.is_some() && e.under.is_none() && !matches!(e.v4, Some("boulevard") | Some("ramp") | Some("flyover") | Some("expressway"))).then_some(1000);
    run_on_by(net, path, &town);
}

fn run_on_by(net: &Net, path: &mut Vec<u32>, own: &impl Fn(&Edge) -> Option<i64>) {
    // (every road meeting there counts, the graded ones too, as the validator counts them)
    let deg = |n: u32| net.r.edges.iter().filter(|e| e.a == n || e.b == n).count();
    let junction = |n: u32| deg(n) >= 3;
    for end in [true, false] {
        let (last, before) = if end { (path[path.len() - 1], path.get(path.len().wrapping_sub(2)).copied()) } else { (path[0], path.get(1).copied()) };
        if junction(last) {
            continue;
        }
        let (mut at, mut from, mut run, mut add) = (last, before, 0i64, Vec::new());
        loop {
            // (onto a node the line already passes only where that is a junction: it meets itself there)
            let next = net.adj[at as usize].iter().map(|&e| &net.r.edges[e as usize]).find(|e| {
                let to = if e.a == at { e.b } else { e.a };
                own(e).is_some() && Some(to) != from && (!path.contains(&to) || junction(to))
            });
            let Some(e) = next else { break };
            let to = if e.a == at { e.b } else { e.a };
            run += isqrt(d2(net.pos(at), net.pos(to)));
            if run > RUN_ON_CM {
                break;
            }
            add.push(to);
            (from, at) = (Some(at), to);
            if junction(to) {
                break;
            }
        }
        // (to a junction, or the street's own end: a terminus)
        if !add.last().is_some_and(|&n| junction(n) || deg(n) == 1) {
            continue;
        }
        if end {
            path.extend(add);
        } else {
            add.reverse();
            add.extend(path.iter().copied());
            *path = add;
        }
    }
}

/// City Gen v4 (phase 9): a tram station's platform (cm): the plan's 40 m by 3 m, and how far
/// (cm) its ends keep from a junction's box (past the widest road meeting there).
pub const PLATFORM_LEN_CM: i64 = 4_000;
pub const PLATFORM_W_CM: i64 = 300;
pub const PLATFORM_JUNCTION_CM: i64 = 300;
/// How straight (cm off its chord) a platform's run of track is, and how far (cm) a station
/// may move along its line to find one.
pub const PLATFORM_BOW_CM: i64 = 100;
const PLATFORM_REACH_CM: i64 = 20_000;
/// How far apart (cm) at least a line's stations stand.
const STATION_GAP_CM: i64 = 10_000;
/// A centre bed this wide (cm) holds an island between its two tracks.
pub const ISLAND_BED_CM: i64 = 860;

/// A tram line's track as one polyline: its points (cm) and, per segment, the road it is on.
pub fn track(r: &Roads, path: &[u32]) -> (Vec<(i64, i64)>, Vec<u32>) {
    let mut pts: Vec<(i64, i64)> = Vec::new();
    let mut on: Vec<u32> = Vec::new();
    for w in path.windows(2) {
        let Some(e) = r.edges.iter().filter(|e| (e.a == w[0] && e.b == w[1]) || (e.a == w[1] && e.b == w[0])).min_by_key(|e| (e.tram.is_none(), e.id)) else { continue };
        let mut p: Vec<(i64, i64)> = e.points.iter().map(|q| (q[0], q[2])).collect();
        if e.a != w[0] {
            p.reverse();
        }
        if pts.is_empty() {
            pts.push(p[0]);
        }
        for q in &p[1..] {
            pts.push(*q);
            on.push(e.id);
        }
    }
    (pts, on)
}

/// City Gen v4 (phase 9): each tram line's stations moved onto its track: a 40 m by 3 m
/// platform on a straight run (`PLATFORM_BOW_CM`) clear of every junction's box, the nearest
/// to where the stop stood (a run on a bed wide enough for an island first, within reach):
/// an island down the middle of a centre bed, between its tracks, else a platform at the kerb
/// on the stop's side. A stop with no such run stays as it was (the validator lists it).
pub fn stations(r: &Roads, t: &mut Transit, sites: &mut Vec<Site>, terrain: &super::terrain::Terrain) {
    // (a stop no tram line calls at, cut off by the City Line's boulevard, goes)
    let called: std::collections::BTreeSet<&String> = t.lines.iter().filter(|l| l.kind == "tram").flat_map(|l| &l.stops).collect();
    sites.retain(|s| s.kind != "tramstop" || called.contains(&s.id));
    let mut moves: Vec<(String, Vec<String>, Vec<String>)> = Vec::new();
    let mut deg: BTreeMap<u32, usize> = BTreeMap::new();
    for e in &r.edges {
        *deg.entry(e.a).or_default() += 1;
        *deg.entry(e.b).or_default() += 1;
    }
    // every junction (three roads or more) and how far along the tram street its box reaches:
    // past the widest road crossing it (not the tram street itself)
    let boxes: Vec<((i64, i64), i64)> = deg
        .iter()
        .filter(|x| *x.1 >= 3)
        .map(|(&n, _)| {
            let q = &r.nodes[n as usize];
            let at: Vec<&Edge> = r.edges.iter().filter(|e| e.a == n || e.b == n).collect();
            let reach = at.iter().filter(|e| e.tram.is_none()).map(|e| e.width / 2).max().or_else(|| at.iter().map(|e| e.width / 2).min()).unwrap_or(0);
            ((q.x, q.z), reach + PLATFORM_JUNCTION_CM)
        })
        .collect();
    for line in t.lines.iter().filter(|l| l.kind == "tram") {
        let (pts, on) = track(r, &line.path);
        if pts.len() < 2 {
            continue;
        }
        let mut at = vec![0i64; pts.len()];
        for k in 1..pts.len() {
            at[k] = at[k - 1] + isqrt(d2(pts[k - 1], pts[k]));
        }
        let total = at[at.len() - 1];
        let pos = |s: i64| -> ((i64, i64), usize) {
            let k = at.partition_point(|&a| a <= s).clamp(1, pts.len() - 1);
            let l = (at[k] - at[k - 1]).max(1);
            let f = (s - at[k - 1]).clamp(0, l);
            let (a, b) = (pts[k - 1], pts[k]);
            ((a.0 + (b.0 - a.0) * f / l, a.1 + (b.1 - a.1) * f / l), k - 1)
        };
        let half = PLATFORM_LEN_CM / 2;
        // is the run centred s along the track a platform's: straight, clear of every box?
        let fits = |s: i64| -> bool {
            if s - half < 0 || s + half > total {
                return false;
            }
            let ((a, _), (b, _)) = (pos(s - half), pos(s + half));
            let chord = isqrt(d2(a, b)).max(1);
            let bow = (0..pts.len()).filter(|&k| at[k] > s - half && at[k] < s + half).all(|k| {
                let (p, q) = (pts[k], (b.0 - a.0, b.1 - a.1));
                ((p.0 - a.0) as i128 * q.1 as i128 - (p.1 - a.1) as i128 * q.0 as i128).abs() / chord as i128 <= PLATFORM_BOW_CM as i128
            });
            bow && boxes.iter().all(|&(n, r2)| seg_d2(n, a, b) >= r2 * r2)
        };
        let edge = |s: i64| r.edges.get(on[pos(s).1.min(on.len() - 1)] as usize);
        let island = |s: i64| edge(s).is_some_and(|e| e.tram == Some("centre-bed") && e.bed.unwrap_or(0) >= ISLAND_BED_CM);
        // each stop's door, and where along the track it is nearest
        let stops: Vec<(String, (i64, i64), i64)> = line
            .stops
            .iter()
            .filter_map(|sid| sites.iter().find(|s| &s.id == sid))
            .map(|site| {
                let door = door(site);
                let want = (0..pts.len() - 1)
                    .map(|k| {
                        let (a, b) = (pts[k], pts[k + 1]);
                        let l = isqrt(d2(a, b)).max(1);
                        let f = (((door.0 - a.0) as i128 * (b.0 - a.0) as i128 + (door.1 - a.1) as i128 * (b.1 - a.1) as i128) / l as i128).clamp(0, l as i128) as i64;
                        (d2((a.0 + (b.0 - a.0) * f / l, a.1 + (b.1 - a.1) * f / l), door), at[k] + f)
                    })
                    .min()
                    .map_or(0, |x| x.1);
                (site.id.clone(), door, want)
            })
            .collect();
        // the platform at s for a stop by `door`: the island down the middle of a centre bed, else
        // the kerb's on the stop's side, itself clear of every box: (its centre, facing, axis)
        let place = |s: i64, door: (i64, i64)| -> Option<((i64, i64), (i64, i64), (i64, i64))> {
            if !fits(s) {
                return None;
            }
            let ((a, _), (b, _)) = (pos(s - half), pos(s + half));
            let (c, _) = pos(s);
            let l = isqrt(d2(a, b)).max(1);
            let u = ((b.0 - a.0) * ONE / l, (b.1 - a.1) * ONE / l);
            let n = (-u.1, u.0);
            let e = edge(s)?;
            // (never on a bridge: the platform's run of track all on land)
            let (k0, k1) = (pos(s - half).1, pos(s + half).1);
            if (k0..=k1.min(on.len() - 1)).any(|k| r.edges.get(on[k] as usize).is_some_and(|x| x.bridge == Some(true))) {
                return None;
            }
            // (none beside a bed too narrow for an island between its tracks: the tram would stop in the
            // bed with a car lane between it and the kerb)
            if e.tram == Some("centre-bed") && e.bed.unwrap_or(0) < ISLAND_BED_CM {
                return None;
            }
            let (centre, front) = if e.tram == Some("centre-bed") {
                (c, n)
            } else {
                let side = if (door.0 - c.0) as i128 * n.0 as i128 + (door.1 - c.1) as i128 * n.1 as i128 >= 0 { 1 } else { -1 };
                let off = e.width / 2 - e.walk + PLATFORM_W_CM / 2;
                ((c.0 + side * n.0 * off / ONE, c.1 + side * n.1 * off / ONE), (-side * n.0, -side * n.1))
            };
            let (p0, p1) = ((centre.0 - u.0 * half / ONE, centre.1 - u.1 * half / ONE), (centre.0 + u.0 * half / ONE, centre.1 + u.1 * half / ONE));
            boxes.iter().all(|&(n, r2)| seg_d2(n, p0, p1) >= r2 * r2).then_some((centre, front, u))
        };
        // in order along the track, as many stops as can have their platforms, STATION_GAP_CM
        // apart at least, each as near its stop as may be (a bed wide enough for an island
        // counting as nearer): the best of every choice, stop by stop
        let mut order: Vec<usize> = (0..stops.len()).collect();
        order.sort_by_key(|&k| (stops[k].2, k));
        let opts: Vec<Vec<(i64, i64, ((i64, i64), (i64, i64), (i64, i64)))>> = order
            .iter()
            .map(|&k| {
                let (_, door, want) = stops[k];
                (0..=total / 200)
                    .map(|i| i * 200)
                    .filter_map(|s| place(s, door).map(|p| (s, (s - want).abs() + if island(s) { 0 } else { PLATFORM_REACH_CM / 4 }, p)))
                    .collect()
            })
            .collect();
        // best[i][j]: (placed, -cost) over stops i.., the last platform at opts[i-1][j] (or none)
        type Pick = (usize, i64, Vec<(usize, usize)>);
        fn best(i: usize, after: i64, opts: &[Vec<(i64, i64, ((i64, i64), (i64, i64), (i64, i64)))>]) -> Pick {
            if i == opts.len() {
                return (0, 0, Vec::new());
            }
            let mut top = best(i + 1, after, opts);
            if let Some((j, o)) = opts[i].iter().enumerate().filter(|(_, o)| o.0 >= after).min_by_key(|(_, o)| o.1) {
                let mut rest = best(i + 1, o.0 + STATION_GAP_CM, opts);
                let take = (rest.0 + 1, rest.1 + o.1);
                if take.0 > top.0 || (take.0 == top.0 && take.1 < top.1) {
                    rest.2.push((i, j));
                    top = (take.0, take.1, rest.2);
                }
            }
            top
        }
        let (_, _, picks) = best(0, 0, &opts);
        let chosen: Vec<(usize, i64, ((i64, i64), (i64, i64), (i64, i64)))> = picks.iter().rev().map(|&(i, j)| (order[i], opts[i][j].0, opts[i][j].2)).collect();
        // (a stop with no room for its platform stays a stop at the kerb, as before: the validator
        // lists it); the line's stops in order along its track
        let mut along: Vec<(i64, String)> = stops.iter().enumerate().map(|(k, st)| (chosen.iter().find(|c| c.0 == k).map_or(st.2, |c| c.1), st.0.clone())).collect();
        along.sort();
        moves.push((line.id.clone(), along.into_iter().map(|x| x.1).collect(), Vec::new()));
        for (k, _, (centre, front, u)) in chosen {
            let Some(site) = sites.iter_mut().find(|s| s.id == stops[k].0) else { continue };
            let corner = |sl: i64, sw: i64| [centre.0 + (u.0 * sl + front.0 * sw) / ONE, centre.1 + (u.1 * sl + front.1 * sw) / ONE];
            let (hl, hw) = (PLATFORM_LEN_CM / 2, PLATFORM_W_CM / 2);
            let mut poly = vec![corner(-hl, -hw), corner(hl, -hw), corner(hl, hw), corner(-hl, hw)];
            let area: i128 = (0..4).map(|k| poly[k][0] as i128 * poly[(k + 1) % 4][1] as i128 - poly[(k + 1) % 4][0] as i128 * poly[k][1] as i128).sum();
            if area < 0 {
                poly.reverse();
            }
            site.x = centre.0;
            site.z = centre.1;
            site.y = terrain.height_at(centre.0, centre.1);
            site.w = PLATFORM_LEN_CM;
            site.d = PLATFORM_W_CM;
            site.front = Some([front.0, front.1]);
            site.facing = if front.1 >= 0 { super::city::Facing::North } else { super::city::Facing::South };
            site.poly = Some(poly);
        }
    }
    // each line's stations in order along its track
    for (id, keep, _) in moves {
        if let Some(l) = t.lines.iter_mut().find(|l| l.id == id) {
            l.stops = keep;
        }
    }
}

