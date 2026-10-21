#!/usr/bin/env python3
"""Headless acceptance of the Commons airport (docs/plans/airport-spec.md section 12). Headless Chrome only, through
tools/ui_smoke.py's DevTools-pipe driver (HQ_GL=metal for GPU speed; HQ_PROFILE: the profile directory).

    python3 tools/airport_smoke.py <base url> <out dir> [steps]

steps (comma separated, default all): spawn, map, threshold, gallery, curb, walk, apron, final, sim, flight, night.
Writes <out dir>/*.png and <out dir>/report.json; prints one line per shot. Look at every PNG yourself.
Numeric checks: no page errors, every view's HQ3D_DEBUG.stats().drawCalls under ui_smoke.MAX_DRAW_CALLS, the spawn
view's airport at level 1 adding <= 30 renderer draw calls (its groups hidden vs shown), air.perf() <= 1 ms at the apron, the flown roll on the runway's centreline, no two aircraft on top of
each other over simulated minutes. Exit code 1 when a check fails.
"""
import importlib.util, json, math, os, sys, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
spec = importlib.util.spec_from_file_location("ui_smoke", os.path.join(ROOT, "tools", "ui_smoke.py"))
smoke = importlib.util.module_from_spec(spec); spec.loader.exec_module(smoke)

BASE, OUT = sys.argv[1].rstrip("/"), sys.argv[2]
ALL = ["spawn", "map", "threshold", "gallery", "curb", "walk", "apron", "final", "sim", "flight", "night"]
STEPS = sys.argv[3].split(",") if len(sys.argv) > 3 else ALL
os.makedirs(OUT, exist_ok=True)
FAILS, ROWS = [], []
SPAWN_EXTRA = 30          # the airport's share of the spawn view (level 1)


def fail(msg):
    FAILS.append(msg); print("FAIL", msg, flush=True)


class Page(smoke.Page):
    def __init__(self, chrome, url):
        self.c = chrome
        self.target = chrome.call("Target.createTarget", {"url": "about:blank"})["targetId"]
        self.sid = chrome.call("Target.attachToTarget", {"targetId": self.target, "flatten": True})["sessionId"]
        for m in ("Runtime.enable", "Page.enable"):
            chrome.call(m, session=self.sid)
        w, h = chrome.size
        chrome.call("Emulation.setDeviceMetricsOverride", {"width": w, "height": h, "deviceScaleFactor": 1, "mobile": False}, session=self.sid)
        chrome.call("Page.addScriptToEvaluateOnNewDocument", {"source": smoke.PRELUDE + "\ntry{localStorage.setItem('hq_ws_asked','1')}catch(e){}\n"}, session=self.sid)
        chrome.call("Page.navigate", {"url": url}, session=self.sid)

    def j(self, expr):
        v = self.eval("JSON.stringify(%s)" % expr)
        return json.loads(v) if v else None

    def key(self, k, code, down=True):
        vk = ord(k.upper()) if len(k) == 1 else 0
        self.c.call("Input.dispatchKeyEvent", {"type": "keyDown" if down else "keyUp", "key": k, "code": code, "windowsVirtualKeyCode": vk}, session=self.sid)


# hide the Lobby's voice card if it overlaps the City; read the whole view's draw calls (forcing a render when 0)
HIDE = """(function(){var c=[].slice.call(document.querySelectorAll('div,section,aside')).filter(function(e){var t=e.textContent||'';
  var r=e.getBoundingClientRect();return t.indexOf('Join voice')>=0&&t.indexOf('Lobby')>=0&&r.width>0&&r.width<420;});
  c.forEach(function(e){e.style.visibility='hidden'});return c.length;})()"""
STATS = "(function(){var s=HQ3D_DEBUG.stats()||{};var a=HQV.hqCity3d.air;return {dc:s.drawCalls,tri:s.triangles,level:a&&a.level?a.level():null,perf:a&&a.perf?a.perf():null,err:(HQ3D.inst&&null)||null}})()"
AIR = "HQV.hqCity3d.air"


def frame_dc(pg, wait=6.5):
    """The whole view's draw calls and triangles from the renderer (hq3d logs them every 5 s with hqperf=1): the
    first line logged after this call, so it measures the view as it stands now."""
    n0 = len(pg.console("hq-frame")); end = time.time() + wait
    while time.time() < end:
        L = pg.console("hq-frame")
        if len(L) > n0:
            try:
                return json.loads(L[-1].split(" ", 1)[1])
            except (ValueError, IndexError):
                return None
        time.sleep(0.25)
    return None


