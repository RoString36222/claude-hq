"""City play: odd jobs from the phone (games/playjobs.js, HQ 3.22).

Under node, on the @3 fixtures and on a v4-shaped world (the @3 doc with its roads renamed to v4's classes, as in
tests/test_citylife.py): offers are a pure function of (world, slot, bucket, hour); every target is on a footpath, clear
of buildings, in front of a real lot of the right use; distances are sane; more fares at night than at midday; a
simulated taxi run with a fake ctx and frame stream completes and pays, rams pay less, running out of time fails, the
wrong vehicle does not count; the store round-trips; dispose clears the beacon, the HUD and the job. The Jobs app
renders in the phone's DOM shim (tests/test_hqphone.py) with its offers, a Start that starts, a Cancel, and the record.
Skipped without node."""
import json
import os
import re
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")

SCRIPT = r"""
var fs = require("fs"), zlib = require("zlib"), root = %(root)s, FIX = root + "/tests/fixtures/";
global.window = {HQV: {}};
for (var f of ["world", "citylife", "cityplay", "playjobs"]) new Function(fs.readFileSync(root + "/games/" + f + ".js", "utf8"))();
var HQV = window.HQV, WD = HQV.world, L = HQV.cityLife, J = HQV.playJobs, out = {};
function doc(p){ return JSON.parse(zlib.gunzipSync(fs.readFileSync(FIX + p)).toString("utf8")); }
var V4 = {local: ["lane", "local street", "collector", "shared street", "service road", "local street + tram"],
          arterial: ["avenue", "boulevard", "boulevard + tram", "avenue_tram"], highway: ["highway", "expressway"], ring: ["expressway"]};
function v4(d){ d.layers.roads.edges.forEach(function(e, i){ var o = V4[e["class"]]; if(o) e["class"] = o[i %% o.length]; }); return d; }
var docs = {commons: doc("claude-hq@3.json.gz"), island: doc("island@3.json.gz"), v4: v4(doc("claude-hq@3.json.gz"))};
var Ws = {};
out.registered = HQV.cityPlay.features();
Object.keys(docs).forEach(function(name){
  var W = Ws[name] = WD.pack(docs[name]), U = L.landUse(W), o = out[name] = {kinds: {}, bad: [], legs: [], taxiDay: 0, taxiNight: 0, n: 0};
  o.docks = J.places(W).docks.length;
  var seed = HQV.cityPlay.hashStr(W.seed || W.id), lim = W.half - 60;
  var a = J.offers(W, {seed: seed, slot: 100, x: 0, z: 0, hour: 9});
  o.same = JSON.stringify(a) === JSON.stringify(J.offers(WD.pack(JSON.parse(JSON.stringify(docs[name]))), {seed: seed, slot: 100, x: 10, z: 20, hour: 9}));
  o.differs = JSON.stringify(a) !== JSON.stringify(J.offers(W, {seed: seed, slot: 101, x: 0, z: 0, hour: 9}));
  function okPt(p, why){
    var s = WD.surfaceAt(W, p.x, p.z);
    if(s !== "sidewalk" || WD.blockedAt(W, p.x, p.z)) o.bad.push(why + ":" + s);
  }
  for(var x = -lim; x <= lim; x += 300) for(var z = -lim; z <= lim; z += 300){
    J.offers(W, {seed: seed, slot: 7, x: x, z: z, hour: 13}).forEach(function(of){ if(of.kind === "taxi") o.taxiDay++; });
    J.offers(W, {seed: seed, slot: 7, x: x, z: z, hour: 23}).forEach(function(of){ if(of.kind === "taxi") o.taxiNight++; });
    J.offers(W, {seed: seed, slot: 7, x: x, z: z, hour: 8.25}).forEach(function(of){
      o.n++; o.kinds[of.kind] = (o.kinds[of.kind] || 0) + 1;
      okPt(of.from, of.kind + " from");
      var B = J.bucketOf(x, z);
      o.legs.push(["near", of.kind, Math.round(Math.hypot(of.from.x - B.x, of.from.z - B.z))]);
      if(of.kind === "taxi" && !/^stop:|^terrace:/.test(of.from.spot)) o.bad.push("taxi spot " + of.from.spot);
      if(of.kind !== "taxi"){
        var u0 = U[of.from.lot];
        if(!u0 || (of.kind === "van" ? u0.ground !== "loading" || u0.group !== "industry" : ["shop", "cafe", "loading"].indexOf(u0.ground) < 0)) o.bad.push(of.kind + " from lot " + of.from.lot);
      }
      if(of.kind === "delivery" && (of.stops.length < 1 || of.stops.length > 3)) o.bad.push("parcels " + of.stops.length);
      var prev = of.from;
      of.stops.forEach(function(s){
        okPt(s, of.kind + " stop");
        var u = U[s.lot];
        var want = of.kind === "taxi" ? (u && (u.use === "home" || u.use === "office")) : of.kind === "delivery" ? (u && u.use === "home") : (u && (u.ground === "shop" || u.ground === "cafe"));
        if(!want) o.bad.push(of.kind + " stop lot " + s.lot);
        o.legs.push(["leg", of.kind, Math.round(Math.hypot(s.x - prev.x, s.z - prev.z))]);
        prev = s;
      });
      if(!(of.base > 0) || !(of.dist > 0)) o.bad.push("base/dist");
    });
  }
});

// ---- a fake ctx and a frame stream ----
function fakeCtx(W, mem){
  var C = {W: W, seed: HQV.cityPlay.hashStr(W.seed || W.id), beacons: {}, hud: null, emits: [], said: [], way: [], blockAt: null, mem: mem || {}};
  C.ctx = {W: W, seed: C.seed, mulberry32: HQV.cityPlay.mulberry32,
    say: function(t){ C.said.push(t); }, local: function(ms){ return ms; },
    blocked: function(x, z){ return !!(C.blockAt && Math.hypot(x - C.blockAt.x, z - C.blockAt.z) < 6); },
    emit: function(k, d){ C.emits.push([k, d]); },
    hud: {rows: {}, set: function(id, t){ this.rows[id] = t; }, clear: function(id){ delete this.rows[id]; }},
    beacon: function(id, x, z){ C.beacons[id] = [x, z]; }, beaconOff: function(id){ delete C.beacons[id]; },
    waypoint: function(x, z, l){ C.way.push([Math.round(x), Math.round(z)]); },
    store: {get: function(k, fb){ return k in C.mem ? JSON.parse(JSON.stringify(C.mem[k])) : fb; }, set: function(k, v){ C.mem[k] = JSON.parse(JSON.stringify(v)); }}};
  return C;
}
var W = Ws.commons, T0 = Date.UTC(2026, 9, 26, 8, 15);
function run(rams, opts){
  opts = opts || {};
  var C = fakeCtx(W, opts.mem), F = J.create(C.ctx), ms = T0, me = {x: 0, z: 0}, mo = {ride: "car", speed: 0};
  function frame(dt){ ms += dt*1000; F.update(dt, {ms: ms, local: ms, me: {x: me.x, y: 0, z: me.z, yaw: 0}, motion: mo}); }
  frame(0.016);
  var of = F.offers().filter(function(o){ return o.kind === (opts.kind || "taxi"); })[0];
  var r = F.start(of.id), res = {start: r, offer: of.id, kinds: F.offers().map(function(o){ return o.kind; })};
  res.beacon = C.beacons.job ? [Math.round(C.beacons.job[0]), Math.round(C.beacons.job[1])] : null;
  res.from = [Math.round(of.from.x), Math.round(of.from.z)];
  if(opts.wrong){ mo = {ride: null, speed: 0}; }
  me = {x: of.from.x, z: of.from.z}; frame(20);
  res.stepAfterPickup = F.active() ? F.active().step : -1;
  res.hud = C.ctx.hud.rows.job || "";
  if(opts.wrong){ F.cancel(); res.emits = C.emits; return res; }
  for(var i = 0; i < rams; i++){ ms += 1000; F.on("ram", {x: me.x, z: me.z, speed: 9}); F.on("ram", {x: me.x, z: me.z, speed: 9}); }
  if(opts.late){ frame(5000); res.emits = C.emits.map(function(e){ return e[1].state + ":" + (e[1].reason || ""); }); res.active = F.active(); res.stats = F.stats(); return res; }
  of.stops.forEach(function(s){ me = {x: s.x + 2, z: s.z + 1}; mo = {ride: "car", speed: 5}; frame(10); mo = {ride: "car", speed: 0.5}; frame(1); });
  res.active = F.active();
  res.emits = C.emits.map(function(e){ return [e[0], e[1].kind, e[1].state, e[1].tip]; });
  res.stats = F.stats(); res.mem = C.mem; res.hudEnd = C.ctx.hud.rows.job || ""; res.beaconEnd = Object.keys(C.beacons);
  res.said = C.said;
  return res;
}
out.clean = run(0);
out.rammed = run(3);
out.late = run(0, {late: true});
out.wrong = run(0, {wrong: true});
out.again = run(0, {mem: out.clean.mem});          // the store round-trips: a second job adds to the first
out.van = run(0, {kind: "van"});
// dispose mid-job: the beacon, the HUD and the job go, no "done"
(function(){
  var C = fakeCtx(W), F = J.create(C.ctx);
  F.update(0.016, {ms: T0, local: T0, me: {x: 0, z: 0}, motion: {ride: "car", speed: 0}});
  F.start(F.offers()[0].id);
  F.update(0.5, {ms: T0 + 500, local: T0 + 500, me: {x: 0, z: 0}, motion: {ride: "car", speed: 0}});
  var before = [Object.keys(C.beacons).length, !!C.ctx.hud.rows.job];
  F.dispose();
  out.dispose = {before: before, after: [Object.keys(C.beacons).length, !!C.ctx.hud.rows.job, F.active()], emits: C.emits.map(function(e){ return e[1].state; })};
  out.disposeRestart = F.start(F.offers()[0] ? F.offers()[0].id : "x").ok;
})();
// a blocked place: after 6 s blocked the job is called off, without a fail on your record
(function(){
  var C = fakeCtx(W), F = J.create(C.ctx), ms = T0;
  F.update(0.016, {ms: ms, local: ms, me: {x: 0, z: 0}, motion: {ride: "car", speed: 0}});
  var of = F.offers()[0];
  F.start(of.id);
  C.blockAt = {x: of.from.x, z: of.from.z};
  for(var i = 0; i < 8; i++){ ms += 1100; F.update(1.1, {ms: ms, local: ms, me: {x: 0, z: 0}, motion: {ride: "car", speed: 0}}); }
  out.blocked = {active: F.active(), emits: C.emits.map(function(e){ return e[1].state + ":" + (e[1].reason || ""); }), fails: F.stats().fails};
  // a place blocked at the start (and 3 m either way): it cannot start
  var C2 = fakeCtx(W), F2 = J.create(C2.ctx);
  F2.update(0.016, {ms: T0, local: T0, me: {x: 0, z: 0}, motion: {ride: "car", speed: 0}});
  C2.blockAt = {x: of.from.x, z: of.from.z};
  out.blockedStart = F2.start(of.id);
})();
// a co-op job from a spec (points snapped to footpaths), and one in the sea refused
(function(){
  var C = fakeCtx(W), F = J.create(C.ctx), P = J.places(W);
  F.update(0.016, {ms: T0, local: T0, me: {x: 0, z: 0}, motion: {ride: "car", speed: 0}});
  var h = P.homes[3], s = P.shops[2];
  out.spec = F.start({kind: "delivery", from: {x: s.x + 1, z: s.z}, stops: [{x: h.x, z: h.z - 1}]});
  var a = F.active(); out.specPt = a ? WD.surfaceAt(W, a.x, a.z) : null; F.cancel();
  out.specBad = F.start({kind: "taxi", from: {x: W.half - 1, z: W.half - 1}, stops: [{x: 0, z: 0}]});
  out.specKind = F.start({kind: "heist", from: {x: s.x, z: s.z}, stops: [{x: h.x, z: h.z}]});
})();
out.pay = [J.payout("taxi", {base: 40, left: 60, limit: 60, rams: 0}), J.payout("taxi", {base: 40, left: 0, limit: 60, rams: 0}),
           J.payout("taxi", {base: 40, left: 60, limit: 60, rams: 2}), J.payout("van", {base: 40, left: 60, limit: 60, heavy: true}),
           J.payout("van", {base: 40, left: 60, limit: 60, rams: 1})];
out.ranks = [0, 4, 5, 19, 20, 99].map(function(n){ return J.rankOf(n).name; });
out.can = [J.canDo("taxi", {ride: "car"}), J.canDo("taxi", {ride: "moto"}), J.canDo("delivery", {ride: null}), J.canDo("delivery", {ride: "moto"}),
           J.canDo("delivery", {ride: "car"}), J.canDo("van", {ride: "tank"}), J.canDo("taxi", {ride: "car", air: true}), J.heavy({ride: "car", body: "suv"}), J.heavy({ride: "car", body: "sedan"})];
out.ach = J.achList(J.record(J.record(null, {kind: "taxi", state: "done", tip: 30, hour: 23}), {kind: "van", state: "done", tip: 50, rams: 0})).filter(function(a){ return a.done; }).map(function(a){ return a.id; });
out.achSrc = (HQV.hqAchSources || []).length;
out.fmt = [J.fmtClock(102), J.fmtClock(0), J.fmtDist(640), J.fmtDist(1234)];
console.log(JSON.stringify(out));
"""


