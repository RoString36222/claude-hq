//! The road graph while it grows: straight segments between nodes, kept planar
//! (roads meet only at nodes). A new segment is fitted with Parish & Muller's local
//! constraints: it stops where it first crosses a road (a junction there), snaps to
//! a junction or a road within reach of its end, and is refused when it would meet
//! a road at a sliver angle or run alongside one. Faces of the finished graph are
//! the city's blocks.
//!
//! A river's bank is laid in first as a wall (`Kind::Water` edges): streets meet it
//! like a road and stop there, faces form against it, and before the lots are cut the
//! wall is taken down. A bridge (`GEdge::bridge`) spans the water between two of its
//! nodes; no street joins a bridge part way over.

use std::collections::HashMap;

use super::geom::{crossing, cross, dist2, dot, lerp, nearest_on, sub, unit, COS30, P};
use super::super::noise::ONE;
use super::super::roads::segments_touch;

/// The spatial index's cell (cm): longer than most segments, so a query reads a few cells.
const CELL: i64 = 4_000;

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Kind {
    Arterial,
    Local,
    /// A river's bank: a wall, not a road.
    Water,
}

#[derive(Clone)]
pub struct GEdge {
    pub a: u32,
    pub b: u32,
    pub kind: Kind,
    /// The street it is part of (an index into the generator's street list).
    pub road: u32,
    pub alive: bool,
    /// A bridge over the river: straight from bank to bank.
    pub bridge: bool,
}

/// What became of a segment: it ended at a new node (the street can grow on from
/// it), it joined the network at a node (on a road of street `.1`), or it was refused.
pub enum Fit {
    Free(u32),
    Joined(u32, u32),
    Refused,
}

#[derive(Default)]
pub struct Graph {
    pub nodes: Vec<P>,
    pub edges: Vec<GEdge>,
    /// Alive edges at each node.
    pub adj: Vec<Vec<u32>>,
    // lookups only, never iterated: HashMap order cannot leak into the world
    ecell: HashMap<(i64, i64), Vec<u32>>,
    ncell: HashMap<(i64, i64), Vec<u32>>,
}

fn cell(p: P) -> (i64, i64) {
    (p.0.div_euclid(CELL), p.1.div_euclid(CELL))
}

impl Graph {
    pub fn node(&mut self, p: P) -> u32 {
        let id = self.nodes.len() as u32;
        self.nodes.push(p);
        self.adj.push(Vec::new());
        self.ncell.entry(cell(p)).or_default().push(id);
        id
    }

    pub fn link(&mut self, a: u32, b: u32, kind: Kind, road: u32) -> u32 {
        let id = self.edges.len() as u32;
        self.edges.push(GEdge { a, b, kind, road, alive: true, bridge: false });
        self.adj[a as usize].push(id);
        self.adj[b as usize].push(id);
        let (pa, pb) = (self.nodes[a as usize], self.nodes[b as usize]);
        let (lo, hi) = (cell((pa.0.min(pb.0), pa.1.min(pb.1))), cell((pa.0.max(pb.0), pa.1.max(pb.1))));
        for cz in lo.1..=hi.1 {
            for cx in lo.0..=hi.0 {
                self.ecell.entry((cx, cz)).or_default().push(id);
            }
        }
        id
    }

    /// Remove edge `e` (its nodes stay).
    pub fn kill(&mut self, e: u32) {
        let (a, b) = (self.edges[e as usize].a, self.edges[e as usize].b);
        self.edges[e as usize].alive = false;
        self.adj[a as usize].retain(|&x| x != e);
        self.adj[b as usize].retain(|&x| x != e);
    }

    /// Split edge `e` at `p` (a new node), keeping its kind and street.
    pub fn split(&mut self, e: u32, p: P) -> u32 {
        let GEdge { a, b, kind, road, bridge, .. } = self.edges[e as usize];
        self.kill(e);
        let n = self.node(p);
        let (x, y) = (self.link(a, n, kind, road), self.link(n, b, kind, road));
        self.edges[x as usize].bridge = bridge;
        self.edges[y as usize].bridge = bridge;
        n
    }

    pub fn other(&self, e: u32, n: u32) -> u32 {
        let g = &self.edges[e as usize];
        if g.a == n { g.b } else { g.a }
    }

    fn linked(&self, a: u32, b: u32) -> bool {
        self.adj[a as usize].iter().any(|&e| self.other(e, a) == b)
    }

    fn touches(&self, e: u32, n: u32) -> bool {
        let g = &self.edges[e as usize];
        g.a == n || g.b == n
    }

