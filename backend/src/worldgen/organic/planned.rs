//! City Gen v5 (generator version 4; docs/plans/city-gen-v5.md): the planned street network.
//!
//! The @2/@3 streets are grown: arterials traced through a tensor field, local streets
//! sprouting off them and bending as they go. v5 lays the city out as a plan instead, in the
//! order a city is planned, and every later street fits itself to what is already there
//! (`Graph::fit`: a crossing is a junction, a near end snaps to it):
//!
//!   1. the plaza: an octagon of arterial round it (as @3, so its sites and names stand)
//!   2. the radial avenues, straight out from the plaza's corners to the edge (or the shore)
//!   3. the ring boulevard, `art_ring_pm` of the city's radius out
//!   4. downtown: one orthogonal grid inside the ring, on an axis drawn once for the city,
//!      `DT_U` by `DT_V` blocks
//!   5. each sector between two avenues: its own grid, square to the sector's middle (so the
//!      streets meet their avenues square), its district's spacing
//!
//! A grid point inside a park with park all round it gets no street: a park is one block (a
//! superblock), room for its stadium, amusement park or lawn. Points on water, past the city,
//! in the river's zone or up a slope steeper than the city's grade are skipped. Integer
//! arithmetic and the city's own rng, as the rest of the generator.
use super::geom::{add, len, turn, unit, DIR16, P};
use super::graph::{Fit, Graph, Kind};
use super::streets::{Ctx, Street, MIN_CM, SNAP_CM};
use super::super::noise::ONE;
use super::super::profile::district;
use super::super::claims::Airport;
use super::super::rng::Rng;

/// Downtown's block (cm): along the axis, across it.
const DT_U: i64 = 11_000;
const DT_V: i64 = 8_500;
/// A sector's spacing (cm) when its district gives none: along the sector, across it.
const SEC_U: i64 = 13_000;
const SEC_V: i64 = 9_500;
/// An avenue's step (cm) and the gap a new segment's middle keeps to another road (cm).
const STEP_CM: i64 = 2_400;
const GAP_CM: i64 = 1_200;

