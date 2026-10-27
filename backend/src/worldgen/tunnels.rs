//! City Gen v4, phase 7: road tunnels. Where the ring road passes behind the airport's
//! terminal, in the corridor the airport left it (claims.rs), it now goes under the ground:
//! a cut-and-cover tunnel the length of the corridor (and a margin), reached down an open
//! cutting `CUT_CM` long at each end (the plan's 175 m at 4 %, for 5.5 m clear and a 1.5 m
//! roof). The ring's edge there is split into five: the ring, a cutting, the tunnel, a
//! cutting, the ring; each piece below the land carries `under` ("cutting" or "tunnel").
//!
//! Heights come in `seat`, after the ring is graded: the tunnel's road `DEPTH_CM` under the
//! lowest ground over its whole length (the airport's land is flat), level; each cutting
//! straight from the ring's height at its outer end down to it. The land over the tunnel is
//! never carved (the airport stands on it), nor is a cutting's: the client cuts it open
//! (games/world.js holes) and draws its retaining walls and portals. The validator holds
//! the depth, the grade and that nothing else crosses a cutting.

use super::claims::Airport;
use super::organic::geom::P;
use super::roads::{path_len, Edge, Node, Roads};
use super::terrain::Terrain;

/// From the road's surface up to the ground over a tunnel: 5.5 m clear and a 1.5 m roof.
pub const DEPTH_CM: i64 = 700;
/// An open cutting's length (cm): down `DEPTH_CM` at 4 %.
pub const CUT_CM: i64 = 17_500;
/// How far (cm) a cutting keeps from the ends of the ring's edge (its junctions).
const END_CM: i64 = 6_000;
/// The tunnel runs on this far (cm) past the corridor at each end.
const MARGIN_CM: i64 = 2_000;
/// A cutting's design grade (per mille), and the steepest it may be (the plan's 6 %).
const DESIGN_PM: i64 = 45;
pub const MAX_PM: i64 = 60;

/// Is this road (or a piece of it) below the land: a tunnel or a cutting?
pub fn under(e: &Edge) -> bool {
    e.under.is_some()
}

/// Take the ring under the airport where it runs in the corridor behind the terminal.
/// Returns how many tunnels were made (0 or 1).
pub fn build(roads: &mut Roads, claim: Option<&Airport>, t: &Terrain) -> usize {
    let Some(a) = claim else { return 0 };
    let Some(k) = roads.edges.iter().position(|e| e.class == "ring" && e.under.is_none() && e.points.windows(2).any(|w| a.in_corridor((w[0][0], w[0][2]), (w[1][0], w[1][2]), 0))) else { return 0 };
    let e = roads.edges[k].clone();
    let pts = &e.points;
    let at: Vec<i64> = along(pts);
    let total = at[at.len() - 1];
    let inside: Vec<usize> = (0..pts.len().saturating_sub(1)).filter(|&i| a.in_corridor((pts[i][0], pts[i][2]), (pts[i + 1][0], pts[i + 1][2]), e.width / 2)).collect();
    let (Some(&i0), Some(&i1)) = (inside.first(), inside.last()) else { return 0 };
    // the covered stretch and the cuttings either side, by distance along the edge
    let (s1, s2) = ((at[i0] - MARGIN_CM).max(0), (at[i1 + 1] + MARGIN_CM).min(total));
    // each cutting long enough to come down from the land at its outer end to the tunnel's floor at DESIGN_PM, at
    // least CUT_CM (the land on the base terrain: edits change heights, never layout)
    let ground = |s: i64| {
        let q = point_at(pts, &at, s);
        t.height_at(q.0, q.1)
    };
    let floor = (s1..=s2).step_by(400).map(ground).min().unwrap_or(0) - DEPTH_CM;
    let (mut s0, mut s3) = (s1 - CUT_CM, s2 + CUT_CM);
    for _ in 0..8 {
        s0 = s1 - CUT_CM.max((ground(s0.max(0)) - floor) * 1000 / DESIGN_PM);
        s3 = s2 + CUT_CM.max((ground(s3.min(total)) - floor) * 1000 / DESIGN_PM);
    }
    // (the cuttings well clear of the junctions at the edge's ends, where other roads join)
    if s0 < END_CM || s3 > total - END_CM {
        return 0;
    }
    let cuts = [s0, s1, s2, s3];
    let mut ids = Vec::new();
    for &s in &cuts {
        let q = point_at(pts, &at, s);
        let id = roads.nodes.len() as u32;
        roads.nodes.push(Node { id, x: q.0, y: t.height_at(q.0, q.1), z: q.1, junction: None, island: None });
        ids.push(id);
    }
    let piece = |a_: u32, b_: u32, from: i64, to: i64, under: Option<&'static str>| Edge {
        id: 0,
        a: a_,
        b: b_,
        points: slice(pts, &at, from, to),
        under,
        ..e.clone()
    };
    let pieces = vec![
        piece(e.a, ids[0], 0, s0, None),
        piece(ids[0], ids[1], s0, s1, Some("cutting")),
        piece(ids[1], ids[2], s1, s2, Some("tunnel")),
        piece(ids[2], ids[3], s2, s3, Some("cutting")),
        piece(ids[3], e.b, s3, total, None),
    ];
    roads.edges.remove(k);
    roads.edges.extend(pieces);
    for (n, x) in roads.edges.iter_mut().enumerate() {
        x.id = n as u32;
    }
    1
}

