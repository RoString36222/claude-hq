//! The city: a grid of blocks on the plateau, each block given a district, and
//! each district's blocks cut into lots. The HQ lots are a ranked POOL, nearest
//! the plaza first: members are assigned lots from it (server side, P2), so a new
//! member fills a lot and never moves anyone.
//!
//! Layout depends on the seed and the profile only, never on terrain edits: a
//! reshaped hill re-seats lots and roads on the new ground (their heights), it
//! never moves them.

use std::collections::BTreeMap;

use serde::Serialize;

use super::profile::{district, Place, Profile};
use super::rng::{sub, Rng};
use super::terrain::Terrain;

#[derive(Serialize, Clone)]
pub struct Block {
    pub id: u32,
    pub i: i32,
    pub j: i32,
    /// Centre and size (cm).
    pub x: i64,
    pub z: i64,
    pub w: i64,
    pub d: i64,
    pub district: u8,
    /// Organic worlds (@2): the block's footprint, [x, z] cm, counter-clockwise
    /// (positive area in x, z); x, z, w, d are then its bounding box and i, j are 0.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub poly: Option<Vec<[i64; 2]>>,
}

/// Which side of its rectangle a lot's door is on.
#[derive(Serialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Facing {
    North, // +z
    South, // -z
}

#[derive(Serialize, Clone)]
pub struct Lot {
    pub id: u32,
    pub block: u32,
    /// "hq" (an HQ's lot, from the pool) or "building".
    pub kind: &'static str,
    pub district: u8,
    pub x: i64,
    pub z: i64,
    pub w: i64,
    pub d: i64,
    pub facing: Facing,
    /// The door, on the facing side, on the ground.
    pub door: [i64; 3],
    /// Floors of the building that stands here (0 for an HQ lot: the HQ builds itself).
    pub floors: i64,
    /// HQ lots: rank in the pool (0 = nearest the plaza) and tier (rank / hq_tier).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rank: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tier: Option<u32>,
    /// Organic worlds (@2): the lot's footprint ([x, z] cm, counter-clockwise; x, z
    /// are then its centroid, w its frontage and d its depth); `front`, the Q16 unit
    /// vector its door faces, out to its road; `grow`, its growth rank (0 = nearest
    /// the core: lots appear in this order); `min_tier`, the first city tier it exists in.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub poly: Option<Vec<[i64; 2]>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub front: Option<[i64; 2]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub grow: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_tier: Option<u8>,
}

#[derive(Serialize, Clone)]
pub struct Site {
    /// "<kind>:<n>", stable across seeds for the same profile.
    pub id: String,
    pub kind: &'static str,
    pub block: u32,
    pub x: i64,
    pub y: i64,
    pub z: i64,
    pub w: i64,
    pub d: i64,
    pub facing: Facing,
    /// Organic worlds (@2): the first city tier the site exists in, its footprint
    /// ([x, z] cm, counter-clockwise) and the Q16 unit vector its door faces.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tier: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub poly: Option<Vec<[i64; 2]>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub front: Option<[i64; 2]>,
}

/// The grid's line positions: line `i` runs between block columns i and i+1.
pub struct Grid {
    pub px: i64,
    pub pz: i64,
    pub avenue_every: i64,
    pub road: i64,
    pub avenue: i64,
}

impl Grid {
    pub fn new(p: &Profile) -> Self {
        Grid { px: p.block_w_cm + p.road_cm, pz: p.block_d_cm + p.road_cm, avenue_every: p.avenue_every, road: p.road_cm, avenue: p.avenue_cm }
    }
    pub fn line_x(&self, i: i64) -> i64 {
        i * self.px + self.px / 2
    }
    pub fn line_z(&self, j: i64) -> i64 {
        j * self.pz + self.pz / 2
    }
    pub fn is_avenue(&self, line: i64) -> bool {
        line.rem_euclid(self.avenue_every) == 1
    }
    pub fn width(&self, line: i64) -> i64 {
        if self.is_avenue(line) { self.avenue } else { self.road }
    }
}

pub struct City {
    pub blocks: Vec<Block>,
    pub lots: Vec<Lot>,
    pub sites: Vec<Site>,
}

