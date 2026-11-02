//! City Gen v5: the planned city written as the doc's layers, in their @3 shapes, so today's client draws @4.
//!
//! - roads: every arterial, street and link a polyline; split where two cross or one's end meets another's side,
//!   ends within `JOIN_CM` one node; then seated and carved on the terrain as @3's
//! - blocks and lots: one block per building, its lot the building's footprint (floors by its height)
//! - sites: the spawn and fountain on the plaza, Central, the airport (its footprint, its front the apron's side), the port
//! - metro and rail: the lines' paths and kinds, stations, entrances and their stair holes; each tunnel mouth a portal
//!   (rail.portals, metro.portals with each line's depot) and its open cutting's terrain hole; rail.keep_out, the
//!   airport's box and approaches (no line crosses them above the ground: the client routes the Island Link round them)
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
    let City { mut land, airport: ap, hub, port, rail, arterials, streets, landuse, metro, space, .. } = c;
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
            poly: Some(poly), front: Some(front), grow: Some(k as u32), min_tier: None, gates: None, annex: None,
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

    // the HQ pool: a township each, spread over the residential blocks (nearest Central first), every one's door and
    // gateways out to a local street
    hq_pool(&p, &roads, hub, &doc.sites, &land, &space, &ap.poly, &landuse.buildings, &landuse.frames, &mut doc.lots, &mut doc.blocks)?;

    let districts = districts_of(&land, &landuse.cells, hub);
    let zones = Some(zones::layer(land.seed, &doc.blocks));
    // [3.37] the bus stops on the avenues' kerbs (the stations' and landmarks' first), and the bus loops through them
    {
        let mut anchors: Vec<P> = metro.stations.iter().map(|s| s.c).collect();
        anchors.extend(rail.iter().flat_map(|l| l.stations.iter().copied()));
        anchors.extend(doc.sites.iter().filter(|s| matches!(s.kind, "transit" | "fountain" | "port" | "airport")).map(|s| (s.x, s.z)));
        let mut avoid: Vec<P> = metro.stations.iter().flat_map(|s| s.entrances.iter().copied()).collect();
        avoid.extend(metro.lines.iter().filter_map(|l| l.depot.as_ref().map(|d| d.portal.at)));
        avoid.extend(rail.iter().flat_map(|l| l.portals.iter().map(|p| p.at)));
        let stops = super::bus::stops(&roads, &doc.lots, &doc.sites, &anchors, &avoid);
        for (k, b) in stops.iter().enumerate() {
            let mut s = site(&format!("busstop:{k}"), "busstop", b.at, gy(b.at), super::bus::W_CM, super::bus::D_CM, None, b.front);
            s.tier = Some(transit::BUS_TIER);
            doc.sites.push(s);
        }
    }
    let mut tr = transit::generate_avenues(&roads, &doc.sites, &doc.lots);
    let isl = land.coast.as_ref().map(|co| island::grow(&p, co, &mut roads, &mut doc, &mut tr));

    let mut terrain = land.t.clone();
    grade_airport(&mut terrain, &land, &ap);
    grade_terminal(&mut terrain, tat, tn);
    grade_townships(&mut terrain, &doc.lots);
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

