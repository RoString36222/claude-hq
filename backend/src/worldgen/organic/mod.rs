//! The organic city (world version 2: the Commons and the personal islands).
//!
//!   zoning (district seeds round the plaza, each with a character)
//!     -> the river's bank laid in as a wall (river.rs): streets meet it and stop
//!     -> arterials traced through a tensor field (radial, the districts' grids,
//!        the slope of the land, the coast), then local streets grown off them
//!        L-system style, every district in its own way (streets.rs)
//!        (arterials bridge the river; a quay street runs to the dock's bank)
//!     -> the network pruned: no road steeper than the city's grade, one network
//!     -> blocks: the faces of the planar road graph, inset to the kerbs (blocks.rs);
//!        the river's faces are no blocks, and the wall comes down
//!     -> lots: blocks split down to their district's lot size, every lot on a road (lots.rs)
//!     -> sites on the plaza and the civic lots, the HQ pool on the lots nearest
//!        the plaza, a growth rank for every lot
//!     -> highways and the ring, routed as in version 1 (roads::graded)
//!
//! Layout comes from the seed and the profile only, and every route is planned on
//! the BASE terrain: edits re-seat roads, lots and sites, never move them.

pub mod blocks;
pub mod geom;
pub mod graph;
pub mod lots;
pub mod streets;
pub mod tensor;
pub mod widen;
pub mod zoning;

#[cfg(test)]
mod tests;

use std::collections::{BTreeMap, BTreeSet};

use super::city::{Block, City, Facing, Lot, Site};
use super::districts::{Districts, CELL_CM};
use super::noise::{isqrt, value, ONE};
use super::profile::{district, Place, Profile};
use super::river::River;
use super::rng::{sub, Rng};
use super::roads::{self, Edge, Node, Roads};
use super::terrain::Terrain;
use geom::{area2, centroid, dist2, inside, left, nearest_on, seg_dist2, P};
use graph::{Graph, Kind};
use streets::{Ctx, Street};
use zoning::{character, Zoning};

