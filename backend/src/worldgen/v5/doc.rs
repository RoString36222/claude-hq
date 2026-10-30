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
/// A metro entrance's stair well: across, along (cm).
const ENT_W_CM: i64 = 400;
const ENT_D_CM: i64 = 1_200;

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

    // the streets: the arterials first (their edges named avenues), then the local streets and links, and the port's
    // drive from its land side's door to the nearest of them
    let mut all: Vec<&Road> = arterials.iter().chain(streets.iter()).collect();
    let drive = port.and_then(|(at, f)| port_drive(&all, &landuse.buildings, at, port_front(at, f)));
    all.extend(drive.iter());
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
        let a = ap.poly.clone();
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
    // the terminal's road: from the street end at its landside to where the airfield's access road starts (hqairfield.js),
    // so the way to the curb is road all along
    let (tat, tn) = terminal(&ap);
    terminal_road(&mut roads, super::airport::landside(ap.c, ap.dir, ap.side), frame_pt(tat, tn, ACCESS_UV.0, ACCESS_UV.1));

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
    let spawn = (hub.0, hub.1 + 2_000);
    let transit_at = (hub.0, hub.1 - 2_500);
    // the fountain on the plaza beside the hub's junction (the hub is where the avenues meet), its door on a sidewalk
    let keep = [(spawn, 200, 200), (transit_at, 2_000, 1_400)];
    let (fq, ff) = fountain_at(&roads, hub, &keep, &doc.lots).unwrap_or((hub, [0, ONE]));
    doc.sites.push(site("fountain:0", "fountain", fq, gy(fq), FOUNTAIN_CM, FOUNTAIN_CM, None, ff));
    doc.sites.push(site("spawn:0", "spawn", spawn, gy(spawn), 200, 200, None, [0, ONE]));
    doc.sites.push(site("transit:0", "transit", transit_at, gy(hub), 2_000, 1_400, None, [0, ONE]));
    {
        // the airport: its x, z the terminal's middle (the client's airfield frame), its front out of the apron to the city
        let (dx, dz) = (ap.dir.0 as f64 / 1000.0, ap.dir.1 as f64 / 1000.0);
        let ((nx, nz), at) = (tn, tat);
        // the site is the terminal (40 m across, 160 m deep along its front: hqcivic.js AIRPORT_HALL's 40 x 160 frame,
        // hqairfield.js's hall at u -66..66), w/d world axes as @3's; the locked box is the runway's `area`, the
        // generator's alone
        let (w, d) = if nx.abs() > nz.abs() { (16_000, 4_000) } else { (4_000, 16_000) };
        let mut s = site("airport:0", "airport", at, ap.y, w, d, None, q16(nx, nz));
        let area: Vec<[i64; 2]> = ap.poly.iter().map(|q| [q.0, q.1]).collect();
        s.runway = Some(Runway { x: ap.c.0, z: ap.c.1, dir: q16(dx, dz), len: ap.len, side: ap.side, area });
        doc.sites.push(s);
    }
    if let Some((at, f)) = port {
        doc.sites.push(site("port:0", "port", at, gy(at), PORT_W_CM, PORT_D_CM, None, port_front(at, f)));
    }

    // the HQ pool: the blocks nearest Central first (offices, then homes), each laid out in equal HQ lots along its
    // streets (New York's), every lot's door out to a local street
    hq_pool(&p, &roads, hub, &doc.sites, &landuse.buildings, &landuse.frames, &mut doc.lots)?;

    let districts = districts_of(&land, &landuse.cells, hub);
    let zones = Some(zones::layer(land.seed, &doc.blocks));
    let mut tr = transit::generate(&roads, &doc.sites, &doc.lots, None, &[]);
    let isl = land.coast.as_ref().map(|co| island::grow(&p, co, &mut roads, &mut doc, &mut tr));

    let mut terrain = land.t.clone();
    grade_airport(&mut terrain, &land, &ap);
    grade_terminal(&mut terrain, tat, tn);
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

