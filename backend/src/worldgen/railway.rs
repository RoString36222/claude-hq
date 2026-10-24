//! The @3 railways (`layers.rail`): the City Line and the Island Link.
//!
//!   CL  (kind "city", tier 4) Central - 0-2 neighbourhood stops - Port - Airport (Central -
//!       Airport with no port, Central - Port with no airport), elevated 9 m over the
//!       streets along the arterials (cheapest street path, arterials preferred, smoothed to
//!       no curve under 150 m), `bridge` where it is over water, `viaduct` elsewhere.
//!       Stations are elevated boxes over the street (80 m platforms, two of them), their
//!       stairs and lift feet on the pavement, never on a carriageway
//!   IL  (kind "island", tier 2) from Central's underground platforms (22 m down, under the
//!       metro interchange) straight through a tunnel, climbing at 4 % at most, to a portal
//!       on open land near the coast (its open trench a terrain hole in `holes`), then at
//!       grade and onto a viaduct to `sea`: the abutment on the coast, 9 m over the ground,
//!       its front out to sea. The coast point is seeded, away from the river's mouth and
//!       the airport. On the Commons the IL's station is Commons Central, a terminal of six
//!       platforms, and `sea` is the Commons' sea junction
//!
//! Claims: the IL portal's trench (`rail:<n>`, n after the stations' numbers). The City
//! Line's stations stand over streets and claim no land. Integer arithmetic only, seeded
//! with the salt "railway".

use serde::Serialize;

use super::lines::{ahead, align, arr, dist, length, min_radius, pts, resample, tune, Claim, Ctx, Land, Net, Stop, MIN_RADIUS_CM, P, STEP_CM};
use super::metro::{band, Metro};
use super::organic::geom::{left, nearest_on, unit};
use super::rng::{sub, Rng};
use super::transit::door;

#[derive(Serialize, Clone, Default, Debug)]
pub struct Rail {
    pub lines: Vec<Line>,
    pub stations: Vec<Station>,
    /// The Island Link's abutment on the coast (an island) or sea junction (the Commons).
    pub sea: Option<Sea>,
    /// Terrain holes (the Island Link's portal trench), cut like `layers.metro.holes`.
    pub holes: Vec<Vec<[i64; 2]>>,
}

#[derive(Serialize, Clone, Debug)]
pub struct Line {
    pub id: String,
    /// "city" or "island".
    pub kind: &'static str,
    pub stations: Vec<String>,
    /// The track's centre, [x, y, z] cm, y the rail level.
    pub path: Vec<[i64; 3]>,
    /// Per path segment: "viaduct", "bridge", "tunnel", "portal" or "grade".
    pub kinds: Vec<&'static str>,
    pub tier: u8,
}

#[derive(Serialize, Clone, Debug)]
pub struct Station {
    pub id: String,
    /// "elevated", "underground" or "terminal".
    pub kind: &'static str,
    pub x: i64,
    /// The rail level at the platforms (cm).
    pub y: i64,
    pub z: i64,
    pub along: [i64; 2],
    pub len: i64,
    pub platforms: u32,
    pub lines: Vec<String>,
    /// The street feet of the stairs and lift (elevated), or the hub's door (underground).
    pub stairs: Vec<[i64; 2]>,
}

#[derive(Serialize, Clone, Copy, Debug)]
pub struct Sea {
    pub x: i64,
    pub z: i64,
    pub y: i64,
    /// Out to sea (Q16 unit).
    pub front: [i64; 2],
}

pub const CL_TIER: u8 = 4;
pub const IL_TIER: u8 = 2;
/// The City Line's rail level over the ground, and its platforms.
pub const CL_HEIGHT_CM: i64 = 900;
pub const CL_PLATFORM_CM: i64 = 8_000;
/// The Island Link's platforms: rail level under the ground, length.
pub const IL_DEPTH_CM: i64 = 2_200;
pub const IL_PLATFORM_CM: i64 = 10_000;
/// The abutment's rail level over the coast's ground.
pub const SEA_HEIGHT_CM: i64 = 300;
const GRADE_PM: i64 = 40;
/// Under this much ground the climbing track runs in an open trench (above it, a covered box).
const COVER_CM: i64 = 300;
const TRENCH_W_CM: i64 = 1_200;
/// A City Line leg this long by street gets a neighbourhood stop (two past the second).
const MID_STOP_CM: i64 = 100_000;
const TWO_STOPS_CM: i64 = 180_000;
/// The airport's keep-out for the Island Link's portal (cm).
const AIRPORT_CLEAR_CM: i64 = 45_000;

