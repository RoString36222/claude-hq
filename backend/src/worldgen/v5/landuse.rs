//! City Gen v5: land use from travel, and the buildings as boxes in the volume.
//!
//! After the airport (airport.rs), in this order, each step taking only what is still free:
//!   1. the centre: the plaza and Central (the metro and rail hub) on the flattest dry ground near the island's middle,
//!      `CENTRE_CLEAR_CM` at least from the airport;
//!   2. the port: the river's port quay where the river gives one, else the dry coast point farthest from the airport;
//!   3. the land, on a `CELL_CM` grid within the city's radius, by what people travel for:
//!      - industry: within `IND_REACH_CM` of the port or the airport (freight), and `IND_OUT_PM` of the radius from the
//!        centre at least; its share of the cells, nearest the port and airport first;
//!      - offices: nearest the hub (a commute's end), their share;
//!      - the gap: every cell within `GAP_CM` of industry is green (no home is ever that near a factory);
//!      - homes: the rest, nearest the offices first (a short commute), the airport's noise (under its approaches,
//!        within `NOISE_CM` of it) left green;
//!      - parks: what is left;
//!   4. the buildings: on each district's cells, a lattice of plots square to the hub, each a building box by its use
//!      (towers nearest the hub tallest, then mid-rise blocks of homes, then low wide sheds), carved at `SPACING_CM`
//!      from every other solid: room for a street between any two, so the road network can reach every door.
use super::airport::Airport;
use super::land::Land;
use super::space::{Space, GROUND};
use super::super::organic::geom::{rise, P};
use super::super::rng::{sub, Rng};

pub const CELL_CM: i64 = 5_000;
pub const CENTRE_CLEAR_CM: i64 = 20_000;
pub const IND_REACH_CM: i64 = 35_000;
pub const IND_OUT_PM: i64 = 450;
pub const GAP_CM: i64 = 15_000;
pub const NOISE_CM: i64 = 8_000;
pub const SPACING_CM: i64 = 2_000;
/// The plaza round the hub (cm): no building in it.
pub const PLAZA_CM: i64 = 6_000;
/// The shares of the city's cells (per mille): industry, offices; homes take the rest that is not gap or noise.
pub const IND_PM: i64 = 150;
pub const OFFICE_PM: i64 = 130;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Use {
    Office,
    Home,
    Industry,
    Park,
}

#[derive(Clone, Debug)]
pub struct Building {
    pub id: u32,
    pub use_: Use,
    /// The footprint (a rectangle, convex, cm) and its middle.
    pub poly: Vec<P>,
    pub c: P,
    /// The ground under it and its height (cm).
    pub y: i64,
    pub h: i64,
    pub solid: u32,
}

pub struct LandUse {
    pub hub: P,
    pub port: Option<(P, P)>,
    /// Every cell's use (the cell's middle, cm).
    pub cells: Vec<(P, Use)>,
    pub buildings: Vec<Building>,
}

fn d(a: P, b: P) -> i64 {
    ((a.0 - b.0) as f64).hypot((a.1 - b.1) as f64) as i64
}

/// The distance (cm) from `q` to the airport's footprint (0 inside it).
fn to_airport(q: P, ap: &Airport) -> i64 {
    let n = ap.poly.len();
    if super::super::organic::geom::inside(q, &ap.poly) {
        return 0;
    }
    (0..n).map(|k| (super::super::organic::geom::seg_dist2(q, q, ap.poly[k], ap.poly[(k + 1) % n]) as f64).sqrt() as i64).min().unwrap_or(i64::MAX)
}

/// Under one of the airport's approaches, within its first kilometre (the noise footprint): along its line, within the
/// approach's width.
fn under_approach(q: P, ap: &Airport) -> bool {
    let (dx, dz) = (q.0 - ap.c.0, q.1 - ap.c.1);
    let a = (dx * ap.dir.0 + dz * ap.dir.1) / 1000;
    let w = (-dx * ap.dir.1 + dz * ap.dir.0) / 1000;
    let past = a.abs() - ap.len / 2;
    past > 0 && past < 100_000 && w.abs() < 7_500 + past * 150 / 1000
}

/// The city's dry cells (their middles, cm) within its radius, off the airport.
fn dry_cells(land: &Land, ap: &Airport) -> Vec<P> {
    let r = land.p.city_r_cm;
    let n = r / CELL_CM;
    (-n..=n).flat_map(|i| (-n..=n).map(move |j| (i * CELL_CM, j * CELL_CM)))
        .filter(|&q| q.0 * q.0 + q.1 * q.1 <= r * r && land.dry(q) && to_airport(q, ap) > 0)
        .collect()
}

