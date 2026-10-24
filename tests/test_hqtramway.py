"""The street tramway (games/hqtramway.js, HQ 3.15, docs/plans/transport-revamp.md 3.1).

hqtramway.js lays rails, beds, crossovers, poles, wires and stop islands on the tracks games/traffic.js drives
(traffic.lanes / tramPaths / tramStops). node loads world.js, traffic.js and hqtramway.js against a stub `window`
and checks, on the synthetic hub city (tests/fixtures/traffic_city.js), the @2 Commons and (when its fixture exists)
the @3 Commons, all at tier 5: the rails sit on the tram lanes' offset at standard gauge, every tram lane is
covered, every terminus has its crossover, poles keep 30 m and the 0.4 m chord rule, stops get islands and totems,
the output is deterministic, and the view stays within its 10 draw calls. Skipped without node. Stdlib only."""
import json
import os
import re
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")

HARNESS = r"""
import fs from "fs";
import zlib from "zlib";
import { createRequire } from "module";
const root = %(root)s, FIX = root + "/tests/fixtures/", require = createRequire(root + "/tests/");
globalThis.window = {HQV: {}};
for (const f of ["world", "traffic", "hqtramway"]) new Function(fs.readFileSync(root + "/games/" + f + ".js", "utf8"))();
const THREE = await import(root + "/games/vendor/three-module.js");
const H = window.HQV, T = H.traffic, TW = H.hqTramway, WD = H.world, city = require(FIX + "traffic_city.js"), out = {};
function gz(p){ return JSON.parse(zlib.gunzipSync(fs.readFileSync(FIX + p)).toString("utf8")); }
const worlds = {city: city(1, 7, true), commons: WD.pack(gz("claude-hq@2.json.gz"))};
if(fs.existsSync(FIX + "claude-hq@3.json.gz")) worlds.v3 = WD.pack(gz("claude-hq@3.json.gz"));
function segD(px, pz, ax, az, bx, bz){
  const ux = bx - ax, uz = bz - az, l = ux*ux + uz*uz, t = l > 1e-12 ? Math.max(0, Math.min(1, ((px - ax)*ux + (pz - az)*uz)/l)) : 0;
  return Math.hypot(px - ax - ux*t, pz - az - uz*t);
}
function polyD(x, z, P){ let b = 1e9; for(let i = 1; i < P.length; i++) b = Math.min(b, segD(x, z, P[i-1][0], P[i-1][2], P[i][0], P[i][2])); return b; }
function strip(L){ return JSON.stringify(L, function(k, v){ return k === "box" || k === "C" ? undefined : v; }); }
for(const name of Object.keys(worlds)){
  const W = worlds[name], sim = T.create(W, {tier: 5, seed: 7}), L = TW.layout(W, 5, {sim}), o = out[name] = {stats: L.stats};
  const E = sim._.edges, byI = {};
  E.forEach(function(e){ byI[e.i] = e; });
  // rails on the tram lane: each lane track's points at tramOff from the edge's centre line (mid-lane samples)
  let offErr = 0, offN = 0;
  L.tracks.forEach(function(t){
    if(t.kind !== "lane") return;
    const e = byI[t.ei], S = TW._.sample(t.P, 5);
    S.slice(1, -1).forEach(function(p){ offErr = Math.max(offErr, Math.abs(polyD(p.x, p.z, e.pts) - e.tramOff)); offN++; });
  });
  o.offset = {err: offErr, n: offN};
  // gauge: the inner faces of the two rails of every track 1.435 m apart (rail centres 2*RAIL_C, heads HEAD wide)
  let gErr = 0, gN = 0;
  const railsBy = {};
  L.rails.forEach(function(r){ (railsBy[r.key] = railsBy[r.key] || {})[r.side] = r.P; });
  Object.keys(railsBy).forEach(function(k){
    const A = railsBy[k][-1], B = railsBy[k][1];
    for(let i = 1; i < A.length; i++){
      const mx = (A[i][0] + A[i-1][0])/2, mz = (A[i][2] + A[i-1][2])/2, seg = Math.hypot(A[i][0] - A[i-1][0], A[i][2] - A[i-1][2]);
      if(seg < 3) continue;
      gErr = Math.max(gErr, Math.abs(polyD(mx, mz, B) - TW.HEAD - TW.GAUGE)); gN++;
    }
  });
  o.gauge = {err: gErr, n: gN};
  // every tram lane covered; tracks only where trams run
  const keys = {};
  L.tracks.forEach(function(t){ keys[t.key] = t; });
  let missing = 0, lanesUsed = 0;
  sim._.lines.forEach(function(r){ if(r.kind === "tram") r.lanes.forEach(function(ln){ lanesUsed++; if(!keys["L:" + ln.e.i + ":" + ln.dir]) missing++; }); });
  o.cover = {missing: missing, lanesUsed: lanesUsed, tramEdges: E.filter(function(e){ return e.tram; }).length,
             edgesWithTrack: E.filter(function(e){ return e.tram && (keys["L:" + e.i + ":0"] || keys["L:" + e.i + ":1"]); }).length,
             strays: L.tracks.filter(function(t){ return t.kind === "lane" && !byI[t.ei].tram; }).length};
  // a crossover at every terminus: one per distinct reversing lane, from the inbound track onto the other
  const termini = {};
  sim._.lines.forEach(function(r){ if(r.kind === "tram") r.lanes.forEach(function(ln, i){ if(r.rev[i]) termini["X:" + ln.e.i + ":" + ln.dir] = 1; }); });
  o.xover = {termini: Object.keys(termini).length, have: L.crossovers.filter(function(x){ return termini[x.key]; }).length,
             gear: L.crossovers.every(function(x){ return x.motor && x.check.length >= 2 && x.len > 5; }),
             // the far end of the crossover is a track-width over from where it leaves
             across: L.crossovers.map(function(x){ return Math.hypot(x.to.x - x.from.x, x.to.z - x.from.z); })};
  // poles: spans along the track at most 30 m, the staggered chord within 0.4 m of the track
  let worstSpan = 0, worstDev = 0, spans = 0, stag = true;
  L.spans.forEach(function(sp){
    const R = sp.regs, S = sp.S;
    for(let k = 1; k < R.length; k++){
      worstSpan = Math.max(worstSpan, R[k].s - R[k-1].s); spans++;
      if(Math.abs(Math.abs(R[k].st) - TW.STAGGER) > 1e-9) stag = false;
      for(let j = 0; j < S.length; j++){
        if(S[j].s < R[k-1].s - 1e-6 || S[j].s > R[k].s + 1e-6) continue;
        worstDev = Math.max(worstDev, segD(S[j].x, S[j].z, R[k-1].x, R[k-1].z, R[k].x, R[k].z));
      }
    }
  });
  o.poles = {n: L.poles.length, spans: spans, worstSpan: worstSpan, worstDev: worstDev, stagger: stag,
             kinds: L.poles.map(function(p){ return p.kind; }).filter(function(v, i, a){ return a.indexOf(v) === i; }).sort(),
             // a kerb pole stands off the carriageway; a centre pole between the two tracks
             clear: L.poles.every(function(p){ return L.tracks.every(function(t){ return t.kind !== "lane" || polyD(p.x, p.z, t.P) > T.SPEC.tram.wid/2 + 0.08; }); })};
  o.wires = {contact: L.wires.contact.length/6, messenger: L.wires.messenger.length/6, droppers: L.wires.droppers.length/6,
             height: L.wires.contact.length ? L.wires.contact[1] - L.spans[0].regs[0].y : 0};
  // stops: an island per stop and direction, 0.3 m high, beside the track, a totem per line
  const stops = T.tramStops(W, 5, sim);
  o.islands = {stops: stops.length, n: L.islands.length, h: L.islands.map(function(i){ return i.h; }).filter(function(v, i, a){ return a.indexOf(v) === i; }),
               everyStop: stops.every(function(st){ return L.islands.some(function(I){ return I.stop === st.id && I.lines.indexOf(st.line) >= 0; }); }),
               totems: L.totems.length, lines: L.islands.reduce(function(a, I){ return a + I.lines.length; }, 0),
               beside: L.islands.every(function(I){ return L.tracks.every(function(t){ return t.kind !== "lane" || polyD(I.x, I.z, t.P) > T.SPEC.tram.wid/2 + I.w/2 - 0.01; }); })};
  // beds: setts only near stops, stencils at least 120 m apart along a stretch
  o.beds = {kinds: L.beds.map(function(b){ return b.kind; }).filter(function(v, i, a){ return a.indexOf(v) === i; }).sort(),
            settsNear: L.beds.filter(function(b){ return b.kind === "setts"; }).every(function(b){ return b.P.every(function(p){ return stops.some(function(st){ return Math.hypot(st.x - p[0], st.z - p[2]) < TW.SETTS + 2.1; }); }); }),
            stencils: L.stencils.length,
            stencilGap: (function(){ let g = 1e9; L.stencils.forEach(function(a, i){ L.stencils.forEach(function(b, j){ if(j > i && a.key === b.key) g = Math.min(g, Math.hypot(a.x - b.x, a.z - b.z)); }); }); return g; })()};
  // determinism: the same layout from a fresh sim and from a layout-only build
  o.det = strip(L) === strip(TW.layout(W, 5, {sim: T.create(W, {tier: 5, seed: 99})})) && strip(L) === strip(TW.layout(W, 5));
  // the view: draw calls and triangles from a few camera spots, LOD by distance
  const V = TW.view({THREE: THREE}, W, 5, {layout: L});
  let calls = 0, tris = 0, polesShown = 0;
  const cams = L.tracks.length ? [L.tracks[0].P[0], L.tracks[Math.floor(L.tracks.length/2)].P[0], L.tracks[L.tracks.length - 1].P[0]] : [[0, 0, 0]];
  cams.forEach(function(p){
    V.update(0, 0, {x: p[0], y: 0, z: p[2]});
    calls = Math.max(calls, V.drawCalls()); tris = Math.max(tris, V.triangles());
    const pm = V.group.children.filter(function(m){ return m.name === "hqtramway-poles"; })[0];
    polesShown = Math.max(polesShown, pm.count);
  });
  V.update(0, 0, {x: 1e5, y: 0, z: 1e5});
  o.view = {calls: calls, tris: tris, polesShown: polesShown, far: V.drawCalls(), shots: ["tram-stop", "tram-junction", "tram-crossover"].map(function(n){ return !!V.tools.shotCam(n); })};
  V.dispose();
}
console.log(JSON.stringify(out));
"""


