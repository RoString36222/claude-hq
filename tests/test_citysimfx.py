"""Living City scene effects and sirens (games/citysimfx.js HQV.citySimFx, games/engine.js siren / crowd / crackle).

Two node processes: one imports the vendored three.js and runs citysimfx against a stub event director (a fire, a
crash, a medical call, a robbery and a far fire) and a stub engine that records its sirens; the other runs
engine.js against a fake AudioContext (as tests/test_enginesound.py). The Python side checks the pure helpers
(flames on the lot, phase -> intensity, smoke, beacons, siren pitch / Doppler / falloff), the draw-call budget,
the 600 m cut-off, Calm gating and determinism. Skipped without node. Stdlib only."""
import json
import math
import os
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")

FX = r"""
var fs = require("fs"), url = require("url"), root = process.argv[1];
import(url.pathToFileURL(root + "/games/vendor/three-module.js").href).then(function(THREE){
  global.window = {HQV: {}};
  // a stub engine: records the voices citysimfx asks for
  var made = [], sets = [], stops = 0, crackles = [], crowds = [];
  window.HQV.engine = {SIREN_M: 700, calm: function(){ return false; },
    siren: function(kind){ var id = made.length; made.push(kind); return {set: function(d, ap){ sets.push([id, d, ap]); }, stop: function(){ stops++; }}; },
    crackleLoop: function(){ return {set: function(d, l){ crackles.push([d, l]); }, stop: function(){}}; },
    crowdLoop: function(){ return {set: function(d, l){ crowds.push([d, l]); }, stop: function(){}}; }};
  new Function(fs.readFileSync(root + "/games/citysimfx.js", "utf8"))();
  var X = window.HQV.citySimFx, out = {};

  /* ---------- a world with two lots and a stub director ---------- */
  var W = {id: "fxworld", lots: [
    {id: 7, x: 10000, z: 5000, w: 2000, d: 1600, floors: 4, door: [10000, 0, 5800], front: [0, 65536]},
    {id: 8, x: 90000, z: 0, w: 1500, d: 1500, floors: 2, door: [90000, 0, 750], front: [0, 65536]}]};
  function U(kind, d0){ return {kind: kind, station: "st", dispatch: d0, arrive: 120000, leave: 480000, back: 560000}; }
  var EVS = [
    {id: "f1", kind: "fire", start: 0, end: 600000, lot: 7, severity: 2, x: 100, z: 50, units: [U("fire", 30000), U("fire", 32000), U("police", 34000)]},
    {id: "f2", kind: "fire", start: 0, end: 600000, lot: 8, severity: 3, x: 900, z: 0, units: [U("fire", 30000)]},
    {id: "c1", kind: "crash", start: 0, end: 600000, x: 150, z: 60, severity: 2, units: [U("police", 30000), U("tow", 60000), U("ambulance", 31000)]},
    {id: "m1", kind: "medical", start: 0, end: 600000, x: 80, z: 40, severity: 1, units: [U("ambulance", 30000)]},
    {id: "r1", kind: "crime", start: 0, end: 600000, x: 60, z: -30, severity: 2, route: [[200, 0], [220, 0]], units: [U("police", 30000), U("police", 31000)]}];
  function phase(ev, ms){ return ms < ev.start ? "done" : ms < 30000 ? "reported" : ms < 120000 ? "responding" : ms < 400000 ? "onscene" : ms < ev.end ? "clearing" : "done"; }
  var D = {events: function(a, b){ return EVS.filter(function(e){ return e.end > a && e.start < b; }); },
           active: function(ms){ return EVS.filter(function(e){ return e.start <= ms && ms < e.end; }); },
           phase: phase,
           unitsAt: function(ms){ var r = []; EVS.forEach(function(ev){ ev.units.forEach(function(u){
             if(ms >= u.dispatch && ms < u.arrive) r.push({ev: ev, unit: u, phase: "responding", from: {x: ev.x + 400, z: ev.z}, to: {x: ev.x, z: ev.z}}); }); }); return r; },
           at: function(ms){ return {rush: 0, match: {id: "mt", kind: "match", start: 0, end: 7200000, x: 300, z: 0}}; }};

  /* ---------- pure helpers ---------- */
  out.levels = {};
  ["reported", "responding", "onscene", "clearing", "done"].forEach(function(p){ out.levels[p] = [0, 0.5, 1].map(function(u){ return X.fireLevel(p, u, 2); }); });
  out.sev = [1, 2, 3].map(function(s){ return X.fireLevel("onscene", 0, s).flame; });
  var sp = X.phaseSpans(D, EVS[0]); out.spans = sp;
  out.u = [X.phaseU(sp, "onscene", 120000), X.phaseU(sp, "onscene", 260000), X.phaseU(sp, "onscene", 400000)];
  var roof = {x: 100, z: 50, w: 20, d: 16, y: 14};
  out.flames = X.flameSpots(roof, 7, "f1"); out.flames2 = X.flameSpots(roof, 7, "f1");
  var L = X.layout(W, EVS[0], function(x, z){ return 1; }); out.layout = {roof: L.roof, slots: L.slots, cones: L.cones.length, flames: L.flames.length, door: L.door};
  out.crashLayout = X.layout(W, EVS[2], null).crash.length;
  out.blockLayout = X.layout(W, EVS[4], null).block;
  var wind = {x: 1, z: 0, k: 1}, still = {x: 1, z: 0, k: 0};
  function meanX(w, t, calm){ var s = 0, ys = []; for(var i = 0; i < 20; i++){ var p = X.smokePuff(i, 20, t, w, 1, calm, "f1"); s += p.x; ys.push([p.y, p.a]); } return [s/20, ys]; }
  out.smoke = {wind: meanX(wind, 10, false)[0], still: meanX(still, 10, false)[0],
               calmA: meanX(wind, 10, true), calmB: meanX(wind, 37, true), live: [meanX(wind, 10, false)[1], meanX(wind, 13, false)[1]]};
  out.beacon = {calm: [0, 100, 250, 400].map(function(t){ return [X.beaconK("police", t, 0, true, 0), X.beaconK("police", t, 1, true, 0)]; }),
                live: [0, 100, 250, 400].map(function(t){ return [X.beaconK("police", t, 0, false, 0), X.beaconK("police", t, 1, false, 0)]; })};
  var units = D.unitsAt(60000);
  out.pick = X.sirenPick(units, 60000, {x: 100, z: 50}, 2, 700).map(function(p){ return [p.kind, Math.round(p.d)]; });
  out.unitPos = X.unitPos(units[0], 75000);

  /* ---------- the drawing ---------- */
  var scene = new THREE.Scene(), calm = false;
  var fx = X.create({THREE: THREE}, W, D, {scene: scene, ground: function(){ return 1; }, calm: function(){ return calm; }});
  function snap(){ var g = fx.group, r = {}; g.children.forEach(function(m){ var n = m.geometry.instanceCount != null && m.geometry.isInstancedBufferGeometry ? m.geometry.instanceCount : m.count;
      r[m.name] = {n: m.visible ? n : 0, sum: 0, maxX: -1e9};
      if(m.geometry.isInstancedBufferGeometry){ var P = m.geometry.attributes.aPos.array, C = m.geometry.attributes.aCol.array;
        for(var i = 0; i < n*4; i++) r[m.name].sum += P[i] + C[i]*7;
        for(i = 0; i < n; i++) r[m.name].maxX = Math.max(r[m.name].maxX, P[i*4]); }
      else { var A = m.instanceMatrix.array; for(var j = 0; j < n*16; j++) r[m.name].sum += A[j]; for(j = 0; j < n; j++) r[m.name].maxX = Math.max(r[m.name].maxX, A[j*16 + 12]); } });
    return r; }
  var cam = {x: 100, y: 20, z: 50};
  fx.setNight(true);
  fx.update(250000, 1/60, cam); out.onscene = snap(); out.draws = fx.drawCalls();
  fx.update(250000, 1/60, cam); out.again = snap();
  fx.update(250250, 1/60, cam); out.later = snap();
  calm = true;
  fx.update(250000, 1/60, cam); out.calmA = snap(); fx.update(250250, 1/60, cam); out.calmB = snap(); calm = false;
  fx.update(250000, 1/60, {x: 3000, y: 20, z: 3000}); out.farDraws = fx.drawCalls();
  fx.update(60000, 1/60, cam); out.responding = snap();
  fx.update(450000, 1/60, cam); out.clearing = snap();
  fx.update(600000 + 600000, 1/60, cam); out.charred = snap(); out.charDraws = fx.drawCalls();
  fx.update(600000 + 7200000, 1/60, cam); out.goneDraws = fx.drawCalls();
  out.groupKids = fx.group.children.length;

  /* ---------- the sounds it asks for ---------- */
  made.length = 0; sets.length = 0; stops = 0; crackles.length = 0; crowds.length = 0;
  var fx2 = X.create({THREE: THREE}, W, D, {scene: scene, ground: function(){ return 0; }, calm: function(){ return false; }});
  for(var f = 0; f < 30; f++) fx2.update(60000 + f*16, 1/60, {x: 120, y: 5, z: 50});
  out.sound = {made: made.slice(), voices: new Set(sets.map(function(s){ return s[0]; })).size, approach: sets[sets.length - 1][2], crackles: crackles.length, crowds: crowds.length};
  fx2.update(130000, 1/60, {x: 120, y: 5, z: 50}); fx2.update(130300, 1/60, {x: 120, y: 5, z: 50});
  out.sound.stops = stops;
  fx2.destroy(); fx.destroy(); out.destroyed = scene.children.length;
  console.log(JSON.stringify(out));
}).catch(function(e){ console.error(e && e.stack || e); process.exit(1); });
"""

