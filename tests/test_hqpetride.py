"""Riding your pets (games/hqpetride.js, HQ 3.14): a grown dragon flies you, the sea serpent swims, a big dinosaur walks.

One node process loads the vendored three.js, games/hqpets.js, games/hqroof.js and games/hqpetride.js against a stub
`window` and runs the scenarios; the Python side checks the numbers: who can be ridden (grown, nearby, the serpent on
water only), the dragon's flight (the leap off the ground, climb / glide / hover / dive within their rates, the top
speed, the ceiling, turning banks it, the same flight at 30 and 120 Hz), landing on the ground and on an HQ roof pad
(hqroof's landing assist on the dragon's state), the dismount rules (not mid-air above DISMOUNT_H m), the breath off in
Calm, a dinosaur's walk and run against walls, the mounts' models (saddle, seat, draw calls) and their poses. Then
the wiring by reading the files: presence a = 13 only where the Arena lists "petride", remote riders drawn on their
pet, the Arena's capability. Skipped when node is not installed. Stdlib only."""
import json
import os
import re
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")

HARNESS = r"""
var fs = require("fs"), url = require("url"), root = process.argv[1];
import(url.pathToFileURL(root + "/games/vendor/three-module.js").href).then(function(THREE){
  global.window = {HQV: {}};
  ["hqpets", "hqroof", "hqpetride"].forEach(function(f){ new Function(fs.readFileSync(root + "/games/" + f + ".js", "utf8"))(); });
  var H = window.HQV, P = H.hqPets, R = H.hqPetRide, out = {};
  var sp = function(id){ return P.speciesOf(id); };
  // ---- who rides ----
  out.kinds = P.SPECIES.map(function(s){ return [s.id, R.rideKind(s)]; });
  out.mount = {
    grownNear: R.canMount({sp: sp("firedragon"), affection: 450, d: 2}),
    young: R.canMount({sp: sp("firedragon"), affection: 200, d: 2}),
    far: R.canMount({sp: sp("firedragon"), affection: 450, d: 6}),
    dog: R.canMount({sp: sp("shiba"), affection: 1000, d: 1}),
    raptor: R.canMount({sp: sp("raptor"), affection: 1000, d: 1}),
    trikeYoung: R.canMount({sp: sp("triceratops"), affection: 100, d: 1}),
    trike: R.canMount({sp: sp("triceratops"), affection: 400, d: 1}),
    serpentLand: R.canMount({sp: sp("seaserpent"), affection: 500, d: 2, water: false}),
    serpentSea: R.canMount({sp: sp("seaserpent"), affection: 500, d: 4, water: true}),
    notHere: R.canMount({sp: sp("firedragon"), affection: 450, d: 1, world: false})
  };
  out.grownMark = [R.STAGE_GROWN, P.STAGE_AT[1]];
  // ---- the dragon's flight ----
  var flat = {floor: function(){ return 0; }};
  function fly(hz, secs, inputs, env, st){
    st = st || R.newState("dragon", 0, 0, 0, 0, sp("firedragon"));
    var dt = 1/hz, n = Math.round(secs*hz), path = [], ev = [];
    for(var i = 0; i < n; i++){
      var t = i*dt;
      R.step(st, inputs(t, st), dt, env || flat).forEach(function(e){ ev.push([Math.round((t + dt)*100)/100, e.type, !!e.hard]); });
      if((i + 1) % hz === 0) path.push([st.x, st.y, st.z, st.yaw, st.speed, st.pitch, st.roll, st.wing]);
    }
    return {st: st, path: path, ev: ev};
  }
  function sched(t){ var s = Math.floor(t); if(s < 4) return {lift: 1}; if(s < 12) return {fwd: 1, turn: s >= 8 ? 0.7 : 0}; if(s < 16) return {}; if(s < 19) return {lift: -1}; return {fwd: -1, turn: -1}; }
  var a = fly(30, 24, sched), b = fly(120, 24, sched), c = fly(120, 24, sched);
  out.rates = {p30: a.path, p120: b.path, same: JSON.stringify(b) === JSON.stringify(c)};
  // the leap: Space on the ground
  var lp = fly(60, 1.5, function(){ return {lift: 1}; });
  out.leap = {ev: lp.ev, y: lp.st.y, ground: lp.st.ground, wing: lp.st.wing};
  // climb: rate never past V.climb; then glide at cruise: a slow sink; then hover (S down to 0): height held
  var cl = R.newState("dragon", 0, 0, 0, 0), vys = [];
  fly(60, 6, function(t, st){ vys.push(st.vy); return {lift: 1}; }, flat, cl);
  var y0 = cl.y; fly(60, 7, function(){ return {fwd: 1}; }, flat, cl);
  var gl = [], gw = null; fly(60, 4, function(t, st){ gl.push(st.vy); gw = st.wing; return {}; }, flat, cl);
  var hv = R.newState("dragon", 0, 50, 0, 0); hv.ground = false; var hy = [], hw = null;
  fly(60, 6, function(t, st){ hy.push(st.y); hw = st.wing; return {}; }, flat, hv);
  out.climb = {maxVy: Math.max.apply(null, vys), y0: y0, glideVy: gl.slice(-60), glideWing: gw, hoverY: [hy[0], hy[hy.length - 1]], hoverWing: hw,
               V: {climb: R.VEHICLES.dragon.climb, glide: R.VEHICLES.dragon.glide, top: R.VEHICLES.dragon.top, dive: R.VEHICLES.dragon.dive, diveGain: R.VEHICLES.dragon.diveGain, ceil: R.VEHICLES.dragon.ceil}};
  // top speed: W held for a minute; a dive past it; the ceiling
  var ts = R.newState("dragon", 0, 300, 0, 0); ts.ground = false; fly(60, 60, function(){ return {fwd: 1}; }, flat, ts); out.top = ts.speed;
  var dv = ts, dvs = [], dw = null; fly(60, 6, function(t, st){ dvs.push(st.vy); dw = st.wing; return {fwd: 1, lift: -1}; }, flat, dv);
  out.dive = {speed: dv.speed, minVy: Math.min.apply(null, dvs), wing: dw, pitch: dv.pitch};
  var ce = R.newState("dragon", 0, 780, 0, 0); ce.ground = false; var ceil = fly(60, 20, function(){ return {lift: 1}; }, flat, ce); out.ceil = {y: ce.y, ev: ceil.ev.map(function(e){ return e[1]; })};
  // a turn at speed banks it; in a hover it turns quicker
  var tn = R.newState("dragon", 0, 100, 0, 0); tn.ground = false; fly(60, 8, function(){ return {fwd: 1}; }, flat, tn);
  fly(60, 2, function(){ return {fwd: 1, turn: 1}; }, flat, tn); out.bank = {roll: tn.roll, rate: tn.rate};
  var th = R.newState("dragon", 0, 100, 0, 0); th.ground = false; fly(60, 2, function(){ return {turn: 1}; }, flat, th); out.hoverTurn = th.rate;
  // ---- landing: on the ground (Shift from a hover), and on an HQ roof pad with the landing assist ----
  var ld = R.newState("dragon", 0, 20, 0, 0); ld.ground = false;
  var lev = fly(60, 12, function(t, st){ return st.ground ? {} : {lift: -1}; }, flat, ld);
  out.landGround = {ground: ld.ground, y: ld.y, ev: lev.ev.map(function(e){ return [e[1], e[2]]; })};
  var roof = {uid: "u", name: "Ada's HQ", own: false, rot: 0, pad: {x: 0, z: 0, y: 60, r: 6}, deck: {x: 0, z: 4, hw: 12, hd: 12, y: 60, rot: 0}, lift: {x: 0, z: 9, y: 60}, house: null};
  var padFloor = {floor: function(x, z){ return Math.hypot(x, z) < 13 ? 60 : 0; }};
  var pd = R.newState("dragon", 9, 72, -6, 0); pd.ground = false; var S = {}, cues = {}, says = [];
  var pev = fly(60, 25, function(t, st){
    var o = H.hqRoof.step(S, st, [roof], {lift: st.ground ? 0 : -0.5}, 1/60); if(o.cue) cues[o.cue] = 1; if(o.say) says.push(o.say);
    return st.ground ? {} : {lift: -0.5}; }, padFloor, pd);
  out.landPad = {ground: pd.ground, y: pd.y, d: Math.hypot(pd.x, pd.z), cues: Object.keys(cues).sort(), says: says, spot: H.hqRoof.spotBeside(roof)};
  // dismount: not 10 m up; yes just over the ground, and landed
  var hi = R.newState("dragon", 0, 10, 0, 0); hi.ground = false; hi.agl = 10;
  var lo = R.newState("dragon", 0, 2, 0, 0); lo.ground = false; lo.agl = 2.4;
  out.dismount = {high: R.canDismount(hi), low: R.canDismount(lo), landed: R.canDismount(ld), DH: R.DISMOUNT_H};
  // ---- the breath: none in Calm ----
  out.breath = {fire: R.breathOf(sp("firedragon"), false), ice: R.breathOf(sp("icedragon"), false), fireCalm: R.breathOf(sp("firedragon"), true),
                gold: R.breathOf(sp("golddragon"), false), wyvern: R.breathOf(sp("wyvern"), false), trikeCalm: R.breathOf(sp("triceratops"), true)};
  // ---- on the ground: a dinosaur walks, runs, stops at a wall; the serpent stays on the water ----
  var dn = R.newState("dino", 0, 0, 0, 0, sp("triceratops")), wall = {blocked: function(x, z){ return z > 60; }, ground: function(){ return 1.5; }};
  fly(60, 4, function(){ return {fwd: 1}; }, wall, dn); var walk = dn.speed;
  fly(60, 3, function(){ return {fwd: 1, run: true}; }, wall, dn); var run = dn.speed;
  var bump = fly(60, 8, function(){ return {fwd: 1, run: true}; }, wall, dn);
  out.dino = {walk: walk, run: run, D: R.DINO.triceratops, z: dn.z, y: dn.y, bumped: bump.ev.some(function(e){ return e[1] === "bump"; }), ground: dn.ground};
  var sea = {water: function(x, z){ return z < 20; }, waterY: function(){ return -0.4; }};
  var se = R.newState("serpent", 0, 0, 0, 0, sp("seaserpent")); fly(60, 10, function(){ return {fwd: 1, run: true}; }, sea, se);
  out.serpent = {z: se.z, y: se.y, top: R.VEHICLES.serpent.top, off: R.canDismount(se, sea), offSea: R.canDismount(R.newState("serpent", 0, 0, -50, 0), sea)};
  // ---- the mounts: every rideable species, posed in every wing mode and gait ----
  var mat = function(col, o){ return new THREE.MeshStandardMaterial({color: col, roughness: (o || {}).roughness || 0.5}); };
  var ctx = {THREE: THREE, mat: mat, L: null};
  out.models = {};
  P.SPECIES.forEach(function(s){
    if(!R.rideKind(s)) return;
    var B = R.mountModel(ctx, {species: s.id, variant: 1, acc: 31, name: "Rex"}), st = R.newState(R.rideKind(s), 0, 0, 0, 0, s);
    ["fold", "climb", "hover", "glide", "dive"].forEach(function(w){ st.wing = w; st.ground = w === "fold"; st.speed = w === "hover" ? 2 : 30; R.animate(B, st, 1.3, 1/60, false, false); R.animate(B, st, 1.4, 1/60, true, false); });
    st.ground = true; st.speed = 8; R.animate(B, st, 2, 1/60, false, false); R.animate(B, st, 2.1, 1/60, false, true);
    var n = 0; B.g.traverse(function(o){ if(o.isMesh || o.isInstancedMesh) n++; });
    var box = new THREE.Box3().setFromObject(B.M.g), sz = box.getSize(new THREE.Vector3());
    out.models[s.id] = {draws: n, seatY: B.seat.position.y, saddle: B.saddle.length, len: Math.max(sz.x, sz.z), h: sz.y, kind: B.rk, scale: B.RS, hasWings: !!B.M.wing,
                        mouth: B.mouth().toArray().map(function(v){ return Math.round(v*100)/100; })};
  });
  // the wyvern: the saddle between its wing-shoulders, at its back standing, walking and flying; its wings clear the ground landed
  var Bw = R.mountModel(ctx, {species: "wyvern", variant: 0, name: "Wy"}), sw = R.newState("dragon", 0, 0, 0, 0, sp("wyvern")), wyS = {};
  function backY(){ Bw.g.updateMatrixWorld(true); var p = new THREE.Vector3().fromArray(P.WY_SEAT); Bw.M.body.localToWorld(p); return p.y; }
  function memMin(){ Bw.g.updateMatrixWorld(true); return new THREE.Box3().setFromObject(Bw.M.wingMesh, true).min.y; }
  [["stand", true, "fold", 0], ["walk", true, "fold", 3], ["glide", false, "glide", 30], ["climb", false, "climb", 20]].forEach(function(c){
    sw.ground = c[1]; sw.wing = c[2]; sw.speed = c[3]; sw.agl = c[1] ? 0 : 40; sw.vy = 0;
    for(var i = 0; i < 40; i++) R.animate(Bw, sw, 3 + i/60, 1/60, false, false);
    wyS[c[0]] = {back: backY(), mem: memMin()};
  });
  wyS.top = Bw.seat.position.y - 0.16; wyS.s = Bw.s;
  out.wyvern = wyS;
  // a breath through a pooled Fx (a stand-in: emit / zap recorded)
  var em = [], F = {emit: function(k, x, y, z, n, dx, dz, spd){ em.push([k, n, Math.round(spd)]); }, zap: function(){ em.push(["zap"]); }};
  var Bf = R.mountModel(ctx, {species: "firedragon", variant: 0, name: "Ember"}), sf = R.newState("dragon", 0, 50, 0, 0); sf.speed = 30;
  for(var i = 0; i < 30; i++) R.breathe(F, Bf, sf, 1/60, R.breathOf(Bf.sp, false));
  R.breathe(F, Bf, sf, 1/60, R.breathOf(Bf.sp, true));
  out.breathe = {n: em.length, first: em[0]};
  // someone else's dragon from their presence
  var Bp = R.mountModel(ctx, {species: "stormdragon", variant: 0, name: "Zap"});
  out.peer = [R.peerState(Bp, 30, 0, 50).wing, R.peerState(Bp, 30, 3, 50).wing, R.peerState(Bp, 3, 0, 50).wing, R.peerState(Bp, 30, -8, 50).wing, R.peerState(Bp, 0, 0, 0).ground];
  process.stdout.write(JSON.stringify(out));
}).catch(function(e){ console.error(e && e.stack || e); process.exit(1); });
"""


