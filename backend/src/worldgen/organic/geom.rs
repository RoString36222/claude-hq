//! Integer plane geometry for the organic city: points in cm on (x, z),
//! directions as Q16 unit vectors, turns from a table of Q16 rotations (no trig).
//! Polygons are counter-clockwise: positive shoelace area in (x, z).

use super::super::noise::{isqrt, ONE};

pub type P = (i64, i64);

/// cos and sin (Q16) of 0, 5, 10, ... 90 degrees.
const ROT5: [P; 19] = [
    (65536, 0), (65287, 5712), (64540, 11380), (63303, 16962), (61584, 22415), (59396, 27697), (56756, 32768),
    (53684, 37590), (50203, 42126), (46341, 46341), (42126, 50203), (37590, 53684), (32768, 56756), (27697, 59396),
    (22415, 61584), (16962, 63303), (11380, 64540), (5712, 65287), (0, 65536),
];

/// The 16 compass directions, 22.5 degrees apart (Q16), from +x toward +z.
pub const DIR16: [P; 16] = [
    (65536, 0), (60547, 25080), (46341, 46341), (25080, 60547), (0, 65536), (-25080, 60547), (-46341, 46341), (-60547, 25080),
    (-65536, 0), (-60547, -25080), (-46341, -46341), (-25080, -60547), (0, -65536), (25080, -60547), (46341, -46341), (60547, -25080),
];

/// cos 30 degrees (Q16): the narrowest angle two roads may meet at.
pub const COS30: i64 = 56756;

pub fn add(a: P, b: P) -> P {
    (a.0 + b.0, a.1 + b.1)
}

pub fn sub(a: P, b: P) -> P {
    (a.0 - b.0, a.1 - b.1)
}

pub fn dot(a: P, b: P) -> i128 {
    a.0 as i128 * b.0 as i128 + a.1 as i128 * b.1 as i128
}

pub fn cross(a: P, b: P) -> i128 {
    a.0 as i128 * b.1 as i128 - a.1 as i128 * b.0 as i128
}

pub fn len(v: P) -> i64 {
    isqrt(v.0 * v.0 + v.1 * v.1)
}

pub fn dist2(a: P, b: P) -> i64 {
    (a.0 - b.0).pow(2) + (a.1 - b.1).pow(2)
}

/// `v` as a Q16 unit vector (+x for a zero vector).
pub fn unit(v: P) -> P {
    // scale small vectors up first, so the unit vector keeps its precision
    let s = if v.0.abs().max(v.1.abs()) < 1 << 20 { 1 << 10 } else { 1 };
    let (x, z) = (v.0 * s, v.1 * s);
    let l = isqrt(x * x + z * z);
    if l == 0 {
        return (ONE, 0);
    }
    (x * ONE / l, z * ONE / l)
}

/// A point `cm` along the Q16 unit direction `d` from `p`.
pub fn along(p: P, d: P, cm: i64) -> P {
    (p.0 + d.0 * cm / ONE, p.1 + d.1 * cm / ONE)
}

/// A quarter turn from +x toward +z: the left of a direction, for a CCW polygon's inside.
pub fn left(d: P) -> P {
    (-d.1, d.0)
}

/// Rotate `v` by the Q16 rotation (cos, sin).
pub fn rotate(v: P, r: P) -> P {
    ((v.0 * r.0 - v.1 * r.1) / ONE, (v.0 * r.1 + v.1 * r.0) / ONE)
}

/// Rotate `v` by `deg` degrees (a multiple of 5; positive turns +x toward +z).
pub fn turn(v: P, deg: i64) -> P {
    let mut v = v;
    let mut d = deg.rem_euclid(360);
    while d >= 90 {
        v = left(v);
        d -= 90;
    }
    rotate(v, ROT5[(d / 5) as usize])
}

/// Where segment ab crosses segment cd: the fraction along ab as (num, den), den > 0,
/// ends included. Parallel segments that touch cross at a (0).
pub fn crossing(a: P, b: P, c: P, d: P) -> Option<(i128, i128)> {
    if !super::super::roads::segments_touch(a, b, c, d) {
        return None;
    }
    let (r, s) = (sub(b, a), sub(d, c));
    let den = cross(r, s);
    if den == 0 {
        return Some((0, 1));
    }
    let t = cross(sub(c, a), s);
    Some(if den < 0 { (-t, -den) } else { (t, den) })
}

/// The point a fraction (num / den) along ab.
pub fn lerp(a: P, b: P, num: i128, den: i128) -> P {
    (a.0 + ((b.0 - a.0) as i128 * num / den) as i64, a.1 + ((b.1 - a.1) as i128 * num / den) as i64)
}

