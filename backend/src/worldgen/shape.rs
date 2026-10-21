//! Version 2 roads, once the layout is settled (HQ 3.2): dirt tracks in the outskirts, and the line they wander.
//!
//! Surfaces. The outskirts' local streets are dirt tracks (`surface: "dirt"`): beyond `DIRT_FROM_PM` of the
//! city's radius always, and in a ragged band from `DIRT_BAND_PM` by a coin per edge, so the town frays out
//! into the country instead of ending at a clean circle. Arterials, the ring, the highways and bridges stay
//! paved.
//!
//! Tracks. A dirt road is drawn as a narrower track inside its corridor, and that track does not run dead
//! straight from node to node like a paved street: each one is a cubic Hermite curve through both of its
//! nodes, on through a node where it simply continues another track (degree 2) on a single shared tangent, and
//! it meanders gently between them. The edge's `points` (its corridor's centre line) are untouched, so every
//! node, junction, lot and site keeps its place, and the lots' rule (clear of the corridor) still holds: the
//! track never strays more than `TRACK_DEV_CM` from the corridor's centre line. (A paved street's line stays
//! straight: its pavements run right up to the lots on both sides, so there is no room to bend it without
//! moving them, which only a new world version may do.)
//!
//! Runs after civic sites, transit and the island tiers are laid. Integer arithmetic only, like the rest of the
//! generator: the same id gives a byte-identical document everywhere.

use std::collections::HashMap;

use super::noise::isqrt;
use super::profile::Profile;
use super::rng::fnv1a64;
use super::roads::{is_graded, Roads};

/// Local streets beyond this share of the city's radius (per mille) are dirt; from DIRT_BAND_PM, some are.
pub const DIRT_FROM_PM: i64 = 860;
pub const DIRT_BAND_PM: i64 = 760;
/// The share of the band's local streets that are dirt (per cent).
pub const DIRT_BAND_PCT: u64 = 45;
/// A track's half width (cm), and so how far it may stray from the centre line of a corridor of half width h:
/// h - TRACK_HALF_CM (a local street's 800 cm corridor: 225 cm).
pub const TRACK_HALF_CM: i64 = 175;
/// A track's points are at most this far apart (cm).
pub const TRACK_STEP_CM: i64 = 300;
/// The meander's largest swing either side (cm), before the corridor's limit.
pub const MEANDER_CM: i64 = 90;
const Q: i64 = 1 << 16;

/// A unit vector (Q16) along (dx, dz); (0, 0) for a zero vector.
fn unit(dx: i64, dz: i64) -> (i64, i64) {
    let l = isqrt(dx * dx + dz * dz);
    if l == 0 {
        (0, 0)
    } else {
        (dx * Q / l, dz * Q / l)
    }
}

/// a + (b - a) * k / Q, renormalised: the tangent eased from `a` towards `b` by `k`.
fn ease(a: (i64, i64), b: (i64, i64), k: i64) -> (i64, i64) {
    unit(a.0 + (b.0 - a.0) * k / Q, a.1 + (b.1 - a.1) * k / Q)
}

fn div_round(a: i64, b: i64) -> i64 {
    (2 * a + if a >= 0 { b } else { -b }) / (2 * b)
}

/// The Hermite curve from p0 to p1 with unit tangents t0, t1 (Q16) scaled to the chord, sampled in n steps.
/// `f` (Q16) is the tangents' length as a share of the chord: shorter pulls the bend in towards the nodes.
pub(crate) fn hermite(p0: (i64, i64), p1: (i64, i64), t0: (i64, i64), t1: (i64, i64), n: i64, f: i64) -> Vec<(i64, i64)> {
    let len = isqrt((p1.0 - p0.0).pow(2) + (p1.1 - p0.1).pow(2)) * f / Q;
    let (m0, m1) = ((t0.0 * len / Q, t0.1 * len / Q), (t1.0 * len / Q, t1.1 * len / Q));
    let s = n * n * n;
    (0..=n)
        .map(|i| {
            // the basis times n^3, in integers
            let (i2, i3) = (i * i, i * i * i);
            let h00 = 2 * i3 - 3 * i2 * n + s;
            let h10 = i3 - 2 * i2 * n + i * n * n;
            let h01 = -2 * i3 + 3 * i2 * n;
            let h11 = i3 - i2 * n;
            let x = h00 * p0.0 + h10 * m0.0 + h01 * p1.0 + h11 * m1.0;
            let z = h00 * p0.1 + h10 * m0.1 + h01 * p1.1 + h11 * m1.1;
            (div_round(x, s), div_round(z, s))
        })
        .collect()
}

