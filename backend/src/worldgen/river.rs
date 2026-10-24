//! The river (@2): every organic world has one, from the sea inland to a harbour basin
//! near the city's middle, so the port stands in town and not always on its edge.
//!
//!   course   it leaves the coast at a seeded bearing and spirals inland: the bearing
//!            turns steadily from the mouth to the basin while the radius falls from the
//!            coast to its nearest the plaza (the dock's reach: inside a personal city's
//!            first ring) and rises again to a harbour basin 25-45% of the city's radius
//!            out. Out past the town it meanders (integer value noise on its lateral offset)
//!   water    the channel (`width_cm` wide) and the basin (a disc 2.2 widths across) as
//!            one counter-clockwise outline, closed 30 m out past the coast so it overlaps
//!            the sea; at its nearest the plaza a bay opens on the plaza's side for the
//!            dock's pier
//!   bank     the water's outline `BANK_CM` further out: the slope down to the water and
//!            the land beside it that the terrain's 8 m lattice blends into the slope, so
//!            the ground at the bank's edge is the land's own; round the basin it widens
//!            into the port's apron. Streets, blocks, lots and sites keep outside it (the
//!            organic generator lays it into its road graph as a wall before any street
//!            grows, so streets meet it and stop); arterials, the ring road and the
//!            highways cross on straight, level bridges
//!   shape    the terrain hook (after the coast's): the water sinks below the sea, its bed
//!            falling to 4 m deep, and the bank blends up from a metre above the sea at the
//!            water's edge to the land `SLOPE_CM` inland, as the beach does
//!   dock     on the bay's bank, half its pier out over the water, a quay street to its
//!            back from the nearest road (organic::generate); the port on its apron, its
//!            front quarter out over the basin, on the side nearest the plaza away from the
//!            channel. civic.rs stands them there
//!
//! `layers.river` carries the centre line, the width, the basin and the water's outline.
//! Integer arithmetic only (cm, Q16, no trig), as the rest of the generator.

use serde::Serialize;

use super::island::{directions, Coast, RADII_CM};
use super::noise::{isqrt, smoothstep, value, ONE};
use super::organic::geom::{along, area2, cross, dist2, dot, inside, left, len, lerp, nearest_on, simple, sub, unit, P};
use super::profile::Profile;
use super::rng::{self, Rng};
use super::roads::segments_touch;
use super::terrain::Terrain;

/// How far (cm) past the water's edge the bank reaches: no street, block, lot or site
/// comes nearer the water (bar the bridges, the dock and the port). The slope and a
/// terrain cell and a half: the ground a road at the bank's edge stands on is untouched.
pub const BANK_CM: i64 = 2_000;
/// The bank's slope (cm): the ground blends from the water's edge up to the land over it.
const SLOPE_CM: i64 = 800;
/// How far (cm) back from the water's edge the dock's back and the port's stand: half
/// the dock's 24 m on land, three quarters of the port's 40 m. The bank round the basin
/// widens by `APRON_CM` on the port's side (full across `APRON_COS` of its bearing, easing
/// out by `APRON_EASE`), 10 m clear behind the port.
const DOCK_STAND_CM: i64 = 1_200;
const PORT_STAND_CM: i64 = 3_000;
const APRON_CM: i64 = PORT_STAND_CM + 1_000 - BANK_CM;
const APRON_COS: i64 = 53_684; // cos 35 degrees (Q16)
const APRON_EASE: i64 = 37_590; // cos 55 degrees
/// The centre line's step (cm).
const STEP_CM: i64 = 1_200;
/// The water's outline closes this far (cm) out past the coast.
const MOUTH_CM: i64 = 3_000;
/// The dock's bay: this deep (cm) into the plaza's bank, at full depth for this far
/// either side of the dock and easing back to the bank over the next stretch.
const BAY_CM: i64 = 1_400;
const BAY_FLAT_CM: i64 = 1_800;
const BAY_RAMP_CM: i64 = 3_000;
/// The river bed: a metre below the sea at the water's edge, falling this much (per
/// mille) to this depth (cm) below the sea.
const BED_PM: i64 = 300;
const DEPTH_CM: i64 = 400;
/// The meander's noise cell (cm) along the course.
const MEANDER_CM: i64 = 20_000;
/// Samples of the course before it is resampled to its step, and the smoothing passes
/// over it (each a 1-2-1 average of neighbours: about 55 m of blur after 40).
const FINE: i64 = 512;
const SMOOTH: usize = 40;
/// Seeded courses tried before a world is declared to have no room for a river.
const ATTEMPTS: i64 = 32;
/// The point-in-outline raster's cell (cm).
const CELL_CM: i64 = 1_600;

