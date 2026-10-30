//! City Gen v5: the planned city written as the doc's layers, in their @3 shapes, so today's client draws @4.
//!
//! - roads: every arterial, street and link a polyline; split where two cross or one's end meets another's side,
//!   ends within `JOIN_CM` one node; then seated and carved on the terrain as @3's
//! - blocks and lots: one block per building, its lot the building's footprint (floors by its height)
//! - sites: the spawn and fountain on the plaza, Central, the airport (its footprint, its front the apron's side), the port
//! - metro and rail: the lines' paths and kinds, stations, entrances and their stair holes
use std::collections::{BTreeMap, BTreeSet};

use super::super::city::{Block, City as Doc, Facing, Lot, Runway, Site};
use super::super::noise::ONE;
use super::super::organic::geom::P;
use super::super::profile::district;
use super::super::roads::{Edge, Node, Roads};
use super::super::{districts, island, profile_for, Edit, metro as m3, railway as r3, transit, zones, Layers};
use super::landuse::Use;
use super::roads::Road;
use super::City;

/// Ends this close (cm) are one node; an end this close to another road's side joins it there.
pub const JOIN_CM: i64 = 1_500;
/// The spatial hash's cell (cm) for finding crossings.
const HASH_CM: i64 = 4_000;
/// A floor's height (cm).
const FLOOR_CM: i64 = 350;
/// A metro entrance's stair well: across, along (cm); the concourse under the street (cm).
const ENT_W_CM: i64 = 400;
const ENT_D_CM: i64 = 1_200;
const HALL_CM: i64 = 800;

fn q16(dx: f64, dz: f64) -> [i64; 2] {
    let l = dx.hypot(dz).max(1e-9);
    [(dx / l * ONE as f64).round() as i64, (dz / l * ONE as f64).round() as i64]
}

fn district_of(u: Use) -> u8 {
    match u {
        Use::Office => district::OFFICE,
        Use::Home => district::RESIDENTIAL,
        Use::Industry => district::INDUSTRIAL,
        Use::Park => district::PARK,
    }
}

