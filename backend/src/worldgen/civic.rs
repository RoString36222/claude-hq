//! Civic sites (@2): the services a city runs, each placed by a rule and given the
//! first city tier it stands in (`Site.tier`). The table is `CIVIC`:
//!
//!   townhall        the lot nearest the plaza whose door looks across at it
//!   police          the arterial lot nearest the plaza
//!   library, post   civic lots; market in the old town (or commercial), bank and mall downtown
//!   school, univ.   residential lots nearest a park
//!   clinic          a greedy cover on arterial lots: within 600 m by road of every lot it
//!                   can reach, 300 m apart; a hospital at tier 3
//!   fire            a greedy cover: within 800 m by road of every lot
//!   transit         the hub, beside the arterial junction nearest the plaza
//!   busstop         every ~250 m along the arterials (tier 2), then a cover to 250 m by
//!                   road from arterial lots, then from any for the lots still out of reach
//!   tramstop        every ~200 m along the tram streets: the arterials most lots front (tier 4)
//!   power, water    industrial lots farthest out (tier 3)
//!   stadium         in the park nearest downtown, else downtown's biggest lot, else
//!                   open land past the city's edge nearest downtown (tier 5)
//!   zone buildings  on their industry's lots, at its tier (zones.rs)
//!   dock, port      on the shore, facing the sea (tier 1 and 3); airport on the flattest
//!                   open land outside the city (tier 5): `outside`, once the highways are laid
//!
//! `place` runs inside the organic generator after the plaza's sites and BEFORE the HQ
//! pool is drawn, so a service never takes a member's lot. A site takes its lot (the
//! lot is no longer a lot) and stands on it as the profile's slotted sites do: square
//! to its front, a metre back from the door. Coverage distances are by road: along the
//! street graph from the site's door to the lot's.
//!
//! The HQ tabs' doors (the 16 `view-building` slots of version 1) are civic sites
//! here: the first site of each kind in `VIEWS` carries `view: "<tab>"`.

use std::cmp::Reverse;
use std::collections::{BTreeMap, BinaryHeap};

use super::city::{Block, City, Facing, Lot, Site};
use super::noise::{isqrt, ONE};
use super::organic::blocks::KERB_CM;
use super::organic::geom::{self, along, centroid, dist2, inside, left, len, nearest_on, obb, seg_dist2, DIR16, P};
use super::organic::graph::{Graph, Kind};
use super::organic::{fit, rect};
use super::profile::{district, Profile};
use super::roads::Roads;
use super::terrain::Terrain;
use super::zones;

