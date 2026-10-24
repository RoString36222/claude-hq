"""HQ 3.15 integration: games/hqcity3d.js wiring every transport part through games/hqtransit.js, on the generated
@3 Commons (tests/fixtures/claude-hq@3.json.gz, written by tools/world_fixture.py --v3).

The City is built under node with the vendored three.js and the same stub hq3d ctx, worldbuild, DOM and Arena as
tests/test_cities.py (its harness, reused), plus every transport module. It checks what the integration promises
(docs/plans/transport-revamp.md section 7): the live id @3 and its /assign fallback, every Service registered with
hqRide (bus, tram, metro, rail, gondola, ferry), the views built, E at a stop opening the free board menu, a whole bus
ride through the hqRide session (walk, wait, board, seated with the "sit" carry and the seat camera, off at the stop),
S and V while riding, E at a metro entrance taking you below the street (HQV.hqUnderground: the surface hidden, the
dark fog, the metro's floors as the ground), E on the platform offering the way out, a peer seated in a vehicle
(presence a = 14), the draw-call sums, and a destroyed City restoring everything. Skipped without node or fixture."""
import json
import os
import shutil
import subprocess
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import test_cities  # noqa: E402  (its harness: the stub ctx, DOM and Arena)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIX = os.path.join(ROOT, "tests", "fixtures")
COMMONS3 = os.path.join(FIX, "claude-hq@3.json.gz")
NODE = shutil.which("node")
ME = test_cities.ME

TRANSIT = ["hqride", "hqcommute", "hqweather", "hqrail", "hqtramway", "hqcoach", "hqmetro", "hqunderground", "hqcityrail", "hqgondola",
           "hqferries", "hqheli", "hqcall", "hqcabs", "hqhelicall", "hqtransit"]

