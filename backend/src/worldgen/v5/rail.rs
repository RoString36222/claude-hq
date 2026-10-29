//! City Gen v5: the railways: the City Line (the port, Central, the airport's terminal) and the Island Link (Central out
//! to an abutment on the coast, the sea crossing beyond it the client's). No corners, only curves (align.rs), stations on
//! straight platforms; and a vertical profile planned against the volume:
//!   - on a viaduct (`UP_CM` over the ground) wherever the volume there is free; else in a shallow tunnel (`DOWN_CM`
//!     under it, above the metro), else a deep one under every metro line (the airport owns everything from its
//!     ground up, a tower its plot, a station its concourse);
//!   - its grade at most `GRADE_PM`, held by lowering, never raising: a line starts down well before what it must pass
//!     under and comes up only after it, never diving at the last moment (profile());
//!   - every step, ramps included, is checked in the volume at its own height; one that meets something drops a level;
//!   - the Island Link ends at its abutment on the viaduct, its front out to sea.
use super::align::{connect, Pose};
use super::airport::{Airport, TERMINAL_CM};
use super::land::Land;
use super::space::Space;
use super::super::organic::geom::{inside, seg_dist2, P};

pub const UP_CM: i64 = 900;
pub const DOWN_CM: i64 = 1_100;
/// A deep tunnel's rail (cm under the ground): under the deepest metro line (metro.rs: 20 m and 9 m a line, 4 lines).
pub const DEEP_CM: i64 = 5_400;
pub const GRADE_PM: i64 = 40;
pub const PLATFORM_CM: f64 = 12_000.0;
/// The Island Link's Central platforms, this far (cm) from the hub toward its bearing.
pub const IL_SET_CM: i64 = 8_000;
pub const HW_CM: i64 = 500;
pub const CLEAR_CM: i64 = 700;
/// Within this far (cm) of the airport a line's levels are measured from the lower of the ground and the airport's.
pub const EDGE_CM: i64 = 3_000;

#[derive(Clone, Debug)]
pub struct Line {
    pub id: &'static str,
    pub stations: Vec<P>,
    /// The track's centre: [x, y (the rail), z] cm, every 4 m; and each point's kind.
    pub path: Vec<[i64; 3]>,
    pub kinds: Vec<&'static str>,
    pub min_r: i64,
    /// The abutment (the Island Link's end on the coast) and its front out to sea.
    pub sea: Option<(P, (f64, f64))>,
}

fn d(a: P, b: P) -> i64 {
    ((a.0 - b.0) as f64).hypot((a.1 - b.1) as f64) as i64
}

/// The plan of a line through `seq` (stations on straight platforms along their chords, curves between); the last
/// pose's heading `end` when given (the abutment's front). -> points (x, z, heading) and the tightest curve.
fn plan_line(seq: &[P], end: Option<f64>) -> (Vec<Pose>, f64) {
    let n = seq.len();
    let head: Vec<f64> = (0..n).map(|k| {
        if let (true, Some(e)) = (k == n - 1, end) {
            return e;
        }
        let (a, b) = (seq[k.saturating_sub(1)], seq[(k + 1).min(n - 1)]);
        ((b.1 - a.1) as f64).atan2((b.0 - a.0) as f64)
    }).collect();
    let half = PLATFORM_CM / 2.0;
    let pose = |k: usize, s: f64| -> Pose { (seq[k].0 as f64 + s * half * head[k].cos(), seq[k].1 as f64 + s * half * head[k].sin(), head[k]) };
    let (mut pts, mut min_r) = (Vec::new(), f64::INFINITY);
    for k in 0..n {
        let (a, b) = (pose(k, -1.0), pose(k, 1.0));
        for i in 0..=30 {
            let t = i as f64 / 30.0;
            pts.push((a.0 + (b.0 - a.0) * t, a.1 + (b.1 - a.1) * t, head[k]));
        }
        if k + 1 < n {
            let (r, c) = connect(b, pose(k + 1, -1.0));
            min_r = min_r.min(r);
            pts.extend(c.into_iter().skip(1));
        }
    }
    pts.dedup_by(|a, b| (a.0 - b.0).abs() < 1.0 && (a.1 - b.1).abs() < 1.0);
    (pts, min_r)
}

/// A step's box at height y (the rail) for the volume checks.
fn step_box(a: (f64, f64), b: (f64, f64)) -> Vec<P> {
    let (dx, dz) = (b.0 - a.0, b.1 - a.1);
    let l = dx.hypot(dz).max(1.0);
    let (nx, nz) = (-dz / l * HW_CM as f64, dx / l * HW_CM as f64);
    vec![((a.0 + nx) as i64, (a.1 + nz) as i64), ((b.0 + nx) as i64, (b.1 + nz) as i64), ((b.0 - nx) as i64, (b.1 - nz) as i64), ((a.0 - nx) as i64, (a.1 - nz) as i64)]
}

