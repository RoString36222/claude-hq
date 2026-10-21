//! The road graph: the city's grid (every side of every block), and graded
//! roads outside it: a highway from the city out through each seeded gate on the
//! world's edge, and a ring road joining the highways round the city. Graded
//! roads are routed with A* over the terrain, paying for slope, so they wind
//! round hills instead of going straight up them.
//!
//! Routes are planned on the BASE terrain; heights come from the edited
//! terrain in `seat`. An edit reshapes the ground a road sits on, it never
//! moves the road.
//!
//! Where a road crosses a river (river.rs) it does so on a bridge: an edge straight
//! from bank to bank, level a metre over the higher bank, the city streets that meet
//! it ramping up to its deck. A graded road's run over the river and its bank is
//! replaced by one.

use std::cmp::Reverse;
use std::collections::{BTreeMap, BTreeSet, BinaryHeap};

use serde::Serialize;

use super::city::{Block, Grid};
use super::noise::{isqrt, smoothstep, ONE};
use super::profile::Profile;
use super::river::River;
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
    /// "street" or "avenue" (the city grid), "highway" (city to a gate) or "ring"
    /// (round the city, joining the highways). Highways and the ring are graded.
    pub class: &'static str,
    /// Full width (cm), sidewalks included.
    pub width: i64,
    /// Sidewalk width (cm) each side, taken out of `width` (0 on graded roads).
    pub walk: i64,
    /// Lanes per direction.
    pub lanes: u8,
    /// Route number: "H1".."H<gates>" on a gate's highway, "R1" on the ring, else none.
    #[serde(rename = "ref")]
    pub route: Option<String>,
    pub name: String,
    /// The centre line, from a to b: [x, y, z] cm. City edges are resampled into
    /// equal steps of at most `STEP_CM`; graded edges have a point per terrain vertex.
    pub points: Vec<[i64; 3]>,
    /// Island worlds: the city tier the road appears at.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_tier: Option<u8>,
    /// Some(true) on a bridge over a river: straight, and level across.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bridge: Option<bool>,
    /// Version 2: Some("dirt") on an outskirts track (shape.rs); a paved road has none.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub surface: Option<&'static str>,
    /// Version 2, a dirt road only: the track drawn inside its corridor ([x, z] cm, a to b), which wanders
    /// within it (shape.rs); `points` stays the corridor's centre line.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub track: Option<Vec<[i64; 2]>>,
}

#[derive(Serialize, Clone)]
pub struct Roads {
    pub nodes: Vec<Node>,
    pub edges: Vec<Edge>,
}

/// Longest step (cm) between consecutive points of a city edge: the terrain's spacing.
pub const STEP_CM: i64 = 800;

/// Highways and the ring are graded (cut and filled to `country_grade_pm`).
pub fn is_graded(class: &str) -> bool {
    matches!(class, "highway" | "ring")
}

/// Original names, coding-themed (the IP rule: nothing borrowed).
pub const NAMES: [&str; 72] = [
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

    // street names: one per grid line, x-lines (running north-south) and z-lines;
    // the highways draw theirs from the rest of the same shuffle, so no name repeats
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
    if lines_x.len() + lines_z.len() + p.gates as usize > names.len() {
        return Err(format!("profile {}: more grid lines and gates than street names", p.name));
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
            let walk = if class == "avenue" { p.avenue_walk_cm } else { p.street_walk_cm };
            Edge { id: 0, a, b, class, width, walk, lanes: 1, route: None, name, points: resample((na.x, na.z), (nb.x, nb.z)), min_tier: None, bridge: None, surface: None, track: None }
        })
        .collect();
    graded(&mut rng, p, base, blocks, &mut nodes, &mut edges, &mut it, None)?;
    Ok(Roads { nodes, edges })
}

