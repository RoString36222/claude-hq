//! Blocks: the faces of the finished road graph. The face walk gives each face as a
//! cycle of nodes; a cycle that visits a node twice (a dead end, or a bridge to a
//! knot of streets inside the face) is cut there into simple loops: the
//! counter-clockwise ones are blocks, the clockwise ones holes in them (streets
//! inside the block, whose land has blocks of its own). A block's footprint is its
//! loop inset by half the width of the road along each side: the land between the kerbs.
//! A side along a river's wall is no road (no lot fronts it), and a loop of nothing but
//! wall and bridges is the river itself, not a block.

use std::collections::{BTreeMap, HashMap};

use super::geom::{area2, cross, dot, left, simple, sub, unit, P};
use super::graph::{Graph, Kind};
use super::super::noise::ONE;

/// How far (cm) a block keeps back from a road's edge, past its half-width.
pub const KERB_CM: i64 = 25;
/// The smallest block kept (cm2).
const MIN_BLOCK_CM2: i64 = 120 * 10_000;

pub struct Face {
    /// The footprint (cm, counter-clockwise), inside the kerbs.
    pub poly: Vec<P>,
    /// Loops of street inside it (centre lines): their land is not this block's.
    pub holes: Vec<Vec<P>>,
    /// Side k (poly[k] to poly[k + 1]) is on a road (false: on a river's bank).
    pub fronts: Vec<bool>,
}

/// The blocks of `g`; `half(e)` is graph edge e's half-width (cm).
pub fn blocks(g: &Graph, half: impl Fn(u32) -> i64) -> Vec<Face> {
    // lookups only: never iterated
    let mut between: HashMap<(u32, u32), u32> = HashMap::new();
    for (k, e) in g.edges.iter().enumerate() {
        if e.alive {
            between.insert((e.a.min(e.b), e.a.max(e.b)), k as u32);
        }
    }
    let mut out = Vec::new();
    for cyc in g.faces() {
        let (mut loops, mut holes) = (Vec::new(), Vec::new());
        for l in split_loops(&cyc) {
            let pts: Vec<P> = l.iter().map(|&n| g.nodes[n as usize]).collect();
            match area2(&pts) {
                a if a > 0 => loops.push(l),
                a if a < 0 => holes.push(pts),
                _ => {}
            }
        }
        for l in loops {
            let n = l.len();
            let edges: Vec<u32> = (0..n).map(|k| between[&(l[k].min(l[(k + 1) % n]), l[k].max(l[(k + 1) % n]))]).collect();
            if edges.iter().all(|&e| g.edges[e as usize].kind == Kind::Water || g.edges[e as usize].bridge) {
                continue; // the river
            }
            let sides: Vec<(P, i64, bool)> = (0..n)
                .map(|k| (g.nodes[l[k] as usize], half(edges[k]) + KERB_CM, g.edges[edges[k] as usize].kind != Kind::Water))
                .collect();
            let sides = straighten(sides);
            let fronts: Vec<bool> = sides.iter().map(|s| s.2).collect();
            let Some(poly) = inset(&sides.iter().map(|s| (s.0, s.1)).collect::<Vec<_>>()) else { continue };
            if area2(&poly) >= 2 * MIN_BLOCK_CM2 {
                out.push(Face { poly, holes: holes.clone(), fronts });
            }
        }
    }
    out
}

/// Cut a closed walk at every node it revisits: each stretch between two visits is
/// a loop of its own. Loops of two nodes (there and back along a dead end) are dropped.
fn split_loops(cyc: &[u32]) -> Vec<Vec<u32>> {
    let mut out = Vec::new();
    let mut stack: Vec<u32> = Vec::new();
    let mut at: BTreeMap<u32, usize> = BTreeMap::new();
    for &v in cyc.iter().chain(cyc.first()) {
        if let Some(&k) = at.get(&v) {
            let lp = stack.split_off(k);
            for n in &lp {
                at.remove(n);
            }
            if lp.len() >= 3 {
                out.push(lp);
            }
        }
        at.insert(v, stack.len());
        stack.push(v);
    }
    out
}

