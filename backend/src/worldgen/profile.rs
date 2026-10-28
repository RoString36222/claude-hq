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

/// One way a street may be paved (generator @3, organic/widen.rs): its full width and
/// sidewalks (cm), and how often (a weight among its kind's tiers) a street is paved so.
/// Every segment of one street is paved alike; a street that cannot have its tier where a
/// lot cannot give way steps down to the next narrower one.
pub struct Tier {
    pub cm: i64,
    pub walk_cm: i64,
    pub weight: u32,
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
    /// On an organic world (@2) these are the layout widths: the blocks, lots and sites
    /// are cut and placed against them.
    pub block_w_cm: i64,
    pub block_d_cm: i64,
    pub road_cm: i64,
    pub avenue_cm: i64,
    /// Organic worlds (@2): the widths (cm, sidewalks included) a local road and an
    /// arterial are paved at, at least the layout's. The extra comes out of the block
    /// and lot strip along the road, so nothing is placed differently (organic/widen.rs).
    pub paved_road_cm: i64,
    pub paved_avenue_cm: i64,
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
    /// An island's coast and sea level (cm): no road or lot goes past the coast or below
    /// the sea. `coast_r_cm` is the farthest the seeded coast reaches, plus 25 m (island.rs).
    /// None for a world on land.
    pub coast_r_cm: Option<i64>,
    pub sea_cm: Option<i64>,
    /// The river's width (cm), from the sea to a harbour basin in town (river.rs). None:
    /// no river (a world without a coast has nowhere for one to run).
    pub river_cm: Option<i64>,
    /// Generator @3 (water.rs): lakes, canals and a marina laid before the streets, and
    /// the water transport round them. Only the @3 profiles set it.
    pub water: bool,
    /// City Gen v4 (phase 2, @3): roads paved and drawn by the plan's classes (classes.rs).
    pub v4: bool,
    /// Generator @3: the tiers a local road and an arterial are paved at, widest first
    /// (organic/widen.rs). Empty: every one at `paved_road_cm` / `paved_avenue_cm`.
    pub local_tiers: &'static [Tier],
    pub arterial_tiers: &'static [Tier],
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
        paved_road_cm: 800,
        paved_avenue_cm: 1_200,
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
        local_tiers: &[],
        arterial_tiers: &[],
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
        river_cm: None,
        water: false,
        v4: false,
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
    // the HQ tabs' doors are civic sites here (civic.rs VIEWS), not view-building slots
    let sites = plaza_sites();
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
        // HQ 3.10: wider roads. Laid out at Arena City's 8 m / 12 m (so every lot, site and
        // HQ stays where it was), paved wider: a local road 10.5 m (a 7 m carriageway, was 5 m;
        // 1.75 m sidewalks, were 1.5), an arterial 15.5 m (11 m, was 8; 2.25 m sidewalks,
        // were 2), a highway 13.5 m (was 10) and the ring 12 m (was 9). @1 keeps city()'s.
        paved_road_cm: 1_050,
        paved_avenue_cm: 1_550,
        street_walk_cm: 175,
        avenue_walk_cm: 225,
        highway_cm: 1_350,
        ring_cm: 1_200,
        radials: (4, 5),
        plaza_cm: 3_600,
        art_ring_pm: 560,
        hq_districts: &[district::DOWNTOWN, district::OFFICE],
        hq_min_m2: 350,
        // an island too: the coast wobbles between the ring road and 975 m
        coast_r_cm: Some(100_000),
        // the sea (and the river's water) 4 m down, as a personal island's: the river's
        // banks are an embankment, not a gorge through the plateau
        sea_cm: Some(-400),
        river_cm: Some(3_600),
        ..city()
    }
}

/// HQ 3.20.1: big-city roads at @3, still on the same layout (every lot, site and HQ
/// where it was). Lanes about 3.6 to 4.5 m, as a game's are, the street's width picked
/// per street: a local road a 7.5 m two-lane side street, a 9.5 m street or an 11.5 m wide
/// one; an arterial a 14.5 m four-lane avenue or a 17.5 m boulevard.
pub const LOCAL_TIERS: [Tier; 3] = [
    Tier { cm: 1_600, walk_cm: 225, weight: 20 },
    Tier { cm: 1_350, walk_cm: 200, weight: 50 },
    Tier { cm: 1_100, walk_cm: 175, weight: 30 },
];
pub const ARTERIAL_TIERS: [Tier; 2] = [
    Tier { cm: 2_300, walk_cm: 275, weight: 40 },
    Tier { cm: 1_950, walk_cm: 250, weight: 60 },
];

/// A world at generator version 3: the version 2 profile (`commons` or `island`) with
/// its water laid (water.rs) and its streets paved by tier.
pub fn with_water(p: Profile) -> Profile {
    // (City Gen v4 phase 2 classes the town's roads; the ring and highways become
    // expressways with their interchanges, phase 6: at-grade, a 29 m road jams its junctions)
    let wide = if p.gates > 0 { super::classes::class("expressway").map_or(p.ring_cm, |c| c.total_cm) } else { p.ring_cm };
    Profile { water: true, v4: true, local_tiers: &LOCAL_TIERS, arterial_tiers: &ARTERIAL_TIERS, ring_cm: wide, highway_cm: wide.max(p.highway_cm), ..p }
}

/// A personal city (`user:<uuid>@2`): a 1.8 km island, the sea round a coast at
/// about 850 m (815 to 885). The city is generated at full size, 800 m out, and grows
/// into it by tier (island.rs). No highways or ring road (nowhere to drive to: ferries
/// and boats leave from the docks); one HQ, its owner's.
pub fn island() -> Profile {
    Profile {
        name: "island",
        legend: &district::NAMES2,
        size_cm: 180_000,
        core_r_cm: 70_000,
        blend_cm: 14_000,
        rise_pm: 40,
        hills: &[(40_000, 2_500), (20_000, 1_000), (10_000, 400), (5_000, 150)],
        plateau: &[(30_000, 600), (12_800, 100)],
        city_r_cm: 80_000,
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
        coast_r_cm: Some(91_000),
        sea_cm: Some(-400),
        river_cm: Some(2_400),
        ..commons()
    }
}