/// The layers of world `seed` at generator version 4, with `edits` applied to its terrain.
pub fn layers(seed: &str, edits: &[Edit]) -> Result<Layers, String> {
    let c = City::plan(seed)?;
    let City { mut land, airport: ap, hub, port, rail, arterials, streets, landuse, metro, .. } = c;
    let p = profile_for(seed, 4);

    // the streets: the arterials first (their edges named avenues), then the local streets and links
    let all: Vec<&Road> = arterials.iter().chain(streets.iter()).collect();
    let mut roads = graph(&all);
    // where a road crosses the river: a bridge, straight and level from bank to bank (@3's)
    if let Some(r) = land.river.as_ref() {
        let edges = std::mem::take(&mut roads.edges);
        roads.edges = super::super::roads::bridged(&mut roads.nodes, &land.t, edges, r);
        for (k, e) in roads.edges.iter_mut().enumerate() {
            e.id = k as u32;
        }
    }
    // (an edge whose end the graph moved onto a neighbour's, now on the airport's box: dropped)
    {
        let a = super::airport::footprint(ap.c, ap.dir, ap.len, ap.side);
        let claim = |p: P, q: P, clear: i64| {
            let n = a.len();
            super::super::organic::geom::inside(p, &a) || super::super::organic::geom::inside(q, &a)
                || (0..n).any(|k| super::super::organic::geom::seg_dist2(p, q, a[k], a[(k + 1) % n]) < clear * clear)
        };
        roads.edges.retain(|e| !e.points.windows(2).any(|s| claim((s[0][0], s[0][2]), (s[1][0], s[1][2]), e.width / 2)));
        let used: BTreeSet<u32> = roads.edges.iter().flat_map(|e| [e.a, e.b]).collect();
        let map: BTreeMap<u32, u32> = used.iter().enumerate().map(|(k, &n)| (n, k as u32)).collect();
        roads.nodes = std::mem::take(&mut roads.nodes).into_iter().filter(|n| used.contains(&n.id)).map(|mut n| { n.id = map[&n.id]; n }).collect();
        for (k, e) in roads.edges.iter_mut().enumerate() {
            (e.id, e.a, e.b) = (k as u32, map[&e.a], map[&e.b]);
        }
    }

    // the buildings: a block and a lot each
    let mut doc = Doc { blocks: Vec::new(), lots: Vec::new(), sites: Vec::new() };
    for (k, b) in landuse.buildings.iter().enumerate() {
        let (x0, x1) = (b.poly.iter().map(|q| q.0).min().unwrap_or(b.c.0), b.poly.iter().map(|q| q.0).max().unwrap_or(b.c.0));
        let (z0, z1) = (b.poly.iter().map(|q| q.1).min().unwrap_or(b.c.1), b.poly.iter().map(|q| q.1).max().unwrap_or(b.c.1));
        let (w, dd) = (x1 - x0, z1 - z0);
        let poly: Vec<[i64; 2]> = b.poly.iter().map(|q| [q.0, q.1]).collect();
        let dist = district_of(b.use_);
        // the door on the side toward the nearest road
        let facing = if near_road(&roads, (b.c.0, z1)) <= near_road(&roads, (b.c.0, z0)) { Facing::North } else { Facing::South };
        let (dz, front) = if facing == Facing::North { (dd / 2, [0, ONE]) } else { (-dd / 2, [0, -ONE]) };
        doc.blocks.push(Block { id: k as u32, i: 0, j: 0, x: b.c.0, z: b.c.1, w, d: dd, district: dist, poly: Some(poly.clone()) });
        doc.lots.push(Lot {
            id: k as u32, block: k as u32, kind: "building", district: dist, x: b.c.0, z: b.c.1, w, d: dd, facing,
            door: [b.c.0, b.y, b.c.1 + dz], floors: (b.h / FLOOR_CM).max(1), rank: None, tier: None,
            poly: Some(poly), front: Some(front), grow: Some(k as u32), min_tier: None,
        });
    }

    // the sites
    let site = |id: &str, kind: &'static str, at: P, y: i64, w: i64, d: i64, poly: Option<Vec<[i64; 2]>>, front: [i64; 2]| Site {
        id: id.to_string(), kind, block: 0, x: at.0, y, z: at.1, w, d, facing: if front[1] >= 0 { Facing::North } else { Facing::South },
        tier: Some(1), poly, front: Some(front), view: None, runway: None,
    };
    let gy = |q: P| land.height(q);
    doc.sites.push(site("fountain:0", "fountain", hub, gy(hub), 900, 900, None, [0, ONE]));
    let spawn = (hub.0, hub.1 + 2_000);
    doc.sites.push(site("spawn:0", "spawn", spawn, gy(spawn), 200, 200, None, [0, ONE]));
    doc.sites.push(site("transit:0", "transit", (hub.0, hub.1 - 2_500), gy(hub), 2_000, 1_400, None, [0, ONE]));
    {
        // the airport: its x, z the terminal's middle (the client's airfield frame), its front out of the apron to the city
        let (dx, dz) = (ap.dir.0 as f64 / 1000.0, ap.dir.1 as f64 / 1000.0);
        let (nx, nz) = (-dz * ap.side as f64, dx * ap.side as f64);
        let out = super::airport::TERMINAL_CM as f64;
        let at = (ap.c.0 + (nx * out) as i64, ap.c.1 + (nz * out) as i64);
        // the site is the terminal (40 m deep along its front, 160 m across, world axes as @3's); the locked box is the
        // runway's `area`, the generator's alone
        let (w, d) = if nx.abs() > nz.abs() { (4_000, 16_000) } else { (16_000, 4_000) };
        let mut s = site("airport:0", "airport", at, ap.y, w, d, None, q16(nx, nz));
        let area: Vec<[i64; 2]> = ap.poly.iter().map(|q| [q.0, q.1]).collect();
        s.runway = Some(Runway { x: ap.c.0, z: ap.c.1, dir: q16(dx, dz), len: ap.len, side: ap.side, area });
        doc.sites.push(s);
    }
    if let Some((at, f)) = port {
        let fl = (f.0 as f64).hypot(f.1 as f64);
        let front = if fl > 0.0 && (fl - ONE as f64).abs() < ONE as f64 / 10.0 { [f.0, f.1] } else { q16((f.0 - at.0) as f64, (f.1 - at.1) as f64) };
        doc.sites.push(site("port:0", "port", at, gy(at), 3_000, 2_000, None, front));
    }

    // the HQ pool: the offices nearest Central first (an HQ is an office), then the homes; each one's lot grown to its
    // parcel (clear of the streets), its door out to the nearest local street, at least `hq::GAP_CM` from the next
    hq_pool(&p, &roads, hub, &mut doc.lots)?;

    let districts = districts_of(&land, &landuse.cells, hub);
    let zones = Some(zones::layer(land.seed, &doc.blocks));
    let mut tr = transit::generate(&roads, &doc.sites, &doc.lots, None, &[]);
    let isl = land.coast.as_ref().map(|co| island::grow(&p, co, &mut roads, &mut doc, &mut tr));

    let mut terrain = land.t.clone();
    terrain.apply(edits)?;
    roads.seat(&terrain, &p)?;
    roads.carve(&mut terrain, |q| land.river.as_ref().is_some_and(|r| r.wet(q)));
    let water = match (land.plan.take(), land.river.as_ref(), land.coast.as_ref()) {
        (Some(plan), Some(r), Some(co)) => Some(plan.finish(&p, &roads, &mut doc, r, co)),
        _ => None,
    };

    let metro = metro_layer(&metro, &land);
    let rail = rail_layer(&rail, &land, &ap);
    doc.seat(&terrain);
    Ok(Layers {
        terrain, districts, roads, blocks: doc.blocks, lots: doc.lots, sites: doc.sites, zones, transit: Some(tr), island: isl,
        river: land.river, water, metro: Some(metro), rail: Some(rail), gondola: None,
    })
}

