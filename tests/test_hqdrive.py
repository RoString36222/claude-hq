"""games/hqdrive.js (HQ 3.12): driving feel and convoys, the pure half run under node.

Lights by night and weather, tyre grip per weather, cosmetic damage (accumulate, persist, repair), and the convoy
maths (slots, the assist, invitations); plus the wiring that gates convoys on the Arena's "convoy" capability.
"""
import json
import os
import re
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")
SCRIPT = r"""
const fs = require('fs'), path = require('path'), R0 = process.argv[1];
const mem = {};
global.window = {HQV: {}, localStorage: {getItem: k => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }}};
eval(fs.readFileSync(path.join(R0, 'games', 'hqweather.js'), 'utf8'));
eval(fs.readFileSync(path.join(R0, 'games', 'hqdrive.js'), 'utf8'));
const D = window.HQV.hqDrive, W = window.HQV.hqWeather, out = {};
// lights
const kinds = ['clear', 'cloudy', 'rain', 'storm', 'snow', 'fog'];
out.lightsDay = {}; out.lightsNight = {};
kinds.forEach(k => { out.lightsDay[k] = D.lightsAuto(false, D.wxOf(k)); out.lightsNight[k] = D.lightsAuto(true, D.wxOf(k)); });
out.manual = [D.lightsOn(false, D.wxOf('clear'), true), D.lightsOn(true, D.wxOf('storm'), false), D.lightsOn(true, D.wxOf('clear'), null)];
// the fallback numbers agree with the weather's own table
out.wxSync = kinds.every(k => ['rain', 'snow', 'storm', 'fogFar'].every(f => D.WX[k][f] === W.LOOK[k][f]));
const half = D.wxEase(D.wxOf('clear'), D.wxOf('rain'), 0.5); out.ease = [half.rain, D.wxEase(D.wxOf('clear'), D.wxOf('rain'), 1).rain];
// grip
out.grip = {};
['car', 'moto', 'bike'].forEach(b => { out.grip[b] = {}; kinds.forEach(k => { out.grip[b][k] = D.gripOf(D.wxOf(k), b); }); });
const S = {min: 7, turn: 1.3, grip: 2.2, max: 0.62, bleed: 3.4}, S0 = JSON.stringify(S);
out.slideDry = D.slideOf(S, D.gripOf(D.wxOf('clear'), 'car')) === S;
out.slideWet = D.slideOf(S, D.gripOf(D.wxOf('storm'), 'car')); out.slideKept = JSON.stringify(S) === S0;
// damage
out.below = D.dmgAdd(null, 5.9, 'f');
let st = D.dmgNew(); const steps = [];
for (let i = 0; i < 8; i++) { st = D.dmgAdd(st, 16, i < 4 ? 'f' : 'r'); steps.push(st.d); }
out.steps = steps; out.final = st; out.cracked = D.dmgCracked(st); out.smoke = D.dmgSmoke(st);
out.light = [D.dmgCracked(D.dmgAdd(null, 9, 'f')), D.dmgSmoke(D.dmgAdd(null, 9, 'f'))];
out.pull = [D.dmgPull(D.dmgNew(), 'k'), Math.abs(D.dmgPull(st, 'own:1')), D.dmgPull(st, 'own:1') === D.dmgPull(st, 'own:1')];
out.saved = D.dmgSave('own:abc', st); out.loaded = D.dmgLoad('own:abc'); out.other = D.dmgLoad('own:zzz').d;
out.badKey = [D.dmgSave('../x y', st), D.dmgLoad('../x y').d];
D.dmgSave('kind:car', D.dmgAdd(null, 12, 'r'));
out.repairOne = [D.dmgRepair('own:abc'), D.dmgLoad('own:abc').d, D.dmgLoad('kind:car').d > 0, D.dmgRepair('own:abc')];
out.repairAll = [D.dmgRepairAll(), D.dmgLoad('kind:car').d];
for (let i = 0; i < 50; i++) D.dmgSave('v' + i, D.dmgAdd(null, 10, 'f'));
out.kept = Object.keys(JSON.parse(mem[D.DMG_LS])).length; out.newest = D.dmgLoad('v49').d > 0; out.oldest = D.dmgLoad('v0').d;
out.junk = (mem[D.DMG_LS] = '{nope', D.dmgLoad('v49').d);
// convoy slots: forward is +z at yaw 0, model-local +x is left
out.slots = [0, 1, 2, 3].map(i => D.slotOf(i, false)); out.air = D.slotOf(0, true);
const L = {x: 10, z: 20, yaw: 0, vx: 0, vz: 0};
out.p0 = D.slotPoint(L, D.slotOf(0)); out.p1 = D.slotPoint(L, D.slotOf(1));
out.pTurned = D.slotPoint({x: 0, z: 0, yaw: Math.PI/2}, D.slotOf(0));
out.pLead = D.slotPoint({x: 0, z: 0, yaw: 0, vx: 0, vz: 10}, D.slotOf(0), 0.5);
// the assist: slot ahead-left -> steer left (> 0) and throttle; sitting in it with the leader parked -> brake to 0
const moving = {x: 0, z: 60, yaw: 0, vx: 0, vz: 12};
out.aBehind = D.assist({x: 0, z: 0, yaw: 0, speed: 5}, moving, D.slotOf(0), false);
out.aRight = D.assist({x: -4, z: 50, yaw: 0, speed: 12}, moving, D.slotOf(0), false);
const sp = D.slotPoint({x: 0, z: 0, yaw: 0}, D.slotOf(0), 0.25);
out.aIn = D.assist({x: sp.x, z: sp.z, yaw: 0, speed: 3}, {x: 0, z: 0, yaw: 0}, D.slotOf(0), false);
out.followers = D.followersOf([{u: 'b', cv: 'L'}, {u: 'a', cv: 'L'}, {u: 'c', cv: 'X'}], 'L', 'me', 'L');
// invitations: A (me) invites B; B accepts (cv = A); A sees B join; B leaves when too far
const A = D.convoyNew(), B = D.convoyNew();
const near = {x: 0, z: 0};
let r = D.convoyKey(A, {me: 'A', peers: [{u: 'B', n: 'Bo', w: 'w', x: 30, z: 0}, {u: 'C', n: 'Cy', w: 'w', x: 55, z: 0}], world: 'w', pos: near, now: 1});
out.inv = [r.t, r.u, JSON.stringify(D.convoyNet(A, {}))];
out.none = D.convoyKey(D.convoyNew(), {me: 'A', peers: [{u: 'C', w: 'w', x: 55, z: 0}], world: 'w', pos: near, now: 1}).t;
out.otherWorld = D.convoyKey(D.convoyNew(), {me: 'A', peers: [{u: 'B', w: 'v', x: 1, z: 0}], world: 'w', pos: near, now: 1}).t;
let ev = D.convoyStep(B, {me: 'B', peers: [{u: 'A', n: 'Al', w: 'w', x: 0, z: 0, ci: 'B'}], world: 'w', pos: {x: 30, z: 0}, now: 2});
out.bInvited = [ev.map(e => e.t).join(','), B.pending];
r = D.convoyKey(B, {me: 'B', peers: [{u: 'A', n: 'Al', w: 'w', x: 0, z: 0, ci: 'B'}], world: 'w', pos: {x: 30, z: 0}, now: 3});
out.bJoin = [r.t, B.lead, JSON.stringify(D.convoyNet(B, {}))];
ev = D.convoyStep(A, {me: 'A', peers: [{u: 'B', n: 'Bo', w: 'w', x: 30, z: 0, cv: 'A'}], world: 'w', pos: near, now: 4});
out.aJoined = [ev.map(e => e.t).join(','), A.role, A.members.join(','), A.invite];
out.aRoute = JSON.stringify(D.convoyNet(A, {route: {x: 100.4, z: -2000}}));
ev = D.convoyStep(B, {me: 'B', peers: [{u: 'A', n: 'Al', w: 'w', x: 0, z: 0}], world: 'w', pos: {x: 30, z: 0}, now: 5});
out.bRole = [B.role, B.members.join(',')];
ev = D.convoyStep(B, {me: 'B', peers: [{u: 'A', n: 'Al', w: 'w', x: 0, z: 0}], world: 'w', pos: {x: 500, z: 0}, now: 6});
out.bFar = [ev.map(e => e.t + ':' + e.why).join(','), B.lead];
const B2 = D.convoyNew(); B2.lead = 'A';
out.bWorld = D.convoyStep(B2, {me: 'B', peers: [{u: 'A', w: 'v', x: 0, z: 0}], world: 'w', pos: near, now: 1}).map(e => e.why).join(',');
const B3 = D.convoyNew(); B3.lead = 'A';
out.bKey = D.convoyKey(B3, {me: 'B', peers: [{u: 'A', w: 'w', x: 0, z: 0}], world: 'w', pos: near, now: 1}).t + ':' + B3.lead;
const A2 = D.convoyNew(); A2.invite = 'B'; A2.invAt = 0;
D.convoyStep(A2, {me: 'A', peers: [{u: 'B', w: 'w', x: 1, z: 0}], world: 'w', pos: near, now: D.INVITE_TTL + 1});
out.expired = A2.invite;
console.log(JSON.stringify(out));
"""