/// Where a civic site goes.
pub enum Place {
    /// The lot nearest the plaza whose door looks across at it.
    Plaza,
    /// Beside the arterial junction (three arterials or more) nearest the plaza.
    Junction,
    /// Lots of the first of `districts` with room (then any district; none listed:
    /// any), nearest the plaza first, or the `far`thest; `arterial`: the door on an
    /// arterial; `park`: nearest a park first.
    Lots { districts: &'static [u8], arterial: bool, park: bool, far: bool },
    /// A greedy cover: sites until every lot one can reach is within `radius_cm` by
    /// road of one; `along_arterial`: only on lots whose door is on an arterial.
    Coverage { radius_cm: i64, along_arterial: bool },
    /// Every `every_cm` along the arterials, or (`tram`) along the tram streets only.
    Along { every_cm: i64, tram: bool },
    /// In the park nearest downtown (else downtown's biggest lot; else, in `outside`,
    /// on open land nearest downtown).
    Park,
    /// On the shore, its front to the sea (`outside`).
    Shore,
    /// On the flattest open land just outside the city (`outside`).
    Edge,
}

pub struct Civic {
    pub kind: &'static str,
    pub tier: u8,
    /// How many (`Lots`): the other places decide for themselves.
    pub count: i64,
    pub w_cm: i64,
    pub d_cm: i64,
    /// Sites of the kind keep at least this far apart (cm, centre to centre).
    pub apart_cm: i64,
    pub place: Place,
}

const fn on(districts: &'static [u8], arterial: bool, park: bool, far: bool) -> Place {
    Place::Lots { districts, arterial, park, far }
}

const fn civic(kind: &'static str, tier: u8, count: i64, w_cm: i64, d_cm: i64, apart_cm: i64, place: Place) -> Civic {
    Civic { kind, tier, count, w_cm, d_cm, apart_cm, place }
}

const RESIDENTIAL: &[u8] = &[district::SUBURB, district::RESIDENTIAL, district::OLDTOWN];
const INDUSTRIAL: &[u8] = &[district::INDUSTRIAL, district::LOGISTICS];

/// The civic sites, in the order they are placed (an earlier row has first pick of the lots).
pub const CIVIC: &[Civic] = &[
    civic("townhall", 1, 1, 2_000, 1_800, 0, Place::Plaza),
    civic("police", 1, 1, 1_400, 1_200, 0, on(&[], true, false, false)),
    civic("library", 1, 1, 1_400, 1_200, 0, on(&[district::CIVIC], false, false, false)),
    civic("post", 1, 1, 1_000, 1_000, 0, on(&[district::CIVIC], false, false, false)),
    civic("market", 1, 1, 1_600, 1_400, 0, on(&[district::OLDTOWN, district::COMMERCIAL, district::DOWNTOWN], false, false, false)),
    civic("school", 1, 1, 2_000, 1_600, 0, on(RESIDENTIAL, false, true, false)),
    civic("fire", 1, 0, 1_600, 1_400, 0, Place::Coverage { radius_cm: 80_000, along_arterial: false }),
    civic("clinic", 1, 0, 1_400, 1_200, 30_000, Place::Coverage { radius_cm: 60_000, along_arterial: true }),
    civic("transit", 2, 1, 2_000, 1_400, 0, Place::Junction),
    civic("bank", 2, 1, 1_200, 1_200, 0, on(&[district::DOWNTOWN, district::FINANCE], false, false, false)),
    civic("busstop", 2, 0, 400, 200, 0, Place::Along { every_cm: 25_000, tram: false }),
    civic("busstop", 2, 0, 400, 200, 0, Place::Coverage { radius_cm: 25_000, along_arterial: true }),
    // the lots no arterial stop reaches (deep in a suburb): a stop on their own street
    civic("busstop", 2, 0, 400, 200, 0, Place::Coverage { radius_cm: 25_000, along_arterial: false }),
    civic("hospital", 3, 1, 2_400, 2_000, 0, on(&[district::CIVIC, district::DOWNTOWN, district::OLDTOWN], true, false, false)),
    civic("mall", 3, 1, 3_000, 2_400, 0, on(&[district::DOWNTOWN, district::COMMERCIAL], false, false, false)),
    civic("university", 3, 1, 2_800, 2_200, 0, on(RESIDENTIAL, false, true, false)),
    civic("power", 3, 1, 3_000, 2_400, 0, on(INDUSTRIAL, false, false, true)),
    civic("water", 3, 1, 2_400, 2_400, 0, on(INDUSTRIAL, false, false, true)),
    civic("tramstop", 4, 0, 600, 250, 0, Place::Along { every_cm: 20_000, tram: true }),
    civic("stadium", 5, 1, 5_000, 4_000, 0, Place::Park),
    civic("dock", 1, 1, 1_200, 2_400, 0, Place::Shore),
    civic("port", 3, 1, 3_000, 4_000, 0, Place::Shore),
    civic("airport", 5, 1, 4_000, 16_000, 0, Place::Edge),
];

/// The HQ tabs (games/hqbase.js VIEWS, in its order) and the kind of site whose door
/// opens each: the first site of that kind carries the tab as its `view`.
pub const VIEWS: [(&str, &str); 13] = [
    ("live", "townhall"),
    ("analytics", "library"),
    ("pokedex", "university"),
    ("gym", "school"),
    ("quests", "post"),
    ("village", "police"),
    ("arena", "transit"),
    ("store", "market"),
    ("cali", "mall"),
    ("valley", "campus"),
    ("music", "studio"),
    ("workshop", "office"),
    ("compete", "stadium"),
];

/// Zone buildings: one to every this many lots of their industry (1 to 4), this far apart (cm).
const ZONE_LOTS: usize = 8;
const ZONE_APART_CM: i64 = 6_000;

/// Where a door meets the road graph: edge `e`, the way along it to its ends (cm),
/// and the way across from the door to it.
#[derive(Clone, Copy)]
pub struct At {
    pub e: u32,
    pub a: i64,
    pub b: i64,
    pub off: i64,
}

fn ends(g: &Graph, e: u32) -> (P, P) {
    let x = &g.edges[e as usize];
    (g.nodes[x.a as usize], g.nodes[x.b as usize])
}

/// The road nearest `q` (ties to the lower edge), if one is within 500 m.
pub fn attach(g: &Graph, q: P) -> Option<At> {
    for reach in [2_000, 10_000, 50_000] {
        let best = g
            .edges_in((q.0 - reach, q.1 - reach), (q.0 + reach, q.1 + reach))
            .into_iter()
            .map(|e| {
                let (a, b) = ends(g, e);
                let (n, d2) = nearest_on(q, a, b);
                (d2, e, n)
            })
            .min();
        if let Some((d2, e, n)) = best.filter(|b| b.0 <= reach * reach) {
            let (a, b) = ends(g, e);
            return Some(At { e, a: len(geom::sub(n, a)), b: len(geom::sub(n, b)), off: isqrt(d2) });
        }
    }
    None
}

/// Road distance (cm) from the doors `from` to every node, out to `limit` (beyond it, i64::MAX).
pub fn spread(g: &Graph, from: &[At], limit: i64) -> Vec<i64> {
    let mut dist = vec![i64::MAX; g.nodes.len()];
    let mut heap = BinaryHeap::new();
    let relax = |dist: &mut Vec<i64>, heap: &mut BinaryHeap<Reverse<(i64, u32)>>, n: u32, d: i64| {
        if d <= limit && d < dist[n as usize] {
            dist[n as usize] = d;
            heap.push(Reverse((d, n)));
        }
    };
    for f in from {
        let x = &g.edges[f.e as usize];
        relax(&mut dist, &mut heap, x.a, f.off + f.a);
        relax(&mut dist, &mut heap, x.b, f.off + f.b);
    }
    while let Some(Reverse((d, n))) = heap.pop() {
        if d > dist[n as usize] {
            continue;
        }
        for &e in &g.adj[n as usize] {
            let m = g.other(e, n);
            let (a, b) = ends(g, e);
            relax(&mut dist, &mut heap, m, d + len(geom::sub(b, a)));
        }
    }
    dist
}

/// Road distance (cm) to the door `to`, given `spread`'s node distances from `from`.
pub fn reach(g: &Graph, dist: &[i64], from: &[At], to: &At) -> i64 {
    let x = &g.edges[to.e as usize];
    let via = |n: u32, d: i64| dist[n as usize].saturating_add(d);
    let mut best = via(x.a, to.a).min(via(x.b, to.b));
    for f in from.iter().filter(|f| f.e == to.e) {
        best = best.min(f.off + (f.a - to.a).abs());
    }
    best.saturating_add(to.off)
}

struct Civ<'a> {
    p: &'a Profile,
    t: &'a Terrain,
    g: &'a Graph,
    blocks: &'a [Block],
    lots: &'a [Lot],
    at: Vec<Option<At>>,
    /// The lot's door is at an arterial's kerb.
    art: Vec<bool>,
    plaza_d2: Vec<i64>,
    taken: Vec<bool>,
    sites: Vec<Site>,
    /// Where each civic site's door meets the road (by its index in `sites`).
    doors: BTreeMap<usize, At>,
}