/// Lays the planned network into `g` (empty but for the river's and pools' walls) and returns
/// the arterial chains (node lists): the plaza's octagon first, then the avenues, then the ring.
pub fn network(g: &mut Graph, c: &Ctx, rng: &mut Rng, streets: &mut Vec<Street>, art: &[&str], local: &[&str], keep: Option<&Airport>) -> Result<Vec<Vec<u32>>, String> {
    // the ground placed before the streets (the airport's claim): no street on it
    let free = |q: P| c.open(q) && !keep.is_some_and(|a| a.contains(q));
    let p = c.p;
    let mut art = art.iter();
    let mut named = |streets: &mut Vec<Street>, suffix: &str, kind: Kind| {
        let road = streets.len() as u32;
        let name = match kind {
            Kind::Arterial => format!("{} {suffix}", art.next().map_or("Grand", |s| *s)),
            _ => format!("{} {suffix}", local[(road as usize) % local.len().max(1)]),
        };
        streets.push(Street { name, kind });
        road
    };

    // 1. the plaza
    let circus = named(streets, "Circus", Kind::Arterial);
    let corners: Vec<u32> = (0..8).map(|k| {
        let d = DIR16[2 * k + 1];
        g.node((d.0 * p.plaza_cm / ONE, d.1 * p.plaza_cm / ONE))
    }).collect();
    for k in 0..8 {
        g.link(corners[k], corners[(k + 1) % 8], Kind::Arterial, circus);
    }
    let mut chains = vec![corners.iter().copied().chain(std::iter::once(corners[0])).collect::<Vec<u32>>()];

    // 2. the avenues: n of the eight corners, evenly spread, straight out
    let n = rng.range(p.radials.0, p.radials.1).clamp(3, 8) as usize;
    let first = rng.range(0, 7) as usize;
    let mut spokes: Vec<P> = Vec::new();
    for k in 0..n {
        let at = corners[(first + k * 8 / n) % 8];
        let dir = unit(g.nodes[at as usize]);
        spokes.push(dir);
        let road = named(streets, "Avenue", Kind::Arterial);
        let pts: Vec<P> = (1..).map(|i| add(g.nodes[at as usize], (dir.0 * STEP_CM * i / ONE, dir.1 * STEP_CM * i / ONE)))
            .take_while(|&q| len(q) <= p.city_r_cm * 97 / 100).collect();
        chains.push(lay(g, c, &free, at, &pts, Kind::Arterial, road));
    }

    // 3. the ring: 36 points, 10 degrees apart, laid from the first open one round to it again
    let rr = p.city_r_cm * p.art_ring_pm / 1000;
    if rr > p.plaza_cm * 2 {
        let road = named(streets, "Boulevard", Kind::Arterial);
        let ring: Vec<P> = (0..36).map(|k| { let d = turn((ONE, 0), k * 10); (d.0 * rr / ONE, d.1 * rr / ONE) }).collect();
        if let Some(s) = (0..36).find(|&k| free(ring[k])) {
            let start = start_at(g, ring[s]);
            let pts: Vec<P> = (1..=36).map(|i| ring[(s + i) % 36]).collect();
            chains.push(lay(g, c, &free, start, &pts, Kind::Arterial, road));
        }
    }

    // 4. downtown: one grid inside the ring
    let axis = turn((ONE, 0), rng.range(0, 89));
    let inner = if rr > p.plaza_cm * 2 { rr - 1_500 } else { p.city_r_cm * 34 / 100 };
    grid(g, c, &free, streets, &mut named, (0, 0), axis, DT_U, DT_V, &|q: P| len(q) > p.plaza_cm + 1_500 && len(q) < inner, "Street");

    // 5. the sectors between the avenues, each square to its middle
    let mut order: Vec<(i64, P)> = spokes.iter().map(|&d| (angle_pm(d), d)).collect();
    order.sort();
    let m = order.len();
    for k in 0..m {
        let (a0, d0) = order[k];
        let (mut a1, d1) = order[(k + 1) % m];
        if a1 <= a0 {
            a1 += 6_283;
        }
        let mid = turn((ONE, 0), ((a0 + a1) / 2 * 360 / 6_283) % 360);
        let (su, sv) = c.zoning.at((mid.0 * rr / ONE, mid.1 * rr / ONE))
            .map(|z| super::zoning::character(z.district))
            .filter(|ch| ch.grows && ch.spacing_cm > 0)
            .map_or((SEC_U, SEC_V), |ch| (ch.spacing_cm.max(9_000), ch.spacing_cm.max(9_000) * 3 / 4));
        let within = move |q: P| {
            let (x0, x1) = (cross(d0, q), cross(q, d1));
            len(q) >= rr + 1_500 && (if a1 - a0 < 3_142 { x0 > 0 && x1 > 0 } else { x0 > 0 || x1 > 0 })
        };
        grid(g, c, &free, streets, &mut named, (0, 0), mid, su, sv, &within, "Road");
    }
    Ok(chains)
}

/// An angle in thousandths of a radian, 0..6283, from +x toward +z (atan2 by octant on integers).
fn angle_pm(d: P) -> i64 {
    let a = (d.1 as f64).atan2(d.0 as f64);
    let a = if a < 0.0 { a + std::f64::consts::TAU } else { a };
    (a * 1000.0).round() as i64
}

fn cross(a: P, b: P) -> i128 {
    a.0 as i128 * b.1 as i128 - a.1 as i128 * b.0 as i128
}

/// A node at q: an existing one within the snap, else a new one.
fn start_at(g: &mut Graph, q: P) -> u32 {
    let lo = (q.0 - SNAP_CM, q.1 - SNAP_CM);
    let hi = (q.0 + SNAP_CM, q.1 + SNAP_CM);
    let near = g.edges_in(lo, hi).into_iter().flat_map(|e| [g.edges[e as usize].a, g.edges[e as usize].b])
        .filter(|&n| super::geom::dist2(g.nodes[n as usize], q) <= SNAP_CM * SNAP_CM).min();
    near.unwrap_or_else(|| g.node(q))
}

