"""The 3D City on a Cities world (WorldDoc v2): games/hqcity3d.js wiring the Cities modules.

The Commons (claude-hq@2) and a personal island (user:<id>@2) come from the real generator
(tests/fixtures/*@2.json.gz, written by tools/world_fixture.py). The City is built under node with
the vendored three.js, a stub hq3d ctx, a stub worldbuild, a tiny fake DOM for its menus and a stub
Arena (city state, HQ assignment, archipelago, fares). It checks what the integration promises:
the world chain (island, else the Commons, else claude-hq@1), tier from the city state, civic
buildings by tier with the town hall's door opening the Town Hall, HQ towers by the Arena's ranks,
the owner's HQ by the town hall on an island, boats at the docks and the sea blocking a walk, the
per-world net room, E on a resident / at a stop (wait, board, pay, ride, step off) / at a dock
(a ferry that lands you on the other world), the My island button, and the load order in
ui/app/22-hq.js. The pure helpers are checked directly. Stdlib only; skipped without node."""
import json
import os
import re
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIX = os.path.join(ROOT, "tests", "fixtures")
COMMONS = os.path.join(FIX, "claude-hq@2.json.gz")
ISLAND = os.path.join(FIX, "island@2.json.gz")
NODE = shutil.which("node")
ME = "0b8e4c1a-3f2d-4e5b-9a6c-7d8e9f0a1b2c"


def read(*p):
    with open(os.path.join(ROOT, *p), encoding="utf-8") as f:
        return f.read()


