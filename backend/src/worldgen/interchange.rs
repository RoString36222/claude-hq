//! City Gen v4, phase 6: interchanges. Where a highway meets the ring road (a T: the ring
//! runs on, the highway ends there), a trumpet takes the place of the junction, all of it
//! one-way ramps and a flyover, nothing crossing at grade. In the ring's frame at the
//! junction J (x along the ring the way its inner carriageway runs, "eastbound"; y out from
//! the city, the highway coming in from y < 0), traffic keeping left (India):
//!
//!   - the flyover (the highway's last stretch, two-way, a lane each way) leaves the
//!     highway at N, rises at 5 % and crosses the ring at x = 0 on one span, to T beyond it;
//!   - eastbound to the city: a slip road off the ring's inner kerb at P1 (x = -a1) down
//!     to N; the city to eastbound: a slip road from N on to the inner kerb at P2 (x = a2);
//!   - the flyover outbound to westbound: at T a loop (270 degrees, clockwise, 30 m)
//!     coming down to the ring's outer kerb, under the flyover, to join it at P1;
//!   - westbound to the city: off the outer kerb at P2, round the loop's far side and
//!     over its top, climbing to T and on down the flyover.
//!
//! Lane balance, with the traffic sim's lanes (an expressway's are its lanes less one: the
//! one by the median is kept for overtaking): the ring's two lanes a way come to one each
//! between P1 and P2 (its edge there carries one lane fewer), the highway's two at N split
//! between the flyover's one and a slip road. So every node has as many lanes in as out.
//!
//! Layout is worked out on the base terrain (edits change heights, never layout) in the
//! ring's curved frame: a point (x, y) is y out along the ring's normal from the point x
//! along it, so the ramps beside the ring follow its curve. A junction where the trumpet
//! does not fit (the coast, a block, the river or a lake, the airport's claim, another road
//! or junction in the way, the ring too curved, the highway too short or at an angle)
//! stays a junction at grade. Heights come in `seat`: the flyover's deck `LIFT_CM` over
//! the highest of the ring and the land under its span, the loop and the westbound ramp
//! coming down off it at `RAMP_PM`, every ramp on the ground elsewhere.
//!
//! Integer arithmetic only (cm, Q16 directions, arcs from the 5 degree rotation table).

use super::claims::Airport;
use super::city::Block;
use super::noise::ONE;
use super::organic::geom::{dist2, inside, left, len, nearest_on, seg_dist2, sub, turn, unit, P};
use super::river::River;
use super::roads::{path_len, Edge, Node, Roads};
use super::terrain::Terrain;

/// A deck's height over what it crosses: 5.5 m clear and its 1.5 m depth (IRC:92).
pub const LIFT_CM: i64 = 700;
/// A ramp's and a flyover's grade (per mille): a flyover designed at up to 5.5 %, a ramp
/// coming off a deck at 5 % (the plan's 4 % desired, 6 % at most: `MAX_PM`, the
/// validator's limit).
pub const DESIGN_PM: i64 = 55;
pub const RAMP_PM: i64 = 50;
pub const MAX_PM: i64 = 60;
/// The loop ramp's radius (30-60 m, 30-40 km/h), the semi-direct ramp's turns, the slip
/// roads' turns (60 m: 40-50 km/h off an 80 km/h road).
pub const LOOP_R: i64 = 3_000;
const TURN_R: i64 = 3_000;
const SLIP_R: i64 = 6_000;
/// A ramp's half width (classes.rs: 8 m), the slip roads' offset beside the flyover (clear
/// of its rising deck), the loop to the ramp round it, a ramp's straight beside the ring
/// before it joins (its junction box, 16.5 m, and some), the coast's margin.
const HALF: i64 = 400;
const SLIP_X: i64 = 1_000;
const ROOM: i64 = 1_200;
const TAPER: i64 = 3_000;
const COAST_GAP: i64 = 1_500;
/// The tightest curve (cm) on the highway's eased approach to the flyover.
const CONN_R: i64 = 6_000;
/// How far (cm) the ring may be graded over the land under a flyover's span, as the layout
/// allows for it.
const RING_FILL: i64 = 200;
/// How far (cm) below the ground under its span a flyover's foot may stand: lower land is
/// filled up to it (an embankment).
pub const FOOT_FILL: i64 = 300;
/// How far (cm) a trumpet may slide along the ring off the junction, to meet its highway.
const SLIDE: i64 = 15_000;
/// The flyover reaches its deck this far (cm) before the ring's edge.
const DECK_BEFORE: i64 = 300;
/// What the ramps keep off (cm past their half width): blocks, the airport's claim, other roads.
const CLEAR: i64 = 300;

/// What an interchange must keep off, beyond the roads themselves.
pub struct Keep<'a> {
    pub blocks: &'a [Block],
    pub claim: Option<&'a Airport>,
    pub river: Option<&'a River>,
    pub coast: Option<&'a [P]>,
}

/// One trumpet's plan, in world cm.
struct Plan {
    /// The ring's chain (edge indices) the trumpet replaces, west to east, and its path.
    chain: Vec<usize>,
    west: Vec<P>,
    middle: Vec<P>,
    east: Vec<P>,
    /// The highway's edge (from J), its kept part (city end first, then the connector to N,
    /// from `conn`).
    highway: usize,
    hway: Vec<P>,
    conn: usize,
    n: P,
    t: P,
    p1: P,
    p2: P,
    stem: Vec<P>,
    loop_: Vec<P>,
    m3: Vec<P>,
    m1: Vec<P>,
    m2: Vec<P>,
}

