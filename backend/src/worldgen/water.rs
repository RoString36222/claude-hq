//! Water (@3): lakes, canals and a marina in every world, and the water transport laid
//! round them. Two stages, as the river's: the bodies are laid BEFORE any street grows
//! (`lay`, then `Plan::shape` carves them into the base terrain), so the organic streets,
//! blocks, lots and sites form round them; the piers, berths, harbour office, network and
//! routes come once the roads are laid (`Plan::finish`).
//!
//!   canals   1-3 arms 20-24 m wide off the river in town, square out of its bank and
//!            bending gently, each ending in a turning basin. Their water and banks are
//!            joined into the river's (river.rs `River::join`): the organic generator walls
//!            them in as one body, arterials bridge them as they bridge the river, local
//!            streets stop at the quays. The river's shaping carves them (the sea's level)
//!   marina   on the coast nearest the hub (the plaza): a dredged basin half inland, open
//!            to the sea, a breakwater arc at sea round its seaward side with the entrance on
//!            the river's side and a lighthouse on its head, finger berths, a harbour office
//!   lakes    a park lake of 1-3 ha in town (a seeded radial outline, radius noise +-18%, an
//!            island in some over 1.5 ha), and on a world with highways (the Commons) an
//!            upland lake on the high ground past the city. Its surface stands a metre under
//!            the lowest ground round it; banks 1:3 down to a bed 2-3 m deep
//!   piers    water-bus piers on the river, the canals and the marina (3-6), a launch
//!            jetty on the park lake, hire jetties (lake, marina), a fuel jetty (marina): each
//!            from 3 m inland out over the water, `front` the Q16 unit out over it
//!   net      the navigable centre lines: the river (and a point out past its mouth), the
//!            canals, the marina and a sea lane round the coast joining it to the river's
//!            mouth; the park lake's loop is its own network (it never reaches the sea)
//!   routes   W1 (and W2 on a long network with canals) calling at the water-bus piers,
//!            L1 the launch's loop on the park lake
//!
//! The lakes and the marina ride on the river as its `pools` (water and bank zones), so
//! everything that keeps off the river (streets, blocks, lots, sites, highways and the
//! ring) keeps off them too. Integer arithmetic only (cm, Q16, no trig).

use std::cmp::Reverse;
use std::collections::BinaryHeap;

use serde::Serialize;

use super::city::{City, Facing, Site};
use super::island::{directions, Coast};
use super::noise::{smoothstep, isqrt, ONE};
use super::organic::geom::{along, area2, dist2, dot, inside, left, len, seg_dist2, sub, turn, unit, P};
use super::organic::rect;
use super::organic::zoning::Zoning;
use super::profile::{district, Profile};
use super::river::{outline, River, Zone, BANK_CM};
use super::rng::{self, Rng};
use super::roads::Roads;
use super::terrain::Terrain;

/// The bank round a lake (cm): the slope up from the water, where nothing is built.
const LAKE_BANK_CM: i64 = 1_500;
/// The marina's quay apron (cm), as the river's bank.
const MARINA_BANK_CM: i64 = BANK_CM;
/// A canal's centre-line step (cm).
const CANAL_STEP_CM: i64 = 1_200;
/// How deep (cm) the marina is dredged, and the canals run (the river's own depth).
const MARINA_BED_CM: i64 = 300;
const CANAL_BED_CM: i64 = 400;
/// A lake's surface stands this far (cm) under the lowest ground of its outline.
const LAKE_DROP_CM: i64 = 100;
/// The water's edge sits this deep (cm) at the shore; a lake's island and the land
/// round it stand this far above the surface.
const EDGE_CM: i64 = 30;
const SHORE_CM: i64 = 60;

#[derive(Serialize)]
pub struct Body {
    pub id: String,
    /// "lake", "canal" or "marina".
    pub kind: &'static str,
    /// The water's outline, [x, z] cm, counter-clockwise. A canal's starts inside the
    /// river (it joins it), the marina's reaches out over the sea.
    pub poly: Vec<[i64; 2]>,
    /// The water's surface (cm) and its depth below it at the deepest (cm).
    pub level: i64,
    pub bed: i64,
    /// "bank" (a slope) or "quay" (a stone wall).
    pub edge: &'static str,
    /// Land in the water (a lake's island), outlines as `poly`.
    pub islands: Vec<Vec<[i64; 2]>>,
    /// The water it opens onto: "river", "sea", or none (a lake).
    pub joins: Option<String>,
    pub tier: u8,
}

#[derive(Serialize)]
pub struct Pier {
    pub id: String,
    /// The body it stands in: "river" or a body's id.
    pub body: String,
    /// "waterbus", "launch", "hire" or "fuel".
    pub kind: &'static str,
    /// The deck's middle and height (cm); `front` the Q16 unit out over the water; its
    /// length along `front` (from 3 m inland to its head over the water) and width (cm).
    pub x: i64,
    pub z: i64,
    pub y: i64,
    pub front: [i64; 2],
    pub len: i64,
    pub w: i64,
    pub tier: u8,
}

#[derive(Serialize)]
pub struct Berth {
    pub body: String,
    pub x: i64,
    pub z: i64,
    /// The way a moored boat's bow points (Q16 unit).
    pub front: [i64; 2],
}

#[derive(Serialize, Default)]
pub struct Net {
    pub nodes: Vec<[i64; 2]>,
    pub edges: Vec<[u32; 2]>,
}

#[derive(Serialize)]
pub struct Route {
    pub id: String,
    /// "waterbus" or "launch".
    pub kind: &'static str,
    /// Pier ids in calling order, and the net's node indices it sails through.
    pub piers: Vec<String>,
    pub path: Vec<u32>,
    #[serde(rename = "loop")]
    pub looped: bool,
    pub tier: u8,
}