/// The furthest the points stray from the line p0-p1 (cm).
pub(crate) fn deviation(pts: &[(i64, i64)], p0: (i64, i64), p1: (i64, i64)) -> i64 {
    let (dx, dz) = (p1.0 - p0.0, p1.1 - p0.1);
    let l = isqrt(dx * dx + dz * dz).max(1);
    pts.iter().map(|q| ((q.0 - p0.0) * dz - (q.1 - p0.1) * dx).abs() / l).max().unwrap_or(0)
}

/// Mark the outskirts' local streets as dirt tracks.
pub fn surfaces(roads: &mut Roads, p: &Profile, seed: u64) {
    let r_city = p.city_r_cm.max(1);
    for e in roads.edges.iter_mut() {
        if e.class != "local" || e.bridge == Some(true) || e.points.len() < 2 {
            continue;
        }
        let m = e.points[e.points.len() / 2];
        let pm = isqrt(m[0] * m[0] + m[2] * m[2]) * 1000 / r_city;
        let coin = fnv1a64(format!("{seed}:dirt:{}", e.id).as_bytes()) % 100;
        if pm >= DIRT_FROM_PM || (pm >= DIRT_BAND_PM && coin < DIRT_BAND_PCT) {
            e.surface = Some("dirt");
        }
    }
}

fn dirt(e: &super::roads::Edge) -> bool {
    e.surface == Some("dirt") && !is_graded(e.class) && e.bridge != Some(true) && e.points.len() >= 2
}