/// The graded roads round a city whose `nodes` and street `edges` are laid: a
/// highway from the city node nearest each seeded gate out to it, and the ring
/// joining the highways. Appends them (split into junctions where they meet) and
/// numbers every edge. `names` gives each highway its name. No gates, no roads. A
/// road crosses the `river` (if any) quickly, on a bridge.
#[allow(clippy::too_many_arguments)] // the city the roads join, and the river they cross
pub fn graded<'a>(
    rng: &mut Rng,
    p: &Profile,
    base: &Terrain,
    blocks: &[Block],
    nodes: &mut Vec<Node>,
    edges: &mut Vec<Edge>,
    it: &mut impl Iterator<Item = &'a str>,
    river: Option<&River>,
) -> Result<(), String> {
    if p.gates == 0 {
        for (k, e) in edges.iter_mut().enumerate() {
            e.id = k as u32;
        }
        return Ok(());
    }
    let city_nodes = nodes.len();

    // gates: seeded points round the world's edge, a highway from the city to each
    let half = (base.n as i64 - 1) * base.cell_cm / 2 - base.cell_cm;
    let perim = 8 * half;
    let step = perim / p.gates;
    let start = rng.range(0, step - 1);
    let mut gates = Vec::new();
    for k in 0..p.gates {
        let t = (start + k * step + rng.range(-step / 5, step / 5)).rem_euclid(perim);
        let (side, off) = (t / (2 * half), t % (2 * half) - half);
        gates.push(match side {
            0 => (off, -half),
            1 => (half, off),
            2 => (-off, half),
            _ => (-half, -off),
        });
    }
    // route numbers go round the compass: gate 1 is the first clockwise from -z (atan2(x, z) from -PI)
    let mut order: Vec<usize> = (0..gates.len()).collect();
    order.sort_by(|&a, &b| gate_order(gates[a], gates[b]));
    let mut number = vec![0usize; gates.len()];
    for (r, &k) in order.iter().enumerate() {
        number[k] = r + 1;
    }

    // the blocks and streets: graded roads keep their full width off them
    let keep = Keep::new(base, blocks, edges, p.highway_cm.max(p.ring_cm) / 2);
    let mut graded: Vec<Edge> = Vec::new();
    let mut junctions = Vec::new();
    // the highways laid so far: a highway that would touch one pays for every point it
    // shares, so two highways cross (a junction) but never run along each other
    let mut laid = Taken::default();
    for (k, &(gx, gz)) in gates.iter().enumerate() {
        let from = nodes.iter().take(city_nodes).min_by_key(|n| ((n.x - gx).pow(2) + (n.z - gz).pow(2), n.id)).unwrap().id;
        let (fx, fz) = (nodes[from as usize].x, nodes[from as usize].z);
        let mut path = route(base, p, (fx, fz), (gx, gz), p.city_r_cm, i64::MAX, &keep, &[], true, river);
        if path.as_ref().is_some_and(|q| (1..q.len()).any(|i| laid.hits(q[i - 1], q[i], i + 1 == q.len()))) {
            path = route(base, p, (fx, fz), (gx, gz), p.city_r_cm, i64::MAX, &keep, std::slice::from_ref(&laid), true, river);
        }
        let path = path.ok_or_else(|| format!("no highway from the city to gate {k}"))?;
        laid.add(&path, base);
        // split where the road crosses the ring's radius: the ring joins there. Never at
        // or beside a spike (a point whose neighbours on the road are adjacent): the road
        // wraps round it, so the ring could only leave along or across the road. Never
        // within a cell of another junction either (the ring between them would be a stub)
        let cheb = |u: (i64, i64), v: (i64, i64)| (u.0 - v.0).abs().max((u.1 - v.1).abs());
        let spike = |q: usize| q > 0 && q + 1 < path.len() && cheb(path[q - 1], path[q + 1]) <= base.cell_cm;
        let crowded = |q: usize| junctions.iter().any(|&j: &u32| cheb(path[q], (nodes[j as usize].x, nodes[j as usize].z)) < 2 * base.cell_cm);
        let wet = |q: usize| river.is_some_and(|r| r.zone(path[q]));
        let cut = (1..path.len() - 1)
            .filter(|&q| !(q - 1..=q + 1).any(spike) && !crowded(q) && !wet(q))
            .min_by_key(|&q| ((isqrt(path[q].0.pow(2) + path[q].1.pow(2)) - p.ring_r_cm).abs(), q))
            .unwrap_or(path.len() / 2);
        let jn = push_node(nodes, base, path[cut]);
        let gate = push_node(nodes, base, (gx, gz));
        let name = format!("{} Way", it.next().unwrap());
        let route_ref = Some(format!("H{}", number[k]));
        for (a, b, part) in [(from, jn, &path[..=cut]), (jn, gate, &path[cut..])] {
            graded.push(Edge { route: route_ref.clone(), ..graded_edge(a, b, part, &name, "highway", p.highway_cm) });
        }
        junctions.push(jn);
    }
    // the ring: each junction to the next, round the city, meeting the roads already
    // laid only at its two junctions: it may not step onto their points or cross their
    // diagonal steps (a stub or a split one cell from a junction is no junction). If
    // that leaves no way through it pays for the highways (never crossing itself), and
    // only then for itself too; `split_contacts` makes junctions where it meets them.
    let mut ring = Taken::default();
    let n = junctions.len();
    // on an island the ring keeps 15 m and its half width inside the coast's nearest reach
    let out_r = super::island::lo_of(p).map_or(i64::MAX, |lo| lo - 1_500 - p.ring_cm / 2);
    for k in 0..n {
        let (a, b) = (junctions[k], junctions[(k + 1) % n]);
        let (pa, pb) = ((nodes[a as usize].x, nodes[a as usize].z), (nodes[b as usize].x, nodes[b as usize].z));
        let forbid = |t: &Taken, f: bool| Taken { forbid: f, ..t.clone() };
        let path = [(true, true), (false, true), (false, false)]
            .into_iter()
            .find_map(|(h, r)| route(base, p, pa, pb, p.ring_r_cm * 4 / 5, out_r, &keep, &[forbid(&laid, h), forbid(&ring, r)], false, river))
            .ok_or_else(|| format!("no ring road from junction {k}"))?;
        ring.add(&path, base);
        graded.push(Edge { route: Some("R1".to_string()), ..graded_edge(a, b, &path, &format!("Ring Road {}", k + 1), "ring", p.ring_cm) });
    }
    let graded = split_contacts(nodes, base, graded)?;
    edges.extend(match river {
        Some(r) => bridged(nodes, base, graded, r),
        None => graded,
    });

    for (k, e) in edges.iter_mut().enumerate() {
        e.id = k as u32;
    }
    Ok(())
}

/// The gates' compass order from integers only (no trig): the angle atan2(x, z)
/// ascending from -PI. The half-plane x < 0 (and the -z axis) first, then by the
/// cross product within a half-plane.
fn gate_order(a: (i64, i64), b: (i64, i64)) -> std::cmp::Ordering {
    let west = |(x, z): (i64, i64)| x < 0 || (x == 0 && z < 0);
    west(b).cmp(&west(a)).then_with(|| (a.0 * b.1 - a.1 * b.0).cmp(&0)).then_with(|| a.cmp(&b))
}