HARNESS = r"""
import fs from "fs";
import zlib from "zlib";
const root = %(root)s, ME = %(me)s;
const THREE = await import(root + "/games/vendor/three-module.js");
/* a tiny DOM: elements that remember children, text, listeners (the City's menus and buttons) */
function El(tag){ this.tagName = tag; this.children = []; this.style = {}; this.attrs = {}; this.on = {}; this.textContent = ""; this.parentNode = null; this.disabled = false; }
El.prototype.appendChild = function(c){ c.parentNode = this; this.children.push(c); return c; };
El.prototype.removeChild = function(c){ var i = this.children.indexOf(c); if(i >= 0) this.children.splice(i, 1); c.parentNode = null; return c; };
El.prototype.setAttribute = function(k, v){ this.attrs[k] = String(v); };
El.prototype.addEventListener = function(t, f){ this.on[t] = f; };
El.prototype.focus = function(){};
El.prototype.click = function(){ if(this.on.click) this.on.click({}); };
const winKeys = [];
globalThis.document = {createElement: t => new El(t), pointerLockElement: null};
globalThis.window = {HQV: {}, addEventListener(t, f){ winKeys.push(f); }, removeEventListener(t, f){ var i = winKeys.indexOf(f); if(i >= 0) winKeys.splice(i, 1); }};
const HQV = window.HQV;
var NOW = 1760000000000; const realNow = Date.now; Date.now = () => NOW;
for (const f of ["hqbase", "hqskate", "world", "worldgeom", "hqcityparts", "hqcity", "hqmerge", "hqcivic", "npcsim", "npcdraw", "traffic", "ocean", "hqboat", "hqtravel", "hqcity3d"])
  new Function(fs.readFileSync(root + "/games/" + f + ".js", "utf8"))();
const gz = p => JSON.parse(zlib.gunzipSync(fs.readFileSync(p)).toString("utf8"));
const WD = HQV.world, C3 = HQV.hqCity3d;
const DOCS = {"claude-hq@2": WD.pack(gz(%(commons)s)), ["user:" + ME + "@2"]: WD.pack(gz(%(island)s))};
const out = {};

/* ---------- the stub hq3d ctx (as tests/test_hqcity3d.py) ---------- */
function hashStr(s){ var h = 2166136261 >>> 0; s = String(s); for(var i = 0; i < s.length; i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h >>> 0; }
function rng(seed){ var a = seed >>> 0 || 1; return function(){ a = (a + 0x6D2B79F5) >>> 0; var t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0)/4294967296; }; }
function mat(c, o){ return new THREE.MeshStandardMaterial(Object.assign({color: c, roughness: 0.7, metalness: 0.08}, o || {})); }
function emis(c, e, ei, o){ var m = mat(c, o); m.emissive = new THREE.Color(e); m.emissiveIntensity = ei; return m; }
function add(o, x, y, z, p, ns){ o.position.set(x, y, z); if(!ns){ o.castShadow = true; o.receiveShadow = true; } p.add(o); return o; }
var noop2d = new Proxy({}, {get(t, k){ return k === "measureText" ? function(){ return {width: 10}; } : (k === "createLinearGradient" || k === "createRadialGradient") ? function(){ return {addColorStop(){}}; } : function(){}; }, set(){ return true; }});
function tagged(name){ var g = new THREE.Group(); g.name = name; return g; }
var avatar = {x: 0, z: 0}, LIST = [], calls = {get: [], post: [], townHall: [], goCity: [], teleport: []}, ISLES = true, ARENA_UP = true;
var STATE = {commons: {owner: "commons", tier: 5, grow: 1000, name: "The Commons"}};
STATE[ME] = {owner: ME, tier: 1, grow: 0, name: "Ann"};
var ROWS = [], ARCH = {commons: {world: "claude-hq@2", x: 0, z: 0}, islands: [{owner: ME, name: "Ann", world: "user:" + ME + "@2", x: 310000, z: 0, tier: 1}]};
const root2d = new El("div");
var c = {THREE: THREE, L: null, el: root2d, PI: Math.PI, COL: {amber: 0xffb347, cyan: 0x5fd3e6, green: 0x6fd38a}, HEX: {green: "#6fd38a", amber: "#ffb347", cyan: "#5fd3e6"},
  STATE_HEX: {}, E: {calm(){ return false; }}, rng: rng, hashStr: hashStr, mat: mat, emis: emis, add: add,
  box(w, h, d, m, x, y, z, p, ns){ return add(new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m), x, y, z, p, ns); },
  cyl(rt, rb, h, m, x, y, z, p, seg){ return add(new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg || 20), m), x, y, z, p); },
  sph(r, m, x, y, z, p){ return add(new THREE.Mesh(new THREE.SphereGeometry(r, 14, 10), m), x, y, z, p); },
  canvasTex(w, h, draw){ if(draw) draw(noop2d, w, h); return {c: null, g: noop2d, t: new THREE.Texture()}; },
  screen(w, h, t, tr){ return new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({map: t, transparent: !!tr})); },
  glow(col, s, o){ return new THREE.Sprite(new THREE.SpriteMaterial({color: col, opacity: o, transparent: true})); },
  label(t){ var s = new THREE.Sprite(new THREE.SpriteMaterial({transparent: true})); s.name = "label:" + t; return s; }, glyph(){ return new THREE.Sprite(new THREE.SpriteMaterial()); },
  short(s, n){ s = String(s || ""); return s.length > n ? s.slice(0, n) : s; }, crewState(){ return "idle"; },
  character(){}, anim(){}, level(){ return 1; }, look(){ return {}; }, sessions(){ return []; }, lights: [], g: null,
  car(a){ var g = tagged("car"); g.add(new THREE.Mesh(new THREE.BoxGeometry(1.7, 1, 3.6), mat(a))); return {g: g}; },
  moto(a){ var g = tagged("moto"); g.add(new THREE.Mesh(new THREE.BoxGeometry(0.4, 1, 1.4), mat(a))); return {g: g}; },
  bike(a){ var g = tagged("bike"); g.add(new THREE.Mesh(new THREE.BoxGeometry(0.1, 1, 1), mat(a))); return {g: g}; },
  board(){ return {g: tagged("board")}; },
  avatar(){ return avatar; }, view(){ return {yaw: 0.6, pitch: 0.7}; },
  teleport(x, z, yaw){ calls.teleport.push([x, z, yaw]); avatar = {x: x, z: z}; },
  goCity(world, spawn){ calls.goCity.push([world, spawn]); return true; },
  api: {city(){ return LIST; }, cityReturn(){ return null; }, viewTitle(){ return null; }, me(){ return ME; },
    netCan(cap){ return ISLES && cap === "isles"; }, announce(){}, toast(){},
    arenaGet(path){
      calls.get.push(path);
      if(!ARENA_UP) return Promise.reject(new Error("HTTP 502"));
      var m = /^\/api\/arena\/city\/(commons|[0-9a-f-]{36})$/.exec(path);
      if(m) return STATE[m[1]] ? Promise.resolve(STATE[m[1]]) : Promise.reject(new Error("HTTP 404"));
      if(path === "/api/arena/world/claude-hq@2/assign") return Promise.resolve(ROWS);
      if(path === "/api/arena/archipelago") return Promise.resolve(ARCH);
      return Promise.reject(new Error("HTTP 404"));
    },
    arenaPost(path, body){ calls.post.push([path, body]); return Promise.resolve({ok: true, status: 200, j: {}}); }}};
HQV.townHall = {open(owner, o){ calls.townHall.push([owner, !!(o && o.mine)]); }, isOpen(){ return false; }};
var wbOpts = [];
HQV.worldbuild = {create(cc, WW, o){ wbOpts.push(o); var root = new THREE.Group(), floor = new THREE.Mesh(new THREE.PlaneGeometry(10, 10), new THREE.MeshBasicMaterial());
  return {root: root, ready: Promise.resolve(), update(){}, setNight(){}, setFaded(){}, terrainMeshes(){ return [floor]; },
    setQuality(){}, stats(){ return {}; }, destroy(){}, sea: new THREE.Mesh()}; }};
var FAIL = {};
WD.load = function(o){ var id = (o && o.id) || "claude-hq@1"; if(FAIL[id] || !DOCS[id]) return Promise.reject(new Error("world unavailable: 404")); return Promise.resolve(DOCS[id]); };
const frustum = new THREE.Frustum();
function frame(w, x, z, n){ for(var i = 0; i < (n || 1); i++) w.update(i*0.05, 0.05, 1, {x: x, y: 40, z: z, fov: 60, mode: "chase", frustum: frustum, avatar: {x: avatar.x, y: 0, z: avatar.z}}); }
function city(world, spawn){ C3.go(world, spawn); var w = {scene: new THREE.Scene(), name: "city"}; HQV.hqWorlds.city3d(c, w); return w; }
function menuItems(){ var m = root2d.children.filter(e => e.attrs.role === "dialog")[0]; return m ? m.children.filter(e => e.tagName === "button") : []; }

/* ---------- pure ---------- */
var CW = DOCS["claude-hq@2"], IW = DOCS["user:" + ME + "@2"];
out.pure = {
  owner: [C3.ownerOf("user:" + ME + "@2"), C3.ownerOf("claude-hq@2"), C3.ownerOf("user:../x@2"), C3.ownerOf(null)],
  islandOf: [C3.islandOf(ME), C3.islandOf("x/../y"), C3.islandOf(ME.toUpperCase())],
  worldOk: ["claude-hq@2", "claude-hq@1", "user:" + ME + "@2", "claude-hq@3", "user:" + ME + "@1", "user:x@2", ""].map(C3.worldOk),
  net: [C3.netRoom("claude-hq@2", true), C3.netRoom("user:" + ME + "@2", true), C3.netRoom("claude-hq@2", false), C3.netRoom("evil", true)],
  ranks: C3.assignRanks([{userId: "b"}, {userId: "a"}, {userId: "z"}, null, {userId: 7}], [{user: "a", lot_rank: 5}, {user: "b", lot_rank: 0}, {user: "q", lot_rank: 1}, {user: "z", lot_rank: 999}], CW)
    .map(a => [a.h.userId, a.lot.rank]),
  islandMine: C3.assignIsland([], ME, ME, IW).map(a => [a.h.userId, a.h.isYou, a.lot.rank]),
  islandOther: C3.assignIsland([{userId: ME}], ME, "someone-else", IW).map(a => [a.h.userId, a.lot.rank]),
  islandClosed: C3.assignIsland([], ME, "someone-else", IW).length,
  civicTier: [1, 2, 3, 4, 5].map(t => C3.civicSites(IW, t).length),
  civicMaxTier: [1, 2, 3, 4, 5].map(t => Math.max.apply(null, C3.civicSites(IW, t).map(s => s.tier || 1))),
  civicPlaza: C3.civicSites(CW, 5).filter(s => /^(fountain|skatepark|bikepark|spawn)$/.test(s.kind)).length,
  places: C3.travelPlaces(ARCH, "claude-hq@2", ME).map(p => [p.world, p.name, p.x, p.z]),
  placesIsland: C3.travelPlaces(ARCH, "user:" + ME + "@2", ME).map(p => p.name),
  placesBad: C3.travelPlaces({islands: [{world: "user:../../x@2", x: 1, z: 1}, {world: "user:" + ME + "@2", x: "a", z: 0}]}, "claude-hq@2", ME).length,
  lotFront: (function(){ var l = IW.lots.filter(x => x.kind === "hq")[0], p = C3.placeLot(l), f = C3.frontOf(l); return [Math.abs(Math.sin(p.rot) - f[0]) < 1e-9, Math.abs(Math.cos(p.rot) - f[1]) < 1e-9]; })(),
  wait: [C3.waitText(4000), C3.waitText(125000), C3.waitText(-5)],
  // the generator's job tables (minutes, per-mille) become npcsim's (hours, weights) and npcsim reads them
  zones: (function(){ var z = C3.simZones(CW.zones), j = z[0].jobs[0], tab = HQV.npcSim.zoneJobs(z)[z[0].kind][0];
    return {first: [j.job, j.from, j.to, j.n], read: tab, raw: CW.zones[0].jobs[0]}; })()
};
var dock = IW.sites.filter(s => s.kind === "dock")[0], dd = C3.doorOf(dock);
out.pure.terminal = [(C3.terminalAt(IW, 1, dd.x, dd.z) || {}).kind, C3.terminalAt(IW, 1, dd.x + 200, dd.z) == null];


/* ---------- roads: nothing you can't see blocks a road (a v2 building blocks by the box it is drawn as) ---------- */
function roadHits(test, W){
  var n = 0, hit = 0;
  W.edges.forEach(function(e){ var p = e.pts, m = p.length/3, hw = e.width/200;
    for(var s = 0; s + 1 < m; s++){ var ax = p[3*s]/100, az = p[3*s+2]/100, bx = p[3*s+3]/100, bz = p[3*s+5]/100, L = Math.hypot(bx - ax, bz - az); if(!L) continue;
      var nx = -(bz - az)/L, nz = (bx - ax)/L;
      for(var t = 0; t < L; t += 2) [0, hw*0.45, -hw*0.45].forEach(function(o){ n++; if(test(ax + (bx - ax)*t/L + nx*o, az + (bz - az)*t/L + nz*o)) hit++; }); } });
  return [n, hit];
}
out.roads = {commonsWorld: roadHits(function(x, z){ return WD.blockedAt(CW, x, z); }, CW),
             islandWorld: roadHits(function(x, z){ return WD.blockedAt(IW, x, z); }, IW)};
/* ---------- the Commons ---------- */
ROWS = [{user: "c1", lot_rank: 3}, {user: "c0", lot_rank: 0}];
LIST = [{userId: "c0", level: 2, look: {}}, {userId: "c1", level: 3, look: {}}, {userId: "c2", level: 1, look: {}}];
var wc = city(null);
await wc.whenReady; await new Promise(r => setTimeout(r, 0));
frame(wc, 0, 0, 2);
var hqHits = wc.hits.filter(o => o.userData.door && o.userData.door.userId);
out.commons = {world: wc.world(), net: wc.net, tierOpt: wbOpts[0], civic: wc.doors.filter(d => d.kind && !d.userId).length,
  townDoor: wc.doors.filter(d => d.kind === "townhall").map(d => [!!d.view, d.live]),
  viewDoors: wc.doors.filter(d => d.view && !d.userId && !/^visit:|^@/.test(d.view)).map(d => d.view).sort(),
  towers: hqHits.map(o => o.userData.door.userId).filter((u, i, a) => a.indexOf(u) === i).sort(),
  boats: wc.bikes.filter(b => b.kind === "rowboat" || b.kind === "jetski").map(b => b.kind).sort(),
  seaBlocked: wc.blocked(900, 0), plazaOpen: !wc.blocked(3, 9),
  seaY: wc.sea && wc.sea.y, gets: calls.get.slice()};
ISLES = false; out.commons.netOld = wc.net; ISLES = true;
// the town hall's door: the Town Hall panel for the Commons, no owner controls
wc.townHall(); out.commons.townHall = calls.townHall.slice();
// stepping ashore from a boat at a berth lands on the dock, on land
var berth = wc.sea.docks[0], land = wc.boatLand({x: berth.x, z: berth.z, yaw: berth.yaw});
out.commons.ashore = land && [wc.sea.land(land.x, land.z), wc.boatLand({x: berth.x + 400, z: berth.z + 400, yaw: 0}) == null];

/* ---------- the pier: walked on at its deck, the boats moored in sight beside it ---------- */
(function(){
  var site = CW.sites.filter(s => s.id === berth.id)[0], P = HQV.hqCivic.pierOf(site)[0], dx = P.dir[0], dz = P.dir[1];
  var len = (P.head[0] - P.poly[0][0])*dx + (P.head[1] - P.poly[0][1])*dz, walk = [];
  // from its land end (the ferry office stands across it: you come on round its side) out to its head, down the middle
  for(var a = 0.5; a <= len - 0.3; a += 1){ var x = P.head[0] - dx*(len - a), z = P.head[1] - dz*(len - a); walk.push([wc.blocked(x, z), wc.groundY(x, z)]); }
  var onPier = walk, ax = P.head[0] - dx*(len - 1), az = P.head[1] - dz*(len - 1);
  out.pier = {deckY: P.y, seaY: wc.sea.y, walkBlocked: walk.filter(q => q[0]).length, deckYs: onPier.map(q => q[1]),
    besideBlocked: [1, -1].map(sg => wc.blocked(P.head[0] - dx*3 + dz*(P.w/2 + 1.5)*sg, P.head[1] - dz*3 - dx*(P.w/2 + 1.5)*sg)),
    landY: land && wc.groundY(land.x, land.z), berthOnDeck: HQV.hqCivic.deckAt([P], berth.x, berth.z),
    // the way on: off the paving beside the land end
    access: [1, -1].map(sg => wc.blocked(ax + dz*(P.w/2 + 1)*sg, az - dx*(P.w/2 + 1)*sg))};
  // the boats at this berth: none under the deck, clear of it beam and all, each in reach (4 m) of its edge
  var V = HQV.hqboat.VEHICLES;
  out.pier.boats = wc.bikes.filter(b => /^boat:/.test(b.id || "") && b.id.indexOf(berth.id + ":") === 5).map(function(b){
    var rx = b.x - P.head[0], rz = b.z - P.head[1], along = rx*dx + rz*dz, side = Math.abs(rx*dz - rz*dx);
    return {kind: b.kind, under: HQV.hqCivic.deckAt([P], b.x, b.z) != null, clear: side - V[b.kind].beam/2 - P.w/2,
      reach: Math.hypot(side - (P.w/2 - 0.3), Math.max(0, along)), alongside: along < 0 && along > -len, y: b.g.position.y};
  });
})();

/* ---------- what is drawn: civic buildings in full near the camera, boxes beyond; props near only ---------- */
function frameCam(w, x, y, z, mode, n){ for(var i = 0; i < (n || 1); i++) w.update(i*0.05, 0.05, 1, {x: x, y: y, z: z, fov: 60, mode: mode, frustum: frustum, avatar: {x: avatar.x, y: 0, z: avatar.z}}); }
function drawnNow(w, cx, cy, cz){
  var full = [], lod = null, props = 0;
  w.scene.traverse(function(o){
    if(/^civic:/.test(o.name) && o.parent && o.name !== "civic:lod" && !/^civic:/.test(o.parent.name) && o.isGroup){
      if(o.visible) full.push(Math.hypot(o.position.x - cx, o.position.z - cz, o.position.y - cy));
    }
    if(o.name === "civic:lod") lod = {visible: o.visible, count: o.count, shown: (function(){ var n = 0, m = o.instanceMatrix.array; for(var i = 0; i < o.count; i++) if(m[i*16] !== 0 || m[i*16 + 10] !== 0) n++; return n; })()};
  });
  w.bikes.forEach(function(b){ var vis = !b.inner || b.inner.visible, q = b.g; while(q){ if(!q.visible) vis = false; q = q.parent; } if(vis) props++; });
  return {full: full.length, farthest: full.length ? Math.max.apply(null, full) : 0, lod: lod, props: props};
}
avatar = {x: 0, z: 10};
frameCam(wc, 0, 4, 18, "chase", 2); out.drawn = {chase: drawnNow(wc, 0, 4, 18)};
frameCam(wc, 0, 900, 10, "map", 2); out.drawn.map = drawnNow(wc, 0, 900, 10);
frameCam(wc, 0, 4, 18, "chase", 2); out.drawn.back = drawnNow(wc, 0, 4, 18);
out.drawn.civics = wc.scene.getObjectByName("civic:lod") ? wc.scene.getObjectByName("civic:lod").count : 0;

/* ---------- a stop: wait, board, pay, ride, step off ---------- */
(function(){
  // at tier 5 on the Commons every line runs; stand at the first stop a line calls at
  var line = CW.transit.lines.filter(l => l.kind === "bus")[0], stop = CW.sites.filter(s => s.id === line.stops[1])[0];
  avatar = {x: stop.x/100, z: stop.z/100};
  var used = wc.use({x: avatar.x, z: avatar.z}), items = menuItems();
  out.bus = {used: used, menu: wc.menuOpen(), items: items.length, first: items.length ? items[0].textContent : null};
  if(!items.length) return;
  items[0].click();
  out.bus.menuAfter = wc.menuOpen(); out.bus.carryWaiting = wc.carry();
  // wait for the bus: nothing paid until it comes
  var paid0 = calls.post.length;
  for(var i = 0; i < 60*12 && !wc.carry(); i++){ NOW += 1000; frame(wc, avatar.x, avatar.z); }
  var p = wc.carry();
  out.bus.boarded = !!p; out.bus.fare = calls.post.slice(paid0);
  var moved = 0, last = p;
  for(var j = 0; j < 60*30 && wc.carry(); j++){ NOW += 500; frame(wc, avatar.x, avatar.z); var q = wc.carry(); if(q){ moved = Math.max(moved, Math.hypot(q.x - p.x, q.z - p.z)); last = q; } }
  out.bus.moved = moved; out.bus.off = calls.teleport.length; out.bus.carryAfter = wc.carry();
})();

/* ---------- a resident talks (E) ---------- */
(function(){
  // a resident the sim shows walking near some point in the day; the City draws it, E says its line
  var sim = HQV.npcSim.create(WD.docOf(CW), {tier: 5, grow: 1000, seed: CW.seed});
  var tMs = HQV.npcSim.localMs(new Date(NOW)), list = sim.at(tMs, {x: 0, z: 0}, 400);
  out.talk = {seen: list.length};
  var r = list.filter(x => x.mode === "walk")[0] || list[0]; if(!r) return;
  avatar = {x: r.x + 0.5, z: r.z};
  frame(wc, avatar.x, avatar.z, 1);
  var before = 0; wc.scene.traverse(o => { if(/^label:/.test(o.name)) before++; });
  out.talk.used = wc.use({x: avatar.x, z: avatar.z});
  var labels = []; wc.scene.traverse(o => { if(/^label:/.test(o.name)) labels.push(o.name); });
  out.talk.newLabel = labels.length - before;
})();

/* ---------- a dock: the ferry to my island ---------- */
(function(){
  var d = CW.sites.filter(s => s.kind === "dock")[0], door = C3.doorOf(d);
  avatar = {x: door.x, z: door.z};
  calls.goCity = [];
  wc.use({x: avatar.x, z: avatar.z});
})();
await new Promise(r => setTimeout(r, 10));
(function(){
  var items = menuItems();
  out.ferry = {items: items.map(b => b.textContent)};
  var fi = items.findIndex(b => /Ferry to My island/.test(b.textContent));
  if(fi < 0) return;
  items[fi].click();
  out.ferry.held = !!wc.carry();
})();
for(var i = 0; i < 400 && !calls.goCity.length; i++){ NOW += 1000; frame(wc, avatar.x, avatar.z); await new Promise(r => setTimeout(r, 0)); }
out.ferry.arrived = calls.goCity.map(g => [g[0], !!g[1] && isFinite(g[1].x) && isFinite(g[1].z)]);
out.ferry.camPose = (function(){ var p = wc.camPose(); return p ? p.frame : null; })();
var statsEl = root2d.children.filter(e => e.className === "hq3d-stats")[0];
out.commons.stats = statsEl ? statsEl.children.map(e => e.children.length ? e.children.map(k => k.textContent) : e.textContent) : null;
var spawn = calls.goCity.length ? calls.goCity[0][1] : null;

/* ---------- my island, tier 1, arriving by the ferry ---------- */
var wi = city("user:" + ME + "@2", spawn);
await wi.whenReady; await new Promise(r => setTimeout(r, 0));
frame(wi, 0, 0, 2);
var islandTowers = wi.hits.filter(o => o.userData.door && o.userData.door.userId).map(o => o.userData.door.userId).filter((u, i, a) => a.indexOf(u) === i);
out.roads.island = roadHits(function(x, z){ return wi.blocked(x, z); }, IW);
out.pure.stats = [1, 3, 5].map(function(t){ var K = C3.cityStats(IW, t, {population: 120, grow: 400, treasury: 55, specialty: "fish"}); return [K.happiness, K.parts.map(p => p.key), K.homes, K.population, K.tierName]; });
out.pure.statsNone = C3.cityStats(null, 2, null);
out.island = {world: wi.world(), net: wi.net, tierOpt: wbOpts[wbOpts.length - 1], towers: islandTowers,
  townDoor: wi.doors.filter(d => d.kind === "townhall").length,
  spawnAtDock: spawn && Math.hypot(wi.spawn.x - spawn.x, wi.spawn.z - spawn.z) < 0.01,
  home: !!wi.home, button: root2d.children.filter(e => e.tagName === "button").map(e => e.textContent)};
wi.townHall(); out.island.townHall = calls.townHall[calls.townHall.length - 1];
// the My island / The Commons button goes straight there
calls.goCity = [];
var btn = root2d.children.filter(e => e.tagName === "button" && /Commons/.test(e.textContent))[0];
if(btn) btn.click();
out.island.buttonGo = calls.goCity.map(g => [g[0], g[1]]);
wi.destroy(); wc.destroy();
out.leftover = root2d.children.filter(e => e.tagName === "button" || e.attrs.role === "dialog").length;

/* ---------- the chain: no island -> the Commons; no @2 -> claude-hq@1 (a v1 City) ---------- */
FAIL["user:" + ME + "@2"] = true;
var wf = city("user:" + ME + "@2"); await wf.whenReady; out.fallIsland = wf.world();
wf.destroy();
FAIL["claude-hq@2"] = true; DOCS["claude-hq@1"] = WD.pack(gz(%(legacy)s));
var wl = city(null); await wl.whenReady; out.fallLegacy = [wl.world(), wl.net]; wl.destroy();
// the Arena is down: the island still builds, at tier 1
delete FAIL["user:" + ME + "@2"]; delete FAIL["claude-hq@2"]; ARENA_UP = false;
var wd = city("user:" + ME + "@2"); await wd.whenReady; out.arenaDown = [wd.world(), wbOpts[wbOpts.length - 1].tier]; wd.destroy();
Date.now = realNow;
process.stdout.write(JSON.stringify(out));
"""


