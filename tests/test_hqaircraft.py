"""The aircraft models (games/hqaircraft.js, HQV.hqAircraft; airport spec rev 2, sections 6 and 11).

node imports the vendored three.js, loads games/hqmerge.js, games/hqships.js (the merge helper the models
use) and games/hqaircraft.js against a stub `window` and a stub hq3d ctx, and reports: the parked fleets'
draw calls (HQV.hqMerge.drawCount) for n = 1 and 12, day and night; per-plane liveries and their disposal;
DOOR_L1 / NOSE / SPAN against the model's own geometry; the amphibian's wheels; the phase-driven lights
(which light points are lit, no new draw call, per plane on clones). One node process; skipped without node."""
import json
import os
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")

HARNESS = r"""
var fs = require("fs"), url = require("url"), root = %(root)s;
import(url.pathToFileURL(root + "/games/vendor/three-module.js").href).then(function(THREE){
  global.window = {HQV: {}};
  ["hqmerge", "hqships", "hqaircraft"].forEach(function(f){ new Function(fs.readFileSync(root + "/games/" + f + ".js", "utf8"))(); });
  var HQV = window.HQV, A = HQV.hqAircraft, out = {};
  function mat(c, o){ return new THREE.MeshStandardMaterial(Object.assign({color: c, roughness: 0.7, metalness: 0.08}, o || {})); }
  var c = {THREE: THREE, mat: mat};
  out.consts = {DOOR_L1: A.DOOR_L1, NOSE: A.NOSE, SPAN: A.SPAN};
  out.airlines = A.AIRLINE_IDS.map(function(id){ return A.AIRLINES[id].name; });

  /* ---------- the parked fleets ---------- */
  out.parked = [];
  ["jet", "commuter"].forEach(function(kind){ [1, 12].forEach(function(n){
    var F = A.parked(c, kind, n), r = {kind: kind, n: n};
    for(var i = 0; i < n; i++) F.set(i, {x: i*50, y: 0.1, z: 0, yaw: i*0.3}, [0x1f9e9a, 0x23408e, 0x7a4cc2][i %% 3]);
    F.count(n);
    F.setNight(false); r.day = HQV.hqMerge.drawCount(F.g);
    F.setNight(true); r.night = HQV.hqMerge.drawCount(F.g);
    r.trisPerPlane = F.tris;
    r.inst = 0; F.g.traverse(function(o){ if(o.isInstancedMesh){ r.inst++; r.count = o.count; } });
    var brand = F.g.children.filter(function(o){ return /-brand$/.test(o.name); })[0];
    r.colors = n > 1 ? [0, 1].map(function(i){ var cc = new THREE.Color(); brand.getColorAt(i, cc); return cc.getHex(); }) : null;
    var m4 = new THREE.Matrix4(), p = new THREE.Vector3(); brand.getMatrixAt(n - 1, m4); p.setFromMatrixPosition(m4); r.last = [p.x, p.y, p.z];
    F.count(0); r.zero = HQV.hqMerge.drawCount(F.g);
    var disposed = 0; F.g.traverse(function(o){ if(o.material) o.material.addEventListener("dispose", function(){ disposed++; }); });
    F.dispose(); r.disposedMats = disposed;
    out.parked.push(r);
  }); });

  /* ---------- the airliner's geometry against the constants ---------- */
  var P = A.airliner(c, {brand: 0xe2805e});
  P.g.updateMatrixWorld(true);
  var bb = new THREE.Box3(), v = new THREE.Vector3(), door = [];
  P.g.traverse(function(o){
    if(!o.isMesh || /-gear$/.test(o.name)) return;
    var pos = o.geometry.attributes.position;
    for(var i = 0; i < pos.count; i++){
      v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld); bb.expandByPoint(v);
      if(/-dark$/.test(o.name) && v.x > 1.5 && Math.abs(v.z - 14.6) < 0.6) door.push([v.x, v.y, v.z]);
    }
  });
  out.bounds = {minX: bb.min.x, maxX: bb.max.x, maxZ: bb.max.z, minZ: bb.min.z};
  out.door = door.length ? {x: door.reduce(function(s, p){ return s + p[0]; }, 0)/door.length, sill: Math.min.apply(null, door.map(function(p){ return p[1]; })),
    z0: Math.min.apply(null, door.map(function(p){ return p[2]; })), z1: Math.max.apply(null, door.map(function(p){ return p[2]; }))} : null;

  /* ---------- liveries: own material, disposed with the plane; the shared one untouched ---------- */
  function brandMesh(X){ var m = null; X.g.traverse(function(o){ if(o.isMesh && /-brand$/.test(o.name)) m = o; }); return m; }
  var Q = P.clone(), Q2 = P.clone(), shared = brandMesh(P).material;
  Q.setLivery(0x1f9e9a, 0x23408e); Q2.setLivery(0x7a4cc2);
  var qm = brandMesh(Q).material, qg = brandMesh(Q).geometry, q2m = brandMesh(Q2).material, ev = {qm: 0, qg: 0, shared: 0, q2m: 0};
  qm.addEventListener("dispose", function(){ ev.qm++; }); qg.addEventListener("dispose", function(){ ev.qg++; });
  shared.addEventListener("dispose", function(){ ev.shared++; }); q2m.addEventListener("dispose", function(){ ev.q2m++; });
  // the fin takes the tail colour, the cheatline the brand colour (vertex colours on Q's own copy)
  var col = qg.attributes.color, pos = qg.attributes.position, fin = null, line = null;
  for(var i = 0; i < pos.count; i++){
    var x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i), hex = new THREE.Color(col.getX(i), col.getY(i), col.getZ(i)).getHex();
    if(Math.abs(x) < 0.3 && z < -15 && y > 8 && fin == null) fin = hex;
    if(Math.abs(x) > 1.85 && Math.abs(x) < 2.0 && y > 2.5 && y < 3.5 && line == null) line = hex;
  }
  out.livery = {own: qm !== shared, own2: q2m !== shared && q2m !== qm, q2color: q2m.color.getHex(), sharedColor: shared.color.getHex(),
    fin: fin, line: line, sharedGeo: brandMesh(Q2).geometry === brandMesh(P).geometry, vc: !!qm.vertexColors};
  Q.dispose(); Q2.dispose();
  out.livery.disposed = {qm: ev.qm, qg: ev.qg, q2m: ev.q2m, shared: ev.shared};
  P.dispose(); out.livery.disposed.sharedAfterOwner = ev.shared;

  /* ---------- the lights by phase ---------- */
  var J = A.airliner(c, {}), base = J.clone(), K = {};
  var Lt = null; base.g.traverse(function(o){ if(o.isPoints) Lt = o; });
  var kinds = ["red", "green", "white", "strobe", "strobe", "beacon", "beacon", "taxi", "landing", "landing"];
  function lit(X){ var pts = null; X.g.traverse(function(o){ if(o.isPoints) pts = o; }); var a = pts.geometry.attributes.color.array, r = {};
    kinds.forEach(function(k, i){ r[k] = (r[k] || 0) + (a[3*i] + a[3*i + 1] + a[3*i + 2] > 0 ? 1 : 0); }); return r; }
  var d0 = HQV.hqMerge.drawCount(base.g);
  // t = 0.05: inside the strobe's and the beacon's flash
  ["parked", "pushback", "taxi", "hold", "lineup", "takeoff", "cruise", "approach", "rollout", "exit"].forEach(function(ph){
    base.update(0.016, 99.05, true, 1, 5, ph); K[ph] = lit(base);
  });
  base.g.position.y = 0; base.update(0.016, 99.05, false, 1, 5, "taxi");
  base.g.position.y = 120; base.update(0.016, 99.05, false, 0, 80, "climb"); K.climbLow = lit(base);
  base.g.position.y = 900; base.update(0.016, 99.05, false, 0, 80, "climb"); K.climbHigh = lit(base);
  base.update(0.016, 100.5, false, 0, 80, "cruise"); K.cruiseOff = lit(base);
  base.update(0.016, 99.05, false, 1, 0); K.none = lit(base);
  out.lights = K; out.drawLights = [d0, HQV.hqMerge.drawCount(base.g)];
  // clones keep their own lights
  var b2 = J.clone(); b2.update(0.016, 99.05, true, 1, 5, "parked"); base.update(0.016, 99.05, true, 1, 5, "taxi");
  out.cloneLights = [lit(b2).taxi, lit(base).taxi];
  var lgd = 0; var lg = null; b2.g.traverse(function(o){ if(o.isPoints) lg = o.geometry; }); lg.addEventListener("dispose", function(){ lgd++; });
  b2.dispose(); out.cloneLightGeoDisposed = lgd;

  /* ---------- the amphibian ---------- */
  var M = A.amphibian(c, {}), mc = M.clone(), wheels = function(X){ var w = null; X.g.traverse(function(o){ if(/-wheels$/.test(o.name)) w = o; }); return w; };
  var bm = brandMesh(M).material.color.getHex();
  out.amph = {brand: bm, hasWheels: !!wheels(M), draws: HQV.hqMerge.drawCount(M.g)};
  mc.update(0.016, 1, false, 1, 0, "taxi", {surface: "land"}); out.amph.land = wheels(mc).visible;
  mc.update(0.016, 1, false, 1, 0, {phase: "taxi", surface: "water"}); out.amph.water = wheels(mc).visible;
  mc.update(0.016, 1, false, 0.3, 0, "climb", {surface: "land"}); out.amph.up = wheels(mc).visible;
  mc.update(0.016, 1, false, 1, 0, {phase: "rollout", surface: "land"}); out.amph.land2 = wheels(mc).visible;
  var sp = A.seaplane(c, {}); out.amph.seaWheels = !!wheels(sp);
  sp.update(0.016, 1, false, 1, 0); out.amph.seaOk = true;
  // the wheels sit in the floats: bottoms at y 0, under the floats' line
  var wb = new THREE.Box3().setFromObject(wheels(M)); out.amph.wheelBox = [wb.min.x, wb.max.x, wb.min.y, wb.max.y];
  mc.dispose(); M.dispose(); sp.dispose();
  process.stdout.write(JSON.stringify(out));
}).catch(function(e){ console.error(e && e.stack || e); process.exit(1); });
"""


