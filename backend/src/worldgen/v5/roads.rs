//! City Gen v5: the road network. Arterials first (after the railways, before the buildings, so they have their room):
//!
//!   - the centres: Central, the port, the airport terminal's landside, every rail station, each district's middle (the
//!     home catchments by bearing, the industrial clusters, the offices); centres nearer than `MERGE_CM` are one;
//!   - the links: a spanning tree over the centres (shortest first) and every centre to Central;
//!   - each link routed over free ground on a `GRID_CM` grid (the airport, a rail ramp at the street, anything at the
//!     ground's level refuse a cell; a viaduct over it or a tunnel under it do not), a step turning at most 45 degrees
//!     and only after 80 m straight (no sharp turn, ever: two turns close together are one), paying for slope and turns; then simplified and its corners rounded into arcs of
//!     `R_ART_CM` (less only where its legs are short), checked in the volume again (a tighter `R_MIN_CM` curve if the
//!     wide one meets something, the grid's own path only if that does too);
//!   - carved at the ground's level: roads may meet roads (a junction), nothing else.
use std::cmp::Reverse;
use std::collections::{BinaryHeap, BTreeMap};

use super::airport::{Airport, APRON_W_CM, STRIP_W_CM};
use super::land::Land;
use super::landuse::Use;
use super::rail;
use super::space::Space;
use super::super::organic::geom::P;

pub const GRID_CM: i64 = 2_000;
pub const MERGE_CM: i64 = 12_000;
pub const R_ART_CM: f64 = 15_000.0;
pub const R_MIN_CM: f64 = 5_000.0;
pub const ART_HW_CM: i64 = 1_000;
pub const ROAD_UP_CM: i64 = 600;
const TURN_COST: i64 = 1_500;
/// Cells (20 m) a route runs straight after a turn before it may turn again.
const MIN_RUN: i64 = 4;
/// What a step costs (per mille of its length) on a laid arterial's cell, and beside one.
const SHARE_PM: i64 = 300;
const BESIDE_PM: i64 = 3_000;
const SLOPE_COST_PM: i64 = 20;
const SIMPLIFY_CM: f64 = 1_500.0;
const DIRS: [(i64, i64); 8] = [(1, 0), (1, 1), (0, 1), (-1, 1), (-1, 0), (-1, -1), (0, -1), (1, -1)];

#[derive(Clone, Debug)]
pub struct Road {
    pub class: &'static str,
    pub from: usize,
    pub to: usize,
    /// Its centre line [x, y (the ground), z] cm, every 4 m or so.
    pub points: Vec<[i64; 3]>,
    /// Its tightest curve (cm; infinite when straight), and whether the curve had to fall back to the grid's path.
    pub min_r: f64,
    pub fallback: bool,
}

fn d(a: P, b: P) -> i64 {
    ((a.0 - b.0) as f64).hypot((a.1 - b.1) as f64) as i64
}

fn centroid(ps: &[P]) -> Option<P> {
    (!ps.is_empty()).then(|| { let n = ps.len() as i64; (ps.iter().map(|q| q.0).sum::<i64>() / n, ps.iter().map(|q| q.1).sum::<i64>() / n) })
}

/// The places the arterials join.
pub fn centres(hub: P, port: Option<(P, P)>, ap: &Airport, rails: &[rail::Line], cells: &[(P, Use)]) -> Vec<P> {
    let mut out = vec![hub];
    if let Some((q, f)) = port {
        out.push((q.0 - f.0.signum() * 6_000, q.1 - f.1.signum() * 6_000));
    }
    // the terminal's landside: past the apron, off the airport
    let w = ap.side * (STRIP_W_CM / 2 + APRON_W_CM + 4_000);
    out.push((ap.c.0 - ap.dir.1 * w / 1000, ap.c.1 + ap.dir.0 * w / 1000));
    for l in rails {
        out.extend(l.stations.iter().copied());
    }
    let bearing = |q: P| ((q.1 - hub.1) as f64).atan2((q.0 - hub.0) as f64);
    for (u, groups) in [(Use::Home, 4usize), (Use::Industry, 2), (Use::Office, 1)] {
        let mut cs: Vec<(f64, P)> = cells.iter().filter(|(_, x)| *x == u).map(|(q, _)| (bearing(*q), *q)).collect();
        cs.sort_by(|a, b| a.0.total_cmp(&b.0));
        for g in 0..groups {
            let part: Vec<P> = cs[g * cs.len() / groups..(g + 1) * cs.len() / groups].iter().map(|x| x.1).collect();
            if let Some(c) = centroid(&part) {
                // (the cell of the group nearest its middle: a centroid can fall in a gap)
                if let Some(q) = part.iter().min_by_key(|&&q| d(q, c)) {
                    out.push(*q);
                }
            }
        }
    }
    let mut merged: Vec<P> = Vec::new();
    for q in out {
        if merged.iter().all(|&m| d(m, q) >= MERGE_CM) {
            merged.push(q);
        }
    }
    merged
}