fn cost(class: &str) -> i64 {
    match class {
        "arterial" => 1_000,
        "highway" | "ring" => 1_100,
        _ => 2_500,
    }
}

pub fn plan(c: &Ctx, m: &Metro) -> Result<(Rail, Vec<Claim>), String> {
    let mut land = Land::new(c);
    // what the metro holds: its depots, trenches and entrances
    for d in &m.depots {
        land.taken.push(pts(&d.poly));
    }
    for h in &m.holes {
        land.taken.push(pts(h));
    }
    for e in &m.entrances {
        land.taken.push(pts(&super::lines::rect((e.x, e.z), (e.front[0], e.front[1]), e.d, e.w)));
    }
    let net = Net::new(c.roads);
    let mut rng = Rng::new(sub(c.seed, "railway", 0, 0));
    let mut r = Rail::default();
    let mut claims = Vec::new();
    let Some(hub) = c.sites.iter().find(|s| s.kind == "transit") else {
        return Ok((r, claims));
    };
    let hq = door(hub);
    let dry: Vec<bool> = (0..c.roads.nodes.len() as u32).map(|n| net.degree(n) > 0 && !land.wet(net.pos(n))).collect();
    let central = net
        .nearest(hq, |n| dry[n as usize] && net.arterial_degree(n) >= 1)
        .or_else(|| net.nearest(hq, |n| dry[n as usize]))
        .ok_or("railway: no street for Central")?;

    // the City Line
    let targets: Vec<P> = ["port", "airport"].iter().filter_map(|k| c.sites.iter().find(|s| s.kind == *k)).map(door).collect();
    if !targets.is_empty() {
        if let Some(cl) = city_line(&land, &net, central, &targets, &dry) {
            let (path, at, stops) = cl;
            let ys = viaduct_levels(&land, &path);
            let kinds: Vec<&'static str> = path.windows(2).map(|w| if land.wet(mid(w[0], w[1])) { "bridge" } else { "viaduct" }).collect();
            let mut ids = Vec::new();
            for (k, s) in stops.iter().enumerate() {
                let id = format!("rail:{}", r.stations.len());
                let p = path[at[k]];
                r.stations.push(Station {
                    id: id.clone(),
                    kind: "elevated",
                    x: p.0,
                    y: ys[at[k]],
                    z: p.1,
                    along: arr(s.along),
                    len: CL_PLATFORM_CM,
                    platforms: 2,
                    lines: vec!["CL".into()],
                    stairs: stairs(c, &land, p),
                });
                ids.push(id);
            }
            r.lines.push(Line { id: "CL".into(), kind: "city", stations: ids, path: path.iter().zip(&ys).map(|(q, &y)| [q.0, y, q.1]).collect(), kinds, tier: CL_TIER });
        }
    }

    // the Island Link
    if let Some(coast) = c.coast {
        let centre = m.stations.iter().find(|s| s.lines.len() > 1).map(|s| (s.x, s.z)).unwrap_or(net.pos(central));
        let commons = c.profile.name == "commons";
        if let Some(il) = island_link(c, &land, centre, coast, &mut rng) {
            let id = format!("rail:{}", r.stations.len());
            r.stations.push(Station {
                id: id.clone(),
                kind: if commons { "terminal" } else { "underground" },
                x: centre.0,
                y: il.ys[il.at],
                z: centre.1,
                along: arr(il.dir),
                len: IL_PLATFORM_CM,
                platforms: if commons { 6 } else { 2 },
                lines: vec!["IL".into()],
                stairs: vec![arr(hq)],
            });
            r.holes.push(il.trench.clone());
            let ctr = il.trench_mid;
            claims.push(Claim { kind: "rail", id: String::new(), x: ctr.0, z: ctr.1, poly: il.trench.clone(), front: arr(il.dir), tier: IL_TIER, lot: None });
            r.sea = Some(Sea { x: il.sea.0, z: il.sea.1, y: *il.ys.last().unwrap(), front: arr(il.dir) });
            r.lines.push(Line {
                id: "IL".into(),
                kind: "island",
                stations: vec![id],
                path: il.path.iter().zip(&il.ys).map(|(q, &y)| [q.0, y, q.1]).collect(),
                kinds: il.kinds,
                tier: IL_TIER,
            });
        }
    }
    let n = r.stations.len();
    for (k, cl) in claims.iter_mut().enumerate() {
        cl.id = format!("rail:{}", n + k);
    }
    Ok((r, claims))
}

fn mid(a: P, b: P) -> P {
    ((a.0 + b.0) / 2, (a.1 + b.1) / 2)
}