/// The HQ lots (see `layers`).
fn hq_pool(p: &super::super::profile::Profile, roads: &Roads, hub: P, lots: &mut [Lot]) -> Result<(), String> {
    use super::super::organic::hq::{arterial, fits, Streets, GAP_CM, MIN_GAP_CM};
    let streets = Streets::new(roads);
    // the road points by 10 m cell, with the half width each keeps clear
    let mut near: BTreeMap<(i64, i64), Vec<(i64, i64, i64)>> = BTreeMap::new();
    for e in &roads.edges {
        for q in &e.points {
            near.entry((q[0].div_euclid(1_000), q[2].div_euclid(1_000))).or_default().push((q[0], q[2], e.width / 2 + 100));
        }
    }
    let clear = |q: P| {
        let (kx, kz) = (q.0.div_euclid(1_000), q.1.div_euclid(1_000));
        (kx - 2..=kx + 2).all(|x| (kz - 2..=kz + 2).all(|z| near.get(&(x, z)).is_none_or(|v| v.iter().all(|&(px, pz, hw)| (px - q.0).pow(2) + (pz - q.1).pow(2) > hw * hw))))
    };
    let hd = |l: &Lot| ((l.x - hub.0) as f64).hypot((l.z - hub.1) as f64) as i64;
    let mut order: Vec<usize> = (0..lots.len()).collect();
    order.sort_by_key(|&k| (lots[k].district != district::OFFICE, hd(&lots[k]), k));
    let mut chosen: Vec<P> = Vec::new();
    // (the gap steps down to `MIN_GAP_CM` when too few lots qualify, as @3's pool)
    for gap in [GAP_CM, 3_500, MIN_GAP_CM] {
    for &k in &order {
        if chosen.len() as i64 >= p.hq_lots {
            break;
        }
        let l = &lots[k];
        let c = (l.x, l.z);
        if l.kind == "hq" {
            continue;
        }
        // the parcel: out from the building each way, 1 m at a time, while clear of every street (to 30 m)
        let reach = |dx: i64, dz: i64, from: i64| (from..=3_000).step_by(100).take_while(|&r| clear((c.0 + dx * r, c.1 + dz * r))).last().unwrap_or(0);
        let (e, w, n, s) = (reach(1, 0, l.w / 2), reach(-1, 0, l.w / 2), reach(0, 1, l.d / 2), reach(0, -1, l.d / 2));
        if e < l.w / 2 || w < l.w / 2 || n < l.d / 2 || s < l.d / 2 {
            continue;
        }
        let poly = vec![[c.0 - w, c.1 - s], [c.0 + e, c.1 - s], [c.0 + e, c.1 + n], [c.0 - w, c.1 + n]];
        // the door on the side nearest a street, out to it
        let sides = [(e, [ONE, 0], [c.0 + e, c.1]), (w, [-ONE, 0], [c.0 - w, c.1]), (n, [0, ONE], [c.0, c.1 + n]), (s, [0, -ONE], [c.0, c.1 - s])];
        let mut best = None;
        for &(r, f, door) in &sides {
            if let Some((_, _, class)) = streets.fronted((door[0], door[1]), f) {
                if !arterial(class) && best.is_none_or(|b: (i64, [i64; 2], [i64; 2])| r < b.0) {
                    best = Some((r, f, door));
                }
            }
        }
        let Some((_, f, door)) = best else { continue };
        let mut hq = l.clone();
        (hq.x, hq.z, hq.w, hq.d) = ((2 * c.0 + e - w) / 2, (2 * c.1 + n - s) / 2, e + w, n + s);
        (hq.poly, hq.front, hq.door) = (Some(poly), Some(f), [door[0], l.door[1], door[1]]);
        hq.facing = if f[1] < 0 { Facing::South } else { Facing::North };
        (hq.kind, hq.floors, hq.rank, hq.tier) = ("hq", 0, Some(chosen.len() as u32), Some(chosen.len() as u32 / p.hq_tier.max(1) as u32));
        let at = (hq.x, hq.z);
        if !fits(&hq) || chosen.iter().any(|q| (q.0 - at.0).pow(2) + (q.1 - at.1).pow(2) < gap * gap) {
            continue;
        }
        chosen.push(at);
        lots[k] = hq;
    }
    }
    // (fewer than the profile's count is the validator's soft `hq-count`)
    Ok(())
}

