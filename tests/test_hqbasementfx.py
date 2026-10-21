"""The basement garage's experience layer (games/hqbasementfx.js, HQV.hqBasementFx, Claude HQ 3.4 spec "D").

node with a tiny fake THREE: Calm (k = 0) leaves every transform still (turntables, fishtank, the valet jumps
straight to its end pose instead of animating), valetPlan's phases are contiguous, monotonic and finite both
ways, the trophy wall's plaques are deterministic per uid and read the local Rally/Kart bests when present,
the lift rides run their beats in order (sweep, floor flip, doors, chime) and are instant in Calm, and every
hook survives a null ctx, no THREE and no HQV.engine. Skipped when node is not installed. Stdlib only."""
import json
import os
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")


def read(*p):
    with open(os.path.join(ROOT, *p), encoding="utf-8") as f:
        return f.read()


HARNESS = r"""
import fs from "fs";
const root = %(root)s;
globalThis.window = {HQV: {}};
const src = fs.readFileSync(root + "/games/hqbasementfx.js", "utf8");
new Function(src)();
const F = window.HQV.hqBasementFx, out = {};
const sounds = [], toasts = [];

// --- a tiny THREE: enough for position / rotation / materials / buffer attributes
class V3 { constructor(){ this.x = 0; this.y = 0; this.z = 0; } set(x, y, z){ this.x = x; this.y = y; this.z = z; return this; } }
class Obj { constructor(){ this.position = new V3(); this.rotation = new V3(); this.scale = new V3().set(1, 1, 1); this.children = []; this.parent = null; this.visible = true; this.userData = {}; }
  add(o){ o.parent = this; this.children.push(o); return this; } remove(o){ this.children = this.children.filter(c => c !== o); o.parent = null; } }
class Mesh extends Obj { constructor(g, m){ super(); this.geometry = g; this.material = m; } }
class Points extends Mesh {}
class Mat { constructor(o){ Object.assign(this, {opacity: 1}, o || {}); } }
class Geo { constructor(){ this.attributes = {}; } setAttribute(n, a){ this.attributes[n] = a; } }
const THREE = {Group: Obj, Mesh, Points, BufferGeometry: Geo, BufferAttribute: class { constructor(a, n){ this.array = a; this.itemSize = n; } },
  CylinderGeometry: Geo, ConeGeometry: Geo, PlaneGeometry: Geo, BoxGeometry: Geo,
  MeshBasicMaterial: Mat, MeshStandardMaterial: Mat, MeshPhysicalMaterial: Mat, PointsMaterial: Mat, AdditiveBlending: 2, DoubleSide: 2};
const fakeCanvas = () => { const calls = []; return new Proxy({calls}, {get(t, k){ if(k in t) return t[k]; if(k === "createLinearGradient") return () => ({addColorStop(){}}); return (...a) => { calls.push([k, a]); }; }, set(t, k, v){ t[k] = v; return true; }}); };
const texts = [];
const ctx = {THREE, uid: "u-1", canvasTex(w, h, draw){ const g = fakeCanvas(); draw && draw(g, w, h); g.calls.forEach(c => { if(c[0] === "fillText") texts.push(String(c[1][0])); }); return {t: {}, g}; }};

function snap(o){ const r = []; (function walk(n){ r.push([n.position.x, n.position.y, n.position.z, n.rotation.y]); n.children.forEach(walk); })(o); return JSON.stringify(r); }

// 1. Calm: nothing moves
{
  const g = new Obj(), P = F.plinths(ctx, g, [{x: 0, z: 0}, {x: 4, z: 0}, {x: 8, z: 0}]), L = F.lounge(ctx, g, {x: 2, z: 3});
  const before = snap(g);
  for(let i = 0; i < 60; i++){ P.update(i/60, 1/60, 0); L.update(i/60, 1/60, 0); }
  out.calmStill = snap(g) === before;
  for(let i = 0; i < 60; i++){ P.update(i/60, 1/60, 1); L.update(i/60, 1/60, 1); }
  out.movesAtK1 = snap(g) !== before;
  out.spin = P.state().angle;
  // frame-rate independence: 30 Hz vs 120 Hz for one second
  const a = F.plinths(ctx, new Obj(), [{x: 0, z: 0}]), b = F.plinths(ctx, new Obj(), [{x: 0, z: 0}]);
  for(let i = 0; i < 30; i++) a.update(0, 1/30, 1); for(let i = 0; i < 120; i++) b.update(0, 1/120, 1);
  out.fpsAgree = Math.abs(a.state().angle - b.state().angle) < 1e-9;
}

// 2. valetPlan
out.plans = ["basement", "carpark"].map(to => F.valetPlan(to === "basement" ? "carpark" : "basement", to));
out.samples = out.plans.map(p => { const r = []; for(let t = -1; t <= p.total + 1; t += 0.25) r.push(F.valetAt(p, t)); return r; });

// 3. determinism of plaques
out.plaqA = F.plaqueLayout("user-a"); out.plaqA2 = F.plaqueLayout("user-a"); out.plaqB = F.plaqueLayout("user-b");
window.HQV.api = {save: {kart: {best: {oval: 61234, figure8: 0}}, rally: {best: {"stage-1": 95000}}}, toast: m => toasts.push(m)};
out.bests = F.localBests();
F.trophyWall(ctx, new Obj(), {x: 0, z: -10}, "user-a");
out.wallTexts = texts.slice();

// 4. null ctx / no engine / no world
out.nullOk = (() => { try {
  const r = F.liftArrival(null, null, {dir: "down"}); r.update(0, 0.1, 1); r.done();
  F.lobbyRide(undefined, {}).update(0, 1, 0);
  F.plinths(null, null, [{x: 0, z: 0}]).update(0, 1, 1);
  F.trophyWall(null, null, null); F.lounge(null, null).update(0, 1, 1); F.photoSpot(null, null);
  F.lighting(null, {night: true, weather: "rain"}); F.sound("bell"); F.setTime(true, "rain"); F.update(0, 1, 1);
  F.valet("x", "basement"); return true; } catch(e){ return String(e && e.stack); } })();

// 5. rides
window.HQV.engine = {sfx: n => sounds.push(n)};
{
  const w = {scene: new Obj()}, r = F.liftArrival(ctx, w, {dir: "down"}), seen = [];
  while(!r.done()){ r.update(0, 1/60, 1); seen.push(r.state()); }
  out.ride = {floors: [...new Set(seen.map(s => s.floor))], last: seen[seen.length - 1], frames: seen.length,
    doorsMono: seen.every((s, i) => i === 0 || s.doors >= seen[i - 1].doors), cleaned: w.scene.children.length === 0};
  out.rideSounds = sounds.slice();
  const c = F.liftArrival(ctx, {scene: new Obj()}, {dir: "up"}); let n = 0; while(!c.done() && n < 1000){ c.update(0, 1/60, 0); n++; }
  out.calmFrames = n; out.calmFloor = c.state().floor;
}

// 6. valet with a live world
{
  const prop = {id: "own:v1", x: 10, z: -4, g: new Obj()}; prop.g.position.set(10, 0, -4);
  const w = {scene: new Obj(), bikes: [prop], pad: {x: 0, z: 14}};
  F.enter(ctx, w);
  const r = F.valet("v1", "carpark", "<b>Evil</b>");
  const ys = [], xs = [];
  for(let i = 0; i < 400; i++){ F.update(0, 1/60, 1); ys.push(prop.g.position.y); xs.push(prop.g.position.x); }
  out.valet = {phases: r.plan.phases.map(p => p.name), endY: prop.g.position.y, endX: prop.g.position.x, endZ: prop.g.position.z, hidden: !prop.g.visible,
    yMono: ys.every((y, i) => i === 0 || y <= ys[i - 1] + 1e-9), xMono: xs.every((x, i) => i === 0 || x <= xs[i - 1] + 1e-9)};
  const p2 = {id: "own:v2", x: 6, z: 2, g: new Obj()}; p2.g.position.set(6, 0, 2); w.bikes.push(p2);
  F.valet("v2", "basement"); out.v2start = [p2.g.position.x, p2.g.position.y, p2.g.position.z];
  F.update(0, 0.016, 0); out.v2calm = [p2.g.position.x, p2.g.position.y, p2.g.position.z]; out.liveAfter = F.live();
  F.leave();
}
out.toasts = toasts;
out.look = [F.lighting({}, {night: true, weather: "light rain"}), F.lighting({}, {night: false, weather: "clear"})];
out.usesRandom = /Math\.random/.test(src);
out.usesInner = /innerHTML/.test(src);
console.log(JSON.stringify(out));
"""


