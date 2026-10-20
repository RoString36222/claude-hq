//! Islands (@2): both organic worlds stand in the sea. The Commons is the larger
//! island; a personal city (`user:<uuid>@2`) fills its own as it grows.
//!
//!   coast    a seeded coastline: radial noise on the radius, a star-shaped polygon
//!            round the plaza, kept clear of everything the city builds (the streets'
//!            reach and the ring road); `shape` sinks the land below the sea outside
//!            it and lifts it a beach above the sea inside it (the terrain hook)
//!   trim     on an island a highway ends at the ring: its tail out to the world's
//!            edge would run into the sea
//!   grow     a personal city is generated at full size once, and every lot, site
//!            and road gets the first city tier it exists in (`min_tier`; a site's
//!            `tier`): its ring, `radius_by_tier`, out from the plaza, and never
//!            before its spec tier or its road. The shore's sites (the dock and the
//!            port, on the river: river.rs) keep their spec tiers. A transit line
//!            runs from the tier all its stops and streets exist in. Growth only
//!            adds: nothing moves between tiers
//!
//! `layers.island` carries the coast, the sea level, the docks (the dock and port
//! sites, where ferries and boats tie up) and the tiers' radii. The Commons is always
//! fully grown (tier 5): its things carry no `min_tier`.
//!
//! Integer arithmetic only (cm, Q16, no trig), as the rest of the generator.

use std::collections::{BTreeMap, VecDeque};

use serde::Serialize;

use super::city::City;
use super::noise::{smoothstep, ONE};
use super::organic::geom::{add, along, centroid, cross, dist2, len, nearest_on, sub, unit, DIR16, P};
use super::profile::Profile;
use super::rng;
use super::roads::Roads;
use super::terrain::Terrain;
use super::transit::{door, Transit};

#[derive(Serialize)]
pub struct Island {
    /// The coast, [x, z] cm, counter-clockwise round the plaza.
    pub coast: Vec<[i64; 2]>,
    /// Sea level (cm): the land inside the coast stands above it, the sea bed outside below.
    pub sea_cm: i64,
    /// The dock and port sites' ids: where ferries and boats tie up.
    pub docks: Vec<String>,
    /// How far out from the plaza (cm) the city reaches at tiers 1 to 5.
    pub radius_by_tier: [i64; 5],
}

/// A personal city's reach at tiers 1 to 5 (cm). Another profile scales them to its
/// city's radius, so tier 5 is always the whole city.
pub const RADII_CM: [i64; 5] = [15_000, 25_000, 40_000, 60_000, 80_000];

/// Vertices round the coast (DIR16 halved three times): about 42 m apart on a personal island.
const COAST_N: usize = 128;
/// The coast's noise: (lattice cells round the island, weight), coarse to fine.
const OCTAVES: [(i64, i64); 3] = [(6, 4), (13, 2), (29, 1)];
/// The beach: the land blends down to a metre above the sea over this reach (cm)
/// inside the coast, never lower than a floor that rises this much (per mille) inland.
const BLEND_CM: i64 = 30_000;
const RISE_PM: i64 = 10;
/// The sea bed: a metre below the sea at the coast, falling this much (per mille) out
/// to this depth (cm) below the sea.
const SHELF_PM: i64 = 80;
const DEPTH_CM: i64 = 3_000;
/// The farthest a door may be from the road it opens onto (cm).
const REACH_CM: i64 = 20_000;

/// The seeded coastline of a world with a coast and a sea.
pub struct Coast {
    pub poly: Vec<P>,
    pub sea_cm: i64,
    /// Every vertex of the coast is between these radii (cm).
    pub lo: i64,
    pub hi: i64,
}

/// The coast's directions: DIR16, each gap halved three times (Q16 units, counter-clockwise).
pub(super) fn directions() -> Vec<P> {
    let mut dirs = DIR16.to_vec();
    while dirs.len() < COAST_N {
        let n = dirs.len();
        dirs = (0..n).flat_map(|k| [dirs[k], unit(add(dirs[k], dirs[(k + 1) % n]))]).collect();
    }
    dirs
}

