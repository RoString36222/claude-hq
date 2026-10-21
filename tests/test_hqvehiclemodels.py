"""Stand-in vehicle bodies (games/hqvehiclemodels.js, docs/plans/dealership-spec.md).

node builds every body type with the vendored three.js; the Python side checks the budgets (triangles, draw
calls), the size against the catalogue's dims, the rig the 3D City rides (wheels on the wheelbase and on the
ground, the steering, the rider's anchors), the paint, shared geometry, the starters (hq3d's own car and
motorbike, untouched) and the glTF hook (a real model swapped in once it has loaded).
Skipped when node is not installed. Stdlib only."""
import json
import re
import os
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")

ENTRIES = [
    {"id": "t-sedan", "class": "car.sedan.3000", "brand": "BMW", "model": "M3 Competition",
     "dims": {"lengthM": 4.79, "widthM": 1.90, "heightM": 1.43, "wheelbaseM": 2.86}},
    {"id": "t-coupe", "class": "car.coupe.3000", "brand": "BMW", "model": "M2"},
    {"id": "t-hatch", "class": "car.hatch.2000", "brand": "BMW", "model": "M135 xDrive"},
    {"id": "t-suv", "class": "car.suv.5000", "brand": "BMW", "model": "X5 M Competition"},
    {"id": "t-ev", "class": "car.sedan.ev", "brand": "BMW", "model": "i7 M70",
     "dims": {"lengthM": 5.39, "widthM": 1.95, "heightM": 1.54, "wheelbaseM": 3.22}},
    {"id": "t-hyper", "class": "car.hyper.over5000", "brand": "Bugatti", "model": "Chiron Super Sport"},
    {"id": "t-plain", "class": "car.sedan.2000", "brand": "Acme", "model": "Saloon"},
    {"id": "t-naked", "class": "bike.naked.400", "brand": "KTM", "model": "390 Duke", "spec": {"cc": 399}},
    {"id": "t-naked-big", "class": "bike.naked.over950", "brand": "BMW", "model": "S 1000 R", "spec": {"cc": 999}},
    {"id": "t-sport", "class": "bike.sport.over950", "brand": "BMW", "model": "S 1000 RR", "spec": {"cc": 999}},
    {"id": "t-adv", "class": "bike.adventure.over950", "brand": "BMW", "model": "R 1300 GS", "spec": {"cc": 1300, "layout": "boxer"}},
    {"id": "t-classic", "class": "bike.classic.400", "brand": "Royal Enfield", "model": "Classic 350", "spec": {"cc": 349, "cyl": 1}},
    {"id": "t-classic-twin", "class": "bike.classic.950", "brand": "Royal Enfield", "model": "Interceptor 650", "spec": {"cc": 648, "cyl": 2}},
    {"id": "t-cruiser", "class": "bike.cruiser.over950", "brand": "Harley-Davidson", "model": "Fat Boy 114", "spec": {"cc": 1868, "cyl": 2, "layout": "v-twin-45"}},
    {"id": "t-hypersport", "class": "bike.hypersport.over950", "brand": "Kawasaki", "model": "Ninja H2", "spec": {"cc": 998, "cyl": 4}},
    {"id": "t-busa", "class": "bike.hypersport.over950", "brand": "Suzuki", "model": "Hayabusa", "spec": {"cc": 1340, "cyl": 4}},
    {"id": "t-v4", "class": "bike.sport.over950", "brand": "Ducati", "model": "Panigale V4 S", "spec": {"cc": 1103, "cyl": 4, "layout": "v4"}},
    {"id": "t-r1", "class": "bike.sport.over950", "brand": "Yamaha", "model": "R1", "spec": {"cc": 998, "cyl": 4}},
    {"id": "t-triple", "class": "bike.naked.950", "brand": "Triumph", "model": "Street Triple 765 RS", "spec": {"cc": 765, "cyl": 3}},
    {"id": "t-super", "class": "car.super.over5000", "brand": "Lamborghini", "model": "Revuelto"},
    {"id": "t-sto", "class": "car.super.over5000", "brand": "Lamborghini", "model": "Huracán STO"},
    {"id": "t-urus", "class": "car.suv.5000", "brand": "Lamborghini", "model": "Urus Performante"},
]

