//! City Gen v5: rail alignments with no corners, only curves. A line is laid pose to pose (a point and a heading): the
//! shortest arc-straight-arc path (Dubins' CSC: left or right, straight, left or right) between them, of the widest
//! radius from `RADII_CM` whose path does not loop (no longer than `LOOP` times the chord, plus a half circle's
//! allowance where the headings disagree). Every path is tangent-continuous: a train never turns on the spot.
//! Points every `STEP_CM` along it.
pub const RADII_CM: [f64; 6] = [40_000.0, 30_000.0, 25_000.0, 20_000.0, 15_000.0, 12_000.0];
pub const STEP_CM: f64 = 400.0;
const LOOP: f64 = 1.6;

pub type Pose = (f64, f64, f64); // x, z (cm), heading (radians from +x toward +z)

fn m2pi(a: f64) -> f64 {
    let t = std::f64::consts::TAU;
    ((a % t) + t) % t
}

/// One CSC word: its turn signs (+1 left/counter-clockwise, -1 right), arc angles, straight length and heading.
struct Word {
    s1: f64,
    a1: f64,
    len: f64,
    phi: f64,
    s2: f64,
    a2: f64,
}

fn words(p: Pose, q: Pose, r: f64) -> Vec<Word> {
    let c = |x: f64, z: f64, h: f64, s: f64| (x - s * r * h.sin(), z + s * r * h.cos());   // the turning circle's centre
    let mut out = Vec::new();
    for (s1, s2) in [(1.0, 1.0), (-1.0, -1.0), (1.0, -1.0), (-1.0, 1.0)] {
        let (c1, c2) = (c(p.0, p.1, p.2, s1), c(q.0, q.1, q.2, s2));
        let (vx, vz) = (c2.0 - c1.0, c2.1 - c1.1);
        let d = vx.hypot(vz);
        let al = vz.atan2(vx);
        let (len, phi) = if s1 == s2 {
            (d, al)
        } else {
            if d < 2.0 * r {
                continue;
            }
            let l = (d * d - 4.0 * r * r).sqrt();
            (l, if s1 > 0.0 { al + (2.0 * r).atan2(l) } else { al - (2.0 * r).atan2(l) })
        };
        let a1 = if s1 > 0.0 { m2pi(phi - p.2) } else { m2pi(p.2 - phi) };
        let a2 = if s2 > 0.0 { m2pi(q.2 - phi) } else { m2pi(phi - q.2) };
        out.push(Word { s1, a1, len, phi, s2, a2 });
    }
    out
}

/// The points of the path from `p` to `q`: [(x, z, heading)], every STEP_CM, both ends included.
fn sample(p: Pose, q: Pose, r: f64, w: &Word) -> Vec<Pose> {
    let mut out = vec![p];
    let mut at = p;
    let arc = |at: Pose, s: f64, a: f64, out: &mut Vec<Pose>| -> Pose {
        let (cx, cz) = (at.0 - s * r * at.2.sin(), at.1 + s * r * at.2.cos());
        let n = ((a * r) / STEP_CM).ceil().max(1.0) as usize;
        let mut last = at;
        for i in 1..=n {
            let h = at.2 + s * a * i as f64 / n as f64;
            last = (cx + s * r * h.sin(), cz - s * r * h.cos(), h);
            out.push(last);
        }
        last
    };
    if w.a1 > 1e-9 {
        at = arc(at, w.s1, w.a1, &mut out);
    }
    let n = (w.len / STEP_CM).ceil() as usize;
    let s0 = at;
    for i in 1..=n {
        let t = w.len * i as f64 / n as f64;
        at = (s0.0 + t * w.phi.cos(), s0.1 + t * w.phi.sin(), w.phi);
        out.push(at);
    }
    if w.a2 > 1e-9 {
        arc(at, w.s2, w.a2, &mut out);
    }
    if let Some(last) = out.last_mut() {
        *last = q;
    }
    out
}

/// The curve from `p` to `q`, its radius (cm) and points.
pub fn connect(p: Pose, q: Pose) -> (f64, Vec<Pose>) {
    let chord = (q.0 - p.0).hypot(q.1 - p.1);
    let mut fallback: Option<(f64, f64, Vec<Pose>)> = None;
    for &r in &RADII_CM {
        let Some((total, w)) = words(p, q, r).into_iter().map(|w| (r * (w.a1 + w.a2) + w.len, w)).min_by(|a, b| a.0.total_cmp(&b.0)) else { continue };
        let pts = sample(p, q, r, &w);
        if total <= LOOP * chord + std::f64::consts::PI * r * 0.5 {
            return (r, pts);
        }
        if fallback.as_ref().is_none_or(|f| total < f.0) {
            fallback = Some((total, r, pts));
        }
    }
    let (_, r, pts) = fallback.expect("a CSC path always exists for equal-radius circles");
    (r, pts)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn turns(pts: &[Pose]) -> f64 {
        pts.windows(2).map(|w| { let d = (w[1].2 - w[0].2).abs() % std::f64::consts::TAU; d.min(std::f64::consts::TAU - d) }).fold(0.0, f64::max)
    }

    #[test]
    fn every_path_is_curves_and_straights_without_a_corner() {
        let cases = [((0.0, 0.0, 0.0), (80_000.0, 30_000.0, 0.0)), ((0.0, 0.0, 0.0), (60_000.0, 60_000.0, 1.57)), ((0.0, 0.0, 0.0), (90_000.0, -10_000.0, 3.0))];
        for (p, q) in cases {
            let (r, pts) = connect(p, q);
            assert!(r >= 12_000.0);
            // a step turns at most step / radius (plus rounding): a curve, never a corner
            assert!(turns(&pts) <= STEP_CM / r * 1.05 + 1e-6, "{:?} -> {:?}: turn {}", p, q, turns(&pts));
            let e = pts.last().unwrap();
            assert!((e.0 - q.0).abs() < 1.0 && (e.1 - q.1).abs() < 1.0);
        }
    }
}
