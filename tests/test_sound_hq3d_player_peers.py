"""Sound PR B in the 3D HQ/City host (games/hq3d.js) and its own modules (hqgrenade, hqbasementfx).

Under node, with games/engine.js on the fake AudioContext of tests/test_spatial_sound.py: other players' vehicles as
this page plays them (HQV.hq3dPure.peerSound: a helicopter's rotor, a prop's drone, an airliner's turbofans, a car's,
motorbike's or tank's own voice at the revs their presence sends, else a guess from their speed, silent standing with
nothing sent, no engine for a bicycle or a pet) and the pools they play through (HQV.hq3dPure.peerPools: the nearest 3
cars, the nearest helicopter and plane, handles made once and reused, a new voice for a changed vehicle, nothing at sfx
volume 0, and their planes not muted by Ambient sounds at 0%: a person, not ambience); the grenade's boom where it goes
off (hqGrenade.boomAt: through spatialOut("blast"), panned, at the ears' distance, its own sound-travel delay only, cut
at 400 m, one of the blast kind's voices; centred through audioOut() on an engine without spatialOut); the basement's
car lift and its bell at the lift (hqBasementFx). The rest reads
games/hq3d.js: your own engines are "own" at you, the peers' sounds are wired, the blasts go through boomAt, a paused
view lets its floor's voices go, and the pins other tests rely on are intact. Skipped without node. Stdlib only."""
import json
import os
import re
import subprocess
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import test_spatial_sound as core  # noqa: E402  (its fake AudioContext and runner)

ROOT = core.ROOT
NODE = core.NODE


def read(*p):
    with open(os.path.join(ROOT, *p), encoding="utf-8") as f:
        return f.read()


def func_body(src, name):
    """The text of `function name(...){ ... }` (brace matched)."""
    m = re.search(r"function %s\([^)]*\)\s*\{" % re.escape(name), src)
    assert m, name
    i, depth = m.end(), 1
    while depth:
        depth += src[i] == "{"
        depth -= src[i] == "}"
        i += 1
    return src[m.start():i]


LOAD = core.FAKE + r"""
const load = f => new Function('window', 'document', fs.readFileSync(path.join(R0, 'games', f), 'utf8'))(window, document);
['hqvehiclephys.js', 'hqheli.js', 'hqplane.js', 'hqpetride.js', 'hq3d.js', 'hqgrenade.js', 'hqbasementfx.js'].forEach(load);
const H = window.HQV.hq3dPure, G = window.HQV.hqGrenade, F = window.HQV.hqBasementFx, PH = window.HQV.hqVehiclePhys;
// games/hq3d.js VEHICLES' own starters and the tank (the rest come from their modules)
const CAR = {top: 22, motor: true, gears: [5, 9.5, 14, 18.5, 23], eng: "turbo"};
const MOTO = {top: 24, motor: true, gears: [6.5, 11.5, 16, 20.5, 25], eng: "bike"};
const TANK = {top: 11, motor: true, gears: [3, 6, 9, 11.5], eng: "diesel", tank: true};
const BIKE = {top: 10, sprint: 14};
const HELI = window.HQV.hqheli.VEHICLES, PLANE = window.HQV.hqplane.VEHICLES, PET = window.HQV.hqPetRide.VEHICLES;
const EN_CAR = PH.engineFor({}, 'car', CAR.eng, CAR.gears), EN_TANK = PH.engineFor({}, 'car', TANK.eng, TANK.gears);
store.hq_sfx = '0.5';
"""

