#!/usr/bin/env python3
"""Graphics tour (City Gen v4 phase 11, HQ 3.34.0): the frame budgets at the City's busiest new pieces.

    python3 tools/graphics_tour.py [path/to/claudehq] [OUT_DIR | --out OUT_DIR]

Starts the HQ server against a throwaway HQ folder and the fake Arena of tools/ui_smoke.py (the @3 fixtures), opens
`/?hqsmoke=1&hqperf=1` once in headless Chrome (never a visible window, a free port, never 8765), and moves through
fixed spots on the @3 Commons, derived from the fixture the way ui_smoke's spots() is:

  trumpet       a trumpet interchange (a road node with junction "ramps"), from above
  flyover       a flyover deck (the middle of a v4 "flyover" edge), from the side
  boulevard     the City Line boulevard (a v4 "boulevard" edge), along it
  tram-bed      a tram centre bed (an edge with bed > 0), along it
  tram-platform a tram station platform (a tramstop site 40 m long, w == 4000)
  tunnel        inside the ring's road tunnel (world.js tunnelsOf, at the tunnel road's height), in the page
  cutting       the ring's cutting down to the tunnel (tunnelsOf too)
  signals       a signal junction (junction "signals", the one nearest the plaza)
  plaza         the plaza in front of the fountain
  metro         an underground metro station (HQ3D_DEBUG.transit, below the street)
  hq-lot        your HQ lot (rank 0, the fake Arena's "you"), at its door

At each it saves NN-name.png and records the frame's draw calls (the renderer's own count, the shadow pass included)
and triangles, and fails on more than 1,200 calls a frame (240 below the street), 1.5 M triangles, or any page error.
Writes graphics_tour.json beside the shots (default: a new temp dir) and prints a table. Stdlib only.
The budgets are the plan's, sized for an M3 Pro and up: docs/plans/city-gen-v4.md, phase 11.
"""
import json
import math
import os
import shutil
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))
OUT, BIN = None, None
_a = sys.argv[1:]
_i = 0
while _i < len(_a):
    if _a[_i] == "--out" and _i + 1 < len(_a):
        OUT = _a[_i + 1]; _i += 2; continue
    if not _a[_i].startswith("--"):
        if BIN is None:
            BIN = _a[_i]
        elif OUT is None:
            OUT = _a[_i]
    _i += 1
sys.argv = [sys.argv[0]] + ([BIN] if BIN else [])
import ui_smoke as U  # noqa: E402  (its server, fake Arena and Chrome driver)

MAX_FRAME = U.MAX_FRAME_CALLS       # 1,200 a frame on the surface
MAX_UNDER = U.MAX_UNDER_CALLS       # 240 below the street
MAX_TRI = U.MAX_TRIANGLES           # 1.5 M
SETTLE = 12.0                       # seconds a spot may take to build its tiles (the draw calls stop changing)


def _mid(points):
    """The middle (by length) of a polyline in cm -> (x, y, z) m and the unit direction (dx, dz) there."""
    P = [(p[0] / 100.0, p[1] / 100.0, p[2] / 100.0) for p in points]
    seg = [math.hypot(b[0] - a[0], b[2] - a[2]) for a, b in zip(P, P[1:])]
    half, s = sum(seg) / 2, 0.0
    for (a, b), l in zip(zip(P, P[1:]), seg):
        if s + l >= half and l > 1e-6:
            f = (half - s) / l
            return (a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f), ((b[0] - a[0]) / l, (b[2] - a[2]) / l)
        s += l
    a, b = P[0], P[-1]
    l = math.hypot(b[0] - a[0], b[2] - a[2]) or 1.0
    return a, ((b[0] - a[0]) / l, (b[2] - a[2]) / l)


def _along(c, d, back, up, ahead=10.0, look_up=1.0, side=0.0):
    """A camera `back` m behind c along d (and `side` m to its right), `up` m over c, looking `ahead` m past it."""
    (x, y, z), (dx, dz) = c, d
    rx, rz = dz, -dx
    pos = [round(x - dx * back + rx * side, 2), round(y + up, 2), round(z - dz * back + rz * side, 2)]
    look = [round(x + dx * ahead, 2), round(y + look_up, 2), round(z + dz * ahead, 2)]
    return pos, look