/// The links: a spanning tree (Prim's, shortest first) and every centre to the first (Central).
pub fn links(cs: &[P]) -> Vec<(usize, usize)> {
    let n = cs.len();
    let mut inn = vec![false; n];
    let mut out = Vec::new();
    if n == 0 {
        return out;
    }
    inn[0] = true;
    for _ in 1..n {
        let best = (0..n).filter(|&i| inn[i]).flat_map(|i| (0..n).filter(|&j| !inn[j]).map(move |j| (i, j)))
            .min_by_key(|&(i, j)| (d(cs[i], cs[j]), i, j));
        if let Some((i, j)) = best {
            inn[j] = true;
            out.push((i, j));
        }
    }
    for j in 1..n {
        if !out.iter().any(|&(a, b)| (a, b) == (0, j) || (a, b) == (j, 0)) {
            out.push((0, j));
        }
    }
    out
}

/// The grid of free ground: which cells a road may cross.
struct Grid {
    n: i64,
    free: Vec<bool>,
    /// The cells a laid arterial runs through (a later route rides on them), and those beside them.
    road: Vec<bool>,
    beside: Vec<bool>,
}

impl Grid {
    fn new(land: &Land, space: &Space) -> Grid {
        let n = (land.p.city_r_cm + 10_000) / GRID_CM;
        let side = 2 * n + 1;
        let mut free = vec![false; (side * side) as usize];
        for i in -n..=n {
            for j in -n..=n {
                let q = (i * GRID_CM, j * GRID_CM);
                if q.0 * q.0 + q.1 * q.1 > (land.p.city_r_cm + 5_000).pow(2) || !land.dry(q) {
                    continue;
                }
                let g = land.height(q);
                let h = GRID_CM / 2;
                let sq = vec![(q.0 - h, q.1 - h), (q.0 + h, q.1 - h), (q.0 + h, q.1 + h), (q.0 - h, q.1 + h)];
                free[((i + n) * side + (j + n)) as usize] = space.blocker_but(&sq, g - 200, g + ROAD_UP_CM, 0, &["road"]).is_none();
            }
        }
        // a route keeps a cell (20 m) off anything: room for its curves to cut their corners (a 45 degree bend of R_ART_CM
        // moves 12 m into it)
        let at = |i: i64, j: i64| -> bool { i.abs() <= n && j.abs() <= n && free[((i + n) * side + (j + n)) as usize] };
        let roomy: Vec<bool> = (0..side * side).map(|k| {
            let (i, j) = (k / side - n, k % side - n);
            (-1..=1).all(|a| (-1..=1).all(|b| at(i + a, j + b)))
        }).collect();
        let m = roomy.len();
        Grid { n, free: roomy, road: vec![false; m], beside: vec![false; m] }
    }
    fn idx(&self, c: (i64, i64)) -> usize {
        let side = 2 * self.n + 1;
        ((c.0 + self.n) * side + (c.1 + self.n)) as usize
    }
    /// Marks a laid route's cells as road (and the cells round them as beside it).
    fn lay(&mut self, cells: &[(i64, i64)]) {
        for &c in cells {
            for a in -1..=1i64 {
                for b in -1..=1i64 {
                    let x = (c.0 + a, c.1 + b);
                    if x.0.abs() <= self.n && x.1.abs() <= self.n {
                        let k = self.idx(x);
                        if (a, b) == (0, 0) { self.road[k] = true; } else { self.beside[k] = true; }
                    }
                }
            }
        }
    }
    fn ok(&self, c: (i64, i64)) -> bool {
        let side = 2 * self.n + 1;
        c.0.abs() <= self.n && c.1.abs() <= self.n && self.free[((c.0 + self.n) * side + (c.1 + self.n)) as usize]
    }
    fn cell(&self, q: P) -> (i64, i64) {
        ((q.0 as f64 / GRID_CM as f64).round() as i64, (q.1 as f64 / GRID_CM as f64).round() as i64)
    }
    /// The free cell nearest q (within 10 cells).
    fn snap(&self, q: P) -> Option<(i64, i64)> {
        let c = self.cell(q);
        (0..=10i64).find_map(|r| {
            let mut ring: Vec<(i64, i64)> = (-r..=r).flat_map(|a| (-r..=r).map(move |b| (c.0 + a, c.1 + b))).filter(|x| (x.0 - c.0).abs().max((x.1 - c.1).abs()) == r && self.ok(*x)).collect();
            ring.sort_by_key(|x| ((x.0 - c.0).pow(2) + (x.1 - c.1).pow(2), *x));
            ring.first().copied()
        })
    }
}