/// Generate the city, its roads and the district map, round the river if it has one.
/// `water`: the @3 water bodies laid before the streets (water.rs), kept off the airport's claim.
pub fn generate(seed: u64, p: &Profile, base: &Terrain, river: Option<&River>, water: &[Vec<P>]) -> Result<(City, Roads, Districts), String> {
    let zoning = Zoning::new(seed, p);
    let field = tensor::Field { terrain: base, grids: zoning.grids(), radial_r: p.city_r_cm * 6 / 10, coast_r: p.coast_r_cm };
    let ctx = Ctx { p, t: base, field, zoning: &zoning, river };

    // names: the highways' first (roads::graded draws them), then the arterials', and
    // the local streets go round the rest, so no highway shares a street's name
    let mut rng = Rng::new(sub(seed, "roads", 0, 0));
    let mut names: Vec<&str> = roads::NAMES.to_vec();
    rng.shuffle(&mut names);
    let (ways, rest) = names.split_at(p.gates as usize);
    let (art_names, local_names) = rest.split_at(2 + p.radials.1 as usize);

    let mut g = Graph::default();
    let mut streets = Vec::new();
    let mut grow = Rng::new(sub(seed, "streets", 0, 0));
    // the river's bank, a loop of wall: its first node, and the one behind the dock
    // (where the dock's quay street ends)
    let wall = river.map(|r| {
        let road = streets.len() as u32;
        streets.push(Street { name: "River".to_string(), kind: Kind::Water });
        let first = g.nodes.len() as u32;
        let n = r.bank.poly.len() as u32;
        for &q in &r.bank.poly {
            g.node(q);
        }
        for k in 0..n {
            g.link(first + k, first + (k + 1) % n, Kind::Water, road);
        }
        (first, first + r.quay as u32)
    });
    // @3: the other bodies of water in reach of the city (lakes, the marina), each its
    // own loop of wall (none before @3: the streets are as they were)
    let mut pools: Vec<(u32, u32)> = Vec::new();
    if let Some(r) = river.filter(|r| !r.pools.is_empty()) {
        let road = streets.len() as u32;
        streets.push(Street { name: "Water".to_string(), kind: Kind::Water });
        for (_, bank) in &r.pools {
            if bank.poly.iter().all(|&q| geom::len(q) > p.city_r_cm + 2_000) {
                continue;
            }
            let first = g.nodes.len() as u32;
            let n = bank.poly.len() as u32;
            for &q in &bank.poly {
                g.node(q);
            }
            for k in 0..n {
                g.link(first + k, first + (k + 1) % n, Kind::Water, road);
            }
            pools.push((first, n));
        }
    }
    let mut chains = streets::arterials(&mut g, &ctx, &mut grow, &mut streets, art_names)?;
    // the dock's quay: a street to the bank behind the dock from the nearest arterial,
    // else (once the local streets have grown) from the nearest street; none if a street
    // already ends on the bank there (within 15 m)
    let mut quay = None;
    if let Some((first, to)) = wall {
        // bridges where the arterials left the river unbridged, from the far end of the names
        let rev: Vec<&str> = local_names.iter().rev().copied().collect();
        chains.extend(streets::bridges(&mut g, &ctx, first, &mut streets, &rev));
        let road = streets.len() as u32;
        streets.push(Street { name: format!("{} Quay", local_names[0]), kind: Kind::Local });
        quay = Some((to, road));
    }
    let laid = |g: &Graph, to: u32| {
        let q = g.nodes[to as usize];
        g.edges.iter().any(|e| e.alive && e.kind != Kind::Water && [e.a, e.b].iter().any(|&n| dist2(g.nodes[n as usize], q) <= 1_500 * 1_500))
    };
    let quay = quay.filter(|&(to, road)| !laid(&g, to) && !g.spur(to, 12_000, streets::MIN_CM, Kind::Local, road));
    streets::locals(&mut g, &ctx, &mut grow, &chains, &mut streets, local_names);
    // @3: a pool no street reaches gets one, to its shore nearest the plaza (else its
    // wall would float inside a block)
    for &(first, n) in &pools {
        let touched = (first..first + n).any(|k| g.adj[k as usize].iter().any(|&e| g.edges[e as usize].kind != Kind::Water));
        if touched {
            continue;
        }
        let road = streets.len() as u32;
        streets.push(Street { name: format!("{} Shore", local_names[(road as usize) % local_names.len()]), kind: Kind::Local });
        let mut by: Vec<(i64, u32)> = (first..first + n).map(|k| (dist2(g.nodes[k as usize], (0, 0)), k)).collect();
        by.sort();
        for (_, k) in by.into_iter().take(8) {
            if g.spur(k, 12_000, streets::MIN_CM, Kind::Local, road) {
                break;
            }
        }
    }
    if let Some((to, road)) = quay {
        if !laid(&g, to) && !g.spur(to, 12_000, streets::MIN_CM, Kind::Local, road) {
            return Err(format!("profile {}: no road reaches the dock", p.name));
        }
    }
    prune(&mut g, p, base, chains[0][0]);
    if wall.is_some_and(|(_, to)| !laid(&g, to)) {
        return Err(format!("profile {}: the dock's road was pruned", p.name));
    }

    let width = |k: Kind| match k {
        Kind::Arterial => p.avenue_cm,
        Kind::Local => p.road_cm,
        Kind::Water => 0,
    };

    // blocks, the plaza first, then nearest it first; then the river's wall comes down
    let mut faces = blocks::blocks(&g, |e: u32| width(g.edges[e as usize].kind) / 2);
    // @3: no block over a pool's water (one whose wall no street reached)
    if let Some(r) = river.filter(|r| !r.pools.is_empty()) {
        faces.retain(|f| !r.pools.iter().any(|z| z.0.meets(&f.poly)));
    }
    for k in 0..g.edges.len() {
        if g.edges[k].alive && g.edges[k].kind == Kind::Water {
            g.kill(k as u32);
        }
    }
    let half = |e: u32| width(g.edges[e as usize].kind) / 2;
    let mut order: Vec<(i64, P, usize)> = faces
        .iter()
        .enumerate()
        .map(|(k, f)| {
            let c = centroid(&f.poly);
            (if inside((0, 0), &f.poly) { -1 } else { dist2(c, (0, 0)) }, c, k)
        })
        .collect();
    order.sort();
    if order.first().is_none_or(|o| o.0 != -1) {
        return Err(format!("profile {}: the plaza is not a block", p.name));
    }
    let mut blocks = Vec::with_capacity(order.len());
    let mut holes = Vec::with_capacity(order.len());
    let mut fronts = Vec::with_capacity(order.len());
    for (id, &(rank, c, k)) in order.iter().enumerate() {
        let poly = &faces[k].poly;
        let (x0, x1) = (poly.iter().map(|q| q.0).min().unwrap(), poly.iter().map(|q| q.0).max().unwrap());
        let (z0, z1) = (poly.iter().map(|q| q.1).min().unwrap(), poly.iter().map(|q| q.1).max().unwrap());
        let d = if rank == -1 { district::PLAZA } else { zoning.district(c).unwrap_or(district::SUBURB) };
        blocks.push(Block {
            id: id as u32, i: 0, j: 0, x: (x0 + x1) / 2, z: (z0 + z1) / 2, w: x1 - x0, d: z1 - z0, district: d,
            poly: Some(poly.iter().map(|q| [q.0, q.1]).collect()),
        });
        holes.push(&faces[k].holes);
        fronts.push(&faces[k].fronts);
    }

    // lots: every block of a district that builds, split to its lot size; a lot must
    // be clear of every road, outside the block's holes, with its door on a road
    let mut lots: Vec<Lot> = Vec::new();
    for ((b, hs), fs) in blocks.iter().zip(&holes).zip(&fronts) {
        let ch = character(b.district);
        if !ch.grows || b.district == district::PLAZA {
            continue;
        }
        let sides: Vec<(P, bool)> = b.poly.as_ref().unwrap().iter().zip(fs.iter()).map(|(q, &f)| ((q[0], q[1]), f)).collect();
        let mut rng = Rng::new(sub(seed, "lots", b.id as i64, 0));
        for cut in lots::split_sides(&sides, ch.lot_m2 * 10_000, &mut rng) {
            let c = centroid(&cut.poly);
            if hs.iter().any(|h| inside(c, h)) || !clear_of_roads(&g, &cut.poly, half) || !on_a_road(&g, cut.door, half) {
                continue;
            }
            // @3: never on a pool's bank
            if river.is_some_and(|r| r.pools.iter().any(|z| z.1.meets(&cut.poly))) {
                continue;
            }
            let floors = rng.range(ch.floors.0, ch.floors.1);
            lots.push(Lot {
                id: 0, block: b.id, kind: "building", district: b.district, x: c.0, z: c.1, w: cut.w, d: cut.d,
                facing: if cut.front.1 >= 0 { Facing::North } else { Facing::South },
                door: [cut.door.0, base.height_at(cut.door.0, cut.door.1), cut.door.1], floors,
                rank: None, tier: None, poly: Some(cut.poly.iter().map(|q| [q.0, q.1]).collect()), front: Some([cut.front.0, cut.front.1]),
                grow: None, min_tier: None,
            });
        }
    }

    let mut sites = sites(p, base, &blocks, &mut lots)?;
    // the civic sites take their lots before the HQ pool is drawn: never a member's
    super::civic::place(seed, p, base, &g, &mut blocks, &mut lots, &mut sites)?;
    hq_pool(p, base, &mut lots)?;
    let mut by_core: Vec<(i64, usize)> = lots.iter().enumerate().map(|(k, l)| (l.x * l.x + l.z * l.z, k)).collect();
    by_core.sort();
    for (rank, &(_, k)) in by_core.iter().enumerate() {
        lots[k].grow = Some(rank as u32);
    }
    for (k, l) in lots.iter_mut().enumerate() {
        l.id = k as u32;
    }
    // the layout is final: pave the roads wider into the strip of block and lot along them
    let roles = if p.v4 { v4_roles(&g, &zoning) } else { Vec::new() };
    let paving = widen::widen(p, seed, base, &g, &mut blocks, &mut lots, &mut sites, &roles, river);
    // City Gen v4 (@3 Commons): the airport claims its land before the graded roads are
    // routed, so the highways and the ring go round it (claims.rs)
    let mut city = City { blocks, lots, sites };
    let claim = if p.water && p.gates > 0 { super::civic::airport_first(p, base, &mut city, river, water) } else { None };
    let City { blocks, lots, sites } = city;

    // the road graph as the world's roads (live nodes only), then the graded roads
    let mut renum = vec![u32::MAX; g.nodes.len()];
    let mut nodes = Vec::new();
    for (k, &(x, z)) in g.nodes.iter().enumerate() {
        if !g.adj[k].is_empty() {
            renum[k] = nodes.len() as u32;
            nodes.push(Node { id: nodes.len() as u32, x, y: base.height_at(x, z), z, junction: None, island: None });
        }
    }
    let mut edges: Vec<Edge> = g
        .edges
        .iter()
        .enumerate()
        .filter(|(_, e)| e.alive)
        .map(|(k, e)| {
            let class = if e.kind == Kind::Arterial { "arterial" } else { "local" };
            let Street { name, .. } = &streets[e.road as usize];
            let (width, walk) = paving.width(k as u32);
            Edge {
                id: 0, a: renum[e.a as usize], b: renum[e.b as usize], class, width, walk, lanes: 1, route: None,
                name: name.clone(), points: roads::resample(g.nodes[e.a as usize], g.nodes[e.b as usize]), min_tier: None,
                bridge: e.bridge.then_some(true), v4: None, median: None,
            }
            .classed(paving.class(k as u32))
        })
        .collect();
    roads::graded(&mut rng, p, base, &blocks, &mut nodes, &mut edges, &mut ways.iter().copied(), river, claim.as_ref())?;
    let roads = Roads { nodes, edges };

    let districts = district_map(seed, p, base, &ctx, &g, &blocks, claim.as_ref());
    Ok((City { blocks, lots, sites }, roads, districts))
}