/// The ring's curved frame at a junction: its path by arc length (cm) from J, the way the
/// inner carriageway runs.
struct Frame {
    pts: Vec<P>,
    at: Vec<i64>,
    /// Arc length (from the path's start) of J.
    j: i64,
}

impl Frame {
    /// The point and the Q16 unit tangent x cm along the ring from J.
    fn on(&self, x: i64) -> (P, P) {
        let s = (self.j + x).clamp(0, self.at[self.at.len() - 1]);
        let p = self.point(s);
        let (a, b) = (self.point((s - 1_500).max(0)), self.point((s + 1_500).min(self.at[self.at.len() - 1])));
        (p, unit(sub(b, a)))
    }

    fn point(&self, s: i64) -> P {
        let k = self.at.partition_point(|&a| a <= s).clamp(1, self.at.len() - 1);
        let (a, b) = (self.pts[k - 1], self.pts[k]);
        let l = (self.at[k] - self.at[k - 1]).max(1);
        let f = s - self.at[k - 1];
        (a.0 + (b.0 - a.0) * f / l, a.1 + (b.1 - a.1) * f / l)
    }

    /// Local (x, y) to world: y out (to the tangent's left, geom's `left`, away from the
    /// city) from the point x along the ring.
    fn map(&self, (x, y): P) -> P {
        let (p, u) = self.on(x);
        let o = left(u);
        (p.0 + o.0 * y / ONE, p.1 + o.1 * y / ONE)
    }

    /// Local (x, y) to world for the trumpet's ramps: the point x along the ring, then y out
    /// along the ring's normal at J (fixed). The stretches beside the ring follow its curve,
    /// and nothing further out is squeezed or stretched however the ring curves (the normals
    /// do not fan): a shape is only sheared along the normal by the ring's own bend.
    /// (The ring's line here is eased over 24 m.)
    fn place(&self, q: P) -> P {
        // (the ring's line eased over 24 m: a ramp beside it does not copy the kink where its pieces met at the junction)
        let k: Vec<P> = (-4..=4).map(|i| self.on(q.0 + i * 300).0).collect();
        let p = (k.iter().map(|v| v.0).sum::<i64>() / 9, k.iter().map(|v| v.1).sum::<i64>() / 9);
        let o0 = left(self.on(0).1);
        (p.0 + o0.0 * q.1 / ONE, p.1 + o0.1 * q.1 / ONE)
    }

    /// World to local: (x along the ring from J, y out from it), by the frame's own
    /// (smoothed) normals: the x whose normal passes through q, nearest the ring's nearest point.
    fn local(&self, q: P) -> P {
        let end = self.at[self.at.len() - 1];
        let off = |x: i64| {
            let (p, u) = self.on(x);
            let v = sub(q, p);
            ((v.0 as i128 * u.0 as i128 + v.1 as i128 * u.1 as i128) / ONE as i128) as i64
        };
        // start from the nearest point of the path, then walk to where q is square across
        let mut x = (0..self.at.len()).min_by_key(|&k| dist2(self.pts[k], q)).map_or(0, |k| self.at[k]) - self.j;
        for step in [1_600, 400, 100, 25] {
            for _ in 0..64 {
                let (a, b) = (off(x), off(x + step));
                if a.abs() <= b.abs() && a.abs() <= off(x - step).abs() {
                    break;
                }
                x += if b.abs() < a.abs() { step } else { -step };
                if self.j + x < 0 || self.j + x > end {
                    break;
                }
            }
        }
        let (p, u) = self.on(x);
        let o = left(u);
        let v = sub(q, p);
        (x, ((v.0 as i128 * o.0 as i128 + v.1 as i128 * o.1 as i128) / ONE as i128) as i64)
    }

    /// The ring's own path from x0 to x1 (both exact), every point between.
    fn path(&self, x0: i64, x1: i64) -> Vec<P> {
        let (s0, s1) = (self.j + x0, self.j + x1);
        let mut out = vec![self.point(s0)];
        for k in 0..self.pts.len() {
            if self.at[k] > s0 + 50 && self.at[k] < s1 - 50 {
                out.push(self.pts[k]);
            }
        }
        out.push(self.point(s1));
        out
    }
}

/// Points along a local polyline's straights every 4 m, its corners kept.
fn sample(local: &[P]) -> Vec<P> {
    let mut out = vec![local[0]];
    for w in local.windows(2) {
        let l = len(sub(w[1], w[0]));
        let n = (l / 400).max(1);
        for k in 1..=n {
            out.push((w[0].0 + (w[1].0 - w[0].0) * k / n, w[0].1 + (w[1].1 - w[0].1) * k / n));
        }
    }
    out.dedup();
    out
}



/// A local arc round `c` of radius `r` from angle `a0` to `a1` (degrees, multiples of 5,
/// counter-clockwise from +x when a1 > a0), every 5 degrees.
fn arc(c: P, r: i64, a0: i64, a1: i64) -> Vec<P> {
    let step = if a1 >= a0 { 5 } else { -5 };
    let mut out = Vec::new();
    let mut a = a0;
    loop {
        let v = turn((ONE, 0), a);
        out.push((c.0 + r * v.0 / ONE, c.1 + r * v.1 / ONE));
        if a == a1 {
            break;
        }
        a += step;
    }
    out
}

