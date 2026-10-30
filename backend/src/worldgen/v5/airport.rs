//! City Gen v5: the airport, the first thing placed after the land and water, and locked in the volume.
//!
//! Its runway is `RUNWAY_CM` long: room for the fastest HQ vehicle to run from a standstill to its top speed (nitro on)
//! and brake to a stop (the Chiron Super Sport, 2,138 m with the game's physics, games/hqvehiclephys.js; the test
//! tests/test_runway_length.py runs every catalogue vehicle against this constant). That is longer than the Commons
//! is wide, so only the apron side stands on the island: the terminal, its landside and the apron (`APRON_HALF_CM`
//! either side of the runway's middle, from the strip's edge out `APRON_W_CM`) must be dry, and the strip may run out
//! over the sea on a pier deck (the client's airfield draws it so where there is no land under it). Every orientation
//! (10 degree steps) and position (a `STEP_CM` grid) whose apron side is dry, and whose strip crosses no river, lake,
//! canal or the marina (it may cross the coast), is scored:
//!   - flat: the rise over the apron side and the dry land under the strip (one platform: a hill under it lifts it all);
//!   - approaches: the dry land under each approach's first `APP_LOOK_CM` (over the sea is best: nothing will stand
//!     under an aircraft's approach), at `UNDER_COST` a step; an approach whose line passes within `CENTRE_KEEP_CM` of
//!     the city's middle rules a site out;
//!   - away from the centre: the farther out the better (in the city is allowed, at its edge is preferred);
//!
//! The lowest score wins, the smaller angle and then position breaking ties. Locked: the footprint (the strip and the
//! platform beside it along the whole runway, widening to the apron side round the middle: convex) from the ground into
//! the sky, and each approach surface as stepped boxes rising at `APP_RISE_PM` from `APP_START_CM` past the threshold,
//! widening `APP_SPREAD_PM` each side (ICAO Annex 14), to `APP_LEN_CM`; under them the volume stays free.
use super::land::Land;
use super::space::{Space, GROUND, SKY};
use super::super::organic::geom::{crossing, inside, P};

/// The runway's length (cm): 0 -> top speed (nitro) -> 0 for the fastest HQ vehicle (2,138 m), rounded up.
pub const RUNWAY_CM: i64 = 220_000;
pub const STRIP_W_CM: i64 = 15_000;
/// Along the whole runway the client's platform reaches this far (cm) from the centre line on the apron side: its
/// taxiways (170 m) and the service row beside the apron (215 m, hqairfield.js `air.service`).
pub const STRIP_IN_CM: i64 = 22_000;
/// The apron side's half length along the runway (cm): the apron (245 m, hqairfield.js `air.apron`) and a margin.
pub const APRON_HALF_CM: i64 = 26_000;
pub const STRIP_END_CM: i64 = 6_000;
/// The apron side, past the strip: the apron, stands and concourse, the terminal, its forecourt and car park (the client's
/// airfield, hqairfield.js, laid to the runway: its terminal `TERMINAL_CM` from the runway, its access road 146 m past it).
pub const APRON_W_CM: i64 = 38_800;
/// From the runway's centre line to the terminal's middle (cm): the airfield's frame origin in the client.
pub const TERMINAL_CM: i64 = 31_700;
pub const STEP_CM: i64 = 5_000;
pub const APP_LOOK_CM: i64 = 60_000;
pub const APP_START_CM: i64 = 6_000;
pub const APP_LEN_CM: i64 = 100_000;
pub const APP_STEP_CM: i64 = 10_000;
pub const APP_RISE_PM: i64 = 20;
pub const APP_SPREAD_PM: i64 = 150;
/// What a step of dry land under an approach costs (against the rise in 2 m steps), and how far (cm) every approach's
/// line keeps from the city's middle.
pub const UNDER_COST: i64 = 20;
pub const CENTRE_KEEP_CM: i64 = 30_000;

/// Where an approach starts: half the runway and the threshold's margin.
fn ap_half(len: i64) -> i64 {
    len / 2 + APP_START_CM
}