def run():
    return json.loads(subprocess.check_output([NODE, "-e", SCRIPT, ROOT], text=True))


def read(*p):
    with open(os.path.join(ROOT, *p), encoding="utf-8") as f:
        return f.read()


@unittest.skipUnless(NODE, "node is not installed")
class DriveTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.o = run()

    def test_lights_come_on_at_night_and_in_heavy_weather(self):
        o = self.o
        self.assertTrue(all(o["lightsNight"].values()))
        self.assertEqual({k for k, v in o["lightsDay"].items() if v}, {"rain", "storm", "snow", "fog"})
        self.assertEqual(o["manual"], [True, False, True])            # L wins either way; null is automatic
        self.assertTrue(o["wxSync"])
        self.assertAlmostEqual(o["ease"][0], 0.35)
        self.assertAlmostEqual(o["ease"][1], 0.7)

    def test_grip_per_weather(self):
        g = self.o["grip"]
        for b in ("car", "moto", "bike"):
            self.assertEqual((g[b]["clear"]["lat"], g[b]["clear"]["brake"], g[b]["clear"]["kind"]), (1, 1, None))
            self.assertEqual(g[b]["fog"]["lat"], 1)
            self.assertLess(g[b]["rain"]["lat"], 1)
            self.assertLess(g[b]["storm"]["lat"], g[b]["rain"]["lat"])
            self.assertLess(g[b]["snow"]["lat"], g[b]["storm"]["lat"])
            self.assertLess(g[b]["snow"]["brake"], g[b]["rain"]["brake"])
            self.assertGreaterEqual(min(g[b][k]["lat"] for k in g[b]), 0.45)   # still fun
            self.assertEqual((g[b]["rain"]["kind"], g[b]["snow"]["kind"]), ("wet", "snow"))
        # two wheels lose more and ride more carefully; a car keeps its top speed in the rain
        self.assertLess(g["moto"]["storm"]["lat"], g["car"]["storm"]["lat"])
        self.assertLess(g["bike"]["snow"]["top"], 1)
        self.assertEqual(g["car"]["rain"]["top"], 1)
        # noticeable: a storm brakes at least a quarter worse
        self.assertLess(g["car"]["storm"]["brake"], 0.75)

    def test_a_wet_powerslide_comes_easier_and_lasts_longer(self):
        o = self.o
        self.assertTrue(o["slideDry"])
        w = o["slideWet"]
        self.assertLess(w["min"], 7)
        self.assertLess(w["grip"], 2.2)
        self.assertGreater(w["max"], 0.62)
        self.assertTrue(o["slideKept"])

    def test_damage_accumulates_and_marks(self):
        o = self.o
        self.assertEqual(o["below"]["d"], 0)
        self.assertEqual(o["below"]["n"], 0)
        s = o["steps"]
        self.assertTrue(all(b > a for a, b in zip(s, s[1:]) if a < 1))
        self.assertEqual(s[-1], 1)                                     # capped
        self.assertEqual(o["final"]["n"], 8)
        self.assertLessEqual(len(o["final"]["hits"]), 12)
        self.assertTrue(o["cracked"])
        self.assertTrue(o["smoke"])
        self.assertEqual(o["light"], [False, False])                   # one light knock: nothing cracked, no smoke
        self.assertEqual(o["pull"][0], 0)
        self.assertGreater(o["pull"][1], 0)
        self.assertTrue(o["pull"][2])

    def test_damage_persists_per_vehicle_and_the_garage_repairs_it(self):
        o = self.o
        self.assertTrue(o["saved"])
        self.assertEqual(o["loaded"]["d"], o["final"]["d"])
        self.assertEqual(o["other"], 0)
        self.assertEqual(o["badKey"], [False, 0])
        self.assertEqual(o["repairOne"], [True, 0, True, False])
        self.assertEqual(o["repairAll"], [1, 0])
        self.assertEqual(o["kept"], 40)
        self.assertTrue(o["newest"])
        self.assertEqual(o["oldest"], 0)
        self.assertEqual(o["junk"], 0)                                 # a broken store is no damage, not an error

    def test_convoy_slots(self):
        o = self.o
        s = o["slots"]
        self.assertGreater(s[0]["side"], 0)                            # behind-left
        self.assertLess(s[1]["side"], 0)                               # behind-right
        self.assertEqual(s[0]["back"], s[1]["back"])
        self.assertGreater(s[2]["back"], s[0]["back"])                 # the next row back
        self.assertGreater(o["air"]["back"], s[0]["back"])
        self.assertGreater(o["air"]["up"], 0)
        self.assertAlmostEqual(o["p0"]["x"], 12.6)
        self.assertAlmostEqual(o["p0"]["z"], 12)
        self.assertAlmostEqual(o["p1"]["x"], 7.4)
        self.assertAlmostEqual(o["pTurned"]["x"], -8, places=6)        # facing +x: behind is -x
        self.assertAlmostEqual(o["pTurned"]["z"], -2.6, places=6)
        self.assertAlmostEqual(o["pLead"]["z"], -3)                    # carried 0.5 s along the leader's velocity

    def test_convoy_assist(self):
        o = self.o
        b, r, i = o["aBehind"], o["aRight"], o["aIn"]
        self.assertGreater(b["thr"], 0)
        self.assertGreater(b["along"], 0)
        self.assertFalse(b["ok"])
        self.assertGreater(r["steer"], 0)                              # you are right of the slot (-x): steer left
        self.assertTrue(i["ok"])
        self.assertLess(i["thr"], 0)                                   # leader parked, you are there: slow down
        for a in (b, r, i):
            self.assertLessEqual(abs(a["steer"]), 1)
            self.assertLessEqual(abs(a["thr"]), 1)
        self.assertEqual(o["followers"], ["a", "b", "me"])

    def test_convoy_invite_accept_leave(self):
        o = self.o
        self.assertEqual(o["inv"], ["invited", "B", '{"ci":"B"}'])     # the nearest within 40 m
        self.assertEqual(o["none"], "none")
        self.assertEqual(o["otherWorld"], "none")
        self.assertEqual(o["bInvited"], ["invited", "A"])
        self.assertEqual(o["bJoin"], ["joined", "A", '{"cv":"A"}'])
        self.assertEqual(o["aJoined"], ["joined", "lead", "A,B", None])
        self.assertEqual(o["aRoute"], '{"cg":[10040,-102400]}')        # the route rides along, clamped to the map
        self.assertEqual(o["bRole"], ["follow", "A,B"])
        self.assertEqual(o["bFar"], ["left:far", None])
        self.assertEqual(o["bWorld"], "world")
        self.assertEqual(o["bKey"], "left:null")
        self.assertIsNone(o["expired"])

    def test_convoys_are_gated_on_the_arenas_capability(self):
        hq3d, ui, proto = read("games", "hq3d.js"), read("ui", "app", "22-hq.js"), read("backend", "src", "protocol.rs")
        self.assertIn('api.netCan && api.netCan("convoy")', hq3d)
        self.assertIn('var cv = hqNetCan("convoy") && HQ3D.inst.convoyNet ? HQ3D.inst.convoyNet() : null;', ui)
        self.assertIn("msg.bb,msg.bt,msg.ci,msg.cv,msg.cg,msg.vt,JSON.stringify(msg.pt||0),msg.vx,msg.vz,msg.yr,msg.rpm].join", ui)  # in the dedupe key
        self.assertRegex(proto, r'\("hq", 4, &\[[^\]]*"convoy"[^\]]*\]')   # (later caps may follow: "hqstyle")
        # convoyCan (the Here now button) and convoyNet go through cvOn(), which checks the capability
        self.assertRegex(hq3d, r"inst\.convoyNet = function\(\)\{\s*var D = Drv\(\); if\(!D \|\| !DRV\.C \|\| !cvOn\(\)\) return null;")
        self.assertIn("if(!D || !cvOn() || !avatar", hq3d)
        self.assertIn('"hqdrive"', ui)

    def test_wiring(self):
        src = read("games", "hq3d.js")
        self.assertIn("drvMount();", src)
        self.assertIn("drvDismount();", src)
        self.assertIn('if(d) drvHit(ride.speed, d > 0 ? "f" : "r");', src)
        self.assertIn("(V.brake || 14)*G.brake", src)
        self.assertIn("ease(7*G.lat, dt)", src)
        self.assertIn('drvRepair(null, "at the garage")', src)
        self.assertIn('drvRepair(null, "at the dealership")', src)
        self.assertIn('drvRepair(rk, "in your B1 garage")', src)
        self.assertIn("if(drvKey(e)) return;", src)
        for kind in ("bike", "moto", "car"):
            self.assertRegex(src, kind + r': "[^"]*L lights')
        css = read("games", "games.css")
        self.assertIn(".hq3d-convoy{", css)
        self.assertNotRegex(css[css.index("HQ 3.12"):css.index(".hq3d-convoy-k")], r"#[0-9a-fA-F]{3,6}\b")   # tokens only


