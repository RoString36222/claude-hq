"""Calling your vehicle (games/hqcall.js, docs/plans/dealership-spec.md "Calling your vehicle").

node: the kerb spot beside you (on the left of the way it arrives: [3.22.3] traffic keeps left), the route held a lane
left of the centre line and
ending at the kerb, the run along it (slowing for the corner, stopping at the spot, the same at 30 and 120 Hz), stopping
for an obstacle and going on once it moves, a redirect keeping its speed, and the out-of-sight spawn choice. Python:
hq3d's wiring (C, the call list keeping its keys, the step every frame, your vehicles put back in their world).
Skipped when node is not installed. Stdlib only."""
import json
import math
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
new Function(fs.readFileSync(root + "/games/hqcall.js", "utf8"))();
const H = window.HQV.hqCall, out = {};
// a road along +z (half carriageway 5 m) through the origin
out.kerbN = H.kerb({x: 0, z: 0, ux: 0, uz: 1, half: 5}, [0, 1]);
out.kerbS = H.kerb({x: 0, z: 0, ux: 0, uz: 1, half: 5}, [0, -1]);
out.kerbNarrow = H.kerb({x: 0, z: 0, ux: 0, uz: 1, half: 2}, null);
// an L: 120 m north up x = 0, then 80 m west... (west = +x in this frame), to the road point (80, 120)
const L = new Float64Array([0, 0, 0, 60, 0, 120, 40, 120, 80, 120]);
out.arr = H.arrival(L);
const spot = H.kerb({x: 80, z: 120, ux: 1, uz: 0, half: 5}, out.arr);
out.spot = spot;
const P = H.pathFor(L, spot, H.LANE);
out.path = Array.from(P);
// the centre line's distance from a point (the L's two legs)
function cdist(x, z){
  const a = Math.hypot(x - 0, 0) + 0, d1 = (z >= 0 && z <= 120) ? Math.abs(x) : Math.min(Math.hypot(x, z), Math.hypot(x, z - 120));
  const d2 = (x >= 0 && x <= 80) ? Math.abs(z - 120) : Math.min(Math.hypot(x, z - 120), Math.hypot(x - 80, z - 120));
  return Math.min(d1, d2);
}
function drive(hz, obsAt, clearAt){
  const R = H.run(P, 0), dt = 1/hz;
  let t = 0, vmax = 0, vCorner = 99, offMax = 0, minGap = 1e9, passed = false;
  while(!R.done && t < 120){
    let obs = [];
    if(obsAt && t < clearAt) obs = [{x: obsAt[0], z: obsAt[1], r: 1}];
    const ahead = H.aheadOf(R.x, R.z, R.yaw, obs, 1.4, 30);
    H.step(R, dt, ahead); t += dt;
    vmax = Math.max(vmax, R.v);
    if(Math.hypot(R.x - 0, R.z - 120) < 6) vCorner = Math.min(vCorner, R.v);
    if(R.s > 10 && R.len - R.s > 10) offMax = Math.max(offMax, cdist(R.x, R.z));
    if(obsAt && t < clearAt){ const g = Math.hypot(R.x - obsAt[0], R.z - obsAt[1]); minGap = Math.min(minGap, g); }
  }
  return {t, vmax, vCorner, offMax, minGap, done: R.done, x: R.x, z: R.z, yaw: R.yaw, len: R.len};
}
out.d60 = drive(60); out.d30 = drive(30); out.d120 = drive(120);
// a car stopped on its lane (the left: +x going +z) 50 m up the first leg, gone after 20 s
out.obs = drive(60, [1.8, 50], 20);
// a redirect: a new run started at speed keeps it
const R2 = H.run(P, 9); H.step(R2, 1/60, Infinity); out.redirectV = R2.v;
// out of sight: the nearest candidate over 40 m away that is not on screen (here: x < 0 is "on screen")
const cands = [{x: 10, z: 0}, {x: -50, z: 0}, {x: 60, z: 5}, {x: 45, z: 10}, {x: 200, z: 0}];
out.spawn = H.spawnPick(cands, {x: 0, z: 0}, (x, z) => x < 0, 40);
out.spawnNone = H.spawnPick([{x: 5, z: 0}], {x: 0, z: 0}, null, 40);
out.ahead = [H.aheadOf(0, 0, 0, [{x: 0, z: 20, r: 1}]), H.aheadOf(0, 0, 0, [{x: 5, z: 20, r: 1}]), H.aheadOf(0, 0, 0, [{x: 0, z: -20, r: 1}])];
// the carpark's polylines in the shapes HQV.hqCarpark may give them
const P1 = H.poly([{x: 0, y: 6, z: 0}, {x: 0, y: 3, z: 10}, {x: 5, y: 0, z: 10}]);
const P2 = H.poly([[1, 2], [3, 4]]), P3 = H.poly([[0, 9, 0], [1, 0, 1]]), P4 = H.poly([{x: 1, z: 1}]);
const arr = (a) => a ? Array.from(a).map(v => v !== v ? null : v) : null;
out.poly = {objs: {xz: arr(P1.xz), y: arr(P1.y)}, pairs: {xz: arr(P2.xz), y: arr(P2.y)}, triples: {xz: arr(P3.xz), y: arr(P3.y)}, short: P4};
const J = H.join(P1, new Float64Array([5, 10, 5, 30]));
out.join = {xz: arr(J.xz), y: arr(J.y)};
// down the ramps (heights) then 120 m of road
const J2 = H.join(P1, new Float64Array([5, 10, 5, 130]));
{ const R = H.run(J2.xz, 0, J2.y); let vRamp = 0, vRoad = 0, yStart = R.y, yMid = null, t = 0;
  while(!R.done && t < 120){ H.step(R, 1/60, Infinity); t += 1/60;
    if(R.y === R.y){ vRamp = Math.max(vRamp, R.v); if(yMid === null && R.s >= 10) yMid = R.y; } else vRoad = Math.max(vRoad, R.v); }
  out.ramp = {done: R.done, vRampMax: vRamp, vRoadMax: vRoad, yStart, yMid}; }