/// The distance (cm) from `q` to the nearest edge point.
fn near_road(r: &Roads, q: P) -> i64 {
    r.edges.iter().flat_map(|e| e.points.iter()).map(|p| ((p[0] - q.0) as f64).hypot((p[2] - q.1) as f64) as i64).min().unwrap_or(i64::MAX)
}

/// The districts grid (`districts::CELL_CM`), from the land-use cells: the plaza round the hub, else the nearest cell's use.
fn districts_of(land: &super::land::Land, cells: &[(P, Use)], hub: P) -> districts::Districts {
    let cell = super::landuse::CELL_CM;
    let by: BTreeMap<(i64, i64), Use> = cells.iter().map(|&(q, u)| (((q.0 + cell / 2).div_euclid(cell), (q.1 + cell / 2).div_euclid(cell)), u)).collect();
    let n = (land.p.size_cm / districts::CELL_CM) as usize;
    let origin = -land.p.size_cm / 2;
    let mut kinds = Vec::with_capacity(n * n);
    for iz in 0..n {
        for ix in 0..n {
            let q = (origin + ix as i64 * districts::CELL_CM + districts::CELL_CM / 2, origin + iz as i64 * districts::CELL_CM + districts::CELL_CM / 2);
            let k = if ((q.0 - hub.0) as f64).hypot((q.1 - hub.1) as f64) < super::landuse::PLAZA_CM as f64 {
                district::PLAZA
            } else if !land.dry(q) {
                district::WILD
            } else {
                by.get(&((q.0 + cell / 2).div_euclid(cell), (q.1 + cell / 2).div_euclid(cell))).map_or(district::WILD, |&u| district_of(u))
            };
            kinds.push(k);
        }
    }
    districts::Districts { cell_cm: districts::CELL_CM, origin_cm: origin, n, kinds, legend: land.p.legend.to_vec() }
}

