//! City Gen v5: the island as the generator sees it, before anything is placed: its terrain, coast, river and the water
//! bodies laid with the river (the @3 pieces, reused), and what is buildable land.
use super::super::island::Coast;
use super::super::organic::geom::{inside, P};
use super::super::profile::Profile;
use super::super::river::River;
use super::super::terrain::Terrain;
use super::super::{island, profile_for, river, rng, terrain, water};

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
