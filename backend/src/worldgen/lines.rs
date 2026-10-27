//! The @3 line planners' shared ground (metro.rs, railway.rs, gondola.rs): what they
//! read (`Ctx`, the finished world before lines are laid), what they hand back for land
//! (`Claim`, a site worldgen adds, maybe retyping one non-hq lot), and the integer
//! geometry they share:
//!
//!   Land      point and footprint tests against the roads (their full width), the lots,
//!             the sites, the water and the coast, through a bucket grid
//!   Net       the road graph: cheapest node paths by class, and their centre lines
//!   alignment straight platforms pinned, the track between them smoothed from the
//!             street centre lines (a bi-Laplacian band, as games/hqrail.js's elastic
//!             band, in integers) until no curve is tighter than `MIN_RADIUS_CM`
//!
//! Integer arithmetic only (cm, Q16 directions, i128 products, no trig), so every
//! platform builds the same bytes.

use std::cmp::Reverse;
use std::collections::BinaryHeap;

use super::city::{Lot, Site};
use super::noise::{isqrt, ONE};
use super::organic::geom::{cross, dist2, dot, inside, nearest_on, seg_dist2, turn, unit, DIR16};
use super::profile::Profile;
use super::river::River;
use super::roads::Roads;
use super::terrain::Terrain;

pub type P = (i64, i64);

/// Everything a line planner reads: the finished @3 world before lines are laid.
pub struct Ctx<'a> {
    pub seed: u64,
    pub profile: &'a Profile,
    pub terrain: &'a Terrain,
    pub roads: &'a Roads,
    pub lots: &'a [Lot],
    pub sites: &'a [Site],
    pub river: Option<&'a River>,
    /// Every water polygon (bodies, river), cm.
    pub water: &'a [Vec<[i64; 2]>],
    /// The island coast polygon, cm (None on @1).
    pub coast: Option<&'a [[i64; 2]]>,
}

/// A piece of land a planner needs: worldgen turns it into a site of `kind` (id
/// `<kind>:<n>`, footprint `poly`, counter-clockwise, door facing the Q16 `front`, from
/// city tier `tier`) and removes `lot`, a non-hq lot the footprint stands on, from the lots.
#[derive(Clone, Debug, PartialEq)]
pub struct Claim {
    pub kind: &'static str,
    pub id: String,
    pub x: i64,
    pub z: i64,
    pub poly: Vec<[i64; 2]>,
    pub front: [i64; 2],
    pub tier: u8,
    pub lot: Option<u32>,
}

/// The tightest curve a line may take (cm).
pub const MIN_RADIUS_CM: i64 = 15_000;
/// The step (cm) between a line's path points.
pub const STEP_CM: i64 = 2_500;

// ---------------------------------------------------------------- small geometry

pub fn pt(a: [i64; 2]) -> P {
    (a[0], a[1])
}

pub fn arr(p: P) -> [i64; 2] {
    [p.0, p.1]
}

pub fn dist(a: P, b: P) -> i64 {
    isqrt(dist2(a, b))
}

/// The point `cm` along the Q16 unit `d` from `p` (exact for long distances too).
pub fn ahead(p: P, d: P, cm: i64) -> P {
    (p.0 + ((d.0 as i128 * cm as i128) / ONE as i128) as i64, p.1 + ((d.1 as i128 * cm as i128) / ONE as i128) as i64)
}

/// The left of a Q16 direction (a quarter turn from +x toward +z).
pub fn left(d: P) -> P {
    (-d.1, d.0)
}

pub fn neg(d: P) -> P {
    (-d.0, -d.1)
}

/// A rectangle round `c`, `len` along the Q16 unit `d` and `w` across, counter-clockwise.
pub fn rect(c: P, d: P, len: i64, w: i64) -> Vec<[i64; 2]> {
    let l = left(d);
    let f = |a: i64, b: i64| arr(ahead(ahead(c, d, a), l, b));
    let mut r = vec![f(-len / 2, -w / 2), f(len / 2, -w / 2), f(len / 2, w / 2), f(-len / 2, w / 2)];
    if area2(&r) < 0 {
        r.reverse();
    }
    r
}

pub fn area2(poly: &[[i64; 2]]) -> i64 {
    let n = poly.len();
    (0..n).map(|i| poly[i][0] * poly[(i + 1) % n][1] - poly[(i + 1) % n][0] * poly[i][1]).sum()
}

pub fn pts(poly: &[[i64; 2]]) -> Vec<P> {
    poly.iter().map(|&a| pt(a)).collect()
}

/// Do two polygons meet (an edge within `gap` of the other's, or one inside the other)?
pub fn polys_meet(a: &[P], b: &[P], gap: i64) -> bool {
    if a.is_empty() || b.is_empty() {
        return false;
    }
    if inside(a[0], b) || inside(b[0], a) {
        return true;
    }
    let (n, m) = (a.len(), b.len());
    (0..n).any(|i| (0..m).any(|j| seg_dist2(a[i], a[(i + 1) % n], b[j], b[(j + 1) % m]) <= gap * gap))
}