/// `layers.water`.
#[derive(Serialize)]
pub struct Water {
    pub bodies: Vec<Body>,
    pub piers: Vec<Pier>,
    pub berths: Vec<Berth>,
    pub breakwater: Option<Vec<[i64; 2]>>,
    pub lighthouse: Option<[i64; 2]>,
    /// The harbour office's site id.
    pub office: Option<String>,
    pub net: Net,
    pub routes: Vec<Route>,
}

struct Lake {
    body: usize,
    c: P,
    /// The outline's vertices, each along `directions()[4 k]` from `c`.
    poly: Vec<P>,
    island: Option<Vec<P>>,
    park: bool,
}

struct Canal {
    body: usize,
    center: Vec<P>,
    width: i64,
}

struct Marina {
    body: usize,
    /// The basin's centre, the Q16 unit out to sea, its radius (cm).
    m: P,
    d: P,
    r: i64,
}

/// The bodies laid before the streets: `finish` adds the rest once the roads are in.
pub struct Plan {
    bodies: Vec<Body>,
    lakes: Vec<Lake>,
    canals: Vec<Canal>,
    marina: Option<Marina>,
}

impl Plan {
    /// The bodies' outlines as laid (cm): what City Gen v4 keeps the airport's claim off.
    pub fn outlines(&self) -> Vec<Vec<P>> {
        self.bodies.iter().map(|b| b.poly.iter().map(|q| (q[0], q[1])).collect()).collect()
    }
    /// The bodies as laid: outline (cm), surface and depth below it (cm). City Gen v5 carves them in its volume.
    pub fn levels(&self) -> Vec<(Vec<P>, i64, i64)> {
        self.bodies.iter().map(|b| (b.poly.iter().map(|q| (q[0], q[1])).collect(), b.level, b.bed)).collect()
    }
}

fn pts(v: &[P]) -> Vec<[i64; 2]> {
    v.iter().map(|q| [q.0, q.1]).collect()
}

fn neg(v: P) -> P {
    (-v.0, -v.1)
}

/// A round outline: `n` of the coast's directions (every `128 / n`-th) at radius
/// `r(k)` from `c`. Star-shaped round c, so simple; counter-clockwise.
fn radial(c: P, n: usize, r: impl Fn(usize) -> i64) -> Vec<P> {
    let dirs = directions();
    (0..n).map(|k| along(c, dirs[k * dirs.len() / n], r(k))).collect()
}

/// Periodic value noise at vertex `i` of `n` round a loop: -32768..=32767. Octaves of
/// (lattice cells round the loop, weight), as the coast's.
fn wobble(seed: u64, i: usize, n: usize, octaves: &[(i64, i64)]) -> i64 {
    let (mut sum, mut weight) = (0, 0);
    for (o, &(cells, w)) in octaves.iter().enumerate() {
        let u = i as i64 * cells * ONE / n as i64;
        let (j, f) = (u / ONE, smoothstep(u % ONE));
        let at = |j: i64| (rng::sub(seed, "water-wobble", o as i64, j % cells) >> 48) as i64 - 32768;
        sum += w * (at(j) + (at(j + 1) - at(j)) * f / ONE);
        weight += w;
    }
    sum / weight
}

/// Lay the bodies of water of a world whose profile has them (and a river and a coast):
/// the canals into the river, then the marina and the lakes as the river's pools.
pub fn lay(seed: u64, p: &Profile, river: &mut River, coast: &Coast) -> Plan {
    let ground = super::terrain::generate_with(seed, p, None);
    let zoning = Zoning::new(seed, p);
    let mut plan = Plan { bodies: Vec::new(), lakes: Vec::new(), canals: Vec::new(), marina: None };
    canals(seed, p, river, coast, &mut plan);
    marina(p, river, coast, &mut plan);
    lake(seed, p, river, coast, &ground, &zoning, true, &mut plan);
    if p.gates > 0 {
        lake(seed, p, river, coast, &ground, &zoning, false, &mut plan);
    }
    plan
}

