//! City Gen v5: the metro, laid for the most connectivity, underground, curves only (align.rs), in the volume.
//!
//!   1. where people travel: the homes split into `HOME_GROUPS` catchments round the hub (equal shares by bearing), the
//!      industry into the port's and the airport's, and the airport's terminal; destinations nearer than `MERGE_CM`
//!      are one;
//!   2. lines through the hub: the destination farthest round is paired with the one most nearly opposite it, a line
//!      from one through the hub to the other; one left over gets a branch; a gap over `INFILL_CM` between stations
//!      gets one at its middle;
//!   3. each station on a straight platform `PLATFORM_CM` long, along its line (its chord: from the station before to
//!      the one after); between platforms the track is a curve (align::connect), so no line has a corner anywhere;
//!   4. each line at its own depth, `LEVEL_GAP_CM` below the one before (lines cross without meeting); its tunnels,
//!      platforms and a concourse over each station carved in the volume, and two entrances on free ground beside it
//!      (toward each end of its platform, else anywhere round it out to 150 m).
use super::airport::{Airport, APRON_W_CM, STRIP_W_CM};
use super::align::{connect, Pose};
use super::land::Land;
use super::landuse::{LandUse, Use};
use super::space::Space;
use super::super::organic::geom::P;

pub const HOME_GROUPS: usize = 4;
pub const MERGE_CM: i64 = 25_000;
pub const INFILL_CM: i64 = 65_000;
pub const PLATFORM_CM: f64 = 12_000.0;
pub const TOP_CM: i64 = 2_000;
pub const LEVEL_GAP_CM: i64 = 900;
pub const TUNNEL_HW_CM: i64 = 450;
pub const TUNNEL_UP_CM: i64 = 700;

#[derive(Clone, Debug)]
pub struct Station {
    pub id: usize,
    pub c: P,
    pub heading: f64,
    pub lines: Vec<usize>,
    /// The rail's level per line (cm, absolute), and the entrances' spots on the street.
    pub rail_y: Vec<i64>,
    pub entrances: Vec<P>,
}

#[derive(Clone, Debug)]
pub struct Line {
    pub id: usize,
    pub stations: Vec<usize>,
    /// The track's centre: [x, y, z] cm, every 4 m.
    pub path: Vec<[i64; 3]>,
    /// Its tightest curve (cm).
    pub min_r: i64,
    pub rail_y: i64,
}

pub struct Metro {
    pub lines: Vec<Line>,
    pub stations: Vec<Station>,
}

fn d(a: P, b: P) -> i64 {
    ((a.0 - b.0) as f64).hypot((a.1 - b.1) as f64) as i64
}

fn bearing(o: P, q: P) -> f64 {
    ((q.1 - o.1) as f64).atan2((q.0 - o.0) as f64)
}

fn centroid(ps: &[P]) -> P {
    let n = ps.len().max(1) as i64;
    (ps.iter().map(|q| q.0).sum::<i64>() / n, ps.iter().map(|q| q.1).sum::<i64>() / n)
}

/// Where the metro should go: the home catchments, the industrial clusters, the airport's terminal.
pub fn destinations(lu: &LandUse, ap: &Airport) -> Vec<P> {
    let mut homes: Vec<(f64, P)> = lu.buildings.iter().filter(|b| b.use_ == Use::Home).map(|b| (bearing(lu.hub, b.c), b.c)).collect();
    homes.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut out: Vec<P> = Vec::new();
    if !homes.is_empty() {
        // (the split starts at the widest gap in bearing, so no catchment straddles an empty side)
        let n = homes.len();
        let gap = (0..n).max_by(|&i, &j| {
            let g = |k: usize| { let a = homes[k].0; let b = homes[(k + 1) % n].0; (b - a).rem_euclid(std::f64::consts::TAU) };
            g(i).total_cmp(&g(j))
        }).unwrap_or(0);
        let ordered: Vec<P> = (0..n).map(|k| homes[(gap + 1 + k) % n].1).collect();
        for g in 0..HOME_GROUPS {
            let part = &ordered[g * n / HOME_GROUPS..(g + 1) * n / HOME_GROUPS];
            if !part.is_empty() {
                out.push(centroid(part));
            }
        }
    }
    let ind: Vec<P> = lu.buildings.iter().filter(|b| b.use_ == Use::Industry).map(|b| b.c).collect();
    let port = lu.port.map(|p| p.0);
    let (by_port, by_air): (Vec<P>, Vec<P>) = ind.iter().partition(|&&q| port.is_some_and(|p| d(q, p) < d(q, ap.c)));
    for g in [by_port, by_air] {
        if !g.is_empty() {
            out.push(centroid(&g));
        }
    }
    // the terminal: the apron's middle
    let w = ap.side * (STRIP_W_CM / 2 + APRON_W_CM / 2);
    out.push((ap.c.0 - ap.dir.1 * w / 1000, ap.c.1 + ap.dir.0 * w / 1000));
    let mut merged: Vec<P> = Vec::new();
    for q in out {
        if merged.iter().all(|&m| d(m, q) >= MERGE_CM) && d(q, lu.hub) >= MERGE_CM {
            merged.push(q);
        }
    }
    merged
}

