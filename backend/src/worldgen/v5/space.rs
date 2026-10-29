//! City Gen v5 (docs/plans/city-gen-v5.md): the volume. Everything the generator places carves a solid out of it: a
//! convex footprint ([x, z] cm) over a height range (y cm, absolute: the sea's level is 0). No two solids may come within
//! their clearance of each other where their height ranges overlap; a tunnel under the airport is free, a viaduct over
//! it is not. Lookups go through a grid of `CELL_CM` squares, so a check is local however full the island is.
//!
//!   Space::default()                                    an empty volume
//!   space.blocker(poly, y0, y1, gap) -> Option<id>      the first solid within `gap` cm of the box, if any
//!   space.carve(kind, owner, poly, y0, y1, gap)         the box as a solid, or Err(the solid in its way)
//!   space.sweep(kind, owner, line, half_w, up, gap)     a line (centre [x, y, z] cm) as boxes: `half_w` either side, from
//!                                                       its own height to `up` over it; all or none
//!   levels: DEEP, SHALLOW, GROUND, ABOVE, SKY           (y0, y1) over the ground, cm
use std::collections::BTreeMap;

use super::super::organic::geom::{inside, seg_dist2, P};

/// The grid's square (cm).
pub const CELL_CM: i64 = 5_000;

/// The levels (cm over the ground there): deep (metro platforms and running tunnels), shallow (concourses, road tunnels),
/// ground (streets, building feet), above (viaducts, flyovers), sky (towers' tops, the airport's approaches).
pub const DEEP: (i64, i64) = (-3_000, -1_400);
pub const SHALLOW: (i64, i64) = (-1_400, -200);
pub const GROUND: (i64, i64) = (-200, 700);
pub const ABOVE: (i64, i64) = (700, 6_000);
pub const SKY: (i64, i64) = (6_000, 100_000);

/// A carved box: a convex footprint over [y0, y1).
#[derive(Clone, Debug)]
pub struct Solid {
    pub id: u32,
    pub kind: &'static str,
    pub owner: String,
    pub poly: Vec<P>,
    pub y0: i64,
    pub y1: i64,
    bbox: (i64, i64, i64, i64),
}

#[derive(Default, Clone, Debug)]
pub struct Space {
    pub solids: Vec<Solid>,
    cells: BTreeMap<(i64, i64), Vec<u32>>,
}

fn bbox(poly: &[P]) -> (i64, i64, i64, i64) {
    poly.iter().fold((i64::MAX, i64::MIN, i64::MAX, i64::MIN), |b, q| (b.0.min(q.0), b.1.max(q.0), b.2.min(q.1), b.3.max(q.1)))
}

/// Do two convex footprints come within `gap` cm of each other (or overlap)?
pub fn near(a: &[P], b: &[P], gap: i64) -> bool {
    if a.iter().any(|&q| inside(q, b)) || b.iter().any(|&q| inside(q, a)) {
        return true;
    }
    let (n, m) = (a.len(), b.len());
    (0..n).any(|i| (0..m).any(|j| seg_dist2(a[i], a[(i + 1) % n], b[j], b[(j + 1) % m]) < gap.max(1) * gap.max(1)))
}

impl Space {
    fn cells_of(b: (i64, i64, i64, i64), gap: i64) -> impl Iterator<Item = (i64, i64)> {
        let (x0, x1) = ((b.0 - gap).div_euclid(CELL_CM), (b.1 + gap).div_euclid(CELL_CM));
        let (z0, z1) = ((b.2 - gap).div_euclid(CELL_CM), (b.3 + gap).div_euclid(CELL_CM));
        (x0..=x1).flat_map(move |x| (z0..=z1).map(move |z| (x, z)))
    }

    /// The first solid (lowest id) within `gap` cm of the box `poly` x [y0, y1), if any.
    pub fn blocker(&self, poly: &[P], y0: i64, y1: i64, gap: i64) -> Option<u32> {
        let b = bbox(poly);
        let mut seen: Vec<u32> = Space::cells_of(b, gap).flat_map(|c| self.cells.get(&c).into_iter().flatten().copied()).collect();
        seen.sort_unstable();
        seen.dedup();
        seen.into_iter().find(|&id| {
            let s = &self.solids[id as usize];
            s.y0 < y1 && y0 < s.y1
                && s.bbox.0 - gap <= b.1 && b.0 <= s.bbox.1 + gap && s.bbox.2 - gap <= b.3 && b.2 <= s.bbox.3 + gap
                && near(&s.poly, poly, gap)
        })
    }

    /// As `blocker`, passing over solids of the kinds in `ignore` (roads meet roads: a junction is no collision).
    pub fn blocker_but(&self, poly: &[P], y0: i64, y1: i64, gap: i64, ignore: &[&str]) -> Option<u32> {
        let b = bbox(poly);
        let mut seen: Vec<u32> = Space::cells_of(b, gap).flat_map(|c| self.cells.get(&c).into_iter().flatten().copied()).collect();
        seen.sort_unstable();
        seen.dedup();
        seen.into_iter().find(|&id| {
            let s = &self.solids[id as usize];
            !ignore.contains(&s.kind)
                && s.y0 < y1 && y0 < s.y1
                && s.bbox.0 - gap <= b.1 && b.0 <= s.bbox.1 + gap && s.bbox.2 - gap <= b.3 && b.2 <= s.bbox.3 + gap
                && near(&s.poly, poly, gap)
        })
    }