/// Points over a footprint: its corners, its edges every ~4 m and a 4 m lattice inside.
pub fn samples(poly: &[P]) -> Vec<P> {
    let mut out = Vec::new();
    let n = poly.len();
    for i in 0..n {
        let (a, b) = (poly[i], poly[(i + 1) % n]);
        let k = (dist(a, b) / 400).max(1);
        for j in 0..k {
            out.push((a.0 + (b.0 - a.0) * j / k, a.1 + (b.1 - a.1) * j / k));
        }
    }
    let (x0, x1) = poly.iter().fold((i64::MAX, i64::MIN), |m, p| (m.0.min(p.0), m.1.max(p.0)));
    let (z0, z1) = poly.iter().fold((i64::MAX, i64::MIN), |m, p| (m.0.min(p.1), m.1.max(p.1)));
    let mut z = z0 + 200;
    while z < z1 {
        let mut x = x0 + 200;
        while x < x1 {
            if inside((x, z), poly) {
                out.push((x, z));
            }
            x += 400;
        }
        z += 400;
    }
    out
}

/// The radius (cm) of the circle through three points (i64::MAX when they are in line).
pub fn radius3(a: P, b: P, c: P) -> i64 {
    let cr = (b.0 - a.0) as i128 * (c.1 - a.1) as i128 - (b.1 - a.1) as i128 * (c.0 - a.0) as i128;
    if cr == 0 {
        return i64::MAX;
    }
    let (ab, bc, ca) = (dist(a, b) as i128, dist(b, c) as i128, dist(c, a) as i128);
    (ab * bc * ca / (2 * cr.abs())).min(i64::MAX as i128) as i64
}

/// The tightest curve along a polyline, from its point triples `skip` apart.
pub fn min_radius(path: &[P], skip: usize) -> i64 {
    if path.len() < 2 * skip + 1 {
        return i64::MAX;
    }
    (skip..path.len() - skip).map(|i| radius3(path[i - skip], path[i], path[i + skip])).min().unwrap_or(i64::MAX)
}

pub fn length(path: &[P]) -> i64 {
    path.windows(2).map(|w| dist(w[0], w[1])).sum()
}

/// `path` resampled to equal steps of about `step` cm, both ends kept.
pub fn resample(path: &[P], step: i64) -> Vec<P> {
    if path.len() < 2 {
        return path.to_vec();
    }
    let total = length(path);
    let n = ((total + step / 2) / step).max(1);
    let mut out = Vec::with_capacity(n as usize + 1);
    let (mut seg, mut at) = (0usize, 0i64); // at: distance to the start of path[seg]
    for k in 0..=n {
        let want = total * k / n;
        while seg + 1 < path.len() - 1 && at + dist(path[seg], path[seg + 1]) < want {
            at += dist(path[seg], path[seg + 1]);
            seg += 1;
        }
        let l = dist(path[seg], path[seg + 1]).max(1);
        let t = (want - at).clamp(0, l);
        let (a, b) = (path[seg], path[seg + 1]);
        out.push((a.0 + (b.0 - a.0) * t / l, a.1 + (b.1 - a.1) * t / l));
    }
    out
}

// ---------------------------------------------------------------- the land

const CELL: i64 = 3_200;

struct Grid<T> {
    lo: P,
    n: i64,
    cells: Vec<Vec<T>>,
}

impl<T: Copy> Grid<T> {
    fn new(lo: P, size: i64) -> Self {
        let n = size / CELL + 2;
        Grid { lo, n, cells: vec![Vec::new(); (n * n) as usize] }
    }

    fn cell(&self, q: P) -> (i64, i64) {
        (((q.0 - self.lo.0).div_euclid(CELL)).clamp(0, self.n - 1), ((q.1 - self.lo.1).div_euclid(CELL)).clamp(0, self.n - 1))
    }

    fn add(&mut self, lo: P, hi: P, v: T) {
        let ((i0, j0), (i1, j1)) = (self.cell(lo), self.cell(hi));
        for j in j0..=j1 {
            for i in i0..=i1 {
                self.cells[(j * self.n + i) as usize].push(v);
            }
        }
    }

    fn around(&self, lo: P, hi: P) -> Vec<T>
    where
        T: Ord,
    {
        let ((i0, j0), (i1, j1)) = (self.cell(lo), self.cell(hi));
        let mut out = Vec::new();
        for j in j0..=j1 {
            for i in i0..=i1 {
                out.extend_from_slice(&self.cells[(j * self.n + i) as usize]);
            }
        }
        out.sort();
        out.dedup();
        out
    }
}

fn bbox(poly: &[P]) -> (P, P) {
    poly.iter().fold(((i64::MAX, i64::MAX), (i64::MIN, i64::MIN)), |(lo, hi), p| ((lo.0.min(p.0), lo.1.min(p.1)), (hi.0.max(p.0), hi.1.max(p.1))))
}

/// The lot's footprint (its polygon, else its rectangle).
pub fn lot_poly(l: &Lot) -> Vec<P> {
    match &l.poly {
        Some(p) => pts(p),
        None => vec![(l.x - l.w / 2, l.z - l.d / 2), (l.x + l.w / 2, l.z - l.d / 2), (l.x + l.w / 2, l.z + l.d / 2), (l.x - l.w / 2, l.z + l.d / 2)],
    }
}