/// A cubic from p (leaving along the Q16 unit `dp`) to q (arriving along `dq`), its
/// control points a third of the way, every 4 m or so (ends exact).
fn cubic(p: P, dp: P, q: P, dq: P) -> Vec<P> {
    let l = len(sub(q, p));
    let (c1, c2) = ((p.0 + dp.0 * l / 3 / ONE, p.1 + dp.1 * l / 3 / ONE), (q.0 - dq.0 * l / 3 / ONE, q.1 - dq.1 * l / 3 / ONE));
    let n = (l / 400).max(4) as i128;
    (0..=n)
        .map(|i| {
            let (t, u) = (i, n - i);
            let w = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
            let at = |a: i64, b: i64, c: i64, d: i64| ((w[0] * a as i128 + w[1] * b as i128 + w[2] * c as i128 + w[3] * d as i128) / (n * n * n)) as i64;
            (at(p.0, c1.0, c2.0, q.0), at(p.1, c1.1, c2.1, q.1))
        })
        .collect()
}

/// Does a polyline turn no tighter than radius r anywhere (each corner's turn against the
/// length either side)?
fn gentle(pts: &[P], r: i64) -> bool {
    pts.windows(3).all(|w| {
        let (a, b) = (sub(w[1], w[0]), sub(w[2], w[1]));
        let (la, lb) = (len(a) as i128, len(b) as i128);
        let cross = (a.0 as i128 * b.1 as i128 - a.1 as i128 * b.0 as i128).abs();
        let dot = a.0 as i128 * b.0 as i128 + a.1 as i128 * b.1 as i128;
        dot > 0 && cross * r as i128 * 2 <= la * lb * (la + lb)
    })
}