#[derive(Serialize)]
pub struct Basin {
    pub x: i64,
    pub z: i64,
    pub r: i64,
}

#[derive(Serialize)]
pub struct River {
    /// The centre line, [x, z] cm, from the mouth (on the coast) to the basin's centre.
    pub center: Vec<[i64; 2]>,
    /// The channel's width (cm).
    pub width_cm: i64,
    /// The harbour basin (cm).
    pub basin: Basin,
    /// The water's outline (channel, bay and basin), [x, z] cm, counter-clockwise, its
    /// mouth end closed 30 m out past the coast.
    pub poly: Vec<[i64; 2]>,
    /// The water, and the water and its bank (`BANK_CM` round it), for point tests.
    #[serde(skip)]
    pub water: Zone,
    #[serde(skip)]
    pub bank: Zone,
    /// The bank's vertex straight behind the dock: where the quay street ends.
    #[serde(skip)]
    pub quay: usize,
    /// Where a bridge may cross the river square, mouth first.
    #[serde(skip)]
    pub crossings: Vec<Crossing>,
    /// Where the dock stands: the middle of its back, on the bank, and the Q16 unit out
    /// over the water (its front).
    #[serde(skip)]
    pub dock: (P, P),
    /// Where the port stands: the middle of its back, on its apron, and its front.
    #[serde(skip)]
    pub port: (P, P),
    #[serde(skip)]
    sea_cm: i64,
    /// Generator @3 (water.rs): the canals' centre lines (mouth first), whose water and
    /// banks are joined into `water` and `bank`, and the other bodies of water (lakes, the
    /// marina) as (water, bank). Empty before @3, so nothing else changes there.
    #[serde(skip)]
    pub arms: Vec<Vec<P>>,
    #[serde(skip)]
    pub pools: Vec<(Zone, Zone)>,
}

/// A place a bridge may cross the river square: a point of the centre line, its normal
/// (Q16, to the left going upstream), and the bank's vertices either side (indices into
/// `bank.poly`, left and right).
pub struct Crossing {
    pub at: P,
    pub normal: P,
    pub left: usize,
    pub right: usize,
}

/// A polygon with a raster over it, for fast point tests and nearby edges.
pub struct Zone {
    pub poly: Vec<P>,
    lo: P,
    nx: i64,
    nz: i64,
    /// Per cell: 0 outside, 1 inside, 2 an edge passes near (test exactly).
    cells: Vec<u8>,
    /// Per cell: the edges whose box meets it.
    edges: Vec<Vec<u32>>,
}

impl Zone {
    pub(super) fn new(poly: Vec<P>) -> Zone {
        let (x0, x1) = poly.iter().fold((i64::MAX, i64::MIN), |m, q| (m.0.min(q.0), m.1.max(q.0)));
        let (z0, z1) = poly.iter().fold((i64::MAX, i64::MIN), |m, q| (m.0.min(q.1), m.1.max(q.1)));
        let lo = (x0 - CELL_CM, z0 - CELL_CM);
        let (nx, nz) = ((x1 - lo.0) / CELL_CM + 2, (z1 - lo.1) / CELL_CM + 2);
        let mut z = Zone { poly, lo, nx, nz, cells: vec![0; (nx * nz) as usize], edges: vec![Vec::new(); (nx * nz) as usize] };
        let n = z.poly.len();
        for k in 0..n {
            let (a, b) = (z.poly[k], z.poly[(k + 1) % n]);
            let (i0, j0) = z.cell((a.0.min(b.0), a.1.min(b.1)));
            let (i1, j1) = z.cell((a.0.max(b.0), a.1.max(b.1)));
            for j in j0..=j1 {
                for i in i0..=i1 {
                    let c = (j * nx + i) as usize;
                    z.cells[c] = 2;
                    z.edges[c].push(k as u32);
                }
            }
        }
        for j in 0..nz {
            for i in 0..nx {
                let c = (j * nx + i) as usize;
                if z.cells[c] == 0 && inside((lo.0 + i * CELL_CM + CELL_CM / 2, lo.1 + j * CELL_CM + CELL_CM / 2), &z.poly) {
                    z.cells[c] = 1;
                }
            }
        }
        z
    }

