"""HQ growth (HQ 3.37): a township grows over its two neighbouring plots with its owner's Claude worker-hours, and every
live session is a builder on it.

The growth rules and storage are tested in Rust (backend/src/hqwork/tests.rs), the plots in the generator
(backend/src/worldgen/v5/doc.rs townships_have_room_to_grow) and the HQ app's count (dashboard-rs/src/arena.rs
hq_work_*). Here, under node with the real modules: games/hqgrowth.js's pure parts (buildOf, annexRings, groundRing,
activeSite, sitePlan, crewPlan, crewAt) on a township as the generator writes it, straight and turned; the township's wall
round the ground it has grown over (hqcityparts townPlan via hqcity3d's townOf / growthOf); and the privacy allowlist
(only dates and whole numbers leave, only while the HQ is open, and the egress is documented). Stdlib only; the node
part is skipped without node."""
import json
import os
import re
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")


def read(*p):
    with open(os.path.join(ROOT, *p), encoding="utf-8") as f:
        return f.read()


HARNESS = r"""
import fs from "fs";
const root = %(root)s;
globalThis.window = {HQV: {}};
const HQV = window.HQV;
for (const f of ["hqstyle", "hqtower", "hqbase", "world", "hqcityparts", "hqgrowth", "hqcity", "hqmerge", "hqnav", "hqcarlift", "hqcity3d"])
  new Function(fs.readFileSync(root + "/games/" + f + ".js", "utf8"))();
const G = HQV.hqGrowth, C3 = HQV.hqCity3d, P = HQV.hqCityParts;
// a township as the generator writes it (cm): 88 x 56 m centred at (100, 200) m, turned th, its gates, its two 55 m plots
// flush with its sides (the first on its +x side, past the way out)
function township(th){
  const fx = Math.sin(th), fz = Math.cos(th), ax = fz, az = -fx;
  const at = (a, b) => [Math.round(10000 + a*ax + b*fx), Math.round(20000 + a*az + b*fz)];
  const front = [Math.round(fx*65536), Math.round(fz*65536)];
  const rect = (a0, a1) => [at(a0, 2800), at(a1, 2800), at(a1, -2800), at(a0, -2800)].reverse();
  return {id: 3, kind: "hq", rank: 3, x: 10000, z: 20000, w: 8800, d: 5600, front: front, door: [at(0, 2800)[0], 0, at(0, 2800)[1]],
    poly: rect(-4400, 4400),
    gates: [{x: at(-3750, 2800)[0], z: at(-3750, 2800)[1], dir: front, kind: "in", w: 700}, {x: at(3750, 2800)[0], z: at(3750, 2800)[1], dir: front, kind: "out", w: 700}],
    annex: [{x: at(7150, 0)[0], z: at(7150, 0)[1], poly: rect(4400, 9900)}, {x: at(-7150, 0)[0], z: at(-7150, 0)[1], poly: rect(-9900, -4400)}]};
}
function inRing(R, x, z){ var c = false; for(var i = 0, j = R.length - 1; i < R.length; j = i++){ var a = R[i], b = R[j]; if((a[1] > z) !== (b[1] > z) && x < (b[0] - a[0])*(z - a[1])/(b[1] - a[1]) + a[0]) c = !c; } return c; }
function bnd(R){ return {x0: Math.min(...R.map(q => q[0])), x1: Math.max(...R.map(q => q[0])), z0: Math.min(...R.map(q => q[1])), z1: Math.max(...R.map(q => q[1]))}; }
const out = {};
// 1. the build as the Arena sends it, checked
out.build = [null, {}, {pts: 3, lots: 1, stages: [-1, -1]}, {pts: 60, lots: 2, stages: [2, -1]}, {pts: 290, lots: 3, stages: [4, 4]},
  {pts: "9", lots: 9, stages: [7, 2]}, {pts: 20, stages: [1.5, 3]}, {pts: 50, lots: 3, stages: [2, 3]}].map(b => G.buildOf(b ? {build: b} : null));
// 2. the plots in the lot's frame, the ground the wall goes round, straight and turned
out.frames = [0, 0.52, -2.2].map(function(th){
  const l = township(th), p = C3.placeLot(l), R = C3.lotRing(l, p), rings = G.annexRings(l, p);
  const r = {rings: rings.map(bnd), lot: bnd(R), ground: [0, 1, 2].map(n => bnd(G.groundRing(R, rings, n))), gates: P.townGates(l, p)};
  // the township as it has grown: its wall round all of its ground, its gateways where the doc has them
  const h = {userId: "u-1", build: {pts: 200, lots: 3, stages: [4, 1]}, crew: {working: 3, needs: 1}};
  const GR = C3.growthOf(l, p, h, R), T = C3.townOf(l, p, 2, GR.ground), T0 = C3.townOf(l, p, 2);
  r.town = {x0: T.x0, x1: T.x1, gates: T.gates.map(g => Math.round(g.x*10)/10), gates0: T0.gates.map(g => Math.round(g.x*10)/10), x00: T0.x0, x10: T0.x1};
  r.active = GR.A; r.crew = C3.crewCount(h); r.plans = GR.plans.map(P => P && {crane: !!P.crane, n: P.items.length});
  r.blocks = GR.blocks.length;
  return r;
});
out.crewCap = [{}, {crew: {working: 5, needs: 9}}, {crew: {working: -3}}].map(h => C3.crewCount(h));
// 3. where the builders work
out.active = [{stages: [-1, -1]}, {stages: [0, -1]}, {stages: [3, -1]}, {stages: [4, -1]}, {stages: [4, 0]}, {stages: [4, 4]}].map(b => G.activeSite(G.buildOf({build: b})));
// 4. each plot's plan at each stage, on a 55 x 56 m plot
const plot = [[44, 28], [99, 28], [99, -28], [44, -28]];
out.plans = [-1, 0, 1, 2, 3, 4].map(function(st){
  const A = G.sitePlan(plot, st, {seed: "u-1:0", side: 1, active: true}), B = G.sitePlan(plot, st, {seed: "u-1:0", side: 1, active: true});
  const Cp = G.sitePlan(plot, st, {seed: "u-2:0", side: 1, active: true}), I = G.sitePlan(plot, st, {seed: "u-1:0", side: 1, active: false});
  const kinds = {}; A.items.forEach(it => { kinds[it.kind] = (kinds[it.kind] || 0) + 1; });
  const pts = A.items.filter(it => isFinite(it.x) && isFinite(it.z) && it.kind !== "ground" && it.kind !== "path");
  return {kinds: kinds, same: JSON.stringify(A) === JSON.stringify(B), differs: JSON.stringify(A) !== JSON.stringify(Cp),
    inside: pts.every(it => it.x > 44 && it.x < 99 && it.z > -28 && it.z < 28),
    spots: A.spots.length, spotsIn: A.spots.every(s => s[0] > 44 && s[0] < 99 && s[1] > -28 && s[1] < 28),
    store: A.store, crane: A.crane, craneIdle: I.crane, blocksIn: A.blocks.every(b => b[0] > 44 && b[0] < 99 && b[1] > -28 && b[1] < 28),
    landmark: (A.items.filter(it => it.kind === "landmark")[0] || {}).style || null,
    landmarks: ["a", "b", "c", "d", "e", "f", "g", "h"].map(s => (G.sitePlan(plot, 4, {seed: s}).items.filter(it => it.kind === "landmark")[0] || {}).style)};
});
// 5. the builders
const P2 = G.sitePlan(plot, 2, {seed: "u-1:0", side: 1, active: true});
out.crewN = [0, 1, 4, 8, 20].map(n => G.crewPlan(n, P2, "u-1").length);
const crew = G.crewPlan(6, P2, "u-1");
out.roles = crew.map(w => w.role);
out.crewSame = JSON.stringify(crew) === JSON.stringify(G.crewPlan(6, P2, "u-1"));
out.calm = crew.map(w => { const a = G.crewAt(w, 123.4, true); return a.x === w.spot[0] && a.z === w.spot[1] && !a.walk && !a.swing; });
// a carrier goes from the store to its spot and back, on the plot, carrying only on the way there
const cw = crew[0], track = [];
for(let t = 0; t < 120; t += 0.25) track.push(G.crewAt(cw, t, false));
out.carry = {inside: track.every(a => a.x > 44 && a.x < 99 && a.z > -28 && a.z < 28),
  reaches: track.some(a => Math.hypot(a.x - cw.spot[0], a.z - cw.spot[1]) < 0.05), store: track.some(a => Math.hypot(a.x - cw.from[0], a.z - cw.from[1]) < 0.05),
  loadedBack: track.some((a, i) => i && a.load && Math.hypot(a.x - cw.from[0], a.z - cw.from[1]) < Math.hypot(track[i - 1].x - cw.from[0], track[i - 1].z - cw.from[1]) - 1e-6)};
const hw = crew[1], sw = [];
for(let t = 0; t < 4; t += 0.1) sw.push(G.crewAt(hw, t, false).swing);
out.hammer = {min: Math.min(...sw), max: Math.max(...sw), still: [0, 1, 2].every(t => { const a = G.crewAt(hw, t, false); return a.x === hw.spot[0] && a.z === hw.spot[1]; })};
out.text = [{pts: 0}, {pts: 60, lots: 2, stages: [2, -1]}, {pts: 290, lots: 3, stages: [4, 4]}].map(b => G.growthText(G.buildOf({build: b})));
out.crewText = C3.crewText({crew: {working: 2, needs: 1}, build: {pts: 60, lots: 2, stages: [2, -1]}});
out.crewTextOld = C3.crewText({crew: {working: 2, needs: 1}});
// 6. drawn: three.js and a stub ctx; every stage's plot and the builders build, merge to a few draws, and step
const THREE = await import(root + "/games/vendor/three-module.js");
const texts = [];
var noop2d = new Proxy({}, {get(t, k){ return k === "measureText" ? function(s){ return {width: String(s).length*20}; } : k === "fillText" ? function(s){ texts.push(String(s)); } : function(){ return {addColorStop(){}}; }; }, set(){ return true; }});
const MC = {};
function mat(c, o){ const k = JSON.stringify([c, o || {}]); return MC[k] || (MC[k] = new THREE.MeshStandardMaterial(Object.assign({color: c}, o || {}))); }
function add(o, x, y, z, p){ o.position.set(x, y, z); p.add(o); return o; }
var c = {THREE: THREE, PI: Math.PI, mat: mat, box(w, h, d, m, x, y, z, p){ return add(new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m), x, y, z, p); },
  canvasTex(w, h, draw){ if(draw) draw(noop2d, w, h); return {c: null, g: noop2d, t: new THREE.Texture()}; }};
function draws(g){ let n = 0; g.traverse(o => { if(o.visible && (o.isMesh || o.isSprite)) n += Array.isArray(o.material) ? o.material.length : 1; }); return n; }
out.drawn = [-1, 0, 1, 2, 3, 4].map(function(st){
  const g = new THREE.Group(), Pl = G.sitePlan(plot, st, {seed: "u-1:0", side: 1, active: true});
  G.siteBuild(c, g, Pl, 0.03);
  const before = draws(g), crew = G.crewPlan(8, Pl, "u-1"), C = G.crewBuild(c, Pl, crew, 0.03);
  g.add(C.g);
  const roots = {}; roots[C.g.uuid] = 1;
  HQV.hqMerge.mergeStatic(THREE, g, {keep: o => { for(let q = o; q && q !== g; q = q.parent) if(roots[q.uuid]) return true; return false; }});
  const p0 = C.men.map(M => M.g.position.clone());
  G.crewStep(C, 3.7, false); const moved = C.men.some((M, i) => M.g.position.distanceTo(p0[i]) > 0.01 || M.arm.rotation.x !== 0);
  G.crewStep(C, 9.1, true); const calm = C.men.every(M => M.g.position.x === M.w.spot[0] && M.g.position.z === M.w.spot[1]);
  return {before: before, after: draws(g) - draws(C.g), men: C.men.length, crane: !!C.crane, moved: moved, calm: calm};
});
out.signs = texts.slice(0, 4);
console.log(JSON.stringify(out));
"""


