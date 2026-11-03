//! Growing the street network. First the arterials: a ring round the plaza, radials
//! traced out from it through the tensor field (bending to follow the land and the
//! districts' grids) and an arterial ring traced round the middle of the city along
//! the field's other family. Then local streets grow off them L-system style (Parish
//! & Muller 2001): each step extends a street, may branch at 60-120 degrees, snaps
//! to a junction within 12 m, and stops at steep ground or water, every district
//! growing in its own character. A river's bank is a wall in the graph: a local street
//! meets it and stops; an arterial that runs into the river crosses it on a bridge,
//! straight over from bank to bank, wherever the crossing is short and square enough.

use std::collections::VecDeque;

use super::geom::{add, along, crossing, dist2, dot, left, len, lerp, nearest_on, sub, turn, unit, DIR16, P};
use super::graph::{Fit, Graph, Kind};
use super::super::river::{River, BANK_CM};
use super::super::noise::ONE;
use super::super::profile::Profile;
use super::super::rng::Rng;
use super::super::terrain::Terrain;
use super::tensor::Field;
use super::zoning::{character, Zoning};

/// A named street: an arterial or a local street, made of graph edges.
pub struct Street {
    pub name: String,
    pub kind: Kind,
}

/// A junction within this reach (cm) of a street's end is taken: the 12 m snap.
pub const SNAP_CM: i64 = 1_200;
/// The shortest segment (cm), and how near another road a new one's middle may come.
pub const MIN_CM: i64 = 800;
const GAP_CM: i64 = 1_200;
/// An arterial's step (cm).
const ART_STEP_CM: i64 = 2_400;
/// The most local-street segments a city grows (a bound, not a target).
const MAX_LOCAL: usize = 12_000;

pub struct Ctx<'a> {
    pub p: &'a Profile,
    pub t: &'a Terrain,
    pub field: Field<'a>,
    pub zoning: &'a Zoning,
    pub river: Option<&'a River>,
}

impl Ctx<'_> {
    /// Water: past an island's coast, or ground at or below the sea.
    pub fn wet(&self, q: P) -> bool {
        self.p.coast_r_cm.is_some_and(|c| len(q) > c - 2_000) || self.p.sea_cm.is_some_and(|s| self.t.height_at(q.0, q.1) <= s + 50)
    }

    /// Can a road run straight from a to b without climbing steeper than the city's
    /// grade (with a margin: the network is checked to the full grade later)?
    pub fn gentle(&self, a: P, b: P) -> bool {
        let n = (len(sub(b, a)) + 399) / 400;
        let n = n.max(1);
        let run = (len(sub(b, a)) / n).max(1);
        let mut last = self.t.height_at(a.0, a.1);
        for i in 1..=n {
            let q = (a.0 + (b.0 - a.0) * i / n, a.1 + (b.1 - a.1) * i / n);
            let h = self.t.height_at(q.0, q.1);
            if (h - last).abs() * 1000 / run > self.p.city_grade_pm * 85 / 100 {
                return false;
            }
            last = h;
        }
        true
    }

    /// Inside the city, on dry land, off the river's bank.
    pub(super) fn open(&self, q: P) -> bool {
        len(q) <= self.p.city_r_cm && !self.wet(q) && !self.river.is_some_and(|r| r.zone(q))
    }
}

fn neg(v: P) -> P {
    (-v.0, -v.1)
}