/// The cheapest grid path from a to b turning at most 45 degrees a step, and only after `MIN_RUN` cells straight since
/// the last turn (two turns close together are one sharp bend): cells.
fn route(land: &Land, grid: &Grid, a: (i64, i64), b: (i64, i64)) -> Option<Vec<(i64, i64)>> {
    // the state: the cell, the heading, the straight run so far (capped at MIN_RUN)
    let key = |c: (i64, i64), k: usize, r: i64| (c, k, r);
    let h = |c: (i64, i64)| (((c.0 - b.0) as f64).hypot((c.1 - b.1) as f64) * GRID_CM as f64) as i64;
    let mut best: BTreeMap<((i64, i64), usize, i64), i64> = BTreeMap::new();
    let mut prev: BTreeMap<((i64, i64), usize, i64), ((i64, i64), usize, i64)> = BTreeMap::new();
    let mut heap = BinaryHeap::new();
    for k in 0..8 {
        best.insert(key(a, k, MIN_RUN), 0);
        heap.push(Reverse((h(a), 0i64, a, k, MIN_RUN)));
    }
    let ht = |c: (i64, i64)| land.height((c.0 * GRID_CM, c.1 * GRID_CM));
    while let Some(Reverse((_, g, c, k, run))) = heap.pop() {
        if c == b {
            let mut out = vec![c];
            let mut s = (c, k, run);
            while let Some(&p) = prev.get(&s) {
                out.push(p.0);
                s = p;
            }
            out.reverse();
            return Some(out);
        }
        if best.get(&key(c, k, run)).is_some_and(|&x| x < g) {
            continue;
        }
        for t in [0i64, 1, -1] {
            if t != 0 && run < MIN_RUN {
                continue;
            }
            let nr = if t == 0 { (run + 1).min(MIN_RUN) } else { 1 };
            let nk = ((k as i64 + t).rem_euclid(8)) as usize;
            let (dx, dz) = DIRS[nk];
            let nc = (c.0 + dx, c.1 + dz);
            if !grid.ok(nc) {
                continue;
            }
            let step = if dx != 0 && dz != 0 { GRID_CM * 1414 / 1000 } else { GRID_CM };
            let slope = (ht(nc) - ht(c)).abs() * 1000 / step;
            // riding a laid arterial is cheap; running alongside one (a parallel road) dear: routes merge into trunks
            let k2 = grid.idx(nc);
            let ride = if grid.road[k2] { step * SHARE_PM / 1000 } else if grid.beside[k2] { step * BESIDE_PM / 1000 } else { step };
            let ng = g + ride + step * slope / 1000 * SLOPE_COST_PM / 10 + if t != 0 { TURN_COST } else { 0 };
            if best.get(&key(nc, nk, nr)).is_none_or(|&x| ng < x) {
                best.insert(key(nc, nk, nr), ng);
                prev.insert(key(nc, nk, nr), (c, k, run));
                heap.push(Reverse((ng + h(nc), ng, nc, nk, nr)));
            }
        }
    }
    None
}