/// Where the terminal's road meets the airfield's access road, in the terminal's frame (m: u out of the city toward the
/// runway, v across): hqairfield.js `landside.access` starts here on a planned airport, a local road's half width and a
/// little more short of the box (u -146, the validator's `airport` rule).
const ACCESS_UV: (f64, f64) = (-152.0, -8.0);
/// The terminal's landside graded level (frame m): flat over the hall, its curb, forecourt and car park
/// (u `GRADE_U`, |v| <= `GRADE_V`), easing back to the land over `GRADE_EASE` toward the city and the sides and
/// `GRADE_BACK` behind the hall (short of the airside platform at u 76, which takes its own level).
const GRADE_U: (f64, f64) = (-116.0, 66.0);
const GRADE_V: f64 = 90.0;
const GRADE_EASE: f64 = 30.0;
const GRADE_BACK: f64 = 10.0;

/// The terminal's middle (cm) and its front (unit: out of the apron toward the city), as the airport site's x, z, front.
fn terminal(ap: &super::airport::Airport) -> (P, (f64, f64)) {
    let (dx, dz) = (ap.dir.0 as f64 / 1000.0, ap.dir.1 as f64 / 1000.0);
    let (nx, nz) = (-dz * ap.side as f64, dx * ap.side as f64);
    let out = super::airport::TERMINAL_CM as f64;
    ((ap.c.0 + (nx * out) as i64, ap.c.1 + (nz * out) as i64), (nx, nz))
}

/// The point (cm) at frame (u, v) m of the terminal at `o` with front `n` (hqairfield.js: B = -front, T = [B.z, -B.x]).
fn frame_pt(o: P, n: (f64, f64), u: f64, v: f64) -> P {
    let (bx, bz) = (-n.0, -n.1);
    (o.0 + ((u * bx + v * bz) * 100.0).round() as i64, o.1 + ((u * bz - v * bx) * 100.0).round() as i64)
}

/// The terminal's landside graded flat to the ground's height at its middle (the site's y, `City::seat`): the hall
/// stands on it, the curb and forecourt (drawn on the ground) are level with its door (all inside the airport's box).
fn grade_terminal(t: &mut super::super::terrain::Terrain, o: P, n: (f64, f64)) {
    let y = t.height_at(o.0, o.1) as f64;
    let (bx, bz) = (-n.0, -n.1);
    let ease = |d: f64, m: f64| { let k = (1.0 - d / m).clamp(0.0, 1.0); k * k * (3.0 - 2.0 * k) };
    for iz in 0..t.n {
        for ix in 0..t.n {
            let (x, z) = t.vertex_pos(ix, iz);
            let (dx, dz) = ((x - o.0) as f64 / 100.0, (z - o.1) as f64 / 100.0);
            let (u, v) = (dx * bx + dz * bz, dx * bz - dz * bx);
            let du = if u < GRADE_U.0 { (GRADE_U.0 - u, GRADE_EASE) } else { ((u - GRADE_U.1).max(0.0), GRADE_BACK) };
            let w = ease(du.0, du.1) * ease((v.abs() - GRADE_V).max(0.0), GRADE_EASE);
            if w > 0.0 {
                let h = &mut t.heights[iz * t.n + ix];
                *h = (*h as f64 + (y - *h as f64) * w).round() as i32;
            }
        }
    }
}

/// The airport's footprint graded to its level (the site's y) on the island, easing back to the land over
/// `GRADE_EASE` round it: a runway on land stands on its own flat platform, cut into the hills and filled over the
/// dips (the sea under a pier stays as it is).
fn grade_airport(t: &mut super::super::terrain::Terrain, land: &super::land::Land, ap: &super::airport::Airport) {
    use super::super::organic::geom::{inside, seg_dist2};
    let y = ap.y as f64;
    let m = (GRADE_EASE * 100.0) as i64;
    let (x0, x1, z0, z1) = ap.poly.iter().fold((i64::MAX, i64::MIN, i64::MAX, i64::MIN), |b, q| (b.0.min(q.0), b.1.max(q.0), b.2.min(q.1), b.3.max(q.1)));
    let n = ap.poly.len();
    for iz in 0..t.n {
        for ix in 0..t.n {
            let q = t.vertex_pos(ix, iz);
            if q.0 < x0 - m || q.0 > x1 + m || q.1 < z0 - m || q.1 > z1 + m || !land.coast.as_ref().is_none_or(|c| inside(q, &c.poly)) {
                continue;
            }
            let d = if inside(q, &ap.poly) { 0.0 } else { ((0..n).map(|e| seg_dist2(ap.poly[e], ap.poly[(e + 1) % n], q, q)).min().unwrap_or(i64::MAX) as f64).sqrt() / 100.0 };
            let k = (1.0 - d / GRADE_EASE).clamp(0.0, 1.0);
            let w = k * k * (3.0 - 2.0 * k);
            if w > 0.0 {
                let h = &mut t.heights[iz * t.n + ix];
                *h = (*h as f64 + (y - *h as f64) * w).round() as i32;
            }
        }
    }
}

