//! City Gen v4: the HQ pool by spacing (the plan's "HQ spacing" and "Garage lots", @3 only).
//!
//! Before v4 the pool was the profile's count of lots nearest the plaza that the block
//! splitter happened to make big enough, drawn before the roads were paved. From v4 it is
//! drawn by rule once the town's roads are laid, paved and the City Line's boulevard cut
//! (worldgen/mod.rs calls `draw` after corridor.rs), on the lots as they then are, so what is
//! checked is what is built (and the City Line no longer has HQs in its way):
//!
//!   - **garage-sized** (`fits`): the lot holds the HQ's smallest tower (hqtower.js
//!     footprint(0, 2): the 11 x 8 m podium; its wings, which the plan only builds from a
//!     wider tower, stand on it), and beside the tower the client grows there (hqcity3d.js
//!     grandOf, up to 25 x 14 m with both wings) a garage its `garageFits` takes: the 7 x 6.2 m
//!     bay inside the lot clear of the tower and the walk to its door, its 8 m apron on the lot
//!     or out over its street edge, a 3.5 m driveway to the street;
//!   - **fronting** (`Streets::fronts_ok`): the road straight out of its door is a local
//!     street, a lane, a shared street or a collector, never an avenue, a boulevard or a
//!     graded road;
//!   - **spaced**: a Poisson-disc spread, drawn nearest the plaza first (so rank 0 is still the
//!     nearest): no two HQs closer than `GAP_CM` between their lots' centres;
//!   - **near transit**: its door within `WALK_CM` of a stop (the bus and tram stops and the
//!     transit hub as they stand when the pool is drawn).
//!
//! Too few single lots qualify: neighbouring lots of a block merged into one (`clusters`), then
//! lots carved square to a block's frontage (`carves`; the lots under one give way, what is
//! left of them lots of their own). Still too few: the walk is dropped first, then the gap
//! steps down to `MIN_GAP_CM` (`RELAX`); the garage and fronting rules never relax. A town
//! with no room for the profile's count even then keeps the HQs it has room for (one sweep
//! world in 51, v4seed7: 54 blocks, 4.3 ha of lots, 30 such HQs; v4seed30 keeps 62).
//!
//! The client's measures (`hqtower.js` footprint, `hqcity3d.js` placeLot, HQ_DZ, HQ_DOOR,
//! grandOf, baySearch, garageFits, GARAGE_CLEAR, GARAGE_WAY, `hqcity.js` LOT_EXTRAS.garage) are
//! mirrored here in mm; keep the two in step (tests/test_hq_spacing.py checks the fixture's HQ
//! lots with the client's own code).

use std::collections::{BTreeMap, BTreeSet};

use super::super::city::{Block, City, Facing, Lot, Site};
use super::super::noise::{isqrt, ONE};
use super::super::profile::{district, Profile};
use super::super::terrain::Terrain;
use super::blocks::KERB_CM;
use super::geom::{self, area2, centroid, clip, cross, crossing, dist2, dot, extent, inside, left, len, nearest_on, obb, simple, sub, unit, FPoly, P};
use super::super::roads::Roads;
use super::lots::MIN_FRONT_CM;
use super::zoning::character;

/// How far apart two HQs stand (cm, between their lots' centres), from the lot and block
/// sizes: the HQ districts' lots are 650 to 800 m2 (zoning.rs), 25 to 28 m wide, and the
/// smallest lot the client fits an HQ and its garage on is 28 x 14 m (a 30 x 20 m one leaves
/// the garage room to move). Two HQs on neighbouring lots of a row stand 25 to 30 m apart, so
/// `MIN_GAP_CM`, 30 m, keeps them off each other's neighbours, and the target, 40 m, leaves
/// about a lot between them. The sweep (claude-hq@3, v4seed1..50@3) set it: at 40 m 49 of the
/// 51 worlds hold their 64, every HQ near a stop (a scan with the smallest tower's garage rule
/// had 46 at 45 m, 40 at 50 m, 10 at 60 m); the other two relax to 30 m.
pub const GAP_CM: i64 = 4_000;
pub const MIN_GAP_CM: i64 = 3_000;

/// The short walk to transit (cm): an HQ's door this near a stop.
pub const WALK_CM: i64 = 25_000;

/// Road classes an HQ may not front: the main roads and the graded roads.
pub fn arterial(class: &str) -> bool {
    matches!(class, "avenue" | "boulevard" | "arterial" | "expressway" | "ramp" | "flyover" | "highway" | "ring")
}

/// The stops an HQ's walk is measured to (as they stand when the pool is drawn: the bus and
/// tram stops and the transit hub; the metro and rail, placed later, only add to them).
pub fn stop(kind: &str) -> bool {
    matches!(kind, "busstop" | "tramstop" | "transit" | "metro-entrance" | "rail")
}

