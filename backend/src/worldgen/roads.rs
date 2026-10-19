//! The road graph: the city's grid (every side of every block), and country
//! roads that leave the city through seeded gates on the world's edge and are
//! joined by a ring. Country roads are routed with A* over the terrain, paying
//! for slope, so they wind round hills instead of going straight up them.
//!
//! Routes are planned on the BASE terrain; heights come from the edited
//! terrain in `seat`. An edit reshapes the ground a road sits on, it never
//! moves the road.

use std::cmp::Reverse;
use std::collections::{BTreeMap, BinaryHeap};

use serde::Serialize;

use super::city::{Block, Grid};
use super::noise::{isqrt, smoothstep, ONE};
use super::profile::Profile;
use super::rng::{sub, Rng};
use super::terrain::Terrain;

#[derive(Serialize, Clone)]
pub struct Node {
    pub id: u32,
    pub x: i64,
    pub y: i64,
    pub z: i64,
}

#[derive(Serialize, Clone)]
pub struct Edge {
    pub id: u32,
    pub a: u32,
    pub b: u32,
    /// "avenue", "street" or "country".
    pub class: &'static str,
    pub width: i64,
    pub name: String,
    /// The centre line, from a to b: [x, y, z] cm.
    pub points: Vec<[i64; 3]>,
}

#[derive(Serialize, Clone)]
pub struct Roads {
    pub nodes: Vec<Node>,
    pub edges: Vec<Edge>,
}

/// Original names, coding-themed (the IP rule: nothing borrowed).
const NAMES: [&str; 72] = [
    "Commit", "Merge", "Rebase", "Branch", "Patch", "Refactor", "Opus", "Sonnet", "Haiku", "Prompt", "Token", "Context",
    "Cache", "Kernel", "Lambda", "Vector", "Tensor", "Socket", "Packet", "Daemon", "Thread", "Mutex", "Async", "Await",
    "Closure", "Compile", "Runtime", "Pixel", "Shader", "Sprite", "Cursor", "Terminal", "Shell", "Script", "Query", "Index",
    "Schema", "Router", "Proxy", "Ticket", "Sprint", "Standup", "Deploy", "Release", "Hotfix", "Linter", "Parser", "Lexer",
    "Binary", "Octal", "Byte", "Nibble", "Stack", "Heap", "Queue", "Graph", "Leaf", "Root", "Trunk", "Fork",
    "Clone", "Push", "Pull", "Fetch", "Stash", "Diff", "Blame", "Bisect", "Sandbox", "Webhook", "Payload", "Uptime",
];

