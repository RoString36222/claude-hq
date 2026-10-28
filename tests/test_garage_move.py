"""City Gen v4 phase 10 (HQ 3.33): movable HQ garages, the client.

You can move your HQ's car-lift bay anywhere inside your own lot and turn it in quarter turns (r 0..3). This checks, under
node with the real modules and the generator's @3 Commons (tests/fixtures/claude-hq@3.json.gz):
  - garageFits (games/hqcity3d.js): the default bay (garagePlace, with both wings) fits on the Commons' HQ lots, and a spot
    outside the lot, on the building, with its apron blocked or with no way to the street is turned down;
  - garageOf: a stored spot (the Arena's h.garage, decimetres) for another lot's rank, or one that no longer fits, falls back
    to garagePlace; one that fits is drawn there, its r kept;
  - r 1 and 3: the bay's walls (garageLocal, what blocked() reads) turn with it, and games/hqcarlift.js's door, apron, heading
    and exit path turn too, the exit path running along the driveway out to the street, never through the HQ;
  - the defaults are unchanged: r 0 / 2 from garagePlace and the car lift's points for them as before 3.33;
  - the Move garage panel's pure parts (ui/app/40-studio.js): the 0.5 m grid, quarter turns, keys, decimetres, the stored
    spot's check and your own City entry (the draft, else what you saved, else this machine's copy without an Arena).
Stdlib only; skipped without node."""
import json
import os
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
import zlib from "zlib";
const root = %(root)s;
globalThis.window = {HQV: {}};
const HQV = window.HQV;
for (const f of ["hqstyle", "hqtower", "hqbase", "world", "hqcityparts", "hqcity", "hqmerge", "hqnav", "hqcarpark", "hqcall", "hqcarlift", "hqcity3d"])
  new Function(fs.readFileSync(root + "/games/" + f + ".js", "utf8"))();
const gz = p => JSON.parse(zlib.gunzipSync(fs.readFileSync(p)).toString("utf8"));
const C3 = HQV.hqCity3d, CL = HQV.hqCarLift, G = HQV.hqLotExtras.garage;
const W = HQV.world.pack(gz(root + "/tests/fixtures/claude-hq@3.json.gz"));
const lots = W.lots.filter(l => l.kind === "hq");
const out = {};
function inBox(K, x, z, m){ return Math.abs(x - K[0]) < K[2] + (m || 0) && Math.abs(z - K[1]) < K[3] + (m || 0); }
function local(p, x, z){ var dx = x - p.x, dz = z - p.z, c = Math.cos(p.rot), s = Math.sin(p.rot); return {x: dx*c - dz*s, z: dx*s + dz*c}; }
function inRing(P, x, z){ var inside = false; for(var i = 0, j = P.length - 1; i < P.length; j = i++){ var xi = P[i][0], zi = P[i][1], xj = P[j][0], zj = P[j][1]; if((zi > z) !== (zj > z) && x < (xj - xi)*(z - zi)/(zj - zi) + xi) inside = !inside; } return inside; }

/* 1. the defaults on the @3 Commons: garageFits with both wings */
out.defaults = {n: 0, ok: 0, byR: {}, fails: []};
out.room = [];
var sideLot = null;
lots.forEach(function(l){
  var p = C3.placeLot(l), g = C3.grandOf(l, p), d = C3.garagePlace(l, p, 2, g);
  out.defaults.n++;
  var k = String(d ? d.r : "none"), B = out.defaults.byR[k] = out.defaults.byR[k] || {n: 0, ok: 0};
  B.n++;
  var F = d ? C3.garageFits(l, p, d, g) : {ok: false, why: "none"};
  if(F.ok){ out.defaults.ok++; B.ok++; } else out.defaults.fails.push({lot: l.id, rank: l.rank, r: d && d.r, why: F.why});
  // the room to move it: spots (0.5 m grid, 4 turns) that fit, per lot
  var n = 0;
  for(var x = -30; x <= 30; x += 0.5) for(var z = -22; z <= 22; z += 0.5) for(var r = 0; r < 4; r++){
    var Q = C3.garageFits(l, p, {x: x, z: z, r: r}, g);
    if(!Q.ok) continue; n++;
    if(r === 1 && !sideLot) sideLot = {l: l, p: p, g: g, sp: {x: x, z: z, r: 1}, way: Q.way};
  }
  out.room.push(n);
});

