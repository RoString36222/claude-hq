//! The district map: what kind of place every 8 m of the world is. Inside the
//! city it is the block's district (or street, between blocks); outside, forest
//! on the high ground and farmland on the low, with a seeded wild fringe.

use serde::Serialize;

use super::city::{Block, Grid};
use super::noise::value;
use super::profile::{district, Profile};
use super::rng::sub;
use super::terrain::Terrain;

#[derive(Serialize, Clone)]
pub struct Districts {
    pub cell_cm: i64,
    pub origin_cm: i64,
    pub n: usize,
    /// Row-major (z, then x); an index into `legend`.
    pub kinds: Vec<u8>,
    pub legend: Vec<&'static str>,
}

pub const CELL_CM: i64 = 800; // the terrain's spacing: finer than a block (26 m), so every block shows

pub fn generate(seed: u64, p: &Profile, base: &Terrain, blocks: &[Block]) -> Districts {
    let g = Grid::new(p);
    let n = (p.size_cm / CELL_CM) as usize;
    let origin = -p.size_cm / 2;
    let ns = sub(seed, "districts-wild", 0, 0);
    let by_cell: std::collections::BTreeMap<(i32, i32), &Block> = blocks.iter().map(|b| ((b.i, b.j), b)).collect();
    let mut kinds = Vec::with_capacity(n * n);
    for iz in 0..n {
        for ix in 0..n {
            let (x, z) = (origin + ix as i64 * CELL_CM + CELL_CM / 2, origin + iz as i64 * CELL_CM + CELL_CM / 2);
            let (bi, bj) = ((x + g.px / 2).div_euclid(g.px) as i32, (z + g.pz / 2).div_euclid(g.pz) as i32);
            let k = match by_cell.get(&(bi, bj)) {
                Some(b) if (x - b.x).abs() <= b.w / 2 && (z - b.z).abs() <= b.d / 2 => b.district,
                Some(_) => district::STREET,
                None if x * x + z * z <= (p.city_r_cm + g.px) * (p.city_r_cm + g.px) => district::STREET,
                None => {
                    let h = base.height_at(x, z);
                    let wild = value(ns, x, z, 25_600);
                    if wild > 16_000 {
                        district::WILD
                    } else if h > 2_500 || wild > 4_000 {
                        district::FOREST
                    } else {
                        district::FARMLAND
                    }
                }
            };
            kinds.push(k);
        }
    }
    Districts { cell_cm: CELL_CM, origin_cm: origin, n, kinds, legend: district::NAMES.to_vec() }
}

impl Districts {
    /// The district at (x, z) cm.
    pub fn at(&self, x: i64, z: i64) -> u8 {
        let f = |v: i64| ((v - self.origin_cm).div_euclid(self.cell_cm)).clamp(0, self.n as i64 - 1) as usize;
        self.kinds[f(z) * self.n + f(x)]
    }
}
