//! Wider roads (HQ 3.10) without moving the city. An organic world is laid out (its
//! blocks cut, its lots split and ranked, its sites and the HQ pool placed) against
//! the profile's layout widths, `road_cm` and `avenue_cm`, exactly as before; then
//! every road is paved at `paved_road_cm` / `paved_avenue_cm` and the extra half-width
//! comes out of the strip of block and lot along it. So the same lots exist with the
//! same ids, ranks and districts (every member's tower stays on its lot, see
//! archipelago.rs `commons_lot`); a lot only gives up the front of its plot to the
//! road, its door stepping back with it.
//!
//! Every corner of a block or lot the paving now reaches is pushed straight out of it
//! (`push`, a function of the point alone: two lots sharing a corner, and a block and
//! the lots on its side, move it alike, so no gap or overlap opens between them). A
//! road that still reaches a side between two corners (a road bending away under a
//! straight side) moves that side back (`clear`). Where a lot still cannot give way (a
//! dead end's tip in a notch of it, a sharp corner into a junction) the road that
//! reaches it keeps its layout width (`narrow`): a few short streets in a world.
//!
//! HQ 3.20.1 (generator @3): a street is paved at one of its kind's tiers
//! (`Profile::local_tiers` / `arterial_tiers`), picked per street from the seed, so
//! some streets are wide and some narrow, each the same width end to end. A road that
//! reaches a lot that cannot give way steps down a tier at a time, then to the @2
//! paved width, and only then to its layout width.
//!
//! The sites the layout placed on lots (civic buildings, stops) keep their size: one
//! the wider road would reach steps back from it, by at most the extra half-width
//! (`shift_sites`), onto what was its own lot's ground.

use super::super::city::{Block, Lot, Site};
use super::super::noise::isqrt;
use super::super::profile::{Profile, Tier};
use super::super::rng::{sub as subseed, Rng};
use super::super::terrain::Terrain;
use super::blocks::{inset, KERB_CM};
use super::geom::{along, area2, centroid, clip, dot, extent, inside, left, len, nearest_on, seg_dist2, simple, sub, unit, FPoly, P};
use super::graph::{Graph, Kind};

/// How far (cm) into the kerb a road may still reach a lot (rounding as a side moves):
/// a lot is never on the paved road itself.
const SLACK_CM: i64 = 10;

/// How far (cm) a stepped-back site clears the paved road.
const SITE_CLEAR_CM: i64 = 10;

/// The paving: the profile's widths, less the roads kept at their layout width.
pub struct Paving<'a> {
    p: &'a Profile,
    g: &'a Graph,
    seed: u64,
    /// How many steps down its ladder graph edge e is paved (a lot it would reach cannot
    /// give way): 0 its street's own width, the last its layout width.
    pub narrow: Vec<u8>,
}

/// The tier a street of `tiers` is paved at: weighted, from the seed and the street.
fn pick(seed: u64, road: u32, tiers: &[Tier]) -> usize {
    let total: u32 = tiers.iter().map(|t| t.weight).sum();
    let mut w = (Rng::new(subseed(seed, "paving", road as i64, 0)).next_u64() % total.max(1) as u64) as u32;
    for (k, t) in tiers.iter().enumerate() {
        if w < t.weight {
            return k;
        }
        w -= t.weight;
    }
    tiers.len() - 1
}

/// A road segment near a footprint: its ends, how far from its centre line a block or
/// lot keeps (the paved half-width and the kerb), and its graph edge.
type Seg = (P, P, i64, u32);

