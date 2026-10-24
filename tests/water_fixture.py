"""A small synthetic @3 world doc with a water layer (HQ 3.15, plan 5.1) for tests/test_hqferries.py and
tests/test_hqboat.py: a canal joined to a marina, a second canal on its own, a park lake with an island, piers of every
kind, a net and three routes (W1 and W2 share a pier; L1 loops the lake). Positions in cm, Q16 fronts, as the
generator writes them. Stdlib only."""
import math

Q = 65536


def _cm(v):
    return int(round(v * 100))


def _rect(x0, z0, x1, z1):
    return [[_cm(x0), _cm(z0)], [_cm(x1), _cm(z0)], [_cm(x1), _cm(z1)], [_cm(x0), _cm(z1)]]


def _circle(cx, cz, r, n):
    return [[_cm(cx + math.sin(a) * r), _cm(cz + math.cos(a) * r)] for a in (i / n * 2 * math.pi for i in range(n))][::-1]


def _pier(pid, body, kind, root, head, w=5):
    """A pier from `root` (3 m inland) to `head` (over the water), in metres."""
    dx, dz = head[0] - root[0], head[1] - root[1]
    ln = math.hypot(dx, dz)
    return {"id": pid, "body": body, "kind": kind, "x": _cm((root[0] + head[0]) / 2), "z": _cm((root[1] + head[1]) / 2),
            "y": 120 if body != "lake:0" else 380, "front": [int(round(dx / ln * Q)), int(round(dz / ln * Q))],
            "len": _cm(ln), "w": _cm(w), "tier": 1}


def synthetic_doc():
    ring = [(-100 + 35 * math.sin(k * math.pi / 4), -200 + 35 * math.cos(k * math.pi / 4)) for k in range(8)]
    nodes = [(-190, 0), (-180, 0), (-40, 0), (60, 0), (100, 0), (160, 0), (160, -50), (200, 0), (200, 50), (210, 0)]
    nodes += ring                                          # 10..17, k = 0 north .. 4 south
    nodes += [(-100, -250), (-100, -150)]                  # 18, 19: the lake piers' heads
    nodes += [(-190, 111), (-150, 111), (-20, 111), (-150, 107)]   # 20..23: the second canal
    edges = [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [5, 7], [7, 8], [7, 9]]
    edges += [[10 + k, 10 + (k + 1) % 8] for k in range(8)] + [[18, 14], [19, 10]]
    edges += [[20, 21], [21, 22], [21, 23]]
    water = {
        "bodies": [
            {"id": "canal:0", "kind": "canal", "poly": _rect(-200, -11, 100, 11), "level": 0, "bed": 400, "edge": "quay",
             "islands": [], "joins": "marina:0", "tier": 1},
            {"id": "marina:0", "kind": "marina", "poly": _rect(100, -60, 220, 60), "level": 0, "bed": 300, "edge": "quay",
             "islands": [], "joins": "sea", "tier": 1},
            {"id": "canal:1", "kind": "canal", "poly": _rect(-200, 100, 0, 122), "level": 0, "bed": 400, "edge": "quay",
             "islands": [], "joins": None, "tier": 1},
            {"id": "lake:0", "kind": "lake", "poly": _circle(-100, -200, 60, 24), "level": 300, "bed": 250, "edge": "bank",
             "islands": [_circle(-100, -200, 10, 10)], "joins": None, "tier": 1},
        ],
        "piers": [
            _pier("pier:0", "canal:0", "waterbus", (-180, -14), (-180, -4)),
            _pier("pier:1", "canal:0", "waterbus", (-40, -14), (-40, -4)),
            _pier("pier:2", "canal:0", "waterbus", (60, 14), (60, 4)),
            _pier("pier:3", "marina:0", "waterbus", (160, -63), (160, -50)),
            _pier("pier:4", "marina:0", "hire", (200, 63), (200, 50)),
            _pier("pier:5", "marina:0", "fuel", (223, 0), (210, 0)),
            _pier("pier:6", "lake:0", "launch", (-100, -263), (-100, -250), 4),
            _pier("pier:7", "lake:0", "hire", (-100, -137), (-100, -150), 4),
            _pier("pier:8", "canal:1", "taxi", (-150, 97), (-150, 107)),
            _pier("pier:9", "canal:1", "taxi", (-20, 125), (-20, 115)),
        ],
        "berths": [{"body": "marina:0", "x": _cm(120 + 9 * i), "z": _cm(40), "front": [0, -Q]} for i in range(5)]
                  + [{"body": "marina:0", "x": _cm(195), "z": _cm(45), "front": [0, -Q]},
                     {"body": "lake:0", "x": _cm(-95), "z": _cm(-152), "front": [0, -Q]}],
        "breakwater": [[_cm(225), _cm(-70)], [_cm(240), _cm(-70)]],
        "lighthouse": [_cm(240), _cm(-70)],
        "office": "harbour:0",
        "net": {"nodes": [[_cm(x), _cm(z)] for x, z in nodes], "edges": edges},
        "routes": [
            {"id": "W1", "kind": "waterbus", "piers": ["pier:0", "pier:1", "pier:2"], "path": [1, 2, 3], "loop": False, "tier": 1},
            {"id": "W2", "kind": "waterbus", "piers": ["pier:2", "pier:3"], "path": [3, 4, 5, 6], "loop": False, "tier": 1},
            {"id": "L1", "kind": "launch", "piers": ["pier:6"], "path": [18, 14, 15, 16, 17, 10, 11, 12, 13, 14, 18], "loop": True, "tier": 1},
        ],
    }
    coast = _circle(0, 0, 420, 64)
    return {
        "id": "user:synthetic-water@3", "seed": "user:synthetic-water@3", "version": 3, "profile": "island", "size_cm": 90000,
        "layers": {
            "terrain": {"step_cm": 1000, "w": 2, "h": 2, "heights": [0, 0, 0, 0], "origin": [-45000, -45000]},
            "roads": {"nodes": [], "edges": []}, "lots": [], "blocks": [], "districts": [],
            "sites": [{"id": "harbour:0", "kind": "harbour", "x": _cm(160), "z": _cm(75), "w": 1200, "d": 900}],
            "island": {"coast": coast, "sea_cm": 0, "docks": [], "radius_by_tier": [400, 400, 400, 400, 400]},
            "water": water,
        },
        "hashes": {"world": "synthetic"},
    }