/// A straight city edge from `a` to `b` in `n = ceil(len / STEP_CM)` equal steps
/// (truncating division, so steps differ by at most 1 cm). Heights come in `seat`.
pub fn resample(a: (i64, i64), b: (i64, i64)) -> Vec<[i64; 3]> {
    let (dx, dz) = (b.0 - a.0, b.1 - a.1);
    let n = ((isqrt(dx * dx + dz * dz) + STEP_CM - 1) / STEP_CM).max(1);
    (0..=n).map(|i| [a.0 + dx * i / n, 0, a.1 + dz * i / n]).collect()
}

fn push_node(nodes: &mut Vec<Node>, t: &Terrain, (x, z): (i64, i64)) -> u32 {
    let id = nodes.len() as u32;
    nodes.push(Node { id, x, y: t.height_at(x, z), z });
    id
}

fn graded_edge(a: u32, b: u32, path: &[(i64, i64)], name: &str, class: &'static str, width: i64) -> Edge {
    Edge {
        id: 0, a, b, class, width, walk: 0, lanes: 1, route: None, name: name.to_string(), points: path.iter().map(|&(x, z)| [x, 0, z]).collect(),
        min_tier: None, bridge: None,
        surface: None,
        track: None,
    }
}

/// Bridge the graded roads over the river: each run of a road's points on the river or
/// its bank whose straight line crosses the water becomes a bridge, straight from the
/// last point before it to the first after it (a node at each). A run reaching an end of
/// its road (a tail out to sea, which `island::trim` drops) is left.
fn bridged(nodes: &mut Vec<Node>, t: &Terrain, paths: Vec<Edge>, river: &River) -> Vec<Edge> {
    let mut out = Vec::new();
    for e in paths {
        let mut rest = e;
        let mut from = 0;
        loop {
            let at = |k: usize| (rest.points[k][0], rest.points[k][2]);
            let last = rest.points.len() - 1;
            let Some(i) = (from..=last).find(|&k| river.zone(at(k))) else { break };
            let Some(j) = (i..=last).find(|&k| !river.zone(at(k))) else { break };
            if i == 0 || !(river.water.crosses(at(i - 1), at(j)) || river.wet(lerp2(at(i - 1), at(j)))) {
                from = j;
                continue;
            }
            let (pa, pb) = (at(i - 1), at(j));
            let na = if i - 1 == 0 { rest.a } else { push_node(nodes, t, pa) };
            let nb = if j == last { rest.b } else { push_node(nodes, t, pb) };
            if i - 1 > 0 {
                out.push(Edge { b: na, points: rest.points[..i].to_vec(), ..rest.clone() });
            }
            out.push(Edge { a: na, b: nb, points: resample(pa, pb), bridge: Some(true), ..rest.clone() });
            if j == last {
                rest.points.clear();
                break;
            }
            rest = Edge { a: nb, points: rest.points[j..].to_vec(), ..rest };
            from = 0;
        }
        if !rest.points.is_empty() {
            out.push(rest);
        }
    }
    out
}

/// The midpoint of ab.
fn lerp2(a: (i64, i64), b: (i64, i64)) -> (i64, i64) {
    ((a.0 + b.0) / 2, (a.1 + b.1) / 2)
}

/// Where two graded roads meet.
enum Contact {
    /// Path p's point i is path q's point j (q > p).
    Vertex(usize, usize, usize, usize),
    /// Path p's diagonal step i -> i+1 crosses path q's step j -> j+1 inside one terrain cell.
    Cross(usize, usize, usize, usize),
}

