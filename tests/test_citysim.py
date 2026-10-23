"""The city's event director (games/citysim.js, Living City plan 2.1) on the real @2 fixtures and the npc town.

citysim.js is pure, so node loads it against a stub `window` with tests/fixtures/claude-hq@2.json.gz,
island@2.json.gz and npc_town@2.json, runs every scenario in one process and prints the numbers; the Python
side checks them: determinism whatever the query order (and across fresh instances), rates per hour against
D.rates, every unit from a real station of its kind with a reachable scene and ordered times, monotonic
phases, never two fires on one lot at once, three matches a week, school runs Mon-Fri at 08:00 / 15:00 on
the city's clock, coverage making things worse, and a day of events in under 50 ms. Skipped when node is not
installed. Stdlib only."""
import json
import os
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")

HARNESS = r"""
var fs = require("fs"), zlib = require("zlib"), root = %(root)s;
global.window = {HQV: {}};
new Function(fs.readFileSync(root + "/games/citysim.js", "utf8"))();
var C = window.HQV.citySim, out = {};
function load(f){ var b = fs.readFileSync(root + "/tests/fixtures/" + f); return JSON.parse(/\.gz$/.test(f) ? zlib.gunzipSync(b) : b); }
var docs = {hq: load("claude-hq@2.json.gz"), island: load("island@2.json.gz"), town: load("npc_town@2.json")};
var H = 3600000, DAY = 24*H, T0 = Date.UTC(2026, 9, 19);      // a Monday, 00:00 UTC
var EMERG = ["fire", "medical", "crime", "crash"];

// ---- performance: a fresh instance, a whole day of events ----
out.perf = {};
Object.keys(docs).forEach(function(k){
  var t = process.hrtime.bigint(), D = C.create(docs[k], {tier: 5}), n = D.events(T0 + 3*DAY, T0 + 4*DAY).length;
  out.perf[k] = {ms: Number(process.hrtime.bigint() - t)/1e6, n: n};
  t = process.hrtime.bigint();
  for(var i = 0; i < 60; i++) D.active(T0 + 3*DAY + i*1000);
  out.perf[k].activeMs = Number(process.hrtime.bigint() - t)/1e6/60;
});

// ---- determinism: forward by day, backward by hour, scattered first; a fresh instance; another seed ----
(function(){
  var o = {tier: 4, coverage: 0.6}, A = C.create(docs.hq, o), B = C.create(docs.hq, o), E = C.create(docs.hq, o);
  var S = C.create(docs.hq, {tier: 4, coverage: 0.6, seed: "other"}), span = 3*DAY, a = {}, b = {}, e = {}, s = {};
  function put(m, list){ list.forEach(function(ev){ m[ev.id] = JSON.stringify(ev); }); }
  for(var d = 0; d < 3; d++) put(a, A.events(T0 + d*DAY, T0 + (d + 1)*DAY));
  for(var h = 71; h >= 0; h--) put(b, B.events(T0 + h*H, T0 + (h + 1)*H));
  [50, 3, 61, 17, 9, 40].forEach(function(h){ E.active(T0 + h*H + 1234); E.unitsAt(T0 + h*H); });
  put(e, E.events(T0, T0 + span));
  put(s, S.events(T0, T0 + span));
  var same = 0, diff = 0, other = 0;
  Object.keys(a).forEach(function(id){ if(a[id] === b[id] && a[id] === e[id]) same++; else diff++; if(s[id] !== a[id]) other++; });
  var actSame = true;
  for(var t = T0; t < T0 + span; t += 7*60000 + 13){
    if(JSON.stringify(A.active(t)) !== JSON.stringify(C.create(docs.hq, o).active(t))) { actSame = false; break; }
    if(t > T0 + 4*H) break;
  }
  out.det = {n: Object.keys(a).length, same: same, diff: diff, nb: Object.keys(b).length, ne: Object.keys(e).length,
             otherSeedDiffers: other, activeFresh: actSame};
})();

// ---- rates, units, phases, fires per lot: 14 days on each fixture ----
out.fix = {};
[["hq", {tier: 3}], ["hq", {tier: 5, coverage: 0}], ["island", {tier: 3}], ["town", {tier: 5}]].forEach(function(cfg){
  var D = C.create(docs[cfg[0]], cfg[1]), days = 14, list = D.events(T0, T0 + days*DAY);
  var sites = {}; (docs[cfg[0]].layers.sites).forEach(function(s){ sites[s.id] = s; });
  var nodes = {}; docs[cfg[0]].layers.roads.nodes.forEach(function(n){ nodes[n.id] = 1; });
  var r = {name: cfg[0] + JSON.stringify(cfg[1]), counts: {}, rates: D.rates, hours: days*24, bad: [], phaseBad: [], fireClash: 0,
           maxDur: 0, emergencies: 0, longRoutes: 0, crimes: 0, kinds: {}};
  list.forEach(function(ev){
    if(ev.start < T0 || ev.start >= T0 + days*DAY) return;
    r.counts[ev.kind] = (r.counts[ev.kind] || 0) + 1;
    if(C.KINDS[ev.kind].win) r.maxDur = Math.max(r.maxDur, ev.end - ev.start);
    if(!(ev.end >= ev.start) || !nodes.hasOwnProperty(ev.node)) r.bad.push(ev.id + " node/end");
    ev.units.forEach(function(u){
      r.kinds[u.kind] = 1;
      if(!(u.dispatch >= ev.start && u.arrive >= u.dispatch && u.leave >= u.arrive && u.back >= u.leave && u.back <= ev.end))
        r.bad.push(ev.id + " times " + u.kind);
      if(u.drop != null && !(u.drop >= u.leave && u.drop <= u.back)) r.bad.push(ev.id + " drop");
      if(!nodes.hasOwnProperty(u.node)) r.bad.push(ev.id + " unit node");
      if(u.kind === "getaway") return;
      // a school bus or a market van comes from somewhere else: it has a road to drive
      if((ev.kind === "school" || ev.kind === "market") && !(D.dist(u.home, u.node) > 0)) r.bad.push(ev.id + " no drive " + u.kind);
      if(ev.kind === "school" && u.station === ev.site) r.bad.push(ev.id + " bus from its own school");
      var s = sites[u.station];
      if(!s || C.STATIONS[u.kind].indexOf(s.kind) < 0) r.bad.push(ev.id + " station " + u.station + " for " + u.kind);
      else if(!isFinite(D.dist(u.home, u.node)) || !isFinite(D.dist(u.home, ev.node))) r.bad.push(ev.id + " unreachable");
    });
    if(ev.dest != null && (!sites[ev.dest] || ["hospital", "clinic"].indexOf(sites[ev.dest].kind) < 0)) r.bad.push(ev.id + " dest");
    if(EMERG.indexOf(ev.kind) >= 0){
      r.emergencies++;
      if(!ev.units.length) r.bad.push(ev.id + " no units");
      // phases never go back, start reported (or responding) and end done
      var last = -1, ok = true;
      for(var i = 0; i <= 120; i++){
        var p = C.PHASES.indexOf(D.phase(ev, ev.start + (ev.end - ev.start)*i/120));
        if(p < last) ok = false; last = p;
      }
      if(!ok || D.phase(ev, ev.start) !== "reported" || D.phase(ev, ev.end) !== "done") r.phaseBad.push(ev.id);
    }
    if(ev.kind === "crime"){
      r.crimes++; if(ev.routeLen >= 1000 && ev.route.length >= 2) r.longRoutes++;
      // the roadblock is where the route ends (metres), its heading from the node before
      var bn = docs[cfg[0]].layers.roads.nodes.filter(function(n){ return n.id === ev.route[ev.route.length - 1]; })[0];
      if(!ev.block || !bn || Math.abs(ev.block.x - bn.x/100) > 0.01 || Math.abs(ev.block.z - bn.z/100) > 0.01 || !isFinite(ev.block.fx)) r.bad.push(ev.id + " block");
    }
  });
  var fires = list.filter(function(e){ return e.kind === "fire"; });
  for(var i = 0; i < fires.length; i++) for(var j = i + 1; j < fires.length; j++)
    if(fires[i].lot === fires[j].lot && fires[i].start < fires[j].end && fires[j].start < fires[i].end) r.fireClash++;
  // response: the first arrival after the report, for fires
  var resp = fires.map(function(e){ return (e.arrive - e.start)/1000; });
  r.fireResp = resp.length ? resp.reduce(function(a, b){ return a + b; })/resp.length : 0;
  out.fix[r.name] = r;
});

// ---- local-day events: matches, school, market, rush on a +05:30 clock ----
(function(){
  var tz = 330, D = C.create(docs.hq, {tier: 5, tzMin: tz}), d1 = C.create(docs.hq, {tier: 1, tzMin: tz});
  var list = D.events(T0, T0 + 28*DAY), loc = function(ms){ var t = new Date(ms + tz*60000); return {dow: t.getUTCDay(), h: t.getUTCHours() + t.getUTCMinutes()/60}; };
  var m = list.filter(function(e){ return e.kind === "match" && e.kick >= T0 && e.kick < T0 + 28*DAY; });
  out.match = {n: m.length, kicks: m.map(function(e){ var L = loc(e.kick); return [L.dow, L.h, (e.kick - e.start)/60000, (e.clear - e.kick)/60000]; }),
               tier1: d1.events(T0, T0 + 28*DAY).filter(function(e){ return e.kind === "match"; }).length};
  var s = list.filter(function(e){ return e.kind === "school" && e.start >= T0 && e.start < T0 + 14*DAY; });
  out.school = {n: s.length, bells: s.map(function(e){ var L = loc(e.bell); return [L.dow, L.h]; }), units: s.map(function(e){ return e.units.length; })};
  var mk = list.filter(function(e){ return e.kind === "market" && e.start >= T0 && e.start < T0 + 14*DAY; });
  out.market = mk.map(function(e){ var L = loc(e.start); return [L.dow, L.h]; });
  var at = {};
  [[0, 8], [0, 12], [2, 19], [5, 8], [6, 8]].forEach(function(q){
    // T0 is a Monday: local Monday 08:00 is T0 + 8 h - tz
    var ms = T0 + q[0]*DAY + q[1]*H - tz*60000, A = D.at(ms);
    at[q.join(":")] = {rush: A.rush, school: A.school && A.school.kind, match: !!A.match, market: !!A.market, festival: !!A.festival};
  });
  out.at = at;
  // the Saturday match: D.at sees it, unitsAt has its police on duty
  var sat = m.filter(function(e){ return loc(e.kick).dow === 6; })[0];
  out.atMatch = sat ? {match: D.at(sat.kick + H).match && D.at(sat.kick + H).match.id === sat.id,
                       police: D.unitsAt(sat.kick).filter(function(u){ return u.ev.id === sat.id; }).length} : null;
})();

// ---- coverage: poor fire cover means more fires and slower arrivals ----
(function(){
  var good = C.create(docs.island, {tier: 4, coverage: 1}), poor = C.create(docs.island, {tier: 4, coverage: {fire: 0.1}});
  function fires(D){ var f = D.events(T0, T0 + 7*DAY).filter(function(e){ return e.kind === "fire"; });
    return {n: f.length, resp: f.reduce(function(a, e){ return a + (e.arrive - e.start); }, 0)/Math.max(1, f.length)/1000,
            dur: f.reduce(function(a, e){ return a + (e.done - e.arrive); }, 0)/Math.max(1, f.length)/1000}; }
  out.cover = {good: fires(good), poor: fires(poor), crimeSame: good.rates.crime === poor.rates.crime};
})();

// ---- unitsAt along a fire, an ambulance run and a chase ----
(function(){
  var D = C.create(docs.hq, {tier: 5}), list = D.events(T0, T0 + 2*DAY), seen = {};
  function phases(ev){
    var ph = {};
    for(var t = ev.start; t < ev.end; t += 5000) D.unitsAt(t).forEach(function(u){ if(u.ev.id === ev.id) ph[u.unit.kind + ":" + u.phase] = 1; });
    return Object.keys(ph).sort();
  }
  var f = list.filter(function(e){ return e.kind === "fire"; })[0], m = list.filter(function(e){ return e.kind === "medical" && e.dest; })[0];
  var c = list.filter(function(e){ return e.kind === "crime"; })[0];
  out.units = {fire: phases(f), medical: phases(m), crime: phases(c),
               activeHas: D.active(f.arrive).some(function(e){ return e.id === f.id; }), notBefore: D.active(f.start - 1).some(function(e){ return e.id === f.id; }),
               notAfter: D.active(f.end).some(function(e){ return e.id === f.id; })};
})();

console.log(JSON.stringify(out));
"""


