"""The airfield's ground, markings, lights and field furniture (games/hqairport3d.js, HQV.hqAirport3d).

node imports the vendored three.js, loads games/world.js, games/hqmerge.js and games/hqairport3d.js against a stub
`window` and a stub hq3d ctx (real THREE objects, canvases as a no-op 2D proxy, as tests/test_hqcivic.py), plans and
builds the Commons airfield from tests/fixtures/airfield_commons.json over the real claude-hq@2 terrain, and reports
paint, lights, fence, masts, signs, PAPI states and draw calls per detail level, day and night. The Python side checks
them against docs/plans/airport-spec.md sections 4, 9 and 11, with its own pavement test (not the module's).
One node process for the whole file. Skipped when node is not installed. Stdlib only."""
import json
import os
import re
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "games", "hqairport3d.js")
NODE = shutil.which("node")

HARNESS = r"""
var fs = require("fs"), url = require("url"), zlib = require("zlib"), root = %(root)s;
import(url.pathToFileURL(root + "/games/vendor/three-module.js").href).then(function(THREE){
  global.window = {HQV: {}};
  ["world", "hqmerge", "hqairport3d"].forEach(function(f){ new Function(fs.readFileSync(root + "/games/" + f + ".js", "utf8"))(); });
  var HQV = window.HQV, A3 = HQV.hqAirport3d, WD = HQV.world, out = {};
  var L = JSON.parse(fs.readFileSync(root + "/tests/fixtures/airfield_commons.json", "utf8"));
  var W = WD.pack(JSON.parse(zlib.gunzipSync(fs.readFileSync(root + "/tests/fixtures/claude-hq@2.json.gz"))));
  var ground = function(x, z){ return WD.heightAt(W, x, z); };

  /* ---------- the stub hq3d ctx (as tests/test_hqcivic.py) ---------- */
  var texts = [];
  var noop2d = new Proxy({}, {get(t, k){ return k === "measureText" ? function(){ return {width: 10}; } : k === "fillText" ? function(s){ texts.push(String(s)); }
    : (k === "createLinearGradient" || k === "createRadialGradient") ? function(){ return {addColorStop(){}}; } : function(){}; }, set(){ return true; }});
  var c = {THREE: THREE, mat: function(col, o){ return new THREE.MeshStandardMaterial(Object.assign({color: col, roughness: 0.7, metalness: 0.08}, o || {})); },
    canvasTex: function(w, h, draw){ if(draw) draw(noop2d, w, h); return {c: null, g: noop2d, t: new THREE.Texture()}; }};

  /* ---------- an independent pavement test, from L alone ---------- */
  function inPoly(P, x, z){ var ins = false; for(var i = 0, j = P.length - 1; i < P.length; j = i++){ var a = P[i], b = P[j];
    if((a[1] > z) !== (b[1] > z) && x < (b[0] - a[0])*(z - a[1])/(b[1] - a[1]) + a[0]) ins = !ins; } return ins; }
  function dSeg(px, pz, a, b){ var dx = b[0] - a[0], dz = b[1] - a[1], l2 = dx*dx + dz*dz, t = l2 ? Math.max(0, Math.min(1, ((px - a[0])*dx + (pz - a[1])*dz)/l2)) : 0;
    return Math.hypot(px - a[0] - dx*t, pz - a[1] - dz*t); }
  function dPoly(px, pz, P){ var d = Infinity; for(var i = 0; i + 1 < P.length; i++) d = Math.min(d, dSeg(px, pz, P[i], P[i + 1])); return d; }
  var Rw = L.runway, E0 = Rw.ends[0], tol = 0.06;
  function runwayLocal(x, z){ var dx = x - E0.thr[0], dz = z - E0.thr[1]; return [dx*E0.dir[0] + dz*E0.dir[1], dx*E0.left[0] + dz*E0.left[1]]; }
  function pave(x, z){
    var r = runwayLocal(x, z);
    if(r[0] >= -Rw.pad - tol && r[0] <= Rw.len + Rw.pad + tol && Math.abs(r[1]) <= Rw.w/2 + Rw.shoulder + tol) return "runway";
    var hw = L.widths.A/2 + L.widths.shoulder + tol;
    for(var k in L.lines) if(k !== "RWY" && dPoly(x, z, L.lines[k]) <= hw) return "taxiway";
    for(var cv in L.curves) if(!/^S/.test(cv) && dPoly(x, z, L.curves[cv]) <= hw) return "taxiway";
    for(var i = 0; i < L.apron.length; i++) if(inPoly(L.apron[i], x, z) || dPoly(x, z, L.apron[i].concat([L.apron[i][0]])) <= tol) return "apron";
    if(dPoly(x, z, L.serviceRoad) <= L.serviceRoadW/2 + tol) return "service";
    var LS = L.landside;
    if(dPoly(x, z, LS.access) <= LS.roadW/2 + tol) return "road";
    // the forecourt loop (a rectangle, mitred corners): its outer box minus its inner box
    var fx = LS.forecourt.map(function(p){ return p[0]; }), fz = LS.forecourt.map(function(p){ return p[1]; }), h = LS.roadW/2 + tol;
    var x0 = Math.min.apply(null, fx), x1 = Math.max.apply(null, fx), z0 = Math.min.apply(null, fz), z1 = Math.max.apply(null, fz);
    if(x >= x0 - h && x <= x1 + h && z >= z0 - h && z <= z1 + h && !(x > x0 + h && x < x1 - h && z > z0 + h && z < z1 - h)) return "road";
    // the curb's sidewalk: 4 m on the terminal side of the curb leg, along the forecourt
    var cx = LS.curb.dropoff[0][0], zs = LS.forecourt.map(function(p){ return p[1]; });
    if(x <= cx - LS.roadW/2 + tol && x >= cx - LS.roadW/2 - 4 - tol && z >= Math.min.apply(null, zs) - tol && z <= Math.max.apply(null, zs) + tol) return "road";
    return null;
  }
  var P = A3.plan(L, {ground: ground}), P2 = A3.plan(L, {ground: ground});
  out.deterministic = JSON.stringify(P) === JSON.stringify(P2);
  out.bad = [A3.plan(null), A3.plan({ok: false, why: "no site"}), A3.create(c, {ok: false})].map(function(v){ return v === null; });

  /* ---------- paint on pavement ---------- */
  var paint = {counts: {}, off: []};
  Object.keys(P.paint).forEach(function(k){
    paint.counts[k] = P.paint[k].length;
    P.paint[k].forEach(function(q){ for(var j = 0; j < 4; j++){ var x = q[j*3], z = q[j*3 + 2];
      if(!pave(x, z) && paint.off.length < 20) paint.off.push([k, +x.toFixed(2), +z.toFixed(2)]); } });
  });
  // airside paint floats over its surface: never below the platform
  paint.minY = Infinity; Object.keys(P.paint).forEach(function(k){ P.paint[k].forEach(function(q){ var x = q[0], z = q[2];
    if(runwayLocal(x, z)[0] > -100 && x < -770) paint.minY = Math.min(paint.minY, q[1], q[4], q[7], q[10]); }); });
  out.paint = paint;

  /* ---------- lights ---------- */
  var lights = P.lights.map(function(l){ var r = runwayLocal(l.x, l.z); return {g: l.g, end: l.end, a: l.a, i: l.i, side: l.side, along: r[0], lat: r[1], x: l.x, z: l.z}; });
  out.lights = lights;
  out.colors = {};
  [0, 1].forEach(function(e){ out.colors[e] = P.lights.map(function(l){ var c = A3.lampColor(Object.assign({len: Rw.len}, l), e, [false, false], true); return c ? c.slice() : null; }); });
  out.colorsBlinkOff = P.lights.map(function(l){ return A3.lampColor(Object.assign({len: Rw.len}, l), 0, [false, false], false); });
  out.colorsHold = P.lights.map(function(l){ return A3.lampColor(Object.assign({len: Rw.len}, l), 0, [true, false], true); });
  out.LIGHT = A3.LIGHT;
  out.papiPlan = P.papi;
  out.papiWhite = [[0, 3.6], [0, 3.4], [1, 3.2], [1, 3.1], [2, 2.9], [2, 2.8], [3, 2.6], [3, 2.4]].map(function(t){ return A3.papiWhite(t[0], t[1]); });
  out.rabbit = P.rabbit;
  out.approach = Rw.ends.map(function(E){ return E.approach; });

  /* ---------- fence, masts, signs ---------- */
  var fence = {n: P.fence.length, onPave: [], nearRoad: [], len: 0};
  P.fence.forEach(function(f){
    var a = f[0], b = f[1], l = Math.hypot(b[0] - a[0], b[1] - a[1]); fence.len += l;
    for(var s = 0; s <= l; s += 0.25){ var x = a[0] + (b[0] - a[0])*s/l, z = a[1] + (b[1] - a[1])*s/l;
      if(pave(x, z) && fence.onPave.length < 10) fence.onPave.push([+x.toFixed(2), +z.toFixed(2), pave(x, z)]);
      if(dPoly(x, z, L.serviceRoad) < L.serviceRoadW/2 + 0.5 && fence.nearRoad.length < 10) fence.nearRoad.push([+x.toFixed(2), +z.toFixed(2)]); }
  });
  out.fence = fence;
  out.masts = P.masts.map(function(m){
    var inBox = L.stands.filter(function(st){ return [[0, 0], [m.r, 0], [-m.r, 0], [0, m.r], [0, -m.r]].some(function(o){ return inPoly(st.box, m.x + o[0], m.z + o[1]); }); }).map(function(st){ return st.id; });
    return {x: m.x, z: m.z, r: m.r, h: m.h, road: dPoly(m.x, m.z, L.serviceRoad) - L.serviceRoadW/2 - m.r, inBox: inBox,
            onPlatform: L.platform.some(function(p){ return inPoly(p, m.x, m.z); })};
  });
  out.signs = P.signs.map(function(s){ var cs = Math.cos(s.yaw), sn = Math.sin(s.yaw);
    var pts = [[0, 0], [1.25, 0], [-1.25, 0]].map(function(o){ return [s.x + cs*o[0], s.z - sn*o[0]]; });
    return {x: s.x, z: s.z, on: pts.map(function(p){ return pave(p[0], p[1]); }).filter(Boolean),
            onPlatform: L.platform.some(function(p){ return inPoly(p, s.x, s.z); })}; });
  out.cells = P.cells; out.edges = P.edges;

  /* ---------- the built group: draw calls per level, day and night; no allocation on a switch ---------- */
  var A = A3.create(c, L, {ground: ground}), draws = {};
  function ids(){ var u = []; A.g.traverse(function(o){ u.push(o.uuid, o.geometry ? o.geometry.uuid : "-", o.material ? o.material.uuid : "-"); }); return u.join(","); }
  var before = ids();
  [false, true].forEach(function(n){ A.setNight(n); [2, 1, 0].forEach(function(lv){ A.setDetail(lv); draws[(n ? "night" : "day") + lv] = HQV.hqMerge.drawCount(A.g); }); });
  out.draws = draws; out.sameObjects = ids() === before;
  A.setNight(false); A.setDetail(2);
  out.stats = A.stats();
  // lamp colours through the mesh: the in-use end flips everything
  A.setRunway(0); out.mesh0 = A.lampColors();
  A.setRunway(1); out.mesh1 = A.lampColors();
  A.setRunway(0); A.setHold(0, true); out.meshHold = A.lampColors(); A.setHold(0, false);
  // PAPI against a camera on the 36 approach: ~3.0 deg (2 white, 2 red), 4.5 deg (all white), 1.5 deg (all red)
  var cam = new THREE.PerspectiveCamera(50, 1, 0.3, 3000), pp = P.papi.filter(function(p){ return p.end === 0; }), mid = pp[1];
  out.papi = {};
  [["on", 3.0], ["high", 4.5], ["low", 1.5]].forEach(function(t){
    var d = 2000; cam.position.set(E0.thr[0], mid.y + d*Math.tan(t[1]*Math.PI/180), mid.z - d); cam.updateMatrixWorld(true);
    A.update(0.016, 1.0, cam); out.papi[t[0]] = A.papiState().slice(0, pp.length);
  });
  // the rabbit runs 420 m -> 30 m, twice a second, at the in-use end
  A.setNight(true); A.setDetail(1);
  var rb = [], rabbitObj = null; A.g.traverse(function(o){ if(o.name === "airport-rabbit") rabbitObj = o; });
  [0.0, 0.1, 0.2, 0.3, 0.45, 0.5].forEach(function(tt){ A.update(0.016, 10 + tt, null); var p = rabbitObj.geometry.attributes.position.array; rb.push([p[0], p[1], p[2]]); });
  out.rabbitRun = rb;
  // obstruction lights blink at 1 Hz
  A.update(0.016, 20.2, null); var on = A.lampColors(); A.update(0.016, 20.7, null); var offc = A.lampColors();
  out.obst = P.lights.map(function(l, i){ return l.g === "obst" ? [on[i], offc[i]] : null; }).filter(Boolean);
  // the socks ease toward the wind (frame-rate independent): 60 steps of 1/60 s vs 6 steps of 1/6 s
  function sockAfter(steps, dt){ var B = A3.create(c, L, {ground: ground}); B.setWind({yaw: 1.0, speed: 10}); for(var i = 0; i < steps; i++) B.update(dt, i*dt, null);
    var s = null; B.g.traverse(function(o){ if(o.name === "airport-socks") s = o; }); var m = new THREE.Matrix4(); s.getMatrixAt(0, m);
    var e = new THREE.Euler().setFromRotationMatrix(m, "YXZ"); B.dispose(); return [e.y, e.x]; }
  out.sock = [sockAfter(60, 1/60), sockAfter(6, 1/6)];
  // dispose frees every geometry and texture
  var disposed = 0, total = 0; A.g.traverse(function(o){ if(o.geometry){ total++; o.geometry.addEventListener("dispose", function(){ disposed++; }); } });
  var parent = new THREE.Group(); parent.add(A.g); A.dispose(); out.dispose = {total: total, disposed: disposed, detached: A.g.parent === null};
  out.texts = texts.slice(0, 40);
  process.stdout.write(JSON.stringify(out));
}).catch(function(e){ console.error(e && e.stack || e); process.exit(1); });
"""