/// Lay each dirt road's track: a Hermite curve through its nodes (on through a node joining two tracks), and
/// a meander, inside its corridor. Run after `surfaces`.
pub fn tracks(roads: &mut Roads, seed: u64) {
    let pos: HashMap<u32, (i64, i64)> = roads.nodes.iter().map(|n| (n.id, (n.x, n.z))).collect();
    let mut inc: HashMap<u32, Vec<usize>> = HashMap::new();
    for (i, e) in roads.edges.iter().enumerate() {
        inc.entry(e.a).or_default().push(i);
        inc.entry(e.b).or_default().push(i);
    }
    // a node a track runs on through: degree 2, both edges dirt; its tangent, out along each of them
    let chord_out = |i: usize, n: u32| -> (i64, i64) {
        let e = &roads.edges[i];
        let (p, q) = if e.a == n { (pos[&e.a], pos[&e.b]) } else { (pos[&e.b], pos[&e.a]) };
        unit(q.0 - p.0, q.1 - p.1)
    };
    let mut through: HashMap<u32, [(usize, (i64, i64)); 2]> = HashMap::new();
    let mut nodes: Vec<u32> = inc.keys().copied().collect();
    nodes.sort_unstable();
    for &n in &nodes {
        let es = &inc[&n];
        if es.len() != 2 || es[0] == es[1] || !dirt(&roads.edges[es[0]]) || !dirt(&roads.edges[es[1]]) {
            continue;
        }
        let (ui, uj) = (chord_out(es[0], n), chord_out(es[1], n));
        let ti = unit(ui.0 - uj.0, ui.1 - uj.1);
        if ti != (0, 0) {
            through.insert(n, [(es[0], ti), (es[1], (-ti.0, -ti.1))]);
        }
    }
    let tangent = |i: usize, n: u32, fallback: (i64, i64), k: &HashMap<u32, i64>| -> (i64, i64) {
        match (through.get(&n), k.get(&n)) {
            (Some(t), Some(&kk)) => ease(fallback, if t[0].0 == i { t[0].1 } else { t[1].1 }, kk),
            _ => fallback,
        }
    };
    let curve = |i: usize, k: &HashMap<u32, i64>, f: i64| -> Option<(Vec<(i64, i64)>, (i64, i64), (i64, i64))> {
        let e = &roads.edges[i];
        let (p0, p1) = (pos[&e.a], pos[&e.b]);
        let c = unit(p1.0 - p0.0, p1.1 - p0.1);
        if c == (0, 0) {
            return None;
        }
        let t0 = tangent(i, e.a, c, k);
        let tb = tangent(i, e.b, (-c.0, -c.1), k);
        let len = isqrt((p1.0 - p0.0).pow(2) + (p1.1 - p0.1).pow(2));
        let n = ((len + TRACK_STEP_CM - 1) / TRACK_STEP_CM).max(2);
        Some((hermite(p0, p1, t0, (-tb.0, -tb.1), n, f), p0, p1))
    };
    // the longest tangents (of a few) whose curve stays in the corridor, keeping the nodes' directions; None if none do
    const LENGTHS: [i64; 4] = [Q, Q / 2, Q / 3, Q / 5];
    let fit = |i: usize, k: &HashMap<u32, i64>, room: i64| -> Option<i64> {
        LENGTHS.iter().copied().find(|&f| curve(i, k, f).is_some_and(|(pts, p0, p1)| deviation(&pts, p0, p1) <= room))
    };
    // how much of the through tangent each node keeps (Q: all), halved for any edge whose curve leaves its corridor
    let mut k: HashMap<u32, i64> = through.keys().map(|&n| (n, Q)).collect();
    for _round in 0..10 {
        let mut over = false;
        for (i, e) in roads.edges.iter().enumerate() {
            if !dirt(e) {
                continue;
            }
            let room = (e.width / 2 - TRACK_HALF_CM).max(0);
            if curve(i, &k, Q).is_some() && fit(i, &k, room).is_none() {
                {
                    // no tangent length fits: ease this edge's nodes' directions back halfway
                    over = true;
                    for nd in [e.a, e.b] {
                        if let Some(v) = k.get_mut(&nd) {
                            *v /= 2;
                        }
                    }
                }
            }
        }
        if !over {
            break;
        }
    }
    let laid: Vec<Option<Vec<[i64; 2]>>> = roads
        .edges
        .iter()
        .enumerate()
        .map(|(i, e)| {
            if !dirt(e) {
                return None;
            }
            let room = (e.width / 2 - TRACK_HALF_CM).max(0);
            let Some(f) = fit(i, &k, room) else {
                let (p0, p1) = (pos[&e.a], pos[&e.b]);
                return Some(vec![[p0.0, p0.1], [p1.0, p1.1]]);     // never out of its corridor: straight
            };
            let (pts, p0, p1) = curve(i, &k, f)?;
            let base = deviation(&pts, p0, p1);
            // the meander: S-bends across the line, none at the ends, within what room the curve left
            let h = fnv1a64(format!("{seed}:track:{}", e.id).as_bytes());
            let amp = (MEANDER_CM / 3 + (h % 1000) as i64 * (MEANDER_CM * 2 / 3) / 1000).min(room - base);
            let len = isqrt((p1.0 - p0.0).pow(2) + (p1.1 - p0.1).pow(2)).max(1);
            let waves = (len / 2_600).clamp(1, 6);                          // a bend every ~26 m
            let flip = if (h >> 20) & 1 == 1 { 1 } else { -1 };
            let (nx, nz) = unit(-(p1.1 - p0.1), p1.0 - p0.0);                // left of the chord
            let n = (pts.len() - 1) as i64;
            Some(
                pts.iter()
                    .enumerate()
                    .map(|(j, q)| {
                        let t = j as i64 * Q / n;                         // 0..Q along the edge
                        let ph = t * waves;                               // half-waves along it
                        let u = ph % Q;
                        let sgn = if (ph / Q) % 2 == 0 { flip } else { -flip };
                        let bump = 4 * u * (Q - u) / Q;                  // 0..Q..0 over each half-wave
                        let taper = 4 * t * (Q - t) / Q;                 // nothing at the nodes
                        let off = if amp > 0 { amp * bump / Q * taper / Q * sgn } else { 0 };
                        [q.0 + nx * off / Q, q.1 + nz * off / Q]
                    })
                    .collect(),
            )
        })
        .collect();
    for (e, t) in roads.edges.iter_mut().zip(laid) {
        e.track = t;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::worldgen::generate;

    fn dist_to_poly(q: (i64, i64), pts: &[[i64; 3]]) -> i64 {
        pts.windows(2)
            .map(|w| {
                let (a, b) = ((w[0][0], w[0][2]), (w[1][0], w[1][2]));
                let (dx, dz) = (b.0 - a.0, b.1 - a.1);
                let l2 = (dx * dx + dz * dz).max(1);
                let t = (((q.0 - a.0) * dx + (q.1 - a.1) * dz) * 1000 / l2).clamp(0, 1000);
                let (px, pz) = (a.0 + dx * t / 1000, a.1 + dz * t / 1000);
                isqrt((q.0 - px).pow(2) + (q.1 - pz).pow(2))
            })
            .min()
            .unwrap_or(i64::MAX)
    }

    #[test]
    fn dirt_tracks_wander_inside_their_corridors_from_node_to_node() {
        for id in ["claude-hq@2", "user:00000000-0000-4000-8000-000000000000@2", "seed-42@2"] {
            let w = generate(id, &[]).unwrap();
            let r = &w.layers.roads;
            let pos: HashMap<u32, (i64, i64)> = r.nodes.iter().map(|n| (n.id, (n.x, n.z))).collect();
            let r_city = super::super::profile_for(id.split('@').next().unwrap(), 2).city_r_cm;
            let mut dirt_n = 0;
            for e in &r.edges {
                if e.surface != Some("dirt") {
                    assert!(e.track.is_none(), "{id}: edge {} has a track but is paved", e.id);
                    continue;
                }
                dirt_n += 1;
                // only the outskirts' local streets, never a bridge or a graded road
                assert_eq!(e.class, "local", "{id}: edge {}", e.id);
                assert!(e.bridge != Some(true));
                let m = e.points[e.points.len() / 2];
                assert!(isqrt(m[0] * m[0] + m[2] * m[2]) * 1000 / r_city >= DIRT_BAND_PM, "{id}: dirt edge {} in town", e.id);
                let t = e.track.as_ref().unwrap_or_else(|| panic!("{id}: dirt edge {} has no track", e.id));
                // from its node to its node, and never out of its corridor (the lots' rule holds for the track too)
                assert_eq!((t[0][0], t[0][1]), pos[&e.a], "{id}: edge {} starts off its node", e.id);
                assert_eq!((t[t.len() - 1][0], t[t.len() - 1][1]), pos[&e.b], "{id}: edge {} ends off its node", e.id);
                let room = e.width / 2 - TRACK_HALF_CM;
                for q in t {
                    assert!(dist_to_poly((q[0], q[1]), &e.points) <= room + 2, "{id}: edge {}'s track leaves its corridor", e.id);
                }
                // sampled finely enough to draw as a curve (a bulge or the meander stretches a step a little)
                for w2 in t.windows(2) {
                    assert!(isqrt((w2[1][0] - w2[0][0]).pow(2) + (w2[1][1] - w2[0][1]).pow(2)) <= TRACK_STEP_CM * 3 / 2, "{id}: edge {}", e.id);
                }
            }
            assert!(dirt_n > 0, "{id}: no dirt tracks at all");
        }
    }

    #[test]
    fn a_track_runs_smoothly_on_through_a_node_it_shares_with_another() {
        let w = generate("claude-hq@2", &[]).unwrap();
        let r = &w.layers.roads;
        let mut at: HashMap<u32, Vec<&super::super::roads::Edge>> = HashMap::new();
        for e in &r.edges {
            at.entry(e.a).or_default().push(e);
            at.entry(e.b).or_default().push(e);
        }
        let (mut checked, mut smooth) = (0, 0);
        let mut ids: Vec<&u32> = at.keys().collect();
        ids.sort_unstable();
        for n in ids {
            let es = &at[n];
            if es.len() != 2 || es.iter().any(|e| e.track.is_none()) {
                continue;
            }
            // each track's first step away from the node: the two must point (nearly) opposite ways
            let away = |e: &super::super::roads::Edge| {
                let t = e.track.as_ref().unwrap();
                let (p, q) = if e.a == *n { (t[0], t[1]) } else { (t[t.len() - 1], t[t.len() - 2]) };
                unit(q[0] - p[0], q[1] - p[1])
            };
            let (u, v) = (away(es[0]), away(es[1]));
            let dot = (u.0 * v.0 + u.1 * v.1) / Q;                  // -Q is dead straight on through
            // never more of a kink than the corridors' own (a sharp corner has too little room to round off)
            let chord = |e: &super::super::roads::Edge| {
                let (p, q) = if e.a == *n { (e.points[0], e.points[e.points.len() - 1]) } else { (e.points[e.points.len() - 1], e.points[0]) };
                unit(q[0] - p[0], q[2] - p[2])
            };
            let (cu, cv) = (chord(es[0]), chord(es[1]));
            let cdot = (cu.0 * cv.0 + cu.1 * cv.1) / Q;
            assert!(dot <= cdot + Q / 50, "node {n}: the tracks kink more than the corridors ({dot} vs {cdot})");
            checked += 1;
            if dot < -Q * 95 / 100 {
                smooth += 1;
            }
        }
        assert!(checked > 10, "too few tracks run on through a node ({checked})");
        // and most such nodes come out smooth (within ~18 degrees of straight on)
        assert!(smooth * 10 >= checked * 7, "only {smooth} of {checked} through nodes are smooth");
    }

    #[test]
    fn the_same_world_lays_the_same_tracks() {
        let (a, b) = (generate("claude-hq@2", &[]).unwrap(), generate("claude-hq@2", &[]).unwrap());
        assert_eq!(a.hashes.roads, b.hashes.roads);
    }
}