pub fn site_poly(s: &Site) -> Vec<P> {
    match &s.poly {
        Some(p) => pts(p),
        None => vec![(s.x - s.w / 2, s.z - s.d / 2), (s.x + s.w / 2, s.z - s.d / 2), (s.x + s.w / 2, s.z + s.d / 2), (s.x - s.w / 2, s.z + s.d / 2)],
    }
}

/// What a footprint stands on: `None` when it may not stand there at all, else the
/// non-hq lot it takes (at most one).
pub type Stand = Option<Option<u32>>;

/// Point and footprint tests over the world's land.
pub struct Land<'a> {
    pub c: &'a Ctx<'a>,
    /// Road centre-line segments: (a, b, half width, half carriageway).
    segs: Vec<(P, P, i64, i64)>,
    seg_grid: Grid<u32>,
    lots: Vec<Vec<P>>,
    lot_grid: Grid<u32>,
    sites: Vec<Vec<P>>,
    site_grid: Grid<u32>,
    water: Vec<(Vec<P>, (P, P))>,
    coast: Option<Vec<P>>,
    /// Footprints taken so far (claims), for the later planners and this one.
    pub taken: Vec<Vec<P>>,
}

impl<'a> Land<'a> {
    pub fn new(c: &'a Ctx<'a>) -> Self {
        let half = c.profile.size_cm / 2 + 4 * CELL;
        let lo = (-half, -half);
        let mut segs = Vec::new();
        let mut seg_grid = Grid::new(lo, 2 * half);
        for e in &c.roads.edges {
            let hw = e.width / 2;
            let hc = (e.width / 2 - e.walk).max(0);
            for w in e.points.windows(2) {
                let (a, b) = ((w[0][0], w[0][2]), (w[1][0], w[1][2]));
                let m = hw + 2_000;
                seg_grid.add((a.0.min(b.0) - m, a.1.min(b.1) - m), (a.0.max(b.0) + m, a.1.max(b.1) + m), segs.len() as u32);
                segs.push((a, b, hw, hc));
            }
        }
        let mut lot_grid = Grid::new(lo, 2 * half);
        let lots: Vec<Vec<P>> = c.lots.iter().map(lot_poly).collect();
        for (k, l) in lots.iter().enumerate() {
            let (a, b) = bbox(l);
            lot_grid.add(a, b, k as u32);
        }
        let sites: Vec<Vec<P>> = c.sites.iter().map(site_poly).collect();
        let mut site_grid = Grid::new(lo, 2 * half);
        for (k, sp) in sites.iter().enumerate() {
            let (a, b) = bbox(sp);
            site_grid.add(a, b, k as u32);
        }
        let water = c.water.iter().map(|w| {
            let p = pts(w);
            let b = bbox(&p);
            (p, b)
        });
        Land {
            c,
            segs,
            seg_grid,
            lots,
            lot_grid,
            sites,
            site_grid,
            water: water.collect(),
            coast: c.coast.map(pts),
            // City Gen v4: the airport's claim (claims.rs) is taken before any line plans
            // and (phase 3) the full roundabouts' circles
            taken: super::claims::Airport::of(c.sites).map_or(Vec::new(), |a| [a.polys, vec![a.corridor]].concat()).into_iter().chain(c.roads.roundabout_circles()).collect(),
        }
    }

    pub fn height(&self, q: P) -> i64 {
        self.c.terrain.height_at(q.0, q.1)
    }

    /// Off the island, or on a water polygon or the river.
    pub fn wet(&self, q: P) -> bool {
        !self.on_island(q) || self.inland_water(q)
    }

    /// Inside the coast (anywhere, with no coast).
    pub fn on_island(&self, q: P) -> bool {
        self.coast.as_ref().is_none_or(|c| inside(q, c))
    }

    /// On the river or a water body (not the sea).
    pub fn inland_water(&self, q: P) -> bool {
        if self.c.river.is_some_and(|r| r.wet(q)) {
            return true;
        }
        self.water.iter().any(|(p, (lo, hi))| q.0 >= lo.0 && q.0 <= hi.0 && q.1 >= lo.1 && q.1 <= hi.1 && inside(q, p))
    }

    /// The distance (cm) from q to the coast (i64::MAX with no coast).
    pub fn to_coast(&self, q: P) -> i64 {
        match &self.coast {
            None => i64::MAX,
            Some(c) => isqrt((0..c.len()).map(|i| nearest_on(q, c[i], c[(i + 1) % c.len()]).1).min().unwrap_or(0)),
        }
    }

    /// Is q at least `margin` cm off every road's full width (carriageway and pavement)?
    pub fn off_roads(&self, q: P, margin: i64) -> bool {
        self.seg_grid.around(q, q).iter().all(|&s| {
            let (a, b, hw, _) = self.segs[s as usize];
            nearest_on(q, a, b).1 >= (hw + margin).pow(2)
        })
    }

    /// Is q off every carriageway (a pavement is fine)?
    pub fn off_carriageways(&self, q: P) -> bool {
        self.seg_grid.around(q, q).iter().all(|&s| {
            let (a, b, _, hc) = self.segs[s as usize];
            nearest_on(q, a, b).1 >= (hc + 50).pow(2)
        })
    }