pub fn generate(seed: u64, p: &Profile, base: &Terrain, blocks: &[Block]) -> Result<Roads, String> {
    let g = Grid::new(p);
    let mut rng = Rng::new(sub(seed, "roads", 0, 0));

    // street names: one per grid line, x-lines (running north-south) and z-lines
    let mut names: Vec<&str> = NAMES.to_vec();
    rng.shuffle(&mut names);
    let (mut lines_x, mut lines_z) = (BTreeMap::new(), BTreeMap::new());
    for b in blocks {
        for i in [b.i as i64 - 1, b.i as i64] {
            lines_x.entry(i).or_insert(());
        }
        for j in [b.j as i64 - 1, b.j as i64] {
            lines_z.entry(j).or_insert(());
        }
    }
    if lines_x.len() + lines_z.len() > names.len() {
        return Err(format!("profile {}: more grid lines than street names", p.name));
    }
    let mut it = names.into_iter();
    let name_x: BTreeMap<i64, String> = lines_x.keys().map(|&i| (i, format!("{} {}", it.next().unwrap(), if g.is_avenue(i) { "Avenue" } else { "Street" }))).collect();
    let name_z: BTreeMap<i64, String> = lines_z.keys().map(|&j| (j, format!("{} {}", it.next().unwrap(), if g.is_avenue(j) { "Boulevard" } else { "Road" }))).collect();

    // the grid: a node at every crossing a block touches, an edge along every block side
    let mut node_of: BTreeMap<(i64, i64), u32> = BTreeMap::new();
    for b in blocks {
        for i in [b.i as i64 - 1, b.i as i64] {
            for j in [b.j as i64 - 1, b.j as i64] {
                node_of.entry((j, i)).or_insert(0);
            }
        }
    }
    let mut nodes = Vec::new();
    for (k, ((j, i), id)) in node_of.iter_mut().enumerate() {
        *id = k as u32;
        let (x, z) = (g.line_x(*i), g.line_z(*j));
        nodes.push(Node { id: k as u32, x, y: base.height_at(x, z), z });
    }
    let mut sides: BTreeMap<(u32, u32), (&'static str, i64, String)> = BTreeMap::new();
    for b in blocks {
        let (i, j) = (b.i as i64, b.j as i64);
        for (a, c, line, along_x) in [
            ((j - 1, i - 1), (j - 1, i), j - 1, true),
            ((j, i - 1), (j, i), j, true),
            ((j - 1, i - 1), (j, i - 1), i - 1, false),
            ((j - 1, i), (j, i), i, false),
        ] {
            let (na, nc) = (node_of[&a], node_of[&c]);
            let name = if along_x { name_z[&line].clone() } else { name_x[&line].clone() };
            let class = if g.is_avenue(line) { "avenue" } else { "street" };
            sides.insert((na.min(nc), na.max(nc)), (class, g.width(line), name));
        }
    }
    let mut edges: Vec<Edge> = sides
        .into_iter()
        .map(|((a, b), (class, width, name))| {
            let (na, nb) = (&nodes[a as usize], &nodes[b as usize]);
            Edge { id: 0, a, b, class, width, name, points: vec![[na.x, na.y, na.z], [nb.x, nb.y, nb.z]] }
        })
        .collect();

    // gates: seeded points round the world's edge, a road from the city to each
    let half = (base.n as i64 - 1) * base.cell_cm / 2 - base.cell_cm;
    let perim = 8 * half;
    let step = perim / p.gates;
    let start = rng.range(0, step - 1);
    let mut junctions = Vec::new();
    for k in 0..p.gates {
        let t = (start + k * step + rng.range(-step / 5, step / 5)).rem_euclid(perim);
        let (side, off) = (t / (2 * half), t % (2 * half) - half);
        let (gx, gz) = match side {
            0 => (off, -half),
            1 => (half, off),
            2 => (-off, half),
            _ => (-half, -off),
        };
        let from = nodes.iter().take(node_of.len()).min_by_key(|n| ((n.x - gx).pow(2) + (n.z - gz).pow(2), n.id)).unwrap().id;
        let (fx, fz) = (nodes[from as usize].x, nodes[from as usize].z);
        let path = route(base, p, (fx, fz), (gx, gz), p.city_r_cm)
            .ok_or_else(|| format!("no country road from the city to gate {k}"))?;
        // split where the road crosses the ring's radius: the ring joins there
        let cut = (1..path.len() - 1)
            .min_by_key(|&q| ((isqrt(path[q].0.pow(2) + path[q].1.pow(2)) - p.ring_r_cm).abs(), q))
            .unwrap_or(path.len() / 2);
        let jn = push_node(&mut nodes, base, path[cut]);
        let gate = push_node(&mut nodes, base, (gx, gz));
        let name = format!("{} Way", NAMES[(rng.range(0, NAMES.len() as i64 - 1)) as usize]);
        edges.push(country(from, jn, &path[..=cut], &name));
        edges.push(country(jn, gate, &path[cut..], &name));
        junctions.push(jn);
    }
    // the ring: each junction to the next, round the city
    let n = junctions.len();
    for k in 0..n {
        let (a, b) = (junctions[k], junctions[(k + 1) % n]);
        let (pa, pb) = ((nodes[a as usize].x, nodes[a as usize].z), (nodes[b as usize].x, nodes[b as usize].z));
        let path = route(base, p, pa, pb, p.ring_r_cm * 4 / 5).ok_or_else(|| format!("no ring road from junction {k}"))?;
        edges.push(country(a, b, &path, &format!("Ring Road {}", k + 1)));
    }

    for (k, e) in edges.iter_mut().enumerate() {
        e.id = k as u32;
    }
    Ok(Roads { nodes, edges })
}

fn push_node(nodes: &mut Vec<Node>, t: &Terrain, (x, z): (i64, i64)) -> u32 {
    let id = nodes.len() as u32;
    nodes.push(Node { id, x, y: t.height_at(x, z), z });
    id
}

fn country(a: u32, b: u32, path: &[(i64, i64)], name: &str) -> Edge {
    Edge { id: 0, a, b, class: "country", width: 700, name: name.to_string(), points: path.iter().map(|&(x, z)| [x, 0, z]).collect() }
}

/// How far either side of a country road's edge the land is blended into it (cm).
const SHOULDER_CM: i64 = 400;

impl Roads {
    /// Heights from (possibly edited) terrain. City roads lie on the ground (the
    /// plateau keeps them gentle). A country road is GRADED: the profile closest to
    /// the land that never exceeds its class's grade, pinned to its nodes at both
    /// ends -- cut into hills and filled over dips, as a real road is built. A road
    /// that cannot be graded at all is an error (and so is an edit that causes one).
    pub fn seat(&mut self, t: &Terrain, p: &Profile) -> Result<(), String> {
        for n in &mut self.nodes {
            n.y = t.height_at(n.x, n.z);
        }
        for e in &mut self.edges {
            let len = e.points.len();
            let (ya, yb) = (self.nodes[e.a as usize].y, self.nodes[e.b as usize].y);
            let raw: Vec<i64> = e.points.iter().map(|q| t.height_at(q[0], q[2])).collect();
            if e.class != "country" {
                for (q, pt) in e.points.iter_mut().enumerate() {
                    pt[1] = raw[q];
                }
            } else {
                let g = p.country_grade_pm;
                // distance along the road to each point
                let mut at = vec![0i64; len];
                for q in 1..len {
                    let (a, b) = (e.points[q - 1], e.points[q]);
                    at[q] = at[q - 1] + isqrt((b[0] - a[0]).pow(2) + (b[2] - a[2]).pow(2));
                }
                let total = at[len - 1];
                // the land, lightly smoothed: a road follows the lie of the land, not every bump
                let smooth: Vec<i64> = (0..len)
                    .map(|q| {
                        let (lo, hi) = (q.saturating_sub(2), (q + 2).min(len - 1));
                        raw[lo..=hi].iter().sum::<i64>() / (hi - lo + 1) as i64
                    })
                    .collect();
                // the band every point must stay in to reach both pinned ends at the grade:
                // g-Lipschitz bounds, so a step-by-step clamp inside them always arrives at yb
                let mut y = vec![ya; len];
                for q in 1..len {
                    let (from_a, to_b) = (at[q] * g / 1000, (total - at[q]) * g / 1000);
                    let lo = (ya - from_a).max(yb - to_b);
                    let hi = (ya + from_a).min(yb + to_b);
                    if lo > hi {
                        return Err(format!("{} cannot be graded: it climbs {} m in {} m", e.name, (yb - ya).abs() / 100, total / 100));
                    }
                    let step = (at[q] - at[q - 1]) * g / 1000;
                    let (lo, hi) = (lo.max(y[q - 1] - step), hi.min(y[q - 1] + step));
                    y[q] = smooth[q].clamp(lo, hi);
                }
                for (q, pt) in e.points.iter_mut().enumerate() {
                    pt[1] = y[q];
                }
            }
            e.points[0][1] = ya;
            e.points[len - 1][1] = yb;
        }
        Ok(())
    }

    /// Cut and fill: bring the land under every country road to the road's height,
    /// blending over a shoulder either side, so the ground under a road IS the road.
    pub fn carve(&self, t: &mut Terrain) {
        for e in self.edges.iter().filter(|e| e.class == "country") {
            let reach = e.width / 2 + SHOULDER_CM;
            for q in e.points.windows(2) {
                let (a, b) = (q[0], q[1]);
                let (lo, hi) = (t.vertex_of(a[0].min(b[0]) - reach, a[2].min(b[2]) - reach), t.vertex_of(a[0].max(b[0]) + reach, a[2].max(b[2]) + reach));
                let (dx, dz) = (b[0] - a[0], b[2] - a[2]);
                let l2 = (dx * dx + dz * dz).max(1);
                for iz in lo.1..=hi.1 {
                    for ix in lo.0..=hi.0 {
                        let (vx, vz) = t.vertex_pos(ix, iz);
                        // nearest point on the segment, as a fraction (Q16) along it
                        let f = (((vx - a[0]) * dx + (vz - a[2]) * dz) * ONE / l2).clamp(0, ONE);
                        let (px, pz) = (a[0] + dx * f / ONE, a[2] + dz * f / ONE);
                        let d = isqrt((vx - px).pow(2) + (vz - pz).pow(2));
                        if d > reach {
                            continue;
                        }
                        let road_y = a[1] + (b[1] - a[1]) * f / ONE;
                        let w = if d <= e.width / 2 { ONE } else { smoothstep(ONE - (d - e.width / 2) * ONE / SHOULDER_CM) };
                        let k = iz * t.n + ix;
                        let h = t.heights[k] as i64;
                        t.heights[k] = (h + (road_y - h) * w / ONE) as i32;
                    }
                }
            }
        }
    }
}

/// A* over the terrain's vertices from `a` to `b` (cm), paying for length and
/// slope, avoiding the inside of `avoid_r` (the city, or the ring's inside).
/// Returns the path's points, `a` and `b` exact.
fn route(t: &Terrain, p: &Profile, a: (i64, i64), b: (i64, i64), avoid_r: i64) -> Option<Vec<(i64, i64)>> {
    let n = t.n;
    let (s, g) = (t.vertex_of(a.0, a.1), t.vertex_of(b.0, b.1));
    let idx = |v: (usize, usize)| v.1 * n + v.0;
    let h = |v: (usize, usize)| t.heights[idx(v)] as i64;
    let cell = t.cell_cm;
    let heur = |v: (usize, usize)| {
        let (dx, dz) = ((v.0 as i64 - g.0 as i64).abs(), (v.1 as i64 - g.1 as i64).abs());
        (dx.max(dz) * 1000 + dx.min(dz) * 414) * cell / 1000
    };
    let mut best = vec![i64::MAX; n * n];
    let mut from = vec![usize::MAX; n * n];
    let mut open = BinaryHeap::new();
    best[idx(s)] = 0;
    open.push(Reverse((heur(s), idx(s))));
    while let Some(Reverse((_, u))) = open.pop() {
        if u == idx(g) {
            break;
        }
        let (ux, uz) = (u % n, u / n);
        for (dx, dz) in [(-1i64, -1i64), (0, -1), (1, -1), (-1, 0), (1, 0), (-1, 1), (0, 1), (1, 1)] {
            let (vx, vz) = (ux as i64 + dx, uz as i64 + dz);
            if vx < 0 || vz < 0 || vx >= n as i64 || vz >= n as i64 {
                continue;
            }
            let v = (vx as usize, vz as usize);
            let len = if dx != 0 && dz != 0 { cell * 1414 / 1000 } else { cell };
            let grade = (h(v) - h((ux, uz))).abs() * 1000 / len;
            let (wx, wz) = t.vertex_pos(v.0, v.1);
            let inside = wx * wx + wz * wz < avoid_r * avoid_r;
            let mut step = len * (1000 + 25 * grade) / 1000;
            if grade > p.country_grade_pm {
                step += len * 50;
            }
            if inside {
                step += len * 20;
            }
            let c = best[u] + step;
            let vi = idx(v);
            if c < best[vi] {
                best[vi] = c;
                from[vi] = u;
                open.push(Reverse((c + heur(v), vi)));
            }
        }
    }
    if best[idx(g)] == i64::MAX {
        return None;
    }
    let mut cells = vec![idx(g)];
    while *cells.last().unwrap() != idx(s) {
        cells.push(from[*cells.last().unwrap()]);
    }
    cells.reverse();
    // every vertex (8 m apart), so the road's height profile follows the land; the ends exact
    let mut pts = vec![a];
    if cells.len() > 2 {
        pts.extend(cells[1..cells.len() - 1].iter().map(|&c| t.vertex_pos(c % n, c / n)));
    }
    pts.push(b);
    Some(pts)
}
