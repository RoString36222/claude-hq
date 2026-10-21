"""games/vehicles/catalogue.json (the vehicle catalogue) and games/hqvehicles.js (its loader's helpers).

The rules in docs/plans/dealership-spec.md: classes by kind, type and cc band; at most two slot vehicles
per class (slots 1 and 2); stable ids; specs, dimensions and paints in sane ranges."""
import json
import os
import re
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CAT = os.path.join(ROOT, "games", "vehicles", "catalogue.json")
NODE = shutil.which("node")

ID_RE = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")
HEX_RE = re.compile(r"^#[0-9a-f]{6}$")
BIKE_TYPES = {"naked", "sport", "adventure", "cruiser", "scooter", "dirt"}
CAR_TYPES = {"hatch", "sedan", "coupe", "suv", "pickup", "hyper"}
BIKE_BANDS = {"400", "950", "over950"}
CAR_BANDS = {"2000", "3000", "5000", "over5000", "ev"}
LAYOUTS = {"single", "parallel-twin", "v-twin", "boxer-twin", "inline-3", "inline-4", "inline-6", "v8", "w16", "v16", "electric"}
ASPIRATION = {"na", "turbo", "twin-turbo", "quad-turbo", "electric"}
SOUNDS = {"single", "twin", "vtwin", "boxer", "four", "six", "v8", "w16", "v16", "electric", "turbo4", "turbo6", "v8tt"}
DRIVES = {"rwd", "fwd", "awd"}
# coins per class tier (the spec's Economy) for when prices are set; tier 0 is the free starters.
# FREE FOR ALL FOR NOW: every price is 0 (allowed in any tier) and every class's minLevel is 0.
PRICE = {0: (0, 0), 1: (800, 1500), 2: (2500, 5000), 3: (8000, 15000), 4: (25000, 40000), 5: (100000, 500000)}


def band_of(kind, cc, electric):
    """The spec's bands, written out again independently of games/hqvehicles.js."""
    if electric:
        return "ev"
    if kind == "bike":
        return "400" if cc <= 400 else "950" if cc <= 950 else "over950"
    return "2000" if cc <= 2000 else "3000" if cc <= 3000 else "5000" if cc <= 5000 else "over5000"


