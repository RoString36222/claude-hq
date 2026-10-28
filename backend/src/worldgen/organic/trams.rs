//! City Gen v4: the tram routes, planned on the street graph before the streets are paved (so the
//! roads they follow are paved as their classes' tram versions) and before the civic sites (so the
//! stations stand along them). A route is a path through the network along one of the city's main
//! desire lines:
//!
//!   places     each district (a zoning seed's patch) with the lots in it, at the middle of their
//!              doors, weighed by its floors (its people); and the core, the plaza, weighed as twice
//!              the mean district
//!   pairs      every two places at least `MIN_PAIR_CM` apart, strongest first by a gravity model:
//!              the product of their weights over the distance between them
//!   a route    for each pair whose two places no route yet passes near (`SERVED_CM`), the cheapest
//!              path from a junction near the one to a junction near the other: any road class (the
//!              narrow ones share the lane), a side street costing a little more than a main road,
//!              a road another route already runs on four times as much, every turn costing by its
//!              angle and only turns a tram can take (transit.rs `tram_turn_ok`: a 25 m curve at
//!              least), never a node twice
//!   how many   up to `ROUTES` on the Commons, one on a personal island
//!
//! The City Line's corridor is cut through the town later (corridor.rs): where it crosses a route,
//! the route runs as a line each side of it (transit.rs).

use std::cmp::Reverse;
use std::collections::{BTreeMap, BinaryHeap};

use super::super::city::Lot;
use super::super::noise::ONE;
use super::super::profile::Profile;
use super::super::transit::tram_turn_ok;
use super::geom::{dist2, len, sub, unit, P};
use super::graph::{Graph, Kind};
use super::zoning::Zoning;

/// A tram route: its nodes end to end, and the graph edges between them.
#[derive(Clone, Debug)]
pub struct Route {
    pub nodes: Vec<u32>,
    pub edges: Vec<u32>,
}

/// The most routes on the Commons (a personal island has one).
const ROUTES: usize = 3;
/// The shortest route (cm): two stations, a little closer than the plan's 600 m.
const MIN_ROUTE_CM: i64 = 30_000;
/// The nearest two places (cm) a route joins.
const MIN_PAIR_CM: i64 = 30_000;
/// The longest way round (per mille of the straight line between its ends, and cm more).
const DETOUR_PM: i64 = 1_500;
const DETOUR_CM: i64 = 10_000;
/// Per mille: a road no lot fronts (through a park, along the water) costs this much more.
const BARE_PM: i64 = 3_000;
/// How near (cm) a route must pass a place to serve it.
const SERVED_CM: i64 = 25_000;
/// How far (cm) from a place its route may start or end, at a junction.
const END_CM: i64 = 20_000;
/// A district with fewer lots is no place of its own.
const MIN_LOTS: usize = 6;
/// Per mille of a road's length: a main road, a side street, a road a route already runs on.
const MAIN_PM: i64 = 1_000;
const SIDE_PM: i64 = 1_300;
const SHARED_PM: i64 = 4_000;
/// A turn's cost (cm) at a right angle, in proportion to 1 - cos of it.
const TURN_CM: i64 = 20_000;