/// Each point's distance (cm) along a road.
fn along(points: &[[i64; 3]]) -> Vec<i64> {
    let mut at = vec![0i64; points.len()];
    for q in 1..points.len() {
        let (a, b) = (points[q - 1], points[q]);
        at[q] = at[q - 1] + super::noise::isqrt((b[0] - a[0]).pow(2) + (b[2] - a[2]).pow(2));
    }
    at
}

/// The point s cm along a road.
fn point_at(pts: &[[i64; 3]], at: &[i64], s: i64) -> P {
    let k = at.partition_point(|&a| a <= s).clamp(1, pts.len() - 1);
    let (a, b) = (pts[k - 1], pts[k]);
    let l = (at[k] - at[k - 1]).max(1);
    let f = s - at[k - 1];
    (a[0] + (b[0] - a[0]) * f / l, a[2] + (b[2] - a[2]) * f / l)
}

/// The road's points from s0 to s1 (both ends exact).
fn slice(pts: &[[i64; 3]], at: &[i64], s0: i64, s1: i64) -> Vec<[i64; 3]> {
    let (p0, p1) = (point_at(pts, at, s0), point_at(pts, at, s1));
    let mut out = vec![[p0.0, 0, p0.1]];
    for (k, q) in pts.iter().enumerate() {
        if at[k] > s0 + 50 && at[k] < s1 - 50 {
            out.push(*q);
        }
    }
    out.push([p1.0, 0, p1.1]);
    out
}

/// The heights below the land, once the ring is graded: the tunnel level `DEPTH_CM` under
/// the lowest ground over it, its nodes there; each cutting straight from its outer node
/// down to it.
pub fn seat(roads: &mut Roads, t: &Terrain) {
    let tunnels: Vec<usize> = (0..roads.edges.len()).filter(|&k| roads.edges[k].under == Some("tunnel")).collect();
    for k in tunnels {
        let e = &roads.edges[k];
        let floor = e.points.iter().map(|q| t.height_at(q[0], q[2])).min().unwrap_or(0) - DEPTH_CM;
        let (a, b) = (e.a, e.b);
        for q in roads.edges[k].points.iter_mut() {
            q[1] = floor;
        }
        roads.nodes[a as usize].y = floor;
        roads.nodes[b as usize].y = floor;
    }
    for k in 0..roads.edges.len() {
        if roads.edges[k].under != Some("cutting") {
            continue;
        }
        let (ya, yb) = (roads.nodes[roads.edges[k].a as usize].y, roads.nodes[roads.edges[k].b as usize].y);
        let at = along(&roads.edges[k].points);
        let total = at[at.len() - 1].max(1);
        for (q, s) in roads.edges[k].points.iter_mut().zip(at) {
            q[1] = ya + (yb - ya) * s / total;
        }
    }
}

/// The tunnels' and cuttings' length (cm), for the report.
pub fn length(roads: &Roads) -> i64 {
    roads.edges.iter().filter(|e| under(e)).map(|e| path_len(&e.points)).sum()
}