/// The arterials: the plaza's ring (street 0), the radials and the arterial ring, as
/// chains of nodes in the order they were laid. `names` are drawn in order.
pub fn arterials(g: &mut Graph, c: &Ctx, rng: &mut Rng, streets: &mut Vec<Street>, names: &[&str]) -> Result<Vec<Vec<u32>>, String> {
    let p = c.p;
    let mut names = names.iter();
    let mut name = |suffix: &str| format!("{} {suffix}", names.next().expect("street names"));

    // the plaza: an octagon of arterial round it
    let circus = streets.len() as u32;
    streets.push(Street { name: name("Circus"), kind: Kind::Arterial });
    let corners: Vec<u32> = (0..8).map(|k| {
        let d = DIR16[2 * k + 1];
        g.node((d.0 * p.plaza_cm / ONE, d.1 * p.plaza_cm / ONE))
    }).collect();
    for k in 0..8 {
        g.link(corners[k], corners[(k + 1) % 8], Kind::Arterial, circus);
    }
    let mut chains = vec![corners.iter().copied().chain(std::iter::once(corners[0])).collect::<Vec<u32>>()];

    // radials, from evenly spread corners
    let n = rng.range(p.radials.0, p.radials.1).max(1);
    let first = rng.range(0, 7);
    for k in 0..n {
        let at = corners[((first + k * 8 / n) % 8) as usize];
        let road = streets.len() as u32;
        streets.push(Street { name: name("Avenue"), kind: Kind::Arterial });
        let o = g.nodes[at as usize];
        chains.push(trace(g, c, at, unit(o), road, None, p.city_r_cm / ART_STEP_CM * 2));
    }

    // the arterial ring, started between two radials and traced both ways round
    let rr = p.city_r_cm * p.art_ring_pm / 1000;
    if rr > p.plaza_cm * 2 {
        let road = streets.len() as u32;
        streets.push(Street { name: name("Boulevard"), kind: Kind::Arterial });
        let start = (0..16)
            .map(|k| DIR16[((2 * first + 2 + k) % 16) as usize])
            .map(|d| (d.0 * rr / ONE, d.1 * rr / ONE))
            .find(|&q| c.open(q) && g.edges.iter().all(|e| !e.alive || super::geom::nearest_on(q, g.nodes[e.a as usize], g.nodes[e.b as usize]).1 > (4 * SNAP_CM).pow(2)))
            .ok_or("no room for the arterial ring")?;
        let s = g.node(start);
        let steps = 7 * rr / ART_STEP_CM;
        let mut ring = trace(g, c, s, left(unit(start)), road, Some(rr), steps);
        if g.adj[s as usize].len() < 2 {
            let back = trace(g, c, s, neg(left(unit(start))), road, Some(rr), steps);
            ring.splice(0..0, back.into_iter().skip(1).rev());
        }
        chains.push(ring);
    }
    Ok(chains)
}

/// Trace one arterial from node `from`, heading `h`, until it leaves the city, meets
/// steep ground or water, or (a radial) meets another road. A ring (`ring`: its
/// radius) is pulled toward its radius and runs on through other roads until it
/// meets itself. Returns the chain of nodes it laid.
fn trace(g: &mut Graph, c: &Ctx, from: u32, h: P, road: u32, ring: Option<i64>, max_steps: i64) -> Vec<u32> {
    let mut chain = vec![from];
    let (mut u, mut h) = (from, h);
    for _ in 0..max_steps {
        let pos = g.nodes[u as usize];
        // the field's eigenvector nearest the heading, either family, either sign
        let (major, minor) = c.field.at(pos);
        let d = [major, neg(major), minor, neg(minor)].into_iter().max_by_key(|&v| (dot(v, h), v)).unwrap();
        let mut want = unit(add((h.0 * 2, h.1 * 2), d));
        if let Some(rr) = ring {
            let k = ((rr - len(pos)) * ONE / (rr / 3)).clamp(-ONE / 2, ONE / 2);
            let out = unit(pos);
            want = unit(add(want, (out.0 * k / ONE, out.1 * k / ONE)));
        }
        // the river ahead: over it on a bridge where one can stand
        let ahead = |k: i64| along(pos, want, ART_STEP_CM * k / 2);
        let river = c.river.is_some_and(|r| (1..=3).any(|k| r.zone(ahead(k))));
        if river {
            if let Some(b) = [0, 15, -15, 30, -30].into_iter().find_map(|deg| bridge(g, c, u, turn(want, deg), road)) {
                (u, h) = crossed(&mut chain, u, b);
                continue;
            }
        }
        // straight on if the land allows, else bend toward the contour (or, at the river
        // with no bridge to be had, along its bank)
        let bends: &[i64] = if river { &[0, 15, -15, 30, -30, 45, -45, 60, -60, 75, -75, 90, -90] } else { &[0, 15, -15, 30, -30, 45, -45] };
        let next = bends.iter().map(|&deg| {
            let dir = turn(want, deg);
            (dir, along(pos, dir, ART_STEP_CM))
        }).find(|&(_, q)| c.open(q) && c.gentle(pos, q));
        let Some((dir, q)) = next else {
            // held up at the river: straight across it, if a bridge can stand here
            match across(g, c, u, road) {
                Some(b) => {
                    (u, h) = crossed(&mut chain, u, b);
                    continue;
                }
                None => break,
            }
        };
        match g.fit(u, q, Kind::Arterial, road, SNAP_CM, MIN_CM, GAP_CM) {
            Fit::Free(v) => {
                chain.push(v);
                (u, h) = (v, dir);
            }
            Fit::Joined(v, met) => {
                chain.push(v);
                // met the river's bank: over it from there, or stop
                let wall = g.adj[v as usize].iter().any(|&e| g.edges[e as usize].kind == Kind::Water);
                if wall {
                    match across(g, c, v, road) {
                        Some(b) => {
                            (u, h) = crossed(&mut chain, v, b);
                            continue;
                        }
                        None => break,
                    }
                }
                if ring.is_none() || met == road {
                    break;
                }
                (u, h) = (v, unit(sub(g.nodes[v as usize], pos)));
            }
            Fit::Refused => break,
        }
    }
    chain
}