    /// Alive edges whose cells meet the box (lo, hi), in id order.
    pub fn edges_in(&self, lo: P, hi: P) -> Vec<u32> {
        let (lo, hi) = (cell(lo), cell(hi));
        let mut out = Vec::new();
        for cz in lo.1..=hi.1 {
            for cx in lo.0..=hi.0 {
                if let Some(v) = self.ecell.get(&(cx, cz)) {
                    out.extend(v.iter().copied().filter(|&e| self.edges[e as usize].alive));
                }
            }
        }
        out.sort_unstable();
        out.dedup();
        out
    }

    /// The node nearest `p` within `r` cm (ties to the lower id), bar `skip`.
    fn node_near(&self, p: P, r: i64, skip: u32) -> Option<u32> {
        let (lo, hi) = (cell((p.0 - r, p.1 - r)), cell((p.0 + r, p.1 + r)));
        let mut best: Option<(i64, u32)> = None;
        for cz in lo.1..=hi.1 {
            for cx in lo.0..=hi.0 {
                for &n in self.ncell.get(&(cx, cz)).map_or(&[][..], |v| &v[..]) {
                    let d = dist2(self.nodes[n as usize], p);
                    if n != skip && !self.adj[n as usize].is_empty() && d <= r * r && best.is_none_or(|b| (d, n) < b) {
                        best = Some((d, n));
                    }
                }
            }
        }
        best.map(|b| b.1)
    }

    /// Does every edge at `n` make at least 30 degrees with the way from `n` to `toward`?
    pub fn angle_ok(&self, n: u32, toward: P) -> bool {
        let o = self.nodes[n as usize];
        let d = unit((toward.0 - o.0, toward.1 - o.1));
        self.adj[n as usize].iter().all(|&e| {
            let q = self.nodes[self.other(e, n) as usize];
            dot(unit((q.0 - o.0, q.1 - o.1)), d) <= (COS30 * ONE) as i128
        })
    }

    /// Does segment ab cross (or touch) no road, bar those at the `skip` nodes and `skip_edge`?
    fn clear(&self, a: P, b: P, skip: &[u32], skip_edge: Option<u32>) -> bool {
        self.edges_in((a.0.min(b.0), a.1.min(b.1)), (a.0.max(b.0), a.1.max(b.1))).into_iter().all(|e| {
            let g = &self.edges[e as usize];
            Some(e) == skip_edge
                || skip.iter().any(|&n| self.touches(e, n))
                || !segments_touch(a, b, self.nodes[g.a as usize], self.nodes[g.b as usize])
        })
    }

    /// Is `q` at least `gap` cm from every road, bar those at the `skip` nodes?
    fn roomy(&self, q: P, gap: i64, skip: &[u32]) -> bool {
        self.edges_in((q.0 - gap, q.1 - gap), (q.0 + gap, q.1 + gap)).into_iter().all(|e| {
            let g = &self.edges[e as usize];
            skip.iter().any(|&n| self.touches(e, n)) || nearest_on(q, self.nodes[g.a as usize], self.nodes[g.b as usize]).1 >= gap * gap
        })
    }

    /// The street of a road at node `n`.
    fn road_at(&self, n: u32) -> u32 {
        self.adj[n as usize].first().map_or(u32::MAX, |&e| self.edges[e as usize].road)
    }

    /// A segment from node `u` toward `p`, fitted to the roads already laid (see the module doc).
    /// `snap`: how far (cm) it reaches for a junction or a road; `min_len`: its shortest;
    /// `gap`: how close its middle may come to another road.
    #[allow(clippy::too_many_arguments)] // the segment, what it is, and the three reaches it is fitted with
    pub fn fit(&mut self, u: u32, p: P, kind: Kind, road: u32, snap: i64, min_len: i64, gap: i64) -> Fit {
        let a = self.nodes[u as usize];
        // the first road it crosses: a junction there (or at that road's end, if near)
        let mut first: Option<(i128, i128, u32)> = None;
        for e in self.edges_in((a.0.min(p.0), a.1.min(p.1)), (a.0.max(p.0), a.1.max(p.1))) {
            if self.touches(e, u) {
                continue;
            }
            let g = &self.edges[e as usize];
            if let Some((num, den)) = crossing(a, p, self.nodes[g.a as usize], self.nodes[g.b as usize]) {
                if first.is_none_or(|(n0, d0, _)| num * d0 < n0 * den) {
                    first = Some((num, den, e));
                }
            }
        }
        if let Some((num, den, e)) = first {
            if self.edges[e as usize].bridge {
                return Fit::Refused;
            }
            let x = lerp(a, p, num, den);
            let (ea, eb) = (self.edges[e as usize].a, self.edges[e as usize].b);
            for end in [ea, eb] {
                if dist2(self.nodes[end as usize], x) <= snap * snap {
                    return self.join(u, end, kind, road, min_len);
                }
            }
            return self.join_edge(u, e, x, kind, road, min_len);
        }
        // a junction within reach of its end
        if let Some(n) = self.node_near(p, snap, u) {
            return self.join(u, n, kind, road, min_len);
        }
        // a road within reach of its end: meet it square on
        let mut near: Option<(i64, u32, P)> = None;
        for e in self.edges_in((p.0 - snap, p.1 - snap), (p.0 + snap, p.1 + snap)) {
            let g = &self.edges[e as usize];
            if self.touches(e, u) || g.bridge {
                continue;
            }
            let (q, d) = nearest_on(p, self.nodes[g.a as usize], self.nodes[g.b as usize]);
            if d <= snap * snap && near.is_none_or(|b| (d, e) < (b.0, b.1)) {
                near = Some((d, e, q));
            }
        }
        if let Some((_, e, x)) = near {
            let (ea, eb) = (self.edges[e as usize].a, self.edges[e as usize].b);
            for end in [ea, eb] {
                if dist2(self.nodes[end as usize], x) <= snap * snap {
                    return self.join(u, end, kind, road, min_len);
                }
            }
            return self.join_edge(u, e, x, kind, road, min_len);
        }
        // open ground
        let mid = ((a.0 + p.0) / 2, (a.1 + p.1) / 2);
        if dist2(a, p) < min_len * min_len || !self.angle_ok(u, p) || !self.roomy(mid, gap, &[u]) || !self.roomy(p, gap, &[u]) {
            return Fit::Refused;
        }
        let n = self.node(p);
        self.link(u, n, kind, road);
        Fit::Free(n)
    }