impl Paving<'_> {
    /// The widths (cm, with sidewalks) graph edge e may be paved at, widest first: its
    /// street's tier and the narrower ones, the profile's paved width, the layout width
    /// (its sidewalks in the paved width's proportion).
    fn ladder(&self, e: u32) -> Vec<(i64, i64)> {
        let (p, ge) = (self.p, &self.g.edges[e as usize]);
        let (tiers, paved, walk, layout) = match ge.kind {
            Kind::Arterial => (p.arterial_tiers, p.paved_avenue_cm, p.avenue_walk_cm, p.avenue_cm),
            Kind::Local => (p.local_tiers, p.paved_road_cm, p.street_walk_cm, p.road_cm),
            Kind::Water => return vec![(0, 0)],
        };
        let mut out: Vec<(i64, i64)> = if tiers.is_empty() { vec![] } else { tiers[pick(self.seed, ge.road, tiers)..].iter().map(|t| (t.cm, t.walk_cm)).collect() };
        if out.last().is_none_or(|l| l.0 > paved) {
            out.push((paved, walk));
        }
        if out.last().is_some_and(|l| l.0 > layout) {
            out.push((layout, walk * layout / paved.max(1)));
        }
        out
    }

    /// The full width (cm) graph edge e is paved at and its sidewalks.
    pub fn width(&self, e: u32) -> (i64, i64) {
        let l = self.ladder(e);
        l[(self.narrow[e as usize] as usize).min(l.len() - 1)]
    }

    /// The paved half-width (cm) of graph edge e.
    pub fn half(&self, e: u32) -> i64 {
        self.width(e).0 / 2
    }

    /// The narrowest a lot's share of ground steps edge e down to: the profile's paved width.
    fn floor(&self, e: u32) -> i64 {
        match self.g.edges[e as usize].kind {
            Kind::Arterial => self.p.paved_avenue_cm,
            _ => self.p.paved_road_cm,
        }
    }

    /// Pave graph edge e a step narrower: false if it is at its layout width already.
    fn step_down(&mut self, e: u32) -> bool {
        let n = self.ladder(e).len() as u8;
        let k = &mut self.narrow[e as usize];
        if *k + 1 >= n {
            return false;
        }
        *k += 1;
        true
    }

    /// The road segments within reach of the box round `pts`.
    fn near(&self, pts: &[P]) -> Vec<Seg> {
        let p = self.p;
        let r = p.local_tiers.iter().chain(p.arterial_tiers).map(|t| t.cm).fold(p.paved_avenue_cm.max(p.paved_road_cm), i64::max);
        let (x0, x1) = (pts.iter().map(|q| q.0).min().unwrap() - r, pts.iter().map(|q| q.0).max().unwrap() + r);
        let (z0, z1) = (pts.iter().map(|q| q.1).min().unwrap() - r, pts.iter().map(|q| q.1).max().unwrap() + r);
        let g = self.g;
        g.edges_in((x0, z0), (x1, z1))
            .into_iter()
            .filter(|&e| g.edges[e as usize].kind != Kind::Water)
            .map(|e| (g.nodes[g.edges[e as usize].a as usize], g.nodes[g.edges[e as usize].b as usize], self.half(e) + KERB_CM, e))
            .collect()
    }

    /// `q` pushed straight away from every road whose paved strip (and kerb) reaches
    /// it, the deepest first; a corner between two roads takes a push from each.
    fn push(&self, mut q: P) -> P {
        let roads = self.near(&[q]);
        for _ in 0..8 {
            let deepest = roads
                .iter()
                .map(|&(a, b, keep, _)| {
                    let (m, d2) = nearest_on(q, a, b);
                    (keep - isqrt(d2), m)
                })
                .max();
            match deepest {
                Some((deep, m)) if deep > 0 && m != q => q = along(q, unit(sub(q, m)), deep + 1),
                _ => break,
            }
        }
        q
    }

    /// What pushing the corners left: while a road reaches a side, that side moves back
    /// by as much (its corners sliding along their neighbours, as a block is cut,
    /// blocks.rs), else is cut along its moved line if that takes only the strip along it.
    fn clear(&self, roads: &[Seg], mut poly: Vec<P>) -> Vec<P> {
        for _ in 0..8 {
            let Some((deep, k, _)) = reached(roads, &poly) else { break };
            let sides: Vec<(P, i64)> = (0..poly.len()).map(|j| (poly[j], if j == k { deep + 2 } else { 0 })).collect();
            if let Some(out) = inset(&sides) {
                poly = out;
                continue;
            }
            let (a, b) = (poly[k], poly[(k + 1) % poly.len()]);
            let inward = left(unit(sub(b, a)));
            let fp: FPoly = poly.iter().map(|&q| (q, true)).collect();
            let out: Vec<P> = clip(&fp, along(a, inward, deep + 2), inward).into_iter().map(|q| q.0).collect();
            let strip = 2 * (deep + 2) * (len(sub(b, a)) + 4 * (deep + 2));
            if out.len() < 3 || area2(&poly) - area2(&out) > strip || !simple(&out) {
                break;
            }
            poly = out;
        }
        poly
    }

    /// `poly` (counter-clockwise) off the paved roads, and the roads that still reach
    /// it (none for a lot that gave way). A footprint that would come out tangled is
    /// kept as it was (and reached).
    fn trim(&self, poly: &[P], sides: bool) -> (Vec<P>, Vec<u32>) {
        let mut pairs: Vec<(P, P)> = poly.iter().map(|&q| (q, self.push(q))).collect();
        // a side shorter than the push (a corner's sliver) can turn round: drop its far corner
        let mut k = 0;
        while pairs.len() > 3 && k < pairs.len() {
            let j = (k + 1) % pairs.len();
            if dot(sub(pairs[j].1, pairs[k].1), sub(pairs[j].0, pairs[k].0)) <= 0 {
                pairs.remove(j);
                k = 0;
            } else {
                k += 1;
            }
        }
        let roads = self.near(poly);
        let pushed: Vec<P> = pairs.into_iter().map(|q| q.1).collect();
        let mut out = if sides { self.clear(&roads, pushed) } else { pushed };
        // tangled, or come out somewhere else (a lot's middle must stay on it): kept as it was
        if !(out.len() >= 3 && area2(&out) > 0 && simple(&out) && inside(centroid(&out), poly)) {
            out = poly.to_vec();
        }
        let n = out.len();
        let mut by: Vec<u32> = roads
            .iter()
            .filter(|&&(a, b, keep, _)| (0..n).any(|k| seg_dist2(out[k], out[(k + 1) % n], a, b) < (keep - SLACK_CM).pow(2)))
            .map(|s| s.3)
            .collect();
        by.sort_unstable();
        by.dedup();
        (out, by)
    }
}