/// Turn every place two graded roads meet into a junction node, splitting both
/// there, so roads only ever meet at nodes. A crossing of two diagonal steps gets
/// the cell's exact centre as a shared point first. Where two roads share a run of
/// points, the run is kept once (by the earlier road: highways come before the
/// ring) with a junction at each end; a single shared step from the later road's end
/// node is skipped instead (no junction one cell from a node). Nodes are appended.
fn split_contacts(nodes: &mut Vec<Node>, t: &Terrain, mut paths: Vec<Edge>) -> Result<Vec<Edge>, String> {
    let cell = t.cell_cm;
    for _ in 0..10_000 {
        let Some(c) = first_contact(&paths, cell) else {
            return Ok(paths);
        };
        match c {
            Contact::Cross(p, i, q, j) => {
                let (a, b) = (paths[p].points[i], paths[p].points[i + 1]);
                let mid = [a[0].min(b[0]) + cell / 2, 0, a[2].min(b[2]) + cell / 2];
                paths[q].points.insert(j + 1, mid);
                paths[p].points.insert(i + 1, mid);
            }
            Contact::Vertex(p, i, q, j) => {
                let at = |e: &Edge, k: usize| (e.points[k][0], e.points[k][2]);
                // the shared run through (i, j): q runs the same way (d = 1) or the other way (d = -1)
                let (lp, lq) = (paths[p].points.len() as i64, paths[q].points.len() as i64);
                let same = |k: i64, d: i64| {
                    let (ik, jk) = (i as i64 + k, j as i64 + k * d);
                    (0..lp).contains(&ik) && (0..lq).contains(&jk) && at(&paths[p], ik as usize) == at(&paths[q], jk as usize)
                };
                let d = if same(1, 1) || same(-1, 1) { 1 } else { -1 };
                let (mut lo, mut hi) = (0i64, 0i64);
                while same(lo - 1, d) {
                    lo -= 1;
                }
                while same(hi + 1, d) {
                    hi += 1;
                }
                let (i0, i1) = ((i as i64 + lo) as usize, (i as i64 + hi) as usize);
                let (j0, j1) = ((j as i64 + lo * d) as usize, (j as i64 + hi * d) as usize);
                // one step shared from q's end node: snap to that node (q skips the step) instead
                // of a junction one cell away from it
                let q_end = |k: usize| k == 0 || k as i64 + 1 == lq;
                let snap = hi - lo == 1 && q_end(j0) != q_end(j1) && {
                    // q's new step (its node straight to the point after the shared one) must
                    // touch p's steps either side of the shared point only at the node
                    let (ip, iv, jn, jv) = if q_end(j0) { (i0, i1, j0, j1) } else { (i1, i0, j1, j0) };
                    let (pp, qq) = (&paths[p], &paths[q]);
                    let (n, w) = (at(qq, jn), at(qq, if jv > jn { jv + 1 } else { jv - 1 }));
                    let beyond = if iv > ip { iv + 1 } else { iv.wrapping_sub(1) };
                    let clear_of = |k: usize| pp.points.get(k).is_none_or(|_| !segments_touch(n, w, at(pp, iv), at(pp, k)));
                    clear_of(beyond) && {
                        let (v, d) = (at(pp, iv), (w.0 - n.0, w.1 - n.1));
                        (v.0 - n.0) as i128 * d.1 as i128 - (v.1 - n.1) as i128 * d.0 as i128 != 0
                    }
                };
                if snap {
                    let (ip, jn, jv) = if q_end(j0) { (i0, j0, j1) } else { (i1, j1, j0) };
                    let n = node_for(nodes, t, &paths[p], ip, &paths[q], jn)?;
                    paths[q].points.remove(jv);
                    let ppieces = cut(&paths[p], &[(ip, n)], None);
                    paths.splice(p..=p, ppieces);
                    continue;
                }
                let n0 = node_for(nodes, t, &paths[p], i0, &paths[q], j0)?;
                let n1 = if i1 == i0 { n0 } else { node_for(nodes, t, &paths[p], i1, &paths[q], j1)? };
                let (qs, qe) = (j0.min(j1), j0.max(j1));
                let (nqs, nqe) = if j0 <= j1 { (n0, n1) } else { (n1, n0) };
                // q (the later road) drops its copy of a shared run; a single point is no run
                let qpieces = cut(&paths[q], &[(qs, nqs), (qe, nqe)], if qs < qe { Some(qs) } else { None });
                let ppieces = cut(&paths[p], &[(i0, n0), (i1, n1)], None);
                paths.splice(q..=q, qpieces);
                paths.splice(p..=p, ppieces);
            }
        }
    }
    Err("graded roads: too many contacts to resolve".into())
}

/// The earliest contact in (path, point) order, if any.
fn first_contact(paths: &[Edge], cell: i64) -> Option<Contact> {
    // a step corner to corner across one terrain cell: (the cell, which diagonal)
    let diagonal = |q: &[i64; 3], r: &[i64; 3]| {
        let (dx, dz) = (r[0] - q[0], r[2] - q[2]);
        (dx.abs() == cell && dz.abs() == cell).then(|| ((q[0].min(r[0]), q[2].min(r[2])), (dx > 0) == (dz > 0)))
    };
    let mut at: BTreeMap<(i64, i64), Vec<(usize, usize)>> = BTreeMap::new();
    let mut diag: BTreeMap<(i64, i64), Vec<(usize, usize, bool)>> = BTreeMap::new();
    for (p, e) in paths.iter().enumerate() {
        for (i, q) in e.points.iter().enumerate() {
            at.entry((q[0], q[2])).or_default().push((p, i));
            if let Some((c, d)) = e.points.get(i + 1).and_then(|r| diagonal(q, r)) {
                diag.entry(c).or_default().push((p, i, d));
            }
        }
    }
    let end = |e: &Edge, i: usize| i == 0 || i + 1 == e.points.len();
    for (p, e) in paths.iter().enumerate() {
        for (i, q) in e.points.iter().enumerate() {
            for &(o, j) in &at[&(q[0], q[2])] {
                // two roads ending at the same node already meet properly
                if o != p && !(end(e, i) && end(&paths[o], j)) {
                    return Some(Contact::Vertex(p.min(o), if o > p { i } else { j }, p.max(o), if o > p { j } else { i }));
                }
            }
            if let Some((c, mine)) = e.points.get(i + 1).and_then(|r| diagonal(q, r)) {
                if let Some(&(o, j, _)) = diag[&c].iter().find(|&&(o, _, d)| o != p && d != mine) {
                    return Some(Contact::Cross(p.min(o), if o > p { i } else { j }, p.max(o), if o > p { j } else { i }));
                }
            }
        }
    }
    None
}

/// Do segments ab and cd (x, z) share any point? Integer orientation tests.
pub fn segments_touch(a: (i64, i64), b: (i64, i64), c: (i64, i64), d: (i64, i64)) -> bool {
    let orient = |p: (i64, i64), q: (i64, i64), r: (i64, i64)| ((q.0 - p.0) as i128 * (r.1 - p.1) as i128 - (q.1 - p.1) as i128 * (r.0 - p.0) as i128).signum();
    let within = |p: (i64, i64), q: (i64, i64), r: (i64, i64)| r.0 >= p.0.min(q.0) && r.0 <= p.0.max(q.0) && r.1 >= p.1.min(q.1) && r.1 <= p.1.max(q.1);
    if a.0.max(b.0) < c.0.min(d.0) || c.0.max(d.0) < a.0.min(b.0) || a.1.max(b.1) < c.1.min(d.1) || c.1.max(d.1) < a.1.min(b.1) {
        return false;
    }
    let (o1, o2, o3, o4) = (orient(a, b, c), orient(a, b, d), orient(c, d, a), orient(c, d, b));
    (o1 * o2 < 0 && o3 * o4 < 0)
        || (o1 == 0 && within(a, b, c))
        || (o2 == 0 && within(a, b, d))
        || (o3 == 0 && within(c, d, a))
        || (o4 == 0 && within(c, d, b))
}