/// City Gen v4 (phase 2): the class each graph edge's street starts its paving ladder at
/// (widen.rs), by the street's role: a main road a boulevard where every block along it is
/// at least `BOULEVARD_BLOCK_CM` long (a 36.5 m road's junctions need the room), else an
/// avenue; a local street in the old
/// town or the plaza a shared street; one with a dead end, or under 60 m, a lane; one
/// 150 m or more that joins main roads at two places or more a collector (it gathers the
/// local streets to them); any other a local street.
const BOULEVARD_BLOCK_CM: i64 = 5_000;

fn v4_roles(g: &Graph, zoning: &Zoning) -> Vec<Option<&'static str>> {
    let alive = |e: &u32| g.edges[*e as usize].alive && g.edges[*e as usize].kind != Kind::Water;
    let mut by_road: BTreeMap<u32, Vec<u32>> = BTreeMap::new();
    for (k, e) in g.edges.iter().enumerate() {
        if e.alive && e.kind != Kind::Water {
            by_road.entry(e.road).or_default().push(k as u32);
        }
    }
    let mut out = vec![None; g.edges.len()];
    for es in by_road.values() {
        let first = &g.edges[es[0] as usize];
        let seg = |e: u32| geom::len(geom::sub(g.nodes[g.edges[e as usize].b as usize], g.nodes[g.edges[e as usize].a as usize]));
        let role = if first.kind == Kind::Arterial {
            if es.iter().all(|&e| seg(e) >= BOULEVARD_BLOCK_CM) { "boulevard" } else { "avenue" }
        } else {
            let len: i64 = es.iter().map(|&e| geom::len(geom::sub(g.nodes[g.edges[e as usize].b as usize], g.nodes[g.edges[e as usize].a as usize]))).sum();
            let nodes: BTreeSet<u32> = es.iter().flat_map(|&e| [g.edges[e as usize].a, g.edges[e as usize].b]).collect();
            let dead = nodes.iter().any(|&n| g.adj[n as usize].iter().filter(|e| alive(e)).count() == 1);
            let joins = nodes.iter().filter(|&&n| g.adj[n as usize].iter().any(|&e| alive(&e) && g.edges[e as usize].kind == Kind::Arterial)).count();
            let mid = es[es.len() / 2];
            let m = &g.edges[mid as usize];
            let at = geom::lerp(g.nodes[m.a as usize], g.nodes[m.b as usize], 1, 2);
            if matches!(zoning.district(at), Some(district::OLDTOWN) | Some(district::PLAZA)) {
                "shared"
            } else if dead || len < 6_000 {
                "lane"
            } else if joins >= 2 && len >= 15_000 {
                "collector"
            } else {
                "local"
            }
        };
        for &e in es {
            out[e as usize] = Some(role);
        }
    }
    out
}

