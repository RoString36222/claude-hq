//! City Gen v5: the metro, laid for the most connectivity, underground, curves only (align.rs), in the volume.
//!
//!   1. where people travel: the homes split into `HOME_GROUPS` catchments round the hub (equal shares by bearing), the
//!      industry into the port's and the airport's, and the airport's terminal; destinations nearer than `MERGE_CM`
//!      are one;
//!   2. lines through the hub: the destination farthest round is paired with the one most nearly opposite it, a line
//!      from one through the hub to the other, at most `HUB_LINES` of them (every hall-to-platform stair within
//!      `DROP_CM`); a destination left over gets a branch, a line from it to the nearest station of a line already
//!      laid (not the hub), a level under that line there; a gap over `INFILL_CM` between stations gets one at its
//!      middle;
//!   3. each station on a straight platform `PLATFORM_CM` long, along its line (its chord: from the station before to
//!      the one after); between platforms the track is a curve (align::connect), so no line has a corner anywhere;
//!   4. each line at its own depth under the ground, `TOP_CM` and then `LEVEL_GAP_CM` below the line before at every
//!      station (lines cross without meeting), graded evenly between its stations; its tunnels,
//!      platforms and a concourse over each station carved in the volume, and two entrances on free ground beside it
//!      (toward each end of its platform, else anywhere round it out to 150 m).
use super::airport::{Airport, TERMINAL_CM};
use super::align::{connect, Pose};
use super::land::Land;
use super::landuse::{LandUse, Use};
use super::space::Space;
use super::super::organic::geom::P;

pub const HOME_GROUPS: usize = 4;
pub const MERGE_CM: i64 = 25_000;
pub const INFILL_CM: i64 = 65_000;
pub const PLATFORM_CM: f64 = 12_000.0;
pub const TOP_CM: i64 = 1_600;
pub const LEVEL_GAP_CM: i64 = 800;
/// The steepest a line climbs between its platforms (3%; the curve between them is a little longer than their gap).
pub const GRADE: f64 = 0.03;
/// The least ground over a tunnel's roof (cm).
pub const COVER_CM: i64 = 300;
/// A ticket hall's floor under the street, and the most its platforms' stairs go down from it (cm).
pub const HALL_CM: i64 = 800;
pub const DROP_CM: i64 = 2_300;
/// The most lines through the hub: lines crossing there are a tunnel's height and a margin apart (`TUNNEL_UP_CM` + 50),
/// the hall over the highest one's tunnel (+ 100), so n lines put the deepest platform (n - 1) * 750 + 690 under the
/// hall: three within `DROP_CM`, four not.
pub const HUB_LINES: usize = 3;
/// A platform's top over its rail (cm).
const FLOOR_CM: i64 = 110;
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
    /// Its ticket hall's floor (cm, absolute): `HALL_CM` under the street, lower over deep platforms (at most `DROP_CM`
    /// down to the deepest), above every line's tunnel.
    pub hall_y: i64,
}

#[derive(Clone, Debug)]
pub struct Line {
    pub id: usize,
    pub stations: Vec<usize>,
    /// The track's centre: [x, y, z] cm, every 4 m.
    pub path: Vec<[i64; 3]>,
    /// Its tightest curve (cm).
    pub min_r: i64,
    /// Its rail's level at the hub (cm, absolute): each line its own.
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
    let w = ap.side * (TERMINAL_CM);
    out.push((ap.c.0 - ap.dir.1 * w / 1000, ap.c.1 + ap.dir.0 * w / 1000));
    let mut merged: Vec<P> = Vec::new();
    for q in out {
        if merged.iter().all(|&m| d(m, q) >= MERGE_CM) && d(q, lu.hub) >= MERGE_CM {
            merged.push(q);
        }
    }
    merged
}

