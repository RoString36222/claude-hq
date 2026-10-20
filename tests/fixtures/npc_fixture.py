#!/usr/bin/env python3
"""Writes tests/fixtures/npc_town@2.json: a small synthetic WorldDoc v2 town for tests/test_npcsim.py.

A 7 x 7 road grid, 150 m apart with a fixed jitter (an "organic" look), on an island 720 m in radius.
Arterials (row and column 3) and locals; roads, blocks, lots and sites carry the v2 fields of
docs/plans/cities-build-spec.md (poly, front, grow, min_tier, tier, the @2 district legend, transit,
island). Blocks are the grid cells inset by their roads' half widths, so a road (sidewalks included)
never overlaps a block. Each block holds four lots; some lots become civic and zone sites. Deterministic:
run it again and the file is byte-identical. Stdlib only.

    python3 tests/fixtures/npc_fixture.py
"""
import json
import math
import os

HERE = os.path.dirname(os.path.abspath(__file__))
N, S = 7, 15000                     # nodes per axis, spacing (cm)
COAST = 72000                       # island radius (cm)
LEGEND = ["wild", "farmland", "forest", "plaza", "civic", "hq", "commercial", "residential", "park", "industrial", "street",
          "oldtown", "downtown", "suburb", "office", "tech", "studio", "finance", "biotech", "media", "logistics", "farm", "water"]
DID = {n: i for i, n in enumerate(LEGEND)}
# cell (i, j) district: MAP[j] (j = 0 at the south, -z), letter i (i = 0 at the west, -x)
MAP = ["A U R P U W",
       "U R M V R U",
       "R B C D P R",
       "R F D L C R",
       "U R O T R U",
       "A U R R U W"]
LETTER = {"R": "residential", "U": "suburb", "D": "downtown", "L": "oldtown", "C": "commercial", "P": "park",
          "O": "office", "T": "tech", "V": "studio", "F": "finance", "B": "biotech", "M": "media", "W": "logistics",
          "A": "farm"}
ZONE_TIER = {"office": 3, "tech": 3, "studio": 4}
# (cell i, cell j, sub-lot) -> (site kind, tier)
SITES = {
    (2, 3, 0): ("townhall", 1), (3, 3, 0): ("market", 1), (3, 2, 1): ("police", 1), (2, 2, 2): ("fire", 1),
    (1, 4, 0): ("clinic", 2), (4, 1, 0): ("clinic", 2), (4, 4, 1): ("school", 2), (1, 1, 1): ("hospital", 3),
    (4, 3, 1): ("university", 3), (2, 2, 0): ("mall", 3), (3, 2, 0): ("bank", 2), (3, 3, 1): ("library", 2),
    (2, 3, 1): ("post", 2), (3, 2, 2): ("transit", 2), (0, 4, 0): ("stadium", 5),
    (2, 4, 0): ("office", 3), (3, 4, 0): ("campus", 3), (3, 1, 0): ("studio", 4), (1, 3, 0): ("finance", 3),
    (1, 2, 0): ("biotech", 3), (2, 1, 0): ("media", 3), (5, 0, 0): ("warehouse", 4), (0, 5, 0): ("farm", 4),
}
Y = 50


def node_xy(i, j):
    jx = ((i * 7 + j * 13) % 9 - 4) * 300
    jz = ((i * 11 + j * 5) % 9 - 4) * 300
    return (i - 3) * S + jx, (j - 3) * S + jz


def ring(i, j):
    return max(abs(i - 3), abs(j - 3))


def node_tier(i, j):
    return [1, 1, 2, 4][ring(i, j)]


def arterial(i0, j0, i1, j1):
    return (j0 == j1 == 3) or (i0 == i1 == 3)


def width_of(art):
    return (2000, 300) if art else (1400, 250)


def inset_quad(pts, hws):
    """Quad pts (CCW, cm) with side k (pts[k] -> pts[k+1]) moved inward by hws[k]; corners re-intersected."""
    lines = []
    for k in range(4):
        (ax, az), (bx, bz) = pts[k], pts[(k + 1) % 4]
        dx, dz = bx - ax, bz - az
        L = math.hypot(dx, dz)
        nx, nz = -dz / L, dx / L                      # inward for a CCW quad (left of the side)
        lines.append(((ax + nx * hws[k], az + nz * hws[k]), (dx, dz)))
    out = []
    for k in range(4):
        (p, d), (q, e) = lines[k - 1], lines[k]
        den = d[0] * e[1] - d[1] * e[0]
        t = ((q[0] - p[0]) * e[1] - (q[1] - p[1]) * e[0]) / den
        out.append((p[0] + d[0] * t, p[1] + d[1] * t))
    return out