/// The deepest any road reaches into the polygon's sides: (how far, side k, edge).
fn reached(roads: &[Seg], poly: &[P]) -> Option<(i64, usize, u32)> {
    let n = poly.len();
    roads
        .iter()
        .flat_map(|&(a, b, keep, e)| (0..n).map(move |k| (keep - 1 - isqrt(seg_dist2(poly[k], poly[(k + 1) % n], a, b)), k, e)))
        .filter(|r| r.0 > 0)
        .max()
}

fn pts(poly: &[[i64; 2]]) -> Vec<P> {
    poly.iter().map(|q| (q[0], q[1])).collect()
}

fn poly_of(q: &[P]) -> Option<Vec<[i64; 2]>> {
    Some(q.iter().map(|q| [q.0, q.1]).collect())
}

/// Pave the roads at the profile's paved widths, once the layout is final (ids, ranks,
/// sites and the HQ pool set): trim every lot and block, step the sites back. The
/// paving says which roads kept their layout width.
pub fn widen<'a>(p: &'a Profile, seed: u64, t: &Terrain, g: &'a Graph, blocks: &mut [Block], lots: &mut [Lot], sites: &mut [Site]) -> Paving<'a> {
    let mut pv = Paving { p, g, seed, narrow: vec![0; g.edges.len()] };
    if p.paved_road_cm == p.road_cm && p.paved_avenue_cm == p.avenue_cm && p.local_tiers.is_empty() && p.arterial_tiers.is_empty() {
        return pv;
    }
    // the roads kept narrow: whatever reaches a lot that cannot give way, or a site
    // that cannot step back (a narrow road reaches less, so this settles in a round or two)
    let olds: Vec<Option<Vec<P>>> = lots.iter().map(|l| l.poly.as_ref().map(|q| pts(q))).collect();
    // (a step at a time down a ladder of up to five widths: more rounds than @2's four)
    let tiered = !(p.local_tiers.is_empty() && p.arterial_tiers.is_empty());
    let rounds = if tiered { 10 } else { 4 };
    for _ in 0..rounds {
        let mut more = false;
        // (an HQ lot keeps the pool's least area, hq_pool: else it is not trimmed at all)
        let (mut by, mut soft): (Vec<u32>, Vec<u32>) = (Vec::new(), Vec::new());
        for (l, old) in lots.iter().zip(&olds) {
            let Some(old) = old else { continue };
            let (out, reach) = pv.trim(old, true);
            let at = || pv.near(old).into_iter().filter(|&(a, b, keep, _)| (0..old.len()).any(|k| seg_dist2(old[k], old[(k + 1) % old.len()], a, b) < keep * keep)).map(|r| r.3);
            if l.kind == "hq" && area2(&out) < 2 * p.hq_min_m2 * 10_000 {
                by.extend(at());
            } else if tiered && area2(&out) * 10 < area2(old) * 6 {
                // (@3's tiers: a lot keeps 60% of its ground, the roads at it no narrower than @2's for that)
                soft.extend(at());
            }
            by.extend(reach);
        }
        by.extend(sites.iter().filter(|x| on_lots(x)).flat_map(|x| step(&pv, &pts(x.poly.as_ref().unwrap())).1));
        by.sort_unstable();
        by.dedup();
        for e in by {
            more |= pv.step_down(e);
        }
        soft.sort_unstable();
        soft.dedup();
        for e in soft {
            more |= pv.width(e).0 > pv.floor(e) && pv.step_down(e);
        }
        if !more {
            break;
        }
    }
    for (l, old) in lots.iter_mut().zip(&olds) {
        let (Some(old), Some(f)) = (old, l.front) else { continue };
        let poly = pv.trim(old, true).0;
        if poly == *old {
            continue;
        }
        // the door (lots.rs: the middle of the front edge) is pushed as the corners
        // are, onto the front edge's new line; frontage and depth measured again. The
        // lot's x, z stay the layout's (its growth rank is by them, and its HQ's place).
        let door = pv.push((l.door[0], l.door[2]));
        let m = poly.len();
        let j = (0..m).min_by_key(|&j| nearest_on(door, poly[j], poly[(j + 1) % m]).1).unwrap();
        let (lo, hi) = extent(&poly, (-f[0], -f[1]));
        (l.w, l.d) = (len(sub(poly[(j + 1) % m], poly[j])), (hi - lo).max(1));
        l.door = [door.0, t.height_at(door.0, door.1), door.1];
        l.poly = poly_of(&poly);
    }
    for x in sites.iter_mut().filter(|x| on_lots(x)) {
        let (to, _) = step(&pv, &pts(x.poly.as_ref().unwrap()));
        if to != (0, 0) {
            (x.x, x.z) = (x.x + to.0, x.z + to.1);
            x.y = t.height_at(x.x, x.z);
            x.poly = x.poly.as_ref().map(|q| q.iter().map(|c| [c[0] + to.0, c[1] + to.1]).collect());
        }
    }
    for b in blocks.iter_mut() {
        let Some(old) = b.poly.as_ref().map(|q| pts(q)) else { continue };
        // a block is the pavement under its lots: only its corners move (as its lots'
        // do), and not at all if that would leave one of its lots or sites outside it
        let poly = pv.trim(&old, false).0;
        let holds = lots.iter().filter(|l| l.block == b.id).all(|l| l.poly.as_ref().is_none_or(|q| inside(centroid(&pts(q)), &poly)))
            && sites.iter().filter(|x| x.block == b.id && !matches!(x.kind, "dock" | "port")).all(|x| x.poly.as_ref().is_none_or(|q| q.iter().all(|c| inside((c[0], c[1]), &poly))));
        if poly == old || !holds {
            continue;
        }
        let (x0, x1) = (poly.iter().map(|q| q.0).min().unwrap(), poly.iter().map(|q| q.0).max().unwrap());
        let (z0, z1) = (poly.iter().map(|q| q.1).min().unwrap(), poly.iter().map(|q| q.1).max().unwrap());
        (b.x, b.z, b.w, b.d) = ((x0 + x1) / 2, (z0 + z1) / 2, x1 - x0, z1 - z0);
        b.poly = poly_of(&poly);
    }
    pv
}