class Catalogue(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with open(CAT, encoding="utf-8") as f:
            cls.cat = json.load(f)
        cls.classes = {c["id"]: c for c in cls.cat["classes"]}
        cls.vehicles = cls.cat["vehicles"]

    def test_classes(self):
        self.assertEqual(len(self.classes), len(self.cat["classes"]), "class ids are unique")
        for cid, c in self.classes.items():
            if cid == "starter":
                self.assertEqual(c["tier"], 0)
                self.assertEqual(c["minLevel"], 0)
                continue
            kind, typ, band = cid.split(".")
            self.assertEqual((c["kind"], c["type"], c["band"]), (kind, typ, band), cid)
            self.assertIn(typ, BIKE_TYPES if kind == "bike" else CAR_TYPES, cid)
            self.assertIn(band, BIKE_BANDS if kind == "bike" else CAR_BANDS, cid)
            self.assertIn(c["tier"], (1, 2, 3, 4, 5), cid)
            # the player level a class needs (configurable here; the Arena enforces it).
            # 0 = no gate (every class for now).
            self.assertIsInstance(c["minLevel"], int, cid)
            self.assertTrue(0 <= c["minLevel"] <= 100, cid)
            self.assertTrue(c["label"].strip(), cid)
            if typ == "hyper":
                self.assertIn(band, ("over5000", "ev"), "a hypercar is over 5000 cc or electric")
                self.assertEqual(c["tier"], 5)
            if band != "ev":
                self.assertIn("cc" if band != "starter" else "", c["label"], "labels say the band in cc")

    def test_ids_are_unique_and_stable_in_form(self):
        ids = [v["id"] for v in self.vehicles]
        self.assertEqual(len(ids), len(set(ids)))
        for i in ids:
            self.assertRegex(i, ID_RE)
            self.assertLessEqual(len(i), 48)

    def test_every_vehicle_is_in_a_class_that_fits_it(self):
        for v in self.vehicles:
            c = self.classes.get(v["class"])
            self.assertIsNotNone(c, v["id"])
            if v["class"] == "starter":
                self.assertEqual(v["slot"], "starter", v["id"])
                self.assertEqual(v["price"], 0, v["id"])
                continue
            s = v["spec"]
            self.assertEqual(band_of(c["kind"], s["cc"], s["electric"]), c["band"],
                             f"{v['id']}: {s['cc']} cc (electric {s['electric']}) is not band {c['band']}")
            self.assertEqual(v["body"], c["type"], f"{v['id']}: the stand-in body is the class type")

    def test_at_most_two_slots_per_class(self):
        by = {}
        for v in self.vehicles:
            self.assertIn(v["slot"], (1, 2, "reserve", "starter"), v["id"])
            if v["slot"] in (1, 2):
                by.setdefault(v["class"], []).append(v["slot"])
        for cid, slots in by.items():
            self.assertLessEqual(len(slots), 2, cid)
            self.assertEqual(len(slots), len(set(slots)), f"{cid}: a slot taken twice")
            self.assertIn(1, slots, f"{cid}: slot 2 filled before slot 1")

    def test_specs_are_sane(self):
        for v in self.vehicles:
            s, bike = v["spec"], v["class"].startswith("bike.") or v["body"] in BIKE_TYPES
            with self.subTest(v=v["id"]):
                self.assertIn(s["layout"], LAYOUTS)
                self.assertIn(s["aspiration"], ASPIRATION)
                self.assertIn(s["drive"], DRIVES)
                self.assertIsInstance(s["hybrid"], bool)
                self.assertIn(v["sound"], SOUNDS)
                if s["electric"]:
                    self.assertEqual((s["cc"], s["cyl"], s["layout"], s["aspiration"], v["sound"]),
                                     (0, 0, "electric", "electric", "electric"))
                    self.assertEqual(s["gears"], 1)
                else:
                    self.assertTrue(50 <= s["cc"] <= 9000)
                    self.assertTrue(1 <= s["cyl"] <= 16)
                    self.assertTrue(4 <= s["gears"] <= 10)
                if bike:
                    self.assertEqual(s["drive"], "rwd")
                    self.assertTrue(5 <= s["powerKw"] <= 200 and 90 <= s["massKg"] <= 350, s)
                    self.assertTrue(60 <= s["topKmh"] <= 330)
                else:
                    self.assertTrue(30 <= s["powerKw"] <= 1500 and 700 <= s["massKg"] <= 3500, s)
                    self.assertTrue(60 <= s["topKmh"] <= 460)
                if s["torqueNm"] is not None:
                    self.assertTrue(10 <= s["torqueNm"] <= 2000)
                if s["zeroTo100s"] is not None:
                    self.assertTrue(1.5 <= s["zeroTo100s"] <= 20)
                self.assertTrue(1950 <= v["year"] <= 2030)

    def test_dimensions_are_sane(self):
        for v in self.vehicles:
            d, bike = v["dims"], v["body"] in BIKE_TYPES
            with self.subTest(v=v["id"]):
                ln, wd, ht = ((1.6, 2.6), (0.6, 1.2), (0.9, 1.6)) if bike else ((3.0, 6.0), (1.4, 2.2), (1.0, 2.1))
                self.assertTrue(ln[0] <= d["lengthM"] <= ln[1], d)
                self.assertTrue(wd[0] <= d["widthM"] <= wd[1], d)
                self.assertTrue(ht[0] <= d["heightM"] <= ht[1], d)
                self.assertTrue(0.55 * d["lengthM"] <= d["wheelbaseM"] < d["lengthM"], d)

    def test_paints_and_prices(self):
        for v in self.vehicles:
            with self.subTest(v=v["id"]):
                self.assertTrue(4 <= len(v["paints"]) <= 6, v["paints"])
                names = [p["name"] for p in v["paints"]]
                self.assertEqual(len(names), len(set(names)))
                for p in v["paints"]:
                    self.assertRegex(p["hex"], HEX_RE)
                    self.assertTrue(p["name"].strip())
                lo, hi = PRICE[self.classes[v["class"]]["tier"]]
                self.assertIsInstance(v["price"], int)
                self.assertTrue(v["price"] == 0 or lo <= v["price"] <= hi, f"{v['price']} not 0 or in tier band {lo}-{hi}")

    def test_model3d_when_present_is_credited(self):
        for v in self.vehicles:
            m = v["model3d"]
            if m is None:
                continue
            with self.subTest(v=v["id"]):
                self.assertRegex(m["file"], r"^vehicles/[a-z][a-z0-9-]{0,40}\.glb$")
                for k in ("licence", "author", "source"):
                    self.assertTrue(str(m.get(k, "")).strip(), k)
                self.assertTrue(m["source"].startswith("https://"))

    def test_brand_and_model_are_text(self):
        for v in self.vehicles:
            for k in ("brand", "model"):
                self.assertTrue(isinstance(v[k], str) and v[k].strip() and len(v[k]) <= 48, (v["id"], k))
            self.assertIsInstance(v["pickedBy"], list)

    def test_the_starters_are_todays_car_and_motorbike(self):
        ids = {v["id"]: v for v in self.vehicles}
        car, moto = ids["starter-car"], ids["starter-moto"]
        # hq3d.js VEHICLES: car top 22 m/s, moto 24 m/s, both 5 gears
        self.assertAlmostEqual(car["spec"]["topKmh"] / 3.6, 22, delta=0.5)
        self.assertAlmostEqual(moto["spec"]["topKmh"] / 3.6, 24, delta=0.5)
        self.assertEqual((car["spec"]["gears"], moto["spec"]["gears"]), (5, 5))


SCRIPT = r"""
const fs = require('fs'), path = require('path'), R0 = process.argv[1];
global.window = {HQV: {}};
let fetched = 0;
global.fetch = u => { fetched++; return Promise.resolve({ok: true, json: () => Promise.resolve(JSON.parse(fs.readFileSync(path.join(R0, u.replace(/^\//, '')), 'utf8')))}); };
eval(fs.readFileSync(path.join(R0, 'games/hqvehicles.js'), 'utf8'));
const V = window.HQV.hqVehicles;
(async () => {
  const cat = await V.load(), again = await V.load();
  const cls = V.classes(cat).map(c => c.id), sale = V.onSale(cat).map(c => c.id);
  console.log(JSON.stringify({
    same: cat === again, fetched, url: V.URL,
    bands: [V.bandOf('bike', 399), V.bandOf('bike', 400), V.bandOf('bike', 401), V.bandOf('bike', 950), V.bandOf('bike', 951),
            V.bandOf('car', 1998), V.bandOf('car', 2000), V.bandOf('car', 2993), V.bandOf('car', 4395), V.bandOf('car', 7993),
            V.bandOf('car', 0, true), V.bandOf('bike', 0, true)],
    cls, sale,
    hyper: V.byClass(cat, 'car.hyper.over5000').map(v => [v.id, v.slot]),
    get: V.get(cat, 'ktm-390-duke') && V.get(cat, 'ktm-390-duke').model, none: V.get(cat, 'nope'),
    empty: [V.classes(null).length, V.byClass(null, 'x').length, V.onSale({}).length]
  }));
})();
"""


@unittest.skipUnless(NODE, "node not installed")
class Loader(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        r = subprocess.run([NODE, "-e", SCRIPT, ROOT], capture_output=True, text=True, timeout=60)
        if r.returncode:
            raise AssertionError(r.stderr)
        cls.o = json.loads(r.stdout)

    def test_loads_once(self):
        self.assertTrue(self.o["same"])
        self.assertEqual(self.o["fetched"], 1)
        self.assertEqual(self.o["url"], "/games/vehicles/catalogue.json")

    def test_bands(self):
        self.assertEqual(self.o["bands"], ["400", "400", "950", "950", "over950",
                                           "2000", "2000", "3000", "5000", "over5000", "ev", "ev"])

    def test_classes_are_ordered_and_skip_the_starters(self):
        cls = self.o["cls"]
        self.assertNotIn("starter", cls)
        kinds = [c.split(".")[0] for c in cls]
        self.assertEqual(kinds, sorted(kinds), "bikes before cars")
        naked = [c for c in cls if c.startswith("bike.naked.")]
        self.assertEqual(naked, ["bike.naked.400", "bike.naked.950", "bike.naked.over950"])

    def test_on_sale_is_the_full_classes(self):
        with open(CAT, encoding="utf-8") as f:
            cat = json.load(f)
        full = sorted(c["id"] for c in cat["classes"] if c["id"] != "starter"
                      and len([v for v in cat["vehicles"] if v["class"] == c["id"] and v["slot"] in (1, 2)]) == 2)
        self.assertEqual(sorted(self.o["sale"]), full)
        self.assertGreaterEqual(len(full), 10)

    def test_by_class_puts_reserves_last(self):
        self.assertEqual(self.o["hyper"], [["bugatti-chiron-super-sport", 1], ["bugatti-tourbillon", 2],
                                           ["bugatti-veyron", "reserve"]])

    def test_get_and_empty(self):
        self.assertEqual(self.o["get"], "390 Duke")
        self.assertIsNone(self.o["none"])
        self.assertEqual(self.o["empty"], [0, 0, 0])


if __name__ == "__main__":
    unittest.main()
