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

/// An organic city's district seeds: `count` seeds of `district` on a ring `ring_pm`
/// per mille of the city's radius out from the plaza. A place is the district of the
/// seed nearest it (with a seeded wobble), so districts are organic patches.
pub struct Zone {
    pub district: u8,
    pub ring_pm: i64,
    pub count: i64,
}

pub struct Profile {
    pub name: &'static str,
    /// The district names this world serialises (`layers.districts.legend`).
    pub legend: &'static [&'static str],
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
    /// Sidewalk width (cm) each side of a street and an avenue, taken out of the road's width.
    pub street_walk_cm: i64,
    pub avenue_walk_cm: i64,
    /// Blocks whose centre is within this radius (cm) of the plaza are city.
    pub city_r_cm: i64,
    /// How many HQ lots (the pool new members are assigned from) and lots per tier.
    pub hq_lots: i64,
    pub hq_tier: i64,
    pub commercial_r_cm: i64,
    pub park_pm: u32,
    /// Highways out of the city to the world's edge (one per gate), and the ring road that links them.
    pub gates: i64,
    pub ring_r_cm: i64,
    /// Full widths (cm) of a highway and of the ring: no sidewalk, a shoulder painted inside.
    pub highway_cm: i64,
    pub ring_cm: i64,
    /// Steepest a road may be (per mille), in the city and on the graded roads (highways, ring).
    pub city_grade_pm: i64,
    pub country_grade_pm: i64,
    /// Steepest ground a site or lot may stand on (cm of rise across its footprint).
    pub site_flat_cm: i64,
    pub sites: Vec<SiteSpec>,
    /// Organic worlds (@2): the district seeds; how many arterials radiate from the
    /// plaza (a range), the plaza's radius (cm) and the arterial ring's (per mille of
    /// the city's radius); the districts the HQ pool's lots are drawn from, and the
    /// smallest an HQ lot may be (m2).
    pub zones: &'static [Zone],
    pub radials: (i64, i64),
    pub plaza_cm: i64,
    pub art_ring_pm: i64,
    pub hq_districts: &'static [u8],
    pub hq_min_m2: i64,
    /// An island's coast (radius, cm) and sea level (cm): no road or lot goes past the
    /// coast or below the sea. None for a world on land.
    pub coast_r_cm: Option<i64>,
    pub sea_cm: Option<i64>,
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
    // organic worlds (@2) add these; @1 keeps serialising NAMES
    pub const OLDTOWN: u8 = 11;
    pub const DOWNTOWN: u8 = 12;
    pub const SUBURB: u8 = 13;
    pub const OFFICE: u8 = 14;
    pub const TECH: u8 = 15;
    pub const STUDIO: u8 = 16;
    pub const FINANCE: u8 = 17;
    pub const BIOTECH: u8 = 18;
    pub const MEDIA: u8 = 19;
    pub const LOGISTICS: u8 = 20;
    pub const FARM: u8 = 21;
    pub const WATER: u8 = 22;
    pub const NAMES2: [&str; 23] = [
        "wild", "farmland", "forest", "plaza", "civic", "hq", "commercial", "residential", "park", "industrial", "street",
        "oldtown", "downtown", "suburb", "office", "tech", "studio", "finance", "biotech", "media", "logistics", "farm", "water",
    ];
}

/// Arena City: a 2 km world, a city on a plateau in the middle, hills around it.
pub fn city() -> Profile {
    Profile {
        name: "city",
        legend: &district::NAMES,
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
        street_walk_cm: 150,
        avenue_walk_cm: 200,
        city_r_cm: 48_000,
        hq_lots: 64,
        hq_tier: 16,
        commercial_r_cm: 32_000,
        park_pm: 120,
        gates: 6,
        ring_r_cm: 78_000,
        highway_cm: 1_000,
        ring_cm: 900,
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
        zones: &[],
        radials: (0, 0),
        plaza_cm: 0,
        art_ring_pm: 0,
        hq_districts: &[],
        hq_min_m2: 0,
        coast_r_cm: None,
        sea_cm: None,
    }
}

