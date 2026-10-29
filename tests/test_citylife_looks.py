"""City life's looks (HQ 3.21): buildings by use and the footpaths' furniture (games/worldgeom.js, games/worldbuild.js).

Under node, on the @3 commons fixture with games/citylife.js loaded: every window's lit attribute is its lot's use code
(and a shopfront's its opening hours), the detail-1 body carries the use, LIT_GLSL (run as JS) agrees with litAt on a
grid of codes and hours, shop and cafe lots get a shopfront with an awning, loading bays a shutter, flat roofs their
clutter, the furniture lands in its tiles on the ground, and the triangle and draw-call growth stays inside budget
(worldbuild under node with the vendored three.js). Without citylife.js the same build is unchanged. Skipped without
node."""
import json
import os
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")

SCRIPT = r"""
import { createRequire } from "module";
const require = createRequire(import.meta.url);
var fs = require("fs"), zlib = require("zlib"), crypto = require("crypto"), root = %(root)s;
global.window = {HQV: {}};
for (var f of ["world", "citylife", "worldgeom"]) new Function(fs.readFileSync(root + "/games/" + f + ".js", "utf8"))();
var HQV = window.HQV, Q = HQV.world, G = HQV.worldgeom, CL = HQV.cityLife, out = {};
var W = Q.pack(JSON.parse(zlib.gunzipSync(fs.readFileSync(root + "/tests/fixtures/claude-hq@3.json.gz"))));
var U = CL.landUse(W), NT = G.NT;
function digest(o){
  var h = crypto.createHash("sha1");
  (function walk(v){
    if(v && ArrayBuffer.isView(v)){ h.update(Buffer.from(v.buffer, v.byteOffset, v.byteLength)); return; }
    if(Array.isArray(v)){ v.forEach(walk); return; }
    if(v && typeof v === "object"){ Object.keys(v).sort().forEach(function(k){ h.update(k); walk(v[k]); }); return; }
    h.update(String(JSON.stringify(v)));
  })(o);
  return h.digest("hex");
}
function same(a, b){ return Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6 && Math.abs(a[2] - b[2]) < 1e-6; }
function colAt(g, i){ return [g.col[3*i], g.col[3*i + 1], g.col[3*i + 2]]; }
function build(){
  var t = {}, b0 = 0, b1 = 0, maxTile = 0;
  for(var tz = 0; tz < NT; tz++) for(var tx = 0; tx < NT; tx++){
    var d0 = G.buildingTile(W, tx, tz, 0), d1 = G.buildingTile(W, tx, tz, 1);
    t[tx + "," + tz] = {d0: d0, d1: d1, p: G.props(W, tx, tz)};
    var n = (d0.body.idx.length + d0.win.idx.length)/3;
    b0 += n; b1 += d1.body.idx.length/3; maxTile = Math.max(maxTile, n);
  }
  return {t: t, b0: b0, b1: b1, maxTile: maxTile};
}
var A = build();

// ---- windows: each lot's use code; shopfront glass its opening hours; detail 1 bodies carry the use ----
var lit = {n: 0, legacy: 0, wrongUse: 0, kinds: {}}, d1 = {n: 0, wrong: 0}, perLot = {};
Object.keys(A.t).forEach(function(k){
  var w = A.t[k].d0.win, b = A.t[k].d1.body;
  for(var i = 0; i < w.lit.length; i++){
    var c = w.lit[i], id = w.bid[i], u = U[id];
    lit.n++;
    if(c < 2){ lit.legacy++; continue; }
    var kind = CL.LIT[Math.floor(c - 2)];
    lit.kinds[kind] = (lit.kinds[kind] || 0) + 1;
    if(!u || (kind !== u.use && kind !== "shop" && kind !== "cafe" && !(u.ground === "lobby" && kind === "office"))) lit.wrongUse++;
    (perLot[id] = perLot[id] || {})[kind] = 1;
  }
  for(i = 0; i < b.lit.length; i++){ var u2 = U[b.bid[i]]; d1.n++; if(!u2 || b.lit[i] !== 2 + CL.LIT.indexOf(u2.use)) d1.wrong++; }
});
out.lit = lit; out.d1 = d1;

// ---- ground floors and roofs: per lot, which of its parts were built ----
var AW = G.AWNINGS, CREAM = [0.93, 0.90, 0.82], SHUT = [0.60, 0.61, 0.62], AC = [0.74, 0.75, 0.76];
var lots = {};
Object.keys(A.t).forEach(function(k){
  var g = A.t[k].d0.body;
  for(var i = 0; i < g.bid.length; i++){
    var id = g.bid[i], L = lots[id] || (lots[id] = {awning: false, cream: false, shutter: false, ac: false, any: true});
    var c = colAt(g, i);
    if(AW.some(function(a){ return same(a, c); })) L.awning = true;
    if(same(c, CREAM)) L.cream = true;
    if(same(c, SHUT)) L.shutter = true;
    if(same(c, AC)) L.ac = true;
  }
});
var gf = {};
Object.keys(lots).forEach(function(id){
  var u = U[id];
  if(!u) return;
  var s = gf[u.ground] || (gf[u.ground] = {n: 0, awning: 0, cream: 0, shutter: 0, glassOpen: 0});
  s.n++;
  if(lots[id].awning) s.awning++;
  if(lots[id].cream) s.cream++;
  if(lots[id].shutter) s.shutter++;
  if(perLot[id] && (perLot[id].shop || perLot[id].cafe)) s.glassOpen++;
});
out.ground = gf;
out.roofAc = Object.keys(lots).filter(function(id){ return lots[id].ac; }).length;

// ---- furniture: in its tiles, on the ground, every kind, coloured canopies ----
var fu = {n: 0, outside: 0, offGround: 0, kinds: {}, uncoloured: 0}, all = CL.furniture(W).length;
Object.keys(A.t).forEach(function(k){
  (A.t[k].p.furniture || []).forEach(function(o){
    fu.n++;
    var t = G.tileOf(o.x, o.z);
    if(t.tx + "," + t.tz !== k) fu.outside++;
    var gy = Q.streetAt ? Q.streetAt(W, o.x, o.z) : Q.groundAt(W, o.x, o.z);
    if(!(Math.abs(o.y - gy) < 1e-6) || !isFinite(o.yaw)) fu.offGround++;
    fu.kinds[o.kind] = (fu.kinds[o.kind] || 0) + 1;
    if((o.kind === "stall" || o.kind === "table") && !(o.c && o.c.length === 3)) fu.uncoloured++;
  });
});
fu.all = all;
out.furn = fu;
out.tileMsg = Object.keys(G.buildTile(W, {id: 1, tx: 4, tz: 4, want: ["props"]}).props);

// ---- the shader table against the JS one: LIT_GLSL run as JS on float32 codes ----
var js = CL.LIT_GLSL.replace(/float (\w+)\(float (\w+), float (\w+)\)/g, "function $1($2, $3)").replace(/\bfloat (\w+) =/g, "var $1 =");
var glsl = new Function("step", "floor", js + "\nreturn hqLitAt;")(function(e, x){ return x < e ? 0 : 1; }, Math.floor);
var agree = {n: 0, bad: []};
var codes = [0, 1];
for(var i = 0; i < CL.LIT.length; i++) for(var r = 0; r < 60; r++) codes.push(CL.litCode(CL.LIT[i], (r + 0.37)/60));
for(var h = 0; h < 24; h += 0.25) [h, h + 0.1].forEach(function(hh){
  codes.forEach(function(c){
    var c32 = Math.fround(c), a = CL.litAt(c32, hh), b = glsl(c32, hh) > 0.5;
    agree.n++;
    if(a !== b && agree.bad.length < 10) agree.bad.push([c, hh, a, b]);
  });
});
out.agree = agree;
out.hours = {shopOpen: CL.litAt(CL.litCode("shop", 0.5), 12), shopShut: CL.litAt(CL.litCode("shop", 0.5), 22),
             cafeLate: CL.litAt(CL.litCode("cafe", 0.5), 22), cafeShut: CL.litAt(CL.litCode("cafe", 0.5), 3)};

// ---- budgets: the same build without city life (worldgeom reads HQV.cityLife at build time) ----
var keep = HQV.cityLife;
HQV.cityLife = undefined;
var B0 = build();
out.budget = {b0: A.b0, b1: A.b1, maxTile: A.maxTile, base0: B0.b0, base1: B0.b1, baseMax: B0.maxTile};
out.plainProps = Object.keys(B0.t["4,4"].p).sort();
out.plainLit = (function(){ var s = {}; Object.keys(B0.t).forEach(function(k){ var l = B0.t[k].d0.win.lit; for(var i = 0; i < l.length; i++) s[l[i]] = 1; }); return Object.keys(s).sort(); })();
HQV.cityLife = keep;

// ---- worldbuild with three.js: draw calls and triangles, with and without city life ----
const THREE = await import(root + "/games/vendor/three-module.js");
new Function(fs.readFileSync(root + "/games/worldbuild.js", "utf8"))();
var WB = HQV.worldbuild;
function tick(){ return new Promise(function(r){ setTimeout(r, 2); }); }
async function settle(wb, cam){ for(var i = 0; i < 400; i++){ wb.update(cam); await tick(); wb.update(cam); if(wb.stats().pending === 0) return true; } return false; }
async function cams(withCL){
  HQV.cityLife = withCL ? keep : undefined;
  var Wc = Q.pack(JSON.parse(zlib.gunzipSync(fs.readFileSync(root + "/tests/fixtures/claude-hq@3.json.gz"))));
  var wb = WB.create({THREE: THREE}, Wc, {worker: false});
  await wb.ready;
  var res = {};
  for(const p of [[0, 0], [200, -150], [-400, 300]]){
    var cm = {x: p[0], z: p[1], mode: "near"};
    await settle(wb, cm); wb.update(cm);
    var s = wb.stats();
    res[p.join(",")] = {dc: s.drawCalls, tri: s.triangles};
  }
  var furn = [];
  wb.root.children.forEach(function(o){ if(/^furniture /.test(o.name || "")) furn.push({name: o.name, count: o.count}); });
  res.furn = furn;
  res.hour = typeof wb.setHour === "function";
  if(withCL){
    // what furnitureAt finds: the furniture under a drawn one, nothing a few metres off
    var f = CL.furniture(Wc)[0];
    res.blockAt = f ? wb.furnitureAt(f.x, f.z) : null;
    res.clearAt = f ? wb.furnitureAt(f.x + 3, f.z + 3) : "none";
  }
  wb.destroy();
  return res;
}
out.wbCL = await cams(true);
out.wbPlain = await cams(false);
HQV.cityLife = keep;
process.stdout.write(JSON.stringify(out));
"""