/// The client's measures, in mm (the HQ's footprints are whole mm there). `HQ_DZ`: the
/// building stands this far in front of the lot's centre (hqcity3d.js placeLot); `HQ_DOOR`: its
/// door in front of the building's middle.
const HQ_DZ: i64 = 2_000;
const HQ_DOOR: i64 = 4_800;
/// LOT_EXTRAS.garage: the bay's width and depth; its 0.3 m margin.
const BAY: (i64, i64) = (7_000, 6_200);
const BAY_MARGIN: i64 = 300;
/// GARAGE_CLEAR (the apron out of the bay's door) and GARAGE_WAY (a driveway's width).
const CLEAR: i64 = 8_000;
const WAY: i64 = 3_500;
/// The walk to the door (hqcity3d.js: [0, HQ_DOOR + 6, 1.6, 6]).
const WALK: [i64; 4] = [0, HQ_DOOR + 6_000, 1_600, 6_000];
/// hqtower.js footprint(k / 8, 2), k = 0..8 (the client's tower sizes, grand in eighths), boxes
/// [x, z, half w, half d] in mm in the HQ's frame (+z its front), the 0.3 m margin in: the
/// podium (11 x 8 m at 0, 25 x 14 m at 1), its entrance canopy, then from 2/8 its two wings.
const FOOTS: [&[[i64; 4]]; 9] = [
    &[[0, -200, 5_800, 4_300], [0, 5_350, 4_400, 1_250]],
    &[[0, -575, 6_675, 4_675], [0, 5_350, 4_400, 1_250]],
    &[[0, -950, 7_550, 5_050], [0, 5_350, 4_400, 1_250], [-5_560, -1_850, 1_690, 3_250], [5_560, -1_850, 1_690, 3_250]],
    &[[0, -1_325, 8_425, 5_425], [0, 5_350, 4_400, 1_250], [-6_260, -2_225, 1_865, 3_625], [6_260, -2_225, 1_865, 3_625]],
    &[[0, -1_700, 9_300, 5_800], [0, 5_350, 4_400, 1_250], [-6_960, -2_600, 2_040, 4_000], [6_960, -2_600, 2_040, 4_000]],
    &[[0, -2_075, 10_175, 6_175], [0, 5_350, 4_400, 1_250], [-7_660, -2_975, 2_215, 4_375], [7_660, -2_975, 2_215, 4_375]],
    &[[0, -2_450, 11_050, 6_550], [0, 5_350, 4_400, 1_250], [-8_360, -3_350, 2_390, 4_750], [8_360, -3_350, 2_390, 4_750]],
    &[[0, -2_825, 11_925, 6_925], [0, 5_350, 4_400, 1_250], [-9_060, -3_725, 2_565, 5_125], [9_060, -3_725, 2_565, 5_125]],
    &[[0, -3_200, 12_800, 7_300], [0, 5_350, 4_400, 1_250], [-9_760, -4_100, 2_740, 5_500], [9_760, -4_100, 2_740, 5_500]],
];

/// footprint(k / 8, wings): the podium and canopy, then as many wings as it has.
fn foot(k: usize, wings: usize) -> &'static [[i64; 4]] {
    let f = FOOTS[k];
    &f[..f.len().min(2 + wings)]
}

/// A lot's polygon in its HQ's frame (mm): +z out of its front, the origin the HQ's middle
/// (hqcity3d.js lotRing). None without a polygon or a front.
pub fn ring(l: &Lot) -> Option<Vec<P>> {
    let f = l.front?;
    let poly = l.poly.as_ref()?;
    if poly.len() < 3 || f == [0, 0] {
        return None;
    }
    // the unit front (Q16), the HQ's middle HQ_DZ in front of the lot's centre (cm)
    let u = unit((f[0], f[1]));
    let c = (l.x * 10 + u.0 * HQ_DZ / ONE, l.z * 10 + u.1 * HQ_DZ / ONE);
    Some(
        poly.iter()
            .map(|q| {
                let (dx, dz) = (q[0] * 10 - c.0, q[1] * 10 - c.1);
                ((dx * u.1 - dz * u.0) / ONE, (dx * u.0 + dz * u.1) / ONE)
            })
            .collect(),
    )
}

/// The street-side edge of the ring at column x: the furthest +z where it crosses the outline.
fn front_z(r: &[P], x: i64) -> Option<i64> {
    let n = r.len();
    let mut best: Option<i64> = None;
    for i in 0..n {
        let (a, b) = (r[(i + n - 1) % n], r[i]);
        if (a.0 > x) == (b.0 > x) {
            continue;
        }
        let z = a.1 + (b.1 - a.1) * (x - a.0) / (b.0 - a.0);
        best = Some(best.map_or(z, |m: i64| m.max(z)));
    }
    best
}

fn hits(keep: &[[i64; 4]], x: i64, z: i64, ex: i64, ez: i64) -> bool {
    keep.iter().any(|k| (x - k[0]).abs() < ex + k[2] && (z - k[1]).abs() < ez + k[3])
}

/// Every point of an n x n sample of the box is on the lot (or, `street`, out past its street edge).
fn on_n(r: &[P], n: i64, x: i64, z: i64, ex: i64, ez: i64, street: bool) -> bool {
    let h = n / 2;
    (-h..=h).all(|i| {
        (-h..=h).all(|j| {
            let q = (x + i * ex / h, z + j * ez / h);
            inside(q, r) || (street && front_z(r, q.0).is_some_and(|f| q.1 >= f))
        })
    })
}

/// The 5 x 5 sample (hqcity3d.js boxOn, boxInLot).
fn on(r: &[P], x: i64, z: i64, ex: i64, ez: i64, street: bool) -> bool {
    on_n(r, 5, x, z, ex, ez, street)
}

/// A straight run WAY wide centred on column cx, from z0 out to the lot's street edge, clear of keep.
fn way_out(r: &[P], keep: &[[i64; 4]], cx: i64, z0: i64) -> bool {
    let cols = [cx - WAY / 2, cx, cx + WAY / 2];
    let mut edge = i64::MIN;
    for &x in &cols {
        match front_z(r, x) {
            Some(f) => edge = edge.max(f),
            None => return false,
        }
    }
    let mut z = z0;
    while z <= edge + 500 {
        for &x in &cols {
            if hits(keep, x, z, 0, 0) || (!inside((x, z), r) && !front_z(r, x).is_some_and(|f| z >= f)) {
                return false;
            }
        }
        z += 500;
    }
    true
}