/// Is a bridge's middle `q` clear of the dock's bay and the port's apron (70 m from both)?
fn clear_of_docks(r: &River, q: P) -> bool {
    [r.dock.0, r.port.0].iter().all(|&d| dist2(q, d) >= 7_000 * 7_000)
}

/// How far apart (cm) the bridges in town stand, at most, where the arterials leave gaps.
const BRIDGE_EVERY_CM: i64 = 15_000;

/// Bridges along the river in town, wherever no bridge stands within `BRIDGE_EVERY_CM`
/// (the river's crossings nearest the plaza first): square across from bank to bank
/// between the river wall's own nodes (`wall`: the first's id), dry land past both, and
/// an arterial traced out from each end until it meets the city's roads. Each is a
/// street of its own, named from `names`. Returns the arterials' chains.
pub fn bridges(g: &mut Graph, c: &Ctx, wall: u32, streets: &mut Vec<Street>, names: &[&str]) -> Vec<Vec<u32>> {
    let Some(r) = c.river else { return Vec::new() };
    let mut order: Vec<(i64, usize)> = r.crossings.iter().enumerate().map(|(k, x)| (dist2(x.at, (0, 0)), k)).collect();
    order.sort();
    let mut chains = Vec::new();
    for (_, k) in order {
        let x = &r.crossings[k];
        let (l, rt) = (wall + x.left as u32, wall + x.right as u32);
        let (pl, pr) = (g.nodes[l as usize], g.nodes[rt as usize]);
        let near = g.edges.iter().any(|e| {
            e.alive && e.bridge && dist2(lerp(g.nodes[e.a as usize], g.nodes[e.b as usize], 1, 2), x.at) < BRIDGE_EVERY_CM * BRIDGE_EVERY_CM
        });
        let out = |q: P, n: P| along(q, n, BANK_CM);
        let ok = !near
            && c.open(out(pl, x.normal))
            && c.open(out(pr, neg(x.normal)))
            && clear_of_docks(r, x.at)
            && g.clear_between(l, rt)
            && g.angle_ok(l, pr)
            && g.angle_ok(rt, pl);
        if !ok {
            continue;
        }
        let road = streets.len() as u32;
        streets.push(Street { name: format!("{} Bridge", names[chains.len() / 2 % names.len()]), kind: Kind::Arterial });
        let b = g.link(l, rt, Kind::Arterial, road);
        g.edges[b as usize].bridge = true;
        let steps = c.p.city_r_cm / ART_STEP_CM * 2;
        let (left, right) = (trace(g, c, l, x.normal, road, None, steps), trace(g, c, rt, neg(x.normal), road, None, steps));
        // a bridge no road leaves on one side is no bridge (what was laid stays, a street to the bank)
        if left.len() < 2 || right.len() < 2 {
            g.kill(b);
        }
        chains.extend([left, right]);
    }
    chains
}

/// A bridge laid from node `u`: its nodes onto the chain; the far node and the heading.
fn crossed(chain: &mut Vec<u32>, u: u32, (near, far, dir): (u32, u32, P)) -> (u32, P) {
    if near != u {
        chain.push(near);
    }
    chain.push(far);
    (far, dir)
}