/// Lays a street from node `from` through `pts`, each segment fitted to what is there; a point
/// that is not free (water, past the city, the river's zone, ground placed before the streets) or
/// too steep to reach ends the street there. -> the nodes it passed through.
fn lay(g: &mut Graph, c: &Ctx, free: &dyn Fn(P) -> bool, from: u32, pts: &[P], kind: Kind, road: u32) -> Vec<u32> {
    let mut chain = vec![from];
    let mut at = from;
    for &q in pts {
        if !free(q) || !c.gentle(g.nodes[at as usize], q) {
            break;
        }
        match g.fit(at, q, kind, road, SNAP_CM, MIN_CM, GAP_CM) {
            Fit::Free(n) | Fit::Joined(n, _) => {
                if n != at {
                    chain.push(n);
                }
                at = n;
            }
            Fit::Refused => break,
        }
    }
    chain
}

/// A grid centred on `o`, `u` (a unit vector) along it, its cells `su` by `sv` cm, over the
/// points `within` accepts that are open and not inside a park (a park point with park on all
/// four sides is its superblock's inside). Each grid line is laid as runs of consecutive
/// points, one local street per run.
#[allow(clippy::too_many_arguments)] // the grid's place, axis, cells and where it runs
fn grid(g: &mut Graph, c: &Ctx, free: &dyn Fn(P) -> bool, streets: &mut Vec<Street>, named: &mut impl FnMut(&mut Vec<Street>, &str, Kind) -> u32,
        o: P, u: P, su: i64, sv: i64, within: &dyn Fn(P) -> bool, suffix: &str) {
    let v = (-u.1, u.0);
    let r = c.p.city_r_cm;
    let (nu, nv) = (r / su + 1, r / sv + 1);
    let at = |i: i64, j: i64| (o.0 + (u.0 * su * i + v.0 * sv * j) / ONE, o.1 + (u.1 * su * i + v.1 * sv * j) / ONE);
    let park = |q: P| c.zoning.at(q).is_some_and(|z| z.district == district::PARK);
    // a step over the grid's edge: onto open ground, never into the plaza
    let over = |q: P| free(q) && len(q) > c.p.plaza_cm + 1_500;
    let ok = |i: i64, j: i64| {
        let q = at(i, j);
        if !within(q) || !free(q) {
            return false;
        }
        // inside a park: no street (its edge keeps one, so the park is one block)
        !(park(q) && park(at(i + 1, j)) && park(at(i - 1, j)) && park(at(i, j + 1)) && park(at(i, j - 1)))
    };
    // the lines along u (j fixed), then across (i fixed)
    for (outer, inner, along) in [(nv, nu, true), (nu, nv, false)] {
        for a in -outer..=outer {
            let mut run: Vec<P> = Vec::new();
            for b in -inner..=inner + 1 {
                let (i, j) = if along { (b, a) } else { (a, b) };
                if b <= inner && ok(i, j) {
                    if run.is_empty() {
                        // and it starts one step back, over the edge it starts from
                        let (pi, pj) = if along { (b - 1, a) } else { (a, b - 1) };
                        if over(at(pi, pj)) {
                            run.push(at(pi, pj));
                        }
                    }
                    run.push(at(i, j));
                    continue;
                }
                // a run that ends at the grid's edge (not at water or the city's end) goes one step on, over the edge, so it
                // crosses the ring or the avenue there and joins it (Graph::fit makes the crossing a junction): every grid is
                // tied into the network, not an island of streets the generator would drop
                if !run.is_empty() && b <= inner && over(at(i, j)) {
                    run.push(at(i, j));
                }
                if run.len() >= 2 {
                    let road = named(streets, suffix, Kind::Local);
                    let s = start_at(g, run[0]);
                    lay(g, c, free, s, &run[1..], Kind::Local, road);
                }
                run.clear();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn angles_run_round_from_plus_x() {
        assert_eq!(angle_pm((ONE, 0)), 0);
        assert!((angle_pm((0, ONE)) - 1_571).abs() <= 1);
        assert!((angle_pm((-ONE, 0)) - 3_142).abs() <= 1);
        assert!((angle_pm((0, -ONE)) - 4_712).abs() <= 1);
    }
}
