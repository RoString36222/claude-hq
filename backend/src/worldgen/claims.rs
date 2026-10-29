//! Land claims (City Gen v4, phase 1): land a layer takes before the next is planned,
//! so nothing laid later can enter it. The first is the airport's: its landside (the
//! forecourt, terminal, car park and control tower the client draws), the airside it lays
//! out offshore behind the terminal (games/hqairfield.js) and the runway's protection
//! zones, claimed before any graded road is routed. The highways go round it (roads.rs),
//! the dock, port and stadium keep off it (civic.rs) and the validator (validate.rs) fails
//! a world where anything else stands in it.
//!
//! Between the terminal's back and the airside runs the ring corridor: the ring road may
//! pass there, under the terminal's skybridge, as the airport was designed round it
//! (docs/plans/airport-spec.md); nothing else may. Phase 6 (underpasses and tunnels) takes
//! the ring under the airport instead.
//!
//! The claim is worked out from the airport site alone (its centre, front, width and
//! depth), so any stage, and the validator, can rebuild it from the world's sites.
//!
//! Frame (as hqairfield.js): B = -front (out from the city), T = (B.z, -B.x); a point
//! at (u, v) is centre + u*B + v*T, u and v in cm. The client puts the runway at
//! u = RU for the first RU in 355..455 m (10 m steps) whose airside is clear; with the
//! ring in its corridor that is 395 m at the nearest (the Commons' own), and the claim
//! covers every RU from there out.

use super::city::Site;
use super::noise::ONE;
use super::organic::geom::{inside, seg_dist2, P};

/// The client's runway search (cm): RU from `RU_MIN` to `RU_MAX`; `RU_RING`, the nearest
/// it can take with the ring road in its corridor behind the terminal.
const RU_MIN: i64 = 35_500;
const RU_RING: i64 = 39_500;
const RU_MAX: i64 = 45_500;
/// The client's keep-out round the airside (`CLEAR`, 6 m) and its 2 m sampling step.
const AIR_CLEAR: i64 = 800;
/// The airside's extent from the runway (hqairfield.js `airRects`): from RU - 241 m to
/// RU + 70 m, and 860 m either side of the runway's middle along it.
const AIR_BACK: i64 = 24_100;
const AIR_FRONT: i64 = 7_000;
const AIR_HALF: i64 = 86_000;
/// The runway's half length (1600 m) and the protection zone past each end (FAA AC
/// 150/5300-13B, as in the plan): from 61 m past the threshold, 518 m long, widening
/// from 152 m to 308 m; the object-free area 244 m wide to 305 m past the end.
const RWY_HALF: i64 = 80_000;
const RPZ_START: i64 = 6_100;
const RPZ_LEN: i64 = 51_800;
const RPZ_HW0: i64 = 7_600;
const RPZ_HW1: i64 = 15_400;
const OFA_HW: i64 = 12_200;
const OFA_LEN: i64 = 30_500;
/// HQ 3.36: the inner approach surface past each end (ICAO Annex 14 for a precision runway):
/// from 60 m past the threshold, 300 m wide there, widening 15 % each side, rising 2 %. A line
/// may only pass under it where the surface clears its deck and a train, 13 m and 5 m over
/// the sea (hqrail.js SEA_UP) with 2 m to spare: 60 m + 20 m / 2 % = 1060 m past the end.
const APP_START: i64 = 6_000;
const APP_LEN: i64 = 100_000;
const APP_HW0: i64 = 15_000;
const APP_SPREAD_PM: i64 = 150;
/// The landside the client draws round the terminal (hqairfield.js `landside`), in the
/// frame (m): the forecourt, the terminal with its canopy and the skybridge behind it,
/// the car park, the control tower; each grown by `LANDSIDE_CLEAR`. Its access road on
/// to the street (u -146 to -120, v -8) is the one road that may cross a claimed road.
const LANDSIDE: [[i64; 4]; 4] = [[-120, -88, -62, 62], [-88, 66, -20, 20], [-60, -4, 30, 86], [91, 99, -104, -96]];
const LANDSIDE_CLEAR: i64 = 400;

/// The airport's claim: polygons ([x, z] cm, each a convex quad) that only the airport
/// may stand in, and the corridor only the ring road may run in.
#[derive(Clone, Debug)]
pub struct Airport {
    pub site: String,
    pub polys: Vec<Vec<P>>,
    /// Between the terminal's back and the airside, along its whole length.
    pub corridor: Vec<P>,
    /// The first `landside` polygons are the landside pieces (forecourt, terminal, car
    /// park, tower): roads keep off them, but they need not be dry.
    pub landside: usize,
    /// Their bounding box, (x0, x1, z0, z1).
    pub bbox: (i64, i64, i64, i64),
    /// HQ 3.36: the inner approach surface past each runway end where it is lower than a
    /// viaduct and a train (`APP_*`): no line crosses there above the ground. Not part of
    /// the claim (roads and lots may stand under it), only of the rail layer's keep-out.
    pub approach: Vec<Vec<P>>,
}

