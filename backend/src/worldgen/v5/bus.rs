//! City Gen v5's bus stops: on the avenues (class "arterial"), at the kerb, so `transit::generate` can run its bus loops
//! (the v4 cities stand theirs on lots: v5's lots are their buildings, wall to wall, so a v5 stop stands in the verge
//! between the pavement and the lots, its shelter facing the road and its door on the pavement).
//!
//! First a stop by each anchor (the metro and rail stations, the landmarks: the nearest good place on an avenue within
//! `ANCHOR_CM`), then one wherever an avenue runs `EVERY_CM` with none; never within `JUNCTION_CM` of an avenue's end
//! (a junction), on a lot or another road, near a stair or tunnel mouth, nor where its door would be served by another
//! street (the bus loops find a stop's street as the avenue whose chord passes nearest its door).
use super::super::city::{Lot, Site};
use super::super::noise::{isqrt, ONE};
use super::super::organic::geom::{inside, P};
use super::super::roads::{Edge, Roads};

/// A stop every this far (cm) along the avenues, at the most.
pub const EVERY_CM: i64 = 25_000;
/// A station or landmark has its stop within this (cm) of it, where an avenue passes.
pub const ANCHOR_CM: i64 = 20_000;
/// Clear of an avenue's ends (its junctions) by this (cm).
pub const JUNCTION_CM: i64 = 4_000;
/// The shelter's site: along the road, across (cm); its back this far (cm) beyond the pavement's edge.
pub const W_CM: i64 = 400;
pub const D_CM: i64 = 200;
pub const OUT_CM: i64 = 50;
/// Clear of a metro stair or a tunnel mouth by this (cm), and of every other site by `SITE_CM`.
pub const AVOID_CM: i64 = 2_500;
pub const SITE_CM: i64 = 3_000;
/// Candidate places every this far (cm) along an avenue.
const STEP_CM: i64 = 2_500;

fn d2(a: P, b: P) -> i64 {
    (a.0 - b.0).pow(2) + (a.1 - b.1).pow(2)
}

fn seg_d2(q: P, a: P, b: P) -> i64 {
    let (ab, aq) = ((b.0 - a.0, b.1 - a.1), (q.0 - a.0, q.1 - a.1));
    let l2 = ab.0 as i128 * ab.0 as i128 + ab.1 as i128 * ab.1 as i128;
    if l2 == 0 {
        return d2(q, a);
    }
    let t = (aq.0 as i128 * ab.0 as i128 + aq.1 as i128 * ab.1 as i128).clamp(0, l2);
    let (x, z) = (a.0 + (ab.0 as i128 * t / l2) as i64, a.1 + (ab.1 as i128 * t / l2) as i64);
    d2(q, (x, z))
}

/// A candidate: the stop's centre, its front (Q16, toward the road), its door, the avenue it serves.
#[derive(Clone, Copy)]
pub struct Stop {
    pub at: P,
    pub front: [i64; 2],
    pub door: P,
    pub edge: u32,
}

fn arterial(e: &Edge) -> bool {
    e.class == "arterial" && e.bridge != Some(true)
}