/// Where segment a-b meets c-d: the parameters along each, when they cross inside both.
fn cross(a: (f64, f64), b: (f64, f64), c: (f64, f64), d: (f64, f64)) -> Option<(f64, f64)> {
    let (r, s) = ((b.0 - a.0, b.1 - a.1), (d.0 - c.0, d.1 - c.1));
    let den = r.0 * s.1 - r.1 * s.0;
    if den.abs() < 1e-9 {
        return None;
    }
    let (qx, qz) = (c.0 - a.0, c.1 - a.1);
    let t = (qx * s.1 - qz * s.0) / den;
    let u = (qx * r.1 - qz * r.0) / den;
    // a crossing on a vertex counts once: on the segment it starts
    (t > -1e-9 && t < 1.0 - 1e-9 && u > -1e-9 && u < 1.0 - 1e-9).then_some((t, u))
}

/// The foot of `q` on segment a-b: its parameter and distance.
fn foot(q: (f64, f64), a: (f64, f64), b: (f64, f64)) -> (f64, f64) {
    let (dx, dz) = (b.0 - a.0, b.1 - a.1);
    let l2 = (dx * dx + dz * dz).max(1e-9);
    let t = (((q.0 - a.0) * dx + (q.1 - a.1) * dz) / l2).clamp(0.0, 1.0);
    let f = (a.0 + t * dx, a.1 + t * dz);
    (t, (f.0 - q.0).hypot(f.1 - q.1))
}

