//! The tensor field the arterials are traced through (Chen et al. 2008, "Interactive
//! procedural street modeling"). A 2D symmetric tensor is kept as (cos 2t, sin 2t)
//! times a weight; basis fields are summed, and a road follows the sum's major or
//! minor eigenvector. Basis fields here: radial round the plaza, a grid per
//! rectilinear district, the slope of the land (roads follow the contours) and, on
//! an island, the coast (roads run along it). All Q16, no trig: a direction's tensor
//! is (x2 - z2, 2xz), and the eigenvector back is the half-angle vector.

use super::geom::{len, unit, P};
use super::super::noise::{smoothstep, ONE};
use super::super::terrain::Terrain;

/// A grid basis field: rectilinear along the Q16 unit `dir` round `at`, fading out by `r` cm.
pub struct Grid {
    pub at: P,
    pub dir: P,
    pub r: i64,
}

pub struct Field<'a> {
    pub terrain: &'a Terrain,
    pub grids: Vec<Grid>,
    /// The radial field's reach (cm): the plaza's pull fades over it.
    pub radial_r: i64,
    /// An island's coast radius (cm).
    pub coast_r: Option<i64>,
}

/// The tensor (Q16) whose major eigenvector is the Q16 unit `d`.
fn tensor(d: P) -> P {
    ((d.0 * d.0 - d.1 * d.1) / ONE, 2 * d.0 * d.1 / ONE)
}

impl Field<'_> {
    /// The field at (x, z): its major and minor eigenvectors (Q16 units; minor = major turned left).
    pub fn at(&self, p: P) -> (P, P) {
        let (mut a, mut b) = (0i64, 0i64);
        let mut acc = |t: P, w: i64| {
            a += t.0 * w / ONE;
            b += t.1 * w / ONE;
        };
        // radial: strongest at the plaza, fading over radial_r
        let r = len(p);
        if r > 0 {
            acc(tensor(unit(p)), 2 * ONE * self.radial_r / (self.radial_r + 2 * r));
        }
        for g in &self.grids {
            let d = len((p.0 - g.at.0, p.1 - g.at.1));
            if d < g.r {
                acc(tensor(g.dir), 3 * smoothstep(ONE - d * ONE / g.r) / 2);
            }
        }
        // the land: across the slope (along the contours), weighted by how steep it is
        let t = self.terrain;
        let s = 800;
        let (gx, gz) = (t.height_at(p.0 + s, p.1) - t.height_at(p.0 - s, p.1), t.height_at(p.0, p.1 + s) - t.height_at(p.0, p.1 - s));
        let slope_pm = len((gx, gz)) * 1000 / (2 * s);
        if slope_pm > 0 {
            acc(tensor(unit((-gz, gx))), (slope_pm * ONE / 30).min(3 * ONE));
        }
        if let Some(c) = self.coast_r {
            let w = smoothstep(ONE - (r - c).abs() * ONE / 15_000);
            if w > 0 && r > 0 {
                let u = unit(p);
                acc(tensor((-u.1, u.0)), 2 * w);
            }
        }
        let m = len((a, b));
        let major = if m == 0 {
            (ONE, 0)
        } else if a + m == 0 && b == 0 {
            (0, ONE)
        } else {
            unit((a + m, b))
        };
        (major, (-major.1, major.0))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_plaza_field_is_radial() {
        let t = Terrain { cell_cm: 800, origin_cm: -40_000, n: 101, heights: vec![0; 101 * 101] };
        let f = Field { terrain: &t, grids: vec![], radial_r: 30_000, coast_r: None };
        let (major, _) = f.at((5_000, 5_000));
        // radial: along (1, 1), either sign
        assert!((major.0.abs() - 46341).abs() < 3_000 && (major.1.abs() - 46341).abs() < 3_000, "{major:?}");
        let g = Field { terrain: &t, grids: vec![Grid { at: (0, 0), dir: (ONE, 0), r: 100_000 }], radial_r: 1, coast_r: None };
        let (major, minor) = g.at((20_000, 20_000));
        assert!(major.0.abs() > 60_000 && minor.1.abs() > 60_000, "{major:?} {minor:?}");
    }
}