#[derive(Clone, Debug)]
pub struct Airport {
    /// The runway's middle, its direction (unit, x1000) and length (cm).
    pub c: P,
    pub dir: (i64, i64),
    pub len: i64,
    /// Which side of the runway the apron and terminal stand (+1: left of dir, -1: right).
    pub side: i64,
    /// The footprint (strip and apron), convex, cm.
    pub poly: Vec<P>,
    /// The ground's height on its apron side (cm): the site is graded to it (the strip's deck stands level with it).
    pub y: i64,
    pub solids: Vec<u32>,
}

/// The quad from `c` along `d` (x1000) from `a0` to `a1` cm, across from `w0` to `w1` cm (left positive).
fn quad(c: P, d: (i64, i64), a0: i64, a1: i64, w0: i64, w1: i64) -> Vec<P> {
    let at = |a: i64, w: i64| (c.0 + (d.0 * a - d.1 * w) / 1000, c.1 + (d.1 * a + d.0 * w) / 1000);
    vec![at(a0, w0), at(a1, w0), at(a1, w1), at(a0, w1)]
}

/// The footprint of a runway of length `len` at `c` along `d`, its apron on `side`: the strip and the platform along the
/// whole runway, widening to the apron side's outer edge over its middle (a convex hexagon).
pub fn footprint(c: P, d: (i64, i64), len: i64, side: i64) -> Vec<P> {
    let half = len / 2 + STRIP_END_CM;
    let (o, i, a) = (-STRIP_W_CM / 2, STRIP_IN_CM, STRIP_W_CM / 2 + APRON_W_CM);
    let at = |u: i64, w: i64| { let w = w * side; (c.0 + (d.0 * u - d.1 * w) / 1000, c.1 + (d.1 * u + d.0 * w) / 1000) };
    let p = vec![at(-half, o), at(half, o), at(half, i), at(APRON_HALF_CM, a), at(-APRON_HALF_CM, a), at(-half, i)];
    if side > 0 { p } else { p.into_iter().rev().collect() }
}

/// The apron side: the apron, terminal, landside and car park, which stand on the island (dry), round the middle.
pub fn apron_box(c: P, d: (i64, i64), side: i64) -> Vec<P> {
    let (w0, w1) = (STRIP_W_CM / 2, STRIP_W_CM / 2 + APRON_W_CM);
    let (w0, w1) = if side > 0 { (w0, w1) } else { (-w1, -w0) };
    quad(c, d, -APRON_HALF_CM, APRON_HALF_CM, w0, w1)
}

/// The terminal's landside, where its road meets the city: 40 m past the airport's box on the apron side.
pub fn landside(c: P, d: (i64, i64), side: i64) -> P {
    let w = side * (STRIP_W_CM / 2 + APRON_W_CM + 4_000);
    (c.0 - d.1 * w / 1000, c.1 + d.0 * w / 1000)
}

/// Does any lake, canal or the marina reach into `poly` (a body narrower than the footprint passes between its corners)?
fn wet(land: &Land, poly: &[P]) -> bool {
    let n = poly.len();
    land.water.iter().any(|w| {
        w.iter().any(|&q| inside(q, poly))
            || (0..w.len()).any(|i| (0..n).any(|k| crossing(w[i], w[(i + 1) % w.len()], poly[k], poly[(k + 1) % n]).is_some()))
    })
}

/// Is there a way for a road over dry land, off `poly`, from `from` to within 150 m of the island's middle (a 20 m grid,
/// each step with dry land 40 m round it: as the roads' grid, roads.rs)?
fn reaches(land: &Land, from: P, poly: &[P], r: i64) -> bool {
    const G: i64 = 2_000;
    let n = r / G + 1;
    let dry = |c: (i64, i64)| { let q = (c.0 * G, c.1 * G); land.dry(q) && !inside(q, poly) };
    let ok = |c: (i64, i64)| c.0.abs() <= n && c.1.abs() <= n && (-2..=2).all(|a| (-2..=2).all(|b| dry((c.0 + a, c.1 + b))));
    let start = ((from.0 as f64 / G as f64).round() as i64, (from.1 as f64 / G as f64).round() as i64);
    let mut seen = std::collections::BTreeSet::from([start]);
    let mut todo = vec![start];
    while let Some(c) = todo.pop() {
        if (c.0 * G).pow(2) + (c.1 * G).pow(2) <= 15_000i64.pow(2) {
            return true;
        }
        for (dx, dz) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
            let x = (c.0 + dx, c.1 + dz);
            if ok(x) && seen.insert(x) {
                todo.push(x);
            }
        }
    }
    false
}