@unittest.skipUnless(NODE, "node not installed")
class CityLifeLooks(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        r = subprocess.run([NODE, "--input-type=module", "-e", SCRIPT % {"root": json.dumps(ROOT)}],
                           capture_output=True, text=True, timeout=900)
        if r.returncode:
            raise AssertionError(r.stderr[-4000:])
        cls.o = json.loads(r.stdout)

    def test_windows_get_their_lots_use_codes(self):
        lit = self.o["lit"]
        self.assertGreater(lit["n"], 10000)
        self.assertEqual(lit["legacy"], 0, "every window of a building lot has a use code")
        self.assertEqual(lit["wrongUse"], 0, lit)
        for k in ("home", "office", "shop", "cafe"):
            self.assertGreater(lit["kinds"].get(k, 0), 0, (k, lit["kinds"]))
        self.assertGreater(lit["kinds"].get("warehouse", 0) + lit["kinds"].get("workshop", 0), 0)
        self.assertGreater(self.o["d1"]["n"], 1000)
        self.assertEqual(self.o["d1"]["wrong"], 0, "a detail-1 body carries 2 + its use")

    def test_shader_table_agrees_with_litAt(self):
        a = self.o["agree"]
        self.assertGreater(a["n"], 30000)
        self.assertEqual(a["bad"], [])
        self.assertEqual(self.o["hours"], {"shopOpen": True, "shopShut": False, "cafeLate": True, "cafeShut": False})

    def test_shops_and_cafes_get_a_shopfront_with_an_awning(self):
        g = self.o["ground"]
        for k in ("shop", "cafe"):
            s = g[k]
            self.assertGreater(s["n"], 5, k)
            self.assertGreaterEqual(s["awning"], 0.9*s["n"], (k, s))
            self.assertGreaterEqual(s["glassOpen"], 0.9*s["n"], (k, s))
        self.assertGreaterEqual(g["cafe"]["cream"], 0.9*g["cafe"]["n"], "a cafe's striped awning")
        self.assertEqual(g["door"]["awning"], 0, "a front door has no awning")
        if "loading" in g:
            self.assertGreaterEqual(g["loading"]["shutter"], 0.9*g["loading"]["n"], g["loading"])
        self.assertGreater(self.o["roofAc"], 20, "flat roofs get their clutter")

    def test_furniture_props_per_tile_on_the_ground(self):
        f = self.o["furn"]
        self.assertGreater(f["n"], 100)
        self.assertLessEqual(f["n"], f["all"])
        self.assertGreater(f["n"], 0.9*f["all"], "only what stands in a terrain hole is left out")
        self.assertEqual(f["outside"], 0)
        self.assertEqual(f["offGround"], 0)
        self.assertEqual(f["uncoloured"], 0)
        for k in ("bin", "table"):
            self.assertIn(k, f["kinds"])
        self.assertIn("furniture", self.o["tileMsg"])

    def test_without_city_life_nothing_changes(self):
        self.assertEqual(self.o["plainProps"], ["gantries", "lamps", "parked", "signs", "trees"])
        self.assertEqual(self.o["plainLit"], ["0", "1"])
        self.assertEqual(self.o["wbPlain"]["furn"], [])

    def test_budgets(self):
        b = self.o["budget"]
        self.assertEqual(b["b1"], b["base1"], "detail 1 stays a box")
        self.assertLessEqual(b["b0"], 1.5*b["base0"], b)          # shopfronts, awnings and roof clutter: modest
        self.assertLessEqual(b["maxTile"], 1.5*b["baseMax"], b)
        self.assertLessEqual(b["b0"], 600000, b)
        cl, plain = self.o["wbCL"], self.o["wbPlain"]
        self.assertTrue(cl["hour"])
        self.assertGreater(len(cl["furn"]), 0)
        self.assertLessEqual(len(cl["furn"]), 6)
        for cam in ("0,0", "200,-150", "-400,300"):
            self.assertLessEqual(cl[cam]["dc"] - plain[cam]["dc"], 6, (cam, cl[cam], plain[cam]))
            self.assertGreaterEqual(cl[cam]["dc"], plain[cam]["dc"], cam)
        self.assertIsNotNone(cl["blockAt"])
        self.assertIsNone(cl["clearAt"])


if __name__ == "__main__":
    unittest.main()
