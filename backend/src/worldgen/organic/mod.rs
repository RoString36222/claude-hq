//! The organic city (world version 2: the Commons and the personal islands).
//!
//!   zoning (district seeds round the plaza, each with a character)
//!     -> arterials traced through a tensor field (radial, the districts' grids,
//!        the slope of the land, the coast), then local streets grown off them
//!        L-system style, every district in its own way (streets.rs)
//!     -> the network pruned: no road steeper than the city's grade, one network
//!     -> blocks: the faces of the planar road graph, inset to the kerbs (blocks.rs)
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
pub mod zoning;

#[cfg(test)]
mod tests;

use super::city::{Block, City, Facing, Lot, Site};
use super::districts::{Districts, CELL_CM};
use super::noise::{isqrt, value, ONE};
use super::profile::{district, Place, Profile};
use super::rng::{sub, Rng};
use super::roads::{self, Edge, Node, Roads};
use super::terrain::Terrain;
use geom::{area2, centroid, dist2, inside, left, nearest_on, seg_dist2, P};
use graph::{Graph, Kind};
use streets::{Ctx, Street};
use zoning::{character, Zoning};

/// Generate the city, its roads and the district map.
pub fn generate(seed: u64, p: &Profile, base: &Terrain) -> Result<(City, Roads, Districts), String> {
    let zoning = Zoning::new(seed, p);
    let field = tensor::Field { terrain: base, grids: zoning.grids(), radial_r: p.city_r_cm * 6 / 10, coast_r: p.coast_r_cm };
    let ctx = Ctx { p, t: base, field, zoning: &zoning };

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
    let chains = streets::arterials(&mut g, &ctx, &mut grow, &mut streets, art_names)?;
    streets::locals(&mut g, &ctx, &mut grow, &chains, &mut streets, local_names);
    prune(&mut g, p, base);

    let width = |k: Kind| if k == Kind::Arterial { p.avenue_cm } else { p.road_cm };
    let half = |e: u32| width(g.edges[e as usize].kind) / 2;

    // blocks, the plaza first, then nearest it first
    let faces = blocks::blocks(&g, half);
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
    }

    // lots: every block of a district that builds, split to its lot size; a lot must
    // be clear of every road, outside the block's holes, with its door on a road
    let mut lots: Vec<Lot> = Vec::new();
    for (b, hs) in blocks.iter().zip(&holes) {
        let ch = character(b.district);
        if !ch.grows || b.district == district::PLAZA {
            continue;
        }
        let poly: Vec<P> = b.poly.as_ref().unwrap().iter().map(|q| (q[0], q[1])).collect();
        let mut rng = Rng::new(sub(seed, "lots", b.id as i64, 0));
        for cut in lots::split(&poly, ch.lot_m2 * 10_000, &mut rng) {
            let c = centroid(&cut.poly);
            if hs.iter().any(|h| inside(c, h)) || !clear_of_roads(&g, &cut.poly, half) || !on_a_road(&g, cut.door, half) {
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

    let sites = sites(p, base, &blocks, &mut lots)?;
    hq_pool(p, base, &mut lots)?;
    let mut by_core: Vec<(i64, usize)> = lots.iter().enumerate().map(|(k, l)| (l.x * l.x + l.z * l.z, k)).collect();
    by_core.sort();
    for (rank, &(_, k)) in by_core.iter().enumerate() {
        lots[k].grow = Some(rank as u32);
    }
    for (k, l) in lots.iter_mut().enumerate() {
        l.id = k as u32;
    }

    // the road graph as the world's roads (live nodes only), then the graded roads
    let mut renum = vec![u32::MAX; g.nodes.len()];
    let mut nodes = Vec::new();
    for (k, &(x, z)) in g.nodes.iter().enumerate() {
        if !g.adj[k].is_empty() {
            renum[k] = nodes.len() as u32;
            nodes.push(Node { id: nodes.len() as u32, x, y: base.height_at(x, z), z });
        }
    }
    let mut edges: Vec<Edge> = g
        .edges
        .iter()
        .filter(|e| e.alive)
        .map(|e| {
            let (class, walk) = if e.kind == Kind::Arterial { ("arterial", p.avenue_walk_cm) } else { ("local", p.street_walk_cm) };
            let Street { name, .. } = &streets[e.road as usize];
            Edge {
                id: 0, a: renum[e.a as usize], b: renum[e.b as usize], class, width: width(e.kind), walk, lanes: 1, route: None,
                name: name.clone(), points: roads::resample(g.nodes[e.a as usize], g.nodes[e.b as usize]), min_tier: None,
            }
        })
        .collect();
    roads::graded(&mut rng, p, base, &blocks, &mut nodes, &mut edges, &mut ways.iter().copied())?;
    let roads = Roads { nodes, edges };

    let districts = district_map(seed, p, base, &ctx, &g, &blocks);
    Ok((City { blocks, lots, sites }, roads, districts))
}

/// Drop every road steeper than the city's grade (measured as the world will be:
/// the ground under each 8 m step), then every road the plaza cannot reach.
fn prune(g: &mut Graph, p: &Profile, t: &Terrain) {
    for k in 0..g.edges.len() {
        let e = &g.edges[k];
        if !e.alive {
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
    // node 0 is on the plaza's ring
    let mut seen = vec![false; g.nodes.len()];
    let mut stack = vec![0u32];
    seen[0] = true;
    while let Some(n) = stack.pop() {
        for &e in &g.adj[n as usize] {
            let m = g.other(e, n);
            if !seen[m as usize] {
                seen[m as usize] = true;
                stack.push(m);
            }
        }
    }
    for k in 0..g.edges.len() {
        if g.edges[k].alive && !seen[g.edges[k].a as usize] {
            g.kill(k as u32);
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
                tier: Some(1), poly: Some(poly.iter().map(|q| [q.0, q.1]).collect()), front: Some([front.0, front.1]),
            });
        }
    }
    Ok(out)
}

/// A w x d rectangle centred on c, its front (a w side) facing the Q16 unit `front`: CCW.
fn rect(c: P, front: P, w: i64, d: i64) -> Vec<P> {
    let along = left(front);
    let at = |s: i64, t: i64| (c.0 + (along.0 * s + front.0 * t) / ONE / 2, c.1 + (along.1 * s + front.1 * t) / ONE / 2);
    let r = vec![at(-w, -d), at(w, -d), at(w, d), at(-w, d)];
    if area2(&r) < 0 { r.into_iter().rev().collect() } else { r }
}

/// Where a w x d site stands on lot `l`: a metre back from its door, square to its
/// front, wholly inside it on flat ground. None if it does not fit.
fn fit(t: &Terrain, p: &Profile, l: &Lot, w: i64, d: i64) -> Option<P> {
    let f = l.front?;
    let poly: Vec<P> = l.poly.as_ref()?.iter().map(|q| (q[0], q[1])).collect();
    let back = d / 2 + 100;
    let c = (l.door[0] - f[0] * back / ONE, l.door[2] - f[1] * back / ONE);
    let r = rect(c, (f[0], f[1]), w, d);
    (r.iter().all(|&q| inside(q, &poly)) && geom::rise(t, &r) <= p.site_flat_cm).then_some(c)
}

/// The HQ pool: the profile's count of lots, from its HQ districts (then any) big
/// and flat enough, nearest the plaza first, ranked and tiered in that order.
fn hq_pool(p: &Profile, t: &Terrain, lots: &mut [Lot]) -> Result<(), String> {
    let ok = |l: &Lot| {
        let poly: Vec<P> = l.poly.as_ref().unwrap().iter().map(|q| (q[0], q[1])).collect();
        area2(&poly) >= 2 * p.hq_min_m2 * 10_000 && geom::rise(t, &poly) <= p.site_flat_cm * 2
    };
    let mut cand: Vec<(bool, i64, usize)> =
        lots.iter().enumerate().filter(|(_, l)| ok(l)).map(|(k, l)| (!p.hq_districts.contains(&l.district), l.x * l.x + l.z * l.z, k)).collect();
    cand.sort();
    if (cand.len() as i64) < p.hq_lots {
        return Err(format!("profile {}: {} lots can hold an HQ, the pool needs {}", p.name, cand.len(), p.hq_lots));
    }
    let mut pool: Vec<(i64, usize)> = cand[..p.hq_lots as usize].iter().map(|&(_, d, k)| (d, k)).collect();
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
/// sea round an island, and outside the city, as version 1's countryside.
fn district_map(seed: u64, p: &Profile, base: &Terrain, ctx: &Ctx, g: &Graph, blocks: &[Block]) -> Districts {
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
            kinds.push(if ctx.wet((x, z)) {
                district::WATER
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