    /// Is the footprint at least `margin` cm off every road's full width?
    pub fn poly_off_roads(&self, poly: &[P], margin: i64) -> bool {
        let (lo, hi) = bbox(poly);
        let n = poly.len();
        self.seg_grid.around(lo, hi).iter().all(|&s| {
            let (a, b, hw, _) = self.segs[s as usize];
            !inside(a, poly) && (0..n).all(|k| seg_dist2(poly[k], poly[(k + 1) % n], a, b) >= (hw + margin).pow(2))
        })
    }

    /// The lots a footprint meets (indices into `c.lots`).
    pub fn lots_under(&self, poly: &[P]) -> Vec<usize> {
        let (lo, hi) = bbox(poly);
        self.lot_grid.around(lo, hi).into_iter().map(|k| k as usize).filter(|&k| polys_meet(poly, &self.lots[k], 0)).collect()
    }

    /// May a footprint stand here: off the roads (`margin` past their full width), on dry
    /// land `coast_gap` cm in from the coast, clear of the sites and of what is taken, on
    /// no hq lot and on at most one other (none unless `take_lot`)? The lot it takes.
    pub fn stand(&self, poly: &[P], margin: i64, take_lot: bool, coast_gap: i64) -> Stand {
        if !self.poly_off_roads(poly, margin) {
            return None;
        }
        if self.taken.iter().any(|t| polys_meet(poly, t, 100)) {
            return None;
        }
        let (lo, hi) = bbox(poly);
        if self.site_grid.around((lo.0 - 200, lo.1 - 200), (hi.0 + 200, hi.1 + 200)).iter().any(|&k| polys_meet(poly, &self.sites[k as usize], 100)) {
            return None;
        }
        let under = self.lots_under(poly);
        if under.iter().any(|&k| self.c.lots[k].kind == "hq") || under.len() > 1 || (!under.is_empty() && !take_lot) {
            return None;
        }
        let sm = samples(poly);
        if sm.iter().any(|&q| self.wet(q)) {
            return None;
        }
        if coast_gap > 0 && poly.iter().any(|&q| self.to_coast(q) < coast_gap) {
            return None;
        }
        Some(under.first().map(|&k| self.c.lots[k].id))
    }

    /// The steepest grade (per mille) between neighbouring samples 8 m apart over a footprint,
    /// and its highest and lowest ground.
    pub fn relief(&self, poly: &[P]) -> (i64, i64, i64) {
        let sm = samples(poly);
        let hs: Vec<i64> = sm.iter().map(|&q| self.height(q)).collect();
        let (lo, hi) = hs.iter().fold((i64::MAX, i64::MIN), |m, &h| (m.0.min(h), m.1.max(h)));
        let mut steep = 0;
        for (k, &q) in sm.iter().enumerate() {
            let h0 = hs[k];
            for d in [(800, 0), (0, 800)] {
                let h1 = self.height((q.0 + d.0, q.1 + d.1));
                steep = steep.max((h1 - h0).abs() * 1000 / 800);
            }
        }
        (steep, lo, hi)
    }

    /// Is a footprint already taken by a planner's claim?
    pub fn is_taken(&self, poly: &[P]) -> bool {
        self.taken.iter().any(|t| polys_meet(poly, t, 0))
    }
}

/// Open land on an 8 m raster: cells a 6 m square stands on with 2 m to spare (off the
/// roads, the lots, the sites, the water and what was taken when it was made).
pub struct OpenMap {
    half: i64,
    n: i64,
    open: Vec<bool>,
    /// Cells (8 m, city-block distance) to the nearest closed cell.
    clear: Vec<i64>,
}

pub const OPEN_CELL: i64 = 800;

impl OpenMap {
    pub fn new(land: &Land) -> Self {
        let half = land.c.profile.size_cm / 2;
        let n = 2 * half / OPEN_CELL;
        let mut open = vec![false; (n * n) as usize];
        for j in 0..n {
            for i in 0..n {
                let q = (i * OPEN_CELL - half + OPEN_CELL / 2, j * OPEN_CELL - half + OPEN_CELL / 2);
                let sq = [(q.0 - 300, q.1 - 300), (q.0 + 300, q.1 - 300), (q.0 + 300, q.1 + 300), (q.0 - 300, q.1 + 300)];
                open[(j * n + i) as usize] = land.stand(&sq, 200, false, 1_000).is_some();
            }
        }
        let mut clear: Vec<i64> = open.iter().map(|&o| if o { i64::MAX / 4 } else { 0 }).collect();
        let k = |i: i64, j: i64| (j * n + i) as usize;
        for j in 0..n {
            for i in 0..n {
                if i > 0 {
                    clear[k(i, j)] = clear[k(i, j)].min(clear[k(i - 1, j)] + 1);
                }
                if j > 0 {
                    clear[k(i, j)] = clear[k(i, j)].min(clear[k(i, j - 1)] + 1);
                }
            }
        }
        for j in (0..n).rev() {
            for i in (0..n).rev() {
                if i + 1 < n {
                    clear[k(i, j)] = clear[k(i, j)].min(clear[k(i + 1, j)] + 1);
                }
                if j + 1 < n {
                    clear[k(i, j)] = clear[k(i, j)].min(clear[k(i, j + 1)] + 1);
                }
            }
        }
        OpenMap { half, n, open, clear }
    }

