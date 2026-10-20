//! Growing the street network. First the arterials: a ring round the plaza, radials
//! traced out from it through the tensor field (bending to follow the land and the
//! districts' grids) and an arterial ring traced round the middle of the city along
//! the field's other family. Then local streets grow off them L-system style (Parish
//! & Muller 2001): each step extends a street, may branch at 60-120 degrees, snaps
//! to a junction within 12 m, and stops at steep ground or water, every district
//! growing in its own character.

use std::collections::VecDeque;

use super::geom::{add, along, dot, left, len, sub, turn, unit, DIR16, P};
use super::graph::{Fit, Graph, Kind};
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
const MIN_CM: i64 = 800;
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

    /// Inside the city, on dry land.
    fn open(&self, q: P) -> bool {
        len(q) <= self.p.city_r_cm && !self.wet(q)
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
    streets.push(Street { name: name("Circus"), kind: Kind::Arterial });
    let corners: Vec<u32> = (0..8).map(|k| {
        let d = DIR16[2 * k + 1];
        g.node((d.0 * p.plaza_cm / ONE, d.1 * p.plaza_cm / ONE))
    }).collect();
    for k in 0..8 {
        g.link(corners[k], corners[(k + 1) % 8], Kind::Arterial, 0);
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
        // straight on if the land allows, else bend toward the contour
        let next = [0, 15, -15, 30, -30, 45, -45].into_iter().map(|deg| {
            let dir = turn(want, deg);
            (dir, along(pos, dir, ART_STEP_CM))
        }).find(|&(_, q)| c.open(q) && c.gentle(pos, q));
        let Some((dir, q)) = next else { break };
        match g.fit(u, q, Kind::Arterial, road, SNAP_CM, MIN_CM, GAP_CM) {
            Fit::Free(v) => {
                chain.push(v);
                (u, h) = (v, dir);
            }
            Fit::Joined(v, met) => {
                chain.push(v);
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