fn dist2(x: i64, z: i64) -> i64 {
    x * x + z * z
}

pub fn generate(seed: u64, p: &Profile, t: &Terrain) -> Result<City, String> {
    let g = Grid::new(p);
    let (ri, rj) = (p.city_r_cm / g.px + 1, p.city_r_cm / g.pz + 1);

    // the blocks inside the city's circle, nearest the plaza first
    let mut cells: Vec<(i64, i64)> = Vec::new();
    for j in -rj..=rj {
        for i in -ri..=ri {
            if dist2(i * g.px, j * g.pz) <= p.city_r_cm * p.city_r_cm {
                cells.push((i, j));
            }
        }
    }
    // a block's rectangle: the cell between its grid lines, less half of each road (avenues are wider)
    let rect = |i: i64, j: i64| {
        let (x0, x1) = (g.line_x(i - 1) + g.width(i - 1) / 2, g.line_x(i) - g.width(i) / 2);
        let (z0, z1) = (g.line_z(j - 1) + g.width(j - 1) / 2, g.line_z(j) - g.width(j) / 2);
        ((x0 + x1) / 2, (z0 + z1) / 2, x1 - x0, z1 - z0)
    };
    // nearest the plaza first, by where each block really is
    cells.sort_by_key(|&(i, j)| {
        let (x, z, _, _) = rect(i, j);
        (dist2(x, z), j, i)
    });

    let views = p.sites.iter().filter_map(|s| match s.place {
        Place::Slots { district: d, per_block } if d == district::CIVIC => Some((s.count + per_block - 1) / per_block),
        _ => None,
    });
    let civic_blocks: i64 = views.sum();
    if (cells.len() as i64) < 1 + civic_blocks + p.hq_lots {
        return Err(format!("profile {}: {} city blocks cannot hold the plaza, {civic_blocks} civic blocks and {} HQ lots", p.name, cells.len(), p.hq_lots));
    }

    // the industrial quarter: a sector on the city's edge, pointing a seeded way
    let mut rng = Rng::new(sub(seed, "districts", 0, 0));
    let (ax, az) = (rng.range(-1000, 1000), rng.range(-1000, 1000));
    let in_industry = |x: i64, z: i64| {
        let dot = (x * ax + z * az) as i128;
        dot > 0 && dot * dot * 100 > 72 * dist2(x, z) as i128 * (ax * ax + az * az) as i128 && dist2(x, z) * 100 > 49 * p.city_r_cm * p.city_r_cm
    };

    let mut blocks = Vec::with_capacity(cells.len());
    for (k, &(i, j)) in cells.iter().enumerate() {
        let (bx, bz, bw, bd) = rect(i, j);
        let (cx, cz) = (i * g.px, j * g.pz);
        let k = k as i64;
        let d = if k == 0 {
            district::PLAZA
        } else if k <= civic_blocks {
            district::CIVIC
        } else if k <= civic_blocks + p.hq_lots {
            district::HQ
        } else if in_industry(cx, cz) {
            district::INDUSTRIAL
        } else if rng.chance(p.park_pm) {
            district::PARK
        } else if dist2(cx, cz) <= p.commercial_r_cm * p.commercial_r_cm {
            district::COMMERCIAL
        } else {
            district::RESIDENTIAL
        };
        blocks.push(Block { id: k as u32, i: i as i32, j: j as i32, x: bx, z: bz, w: bw, d: bd, district: d, poly: None });
    }

    let lots = lots(seed, p, t, &blocks);
    let sites = sites(p, t, &blocks)?;
    Ok(City { blocks, lots, sites })
}

fn door(t: &Terrain, x: i64, z: i64, d: i64, f: Facing) -> [i64; 3] {
    let dz = if f == Facing::North { d / 2 } else { -d / 2 };
    [x, t.height_at(x, z + dz), z + dz]
}