/// hqcity3d.js garageFits at spot (x, z, r) (mm) on `ring`, the tower at `foot`.
fn garage_fits(ring: &[P], foot: &[[i64; 4]], x: i64, z: i64, r: usize) -> bool {
    const DIR: [P; 4] = [(0, 1), (1, 0), (0, -1), (-1, 0)];
    let (u, odd) = (DIR[r], r % 2 == 1);
    let (hx, hz) = if odd { (BAY.1 / 2, BAY.0 / 2) } else { (BAY.0 / 2, BAY.1 / 2) };
    let mut keep: Vec<[i64; 4]> = foot.to_vec();
    keep.push(WALK);
    if !on(ring, x, z, hx + BAY_MARGIN, hz + BAY_MARGIN, false) || hits(&keep, x, z, hx + BAY_MARGIN, hz + BAY_MARGIN) {
        return false;
    }
    let (ax, az) = (x + u.0 * (BAY.1 / 2 + CLEAR / 2), z + u.1 * (BAY.1 / 2 + CLEAR / 2));
    let (ahx, ahz) = if odd { (CLEAR / 2, BAY.0 / 2) } else { (BAY.0 / 2, CLEAR / 2) };
    if hits(&keep, ax, az, ahx, ahz) || !on(ring, ax, az, ahx, ahz, true) {
        return false;
    }
    let (ex, ez) = (x + u.0 * (BAY.1 / 2 + CLEAR), z + u.1 * (BAY.1 / 2 + CLEAR));
    match r {
        0 => way_out(ring, foot, x, ez),
        1 | 3 => way_out(ring, foot, ex - u.0 * WAY / 2, z),
        _ => {
            let mut foot = foot.to_vec();
            foot.push([x, z, hx, hz]);
            [1, -1].iter().any(|&sd| way_out(ring, &foot, x + sd * (BAY.0 / 2 + BAY_MARGIN + WAY / 2), ez + WAY / 2))
        }
    }
}

/// hqcity3d.js baySearch(.., any): is there a bay (its door to the front or the back, on the
/// 0.5 m grid) inside the lot (a 3 x 3 sample), clear of keep, its apron clear of keep too?
fn bay_any(ring: &[P], keep: &[[i64; 4]], slack: i64) -> bool {
    let (hw, hd) = (BAY.0 / 2 + BAY_MARGIN - slack, BAY.1 / 2 + BAY_MARGIN - slack);
    [1, -1].iter().any(|&f| {
        (-60..=60).any(|i| {
            (-32..=32).any(|j| {
                let (x, z) = (i * 500, j * 500);
                !hits(keep, x, z, hw, hd) && !hits(keep, x, z + f * (BAY.1 / 2 + CLEAR / 2), BAY.0 / 2, CLEAR / 2) && on_n(ring, 3, x, z, hw, hd, false)
            })
        })
    })
}

/// hqcity3d.js grandOf: how big the client grows the lot's tower (k / 8): the largest step
/// up to which every part of the footprint that fits at the smallest size still fits, for
/// every wing count, with a bay beside it; 0 when not even the smallest podium fits.
fn grand_of(r: &[P], slack: i64) -> usize {
    let walk = [WALK];
    let box_in = |b: &[i64; 4]| on(r, b[0], b[1], b[2] - slack, b[3] - slack, false);
    if !box_in(&FOOTS[0][0]) {
        return 0;
    }
    let mut best = 0;
    for k in 1..FOOTS.len() {
        let ok = (0..=2).all(|wings| {
            let (b0, b) = (foot(0, wings), foot(k, wings));
            let parts = (0..b.len()).all(|i| !(i >= b0.len() || box_in(&b0[i])) || box_in(&b[i]));
            parts && bay_any(r, &[b, &walk[..]].concat(), slack)
        });
        if !ok {
            break;
        }
        best = k;
    }
    best
}

/// How much more generously (mm) the tower's size is measured here than the client does: the
/// lot's corners come here in whole mm, the client's in floating point, so on a lot where the
/// two differ by a hair the size here is the bigger, and the garage is checked beside it.
const SLACK_MM: i64 = 10;

/// Does lot `l` hold an HQ: the smallest tower's podium inside it (its entrance canopy may
/// reach the pavement), and a garage `garageFits` takes beside the tower the client grows
/// there (`grand_of`, as generously as `SLACK_MM`; a spot clear of a bigger tower is clear of
/// a smaller one): a 1 m grid, every quarter turn, a spot the client's 0.5 m grid has too.
pub fn fits(l: &Lot) -> bool {
    let Some(r) = ring(l) else { return false };
    if !on(&r, FOOTS[0][0][0], FOOTS[0][0][1], FOOTS[0][0][2], FOOTS[0][0][3], false) {
        return false;
    }
    let keep = foot(grand_of(&r, SLACK_MM), 2);
    let (x0, x1) = (r.iter().map(|q| q.0).min().unwrap(), r.iter().map(|q| q.0).max().unwrap());
    let (z0, z1) = (r.iter().map(|q| q.1).min().unwrap(), r.iter().map(|q| q.1).max().unwrap());
    let snap = |v: i64| v.div_euclid(1_000) * 1_000;
    let mut z = snap(z0);
    while z <= z1 {
        let mut x = snap(x0);
        while x <= x1 {
            if (0..4).any(|rr| garage_fits(&r, keep, x, z, rr)) {
                return true;
            }
            x += 1_000;
        }
        z += 1_000;
    }
    false
}


/// The order the pool relaxes in when too few lots qualify: (walk to transit kept, the gap).
/// At each gap the walk goes first, then the gap steps down to `MIN_GAP_CM`; the garage and
/// fronting rules never relax.
const RELAX: [(bool, i64); 6] = [(true, GAP_CM), (false, GAP_CM), (true, 3_500), (false, 3_500), (true, MIN_GAP_CM), (false, MIN_GAP_CM)];

/// The world's roads as the pool (and the validator) reads them: each piece of each road, its
/// paved half-width and its class, in 64 m cells.
pub struct Streets {
    segs: Vec<(P, P, i64, u32, &'static str)>,
    cells: BTreeMap<(i64, i64), Vec<u32>>,
}

const CELL_CM: i64 = 6_400;

/// How far out of a door the road it fronts is looked for (cm): past the middle of the
/// widest street a lot fronts.
const FRONT_REACH_CM: i64 = 3_000;

impl Streets {
    pub fn new(roads: &Roads) -> Self {
        let mut segs = Vec::new();
        let mut cells: BTreeMap<(i64, i64), Vec<u32>> = BTreeMap::new();
        for e in &roads.edges {
            for w in e.points.windows(2) {
                let (a, b) = ((w[0][0], w[0][2]), (w[1][0], w[1][2]));
                let k = segs.len() as u32;
                segs.push((a, b, e.width / 2, e.id, e.v4.unwrap_or(e.class)));
                let r = e.width / 2;
                for cx in (a.0.min(b.0) - r).div_euclid(CELL_CM)..=(a.0.max(b.0) + r).div_euclid(CELL_CM) {
                    for cz in (a.1.min(b.1) - r).div_euclid(CELL_CM)..=(a.1.max(b.1) + r).div_euclid(CELL_CM) {
                        cells.entry((cx, cz)).or_default().push(k);
                    }
                }
            }
        }
        Streets { segs, cells }
    }