def _yaw(d):
    return round(math.atan2(d[0], d[1]), 3)


def tour_spots(world_bytes):
    """The fixed spots in scene metres, from the @3 fixture: [(name, caption, spec)]. spec: {at: (x, z), yaw, pos, look}
    (a held camera when pos is set) or {metro: True}; the tunnel and cutting come from the page (spec {tunnel: kind})."""
    d = json.loads(world_bytes)
    roads = d["layers"]["roads"]
    nodes = {n["id"]: n for n in roads["nodes"]}
    edges = roads["edges"]
    out = []

    def edge_spot(name, caption, e, back, up, side=0.0, look_up=1.0, ahead=10.0):
        c, dr = _mid(e["points"])
        pos, look = _along(c, dr, back, up, ahead=ahead, look_up=look_up, side=side)
        out.append((name, caption + " (edge %s, %s)" % (e["id"], e.get("name") or e["class"]),
                    {"at": (round(c[0], 1), round(c[2], 1)), "yaw": _yaw(dr), "pos": pos, "look": look}))

    def node_spot(name, caption, n, back, up):
        ends = [e for e in edges if e["a"] == n["id"] or e["b"] == n["id"]]
        dr = (0.0, 1.0)
        if ends:
            e = ends[0]
            p = e["points"] if e["a"] == n["id"] else e["points"][::-1]
            dx, dz = p[1][0] - p[0][0], p[1][2] - p[0][2]
            l = math.hypot(dx, dz) or 1.0
            dr = (dx / l, dz / l)
        c = (n["x"] / 100.0, n["y"] / 100.0, n["z"] / 100.0)
        # from behind and to one side, so the junction's arms are in the picture
        pos, look = _along(c, dr, back, up, ahead=0.0, look_up=0.0, side=back * 0.6)
        out.append((name, caption + " (node %s)" % n["id"], {"at": (round(c[0], 1), round(c[2], 1)), "yaw": _yaw(dr), "pos": pos, "look": look}))

    ramps = sorted((n for n in roads["nodes"] if n.get("junction") == "ramps"), key=lambda n: (abs(n["y"]), n["id"]))
    if ramps:
        node_spot("trumpet", "Trumpet interchange from above", ramps[0], 70.0, 45.0)
    fly = [e for e in edges if e.get("v4") == "flyover"]
    if fly:
        edge_spot("flyover", "Flyover deck from the side", fly[0], 10.0, 9.0, side=32.0)
    blvd = [e for e in edges if e.get("v4") == "boulevard"]
    if blvd:
        # low and off the median, so the City Line's viaduct over it is in the picture, not in front of the lens
        edge_spot("boulevard", "The City Line boulevard", blvd[len(blvd) // 2], 30.0, 3.5, side=9.0, look_up=5.0, ahead=25.0)
    bed = [e for e in edges if (e.get("bed") or 0) > 0]
    if bed:
        edge_spot("tram-bed", "Tram centre bed", bed[0], 22.0, 5.0)
    stops = [s for s in d["layers"]["sites"] if s.get("kind") == "tramstop" and s.get("w") == 4000]
    if stops:
        s = stops[0]
        c = (s["x"] / 100.0, (s.get("y") or 0) / 100.0, s["z"] / 100.0)
        p = s.get("poly") or []
        dr = (0.0, 1.0)
        if len(p) >= 2:
            dx, dz = p[1][0] - p[0][0], p[1][1] - p[0][1]
            l = math.hypot(dx, dz) or 1.0
            dr = (dx / l, dz / l)
        pos, look = _along(c, dr, 26.0, 3.5, ahead=0.0, side=6.0)
        out.append(("tram-platform", "Tram station platform (%s)" % s["id"], {"at": (round(c[0], 1), round(c[2], 1)), "yaw": _yaw(dr), "pos": pos, "look": look}))
    out.append(("tunnel", "Inside the ring's road tunnel under the airport", {"tunnel": "tunnel"}))
    out.append(("cutting", "The ring's cutting down to the tunnel portal", {"tunnel": "cutting"}))
    sig = sorted((n for n in roads["nodes"] if n.get("junction") == "signals"), key=lambda n: (n["x"] ** 2 + n["z"] ** 2, n["id"]))
    if sig:
        node_spot("signals", "Signal junction", sig[0], 30.0, 14.0)
    sp = U.spots(world_bytes)
    px, pz = sp["plaza"]
    out.append(("plaza", "The plaza, facing the fountain", {"at": (px, pz), "yaw": round(math.atan2(-px, -pz), 3)}))
    out.append(("metro", "An underground metro station", {"metro": True}))
    if sp.get("spawn"):
        out.append(("hq-lot", "Your HQ lot (rank 0), at its door", {"at": sp["spawn"], "yaw": sp["spawn_yaw"]}))
    return out


def tunnel_spec(t, kind):
    c, dr = (t["x"], t["y"], t["z"]), (t["dx"], t["dz"])
    if kind == "tunnel":            # inside, at the road's height: 2.2 m eyes, looking down the bore
        pos, look = _along(c, dr, 8.0, 2.2, ahead=30.0, look_up=2.0)
    else:                           # in the cutting, over the road, looking on toward the portal
        pos, look = _along(c, dr, 25.0, 5.0, ahead=15.0, look_up=1.0)
    return {"at": (round(c[0], 1), round(c[2], 1)), "yaw": _yaw(dr), "pos": pos, "look": look}


def main():
    t0 = time.time()
    out_dir = OUT or tempfile.mkdtemp(prefix="hq-graphics-tour-")
    os.makedirs(out_dir, exist_ok=True)
    if not os.access(U.BIN, os.X_OK):
        U.fail(f"no claudehq binary at {U.BIN} (cargo build --release --manifest-path dashboard-rs/Cargo.toml)")
    world = U.load_world()
    worlds = U.load_worlds()
    live = worlds.get(U.LIVE_ID)
    if not live:
        U.fail(f"no {U.LIVE_ID} fixture in tests/fixtures")
    spots = tour_spots(live)
    arena = U.FakeArena(world, worlds=worlds)
    tmp = tempfile.mkdtemp(prefix="hq-gtour-")
    root, home = U.make_root(tmp, arena.url)
    server, base, _log = U.start_server(tmp, root, home)
    rows, bad = [], []
    helpers = ""
    for n in ("transit_tour.js", "graphics_tour.js"):
        with open(os.path.join(ROOT, "tools", n), encoding="utf-8") as f:
            helpers += f.read() + ";\n"
    try:
        chrome = U.find_chrome()
        if not chrome:
            U.fail("no Chrome/Chromium found")
        br = U.Chrome(chrome, os.path.join(tmp, "chrome"), size=(1280, 800))
        sx, sz = spots[0][2].get("at", (0.0, 10.5))
        pg = br.open(U.smoke_url(base, "chase", (sx, sz), hqperf=1))
        v = pg.wait_smoke()
        if not v or not v.startswith("ok"):
            U.fail("the City did not come up: " + str(v)[:300], "\n".join(pg.console()[-40:]))
        ev = pg.eval
        ev("Array.prototype.slice.call(document.querySelectorAll('button')).filter(function(b){ return /^Not now$/.test(b.textContent.trim()) && b.offsetParent; }).forEach(function(b){ b.click(); }), 1")
        ev(helpers + "1")
        ev("__tour.hideLobby()")
        ev("__tour.clearSkies()")
        world_id = ev("HQ3D_DEBUG.world()")
        if world_id != U.LIVE_ID:
            U.fail(f"the page built {world_id!r}, not the live Commons {U.LIVE_ID}")
        page_budget = (json.loads(ev("JSON.stringify(HQ3D_DEBUG.stats())") or "{}")).get("budget")
        if page_budget and (page_budget.get("frame"), page_budget.get("under"), page_budget.get("triangles")) != (MAX_FRAME, MAX_UNDER, MAX_TRI):
            U.fail(f"the page's budget {page_budget} is not this gate's ({MAX_FRAME} / {MAX_UNDER})")
        tun = json.loads(ev("__gt.tunnels()") or "{}")
        print(f"world {world_id}; loaded in {time.time() - t0:.0f} s; tunnels {tun}", flush=True)

        def settle():
            """Wait for the tiles round the avatar: the world's draw calls unchanged over two 1 s polls (SETTLE at most)."""
            end, last, same = time.time() + SETTLE, None, 0
            time.sleep(1.5)
            while time.time() < end:
                st = json.loads(ev("JSON.stringify(HQ3D_DEBUG.stats())") or "{}")
                k = (st.get("worldDrawCalls"), st.get("drawCalls"))
                same = same + 1 if k == last else 0
                last = k
                if same >= 2:
                    return
                time.sleep(1.0)

        for i, (name, caption, spec) in enumerate(spots):
            ts = time.time()
            if spec.get("tunnel"):
                t = tun.get(spec["tunnel"]) if isinstance(tun, dict) else None
                if not t:
                    bad.append(f"{name}: the world has no {spec['tunnel']} (tunnelsOf)")
                    print(f"BAD {name}: no {spec['tunnel']} in tunnelsOf", flush=True)
                    continue
                spec = tunnel_spec(t, spec["tunnel"])
            if spec.get("metro"):
                r = ev("__gt.metro()")
            else:
                ax, az = spec["at"]
                r = ev("__gt.go(%s, %s, %s, %s, %s)" % (ax, az, spec.get("yaw", "null"), json.dumps(spec.get("pos")), json.dumps(spec.get("look"))))
            settle()
            st = json.loads(ev("JSON.stringify(HQ3D_DEBUG.stats())") or "{}")
            png = os.path.join(out_dir, "%02d-%s.png" % (i + 1, name))
            pg.screenshot(png)
            errs = pg.errors()
            dc, tri, under = st.get("drawCalls"), st.get("triangles"), bool(st.get("underground"))
            cap = MAX_UNDER if under else MAX_FRAME
            problems = []
            if errs:
                problems.append("page errors: " + "; ".join(str(e)[:160] for e in errs[:3]))
            if not isinstance(dc, (int, float)) or dc <= 0:
                problems.append(f"no draw-call count ({dc!r}): a 0 is a failed measurement")
            elif dc > cap:
                problems.append(f"{dc} draw calls (<= {cap})")
            if isinstance(tri, (int, float)) and tri > MAX_TRI:
                problems.append(f"{tri} triangles (<= {MAX_TRI})")
            if spec.get("metro") and not under:
                problems.append(f"not below the street at {r}")
            row = {"spot": name, "caption": caption, "drawCalls": dc, "triangles": tri, "worldDrawCalls": st.get("worldDrawCalls"),
                   "transitDrawCalls": st.get("transitDrawCalls"), "under": under, "budget": cap, "at": spec.get("at"),
                   "camera": {"pos": spec.get("pos"), "look": spec.get("look")} if spec.get("pos") else None,
                   "errors": errs[:5], "problems": problems, "png": png, "seconds": round(time.time() - ts, 1)}
            rows.append(row)
            if problems:
                bad.append(f"{name}: " + "; ".join(problems))
            print(f"{'ok ' if not problems else 'BAD'} {name:14s} {str(dc):>5} calls (<= {cap:4d}) {str(tri):>8} tris  world {str(st.get('worldDrawCalls')):>4}"
                  f"  {'under' if under else '     '}  {row['seconds']:4.1f} s  {caption}" + ("  <- " + "; ".join(problems) if problems else ""), flush=True)
        pg.close()
        br.close()
    finally:
        U.stop_server(server)
        arena.close()
        shutil.rmtree(tmp, ignore_errors=True)
    secs = round(time.time() - t0, 1)
    with open(os.path.join(out_dir, "graphics_tour.json"), "w") as f:
        json.dump({"budgets": {"frame": MAX_FRAME, "under": MAX_UNDER, "triangles": MAX_TRI}, "seconds": secs, "spots": rows}, f, indent=1)
    print(f"\n{len(rows)} spots in {out_dir} ({secs} s)")
    if bad or len(rows) < len(spots):
        print("problems:\n  " + "\n  ".join(bad or ["fewer spots than planned"]))
        sys.exit(1)
    print("graphics tour passed")


if __name__ == "__main__":
    main()