impl Airport {
    /// The claim of an airport site at `c` facing `front` (a Q16 unit toward the city),
    /// `w` wide and `d` deep.
    pub fn new(id: &str, c: P, front: P, w: i64, d: i64) -> Airport {
        let b = (-front.0, -front.1);
        let t = (b.1, -b.0);
        let at = |u: i64, v: i64| (c.0 + (u * b.0 + v * t.0) / ONE, c.1 + (u * b.1 + v * t.1) / ONE);
        let quad = |u0: i64, u1: i64, v0: i64, v1: i64| vec![at(u0, v0), at(u1, v0), at(u1, v1), at(u0, v1)];
        let air0 = RU_RING - AIR_BACK - AIR_CLEAR;
        let m = LANDSIDE_CLEAR;
        let mut polys: Vec<Vec<P>> = LANDSIDE.iter().map(|r| quad(r[0] * 100 - m, r[1] * 100 + m, r[2] * 100 - m, r[3] * 100 + m)).collect();
        polys.extend([
            // the site itself
            quad(-d / 2 - m, d / 2 + m, -w / 2 - m, w / 2 + m),
            // the airside, for every runway position the client may choose
            quad(air0, RU_MAX + AIR_FRONT + AIR_CLEAR, -AIR_HALF - AIR_CLEAR, AIR_HALF + AIR_CLEAR),
        ]);
        let corridor = quad(d / 2 + m, air0, -AIR_HALF - AIR_CLEAR, AIR_HALF + AIR_CLEAR);
        for s in [1, -1] {
            // past each end: the object-free area, then the protection zone widening out
            let (e0, e1, e2) = (s * RWY_HALF, s * (RWY_HALF + RPZ_START), s * (RWY_HALF + RPZ_START + RPZ_LEN));
            polys.push(quad(RU_MIN - OFA_HW, RU_MAX + OFA_HW, e0, s * (RWY_HALF + OFA_LEN)));
            polys.push(vec![at(RU_MIN - RPZ_HW0, e1), at(RU_MAX + RPZ_HW0, e1), at(RU_MAX + RPZ_HW1, e2), at(RU_MIN - RPZ_HW1, e2)]);
        }
        let all = polys.iter().flatten();
        let bbox = all.fold((i64::MAX, i64::MIN, i64::MAX, i64::MIN), |b, q| (b.0.min(q.0), b.1.max(q.0), b.2.min(q.1), b.3.max(q.1)));
        let hw1 = APP_HW0 + APP_LEN * APP_SPREAD_PM / 1000;
        let approach = [1, -1]
            .iter()
            .map(|&s| {
                let (e1, e2) = (s * (RWY_HALF + APP_START), s * (RWY_HALF + APP_START + APP_LEN));
                vec![at(RU_MIN - APP_HW0, e1), at(RU_MAX + APP_HW0, e1), at(RU_MAX + hw1, e2), at(RU_MIN - hw1, e2)]
            })
            .collect();
        Airport { site: id.to_string(), polys, corridor, landside: LANDSIDE.len(), bbox, approach }
    }

    /// The runway positions the client may settle on with the ring in its corridor,
    /// nearest first (cm).
    pub fn runway_offsets() -> impl Iterator<Item = i64> {
        (RU_RING..=RU_MAX).step_by(1_000)
    }

    /// Does segment ab come within `clear` cm of the ring corridor?
    pub fn in_corridor(&self, a: P, b: P, clear: i64) -> bool {
        let p = &self.corridor;
        inside(a, p) || inside(b, p) || (0..p.len()).any(|k| seg_dist2(a, b, p[k], p[(k + 1) % p.len()]) < clear.max(1) * clear.max(1))
    }

    /// The airside the client lays out with its runway at `ru` cm (hqairfield.js
    /// `airRects`): the rectangles whose ground must be low enough for its platform, as
    /// quads ([x, z] cm).
    pub fn airside(c: P, front: P, ru: i64) -> Vec<Vec<P>> {
        let b = (-front.0, -front.1);
        let t = (b.1, -b.0);
        let at = |u: i64, v: i64| (c.0 + (u * b.0 + v * t.0) / ONE, c.1 + (u * b.1 + v * t.1) / ONE);
        let ru = ru / 100;
        let rects = [
            [ru - 241, ru - 129, -150, 150],
            [ru - 195, ru - 129, -245, -150],
            [ru - 180, ru - 129, 150, 245],
            [ru - 170, ru + 70, -860, 860],
            [ru - 215, ru - 170, -480, -360],
            [ru - 215, ru - 170, -340, -270],
            [ru - 215, ru - 170, 320, 470],
        ];
        rects.iter().map(|r| vec![at(r[0] * 100, r[2] * 100), at(r[1] * 100, r[2] * 100), at(r[1] * 100, r[3] * 100), at(r[0] * 100, r[3] * 100)]).collect()
    }

    /// The claim of the world's airport site, if it has one.
    pub fn of(sites: &[Site]) -> Option<Airport> {
        let s = sites.iter().find(|s| s.kind == "airport")?;
        let f = s.front?;
        Some(Airport::new(&s.id, (s.x, s.z), (f[0], f[1]), s.w, s.d))
    }