    fn cell(&self, q: P) -> (i64, i64) {
        (((q.0 - self.lo.0).div_euclid(CELL_CM)).clamp(0, self.nx - 1), ((q.1 - self.lo.1).div_euclid(CELL_CM)).clamp(0, self.nz - 1))
    }

    /// Is q inside the polygon?
    pub fn holds(&self, q: P) -> bool {
        let (i, j) = ((q.0 - self.lo.0).div_euclid(CELL_CM), (q.1 - self.lo.1).div_euclid(CELL_CM));
        if i < 0 || j < 0 || i >= self.nx || j >= self.nz {
            return false;
        }
        match self.cells[(j * self.nx + i) as usize] {
            0 => false,
            1 => true,
            _ => inside(q, &self.poly),
        }
    }

    /// The squared distance (cm2) from q to the outline, if it is within a cell (16 m).
    pub(super) fn near2(&self, q: P) -> Option<i64> {
        let (i, j) = self.cell(q);
        let n = self.poly.len();
        let mut best: Option<i64> = None;
        for jj in (j - 1).max(0)..=(j + 1).min(self.nz - 1) {
            for ii in (i - 1).max(0)..=(i + 1).min(self.nx - 1) {
                for &k in &self.edges[(jj * self.nx + ii) as usize] {
                    let d = nearest_on(q, self.poly[k as usize], self.poly[(k as usize + 1) % n]).1;
                    best = Some(best.map_or(d, |b| b.min(d)));
                }
            }
        }
        best.filter(|&d| d <= CELL_CM * CELL_CM)
    }

    /// Does segment ab meet the outline?
    pub fn crosses(&self, a: P, b: P) -> bool {
        let n = self.poly.len();
        let (i0, j0) = self.cell((a.0.min(b.0), a.1.min(b.1)));
        let (i1, j1) = self.cell((a.0.max(b.0), a.1.max(b.1)));
        (j0..=j1).any(|j| {
            (i0..=i1).any(|i| self.edges[(j * self.nx + i) as usize].iter().any(|&k| segments_touch(a, b, self.poly[k as usize], self.poly[(k as usize + 1) % n])))
        })
    }

    /// Does the polygon `poly` overlap this one (a corner inside, or an edge across its outline)?
    pub fn meets(&self, poly: &[P]) -> bool {
        let n = poly.len();
        poly.iter().any(|&q| self.holds(q)) || (0..n).any(|k| self.crosses(poly[k], poly[(k + 1) % n]))
    }
}

impl River {
    /// The river of a world whose profile has one (and a coast for it to reach); Ok(None)
    /// for a world without. Courses are tried seed by seed until one fits the city.
    pub fn new(seed: u64, p: &Profile) -> Result<Option<River>, String> {
        let (Some(width), Some(coast)) = (p.river_cm, Coast::new(seed, p)) else {
            return Ok(None);
        };
        (0..ATTEMPTS)
            .find_map(|k| course(seed, p, &coast, width, k))
            .map(Some)
            .ok_or_else(|| format!("profile {}: no course for the river fits the city", p.name))
    }

    /// The terrain hook: sink the water below the sea and blend the bank up to the land.
    pub fn shape(&self, t: &mut Terrain) {
        let w = &self.water;
        let (lo, hi) = (t.vertex_of(w.lo.0 - BANK_CM, w.lo.1 - BANK_CM), t.vertex_of(w.lo.0 + w.nx * CELL_CM, w.lo.1 + w.nz * CELL_CM));
        let (sea, floor) = (self.sea_cm, self.sea_cm + 100);
        for iz in lo.1..=hi.1 {
            for ix in lo.0..=hi.0 {
                let q = t.vertex_pos(ix, iz);
                let wet = w.holds(q);
                // the signed way out from the water's edge (negative in the water)
                let s = match w.near2(q) {
                    Some(d2) => if wet { -isqrt(d2) } else { isqrt(d2) },
                    None if wet => -CELL_CM,
                    None => continue,
                };
                if s >= SLOPE_CM {
                    continue;
                }
                let k = iz * t.n + ix;
                let h = t.heights[k] as i64;
                let h = if s < 0 {
                    h.min((sea - 100 + s * BED_PM / 1000).max(sea - DEPTH_CM))
                } else if h > sea {
                    // up from a metre over the sea at the water's edge (low land too: no sea shows past the bank)
                    floor + (h - floor) * smoothstep(s * ONE / SLOPE_CM) / ONE
                } else {
                    h // the sea's own floor, out past the coast
                };
                t.heights[k] = h as i32;
            }
        }
    }

