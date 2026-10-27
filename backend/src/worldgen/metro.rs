//! The @3 metro (`layers.metro`): two lines in real tunnels under the streets.
//!
//!   lines     M1 (roughly east-west) and M2 (north-south) cross at Central, the transit
//!             hub's arterial junction: M1 above, M2 below, at right angles. Each runs
//!             out to a far site in its compass sector (port, stadium, university...)
//!             along the street network (cheapest node path, arterials preferred), the
//!             tunnel following the street centre lines smoothed to no curve under 150 m
//!   stations  4-8 a line, 450-800 m apart, at arterial junctions where there are some;
//!             90 m platforms (side platforms; Central an island), the ticket hall 5 m
//!             under the street
//!   levels    rail level 12-16 m under the ground (M1 about 13 m, M2 about 15 m);
//!             `cutcover` within 120 m of a station, `bored` between
//!   entrances 2-4 a station at the back of the pavement or on a corner plaza (a small
//!             non-hq lot it claims), one at least a lift; each has its stair well's hole
//!   ends      one end climbs at 4 % through a cut-and-cover `portal` (the ramp; its open
//!             trench is a terrain hole) on open, gentle land into an open-air depot of
//!             four stabling tracks (`open`); the other end is a tunnel terminus with a
//!             150 m headshunt
//!
//! Claims: every entrance (`metro-entrance:<n>`, its footprint), and per line the portal's
//! trench (`metro:<n>`, n after the stations' numbers) and its depot (`depot:<n>`).
//! Integer arithmetic only (cm, Q16), seeded from the world seed with the salt "metro".

use serde::Serialize;

use super::lines::{ahead, align, around, arr, dist, dubins, left, length, min_radius, neg, pts, tune, MIN_RADIUS_CM, rect, resample, Claim, Ctx, Land, Net, OpenMap, Stop, P, STEP_CM};
use super::noise::ONE;
use super::organic::geom::{dot, turn, unit, DIR16};
use super::rng::{sub, Rng};
use super::transit::door;

#[derive(Serialize, Clone, Default, Debug)]
pub struct Metro {
    pub lines: Vec<Line>,
    pub stations: Vec<Station>,
    pub entrances: Vec<Entrance>,
    pub portals: Vec<Portal>,
    pub depots: Vec<Depot>,
    /// Every terrain hole the metro needs (entrances' stair wells, portals' trenches).
    pub holes: Vec<Vec<[i64; 2]>>,
}

#[derive(Serialize, Clone, Debug)]
pub struct Line {
    pub id: String,
    pub stations: Vec<String>,
    /// The track's centre, [x, y, z] cm, y the rail level.
    pub path: Vec<[i64; 3]>,
    /// Per path segment: "bored", "cutcover", "portal" or "open".
    pub kinds: Vec<&'static str>,
    pub depot: Option<String>,
    pub tier: u8,
}

#[derive(Serialize, Clone, Debug)]
pub struct Station {
    pub id: String,
    pub x: i64,
    /// The rail level (cm).
    pub y: i64,
    pub z: i64,
    /// The track's direction (Q16 unit).
    pub along: [i64; 2],
    pub len: i64,
    /// "side" or "island".
    pub platform: &'static str,
    /// This station's line first; an interchange lists the other line too.
    pub lines: Vec<String>,
    pub hall_y: i64,
    pub entrances: Vec<String>,
}

#[derive(Serialize, Clone, Debug)]
pub struct Entrance {
    pub id: String,
    pub station: String,
    pub x: i64,
    pub z: i64,
    /// Street level (cm).
    pub y: i64,
    /// The way down (Q16 unit).
    pub front: [i64; 2],
    /// Footprint: `w` across `front`, `d` along it (cm).
    pub w: i64,
    pub d: i64,
    /// "stairs", "escalator" or "lift".
    pub kind: &'static str,
    pub hole: Vec<[i64; 2]>,
}

#[derive(Serialize, Clone, Debug)]
pub struct Portal {
    pub id: String,
    pub line: String,
    /// The headwall: where the tunnel's roof ends and the open trench begins.
    pub x: i64,
    pub z: i64,
    /// Ground level at the headwall (cm).
    pub y: i64,
    /// Toward the tunnel (Q16 unit).
    pub front: [i64; 2],
    /// The trench's width and length (cm), from the headwall to where the track meets the ground.
    pub w: i64,
    pub len: i64,
    pub hole: Vec<[i64; 2]>,
}

#[derive(Serialize, Clone, Debug)]
pub struct Depot {
    pub id: String,
    pub line: String,
    pub poly: Vec<[i64; 2]>,
    /// Stabling tracks, [x, y, z] cm.
    pub tracks: Vec<Vec<[i64; 3]>>,
}