    /// Footprints `len` x `w` that stand on open land: (centre, direction index into
    /// DIR16), centres on a lattice of `every` cells, every direction.
    pub fn fits(&self, len: i64, w: i64, every: i64) -> Vec<(P, usize)> {
        let need = (w / 2 + OPEN_CELL - 1) / OPEN_CELL;
        let mut out = Vec::new();
        for j in (0..self.n).step_by(every as usize) {
            for i in (0..self.n).step_by(every as usize) {
                if self.clear[(j * self.n + i) as usize] < need {
                    continue;
                }
                let q = (i * OPEN_CELL - self.half + OPEN_CELL / 2, j * OPEN_CELL - self.half + OPEN_CELL / 2);
                for (k, &d) in DIR16.iter().enumerate() {
                    if self.holds(&pts(&rect(q, d, len, w))) {
                        out.push((q, k));
                    }
                }
            }
        }
        out
    }

    pub fn at(&self, q: P) -> bool {
        let (i, j) = ((q.0 + self.half).div_euclid(OPEN_CELL), (q.1 + self.half).div_euclid(OPEN_CELL));
        i >= 0 && j >= 0 && i < self.n && j < self.n && self.open[(j * self.n + i) as usize]
    }

    /// Is every 6 m lattice point of the footprint (and its corners) on open land?
    pub fn holds(&self, poly: &[P]) -> bool {
        let (lo, hi) = bbox(poly);
        if poly.iter().any(|&q| !self.at(q)) {
            return false;
        }
        let mut z = lo.1;
        while z <= hi.1 {
            let mut x = lo.0;
            while x <= hi.0 {
                if inside((x, z), poly) && !self.at((x, z)) {
                    return false;
                }
                x += 600;
            }
            z += 600;
        }
        true
    }

}

// ---------------------------------------------------------------- the road graph

pub struct Net<'a> {
    pub r: &'a Roads,
    pub adj: Vec<Vec<u32>>,
}

impl<'a> Net<'a> {
    pub fn new(r: &'a Roads) -> Self {
        let mut adj = vec![Vec::new(); r.nodes.len()];
        for e in &r.edges {
            adj[e.a as usize].push(e.id);
            adj[e.b as usize].push(e.id);
        }
        Net { r, adj }
    }

    pub fn pos(&self, n: u32) -> P {
        let n = &self.r.nodes[n as usize];
        (n.x, n.z)
    }

    /// Arterials meeting at n.
    pub fn arterial_degree(&self, n: u32) -> usize {
        self.adj[n as usize].iter().filter(|&&e| self.r.edges[e as usize].class == "arterial").count()
    }

    pub fn degree(&self, n: u32) -> usize {
        self.adj[n as usize].len()
    }

    /// The node nearest q that `ok` keeps (ties to the lower id).
    pub fn nearest(&self, q: P, ok: impl Fn(u32) -> bool) -> Option<u32> {
        (0..self.r.nodes.len() as u32).filter(|&n| ok(n)).min_by_key(|&n| (dist2(self.pos(n), q), n))
    }

    /// The cheapest ways from a to every node: (cost, previous node) per node.
    pub fn tree(&self, a: u32, cost: &impl Fn(&str) -> i64) -> (Vec<i64>, Vec<u32>) {
        let n = self.r.nodes.len();
        let mut d = vec![i64::MAX; n];
        let mut prev = vec![u32::MAX; n];
        let mut heap = BinaryHeap::new();
        d[a as usize] = 0;
        heap.push(Reverse((0i64, a)));
        while let Some(Reverse((dn, u))) = heap.pop() {
            if dn > d[u as usize] {
                continue;
            }
            for &e in &self.adj[u as usize] {
                let edge = &self.r.edges[e as usize];
                let v = if edge.a == u { edge.b } else { edge.a };
                let l: i64 = edge.points.windows(2).map(|w| dist((w[0][0], w[0][2]), (w[1][0], w[1][2]))).sum();
                let nd = dn + l * cost(edge.class) / 1000;
                if nd < d[v as usize] || (nd == d[v as usize] && u < prev[v as usize]) {
                    d[v as usize] = nd;
                    prev[v as usize] = u;
                    heap.push(Reverse((nd, v)));
                }
            }
        }
        (d, prev)
    }

    /// The node path from the tree's root to b (None when b is out of reach).
    pub fn walk(prev: &[u32], d: &[i64], b: u32) -> Option<Vec<u32>> {
        if d[b as usize] == i64::MAX {
            return None;
        }
        let mut out = vec![b];
        while d[*out.last().unwrap() as usize] != 0 {
            out.push(prev[*out.last().unwrap() as usize]);
        }
        out.reverse();
        Some(out)
    }

