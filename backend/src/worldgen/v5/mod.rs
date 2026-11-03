//! City Gen v5 (docs/plans/city-gen-v5.md): the city planned in a volume.
//!
//! City::plan(seed) runs the decisions in their order, each seeing only the volume still free: the land and water, the
//! airport, the centre and the port, the railways (the transport spine, before any building), the land's uses, the
//! arterials between their centres, the buildings round them, the metro.
pub mod airport;
pub mod align;
pub mod doc;
pub mod land;
pub mod landuse;
pub mod metro;
pub mod rail;
pub mod roads;
pub mod space;

use super::organic::geom::P;

pub struct City {
    pub land: land::Land,
    pub space: space::Space,
    pub airport: airport::Airport,
    pub hub: P,
    pub port: Option<(P, P)>,
    pub rail: Vec<rail::Line>,
    /// The places the arterials join, and the arterials.
    pub centres: Vec<P>,
    pub arterials: Vec<roads::Road>,
    /// The local streets between the plots, and the links joining their networks to the arterials.
    pub streets: Vec<roads::Road>,
    pub landuse: landuse::LandUse,
    pub metro: metro::Metro,
}

impl City {
    pub fn plan(seed: &str) -> Result<City, String> {
        let land = land::Land::new(seed)?;
        let mut space = space::Space::default();
        // the water takes its level first: the boats on it, the bed under it
        land.carve_water(&mut space);
        let airport = airport::place(&land, &mut space).ok_or("v5: no room for the airport")?;
        let (hub, port) = landuse::centre(&land, &airport);
        let rail = rail::plan(&land, hub, port, &airport, &mut space);
        // the land's uses, the arterials between their centres, then the buildings round them
        let cells = landuse::zone(&land, &airport, hub, port);
        let centres = roads::centres(hub, port, &airport, &rail, &cells);
        let arterials = roads::arterials(&land, &mut space, &centres);
        let (mut buildings, frames) = landuse::build(&land, hub, &cells, &arterials, &mut space);
        let mut streets = roads::locals(&land, &mut space, hub, &buildings, &frames, &arterials);
        // every building reachable: a street network that could not be joined to the arterials goes, with the buildings
        // only it serves (their space stays empty)
        let comps = roads::components(&arterials, &streets);
        let main = comps.first().copied();
        let mut k = arterials.len();
        streets.retain(|_| { k += 1; comps.get(k - 1).copied() == main });
        let near = |q: P| arterials.iter().chain(&streets).any(|r| r.points.iter().any(|p| (p[0] - q.0).pow(2) + (p[2] - q.1).pow(2) <= 5_000i64.pow(2)));
        buildings.retain(|b| near(b.c));
        let landuse = landuse::LandUse { hub, port, cells, buildings, frames };
        let metro = metro::plan(&land, &landuse, &airport, &mut space);
        Ok(City { land, space, airport, hub, port, rail, centres, arterials, streets, landuse, metro })
    }
}

/// The Commons' plan, made once for every test that reads it (planning it in each, in parallel, slows the suite's
/// timed tests).
#[cfg(test)]
pub fn commons() -> &'static City {
    static C: std::sync::OnceLock<City> = std::sync::OnceLock::new();
    C.get_or_init(|| City::plan("claude-hq").expect("the Commons plans"))
}