PEERS = LOAD + r"""
// ---- what each vehicle sounds like ----
const at = {x: 30, hy: 2, z: -4};
const P = o => Object.assign({}, at, o);
out.car = H.peerSound('u1', P({pv: 12, rpm: 3200, vk: 'car'}), CAR, EN_CAR);
out.carGuess = H.peerSound('u1', P({pv: 11, vk: 'car'}), CAR, EN_CAR);
out.carWant = EN_CAR.idle + (EN_CAR.red - EN_CAR.idle)*0.5*0.6;
out.carStill = H.peerSound('u1', P({pv: 0.1, vk: 'car'}), CAR, EN_CAR);
out.carIdle = H.peerSound('u1', P({pv: 0, rpm: 850, vk: 'car'}), CAR, EN_CAR);
out.noReal = H.peerSound('u1', P({pv: 11, vk: 'car'}), CAR, null);
out.tuned = H.peerSound('u1', P({pv: 12, rpm: 3200, vk: 'car', ex: 'sport'}), CAR, EN_CAR);
out.moto = H.peerSound('u2', P({pv: 20, rpm: 9000, vk: 'moto'}), MOTO, PH.engineFor({}, 'bike', MOTO.eng, MOTO.gears));
out.tank = H.peerSound('u3', P({pv: 4, rpm: 1500, vk: 'tank'}), TANK, EN_TANK);
out.heli = H.peerSound('u4', P({pv: 22.5, vk: 'heli', hy: 50}), HELI.heli, null);
out.attack = H.peerSound('u4', P({pv: 0, vk: 'attack'}), HELI.attack, null);
out.prop = H.peerSound('u5', P({pv: 33, vk: 'prop'}), PLANE.prop, null);
out.seaplane = H.peerSound('u5', P({pv: 0, vk: 'seaplane'}), PLANE.seaplane, null);
out.airliner = H.peerSound('u6', P({pv: 60, vk: 'airliner'}), PLANE.airliner, null);
out.none = [H.peerSound('u7', P({pv: 6, vk: 'bike'}), BIKE, null), H.peerSound('u8', P({pv: 20, vk: 'petride'}), PET.petride, null),
            H.peerSound('u9', null, CAR, EN_CAR), H.peerSound('u9', P({}), null, null)];
// ---- the pools: the nearest of each kind, handles reused, a new voice for a changed vehicle ----
E.listener({x: 0, y: 0, z: 0, yaw: Math.PI/2});           // faces +x; its right is +z
const engines = [], sets = [], es = E.engineSound;
E.engineSound = function(v, ex, real){ engines.push([v, ex, !!real]); const h = es(v, ex, real), s0 = h.set;
  h.set = function(rpm, o){ sets.push([v, Math.round(rpm), o.sk, !!o.pos]); s0(rpm, o); }; return h; };
const cars = d => d.map((x, i) => H.peerSound('c' + i, {x: x, hy: 0, z: 0, pv: 8, rpm: 2500 + i, vk: 'car'}, CAR, EN_CAR));
const air = [H.peerSound('h', {x: 0, hy: 60, z: -300, pv: 10, vk: 'heli'}, HELI.heli, null),
             H.peerSound('h2', {x: 0, hy: 60, z: -500, pv: 10, vk: 'heli'}, HELI.heli, null),
             H.peerSound('j', {x: 900, hy: 300, z: 0, pv: 80, vk: 'airliner'}, PLANE.airliner, null),
             H.peerSound('j2', {x: 1200, hy: 300, z: 0, pv: 80, vk: 'airliner'}, PLANE.airliner, null)];
const PP = H.peerPools(E);
const list1 = cars([10, 20, 30, 45, 60, 200]).concat(air);
out.ids1 = PP.update(list1); out.made1 = engines.slice(); out.sets1 = sets.slice(); sets.length = 0;
out.state1 = S.state().pools;
const list2 = cars([10, 20, 30, 24, 60, 200]).concat(air);      // c3 20% nearer than c2: it takes c2's voice (and its handle)
out.ids2 = PP.update(list2); out.made2 = engines.length;
const list3 = list2.slice(); list3[0] = H.peerSound('c0', {x: 10, hy: 0, z: 0, pv: 8, rpm: 2500, vk: 'car', ex: 'sport'}, CAR, EN_CAR);
out.ids3 = PP.update(list3); out.made3 = engines.slice(out.made2);  // another exhaust: its own voice
store.hq_sfx = '0'; out.muted = PP.update(list3); store.hq_sfx = '0.5';
E.ambientSetVolume(0); out.ambient0 = PP.update(list3); E.ambientSetVolume(1);   // a person's plane is not ambience
E.listener(null); out.noEars = PP.update(list3); E.listener({x: 0, y: 0, z: 0, yaw: Math.PI/2});
PP.stop(); out.stopped = S.state().pools;
out.noPools = [H.peerPools(null), H.peerPools({engineSound: es}), H.peerPools({pool: E.pool})];
E.engineSound = es;
console.log(JSON.stringify(out));
"""