@unittest.skipUnless(NODE, "node not installed")
class PlayJobs(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        r = subprocess.run([NODE, "-e", SCRIPT % {"root": json.dumps(ROOT)}], capture_output=True, text=True, timeout=300)
        if r.returncode:
            raise AssertionError(r.stderr[-3000:])
        cls.o = json.loads(r.stdout.strip().splitlines()[-1])

    def test_registers_with_city_play(self):
        self.assertIn("jobs", self.o["registered"])
        self.assertGreaterEqual(self.o["achSrc"], 1)

    def test_offers_are_deterministic_per_world_and_slot(self):
        for name in ("commons", "island", "v4"):
            self.assertTrue(self.o[name]["same"], name)
            self.assertTrue(self.o[name]["differs"], name)

    def test_every_kind_is_offered_on_footpaths_at_the_right_lots(self):
        for name in ("commons", "island", "v4"):
            w = self.o[name]
            self.assertEqual(w["bad"], [], name)
            self.assertGreater(w["n"], 10, name)
            for k in ("taxi", "delivery", "van"):
                if k == "van" and not w["docks"]:
                    self.assertEqual(w["kinds"].get(k, 0), 0, name)     # no industry (the island): no van runs
                    continue
                self.assertGreater(w["kinds"].get(k, 0), 0, name + " " + k)
        self.assertGreater(self.o["commons"]["docks"], 0)

    def test_distances_are_sane(self):
        for name in ("commons", "island", "v4"):
            for kind_, k, d in self.o[name]["legs"]:
                if kind_ == "near":
                    self.assertLessEqual(d, 1600 if k == "van" else 1100, name + " " + k)
                elif k == "taxi":
                    self.assertTrue(100 <= d <= 2800, (name, k, d))
                elif k == "delivery":
                    self.assertTrue(20 <= d <= 900, (name, k, d))
                else:
                    self.assertTrue(100 <= d <= 3600, (name, k, d))

    def test_more_fares_at_night(self):
        for name in ("commons", "island", "v4"):
            self.assertGreater(self.o[name]["taxiNight"], self.o[name]["taxiDay"], name)

    def test_a_taxi_run_completes_and_pays(self):
        c = self.o["clean"]
        self.assertTrue(c["start"]["ok"])
        self.assertEqual(c["beacon"], c["from"])
        self.assertEqual(c["stepAfterPickup"], 1)
        self.assertRegex(c["hud"], r"^Fare: \d+:\d\d · \d")
        self.assertIsNone(c["active"])
        self.assertEqual([e[:3] for e in c["emits"]], [["job", "taxi", "start"], ["job", "taxi", "done"]])
        tip = c["emits"][1][3]
        self.assertGreater(tip, 0)
        self.assertEqual(c["stats"]["rep"], tip)
        self.assertEqual(c["stats"]["done"]["taxi"], 1)
        self.assertEqual(c["stats"]["streak"], 1)
        self.assertEqual(c["beaconEnd"], [])
        self.assertIn("done", c["hudEnd"])
        for t in c["said"]:
            self.assertFalse(re.search(r"\d{3,}", t.replace("City rep", "")) and "rep" not in t, t)

    def test_rams_pay_less(self):
        clean, rammed = self.o["clean"]["emits"][1][3], self.o["rammed"]["emits"][1][3]
        self.assertEqual(self.o["clean"]["offer"], self.o["rammed"]["offer"])
        self.assertLess(rammed, clean)

    def test_late_fails_and_wrong_vehicle_does_not_count(self):
        self.assertEqual(self.o["late"]["emits"], ["start:", "fail:late"])
        self.assertIsNone(self.o["late"]["active"])
        self.assertEqual(self.o["late"]["stats"]["fails"], 1)
        self.assertEqual(self.o["wrong"]["stepAfterPickup"], 0)
        self.assertIn("Get in a car", self.o["wrong"]["hud"])

    def test_the_store_round_trips(self):
        a, b = self.o["clean"], self.o["again"]
        self.assertEqual(b["stats"]["done"]["taxi"], 2)
        self.assertEqual(b["stats"]["rep"], 2*a["stats"]["rep"])
        self.assertEqual(b["stats"]["streak"], 2)
        self.assertEqual(b["stats"]["bestStreak"], 2)

    def test_van_run(self):
        v = self.o["van"]
        self.assertTrue(v["start"]["ok"])
        self.assertEqual(v["emits"][-1][:3], ["job", "van", "done"])
        self.assertEqual(v["stats"]["smooth"], 1)

    def test_dispose_clears_everything(self):
        d = self.o["dispose"]
        self.assertEqual(d["before"], [1, True])
        self.assertEqual(d["after"], [0, False, None])
        self.assertNotIn("done", d["emits"])
        self.assertFalse(self.o["disposeRestart"])

    def test_blocked_places(self):
        b = self.o["blocked"]
        self.assertIsNone(b["active"])
        self.assertEqual(b["emits"], ["start:", "fail:blocked"])
        self.assertEqual(b["fails"], 0)
        self.assertEqual(self.o["blockedStart"], {"ok": False, "reason": "blocked"})

    def test_co_op_spec(self):
        self.assertEqual(self.o["spec"], {"ok": True})
        self.assertEqual(self.o["specPt"], "sidewalk")
        self.assertFalse(self.o["specBad"]["ok"])
        self.assertEqual(self.o["specKind"], {"ok": False, "reason": "kind"})

    def test_rules(self):
        p = self.o["pay"]
        self.assertEqual(p[0], 40)
        self.assertEqual(p[1], 20)
        self.assertLess(p[2], p[0])
        self.assertEqual(p[3], 50)
        self.assertLess(p[4], p[0])
        self.assertEqual(self.o["ranks"], ["Rookie", "Rookie", "Pro", "Pro", "Legend", "Legend"])
        self.assertEqual(self.o["can"], [True, False, True, True, False, True, False, True, False])
        self.assertEqual(sorted(self.o["ach"]), ["jobs-first-fare", "jobs-gentle"])
        self.assertEqual(self.o["fmt"], ["1:42", "0:00", "640 m", "1.2 km"])

    def test_no_random_no_html(self):
        with open(os.path.join(ROOT, "games", "playjobs.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertNotIn("Math.random", src)
        self.assertNotIn("innerHTML", src)
        self.assertNotIn("fetch(", src)


@unittest.skipUnless(NODE, "node not installed")
class JobsApp(unittest.TestCase):
    def test_the_app_lists_starts_and_cancels(self):
        import sys
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        from test_hqphone import DOM
        script = DOM + r"""
import zlib from "zlib";
const R = %(root)s;
load("games/world.js"); load("games/citylife.js"); load("games/cityplay.js"); load("games/hqphone.js"); load("games/hqphoneapps.js"); load("games/playjobs.js");
const HQV = window.HQV, o = {};
const W = HQV.world.pack(JSON.parse(zlib.gunzipSync(fs.readFileSync(R + "/tests/fixtures/claude-hq@3.json.gz")).toString("utf8")));
const live = HQV.cityPlay.create(null, {W: W, local: function(ms){ return ms; }});
const T0 = Date.UTC(2026, 9, 26, 8, 15);
live.update(0.016, {ms: T0, local: T0, me: {x: 0, y: 0, z: 0, yaw: 0}, motion: {ride: null, speed: 0}});
const app = HQV.hqPhone.registry.get("jobs");
o.app = app ? [app.name, app.needsCity, app.dock] : null;
const said = [], nav = {close: function(){ o.closed = true; }, back: function(){}, open: function(){}, title: function(){}, setBadge: function(){}};
const host = {announce: function(t){ said.push(t); }, me: function(){ return {x: 0, z: 0}; }};
const el = document.body.appendChild(document.createElement("div"));
const h = app.render(el, host, nav);
const starts = el.querySelectorAll("button").filter(function(b){ return b.textContent === "Start"; });
o.starts = starts.length;
o.tabs = starts.map(function(b){ return b.tabIndex; });
o.label = starts[0].getAttribute("aria-label");
starts[0].focus(); starts[0].parentNode.key("ArrowDown");
o.moved = document.activeElement === starts[1] && starts[1].tabIndex === 0 && starts[0].tabIndex === -1;
o.curHidden0 = el.querySelector("section").hidden;
o.record = el.textContent.indexOf("Taxi fare: Rookie") >= 0 && el.textContent.indexOf("City rep") >= 0;
starts[0].click();
o.closed = !!o.closed; o.said = said.slice();
o.active = HQV.playJobs.live().active() ? HQV.playJobs.live().active().kind : null;
h.tick(T0 + 1000);
o.curHidden1 = el.querySelector("section").hidden;
o.disabled = el.querySelectorAll("button").filter(function(b){ return b.textContent === "Start"; }).every(function(b){ return b.disabled; });
find(el, "Cancel job").click();
o.after = HQV.playJobs.live().active();
o.curHidden2 = el.querySelector("section").hidden;
o.ach = HQV.hqPhoneApps.render.achievements(document.body.appendChild(document.createElement("div")), {}) ? document.body.textContent.indexOf("First fare") >= 0 : false;
h.dispose(); live.dispose();
console.log(JSON.stringify(o));
"""
        env = dict(os.environ, TZ="UTC")
        r = subprocess.run([NODE, "--input-type=module", "-"], input=script.replace("%(root)s", json.dumps(ROOT)),
                           capture_output=True, text=True, cwd=ROOT, timeout=120, env=env)
        if r.returncode:
            raise AssertionError(r.stderr[-3000:])
        o = json.loads(r.stdout.strip().splitlines()[-1])
        self.assertEqual(o["app"], ["Jobs", True, False])
        self.assertGreaterEqual(o["starts"], 3)
        self.assertEqual(o["tabs"].count(0), 1)
        self.assertTrue(o["label"].startswith("Start "))
        self.assertTrue(o["moved"])
        self.assertTrue(o["curHidden0"])
        self.assertTrue(o["record"])
        self.assertTrue(o["closed"])
        self.assertTrue(o["said"][-1].endswith("started"))
        self.assertIsNotNone(o["active"])
        self.assertFalse(o["curHidden1"])
        self.assertTrue(o["disabled"])
        self.assertIsNone(o["after"])
        self.assertTrue(o["curHidden2"])
        self.assertTrue(o["ach"])


if __name__ == "__main__":
    unittest.main()