@unittest.skipUnless(NODE, "node is not installed")
@unittest.skipUnless(os.path.exists(COMMONS) and os.path.exists(ISLAND), "the @2 fixtures are missing (python3 tools/world_fixture.py)")
class CitiesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        src = HARNESS % {"root": json.dumps(ROOT), "me": json.dumps(ME), "commons": json.dumps(COMMONS),
                         "island": json.dumps(ISLAND), "legacy": json.dumps(os.path.join(FIX, "claude-hq@1.json.gz"))}
        r = subprocess.run([NODE, "--input-type=module", "-e", src], capture_output=True, text=True, timeout=600)
        if r.returncode != 0:
            raise AssertionError("node failed:\n" + r.stderr[-4000:])
        cls.out = json.loads(r.stdout)

    def test_pure_helpers(self):
        p = self.out["pure"]
        self.assertEqual(p["owner"], [ME, "commons", "commons", "commons"])
        self.assertEqual(p["islandOf"], ["user:" + ME + "@2", None, None])
        self.assertEqual(p["worldOk"], [True, True, True, False, False, False, False])
        self.assertEqual(p["net"], ["city3d:claude-hq@2", "city3d:user:" + ME + "@2", "city3d", "city3d"])
        # by the Arena's ranks: a row for a rank with no lot, or a user not on the list, places nobody
        self.assertEqual(p["ranks"], [["a", 5], ["b", 0]])
        self.assertEqual(p["islandMine"], [[ME, True, 0]])
        self.assertEqual(p["islandOther"], [[ME, 0]])
        self.assertEqual(p["islandClosed"], 0)
        self.assertEqual(p["civicTier"], sorted(p["civicTier"]), "a city only gains buildings as it grows")
        self.assertLess(p["civicTier"][0], p["civicTier"][4])
        self.assertEqual(p["civicMaxTier"], [1, 2, 3, 4, 5])
        self.assertEqual(p["civicPlaza"], 0, "the plaza's own parts are not civic buildings")
        self.assertEqual(p["places"], [["user:" + ME + "@2", "My island", 3100, 0]])
        self.assertEqual(p["placesIsland"], ["The Commons"])
        self.assertEqual(p["placesBad"], 0)
        self.assertEqual(p["lotFront"], [True, True])
        self.assertEqual(p["wait"], ["4 s", "2 min 5 s", "0 s"])
        self.assertEqual(p["terminal"], ["dock", True])
        raw, z = p["zones"]["raw"], p["zones"]
        self.assertEqual(z["first"], [raw["job"], raw["start_min"]/60, raw["end_min"]/60, raw["share_pm"]])
        self.assertEqual(z["read"], z["first"], "npcsim reads the converted table as it is")
        self.assertTrue(0 < z["read"][1] < z["read"][2] <= 24, "a day shift in hours")

    def test_roads_are_not_blocked_by_what_is_not_there(self):
        r = self.out["roads"]
        # the world's buildings and trees never stand on a road (a v2 building blocks by its drawn, turned box)
        for k in ("commonsWorld", "islandWorld"):
            n, hit = r[k]
            self.assertGreater(n, 1000)
            self.assertEqual(hit, 0, k + ": road points blocked by a building's or tree's footprint")
        # and on an island nothing else does either (civic masses, the HQ's garage, the sea)
        self.assertEqual(r["island"][1], 0)

    def test_city_stats(self):
        s = self.out["pure"]["stats"]
        for happy, keys, homes, pop, name in s:
            self.assertTrue(0 <= happy <= 100)
            self.assertEqual(pop, 120)
            self.assertIn("green", keys)
        self.assertNotIn("transit", s[0][1], "no buses at tier 1, so transit does not count")
        self.assertIn("transit", s[1][1])
        self.assertLess(s[0][2], s[2][2], "a bigger city has more buildings")
        self.assertEqual([x[4] for x in s], ["Village", "City", "Capital"])
        none = self.out["pure"]["statsNone"]
        self.assertIsNone(none["happiness"]); self.assertIsNone(none["population"])
        rows = self.out["commons"]["stats"]
        self.assertEqual(rows[0], "The Commons")
        labels = [r[0] for r in rows if isinstance(r, list) and len(r) == 2]
        for want in ("Tier", "Population", "Happiness", "Treasury"):
            self.assertIn(want, labels)

    def test_the_commons(self):
        c = self.out["commons"]
        self.assertEqual(c["world"], "claude-hq@2")
        self.assertEqual(c["net"], "city3d:claude-hq@2")
        self.assertEqual(c["netOld"], "city3d", "an Arena without isles: the shared 3D City room")
        self.assertEqual(c["tierOpt"]["tier"], 5)
        self.assertGreater(c["civic"], 10)
        self.assertEqual(c["townDoor"], [[False, True]], "one live town hall door, no tab")
        for tab in ["store", "analytics", "pokedex", "gym", "quests", "village", "arena"]:
            self.assertIn(tab, c["viewDoors"])
        self.assertEqual(c["towers"], ["c0", "c1"], "towers by the Arena's ranks; c2 has none")
        self.assertEqual(c["boats"], ["jetski", "jetski", "rowboat", "rowboat"])
        self.assertTrue(c["seaBlocked"], "the open sea is not walkable")
        self.assertTrue(c["plazaOpen"])
        self.assertEqual(c["seaY"], -15)
        self.assertIn("/api/arena/city/commons", c["gets"])
        self.assertIn("/api/arena/world/claude-hq@2/assign", c["gets"])
        self.assertEqual(c["townHall"], [["commons", False]])
        self.assertEqual(c["ashore"], [True, True])

    def test_the_pier(self):
        p = self.out["pier"]
        self.assertAlmostEqual(p["deckY"] - p["seaY"], 1.81, 2, "the deck stands over the sea")
        self.assertEqual(p["walkBlocked"], 0, "you walk out along the pier to its head")
        self.assertTrue(p["deckYs"])
        for y in p["deckYs"]:
            self.assertAlmostEqual(y, p["deckY"], 6, "on the deck, not on the seabed under it")
        self.assertEqual(p["besideBlocked"], [True, True], "the water either side of it is still the sea")
        self.assertIn(False, p["access"], "a way onto the pier beside the ferry office")
        self.assertAlmostEqual(p["landY"], p["deckY"], 6, "stepping ashore from the berth: up onto the pier's head")
        self.assertIsNone(p["berthOnDeck"])
        self.assertEqual(sorted(b["kind"] for b in p["boats"]), ["jetski", "rowboat"])
        for b in p["boats"]:
            self.assertFalse(b["under"], b)
            self.assertGreater(b["clear"], 0.1, b)
            self.assertLess(b["reach"], 4, b)
            self.assertTrue(b["alongside"], b)
            self.assertEqual(b["y"], p["seaY"])

    def test_what_is_drawn(self):
        d = self.out["drawn"]
        self.assertGreater(d["civics"], 50, "every civic building has boxes for far off")
        c = d["chase"]
        self.assertGreater(c["full"], 0)
        self.assertLess(c["farthest"], 180, "in full only near the camera")
        self.assertTrue(c["lod"]["visible"])
        self.assertGreater(c["lod"]["shown"], 0)
        self.assertLess(c["lod"]["shown"], d["civics"], "a building drawn in full hides its boxes")
        m = d["map"]
        self.assertEqual(m["full"], 0, "the map, from high up: boxes only")
        self.assertEqual(m["lod"]["shown"], d["civics"])
        self.assertEqual(m["props"], 0, "no bikes, boards or boats drawn from up there")
        self.assertGreater(c["props"], 0, "the plaza's bikes are drawn from the street")
        self.assertEqual(d["back"]["full"], c["full"])
        self.assertEqual(d["back"]["lod"]["shown"], c["lod"]["shown"])

    def test_a_bus_ride(self):
        b = self.out["bus"]
        self.assertTrue(b["used"])
        self.assertTrue(b["menu"])
        self.assertGreater(b["items"], 0)
        self.assertRegex(b["first"], r"^1\. Bus \d+ to .+ · in ")
        self.assertFalse(b["menuAfter"])
        self.assertIsNone(b["carryWaiting"], "waiting at the stop, you still walk")
        self.assertTrue(b["boarded"])
        self.assertEqual(b["fare"], [["/api/arena/city/commons/fare", {"kind": "bus"}]], "one fare, at boarding")
        self.assertGreater(b["moved"], 20, "the bus carries you along the line")
        self.assertEqual(b["off"], 1, "you step off at your stop")
        self.assertIsNone(b["carryAfter"])

    def test_a_resident_talks(self):
        t = self.out["talk"]
        self.assertGreater(t["seen"], 0)
        self.assertTrue(t["used"])
        self.assertEqual(t["newLabel"], 1)

    def test_the_ferry_to_my_island(self):
        f = self.out["ferry"]
        self.assertTrue(any(i.startswith("1. ") for i in f["items"]))
        self.assertTrue(any("Ferry to My island" in i for i in f["items"]), f["items"])
        self.assertTrue(f["held"], "boarding: you wait at the dock")
        self.assertEqual(f["arrived"], [["user:" + ME + "@2", True]])

    def test_my_island(self):
        i = self.out["island"]
        self.assertEqual(i["world"], "user:" + ME + "@2")
        self.assertEqual(i["net"], "city3d:user:" + ME + "@2")
        self.assertEqual(i["tierOpt"]["tier"], 1)
        self.assertEqual(i["towers"], [ME], "your HQ by the town hall, open or not")
        self.assertEqual(i["townDoor"], 1)
        self.assertTrue(i["spawnAtDock"], "the ferry lands you where hqtravel says")
        self.assertTrue(i["home"])
        self.assertIn("⛲ The Commons", i["button"])
        self.assertEqual(i["townHall"], [ME, True], "your own town hall: owner controls")
        self.assertEqual(i["buttonGo"], [["claude-hq@2", None]])
        self.assertEqual(self.out["leftover"], 0, "a destroyed City leaves no buttons or menus behind")

    def test_fallbacks(self):
        self.assertEqual(self.out["fallIsland"], "claude-hq@2")
        self.assertEqual(self.out["fallLegacy"], ["claude-hq@1", "city3d"])
        self.assertEqual(self.out["arenaDown"], ["user:" + ME + "@2", 1])