/// Drop corners where the road runs on straight (under 2 degrees) at the same width
/// (and both sides roads, or both wall): a street is a chain of short segments, a
/// block's side is one edge.
fn straighten(mut s: Vec<(P, i64, bool)>) -> Vec<(P, i64, bool)> {
    let mut k = 0;
    while s.len() > 3 && k < s.len() {
        let n = s.len();
        let (prev, cur, next) = (s[(k + n - 1) % n], s[k], s[(k + 1) % n]);
        let (u, v) = (unit(sub(cur.0, prev.0)), unit(sub(next.0, cur.0)));
        if prev.1 == cur.1 && prev.2 == cur.2 && dot(u, v) > 0 && cross(u, v).abs() < (ONE * ONE / 30) as i128 {
            s.remove(k);
        } else {
            k += 1;
        }
    }
    s
}

/// Move each side (a point and the half-width of the road from it to the next point)
/// inward by its half-width; corners where the moved sides meet. None if the result
/// is not a simple polygon running the same way round (the face was too thin).
pub fn inset(s: &[(P, i64)]) -> Option<Vec<P>> {
    let n = s.len();
    if n < 3 {
        return None;
    }
    let normal = |k: usize| left(unit(sub(s[(k + 1) % n].0, s[k].0)));
    let mut out = Vec::with_capacity(n);
    for k in 0..n {
        let j = (k + n - 1) % n;
        let (n1, h1, n2, h2) = (normal(j), s[j].1 as i128, normal(k), s[k].1 as i128);
        // x . n1 = h1 and x . n2 = h2 (Q16 normals)
        let det = cross(n1, n2);
        let x = if det.abs() < (ONE * ONE / 8) as i128 {
            // nearly straight on: the mean of the two offsets
            (((n1.0 as i128 * h1 + n2.0 as i128 * h2) / (2 * ONE as i128)) as i64, ((n1.1 as i128 * h1 + n2.1 as i128 * h2) / (2 * ONE as i128)) as i64)
        } else {
            let o = ONE as i128;
            (((h1 * o * n2.1 as i128 - h2 * o * n1.1 as i128) / det) as i64, ((n1.0 as i128 * h2 * o - n2.0 as i128 * h1 * o) / det) as i64)
        };
        out.push((s[k].0 .0 + x.0, s[k].0 .1 + x.1));
    }
    // every side still runs the way it did, and nothing crosses
    let flipped = (0..n).any(|k| dot(sub(out[(k + 1) % n], out[k]), sub(s[(k + 1) % n].0, s[k].0)) <= 0);
    (!flipped && area2(&out) > 0 && simple(&out)).then_some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::graph::Kind;

    #[test]
    fn loops_split_at_revisited_nodes() {
        // a face with a dead end (2-3-2) and a knot (4-5-6-4) on a bridge (1-4)
        let l = split_loops(&[0, 1, 4, 5, 6, 4, 1, 2, 3, 2, 7]);
        assert_eq!(l, vec![vec![4, 5, 6], vec![0, 1, 2, 7]]);
    }

    #[test]
    fn a_square_insets_by_each_roads_half_width() {
        let sq = [((0, 0), 400), ((10_000, 0), 600), ((10_000, 10_000), 400), ((0, 10_000), 400)];
        let p = inset(&sq).unwrap();
        assert_eq!(p, vec![(400, 400), (9_400, 400), (9_400, 9_600), (400, 9_600)]);
        // too thin: the sides cross
        assert!(inset(&[((0, 0), 400), ((10_000, 0), 400), ((10_000, 500), 400), ((0, 500), 400)]).is_none());
    }

    #[test]
    fn a_grid_has_its_blocks() {
        let mut g = Graph::default();
        let n: Vec<u32> = (0..9).map(|k| g.node(((k % 3) * 6_000, (k / 3) * 6_000))).collect();
        for k in 0..9 {
            if k % 3 < 2 {
                g.link(n[k], n[k + 1], Kind::Local, 0);
            }
            if k < 6 {
                g.link(n[k], n[k + 3], Kind::Local, 0);
            }
        }
        let b = blocks(&g, |_| 400);
        assert_eq!(b.len(), 4);
        for f in &b {
            assert_eq!(area2(&f.poly), 2 * (6_000 - 850) * (6_000 - 850));
        }
    }
}