/// The lines' station sequences (points), each through the hub.
pub fn routes(hub: P, dests: &[P]) -> Vec<Vec<P>> {
    let mut left: Vec<P> = dests.to_vec();
    let mut out = Vec::new();
    while !left.is_empty() {
        // the farthest destination, paired with the one most nearly opposite it across the hub
        let (i, _) = left.iter().enumerate().max_by_key(|(_, &q)| (d(q, hub), q)).unwrap();
        let a = left.remove(i);
        let ba = bearing(hub, a);
        let opp = left.iter().enumerate().map(|(k, &q)| {
            let diff = (bearing(hub, q) - ba).rem_euclid(std::f64::consts::TAU);
            ((diff - std::f64::consts::PI).abs(), k)
        }).filter(|(off, _)| *off < std::f64::consts::FRAC_PI_2).min_by(|x, y| x.0.total_cmp(&y.0)).map(|(_, k)| k);
        let mut seq = vec![a, hub];
        if let Some(k) = opp {
            seq.push(left.remove(k));
        }
        // infill: a station mid-way where two are more than INFILL_CM apart
        let mut full = vec![seq[0]];
        for w in seq.windows(2) {
            if d(w[0], w[1]) > INFILL_CM {
                full.push(((w[0].0 + w[1].0) / 2, (w[0].1 + w[1].1) / 2));
            }
            full.push(w[1]);
        }
        out.push(full);
    }
    out
}