/// A bridge from node `u` square across the river nearby (within a step and its bank of
/// the water): toward the nearest stretch of its centre line, or up to 30 degrees off.
fn across(g: &mut Graph, c: &Ctx, u: u32, road: u32) -> Option<(u32, u32, P)> {
    let r = c.river?;
    let pos = g.nodes[u as usize];
    let center: Vec<P> = r.center.iter().map(|q| (q[0], q[1])).collect();
    let near = |line: &[P]| (1..line.len()).map(|k| (k, nearest_on(pos, line[k - 1], line[k]))).min_by_key(|&(k, (_, d2))| (d2, k));
    let (mut k, (mut foot, mut d2)) = near(&center)?;
    let mut line = &center;
    // @3: or a canal's, if nearer
    for arm in &r.arms {
        if let Some((ka, (fa, da))) = near(arm).filter(|a| a.1 .1 < d2) {
            (k, foot, d2, line) = (ka, fa, da, arm);
        }
    }
    let reach = ART_STEP_CM + BANK_CM + r.width_cm / 2 + BAY_REACH_CM;
    if d2 > reach * reach || foot == pos {
        return None;
    }
    // square to the river: along its normal, the way to the water
    let t = unit(sub(line[k], line[k - 1]));
    let n = if dot(left(t), sub(foot, pos)) > 0 { left(t) } else { neg(left(t)) };
    [0, 15, -15, 30, -30].into_iter().find_map(|deg| bridge(g, c, u, turn(n, deg), road))
}

/// How far (cm) the dock's bay widens the river: a bridge may start this much farther off.
const BAY_REACH_CM: i64 = 1_400;
/// cos 45 degrees (Q16): a bridge meets each bank at least this square.
const COS45: i64 = 46341;

/// A bridge from node `u` heading `dir`, if the river's bank is within a step ahead, the
/// water beyond it is crossed in under 1.6 times its width and banks (square to within
/// 45 degrees at both banks), away from the dock's bay and the port's apron, with open land
/// past the far bank.
/// Lays the approach to the near bank and the bridge to the far one, both ends on the
/// river's wall: (near node, far node, the heading).
fn bridge(g: &mut Graph, c: &Ctx, u: u32, dir: P, road: u32) -> Option<(u32, u32, P)> {
    let r = c.river?;
    if g.adj[u as usize].iter().any(|&e| g.edges[e as usize].bridge) {
        return None; // one bridge from a bank node
    }
    let a = g.nodes[u as usize];
    let span = (r.width_cm + 2 * BANK_CM) * 16 / 10;
    let far = along(a, dir, ART_STEP_CM + span);
    let mut hits: Vec<(i128, i128, u32)> = g
        .edges_in((a.0.min(far.0), a.1.min(far.1)), (a.0.max(far.0), a.1.max(far.1)))
        .into_iter()
        .filter(|&e| g.edges[e as usize].a != u && g.edges[e as usize].b != u)
        .filter_map(|e| {
            let x = &g.edges[e as usize];
            crossing(a, far, g.nodes[x.a as usize], g.nodes[x.b as usize]).map(|(num, den)| (num, den, e))
        })
        .collect();
    hits.sort_by(|x, y| (x.0 * y.1).cmp(&(y.0 * x.1)).then(x.2.cmp(&y.2)));
    let wall = |e: u32| g.edges[e as usize].kind == Kind::Water;
    // from a node on the bank itself the first wall met is the far bank's
    let on_wall = g.adj[u as usize].iter().find(|&&e| wall(e)).copied();
    let ((x1, e1), (n2, d2, e2)) = match (on_wall, &hits[..]) {
        (Some(e), [h, ..]) => ((a, e), *h),
        (None, [(n1, d1, e1), h, ..]) => ((lerp(a, far, *n1, *d1), *e1), *h),
        _ => return None,
    };
    let x2 = lerp(a, far, n2, d2);
    let mid = ((x1.0 + x2.0) / 2, (x1.1 + x2.1) / 2);
    let square = |e: u32| {
        let x = &g.edges[e as usize];
        dot(unit(sub(g.nodes[x.b as usize], g.nodes[x.a as usize])), dir).abs() <= (COS45 * ONE) as i128
    };
    let ok = wall(e1) && wall(e2) && e1 != e2 && x1 != x2
        && len(sub(x1, a)) <= ART_STEP_CM + BANK_CM && len(sub(x2, x1)) <= span
        && r.wet(mid) && square(e1) && square(e2)
        && clear_of_docks(r, mid)
        && c.open(along(x2, dir, BANK_CM));
    if !ok {
        return None;
    }
    let at = |g: &mut Graph, e: u32, x: P| {
        let (ea, eb) = (g.edges[e as usize].a, g.edges[e as usize].b);
        [ea, eb].into_iter().find(|&n| g.nodes[n as usize] == x).unwrap_or_else(|| g.split(e, x))
    };
    let near = if on_wall.is_some() { u } else { at(g, e1, x1) };
    let farn = at(g, e2, x2);
    if near != u {
        g.link(u, near, Kind::Arterial, road);
    }
    let b = g.link(near, farn, Kind::Arterial, road);
    g.edges[b as usize].bridge = true;
    Some((near, farn, dir))
}

