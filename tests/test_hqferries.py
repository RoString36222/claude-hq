"""games/hqferries.js: the water bus, the lake launch and the water taxis on the @3 water (HQ 3.15, plan 3.8).

Runs under node (skipped without it) on a synthetic water layer (tests/water_fixture.py), the hand-made
tests/fixtures/world_v3_tiny.json and, when they exist, the generated @3 fixtures (claude-hq@3, island@3; more docs can
be named in HQ_WATER_DOCS, a path list). Checks: every route calls at its piers in order; headways; speeds per kind of
water; vessels never leave the water (against games/world.js waterAt / riverAt / the coast, and never on a pier deck);
two vessels never lie at one berth at once; the Service contract (departures, trips, seats, doors); water taxis stay on
the net and only join connected water; the taxi controller's states; determinism; and the 3D view (draw-call budget,
Calm: the gangway appears in place and the lighthouse stands still; the shot cameras; the sounds)."""
import gzip
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
NODE = shutil.which("node")
sys.path.insert(0, HERE)
from water_fixture import synthetic_doc  # noqa: E402

FIX = os.path.join(HERE, "fixtures")

HARNESS = r"""
import fs from "fs";
const root = process.argv[1], docs = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const THREE = await import(root + "/games/vendor/three-module.js");
globalThis.window = {HQV: {}};
for (const f of ["world", "ocean", "hqboat", "hqride", "hqferries"]) new Function(fs.readFileSync(root + "/games/" + f + ".js", "utf8"))();
const H = window.HQV, WD = H.world, F = H.hqFerries, out = {docs: {}};
const T0 = 1700000000000;

function coastTest(W){ return H.ocean.landTest([H.ocean.coastOf({layers: {island: W.island}})]); }
function study(name, doc){
  const W = WD.pack(doc), sim = F.create(W, {tier: 5}), land = W.island ? coastTest(W) : () => true, o = {lines: [], taxis: {}};
  function worldWet(x, z){ return !!(WD.waterAt(W, x, z) || (W.river && WD.riverAt(W, x, z)) || !land(x, z)); }
  o.stops = sim.stops().map(s => ({id: s.id, name: s.name, lines: s.lines}));
  o.piers = (W.water.piers || []).map(p => ({id: p.id, body: p.body, kind: p.kind}));
  o.bodies = (W.water.bodies || []).map(b => ({id: b.id, kind: b.kind}));
  for (const l of sim.lines()) {
    const R = sim.route(l.id), L = {id: l.id, kind: l.kind, loop: l.loop, stops: l.stops, headway: l.headway, C: R.C, n: R.n,
      seq: [], dry: 0, worldDry: 0, onDeck: 0, edgeDry: 0, tooFast: [], maxBy: {}, samples: 0, deps: {}, berthClash: 0, sameMin: 1e9};
    // one vessel round its whole cycle, every second: where it calls, how fast, on what water
    for (let t = 0; t < R.C; t++) {
      const v = sim.vessel(l.id, 0, R.off + t*1000), w = sim.wet(v.x, v.z);
      L.samples++;
      if (v.stop && L.seq[L.seq.length - 1] !== v.stop) L.seq.push(v.stop);
      if (!w) L.dry++;
      if (!worldWet(v.x, v.z)) L.worldDry++;
      if (WD.deckAt(W, v.x, v.z) != null) L.onDeck++;
      if (l.kind === "waterbus" && v.phase === "run") {
        for (const sd of [1, -1]) { const ex = v.x + sd*Math.cos(v.yaw)*4.2, ez = v.z - sd*Math.sin(v.yaw)*4.2; if (!sim.wet(ex, ez)) L.edgeDry++; }
      }
      const k = w ? w.kind : "none";
      L.maxBy[k] = Math.max(L.maxBy[k] || 0, v.speed);
      const lim = l.kind === "launch" ? F.LAUNCH_V : (F.SPEED[k] || 6);
      if (v.speed > lim + 0.1) L.tooFast.push([t, k, v.speed]);
    }
    // departures from every stop: one call a direction, a vessel every headway
    for (const s of l.stops) {
      const d = sim.departures(s, T0, 12).filter(x => x.line === l.id);
      L.deps[s] = d.map(x => [x.at - T0, x.to, x.boarding, x.vehicle]);
    }
    // its vessels: never two at one berth at once (dwelling within 12 m), and passing each other with room
    for (let t = 0; t < 1800; t += 1) {
      const V = sim.vehicles(T0 + t*1000).filter(v => v.line === l.id);
      for (let i = 0; i < V.length; i++) for (let j = i + 1; j < V.length; j++) {
        const dd = Math.hypot(V[i].x - V[j].x, V[i].z - V[j].z);
        L.sameMin = Math.min(L.sameMin, dd);
        if (V[i].stop && V[j].stop && dd < 12) L.berthClash++;
      }
    }
    // a trip from the first stop to the last (round the loop for the launch)
    const from = l.stops[0], to = l.loop && l.stops.length === 1 ? l.stops[0] : l.stops[l.stops.length - 1], tr = sim.trip(l.id, from, to, T0);
    if (tr) {
      const p0 = tr.pose(tr.depart), p1 = tr.pose(tr.reach), pm = tr.pose((tr.depart + tr.reach)/2), seats = [];
      for (let i = 0; i < tr.seats + tr.standing; i++) { const s = tr.seat(i, tr.depart); seats.push([s.x - p0.x, s.z - p0.z, s.y - p0.y]); }
      const dr = tr.door(tr.depart), st = sim.stops().filter(s => s.id === from)[0];
      L.trip = {depart: tr.depart - T0, reach: tr.reach - T0, arrive: tr.arrive - T0, stops: tr.stops.map(s => s.id), seats: tr.seats, standing: tr.standing,
                doneEnd: p1.done, doneMid: pm.done, doors0: p0.doors, speedMid: pm.speed, seatsLocal: seats, doorToStop: Math.hypot(dr.x - st.x, dr.z - st.z),
                mode: tr.mode, line: tr.line, vehicle: tr.vehicle, yaw: p0.yaw};
    }
    o.lines.push(L);
  }
  // water taxis: every pair of piers; on the net, on the water, at taxi speeds
  const N = W.water.net.nodes.map(p => [p[0]/100, p[1]/100]), E = new Set(W.water.net.edges.map(e => Math.min(e[0], e[1]) + "," + Math.max(e[0], e[1])));
  const P = W.water.piers.map(p => p.id);
  for (const a of P) for (const b of P) {
    if (a === b) continue;
    const T = F.taxi(W, a, b, T0, "seed"), path = F.taxiPath(W, a, b), r = {ok: !!T};
    if (T) {
      r.skipper = T.skipper; r.secs = T.secs; r.metres = T.metres; r.dry = 0; r.fast = 0; r.slowFast = 0; r.offNet = 0; r.noEdge = 0;
      // every point between the two berths is a net node (or passes a pier's head node just off it), joined by edges
      const idx = path.nodes.slice(1, -1);
      path.slice(1, -1).forEach((q, k) => { const n = N[idx[k]]; if (!n || Math.hypot(n[0] - q[0], n[1] - q[1]) > F.TAXI.off + 0.01) r.offNet++; });
      for (let i = 1; i < idx.length; i++) if (!E.has(Math.min(idx[i], idx[i - 1]) + "," + Math.max(idx[i], idx[i - 1]))) r.noEdge++;
      for (let t = T.depart; t <= T.reach; t += 250) {
        const p = T.pose(t), w = sim.wet(p.x, p.z);
        if (!w || !worldWet(p.x, p.z) || WD.deckAt(W, p.x, p.z) != null) r.dry++;
        if (p.speed > F.TAXI.open + 0.05) r.fast++;
        if (w && (w.kind === "river" || w.kind === "canal") && p.speed > F.TAXI.slow + 0.1) r.slowFast++;
      }
      r.again = JSON.stringify(F.taxi(W, a, b, T0, "seed").pose(T.depart + 5000)) === JSON.stringify(T.pose(T.depart + 5000));
    }
    o.taxis[a + ">" + b] = r;
  }
  // a fingerprint of everything visible over an hour: two processes must agree
  const fp = [];
  for (let t = 0; t < 3600; t += 7) sim.vehicles(T0 + t*1000).forEach(v => fp.push(v.id, v.x.toFixed(4), v.z.toFixed(4), v.yaw.toFixed(5), v.doors.toFixed(4)));
  sim.stops().forEach(s => fp.push(JSON.stringify(sim.departures(s.id, T0, 4))));
  o.fp = fp.join("|");
  o.fresh = JSON.stringify(F.create(WD.pack(doc), {tier: 5}).vehicles(T0 + 12345)) === JSON.stringify(sim.vehicles(T0 + 12345));
  return {W, sim, o};
}
const studied = {};
for (const [name, doc] of Object.entries(docs)) { studied[name] = study(name, doc); out.docs[name] = studied[name].o; }

// the taxi controller, pure (no THREE): coming -> here -> riding -> done
(function(){
  const {W} = studied.synthetic, said = [];
  let now = T0;
  const ctl = F.taxiController(null, W, {now: () => now, announce: t => said.push(t), seed: "s", me: () => ({x: -100, z: -140})});
  const h = ctl.request("pier:0", "pier:3"), r = {states: []};
  r.ok = !!h; r.skipper = h.skipper;
  r.states.push(h.state().state); r.eta0 = h.state().eta;
  r.boardEarly = h.board();
  now = h.approach ? h.approach.reach + 10 : now; ctl.update(now, 0.1); r.states.push(h.state().state);
  r.carryBefore = ctl.carry(now);
  r.board = h.board(); r.states.push(h.state().state);
  now += 5000; ctl.update(now, 0.1); r.carry = ctl.carry(now); r.cam = ctl.camPose(now, {yaw: 0, pitch: 0});
  now = h.ride.reach + 100; ctl.update(now, 0.1); r.states.push(h.state().state);
  r.carryAfter = ctl.carry(now); r.ashore = h.ashore(); r.said = said.length; r.drawCalls = ctl.drawCalls();
  r.lake = ctl.request("pier:6", "pier:0");
  const h2 = ctl.request(null, "pier:7"); r.nearest = h2 ? h2.from : null; h2 && h2.cancel(); r.cancelled = h2 ? h2.state().state : null;
  out.ctl = r;
})();

// the view, with the vendored three.js
(function(){
  const {W, sim} = studied.synthetic, scene = new THREE.Scene(), sounds = [];
  let calm = false, night = true;
  const c = {THREE, scene, mat: (col, o) => new THREE.MeshStandardMaterial(Object.assign({color: col}, o || {}))};
  const V = F.view(c, sim, {calm: () => calm, night: () => night, sfx: (n, o) => sounds.push(n)});
  const pier2 = sim.stops().filter(s => s.id === "pier:2")[0], cam = {x: pier2.x, y: 5, z: pier2.z};
  const r = {calls: [], shots: {}};
  for (let t = 0; t < 600; t += 1) { V.update(T0 + t*1000, 1, cam); r.calls.push(V.drawCalls()); }
  r.sounds = Array.from(new Set(sounds)).sort();
  ["waterbus-pier", "waterbus-cabin", "marina", "lake-launch", "nope"].forEach(n => { r.shots[n] = V.tools.shotCam(n); });
  // a gangway mid-swing: Calm puts it straight out, without Calm it is part way
  let ms = null, vid = null;
  for (let t = 0; t < 900 && ms == null; t += 0.25) { const L = sim.vehicles(T0 + t*1000).filter(v => v.kind === "waterbus" && v.doors > 0.3 && v.doors < 0.7); if (L.length) { ms = T0 + t*1000; vid = L[0].id; } }
  function gangYaw(q){
    const list = sim.vehicles(q).filter(v => v.kind === "waterbus" && Math.hypot(v.x - cam.x, v.z - cam.z) <= 1600), i = list.findIndex(v => v.id === vid);
    const m = new THREE.Matrix4(), g = scene.getObjectByName("hqferries-gangway"); g.getMatrixAt(i, m);
    const e = new THREE.Euler().setFromRotationMatrix(m, "YXZ"); return {yaw: e.y, v: list[i]};
  }
  calm = false; V.update(ms, 0.016, cam); const a = gangYaw(ms);
  calm = true; V.update(ms, 0.016, cam); const b = gangYaw(ms);
  const want = a.v.yaw + Math.PI/2 - a.v.side*Math.PI/2;
  function angd(x, y){ return Math.abs(Math.atan2(Math.sin(x - y), Math.cos(x - y))); }
  r.gang = {doors: a.v.doors, offMoving: angd(a.yaw, want), offCalm: angd(b.yaw, want)};
  // the lighthouse: a sweep at night, still under Calm
  const beam = scene.getObjectByName("hqferries-beam");
  calm = false; V.update(T0 + 1000, 0.1, cam); const r1 = beam.rotation.y; V.update(T0 + 9000, 0.1, cam); const r2 = beam.rotation.y;
  calm = true; V.update(T0 + 1000, 0.1, cam); const r3 = beam.rotation.y; V.update(T0 + 9000, 0.1, cam); const r4 = beam.rotation.y;
  r.beam = {moving: angd(r1, r2), calm: angd(r3, r4), visibleNight: beam.visible};
  night = false; V.update(T0 + 9000, 0.1, cam); r.beam.visibleDay = beam.visible;
  r.wakes = V.wakes().length;
  r.maxCalls = Math.max.apply(null, r.calls);
  // with a water taxi out too
  let now = T0;
  const ctl = F.taxiController(c, W, {now: () => now, seed: "s"}), h = ctl.request("pier:0", "pier:3");
  ctl.update(now, 0.1); r.taxiCalls = ctl.drawCalls(); r.total = r.maxCalls + r.taxiCalls;
  let tris = 0; scene.traverse(o => { if (o.isMesh) { const g = o.geometry, n = (g.index ? g.index.count : g.attributes.position.count)/3; tris += o.isInstancedMesh ? n*o.count : n; } });
  r.tris = tris;
  V.dispose(); ctl.dispose();
  let left = 0; scene.traverse(o => { if (o.isMesh) left++; }); r.leftAfterDispose = left;
  out.view = r;
})();
console.log(JSON.stringify(out));
"""