/// A local road from the node nearest `from` (within 60 m: the street end at the terminal's landside) to `to`; not from
/// the dead end of a road more than one class above it (an avenue would run on as a local: the validator's class-step).
fn terminal_road(roads: &mut Roads, from: P, to: P) {
    let d = |n: &Node| ((n.x - from.0) as f64).hypot((n.z - from.1) as f64);
    let ok = |n: &Node| {
        let mut es = roads.edges.iter().filter(|e| e.a == n.id || e.b == n.id);
        match (es.next(), es.next()) {
            (Some(e), None) => super::super::classes::one_step(e.v4.unwrap_or(e.class), "local"),
            _ => true,
        }
    };
    let Some(a) = roads.nodes.iter().filter(|n| d(n) <= 6_000.0 && ok(n)).min_by(|p, q| d(p).total_cmp(&d(q))).map(|n| n.id) else { return };
    let (ax, az) = (roads.nodes[a as usize].x, roads.nodes[a as usize].z);
    let len = ((to.0 - ax) as f64).hypot((to.1 - az) as f64);
    if len < 500.0 {
        return;
    }
    let b = roads.nodes.len() as u32;
    roads.nodes.push(Node { id: b, x: to.0, y: 0, z: to.1, junction: None, island: None });
    let m = (len / 400.0).ceil() as i64;
    let points: Vec<[i64; 3]> = (0..=m).map(|i| [ax + (to.0 - ax) * i / m, 0, az + (to.1 - az) * i / m]).collect();
    let c = super::super::classes::class("local").expect("a class");
    roads.edges.push(Edge {
        id: roads.edges.len() as u32, a, b, class: "local", width: c.total_cm, walk: c.side_cm, lanes: 1, route: None,
        name: "Terminal Road".to_string(), points, min_tier: None, bridge: None, v4: None, median: None, oneway: None, under: None,
        tram: None, bed: None, lines: 0,
    }.classed(Some("local")));
}

/// The fountain's site (cm a side) and the port's (w, d: world axes).
const FOUNTAIN_CM: i64 = 900;
const PORT_W_CM: i64 = 3_000;
const PORT_D_CM: i64 = 2_000;
/// A site's door stands this far out past its edge (cm: hqnav.js DOOR_OUT).
const DOOR_OUT_CM: f64 = 200.0;

/// The port's front: its Q16 unit, or toward the point it was given.
fn port_front(at: P, f: P) -> [i64; 2] {
    let fl = (f.0 as f64).hypot(f.1 as f64);
    if fl > 0.0 && (fl - ONE as f64).abs() < ONE as f64 / 10.0 { [f.0, f.1] } else { q16((f.0 - at.0) as f64, (f.1 - at.1) as f64) }
}

/// Where hqnav.js puts a site's door (cm): out from `at` along `dir` (unit) past the site's w x d box (world axes) by
/// `DOOR_OUT_CM`.
fn door_of(at: P, dir: (f64, f64), w: i64, d: i64) -> (f64, f64) {
    let r = dir.0.abs() * w as f64 / 2.0 + dir.1.abs() * d as f64 / 2.0 + DOOR_OUT_CM;
    (at.0 as f64 + dir.0 * r, at.1 as f64 + dir.1 * r)
}