BODY = r"""
DOCS["claude-hq@3"] = WD.pack(gz(%(commons3)s));
HQV.engine = {audioOut(){ return null; }};
// hq3d's teleport lands you on the level given (a station hall below the street): the stub keeps it as your feet
c.teleport = function(x, z, yaw, y){ calls.teleport.push([x, z, yaw]); avatar = {x: x, z: z, hy: y != null ? y : undefined}; };
var NOWS = []; function at(ms){ NOW = ms; }
function keyEv(code){ return {type: "keydown", code: code, key: code.replace(/^Key/, "").toLowerCase(), repeat: false, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false}; }
ROWS = [{user: "c0", lot_rank: 0}];
LIST = [{userId: "c0", level: 2, look: {}}];
var wc = city(null);
await wc.whenReady; for(var tk = 0; tk < 4; tk++) await new Promise(r => setTimeout(r, 0));    // transport is built just after the City
frame(wc, 0, 0, 2);
var T = wc.transit();
out.world = wc.world();
out.chain = C3.lastLoad ? C3.lastLoad.ids : null;
out.assign = calls.get.filter(p => /\/assign$/.test(p));
out.hasTransit = !!T;
if(T){
  out.services = T.debug.services().sort();
  out.registered = HQV.hqRide.services().map(s => s.mode).sort();
  out.views = T.debug.views().sort();
  out.drawCalls = T.drawCalls();
  out.under0 = HQV.hqUnderground && HQV.hqUnderground.under();

  /* ---------- a bus: E at the stop, the free board menu, the whole ride ---------- */
  (function(){
    var st = T.debug.stops("bus")[0]; if(!st){ out.bus = null; return; }
    avatar = {x: st.x, z: st.z};
    var used = wc.use({x: st.x, z: st.z}), items = menuItems();
    out.bus = {used: used, menu: wc.menuOpen(), items: items.length, first: items.length ? items[0].textContent : null, prompt: null};
    if(!items.length) return;
    items[0].click();
    out.bus.menuAfter = wc.menuOpen();
    var S = T.session(); out.bus.session = !!S; out.bus.phase0 = S && S.phase;
    var anims = {}, seatCam = null, keys = null, moved = 0, p0 = null, steps = 0;
    for(var i = 0; i < 60*40 && T.session(); i++){
      var S0 = T.session();
      // waiting at the stop: on to a second before the bus is due (the timetable is the clock's)
      if(S0.phase === "wait" && S0.trip.arrive - NOW > 3000) NOW = S0.trip.arrive - 2000;
      NOW += S0.phase === "seated" || S0.phase === "standing" ? 2000 : 250; frame(wc, avatar.x, avatar.z);
      var p = wc.carry();
      if(p){ anims[p.anim] = 1; if(!p0) p0 = p; moved = Math.max(moved, Math.hypot(p.x - p0.x, p.z - p0.z)); avatar = {x: p.x, z: p.z};
        if(p.anim === "sit" && !seatCam){ var cp = wc.camPose(); seatCam = cp ? {camera: !!cp.camera, fov: cp.fov, mode: cp.mode} : null;
          // V cycles the seat camera, S rings the bell
          var v1 = wc.transitKey(keyEv("KeyV")), m1 = (wc.camPose() || {}).mode, sOk = wc.transitKey(keyEv("KeyS"));
          keys = {v: v1, mode: m1, s: sOk, stop: T.debug.info().stopRequested, net: T.net()};
          wc.transitKey(keyEv("KeyV")); wc.transitKey(keyEv("KeyV"));
        } }
      steps++;
    }
    out.bus.anims = Object.keys(anims).sort(); out.bus.seatCam = seatCam; out.bus.keys = keys; out.bus.moved = moved;
    out.bus.ended = !T.session(); out.bus.carryAfter = wc.carry(); out.bus.fares = calls.post.filter(q => /fare/.test(q[0])).length;
  })();

  /* ---------- a peer seated in a vehicle (presence a = 14) ---------- */
  (function(){
    var bus = HQV.hqRide.services().filter(s => s.mode === "bus")[0], v = bus ? bus.vehicles(NOW)[0] : null;
    out.peer = v ? T.peerSeat(1, v.id, "peer-1", NOW) : null;
    out.peerFar = v ? Math.hypot(out.peer.x - v.x, out.peer.z - v.z) : null;
    out.peerNone = T.peerSeat(1, "no-such-vehicle", "peer-1", NOW);
  })();

  /* ---------- the metro: E at an entrance, below the street, the platform's way out ---------- */
  (function(){
    var M = WD.metroOf(wc.doc()); if(!M || !M.entrances.length){ out.metro = null; return; }
    var e = M.entrances.filter(q => q.kind !== "lift")[0] || M.entrances[0];
    var hidden0 = wc.scene.children.filter(g => !g.visible).length;
    if(T.session()) T.session().cancel(true);
    avatar = {x: e.x, z: e.z, hy: WD.streetAt(wc.doc(), e.x, e.z)};      // at the top of the stairs
    out.metro = {prompt: wc.prompt({x: e.x, z: e.z}), used: wc.use({x: e.x, z: e.z})};
    for(var i = 0; i < 6; i++){ NOW += 150; frame(wc, avatar.x, avatar.z); }
    var tp = calls.teleport[calls.teleport.length - 1] || null;
    out.metro.under = HQV.hqUnderground.under(); out.metro.teleport = tp;
    var scene = wc.scene, hidden = 0, shown = 0;
    scene.children.forEach(function(g){ if(g.visible) shown++; else hidden++; });
    out.metro.hidden = hidden; out.metro.fogDark = !!(scene.fog && scene.fog.color && scene.fog.color.getHex() === 0x0b0d10);
    var st = M.stations.filter(s => s.id === e.station)[0];
    out.metro.groundBelow = st ? wc.groundY(st.x, st.z) < WD.streetAt(wc.doc(), st.x, st.z) - 3 : null;
    // on the platform: E offers the departures and the way out
    if(st){ avatar = {x: st.x, z: st.z, hy: st.y + 1.1}; wc.use({x: st.x, z: st.z}); var it = menuItems().map(b => b.textContent);
      out.metro.platformMenu = it; var wo = menuItems().filter(b => /Way out/.test(b.textContent))[0];
      if(wo){ wo.click(); for(var j = 0; j < 6; j++){ NOW += 150; frame(wc, avatar.x, avatar.z); } }
      out.metro.upAgain = !HQV.hqUnderground.under(); }
    out.metro.surfaceBack = scene.children.filter(g => !g.visible).length - hidden0;
  })();
  out.drawCallsBy = T.drawCallsBy();
  out.servicesLater = T.debug.services().sort();          // the Island Link joins once the archipelago is known
  out.link = (function(){ var L = T.debug.lines("link")[0]; return L ? {world: L.world, short: L.short, stops: L.stops.length} : null; })();
}
wc.destroy();
out.afterDestroy = {under: HQV.hqUnderground ? HQV.hqUnderground.under() : null, leftover: root2d.children.filter(e => e.attrs.role === "dialog").length};

/* ---------- an Arena without @3: the Commons @2, transport without the metro ---------- */
FAIL["claude-hq@3"] = true;
var w2 = city(null); await w2.whenReady; for(var tk2 = 0; tk2 < 4; tk2++) await new Promise(r => setTimeout(r, 0)); frame(w2, 0, 0, 1);
out.fallback = {world: w2.world(), services: w2.transit() ? w2.transit().debug.services().sort() : null};
w2.destroy();
Date.now = realNow;
process.stdout.write(JSON.stringify(out));
"""


def harness():
    src = test_cities.HARNESS
    head = src[:src.index("/* ---------- pure ---------- */")]
    old = '"hqbridges", "hqnav", "hqminimap", "hqroutefx", "hqnavui", "hqcity3d"]'
    assert old in head, "test_cities' script list moved"
    head = head.replace(old, '"hqbridges", "hqnav", "hqminimap", "hqroutefx", "hqnavui", ' + ", ".join('"%s"' % n for n in TRANSIT) + ', "hqcity3d"]')
    return head + BODY