/// The stops, in placing order (anchors first).
pub fn stops(r: &Roads, lots: &[Lot], sites: &[Site], anchors: &[P], avoid: &[P]) -> Vec<Stop> {
    let pos = |n: u32| r.nodes.iter().find(|m| m.id == n).map(|m| (m.x, m.z)).unwrap_or((0, 0));
    let chords: Vec<(u32, P, P)> = r.edges.iter().filter(|e| e.class == "arterial").map(|e| (e.id, pos(e.a), pos(e.b))).collect();
    let lot_polys: Vec<(Vec<P>, (i64, i64, i64, i64))> = lots
        .iter()
        .filter_map(|l| l.poly.as_ref())
        .map(|p| {
            let q: Vec<P> = p.iter().map(|c| (c[0], c[1])).collect();
            let b = q.iter().fold((i64::MAX, i64::MIN, i64::MAX, i64::MIN), |b, c| (b.0.min(c.0), b.1.max(c.0), b.2.min(c.1), b.3.max(c.1)));
            (q, b)
        })
        .collect();
    let segs: Vec<(u32, i64, P, P)> = r
        .edges
        .iter()
        .flat_map(|e| e.points.windows(2).map(move |w| (e.id, e.width / 2, (w[0][0], w[0][2]), (w[1][0], w[1][2]))))
        .collect();
    let others: Vec<P> = sites.iter().map(|s| (s.x, s.z)).collect();

    // every candidate along every avenue, each side
    let mut cands: Vec<Stop> = Vec::new();
    for e in r.edges.iter().filter(|e| arterial(e)) {
        let pts: Vec<P> = e.points.iter().map(|p| (p[0], p[2])).collect();
        let total: i64 = pts.windows(2).map(|w| isqrt(d2(w[0], w[1]))).sum();
        let mut s = JUNCTION_CM;
        while s <= total - JUNCTION_CM {
            if let Some((q, t)) = along(&pts, s) {
                for side in [1i64, -1] {
                    // (the left of a->b is (tz, -tx))
                    let n = (t.1 * side, -t.0 * side);
                    let back = e.width / 2 + OUT_CM + D_CM / 2;
                    let at = (q.0 + n.0 * back / ONE, q.1 + n.1 * back / ONE);
                    let front = [-n.0, -n.1];
                    let door = (at.0 + front[0] * (D_CM / 2 + 100) / ONE, at.1 + front[1] * (D_CM / 2 + 100) / ONE);
                    cands.push(Stop { at, front, door, edge: e.id });
                }
            }
            s += STEP_CM;
        }
    }
    // a good place: its footprint (and a metre round it) off every lot and road, clear of the stairs and the sites, its
    // door served by its own avenue
    let ok = |c: &Stop| -> bool {
        let (fx, fz) = (c.front[0], c.front[1]);
        let (ax, az) = (fz, -fx);
        let rect = |hw: i64, hd: i64| -> Vec<P> {
            [(-hw, -hd), (hw, -hd), (hw, hd), (-hw, hd)].iter().map(|&(u, v)| (c.at.0 + (ax * u + fx * v) / ONE, c.at.1 + (az * u + fz * v) / ONE)).collect()
        };
        let (corners, own) = (rect(W_CM / 2 + 100, D_CM / 2 + 100), rect(W_CM / 2, D_CM / 2));
        let bb = corners.iter().fold((i64::MAX, i64::MIN, i64::MAX, i64::MIN), |b, q| (b.0.min(q.0), b.1.max(q.0), b.2.min(q.1), b.3.max(q.1)));
        for (poly, b) in &lot_polys {
            if b.0 > bb.1 || bb.0 > b.1 || b.2 > bb.3 || bb.2 > b.3 {
                continue;
            }
            if corners.iter().any(|&q| inside(q, poly)) || poly.iter().any(|&q| inside(q, &corners)) || inside(c.at, poly) {
                return false;
            }
        }
        // off every road's paving (its own: beyond the pavement), the door on its own avenue's pavement
        for &(id, half, a, b) in &segs {
            let r = if id == c.edge { half } else { half + 100 };
            if own.iter().chain(std::iter::once(&c.at)).any(|&q| seg_d2(q, a, b) < r * r) {
                return false;
            }
        }
        if avoid.iter().any(|&p| d2(p, c.at) < AVOID_CM * AVOID_CM) || others.iter().any(|&p| d2(p, c.at) < SITE_CM * SITE_CM) {
            return false;
        }
        chords.iter().min_by_key(|ch| (seg_d2(c.door, ch.1, ch.2), ch.0)).map(|ch| ch.0) == Some(c.edge)
    };
    let good: Vec<Stop> = cands.into_iter().filter(|c| ok(c)).collect();

    let mut out: Vec<Stop> = Vec::new();
    let mut taken = vec![false; good.len()];
    for &a in anchors {
        if out.iter().any(|s| d2(s.at, a) < (EVERY_CM / 2) * (EVERY_CM / 2)) {
            continue;
        }
        let best = (0..good.len()).filter(|&k| !taken[k] && d2(good[k].at, a) <= ANCHOR_CM * ANCHOR_CM).min_by_key(|&k| (d2(good[k].at, a), k));
        if let Some(k) = best {
            if out.iter().all(|s| d2(s.at, good[k].at) >= SITE_CM * SITE_CM * 4) {
                taken[k] = true;
                out.push(good[k]);
            }
        }
    }
    for k in 0..good.len() {
        if !taken[k] && out.iter().all(|s| d2(s.at, good[k].at) >= EVERY_CM * EVERY_CM) {
            taken[k] = true;
            out.push(good[k]);
        }
    }
    out
}