    /// Does point q stand in the claim?
    pub fn contains(&self, q: P) -> bool {
        self.in_box(q, 0) && self.polys.iter().any(|p| inside(q, p))
    }

    /// Does segment ab come within `clear` cm of the claim (or cross it)?
    pub fn meets_seg(&self, a: P, b: P, clear: i64) -> bool {
        if a.0.max(b.0) < self.bbox.0 - clear || a.0.min(b.0) > self.bbox.1 + clear || a.1.max(b.1) < self.bbox.2 - clear || a.1.min(b.1) > self.bbox.3 + clear {
            return false;
        }
        self.polys.iter().any(|p| {
            inside(a, p) || inside(b, p) || (0..p.len()).any(|k| seg_dist2(a, b, p[k], p[(k + 1) % p.len()]) < clear * clear)
        })
    }

    /// HQ 3.36: does segment a-b come within `clear` cm of the claim or an inner approach
    /// surface (what no line may cross above)?
    pub fn meets_keep_out(&self, a: P, b: P, clear: i64) -> bool {
        self.meets_seg(a, b, clear)
            || self.approach.iter().any(|p| inside(a, p) || inside(b, p) || (0..p.len()).any(|k| seg_dist2(a, b, p[k], p[(k + 1) % p.len()]) < clear * clear))
    }

    /// Does polygon `poly` overlap the claim (or come within `clear` cm of it)?
    pub fn meets_poly(&self, poly: &[P], clear: i64) -> bool {
        let n = poly.len();
        (0..n).any(|k| self.meets_seg(poly[k], poly[(k + 1) % n], clear)) || self.polys.iter().any(|p| p.iter().any(|&q| inside(q, poly)))
    }

    /// Do two polygons overlap, or come within `clear` cm?
    pub fn polys_meet(p: &[P], q: &[P], clear: i64) -> bool {
        let (n, m) = (p.len(), q.len());
        let c2 = clear.max(1) * clear.max(1);
        p.iter().any(|&a| inside(a, q)) || q.iter().any(|&a| inside(a, p)) || (0..n).any(|i| (0..m).any(|j| seg_dist2(p[i], p[(i + 1) % n], q[j], q[(j + 1) % m]) < c2))
    }

    fn in_box(&self, q: P, m: i64) -> bool {
        q.0 >= self.bbox.0 - m && q.0 <= self.bbox.1 + m && q.1 >= self.bbox.2 - m && q.1 <= self.bbox.3 + m
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn commons_like() -> Airport {
        // the Commons' airport: at (-620, 0) m facing +x (toward the plaza), 40 x 160 m
        Airport::new("airport:0", (-62_000, 0), (ONE, 0), 4_000, 16_000)
    }

    #[test]
    fn the_claim_runs_from_the_forecourt_out_past_the_runway() {
        let a = commons_like();
        // the forecourt and the terminal; behind it the ring's corridor, then the airside
        for x in [-53_000, -62_000, -70_000] {
            assert!(a.contains((x, 0)), "{x}");
        }
        assert!(!a.contains((-75_000, 0)) && a.in_corridor((-75_000, 0), (-75_000, 0), 0));
        for ru in [39_500, 42_000, 45_500] {
            assert!(a.contains((-62_000 - ru, 0)), "runway at RU {ru}");
            assert!(a.contains((-62_000 - ru, 79_000)), "runway end at RU {ru}");
        }
        // the forecourt, the car park and the control tower are the airport's
        assert!(a.contains((-62_000 + 11_800, 0)) && a.contains((-62_000 + 3_000, 8_500)) && a.contains((-62_000 - 9_500, -10_000)));
        // past the forecourt is the road's (the access road crosses it to the street)
        assert!(!a.contains((-62_000 + 12_800, 0)));
        // between the car park and the tower, landside, too
        assert!(!a.contains((-62_000 - 3_000, -6_000)));
    }

    #[test]
    fn the_protection_zones_reach_518_m_past_the_object_free_area() {
        let a = commons_like();
        let ru = -62_000 - 40_000;
        assert!(a.contains((ru, 80_000 + 6_100 + 51_000)), "inside the far end of the RPZ");
        assert!(a.contains((ru - 15_000, -(80_000 + 6_100 + 51_000))), "the RPZ widens out");
        assert!(!a.contains((ru, 80_000 + 6_100 + 52_500)), "past the RPZ");
    }

    #[test]
    fn the_ring_may_run_behind_the_terminal_and_nothing_into_the_airside() {
        let a = commons_like();
        // the ring behind the terminal, under its skybridge: in the corridor, clear of the claim
        assert!(!a.meets_seg((-73_500, -30_000), (-73_500, 30_000), 900));
        assert!(a.in_corridor((-73_500, -30_000), (-73_500, 30_000), 900));
        // a road 6 m off the airside's edge is in it
        assert!(a.meets_seg((-76_000, -30_000), (-76_000, 30_000), 900));
        // landside of the forecourt, clear by more than the road's half width
        assert!(!a.meets_seg((-48_000, -30_000), (-48_000, 30_000), 900));
        assert!(a.meets_poly(&[(-49_000, -500), (-49_000, 500), (-56_000, 500), (-56_000, -500)], 0));
    }
}
