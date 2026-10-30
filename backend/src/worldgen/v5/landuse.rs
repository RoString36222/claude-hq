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
//!   4. the buildings: each district (one use's cells in one face of the arterial network) a lattice of long thin
//!      blocks (Manhattan's, about three times as long as they are deep) whose long side runs along the arterial most of
//!      it is nearest, so each face has its own grid; each block a row or two of
//!      building boxes by its use (towers nearest the hub tallest in small blocks, mid-rise homes in long ones, low wide
//!      sheds in big ones), every one fronting a long street, carved at `SPACING_CM` from every other solid.
use std::collections::BTreeMap;

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
/// How far (cm) a building stands back from a road already laid (its pavement).
pub const ROAD_SETBACK_CM: i64 = 500;
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
    /// Its district's frame (`LandUse::frames`) and its block in it.
    pub frame: u32,
    pub block: (i64, i64),
}

pub struct LandUse {
    pub hub: P,
    pub port: Option<(P, P)>,
    /// Every cell's use (the cell's middle, cm).
    pub cells: Vec<(P, Use)>,
    pub buildings: Vec<Building>,
    /// Each district's street frame (its blocks' axis and size).
    pub frames: Vec<Frame>,
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

/// Steps 3 and 4: the land use and its buildings, round the centre, the lines and the arterials already in the volume.
pub fn plan(land: &Land, ap: &Airport, hub: P, port: Option<(P, P)>, arterials: &[super::roads::Road], space: &mut Space) -> LandUse {
    let cells = zone(land, ap, hub, port);
    let (buildings, frames) = build(land, hub, &cells, arterials, space);
    LandUse { hub, port, cells, buildings, frames }
}

/// Step 3: every cell's use.
pub fn zone(land: &Land, ap: &Airport, hub: P, port: Option<(P, P)>) -> Vec<(P, Use)> {
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
    dry.iter().copied().zip(uses.into_iter().map(|u| u.unwrap_or(Use::Park))).collect()
}

/// A district's street frame: the blocks' long side runs along `u` (its face's arterial's way), `o` a corner of block
/// (0, 0); `long` and `short` the blocks' pitch (cm, street centre line to street centre line) along `u` and across it.
#[derive(Clone, Copy, Debug)]
pub struct Frame {
    pub use_: Use,
    pub o: (f64, f64),
    pub u: (f64, f64),
    pub long: f64,
    pub short: f64,
}

impl Frame {
    /// The world point (cm) at `a` along the long axis and `b` across it.
    pub fn at(&self, a: f64, b: f64) -> (f64, f64) {
        (self.o.0 + a * self.u.0 - b * self.u.1, self.o.1 + a * self.u.1 + b * self.u.0)
    }
}

/// Each use's blocks (Manhattan's: long and thin): its building's footprint along the block and across it (cm), the
/// rows of buildings across a block (back to back, each fronting a long street) and how many stand in a row (the
/// district's own, between the two).
pub fn block_of(u: Use) -> ((i64, i64), i64, (i64, i64)) {
    match u {
        Use::Industry => ((6_000, 4_000), 2, (3, 4)),
        Use::Office => ((3_000, 4_400), 1, (3, 4)),
        _ => ((2_400, 1_800), 2, (5, 6)),
    }
}
/// From a street's centre line to the buildings' fronts (cm): its half width and a pavement.
pub const FRONT_CM: i64 = 1_000;
/// From the arterial a face's lattice is laid along (its centre line) to the lattice's first long street (cm): the
/// arterial's half width and a building's setback from it, less a block's front, and a metre to spare.
const ART_SIDE_CM: f64 = 600.0;

/// Step 4: the buildings on the cells, round what is already in the volume (the lines, the arterials). Each district
/// (the cells of one use in one face of the arterial network, joined) is a lattice of long blocks along the arterial
/// most of its face is nearest; each block a row or two of buildings by its use (towers nearest the hub tallest, then mid-rise homes, then low wide sheds). The
/// districts' frames are returned with the buildings (roads.rs `locals` lays the streets round their blocks).
pub fn build(land: &Land, hub: P, cells: &[(P, Use)], arterials: &[super::roads::Road], space: &mut Space) -> (Vec<Building>, Vec<Frame>) {
    let r = land.p.city_r_cm;
    let mut rng = Rng::new(sub(land.seed, "v5-buildings", 0, 0));
    // the arterials' segments (not Central's ring: its from and to both Central), each with its road
    let segs: Vec<(usize, (f64, f64), (f64, f64))> = arterials.iter().enumerate().filter(|(_, a)| (a.from, a.to) != (0, 0))
        .flat_map(|(k, a)| a.points.windows(2).map(move |w| (k, (w[0][0] as f64, w[0][2] as f64), (w[1][0] as f64, w[1][2] as f64))))
        .filter(|(_, a, b)| a != b).collect();
    let foot = |q: (f64, f64), a: (f64, f64), b: (f64, f64)| {
        let (ex, ez) = (b.0 - a.0, b.1 - a.1);
        let t = (((q.0 - a.0) * ex + (q.1 - a.1) * ez) / (ex * ex + ez * ez)).clamp(0.0, 1.0);
        (a.0 + t * ex, a.1 + t * ez)
    };
    let nearest = |q: (f64, f64)| segs.iter().map(|&(k, a, b)| { let f = foot(q, a, b); ((f.0 - q.0).hypot(f.1 - q.1), k, a, b) })
        .min_by(|x, y| x.0.total_cmp(&y.0));
    // the districts: the built cells of one use in one face of the arterial network (cells joined where no arterial runs
    // between them), in connected pieces
    let key = |q: P| (q.0.div_euclid(CELL_CM) + i64::from(q.0.rem_euclid(CELL_CM) * 2 >= CELL_CM), q.1.div_euclid(CELL_CM) + i64::from(q.1.rem_euclid(CELL_CM) * 2 >= CELL_CM));
    let mut by_cell: BTreeMap<(i64, i64), Vec<usize>> = BTreeMap::new();
    for (s, &(_, a, b)) in segs.iter().enumerate() {
        for q in [a, b] {
            by_cell.entry(key((q.0 as i64, q.1 as i64))).or_default().push(s);
        }
    }
    let cut = |c: (i64, i64), n: (i64, i64)| {
        let (p, q) = ((c.0 * CELL_CM, c.1 * CELL_CM), (n.0 * CELL_CM, n.1 * CELL_CM));
        (c.0.min(n.0) - 1..=c.0.max(n.0) + 1).any(|x| (c.1.min(n.1) - 1..=c.1.max(n.1) + 1).any(|z| by_cell.get(&(x, z)).is_some_and(|v| v.iter().any(|&s| {
            let (_, a, b) = segs[s];
            super::super::organic::geom::seg_dist2(p, q, (a.0 as i64, a.1 as i64), (b.0 as i64, b.1 as i64)) == 0
        }))))
    };
    let mut tag: BTreeMap<(i64, i64), (Use, usize, (f64, f64), (f64, f64))> = BTreeMap::new();
    for &(q, u) in cells {
        if u == Use::Park {
            continue;
        }
        let qf = (q.0 as f64, q.1 as f64);
        let (k, dir, f) = nearest(qf).map_or((usize::MAX, (1.0, 0.0), qf), |(_, k, a, b)| { let l = (b.0 - a.0).hypot(b.1 - a.1); (k, ((b.0 - a.0) / l, (b.1 - a.1) / l), foot(qf, a, b)) });
        tag.insert(key(q), (u, k, dir, f));
    }
    // flood a set of cells over the uncut sides: its pieces
    let flood = |same: &dyn Fn((i64, i64), (i64, i64)) -> bool| {
        let mut of: BTreeMap<(i64, i64), usize> = BTreeMap::new();
        let mut parts: Vec<Vec<(i64, i64)>> = Vec::new();
        for &c0 in tag.keys() {
            if of.contains_key(&c0) {
                continue;
            }
            let id = parts.len();
            let (mut todo, mut mine) = (vec![c0], Vec::new());
            of.insert(c0, id);
            while let Some(c) = todo.pop() {
                mine.push(c);
                for n in [(c.0 + 1, c.1), (c.0 - 1, c.1), (c.0, c.1 + 1), (c.0, c.1 - 1)] {
                    if !of.contains_key(&n) && tag.contains_key(&n) && same(c, n) && !cut(c, n) {
                        of.insert(n, id);
                        todo.push(n);
                    }
                }
            }
            parts.push(mine);
        }
        (of, parts)
    };
    let (face_of, faces) = flood(&|_, _| true);
    let (of, parts) = flood(&|c, n| tag[&c].0 == tag[&n].0);
    // each face's lattice: its long axis the way of the arterial most of its cells are nearest (their mean), its first
    // long street beside that arterial
    let axes: Vec<((f64, f64), (f64, f64))> = faces.iter().map(|mine| {
        let mut count: BTreeMap<usize, usize> = BTreeMap::new();
        for c in mine {
            *count.entry(tag[c].1).or_default() += 1;
        }
        let k = count.iter().max_by_key(|&(k, n)| (*n, std::cmp::Reverse(*k))).map_or(usize::MAX, |(k, _)| *k);
        let (mut sc, mut ss, mut cx, mut cz, mut fx, mut fz, mut n) = (0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
        for c in mine.iter().filter(|c| tag[*c].1 == k) {
            let (_, _, d, f) = tag[c];
            let a = d.1.atan2(d.0) * 2.0;
            (sc, ss, n) = (sc + a.cos(), ss + a.sin(), n + 1.0);
            (cx, cz, fx, fz) = (cx + (c.0 * CELL_CM) as f64, cz + (c.1 * CELL_CM) as f64, fx + f.0, fz + f.1);
        }
        let a = ss.atan2(sc) / 2.0;
        let ax = (a.cos(), a.sin());
        let ((cx, cz), (fx, fz)) = ((cx / n, cz / n), (fx / n, fz / n));
        if k == usize::MAX {
            return (ax, (cx, cz));
        }
        // (the origin on the arterial's line, a little toward the face: the arterial's buildings keep their setback)
        let nv = (-ax.1, ax.0);
        let along = (fx - cx) * ax.0 + (fz - cz) * ax.1;
        let f = (cx + along * ax.0, cz + along * ax.1);
        let off = (fx - cx) * nv.0 + (fz - cz) * nv.1;
        let s = if off <= 0.0 { 1.0 } else { -1.0 };
        (ax, (f.0 + nv.0 * (off + s * ART_SIDE_CM), f.1 + nv.1 * (off + s * ART_SIDE_CM)))
    }).collect();
    let districts: Vec<(Use, Vec<(i64, i64)>)> = parts.into_iter().map(|mine| (tag[&mine[0]].0, mine)).collect();
    // each district's blocks: its face's lattice, the blocks its use's size (the buildings in a row the face's own for
    // the use: every piece of one use in a face on one lattice)
    let frames: Vec<Frame> = districts.iter().map(|(u, mine)| {
        let face = face_of[&mine[0]];
        let (ax, o) = axes[face];
        let ((bw, bd), rows, (n0, n1)) = block_of(*u);
        let per = Rng::new(sub(land.seed, "v5-blocks", face as i64, *u as i64)).range(n0, n1);
        let long = (per * bw + (per - 1) * SPACING_CM + 2 * FRONT_CM) as f64;
        let short = (rows * bd + (rows - 1) * SPACING_CM + 2 * FRONT_CM) as f64;
        Frame { use_: *u, o, u: ax, long, short }
    }).collect();
    // the buildings: industry first (every home then keeps GAP_CM from its buildings themselves), then offices, homes
    let mut buildings = Vec::new();
    let mut order: Vec<usize> = (0..districts.len()).collect();
    let rank = |u: Use| match u { Use::Industry => 0, Use::Office => 1, _ => 2 };
    order.sort_by_key(|&k| (rank(districts[k].0), k));
    for k in order {
        let (u, ref mine) = districts[k];
        let f = frames[k];
        let ((bw, bd), rows, _) = block_of(u);
        let per = ((f.long as i64 - 2 * FRONT_CM + SPACING_CM) / (bw + SPACING_CM)).max(1);
        // the district's extent in its frame: the blocks that may hold a building of it
        let (mut a0, mut a1, mut b0, mut b1) = (f64::MAX, f64::MIN, f64::MAX, f64::MIN);
        for c in mine {
            let (dx, dz) = ((c.0 * CELL_CM) as f64 - f.o.0, (c.1 * CELL_CM) as f64 - f.o.1);
            let (la, lb) = (dx * f.u.0 + dz * f.u.1, -dx * f.u.1 + dz * f.u.0);
            let h = CELL_CM as f64;
            (a0, a1, b0, b1) = (a0.min(la - h), a1.max(la + h), b0.min(lb - h), b1.max(lb + h));
        }
        for ia in (a0 / f.long).floor() as i64..=(a1 / f.long).ceil() as i64 {
            for ib in (b0 / f.short).floor() as i64..=(b1 / f.short).ceil() as i64 {
                for row in 0..rows {
                    for i in 0..per {
                        let la = ia as f64 * f.long + (FRONT_CM + bw / 2 + i * (bw + SPACING_CM)) as f64;
                        let lb = ib as f64 * f.short + (FRONT_CM + bd / 2 + row * (bd + SPACING_CM)) as f64;
                        let w = f.at(la, lb);
                        let q = (w.0.round() as i64, w.1.round() as i64);
                        if of.get(&key(q)) != Some(&k) || !land.dry(q) {
                            continue;
                        }
                        // (a little smaller than its plot, never larger: the spacing to the next holds)
                        let (hw, hd) = ((bw / 2 - rng.range(50, bw / 10)) as f64, (bd / 2 - rng.range(50, bd / 10)) as f64);
                        let poly: Vec<P> = [(-hw, -hd), (hw, -hd), (hw, hd), (-hw, hd)].iter()
                            .map(|&(x, z)| { let p = f.at(la + x, lb + z); (p.0.round() as i64, p.1.round() as i64) }).collect();
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
                        // SPACING_CM from every other solid, ROAD_SETBACK_CM from a road already laid (its pavement: a
                        // building fronts its road)
                        let (y0, y1) = (y + GROUND.0, y + h);
                        if space.blocker_but(&poly, y0, y1, SPACING_CM, &["road"]).is_none() && space.blocker(&poly, y0, y1, ROAD_SETBACK_CM).is_none() {
                            let solid = space.put("building", "landuse", poly.clone(), y0, y1);
                            buildings.push(Building { id: buildings.len() as u32, use_: u, poly, c: q, y, h, solid, frame: k as u32, block: (ia, ib) });
                        }
                    }
                }
            }
        }
    }
    (buildings, frames)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn commons() -> (&'static Land, &'static Space, &'static Airport, &'static LandUse) {
        let c = super::super::commons();
        (&c.land, &c.space, &c.airport, &c.landuse)
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
        let c = super::super::commons();
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