/// The point s cm along a polyline and the unit (Q16) direction there.
fn along(pts: &[P], s: i64) -> Option<(P, P)> {
    let mut acc = 0;
    for w in pts.windows(2) {
        let l = isqrt(d2(w[0], w[1]));
        if l > 0 && acc + l >= s {
            let t = s - acc;
            let q = (w[0].0 + (w[1].0 - w[0].0) * t / l, w[0].1 + (w[1].1 - w[0].1) * t / l);
            return Some((q, ((w[1].0 - w[0].0) * ONE / l, (w[1].1 - w[0].1) * ONE / l)));
        }
        acc += l;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::super::super::organic::geom::inside;
    use super::super::super::Layers;
    use super::*;

    fn layers4() -> &'static Layers {
        static L: std::sync::OnceLock<Layers> = std::sync::OnceLock::new();
        L.get_or_init(|| super::super::doc::layers("claude-hq@4", &[]).unwrap())
    }

    /// The Commons has bus stops on its avenues' kerbs: off every lot and road, each door on its own avenue's pavement,
    /// clear of the junctions; a stop by most stations.
    #[test]
    fn stops_stand_at_the_avenues_kerbs() {
        let l = layers4();
        let stops: Vec<&Site> = l.sites.iter().filter(|s| s.kind == "busstop").collect();
        assert!(stops.len() >= 12, "{} stops", stops.len());
        let pos = |n: u32| l.roads.nodes.iter().find(|m| m.id == n).map(|m| (m.x, m.z)).unwrap();
        for s in &stops {
            assert_eq!(s.tier, Some(super::super::super::transit::BUS_TIER));
            assert!(s.poly.is_none());
            for t in &l.lots {
                let p: Vec<P> = t.poly.as_ref().unwrap().iter().map(|c| (c[0], c[1])).collect();
                assert!(!inside((s.x, s.z), &p), "{} on lot {}", s.id, t.id);
            }
            let door = super::super::super::transit::door(s);
            // the door on an avenue's pavement: within its half width (and a metre) of the centre line, the shelter beyond it
            let on = l.roads.edges.iter().filter(|e| e.class == "arterial").any(|e| {
                e.points.windows(2).any(|w| seg_d2(door, (w[0][0], w[0][2]), (w[1][0], w[1][2])) <= (e.width / 2) * (e.width / 2))
            });
            assert!(on, "{}'s door is on no avenue's pavement", s.id);
            for e in &l.roads.edges {
                for w in e.points.windows(2) {
                    assert!(seg_d2((s.x, s.z), (w[0][0], w[0][2]), (w[1][0], w[1][2])) >= (e.width / 2) * (e.width / 2), "{} on road {}", s.id, e.id);
                }
            }
            // clear of the junctions: no avenue's end within JUNCTION_CM less a step
            let near_end = l.roads.edges.iter().filter(|e| e.class == "arterial").any(|e| [e.a, e.b].iter().any(|&n| d2(pos(n), door) < (JUNCTION_CM - STEP_CM) * (JUNCTION_CM - STEP_CM)));
            assert!(!near_end, "{} at a junction", s.id);
        }
    }

    /// The bus loops run on the avenues alone, from the hub round every stop.
    #[test]
    fn bus_loops_keep_to_the_avenues() {
        let l = layers4();
        let tr = l.transit.as_ref().unwrap();
        let buses: Vec<_> = tr.lines.iter().filter(|x| x.kind == "bus").collect();
        assert!(!buses.is_empty());
        for b in &buses {
            assert!(b.stops.len() >= 3, "{}", b.id);
            for w in b.path.windows(2) {
                let ok = l.roads.edges.iter().any(|e| e.class == "arterial" && ((e.a == w[0] && e.b == w[1]) || (e.a == w[1] && e.b == w[0])));
                assert!(ok, "{}: {} -> {} is no avenue", b.id, w[0], w[1]);
            }
        }
        for s in l.sites.iter().filter(|s| s.kind == "busstop") {
            assert!(buses.iter().any(|b| b.stops.contains(&s.id)), "{} served by no line", s.id);
        }
    }
}