/// The port's drive: a local street from the nearest street (within 60 m) to its land side's door (the door at its end,
/// on the sidewalk round its end), none when the door is already on one or a building stands in the way.
fn port_drive(all: &[&Road], buildings: &[super::landuse::Building], at: P, front: [i64; 2]) -> Option<Road> {
    let back = (-front[0] as f64 / ONE as f64, -front[1] as f64 / ONE as f64);
    let door = door_of(at, back, PORT_W_CM, PORT_D_CM);
    let c = super::super::classes::class("local")?;
    // the nearest centre line point: (distance, foot, the road's half width)
    let mut best: Option<(f64, (f64, f64), f64)> = None;
    for r in all {
        let hw = super::super::classes::class(if r.class == "arterial" { "avenue" } else { "local" }).map_or(0, |k| k.total_cm) as f64 / 2.0;
        for s in r.points.windows(2) {
            let (t, dd) = foot(door, (s[0][0] as f64, s[0][2] as f64), (s[1][0] as f64, s[1][2] as f64));
            let f = (s[0][0] as f64 + t * (s[1][0] - s[0][0]) as f64, s[0][2] as f64 + t * (s[1][2] - s[0][2]) as f64);
            if best.is_none_or(|b| dd < b.0) {
                best = Some((dd, f, hw));
            }
        }
    }
    let (dd, f, hw) = best?;
    if dd > 6_000.0 || dd <= hw {
        return None;
    }
    // the street's end short of the door by the end's carriageway and half its sidewalk
    let (ux, uz) = ((door.0 - f.0) / dd, (door.1 - f.1) / dd);
    let back_cm = c.total_cm as f64 / 2.0 - c.side_cm as f64 / 2.0;
    let len = dd - back_cm;
    if len < 1_000.0 {
        return None;
    }
    let m = (len / 400.0).ceil() as i64;
    let points: Vec<[i64; 3]> = (0..=m).map(|i| {
        let k = len * i as f64 / m as f64;
        [(f.0 + ux * k).round() as i64, 0, (f.1 + uz * k).round() as i64]
    }).collect();
    let clear = c.total_cm / 2 + 100;
    let (a, b) = ((points[0][0], points[0][2]), (points[m as usize][0], points[m as usize][2]));
    if buildings.iter().any(|bd| {
        let n = bd.poly.len();
        super::super::organic::geom::inside(a, &bd.poly) || super::super::organic::geom::inside(b, &bd.poly)
            || (0..n).any(|k| super::super::organic::geom::seg_dist2(a, b, bd.poly[k], bd.poly[(k + 1) % n]) < clear * clear)
    }) {
        return None;
    }
    Some(Road { class: "local", from: 0, to: 0, points, min_r: f64::INFINITY, fallback: false })
}

/// The fountain on the plaza: the spot nearest the hub (within 60 m) facing a road, its door (`door_of`) mid-sidewalk
/// on it, its basin clear of every road's sidewalk and of the `keep` sites (centre, w, d) and the lots; with its front
/// (Q16, toward that road). None when no spot fits.
fn fountain_at(roads: &Roads, hub: P, keep: &[(P, i64, i64)], lots: &[Lot]) -> Option<(P, [i64; 2])> {
    let segs: Vec<((f64, f64), (f64, f64), f64, f64)> = roads.edges.iter().flat_map(|e| e.points.windows(2).map(move |s| {
        ((s[0][0] as f64, s[0][2] as f64), (s[1][0] as f64, s[1][2] as f64), e.width as f64 / 2.0, e.walk as f64)
    })).filter(|s| foot((hub.0 as f64, hub.1 as f64), s.0, s.1).1 < 12_000.0).collect();
    let half = FOUNTAIN_CM as f64 / 2.0;
    let mut best: Option<(f64, P, [i64; 2])> = None;
    for &(a, b, hw, walk) in &segs {
        let l = (b.0 - a.0).hypot(b.1 - a.1);
        if l < 1.0 {
            continue;
        }
        let (dx, dz) = ((b.0 - a.0) / l, (b.1 - a.1) / l);
        for side in [-1.0, 1.0] {
            // facing the road: the front is -normal; the door that far out lands mid-sidewalk
            let (nx, nz) = (-dz * side, dx * side);
            let reach = (nx.abs() + nz.abs()) * half + DOOR_OUT_CM;
            let off = hw - walk / 2.0 + reach;
            let mut t = 0.0;
            while t <= l {
                let q = (a.0 + dx * t + nx * off, a.1 + dz * t + nz * off);
                t += 200.0;
                let qi = (q.0.round() as i64, q.1.round() as i64);
                let dh = ((qi.0 - hub.0) as f64).hypot((qi.1 - hub.1) as f64);
                if dh > 6_000.0 || best.is_some_and(|bb| bb.0 <= dh) {
                    continue;
                }
                let free = segs.iter().all(|&(c, d, w2, _)| foot(q, c, d).1 >= w2 + half + 40.0)
                    && keep.iter().all(|&(k, w, d)| (qi.0 - k.0).abs() * 2 > w + FOUNTAIN_CM + 200 || (qi.1 - k.1).abs() * 2 > d + FOUNTAIN_CM + 200)
                    && lots.iter().all(|lt| (qi.0 - lt.x).abs() * 2 > lt.w + FOUNTAIN_CM + 200 || (qi.1 - lt.z).abs() * 2 > lt.d + FOUNTAIN_CM + 200);
                if free {
                    best = Some((dh, qi, q16(-nx, -nz)));
                }
            }
        }
    }
    best.map(|b| (b.1, b.2))
}