/// The lines' station sequences (points): `HUB_LINES` at most through the hub, then the branches, each from a
/// destination left over to the nearest station (not the hub) of a line before it, its last.
pub fn routes(hub: P, dests: &[P]) -> Vec<Vec<P>> {
    let mut left: Vec<P> = dests.to_vec();
    let mut out: Vec<Vec<P>> = Vec::new();
    let infill = |seq: Vec<P>| {
        let mut full = vec![seq[0]];
        for w in seq.windows(2) {
            if d(w[0], w[1]) > INFILL_CM {
                full.push(((w[0].0 + w[1].0) / 2, (w[0].1 + w[1].1) / 2));
            }
            full.push(w[1]);
        }
        full
    };
    while !left.is_empty() {
        if out.len() >= HUB_LINES {
            // a branch: the destination farthest out first, to the nearest station off the hub
            let (i, _) = left.iter().enumerate().max_by_key(|(_, &q)| (d(q, hub), q)).unwrap();
            let a = left.remove(i);
            let to = out.iter().flatten().copied().filter(|&q| d(q, hub) >= 2_000).min_by_key(|&q| (d(q, a), q));
            out.push(infill(vec![a, to.unwrap_or(hub)]));
            continue;
        }
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
        out.push(infill(seq));
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
        stations.push(Station { id: stations.len(), c: q, heading: 0.0, lines: Vec::new(), rail_y: Vec::new(), entrances: Vec::new(), hall_y: 0 });
        stations.len() - 1
    };
    // what a line passes under (the water's level, the airport's box, the rail's tunnels): their boxes' bounds and bottoms
    let under: Vec<(Vec<P>, (i64, i64, i64, i64), i64, i64)> = space.solids.iter().filter(|o| matches!(o.kind, "water" | "airport" | "rail")).map(|o| {
        let (xs, zs) = (o.poly.iter().map(|q| q.0), o.poly.iter().map(|q| q.1));
        (o.poly.clone(), (xs.clone().min().unwrap_or(0), zs.clone().min().unwrap_or(0), xs.max().unwrap_or(0), zs.max().unwrap_or(0)), o.y0, o.y1)
    }).collect();
    for (li, seq) in routes(lu.hub, &destinations(lu, ap)).into_iter().enumerate() {
        // its depth: a level under the line before it at the hub; a branch's a level under the line it meets
        let meets = (!seq.contains(&lu.hub)).then(|| seq[seq.len() - 1]);
        let host = meets.and_then(|q| stations.iter().find(|s| d(s.c, q) < 2_000)).and_then(|s| s.rail_y.iter().copied().min().map(|y| land.height(s.c) - y));
        let below = host.map_or(TOP_CM + LEVEL_GAP_CM * li as i64, |h| h + LEVEL_GAP_CM);
        let rail_y = meets.map_or(datum, |q| land.height(q)) - below;
        // the rail at each station, its depth under that station's ground
        let mut ys: Vec<f64> = seq.iter().map(|&q| (land.height(q) - below) as f64).collect();
        // within GRADE between platforms (their ends `gap` apart): the higher of two too far apart goes deeper
        let gap: Vec<f64> = seq.windows(2).map(|w| (d(w[0], w[1]) as f64 - PLATFORM_CM).max(2_000.0)).collect();
        for _ in 0..seq.len() {
            for k in 0..gap.len() {
                let lim = GRADE * gap[k];
                if ys[k] - ys[k + 1] > lim { ys[k] = ys[k + 1] + lim; }
                if ys[k + 1] - ys[k] > lim { ys[k + 1] = ys[k] + lim; }
            }
        }
        let ids: Vec<usize> = seq.iter().map(|&q| station_at(&mut stations, q)).collect();
        // each station's heading: along its chord (the station before to the one after)
        let head: Vec<f64> = (0..seq.len()).map(|k| {
            let (a, b) = (seq[k.saturating_sub(1)], seq[(k + 1).min(seq.len() - 1)]);
            ((b.1 - a.1) as f64).atan2((b.0 - a.0) as f64)
        }).collect();
        let half = PLATFORM_CM / 2.0;
        let pose = |k: usize, s: f64| -> Pose { let q = seq[k]; (q.0 as f64 + s * half * head[k].cos(), q.1 as f64 + s * half * head[k].sin(), head[k]) };
        let mut pts: Vec<Pose> = Vec::new();
        let mut level: Vec<f64> = Vec::new();
        let mut plat: Vec<Option<usize>> = Vec::new();
        let mut min_r = f64::INFINITY;
        for k in 0..seq.len() {
            // the platform: straight
            let (a, b) = (pose(k, -1.0), pose(k, 1.0));
            let n = (PLATFORM_CM / 400.0) as usize;
            for i in 0..=n {
                let t = i as f64 / n as f64;
                pts.push((a.0 + (b.0 - a.0) * t, a.1 + (b.1 - a.1) * t, head[k]));
                level.push(ys[k]);
                plat.push(Some(k));
            }
            if k + 1 < seq.len() {
                let (r, c) = connect(b, pose(k + 1, -1.0));
                min_r = min_r.min(r);
                // graded evenly (by length) from this platform's level to the next one's
                let mut run = vec![0.0];
                for w in c.windows(2) {
                    run.push(run[run.len() - 1] + (w[1].0 - w[0].0).hypot(w[1].1 - w[0].1));
                }
                let total = run[run.len() - 1].max(1.0);
                for (i, p) in c.into_iter().enumerate().skip(1) {
                    pts.push(p);
                    level.push(ys[k] + (ys[k + 1] - ys[k]) * run[i] / total);
                    plat.push(None);
                }
            }
        }
        let mut at: Vec<(Pose, f64, Option<usize>)> = pts.into_iter().zip(level).zip(plat).map(|((p, y), k)| (p, y, k)).collect();
        at.dedup_by(|a, b| (a.0 .0 - b.0 .0).abs() < 1.0 && (a.0 .1 - b.0 .1).abs() < 1.0);
        // under a rise between stations the line goes deeper (COVER_CM over its tunnel), its platforms kept level and its
        // grades within GRADE: each pass only lowers, until nothing moves
        // (and under the water, the airport and the rail, and a level under every line laid before it where they cross)
        let reach = 2 * TUNNEL_HW_CM + 100;
        let cap: Vec<f64> = at.iter().map(|a| {
            let q = (a.0 .0 as i64, a.0 .1 as i64);
            let mut c = land.height(q) - TUNNEL_UP_CM - COVER_CM;
            for l in &lines {
                let l: &Line = l;
                for p in &l.path {
                    if (p[0] - q.0).abs() < reach && (p[2] - q.1).abs() < reach {
                        c = c.min(p[1] - TUNNEL_UP_CM - 50);
                    }
                }
            }
            let foot = [(q.0 - TUNNEL_HW_CM, q.1 - TUNNEL_HW_CM), (q.0 + TUNNEL_HW_CM, q.1 - TUNNEL_HW_CM), (q.0 + TUNNEL_HW_CM, q.1 + TUNNEL_HW_CM), (q.0 - TUNNEL_HW_CM, q.1 + TUNNEL_HW_CM)];
            // (a box wholly under the line's own level, a deep rail tunnel, it passes over)
            for (poly, b, y0, y1) in &under {
                if *y1 + 10 <= c.min(a.1 as i64) {
                    continue;
                }
                if q.0 >= b.0 - TUNNEL_HW_CM && q.0 <= b.2 + TUNNEL_HW_CM && q.1 >= b.1 - TUNNEL_HW_CM && q.1 <= b.3 + TUNNEL_HW_CM
                    && super::space::near(&foot, poly, 1) {
                    c = c.min(y0 - TUNNEL_UP_CM - 100);
                }
            }
            c as f64
        }).collect();
        let step: Vec<f64> = (0..at.len()).map(|i| if i == 0 { 0.0 } else { (at[i].0 .0 - at[i - 1].0 .0).hypot(at[i].0 .1 - at[i - 1].0 .1) }).collect();
        for _ in 0..16 {
            let before: f64 = at.iter().map(|a| a.1).sum();
            for (a, &c) in at.iter_mut().zip(&cap) {
                a.1 = a.1.min(c);
            }
            for k in 0..seq.len() {
                let low = at.iter().filter(|a| a.2 == Some(k)).map(|a| a.1).fold(f64::INFINITY, f64::min);
                at.iter_mut().filter(|a| a.2 == Some(k)).for_each(|a| a.1 = low);
                ys[k] = low;
            }
            for i in 1..at.len() {
                at[i].1 = at[i].1.min(at[i - 1].1 + GRADE * step[i]);
            }
            for i in (1..at.len()).rev() {
                at[i - 1].1 = at[i - 1].1.min(at[i].1 + GRADE * step[i]);
            }
            if (before - at.iter().map(|a| a.1).sum::<f64>()).abs() < 1.0 {
                break;
            }
        }
        let path: Vec<[i64; 3]> = at.iter().map(|(p, y, _)| [p.0.round() as i64, y.round() as i64, p.1.round() as i64]).collect();
        // the volume: the tunnel (its own steps may touch, other lines' are a level apart)
        let swept = space.sweep("metro", &format!("M{}", li + 1), &path, TUNNEL_HW_CM, TUNNEL_UP_CM, 0);
        debug_assert!(swept.is_ok(), "M{}: its tunnel meets {:?}", li + 1, swept.err().map(|b| space.solids[b as usize].kind));
        for (k, &s) in ids.iter().enumerate() {
            let st = &mut stations[s];
            st.lines.push(li);
            st.rail_y.push(ys[k].round() as i64);
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
        let (low, high) = (st.rail_y.iter().copied().min().unwrap_or(g), st.rail_y.iter().copied().max().unwrap_or(g));
        st.hall_y = (g - HALL_CM).min(low + FLOOR_CM + DROP_CM).max(high + TUNNEL_UP_CM + 100);
        let _ = space.carve("concourse", "metro", rect(st.c, 3_000.0, 1_000.0), st.hall_y, st.hall_y + 550, 0);
        // (the terminal's station: its ways up are inside the terminal, in the airport's box)
        let ignore: &[&str] = if super::super::organic::geom::inside(st.c, &ap.poly) { &["airport"] } else { &[] };
        for side in [1.0, -1.0] {
            // the nearest free street-level spot 20-80 m off the platform's end on this side
            // (nearest first, toward its end, then anywhere round it out to 150 m: a terminal's station rises at the
            // airport's landside edge)
            let spot = (2..16).flat_map(|k| (0..24).map(move |a| (k, a))).find_map(|(k, a)| {
                let off = if a % 2 == 0 { (a / 2) as f64 } else { -((a + 1) / 2) as f64 } * 0.26;
                let ang = st.heading + if side > 0.0 { 0.0 } else { std::f64::consts::PI } + off;
                let q = (st.c.0 + (ang.cos() * k as f64 * 1_000.0) as i64, st.c.1 + (ang.sin() * k as f64 * 1_000.0) as i64);
                let foot = rect(q, 400.0, 200.0);
                (land.dry(q) && space.blocker_but(&foot, st.hall_y, g + 400, 300, ignore).is_none()).then_some((q, foot))
            });
            if let Some((q, foot)) = spot {
                space.put("entrance", "metro", foot, st.hall_y, g + 400);
                st.entrances.push(q);
            }
        }
    }
    Metro { lines, stations }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn commons() -> (&'static Land, &'static LandUse, &'static Airport, &'static Metro) {
        let c = super::super::commons();
        (&c.land, &c.landuse, &c.airport, &c.metro)
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
    fn every_line_passes_the_hub_or_branches_off_one_and_lines_cross_at_their_own_depths() {
        let (_, lu, _, m) = commons();
        let hub = m.stations.iter().position(|s| d(s.c, lu.hub) < 2_000).expect("a hub station");
        let through = m.lines.iter().filter(|l| l.stations.contains(&hub)).count();
        assert!((1..=HUB_LINES).contains(&through), "{through} lines through the hub");
        for l in m.lines.iter().filter(|l| !l.stations.contains(&hub)) {
            let end = *l.stations.last().unwrap();
            assert!(m.lines.iter().any(|o| o.id < l.id && o.stations.contains(&end)), "M{} branches off a line before it", l.id + 1);
        }
        let mut ys: Vec<i64> = m.lines.iter().map(|l| l.rail_y).collect();
        ys.dedup();
        assert_eq!(ys.len(), m.lines.len(), "each line its own depth");
    }

    #[test]
    fn every_line_runs_under_the_ground_at_a_metro_grade() {
        let (land, _, _, m) = commons();
        for l in &m.lines {
            for w in l.path.windows(2) {
                let run = ((w[1][0] - w[0][0]) as f64).hypot((w[1][2] - w[0][2]) as f64).max(1.0);
                assert!(((w[1][1] - w[0][1]) as f64 / run).abs() <= GRADE + 0.005, "M{}: a {:.1}% grade at ({}, {})", l.id + 1,
                        (w[1][1] - w[0][1]) as f64 / run * 100.0, w[0][0] / 100, w[0][2] / 100);
            }
            for p in &l.path {
                let g = land.height((p[0], p[2]));
                assert!(p[1] + TUNNEL_UP_CM <= g - COVER_CM + 2, "M{}: {} m of cover at ({}, {})", l.id + 1, (g - p[1] - TUNNEL_UP_CM) / 100, p[0] / 100, p[2] / 100);
            }
        }
        for s in &m.stations {
            let g = land.height(s.c);
            assert!(s.rail_y.iter().all(|&y| g - y >= TOP_CM), "metro:{}: a platform {} m under its ground", s.id, s.rail_y.iter().map(|&y| (g - y) / 100).min().unwrap_or(0));
        }
    }

    /// Every platform can be walked up to its hall: the stairs drop at most DROP_CM (Central's interchange too).
    #[test]
    fn every_platform_is_within_a_stair_of_its_hall() {
        let (_, _, _, m) = commons();
        for s in &m.stations {
            for &y in &s.rail_y {
                let drop = s.hall_y - (y + FLOOR_CM);
                assert!((0..=DROP_CM).contains(&drop), "metro:{}: a {} cm stair from the hall ({} lines)", s.id, drop, s.lines.len());
            }
        }
    }

    #[test]
    fn the_metro_reaches_the_homes_the_industry_and_the_airport() {
        let (_, lu, ap, m) = commons();
        let near = |q: P, r: i64| m.stations.iter().any(|s| d(s.c, q) <= r);
        let homes: Vec<P> = lu.buildings.iter().filter(|b| b.use_ == Use::Home).map(|b| b.c).collect();
        let served = homes.iter().filter(|&&q| near(q, 50_000)).count();
        assert!(served * 100 >= homes.len() * 55, "{served} of {} homes within 500 m of a station", homes.len());
        let w = ap.side * (TERMINAL_CM);
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
        let c = super::super::commons();
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