/// The City Line's track: (path, each stop's path index, stops) from Central through the
/// targets in order, with neighbourhood stops on long legs.
fn city_line(land: &Land, net: &Net, central: u32, targets: &[P], dry: &[bool]) -> Option<(Vec<P>, Vec<usize>, Vec<Stop>)> {
    let mut nodes = vec![central];
    for &t in targets {
        let n = net.nearest(t, |n| dry[n as usize] && net.arterial_degree(n) + net.degree(n) > 0)?;
        if n != *nodes.last().unwrap() && dist(net.pos(n), net.pos(*nodes.last().unwrap())) >= 20_000 {
            nodes.push(n);
        }
    }
    if nodes.len() < 2 {
        return None;
    }
    // each leg's street line, and its stops (the leg's start, then mid stops)
    let mut at: Vec<P> = vec![net.pos(nodes[0])];
    let mut guides: Vec<Vec<P>> = Vec::new();
    let mut mids = 0;
    for w in nodes.windows(2) {
        let leg = net.path(w[0], w[1], &cost)?;
        let (line, _) = net.line(&leg, &cost);
        let total = length(&line);
        let want = if mids >= 2 { 0 } else if total >= TWO_STOPS_CM && mids == 0 { 2 } else if total >= MID_STOP_CM { 1 } else { 0 };
        let mut cut = vec![0usize];
        let mut cum = 0;
        let mut k = 1;
        for i in 1..line.len() {
            cum += dist(line[i - 1], line[i]);
            if k <= want && cum >= total * k as i64 / (want as i64 + 1) && !land.wet(line[i]) {
                cut.push(i);
                k += 1;
            }
        }
        mids += cut.len() - 1;
        cut.push(line.len() - 1);
        for cw in cut.windows(2) {
            guides.push(line[cw[0]..=cw[1]].to_vec());
            at.push(line[cw[1]]);
        }
    }
    let mut stops: Vec<Stop> = (0..at.len())
        .map(|k| {
            let (a, b) = (at[k.saturating_sub(1)], at[(k + 1).min(at.len() - 1)]);
            Stop { at: at[k], along: unit((b.0 - a.0, b.1 - a.1)) }
        })
        .collect();
    tune(&mut stops, None, CL_PLATFORM_CM, 16_000);
    let (path, idx) = align(&stops, &guides, CL_PLATFORM_CM);
    if min_radius(&path, 1) < MIN_RADIUS_CM {
        return None;
    }
    Some((path, idx, stops))
}

/// Rail levels 9 m over the ground (the water's surface over water), eased over 9 points.
fn viaduct_levels(land: &Land, path: &[P]) -> Vec<i64> {
    let sea = land.c.profile.sea_cm.unwrap_or(0);
    let g: Vec<i64> = path.iter().map(|&q| if land.wet(q) { land.height(q).max(sea) } else { land.height(q) }).collect();
    let n = g.len() as i64;
    (0..n)
        .map(|i| {
            let (a, b) = ((i - 4).max(0), (i + 4).min(n - 1));
            let avg = (a..=b).map(|j| g[j as usize]).max().unwrap_or(0);
            avg + CL_HEIGHT_CM
        })
        .collect()
}

/// Two to four stair and lift feet on the pavement of the streets under an elevated
/// station at q: off every carriageway, on dry land, 10 m apart.
fn stairs(c: &Ctx, land: &Land, q: P) -> Vec<[i64; 2]> {
    let mut cands: Vec<(i64, P)> = Vec::new();
    for e in &c.roads.edges {
        if e.walk <= 0 {
            continue;
        }
        for w in e.points.windows(2) {
            let (a, b) = ((w[0][0], w[0][2]), (w[1][0], w[1][2]));
            let (pr, d2) = nearest_on(q, a, b);
            if d2 > 2_000 * 2_000 || a == b {
                continue;
            }
            let d = unit((b.0 - a.0, b.1 - a.1));
            for t in [1_000, -1_000, 2_000, -2_000, 3_000, -3_000] {
                for side in [1, -1] {
                    let foot = ahead(ahead(pr, d, t), left(d), side * (e.width / 2 - e.walk / 2));
                    if land.off_carriageways(foot) && !land.wet(foot) {
                        cands.push((dist(foot, q), foot));
                    }
                }
            }
        }
    }
    cands.sort();
    let mut out: Vec<P> = Vec::new();
    for (_, f) in cands {
        if out.len() >= 4 {
            break;
        }
        if out.iter().all(|&o| dist(o, f) >= 1_000) {
            out.push(f);
        }
    }
    out.into_iter().map(arr).collect()
}