def _gz(name):
    p = os.path.join(FIX, name)
    if not os.path.exists(p):
        return None
    with gzip.open(p, "rt", encoding="utf-8") as fh:
        return json.load(fh)


def _docs():
    docs = {"synthetic": synthetic_doc()}
    with open(os.path.join(FIX, "world_v3_tiny.json"), encoding="utf-8") as fh:
        docs["tiny"] = json.load(fh)
    for name in ("claude-hq@3.json.gz", "island@3.json.gz"):
        d = _gz(name)
        if d and (d.get("layers") or {}).get("water"):
            docs[name.split(".")[0]] = d
    for p in filter(None, os.environ.get("HQ_WATER_DOCS", "").split(os.pathsep)):
        with open(p, encoding="utf-8") as fh:
            docs[os.path.basename(p)] = json.load(fh)
    return docs


def _run(docs):
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as fh:
        json.dump(docs, fh)
        path = fh.name
    try:
        r = subprocess.run([NODE, "--input-type=module", "-e", HARNESS, ROOT, path], capture_output=True, text=True, timeout=600)
    finally:
        os.unlink(path)
    if r.returncode != 0:
        raise AssertionError(r.stderr[-4000:])
    return json.loads(r.stdout.strip().splitlines()[-1])


@unittest.skipUnless(NODE, "node not installed")
class FerriesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.docs = _docs()
        cls.o = _run(cls.docs)

    def each_line(self):
        for name, d in self.o["docs"].items():
            for L in d["lines"]:
                yield name, d, L

    def test_lines_from_every_route(self):
        for name, d in self.o["docs"].items():
            want = [r["id"] for r in self.docs[name]["layers"]["water"]["routes"]]
            self.assertEqual([L["id"] for L in d["lines"]], want, name)
        syn = {L["id"]: L for L in self.o["docs"]["synthetic"]["lines"]}
        self.assertEqual(syn["W1"]["kind"], "waterbus")
        self.assertEqual(syn["L1"]["kind"], "launch")
        self.assertTrue(syn["L1"]["loop"])

    def test_calls_at_its_piers_in_order(self):
        for name, d, L in self.each_line():
            s = L["stops"]
            want = s[1:] + [s[0]] if L["loop"] else s[1:] + s[-2::-1]
            self.assertEqual(L["seq"], want, (name, L["id"]))

    def test_headways(self):
        for name, d, L in self.each_line():
            H = 150 if L["kind"] == "waterbus" else 300
            self.assertEqual(L["headway"], H)
            self.assertEqual(L["C"] % H, 0)
            self.assertEqual(L["n"], L["C"] // H)
            for stop, deps in L["deps"].items():
                self.assertTrue(deps, (name, L["id"], stop))
                ats = sorted(x[0] for x in deps)
                self.assertGreaterEqual(ats[0], -1)
                calls = 1 if (stop in (L["stops"][0], L["stops"][-1]) or L["loop"]) else 2
                by_to = {}
                for at, to, boarding, veh in deps:
                    by_to.setdefault((to, veh.split(":")[0]), []).append(at)
                # each direction's departures are exactly a headway apart
                gaps = sorted({round(b - a) for (k, v) in by_to.items() for a, b in zip(sorted(v), sorted(v)[1:])})
                if calls == 1 or len(by_to) > 1:
                    self.assertEqual(gaps, [H * 1000], (name, L["id"], stop, deps))

    def test_speeds_by_water(self):
        for name, d, L in self.each_line():
            self.assertEqual(L["tooFast"], [], (name, L["id"]))
            if L["kind"] == "launch":
                self.assertAlmostEqual(max(L["maxBy"].values()), 4.0, delta=0.05)
        syn = {L["id"]: L for L in self.o["docs"]["synthetic"]["lines"]}
        self.assertAlmostEqual(syn["W1"]["maxBy"]["canal"], 6.0, delta=0.05)      # canals at 6 m/s
        self.assertGreater(syn["W2"]["maxBy"]["marina"], 6.5)                     # faster in the marina (9 at most)
        for name in ("claude-hq@3", "island@3"):
            if name in self.o["docs"]:
                w1 = [L for L in self.o["docs"][name]["lines"] if L["id"] == "W1"][0]
                self.assertAlmostEqual(w1["maxBy"].get("river", 0), 6.0, delta=0.05)

    def test_vessels_never_leave_the_water(self):
        for name, d, L in self.each_line():
            self.assertGreater(L["samples"], 100)
            self.assertEqual(L["dry"], 0, (name, L["id"]))
            self.assertEqual(L["worldDry"], 0, (name, L["id"]))
            self.assertEqual(L["onDeck"], 0, (name, L["id"]))
            self.assertEqual(L["edgeDry"], 0, (name, L["id"]))        # the hull's sides too, under way

    def test_vessels_keep_apart(self):
        for name, d, L in self.each_line():
            self.assertEqual(L["berthClash"], 0, (name, L["id"]))
            if L["n"] > 1 and L["kind"] == "waterbus":
                self.assertGreater(L["sameMin"], 5, (name, L["id"]))   # passing each other, each keeping right

    def test_trip(self):
        for name, d, L in self.each_line():
            t = L.get("trip")
            self.assertIsNotNone(t, (name, L["id"]))
            self.assertEqual(t["mode"], "ferry")
            self.assertEqual(t["line"], L["id"])
            self.assertGreaterEqual(t["depart"], 0)
            self.assertLessEqual(t["arrive"], t["depart"])
            self.assertGreater(t["reach"], t["depart"])
            self.assertTrue(t["doneEnd"])
            self.assertFalse(t["doneMid"])
            self.assertEqual(t["stops"][0], L["stops"][0])
            self.assertEqual(t["stops"][-1], L["stops"][0] if L["loop"] and len(L["stops"]) == 1 else L["stops"][-1])
            self.assertEqual(t["seats"], 36 if L["kind"] == "waterbus" else 12)
            self.assertEqual(len(t["seatsLocal"]), t["seats"] + t["standing"])
            for dx, dz, dy in t["seatsLocal"]:
                self.assertLess((dx * dx + dz * dz) ** 0.5, 13)
                self.assertGreaterEqual(dy, -0.01)
            self.assertEqual(len({(round(a, 2), round(b, 2)) for a, b, c in t["seatsLocal"]}), len(t["seatsLocal"]))
            self.assertLess(t["doorToStop"], 3)

    def test_taxis_on_connected_water_only(self):
        for name, d in self.o["docs"].items():
            body = {p["id"]: p["body"] for p in d["piers"]}
            kind = {b["id"]: b["kind"] for b in d["bodies"]}
            for key, r in d["taxis"].items():
                a, b = key.split(">")
                ba, bb = body[a], body[b]
                lake_a, lake_b = kind.get(ba) == "lake", kind.get(bb) == "lake"
                if name == "synthetic":
                    comp = lambda x: x if x in ("canal:1", "lake:0") else "main"   # noqa: E731
                    self.assertEqual(r["ok"], comp(ba) == comp(bb), key)
                elif lake_a != lake_b or (lake_a and ba != bb):
                    self.assertFalse(r["ok"], (name, key))
                if not r["ok"]:
                    continue
                self.assertEqual(r["dry"], 0, (name, key))
                self.assertEqual(r["fast"], 0, (name, key))
                self.assertEqual(r["slowFast"], 0, (name, key))
                self.assertEqual(r["noEdge"], 0, (name, key))
                self.assertEqual(r["offNet"], 0, (name, key))
                self.assertTrue(r["again"], (name, key))
                self.assertTrue(r["skipper"])
        syn = self.o["docs"]["synthetic"]["taxis"]
        self.assertTrue(syn["pier:0>pier:3"]["ok"])
        self.assertTrue(syn["pier:6>pier:7"]["ok"])
        self.assertTrue(syn["pier:8>pier:9"]["ok"])
        self.assertFalse(syn["pier:0>pier:6"]["ok"])
        self.assertFalse(syn["pier:8>pier:0"]["ok"])

    def test_taxi_speeds(self):
        syn = self.o["docs"]["synthetic"]["taxis"]
        r = syn["pier:0>pier:4"]
        self.assertGreater(r["metres"], 300)
        self.assertLess(r["secs"], r["metres"] / 5.0)          # quicker than the water bus's pace

    def test_deterministic(self):
        again = _run({"synthetic": self.docs["synthetic"], "tiny": self.docs["tiny"]})
        for name in ("synthetic", "tiny"):
            a, b = self.o["docs"][name]["fp"], again["docs"][name]["fp"]
            self.assertEqual(hashlib.sha256(a.encode()).hexdigest(), hashlib.sha256(b.encode()).hexdigest())
            self.assertTrue(self.o["docs"][name]["fresh"])

    def test_taxi_controller(self):
        c = self.o["ctl"]
        self.assertTrue(c["ok"])
        self.assertEqual(c["states"], ["coming", "here", "riding", "done"])
        self.assertGreater(c["eta0"], 5)
        self.assertFalse(c["boardEarly"])
        self.assertTrue(c["board"])
        self.assertIsNone(c["carryBefore"])
        self.assertEqual(c["carry"]["anim"], "sit")
        self.assertTrue(c["cam"]["camera"])
        self.assertIsNone(c["carryAfter"])
        self.assertIsNotNone(c["ashore"])
        self.assertGreaterEqual(c["said"], 3)
        self.assertEqual(c["drawCalls"], 0)                       # no THREE, nothing drawn
        self.assertIsNone(c["lake"])                              # a lake pier to a canal pier: no water route
        self.assertEqual(c["nearest"], "pier:6")                    # the nearest pier on the same water as pier:7
        self.assertEqual(c["cancelled"], "cancelled")

    def test_view(self):
        v = self.o["view"]
        self.assertLessEqual(v["maxCalls"], 11)
        self.assertLessEqual(v["total"], 12)                      # plan 3.14: water transport <= 12 draw calls
        self.assertEqual(v["taxiCalls"], 1)
        self.assertLess(v["tris"], 90000)
        for n in ("waterbus-pier", "waterbus-cabin", "marina", "lake-launch"):
            s = v["shots"][n]
            self.assertIsNotNone(s, n)
            self.assertIn("pos", s)
            self.assertIn("look", s)
        self.assertIsNone(v["shots"]["nope"])
        self.assertIn("ferry-horn", v["sounds"])
        self.assertIn("gangway-clank", v["sounds"])               # the gangway's own clank (hqRide has one since Sound PR B)
        g = v["gang"]
        self.assertGreater(g["offMoving"], 0.2)                   # part way round, swinging
        self.assertLess(g["offCalm"], 1e-6)                       # Calm: simply out
        b = v["beam"]
        self.assertGreater(b["moving"], 0.5)
        self.assertLess(b["calm"], 1e-9)
        self.assertTrue(b["visibleNight"])
        self.assertFalse(b["visibleDay"])
        self.assertGreaterEqual(v["wakes"], 0)
        self.assertLessEqual(v["wakes"], 4)
        self.assertEqual(v["leftAfterDispose"], 0)

    def test_house_rules(self):
        with open(os.path.join(ROOT, "games", "hqferries.js"), encoding="utf-8") as fh:
            src = fh.read()
        self.assertNotIn("Math.random(", src)
        self.assertNotIn("innerHTML", src)
        self.assertNotIn("=>", src)                               # var-style ES5, as the rest of games/
        self.assertNotRegex(src, r"\b(let|const)\s")


if __name__ == "__main__":
    unittest.main()