/// The vertical profile of `pts` against the volume: each point's rail height and kind; None where no level is free.
/// The levels, highest first: a viaduct (`UP_CM` over the ground), a shallow tunnel (`DOWN_CM` under it), a deep one
/// (`DEEP_CM`, under every metro line). Each point takes the highest free; then the grade is held by lowering, never
/// raising: a point is at most a grade's climb over its neighbours, so a line goes down well before what it must pass
/// under and comes up only after it. A point that then meets something drops a level, and the profile is laid again.
fn profile(land: &Land, ap: &Airport, space: &Space, pts: &[Pose], must_end_up: bool, stations: &[P]) -> Option<(Vec<i64>, Vec<&'static str>)> {
    let n = pts.len();
    // the ground: the terrain's, and on the airport its graded level (its box stands on that, not on the terrain); within
    // EDGE_CM of the airport the lower of the two, so a level under one is under both where they meet
    let near_ap = |q: P| inside(q, &ap.poly) || (0..ap.poly.len()).any(|k| seg_dist2(q, q, ap.poly[k], ap.poly[(k + 1) % ap.poly.len()]) < EDGE_CM * EDGE_CM);
    let g: Vec<i64> = pts.iter().map(|p| {
        let q = (p.0 as i64, p.1 as i64);
        if inside(q, &ap.poly) { ap.y } else if near_ap(q) { land.height(q).min(ap.y) } else { land.height(q) }
    }).collect();
    let levels = [UP_CM, -DOWN_CM, -DEEP_CM];
    let free_at = |i: usize, y: i64| -> bool {
        let j = if i + 1 < n { i + 1 } else { i - 1 };
        space.blocker(&step_box((pts[i].0, pts[i].1), (pts[j].0, pts[j].1)), y, y + CLEAR_CM, 0).is_none()
    };
    let mut lv: Vec<usize> = (0..n).map(|i| (0..levels.len()).find(|&k| free_at(i, g[i] + levels[k])).unwrap_or(levels.len())).collect();
    if lv.contains(&levels.len()) || (must_end_up && lv[n - 1] != 0) {
        return None;
    }
    let step = |i: usize| ((pts[i].0 - pts[i - 1].0).hypot(pts[i].1 - pts[i - 1].1) * GRADE_PM as f64 / 1000.0) as i64;
    // a platform's points: on a viaduct or under the street, never on a ramp (half sunk, it walls the street off)
    let platform: Vec<bool> = pts.iter().map(|p| stations.iter().any(|s| (p.0 - s.0 as f64).hypot(p.1 - s.1 as f64) <= PLATFORM_CM / 2.0 + 400.0)).collect();
    for _round in 0..8 {
        let mut y: Vec<i64> = (0..n).map(|i| g[i] + levels[lv[i]]).collect();
        // the grade, by lowering: forward (a climb no steeper than the grade) and back (a descent no steeper)
        for i in 1..n {
            y[i] = y[i].min(y[i - 1] + step(i));
        }
        for i in (0..n - 1).rev() {
            y[i] = y[i].min(y[i + 1] + step(i + 1));
        }
        let bad: Vec<usize> = (0..n).filter(|&i| !free_at(i, y[i]) || (platform[i] && y[i] < g[i] + UP_CM - 100 && y[i] > g[i] - DOWN_CM + 100)).collect();
        if bad.is_empty() {
            if must_end_up && y[n - 1] < g[n - 1] + UP_CM / 2 {
                return None;
            }
            let kinds = (0..n).map(|i| if y[i] >= g[i] + 300 { "viaduct" } else if y[i] <= g[i] - 300 { "tunnel" } else { "ramp" }).collect();
            return Some((y, kinds));
        }
        for i in bad {
            if lv[i] + 1 >= levels.len() {
                return None;
            }
            lv[i] += 1;
        }
    }
    None
}