/// A site with a footprint stepped back from any road the paving now reaches,
/// straight away from that road, until it clears it by `SITE_CLEAR_CM`: the step, and
/// the roads that still reach it (a site wedged between roads), or that reach where
/// it stood if any still do.
fn step(pv: &Paving, poly: &[P]) -> (P, Vec<u32>) {
    let roads = pv.near(poly);
    let n = poly.len();
    let reach = |q: &[P]| -> Vec<u32> { roads.iter().filter(|&&(a, b, keep, _)| (0..n).any(|k| seg_dist2(q[k], q[(k + 1) % n], a, b) < (keep - KERB_CM).pow(2))).map(|r| r.3).collect() };
    let mut to = (0, 0);
    // a few steps: a corner site can sit back from two roads, or two segments of one
    for _ in 0..16 {
        let at: Vec<P> = poly.iter().map(|q| (q.0 + to.0, q.1 + to.1)).collect();
        let c = centroid(&at);
        let worst = roads
            .iter()
            .filter_map(|&(a, b, keep, _)| {
                let d = (0..n).map(|k| seg_dist2(at[k], at[(k + 1) % n], a, b)).min().unwrap();
                let need = keep - KERB_CM + SITE_CLEAR_CM - isqrt(d);
                (need > 0).then(|| (need, unit(sub(c, nearest_on(c, a, b).0))))
            })
            .max();
        let Some((need, away)) = worst else { break };
        to = along(to, away, need);
    }
    let at: Vec<P> = poly.iter().map(|q| (q.0 + to.0, q.1 + to.1)).collect();
    if reach(&at).is_empty() {
        (to, Vec::new())
    } else {
        ((0, 0), reach(poly))
    }
}

/// The sites the layout placed on lots (not the dock or the port: they stand on the
/// river's bank, placed after the roads), stepped back from the paving.
fn on_lots(s: &Site) -> bool {
    s.poly.is_some() && !matches!(s.kind, "dock" | "port")
}
