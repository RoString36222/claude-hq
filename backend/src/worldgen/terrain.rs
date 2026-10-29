//! Terrain: a heightfield (cm) on a square grid. The generated heights are the
//! BASE; edits (brushes) are applied on top, in order, so the land can be
//! reshaped without regenerating -- and without moving anything built on it.

use serde::{Deserialize, Serialize};

use super::noise::{fbm, isqrt, smoothstep, ONE};
use super::profile::Profile;
use super::rng::sub;

#[derive(Serialize, Clone)]
pub struct Terrain {
    /// Grid spacing and the world's -x/-z corner (cm); `n` vertices a side, row-major (z, then x).
    pub cell_cm: i64,
    pub origin_cm: i64,
    pub n: usize,
    pub heights: Vec<i32>,
}

/// A terrain edit: a brush at (x, z) cm with a radius (cm). Applied in order.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "op", rename_all = "lowercase")]
pub enum Edit {
    /// Up (or down, for a negative amount) by `cm` at the centre, falling off smoothly to the rim.
    Raise { x: i64, z: i64, r: i64, cm: i64 },
    /// Pull everything inside toward height `y`, fully at the centre, blending to the rim.
    Flatten { x: i64, z: i64, r: i64, y: i64 },
    /// Average each point with its neighbours, `passes` times, inside the radius.
    Smooth { x: i64, z: i64, r: i64, passes: i64 },
}

/// Most edits a world keeps, and the largest brush (cm): an edit list is input
/// from outside, so it is bounded.
pub const MAX_EDITS: usize = 512;
pub const MAX_RADIUS_CM: i64 = 40_000;

/// The base terrain of world `seed` with profile `p`, its river (if any) shaped in.
pub fn generate(seed: u64, p: &Profile) -> Terrain {
    let river = super::river::River::new(seed, p).ok().flatten();
    generate_with(seed, p, river.as_ref())
}

/// The base terrain, with the coast's sea and then `river` (already generated) shaped in.
/// City Gen v5: how far (cm) the city's plateau is raised (its lowest ground was at the sea's level).
pub const V5_LIFT_CM: i64 = 800;

pub fn generate_with(seed: u64, p: &Profile, river: Option<&super::river::River>) -> Terrain {
    let n = (p.size_cm / p.cell_cm) as usize + 1;
    let origin = -p.size_cm / 2;
    let (hs, ps) = (sub(seed, "terrain", 0, 0), sub(seed, "plateau", 0, 0));
    let mut heights = Vec::with_capacity(n * n);
    for iz in 0..n {
        for ix in 0..n {
            let (x, z) = (origin + ix as i64 * p.cell_cm, origin + iz as i64 * p.cell_cm);
            let d = isqrt(x * x + z * z);
            let hills = fbm(hs, x, z, p.hills) + (d - p.core_r_cm).max(0) * p.rise_pm / 1000;
            // v5: the city's plateau stands V5_LIFT_CM up, clear of the sea (its lows were the sea's level, so wet)
            let plateau = fbm(ps, x, z, p.plateau) + if p.v5 { V5_LIFT_CM } else { 0 };
            let t = smoothstep((d - p.core_r_cm) * ONE / p.blend_cm);
            heights.push((plateau + (hills - plateau) * t / ONE) as i32);
        }
    }
    let mut t = Terrain { cell_cm: p.cell_cm, origin_cm: origin, n, heights };
    // an island's coast: the sea round it (island.rs)
    if let Some(coast) = super::island::Coast::new(seed, p) {
        coast.shape(&mut t);
    }
    // and the river running into it (river.rs)
    if let Some(r) = river {
        r.shape(&mut t);
    }
    t
}

impl Terrain {
    fn at(&self, ix: usize, iz: usize) -> i64 {
        self.heights[iz * self.n + ix] as i64
    }

    /// Height (cm) at any point, bilinear between the grid's vertices; clamped to the world.
    pub fn height_at(&self, x: i64, z: i64) -> i64 {
        let max = (self.n as i64 - 1) * self.cell_cm;
        let (lx, lz) = ((x - self.origin_cm).clamp(0, max), (z - self.origin_cm).clamp(0, max));
        let (ix, iz) = ((lx / self.cell_cm) as usize, (lz / self.cell_cm) as usize);
        let (ix1, iz1) = ((ix + 1).min(self.n - 1), (iz + 1).min(self.n - 1));
        let fx = lx % self.cell_cm * ONE / self.cell_cm;
        let fz = lz % self.cell_cm * ONE / self.cell_cm;
        let a = self.at(ix, iz) + (self.at(ix1, iz) - self.at(ix, iz)) * fx / ONE;
        let b = self.at(ix, iz1) + (self.at(ix1, iz1) - self.at(ix, iz1)) * fx / ONE;
        a + (b - a) * fz / ONE
    }

