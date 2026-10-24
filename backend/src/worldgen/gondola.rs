//! The @3 gondola (`layers.gondola`): one aerial ropeway, G1.
//!
//!   summit    where a hill top 25 m or more above the transit hub stands within 1.4 km of
//!             it: from a valley station beside a tram stop or a metro entrance straight up
//!             to a summit station (with its viewing deck) on the top
//!   crossing  else across the river or a water body: from a valley station beside a tram
//!             stop or metro entrance over the water to a station on the far bank
//!
//! Stations (12 x 24 m, on open land, clear of what the other planners took) claim small
//! sites (`gondola:<n>`). Towers stand on open land (no road, lot or water) at most 220 m
//! apart, each as tall as the cable needs: it hangs 2 % of the span at mid-span and clears
//! the ground (or the water) by 12 m everywhere. A station's `y` is its boarding deck, where
//! the cable runs (14 m over its ground); a tower's `y` is its foot and `h` the cable's
//! height over it. Integer arithmetic only, seeded with the salt "gondola".

use serde::Serialize;

use super::lines::{ahead, arr, dist, neg, pts, rect, Claim, Ctx, Land, P};
use super::noise::ONE;
use super::organic::geom::{unit, DIR16};
use super::rng::{sub, Rng};
use super::transit::door;

#[derive(Serialize, Clone, Default, Debug)]
pub struct Gondola {
    pub lines: Vec<Line>,
}

#[derive(Serialize, Clone, Debug)]
pub struct Line {
    pub id: String,
    /// "summit" or "crossing".
    pub kind: &'static str,
    pub stations: Vec<Station>,
    pub towers: Vec<Tower>,
    pub tier: u8,
}

#[derive(Serialize, Clone, Debug)]
pub struct Station {
    pub id: String,
    pub x: i64,
    /// The boarding deck, where the cable runs (cm).
    pub y: i64,
    pub z: i64,
    /// Toward the other station (Q16 unit).
    pub front: [i64; 2],
}

#[derive(Serialize, Clone, Copy, Debug)]
pub struct Tower {
    pub x: i64,
    /// The tower's foot (cm).
    pub y: i64,
    pub z: i64,
    /// The cable's height over the foot (cm).
    pub h: i64,
}

pub const TIER: u8 = 3;
pub const STATION_LEN_CM: i64 = 2_400;
pub const STATION_W_CM: i64 = 1_200;
/// The deck (and cable) over a station's ground.
pub const DECK_CM: i64 = 1_400;
pub const SPAN_MAX_CM: i64 = 22_000;
pub const SAG_PM: i64 = 20;
pub const CLEAR_CM: i64 = 1_200;
const HILL_CM: i64 = 2_500;
const REACH_CM: i64 = 140_000;
const CROSS_MAX_CM: i64 = 70_000;
const TOWER_MAX_CM: i64 = 6_000;

pub fn plan(c: &Ctx, taken: &[Claim]) -> Result<(Gondola, Vec<Claim>), String> {
    let mut land = Land::new(c);
    for t in taken {
        land.taken.push(pts(&t.poly));
    }
    let mut rng = Rng::new(sub(c.seed, "gondola", 0, 0));
    let mut g = Gondola::default();
    let Some(hub) = c.sites.iter().find(|s| s.kind == "transit") else {
        return Ok((g, vec![]));
    };
    let hq = door(hub);
    // where a valley station may stand beside: tram stops, metro entrances, else the hub
    let mut anchors: Vec<P> = c.sites.iter().filter(|s| s.kind == "tramstop").map(door).collect();
    anchors.extend(taken.iter().filter(|t| t.kind == "metro-entrance").map(|t| (t.x, t.z)));
    if anchors.is_empty() {
        anchors.push(hq);
    }
    rng.shuffle(&mut anchors);

    let plan = summit(&land, hq, &anchors).or_else(|| crossing(&land, &anchors));
    let Some((kind, a, b)) = plan else {
        return Ok((g, vec![]));
    };
    let Some((ya, yb, towers)) = rig(&land, a, b) else {
        return Ok((g, vec![]));
    };
    let fwd = unit((b.0 - a.0, b.1 - a.1));
    let mut claims = Vec::new();
    let mut stations = Vec::new();
    for (k, (p, y, f)) in [(a, ya, fwd), (b, yb, neg(fwd))].into_iter().enumerate() {
        let id = format!("gondola:{k}");
        stations.push(Station { id: id.clone(), x: p.0, y, z: p.1, front: arr(f) });
        claims.push(Claim { kind: "gondola", id, x: p.0, z: p.1, poly: rect(p, f, STATION_LEN_CM, STATION_W_CM), front: arr(f), tier: TIER, lot: None });
    }
    g.lines.push(Line { id: "G1".into(), kind, stations, towers, tier: TIER });
    Ok((g, claims))
}