/// The interchange plan at junction node `j`, or why there is none (for the report).
fn plan(roads: &Roads, t: &Terrain, keep: &Keep, j: u32, at: &[Vec<usize>]) -> Result<Plan, &'static str> {
    let es = &at[j as usize];
    let rings: Vec<usize> = es.iter().copied().filter(|&k| roads.edges[k].class == "ring").collect();
    let hws: Vec<usize> = es.iter().copied().filter(|&k| roads.edges[k].class == "highway").collect();
    if es.len() != 3 || rings.len() != 2 || hws.len() != 1 {
        return Err("not a T");
    }
    let node = |n: u32| &roads.nodes[n as usize];
    let jp = (node(j).x, node(j).z);
    // a road's points from node n outward
    let from = |k: usize, n: u32| -> Vec<P> {
        let e = &roads.edges[k];
        let mut v: Vec<P> = e.points.iter().map(|q| (q[0], q[2])).collect();
        if e.b == n {
            v.reverse();
        }
        v
    };
    // the ring each way from J, through the nodes where only the ring runs on, as far as
    // the longer side of a trumpet needs or the next junction (each side is checked below)
    let reach = 20_000;
    let walk = |k0: usize| -> Result<(Vec<usize>, Vec<P>), &'static str> {
        let (mut k, mut n, mut pts, mut chain) = (k0, j, vec![jp], Vec::new());
        loop {
            let e = &roads.edges[k];
            if e.bridge.is_some() {
                return Err("a bridge on the ring");
            }
            chain.push(k);
            pts.extend(from(k, n).into_iter().skip(1));
            n = if e.a == n { e.b } else { e.a };
            if path_len(&pts.iter().map(|q| [q.0, 0, q.1]).collect::<Vec<_>>()) >= reach {
                return Ok((chain, pts));
            }
            let next: Vec<usize> = at[n as usize].iter().copied().filter(|&m| m != k).collect();
            if next.len() != 1 || roads.edges[next[0]].class != "ring" || n == j {
                return Ok((chain, pts));
            }
            k = next[0];
        }
    };
    let (ca, pa) = walk(rings[0])?;
    let (cb, pb) = walk(rings[1])?;
    if ca.iter().any(|k| cb.contains(k)) {
        return Err("the ring is too short");
    }
    // eastbound: the way the ring runs with the city on its left, to the kerb (traffic keeps left)
    let d = unit(sub(pb[pb.len().min(6) - 1], pa[pa.len().min(6) - 1]));
    let east = (jp.0 as i128 * left(d).0 as i128 + jp.1 as i128 * left(d).1 as i128) > 0;
    let (cw, pw, ce, pe) = if east { (ca, pa, cb, pb) } else { (cb, pb, ca, pa) };
    let mut pts: Vec<P> = pw.iter().rev().copied().collect();
    pts.extend(pe.iter().skip(1));
    let mut acc = vec![0i64; pts.len()];
    for k in 1..pts.len() {
        acc[k] = acc[k - 1] + len(sub(pts[k], pts[k - 1]));
    }
    let mut f = Frame { j: acc[pw.len() - 1], pts, at: acc };
    let ring_half = roads.edges[cw[0]].width / 2;
    let y_l = ring_half + HALF;
    let y_t = y_l + LOOP_R;
    let y_top = y_t + LOOP_R + 2 * HALF + ROOM;
    let xr = HALF + 2 * LOOP_R + 2 * HALF + ROOM;
    let a2 = xr + TURN_R + TAPER;
    let a1 = SLIP_X + SLIP_R + TAPER;
    let hk = hws[0];
    let mut hw = from(hk, j);
    let ground = |q: P| t.height_at(q.0, q.1);
    // N, the flyover's foot: far enough in for it to climb to its deck at the design grade
    let depth = |f: &Frame| -> i64 {
        let span = (-(ring_half + DECK_BEFORE)..=y_l + HALF).step_by(400).map(|y| ground(f.map((0, y)))).max().unwrap_or(0);
        (ring_half + DECK_BEFORE + LIFT_CM * 1000 / DESIGN_PM..=40_000)
            .step_by(1_000)
            .find(|&yn| (span + LIFT_CM - ground(f.map((0, -yn))).max(span - FOOT_FILL)) * 1000 <= DESIGN_PM * (yn - ring_half - DECK_BEFORE))
            .unwrap_or(0)
    };
    // the trumpet slides along the ring (up to SLIDE) so its flyover meets the highway where
    // the highway is at the flyover's foot (and 40 m in)
    let j0 = f.j;
    for _ in 0..2 {
        let y_n = depth(&f);
        let Some(q) = hw.iter().find(|&&q| f.local(q).1 <= -(y_n + 2_500)) else { return Err("the highway is too short") };
        f.j = (f.j + f.local(*q).0).clamp(0, f.at[f.at.len() - 1]);
    }
    if (f.j - j0).abs() > SLIDE {
        return Err("the highway meets the ring at an angle");
    }
    if f.j < a1 + 2_000 || f.at[f.at.len() - 1] - f.j < a2 + 2_000 {
        return Err("another junction on the ring nearby");
    }
    // the ring no more curved than a 300 m radius across the trumpet
    let (q0, q1, q2) = (f.on(-a1).0, f.on(0).0, f.on(a2).0);
    let bow = nearest_on(q1, q0, q2).1;
    let chord = dist2(q0, q2);
    // (the sagitta of a chord c on radius R is c^2 / 8R: at 300 m, s^2 = c^4 / (64 R^2))
    if (bow as i128) * 64 * 30_000i128 * 30_000 > (chord as i128) * (chord as i128) {
        return Err("the ring is too curved there");
    }
    let y_n = depth(&f);
    if y_n == 0 {
        return Err("no room for the flyover to climb");
    }
    let o = left(f.on(0).1);
    let inward = (-o.0, -o.1);
    let n = f.map((0, -y_n));
    // the highway eased on to the flyover's line: a cubic from one of its points (the nearest
    // past N that gives one) leaving along the highway and arriving at N along the flyover,
    // never tighter than CONN_R
    let dotq = |a: P, b: P| a.0 as i128 * b.0 as i128 + a.1 as i128 * b.1 as i128;
    let mut eased = None;
    for k in 1..hw.len().saturating_sub(1) {
        let q = hw[k];
        if dist2(q, n) < 2_500i64.pow(2) || dotq(sub(q, n), inward) <= 0 {
            continue;
        }
        let along = unit(sub(q, hw[k + 1]));
        if dotq(along, o) <= 0 {
            continue;
        }
        let curve = cubic(q, along, n, o);
        if gentle(&curve, CONN_R) {
            eased = Some((k, curve));
            break;
        }
    }
    let Some((cut, curve)) = eased else { return Err("the highway meets the ring at an angle") };
    // (the kept part, city end first, then on to N)
    let mut hway: Vec<P> = hw.split_off(cut);
    hway.reverse();
    let conn = hway.len() - 1;
    hway.extend(curve.into_iter().skip(1));

    let m = |v: Vec<P>| -> Vec<P> { sample(&v).into_iter().map(|q| f.place(q)).collect() };
    // the loop and the westbound ramp come down off the deck (the land under the flyover's
    // span and RING_FILL for the ring's grading, plus LIFT_CM) to the ring at DESIGN_PM
    let deck = (-(ring_half + DECK_BEFORE)..=y_l + HALF).step_by(400).map(|y| ground(f.map((0, y)))).max().unwrap_or(0) + RING_FILL + LIFT_CM;
    let climb = |pts: &[P], end: P| (deck - ground(end)) * 1000 <= DESIGN_PM * path_len(&pts.iter().map(|q| [q.0, 0, q.1]).collect::<Vec<_>>());
    let mut loop_l = vec![(0, y_t)];
    loop_l.extend(arc((HALF + LOOP_R, y_t), LOOP_R, 180, -90));
    loop_l.extend([(-a1 + 1_500, y_l), (-a1, 0)]);
    let mut m3_l = vec![(a2, 0), (a2 - 1_500, y_l)];
    m3_l.extend(arc((xr + TURN_R, y_l + TURN_R), TURN_R, -90, -180));
    m3_l.extend(arc((xr - TURN_R, y_top - TURN_R), TURN_R, 0, 90));
    m3_l.extend(arc((-HALF + TURN_R, y_top - TURN_R), TURN_R, 90, 180));
    m3_l.extend([(-HALF, y_t), (0, y_t)]);
    let mut m2_l = vec![(0, -y_n), (SLIP_X, -y_n + 1_500)];
    m2_l.extend(arc((SLIP_X + SLIP_R, -y_l - SLIP_R), SLIP_R, 180, 90));
    m2_l.extend([(a2 - 1_500, -y_l), (a2, 0)]);
    let mut m1_l = vec![(-a1, 0), (-a1 + 1_500, -y_l)];
    m1_l.extend(arc((-SLIP_X - SLIP_R, -y_l - SLIP_R), SLIP_R, 90, 0));
    m1_l.extend([(-SLIP_X, -y_n + 1_500), (0, -y_n)]);
    let p = Plan {
        west: f.path(-(f.j), -a1),
        middle: f.path(-a1, a2),
        east: f.path(a2, f.at[f.at.len() - 1] - f.j),
        chain: cw.iter().rev().copied().chain(ce.iter().copied()).collect(),
        highway: hk,
        hway,
        conn,
        n,
        t: f.map((0, y_t)),
        p1: f.on(-a1).0,
        p2: f.on(a2).0,
        stem: m(vec![(0, -y_n), (0, y_t)]),
        loop_: m(loop_l),
        m3: m(m3_l),
        m1: m(m1_l),
        m2: m(m2_l),
    };
    // and the slip roads from the flyover's foot, as high as its climb needs it, to the ring
    let span = deck - RING_FILL - LIFT_CM;
    let foot = ground(p.n).max(span - FOOT_FILL).max(deck - DESIGN_PM * (y_n - ring_half - DECK_BEFORE) / 1000);
    let slip = |pts: &[P], end: P| (foot - ground(end)).abs() * 1000 <= DESIGN_PM * path_len(&pts.iter().map(|q| [q.0, 0, q.1]).collect::<Vec<_>>());
    if !climb(&p.loop_, p.p1) || !climb(&p.m3, p.p2) || !slip(&p.m1, p.p1) || !slip(&p.m2, p.p2) {
        return Err("no room for the ramps to climb");
    }
    fits(roads, keep, &p, ring_half)?;
    apart(&p)?;
    // the ramps beside the ring, never on it (where it curves out toward them), but where they join it: a ramp's lane
    // (4 m) clear of the ring's (12 m out), its shoulder over the ring's at most
    let ring: Vec<P> = p.west.iter().chain(&p.middle).chain(&p.east).copied().collect();
    for v in [&p.loop_, &p.m3, &p.m1, &p.m2] {
        for q in v.iter().filter(|&&q| dist2(q, p.p1) > 2_500i64.pow(2) && dist2(q, p.p2) > 2_500i64.pow(2)) {
            if ring.windows(2).any(|w| seg_dist2(w[0], w[1], *q, *q) < ring_half.pow(2)) {
                return Err("its ramps would meet the ring");
            }
        }
    }
    // and no ramp kinks anywhere its frame bent it (tighter than 15 m: the loop is 30 m round; its ends turn in the
    // junction boxes)
    for v in [&p.loop_, &p.m3, &p.m1, &p.m2] {
        let (mut a, mut b) = (0, v.len());
        while a < v.len() && dist2(v[a], v[0]) < 2_500i64.pow(2) {
            a += 1;
        }
        while b > a && dist2(v[b - 1], v[v.len() - 1]) < 2_500i64.pow(2) {
            b -= 1;
        }
            if b > a + 2 && !gentle(&v[a..b], 1_500) {
            return Err("its ramps would kink");
        }
    }
    Ok(p)
}