// a call (a time budget) from far away: a zig-zag of right angles every 80 m, after 300 m of carpark ramps
function zig(L, ramp){
  const xz = [], y = []; let x = 0, z = 0, d = 0;
  if(ramp){ for(let i = 0; i <= 30; i++){ xz.push(i & 1 ? 10 : 0, i*10); y.push(15 - i*0.5); } z = 310; }
  xz.push(x, z); y.push(NaN);
  for(let k = 0; k < L; k += 80){ d ^= 1; if(d) x += 80; else z += 80; xz.push(x, z); y.push(NaN); }
  return {xz: Float64Array.from(xz), y: ramp ? Float64Array.from(y) : null};
}
out.budget = [[80, 0, 30], [400, 0, 144], [6000, 0, 30], [6000, 1, 144], [6000, 1, 20]].map(([L, ramp, hz]) => {
  const z = zig(L, ramp), R = H.run(z.xz, 0, z.y, H.BUDGET); let t = 0, vEnd = 0;
  while(!R.done && t < 60){ H.step(R, 1/hz, Infinity); t += 1/hz; if(R.len - R.s < 20) vEnd = Math.max(vEnd, R.v); }
  return {len: R.len, t, done: R.done, vEnd, x: R.x, z: R.z};
});
{ const z = zig(1500, 0), R = H.run(z.xz, 0, null, H.BUDGET); let t = 0, w0 = null;      // a car blocks its last stretch for 1 s
  while(!R.done && t < 60){ if(w0 === null && R.len - R.s < 24) w0 = t; H.step(R, 1/60, w0 !== null && t < w0 + 1 ? 8 : Infinity); t += 1/60; }
  out.budgetBlocked = t; }
// the call list's search: every word, anywhere in the name, the where-it-is line or the tags; case and accents ignored
{ const it = {title: "Lamborghini Huracán STO", sub: "In the carpark", tags: "Lamborghini Huracán STO 2021 car super 5000 super v10 5204cc car"};
  out.match = [H.matches(it, ""), H.matches(it, "huracan"), H.matches(it, "LAMBO v10"), H.matches(it, "carpark sto"), H.matches(it, "bmw"), H.matches(it, "v10 bike")]; }