HARNESS = r"""
import fs from "fs";
const root = %(root)s, ENTRIES = %(entries)s;
const THREE = await import(root + "/games/vendor/three-module.js");
globalThis.window = {HQV: {}};
new Function(fs.readFileSync(root + "/games/hqvehiclemodels.js", "utf8"))();
const V = window.HQV.hqVehicleModels, out = {rows: []};
const v3 = () => new THREE.Vector3();
function wpos(o){ o.updateWorldMatrix(true, false); return o.getWorldPosition(v3()).toArray(); }
for (const e of ENTRIES){
  const r = V.build(THREE, e, 0x3366cc);
  r.g.updateMatrixWorld(true);
  const b = new THREE.Box3().setFromObject(r.g), s = b.getSize(v3());
  // the tyres' outer extent across (a car's width without its mirrors)
  const tb = new THREE.Box3(); r.wheels.forEach(w => tb.expandByObject(w));
  const mats = {}; r.meshes.forEach(m => { mats[m.userData.mk] = (mats[m.userData.mk] || 0) + 1; });
  const paintMeshes = r.meshes.filter(m => m.userData.mk === "paint");
  const before = r.paint.color.getHex(); r.setPaint(0xff0000);
  const w0 = r.wheels[0].rotation.x; r.roll(1.0, 0.5);
  const st = r.brake && (r.brake(true), r.meshes.filter(m => m.userData.mk === "tail").map(m => m.material.color.getHex()));
  out.rows.push({id: e.id, kind: r.kind, tris: V.triangles(r), dc: V.drawCalls(r), size: s.toArray(), minY: b.min.y,
    tyreW: tb.max.x - tb.min.x, dims: V.dims(e), shown: V.shown(e), scale: r.scale, radii: r.radii, R: r.R,
    wheels: r.wheels.map(w => ({name: w.name, p: wpos(w)})),
    anchors: ["a-seat", "a-grip-l", "a-grip-r", "a-foot-l", "a-foot-r"].map(n => !!r.g.getObjectByName(n)),
    seat: r.seat ? wpos(r.seat) : null, grips: r.grips.map(g => g ? wpos(g) : null), feetPos: r.feet.map(f => f ? wpos(f) : null),
    steer: Array.isArray(r.steer) ? r.steer.map(h => h && h.name) : r.steer && r.steer.name, spin: !!r.spin,
    steerY: Array.isArray(r.steer) ? r.steer[0].rotation.y : r.steer.rotation.y, spinZ: r.spin ? r.spin.rotation.z : null,
    rolled: r.wheels[0].rotation.x - w0,
    mats, paintIsRig: paintMeshes.length > 0 && paintMeshes.every(m => m.material === r.paint), paint0: before, paint1: r.paint.color.getHex(),
    tailOn: st, riderK: r.riderK || null, hats: r.hats === false ? false : null, lean: r.lean});
}
// every catalogue vehicle as drawn: its box and its seat (the display scale, HQV.hqVehicleModels.SCALE)
const cat = JSON.parse(fs.readFileSync(root + "/games/vehicles/catalogue.json", "utf8"));
out.cat = cat.vehicles.filter(v => v.slot !== "starter").map(v => {
  const r = V.build(THREE, v, 0x3366cc); r.g.updateMatrixWorld(true);
  const s = new THREE.Box3().setFromObject(r.g).getSize(v3());
  return {id: v.id, kind: r.kind, size: s.toArray(), seatY: r.seat.getWorldPosition(v3()).y, tris: V.triangles(r), dc: V.drawCalls(r), shown: V.shown(v)};
});
out.SCALE = V.SCALE;
// shared geometry: two copies of one entry, different paints
const a = V.build(THREE, ENTRIES[0], 0x111111), b2 = V.build(THREE, ENTRIES[0], 0xeeeeee);
const ga = a.meshes.map(m => m.geometry.uuid).sort().join(), gb = b2.meshes.map(m => m.geometry.uuid).sort().join();
out.shared = {sameGeo: ga === gb, ownPaint: a.paint !== b2.paint, paints: [a.paint.color.getHex(), b2.paint.color.getHex()]};
// the catalogue's first paint when none is given
out.defPaint = V.build(THREE, Object.assign({}, ENTRIES[1], {paints: ["#ff6a00"]})).paint.color.getHexString();
// the starters: hq3d's own car and motorbike, untouched
const calls = [];
const ctx = {THREE, car: (p) => { calls.push(["car", p]); return {g: new THREE.Group(), starter: "car"}; },
             moto: (p) => { calls.push(["moto", p]); return {g: new THREE.Group(), starter: "moto"}; }};
out.starter = [V.build(ctx, {id: "starter-car", starter: true}, 0x123456).starter, V.build(ctx, {id: "starter-moto", kind: "bike", starter: true}, 0x654321).starter,
               V.build(ctx, ENTRIES[0], 0x1).starter || null, calls];
// a real model: a fake GLTFLoader hands back a scene; the stand-in gives way once it has loaded
const scene = new THREE.Group();
const body = new THREE.Mesh(new THREE.BoxGeometry(1.8, 1.2, 4.2), new THREE.MeshStandardMaterial({name: "Paint", color: 0x888888})); body.position.y = 0.9; scene.add(body);
const glass = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.4, 2), new THREE.MeshStandardMaterial({name: "Glass"})); glass.position.y = 1.6; scene.add(glass);
[[0.8, 1.4], [-0.8, 1.4], [0.8, -1.4], [-0.8, -1.4]].forEach((p, i) => { const w = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 0.25, 12), new THREE.MeshStandardMaterial()); w.name = "wheel-" + i; w.position.set(p[0], 0.35, p[1]); scene.add(w); });
let loads = 0;
const loader = {load(url, ok){ loads++; out.glbUrl = url; setTimeout(() => ok({scene}), 0); }};
const ge = Object.assign({}, ENTRIES[0], {model3d: {file: "vehicles/t.glb", paintMaterial: "Paint", lengthM: 4.79}});
const g1 = V.build(THREE, ge, 0x00ff00, {loader}), g2 = V.build(THREE, ge, 0x0000ff, {loader});
out.glbBefore = {standin: g1.standin.visible, ready: !!g1.ready};
await Promise.all([g1.ready, g2.ready]);
const gb3 = new THREE.Box3().setFromObject(g1.g.getObjectByName("glb"));
const pm = []; g1.g.getObjectByName("glb").traverse(o => { if(o.isMesh && o.material.name === "Paint") pm.push(o.material.color.getHex()); });
const pm2 = []; g2.g.getObjectByName("glb").traverse(o => { if(o.isMesh && o.material.name === "Paint") pm2.push(o.material.color.getHex()); });
g1.setPaint(0xabcdef);
const pm3 = []; g1.g.getObjectByName("glb").traverse(o => { if(o.isMesh && o.material.name === "Paint") pm3.push(o.material.color.getHex()); });
out.glb = {loads, model: g1.model, standin: g1.standin.visible, wheels: g1.wheels.map(w => w.name), len: gb3.max.z - gb3.min.z, minY: gb3.min.y,
           paint: pm, paint2: pm2, repaint: pm3, steer: g1.steer.map(w => w.name), sceneUntouched: body.material.color.getHex()};
console.log(JSON.stringify(out));
"""