impl Civ<'_> {
    fn half(&self, e: u32) -> i64 {
        if self.g.edges[e as usize].kind == Kind::Arterial { self.p.avenue_cm / 2 } else { self.p.road_cm / 2 }
    }

    fn door(&self, k: usize) -> P {
        (self.lots[k].door[0], self.lots[k].door[2])
    }

    fn free(&self, k: usize) -> bool {
        !self.taken[k] && self.at[k].is_some()
    }

    fn of_kind(&self, kind: &str) -> usize {
        self.sites.iter().filter(|s| s.kind == kind).count()
    }

    /// Is lot k at least `apart` from every site of `kind`?
    fn apart(&self, kind: &str, apart: i64, k: usize) -> bool {
        apart == 0 || self.sites.iter().filter(|s| s.kind == kind).all(|s| dist2((s.x, s.z), (self.lots[k].x, self.lots[k].z)) >= apart * apart)
    }

    /// Put a w x d site of `kind` on lot k (it must fit, clear of the roads) and take the lot.
    fn put(&mut self, kind: &'static str, tier: u8, k: usize, w: i64, d: i64) -> bool {
        let Some(c) = fit(self.t, self.p, &self.lots[k], w, d) else {
            return false;
        };
        let l = &self.lots[k];
        let f = l.front.unwrap();
        let poly = rect(c, (f[0], f[1]), w, d);
        if !self.clear(&poly) {
            return false;
        }
        let n = self.of_kind(kind);
        self.sites.push(Site {
            id: format!("{kind}:{n}"), kind, block: l.block, x: c.0, y: self.t.height_at(c.0, c.1), z: c.1, w, d,
            facing: if f[1] >= 0 { Facing::North } else { Facing::South },
            tier: Some(tier), poly: Some(poly.iter().map(|q| [q.0, q.1]).collect()), front: Some(f), view: None,
        });
        self.doors.insert(self.sites.len() - 1, self.at[k].unwrap());
        self.taken[k] = true;
        true
    }

    /// Put a w x d `kind` on the first lot in `order` (group, lot) that holds it, or
    /// failing that 3/4 or 1/2 of it, a group at a time: a better group's lot at half
    /// the size beats a worse group's at full size.
    fn first(&mut self, kind: &'static str, tier: u8, order: &[(usize, usize)], w: i64, d: i64) -> bool {
        for group in order.chunk_by(|a, b| a.0 == b.0) {
            for s in [4, 3, 2] {
                if group.iter().any(|&(_, k)| self.put(kind, tier, k, w * s / 4, d * s / 4)) {
                    return true;
                }
            }
        }
        false
    }

    /// The distance (cm) from lot k's centroid to the nearest park block.
    fn park_d(&self, k: usize) -> i64 {
        let c = (self.lots[k].x, self.lots[k].z);
        self.blocks
            .iter()
            .filter(|b| b.district == district::PARK)
            .map(|b| {
                let poly = pts(b.poly.as_ref().unwrap());
                (0..poly.len()).map(|i| nearest_on(c, poly[i], poly[(i + 1) % poly.len()]).1).min().unwrap_or(i64::MAX)
            })
            .min()
            .unwrap_or(i64::MAX)
    }

    fn lots_place(&mut self, c: &Civic, districts: &[u8], arterial: bool, park: bool, far: bool, strict: bool) -> Result<(), String> {
        for n in 0..c.count {
            let mut order: Vec<(usize, i64, i64, usize)> = (0..self.lots.len())
                .filter(|&k| self.free(k) && (!arterial || self.art[k]) && self.apart(c.kind, c.apart_cm, k))
                .map(|k| {
                    let rank = if districts.is_empty() { 0 } else { districts.iter().position(|&d| d == self.lots[k].district).unwrap_or(districts.len()) };
                    let pd = if park { self.park_d(k) } else { 0 };
                    (rank, pd, if far { -self.plaza_d2[k] } else { self.plaza_d2[k] }, k)
                })
                .filter(|o| !strict || o.0 < districts.len())
                .collect();
            order.sort();
            let order: Vec<(usize, usize)> = order.into_iter().map(|o| (o.0, o.3)).collect();
            if !self.first(c.kind, c.tier, &order, c.w_cm, c.d_cm) {
                if strict {
                    return Ok(());
                }
                return Err(format!("profile {}: no lot for {}:{n}", self.p.name, c.kind));
            }
        }
        Ok(())
    }

    /// The lot nearest the plaza whose door looks across at it (within 45 degrees).
    fn plaza(&mut self, c: &Civic) -> Result<(), String> {
        let faces = |k: usize| {
            let (door, f) = (self.door(k), self.lots[k].front.unwrap());
            let toward = -(door.0 as i128 * f[0] as i128 + door.1 as i128 * f[1] as i128);
            toward * 10 >= 7 * len(door) as i128 * ONE as i128
        };
        let mut order: Vec<(bool, i64, usize)> = (0..self.lots.len()).filter(|&k| self.free(k)).map(|k| (!faces(k), self.plaza_d2[k], k)).collect();
        order.sort();
        let order: Vec<(usize, usize)> = order.into_iter().map(|o| (o.0 as usize, o.2)).collect();
        if self.first(c.kind, c.tier, &order, c.w_cm, c.d_cm) { Ok(()) } else { Err(format!("profile {}: no lot for the {}", self.p.name, c.kind)) }
    }

    /// Beside the arterial junction nearest the plaza: arterial lots within 60 m of a
    /// junction, the junction nearest the plaza first, then the nearest the junction.
    fn junction(&mut self, c: &Civic) -> Result<(), String> {
        let g = self.g;
        let joins: Vec<P> = (0..g.nodes.len())
            .filter(|&n| g.adj[n].iter().filter(|&&e| g.edges[e as usize].kind == Kind::Arterial).count() >= 3)
            .map(|n| g.nodes[n])
            .collect();
        let mut order: Vec<(bool, i64, i64, usize)> = (0..self.lots.len())
            .filter(|&k| self.free(k) && self.art[k])
            .map(|k| {
                let door = self.door(k);
                let j = joins.iter().map(|&j| (dist2(j, door), dist2(j, (0, 0)))).filter(|j| j.0 <= 6_000 * 6_000).min_by_key(|j| (j.1, j.0));
                match j {
                    Some((dj, jp)) => (false, jp, dj, k),
                    None => (true, self.plaza_d2[k], 0, k),
                }
            })
            .collect();
        order.sort();
        let order: Vec<(usize, usize)> = order.into_iter().map(|o| (o.0 as usize, o.3)).collect();
        if self.first(c.kind, c.tier, &order, c.w_cm, c.d_cm) { Ok(()) } else { Err(format!("profile {}: no lot for the {} hub", self.p.name, c.kind)) }
    }

    /// The greedy cover. The uncovered lot nearest the plaza picks it: of the lots
    /// within reach of it (a spread of up to 12 of them), the one that covers the most
    /// uncovered lots. A lot no candidate reaches is left (it stays uncovered).
    fn coverage(&mut self, c: &Civic, radius: i64, along_arterial: bool) {
        let g = self.g;
        let n = self.lots.len();
        let mut best = vec![i64::MAX; n];
        let cover = |best: &mut Vec<i64>, at: At, lots: &[Option<At>], taken: &[bool]| {
            let d = spread(g, &[at], radius);
            for k in 0..n {
                if let (false, Some(to)) = (taken[k], &lots[k]) {
                    best[k] = best[k].min(reach(g, &d, &[at], to));
                }
            }
        };
        let existing: Vec<At> = self.doors.iter().filter(|(&s, _)| self.sites[s].kind == c.kind).map(|(_, &a)| a).collect();
        for at in existing {
            cover(&mut best, at, &self.at, &self.taken);
        }
        let mut hopeless = vec![false; n];
        loop {
            let u = (0..n).filter(|&k| self.free(k) && !hopeless[k] && best[k] > radius).min_by_key(|&k| (self.plaza_d2[k], k));
            let Some(u) = u else { break };
            let from = [self.at[u].unwrap()];
            let du = spread(g, &from, radius);
            let mut cands: Vec<(i64, usize)> = (0..n)
                .filter(|&k| self.free(k) && (!along_arterial || self.art[k]) && self.apart(c.kind, c.apart_cm, k))
                .filter(|&k| fit(self.t, self.p, &self.lots[k], c.w_cm, c.d_cm).is_some())
                .filter_map(|k| {
                    let r = reach(g, &du, &from, self.at[k].as_ref().unwrap());
                    (r <= radius).then_some((r, k))
                })
                .collect();
            if cands.is_empty() {
                hopeless[u] = true;
                continue;
            }
            cands.sort();
            let m = cands.len();
            let tries: Vec<usize> = (0..m.min(12)).map(|i| cands[i * m / m.min(12)].1).collect();
            let gain = |k: usize| {
                let from = [self.at[k].unwrap()];
                let d = spread(g, &from, radius);
                (0..n).filter(|&j| self.free(j) && j != k && best[j] > radius && reach(g, &d, &from, self.at[j].as_ref().unwrap()) <= radius).count()
            };
            let pick = tries.iter().copied().max_by_key(|&k| (gain(k), Reverse(k))).unwrap();
            self.put(c.kind, c.tier, pick, c.w_cm, c.d_cm);
            cover(&mut best, self.at[pick].unwrap(), &self.at, &self.taken);
        }
    }

    /// The tram streets: the arterial streets the most lots front (two in a city as
    /// big as the Commons, one on an island), as graph street indices.
    fn tram_roads(&self) -> Vec<u32> {
        let mut fronting: BTreeMap<u32, usize> = BTreeMap::new();
        for k in 0..self.lots.len() {
            if let (true, Some(at)) = (self.art[k], self.at[k]) {
                let e = &self.g.edges[at.e as usize];
                if e.kind == Kind::Arterial {
                    *fronting.entry(e.road).or_insert(0) += 1;
                }
            }
        }
        let mut by: Vec<(Reverse<usize>, u32)> = fronting.into_iter().map(|(r, n)| (Reverse(n), r)).collect();
        by.sort();
        by.truncate(if self.p.city_r_cm >= 40_000 { 2 } else { 1 });
        by.into_iter().map(|b| b.1).collect()
    }

    /// A stop every `every` along the arterials (or the tram streets): walking each
    /// one in 25 m steps, wherever no stop of the kind is within `every`, the free lot
    /// on that street whose door is nearest (within 60 m).
    fn along(&mut self, c: &Civic, every: i64, tram: bool) {
        let g = self.g;
        let roads = if tram { Some(self.tram_roads()) } else { None };
        let ok = |e: u32| g.edges[e as usize].alive && g.edges[e as usize].kind == Kind::Arterial && roads.as_ref().is_none_or(|r| r.contains(&g.edges[e as usize].road));
        let mut order: Vec<(u32, u32)> = (0..g.edges.len() as u32).filter(|&e| ok(e)).map(|e| (g.edges[e as usize].road, e)).collect();
        order.sort();
        let mut stops: Vec<P> = self.sites.iter().filter(|s| s.kind == c.kind).map(|s| (s.x, s.z)).collect();
        for (_, e) in order {
            let (a, b) = ends(g, e);
            let steps = len(geom::sub(b, a)) / 2_500 + 1;
            for i in 0..=steps {
                let q = geom::lerp(a, b, i as i128, steps as i128);
                if stops.iter().any(|&s| dist2(s, q) < every * every) {
                    continue;
                }
                let mut near: Vec<(i64, usize)> = (0..self.lots.len())
                    .filter(|&k| self.free(k) && self.art[k] && ok(self.at[k].unwrap().e))
                    .map(|k| (dist2(self.door(k), q), k))
                    .filter(|o| o.0 <= 6_000 * 6_000)
                    .collect();
                near.sort();
                if let Some(&(_, k)) = near.iter().find(|&&(_, k)| fit(self.t, self.p, &self.lots[k], c.w_cm, c.d_cm).is_some()) {
                    self.put(c.kind, c.tier, k, c.w_cm, c.d_cm);
                    let s = self.sites.last().unwrap();
                    stops.push((s.x, s.z));
                }
            }
        }
    }

    /// Is the footprint clear of every road (its half-width and a kerb)?
    fn clear(&self, poly: &[P]) -> bool {
        let reach = 2_000;
        let (x0, x1) = (poly.iter().map(|q| q.0).min().unwrap() - reach, poly.iter().map(|q| q.0).max().unwrap() + reach);
        let (z0, z1) = (poly.iter().map(|q| q.1).min().unwrap() - reach, poly.iter().map(|q| q.1).max().unwrap() + reach);
        let n = poly.len();
        self.g.edges_in((x0, z0), (x1, z1)).into_iter().all(|e| {
            let (a, b) = ends(self.g, e);
            let h = self.half(e) + KERB_CM;
            (0..n).all(|k| seg_dist2(poly[k], poly[(k + 1) % n], a, b) >= h * h)
        })
    }

    /// The stadium: in the park block nearest downtown (by block centres), square to
    /// its box, flat and clear of the roads (smaller if it must be); else downtown's
    /// biggest lot that holds it (or 3/4 of it).
    fn park(&mut self, c: &Civic) {
        let downtown: Vec<P> = self.blocks.iter().filter(|b| b.district == district::DOWNTOWN).map(|b| (b.x, b.z)).collect();
        let mut parks: Vec<(i64, usize)> = self
            .blocks
            .iter()
            .enumerate()
            .filter(|(_, b)| b.district == district::PARK)
            .map(|(k, b)| (downtown.iter().map(|&d| dist2(d, (b.x, b.z))).min().unwrap_or(dist2((b.x, b.z), (0, 0))), k))
            .collect();
        parks.sort();
        // where in a park: its centroid, then 10 m steps out along and across its box, nearest first
        let mut offs: Vec<(i64, i64, i64)> = (-6..=6i64).flat_map(|i| (-6..=6i64).map(move |j| (i * i + j * j, i, j))).collect();
        offs.sort();
        for s in [4, 3, 2] {
            for &(_, k) in &parks {
                let b = &self.blocks[k];
                let poly = pts(b.poly.as_ref().unwrap());
                let (u, _, _) = obb(&poly);
                for &(_, i, j) in &offs {
                    let mid = along(along(centroid(&poly), u, i * 1_000), left(u), j * 1_000);
                    // the front: across the box's axis, toward the plaza
                    let f = if geom::dot(left(u), (-mid.0, -mid.1)) >= 0 { left(u) } else { (u.1, -u.0) };
                    let (w, d) = (c.w_cm * s / 4, c.d_cm * s / 4);
                    let r = rect(mid, f, w, d);
                    if r.iter().all(|&q| inside(q, &poly)) && self.clear(&r) && geom::rise(self.t, &r) <= self.p.site_flat_cm {
                        let n = self.of_kind(c.kind);
                        self.sites.push(Site {
                            id: format!("{}:{n}", c.kind), kind: c.kind, block: b.id, x: mid.0, y: self.t.height_at(mid.0, mid.1), z: mid.1, w, d,
                            facing: if f.1 >= 0 { Facing::North } else { Facing::South },
                            tier: Some(c.tier), poly: Some(r.iter().map(|q| [q.0, q.1]).collect()), front: Some([f.0, f.1]), view: None,
                        });
                        return;
                    }
                }
            }
        }
        // no park will do: the biggest lot downtown, else (in `outside`) open land past downtown's edge
        let mut order: Vec<(i64, usize)> = (0..self.lots.len())
            .filter(|&k| self.free(k) && self.lots[k].district == district::DOWNTOWN)
            .map(|k| (-geom::area2(&pts(self.lots[k].poly.as_ref().unwrap())), k))
            .collect();
        order.sort();
        for (_, k) in order {
            if self.put(c.kind, c.tier, k, c.w_cm, c.d_cm) || self.put(c.kind, c.tier, k, c.w_cm * 3 / 4, c.d_cm * 3 / 4) {
                break;
            }
        }
    }
}

