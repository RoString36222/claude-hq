"""The HQ revamp's working roofs (games/hqroof.js wired by games/hqcity3d.js, the lobby's Roof lift in games/hqlobby.js).

On the real Commons (claude-hq@2 from tests/fixtures, built under node with tests/test_cities.py's stub ctx and
Arena): every HQ lot's tower has its pad on its roof deck and inside its lot; a helicopter (games/hqheli.js) let down
near a pad is drawn over it and set down on it (the assist), "Landing on <name>'s HQ" said once; on the pad you may
step out, onto the deck, and walk it inside its railing; the roof lift's door takes you down (yours into your
Lobby, a friend's as a visitor); the lobby's Roof lift goes up to your deck; no fly-on (island swap) arms over the
towers. Stdlib only; skipped without node or the fixtures."""
import json
import os
import re
import shutil
import subprocess
import unittest

from tests import test_cities as TC

ROOT = TC.ROOT
NODE = shutil.which("node")

CHECKS = r"""
/* ---------- the HQ revamp's roofs ---------- */
for (const f of ["hqheli", "hqroof", "hqdecor", "hqlobby"]) new Function(fs.readFileSync(root + "/games/" + f + ".js", "utf8"))();
const RF = HQV.hqRoof, Hh = HQV.hqheli, T = HQV.hqTower;
var toasts = []; c.api.toast = function(t){ toasts.push(t); };
var CW = DOCS["claude-hq@2"];
function inRing(P, x, z){ var inside = false; for(var i = 0, j = P.length - 1; i < P.length; j = i++){ var xi = P[i][0], zi = P[i][1], xj = P[j][0], zj = P[j][1]; if((zi > z) !== (zj > z) && x < (xj - xi)*(z - zi)/(zj - zi) + xi) inside = !inside; } return inside; }
// every HQ lot's tower (level 50, both wings): its pad on its deck, inside the lot, and no fly-on over it
out.pads = CW.lots.filter(l => l.kind === "hq").map(function(l){
  var p = C3.placeLot(l), g = C3.grandOf(l, p), M = T.massing(50, g, 0), P = l.poly.map(q => [q[0]/100, q[1]/100]);
  var B = {pad: () => M.pad, roofDeck: () => T.roofDeck(M), roofLift: () => null};
  var R = RF.roofOf({x: p.x, y: p.y, z: p.z, rot: p.rot, h: {userId: "u"}}, B, C3.toWorld);
  var rim = [0, 1, 2, 3, 4, 5, 6, 7].every(k => inRing(P, R.pad.x + Math.cos(k*Math.PI/4)*R.pad.r, R.pad.z + Math.sin(k*Math.PI/4)*R.pad.r));
  var S = HQV.ocean.flyOnState(), arm = 0;
  [[10, 0], [0, 10], [-7, 7]].forEach(v => { for(var t = 0; t < 4; t++){ var o = HQV.ocean.flyOn(S, {x: R.pad.x, z: R.pad.z, vx: v[0], vz: v[1], speed: 10}, {r: HQV.ocean.COAST_R.commons + 150, now: t*5000}); if(o.arm || o.swap) arm++; } });
  return {id: l.id, onDeck: RF.onDeck(R, R.pad.x, R.pad.z), inDeck: R.pad.r <= Math.min(R.deck.hw, R.deck.hd) + 0.36, inLot: rim, flyOn: arm};
});
// the Commons with your HQ (level 30) and a friend's (level 12)
ROWS = [{user: ME, lot_rank: 0}, {user: "f1", lot_rank: 1}];
LIST = [{userId: ME, isYou: true, level: 30, look: {}}, {userId: "f1", level: 12, look: {}, trainerName: "Fen"}];
var wc = city("claude-hq@2"); await wc.whenReady; await new Promise(r => setTimeout(r, 0)); frame(wc, 0, 0, 2);
var roofs = wc.roofs(), mineR = roofs.filter(r => r.own)[0], fr = roofs.filter(r => !r.own)[0];
out.roofs = roofs.map(r => ({own: r.own, name: r.name, padFloor: +(wc.heliFloor(r.pad.x, r.pad.z) - r.pad.y).toFixed(3)}));
out.roofDoors = wc.doors.filter(d => d.roof).map(d => [d.view, d.kind, +(d.front.y).toFixed(2)]);
// a landing on the friend's pad: let down 5 m off its centre, 14 m up, no stick but the collective
function land(R, assist){
  var st = Hh.newState("heli", R.pad.x + 5, R.pad.y + 14, R.pad.z - 3, 0); st.ground = false; st.rpm = 1;
  var cues = {}, inp = {fwd: 0, turn: 0, lift: -1};
  for(var i = 0; i < 900 && !st.ground; i++){ Hh.step(st, inp, 1/30, {floor: wc.heliFloor}); if(assist){ var q = wc.heliAssist(st, inp, 1/30); if(q) cues[q] = 1; } }
  return {ground: st.ground, off: +Math.hypot(st.x - R.pad.x, st.z - R.pad.z).toFixed(2), dy: +(st.y - R.pad.y).toFixed(3), cues: Object.keys(cues).sort(), st: st};
}
var L1 = land(fr, true), L0 = land(fr, false);
out.landing = {assisted: {ground: L1.ground, off: L1.off, dy: L1.dy, cues: L1.cues}, plain: {off: L0.off}, toasts: toasts.slice()};
land(fr, true); out.landing.toastsAgain = toasts.length;                        // the same approach: not said again
// out on the pad: onto the deck; walking there; the railing; the roof lift's door
var spot = wc.heliLand(L1.st);
out.exit = spot ? {onDeck: RF.onDeck(fr, spot.x, spot.z), y: +(spot.y - fr.deck.y).toFixed(3)} : null;
avatar = {x: spot.x, z: spot.z, hy: spot.y};
out.walk = {onRoof: wc.onRoof(), ground: +(wc.groundY(spot.x, spot.z) - fr.deck.y).toFixed(3), here: wc.blocked(spot.x, spot.z),
  railing: wc.blocked(fr.deck.x + Math.cos(fr.deck.rot)*(fr.deck.hw + 0.6), fr.deck.z - Math.sin(fr.deck.rot)*(fr.deck.hw + 0.6)),
  house: fr.house ? wc.blocked(fr.house.x, fr.house.z) : null};
avatar = {x: spot.x, z: spot.z, hy: 0};                                         // the street under it: not the roof
out.walk.street = wc.onRoof();
var sp = wc.spawnFrom.roof; out.spawnRoof = sp ? {onDeck: RF.onDeck(mineR, sp.x, sp.z), y: +(sp.y - mineR.deck.y).toFixed(3)} : null;
// the plane never gets the assist: only heliMove calls heliAssist
// the lobby: its Roof lift, the Studio kiosk
c.sky = function(){ return new THREE.Texture(); }; c.rr = function(){}; c.HEX.muted = "#8e9aa6"; c.HEX.ink = "#e9eff3"; c.HEX.coral = "#ff6b5b";
var lw = {scene: new THREE.Scene(), name: "lobby"}, add0 = c.add;
var keep0 = {add: c.add, box: c.box, cyl: c.cyl, sph: c.sph};                               // hq3d's helpers: no parent -> the world being built
["add", "box", "cyl", "sph"].forEach(function(k){ var f = keep0[k], at = k === "add" ? 4 : k === "box" ? 7 : k === "cyl" ? 7 : 5;
  c[k] = function(){ var a = Array.prototype.slice.call(arguments); if(!a[at]) a[at] = lw.scene; return f.apply(c, a); }; });
HQV.hqWorlds.lobby(c, lw); Object.assign(c, keep0);
out.lobby = {roof: lw.doors.filter(d => d.view === "@roof").map(d => d.kind), spawnRoof: lw.spawnFrom.roof, studio: lw.hits.some(h => h.userData.door && h.userData.door.kind === "studio"),
  b1: lw.doors.some(d => d.view === "@basement" && d.kind === "lift"), mission: lw.doors.filter(d => d.view === "@mission").length};
"""