@unittest.skipUnless(NODE, "node is not installed")
class VehicleModels(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        src = HARNESS % {"root": json.dumps(ROOT), "entries": json.dumps(ENTRIES)}
        r = subprocess.run([NODE, "--input-type=module", "-e", src], capture_output=True, text=True, timeout=120)
        if r.returncode != 0:
            raise AssertionError(r.stderr[-3000:])
        cls.o = json.loads(r.stdout.strip().splitlines()[-1])
        cls.rows = {x["id"]: x for x in cls.o["rows"]}

    def test_budgets(self):
        for r in self.o["rows"]:
            self.assertLess(r["tris"], 6000, r["id"])
            # the body: at most five materials; one mesh per wheel; a bike's steering; a car's steering wheel
            body = sum(1 for k in r["mats"] if k in ("paint", "trim", "glass", "light", "tail"))
            self.assertLessEqual(body, 5, (r["id"], r["mats"]))
            # a mesh per material per rigid piece; a car's calipers ride its four wheel holders
            self.assertLessEqual(r["dc"], 16 if r["kind"] == "car" else 12, (r["id"], r["mats"]))
        for r in self.o["cat"]:
            self.assertLess(r["tris"], 6000, r["id"])
            self.assertLessEqual(r["dc"], 16 if r["kind"] == "car" else 12, r["id"])

    def test_size_matches_dims(self):
        for r in self.o["rows"]:
            sx, sy, sz = r["size"]
            d = r["shown"]
            k = self.o["SCALE"][r["kind"]]
            self.assertEqual(r["scale"], k)
            for n in ("lengthM", "widthM", "heightM", "wheelbaseM"):
                self.assertAlmostEqual(d[n], r["dims"][n]*k, delta=0.002)
            self.assertAlmostEqual(sz/d["lengthM"], 1, delta=0.05, msg=(r["id"], "length", sz, d))
            self.assertAlmostEqual(sy/d["heightM"], 1, delta=0.05, msg=(r["id"], "height", sy, d))
            self.assertAlmostEqual(r["minY"], 0, delta=0.02, msg=r["id"])
            if r["kind"] == "car":
                self.assertAlmostEqual(r["tyreW"]/d["widthM"], 1, delta=0.05, msg=(r["id"], "track", r["tyreW"]))
                self.assertLess(sx, d["widthM"]*1.15, (r["id"], "mirrors", sx))
            else:
                self.assertAlmostEqual(sx/d["widthM"], 1, delta=0.08, msg=(r["id"], "bars", sx))
        # the catalogue's dims win over the type's
        self.assertEqual(self.rows["t-ev"]["dims"]["lengthM"], 5.39)
        self.assertAlmostEqual(self.rows["t-ev"]["size"][2], 5.39*self.o["SCALE"]["car"], delta=0.27)

    # the starters as hq3d draws them (games/hq3d.js carModel / motoModel, measured: length, height, width in m)
    STARTER = {"car": (3.97, 1.79, 2.08), "bike": (2.64, 1.59, 0.96)}

    def test_the_starters_scale_family(self):
        # by box size (the cube root of length × height × width): each kind's median within 15% of its starter,
        # a superbike at least the starter motorbike, every car at least the starter hatch; and real sizes kept
        size = lambda b: (b[0]*b[1]*b[2]) ** (1/3)
        by = {}
        for r in self.o["cat"]:
            sx, sy, sz = r["size"]
            by.setdefault(r["kind"], {})[r["id"]] = size((sz, sy, sx))
        for kind in ("car", "bike"):
            v = sorted(by[kind].values()); med = v[len(v)//2]
            self.assertAlmostEqual(med/size(self.STARTER[kind]), 1, delta=0.15, msg=(kind, med))
        self.assertGreaterEqual(by["bike"]["bmw-s-1000-rr"], size(self.STARTER["bike"]))
        for i, s in by["car"].items():
            # [3.9] the one exception: the 1974 Countach (4.14 x 1.89 x 1.07 m), drawn at its real size under the hatch
            self.assertGreaterEqual(s, size(self.STARTER["car"])*(0.92 if i == "lamborghini-countach-lp400" else 0.98), i)
        self.assertGreater(by["car"]["bmw-x5-40i"], by["car"]["bmw-m135-xdrive"]*1.1)      # an SUV still over a hatch
        self.assertGreater(by["bike"]["bmw-r-1300-gs"], by["bike"]["ktm-rc-390"]*1.1)
        # the rider's seat at the starters' height: a bike's about the starter motorbike's (1.06 m)
        for r in self.o["cat"]:
            if r["kind"] == "bike":
                # [3.9] a cruiser's seat is low by design (the Fat Boy's 675 mm): it may sit down to 0.8 m as drawn
                lo = 0.8 if r["id"] == "harley-davidson-fat-boy-114" else 0.9
                self.assertTrue(lo <= r["seatY"] <= 1.25, (r["id"], r["seatY"]))

    def test_bays_and_turntables_fit_the_largest(self):
        # the car park, the basement and the dealer's turntables hold the biggest vehicle as drawn
        def const(path, name):
            src = open(os.path.join(ROOT, path)).read()
            m = re.search(r"\b%s = ([0-9.]+)" % name, src)
            return float(m.group(1))
        cars = [r for r in self.o["cat"] if r["kind"] == "car"]
        bikes = [r for r in self.o["cat"] if r["kind"] == "bike"]
        wmax = max(r["size"][0] for r in cars)
        lmax = max(r["size"][2] for r in cars)
        self.assertLess(wmax, const("games/hqcarpark.js", "BAY_W") - 0.2)
        self.assertLess(lmax, const("games/hqcarpark.js", "BAY_D") + const("games/hqcarpark.js", "AISLE")/2 - 1.5,
                        "nose at the bay's back line, the tail leaves the aisle open")
        # B1's gallery (games/hqbasement.js): plinths one pitch apart, their radius capped at R_MAX; the longest car's
        # nose and tail stay on its plinth (its mirrors' corners may reach just past the rim)
        bsrc = open(os.path.join(ROOT, "games/hqbasement.js")).read()
        gal = dict((k, float(v)) for k, v in re.findall(r"\b(x0|x1|nBack): (-?[0-9.]+)", bsrc.split("var GAL = ", 1)[1].split("};", 1)[0]))
        r_max = ((gal["x1"] - gal["x0"])/(gal["nBack"] - 1) - 0.35)/2
        self.assertLess(lmax/2, r_max)
        self.assertLess(wmax, 2*r_max - 2.5)
        sweep = lambda rs: max((r["size"][0]**2 + r["size"][2]**2) ** 0.5 for r in rs)   # turning on a turntable
        self.assertLessEqual(sweep(cars), const("games/hqdealer.js", "CAR_CELL"))
        self.assertLessEqual(sweep(bikes), const("games/hqdealer.js", "BIKE_CELL"))

    def test_wheels_on_the_wheelbase_and_the_ground(self):
        for r in self.o["rows"]:
            W = r["wheels"]
            zs = sorted({round(w["p"][2], 3) for w in W})
            self.assertEqual(len(zs), 2, r["id"])
            self.assertAlmostEqual(zs[1] - zs[0], r["shown"]["wheelbaseM"], delta=0.01, msg=r["id"])
            for w, rad in zip(W, r["radii"]):
                self.assertAlmostEqual(w["p"][1], rad, delta=0.01, msg=(r["id"], w["name"]))   # touching the ground
            self.assertEqual([w["name"] for w in W], ["wheel-%d" % i for i in range(len(W))])
            self.assertEqual(len(W), 4 if r["kind"] == "car" else 2)

    def test_the_rig_hq3d_rides(self):
        for r in self.o["rows"]:
            self.assertEqual(r["anchors"], [True]*5, r["id"])
            self.assertGreater(r["rolled"], 0.5/max(r["radii"]), r["id"])
            if r["kind"] == "car":
                self.assertEqual(r["steer"], ["steer-l", "steer-r"])
                self.assertTrue(r["spin"])
                self.assertAlmostEqual(r["steerY"], 0.25, places=5)
                self.assertAlmostEqual(r["spinZ"], -0.8, places=5)
                self.assertEqual(r["hats"], False)
                self.assertTrue(0.4 <= r["riderK"] <= 0.85, r)
                # right-hand drive: the driver on -x, hands ahead of the hips
                self.assertLess(r["seat"][0], 0)
                self.assertGreater(r["grips"][0][2], r["seat"][2])
            else:
                self.assertEqual(r["steer"], "steer")
                self.assertAlmostEqual(r["steerY"], 0.2, places=5)
                self.assertAlmostEqual(r["seat"][0], 0, places=5)
                self.assertGreater(r["grips"][0][0], 0)                    # left grip on +x (model-local +x is left)
                self.assertGreater(r["grips"][0][2], r["seat"][2])
        # a lower car seats a smaller driver (the Mini characters' heads stay under the roof)
        self.assertLess(self.rows["t-hyper"]["riderK"], self.rows["t-suv"]["riderK"])
        self.assertGreater(self.rows["t-sport"]["lean"], self.rows["t-adv"]["lean"])
        # [3.9] the new poses: a classic sits upright, a cruiser leans back a touch with its feet forward of the hips,
        # low, its hands out wide; a classic's feet sit under its hips
        R = self.rows
        self.assertLess(R["t-classic"]["lean"], R["t-adv"]["lean"])
        self.assertLess(R["t-cruiser"]["lean"], 0)
        for k in ("t-cruiser",):
            feet = [a for a in R[k]["feetPos"]]
            self.assertGreater(min(f[2] for f in feet), R[k]["seat"][2] + 0.6, k)          # forward controls
            self.assertLess(R[k]["seat"][1], R["t-classic"]["seat"][1] - 0.1, k)           # a low seat
            span = lambda r: sum((a - b)**2 for a, b in zip(r["grips"][0], r["grips"][1])) ** 0.5
            self.assertGreater(span(R[k]), span(R["t-classic"]) + 0.1, k)                     # wide bars
        for k in ("t-classic", "t-classic-twin"):
            self.assertLess(abs(R[k]["feetPos"][0][2] - R[k]["seat"][2]), 0.25, k)       # hips over the pegs
            self.assertGreater(R[k]["grips"][0][1], R["t-v4"]["grips"][0][1], k)           # hands up, not tucked

    def test_paint_and_brakes(self):
        for r in self.o["rows"]:
            self.assertTrue(r["paintIsRig"], r["id"])
            self.assertEqual(r["paint0"], 0x3366cc)
            self.assertEqual(r["paint1"], 0xff0000)
            self.assertTrue(r["tailOn"] and all(c == 0xffffff for c in r["tailOn"]), r["id"])
        self.assertTrue(self.o["shared"]["sameGeo"])
        self.assertTrue(self.o["shared"]["ownPaint"])
        self.assertEqual(self.o["shared"]["paints"], [0x111111, 0xeeeeee])
        self.assertEqual(self.o["defPaint"], "ff6a00")

    def test_starters_stay_hq3ds(self):
        car, moto, entry, calls = self.o["starter"]
        self.assertEqual(car, "car")
        self.assertEqual(moto, "moto")
        self.assertIsNone(entry)                                # a catalogue vehicle is never the starter
        self.assertEqual(calls, [["car", 0x123456], ["moto", 0x654321]])

    def test_a_real_model_swaps_in(self):
        self.assertEqual(self.o["glbBefore"], {"standin": True, "ready": True})
        g = self.o["glb"]
        self.assertEqual(g["loads"], 1, "one fetch per file, shared")
        self.assertEqual(self.o["glbUrl"], "/games/vehicles/t.glb")
        self.assertEqual(g["model"], "glb")
        self.assertFalse(g["standin"])
        self.assertEqual(g["wheels"], ["wheel-0", "wheel-1", "wheel-2", "wheel-3"])
        self.assertEqual(g["steer"], ["wheel-0", "wheel-1"])
        self.assertAlmostEqual(g["len"], 4.79*self.o["SCALE"]["car"], delta=0.01)
        self.assertAlmostEqual(g["minY"], 0, delta=0.01)
        self.assertEqual(g["paint"], [0x00ff00])
        self.assertEqual(g["paint2"], [0x0000ff], "each vehicle its own paint")
        self.assertEqual(g["repaint"], [0xabcdef])
        self.assertEqual(g["sceneUntouched"], 0x888888, "the loaded scene's material is copied, not changed")


if __name__ == "__main__":
    unittest.main()
