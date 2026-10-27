"""Claude Cabs (games/hqcabs.js) and its phone apps (games/hqphonecabs.js), docs/plans/transport-revamp.md 3.9, 3.12, 5.9.

node: the classes, quotes along the hqnav route on the real Commons (@2 fixture), the seeded driver (deterministic,
rating 4.6-5.0, a plate, a model of the class from the catalogue), driver-mode requests (deterministic, spaced by slot,
20 s offers, pickups on a road near you, drop-offs 0.4-3 km away), the drive rating and trip score, the local driver
stats with a fake and a throwing localStorage, the ride state machine on a fake call engine (matching, coming, here,
riding, skip ahead, done with a ticket and an achievement, cancel, Calm's fade), driver mode end to end, and the phone
apps under a DOM stub (registration, tabs, class chips, the dealership call). Skipped when node is not installed."""
import json
import os
import re
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")
FIX = os.path.join(ROOT, "tests", "fixtures")


def read(*p):
    with open(os.path.join(ROOT, *p), encoding="utf-8") as f:
        return f.read()


HARNESS = r"""
import fs from "fs";
import zlib from "zlib";
const root = %(root)s;
/* ---------- a small DOM ---------- */
function El(tag){ this.tagName = String(tag).toLowerCase(); this.children = []; this.parentNode = null; this.attrs = {}; this.ls = {};
  this.style = {}; this.hidden = false; this.disabled = false; this._t = ""; this.className = ""; this.type = ""; this.value = ""; this.tabIndex = 0; }
El.prototype.appendChild = function(k){ k.parentNode = this; this.children.push(k); return k; };
El.prototype.removeChild = function(k){ var i = this.children.indexOf(k); if(i >= 0) this.children.splice(i, 1); k.parentNode = null; return k; };
Object.defineProperty(El.prototype, "firstChild", {get(){ return this.children[0] || null; }});
Object.defineProperty(El.prototype, "textContent", {get(){ return this._t + this.children.map(k => k.textContent).join(""); }, set(v){ this.children = []; this._t = String(v); }});
Object.defineProperty(El.prototype, "classList", {get(){ var el = this; return {
  contains(c){ return (" " + el.className + " ").indexOf(" " + c + " ") >= 0; },
  add(c){ if(!this.contains(c)) el.className = (el.className + " " + c).trim(); },
  remove(c){ el.className = (" " + el.className + " ").replace(" " + c + " ", " ").trim(); },
  toggle(c, on){ if(on === undefined) on = !this.contains(c); if(on) this.add(c); else this.remove(c); }}; }});
El.prototype.setAttribute = function(k, v){ this.attrs[k] = String(v); };
El.prototype.getAttribute = function(k){ return this.attrs[k] != null ? this.attrs[k] : null; };
El.prototype.addEventListener = function(t, f){ (this.ls[t] = this.ls[t] || []).push(f); };
El.prototype.removeEventListener = function(t, f){ var L = this.ls[t] || [], i = L.indexOf(f); if(i >= 0) L.splice(i, 1); };
El.prototype.all = function(){ var o = [this]; this.children.forEach(k => { o = o.concat(k.all()); }); return o; };
El.prototype.querySelectorAll = function(sel){ var t = sel.match(/^[a-z0-9]+/i), cs = sel.replace(/^[a-z0-9]+/i, "").split(".").filter(Boolean);
  return this.all().slice(1).filter(n => (!t || n.tagName === t[0].toLowerCase()) && cs.every(c => n.classList.contains(c))); };
El.prototype.querySelector = function(sel){ return this.querySelectorAll(sel)[0] || null; };
El.prototype.closest = function(sel){ var c = sel.replace(".", ""); for(var n = this; n; n = n.parentNode) if(n.classList && n.classList.contains(c)) return n; return null; };
El.prototype.focus = function(){ globalThis.document.activeElement = this; };
El.prototype.click = function(){ (this.ls.click || []).slice().forEach(f => f({target: this})); };
El.prototype.key = function(k){ var e = {type: "keydown", key: k, target: this, preventDefault(){}, stopPropagation(){}};
  for(var n = this; n; n = n.parentNode) (n.ls.keydown || []).slice().forEach(f => f(e)); };
globalThis.document = {createElement: t => new El(t), documentElement: new El("html"), activeElement: null};
const store = {};
globalThis.window = {HQV: {}, document: globalThis.document};
let lsMode = "ok";
Object.defineProperty(globalThis.window, "localStorage", {get(){ if(lsMode === "throw") throw new Error("denied"); if(lsMode === "none") return undefined;
  return {getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; }}; }});
for (const f of ["world", "hqnav", "hqcall", "hqride", "hqcabs", "hqphonecabs"])
  new Function(fs.readFileSync(root + "/games/" + f + ".js", "utf8"))();
const H = window.HQV, WD = H.world, CB = H.hqCabs, out = {};
const gz = p => JSON.parse(zlib.gunzipSync(fs.readFileSync(p)).toString("utf8"));
const W = WD.pack(gz(%(commons)s)); W.id = "claude-hq@3";
const cat = JSON.parse(fs.readFileSync(root + "/games/vehicles/catalogue.json", "utf8"));

/* ---------- classes and quotes ---------- */
out.classes = CB.classes().map(c => c.id);
const sp = W.sites.filter(s => s.kind === "spawn")[0], from = {x: sp.x/100, z: sp.z/100};
const dock = W.sites.filter(s => s.kind === "dock")[0], to = H.hqnav.doorOf(dock);
const MS = Date.UTC(2026, 9, 24, 12, 0, 0);
out.quote = {cab: CB.quote(W, from, to, "cab", MS), cab2: CB.quote(W, from, to, "cab", MS + 30000), heli: CB.quote(W, from, to, "heli", MS),
             straight: Math.hypot(to.x - from.x, to.z - from.z), route: H.hqnav.route(H.hqnav.graph(W, 5), from, to, "drive").len,
             minutes: [0, 1, 2, 3, 4, 5].map(m => CB.quote(W, from, to, "cab", MS + m*60000).eta),
             noWorld: CB.quote(null, {x: 0, z: 0}, {x: 300, z: 400}, "go", MS)};

/* ---------- drivers ---------- */
out.drivers = {};
CB.classes().forEach(c => { out.drivers[c.id] = [0, 1, 2, 3, 4, 5, 6, 7].map(k => CB.driverFor("claude-hq@3", "ride" + k, c.id, cat)); });
out.driverAgain = CB.driverFor("claude-hq@3", "ride0", "cab", cat);
out.driverNoCat = CB.driverFor("claude-hq@3", "ride0", "lux", null);
out.catClass = {}; cat.vehicles.forEach(v => { out.catClass[v.id] = [v["class"], !!(v.spec && v.spec.electric)]; });

/* ---------- driver-mode requests ---------- */
const near = {x: from.x, z: from.z, r: 1200};
const seen = {}, live = [];
for(let t = MS; t < MS + 20*60000; t += 2500){
  const L = CB.requests(W, t, "claude-hq@3", near);
  live.push(L.length);
  L.forEach(o => { if(!seen[o.id]) seen[o.id] = o; if(!(o.at <= t && t < o.expires)) throw new Error("not live: " + o.id); });
}
const offers = Object.keys(seen).map(k => seen[k]).sort((a, b) => a.at - b.at);
out.req = {n: offers.length, maxLive: Math.max.apply(null, live), ats: offers.map(o => o.at), lifes: offers.map(o => o.expires - o.at),
  straight: offers.map(o => Math.hypot(o.drop.x - o.pickup.x, o.drop.z - o.pickup.z)), pickupM: offers.map(o => Math.hypot(o.pickup.x - near.x, o.pickup.z - near.z)),
  metres: offers.map(o => o.metres), names: offers.map(o => o.drop.name), ids: offers.map(o => o.id),
  onRoad: offers.map(o => { const r = WD.nearestRoad(W, o.pickup.x, o.pickup.z, 30); return r ? r.dist <= r.half : false; }),
  npcOff: offers.map(o => Math.hypot(o.npc.x - o.pickup.x, o.npc.z - o.pickup.z))};
// a fresh copy of the world gives the very same offers (a pure function of world, minute, slot)
const W2 = WD.pack(gz(%(commons)s)); W2.id = "claude-hq@3";
const again = [];
for(let t = MS; t < MS + 20*60000; t += 2500) CB.requests(W2, t, "claude-hq@3", near).forEach(o => { if(!again.some(x => x.id === o.id)) again.push(o); });
out.req.same = JSON.stringify(again.map(o => [o.id, o.pickup, o.drop, o.metres])) === JSON.stringify(offers.map(o => [o.id, o.pickup, o.drop, o.metres]));
out.req.otherSeed = CB.requests(W, MS + 60000, "user:other@3", near).map(o => o.id + JSON.stringify(o.pickup));

/* ---------- the drive rating and the trip score ---------- */
function samples(fnv, n){ const S = []; for(let i = 0; i <= n; i++) S.push({t: i*0.25, v: fnv(i*0.25), street: true}); return S; }
const smooth = samples(t => Math.min(12, t*2), 200), harsh = samples(t => t < 20 ? 12 : t < 21 ? 12 - (t - 20)*9 : 3, 200);
const fast = samples(t => 20, 200), fastHighway = samples(t => 20, 200).map(s => ({t: s.t, v: s.v, street: false}));
out.rate = {smooth: CB.rateDrive({samples: smooth}), harsh: CB.rateDrive({samples: harsh}), fast: CB.rateDrive({samples: fast}),
  highway: CB.rateDrive({samples: fastHighway}), kerb: CB.rateDrive({samples: smooth, kerb: 2}), awful: CB.rateDrive({samples: fast, kerb: 9}), empty: CB.rateDrive(null)};
out.score = {good: CB.scoreTrip({samples: smooth, metres: 1500, secs: 150, expect: 190}), late: CB.scoreTrip({samples: smooth, metres: 1500, secs: 400, expect: 190}),
  rough: CB.scoreTrip({samples: harsh, metres: 1500, secs: 150, expect: 190})};

/* ---------- local driver stats ---------- */
lsMode = "ok";
out.stats0 = CB.driverStats();
CB.recordFare({points: 100, stars: 5}); CB.recordFare({points: 50, stars: 4});
out.stats2 = CB.driverStats(); out.stored = JSON.parse(store[CB.consts.STATS_KEY]);
lsMode = "throw";
let threw = false; try { CB.recordFare({points: 10, stars: 3}); out.statsThrow = CB.driverStats(); } catch(e){ threw = true; }
out.threw = threw;
lsMode = "ok";

/* ---------- the ride on a fake call engine ---------- */
function fakeCall(){
  return {
    kerb(road){ return {x: road.x, z: road.z, yaw: 0}; }, arrival(){ return [0, 1]; },
    pathFor(pts, spot){ return Float64Array.from([pts[0], pts[1], spot.x, spot.z]); },
    run(P){ const len = Math.hypot(P[2] - P[0], P[3] - P[1]); return {P, len, s: 0, v: 0, x: P[0], z: P[1], yaw: Math.atan2(P[2] - P[0], P[3] - P[1]), done: len < 0.01}; },
    step(R, dt){ if(R.done) return R; R.v = 12; R.s = Math.min(R.len, R.s + 12*dt); const f = R.len ? R.s/R.len : 1; R.x = R.P[0] + (R.P[2] - R.P[0])*f; R.z = R.P[1] + (R.P[3] - R.P[1])*f; if(R.s >= R.len) R.done = true; return R; },
    pointAt(R, s){ const f = R.len ? s/R.len : 1; return {x: R.P[0] + (R.P[2] - R.P[0])*f, z: R.P[1] + (R.P[3] - R.P[1])*f}; },
    etaOf(R){ return Math.max(1, Math.round((R.len - R.s)/12)); }
  };
}
function machine(calmOn){
  const said = [], tix = [], ach = [], fades = [], shown = [], snd = [];
  let me = {x: 0, z: 0, speed: 0, driving: false};
  const C = CB.mount(null, {W: null, me: () => me, seed: "claude-hq@3"}, {call: fakeCall(), announce: t => said.push(t), calm: () => calmOn,
    tickets: {add(t){ tix.push(t); return t; }}, achievements: {record(e){ ach.push(e); }}, fade(ms){ fades.push(ms); }, showRoute(p, l){ shown.push(p ? l : null); },
    sfx(n, o){ snd.push([n, o || null]); }});
  const log = [];
  let t = MS;
  const h = C.request({x: 3000, z: 0, name: "Harbour Street"}, "cab", t);
  log.push(h.state().phase);
  const matchAt = t;
  while(h.state().phase === "matching" && t < MS + 10000){ t += 100; C.update(t, 0.1); }
  const matchMs = t - matchAt;
  log.push(h.state().phase);
  const etaStart = h.state().eta, metStart = h.state().metres;
  while(h.state().phase === "coming" && t < MS + 600000){ t += 100; C.update(t, 0.1); }
  log.push(h.state().phase);
  const st = h.state();
  me = {x: 50, z: 50};
  const farBoard = h.board();
  const cab = C.carry(t);
  me = {x: 0, z: 0};
  const board = C.use();
  log.push(h.state().phase);
  t += 100; C.update(t, 0.1);
  const carry = C.carry(t), cam = C.camPose(t, {});
  const canSkip = h.state().canSkip, skip = h.skip();
  const afterSkip = h.state();
  let n = 0;
  while(h.state().phase === "riding" && t < MS + 3600000){ t += 100; C.update(t, 0.1); n++; }
  log.push(h.state().phase);
  const exit = h.state().exit, carryDone = C.carry(t);
  const rated = h.rate(5);
  // a second ride, cancelled while it comes
  const h2 = C.request({x: -500, z: 0, name: "Market"}, "bike", t);
  t += 4000; C.update(t, 0.1);
  const h2phase = h2.state().phase, cancel = h2.cancel(), h2after = h2.state().phase;
  return {log, matchMs, etaStart, metStart, here: st, farBoard, cabBeforeBoard: cab, board, carry, cam: !!(cam && cam.camera), canSkip, skip,
          skipping: afterSkip.skipping, steps: n, exit, carryDone, rated, said, tix, ach, fades, h2phase, cancel, h2after, shown,
          state: C.state(), driver: h.driver, snd};
}
out.ride = machine(false);
out.rideCalm = machine(true);

/* ---------- driver mode ---------- */
{
  const said = [], ach = [], snd = [];
  let me = {x: from.x, z: from.z, speed: 0, driving: false, street: true, kerbHits: 0};
  const C = CB.mount(null, {W: W, me: () => me, seed: "claude-hq@3"}, {call: H.hqCall, announce: t => said.push(t), achievements: {record(e){ ach.push(e); }},
    sfx(n, o){ snd.push([n, o || null, {x: me.x, z: me.z}]); }});
  const d = {};
  d.offWalking = C.driver.on(true);
  me.driving = true;
  d.on = C.driver.on(true);
  let t = MS; C.update(t, 0.1);
  let O = C.driver.offers();
  while(!O.length && t < MS + 600000){ t += 2500; C.update(t, 0.1); O = C.driver.offers(); }
  d.offers = O.length;
  const o = O[0];
  d.acceptBad = C.driver.accept("nope");
  d.accept = C.driver.accept(o.id);
  d.phase1 = C.driver.state().phase;
  // drive to the pickup: arriving fast does not count, stopping does
  me = Object.assign(me, {x: o.pickup.x + 2, z: o.pickup.z, speed: 5}); t += 1000; C.update(t, 0.1);
  d.phaseFast = C.driver.state().phase;
  me.speed = 0.4; t += 100; C.update(t, 0.1);
  d.phase2 = C.driver.state().phase;
  t += 3000; C.update(t, 0.1);
  d.phase3 = C.driver.state().phase;
  // the trip: smooth driving, one kerb hit
  for(let i = 0; i < 400; i++){ me.speed = Math.min(11, i*0.5); t += 250; C.update(t, 0.25); }
  me.kerbHits = 1;
  me = Object.assign(me, {x: o.drop.x + 3, z: o.drop.z, speed: 0.2}); t += 250; C.update(t, 0.25);
  d.phase4 = C.driver.state().phase;
  t += 2500; C.update(t, 0.1);
  const s = C.driver.state();
  d.phase5 = s.phase; d.result = s.result; d.stats = s.stats; d.ach = ach; d.said = said.slice(-1);
  d.off = C.driver.on(false); d.offPhase = C.driver.state().phase;
  d.snd = snd;
  out.drive = d;
}

/* ---------- the phone apps ---------- */
{
  const Q = H.hqPhoneQueue || [];
  out.apps = Q.map(a => ({id: a.id, name: a.name, dock: !!a.dock, needsCity: !!a.needsCity, glyph: typeof a.glyph, render: typeof a.render, order: a.order}));
  const said = [];
  let me = {x: from.x, z: from.z, speed: 0, driving: false};
  const C = CB.mount(null, {W: W, me: () => me, seed: "claude-hq@3"}, {call: H.hqCall, announce: t => said.push(t)});
  const host = {cabs: C, me: () => me, announce: t => said.push("phone:" + t), calm: () => false, now: () => MS,
    places: () => H.hqnav.places(W, 5, {x: from.x, z: from.z}).map(p => ({id: p.id, name: p.label, x: p.door.x, z: p.door.z, kind: p.kind})),
    ride: H.hqRide, vehicles: {list: () => [{key: "own:1", title: "BMW M2", sub: "In the carpark", tags: "bmw m2 car"}, {key: "own:2", title: "KTM 390 Duke", sub: "In the carpark", tags: "ktm bike motorbike motorcycle"}], call(k){ said.push("call:" + k); return true; }},
    heli: {spots: () => [{id: "open:1:2", x: 1, y: 0, z: 2, kind: "open", name: "Open ground", dist: 40}], call(s, o){ said.push("heli:" + s.id + ":" + (o && o.own)); return {}; }},
    dealer: {mount(el, done){ said.push("dealer-mounted"); host._done = done; }}, sfx(n){ said.push("sfx:" + n); }};
  const el = new El("div"), cabsApp = Q.filter(a => a.id === "claude-cabs")[0];
  const A = cabsApp.render(el, host, {back(){}, open(){}, title(){}, setBadge(){}});
  const tabs = el.querySelectorAll(".pc-tab"), chips = el.querySelectorAll(".pc-chip");
  out.phone = {tabs: tabs.map(t => [t.textContent, t.getAttribute("role"), t.getAttribute("aria-selected")]),
    chips: chips.map(c => [c.getAttribute("role"), c.getAttribute("aria-checked"), c.tabIndex]), chipNames: chips.map(c => c.querySelector(".pc-chip-name").textContent),
    radiogroup: el.querySelector(".pc-chips").getAttribute("role"), price: /\d+\s*coins|\$|£|€/.test(el.textContent), free: el.textContent.indexOf("free") >= 0};
  // arrow keys move the class pick (roving tabindex) and remember it
  chips.filter(c => c.getAttribute("aria-checked") === "true")[0].key("ArrowRight");
  out.phone.afterArrow = el.querySelectorAll(".pc-chip").map(c => c.getAttribute("aria-checked"));
  out.phone.remembered = store[H.hqPhoneCabs.CLS_KEY];
  // search a destination, pick it, request
  const q = el.querySelector(".pc-search"); q.value = "dock"; (q.ls.input || []).forEach(f => f({}));
  const opt = el.querySelector(".pc-opt"); out.phone.opt = opt ? opt.textContent : null; if(opt) opt.click();
  el.querySelectorAll(".pc-primary")[0].click();
  out.phone.state = C.state().phase;
  out.phone.live = !!el.querySelector(".pc-live");
  A.tick(MS);
  out.phone.cancelBtn = el.querySelectorAll(".pc-btn").map(b => b.textContent).indexOf("Cancel ride") >= 0;
  out.phone.badge = cabsApp.badge(host);
  // the Drive tab
  tabs[1].click();
  out.phone.drive = el.querySelector(".pc-toggle").getAttribute("aria-pressed");
  out.phone.statsShown = el.querySelectorAll("dt").map(d => d.textContent);
  // Vehicles: chips from hqCall and a heli spot list
  const ve = new El("div"); Q.filter(a => a.id === "vehicles")[0].render(ve, host, {back(){}});
  out.phone.vehChips = ve.querySelectorAll(".hqcall-chip").map(c => c.textContent);
  ve.querySelectorAll(".hqcall-chip").filter(c => /^Helicopters/.test(c.textContent))[0].click();
  out.phone.vehHeliEmpty = ve.querySelector(".pc-list").textContent;
  ve.querySelectorAll(".pc-primary").filter(b => b.textContent === "Call a helicopter")[0].click();
  const land = ve.querySelectorAll(".pc-btn").filter(b => b.textContent === "Land here")[0]; if(land) land.click();
  // Dealership: the ring, then the catalogue, then the delivery line
  const de = new El("div"), DA = Q.filter(a => a.id === "dealership")[0].render(de, host, {back(){}});
  out.phone.ringText = de.querySelector(".pc-msg").textContent; out.phone.ringing = !!de.querySelector(".pc-ringing");
  DA._answer();
  out.phone.answered = de.querySelector(".pc-msg").textContent;
  host._done({id: "abc", name: "BMW M2", level: 2, bay: 14});
  out.phone.delivered = de.querySelector(".pc-msg").textContent;
  de.querySelectorAll(".pc-primary")[0].click();
  DA.dispose();
  out.phone.said = said;
}
/* ---------- drawing (three.js): every cab instanced, the beacon, Calm's ring ---------- */
{
  const THREE = await import(root + "/games/vendor/three-module.js");
  const scene = new THREE.Scene();
  let calm = false, me = {x: from.x, z: from.z, speed: 0, driving: true, yaw: 0};
  const C = CB.mount({THREE, scene}, {W: W, me: () => me, ground: () => 0, group: scene, seed: "claude-hq@3"},
                     {call: H.hqCall, calm: () => calm, catalogue: cat, models: null});
  let t = MS;
  C.request(to, "xl", t);
  for(let i = 0; i < 60; i++){ t += 100; C.update(t, 0.1); }
  const d = {coming: C.drawCalls(), inst: []};
  scene.traverse(o => { if(o.isInstancedMesh && o.visible) d.inst.push(o.count); });
  d.rig = (() => { const R = C.driverRig(); return R ? {seat: !!R.seat, grips: R.grips.length, feet: R.feet.length} : null; })();
  C.cancel(); t += 100; C.update(t, 0.1);
  d.cancelled = C.drawCalls();
  // driver mode: the beacon (a light column; Calm a still ring)
  C.driver.on(true);
  let O = []; while(!O.length && t < MS + 600000){ t += 2500; C.update(t, 0.1); O = C.driver.offers(); }
  C.driver.accept(O[0].id); t += 100; C.update(t, 0.1);
  const vis = () => { const v = []; scene.traverse(o => { if(o.isMesh && !o.isInstancedMesh && o.visible) v.push(o.geometry.type); }); return v; };
  d.beacon = vis(); d.beaconCalls = C.drawCalls();
  calm = true; t += 100; C.update(t, 0.1); d.beaconCalm = vis();
  d.shot = C.tools.shotCam("driver-pickup") ? 1 : 0;
  C.dispose();
  let left = 0; scene.traverse(o => { if(o !== scene) left++; });
  d.left = left;
  out.draw = d;
}
console.log(JSON.stringify(out));
"""