ENG = r"""
const fs = require('fs');
let now = 0, made = 0, vol = '0.5', amb = null, calmOn = false; const gains = [], oscs = [];
function param(v){ const p = {value: v, ev: [], setTargetAtTime(x, t){ p.ev.push(['T', x, t]); },
  cancelScheduledValues(t){ p.ev = p.ev.filter(e => e[2] < t); }, setValueAtTime(x, t){ p.ev.push(['V', x, t]); },
  exponentialRampToValueAtTime(x, t){ p.ev.push(['E', x, t]); }}; return p; }
function node(){ made++; return {connect(){}, start(){}, stop(){ this.stopped = true; }, frequency: param(0), detune: param(0), Q: param(0), type: ''}; }
class AC { constructor(){ this.state = 'running'; this.sampleRate = 8000; this.destination = {}; }
  get currentTime(){ return now; } resume(){ return Promise.resolve(); }
  createGain(){ const n = node(); n.gain = param(1); gains.push(n.gain); return n; }
  createOscillator(){ const n = node(); oscs.push(n); return n; }
  createBiquadFilter(){ return node(); } createBufferSource(){ return node(); }
  createDynamicsCompressor(){ const n = node(); ['threshold', 'knee', 'ratio', 'attack', 'release'].forEach(k => n[k] = param(0)); return n; }
  createBuffer(c, n){ made++; const d = new Float32Array(n); return {getChannelData: () => d}; } }
const window = {HQV: {}, matchMedia: () => ({matches: false}), AudioContext: AC};
const document = {documentElement: {classList: {contains: () => calmOn}}};
global.localStorage = {getItem: k => k === 'hq_ambient' ? amb : vol, setItem(){}};
global.performance = {now: () => 0};
new Function('window', 'document', fs.readFileSync(process.argv[1], 'utf8'))(window, document);
const E = window.HQV.engine, out = {};
const lastT = p => { const e = p.ev.filter(x => x[0] === 'T'); return e.length ? e[e.length - 1] : null; };
// the maths
out.vol = [0, 100, 350, 699, 700, 2000, -1].map(d => E.sirenVol(d));
out.dop = [E.doppler(1000, 0), E.doppler(1000, 20), E.doppler(1000, -20), E.doppler(1000, 500)];
out.amb = [0, 0.3, 0.6, 0.9, 1.2, 1.5].map(t => E.sirenHz('ambulance', t, false, false));
out.wail = []; for (let t = 0; t <= 4.2; t += 0.05) out.wail.push(E.sirenHz('police', t, false, false));
out.yelp = []; for (let t = 0; t <= 0.32; t += 0.01) out.yelp.push(E.sirenHz('police', t, true, false));
out.fire = []; for (let t = 0; t <= 6; t += 0.1) out.fire.push(E.sirenHz('fire', t, false, false));
out.calm = ['police', 'ambulance', 'fire'].map(k => [0, 1.1, 2.7].map(t => E.sirenHz(k, t, true, true)));
out.horn = [0.2, 0.65, 1.0, 2, 7.2].map(t => E.hornOn(t));
// a voice: one graph, nothing made per frame, louder near, silent after the last set()
E.siren('police').stop();                     // the context, its master and the shared bus
let m0 = made, g0 = gains.length, o0 = oscs.length; const v = E.siren('police'); out.made = made - m0;
const outG = gains[g0], main = oscs[o0];
let m1 = made; const lv = [];
for (let i = 0; i < 120; i++){ now += 1/60; v.set(500 - i*3, 15); lv.push(outG.ev[outG.ev.length - 2][1]); }
out.perFrame = made - m1; out.nearer = [lv[0], lv[lv.length - 1]];
out.deadman = outG.ev[outG.ev.length - 1];  out.now = now;
out.mainHz = lastT(main.frequency)[1]; out.mainType = main.type;
now += 1/60; v.set(800, 0); out.beyond = outG.ev[outG.ev.length - 2][1];
v.stop(); out.stopped = oscs.slice(o0).every(o => o.stopped);
// Calm: a soft sine, no horn
calmOn = true; g0 = gains.length; o0 = oscs.length; const fv = E.siren('fire');
for (let i = 0; i < 90; i++){ now += 1/60; fv.set(50, 0); }
out.calmType = oscs[o0].type; out.calmHz = lastT(oscs[o0].frequency)[1];
out.calmHorn = (lastT(gains[g0 + 2]) || [0, 0])[1];
fv.stop(); calmOn = false;
// a fire engine up close blows its horn (a horn gain goes up)
g0 = gains.length; const hv = E.siren('fire'); const hg = gains[g0 + 2]; let blew = false;
for (let i = 0; i < 480; i++){ now += 1/60; hv.set(40, 0); const e = lastT(hg); if (e && e[1] > 0) blew = true; }
out.horned = blew; hv.stop();
// muted: nothing made, set() harmless
vol = '0'; m0 = made; const mv = E.siren('ambulance'); mv.set(10, 0); out.mutedMade = made - m0; vol = '0.5';
// ambient loops: off with the Ambient switch; crowd louder near; the crackle's pops are seeded
amb = '0'; m0 = made; E.crowdLoop().set(10, 1); E.crackleLoop().set(10, 1); out.ambOffMade = made - m0; amb = null;
g0 = gains.length; const cr = E.crowdLoop(); now += 0.1; cr.set(50, 1); const cg = gains[g0]; const near = cg.ev[cg.ev.length - 2][1];
now += 0.1; cr.set(950, 1); out.crowd = [near, cg.ev[cg.ev.length - 2][1]]; cr.stop();
out.crowdVol = [E.crowdVol(0, 1), E.crowdVol(899, 1), E.crowdVol(900, 1), E.crowdVol(0, 0)];
function pops(){ const g1 = gains.length, c = E.crackleLoop(); let n = 0;
  for (let i = 0; i < 120; i++){ now += 1/60; c.set(30, 1); }
  gains.slice(g1).forEach(p => p.ev.forEach(e => { if (e[0] === 'V' && e[1] > 0) n += Math.round(e[1]*1000); })); c.stop(); return n; }
now = 50; const p1 = pops(); now = 50; const p2 = pops(); out.pops = [p1, p2];
// the one-shot sfx
m0 = made; E.sfx('siren', {kind: 'ambulance', dist: 100, approach: 10}); out.sfxMade = made - m0;
m0 = made; E.sfx('siren', {kind: 'police', dist: 5000}); out.sfxFar = made - m0;
console.log(JSON.stringify(out));
"""


