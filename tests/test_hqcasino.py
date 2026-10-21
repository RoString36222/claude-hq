"""The Casino (games/hqcasino.js, games/hqcasinoui.js; the Arena's half is backend/src/casino.rs and its tests).

node: where it stands (place() turns one of the world's big building lots into the "casino:0" site, the same lot on
every client, from tier 3, and the world cache never keeps it), that Go to lists it, every game has a spot on the
floor, and the house's opinions (roast/cheer) pick by what happened. Source: no Math.random, textContent only, the
panel's posts carry a game, a bet and a pick and nothing else, Calm cuts the animations short.
"""
import json
import os
import re
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")
FIX = os.path.join(ROOT, "tests", "fixtures")

SCRIPT = r"""
const fs = require("fs"), zlib = require("zlib"), root = process.argv[1];
globalThis.window = {HQV: {}};
for (const f of ["world", "hqnav", "hqdealer", "hqcasinoui", "hqcasino"]) new Function(fs.readFileSync(root + "/games/" + f + ".js", "utf8"))();
const H = window.HQV, WD = H.world, K = H.hqCasino, U = H.hqCasinoUi;
const gz = p => JSON.parse(zlib.gunzipSync(fs.readFileSync(p)).toString("utf8"));
const out = {};
function placed(file, id, tier){
  const W = WD.pack(gz(file)); W.id = id;
  H.hqDealer.place(W, tier);
  const s = K.place(W, tier);
  if(!s) return null;
  const lot = W.lots.filter(l => l.id === s.lot)[0], F = H.hqDealer.frame(s);
  const again = K.place(W, tier), cc = WD.cacheCopy(W);
  return {site: {id: s.id, kind: s.kind, name: s.name}, lotKind: lot.kind, w: F.w, d: F.d, same: again === s,
          notDealer: W.sites.filter(x => x.kind === "dealer").every(d => d.lot !== s.lot),
          places: H.hqnav.places(W, tier, {x: 0, z: 0}).filter(p => p.kind === "casino").map(p => p.label),
          cached: cc.sites.some(x => x.kind === "casino") || cc.lots.some(l => l.kind === "casino"),
          again2: (() => { const W2 = WD.pack(gz(file)); W2.id = id; H.hqDealer.place(W2, tier); return K.place(W2, tier).lot; })()};
}
out.commons = placed(root + "/tests/fixtures/claude-hq@2.json.gz", "claude-hq@2", 5);
out.low = placed(root + "/tests/fixtures/claude-hq@2.json.gz", "claude-hq@2", 2);
out.spots = K.SPOTS.map(s => s.game).filter(Boolean);
out.games = Object.keys(U.GAMES);
const r = (o, k) => U.roast(o, k).text;
out.roasts = {
  near: r({game: "slots", bet: 5, result: {reels: ["seven", "seven", "bell"]}}, 0),
  zero: r({game: "roulette", bet: 5, result: {pocket: 0, pick: "red"}}, 0),
  bust: r({game: "blackjack", bet: 5, result: {outcome: "bust", hand: {ptotal: 23, dtotal: 17}}}, 0),
  pad: r({game: "rocket", bet: 5, result: {crash: 100, target: 200}}, 0),
  duel: r({game: "duel", bet: 5, vs: "Bea", result: {you: "rock", them: "paper"}}, 0),
  streak: r({game: "coin", bet: 5, streak: 9, result: {side: "tails"}}, 0)
};
out.capital = [...Array(40).keys()].every(k => /^[A-Z0-9]/.test(U.roast({game: "duel", bet: 5, vs: "bea", result: {you: "rock", them: "paper"}}, k).text));
out.arts = [...new Set([...Array(12).keys()].map(k => U.roast({game: "dice", bet: 5, result: {dice: [2, 3]}}, k).art))].length;
out.cheer = [U.cheer({bet: 10, payout: 10}, 0).art, U.cheer({bet: 10, payout: 20}, 0).art, U.cheer({bet: 10, payout: 5000}, 0).art];
console.log(JSON.stringify(out));
"""


