"""Trips between islands (games/hqtravel.js, docs/plans/cities-build-spec.md, task cl-travel).

hqtravel.js is pure apart from its hooks and localStorage, so node loads it against a `window` stub with a
fake clock, hand-resolved promises and a fake (or throwing) localStorage, runs every scenario in one process
and prints JSON; the Python side checks it. The checks: mode gating by tiers and terminals, ride times, the
load starting at departure and arrival waiting for both the build and the ride's minimum time, the
fast-travel fee only once unlocked, room ids, failed loads returning you to the origin terminal with a
message, the boat landing hook, the visited memory surviving broken storage, and poses that are a pure
function of time (frame-rate independent). Skipped when node is not installed. Stdlib only."""
import json
import os
import re
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "games", "hqtravel.js")
NODE = shutil.which("node")


def read(p):
    with open(p, encoding="utf-8") as f:
        return f.read()

HARNESS = r"""
var fs = require("fs"), root = %(root)s;
var mem = {}, storageMode = "ok";
global.window = {HQV: {}};
Object.defineProperty(window, "localStorage", {get: function(){
  if(storageMode === "throw") throw new Error("SecurityError");
  if(storageMode === "none") return null;
  return {getItem: function(k){ return k in mem ? mem[k] : null; }, setItem: function(k, v){ mem[k] = String(v); }};
}});
new Function(fs.readFileSync(root + "/games/hqtravel.js", "utf8"))();
var H = window.HQV.hqTravel, out = {};
var A = "user:11111111-2222-4333-8444-555555555555@2", B = "user:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee@2";
var C = "claude-hq@2";

// a site (cm) facing +z (front is Q16)
function S(id, kind, x, z, tier){ return {id: id, kind: kind, x: x, z: z, w: 1000, d: 1000, tier: tier, front: [0, 65536]}; }
function doc(sites){ return {id: "x", layers: {sites: sites}}; }
var FULL = doc([S("dock1", "dock", 10000, 20000, 1), S("st1", "transit", 30000, 0, 4), S("air1", "airport", -50000, 0, 5),
                S("spawn1", "spawn", 0, 0, 1)]);
var NOAIR = doc([S("dock1", "dock", 10000, 20000, 1), S("st1", "transit", 30000, 0, 4)]);
var LATEDOCK = doc([S("dock9", "dock", 0, 0, 3)]);
function city(w, tier, d, x, z){ return {world: w, tier: tier, doc: d, x: x == null ? 0 : x, z: z == null ? 0 : z, name: "Isle"}; }
function modes(a, b){ return H.options(a, b).map(function(o){ return o.mode; }); }

// ---------- gating ----------
out.gate = {
  t1t1: modes(city(A, 1, FULL), city(B, 1, FULL)),
  t3t4: modes(city(A, 3, FULL), city(B, 4, FULL)),
  t4t4: modes(city(A, 4, FULL), city(B, 4, FULL)),
  t5t5: modes(city(A, 5, FULL), city(B, 5, FULL)),
  t5noair: modes(city(A, 5, FULL), city(B, 5, NOAIR)),
  commonsT4: modes(city(C, null, FULL), city(B, 4, FULL)),
  commonsT3: modes(city(C, null, FULL), city(B, 3, FULL)),
  commonsT5: modes(city(C, null, FULL), city(B, 5, FULL)),
  commonsNoDoc: modes(city(C, null, FULL), {world: B, tier: 5}),
  t4NoDoc: modes(city(A, 4, FULL), {world: B, tier: 4}),
  dockTooEarly: modes(city(A, 1, LATEDOCK), city(B, 1, FULL)),
  dockGrown: modes(city(A, 3, LATEDOCK), city(B, 1, FULL)),
  noDocks: modes(city(A, 5, doc([S("st1", "transit", 0, 0, 4)])), city(B, 5, FULL)),
  same: modes(city(A, 5, FULL), city(A, 5, FULL)),
  badId: modes({world: "user:nope@2", tier: 5, doc: FULL}, city(B, 5, FULL))
};
out.seconds = {};
["ferry", "rail", "plane"].forEach(function(m){
  out.seconds[m] = [H.rideSeconds(m, {x: 0, z: 0}, {x: 0, z: 100}), H.rideSeconds(m, {x: 0, z: 0}, {x: 0, z: 1e6}),
                    H.rideSeconds(m, {x: 0, z: 0}, {x: 0, z: 9000})];
});

// ---------- rooms ----------
out.rooms = [H.roomFor(C), H.roomFor(A), H.roomFor("claude-hq@1"), H.roomFor("user:x@2"), H.roomFor("../etc"), H.roomFor(null)];

// ---------- ferry schedule ----------
out.sail = [H.nextSailing(A, B, 1000000), H.nextSailing(B, A, 1000000), H.nextSailing(A, B, 1000000 + 7)];

// ---------- trip harness ----------
function defer(){ var d = {}; d.p = new Promise(function(res, rej){ d.res = res; d.rej = rej; }); return d; }
function flush(){ return new Promise(function(r){ setImmediate(r); }); }
function rig(o){
  o = o || {};
  var r = {now: 1000000, log: [], docD: defer(), cityD: defer(), buildD: defer(), fareD: defer(), arrived: [], progress: []};
  r.hooks = {
    now: function(){ return r.now; },
    fetchDoc: function(w){ r.log.push(["doc", w, r.now]); return r.docD.p; },
    fetchCity: function(w){ r.log.push(["city", w, r.now]); return r.cityD.p; },
    buildWorld: function(d, c){ r.log.push(["build", d.id, c && c.tier, r.now]); return r.buildD.p; },
    fare: function(kind, to){ r.log.push(["fare", kind, to.world, r.now]); return r.fareD.p; },
    onProgress: function(p){ r.progress.push(p.phase); },
    onArrive: function(sp, b){ r.arrived.push({sp: sp, b: b, at: r.now}); }
  };
  return r;
}
async function tick(r, trip, secs, step){
  step = step || 0.25;
  for(var t = 0; t < secs - 1e-9; t += step){ r.now += step*1000; trip.update(); await flush(); }
}
var DEST = doc([S("st2", "transit", 5000, 5000, 4), S("dock2", "dock", 0, 7000, 1), S("air2", "airport", 0, -9000, 5)]);
DEST.id = "dest";

async function main(){
  storageMode = "ok";

  // rail: the load starts at departure; arrival waits for the ride's minimum time
  var r = rig(), from = city(A, 4, FULL), to = city(B, 4, null, 0, 9000);
  var trip = H.start("rail", from, to, r.hooks);
  await flush();
  out.railStart = {ok: trip.ok, room: trip.room, seconds: trip.seconds, phase: trip.phase, log: r.log.slice()};
  r.docD.res(DEST); r.cityD.res({tier: 4}); await flush(); await flush();
  r.buildD.res("BUILT"); await flush(); await flush();
  out.railBuiltEarly = {builtAt: trip.builtAt, arrived: r.arrived.length, log: r.log.slice()};
  await tick(r, trip, trip.seconds - 1);
  out.railBefore = {phase: trip.phase, arrived: r.arrived.length};
  await tick(r, trip, 1.5);
  out.railAfter = {phase: trip.phase, arrived: r.arrived.length, spawn: r.arrived[0] && r.arrived[0].sp,
                   built: r.arrived[0] && r.arrived[0].b, at: r.arrived[0] && (r.arrived[0].at - trip.departAt)/1000,
                   fare: r.log.filter(function(l){ return l[0] === "fare"; }).length};

  // a slow build: the ride ends, the trip holds, and arrival comes when the build lands
  r = rig(); trip = H.start("rail", from, to, r.hooks);
  r.docD.res(DEST); r.cityD.res({tier: 4}); await flush(); await flush();
  await tick(r, trip, trip.seconds + 5);
  out.slow = {phase: trip.phase, arrived: r.arrived.length, fade: trip.pose().fade};
  r.buildD.res("LATE"); await flush(); await flush();
  r.now += 16; trip.update();
  out.slow.after = {phase: trip.phase, arrived: r.arrived.length, site: r.arrived[0] && r.arrived[0].sp.site,
                    late: r.arrived[0] && (r.arrived[0].at - trip.departAt)/1000 > trip.seconds + 4};

  // ferry: nothing loads while boarding; the load starts at the scheduled sailing
  r = rig(); var ff = city(A, 1, FULL), ft = city(B, 1, null, 0, 3000);
  trip = H.start("ferry", ff, ft, r.hooks);
  var waitS = (trip.departAt - r.now)/1000;
  await tick(r, trip, Math.max(0, waitS - 0.5), 0.5);
  out.ferryBoard = {phase: trip.phase, log: r.log.length, departAt: trip.departAt, sail: H.nextSailing(A, B, 1000000),
                    pose: trip.pose().pos != null};
  await tick(r, trip, 1, 0.5);
  out.ferryDepart = {phase: trip.phase, log: r.log.map(function(l){ return l[0]; }),
                     loadAt: r.log.length ? r.log[0][2] : null, departAt: trip.departAt, seconds: trip.seconds};
  r.docD.res(DEST); r.cityD.res({tier: 1}); r.buildD.res("B"); await flush(); await flush(); await flush();
  await tick(r, trip, trip.seconds + 1);
  out.ferryArrive = {phase: trip.phase, site: r.arrived[0] && r.arrived[0].sp.site, world: r.arrived[0] && r.arrived[0].sp.world};

  // failures: doc rejects, build rejects, a load that never settles
  async function failCase(mode, how, f, t){
    var r = rig(), trip = H.start(mode, f || from, t || to, r.hooks);
    if(how === "doc") r.docD.rej(new Error("503"));
    if(how === "baddoc"){ r.docD.res({nope: 1}); r.cityD.res({}); }
    if(how === "build"){ r.docD.res(DEST); r.cityD.res({}); await flush(); await flush(); r.buildD.rej(new Error("oom")); }
    await flush(); await flush(); await flush();
    await tick(r, trip, how === "hang" ? trip.seconds + H.LOAD_TIMEOUT + 1 : 1);
    var a = r.arrived[0] || {sp: {}};
    return {phase: trip.phase, n: r.arrived.length, site: a.sp.site, world: a.sp.world, failed: !!a.sp.failed,
            message: a.sp.message, tripMsg: trip.message};
  }
  out.fail = {doc: await failCase("rail", "doc"), baddoc: await failCase("rail", "baddoc"),
              build: await failCase("rail", "build"), hang: await failCase("rail", "hang"),
              ferry: await failCase("plane", "doc", city(A, 5, FULL), city(B, 5, null))};

  // fast travel: refused (and no fare) until visited; then one 1-coin fare, a fade, and arrival
  mem = {};
  r = rig();
  var fopts = H.options(city(A, 1, FULL), city(B, 1, null)).map(function(o){ return o.mode; });
  var refused = H.start("fast", city(A, 1, FULL), city(B, 1, null), r.hooks);
  out.fastLocked = {opts: fopts, ok: refused.ok, error: refused.error, log: r.log.length};
  H.markVisited(B);
  var fo = H.options(city(A, 1, FULL), city(B, 1, null)).filter(function(o){ return o.mode === "fast"; })[0];
  trip = H.start("fast", city(A, 1, FULL), city(B, 1, null), r.hooks);
  await flush();
  out.fastPaying = {phase: trip.phase, log: r.log.map(function(l){ return l.slice(0, 2); }), fee: fo && fo.fee, mode: fo && fo.mode};
  r.fareD.res(); await flush(); await flush();
  out.fastLoading = {phase: trip.phase, log: r.log.map(function(l){ return l[0]; })};
  r.docD.res(DEST); r.cityD.res({tier: 1}); r.buildD.res("F"); await flush(); await flush(); await flush();
  await tick(r, trip, 0.5);
  out.fastMid = {phase: trip.phase, fade: trip.pose().fade};
  await tick(r, trip, 1.5);
  out.fastArr = {phase: trip.phase, n: r.arrived.length, fade: trip.pose().fade};
  await tick(r, trip, 1);
  out.fastDone = {phase: trip.phase, fade: trip.pose().fade};
  out.fastCommons = H.options(city(A, 1, FULL), city(C, null, null)).map(function(o){ return o.mode; });
  // a declined fare: no load, back where you were
  r = rig(); trip = H.start("fast", city(A, 1, FULL), city(B, 1, null), r.hooks);
  r.fareD.rej(new Error("402")); await flush(); await flush(); await flush();
  out.fastDeclined = {phase: trip.phase, log: r.log.map(function(l){ return l[0]; }), n: r.arrived.length,
                      failed: r.arrived[0] && r.arrived[0].sp.failed, world: r.arrived[0] && r.arrived[0].sp.world,
                      message: trip.message};
  out.visitedAfter = H.visited();

  // other refusals
  out.refuse = {boat: H.start("boat", city(A, 1, FULL), city(B, 1, FULL), {}).error,
                rail: H.start("rail", city(A, 3, FULL), city(B, 4, FULL), {}).ok,
                bogus: H.start("teleport", city(A, 1, FULL), city(B, 1, FULL), {}).ok};

  // the boat lands at the dock it reached
  var bd = defer(), bb = [];
  var bp = H.arrive(B, "dock2", {fetchDoc: function(){ return Promise.resolve(DEST); }, buildWorld: function(){ return Promise.resolve("BB"); },
                                 onArrive: function(sp, b){ bb.push(b); }});
  var bs = await bp;
  var bf = await H.arrive(B, "dock2", {fetchDoc: function(){ return Promise.reject(new Error("x")); }, buildWorld: function(){}});
  var bx = await H.arrive("nope", "dock2", {});
  out.boat = {spawn: bs, built: bb, fail: bf, bad: bx};

  // poses: a pure function of time, whatever the update cadence
  function poseRun(fps){
    var r = rig(), trip = H.start("plane", city(A, 5, FULL), city(B, 5, null, 4000, 8000), r.hooks), samples = [];
    r.docD.res(DEST); r.cityD.res({tier: 5}); r.buildD.res("P");
    return (async function(){
      await flush(); await flush(); await flush();
      var marks = [3, 7, 12, 19], mi = 0, end = trip.departAt + 30000, step = 1000/fps;
      while(r.now < end){
        var next = Math.min(r.now + step, mi < marks.length ? trip.departAt + marks[mi]*1000 : end);
        r.now = next; trip.update(); await flush();
        if(mi < marks.length && r.now === trip.departAt + marks[mi]*1000){ samples.push(trip.pose()); mi++; }
      }
      return {samples: samples, phase: trip.phase, spawn: r.arrived[0].sp, last: trip.pose(), seconds: trip.seconds};
    })();
  }
  out.pose60 = await poseRun(60); out.pose7 = await poseRun(7);
  out.ridePoses = {};
  ["ferry", "rail", "plane"].forEach(function(m){
    var F = {x: 1, y: 0, z: 2, yaw: 0.6}, a = [];
    for(var t = 0; t <= 80; t += 4) a.push(H.ridePose(m, F, 60, t));
    out.ridePoses[m] = a;
  });

  // storage that throws or holds garbage: nothing visited, nothing breaks
  storageMode = "throw";
  var threw = false;
  try { H.markVisited(A); out.throwVisited = H.visited(); out.throwOpts = modes(city(A, 1, FULL), city(B, 1, null)); }
  catch(e){ threw = true; }
  out.throwThrew = threw;
  storageMode = "none"; out.noneVisited = H.visited();
  storageMode = "ok"; mem = {hq_travel_visited: "{not json"}; out.garbage = H.visited();
  mem = {hq_travel_visited: JSON.stringify([A, "<script>", 7, B])}; out.filtered = H.visited();
  process.stdout.write(JSON.stringify(out));
}
main().catch(function(e){ console.error(e && e.stack || e); process.exit(1); });
"""