    /// Is q on the river or its bank (where no street, block, lot or site goes)? From @3
    /// also on any other body of water or its bank.
    pub fn zone(&self, q: P) -> bool {
        self.bank.holds(q) || self.pools.iter().any(|z| z.1.holds(q))
    }

    /// Is q on the water (from @3: any body's)?
    pub fn wet(&self, q: P) -> bool {
        self.water.holds(q) || self.in_pool(q)
    }

    /// Is q on one of the other bodies of water (@3: a lake, the marina)?
    pub fn in_pool(&self, q: P) -> bool {
        self.pools.iter().any(|z| z.0.holds(q))
    }

    /// Does the footprint meet the river's bank, or (@3) another body's?
    pub fn bank_meets(&self, poly: &[P]) -> bool {
        self.bank.meets(poly) || self.pools.iter().any(|z| z.1.meets(poly))
    }

    /// Does segment ab cross the water's edge (the river's, or @3 another body's)?
    pub fn water_crosses(&self, a: P, b: P) -> bool {
        self.water.crosses(a, b) || self.pools.iter().any(|z| z.0.crosses(a, b))
    }

    /// The sea level the river runs out to (cm).
    pub fn sea_cm(&self) -> i64 {
        self.sea_cm
    }

    /// Join a canal (@3) into the river: its water and its bank outlines (counter-clockwise,
    /// each starting inside the river's own) are merged into the river's, so the organic
    /// generator walls, bridges and builds round one body of water. The quay and the
    /// crossings follow the bank's vertices; a crossing the canal swallowed is dropped.
    /// False (and nothing changed) when the outlines do not meet the river's cleanly.
    pub fn join(&mut self, water: &[P], bank: &[P], arm: Vec<P>) -> bool {
        let (Some((w, _)), Some((b, map))) = (union(&self.water.poly, water), union(&self.bank.poly, bank)) else {
            return false;
        };
        let Some(quay) = map[self.quay] else { return false };
        self.quay = quay;
        self.crossings.retain_mut(|x| match (map[x.left], map[x.right]) {
            (Some(l), Some(r)) => {
                (x.left, x.right) = (l, r);
                true
            }
            _ => false,
        });
        self.water = Zone::new(w);
        self.bank = Zone::new(b);
        self.arms.push(arm);
        true
    }
}

/// The union of two simple counter-clockwise polygons whose outlines cross exactly
/// twice (a canal's mouth inside the river): `a` round the outside of `b`, then `b`
/// round the outside of `a`. Also, for each of `a`'s vertices, its index in the union
/// (None where `b` swallowed it). None if they do not cross twice or the union is no
/// simple polygon.
pub(super) fn union(a: &[P], b: &[P]) -> Option<(Vec<P>, Vec<Option<usize>>)> {
    let (n, m) = (a.len(), b.len());
    let mut xs: Vec<(usize, usize, P)> = Vec::new();
    for i in 0..n {
        let (p, q) = (a[i], a[(i + 1) % n]);
        let (x0, x1, z0, z1) = (p.0.min(q.0), p.0.max(q.0), p.1.min(q.1), p.1.max(q.1));
        for j in 0..m {
            let (c, d) = (b[j], b[(j + 1) % m]);
            if c.0.max(d.0) < x0 || c.0.min(d.0) > x1 || c.1.max(d.1) < z0 || c.1.min(d.1) > z1 {
                continue;
            }
            if let Some((num, den)) = super::organic::geom::crossing(p, q, c, d) {
                xs.push((i, j, lerp(p, q, num, den)));
                if xs.len() > 2 {
                    return None;
                }
            }
        }
    }
    let [x, y] = xs[..] else { return None };
    if x.0 == y.0 || x.1 == y.1 {
        return None;
    }
    // leaving b along a: the vertex after the crossing is outside b
    let (leave, enter) = if !inside(a[(x.0 + 1) % n], b) { (x, y) } else { (y, x) };
    if inside(a[(leave.0 + 1) % n], b) || inside(b[(enter.1 + 1) % m], a) {
        return None;
    }
    let mut out = vec![leave.2];
    let mut map = vec![None; n];
    let mut k = (leave.0 + 1) % n;
    loop {
        map[k] = Some(out.len());
        out.push(a[k]);
        if k == enter.0 {
            break;
        }
        k = (k + 1) % n;
    }
    out.push(enter.2);
    let mut k = (enter.1 + 1) % m;
    loop {
        out.push(b[k]);
        if k == leave.1 {
            break;
        }
        k = (k + 1) % m;
    }
    out.dedup();
    if out.first() == out.last() {
        out.pop();
    }
    // a repeated point would shift the map: refuse rather than mend
    if out.len() != map.iter().flatten().count() + 2 + (leave.1 + m - enter.1) % m || area2(&out) <= 0 || !simple(&out) {
        return None;
    }
    Some((out, map))
}