out.consts = {CRUISE: H.CRUISE, TURN_V: H.TURN_V, LANE: H.LANE, STOP_GAP: H.STOP_GAP, CALL_R: H.CALL_R, MIN_HIDE: H.MIN_HIDE, RAMP_V: H.RAMP_V};
console.log(JSON.stringify(out));
"""


@unittest.skipUnless(NODE, "node not installed")
class CallNode(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        r = subprocess.run([NODE, "--input-type=module", "-e", HARNESS % {"root": json.dumps(ROOT)}],
                           capture_output=True, text=True, timeout=120)
        if r.returncode:
            raise AssertionError(r.stderr[-3000:])
        cls.o = json.loads(r.stdout.strip().splitlines()[-1])

    def test_kerb_is_on_the_left_of_the_way_it_arrives(self):
        n, s = self.o["kerbN"], self.o["kerbS"]
        # [3.22.3] traffic keeps left: heading +z the left of travel is +x; heading -z it is -x; 5 m half carriageway,
        # 1.3 m in from its edge
        self.assertAlmostEqual(n["x"], 3.7, places=6); self.assertAlmostEqual(n["z"], 0, places=6)
        self.assertAlmostEqual(n["yaw"], 0, places=6)
        self.assertAlmostEqual(s["x"], -3.7, places=6)
        self.assertAlmostEqual(abs(s["yaw"]), math.pi, places=6)
        self.assertAlmostEqual(abs(self.o["kerbNarrow"]["x"]), 1.6, places=6, msg="never closer to the middle than 1.6 m")

    def test_arrival_direction(self):
        self.assertAlmostEqual(self.o["arr"][0], 1, places=6)
        self.assertAlmostEqual(self.o["arr"][1], 0, places=6)

    def test_path_keeps_left_and_ends_at_the_kerb(self):
        p, sp = self.o["path"], self.o["spot"]
        self.assertAlmostEqual(p[0], 0, places=6, msg="it starts where it stands (the offset eases in)")
        self.assertAlmostEqual(p[1], 0, places=6)
        self.assertAlmostEqual(p[-2], sp["x"], places=6); self.assertAlmostEqual(p[-1], sp["z"], places=6)
        # the first leg (going +z) on its left: x > 0, LANE m off
        mid = [(p[i], p[i + 1]) for i in range(0, len(p), 2) if 20 < p[i + 1] < 100]
        self.assertTrue(mid)
        for x, _ in mid:
            self.assertAlmostEqual(x, self.o["consts"]["LANE"], places=6)

    def test_run_reaches_the_spot_slowing_for_the_corner(self):
        d, c, sp = self.o["d60"], self.o["consts"], self.o["spot"]
        self.assertTrue(d["done"])
        self.assertAlmostEqual(d["x"], sp["x"], places=6); self.assertAlmostEqual(d["z"], sp["z"], places=6)
        self.assertAlmostEqual(d["yaw"], sp["yaw"], places=6)
        self.assertLessEqual(d["vmax"], c["CRUISE"] + 1e-9)
        self.assertGreater(d["vmax"], c["CRUISE"] - 1, "cruises on the 120 m leg")
        self.assertLess(d["vCorner"], c["TURN_V"] + 2.5, "slows through the right angle")
        # its lane (1.8 m off) and the drift to the kerb (3.7 m off): always inside the 5 m half carriageway
        self.assertLess(d["offMax"], 3.8, "stays on its side of the road")
        # about 200 m: cruise plus a corner and a stop, 20-35 s
        self.assertTrue(17 < d["t"] < 35, d["t"])

    def test_frame_rate_independent(self):
        t30, t120 = self.o["d30"]["t"], self.o["d120"]["t"]
        self.assertLess(abs(t30 - t120)/t120, 0.06, (t30, t120))

    def test_stops_for_an_obstacle_then_goes_on(self):
        o, c = self.o["obs"], self.o["consts"]
        self.assertTrue(o["done"], "it carries on once the way is clear")
        self.assertGreater(o["minGap"], c["STOP_GAP"] - 2.5, "never runs into it")
        self.assertGreater(o["t"], self.o["d60"]["t"] + 5, "it waited")

    def test_a_call_is_there_within_its_budget_from_anywhere(self):
        for b in self.o["budget"]:
            self.assertTrue(b["done"], b)
            self.assertLess(b["t"], 9, b)
            self.assertLessEqual(b["vEnd"], self.o["consts"]["CRUISE"] + 1e-9, "the last stretch is driven at street speed")
        self.assertGreater(self.o["budget"][3]["len"], 6000, "the carpark ramps and 6 km of road")
        self.assertLess(self.o["budgetBlocked"], 10, "held up on its last stretch, still under 10 s")

    def test_search_matches_every_word(self):
        self.assertEqual(self.o["match"], [True, True, True, True, False, False])

    def test_redirect_keeps_speed(self):
        self.assertGreater(self.o["redirectV"], 8.5)

    def test_out_of_sight_spawn(self):
        self.assertEqual(self.o["spawn"], {"x": 45, "z": 10}, "the nearest over 40 m that is not on screen")
        self.assertIsNone(self.o["spawnNone"])

    def test_ahead(self):
        a = self.o["ahead"]
        self.assertAlmostEqual(a[0], 19, places=6, msg="20 m ahead in its lane, less the obstacle's radius")
        self.assertIsNone(a[1], "5 m to the side: not in its lane (Infinity, null in JSON)")
        self.assertIsNone(a[2], "behind it: nothing ahead")

    def test_carpark_polylines(self):
        p = self.o["poly"]
        self.assertEqual(p["objs"]["xz"], [0, 0, 0, 10, 5, 10])
        self.assertEqual(p["objs"]["y"], [6, 3, 0])
        self.assertEqual(p["pairs"]["xz"], [1, 2, 3, 4])
        self.assertIsNone(p["pairs"]["y"], "no heights: on the ground")
        self.assertEqual(p["triples"]["y"], [9, 0])
        self.assertIsNone(p["short"], "one point is not a path")
        j = self.o["join"]
        self.assertEqual(j["xz"], [0, 0, 0, 10, 5, 10, 5, 30], "the road path's first point (on the carpark's last) is dropped")
        self.assertEqual(j["y"][:3], [6, 3, 0])
        self.assertIsNone(j["y"][3], "NaN: the ground (null in JSON)")

    def test_down_the_ramps_slowly_then_the_road(self):
        r, c = self.o["ramp"], self.o["consts"]
        self.assertTrue(r["done"])
        self.assertLessEqual(r["vRampMax"], c["RAMP_V"] + 1e-9, "inside the carpark it keeps to RAMP_V")
        self.assertGreater(r["vRoadMax"], c["RAMP_V"] + 3, "out on the road it speeds up")
        self.assertAlmostEqual(r["yStart"], 6, places=6)
        self.assertAlmostEqual(r["yMid"], 3, places=1)


CHIPS = r"""
import fs from "fs";
const root = %(root)s;
function El(tag){ this.tagName = String(tag).toLowerCase(); this.children = []; this.parentNode = null; this.attrs = {}; this.ls = {};
  this.style = {}; this.hidden = false; this._t = ""; this.className = ""; this.type = ""; this.value = ""; this.tabIndex = 0; }
