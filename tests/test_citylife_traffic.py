"""City life in the traffic and on the street (HQ 3.21): games/traffic.js with games/citylife.js, and
games/cityevents3d.js.

Under node on the @3 fixture (tests/fixtures/claude-hq@3.json.gz), the local clock taken as UTC (o.local 0):
fewer cars are out at 03:00 than at the 08:15 rush; the industrial district sends vans and lorries, the night more
taxis; no car is on a closed street while it is closed (roadworks injected on an arterial, and the real Sunday
parade) and cars use it again afterwards; without city life the traffic is today's. cityevents3d builds stalls only
on market days and hours, roadworks only on weekdays 09-16 and the parade only on Sunday 15:00-16:30, its barriers
block, and it all is a pure function of the world and the clock. Skipped without node. Stdlib only."""
import json
import os
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")
FIXTURE = os.path.join(ROOT, "tests", "fixtures", "claude-hq@3.json.gz")

HARNESS = r"""
import fs from "fs";
import zlib from "zlib";
const root = %(root)s;
globalThis.window = {HQV: {}};
for (const f of ["world", "citylife", "traffic", "cityevents3d"]) new Function(fs.readFileSync(root + "/games/" + f + ".js", "utf8"))();
const THREE = await import(root + "/games/vendor/three-module.js");
const H = window.HQV, WD = H.world, L = H.cityLife, T = H.traffic, CE = H.cityEvents3d, out = {};
function pack(){ return WD.pack(JSON.parse(zlib.gunzipSync(fs.readFileSync(root + "/tests/fixtures/claude-hq@3.json.gz")).toString("utf8"))); }
const W = pack(), ALL = {x: 0, z: 0}, FAR = 1e9;
function sim(o){ return T.create(WD.docOf(W), Object.assign({tier: 5, seed: W.id, W: W, local: 0}, o || {})); }
function cars(s, ms){ return s.at(ms, ALL, FAR).filter(function(v){ return v.kind === "car"; }); }
function share(list, keys){ return list.length ? list.filter(function(c){ return keys.indexOf(c.type) >= 0; }).length/list.length : 0; }
const MON = Date.UTC(2026, 9, 26), SUN = Date.UTC(2026, 9, 25), WED = Date.UTC(2026, 9, 28), THU = Date.UTC(2026, 9, 29), SAT = Date.UTC(2026, 9, 24), HR = 36e5;
const s = sim();

// ---- demand: by the hour, a multiplier on today's density ----
out.info = s.info();
out.count = {h3: cars(s, MON + 3*HR).length, h815: cars(s, MON + 8.25*HR).length, h13: cars(s, MON + 13*HR).length, all: s.info().cars};
const off = T.create(WD.docOf(W), {tier: 5, seed: W.id, W: W, life: false}), offCars = cars(off, MON + 3*HR);
out.off = {n: offCars.length, cars: off.info().cars, types: offCars.filter(function(v){ return v.type !== "car"; }).length,
           same: (function(){ const CLs = H.cityLife; delete H.cityLife; const bare = T.create(WD.docOf(W), {tier: 5, seed: W.id, W: W}); H.cityLife = CLs;
             return !bare.info().life && JSON.stringify(cars(off, MON + 3*HR + 5000)) === JSON.stringify(cars(bare, MON + 3*HR + 5000)); })()};

// ---- the mix: the district and the hour ----
const ind = sim({groupAt: function(){ return "industry"; }}), indCars = ind.cars(MON + 9*HR), allCars = s.cars(MON + 9*HR);
// (on the main roads: how much of the traffic is on them, and how much on the ring, moves with the world's road widths)
function onMain(sim, cs){ return cs.filter(function(c){ return sim._.rings[c.ring].kindL === "main"; }); }
out.mix = {industry: share(onMain(ind, indCars), ["van", "lorry"]), lorries: indCars.filter(function(c){ return c.type === "lorry"; }).length,
           city: share(onMain(s, allCars), ["van", "lorry"]), taxiNight: share(s.cars(MON + 23*HR), ["taxi"]), taxiDay: share(s.cars(MON + 13*HR), ["taxi"]),
           kinds: {}, groups: {}};
indCars.concat(allCars).forEach(function(c){ if(c.type === "lorry") out.mix.kinds[s._.rings[c.ring].kindL] = 1; });
allCars.forEach(function(c){ out.mix.groups[c.group] = 1; });
out.mix.lorryOnTwo = indCars.filter(function(c){ return c.type === "lorry"; }).every(function(c){ var r = ind._.rings[c.ring]; return !r.uturn; });
// the mix picks lorries; only a platoon's first car drives one (a follower's pick is a van), so whether any is out at
// 09:00 depends on which slots lead: count the picks, and check every lorry out leads its platoon
var lorryPicks = 0, lorryLead = true;
ind._.rings.forEach(function(r){ (r.cars || []).forEach(function(c){
  if(L.pick(L.mix("industry", r.kindL, 9), c.ut) === "lorry") lorryPicks++;
  if(c.st && c.st.type === "lorry" && c.fol > 0) lorryLead = false;
}); });
out.mix.lorryPicks = lorryPicks; out.mix.lorryLead = lorryLead;

// ---- closures: no car on a closed edge while it is closed; back on it afterwards ----
function corridor(id){
  const e = W.edges.filter(function(x){ return x.id === id; })[0], P = [];
  for(let i = 0; i + 2 < e.pts.length; i += 3) P.push([e.pts[i]/100, e.pts[i + 2]/100]);
  const half = Math.max(1.5, (e.width - 2*e.walk)/200);
  let len = 0; for(let i = 1; i < P.length; i++) len += Math.hypot(P[i][0] - P[i-1][0], P[i][1] - P[i-1][1]);
  // inside the carriageway, clear of the junction boxes at the ends (10 m)
  return function(x, z){
    let acc = 0;
    for(let i = 1; i < P.length; i++){
      const ax = P[i-1][0], az = P[i-1][1], ux = P[i][0] - ax, uz = P[i][1] - az, l = Math.hypot(ux, uz) || 1;
      const t = Math.max(0, Math.min(1, ((x - ax)*ux + (z - az)*uz)/(l*l))), along = acc + t*l;
      if(along > 10 && along < len - 10 && Math.hypot(x - ax - ux*t, z - az - uz*t) < half) return true;
      acc += l;
    }
    return false;
  };
}
// the busiest ring the parade does not touch; its longest edge gets weekday roadworks (as cityLife's, on an arterial)
const parade = {}; L.events(W, SUN + 15.5*HR).forEach(function(ev){ if(ev.kind === "parade") ev.edges.forEach(function(id){ parade[id] = 1; }); });
const ring = s._.rings.filter(function(r){ return r.cars.length && !r.lanes.some(function(ln){ return parade[ln.e.id]; }); }).sort(function(a, b){ return b.cars.length - a.cars.length; })[0];
const X = ring.lanes.slice().sort(function(a, b){ return b.e.len - a.e.len; })[0].e.id;
function works(ms){ const wd = L.weekday(ms), h = L.hourOf(ms), o = {}; if(wd >= 1 && wd <= 5 && h >= 9 && h < 16) o[X] = "roadworks"; return o; }
const sw = sim({closed: works}), inX = corridor(X);
function onX(s0, t0, t1, step){ let n = 0; for(let t = t0; t < t1; t += step) n += cars(s0, t).filter(function(v){ return inX(v.x, v.z); }).length; return n; }
out.closed = {edge: X, before: onX(sw, MON + 8*HR, MON + 8.5*HR, 1000), during: onX(sw, MON + 9*HR, MON + 16*HR, 5000) + onX(sw, MON + 9*HR - 1, MON + 9*HR + 60e3, 500) + onX(sw, MON + 16*HR - 120e3, MON + 16*HR, 500), after: onX(sw, MON + 16.5*HR, MON + 17*HR, 1000),
              map: sw.closed(MON + 10*HR), none: sw.closed(MON + 17*HR), ringOut: sw.cars(MON + 12*HR).filter(function(c){ return c.ring === ring.id && c.show; }).length};
const pIn = Object.keys(parade).map(function(id){ return corridor(+id); });
function onParade(t0, t1, step){ let n = 0; for(let t = t0; t < t1; t += step) n += cars(s, t).filter(function(v){ return pIn.some(function(f){ return f(v.x, v.z); }); }).length; return n; }
out.parade = {edges: Object.keys(parade).length, before: onParade(SUN + 13*HR, SUN + 13.5*HR, 1000), during: onParade(SUN + 15*HR, SUN + 16.5*HR, 3000) + onParade(SUN + 16.5*HR - 120e3, SUN + 16.5*HR, 500), after: onParade(SUN + 17*HR, SUN + 17.5*HR, 1000)};

// ---- determinism ----
const s2 = T.create(WD.docOf(pack()), {tier: 5, seed: W.id, W: pack(), local: 0});
out.det = [MON + 8.25*HR, MON + 23*HR, SUN + 15.5*HR].every(function(t){ return JSON.stringify(cars(s2, t)) === JSON.stringify(cars(sim(), t)); });
// a local offset is a clock shift: 08:15 local at UTC+2 is 06:15 UTC
// (laps run on the shared clock: a ring whose lap does not divide the 2 h starts its laps at other local times, so its
// cars' hours differ by up to a lap; the rings whose laps divide it see exactly the same)
const tz = T.create(WD.docOf(W), {tier: 5, seed: W.id, W: W, local: 2*HR}), s3 = sim();
function even(c){ var T0 = s3._.rings[c.ring].prof.T; return Math.abs(7200/T0 - Math.round(7200/T0)) < 1e-6; }
const tzA = tz.cars(MON + 6.25*HR), tzB = s3.cars(MON + 8.25*HR);
// (enough of them to say so: how many laps divide the 2 h moves with the world's junctions)
out.tz = tzA.filter(even).length >= 30 && JSON.stringify(tzA.filter(even).map(function(c){ return [c.show, c.type]; })) === JSON.stringify(tzB.filter(even).map(function(c){ return [c.show, c.type]; }));

// ---- the view: the types drawn, a few draw calls ----
const V = T.view({THREE: THREE}), list = cars(ind, MON + 8.25*HR).concat(cars(s, MON + 23*HR).filter(function(v){ return v.type === "taxi"; }),
                                                cars(s, MON + 8.25*HR).filter(function(v){ return v.type === "scooter" || v.type === "bike"; }));
// a lorry body too, if none of these is one (a lorry is out only where a platoon's first car picks one)
const lv = list.filter(function(v){ return v.type === "van"; })[0];
if(lv && !list.some(function(v){ return v.type === "lorry"; })) list.push(Object.assign({}, lv, {type: "lorry", x: lv.x + 20}));
const n = V.update(list, 0), tally = {};
list.forEach(function(v){ tally[v.type] = (tally[v.type] || 0) + 1; });
out.view = {n: n, tally: tally, calls: V.drawCalls(), solidSpec: ["van", "lorry", "scooter", "bike", "taxi"].every(function(k){ return T.SPEC[k] && T.SPEC[k].len > 0 && T.SPEC[k].wid > 0; })};
V.dispose();

// ---- cityevents3d ----
function evAt(ms){
  const S = new THREE.Scene(), E = CE.create(THREE, S, W), evs = L.events(W, ms);
  const at = evs.length ? evs[0].at : (L.events(W, WED + 10*HR)[0] || {at: {x: 0, z: 0}}).at;
  // the camera at each event in turn (near it: built), then the summary
  if(evs.length) evs.forEach(function(ev){ E.update(ms, ev.at); }); else E.update(ms, at);
  const i = E.info(); E.dispose(); return i;
}
const mk = L.events(W, WED + 10*HR).filter(function(e){ return e.kind === "market"; })[0];
out.events = {
  wed10: evAt(WED + 10*HR), wed15: evAt(WED + 15*HR), thu10: evAt(THU + 10*HR), sat1359: evAt(SAT + 13.98*HR), sat14: evAt(SAT + 14*HR),
  mon10: evAt(MON + 10*HR), mon0859: evAt(MON + 8.98*HR), mon16: evAt(MON + 16*HR), sat10: evAt(SAT + 10*HR), sun10: evAt(SUN + 10*HR),
  sun1530: evAt(SUN + 15.5*HR), sun17: evAt(SUN + 17*HR), monWorks: L.events(W, MON + 10*HR).filter(function(e){ return e.kind === "roadworks"; }).length};
const evs = L.events(W, WED + 10*HR).concat(L.events(W, SUN + 15.5*HR)), W2 = pack();
out.events.pure = evs.every(function(ev){ return JSON.stringify(CE.pieces(W, ev)) === JSON.stringify(CE.pieces(W2, L.events(W2, ev.kind === "parade" ? SUN + 15.5*HR : WED + 10*HR).filter(function(e){ return e.id === ev.id; })[0])); });
// solid: a barrier's centre blocks, the middle of the market street does not (the stalls line the kerbs), far away nothing
(function(){
  const S = new THREE.Scene(), E = CE.create(THREE, S, W), wk = L.events(W, MON + 10*HR).filter(function(e){ return e.kind === "roadworks"; })[0], P = CE.pieces(W, wk), b = P.barriers[0];
  E.update(MON + 10*HR, wk.at);
  const far = E.blocked(wk.at.x + 900, wk.at.z + 900);
  E.update(WED + 10*HR, mk.at);
  const M = CE.pieces(W, mk), st = M.stalls[0];
  out.solid = {barrier: (E.update(MON + 10*HR, wk.at), E.blocked(b.x, b.z)), far: far, stall: (E.update(WED + 10*HR, mk.at), E.blocked(st.x, st.z)),
               mid: E.blocked(mk.at.x, mk.at.z), later: (E.update(WED + 15*HR, mk.at), E.blocked(st.x, st.z)),
               // under the street (the metro): nothing drawn, nothing blocks
               under: (H.hqUnderground = {under: function(){ return true; }}, E.update(MON + 10*HR + 6000, wk.at), E.blocked(b.x, b.z)), drawn: E.drawCalls()};
  delete H.hqUnderground;
  E.dispose();
})();
console.log(JSON.stringify(out));
"""