/// The point of segment ab nearest q, and its squared distance.
pub fn nearest_on(q: P, a: P, b: P) -> (P, i64) {
    let ab = sub(b, a);
    let l2 = dot(ab, ab);
    let t = if l2 == 0 { 0 } else { dot(sub(q, a), ab).clamp(0, l2) };
    let p = if l2 == 0 { a } else { lerp(a, b, t, l2) };
    (p, dist2(p, q))
}

/// Twice the signed area (cm2) of a polygon: positive counter-clockwise.
pub fn area2(poly: &[P]) -> i64 {
    let n = poly.len();
    (0..n).map(|i| poly[i].0 * poly[(i + 1) % n].1 - poly[(i + 1) % n].0 * poly[i].1).sum()
}

/// The area-weighted centroid of a polygon (its first point if degenerate).
pub fn centroid(poly: &[P]) -> P {
    let n = poly.len();
    let (mut cx, mut cz, mut a) = (0i128, 0i128, 0i128);
    for i in 0..n {
        let (p, q) = (poly[i], poly[(i + 1) % n]);
        let c = cross(p, q);
        a += c;
        cx += (p.0 + q.0) as i128 * c;
        cz += (p.1 + q.1) as i128 * c;
    }
    if a == 0 {
        return poly[0];
    }
    ((cx / (3 * a)) as i64, (cz / (3 * a)) as i64)
}

/// Is q inside the polygon (crossing number; points on the boundary may go either way)?
pub fn inside(q: P, poly: &[P]) -> bool {
    let n = poly.len();
    let mut c = false;
    for i in 0..n {
        let (a, b) = (poly[i], poly[(i + 1) % n]);
        if (a.1 > q.1) != (b.1 > q.1) {
            // x of the edge at q's z, compared without dividing
            let lhs = (q.0 - a.0) as i128 * (b.1 - a.1) as i128;
            let rhs = (b.0 - a.0) as i128 * (q.1 - a.1) as i128;
            if (b.1 > a.1 && lhs < rhs) || (b.1 < a.1 && lhs > rhs) {
                c = !c;
            }
        }
    }
    c
}

/// Is the polygon simple: no two edges touch, bar neighbours at their shared corner?
pub fn simple(poly: &[P]) -> bool {
    let n = poly.len();
    if n < 3 {
        return false;
    }
    for i in 0..n {
        let (a, b) = (poly[i], poly[(i + 1) % n]);
        if a == b {
            return false;
        }
        for j in i + 1..n {
            let (c, d) = (poly[j], poly[(j + 1) % n]);
            let next = j == i + 1;
            let prev = i == 0 && j == n - 1;
            if next || prev {
                // neighbours meet at one corner; they must not fold back along each other
                let (o, u, v) = if next { (b, a, d) } else { (a, b, c) };
                if cross(sub(u, o), sub(v, o)) == 0 && dot(sub(u, o), sub(v, o)) > 0 {
                    return false;
                }
                continue;
            }
            if super::super::roads::segments_touch(a, b, c, d) {
                return false;
            }
        }
    }
    true
}

/// A polygon's extent along the Q16 unit axis `u`: (least, most) of p . u / ONE.
pub fn extent(poly: &[P], u: P) -> (i64, i64) {
    poly.iter().fold((i64::MAX, i64::MIN), |(lo, hi), &p| {
        let s = (p.0 * u.0 + p.1 * u.1) / ONE;
        (lo.min(s), hi.max(s))
    })
}

/// Squared distance (cm2) between segments ab and cd: 0 when they touch.
pub fn seg_dist2(a: P, b: P, c: P, d: P) -> i64 {
    if super::super::roads::segments_touch(a, b, c, d) {
        return 0;
    }
    nearest_on(a, c, d).1.min(nearest_on(b, c, d).1).min(nearest_on(c, a, b).1).min(nearest_on(d, a, b).1)
}

/// A polygon whose edges carry a flag: edge k runs from point k to point k + 1 and
/// its flag says it is on a road (frontage).
pub type FPoly = Vec<(P, bool)>;

/// The part of `poly` on the side of the line through `o` that the Q16 normal `n`
/// points to (Sutherland-Hodgman). Edges along the cut are not frontage; the rest
/// keep their flags. A concave polygon can come back with a zero-width bridge: the
/// caller checks the result is simple.
pub fn clip(poly: &[(P, bool)], o: P, n: P) -> FPoly {
    let side = |q: P| dot(sub(q, o), n);
    let k = poly.len();
    let mut out: FPoly = Vec::with_capacity(k + 2);
    for i in 0..k {
        let (p, f) = poly[i];
        let q = poly[(i + 1) % k].0;
        let (sp, sq) = (side(p), side(q));
        if sp >= 0 {
            out.push((p, if sp == 0 && sq < 0 { false } else { f }));
        }
        if (sp > 0 && sq < 0) || (sp < 0 && sq > 0) {
            out.push((lerp(p, q, sp, sp - sq), sq > 0 && f));
        }
    }
    // drop repeated points (a zero-length edge)
    let mut k = 0;
    while out.len() > 1 && k < out.len() {
        if out[k].0 == out[(k + 1) % out.len()].0 {
            out.remove(k);
        } else {
            k += 1;
        }
    }
    out
}

