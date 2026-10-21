"""The (temporary) Showroom and the catalogue in the 3D City (games/hqshowroom.js, games/hq3d.js).

node: every catalogue vehicle derives its handling (hqVehiclePhys.derive, as hq3d registers it) and builds a body
(hqVehicleModels.build with the vendored three.js); the Showroom groups the classes Bikes / Cars, by type and cc
band, and writes a spec line. The Python side checks hq3d's wiring: the base kinds (a catalogue car drives as the
car, a bike as the motorbike), presence (others see 5 / 6), the G key and the panel keeping its keys.
Skipped when node is not installed. Stdlib only."""
import json
import os
import re
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
const THREE = await import(root + "/games/vendor/three-module.js");
globalThis.window = {HQV: {}};
for (const f of ["hqvehicles", "hqvehiclephys", "hqvehiclemodels", "hqshowroom"])
  new Function(fs.readFileSync(root + "/games/" + f + ".js", "utf8"))();
const H = window.HQV, cat = JSON.parse(fs.readFileSync(root + "/games/vehicles/catalogue.json", "utf8"));
// hq3d.js catEntry: the class's kind, the body (else the class's type), the spec, the dims, the voice
function catEntry(v){ const cls = String(v["class"] || "").split("."); return {kind: cls[0] === "bike" ? "bike" : "car", type: v.body || cls[1], spec: v.spec, dims: v.dims, sound: v.sound}; }
const out = {rows: [], groups: null, lines: {}};
for (const v of cat.vehicles){
  if (v.slot === "starter") continue;
  const V = H.hqVehiclePhys.derive(catEntry(v));
  const r = H.hqVehicleModels.build(THREE, v, 0x3366cc);
  const t = H.hqVehiclePhys.t0100(V.top, V.acc, V.floor);
  out.rows.push({id: v.id, kind: V.kind, top: V.top, acc: V.acc, t0100: t, eng: V.eng, gears: V.gears.length, box: V.box,
                 rigKind: r.kind, wheels: r.wheels.length, roll: typeof r.roll, seat: !!r.seat, tris: H.hqVehicleModels.triangles(r)});
}
out.groups = H.hqShowroom.groups(cat).map(k => ({kind: k.kind, label: k.label,
  types: k.types.map(t => ({type: t.type, label: t.label, classes: t.classes.map(c => ({id: c.id, n: c.vehicles.length}))}))}));
for (const id of ["bmw-m3-competition", "bmw-i7-m70", "ktm-390-duke"]) out.lines[id] = H.hqShowroom.specLine(H.hqVehicles.get(cat, id));
console.log(JSON.stringify(out));
"""


@unittest.skipUnless(NODE, "node not installed")
class ShowroomNode(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        r = subprocess.run([NODE, "--input-type=module", "-e", HARNESS % {"root": json.dumps(ROOT)}],
                           capture_output=True, text=True, timeout=180)
        if r.returncode:
            raise AssertionError(r.stderr[-3000:])
        cls.o = json.loads(r.stdout.strip().splitlines()[-1])
        cls.cat = json.loads(read("games", "vehicles", "catalogue.json"))

    def test_every_catalogue_vehicle_derives_and_builds(self):
        ids = {v["id"] for v in self.cat["vehicles"] if v.get("slot") != "starter"}
        rows = {r["id"]: r for r in self.o["rows"]}
        self.assertEqual(set(rows), ids)
        for r in rows.values():
            self.assertGreater(r["top"], 10, r["id"])
            self.assertGreater(r["acc"], 1, r["id"])
            self.assertLess(r["t0100"], 20, r["id"])
            self.assertEqual(r["rigKind"], r["kind"], r["id"])
            self.assertEqual(r["wheels"], 4 if r["kind"] == "car" else 2, r["id"])
            self.assertEqual(r["roll"], "function", r["id"] + ": hq3d rolls a catalogue rig's own wheels")
            self.assertTrue(r["seat"], r["id"])
            self.assertLess(r["tris"], 6000, r["id"])

    def test_a_chiron_outruns_a_390_duke_off_the_line(self):
        rows = {r["id"]: r for r in self.o["rows"]}
        self.assertLess(rows["bugatti-chiron-super-sport"]["t0100"], rows["ktm-390-duke"]["t0100"])
        self.assertEqual(rows["bmw-i7-m70"]["eng"], "electric")
        self.assertEqual(rows["bmw-i7-m70"]["gears"], 1)

    def test_groups_bikes_then_cars_by_type_and_band(self):
        G = self.o["groups"]
        self.assertEqual([k["kind"] for k in G], ["bike", "car"])
        self.assertEqual([k["label"] for k in G], ["Bikes", "Cars"])
        naked = [t for t in G[0]["types"] if t["type"] == "naked"][0]
        self.assertEqual([c["id"] for c in naked["classes"]], ["bike.naked.400", "bike.naked.950", "bike.naked.over950"])
        every = {c["id"] for k in G for t in k["types"] for c in t["classes"]}
        self.assertNotIn("starter", every)
        self.assertTrue(all(c["n"] >= 1 for k in G for t in k["types"] for c in t["classes"]))

    def test_spec_lines(self):
        L = self.o["lines"]
        self.assertIn("2993 cc", L["bmw-m3-competition"])
        self.assertIn("RWD", L["bmw-m3-competition"])
        self.assertTrue(L["bmw-i7-m70"].startswith("electric"))
        self.assertIn("399 cc", L["ktm-390-duke"])
        self.assertNotIn("RWD", L["ktm-390-duke"], "a bike's drive is not listed")


class ShowroomWiring(unittest.TestCase):
    src = read("games", "hq3d.js")
    panel = read("games", "hqshowroom.js")

    def test_catalogue_vehicles_drive_on_the_car_and_moto_paths(self):
        self.assertIn('function baseKind(k){ var V = VEHICLES[k]; return V && V.cat ? (V.kind === "bike" ? "moto" : "car") : k; }', self.src)
        self.assertIn("HQV.hqVehicleModels.build(ctx, Vc, b.color)", self.src)
        self.assertIn("if(ride.B.roll) ride.B.roll(d, ride.steer);", self.src)

    def test_others_see_the_starter_car_or_motorbike(self):
        self.assertIn("RIDE_A[ride.base || ride.kind] || 3", self.src)
        self.assertIn("var RIDE_A = {bike: 3, skate: 4, car: 5, moto: 6};", self.src)

    def test_g_opens_it_and_the_open_panel_keeps_the_keys(self):
        self.assertRegex(self.src, r'e\.code === "KeyG" && e\.type === "keydown"[^\n]*\n[^\n]*showroomOn\(\)\)\{ e\.preventDefault\(\); e\.stopPropagation\(\); showroomToggle\(\)')
        self.assertIn("if(HQV.hqShowroom.owns(e)) return;", self.src)
        self.assertIn("e.preventDefault(); e.stopPropagation();", self.src)
        self.assertIn("if(e.stopPropagation) e.stopPropagation();", self.panel)

    def test_text_only(self):
        self.assertNotIn("innerHTML", self.panel)
        self.assertIn("TEMPORARY", self.panel)


if __name__ == "__main__":
    unittest.main()
