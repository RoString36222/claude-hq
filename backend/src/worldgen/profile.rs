//! A profile is everything about a kind of world that is not the seed: its size,
//! the city's grid, how hilly the land is, how many lots, and the sites features
//! reserve. A new kind of map is a new profile, not new generator code.

/// Where a site goes.
pub enum Place {
    /// In the plaza block, this far (cm) from its centre.
    Plaza { dx: i64, dz: i64 },
    /// In blocks of a district, nearest the plaza first, `per_block` to a block.
    Slots { district: u8, per_block: i64 },
}

/// A site a feature reserves: the generator finds it a valid place.
pub struct SiteSpec {
    pub kind: &'static str,
    pub count: i64,
    pub w_cm: i64,
    pub d_cm: i64,
    pub place: Place,
}

pub struct Profile {
    pub name: &'static str,
    /// The world is a square this wide (cm), centred on the origin.
    pub size_cm: i64,
    /// Terrain grid spacing (cm).
    pub cell_cm: i64,
    /// The city sits on a plateau this wide (radius, cm); the land blends into hills over `blend_cm`.
    pub core_r_cm: i64,
    pub blend_cm: i64,
    /// Beyond the core the land rises this much per metre (per mille).
    pub rise_pm: i64,
    /// Hills and plateau: octaves of (cell cm, amplitude cm).
    pub hills: &'static [(i64, i64)],
    pub plateau: &'static [(i64, i64)],
    /// City grid: a block, the road round it, and every `avenue_every`-th line an avenue.
    pub block_w_cm: i64,
    pub block_d_cm: i64,
    pub road_cm: i64,
    pub avenue_cm: i64,
    pub avenue_every: i64,
    /// Blocks whose centre is within this radius (cm) of the plaza are city.
    pub city_r_cm: i64,
    /// How many HQ lots (the pool new members are assigned from) and lots per tier.
    pub hq_lots: i64,
    pub hq_tier: i64,
    pub commercial_r_cm: i64,
    pub park_pm: u32,
    /// Roads out of the city to the world's edge, and the country ring that links them.
    pub gates: i64,
    pub ring_r_cm: i64,
    /// Steepest a road may be (per mille), in the city and in the country.
    pub city_grade_pm: i64,
    pub country_grade_pm: i64,
    /// Steepest ground a site or lot may stand on (cm of rise across its footprint).
    pub site_flat_cm: i64,
    pub sites: Vec<SiteSpec>,
}

pub mod district {
    pub const WILD: u8 = 0;
    pub const FARMLAND: u8 = 1;
    pub const FOREST: u8 = 2;
    pub const PLAZA: u8 = 3;
    pub const CIVIC: u8 = 4;
    pub const HQ: u8 = 5;
    pub const COMMERCIAL: u8 = 6;
    pub const RESIDENTIAL: u8 = 7;
    pub const PARK: u8 = 8;
    pub const INDUSTRIAL: u8 = 9;
    pub const STREET: u8 = 10;
    pub const NAMES: [&str; 11] = [
        "wild", "farmland", "forest", "plaza", "civic", "hq", "commercial", "residential", "park", "industrial", "street",
    ];
}

/// Arena City: a 2 km world, a city on a plateau in the middle, hills around it.
pub fn city() -> Profile {
    Profile {
        name: "city",
        size_cm: 204_800,
        cell_cm: 800,
        core_r_cm: 52_000,
        blend_cm: 16_000,
        rise_pm: 60,
        hills: &[(51_200, 4_000), (25_600, 1_800), (12_800, 700), (6_400, 250), (3_200, 90)],
        plateau: &[(40_000, 250), (12_800, 60)],
        block_w_cm: 3_600,
        block_d_cm: 2_600,
        road_cm: 800,
        avenue_cm: 1_200,
        avenue_every: 4,
        city_r_cm: 48_000,
        hq_lots: 64,
        hq_tier: 16,
        commercial_r_cm: 32_000,
        park_pm: 120,
        gates: 6,
        ring_r_cm: 78_000,
        city_grade_pm: 80,
        country_grade_pm: 140,
        site_flat_cm: 150,
        // sizes from today's City: the fountain (games/hqcity.js, r 4.45 m), the skatepark
        // (games/hqskate.js HW 5.75, HD 11) and the bike park's pad
        sites: vec![
            SiteSpec { kind: "fountain", count: 1, w_cm: 900, d_cm: 900, place: Place::Plaza { dx: 0, dz: 0 } },
            SiteSpec { kind: "skatepark", count: 1, w_cm: 1_150, d_cm: 2_200, place: Place::Plaza { dx: 1_100, dz: 0 } },
            SiteSpec { kind: "bikepark", count: 1, w_cm: 400, d_cm: 1_000, place: Place::Plaza { dx: -1_100, dz: 0 } },
            SiteSpec { kind: "spawn", count: 1, w_cm: 200, d_cm: 200, place: Place::Plaza { dx: 0, dz: 1_000 } },
            // One per HQ tab (Analytics, Gym, Store, ...): 16 slots, two to a civic block.
            SiteSpec { kind: "view-building", count: 16, w_cm: 1_600, d_cm: 2_200, place: Place::Slots { district: district::CIVIC, per_block: 2 } },
        ],
    }
}