/// Each township (an HQ lot with gates; with its neighbouring plots, `town_ground`) graded level at its door's height (the ground in the middle of its street front):
/// the lot drawn flat on it (worldgeom.js), its HQ, drive and gardens on one level, easing back to the land over
/// `TOWN_EASE_CM` round it (level out to a terrain cell and a half past its edge: the ground between the vertices is
/// their blend, so its own edge is level too).
const TOWN_EASE_CM: f64 = 1_000.0;
fn grade_townships(t: &mut super::super::terrain::Terrain, lots: &[Lot]) {
    use super::super::organic::geom::{inside, seg_dist2};
    let flat = t.cell_cm as f64 * 1.5;
    let m = (flat + TOWN_EASE_CM) as i64;
    // each township: its outline, its level, its box grown by the grading's reach
    let towns: Vec<(Vec<P>, f64, (i64, i64, i64, i64))> = lots.iter().filter(|l| l.kind == "hq" && l.gates.is_some()).filter_map(|l| {
        let r: Vec<P> = town_ground(l)?;
        let b = r.iter().fold((i64::MAX, i64::MIN, i64::MAX, i64::MIN), |b, q| (b.0.min(q.0), b.1.max(q.0), b.2.min(q.1), b.3.max(q.1)));
        Some((r, t.height_at(l.door[0], l.door[2]) as f64, (b.0 - m, b.1 + m, b.2 - m, b.3 + m)))
    }).collect();
    // every vertex in reach takes the nearest township's level (two in one block each keep their own ground)
    let mut grade: BTreeMap<usize, (f64, f64)> = BTreeMap::new();
    for (r, y, b) in &towns {
        let n = r.len();
        for iz in 0..t.n {
            for ix in 0..t.n {
                let q = t.vertex_pos(ix, iz);
                if q.0 < b.0 || q.0 > b.1 || q.1 < b.2 || q.1 > b.3 {
                    continue;
                }
                let d = if inside(q, r) { 0.0 } else { ((0..n).map(|e| seg_dist2(r[e], r[(e + 1) % n], q, q)).min().unwrap_or(i64::MAX) as f64).sqrt() };
                let k = iz * t.n + ix;
                if grade.get(&k).is_none_or(|g| d < g.0) {
                    grade.insert(k, (d, *y));
                }
            }
        }
    }
    for (k, (d, y)) in grade {
        let e = (1.0 - (d - flat).max(0.0) / TOWN_EASE_CM).clamp(0.0, 1.0);
        let w = e * e * (3.0 - 2.0 * e);
        if w > 0.0 {
            let h = &mut t.heights[k];
            *h = (*h as f64 + (y - *h as f64) * w).round() as i32;
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
/// with its owner's level, the lot does not): a township 88 m along its street and 56 m deep. 56 m is a home block's
/// whole depth between its two streets' building lines (landuse.rs block_of: two 18 m rows and the 20 m between them),
/// so a township fills its block through to the next street, two to a home block; 4 928 m2, four times the 36 x 34 m
/// lot it replaces (1 224 m2), with room inside its wall for a drive round the HQ, parking and gardens.
pub const HQ_LOT_W: i64 = 8_800;
pub const HQ_LOT_D: i64 = 5_600;
/// A township's two gateways on its street front: each one's middle this far in from the lot's side edge (cm), its
/// opening this wide (the 5.5 m drive inside and its posts). The way in on the lot's -x side (its frame: +z out of its
/// front), the way out on its +x side.
pub const GATE_IN_CM: i64 = 650;
pub const GATE_W_CM: i64 = 700;
/// How far (cm) a gateway's middle may stand back from its street's edge (the lot's front is `FRONT_CM` from the street's
/// centre line: the pavement between).
pub const GATE_REACH_CM: i64 = 800;
/// The townships spread over the city: the blocks holding them this far apart (centre to centre, cm) at first, then
/// closer, step by step, until the profile's count is laid (0: anywhere they fit).
const SPREAD_CM: [i64; 8] = [48_000, 40_000, 34_000, 28_000, 22_000, 16_000, 10_000, 0];
/// Each township's two neighbouring plots (HQ 3.37, `Lot::annex`), flush with its sides along its street: this wide
/// (cm) and as deep as it. A home block's row is 200 m between its streets' building lines, so a township and both its
/// plots (88 + 2 x 55 m) fill it with a metre to spare: one township to a block, the block its to grow over.
pub const HQ_ANNEX_W: i64 = 5_500;
/// Two townships' outlines at least this far apart (cm): two walls, never one shared.
const TOWN_GAP_CM: i64 = 300;

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

/// A township's gateways (see `Gate`): on its front edge, `GATE_IN_CM` in from each side, the way in at the -x side.
/// `at(x, z)`: the world point (cm) at x across the lot's front (its frame's +x) and z out of its middle toward the street.
pub fn township_gates(at: &dyn Fn(f64, f64) -> (f64, f64), front: [i64; 2]) -> Vec<super::super::city::Gate> {
    let (gx, gz) = ((HQ_LOT_W - 2 * GATE_IN_CM) as f64 / 2.0, HQ_LOT_D as f64 / 2.0);
    [(-gx, "in"), (gx, "out")].iter().map(|&(x, kind)| {
        let q = at(x, gz);
        super::super::city::Gate { x: q.0.round() as i64, z: q.1.round() as i64, dir: front, kind, w: GATE_W_CM }
    }).collect()
}

/// The whole ground a township may grow over (cm, counter-clockwise, its street edge first): its lot and its
/// neighbouring plots (`Lot::annex`) as one rectangle in the lot's frame; just its lot without plots; None off a township.
pub fn town_ground(l: &Lot) -> Option<Vec<P>> {
    let poly = l.poly.as_ref()?;
    let f = l.front?;
    let (fx, fz) = (f[0] as f64 / ONE as f64, f[1] as f64 / ONE as f64);
    let (sx, sz) = (fz, -fx);
    let pts: Vec<(f64, f64)> = poly.iter().chain(l.annex.iter().flatten().flat_map(|a| a.poly.iter()))
        .map(|q| ((q[0] - l.x) as f64, (q[1] - l.z) as f64)).map(|(dx, dz)| (dx * sx + dz * sz, dx * fx + dz * fz)).collect();
    let (u0, u1) = pts.iter().fold((f64::MAX, f64::MIN), |m, q| (m.0.min(q.0), m.1.max(q.0)));
    let (v0, v1) = pts.iter().fold((f64::MAX, f64::MIN), |m, q| (m.0.min(q.1), m.1.max(q.1)));
    let at = |u: f64, v: f64| ((l.x as f64 + u * sx + v * fx).round() as i64, (l.z as f64 + u * sz + v * fz).round() as i64);
    let r = vec![at(u0, v1), at(u1, v1), at(u1, v0), at(u0, v0)];
    Some(if super::super::organic::geom::area2(&r) < 0 { vec![r[1], r[0], r[3], r[2]] } else { r })
}

/// The HQ lots (see `layers`): a township each, every one the same `HQ_LOT_W` x `HQ_LOT_D`, spread over the city's
/// residential blocks (then its industrial ones; an office block is too shallow for one), two or three to a block
/// along its street, the blocks holding them `SPREAD_CM` apart (relaxed until the profile's count is laid), nearest
/// Central first. Each turned to its block's frame (landuse.rs `Frame`), its front on one of the block's long sides,
/// its two gateways (`township_gates`) and its door on a local street within `GATE_REACH_CM`; clear of every road (its
/// half width and `LOT_ROAD_CM`), the sites, the airport, the other lots (townships `TOWN_GAP_CM` apart), the water
/// and every solid in the volume but the block's own buildings and the roads (a metro entrance, a station, a railway
/// over it); with room for the HQ and its garage (`hq::fits`). The block's buildings under a township give way (the
/// first lots take their places in the list and their blocks, an outline the township's, the rest are dropped with
/// their blocks).
#[allow(clippy::too_many_arguments)]
fn hq_pool(p: &super::super::profile::Profile, roads: &Roads, hub: P, sites: &[Site], land: &super::land::Land, space: &super::space::Space,
    airport: &[P], buildings: &[super::landuse::Building], frames: &[super::landuse::Frame], lots: &mut Vec<Lot>, blocks: &mut Vec<Block>) -> Result<(), String> {
    use super::super::organic::geom::{inside, seg_dist2};
    use super::super::organic::hq::{arterial, fits, Streets};
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
    let rank_of = |u: Use| match u { Use::Home => 0, Use::Industry => 1, _ => 2 };
    let centre_of = |key: (u32, i64, i64)| { let f = &frames[key.0 as usize]; f.at((key.1 as f64 + 0.5) * f.long, (key.2 as f64 + 0.5) * f.short) };
    let mut order: Vec<((u32, i64, i64), (i64, i64))> = by.keys().map(|&key| {
        let c = centre_of(key);
        (key, (rank_of(frames[key.0 as usize].use_), ((c.0 - hub.0 as f64).hypot(c.1 - hub.1 as f64)) as i64))
    }).collect();
    order.sort_by_key(|&(key, r)| (r, key));
    let (w, d) = (HQ_LOT_W as f64, HQ_LOT_D as f64);
    let rnd = |q: (f64, f64)| (q.0.round() as i64, q.1.round() as i64);
    // the townships one block may hold, in the block's own terms (its buildings `mine`, the townships laid so far)
    let block_lots = |key: (u32, i64, i64), placed: &[Vec<P>]| -> Vec<Lot> {
        let f = frames[key.0 as usize];
        let mine = &by[&key];
        let (a, b) = (key.1 as f64, key.2 as f64);
        let fr = FRONT_CM as f64;
        let (a0, a1, b0, b1) = (a * f.long + fr, (a + 1.0) * f.long - fr, b * f.short + fr, (b + 1.0) * f.short - fr);
        // one township to a block, in the middle of its row, its two neighbouring plots (HQ_ANNEX_W) flush either side
        let aw = HQ_ANNEX_W as f64;
        if a1 - a0 < w + 2.0 * aw - 1.0 || b1 - b0 < d - 1.0 {
            return Vec::new();
        }
        let across = (-f.u.1, f.u.0);
        let base = &lots[mine[0]];
        // the row along one long side (s 1: the side at b1, fronting +across; -1: at b0)
        let row = |s: f64| -> Option<Lot> {
            let edge = if s > 0.0 { b1 } else { b0 };
            let front = q16(s * across.0, s * across.1);
            let la = (a0 + a1) / 2.0;
            // the lot's frame: x across its front (s along the block), z out of its middle to the street
            let at = |x: f64, z: f64| f.at(la + s * x, edge - s * d / 2.0 + s * z);
            // a rectangle x0..x1 across the front, the lot's depth (counter-clockwise, its front edge first)
            let rect = |x0: f64, x1: f64| -> Vec<P> {
                let r: Vec<P> = [(x0, d / 2.0), (x1, d / 2.0), (x1, -d / 2.0), (x0, -d / 2.0)].iter().map(|&(x, z)| rnd(at(x, z))).collect();
                if super::super::organic::geom::area2(&r) < 0 { vec![r[1], r[0], r[3], r[2]] } else { r }
            };
            let poly = rect(-w / 2.0, w / 2.0);
            // the whole ground it may grow over: the township and both its neighbouring plots
            let full = rect(-w / 2.0 - aw, w / 2.0 + aw);
            let (mid, door) = (rnd(at(0.0, 0.0)), rnd(at(0.0, d / 2.0)));
            let gates = township_gates(&at, front);
            let on_street = |q: P| streets.fronted(q, front).is_some_and(|(dd, _, class)| !arterial(class) && dd <= GATE_REACH_CM);
            let fronts = [-w / 2.0 - aw / 2.0, w / 2.0 + aw / 2.0].iter().all(|&x| on_street(rnd(at(x, d / 2.0))));
            if !off_roads(&full) || !on_street(door) || !fronts || !gates.iter().all(|g| on_street((g.x, g.z))) {
                return None;
            }
            // dry all over (a 5 m grid), clear of the airport, of every solid but this block's buildings and the roads
            let fw = w + 2.0 * aw;
            let dry = (0..=(fw / 500.0) as i64).all(|ix| (0..=(d / 500.0) as i64).all(|iz| land.dry(rnd(at(-fw / 2.0 + ix as f64 * 500.0, -d / 2.0 + iz as f64 * 500.0)))));
            let y = land.height(mid);
            if !dry || convex_overlap(airport, &full) || space.blocker_but(&full, y + super::space::GROUND.0, y + super::space::ABOVE.1, 100, &["building", "road"]).is_some() {
                return None;
            }
            if site_polys.iter().any(|sp| convex_overlap(sp, &full))
                || lots.iter().enumerate().any(|(j, o)| !mine.contains(&j) && o.kind == "building" && o.poly.is_some() && convex_overlap(&poly_of(o), &full))
                || placed.iter().any(|q| super::space::near(q, &full, TOWN_GAP_CM))
            {
                return None;
            }
            let annex: Vec<super::super::city::Annex> = [(w / 2.0, w / 2.0 + aw), (-w / 2.0 - aw, -w / 2.0)].iter().map(|&(x0, x1)| {
                let m = rnd(at((x0 + x1) / 2.0, 0.0));
                super::super::city::Annex { x: m.0, z: m.1, poly: rect(x0, x1).iter().map(|q| [q.0, q.1]).collect() }
            }).collect();
            let mut hq = base.clone();
            (hq.x, hq.z, hq.w, hq.d) = (mid.0, mid.1, HQ_LOT_W, HQ_LOT_D);
            (hq.poly, hq.front, hq.door) = (Some(poly.iter().map(|q| [q.0, q.1]).collect()), Some(front), [door.0, base.door[1], door.1]);
            hq.facing = if front[1] < 0 { Facing::South } else { Facing::North };
            (hq.kind, hq.floors, hq.gates, hq.annex) = ("hq", 0, Some(gates), Some(annex));
            fits(&hq).then_some(hq)
        };
        row(1.0).or_else(|| row(-1.0)).into_iter().collect()
    };
    // lay them: the blocks in order, each `spread` from the blocks laid before it; the widest spread that lays them all
    let mut laid: Vec<((u32, i64, i64), Vec<Lot>)> = Vec::new();
    for &spread in &SPREAD_CM {
        laid.clear();
        let (mut count, mut placed, mut at): (i64, Vec<Vec<P>>, Vec<(f64, f64)>) = (0, Vec::new(), Vec::new());
        for &(key, _) in &order {
            if count >= p.hq_lots {
                break;
            }
            let c = centre_of(key);
            if at.iter().any(|q| (q.0 - c.0).hypot(q.1 - c.1) < spread as f64) {
                continue;
            }
            let mut ls = block_lots(key, &placed);
            ls.truncate((p.hq_lots - count).max(0) as usize);
            if ls.is_empty() {
                continue;
            }
            count += ls.len() as i64;
            at.push(c);
            placed.extend(ls.iter().filter_map(town_ground));
            laid.push((key, ls));
        }
        if count >= p.hq_lots {
            break;
        }
    }
    let mut dead: BTreeSet<usize> = BTreeSet::new();
    let mut r = 0u32;
    // (ranked nearest Central first, as the pool hands them out)
    laid.sort_by_key(|(key, _)| { let c = centre_of(*key); (((c.0 - hub.0 as f64).hypot(c.1 - hub.1 as f64)) as i64, *key) });
    for (key, ls) in laid {
        // the block's buildings under its townships give way: the first townships take their places, any more are dropped
        let mine = &by[&key];
        let gone: Vec<usize> = mine.iter().copied().filter(|&j| { let q = poly_of(&lots[j]); ls.iter().filter_map(town_ground).any(|h| convex_overlap(&q, &h)) }).collect();
        dead.extend(gone.iter().skip(ls.len()).copied());
        for (i, mut hq) in ls.into_iter().enumerate() {
            (hq.rank, hq.tier) = (Some(r), Some(r / p.hq_tier.max(1) as u32));
            r += 1;
            // its block: the whole ground the township may grow over (its own lot and its neighbouring plots)
            let ring: Vec<[i64; 2]> = town_ground(&hq).map_or_else(|| hq.poly.clone().unwrap_or_default(), |g| g.iter().map(|q| [q.0, q.1]).collect());
            let (x0, x1) = (ring.iter().map(|q| q[0]).min().unwrap_or(hq.x), ring.iter().map(|q| q[0]).max().unwrap_or(hq.x));
            let (z0, z1) = (ring.iter().map(|q| q[1]).min().unwrap_or(hq.z), ring.iter().map(|q| q[1]).max().unwrap_or(hq.z));
            // the building's block it took the place of (else a new one)
            let bk = match gone.get(i) { Some(&j) => lots[j].block as usize, None => blocks.len() };
            let blk = Block { id: bk as u32, i: 0, j: 0, x: (x0 + x1) / 2, z: (z0 + z1) / 2, w: x1 - x0, d: z1 - z0, district: hq.district, poly: Some(ring) };
            if bk == blocks.len() { blocks.push(blk); } else { blocks[bk] = Block { district: blocks[bk].district, ..blk }; }
            hq.block = bk as u32;
            match gone.get(i) {
                Some(&j) => {
                    (hq.id, hq.district) = (lots[j].id, lots[j].district);
                    lots[j] = hq;
                }
                None => {
                    hq.id = lots.len() as u32;
                    lots.push(hq);
                }
            }
        }
    }
    // (the dropped buildings out with their blocks, the lots' and blocks' ids their places again)
    if !dead.is_empty() {
        let gone_blocks: BTreeSet<u32> = dead.iter().map(|&j| lots[j].block).collect();
        let mut k = 0;
        lots.retain(|_| { let keep = !dead.contains(&k); k += 1; keep });
        let map: BTreeMap<u32, u32> = blocks.iter().filter(|b| !gone_blocks.contains(&b.id)).enumerate().map(|(n, b)| (b.id, n as u32)).collect();
        blocks.retain(|b| !gone_blocks.contains(&b.id));
        for b in blocks.iter_mut() {
            b.id = map[&b.id];
        }
        for (i, l) in lots.iter_mut().enumerate() {
            l.id = i as u32;
            l.block = map.get(&l.block).copied().unwrap_or(0);
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
        let id = format!("M{}", l.id + 1);
        // its depot: the portal (its cutting a terrain hole, from the headwall to where the rail meets the ground), the
        // yard and its sidings
        let depot = l.depot.as_ref().map(|dp| {
            let (a, b) = (dp.portal.i.min(dp.portal.open), dp.portal.i.max(dp.portal.open));
            let c: Vec<P> = l.path[a..=b].iter().map(|p| (p[0], p[2])).collect();
            out.holes.extend(cut_holes(&c, super::metro::TRENCH_W_CM));
            let hole = cut_ring(&c, super::metro::TRENCH_W_CM);
            out.portals.push(m3::Portal {
                id: format!("portal:{}", out.portals.len()), line: id.clone(), x: dp.portal.at.0, z: dp.portal.at.1, y: dp.portal.ground,
                front: q16(dp.portal.front.0, dp.portal.front.1), w: super::metro::TRENCH_W_CM, len: dp.portal.len, hole,
            });
            let did = format!("depot:{}", out.depots.len());
            out.depots.push(m3::Depot { id: did.clone(), line: id.clone(), poly: dp.poly.iter().map(|q| [q.0, q.1]).collect(), tracks: dp.tracks.clone() });
            did
        });
        out.lines.push(m3::Line { id, stations: l.stations.iter().map(|&k| sid(k)).collect(), path: l.path.clone(), kinds: l.kinds.clone(), depot, tier: 1 });
    }
    out
}

/// A cutting's terrain hole, `w` cm wide along its centre line `c`, as a chain of quads (each convex, the next sharing its
/// edge: every point's edge across the line square to its neighbours' chord, as metro::band's), so the client's cut is
/// exact however long and gently curved the cutting is.
fn cut_holes(c: &[P], w: i64) -> Vec<Vec<[i64; 2]>> {
    let n = c.len();
    let side: Vec<([i64; 2], [i64; 2])> = (0..n).map(|i| {
        let (a, b) = (c[i.saturating_sub(1)], c[(i + 1).min(n - 1)]);
        let (dx, dz) = ((b.0 - a.0) as f64, (b.1 - a.1) as f64);
        let l = dx.hypot(dz).max(1.0);
        let (nx, nz) = (-dz / l * w as f64 / 2.0, dx / l * w as f64 / 2.0);
        ([c[i].0 + nx as i64, c[i].1 + nz as i64], [c[i].0 - nx as i64, c[i].1 - nz as i64])
    }).collect();
    (1..n).map(|i| vec![side[i - 1].1, side[i].1, side[i].0, side[i - 1].0]).collect()
}

/// The same cutting as one ring (a portal's `hole`), through every fifth point and the last: few enough points that no
/// three are near collinear (its centroid shows which way the cutting runs from its headwall).
fn cut_ring(c: &[P], w: i64) -> Vec<[i64; 2]> {
    let mut k: Vec<P> = c.iter().step_by(5).copied().collect();
    if k.last() != c.last() {
        k.extend(c.last().copied());
    }
    super::super::metro::band(&k, w)
}

fn rail_layer(lines: &[super::rail::Line], land: &super::land::Land, ap: &super::airport::Airport) -> r3::Rail {
    // what no line crosses above the ground (the client routes the Island Link's sea crossing round it)
    let keep_out = super::rail::keep_out(ap).into_iter().map(|k| k.into_iter().map(|q| [q.0, q.1]).collect()).collect();
    let mut out = r3::Rail { keep_out, ..Default::default() };
    for l in lines {
        let n = l.path.len();
        // per segment, the less open of its ends: in a tunnel, in a portal's open cutting, on the ground, on a viaduct
        let rank = |k: &str| match k { "tunnel" => 0, "cutting" => 1, "ramp" => 2, _ => 3 };
        let kinds: Vec<&'static str> = (0..n.saturating_sub(1)).map(|i| {
            let k = if rank(l.kinds[i]) <= rank(l.kinds[i + 1]) { l.kinds[i] } else { l.kinds[i + 1] };
            match k { "cutting" => "portal", "ramp" => "grade", k => k }
        }).collect();
        // each cutting a terrain hole, from its headwall to where the rail meets the ground; each mouth a portal
        let centre = |i0: usize, i1: usize| -> Vec<P> { l.path[i0.min(i1)..=i0.max(i1)].iter().map(|p| (p[0], p[2])).collect() };
        let band = |i0: usize, i1: usize| cut_ring(&centre(i0, i1), super::rail::TRENCH_W_CM);
        for &(i0, i1) in &l.cuts {
            out.holes.extend(cut_holes(&centre(i0, i1), super::rail::TRENCH_W_CM));
        }
        for pt in &l.portals {
            out.portals.push(m3::Portal {
                id: format!("rail-portal:{}", out.portals.len()), line: l.id.to_string(), x: pt.at.0, z: pt.at.1, y: pt.ground,
                front: q16(pt.front.0, pt.front.1), w: super::rail::TRENCH_W_CM, len: pt.len, hole: band(pt.i, pt.open),
            });
        }
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
    use std::collections::BTreeSet;

    fn layers4() -> &'static Layers {
        static L: std::sync::OnceLock<Layers> = std::sync::OnceLock::new();
        L.get_or_init(|| layers("claude-hq@4", &[]).unwrap())
    }

    /// A township's whole ground: its lot and its neighbouring plots.
    fn ground(l: &Lot) -> Vec<P> {
        town_ground(l).unwrap()
    }

    fn ring(l: &Lot) -> Vec<P> {
        l.poly.as_ref().unwrap().iter().map(|v| (v[0], v[1])).collect()
    }

    /// Every HQ lot the same size (a township, `HQ_LOT_W` x `HQ_LOT_D`), turned to its block's frame: the profile's count,
    /// each fronting a local street with its door mid front, with room for the HQ and its garage, none on another lot, a
    /// site or the next township's ground (`TOWN_GAP_CM` between their outlines).
    #[test]
    fn hq_lots_are_equal_townships_and_front_a_street() {
        let l = layers4();
        let p = profile_for("claude-hq@4", 4);
        let hq: Vec<&Lot> = l.lots.iter().filter(|x| x.kind == "hq").collect();
        assert_eq!(hq.len() as i64, p.hq_lots);
        let ids: Vec<u32> = l.lots.iter().map(|x| x.id).collect();
        assert_eq!(ids, (0..l.lots.len() as u32).collect::<Vec<_>>(), "lot ids their places");
        let bids: Vec<u32> = l.blocks.iter().map(|x| x.id).collect();
        assert_eq!(bids, (0..l.blocks.len() as u32).collect::<Vec<_>>(), "block ids their places");
        assert!(l.lots.iter().all(|x| (x.block as usize) < l.blocks.len()), "every lot on a block");
        let mut ranks: Vec<u32> = hq.iter().map(|x| x.rank.unwrap()).collect();
        ranks.sort();
        assert_eq!(ranks, (0..hq.len() as u32).collect::<Vec<_>>());
        // four times the 36 x 34 m lot it replaced, or more
        const { assert!(HQ_LOT_W * HQ_LOT_D >= 4 * 3_600 * 3_400) };
        let streets = Streets::new(&l.roads);
        let len = |a: P, b: P| ((a.0 - b.0) as f64).hypot((a.1 - b.1) as f64);
        for a in &hq {
            assert_eq!((a.w, a.d), (HQ_LOT_W, HQ_LOT_D), "lot {}", a.id);
            let r = ring(a);
            assert_eq!(r.len(), 4);
            assert!(super::super::super::organic::geom::area2(&r) > 0, "lot {} counter-clockwise", a.id);
            // an 88 m front edge (its door in the middle of it, facing out), 56 m deep
            let f = a.front.unwrap();
            let fu = (f[0] as f64 / ONE as f64, f[1] as f64 / ONE as f64);
            assert!((len(r[0], r[1]) - HQ_LOT_W as f64).abs() < 3.0 && (len(r[1], r[2]) - HQ_LOT_D as f64).abs() < 3.0, "lot {} its size", a.id);
            let mid = ((r[0].0 + r[1].0) / 2, (r[0].1 + r[1].1) / 2);
            assert!(len(mid, (a.door[0], a.door[2])) < 3.0, "lot {}'s door mid front", a.id);
            let out = ((a.door[0] - a.x) as f64 * fu.0 + (a.door[2] - a.z) as f64 * fu.1) - HQ_LOT_D as f64 / 2.0;
            assert!(out.abs() < 3.0, "lot {} fronts the way its door is", a.id);
            assert!(streets.fronted((a.door[0], a.door[2]), f).is_some_and(|(_, _, c)| !arterial(c)), "lot {} fronts a local street", a.id);
            assert!(fits(a), "lot {} holds the HQ and its garage", a.id);
            // (its block: its whole ground, townships_have_room_to_grow)
            for o in l.lots.iter().filter(|o| o.id != a.id && o.poly.is_some()) {
                assert!(!convex_overlap(&r, &ring(o)), "lot {} on lot {}", a.id, o.id);
            }
            for s in l.sites.iter().filter(|s| s.kind != "spawn") {
                let sp = vec![(s.x - s.w / 2, s.z - s.d / 2), (s.x + s.w / 2, s.z - s.d / 2), (s.x + s.w / 2, s.z + s.d / 2), (s.x - s.w / 2, s.z + s.d / 2)];
                assert!(!convex_overlap(&r, &sp), "lot {} on site {}", a.id, s.id);
            }
            for o in hq.iter().filter(|o| o.id != a.id) {
                assert!((a.x - o.x).pow(2) + (a.z - o.z).pow(2) >= MIN_GAP_CM * MIN_GAP_CM);
                assert!(!super::super::space::near(&r, &ring(o), TOWN_GAP_CM), "townships {} and {} closer than their walls' gap", a.id, o.id);
            }
        }
        // turned: the v5 blocks are rotated rectangles, so are their lots
        assert!(hq.iter().any(|a| a.front.unwrap()[0] != 0 && a.front.unwrap()[1] != 0), "some lot turned off the axes");
    }

    /// Each township's two gateways: the way in (first) and the way out on its front edge, `GATE_IN_CM` in from its
    /// sides, `GATE_W_CM` wide, facing out as its front, each at a local street within `GATE_REACH_CM`.
    #[test]
    fn township_gates_open_on_a_street() {
        let l = layers4();
        let streets = Streets::new(&l.roads);
        for a in l.lots.iter().filter(|x| x.kind == "hq") {
            let g = a.gates.as_ref().expect("a township has gates");
            assert_eq!(g.iter().map(|x| x.kind).collect::<Vec<_>>(), vec!["in", "out"], "lot {}", a.id);
            let f = a.front.unwrap();
            let fu = (f[0] as f64 / ONE as f64, f[1] as f64 / ONE as f64);
            // the lot's frame: +x across its front (fz, -fx), +z out of its front
            let side = (fu.1, -fu.0);
            for (k, x) in g.iter().enumerate() {
                assert_eq!((x.dir, x.w), (f, GATE_W_CM), "lot {} gate {k}", a.id);
                let (dx, dz) = ((x.x - a.x) as f64, (x.z - a.z) as f64);
                let (u, v) = (dx * side.0 + dz * side.1, dx * fu.0 + dz * fu.1);
                assert!((v - HQ_LOT_D as f64 / 2.0).abs() < 3.0, "lot {} gate {k} on its front edge ({v})", a.id);
                let want = (HQ_LOT_W / 2 - GATE_IN_CM) as f64 * if x.kind == "in" { -1.0 } else { 1.0 };
                assert!((u - want).abs() < 3.0, "lot {} gate {k} {} m along its front", a.id, u / 100.0);
                let s = streets.fronted((x.x, x.z), f);
                assert!(s.is_some_and(|(d, _, c)| !arterial(c) && d <= GATE_REACH_CM), "lot {} gate {k} on no local street: {:?}", a.id, s.map(|q| (q.0, q.2)));
            }
        }
    }

    /// The townships spread over the city, in clusters along their streets: not piled at the centre (no more than a
    /// quarter within 800 m of the hub), in at least 24 of the 500 m squares, and most beside another township on the same
    /// street (two to a block).
    #[test]
    fn townships_spread_in_clusters() {
        let l = layers4();
        let hub = l.sites.iter().find(|s| s.kind == "fountain").map(|s| (s.x, s.z)).unwrap();
        let hq: Vec<&Lot> = l.lots.iter().filter(|x| x.kind == "hq").collect();
        let near = hq.iter().filter(|a| (a.x - hub.0).pow(2) + (a.z - hub.1).pow(2) < 80_000i64.pow(2)).count();
        assert!(near * 4 <= hq.len(), "{near} of {} townships within 800 m of the hub", hq.len());
        let squares: BTreeSet<(i64, i64)> = hq.iter().map(|a| (a.x.div_euclid(50_000), a.z.div_euclid(50_000))).collect();
        assert!(squares.len() >= 24, "the townships in {} 500 m squares", squares.len());
        // (one to a block now, the rest of its row its neighbouring plots: HQ 3.37)
        for a in &hq {
            for o in hq.iter().filter(|o| o.id != a.id) {
                assert!(!super::super::space::near(&ground(a), &ground(o), TOWN_GAP_CM), "townships {} and {}: their grounds touch", a.id, o.id);
            }
        }
    }

    /// Every township level, its neighbouring plots too: its ground (the terrain) within 30 cm of its door's over its inside
    /// (a 4 m grid, 10 m in from its edges), and within 2 m on its edges (where the streets' carving meets it, under its walls).
    #[test]
    fn townships_are_graded_level() {
        let l = layers4();
        let mut bad = Vec::new();
        for a in l.lots.iter().filter(|x| x.kind == "hq") {
            let f = a.front.unwrap();
            let (fx, fz) = (f[0] as f64 / ONE as f64, f[1] as f64 / ONE as f64);
            let at = |u: f64, v: f64| ((a.x as f64 + u * fz + v * fx).round() as i64, (a.z as f64 - u * fx + v * fz).round() as i64);
            let (hw, hd) = (HQ_LOT_W as f64 / 2.0 + HQ_ANNEX_W as f64, HQ_LOT_D as f64 / 2.0);
            let r = ground(a);
            let mut u = -hw + 1_000.0;
            while u <= hw - 1_000.0 {
                let mut v = -hd + 1_000.0;
                while v <= hd - 1_000.0 {
                    let q = at(u, v);
                    let dy = l.terrain.height_at(q.0, q.1) - a.door[1];
                    if dy.abs() > 30 {
                        bad.push((a.id, q, dy));
                    }
                    v += 400.0;
                }
                u += 400.0;
            }
            for k in 0..4 {
                for q in [r[k], ((r[k].0 + r[(k + 1) % 4].0) / 2, (r[k].1 + r[(k + 1) % 4].1) / 2)] {
                    let dy = l.terrain.height_at(q.0, q.1) - a.door[1];
                    if dy.abs() > 200 {
                        bad.push((a.id, q, dy));
                    }
                }
            }
        }
        assert!(bad.is_empty(), "townships not level (lot, at, cm off its door's): {bad:?}");
    }

    /// No township on the water, the airport, a station, a metro entrance or under a railway line at the ground or above.
    #[test]
    fn townships_keep_off_water_airport_and_stations() {
        let l = layers4();
        let city = super::super::City::plan("claude-hq@4").unwrap();
        let ap = l.sites.iter().find_map(|s| s.runway.as_ref()).map(|r| r.area.iter().map(|v| (v[0], v[1])).collect::<Vec<P>>()).unwrap();
        let metro = l.metro.as_ref().unwrap();
        let rail = l.rail.as_ref().unwrap();
        for a in l.lots.iter().filter(|x| x.kind == "hq") {
            let r = ground(a);
            assert!(!convex_overlap(&r, &ap), "lot {} on the airport", a.id);
            let (x0, x1) = (r.iter().map(|q| q.0).min().unwrap(), r.iter().map(|q| q.0).max().unwrap());
            let (z0, z1) = (r.iter().map(|q| q.1).min().unwrap(), r.iter().map(|q| q.1).max().unwrap());
            for x in (x0..=x1).step_by(400) {
                for z in (z0..=z1).step_by(400) {
                    assert!(!inside((x, z), &r) || city.land.dry((x, z)), "lot {} on the water at {x}, {z}", a.id);
                }
            }
            for s in &metro.stations {
                assert!(!inside((s.x, s.z), &r), "lot {} on metro station {}", a.id, s.id);
            }
            for e in &metro.entrances {
                assert!(!super::super::space::near(&[(e.x - e.w / 2, e.z - e.d / 2), (e.x + e.w / 2, e.z - e.d / 2), (e.x + e.w / 2, e.z + e.d / 2), (e.x - e.w / 2, e.z + e.d / 2)], &r, 100),
                    "lot {} on metro entrance {}", a.id, e.id);
            }
            for s in &rail.stations {
                assert!(!inside((s.x, s.z), &r), "lot {} on rail station {}", a.id, s.id);
            }
            for ln in &rail.lines {
                for (k, w) in ln.path.windows(2).enumerate() {
                    if ln.kinds.get(k).is_some_and(|kd| *kd == "tunnel") {
                        continue;
                    }
                    let (p, q) = ((w[0][0], w[0][2]), (w[1][0], w[1][2]));
                    assert!(!inside(p, &r) && (0..4).all(|i| seg_dist2(r[i], r[(i + 1) % 4], p, q) > 0), "lot {} under rail line {}", a.id, ln.id);
                }
            }
        }
    }

    /// No HQ lot's ground on a road: every edge of it a road's half width clear of every road's centre line, none
    /// inside it (a lot's pad over a carriageway draws over the asphalt).
    #[test]
    fn hq_lots_stay_off_the_roads() {
        let l = layers4();
        let mut bad = Vec::new();
        for a in l.lots.iter().filter(|x| x.kind == "hq") {
            let r = ground(a);
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

    /// Room to grow (HQ 3.37): every township has its two neighbouring plots, `HQ_ANNEX_W` wide and as deep as it, flush
    /// with its sides along its street (the first on its +x side, past the way out), their street edges in line with its
    /// front and on a local street; no building, site or other lot on any of its ground, and its block that whole ground.
    #[test]
    fn townships_have_room_to_grow() {
        let l = layers4();
        let streets = Streets::new(&l.roads);
        let len = |a: P, b: P| ((a.0 - b.0) as f64).hypot((a.1 - b.1) as f64);
        for a in l.lots.iter().filter(|x| x.kind == "hq") {
            let ax = a.annex.as_ref().unwrap_or_else(|| panic!("township {} has no plots", a.id));
            assert_eq!(ax.len(), 2, "township {}", a.id);
            let f = a.front.unwrap();
            let fu = (f[0] as f64 / ONE as f64, f[1] as f64 / ONE as f64);
            let side = (fu.1, -fu.0);
            let out_gate = a.gates.as_ref().unwrap().iter().find(|g| g.kind == "out").unwrap();
            let gu = (out_gate.x - a.x) as f64 * side.0 + (out_gate.z - a.z) as f64 * side.1;
            for (k, p) in ax.iter().enumerate() {
                let r: Vec<P> = p.poly.iter().map(|q| (q[0], q[1])).collect();
                assert_eq!(r.len(), 4);
                assert!(super::super::super::organic::geom::area2(&r) > 0, "township {} plot {k} counter-clockwise", a.id);
                assert!((len(r[0], r[1]) - HQ_ANNEX_W as f64).abs() < 3.0 && (len(r[1], r[2]) - HQ_LOT_D as f64).abs() < 3.0, "township {} plot {k} its size", a.id);
                let (du, dv) = ((p.x - a.x) as f64 * side.0 + (p.z - a.z) as f64 * side.1, (p.x - a.x) as f64 * fu.0 + (p.z - a.z) as f64 * fu.1);
                let want = (HQ_LOT_W + HQ_ANNEX_W) as f64 / 2.0;
                assert!((du.abs() - want).abs() < 3.0 && dv.abs() < 3.0, "township {} plot {k} flush with its side ({du}, {dv})", a.id);
                // the first on the way out's side
                assert_eq!(du.signum() == gu.signum(), k == 0, "township {} plot {k} on the wrong side", a.id);
                // its street edge in line with the township's front, on a local street
                let fm = ((r[0].0 + r[1].0) / 2, (r[0].1 + r[1].1) / 2);
                let fv = (fm.0 - a.x) as f64 * fu.0 + (fm.1 - a.z) as f64 * fu.1;
                assert!((fv - HQ_LOT_D as f64 / 2.0).abs() < 3.0, "township {} plot {k} its front edge in line ({fv})", a.id);
                assert!(streets.fronted(fm, f).is_some_and(|(d, _, c)| !arterial(c) && d <= GATE_REACH_CM), "township {} plot {k} on no local street", a.id);
            }
            let g = ground(a);
            let b = &l.blocks[a.block as usize];
            assert_eq!(b.poly.as_ref().map(|q| q.iter().map(|v| (v[0], v[1])).collect::<Vec<P>>()), Some(g.clone()), "township {}'s block is its whole ground", a.id);
            for o in l.lots.iter().filter(|o| o.id != a.id && o.poly.is_some()) {
                assert!(!convex_overlap(&g, &ring(o)), "township {}'s ground on lot {}", a.id, o.id);
            }
            for (k, s) in l.sites.iter().enumerate() {
                let sp: Vec<P> = vec![(s.x - s.w / 2, s.z - s.d / 2), (s.x + s.w / 2, s.z - s.d / 2), (s.x + s.w / 2, s.z + s.d / 2), (s.x - s.w / 2, s.z + s.d / 2)];
                assert!(s.poly.is_some() || s.w == 0 || !convex_overlap(&g, &sp), "township {}'s ground on site {k} ({})", a.id, s.kind);
            }
        }
        // only townships have plots
        assert!(l.lots.iter().all(|x| x.kind == "hq" || x.annex.is_none()));
    }
}