pub const TIER: u8 = 3;
pub const PLATFORM_CM: i64 = 9_000;
/// Rail level under the ground (cm): the band, and each line's aim in it (M1 above M2).
pub const DEPTH_MIN_CM: i64 = 1_200;
pub const DEPTH_MAX_CM: i64 = 1_600;
const DEPTH_CM: [i64; 2] = [1_300, 1_500];
/// Station spacing along the finished track.
pub const APART_TRACK_MIN_CM: i64 = 45_000;
pub const APART_TRACK_MAX_CM: i64 = 80_000;
/// Station picks along the streets: (least by street, least in a straight line, aim),
/// tried in turn; the track checks the result.
const SPACINGS: [(i64, i64, i64); 6] = [(52_000, 38_000, 62_000), (52_000, 38_000, 54_000), (48_000, 42_000, 52_000), (46_000, 45_500, 50_000), (55_000, 30_000, 58_000), (50_000, 45_500, 60_000)];
const APART_MAX_CM: i64 = 78_000;
/// How far by street (cost-weighted) a line may run out from Central.
const REACH_CM: i64 = 400_000;
const COS60: i64 = 32_768;
const COS70: i64 = 22_415;
const MAX_STATIONS: usize = 8;
const MIN_STATIONS: usize = 4;
/// A small island whose streets hold no four-station line gets three (Central and one each side).
const SMALL_STATIONS: usize = 3;
const HALL_CM: i64 = 500;
const CUTCOVER_CM: i64 = 12_000;
const HEADSHUNT_CM: i64 = 15_000;
/// The ramp's grade (per mille) and the box tunnel's height: shallower than this the
/// ramp is an open trench.
const GRADE_PM: i64 = 40;
const COVER_CM: i64 = 700;
pub const TRENCH_W_CM: i64 = 1_200;
pub const DEPOT_LEN_CM: i64 = 16_000;
pub const DEPOT_W_CM: i64 = 6_000;
/// Entrance footprint (across, along the way down) and its hole.
pub const ENT_W_CM: i64 = 500;
pub const ENT_D_CM: i64 = 1_100;
const STAIR_HOLE: (i64, i64) = (400, 900);
const LIFT_HOLE: (i64, i64) = (300, 300);
/// The far sites a line runs out to, best first.
const FAR: [&str; 12] = ["port", "airport", "stadium", "university", "campus", "hospital", "mall", "studio", "carpark", "school", "power", "water"];

fn cost(class: &str) -> i64 {
    match class {
        "arterial" => 1_000,
        "highway" | "ring" => 1_150,
        _ => 1_700,
    }
}

