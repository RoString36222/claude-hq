"""Calling a helicopter (games/hqhelicall.js), docs/plans/transport-revamp.md 3.10 and 5.10.

node: landing spots on the real Commons (@2 fixture) and the tiny @3 world (open areas clear of roads, buildings,
lots, sites, water and trees, within 400 m; the airport apron, the hospital pad and the marina breakwater), the pure
flight path (cruise at 90 m, a 12 degree glideslope, a flare, the hover-taxi, a landing pose exactly on the spot,
continuous, the rotor spooling up), the Doppler factor, the controller headless (call, land, board, fly, an own heli
handed back), and the drawing with the vendored three.js (draw calls, Calm drops the dust). Skipped without node."""
import json
import math
import os
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")
FIX = os.path.join(ROOT, "tests", "fixtures")


def read(*p):
    with open(os.path.join(ROOT, *p), encoding="utf-8") as f:
        return f.read()


HARNESS = r"""
import fs from "fs";
import zlib from "zlib";
const root = %(root)s;
const THREE = await import(root + "/games/vendor/three-module.js");
globalThis.window = {HQV: {}};
for (const f of ["world", "hqnav", "hqheli", "hqhelicall"]) new Function(fs.readFileSync(root + "/games/" + f + ".js", "utf8"))();
const H = window.HQV, WD = H.world, HC = H.hqHeliCall, out = {};
const gz = p => JSON.parse(zlib.gunzipSync(fs.readFileSync(p)).toString("utf8"));
const W = WD.pack(gz(%(commons)s)); W.id = "claude-hq@3";
const T3 = WD.pack(JSON.parse(fs.readFileSync(%(tiny)s, "utf8")));

/* ---------- spots ---------- */
function check(Wx, s){
  // every open area: its 26 x 26 m square holds no building, lot, site, water, tree, and no road near it
  const half = HC.consts.OPEN_HALF, bad = [];
  const r = WD.nearestRoad(Wx, s.x, s.z, 60);
  if(r && r.dist - r.half < half) bad.push("road " + (r.dist - r.half).toFixed(1));
  for(let i = 0; i <= 8; i++) for(let k = 0; k <= 8; k++){
    const x = s.x - half + i*half/4, z = s.z - half + k*half/4;
    if(WD.blockedAt(Wx, x, z)) bad.push("blocked");
    if(WD.lotAt(Wx, x, z)) bad.push("lot");
    if(WD.siteAt(Wx, x, z)) bad.push("site");
    if(Wx.water && WD.waterAt(Wx, x, z)) bad.push("water");
    if(Wx.river && WD.riverAt(Wx, x, z)) bad.push("river");
  }
  WD.trees(Wx).forEach(t => { if(Math.abs(t.x - s.x) <= half && Math.abs(t.z - s.z) <= half) bad.push("tree"); });
  return [...new Set(bad)];
}
const sp = W.sites.filter(s => s.kind === "spawn")[0], hosp = W.sites.filter(s => s.kind === "hospital")[0];
out.spots = [];
[[sp.x/100, sp.z/100], [hosp.x/100 + 60, hosp.z/100], [100, -150], [-200, 200]].forEach(p => {
  const t0 = Date.now(), L = HC.spots(W, p[0], p[1], 400, {roofs: [{id: "hq:me", x: p[0] + 5, y: 30, z: p[1] + 5, name: "Your HQ roof"}]});
  out.spots.push({ms: Date.now() - t0, at: p, list: L.map(s => ({id: s.id, kind: s.kind, name: s.name, dist: s.dist, x: s.x, y: s.y, z: s.z, bad: s.kind === "open" ? check(W, s) : []}))});
});
out.again = JSON.stringify(HC.spots(W, sp.x/100, sp.z/100, 400)) === JSON.stringify(HC.spots(W, sp.x/100, sp.z/100, 400));
const bw = WD.waterOf(T3).breakwater;
out.tiny = HC.spots(T3, 200, -80, 400).map(s => ({id: s.id, kind: s.kind, name: s.name, x: s.x, y: s.y, z: s.z, bad: s.kind === "open" ? check(T3, s) : []}));
out.tinyDeck = WD.deckAt(T3, 275, -100);
out.clearOnRoad = (() => { const e = W.edges[10], p = e.pts; return HC.clearAt(W, p[0]/100, p[2]/100); })();

/* ---------- the path ---------- */
function fly(P, dt){
  const S = []; for(let t = 0; t <= P.T + 1e-9; t += dt) S.push(P.pose(t)); S.push(P.pose(P.T)); return S;
}
const from = {x: 0, y: 2, z: 0}, to = {x: 1800, y: 6, z: 900};
const P = HC.path(from, to, {start: "ground"}), S = fly(P, 0.1);
const g = S.filter(p => p.phase === "glide");
let slopes = [];
for(let i = 1; i < g.length; i++){ const dh = Math.hypot(g[i].x - g[i-1].x, g[i].z - g[i-1].z), dy = g[i-1].y - g[i].y; if(dh > 0.5) slopes.push(Math.atan2(dy, dh)*180/Math.PI); }
let jump = 0; for(let i = 1; i < S.length; i++) jump = Math.max(jump, Math.hypot(S[i].x - S[i-1].x, S[i].y - S[i-1].y, S[i].z - S[i-1].z));
const end = P.pose(P.T), cruise = S.filter(p => p.phase === "cruise");
out.path = {T: P.T, H: P.H, phases: [...new Set(S.map(p => p.phase))], slopeMin: Math.min(...slopes), slopeMax: Math.max(...slopes),
  cruiseY: cruise.length ? [Math.min(...cruise.map(p => p.y)), Math.max(...cruise.map(p => p.y))] : null, cruiseV: Math.max(...S.map(p => Math.hypot(p.vx, p.vz))),
  end: {x: end.x, y: end.y, z: end.z, done: end.done}, start: P.pose(0), jump: jump, rpm0: P.pose(0).rpm, rpm5: P.pose(5).rpm,
  flarePitch: Math.max(...S.filter(p => p.phase === "flare").map(p => p.pitch)), taxiY: S.filter(p => p.phase === "taxi").map(p => p.y - to.y),
  minAgl: Math.min(...S.filter(p => p.phase === "cruise" || p.phase === "glide").map(p => p.y - to.y))};
const Ph = HC.path({x: 0, y: 0, z: 0}, {x: 220, y: 0, z: 0}, {start: "ground"}), Sh = fly(Ph, 0.05);
let hopMax = 0; for(let i = 1; i < Sh.length; i++){ const a = Sh[i-1], b = Sh[i], dh = Math.hypot(b.x - a.x, b.z - a.z); if(dh > 0.05 && a.y > b.y && b.phase === "glide") hopMax = Math.max(hopMax, Math.atan2(a.y - b.y, dh)*180/Math.PI); }
out.hop = {T: Ph.T, H: Ph.H, end: Ph.pose(Ph.T), hopMax: hopMax};
const Pc = HC.path({x: 1000, y: 96, z: 0}, {x: 0, y: 6, z: 0}, {start: "cruise"});
out.call = {start: Pc.pose(0), end: Pc.pose(Pc.T), T: Pc.T, rpm0: Pc.pose(0).rpm, phases: [...new Set(fly(Pc, 0.2).map(p => p.phase))]};
const Pl = HC.path({x: 0, y: 0, z: 0}, {x: 1500, y: 90, z: 0}, {start: "ground", end: "cruise"});
out.leave = {end: Pl.pose(Pl.T), phases: [...new Set(fly(Pl, 0.2).map(p => p.phase))]};
out.doppler = [HC.doppler({x: 0, y: 0, z: 0, vx: 40, vy: 0, vz: 0}, {x: 100, y: 0, z: 0}), HC.doppler({x: 0, y: 0, z: 0, vx: -40, vy: 0, vz: 0}, {x: 100, y: 0, z: 0}),
               HC.doppler({x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 40}, {x: 100, y: 0, z: 0})];

/* ---------- the controller, headless ---------- */
{
  const said = [], ach = [], snd = [];
  let me = {x: sp.x/100, y: 0, z: sp.z/100}, now = Date.UTC(2026, 9, 24, 12);
  const C = HC.mount(null, {W: W, me: () => me, ground: (x, z) => WD.groundAt(W, x, z), now: () => now},
                     {announce: t => said.push(t), achievements: {record(e){ ach.push(e); }}, sfx: (n, o) => snd.push([n, o])});
  const L = C.spots(); const spot = L[0];
  const h = C.call(spot, {own: null});
  const r = {spot: spot.id, phase0: h.state().phase, eta0: h.state().eta};
  let n = 0; while(h.state().phase === "coming" && n < 5000){ now += 100; C.update(now, 0.1); n++; }
  r.secs = n/10; r.phase1 = h.state().phase;
  r.useFar = C.use();
  const down = h.state().spot; me = {x: down.x + 3, y: down.y, z: down.z};
  r.flyBefore = C.fly({x: me.x + 900, z: me.z + 500, name: "Harbour"});
  r.use = C.use(); r.phase2 = h.state().phase;
  now += 100; C.update(now, 0.1);
  const c1 = C.carry(now); r.carry = c1 ? {seat: c1.seat, anim: c1.anim} : null; r.cam = !!C.camPose(now, {});
  n = 0; while(h.state().phase === "riding" && n < 20000){ now += 100; C.update(now, 0.1); n++; }
  r.phase3 = h.state().phase; r.exit = C.exit(); r.carryAfter = C.carry(now);
  r.ach = ach; r.snd = snd.filter(s => s[0] === "rotor" && s[1] && s[1].rate).length; r.said = said;
  // your own heli: lands and is handed back
  const h2 = C.call(L[1] || spot, {own: "v-own-1"});
  n = 0; while(h2.state().phase === "coming" && n < 5000){ now += 100; C.update(now, 0.1); n++; }
  r.own = {phase: h2.state().phase, landed: h2.landed(), useOwn: C.use(), release: h2.release(), after: C.current()};
  out.ctl = r;
}

/* ---------- drawing (three.js) ---------- */
{
  const scene = new THREE.Scene();
  const c = {THREE, scene, mat: (col, o) => new THREE.MeshStandardMaterial(Object.assign({color: col}, o || {})),
             glow: (col, s, o) => new THREE.Sprite(new THREE.SpriteMaterial({color: col, transparent: true, opacity: o}))};
  let calm = false, now = 0;
  const C = HC.mount(c, {W: null, me: () => ({x: 0, y: 0, z: 0}), ground: () => 0, group: scene, now: () => now}, {calm: () => calm});
  C.call({id: "open:0:0", x: 0, y: 0, z: 0, kind: "open", name: "Open"}, {own: null});
  let n = 0, dcFly = 0, dcLow = 0, dust = 0;
  while(n++ < 4000){ now += 100; C.update(now, 0.1); const st = C.current() && C.current().state(); if(!st || st.phase !== "coming") break; dcFly = Math.max(dcFly, C.drawCalls()); }
  scene.traverse(o => { if(o.isPoints && o.visible) dust++; });
  calm = true; now += 10; C.update(now, 0.01);
  let dustCalm = 0; scene.traverse(o => { if(o.isPoints && o.visible) dustCalm++; });
  out.draw = {dcFly: dcFly, dustLanding: dust, dustCalm: dustCalm};
  C.dispose();
}
console.log(JSON.stringify(out));
"""