/// Does the plan keep off everything it must? The ramps and the flyover (and the
/// highway's new connector) against the blocks, the claim, the river and lakes, the coast
/// and every road but the ring and highway it replaces.
fn fits(roads: &Roads, keep: &Keep, p: &Plan, ring_half: i64) -> Result<(), &'static str> {
    let ours: Vec<usize> = p.chain.iter().copied().chain([p.highway]).collect();
    let others: Vec<(P, P, i64)> = roads
        .edges
        .iter()
        .enumerate()
        .filter(|(k, _)| !ours.contains(k))
        .flat_map(|(_, e)| e.points.windows(2).map(move |w| ((w[0][0], w[0][2]), (w[1][0], w[1][2]), e.width / 2)))
        .collect();
    let pieces: [(&[P], i64); 6] = [(&p.stem, 373), (&p.loop_, HALF), (&p.m3, HALF), (&p.m1, HALF), (&p.m2, HALF), (&p.hway[p.conn..], ring_half)];
    for (pts, hw) in pieces {
        for w in pts.windows(2) {
            let (a, b) = (w[0], w[1]);
            for bl in keep.blocks {
                let r = [(bl.x - bl.w / 2, bl.z - bl.d / 2), (bl.x + bl.w / 2, bl.z - bl.d / 2), (bl.x + bl.w / 2, bl.z + bl.d / 2), (bl.x - bl.w / 2, bl.z + bl.d / 2)];
                if inside(a, &r) || (0..4).any(|k| seg_dist2(a, b, r[k], r[(k + 1) % 4]) < (hw + CLEAR).pow(2)) {
                    return Err("a block in the way");
                }
            }
            if keep.claim.is_some_and(|c| c.meets_seg(a, b, hw + CLEAR) || c.in_corridor(a, b, hw + CLEAR)) {
                return Err("the airport's claim");
            }
            if keep.river.is_some_and(|r| r.zone(a) || r.zone(b)) {
                return Err("the river or a lake");
            }
            if let Some(c) = keep.coast {
                let near = (0..c.len()).map(|k| seg_dist2(a, a, c[k], c[(k + 1) % c.len()])).min().unwrap_or(i64::MAX);
                if !inside(a, c) || near < (hw + COAST_GAP).pow(2) {
                    return Err("the coast");
                }
            }
            if others.iter().any(|&(c, d, h)| seg_dist2(a, b, c, d) < (hw + h + CLEAR).pow(2)) {
                return Err("another road in the way");
            }
        }
    }
    Ok(())
}