def read(*p):
    with open(os.path.join(ROOT, *p), encoding="utf-8") as f:
        return f.read()


@unittest.skipUnless(NODE, "node is not installed")
class CasinoTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        r = subprocess.run([NODE, "-e", SCRIPT, ROOT], capture_output=True, text=True, timeout=120)
        if r.returncode:
            raise AssertionError(r.stderr)
        cls.o = json.loads(r.stdout.strip().splitlines()[-1])

    def test_the_commons_has_a_casino_on_a_big_lot_the_same_everywhere(self):
        c = self.o["commons"]
        self.assertEqual(c["site"], {"id": "casino:0", "kind": "casino", "name": "The Lucky Byte"})
        self.assertEqual(c["lotKind"], "casino")
        self.assertGreaterEqual(min(c["w"], c["d"]), 22)
        self.assertTrue(c["same"])
        self.assertTrue(c["notDealer"])
        self.assertEqual(c["places"], ["The Lucky Byte"])
        self.assertFalse(c["cached"])

    def test_no_casino_below_tier_3(self):
        self.assertIsNone(self.o["low"])

    def test_every_game_has_a_place_on_the_floor(self):
        # the slot machines' spots are made with the banks (SLOT_BANKS) when the floor is built
        games = set(self.o["games"]) - {"cage"}
        self.assertEqual(games, (set(self.o["spots"]) | {"slots"}) - {"cage"})
        self.assertIn("cage", self.o["spots"])
        self.assertIn("duel", self.o["spots"])

    def test_the_house_roasts_what_actually_happened(self):
        r = self.o["roasts"]
        self.assertIn("seven", r["near"])
        self.assertIn("Zero", r["zero"])
        self.assertIn("23", r["bust"])
        self.assertTrue("launch pad" in r["pad"] or "1.00x" in r["pad"], r["pad"])
        self.assertIn("Bea", r["duel"])
        self.assertIn("9", r["streak"])
        self.assertTrue(self.o["capital"])
        self.assertGreaterEqual(self.o["arts"], 5)
        self.assertEqual(self.o["cheer"], ["none", "coins", "jackpot"])


class SourceTests(unittest.TestCase):
    def setUp(self):
        self.ui = read("games", "hqcasinoui.js")
        self.floor = read("games", "hqcasino.js")

    def test_nothing_random_on_the_page_and_no_html_strings(self):
        for src in (self.ui, self.floor):
            self.assertNotIn("Math.random(", src)
            self.assertNotIn("innerHTML", src)
            self.assertNotIn("insertAdjacentHTML", src)

    def test_the_page_only_posts_to_the_casino_routes(self):
        posts = re.findall(r'post\("([^"]+)"', self.ui)
        self.assertEqual(sorted(set(posts)), ["/api/arena/casino/blackjack", "/api/arena/casino/cage", "/api/arena/casino/duel", "/api/arena/casino/play"])
        self.assertNotIn("fetch(", self.ui)

    def test_calm_cuts_the_animations_short(self):
        self.assertIn("A.dur = calm() ? 0.4 :", self.ui)
        self.assertIn("cl = calm()", self.ui)

    def test_the_casino_is_wired_into_the_city_and_the_page(self):
        city = read("games", "hqcity3d.js")
        self.assertIn("HQV.hqCasino.place(W, tier)", city)
        self.assertIn("w.spawnFrom.casino", city)
        hq = read("ui", "app", "22-hq.js")
        self.assertIn('"hqcasinoui","hqcasino"', hq)
        self.assertLess(hq.index('"hqcasinoui"'), hq.index('"hqcity3d"'))
        server = read("dashboard-rs", "src", "server.rs")
        for p in ("/api/arena/casino/play", "/api/arena/casino/cage", "/api/arena/casino/blackjack", "/api/arena/casino/duel"):
            self.assertIn(p, server)


if __name__ == "__main__":
    unittest.main()