@unittest.skipUnless(NODE, "node is not installed")
class CitySim(unittest.TestCase):
    out = None

    @classmethod
    def setUpClass(cls):
        js = HARNESS % {"root": json.dumps(ROOT)}
        p = subprocess.run([NODE, "-e", js], capture_output=True, text=True, timeout=300)
        if p.returncode:
            raise AssertionError(p.stderr[-4000:])
        cls.out = json.loads(p.stdout.strip().splitlines()[-1])

    def test_perf(self):
        for k, v in self.out["perf"].items():
            self.assertGreater(v["n"], 20, k)
            self.assertLess(v["ms"], 50, k)          # a fresh instance, 24 h of events (graph + Dijkstras included)
            self.assertLess(v["activeMs"], 2, k)     # a frame's active() once warm

    def test_determinism(self):
        d = self.out["det"]
        self.assertGreater(d["n"], 100)
        self.assertEqual(d["diff"], 0)
        self.assertEqual(d["n"], d["nb"])
        self.assertEqual(d["n"], d["ne"])
        self.assertTrue(d["activeFresh"])
        self.assertGreater(d["otherSeedDiffers"], d["n"]*0.5)

    def test_rates(self):
        for name, r in self.out["fix"].items():
            for k in ("fire", "medical", "crime", "crash"):
                want = r["rates"][k]*r["hours"]
                got = r["counts"].get(k, 0)
                # a binomial count with a few calls off (fires on a burning lot, no station in reach)
                self.assertGreater(got, want*0.7, (name, k, got, want))
                self.assertLess(got, want*1.3, (name, k, got, want))
            self.assertGreater(r["counts"].get("patrol", 0), 0, name)
            self.assertGreater(r["counts"].get("delivery", 0), 0, name)

    def test_units_and_scenes(self):
        for name, r in self.out["fix"].items():
            self.assertEqual(r["bad"], [], name)
            self.assertLess(r["maxDur"], 3*3600*1000, name)     # LOOK: no windowed event outlasts the look-back
            self.assertGreater(r["emergencies"], 100, name)
            self.assertGreaterEqual(r["longRoutes"], r["crimes"]*0.9, name)   # getaways run 1.2-3 km
        kinds = set()
        for r in self.out["fix"].values():
            kinds |= set(r["kinds"])
        self.assertEqual(kinds, {"fire", "ambulance", "police", "tow", "van", "schoolbus", "getaway"})

    def test_phases_monotonic(self):
        for name, r in self.out["fix"].items():
            self.assertEqual(r["phaseBad"], [], name)

    def test_no_two_fires_on_a_lot(self):
        for name, r in self.out["fix"].items():
            self.assertEqual(r["fireClash"], 0, name)

    def test_matches(self):
        m = self.out["match"]
        self.assertEqual(m["n"], 12)                 # 3 a week for 4 weeks
        self.assertEqual(m["tier1"], 0)              # no stadium yet
        for dow, h, before, length in m["kicks"]:
            self.assertIn((dow, h), {(3, 19.5), (6, 15), (0, 17)})
            self.assertEqual(before, 45)
            self.assertEqual(length, 120)
        self.assertEqual(self.out["atMatch"], {"match": True, "police": 2})

    def test_school_and_days(self):
        s = self.out["school"]
        self.assertEqual(s["n"], 2*10)               # one school, two runs, ten school days
        for dow, h in s["bells"]:
            self.assertIn(dow, range(1, 6))
            self.assertIn(h, (8, 15))
        self.assertTrue(all(n == 2 for n in s["units"]))
        self.assertEqual(sorted(self.out["market"]), [[3, 7], [3, 7], [6, 7], [6, 7]])
        at = self.out["at"]
        self.assertEqual(at["0:8"]["rush"], 1)
        self.assertEqual(at["0:8"]["school"], "school")
        self.assertEqual(at["0:12"]["rush"], 0)
        self.assertEqual(at["5:8"]["rush"], 0)       # Saturday
        self.assertTrue(at["5:8"]["market"])
        self.assertIsNone(at["6:8"]["school"])       # Sunday
        self.assertTrue(at["2:19"]["match"])         # Wednesday kick-off 19:30: fans arriving

    def test_coverage(self):
        c = self.out["cover"]
        self.assertGreater(c["poor"]["n"], c["good"]["n"]*1.3)
        self.assertGreater(c["poor"]["resp"], c["good"]["resp"])
        self.assertGreater(c["poor"]["dur"], c["good"]["dur"])
        self.assertTrue(c["crimeSame"])

    def test_units_at(self):
        u = self.out["units"]
        self.assertTrue({"fire:responding", "fire:onscene", "fire:returning"} <= set(u["fire"]), u["fire"])
        self.assertTrue({"ambulance:responding", "ambulance:onscene", "ambulance:transport", "ambulance:returning"} <= set(u["medical"]), u["medical"])
        self.assertTrue({"getaway:chase", "police:chase", "police:onscene"} <= set(u["crime"]), u["crime"])
        self.assertTrue(u["activeHas"])
        self.assertFalse(u["notBefore"])
        self.assertFalse(u["notAfter"])


if __name__ == "__main__":
    unittest.main()