    /// The cheapest node path from a to b: `cost(class)` per mille of each edge's length.
    pub fn path(&self, a: u32, b: u32, cost: &impl Fn(&str) -> i64) -> Option<Vec<u32>> {
        let n = self.r.nodes.len();
        let mut d = vec![i64::MAX; n];
        let mut prev = vec![u32::MAX; n];
        let mut heap = BinaryHeap::new();
        d[a as usize] = 0;
        heap.push(Reverse((0i64, a)));
        while let Some(Reverse((dn, u))) = heap.pop() {
            if u == b {
                break;
            }
            if dn > d[u as usize] {
                continue;
            }
            for &e in &self.adj[u as usize] {
                let edge = &self.r.edges[e as usize];
                let v = if edge.a == u { edge.b } else { edge.a };
                let l: i64 = edge.points.windows(2).map(|w| dist((w[0][0], w[0][2]), (w[1][0], w[1][2]))).sum();
                let nd = dn + l * cost(edge.class) / 1000;
                if nd < d[v as usize] || (nd == d[v as usize] && u < prev[v as usize]) {
                    d[v as usize] = nd;
                    prev[v as usize] = u;
                    heap.push(Reverse((nd, v)));
                }
            }
        }
        if d[b as usize] == i64::MAX {
            return None;
        }
        let mut out = vec![b];
        while *out.last().unwrap() != a {
            out.push(prev[*out.last().unwrap() as usize]);
        }
        out.reverse();
        Some(out)
    }

    /// The centre line along a node path ([x, z] cm), and for each node of the path the
    /// index of its point.
    pub fn line(&self, nodes: &[u32], cost: &impl Fn(&str) -> i64) -> (Vec<P>, Vec<usize>) {
        let mut out: Vec<P> = Vec::new();
        let mut at = Vec::new();
        if let Some(&n0) = nodes.first() {
            out.push(self.pos(n0));
            at.push(0);
        }
        for w in nodes.windows(2) {
            let e = self.adj[w[0] as usize]
                .iter()
                .map(|&e| &self.r.edges[e as usize])
                .filter(|e| (e.a == w[0] && e.b == w[1]) || (e.b == w[0] && e.a == w[1]))
                .min_by_key(|e| (cost(e.class), e.id));
            match e {
                Some(e) => {
                    let mut p: Vec<P> = e.points.iter().map(|q| (q[0], q[2])).collect();
                    if e.a != w[0] {
                        p.reverse();
                    }
                    out.extend_from_slice(&p[1..]);
                }
                None => out.push(self.pos(w[1])),
            }
            at.push(out.len() - 1);
        }
        (out, at)
    }
}

// ---------------------------------------------------------------- alignment

const FIX: i64 = 64; // smoothing works in 1/64 cm

/// Smooth the free points between two fixed pairs (the platform ends and the points just
/// inside them) until no curve along fixed + free + fixed is tighter than `min_r`; a
/// cubic Hermite between the platform ends when the band cannot get there.
fn smooth(before: [P; 2], free: Vec<P>, after: [P; 2], min_r: i64) -> Vec<P> {
    let all = |f: &[P]| -> Vec<P> {
        let mut v = vec![before[0], before[1]];
        v.extend_from_slice(f);
        v.extend_from_slice(&after);
        v
    };
    let ok = |f: &[P]| min_radius(&all(f), 1) >= min_r && min_radius(&all(f), 2) >= min_r;
    if ok(&free) {
        return free;
    }
    let mut v: Vec<(i64, i64)> = all(&free).iter().map(|p| (p.0 * FIX, p.1 * FIX)).collect();
    let n = v.len();
    for it in 0..6_000 {
        // a Laplacian pass first (fast on wiggles), then bi-Laplacian (keeps the ends' tangents)
        let mut nv = v.clone();
        for i in 2..n - 2 {
            let (a, b, c, d, e) = (v[i - 2], v[i - 1], v[i], v[i + 1], v[i + 2]);
            if it < 200 {
                nv[i] = ((b.0 + 2 * c.0 + d.0) / 4, (b.1 + 2 * c.1 + d.1) / 4);
            } else {
                let fx = -a.0 + 4 * b.0 - 6 * c.0 + 4 * d.0 - e.0;
                let fz = -a.1 + 4 * b.1 - 6 * c.1 + 4 * d.1 - e.1;
                nv[i] = (c.0 + fx / 20, c.1 + fz / 20);
            }
        }
        v = nv;
        if it % 25 == 24 {
            // keep the spacing even: resample the free run between the fixed pairs
            let f: Vec<P> = v.iter().map(|p| (p.0 / FIX, p.1 / FIX)).collect();
            if ok(&f[2..n - 2]) {
                return f[2..n - 2].to_vec();
            }
            let even = resample(&f[1..n - 1], STEP_CM);
            if even.len() == n - 2 {
                for (k, p) in even.iter().enumerate().skip(1).take(n - 4) {
                    v[k + 1] = (p.0 * FIX, p.1 * FIX);
                }
            }
        }
    }
    let f: Vec<P> = v.iter().map(|p| (p.0 / FIX, p.1 / FIX)).collect();
    if ok(&f[2..n - 2]) {
        return f[2..n - 2].to_vec();
    }
    let d0 = unit((before[1].0 - before[0].0, before[1].1 - before[0].1));
    let d1 = unit((after[1].0 - after[0].0, after[1].1 - after[0].1));
    let mut best = f[2..n - 2].to_vec();
    let mut best_r = min_radius(&all(&best), 1).min(min_radius(&all(&best), 2));
    for scale in [1_000, 800, 1_200, 650, 1_500] {
        let h = hermite_scaled(before[1], d0, after[0], d1, scale);
        let r = min_radius(&all(&h), 1).min(min_radius(&all(&h), 2));
        if r > best_r {
            best = h;
            best_r = r;
        }
    }
    if best_r >= min_r {
        return best;
    }
    // the sure way: a Dubins curve, the shortest of a few radii
    let mut sure: Option<(i64, Vec<P>)> = None;
    for r in [min_r + 1_000, 20_000, 25_000] {
        if let Some(mut d) = dubins(before[1], d0, after[0], d1, r) {
            let l = length(&d);
            d.pop(); // after[0] is the caller's
            if min_radius(&all(&d), 1) >= min_r - 500 && sure.as_ref().is_none_or(|s| l < s.0) {
                sure = Some((l, d));
            }
        }
    }
    sure.map_or(best, |s| s.1)
}