pub fn plan(p: &Profile, g: &Graph, zoning: &Zoning, lots: &[Lot]) -> Vec<Route> {
    // the places: the districts (by zoning seed), and the core
    let mut sum: BTreeMap<usize, (i64, i64, i64, usize)> = BTreeMap::new();
    for l in lots {
        let Some(s) = zoning.at((l.x, l.z)) else { continue };
        let Some(k) = zoning.seeds.iter().position(|x| std::ptr::eq(x, s)) else { continue };
        let e = sum.entry(k).or_insert((0, 0, 0, 0));
        *e = (e.0 + l.door[0], e.1 + l.door[2], e.2 + l.floors.max(1), e.3 + 1);
    }
    let mut places: Vec<(P, i64)> = sum.values().filter(|s| s.3 >= MIN_LOTS).map(|s| ((s.0 / s.3 as i64, s.1 / s.3 as i64), s.2)).collect();
    if places.is_empty() {
        return Vec::new();
    }
    let mean = places.iter().map(|x| x.1).sum::<i64>() / places.len() as i64;
    places.push(((0, 0), 2 * mean));
    let mut pairs: Vec<(Reverse<i128>, usize, usize)> = Vec::new();
    for i in 0..places.len() {
        for j in i + 1..places.len() {
            let d = len(sub(places[i].0, places[j].0));
            if d >= MIN_PAIR_CM {
                pairs.push((Reverse(places[i].1 as i128 * places[j].1 as i128 * 1_000 / d as i128), i, j));
            }
        }
    }
    pairs.sort();
    let most = if p.name == "island" { 1 } else { ROUTES };
    let mut used = vec![false; g.edges.len()];
    // the roads lots front (each lot's door on the road nearest it)
    let mut fronted = vec![false; g.edges.len()];
    for l in lots {
        if let Some(a) = super::super::civic::attach(g, (l.door[0], l.door[2])) {
            fronted[a.e as usize] = true;
        }
    }
    let mut out: Vec<Route> = Vec::new();
    for &(_, i, j) in &pairs {
        if out.len() >= most {
            break;
        }
        let near = |q: P, out: &[Route]| out.iter().flat_map(|r| &r.nodes).any(|&n| dist2(g.nodes[n as usize], q) <= SERVED_CM * SERVED_CM);
        if near(places[i].0, &out) && near(places[j].0, &out) {
            continue;
        }
        let Some(mut r) = route(g, places[i].0, places[j].0, &used, &fronted) else { continue };
        let total: i64 = r.edges.iter().map(|&e| seg(g, e)).sum();
        let chord = len(sub(g.nodes[r.nodes[0] as usize], g.nodes[r.nodes[r.nodes.len() - 1] as usize]));
        if total > chord * DETOUR_PM / 1000 + DETOUR_CM {
            continue;
        }
        extend(g, &mut r, &used);
        if r.edges.iter().map(|&e| seg(g, e)).sum::<i64>() < MIN_ROUTE_CM {
            continue;
        }
        for &e in &r.edges {
            used[e as usize] = true;
        }
        out.push(r);
    }
    out
}

fn seg(g: &Graph, e: u32) -> i64 {
    let x = &g.edges[e as usize];
    len(sub(g.nodes[x.b as usize], g.nodes[x.a as usize]))
}

fn road(g: &Graph, e: u32) -> bool {
    g.edges[e as usize].alive && g.edges[e as usize].kind != Kind::Water
}

fn degree(g: &Graph, n: u32) -> usize {
    g.adj[n as usize].iter().filter(|&&e| road(g, e)).count()
}

/// How far (cm) a route runs on past each of its ends.
const EXTEND_CM: i64 = 25_000;

/// Run a route on past each end, through the district it serves rather than to its middle and
/// back: the straightest way on a tram may turn (`turn_ok`), onto no road a route already has and
/// no node of its own, to the last junction (or street's end) within `EXTEND_CM`.
fn extend(g: &Graph, r: &mut Route, used: &[bool]) {
    for last in [true, false] {
        if !last {
            r.nodes.reverse();
            r.edges.reverse();
        }
        let (mut back, mut at, mut e_in) = (r.nodes[r.nodes.len() - 2], r.nodes[r.nodes.len() - 1], r.edges[r.edges.len() - 1]);
        let (mut add, mut keep, mut run): (Vec<(u32, u32)>, usize, i64) = (Vec::new(), 0, 0);
        loop {
            let pn = g.nodes[at as usize];
            let (u1, l1) = (unit(sub(g.nodes[back as usize], pn)), seg(g, e_in));
            let next = g.adj[at as usize]
                .iter()
                .copied()
                .filter(|&e| road(g, e) && e != e_in && !used[e as usize])
                .filter_map(|e| {
                    let m = g.other(e, at);
                    let (u2, l2) = (unit(sub(g.nodes[m as usize], pn)), seg(g, e));
                    let bend = degree(g, at) == 2 && !g.edges[e as usize].bridge && !g.edges[e_in as usize].bridge;
                    let ok = !r.nodes.contains(&m) && !add.iter().any(|x| x.0 == m) && turn_ok(u1, l1, u2, l2, bend);
                    ok.then_some((((u1.0 as i128 * u2.0 as i128 + u1.1 as i128 * u2.1 as i128) / ONE as i128) as i64, e, m))
                })
                .min();
            let Some((_, e, m)) = next else { break };
            run += seg(g, e);
            if run > EXTEND_CM {
                break;
            }
            add.push((m, e));
            if degree(g, m) != 2 {
                keep = add.len();
            }
            if degree(g, m) == 1 {
                break;
            }
            (back, at, e_in) = (at, m, e);
        }
        for &(m, e) in &add[..keep] {
            r.nodes.push(m);
            r.edges.push(e);
        }
        if !last {
            r.nodes.reverse();
            r.edges.reverse();
        }
    }
}