def harness():
    src = TC.HARNESS % {"root": json.dumps(ROOT), "me": json.dumps(TC.ME), "commons": json.dumps(TC.COMMONS), "island": json.dumps(TC.ISLAND),
                        "legacy": json.dumps(os.path.join(TC.FIX, "claude-hq@1.json.gz"))}
    cut = src.index("/* ---------- pure ---------- */")
    return src[:cut] + CHECKS + "\nDate.now = realNow;\nprocess.stdout.write(JSON.stringify(out));\n"


@unittest.skipUnless(NODE, "node is not installed")
@unittest.skipUnless(os.path.exists(TC.COMMONS) and os.path.exists(TC.ISLAND), "the @2 fixtures are missing")
class HqRoofs(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        r = subprocess.run([NODE, "--input-type=module", "-e", harness()], capture_output=True, text=True, timeout=600)
        if r.returncode != 0:
            raise AssertionError("node failed:\n" + r.stderr[-4000:])
        cls.out = json.loads(r.stdout)

    def test_every_commons_tower_has_its_pad(self):
        pads = self.out["pads"]
        self.assertGreater(len(pads), 60)
        for p in pads:
            with self.subTest(lot=p["id"]):
                self.assertTrue(p["onDeck"] and p["inDeck"], "the pad stays on the roof")
                self.assertTrue(p["inLot"], "the pad stands over the lot")
                self.assertEqual(p["flyOn"], 0, "no island swap over a tower")

    def test_pads_are_floors(self):
        self.assertEqual(len(self.out["roofs"]), 2)
        for r in self.out["roofs"]:
            self.assertEqual(r["padFloor"], 0)
        self.assertEqual(sorted(d[0] for d in self.out["roofDoors"]), ["@lobby", "visit:f1"])
        self.assertTrue(all(d[1] == "roof" and d[2] > 10 for d in self.out["roofDoors"]))

    def test_landing_assist(self):
        L = self.out["landing"]
        self.assertTrue(L["assisted"]["ground"])
        self.assertLess(L["assisted"]["off"], 1.0, "drawn over the pad's centre")
        self.assertLess(L["assisted"]["dy"], 0.01)
        self.assertGreater(L["plain"]["off"], 2.0, "without it, it comes down where it was")
        self.assertIn("approach", L["assisted"]["cues"])
        self.assertIn("descend", L["assisted"]["cues"])
        self.assertEqual(L["toasts"], ["\U0001F681 Landing on Fen's HQ"])
        self.assertEqual(L["toastsAgain"], 1, "said once per approach")

    def test_exit_and_walk_the_deck(self):
        e = self.out["exit"]
        self.assertIsNotNone(e, "you may get out on a pad")
        self.assertTrue(e["onDeck"])
        self.assertEqual(e["y"], 0)
        w = self.out["walk"]
        self.assertTrue(w["onRoof"])
        self.assertEqual(w["ground"], 0)
        self.assertFalse(w["here"])
        self.assertTrue(w["railing"], "the railing keeps you on the deck")
        self.assertTrue(w["house"])
        self.assertFalse(w["street"])
        self.assertTrue(self.out["spawnRoof"]["onDeck"])

    def test_lobby_roof_lift(self):
        lb = self.out["lobby"]
        self.assertEqual(lb["roof"], ["lift"])
        self.assertTrue(lb["spawnRoof"])
        self.assertTrue(lb["studio"])
        self.assertTrue(lb["b1"])
        self.assertEqual(lb["mission"], 2)

    def test_hq3d_hooks(self):
        s = open(os.path.join(ROOT, "games", "hq3d.js"), encoding="utf-8").read()
        self.assertIn('if(d.view === "@roof")', s)                               # the Roof stop
        self.assertIn('enterWorld("lobby", "roof")', s)                          # down the roof lift
        self.assertIn("cur.heliAssist(st", s)                                    # helicopters only (heliMove)
        self.assertNotRegex(s[s.index("function planeMove"):s.index("function planeMove") + 4000], r"heliAssist")
        self.assertIn("!!d.roof !== up", s)                                      # roof doors only on the roof


if __name__ == "__main__":
    unittest.main()