/// Periodic value noise round the coast at vertex `i` of `n`: -32768..=32767.
fn wobble(seed: u64, i: usize, n: usize) -> i64 {
    let (mut sum, mut weight) = (0, 0);
    for (o, &(cells, w)) in OCTAVES.iter().enumerate() {
        let u = i as i64 * cells * ONE / n as i64;
        let (j, f) = (u / ONE, smoothstep(u % ONE));
        let at = |j: i64| (rng::sub(seed, "coast", o as i64, j % cells) >> 48) as i64 - 32768;
        sum += w * (at(j) + (at(j + 1) - at(j)) * f / ONE);
        weight += w;
    }
    sum / weight
}

/// The nearest the coast of a profile with a coast comes to the plaza (cm): 15 m clear
/// of the city's streets and of the ring road's radius plus a tenth. The ring road is
/// routed inside it (roads::graded), so it never runs into the sea.
pub fn lo_of(p: &Profile) -> Option<i64> {
    let (c, _) = (p.coast_r_cm?, p.sea_cm?);
    Some((p.city_r_cm.max(p.ring_r_cm * 11 / 10) + 1_500).min(c - 2_500))
}

impl Coast {
    /// The coast of a profile with `coast_r_cm` (the farthest it reaches, plus 25 m:
    /// the generator's "past the coast" circle is always at sea) and `sea_cm`. It keeps
    /// 15 m clear of the city's streets and of the ring road (its radius plus a tenth
    /// for its wander) and wobbles between that and its farthest.
    pub fn new(seed: u64, p: &Profile) -> Option<Coast> {
        let (c, sea_cm) = (p.coast_r_cm?, p.sea_cm?);
        let (lo, hi) = (lo_of(p)?, c - 2_500);
        let (mid, amp) = ((lo + hi) / 2, (hi - lo) / 2);
        let poly = directions().iter().enumerate().map(|(i, &d)| along((0, 0), d, mid + amp * wobble(seed, i, COAST_N) / 32768)).collect();
        Some(Coast { poly, sea_cm, lo, hi })
    }

    /// The coast's radius (cm) in q's direction: where the ray from the plaza through
    /// q leaves the island. The coast is star-shaped round the plaza, so one edge holds it.
    pub fn radius_at(&self, q: P) -> i64 {
        if q == (0, 0) {
            return self.lo;
        }
        let n = self.poly.len();
        let k = (0..n).find(|&k| cross(self.poly[k], q) >= 0 && cross(q, self.poly[(k + 1) % n]) > 0).unwrap_or(0);
        let (a, b) = (self.poly[k], self.poly[(k + 1) % n]);
        let ab = sub(b, a);
        (len(q) as i128 * cross(ab, a) / cross(ab, q)) as i64
    }

    /// Is q on the island (the coast itself is the land's edge)?
    pub fn land(&self, q: P) -> bool {
        len(q) <= self.radius_at(q)
    }

    /// The terrain hook: sink the land outside the coast below the sea (a shelf, then
    /// the deep), and keep the land inside it above the sea, blending down to a beach.
    pub fn shape(&self, t: &mut Terrain) {
        for iz in 0..t.n {
            for ix in 0..t.n {
                let q = t.vertex_pos(ix, iz);
                let r = len(q);
                // inland of the blend wherever the coast is, without finding its edge
                let s = if r + BLEND_CM < self.lo { BLEND_CM } else { self.radius_at(q) - r };
                let k = iz * t.n + ix;
                let h = t.heights[k] as i64;
                let h = if s >= 0 {
                    let floor = self.sea_cm + 100 + s.min(BLEND_CM) * RISE_PM / 1000;
                    let up = h.max(floor);
                    if s >= BLEND_CM { up } else { floor + (up - floor) * smoothstep(s * ONE / BLEND_CM) / ONE }
                } else {
                    (self.sea_cm - 100 + s * SHELF_PM / 1000).max(self.sea_cm - DEPTH_CM)
                };
                t.heights[k] = h as i32;
            }
        }
    }
}