def shot(pg, name, note="", measure=True):
    pg.eval(HIDE); time.sleep(0.4)
    fr = frame_dc(pg) if measure else None
    path = os.path.join(OUT, name + ".png")
    pg.screenshot(path)
    st = pg.j(STATS) or {}
    row = {"name": name, "note": note, "dc": (fr or {}).get("dc"), "tri": (fr or {}).get("tri"), "ms": (fr or {}).get("ms"),
           "tiles": st.get("dc"), "level": st.get("level"), "perf": st.get("perf"),
           "state": pg.j(AIR + ".state()"), "errors": pg.errors(), "probe": pg.j("HQ3D_DEBUG.probe()")}
    ROWS.append(row)
    print("SHOT", name, json.dumps({k: row[k] for k in ("note", "dc", "tri", "ms", "tiles", "level", "perf", "errors")}), flush=True)
    if row["errors"]:
        fail("%s: page errors %s" % (name, row["errors"][:3]))
    # the view gate is ui_smoke's: HQ3D_DEBUG.stats().drawCalls (the City's tiles) under MAX_DRAW_CALLS; dc is the
    # renderer's whole frame (shadow pass, residents, traffic and the airport included), for the airport's share
    if not row["tiles"]:
        fail("%s: HQ3D_DEBUG.stats().drawCalls read %r (a failed measurement)" % (name, row["tiles"]))
    elif row["tiles"] >= smoke.MAX_DRAW_CALLS:
        fail("%s: %d draw calls (>= %d)" % (name, row["tiles"], smoke.MAX_DRAW_CALLS))
    if measure and not row["dc"]:
        fail("%s: the renderer's draw calls read %r" % (name, row["dc"]))
    return row


def open_city(b, night=False, at=None, yaw=0.0):
    url = BASE + "/?hqsmoke=1&hqperf=1&cam=chase" + ("&night=1" if night else "") + ("&at=%s,%s&yaw=%s" % (at[0], at[1], yaw) if at else "")
    pg = Page(b, url)
    smoke.parse_smoke(pg.wait_smoke(150))
    end = time.time() + 60
    while time.time() < end and not pg.j(AIR + " && " + AIR + ".layout && " + AIR + ".layout() ? 1 : 0"):
        time.sleep(1)
    time.sleep(4)
    err = pg.eval("window.HQV && HQV.hqCity3d && HQV.hqCity3d.air ? '' : 'no air hooks'")
    if err:
        fail(err)
    return pg


def aerial(pg, x, y, z, yaw, wait=2.5):
    """A helicopter hovering at (x, y, z) facing yaw: the chase camera behind it is an aerial view."""
    pg.eval("HQ3D_DEBUG.mode('chase')"); pg.eval("HQ3D_DEBUG.teleport(-600, 60, 0)"); time.sleep(0.5)
    pg.eval("HQ3D_DEBUG.ride('heli')"); time.sleep(1)
    pg.eval("HQ3D_DEBUG.fly(%f, %f, %f, %f)" % (x, y, z, yaw)); time.sleep(wait)
    pg.eval("HQ3D_DEBUG.fly(%f, %f, %f, %f)" % (x, y, z, yaw)); time.sleep(0.6)


def go(pg, x, z, yaw, mode="chase", wait=3.0):
    pg.eval("HQ3D_DEBUG.mode(%s)" % json.dumps(mode)); time.sleep(0.4)
    pg.eval("HQ3D_DEBUG.teleport(%f,%f,%f)" % (x, z, yaw)); time.sleep(wait)


