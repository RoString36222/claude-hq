"""HQ 3.13: the Tuning shop (games/hqtuning.js) and the Pet shop (games/hqpets.js) together in the City.

Both claim a building lot in games/hqcity3d.js's setup(), after the dealership and the casino. This runs the same
claiming order on the Commons fixture (claude-hq@2) at tier 1 and tier 5, and checks the four lots are distinct, the
Pet shop keeps its lot when the Tuning shop appears (tier 2), and a second pass claims nothing new. Then it reads
hqcity3d.js for the order. Skipped when node is not installed. Stdlib only."""
import json
import os
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")

HARNESS = r"""
var fs = require("fs"), zlib = require("zlib"), root = process.argv[1], store = {};
function El(){ this.children = []; this.style = {}; this.ls = {}; this.classList = {add(){}, remove(){}, contains(){ return false; }, toggle(){}}; }
globalThis.document = {createElement: function(){ return new El(); }, documentElement: new El()};
globalThis.window = {HQV: {}, document: globalThis.document, localStorage: {getItem: function(k){ return store[k] || null; }, setItem: function(k, v){ store[k] = String(v); }}};
["world", "hqmerge", "hqvehicles", "hqvehiclemodels", "hqnav", "hqdealer", "hqcasino", "hqgarage", "hqtuning", "hqpets"].forEach(function(f){
  new Function(fs.readFileSync(root + "/games/" + f + ".js", "utf8"))();
});
var H = window.HQV, gz = function(p){ return JSON.parse(zlib.gunzipSync(fs.readFileSync(p)).toString("utf8")); }, raw = gz(root + "/tests/fixtures/claude-hq@2.json.gz");
function claim(tier){
  var W = H.world.pack(JSON.parse(JSON.stringify(raw))); W.id = "claude-hq@2";
  // games/hqcity3d.js setup(): dealership, casino, Pet shop, Tuning shop
  var run = function(){ return {dealer: H.hqDealer.place(W, tier), casino: H.hqCasino.place(W, tier), petshop: H.hqPets.place(W), tuning: H.hqTuning.place(W, tier)}; };
  var a = run(), b = run(), lots = {}, same = {};
  Object.keys(a).forEach(function(k){ lots[k] = a[k] ? a[k].lot : null; same[k] = a[k] === b[k]; });
  return {lots: lots, same: same, sites: W.sites.filter(function(s){ return s.claimed; }).length};
}
console.log(JSON.stringify({t1: claim(1), t5: claim(5)}));
"""


@unittest.skipUnless(NODE, "node not installed")
class ShopsClaimDifferentLots(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        r = subprocess.run([NODE, "-e", HARNESS, ROOT], capture_output=True, text=True, timeout=120)
        if r.returncode:
            raise AssertionError(r.stderr[-2000:])
        cls.out = json.loads(r.stdout.strip().splitlines()[-1])

    def test_four_distinct_lots_at_tier_5(self):
        lots = self.out["t5"]["lots"]
        for k in ("dealer", "casino", "petshop", "tuning"):
            self.assertIsNotNone(lots[k], k)
        self.assertEqual(len(set(lots.values())), 4, lots)

    def test_claims_are_idempotent(self):
        for t in ("t1", "t5"):
            self.assertTrue(all(self.out[t]["same"].values()), self.out[t]["same"])

    def test_pet_shop_keeps_its_lot_when_the_tuning_shop_arrives(self):
        self.assertIsNone(self.out["t1"]["lots"]["tuning"], "no Tuning shop before tier 2")
        self.assertIsNotNone(self.out["t1"]["lots"]["petshop"])
        self.assertEqual(self.out["t1"]["lots"]["petshop"], self.out["t5"]["lots"]["petshop"])

    def test_hqcity3d_claims_in_that_order(self):
        with open(os.path.join(ROOT, "games", "hqcity3d.js"), encoding="utf-8") as f:
            city = f.read()
        idx = [city.index(s) for s in ("dealerSite = HQV.hqDealer.place(W, tier)", "casinoSite = HQV.hqCasino.place(W, tier)",
                                       "petSite = HQV.hqPets.place(W)", "tuningSite = HQV.hqTuning.place(W, tier)",
                                       "indexBuildings();\n    wb = HQV.worldbuild.create(")]
        self.assertEqual(idx, sorted(idx))


if __name__ == "__main__":
    unittest.main()