/// Drop every road steeper than the city's grade (measured as the world will be:
/// the ground under each 8 m step; a bridge is level), then every road the plaza (its
/// ring's node `start`) cannot reach. The river's wall is no road: never dropped, never
/// a way through.
fn prune(g: &mut Graph, p: &Profile, t: &Terrain, start: u32) {
    for k in 0..g.edges.len() {
        let e = &g.edges[k];
        if !e.alive || e.kind == Kind::Water || e.bridge {
            continue;
        }
        let pts = roads::resample(g.nodes[e.a as usize], g.nodes[e.b as usize]);
        let steep = pts.windows(2).any(|s| {
            let run = isqrt((s[1][0] - s[0][0]).pow(2) + (s[1][2] - s[0][2]).pow(2)).max(1);
            (t.height_at(s[1][0], s[1][2]) - t.height_at(s[0][0], s[0][2])).abs() * 1000 / run > p.city_grade_pm
        });
        if steep {
            g.kill(k as u32);
        }
    }
    let mut seen = vec![false; g.nodes.len()];
    let mut stack = vec![start];
    seen[start as usize] = true;
    while let Some(n) = stack.pop() {
        for &e in &g.adj[n as usize] {
            if g.edges[e as usize].kind == Kind::Water {
                continue;
            }
            let m = g.other(e, n);
            if !seen[m as usize] {
                seen[m as usize] = true;
                stack.push(m);
            }
        }
    }
    for k in 0..g.edges.len() {
        if g.edges[k].alive && g.edges[k].kind != Kind::Water && !(seen[g.edges[k].a as usize] && seen[g.edges[k].b as usize]) {
            g.kill(k as u32);
        }
    }
    // a bridge leads somewhere: none left with a bank no road meets
    let road = |g: &Graph, n: u32, e: u32| g.adj[n as usize].iter().any(|&x| x != e && g.edges[x as usize].kind != Kind::Water);
    loop {
        let dead: Vec<u32> = (0..g.edges.len() as u32)
            .filter(|&e| g.edges[e as usize].alive && g.edges[e as usize].bridge && !(road(g, g.edges[e as usize].a, e) && road(g, g.edges[e as usize].b, e)))
            .collect();
        if dead.is_empty() {
            break;
        }
        for e in dead {
            g.kill(e);
        }
    }
}

