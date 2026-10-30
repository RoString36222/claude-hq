"""The exosuit's flight (games/hqexoride.js) and visor HUD (games/hqexohud.js).

One node process loads the vendored three.js and both modules against a stub `window` and runs the scenarios; the
Python side checks the numbers: every frame stays finite under odd inputs and clocks, the boost drains and refills,
only the abyss goes under water, the stratos has no height cap while the rest stop at 600 m, a slow descent lands,
the bulwark is the slowest, and the HUD draws headless on a stub canvas. Skipped when node is not installed."""
import json
import os
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")

HARNESS = r"""
var fs = require("fs"), url = require("url"), root = process.argv[1];
import(url.pathToFileURL(root + "/games/vendor/three-module.js").href).then(function(THREE){
  global.window = {HQV: {}, devicePixelRatio: 3};
  ["hqexoride", "hqexohud"].forEach(function(f){ new Function(fs.readFileSync(root + "/games/" + f + ".js", "utf8"))(); });
  var H = window.HQV, R = H.hqExoRide, out = {frames: R.FRAMES, stats: R.STATS};
  var flat = {floor: function(){ return 0; }, water: function(){ return null; }};
  var sea = {floor: function(){ return -50; }, water: function(){ return 0; }};
  function fin(st){ return ["x", "y", "z", "yaw", "pitch", "roll", "speed", "vs", "boost"].every(function(k){ return typeof st[k] === "number" && isFinite(st[k]); }); }
  function run(st, secs, inp, env, hz){ hz = hz || 60; for(var i = 0; i < Math.round(secs*hz); i++) R.step(st, 1/hz, typeof inp === "function" ? inp(i/hz, st) : inp, env); return st; }
  // ---- odd inputs and clocks ----
  var odd = [NaN, -1, 0, 1e9, Infinity, -Infinity, undefined, null, "x", 1/60];
  var oddInp = [undefined, null, {}, {fwd: NaN, up: Infinity, left: -Infinity, boost: "yes"}, {fwd: true, right: 1, down: 1e9, boost: true},
                {fwd: 1, up: 1, boost: 1}, {back: 1, down: 1}];
  var badEnv = [undefined, {}, {floor: function(){ return NaN; }, water: function(){ return Infinity; }},
                {floor: function(){ throw new Error("x"); }, water: function(){ return "q"; }}, sea, flat];
  out.finite = R.FRAMES.map(function(f){
    var st = R.newState(f, NaN, undefined, "z", Infinity), ok = fin(st);
    for(var i = 0; i < 3000; i++){ R.step(st, odd[i % odd.length], oddInp[i % oddInp.length], badEnv[i % badEnv.length]); ok = ok && fin(st); }
    var s2 = R.newState(f, 0, 10, 0, 0); s2.y = NaN; s2.speed = Infinity; R.step(s2, 1/60, {fwd: 1}, flat); ok = ok && fin(s2);
    R.step(null, 1/60, {}, flat);
    return [f, ok, st.mode];
  });
  // ---- 30 Hz and 120 Hz agree ----
  function sched(t){ return t < 3 ? {up: 1} : t < 8 ? {fwd: 1, left: t > 6} : {fwd: 1, boost: 1}; }
  var a = run(R.newState("sentinel", 0, 0, 0, 0), 10, sched, flat, 30), b = run(R.newState("sentinel", 0, 0, 0, 0), 10, sched, flat, 120);
  out.rates = [[a.x, a.y, a.z], [b.x, b.y, b.z]];
  // ---- boost ----
  var bs = run(R.newState("strider", 0, 0, 0, 0), 2, {up: 1}, flat); bs = run(bs, 4, {fwd: 1}, flat); var cruiseV = bs.speed;
  run(bs, 1, {fwd: 1, boost: 1}, flat); var b1 = bs.boost, boosted = bs.boosting;
  run(bs, 5, {fwd: 1, boost: 1}, flat); var bEmpty = bs.boost, vBoost = bs.speed;
  run(bs, 3, {fwd: 1}, flat); var bRefill = bs.boost;
  out.boost = {b1: b1, boosted: boosted, empty: bEmpty, refill: bRefill, cruiseV: cruiseV, vBoost: vBoost};
  // ---- water ----
  out.water = R.FRAMES.map(function(f){ var st = R.newState(f, 0, 5, 0, 0); run(st, 10, {down: 1}, sea); var y1 = st.y, m1 = st.mode;
    run(st, 3, {fwd: 1}, sea); return [f, y1, m1, st.y, st.speed]; });
  // ---- ceiling ----
  out.ceiling = R.FRAMES.map(function(f){ var st = R.newState(f, 0, 0, 0, 0); run(st, 120, {up: 1}, flat); var hy = st.y;
    run(st, 60, {fwd: 1, up: 1}, flat); return [f, Math.max(hy, st.y)]; });
  // ---- landing ----
  var ld = run(R.newState("bulwark", 0, 80, 0, 0), 1, {fwd: 1}, flat); ld.mode = "hover"; var air = ld.mode;
  run(ld, 40, {down: 1}, flat); out.land = {air: air, mode: ld.mode, y: ld.y, speed: ld.speed};
  var lf = R.newState("flux", 0, 0, 0, 0); run(lf, 1, {up: 1}, flat); out.lift = {mode: lf.mode, y: lf.y};
  // ---- top speeds ----
  out.tops = R.FRAMES.map(function(f){ var st = R.newState(f, 0, 0, 0, 0); run(st, 2, {up: 1}, flat); run(st, 20, {fwd: 1}, flat); return [f, st.speed, st.mode]; });
  // ---- turns: a banked cruise turn ----
  var tr = run(R.newState("sentinel", 0, 50, 0, 0), 6, {fwd: 1}, flat); var y0 = tr.yaw; run(tr, 1, {fwd: 1, left: 1}, flat);
  out.turn = {roll: tr.roll, dyaw: tr.yaw - y0, mode: tr.mode};
  // ---- the HUD on a stub canvas ----
  var calls = {n: 0};
  function ctx(){ var g = {addColorStop: function(){}};
    return new Proxy({}, {get: function(o, k){ if(k in o) return o[k]; if(k === "createRadialGradient" || k === "createLinearGradient") return function(){ return g; };
      return function(){ calls.n++; }; }, set: function(o, k, v){ o[k] = v; return true; }}); }
  var canvas = {style: {}, getContext: function(){ return this._c || (this._c = ctx()); }};
  global.document = window.document = {createElement: function(){ return canvas; }};
  var kids = [], box = {appendChild: function(c){ kids.push(c); c.parentNode = box; }, removeChild: function(c){ kids.splice(kids.indexOf(c), 1); },
    getBoundingClientRect: function(){ return {width: 800, height: 450}; }};
  window.THREE = THREE;
  var hud = H.hqExoHud.create(box), cam = new THREE.PerspectiveCamera(72, 16/9, .5, 900); cam.position.set(0, 50, 0); cam.updateMatrixWorld(); cam.updateProjectionMatrix();
  var st = R.newState("abyss", 0, 50, 0, 0); st.mode = "cruise"; st.speed = 60; st.vs = -5; st.agl = 20;
  hud.boot(); hud.draw(st, cam, [{x: 0, y: 50, z: -100, label: "drone"}, {x: 50, y: 40, z: 100}, null], "abyss", "#7fd3ea");
  var n1 = calls.n; hud.draw(st, cam, [], "abyss", "#7fd3ea"); var n2 = calls.n;
  hud.show(false); hud.draw(st, cam, [], "nope", null); hud.show(true); hud.draw({}, null, null, undefined, undefined);
  out.hud = {calls: n1, throttled: n2 === n1, w: canvas.width, h: canvas.height, attached: kids.length};
  hud.destroy(); out.hud.removed = kids.length === 0;
  process.stdout.write(JSON.stringify(out));
}).catch(function(e){ console.error(e && e.stack || e); process.exit(1); });
"""


