//! Where each district is, and what it is like. The profile's zones are seeds on
//! rings round the plaza; a place belongs to the nearest seed (the distance wobbled
//! by noise, so the borders wander). Each district has a character: how its local
//! streets grow (step, wander, grid or loops, side streets, dead ends) and how big
//! its lots are.

use super::geom::{len, turn, DIR16, P};
use super::super::noise::{value, ONE};
use super::super::profile::{district, Profile};
use super::super::rng::{sub, Rng};
use super::tensor::Grid;

pub struct Seed {
    pub at: P,
    pub district: u8,
    /// The district's grid (Q16 unit), for the rectilinear ones.
    pub dir: P,
}

pub struct Zoning {
    pub seeds: Vec<Seed>,
    city_r: i64,
    wobble: u64,
}

/// How a district grows and divides.
pub struct Character {
    /// Local streets grow here (not in parks or the plaza).
    pub grows: bool,
    /// A local street's step (cm) and how far it wanders per step (degrees, a multiple of 5).
    pub seg_cm: i64,
    pub wander: i64,
    /// Streets keep to the district's grid.
    pub grid: bool,
    /// A steady turn per step (degrees): streets curl into loops.
    pub bend: i64,
    /// Per step, the chance (per mille) of a side street each side, and of the street ending (a cul-de-sac).
    pub branch_pm: u32,
    pub end_pm: u32,
    /// Side streets leave an arterial this far apart (cm).
    pub spacing_cm: i64,
    /// The lot size it splits blocks down to (m2), and a building's floors.
    pub lot_m2: i64,
    pub floors: (i64, i64),
    /// What its local streets are called.
    pub suffix: &'static str,
}

pub fn character(d: u8) -> Character {
    let c = |seg_cm, wander, grid, bend, branch_pm, end_pm, spacing_cm, lot_m2, floors, suffix| Character {
        grows: true, seg_cm, wander, grid, bend, branch_pm, end_pm, spacing_cm, lot_m2, floors, suffix,
    };
    match d {
        // tight and curved, small lots
        district::OLDTOWN => c(2_200, 15, false, 0, 350, 0, 4_500, 160, (2, 4), "Lane"),
        district::CIVIC => c(3_600, 0, true, 0, 300, 0, 6_000, 650, (2, 4), "Walk"),
        // a loose, rotated grid with large lots
        district::DOWNTOWN => c(5_500, 5, true, 0, 450, 0, 7_000, 800, (6, 20), "Street"),
        // dense and rectilinear
        district::OFFICE | district::FINANCE | district::MEDIA => c(4_500, 0, true, 0, 500, 0, 5_000, 650, (4, 10), "Street"),
        // loops and cul-de-sacs
        district::SUBURB => c(3_500, 10, false, 10, 250, 120, 6_000, 450, (1, 2), "Close"),
        // long blocks
        district::INDUSTRIAL | district::LOGISTICS => c(9_000, 0, true, 0, 200, 0, 14_000, 2_200, (1, 2), "Road"),
        // low and wide in green space
        district::TECH | district::BIOTECH => c(7_000, 10, false, 0, 200, 60, 12_000, 3_000, (1, 3), "Drive"),
        // walled backlots
        district::STUDIO => c(7_000, 0, true, 0, 250, 0, 10_000, 2_500, (1, 2), "Row"),
        _ => Character { grows: false, ..c(0, 0, false, 0, 0, 0, 0, 0, (0, 0), "Street") },
    }
}

impl Zoning {
    pub fn new(seed: u64, p: &Profile) -> Self {
        let mut rng = Rng::new(sub(seed, "zones", 0, 0));
        let mut seeds = Vec::new();
        // the inner ring and the outer, each spread evenly round the compass, kinds shuffled
        for inner in [true, false] {
            let mut kinds: Vec<(u8, i64)> = Vec::new();
            for z in p.zones.iter().filter(|z| (z.ring_pm < 400) == inner) {
                kinds.extend((0..z.count).map(|_| (z.district, z.ring_pm)));
            }
            rng.shuffle(&mut kinds);
            let n = kinds.len() as i64;
            let start = rng.range(0, 15);
            for (k, &(d, ring_pm)) in kinds.iter().enumerate() {
                let dir = turn(DIR16[((start + k as i64 * 16 / n.max(1)) % 16) as usize], rng.range(-2, 2) * 5);
                let r = p.city_r_cm * (ring_pm + rng.range(-40, 40)) / 1000;
                let grid = turn(DIR16[rng.range(0, 15) as usize], rng.range(-2, 2) * 5);
                seeds.push(Seed { at: (dir.0 * r / ONE, dir.1 * r / ONE), district: d, dir: grid });
            }
        }
        Zoning { seeds, city_r: p.city_r_cm, wobble: sub(seed, "zones-wobble", 0, 0) }
    }

    /// The district seed whose patch holds `p`; None outside the city.
    pub fn at(&self, p: P) -> Option<&Seed> {
        if len(p) > self.city_r {
            return None;
        }
        // each seed's distance wobbles by its own noise, up to an eighth of the city's radius
        let amp = self.city_r / 8;
        self.seeds
            .iter()
            .enumerate()
            .min_by_key(|&(k, s)| (len((p.0 - s.at.0, p.1 - s.at.1)) + value(self.wobble.wrapping_add(k as u64), p.0, p.1, 12_800) * amp / 32768, k))
            .map(|(_, s)| s)
    }

    pub fn district(&self, p: P) -> Option<u8> {
        self.at(p).map(|s| s.district)
    }

    /// A grid basis field for each rectilinear district.
    pub fn grids(&self) -> Vec<Grid> {
        self.seeds.iter().filter(|s| character(s.district).grid).map(|s| Grid { at: s.at, dir: s.dir, r: self.city_r * 35 / 100 }).collect()
    }
}