def area(poly):
    return sum(poly[k][0] * poly[(k + 1) % len(poly)][1] - poly[(k + 1) % len(poly)][0] * poly[k][1] for k in range(len(poly))) / 2


def lerp(a, b, t):
    return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)


def bilerp(q, u, v):
    return lerp(lerp(q[0], q[1], u), lerp(q[3], q[2], u), v)


def shrink(poly, cm):
    cx = sum(p[0] for p in poly) / len(poly)
    cz = sum(p[1] for p in poly) / len(poly)
    out = []
    for x, z in poly:
        dx, dz = cx - x, cz - z
        L = math.hypot(dx, dz)
        out.append((x + dx / L * cm, z + dz / L * cm))
    return out


def ipoly(poly):
    return [[int(round(x)), int(round(z))] for x, z in poly]


def bbox(poly):
    xs, zs = [p[0] for p in poly], [p[1] for p in poly]
    return {"x": (min(xs) + max(xs)) // 2, "z": (min(zs) + max(zs)) // 2, "w": max(xs) - min(xs), "d": max(zs) - min(zs)}


def main():
    nodes, nid = [], {}
    for j in range(N):
        for i in range(N):
            x, z = node_xy(i, j)
            nid[(i, j)] = len(nodes)
            nodes.append({"id": len(nodes), "x": x, "y": Y, "z": z})
    edges, eid = [], {}

    def add_edge(a, b):
        art = arterial(a[0], a[1], b[0], b[1])
        w, walk = width_of(art)
        na, nb = nodes[nid[a]], nodes[nid[b]]
        mid = [(na["x"] + nb["x"]) // 2, Y, (na["z"] + nb["z"]) // 2]
        e = {"id": len(edges), "a": nid[a], "b": nid[b], "class": "arterial" if art else "local", "width": w, "walk": walk,
             "lanes": 2 if art else 1, "ref": None, "name": "", "points": [[na["x"], Y, na["z"]], mid, [nb["x"], Y, nb["z"]]],
             "min_tier": max(node_tier(*a), node_tier(*b))}
        eid[(a, b)] = eid[(b, a)] = e["id"]
        edges.append(e)

    for j in range(N):
        for i in range(N):
            if i + 1 < N:
                add_edge((i, j), (i + 1, j))
            if j + 1 < N:
                add_edge((i, j), (i, j + 1))

    blocks, lots, sites = [], [], []
    for j in range(N - 1):
        for i in range(N - 1):
            corners = [(i, j), (i + 1, j), (i + 1, j + 1), (i, j + 1)]   # CCW in (x, z)
            pts = [node_xy(*c) for c in corners]
            hws = [edges[eid[(corners[k], corners[(k + 1) % 4])]]["width"] / 2 for k in range(4)]
            q = inset_quad(pts, hws)
            assert area(q) > 0
            dname = LETTER[MAP[j].split()[i]]
            tier = max(node_tier(*c) for c in corners)
            bp = ipoly(q)
            b = {"id": len(blocks), "i": i, "j": j, "district": DID[dname], "poly": bp}
            b.update(bbox(bp))
            blocks.append(b)
            for sub, (u0, v0) in enumerate([(0, 0), (0.5, 0), (0.5, 0.5), (0, 0.5)]):
                sq = [bilerp(q, u0, v0), bilerp(q, u0 + 0.5, v0), bilerp(q, u0 + 0.5, v0 + 0.5), bilerp(q, u0, v0 + 0.5)]
                lp = ipoly(shrink(sq, 150))
                # the door faces the block side the lot touches: south (side 0) or north (side 2)
                k = 0 if v0 == 0 else 2
                (ax, az), (bx, bz) = q[k], q[(k + 1) % 4]
                L = math.hypot(bx - ax, bz - az)
                front = [int(round((bz - az) / L * 65536)), int(round(-(bx - ax) / L * 65536))]   # outward = right of the CCW side
                mt = max(tier, ZONE_TIER.get(dname, 1))
                if ring(i, j) >= 2 and sub == 3 and (i == 0 or i == N - 2 or j == 0 or j == N - 2):
                    mt = 5
                cx = sum(p[0] for p in lp) // 4
                cz = sum(p[1] for p in lp) // 4
                grow = int(math.hypot(cx, cz)) // 100
                if (i, j, sub) in SITES:
                    kind, st = SITES[(i, j, sub)]
                    s = {"id": "%s:%d" % (kind, sum(1 for x in sites if x["kind"] == kind)), "kind": kind, "block": b["id"],
                         "y": Y, "facing": "north", "tier": max(st, tier), "poly": lp, "front": front}
                    s.update(bbox(lp))
                    sites.append(s)
                    continue
                lot = {"id": len(lots), "block": b["id"], "kind": "building", "district": DID[dname], "facing": "north",
                       "door": [cx, Y, cz], "floors": 2 + (len(lots) % 4), "rank": len(lots), "tier": 0,
                       "poly": lp, "front": front, "grow": grow, "min_tier": mt}
                lot.update(bbox(lp))
                lots.append(lot)
    # growth rank: nearest the core first
    for r, lot in enumerate(sorted(lots, key=lambda l: (l["grow"], l["id"]))):
        lot["grow"] = r

    # bus stops at the middle of every arterial edge, on its left sidewalk
    stops = {"row": [], "col": []}
    for line, keyf in (("row", lambda k: ((k, 3), (k + 1, 3))), ("col", lambda k: ((3, k), (3, k + 1)))):
        for k in range(N - 1):
            a, b = keyf(k)
            e = edges[eid[(a, b)]]
            (ax, _, az), (bx, _, bz) = e["points"][0], e["points"][-1]
            L = math.hypot(bx - ax, bz - az)
            nx, nz = (bz - az) / L, -(bx - ax) / L
            off = e["width"] / 2 - e["walk"] / 2
            x, z = int(round((ax + bx) / 2 + nx * off)), int(round((az + bz) / 2 + nz * off))
            sid = "busstop:%d" % sum(len(v) for v in stops.values())
            sites.append({"id": sid, "kind": "busstop", "block": -1, "x": x, "y": Y, "z": z, "w": 300, "d": 200,
                          "facing": "north", "tier": 2, "poly": [[x - 150, z - 100], [x + 150, z - 100], [x + 150, z + 100], [x - 150, z + 100]],
                          "front": [0, 65536]})
            stops[line].append(sid)
    transit = {"lines": [
        {"id": "bus-1", "kind": "bus", "tier": 2, "stops": stops["row"], "path": [nid[(k, 3)] for k in range(N)]},
        {"id": "bus-2", "kind": "bus", "tier": 2, "stops": stops["col"], "path": [nid[(3, k)] for k in range(N)]}]}

    coast = [[int(round(COAST * math.cos(a * math.pi / 24))), int(round(COAST * math.sin(a * math.pi / 24)))] for a in range(48)]
    size = 160000
    cell, n = 800, size // 800
    kinds = []
    for zj in range(n):
        for xi in range(n):
            x, z = -size // 2 + xi * cell + cell // 2, -size // 2 + zj * cell + cell // 2
            k = DID["water"] if x * x + z * z > COAST * COAST else DID["street"]
            for b in blocks:
                if b["x"] - b["w"] // 2 <= x <= b["x"] + b["w"] // 2 and b["z"] - b["d"] // 2 <= z <= b["z"] + b["d"] // 2:
                    k = b["district"]
                    break
            kinds.append(k)
    doc = {"id": "npc-town@2", "seed": "npc-town", "version": 2, "profile": "island", "size_cm": size,
           "layers": {"terrain": {"cell_cm": 80000, "origin_cm": -80000, "n": 3, "heights": [Y] * 9},
                      "districts": {"cell_cm": cell, "origin_cm": -size // 2, "n": n, "kinds": kinds, "legend": LEGEND},
                      "roads": {"nodes": nodes, "edges": edges}, "blocks": blocks, "lots": lots, "sites": sites,
                      "transit": transit,
                      "island": {"coast": coast, "sea_cm": -200, "docks": [], "radius_by_tier": [30000, 40000, 50000, 60000, 70000]}},
           "hashes": {}}
    with open(os.path.join(HERE, "npc_town@2.json"), "w") as f:
        json.dump(doc, f, separators=(",", ":"), sort_keys=True)
        f.write("\n")


if __name__ == "__main__":
    main()