El.prototype.appendChild = function(k){ k.parentNode = this; this.children.push(k); return k; };
El.prototype.removeChild = function(k){ var i = this.children.indexOf(k); if(i >= 0) this.children.splice(i, 1); k.parentNode = null; return k; };
Object.defineProperty(El.prototype, "firstChild", {get(){ return this.children[0] || null; }});
Object.defineProperty(El.prototype, "textContent", {get(){ return this._t + this.children.map(k => k.textContent).join(""); }, set(v){ this.children = []; this._t = String(v); }});
Object.defineProperty(El.prototype, "classList", {get(){ var el = this; return {contains(c){ return (" " + el.className + " ").indexOf(" " + c + " ") >= 0; }}; }});
El.prototype.setAttribute = function(k, v){ this.attrs[k] = String(v); };
El.prototype.getAttribute = function(k){ return this.attrs[k] != null ? this.attrs[k] : null; };
El.prototype.addEventListener = function(t, f){ (this.ls[t] = this.ls[t] || []).push(f); };
El.prototype.removeEventListener = function(){};
El.prototype.all = function(){ var o = [this]; this.children.forEach(k => { o = o.concat(k.all()); }); return o; };
El.prototype.querySelectorAll = function(sel){ var t = sel.match(/^[a-z]+/), cs = sel.replace(/^[a-z]+/, "").split(".").filter(Boolean);
  return this.all().slice(1).filter(n => (!t || n.tagName === t[0]) && cs.every(c => n.classList.contains(c))); };