/// The canals: seeded arms off the river in town, square out of its bank, joined into it.
fn canals(seed: u64, p: &Profile, river: &mut River, coast: &Coast, plan: &mut Plan) {
    let mut rng = Rng::new(rng::sub(seed, "canals", 0, 0));
    let want = rng.range(1, 3) as usize;
    let center: Vec<P> = river.center.iter().map(|q| (q[0], q[1])).collect();
    let n = center.len();
    let basin = (river.basin.x, river.basin.z);
    let near = p.plaza_cm + p.avenue_cm / 2 + BANK_CM + 2_500;
    let mut ends: Vec<P> = Vec::new();
    for _ in 0..60 {
        if plan.canals.len() >= want || n < 10 {
            break;
        }
        let i = rng.range(4, n as i64 - 5) as usize;
        let side = if rng.chance(500) { 1 } else { -1 };
        let width = rng.range(10, 12) * 200;
        let length = rng.range(13, 22) * CANAL_STEP_CM;
        let bend = rng.range(-6, 6) * 5;
        let c = center[i];
        if len(c) > p.city_r_cm * 80 / 100
            || len(c) + 8_000 > coast.lo
            || dist2(c, basin) < (river.basin.r + 6_000).pow(2)
            || [river.dock.0, river.port.0].iter().any(|&d| dist2(c, d) < 9_000 * 9_000)
        {
            continue;
        }
        let t = unit(sub(center[i + 1], center[i - 1]));
        let out = if side > 0 { left(t) } else { neg(left(t)) };
        let steps = length / CANAL_STEP_CM;
        let mut line = vec![c];
        for j in 1..=steps {
            let h = turn(out, bend * j / steps / 5 * 5);
            line.push(along(line[line.len() - 1], h, CANAL_STEP_CM));
        }
        let normals: Vec<P> = (0..line.len()).map(|k| left(unit(sub(line[(k + 1).min(line.len() - 1)], line[k.saturating_sub(1)])))).collect();
        let hw = width / 2;
        let half = vec![(hw, hw); line.len()];
        let b = line[line.len() - 1];
        let rb = width * 11 / 10;
        let (Some((water, _, _)), Some((bank, _, _))) =
            (outline(&line, &normals, &half, b, rb, 0, None), outline(&line, &normals, &half, b, rb, BANK_CM, None))
        else {
            continue;
        };
        let ok = line[1..].iter().all(|&q| coast.land(q) && len(q) < p.city_r_cm * 90 / 100 && coast.radius_at(q) - len(q) > 10_000)
            && bank.iter().all(|&q| len(q) > near)
            && line.iter().all(|&q| [river.dock.0, river.port.0].iter().all(|&d| dist2(q, d) >= 8_000 * 8_000))
            && ends.iter().all(|&e| dist2(e, b) >= 12_000 * 12_000)
            && area2(&water) > 0
            && area2(&bank) > 0;
        if !ok || !river.join(&water, &bank, line.clone()) {
            continue;
        }
        ends.push(b);
        plan.canals.push(Canal { body: plan.bodies.len(), center: line, width });
        plan.bodies.push(Body {
            id: format!("canal:{}", plan.canals.len() - 1), kind: "canal", poly: pts(&water), level: river.sea_cm(), bed: CANAL_BED_CM,
            edge: "quay", islands: Vec::new(), joins: Some("river".to_string()), tier: 1,
        });
    }
}

/// An outline pushed out from `c` by `by` cm at every vertex (radial outlines only).
fn grown(poly: &[P], c: P, by: i64) -> Vec<P> {
    poly.iter().map(|&q| along(q, unit(sub(q, c)), by)).collect()
}

/// Is the outline clear of every body laid so far (with its bank) and inside the world?
fn clear(p: &Profile, river: &River, poly: &[P]) -> bool {
    let half = p.size_cm / 2 - 1_000;
    poly.iter().all(|q| q.0.abs() < half && q.1.abs() < half) && !river.bank_meets(poly)
}

/// The marina: on the coast nearest the plaza (the hub), a dredged basin centred half its
/// radius inland of the coast, clear of the river's mouth and its bank.
fn marina(p: &Profile, river: &mut River, coast: &Coast, plan: &mut Plan) {
    let r = if p.size_cm >= 200_000 { 6_500 } else { 5_500 };
    let mouth = (river.center[0][0], river.center[0][1]);
    let mut order: Vec<(i64, usize)> = coast.poly.iter().enumerate().map(|(k, &q)| (len(q), k)).collect();
    order.sort();
    for (_, k) in order {
        let c = coast.poly[k];
        // square out of the coast: the normal of its edges either side (counter-clockwise,
        // so the sea is on their right)
        let n = coast.poly.len();
        let e = sub(coast.poly[(k + 1) % n], coast.poly[(k + n - 1) % n]);
        let d = unit((e.1, -e.0));
        let m = along(c, d, -r / 2);
        let water = radial(m, 32, |_| r);
        let bank = radial(m, 32, |_| r + MARINA_BANK_CM);
        if dist2(c, mouth) < 25_000 * 25_000 || !clear(p, river, &grown(&bank, m, 1_000)) || !coast.land(along(m, d, -r - MARINA_BANK_CM)) {
            continue;
        }
        river.pools.push((Zone::new(water.clone()), Zone::new(bank)));
        plan.marina = Some(Marina { body: plan.bodies.len(), m, d, r });
        plan.bodies.push(Body {
            id: "marina:0".to_string(), kind: "marina", poly: pts(&water), level: coast.sea_cm, bed: MARINA_BED_CM,
            edge: "quay", islands: Vec::new(), joins: Some("sea".to_string()), tier: 1,
        });
        return;
    }
}