/// Ramer-Douglas-Peucker on points (cm).
fn simplify(p: &[(f64, f64)], tol: f64) -> Vec<(f64, f64)> {
    if p.len() < 3 {
        return p.to_vec();
    }
    let (a, b) = (p[0], p[p.len() - 1]);
    let (dx, dz) = (b.0 - a.0, b.1 - a.1);
    let l = dx.hypot(dz).max(1e-9);
    let (k, far) = (1..p.len() - 1).map(|i| (i, ((p[i].0 - a.0) * dz - (p[i].1 - a.1) * dx).abs() / l)).max_by(|x, y| x.1.total_cmp(&y.1)).unwrap();
    if far <= tol {
        return vec![a, b];
    }
    let mut left = simplify(&p[..=k], tol);
    let right = simplify(&p[k..], tol);
    left.pop();
    left.extend(right);
    left
}

/// A polyline's corners rounded into arcs of `r` (less where its legs are short: tangents within 0.45 of either leg).
/// -> points every ~4 m and the tightest radius used.
pub fn round(q: &[(f64, f64)], r: f64) -> (Vec<(f64, f64)>, f64) {
    let n = q.len();
    let mut out = vec![q[0]];
    let mut min_r = f64::INFINITY;
    let mut at = q[0];
    let line = |out: &mut Vec<(f64, f64)>, a: (f64, f64), b: (f64, f64)| {
        let l = (b.0 - a.0).hypot(b.1 - a.1);
        let m = (l / 400.0).ceil().max(1.0) as usize;
        for i in 1..=m {
            out.push((a.0 + (b.0 - a.0) * i as f64 / m as f64, a.1 + (b.1 - a.1) * i as f64 / m as f64));
        }
    };
    for i in 1..n.saturating_sub(1) {
        let (a, b, c) = (at, q[i], q[i + 1]);
        let (l1, l2) = ((b.0 - a.0).hypot(b.1 - a.1), (c.0 - b.0).hypot(c.1 - b.1));
        if l1 < 1.0 || l2 < 1.0 {
            continue;
        }
        let (d1, d2) = (((b.0 - a.0) / l1, (b.1 - a.1) / l1), ((c.0 - b.0) / l2, (c.1 - b.1) / l2));
        let th = (d1.0 * d2.0 + d1.1 * d2.1).clamp(-1.0, 1.0).acos();
        if th < 0.01 {
            line(&mut out, at, b);
            at = b;
            continue;
        }
        let tn = (th / 2.0).tan();
        let t = (r * tn).min(0.45 * l1.min(l2) * if i + 2 == n { 2.0 } else { 1.0 }).min(0.9 * l1);
        let rr = t / tn;
        min_r = min_r.min(rr);
        let sg = if d1.0 * d2.1 - d1.1 * d2.0 > 0.0 { 1.0 } else { -1.0 };
        let t1 = (b.0 - d1.0 * t, b.1 - d1.1 * t);
        let (cx, cz) = (t1.0 - d1.1 * rr * sg, t1.1 + d1.0 * rr * sg);
        line(&mut out, at, t1);
        let a0 = (t1.1 - cz).atan2(t1.0 - cx);
        let m = ((th * rr) / 400.0).ceil().max(2.0) as usize;
        for k in 1..=m {
            let an = a0 + sg * th * k as f64 / m as f64;
            out.push((cx + an.cos() * rr, cz + an.sin() * rr));
        }
        at = *out.last().unwrap();
    }
    line(&mut out, at, q[n - 1]);
    (out, min_r)
}

/// The road boxes along `pts` (at the ground there), free of everything but roads?
fn clear(land: &Land, space: &Space, pts: &[(f64, f64)], hw: i64) -> bool {
    pts.windows(2).all(|w| {
        let (a, b) = w.split_at(1);
        let (a, b) = (a[0], b[0]);
        let (dx, dz) = (b.0 - a.0, b.1 - a.1);
        let l = dx.hypot(dz).max(1.0);
        let (nx, nz) = (-dz / l * hw as f64, dx / l * hw as f64);
        let poly = vec![((a.0 + nx) as i64, (a.1 + nz) as i64), ((b.0 + nx) as i64, (b.1 + nz) as i64), ((b.0 - nx) as i64, (b.1 - nz) as i64), ((a.0 - nx) as i64, (a.1 - nz) as i64)];
        let g = land.height((a.0 as i64, a.1 as i64)).min(land.height((b.0 as i64, b.1 as i64)));
        space.blocker_but(&poly, g - 200, g + ROAD_UP_CM, 0, &["road"]).is_none()
    })
}