/// Can a route turn where its two roads meet (see transit.rs `tram_turn_ok`)? At a node of two roads (`bend`), on
/// the tram's own curve (roads.rs `fillet_bends`); at a junction or a bridge's end, at the node itself: a junction
/// keeps its arms straight (the cars' turns and a bed's trims there are drawn from them).
fn turn_ok(u1: P, l1: i64, u2: P, l2: i64, bend: bool) -> bool {
    tram_turn_ok(u1, l1, u2, l2, bend)
}

/// The cheapest path a tram may take from a junction near `from` to one near `to` (see the module doc).
fn route(g: &Graph, from: P, to: P, used: &[bool], fronted: &[bool]) -> Option<Route> {
    let ends = |q: P| -> Vec<(i64, u32)> {
        let mut v: Vec<(i64, u32)> = (0..g.nodes.len() as u32)
            .filter(|&n| degree(g, n) >= 3 && dist2(g.nodes[n as usize], q) <= END_CM * END_CM)
            .map(|n| (len(sub(g.nodes[n as usize], q)), n))
            .collect();
        v.sort();
        v
    };
    let (starts, goals) = (ends(from), ends(to));
    if starts.is_empty() || goals.is_empty() {
        return None;
    }
    let cost = |e: u32| {
        let pm = if used[e as usize] { SHARED_PM } else if g.edges[e as usize].kind == Kind::Arterial { MAIN_PM } else { SIDE_PM };
        let pm = if fronted[e as usize] { pm } else { pm * BARE_PM / 1000 };
        seg(g, e) * pm / 1000
    };
    // states: an edge walked toward one of its ends (2e: toward b, 2e+1: toward a)
    let head = |s: usize| if s.is_multiple_of(2) { g.edges[s / 2].b } else { g.edges[s / 2].a };
    let tail = |s: usize| if s.is_multiple_of(2) { g.edges[s / 2].a } else { g.edges[s / 2].b };
    let mut dist = vec![i64::MAX; 2 * g.edges.len()];
    let mut prev = vec![usize::MAX; 2 * g.edges.len()];
    let mut heap = BinaryHeap::new();
    for &(d, n) in &starts {
        for &e in g.adj[n as usize].iter().filter(|&&e| road(g, e)) {
            let s = 2 * e as usize + (g.edges[e as usize].a != n) as usize;
            let c = 2 * d + cost(e);
            if c < dist[s] {
                dist[s] = c;
                heap.push(Reverse((c, s)));
            }
        }
    }
    while let Some(Reverse((d, s))) = heap.pop() {
        if d > dist[s] {
            continue;
        }
        let (n, back) = (head(s), tail(s));
        let pn = g.nodes[n as usize];
        let (u1, l1) = (unit(sub(g.nodes[back as usize], pn)), seg(g, (s / 2) as u32));
        let bend = degree(g, n) == 2 && !g.edges[s / 2].bridge;
        for &e in g.adj[n as usize].iter().filter(|&&e| road(g, e) && e as usize != s / 2) {
            let m = g.other(e, n);
            let (u2, l2) = (unit(sub(g.nodes[m as usize], pn)), seg(g, e));
            if !turn_ok(u1, l1, u2, l2, bend && !g.edges[e as usize].bridge) {
                continue;
            }
            let c = ((u1.0 as i128 * u2.0 as i128 + u1.1 as i128 * u2.1 as i128) / ONE as i128) as i64;
            let turn = (c + ONE) * TURN_CM / ONE;
            let t = 2 * e as usize + (g.edges[e as usize].a != n) as usize;
            let nd = d + cost(e) + turn;
            if nd < dist[t] {
                dist[t] = nd;
                prev[t] = s;
                heap.push(Reverse((nd, t)));
            }
        }
    }
    // the best way in to a junction near `to`
    let mut best: Option<(i64, usize)> = None;
    for &(d, n) in &goals {
        for &e in g.adj[n as usize].iter().filter(|&&e| road(g, e)) {
            let s = 2 * e as usize + (g.edges[e as usize].b != n) as usize;
            if dist[s] < i64::MAX && best.is_none_or(|b| (dist[s] + 2 * d, s) < b) {
                best = Some((dist[s] + 2 * d, s));
            }
        }
    }
    let (_, mut s) = best?;
    let mut states = vec![s];
    while prev[s] != usize::MAX {
        s = prev[s];
        states.push(s);
    }
    states.reverse();
    let mut nodes = vec![tail(states[0])];
    nodes.extend(states.iter().map(|&s| head(s)));
    let mut seen = nodes.clone();
    seen.sort_unstable();
    seen.dedup();
    // (never a node twice: a tram line runs end to end)
    (seen.len() == nodes.len()).then(|| Route { nodes, edges: states.iter().map(|&s| (s / 2) as u32).collect() })
}