@unittest.skipUnless(NODE, "node is not installed")
class HqTravel(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        js = HARNESS % {"root": json.dumps(ROOT)}
        res = subprocess.run([NODE, "-e", js], capture_output=True, text=True, timeout=120)
        if res.returncode != 0:
            raise AssertionError(res.stderr)
        cls.o = json.loads(res.stdout)

    def test_mode_gating_by_tiers_and_terminals(self):
        g = self.o["gate"]
        self.assertEqual(g["t1t1"], ["ferry", "boat"])
        self.assertEqual(g["t3t4"], ["ferry", "boat"])             # rail needs tier 4 at both ends
        self.assertEqual(g["t4t4"], ["ferry", "rail", "boat"])
        self.assertEqual(g["t5t5"], ["ferry", "rail", "plane", "boat"])
        self.assertEqual(g["t5noair"], ["ferry", "rail", "boat"])   # tier 5 but no airport in the doc
        self.assertEqual(g["commonsT4"][:2], ["ferry", "rail"])
        self.assertNotIn("plane", g["commonsT4"])
        self.assertNotIn("rail", g["commonsT3"])
        self.assertIn("plane", g["commonsT5"])
        self.assertIn("plane", g["commonsNoDoc"])                  # no doc yet: presumed from the profile
        self.assertIn("rail", g["t4NoDoc"])
        self.assertEqual(g["dockTooEarly"], [])                    # its only dock grows in at tier 3
        self.assertEqual(g["dockGrown"], ["ferry", "boat"])
        self.assertNotIn("ferry", g["noDocks"])
        self.assertNotIn("boat", g["noDocks"])
        self.assertEqual(g["same"], [])
        self.assertEqual(g["badId"], [])

    def test_ride_times_in_range(self):
        s = self.o["seconds"]
        self.assertEqual(s["ferry"][:2], [60, 90])
        self.assertEqual(s["rail"][:2], [30, 45])
        for m, (lo, hi) in {"ferry": (60, 90), "rail": (30, 45)}.items():
            self.assertTrue(lo < s[m][2] < hi, (m, s[m]))
        self.assertTrue(all(10 <= v <= 25 for v in s["plane"]))     # a short cutscene

    def test_room_ids(self):
        self.assertEqual(self.o["rooms"], ["city3d:claude-hq@2", "city3d:user:11111111-2222-4333-8444-555555555555@2",
                                           "city3d:claude-hq@1", None, None, None])
        self.assertEqual(self.o["railStart"]["room"], "city3d:user:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee@2")

    def test_ferry_schedule_is_shared_and_symmetric(self):
        a, b, c = self.o["sail"]
        self.assertEqual(a, b)
        self.assertTrue(1000000 <= a < 1000000 + 90000)
        self.assertGreaterEqual(c, 1000007)
        self.assertIn(c, (a, a + 90000))

    def test_load_starts_at_departure_and_arrival_waits_for_the_ride(self):
        s = self.o["railStart"]
        self.assertTrue(s["ok"])
        self.assertEqual(s["phase"], "riding")
        self.assertEqual([l[0] for l in s["log"]], ["doc", "city"])
        self.assertTrue(all(l[2] == 1000000 for l in s["log"]))     # at departure, not later
        e = self.o["railBuiltEarly"]
        self.assertIsNotNone(e["builtAt"])
        self.assertEqual(e["arrived"], 0)                           # built, but the ride isn't over
        self.assertEqual(e["log"][2][:3], ["build", "dest", 4])     # built with the fetched city state
        self.assertEqual(self.o["railBefore"], {"phase": "riding", "arrived": 0})
        a = self.o["railAfter"]
        self.assertEqual(a["arrived"], 1)
        self.assertGreaterEqual(a["at"], self.o["railStart"]["seconds"])
        self.assertEqual(a["built"], "BUILT")
        self.assertEqual(a["spawn"]["site"], "st2")                 # the destination station
        self.assertEqual(a["spawn"]["world"], "user:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee@2")
        self.assertEqual(a["phase"], "done")
        self.assertEqual(a["fare"], 0)                              # rail is free

    def test_arrival_waits_for_a_slow_build(self):
        s = self.o["slow"]
        self.assertEqual(s["phase"], "holding")
        self.assertEqual(s["arrived"], 0)
        self.assertEqual(s["after"]["arrived"], 1)
        self.assertEqual(s["after"]["site"], "st2")
        self.assertTrue(s["after"]["late"])

    def test_ferry_loads_at_its_sailing(self):
        b = self.o["ferryBoard"]
        self.assertEqual(b["phase"], "boarding")
        self.assertEqual(b["log"], 0)
        self.assertEqual(b["departAt"], b["sail"])
        d = self.o["ferryDepart"]
        self.assertEqual(d["phase"], "riding")
        self.assertEqual(d["log"], ["doc", "city"])
        self.assertLess(d["loadAt"] - d["departAt"], 600)           # within a frame or two of the sailing
        self.assertTrue(60 <= d["seconds"] <= 90)
        a = self.o["ferryArrive"]
        self.assertEqual(a["site"], "dock2")
        self.assertEqual(a["phase"], "done")

    def test_failed_load_returns_to_the_origin_with_a_message(self):
        for k, f in self.o["fail"].items():
            self.assertEqual(f["phase"], "failed", k)
            self.assertEqual(f["n"], 1, k)
            self.assertTrue(f["failed"], k)
            self.assertEqual(f["world"], "user:11111111-2222-4333-8444-555555555555@2", k)
            self.assertTrue(f["message"] and f["message"] == f["tripMsg"], k)
            self.assertIn("back at the", f["message"], k)
        self.assertEqual(self.o["fail"]["doc"]["site"], "st1")       # the origin station
        self.assertEqual(self.o["fail"]["ferry"]["site"], "air1")    # a plane: the origin airport
        self.assertIn("Isle", self.o["fail"]["doc"]["message"])

    def test_fast_travel_fee_only_when_unlocked(self):
        l = self.o["fastLocked"]
        self.assertNotIn("fast", l["opts"])
        self.assertFalse(l["ok"])
        self.assertTrue(l["error"])
        self.assertEqual(l["log"], 0)                                # no fare, no load
        p = self.o["fastPaying"]
        self.assertEqual(p["mode"], "fast")
        self.assertEqual(p["fee"], 1)
        self.assertEqual(p["phase"], "paying")
        self.assertEqual(p["log"], [["fare", "fast"]])                # the fee first, nothing loads yet
        self.assertEqual(self.o["fastLoading"]["log"], ["fare", "doc", "city"])
        self.assertIn("fast", self.o["fastCommons"])                 # the Commons is always open
        d = self.o["fastDeclined"]
        self.assertEqual(d["phase"], "failed")
        self.assertEqual(d["log"], ["fare"])
        self.assertTrue(d["failed"])
        self.assertEqual(d["world"], "user:11111111-2222-4333-8444-555555555555@2")
        self.assertIn("coin", d["message"])

    def test_fast_travel_fades(self):
        self.assertAlmostEqual(self.o["fastMid"]["fade"], 1, places=6)
        self.assertEqual(self.o["fastArr"]["n"], 1)
        self.assertEqual(self.o["fastDone"]["phase"], "done")
        self.assertAlmostEqual(self.o["fastDone"]["fade"], 0, places=6)

    def test_refusals(self):
        r = self.o["refuse"]
        self.assertIn("helm", r["boat"])
        self.assertFalse(r["rail"])
        self.assertFalse(r["bogus"])

    def test_boat_arrive(self):
        b = self.o["boat"]
        self.assertEqual(b["spawn"]["site"], "dock2")
        self.assertEqual(b["spawn"]["world"], "user:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee@2")
        self.assertAlmostEqual(b["spawn"]["z"], 70 + 7, places=6)   # just outside the dock, on its door side
        self.assertEqual(b["built"], ["BB"])
        self.assertTrue(b["fail"]["failed"] and b["fail"]["message"])
        self.assertTrue(b["bad"]["failed"])

    def test_visited_memory(self):
        self.assertIn("user:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee@2", self.o["visitedAfter"])
        self.assertIn("user:11111111-2222-4333-8444-555555555555@2", self.o["visitedAfter"])  # the origin too
        self.assertFalse(self.o["throwThrew"])
        self.assertEqual(self.o["throwVisited"], [])
        self.assertNotIn("fast", self.o["throwOpts"])
        self.assertEqual(self.o["noneVisited"], [])
        self.assertEqual(self.o["garbage"], [])
        self.assertEqual(self.o["filtered"], ["user:11111111-2222-4333-8444-555555555555@2",
                                              "user:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee@2"])

    def test_poses_are_frame_rate_independent(self):
        a, b = self.o["pose60"], self.o["pose7"]
        self.assertEqual(a["phase"], "done")
        self.assertEqual(len(a["samples"]), len(b["samples"]))
        for pa, pb in zip(a["samples"], b["samples"]):
            self.assertEqual(pa["frame"], pb["frame"])
            for k in ("pos", "look"):
                for ax in "xyz":
                    self.assertAlmostEqual(pa[k][ax], pb[k][ax], places=6)
        # the landing ends on the airport spawn
        self.assertEqual(a["spawn"]["site"], "air2")
        last = a["last"]["vehicle"]["pos"]
        self.assertAlmostEqual(last["x"], a["spawn"]["x"], places=6)
        self.assertAlmostEqual(last["y"], a["spawn"]["y"], places=6)
        self.assertAlmostEqual(last["z"], a["spawn"]["z"], places=6)
        src = read(SRC)
        self.assertNotRegex(src, r"Math\.min\(1, *dt *\*")

    def test_ride_camera_path_is_a_smooth_scripted_cinematic(self):
        for m, poses in self.o["ridePoses"].items():
            prev = None
            for p in poses:
                self.assertTrue(p["camera"])
                for k in ("pos", "look"):
                    self.assertTrue(all(isinstance(p[k][ax], (int, float)) for ax in "xyz"), m)
                if prev:   # no cuts: 4 s apart, the camera moves less than the vehicle could plus a shot change
                    d = sum((p["pos"][ax] - prev["pos"][ax]) ** 2 for ax in "xyz") ** 0.5
                    self.assertLess(d, 1500, m)
                prev = p
        self.assertGreater(self.o["ridePoses"]["plane"][-1]["vehicle"]["pos"]["y"], 300)   # cruising
        self.assertEqual(self.o["ridePoses"]["ferry"][-1]["vehicle"]["pos"]["y"], 0)       # on the sea

    def test_no_markup_or_unvalidated_ids(self):
        src = read(SRC)
        self.assertNotRegex(src, r"innerHTML|document\.|fetch\(")
        self.assertTrue(re.search(r"ISLAND_RE = /\^user:", src))


if __name__ == "__main__":
    unittest.main()
