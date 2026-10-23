"""The HQ revamp's tower (games/hqtower.js) on the real worlds, and HQ Studio's styles applied to it.

Runs the tower under node with the vendored three.js and a stub hq3d ctx, on the Commons (claude-hq@2) and an island
(island@2) from tests/fixtures (the generator's real output, as tests/test_cities.py): the tower's size (a bit
bigger: wider, deeper and taller than the old one, by what its lot allows), its fit inside every Commons HQ lot, the
car-lift bay rules (3.5.8: inside the lot, 8 m clear out of its gate, never into the building), the roof pad (always,
inside the roof, clear of every crown), the draw-call budget (at most 1.5x the old tower's, by style and level; a far
tower's LOD much less), and each style option reaching the building. Stdlib only; skipped without node."""
import json
import os
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIX = os.path.join(ROOT, "tests", "fixtures")
COMMONS = os.path.join(FIX, "claude-hq@2.json.gz")
ISLAND = os.path.join(FIX, "island@2.json.gz")
NODE = shutil.which("node")
# the old tower's draws after the City's merge (measured on main before the revamp: level -> draws)
OLD_DRAWS = {1: 26, 10: 40, 25: 75, 30: 94, 50: 100}
# the old tower's height (lobby 3.5 + 2.6 m floors + the upper tier's 0.5 m step), by level
def old_top(level):
    low = min(8, 1 + level // 5)
    high = min(8, 1 + (level - 25) // 4) if level >= 25 else 0
    return 3.5 + low * 2.6 + ((0.5 + high * 2.6) if high else 0)


HARNESS = r"""
import fs from "fs";
import zlib from "zlib";
const root = %(root)s;
const THREE = await import(root + "/games/vendor/three-module.js");
globalThis.window = {HQV: {}};
const HQV = window.HQV;
for (const f of ["hqstyle", "hqtower", "hqbase", "world", "hqcityparts", "hqcity", "hqmerge", "hqcity3d"]) new Function(fs.readFileSync(root + "/games/" + f + ".js", "utf8"))();
const gz = p => JSON.parse(zlib.gunzipSync(fs.readFileSync(p)).toString("utf8"));
const C3 = HQV.hqCity3d, T = HQV.hqTower, S = HQV.hqStyle;
var noop2d = new Proxy({}, {get(t, k){ return k === "measureText" ? function(){ return {width: 10}; } : (k === "createLinearGradient" || k === "createRadialGradient") ? function(){ return {addColorStop(){}}; } : function(){}; }, set(){ return true; }});
function hashStr(s){ var h = 2166136261 >>> 0; s = String(s); for(var i = 0; i < s.length; i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h >>> 0; }
function rng(seed){ var a = seed >>> 0 || 1; return function(){ a = (a + 0x6D2B79F5) >>> 0; var t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0)/4294967296; }; }
function mat(c, o){ return new THREE.MeshStandardMaterial(Object.assign({color: c, roughness: 0.7, metalness: 0.08}, o || {})); }
function emis(c, e, ei, o){ var m = mat(c, o); m.emissive = new THREE.Color(e); m.emissiveIntensity = ei; return m; }
function add(o, x, y, z, p){ o.position.set(x, y, z); p.add(o); return o; }
var fonts = [];
var c = {THREE, PI: Math.PI, COL: {amber: 0xffb347, cyan: 0x5fd3e6, green: 0x6fd38a, coral: 0xff6b5b}, HEX: {green: "#6fd38a", amber: "#ffb347", cyan: "#5fd3e6", ink: "#e9eff3", coral: "#ff6b5b"},
  E: {calm(){ return false; }}, rng, hashStr, mat, emis, add,
  box(w, h, d, m, x, y, z, p){ return add(new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m), x, y, z, p); },
  cyl(rt, rb, h, m, x, y, z, p, seg){ return add(new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg || 12), m), x, y, z, p); },
  sph(r, m, x, y, z, p){ return add(new THREE.Mesh(new THREE.SphereGeometry(r, 8, 6), m), x, y, z, p); },
  canvasTex(w, h, draw){ var g = new Proxy(noop2d, {set(t, k, v){ if(k === "font") fonts.push(v); return true; }}); if(draw) draw(g, w, h); return {c: null, g: g, t: new THREE.Texture()}; },
  screen(w, h, t){ return new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({map: t})); },
  glow(col){ return new THREE.Sprite(new THREE.SpriteMaterial({color: col, transparent: true})); },
  label(t){ var s = new THREE.Sprite(new THREE.SpriteMaterial()); s.name = "label:" + t; return s; }, glyph(){ return new THREE.Sprite(new THREE.SpriteMaterial()); },
  short(s, n){ s = String(s || ""); return s.length > n ? s.slice(0, n) : s; }};
function make(level, look, grand, stars){
  return HQV.hqBuilding(c, {level(){ return level; }, look(){ return look; }, live(){ return 2; }, campus: false, grand: grand, prestige: stars ? function(){ return stars; } : null,
    door: {view: "@lobby"}, doorFront(){ return new THREE.Vector3(0, 0, 4.8); }});
}
// as hqcity3d building(): keepMesh + the moving parts, then hqmerge; draws = meshes (x materials) + sprites
function draws(B){
  function keepMesh(o){ if(!o || !o.isMesh || o.isInstancedMesh) return true; var u = o.userData || {}; if(u.door || u.anim || u.fade || u.wave != null) return true;
    var m = o.material; if(!m || Array.isArray(m)) return true; if(m.transparent || m.map || m.emissiveMap) return true;
    return !!(m.emissive && m.emissiveIntensity > 0 && (m.emissive.r || m.emissive.g || m.emissive.b)); }
  var g = B.g;
  function pose(){ var s = {}; g.traverse(o => { s[o.uuid] = o.position.toArray().concat(o.quaternion.toArray(), [o.visible ? 1 : 0]).join(","); }); return s; }
  var a = pose(); B.animate(3.7, 0, 1); var b = pose(), roots = {}; Object.keys(a).forEach(id => { if(a[id] !== b[id]) roots[id] = 1; });
  function under(o){ for(var p = o; p && p !== g; p = p.parent) if(roots[p.uuid]) return true; return false; }
  HQV.hqMerge.mergeStatic(THREE, g, {keep: o => (o.isMesh && keepMesh(o)) || under(o)});
  function count(){ var n = 0; g.traverse(o => { var v = true; for(var p = o; p; p = p.parent) if(!p.visible) v = false; if(!v) return;
    if(o.isMesh) n += Array.isArray(o.material) ? o.material.length : 1; else if(o.isSprite) n++; }); return n; }
  var full = count(); B.setLod(1); var far = count(); B.setLod(0);
  return {full, far};
}
const out = {};
/* ---------- the shape ---------- */
out.massing = [];
[1, 5, 10, 15, 20, 25, 30, 40, 45, 50, 60].forEach(function(L){ [0, 0.5, 1].forEach(function(g){ [0, 3].forEach(function(st){
  var M = T.massing(L, g, st), R = M.roof, P = M.pad, slots = T.crownSlots(M);
  out.massing.push({L, g, st, top: M.top, w: M.podium.w, d: M.podium.d, wings: M.wings.length,
    padIn: Math.abs(P.x - R.x) + P.r <= R.w/2 + 1e-6 && Math.abs(P.z - R.z) + P.r <= R.d/2 + 1e-6, padR: P.r, padY: P.y - R.y,
    slotsOut: slots.every(s => Math.hypot(s.x - P.x, s.z - P.z) > P.r + 0.3 && Math.abs(s.x - R.x) < R.w/2 && Math.abs(s.z - R.z) < R.d/2), nslots: slots.length,
    tiers: M.tiers.map(t => [t.floors, +(t.h/T.FH).toFixed(6)])});
}); }); });
/* ---------- every Commons lot (and the island's) ---------- */
function inRing(P, x, z){ var inside = false; for(var i = 0, j = P.length - 1; i < P.length; j = i++){ var xi = P[i][0], zi = P[i][1], xj = P[j][0], zj = P[j][1]; if((zi > z) !== (zj > z) && x < (xj - xi)*(z - zi)/(zj - zi) + xi) inside = !inside; } return inside; }
function boxIn(P, p, b){ for(var i = -1; i <= 1; i += 0.5) for(var j = -1; j <= 1; j += 0.5){ var w = C3.toWorld(p, b[0] + i*b[2], b[1] + j*b[3]); if(!inRing(P, w.x, w.z)) return false; } return true; }
var G = HQV.hqLotExtras.garage;
out.lots = [];
[["commons", %(commons)s], ["island", %(island)s]].forEach(function(wd){
  var W = HQV.world.pack(gz(wd[1]));
  W.lots.filter(l => l.kind === "hq").forEach(function(l){
    var P = l.poly.map(q => [q[0]/100, q[1]/100]), p = C3.placeLot(l), g = C3.grandOf(l, p), o = {world: wd[0], id: l.id, grand: g, worse: 0, bays: []};
    for(var wings = 0; wings <= 2; wings++){
      var b0 = C3.hqFoot(0, wings), b1 = C3.hqFoot(g, wings);
      b1.forEach(function(b, i){ if(i !== 1 && boxIn(P, p, b0[i]) && !boxIn(P, p, b)) o.worse++; });       // a part that fitted no longer does
      var bay = C3.garagePlace(l, p, wings, g);
      if(!bay){ o.bays.push(null); continue; }
      var inLot = true; for(var i = -1; i <= 1; i++) for(var j = -1; j <= 1; j++){ var w = C3.toWorld(p, bay.x + i*(G.w/2 + 0.3), bay.z + j*(G.d/2 + 0.3)); if(!inRing(P, w.x, w.z)) inLot = false; }
      var a0 = bay.f === -1 ? bay.z - G.d/2 - 8 : bay.z + G.d/2, a1 = a0 + 8, keep = b1.concat([[0, C3.HQ_DOOR + 6, 1.6, 6]]);
      var into = keep.some(K => Math.abs(bay.x - K[0]) < G.w/2 + K[2] && a1 > K[1] - K[3] && a0 < K[1] + K[3]);
      var onHq = b1.some(K => Math.abs(bay.x - K[0]) < G.w/2 + 0.3 + K[2] && Math.abs(bay.z - K[1]) < G.d/2 + 0.3 + K[3]);
      o.bays.push({inLot, into, onHq, f: bay.f});
    }
    out.lots.push(o);
  });
});
/* ---------- the building: its size against the old one, its meshes inside its footprint ---------- */
out.build = [];
[1, 10, 30, 50].forEach(function(L){ [0, 1].forEach(function(g){
  var B = make(L, {}, g), box = new THREE.Box3(), fp = T.footprint(g, B.wings);
  B.g.updateMatrixWorld(true);
  B.g.traverse(o => { if(!o.isMesh || o.name === "prestige-beacon") return; var bb = new THREE.Box3().setFromObject(o); if(isFinite(bb.min.x)) box.union(bb); });
  out.build.push({L, g, top: B.top(), wings: B.wings, minX: box.min.x, maxX: box.max.x, minZ: box.min.z, maxZ: box.max.z,
    fpX: Math.max.apply(null, fp.map(b => Math.abs(b[0]) + b[2])), fpZ0: Math.min.apply(null, fp.map(b => b[1] - b[3])), fpZ1: Math.max.apply(null, fp.map(b => b[1] + b[3])),
    pad: B.pad(), deck: B.roofDeck(), lift: B.roofLift(), padMesh: !!B.g.getObjectByName("hq-helipad"), padLights: !!B.g.getObjectByName("hq-padlights")});
}); });
/* ---------- draws by style and level ---------- */
out.draws = {};
Object.keys(S.PRESETS).forEach(function(pr){ [1, 10, 25, 30, 50].forEach(function(L){
  out.draws[pr + ":" + L] = draws(make(L, {style: S.preset(pr), decor: "neon", crew: {color: "#ff6b5b", tag: "AB"}}, 1));
}); });
/* ---------- each option reaches the building ---------- */
function sig(B){ var s = []; B.g.traverse(o => { if(o.isMesh){ var g = o.geometry, m = Array.isArray(o.material) ? o.material[0] : o.material;
    s.push(o.name + ":" + (g.attributes.position ? g.attributes.position.count : 0) + ":" + (m && m.map ? m.map.uuid : "") + ":" + (m && m.color ? m.color.getHexString() : "")); } }); return s.sort().join("|"); }
function matOf(B, name){ var m = null; B.g.traverse(o => { if(o.isMesh && o.name === name && !m) m = o.material; }); return m; }
var base = S.defaults(), B0 = make(30, {style: base}, 1), s0 = sig(B0);
out.options = {};
var X = S.SCHEMA.ext;
["facade", "material", "tint", "crown", "entrance", "flags", "land", "balcony", "roof"].forEach(function(k){
  var vals = k === "balcony" ? [false] : k === "roof" ? [["tank", "solar", "garden"]] : X[k].enum.filter(v => v !== base.ext[k]);
  out.options[k] = vals.map(function(v){ var d = S.clean(base); d.ext[k] = v; var B = make(30, {style: d}, 1); return sig(B) !== s0 || JSON.stringify(B.stale ? 0 : 1) === "x"; });
});
var dc = S.clean(base); dc.ext.body = "#123456"; dc.ext.trim = "#abcdef"; dc.ext.night = "#ff0000";
var Bc = make(30, {style: dc}, 1);
out.colors = {body: matOf(Bc, "hqt:body").color.getHexString(), trim: matOf(Bc, "hqt:trim").color.getHexString(), lit: matOf(Bc, "hqt:lit").color.getHexString()};
fonts.length = 0; var df = S.clean(base); df.ext.font = "serif"; make(1, {style: df, sign: "Ann"}, 1); out.fontSerif = fonts.some(f => /Georgia/.test(f));
// the old look (paint, accent) still colours a tower that never opened the Studio
var Bo = make(5, {paint: "#3f8f5a", accent: "#ff6b5b"}, 1); out.oldLook = [matOf(Bo, "hqt:body").color.getHexString(), matOf(Bo, "hqt:trim").color.getHexString()];
// stale: a new style rebuilds; the night and live switches never need one
var stl = {style: S.defaults()}, Bs = HQV.hqBuilding(c, {level(){ return 10; }, look(){ return stl; }, campus: false, door: {}, doorFront(){ return new THREE.Vector3(); }});
var st0 = Bs.stale(); stl = {style: S.preset("tokyo")}; out.stale = [st0, Bs.stale()];
Bs.setNight(false); Bs.setLive(8); out.hqKeyStyle = C3.hqKey({h: {userId: "u", style: {a: 1}}, lot: {id: 1}}) !== C3.hqKey({h: {userId: "u", style: {a: 2}}, lot: {id: 1}});
// a wire style that is nonsense still builds (clean)
try { make(10, {style: {v: 9, ext: {facade: "evil<script>", body: "red", roof: "x"}, int: 5}}, 1); out.junk = true; } catch(e){ out.junk = String(e); }
console.log(JSON.stringify(out));
"""


@unittest.skipUnless(NODE and os.path.exists(COMMONS) and os.path.exists(ISLAND), "node or the @2 fixtures missing")
class HqTower(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        src = HARNESS % {"root": json.dumps(ROOT), "commons": json.dumps(COMMONS), "island": json.dumps(ISLAND)}
        r = subprocess.run([NODE, "--input-type=module", "-e", src], capture_output=True, text=True, timeout=600)
        if r.returncode != 0:
            raise AssertionError("node failed:\n" + r.stderr[-4000:])
        cls.out = json.loads(r.stdout)

    def test_pad_always_on_the_roof_and_clear_of_the_crown(self):
        for m in self.out["massing"]:
            with self.subTest(level=m["L"], grand=m["g"], stars=m["st"]):
                self.assertTrue(m["padIn"], "the pad stays on the roof")
                self.assertGreaterEqual(m["padR"], 2.0)
                self.assertTrue(m["slotsOut"], "crown slots stay off the pad")
                self.assertGreaterEqual(m["nslots"], 2, "a crown and the roof lift need their corners")
                for floors, fh in m["tiers"]:
                    self.assertAlmostEqual(floors, fh)

    def test_a_bit_bigger(self):
        for m in self.out["massing"]:
            if m["st"]:
                continue
            ratio = m["top"] / old_top(m["L"])
            with self.subTest(level=m["L"], grand=m["g"]):
                self.assertGreaterEqual(ratio, 1.15 if m["L"] >= 10 else 1.15)
                if m["L"] >= 25:
                    self.assertLessEqual(ratio, 1.35, "taller, not a different scale")
                if m["g"] == 1:
                    area = m["w"] * m["d"] / (9 * 7)
                    self.assertTrue(1.2 <= area <= 1.3, area)

    def test_every_commons_lot_fits(self):
        lots = [l for l in self.out["lots"] if l["world"] == "commons"]
        self.assertGreater(len(lots), 60)
        for l in self.out["lots"]:
            with self.subTest(world=l["world"], lot=l["id"]):
                self.assertIn(l["grand"], (0, 0.25, 0.5, 0.75, 1))
                self.assertEqual(l["worse"], 0, "a footprint part that fitted the lot no longer does")
        grand = [l for l in lots if l["grand"] >= 0.75]
        self.assertGreater(len(grand) / len(lots), 0.75, "most lots get the bigger tower")

    def test_car_lift_bays_still_hold(self):
        for l in self.out["lots"]:
            for wings, b in enumerate(l["bays"]):
                with self.subTest(world=l["world"], lot=l["id"], wings=wings):
                    self.assertIsNotNone(b, "no room for the car-lift bay")
                    self.assertTrue(b["inLot"])
                    self.assertFalse(b["into"], "8 m out of the gate runs into the HQ")
                    self.assertFalse(b["onHq"])
        self.assertTrue(any(b and b["f"] == -1 for l in self.out["lots"] for b in l["bays"]))

    def test_building_inside_its_footprint(self):
        for b in self.out["build"]:
            with self.subTest(level=b["L"], grand=b["g"]):
                self.assertLessEqual(max(-b["minX"], b["maxX"]), b["fpX"] + 0.35)
                self.assertGreaterEqual(b["minZ"], b["fpZ0"] - 0.35)
                self.assertLessEqual(b["maxZ"], b["fpZ1"] + 0.35)
                self.assertTrue(b["padMesh"] and b["padLights"])
                self.assertAlmostEqual(b["pad"]["y"], b["deck"]["y"] + 0.2, places=3)
                self.assertTrue(abs(b["lift"]["x"] - b["deck"]["x"]) <= b["deck"]["hw"] + 0.6)

    def test_draw_budget(self):
        for k, d in self.out["draws"].items():
            level = int(k.split(":")[1])
            with self.subTest(style=k):
                self.assertLessEqual(d["full"], OLD_DRAWS[level] * 1.5, "more than 1.5x the old tower's draws")
                self.assertLessEqual(d["far"], 8, "a far tower shows its masses only")

    def test_options_reach_the_building(self):
        for k, changed in self.out["options"].items():
            with self.subTest(option=k):
                self.assertTrue(changed and all(changed), k)
        self.assertEqual(self.out["colors"], {"body": "123456", "trim": "abcdef", "lit": "ff0000"})
        self.assertTrue(self.out["fontSerif"])
        self.assertEqual(self.out["oldLook"], ["3f8f5a", "ff6b5b"])
        self.assertEqual(self.out["stale"], [False, True])
        self.assertTrue(self.out["hqKeyStyle"])
        self.assertIs(self.out["junk"], True)


if __name__ == "__main__":
    unittest.main()