@unittest.skipUnless(NODE, "node is not installed")
class Tramway(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        res = subprocess.run([NODE, "--input-type=module", "-e", HARNESS % {"root": json.dumps(ROOT)}], capture_output=True, text=True, timeout=600)
        if res.returncode != 0:
            raise AssertionError("node harness failed:\n" + res.stderr[-4000:])
        cls.r = json.loads(res.stdout.strip().splitlines()[-1])

    def each(self):
        return sorted(self.r.items())

    def test_rails_sit_on_the_tram_lanes(self):
        for w, o in self.each():
            self.assertGreater(o["offset"]["n"], 20, w)
            self.assertLess(o["offset"]["err"], 0.02, "%s: the track is tramOff from the centre line" % w)

    def test_standard_gauge(self):
        for w, o in self.each():
            self.assertGreater(o["gauge"]["n"], 10, w)
            self.assertLess(o["gauge"]["err"], 0.01, "%s: 1.435 m between the rails' inner faces" % w)

    def test_every_tram_edge_covered(self):
        for w, o in self.each():
            c = o["cover"]
            self.assertEqual(c["missing"], 0, w)
            self.assertEqual(c["edgesWithTrack"], c["tramEdges"], "%s: every tram edge has track" % w)
            self.assertEqual(c["strays"], 0, "%s: no track where no tram runs" % w)

    def test_crossover_at_every_terminus(self):
        for w, o in self.each():
            x = o["xover"]
            self.assertGreater(x["termini"], 0, w)
            self.assertEqual(x["have"], x["termini"], "%s: a crossover at each terminus" % w)
            self.assertTrue(x["gear"], "%s: switch blades, a point-motor box and a check rail" % w)
            for d in x["across"]:
                self.assertGreater(d, 2.5, "%s: the crossover reaches the other track" % w)

    def test_pole_spacing_and_chord_rule(self):
        for w, o in self.each():
            p = o["poles"]
            self.assertGreater(p["n"], 10, w)
            self.assertLessEqual(p["worstSpan"], 30 + 1e-6, "%s: a pole every 30 m at most" % w)
            self.assertLessEqual(p["worstDev"], 0.4 + 1e-6, "%s: the contact wire within 0.4 m of the track" % w)
            self.assertTrue(p["stagger"], "%s: the wire staggered 0.2 m at each pole" % w)
            self.assertTrue(p["clear"], "%s: no pole in a tram's way" % w)
        self.assertIn("centre", self.r["commons"]["poles"]["kinds"], "centre poles with twin arms on the two-way arterials")

    def test_wires(self):
        for w, o in self.each():
            ww = o["wires"]
            self.assertGreater(ww["contact"], 10, w)
            self.assertGreater(ww["messenger"], ww["contact"], w)
            self.assertGreater(ww["droppers"], 0, w)
            self.assertAlmostEqual(ww["height"], 5.6, 1, "%s: contact wire 5.6 m over the rails" % w)

    def test_stop_islands_and_totems(self):
        for w, o in self.each():
            i = o["islands"]
            self.assertGreater(i["n"], 0, w)
            self.assertTrue(i["everyStop"], "%s: an island at every tram stop" % w)
            self.assertEqual(i["h"], [0.3])
            self.assertEqual(i["totems"], i["lines"], "%s: a totem per line at each island" % w)
            self.assertTrue(i["beside"], "%s: islands beside the track, never on it" % w)

    def test_beds_and_stencils(self):
        for w, o in self.each():
            b = o["beds"]
            self.assertIn("setts", b["kinds"], w)
            self.assertTrue(b["settsNear"], "%s: setts only within 25 m of a stop" % w)
            if b["stencils"] > 1:
                self.assertGreaterEqual(b["stencilGap"], 100, "%s: TRAM stencils far apart" % w)
        self.assertIn("asphalt", self.r["city"]["beds"]["kinds"], "reserved stretches over 60 m")
        self.assertGreater(self.r["city"]["beds"]["stencils"], 0)

    def test_deterministic(self):
        for w, o in self.each():
            self.assertTrue(o["det"], "%s: the same layout from any sim of the world and tier" % w)

    def test_view_budget(self):
        for w, o in self.each():
            v = o["view"]
            self.assertLessEqual(v["calls"], 10, "%s: the tramway in at most 10 draw calls" % w)
            self.assertLess(v["tris"], 60000, "%s: within 60k triangles" % w)
            self.assertGreater(v["polesShown"], 0)
            self.assertLessEqual(v["far"], 2, "%s: far away only the static stops (furniture, badges) draw" % w)
            self.assertTrue(v["shots"][0] and v["shots"][1], w)


class Source(unittest.TestCase):
    def test_house_rules(self):
        with open(os.path.join(ROOT, "games", "hqtramway.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertNotIn("Math.random", src)
        self.assertNotIn("innerHTML", src)
        self.assertNotIn("fetch(", src)
        self.assertIsNone(re.search(r"\blet\b|\bconst\b|=>", src), "var-style JS")


if __name__ == "__main__":
    unittest.main()