THREE_SCRIPT = r"""
const fs = require('fs'), path = require('path'), url = require('url'), root = process.argv[1];
const grad = {addColorStop(){}};
const ctx2d = {createRadialGradient: () => grad, createLinearGradient: () => grad, fillRect(){}, set fillStyle(v){}};
global.window = {HQV: {}, document: {createElement: () => ({width: 0, height: 0, getContext: () => ctx2d})}};
import(url.pathToFileURL(root + "/games/vendor/three-module.js").href).then(function(T){
  eval(fs.readFileSync(path.join(root, 'games', 'hqdrive.js'), 'utf8'));
  const D = window.HQV.hqDrive, out = {};
  // a stand-in car: a body panel (painted) 1.8 wide, 1.2 tall, 4 long, its geometry shared like a blueprint's
  const shared = new T.BoxGeometry(1.8, 1.2, 4, 6, 4, 12), paint = new T.MeshStandardMaterial({roughness: 0.3, metalness: 0.55});
  const g = new T.Group(), body = new T.Mesh(shared, paint); body.position.y = 0.7; body.userData.mk = 'paint'; g.add(body);
  const rig = {g: g, paint: paint, lights: function(on, cr){ out.rigLights = [on, cr]; }};
  const before = Float32Array.from(shared.attributes.position.array);
  let st = D.dmgAdd(D.dmgAdd(null, 18, 'f'), 18, 'f');
  out.dented = D.dent(T, rig, st, 'own:x');
  const A = body.geometry.attributes.position.array;
  let frontMoved = 0, rearMoved = 0;
  for (let i = 0; i < A.length; i += 3) {
    const dz = A[i + 2] - before[i + 2];
    if (before[i + 2] > 1.9 && dz < -0.01) frontMoved++;
    if (before[i + 2] < -1.9 && Math.abs(dz) > 1e-6) rearMoved++;
  }
  out.frontMoved = frontMoved; out.rearMoved = rearMoved;
  out.sharedUntouched = shared.attributes.position.array.every((v, i) => v === before[i]);
  out.cloned = body.geometry !== shared;
  out.rough = paint.roughness > 0.3;
  out.again = D.dent(T, rig, st, 'own:x');                    // the same damage: nothing to do
  D.undent(rig);
  out.restored = body.geometry.attributes.position.array.every((v, i) => v === before[i]) && paint.roughness === 0.3;
  // the beam: one mesh on the rig, hidden until the lights come on, ahead of the nose
  const b = D.beam(T, rig, {base: 'car'});
  out.beam = [rig.g.children.indexOf(b) >= 0, b.visible, D.beam(T, rig, {base: 'car'}) === b];
  D.lights(rig, true, false, 0, false); out.on = [b.visible, out.rigLights];
  b.geometry.computeBoundingBox(); out.ahead = b.geometry.boundingBox.min.z > 1.9;
  D.lights(rig, false, false, 0, false); out.off = b.visible;
  // spray and smoke: particles only in the rain at speed / when smoking, none in Calm
  const scene = new T.Scene(), fx = D.fx(T, scene, 32);
  out.dry = fx.step(0.05, {x: 0, z: 0, yaw: 0, speed: 20, rain: 0});
  let wet = 0; for (let i = 0; i < 10; i++) wet = fx.step(0.03, {x: 0, z: 0, yaw: 0, speed: 20, rain: 1});
  out.wet = wet; out.visible = fx.pts.visible;
  fx.clear(); let calm = 0; for (let i = 0; i < 10; i++) calm = fx.step(0.03, {x: 0, z: 0, yaw: 0, speed: 20, rain: 1, smoke: true, calm: true});
  out.calm = calm;
  let sm = 0; for (let i = 0; i < 20; i++) sm = fx.step(0.05, {x: 0, z: 0, yaw: 0, speed: 0, rain: 0, smoke: true});
  out.smoke = sm;
  fx.dispose(); out.disposed = scene.children.length;
  console.log(JSON.stringify(out));
}).catch(function(e){ console.error(e); process.exit(1); });
"""