@unittest.skipUnless(NODE, "node not installed")
class TestHqAircraft(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        js = HARNESS % {"root": json.dumps(ROOT)}
        p = subprocess.run([NODE, "-e", js], capture_output=True, text=True, timeout=300)
        if p.returncode != 0:
            raise AssertionError("node harness failed:\n" + p.stderr)
        cls.r = json.loads(p.stdout)

    def test_parked_fleet_draw_calls(self):
        self.assertEqual(len(self.r["parked"]), 4)
        for f in self.r["parked"]:
            self.assertLessEqual(f["day"], 7, f)
            self.assertLessEqual(f["night"], 7, f)
            self.assertEqual(f["count"], f["n"], f)
            self.assertEqual(f["zero"], 0, f)
            self.assertLessEqual(f["trisPerPlane"], 12000, f)
            self.assertGreater(f["disposedMats"], 0, f)
        twelve = [f for f in self.r["parked"] if f["n"] == 12]
        for f in twelve:
            self.assertEqual(f["colors"], [0x1f9e9a, 0x23408e])
            self.assertAlmostEqual(f["last"][0], 550, places=3)

    def test_constants_match_the_model(self):
        c, b, d = self.r["consts"], self.r["bounds"], self.r["door"]
        self.assertEqual(c["DOOR_L1"], [1.95, 2.5, 14.6])
        self.assertAlmostEqual(b["maxZ"], c["NOSE"], delta=0.1)
        self.assertAlmostEqual(b["maxX"] - b["minX"], c["SPAN"], delta=0.1)
        self.assertIsNotNone(d)
        self.assertAlmostEqual(d["x"], c["DOOR_L1"][0], delta=0.1)
        self.assertAlmostEqual(d["sill"], c["DOOR_L1"][1], delta=0.1)
        self.assertAlmostEqual((d["z0"] + d["z1"])/2, c["DOOR_L1"][2], delta=0.1)

    def test_livery(self):
        L = self.r["livery"]
        self.assertTrue(L["own"])
        self.assertTrue(L["own2"])
        self.assertEqual(L["q2color"], 0x7a4cc2)
        self.assertEqual(L["sharedColor"], 0xe2805e)
        self.assertTrue(L["vc"])
        self.assertEqual(L["fin"], 0x23408e)
        self.assertEqual(L["line"], 0x1f9e9a)
        self.assertTrue(L["sharedGeo"], "no tail colour: the brand mesh's geometry stays shared")
        D = L["disposed"]
        self.assertEqual(D["qm"], 1)
        self.assertEqual(D["qg"], 1)
        self.assertEqual(D["q2m"], 1)
        self.assertEqual(D["shared"], 0, "a clone's dispose leaves the shared material")
        self.assertEqual(D["sharedAfterOwner"], 1)

    def test_invented_airlines(self):
        self.assertEqual(self.r["airlines"], ["Archipelago Air", "Tokenline", "Context Airways", "Gradient Air", "Isle Hopper"])

    def test_lights_by_phase(self):
        K = self.r["lights"]
        self.assertEqual(sum(K["parked"].values()), 0)
        for ph in ("pushback", "taxi", "hold", "exit"):
            self.assertEqual(K[ph]["taxi"], 1, ph)
            self.assertEqual(K[ph]["beacon"], 2, ph)
            self.assertEqual(K[ph]["landing"], 0, ph)
            self.assertEqual(K[ph]["strobe"], 0, ph)
            self.assertEqual(K[ph]["red"] + K[ph]["green"], 2, ph)
        for ph in ("lineup", "takeoff", "approach", "rollout"):
            self.assertEqual(K[ph]["landing"], 2, ph)
            self.assertEqual(K[ph]["strobe"], 2, ph)
        self.assertEqual(K["lineup"]["taxi"], 1)
        self.assertEqual(K["takeoff"]["taxi"], 0)
        self.assertEqual(K["cruise"]["landing"], 0)
        self.assertEqual(K["cruise"]["strobe"], 2)
        self.assertEqual(K["cruiseOff"]["strobe"], 0, "the strobe is a flash, not steady")
        self.assertEqual(K["climbLow"]["landing"], 2)
        self.assertEqual(K["climbHigh"]["landing"], 0)
        # no phase: the old blink (no taxi or landing lights)
        self.assertEqual(K["none"]["taxi"] + K["none"]["landing"], 0)
        self.assertEqual(K["none"]["red"], 1)
        a, b = self.r["drawLights"]
        self.assertEqual(a, b)
        self.assertLessEqual(a, 7)
        self.assertEqual(self.r["cloneLights"], [0, 1])
        self.assertEqual(self.r["cloneLightGeoDisposed"], 1)

    def test_amphibian(self):
        m = self.r["amph"]
        self.assertEqual(m["brand"], 0xe07a2e)
        self.assertTrue(m["hasWheels"])
        self.assertFalse(m["seaWheels"])
        self.assertTrue(m["land"])
        self.assertFalse(m["water"])
        self.assertFalse(m["up"])
        self.assertTrue(m["land2"])
        self.assertTrue(m["seaOk"])
        x0, x1, y0, y1 = m["wheelBox"]
        self.assertAlmostEqual(y0, 0, delta=0.02)
        self.assertLess(y1, 0.85)
        self.assertLess(x1, 3.0)


if __name__ == "__main__":
    unittest.main()