/* 2. the rules on a plain rectangular lot (no polygon: @1's shape), 80 x 60 m, facing north */
var R = {id: 1, rank: 0, x: 0, z: 0, w: 8000, d: 6000, kind: "hq", facing: "north", door: [0, 0]};
var Rp = C3.placeLot(R), Rg = C3.grandOf(R, Rp);
function why(sp){ var F = C3.garageFits(R, Rp, sp, Rg); return F.ok ? "ok" : F.why; }
out.rect = {
  front: why({x: 16, z: 6, r: 0}),             // beside the tower, facing the street
  outside: why({x: 45, z: 0, r: 0}),
  half: why({x: 37, z: 0, r: 0}),              // half off the lot's side
  onHq: why({x: 0, z: 0, r: 0}),
  onWalk: why({x: 0, z: 12, r: 0}),
  facingHq: why({x: 0, z: -14, r: 0}),         // behind the tower, its door to the tower's back wall
  sideIntoHq: why({x: 16, z: -1, r: 3}),       // beside it, its side door to the tower
  apronOffBack: why({x: 20, z: -24, r: 2}),     // facing away, its apron off the lot's back
  side: why({x: 22, z: -14, r: 1}),            // a side door, its driveway up the lot's side
  awayNoWay: why({x: 0, z: -15, r: 2}),        // behind the tower facing away: both ways round it blocked
  snapped: C3.garageFits(R, Rp, {x: 16.2, z: 6.1, r: 0}, Rg).ok === C3.garageFits(R, Rp, {x: 16, z: 6, r: 0}, Rg).ok
};
out.rectWay = C3.garageFits(R, Rp, {x: 22, z: -14, r: 1}, Rg).way;
out.rectFront = C3.lotRing(R, Rp).reduce(function(m, q){ return Math.max(m, q[1]); }, -1e9);

/* 3. stored spots: another lot's rank, one that doesn't fit, one that does */
var L0 = sideLot.l, P0 = sideLot.p, wings = 2, def = C3.garagePlace(L0, P0, wings, sideLot.g);
function dm(sp, rank){ return {lot: rank, x: Math.round(sp.x*10), z: Math.round(sp.z*10), r: sp.r}; }
out.stored = {
  def: def,
  otherRank: C3.garageOf(L0, P0, {garage: dm(sideLot.sp, (L0.rank | 0) + 1)}, wings, sideLot.g),
  noFit: C3.garageOf(L0, P0, {garage: dm({x: 0, z: 0, r: 0}, L0.rank | 0)}, wings, sideLot.g),
  badR: C3.garageOf(L0, P0, {garage: {lot: L0.rank | 0, x: Math.round(sideLot.sp.x*10), z: Math.round(sideLot.sp.z*10), r: 5}}, wings, sideLot.g),
  fits: C3.garageOf(L0, P0, {garage: dm(sideLot.sp, L0.rank | 0)}, wings, sideLot.g),
  none: C3.garageOf(L0, P0, {}, wings, sideLot.g),
  key: C3.hqKey({h: {userId: "u", garage: dm(sideLot.sp, 0)}, lot: L0}) !== C3.hqKey({h: {userId: "u"}, lot: L0})
};

/* 4. the bay's walls turn with it (garageLocal -> hqLotExtraBlocked, as blocked() asks) */
var B = HQV.hqLotExtraBlocked;
function walls(r){
  var GP = C3.toGarage({x: 5, z: -3, r: r}), u = [[0, 1], [1, 0], [0, -1], [-1, 0]][r], v = [u[1], -u[0]];   // v: across the bay
  function at(a, b){ var q = C3.garageLocal(GP, 5 + u[0]*a + v[0]*b, -3 + u[1]*a + v[1]*b); return B(q.x, q.z, true); }
  return {back: at(-G.d/2, 0), side: at(0, G.w/2), side2: at(0, -G.w/2), front: at(G.d/2 + 0.6, 0), middle: at(0, 0),
          // the lot's own axes: a wall where the turned bay has one, open where it is open
          lotBack: (function(){ var q = C3.garageLocal(GP, 5 - u[0]*G.d/2, -3 - u[1]*G.d/2); return B(q.x, q.z, true); })()};
}
out.walls = [0, 1, 2, 3].map(walls);
// before 3.33 r 0 / 2: the mapping blocked() used (s mirrors, f flips z)
out.legacyMap = [{x: -13, z: 6.7, s: -1, f: 1}, {x: 11, z: -14, s: 1, f: -1}].map(function(GP){
  var pts = [[-14, 5], [-12, 9.9], [12, -11], [9, -17.2]], same = true;
  pts.forEach(function(q){ var a = C3.garageLocal(GP, q[0], q[1]), b = {x: G.x + GP.s*(q[0] - GP.x), z: G.z + (GP.f === -1 ? -1 : 1)*(q[1] - GP.z)}; if(a.x !== b.x || a.z !== b.z) same = false; });
  return same;
});