/// Is every edge of the footprint at least its half-width from every road?
fn clear_of_roads(g: &Graph, poly: &[P], half: impl Fn(u32) -> i64) -> bool {
    let reach = 1_000;
    let (x0, x1) = (poly.iter().map(|q| q.0).min().unwrap() - reach, poly.iter().map(|q| q.0).max().unwrap() + reach);
    let (z0, z1) = (poly.iter().map(|q| q.1).min().unwrap() - reach, poly.iter().map(|q| q.1).max().unwrap() + reach);
    let n = poly.len();
    g.edges_in((x0, z0), (x1, z1)).into_iter().all(|e| {
        let (a, b) = (g.nodes[g.edges[e as usize].a as usize], g.nodes[g.edges[e as usize].b as usize]);
        let h = half(e);
        (0..n).all(|k| seg_dist2(poly[k], poly[(k + 1) % n], a, b) >= h * h)
    })
}

/// Is the door at the kerb of some road?
fn on_a_road(g: &Graph, door: P, half: impl Fn(u32) -> i64) -> bool {
    let reach = 1_000;
    g.edges_in((door.0 - reach, door.1 - reach), (door.0 + reach, door.1 + reach)).into_iter().any(|e| {
        let (a, b) = (g.nodes[g.edges[e as usize].a as usize], g.nodes[g.edges[e as usize].b as usize]);
        let r = half(e) + blocks::KERB_CM + 50;
        nearest_on(door, a, b).1 <= r * r
    })
}