/// A lake: the park lake in town (`park`), else the upland lake on the high ground past
/// the city. The candidates are rings of points; the park lake prefers the park district,
/// then the flattest ground, then the nearest the plaza; the upland lake the highest ground
/// flat enough (4 m across it at most).
#[allow(clippy::too_many_arguments)] // where it may go, and what it must keep clear of
fn lake(seed: u64, p: &Profile, river: &mut River, coast: &Coast, ground: &Terrain, zoning: &Zoning, park: bool, plan: &mut Plan) {
    let mut rng = Rng::new(rng::sub(seed, "lake", park as i64, 0));
    let area_m2 = if park { rng.range(100, 300) * 100 } else { rng.range(60, 120) * 100 };
    // pi r^2 = area: r = sqrt(area * 7 / 22)
    let r = isqrt(area_m2 * 10_000 * 7 / 22);
    let wseed = rng::sub(seed, "lake-outline", park as i64, 0);
    let radii: Vec<i64> = (0..32).map(|k| r + r * 18 / 100 * wobble(wseed, k, 32, &[(3, 3), (5, 2), (8, 1)]) / 32768).collect();
    let reach = r * 118 / 100 + LAKE_BANK_CM;
    let (lo, hi) = if park {
        (p.plaza_cm + p.avenue_cm + 6_000 + reach, p.city_r_cm * 70 / 100)
    } else {
        (p.city_r_cm + 6_000 + reach, p.ring_r_cm - 3_000 - reach)
    };
    let dirs = directions();
    let mut best: Option<((bool, i64, i64, i64), P)> = None;
    let mut rr = lo;
    while rr <= hi {
        for (k, &d) in dirs.iter().enumerate().step_by(4) {
            let c = along((0, 0), d, rr);
            let poly = radial(c, 32, |j| radii[j]);
            let bank = radial(c, 32, |j| radii[j] + LAKE_BANK_CM + 1_000);
            if !bank.iter().all(|&q| coast.land(q) && coast.radius_at(q) - len(q) > 3_000) || !clear(p, river, &bank) {
                continue;
            }
            let hs: Vec<i64> = poly.iter().chain(std::iter::once(&c)).map(|q| ground.height_at(q.0, q.1)).collect();
            let rise = hs.iter().max().unwrap() - hs.iter().min().unwrap();
            let key = if park {
                (zoning.district(c) != Some(district::PARK), rise / 200, rr, k as i64)
            } else {
                (rise > 400, -ground.height_at(c.0, c.1) / 100, rise / 200, k as i64)
            };
            if best.as_ref().is_none_or(|b| key < b.0) {
                best = Some((key, c));
            }
        }
        rr += 2_000;
    }
    let Some((_, c)) = best else { return };
    let poly = radial(c, 32, |j| radii[j]);
    let bank = radial(c, 32, |j| radii[j] + LAKE_BANK_CM);
    // an island in some big park lakes: a small wobbly round off the middle
    let island = (park && area_m2 > 15_000 && rng.chance(600)).then(|| {
        let at = along(c, dirs[rng.range(0, 127) as usize], r * 15 / 100);
        let ri = r * 22 / 100;
        radial(at, 16, |j| ri + ri / 10 * wobble(wseed ^ 1, j, 16, &[(3, 1)]) / 32768)
    });
    river.pools.push((Zone::new(poly.clone()), Zone::new(bank)));
    let n = plan.lakes.len();
    plan.lakes.push(Lake { body: plan.bodies.len(), c, poly: poly.clone(), island: island.clone(), park });
    plan.bodies.push(Body {
        id: format!("lake:{n}"), kind: "lake", poly: pts(&poly), level: 0, bed: rng.range(20, 30) * 10,
        edge: "bank", islands: island.iter().map(|i| pts(i)).collect(), joins: None, tier: 1,
    });
}

impl Plan {
    /// The terrain hook (after the coast's and the river's, which carves the canals): each
    /// lake's surface set a metre under the lowest ground of its outline and its basin dug,
    /// banks 1:3 to its bed, the land round it blended down to just above the water; the
    /// marina dredged to its bed with a quay round it.
    pub fn shape(&mut self, t: &mut Terrain) {
        for l in &self.lakes {
            let level = l.poly.iter().map(|q| t.height_at(q.0, q.1)).min().unwrap() - LAKE_DROP_CM;
            let b = &mut self.bodies[l.body];
            b.level = level;
            let island = l.island.as_ref().map(|i| Zone::new(i.clone()));
            carve(t, &Zone::new(l.poly.clone()), level, b.bed, 3, LAKE_BANK_CM, true, island.as_ref());
        }
        if let Some(m) = &self.marina {
            let b = &self.bodies[m.body];
            carve(t, &Zone::new(radial(m.m, 32, |_| m.r)), b.level, b.bed, 1, 400, false, None);
        }
    }

    /// The rest of the water, once the roads are laid and the sites placed: the piers, the
    /// marina's berths, breakwater, lighthouse and harbour office (a site), the network
    /// and the routes.
    pub fn finish(self, p: &Profile, roads: &Roads, city: &mut City, river: &River, coast: &Coast) -> Water {
        let mut f = Finish { p, roads, river, coast, piers: Vec::new(), nodes: Vec::new() };
        // 3-6 water-bus piers: a canal's and the marina's, the rest on the river
        f.river_piers(city, 3.min(5 - self.canals.len().min(3)));
        for c in &self.canals {
            f.canal_pier(city, c, &self.bodies[c.body]);
        }
        if let Some(m) = &self.marina {
            for (kind, deg) in [("waterbus", 0), ("fuel", 50), ("hire", -50)] {
                let u = turn(neg(m.d), deg);
                f.pier(city, &self.bodies[m.body].id, kind, self.bodies[m.body].level + 100, along(m.m, u, m.r + 300), neg(u), 1_900, 500);
            }
        }
        for l in self.lakes.iter().filter(|l| l.park) {
            let b = &self.bodies[l.body];
            // the launch's jetty on the shore nearest the plaza that has room, the hire
            // jetty as near across from it as has room
            let mut near: Vec<(i64, usize)> = (0..32).map(|k| (dist2(l.poly[k], (0, 0)), k)).collect();
            near.sort();
            let mut jetty = |kind: &'static str, order: Vec<usize>| {
                order.into_iter().find(|&k| {
                    let u = unit(sub(l.poly[k], l.c));
                    f.pier(city, &b.id, kind, b.level + SHORE_CM, along(l.poly[k], u, 300), neg(u), 1_500, 400)
                })
            };
            let k0 = jetty("launch", near.iter().map(|x| x.1).collect()).unwrap_or(near[0].1);
            // across the lake from the launch's, then a vertex either way round at a time
            jetty("hire", (0..32usize).map(|j| (k0 + 16 + if j.is_multiple_of(2) { j / 2 } else { 32 - j.div_ceil(2) }) % 32).collect());
        }