class LoadOrder(unittest.TestCase):
    def test_cities_modules_load_before_the_city(self):
        src = read("ui", "app", "22-hq.js")
        order = json.loads(re.search(r"var HQ_SCRIPTS = (\[[^\]]*\]);", src).group(1))
        for m in ["hqcivic", "npcsim", "npcdraw", "traffic", "ocean", "hqboat", "hqtravel"]:
            self.assertIn(m, order)
            self.assertLess(order.index(m), order.index("hqcity3d"), m)
            self.assertRegex(src, r"HQ_SCRIPTS_3D = \{[^}]*\b" + m + r":1", m + " fails soft")
        self.assertLess(order.index("hqmerge"), order.index("hqcivic"))
        self.assertLess(order.index("npcsim"), order.index("npcdraw"))

    def test_hq3d_hooks(self):
        src = read("games", "hq3d.js")
        for hook in ["inst.goCity", "cur.carry", "cur.use", "cur.camPose", "cur.boatLand", "cur.onBoat", "HQV.hqboat.VEHICLES",
                     "HQV.townHall.isOpen", "HQV.hq3dPure.CHAR_FILES"]:
            self.assertIn(hook, src)
        # the town hall's door has no tab: it never reaches the tab code
        self.assertIn('if(!d.view){ if(d.kind === "townhall"', src)


if __name__ == "__main__":
    unittest.main()