/// The tiers' radii for a profile: `RADII_CM` scaled to its city.
pub fn radius_by_tier(p: &Profile) -> [i64; 5] {
    RADII_CM.map(|r| r * p.city_r_cm / RADII_CM[4])
}

/// The ring a point is in: the first tier whose radius reaches it (5 past them all).
fn ring(radii: &[i64; 5], q: P) -> u8 {
    let d = len(q);
    radii.iter().position(|&r| d <= r).unwrap_or(4) as u8 + 1
}

/// Drop every highway tail: a highway edge with an end no other road meets, until
/// none is left. What stays runs from the city to the ring (or to another highway).
pub fn trim(roads: &mut Roads) {
    let mut degree = vec![0usize; roads.nodes.len()];
    for e in &roads.edges {
        degree[e.a as usize] += 1;
        degree[e.b as usize] += 1;
    }
    let mut alive = vec![true; roads.edges.len()];
    loop {
        let mut changed = false;
        for (k, e) in roads.edges.iter().enumerate() {
            if alive[k] && e.class == "highway" && (degree[e.a as usize] == 1 || degree[e.b as usize] == 1) {
                alive[k] = false;
                degree[e.a as usize] -= 1;
                degree[e.b as usize] -= 1;
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }
    let mut renum = vec![u32::MAX; roads.nodes.len()];
    let mut nodes = Vec::new();
    for (k, n) in roads.nodes.iter().enumerate() {
        if degree[k] > 0 {
            renum[k] = nodes.len() as u32;
            nodes.push(super::roads::Node { id: nodes.len() as u32, ..n.clone() });
        }
    }
    let mut k = 0;
    roads.edges.retain(|_| {
        k += 1;
        alive[k - 1]
    });
    for (id, e) in roads.edges.iter_mut().enumerate() {
        (e.id, e.a, e.b) = (id as u32, renum[e.a as usize], renum[e.b as usize]);
    }
    roads.nodes = nodes;
}

/// The road a door opens onto: the edge nearest it within `reach` cm (ties to the lower edge).
fn road_at(r: &Roads, q: P, reach: i64) -> Option<usize> {
    r.edges
        .iter()
        .enumerate()
        .filter_map(|(k, e)| {
            let (x0, x1) = e.points.iter().fold((i64::MAX, i64::MIN), |m, s| (m.0.min(s[0]), m.1.max(s[0])));
            let (z0, z1) = e.points.iter().fold((i64::MAX, i64::MIN), |m, s| (m.0.min(s[2]), m.1.max(s[2])));
            if q.0 < x0 - reach || q.0 > x1 + reach || q.1 < z0 - reach || q.1 > z1 + reach {
                return None;
            }
            let d2 = e.points.windows(2).map(|s| nearest_on(q, (s[0][0], s[0][2]), (s[1][0], s[1][2])).1).min()?;
            (d2 <= reach * reach).then_some((d2, k))
        })
        .min()
        .map(|(_, k)| k)
}

/// Are these the shore's sites, where ferries and boats tie up? They open at their spec
/// tier (the dock 1, the port 3): the dock on the river's bank inside the first ring (its
/// quay a tier-1 street), the port on the river's basin.
pub fn shore(kind: &str) -> bool {
    matches!(kind, "dock" | "port")
}

/// Each road edge's first tier: the first tier in which the plaza reaches one of its
/// ends through nodes no farther out than that tier's ring (so an edge leading out of
/// a ring opens with it, and the roads present at a tier are one network).
fn edge_tiers(radii: &[i64; 5], r: &Roads) -> Vec<u8> {
    let n = r.nodes.len();
    let pos: Vec<P> = r.nodes.iter().map(|n| (n.x, n.z)).collect();
    let mut adj = vec![Vec::new(); n];
    for e in &r.edges {
        adj[e.a as usize].push(e.b as usize);
        adj[e.b as usize].push(e.a as usize);
    }
    let start = (0..n).min_by_key(|&k| (dist2(pos[k], (0, 0)), k)).unwrap_or(0);
    let mut reached = vec![5u8; n];
    let mut seen = vec![false; n];
    for t in 1..=5u8 {
        let mut queue: VecDeque<usize> = (0..n).filter(|&k| seen[k]).collect();
        if !seen[start] {
            seen[start] = true;
            reached[start] = t;
            queue.push_back(start);
        }
        while let Some(u) = queue.pop_front() {
            for &v in &adj[u] {
                if !seen[v] && ring(radii, pos[v]) <= t {
                    seen[v] = true;
                    reached[v] = t;
                    queue.push_back(v);
                }
            }
        }
    }
    r.edges.iter().map(|e| reached[e.a as usize].min(reached[e.b as usize])).collect()
}

/// The island layer, and on a personal island every thing's first tier. Runs once
/// every road, site and transit line is laid (after `civic::outside` and `transit`).
///
///   road edge  `edge_tiers`
///   lot        its ring, or its door's road's tier if later
///   site       its spec tier, its ring or its door's road's tier, whichever is
///              latest; the shore's (`shore`) their spec tier
///   line       its spec tier, or the latest of its stops and its path's streets:
///              a line runs only once all it calls at and drives along exists
///
/// Every tier is a number on a thing generated once at full size: growth only adds,
/// nothing moves. A block has no tier of its own (the contract has none): it shows
/// with the first lot or site on it.
pub fn grow(p: &Profile, coast: &Coast, roads: &mut Roads, city: &mut City, transit: &mut Transit) -> Island {
    let radii = radius_by_tier(p);
    let docks = city.sites.iter().filter(|s| shore(s.kind)).map(|s| s.id.clone()).collect();
    let island = Island { coast: coast.poly.iter().map(|q| [q.0, q.1]).collect(), sea_cm: coast.sea_cm, docks, radius_by_tier: radii };
    if p.name != "island" {
        return island;
    }

    let edge_t = edge_tiers(&radii, roads);
    for (e, t) in roads.edges.iter_mut().zip(&edge_t) {
        e.min_tier = Some(*t);
    }
    let on_road = |q: P| road_at(roads, q, REACH_CM).map_or(1, |e| edge_t[e]);
    for l in &mut city.lots {
        let poly: Vec<P> = l.poly.as_ref().map_or(vec![(l.x, l.z)], |v| v.iter().map(|q| (q[0], q[1])).collect());
        l.min_tier = Some(ring(&radii, centroid(&poly)).max(on_road((l.door[0], l.door[2]))));
    }
    for s in &mut city.sites {
        let spec = s.tier.unwrap_or(1);
        s.tier = Some(if shore(s.kind) { spec } else { spec.max(ring(&radii, (s.x, s.z))).max(on_road(door(s))) });
    }

    // a hop of a line's path exists once any street joining its two nodes does
    let mut hop: BTreeMap<(u32, u32), u8> = BTreeMap::new();
    for (e, &t) in roads.edges.iter().zip(&edge_t) {
        let h = hop.entry((e.a.min(e.b), e.a.max(e.b))).or_insert(t);
        *h = (*h).min(t);
    }
    let site_t: BTreeMap<&str, u8> = city.sites.iter().map(|s| (s.id.as_str(), s.tier.unwrap_or(1))).collect();
    for line in &mut transit.lines {
        let stops = line.stops.iter().map(|id| site_t.get(id.as_str()).copied().unwrap_or(5));
        let path = line.path.windows(2).map(|w| hop.get(&(w[0].min(w[1]), w[0].max(w[1]))).copied().unwrap_or(5));
        line.tier = stops.chain(path).fold(line.tier, u8::max);
    }
    island
}

#[cfg(test)]
#[path = "island_tests.rs"]
mod tests;