fn pts(v: &[[i64; 2]]) -> Vec<P> {
    v.iter().map(|q| (q[0], q[1])).collect()
}

/// Place the civic sites and the zone buildings on the city's lots (the lots they
/// take are removed), after the profile's `sites`; the specialty's zone first.
pub fn place(seed: u64, p: &Profile, t: &Terrain, g: &Graph, blocks: &mut [Block], lots: &mut Vec<Lot>, sites: &mut Vec<Site>) -> Result<(), String> {
    zones::ensure_specialty(seed, blocks, lots);
    let half = |e: u32| if g.edges[e as usize].kind == Kind::Arterial { p.avenue_cm / 2 } else { p.road_cm / 2 };
    let at: Vec<Option<At>> = lots.iter().map(|l| attach(g, (l.door[0], l.door[2]))).collect();
    let art = lots
        .iter()
        .map(|l| {
            let door = (l.door[0], l.door[2]);
            g.edges_in((door.0 - 2_000, door.1 - 2_000), (door.0 + 2_000, door.1 + 2_000)).into_iter().any(|e| {
                let (a, b) = ends(g, e);
                let r = half(e) + KERB_CM + 60;
                g.edges[e as usize].kind == Kind::Arterial && nearest_on(door, a, b).1 <= r * r
            })
        })
        .collect();
    let (blocks, all): (&[Block], &[Lot]) = (&*blocks, &*lots);
    let mut c = Civ {
        p, t, g, blocks, lots: all,
        at, art,
        plaza_d2: all.iter().map(|l| l.x * l.x + l.z * l.z).collect(),
        taken: vec![false; all.len()],
        sites: std::mem::take(sites),
        doors: BTreeMap::new(),
    };
    for row in CIVIC {
        match row.place {
            Place::Plaza => c.plaza(row)?,
            Place::Junction => c.junction(row)?,
            Place::Lots { districts, arterial, park, far } => c.lots_place(row, districts, arterial, park, far, false)?,
            Place::Coverage { radius_cm, along_arterial } => c.coverage(row, radius_cm, along_arterial),
            Place::Along { every_cm, tram } => c.along(row, every_cm, tram),
            Place::Park => c.park(row),
            Place::Shore | Place::Edge => {} // `outside`
        }
    }
    for ind in &zones::INDUSTRY {
        let m = (0..all.len()).filter(|&k| c.free(k) && all[k].district == ind.district).count();
        if m == 0 {
            continue;
        }
        let row = civic(ind.kind, ind.tier, (m / ZONE_LOTS).clamp(1, 4) as i64, ind.w_cm, ind.d_cm, ZONE_APART_CM, on(&[], false, false, false));
        c.lots_place(&row, &[ind.district], false, false, false, true)?;
    }
    let taken = c.taken;
    *sites = c.sites;
    let mut k = 0;
    lots.retain(|_| {
        k += 1;
        !taken[k - 1]
    });
    Ok(())
}

