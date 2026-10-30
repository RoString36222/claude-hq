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
//!   - carved at the ground's level: roads may meet roads (a junction), nothing else;
//!   - Central a circus: a ring of `RING_CM` round the plaza (the metro's hub under it), laid first; no route crosses
//!     it or the plaza, an avenue to Central ends on a spoke, its last `SPOKE_CM` straight and square to the ring (one
//!     spoke for avenues whose bearings are within `SPOKE_SEP` of each other), its turn onto the spoke rounded.
use std::cmp::Reverse;
use std::collections::{BinaryHeap, BTreeMap};

use super::airport::Airport;
use super::land::Land;
use super::landuse::Use;
use super::rail;
use super::space::Space;
use super::super::organic::geom::{inside, P};

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
/// An arterial's point this near (cm) one laid before rides on it.
const SHARED_CM: f64 = 1_000.0;
/// Central's circus: the ring's centre line (cm from the hub), the spokes' straight run square to it, the least angle
/// (radians) between two spokes (their junctions on the ring over 30 m apart).
pub const RING_CM: f64 = 4_800.0;
const SPOKE_CM: f64 = 6_000.0;
const SPOKE_SEP: f64 = 1.2;
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
    out.push(super::airport::landside(ap.c, ap.dir, ap.side));
    for l in rails {
        // (the terminal's station is reached through the terminal: its landside is the centre)
        out.extend(l.stations.iter().copied().filter(|&q| !super::super::organic::geom::inside(q, &ap.poly)));
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
    /// Over the river (a bridge): a road crosses it straight, and dearly.
    wet: Vec<bool>,
}