BOOM = LOAD + r"""
now = 10;
E.listener({x: 0, y: 0, z: 0, yaw: Math.PI/2});           // faces +x; its right is +z
const boomAt = (p, d, wet, e) => { const k = nodes.length, V = G.boomAt(e || E, p, d, wet), m = since(k);
  const src = m.find(n => n.kind === 'src'), lp = m.find(n => n.kind === 'filter'), gn = m.filter(n => n.kind === 'gain' && n.out[0] === (V && V.out))[0];
  const pan = m.find(n => n.kind === 'pan');
  return {V: !!V, made: m.length, voice: V && V.out && V.out.gain ? r4(V.out.gain.value) : null, delay: V ? V.delay : null, d: V && V.d != null ? r4(V.d) : null,
          pan: pan ? r4(pan.pan.value) : null, start: src ? r4(src.started - now) : null, rate: src ? src.playbackRate.value : null,
          gain: gn ? r4(gn.gain.value) : null, lp: lp ? r4(lp.frequency.value) : null, toVoice: !!gn}; };
out.right = boomAt({x: 0, y: 0, z: 100}, 7, false);          // 100 m on your right; the caller's camera said 7 m: the ears win
out.rightWant = {gain: r4(G.boomVol(100)), lp: r4(500 + 1800*(1 - 100/400)), start: r4(100/343)};
out.liveRight = S.state().live.blast.map(e => [r4(e.d), r4(e.until - now)]);
out.left = boomAt({x: 0, y: 0, z: -40}, 7, true);            // wet, on your left
out.leftWant = {gain: r4(G.boomVol(40)), start: r4(40/343)};
out.liveLeft = S.state().live.blast.map(e => r4(e.until - now));
out.far = boomAt({x: 0, y: 0, z: 450}, 7, false);             // past the blast kind's 400 m: nothing made
now += 10;
// the blast kind's 4 voices: a fifth farther than all of them is not heard, a nearer one takes the farthest's
[50, 60, 70, 80].forEach(d => G.boomAt(E, {x: d, y: 0, z: 0}, 0, false));
out.full = S.state().live.blast.length;
out.fifth = boomAt({x: 90, y: 0, z: 0}, 0, false).V;
out.steal = boomAt({x: 20, y: 0, z: 0}, 0, false).V;
out.afterSteal = S.state().live.blast.map(e => Math.round(e.d)).sort((a, b) => a - b);
now += 10;
E.listener(null);
out.noEars = boomAt({x: 0, y: 0, z: 100}, 50, false);         // no listener: centred, at the caller's distance
out.noEarsWant = {gain: r4(G.boomVol(50)), start: r4(50/343)};
E.listener({x: 0, y: 0, z: 0, yaw: Math.PI/2});
now += 10;
out.old = boomAt({x: 0, y: 0, z: 10}, 30, false, {audioOut: E.audioOut});   // an engine without spatialOut: audioOut
out.oldWant = {start: r4(30/343), gain: r4(G.boomVol(30))};
out.oldInto = (() => { const k = nodes.length; G.boomAt({audioOut: E.audioOut}, {x: 0, z: 10}, 30, false);
  return since(k).filter(n => n.kind === 'gain').some(n => n.out[0] === E.audioOut().out); })();
store.hq_sfx = '0'; now += 10;
out.muted = boomAt({x: 0, y: 0, z: 20}, 20, false);
store.hq_sfx = '0.5';
out.noE = G.boomAt(null, {x: 0, z: 10}, 10, false);
console.log(JSON.stringify(out));
"""