/// The point a fraction `f` (Q16) of the way between two Q16 units, as a Q16 unit.
fn blend(a: P, b: P, f: i64) -> P {
    unit((a.0 + (b.0 - a.0) * f / ONE, a.1 + (b.1 - a.1) * f / ONE))
}

/// `pts` resampled to equal steps of about `step` cm, the ends kept.
pub(super) fn resample(pts: &[P], step: i64) -> Vec<P> {
    let mut at = vec![0i64; pts.len()];
    for k in 1..pts.len() {
        at[k] = at[k - 1] + len(sub(pts[k], pts[k - 1]));
    }
    let total = at[pts.len() - 1];
    let n = ((total + step / 2) / step).max(1);
    let mut out = Vec::with_capacity(n as usize + 1);
    let mut k = 1;
    for i in 0..=n {
        let s = total * i / n;
        while k + 1 < pts.len() && at[k] < s {
            k += 1;
        }
        let seg = (at[k] - at[k - 1]).max(1);
        out.push(lerp(pts[k - 1], pts[k], (s - at[k - 1]).clamp(0, seg) as i128, seg as i128));
    }
    out[0] = pts[0];
    out[n as usize] = pts[pts.len() - 1];
    out
}

/// Where segment ab (a outside the disc (c, r), b inside) crosses its rim.
fn rim(a: P, b: P, c: P, r: i64) -> P {
    let (mut lo, mut hi) = (0i128, ONE as i128);
    for _ in 0..24 {
        let mid = (lo + hi) / 2;
        if dist2(lerp(a, b, mid, ONE as i128), c) < r * r {
            hi = mid;
        } else {
            lo = mid;
        }
    }
    lerp(a, b, hi, ONE as i128)
}

/// The sector of `dirs` (counter-clockwise Q16 units) that holds the direction v.
fn sector(dirs: &[P], v: P) -> usize {
    let n = dirs.len();
    (0..n).find(|&k| cross(dirs[k], v) >= 0 && cross(v, dirs[(k + 1) % n]) > 0).unwrap_or(0)
}

/// The outline round a channel and its basin: each side of the centre line `c` (the
/// mouth's extension first) offset by its half width (`half`: left, right) plus `extra`,
/// joined round the far side of the basin (`b`, radius `rb + extra`, and `APRON_CM` more
/// toward the Q16 unit `apron`, if any). Counter-clockwise:
/// up the right side, round the basin, back down the left. Also, for each point of the
/// centre line, the polygon's index of its left side's point and of its right side's
/// (None where the basin swallows it), and where the channel meets the basin (the middle
/// of its two rim points).
pub(super) type Sides = Vec<(Option<usize>, Option<usize>)>;
pub(super) fn outline(c: &[P], normals: &[P], half: &[(i64, i64)], b: P, rb: i64, extra: i64, apron: Option<P>) -> Option<(Vec<P>, Sides, P)> {
    let rr = rb + extra;
    let side = |s: i64| -> Vec<P> {
        (0..c.len()).map(|i| {
            let h = if s > 0 { half[i].0 } else { half[i].1 } + extra;
            along(c[i], normals[i], s * h)
        }).collect()
    };
    let (l, r) = (side(1), side(-1));
    let jr = (1..r.len()).find(|&i| dist2(r[i], b) < rr * rr)?;
    let jl = (1..l.len()).find(|&i| dist2(l[i], b) < rr * rr)?;
    let (xr, xl) = (rim(r[jr - 1], r[jr], b, rr), rim(l[jl - 1], l[jl], b, rr));
    let dirs: Vec<P> = directions().into_iter().step_by(2).collect();
    let (kr, kl) = (sector(&dirs, sub(xr, b)), sector(&dirs, sub(xl, b)));
    let end = if kl > kr { kl } else { kl + dirs.len() };
    let wide = |d: P| {
        let cos = apron.map_or(0, |u| (dot(d, u) / ONE as i128) as i64);
        APRON_CM * smoothstep((cos - APRON_EASE) * ONE / (APRON_COS - APRON_EASE)) / ONE
    };
    let arc: Vec<P> = (kr + 1..=end).map(|k| along(b, dirs[k % dirs.len()], rr + wide(dirs[k % dirs.len()]))).collect();
    let mut poly: Vec<P> = r[..jr].to_vec();
    poly.push(xr);
    poly.extend(arc);
    poly.push(xl);
    let base = poly.len();
    poly.extend(l[..jl].iter().rev());
    let sides = (0..c.len()).map(|k| ((k < jl).then(|| base + jl - 1 - k), (k < jr).then_some(k))).collect();
    Some((poly, sides, ((xr.0 + xl.0) / 2, (xr.1 + xl.1) / 2)))
}