pub fn plan(c: &Ctx) -> Result<(Metro, Vec<Claim>), String> {
    let mut land = Land::new(c);
    let net = Net::new(c.roads);
    let mut rng = Rng::new(sub(c.seed, "metro", 0, 0));
    let mut m = Metro::default();
    let mut claims = Vec::new();
    let Some(hub) = c.sites.iter().find(|s| s.kind == "transit") else {
        return Ok((m, claims));
    };
    let hq = door(hub);
    let dry: Vec<bool> = (0..c.roads.nodes.len() as u32).map(|n| net.degree(n) > 0 && !land.wet(net.pos(n))).collect();
    let usable = |n: u32| dry[n as usize];
    let central = net
        .nearest(hq, |n| usable(n) && net.arterial_degree(n) >= 3 && dist(net.pos(n), hq) <= 20_000)
        .or_else(|| net.nearest(hq, |n| usable(n) && net.arterial_degree(n) >= 1))
        .or_else(|| net.nearest(hq, usable))
        .ok_or("metro: no street for Central")?;
    let cp = net.pos(central);
    let (td, tp) = net.tree(central, &cost);

    // each line's stations, alignment and depot: the first layout that checks out
    let open = OpenMap::new(&land);
    let fits = open.fits(DEPOT_LEN_CM, DEPOT_W_CM, 2);
    let mut built: Vec<Built> = Vec::new();
    let mut ends: Vec<P> = Vec::new();
    for li in 0..2usize {
        // M2 runs out along the perpendicular to M1's platform at Central
        let axis = match built.first() {
            Some(b0) => {
                let l = left(b0.stops[b0.central].along);
                if l.1.abs() >= l.0.abs() { if l.1 > 0 { l } else { neg(l) } } else if l.0 > 0 { l } else { neg(l) }
            }
            None if li == 0 => (ONE, 0),
            None => (0, ONE),
        };
        // each side's options: (street line, stations on it), most stations first
        let mut sides: Vec<Vec<(Vec<P>, Vec<usize>)>> = Vec::new();
        for side in [neg(axis), axis] {
            let mut opts: Vec<(Vec<P>, Vec<usize>)> = Vec::new();
            for end in far_ends(c, &net, &land, cp, side, &td, &ends, &usable) {
                let Some(nodes) = Net::walk(&tp, &td, end) else { continue };
                let (line, at) = net.line(&nodes, &cost);
                for sp in SPACINGS {
                    let picks = pick(&line, &at, &nodes, &net, &land, side, sp);
                    if !picks.is_empty() && !opts.iter().any(|o| o.1.len() == picks.len() && o.0.last() == line.last() && o.1 == picks) {
                        opts.push((line.clone(), picks));
                    }
                }
            }
            opts.sort_by_key(|o| std::cmp::Reverse(o.1.len().min(MAX_STATIONS / 2)));
            opts.truncate(12);
            sides.push(opts);
        }
        let mut combos: Vec<(usize, usize, usize)> = Vec::new();
        for (i, a) in sides[0].iter().enumerate() {
            for (j, b) in sides[1].iter().enumerate() {
                let n = (a.1.len() + b.1.len() + 1).min(MAX_STATIONS);
                if n >= SMALL_STATIONS {
                    combos.push((n, i, j));
                }
            }
        }
        combos.sort_by_key(|&(n, i, j)| (std::cmp::Reverse(n), i + j, i));
        // three stations only where four will not go (a small island)
        let (four, three): (Vec<_>, Vec<_>) = combos.into_iter().partition(|c| c.0 >= MIN_STATIONS);
        let combos: Vec<(usize, usize, usize)> = four.into_iter().take(24).chain(three.into_iter().take(8)).collect();
        let mut done: Option<(Built, Option<Built>)> = None;
        for &(n_st, i, j) in combos.iter() {
            if n_st < MIN_STATIONS && done.is_some() {
                break;
            }
            let (la, pa) = &sides[0][i];
            let (lb, pb) = &sides[1][j];
            let mut guide: Vec<P> = la.iter().rev().copied().collect();
            let off = guide.len() - 1;
            guide.extend_from_slice(&lb[1..]);
            let mut idx: Vec<usize> = pa.iter().rev().map(|&i| off - i).collect();
            idx.push(off);
            idx.extend(pb.iter().map(|&i| off + i));
            // keep at most MAX_STATIONS, trimming the longer side
            let mut ci = pa.len();
            while idx.len() > MAX_STATIONS {
                if ci >= idx.len() - 1 - ci {
                    idx.remove(0);
                    ci -= 1;
                } else {
                    idx.pop();
                }
            }
            let at: Vec<P> = idx.iter().map(|&i| guide[i]).collect();
            let mut stops: Vec<Stop> = (0..at.len())
                .map(|k| {
                    let (a, b) = (at[k.saturating_sub(1)], at[(k + 1).min(at.len() - 1)]);
                    Stop { at: at[k], along: unit((b.0 - a.0, b.1 - a.1)) }
                })
                .collect();
            stops[ci].at = cp;
            // M2 crosses M1 at right angles at Central: M1's platform there turns (within
            // 45 degrees) to suit both lines, and M1 is laid again if it moved
            let mut m1_again: Option<Built> = None;
            if let Some(b0) = built.first() {
                let chord = stops[ci].along;
                let base = b0.stops[b0.central].along;
                let perp = |a1: P| {
                    let l = left(a1);
                    if dot(l, chord) >= 0 { l } else { neg(l) }
                };
                let mut best = (i64::MAX, 0i64);
                for deg in (-45..=45).step_by(5) {
                    let a1 = unit(turn(base, deg));
                    let mut s1 = b0.stops.clone();
                    s1[b0.central].along = a1;
                    let mut s2 = stops.clone();
                    s2[ci].along = perp(a1);
                    tune(&mut s2, Some(ci), PLATFORM_CM, 16_000);
                    let cost = around(&s1, b0.central, PLATFORM_CM, 16_000) + around(&s2, ci, PLATFORM_CM, 16_000);
                    if cost < best.0 {
                        best = (cost, deg);
                    }
                }
                let mut a1 = unit(turn(base, best.1));
                if best.1 != 0 {
                    let mut s1 = b0.stops.clone();
                    s1[b0.central].along = a1;
                    tune(&mut s1, Some(b0.central), PLATFORM_CM, 16_000);
                    let (path1, at1) = align(&s1, &b0.guides, PLATFORM_CM);
                    let mut nb = Built { li: 0, stops: s1, central: b0.central, path: path1, at: at1, guides: b0.guides.clone(), ext: None, first: b0.first };
                    let mut ok = line_ok(&nb.path, &nb.at);
                    if ok {
                        let saved = land.taken.clone();
                        if b0.ext.as_ref().is_some_and(|e| e.0 < 2) {
                            land.taken.truncate(land.taken.len() - 2);
                        }
                        nb.ext = settle_ends(&nb, &land, &open, &fits, b0.first);
                        land.taken = saved;
                        let had = b0.ext.as_ref().is_some_and(|e| e.0 < 2);
                        ok = !had || nb.ext.as_ref().is_some_and(|e| e.0 < 2);
                    }
                    if ok {
                        m1_again = Some(nb);
                    } else {
                        a1 = base; // M1 stays as laid
                    }
                }
                stops[ci].along = perp(a1);
            }
            tune(&mut stops, (!built.is_empty()).then_some(ci), PLATFORM_CM, 16_000);
            let guides: Vec<Vec<P>> = idx.windows(2).map(|w| guide[w[0]..=w[1]].to_vec()).collect();
            let (path, sat) = align(&stops, &guides, PLATFORM_CM);
            if !line_ok(&path, &sat) {
                continue;
            }
            let first = rng.range(0, 1) as usize;
            let mut b = Built { li, stops, central: ci, path, at: sat, guides, ext: None, first };
            // M2's depot keeps clear of M1's as it will stand
            let saved = land.taken.clone();
            if let (Some(nb), Some(b0)) = (&m1_again, built.first()) {
                if b0.ext.as_ref().is_some_and(|e| e.0 < 2) {
                    land.taken.truncate(land.taken.len() - 2);
                }
                if let Some((_, _, _, x)) = nb.ext.as_ref().filter(|e| e.0 < 2) {
                    land.taken.push(pts(&x.trench));
                    land.taken.push(pts(&x.depot));
                }
            }
            b.ext = settle_ends(&b, &land, &open, &fits, first);
            land.taken = saved;
            let has_depot = b.ext.as_ref().is_some_and(|e| e.0 < 2);
            if done.is_none() || has_depot {
                done = Some((b, m1_again));
            }
            if has_depot {
                break;
            }
        }
        let done = done.map(|(b, again)| {
            if let Some(nb) = again {
                // M1 laid again: its depot changes
                if built[0].ext.as_ref().is_some_and(|e| e.0 < 2) {
                    land.taken.truncate(land.taken.len() - 2);
                }
                if let Some((_, _, _, x)) = nb.ext.as_ref().filter(|e| e.0 < 2) {
                    land.taken.push(pts(&x.trench));
                    land.taken.push(pts(&x.depot));
                }
                built[0] = nb;
            }
            b
        });
        let Some(b) = done else { continue };
        if let Some((_, _, _, x)) = b.ext.as_ref().filter(|e| e.0 < 2) {
            land.taken.push(pts(&x.trench));
            land.taken.push(pts(&x.depot));
        }
        ends.push(b.stops[0].at);
        ends.push(b.stops[b.stops.len() - 1].at);
        built.push(b);
    }

    let mut station_n = 0usize;
    let mut central_ids: Vec<String> = Vec::new();
    for b in built.iter() {
        let name = format!("M{}", b.li + 1);
        let depth = DEPTH_CM[b.li];
        let ext = b.ext.clone();
        let (e, lo, hi, x) = ext.unwrap_or((2, 0, b.path.len() - 1, Ext::default()));
        // the line's track: [headshunt or ramp] main [ramp or headshunt], in the line's order
        let main = b.path[lo..=hi].to_vec();
        let keep: Vec<usize> = (0..b.stops.len()).filter(|&k| b.at[k] >= lo && b.at[k] <= hi).collect();
        let hs = |from: P, dir: P| -> Vec<P> { (1..=HEADSHUNT_CM / STEP_CM).map(|k| ahead(from, dir, k * STEP_CM)).collect() };
        let nm = main.len();
        let start_dir = unit((main[0].0 - main[1].0, main[0].1 - main[1].1));
        let end_dir = unit((main[nm - 1].0 - main[nm - 2].0, main[nm - 1].1 - main[nm - 2].1));
        // (point, ramp level and kind where the ramp sets them)
        let mut track: Vec<(P, Option<(i64, &'static str)>)> = Vec::new();
        if e == 0 {
            track.extend(x.pts.iter().enumerate().rev().map(|(k, &q)| (q, Some((x.y[k], x.kind[k])))));
        } else {
            track.extend(hs(main[0], start_dir).into_iter().rev().map(|q| (q, None)));
        }
        let main_at = track.len();
        track.extend(main.iter().map(|&q| (q, None)));
        if e == 1 {
            track.extend(x.pts.iter().enumerate().map(|(k, &q)| (q, Some((x.y[k], x.kind[k])))));
        } else {
            track.extend(hs(main[nm - 1], end_dir).into_iter().map(|q| (q, None)));
        }
        let tp: Vec<P> = track.iter().map(|t| t.0).collect();
        // levels: the ramp's own where it has one, else the depth band under the ground
        let mut ys = levels(&land, &tp, depth);
        for (k, t) in track.iter().enumerate() {
            if let Some((y, _)) = t.1 {
                ys[k] = y;
            }
        }
        let st_idx: Vec<usize> = keep.iter().map(|&k| b.at[k] - lo + main_at).collect();
        let mut cum = vec![0i64; tp.len()];
        for i in 1..tp.len() {
            cum[i] = cum[i - 1] + dist(tp[i - 1], tp[i]);
        }
        let depth_ok = |j: usize| (DEPTH_MIN_CM..=DEPTH_MAX_CM).contains(&(land.height(tp[j]) - ys[j]));
        let kinds: Vec<&'static str> = (0..tp.len() - 1)
            .map(|i| {
                let fixed = [track[i].1, track[i + 1].1];
                if fixed.iter().any(|f| f.is_some_and(|f| f.1 == "open")) {
                    "open"
                } else if fixed.iter().any(|f| f.is_some()) && !(depth_ok(i) && depth_ok(i + 1)) {
                    "portal"
                } else if st_idx.iter().any(|&s| (cum[s] - cum[i]).abs() <= CUTCOVER_CM || (cum[s] - cum[i + 1]).abs() <= CUTCOVER_CM) {
                    "cutcover"
                } else {
                    "bored"
                }
            })
            .collect();

        // stations
        let mut ids = Vec::new();
        for (j, &k) in keep.iter().enumerate() {
            let p = tp[st_idx[j]];
            let central = k == b.central;
            let id = format!("metro:{station_n}");
            station_n += 1;
            let mut lines = vec![name.clone()];
            if central {
                lines.push(if b.li == 0 { "M2".into() } else { "M1".into() });
                central_ids.push(id.clone());
            }
            m.stations.push(Station {
                id: id.clone(),
                x: p.0,
                y: ys[st_idx[j]],
                z: p.1,
                along: arr(b.stops[k].along),
                len: PLATFORM_CM,
                platform: if central { "island" } else { "side" },
                lines,
                hall_y: land.height(p) - HALL_CM,
                entrances: vec![],
            });
            ids.push(id);
        }
        let depot = (e < 2).then(|| format!("depot:{}", m.depots.len()));
        if let Some(did) = &depot {
            m.portals.push(Portal {
                id: format!("portal:{}", m.portals.len()),
                line: name.clone(),
                x: x.head.0,
                z: x.head.1,
                y: land.height(x.head),
                front: arr(x.back),
                w: TRENCH_W_CM,
                len: x.trench_len,
                hole: x.trench.clone(),
            });
            m.holes.push(x.trench.clone());
            m.depots.push(Depot { id: did.clone(), line: name.clone(), poly: x.depot.clone(), tracks: x.tracks.clone() });
            let t = centre(&x.trench);
            claims.push(Claim { kind: "metro", id: String::new(), x: t.0, z: t.1, poly: x.trench.clone(), front: arr(x.back), tier: TIER, lot: None });
            let d = centre(&x.depot);
            claims.push(Claim { kind: "depot", id: did.clone(), x: d.0, z: d.1, poly: x.depot.clone(), front: arr(x.back), tier: TIER, lot: x.depot_lot });
        }
        m.lines.push(Line { id: name, stations: ids, path: tp.iter().zip(&ys).map(|(q, &y)| [q.0, y, q.1]).collect(), kinds, depot, tier: TIER });
    }
    // the trenches' sites, numbered after the stations
    for (n, cl) in (station_n..).zip(claims.iter_mut().filter(|cl| cl.kind == "metro")) {
        cl.id = format!("metro:{n}");
    }

    // entrances: Central's once (both its records list them), then every other station
    for si in 0..m.stations.len() {
        if central_ids.len() == 2 && m.stations[si].id == central_ids[1] {
            continue;
        }
        let s = &m.stations[si];
        let want = if central_ids.contains(&s.id) { 4 } else { 2 + rng.range(0, 2) as usize };
        let (q, sid) = ((s.x, s.z), s.id.clone());
        let found = entrances(&mut land, c, q, want, &mut rng);
        let mut ids = Vec::new();
        for (k, (poly, front, lot)) in found.into_iter().enumerate() {
            let n = m.entrances.len();
            let id = format!("ent:{n}");
            let kind = match k {
                0 => "lift",
                1 => "escalator",
                _ => "stairs",
            };
            let ctr = centre(&poly);
            let (hw, hd) = if kind == "lift" { LIFT_HOLE } else { STAIR_HOLE };
            let hole = rect(ctr, front, hd, hw);
            m.holes.push(hole.clone());
            m.entrances.push(Entrance { id: id.clone(), station: sid.clone(), x: ctr.0, z: ctr.1, y: land.height(ctr), front: arr(front), w: ENT_W_CM, d: ENT_D_CM, kind, hole });
            claims.push(Claim { kind: "metro-entrance", id: format!("metro-entrance:{n}"), x: ctr.0, z: ctr.1, poly, front: arr(front), tier: TIER, lot });
            ids.push(id);
        }
        m.stations[si].entrances = ids;
    }
    if central_ids.len() == 2 {
        let e0 = m.stations.iter().find(|s| s.id == central_ids[0]).map(|s| s.entrances.clone()).unwrap_or_default();
        if let Some(s) = m.stations.iter_mut().find(|s| s.id == central_ids[1]) {
            s.entrances = e0;
        }
    }
    Ok((m, claims))
}

/// A line before its ends are settled.
struct Built {
    li: usize,
    stops: Vec<Stop>,
    central: usize,
    path: Vec<P>,
    at: Vec<usize>,
    /// The street centre lines between consecutive stops.
    guides: Vec<Vec<P>>,
    /// The portal end (0 the first, 1 the last, 2 none), the path's kept span and the ramp.
    ext: Option<(usize, usize, usize, Ext)>,
    /// The end tried first for the portal (seeded).
    first: usize,
}

/// Station gaps along the track in range and no curve too tight.
fn line_ok(path: &[P], at: &[usize]) -> bool {
    at.windows(2).all(|w| (APART_TRACK_MIN_CM..=APART_TRACK_MAX_CM).contains(&length(&path[w[0]..=w[1]]))) && min_radius(path, 1) >= MIN_RADIUS_CM && min_radius(path, 2) >= MIN_RADIUS_CM
}

/// The line's portal and depot: tried at the `first` end, then the other, then with
/// stations dropped at the end (never Central, never under `MIN_STATIONS`).
fn settle_ends(b: &Built, land: &Land, open: &OpenMap, fits: &[(P, usize)], first: usize) -> Option<(usize, usize, usize, Ext)> {
    let depth = DEPTH_CM[b.li];
    for drop in 0..=b.stops.len().saturating_sub(MIN_STATIONS) {
        for e in [first, 1 - first] {
            let n = b.stops.len();
            let keep: Vec<usize> = if e == 1 { (0..n - drop).collect() } else { (drop..n).collect() };
            if !keep.contains(&b.central) || keep.len() < MIN_STATIONS.min(b.stops.len()) {
                continue;
            }
            let half = (PLATFORM_CM / 2 / STEP_CM) as usize + 1;
            let lo = b.at[keep[0]].saturating_sub(half);
            let hi = (b.at[*keep.last().unwrap()] + half).min(b.path.len() - 1);
            let mut path = b.path[lo..=hi].to_vec();
            if e == 0 {
                path.reverse();
            }
            let y0 = levels(land, &path, depth).last().copied().unwrap();
            if let Some(x) = depot_link(land, open, fits, &path, y0, depth) {
                return Some((e, lo, hi, x));
            }
        }
    }
    None
}

/// A portal end: the ramp and depot entry beyond the last platform (points, levels, kinds),
/// the portal's headwall, the trench and the depot.
#[derive(Default, Clone)]
struct Ext {
    pts: Vec<P>,
    y: Vec<i64>,
    kind: Vec<&'static str>,
    head: P,
    back: P,
    trench_len: i64,
    trench: Vec<[i64; 2]>,
    depot: Vec<[i64; 2]>,
    depot_lot: Option<u32>,
    tracks: Vec<Vec<[i64; 3]>>,
}

fn centre(poly: &[[i64; 2]]) -> P {
    let n = poly.len().max(1) as i64;
    (poly.iter().map(|p| p[0]).sum::<i64>() / n, poly.iter().map(|p| p[1]).sum::<i64>() / n)
}

/// Where a line may run out to on one side of Central (60 degrees either side of
/// `side`): far sites' nodes first, then the nodes farthest by street, ten at most, each
/// 150 m from the others.
#[allow(clippy::too_many_arguments)]
fn far_ends(c: &Ctx, net: &Net, land: &Land, cp: P, side: P, td: &[i64], avoid: &[P], usable: &impl Fn(u32) -> bool) -> Vec<u32> {
    let in_sector = |q: P| {
        let v = (q.0 - cp.0, q.1 - cp.1);
        dist(q, cp) >= 30_000 && dot(unit(v), side) >= COS60 as i128 * ONE as i128 && land.to_coast(q) >= 10_000 && avoid.iter().all(|&a| dist(a, q) >= 25_000)
    };
    let ok = |n: u32| usable(n) && td[n as usize] <= REACH_CM && in_sector(net.pos(n));
    let mut order: Vec<u32> = Vec::new();
    for &kind in FAR.iter() {
        for s in c.sites.iter().filter(|s| s.kind == kind) {
            if let Some(n) = net.nearest(door(s), ok) {
                if dist(net.pos(n), door(s)) <= 10_000 {
                    order.push(n);
                }
            }
        }
    }
    let mut by_reach: Vec<u32> = (0..net.r.nodes.len() as u32).filter(|&n| ok(n)).collect();
    by_reach.sort_by_key(|&n| (std::cmp::Reverse(td[n as usize]), n));
    order.extend(by_reach);
    let mut out: Vec<u32> = Vec::new();
    for n in order {
        if out.len() >= 16 {
            break;
        }
        if out.iter().all(|&o| dist(net.pos(o), net.pos(n)) >= 15_000) {
            out.push(n);
        }
    }
    out
}

/// Stations out from Central (index 0, not returned) along a street line: each next one
/// 500-780 m on by street (and 350 m+ in a straight line) from the last, the best junction
/// in that window (arterial junctions first), nearest the aim; the aim that fits the most.
fn pick(line: &[P], at: &[usize], nodes: &[u32], net: &Net, land: &Land, side: P, sp: (i64, i64, i64)) -> Vec<usize> {
    let cone = COS60;
    let mut cum = vec![0i64; line.len()];
    for i in 1..line.len() {
        cum[i] = cum[i - 1] + dist(line[i - 1], line[i]);
    }
    let node_at = |i: usize| at.iter().position(|&j| j == i).map(|k| nodes[k]);
    let rank = |i: usize| match node_at(i) {
        Some(n) if net.arterial_degree(n) >= 3 => 3,
        Some(n) if net.degree(n) >= 3 => 2,
        Some(_) => 1,
        None => 0,
    };
    let run = |aim: i64| {
        let mut out: Vec<usize> = Vec::new();
        let mut last = 0usize;
        loop {
            // the way the line comes in: the last chord, or (from Central) the sector's axis and cone
            let (way, cos) = match out.len() {
                0 => (side, cone),
                1 => (unit((line[out[0]].0 - line[0].0, line[out[0]].1 - line[0].1)), COS70),
                k => (unit((line[out[k - 1]].0 - line[out[k - 2]].0, line[out[k - 1]].1 - line[out[k - 2]].1)), COS70),
            };
            let turn_ok = |j: usize| dot(unit((line[j].0 - line[last].0, line[j].1 - line[last].1)), way) >= cos as i128 * ONE as i128;
            let best = (last + 1..line.len())
                .filter(|&j| cum[j] - cum[last] >= sp.0 && cum[j] - cum[last] <= APART_MAX_CM && dist(line[j], line[last]) >= sp.1 && !land.wet(line[j]) && turn_ok(j))
                .max_by_key(|&j| (rank(j) * 6_000 - (cum[j] - cum[last] - aim).abs(), std::cmp::Reverse(j)));
            match best {
                Some(j) => {
                    out.push(j);
                    last = j;
                }
                None => break,
            }
        }
        out
    };
    run(sp.2)
}

/// Rail levels along a track: `depth` under the ground, eased over 9 points, kept in the band.
fn levels(land: &Land, track: &[P], depth: i64) -> Vec<i64> {
    let h: Vec<i64> = track.iter().map(|&q| land.height(q)).collect();
    let n = h.len() as i64;
    (0..n)
        .map(|i| {
            let (a, b) = ((i - 4).max(0), (i + 4).min(n - 1));
            let avg = (a..=b).map(|j| h[j as usize]).sum::<i64>() / (b - a + 1) - depth;
            avg.clamp(h[i as usize] - DEPTH_MAX_CM, h[i as usize] - DEPTH_MIN_CM)
        })
        .collect()
}

/// The ramp from the end of `path` (its last platform's end, rail level `y0`) to a depot
/// on gentle open land (`fits`: the depot footprints open land holds): the shortest
/// smooth way (radius 200 m) to the depot's mouth, level at `depth` under the ground
/// until it climbs at 4 % to the depot's ground; the open trench where it is shallower
/// than the tunnel box. The nearest depot first; None when none connects.
fn depot_link(land: &Land, open: &OpenMap, fits: &[(P, usize)], path: &[P], y0: i64, depth: i64) -> Option<Ext> {
    let n = path.len();
    let end = path[n - 1];
    let d0 = unit((end.0 - path[n - 2].0, end.1 - path[n - 2].1));
    let mut cands: Vec<(i64, P, usize)> = fits
        .iter()
        .map(|&(q, k)| (dist(ahead(q, DIR16[k], -DEPOT_LEN_CM / 2), end), q, k))
        .filter(|c| (20_000..=120_000).contains(&c.0))
        .collect();
    cands.sort();
    let mut tried = 0;
    for (_, q, k) in cands {
        let a0 = DIR16[k];
        // the ground: under 4 % end to end (a cheap look first)
        let hs: Vec<i64> = [-7_500, 0, 7_500].iter().flat_map(|&a| [-2_500, 0, 2_500].map(|b| land.height(ahead(ahead(q, a0, a), left(a0), b)))).collect();
        let (mn, mx) = hs.iter().fold((i64::MAX, i64::MIN), |m, &h| (m.0.min(h), m.1.max(h)));
        if (mx - mn) * 1000 / DEPOT_LEN_CM >= GRADE_PM {
            continue;
        }
        tried += 1;
        if tried > 800 {
            break;
        }
        let lead = ahead(end, d0, STEP_CM);
        let Some(mut ln) = dubins(lead, d0, ahead(q, a0, -DEPOT_LEN_CM / 2), a0, 20_000) else { continue };
        ln.insert(0, lead);
        let d = a0;
        let mouth = *ln.last().unwrap();
        let depot = rect(ahead(mouth, d, DEPOT_LEN_CM / 2), d, DEPOT_LEN_CM, DEPOT_W_CM);
        let dp = pts(&depot);
        if !open.holds(&dp) {
            continue;
        }
        let (_, lo, hi) = land.relief(&dp);
        if (hi - lo) * 1000 / DEPOT_LEN_CM >= GRADE_PM {
            continue;
        }
        let yd = (lo + hi) / 2;
        let mut sl: Vec<i64> = Vec::with_capacity(ln.len());
        let mut prev = end;
        let mut s = 0;
        for &p in &ln {
            s += dist(prev, p);
            sl.push(s);
            prev = p;
        }
        let total = s;
        if yd - y0 > total * GRADE_PM / 1000 {
            continue; // too short to climb
        }
        // level at `depth` under the ground, then the climb to the depot's ground
        let y_at = |q: P, s: i64| (land.height(q) - depth).max(yd - (total - s) * GRADE_PM / 1000).min(yd);
        // the tunnel stays under the ground (the box's height over it) and on the island; the trench is open land
        let mut first_trench = None;
        let mut bad = false;
        for (i, &p) in ln.iter().enumerate() {
            let (h, y) = (land.height(p), y_at(p, sl[i]));
            if h - y < COVER_CM {
                if (h - yd).abs() > 300 || h < y - 50 || !open.at(p) {
                    bad = true;
                    break;
                }
                first_trench.get_or_insert(i);
            } else if first_trench.is_some() || land.to_coast(p) < 3_000 {
                bad = true;
                break;
            }
        }
        let Some(ft) = first_trench.filter(|_| !bad) else {
            continue;
        };
        let head = if ft == 0 { end } else { ln[ft - 1] };
        let head_s = if ft == 0 { 0 } else { sl[ft - 1] };
        let mut tl = vec![head];
        tl.extend_from_slice(&ln[ft..]);
        let trench = band(&tl, TRENCH_W_CM);
        if land.stand(&pts(&trench), 300, false, 2_000).is_none() {
            continue;
        }
        let Some(lot) = land.stand(&dp, 300, true, 2_000) else {
            continue;
        };
        let mut x = Ext::default();
        for (i, &p) in ln.iter().enumerate() {
            x.pts.push(p);
            x.y.push(y_at(p, sl[i]));
            x.kind.push("portal");
        }
        for j in 1..=2 {
            x.pts.push(ahead(mouth, d, j * 1_500));
            x.y.push(yd);
            x.kind.push("open");
        }
        let l = left(d);
        let p1 = ahead(mouth, d, 4_000);
        let p2 = ahead(mouth, d, DEPOT_LEN_CM - 1_000);
        x.tracks = [-750, -250, 250, 750]
            .iter()
            .map(|&o| resample(&[mouth, ahead(p1, l, o), ahead(p2, l, o)], STEP_CM).iter().map(|q| [q.0, yd, q.1]).collect())
            .collect();
        x.head = head;
        x.back = neg(d);
        x.trench_len = total - head_s;
        x.trench = trench;
        x.depot = depot;
        x.depot_lot = lot;
        return Some(x);
    }
    None
}

/// A band `w` wide round a centre line, counter-clockwise.
pub fn band(line: &[P], w: i64) -> Vec<[i64; 2]> {
    let n = line.len();
    let mut l = Vec::with_capacity(n);
    let mut r = Vec::with_capacity(n);
    for i in 0..n {
        let (a, b) = (line[i.saturating_sub(1)], line[(i + 1).min(n - 1)]);
        let nl = left(unit((b.0 - a.0, b.1 - a.1)));
        l.push(arr(ahead(line[i], nl, w / 2)));
        r.push(arr(ahead(line[i], nl, -w / 2)));
    }
    let mut poly = r;
    poly.extend(l.into_iter().rev());
    if super::lines::area2(&poly) < 0 {
        poly.reverse();
    }
    poly
}

/// Up to `want` entrance footprints round a station at q: at the back of the pavement
/// of the streets near it (or on a corner lot it takes), each clear of the others. The
/// footprint, the way down and the lot taken.
fn entrances(land: &mut Land, c: &Ctx, q: P, want: usize, rng: &mut Rng) -> Vec<(Vec<[i64; 2]>, P, Option<u32>)> {
    // (has a lot, distance, jitter, footprint, way down, lot)
    let mut cands: Vec<(bool, i64, u64, Vec<[i64; 2]>, P, Option<u32>)> = Vec::new();
    for e in &c.roads.edges {
        let hw = e.width / 2;
        for w in e.points.windows(2) {
            let (a, b) = ((w[0][0], w[0][2]), (w[1][0], w[1][2]));
            let (pr, d2) = super::organic::geom::nearest_on(q, a, b);
            if d2 > 6_000 * 6_000 || a == b {
                continue;
            }
            let d = unit((b.0 - a.0, b.1 - a.1));
            for t in [0, 1_500, -1_500, 3_000, -3_000, 4_500, -4_500] {
                let base = ahead(pr, d, t);
                for side in [left(d), neg(left(d))] {
                    for gap in [150, 600, 1_200] {
                        let ctr = ahead(base, side, hw + ENT_W_CM / 2 + gap);
                        if dist(ctr, q) > 7_000 {
                            continue;
                        }
                        let front = if t > 0 { neg(d) } else { d };
                        let poly = rect(ctr, front, ENT_D_CM, ENT_W_CM);
                        cands.push((false, dist(ctr, q), 0, poly, front, None));
                    }
                }
            }
        }
    }
    let mut ok = Vec::new();
    for (_, dq, _, poly, front, _) in cands {
        // (half a metre off every road: never just touching a wider v4 road's edge)
        if let Some(lot) = land.stand(&pts(&poly), 50, true, 1_000) {
            ok.push((lot.is_some(), dq / 500, rng.next_u64(), poly, front, lot));
        }
    }
    ok.sort_by_key(|a| (a.0, a.1, a.2));
    let mut out: Vec<(Vec<[i64; 2]>, P, Option<u32>)> = Vec::new();
    let mut lots: Vec<u32> = Vec::new();
    for (_, _, _, poly, front, lot) in ok {
        if out.len() >= want {
            break;
        }
        let ctr = centre(&poly);
        if out.iter().any(|o| dist(centre(&o.0), ctr) < 2_500) || lot.is_some_and(|l| lots.contains(&l)) {
            continue;
        }
        if land.is_taken(&pts(&poly)) {
            continue;
        }
        land.taken.push(pts(&poly));
        lots.extend(lot);
        out.push((poly, front, lot));
    }
    out
}