/* 5. the car lift for a turned bay: door, apron, heading, the exit path along the driveway to the street */
function lift(l, p, g, sp, way){
  var gar = C3.toGarage(sp, way), E = {x: p.x, z: p.z, rot: p.rot, garage: gar};
  var s = CL.streetSpot({}, E), K = CL.liftSite({}, "me", E), path = K.cp.exitPath(null, K.site), ent = K.cp.entrance(K.site);
  var foot = C3.hqFoot(g, 2), dl = local(p, K.site.door.x, K.site.door.z), al = local(p, K.site.apron.x, K.site.apron.z), sl = local(p, s.x, s.z);
  var ring = C3.lotRing(l, p), last = local(p, path[path.length - 1].x, path[path.length - 1].z);
  return {r: gar.r, door: [+dl.x.toFixed(3), +dl.z.toFixed(3)], apron: [+al.x.toFixed(3), +al.z.toFixed(3)], spot: [+sl.x.toFixed(3), +sl.z.toFixed(3)],
    yaw: +(((s.yaw - p.rot + 3*Math.PI) %% (2*Math.PI)) - Math.PI).toFixed(4), into: path.some(function(q){ var lq = local(p, q.x, q.z); return foot.some(function(K){ return inBox(K, lq.x, lq.z); }); }),
    lastOut: !inRing(ring, last.x, last.z), lastZ: +last.z.toFixed(2), entEnd: Math.hypot(ent.x - path[path.length - 1].x, ent.z - path[path.length - 1].z),
    n: path.length, way: (K.site.way || []).length, bay: [gar.x, gar.z]};
}
out.liftSide = lift(sideLot.l, sideLot.p, sideLot.g, sideLot.sp, sideLot.way);
var rectSide = C3.garageFits(R, Rp, {x: 22, z: -14, r: 1}, Rg), rectSide3 = C3.garageFits(R, Rp, {x: -22, z: -14, r: 3}, Rg);
out.liftRect = [lift(R, Rp, Rg, {x: 22, z: -14, r: 1}, rectSide.way), lift(R, Rp, Rg, {x: -22, z: -14, r: 3}, rectSide3.way)];
out.rect3 = rectSide3.ok;
// a default bay's lift: exactly as before 3.33 (no driveway, its points from f)
var E0 = {x: 0, z: 0, rot: 0, garage: {x: 4.5, z: -9.5, s: 1, f: -1}}, E2 = {x: 0, z: 0, rot: 0, garage: {x: 4.5, z: -9.5, s: 1, f: -1, r: 2}};
var p0 = CL.liftSite({}, "me", E0).cp.exitPath(null, CL.liftSite({}, "me", E0).site), p2 = CL.liftSite({}, "me", E2).cp.exitPath(null, CL.liftSite({}, "me", E2).site);
out.defaultLift = {same: JSON.stringify(p0) === JSON.stringify(p2), n: p0.length, spot: CL.streetSpot({}, E0)};

/* 6. lotExtras: a turned bay's group turns; the plate is yours only and not a door */
const THREE = await import(root + "/games/vendor/three-module.js");
var noop2d = new Proxy({}, {get(t, k){ return k === "measureText" ? function(){ return {width: 10}; } : function(){ return {addColorStop(){}}; }; }, set(){ return true; }});
function mat(c, o){ return new THREE.MeshStandardMaterial(Object.assign({color: c}, o || {})); }
function add(o, x, y, z, p){ o.position.set(x, y, z); p.add(o); return o; }
var c = {THREE: THREE, PI: Math.PI, mat: mat, emis: function(c0, e, ei){ var m = mat(c0); m.emissive = new THREE.Color(e); m.emissiveIntensity = ei; return m; },
  box(w, h, d, m, x, y, z, p){ return add(new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m), x, y, z, p); },
  canvasTex(w, h, draw){ if(draw) draw(noop2d, w, h); return {c: null, g: noop2d, t: new THREE.Texture()}; },
  screen(w, h, t){ return new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({map: t})); },
  glow(col){ return new THREE.Sprite(new THREE.SpriteMaterial({color: col})); }};