/// Steps 1 and 2: the centre (the hub) and the port (its quay and front), decided before the lines and the land use.
pub fn centre(land: &Land, ap: &Airport) -> (P, Option<(P, P)>) {
    let dry = dry_cells(land, ap);
    let hub = dry.iter().copied()
        .filter(|&q| to_airport(q, ap) >= CENTRE_CLEAR_CM)
        .min_by_key(|&q| (d(q, (0, 0)) / 5_000 + rise(&land.t, &[(q.0 - 2_000, q.1 - 2_000), (q.0 + 2_000, q.1 + 2_000)]) / 100, q))
        .unwrap_or((0, 0));
    // 2. the port
    let port = land.river.as_ref().map(|rv| rv.port).filter(|p| p.0 != (0, 0)).or_else(|| {
        land.coast.as_ref().and_then(|c| c.poly.iter().copied().max_by_key(|&q| (d(q, ap.c), q)).map(|q| (q, (-q.0.signum(), -q.1.signum()))))
    });
    (hub, port)
}

/// Steps 3 and 4: the land use and its buildings, round the centre and the lines already in the volume.
pub fn plan(land: &Land, ap: &Airport, hub: P, port: Option<(P, P)>, space: &mut Space) -> LandUse {
    let r = land.p.city_r_cm;
    let dry = dry_cells(land, ap);
    let port_at = port.map(|p| p.0);

    // 3. the land
    let total = dry.len() as i64;
    let mut uses: Vec<Option<Use>> = vec![None; dry.len()];
    // industry: near the port or the airport, out from the centre; nearest those first
    let mut ind: Vec<(i64, usize)> = dry.iter().enumerate().filter_map(|(k, &q)| {
        let reach = port_at.map_or(i64::MAX, |p| d(q, p)).min(to_airport(q, ap));
        (reach <= IND_REACH_CM && d(q, hub) >= r * IND_OUT_PM / 1000).then_some((reach, k))
    }).collect();
    ind.sort();
    for &(_, k) in ind.iter().take((total * IND_PM / 1000) as usize) {
        uses[k] = Some(Use::Industry);
    }
    // offices: nearest the hub
    let mut off: Vec<(i64, usize)> = dry.iter().enumerate().filter(|(k, _)| uses[*k].is_none()).map(|(k, &q)| (d(q, hub), k)).collect();
    off.sort();
    for &(_, k) in off.iter().take((total * OFFICE_PM / 1000) as usize) {
        uses[k] = Some(Use::Office);
    }
    // the gap round industry, and the airport's noise: green
    let ind_cells: Vec<P> = dry.iter().enumerate().filter(|(k, _)| uses[*k] == Some(Use::Industry)).map(|(_, &q)| q).collect();
    for (k, &q) in dry.iter().enumerate() {
        // (a cell's buildings stand anywhere in it: the gap is kept from the cells' edges, a cell more)
        if uses[k].is_none() && (ind_cells.iter().any(|&c| d(q, c) < GAP_CM + CELL_CM) || under_approach(q, ap) || to_airport(q, ap) < NOISE_CM) {
            uses[k] = Some(Use::Park);
        }
    }
    // homes: the rest (nearest the offices first: every one of them, the city's homes are its biggest use)
    for u in uses.iter_mut() {
        if u.is_none() {
            *u = Some(Use::Home);
        }
    }
    let cells: Vec<(P, Use)> = dry.iter().copied().zip(uses.into_iter().map(|u| u.unwrap_or(Use::Park))).collect();

    // 4. the buildings: a plot lattice square to the hub (one axis toward it), per use its plot and building
    let mut rng = Rng::new(sub(land.seed, "v5-buildings", 0, 0));
    let mut buildings = Vec::new();
    let use_at = |q: P| cells.iter().min_by_key(|(c, _)| d(*c, q)).filter(|(c, _)| d(*c, q) <= CELL_CM).map(|(_, u)| *u);
    // (industry first: every home then keeps GAP_CM from its buildings themselves)
    for (u, (pw, pd), (bw, bd)) in [
        (Use::Industry, (8_400, 6_400), (6_000, 4_000)),
        (Use::Office, (5_200, 5_200), (3_000, 3_000)),
        (Use::Home, (4_400, 3_800), (2_400, 1_800)),
    ] {
        let m = r / pw.min(pd) + 2;
        for i in -m..=m {
            for j in -m..=m {
                let q = (hub.0 + i * pw, hub.1 + j * pd);
                if use_at(q) != Some(u) || !land.dry(q) {
                    continue;
                }
                let (hw, hd) = (bw / 2 + rng.range(-bw / 10, bw / 10), bd / 2 + rng.range(-bd / 10, bd / 10));
                let poly = vec![(q.0 - hw, q.1 - hd), (q.0 + hw, q.1 - hd), (q.0 + hw, q.1 + hd), (q.0 - hw, q.1 + hd)];
                if !poly.iter().all(|&c| land.dry(c)) {
                    continue;
                }
                // the plaza round the hub stays open (Central's station, the squares, the lines over and under it)
                if d(q, hub) < PLAZA_CM {
                    continue;
                }
                if u == Use::Home && buildings.iter().any(|b: &Building| b.use_ == Use::Industry && d(b.c, q) < GAP_CM) {
                    continue;
                }
                let y = land.height(q);
                let h = match u {
                    // towers: taller toward the hub, 40 m to 140 m
                    Use::Office => 4_000 + (10_000 * (r - d(q, hub)).max(0) / r.max(1)) + rng.range(0, 1_500),
                    Use::Home => rng.range(1_200, 2_600),
                    _ => rng.range(800, 1_400),
                };
                if let Ok(solid) = space.carve("building", "landuse", poly.clone(), y + GROUND.0, y + h, SPACING_CM) {
                    buildings.push(Building { id: buildings.len() as u32, use_: u, poly, c: q, y, h, solid });
                }
            }
        }
    }
    LandUse { hub, port, cells, buildings }
}

