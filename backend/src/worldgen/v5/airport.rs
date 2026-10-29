//! City Gen v5: the airport, the first thing placed after the land and water, and locked in the volume.
//!
//! Its runway is a quarter of the city's diameter (the owner's scale: @3's 1.6 km runway was the city's whole width),
//! with its strip (`STRIP_W_CM` wide, `STRIP_END_CM` past each end) and an apron and terminal along one side. Every
//! orientation (10 degree steps) and position (a `STEP_CM` grid) whose footprint is all on dry land is scored:
//!   - flat: the rise over the footprint (it is graded, so a slope costs, it does not refuse);
//!   - approaches: the dry land under each approach's first `APP_LOOK_CM` (over the sea is best: nothing will stand
//!     under an aircraft's approach), at `UNDER_COST` a step; an approach whose line passes within `CENTRE_KEEP_CM` of
//!     the city's middle all but rules a site out;
//!   - away from the centre: the farther out the better (in the city is allowed, at its edge is preferred);
//!
//! The lowest score wins, the smaller angle and then position breaking ties. Locked: the footprint from the ground into
//! the sky, and each approach surface as stepped boxes rising at `APP_RISE_PM` from `APP_START_CM` past the threshold,
//! widening `APP_SPREAD_PM` each side (ICAO Annex 14), to `APP_LEN_CM`; under them the volume stays free.
use super::land::Land;
use super::space::{Space, GROUND, SKY};
use super::super::organic::geom::{rise, P};

pub const STRIP_W_CM: i64 = 15_000;
pub const STRIP_END_CM: i64 = 6_000;
pub const APRON_W_CM: i64 = 9_000;
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
    /// The ground's height there (cm): the site is graded to it.
    pub y: i64,
    pub solids: Vec<u32>,
}

/// The quad from `c` along `d` (x1000) from `a0` to `a1` cm, across from `w0` to `w1` cm (left positive).
fn quad(c: P, d: (i64, i64), a0: i64, a1: i64, w0: i64, w1: i64) -> Vec<P> {
    let at = |a: i64, w: i64| (c.0 + (d.0 * a - d.1 * w) / 1000, c.1 + (d.1 * a + d.0 * w) / 1000);
    vec![at(a0, w0), at(a1, w0), at(a1, w1), at(a0, w1)]
}

/// The footprint of a runway of length `len` at `c` along `d`, its apron on `side`.
pub fn footprint(c: P, d: (i64, i64), len: i64, side: i64) -> Vec<P> {
    let half = len / 2 + STRIP_END_CM;
    let (w0, w1) = if side > 0 { (-STRIP_W_CM / 2, STRIP_W_CM / 2 + APRON_W_CM) } else { (-STRIP_W_CM / 2 - APRON_W_CM, STRIP_W_CM / 2) };
    quad(c, d, -half, half, w0, w1)
}

/// Places the airport on `land` and locks it in `space`. None where no footprint fits on dry land.
pub fn place(land: &Land, space: &mut Space) -> Option<Airport> {
    let len = (land.city_d() / 4 / 1_000) * 1_000;
    let r = land.p.city_r_cm + land.p.coast_r_cm.map_or(0, |c| (c - land.p.city_r_cm).max(0));
    let mut best: Option<((i64, i64, i64, i64), Airport)> = None;
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
                    let poly = footprint(c, d, len, side);
                    if !poly.iter().all(|&q| land.dry(q)) || !land.dry(c) {
                        continue;
                    }
                    let flat = rise(&land.t, &poly);
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
                    // and an approach's line over the city's middle: never (an approach is flown low over what is under it)
                    let over_centre = [-1i64, 1].iter().any(|&s| {
                        let (ax, az) = (c.0 + d.0 * s * ap_half(len) / 1000, c.1 + d.1 * s * ap_half(len) / 1000);
                        let (bx, bz) = (ax + d.0 * s * APP_LEN_CM / 1000, az + d.1 * s * APP_LEN_CM / 1000);
                        super::super::organic::geom::seg_dist2((ax, az), (bx, bz), (0, 0), (0, 0)) < CENTRE_KEEP_CM * CENTRE_KEEP_CM
                    });
                    let out = -((c.0 as f64).hypot(c.1 as f64) as i64) / 1_000;
                    let key = (flat / 200 + under * UNDER_COST + if over_centre { 1_000 } else { 0 }, out, k, i * 1000 + j);
                    if best.as_ref().is_none_or(|b| key < b.0) {
                        best = Some((key, Airport { c, dir: d, len, side, poly, y: land.height(c), solids: Vec::new() }));
                    }
                }
            }
        }
    }
    let (_, mut ap) = best?;
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
    fn the_runway_is_a_quarter_of_the_city() {
        let (land, _, ap) = commons();
        let q = land.city_d() / 4;
        assert!((ap.len - q).abs() <= 1_000, "runway {} cm, a quarter of the city {} cm", ap.len, q);
        assert!(ap.poly.iter().all(|&p| land.dry(p)));
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