        // the marina: berths, breakwater, lighthouse, office
        let mut berths = Vec::new();
        let (mut breakwater, mut lighthouse, mut office) = (None, None, None);
        // the sea lane leaves the marina on the river's side
        let mouth = (river.center[0][0], river.center[0][1]);
        let gap = self.marina.as_ref().map_or(1, |m| if super::organic::geom::cross(m.d, sub(mouth, m.m)) >= 0 { 1 } else { -1 });
        // the entrance: the first bearing (degrees off the way out to sea, on that side)
        // whose lane from the basin out to sea crosses no land
        let lane = self.marina.as_ref().map(|m| {
            let ends = |deg: i64| {
                let u = turn(m.d, gap * deg);
                (along(m.m, u, m.r * 8 / 10), along(m.m, u, m.r + 3_000))
            };
            let deg = [45, 55, 35, 65, 75, 25]
                .into_iter()
                .find(|&deg| {
                    let (a, b) = ends(deg);
                    (0..=20).all(|s| {
                        let q = (a.0 + (b.0 - a.0) * s / 20, a.1 + (b.1 - a.1) * s / 20);
                        dist2(q, m.m) < m.r * m.r || !coast.land(q)
                    })
                })
                .unwrap_or(45);
            (deg, ends(deg))
        });
        if let Some(m) = &self.marina {
            let id = &self.bodies[m.body].id;
            let side = left(m.d);
            for (row, bow) in [(0, m.d), (-m.r * 35 / 100, neg(m.d))] {
                for j in 0..6i64 {
                    let q = along(along(m.m, side, (2 * j - 5) * 500), m.d, row);
                    if dist2(q, m.m) < (m.r - 600).pow(2) {
                        berths.push(Berth { body: id.clone(), x: q.0, z: q.1, front: [bow.0, bow.1] });
                    }
                }
            }
            // the breakwater: an arc at sea round the seaward side, its head by the entrance
            let top = lane.map_or(4, |l| l.0 / 5 - 5);
            let arc: Vec<P> = (-12..=top).map(|k| along(m.m, turn(m.d, gap * k * 5), m.r + 1_000)).collect();
            let mut run: Vec<P> = Vec::new();
            let mut best: Vec<P> = Vec::new();
            for &q in &arc {
                if !coast.land(q) && !river.bank.holds(q) && !river.wet(q) {
                    run.push(q);
                } else {
                    run.clear();
                }
                if run.len() > best.len() {
                    best = run.clone();
                }
            }
            if best.len() >= 4 {
                lighthouse = best.last().map(|q| [q.0, q.1]);
                breakwater = Some(pts(&best));
            }
            office = f.office(city, m);
        }

        // the network: the river's centre line from out past its mouth, the canals, the
        // marina and the sea lane, the lakes' loops; every pier's head joins it
        let center: Vec<P> = river.center.iter().map(|q| (q[0], q[1])).collect();
        let n = center.len();
        let keep: Vec<usize> = (0..n).filter(|&i| i % 2 == 0 || i == n - 1).collect();
        let first = f.nodes.len() as u32;
        let mut edges: Vec<[u32; 2]> = Vec::new();
        for &i in &keep {
            f.nodes.push(center[i]);
        }
        for k in 1..keep.len() as u32 {
            edges.push([first + k - 1, first + k]);
        }
        let river_node = |i: usize| first + keep.iter().position(|&k| k >= i).unwrap_or(keep.len() - 1) as u32;
        let out = unit(sub(center[0], center[1]));
        let sea = f.nodes.len() as u32;
        f.nodes.push(along(center[0], out, 4_500));
        edges.push([sea, first]);
        let mut canal_nodes: Vec<Vec<u32>> = Vec::new();
        for c in &self.canals {
            let i = (0..n).find(|&i| center[i] == c.center[0]).unwrap_or(0);
            let mut prev = f.nodes.len() as u32;
            f.nodes.push(c.center[0]);
            edges.push([river_node(i).min(prev), river_node(i).max(prev)]);
            let mut mine = vec![prev];
            for (k, &q) in c.center.iter().enumerate().skip(2).step_by(2) {
                if k + 1 == c.center.len() || k % 2 == 0 {
                    let id = f.nodes.len() as u32;
                    f.nodes.push(q);
                    edges.push([prev, id]);
                    mine.push(id);
                    prev = id;
                }
            }
            if *c.center.last().unwrap() != f.nodes[prev as usize] {
                let id = f.nodes.len() as u32;
                f.nodes.push(*c.center.last().unwrap());
                edges.push([prev, id]);
                mine.push(id);
            }
            canal_nodes.push(mine);
        }
        let mut marina_node = None;
        if let Some(m) = &self.marina {
            // basin -> the entrance -> out to sea -> round the coast to the river's mouth
            let (_, (a, b)) = lane.unwrap();
            let (mid, inner, outer) = (f.nodes.len() as u32, f.nodes.len() as u32 + 1, f.nodes.len() as u32 + 2);
            f.nodes.extend([m.m, a, b]);
            edges.extend([[mid, inner], [inner, outer]]);
            marina_node = Some(mid);
            let lane = sea_lane(p, coast, f.nodes[outer as usize], f.nodes[sea as usize]);
            let mut prev = outer;
            for q in lane {
                let id = f.nodes.len() as u32;
                f.nodes.push(q);
                edges.push([prev, id]);
                prev = id;
            }
            edges.push([prev, sea]);
        }
        let mut lake_loops: Vec<(String, Vec<u32>)> = Vec::new();
        for l in self.lakes.iter().filter(|l| l.park) {
            let start = f.nodes.len() as u32;
            for k in (0..32).step_by(2) {
                f.nodes.push(along(l.c, unit(sub(l.poly[k], l.c)), len(sub(l.poly[k], l.c)) * 68 / 100));
            }
            for k in 0..16u32 {
                edges.push([start + k, start + (k + 1) % 16]);
            }
            lake_loops.push((self.bodies[l.body].id.clone(), (start..start + 16).collect()));
        }
        // each pier's head, joined to the nearest node of its own water
        let mut pier_node = Vec::new();
        for (pier, head) in &f.piers {
            let own: Vec<u32> = if pier.body == "river" {
                keep.iter().enumerate().map(|(k, _)| first + k as u32).collect()
            } else if let Some(k) = self.canals.iter().position(|c| self.bodies[c.body].id == pier.body) {
                canal_nodes[k].clone()
            } else if let Some((_, l)) = lake_loops.iter().find(|(id, _)| *id == pier.body) {
                l.clone()
            } else {
                marina_node.into_iter().collect()
            };
            let id = f.nodes.len() as u32;
            f.nodes.push(*head);
            if let Some(&to) = own.iter().min_by_key(|&&k| (dist2(f.nodes[k as usize], *head), k)) {
                edges.push([to.min(id), to.max(id)]);
            }
            pier_node.push(id);
        }
        let net = Net { nodes: pts(&f.nodes), edges };