    /// The grid vertex nearest (x, z).
    pub fn vertex_of(&self, x: i64, z: i64) -> (usize, usize) {
        let max = self.n as i64 - 1;
        let f = |v: i64| ((v - self.origin_cm + self.cell_cm / 2).div_euclid(self.cell_cm)).clamp(0, max) as usize;
        (f(x), f(z))
    }

    pub fn vertex_pos(&self, ix: usize, iz: usize) -> (i64, i64) {
        (self.origin_cm + ix as i64 * self.cell_cm, self.origin_cm + iz as i64 * self.cell_cm)
    }

    /// Apply edits in order. Rejects an oversized list or brush instead of clamping it.
    pub fn apply(&mut self, edits: &[Edit]) -> Result<(), String> {
        if edits.len() > MAX_EDITS {
            return Err(format!("at most {MAX_EDITS} terrain edits"));
        }
        for (k, e) in edits.iter().enumerate() {
            let (x, z, r) = match *e {
                Edit::Raise { x, z, r, .. } | Edit::Flatten { x, z, r, .. } | Edit::Smooth { x, z, r, .. } => (x, z, r),
            };
            if !(1..=MAX_RADIUS_CM).contains(&r) {
                return Err(format!("edit {k}: radius must be 1..={MAX_RADIUS_CM} cm"));
            }
            let half = (self.n as i64 - 1) * self.cell_cm / 2;
            if x.abs() > half || z.abs() > half {
                return Err(format!("edit {k}: centre is outside the world"));
            }
            match *e {
                Edit::Raise { cm, .. } if cm.abs() > 20_000 => return Err(format!("edit {k}: raise at most 200 m")),
                Edit::Flatten { y, .. } if y.abs() > 100_000 => return Err(format!("edit {k}: flatten height out of range")),
                Edit::Smooth { passes, .. } if !(1..=8).contains(&passes) => return Err(format!("edit {k}: smooth 1..=8 passes")),
                _ => {}
            }
            self.brush(e, x, z, r);
        }
        Ok(())
    }

    fn brush(&mut self, e: &Edit, x: i64, z: i64, r: i64) {
        let (lo, hi) = (self.vertex_of(x - r, z - r), self.vertex_of(x + r, z + r));
        // weight: 1 (Q16) at the centre, smoothly 0 at the rim
        let weight = |vx: i64, vz: i64| {
            let d = isqrt((vx - x) * (vx - x) + (vz - z) * (vz - z));
            if d >= r { 0 } else { smoothstep(ONE - d * ONE / r) }
        };
        match *e {
            Edit::Raise { cm, .. } => self.each(lo, hi, |t, ix, iz, h| {
                let (vx, vz) = t.vertex_pos(ix, iz);
                h + cm * weight(vx, vz) / ONE
            }),
            Edit::Flatten { y, .. } => self.each(lo, hi, |t, ix, iz, h| {
                let (vx, vz) = t.vertex_pos(ix, iz);
                h + (y - h) * weight(vx, vz) / ONE
            }),
            Edit::Smooth { passes, .. } => {
                for _ in 0..passes {
                    let before = self.clone();
                    self.each(lo, hi, |_, ix, iz, h| {
                        let (vx, vz) = before.vertex_pos(ix, iz);
                        let w = weight(vx, vz);
                        if w == 0 {
                            return h;
                        }
                        let (mut sum, mut cnt) = (0i64, 0i64);
                        for (dx, dz) in [(-1i64, 0i64), (1, 0), (0, -1), (0, 1), (0, 0)] {
                            let (nx, nz) = (ix as i64 + dx, iz as i64 + dz);
                            if nx >= 0 && nz >= 0 && (nx as usize) < before.n && (nz as usize) < before.n {
                                sum += before.at(nx as usize, nz as usize);
                                cnt += 1;
                            }
                        }
                        h + (sum / cnt - h) * w / ONE
                    });
                }
            }
        }
    }

    fn each(&mut self, lo: (usize, usize), hi: (usize, usize), f: impl Fn(&Terrain, usize, usize, i64) -> i64) {
        for iz in lo.1..=hi.1 {
            for ix in lo.0..=hi.0 {
                let h = f(self, ix, iz, self.at(ix, iz));
                self.heights[iz * self.n + ix] = h.clamp(i32::MIN as i64, i32::MAX as i64) as i32;
            }
        }
    }
}
