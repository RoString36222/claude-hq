//! City Gen v5 (docs/plans/city-gen-v5.md): the city planned in a volume.
//!
//! City::plan(seed) runs the decisions in their order, each seeing only the volume still free: the land and water, the
//! airport, the centre and the port, the railways (the transport spine, before any building), the land's uses, the
//! arterials between their centres, the buildings round them, the metro.
pub mod airport;
pub mod align;
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
        let airport = airport::place(&land, &mut space).ok_or("v5: no room for the airport")?;
        let (hub, port) = landuse::centre(&land, &airport);
        let rail = rail::plan(&land, hub, port, &airport, &mut space);
        // the land's uses, the arterials between their centres, then the buildings round them
        let cells = landuse::zone(&land, &airport, hub, port);
        let centres = roads::centres(hub, port, &airport, &rail, &cells);
        let arterials = roads::arterials(&land, &mut space, &centres);
        let buildings = landuse::build(&land, hub, &cells, &mut space);
        let landuse = landuse::LandUse { hub, port, cells, buildings };
        let streets = roads::locals(&land, &mut space, hub, &landuse.buildings, &arterials);
        let metro = metro::plan(&land, &landuse, &airport, &mut space);
        Ok(City { land, space, airport, hub, port, rail, centres, arterials, streets, landuse, metro })
    }
}