/// The plaza's sites, shared by the organic profiles (sizes as Arena City's).
fn plaza_sites() -> Vec<SiteSpec> {
    vec![
        SiteSpec { kind: "fountain", count: 1, w_cm: 900, d_cm: 900, place: Place::Plaza { dx: 0, dz: 0 } },
        SiteSpec { kind: "skatepark", count: 1, w_cm: 1_150, d_cm: 2_200, place: Place::Plaza { dx: 1_100, dz: 0 } },
        SiteSpec { kind: "bikepark", count: 1, w_cm: 400, d_cm: 1_000, place: Place::Plaza { dx: -1_100, dz: 0 } },
        SiteSpec { kind: "spawn", count: 1, w_cm: 200, d_cm: 200, place: Place::Plaza { dx: 0, dz: 1_000 } },
    ]
}

/// The Commons (`claude-hq@2`): Arena City's 2 km world grown organically. Arterials
/// traced through a tensor field, local streets grown between them, districts with
/// their own character, the 64-lot HQ pool downtown. The same land, on a gently
/// rolling plateau for the streets to follow.
pub fn commons() -> Profile {
    let mut sites = plaza_sites();
    // one per HQ tab, on the civic lots nearest the plaza (two to a block at most)
    sites.push(SiteSpec { kind: "view-building", count: 16, w_cm: 1_600, d_cm: 2_200, place: Place::Slots { district: district::CIVIC, per_block: 2 } });
    Profile {
        name: "commons",
        legend: &district::NAMES2,
        plateau: &[(40_000, 900), (12_800, 120)],
        sites,
        zones: &[
            Zone { district: district::CIVIC, ring_pm: 160, count: 1 },
            Zone { district: district::OLDTOWN, ring_pm: 220, count: 2 },
            Zone { district: district::DOWNTOWN, ring_pm: 460, count: 3 },
            Zone { district: district::OFFICE, ring_pm: 500, count: 1 },
            Zone { district: district::PARK, ring_pm: 480, count: 1 },
            Zone { district: district::SUBURB, ring_pm: 820, count: 3 },
            Zone { district: district::INDUSTRIAL, ring_pm: 860, count: 1 },
            Zone { district: district::TECH, ring_pm: 820, count: 1 },
            Zone { district: district::STUDIO, ring_pm: 860, count: 1 },
        ],
        radials: (4, 5),
        plaza_cm: 3_600,
        art_ring_pm: 560,
        hq_districts: &[district::DOWNTOWN, district::OFFICE],
        hq_min_m2: 350,
        ..city()
    }
}

/// A personal city (`user:<uuid>@2`): a 1.8 km island, the sea round a coast at
/// about 850 m. The commons algorithm on a smaller core for now: the island's own
/// coast, docks and growth tiers come later (gen-island). No highways or ring road
/// (nowhere to drive to: ferries and boats leave from the docks); one HQ, its owner's.
pub fn island() -> Profile {
    Profile {
        name: "island",
        legend: &district::NAMES2,
        size_cm: 180_000,
        core_r_cm: 34_000,
        blend_cm: 14_000,
        rise_pm: 40,
        hills: &[(40_000, 2_500), (20_000, 1_000), (10_000, 400), (5_000, 150)],
        plateau: &[(30_000, 600), (12_800, 100)],
        city_r_cm: 30_000,
        hq_lots: 1,
        hq_tier: 1,
        gates: 0,
        ring_r_cm: 0,
        sites: plaza_sites(),
        zones: &[
            Zone { district: district::CIVIC, ring_pm: 220, count: 1 },
            Zone { district: district::OLDTOWN, ring_pm: 300, count: 1 },
            Zone { district: district::DOWNTOWN, ring_pm: 560, count: 1 },
            Zone { district: district::PARK, ring_pm: 700, count: 1 },
            Zone { district: district::SUBURB, ring_pm: 820, count: 3 },
        ],
        radials: (4, 4),
        art_ring_pm: 580,
        hq_districts: &[district::DOWNTOWN, district::OLDTOWN],
        coast_r_cm: Some(85_000),
        sea_cm: Some(-400),
        ..commons()
    }
}