    /// Carves the box as a solid. -> its id, or Err(the solid within `gap` of it).
    pub fn carve(&mut self, kind: &'static str, owner: &str, poly: Vec<P>, y0: i64, y1: i64, gap: i64) -> Result<u32, u32> {
        if let Some(b) = self.blocker(&poly, y0, y1, gap) {
            return Err(b);
        }
        Ok(self.put(kind, owner, poly, y0, y1))
    }

    /// Carves without checking (a solid the caller has already checked, or one allowed to touch its own parts).
    pub fn put(&mut self, kind: &'static str, owner: &str, poly: Vec<P>, y0: i64, y1: i64) -> u32 {
        let id = self.solids.len() as u32;
        let b = bbox(&poly);
        for c in Space::cells_of(b, 0) {
            self.cells.entry(c).or_default().push(id);
        }
        self.solids.push(Solid { id, kind, owner: owner.to_string(), poly, y0, y1, bbox: b });
        id
    }

    /// A line's boxes: each step of `line` ([x, y, z] cm, its centre at its own height) a quad `half_w` cm either side,
    /// from its lower end's height to `up` cm over its higher one. Checked first, as one: Err(the first blocker) and
    /// nothing carved, or every box carved. The line's own steps may touch each other.
    pub fn sweep(&mut self, kind: &'static str, owner: &str, line: &[[i64; 3]], half_w: i64, up: i64, gap: i64) -> Result<Vec<u32>, u32> {
        let quads: Vec<(Vec<P>, i64, i64)> = line.windows(2).filter_map(|w| {
            let (a, b) = ((w[0][0], w[0][2]), (w[1][0], w[1][2]));
            let (dx, dz) = (b.0 - a.0, b.1 - a.1);
            let l = ((dx as f64).hypot(dz as f64)).max(1.0);
            if l < 1.0 {
                return None;
            }
            let (nx, nz) = ((-dz as f64 / l * half_w as f64) as i64, (dx as f64 / l * half_w as f64) as i64);
            let poly = vec![(a.0 + nx, a.1 + nz), (b.0 + nx, b.1 + nz), (b.0 - nx, b.1 - nz), (a.0 - nx, a.1 - nz)];
            Some((poly, w[0][1].min(w[1][1]), w[0][1].max(w[1][1]) + up))
        }).collect();
        for (poly, y0, y1) in &quads {
            if let Some(b) = self.blocker(poly, *y0, *y1, gap) {
                return Err(b);
            }
        }
        Ok(quads.into_iter().map(|(poly, y0, y1)| self.put(kind, owner, poly, y0, y1)).collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sq(x: i64, z: i64, s: i64) -> Vec<P> {
        vec![(x, z), (x + s, z), (x + s, z + s), (x, z + s)]
    }

    #[test]
    fn boxes_that_meet_are_refused_and_their_blocker_named() {
        let mut v = Space::default();
        let a = v.carve("building", "a", sq(0, 0, 2_000), 0, 3_000, 0).unwrap();
        assert_eq!(v.carve("building", "b", sq(1_000, 1_000, 2_000), 0, 3_000, 0), Err(a));
        assert!(v.carve("building", "c", sq(2_500, 0, 2_000), 0, 3_000, 0).is_ok());
    }

    #[test]
    fn a_gap_keeps_neighbours_apart() {
        let mut v = Space::default();
        v.carve("building", "a", sq(0, 0, 2_000), 0, 3_000, 0).unwrap();
        // 3 m off: free with no gap, refused with 5 m
        assert!(v.blocker(&sq(2_300, 0, 1_000), 0, 3_000, 0).is_none());
        assert!(v.blocker(&sq(2_300, 0, 1_000), 0, 3_000, 500).is_some());
    }

    #[test]
    fn under_the_airport_is_free_over_it_is_not() {
        let mut v = Space::default();
        v.carve("airport", "airport", sq(-20_000, -5_000, 40_000), GROUND.0, SKY.1, 0).unwrap();
        // a tunnel in the shallow level passes under it; a viaduct cannot pass over it
        let tunnel = [[-30_000, -1_000, 0], [30_000, -1_000, 0]];
        assert!(v.sweep("tunnel", "m1", &tunnel, 400, 600, 0).is_ok());
        let viaduct = [[-30_000, 900, 10_000], [30_000, 900, 10_000]];
        assert!(v.sweep("viaduct", "cl", &viaduct, 500, 700, 0).is_err());
    }

    #[test]
    fn a_refused_sweep_carves_nothing() {
        let mut v = Space::default();
        v.carve("building", "a", sq(10_000, -1_000, 2_000), 0, 3_000, 0).unwrap();
        let n = v.solids.len();
        let road = [[0, 0, 0], [8_000, 0, 0], [16_000, 0, 0]];
        assert!(v.sweep("road", "r", &road, 500, 500, 0).is_err());
        assert_eq!(v.solids.len(), n);
    }
}