def main():
    chrome = smoke.find_chrome()
    prof = os.environ.get("HQ_PROFILE") or os.path.join(OUT, "chrome-profile")
    b = smoke.Chrome(chrome, prof, size=(1280, 800))
    rep = {}
    try:
        day = [s for s in STEPS if s != "night"]
        if day:
            pg = open_city(b)
            L = pg.j(AIR + ".layout()")
            if not L or not L.get("ok"):
                fail("no airfield layout on the Commons"); return rep
            rep["layout"] = {"RU": L["frame"]["RU"], "y": L["y"], "stands": len(L["stands"])}
            if "spawn" in STEPS:
                r = shot(pg, "01-spawn", "the spawn view: the airport at level 1")
                if r["level"] != 1:
                    fail("spawn: airport level %r (want 1)" % r["level"])
                hid = pg.j("(function(){var m=%s.modules();[m.ground,m.buildings,m.vehicles,m.fleet&&m.fleet.jet,m.fleet&&m.fleet.commuter].forEach(function(o){if(o&&o.g)o.g.visible=false});return 1})()" % AIR)
                # the renderer's frame moves with the residents and the traffic: the smaller of two readings each way
                lo = lambda a, b: a if not b or (a and a["dc"] <= b["dc"]) else b
                fr0 = lo(frame_dc(pg), frame_dc(pg))
                pg.j("(function(){var m=%s.modules();[m.ground,m.buildings,m.fleet&&m.fleet.jet,m.fleet&&m.fleet.commuter].forEach(function(o){if(o&&o.g)o.g.visible=true});return 1})()" % AIR)
                fr1 = lo(frame_dc(pg), frame_dc(pg))
                rep["spawnShare"] = {"without": fr0, "with": fr1}
                print("SPAWN share", fr0, fr1, flush=True)
                if fr0 and fr1 and fr1["dc"] - fr0["dc"] > SPAWN_EXTRA:
                    fail("spawn: the airport adds %d draw calls (> %d)" % (fr1["dc"] - fr0["dc"], SPAWN_EXTRA))
                mods = pg.j("(function(){var m=%s.modules();var H=HQV.hqMerge;function dc(o){return o&&o.g&&H?H.drawCount(o.g):null}"
                            "return {ground:dc(m.ground),buildings:dc(m.buildings),vehicles:dc(m.vehicles),fleet:m.fleet?dc(m.fleet.jet)+dc(m.fleet.commuter):null}})()" % AIR)
                rep["spawnModules"] = mods
                print("MODULES spawn", mods, flush=True)
                tot = sum(v for v in (mods or {}).values() if v)
                if tot > SPAWN_EXTRA:
                    fail("spawn: airport draws %d calls at level 1 (> %d)" % (tot, SPAWN_EXTRA))
            if "map" in STEPS:
                go(pg, -700, 0, 0, "map", 4); shot(pg, "02-map", "map view on the airfield")
            if "threshold" in STEPS:
                E = L["runway"]["ends"][0]
                go(pg, E["thr"][0], E["thr"][1] - 4, 0.0, "chase", 4); shot(pg, "03-threshold36", "threshold 36, looking +z down the runway")
            if "gallery" in STEPS:
                g = pg.j(AIR + ".stand()")
                rep["stand"] = g
                if g and g.get("gate"):
                    gt = g["gate"]
                    pg.eval("HQ3D_DEBUG.mode('chase')"); pg.eval(AIR + ".gate('4')"); time.sleep(4)
                    p = pg.j("HQ3D_DEBUG.probe()")
                    if p and abs(p["y"] - gt["y"]) > 0.6:
                        fail("gallery: avatar y %.2f, gate floor %.2f" % (p["y"], gt["y"]))
                    shot(pg, "04-gallery", "gallery at stand 4, the apron")
                    aerial(pg, gt["x"] - 60, 45, gt["z"] - 90, -0.6); shot(pg, "05-apron-aerial", "the contact stands from the air")
                    aerial(pg, -900, 260, -700, 0.25); shot(pg, "05b-airfield-aerial", "the whole airfield from the south")
                else:
                    fail("no gate spot")
            if "curb" in STEPS:
                g = pg.j(AIR + ".stand()")
                d = g["door"]
                go(pg, d["x"] + math.sin(d["yaw"]) * 30, d["z"] + math.cos(d["yaw"]) * 30, d["yaw"] + math.pi, "chase", 4)
                shot(pg, "06-curb", "the curb, the canopy, the hall")
            if "walk" in STEPS:
                rep["walk"] = walk(pg, L)
            if "apron" in STEPS:
                aerial(pg, -560, 110, 120, -2.1, 4)
                r = shot(pg, "07-apron-overview", "the terminal, skybridge, concourse and apron from over the city's edge")
                time.sleep(3)
                pf = pg.j(AIR + ".perf()")
                rep["perf"] = pf
                print("PERF", pf, flush=True)
                if pf and pf["avg"] > 1.0:
                    fail("air.perf() avg %.2f ms (> 1 ms)" % pf["avg"])
            if "final" in STEPS or "apron" in STEPS:
                final(pg, "16-short-final")
            if "sim" in STEPS:
                rep["sim"] = sim(pg, L)
            if "flight" in STEPS:
                rep["flight"] = flight(pg, L)
            pg.close()
        if "night" in STEPS:
            pg = open_city(b, night=True)
            shot(pg, "20-night-spawn", "night, the spawn view")
            aerial(pg, -380, 160, 380, -2.2, 4); shot(pg, "21-night-overview", "night, the airfield from over the city")
            aerial(pg, -760, 45, -250, -0.5, 4); shot(pg, "22-night-apron", "night, the apron and concourse")
            final(pg, "23-night-final")
            pg.close()
    finally:
        b.close()
        json.dump({"rows": ROWS, "rep": rep, "fails": FAILS}, open(os.path.join(OUT, "report.json"), "w"), indent=1, default=str)
    return rep