/// The profile's sites: the plaza's at its centre; the slotted ones on the lots of
/// their district nearest the plaza (then any district's), `per_block` to a block,
/// standing back from the road on flat ground. A lot a site takes is no longer a lot.
fn sites(p: &Profile, t: &Terrain, blocks: &[Block], lots: &mut Vec<Lot>) -> Result<Vec<Site>, String> {
    let mut out = Vec::new();
    let mut taken: std::collections::BTreeMap<u32, i64> = std::collections::BTreeMap::new();
    for s in &p.sites {
        for n in 0..s.count {
            let (block, c, front) = match s.place {
                Place::Plaza { dx, dz } => (0, (blocks[0].x + dx, blocks[0].z + dz), (0, ONE)),
                Place::Slots { district: d, per_block } => {
                    let mut cand: Vec<(bool, i64, usize)> = lots
                        .iter()
                        .enumerate()
                        .filter(|(_, l)| *taken.get(&l.block).unwrap_or(&0) < per_block)
                        .map(|(k, l)| (l.district != d, l.x * l.x + l.z * l.z, k))
                        .collect();
                    cand.sort();
                    let found = cand.iter().find_map(|&(_, _, k)| fit(t, p, &lots[k], s.w_cm, s.d_cm).map(|c| (k, c)));
                    let (k, c) = found.ok_or_else(|| format!("site {}: no lot left for slot {n}", s.kind))?;
                    let l = lots.remove(k);
                    *taken.entry(l.block).or_insert(0) += 1;
                    let f = l.front.unwrap();
                    (l.block, c, (f[0], f[1]))
                }
            };
            let poly = rect(c, front, s.w_cm, s.d_cm);
            out.push(Site {
                id: format!("{}:{n}", s.kind), kind: s.kind, block, x: c.0, y: t.height_at(c.0, c.1), z: c.1, w: s.w_cm, d: s.d_cm,
                facing: if front.1 >= 0 { Facing::North } else { Facing::South },
                tier: Some(1), poly: Some(poly.iter().map(|q| [q.0, q.1]).collect()), front: Some([front.0, front.1]), view: None,
            });
        }
    }
    Ok(out)
}

/// A w x d rectangle centred on c, its front (a w side) facing the Q16 unit `front`: CCW.
pub(super) fn rect(c: P, front: P, w: i64, d: i64) -> Vec<P> {
    let along = left(front);
    let at = |s: i64, t: i64| (c.0 + (along.0 * s + front.0 * t) / ONE / 2, c.1 + (along.1 * s + front.1 * t) / ONE / 2);
    let r = vec![at(-w, -d), at(w, -d), at(w, d), at(-w, d)];
    if area2(&r) < 0 { r.into_iter().rev().collect() } else { r }
}

/// Where a w x d site stands on lot `l`: a metre back from its door, square to its
/// front, wholly inside it on flat ground. None if it does not fit.
pub(super) fn fit(t: &Terrain, p: &Profile, l: &Lot, w: i64, d: i64) -> Option<P> {
    let f = l.front?;
    let poly: Vec<P> = l.poly.as_ref()?.iter().map(|q| (q[0], q[1])).collect();
    let back = d / 2 + 100;
    let c = (l.door[0] - f[0] * back / ONE, l.door[2] - f[1] * back / ONE);
    let r = rect(c, (f[0], f[1]), w, d);
    (r.iter().all(|&q| inside(q, &poly)) && geom::rise(t, &r) <= p.site_flat_cm).then_some(c)
}

/// An HQ with both its wings (cm): the box a lot holds square behind its door to be
/// first choice for the pool, so a long thin or skewed lot still has room for the garage.
const HQ_BOX_CM: (i64, i64) = (2_800, 1_200);