@unittest.skipUnless(NODE, "node not installed")
class ExoRide(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        r = subprocess.run([NODE, "-e", HARNESS, ROOT], capture_output=True, text=True, timeout=180)
        if r.returncode != 0:
            raise AssertionError(r.stderr[-3000:])
        cls.o = json.loads(r.stdout)

    def test_six_frames(self):
        self.assertEqual(self.o["frames"], ["sentinel", "strider", "bulwark", "abyss", "stratos", "flux"])
        self.assertEqual(self.o["stats"]["bulwark"]["st"], [25, 100, 15, 90])

    def test_finite_under_odd_inputs_and_clocks(self):
        for f, ok, mode in self.o["finite"]:
            self.assertTrue(ok, f)
            self.assertIn(mode, ["hover", "cruise", "swim", "landed"])

    def test_same_flight_at_30_and_120_hz(self):
        a, b = self.o["rates"]
        for p, q in zip(a, b):
            self.assertAlmostEqual(p, q, delta=max(1.0, 0.015 * abs(q)))  # one sub-step of slack at the boost

    def test_boost_drains_and_refills(self):
        b = self.o["boost"]
        self.assertTrue(b["boosted"])
        self.assertLess(b["b1"], 0.75)
        self.assertLess(b["empty"], 0.05)
        self.assertGreater(b["refill"], b["empty"] + 0.3)
        self.assertGreater(b["vBoost"], b["cruiseV"] * 1.3)

    def test_only_abyss_goes_under_water(self):
        for f, y1, m1, y2, v in self.o["water"]:
            if f == "abyss":
                self.assertLess(y1, -5)
                self.assertEqual(m1, "swim")
                self.assertLess(v, self.o["stats"]["abyss"]["top"] * 0.5)
            else:
                self.assertGreaterEqual(y1, 0)
                self.assertGreaterEqual(y2, 0)

    def test_ceiling(self):
        for f, y in self.o["ceiling"]:
            if f == "stratos":
                self.assertGreater(y, 1000)
            else:
                self.assertLessEqual(y, 600)
                self.assertGreater(y, 590)

    def test_landing_and_lift_off(self):
        self.assertEqual(self.o["land"]["mode"], "landed")
        self.assertAlmostEqual(self.o["land"]["y"], 0, delta=0.01)
        self.assertEqual(self.o["lift"]["mode"], "hover")
        self.assertGreater(self.o["lift"]["y"], 1)

    def test_bulwark_slowest_strider_fastest(self):
        tops = {f: v for f, v, m in self.o["tops"]}
        self.assertEqual(min(tops, key=tops.get), "bulwark")
        self.assertEqual(max(tops, key=tops.get), "strider")
        for f, v, m in self.o["tops"]:
            self.assertEqual(m, "cruise", f)

    def test_banked_turn(self):
        t = self.o["turn"]
        self.assertEqual(t["mode"], "cruise")
        self.assertGreater(t["roll"], 0.3)
        self.assertGreater(t["dyaw"], 0.05)

    def test_hud_draws_headless(self):
        h = self.o["hud"]
        self.assertGreater(h["calls"], 100)
        self.assertTrue(h["throttled"])
        self.assertEqual((h["w"], h["h"]), (1600, 900))
        self.assertEqual(h["attached"], 1)
        self.assertTrue(h["removed"])

    def test_no_marvel_naming(self):
        for p in ("games/hqexoride.js", "games/hqexohud.js"):
            with open(os.path.join(ROOT, p), encoding="utf-8") as f:
                s = f.read().lower()
            for w in ("iron man", "ironman", "marvel", "stark", "jarvis", "repulsor"):
                self.assertNotIn(w, s, p)


if __name__ == "__main__":
    unittest.main()