/// Places the airport on `land` and locks it in `space`. None where no apron side fits on dry land.
pub fn place(land: &Land, space: &mut Space) -> Option<Airport> {
    let len = RUNWAY_CM;
    let r = land.p.city_r_cm + land.p.coast_r_cm.map_or(0, |c| (c - land.p.city_r_cm).max(0));
    let in_coast = |q: P| land.coast.as_ref().is_none_or(|c| inside(q, &c.poly));
    let mut all: Vec<((i64, i64, i64, i64), Airport)> = Vec::new();
    for k in 0..18 {
        let a = (k as f64 * 10.0).to_radians();
        let d = ((a.cos() * 1000.0).round() as i64, (a.sin() * 1000.0).round() as i64);
        let n = r / STEP_CM;
        for i in -n..=n {
            for j in -n..=n {
                let c = (i * STEP_CM, j * STEP_CM);
                if c.0 * c.0 + c.1 * c.1 > r * r {
                    continue;
                }
                for side in [1, -1] {
                    let apron = apron_box(c, d, side);
                    if !apron.iter().all(|&q| land.dry(q)) || !land.dry(landside(c, d, side)) || wet(land, &apron) {
                        continue;
                    }
                    // an approach's line over the city's middle: never (an approach is flown low over what is under it)
                    let over_centre = [-1i64, 1].iter().any(|&s| {
                        let (ax, az) = (c.0 + d.0 * s * ap_half(len) / 1000, c.1 + d.1 * s * ap_half(len) / 1000);
                        let (bx, bz) = (ax + d.0 * s * APP_LEN_CM / 1000, az + d.1 * s * APP_LEN_CM / 1000);
                        super::super::organic::geom::seg_dist2((ax, az), (bx, bz), (0, 0), (0, 0)) < CENTRE_KEEP_CM * CENTRE_KEEP_CM
                    });
                    let poly = footprint(c, d, len, side);
                    if over_centre || wet(land, &poly) {
                        continue;
                    }
                    // the strip, every 20 m: over the island it must be dry (no river between), over the sea it is a pier
                    let mut hs: Vec<i64> = apron.iter().map(|&q| land.height(q)).collect();
                    let mut crosses = false;
                    'strip: for m in -(len / 2 + STRIP_END_CM) / 2_000..=(len / 2 + STRIP_END_CM) / 2_000 {
                        for w in [-STRIP_W_CM / 2, 0, STRIP_IN_CM] {
                            let (u, w) = (m * 2_000, w * side);
                            let q = (c.0 + (d.0 * u - d.1 * w) / 1000, c.1 + (d.1 * u + d.0 * w) / 1000);
                            if !in_coast(q) {
                                continue;
                            }
                            if !land.dry(q) {
                                crosses = true;
                                break 'strip;
                            }
                            hs.push(land.height(q));
                        }
                    }
                    if crosses {
                        continue;
                    }
                    let flat = hs.iter().max().unwrap_or(&0) - hs.iter().min().unwrap_or(&0);
                    // dry land under the approaches' first APP_LOOK_CM, both ends (in 20 m steps)
                    let mut under = 0;
                    for s in [-1, 1] {
                        for m in 0..APP_LOOK_CM / 2_000 {
                            let u = s * (len / 2 + APP_START_CM + m * 2_000);
                            if land.dry((c.0 + d.0 * u / 1000, c.1 + d.1 * u / 1000)) {
                                under += 1;
                            }
                        }
                    }
                    let out = -((c.0 as f64).hypot(c.1 as f64) as i64) / 1_000;
                    let key = (flat / 200 + under * UNDER_COST, out, k, i * 1000 + j);
                    let w = side * TERMINAL_CM;
                    let y = land.height((c.0 - d.1 * w / 1000, c.1 + d.0 * w / 1000));
                    all.push((key, Airport { c, dir: d, len, side, poly, y, solids: Vec::new() }));
                }
            }
        }
    }
    // the best whose landside the city's middle reaches over dry land, round the airport (no river or lake between)
    all.sort_by_key(|x| x.0);
    let (_, mut ap) = all.into_iter().find(|(_, a)| reaches(land, landside(a.c, a.dir, a.side), &a.poly, r))?;
    // locked: the footprint from the ground into the sky; each approach a run of boxes stepping up its surface
    ap.solids.push(space.put("airport", "airport", ap.poly.clone(), ap.y + GROUND.0, ap.y + SKY.1));
    for s in [-1, 1] {
        let mut a = ap.len / 2 + STRIP_END_CM;
        while a < ap.len / 2 + APP_START_CM + APP_LEN_CM {
            let b = a + APP_STEP_CM;
            let out = a - ap.len / 2 - APP_START_CM;
            let hw = STRIP_W_CM / 2 + out.max(0) * APP_SPREAD_PM / 1000;
            let lo = ap.y + out.max(0) * APP_RISE_PM / 1000;
            let poly = if s > 0 { quad(ap.c, ap.dir, a, b, -hw, hw) } else { quad(ap.c, ap.dir, -b, -a, -hw, hw) };
            ap.solids.push(space.put("approach", "airport", poly, lo, ap.y + SKY.1));
            a = b;
        }
    }
    Some(ap)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn commons() -> (Land, Space, Airport) {
        let land = Land::new("claude-hq").unwrap();
        let mut v = Space::default();
        let ap = place(&land, &mut v).expect("an airport");
        (land, v, ap)
    }

    #[test]
    fn the_runway_fits_the_fastest_car_and_runs_out_to_sea() {
        let (land, _, ap) = commons();
        assert_eq!(ap.len, RUNWAY_CM);
        // the apron side on the island, the strip out over the sea past it
        assert!(apron_box(ap.c, ap.dir, ap.side).iter().all(|&p| land.dry(p)));
        assert!(land.dry(landside(ap.c, ap.dir, ap.side)));
        let end = |s: i64| (ap.c.0 + ap.dir.0 * s * ap.len / 2000, ap.c.1 + ap.dir.1 * s * ap.len / 2000);
        assert!(!land.dry(end(-1)) && !land.dry(end(1)), "both ends over the sea");
        // both approaches clear of the city's middle
        for s in [-1i64, 1] {
            let a = (ap.c.0 + ap.dir.0 * s * ap_half(ap.len) / 1000, ap.c.1 + ap.dir.1 * s * ap_half(ap.len) / 1000);
            let b = (a.0 + ap.dir.0 * s * APP_LEN_CM / 1000, a.1 + ap.dir.1 * s * APP_LEN_CM / 1000);
            assert!(super::super::super::organic::geom::seg_dist2(a, b, (0, 0), (0, 0)) >= CENTRE_KEEP_CM * CENTRE_KEEP_CM);
        }
    }

    #[test]
    fn its_volume_is_locked_above_and_free_below() {
        let (_, v, ap) = commons();
        let probe = quad(ap.c, ap.dir, -1_000, 1_000, -1_000, 1_000);
        assert!(v.blocker(&probe, ap.y, ap.y + 2_000, 0).is_some(), "nothing stands on the runway");
        assert!(v.blocker(&probe, ap.y - 1_200, ap.y - 400, 0).is_none(), "a tunnel passes under it");
        // under an approach, low enough, the volume is free; at its height it is not
        let far = ap.len / 2 + APP_START_CM + 80_000;
        let under = quad(ap.c, ap.dir, far, far + 2_000, -500, 500);
        assert!(v.blocker(&under, ap.y, ap.y + 1_000, 0).is_none());
        assert!(v.blocker(&under, ap.y + 2_000, ap.y + 3_000, 0).is_some());
    }
}

#[cfg(test)]
mod show {
    #[test]
    #[ignore]
    fn show_the_commons_airport() {
        let land = super::Land::new("claude-hq").unwrap();
        let mut v = super::Space::default();
        let ap = super::place(&land, &mut v).unwrap();
        let r = ((ap.c.0 as f64).hypot(ap.c.1 as f64) / 100.0) as i64;
        eprintln!("runway {} m at ({}, {}) m, {} m from the centre (city r {} m, coast r {:?} m), dir {:?}, side {}, solids {}",
            ap.len / 100, ap.c.0 / 100, ap.c.1 / 100, r, land.p.city_r_cm / 100, land.p.coast_r_cm.map(|c| c / 100), ap.dir, ap.side, ap.solids.len());
    }
}
