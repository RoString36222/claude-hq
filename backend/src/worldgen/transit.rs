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

    // trams: the stops grouped by the street their doors are on
    let mut by_street: BTreeMap<&str, Vec<&Site>> = BTreeMap::new();
    for s in sites.iter().filter(|s| s.kind == "tramstop") {
        if let Some(e) = net.nearest(door(s), |e| e.class == "arterial") {
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
        let tram = |e: &Edge| (e.class == "arterial").then_some(if e.name == name { 1000 } else { 4000 });
        let calls: Vec<Call> = order.iter().filter_map(|s| net.nearest(door(s), on_street)).map(|e| Call::Street(e.a, e.b)).collect();
        let via = net.via(&calls);
        lines.push(Line {
            id: format!("tram:{n}"), kind: "tram", tier: TRAM_TIER,
            stops: order.iter().map(|s| s.id.clone()).collect(),
            path: net.through(&via, &tram),
        });
        n += 1;
    }
    Transit { lines }
}