LIFT = LOAD + r"""
// the call shapes, through a stub engine
const calls = [], real = window.HQV.engine;
window.HQV.engine = {sfx: n => calls.push(['sfx', n]), sfxAt: (n, p, o) => calls.push(['at', n, p])};
function run(r){ let i = 0; while(!r.done() && i++ < 2000) r.update(0, 1/60, 1); }
const pad = {x: 24.5, z: 6.5};
run(F.liftArrival(null, {scene: {}, pad: pad}, {dir: 'down'})); out.carlift = calls.splice(0);
run(F.lobbyRide(null, {scene: {}})); out.lift = calls.splice(0);
run(F.lobbyRide(null, {scene: {}, liftDoor: {x: -31.7, z: 9}})); out.liftDoor = calls.splice(0);
run(F.liftArrival(null, null, {dir: 'down'})); out.noWorld = calls.splice(0);
F.valet('v1', 'basement'); out.valet = calls.splice(0);
window.HQV.engine = {sfx: n => calls.push(['sfx', n])};          // an engine without sfxAt: centred, as before
run(F.liftArrival(null, {scene: {}, pad: pad}, {dir: 'down'})); out.oldEngine = calls.splice(0);
// the real engine: the car lift's door heard near its pad (a door: 2 m reference, nothing past 40 m), its bell farther
window.HQV.engine = real; now = 50;
E.listener({x: 20, y: 1.6, z: 6.5, yaw: 0});
run(F.liftArrival(null, {scene: {}, pad: pad}, {dir: 'down'}));
const st = S.state().live; out.near = {door: (st.door || []).map(e => r4(e.d)), bell: (st.bell || []).map(e => r4(e.d))};
now = 100;
E.listener({x: 24.5, y: 1.6, z: 6.5 + 60, yaw: 0});
run(F.liftArrival(null, {scene: {}, pad: pad}, {dir: 'down'}));
const st2 = S.state().live; out.far = {door: (st2.door || []).length, bell: (st2.bell || []).map(e => Math.round(e.d))};
console.log(JSON.stringify(out));
"""