function extras(at, mine){
  delete HQV.hqCarLift;
  var g = new THREE.Group(), X = HQV.hqCityParts.lotExtras(c, g, {paint: 0x2a3c50, accent: 0xffb347}, 0, function(x, z){ return {x: x, z: z}; }, 11, "u", at, mine);
  HQV.hqCarLift = CL;
  var gg = g.children[0];
  return {rotY: +gg.rotation.y.toFixed(4), pos: [gg.position.x, gg.position.z], door: [+X.door.front.x.toFixed(3), +X.door.front.z.toFixed(3)], doors: X.doors.length,
          move: !!X.move, moveFlag: !!(X.move && X.move.userData.garageMove), moveNotDoor: !(X.move && X.move.userData.door), meshes: g.children.length};
}
out.extras = {r0: extras({x: 13, z: 6.5, s: 1, f: 1}, true), r0old: extras({x: 13, z: 6.5, s: 1, f: 1, r: 0}, true), r2: extras({x: 11, z: -14, s: 1, f: -1}, false),
  r1: extras(C3.toGarage({x: 22, z: -14, r: 1}, rectSide.way), true), r3: extras(C3.toGarage({x: -22, z: -14, r: 3}), false)};
console.log(JSON.stringify(out));
"""

UI_HARNESS = r"""
import fs from "fs";
const root = %(root)s;
const reg = {};
class El {
  constructor(tag){ this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null; this.attrs = {}; this.ls = {}; this._t = ""; this.dataset = {}; this.style = {}; this.tabIndex = -1;
    this.classList = {s: new Set(), add(...c){ c.forEach(x => this.s.add(x)); }, remove(...c){ c.forEach(x => this.s.delete(x)); }, contains(c){ return this.s.has(c); }, toggle(c, on){ if(on === undefined) on = !this.s.has(c); on ? this.s.add(c) : this.s.delete(c); return on; }}; }
  set id(v){ this._id = v; reg[v] = this; } get id(){ return this._id; }
  set className(v){ this.classList.s = new Set(String(v).split(/\s+/).filter(Boolean)); } get className(){ return [...this.classList.s].join(" "); }
  set textContent(v){ this.children = []; this._t = String(v); } get textContent(){ return this._t + this.children.map(c => c.textContent).join(""); }
  appendChild(c){ c.parentNode = this; this.children.push(c); return c; }
  setAttribute(k, v){ this.attrs[k] = String(v); } getAttribute(k){ return this.attrs[k] == null ? null : this.attrs[k]; }
  addEventListener(t, f){ (this.ls[t] = this.ls[t] || []).push(f); }
  fire(t, e){ var ev = Object.assign({prevented: false, preventDefault(){ this.prevented = true; }, stopPropagation(){}, target: this}, e || {}); (this.ls[t] || []).forEach(f => f(ev)); return ev; }
  click(){ this.fire("click"); } focus(){ document.activeElement = this; }
  querySelector(){ return null; } getBoundingClientRect(){ return {left: 0, top: 0, right: 0, width: 0, height: 0}; }
  all(){ return [this].concat(...this.children.map(c => c.all())); }
}
globalThis.window = globalThis; window.HQV = {};
globalThis.document = {createElement: t => new El(t), body: new El("body"), activeElement: null, documentElement: new El("html"), hidden: false, querySelector(){ return null; }};
globalThis.$ = id => reg[id] || null;
globalThis.getComputedStyle = () => ({getPropertyValue(){ return ""; }});
globalThis.location = {search: ""};
const LS = {}; globalThis.localStorage = {getItem: k => LS[k] == null ? null : LS[k], setItem(k, v){ LS[k] = String(v); }, removeItem(k){ delete LS[k]; }};
const said = []; globalThis.toast = () => {}; globalThis.announce = t => said.push(t);
const posts = []; let arenaCode = 200;
globalThis.ARENA = {paired: false}; globalThis.hqNetCan = cap => cap === "garage" && globalThis.CAN === true;
globalThis.hqArena = (m, path, body) => { posts.push([m, path, body]); return Promise.resolve({ok: arenaCode < 300, code: arenaCode, j: {garage: null}}); };
const ghosts = [], views = []; let changed = 0;
// a lot where x > 0 fits and x <= 0 is "on the building"
const LOT = {x: 0, y: 0, z: 0, rot: 0, rank: 7, garage: {x: 13, z: 6.7, s: 1, f: 1, r: 0}, def: {x: 13, z: 6.7, s: 1, f: 1, r: 0},
  fits(sp){ return sp.x > 0 ? {ok: true, why: "", way: []} : {ok: false, why: "on the building", way: null}; }};