fn lots(seed: u64, p: &Profile, t: &Terrain, blocks: &[Block]) -> Vec<Lot> {
    let mut out = Vec::new();
    let mut rank = 0u32;
    for b in blocks {
        let mut rng = Rng::new(sub(seed, "lots", b.i as i64, b.j as i64));
        match b.district {
            district::HQ => {
                let f = Facing::North;
                out.push(Lot {
                    id: 0, block: b.id, kind: "hq", district: b.district, x: b.x, z: b.z, w: b.w, d: b.d, facing: f,
                    door: door(t, b.x, b.z, b.d, f), floors: 0,
                    rank: Some(rank), tier: Some(rank / p.hq_tier as u32), poly: None, front: None, grow: None, min_tier: None,
                });
                rank += 1;
            }
            district::COMMERCIAL | district::RESIDENTIAL | district::INDUSTRIAL => {
                let n = match b.district {
                    district::COMMERCIAL => rng.range(2, 3),
                    district::RESIDENTIAL => rng.range(3, 4),
                    _ => 1,
                };
                // two rows back to back: the front row faces north (+z), the back row south
                for (row, f) in [(0i64, Facing::North), (1, Facing::South)] {
                    let d = b.d / 2;
                    let z = if row == 0 { b.z + d / 2 } else { b.z - d / 2 };
                    for c in 0..n {
                        let (x0, x1) = (b.x - b.w / 2 + b.w * c / n, b.x - b.w / 2 + b.w * (c + 1) / n);
                        let (x, w) = ((x0 + x1) / 2, x1 - x0);
                        let floors = match b.district {
                            district::COMMERCIAL => rng.range(3, 12),
                            district::RESIDENTIAL => rng.range(1, 4),
                            _ => rng.range(1, 2),
                        };
                        out.push(Lot {
                            id: 0, block: b.id, kind: "building", district: b.district, x, z, w, d, facing: f,
                            door: door(t, x, z, d, f), floors, rank: None, tier: None, poly: None, front: None, grow: None, min_tier: None,
                        });
                    }
                }
            }
            _ => {} // plaza, civic (sites) and parks have no lots
        }
    }
    for (k, l) in out.iter_mut().enumerate() {
        l.id = k as u32;
    }
    out
}

fn sites(p: &Profile, t: &Terrain, blocks: &[Block]) -> Result<Vec<Site>, String> {
    let mut out = Vec::new();
    let mut taken: BTreeMap<u32, i64> = BTreeMap::new(); // block -> slots used
    for s in &p.sites {
        for n in 0..s.count {
            let (b, x, z) = match s.place {
                Place::Plaza { dx, dz } => {
                    let b = &blocks[0];
                    (b, b.x + dx, b.z + dz)
                }
                Place::Slots { district: d, per_block } => {
                    let b = blocks
                        .iter()
                        .find(|b| b.district == d && *taken.get(&b.id).unwrap_or(&0) < per_block)
                        .ok_or_else(|| format!("site {}: no {} block left for slot {n}", s.kind, district::NAMES[d as usize]))?;
                    let slot = *taken.get(&b.id).unwrap_or(&0);
                    taken.insert(b.id, slot + 1);
                    (b, b.x - b.w / 2 + b.w * (2 * slot + 1) / (2 * per_block), b.z)
                }
            };
            out.push(Site {
                id: format!("{}:{n}", s.kind), kind: s.kind, block: b.id,
                x, y: t.height_at(x, z), z, w: s.w_cm, d: s.d_cm, facing: Facing::North, tier: None, poly: None, front: None,
            });
        }
    }
    Ok(out)
}

impl City {
    /// Heights from (possibly edited) terrain: doors and sites stand on the ground.
    pub fn seat(&mut self, t: &Terrain) {
        for l in &mut self.lots {
            l.door[1] = t.height_at(l.door[0], l.door[2]);
        }
        for s in &mut self.sites {
            s.y = t.height_at(s.x, s.z);
        }
    }
}

/// Rise (cm) across a rectangle: the most minus the least of its corners and centre.
pub fn rise(t: &Terrain, x: i64, z: i64, w: i64, d: i64) -> i64 {
    let hs = [
        t.height_at(x, z),
        t.height_at(x - w / 2, z - d / 2),
        t.height_at(x + w / 2, z - d / 2),
        t.height_at(x - w / 2, z + d / 2),
        t.height_at(x + w / 2, z + d / 2),
    ];
    hs.iter().max().unwrap() - hs.iter().min().unwrap()
}