/// Room for a station at p, whichever way it faces (its circle's square).
fn station_fits(land: &Land, p: P) -> bool {
    let h = 1_400;
    let sq = [(p.0 - h, p.1 - h), (p.0 + h, p.1 - h), (p.0 + h, p.1 + h), (p.0 - h, p.1 + h)];
    land.stand(&sq, 200, false, 2_000).is_some()
}

/// A tower's foot at p: on open, dry land.
fn tower_fits(land: &Land, p: P) -> bool {
    let h = 250;
    let sq = [(p.0 - h, p.1 - h), (p.0 + h, p.1 - h), (p.0 + h, p.1 + h), (p.0 - h, p.1 + h)];
    land.stand(&sq, 100, false, 1_000).is_some()
}

/// Valley station spots beside an anchor, nearest first.
fn valley_spots(land: &Land, anchor: P) -> Vec<P> {
    let mut out = Vec::new();
    for r in [2_000, 3_000, 4_500, 6_000, 8_000] {
        for d in DIR16 {
            let p = ahead(anchor, d, r);
            if station_fits(land, p) {
                out.push(p);
            }
        }
        if out.len() >= 4 {
            break;
        }
    }
    out
}

/// A hill top 25 m over the hub within 1.4 km, and a valley station by an anchor below it.
fn summit(land: &Land, hq: P, anchors: &[P]) -> Option<(&'static str, P, P)> {
    let t = land.c.terrain;
    let hh = land.height(hq);
    let mut tops: Vec<(i64, P)> = Vec::new();
    for iz in (0..t.n).step_by(2) {
        for ix in (0..t.n).step_by(2) {
            let q = t.vertex_pos(ix, iz);
            let h = land.height(q);
            if h >= hh + HILL_CM && dist(q, hq) <= REACH_CM && land.on_island(q) {
                tops.push((-h, q));
            }
        }
    }
    tops.sort();
    for &(_, top) in tops.iter().take(40) {
        if !station_fits(land, top) {
            continue;
        }
        let mut near: Vec<P> = anchors.to_vec();
        near.sort_by_key(|&a| (dist(a, top), a));
        for &a in near.iter().take(6) {
            for v in valley_spots(land, a) {
                let l = dist(v, top);
                if (10_000..=REACH_CM).contains(&l) && rig(land, v, top).is_some() {
                    return Some(("summit", v, top));
                }
            }
        }
    }
    None
}