El.prototype.querySelector = function(sel){ return this.querySelectorAll(sel)[0] || null; };
El.prototype.closest = function(sel){ var c = sel.replace(".", ""); for(var n = this; n; n = n.parentNode) if(n.classList.contains(c)) return n; return null; };
El.prototype.focus = function(){ globalThis.document.activeElement = this; };
El.prototype.click = function(){ (this.ls.click || []).slice().forEach(f => f({target: this})); };
El.prototype.key = function(k){ var e = {type: "keydown", key: k, target: this, preventDefault(){}, stopPropagation(){}};
  for(var n = this; n; n = n.parentNode) (n.ls.keydown || []).slice().forEach(f => f(e)); };
globalThis.document = {createElement: t => new El(t), activeElement: null};
const store = {}; let lsThrow = false;
Object.defineProperty(globalThis, "localStorage", {configurable: true, get(){ if(lsThrow) throw new Error("denied");
  return {getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }}; }});
globalThis.window = {HQV: {}};
globalThis.setTimeout = (f) => 0;
new Function(fs.readFileSync(root + "/games/hqcall.js", "utf8"))();
const H = window.HQV.hqCall, out = {};
const items = [
  {key: "a", title: "BMW M2", sub: "In the carpark", tags: "BMW M2 2023 car coupe rwd 2993cc 6 cylinder car"},
  {key: "b", title: "KTM 390 Duke", sub: "In the carpark", tags: "KTM 390 Duke 2024 bike naked 399cc bike motorbike motorcycle"},
  {key: "c", title: "Your car", sub: "Right here", tags: "car starter"},
  {key: "d", title: "Skyhawk", sub: "On the roof", tags: "Skyhawk heli helicopter car"},
  {key: "e", title: "Nothing", sub: "", tags: ""},
  {key: "f", title: "Jet ski", sub: "At the jetty", tags: "jetski boat"}
];
out.chipOf = items.map(H.chipOf);
out.counts = H.chipCounts(items);
out.filter = {cars: H.filterItems(items, "car", "").map(i => i.key), bikes: H.filterItems(items, "bike", "").map(i => i.key),
  heli: H.filterItems(items, "heli", "").map(i => i.key), all: H.filterItems(items, "all", "").map(i => i.key),
  carsBmw: H.filterItems(items, "car", "bmw").map(i => i.key), bikesBmw: H.filterItems(items, "bike", "bmw").map(i => i.key),
  bogus: H.filterItems(items, "spaceship", "ktm").map(i => i.key), carpark: H.filterItems(items, "car", "carpark").map(i => i.key)};
