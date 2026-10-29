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
/// `tram_routes`: City Gen v4, each tram route's stations (organic/trams.rs, civic.rs): its lines are
/// the roads carrying its bit (`Edge::lines`); none before v4, where a line is a tram street.
pub fn generate(r: &Roads, sites: &[Site], lots: &[Lot], inner_cm: Option<i64>, tram_routes: &[Vec<String>]) -> Transit {
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

    if !tram_routes.is_empty() {
        route_lines(&net, sites, tram_routes, &mut lines);
        return Transit { lines };
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

/// City Gen v4 (trams on desire lines): the radius (cm) a tram route's bends are filleted to, the
/// plan's 25 m and a metre for integer rounding; how far (cm) such a bend's centre line may move
/// into it (a town street's own bend moves 25 cm, roads.rs `BEND_SHIFT_CM`); and the span (cm) a
/// track's curve is measured over: three points of it at least this far apart along it.
pub const TRAM_FILLET_CM: i64 = 2_600;
pub const TRAM_BEND_SHIFT_CM: i64 = 200;
pub const TRAM_CURVE_SPAN_CM: i64 = 800;

/// The circle through a, b, c: is its radius at least `r` (cm)? (A straight line's is.)
fn radius_at_least(a: P, b: P, c: P, r: i64) -> bool {
    let cross = ((b.0 - a.0) as i128 * (c.1 - a.1) as i128 - (b.1 - a.1) as i128 * (c.0 - a.0) as i128).abs();
    let (ab, bc, ca) = (isqrt(d2(a, b)) as i128, isqrt(d2(b, c)) as i128, isqrt(d2(c, a)) as i128);
    ab * bc * ca >= 2 * r as i128 * cross
}

/// City Gen v4: the tightest a tram's track may turn, as the validator measures it (`tram-curve`):
/// at every point of the polyline, the circle through it and the points `TRAM_CURVE_SPAN_CM` or
/// more back and ahead along it has a radius of `r` cm at least. The first point where it turns
/// tighter, if any.
pub fn tram_tight(pts: &[P], r: i64) -> Option<usize> {
    let mut at = vec![0i64; pts.len()];
    for k in 1..pts.len() {
        at[k] = at[k - 1] + isqrt(d2(pts[k - 1], pts[k]));
    }
    let (mut i, mut j) = (0usize, 0usize);
    for k in 1..pts.len().saturating_sub(1) {
        while i + 1 < k && at[k] - at[i + 1] >= TRAM_CURVE_SPAN_CM {
            i += 1;
        }
        j = j.max(k + 1);
        while j < pts.len() && at[j] - at[k] < TRAM_CURVE_SPAN_CM {
            j += 1;
        }
        if j >= pts.len() {
            break;
        }
        if at[k] - at[i] >= TRAM_CURVE_SPAN_CM && !radius_at_least(pts[i], pts[k], pts[j], r) {
            return Some(k);
        }
    }
    None
}

/// City Gen v4: can a tram route turn where two straight roads meet at a node, their arms out of it
/// the Q16 unit vectors `u1`, `u2`, `l1`, `l2` cm long? At a node of two roads (`filleted`: roads.rs
/// `fillet_bends` curves it) a `TRAM_FILLET_CM` arc must fit, its tangents within 0.4 of either arm
/// and its middle at most `TRAM_BEND_SHIFT_CM` inside the corner. At a junction or a bridge's end
/// the track turns at the node itself: the circle through it and the arms' first points
/// `TRAM_CURVE_SPAN_CM` or more out (every `STEP_CM`, as roads are resampled) must be as wide.
pub fn tram_turn_ok(u1: P, l1: i64, u2: P, l2: i64, filleted: bool) -> bool {
    let c = ((u1.0 as i128 * u2.0 as i128 + u1.1 as i128 * u2.1 as i128) / ONE as i128) as i64;
    if c < -65_496 {
        return true; // within 2 degrees of straight on
    }
    if filleted && l1 >= 200 && l2 >= 200 {
        let sin_h = isqrt((ONE - c) * ONE / 2);
        let cos_h = isqrt((ONE + c) * ONE / 2);
        if sin_h <= 0 || sin_h >= ONE - 1 {
            return false;
        }
        let tan_d = cos_h * ONE / sin_h;
        let r = TRAM_FILLET_CM;
        return r * tan_d / ONE <= l1.min(l2) * 2 / 5 && r * ONE / sin_h - r <= TRAM_BEND_SHIFT_CM;
    }
    let out = |u: P, l: i64| {
        let n = ((l + super::roads::STEP_CM - 1) / super::roads::STEP_CM).max(1);
        let i = (TRAM_CURVE_SPAN_CM * n + l - 1) / l.max(1);
        let s = (l * i.min(n) / n).max(1);
        (u.0 * s / ONE, u.1 * s / ONE)
    };
    radius_at_least(out(u1, l1), (0, 0), out(u2, l2), TRAM_FILLET_CM)
}

/// How near (cm) its track a route's station must be to call on one of its lines.
const ROUTE_STOP_CM: i64 = 6_000;

/// City Gen v4: the tram routes' lines. A route's roads (its bit in `Edge::lines`, never a boulevard)
/// run end to end as one line, or, where the City Line's boulevard cut them, one line each side;
/// a line calls at the route's stations along its side, in order along its track, two at least.
/// Its ends are at a junction or a street's end: where the cut left one mid-block, the track runs on
/// to the next junction where the tram can make the turn (`tram_tight`), else it ends back at the
/// last junction it passed.
fn route_lines(net: &Net, sites: &[Site], routes: &[Vec<String>], lines: &mut Vec<Line>) {
    let mut n = 0;
    for (k, ids) in routes.iter().enumerate().take(8) {
        for (path, stops) in route_pieces(net, sites, k, ids) {
            if stops.len() < 2 {
                continue;
            }
            lines.push(Line { id: format!("tram:{n}"), kind: "tram", tier: TRAM_TIER, stops: stops.into_iter().map(|x| x.1).collect(), path });
            n += 1;
        }
    }
}

/// Route k's pieces end to end (one, or one each side of the City Line's boulevard), their ends
/// settled (`ends`), and on each the route's stations (`ids`) its track passes within
/// `ROUTE_STOP_CM`, in order along it (how far along, id): each on the piece nearest it.
fn route_pieces(net: &Net, sites: &[Site], k: usize, ids: &[String]) -> Vec<(Vec<u32>, Vec<(i64, String)>)> {
    let r = net.r;
    let bit = 1u8 << k;
    let on = |e: &Edge| e.lines & bit != 0 && e.v4 != Some("boulevard") && !is_graded(e.class);
    let mut deg: BTreeMap<u32, usize> = BTreeMap::new();
    for e in r.edges.iter().filter(|e| on(e)) {
        *deg.entry(e.a).or_default() += 1;
        *deg.entry(e.b).or_default() += 1;
    }
    // its pieces end to end, from their ends (a loop from its lowest node)
    let mut used = std::collections::BTreeSet::new();
    let mut pieces: Vec<Vec<u32>> = Vec::new();
    let starts: Vec<u32> = deg.iter().filter(|x| *x.1 == 1).map(|x| *x.0).chain(deg.keys().copied()).collect();
    for start in starts {
        let mut path = vec![start];
        let mut at = start;
        while let Some(e) = net.adj[at as usize].iter().map(|&e| &r.edges[e as usize]).filter(|e| on(e) && !used.contains(&e.id)).min_by_key(|e| e.id) {
            used.insert(e.id);
            at = if e.a == at { e.b } else { e.a };
            path.push(at);
        }
        // (where its track turns tighter than a tram may, after all, as the streets were curved and
        // cut: a line each side, from the node nearest)
        let mut work = vec![path];
        while let Some(mut path) = work.pop() {
            if path.len() < 2 {
                continue;
            }
            let (pts, _) = track(r, &path);
            let Some(k) = tram_tight(&pts, super::classes::TRAM_MIN_RADIUS_CM) else {
                ends(net, &mut path, &on);
                pieces.push(path);
                continue;
            };
            if path.len() < 3 {
                continue;
            }
            let mut idx = vec![0usize];
            for w in path.windows(2) {
                let n = r.edges.iter().filter(|e| (e.a == w[0] && e.b == w[1]) || (e.a == w[1] && e.b == w[0])).min_by_key(|e| (e.tram.is_none(), e.id)).map_or(0, |e| e.points.len() - 1);
                idx.push(idx[idx.len() - 1] + n);
            }
            let j = (1..path.len() - 1).min_by_key(|&m| (idx[m].abs_diff(k), m)).unwrap_or(1);
            work.push(path[j..].to_vec());
            work.push(path[..=j].to_vec());
        }
    }
    // each station on the piece it is nearest, if near enough
    let mut calls: Vec<Vec<(i64, String)>> = vec![Vec::new(); pieces.len()];
    let tracks: Vec<Option<Track>> = pieces.iter().map(|p| Track::new(r, p)).collect();
    for site in ids.iter().filter_map(|id| sites.iter().find(|s| &s.id == id)) {
        let d = door(site);
        let near = tracks
            .iter()
            .enumerate()
            .filter_map(|(i, t)| t.as_ref().map(|t| (i, t)))
            .map(|(i, t)| {
                let s = t.near(d);
                (d2(t.pos(s).0, d), i, s)
            })
            .min();
        if let Some((_, i, s)) = near.filter(|x| x.0 <= ROUTE_STOP_CM * ROUTE_STOP_CM) {
            calls[i].push((s, site.id.clone()));
        }
    }
    for c in &mut calls {
        c.sort();
    }
    pieces.into_iter().zip(calls).collect()
}

/// City Gen v4: a route's piece long enough for two stations (`FILL_MIN_CM`) but with fewer than
/// it should have (one at each end, about `civic::TRAM_STATIONS_CM` apart: where the City Line's
/// boulevard cut a route between its stations) gets the rest as new stations standing on their
/// platforms (a 40 m run of its track as `stations` would pick, clear of every junction's box),
/// each as far from the others as may be, `STATION_GAP_CM` at least. Their ids join the route's.
/// Returns how many it added.
pub fn route_stations(r: &Roads, sites: &mut Vec<Site>, lots: &[Lot], routes: &mut [Vec<String>]) -> usize {
    let feet = feet(lots);
    let net = Net::new(r);
    let boxes = boxes(r);
    let mut added = 0;
    let mut next = sites.iter().filter(|s| s.kind == "tramstop").filter_map(|s| s.id.strip_prefix("tramstop:").and_then(|n| n.parse::<usize>().ok())).max().map_or(0, |n| n + 1);
    for k in 0..routes.len().min(8) {
        for (path, stops) in route_pieces(&net, sites, k, &routes[k]) {
            let Some(tr) = Track::new(r, &path) else { continue };
            if tr.total < FILL_MIN_CM {
                continue;
            }
            let want = ((tr.total + super::civic::TRAM_STATIONS_CM / 2) / super::civic::TRAM_STATIONS_CM + 1).max(2) as usize;
            let mut at: Vec<i64> = stops.iter().map(|x| x.0).collect();
            while at.len() < want {
                let pick = (0..=tr.total / 200)
                    .map(|i| i * 200)
                    .filter_map(|s| tr.platform(s, tr.pos(s).0).filter(|p| blocked(&boxes, p).is_empty() && off_lots(&feet, p)).map(|p| (at.iter().map(|&x| (x - s).abs()).min().unwrap_or(i64::MAX), s, p)))
                    .filter(|x| x.0 >= STATION_GAP_CM)
                    .max_by_key(|x| (x.0, Reverse(x.1)));
                let Some((_, s, p)) = pick else { break };
                at.push(s);
                let id = format!("tramstop:{next}");
                next += 1;
                let (centre, front, u) = (p.centre, p.front, p.u);
                let corner = |sl: i64, sw: i64| [centre.0 + (u.0 * sl + front.0 * sw) / ONE, centre.1 + (u.1 * sl + front.1 * sw) / ONE];
                let (hl, hw) = (PLATFORM_LEN_CM / 2, PLATFORM_W_CM / 2);
                let mut poly = vec![corner(-hl, -hw), corner(hl, -hw), corner(hl, hw), corner(-hl, hw)];
                let area: i128 = (0..4).map(|k| poly[k][0] as i128 * poly[(k + 1) % 4][1] as i128 - poly[(k + 1) % 4][0] as i128 * poly[k][1] as i128).sum();
                if area < 0 {
                    poly.reverse();
                }
                // (on the block of the route's first station: a platform stands in the street)
                let block = sites.iter().find(|x| routes[k].contains(&x.id)).map_or(0, |x| x.block);
                sites.push(Site {
                    id: id.clone(), kind: "tramstop", block, x: centre.0, y: 0, z: centre.1, w: PLATFORM_LEN_CM, d: PLATFORM_W_CM,
                    facing: if front.1 >= 0 { super::city::Facing::North } else { super::city::Facing::South },
                    tier: Some(TRAM_TIER), poly: Some(poly), front: Some([front.0, front.1]), view: None, runway: None,
                });
                routes[k].push(id);
                added += 1;
            }
        }
    }
    added
}

/// The shortest piece of a route (cm) that has stations: two platforms `STATION_GAP_CM` apart.
const FILL_MIN_CM: i64 = 2 * PLATFORM_LEN_CM + STATION_GAP_CM;

/// A route line's ends at a junction or a street's end (see `route_lines`).
fn ends(net: &Net, path: &mut Vec<u32>, own: &impl Fn(&Edge) -> bool) {
    let r = net.r;
    let deg = |n: u32| net.r.edges.iter().filter(|e| e.a == n || e.b == n).count();
    let done = |n: u32| deg(n) >= 3 || deg(n) == 1;
    let town = |e: &Edge| !is_graded(e.class) && e.v4.is_some() && e.under.is_none() && !matches!(e.v4, Some("boulevard") | Some("ramp") | Some("flyover") | Some("expressway"));
    for last in [true, false] {
        if !last {
            path.reverse();
        }
        let end = path[path.len() - 1];
        if !done(end) {
            // on along the roads as they run, to a junction
            let (mut at, mut from, mut run, mut add) = (end, path[path.len() - 2], 0i64, Vec::new());
            while !done(at) {
                let Some(e) = net.adj[at as usize].iter().map(|&e| &r.edges[e as usize]).find(|e| town(e) && !own(e) && (if e.a == at { e.b } else { e.a }) != from) else { break };
                let to = if e.a == at { e.b } else { e.a };
                run += isqrt(d2(net.pos(at), net.pos(to)));
                if run > RUN_ON_CM || path.contains(&to) {
                    break;
                }
                add.push(to);
                (from, at) = (at, to);
            }
            let mut tail: Vec<u32> = path[path.len().saturating_sub(4)..].to_vec();
            tail.extend(&add);
            let turns = track(r, &tail).0;
            if done(at) && !add.is_empty() && tram_tight(&turns, super::classes::TRAM_MIN_RADIUS_CM).is_none() {
                path.extend(add);
            } else if let Some(j) = (1..path.len() - 1).rev().find(|&j| deg(path[j]) >= 3) {
                // (else back to the last junction)
                path.truncate(j + 1);
            }
        }
        if !last {
            path.reverse();
        }
    }
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

/// A tram line's track measured along: its points, the road under each segment, how far along
/// each point is, and its length (cm).
struct Track<'a> {
    r: &'a Roads,
    pts: Vec<P>,
    on: Vec<u32>,
    at: Vec<i64>,
    total: i64,
}

/// A platform's place on a track: its centre, the way it faces and its axis (Q16), its two ends,
/// and the two ends of its run of track.
#[derive(Clone, Copy)]
struct Plat {
    centre: P,
    front: P,
    u: P,
    ends: (P, P),
    run: (P, P),
}

/// Every junction (three roads or more) and how far along a tram street its box reaches: past the
/// widest road crossing it (not the tram street itself) and `PLATFORM_JUNCTION_CM`.
fn boxes(r: &Roads) -> Vec<(u32, P, i64)> {
    let mut deg: BTreeMap<u32, usize> = BTreeMap::new();
    for e in &r.edges {
        *deg.entry(e.a).or_default() += 1;
        *deg.entry(e.b).or_default() += 1;
    }
    deg.iter()
        .filter(|x| *x.1 >= 3)
        .map(|(&n, _)| {
            let q = &r.nodes[n as usize];
            let at: Vec<&Edge> = r.edges.iter().filter(|e| e.a == n || e.b == n).collect();
            let reach = at.iter().filter(|e| e.tram.is_none()).map(|e| e.width / 2).max().or_else(|| at.iter().map(|e| e.width / 2).min()).unwrap_or(0);
            (n, (q.x, q.z), reach + PLATFORM_JUNCTION_CM)
        })
        .collect()
}

/// A lot's footprint and its box, which a platform keeps off (it stands in the street).
type Foot = ((i64, i64, i64, i64), Vec<P>);

fn feet(lots: &[Lot]) -> Vec<Foot> {
    lots.iter()
        .filter_map(|l| l.poly.as_ref())
        .map(|p| {
            let q: Vec<P> = p.iter().map(|x| (x[0], x[1])).collect();
            (q.iter().fold((i64::MAX, i64::MIN, i64::MAX, i64::MIN), |b, v| (b.0.min(v.0), b.1.max(v.0), b.2.min(v.1), b.3.max(v.1))), q)
        })
        .collect()
}

/// Is a platform clear of every lot? (A kerb platform beside a narrow footpath would stand on the
/// lots along it.)
fn off_lots(feet: &[Foot], p: &Plat) -> bool {
    let (hl, hw) = (PLATFORM_LEN_CM / 2, PLATFORM_W_CM / 2);
    let corner = |sl: i64, sw: i64| (p.centre.0 + (p.u.0 * sl + p.front.0 * sw) / ONE, p.centre.1 + (p.u.1 * sl + p.front.1 * sw) / ONE);
    let rect = [corner(-hl, -hw), corner(hl, -hw), corner(hl, hw), corner(-hl, hw)];
    let b = rect.iter().fold((i64::MAX, i64::MIN, i64::MAX, i64::MIN), |b, v| (b.0.min(v.0), b.1.max(v.0), b.2.min(v.1), b.3.max(v.1)));
    feet.iter().all(|(f, q)| !(b.0 <= f.1 && f.0 <= b.1 && b.2 <= f.3 && f.2 <= b.3) || !super::validate::overlap(&rect, q))
}

/// The junctions whose boxes a platform (or its run of track) reaches.
fn blocked(boxes: &[(u32, P, i64)], p: &Plat) -> Vec<u32> {
    boxes.iter().filter(|&&(_, n, r2)| seg_d2(n, p.run.0, p.run.1) < r2 * r2 || seg_d2(n, p.ends.0, p.ends.1) < r2 * r2).map(|b| b.0).collect()
}

impl<'a> Track<'a> {
    fn new(r: &'a Roads, path: &[u32]) -> Option<Track<'a>> {
        let (pts, on) = track(r, path);
        if pts.len() < 2 {
            return None;
        }
        let mut at = vec![0i64; pts.len()];
        for k in 1..pts.len() {
            at[k] = at[k - 1] + isqrt(d2(pts[k - 1], pts[k]));
        }
        let total = at[at.len() - 1];
        Some(Track { r, pts, on, at, total })
    }

    /// The point s along it, and the segment it is on.
    fn pos(&self, s: i64) -> (P, usize) {
        let k = self.at.partition_point(|&a| a <= s).clamp(1, self.pts.len() - 1);
        let l = (self.at[k] - self.at[k - 1]).max(1);
        let f = (s - self.at[k - 1]).clamp(0, l);
        let (a, b) = (self.pts[k - 1], self.pts[k]);
        ((a.0 + (b.0 - a.0) * f / l, a.1 + (b.1 - a.1) * f / l), k - 1)
    }

    fn edge(&self, s: i64) -> Option<&'a Edge> {
        self.r.edges.get(self.on[self.pos(s).1.min(self.on.len() - 1)] as usize)
    }

    /// Is the bed at s wide enough for an island between its tracks?
    fn island(&self, s: i64) -> bool {
        self.edge(s).is_some_and(|e| e.tram == Some("centre-bed") && e.bed.unwrap_or(0) >= ISLAND_BED_CM)
    }

    /// Where along it (cm) it passes nearest `q`.
    fn near(&self, q: P) -> i64 {
        (0..self.pts.len() - 1)
            .map(|k| {
                let (a, b) = (self.pts[k], self.pts[k + 1]);
                let l = isqrt(d2(a, b)).max(1);
                let f = (((q.0 - a.0) as i128 * (b.0 - a.0) as i128 + (q.1 - a.1) as i128 * (b.1 - a.1) as i128) / l as i128).clamp(0, l as i128) as i64;
                (d2((a.0 + (b.0 - a.0) * f / l, a.1 + (b.1 - a.1) * f / l), q), self.at[k] + f)
            })
            .min()
            .map_or(0, |x| x.1)
    }

    /// The platform centred s along it for a stop by `door`, the junctions' boxes aside: on a
    /// straight run of track (`PLATFORM_BOW_CM`), never on a bridge; the island down the middle of
    /// a centre bed, else the kerb's on the stop's side; none beside a bed too narrow for an island
    /// (the tram would stop in the bed with a car lane between it and the kerb).
    fn platform(&self, s: i64, door: P) -> Option<Plat> {
        let half = PLATFORM_LEN_CM / 2;
        if s - half < 0 || s + half > self.total {
            return None;
        }
        let ((a, k0), (b, k1)) = (self.pos(s - half), self.pos(s + half));
        let chord = isqrt(d2(a, b)).max(1);
        let bow = (0..self.pts.len()).filter(|&k| self.at[k] > s - half && self.at[k] < s + half).all(|k| {
            let (p, q) = (self.pts[k], (b.0 - a.0, b.1 - a.1));
            ((p.0 - a.0) as i128 * q.1 as i128 - (p.1 - a.1) as i128 * q.0 as i128).abs() / chord as i128 <= PLATFORM_BOW_CM as i128
        });
        if !bow {
            return None;
        }
        let (c, _) = self.pos(s);
        let u = ((b.0 - a.0) * ONE / chord, (b.1 - a.1) * ONE / chord);
        let n = (-u.1, u.0);
        let e = self.edge(s)?;
        if (k0..=k1.min(self.on.len() - 1)).any(|k| self.r.edges.get(self.on[k] as usize).is_some_and(|x| x.bridge == Some(true))) {
            return None;
        }
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
        let ends = ((centre.0 - u.0 * half / ONE, centre.1 - u.1 * half / ONE), (centre.0 + u.0 * half / ONE, centre.1 + u.1 * half / ONE));
        Some(Plat { centre, front, u, ends, run: (a, b) })
    }
}

/// A line's stops: each one's id, door, and where along the track it is nearest.
fn line_stops(tr: &Track, line: &Line, sites: &[Site]) -> Vec<(String, P, i64)> {
    line.stops.iter().filter_map(|sid| sites.iter().find(|s| &s.id == sid)).map(|site| (site.id.clone(), door(site), tr.near(door(site)))).collect()
}

/// In order along the track, as many stops as can have their platforms, `STATION_GAP_CM` apart at
/// least, each as near its stop as may be (a bed wide enough for an island counting as nearer): the
/// best of every choice, stop by stop. (stop, where along the track, its platform).
fn choose(tr: &Track, stops: &[(String, P, i64)], boxes: &[(u32, P, i64)], feet: &[Foot]) -> Vec<(usize, i64, Plat)> {
    let mut order: Vec<usize> = (0..stops.len()).collect();
    order.sort_by_key(|&k| (stops[k].2, k));
    let opts: Vec<Vec<(i64, i64, Plat)>> = order
        .iter()
        .map(|&k| {
            let (_, door, want) = stops[k];
            (0..=tr.total / 200)
                .map(|i| i * 200)
                .filter_map(|s| tr.platform(s, door).filter(|p| blocked(boxes, p).is_empty() && off_lots(feet, p)).map(|p| (s, (s - want).abs() + if tr.island(s) { 0 } else { PLATFORM_REACH_CM / 4 }, p)))
                .collect()
        })
        .collect();
    // best[i][j]: (placed, -cost) over stops i.., the last platform at opts[i-1][j] (or none)
    type Pick = (usize, i64, Vec<(usize, usize)>);
    fn best(i: usize, after: i64, opts: &[Vec<(i64, i64, Plat)>]) -> Pick {
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
    picks.iter().rev().map(|&(i, j)| (order[i], opts[i][j].0, opts[i][j].2)).collect()
}

/// City Gen v4 (phase 9): each tram line's stations moved onto its track: a 40 m by 3 m
/// platform on a straight run (`PLATFORM_BOW_CM`) clear of every junction's box, the nearest
/// to where the stop stood (a run on a bed wide enough for an island first, within reach):
/// an island down the middle of a centre bed, between its tracks, else a platform at the kerb
/// on the stop's side. A stop with no such run stays as it was (the validator lists it).
pub fn stations(r: &Roads, t: &mut Transit, sites: &mut Vec<Site>, lots: &[Lot], terrain: &super::terrain::Terrain) {
    let feet = feet(lots);
    // (a stop no tram line calls at, cut off by the City Line's boulevard, goes)
    let called: std::collections::BTreeSet<&String> = t.lines.iter().filter(|l| l.kind == "tram").flat_map(|l| &l.stops).collect();
    sites.retain(|s| s.kind != "tramstop" || called.contains(&s.id));
    let boxes = boxes(r);
    let mut moves: Vec<(String, Vec<String>)> = Vec::new();
    for line in t.lines.iter().filter(|l| l.kind == "tram") {
        let Some(tr) = Track::new(r, &line.path) else { continue };
        let stops = line_stops(&tr, line, sites);
        let chosen = choose(&tr, &stops, &boxes, &feet);
        // (a stop with no room for its platform stays a stop at the kerb, as before: the validator
        // lists it); the line's stops in order along its track
        let mut along: Vec<(i64, String)> = stops.iter().enumerate().map(|(k, st)| (chosen.iter().find(|c| c.0 == k).map_or(st.2, |c| c.1), st.0.clone())).collect();
        along.sort();
        moves.push((line.id.clone(), along.into_iter().map(|x| x.1).collect()));
        for (k, _, p) in chosen {
            let Some(site) = sites.iter_mut().find(|s| s.id == stops[k].0) else { continue };
            let (centre, front, u) = (p.centre, p.front, p.u);
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
    for (id, keep) in moves {
        if let Some(l) = t.lines.iter_mut().find(|l| l.id == id) {
            l.stops = keep;
        }
    }
}

/// The side streets whose mouths may close for a platform: the plan's narrow classes.
const CLOSABLE: [&str; 2] = ["lane", "local"];
/// How far past the tram road's edge (cm) a closed side street ends.
const MOUTH_CM: i64 = 100;

/// City Gen v4: make room for the stations junctions leave none for. Where a station of a tram
/// line has no platform (`choose`), and a 40 m run within its reach is straight and clear but for
/// the box of one or two side streets meeting the line at a T, those side streets end short of the
/// tram road (`MOUTH_CM` past its edge), cul-de-sacs, so the platform stands there. Only a lane or a
/// local street (never a collector or a main road), never one a tram runs on, one that is the only
/// way to the streets behind it, or one a door opens onto within the closed piece; and only where the
/// tram road runs on through the node within a class. Returns how many mouths closed (each line drawn
/// again after, by the caller). `HQ_IX=1` prints the stations with platforms before and after.
pub fn close_mouths(r: &mut Roads, t: &Transit, sites: &[Site], lots: &[Lot]) -> usize {
    let feet = feet(lots);
    let boxes = boxes(r);
    let on_tram: std::collections::BTreeSet<(u32, u32)> = t.lines.iter().filter(|l| l.kind == "tram").flat_map(|l| l.path.windows(2).map(|w| (w[0].min(w[1]), w[0].max(w[1])))).collect();
    let mut doors: Vec<P> = lots.iter().map(|l| (l.door[0], l.door[2])).collect();
    doors.extend(sites.iter().filter(|s| s.kind != "tramstop").map(door));
    let mut close: Vec<(u32, u32, i64)> = Vec::new();
    let (mut stations, mut before, mut gained) = (0, 0, 0);
    for line in t.lines.iter().filter(|l| l.kind == "tram") {
        let Some(tr) = Track::new(r, &line.path) else { continue };
        let stops = line_stops(&tr, line, sites);
        let chosen = choose(&tr, &stops, &boxes, &feet);
        stations += stops.len();
        before += chosen.len();
        let mut taken: Vec<i64> = chosen.iter().map(|c| c.1).collect();
        for (k, &(_, dr, want)) in stops.iter().enumerate() {
            if chosen.iter().any(|c| c.0 == k) {
                continue;
            }
            let mut best: Option<((usize, i64), i64, Vec<(u32, u32, i64)>)> = None;
            for s in (0..=tr.total / 200).map(|i| i * 200) {
                if (s - want).abs() > PLATFORM_REACH_CM || taken.iter().any(|&x| (x - s).abs() < STATION_GAP_CM) {
                    continue;
                }
                let Some(p) = tr.platform(s, dr).filter(|p| off_lots(&feet, p)) else { continue };
                let b = blocked(&boxes, &p);
                if b.is_empty() || b.len() > 2 {
                    continue;
                }
                let Some(sides) = b.iter().map(|&n| closable(r, n, &line.path, &on_tram, &doors)).collect::<Option<Vec<_>>>() else { continue };
                let cost = (b.len(), (s - want).abs());
                if best.as_ref().is_none_or(|x| cost < x.0) {
                    best = Some((cost, s, sides));
                }
            }
            if let Some((_, s, sides)) = best {
                taken.push(s);
                gained += 1;
                for c in sides {
                    if !close.iter().any(|x| x.1 == c.1) {
                        close.push(c);
                    }
                }
            }
        }
    }
    for &(n, e, cut) in &close {
        shorten(r, n, e, cut);
    }
    if std::env::var("HQ_IX").is_ok() {
        eprintln!("trams: {stations} stations, {before} on platforms before closing side streets; {} mouths closed for {gained} more", close.len());
    }
    close.len()
}

/// Can side street e at junction n close (see `close_mouths`)? (n, e, how far from n it ends.)
fn closable(r: &Roads, n: u32, path: &[u32], on_tram: &std::collections::BTreeSet<(u32, u32)>, doors: &[P]) -> Option<(u32, u32, i64)> {
    let at: Vec<&Edge> = r.edges.iter().filter(|e| e.a == n || e.b == n).collect();
    let i = path.iter().position(|&x| x == n)?;
    if at.len() != 3 || i == 0 || i + 1 >= path.len() {
        return None;
    }
    let key = |e: &Edge| (e.a.min(e.b), e.a.max(e.b));
    let (p0, p1) = ((path[i - 1].min(n), path[i - 1].max(n)), (path[i + 1].min(n), path[i + 1].max(n)));
    let tram: Vec<&&Edge> = at.iter().filter(|e| key(e) == p0 || key(e) == p1).collect();
    let side = at.iter().find(|e| key(e) != p0 && key(e) != p1)?;
    if tram.len() != 2 || on_tram.contains(&key(side)) || side.tram.is_some() || is_graded(side.class) || side.bridge.is_some() || side.under.is_some() || side.oneway.is_some() {
        return None;
    }
    if !side.v4.is_some_and(|v| CLOSABLE.contains(&v)) {
        return None;
    }
    // (the tram road runs on through n within a class: no bend two classes apart)
    if let (Some(a), Some(b)) = (tram[0].v4, tram[1].v4) {
        if !super::classes::one_step(a, b) {
            return None;
        }
    }
    // (past the tram road's edge, and its carriageway clear of the tram road's)
    let carriageway = |e: &Edge| (e.width / 2 - e.walk).max(100);
    let cut = (tram.iter().map(|e| e.width / 2).max().unwrap_or(0) + MOUTH_CM).max(tram.iter().map(|e| carriageway(e)).max().unwrap_or(0) + carriageway(side) + MOUTH_CM);
    let length: i64 = side.points.windows(2).map(|w| isqrt(d2((w[0][0], w[0][2]), (w[1][0], w[1][2])))).sum();
    if length < cut + super::roads::STEP_CM {
        return None;
    }
    // (no door on the closed piece: one whose nearest road is this street, within the cut of n)
    let q = (r.nodes[n as usize].x, r.nodes[n as usize].z);
    let reach = cut + side.width / 2 + 300;
    let pts: Vec<P> = side.points.iter().map(|p| (p[0], p[2])).collect();
    let from_n = |d: P| {
        let mut best = (i64::MAX, 0i64);
        let mut acc = 0;
        let pts: Vec<P> = if side.a == n { pts.clone() } else { pts.iter().rev().copied().collect() };
        for w in pts.windows(2) {
            let l = isqrt(d2(w[0], w[1])).max(1);
            let f = (((d.0 - w[0].0) as i128 * (w[1].0 - w[0].0) as i128 + (d.1 - w[0].1) as i128 * (w[1].1 - w[0].1) as i128) / l as i128).clamp(0, l as i128) as i64;
            let x = (w[0].0 + (w[1].0 - w[0].0) * f / l, w[0].1 + (w[1].1 - w[0].1) * f / l);
            best = best.min((d2(x, d), acc + f));
            acc += l;
        }
        best
    };
    for &d in doors.iter().filter(|&&d| d2(d, q) <= reach * reach) {
        let (d2_side, along) = from_n(d);
        let nearest = r.edges.iter().filter(|e| !is_graded(e.class)).map(|e| e.points.windows(2).map(|w| seg_d2(d, (w[0][0], w[0][2]), (w[1][0], w[1][2]))).min().unwrap_or(i64::MAX)).min().unwrap_or(i64::MAX);
        if d2_side <= nearest && along <= cut + 100 {
            return None;
        }
    }
    // (the streets behind it reach the rest another way)
    let m = if side.a == n { side.b } else { side.a };
    let mut adj: BTreeMap<u32, Vec<u32>> = BTreeMap::new();
    for e in r.edges.iter().filter(|e| e.id != side.id) {
        adj.entry(e.a).or_default().push(e.b);
        adj.entry(e.b).or_default().push(e.a);
    }
    let mut seen = std::collections::BTreeSet::from([m]);
    let mut stack = vec![m];
    while let Some(x) = stack.pop() {
        if x == n {
            return Some((n, side.id, cut));
        }
        for &y in adj.get(&x).map_or(&[][..], |v| &v[..]) {
            if seen.insert(y) {
                stack.push(y);
            }
        }
    }
    None
}

/// Side street e ends `cut` cm short of junction n, at a new node: a cul-de-sac.
fn shorten(r: &mut Roads, n: u32, e: u32, cut: i64) {
    let Some(k) = r.edges.iter().position(|x| x.id == e) else { return };
    let mut pts: Vec<[i64; 3]> = r.edges[k].points.clone();
    let from_a = r.edges[k].a == n;
    if !from_a {
        pts.reverse();
    }
    let mut acc = 0;
    let mut out: Vec<[i64; 3]> = Vec::new();
    for w in pts.windows(2) {
        let l = isqrt(d2((w[0][0], w[0][2]), (w[1][0], w[1][2])));
        if out.is_empty() && acc + l > cut {
            let f = cut - acc;
            out.push([w[0][0] + (w[1][0] - w[0][0]) * f / l.max(1), w[0][1], w[0][2] + (w[1][2] - w[0][2]) * f / l.max(1)]);
        }
        if !out.is_empty() && (out.len() > 1 || acc + l > cut + 50) {
            out.push(w[1]);
        }
        acc += l;
    }
    if out.len() < 2 {
        return;
    }
    let id = r.nodes.len() as u32;
    let y = r.nodes[n as usize].y;
    r.nodes.push(super::roads::Node { id, x: out[0][0], y, z: out[0][2], junction: None, island: None });
    if !from_a {
        out.reverse();
    }
    let edge = &mut r.edges[k];
    if from_a {
        edge.a = id;
    } else {
        edge.b = id;
    }
    edge.points = out;
}