struct Grow {
    node: u32,
    h: P,
    road: u32,
    /// Degrees it turns each step (a loop).
    bend: i64,
}

/// Grow the local streets off the arterials' `chains`, breadth first (every street
/// grows a step before any grows two), naming them from `names` in turn.
pub fn locals(g: &mut Graph, c: &Ctx, rng: &mut Rng, chains: &[Vec<u32>], streets: &mut Vec<Street>, names: &[&str]) {
    let mut queue: VecDeque<Grow> = VecDeque::new();
    let street = |streets: &mut Vec<Street>, suffix: &str| {
        let road = streets.len() as u32;
        let k = streets.len() % names.len();
        streets.push(Street { name: format!("{} {suffix}", names[k]), kind: Kind::Local });
        road
    };

    // side streets off the arterials, both sides, the district's spacing apart
    for chain in &chains[1..] {
        let mut acc = 0;
        for k in 1..chain.len().saturating_sub(1) {
            let (a, o, b) = (g.nodes[chain[k - 1] as usize], g.nodes[chain[k] as usize], g.nodes[chain[k + 1] as usize]);
            acc += len(sub(o, a));
            let Some(z) = c.zoning.at(o) else { continue };
            let ch = character(z.district);
            if !ch.grows || acc < ch.spacing_cm {
                continue;
            }
            acc = 0;
            let along = unit(sub(b, a));
            for side in [90, -90] {
                if rng.chance(850) {
                    let h = turn(along, side + rng.range(-3, 3) * 5);
                    let road = street(streets, ch.suffix);
                    let bend = if rng.chance(500) { ch.bend } else { -ch.bend };
                    queue.push_back(Grow { node: chain[k], h, road, bend });
                }
            }
        }
    }

    let mut grown = 0;
    while let Some(gw) = queue.pop_front() {
        if grown >= MAX_LOCAL {
            break;
        }
        let pos = g.nodes[gw.node as usize];
        let Some(z) = c.zoning.at(pos) else { continue };
        let ch = character(z.district);
        if !ch.grows {
            continue;
        }
        // the district's style: keep to its grid, or wander (and curl, for loops)
        let wander = rng.range(-ch.wander / 5, ch.wander / 5) * 5;
        let h = if ch.grid {
            let axes = [z.dir, neg(z.dir), left(z.dir), neg(left(z.dir))];
            let snapped = axes.into_iter().max_by_key(|&v| (dot(v, gw.h), v)).unwrap();
            turn(snapped, wander)
        } else {
            turn(gw.h, gw.bend + wander)
        };
        let l = ch.seg_cm * rng.range(85, 115) / 100;
        // bend round ground too steep to climb straight
        let next = [0, 15, -15, 30, -30].into_iter().map(|deg| {
            let dir = turn(h, deg);
            (dir, along(pos, dir, l))
        }).find(|&(_, q)| c.open(q) && len(q) > c.p.plaza_cm + SNAP_CM && c.gentle(pos, q));
        let Some((dir, q)) = next else { continue };
        match g.fit(gw.node, q, Kind::Local, gw.road, SNAP_CM, MIN_CM, GAP_CM) {
            Fit::Free(v) => {
                grown += 1;
                if !rng.chance(ch.end_pm) {
                    queue.push_back(Grow { node: v, h: dir, ..gw });
                }
                for side in [1, -1] {
                    if rng.chance(ch.branch_pm) {
                        // 60-120 degrees off the street
                        let h = turn(dir, side * (90 + rng.range(-6, 6) * 5));
                        let road = street(streets, ch.suffix);
                        queue.push_back(Grow { node: v, h, road, bend: side * ch.bend });
                    }
                }
            }
            Fit::Joined(..) => grown += 1,
            Fit::Refused => {}
        }
    }
}