/// The sites off the city's lots, once every road is laid: the dock and the port on
/// the shore (a world with a coast or a sea), the airport on the flattest open land
/// outside the city, and the stadium (if no park or lot held it) on open land nearest
/// downtown. Then the HQ tabs' doors: the first site of each kind in `VIEWS`.
pub fn outside(p: &Profile, t: &Terrain, roads: &Roads, city: &mut City) {
    let downtown: Vec<&Block> = city.blocks.iter().filter(|b| b.district == district::DOWNTOWN).collect();
    let n = downtown.len().max(1) as i64;
    let mid = (downtown.iter().map(|b| b.x).sum::<i64>() / n, downtown.iter().map(|b| b.z).sum::<i64>() / n);
    for row in CIVIC {
        let spot = match row.place {
            Place::Shore => shore(p, t, roads, city, row),
            Place::Edge => edge(p, t, roads, city, row, |rise, r, k, _| (rise, r, k as i64)),
            Place::Park if !city.sites.iter().any(|s| s.kind == row.kind) => {
                edge(p, t, roads, city, row, |rise, _, k, c| ((rise > 2 * p.site_flat_cm) as i64, dist2(c, mid), rise * 16 + k as i64))
            }
            _ => continue,
        };
        let Some((c, f)) = spot else { continue };
        let poly = rect(c, f, row.w_cm, row.d_cm);
        // outside the city its block is the nearest one
        let block = city.blocks.iter().min_by_key(|b| (dist2((b.x, b.z), c), b.id)).map_or(0, |b| b.id);
        let n = city.sites.iter().filter(|s| s.kind == row.kind).count();
        city.sites.push(Site {
            id: format!("{}:{n}", row.kind), kind: row.kind, block, x: c.0, y: t.height_at(c.0, c.1), z: c.1, w: row.w_cm, d: row.d_cm,
            facing: if f.1 >= 0 { Facing::North } else { Facing::South },
            tier: Some(row.tier), poly: Some(poly.iter().map(|q| [q.0, q.1]).collect()), front: Some([f.0, f.1]), view: None,
        });
    }
    for (view, kind) in VIEWS {
        if let Some(s) = city.sites.iter_mut().find(|s| s.kind == kind) {
            s.view = Some(view);
        }
    }
}