@unittest.skipUnless(NODE, "node not installed")
class GrowthClient(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        js = os.path.join(ROOT, "tests", ".growth_harness.mjs")
        with open(js, "w", encoding="utf-8") as f:
            f.write(HARNESS % {"root": json.dumps(ROOT)})
        try:
            r = subprocess.run([NODE, js], capture_output=True, text=True, timeout=120)
        finally:
            os.remove(js)
        if r.returncode:
            raise AssertionError(r.stderr[-3000:])
        cls.o = json.loads(r.stdout.strip().splitlines()[-1])

    def test_the_build_is_checked(self):
        b = self.o["build"]
        self.assertEqual(b[0], {"pts": 0, "lots": 1, "stages": [-1, -1]}, "no build: one lot")
        self.assertEqual(b[1], {"pts": 0, "lots": 1, "stages": [-1, -1]})
        self.assertEqual(b[3], {"pts": 60, "lots": 2, "stages": [2, -1]})
        self.assertEqual(b[4], {"pts": 290, "lots": 3, "stages": [4, 4]})
        # out of range, not whole, or a later plot ahead of an earlier one: clamped, dropped, held back
        self.assertEqual(b[5], {"pts": 0, "lots": 3, "stages": [4, 2]})
        self.assertEqual(b[6], {"pts": 20, "lots": 1, "stages": [-1, -1]})
        self.assertEqual(b[7], {"pts": 50, "lots": 2, "stages": [2, -1]})
        # lots always follows the stages, never the number sent
        for x in b:
            self.assertEqual(x["lots"], 1 + sum(1 for s in x["stages"] if s >= 0))

    def test_the_plots_sit_beside_the_township_and_its_wall_goes_round_them(self):
        for f in self.o["frames"]:
            lot, (r0, r1) = f["lot"], f["rings"]
            self.assertAlmostEqual(lot["x1"] - lot["x0"], 88, delta=0.1)
            for r in (r0, r1):
                self.assertAlmostEqual(r["x1"] - r["x0"], 55, delta=0.1)
                self.assertAlmostEqual(r["z0"], lot["z0"], delta=0.1)
                self.assertAlmostEqual(r["z1"], lot["z1"], delta=0.1)
            # one each side, flush, the first past the way out (the gates' +x side in this frame)
            gx = {g["kind"]: g["x"] for g in f["gates"]}
            first_side = 1 if gx["out"] > gx["in"] else -1
            if first_side > 0:
                self.assertAlmostEqual(r0["x0"], lot["x1"], delta=0.1); self.assertAlmostEqual(r1["x1"], lot["x0"], delta=0.1)
            else:
                self.assertAlmostEqual(r0["x1"], lot["x0"], delta=0.1); self.assertAlmostEqual(r1["x0"], lot["x1"], delta=0.1)
            g0, g1, g2 = f["ground"]
            self.assertEqual(g0, lot, "nothing added: the lot")
            self.assertAlmostEqual(g1["x1"] - g1["x0"], 143, delta=0.1)
            self.assertAlmostEqual(g2["x1"] - g2["x0"], 198, delta=0.1)
            # the wall round the grown ground, the gateways where they were
            t = f["town"]
            self.assertAlmostEqual(t["x0"], g2["x0"], delta=0.1)
            self.assertAlmostEqual(t["x1"], g2["x1"], delta=0.1)
            self.assertEqual(t["gates"], t["gates0"])
            self.assertAlmostEqual(t["x10"] - t["x00"], 88, delta=0.1)
            # building the second plot (the first at its landmark): the crane over the second, both plots planned
            self.assertEqual(f["active"], {"k": 1, "mode": "build"})
            self.assertEqual([p["crane"] for p in f["plans"]], [False, True])
            self.assertEqual(f["crew"], 4)
            self.assertGreater(f["blocks"], 4)
        self.assertEqual(self.o["crewCap"], [0, 8, 0])

    def test_the_builders_work_on_the_first_plot_not_finished(self):
        # none added: clearing the first; building it; at its landmark (the second not yet added): tending it; the second
        self.assertEqual(self.o["active"], [{"k": 0, "mode": "clear"}, {"k": 0, "mode": "build"}, {"k": 0, "mode": "build"},
                                            {"k": 0, "mode": "tend"}, {"k": 1, "mode": "build"}, {"k": 1, "mode": "tend"}])

    def test_each_stage_draws_what_it_should(self):
        p = {s: x for s, x in zip([-1, 0, 1, 2, 3, 4], self.o["plans"])}
        for s, x in p.items():
            self.assertTrue(x["same"], f"stage {s} deterministic")
            self.assertTrue(x["inside"] and x["spotsIn"] and x["blocksIn"], f"stage {s} on its plot")
            self.assertGreater(x["spots"], 0, f"stage {s} somewhere to work")
            self.assertEqual(x["kinds"].get("ground"), 1)
        self.assertTrue(all(p[s]["differs"] for s in (0, 1, 2, 3, 4)), "each owner's own")
        # not yet added: fenced off, signed, nothing built, no crane
        self.assertEqual(p[-1]["kinds"].get("sign"), 1)
        self.assertGreater(p[-1]["kinds"].get("post", 0), 20)
        self.assertNotIn("building", p[-1]["kinds"]); self.assertIsNone(p[-1]["crane"])
        self.assertEqual(p[0]["kinds"].get("peg"), 12); self.assertEqual(p[0]["kinds"].get("hut"), 1)
        self.assertEqual(p[1]["kinds"].get("slab"), 3); self.assertEqual(p[1]["kinds"].get("rebar"), 3)
        self.assertEqual(p[2]["kinds"].get("building"), 3); self.assertEqual(p[2]["kinds"].get("scaffold"), 3)
        self.assertEqual(p[3]["kinds"].get("pond"), 1); self.assertGreaterEqual(p[3]["kinds"].get("tree", 0), 6)
        self.assertNotIn("scaffold", p[3]["kinds"])
        self.assertEqual(p[4]["kinds"].get("landmark"), 1); self.assertNotIn("pond", p[4]["kinds"])
        self.assertIn(p[4]["landmark"], ("clock", "spire", "dome"))
        self.assertGreaterEqual(len(set(p[4]["landmarks"])), 2, "not every landmark the same")
        for s in (-1, 0, 1, 2, 3):
            self.assertNotIn("landmark", p[s]["kinds"])
        # the crane while there is building to do, only on the builders' plot
        for s in (0, 1, 2, 3):
            self.assertIsNotNone(p[s]["crane"]); self.assertIsNone(p[s]["craneIdle"])
        self.assertIsNone(p[4]["crane"])

    def test_the_builders(self):
        o = self.o
        self.assertEqual(o["crewN"], [0, 1, 4, 8, 8], "one for each live session, at most eight")
        self.assertEqual(o["roles"], ["carry", "hammer"] * 3)
        self.assertTrue(o["crewSame"])
        self.assertTrue(all(o["calm"]), "Calm: at their work, still")
        c = o["carry"]
        self.assertTrue(c["inside"] and c["reaches"] and c["store"])
        self.assertFalse(c["loadedBack"], "carrying only on the way to the work")
        h = o["hammer"]
        self.assertLess(h["min"], 0.05); self.assertGreater(h["max"], 0.95); self.assertTrue(h["still"])

    def test_it_draws_in_few_draws_and_the_builders_move(self):
        for st, d in zip([-1, 0, 1, 2, 3, 4], self.o["drawn"]):
            self.assertGreater(d["before"], 3, f"stage {st} draws something")
            self.assertLessEqual(d["after"], 24, f"stage {st}: {d['after']} draws once merged")
            self.assertEqual(d["men"], 8)
            self.assertTrue(d["moved"] and d["calm"], f"stage {st}")
            self.assertEqual(d["crane"], 0 <= st < 4)
        self.assertIn("ROOM TO GROW", self.o["signs"])

    def test_the_words(self):
        self.assertEqual(self.o["text"], ["", "2 lots · buildings", "3 lots · complete"])
        self.assertEqual(self.o["crewText"], "2 working · 1 need them · 2 lots · buildings")
        self.assertEqual(self.o["crewTextOld"], "2 working · 1 need them", "an older Arena: as before")


class GrowthSource(unittest.TestCase):
    def test_house_rules(self):
        g = read("games", "hqgrowth.js")
        self.assertNotIn("Math.random", g)
        self.assertNotRegex(g, r"innerHTML|insertAdjacentHTML|document\.write")
        self.assertIn("mulberry32", g)
        self.assertIn("if(calm) return out;", g, "Calm: the builders stand still")
        self.assertIn("calm ? 0.6", g, "Calm: the crane holds still")
        c3 = read("games", "hqcity3d.js")
        self.assertIn("var calm = !!(c.E && c.E.calm && c.E.calm());\n    hqs.forEach(function(E){\n      var C = E.crewG;", c3)
        self.assertIn('"hqcityparts","hqgrowth","hqcity"', read("ui", "app", "22-hq.js"))

    def test_the_rules_match_across_the_pieces(self):
        w = read("backend", "src", "hqwork.rs")
        self.assertIn('pub(crate) const STAGES: [&str; 5] = ["bare ground", "foundations", "buildings", "amenities", "landmark"];', w)
        self.assertIn('var STAGES = ["bare ground", "foundations", "buildings", "amenities", "landmark"];', read("games", "hqgrowth.js"))
        self.assertIn("pub(crate) const ANNEXES: usize = 2;", w)
        self.assertIn("var ANNEXES = 2;", read("games", "hqgrowth.js"))
        self.assertIn("pub(crate) const DAY_CAP: i64 = 24;", w)
        self.assertIn("pub const HQ_WORK_DAY_CAP: i64 = 24;", read("dashboard-rs", "src", "arena.rs"))
        self.assertIn("pub const HQ_ANNEX_W: i64 = 5_500;", read("backend", "src", "worldgen", "v5", "doc.rs"))


class GrowthPrivacy(unittest.TestCase):
    def test_only_dates_and_whole_numbers_leave(self):
        arena = read("dashboard-rs", "src", "arena.rs")
        body = arena[arena.index("pub fn hq_work_body"):]
        body = body[:body.index("\n}\n")]
        self.assertIn('json!({"days": days.iter().map(|(d, n)| json!({"day": py::date_iso(d), "hours": (*n).clamp(0, HQ_WORK_DAY_CAP)}))', body)
        hours = arena[arena.index("pub fn hq_work_hours"):]
        hours = hours[:hours.index("\n}\n")]
        self.assertIn("d.hours.len() as i64", hours, "a count of hours, nothing of their content")
        self.assertIn('self.authed_send("PUT", "/v1/hq/me/work", hq_work_body(&days))', arena)
        # sent only with the crew, while the HQ is open to the city
        server = read("dashboard-rs", "src", "server.rs")
        self.assertIn('if crew.is_some() && code == 200 && r.get("open") == Some(&Value::Bool(true)) {', server)
        # the Arena refuses anything else
        w = read("backend", "src", "hqwork.rs")
        self.assertIn('matches!(k.as_str(), "day" | "hours")', w)
        self.assertIn('k.as_str() != "days"', w)
        self.assertIn("UNPROCESSABLE_ENTITY", w)
        self.assertIn("save_allowed", w)
        self.assertIn('"/v1/hq/me/work"', read("backend", "src", "hq.rs"))
        sql = read("backend", "migrations", "0027_hq_work.sql")
        self.assertIn("CREATE TABLE IF NOT EXISTS hq_work (user_id VARCHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE, day TEXT NOT NULL, hours INTEGER NOT NULL", sql)

    def test_the_egress_is_documented(self):
        agents = read("AGENTS.md")
        self.assertIn("/v1/hq/me/work", agents)
        self.assertIn("HQ 3.37", agents)
        readme = read("README.md")
        start = readme.index("## 🔒 Privacy & security")
        privacy = readme[start:readme.index("\n## ", start + 1)]
        self.assertIn("worker-hours", privacy)


if __name__ == "__main__":
    unittest.main()