/// The road graph of the polylines: split at every crossing and wherever an end meets another's side.
pub fn graph(all: &[&Road]) -> Roads {
    let pts: Vec<Vec<(f64, f64)>> = all.iter().map(|r| r.points.iter().map(|q| (q[0] as f64, q[2] as f64)).collect()).collect();
    // the segments by hash cell
    let mut cells: BTreeMap<(i64, i64), Vec<(usize, usize)>> = BTreeMap::new();
    let key = |v: f64| (v as i64).div_euclid(HASH_CM);
    for (r, l) in pts.iter().enumerate() {
        for i in 0..l.len().saturating_sub(1) {
            let (a, b) = (l[i], l[i + 1]);
            for kx in key(a.0.min(b.0)) - 1..=key(a.0.max(b.0)) + 1 {
                for kz in key(a.1.min(b.1)) - 1..=key(a.1.max(b.1)) + 1 {
                    cells.entry((kx, kz)).or_default().push((r, i));
                }
            }
        }
    }
    // the cuts on each road: (segment + t, the point)
    let mut cuts: Vec<Vec<(f64, (f64, f64))>> = vec![Vec::new(); pts.len()];
    let mut seen: BTreeSet<(usize, usize, usize, usize)> = BTreeSet::new();
    for list in cells.values() {
        for (x, &(r1, i1)) in list.iter().enumerate() {
            for &(r2, i2) in &list[x + 1..] {
                if r1 == r2 && i1.abs_diff(i2) <= 1 {
                    continue;
                }
                let k = if (r1, i1) < (r2, i2) { (r1, i1, r2, i2) } else { (r2, i2, r1, i1) };
                if !seen.insert(k) {
                    continue;
                }
                let (a, b, c, d) = (pts[r1][i1], pts[r1][i1 + 1], pts[r2][i2], pts[r2][i2 + 1]);
                if let Some((t, _)) = cross(a, b, c, d) {
                    let q = (a.0 + t * (b.0 - a.0), a.1 + t * (b.1 - a.1));
                    let u = foot(q, c, d).0;
                    cuts[r1].push((i1 as f64 + t, q));
                    cuts[r2].push((i2 as f64 + u, q));
                }
            }
        }
    }
    // an end near another road's side: that road is cut at its foot, and the end moved onto it
    let mut ends: Vec<[(f64, f64); 2]> = pts.iter().map(|l| [l[0], *l.last().unwrap_or(&l[0])]).collect();
    for r in 0..pts.len() {
        for e in 0..2 {
            let q = ends[r][e];
            let mut best: Option<(f64, usize, f64)> = None;
            if let Some(list) = cells.get(&(key(q.0), key(q.1))) {
                for &(r2, i2) in list {
                    if r2 == r {
                        continue;
                    }
                    let (t, dd) = foot(q, pts[r2][i2], pts[r2][i2 + 1]);
                    if dd <= JOIN_CM as f64 && best.is_none_or(|b| dd < b.0) {
                        best = Some((dd, r2, i2 as f64 + t));
                    }
                }
            }
            if let Some((_, r2, s)) = best {
                let i = (s.floor() as usize).min(pts[r2].len() - 2);
                let t = s - i as f64;
                let (a, b) = (pts[r2][i], pts[r2][i + 1]);
                let f = (a.0 + t * (b.0 - a.0), a.1 + t * (b.1 - a.1));
                cuts[r2].push((s, f));
                ends[r][e] = f;
            }
        }
    }

    // the nodes: points within JOIN_CM are one
    let mut nodes: Vec<Node> = Vec::new();
    let mut at: BTreeMap<(i64, i64), Vec<u32>> = BTreeMap::new();
    let node = |nodes: &mut Vec<Node>, at: &mut BTreeMap<(i64, i64), Vec<u32>>, q: (f64, f64)| -> u32 {
        let (kx, kz) = (key(q.0), key(q.1));
        for x in kx - 1..=kx + 1 {
            for z in kz - 1..=kz + 1 {
                for &n in at.get(&(x, z)).map_or(&[][..], |v| v.as_slice()) {
                    let o = &nodes[n as usize];
                    if ((o.x as f64 - q.0).hypot(o.z as f64 - q.1)) <= JOIN_CM as f64 {
                        return n;
                    }
                }
            }
        }
        let id = nodes.len() as u32;
        nodes.push(Node { id, x: q.0.round() as i64, y: 0, z: q.1.round() as i64, junction: None, island: None });
        at.entry((kx, kz)).or_default().push(id);
        id
    };

    let mut edges: Vec<Edge> = Vec::new();
    let mut names = (0u32, 0u32);
    for (r, road) in all.iter().enumerate() {
        let l = &pts[r];
        if l.len() < 2 {
            continue;
        }
        let mut cs = cuts[r].clone();
        cs.push((0.0, ends[r][0]));
        cs.push(((l.len() - 1) as f64, ends[r][1]));
        cs.sort_by(|a, b| a.0.total_cmp(&b.0));
        cs.dedup_by(|b, a| (b.0 - a.0).abs() * 400.0 < 100.0);
        let art = road.class == "arterial";
        let name = if art {
            names.0 += 1;
            format!("{} Avenue", AVENUES[(names.0 as usize - 1) % AVENUES.len()])
        } else {
            names.1 += 1;
            format!("{} Street", STREETS[(names.1 as usize - 1) % STREETS.len()])
        };
        for w in cs.windows(2) {
            let ((s0, q0), (s1, q1)) = (w[0], w[1]);
            let mut line = vec![q0];
            for i in (s0.floor() as usize + 1)..=(s1.ceil() as usize).saturating_sub(1) {
                if (i as f64) > s0 + 1e-6 && (i as f64) < s1 - 1e-6 {
                    line.push(l[i]);
                }
            }
            line.push(q1);
            let len: f64 = line.windows(2).map(|v| (v[1].0 - v[0].0).hypot(v[1].1 - v[0].1)).sum();
            let (a, b) = (node(&mut nodes, &mut at, q0), node(&mut nodes, &mut at, q1));
            if a == b || len < 200.0 {
                continue;
            }
            let c = super::super::classes::class(if art { "avenue" } else { "local" }).expect("a class");
            let (width, walk) = (c.total_cm, c.side_cm);
            let mut points: Vec<[i64; 3]> = line.iter().map(|q| [q.0.round() as i64, 0, q.1.round() as i64]).collect();
            let (na, nb) = (&nodes[a as usize], &nodes[b as usize]);
            points[0] = [na.x, 0, na.z];
            let last = points.len() - 1;
            points[last] = [nb.x, 0, nb.z];
            edges.push(Edge {
                id: edges.len() as u32, a, b, class: if art { "arterial" } else { "local" }, width, walk, lanes: 1, route: None,
                name: name.clone(), points, min_tier: None, bridge: None, v4: None, median: None, oneway: None, under: None,
                tram: None, bed: None, lines: 0,
            }.classed(Some(if art { "avenue" } else { "local" })));
        }
    }
    // a street that runs on from an avenue's end (a node of just the two) is a collector: one class at a time
    let mut deg: BTreeMap<u32, Vec<usize>> = BTreeMap::new();
    for (k, e) in edges.iter().enumerate() {
        deg.entry(e.a).or_default().push(k);
        deg.entry(e.b).or_default().push(k);
    }
    let taper: Vec<usize> = deg.values().filter(|v| v.len() == 2).filter_map(|v| {
        let (x, y) = (&edges[v[0]], &edges[v[1]]);
        match (x.v4, y.v4) { (Some("avenue"), Some("local")) => Some(v[1]), (Some("local"), Some("avenue")) => Some(v[0]), _ => None }
    }).collect();
    let c = super::super::classes::class("collector").expect("a class");
    for k in taper {
        let e = edges[k].clone();
        edges[k] = Edge { width: c.total_cm, walk: c.side_cm, ..e }.classed(Some("collector"));
    }
    // (a node only a dropped piece ended at) out, the ids packed
    let used: BTreeSet<u32> = edges.iter().flat_map(|e| [e.a, e.b]).collect();
    let map: BTreeMap<u32, u32> = used.iter().enumerate().map(|(k, &n)| (n, k as u32)).collect();
    let nodes: Vec<Node> = nodes.into_iter().filter(|n| used.contains(&n.id)).map(|mut n| { n.id = map[&n.id]; n }).collect();
    for e in &mut edges {
        (e.a, e.b) = (map[&e.a], map[&e.b]);
    }
    Roads { nodes, edges }
}