impl Grid {
    fn new(land: &Land, space: &Space) -> Grid {
        let n = (land.p.city_r_cm + 10_000) / GRID_CM;
        let side = 2 * n + 1;
        let mut free = vec![false; (side * side) as usize];
        let mut wet = vec![false; (side * side) as usize];
        for i in -n..=n {
            for j in -n..=n {
                let q = (i * GRID_CM, j * GRID_CM);
                if q.0 * q.0 + q.1 * q.1 > (land.p.city_r_cm + 5_000).pow(2) {
                    continue;
                }
                // the river's banks and water are bridged (inside the coast, off the lakes, canals and marina)
                let river = land.river.as_ref().is_some_and(|r| r.zone(q))
                    && land.coast.as_ref().is_none_or(|c| inside(q, &c.poly))
                    && !land.water.iter().any(|w| inside(q, w));
                if !land.dry(q) && !river {
                    continue;
                }
                if river {
                    wet[((i + n) * side + (j + n)) as usize] = true;
                }
                let g = land.height(q);
                let h = GRID_CM / 2;
                let sq = vec![(q.0 - h, q.1 - h), (q.0 + h, q.1 - h), (q.0 + h, q.1 + h), (q.0 - h, q.1 + h)];
                free[((i + n) * side + (j + n)) as usize] = space.blocker_but(&sq, g - 200, g + ROAD_UP_CM, 0, &["road", "water"]).is_none();
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
        Grid { n, free: roomy, road: vec![false; m], beside: vec![false; m], wet }
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
    /// Shuts the cells within `r` (cm) of q: no route enters them.
    fn shut(&mut self, q: P, r: f64) {
        let side = 2 * self.n + 1;
        for k in 0..(side * side) as usize {
            let (i, j) = (k as i64 / side - self.n, k as i64 % side - self.n);
            if ((i * GRID_CM - q.0) as f64).hypot((j * GRID_CM - q.1) as f64) <= r {
                self.free[k] = false;
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
            // a bridge runs straight: no turn on it or onto it
            if t != 0 && (grid.wet[k2] || grid.wet[grid.idx(c)]) {
                continue;
            }
            let ride = if grid.wet[k2] { step * BRIDGE_PM / 1000 } else if grid.road[k2] { step * SHARE_PM / 1000 } else if grid.beside[k2] { step * BESIDE_PM / 1000 } else { step };
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
        // (over the water: a bridge, its deck the client's)
        space.blocker_but(&poly, g - 200, g + ROAD_UP_CM, 0, &["road", "water"]).is_none()
    })
}

/// Central's ring (closed: its last point its first), every ~4 m round `hub`.
fn ring(hub: P) -> Vec<(f64, f64)> {
    let n = (std::f64::consts::TAU * RING_CM / 400.0).ceil() as usize;
    (0..=n).map(|k| { let a = std::f64::consts::TAU * (k % n) as f64 / n as f64; (hub.0 as f64 + a.cos() * RING_CM, hub.1 as f64 + a.sin() * RING_CM) }).collect()
}

/// Where no route goes round Central's ring (cm from the hub): the ring, the plaza inside it, a cell's room beyond.
const RING_SHUT_CM: f64 = RING_CM + ART_HW_CM as f64 + GRID_CM as f64;

/// The arterials between the centres, carved in the volume: Central's ring first (when it is clear), then the links.
pub fn arterials(land: &Land, space: &mut Space, cs: &[P]) -> Vec<Road> {
    let mut grid = Grid::new(land, space);
    let mut out = Vec::new();
    let hub = cs.first().copied().unwrap_or((0, 0));
    let circus = !cs.is_empty() && clear(land, space, &ring(hub), ART_HW_CM);
    if circus {
        let points = carve(land, space, &ring(hub));
        out.push(Road { class: "arterial", from: 0, to: 0, points, min_r: RING_CM, fallback: false });
        // (out to the spokes' ends: inside them a route is a spoke, straight)
        grid.shut(hub, RING_CM + SPOKE_CM - GRID_CM as f64);
    }
    // the spokes' bearings so far
    let mut spokes: Vec<f64> = Vec::new();
    for (i, j) in links(cs) {
        // a link to Central (on a circus) runs to its spoke: the spoke's outer end, then straight in to the ring
        let spoke = (circus && (i == 0 || j == 0)).then(|| {
            let o = cs[if i == 0 { j } else { i }];
            let a = ((o.1 - hub.1) as f64).atan2((o.0 - hub.0) as f64);
            let off = |b: f64| (a - b + std::f64::consts::PI).rem_euclid(std::f64::consts::TAU) - std::f64::consts::PI;
            let a = spokes.iter().copied().filter(|&b| off(b).abs() < SPOKE_SEP).min_by(|x, y| off(*x).abs().total_cmp(&off(*y).abs())).unwrap_or(a);
            if !spokes.contains(&a) {
                spokes.push(a);
            }
            let at = |r: f64| (hub.0 as f64 + a.cos() * r, hub.1 as f64 + a.sin() * r);
            (o, at(RING_CM + SPOKE_CM), at(RING_CM))
        });
        let (p, q) = match spoke { Some((o, s, _)) => (o, (s.0 as i64, s.1 as i64)), None => (cs[i], cs[j]) };
        let (Some(a), Some(b)) = (grid.snap(p), grid.snap(q)) else { continue };
        let Some(cells) = route(land, &grid, a, b) else { continue };
        grid.lay(&cells);
        let mut raw: Vec<(f64, f64)> = cells.iter().map(|c| ((c.0 * GRID_CM) as f64, (c.1 * GRID_CM) as f64)).collect();
        let simple = match spoke {
            // (the snapped cell is the spoke's end, exactly; the spoke itself kept whole by the simplifying)
            Some((_, s, r)) => {
                raw.pop();
                raw.push(s);
                let mut v = simplify(&raw, SIMPLIFY_CM);
                v.push(r);
                raw.push(r);
                v
            }
            None => simplify(&raw, SIMPLIFY_CM),
        };
        let (mut pts, mut min_r) = round(&simple, R_ART_CM);
        let mut fallback = false;
        if !clear(land, space, &pts, ART_HW_CM) {
            (pts, min_r) = round(&simple, R_MIN_CM);
            if !clear(land, space, &pts, ART_HW_CM) {
                (pts, min_r, fallback) = (raw.clone(), f64::INFINITY, true);
            }
        }
        // where it rides an arterial already laid, that one is the road: only the runs off it are kept, each from the
        // point it leaves that road (moved onto it), so a shared trunk is one road and a branch peels off it on its curve
        let foot = |q: (f64, f64)| -> Option<(f64, f64)> {
            out.iter().flat_map(|r: &Road| r.points.windows(2)).map(|w| {
                let (c, e) = ((w[0][0] as f64, w[0][2] as f64), (w[1][0] as f64, w[1][2] as f64));
                let (ex, ez) = (e.0 - c.0, e.1 - c.1);
                let t = (((q.0 - c.0) * ex + (q.1 - c.1) * ez) / (ex * ex + ez * ez).max(1.0)).clamp(0.0, 1.0);
                (c.0 + t * ex, c.1 + t * ez)
            }).min_by(|a, b| (a.0 - q.0).hypot(a.1 - q.1).total_cmp(&(b.0 - q.0).hypot(b.1 - q.1)))
        };
        let feet: Vec<Option<(f64, f64)>> = pts.iter().map(|&q| foot(q)).collect();
        let within = |k: usize, r: f64| feet[k].is_some_and(|f| (f.0 - pts[k].0).hypot(f.1 - pts[k].1) < r);
        let on: Vec<Option<(f64, f64)>> = (0..pts.len()).map(|k| feet[k].filter(|_| within(k, SHARED_CM))).collect();
        let mut k = 0;
        while k < pts.len() {
            if on[k].is_some() { k += 1; continue; }
            let k0 = k;
            while k < pts.len() && on[k].is_none() { k += 1; }
            let mut run: Vec<(f64, f64)> = pts[k0..k].to_vec();
            if let Some(f) = k0.checked_sub(1).and_then(|j| on[j]) { run.insert(0, f); }
            if let Some(f) = on.get(k).copied().flatten() { run.push(f); }
            // (a run between two stretches on a laid road that never leaves its carriageway runs beside it: the
            // laid road is the road there)
            if run.len() < 2 || (k0 > 0 && k < pts.len() && (k0..k).all(|x| within(x, 2.0 * ART_HW_CM as f64))) { continue; }
            let points = carve(land, space, &run);
            out.push(Road { class: "arterial", from: i, to: j, points, min_r, fallback });
        }
    }
    out
}

/// A road's level over a-b: the ground's `g`, or over the water a bridge's, its underside clear of the boats.
fn deck(land: &Land, a: (f64, f64), b: (f64, f64), g: i64) -> i64 {
    [a, b, ((a.0 + b.0) / 2.0, (a.1 + b.1) / 2.0)].iter().filter_map(|q| land.water_top((q.0 as i64, q.1 as i64))).map(|t| t + 200).fold(g, i64::max)
}

/// An arterial's points on the ground, its box carved along them.
fn carve(land: &Land, space: &mut Space, pts: &[(f64, f64)]) -> Vec<[i64; 3]> {
    let points: Vec<[i64; 3]> = pts.iter().map(|p| [p.0 as i64, land.height((p.0 as i64, p.1 as i64)), p.1 as i64]).collect();
    for w in points.windows(2) {
        let (a, b) = ((w[0][0] as f64, w[0][2] as f64), (w[1][0] as f64, w[1][2] as f64));
        let mut g = deck(land, a, b, w[0][1].min(w[1][1]));
        let bx = box_of(a, b, ART_HW_CM);
        // (a box that only grazes the water's cells at a low bank: up over them too)
        while let Some(k) = space.blocker(&bx, g - 200, g + ROAD_UP_CM, 0).filter(|&k| space.solids[k as usize].kind == "water") {
            g = space.solids[k as usize].y1 + 200;
        }
        space.put("road", "arterial", bx, g - 200, g + ROAD_UP_CM);
    }
    points
}

#[cfg(test)]
mod tests {

    #[test]
    fn the_arterials_join_every_centre_and_never_turn_sharply() {
        let c = super::super::commons();
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
        let lost: Vec<(i64, i64)> = (0..n).filter(|&i| find(&mut parent, i) != root).map(|i| c.centres[i]).collect();
        assert!(lost.is_empty(), "every centre reached: not {lost:?} (airport landside {:?})", super::super::airport::landside(c.airport.c, c.airport.dir, c.airport.side));
        for r in &c.arterials {
            assert!(!r.fallback, "arterial {} - {}: no curve fitted", r.from, r.to);
            assert!(r.min_r >= 3_000.0, "arterial {} - {}: a {:.0} m curve", r.from, r.to, r.min_r / 100.0);
        }
    }

    #[test]
    fn central_is_a_circus_its_avenues_square_to_the_ring() {
        let c = super::super::commons();
        let hub = c.centres[0];
        let r = |p: &[i64; 3]| ((p[0] - hub.0) as f64).hypot((p[2] - hub.1) as f64);
        let ring = c.arterials.iter().find(|a| (a.from, a.to) == (0, 0)).expect("Central's ring");
        assert!(ring.points.iter().all(|p| (r(p) - super::RING_CM).abs() < 100.0) && ring.points.first() == ring.points.last());
        let mut spokes = 0;
        for a in c.arterials.iter().filter(|a| (a.from, a.to) != (0, 0)) {
            // nothing crosses the ring or the plaza
            assert!(a.points.iter().all(|p| r(p) > super::RING_CM - 100.0), "arterial {} - {} inside the ring", a.from, a.to);
            for (e, f) in [(&a.points[0], &a.points[a.points.len().min(4) - 1]), (a.points.last().unwrap(), &a.points[a.points.len().saturating_sub(4)])] {
                if (r(e) - super::RING_CM).abs() > 100.0 {
                    continue;
                }
                // its last 12 m on the ring square to it (within 10 degrees of the radius)
                spokes += 1;
                let (dx, dz) = ((f[0] - e[0]) as f64, (f[2] - e[2]) as f64);
                let (rx, rz) = ((e[0] - hub.0) as f64, (e[2] - hub.1) as f64);
                let cos = (dx * rx + dz * rz) / (dx.hypot(dz) * rx.hypot(rz)).max(1.0);
                assert!(cos > 10f64.to_radians().cos(), "arterial {} - {} meets the ring askew", a.from, a.to);
            }
        }
        assert!(spokes >= 3, "{spokes} spokes");
    }

    #[test]
    fn no_building_stands_on_an_arterial() {
        let c = super::super::commons();
        for b in &c.landuse.buildings {
            let s = &c.space.solids[b.solid as usize];
            assert!(c.space.solids.iter().filter(|o| o.kind == "road").all(|o| !(o.y0 < s.y1 && s.y0 < o.y1 && super::super::space::near(&o.poly, &s.poly, 1))), "building {}", b.id);
        }
    }
}

/// A local street's half width (cm).
pub const LOCAL_HW_CM: i64 = 450;
/// A street within this (cm) of another's end or line joins it.
/// A bridge's cost over the same run on land (per mille).
const BRIDGE_PM: i64 = 4_000;
pub const JOIN_CM: i64 = 1_500;
/// A street within this (cm) of a laid road and running its way is alongside it.
const ALONG_CM: i64 = 1_200;

/// The plots each use's buildings stand on (landuse.rs build()): their size along x and z (cm).
pub fn plot(u: Use) -> (i64, i64) {
    match u {
        Use::Industry => (8_400, 6_400),
        Use::Office => (5_200, 5_200),
        _ => (4_400, 3_800),
    }
}

fn box_of(a: (f64, f64), b: (f64, f64), hw: i64) -> Vec<P> {
    let (dx, dz) = (b.0 - a.0, b.1 - a.1);
    let l = dx.hypot(dz).max(1.0);
    let (nx, nz) = (-dz / l * hw as f64, dx / l * hw as f64);
    vec![((a.0 + nx) as i64, (a.1 + nz) as i64), ((b.0 + nx) as i64, (b.1 + nz) as i64), ((b.0 - nx) as i64, (b.1 - nz) as i64), ((a.0 - nx) as i64, (a.1 - nz) as i64)]
}

/// After the buildings: the local streets along the gaps between their plots (each use's lattice, a street wherever a
/// building of that use stands on either side and the way is free), then every street network that does not touch an
/// arterial joined to the nearest by a link routed as the arterials are (no sharp turns).
pub fn locals(land: &Land, space: &mut Space, hub: P, buildings: &[super::landuse::Building], arterials: &[Road]) -> Vec<Road> {
    let mut out: Vec<Road> = Vec::new();
    // the roads laid so far, by ALONG_CM cell, as segments: a street may cross one, never run along it
    let mut laid: BTreeMap<(i64, i64), Vec<((f64, f64), (f64, f64))>> = BTreeMap::new();
    let lay = |laid: &mut BTreeMap<(i64, i64), Vec<((f64, f64), (f64, f64))>>, pts: &[(f64, f64)]| {
        for w in pts.windows(2) {
            let m = ((w[0].0 + w[1].0) / 2.0, (w[0].1 + w[1].1) / 2.0);
            laid.entry(((m.0 as i64).div_euclid(ALONG_CM), (m.1 as i64).div_euclid(ALONG_CM))).or_default().push((w[0], w[1]));
        }
    };
    for r in arterials {
        let pts: Vec<(f64, f64)> = r.points.iter().map(|p| (p[0] as f64, p[2] as f64)).collect();
        lay(&mut laid, &pts);
    }
    let alongside = |laid: &BTreeMap<(i64, i64), Vec<((f64, f64), (f64, f64))>>, a: (f64, f64), b: (f64, f64)| -> bool {
        let m = ((a.0 + b.0) / 2.0, (a.1 + b.1) / 2.0);
        let (dx, dz) = (b.0 - a.0, b.1 - a.1);
        let l = dx.hypot(dz).max(1.0);
        let (kx, kz) = ((m.0 as i64).div_euclid(ALONG_CM), (m.1 as i64).div_euclid(ALONG_CM));
        (kx - 1..=kx + 1).any(|x| (kz - 1..=kz + 1).any(|z| laid.get(&(x, z)).is_some_and(|v| v.iter().any(|&(c, e)| {
            let (ex, ez) = (e.0 - c.0, e.1 - c.1);
            let le = ex.hypot(ez).max(1.0);
            let t = (((m.0 - c.0) * ex + (m.1 - c.1) * ez) / (le * le)).clamp(0.0, 1.0);
            let dd = (m.0 - c.0 - t * ex).hypot(m.1 - c.1 - t * ez);
            dd < ALONG_CM as f64 && ((dx * ex + dz * ez) / (l * le)).abs() > 0.8
        }))))
    };
    for u in [Use::Industry, Use::Office, Use::Home] {
        let (pw, pd) = plot(u);
        let mine: std::collections::BTreeSet<(i64, i64)> = buildings.iter().filter(|b| b.use_ == u)
            .map(|b| ((b.c.0 - hub.0) / pw, (b.c.1 - hub.1) / pd)).collect();
        // the lattice's gap lines: x = (i + 1/2) pw between plots i and i+1, run along z; z likewise
        for (along_z, (s0, s1)) in [(true, (pw, pd)), (false, (pd, pw))] {
            let mut runs: BTreeMap<i64, Vec<i64>> = BTreeMap::new();
            for &(i, j) in &mine {
                let (line, at) = if along_z { (i, j) } else { (j, i) };
                for l in [line - 1, line] {
                    runs.entry(l).or_default().push(at);
                }
            }
            for (l, mut ats) in runs {
                ats.sort_unstable();
                ats.dedup();
                // consecutive plots along the line are one street (from the plot's lower edge to the upper's)
                let mut k = 0;
                while k < ats.len() {
                    let mut e = k;
                    while e + 1 < ats.len() && ats[e + 1] == ats[e] + 1 {
                        e += 1;
                    }
                    let (c0, c1) = ((ats[k] as f64 - 0.5) * s1 as f64, (ats[e] as f64 + 0.5) * s1 as f64);
                    let off = (l as f64 + 0.5) * s0 as f64;
                    let (a, b) = if along_z { ((hub.0 as f64 + off, hub.1 as f64 + c0), (hub.0 as f64 + off, hub.1 as f64 + c1)) } else { ((hub.0 as f64 + c0, hub.1 as f64 + off), (hub.0 as f64 + c1, hub.1 as f64 + off)) };
                    let n = (((b.0 - a.0).hypot(b.1 - a.1)) / 400.0).ceil().max(1.0) as usize;
                    let pts: Vec<(f64, f64)> = (0..=n).map(|t| (a.0 + (b.0 - a.0) * t as f64 / n as f64, a.1 + (b.1 - a.1) * t as f64 / n as f64)).collect();
                    // the way must be free (of buildings, rail, the airport; other roads may cross it)
                    let ok = pts.windows(2).all(|w| {
                        let g = land.height((w[0].0 as i64, w[0].1 as i64));
                        land.dry((w[0].0 as i64, w[0].1 as i64)) && space.blocker_but(&box_of(w[0], w[1], LOCAL_HW_CM), g - 200, g + ROAD_UP_CM, 100, &["road"]).is_none()
                    });
                    if ok {
                        // the runs of it not alongside a road already laid (that road is the street there)
                        let free: Vec<bool> = pts.windows(2).map(|w| !alongside(&laid, w[0], w[1])).collect();
                        let mut i = 0;
                        while i < free.len() {
                            if !free[i] { i += 1; continue; }
                            let i0 = i;
                            while i < free.len() && free[i] { i += 1; }
                            let run = &pts[i0..=i];
                            if run.len() < 3 { continue; }
                            for w in run.windows(2) {
                                let g = deck(land, w[0], w[1], land.height((w[0].0 as i64, w[0].1 as i64)));
                                space.put("road", "local", box_of(w[0], w[1], LOCAL_HW_CM), g - 200, g + ROAD_UP_CM);
                            }
                            lay(&mut laid, run);
                            let points = run.iter().map(|p| [p.0 as i64, land.height((p.0 as i64, p.1 as i64)), p.1 as i64]).collect();
                            out.push(Road { class: "local", from: usize::MAX, to: usize::MAX, points, min_r: f64::INFINITY, fallback: false });
                        }
                    }
                    k = e + 1;
                }
            }
        }
    }
    // join each street network that touches no arterial to the nearest arterial (again, while that joins more: a link
    // from one end may fail where another's succeeds)
    let mut grid = Grid::new(land, space);
    for r in arterials {
        let cells: Vec<(i64, i64)> = r.points.iter().map(|p| grid.cell((p[0], p[2]))).collect();
        grid.lay(&cells);
    }
    // (Central's ring, its from and to both Central: no link crosses it or the plaza)
    if arterials.iter().any(|r| (r.from, r.to) == (0, 0)) {
        grid.shut(hub, RING_SHUT_CM);
    }
    for pass in 0..6 {
    let comps = components(arterials, &out);
    let art_c = comps.first().copied();
    let mut seen = std::collections::BTreeSet::new();
    let before = out.len();
    for (k, r) in out.clone().iter().enumerate() {
        let c = comps[arterials.len() + k];
        if Some(c) == art_c || !seen.insert(c) {
            continue;
        }
        let p0 = if pass % 2 == 0 { r.points[0] } else { r.points[r.points.len() - 1] };
        let from = (p0[0], p0[2]);
        // the nearest point of the main network (the arterials and every street already joined to them)
        let main = arterials.iter().chain(out.iter().enumerate().filter(|(j, _)| comps.get(arterials.len() + j).copied() == art_c).map(|(_, r)| r));
        let to = main.flat_map(|a| a.points.iter()).min_by_key(|p| d(from, (p[0], p[2]))).map(|p| (p[0], p[2]));
        let (Some(to), Some(a), _) = (to, grid.snap(from), ()) else { continue };
        let Some(b) = grid.snap(to) else { continue };
        let Some(cells) = route(land, &grid, a, b) else { continue };
        // (from the street's end, through the cells, onto the point it joins: the snapped cells may stand off both)
        // (cells within two of either end are left out: a snapped cell beside the end would hook the link back on itself)
        let off = |c: &&(i64, i64), q: P| ((c.0 * GRID_CM - q.0) as f64).hypot((c.1 * GRID_CM - q.1) as f64) > (2 * GRID_CM) as f64;
        let raw: Vec<(f64, f64)> = std::iter::once((from.0 as f64, from.1 as f64))
            .chain(cells.iter().filter(|c| off(c, from) && off(c, to)).map(|c| ((c.0 * GRID_CM) as f64, (c.1 * GRID_CM) as f64)))
            .chain(std::iter::once((to.0 as f64, to.1 as f64))).collect();
        let (pts, min_r) = round(&simplify(&raw, SIMPLIFY_CM), R_MIN_CM);
        let points = pts.iter().map(|p| [p.0 as i64, land.height((p.0 as i64, p.1 as i64)), p.1 as i64]).collect();
        out.push(Road { class: "link", from: usize::MAX, to: usize::MAX, points, min_r, fallback: false });
    }
    if (out.len() == before && pass > 0) || pass == 5 {
        break;
    }
    }
    out
}

/// Union-find over roads that touch (an end within JOIN_CM of another's line): each road's component (arterials first,
/// then `rest`).
pub fn components(arterials: &[Road], rest: &[Road]) -> Vec<usize> {
    let all: Vec<&Road> = arterials.iter().chain(rest).collect();
    let n = all.len();
    let mut p: Vec<usize> = (0..n).collect();
    fn find(p: &mut [usize], x: usize) -> usize { let mut x = x; while p[x] != x { p[x] = p[p[x]]; x = p[x]; } x }
    let segs: Vec<Vec<(P, P)>> = all.iter().map(|r| r.points.windows(2).map(|w| ((w[0][0], w[0][2]), (w[1][0], w[1][2]))).collect()).collect();
    let bb: Vec<(i64, i64, i64, i64)> = all.iter().map(|r| r.points.iter().fold((i64::MAX, i64::MIN, i64::MAX, i64::MIN), |b, q| (b.0.min(q[0]), b.1.max(q[0]), b.2.min(q[2]), b.3.max(q[2])))).collect();
    for i in 0..n {
        for j in i + 1..n {
            let (a, b) = (bb[i], bb[j]);
            if a.0 > b.1 + JOIN_CM || b.0 > a.1 + JOIN_CM || a.2 > b.3 + JOIN_CM || b.2 > a.3 + JOIN_CM {
                continue;
            }
            let ends = |r: &Road| [(r.points[0][0], r.points[0][2]), (r.points[r.points.len() - 1][0], r.points[r.points.len() - 1][2])];
            let meet = ends(all[i]).iter().any(|&e| segs[j].iter().any(|&(x, y)| super::super::organic::geom::seg_dist2(e, e, x, y) < JOIN_CM * JOIN_CM))
                || ends(all[j]).iter().any(|&e| segs[i].iter().any(|&(x, y)| super::super::organic::geom::seg_dist2(e, e, x, y) < JOIN_CM * JOIN_CM))
                || segs[i].iter().any(|&(a1, a2)| segs[j].iter().any(|&(b1, b2)| super::super::organic::geom::seg_dist2(a1, a2, b1, b2) == 0));
            if meet {
                let (x, y) = (find(&mut p, i), find(&mut p, j));
                p[x] = y;
            }
        }
    }
    (0..n).map(|i| find(&mut p, i)).collect()
}

#[cfg(test)]
mod network_tests {
    use super::*;

    #[test]
    fn every_building_fronts_a_street_and_every_street_is_reachable() {
        let c = super::super::commons();
        let all: Vec<&Road> = c.arterials.iter().chain(&c.streets).collect();
        // one network
        let comps = components(&c.arterials, &c.streets);
        let main = comps[0];
        let joined = comps.iter().filter(|&&x| x == main).count();
        let lost: Vec<(usize, (i64, i64), (i64, i64))> = comps.iter().enumerate().filter(|(_, &x)| x != main).map(|(k, &x)| { let r = all[k]; (x, (r.points[0][0] / 100, r.points[0][2] / 100), (r.points[r.points.len() - 1][0] / 100, r.points[r.points.len() - 1][2] / 100)) }).collect();
        assert_eq!(joined, comps.len(), "roads off the network: {lost:?}");
        // every building within 30 m of a road (its door on a street)
        let near = |q: P| all.iter().any(|r| r.points.iter().any(|p| d(q, (p[0], p[2])) <= 3_000 + 2_000));
        let far: Vec<u32> = c.landuse.buildings.iter().filter(|b| !near(b.c)).map(|b| b.id).collect();
        assert!(far.len() * 100 <= c.landuse.buildings.len(), "{} of {} buildings off every street", far.len(), c.landuse.buildings.len());
    }
}