/// Water: past the coast, or at or below the sea.
fn wet(p: &Profile, t: &Terrain, q: P) -> bool {
    p.coast_r_cm.is_some_and(|c| len(q) > c - 2_000) || p.sea_cm.is_some_and(|s| t.height_at(q.0, q.1) <= s + 50)
}

/// Is the footprint clear of every road (its half-width and 3 m), every block and every site?
fn open(roads: &Roads, city: &City, poly: &[P]) -> bool {
    let (x0, x1) = (poly.iter().map(|q| q.0).min().unwrap(), poly.iter().map(|q| q.0).max().unwrap());
    let (z0, z1) = (poly.iter().map(|q| q.1).min().unwrap(), poly.iter().map(|q| q.1).max().unwrap());
    let n = poly.len();
    let roads_ok = roads.edges.iter().all(|e| {
        let m = e.width / 2 + 300;
        e.points.windows(2).all(|s| {
            let (a, b) = ((s[0][0], s[0][2]), (s[1][0], s[1][2]));
            if a.0.max(b.0) < x0 - m || a.0.min(b.0) > x1 + m || a.1.max(b.1) < z0 - m || a.1.min(b.1) > z1 + m {
                return true;
            }
            (0..n).all(|k| seg_dist2(poly[k], poly[(k + 1) % n], a, b) >= m * m)
        })
    });
    let apart = |other: &[P]| {
        let m = other.len();
        !poly.iter().any(|&q| inside(q, other))
            && !other.iter().any(|&q| inside(q, poly))
            && (0..n).all(|i| (0..m).all(|j| seg_dist2(poly[i], poly[(i + 1) % n], other[j], other[(j + 1) % m]) > 0))
    };
    roads_ok
        && city.blocks.iter().all(|b| b.poly.as_ref().is_none_or(|bp| apart(&pts(bp))))
        && city.sites.iter().all(|s| s.poly.as_ref().is_none_or(|sp| apart(&pts(sp))))
}

