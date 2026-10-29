//! City Gen v5 (docs/plans/city-gen-v5.md): the city planned in a volume.
//!
//! City::plan(seed) runs the decisions in their order, each seeing only the volume still free: the land and water, the
//! airport, the centre and the port, the railways (the transport spine, before any building), the land use and its
//! buildings, the metro.
pub mod airport;
pub mod align;
pub mod land;
pub mod landuse;
pub mod metro;
pub mod rail;
pub mod space;

use super::organic::geom::P;

pub struct City {
    pub land: land::Land,
    pub space: space::Space,
    pub airport: airport::Airport,
    pub hub: P,
    pub port: Option<(P, P)>,
    pub rail: Vec<rail::Line>,
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
        let landuse = landuse::plan(&land, &airport, hub, port, &mut space);
        let metro = metro::plan(&land, &landuse, &airport, &mut space);
        Ok(City { land, space, airport, hub, port, rail, landuse, metro })
    }
}