def final(pg, name):
    """Ride the next ambient jet arrival from 25 s before touchdown (chase camera): the approach lights ahead, the
    PAPI, the runway; then leave it."""
    js = """(function(){ var a = HQV.hqCity3d.air, tr = a.traffic(), L = a.layout(), now = Date.now(), A = HQV.hqAir, AF = HQV.hqAirfield;
      var ctx = {L: L, world: 'claude-hq@2', dests: [], cx: 0, cz: 0, farEnd: function(m){ return A.nominalAirport(Math.sin(m.far)*9000, Math.cos(m.far)*9000, [0, 0]); }, islandEnd: function(){ return null; }};
      var mv = AF.timetable('claude-hq@2', [], now, now + 3600000).filter(function(m){ return m.cls === 'jet' && m.type === 'arr'; })[0];
      if(!mv) return null;
      var e = AF.end(L, mv.stand, mv.end, 0, 0, {stopDist: A.stopDist(A.K.jet)}), f = ctx.farEnd(mv), n = A.normEnd(f), p0 = n.dep.push.length ? n.dep.push[0] : n.dep.taxi[0];
      var R = A.route('jet', {world: 'far', x: p0[0], z: p0[1]}, {world: 'claude-hq@2', x: 0, z: 0}, {a: f, b: e});
      a.ride(R, 'The Commons', R.tTD - 25); a.look(0, 0.3); return {tTD: R.tTD, end: mv.end}; })()"""
    r = pg.j(js)
    time.sleep(4)
    row = shot(pg, name, "short final on an arrival %s" % r, measure=False)
    pg.eval("(function(){ var a = HQV.hqCity3d.air; a.skip(1e5); })()"); time.sleep(4)
    p = pg.j("HQ3D_DEBUG.probe()")
    print("ARRIVED at", {k: round(p[k], 2) for k in ("x", "y", "z")}, flush=True)
    if abs(p["y"] - 5.0) > 0.6:
        fail("%s: stepped out at y %.2f, not on the gallery (5.0)" % (name, p["y"]))
    shot(pg, name + "-arrived", "stepped out at the gate", measure=False)
    return row


def walk(pg, L):
    """Curb -> door -> nave -> ramp -> skybridge -> gallery by teleporting along the plan's floors; the avatar's y must
    follow them and never pop up from the ring road."""
    P = pg.j(AIR + ".plan()")
    out = {"samples": []}
    if not P:
        fail("walk: no building plan"); return out
    F = L["frame"]
    def w(u, v): return [F["o"][0] + u * F["B"][0] + v * F["T"][0], F["o"][1] + u * F["B"][1] + v * F["T"][1]]
    yaw = math.atan2(F["B"][0], F["B"][1])
    # step along the nave's centreline in 2 m steps, letting the avatar settle each time (holding W walks it there)
    for u in list(range(-70, 172, 4)):
        x, z = w(u, 0)
        pg.eval("HQ3D_DEBUG.teleport(%f,%f,%f)" % (x, z, yaw)); time.sleep(0.25)
        p = pg.j("HQ3D_DEBUG.probe()")
        out["samples"].append([u, round(p["y"], 2)])
    ys = [s[1] for s in out["samples"]]
    jumps = [(out["samples"][i][0], round(ys[i] - ys[i - 1], 2)) for i in range(1, len(ys)) if abs(ys[i] - ys[i - 1]) > 2.0]
    out["jumps"] = jumps
    print("WALK", json.dumps(out["samples"]), "jumps", jumps, flush=True)
    if jumps:
        fail("walk: the avatar's height jumps %s" % jumps)
    # under the skybridge on Ring Road 5 (u 140): the road, not the bridge
    x, z = w(140, 30)
    pg.eval("HQ3D_DEBUG.teleport(%f,%f,%f)" % (x, z, 0)); time.sleep(0.6)
    x, z = w(140, 0)
    pg.eval("HQ3D_DEBUG.teleport(%f,%f,%f)" % (x, z, 0)); time.sleep(0.6)
    p = pg.j("HQ3D_DEBUG.probe()")
    out["underBridge"] = round(p["y"], 2)
    if p["y"] > 2:
        fail("walk: under the skybridge the avatar stands at %.2f (on the bridge)" % p["y"])
    g = pg.j(AIR + ".stand()")["gate"]
    pg.eval("HQ3D_DEBUG.teleport(%f,%f,%f)" % (g["x"], g["z"], g["yaw"])); time.sleep(1.5)
    shot(pg, "08-walk-gallery", "walked to the gallery")
    return out


