"""Road navigation (games/hqnav.js, docs/plans/nav-river-spec.md "Client: navigation").

hqnav.js is pure, so node loads it with games/world.js against a stub `window` and runs everything
below in one process; the Python side checks the numbers. On the real worlds (the Commons and an
island from the generator, tests/fixtures/*@2.json.gz, and Arena City claude-hq@1) a route exists
from the spawn to the dock (@2) and to a civic site (@1), is never shorter than the straight line and
starts and ends where asked; on synthetic L- and T-shaped graphs the turn steps come out right;
progress along a route is monotone and arrives; leaving the route triggers a reroute after 2 s; places
are sorted and tier-filtered; a route across the Commons takes under 15 ms. Skipped without node."""
import json
import math
import os
import re
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIX = os.path.join(ROOT, "tests", "fixtures")
NODE = shutil.which("node")
ME = "0b8e4c1a-3f2d-4e5b-9a6c-7d8e9f0a1b2c"
FRIEND = "11111111-2222-4333-8444-555555555555"

HARNESS = r"""
var fs = require("fs"), zlib = require("zlib"), root = %(root)s, FIX = %(fix)s, ME = %(me)s, FRIEND = %(friend)s;
global.window = {HQV: {}};
for (var f of ["world", "hqnav"]) new Function(fs.readFileSync(root + "/games/" + f + ".js", "utf8"))();
var WD = window.HQV.world, N = window.HQV.hqnav, out = {};
function gz(p){ return JSON.parse(zlib.gunzipSync(fs.readFileSync(FIX + "/" + p)).toString("utf8")); }
function now(){ var t = process.hrtime(); return t[0]*1e3 + t[1]/1e6; }
function site(W, id){ return W.sites.filter(function(s){ return s.id === id; })[0]; }
function summary(R, from, to){
  if(!R) return null;
  var P = R.pts, n = P.length;
  return {len: R.len, eta: R.eta_s, straight: Math.hypot(to.x - from.x, to.z - from.z), n: n/2,
          first: [P[0], P[1]], last: [P[n-2], P[n-1]], kinds: R.steps.map(function(s){ return s.kind; }),
          ats: R.steps.map(function(s){ return s.at; }), finite: Array.prototype.every.call(P, isFinite)};
}

/* ---------- the real worlds: spawn -> dock / civic site ---------- */
var worlds = {commons: WD.pack(gz("claude-hq@2.json.gz")), island: WD.pack(gz("island@2.json.gz")), v1: WD.pack(gz("claude-hq@1.json.gz"))};
out.real = {};
[["commons", 5], ["island", 5], ["island", 1], ["v1", 5]].forEach(function(c){
  var W = worlds[c[0]], tier = c[1], G = N.graph(W, tier), sp = site(W, "spawn:0"), from = {x: sp.x/100, z: sp.z/100};
  var P = N.places(W, tier, {x: from.x, z: from.z, island: c[0] === "island", me: ME});
  var goal = P.filter(function(p){ return c[0] === "v1" ? p.kind === "skatepark" : p.kind === "dock"; })[0];
  var r = {places: P.length, goal: goal ? goal.id : null, cached: N.graph(W, tier) === G, M: G.M};
  if(goal){
    r.drive = summary(N.route(G, from, goal.door, "drive"), from, goal.door);
    r.walk = summary(N.route(G, from, goal.door, "walk"), from, goal.door);
    r.door = [goal.door.x, goal.door.z];
  }
  out.real[c[0] + "@" + tier] = r;
});
// island tiers: fewer roads at tier 1 than at 5
out.islandEdges = [1, 2, 3, 4, 5].map(function(t){ return N.graph(worlds.island, t).M; });

/* ---------- snap ---------- */
(function(){
  var W = worlds.commons, G = N.graph(W, 5), e = W.edges[0], p = e.pts;
  var mx = (p[0] + p[3])/200, mz = (p[2] + p[5])/200;
  var s = N.snap(G, mx + 0.5, mz + 0.5), far = N.snap(G, 3000, 3000);
  out.snap = {ei: s.ei, d: s.d, s: s.s, far: far ? far.d : null};
})();

/* ---------- synthetic graphs (cm), a road per edge ---------- */
function mkW(nodes, edges){
  return {nodes: nodes.map(function(n, i){ return {id: i, x: n[0]*100, y: 0, z: n[1]*100}; }),
          edges: edges.map(function(e, i){
            var pts = new Int32Array(6);
            pts[0] = nodes[e[0]][0]*100; pts[2] = nodes[e[0]][1]*100; pts[3] = nodes[e[1]][0]*100; pts[5] = nodes[e[1]][1]*100;
            var o = {id: i, a: e[0], b: e[1], cls: e[3] || "local", width: 800, walk: 150, lanes: 1, name: e[2], pts: pts};
            if(e[4]) o.bridge = true;
            return o;
          }), sites: [], lots: []};
}
function kinds(W, from, to, mode){ var R = N.route(N.graph(W, 5), from, to, mode || "drive"); return R ? R.steps.map(function(s){ return [s.kind, s.road]; }) : null; }
// +x is WEST (N = +z, E = -x): heading north, a turn toward +x is a left turn
out.L = {
  left: kinds(mkW([[0, 0], [0, 100], [100, 100]], [[0, 1, "A St"], [1, 2, "B St"]]), {x: 0, z: 2}, {x: 95, z: 100}),
  right: kinds(mkW([[0, 0], [0, 100], [-100, 100]], [[0, 1, "A St"], [1, 2, "B St"]]), {x: 0, z: 2}, {x: -95, z: 100}),
  bendSameName: kinds(mkW([[0, 0], [0, 100], [100, 100]], [[0, 1, "A St"], [1, 2, "A St"]]), {x: 0, z: 2}, {x: 95, z: 100}),
  renamedStraight: kinds(mkW([[0, 0], [0, 100], [0, 200]], [[0, 1, "A St"], [1, 2, "B St"]]), {x: 0, z: 2}, {x: 0, z: 195}),
  bridge: kinds(mkW([[0, 0], [0, 100], [0, 140], [0, 240]], [[0, 1, "A St"], [1, 2, "A St", "local", true], [2, 3, "A St"]]), {x: 0, z: 2}, {x: 0, z: 235})
};
// a star at C (0, 100): the stem from the south, arms west (+x), east (-x), north, 45 deg west-north, and back south-west
var T = mkW([[0, 100], [0, 0], [100, 100], [-100, 100], [0, 200], [70, 170], [60, 30]],
            [[1, 0, "Main St"], [0, 2, "West Rd"], [0, 3, "East Rd"], [0, 4, "Main St"], [0, 5, "Slight Ln"], [0, 6, "Sharp Ln"]]);
var S0 = {x: 0, z: 3};
out.T = {left: kinds(T, S0, {x: 95, z: 100}), right: kinds(T, S0, {x: -95, z: 100}), straight: kinds(T, S0, {x: 0, z: 195}),
         slight: kinds(T, S0, {x: 63, z: 163}), sharp: kinds(T, S0, {x: 54, z: 37}),
         walk: kinds(T, S0, {x: 95, z: 100}, "walk")};
(function(){
  var G = N.graph(T, 5), R = N.route(G, S0, {x: 95, z: 100}, "drive"), Rw = N.route(G, S0, {x: 95, z: 100}, "walk");
  out.Teta = {len: R.len, drive: R.eta_s, walk: Rw.eta_s, at: R.steps.map(function(s){ return s.at; })};
  // a highway beats a longer local detour on time but not a shorter one
  var H = mkW([[0, 0], [0, 300], [40, 150]], [[0, 1, "Fast Way", "highway"], [0, 2, "Lane", "local"], [2, 1, "Lane", "local"]]);
  var RH = N.route(N.graph(H, 5), {x: 0, z: 1}, {x: 0, z: 299}, "drive");
  out.highway = RH.steps.map(function(s){ return s.road; });
  // unreachable: two separate roads still route, on the largest network
  var D = mkW([[0, 0], [0, 300], [500, 0], [500, 20]], [[0, 1, "Long Rd"], [2, 3, "Stub"]]);
  var RD = N.route(N.graph(D, 5), {x: 499, z: 10}, {x: 1, z: 290}, "walk");
  out.disconnected = RD ? {len: RD.len, roads: RD.steps.map(function(s){ return s.road; })} : null;
  // min_tier: a shortcut that opens at tier 3
  var M = mkW([[0, 0], [0, 100], [100, 100], [100, 0]], [[0, 1, "A"], [1, 2, "A"], [2, 3, "A"], [0, 3, "Short"]]);
  M.edges[3].min_tier = 3;
  out.tiers = [N.route(N.graph(M, 2), {x: 0, z: 1}, {x: 100, z: 1}, "walk").len, N.route(N.graph(M, 3), {x: 0, z: 1}, {x: 100, z: 1}, "walk").len];
})();

/* ---------- progress + reroute on the Commons ---------- */
(function(){
  var W = worlds.commons, G = N.graph(W, 5), sp = site(W, "spawn:0"), from = {x: sp.x/100, z: sp.z/100};
  var dock = N.places(W, 5, from).filter(function(p){ return p.kind === "dock"; })[0];
  // drive along the polyline every 1.5 m with a lateral wobble of `wob` m -> the largest slip back
  function drive(R, wob){
    var P = R.pts, prev = -1, r = {drop: 0, maxOff: 0, reroutes: 0, nextBehind: 0}, k = 0, p;
    for(var i = 0; i + 3 < P.length; i += 2){
      var dx = P[i+2] - P[i], dz = P[i+3] - P[i+1], L = Math.hypot(dx, dz), n = Math.max(1, Math.ceil(L/1.5));
      for(var j = 0; j < n; j++){
        var t = j/n, w = wob*Math.sin(k++*0.7), x = P[i] + dx*t - dz/L*w, z = P[i+1] + dz*t + dx/L*w;
        p = N.progress(R, x, z, k*100);
        r.drop = Math.max(r.drop, prev - p.along); prev = p.along; r.maxOff = Math.max(r.maxOff, p.off);
        if(N.needsReroute(p, "drive")) r.reroutes++;
        if(p.next.at < p.along - 1e-6) r.nextBehind++;
      }
    }
    r.k = k;
    return r;
  }
  var R = N.route(G, from, dock.door, "drive"), P = R.pts, clean = drive(R, 0), wob = drive(N.route(G, from, dock.door, "drive"), 3), k = clean.k;
  var end = N.progress(R, P[P.length-2], P[P.length-1], k*100);
  out.prog = {clean: clean, wob: wob, arrived: end.arrived, left: end.left, along: end.along, len: R.len,
              nextKind: end.next.kind, earlyArrived: N.progress(N.route(G, from, dock.door, "drive"), from.x, from.z, 0).arrived};
  // a step back by 40 m is held at 15 m
  var R2 = N.route(G, from, dock.door, "walk"), mid = Math.floor(R2.pts.length/4)*2;
  var a1 = N.progress(R2, R2.pts[mid], R2.pts[mid+1], 0).along;
  var back = 0, bi = mid;
  while(bi > 0 && back < 40){ bi -= 2; back += Math.hypot(R2.pts[bi+2] - R2.pts[bi], R2.pts[bi+3] - R2.pts[bi+1]); }
  var a2 = N.progress(R2, R2.pts[bi], R2.pts[bi+1], 0).along;
  out.slip = {a1: a1, a2: a2, back: back};
  // leave the route: 40 m off, sideways from a point on it
  var R3 = N.route(G, from, dock.door, "drive"), q = Math.floor(R3.pts.length/2/2)*2;
  var dx3 = R3.pts[q+2] - R3.pts[q], dz3 = R3.pts[q+3] - R3.pts[q+1], L3 = Math.hypot(dx3, dz3) || 1;
  var ox = R3.pts[q] - dz3/L3*40, oz = R3.pts[q+1] + dx3/L3*40;
  N.progress(R3, R3.pts[q], R3.pts[q+1], 0);
  var p0 = N.progress(R3, ox, oz, 1000), p1 = N.progress(R3, ox, oz, 2500), p2 = N.progress(R3, ox, oz, 3100);
  var back3 = N.progress(R3, R3.pts[q], R3.pts[q+1], 3200);
  out.reroute = {off: p2.off, r0: N.needsReroute(p0, "drive"), r1: N.needsReroute(p1, "drive"), r2: N.needsReroute(p2, "drive"),
                 walk: N.needsReroute(p2, "walk"), back: N.needsReroute(back3, "drive")};
})();

/* ---------- places ---------- */
(function(){
  var W = worlds.island, hqLot = W.lots.filter(function(l){ return l.kind === "hq"; })[0], other = W.lots.filter(function(l){ return l.kind === "building"; })[0];
  var o = {x: 0, z: 10, island: true, me: ME, hqs: [{userId: ME, name: "Me", lot: hqLot.id}, {userId: FRIEND, name: "Ada", lot: other}]};
  out.places = {};
  [1, 3, 5].forEach(function(t){
    var P = N.places(W, t, o);
    out.places[t] = P.map(function(p){ return {id: p.id, kind: p.kind, label: p.label, icon: p.icon, dist: p.dist, door: p.door, x: p.x, z: p.z}; });
  });
  out.siteTiers = {};
  W.sites.forEach(function(s){ out.siteTiers[s.id] = s.tier; });
  out.commonsTravel = N.places(worlds.commons, 5, {x: 0, z: 0, me: ME}).filter(function(p){ return p.kind === "travel"; })
    .map(function(p){ return {label: p.label, world: p.world}; });
  out.v1Kinds = N.places(worlds.v1, 5, {x: 0, z: 0, me: ME}).map(function(p){ return p.kind; });
  // the dock's door is on land (above the sea), the port's too
  var ok = {};
  ["island", "commons"].forEach(function(w){
    var Wx = worlds[w], sea = Wx.island.sea_cm/100;
    N.places(Wx, 5, {}).filter(function(p){ return p.kind === "dock" || p.kind === "port"; }).forEach(function(p){
      ok[w + ":" + p.id] = WD.heightAt(Wx, p.door.x, p.door.z) > sea;
    });
  });
  out.doorsOnLand = ok;
})();

/* ---------- performance: across the Commons ---------- */
(function(){
  var W = worlds.commons, t0 = now(), G = N.graph(W, 5), build = now() - t0, times = [], R;
  N.route(G, {x: -400, z: 0}, {x: 400, z: 0}, "drive");
  for(var i = 0; i < 15; i++){
    var a = {x: -420 + i*3, z: -60 + i*8}, b = {x: 420 - i*4, z: 50 - i*6};
    t0 = now(); R = N.route(G, a, b, i %% 2 ? "walk" : "drive"); times.push(now() - t0);
  }
  times.sort(function(a, b){ return a - b; });
  out.perf = {build: build, median: times[7], max: times[14], len: R ? R.len : null};
})();
process.stdout.write(JSON.stringify(out));
"""