struct Link {
    path: Vec<P>,
    ys: Vec<i64>,
    kinds: Vec<&'static str>,
    /// The station's path index.
    at: usize,
    dir: P,
    trench: Vec<[i64; 2]>,
    trench_mid: P,
    sea: P,
}

/// The Island Link: straight from Central's platforms to a coast point (seeded, away from
/// the river's mouth and the airport), climbing at no more than 4 %; the portal's trench on
/// open land, the stretch at grade off the streets and lots.
fn island_link(c: &Ctx, land: &Land, centre: P, coast: &[[i64; 2]], rng: &mut Rng) -> Option<Link> {
    let mouth = c.river.and_then(|r| r.center.first().map(|&p| (p[0], p[1])));
    let airport = c.sites.iter().find(|s| s.kind == "airport").map(|s| (s.x, s.z));
    let sea_y = c.profile.sea_cm.unwrap_or(0);
    // coast points, best first: far from the mouth, a little seeded jitter
    let mut cands: Vec<(i64, P)> = coast
        .iter()
        .map(|&v| {
            let v = (v[0], v[1]);
            let away = mouth.map_or(0, |m| dist(v, m));
            (-(away + rng.range(0, 8_000)), v)
        })
        .collect();
    cands.sort();
    let h0 = land.height(centre);
    let y_plat = h0 - IL_DEPTH_CM;
    for (_, v0) in cands {
        let dir = unit((v0.0 - centre.0, v0.1 - centre.1));
        // the abutment: on the coast, a step in so it stands on the land's edge
        let v = ahead(v0, dir, -300);
        if airport.is_some_and(|a| dist(a, v) < AIRPORT_CLEAR_CM) {
            continue;
        }
        let start = ahead(centre, dir, -IL_PLATFORM_CM / 2);
        let pend = ahead(centre, dir, IL_PLATFORM_CM / 2);
        let run = dist(pend, v);
        if run < 20_000 {
            continue;
        }
        let ya = land.height(v).max(sea_y) + SEA_HEIGHT_CM;
        if (ya - y_plat) * 1000 > run * GRADE_PM {
            continue;
        }
        // the track: the platform, then straight on to the abutment
        let mut path = resample(&[start, centre], STEP_CM);
        let at = path.len() - 1;
        path.extend(resample(&[centre, pend], STEP_CM).into_iter().skip(1));
        let p_at = path.len() - 1;
        path.extend(resample(&[pend, v], STEP_CM).into_iter().skip(1));
        let s_of = |q: P| dist(pend, q);
        let ys: Vec<i64> = path.iter().enumerate().map(|(i, &q)| if i <= p_at { y_plat } else { y_plat + (ya - y_plat) * s_of(q) / run }).collect();
        // classify by the cover over the track (ground minus rail level) at each segment's middle
        let mut kinds = Vec::new();
        let mut trench_pts: Vec<P> = Vec::new();
        let mut ok = true;
        let mut surfaced = false;
        for i in 0..path.len() - 1 {
            let q = mid(path[i], path[i + 1]);
            let y = (ys[i] + ys[i + 1]) / 2;
            let h = land.height(q);
            let cover = h - y;
            let k = if land.wet(q) {
                if cover > 0 && !surfaced { "tunnel" } else { "bridge" }
            } else if cover >= COVER_CM {
                if surfaced {
                    ok = false; // the ground rises over it again past the portal
                }
                "tunnel"
            } else if cover >= 0 {
                trench_pts.push(path[i]);
                trench_pts.push(path[i + 1]);
                surfaced = true;
                "portal"
            } else if cover >= -300 {
                surfaced = true;
                if !land.off_roads(q, 200) {
                    ok = false;
                }
                "grade"
            } else {
                surfaced = true;
                "viaduct"
            };
            kinds.push(k);
        }
        if !ok || trench_pts.is_empty() {
            continue;
        }
        trench_pts.dedup();
        if trench_pts.len() < 2 {
            continue;
        }
        let trench = band(&trench_pts, TRENCH_W_CM);
        if land.stand(&pts(&trench), 300, false, 1_000).is_none() {
            continue;
        }
        // the stretch at grade is on no lot
        let grade: Vec<P> = (0..kinds.len()).filter(|&i| kinds[i] == "grade").flat_map(|i| [path[i], path[i + 1]]).collect();
        if grade.len() >= 2 && !land.lots_under(&pts(&band(&grade, TRENCH_W_CM))).is_empty() {
            continue;
        }
        let tm = trench_pts[trench_pts.len() / 2];
        return Some(Link { path, ys, kinds, at, dir, trench, trench_mid: tm, sea: v });
    }
    None
}