def close(a, b, eps=1e-6):
    return a is not None and b is not None and all(abs(x - y) < eps for x, y in zip(a, b))


@unittest.skipUnless(NODE, "node not installed")
class TestHqAirport3d(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        js = HARNESS % {"root": json.dumps(ROOT)}
        p = subprocess.run([NODE, "-e", js], capture_output=True, text=True, timeout=300)
        if p.returncode != 0:
            raise AssertionError("node harness failed:\n" + p.stderr)
        cls.r = json.loads(p.stdout)
        with open(os.path.join(ROOT, "tests", "fixtures", "airfield_commons.json"), encoding="utf-8") as f:
            cls.L = json.load(f)
        cls.C = cls.r["LIGHT"]

    def lights(self, g, **kw):
        return [(i, l) for i, l in enumerate(self.r["lights"]) if l["g"] == g and all(l.get(k) == v for k, v in kw.items())]

    def test_plan_is_pure_and_guards(self):
        self.assertTrue(self.r["deterministic"])
        self.assertEqual(self.r["bad"], [True, True, True])

    def test_paint_lies_on_pavement(self):
        p = self.r["paint"]
        for k in ("white", "yellow", "red", "black"):
            self.assertGreater(p["counts"][k], 0, k)
        self.assertEqual(p["off"], [])
        self.assertGreater(p["minY"], self.L["y"])

    def test_runway_edge_and_centreline_counts(self):
        for side in (1, -1):
            n = len(self.lights("edge", side=side))
            self.assertLessEqual(abs(n - 33), 1, side)
        self.assertLessEqual(abs(len(self.lights("centre")) - 107), 1)
        for _, l in self.lights("edge"):
            self.assertAlmostEqual(abs(l["lat"]), 23.5, places=3)
        for _, l in self.lights("centre"):
            self.assertAlmostEqual(l["lat"], 0.6, places=3)

    def test_colour_rules_per_end(self):
        C, L = self.C, self.L["runway"]["len"]
        for e in (0, 1):
            cols = self.r["colors"][str(e)]
            for i, l in self.lights("edge"):
                rem = L - (l["along"] if e == 0 else L - l["along"])
                self.assertEqual(cols[i], C["yellow"] if rem < 600 - 1e-6 else C["white"], (e, l["along"]))
            ys = [l for i, l in self.lights("edge", side=1) if cols[i] == C["yellow"]]
            self.assertEqual(len(ys), 12, e)
            for i, l in self.lights("centre"):
                rem = L - (l["along"] if e == 0 else L - l["along"])
                want = C["red"] if rem < 300 else (C["red"] if l["i"] % 2 else C["white"]) if rem < 900 else C["white"]
                self.assertEqual(cols[i], want, (e, l["along"]))
            for i, l in self.lights("thr"):
                self.assertEqual(cols[i], C["green"] if l["end"] == e else C["red"])
            self.assertEqual(len(self.lights("thr")), 32)
            for g in ("tdz", "appr"):
                for i, l in self.lights(g):
                    self.assertEqual(cols[i], C["white"] if l["end"] == e else None, (g, e))
            for i, l in self.lights("apprRed"):
                self.assertEqual(cols[i], C["red"] if l["end"] == e else None)
            for i, _ in self.lights("tedge"):
                self.assertEqual(cols[i], C["blue"])
            for i, _ in self.lights("flood"):
                self.assertEqual(cols[i], C["sodium"])
        # TDZ: 30 rows of 6 per end, along 30..900
        for e in (0, 1):
            self.assertEqual(len(self.lights("tdz", end=e)), 180)
        # taxi centreline lights: green, alternating with yellow only inside the runway strip
        RU, ou = self.L["frame"]["RU"], self.L["frame"]["o"][0]
        tcl = self.lights("tcl")
        self.assertGreater(len(tcl), 40)
        for i, l in tcl:
            u = -(l["x"] - ou)   # B = [-1, 0] on the Commons
            if u <= RU - 50:
                self.assertEqual(self.r["colors"]["0"][i], C["green"])
        self.assertTrue(any(self.r["colors"]["0"][i] == C["yellow"] for i, _ in tcl))

    def test_mesh_colours_follow_set_runway_and_hold(self):
        m0, m1, mh, C = self.r["mesh0"], self.r["mesh1"], self.r["meshHold"], self.C
        for i, l in self.lights("thr"):
            self.assertTrue(close(m0[i], C["green"] if l["end"] == 0 else C["red"]))
            self.assertTrue(close(m1[i], C["green"] if l["end"] == 1 else C["red"]))
        for i, l in self.lights("appr"):
            self.assertTrue(close(m0[i], C["white"]) == (l["end"] == 0))
            self.assertTrue(close(m1[i], C["white"]) == (l["end"] == 1))
        stops = self.lights("stop")
        self.assertEqual(len(stops), 12*6)
        for i, l in stops:
            lit = close(mh[i], C["red"])
            self.assertEqual(lit, l["end"] != 0, l)
            self.assertTrue(close(m0[i], C["red"]))
        for i, l in self.lights("stop"):
            self.assertEqual(self.r["colorsHold"][i] is None, l["end"] == 0)

    def test_papi(self):
        self.assertEqual(self.r["papiWhite"], [True, False, True, False, True, False, True, False])
        self.assertEqual(len(self.r["papiPlan"]), 8)
        for p, q in zip(self.r["papiPlan"], self.L["runway"]["ends"][0]["papi"] + self.L["runway"]["ends"][1]["papi"]):
            self.assertAlmostEqual(p["x"], q[0], places=6)
            self.assertAlmostEqual(p["z"], q[1], places=6)
        pp = self.r["papi"]
        self.assertEqual(pp["on"], [0, 0, 1, 1])      # inner two red, outer two white: on the glideslope
        self.assertEqual(pp["high"], [1, 1, 1, 1])
        self.assertEqual(pp["low"], [0, 0, 0, 0])

    def test_approach_lights_on_the_approach_points(self):
        for e, pts in enumerate(self.r["approach"]):
            appr = [l for _, l in self.lights("appr", end=e)]
            for q in pts:
                bar = [l for l in appr if abs(l["x"] - q[0]) <= 2.01 and abs(l["z"] - q[1]) <= 2.01]
                self.assertGreaterEqual(len(bar), 5, (e, q))
            # every approach lamp sits on one of the points' cross lines
            E = self.L["runway"]["ends"][e]
            for l in appr + [l for _, l in self.lights("apprRed", end=e)]:
                ok = any(abs((l["x"] - q[0])*E["dir"][0] + (l["z"] - q[1])*E["dir"][1]) < 0.01 and
                         abs((l["x"] - q[0])*E["left"][0] + (l["z"] - q[1])*E["left"][1]) <= 14.01 for q in pts)
                self.assertTrue(ok, l)
            # crossbar: 15 lamps at 300 m; red barrettes 30..180 m
            cross = [l for l in appr if abs(abs(l["along"]) - (300 if e == 0 else 1900)) < 0.01 and abs(l["lat"]) > 2.5]
            self.assertEqual(len(cross), 12)
            self.assertEqual(len(self.lights("apprRed", end=e)), 6*6)
            # the rabbit's stations: the approach points, 420 m out first
            rab = self.r["rabbit"][e]
            self.assertEqual(len(rab), len(pts))
            self.assertAlmostEqual(rab[0][0], pts[-1][0], places=6)
            self.assertAlmostEqual(rab[0][2], pts[-1][1], places=6)
            self.assertAlmostEqual(rab[-1][2], pts[0][1], places=6)

    def test_rabbit_runs_twice_a_second(self):
        rb = self.r["rabbitRun"]
        pts = self.r["approach"][0]
        zs = [p[2] for p in rb]
        self.assertAlmostEqual(zs[0], pts[-1][1], places=6)     # t = 10.0: 420 m out
        self.assertGreater(zs[1], zs[0])                        # running in toward the threshold (36: +z)
        self.assertGreater(zs[3], zs[2])
        self.assertAlmostEqual(zs[5], zs[0], places=6)          # half a second later it starts again

    def test_obstruction_blink(self):
        self.assertGreaterEqual(len(self.r["obst"]), 9 + 2 + 2 + 2)
        for on, off in self.r["obst"]:
            self.assertTrue(close(on, self.C["red"]))
            self.assertFalse(close(off, self.C["red"]))

    def test_fence_off_pavement_and_service_road(self):
        f = self.r["fence"]
        self.assertGreater(f["n"], 20)
        self.assertEqual(f["onPave"], [])
        self.assertEqual(f["nearRoad"], [])
        e = self.r["edges"]
        self.assertGreater(e["water"], e["land"])
        self.assertGreater(e["land"], 0)

    def test_masts_off_the_service_road_and_stands(self):
        m = self.r["masts"]
        self.assertEqual(len(m), 9)
        for x in m:
            self.assertGreater(x["road"], 0, x)
            self.assertEqual(x["inBox"], [], x)
            self.assertTrue(x["onPlatform"], x)
            self.assertEqual(x["h"], 25)
        us = sorted(round(-(x["x"] + 620), 2) for x in m)
        self.assertEqual(us, [173.3]*7 + [200.5]*2)
        vs = sorted(x["z"] for x in m if abs(-(x["x"] + 620) - 173.3) < 0.01)
        self.assertEqual(vs, [-132, -88, -44, 0, 44, 88, 132])
        self.assertEqual(sorted(x["z"] for x in m if abs(-(x["x"] + 620) - 200.5) < 0.01), [-240, -160])

    def test_signs(self):
        s = self.r["signs"]
        self.assertGreaterEqual(len(s), 12 + 4)
        for x in s:
            self.assertEqual(x["on"], [], x)
            self.assertTrue(x["onPlatform"], x)
        texts = [c["text"] for c in self.r["cells"]]
        self.assertIn("18-36", texts)
        self.assertIn("36-18", texts)
        for k in ("A", "B", "A1", "A6"):
            self.assertIn(k, texts)
        self.assertLessEqual(len(texts), 16)          # one 512x256 atlas of 128x64 cells
        for t in self.r["texts"]:
            self.assertRegex(t, r"^[0-9A-Z-]{1,6}$")

    def test_draw_calls_per_level(self):
        d = self.r["draws"]
        for n in ("day", "night"):
            self.assertLessEqual(d[n + "2"], 24, d)
            self.assertLessEqual(d[n + "1"], 8, d)      # ground 3, white + yellow 2, lamps + glow + rabbit at night
            self.assertLessEqual(d[n + "0"], 6, d)      # ground 3, white 1, glow at night
        self.assertEqual(d["day0"], 4)
        self.assertEqual(d["night0"], 5)
        self.assertEqual(d["day1"], 5)
        self.assertGreater(d["night2"], d["day2"])
        self.assertTrue(self.r["sameObjects"])

    def test_budgets(self):
        s = self.r["stats"]
        self.assertLessEqual(s["tris"], 120000)
        self.assertLessEqual(s["canvasBytes"], 4*1024*1024)
        self.assertEqual(self.r["dispose"]["total"], self.r["dispose"]["disposed"])
        self.assertTrue(self.r["dispose"]["detached"])

    def test_socks_ease_frame_rate_independent(self):
        a, b = self.r["sock"]
        self.assertAlmostEqual(a[0], b[0], delta=0.02)
        self.assertAlmostEqual(a[1], b[1], delta=0.02)


class TestHqAirport3dSource(unittest.TestCase):
    def setUp(self):
        with open(SRC, encoding="utf-8") as f:
            self.src = f.read()

    def test_house_rules(self):
        self.assertNotIn("Math.random", self.src)
        self.assertNotIn("innerHTML", self.src)
        self.assertIsNone(re.search(r"Math\.min\(\s*1\s*,\s*dt", self.src))
        self.assertIn("HQV.hqAirport3d", self.src)
        self.assertIn("Math.exp(-", self.src)


if __name__ == "__main__":
    unittest.main()