const AVENUES: [&str; 12] = ["Harbour", "Airport", "Central", "Meridian", "Lantern", "Foundry", "Orchard", "Beacon", "Granite", "Willow", "Summit", "Tidewater"];
const STREETS: [&str; 16] = ["Ash", "Birch", "Cedar", "Elm", "Fern", "Hazel", "Juniper", "Laurel", "Maple", "Oak", "Pine", "Rowan", "Spruce", "Thorn", "Yew", "Alder"];

fn metro_layer(mt: &super::metro::Metro, land: &super::land::Land) -> m3::Metro {
    let mut out = m3::Metro { lines: Vec::new(), stations: Vec::new(), entrances: Vec::new(), portals: Vec::new(), depots: Vec::new(), holes: Vec::new() };
    let sid = |k: usize| format!("metro:{k}");
    for (k, s) in mt.stations.iter().enumerate() {
        let g = land.height(s.c);
        let mut ents = Vec::new();
        for e in &s.entrances {
            let n = out.entrances.len();
            let front = q16((s.c.0 - e.0) as f64, (s.c.1 - e.1) as f64);
            let (fx, fz) = (front[0] as f64 / ONE as f64, front[1] as f64 / ONE as f64);
            let (hw, hd) = (ENT_W_CM as f64 / 2.0, ENT_D_CM as f64 / 2.0);
            let hole: Vec<[i64; 2]> = [(-hw, -hd), (hw, -hd), (hw, hd), (-hw, hd)].iter()
                .map(|&(a, b)| [e.0 + (b * fx - a * fz) as i64, e.1 + (b * fz + a * fx) as i64]).collect();
            out.holes.push(hole.clone());
            out.entrances.push(m3::Entrance {
                id: format!("ent:{n}"), station: sid(k), x: e.0, z: e.1, y: land.height(*e), front, w: ENT_W_CM, d: ENT_D_CM, kind: "stairs", hole,
            });
            ents.push(format!("ent:{n}"));
        }
        out.stations.push(m3::Station {
            id: sid(k), x: s.c.0, y: s.rail_y.first().copied().unwrap_or(g - 2_000), z: s.c.1, along: q16(s.heading.cos(), s.heading.sin()),
            len: super::metro::PLATFORM_CM as i64, platform: "island", lines: s.lines.iter().map(|l| format!("M{}", l + 1)).collect(),
            hall_y: g - HALL_CM, entrances: ents,
        });
    }
    for l in &mt.lines {
        out.lines.push(m3::Line {
            id: format!("M{}", l.id + 1), stations: l.stations.iter().map(|&k| sid(k)).collect(), path: l.path.clone(),
            kinds: vec!["bored"; l.path.len().saturating_sub(1)], depot: None, tier: 1,
        });
    }
    out
}