@unittest.skipUnless(NODE and os.path.exists(FIXTURE), "node or the @3 fixture missing")
class CityLifeTraffic(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        r = subprocess.run([NODE, "--input-type=module", "-e", HARNESS % {"root": json.dumps(ROOT)}], capture_output=True, text=True, timeout=600)
        if r.returncode:
            raise AssertionError(r.stderr[-4000:])
        cls.o = json.loads(r.stdout.strip().splitlines()[-1])

    def test_fewer_cars_at_night_than_in_the_rush(self):
        c = self.o["count"]
        self.assertTrue(self.o["info"]["life"])
        # ([3.29] the expressways' lanes join up into laps of an hour or more, and a car is out or not for its whole lap
        # by the hour it began: at 08:15 some began before the rush)
        self.assertGreaterEqual(c["h815"], 0.8 * c["all"], "08:15 is the rush: about today's density")
        self.assertLess(c["h3"], c["h815"] * 0.4)
        self.assertLess(c["h3"], c["h13"])
        self.assertLess(c["h13"], c["h815"])

    def test_without_city_life_the_traffic_is_todays(self):
        o = self.o["off"]
        self.assertEqual(o["n"], o["cars"])
        self.assertEqual(o["types"], 0)
        self.assertTrue(o["same"], "life: false is the sim with no citylife.js")

    def test_the_mix_follows_the_district_and_the_hour(self):
        m = self.o["mix"]
        self.assertGreater(m["industry"], 0.35, "the industrial district sends vans and lorries onto its main roads")
        self.assertGreater(m["lorryPicks"], 0, "the mix picks lorries (a platoon's first car drives one)")
        self.assertTrue(m["lorryLead"], "only a platoon's first car is a lorry")
        self.assertGreater(m["industry"], m["city"])
        self.assertGreater(m["taxiNight"], m["taxiDay"], "more taxis at night")
        self.assertTrue(set(m["kinds"]) <= {"main", "fast"}, "lorries only on main and fast roads")
        self.assertTrue(m["lorryOnTwo"])
        self.assertGreater(len(m["groups"]), 2, "cars come from several districts")

    def test_no_car_on_a_closed_street_and_back_after(self):
        c = self.o["closed"]
        self.assertGreater(c["before"], 0, "cars use the street before the roadworks")
        self.assertEqual(c["during"], 0, "none on it while it is closed")
        self.assertGreater(c["after"], 0, "and use it again afterwards")
        self.assertEqual(c["map"], {str(c["edge"]): "roadworks"})
        self.assertEqual(c["none"], {})
        self.assertEqual(c["ringOut"], 0)
        p = self.o["parade"]
        self.assertGreater(p["edges"], 0)
        self.assertGreater(p["before"], 0)
        self.assertEqual(p["during"], 0, "the parade route is clear of cars")
        self.assertGreater(p["after"], 0)

    def test_determinism(self):
        self.assertTrue(self.o["det"], "same doc, tier, seed and clock: the same cars, types and places")
        self.assertTrue(self.o["tz"], "the local offset only shifts the clock")
        self.assertTrue(self.o["events"]["pure"], "the events' props are a pure function of the world")

    def test_the_view_draws_the_types_in_a_few_calls(self):
        v = self.o["view"]
        for k in ("van", "lorry"):
            self.assertGreater(v["tally"].get(k, 0), 0, k)
            self.assertEqual(v["n"][k], v["tally"][k], k)
        for k in ("scooter", "bike"):
            self.assertEqual(v["n"][k], v["tally"].get(k, 0), k)
        self.assertGreater(v["tally"].get("scooter", 0) + v["tally"].get("bike", 0), 0, "two-wheelers in the rush")
        self.assertGreater(v["tally"].get("taxi", 0), 0)
        self.assertEqual(v["n"]["beacon"], v["tally"]["taxi"], "a taxi's roof sign")
        self.assertEqual(v["n"]["car"], v["tally"].get("car", 0) + v["tally"]["taxi"])
        self.assertLessEqual(v["calls"], 12 + 4, "the traffic budget plus four bodies at most")
        self.assertTrue(v["solidSpec"])

    def test_events_are_drawn_on_their_days_and_hours_only(self):
        e = self.o["events"]
        self.assertGreater(e["wed10"]["stalls"], 0, "Wednesday's market")
        self.assertGreater(e["sat1359"]["stalls"], 0, "Saturday's market, to 14:00")
        for k in ("wed15", "thu10", "sat14", "mon10", "sun1530"):
            self.assertEqual(e[k]["stalls"], 0, k)
        self.assertGreater(e["mon10"]["barriers"], 0, "the week's roadworks")
        # a plate at each end of every roadworks the view has built (it drops one 560 m behind the camera, which visits
        # each in turn: how many stay built depends on how far apart the week's streets are)
        built = [k for k in e["mon10"]["events"] if k.startswith("works:")]
        self.assertGreater(len(built), 0)
        self.assertLessEqual(len(built), e["monWorks"])
        self.assertEqual(e["mon10"]["signs"], 2 * len(built), "a ROAD CLOSED plate at each end")
        self.assertGreater(e["mon10"]["plant"], 0)
        self.assertGreater(e["mon10"]["cones"], 0)
        for k in ("mon0859", "mon16", "sat10", "sun10", "sun1530", "sun17"):
            self.assertEqual(e[k]["barriers"], 0, k)
        self.assertGreater(e["sun1530"]["rails"], 0, "the parade's crowd barriers")
        self.assertGreater(e["sun1530"]["flags"], 0, "and bunting")
        for k in ("sun17", "sat10", "mon10"):
            self.assertEqual(e[k]["rails"] + e[k]["flags"], 0, k)
        self.assertLessEqual(e["wed10"]["drawCalls"], 7)
        self.assertEqual(e["mon16"]["drawCalls"], 0)

    def test_barriers_and_stalls_are_solid(self):
        s = self.o["solid"]
        self.assertTrue(s["barrier"])
        self.assertTrue(s["stall"])
        self.assertFalse(s["mid"], "the middle of the market street is the walk between the stalls")
        self.assertFalse(s["far"])
        self.assertFalse(s["later"], "gone after the market")
        self.assertFalse(s["under"])
        self.assertEqual(s["drawn"], 0)


if __name__ == "__main__":
    unittest.main()