    /// The road at a door: the one whose kerb (its paved half-width out from its middle) is
    /// nearest it: how far (cm) the door stands past that kerb, the road's id and its class.
    pub fn at(&self, door: P) -> Option<(i64, u32, &'static str)> {
        let (cx, cz) = (door.0.div_euclid(CELL_CM), door.1.div_euclid(CELL_CM));
        let mut best: Option<(i64, u32, &'static str)> = None;
        for dx in -1..=1 {
            for dz in -1..=1 {
                for &k in self.cells.get(&(cx + dx, cz + dz)).map_or(&[][..], |v| v.as_slice()) {
                    let (a, b, half, id, class) = self.segs[k as usize];
                    let d = isqrt(nearest_on(door, a, b).1) - half;
                    if best.is_none_or(|x| (d, id) < (x.0, x.1)) {
                        best = Some((d, id, class));
                    }
                }
            }
        }
        best
    }

    /// Is the door at a kerb (within a metre past it)?
    fn kerb(&self, door: P) -> bool {
        self.at(door).is_some_and(|(d, _, _)| d <= KERB_CM + 100)
    }

    /// The road a lot fronts: the first whose middle the line straight out of its door (along
    /// its Q16 `front`) crosses within `FRONT_REACH_CM`: how far (cm) the door stands back from
    /// that road's kerb, its id and its class. (Measured out along the front, a road paved
    /// narrower later, a tram street's, still reads as the road the lot fronts.)
    pub fn fronted(&self, door: P, front: [i64; 2]) -> Option<(i64, u32, &'static str)> {
        let u = unit((front[0], front[1]));
        let far = (door.0 + u.0 * FRONT_REACH_CM / ONE, door.1 + u.1 * FRONT_REACH_CM / ONE);
        let (lo, hi) = ((door.0.min(far.0)).div_euclid(CELL_CM), (door.0.max(far.0)).div_euclid(CELL_CM));
        let (lz, hz) = ((door.1.min(far.1)).div_euclid(CELL_CM), (door.1.max(far.1)).div_euclid(CELL_CM));
        let mut best: Option<(i64, u32, i64, &'static str)> = None;
        for cx in lo..=hi {
            for cz in lz..=hz {
                for &k in self.cells.get(&(cx, cz)).map_or(&[][..], |v| v.as_slice()) {
                    let (a, b, half, id, class) = self.segs[k as usize];
                    let Some((num, den)) = crossing(door, far, a, b) else { continue };
                    let t = (FRONT_REACH_CM as i128 * num / den.max(1)) as i64;
                    if best.is_none_or(|x| (t, id) < (x.0, x.1)) {
                        best = Some((t, id, half, class));
                    }
                }
            }
        }
        best.map(|(t, id, half, class)| (t - half, id, class))
    }

    /// Does a lot whose door and front these are front a street an HQ may: at its kerb (within
    /// a metre), a road that is no main road.
    pub fn fronts_ok(&self, door: P, front: [i64; 2]) -> bool {
        self.fronted(door, front).is_some_and(|(d, _, class)| d <= KERB_CM + 100 && !arterial(class))
    }
}

/// One of the pool's choices: the lot it would be, and the lots it takes: one (the lot
/// itself), neighbouring lots of a block merged (the HQ lot then lot `parts[0]`'s id, block and
/// growth rank), or a lot carved from a block's frontage (`carved`: the lots under it give
/// way, what is left of them, `rest`, lots of their own).
#[derive(Clone)]
struct Pick {
    parts: Vec<usize>,
    lot: Lot,
    carved: bool,
    rest: Vec<Lot>,
}

/// `poly` with every corner of `other` that lies on one of its sides (within 5 cm) put in
/// as a corner of its own, so a side the two share has the same corners in both.
fn with_corners_of(poly: &[P], other: &[P]) -> Vec<P> {
    let n = poly.len();
    let mut out = Vec::with_capacity(n + other.len());
    for i in 0..n {
        let (a, b) = (poly[i], poly[(i + 1) % n]);
        out.push(a);
        let ab = sub(b, a);
        let l2 = dot(ab, ab).max(1);
        let mut on: Vec<(i128, P)> = other
            .iter()
            .filter(|&&q| q != a && q != b && nearest_on(q, a, b).1 <= 25)
            .map(|&q| (dot(sub(q, a), ab), q))
            .filter(|&(t, _)| t > 0 && t < l2)
            .collect();
        on.sort();
        out.extend(on.into_iter().map(|x| x.1));
    }
    out
}

/// The one polygon two polygons make where they share a run of sides (each the other way
/// round); None if they share none, or the shared sides are not one run (a hole would open).
fn union(pa: &[P], pb: &[P]) -> Option<Vec<P>> {
    let (a, b) = (with_corners_of(pa, pb), with_corners_of(pb, pa));
    let sides = |p: &[P]| -> Vec<(P, P)> { (0..p.len()).map(|k| (p[k], p[(k + 1) % p.len()])).collect() };
    let (sa, sb) = (sides(&a), sides(&b));
    let shared: BTreeSet<(P, P)> = sa.iter().filter(|&&(u, v)| sb.contains(&(v, u))).copied().collect();
    if shared.is_empty() {
        return None;
    }
    let rest: Vec<(P, P)> = sa.into_iter().chain(sb).filter(|&(u, v)| !shared.contains(&(u, v)) && !shared.contains(&(v, u))).collect();
    if rest.len() < 3 {
        return None;
    }
    // walk the sides left round, each from where the last ended: one loop through them all
    let mut next: BTreeMap<P, P> = BTreeMap::new();
    for &(u, v) in &rest {
        if next.insert(u, v).is_some() {
            return None;
        }
    }
    let start = rest[0].0;
    let mut poly = vec![start];
    let mut at = next[&start];
    while at != start {
        poly.push(at);
        at = *next.get(&at)?;
        if poly.len() > rest.len() {
            return None;
        }
    }
    if poly.len() != rest.len() {
        return None;
    }
    // drop the corners left in a straight line (within 5 cm)
    let mut k = 0;
    while poly.len() > 3 && k < poly.len() {
        let l = poly.len();
        let (a, b, c) = (poly[(k + l - 1) % l], poly[k], poly[(k + 1) % l]);
        let base = len(sub(c, a)).max(1) as i128;
        if cross(sub(b, a), sub(c, a)).abs() / base < 5 && dot(sub(b, a), sub(c, b)) > 0 {
            poly.remove(k);
        } else {
            k += 1;
        }
    }
    (poly.len() >= 3 && simple(&poly) && area2(&poly) > 0).then_some(poly)
}

/// The HQ lot neighbouring lots `parts` make as one (`poly` their union): lot parts[0]'s id,
/// block and growth rank, its front one of theirs and its door on that front's street, across
/// from the middle of the lot where that is still at the kerb, else that lot's own door; if
/// it fronts a street an HQ may and holds an HQ.
fn merged(st: &Streets, lots: &[Lot], parts: &[usize], poly: &[P]) -> Option<Lot> {
    let c = centroid(poly);
    let first = &lots[parts[0]];
    let base = Lot { poly: Some(poly.iter().map(|q| [q.0, q.1]).collect()), x: c.0, z: c.1, ..first.clone() };
    let mut tries: Vec<(P, [i64; 2])> = Vec::new();
    for &k in parts {
        let (Some(f), door) = (lots[k].front, (lots[k].door[0], lots[k].door[2])) else { continue };
        let along = unit((-f[1], f[0]));
        let s = dot(sub(c, door), along) / ONE as i128;
        tries.push(((door.0 + (along.0 as i128 * s / ONE as i128) as i64, door.1 + (along.1 as i128 * s / ONE as i128) as i64), f));
        tries.push((door, f));
    }
    tries.into_iter().find_map(|(door, f)| {
        if !st.fronts_ok(door, f) {
            return None;
        }
        let k = (0..poly.len()).min_by_key(|&k| nearest_on(door, poly[k], poly[(k + 1) % poly.len()]).1)?;
        let (lo, hi) = extent(poly, (-f[0], -f[1]));
        let l = Lot {
            front: Some(f),
            door: [door.0, first.door[1], door.1],
            w: len(sub(poly[(k + 1) % poly.len()], poly[k])),
            d: (hi - lo).max(1),
            facing: if f[1] >= 0 { Facing::North } else { Facing::South },
            ..base.clone()
        };
        fits(&l).then_some(l)
    })
}

/// How many lots at most one HQ lot is merged from.
const MERGE_MAX: usize = 8;

/// The merged HQ lots of a block (its lots `ks`): from each lot, its neighbours taken in one
/// at a time (the one that leaves the most compact lot: the least perimeter for its area)
/// until the lot holds an HQ, or `MERGE_MAX` lots would not.
fn clusters(st: &Streets, lots: &[Lot], ks: &[usize], ok: &dyn Fn(&Lot) -> bool) -> Vec<Pick> {
    let pts = |k: usize| -> Vec<P> { lots[k].poly.as_ref().map_or(Vec::new(), |q| q.iter().map(|c| (c[0], c[1])).collect()) };
    let perim = |p: &[P]| -> i64 { (0..p.len()).map(|k| len(sub(p[(k + 1) % p.len()], p[k]))).sum() };
    let mut out = Vec::new();
    let mut taken: BTreeSet<usize> = BTreeSet::new();
    for &s in ks {
        let mut parts = vec![s];
        let mut poly = pts(s);
        if poly.len() < 3 || taken.contains(&s) {
            continue;
        }
        while parts.len() < MERGE_MAX {
            let best = ks
                .iter()
                .filter(|k| !parts.contains(k) && !taken.contains(k))
                .filter_map(|&k| union(&poly, &pts(k)).map(|u| {
                    let (pe, ar) = (perim(&u) as i128, area2(&u).max(1) as i128);
                    (pe * pe * 1_000 / ar, k, u)
                }))
                .min_by_key(|x| (x.0, x.1));
            let Some((_, k, u)) = best else { break };
            parts.push(k);
            poly = u;
            if let Some(l) = merged(st, lots, &parts, &poly).filter(|l| ok(l)) {
                taken.extend(parts.iter().copied());
                out.push(Pick { parts: parts.clone(), lot: l, carved: false, rest: Vec::new() });
                break;
            }
        }
    }
    out
}

/// A lot carved for an HQ from a block's frontage, when the lots and their merges are too
/// few (a small, hilly city): its frontage and depth (cm). 30 x 20 m holds the smallest
/// tower and leaves the garage room to move (the least the client fits is 28 x 14 m).
pub const CARVE_CM: (i64, i64) = (3_000, 2_000);

/// How far apart (cm) along a block's side a carved lot is tried.
const CARVE_STEP_CM: i64 = 500;

fn pts_of(poly: &[[i64; 2]]) -> Vec<P> {
    poly.iter().map(|q| (q[0], q[1])).collect()
}

/// The inward Q16 normal of each side of the convex counter-clockwise `win`, with a point on it.
fn sides_in(win: &[P]) -> Vec<(P, P)> {
    (0..win.len()).map(|k| (win[k], left(unit(sub(win[(k + 1) % win.len()], win[k]))))).collect()
}

/// Twice the area of the part of `poly` inside the convex counter-clockwise `win`.
fn overlap2(poly: &[P], win: &[P]) -> i64 {
    let mut f: FPoly = poly.iter().map(|&q| (q, true)).collect();
    for (o, n) in sides_in(win) {
        f = clip(&f, o, n);
        if f.len() < 3 {
            return 0;
        }
    }
    area2(&f.iter().map(|q| q.0).collect::<Vec<_>>()).max(0)
}

/// What is left of lot `l` round the convex `win` it gives way to: the part outside each of
/// win's sides in turn, each a lot of its own if it is one the block splitter would keep
/// (lots.rs: no sliver, its door on a road), facing out over its longest side on a road.
fn rest_of(st: &Streets, t: &Terrain, l: &Lot, win: &[P]) -> Vec<Lot> {
    let Some(poly) = l.poly.as_ref().map(|q| pts_of(q)) else { return Vec::new() };
    let mut keep: FPoly = poly.iter().map(|&q| (q, true)).collect();
    let mut out = Vec::new();
    for (o, n) in sides_in(win) {
        let piece: Vec<P> = clip(&keep, o, (-n.0, -n.1)).into_iter().map(|q| q.0).collect();
        keep = clip(&keep, o, n);
        if piece.len() >= 3 && area2(&piece) > 0 && simple(&piece) {
            let (_, lu, lv) = obb(&piece);
            let at_road = |a: P, b: P| st.kerb(((a.0 + b.0) / 2, (a.1 + b.1) / 2));
            let m = piece.len();
            let front = (0..m)
                .map(|k| (piece[k], piece[(k + 1) % m]))
                .filter(|&(a, b)| len(sub(b, a)) >= MIN_FRONT_CM && at_road(a, b))
                .max_by_key(|&(a, b)| (len(sub(b, a)), a, b));
            let ok = lu.min(lv) >= MIN_FRONT_CM && (area2(&piece) as i128) * 100 >= 2 * 45 * lu as i128 * lv as i128 && inside(centroid(&piece), &piece);
            if let (true, Some((a, b))) = (ok, front) {
                let inward = left(unit(sub(b, a)));
                let f = (-inward.0, -inward.1);
                let door = ((a.0 + b.0) / 2, (a.1 + b.1) / 2);
                let (lo, hi) = extent(&piece, inward);
                let c = centroid(&piece);
                out.push(Lot {
                    id: 0, block: l.block, kind: "building", district: l.district, x: c.0, z: c.1, w: len(sub(b, a)), d: hi - lo,
                    facing: if f.1 >= 0 { Facing::North } else { Facing::South },
                    door: [door.0, t.height_at(door.0, door.1), door.1], floors: l.floors, rank: None, tier: None,
                    poly: Some(piece.iter().map(|q| [q.0, q.1]).collect()), front: Some([f.0, f.1]), grow: None, min_tier: None,
                });
            }
        }
        if keep.len() < 3 {
            break;
        }
    }
    out
}

/// The HQ lots that could be carved from the blocks' frontage: a `CARVE_CM` rectangle square
/// to a block's side on a street an HQ may front (every `CARVE_STEP_CM` along it), wholly
/// inside the block, clear of every site, that holds an HQ; the lots under it give way.
#[allow(clippy::too_many_arguments)] // the city the lots are carved from
fn carves(st: &Streets, t: &Terrain, blocks: &[Block], sites: &[Site], lots: &[Lot], ok: &dyn Fn(&Lot) -> bool) -> Vec<Pick> {
    let (w, d) = CARVE_CM;
    let site_polys: Vec<Vec<P>> = sites.iter().filter_map(|s| s.poly.as_ref()).map(|q| pts_of(q)).collect();
    let mut out = Vec::new();
    for b in blocks {
        if !character(b.district).grows || b.district == district::PLAZA {
            continue;
        }
        let Some(bp) = b.poly.as_ref().map(|q| pts_of(q)) else { continue };
        let ks: Vec<usize> = (0..lots.len()).filter(|&k| lots[k].block == b.id && lots[k].poly.is_some()).collect();
        let n = bp.len();
        for k in 0..n {
            let (a, c) = (bp[k], bp[(k + 1) % n]);
            let l = len(sub(c, a));
            if l < w {
                continue;
            }
            let along = unit(sub(c, a));
            let inward = left(along);
            let front = [-inward.0, -inward.1];
            let mut s = w / 2;
            while s <= l - w / 2 {
                let door = (a.0 + along.0 * s / ONE, a.1 + along.1 * s / ONE);
                s += CARVE_STEP_CM;
                let centre = (door.0 + inward.0 * (d / 2 + 10) / ONE, door.1 + inward.1 * (d / 2 + 10) / ONE);
                let r = super::rect(centre, (front[0], front[1]), w, d);
                if !r.iter().all(|&q| inside(q, &bp)) || bp.iter().any(|&q| inside(q, &r)) || !st.fronts_ok(door, front) {
                    continue;
                }
                if site_polys.iter().any(|sp| overlap2(sp, &r) > 0) {
                    continue;
                }
                let (lo, hi) = extent(&r, inward);
                let lot = Lot {
                    id: 0, block: b.id, kind: "building", district: b.district, x: centre.0, z: centre.1, w, d: hi - lo,
                    facing: if front[1] >= 0 { Facing::North } else { Facing::South },
                    door: [door.0, t.height_at(door.0, door.1), door.1], floors: 0, rank: None, tier: None,
                    poly: Some(r.iter().map(|q| [q.0, q.1]).collect()), front: Some(front), grow: None, min_tier: None,
                };
                if !ok(&lot) || !fits(&lot) {
                    continue;
                }
                let parts: Vec<usize> = ks.iter().copied().filter(|&j| overlap2(&pts_of(lots[j].poly.as_ref().unwrap()), &r) > 0).collect();
                let rest = parts.iter().flat_map(|&j| rest_of(st, t, &lots[j], &r)).collect();
                out.push(Pick { parts, lot, carved: true, rest });
            }
        }
    }
    out
}

/// City Gen v4: the HQ pool of `city`, its doors read off `roads` (see `pool`).
pub fn draw(p: &Profile, t: &Terrain, roads: &Roads, city: &mut City) -> Result<(), String> {
    let st = Streets::new(roads);
    pool(p, t, &st, &city.blocks, &city.sites, &mut city.lots)
}

/// A choice's place in the draw: off the HQ districts last, then nearest the plaza first.
type Key = (bool, i64);

/// City Gen v4: the HQ pool on the paved lots (see the module's notes): `p.hq_lots` lots,
/// garage-sized, fronting no main road, spread `GAP_CM` apart nearest the plaza first, each
/// within `WALK_CM` of a stop; ranked nearest the plaza first and tiered. Where the lots are
/// too few, lots merged, then lots carved (the lots they take leave the city, what is left of
/// a carved-through lot a lot of its own); the lots then numbered again (ids, and growth ranks
/// by the distance from the core, as the layout ranks them).
#[allow(clippy::too_many_arguments)] // the city the pool is drawn from
fn pool(p: &Profile, t: &Terrain, st: &Streets, blocks: &[Block], sites: &[Site], lots: &mut Vec<Lot>) -> Result<(), String> {
    let stops: Vec<P> = sites.iter().filter(|s| stop(s.kind)).map(|s| (s.x, s.z)).collect();
    let flat = |l: &Lot| {
        let poly = l.poly.as_ref().map_or(Vec::new(), |q| pts_of(q));
        poly.len() >= 3 && geom::rise(t, &poly) <= p.site_flat_cm * 2 && area2(&poly) >= 2 * p.hq_min_m2 * 10_000
    };
    // A personal island's one HQ is the owner's, next to the town hall on the plaza: the
    // nearest lot that holds it, whatever its district. The Commons' prefer their HQ
    // districts, nearest the plaza first.
    let by_hall = p.hq_lots == 1;
    let key = |l: &Lot| -> Key { (!by_hall && !p.hq_districts.contains(&l.district), l.x * l.x + l.z * l.z) };
    // every lot, nearest first; whether one qualifies is worked out when the draw reaches it
    let qualifies = |l: &Lot| flat(l) && l.front.is_some_and(|f| st.fronts_ok((l.door[0], l.door[2]), f)) && fits(l);
    let memo: std::cell::RefCell<BTreeMap<usize, bool>> = std::cell::RefCell::new(BTreeMap::new());
    let single_ok = |k: usize| *memo.borrow_mut().entry(k).or_insert_with(|| qualifies(&lots[k]));
    let mut singles: Vec<(Key, Pick)> = lots
        .iter()
        .enumerate()
        .filter(|(_, l)| l.poly.is_some())
        .map(|(k, l)| (key(l), Pick { parts: vec![k], lot: l.clone(), carved: false, rest: Vec::new() }))
        .collect();
    singles.sort_by_key(|x| (x.0, x.1.parts[0]));
    let near = |l: &Lot| stops.iter().any(|&s| dist2(s, (l.door[0], l.door[2])) <= WALK_CM * WALK_CM);
    let draw = |cands: &[&(Key, Pick)], walk: bool, gap: i64| -> Vec<Pick> {
        let mut chosen: Vec<Pick> = Vec::new();
        let mut used: BTreeSet<usize> = BTreeSet::new();
        for (_, c) in cands {
            if chosen.len() as i64 >= p.hq_lots {
                break;
            }
            if c.parts.iter().any(|k| used.contains(k)) || (walk && !near(&c.lot)) {
                continue;
            }
            if !chosen.iter().all(|q| dist2((q.lot.x, q.lot.z), (c.lot.x, c.lot.z)) >= gap * gap) {
                continue;
            }
            if !c.carved && c.parts.len() == 1 && !single_ok(c.parts[0]) {
                continue;
            }
            // (two carved lots may meet on ground no lot had)
            let mine = c.lot.poly.as_ref().map_or(Vec::new(), |q| pts_of(q));
            if c.carved && chosen.iter().filter(|q| q.carved).any(|q| overlap2(&q.lot.poly.as_ref().map_or(Vec::new(), |x| pts_of(x)), &mine) > 0) {
                continue;
            }
            used.extend(c.parts.iter().copied());
            chosen.push(c.clone());
        }
        chosen
    };
    // the choices beyond the single lots, found once and only if needed: merged, then carved
    let mut merges: Option<Vec<(Key, Pick)>> = None;
    let mut carved: Option<Vec<(Key, Pick)>> = None;
    let mut chosen: Vec<Pick> = Vec::new();
    let sorted = |mut v: Vec<(Key, Pick)>| {
        v.sort_by(|a, b| (a.0, &a.1.parts, a.1.lot.x, a.1.lot.z).cmp(&(b.0, &b.1.parts, b.1.lot.x, b.1.lot.z)));
        v
    };
    for &(walk, gap) in &RELAX {
        let mut all: Vec<&(Key, Pick)> = singles.iter().collect();
        chosen = draw(&all, walk, gap);
        if (chosen.len() as i64) < p.hq_lots {
            let m = merges.get_or_insert_with(|| {
                let mut by_block: BTreeMap<u32, Vec<usize>> = BTreeMap::new();
                for (k, l) in lots.iter().enumerate() {
                    by_block.entry(l.block).or_default().push(k);
                }
                sorted(by_block.values().flat_map(|ks| clusters(st, lots, ks, &flat)).map(|c| (key(&c.lot), c)).collect())
            });
            all.extend(m.iter());
            chosen = draw(&all, walk, gap);
        }
        if (chosen.len() as i64) < p.hq_lots {
            let c = carved.get_or_insert_with(|| sorted(carves(st, t, blocks, sites, lots, &flat).into_iter().map(|c| (key(&c.lot), c)).collect()));
            all.extend(c.iter());
            chosen = draw(&all, walk, gap);
        }
        if std::env::var("HQ_POOL").is_ok() {
            eprintln!(
                "hq pool: walk {walk} gap {gap}: {} of {} ({} single lots qualify, {} merged, {} carved)",
                chosen.len(), p.hq_lots, (0..lots.len()).filter(|&k| single_ok(k)).count(), merges.as_ref().map_or(0, |m| m.len()), carved.as_ref().map_or(0, |m| m.len())
            );
        }
        if chosen.len() as i64 >= p.hq_lots {
            break;
        }
    }
    // a town too small for them all keeps the HQs it has room for (the validator lists it,
    // `hq-count`): never one too close, on a main road or without its garage
    if chosen.is_empty() {
        return Err(format!("profile {}: no lot can hold an HQ", p.name));
    }
    chosen.sort_by_key(|c| (c.lot.x * c.lot.x + c.lot.z * c.lot.z, c.lot.x, c.lot.z));
    let mut gone: BTreeSet<usize> = BTreeSet::new();
    let mut new: Vec<Lot> = Vec::new();
    for (rank, c) in chosen.into_iter().enumerate() {
        let mut l = c.lot;
        l.kind = "hq";
        l.floors = 0;
        l.rank = Some(rank as u32);
        l.tier = Some(rank as u32 / p.hq_tier as u32);
        l.door[1] = t.height_at(l.door[0], l.door[2]);
        if c.carved {
            gone.extend(c.parts.iter().copied());
            new.push(l);
            new.extend(c.rest);
        } else {
            lots[c.parts[0]] = l;
            gone.extend(c.parts[1..].iter().copied());
        }
    }
    if !gone.is_empty() || !new.is_empty() {
        let mut k = 0;
        lots.retain(|_| {
            k += 1;
            !gone.contains(&(k - 1))
        });
        lots.extend(new);
        let mut by_core: Vec<(i64, usize)> = lots.iter().enumerate().map(|(k, l)| (l.x * l.x + l.z * l.z, k)).collect();
        by_core.sort();
        for (rank, &(_, k)) in by_core.iter().enumerate() {
            lots[k].grow = Some(rank as u32);
        }
        for (k, l) in lots.iter_mut().enumerate() {
            l.id = k as u32;
        }
    }
    Ok(())
}


#[cfg(test)]
mod tests {
    use super::*;

    fn lot(w: i64, d: i64) -> Lot {
        // a w x d rectangle centred on the origin, its front +z
        let poly = vec![[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]];
        Lot {
            id: 0, block: 0, kind: "building", district: 0, x: 0, z: 0, w, d, facing: Facing::North, door: [0, 0, d / 2], floors: 1,
            rank: None, tier: None, poly: Some(poly), front: Some([0, ONE]), grow: None, min_tier: None,
        }
    }

    #[test]
    fn a_lot_must_hold_the_tower_and_a_garage() {
        // as the client finds on the same rectangles (grandOf, then garageFits at that size):
        // the least is 28 x 14 m (the bay beside the tower, its apron out over the street edge)
        for (w, d, ok) in [(80, 60, true), (16, 12, false), (20, 16, false), (27, 14, false), (28, 14, true), (30, 20, true), (36, 22, true), (40, 24, true)] {
            assert_eq!(fits(&lot(w * 100, d * 100)), ok, "{w} x {d} m");
        }
        // the client's tower sizes there (grandOf, in eighths)
        for (w, d, k) in [(80, 60, 8), (28, 14, 0), (30, 20, 1), (34, 20, 3), (36, 22, 5), (40, 24, 7)] {
            assert_eq!(grand_of(&ring(&lot(w * 100, d * 100)).unwrap(), 0), k, "{w} x {d} m");
        }
        assert!(fits(&lot(CARVE_CM.0, CARVE_CM.1)), "a carved lot holds an HQ");
    }

    #[test]
    fn the_client_spots_agree() {
        // garageFits on tests/test_garage_move.py's 80 x 60 m lot (its HQ 2 m in front of the
        // middle), spot by spot as the client answers
        let r = ring(&lot(8_000, 6_000)).unwrap();
        for (x, z, rr, ok) in [(16, 6, 0, true), (0, 0, 0, false), (0, -14, 0, false), (45, 0, 0, false), (37, 0, 0, false), (16, -1, 3, false), (20, -24, 2, false), (22, 0, 1, true)] {
            assert_eq!(garage_fits(&r, FOOTS[0], x * 1_000, z * 1_000, rr), ok, "({x}, {z}) r {rr}");
        }
    }

    #[test]
    fn neighbouring_lots_merge_into_one() {
        // two 20 x 20 m squares side by side make a 40 x 20 m rectangle; a third, beside the
        // pair's long side, shares a T-junction corner and still merges
        let a = [(0, 0), (2_000, 0), (2_000, 2_000), (0, 2_000)];
        let b = [(2_000, 0), (4_000, 0), (4_000, 2_000), (2_000, 2_000)];
        let ab = union(&a, &b).unwrap();
        assert_eq!(area2(&ab), 2 * 4_000 * 2_000);
        assert_eq!(ab.len(), 4, "{ab:?}");
        let c = [(0, 2_000), (4_000, 2_000), (4_000, 3_000), (0, 3_000)];
        let abc = union(&ab, &c).unwrap();
        assert_eq!(area2(&abc), 2 * 4_000 * 3_000);
        assert_eq!(abc.len(), 4, "{abc:?}");
        // apart: no union
        assert!(union(&a, &[(5_000, 0), (6_000, 0), (6_000, 1_000), (5_000, 1_000)]).is_none());
    }

    #[test]
    fn a_carved_lot_leaves_the_rest_of_the_lot_it_cuts() {
        let win = [(0, 0), (1_000, 0), (1_000, 1_000), (0, 1_000)];
        assert_eq!(overlap2(&[(500, 500), (1_500, 500), (1_500, 1_500), (500, 1_500)], &win), 2 * 500 * 500);
        assert_eq!(overlap2(&[(1_000, 0), (2_000, 0), (2_000, 1_000), (1_000, 1_000)], &win), 0, "touching is no overlap");
    }
}