        // routes: the water bus over the connected network, the launch round its lake
        let adj = adjacency(&net);
        let start = marina_node.unwrap_or(sea);
        let from_start = dijkstra(&net, &adj, start).0;
        let mut bus: Vec<(i64, usize)> = (0..f.piers.len())
            .filter(|&k| f.piers[k].0.kind == "waterbus" && from_start[pier_node[k] as usize] < i64::MAX)
            .map(|k| (from_start[pier_node[k] as usize], k))
            .collect();
        bus.sort();
        let total: i64 = net.edges.iter().map(|e| len(sub(f.nodes[e[0] as usize], f.nodes[e[1] as usize]))).sum();
        let canal_pier = |k: usize| self.canals.iter().any(|c| self.bodies[c.body].id == f.piers[k].0.body);
        let mut routes = Vec::new();
        let ids = |stops: &[usize]| stops.iter().map(|&k| format!("pier:{k}")).collect::<Vec<_>>();
        let (main, branch): (Vec<usize>, Vec<usize>) = bus.iter().map(|b| b.1).partition(|&k| !canal_pier(k));
        let split = total >= 250_000 && bus.len() >= 4 && !branch.is_empty() && main.len() >= 2;
        let lines: Vec<(&str, Vec<usize>)> = if split {
            // W2: the canals, from the river pier nearest their mouths
            let hub = *main
                .iter()
                .min_by_key(|&&k| {
                    let d = dijkstra(&net, &adj, pier_node[k]).0;
                    (branch.iter().map(|&b| d[pier_node[b] as usize]).sum::<i64>(), k)
                })
                .unwrap();
            let d = dijkstra(&net, &adj, pier_node[hub]).0;
            let mut w2: Vec<(i64, usize)> = branch.iter().map(|&k| (d[pier_node[k] as usize], k)).collect();
            w2.sort();
            vec![("W1", main), ("W2", std::iter::once(hub).chain(w2.into_iter().map(|x| x.1)).collect())]
        } else {
            vec![("W1", bus.iter().map(|b| b.1).collect())]
        };
        for (id, stops) in lines {
            if stops.len() < 2 {
                continue;
            }
            let mut path = vec![pier_node[stops[0]]];
            for w in stops.windows(2) {
                path.extend(shortest(&net, &adj, pier_node[w[0]], pier_node[w[1]]).into_iter().skip(1));
            }
            routes.push(Route { id: id.to_string(), kind: "waterbus", piers: ids(&stops), path, looped: false, tier: 2 });
        }
        for (body, nodes) in &lake_loops {
            let Some(k) = (0..f.piers.len()).find(|&k| f.piers[k].0.kind == "launch" && f.piers[k].0.body == *body) else { continue };
            let head = f.nodes[pier_node[k] as usize];
            let j = (0..nodes.len()).min_by_key(|&j| (dist2(f.nodes[nodes[j] as usize], head), j)).unwrap();
            let mut path = vec![pier_node[k]];
            path.extend((0..=nodes.len()).map(|s| nodes[(j + s) % nodes.len()]));
            path.push(pier_node[k]);
            routes.push(Route { id: "L1".to_string(), kind: "launch", piers: ids(&[k]), path, looped: true, tier: 1 });
        }

        // a few hire moorings beside each hire jetty's head
        for (pier, head) in f.piers.iter().filter(|x| x.0.kind == "hire") {
            let fr = (pier.front[0], pier.front[1]);
            for s in [-1, 1] {
                let q = along(along(*head, left(fr), s * 500), fr, -300);
                if self.bodies.iter().any(|b| b.id == pier.body && wet_in(b, q)) {
                    berths.push(Berth { body: pier.body.clone(), x: q.0, z: q.1, front: pier.front });
                }
            }
        }

        let piers = f.piers.into_iter().map(|x| x.0).collect();
        Water { bodies: self.bodies, piers, berths, breakwater, lighthouse, office, net, routes }
    }
}

/// Is q on this body's water (off its islands)?
fn wet_in(b: &Body, q: P) -> bool {
    let poly: Vec<P> = b.poly.iter().map(|v| (v[0], v[1])).collect();
    inside(q, &poly) && !b.islands.iter().any(|i| inside(q, &i.iter().map(|v| (v[0], v[1])).collect::<Vec<_>>()))
}

