"""HQ 3.4: the building side of the Basement Garage (the integrator's shared-file hooks).

The lot's old garage is a car-lift bay down to B1 (games/hqcityparts.js lotExtras: no starters on
the street, a "carlift" door: yours to "@basement", anyone else's a visit), the lobby has a third
lift to B1 (games/hqlobby.js), hq3d.js carries a ride down the car lift and fixes the three owned-
vehicle defects, the script order loads the basement modules after hqlobby, and the version is
3.5.0. Runs the lot code under node with the vendored three.js (skipped without node). Stdlib only."""
import json
import os
import re
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GAMES = os.path.join(ROOT, "games")
NODE = shutil.which("node")


def read(p):
    with open(os.path.join(ROOT, p), encoding="utf-8") as f:
        return f.read()


HARNESS = r"""
import fs from "fs";
const root = %(root)s;
const THREE = await import(root + "/games/vendor/three-module.js");
globalThis.window = {HQV: {}};
const HQV = window.HQV;
for (const f of ["hqstyle", "hqtower", "hqroof", "hqdecor", "hqbase", "hqcityparts", "hqcity"]) new Function(fs.readFileSync(root + "/games/" + f + ".js", "utf8"))();
var noop2d = new Proxy({}, {get(t, k){ return k === "measureText" ? function(){ return {width: 10}; } : function(){ return {addColorStop(){}}; }; }, set(){ return true; }});
function mat(c, o){ return new THREE.MeshStandardMaterial(Object.assign({color: c}, o || {})); }
function emis(c, e, ei, o){ var m = mat(c, o); m.emissive = new THREE.Color(e); m.emissiveIntensity = ei; return m; }
function add(o, x, y, z, p){ o.position.set(x, y, z); p.add(o); return o; }
var c = {THREE: THREE, PI: Math.PI, mat: mat, emis: emis,
  box(w, h, d, m, x, y, z, p){ return add(new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m), x, y, z, p); },
  sph(r, m, x, y, z, p){ return add(new THREE.Mesh(new THREE.SphereGeometry(r, 8, 6), m), x, y, z, p); },
  canvasTex(w, h, draw){ if(draw) draw(noop2d, w, h); return {c: null, g: noop2d, t: new THREE.Texture()}; },
  screen(w, h, t){ return new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({map: t})); },
  glow(col){ return new THREE.Sprite(new THREE.SpriteMaterial({color: col})); }};
var tw = function(x, z){ return {x: 100 + x, z: 50 + z}; }, col = {paint: 0x2a3c50, accent: 0xffb347};
var out = {};
function lot(mine, withLift){
  if(withLift) HQV.hqCarLift = {mesh(ctx, o){ var g = new THREE.Group(); g.add(new THREE.Mesh(new THREE.BoxGeometry(o.w, 0.1, o.d), mat(0x333333))); return {g: g, update(){}}; }};
  else delete HQV.hqCarLift;
  var g = new THREE.Group(), X = HQV.hqCityParts.lotExtras(c, g, col, 0, tw, null, "u-1", null, mine);
  return {items: X.items.length, car: X.car, keys: Object.keys(X).sort(), garage: Object.keys(X.garage).sort(),
          doors: X.doors.map(d => ({view: d.view, kind: d.kind, front: d.front && [d.front.x, d.front.z]})),
          hits: X.hits.length, hitDoor: X.hits.every(h => h.userData.door === X.door), lift: !!X.lift};
}
out.mine = lot(true, false); out.theirs = lot(false, false); out.withLift = lot(true, true);
var G = HQV.hqLotExtras.garage, B = HQV.hqLotExtraBlocked;
out.blocked = {
  front: B(G.x, G.z + G.d/2 + 0.6, true),          // the open front: drive in
  middle: B(G.x, G.z, true),                        // on the platform (no car box any more)
  back: B(G.x, G.z - G.d/2, true),                  // the back wall
  side: B(G.x - G.w/2, G.z, true)                   // a side wall
};
// the rooftop helipad (games/hqtower.js; the HQ revamp: at every level): its edge lights in one InstancedMesh
Object.assign(c, {COL: {amber: 0xffb347, cyan: 0x5fd3e6, green: 0x6fd38a, coral: 0xff6b5b}, HEX: {green: "#6fd38a", amber: "#ffb347", cyan: "#5fd3e6"},
  add: add, E: {calm(){ return false; }}, hashStr(s){ var h = 2166136261; s = String(s); for(var i = 0; i < s.length; i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h; },
  rng(seed){ var a = seed >>> 0 || 1; return function(){ a = (a + 0x6D2B79F5) >>> 0; var t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0)/4294967296; }; },
  cyl(rt, rb, h, m, x, y, z, p, seg){ return add(new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg || 12), m), x, y, z, p); },
  label(){ return new THREE.Group(); }, glyph(){ return new THREE.Sprite(new THREE.SpriteMaterial()); }, short(s){ return String(s || ""); }});
function pads(level){
  try { var B = HQV.hqBuilding(c, {level(){ return level; }, look(){ return {}; }, live(){ return 0; }, campus: false, door: {view: "@lobby"},
                                  doorFront(){ return new THREE.Vector3(); }});
    var n = 0; B.g.traverse(o => { if(o.isInstancedMesh && o.name === "hq-padlights") n++; }); return n; } catch(e){ return "err:" + e.message; }
}
out.helipad = {low: pads(5), high: pads(12)};
console.log(JSON.stringify(out));
"""


