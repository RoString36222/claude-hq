"""Arena City in 3D (games/hqcity3d.js) and the parts it shares with the legacy City.

games/hqcityparts.js holds the fountain, bike park, skatepark and lot extras moved out of
games/hqcity.js; the legacy City must lay out exactly as before (golden
tests/fixtures/hqcity_legacy_golden.json, captured from the code before the move). The 3D City
places HQs on the generated world's HQ lots (claude-hq@1 fixture) by rank in user-id order.
Runs under node (skipped without it) with the vendored three.js and a stub hq3d ctx; the
world queries are games/world.js on the real fixture, the world's meshes a stub worldbuild.
Stdlib only."""
import json
import os
import re
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GAMES = os.path.join(ROOT, "games")
FIXTURE = os.path.join(ROOT, "tests", "fixtures", "claude-hq@1.json.gz")
GOLDEN = os.path.join(ROOT, "tests", "fixtures", "hqcity_legacy_golden.json")
NODE = shutil.which("node")


def read(p):
    with open(p, encoding="utf-8") as f:
        return f.read()


# The node side. Loads three.js (ES module) and the HQ files in page order, packs the fixture
# with games/world.js, builds both Cities with a stub ctx and prints one JSON report.
HARNESS = r"""
import fs from "fs";
import zlib from "zlib";
const root = %(root)s;
const THREE = await import(root + "/games/vendor/three-module.js");
globalThis.window = {HQV: {}};
const HQV = window.HQV;
for (const f of ["hqbase", "hqskate", "world", "hqcityparts", "hqcity", "hqcity3d"])
  new Function(fs.readFileSync(root + "/games/" + f + ".js", "utf8"))();
const doc = JSON.parse(zlib.gunzipSync(fs.readFileSync(%(fixture)s)).toString("utf8"));
// games/hqmerge.js when it is there, else a stand-in that merges nothing; either way every call
// is recorded with the meshes its keep() let through (what would be merged)
if (fs.existsSync(root + "/games/hqmerge.js")) new Function(fs.readFileSync(root + "/games/hqmerge.js", "utf8"))();
else HQV.hqMerge = {mergeStatic(T, g){ return {group: g, before: 0, after: 0}; }, mat(T, k, make){ return make(); }};
const mergeCalls = [], realMerge = HQV.hqMerge.mergeStatic;
HQV.hqMerge.mergeStatic = function(T, g, opts){
  var merged = []; g.traverse(o => { if(o.isMesh && !(opts && opts.keep && opts.keep(o))){ var m = o.material;   // its material as it is now (fading makes it transparent later)
    merged.push({o: o, live: Array.isArray(m) || m.transparent || !!m.map || !!(m.emissive && m.emissiveIntensity > 0 && m.emissive.getHex())}); } });
  var call = {g: g, merged: merged}; mergeCalls.push(call);
  var res = realMerge.apply(this, arguments); call.res = res; return res;
};
const WD = HQV.world, W = WD.pack(doc), C3 = HQV.hqCity3d, X = HQV.hqLotExtras, SP = HQV.hqSkatePark;
const out = {};

/* ---------- a stub hq3d ctx: real THREE objects, no DOM ---------- */
function hashStr(s){ var h = 2166136261 >>> 0; s = String(s); for(var i = 0; i < s.length; i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h >>> 0; }
function rng(seed){ var a = seed >>> 0 || 1; return function(){ a = (a + 0x6D2B79F5) >>> 0; var t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0)/4294967296; }; }
function mat(c, o){ return new THREE.MeshStandardMaterial(Object.assign({color: c, roughness: 0.7, metalness: 0.08}, o || {})); }
function emis(c, e, ei, o){ var m = mat(c, o); m.emissive = new THREE.Color(e); m.emissiveIntensity = ei; return m; }
function add(o, x, y, z, p, ns){ o.position.set(x, y, z); if(!ns){ o.castShadow = true; o.receiveShadow = true; } p.add(o); return o; }
var noop2d = new Proxy({}, {get(t, k){ return k === "measureText" ? function(){ return {width: 10}; } : (k === "createLinearGradient" || k === "createRadialGradient") ? function(){ return {addColorStop(){}}; } : function(){}; }, set(){ return true; }});
function tagged(name){ var g = new THREE.Group(); g.name = name; return g; }
var calm = false, avatar = {x: 0, z: 0}, view = {yaw: 0.6, pitch: 0.7};
var LIST = [], RET = null;
var c = {THREE: THREE, PI: Math.PI, COL: {amber: 0xffb347, cyan: 0x5fd3e6, green: 0x6fd38a}, HEX: {green: "#6fd38a", amber: "#ffb347", cyan: "#5fd3e6"},
  STATE_HEX: {}, E: {calm(){ return calm; }}, rng: rng, hashStr: hashStr,
  mat: mat, emis: emis, add: add,
  box(w, h, d, m, x, y, z, p, ns){ return add(new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m), x, y, z, p, ns); },
  cyl(rt, rb, h, m, x, y, z, p, seg){ return add(new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg || 20), m), x, y, z, p); },
  sph(r, m, x, y, z, p){ return add(new THREE.Mesh(new THREE.SphereGeometry(r, 14, 10), m), x, y, z, p); },
  canvasTex(w, h, draw){ if(draw) draw(noop2d, w, h); return {c: null, g: noop2d, t: new THREE.Texture()}; },
  screen(w, h, t, tr){ return new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({map: t, transparent: !!tr})); },
  glow(col, s, o){ return new THREE.Sprite(new THREE.SpriteMaterial({color: col, opacity: o, transparent: true})); },
  label(t){ return tagged("label:" + t); }, glyph(ch){ return new THREE.Sprite(new THREE.SpriteMaterial()); },
  short(s, n){ s = String(s || ""); return s.length > n ? s.slice(0, n) : s; }, crewState(){ return "idle"; },
  character(){}, anim(){}, level(){ return 1; }, look(){ return {}; }, sessions(){ return []; }, lights: [], g: null,
  car(a, b){ var g = tagged("car"); g.add(new THREE.Mesh(new THREE.BoxGeometry(1.7, 1, 3.6), mat(a))); return {g: g}; },
  moto(a){ var g = tagged("moto"); g.add(new THREE.Mesh(new THREE.BoxGeometry(0.4, 1, 1.4), mat(a))); return {g: g}; },
  bike(a){ var g = tagged("bike"); g.add(new THREE.Mesh(new THREE.BoxGeometry(0.1, 1, 1), mat(a))); return {g: g}; },
  board(a){ return {g: tagged("board")}; },
  avatar(){ return avatar; }, view(){ return view; },
  api: {city(){ return LIST; }, cityReturn(){ return RET; }, viewTitle(){ return null; }}};

/* ---------- pure: assign, placeLot, placeView ---------- */
function shuffle(a, seed){ var R = rng(seed), b = a.slice(); for(var i = b.length - 1; i > 0; i--){ var j = Math.floor(R()*(i + 1)), t = b[i]; b[i] = b[j]; b[j] = t; } return b; }
function people(n, you){ return Array.from({length: n}, (_, i) => ({userId: "u" + String(1000 + (i*7919) %% 9973).padStart(5, "0"), isYou: i === you})); }
function amap(r){ return r.map(a => a.h.userId + "@" + a.lot.id); }
var p20 = people(20, 7);
out.assignShuffles = [1, 2, 3, 4, 5].map(s => amap(C3.assign(shuffle(p20, s).concat([null, {userId: 7}, {name: "x"}]), W)));
out.assignBase = amap(C3.assign(p20, W));
var hqLots = W.lots.filter(l => l.kind === "hq").sort((a, b) => a.rank - b.rank);
out.lotCount = hqLots.length;
out.rankOrder = C3.assign(p20, W).every((a, i, arr) => a.lot.rank === i && (i === 0 || arr[i - 1].h.userId < a.h.userId));
var many = people(90, -1); many.push({userId: "zzzz-you", isYou: true});
var big = C3.assign(shuffle(many, 9), W);
out.big = {n: big.length, youPlaced: big.some(a => a.h.isYou), youLot: (big.filter(a => a.h.isYou)[0] || {lot: {}}).lot.rank,
  firstKept: big.slice(0, -1).every((a, i) => a.h.userId === many.slice().sort((x, y) => x.userId < y.userId ? -1 : 1)[i].userId)};
var many2 = people(90, 3); out.big2 = C3.assign(shuffle(many2, 4), W).filter(a => a.h.isYou).length;

// LOT_EXTRAS footprint (garage, car, motorbike, bicycle) and the HQ's own pad inside its lot, both facings
function inLot(l, pt){ return Math.abs(pt.x*100 - l.x) <= l.w/2 + 1e-6 && Math.abs(pt.z*100 - l.z) <= l.d/2 + 1e-6; }   // the apron ends on the edge
function footprint(l){
  var G = X.garage, K = X.car, pts = [], ae = Math.min(11, l.d/200 - 2);   // the apron's end, as hqcity3d.js building()
  [[-1, -1], [1, -1], [1, 1], [-1, 1]].forEach(s => { pts.push([G.x + s[0]*G.w/2, G.z + s[1]*G.d/2]); pts.push([K.x + s[0]*K.wid/2, K.z + s[1]*K.len/2]); pts.push([s[0]*15, 1.5 + s[1]*7.5]); });
  pts.push([X.moto.x, X.moto.z], [X.bike.x, X.bike.z], [G.x - (G.w - 0.4)/2, ae], [G.x + (G.w - 0.4)/2, ae]);
  return pts;
}
var lotsBoth = hqLots.concat(hqLots.map(l => Object.assign({}, l, {facing: "south", door: [l.door[0], l.door[1], 2*l.z - l.door[2]]})));
out.footprintOut = [];
lotsBoth.forEach(l => { var p = C3.placeLot(l); footprint(l).forEach(q => { var w = C3.toWorld(p, q[0], q[1]); if(!inLot(l, w)) out.footprintOut.push([l.id, l.facing, q]); }); });
out.placeSouth = C3.placeLot({x: 100, z: 200, facing: "south", door: [0, 37, 0]});
out.placeNorth = C3.placeLot({x: 100, z: 200, facing: "north", door: [0, 37, 0]});
out.viewSouth = C3.placeView({x: 0, y: 12, z: 0, d: 2200, facing: "south"});
// door fronts: the door, and where you arrive (2.6 m out), on ground world.js does not block
out.doorBlocked = [];
hqLots.forEach(l => { var p = C3.placeLot(l); [C3.HQ_DOOR, C3.HQ_DOOR + 2.6].forEach(d => { var q = C3.toWorld(p, 0, d);
  if(WD.blockedAt(W, q.x, q.z) || HQV.hqLotExtraBlocked(0, d, true)) out.doorBlocked.push([l.id, d]); }); });
W.sites.filter(s => s.kind === "view-building").forEach(s => { var p = C3.placeView(s); [C3.VIEW_DOOR, C3.VIEW_DOOR + 2].forEach(d => { var q = C3.toWorld(p, 0, d);
  if(WD.blockedAt(W, q.x, q.z)) out.doorBlocked.push([s.id, d]); }); });
var sk = W.sites.filter(s => s.kind === "skatepark")[0];
out.skate = {w: sk.w, d: sk.d, HW: SP.HW, HD: SP.HD};

/* ---------- the legacy City: layout golden, the plaza trees ---------- */
out.legacy = (function(){
  // the exact case list tests/fixtures/hqcity_legacy_golden.json was captured with
  function list(n, you, extra){
    var o = [];
    for(var i = 0; i < n; i++) o.push({userId: "u" + ((i*7919) %% 97 + 100), level: i %% 5 + 1, isYou: i === you, look: {paint: "#1" + (i %% 10) + "2233"}});
    return o.concat(extra || []);
  }
  var cases = [];
  for(var n = 0; n <= 15; n++) cases.push(list(n, n ? n - 1 : -1));
  cases.push(list(14, 0), list(14, 13), list(13, -1), list(20, 19), list(3, 1, [null, {userId: 5}, {name: "x"}]));
  return {lotExtras: HQV.hqLotExtras, views: (HQV.hqViews || []).length,
    colors: [HQV.hqLotColors(), HQV.hqLotColors({paint: "#abcdef", accent: "bad"})],
    names: [HQV.hqCityName({look: {sign: " Sign "}}), HQV.hqCityName({trainerName: "T"}), HQV.hqCityName({})],
    blocked: [[0, 0, true], [13, 3.6, true], [14.5, 7.9, true], [14.5, 7.9, false], [0, 10, true], [9.6, 6.7, true]].map(a => HQV.hqLotExtraBlocked(a[0], a[1], a[2])),
    layouts: cases.map(l => HQV.hqCityLayout(l))};
})();
function cityOf(n, you){ return Array.from({length: n}, (_, i) => ({userId: "c" + i, level: 3 + i, isYou: i === you, look: {paint: "#224466", accent: "#ff8800"}, crew: {working: 1, needs: i}, cos: {}})); }
(function(){
  LIST = cityOf(3, 1);
  var S = new THREE.Scene(), w = {scene: S, name: "city"};
  HQV.hqWorlds.city(c, w); w.setTime(true);
  for(var i = 0; i < 3; i++) w.update(i*0.2, 0.05, 1);
  var L = HQV.hqCityLayout(LIST), P = L.plaza, trees = [];
  S.traverse(o => { if(o.type === "Group" && o.children.length === 2 && o.children[1].geometry && o.children[1].geometry.type === "SphereGeometry") trees.push([o.position.x, o.position.z]); });
  out.legacyWorld = {trees: trees, want: [[P.x + 15, P.z - 10], [P.x + 15, P.z + 10]], bikes: w.bikes.length, kinds: w.bikes.map(b => b.kind || "bike"),
    skate: w.skatepark && [w.skatepark.cx - P.x, w.skatepark.cz - P.z]};
})();

/* ---------- the parts: bike park turned, boards on the fountain side ---------- */
(function(){
  var g = new THREE.Group(), fx = 0, fz = 0;
  var b0 = HQV.hqCityParts.bikePark(c, g, 8.6, 0, 0), bPI = HQV.hqCityParts.bikePark(c, g, -11, 0.4, 0, Math.PI);
  function faces(b){ var dx = fx - b.x, dz = fz - b.z; return Math.sin(b.yaw)*dx + Math.cos(b.yaw)*dz > 0.9*Math.hypot(dx, dz); }
  // where each bike model really stands, from the scene graph
  g.updateMatrixWorld(true);
  var drift = 0; bPI.forEach(b => { var v = new THREE.Vector3(); b.g.getWorldPosition(v); drift = Math.max(drift, Math.hypot(v.x - b.x, v.z - b.z)); });
  var yawErr = 0; bPI.forEach(b => { var q = new THREE.Quaternion(); b.g.getWorldQuaternion(q); var f = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    yawErr = Math.max(yawErr, Math.abs(Math.atan2(f.x, f.z) - Math.atan2(Math.sin(b.yaw), Math.cos(b.yaw)))); });
  var sk1 = HQV.hqCityParts.skatePark(c, g, 11, 0.4, 0, {boardsSide: -1}), sk0 = HQV.hqCityParts.skatePark(c, g, -11, 0, 0);
  out.parts = {legacyFaces: b0.every(faces), turnedFaces: bPI.every(faces), drift: drift, yawErr: yawErr,
    boards: sk1.boards.map(b => [b.x, b.z, b.yaw, b.kind]), legacyBoards: sk0.boards.map(b => [b.x, b.yaw])};
})();

/* ---------- the 3D City on the fixture, with a stub worldbuild ---------- */
var faded = [], wbNight = null;
var wbMade = 0, wbGone = 0;
HQV.worldbuild = {create(cc, WW, o){ wbMade++; var root = new THREE.Group(), floor = new THREE.Mesh(new THREE.PlaneGeometry(10, 10), new THREE.MeshBasicMaterial());
  return {root: root, ready: Promise.resolve(), update(){}, setNight(n){ wbNight = n; }, setFaded(ids){ faded = ids.slice(); }, terrainMeshes(){ return [floor]; },
    setQuality(q){ wbQ.push(q); }, stats(){ return {tiles: 7, pending: 2, worker: true}; }, destroy(){ wbGone++; }}; }};
var wbQ = [], changeCbs = [];
WD.onChange = function(cb){ changeCbs.push(cb); };
WD.load = function(){ return Promise.resolve(W); };
LIST = cityOf(5, 2); RET = null;
var S3 = new THREE.Scene(), w3 = {scene: S3, name: "city"};
HQV.hqWorlds.city3d(c, w3);
var ready = await w3.whenReady;
w3.setTime(false); w3.setTime(true);
var me = w3.bikes.length;
var you = C3.assign(LIST, W).filter(a => a.h.isYou)[0], yp = C3.placeLot(you.lot), ydoor = C3.toWorld(yp, 0, C3.HQ_DOOR);
var frustum = new THREE.Frustum();
var modes = {};
["classic", "chase", "map", "chase", "classic"].forEach((m, i) => { w3.update(i*0.3, 0.05, 1, {x: 0, y: 50, z: 0, fov: 60, mode: m, frustum: frustum, avatar: {x: ydoor.x, y: 0, z: ydoor.z}});
  modes[m + i] = {fog: !!S3.fog}; });
// a camera ray through one of the world's own buildings
var bl = W.lots.filter(l => l.kind === "building" && l.floors >= 3)[0], R = WD.buildingRect(bl), cy = WD.groundAt(W, bl.x/100, bl.z/100) + 3;
var hitT = w3.camHit({x: R.x0 - 5, y: cy, z: (R.z0 + R.z1)/2}, {x: R.x1 + 5, y: cy, z: (R.z0 + R.z1)/2});
var occ = w3.occluderItems(ydoor.x, 0, ydoor.z), occB = w3.occluderItems(bl.x/100 + 30, cy, bl.z/100);
w3.setFaded([bl.id, "hq:" + you.h.userId]);
var pickYou = w3.mapPick(you.lot.x/100, you.lot.z/100), pickOther = w3.mapPick(C3.assign(LIST, W)[0].lot.x/100, C3.assign(LIST, W)[0].lot.z/100), pickPt = w3.mapPick(500, 500);
var info = w3.mapInfo();
var sp = w3.spawn;
out.city3d = {ready: ready === w3, net: w3.net, bikes: w3.bikes.length, kinds: w3.bikes.map(b => b.kind || "bike"),
  finite: w3.bikes.every(b => isFinite(b.x) && isFinite(b.z) && isFinite(b.yaw)),
  doors: w3.doors.map(d => d.view), hits: w3.hits.length, floor: Array.isArray(w3.floor) && w3.floor.length,
  skateBase: w3.skateBase, skateSiteY: sk.y/100, skatepark: w3.skatepark && [w3.skatepark.cx, w3.skatepark.cz],
  groundPark: w3.groundY(sk.x/100 + 3, sk.z/100), groundDoor: w3.groundY(ydoor.x, ydoor.z), doorY: you.lot.door[1]/100,
  spawn: sp, spawnBlocked: w3.blocked(sp.x, sp.z), youDoor: ydoor, doorBlocked: w3.blocked(ydoor.x, ydoor.z),
  fountainBlocked: w3.blocked(0, 0), edgeBlocked: w3.blocked(1023.5, 0), towerBlocked: w3.blocked(yp.x, yp.z),
  garageBlocked: (function(){ var q = C3.toWorld(yp, X.garage.x, X.garage.z - X.garage.d/2); return w3.blocked(q.x, q.z); })(),
  modes: modes, hitT: hitT, occIds: occ.map(o => o.id), occBIds: occB.map(o => o.id), blId: bl.id, faded: faded, wbNight: wbNight,
  pickYou: pickYou, pickOther: pickOther, pickPt: pickPt, infoRoads: info.roads.length, infoHqs: info.hqs,
  camModes: w3.camModes, startMode: w3.startMode, bounds: w3.bounds};
// the quality governor and the smoke stats reach worldbuild; a re-pinned world doc marks the City stale
w3.setQuality(1);
out.city3d.quality = {q: wbQ, stats: w3.stats()};
var staleBefore = w3.stale; changeCbs.forEach(cb => cb(W)); var staleSame = w3.stale;
changeCbs.forEach(cb => cb(Object.assign({}, W, {hash: W.hash + "x"})));
out.city3d.stale = [staleBefore, staleSame, w3.stale];
// a car at the end of its street U-turns smoothly onto the other lane
(function(){
  var traffic = []; S3.children.forEach(g => g.children.forEach(o => { if(o.name === "car") traffic.push(o); }));
  var prev = traffic.map(o => [o.position.x, o.position.z, o.rotation.y]), maxStep = 0, maxYaw = 0, turned = 0;
  for(var f = 0; f < 3000; f++){
    w3.update(10 + f*0.05, 0.05, 1, {x: 0, y: 50, z: 0, fov: 60, mode: "chase", frustum: frustum, avatar: {x: 0, y: 0, z: 0}});
    traffic.forEach((o, n) => { var p = prev[n], dy = Math.abs(Math.atan2(Math.sin(o.rotation.y - p[2]), Math.cos(o.rotation.y - p[2])));
      maxStep = Math.max(maxStep, Math.hypot(o.position.x - p[0], o.position.z - p[1])); maxYaw = Math.max(maxYaw, dy); if(dy > 1e-3) turned++;
      prev[n] = [o.position.x, o.position.z, o.rotation.y]; });
  }
  out.city3d.traffic = {n: traffic.length, maxStep: maxStep, maxYaw: maxYaw, turned: turned};
})();
// the HQ group (a child of the City's HQ group) of a user's building, from its door
function hqGroup(uid){
  var h = w3.hits.filter(o => o.userData.door && o.userData.door.userId === uid)[0];
  for(var o = h; o; o = o.parent) if(o.parent && o.parent.parent === S3) return o;
  return null;
}
// crew counts change: no building is rebuilt, the line under the name is
(function(){
  var before = {}; LIST.forEach(h => { before[h.userId] = hqGroup(h.userId); });
  var hitsN = w3.hits.length;
  LIST = LIST.map(h => Object.assign({}, h, {crew: {working: 4, needs: 2}})); w3.onCity();
  var same = LIST.every(h => hqGroup(h.userId) === before[h.userId]);
  var sub = before.c0.children.some(o => o.name === "label:4 working · 2 need them");
  var subOld = before.c0.children.some(o => o.name === "label:1 working · 0 need them");
  // c0's look changes: only c0 is rebuilt, and what its old building used is disposed
  var disposed = 0; before.c0.traverse(o => { if(o.geometry && !o.isSprite) o.geometry.addEventListener("dispose", () => { disposed++; }); });
  LIST = LIST.map(h => h.userId === "c0" ? Object.assign({}, h, {look: {paint: "#884422", accent: "#00ff88"}}) : h); w3.onCity();
  out.city3d.selective = {crewSame: same, sub: sub, subOld: subOld, c0New: hqGroup("c0") !== before.c0, c0Gone: before.c0.parent === null,
    othersSame: LIST.filter(h => h.userId !== "c0").every(h => hqGroup(h.userId) === before[h.userId]), disposed: disposed, hits: [hitsN, w3.hits.length]};
})();
// fading eases (no snap), with no shader recompile or shadow toggle; under Calm it is instant
(function(){
  var g = hqGroup(you.h.userId), door = w3.hits.filter(o => o.userData.door && o.userData.door.userId === you.h.userId)[0], bg = door.parent, m = null, mesh = null;
  bg.traverse(o => { if(!m && o.isMesh && !Array.isArray(o.material) && o.material.opacity === 1){ m = o.material; mesh = o; } });
  var ver = m.version, shadow = mesh.castShadow, camAt = {x: you.lot.x/100, y: 20, z: you.lot.z/100 + 20, fov: 60, mode: "chase", frustum: frustum, avatar: {x: ydoor.x, y: 0, z: ydoor.z}};
  var step = (dt, k) => w3.update(100, dt, k === undefined ? 1 : k, camAt);
  w3.setFaded(["hq:" + you.h.userId]); step(1/60);
  var first = m.opacity;
  for(var i = 0; i < 30; i++) step(1/60);
  var half = m.opacity;
  for(var i = 0; i < 60; i++) step(1/60);
  var faded = m.opacity, dwFaded = m.depthWrite;
  w3.setFaded([]); for(var i = 0; i < 90; i++) step(1/60);
  var back = m.opacity;
  w3.setFaded(["hq:" + you.h.userId]); step(1/60, 0.25);
  var calm = m.opacity; w3.setFaded([]); step(1/60, 0.25);
  // another HQ's materials are not touched by your fade
  var other = hqGroup("c0"), otherOp = []; w3.setFaded(["hq:" + you.h.userId]); step(1/60, 0.25);
  other.traverse(o => { if(o.isMesh && !Array.isArray(o.material)) otherOp.push(o.material.opacity); });
  w3.setFaded([]); step(1/60, 0.25);
  out.city3d.fade = {first: first, half: half, faded: faded, back: back, calm: calm, transparent: m.transparent, versionSame: m.version === ver,
    shadowSame: mesh.castShadow === shadow, dwFaded: dwFaded, dwBack: m.depthWrite, otherMin: Math.min.apply(null, otherOp)};
})();
// far HQs are not drawn; the map shows them all; the sun's shadow box sits on its texel grid
(function(){
  var g = hqGroup(you.h.userId), at = {x: you.lot.x/100, y: 30, z: you.lot.z/100 + 30, fov: 60, frustum: frustum, avatar: {x: ydoor.x + 0.37, y: 0.2, z: ydoor.z - 0.71}};
  w3.update(1, 0.016, 1, Object.assign({mode: "chase"}, at)); var near = g.visible;
  var sun = null; S3.traverse(o => { if(o.isDirectionalLight) sun = o; });
  var want = C3.snapShadow({x: at.avatar.x, y: at.avatar.y, z: at.avatar.z}, {x: 0.45, y: 0.79, z: 0.34}, 120/sun.shadow.mapSize.x);
  var tgt = sun.target.position, sunOff = [sun.position.x - tgt.x, sun.position.y - tgt.y, sun.position.z - tgt.z];
  var farAt = Object.assign({}, at, {x: at.x + 600}); w3.update(1, 0.016, 1, Object.assign({mode: "chase"}, farAt)); var far = g.visible;
  w3.update(1, 0.016, 1, Object.assign({mode: "map"}, farAt)); var map = g.visible;
  w3.update(1, 0.016, 1, Object.assign({mode: "chase"}, at));
  out.city3d.cull = {near: near, far: far, map: map, back: g.visible};
  out.city3d.sun = {target: [tgt.x, tgt.y, tgt.z], want: [want.x, want.y, want.z], off: sunOff};
})();
// snapShadow: light-space x, y on the texel grid, depth along the light kept, never further than half a texel diagonal
(function(){
  var dir = {x: 0.45, y: 0.79, z: 0.34}, L = Math.hypot(0.45, 0.79, 0.34), z = [0.45/L, 0.79/L, 0.34/L], xl = Math.hypot(z[2], z[0]), x = [z[2]/xl, 0, -z[0]/xl];
  var y = [z[1]*x[2] - z[2]*x[1], z[2]*x[0] - z[0]*x[2], z[0]*x[1] - z[1]*x[0]], texel = 120/2048, worst = {grid: 0, depth: 0, move: 0};
  for(var i = 0; i < 200; i++){
    var p = {x: Math.sin(i*1.7)*400, y: Math.cos(i*0.3)*20, z: Math.cos(i*2.3)*400}, q = C3.snapShadow(p, dir, texel);
    var dot = (v, a) => v.x*a[0] + v.y*a[1] + v.z*a[2];
    [x, y].forEach(a => { var u = dot(q, a)/texel; worst.grid = Math.max(worst.grid, Math.abs(u - Math.round(u))); });
    worst.depth = Math.max(worst.depth, Math.abs(dot(q, z) - dot(p, z)));
    worst.move = Math.max(worst.move, Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z));
  }
  out.snap = worst; out.snapTexel = texel;
})();
// what mergeStatic was asked to merge: never a door, a rideable, the traffic, or a material that changes later
(function(){
  var ride = w3.bikes.map(b => b.g), bad = [];
  mergeCalls.forEach(c => c.merged.forEach(r => {
    var o = r.o, under = q => { for(var p = o; p; p = p.parent) if(p === q) return true; return false; };
    if(o.userData.door) bad.push("door");
    if(ride.some(under)) bad.push("ride");
    if(r.live) bad.push("material");
  }));
  out.city3d.merge = {calls: mergeCalls.length, merged: mergeCalls.reduce((n, c) => n + c.merged.length, 0), bad: bad.slice(0, 5),
    keepDoor: C3.keepMesh(w3.hits[0]), keepPlain: C3.keepMesh(new THREE.Mesh(new THREE.BoxGeometry(), mat(0x888888)))};
})();
// the list changes: rebuilt without piling up doors or hits
var doorsBefore = w3.doors.length, hitsBefore = w3.hits.length;
w3.onLook(); LIST = cityOf(6, 2); w3.onCity();
out.city3d.rebuilt = {doors: [doorsBefore, w3.doors.length], hits: [hitsBefore, w3.hits.length], bikes: w3.bikes.length};
// each HQ lot's slab: y-3 .. y+0.05, tinted per instance (one draw call)
(function(){
  var slab = null; S3.traverse(o => { if(o.isInstancedMesh && o.count === 64 && o.geometry.type === "BoxGeometry" && o.geometry.parameters.width === 1) slab = o; });
  var l0 = C3.assign(LIST, W)[0].lot, lots = W.lots.filter(l => l.kind === "hq").sort((a, b) => (a.rank - b.rank) || (a.id - b.id)), n = lots.indexOf(l0);
  var m = new THREE.Matrix4(), pos = new THREE.Vector3(), sc = new THREE.Vector3(), q = new THREE.Quaternion();
  slab.getMatrixAt(n, m); m.decompose(pos, q, sc);
  out.city3d.slab = {lo: pos.y - sc.y/2, hi: pos.y + sc.y/2, y: l0.door[1]/100, colors: !!slab.instanceColor};
})();
// a levelled HQ (tower and west wing): the ground beside it is clear for the camera, the tower is not
(function(){
  LIST = cityOf(6, 2); LIST[0].level = 15; w3.onCity();
  var a = C3.assign(LIST, W).filter(a => a.h.userId === "c0")[0], p = C3.placeLot(a.lot);
  function ray(lx, lz, dz){ var f = C3.toWorld(p, lx, lz), t = C3.toWorld(p, lx, lz + dz), y = p.y + 1.5;
    return {blocked: w3.blocked(f.x, f.z), t: w3.camHit({x: f.x, y: y, z: f.z}, {x: t.x, y: y + 4, z: t.z})}; }
  out.city3d.wing = {right: ray(8, 0, 8), between: ray(-6, 0, 8), front: ray(0, 12, -24)};
})();
// a level-25 HQ (helipad, heli): its building merges through its sub-groups, and what animate()
// moves (rotor, heli) is never folded into a merged mesh
(function(){
  var n0 = mergeCalls.length; LIST = cityOf(6, 2); LIST[0].level = 60; LIST[0].look = {paint: "#224466", accent: "#ff8800", decor: "crown"}; w3.onCity();
  var g = hqGroup("c0"), calls = mergeCalls.slice(n0).filter(cl => { for(var p = cl.g; p; p = p.parent) if(p === g) return true; return false; });
  var bld = calls.filter(cl => cl.g !== g)[0], a = C3.assign(LIST, W).filter(a => a.h.userId === "c0")[0];
  var at = {x: a.lot.x/100, y: 30, z: a.lot.z/100 + 30, fov: 60, mode: "chase", frustum: frustum, avatar: {x: a.lot.x/100, y: 0, z: a.lot.z/100 + 12}};
  function poses(){ var m = new Map(); g.updateMatrixWorld(true); g.traverse(o => { if(o.isMesh) m.set(o, o.matrixWorld.toArray().map(v => v.toFixed(4)).join()); }); return m; }
  w3.update(3, 0.016, 1, at); var p0 = poses(); w3.update(9.5, 0.016, 1, at); var p1 = poses(), movedMerged = 0, moved = 0;
  p0.forEach((v, o) => { if(p1.get(o) !== v){ moved++; if(/^hqmerge:/.test(o.name)) movedMerged++; } });
  var ba = cl => cl && cl.res ? [cl.res.before, cl.res.after] : [0, 0];
  var plaza = mergeCalls.slice(0, n0).reduce((a, cl) => !a || ba(cl)[0] > ba(a)[0] ? cl : a, null);   // the biggest: the plaza, civic plazas
  out.city3d.hqMerge = {visible: g.visible, building: ba(bld), lot: ba(calls.filter(cl => cl.g === g)[0]), plaza: ba(plaza), moved: moved, movedMerged: movedMerged};
})();
// hq3d gives up before the world loads: nothing gets built; after it loads: the tiles go
var made = wbMade, release;
WD.load = function(){ return new Promise(r => { release = () => r(W); }); };
var w4 = {scene: new THREE.Scene(), name: "city"}; HQV.hqWorlds.city3d(c, w4);
w4.destroy(); release();
var late = await w4.whenReady.then(() => "resolved", e => "rejected");
out.city3d.destroy = {late: late, madeLate: wbMade - made, gone: wbGone};
w3.destroy();
out.city3d.destroy.goneAfter = wbGone; out.city3d.destroy.left = S3.children.filter(o => o.type === "Group").length;
process.stdout.write(JSON.stringify(out));
"""