/// On the shore, its front to the sea: of the 16 compass directions, the one whose
/// shore is nearest the city (the first free one, a quarter turn from the last of
/// the kind's sites), straddling the shoreline (a dock) or mostly on land (a port).
fn shore(p: &Profile, t: &Terrain, roads: &Roads, city: &City, row: &Civic) -> Option<(P, P)> {
    p.coast_r_cm.or(p.sea_cm)?;
    let mut shores: Vec<(i64, usize)> = (0..16)
        .filter_map(|k| {
            let mut r = p.city_r_cm;
            while r < p.size_cm / 2 {
                if wet(p, t, along((0, 0), DIR16[k], r)) {
                    return Some((r - 400, k));
                }
                r += 400;
            }
            None
        })
        .collect();
    shores.sort();
    let taken: Vec<P> = city.sites.iter().filter(|s| matches!(s.kind, "dock" | "port")).map(|s| (s.x, s.z)).collect();
    shores.into_iter().find_map(|(r, k)| {
        let f = DIR16[k];
        if taken.iter().any(|&q| {
            let dot = q.0 as i128 * f.0 as i128 + q.1 as i128 * f.1 as i128;
            dot * 10 > 7 * len(q) as i128 * ONE as i128
        }) {
            return None;
        }
        let s = along((0, 0), f, r);
        let c = if row.d_cm > 3_000 { along(s, f, -row.d_cm / 4) } else { s };
        open(roads, city, &rect(c, f, row.w_cm, row.d_cm)).then_some((c, f))
    })
}