/// The node at point i of p (= point j of q): an end's node if either has one, else a new node.
fn node_for(nodes: &mut Vec<Node>, t: &Terrain, p: &Edge, i: usize, q: &Edge, j: usize) -> Result<u32, String> {
    let end = |e: &Edge, k: usize| if k == 0 { Some(e.a) } else if k + 1 == e.points.len() { Some(e.b) } else { None };
    match (end(p, i), end(q, j)) {
        (Some(a), Some(b)) if a != b => Err(format!("{} and {} end at the same point on different nodes", p.name, q.name)),
        (Some(a), _) | (_, Some(a)) => Ok(a),
        (None, None) => Ok(push_node(nodes, t, (p.points[i][0], p.points[i][2]))),
    }
}

/// Split `e` at the given (point, node) cuts (an end is no cut, so no piece is
/// ever empty), leaving out the piece that starts at point `drop`.
fn cut(e: &Edge, cuts: &[(usize, u32)], drop: Option<usize>) -> Vec<Edge> {
    let last = e.points.len() - 1;
    let mut at: Vec<(usize, u32)> = vec![(0, e.a)];
    at.extend(cuts.iter().copied().filter(|&(k, _)| k > 0 && k < last));
    at.push((last, e.b));
    at.sort_by_key(|&(k, _)| k);
    at.dedup_by_key(|&mut (k, _)| k);
    at.windows(2)
        .filter(|w| Some(w[0].0) != drop)
        .map(|w| Edge { a: w[0].1, b: w[1].1, points: e.points[w[0].0..=w[1].0].to_vec(), ..e.clone() })
        .collect()
}

/// How far (percent of its width) a graded road stays level from a junction.
const JUNCTION_FLAT: i64 = 150;

/// How far either side of a road's edge the land is blended into it (cm).
const SHOULDER_CM: i64 = 400;

/// A bridge's deck stands this far (cm) over the higher of its two banks, and a city
/// street climbs to it no steeper than this (per mille).
const DECK_CM: i64 = 100;
const RAMP_PM: i64 = 60;

/// Each point's distance (cm) along a road from its first.
fn along_road(points: &[[i64; 3]]) -> Vec<i64> {
    let mut at = vec![0i64; points.len()];
    for q in 1..points.len() {
        let (a, b) = (points[q - 1], points[q]);
        at[q] = at[q - 1] + isqrt((b[0] - a[0]).pow(2) + (b[2] - a[2]).pow(2));
    }
    at
}