@unittest.skipUnless(NODE, "node not installed")
class CitySimFx(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        r = subprocess.run([NODE, "-e", FX, ROOT], capture_output=True, text=True, timeout=120)
        assert r.returncode == 0, r.stderr
        cls.o = json.loads(r.stdout)

    def test_phase_to_intensity(self):
        L = self.o["levels"]
        for p in ("reported", "responding"):
            self.assertLess(L[p][0]["flame"], L[p][2]["flame"], p)          # it grows until the engines are on it
        self.assertGreater(L["onscene"][0]["flame"], L["onscene"][2]["flame"])
        self.assertGreater(L["clearing"][0]["smoke"], L["clearing"][2]["smoke"])
        self.assertAlmostEqual(L["clearing"][2]["flame"], 0)
        self.assertGreater(L["clearing"][1]["steam"], L["reported"][1]["steam"])   # white steam as it dies down
        self.assertEqual(L["done"][1]["flame"], 0)
        self.assertEqual(L["done"][1]["smoke"], 0)
        s = self.o["sev"]
        self.assertLess(s[0], s[1])
        self.assertLess(s[1], s[2])

    def test_phase_spans_by_bisection(self):
        sp = self.o["spans"]
        for k, (a, b) in {"reported": (0, 30000), "responding": (30000, 120000), "onscene": (120000, 400000),
                          "clearing": (400000, 600000)}.items():
            self.assertAlmostEqual(sp[k][0], a, delta=60)
            self.assertAlmostEqual(sp[k][1], b, delta=60)
        u = self.o["u"]
        self.assertAlmostEqual(u[0], 0, places=2)
        self.assertAlmostEqual(u[1], 0.5, places=2)
        self.assertAlmostEqual(u[2], 1, places=2)

    def test_flames_sit_on_the_roof_edge(self):
        F = self.o["flames"]
        self.assertEqual(F, self.o["flames2"])                               # deterministic
        self.assertEqual(len(F), 7)
        for x, y, z in F:
            self.assertEqual(y, 14)
            dx, dz = abs(x - 100), abs(z - 50)
            self.assertLessEqual(dx, 10 - 0.6 + 1e-6)
            self.assertLessEqual(dz, 8 - 0.6 + 1e-6)
            self.assertTrue(abs(dx - 9.4) < 1e-6 or abs(dz - 7.4) < 1e-6, (x, z))   # on the edge, not in the middle

    def test_layout_on_the_lot(self):
        L = self.o["layout"]
        self.assertEqual(L["roof"], {"x": 100, "z": 50, "w": 20, "d": 16, "y": 1 + 4*3.5})
        self.assertEqual(len(L["slots"]), 3)
        self.assertGreater(L["door"]["z"], 58)                                # parked out front, on the street side
        for s in L["slots"]:
            self.assertAlmostEqual(s["z"], L["door"]["z"], places=6)
        self.assertEqual(L["cones"], 12)
        self.assertEqual(L["flames"], 7)
        self.assertEqual(self.o["crashLayout"], 2)
        b = self.o["blockLayout"]
        self.assertEqual((b["x"], b["z"]), (220, 0))                         # the roadblock at the chase's end

    def test_smoke_rises_and_leans_with_the_wind(self):
        s = self.o["smoke"]
        self.assertGreater(s["wind"], s["still"] + 3)
        self.assertEqual(s["calmA"], s["calmB"])                             # Calm: the column stands still
        self.assertNotEqual(s["live"][0], s["live"][1])

    def test_beacons_flash_but_not_in_calm(self):
        b = self.o["beacon"]
        self.assertEqual(len({tuple(x) for x in b["calm"]}), 1)
        self.assertIn([1, 0.08], b["live"])
        self.assertIn([0.08, 1], b["live"])

    def test_siren_pick_nearest_two(self):
        p = self.o["pick"]
        self.assertEqual(len(p), 2)
        self.assertLessEqual(p[0][1], p[1][1])
        self.assertTrue(all(k in ("fire", "police", "ambulance") for k, _ in p))
        self.assertAlmostEqual(self.o["unitPos"]["x"], 100 + 400*(1 - 45000/90000), delta=1)

    def test_draw_budget_and_everything_shows(self):
        o = self.o
        self.assertLessEqual(o["draws"], 12)
        self.assertEqual(o["draws"], 6)
        S = o["onscene"]
        for k in ("fx:smoke", "fx:flame", "fx:glow", "fx:box", "fx:cone", "fx:car"):
            self.assertGreater(S[k]["n"], 0, k)
        # 3 + 1 + 3 + 1 + 2 units parked, and the two crash cars
        self.assertEqual(S["fx:car"]["n"], 3 + 3 + 1 + 2 + 2)
        self.assertEqual(o["groupKids"], 6)

    def test_nothing_beyond_600m(self):
        o = self.o
        self.assertEqual(o["farDraws"], 0)
        for k, v in o["onscene"].items():
            if v["n"]:
                self.assertLess(v["maxX"], 100 + 600 + 50, k)                # the far fire at x = 900 m is not drawn

    def test_deterministic_and_calm(self):
        o = self.o
        self.assertEqual(o["onscene"], o["again"])
        self.assertNotEqual(o["onscene"]["fx:glow"]["sum"], o["later"]["fx:glow"]["sum"])     # beacons flash
        self.assertNotEqual(o["onscene"]["fx:flame"]["sum"], o["later"]["fx:flame"]["sum"])   # flames flicker
        self.assertEqual(o["calmA"]["fx:glow"], o["calmB"]["fx:glow"])     # Calm: no flashing
        # Calm flames and smoke only follow the fire's slow growth and decline, never a flicker or a drift
        for k in ("fx:flame", "fx:smoke"):
            live = abs(o["onscene"][k]["sum"] - o["later"][k]["sum"])
            calm = abs(o["calmA"][k]["sum"] - o["calmB"][k]["sum"])
            self.assertLess(calm*10, live, k)

    def test_fire_story(self):
        o = self.o
        self.assertEqual(o["responding"]["fx:cone"]["n"], 0)                 # no cordon before anyone is there
        self.assertGreater(o["responding"]["fx:smoke"]["n"], 0)
        self.assertLessEqual(o["clearing"]["fx:flame"]["n"], o["onscene"]["fx:flame"]["n"])
        self.assertEqual(o["charred"]["fx:smoke"]["n"], 0)
        self.assertEqual(o["charred"]["fx:box"]["n"], 1)                     # the blackened roof, for an hour
        self.assertEqual(o["charDraws"], 1)
        self.assertEqual(o["goneDraws"], 0)

    def test_sounds_it_drives(self):
        s = self.o["sound"]
        self.assertEqual(len(s["made"]), 2)                                  # only the two nearest sirens
        self.assertEqual(s["voices"], 2)
        self.assertGreater(s["approach"], 0)                                 # they are coming toward us
        self.assertGreater(s["crackles"], 0)
        self.assertGreater(s["crowds"], 0)
        self.assertEqual(s["stops"], 2)                                      # arrived: the sirens stop
        self.assertEqual(self.o["destroyed"], 0)


@unittest.skipUnless(NODE, "node not installed")
class SirenSound(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        r = subprocess.run([NODE, "-e", ENG, os.path.join(ROOT, "games", "engine.js")], capture_output=True, text=True, timeout=30)
        assert r.returncode == 0, r.stderr
        cls.o = json.loads(r.stdout)

    def test_falloff(self):
        v = self.o["vol"]
        self.assertGreater(v[0], v[1])
        self.assertGreater(v[1], v[2])
        self.assertGreater(v[3], 0)
        self.assertEqual(v[4:], [0, 0, 0])

    def test_doppler(self):
        d = self.o["dop"]
        self.assertEqual(d[0], 1000)
        self.assertAlmostEqual(d[1], 1000*343/323, places=6)                 # closing: higher
        self.assertAlmostEqual(d[2], 1000*343/363, places=6)                 # going away: lower
        self.assertAlmostEqual(d[3], 1000*343/263, places=6)                 # clamped to 80 m/s

    def test_patterns(self):
        o = self.o
        self.assertEqual(o["amb"], [960, 960, 770, 770, 960, 960])           # hi-lo
        self.assertAlmostEqual(min(o["wail"]), 650, delta=5)
        self.assertAlmostEqual(max(o["wail"]), 1500, delta=5)
        self.assertGreater(max(o["yelp"]) - min(o["yelp"]), 600)            # the yelp sweeps fast
        self.assertGreater(max(o["fire"]), 1000)
        for row in o["calm"]:
            self.assertEqual(len(set(row)), 1)                               # Calm: a steady tone
            self.assertLess(row[0], 700)
        self.assertEqual(o["horn"], [True, False, True, False, True])

    def test_voice(self):
        o = self.o
        self.assertGreater(o["made"], 3)
        self.assertEqual(o["perFrame"], 0)
        self.assertGreater(o["nearer"][1], o["nearer"][0])                   # louder as it comes closer
        self.assertEqual(o["deadman"][1], 0)                                 # silent 0.25 s after the last set()
        self.assertAlmostEqual(o["deadman"][2], o["now"] + 0.25, places=6)
        self.assertEqual(o["mainType"], "sawtooth")
        self.assertEqual(o["beyond"], 0)
        self.assertTrue(o["stopped"])
        self.assertTrue(o["horned"])

    def test_calm_and_muted(self):
        o = self.o
        self.assertEqual(o["calmType"], "sine")
        self.assertAlmostEqual(o["calmHz"], 480, delta=1)
        self.assertEqual(o["calmHorn"], 0)
        self.assertEqual(o["mutedMade"], 0)
        self.assertEqual(o["ambOffMade"], 0)

    def test_ambient_loops(self):
        o = self.o
        self.assertGreater(o["crowd"][0], 0)
        self.assertEqual(o["crowd"][1], 0)
        self.assertGreater(o["crowdVol"][0], o["crowdVol"][1])
        self.assertEqual(o["crowdVol"][2:], [0, 0])
        self.assertGreater(o["pops"][0], 0)
        self.assertEqual(o["pops"][0], o["pops"][1])                         # seeded, the same every time
        self.assertGreater(o["sfxMade"], 0)
        self.assertEqual(o["sfxFar"], 0)


if __name__ == "__main__":
    unittest.main()