#[cfg(test)]
mod tests {
    use super::super::City;
    use super::*;

    fn commons() -> (Land, Space, Airport, LandUse) {
        let c = City::plan("claude-hq").unwrap();
        (c.land, c.space, c.airport, c.landuse)
    }

    #[test]
    fn every_use_is_built_and_no_box_meets_another() {
        let (_, v, _, lu) = commons();
        for u in [Use::Office, Use::Home, Use::Industry] {
            assert!(lu.buildings.iter().filter(|b| b.use_ == u).count() >= 20, "{u:?}");
        }
        // every building's box is free of every other solid, with the spacing
        for b in &lu.buildings {
            let s = &v.solids[b.solid as usize];
            // (against buildings, the railways and the airport: a metro entrance or concourse is meant to stand by one)
            let others = v.solids.iter().filter(|o| matches!(o.kind, "building" | "rail" | "link" | "airport" | "approach"))
                .filter(|o| o.id != s.id && o.y0 < s.y1 && s.y0 < o.y1)
                .any(|o| super::super::space::near(&o.poly, &s.poly, SPACING_CM - 1));
            assert!(!others, "building {} meets another solid", b.id);
        }
    }

    #[test]
    fn industry_keeps_its_gap_from_every_home() {
        let (_, _, _, lu) = commons();
        let homes: Vec<&Building> = lu.buildings.iter().filter(|b| b.use_ == Use::Home).collect();
        for f in lu.buildings.iter().filter(|b| b.use_ == Use::Industry) {
            for h in &homes {
                assert!(d(f.c, h.c) >= GAP_CM, "industry {} and home {} are {} m apart", f.id, h.id, d(f.c, h.c) / 100);
            }
        }
    }

    #[test]
    fn offices_gather_at_the_hub_and_rise_toward_it() {
        let (_, _, _, lu) = commons();
        let mean = |u: Use| { let v: Vec<i64> = lu.buildings.iter().filter(|b| b.use_ == u).map(|b| d(b.c, lu.hub)).collect(); v.iter().sum::<i64>() / v.len().max(1) as i64 };
        assert!(mean(Use::Office) < mean(Use::Home), "offices nearer the hub than homes");
        let tall = lu.buildings.iter().filter(|b| b.use_ == Use::Office).max_by_key(|b| b.h).unwrap();
        assert!(d(tall.c, lu.hub) < 25_000, "the tallest tower stands near the hub");
    }

    #[test]
    fn nothing_stands_on_the_airport() {
        let (_, _, ap, lu) = commons();
        assert!(lu.buildings.iter().all(|b| b.poly.iter().all(|&q| !super::super::super::organic::geom::inside(q, &ap.poly))));
    }
}

#[cfg(test)]
mod show {
    /// V5_DUMP=<file> cargo test --release show_the_commons_land_use -- --ignored: the plan as JSON for tools to draw.
    #[test]
    #[ignore]
    fn show_the_commons_land_use() {
        let c = super::super::City::plan("claude-hq").unwrap();
        let (land, ap, lu) = (&c.land, &c.airport, &c.landuse);
        let j = serde_json::json!({
            "coast": land.coast.as_ref().map(|c| c.poly.clone()),
            "water": land.water, "airport": ap.poly, "hub": lu.hub, "port": lu.port.map(|p| p.0),
            "cells": lu.cells.iter().map(|(q, u)| (q, format!("{u:?}"))).collect::<Vec<_>>(),
            "buildings": lu.buildings.iter().map(|b| (b.poly.clone(), format!("{:?}", b.use_), b.h)).collect::<Vec<_>>(),
        });
        if let Ok(path) = std::env::var("V5_DUMP") {
            std::fs::write(path, j.to_string()).unwrap();
        }
    }
}