@unittest.skipUnless(NODE, "node not installed")
class HqNavTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        src = HARNESS % {"root": json.dumps(ROOT), "fix": json.dumps(FIX), "me": json.dumps(ME), "friend": json.dumps(FRIEND)}
        res = subprocess.run([NODE, "-e", src], capture_output=True, text=True, timeout=120)
        if res.returncode != 0:
            raise AssertionError(res.stderr[-3000:])
        cls.out = json.loads(res.stdout)

    # ---------- real worlds ----------
    def test_routes_to_the_dock_and_a_civic_site(self):
        for key, r in self.out["real"].items():
            with self.subTest(world=key):
                self.assertTrue(r["cached"], "graph() is cached per W + tier")
                self.assertIsNotNone(r["goal"], "the dock (@2) / a civic site (@1) is a place")
                for mode in ("drive", "walk"):
                    R = r[mode]
                    self.assertIsNotNone(R, mode + " route exists")
                    self.assertTrue(R["finite"])
                    self.assertGreaterEqual(R["len"] + 1e-6, R["straight"], "never shorter than the straight line")
                    self.assertAlmostEqual(R["first"][0], 0.0, places=6)
                    self.assertAlmostEqual(R["first"][1], 10.0, places=6)
                    self.assertAlmostEqual(R["last"][0], r["door"][0], places=6)
                    self.assertAlmostEqual(R["last"][1], r["door"][1], places=6)
                    self.assertEqual(R["kinds"][0], "start")
                    self.assertEqual(R["kinds"][-1], "arrive")
                    self.assertEqual(R["ats"], sorted(R["ats"]), "steps in order along the route")
                    self.assertAlmostEqual(R["ats"][-1], R["len"], places=6)
                self.assertLess(r["drive"]["eta"], r["walk"]["eta"], "driving is faster")
                self.assertAlmostEqual(r["walk"]["eta"], r["walk"]["len"]/1.6, delta=1e-6 * r["walk"]["len"] + 1e-6)

    def test_tier_gates_roads(self):
        n = self.out["islandEdges"]
        self.assertEqual(n, sorted(n))
        self.assertLess(n[0], n[4])
        self.assertGreater(self.out["tiers"][0], self.out["tiers"][1] + 50, "the tier-3 shortcut is only used at tier 3")

    def test_snap(self):
        s = self.out["snap"]
        self.assertEqual(s["ei"], 0)
        self.assertLess(s["d"], 1.0)
        self.assertGreater(s["s"], 0)
        self.assertIsNotNone(s["far"])

    # ---------- turn steps ----------
    def test_L_turns(self):
        L = self.out["L"]
        self.assertEqual(L["left"], [["start", "A St"], ["left", "B St"], ["arrive", "B St"]])
        self.assertEqual(L["right"], [["start", "A St"], ["right", "B St"], ["arrive", "B St"]])
        self.assertEqual(L["bendSameName"], [["start", "A St"], ["arrive", "A St"]], "a bend that is no junction is no step")
        self.assertEqual(L["renamedStraight"], [["start", "A St"], ["straight", "B St"], ["arrive", "B St"]])
        self.assertEqual(L["bridge"], [["start", "A St"], ["bridge", "A St"], ["arrive", "A St"]])

    def test_T_turns(self):
        T = self.out["T"]
        self.assertEqual(T["left"], [["start", "Main St"], ["left", "West Rd"], ["arrive", "West Rd"]])
        self.assertEqual(T["walk"], T["left"])
        self.assertEqual(T["right"], [["start", "Main St"], ["right", "East Rd"], ["arrive", "East Rd"]])
        self.assertEqual(T["straight"], [["start", "Main St"], ["arrive", "Main St"]], "straight on, same name: merged away")
        self.assertEqual(T["slight"], [["start", "Main St"], ["slight-left", "Slight Ln"], ["arrive", "Slight Ln"]])
        self.assertEqual(T["sharp"], [["start", "Main St"], ["sharp-left", "Sharp Ln"], ["arrive", "Sharp Ln"]])
        e = self.out["Teta"]
        self.assertAlmostEqual(e["at"][1], 97.0, places=6, msg="the turn sits at the junction")
        self.assertAlmostEqual(e["len"], 97 + 95, places=6)
        self.assertAlmostEqual(e["walk"], e["len"]/1.6, places=6)
        self.assertAlmostEqual(e["drive"], e["len"]/12, places=6)

    def test_highway_and_disconnected(self):
        self.assertEqual(self.out["highway"], ["Fast Way", "Fast Way"])
        d = self.out["disconnected"]
        self.assertIsNotNone(d, "a route snaps onto the largest network when the ends are apart")
        self.assertEqual(set(d["roads"]), {"Long Rd"})

    # ---------- progress ----------
    def test_progress_monotone_and_arrives(self):
        p = self.out["prog"]
        c, w = p["clean"], p["wob"]
        self.assertLessEqual(c["drop"], 1e-6, "along never goes backwards driving forward on the line")
        self.assertLess(c["maxOff"], 1e-6)
        self.assertLess(w["drop"], 6, "a 3 m wobble through corners slips back a few metres at most")
        self.assertLess(w["maxOff"], 3.5)
        for r in (c, w):
            self.assertEqual(r["reroutes"], 0)
            self.assertEqual(r["nextBehind"], 0, "the next step is always ahead")
        self.assertTrue(p["arrived"])
        self.assertFalse(p["earlyArrived"])
        self.assertAlmostEqual(p["along"], p["len"], places=6)
        self.assertAlmostEqual(p["left"], 0, places=6)
        self.assertEqual(p["nextKind"], "arrive")
        s = self.out["slip"]
        self.assertGreaterEqual(s["back"], 40)
        self.assertAlmostEqual(s["a2"], s["a1"] - 15, places=6, msg="held 15 m back")

    def test_reroute(self):
        r = self.out["reroute"]
        self.assertGreater(r["off"], 25)
        self.assertFalse(r["r0"], "just left: not yet")
        self.assertFalse(r["r1"], "1.5 s off: not yet")
        self.assertTrue(r["r2"], "2.1 s off: reroute")
        self.assertTrue(r["walk"])
        self.assertFalse(r["back"], "back on the route")

    # ---------- places ----------
    def test_places(self):
        P, tiers = self.out["places"], self.out["siteTiers"]
        allowed = {"dock", "port", "transit", "airport", "townhall", "hospital", "clinic", "police", "fire", "school",
                   "university", "market", "mall", "bank", "library", "post", "stadium", "fountain", "skatepark",
                   "myhq", "hq", "travel"}
        for t, lst in P.items():
            with self.subTest(tier=t):
                d = [p["dist"] for p in lst]
                self.assertEqual(d, sorted(d))
                for p in lst:
                    self.assertIn(p["kind"], allowed)
                    self.assertTrue(p["label"] and p["icon"])
                    if p["id"] in tiers:
                        self.assertLessEqual(tiers[p["id"]], int(t), p["id"] + " is open at this tier")
                    self.assertAlmostEqual(math.hypot(p["door"]["x"], p["door"]["z"] - 10), p["dist"], places=6)
                kinds = [p["kind"] for p in lst]
                self.assertEqual(kinds.count("myhq"), 1)
                self.assertEqual(kinds.count("hq"), 1)
                self.assertIn("Ada's HQ", [p["label"] for p in lst])
                self.assertIn("The Commons (ferry)", [p["label"] for p in lst])
                self.assertNotIn("busstop", kinds)
        k1, k5 = {p["kind"] for p in P["1"]}, {p["kind"] for p in P["5"]}
        self.assertNotIn("port", k1)
        self.assertNotIn("hospital", k1)
        self.assertIn("port", k5)
        self.assertIn("stadium", k5)
        self.assertGreater(len(P["5"]), len(P["1"]))
        self.assertEqual(self.out["commonsTravel"], [{"label": "My island (ferry)", "world": "user:%s@2" % ME}])
        self.assertEqual(set(self.out["v1Kinds"]), {"fountain", "skatepark"})
        self.assertTrue(self.out["doorsOnLand"] and all(self.out["doorsOnLand"].values()), self.out["doorsOnLand"])

    # ---------- performance + style ----------
    def test_performance(self):
        p = self.out["perf"]
        self.assertIsNotNone(p["len"])
        self.assertGreater(p["len"], 800)
        self.assertLess(p["median"], 15, "a cross-Commons route under 15 ms")

    def test_pure_and_safe(self):
        with open(os.path.join(ROOT, "games", "hqnav.js"), encoding="utf-8") as f:
            src = f.read()
        for bad in ("document.", "innerHTML", "fetch(", "XMLHttpRequest", "THREE.", "localStorage"):
            self.assertFalse(bad in src, bad)
        self.assertIsNone(re.search(r"Math\.min\(\s*1\s*,[^)]*dt", src))


if __name__ == "__main__":
    unittest.main()
