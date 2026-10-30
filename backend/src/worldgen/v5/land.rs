//! City Gen v5: the island as the generator sees it, before anything is placed: its terrain, coast, river and the water
//! bodies laid with the river (the @3 pieces, reused), and what is buildable land.
use super::super::island::Coast;
use super::super::organic::geom::{inside, P};
use super::super::profile::Profile;
use super::super::river::River;
use super::super::terrain::Terrain;
use super::super::{island, profile_for, river, rng, terrain, water};

/// The water's level in the volume: from `COVER_CM` under its bed (a tunnel passes below that) to `SHIP_CM` over its
/// surface (the boats on it), carved in `WATER_CELL_CM` squares.
pub const COVER_CM: i64 = 300;
pub const SHIP_CM: i64 = 600;
const WATER_CELL_CM: i64 = 1_000;

pub struct Land {
    pub seed: u64,
    pub p: Profile,
    pub t: Terrain,
    pub coast: Option<Coast>,
    pub river: Option<River>,
    /// The lakes, canals and marina (their outlines, cm).
    pub water: Vec<Vec<P>>,
    /// The water's plan, finished on the streets once they are laid (v5/doc.rs).
    pub plan: Option<water::Plan>,
}

impl Land {
    /// The land of world `seed` (a world id's seed: "claude-hq", "user:<uuid>") at generator version 4.
    pub fn new(seed: &str) -> Result<Land, String> {
        let p = profile_for(seed, 4);
        let seed = rng::fnv1a64(seed.as_bytes());
        let mut rv = river::River::new(seed, &p)?;
        let coast = island::Coast::new(seed, &p);
        let mut plan = match (&mut rv, &coast) {
            (Some(r), Some(c)) if p.water => Some(water::lay(seed, &p, r, c)),
            _ => None,
        };
        let mut t = terrain::generate_with(seed, &p, rv.as_ref());
        if let Some(plan) = plan.as_mut() {
            plan.shape(&mut t);
        }
        let water = plan.as_ref().map_or(Vec::new(), |w| w.outlines());
        Ok(Land { seed, p, t, coast, river: rv, water, plan })
    }

    /// Buildable: inside the coast, off the river and its banks' zone, out of every lake, canal and the marina.
    pub fn dry(&self, q: P) -> bool {
        self.coast.as_ref().is_none_or(|c| inside(q, &c.poly))
            && !self.river.as_ref().is_some_and(|r| r.zone(q))
            && !self.water.iter().any(|w| inside(q, w))
    }

    pub fn height(&self, q: P) -> i64 {
        self.t.height_at(q.0, q.1)
    }

    /// The city's diameter (cm): what the airport's runway is a quarter of.
    pub fn city_d(&self) -> i64 {
        2 * self.p.city_r_cm
    }
}

impl Land {
    /// Over the water at q: the top of its level (its surface and the boats on it, cm), where a bridge's deck goes.
    pub fn water_top(&self, q: P) -> Option<i64> {
        let r = self.river.as_ref().filter(|r| inside(q, &r.poly.iter().map(|p| (p[0], p[1])).collect::<Vec<P>>())).map(|r| r.sea_cm());
        let b = self.plan.as_ref().and_then(|p| p.levels().into_iter().find(|(poly, _, _)| inside(q, poly)).map(|(_, l, _)| l));
        r.or(b).map(|l| l + SHIP_CM)
    }

    /// The river, lakes, canals and marina as solids ("water"): nothing may be laid through their level, a tunnel
    /// passes under it and a bridge over it.
    pub fn carve_water(&self, space: &mut super::space::Space) {
        let mut bodies: Vec<(String, Vec<P>, i64, i64)> = Vec::new();
        if let Some(r) = &self.river {
            bodies.push(("river".to_string(), r.poly.iter().map(|q| (q[0], q[1])).collect(), r.sea_cm(), river::DEPTH_CM));
        }
        if let Some(plan) = &self.plan {
            for (k, (poly, level, bed)) in plan.levels().into_iter().enumerate() {
                bodies.push((format!("water:{k}"), poly, level, bed));
            }
        }
        let h = WATER_CELL_CM / 2;
        for (owner, poly, level, bed) in bodies {
            let (x0, x1, z0, z1) = poly.iter().fold((i64::MAX, i64::MIN, i64::MAX, i64::MIN), |b, q| (b.0.min(q.0), b.1.max(q.0), b.2.min(q.1), b.3.max(q.1)));
            for i in x0.div_euclid(WATER_CELL_CM)..=x1.div_euclid(WATER_CELL_CM) {
                for j in z0.div_euclid(WATER_CELL_CM)..=z1.div_euclid(WATER_CELL_CM) {
                    let c = (i * WATER_CELL_CM + h, j * WATER_CELL_CM + h);
                    if inside(c, &poly) {
                        let sq = vec![(c.0 - h, c.1 - h), (c.0 + h, c.1 - h), (c.0 + h, c.1 + h), (c.0 - h, c.1 + h)];
                        space.put("water", &owner, sq, level - bed - COVER_CM, level + SHIP_CM);
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    /// The water holds its level: nothing else is laid through it (a tunnel goes under, a bridge over).
    #[test]
    fn nothing_meets_the_water_s_level() {
        let c = super::super::commons();
        let water: Vec<&super::super::space::Solid> = c.space.solids.iter().filter(|s| s.kind == "water").collect();
        assert!(water.len() > 100, "{} water cells", water.len());
        for o in c.space.solids.iter().filter(|s| s.kind != "water") {
            let hit = water.iter().find(|w| w.y0 < o.y1 && o.y0 < w.y1 && super::super::space::near(&w.poly, &o.poly, -1));
            assert!(hit.is_none(), "{} ({}) meets the water ({}) at {:?}", o.kind, o.owner, hit.unwrap().owner, o.poly[0]);
        }
    }
}