/// The HQ pool: the profile's count of lots, from its HQ districts (then any) big
/// and flat enough, those that hold an HQ's box first, nearest the plaza first, ranked
/// and tiered in that order.
fn hq_pool(p: &Profile, t: &Terrain, lots: &mut [Lot]) -> Result<(), String> {
    let ok = |l: &Lot| {
        let poly: Vec<P> = l.poly.as_ref().unwrap().iter().map(|q| (q[0], q[1])).collect();
        area2(&poly) >= 2 * p.hq_min_m2 * 10_000 && geom::rise(t, &poly) <= p.site_flat_cm * 2
    };
    let roomy = |l: &Lot| {
        let (Some(f), Some(poly)) = (l.front, l.poly.as_ref()) else { return true };
        let poly: Vec<P> = poly.iter().map(|q| (q[0], q[1])).collect();
        let (w, d) = HQ_BOX_CM;
        let c = (l.door[0] - f[0] * (d / 2 + 100) / ONE, l.door[2] - f[1] * (d / 2 + 100) / ONE);
        rect(c, (f[0], f[1]), w, d).iter().all(|&q| inside(q, &poly))
    };
    // A personal island's one HQ is the owner's, next to the town hall on the plaza:
    // the nearest lot that holds it, whatever its district. The Commons' 64 prefer
    // their downtown and office districts, nearest first.
    let by_hall = p.hq_lots == 1;
    let mut cand: Vec<(bool, bool, i64, usize)> = lots
        .iter()
        .enumerate()
        .filter(|(_, l)| ok(l))
        .map(|(k, l)| (!by_hall && !p.hq_districts.contains(&l.district), !roomy(l), l.x * l.x + l.z * l.z, k))
        .collect();
    cand.sort();
    if (cand.len() as i64) < p.hq_lots {
        return Err(format!("profile {}: {} lots can hold an HQ, the pool needs {}", p.name, cand.len(), p.hq_lots));
    }
    let mut pool: Vec<(i64, usize)> = cand[..p.hq_lots as usize].iter().map(|&(_, _, d, k)| (d, k)).collect();
    pool.sort();
    for (rank, &(_, k)) in pool.iter().enumerate() {
        let l = &mut lots[k];
        l.kind = "hq";
        l.floors = 0;
        l.rank = Some(rank as u32);
        l.tier = Some(rank as u32 / p.hq_tier as u32);
    }
    Ok(())
}

/// What kind of place every 8 m of the world is: a block's district, a street, the
/// sea round an island, and outside the city, as version 1's countryside; the airport's
/// `claim` (City Gen v4) wild, its grounds cleared of trees.
fn district_map(seed: u64, p: &Profile, base: &Terrain, ctx: &Ctx, g: &Graph, blocks: &[Block], claim: Option<&super::claims::Airport>) -> Districts {
    let n = (p.size_cm / CELL_CM) as usize;
    let origin = -p.size_cm / 2;
    let ns = sub(seed, "districts-wild", 0, 0);
    let centre = |i: usize| origin + i as i64 * CELL_CM + CELL_CM / 2;
    let mut kinds = Vec::with_capacity(n * n);
    for iz in 0..n {
        for ix in 0..n {
            let (x, z) = (centre(ix), centre(iz));
            let h = base.height_at(x, z);
            let wild = value(ns, x, z, 25_600);
            kinds.push(if ctx.wet((x, z)) || ctx.river.is_some_and(|r| r.in_pool((x, z))) {
                district::WATER
            } else if claim.is_some_and(|a| a.contains((x, z))) {
                // City Gen v4: the airport's grounds are cleared (no trees on its claim)
                district::WILD
            } else if ctx.zoning.district((x, z)) == Some(district::PARK) {
                district::PARK
            } else if wild > 16_000 {
                district::WILD
            } else if h > 2_500 || wild > 4_000 {
                district::FOREST
            } else {
                district::FARMLAND
            });
        }
    }
    let cell = |v: i64| ((v - origin).div_euclid(CELL_CM)).clamp(0, n as i64 - 1) as usize;
    for e in g.edges.iter().filter(|e| e.alive) {
        for q in roads::resample(g.nodes[e.a as usize], g.nodes[e.b as usize]) {
            kinds[cell(q[2]) * n + cell(q[0])] = district::STREET;
        }
    }
    for b in blocks {
        let poly: Vec<P> = b.poly.as_ref().unwrap().iter().map(|q| (q[0], q[1])).collect();
        for iz in cell(b.z - b.d / 2)..=cell(b.z + b.d / 2) {
            for ix in cell(b.x - b.w / 2)..=cell(b.x + b.w / 2) {
                if inside((centre(ix), centre(iz)), &poly) {
                    kinds[iz * n + ix] = b.district;
                }
            }
        }
    }
    Districts { cell_cm: CELL_CM, origin_cm: origin, n, kinds, legend: p.legend.to_vec() }
}