@unittest.skipUnless(NODE, "node is not installed")
@unittest.skipUnless(os.path.exists(COMMONS3) and os.path.exists(test_cities.COMMONS), "the @3 fixtures are missing (python3 tools/world_fixture.py --v3)")
class TransitHub(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        src = harness() % {"root": json.dumps(ROOT), "me": json.dumps(ME), "commons": json.dumps(test_cities.COMMONS),
                           "island": json.dumps(test_cities.ISLAND), "commons3": json.dumps(COMMONS3)}
        r = subprocess.run([NODE, "--input-type=module", "-e", src], capture_output=True, text=True, timeout=900,
                           env=dict(os.environ, TZ="UTC"))
        if r.returncode != 0:
            raise AssertionError("node failed:\n" + r.stderr[-4000:])
        cls.out = json.loads(r.stdout)

    def test_the_live_commons_and_its_ranks(self):
        o = self.out
        self.assertEqual(o["world"], "claude-hq@3")
        self.assertEqual(o["chain"], ["claude-hq@3", "claude-hq@2", "claude-hq@1"], "the live Commons first, then its fallbacks")
        # the live path first; this stub Arena has only the @2 one: the fallback asks it next
        self.assertEqual(o["assign"][:2], ["/api/arena/world/claude-hq@3/assign", "/api/arena/world/claude-hq@2/assign"])

    def test_every_service_is_registered(self):
        o = self.out
        self.assertTrue(o["hasTransit"])
        for m in ("bus", "tram", "metro", "rail", "gondola", "ferry"):
            self.assertIn(m, o["services"])
            self.assertIn(m, o["registered"], "registered with hqRide while this City is the one you are in")
        for v in ("tramway", "coach", "metro", "cityrail", "gondola", "ferries"):
            self.assertIn(v, o["views"])
        self.assertIsInstance(o["drawCalls"], int)
        self.assertIn("link", o["servicesLater"], "the Island Link, once the archipelago is known")
        self.assertEqual(o["link"]["short"], "IL")
        self.assertEqual(o["link"]["world"], "user:" + ME + "@3", "to the island at its live version (the Arena listed @2)")
        self.assertFalse(o["under0"])

    def test_a_free_bus_ride(self):
        b = self.out["bus"]
        self.assertTrue(b["used"] and b["menu"])
        self.assertGreater(b["items"], 1)
        self.assertRegex(b["first"], r"^1\. \S+ Bus to .+ · .+ · free$")
        self.assertFalse(b["menuAfter"])
        self.assertTrue(b["session"])
        self.assertIn(b["phase0"], ("walk", "wait"))
        self.assertTrue("sit" in b["anims"] or "stand" in b["anims"], "seated (or at a pole when the bus is full): %s" % b["anims"])
        self.assertIn("walk", b["anims"], "the scripted walk on and off")
        self.assertTrue(b["seatCam"] and b["seatCam"]["camera"])
        self.assertEqual(b["seatCam"]["fov"], 70)
        self.assertTrue(b["keys"]["v"]); self.assertEqual(b["keys"]["mode"], "window")
        self.assertTrue(b["keys"]["s"]); self.assertTrue(b["keys"]["stop"])
        self.assertEqual(b["keys"]["net"]["tk"], 1, "presence a = 14: the bus's mode code")
        self.assertGreater(b["moved"], 20, "the bus carries you along the line")
        self.assertTrue(b["ended"])
        self.assertIsNone(b["carryAfter"])
        self.assertEqual(b["fares"], 0, "free (D4)")

    def test_a_peer_in_their_seat(self):
        o = self.out
        self.assertIsNotNone(o["peer"])
        self.assertLess(o["peerFar"], 6, "drawn in the vehicle they ride")
        self.assertIsNone(o["peerNone"])

    def test_below_the_street(self):
        m = self.out["metro"]
        self.assertIsNotNone(m)
        self.assertRegex(m["prompt"] or "", r"Metro")
        self.assertTrue(m["used"])
        self.assertTrue(m["under"], "E at an entrance takes you down")
        self.assertIsNotNone(m["teleport"], "to the foot of its stairs")
        self.assertEqual(len(m["teleport"]), 3)
        self.assertGreater(m["hidden"], 3, "the surface is hidden")
        self.assertTrue(m["fogDark"])
        self.assertTrue(m["groundBelow"], "the ground is the metro's floor, below the street")
        self.assertTrue(any("Way out" in t for t in m["platformMenu"]), m["platformMenu"])
        self.assertTrue(m["upAgain"], "the way out brings you back up")
        self.assertEqual(m["surfaceBack"], 0, "and the surface comes back")

    def test_destroy_and_fallback(self):
        o = self.out
        self.assertIsNone(o["afterDestroy"]["under"])
        self.assertEqual(o["afterDestroy"]["leftover"], 0)
        self.assertEqual(o["fallback"]["world"], "claude-hq@2")
        self.assertIn("bus", o["fallback"]["services"])
        self.assertNotIn("metro", o["fallback"]["services"], "no metro layer at @2")


if __name__ == "__main__":
    unittest.main()