pub fn plan(land: &Land, lu: &LandUse, ap: &Airport, space: &mut Space) -> Metro {
    let datum = land.height(lu.hub);
    let mut stations: Vec<Station> = Vec::new();
    let mut lines = Vec::new();
    let station_at = |stations: &mut Vec<Station>, q: P| -> usize {
        if let Some(s) = stations.iter().position(|s| d(s.c, q) < 2_000) {
            return s;
        }
        stations.push(Station { id: stations.len(), c: q, heading: 0.0, lines: Vec::new(), rail_y: Vec::new(), entrances: Vec::new() });
        stations.len() - 1
    };
    for (li, seq) in routes(lu.hub, &destinations(lu, ap)).into_iter().enumerate() {
        let rail_y = datum - TOP_CM - LEVEL_GAP_CM * li as i64;
        let ids: Vec<usize> = seq.iter().map(|&q| station_at(&mut stations, q)).collect();
        // each station's heading: along its chord (the station before to the one after)
        let head: Vec<f64> = (0..seq.len()).map(|k| {
            let (a, b) = (seq[k.saturating_sub(1)], seq[(k + 1).min(seq.len() - 1)]);
            ((b.1 - a.1) as f64).atan2((b.0 - a.0) as f64)
        }).collect();
        let half = PLATFORM_CM / 2.0;
        let pose = |k: usize, s: f64| -> Pose { let q = seq[k]; (q.0 as f64 + s * half * head[k].cos(), q.1 as f64 + s * half * head[k].sin(), head[k]) };
        let mut pts: Vec<Pose> = Vec::new();
        let mut min_r = f64::INFINITY;
        for k in 0..seq.len() {
            // the platform: straight
            let (a, b) = (pose(k, -1.0), pose(k, 1.0));
            let n = (PLATFORM_CM / 400.0) as usize;
            for i in 0..=n {
                let t = i as f64 / n as f64;
                pts.push((a.0 + (b.0 - a.0) * t, a.1 + (b.1 - a.1) * t, head[k]));
            }
            if k + 1 < seq.len() {
                let (r, c) = connect(b, pose(k + 1, -1.0));
                min_r = min_r.min(r);
                pts.extend(c.into_iter().skip(1));
            }
        }
        pts.dedup_by(|a, b| (a.0 - b.0).abs() < 1.0 && (a.1 - b.1).abs() < 1.0);
        let path: Vec<[i64; 3]> = pts.iter().map(|p| [p.0.round() as i64, rail_y, p.1.round() as i64]).collect();
        // the volume: the tunnel (its own steps may touch, other lines' are a level apart)
        let _ = space.sweep("metro", &format!("M{}", li + 1), &path, TUNNEL_HW_CM, TUNNEL_UP_CM, 0);
        for (k, &s) in ids.iter().enumerate() {
            let st = &mut stations[s];
            st.lines.push(li);
            st.rail_y.push(rail_y);
            if st.lines.len() == 1 {
                st.heading = head[k];
            }
        }
        lines.push(Line { id: li, stations: ids, path, min_r: min_r as i64, rail_y });
    }
    // each station: a concourse in the shallow level over it, two entrances on free ground beside it
    for st in stations.iter_mut() {
        let g = land.height(st.c);
        let (hx, hz) = (st.heading.cos(), st.heading.sin());
        let rect = |c: P, a: f64, b: f64| -> Vec<P> {
            let (ux, uz, vx, vz) = (hx * a, hz * a, -hz * b, hx * b);
            vec![(c.0 + (-ux - vx) as i64, c.1 + (-uz - vz) as i64), (c.0 + (ux - vx) as i64, c.1 + (uz - vz) as i64),
                 (c.0 + (ux + vx) as i64, c.1 + (uz + vz) as i64), (c.0 + (-ux + vx) as i64, c.1 + (-uz + vz) as i64)]
        };
        let _ = space.carve("concourse", "metro", rect(st.c, 3_000.0, 1_000.0), g - 800, g - 250, 0);
        for side in [1.0, -1.0] {
            // the nearest free street-level spot 20-80 m off the platform's end on this side
            // (nearest first, toward its end, then anywhere round it out to 150 m: a terminal's station rises at the
            // airport's landside edge)
            let spot = (2..16).flat_map(|k| (0..24).map(move |a| (k, a))).find_map(|(k, a)| {
                let off = if a % 2 == 0 { (a / 2) as f64 } else { -((a + 1) / 2) as f64 } * 0.26;
                let ang = st.heading + if side > 0.0 { 0.0 } else { std::f64::consts::PI } + off;
                let q = (st.c.0 + (ang.cos() * k as f64 * 1_000.0) as i64, st.c.1 + (ang.sin() * k as f64 * 1_000.0) as i64);
                let foot = rect(q, 400.0, 200.0);
                (land.dry(q) && space.blocker(&foot, g - 800, g + 400, 300).is_none()).then_some((q, foot))
            });
            if let Some((q, foot)) = spot {
                space.put("entrance", "metro", foot, g - 800, g + 400);
                st.entrances.push(q);
            }
        }
    }
    Metro { lines, stations }
}

#[cfg(test)]
mod tests {
    use super::super::City;
    use super::*;

    fn commons() -> (Land, LandUse, Airport, Metro) {
        let c = City::plan("claude-hq").unwrap();
        (c.land, c.landuse, c.airport, c.metro)
    }