@unittest.skipUnless(NODE, "node is not installed")
class PeerVehicles(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.o = core.run(PEERS)

    def test_a_car_at_the_revs_it_sends(self):
        c = self.o["car"]
        self.assertEqual((c["sk"], c["voice"], c["rpm"], c["speed"]), ("peer", "turbo", 3200, 12))
        self.assertTrue(c["real"])                            # its real engine: set() takes real revs
        self.assertEqual((c["key"], c["id"], c["ex"]), ("car~", "u1|car~", None))
        self.assertEqual((c["x"], c["y"], c["z"]), (30, 2.8, -4))   # where they are drawn, at engine height
        g = self.o["carGuess"]
        self.assertAlmostEqual(g["rpm"], self.o["carWant"])   # nothing sent: a guess from their speed
        self.assertIsNone(self.o["carStill"])                 # standing, nothing sent: its engine is off
        self.assertEqual(self.o["carIdle"]["rpm"], 850)       # standing with revs sent: idling
        self.assertIsNone(self.o["noReal"]["real"])           # no real engine here: the game's revs
        self.assertAlmostEqual(self.o["noReal"]["rpm"], 900 + 6600*0.5)
        t = self.o["tuned"]
        self.assertEqual((t["ex"], t["key"], t["id"]), ("sport", "car~sport", "u1|car~sport"))   # its tuned exhaust, its own voice

    def test_every_vehicle_kind(self):
        o = self.o
        self.assertEqual((o["moto"]["sk"], o["moto"]["voice"], o["moto"]["rpm"]), ("peer", "bike", 9000))
        self.assertEqual((o["tank"]["sk"], o["tank"]["voice"]), ("peer", "diesel"))
        h = o["heli"]
        self.assertEqual((h["sk"], h["voice"], h["speed"]), ("heli", "rotor", 0))
        self.assertAlmostEqual(h["rpm"], 900 + 6700*(0.55 + 0.2*0.5))
        self.assertEqual(h["y"], 50.8)
        self.assertEqual((o["attack"]["sk"], o["attack"]["voice"]), ("heli", "rotor"))   # a rotor turns parked too
        self.assertEqual((o["prop"]["sk"], o["prop"]["voice"]), ("plane", "prop"))
        self.assertEqual(o["seaplane"]["voice"], "prop")
        self.assertAlmostEqual(o["seaplane"]["rpm"], 900 + 5600*0.3)
        a = o["airliner"]                                     # half its top speed: the levers at 0.3 + 0.6 * 0.5
        self.assertEqual((a["sk"], a["voice"]), ("plane", "jet"))
        self.assertAlmostEqual(a["rpm"], 900 + 6700*0.6)
        self.assertAlmostEqual(a["thr"], (0.6 - 0.12)/0.88)
        self.assertEqual(o["none"], [None, None, None, None])   # a bicycle, a pet, nothing known: no engine

    def test_pools_play_the_nearest_of_each_kind(self):
        o = self.o
        self.assertEqual(o["ids1"], {"peer": ["c0|car~", "c1|car~", "c2|car~"], "heli": ["h|heli~"], "plane": ["j|airliner~"]})
        self.assertEqual(o["state1"], {"peer": o["ids1"]["peer"], "heli": o["ids1"]["heli"], "peerplane": o["ids1"]["plane"]})
        self.assertEqual(sorted(o["made1"]), sorted([["turbo", None, True]]*3 + [["rotor", None, False], ["jet", None, False]]))
        kinds = {s[0]: s[2] for s in o["sets1"]}
        self.assertEqual(kinds, {"turbo": "peer", "rotor": "heli", "jet": "peerplane"})   # each heard as its own kind
        self.assertTrue(all(s[3] for s in o["sets1"]))       # ...from where it is
        self.assertIn(["turbo", 2500, "peer", True], o["sets1"])
        self.assertEqual(o["ids2"]["peer"], ["c0|car~", "c1|car~", "c3|car~"])
        self.assertEqual(o["made2"], 5)                       # c2's handle went to c3: nothing new made
        self.assertEqual(o["ids3"]["peer"][0], "c0|car~sport")
        self.assertEqual(o["made3"], [["turbo", "sport", True]])   # a changed vehicle: a voice of its own
        empty = {"peer": [], "heli": [], "plane": []}
        self.assertEqual(o["muted"], empty)                   # sfx volume 0 (Calm, mute): nothing plays
        self.assertEqual(o["noEars"], empty)                  # no listener (a paused view): nothing placed
        self.assertEqual(o["ambient0"]["plane"], ["j|airliner~"])   # Ambient sounds 0% never mutes someone's plane
        self.assertEqual(o["stopped"], {})                    # stop(): no pool left behind
        self.assertEqual(o["noPools"], [None, None, None])    # an engine without pools: none


@unittest.skipUnless(NODE, "node is not installed")
class GrenadeBoom(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.o = core.run(BOOM)

    def test_placed_and_panned_at_the_ears_distance(self):
        r, w = self.o["right"], self.o["rightWant"]
        self.assertTrue(r["V"] and r["toVoice"])              # the boom goes into its spatial voice
        self.assertEqual(r["voice"], 1)                       # the blast kind keeps the boom's own curve: pan only
        self.assertGreater(r["pan"], 0.5)                     # on your right: right
        self.assertEqual(r["delay"], 0)                       # the voice adds no delay...
        self.assertAlmostEqual(r["start"], w["start"])        # ...the boom waits for its sound to travel, once
        self.assertAlmostEqual(r["gain"], w["gain"])          # boomVol at the ears' 100 m, not the caller's 7
        self.assertAlmostEqual(r["lp"], w["lp"])
        self.assertEqual(r["d"], 100)
        self.assertEqual(self.o["liveRight"], [[100, round(100/343 + 1.5, 4)]])   # its voice held while it sounds
        l, lw = self.o["left"], self.o["leftWant"]
        self.assertLess(l["pan"], -0.5)
        self.assertAlmostEqual(l["gain"], lw["gain"])
        self.assertAlmostEqual(l["start"], lw["start"])
        self.assertEqual((l["rate"], l["lp"]), (0.6, 380))    # under water: lower, duller
        self.assertIn(round(40/343 + 2.4, 4), self.o["liveLeft"])   # and longer
        self.assertFalse(self.o["far"]["V"])                  # past 400 m: not heard...
        self.assertEqual(self.o["far"]["made"], 0)            # ...and nothing made

    def test_the_blast_kinds_voice_limit(self):
        self.assertEqual(self.o["full"], 4)
        self.assertFalse(self.o["fifth"])                     # farther than all 4: not heard
        self.assertTrue(self.o["steal"])                      # nearer: takes the farthest's voice
        self.assertEqual(self.o["afterSteal"], [20, 50, 60, 70])

    def test_without_ears_without_spatial_and_muted(self):
        n, w = self.o["noEars"], self.o["noEarsWant"]
        self.assertTrue(n["V"])
        self.assertEqual(n["pan"], 0)                         # no listener: centred...
        self.assertAlmostEqual(n["gain"], w["gain"])          # ...at the caller's distance
        self.assertAlmostEqual(n["start"], w["start"])
        o, ow = self.o["old"], self.o["oldWant"]
        self.assertTrue(o["V"])                               # an older engine: audioOut(), centred
        self.assertIsNone(o["pan"])
        self.assertAlmostEqual(o["start"], ow["start"])
        self.assertAlmostEqual(o["gain"], ow["gain"])
        self.assertTrue(self.o["oldInto"])
        self.assertFalse(self.o["muted"]["V"])                # sfx volume 0: silent, nothing made
        self.assertEqual(self.o["muted"]["made"], 0)
        self.assertIsNone(self.o["noE"])


@unittest.skipUnless(NODE, "node is not installed")
class LiftSounds(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.o = core.run(LIFT)

    def test_the_car_lift_and_its_bell_at_the_pad(self):
        at = {"x": 24.5, "y": 1.2, "z": 6.5}
        self.assertEqual(self.o["carlift"], [["at", "door", at], ["at", "bell", at]])
        self.assertEqual(self.o["oldEngine"], [["sfx", "door"], ["sfx", "bell"]])   # no sfxAt: centred, as before
        self.assertEqual(self.o["noWorld"], [["sfx", "door"], ["sfx", "bell"]])     # no world: nowhere to place it

    def test_the_person_lift(self):
        self.assertEqual(self.o["lift"], [["sfx", "ui"], ["sfx", "bell"]])           # its doors unknown: centred
        self.assertEqual(self.o["liftDoor"], [["sfx", "ui"], ["at", "bell", {"x": -31.7, "y": 1.2, "z": 9}]])
        self.assertEqual(self.o["valet"], [["sfx", "ui"]])                            # the valet's toast is UI

    def test_heard_by_distance(self):
        self.assertEqual(self.o["near"]["door"], [round(((24.5 - 20)**2 + 0.4**2) ** 0.5, 4)])
        self.assertEqual(len(self.o["near"]["bell"]), 1)
        self.assertEqual(self.o["far"]["door"], 0)            # 60 m: past a door's 40 m
        self.assertEqual(self.o["far"]["bell"], [60])         # a bell carries


class Hq3dWiring(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.hq = read("games", "hq3d.js")

    def test_own_engines_are_own_at_you(self):
        hq = self.hq
        for fn in ("engineStep", "engineReal", "gearboxSound", "heliMove"):
            self.assertIn('pos: ownAt(), sk: "own"}', func_body(hq, fn), fn)
        self.assertEqual(func_body(hq, "planeMove").count('pos: ownAt(), sk: "own"}'), 2)
        self.assertIn("E.listener(curCam(), earAt(curCam()), ownRef());", func_body(hq, "frame"))   # how far your own things carry

    @unittest.skipUnless(NODE, "node is not installed")
    def test_own_vehicle_fades_only_from_a_detached_camera(self):
        # ownAt / ownRef as hq3d.js has them, run with camrig.js's real tables: Infinity (no distance loss) while the
        # camera rides with you; from photo, cine and the Map the far chase camera's reach for the vehicle
        hq = self.hq
        i = hq.index("  function ownAt(){")
        j = hq.index("  function ownRef(){")
        block = hq[i:j] + "  " + func_body(hq, "ownRef") + "\n"     # ownAt, OWN_DETACHED and ownRef
        js = r"""
const fs = require("fs"); global.window = {HQV: {}};
new Function(fs.readFileSync(%(cam)s, "utf8"))();
const HQV = window.HQV, E = {clamp: (v, a, b) => v < a ? a : v > b ? b : v};
let rig = null, cur = {camModes: true}, ride = null, avatar = {x: 5, hy: 300, z: -7}, held = false;
function rigOn(){ return !!(rig && cur && cur.camModes); }
function tripHeld(){ return held && rigOn(); }
%(block)s
const out = {};
const at = (mode, r) => { rig = mode ? {mode} : null; ride = r; return {ref: ownRef(), at: ownAt()}; };
held = true; out.riding = ["photo", "cine", "map"].map(m => at(m, null).ref); held = false;
out.noRig = at(null, {base: "car", V: {size: 1}});
["far", "chase", "near", "fp", "classic", "selfie"].forEach(m => { out[m] = at(m, {base: "car", V: {size: 1}}).ref; });
out.car = ["photo", "cine", "map"].map(m => at(m, {base: "car", V: {size: 1}}).ref);
out.airliner = at("photo", {base: "airliner", V: {size: 1}}).ref;
out.longCar = at("photo", {base: "car", V: {size: 2}}).ref;
out.unknown = at("photo", {kind: "hoverboard", V: {}}).ref;
out.onFoot = at("photo", null).ref;
out.map = at("map", {base: "airliner", V: {}}).at;
out.chaseAt = at("chase", {base: "airliner", V: {}}).at;
console.log(JSON.stringify(out, (k, v) => v === Infinity ? "inf" : v));
""" % {"cam": json.dumps(os.path.join(ROOT, "games", "camrig.js")), "block": block}
        r = subprocess.run([NODE, "-e", js], capture_output=True, text=True, timeout=60)
        self.assertEqual(r.returncode, 0, r.stderr[-3000:])
        o = json.loads(r.stdout.strip().splitlines()[-1])
        self.assertEqual(o["noRig"]["ref"], "inf")             # the Base, the Lobby: Classic's ears at you
        for m in ("far", "chase", "near", "fp", "classic", "selfie"):
            self.assertEqual(o[m], "inf", m)                   # the camera rides with it: no distance loss
        car = (15 * 1.35) ** 2 + (9 * 0.85) ** 2
        for v in o["car"]:
            self.assertAlmostEqual(v, car ** 0.5, places=6)    # detached: the far chase camera's reach (21.6 m)
        self.assertAlmostEqual(o["airliner"], ((15 * 7) ** 2 + (9 * 3.2) ** 2) ** 0.5, places=6)   # 108.9 m
        self.assertAlmostEqual(o["longCar"], ((15 * 1.35 * 1.5) ** 2 + (9 * 0.85) ** 2) ** 0.5, places=6)
        self.assertAlmostEqual(o["unknown"], (15 ** 2 + 9 ** 2) ** 0.5, places=6)   # a kind camrig does not know: its default
        self.assertAlmostEqual(o["onFoot"], (15 ** 2 + 9 ** 2) ** 0.5, places=6)
        self.assertEqual(o["map"], {"x": 5, "z": -7})          # the Map: along the ground (a plane up high still heard)
        self.assertEqual(o["chaseAt"], {"x": 5, "y": 300.8, "z": -7})
        # a ride's seat, window or chase camera holds the shot (tripCam) and rides with you, whatever the rig's mode
        # under it: 45 s without input starts the idle fly-by (cine) beneath a ride, and your doors must not fade
        self.assertEqual(o["riding"], ["inf", "inf", "inf"])

    def test_peers_are_heard(self):
        hq = self.hq
        fr = func_body(hq, "frame")
        self.assertLess(fr.index("E.listener(curCam()"), fr.index("peerSounds();"))     # this frame's ears
        self.assertLess(fr.index("placePeers(dt, t);"), fr.index("peerSounds();"))      # where they are drawn now
        ps = func_body(hq, "peerSounds")
        for k in ("HQV.hq3dPure.peerPools(E)", "P.g.parent !== cur.scene", "engineOf(V, baseKind(P.vk))",
                  "HQV.hq3dPure.peerSound(u, P, V, EN)", "PSND.update(list)"):
            self.assertIn(k, ps, k)
        self.assertIn("P.vk = vk; P.ex = ptn && HQV.hqTuning.exhaustOf ? HQV.hqTuning.exhaustOf(ptn) : null;", func_body(hq, "placePeers"))
        pause = hq[hq.index("  inst.pause = function(){"):hq.index("  inst.resume = function(){")]
        self.assertIn("peerSoundsOff();", pause)                # a paused or closed view lets every voice go
        self.assertIn("if(cur && cur.soundPause){ try { cur.soundPause(); } catch(e){} }", pause)   # its floor's too
        self.assertIn('plane: mk("peerplane", 1)', func_body(hq, "peerPools"))
        self.assertIn("(base || (ride && ride.base)) === \"moto\"", func_body(hq, "engineOf"))   # safe for someone else's

    def test_blasts_and_shots_are_placed(self):
        hq = self.hq
        bl = func_body(hq, "gnBlast")
        self.assertIn("H.boomAt(E, {x: b.x, y: b.y, z: b.z}, d, b.wet);", bl)
        self.assertNotIn("H.boom(", bl)
        self.assertIn("gnShotSound(o);", func_body(hq, "gnSeen"))
        sh = func_body(hq, "gnShotSound")
        self.assertIn("!(o.age < 0.5)", sh)
        self.assertIn('E.sfxAt("shot", {x: o.x, y: o.y, z: o.z}, {kind: "blast", curve: true, delay: Math.max(0, d/343 - o.age)});', sh)

    def test_pins_kept(self):
        hq = self.hq
        for pin in ('E.sfx("door")', 'E.sfx("crank")', 'E.sfx("horn"', "sfx: phoneSfx",
                    "E.engineSound(V.eng, ride.tune && HQV.hqTuning ? HQV.hqTuning.exhaustOf(ride.tune) : null)",
                    "if(E.listener) E.listener(curCam(), earAt(curCam()), ownRef());", "if(E.listener) E.listener(null);"):
            self.assertIn(pin, hq, pin)

    def test_ui_sounds_stay_centred(self):
        # the phone's ring and dial, the gallery's shutter and the casino's tones are UI: never placed
        for f in ("hqphonecomms.js", "hqgallery.js", "hqcasino.js", "hqcasinoui.js"):
            src = read("games", f)
            for k in ("spatialOut", "sfxAt", "E.pool"):
                self.assertNotIn(k, src, f + ": " + k)
        self.assertIn("function phoneSfx(n, o){", self.hq)
        for f in ("hqgrenade.js", "hqbasementfx.js"):
            self.assertNotIn("Math.random", read("games", f), f)


if __name__ == "__main__":
    unittest.main()