pub fn plan(land: &Land, hub: P, port: Option<(P, P)>, ap: &Airport, space: &mut Space) -> Vec<Line> {
    let mut out: Vec<Line> = Vec::new();
    let terminal = { let w = ap.side * (TERMINAL_CM); (ap.c.0 - ap.dir.1 * w / 1000, ap.c.1 + ap.dir.0 * w / 1000) };
    // the City Line: the port's station a little inland of its quay, Central, the terminal
    let mut cl: Vec<P> = Vec::new();
    if let Some((q, f)) = port {
        let inland = (q.0 - (f.0.signum()) * 6_000, q.1 - (f.1.signum()) * 6_000);
        cl.push(if land.dry(inland) { inland } else { q });
    }
    cl.extend([hub, terminal]);
    // a line through `seq`: its plan, its profile in the volume, its swept box carved
    let build = |id: &'static str, seq: Vec<P>, end: Option<f64>, sea: bool, space: &mut Space| -> Option<Line> {
        if seq.len() < 2 {
            return None;
        }
        let (pts, min_r) = plan_line(&seq, end);
        let (y, kinds) = profile(land, ap, space, &pts, sea, &seq)?;
        let path: Vec<[i64; 3]> = pts.iter().zip(&y).map(|(p, &h)| [p.0.round() as i64, h, p.1.round() as i64]).collect();
        let owner = id.to_string();
        for w in path.windows(2) {
            let b = step_box((w[0][0] as f64, w[0][2] as f64), (w[1][0] as f64, w[1][2] as f64));
            space.put(if id == "CL" { "rail" } else { "link" }, &owner, b, w[0][1].min(w[1][1]), w[0][1].max(w[1][1]) + CLEAR_CM);
        }
        let sea_end = sea.then(|| { let l = pts[pts.len() - 1]; ((l.0 as i64, l.1 as i64), (l.2.cos(), l.2.sin())) });
        Some(Line { id, stations: seq, path, kinds, min_r: min_r as i64, sea: sea_end })
    };
    out.extend(build("CL", cl, None, false, space));
    // the Island Link: Central to the coast, out over open sea away from the airport's approaches and the port; the best
    // bearing whose line can be built
    if let Some(c) = &land.coast {
        let mut ranked: Vec<(i64, usize, P, f64)> = (0..36).filter_map(|k| {
            let a = (k as f64 * 10.0).to_radians();
            // the coast along this bearing: the last dry point
            let mut at = None;
            for s in (2..60).map(|s| s as f64 * 2_000.0) {
                let q = (hub.0 + (a.cos() * s) as i64, hub.1 + (a.sin() * s) as i64);
                if inside(q, &c.poly) && land.dry(q) {
                    at = Some(q);
                } else if at.is_some() {
                    break;
                }
            }
            let q = at?;
            let ad = (ap.dir.1 as f64).atan2(ap.dir.0 as f64);
            let off_app = ((a - ad).sin()).abs();   // 1: square to the runway's line, 0: along an approach
            let off_port = port.map_or(1.0, |p| (d(q, p.0) as f64 / 50_000.0).min(1.0));
            let off_air = (d(q, ap.c) as f64 / 60_000.0).min(1.0);
            Some((((off_app + off_port + off_air) * 1000.0) as i64, k, q, a))
        }).collect();
        ranked.sort_by_key(|x| (-x.0, x.1));
        // its Central platforms beside the plaza, IL_SET_CM out toward its bearing (the City Line's stand over the plaza
        // itself, the metro's concourse under it); its last station half a platform inland (the platform, and the line,
        // end on the coast)
        let il = ranked.iter().find_map(|&(_, _, q, a)| {
            let start = (hub.0 + (a.cos() * IL_SET_CM as f64) as i64, hub.1 + (a.sin() * IL_SET_CM as f64) as i64);
            let last = (q.0 - (a.cos() * PLATFORM_CM / 2.0) as i64, q.1 - (a.sin() * PLATFORM_CM / 2.0) as i64);
            build("IL", vec![start, last], Some(a), true, space)
        });
        out.extend(il);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn commons() -> (&'static Land, &'static Airport, &'static [Line]) {
        let c = super::super::commons();
        (&c.land, &c.airport, &c.rail)
    }

    #[test]
    fn both_lines_are_built_with_no_corner_and_within_their_grade() {
        let (_, _, r) = commons();
        assert_eq!(r.iter().map(|l| l.id).collect::<Vec<_>>(), vec!["CL", "IL"]);
        for l in r {
            assert!(l.min_r >= 12_000, "{}: a {} m curve", l.id, l.min_r / 100);
            for w in l.path.windows(3) {
                let (h1, h2) = (((w[1][2] - w[0][2]) as f64).atan2((w[1][0] - w[0][0]) as f64), ((w[2][2] - w[1][2]) as f64).atan2((w[2][0] - w[1][0]) as f64));
                let turn = (h2 - h1 + std::f64::consts::PI).rem_euclid(std::f64::consts::TAU) - std::f64::consts::PI;
                let step = ((w[1][0] - w[0][0]) as f64).hypot((w[1][2] - w[0][2]) as f64).max(1.0);
                assert!(turn.abs() <= step / 12_000.0 * 1.2 + 0.01, "{}: a corner", l.id);
            }
            for w in l.path.windows(2) {
                let run = ((w[1][0] - w[0][0]) as f64).hypot((w[1][2] - w[0][2]) as f64).max(1.0);
                let g = (w[1][1] - w[0][1]).abs() as f64 / run * 1000.0;
                // (the ground under a level stretch varies a little too)
                assert!(g <= GRADE_PM as f64 * 1.6 + 5.0, "{}: a {:.0} per mille step", l.id, g);
            }
        }
    }

    #[test]
    fn under_the_airport_never_over_it_and_the_link_ends_up_on_the_coast() {
        let (land, ap, r) = commons();
        for l in r {
            for (i, p) in l.path.iter().enumerate() {
                if inside((p[0], p[2]), &ap.poly) {
                    assert_eq!(l.kinds[i], "tunnel", "{} passes the airport other than under it", l.id);
                }
            }
        }
        let il = r.iter().find(|l| l.id == "IL").unwrap();
        assert_eq!(*il.kinds.last().unwrap(), "viaduct");
        let (q, _) = il.sea.unwrap();
        let c = land.coast.as_ref().unwrap();
        assert!(inside(q, &c.poly), "the abutment stands on the island");
    }
}