/// Dig `water` into the terrain: its surface `level`, banks falling 1 in `slope` from the
/// edge to `bed` below it; the land within `bank` cm of the edge blended down to just
/// above the surface (and, `raise`, lifted to it where lower, so a lake never spills: the
/// marina leaves the sea bed be); an island stands just above the surface.
#[allow(clippy::too_many_arguments)] // the water, its levels and its shore
fn carve(t: &mut Terrain, water: &Zone, level: i64, bed: i64, slope: i64, bank: i64, raise: bool, island: Option<&Zone>) {
    let (x0, x1) = water.poly.iter().fold((i64::MAX, i64::MIN), |m, q| (m.0.min(q.0), m.1.max(q.0)));
    let (z0, z1) = water.poly.iter().fold((i64::MAX, i64::MIN), |m, q| (m.0.min(q.1), m.1.max(q.1)));
    let (lo, hi) = (t.vertex_of(x0 - bank - t.cell_cm, z0 - bank - t.cell_cm), t.vertex_of(x1 + bank + t.cell_cm, z1 + bank + t.cell_cm));
    let top = level + SHORE_CM;
    for iz in lo.1..=hi.1 {
        for ix in lo.0..=hi.0 {
            let q = t.vertex_pos(ix, iz);
            let wet = water.holds(q);
            let s = match water.near2(q) {
                Some(d2) => if wet { -isqrt(d2) } else { isqrt(d2) },
                None if wet => -bed * slope - 1_600,
                None => continue,
            };
            if s >= bank {
                continue;
            }
            let k = iz * t.n + ix;
            let h = t.heights[k] as i64;
            let h = if island.is_some_and(|z| z.holds(q)) {
                top
            } else if s < 0 {
                h.min(level - (EDGE_CM - s / slope).min(bed))
            } else if h > top {
                top + (h - top) * smoothstep(s * ONE / bank) / ONE
            } else if raise {
                top
            } else {
                h
            };
            t.heights[k] = h as i32;
        }
    }
}

/// The sea lane from `a` round the coast to `b` (both at sea): a point out past the coast
/// in each of the coast's directions between them, the short way round.
fn sea_lane(p: &Profile, coast: &Coast, a: P, b: P) -> Vec<P> {
    let dirs = directions();
    let n = dirs.len() as i64;
    let at = |q: P| (0..dirs.len()).max_by_key(|&k| (dot(dirs[k], q), Reverse(k))).unwrap() as i64;
    let (ka, kb) = (at(a), at(b));
    let fwd = (kb - ka).rem_euclid(n);
    let (step, count) = if fwd <= n / 2 { (1, fwd) } else { (-1, n - fwd) };
    let half = p.size_cm / 2 - 300;
    (0..=count)
        .map(|s| {
            let k = (ka + s * step).rem_euclid(n) as usize;
            let d = dirs[k];
            let edge = half * ONE / d.0.abs().max(d.1.abs()).max(1);
            let r = len(coast.poly[k]);
            along((0, 0), d, (r + 4_000).min(edge).max(r + 600))
        })
        .collect()
}

fn adjacency(net: &Net) -> Vec<Vec<u32>> {
    let mut adj = vec![Vec::new(); net.nodes.len()];
    for e in &net.edges {
        adj[e[0] as usize].push(e[1]);
        adj[e[1] as usize].push(e[0]);
    }
    for a in &mut adj {
        a.sort();
        a.dedup();
    }
    adj
}

/// Distances (cm, i64::MAX unreached) and predecessors from `s` over the network.
fn dijkstra(net: &Net, adj: &[Vec<u32>], s: u32) -> (Vec<i64>, Vec<u32>) {
    let n = net.nodes.len();
    let (mut dist, mut prev) = (vec![i64::MAX; n], vec![u32::MAX; n]);
    let mut heap = BinaryHeap::new();
    dist[s as usize] = 0;
    heap.push(Reverse((0i64, s)));
    while let Some(Reverse((d, u))) = heap.pop() {
        if d > dist[u as usize] {
            continue;
        }
        for &v in &adj[u as usize] {
            let (a, b) = (net.nodes[u as usize], net.nodes[v as usize]);
            let nd = d + isqrt((a[0] - b[0]).pow(2) + (a[1] - b[1]).pow(2));
            if nd < dist[v as usize] {
                dist[v as usize] = nd;
                prev[v as usize] = u;
                heap.push(Reverse((nd, v)));
            }
        }
    }
    (dist, prev)
}

/// The nodes of the shortest way from `a` to `b`, both included (just `a` if none).
fn shortest(net: &Net, adj: &[Vec<u32>], a: u32, b: u32) -> Vec<u32> {
    let (dist, prev) = dijkstra(net, adj, a);
    if dist[b as usize] == i64::MAX {
        return vec![a];
    }
    let mut out = vec![b];
    while *out.last().unwrap() != a {
        out.push(prev[*out.last().unwrap() as usize]);
    }
    out.reverse();
    out
}

struct Finish<'a> {
    p: &'a Profile,
    roads: &'a Roads,
    river: &'a River,
    coast: &'a Coast,
    /// The piers laid, each with its head (the end over the water).
    piers: Vec<(Pier, P)>,
    nodes: Vec<P>,
}

