//! Lots: a block cut down to its district's lot size by recursive oriented-box
//! splitting (Parish & Muller 2001). A piece is cut across the longest side of its
//! smallest bounding box, near the middle; a piece left with no road frontage is
//! dropped (a courtyard, or a backlot wall's far side). A lot faces out over its
//! longest frontage edge: `front` is that edge's outward normal, the door its middle.
//! A piece too thin or too ragged to build on (under 45% of its box) is left green.

use super::geom::{area2, centroid, clip, extent, inside, left, len, obb, simple, sub, unit, FPoly, P};
use super::super::noise::ONE;
use super::super::rng::Rng;

/// The shortest frontage (cm) a lot may have, and the shortest side a piece is cut across.
pub const MIN_FRONT_CM: i64 = 500;
const MIN_SIDE_CM: i64 = 700;

pub struct Cut {
    /// Counter-clockwise footprint (cm).
    pub poly: Vec<P>,
    /// The Q16 unit vector out of the lot to its road, and the door (the middle of that edge).
    pub front: P,
    pub door: P,
    /// Frontage and depth (cm).
    pub w: i64,
    pub d: i64,
}

fn points(f: &[(P, bool)]) -> Vec<P> {
    f.iter().map(|q| q.0).collect()
}

/// The longest frontage edge of a piece: (from, to), if one is long enough.
fn front_edge(f: &[(P, bool)]) -> Option<(P, P)> {
    let n = f.len();
    (0..n)
        .filter(|&k| f[k].1)
        .map(|k| (f[k].0, f[(k + 1) % n].0))
        .filter(|&(a, b)| len(sub(b, a)) >= MIN_FRONT_CM)
        .max_by_key(|&(a, b)| (len(sub(b, a)), a, b))
}

/// Cut `block` (counter-clockwise, every side on a road) into lots of about
/// `target_cm2`. The cut positions wobble by `rng`.
pub fn split(block: &[P], target_cm2: i64, rng: &mut Rng) -> Vec<Cut> {
    let mut pieces = Vec::new();
    go(block.iter().map(|&q| (q, true)).collect(), target_cm2, rng, &mut pieces, 0);
    pieces
        .into_iter()
        .filter_map(|f| {
            let (a, b) = front_edge(&f)?;
            let poly = points(&f);
            // a building must fit: no slivers, no L-shapes that wrap round a corner
            let (_, lu, lv) = obb(&poly);
            if lu.min(lv) < MIN_FRONT_CM || (area2(&poly) as i128) * 100 < 2 * 45 * lu as i128 * lv as i128 || !inside(centroid(&poly), &poly) {
                return None;
            }
            let along = unit(sub(b, a));
            let inward = left(along);
            let (lo, hi) = extent(&poly, inward);
            Some(Cut { front: (-inward.0, -inward.1), door: ((a.0 + b.0) / 2, (a.1 + b.1) / 2), w: len(sub(b, a)), d: hi - lo, poly })
        })
        .collect()
}

fn go(f: FPoly, target: i64, rng: &mut Rng, out: &mut Vec<FPoly>, depth: u32) {
    let pts = points(&f);
    let (u, lu, lv) = obb(&pts);
    if area2(&pts) <= 3 * target || lu.max(lv) < 2 * MIN_SIDE_CM || depth > 24 {
        out.push(f);
        return;
    }
    // across the long side, 42-58% of the way along it
    let axis = if lu >= lv { u } else { left(u) };
    let (lo, hi) = extent(&pts, axis);
    let m = lo + (hi - lo) * rng.range(42, 58) / 100;
    let o = (axis.0 * m / ONE, axis.1 * m / ONE);
    let halves = [clip(&f, o, axis), clip(&f, o, (-axis.0, -axis.1))];
    // a concave piece can come apart in two: keep it whole instead
    if halves.iter().any(|h| h.len() >= 3 && !simple(&points(h))) {
        out.push(f);
        return;
    }
    for h in halves {
        if h.len() >= 3 && area2(&points(&h)) > 0 && front_edge(&h).is_some() {
            go(h, target, rng, out, depth + 1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_block_splits_into_lots_that_face_its_roads() {
        // 60 x 30 m, lots of about 150 m2: two rows back to back, each lot on a road
        let block = [(0, 0), (6_000, 0), (6_000, 3_000), (0, 3_000)];
        let lots = split(&block, 150 * 10_000, &mut Rng::new(7));
        let total: i64 = lots.iter().map(|l| area2(&l.poly)).sum();
        assert_eq!(total, area2(&block), "the lots tile the block");
        assert!(lots.len() >= 8, "{} lots", lots.len());
        for l in &lots {
            assert!(area2(&l.poly) <= 2 * 3 * 150 * 10_000, "a lot of {} m2", area2(&l.poly) / 20_000);
            // the door is on the block's edge and the front points out of it
            let on_edge = l.door.0 == 0 || l.door.0 == 6_000 || l.door.1 == 0 || l.door.1 == 3_000;
            assert!(on_edge, "door {:?}", l.door);
            let out = (l.door.0 + l.front.0 / 100, l.door.1 + l.front.1 / 100);
            assert!(!(0..=6_000).contains(&out.0) || !(0..=3_000).contains(&out.1), "front {:?} at {:?}", l.front, l.door);
        }
    }

    #[test]
    fn a_long_block_keeps_every_lot_on_a_road() {
        // 30 x 200 m with lots of 100 m2: every lot has frontage enough
        let block = [(0, 0), (3_000, 0), (3_000, 20_000), (0, 20_000)];
        let lots = split(&block, 100 * 10_000, &mut Rng::new(3));
        assert!(!lots.is_empty());
        for l in &lots {
            assert!(l.w >= MIN_FRONT_CM);
        }
    }
}