globalThis.HQ3D = {visit: false, inst: {lookChanged(){}, cityChanged(){ changed++; }, garageLot(){ return LOT; }, garageView(o){ views.push(o ? {cb: typeof o.cb.place} : null); return true; },
  garageGhost(g){ ghosts.push(g); return true; }, studioView(){}, studioGrid(){}}};
(0, eval)(fs.readFileSync(root + "/ui/app/40-studio.js", "utf8"));
const out = {};
out.snap = [hqGarageSnap(1.24), hqGarageSnap(1.26), hqGarageSnap(-0.2), hqGarageSnap(99), hqGarageSnap("x")];
out.turn = [hqGarageTurn(0), hqGarageTurn(3), hqGarageTurn(0, -1), hqGarageTurn(2, 0)];
out.step = ["left", "right", "up", "down", "rotate", "nope"].map(k => hqGarageStep({x: 1, z: 2, r: 3}, k));
out.keys = ["ArrowLeft", "ArrowUp", "r", "R", "Enter", " ", "Escape", "a"].map(k => hqGarageKeyOf({key: k}));
out.dm = [hqGarageDm({x: 12.5, z: -3, r: 1}, 7), hqGarageM({lot: 7, x: 125, z: -30, r: 1})];
out.clean = [hqGarageClean({lot: 3, x: 125, z: -30, r: 1}), hqGarageClean({lot: 3, x: 12.5, z: 0, r: 0}), hqGarageClean({lot: 3, x: 0, z: 0, r: 4}), hqGarageClean({lot: -1, x: 0, z: 0, r: 0}), hqGarageClean("x")];
const list = [{userId: "me", isYou: true, garage: {lot: 7, x: 10, z: 10, r: 0}}, {userId: "them", garage: {lot: 2, x: 50, z: 0, r: 1}}];
out.cityNone = hqStudioCity(list).map(h => h.garage || null);                  // no Arena, nothing local: the listing as it came
LS.hq_garage = JSON.stringify({lot: 7, x: 200, z: 30, r: 3});
out.cityLocal = hqStudioCity(list).map(h => h.garage || null);                 // no Arena: this machine's copy, on yours only
// the panel: open, hover red / green, place, rotate, save (no Arena: kept here)
hqGarageOpen();
out.open = {view: views[views.length - 1], panel: reg.hqGarage && reg.hqGarage.classList.contains("open"), role: reg.hqGarage.children[0].attrs.role,
  pad: reg.hqgPad.attrs.role, facing: reg.hqgFacing.attrs.role, focus: document.activeElement === reg.hqgPad, cur: Object.assign({}, HQ_GARAGE.cur)};