    /// Link u to the existing node n, if the segment is long enough, crosses nothing
    /// and meets the roads at both ends at a fair angle.
    fn join(&mut self, u: u32, n: u32, kind: Kind, road: u32, min_len: i64) -> Fit {
        let (a, b) = (self.nodes[u as usize], self.nodes[n as usize]);
        if n == u || self.linked(u, n) || dist2(a, b) < min_len * min_len {
            return Fit::Refused;
        }
        if !self.clear(a, b, &[u, n], None) || !self.angle_ok(u, b) || !self.angle_ok(n, a) {
            return Fit::Refused;
        }
        let met = self.road_at(n);
        self.link(u, n, kind, road);
        Fit::Joined(n, met)
    }

    /// Link u to a new junction at x on edge e (splitting it), on the same terms.
    fn join_edge(&mut self, u: u32, e: u32, x: P, kind: Kind, road: u32, min_len: i64) -> Fit {
        let a = self.nodes[u as usize];
        let g = &self.edges[e as usize];
        let (c, d) = (self.nodes[g.a as usize], self.nodes[g.b as usize]);
        let (s, r) = (unit((d.0 - c.0, d.1 - c.1)), unit((a.0 - x.0, a.1 - x.1)));
        if dist2(a, x) < min_len * min_len || dot(s, r).abs() > (COS30 * ONE) as i128 || cross(s, r) == 0 {
            return Fit::Refused;
        }
        if !self.clear(a, x, &[u], Some(e)) || !self.angle_ok(u, x) {
            return Fit::Refused;
        }
        let met = g.road;
        let n = self.split(e, x);
        self.link(u, n, kind, road);
        Fit::Joined(n, met)
    }

    /// Could nodes a and b be joined straight, crossing no road (or wall) but those at them?
    pub fn clear_between(&self, a: u32, b: u32) -> bool {
        self.clear(self.nodes[a as usize], self.nodes[b as usize], &[a, b], None)
    }

    /// A straight street of `kind` to node `to` from the nearest point (within `reach`
    /// cm) of a road that can reach it: crossing nothing, at least `min_len` long, meeting
    /// the roads at both ends at a fair angle. Bridges and walls are not roads to start
    /// from. False if no road can.
    pub fn spur(&mut self, to: u32, reach: i64, min_len: i64, kind: Kind, road: u32) -> bool {
        let d = self.nodes[to as usize];
        let mut near: Vec<(i64, u32, P)> = self
            .edges_in((d.0 - reach, d.1 - reach), (d.0 + reach, d.1 + reach))
            .into_iter()
            .filter(|&e| self.edges[e as usize].kind != Kind::Water && !self.edges[e as usize].bridge && !self.touches(e, to))
            .map(|e| {
                let g = &self.edges[e as usize];
                let (q, d2) = nearest_on(d, self.nodes[g.a as usize], self.nodes[g.b as usize]);
                (d2, e, q)
            })
            .filter(|&(d2, _, _)| d2 <= reach * reach && d2 >= min_len * min_len)
            .collect();
        near.sort();
        for (_, e, q) in near {
            let (ea, eb) = (self.edges[e as usize].a, self.edges[e as usize].b);
            let end = [ea, eb].into_iter().find(|&n| self.nodes[n as usize] == q);
            let ok = match end {
                Some(n) => self.clear(q, d, &[n, to], None) && self.angle_ok(n, d),
                None => {
                    let (s, r) = (unit(sub(self.nodes[eb as usize], self.nodes[ea as usize])), unit(sub(d, q)));
                    self.clear(q, d, &[to], Some(e)) && dot(s, r).abs() <= (COS30 * ONE) as i128
                }
            };
            if !ok || !self.angle_ok(to, q) {
                continue;
            }
            let n = end.unwrap_or_else(|| self.split(e, q));
            self.link(n, to, kind, road);
            return true;
        }
        false
    }