impl Finish<'_> {
    /// Is the segment ab clear of every road (its half-width and `margin`), and of every
    /// lot and site footprint?
    fn clear(&self, city: &City, a: P, b: P, margin: i64) -> bool {
        let (x0, x1, z0, z1) = (a.0.min(b.0), a.0.max(b.0), a.1.min(b.1), a.1.max(b.1));
        let roads = self.roads.edges.iter().all(|e| {
            let m = e.width / 2 + margin;
            e.points.windows(2).all(|s| {
                let (c, d) = ((s[0][0], s[0][2]), (s[1][0], s[1][2]));
                c.0.max(d.0) < x0 - m || c.0.min(d.0) > x1 + m || c.1.max(d.1) < z0 - m || c.1.min(d.1) > z1 + m || seg_dist2(a, b, c, d) >= m * m
            })
        });
        let foot = |poly: &Vec<[i64; 2]>| {
            let poly: Vec<P> = poly.iter().map(|q| (q[0], q[1])).collect();
            let n = poly.len();
            inside(a, &poly) || inside(b, &poly) || (0..n).any(|k| seg_dist2(a, b, poly[k], poly[(k + 1) % n]) < margin * margin)
        };
        roads
            && !city.lots.iter().filter_map(|l| l.poly.as_ref()).any(foot)
            && !city.sites.iter().filter_map(|s| s.poly.as_ref()).any(foot)
            && self.piers.iter().all(|(x, h)| {
                let root = along(*h, (x.front[0], x.front[1]), -x.len);
                seg_dist2(a, b, root, *h) >= 1_500 * 1_500
            })
    }

    /// A pier of `kind` in `body` from `root` (on land) `len` cm out along `front` over
    /// the water, if its root is dry land, its head on the body's water and it is clear.
    #[allow(clippy::too_many_arguments)] // a pier is its body, kind, deck and footprint
    fn pier(&mut self, city: &City, body: &str, kind: &'static str, y: i64, root: P, front: P, len: i64, w: i64) -> bool {
        let front = unit(front);
        let head = along(root, front, len);
        let wet = |q: P| self.river.wet(q) || !self.coast.land(q);
        if wet(root) || !self.coast.land(root) || !wet(head) || !self.clear(city, root, head, w / 2 + 200) {
            return false;
        }
        let mid = along(root, front, len / 2);
        let id = format!("pier:{}", self.piers.len());
        self.piers.push((Pier { id, body: body.to_string(), kind, x: mid.0, z: mid.1, y, front: [front.0, front.1], len, w, tier: if kind == "waterbus" { 2 } else { 1 } }, head));
        true
    }

    /// Water-bus piers on the river in town (up to `most`, 150 m apart), on the bank toward
    /// the plaza, clear of the dock, the port and the basin and of every bridge.
    fn river_piers(&mut self, city: &City, most: usize) {
        let r = self.river;
        let c: Vec<P> = r.center.iter().map(|q| (q[0], q[1])).collect();
        let hw = r.width_cm / 2;
        let basin = (r.basin.x, r.basin.z);
        let mut cand: Vec<(i64, usize)> = (2..c.len().saturating_sub(2))
            .filter(|&i| {
                len(c[i]) < self.p.city_r_cm * 85 / 100
                    && dist2(c[i], basin) > (r.basin.r + 3_000).pow(2)
                    && [r.dock.0, r.port.0].iter().all(|&d| dist2(c[i], d) >= 7_000 * 7_000)
            })
            .map(|i| (dist2(c[i], (0, 0)), i))
            .collect();
        cand.sort();
        let mut laid: Vec<P> = Vec::new();
        for (_, i) in cand {
            if laid.len() >= most {
                break;
            }
            if laid.iter().any(|&q| dist2(q, c[i]) < 15_000 * 15_000) {
                continue;
            }
            let n = left(unit(sub(c[i + 1], c[i - 1])));
            let n = if dot(n, neg(c[i])) >= 0 { n } else { neg(n) };
            let y = r.sea_cm() + 100;
            if self.pier(city, "river", "waterbus", y, along(c[i], n, hw + 300), neg(n), 1_500, 500) {
                laid.push(c[i]);
            }
        }
    }

    /// A water-bus pier on a canal, two thirds of the way up it, either quay.
    fn canal_pier(&mut self, city: &City, c: &Canal, b: &Body) {
        let hw = c.width / 2;
        let m = c.center.len();
        for k in [m * 2 / 3, m / 2, m * 3 / 4, m / 3] {
            let k = k.clamp(1, m - 2);
            let n = left(unit(sub(c.center[k + 1], c.center[k - 1])));
            for side in [n, neg(n)] {
                if self.pier(city, &b.id, "waterbus", b.level + 100, along(c.center[k], side, hw + 300), neg(side), 1_000, 500) {
                    return;
                }
            }
        }
    }

    /// The harbour office: a small site on the marina's quay behind the piers, facing the
    /// water, clear of every road, block and site.
    fn office(&self, city: &mut City, m: &Marina) -> Option<String> {
        for deg in [25, -25, 40, -40, 60, -60, 10, -10] {
            let u = turn(neg(m.d), deg);
            let c = along(m.m, u, m.r + 1_100);
            let front = neg(u);
            let poly = rect(c, front, 1_200, 900);
            let dry = poly.iter().all(|&q| self.coast.land(q) && !self.river.wet(q));
            let piers_clear = self.piers.iter().all(|(x, h)| {
                let root = along(*h, (x.front[0], x.front[1]), -x.len);
                (0..4).all(|k| seg_dist2(poly[k], poly[(k + 1) % 4], root, *h) > 300 * 300)
            });
            if !dry || !piers_clear || !super::civic::open(self.roads, city, &poly) {
                continue;
            }
            let block = city.blocks.iter().min_by_key(|b| (dist2((b.x, b.z), c), b.id)).map_or(0, |b| b.id);
            city.sites.push(Site {
                id: "harbour:0".to_string(), kind: "harbour", block, x: c.0, y: 0, z: c.1, w: 1_200, d: 900,
                facing: if front.1 >= 0 { Facing::North } else { Facing::South },
                tier: Some(1), poly: Some(pts(&poly)), front: Some([front.0, front.1]), view: None, runway: None,
            });
            return Some("harbour:0".to_string());
        }
        None
    }
}

#[cfg(test)]
#[path = "water_tests.rs"]
mod tests;