/// Every HQ lot's size (cm), the same for every HQ (no one's lot is bigger than another's: the building on it grows
/// with its owner's level, the lot does not): its frontage along its street and its depth back from it.
pub const HQ_LOT_W: i64 = 3_600;
pub const HQ_LOT_D: i64 = 3_400;

/// How far (cm) an HQ lot stays out past a road's half width (its kerb and a hair: no pad over a pavement's edge).
const LOT_ROAD_CM: i64 = 50;

/// Do two convex polygons overlap (more than touching, within 2 cm)?
fn convex_overlap(a: &[P], b: &[P]) -> bool {
    for poly in [a, b] {
        let n = poly.len();
        for k in 0..n {
            let (p, q) = (poly[k], poly[(k + 1) % n]);
            let (nx, nz) = ((q.1 - p.1) as f64, -(q.0 - p.0) as f64);
            let l = nx.hypot(nz);
            if l < 1.0 {
                continue;
            }
            let span = |s: &[P]| s.iter().fold((f64::MAX, f64::MIN), |m, v| { let t = (v.0 as f64 * nx + v.1 as f64 * nz) / l; (m.0.min(t), m.1.max(t)) });
            let (sa, sb) = (span(a), span(b));
            if sa.1 <= sb.0 + 2.0 || sb.1 <= sa.0 + 2.0 {
                return false;
            }
        }
    }
    true
}