    /// The bounded faces of the (planar) graph: node cycles, counter-clockwise.
    /// A dead end shows in its face as there and back (u, v, u); a road joining an
    /// island of roads to the rest, likewise.
    pub fn faces(&self) -> Vec<Vec<u32>> {
        let n = self.nodes.len();
        // each node's (neighbour, edge), counter-clockwise from +x
        let half = |v: P| if v.1 > 0 || (v.1 == 0 && v.0 > 0) { 0 } else { 1 };
        let mut ring: Vec<Vec<(u32, u32)>> = vec![Vec::new(); n];
        for (k, r) in ring.iter_mut().enumerate() {
            let o = self.nodes[k];
            let mut v: Vec<(u32, u32)> = self.adj[k].iter().map(|&e| (self.other(e, k as u32), e)).collect();
            v.sort_by(|&(x, _), &(y, _)| {
                let (p, q) = (self.nodes[x as usize], self.nodes[y as usize]);
                let (p, q) = ((p.0 - o.0, p.1 - o.1), (q.0 - o.0, q.1 - o.1));
                half(p).cmp(&half(q)).then_with(|| 0.cmp(&cross(p, q)))
            });
            *r = v;
        }
        let mut seen = vec![[false; 2]; self.edges.len()];
        let dir = |e: u32, from: u32| (self.edges[e as usize].a != from) as usize;
        let mut out = Vec::new();
        for (e0, g) in self.edges.iter().enumerate() {
            if !g.alive {
                continue;
            }
            for (from, to) in [(g.a, g.b), (g.b, g.a)] {
                if seen[e0][dir(e0 as u32, from)] {
                    continue;
                }
                // walk with the face on the left: at each node, turn to the edge just
                // clockwise of the one we came in on
                let mut cyc = Vec::new();
                let (mut u, mut v, mut e) = (from, to, e0 as u32);
                loop {
                    seen[e as usize][dir(e, u)] = true;
                    cyc.push(u);
                    let r = &ring[v as usize];
                    let k = r.iter().position(|&(w, _)| w == u).unwrap();
                    let (w, f) = r[(k + r.len() - 1) % r.len()];
                    (u, v, e) = (v, w, f);
                    if seen[e as usize][dir(e, u)] {
                        break;
                    }
                }
                let pts: Vec<P> = cyc.iter().map(|&k| self.nodes[k as usize]).collect();
                if super::geom::area2(&pts) > 0 {
                    out.push(cyc);
                }
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn segments_stop_at_the_first_road_and_snap() {
        let mut g = Graph::default();
        let (a, b) = (g.node((0, 0)), g.node((10_000, 0)));
        g.link(a, b, Kind::Arterial, 0);
        let c = g.node((5_000, -3_000));
        // crosses the arterial: a junction where it does
        match g.fit(c, (5_000, 3_000), Kind::Local, 1, 1_200, 500, 500) {
            Fit::Joined(n, met) => {
                assert_eq!(g.nodes[n as usize], (5_000, 0));
                assert_eq!(met, 0);
            }
            _ => panic!("expected a junction"),
        }
        // ends 8 m short of node a: snaps to it
        let d = g.node((-3_000, -3_000));
        assert!(matches!(g.fit(d, (-600, -600), Kind::Local, 2, 1_200, 500, 500), Fit::Joined(0, _)));
        // a sliver angle onto the arterial is refused
        let e = g.node((7_000, -400));
        assert!(matches!(g.fit(e, (9_000, 200), Kind::Local, 3, 100, 100, 100), Fit::Refused));
    }

    #[test]
    fn faces_are_the_blocks() {
        // a square split by a diagonal, with a dead end poking into one half
        let mut g = Graph::default();
        let p = [(0, 0), (10_000, 0), (10_000, 10_000), (0, 10_000)].map(|q| g.node(q));
        for k in 0..4 {
            g.link(p[k], p[(k + 1) % 4], Kind::Local, 0);
        }
        g.link(p[0], p[2], Kind::Local, 1);
        let s = g.node((8_000, 3_000));
        g.link(p[1], s, Kind::Local, 2);
        let mut f = g.faces();
        f.sort();
        assert_eq!(f.len(), 2, "{f:?}");
        assert!(f.iter().any(|c| c.len() == 5 && c.contains(&s)), "the dead end is in its face: {f:?}");
    }
}
