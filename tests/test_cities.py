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
# hqcity3d's LOD hysteresis (m): a civic building out of full view comes back inside CIVIC_NEAR - this
HYST = float(re.search(r"var HQ_FAR_HYST = ([\d.]+);", open(os.path.join(ROOT, "games", "hqcity3d.js"), encoding="utf-8").read()).group(1))


def read(*p):
    with open(os.path.join(ROOT, *p), encoding="utf-8") as f:
        return f.read()


HARNESS = r"""
import fs from "fs";
import zlib from "zlib";
const root = %(root)s, ME = %(me)s;
const THREE = await import(root + "/games/vendor/three-module.js");
/* a tiny DOM: elements that remember children, text, listeners (the City's menus and buttons, the minimap, the Go to
   panel); a canvas draws on the no-op 2D context */
function El(tag){ this.tagName = tag; this.children = []; this.style = {}; this.attrs = {}; this.on = {}; this.ls = {}; this.textContent = ""; this.parentNode = null;
  this.disabled = false; this.hidden = false; this.className = ""; var self = this;
  this.classList = {add(k){ if(!this.contains(k)) self.className = (self.className + " " + k).trim(); },
    remove(k){ self.className = self.className.split(" ").filter(x => x && x !== k).join(" "); },
    contains(k){ return self.className.split(" ").indexOf(k) >= 0; }, toggle(k, on){ if(on === undefined) on = !this.contains(k); if(on) this.add(k); else this.remove(k); return on; }}; }
El.prototype.appendChild = function(c){ c.parentNode = this; this.children.push(c); return c; };
El.prototype.removeChild = function(c){ var i = this.children.indexOf(c); if(i >= 0) this.children.splice(i, 1); c.parentNode = null; return c; };
El.prototype.setAttribute = function(k, v){ this.attrs[k] = String(v); };
El.prototype.getAttribute = function(k){ return k in this.attrs ? this.attrs[k] : null; };
El.prototype.removeAttribute = function(k){ delete this.attrs[k]; };
El.prototype.addEventListener = function(t, f){ this.on[t] = f; (this.ls[t] = this.ls[t] || []).push(f); };
El.prototype.removeEventListener = function(t, f){ this.ls[t] = (this.ls[t] || []).filter(x => x !== f); if(this.on[t] === f) delete this.on[t]; };
El.prototype.focus = function(){ document.activeElement = this; };
El.prototype.blur = function(){ if(document.activeElement === this) document.activeElement = null; };
El.prototype.click = function(){ if(this.on.click) this.on.click({}); };
El.prototype.contains = function(n){ for(; n; n = n.parentNode) if(n === this) return true; return false; };
El.prototype.closest = function(sel){ var ks = sel.split(",").map(x => x.trim().replace(/^\./, ""));
  for(var n = this; n; n = n.parentNode) if(String(n.className || "").split(" ").some(k => ks.indexOf(k) >= 0)) return n; return null; };
El.prototype.getContext = function(){ return noop2d; };
El.prototype.getBoundingClientRect = function(){ return {left: 0, top: 0, width: 200, height: 200}; };
El.prototype.all = function(){ var o = [this]; this.children.forEach(k => { o = o.concat(k.all()); }); return o; };
Object.defineProperty(El.prototype, "firstChild", {get(){ return this.children[0] || null; }});
const winKeys = [];
globalThis.document = {createElement: t => new El(t), pointerLockElement: null, activeElement: null};
globalThis.window = {HQV: {}, document: globalThis.document, devicePixelRatio: 1, getComputedStyle: () => ({getPropertyValue: () => ""}),
  setTimeout(f, ms){ var t = setTimeout(f, ms); if(t.unref) t.unref(); return t; }, clearTimeout(t){ clearTimeout(t); },
  addEventListener(t, f, cap){ winKeys.push({t: t, f: f}); }, removeEventListener(t, f){ var i = winKeys.findIndex(l => l.t === t && l.f === f); if(i >= 0) winKeys.splice(i, 1); }};
/* a key, as the browser sends it: the window's capture listeners (hq3d's, the City's), then the target and up (the
   panels' own), then the page's shortcuts (ui/app/09-drawer.js: a document listener that skips a prevented key) */
const pageKeys = [];
function key(target, code, name, type){
  var ev = {type: type || "keydown", code: code, key: name, target: target, repeat: false, defaultPrevented: false, stopped: false,
    metaKey: false, ctrlKey: false, altKey: false, shiftKey: false,
    preventDefault(){ this.defaultPrevented = true; }, stopPropagation(){ this.stopped = true; }};
  winKeys.filter(l => l.t === ev.type).slice().forEach(l => l.f(ev));
  for(var n = target; n && !ev.stopped; n = n.parentNode) (n.ls[ev.type] || []).slice().forEach(f => f(ev));
  var leaked = !ev.stopped && !ev.defaultPrevented; if(leaked) pageKeys.push(code);
  return leaked;
}
const HQV = window.HQV;
var NOW = 1760000000000; const realNow = Date.now; Date.now = () => NOW;
for (const f of ["hqstyle", "hqtower", "hqroof", "hqdecor", "hqbase", "hqskate", "world", "worldgeom", "hqcityparts", "hqcity", "hqmerge", "hqcivic", "npcsim", "npcdraw", "traffic", "ocean", "hqboat", "hqtravel",
                 "hqbridges", "hqnav", "hqminimap", "hqroutefx", "hqnavui", "hqcity3d"])
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
var noop2d = new Proxy({}, {get(t, k){ return k === "measureText" ? function(){ return {width: 10}; } : k === "createImageData" ? function(w, h){ return {data: new Uint8ClampedArray(w*h*4)}; } : (k === "createLinearGradient" || k === "createRadialGradient") ? function(){ return {addColorStop(){}}; } : function(){}; }, set(){ return true; }});
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
function roadHits(test, W, tier){
  var n = 0, hit = 0;
  W.edges.forEach(function(e){ var p = e.pts, m = p.length/3, hw = e.width/200;
    if(tier != null && (e.min_tier | 0) > tier) return;            // not built yet: a bridge to come is still the river
    for(var s = 0; s + 1 < m; s++){ var ax = p[3*s]/100, az = p[3*s+2]/100, bx = p[3*s+3]/100, bz = p[3*s+5]/100, L = Math.hypot(bx - ax, bz - az); if(!L) continue;
      var nx = -(bz - az)/L, nz = (bx - ax)/L;
      for(var t = 0; t < L; t += 2) [0, hw*0.45, -hw*0.45].forEach(function(o){ n++; if(test(ax + (bx - ax)*t/L + nx*o, az + (bz - az)*t/L + nz*o)) hit++; }); } });
  return [n, hit];
}
out.roads = {commonsWorld: roadHits(function(x, z){ return WD.blockedAt(CW, x, z); }, CW),
             islandWorld: roadHits(function(x, z){ return WD.blockedAt(IW, x, z); }, IW)};

/* ---------- civic models stand inside their sites: no solid mass reaches a road, at any tier ---------- */
out.civicOnRoad = [];
[["commons", CW], ["island", IW]].forEach(function(D){
  D[1].sites.forEach(function(st){
    if(!HQV.hqCivic.KINDS[st.kind]) return;
    [1, 3, 5].forEach(function(tier){
      if(st.tier != null && st.tier > tier) return;
      var B = HQV.hqCivic.build(c, st, {tier: tier, night: false}), worst = 0;
      B.boxes.forEach(function(b){ var o = b.o; if(!o || o.y0 > 2.4) return;     // a roof clear of the ground blocks nothing
        var cr = Math.cos(o.rot), sr = Math.sin(o.rot);
        [[1, 1], [1, -1], [-1, 1], [-1, -1], [1, 0], [-1, 0], [0, 1], [0, -1]].forEach(function(q){
          var lx = q[0]*o.hw, lz = q[1]*o.hd, x = o.x + lx*cr + lz*sr, z = o.z - lx*sr + lz*cr;
          D[1].edges.forEach(function(e){ var p = e.pts, m = p.length/3, hw = e.width/200;
            for(var s = 0; s + 1 < m; s++){ var ax = p[3*s]/100, az = p[3*s+2]/100, dx = p[3*s+3]/100 - ax, dz = p[3*s+5]/100 - az, L2 = dx*dx + dz*dz;
              var t = L2 ? Math.max(0, Math.min(1, ((x - ax)*dx + (z - az)*dz)/L2)) : 0, d = Math.hypot(x - ax - dx*t, z - az - dz*t);
              if(d < hw) worst = Math.max(worst, hw - d); } }); }); });
      if(worst > 0.05) out.civicOnRoad.push([D[0], st.id, tier, +worst.toFixed(1)]);
    });
  });
});
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
  // open sea: 40 m out past the coast vertex farthest from every dock (no pier there)
  seaBlocked: (function(){ var I = CW.island, docks = CW.sites.filter(s => s.kind === "dock" || s.kind === "port"), best = null;
    I.coast.forEach(function(q){ var d = Math.min.apply(null, docks.map(s => Math.hypot(q[0] - s.x, q[1] - s.z))); if(!best || d > best.d) best = {q: q, d: d}; });
    var r = Math.hypot(best.q[0], best.q[1]), k = (r + 4000)/r; return wc.blocked(best.q[0]*k/100, best.q[1]*k/100); })(),
  plazaOpen: !wc.blocked(3, 9),
  seaY: wc.sea && wc.sea.y, seaCm: CW.island.sea_cm, gets: calls.get.slice()};
// the opening bridges (games/hqbridges.js): the decks over the water are theirs; a closed one is walkable, an open one not
out.commons.bridges = (function(){
  var B = wc.bridges; if(!B) return null;
  var b = B.list()[0], mx = (b.a.x + b.b.x)/2, mz = (b.a.z + b.b.z)/2, open0 = !wc.blocked(mx, mz);
  var ship = {x: mx - b.left[0]*30, z: mz - b.left[1]*30, yaw: Math.atan2(b.left[0], b.left[1]), speed: 0};
  for(var i = 0; i < 20*30; i++) B.update(1/30, [ship]);
  var shut = wc.blocked(mx, mz);
  for(var j = 0; j < 30*30; j++) B.update(1/30, []);
  return {n: B.list().length, gap: wbOpts[0].gap, walkClosed: open0, blockedOpen: shut, walkAgain: !wc.blocked(mx, mz)};
})();
ISLES = false; out.commons.netOld = wc.net; ISLES = true;
// the town hall's door: the Town Hall panel for the Commons, no owner controls
wc.townHall(); out.commons.townHall = calls.townHall.slice();
// stepping ashore from a boat at a berth lands on the dock, on land
var berth = wc.sea.docks[0], land = wc.boatLand({x: berth.x, z: berth.z, yaw: berth.yaw});
// out in the open sea (100 m past the coast vertex farthest from every dock), its bow out to sea: no land in reach
var openSea = (function(){ var I = CW.island, docks = CW.sites.filter(s => s.kind === "dock" || s.kind === "port"), best = null;
  I.coast.forEach(function(q){ var d = Math.min.apply(null, docks.map(s => Math.hypot(q[0] - s.x, q[1] - s.z))); if(!best || d > best.d) best = {q: q, d: d}; });
  var r = Math.hypot(best.q[0], best.q[1]), k = (r + 10000)/r; return {x: best.q[0]*k/100, z: best.q[1]*k/100, yaw: Math.atan2(best.q[0], best.q[1])}; })();
out.commons.ashore = land && [wc.sea.land(land.x, land.z), wc.boatLand(openSea) == null];

/* ---------- the pier: walked on at its deck, the boats moored in sight beside it ---------- */
(function(){
  var site = CW.sites.filter(s => s.id === berth.id)[0], P = HQV.hqCivic.pierOf(site)[0], dx = P.dir[0], dz = P.dir[1];
  var len = (P.head[0] - P.poly[0][0])*dx + (P.head[1] - P.poly[0][1])*dz, walk = [];
  // from its land end (the ferry office stands across it: you come on round its side) out to its head, down the middle
  for(var a = 0.5; a <= len - 0.3; a += 1){ var x = P.head[0] - dx*(len - a), z = P.head[1] - dz*(len - a); walk.push([wc.blocked(x, z), wc.groundY(x, z)]); }
  var onPier = walk, ax = P.head[0] - dx*(len - 1), az = P.head[1] - dz*(len - 1);
  out.pier = {deckY: P.y, siteY: site.y/100, seaY: wc.sea.y, walkBlocked: walk.filter(q => q[0]).length, deckYs: onPier.map(q => q[1]),
    besideBlocked: [1, -1].map(sg => wc.blocked(P.head[0] - dx*3 + dz*(P.w/2 + 1.5)*sg, P.head[1] - dz*3 - dx*(P.w/2 + 1.5)*sg)),
    landY: land && wc.groundY(land.x, land.z), berthOnDeck: HQV.hqCivic.deckAt([P], berth.x, berth.z),
    // the way on: off the paving beside the land end
    access: [1, -1].map(sg => wc.blocked(ax + dz*(P.w/2 + 1)*sg, az - dx*(P.w/2 + 1)*sg))};
  // the boats at this berth: none under the deck, clear of it beam and all, each in reach (4 m) of its edge
  var V = HQV.hqboat.VEHICLES;
  out.pier.boats = wc.bikes.filter(b => /^boat:/.test(b.id || "") && b.id.indexOf(berth.id + ":") === 5).map(function(b){
    var rx = b.x - P.head[0], rz = b.z - P.head[1], along = rx*dx + rz*dz, side = Math.abs(rx*dz - rz*dx);
    return {kind: b.kind, under: HQV.hqCivic.deckAt([P], b.x, b.z) != null, clear: side - V[b.kind].beam/2 - P.w/2,
      reach: Math.hypot(side - (P.w/2 - 0.3), Math.max(0, along)), alongside: along < 0 && along > -len, y: b.g.position.y,
      river: HQV.world.riverAt(CW, b.x, b.z), riverY: HQV.ocean.RIVER_Y};
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
  return {full: full.length, ds: full, farthest: full.length ? Math.max.apply(null, full) : 0, lod: lod, props: props};
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
  var sim = wc.npcSim(); if(!sim){ out.talk = {seen: 0}; return; }
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

/* ---------- navigation: the minimap, the Go to panel (N), the route to the dock, arrival, the ferry ---------- */
(function(){
  var nv = wc.nav(), btns = root2d.children.filter(e => e.tagName === "button").map(e => e.textContent);
  out.nav = {mounted: [!!nv.minimap, !!nv.ui, !!nv.fx], minimapOn: !!nv.minimap && nv.minimap.el.parentNode === root2d,
             minimapPlaces: nv.minimap ? nv.minimap.layers().places : 0, goBtn: btns.filter(t => /Go to/.test(t)).length};
  // N (on the stage, not typing) opens the panel; while it is open nothing reaches the page or moves you
  avatar = {x: wc.spawn.x, z: wc.spawn.z};
  out.nav.nLeak = key(root2d, "KeyN", "n"); out.nav.nOpen = nv.ui.isOpen(); out.nav.holds = wc.menuOpen();
  out.nav.stageLeaks = [["KeyW", "w"], ["KeyW", "w", "keyup"], ["Digit2", "2"], ["KeyH", "h"], ["Space", " "]].map(k => key(root2d, k[0], k[1], k[2]));
  var q = nv.ui.root.all().filter(e => e.tagName === "input")[0];
  out.nav.typedLeaks = q ? [["KeyW", "w"], ["Digit3", "3"], ["KeyR", "r"]].map(k => key(q, k[0], k[1])) : null;
  key(root2d, "Escape", "Escape"); out.nav.escClosed = !nv.ui.isOpen(); out.nav.heldAfter = wc.menuOpen();
  out.nav.wFree = key(root2d, "KeyW", "w");              // closed: W is the page's again (hq3d's own onKey takes it there)
  // the places: the dock (its door on the land behind it) and the ferry to my island
  var P = nv.places(), dock = P.filter(p => p.kind === "dock")[0], ferry = P.filter(p => p.kind === "travel")[0];
  out.nav.kinds = P.map(p => p.kind).filter((k, i, a) => a.indexOf(k) === i).sort();
  out.nav.ferry = ferry ? [ferry.label, ferry.world] : null;
  out.nav.dockDoorLand = dock ? wc.sea.land(dock.door.x, dock.door.z) : null;
  // a route from spawn to the dock: on the roads, ending at its door
  nv.goTo({x: dock.door.x, z: dock.door.z, label: dock.label, kind: dock.kind});
  var r = wc.nav().route, R = r && r.R, n = R ? R.pts.length : 0;
  out.nav.route = R ? {len: R.len, straight: Math.hypot(dock.door.x - avatar.x, dock.door.z - avatar.z), mode: r.mode, steps: R.steps.length,
    end: [R.pts[n - 2] - dock.door.x, R.pts[n - 1] - dock.door.z], lastLeg: Math.hypot(R.pts[n - 2] - R.pts[n - 4], R.pts[n - 1] - R.pts[n - 3])} : null;
  frame(wc, avatar.x, avatar.z, 2);
  if(out.nav.route) out.nav.route.fx = nv.fx.state();
  var bn = nv.ui.root.all().filter(e => e.className === "hqnavui-banner")[0];
  out.nav.banner = bn ? !bn.hidden : null;
  // walk it: along the route to its end, and the card says you have arrived
  if(R){ for(var i = 0; i + 1 < n; i += 2){ avatar = {x: R.pts[i], z: R.pts[i + 1]}; frame(wc, avatar.x, avatar.z); } }
  var card = nv.ui.root.all().filter(e => e.className === "hqnavui-arrived")[0];
  out.nav.arrived = [wc.nav().route, card ? !card.hidden : null, bn ? bn.hidden : null];
  // the ferry: routed to the dock's land side; there the banner says to press E, and E opens the dock's menu
  nv.goTo({x: ferry.door.x, z: ferry.door.z, label: ferry.label, kind: ferry.kind});
  avatar = {x: ferry.door.x + 1, z: ferry.door.z}; frame(wc, avatar.x, avatar.z, 2);
  var hint = nv.ui.root.all().filter(e => e.className === "hqnavui-hint")[0];
  out.nav.ferryDone = [wc.nav().route && wc.nav().route.done, hint ? [hint.hidden, hint.textContent] : null];
  out.nav.ferryE = wc.use({x: avatar.x, z: avatar.z});
})();
await new Promise(r => setTimeout(r, 10));
(function(){
  // the dock's menu: its keys never reach the page; its digits and Esc still work
  var items = menuItems();
  out.nav.dockMenu = {open: wc.menuOpen(), items: items.length, routeCleared: wc.nav().route == null,
    leaks: [["KeyW", "w"], ["KeyW", "w", "keyup"], ["KeyC", "c"], ["Digit0", "0"], ["KeyH", "h"]].map(k => key(items[0] || root2d, k[0], k[1], k[2]))};
  key(items[0] || root2d, "Escape", "Escape"); out.nav.dockMenu.escClosed = !wc.menuOpen();
  out.nav.pageKeys = pageKeys.slice();
})();
/* the island's first tier: a road all the way to the dock (it stands inside the tier-1 ring) */
(function(){
  var G = HQV.hqnav.graph(IW, 1), dock = HQV.hqnav.places(IW, 1, {}).filter(p => p.kind === "dock")[0], sp = {x: 0, z: 10};
  var R = dock && HQV.hqnav.route(G, sp, dock.door, "walk"), n = R ? R.pts.length : 0;
  out.nav.island = R ? {len: R.len, straight: Math.hypot(dock.door.x - sp.x, dock.door.z - sp.z), firstLeg: Math.hypot(R.pts[2] - R.pts[0], R.pts[3] - R.pts[1]),
    lastLeg: Math.hypot(R.pts[n - 2] - R.pts[n - 4], R.pts[n - 1] - R.pts[n - 3]), land: HQV.ocean.seaOf(WD.docOf(IW), null, 1).land(dock.door.x, dock.door.z)} : null;
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
// the traffic stands on the roads and is solid (3.13.1): this counts what stays put, so it is left out here
var tSpec = HQV.traffic && HQV.traffic.SPEC; if(tSpec) HQV.traffic.SPEC = null;
out.roads.island = roadHits(function(x, z){ return wi.blocked(x, z); }, IW, 1);
if(tSpec) HQV.traffic.SPEC = tSpec;
out.pure.stats = [1, 3, 5].map(function(t){ var K = C3.cityStats(IW, t, {population: 120, grow: 400, treasury: 55, specialty: "fish"}); return [K.happiness, K.parts.map(p => p.key), K.homes, K.population, K.tierName]; });
out.pure.statsNone = C3.cityStats(null, 2, null);
out.pure.garages = IW.lots.filter(l => l.kind === "hq").concat(CW.lots.filter(l => l.kind === "hq").slice(0, 40)).map(function(l){
  var p = C3.placeLot(l); return [2, 0].map(function(wings){ var g = C3.garagePlace(l, p, wings); return g ? [g.s, +(Math.hypot(g.x, g.z)).toFixed(1)] : null; }); });
// every HQ lot's car-lift bay (an HQ with both wings, level 30+): the 8 m out of its door never runs into the HQ (a bay
// behind a wing once faced it, its gate against the wing's back wall)
out.pure.bays = (function(){
  var G = window.HQV.hqLotExtras.garage, keep = [[0, 0, 4.8, 3.8], [-10.5, 0.5, 3, 2.8], [10.5, 0.5, 3, 2.8]], n = 0, none = 0, into = 0, away = 0;
  IW.lots.concat(CW.lots).filter(l => l.kind === "hq").forEach(function(l){
    var g = C3.garagePlace(l, C3.placeLot(l), 2); n++; if(!g){ none++; return; } if(g.f === -1) away++;
    var a0 = g.f === -1 ? g.z - G.d/2 - 8 : g.z + G.d/2, a1 = a0 + 8;    // room to drive out and turn: 8 m
    if(keep.some(function(K){ return Math.abs(g.x - K[0]) < G.w/2 + K[2] && a1 > K[1] - K[3] && a0 < K[1] + K[3]; })) into++;
  });
  return {n: n, none: none, into: into, away: away};
})();
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
/* ---------- riding a cargo ship (the cruise ship's boarding, seat and going ashore) ---------- */
// (the voyage and ship modules load only here: with them the dock's ferry above sails instead of landing you at once)
for (const f of ["hqvoyage", "hqships"]) new Function(fs.readFileSync(root + "/games/" + f + ".js", "utf8"))();
var wv = city("user:" + ME + "@2", spawn);
await wv.whenReady; await new Promise(r => setTimeout(r, 10));
out.cargo = (function(){
  var wi = wv, S = wi.ships, sh = S && (S.state().ships || []).filter(s => s.kind === "cargo")[0];
  if(!sh) return null;
  var o = {boarded: S.board(sh.k, "cargo")};
  frame(wi, avatar.x, avatar.z, 2);
  var C = S.state().cruise, hud = root2d.all().filter(e => /hq3d-cruise/.test(e.className))[0];
  o.kind = C && [C.phase, C.kind, C.k === sh.k]; o.seat = !!wi.carry(); o.icon = hud ? hud.children[0].textContent : null;
  o.atSea = S.ashore() && !!S.state().cruise;             // at sea, E only says a word
  var u = S.until(sh.k, wi.world(), "cargo");
  if(u != null){
    S.skip(u + 20); frame(wi, avatar.x, avatar.z, 2);
    var n = calls.teleport.length; o.ashore = S.ashore(); o.landed = calls.teleport.length === n + 1 && !S.state().cruise && !wi.carry();
  }
  return o;
})();
wv.destroy(); delete HQV.hqVoyage; delete HQV.hqShips;
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
        # a fixed clock (NOW) in a fixed zone: the residents out at that hour are the same on every machine
        r = subprocess.run([NODE, "--input-type=module", "-e", src], capture_output=True, text=True, timeout=600,
                           env=dict(os.environ, TZ="UTC"))
        if r.returncode != 0:
            raise AssertionError("node failed:\n" + r.stderr[-4000:])
        cls.out = json.loads(r.stdout)

    def test_pure_helpers(self):
        p = self.out["pure"]
        self.assertEqual(p["owner"], [ME, "commons", "commons", "commons"])
        self.assertEqual(p["islandOf"], ["user:" + ME + "@3", None, None])           # live islands are @3 (3.15, D2)
        self.assertEqual(p["worldOk"], [True, True, True, True, False, False, False])  # claude-hq@3 is the live Commons
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

    def test_civic_buildings_stay_off_the_road(self):
        self.assertEqual(self.out["civicOnRoad"], [], "a civic building's wall stands on a road (world, site, tier, metres in)")

    def test_no_car_lift_bay_faces_into_its_hq(self):
        # a bay behind the tower faced it: its gate against the back wall, a bike brought up from B1 driven into the
        # building. Every bay's apron now runs clear of the HQ; where only the back has room, the bay faces away.
        b = self.out["pure"]["bays"]
        self.assertGreater(b["n"], 60)
        self.assertEqual(b["none"], 0)
        self.assertEqual(b["into"], 0)
        self.assertGreater(b["away"], 0)

    def test_every_island_hq_has_a_garage(self):
        # a v2 lot is narrower than an @1 lot: the garage finds a spot inside it, with or without the HQ's wings
        g = self.out["pure"]["garages"]
        self.assertGreater(len(g), 3)
        for both in g:
            for spot in both:
                self.assertIsNotNone(spot, "an HQ lot with no room for its garage")
                self.assertIn(spot[0], (1, -1))

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
        self.assertEqual(c["seaY"], c["seaCm"]/100, "the sea at the doc's sea level")
        self.assertIn("/api/arena/city/commons", c["gets"])
        self.assertIn("/api/arena/world/claude-hq@2/assign", c["gets"])
        self.assertEqual(c["townHall"], [["commons", False]])
        self.assertEqual(c["ashore"], [True, True])
        self.assertEqual(c["bridges"], {"n": 4, "gap": True, "walkClosed": True, "blockedOpen": True, "walkAgain": True})

    def test_the_pier(self):
        p = self.out["pier"]
        self.assertAlmostEqual(p["deckY"] - p["siteY"], 0.72, 6, "the deck: the dock's plinth and 0.6 m (hqcivic PIERS)")
        self.assertGreater(p["deckY"] - p["seaY"], 1.0, "the deck stands over the sea")
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
            # afloat: at sea level, or on the river's calm surface RIVER_Y over it
            # (3.2) moored at its draft below the water it floats on, as the boat physics floats it: no pop on boarding
            draft = {"rowboat": 0.12, "jetski": 0.08}[b["kind"]]
            self.assertAlmostEqual(b["y"], p["seaY"] + (b["riverY"] if b["river"] else 0) - draft, 6, b)

    def test_navigation_mounts(self):
        n = self.out["nav"]
        self.assertEqual(n["mounted"], [True, True, True], "minimap, Go to panel / banner, route chevrons")
        self.assertTrue(n["minimapOn"])
        self.assertGreater(n["minimapPlaces"], 5)
        self.assertEqual(n["goBtn"], 1, "a Go to button under the island / Commons button")
        for k in ("dock", "port", "travel", "townhall", "hq"):     # the Commons' HQs here are c0's and c1's
            self.assertIn(k, n["kinds"])
        self.assertEqual(n["ferry"], ["My island (ferry)", "user:" + ME + "@3"])     # live islands are @3 (3.15, D2)
        self.assertTrue(n["dockDoorLand"], "the dock's door (where a route ends) is on land")

    def test_go_to_panel_keys_do_not_leak(self):
        n = self.out["nav"]
        self.assertFalse(n["nLeak"]); self.assertTrue(n["nOpen"], "N opens the Go to panel")
        self.assertTrue(n["holds"], "hq3d stands still while the panel is open (w.menuOpen)")
        self.assertEqual(n["stageLeaks"], [False]*5, "W, 2, H, Space: not the page's shortcuts while the panel is open")
        self.assertEqual(n["typedLeaks"], [False]*3, "typed into the search box: never the page's")
        self.assertTrue(n["escClosed"]); self.assertFalse(n["heldAfter"])
        self.assertTrue(n["wFree"], "the panel closed, W goes on as before")

    def test_route_from_spawn_to_the_dock(self):
        n = self.out["nav"]
        r = n["route"]
        self.assertIsNotNone(r, "no route from spawn to the dock on the Commons")
        self.assertEqual(r["mode"], "walk")
        self.assertGreaterEqual(r["len"], r["straight"] - 1)
        self.assertLess(r["len"], r["straight"]*3, "along the roads, not round the island")
        self.assertLess(max(abs(r["end"][0]), abs(r["end"][1])), 1e-6, "it ends at the dock's door")
        self.assertLess(r["lastLeg"], 30, "the dock's quay street comes up to its door")
        self.assertGreaterEqual(r["steps"], 2)
        self.assertGreater(r["fx"]["count"], 0, "chevrons along it")
        self.assertTrue(r["fx"]["pillar"], "the pillar at the dock")
        self.assertTrue(n["banner"], "the route banner shows")
        self.assertEqual(n["arrived"], [None, True, True], "walked to its end: the route clears, the card shows, the banner hides")

    def test_the_ferry_and_its_dock_menu(self):
        n = self.out["nav"]
        self.assertEqual(n["ferryDone"], [True, [False, "Press F for the ferry"]])
        self.assertTrue(n["ferryE"], "E on the dock's land side opens its menu")
        m = n["dockMenu"]
        self.assertTrue(m["open"]); self.assertGreater(m["items"], 0)
        self.assertTrue(m["routeCleared"], "on the way: the route is done with")
        self.assertEqual(m["leaks"], [False]*5, "W (Workshop), C, 0, H: not the page's while a dock's menu is open")
        self.assertTrue(m["escClosed"])
        self.assertEqual(n["pageKeys"], ["KeyW"], "only the W pressed with nothing open reached the page")

    def test_route_to_the_dock_on_a_tier1_island(self):
        r = self.out["nav"]["island"]
        self.assertIsNotNone(r, "no road route to the dock on a tier-1 island")
        self.assertLess(r["lastLeg"], 30, "the dock stands inside the tier-1 ring, its quay street on a tier-1 road")
        self.assertLess(r["firstLeg"], 30)
        self.assertLess(r["len"], r["straight"]*3)
        self.assertTrue(r["land"])

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
        # back from the map: in full again, bar those in the hysteresis band (they wait until nearer)
        near = len([x for x in c["ds"] if x < 180 - HYST])
        self.assertEqual(d["back"]["full"], near)
        (self.assertEqual if near == c["full"] else self.assertGreater)(d["back"]["lod"]["shown"], c["lod"]["shown"])

    def test_a_bus_ride(self):
        b = self.out["bus"]
        self.assertTrue(b["used"])
        self.assertTrue(b["menu"])
        self.assertGreater(b["items"], 0)
        self.assertRegex(b["first"], r"^1\. Bus \d+ to .+ · in ")
        self.assertFalse(b["menuAfter"])
        self.assertIsNone(b["carryWaiting"], "waiting at the stop, you still walk")
        self.assertTrue(b["boarded"])
        self.assertEqual(b["fare"], [], "every ride is free (3.15, D4): no fare is posted")
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

    def test_ride_a_cargo_ship(self):
        o = self.out["cargo"]
        self.assertIsNotNone(o, "a cargo ship sails the archipelago")
        self.assertTrue(o["boarded"])
        self.assertEqual(o["kind"], ["aboard", "cargo", True])
        self.assertTrue(o["seat"], "a seat on the bridge wing (w.carry)")
        self.assertEqual(o["icon"], "📦")
        self.assertTrue(o["atSea"], "E at sea keeps you aboard")
        if "ashore" in o:
            self.assertTrue(o["ashore"])
            self.assertTrue(o["landed"], "at anchor off this city, E lands you at its port")

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
        self.assertEqual(i["buttonGo"], [["claude-hq@3", None]])     # the live Commons (an older Arena: the chain falls back to @2)
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