out.chips = [H.chips(false).map(c => c.label), H.chips(true).map(c => c.label)];
// the C list: chips over the list, a count on each, arrows pick, remembered, an empty chip explains
let list = items.slice(0, 3), jetty = false;
const stage = new El("div"), picks = [];
const ui = H.mount(stage, {items: () => list, onPick: k => picks.push(k), atJetty: () => jetty});
ui.open();
const root2 = ui.root, group = root2.querySelector(".hqcall-chips");
const chipsNow = () => root2.querySelectorAll(".hqcall-chip").map(b => [b.textContent, b.getAttribute("role"), b.getAttribute("aria-checked"), b.tabIndex]);
const names = () => root2.querySelectorAll(".hqcall-name").map(n => n.textContent);
out.ui = {role: group.getAttribute("role"), label: group.getAttribute("aria-label"), chips: chipsNow(), names: names()};
root2.querySelectorAll(".hqcall-chip")[0].key("ArrowRight");
out.ui.afterRight = chipsNow().map(c => c[2]); out.ui.namesCars = names(); out.ui.stored = store["hq_call_chip"];
out.ui.focus = document.activeElement && document.activeElement.textContent;
root2.querySelectorAll(".hqcall-chip")[1].key("ArrowLeft"); root2.querySelectorAll(".hqcall-chip")[0].key("ArrowLeft");
out.ui.wrapLeft = chipsNow().map(c => c[2]);
out.ui.heliEmpty = root2.querySelector(".hqcall-empty") ? root2.querySelector(".hqcall-empty").textContent : null;
root2.querySelectorAll(".hqcall-chip")[1].click();
ui.search("bmw"); out.ui.carsBmw = names();
ui.search("ktm"); out.ui.carsKtm = root2.querySelector(".hqcall-empty").textContent;
ui.search("");
// remembered: a new panel opens on Cars
const ui2 = H.mount(new El("div"), {items: () => list, onPick(){}}); ui2.open();
out.ui.remembered = ui2.root.querySelectorAll(".hqcall-chip").filter(b => b.getAttribute("aria-checked") === "true").map(b => b.textContent);
// boats only at a jetty
jetty = true; ui.render(); out.ui.jettyChips = chipsNow().map(c => c[0]);
// a throwing localStorage: still works, starts on All
lsThrow = true;
const ui3 = H.mount(new El("div"), {items: () => list, onPick(){}}); ui3.open();
out.ui.throwing = ui3.root.querySelectorAll(".hqcall-chip").filter(b => b.getAttribute("aria-checked") === "true").map(b => b.textContent);
ui3.root.querySelectorAll(".hqcall-chip")[2].click();
out.ui.throwingClick = ui3.root.querySelectorAll(".hqcall-chip").filter(b => b.getAttribute("aria-checked") === "true").map(b => b.textContent);
lsThrow = false;
// no vehicles at all: the old message, no chips
list = []; ui.render(); out.ui.none = [root2.querySelector(".hqcall-empty").textContent, group.hidden];
// keys inside the chips stay in the panel
out.ui.owns = H.owns({target: root2.querySelector(".hqcall-chip")});
console.log(JSON.stringify(out));
"""


@unittest.skipUnless(NODE, "node not installed")
class CallChips(unittest.TestCase):
    """The filter chips (transport revamp 3.11): All · Cars · Bikes · Helicopters (· Boats at a jetty)."""

    @classmethod
    def setUpClass(cls):
        r = subprocess.run([NODE, "--input-type=module", "-e", CHIPS % {"root": json.dumps(ROOT)}],
                           capture_output=True, text=True, timeout=120)
        if r.returncode:
            raise AssertionError(r.stderr[-3000:])
        cls.o = json.loads(r.stdout.strip().splitlines()[-1])

    def test_pure_chip_of_and_counts(self):
        self.assertEqual(self.o["chipOf"], ["car", "bike", "car", "heli", "car", "boat"])
        self.assertEqual(self.o["counts"], {"all": 6, "car": 3, "bike": 1, "heli": 1, "boat": 1})

    def test_filter_combines_with_text(self):
        f = self.o["filter"]
        self.assertEqual(f["cars"], ["a", "c", "e"])
        self.assertEqual(f["bikes"], ["b"])
        self.assertEqual(f["heli"], ["d"])
        self.assertEqual(f["all"], ["a", "b", "c", "d", "e", "f"])
        self.assertEqual(f["carsBmw"], ["a"])
        self.assertEqual(f["bikesBmw"], [])
        self.assertEqual(f["bogus"], ["b"], "an unknown chip is All")
        self.assertEqual(f["carpark"], ["a"], "the search reads the where-it-is line too; the chip reads only the tags")

    def test_chip_list(self):
        self.assertEqual(self.o["chips"][0], ["All", "Cars", "Bikes", "Helicopters"])
        self.assertEqual(self.o["chips"][1], ["All", "Cars", "Bikes", "Helicopters", "Boats"])

    def test_the_c_list(self):
        u = self.o["ui"]
        self.assertEqual(u["role"], "radiogroup")
        self.assertEqual(u["label"], "Vehicle type")
        self.assertEqual([c[0] for c in u["chips"]], ["All 3", "Cars 2", "Bikes 1", "Helicopters 0"])
        self.assertEqual({c[1] for c in u["chips"]}, {"radio"})
        self.assertEqual([c[2] for c in u["chips"]], ["true", "false", "false", "false"])
        self.assertEqual([c[3] for c in u["chips"]], [0, -1, -1, -1], "roving tabindex")
        self.assertEqual(u["names"], ["BMW M2", "KTM 390 Duke", "Your car"])
        self.assertEqual(u["afterRight"], ["false", "true", "false", "false"])
        self.assertEqual(u["namesCars"], ["BMW M2", "Your car"])
        self.assertEqual(u["stored"], "car", "remembered")
        self.assertEqual(u["focus"], "Cars 2", "focus follows the pick")
        self.assertEqual(u["wrapLeft"], ["false", "false", "false", "true"], "Left from All wraps to Helicopters")
        self.assertEqual(u["heliEmpty"], "No helicopters yet: the dealership has them.")
        self.assertEqual(u["carsBmw"], ["BMW M2"])
        self.assertEqual(u["carsKtm"], "Nothing matches “ktm”.")
        self.assertEqual(u["remembered"], ["Cars 2"])
        self.assertEqual(u["jettyChips"][-1], "Boats 0")
        self.assertEqual(u["throwing"], ["All 3"])
        self.assertEqual(u["throwingClick"], ["Bikes 1"])
        self.assertEqual(u["none"], ["No vehicles yet. Pick one in the Showroom (G).", True])
        self.assertTrue(u["owns"])


class CallWiring(unittest.TestCase):
    """games/hq3d.js: C opens the list (a tap; held it still raises the camera), the list keeps its keys, the call
    steps every frame, your vehicles are put back in their world, a called vehicle can't be boarded on the move."""

    @classmethod
    def setUpClass(cls):
        cls.src = read("games", "hq3d.js")

    def test_c_tap_opens_the_list(self):
        self.assertRegex(self.src, r'e\.code === "KeyC"[^\n]*callOn\(\)')
        self.assertIn("E.now() - cTap < 0.25", self.src)
        self.assertIn("callToggle()", self.src)

    def test_list_keeps_its_keys(self):
        self.assertIn("HQV.hqCall.owns(e)", self.src)

    def test_steps_every_frame_and_places_your_vehicles(self):
        self.assertRegex(self.src, r"moveAvatar\(dt\);\s*\n\s*callStep\(dt\);")
        self.assertIn("ownPlace(cur);", self.src)

    def test_no_boarding_on_the_move(self):
        self.assertIn("if(b.calling) return;", self.src)

    def test_hqgarage_contract(self):
        for s in ("HQV.hqGarage.mine()", "HQV.hqGarage.park(o.ownId, {world: o.world, x: o.x, z: o.z, yaw: o.yaw})"):
            self.assertIn(s, self.src)
        # park only for a trip cut short (a world change); the carpark is where your vehicles live
        self.assertIn("} else if(midTrip){", self.src)
        # back in its bay: the Arena is told so, and a pose saved on the way in is dropped (it put the car on the
        # street at its bay's coordinates on the next load)
        self.assertRegex(self.src, r"if\(o\.stored\)\{[^}]*clearTimeout\(parkTimer\[o\.key\]\)[^}]*\n\s*try \{ Promise\.resolve\(HQV\.hqGarage\.park\(o\.ownId, null\)\)")
        # the list stays current without opening C (a vehicle claimed at the dealership is known straight away)
        self.assertIn("HQV.hqGarage.onChange(function(){ ownRefresh(); })", self.src)
        # the Arena's paint is an index: a colour for drawing, and an index back for buying / presence
        self.assertIn('if(typeof ph === "number") ph = cat && cat.paints && cat.paints[ph] ? cat.paints[ph].hex : null;', self.src)
        self.assertIn("Gr.buy(id, paintIdx(V && V.cat, hex))", self.src)
        self.assertIn("paint: paintIdx(V.cat, col)", self.src)

    def test_carpark_contract_and_the_way_back(self):
        for s in ("C.carpark.site()", 'cpPath(K, "exitPath", bay)', 'cpPath(K, "entryPath", bay)', "cpEntrance(K)",
                  "K.cp.bayOf(K.site, key)", "K.cp.bays(K.site)", "K.cp.release(K.site, key)", "ownLeft(b)", "goBack(b)"):
            self.assertIn(s, self.src)
        # only the garage the City draws (a site above its tier stands in the doc but is not built)
        self.assertNotIn("cp.find(RD.W())", self.src)

    def test_text_only(self):
        self.assertNotIn("innerHTML", read("games", "hqcall.js"))


if __name__ == "__main__":
    unittest.main()