@unittest.skipUnless(NODE, "node not installed")
class HqBasementFx(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        src = HARNESS % {"root": json.dumps(ROOT)}
        r = subprocess.run([NODE, "--input-type=module", "-e", src], capture_output=True, text=True, timeout=60)
        if r.returncode != 0:
            raise AssertionError(r.stderr[-3000:])
        cls.o = json.loads(r.stdout.strip().splitlines()[-1])

    def test_calm_leaves_transforms_static(self):
        self.assertTrue(self.o["calmStill"], "k = 0: turntables and fish stay put")
        self.assertTrue(self.o["movesAtK1"])
        self.assertAlmostEqual(self.o["spin"], 0.25, places=6, msg="0.25 rad/s at k = 1")
        self.assertTrue(self.o["fpsAgree"], "30 Hz and 120 Hz agree")

    def test_valet_plan_monotonic_and_finite(self):
        for p, samples in zip(self.o["plans"], self.o["samples"]):
            self.assertGreater(p["total"], 0)
            self.assertLess(p["total"], 20)
            prev = 0
            for ph in p["phases"]:
                self.assertEqual(ph["t0"], prev, "contiguous")
                self.assertGreater(ph["t1"], ph["t0"])
                prev = ph["t1"]
            self.assertAlmostEqual(prev, p["total"])
            idx = [s["i"] for s in samples]
            self.assertEqual(idx, sorted(idx), "phases only advance")
            for s in samples:
                self.assertTrue(0 <= s["u"] <= 1)
        self.assertEqual([x["name"] for x in self.o["plans"][0]["phases"]], ["rise", "doors", "drive"])
        self.assertEqual([x["name"] for x in self.o["plans"][1]["phases"]], ["drive", "doors", "sink"])

    def test_plaques_deterministic(self):
        self.assertEqual(self.o["plaqA"], self.o["plaqA2"])
        self.assertNotEqual([p["title"] for p in self.o["plaqA"]], [p["title"] for p in self.o["plaqB"]])
        self.assertEqual(len(self.o["plaqA"]), 6)
        b = self.o["bests"]
        self.assertEqual([x["game"] for x in b], ["Kart", "Rally"], "zero bests dropped, fastest first")
        self.assertIn("Best 1:01.23", self.o["wallTexts"])
        self.assertIn("HALL OF BESTS", self.o["wallTexts"])

    def test_null_ctx_and_engine_throw_nothing(self):
        self.assertIs(self.o["nullOk"], True, self.o["nullOk"])

    def test_lift_ride_beats(self):
        r = self.o["ride"]
        self.assertEqual(r["floors"], ["G", "B1"])
        self.assertTrue(r["doorsMono"])
        self.assertEqual(r["last"]["doors"], 1)
        self.assertTrue(r["last"]["chimed"])
        self.assertTrue(r["cleaned"], "the fx group leaves the scene when done")
        self.assertIn("bell", self.o["rideSounds"])
        self.assertLessEqual(self.o["calmFrames"], 20, "Calm: instant-ish")
        self.assertEqual(self.o["calmFloor"], "G")

    def test_valet_drives_and_sinks(self):
        v = self.o["valet"]
        self.assertEqual(v["phases"], ["drive", "doors", "sink"])
        self.assertAlmostEqual(v["endX"], 0)
        self.assertAlmostEqual(v["endZ"], 14)
        self.assertAlmostEqual(v["endY"], -6)
        self.assertTrue(v["hidden"])
        self.assertTrue(v["yMono"] and v["xMono"])
        self.assertEqual(self.o["v2start"][1], -6, "to the basement: rises from the lift shaft")
        self.assertEqual(self.o["v2calm"], [6, 0, 2], "Calm jumps to the bay")
        self.assertEqual(self.o["liveAfter"]["valets"], 0)
        self.assertTrue(any("multi-storey" in t for t in self.o["toasts"]))
        self.assertTrue(any("<b>Evil</b>" in t for t in self.o["toasts"]), "names are plain text for the toast")

    def test_lighting_mood(self):
        n, d = self.o["look"]
        self.assertEqual((n["warm"], n["sheen"]), (1, 1))
        self.assertEqual((d["warm"], d["sheen"]), (0, 0))

    def test_rules(self):
        self.assertFalse(self.o["usesRandom"], "deterministic visuals")
        self.assertFalse(self.o["usesInner"], "textContent / canvas only")
        self.assertIn("HQV.hqBasementFx", read("games", "hqbasementfx.js"))


if __name__ == "__main__":
    unittest.main()