/// The smallest box round a polygon with a side along one of its edges: (the Q16
/// unit along that edge, its extent along it, its extent across it).
pub fn obb(poly: &[P]) -> (P, i64, i64) {
    let n = poly.len();
    let mut best: Option<(i128, P, i64, i64)> = None;
    for i in 0..n {
        let e = sub(poly[(i + 1) % n], poly[i]);
        if e == (0, 0) {
            continue;
        }
        let u = unit(e);
        let ((a0, a1), (b0, b1)) = (extent(poly, u), extent(poly, left(u)));
        let area = (a1 - a0) as i128 * (b1 - b0) as i128;
        if best.is_none_or(|b| area < b.0) {
            best = Some((area, u, a1 - a0, b1 - b0));
        }
    }
    best.map_or(((ONE, 0), 0, 0), |b| (b.1, b.2, b.3))
}

/// Rise (cm) across a footprint: the most minus the least of the ground at its
/// corners and its centroid.
pub fn rise(t: &super::super::terrain::Terrain, poly: &[P]) -> i64 {
    let c = centroid(poly);
    let hs: Vec<i64> = poly.iter().chain(std::iter::once(&c)).map(|q| t.height_at(q.0, q.1)).collect();
    hs.iter().max().unwrap() - hs.iter().min().unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn turns_are_exact_enough() {
        let r = turn((ONE, 0), 90);
        assert_eq!(r, (0, ONE));
        let r = turn((ONE, 0), 45);
        assert!((r.0 - 46341).abs() <= 1 && (r.1 - 46341).abs() <= 1);
        let r = turn((ONE, 0), -30);
        assert!((r.0 - 56756).abs() <= 1 && (r.1 + 32768).abs() <= 1, "{r:?}");
        assert_eq!(turn((0, ONE), 180), (0, -ONE));
    }

    #[test]
    fn polygons() {
        let sq = [(0, 0), (100, 0), (100, 100), (0, 100)];
        assert_eq!(area2(&sq), 20_000);
        assert_eq!(centroid(&sq), (50, 50));
        assert!(inside((50, 50), &sq) && !inside((150, 50), &sq));
        assert!(simple(&sq));
        assert!(!simple(&[(0, 0), (100, 100), (100, 0), (0, 100)]));
        assert_eq!(crossing((0, 0), (100, 0), (50, -50), (50, 50)), Some((5_000, 10_000)));
        assert_eq!(crossing((0, 0), (100, 0), (50, 10), (50, 50)), None);
        assert_eq!(nearest_on((50, 30), (0, 0), (100, 0)), ((50, 0), 900));
        assert_eq!(unit((3, 4)), (39321, 52428));
    }

    #[test]
    fn clipping_keeps_frontage_flags() {
        let sq: FPoly = vec![((0, 0), true), ((100, 0), true), ((100, 100), false), ((0, 100), true)];
        // keep x >= 40: the cut (x = 40) is no frontage, the clipped sides keep theirs
        let c = clip(&sq, (40, 0), (ONE, 0));
        assert_eq!(c, vec![((40, 0), true), ((100, 0), true), ((100, 100), false), ((40, 100), false)]);
        let d = clip(&sq, (40, 0), (-ONE, 0));
        assert_eq!(d, vec![((0, 0), true), ((40, 0), false), ((40, 100), false), ((0, 100), true)]);
        assert_eq!(area2(&c.iter().map(|q| q.0).collect::<Vec<_>>()) + area2(&d.iter().map(|q| q.0).collect::<Vec<_>>()), 20_000);
    }

    #[test]
    fn the_oriented_box_lies_along_an_edge() {
        // a 40 x 10 rectangle turned 45 degrees
        let r = [(0, 0), (2_828, 2_828), (2_121, 3_535), (-707, 707)];
        let (u, a, b) = obb(&r);
        assert!((u.0.abs() - 46341).abs() < 50 && (u.1.abs() - 46341).abs() < 50, "{u:?}");
        assert!((a.max(b) - 4_000).abs() < 5 && (a.min(b) - 1_000).abs() < 5, "{a} x {b}");
        assert_eq!(seg_dist2((0, 0), (100, 0), (50, 30), (50, 80)), 900);
        assert_eq!(seg_dist2((0, 0), (100, 0), (50, -30), (50, 80)), 0);
    }
}