fn rail_layer(lines: &[super::rail::Line], land: &super::land::Land, ap: &super::airport::Airport) -> r3::Rail {
    let mut out = r3::Rail { lines: Vec::new(), stations: Vec::new(), sea: None, holes: Vec::new() };
    for l in lines {
        let n = l.path.len();
        // per segment: a ramp is an embankment above the ground, a portal's trench below it
        let kinds: Vec<&'static str> = (0..n.saturating_sub(1)).map(|i| match l.kinds[i] {
            "ramp" => if l.path[i][1] >= land.height((l.path[i][0], l.path[i][2])) { "grade" } else { "portal" },
            k => k,
        }).collect();
        let mut ids = Vec::new();
        for s in &l.stations {
            let i = (0..n).min_by_key(|&i| (l.path[i][0] - s.0).pow(2) + (l.path[i][2] - s.1).pow(2)).unwrap_or(0);
            let (a, b) = (l.path[i.saturating_sub(1)], l.path[(i + 1).min(n - 1)]);
            let along = q16((b[0] - a[0]) as f64, (b[2] - a[2]) as f64);
            let y = l.path[i][1];
            let g = land.height(*s);
            let terminal = super::super::organic::geom::inside(*s, &ap.poly);
            let kind = if terminal { "terminal" } else if y > g { "elevated" } else { "underground" };
            let (px, pz) = (-along[1] * 800 / ONE, along[0] * 800 / ONE);
            let stairs = if kind == "elevated" { vec![[s.0 + px, s.1 + pz], [s.0 - px, s.1 - pz]] } else { vec![[s.0, s.1]] };
            let id = format!("rail:{}", out.stations.len());
            out.stations.push(r3::Station {
                id: id.clone(), kind, x: s.0, y, z: s.1, along, len: super::rail::PLATFORM_CM as i64, platforms: 2, lines: vec![l.id.to_string()], stairs,
            });
            ids.push(id);
        }
        if let Some((q, f)) = l.sea {
            out.sea = Some(r3::Sea { x: q.0, z: q.1, y: l.path.last().map_or(0, |p| p[1]), front: q16(f.0, f.1) });
        }
        out.lines.push(r3::Line {
            id: l.id.to_string(), kind: if l.sea.is_some() { "island" } else { "city" }, stations: ids, path: l.path.clone(), kinds, tier: 1, piers: Vec::new(),
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn road(class: &'static str, pts: &[(i64, i64)]) -> Road {
        Road { class, from: 0, to: 0, points: pts.iter().map(|q| [q.0, 0, q.1]).collect(), min_r: f64::INFINITY, fallback: false }
    }

    #[test]
    fn a_crossing_and_a_t_are_junctions() {
        let a = road("arterial", &[(-10_000, 0), (10_000, 0)]);
        let b = road("local", &[(0, -10_000), (0, 10_000)]);
        // ends 10 m short of the arterial: joins it
        let c = road("local", &[(5_000, 8_000), (5_000, 1_000)]);
        let r = graph(&[&a, &b, &c]);
        assert_eq!(r.edges.len(), 3 + 2 + 1, "the arterial in three, the crossing street in two, the T one");
        let deg = |x: i64, z: i64| {
            let n = r.nodes.iter().position(|n| (n.x - x).abs() < 50 && (n.z - z).abs() < 50).expect("a node there") as u32;
            r.edges.iter().filter(|e| e.a == n || e.b == n).count()
        };
        assert_eq!(deg(0, 0), 4);
        assert_eq!(deg(5_000, 0), 3);
    }
}