const cb = HQG_PLACE;
cb.hover(-4, 2); out.red = ghosts[ghosts.length - 1]; out.redSaid = said[said.length - 1]; out.padBad = reg.hqgPad.classList.contains("bad");
cb.place(-4, 2); out.redPlace = HQ_GARAGE.draft;
cb.hover(9.3, 2.1); out.green = ghosts[ghosts.length - 1];
const c0 = changed; cb.place(9.3, 2.1); out.draft = HQ_GARAGE.draft; out.applied = changed > c0;
out.cityDraft = hqStudioCity(list)[0].garage;
cb.key("rotate"); out.rot = HQ_GARAGE.cur.r;
reg.hqgPad.fire("keydown", {key: "ArrowRight"}); out.arrow = Object.assign({}, HQ_GARAGE.cur);
reg.hqgPad.fire("keydown", {key: "Enter"});
out.saved = {saved: HQ_GARAGE.saved, local: JSON.parse(LS.hq_garage), closed: !reg.hqGarage.classList.contains("open"), view: views[views.length - 1], said: said[said.length - 1]};
out.citySaved = hqStudioCity(list).map(h => h.garage || null);
// with an Arena that keeps it: Save posts {lot, x, z, r}; Reset posts .../reset and clears it (your HQ: the default)
globalThis.ARENA.paired = true; globalThis.CAN = true;
hqGarageOpen(); cb.place(5, 5); reg.hqgPad.fire("keydown", {key: "Enter"});
await new Promise(r => setTimeout(r, 0));
out.post = posts.filter(p => p[0] === "POST").map(p => [p[1], p[2]]);
out.postSaid = said[said.length - 1];
hqGarageOpen(); hqGarageReset(); await new Promise(r => setTimeout(r, 0));
out.reset = {post: posts[posts.length - 1][1], saved: HQ_GARAGE.saved, local: LS.hq_garage || null, mine: hqStudioCity(list)[0].garage};
// Esc on the pad: put back (the draft dropped)
cb.place(6, 6); reg.hqgPad.fire("keydown", {key: "Escape"}); out.esc = {draft: HQ_GARAGE.draft, closed: !reg.hqGarage.classList.contains("open")};
// an older Arena (404): kept here and said so
arenaCode = 404; hqGarageOpen(); cb.place(7, 7); reg.hqgPad.fire("keydown", {key: "Enter"}); await new Promise(r => setTimeout(r, 0));
out.old = {said: said[said.length - 1], remote: HQ_GARAGE.remote, local: JSON.parse(LS.hq_garage)};
// no 3D City: nothing opens, it says where to go
globalThis.HQ3D.inst.garageLot = () => null; const nv = views.length; hqGarageOpen(); out.noCity = {said: said[said.length - 1], views: views.length - nv};
console.log(JSON.stringify(out));
"""


def node(src):
    r = subprocess.run([NODE, "--input-type=module", "-e", src], capture_output=True, text=True, timeout=300)
    if r.returncode != 0:
        raise AssertionError("node failed:\n" + r.stderr[-4000:])
    return json.loads(r.stdout.strip().splitlines()[-1])


@unittest.skipUnless(NODE, "node is not installed")
class GarageModel(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.o = node(HARNESS % {"root": json.dumps(ROOT)})

    def test_defaults_fit_on_the_commons(self):
        d = self.o["defaults"]
        self.assertGreater(d["n"], 50)
        # the default facing the street fits everywhere but one lot whose outline folds back on itself (lot 67)
        r0 = d["byR"]["0"]
        self.assertGreaterEqual(r0["ok"], r0["n"] - 1, d["fails"])
        # a default facing away (r 2): its 8 m apron runs off the lot's back, not out over its street side, so garageFits turns
        # it down (garageOf never asks: a default is drawn where garagePlace puts it); reported, not hidden
        self.assertEqual({f["why"] for f in d["fails"]}, {"apron blocked"})
        self.assertGreater(d["ok"] / d["n"], 0.7)

    def test_room_to_move(self):
        room = self.o["room"]
        self.assertGreater(sum(room) / len(room), 50, "on average a lot has room for its bay in more than one place")
        self.assertGreater(sum(1 for n in room if n > 0), len(room) * 0.75)

    def test_rules(self):
        r = self.o["rect"]
        self.assertEqual(r["front"], "ok")
        self.assertEqual(r["outside"], "outside the lot")
        self.assertEqual(r["half"], "outside the lot")
        self.assertEqual(r["onHq"], "on the building")
        self.assertEqual(r["onWalk"], "on the building")
        self.assertEqual(r["facingHq"], "apron blocked")
        self.assertEqual(r["sideIntoHq"], "apron blocked")
        self.assertEqual(r["apronOffBack"], "apron blocked")
        self.assertEqual(r["side"], "ok")
        self.assertEqual(r["awayNoWay"], "no way to the street")
        self.assertTrue(r["snapped"])
        # a side door's driveway: from the apron's end straight up the lot to its street-side edge, and a metre past it
        way = self.o["rectWay"]
        self.assertEqual(len(way), 2)
        self.assertAlmostEqual(way[0]["x"], 22 + 3.1 + 8 - 1.75)
        self.assertEqual(way[0]["x"], way[1]["x"])
        self.assertGreater(way[1]["z"], self.o["rectFront"])

    def test_stored_spot_or_the_default(self):
        s = self.o["stored"]
        d = s["def"]
        for k in ("otherRank", "noFit", "badR", "none"):
            self.assertEqual(s[k], d, k)
        f = s["fits"]
        self.assertEqual(f["r"], 1)
        self.assertNotEqual([f["x"], f["z"]], [d["x"], d["z"]])
        self.assertTrue(f["way"])
        self.assertTrue(s["key"], "a moved garage rebuilds the HQ (hqKey)")

    def test_walls_turn_with_the_bay(self):
        for r, w in enumerate(self.o["walls"]):
            with self.subTest(r=r):
                self.assertTrue(w["back"]); self.assertTrue(w["side"]); self.assertTrue(w["side2"]); self.assertTrue(w["lotBack"])
                self.assertFalse(w["front"], "the open door"); self.assertFalse(w["middle"], "the platform")
        self.assertEqual(self.o["legacyMap"], [True, True], "r 0 / 2 map exactly as before 3.33")

    def test_side_bay_car_lift(self):
        for o, r in ((self.o["liftRect"][0], 1), (self.o["liftRect"][1], 3)):
            with self.subTest(r=r):
                sx = 1 if r == 1 else -1
                self.assertEqual(o["r"], r)
                self.assertAlmostEqual(o["door"][0], o["bay"][0] + sx * 3.1, places=3)
                self.assertAlmostEqual(o["door"][1], o["bay"][1], places=3)
                self.assertAlmostEqual(o["apron"][0], o["bay"][0] + sx * (3.1 + 3.2), places=3)
                self.assertEqual(o["spot"], o["apron"])
                self.assertAlmostEqual(o["yaw"], sx * 1.5708, places=3)
                self.assertFalse(o["into"], "never through the HQ")
                self.assertTrue(o["lastOut"], "the exit path ends out on the street")
                self.assertEqual(o["way"], 2)
                self.assertLess(o["entEnd"], 1e-6)
        self.assertTrue(self.o["rect3"])
        o = self.o["liftSide"]
        self.assertFalse(o["into"]); self.assertTrue(o["lastOut"])

    def test_default_lift_unchanged(self):
        d = self.o["defaultLift"]
        self.assertTrue(d["same"], "f -1 and r 2: the same path")
        self.assertEqual(d["n"], 7, "pad -> door -> apron, no driveway")

    def test_lot_extras_turn(self):
        e = self.o["extras"]
        self.assertEqual(e["r0"]["rotY"], 0); self.assertEqual(e["r0"], e["r0old"])
        self.assertAlmostEqual(e["r2"]["rotY"], 3.1416, places=3)
        self.assertAlmostEqual(e["r1"]["rotY"], 1.5708, places=3)
        self.assertAlmostEqual(e["r3"]["rotY"], 4.7124, places=3)
        self.assertEqual(e["r1"]["pos"], [22, -14]); self.assertEqual(e["r1"]["door"], [22.4, -14])
        self.assertEqual(e["r3"]["door"], [-22.4, -14])
        self.assertEqual(e["r0"]["door"], [13, 6.9])
        self.assertGreater(e["r1"]["meshes"], e["r3"]["meshes"], "the driveway's strip")
        for k in ("r0", "r1"):
            self.assertTrue(e[k]["move"] and e[k]["moveFlag"] and e[k]["moveNotDoor"]); self.assertEqual(e[k]["doors"], 1)
        self.assertFalse(e["r2"]["move"]); self.assertFalse(e["r3"]["move"])

    def test_wiring(self):
        c3 = read("games", "hqcity3d.js")
        self.assertIn("E.garage = garageOf(E.lot, p, h, B.wings, B.grand);", c3)
        self.assertIn("garageLocal(GP, lx, lz)", c3)
        self.assertIn("h.garage || null]", c3)                                   # hqKey and build()'s signature
        hq = read("games", "hq3d.js")
        for want in ("inst.garageView = function", "garageCam();", "if(d.garage)", "o.garageMove", 'KeyR: "rotate"', "hqs-placing"):
            self.assertIn(want, hq)
        self.assertIn("garageMove: function(){ if(typeof hqGarageOpen===\"function\") hqGarageOpen(); }", read("ui", "app", "22-hq.js"))
        css = read("ui", "hq.css")
        g = css[css.index("/* [3.33] Move garage"):]
        g = g[:g.index("\n/*", 5)] if "\n/*" in g[5:] else g
        self.assertNotRegex(g, r"#[0-9a-fA-F]{3,6}\b", "theme tokens only")
        self.assertIn("html.hq-calm .hqg", g); self.assertIn("prefers-reduced-motion", g)


@unittest.skipUnless(NODE, "node is not installed")
class GaragePanel(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.o = node(UI_HARNESS.replace("%(root)s", json.dumps(ROOT)))

    def test_pure_helpers(self):
        o = self.o
        self.assertEqual(o["snap"], [1, 1.5, 0, 40, 0])
        self.assertEqual(o["turn"], [1, 0, 3, 2])
        self.assertEqual(o["step"], [{"x": 0.5, "z": 2, "r": 3}, {"x": 1.5, "z": 2, "r": 3}, {"x": 1, "z": 1.5, "r": 3},
                                     {"x": 1, "z": 2.5, "r": 3}, {"x": 1, "z": 2, "r": 0}, {"x": 1, "z": 2, "r": 3}])
        self.assertEqual(o["keys"], ["left", "up", "rotate", "rotate", "save", "place", "cancel", None])
        self.assertEqual(o["dm"], [{"lot": 7, "x": 125, "z": -30, "r": 1}, {"x": 12.5, "z": -3, "r": 1}])
        self.assertEqual(o["clean"], [{"lot": 3, "x": 125, "z": -30, "r": 1}, None, None, None, None])

    def test_city_entry(self):
        o = self.o
        self.assertEqual(o["cityNone"], [{"lot": 7, "x": 10, "z": 10, "r": 0}, {"lot": 2, "x": 50, "z": 0, "r": 1}])
        self.assertEqual(o["cityLocal"], [{"lot": 7, "x": 200, "z": 30, "r": 3}, {"lot": 2, "x": 50, "z": 0, "r": 1}])
        self.assertEqual(o["cityDraft"], {"lot": 7, "x": 95, "z": 20, "r": 0})
        self.assertEqual(o["citySaved"][1], {"lot": 2, "x": 50, "z": 0, "r": 1}, "someone else's: the Arena's")

    def test_placement(self):
        o = self.o
        self.assertEqual(o["open"]["view"], {"cb": "function"})
        self.assertTrue(o["open"]["panel"]); self.assertEqual(o["open"]["role"], "dialog")
        self.assertEqual(o["open"]["pad"], "application"); self.assertEqual(o["open"]["facing"], "radiogroup")
        self.assertTrue(o["open"]["focus"])
        self.assertEqual(o["open"]["cur"], {"x": 13, "z": 6.5, "r": 0})
        self.assertFalse(o["red"]["ok"]); self.assertEqual([o["red"]["x"], o["red"]["z"]], [-4, 2])
        self.assertIn("building", o["redSaid"]); self.assertTrue(o["padBad"])
        self.assertIsNone(o["redPlace"], "a red spot is not placed")
        self.assertTrue(o["green"]["ok"]); self.assertEqual([o["green"]["x"], o["green"]["z"]], [9.5, 2])
        self.assertEqual(o["draft"], {"lot": 7, "x": 95, "z": 20, "r": 0}); self.assertTrue(o["applied"])
        self.assertEqual(o["rot"], 1)
        self.assertEqual(o["arrow"], {"x": 10, "z": 2, "r": 1})
        s = o["saved"]
        self.assertEqual(s["saved"], {"lot": 7, "x": 95, "z": 20, "r": 0}, "Enter saves the placed draft")
        self.assertEqual(s["local"], s["saved"]); self.assertTrue(s["closed"]); self.assertIsNone(s["view"])
        self.assertIn("this machine", s["said"])
        self.assertEqual(o["citySaved"][0], s["saved"])

    def test_arena_save_and_reset(self):
        o = self.o
        self.assertEqual(o["post"][0], ["/api/arena/hq/garage", {"lot": 7, "x": 50, "z": 50, "r": 0}])
        self.assertIn("Everyone", o["postSaid"])
        r = o["reset"]
        self.assertEqual(r["post"], "/api/arena/hq/garage/reset")
        self.assertIsNone(r["saved"]); self.assertIsNone(r["local"]); self.assertIsNone(r["mine"], "your HQ: the default")
        self.assertEqual(o["esc"], {"draft": None, "closed": True})
        self.assertIn("doesn't keep garage spots yet", o["old"]["said"])
        self.assertFalse(o["old"]["remote"]); self.assertEqual(o["old"]["local"], {"lot": 7, "x": 70, "z": 70, "r": 0})
        self.assertIn("City", o["noCity"]["said"]); self.assertEqual(o["noCity"]["views"], 0)


if __name__ == "__main__":
    unittest.main()