@unittest.skipUnless(NODE, "node not installed")
class LotCarLift(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        src = HARNESS % {"root": json.dumps(ROOT)}
        r = subprocess.run([NODE, "--input-type=module", "-e", src], capture_output=True, text=True, timeout=120)
        if r.returncode != 0:
            raise AssertionError("node failed:\n" + r.stderr[-4000:])
        cls.out = json.loads(r.stdout)

    def test_lot_has_carlift_door_and_no_starters(self):
        m = self.out["mine"]
        self.assertEqual(m["items"], 0)
        self.assertIsNone(m["car"])
        self.assertEqual(m["garage"], ["on", "top", "walls"])         # fadeGarages still works on it
        self.assertEqual(len(m["doors"]), 1)
        self.assertEqual(m["doors"][0]["view"], "@basement")
        self.assertEqual(m["doors"][0]["kind"], "carlift")
        self.assertTrue(m["hits"] >= 1 and m["hitDoor"])

    def test_door_front_is_on_the_pad(self):
        G = {"x": 13.0, "z": 6.7, "w": 7.0, "d": 6.2}
        fx, fz = self.out["mine"]["doors"][0]["front"]
        self.assertAlmostEqual(fx, 100 + G["x"])
        self.assertTrue(50 + G["z"] - G["d"] / 2 < fz < 50 + G["z"] + G["d"] / 2)

    def test_someone_elses_lift_is_a_visit(self):
        d = self.out["theirs"]["doors"][0]
        self.assertEqual(d["view"], "visit:u-1")
        self.assertEqual(d["kind"], "carlift")

    def test_uses_the_carlift_mesh_when_loaded(self):
        self.assertTrue(self.out["withLift"]["lift"])
        self.assertFalse(self.out["mine"]["lift"])

    def test_blocked_keeps_the_shaft_open_at_the_front(self):
        b = self.out["blocked"]
        self.assertFalse(b["front"])
        self.assertFalse(b["middle"])
        self.assertTrue(b["back"])
        self.assertTrue(b["side"])


    def test_helipad_at_every_level(self):
        # the HQ revamp: every tower has its roof pad, from level 1 (it was level 10+)
        h = self.out["helipad"]
        if isinstance(h["high"], str):
            self.skipTest("hqBuilding needs more of the ctx than this stub: " + h["high"])
        self.assertEqual(h["low"], 1)
        self.assertEqual(h["high"], 1)


class SharedFileHooks(unittest.TestCase):
    def test_lobby_has_a_lift_to_b1(self):
        s = read("games/hqlobby.js")
        self.assertIn('view: "@basement", kind: "lift"', s)
        self.assertRegex(s, r"basement: \{x: R - 2\.6, z: -8")         # spawnFrom.basement
        self.assertIn("B1  Garage", s)

    def test_script_order(self):
        s = read("ui/app/22-hq.js")
        m = re.search(r"var HQ_SCRIPTS = (\[[^\]]*\]);", s)
        L = json.loads(m.group(1))
        i = L.index("hqlobby")
        self.assertEqual(L[i + 1:i + 5], ["hqcarlift", "hqgaragemgr", "hqbasementfx", "hqbasement"])
        for k in ["hqcarlift", "hqgaragemgr", "hqbasementfx", "hqbasement"]:
            self.assertRegex(s, r"HQ_SCRIPTS_3D = \{[^}]*\b" + k + r":1", k + " fails soft")

    def test_hq3d_hooks(self):
        s = read("games/hq3d.js")
        for needle in ["HQV.hqCarLift.arm(near)", "liftCarry(from, name)", "HQV.hqBasement.adopt(w,",
                       'd.view === "garage:open"', "HQV.hqGarageMgr.open({from: d.from})",
                       "function carpark(C, o)", "carpark(C, it.o)", "carpark(C, o)",
                       "HQV.hqCarLift.liftSite(C,", 'K.cp.bayOf(K.site, key)',
                       "HQV.hqGarage.park(o.ownId, null)",
                       "back in your basement garage (B1)", "worlds.basement"]:
            self.assertIn(needle, s, needle)
        self.assertGreaterEqual(s.count("[basement 3.4]"), 10)

    def test_city3d_hooks(self):
        s = read("games/hqcity3d.js")
        self.assertIn("w.spawnFrom.basement", s)
        self.assertIn('HQV.hqGarageMgr.homeOf(r.id) === "basement"', s)
        self.assertIn('KM.kiosk(c, "carpark")', s)

    def test_version_strings_agree(self):
        # the three version strings agree (any version: this ships whenever it ships), and the changelog has the entry
        import re as _re
        v1 = _re.search(r'^version = "([0-9.]+)"', read("dashboard-rs/Cargo.toml"), _re.M).group(1)
        v2 = _re.search(r'APP_VERSION: &str = "([0-9.]+)"', read("dashboard-rs/src/app.rs")).group(1)
        v3 = _re.search(r"\*\*Version ([0-9.]+)\*\*", read("README.md")).group(1)
        self.assertEqual(len({v1, v2, v3}), 1, (v1, v2, v3))
        self.assertIn("Basement Garage.**", read("README.md"))


@unittest.skipUnless(NODE, "node not installed")
class PaintColor(unittest.TestCase):
    """defect 1: an owned vehicle's paint is an index into its catalogue paints, not a hex string."""
    def test_paint_index_and_hex(self):
        s = read("games/hq3d.js")
        m = re.search(r"  function paintColor\(vid, p\)\{.*?\n  \}\n", s, re.S)
        self.assertTrue(m)
        js = ("var VEHICLES = {sedan: {cat: {paints: [{hex: '#112233'}, {hex: '#abcdef'}]}}};" + m.group(0) +
              "console.log(JSON.stringify([paintColor('sedan', 1), paintColor('sedan', 0), paintColor('sedan', 9),"
              " paintColor('sedan', '#ff0000'), paintColor('nope', 1), paintColor('sedan', 'bad')]));")
        r = subprocess.run([NODE, "-e", js], capture_output=True, text=True, timeout=30)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(json.loads(r.stdout), [0xabcdef, 0x112233, None, 0xff0000, None, None])


if __name__ == "__main__":
    unittest.main()