/// The HQ lots (see `layers`), New York style: the blocks nearest Central first (the offices, then the homes, then the
/// sheds), each block (landuse.rs `Frame`: between its street centre lines, its buildings `FRONT_CM` in from them)
/// laid out in equal `HQ_LOT_W` x `HQ_LOT_D` lots side by side along its long frontage, turned to the block's frame, a
/// row on each long side where the block is deep enough for two back to back, else on the side that fronts more, every
/// lot fronting a local street, its door on it. The block's buildings a lot stands on give way (the first lots take
/// their places in the list, any more of them are dropped). Every lot clear of every road (its half width and
/// `LOT_ROAD_CM`), the sites and the other lots, `hq::MIN_GAP_CM` from the next and with room for the HQ and its garage
/// (`hq::fits`).
fn hq_pool(p: &super::super::profile::Profile, roads: &Roads, hub: P, sites: &[Site], buildings: &[super::landuse::Building],
    frames: &[super::landuse::Frame], lots: &mut Vec<Lot>) -> Result<(), String> {
    use super::super::organic::geom::{inside, seg_dist2};
    use super::super::organic::hq::{arterial, fits, Streets, MIN_GAP_CM};
    use super::landuse::FRONT_CM;
    let streets = Streets::new(roads);
    // every road's pieces, with their half widths, by 50 m cell
    const RC: i64 = 5_000;
    let mut segs: Vec<(P, P, i64)> = Vec::new();
    let mut cells: BTreeMap<(i64, i64), Vec<usize>> = BTreeMap::new();
    for e in &roads.edges {
        for w in e.points.windows(2) {
            let (a, b, r) = ((w[0][0], w[0][2]), (w[1][0], w[1][2]), e.width / 2);
            for cx in (a.0.min(b.0) - r).div_euclid(RC)..=(a.0.max(b.0) + r).div_euclid(RC) {
                for cz in (a.1.min(b.1) - r).div_euclid(RC)..=(a.1.max(b.1) + r).div_euclid(RC) {
                    cells.entry((cx, cz)).or_default().push(segs.len());
                }
            }
            segs.push((a, b, r));
        }
    }
    let off_roads = |poly: &[P]| {
        let (x0, x1, z0, z1) = poly.iter().fold((i64::MAX, i64::MIN, i64::MAX, i64::MIN), |m, q| (m.0.min(q.0), m.1.max(q.0), m.2.min(q.1), m.3.max(q.1)));
        let n = poly.len();
        (x0.div_euclid(RC) - 1..=x1.div_euclid(RC) + 1).all(|cx| (z0.div_euclid(RC) - 1..=z1.div_euclid(RC) + 1).all(|cz| {
            cells.get(&(cx, cz)).is_none_or(|v| v.iter().all(|&s| {
                let (a, b, r) = segs[s];
                let c = r + LOT_ROAD_CM;
                !inside(a, poly) && !inside(b, poly) && (0..n).all(|k| seg_dist2(poly[k], poly[(k + 1) % n], a, b) >= c * c)
            }))
        }))
    };
    let site_polys: Vec<Vec<P>> = sites.iter().map(|s| match s.poly.as_ref() {
        Some(q) if q.len() >= 3 => q.iter().map(|v| (v[0], v[1])).collect(),
        _ => vec![(s.x - s.w / 2, s.z - s.d / 2), (s.x + s.w / 2, s.z - s.d / 2), (s.x + s.w / 2, s.z + s.d / 2), (s.x - s.w / 2, s.z + s.d / 2)],
    }).collect();
    let poly_of = |l: &Lot| -> Vec<P> { l.poly.as_ref().map_or_else(Vec::new, |q| q.iter().map(|v| (v[0], v[1])).collect()) };
    // the blocks: their buildings' lots (lot k is building k until the pool lays one), nearest Central first by use
    let mut by: BTreeMap<(u32, i64, i64), Vec<usize>> = BTreeMap::new();
    for (k, b) in buildings.iter().enumerate() {
        if lots.get(k).is_some_and(|l| l.kind == "building") {
            by.entry((b.frame, b.block.0, b.block.1)).or_default().push(k);
        }
    }
    let rank_of = |u: Use| match u { Use::Office => 0, Use::Home => 1, _ => 2 };
    let mut order: Vec<((u32, i64, i64), (i64, i64))> = by.keys().map(|&key| {
        let f = &frames[key.0 as usize];
        let c = f.at((key.1 as f64 + 0.5) * f.long, (key.2 as f64 + 0.5) * f.short);
        (key, (rank_of(f.use_), ((c.0 - hub.0 as f64).hypot(c.1 - hub.1 as f64)) as i64))
    }).collect();
    order.sort_by_key(|&(key, r)| (r, key));
    let (w, d) = (HQ_LOT_W as f64, HQ_LOT_D as f64);
    let mut chosen: Vec<P> = Vec::new();
    let mut dead: BTreeSet<usize> = BTreeSet::new();
    for (key, _) in order {
        if chosen.len() as i64 >= p.hq_lots {
            break;
        }
        let f = frames[key.0 as usize];
        let mine = &by[&key];
        let (a, b) = (key.1 as f64, key.2 as f64);
        let fr = FRONT_CM as f64;
        let (a0, a1, b0, b1) = (a * f.long + fr, (a + 1.0) * f.long - fr, b * f.short + fr, (b + 1.0) * f.short - fr);
        let n = ((a1 - a0) / w).floor() as i64;
        if n == 0 || b1 - b0 < d {
            continue;
        }
        let across = (-f.u.1, f.u.0);
        let rnd = |q: (f64, f64)| (q.0.round() as i64, q.1.round() as i64);
        let base = &lots[mine[0]];
        // a row along one long side (s 1: the side at b1, fronting +across; -1: at b0): each lot that may stand there
        let row = |s: f64| -> Vec<Lot> {
            let edge = if s > 0.0 { b1 } else { b0 };
            let front = q16(s * across.0, s * across.1);
            let mut out = Vec::new();
            for i in 0..n {
                let la = (a0 + a1) / 2.0 - n as f64 * w / 2.0 + w / 2.0 + i as f64 * w;
                let poly: Vec<P> = [(la - w / 2.0, edge), (la + w / 2.0, edge), (la + w / 2.0, edge - s * d), (la - w / 2.0, edge - s * d)]
                    .iter().map(|&(x, z)| rnd(f.at(x, z))).collect();
                let (at, door) = (rnd(f.at(la, edge - s * d / 2.0)), rnd(f.at(la, edge)));
                if !off_roads(&poly) || !streets.fronted(door, front).is_some_and(|(_, _, class)| !arterial(class)) {
                    continue;
                }
                if site_polys.iter().any(|sp| convex_overlap(sp, &poly))
                    || lots.iter().enumerate().any(|(j, o)| !mine.contains(&j) && !dead.contains(&j) && o.poly.is_some() && convex_overlap(&poly_of(o), &poly))
                    || chosen.iter().any(|q| (q.0 - at.0).pow(2) + (q.1 - at.1).pow(2) < MIN_GAP_CM * MIN_GAP_CM)
                {
                    continue;
                }
                let mut hq = base.clone();
                (hq.x, hq.z, hq.w, hq.d) = (at.0, at.1, HQ_LOT_W, HQ_LOT_D);
                (hq.poly, hq.front, hq.door) = (Some(poly.iter().map(|q| [q.0, q.1]).collect()), Some(front), [door.0, base.door[1], door.1]);
                hq.facing = if front[1] < 0 { Facing::South } else { Facing::North };
                (hq.kind, hq.floors) = ("hq", 0);
                if fits(&hq) {
                    out.push(hq);
                }
            }
            out
        };
        let (hi, lo) = (row(1.0), row(-1.0));
        let laid: Vec<Lot> = if b1 - b0 >= 2.0 * d { hi.into_iter().chain(lo).collect() } else if lo.len() > hi.len() { lo } else { hi };
        let laid: Vec<Lot> = laid.into_iter().take((p.hq_lots - chosen.len() as i64).max(0) as usize).collect();
        if laid.is_empty() {
            continue;
        }
        // the block's buildings under its lots give way: the first lots take their places, any more are dropped
        let gone: Vec<usize> = mine.iter().copied().filter(|&j| { let q = poly_of(&lots[j]); laid.iter().any(|h| convex_overlap(&q, &poly_of(h))) }).collect();
        let m = laid.len();
        dead.extend(gone.iter().skip(m).copied());
        for (i, mut hq) in laid.into_iter().enumerate() {
            let r = chosen.len() as u32;
            (hq.rank, hq.tier) = (Some(r), Some(r / p.hq_tier.max(1) as u32));
            chosen.push((hq.x, hq.z));
            match gone.get(i) {
                Some(&j) => {
                    (hq.id, hq.block, hq.district) = (lots[j].id, lots[j].block, lots[j].district);
                    lots[j] = hq;
                }
                None => {
                    hq.id = lots.len() as u32;
                    lots.push(hq);
                }
            }
        }
    }
    // (the dropped buildings out, the lots' ids their places again)
    if !dead.is_empty() {
        let mut k = 0;
        lots.retain(|_| { let keep = !dead.contains(&k); k += 1; keep });
        for (i, l) in lots.iter_mut().enumerate() {
            l.id = i as u32;
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
            hall_y: s.hall_y, entrances: ents,
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

#[cfg(test)]
mod hq_lot_tests {
    use super::*;
    use super::super::super::organic::geom::{inside, seg_dist2};
    use super::super::super::organic::hq::{arterial, fits, Streets, MIN_GAP_CM};

    fn layers4() -> &'static Layers {
        static L: std::sync::OnceLock<Layers> = std::sync::OnceLock::new();
        L.get_or_init(|| layers("claude-hq@4", &[]).unwrap())
    }

    fn ring(l: &Lot) -> Vec<P> {
        l.poly.as_ref().unwrap().iter().map(|v| (v[0], v[1])).collect()
    }

    /// Every HQ lot the same size, side by side along its block's long frontage (New York's), turned to the block's
    /// frame: the profile's count, each fronting a local street with its door on the front edge, with room for the HQ
    /// and its garage, none on another lot, a site or the next HQ's ground.
    #[test]
    fn hq_lots_are_equal_and_front_a_street() {
        let l = layers4();
        let p = profile_for("claude-hq@4", 4);
        let hq: Vec<&Lot> = l.lots.iter().filter(|x| x.kind == "hq").collect();
        assert_eq!(hq.len() as i64, p.hq_lots);
        let ids: Vec<u32> = l.lots.iter().map(|x| x.id).collect();
        assert_eq!(ids, (0..l.lots.len() as u32).collect::<Vec<_>>(), "lot ids their places");
        let mut ranks: Vec<u32> = hq.iter().map(|x| x.rank.unwrap()).collect();
        ranks.sort();
        assert_eq!(ranks, (0..hq.len() as u32).collect::<Vec<_>>());
        let streets = Streets::new(&l.roads);
        let len = |a: P, b: P| ((a.0 - b.0) as f64).hypot((a.1 - b.1) as f64);
        for a in &hq {
            assert_eq!((a.w, a.d), (HQ_LOT_W, HQ_LOT_D), "lot {}", a.id);
            let r = ring(a);
            assert_eq!(r.len(), 4);
            // a 36 m front edge (its door in the middle of it, facing out), 34 m deep
            let f = a.front.unwrap();
            let fu = (f[0] as f64 / ONE as f64, f[1] as f64 / ONE as f64);
            assert!((len(r[0], r[1]) - HQ_LOT_W as f64).abs() < 3.0 && (len(r[1], r[2]) - HQ_LOT_D as f64).abs() < 3.0, "lot {} its size", a.id);
            let mid = ((r[0].0 + r[1].0) / 2, (r[0].1 + r[1].1) / 2);
            assert!(len(mid, (a.door[0], a.door[2])) < 3.0, "lot {}'s door mid front", a.id);
            let out = ((a.door[0] - a.x) as f64 * fu.0 + (a.door[2] - a.z) as f64 * fu.1) - HQ_LOT_D as f64 / 2.0;
            assert!(out.abs() < 3.0, "lot {} fronts the way its door is", a.id);
            assert!(streets.fronted((a.door[0], a.door[2]), f).is_some_and(|(_, _, c)| !arterial(c)), "lot {} fronts a local street", a.id);
            assert!(fits(a), "lot {} holds the HQ and its garage", a.id);
            for o in l.lots.iter().filter(|o| o.id != a.id && o.poly.is_some()) {
                assert!(!convex_overlap(&r, &ring(o)), "lot {} on lot {}", a.id, o.id);
            }
            for s in l.sites.iter().filter(|s| s.kind != "spawn") {
                let sp = vec![(s.x - s.w / 2, s.z - s.d / 2), (s.x + s.w / 2, s.z - s.d / 2), (s.x + s.w / 2, s.z + s.d / 2), (s.x - s.w / 2, s.z + s.d / 2)];
                assert!(!convex_overlap(&r, &sp), "lot {} on site {}", a.id, s.id);
            }
            for o in hq.iter().filter(|o| o.id != a.id) {
                assert!((a.x - o.x).pow(2) + (a.z - o.z).pow(2) >= MIN_GAP_CM * MIN_GAP_CM);
            }
        }
        // rows: lots side by side (their fronts the same way, a lot's width apart along it)
        let rows = hq.iter().filter(|a| hq.iter().any(|o| o.id != a.id && o.front == a.front && (len((o.x, o.z), (a.x, a.z)) - HQ_LOT_W as f64).abs() < 3.0)).count();
        assert!(rows >= 32, "{rows} lots in rows");
        // turned: the v5 blocks are rotated rectangles, so are their lots
        assert!(hq.iter().any(|a| a.front.unwrap()[0] != 0 && a.front.unwrap()[1] != 0), "some lot turned off the axes");
    }

    /// No HQ lot's ground on a road: every edge of it a road's half width clear of every road's centre line, none
    /// inside it (a lot's pad over a carriageway draws over the asphalt).
    #[test]
    fn hq_lots_stay_off_the_roads() {
        let l = layers4();
        let mut bad = Vec::new();
        for a in l.lots.iter().filter(|x| x.kind == "hq") {
            let r = ring(a);
            let n = r.len();
            for e in &l.roads.edges {
                let hw = e.width / 2;
                for s in e.points.windows(2) {
                    let (p, q) = ((s[0][0], s[0][2]), (s[1][0], s[1][2]));
                    if inside(p, &r) || (0..n).any(|k| seg_dist2(r[k], r[(k + 1) % n], p, q) < hw * hw) {
                        bad.push((a.id, e.id, e.class));
                        break;
                    }
                }
            }
        }
        assert!(bad.is_empty(), "HQ lots on roads (lot, edge, class): {bad:?}");
    }
}