def read(p):
    with open(os.path.join(ROOT, p), encoding="utf-8") as f:
        return f.read()


@unittest.skipUnless(NODE, "node not installed")
class PetRide(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        r = subprocess.run([NODE, "-e", HARNESS, ROOT], capture_output=True, text=True, timeout=180)
        if r.returncode != 0:
            raise AssertionError(r.stderr[-3000:])
        cls.o = json.loads(r.stdout)

    def test_who_can_be_ridden(self):
        k = dict(self.o["kinds"])
        for d in ("wyvern", "firedragon", "icedragon", "stormdragon", "crystaldragon", "shadowdragon", "golddragon"):
            self.assertEqual(k[d], "dragon", d)
        self.assertEqual(k["seaserpent"], "serpent")
        for d in ("triceratops", "brachio", "stego", "trex"):
            self.assertEqual(k[d], "dino", d)
        for no in ("shiba", "tabby", "raptor"):
            self.assertIsNone(k[no], no)
        m = self.o["mount"]
        self.assertTrue(m["grownNear"]["ok"])
        self.assertTrue(m["young"]["ok"])                     # 3.14: grown from adoption, any affection
        self.assertEqual(m["far"]["why"], "far")              # beside it
        self.assertEqual(m["dog"]["why"], "kind")
        self.assertEqual(m["raptor"]["why"], "kind")
        self.assertTrue(m["trikeYoung"]["ok"])                 # big dinos ride from adoption too
        self.assertTrue(m["trike"]["ok"])
        self.assertEqual(m["serpentLand"]["why"], "water")    # the serpent: on the water only
        self.assertTrue(m["serpentSea"]["ok"])
        self.assertEqual(m["notHere"]["why"], "world")
        self.assertEqual(self.o["grownMark"][0], self.o["grownMark"][1])

    def test_same_flight_at_30_and_120_hz(self):
        r = self.o["rates"]
        self.assertTrue(r["same"])
        for a, b in zip(r["p30"], r["p120"]):
            for i in range(7):
                self.assertAlmostEqual(a[i], b[i], delta=1e-6)

    def test_leap_off_the_ground(self):
        lp = self.o["leap"]
        self.assertEqual(lp["ev"][0][1], "takeoff")
        self.assertFalse(lp["ground"])
        self.assertGreater(lp["y"], 3)
        self.assertEqual(lp["wing"], "climb")

    def test_climb_glide_hover_bounds(self):
        c = self.o["climb"]
        self.assertLessEqual(c["maxVy"], c["V"]["climb"] + 1e-6)
        self.assertGreater(c["y0"], 25)                       # six seconds of climbing
        for vy in c["glideVy"]:
            self.assertLess(vy, 0)
            self.assertGreater(vy, -c["V"]["glide"] - 0.05)  # a slow sink
        self.assertEqual(c["glideWing"], "glide")
        self.assertAlmostEqual(c["hoverY"][0], c["hoverY"][1], delta=0.2)   # a hover holds its height
        self.assertEqual(c["hoverWing"], "hover")

    def test_top_speed_dive_ceiling(self):
        V = self.o["climb"]["V"]
        self.assertLessEqual(self.o["top"], V["top"] + 1e-6)
        self.assertGreater(self.o["top"], V["top"] - 2)       # 25-45 m/s cruise: W gets it to the top
        d = self.o["dive"]
        self.assertGreater(d["speed"], self.o["top"])          # a dive trades height for speed
        self.assertLessEqual(d["speed"], V["top"] + V["diveGain"] + 1e-6)
        self.assertGreaterEqual(d["minVy"], -V["dive"] - 1e-6)
        self.assertLess(d["minVy"], -10)
        self.assertEqual(d["wing"], "dive")
        self.assertLess(d["pitch"], -0.3)
        self.assertLessEqual(self.o["ceil"]["y"], V["ceil"] + 1e-6)

    def test_turns_bank_and_hover_turns_quicker(self):
        self.assertLess(self.o["bank"]["roll"], -0.1)          # A (left) banks it left (roll < 0: left side down)
        self.assertGreater(self.o["hoverTurn"], self.o["bank"]["rate"])

    def test_landing_on_the_ground_and_on_a_pad(self):
        g = self.o["landGround"]
        self.assertTrue(g["ground"])
        self.assertAlmostEqual(g["y"], 0, delta=1e-6)
        self.assertEqual([e for e in g["ev"] if e[0] == "land"], [["land", False]])   # soft: the last beats cushion it
        p = self.o["landPad"]
        self.assertTrue(p["ground"])
        self.assertAlmostEqual(p["y"], 60, delta=1e-6)        # on the roof pad's deck
        self.assertLess(p["d"], 6)                             # drawn over the pad
        self.assertIn("descend", p["cues"])
        self.assertEqual(p["says"], ["Landing on Ada's HQ"])

    def test_dismount_rules(self):
        d = self.o["dismount"]
        self.assertEqual(d["DH"], 3)
        self.assertEqual(d["high"], {"ok": False, "why": "high"})
        self.assertTrue(d["low"]["ok"])
        self.assertTrue(d["landed"]["ok"])

    def test_breath_off_in_calm(self):
        b = self.o["breath"]
        self.assertEqual((b["fire"], b["ice"], b["gold"], b["wyvern"]), ("fire", "ice", "glitter", "smoke"))
        self.assertIsNone(b["fireCalm"])
        self.assertIsNone(b["trikeCalm"])
        br = self.o["breathe"]
        self.assertGreater(br["n"], 5)
        self.assertEqual(br["first"][0], "fire")
        self.assertGreaterEqual(br["first"][2], 46)            # carried along at the dragon's speed

    def test_dino_and_serpent_on_the_ground(self):
        d = self.o["dino"]
        self.assertAlmostEqual(d["walk"], d["D"]["walk"], delta=0.3)
        self.assertAlmostEqual(d["run"], d["D"]["run"], delta=0.6)
        self.assertTrue(d["bumped"])
        self.assertLessEqual(d["z"], 60.01)                    # never through the wall
        self.assertEqual(d["y"], 1.5)
        s = self.o["serpent"]
        self.assertLess(s["z"], 20)                             # stays on the water
        self.assertEqual(s["y"], -0.4)
        self.assertTrue(s["off"]["ok"])                         # beside the shore: off
        self.assertEqual(s["offSea"]["why"], "water")           # out at sea: not

    def test_mount_models(self):
        m = self.o["models"]
        self.assertEqual(len(m), 12)
        for k, v in m.items():
            self.assertEqual(v["saddle"], 2, k)
            self.assertLessEqual(v["draws"], 9, k)              # the pet's at most 6 + blanket + saddle (+ a spare)
            self.assertGreater(v["seatY"], 0.8, k)
            self.assertGreater(v["len"], 2.4, k)                 # big enough to sit on
        self.assertGreater(m["firedragon"]["len"], 3)
        self.assertTrue(m["firedragon"]["hasWings"])
        self.assertEqual(m["seaserpent"]["kind"], "serpent")
        self.assertEqual(self.o["peer"], ["glide", "climb", "hover", "dive", True])


    def test_the_wyvern_seat(self):
        w = self.o["wyvern"]
        for k in ("stand", "walk", "glide", "climb"):
            self.assertLess(abs(w[k]["back"] - w["top"]), 0.15, k + ": the rider sits on its back between the shoulders")
        self.assertGreater(w["stand"]["mem"], -0.02, "landed, its folded wings clear the ground")
        self.assertGreater(w["top"], 1.5)


class Wiring(unittest.TestCase):
    def test_presence_and_capability(self):
        hq = read("ui/app/22-hq.js")
        self.assertIn('if(a===13 && !hqNetCan("petride")) a = 0;', hq)
        self.assertIn('"hqpets","hqpetride","hqlobby"', hq)
        self.assertIn("hqpetride:1", hq)
        g = read("games/hq3d.js")
        self.assertIn("return ride ? (ride.tank ? 14 : ride.pet ? 13 :", g)   # [3.17] a tank first
        self.assertIn('13: "petride"', g)
        self.assertIn("HQV.hqPetRide.mountModel(ctx, {species: pmount.sp.id", g)   # remote riders on their pet
        self.assertIn("HQV.hqPetRide.animate(P.bike, pst", g)
        self.assertIn("mount: a === 13", g)                                       # their follower copy steps aside
        self.assertIn("if(ride.pet){ dismountPet(force); return; }", g)
        proto = read("backend/src/protocol.rs")
        self.assertRegex(proto, r'\("hq", 4, &\[[^\]]*"petride"[^\]]*\]')
        hqrs = read("backend/src/valley/hq.rs")
        self.assertIn("13.0, 14.0].contains(&f)", hqrs)   # [3.17] 14: a tank
        self.assertIn("crate::pets::rideable(t.0, t.3)", hqrs)

    def test_pets_runtime_hides_the_mount_and_offers_the_ride(self):
        p = read("games/hqpets.js")
        self.assertIn('showPrompt("E  Ride " + rideNear.p.name)', p)
        self.assertIn("if(pr.mount) list = list.slice(1);", p)
        self.assertIn("K.setMounted = function(id, at)", p)
        self.assertRegex(p, r"wm === \"dive\"")

    def test_controls_documented(self):
        rd = read("README.md")
        self.assertIn("Ride your pets", rd)
        g = read("games/hq3d.js")
        for k in ("dragon:", "dino:", "serpent:"):
            self.assertGreaterEqual(g.count(k), 2, k)                              # RIDE_HELP and RIDE_HINT
        self.assertIn('e.code === "KeyF"', g)


if __name__ == "__main__":
    unittest.main()