impl Roads {
    /// Heights from (possibly edited) terrain. City roads lie on the ground (the
    /// plateau keeps them gentle). A highway or the ring is GRADED: the profile closest to
    /// the land that never exceeds its class's grade, pinned to its nodes at both
    /// ends -- cut into hills and filled over dips, as a real road is built. A road
    /// that cannot be graded at all is an error (and so is an edit that causes one).
    /// A bridge is level, its deck a metre over the higher bank; a city street meeting
    /// one ramps up to it (`lift`).
    pub fn seat(&mut self, t: &Terrain, p: &Profile) -> Result<(), String> {
        for n in &mut self.nodes {
            n.y = t.height_at(n.x, n.z);
        }
        self.lift();
        let mut degree = vec![0usize; self.nodes.len()];
        let mut deck = vec![false; self.nodes.len()];
        for e in &self.edges {
            degree[e.a as usize] += 1;
            degree[e.b as usize] += 1;
            if e.bridge == Some(true) {
                deck[e.a as usize] = true;
                deck[e.b as usize] = true;
            }
        }
        for e in &mut self.edges {
            let len = e.points.len();
            let (ya, yb) = (self.nodes[e.a as usize].y, self.nodes[e.b as usize].y);
            let raw: Vec<i64> = e.points.iter().map(|q| t.height_at(q[0], q[2])).collect();
            if e.bridge == Some(true) {
                // `lift` set both ends to the deck
                for pt in e.points.iter_mut() {
                    pt[1] = ya.max(yb);
                }
            } else if !is_graded(e.class) {
                // on the ground, or on a ramp down from a lifted end
                let at = along_road(&e.points);
                let (la, lb) = (ya > raw[0], yb > raw[len - 1]);
                for (q, pt) in e.points.iter_mut().enumerate() {
                    let from_a = if la { ya - at[q] * RAMP_PM / 1000 } else { i64::MIN };
                    let from_b = if lb { yb - (at[len - 1] - at[q]) * RAMP_PM / 1000 } else { i64::MIN };
                    pt[1] = raw[q].max(from_a).max(from_b);
                }
            } else {
                let g = p.country_grade_pm;
                // distance along the road to each point
                let mut at = vec![0i64; len];
                for q in 1..len {
                    let (a, b) = (e.points[q - 1], e.points[q]);
                    at[q] = at[q - 1] + isqrt((b[0] - a[0]).pow(2) + (b[2] - a[2]).pow(2));
                }
                // how far it may climb by each point (summed per step, so the bounds below
                // agree to the cm): nothing within JUNCTION_FLAT widths of a junction, so
                // roads meeting there share one level where their carriageways overlap (but
                // a road off a bridge climbs off its deck straight away, all its length)
                let flat = e.width * JUNCTION_FLAT / 100;
                let off_deck = deck[e.a as usize] || deck[e.b as usize];
                let level = |n: u32| (degree[n as usize] > 1 && !off_deck) as i64 * flat;
                let (fa, fb) = (level(e.a), level(e.b));
                let budget = |fa: i64, fb: i64| {
                    let mut climb = vec![0i64; len];
                    for q in 1..len {
                        let level = at[q] <= fa || at[len - 1] - at[q - 1] <= fb;
                        climb[q] = climb[q - 1] + if level { 0 } else { (at[q] - at[q - 1]) * g / 1000 };
                    }
                    climb
                };
                let mut climb = budget(fa, fb);
                // a short piece between two junctions a river's bridges lifted apart climbs
                // its whole length (no world without a bridge has one)
                if (yb - ya).abs() > climb[len - 1] && deck.iter().any(|&d| d) {
                    climb = budget(0, 0);
                }
                let (total, most) = (at[len - 1], climb[len - 1]);
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
                    let (from_a, to_b) = (climb[q], most - climb[q]);
                    let lo = (ya - from_a).max(yb - to_b);
                    let hi = (ya + from_a).min(yb + to_b);
                    if lo > hi {
                        return Err(format!("{} cannot be graded: it climbs {} m in {} m", e.name, (yb - ya).abs() / 100, total / 100));
                    }
                    let step = climb[q] - climb[q - 1];
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

    /// Bridges: each deck a metre over the higher of its banks (the ground at its ends),
    /// both ends lifted to it; then every city street's node as high as a ramp of
    /// `RAMP_PM` down from a lifted node along the streets needs it (graded roads grade
    /// themselves to their ends). Repeated until the decks agree with the ramps (a
    /// ramp from one bridge may lift another's end). Nothing to do without a bridge.
    fn lift(&mut self) {
        let bridges: Vec<usize> = (0..self.edges.len()).filter(|&k| self.edges[k].bridge == Some(true)).collect();
        if bridges.is_empty() {
            return;
        }
        let ground: Vec<i64> = self.nodes.iter().map(|n| n.y).collect();
        let mut adj: Vec<Vec<(u32, i64)>> = vec![Vec::new(); self.nodes.len()];
        for e in self.edges.iter().filter(|e| e.bridge.is_none() && !is_graded(e.class)) {
            let l = along_road(&e.points)[e.points.len() - 1];
            adj[e.a as usize].push((e.b, l));
            adj[e.b as usize].push((e.a, l));
        }
        let mut y = ground.clone();
        for &k in &bridges {
            let (a, b) = (self.edges[k].a as usize, self.edges[k].b as usize);
            let deck = ground[a].max(ground[b]) + DECK_CM;
            y[a] = y[a].max(deck);
            y[b] = y[b].max(deck);
        }
        for _ in 0..8 {
            // the highest first: a node's height is final once popped
            let mut heap: BinaryHeap<(i64, u32)> = (0..y.len()).filter(|&n| y[n] > ground[n]).map(|n| (y[n], n as u32)).collect();
            while let Some((h, n)) = heap.pop() {
                if h < y[n as usize] {
                    continue;
                }
                for &(m, l) in &adj[n as usize] {
                    let up = h - l * RAMP_PM / 1000;
                    if up > y[m as usize] {
                        y[m as usize] = up;
                        heap.push((up, m));
                    }
                }
            }
            let mut level = true;
            for &k in &bridges {
                let (a, b) = (self.edges[k].a as usize, self.edges[k].b as usize);
                if y[a] != y[b] {
                    (y[a], y[b]) = (y[a].max(y[b]), y[a].max(y[b]));
                    level = false;
                }
            }
            if level {
                break;
            }
        }
        for (n, h) in self.nodes.iter_mut().zip(y) {
            n.y = h;
        }
    }

    /// Cut and fill: bring the land under every road (city roads too) to the road's
    /// height at the terrain's vertices, blending over a shoulder either side, so the
    /// ground under a road follows the road. The road's surface is still its centre
    /// line: between vertices the bilinear ground can differ from it. Never under a
    /// bridge: the river runs on beneath it.
    pub fn carve(&self, t: &mut Terrain) {
        for e in self.edges.iter().filter(|e| e.bridge.is_none()) {
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

/// Roads already laid, for routing round them: their points and diagonal steps.
#[derive(Default, Clone)]
struct Taken {
    points: BTreeSet<(i64, i64)>,
    /// Diagonal steps, as (lower-x end, upper-x end).
    diagonals: BTreeSet<((i64, i64), (i64, i64))>,
    /// Steps off the lattice (a highway's first and last: city node, gate), tested exactly.
    odd: Vec<((i64, i64), (i64, i64))>,
    /// Never step onto a point or across a diagonal (else only pay for it).
    forbid: bool,
}

impl Taken {
    fn add(&mut self, path: &[(i64, i64)], t: &Terrain) {
        let cell = t.cell_cm;
        let lattice = |v: i64| (v - t.origin_cm).rem_euclid(cell) == 0;
        self.points.extend(path.iter().copied());
        for w in path.windows(2) {
            let (dx, dz) = ((w[1].0 - w[0].0).abs(), (w[1].1 - w[0].1).abs());
            if (dx == 0 || dx == cell) && (dz == 0 || dz == cell) && lattice(w[0].0) && lattice(w[0].1) {
                if dx != 0 && dz != 0 {
                    self.diagonals.insert((w[0].min(w[1]), w[0].max(w[1])));
                }
            } else {
                self.odd.push((w[0], w[1]));
            }
        }
    }

    /// Does the step u -> v (vertices) land on a taken point other than the goal, or
    /// cross a taken diagonal step?
    fn hits(&self, u: (i64, i64), v: (i64, i64), goal: bool) -> bool {
        let (c, d) = ((v.0, u.1), (u.0, v.1));
        (!goal && self.points.contains(&v))
            || (u.0 != v.0 && u.1 != v.1 && self.diagonals.contains(&(c.min(d), c.max(d))))
            || self.odd.iter().any(|&(p, q)| segments_touch(u, v, p, q))
    }
}

/// How far (terrain cells, Chebyshev) from its city node a highway may flare over the
/// streets that meet there.
pub const FLARE: i64 = 2;

/// What a graded road keeps `clear` cm (its half-width) away from: the blocks and
/// the city's street surfaces (each edge's strip, the junction squares included),
/// indexed by terrain vertex: each vertex lists the rectangles a step from it could
/// come near. A street's strip carries its end nodes: a highway may flare over the
/// streets that meet at its own city node, on steps leaving within `FLARE` cells of it.
struct Keep {
    rects: Vec<((i64, i64, i64, i64), Option<[(i64, i64); 2]>)>,
    near: Vec<Vec<u32>>,
    clear: i64,
}

impl Keep {
    fn new(t: &Terrain, blocks: &[Block], streets: &[Edge], clear: i64) -> Self {
        let mut rects: Vec<_> = blocks.iter().map(|b| ((b.x - b.w / 2, b.x + b.w / 2, b.z - b.d / 2, b.z + b.d / 2), None)).collect();
        for e in streets {
            let (a, b) = (e.points[0], e.points[e.points.len() - 1]);
            let h = e.width / 2;
            rects.push(((a[0].min(b[0]) - h, a[0].max(b[0]) + h, a[2].min(b[2]) - h, a[2].max(b[2]) + h), Some([(a[0], a[2]), (b[0], b[2])])));
        }
        // a step reaches at most 2 cells from the vertex it leaves (the path's exact
        // first point is within half a cell of it)
        let mut near = vec![Vec::new(); t.n * t.n];
        let reach = clear + 2 * t.cell_cm;
        for (k, (r, _)) in rects.iter().enumerate() {
            let (lo, hi) = (t.vertex_of(r.0 - reach, r.2 - reach), t.vertex_of(r.1 + reach, r.3 + reach));
            for iz in lo.1..=hi.1 {
                for ix in lo.0..=hi.0 {
                    near[iz * t.n + ix].push(k as u32);
                }
            }
        }
        Keep { rects, near, clear }
    }

    /// Does segment ab, leaving vertex `from`, come within `clear` of a block or street?
    /// `flare`: the road's own city node, if it leaves within `FLARE` cells of it.
    fn hits(&self, from: usize, a: (i64, i64), b: (i64, i64), flare: Option<(i64, i64)>) -> bool {
        self.near[from].iter().any(|&k| {
            let (r, ends) = self.rects[k as usize];
            !ends.is_some_and(|n| flare.is_some_and(|f| n.contains(&f))) && !clear_of(a, b, r, self.clear)
        })
    }
}

/// Is segment ab at least `c` cm from the rectangle (x0, x1, z0, z1)? Exact, in
/// integers: apart, the nearest points are a segment end and the rectangle, or a
/// corner and the segment.
fn clear_of(a: (i64, i64), b: (i64, i64), r: (i64, i64, i64, i64), c: i64) -> bool {
    let (x0, x1, z0, z1) = r;
    let inside = |q: (i64, i64)| q.0 >= x0 && q.0 <= x1 && q.1 >= z0 && q.1 <= z1;
    let corners = [(x0, z0), (x1, z0), (x1, z1), (x0, z1)];
    if inside(a) || inside(b) || (0..4).any(|k| segments_touch(a, b, corners[k], corners[(k + 1) % 4])) {
        return false;
    }
    let c2 = (c as i128).pow(2);
    let to_rect = |q: (i64, i64)| {
        let (dx, dz) = ((x0 - q.0).max(0).max(q.0 - x1) as i128, (z0 - q.1).max(0).max(q.1 - z1) as i128);
        dx * dx + dz * dz
    };
    if to_rect(a) < c2 || to_rect(b) < c2 {
        return false;
    }
    let (dx, dz) = ((b.0 - a.0) as i128, (b.1 - a.1) as i128);
    let l2 = dx * dx + dz * dz;
    corners.iter().all(|&(kx, kz)| {
        let (ux, uz) = ((kx - a.0) as i128, (kz - a.1) as i128);
        let along = ux * dx + uz * dz;
        // beyond either end the nearest point is an end, already checked
        along <= 0 || along >= l2 || (ux * dz - uz * dx).pow(2) >= c2 * l2
    })
}

/// A* over the terrain's vertices from `a` to `b` (cm), paying for length and
/// slope (and dearly for steps on a `river`), avoiding the inside of `avoid_r` (the city, or the ring's inside), never past
/// `out_r`, any
/// step that comes within half a road's width of a block or street (`keep`, tested
/// on the real segment: the path's ends are `a` and `b`, not their vertices; a
/// `city_start` road may flare over the streets at `a`) and the points and diagonals
/// in `taken` (other roads', bar the goal). Steps into a `forbid` set are never
/// taken, others are paid for; when every set forbids (and there is one), so are steps
/// near a block or street. Returns the path's points, `a` and `b` exact.
#[allow(clippy::too_many_arguments)] // the ends, and one per thing a road avoids
fn route(
    t: &Terrain,
    p: &Profile,
    a: (i64, i64),
    b: (i64, i64),
    avoid_r: i64,
    out_r: i64,
    keep: &Keep,
    taken: &[Taken],
    city_start: bool,
    river: Option<&River>,
) -> Option<Vec<(i64, i64)>> {
    let n = t.n;
    let strict = !taken.is_empty() && taken.iter().all(|k| k.forbid);
    let (s, g) = (t.vertex_of(a.0, a.1), t.vertex_of(b.0, b.1));
    let idx = |v: (usize, usize)| v.1 * n + v.0;
    let h = |v: (usize, usize)| t.heights[idx(v)] as i64;
    let cell = t.cell_cm;
    let heur = |v: (usize, usize)| {
        let (dx, dz) = ((v.0 as i64 - g.0 as i64).abs(), (v.1 as i64 - g.1 as i64).abs());
        (dx.max(dz) * 1000 + dx.min(dz) * 414) * cell / 1000
    };
    // A* state: a vertex and the direction of the step that reached it (8: the start).
    // A step may turn at most 45 degrees from the last, so a road bends no tighter than
    // about a cell's radius and never doubles back over itself in a hairpin.
    const DIRS: [(i64, i64); 8] = [(1, 0), (1, 1), (0, 1), (-1, 1), (-1, 0), (-1, -1), (0, -1), (1, -1)];
    let mut best = vec![i64::MAX; n * n * 9];
    let mut from = vec![usize::MAX; n * n * 9];
    let mut open = BinaryHeap::new();
    best[idx(s) * 9 + 8] = 0;
    open.push(Reverse((heur(s), idx(s) * 9 + 8)));
    let mut end = None;
    while let Some(Reverse((f, us))) = open.pop() {
        let (u, ud) = (us / 9, us % 9);
        if f - heur((u % n, u / n)) > best[us] {
            continue;
        }
        if u == idx(g) {
            end = Some(us);
            break;
        }
        let (ux, uz) = (u % n, u / n);
        for (d, &(dx, dz)) in DIRS.iter().enumerate() {
            if ud != 8 && (d + 8 - ud) % 8 > 1 && (ud + 8 - d) % 8 > 1 {
                continue;
            }
            let (vx, vz) = (ux as i64 + dx, uz as i64 + dz);
            if vx < 0 || vz < 0 || vx >= n as i64 || vz >= n as i64 {
                continue;
            }
            let v = (vx as usize, vz as usize);
            let len = if dx != 0 && dz != 0 { cell * 1414 / 1000 } else { cell };
            let grade = (h(v) - h((ux, uz))).abs() * 1000 / len;
            let (wx, wz) = t.vertex_pos(v.0, v.1);
            if wx * wx + wz * wz > out_r.saturating_mul(out_r) {
                continue; // past the coast's nearest reach (the ring road on an island)
            }
            let inside = wx * wx + wz * wz < avoid_r * avoid_r;
            let mut step = len * (1000 + 25 * grade) / 1000;
            if grade > p.country_grade_pm {
                step += len * 50;
            }
            if inside {
                step += len * 20;
            }
            // across a river, not along it: every step on its water or bank is dear
            if river.is_some_and(|r| r.zone((wx, wz))) {
                step += len * 30;
            }
            let hit: Vec<bool> = taken.iter().filter(|k| k.hits(t.vertex_pos(ux, uz), (wx, wz), v == g)).map(|k| k.forbid).collect();
            if hit.contains(&true) {
                continue;
            }
            if !hit.is_empty() {
                step += len * 20;
            }
            // a road that may touch another keeps a cell off it where it can: two roads
            // side by side would overlap, or meet again a cell from a junction
            let beside = |k: &Taken| [-cell, 0, cell].iter().any(|&ox| [-cell, 0, cell].iter().any(|&oz| k.points.contains(&(wx + ox, wz + oz))));
            if v != g && taken.iter().any(|k| !k.forbid && beside(k)) {
                step += len * 5;
            }
            let at = |w: usize| if w == idx(s) { a } else if w == idx(g) { b } else { t.vertex_pos(w % n, w / n) };
            let flare = (city_start && (at(u).0 - a.0).abs().max((at(u).1 - a.1).abs()) <= FLARE * cell).then_some(a);
            if keep.hits(u, at(u), at(idx(v)), flare) {
                if strict {
                    continue;
                }
                step += len * 200;
            }
            let c = best[us] + step;
            let vs = idx(v) * 9 + d;
            if c < best[vs] {
                best[vs] = c;
                from[vs] = us;
                open.push(Reverse((c + heur(v), vs)));
            }
        }
    }
    let mut cells = vec![end?];
    while *cells.last().unwrap() != idx(s) * 9 + 8 {
        cells.push(from[*cells.last().unwrap()]);
    }
    let mut cells: Vec<usize> = cells.into_iter().map(|c| c / 9).collect();
    cells.reverse();
    // every vertex (8 m apart), so the road's height profile follows the land; the ends exact
    let mut pts = vec![a];
    if cells.len() > 2 {
        pts.extend(cells[1..cells.len() - 1].iter().map(|&c| t.vertex_pos(c % n, c / n)));
    }
    pts.push(b);
    Some(pts)
}