    #[test]
    fn no_line_has_a_corner() {
        let (_, _, _, m) = commons();
        assert!(m.lines.len() >= 2, "{} lines", m.lines.len());
        for l in &m.lines {
            assert!(l.min_r >= 12_000, "M{}: a {} m curve", l.id + 1, l.min_r / 100);
            for w in l.path.windows(3) {
                let (a, b, c) = ((w[0][0] as f64, w[0][2] as f64), (w[1][0] as f64, w[1][2] as f64), (w[2][0] as f64, w[2][2] as f64));
                let (h1, h2) = ((b.1 - a.1).atan2(b.0 - a.0), (c.1 - b.1).atan2(c.0 - b.0));
                let turn = (h2 - h1 + std::f64::consts::PI).rem_euclid(std::f64::consts::TAU) - std::f64::consts::PI;
                let step = (b.0 - a.0).hypot(b.1 - a.1).max(1.0);
                // a turn within its step's share of the tightest radius (and its rounding): a curve, never a corner
                assert!(turn.abs() <= step / 12_000.0 * 1.2 + 0.01, "M{}: turns {:.1} degrees in a step at ({:.0}, {:.0})", l.id + 1, turn.to_degrees(), b.0 / 100.0, b.1 / 100.0);
            }
        }
    }

    #[test]
    fn every_line_passes_the_hub_and_lines_cross_at_their_own_depths() {
        let (_, lu, _, m) = commons();
        let hub = m.stations.iter().position(|s| d(s.c, lu.hub) < 2_000).expect("a hub station");
        assert!(m.lines.iter().all(|l| l.stations.contains(&hub)));
        let mut ys: Vec<i64> = m.lines.iter().map(|l| l.rail_y).collect();
        ys.dedup();
        assert_eq!(ys.len(), m.lines.len(), "each line its own depth");
    }

    #[test]
    fn the_metro_reaches_the_homes_the_industry_and_the_airport() {
        let (_, lu, ap, m) = commons();
        let near = |q: P, r: i64| m.stations.iter().any(|s| d(s.c, q) <= r);
        let homes: Vec<P> = lu.buildings.iter().filter(|b| b.use_ == Use::Home).map(|b| b.c).collect();
        let served = homes.iter().filter(|&&q| near(q, 50_000)).count();
        assert!(served * 100 >= homes.len() * 55, "{served} of {} homes within 500 m of a station", homes.len());
        let w = ap.side * (STRIP_W_CM / 2 + APRON_W_CM / 2);
        assert!(near((ap.c.0 - ap.dir.1 * w / 1000, ap.c.1 + ap.dir.0 * w / 1000), 30_000), "a station at the terminal");
        assert!(m.stations.iter().all(|s| !s.entrances.is_empty()), "every station has a way in");
    }
}

#[cfg(test)]
mod show {
    /// V5_DUMP=<file> cargo test --release show_the_commons_metro -- --ignored: the plan and its metro as JSON.
    #[test]
    #[ignore]
    fn show_the_commons_metro() {
        let c = super::super::City::plan("claude-hq").unwrap();
        let (land, ap, lu, m) = (&c.land, &c.airport, &c.landuse, &c.metro);
        let j = serde_json::json!({
            "coast": land.coast.as_ref().map(|c| c.poly.clone()), "water": land.water, "airport": ap.poly, "hub": lu.hub, "port": lu.port.map(|p| p.0),
            "cells": lu.cells.iter().map(|(q, u)| (q, format!("{u:?}"))).collect::<Vec<_>>(),
            "buildings": lu.buildings.iter().map(|b| (b.poly.clone(), format!("{:?}", b.use_), b.h)).collect::<Vec<_>>(),
            "arterials": c.arterials.iter().map(|r| (r.points.iter().map(|p| (p[0], p[2])).collect::<Vec<_>>(), (r.min_r / 100.0) as i64)).collect::<Vec<_>>(),
            "centres": c.centres.clone(),
            "rail": c.rail.iter().map(|l| (l.id, l.path.iter().map(|p| (p[0], p[2])).collect::<Vec<_>>(), l.kinds.clone())).collect::<Vec<_>>(),
            "lines": m.lines.iter().map(|l| (l.path.iter().map(|p| (p[0], p[2])).collect::<Vec<_>>(), l.min_r, l.rail_y)).collect::<Vec<_>>(),
            "stations": m.stations.iter().map(|s| (s.c, s.entrances.clone(), s.lines.clone())).collect::<Vec<_>>(),
        });
        if let Ok(path) = std::env::var("V5_DUMP") {
            std::fs::write(path, j.to_string()).unwrap();
        }
        for l in &m.lines {
            eprintln!("M{}: {} stations, tightest curve {} m, rail {} m", l.id + 1, l.stations.len(), l.min_r / 100, l.rail_y / 100);
        }
    }
}