@unittest.skipUnless(NODE, "node not installed")
class HeliCallNode(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        src = HARNESS % {"root": json.dumps(ROOT), "commons": json.dumps(os.path.join(FIX, "claude-hq@2.json.gz")),
                         "tiny": json.dumps(os.path.join(FIX, "world_v3_tiny.json"))}
        r = subprocess.run([NODE, "--input-type=module", "-e", src], capture_output=True, text=True, timeout=300)
        if r.returncode:
            raise AssertionError(r.stderr[-3000:])
        cls.o = json.loads(r.stdout.strip().splitlines()[-1])

    def test_open_spots_are_clear(self):
        n_open = 0
        for case in self.o["spots"]:
            L = case["list"]
            self.assertEqual([s["dist"] for s in L], sorted(s["dist"] for s in L), "nearest first")
            for s in L:
                if s["kind"] == "open":
                    n_open += 1
                    self.assertEqual(s["bad"], [], s)
                    self.assertLessEqual(s["dist"], 400)
            self.assertLess(case["ms"], 3000, "fast enough to list on a tap")
        self.assertGreater(n_open, 0, "open ground is found somewhere")
        self.assertTrue(self.o["again"], "deterministic")
        self.assertFalse(self.o["clearOnRoad"], "a road is never open ground")

    def test_pads(self):
        L = self.o["spots"][0]["list"]
        names = {s["name"] for s in L if s["kind"] == "pad"}
        self.assertIn("Airport apron", names)
        self.assertIn("Your HQ roof", names)
        roof = [s for s in L if s["id"] == "roof:hq:me"][0]
        self.assertEqual(roof["y"], 30, "an HQ roof pad is at the roof's height")
        hosp = [s for s in self.o["spots"][1]["list"] if s["id"] == "pad:hospital:0"]
        if hosp:
            self.assertEqual(hosp[0]["name"], "Hospital helipad")

    def test_breakwater_and_water(self):
        t = self.o["tiny"]
        bw = [s for s in t if s["id"] == "pad:breakwater"]
        self.assertEqual(len(bw), 1)
        self.assertAlmostEqual(bw[0]["x"], 275, places=3)
        self.assertAlmostEqual(bw[0]["z"], -100, places=3, msg="15 m back from the head with the lighthouse")
        self.assertAlmostEqual(bw[0]["y"], self.o["tinyDeck"], places=6, msg="on the crown walk")
        for s in t:
            if s["kind"] == "open":
                self.assertEqual(s["bad"], [], s)

    def test_path_glideslope_and_landing(self):
        p = self.o["path"]
        self.assertEqual(p["phases"], ["spool", "lift", "climb", "cruise", "glide", "flare", "taxi", "land", "settle"])
        self.assertAlmostEqual(p["slopeMin"], 12, delta=0.3)
        self.assertAlmostEqual(p["slopeMax"], 12, delta=0.3)
        self.assertAlmostEqual(p["H"], 96, places=6, msg="cruise 90 m over the higher end")
        self.assertAlmostEqual(p["cruiseY"][0], 96, places=6); self.assertAlmostEqual(p["cruiseY"][1], 96, places=6)
        self.assertLessEqual(p["cruiseV"], 45 + 1e-6)
        e = p["end"]
        self.assertAlmostEqual(e["x"], 1800, places=6); self.assertAlmostEqual(e["y"], 6, places=6); self.assertAlmostEqual(e["z"], 900, places=6)
        self.assertTrue(e["done"])
        self.assertAlmostEqual(p["start"]["x"], 0, places=6); self.assertAlmostEqual(p["start"]["y"], 2, places=6)
        self.assertLess(p["jump"], 45*0.1 + 0.5, "continuous: no jumps between frames")
        self.assertEqual(p["rpm0"], 0, "the rotor spools up on the ground")
        self.assertEqual(p["rpm5"], 1)
        self.assertGreater(p["flarePitch"], 0, "the nose comes up in the flare")
        for y in p["taxiY"]:
            self.assertTrue(2.9 <= y <= 4.1, y)
        self.assertGreaterEqual(p["minAgl"], 11.9, "never lower than the flare height before the flare")

    def test_short_hop_and_call_path(self):
        h = self.o["hop"]
        self.assertAlmostEqual(h["end"]["x"], 220, places=6); self.assertAlmostEqual(h["end"]["y"], 0, places=6)
        self.assertLessEqual(h["hopMax"], 12.5, "a short hop keeps the glideslope")
        self.assertLess(h["H"], 90)
        c = self.o["call"]
        self.assertAlmostEqual(c["start"]["y"], 96, places=6)
        self.assertEqual(c["rpm0"], 1, "a called heli arrives with its rotor turning")
        self.assertNotIn("spool", c["phases"]); self.assertIn("glide", c["phases"])
        self.assertAlmostEqual(c["end"]["y"], 6, places=6)
        l = self.o["leave"]
        self.assertAlmostEqual(l["end"]["x"], 1500, places=6)
        self.assertNotIn("land", l["phases"])

    def test_doppler(self):
        a, r, s = self.o["doppler"]
        self.assertAlmostEqual(a, 343/(343 - 40), places=6)
        self.assertAlmostEqual(r, 343/(343 + 40), places=6)
        self.assertAlmostEqual(s, 1, places=6)

    def test_controller(self):
        r = self.o["ctl"]
        self.assertEqual(r["phase0"], "coming")
        self.assertGreater(r["eta0"], 10)
        self.assertEqual(r["phase1"], "here")
        self.assertFalse(r["useFar"], "board on foot, beside it")
        self.assertTrue(r["flyBefore"]); self.assertTrue(r["use"]); self.assertEqual(r["phase2"], "riding")
        self.assertEqual(r["carry"], {"seat": "rear-left", "anim": "sit"})
        self.assertTrue(r["cam"])
        self.assertIn(r["phase3"], ("done", "leaving"))
        self.assertIsNotNone(r["exit"])
        self.assertIsNone(r["carryAfter"])
        self.assertEqual({a["type"] for a in r["ach"]}, {"heli"}, "High flyer (each call records it; it unlocks once)")
        self.assertGreater(r["snd"], 0, "the rotor beat with a Doppler rate")
        o = r["own"]
        self.assertEqual(o["phase"], "here")
        self.assertEqual(o["landed"]["vehicleId"], "v-own-1")
        self.assertFalse(o["useOwn"], "your own heli is flown by hq3d (mountOn), not boarded as a cab")
        self.assertTrue(o["release"]); self.assertIsNone(o["after"])

    def test_drawing(self):
        d = self.o["draw"]
        self.assertGreater(d["dcFly"], 0)
        self.assertLessEqual(d["dcFly"], 16, "the heli model (hqheli, its static parts merged) plus the dust")
        self.assertEqual(d["dustLanding"], 1, "rotor wash while it lands")
        self.assertEqual(d["dustCalm"], 0, "Calm: no dust")

    def test_house_rules(self):
        src = read("games", "hqhelicall.js")
        self.assertFalse("Math.random" in src)
        self.assertFalse("innerHTML" in src)


if __name__ == "__main__":
    unittest.main()