/// One seeded course (attempt `attempt`), if it fits: clear of the plaza, its outlines
/// simple, the dock inside a personal city's first ring.
fn course(seed: u64, p: &Profile, coast: &Coast, width: i64, attempt: i64) -> Option<River> {
    let mut rng = Rng::new(rng::sub(seed, "river", attempt, 0));
    let dirs = directions();
    let n = dirs.len() as i64;
    let at = |k: i64| dirs[k.rem_euclid(n) as usize];
    // bearings (as indices round the coast's 128 directions): the nearest point, the mouth
    // 40-70 degrees back from it, the basin 60-110 degrees on, all turning one way
    let s = if rng.chance(500) { 1 } else { -1 };
    let ka = rng.range(0, n - 1);
    let km = ka - s * rng.range(14, 25);
    let kb = ka + s * rng.range(22, 39);
    let (hw, rb) = (width / 2, width * 11 / 10);
    // the plaza block and its ring road, then the bank: nothing of the river comes nearer
    let clear = p.plaza_cm + p.avenue_cm / 2 + BANK_CM + 500;
    let lo_a = clear + hw + BAY_CM + 1_000;
    let r_a = rng.range(lo_a, lo_a + 2_000);
    let r_b = rng.range((p.city_r_cm / 4).max(clear + rb), p.city_r_cm * 45 / 100);
    let mouth = coast.poly[km.rem_euclid(n) as usize];
    let r_m = len(mouth);
    let u_a = (ka - km).abs() * ONE / (kb - km).abs();
    let wander = rng::sub(seed, "river-meander", attempt, 0);

    // the spiral: radius falling as a square to the nearest point, then easing out to the basin
    let fine: Vec<P> = (0..=FINE)
        .map(|t| {
            if t == 0 {
                return mouth;
            }
            let u = t * ONE / FINE;
            let kq = km * ONE + (kb - km) * u;
            let d = blend(at(kq.div_euclid(ONE)), at(kq.div_euclid(ONE) + 1), kq.rem_euclid(ONE));
            let r = if u <= u_a {
                let v = (u_a - u) * ONE / u_a;
                r_a + (r_m - r_a) * v / ONE * v / ONE
            } else {
                r_a + (r_b - r_a) * smoothstep((u - u_a) * ONE / (ONE - u_a)) / ONE
            };
            let q = along((0, 0), d, r);
            if u >= u_a {
                return q;
            }
            // the meander: out past the town, never at the mouth
            let taper = smoothstep((r - r_a - 10_000) * ONE / 10_000) * smoothstep((r_m - r) * ONE / 10_000) / ONE;
            along(q, left(d), width * value(wander, r, 0, MEANDER_CM) / 32768 * taper / ONE)
        })
        .collect();
    // smoothed (the ends kept): the spiral turns hard at its nearest the plaza, and every
    // bend must be wide enough for its banks
    let mut center = resample(&fine, STEP_CM);
    for _ in 0..SMOOTH {
        let prev = center.clone();
        for i in 1..center.len() - 1 {
            center[i] = ((prev[i - 1].0 + 2 * prev[i].0 + prev[i + 1].0) / 4, (prev[i - 1].1 + 2 * prev[i].1 + prev[i + 1].1) / 4);
        }
    }
    let center = resample(&center, STEP_CM);
    let b = center[center.len() - 1];
    if center[1..].iter().any(|&q| !coast.land(q)) {
        return None;
    }

    // the mouth's extension out to sea, then each point's normal (left of the way upstream)
    let m = center.len();
    let out = unit(sub(center[0], center[1]));
    let mut c = vec![along(center[0], out, MOUTH_CM)];
    c.extend(&center);
    let normals: Vec<P> = (0..c.len()).map(|i| left(unit(sub(c[(i + 1).min(c.len() - 1)], c[i.saturating_sub(1)])))).collect();

    // the dock: at the course's nearest the plaza (away from the basin), on the plaza's side
    let d = (1..m).filter(|&i| dist2(center[i], b) > (rb + 6_000).pow(2)).min_by_key(|&i| (dist2(center[i], (0, 0)), i))? + 1;
    let toward = if dot(normals[d], (-c[d].0, -c[d].1)) > 0 { 1 } else { -1 };
    let half: Vec<(i64, i64)> = (0..c.len())
        .map(|i| {
            let off = (i as i64 - d as i64).abs() * STEP_CM;
            let bay = if off <= BAY_FLAT_CM { BAY_CM } else { BAY_CM * (ONE - smoothstep((off - BAY_FLAT_CM) * ONE / BAY_RAMP_CM)) / ONE };
            if toward > 0 { (hw + bay, hw) } else { (hw, hw + bay) }
        })
        .collect();
    let (water, _, inlet) = outline(&c, &normals, &half, b, rb, 0, None)?;
    // the port: round the basin, its apron (out to 55 degrees either side) clear of where
    // the channel's banks meet the basin's (110 degrees or more off the channel's inlet),
    // nearest the plaza but leaving 60 m of town between the plaza and its apron
    let inlet = unit(sub(inlet, b));
    let near = p.plaza_cm + p.avenue_cm / 2 + 500;
    let u = directions()
        .into_iter()
        .step_by(4)
        .filter(|&u| dot(u, inlet) * 100 < -34 * (ONE * ONE) as i128)
        .min_by_key(|&u| {
            let apron = len(along(b, u, rb + BANK_CM + APRON_CM));
            (apron < near + 6_000, dist2(along(b, u, rb), (0, 0)), u)
        })?;
    let (bank, sides, _) = outline(&c, &normals, &half, b, rb, BANK_CM, Some(u))?;
    let quay = if toward > 0 { sides[d].0 } else { sides[d].1 }?;
    // where a bridge may cross square: past the mouth's extension, both banks whole, off
    // the bay (and its easing) and clear of the basin
    let crossings = (1..c.len())
        .filter(|&i| (i as i64 - d as i64).abs() * STEP_CM > BAY_FLAT_CM + BAY_RAMP_CM + 1_000 && dist2(c[i], b) > (rb + 4_000).pow(2))
        .filter_map(|i| Some(Crossing { at: c[i], normal: normals[i], left: sides[i].0?, right: sides[i].1? }))
        .collect();
    if area2(&water) <= 0 || area2(&bank) <= 0 || !simple(&water) || !simple(&bank) {
        return None;
    }
    let nb = bank.len();
    if (0..nb).any(|k| nearest_on((0, 0), bank[k], bank[(k + 1) % nb]).1 < near * near) {
        return None;
    }
    let n_p = (normals[d].0 * toward, normals[d].1 * toward);
    let dock = along(c[d], n_p, hw + BAY_CM + DOCK_STAND_CM);
    let front = (-n_p.0, -n_p.1);
    // a personal city's tier-1 town holds its dock (the water's edge: a 24 m one's middle)
    if p.name == "island" && len(along(dock, front, DOCK_STAND_CM)) > RADII_CM[0] - 1_000 {
        return None;
    }

    Some(River {
        center: center.iter().map(|q| [q.0, q.1]).collect(),
        width_cm: width,
        basin: Basin { x: b.0, z: b.1, r: rb },
        poly: water.iter().map(|q| [q.0, q.1]).collect(),
        water: Zone::new(water),
        bank: Zone::new(bank),
        quay,
        crossings,
        dock: (dock, front),
        port: (along(b, u, rb + PORT_STAND_CM), (-u.0, -u.1)),
        sea_cm: coast.sea_cm,
        arms: Vec::new(),
        pools: Vec::new(),
    })
}

#[cfg(test)]
#[path = "river_tests.rs"]
mod tests;