@unittest.skipUnless(NODE, "node is not installed")
@unittest.skipUnless(os.path.exists(FIXTURE), "the world fixture is missing")
class HqCity3dTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        src = HARNESS % {"root": json.dumps(ROOT), "fixture": json.dumps(FIXTURE)}
        r = subprocess.run([NODE, "--input-type=module", "-e", src], capture_output=True, text=True, timeout=180)
        if r.returncode != 0:
            raise AssertionError("node failed:\n" + r.stderr[-4000:])
        cls.out = json.loads(r.stdout)

    # --- assign ---
    def test_assign_is_deterministic_for_shuffled_input(self):
        o = self.out
        for a in o["assignShuffles"]:
            self.assertEqual(a, o["assignBase"])
        self.assertEqual(len(o["assignBase"]), 20)          # junk entries dropped

    def test_assign_fills_lots_by_rank_in_user_order(self):
        self.assertEqual(self.out["lotCount"], 64)
        self.assertTrue(self.out["rankOrder"])

    def test_you_always_placed_when_the_list_exceeds_the_lots(self):
        b = self.out["big"]
        self.assertEqual(b["n"], 64)
        self.assertTrue(b["youPlaced"])
        self.assertEqual(b["youLot"], 63)                  # replaced the last one kept
        self.assertTrue(b["firstKept"])
        self.assertEqual(self.out["big2"], 1)              # you inside the first 64: placed once

    # --- placement ---
    def test_place_lot_both_facings(self):
        n, s = self.out["placeNorth"], self.out["placeSouth"]
        self.assertEqual((n["x"], n["y"], n["z"], n["rot"]), (1, 0.37, 4, 0))
        self.assertAlmostEqual(s["rot"], 3.141592653589793)
        self.assertEqual((s["x"], s["z"]), (1, 0))
        self.assertAlmostEqual(self.out["viewSouth"]["z"], -4)

    def test_lot_extras_footprint_inside_the_lot(self):
        self.assertEqual(self.out["footprintOut"], [])

    def test_every_door_front_on_unblocked_ground(self):
        self.assertEqual(self.out["doorBlocked"], [])

    def test_skatepark_site_is_the_park(self):
        k = self.out["skate"]
        self.assertEqual(k["w"], round(2 * k["HW"] * 100))
        self.assertEqual(k["d"], round(2 * k["HD"] * 100))

    # --- parts ---
    def test_bike_park_faces_the_fountain(self):
        p = self.out["parts"]
        self.assertTrue(p["legacyFaces"])
        self.assertTrue(p["turnedFaces"])
        self.assertLess(p["drift"], 1e-9)                  # the list matches where the models stand
        self.assertLess(p["yawErr"], 1e-9)

    def test_boards_on_the_fountain_side(self):
        p = self.out["parts"]
        for x, z, yaw, kind in p["boards"]:
            self.assertAlmostEqual(x, 11 - 5.25)          # -HW + 0.5 from a park at x 11: towards the fountain at 0
            self.assertAlmostEqual(yaw, 3.141592653589793 / 2)
            self.assertEqual(kind, "skate")
        for x, yaw in p["legacyBoards"]:
            self.assertAlmostEqual(x, -11 + 5.25)         # legacy default: +HW - 0.5
            self.assertAlmostEqual(yaw, -3.141592653589793 / 2)

    # --- the legacy City ---
    def test_legacy_layout_unchanged(self):
        with open(GOLDEN, encoding="utf-8") as f:
            golden = json.load(f)
        self.assertEqual(self.out["legacy"], golden)

    def test_legacy_plaza_trees_are_placed(self):
        lw = self.out["legacyWorld"]
        for want in lw["want"]:
            self.assertIn(want, lw["trees"])
        self.assertEqual(lw["kinds"][:10], ["bike"] * 6 + ["skate"] * 4)   # bike park first, then boards
        self.assertEqual(lw["kinds"][10:], ["car", "moto", "bike"] * 3)
        self.assertEqual(lw["skate"], [-11, 0])

    def test_legacy_lot_extras_caller(self):
        src = read(os.path.join(GAMES, "hqcity.js"))
        body = src[src.index("function building(L)"):src.index("function viewBuilding(L)")]
        self.assertIn("HQV.hqCityParts.lotExtras(c, g, lotColors(h.look), L.rot,", body)
        self.assertRegex(body, r"X\.glows\.forEach\(function\(gl\)\{ lampGlows\.push\(gl\); \}\)")
        self.assertIn("L.car = X.car;", body)
        self.assertIn("X.items.forEach(function(b){ bikes.push(b); });", body)
        build = src[src.index("function build()"):]
        order = [build.index(s) for s in ("bikes = parts.bikePark(", "skate = parts.skatePark(", "skate.boards.forEach", "city.lots.forEach(building)")]
        self.assertEqual(order, sorted(order))
        self.assertNotRegex(src, r"//[^\n]*pt\.position\.set")       # the :238 tree bug stays fixed

    def test_parts_house_style(self):
        for name in ("hqcityparts.js", "hqcity3d.js"):
            src = read(os.path.join(GAMES, name))
            self.assertIn('"use strict"', src)
            self.assertNotIn("Math.random", src)
            self.assertNotRegex(src, r"\b(let|const)\s")
            self.assertNotIn("=>", src)

    # --- the 3D City ---
    def test_city3d_world_contract(self):
        o = self.out["city3d"]
        self.assertTrue(o["ready"])
        self.assertEqual(o["net"], "city3d")
        self.assertEqual(o["camModes"], ["map", "far", "chase", "near", "fp", "classic", "photo", "cine"])
        self.assertEqual(o["startMode"], "chase")
        self.assertEqual(o["bounds"], [-1018, 1018, -1018, 1018])
        self.assertEqual(o["floor"], 1)
        self.assertEqual(o["wbNight"], True)

    def test_city3d_rideables_and_doors(self):
        o = self.out["city3d"]
        self.assertEqual(o["kinds"], ["bike"] * 6 + ["skate"] * 4 + ["car", "moto", "bike"] * 5)
        self.assertTrue(o["finite"])
        self.assertIn("@lobby", o["doors"])
        self.assertEqual(sum(1 for d in o["doors"] if d and d.startswith("visit:")), 4)
        self.assertGreaterEqual(len(o["doors"]), 5 + 13)
        self.assertEqual(o["rebuilt"]["bikes"], 10 + 3 * 6)
        self.assertEqual(o["rebuilt"]["doors"][1], o["rebuilt"]["doors"][0] + 1)

    def test_city3d_ground_and_blocking(self):
        o = self.out["city3d"]
        self.assertAlmostEqual(o["skateBase"], o["skateSiteY"])
        self.assertAlmostEqual(o["groundPark"], o["skateSiteY"])
        self.assertAlmostEqual(o["groundDoor"], o["doorY"])
        self.assertFalse(o["spawnBlocked"])
        self.assertFalse(o["doorBlocked"])
        self.assertTrue(o["fountainBlocked"])
        self.assertTrue(o["edgeBlocked"])
        self.assertTrue(o["towerBlocked"])
        self.assertTrue(o["garageBlocked"])
        sp, door = o["spawn"], o["youDoor"]
        self.assertAlmostEqual(sp["x"], door["x"])
        self.assertAlmostEqual(sp["z"], door["z"] + 2.6)
        self.assertAlmostEqual(sp["camYaw"], 0.55)

    def test_city3d_camera_queries_and_fading(self):
        o = self.out["city3d"]
        self.assertLess(o["hitT"], 1)
        self.assertGreater(o["hitT"], 0)
        self.assertIn(o["blId"], o["occBIds"])                 # the world's buildings by lot id
        self.assertTrue(any(isinstance(i, str) and i.startswith("hq:") for i in o["occIds"]))
        self.assertEqual(len(o["faded"]), 1)               # building lots go to worldbuild; placed ones fade themselves
        self.assertFalse(o["modes"]["map2"]["fog"])
        self.assertTrue(o["modes"]["chase1"]["fog"])
        self.assertTrue(o["modes"]["chase3"]["fog"])

    def test_city3d_quality_stats_and_stale(self):
        o = self.out["city3d"]
        self.assertEqual(o["quality"]["q"], [1])
        self.assertEqual(o["quality"]["stats"], {"tiles": 7, "pending": 2, "worker": True})
        self.assertEqual(o["stale"], [False, False, True])

    def test_city3d_traffic_turns_without_a_snap(self):
        tr = self.out["city3d"]["traffic"]
        self.assertGreater(tr["n"], 0)
        self.assertGreater(tr["turned"], 0)                  # they did reach a street end and turn
        self.assertLess(tr["maxStep"], 7 * 0.05 + 0.05)      # never further than its speed allows in one frame
        self.assertLess(tr["maxYaw"], 0.5)                   # no 180-degree flip in one frame

    def test_city3d_slab_spans_the_spec(self):
        sl = self.out["city3d"]["slab"]
        self.assertAlmostEqual(sl["lo"], sl["y"] - 3, places=5)
        self.assertAlmostEqual(sl["hi"], sl["y"] + 0.05, places=5)
        self.assertTrue(sl["colors"])

    def test_city3d_camera_clear_beside_a_levelled_hq(self):
        wg = self.out["city3d"]["wing"]
        for k in ("right", "between"):
            self.assertFalse(wg[k]["blocked"], k)
            self.assertGreater(wg[k]["t"], 0, k)
        self.assertGreater(wg["front"]["t"], 0)
        self.assertLess(wg["front"]["t"], 1)                 # a ray through the tower still stops at it

    def test_city3d_destroy(self):
        d = self.out["city3d"]["destroy"]
        self.assertEqual(d["late"], "rejected")
        self.assertEqual(d["madeLate"], 0)                 # a late load builds nothing
        self.assertEqual(d["gone"], 0)
        self.assertEqual(d["goneAfter"], 1)                # destroyed after it loaded: its worldbuild goes too

    def test_city3d_rebuilds_only_what_changed(self):
        s = self.out["city3d"]["selective"]
        self.assertTrue(s["crewSame"])                     # crew counts: no building rebuilt
        self.assertTrue(s["sub"])                          # ... the line under the name is new
        self.assertFalse(s["subOld"])
        self.assertTrue(s["c0New"])                        # a look change rebuilds that HQ
        self.assertTrue(s["c0Gone"])
        self.assertTrue(s["othersSame"])                   # ... and no other
        self.assertGreater(s["disposed"], 0)               # its old geometry is freed
        self.assertEqual(s["hits"][0], s["hits"][1])

    def test_city3d_fade_eases_without_recompiles(self):
        f = self.out["city3d"]["fade"]
        self.assertLess(f["first"], 1)
        self.assertGreater(f["first"], 0.75)               # one frame in: barely started, no snap
        self.assertLess(f["half"], f["first"])
        self.assertAlmostEqual(f["faded"], 0.16, places=3)  # there by ~0.25 s
        self.assertFalse(f["dwFaded"])
        self.assertAlmostEqual(f["back"], 1, places=3)
        self.assertTrue(f["dwBack"])
        self.assertAlmostEqual(f["calm"], 0.16, places=3)   # Calm: instant
        self.assertTrue(f["transparent"])                  # transparent for good
        self.assertTrue(f["versionSame"])                  # no needsUpdate (no shader recompile)
        self.assertTrue(f["shadowSame"])                   # no castShadow toggle
        self.assertGreater(f["otherMin"], 0.16)            # fading yours leaves the others solid

    def test_city3d_far_hqs_hidden(self):
        c = self.out["city3d"]["cull"]
        self.assertEqual((c["near"], c["far"], c["map"], c["back"]), (True, False, True, True))

    def test_shadow_box_on_its_texel_grid(self):
        sn, t = self.out["snap"], self.out["snapTexel"]
        self.assertLess(sn["grid"], 1e-6)
        self.assertLess(sn["depth"], 1e-6)
        self.assertLessEqual(sn["move"], t * 0.7072)
        sun = self.out["city3d"]["sun"]
        for a, b in zip(sun["target"], sun["want"]):
            self.assertAlmostEqual(a, b, places=6)
        for a, b in zip(sun["off"], [0.45 * 120, 0.79 * 120, 0.34 * 120]):
            self.assertAlmostEqual(a, b, places=6)

    def test_city3d_merges_only_static_meshes(self):
        m = self.out["city3d"]["merge"]
        self.assertGreaterEqual(m["calls"], 13 + 1 + 2 * 5)   # each view building, the plaza, each HQ (building + lot)
        self.assertGreater(m["merged"], 0)
        self.assertEqual(m["bad"], [])
        self.assertTrue(m["keepDoor"])
        self.assertFalse(m["keepPlain"])

    def test_city3d_hq_building_merges_through_sub_groups(self):
        m = self.out["city3d"]["hqMerge"]
        self.assertTrue(m["visible"])
        for k in ("building", "lot", "plaza"):            # meshes in sub-groups merge too (a group above
            before, after = m[k]                          # a mesh is never kept just for being a group)
            self.assertGreater(before, 0, k)
            self.assertLess(after, before, k)
        self.assertLess(m["plaza"][1], m["plaza"][0] - 20)
        self.assertGreater(m["moved"], 0)                 # the heli and rotor still move
        self.assertEqual(m["movedMerged"], 0)             # and none of it was baked into a merged mesh

    def test_load_order_has_hqmerge_before_hqcity3d(self):
        src = read(os.path.join(ROOT, "ui", "app", "22-hq.js"))
        order = json.loads(re.search(r"var HQ_SCRIPTS = (\[[^\]]*\]);", src).group(1))
        self.assertLess(order.index("hqmerge"), order.index("hqcity3d"))
        self.assertIn("hqmerge:1", src)                    # optional: the City runs without it

    def test_city3d_map_pick_and_info(self):
        o = self.out["city3d"]
        self.assertEqual(o["pickYou"]["kind"], "hq")
        self.assertTrue(o["pickYou"]["you"])
        self.assertEqual(o["pickYou"]["door"], {"x": o["youDoor"]["x"], "z": o["youDoor"]["z"]})
        self.assertEqual(o["pickOther"]["kind"], "hq")
        self.assertFalse(o["pickOther"]["you"])
        self.assertEqual(o["pickPt"], {"kind": "point", "x": 500, "z": 500})
        self.assertGreater(o["infoRoads"], 0)
        self.assertEqual(len(o["infoHqs"]), 5)
        self.assertEqual(sum(1 for h in o["infoHqs"] if h["you"]), 1)


if __name__ == "__main__":
    unittest.main()