/// The free points of a cubic Hermite curve from p0 (heading d0) to p1 (heading d1), the
/// tangents as long as the chord, about `STEP_CM` apart.
pub fn hermite(p0: P, d0: P, p1: P, d1: P) -> Vec<P> {
    hermite_scaled(p0, d0, p1, d1, 1_000)
}

/// `hermite` with the tangents `scale` per mille of the chord.
pub fn hermite_scaled(p0: P, d0: P, p1: P, d1: P, scale: i64) -> Vec<P> {
    let l = dist(p0, p1) as i128;
    let n = ((l as i64 + STEP_CM / 2) / STEP_CM).max(2) as i128;
    let l = l * scale as i128 / 1000;
    let m0 = (d0.0 as i128 * l / ONE as i128, d0.1 as i128 * l / ONE as i128);
    let m1 = (d1.0 as i128 * l / ONE as i128, d1.1 as i128 * l / ONE as i128);
    let n3 = n * n * n;
    (1..n)
        .map(|k| {
            let (t, t2, t3) = (k, k * k, k * k * k);
            // basis * n^3
            let h00 = 2 * t3 - 3 * t2 * n + n3;
            let h10 = t3 - 2 * t2 * n + t * n * n;
            let h01 = -2 * t3 + 3 * t2 * n;
            let h11 = t3 - t2 * n;
            let f = |a: i64, ma: i128, b: i64, mb: i128| ((h00 * a as i128 + h10 * ma + h01 * b as i128 + h11 * mb) / n3) as i64;
            (f(p0.0, m0.0, p1.0, m1.0), f(p0.1, m0.1, p1.1, m1.1))
        })
        .collect()
}

/// Points along the arc of the circle (centre `c`, radius `r`) from `from` to `to`
/// (both on it), turning left (+x toward +z) or right, no two more than `STEP_CM` apart:
/// quarter turns first, then halving each piece through its normalised middle (no trig).
/// `from` left out, `to` kept.
pub fn arc(c: P, r: i64, from: P, to: P, left_turn: bool) -> Vec<P> {
    let rel = |p: P| unit((p.0 - c.0, p.1 - c.1));
    let at = |u: P| ahead(c, u, r);
    let (a, b) = (rel(from), rel(to));
    // within a quarter turn of b, the way we turn?
    let near = |u: P| dot(u, b) >= 0 && if left_turn { cross(u, b) >= 0 } else { cross(u, b) <= 0 };
    let mut keys = vec![a];
    let mut u = a;
    for _ in 0..4 {
        if near(u) && !(keys.len() == 1 && cross(u, b) == 0 && dot(u, b) < 0) {
            break;
        }
        u = if left_turn { left(u) } else { neg(left(u)) };
        keys.push(u);
    }
    keys.push(b);
    let mut out = Vec::new();
    for w in keys.windows(2) {
        let mut piece = vec![w[0], w[1]];
        loop {
            let chord = dist(at(piece[0]), at(piece[1]));
            if chord <= STEP_CM || piece.len() > 64 {
                break;
            }
            let mut next = vec![piece[0]];
            for p in piece.windows(2) {
                let m = (p[0].0 + p[1].0, p[0].1 + p[1].1);
                next.push(if m == (0, 0) { if left_turn { left(p[0]) } else { neg(left(p[0])) } } else { unit(m) });
                next.push(p[1]);
            }
            piece = next;
        }
        out.extend(piece[1..].iter().map(|&u| at(u)));
    }
    if let Some(l) = out.last_mut() {
        *l = to;
    }
    out
}