/// The arterials between the centres, carved in the volume.
pub fn arterials(land: &Land, space: &mut Space, cs: &[P]) -> Vec<Road> {
    let mut grid = Grid::new(land, space);
    let mut out = Vec::new();
    for (i, j) in links(cs) {
        let (Some(a), Some(b)) = (grid.snap(cs[i]), grid.snap(cs[j])) else { continue };
        let Some(cells) = route(land, &grid, a, b) else { continue };
        grid.lay(&cells);
        let raw: Vec<(f64, f64)> = cells.iter().map(|c| ((c.0 * GRID_CM) as f64, (c.1 * GRID_CM) as f64)).collect();
        let simple = simplify(&raw, SIMPLIFY_CM);
        let (mut pts, mut min_r) = round(&simple, R_ART_CM);
        let mut fallback = false;
        if !clear(land, space, &pts, ART_HW_CM) {
            (pts, min_r) = round(&simple, R_MIN_CM);
            if !clear(land, space, &pts, ART_HW_CM) {
                (pts, min_r, fallback) = (raw.clone(), f64::INFINITY, true);
            }
        }
        let points: Vec<[i64; 3]> = pts.iter().map(|p| [p.0 as i64, land.height((p.0 as i64, p.1 as i64)), p.1 as i64]).collect();
        for w in points.windows(2) {
            let (a, b) = ((w[0][0] as f64, w[0][2] as f64), (w[1][0] as f64, w[1][2] as f64));
            let (dx, dz) = (b.0 - a.0, b.1 - a.1);
            let l = dx.hypot(dz).max(1.0);
            let (nx, nz) = (-dz / l * ART_HW_CM as f64, dx / l * ART_HW_CM as f64);
            let poly = vec![((a.0 + nx) as i64, (a.1 + nz) as i64), ((b.0 + nx) as i64, (b.1 + nz) as i64), ((b.0 - nx) as i64, (b.1 - nz) as i64), ((a.0 - nx) as i64, (a.1 - nz) as i64)];
            let g = w[0][1].min(w[1][1]);
            space.put("road", "arterial", poly, g - 200, g + ROAD_UP_CM);
        }
        out.push(Road { class: "arterial", from: i, to: j, points, min_r, fallback });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::super::City;

    #[test]
    fn the_arterials_join_every_centre_and_never_turn_sharply() {
        let c = City::plan("claude-hq").unwrap();
        let n = c.centres.len();
        assert!(n >= 6, "{n} centres");
        // every centre joined to Central through the arterials
        let mut parent: Vec<usize> = (0..n).collect();
        fn find(p: &mut Vec<usize>, x: usize) -> usize { if p[x] != x { let r = find(p, p[x]); p[x] = r; } p[x] }
        for r in &c.arterials {
            let (a, b) = (find(&mut parent, r.from), find(&mut parent, r.to));
            parent[a] = b;
        }
        let root = find(&mut parent, 0);
        assert!((0..n).all(|i| find(&mut parent, i) == root), "every centre reached");
        for r in &c.arterials {
            assert!(!r.fallback, "arterial {} - {}: no curve fitted", r.from, r.to);
            assert!(r.min_r >= 3_000.0, "arterial {} - {}: a {:.0} m curve", r.from, r.to, r.min_r / 100.0);
        }
    }

    #[test]
    fn no_building_stands_on_an_arterial() {
        let c = City::plan("claude-hq").unwrap();
        for b in &c.landuse.buildings {
            let s = &c.space.solids[b.solid as usize];
            assert!(c.space.solids.iter().filter(|o| o.kind == "road").all(|o| !(o.y0 < s.y1 && s.y0 < o.y1 && super::super::space::near(&o.poly, &s.poly, 1))), "building {}", b.id);
        }
    }
}