def sim(pg, L):
    """The airport's traffic over simulated minutes, numerically: no two aircraft on the ground within 25 m of each
    other unless one is pushing past its neighbour, stand states sane, bridges follow."""
    js = """(function(){
      var A = HQV.hqAir, AF = HQV.hqAirfield, a = HQV.hqCity3d.air, L = a.layout(), now = Date.now(), out = {pairs: 0, minD: 1e9, worst: null, n: 0, states: {}};
      var ctx = {L: L, world: 'claude-hq@2', dests: [], cx: 0, cz: 0,
        farEnd: function(m){ return A.nominalAirport(Math.sin(m.far)*9000, Math.cos(m.far)*9000, [0, 0]); }, islandEnd: function(){ return null; }};
      for(var s = 0; s < 1200; s += 2){
        var tr = A.traffic(AF, ctx, now + s*1000), g = tr.moving.filter(function(e){ return e.pose && !e.pose.air && AF.floorAt(L, e.pose.x, e.pose.z) != null; });
        out.n = Math.max(out.n, tr.moving.length);
        Object.keys(tr.stands).forEach(function(k){ var st = tr.stands[k].state; out.states[st] = (out.states[st] || 0) + 1; });
        for(var i = 0; i < g.length; i++) for(var j = i + 1; j < g.length; j++){
          var d = Math.hypot(g[i].pose.x - g[j].pose.x, g[i].pose.z - g[j].pose.z); out.pairs++;
          if(d < out.minD){ out.minD = d; out.worst = {t: s, a: g[i].id + ':' + g[i].pose.phase, b: g[j].id + ':' + g[j].pose.phase}; }
        }
      }
      return out; })()"""
    r = pg.j(js)
    print("SIM", r, flush=True)
    if r and r["minD"] < 25:
        fail("sim: two ground aircraft %.1f m apart %s" % (r["minD"], r["worst"]))
    aerial(pg, -790, 35, -60, -1.9, 3)
    shot(pg, "09-apron-traffic", "apron with traffic and vehicles")
    return r


def flight(pg, L):
    """Book the Isle Hopper (or ride a jet's route) and follow it: phases in order, the roll on the centreline."""
    out = {}
    pg.eval("%s.board(null)" % AIR); time.sleep(6)
    st = pg.j(AIR + ".state()")
    out["booked"] = st
    print("BOOKED", st, flush=True)
    if not st or st.get("kind") is None:
        fail("flight: booking gave no flight (%s)" % st); return out
    if st["kind"] != "amphib":
        fail("flight: booked a %s, want the Isle Hopper" % st["kind"])
    pg.eval(AIR + ".skip(0)"); time.sleep(2)
    phases, track = [], []
    rwy = L["lines"]["RWY"]
    def off_rwy(x, z):
        a, b = rwy[0], rwy[1]; dx, dz = b[0] - a[0], b[1] - a[1]; l = math.hypot(dx, dz)
        return abs((x - a[0]) * dz - (z - a[1]) * dx) / l
    shots = {"pushback": "10-pushback", "taxi": "11-taxi", "hold": "12-hold", "lineup": "13-lineup", "takeoff": "14-takeoff", "climb": "15-climb"}
    for i in range(900):
        s = pg.j(AIR + ".state()")
        if not s or s.get("phase") is None:
            print("FLIGHT state ended", s, pg.errors()[-3:], flush=True)
            break
        ph = s["phase"]
        if not phases or phases[-1] != ph:
            phases.append(ph)
            if ph in shots:
                time.sleep(1.0); shot(pg, shots.pop(ph), "flight phase " + ph, measure=False)
        if ph == "takeoff":
            track.append(round(off_rwy(s["x"], s["z"]), 3))
        if ph in ("cruise", "descent"):
            break
        pg.eval(AIR + ".skip(%f)" % (1.0 if ph in ("taxi", "pushback") else 0.5)); time.sleep(0.12)
    out["phases"] = phases
    out["rollOff"] = max(track) if track else None
    print("FLIGHT phases", phases, "roll off-centreline max", out["rollOff"], flush=True)
    want = ["pushback", "taxi", "hold", "lineup", "takeoff"]
    if [p for p in phases if p in want][:5] != want:
        fail("flight: phases %s" % phases)
    if out["rollOff"] is None or out["rollOff"] > 0.5:
        fail("flight: the roll is %s m off the runway centreline" % out["rollOff"])
    return out


if __name__ == "__main__":
    main()
    print("DONE", "FAILS" if FAILS else "OK", json.dumps(FAILS), flush=True)
    sys.exit(1 if FAILS else 0)
