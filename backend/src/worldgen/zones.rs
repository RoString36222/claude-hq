//! Industry zones (@2): the district kinds a city works in. Each has a tier gate (the
//! first city tier its buildings stand in), a zone building (the site kind civic.rs
//! places on its lots: the workplace), the good it makes, and a job table NPCs read to
//! know who works there and when. `layers.zones` lists the zones a world has.
//!
//! Every city has a specialty good, chosen by its seed: one of the zones it already
//! has, else any of them, and then the outermost suburb becomes that zone (a personal
//! island has no industry of its own until then).

use serde::Serialize;

use super::city::{Block, Lot};
use super::profile::district;
use super::rng::{sub, Rng};

/// A job in a zone: what share (per mille) of its workers do it, and their shift
/// (minutes from midnight; an end before the start runs past midnight).
#[derive(Serialize)]
pub struct Job {
    pub job: &'static str,
    pub start_min: u16,
    pub end_min: u16,
    pub share_pm: u16,
}

pub struct Industry {
    pub district: u8,
    /// The zone building's site kind, its first tier and its footprint (cm).
    pub kind: &'static str,
    pub tier: u8,
    pub w_cm: i64,
    pub d_cm: i64,
    /// What it makes (the market's good when it is the city's specialty).
    pub good: &'static str,
    pub jobs: &'static [Job],
}

const fn job(job: &'static str, start_h: u16, end_h: u16, share_pm: u16) -> Job {
    Job { job, start_min: start_h * 60, end_min: end_h * 60, share_pm }
}

pub const INDUSTRY: [Industry; 8] = [
    Industry {
        district: district::OFFICE, kind: "office", tier: 3, w_cm: 1_800, d_cm: 1_600, good: "services",
        jobs: &[job("clerk", 9, 17, 450), job("manager", 8, 18, 200), job("receptionist", 8, 16, 150), job("cleaner", 18, 22, 100), job("guard", 22, 6, 100)],
    },
    Industry {
        district: district::TECH, kind: "campus", tier: 3, w_cm: 3_000, d_cm: 2_400, good: "tech",
        jobs: &[job("engineer", 10, 19, 500), job("designer", 10, 18, 200), job("barista", 7, 15, 100), job("researcher", 11, 20, 150), job("guard", 22, 6, 50)],
    },
    Industry {
        district: district::STUDIO, kind: "studio", tier: 4, w_cm: 3_000, d_cm: 2_400, good: "film",
        jobs: &[job("crew", 6, 18, 400), job("actor", 8, 17, 150), job("editor", 12, 22, 200), job("caterer", 5, 13, 100), job("guard", 18, 6, 150)],
    },
    Industry {
        district: district::FINANCE, kind: "finance", tier: 4, w_cm: 1_800, d_cm: 1_600, good: "capital",
        jobs: &[job("trader", 7, 16, 400), job("analyst", 8, 19, 300), job("teller", 9, 17, 200), job("guard", 20, 8, 100)],
    },
    Industry {
        district: district::BIOTECH, kind: "biotech", tier: 5, w_cm: 2_800, d_cm: 2_200, good: "medicine",
        jobs: &[job("scientist", 9, 18, 450), job("technician", 7, 15, 250), job("technician", 15, 23, 150), job("guard", 23, 7, 150)],
    },
    Industry {
        district: district::MEDIA, kind: "media", tier: 3, w_cm: 1_800, d_cm: 1_600, good: "content",
        jobs: &[job("writer", 10, 18, 400), job("producer", 9, 19, 250), job("host", 6, 12, 150), job("night editor", 18, 2, 200)],
    },
    Industry {
        district: district::LOGISTICS, kind: "warehouse", tier: 2, w_cm: 3_000, d_cm: 2_400, good: "freight",
        jobs: &[job("loader", 6, 14, 350), job("loader", 14, 22, 300), job("driver", 5, 15, 200), job("dispatcher", 7, 17, 150)],
    },
    Industry {
        district: district::FARM, kind: "farm", tier: 1, w_cm: 2_400, d_cm: 2_400, good: "food",
        jobs: &[job("farmer", 5, 15, 500), job("fisher", 4, 12, 300), job("packer", 8, 16, 200)],
    },
];

pub fn industry(d: u8) -> Option<&'static Industry> {
    INDUSTRY.iter().find(|i| i.district == d)
}

/// A zone of `layers.zones`: an industry district this world has.
#[derive(Serialize)]
pub struct Zone {
    pub district: u8,
    pub kind: &'static str,
    pub tier: u8,
    pub good: &'static str,
    /// The city's specialty good is made here.
    pub specialty: bool,
    pub jobs: &'static [Job],
}

/// The city's specialty: one of the industries it has blocks of (by seed), else any.
pub fn specialty(seed: u64, blocks: &[Block]) -> &'static Industry {
    let have: Vec<&Industry> = INDUSTRY.iter().filter(|i| blocks.iter().any(|b| b.district == i.district)).collect();
    let mut rng = Rng::new(sub(seed, "specialty", 0, 0));
    if have.is_empty() {
        &INDUSTRY[rng.range(0, INDUSTRY.len() as i64 - 1) as usize]
    } else {
        have[rng.range(0, have.len() as i64 - 1) as usize]
    }
}

/// Make sure the specialty's zone exists: if no block is of its district, the suburb
/// block farthest from the plaza and its suburb neighbours (within 150 m, a third of
/// the suburbs at most) become it, with their lots.
pub fn ensure_specialty(seed: u64, blocks: &mut [Block], lots: &mut [Lot]) {
    let s = specialty(seed, blocks);
    if blocks.iter().any(|b| b.district == s.district) {
        return;
    }
    let suburbs: Vec<usize> = (0..blocks.len()).filter(|&b| blocks[b].district == district::SUBURB && lots.iter().any(|l| l.block == b as u32)).collect();
    let Some(&far) = suburbs.iter().max_by_key(|&&b| (blocks[b].x.pow(2) + blocks[b].z.pow(2), std::cmp::Reverse(b))) else {
        return;
    };
    let (fx, fz) = (blocks[far].x, blocks[far].z);
    let mut near: Vec<(i64, usize)> = suburbs.iter().map(|&b| ((blocks[b].x - fx).pow(2) + (blocks[b].z - fz).pow(2), b)).filter(|&(d2, _)| d2 <= 15_000 * 15_000).collect();
    near.sort();
    near.truncate((suburbs.len() / 3).max(1));
    for &(_, b) in &near {
        blocks[b].district = s.district;
        for l in lots.iter_mut().filter(|l| l.block == b as u32) {
            l.district = s.district;
        }
    }
}

/// `layers.zones`: every industry with blocks in this world, in table order.
pub fn layer(seed: u64, blocks: &[Block]) -> Vec<Zone> {
    let s = specialty(seed, blocks);
    INDUSTRY
        .iter()
        .filter(|i| blocks.iter().any(|b| b.district == i.district))
        .map(|i| Zone { district: i.district, kind: i.kind, tier: i.tier, good: i.good, specialty: i.district == s.district, jobs: i.jobs })
        .collect()
}