/// Across the river or a water body from a valley station by an anchor: the shortest that
/// rigs, over the water and down on open land on the far side.
fn crossing(land: &Land, anchors: &[P]) -> Option<(&'static str, P, P)> {
    let mut best: Option<(i64, P, P)> = None;
    for &a in anchors.iter().take(40) {
        for v in valley_spots(land, a).into_iter().take(3) {
            for d in DIR16 {
                // along the ray: into the water, out of it, then a far station on open land
                let (mut wet_in, mut wet_out) = (None, None);
                let mut s = 500;
                while s <= CROSS_MAX_CM {
                    let q = ahead(v, d, s);
                    if !land.on_island(q) {
                        break;
                    }
                    let w = land.inland_water(q);
                    if w && wet_in.is_none() {
                        wet_in = Some(s);
                    }
                    if !w && wet_in.is_some() {
                        wet_out = Some(s);
                        break;
                    }
                    s += 500;
                }
                let Some(out) = wet_out else { continue };
                let mut far = out + 1_500;
                while far <= (out + 12_000).min(CROSS_MAX_CM) {
                    let b = ahead(v, d, far);
                    if best.as_ref().is_some_and(|x| far >= x.0) {
                        break;
                    }
                    if station_fits(land, b) {
                        if rig(land, v, b).is_some() {
                            best = Some((far, v, b));
                        }
                        break;
                    }
                    far += 500;
                }
            }
        }
        if best.is_some() {
            break;
        }
    }
    best.map(|(_, v, b)| ("crossing", v, b))
}

/// The ground under the cable: the land, or the water's surface over water.
fn ground(land: &Land, q: P) -> i64 {
    let h = land.height(q);
    if land.inland_water(q) {
        h.max(land.c.profile.sea_cm.unwrap_or(h))
    } else {
        h
    }
}

/// Towers from a to b and the cable's heights: (deck at a, deck at b, towers). Towers go
/// as far on as they can (220 m) onto open land; then every support rises until the cable
/// (2 % sag) clears the ground by 12 m everywhere. None when it cannot.
pub fn rig(land: &Land, a: P, b: P) -> Option<(i64, i64, Vec<Tower>)> {
    let l = dist(a, b);
    let d = unit((b.0 - a.0, b.1 - a.1));
    // supports: distance along, foot
    let mut at: Vec<i64> = vec![0];
    while l - at.last().unwrap() > SPAN_MAX_CM {
        let cur = *at.last().unwrap();
        let mut s = cur + SPAN_MAX_CM;
        while s > cur + 4_000 && !tower_fits(land, ahead(a, d, s)) {
            s -= 500;
        }
        if s <= cur + 4_000 {
            return None;
        }
        at.push(s);
    }
    at.push(l);
    let foot: Vec<i64> = at.iter().map(|&s| land.height(ahead(a, d, s))).collect();
    let n = at.len();
    let mut top: Vec<i64> = (0..n).map(|k| foot[k] + if k == 0 || k == n - 1 { DECK_CM } else { 1_500 }).collect();
    for _ in 0..400 {
        let mut bad = None;
        'spans: for k in 0..n - 1 {
            let span = at[k + 1] - at[k];
            let sag = span * SAG_PM / 1000;
            let mut s = 0;
            while s <= span {
                let t = s * ONE / span.max(1);
                let y = top[k] + (top[k + 1] - top[k]) * t / ONE - 4 * sag * t / ONE * (ONE - t) / ONE;
                if y - ground(land, ahead(a, d, at[k] + s)) < CLEAR_CM {
                    bad = Some(k);
                    break 'spans;
                }
                s += 250;
            }
        }
        let Some(k) = bad else {
            let towers = (1..n - 1).map(|k| {
                let p = ahead(a, d, at[k]);
                Tower { x: p.0, y: foot[k], z: p.1, h: top[k] - foot[k] }
            });
            return Some((top[0], top[n - 1], towers.collect()));
        };
        for j in [k, k + 1] {
            let cap = if j == 0 || j == n - 1 { DECK_CM + 1_600 } else { TOWER_MAX_CM };
            if top[j] - foot[j] < cap {
                top[j] += 100;
            }
        }
        if (top[k] - foot[k]) >= if k == 0 { DECK_CM + 1_600 } else { TOWER_MAX_CM } && (top[k + 1] - foot[k + 1]) >= if k + 1 == n - 1 { DECK_CM + 1_600 } else { TOWER_MAX_CM } {
            return None;
        }
    }
    None
}