/// Do the trumpet's own ramps keep apart (the ring's curve can squeeze its frame)? Each
/// pair at least their half widths and a metre apart, but within 25 m of a node they share
/// (where they meet) and where the loop passes under the flyover (by design).
fn apart(p: &Plan) -> Result<(), &'static str> {
    let ends = |v: &[P]| (v[0], v[v.len() - 1]);
    let pieces: [(&[P], i64); 5] = [(&p.stem, 373), (&p.loop_, HALF), (&p.m3, HALF), (&p.m1, HALF), (&p.m2, HALF)];
    for i in 0..pieces.len() {
        for j in i + 1..pieces.len() {
            if (i, j) == (0, 1) {
                continue;
            }
            let ((a, ha), (b, hb)) = (pieces[i], pieces[j]);
            let (a0, a1) = ends(a);
            let (b0, b1) = ends(b);
            let shared: Vec<P> = [a0, a1].into_iter().filter(|q| *q == b0 || *q == b1).collect();
            let near = |q: P| shared.iter().any(|&s| dist2(q, s) < 2_500i64.pow(2));
            for u in a.windows(2) {
                if near(u[0]) || near(u[1]) {
                    continue;
                }
                for v in b.windows(2) {
                    if near(v[0]) || near(v[1]) {
                        continue;
                    }
                    if seg_dist2(u[0], u[1], v[0], v[1]) < (ha + hb + 100).pow(2) {
                        return Err("its ramps would meet");
                    }
                }
            }
        }
    }
    Ok(())
}