@unittest.skipUnless(NODE, "node not installed")
class CabsNode(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        src = HARNESS % {"root": json.dumps(ROOT), "commons": json.dumps(os.path.join(FIX, "claude-hq@2.json.gz"))}
        r = subprocess.run([NODE, "--input-type=module", "-e", src], capture_output=True, text=True, timeout=300)
        if r.returncode:
            raise AssertionError(r.stderr[-3000:])
        cls.o = json.loads(r.stdout.strip().splitlines()[-1])

    def test_classes(self):
        self.assertEqual(self.o["classes"], ["bike", "go", "cab", "xl", "lux", "heli", "water"])

    def test_quotes(self):
        q = self.o["quote"]
        self.assertAlmostEqual(q["cab"]["metres"], q["route"], delta=1, msg="metres along the hqnav drive route")
        self.assertGreaterEqual(q["cab"]["metres"], q["straight"] - 1)
        self.assertAlmostEqual(q["cab"]["secs"], q["cab"]["metres"]/12, delta=1, msg="at street speed")
        self.assertAlmostEqual(q["heli"]["metres"], q["straight"], delta=1, msg="a helicopter flies straight")
        self.assertEqual(q["cab"]["eta"], q["cab2"]["eta"], "the same minute, the same nearest driver")
        self.assertGreater(len(set(q["minutes"])), 1, "the nearest driver changes from minute to minute")
        for e in q["minutes"]:
            self.assertTrue(20 <= e <= 150, e)
        self.assertAlmostEqual(q["noWorld"]["metres"], 500*1.3, delta=1, msg="no roads: straight x 1.3")
        for k in ("cab", "heli"):
            self.assertNotIn("price", q[k])
            self.assertNotIn("fare", q[k])

    def test_drivers(self):
        D, cc = self.o["drivers"], self.o["catClass"]
        self.assertEqual(self.o["driverAgain"], D["cab"][0], "the same ride, the same driver")
        names = set()
        for cls, L in D.items():
            for d in L:
                self.assertTrue(4.6 <= d["rating"] <= 5.0, d)
                self.assertRegex(d["plate"], r"^CC\d{2} [A-Z]{3}$")
                self.assertRegex(d["paint"], r"^#[0-9a-f]{6}$")
                names.add(d["name"])
                if cls in ("heli", "water"):
                    continue
                k, ev = cc[d["modelId"]]
                if cls == "bike":
                    self.assertTrue(k.startswith("bike."), d)
                if cls == "go":
                    self.assertTrue(k.startswith("car.hatch."), d)
                if cls == "cab":
                    self.assertTrue(k.startswith("car.sedan.") and not ev, d)
                if cls == "xl":
                    self.assertTrue(k.startswith("car.suv."), d)
                if cls == "lux":
                    self.assertTrue(ev, d)
        self.assertGreater(len(names), 10, "a varied list of names")
        self.assertIn(self.o["driverNoCat"]["modelId"], ("bmw-i4-m50", "bmw-i7-m70"))

    def test_requests_are_deterministic_and_spaced(self):
        r = self.o["req"]
        self.assertGreater(r["n"], 20, "requests come in over 20 minutes")
        self.assertTrue(r["same"], "a pure function of the world, the minute and the slot")
        self.assertEqual(len(set(r["ids"])), r["n"])
        for a in r["ats"]:
            self.assertEqual(a % 15000, 0, "on a slot")
        for a, b in zip(r["ats"], r["ats"][1:]):
            self.assertGreaterEqual(b - a, 15000, "one offer a slot")
        self.assertTrue(all(x == 20000 for x in r["lifes"]), "offered for 20 s")
        self.assertLessEqual(r["maxLive"], 2)
        for s in r["straight"]:
            self.assertTrue(320 <= s <= 3150, s)
        for m, s in zip(r["metres"], r["straight"]):
            self.assertGreaterEqual(m, s - 1)
        for p in r["pickupM"]:
            self.assertLessEqual(p, 1300, "pickups near you")
        self.assertTrue(all(r["onRoad"]), "the car stops on the road")
        for d in r["npcOff"]:
            self.assertTrue(1.5 < d < 8, "the passenger waits on the pavement beside it")
        self.assertTrue(all(n for n in r["names"]))

    def test_rating_and_score(self):
        r = self.o["rate"]
        self.assertEqual(r["smooth"], 5)
        self.assertLess(r["harsh"], 5)
        self.assertLess(r["fast"], 4, "over 60 km/h on streets")
        self.assertEqual(r["highway"], 5, "not on a highway")
        self.assertLess(r["kerb"], 5)
        self.assertEqual(r["awful"], 1)
        self.assertEqual(r["empty"], 5)
        s = self.o["score"]
        self.assertEqual(s["good"]["stars"], 5)
        self.assertEqual(s["good"]["parts"], {"distance": 150, "onTime": 50, "smooth": 50})
        self.assertEqual(s["good"]["points"], 250)
        self.assertLess(s["late"]["points"], s["good"]["points"])
        self.assertLess(s["rough"]["points"], s["good"]["points"])

    def test_driver_stats_local(self):
        self.assertEqual(self.o["stats0"], {"score": 0, "fares": 0, "rating": 0})
        self.assertEqual(self.o["stats2"], {"score": 150, "fares": 2, "rating": 4.5})
        self.assertEqual(self.o["stored"]["fares"], 2)
        self.assertFalse(self.o["threw"], "a throwing localStorage never breaks it")
        self.assertEqual(self.o["statsThrow"]["fares"], 3, "an in-memory copy carries on")

    def test_ride_state_machine(self):
        R = self.o["ride"]
        self.assertEqual(R["log"], ["matching", "coming", "here", "riding", "done"])
        self.assertTrue(1000 <= R["matchMs"] <= 3100, R["matchMs"])
        self.assertGreater(R["etaStart"], 0)
        self.assertEqual(R["here"]["phase"], "here")
        self.assertFalse(R["farBoard"], "E only works beside the cab")
        self.assertTrue(R["board"])
        c = R["carry"]
        self.assertEqual(c["anim"], "sit"); self.assertEqual(c["seat"], "rear-left")   # [3.22.3] the kerb side, with traffic on the left
        self.assertTrue(R["cam"])
        self.assertTrue(R["canSkip"], "3 km: Skip ahead is offered")
        self.assertTrue(R["skip"]); self.assertTrue(R["skipping"])
        self.assertLess(R["steps"]*0.1, 3000/12/2, "4x while skipping")
        self.assertIsNone(R["carryDone"])
        self.assertIsNotNone(R["exit"])
        self.assertTrue(R["rated"])
        self.assertEqual(len(R["tix"]), 1)
        self.assertEqual(R["tix"][0]["mode"], "cab"); self.assertEqual(R["tix"][0]["to"], "Harbour Street")
        self.assertEqual([a["type"] for a in R["ach"]], ["ride"]); self.assertEqual(R["ach"][0]["mode"], "cab")
        self.assertEqual(R["h2phase"], "coming")
        self.assertTrue(R["cancel"]); self.assertEqual(R["h2after"], "cancelled")
        self.assertTrue(any("Matched" in s for s in R["said"]))
        self.assertTrue(any("is here" in s for s in R["said"]))
        self.assertTrue(any("arrived" in s for s in R["said"]))
        self.assertIn("Your Claude Cab", R["shown"], "the route goes to the minimap")
        self.assertEqual(R["fades"], [])

    def test_calm_skip_is_a_fade(self):
        R = self.o["rideCalm"]
        self.assertEqual(R["log"][-1], "done")
        self.assertEqual(R["fades"], [600])
        self.assertFalse(R["skipping"], "no fast-forward under Calm")
        self.assertLess(R["steps"]*0.1, 15, "cut to the last 150 m")

    def test_driver_mode(self):
        d = self.o["drive"]
        self.assertFalse(d["offWalking"]["ok"], "you need to be in a car")
        self.assertTrue(d["on"]["ok"])
        self.assertGreater(d["offers"], 0)
        self.assertFalse(d["acceptBad"]); self.assertTrue(d["accept"])
        self.assertEqual(d["phase1"], "pickup")
        self.assertEqual(d["phaseFast"], "pickup", "rolling past does not pick them up")
        self.assertEqual(d["phase2"], "boarding")
        self.assertEqual(d["phase3"], "trip")
        self.assertEqual(d["phase4"], "alighting")
        self.assertEqual(d["phase5"], "idle")
        res = d["result"]
        self.assertEqual(res["stars"], 4, "one kerb hit")
        self.assertGreater(res["points"], 0)
        self.assertEqual(res["totals"], d["stats"])
        self.assertEqual(d["ach"][-1]["type"], "fare"); self.assertEqual(d["ach"][-1]["stars"], 4)
        self.assertEqual(d["offPhase"], "off")
        # your passenger's door, in and out: your own car's sound (kind own), where you are
        chimes = [s for s in d["snd"] if s[0] == "door-chime"]
        self.assertEqual(len(chimes), 2)
        for n, o, m in chimes:
            self.assertEqual(o["kind"], "own")
            self.assertLess(((o["pos"]["x"] - m["x"]) ** 2 + (o["pos"]["z"] - m["z"]) ** 2) ** 0.5, 1e-6)

    def test_sounds_are_placed(self):
        # the match chime is the phone's (centred); the indicator as it pulls up and the doors as you get in and out are
        # at the cab (the fake call engine parks it at your kerb, (0, 0), and lets you out at Harbour Street, (3000, 0))
        snd = self.o["ride"]["snd"]
        self.assertEqual([s[0] for s in snd], ["chime", "indicator", "door-chime", "door-chime", "chime"])
        self.assertTrue(all(s[1] is None or "pos" not in s[1] for s in snd if s[0] == "chime"))
        ind, din, dout = snd[1][1], snd[2][1], snd[3][1]
        self.assertEqual(ind["kind"], "vehicle")
        self.assertEqual((din["kind"], dout["kind"]), ("door", "door"))
        self.assertLess(abs(ind["pos"]["x"]) + abs(ind["pos"]["z"]), 1e-6)
        self.assertLess(abs(din["pos"]["x"]) + abs(din["pos"]["z"]), 1e-6)
        self.assertLess(abs(dout["pos"]["x"] - 3000) + abs(dout["pos"]["z"]), 1e-6)
        self.assertGreater(din["pos"]["y"], ind["pos"]["y"] - 1)

    def test_phone_apps(self):
        apps = {a["id"]: a for a in self.o["apps"]}
        self.assertEqual(set(apps), {"claude-cabs", "vehicles", "dealership"})
        self.assertTrue(apps["claude-cabs"]["dock"])
        self.assertTrue(apps["claude-cabs"]["needsCity"]); self.assertTrue(apps["vehicles"]["needsCity"])
        for a in apps.values():
            self.assertEqual(a["glyph"], "string"); self.assertEqual(a["render"], "function")
        p = self.o["phone"]
        self.assertEqual([t[1] for t in p["tabs"]], ["tab", "tab"])
        self.assertEqual(p["tabs"][0][2], "true")
        self.assertEqual(p["radiogroup"], "radiogroup")
        self.assertEqual(p["chipNames"], ["Bike", "Go", "Cab", "XL", "Lux", "Heli", "Water taxi"])
        self.assertEqual(sum(1 for c in p["chips"] if c[1] == "true"), 1)
        self.assertEqual([c[2] for c in p["chips"]].count(0), 1, "roving tabindex")
        self.assertFalse(p["price"], "no prices anywhere: free")
        self.assertEqual(p["afterArrow"].index("true"), 3, "ArrowRight from Cab picks XL")
        self.assertEqual(p["remembered"], "xl")
        self.assertIsNotNone(p["opt"])
        self.assertEqual(p["state"], "matching")
        self.assertTrue(p["live"]); self.assertTrue(p["cancelBtn"])
        self.assertEqual(p["badge"], 0, "matching is not yet an active ride badge")
        self.assertEqual(p["drive"], "false")
        self.assertEqual(p["statsShown"], ["Driver score", "Rating", "Fares"])
        self.assertEqual(p["vehChips"][:4], ["All 2", "Cars 1", "Bikes 1", "Helicopters 0"])
        self.assertIn("No helicopters yet: the dealership has them", p["vehHeliEmpty"])
        self.assertIn("heli:open:1:2:null", p["said"])
        self.assertEqual(p["ringText"], "Calling Claude Motors…"); self.assertTrue(p["ringing"])
        self.assertEqual(p["answered"], "Claude Motors, how can we help?")
        self.assertIn("dealer-mounted", p["said"])
        self.assertEqual(p["delivered"], "Your new BMW M2 is parked at level 2, bay 14. Call it?")
        self.assertIn("call:own:abc", p["said"])
        self.assertIn("sfx:dial", p["said"])
        self.assertFalse(any(s.startswith("phone:Matched") for s in p["said"]), "the controller announces, the phone does not repeat it")


    def test_drawing(self):
        d = self.o["draw"]
        self.assertLessEqual(d["coming"], 6, "cabs: paint, livery, sign, figures (and the beacon) within the budget")
        self.assertEqual(d["inst"], [1, 1, 1, 1], "one cab: body, livery, roof sign, its driver")
        self.assertEqual(d["rig"], {"seat": True, "grips": 2, "feet": 2})
        self.assertEqual(d["cancelled"], 0)
        self.assertIn("CylinderGeometry", d["beacon"]); self.assertNotIn("RingGeometry", d["beacon"])
        self.assertIn("RingGeometry", d["beaconCalm"]); self.assertNotIn("CylinderGeometry", d["beaconCalm"])
        self.assertLessEqual(d["beaconCalls"], 6)
        self.assertEqual(d["shot"], 1)
        self.assertEqual(d["left"], 0, "dispose takes it all away")


class CabsSource(unittest.TestCase):
    def test_house_rules(self):
        for f in ("hqcabs.js", "hqhelicall.js", "hqphonecabs.js"):
            src = read("games", f)
            self.assertFalse("Math.random" in src, f + ": " + "Math.random")
            self.assertFalse("innerHTML" in src, f + ": " + "innerHTML")
            self.assertFalse("fetch(" in src, f + ": " + "fetch(")
            self.assertFalse("XMLHttpRequest" in src, f + ": " + "XMLHttpRequest")
        src = read("games", "hqcabs.js")
        self.assertFalse("/v1/" in src, "driver mode has no server route (D5)")


if __name__ == "__main__":
    unittest.main()