/// Open land outside the city: a ring of candidates every 22.5 degrees, from just
/// past the city out toward the world's edge, each long side pointing out from the
/// plaza, its front to the plaza; the least by `key(rise, radius, direction, centre)`.
fn edge(p: &Profile, t: &Terrain, roads: &Roads, city: &City, row: &Civic, key: impl Fn(i64, i64, usize, P) -> (i64, i64, i64)) -> Option<(P, P)> {
    let lim = p.size_cm / 2 - row.d_cm / 2 - 2_000;
    let mut best: Option<((i64, i64, i64), usize, P)> = None;
    for (k, &f) in DIR16.iter().enumerate() {
        let mut r = p.city_r_cm + 6_000 + row.d_cm / 2;
        while r <= lim {
            let c = along((0, 0), f, r);
            let poly = rect(c, (-f.0, -f.1), row.w_cm, row.d_cm);
            let score = key(geom::rise(t, &poly), r, k, c);
            let in_world = poly.iter().all(|q| q.0.abs() < p.size_cm / 2 && q.1.abs() < p.size_cm / 2);
            if best.is_none_or(|b| score < b.0) && in_world && !poly.iter().any(|&q| wet(p, t, q)) && open(roads, city, &poly) {
                best = Some((score, k, c));
            }
            r += 4_000;
        }
    }
    best.map(|(_, k, c)| (c, (-DIR16[k].0, -DIR16[k].1)))
}

#[cfg(test)]
#[path = "civic_tests.rs"]
mod tests;