/// Every junction where a highway meets the ring becomes a trumpet where one fits. Returns
/// (made, kept at grade with why).
pub fn build(roads: &mut Roads, t: &Terrain, keep: &Keep) -> (usize, Vec<(u32, &'static str)>) {
    let mut made = 0;
    let mut kept = Vec::new();
    loop {
        let mut at: Vec<Vec<usize>> = vec![Vec::new(); roads.nodes.len()];
        for (k, e) in roads.edges.iter().enumerate() {
            at[e.a as usize].push(k);
            at[e.b as usize].push(k);
        }
        let todo = (0..roads.nodes.len() as u32).find(|&j| {
            let es = &at[j as usize];
            es.len() == 3 && es.iter().filter(|&&k| roads.edges[k].class == "ring").count() == 2 && es.iter().any(|&k| roads.edges[k].class == "highway") && !kept.iter().any(|&(n, _)| n == j)
        });
        let Some(j) = todo else { break };
        match plan(roads, t, keep, j, &at) {
            Ok(p) => {
                apply(roads, t, p);
                made += 1;
            }
            Err(why) => kept.push((j, why)),
        }
    }
    renumber(roads);
    (made, kept)
}

/// Lay a plan: the ring's chain becomes three edges (west, the middle a lane fewer each
/// way, east), the highway ends at N, and the flyover and the four ramps join them.
fn apply(roads: &mut Roads, t: &Terrain, p: Plan) {
    let push = |nodes: &mut Vec<Node>, q: P| -> u32 {
        let id = nodes.len() as u32;
        nodes.push(Node { id, x: q.0, y: t.height_at(q.0, q.1), z: q.1, junction: Some("ramps"), island: None });
        id
    };
    let (n, tn, p1, p2) = (push(&mut roads.nodes, p.n), push(&mut roads.nodes, p.t), push(&mut roads.nodes, p.p1), push(&mut roads.nodes, p.p2));
    let first = roads.edges[p.chain[0]].clone();
    let last = roads.edges[*p.chain.last().unwrap()].clone();
    let ends = |e: &Edge, other: &[usize]| -> u32 {
        // the chain's far end: the node of e not shared with the next edge of the chain
        let shared = |n: u32| other.iter().any(|&k| roads.edges[k].a == n || roads.edges[k].b == n);
        if shared(e.a) { e.b } else { e.a }
    };
    let west_end = ends(&first, &p.chain[1..]);
    let east_end = ends(&last, &p.chain[..p.chain.len() - 1]);
    let h = roads.edges[p.highway].clone();
    let city = if is_j(roads, &p, h.a) { h.b } else { h.a };
    let pts = |v: &[P]| -> Vec<[i64; 3]> { v.iter().map(|q| [q.0, 0, q.1]).collect() };
    let mid_name = roads.edges[p.chain[p.chain.len() / 2]].name.clone();
    let ring = |a: u32, b: u32, v: &[P], name: &str, lanes: u8| Edge { id: 0, a, b, points: pts(v), name: name.to_string(), lanes, ..first.clone() };
    let lanes = first.lanes;
    let mut add = vec![
        ring(west_end, p1, &p.west, &first.name, lanes),
        ring(p1, p2, &p.middle, &mid_name, lanes.saturating_sub(1).max(1)),
        ring(p2, east_end, &p.east, &last.name, lanes),
        Edge { id: 0, a: city, b: n, points: pts(&p.hway), ..h.clone() },
    ];
    let ramp = |a: u32, b: u32, v: &[P], name: String| Edge {
        id: 0, a, b, class: "highway", width: 800, walk: 0, lanes: 1, route: None, name, points: pts(v), min_tier: h.min_tier, bridge: None,
        v4: Some("ramp"), median: None, oneway: Some(true),
    };
    let ramp_name = format!("{} Ramp", h.name);
    add.push(Edge { id: 0, a: n, b: tn, class: "highway", width: 745, walk: 0, lanes: 1, route: h.route.clone(), name: format!("{} Flyover", h.name), points: pts(&p.stem), min_tier: h.min_tier, bridge: None, v4: Some("flyover"), median: None, oneway: None });
    add.push(ramp(tn, p1, &p.loop_, ramp_name.clone()));
    add.push(ramp(p2, tn, &p.m3, ramp_name.clone()));
    add.push(ramp(p1, n, &p.m1, ramp_name.clone()));
    add.push(ramp(n, p2, &p.m2, ramp_name));
    let mut drop: Vec<usize> = p.chain.clone();
    drop.push(p.highway);
    drop.sort_unstable();
    for k in drop.into_iter().rev() {
        roads.edges.remove(k);
    }
    roads.edges.extend(add);
    for (k, e) in roads.edges.iter_mut().enumerate() {
        e.id = k as u32;
    }
}

/// Is node n the junction J the plan replaces (the highway's end on the ring)?
fn is_j(roads: &Roads, p: &Plan, n: u32) -> bool {
    p.chain.iter().any(|&k| roads.edges[k].a == n || roads.edges[k].b == n)
}

/// Drop the nodes no road meets any more, numbering the rest in order.
fn renumber(roads: &mut Roads) {
    let mut used = vec![false; roads.nodes.len()];
    for e in &roads.edges {
        used[e.a as usize] = true;
        used[e.b as usize] = true;
    }
    let mut renum = vec![u32::MAX; roads.nodes.len()];
    let mut nodes = Vec::new();
    for (k, nd) in roads.nodes.iter().enumerate() {
        if used[k] {
            renum[k] = nodes.len() as u32;
            nodes.push(Node { id: nodes.len() as u32, ..nd.clone() });
        }
    }
    for e in &mut roads.edges {
        (e.a, e.b) = (renum[e.a as usize], renum[e.b as usize]);
    }
    roads.nodes = nodes;
}

/// The sim's lanes a way on a road (games/traffic.js): an expressway's lanes less the one
/// by the median (kept for overtaking), a ramp's or flyover's own, one on every other road.
pub fn sim_lanes(e: &Edge) -> i64 {
    match e.v4 {
        Some("expressway") => (e.lanes as i64 - 1).max(1),
        Some("ramp") | Some("flyover") => e.lanes as i64,
        _ => 1,
    }
}

/// Before the roads are graded: each flyover's foot (N, where the highway meets the slip
/// roads) raised on an embankment to no more than `FOOT_FILL` below the ground under its
/// span, so its climb stays within what the layout planned.
pub fn raise_feet(roads: &mut Roads, t: &Terrain) {
    for k in 0..roads.edges.len() {
        let e = &roads.edges[k];
        if e.v4 != Some("flyover") {
            continue;
        }
        let only_ramps = |n: u32| roads.edges.iter().filter(|x| x.a == n || x.b == n).all(|x| x.v4 == Some("ramp") || x.v4 == Some("flyover"));
        let foot = if only_ramps(e.b) { e.a } else { e.b };
        let fx = (roads.nodes[foot as usize].x, roads.nodes[foot as usize].z);
        // the span: the stem's points over a road it does not meet
        let span = e
            .points
            .iter()
            .filter(|q| {
                roads.edges.iter().any(|r| {
                    r.a != e.a && r.b != e.a && r.a != e.b && r.b != e.b && {
                        let hw = r.width / 2 + DECK_BEFORE;
                        r.points.windows(2).any(|w| seg_dist2((w[0][0], w[0][2]), (w[1][0], w[1][2]), (q[0], q[2]), (q[0], q[2])) < hw * hw)
                    }
                })
            })
            .map(|q| t.height_at(q[0], q[2]))
            .max();
        if let Some(span) = span {
            let n = &mut roads.nodes[foot as usize];
            n.y = n.y.max(span - FOOT_FILL).max(t.height_at(fx.0, fx.1));
        }
    }
}

/// The interchange roads' heights, once the rest are seated: each flyover's deck `LIFT_CM`
/// over the highest of the ring, the ground and the loop under its span, climbing to it
/// from N; T at the deck; the loop and the westbound ramp off it at `RAMP_PM` until they
/// meet the ground; every ramp elsewhere on the ground between its ends (graded at
/// `MAX_PM`, else straight between them).
///
/// Returns the feet whose flyover would climb steeper than `DESIGN_PM` (the ring graded
/// higher than the land), each with the height it needs: `Roads::seat` raises them and
/// seats again.
pub fn seat(roads: &mut Roads, t: &Terrain) -> Vec<(u32, i64)> {
    let mut raise = Vec::new();
    let stems: Vec<usize> = (0..roads.edges.len()).filter(|&k| roads.edges[k].v4 == Some("flyover")).collect();
    for k in stems {
        let (a, b) = (roads.edges[k].a, roads.edges[k].b);
        // T: the end where only ramps meet
        let t_end = |n: u32| roads.edges.iter().filter(|e| e.a == n || e.b == n).all(|e| e.v4 == Some("ramp") || e.v4 == Some("flyover"));
        let (nn, tn, fwd) = if t_end(b) { (a, b, true) } else { (b, a, false) };
        let mut pts: Vec<[i64; 3]> = roads.edges[k].points.clone();
        if !fwd {
            pts.reverse();
        }
        // the span: from the first point over another road (a ring) to T
        let unders: Vec<&Edge> = roads.edges.iter().filter(|e| e.a != nn && e.b != nn && e.a != tn && e.b != tn).collect();
        let over = |q: &[i64; 3]| -> Option<i64> {
            unders
                .iter()
                .filter_map(|e| {
                    let hw = e.width / 2 + 373 + DECK_BEFORE;
                    e.points.windows(2).filter(|w| seg_dist2((w[0][0], w[0][2]), (w[1][0], w[1][2]), (q[0], q[2]), (q[0], q[2])) < hw * hw).map(|w| w[0][1].max(w[1][1])).max()
                })
                .max()
        };
        let k0 = pts.iter().position(|q| over(q).is_some()).unwrap_or(pts.len() / 2);
        // (over what it crosses: the ring and the loop under it, and the land there; on to T level)
        let deck = pts[k0..].iter().filter_map(|q| over(q).map(|y| y.max(t.height_at(q[0], q[2])))).max().unwrap_or(0) + LIFT_CM;
        let ya = roads.nodes[nn as usize].y;
        let along: Vec<i64> = along(&pts);
        let s0 = along[k0].max(1);
        if (deck - ya) * 1000 > DESIGN_PM * s0 {
            raise.push((nn, deck - DESIGN_PM * s0 / 1000));
        }
        for (q, s) in pts.iter_mut().zip(&along) {
            q[1] = ya + (deck - ya) * (*s).min(s0) / s0;
        }
        if !fwd {
            pts.reverse();
        }
        roads.edges[k].points = pts;
        roads.nodes[tn as usize].y = deck;
    }
    // the ramps: on the ground between their ends, and off a deck end at RAMP_PM
    for k in 0..roads.edges.len() {
        if roads.edges[k].v4 != Some("ramp") {
            continue;
        }
        let e = &roads.edges[k];
        let (ya, yb) = (roads.nodes[e.a as usize].y, roads.nodes[e.b as usize].y);
        let ground_a = t.height_at(roads.nodes[e.a as usize].x, roads.nodes[e.a as usize].z);
        let ground_b = t.height_at(roads.nodes[e.b as usize].x, roads.nodes[e.b as usize].z);
        let along = along(&e.points);
        let total = *along.last().unwrap();
        let line = graded_line(&e.points, &along, ground_a.min(ya), ground_b.min(yb), t);
        let deck_a = ya - ground_a.min(ya);
        let deck_b = yb - ground_b.min(yb);
        // (off the deck at RAMP_PM, or as steep as reaching the far end needs, at most MAX_PM: the layout
        // left room for it)
        let g = RAMP_PM.max(((ya - yb).abs() * 1000 + total - 1) / total.max(1)).min(MAX_PM);
        let mut pts = e.points.clone();
        for (q, (s, gl)) in pts.iter_mut().zip(along.iter().zip(line)) {
            let g_ = gl;
            let from_a = if deck_a > 0 { ya - s * g / 1000 } else { i64::MIN };
            let from_b = if deck_b > 0 { yb - (total - s) * g / 1000 } else { i64::MIN };
            let g = g_;
            q[1] = g.max(from_a).max(from_b);
        }
        let n = pts.len();
        pts[0][1] = ya;
        pts[n - 1][1] = yb;
        roads.edges[k].points = pts;
    }
    raise
}

/// Each point's distance (cm) along a road.
fn along(points: &[[i64; 3]]) -> Vec<i64> {
    let mut at = vec![0i64; points.len()];
    for q in 1..points.len() {
        let (a, b) = (points[q - 1], points[q]);
        at[q] = at[q - 1] + len((b[0] - a[0], b[2] - a[2]));
    }
    at
}

/// A ramp's ground line between end heights ya and yb: the land, lightly smoothed, kept
/// within `RAMP_PM` of both ends (straight between them where it cannot be).
fn graded_line(points: &[[i64; 3]], at: &[i64], ya: i64, yb: i64, t: &Terrain) -> Vec<i64> {
    let n = points.len();
    let raw: Vec<i64> = points.iter().map(|q| t.height_at(q[0], q[2])).collect();
    let total = at[n - 1].max(1);
    let straight: Vec<i64> = at.iter().map(|&s| ya + (yb - ya) * s / total).collect();
    if (yb - ya).abs() * 1000 > RAMP_PM * total {
        return straight;
    }
    let mut y = vec![ya; n];
    for q in 1..n {
        let (lo, hi) = ((ya - at[q] * RAMP_PM / 1000).max(yb - (total - at[q]) * RAMP_PM / 1000), (ya + at[q] * RAMP_PM / 1000).min(yb + (total - at[q]) * RAMP_PM / 1000));
        let step = (at[q] - at[q - 1]) * RAMP_PM / 1000;
        let (lo, hi) = (lo.max(y[q - 1] - step), hi.min(y[q - 1] + step));
        if lo > hi {
            return straight;
        }
        let (l, h) = (q.saturating_sub(2), (q + 2).min(n - 1));
        let smooth = raw[l..=h].iter().sum::<i64>() / (h - l + 1) as i64;
        y[q] = smooth.clamp(lo, hi);
    }
    y
}

/// Is any point of a deck road over the ground by more than half a metre (so the land
/// under it is not carved)?
pub fn elevated(e: &Edge, q: &[i64; 3], t: &Terrain) -> bool {
    matches!(e.v4, Some("ramp") | Some("flyover")) && q[1] > t.height_at(q[0], q[2]) + 50
}