@unittest.skipUnless(NODE, "node is not installed")
class DrawTests(unittest.TestCase):
    """The drawing half against the vendored three.js (no renderer): dents, the beam, spray and smoke."""

    @classmethod
    def setUpClass(cls):
        cls.o = json.loads(subprocess.check_output([NODE, "-e", THREE_SCRIPT, ROOT], text=True))

    def test_dents_push_in_where_it_hit_and_the_garage_takes_them_out(self):
        o = self.o
        self.assertTrue(o["dented"])
        self.assertGreater(o["frontMoved"], 3)
        self.assertEqual(o["rearMoved"], 0)
        self.assertTrue(o["sharedUntouched"])                       # the blueprint's geometry is never bent
        self.assertTrue(o["cloned"])
        self.assertTrue(o["rough"])
        self.assertFalse(o["again"])
        self.assertTrue(o["restored"])

    def test_the_beam_and_the_lamps(self):
        o = self.o
        self.assertEqual(o["beam"], [True, False, True])
        self.assertEqual(o["on"], [True, [True, False]])
        self.assertTrue(o["ahead"])
        self.assertFalse(o["off"])

    def test_spray_and_smoke(self):
        o = self.o
        self.assertEqual(o["dry"], 0)
        self.assertGreater(o["wet"], 0)
        self.assertTrue(o["visible"])
        self.assertEqual(o["calm"], 0)
        self.assertGreater(o["smoke"], 0)
        self.assertEqual(o["disposed"], 0)


if __name__ == "__main__":
    unittest.main()