/// The shortest smooth way (radius `r`) from p0 heading d0 to p1 heading d1: a Dubins
/// curve-straight-curve (LSL, RSR, LSR or RSL), sampled at most `STEP_CM` apart, p0
/// left out and p1 kept exactly. None when no word joins them.
pub fn dubins(p0: P, d0: P, p1: P, d1: P, r: i64) -> Option<Vec<P>> {
    let mut best: Option<(i64, Vec<P>)> = None;
    for (l0, l1) in [(true, true), (false, false), (true, false), (false, true)] {
        let centre = |p: P, d: P, l: bool| ahead(p, left(d), if l { r } else { -r });
        let (c1, c2) = (centre(p0, d0, l0), centre(p1, d1, l1));
        let dd = dist(c1, c2);
        if dd == 0 {
            continue;
        }
        let v = unit((c2.0 - c1.0, c2.1 - c1.1));
        let u = if l0 == l1 {
            v
        } else {
            if dd <= 2 * r {
                continue;
            }
            let lg = isqrt(dd * dd - 4 * r * r);
            let (lv, sgn) = (left(v), if l0 { 1 } else { -1 });
            unit(((lg * v.0 + sgn * 2 * r * lv.0) / dd, (lg * v.1 + sgn * 2 * r * lv.1) / dd))
        };
        // the tangent points: the centre is on the turn's side of the motion
        let tp = |c: P, l: bool| ahead(c, left(u), if l { -r } else { r });
        let (t1, t2) = (tp(c1, l0), tp(c2, l1));
        if dot((t2.0 - t1.0, t2.1 - t1.1), u) < 0 {
            continue;
        }
        let mut out = arc(c1, r, p0, t1, l0);
        if out.is_empty() || *out.last().unwrap() != t1 {
            out.push(t1);
        }
        let run = dist(t1, t2);
        let n = (run + STEP_CM - 1) / STEP_CM;
        for k in 1..n {
            out.push((t1.0 + (t2.0 - t1.0) * k / n, t1.1 + (t2.1 - t1.1) * k / n));
        }
        if t2 != t1 {
            out.push(t2);
        }
        out.extend(arc(c2, r, t2, p1, l1));
        if *out.last().unwrap() != p1 {
            out.push(p1);
        }
        out.dedup();
        let total = length(&out) + dist(p0, out[0]);
        if best.as_ref().is_none_or(|b| total < b.0) {
            best = Some((total, out));
        }
    }
    best.map(|b| b.1)
}

/// A station on an alignment: where it stands and its platform's way (Q16 unit).
#[derive(Clone, Copy, Debug)]
pub struct Stop {
    pub at: P,
    pub along: P,
}

/// Turn each stop's platform (but `fixed`'s) within 45 degrees of its way so the
/// shortest smooth ways (radius `r`) to its neighbours' platforms are shortest: a
/// platform squarely across the line's bend would force a loop.
/// The shortest smooth way's length (radius `r`) from platform a's end to platform b's start.
pub fn seg_len(a: &Stop, b: &Stop, plat: i64, r: i64) -> i64 {
    let (p0, p1) = (ahead(a.at, a.along, plat / 2), ahead(b.at, b.along, -plat / 2));
    dubins(p0, a.along, p1, b.along, r).map_or(i64::MAX / 4, |d| length(&d) + dist(p0, d[0]))
}

/// The ways' lengths to stop k's neighbours.
pub fn around(stops: &[Stop], k: usize, plat: i64, r: i64) -> i64 {
    let mut cost = 0;
    if k > 0 {
        cost += seg_len(&stops[k - 1], &stops[k], plat, r);
    }
    if k + 1 < stops.len() {
        cost += seg_len(&stops[k], &stops[k + 1], plat, r);
    }
    cost
}

pub fn tune(stops: &mut [Stop], fixed: Option<usize>, plat: i64, r: i64) {
    let seg = |a: &Stop, b: &Stop| seg_len(a, b, plat, r);
    for _ in 0..2 {
        for k in 0..stops.len() {
            if Some(k) == fixed {
                continue;
            }
            let base = stops[k].along;
            let mut best = (i64::MAX, base);
            for deg in (-45..=45).step_by(5) {
                let mut s = stops[k];
                s.along = unit(turn(base, deg));
                let mut cost = 0;
                if k > 0 {
                    cost += seg(&stops[k - 1], &s);
                }
                if k + 1 < stops.len() {
                    cost += seg(&s, &stops[k + 1]);
                }
                if cost < best.0 {
                    best = (cost, s.along);
                }
            }
            stops[k].along = best.1;
        }
    }
}

/// The track through `stops` in order: each platform straight (`plat` cm long, centred
/// on its stop, along its way), the run between platforms taken from `guides[k]` (the
/// street centre lines from stop k to stop k+1) and smoothed. Points about `STEP_CM`
/// apart, and the index of each stop's point.
pub fn align(stops: &[Stop], guides: &[Vec<P>], plat: i64) -> (Vec<P>, Vec<usize>) {
    let mut path: Vec<P> = Vec::new();
    let mut at = Vec::new();
    let half = plat / 2;
    let mut n = ((plat + STEP_CM - 1) / STEP_CM).max(2);
    n += n % 2;
    for (k, s) in stops.iter().enumerate() {
        let a = ahead(s.at, s.along, -half);
        if k == 0 {
            path.push(a);
        }
        for j in 1..=n {
            path.push(ahead(a, s.along, plat * j / n));
            if j == n / 2 {
                at.push(path.len() - 1);
            }
        }
        if let Some(t) = stops.get(k + 1) {
            let p0 = *path.last().unwrap();
            let p1 = ahead(t.at, t.along, -half);
            let before = [path[path.len() - 2], p0];
            let after = [p1, ahead(p1, t.along, plat / n)];
            // the guide's run between the two platforms, clear of both
            let g: Vec<P> = guides[k].iter().copied().filter(|&q| dist(q, s.at) > half + 3_000 && dist(q, t.at) > half + 3_000).collect();
            let mut run = vec![p0];
            run.extend(g);
            run.push(p1);
            let run = resample(&run, STEP_CM);
            let free = if run.len() < 4 { hermite(p0, s.along, p1, t.along) } else { run[1..run.len() - 1].to_vec() };
            let sm = smooth(before, free, after, MIN_RADIUS_CM + 500);
            path.extend(sm);
            // the next platform's start: its loop pushes from j = 1
            path.push(p1);
        }
    }
    (path, at)
}
