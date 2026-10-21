/* Claude HQ: the civic and zone buildings of the Cities (HQV.hqCivic).
 *
 * One building per WorldDoc site (cities build spec: "Site kinds (civic)"), made from a kit of
 * parts: a footprint (the site's polygon, or its w/d), floors of lit windows, a roof, a sign, its
 * entrances and the details of its kind (the town hall's clock tower, the hospital's red cross and
 * ambulance bay, the fire station's engine bays and truck, a port's cranes and pier, a stadium's
 * bowl, an office district's towers and so on). How grand it is follows the city tier; the rest
 * (palette, roof, which side the wing goes, the company on the sign) comes from the site id, so
 * every client builds the same building.
 *
 *   build(c, site, opts) -> {g, doors, hits, glows, setNight(n), animate(t, dt, k), top, boxes, lod, tint, decks, kind, tier}
 *     c: the hq3d ctx (THREE, mat, emis, box, cyl, sph, canvasTex, glow, label, rng, hashStr, ...).
 *     site: {id, kind, tier, x, y, z (cm), poly: [[x, z], ...] (cm, CCW) | w, d (cm, world axes),
 *            front: [fx, fz] (Q16 unit vector the door faces), view?: "<tab>", name?}.
 *     opts: {tier (the city's tier now; default site.tier), night (default true)}.
 *     g stands at the footprint's middle (m), turned so its front (+z) faces site.front.
 *     doors: [{x, z, y (m, the world), kind, view?, front: Vector3, label, tip, live}]; every
 *       building has at least one. live doors (a site with a view, and the town hall's, kind
 *       "townhall") are the ones a click or a walk-in goes through; their meshes are in hits with
 *       userData.door. The rest are entrances for people and stops to wait at.
 *     glows: the lamp glows (sprites) a night shows. boxes: world AABBs of the masses (o: each mass turned).
 *     lod: the masses as turned boxes {x, z, w, d, rot, y0, y1} (world, m), tint: their colour: what
 *       the City draws far off, every building's boxes in one InstancedMesh. decks: pierOf(site)'s, for
 *       the City to walk on.
 *   Static parts are merged per material (HQV.hqMerge.mergeStatic, when it is loaded): a building
 *   costs under 40 draw calls, lit and at night.
 *   fit(poly) -> {cx, cz, w, d}: the largest centred axis-aligned rectangle found inside poly.
 *   pierOf(site) -> [{poly: [[x, z] x 4], y, head: [x, z], dir: [dx, dz], w}] (world, m): the pier a dock
 *     or a port lays out over the water (empty for any other kind): its deck (y: its top), the middle of
 *     its far end, the way it points (out to sea) and its width. games/ocean.js puts the berth off its head.
 *   deckAt(decks, x, z) -> the deck's top y under (x, z), or null.
 *   KINDS: every kind build() knows, with its sign name and default footprint.
 * Nothing touches THREE until build() is called; tests/test_hqcivic.py runs it under node against
 * the vendored three.js and a stub ctx.
 */
(function(){
"use strict";
var HQV = window.HQV = window.HQV || {};

var PI = Math.PI;
var Q16 = 65536;
var PLINTH = 0.12;          // the paved base every building stands on (m)
var DOOR_OUT = 1.2;         // a door's front: where you stand to go in, this far out of the wall (m)
var SETBACK = 4;            // a building's front wall stands this far behind the site's front edge (m)
// The pier a dock or a port runs out over the water, in its frame (+z out to sea): centred on x = 0,
// from z0 to z1, w wide, its deck's top y. BUILD lays it; pierOf() gives it to the City and the sea.
var PIERS = {
  dock: function(W, D){ return {z0: -D/2 + 6, z1: D/2 + 6, w: Math.min(W*0.5, 6), y: PLINTH + 0.6}; },
  port: function(W, D){ return {z0: D/2 - Math.min(16, D*0.3), z1: D/2 + 30, w: 10, y: PLINTH + 0.6}; }
};

// Window walls: one canvas texture per style, a cell per bay (u) and floor (v); emissiveMap is
// the windows lit at night. wall/win: paint; bay: [bay width, floor height] (m); fw/fh: window
// size in a cell; lit: the share of windows lit.
var STYLES = {
  glass:  {wall: "#4f6f8c", win: "#9cc0da", bay: [3, 3.6], fw: 0.9, fh: 0.78, lit: 0.55, glow: "#ffeac0"},
  office: {wall: "#c6cbd1", win: "#567791", bay: [3, 3.6], fw: 0.62, fh: 0.56, lit: 0.5, glow: "#fff1cf"},
  brick:  {wall: "#9a5a44", win: "#36434f", bay: [3, 3.4], fw: 0.42, fh: 0.52, lit: 0.45, glow: "#ffd9a0"},
  stone:  {wall: "#d8d0bf", win: "#3f4d5a", bay: [3.5, 4.2], fw: 0.36, fh: 0.6, lit: 0.5, glow: "#ffe3b0"},
  white:  {wall: "#eceff2", win: "#62829e", bay: [3, 3.6], fw: 0.56, fh: 0.5, lit: 0.6, glow: "#f4fbff"},
  plain:  {wall: "#b5b1a8", win: "#46505a", bay: [6, 4.5], fw: 0.3, fh: 0.22, lit: 0.35, glow: "#ffe0a8"},
  // the airport terminal's side halls: bands of glazing, every window lit (a terminal never sleeps)
  terminal: {wall: "#56708a", win: "#9cc0da", bay: [3, 3.6], fw: 0.96, fh: 0.62, lit: 1, glow: "#ffeac0"}
};
var TEX = {};               // style -> {map, emi}: shared by every building

// Every kind: its sign, the default footprint (m) when the site has none, the colour of its sign
// and label. The build functions are below (BUILD).
var KINDS = {
  townhall: {name: "Town Hall", size: [40, 30], col: 0xffb347},
  clinic: {name: "Clinic", size: [18, 14], col: 0x6fd38a},
  hospital: {name: "Hospital", size: [44, 34], col: 0xff5b5b},
  fire: {name: "Fire Station", size: [26, 20], col: 0xff6b5b},
  police: {name: "Police", size: [24, 18], col: 0x5f8fe6},
  school: {name: "School", size: [44, 34], col: 0xffb347},
  university: {name: "University", size: [60, 46], col: 0x9b8cf0},
  market: {name: "Market", size: [34, 26], col: 0x6fd38a},
  mall: {name: "Mall", size: [64, 48], col: 0x5fd3e6},
  bank: {name: "Bank", size: [24, 20], col: 0xe8c45a},
  library: {name: "Library", size: [28, 22], col: 0x9b8cf0},
  post: {name: "Post Office", size: [18, 14], col: 0xffb347},
  transit: {name: "Transit Hub", size: [50, 30], col: 0x5fd3e6},
  busstop: {name: "Bus", size: [6, 3], col: 0x5fd3e6},
  tramstop: {name: "Tram", size: [14, 4], col: 0x9b8cf0},
  port: {name: "Port", size: [80, 60], col: 0x5fd3e6},
  dock: {name: "Ferry", size: [14, 30], col: 0x5fd3e6},
  airport: {name: "Airport", size: [40, 160], col: 0x5fd3e6},
  power: {name: "Power Plant", size: [60, 44], col: 0xffb347},
  water: {name: "Water", size: [16, 16], col: 0x5fd3e6},
  stadium: {name: "Stadium", size: [110, 90], col: 0x6fd38a},
  office: {name: "Offices", size: [26, 24], col: 0x5fd3e6},
  campus: {name: "Campus", size: [70, 54], col: 0x6fd38a},
  studio: {name: "Studios", size: [70, 56], col: 0xffb347},
  finance: {name: "Finance", size: [28, 26], col: 0xe8c45a},
  biotech: {name: "Biotech", size: [44, 34], col: 0x6fd38a},
  media: {name: "Media", size: [28, 24], col: 0xe0559b},
  warehouse: {name: "Logistics", size: [48, 34], col: 0xffb347},
  farm: {name: "Farm", size: [60, 50], col: 0x6fd38a}
};
// Made-up names for the zone buildings' signs (picked by site id).
var FIRMS = ["Northwind", "Bluefin", "Lumen", "Quarry & Co", "Halcyon", "Brightline", "Copperleaf", "Orbitworks",
  "Tidewater", "Ironbark", "Saltmarsh", "Kestrel", "Meridian", "Foxglove", "Juniper", "Starling"];
var AWNINGS = [0xd94b4b, 0x3f8fd1, 0x3fa66a, 0xe0a33a, 0x8a5ad1];
// The per-id palette: a tint over the window walls (white leaves the style's paint as it is), the
// roof a flat roof gets when its kind does not choose one, and the frame colour of stop shelters.
var TINTS = [0xffffff, 0xf6ecdc, 0xe4edf6, 0xf2e2de, 0xe8f0e2];
var ROOFS = [0x56606b, 0x4a5560, 0x5f5a52, 0x3f4a56, 0x6a5a50];
var FRAMES = [0x3d4752, 0x2f5f4a, 0x5a3d4a, 0x6b6f75];

/* ---------- footprint ---------- */
// Point in polygon (P: [[x, z], ...]), even-odd.
function inPoly(P, x, z){
  var ins = false;
  for(var i = 0, j = P.length - 1; i < P.length; j = i++){
    var a = P[i], b = P[j];
    if((a[1] > z) !== (b[1] > z) && x < (b[0] - a[0])*(z - a[1])/(b[1] - a[1]) + a[0]) ins = !ins;
  }
  return ins;
}
// Do segments ab and pq cross (properly)?
function cross(a, b, p, q){
  function o(u, v, w){ return (v[0] - u[0])*(w[1] - u[1]) - (v[1] - u[1])*(w[0] - u[0]); }
  var d1 = o(p, q, a), d2 = o(p, q, b), d3 = o(a, b, p), d4 = o(a, b, q);
  return d1*d2 < 0 && d3*d4 < 0;
}
// Is the box x0..x1, z0..z1 inside P? (tested a hair inside its edges, so a box that is the
// polygon's own rectangle counts)
function rectIn(P, x0, x1, z0, z1){
  var e = 1e-7*(1 + Math.abs(x1 - x0) + Math.abs(z1 - z0)); x0 += e; x1 -= e; z0 += e; z1 -= e;
  var C = [[x0, z0], [x1, z0], [x1, z1], [x0, z1]], i, j;
  for(i = 0; i < 4; i++) if(!inPoly(P, C[i][0], C[i][1])) return false;
  for(i = 0; i < P.length; i++) for(j = 0; j < 4; j++) if(cross(P[i], P[(i + 1) % P.length], C[j], C[(j + 1) % 4])) return false;
  return true;
}
// A large axis-aligned rectangle inside P (any units, any winding): the bounds when they fit (a
// rectangular lot), else the best of boxes grown side by side from a 5 x 5 grid of seeds and the
// centroid. -> {cx, cz, w, d}
function fit(P){
  if(!P || P.length < 3) return {cx: 0, cz: 0, w: 0, d: 0};
  var x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, ax = 0, az = 0, A = 0, i, j;
  for(i = 0; i < P.length; i++){
    var p = P[i], q = P[(i + 1) % P.length], cr = p[0]*q[1] - q[0]*p[1];
    x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); z0 = Math.min(z0, p[1]); z1 = Math.max(z1, p[1]);
    A += cr; ax += (p[0] + q[0])*cr; az += (p[1] + q[1])*cr;
  }
  if(rectIn(P, x0, x1, z0, z1)) return {cx: (x0 + x1)/2, cz: (z0 + z1)/2, w: x1 - x0, d: z1 - z0};
  var seeds = [], step = Math.max(x1 - x0, z1 - z0)/48, best = {cx: (x0 + x1)/2, cz: (z0 + z1)/2, w: 0, d: 0};
  if(Math.abs(A) > 1e-9) seeds.push([ax/(3*A), az/(3*A)]);
  for(i = 1; i <= 5; i++) for(j = 1; j <= 5; j++) seeds.push([x0 + (x1 - x0)*i/6, z0 + (z1 - z0)*j/6]);
  seeds.forEach(function(sd){
    var b = [sd[0] - step/2, sd[0] + step/2, sd[1] - step/2, sd[1] + step/2];
    if(!rectIn(P, b[0], b[1], b[2], b[3])) return;
    // grow each side in turn while the box stays inside, then again in halving steps (a lot whose
    // corners were rounded to the cm is a hair off square, and its box should still fill it)
    for(var st = step; st > step/64; st /= 2) for(var grew = true; grew;){
      grew = false;
      for(var s = 0; s < 4; s++){
        var t = b.slice(); t[s] += s % 2 ? st : -st;
        if(rectIn(P, t[0], t[1], t[2], t[3])){ b = t; grew = true; }
      }
    }
    if((b[1] - b[0])*(b[3] - b[2]) > best.w*best.d) best = {cx: (b[0] + b[1])/2, cz: (b[2] + b[3])/2, w: b[1] - b[0], d: b[3] - b[2]};
  });
  return best;
}

// Where the building goes: {x, y, z (m, the footprint's middle), rot, w, d (m, local axes), poly (m, local)}.
function frame(site){
  var f = site.front || [0, Q16], fx = (+f[0] || 0)/Q16, fz = (+f[1] || 0)/Q16;
  if(!(Math.abs(fx) + Math.abs(fz) > 1e-6)){ fx = 0; fz = 1; }
  var rot = Math.atan2(fx, fz), cr = Math.cos(rot), sr = Math.sin(rot), y = (+site.y || 0)/100, K = KINDS[site.kind] || KINDS.office;
  if(site.poly && site.poly.length >= 3){
    var ox = 0, oz = 0;
    site.poly.forEach(function(p){ ox += p[0]/100; oz += p[1]/100; });
    ox /= site.poly.length; oz /= site.poly.length;
    // into the building's frame (+z = front): lx = dx cos - dz sin, lz = dx sin + dz cos
    var L = site.poly.map(function(p){ var dx = p[0]/100 - ox, dz = p[1]/100 - oz; return [dx*cr - dz*sr, dx*sr + dz*cr]; });
    var R = fit(L);
    if(R.w > 1 && R.d > 1){
      return {x: ox + R.cx*cr + R.cz*sr, y: y, z: oz - R.cx*sr + R.cz*cr, rot: rot, w: R.w, d: R.d,
              poly: L.map(function(p){ return [p[0] - R.cx, p[1] - R.cz]; })};
    }
  }
  var w = site.w > 0 ? site.w/100 : K.size[0], d = site.d > 0 ? site.d/100 : K.size[1];
  if(Math.abs(fx) > Math.abs(fz) && site.w > 0 && site.d > 0){ var t = w; w = d; d = t; }   // w/d are world axes
  return {x: (+site.x || 0)/100, y: y, z: (+site.z || 0)/100, rot: rot, w: w, d: d, poly: null};
}

function styleTex(c, name){
  if(TEX[name]) return TEX[name];
  var S = STYLES[name], N = 8, px = 64, R = c.rng(c.hashStr("hqcivic:" + name));
  var lit = [];
  for(var i = 0; i < N*N; i++) lit.push(R() < S.lit);
  function cell(g, ix, iy, col){
    var w = S.fw*px, h = S.fh*px;
    g.fillStyle = col; g.fillRect(ix*px + (px - w)/2, iy*px + (px - h)*0.4, w, h);
  }
  var map = c.canvasTex(N*px, N*px, function(g){
    g.fillStyle = S.wall; g.fillRect(0, 0, N*px, N*px);
    for(var iy = 0; iy < N; iy++){
      g.fillStyle = "rgba(0,0,0,.12)"; g.fillRect(0, iy*px + px - 3, N*px, 3);      // the floor slab line
      for(var ix = 0; ix < N; ix++) cell(g, ix, iy, S.win);
    }
  });
  var emi = c.canvasTex(N*px, N*px, function(g){
    g.fillStyle = "#000"; g.fillRect(0, 0, N*px, N*px);
    for(var iy = 0; iy < N; iy++) for(var ix = 0; ix < N; ix++) if(lit[iy*N + ix]) cell(g, ix, iy, S.glow);
  });
  [map.t, emi.t].forEach(function(t){ t.wrapS = t.wrapT = c.THREE.RepeatWrapping; });
  return (TEX[name] = {map: map.t, emi: emi.t});
}

// Four walls (no top or bottom) as quads with window UVs: u counts bays along the wall from u0, v floors.
function Walls(){ this.pos = []; this.nor = []; this.uv = []; this.idx = []; }
Walls.prototype.add = function(cx, cz, w, d, y0, h, bay, fh, u0, sides){
  var self = this;
  (sides || [[0, 1], [1, 0], [0, -1], [-1, 0]]).forEach(function(n){
    var nx = n[0], nz = n[1], len = nx ? d : w, mx = cx + nx*w/2, mz = cz + nz*d/2;
    var tx = nz, tz = -nx;                                  // up x n: to the right, seen from outside
    var lx = mx - tx*len/2, lz = mz - tz*len/2, rx = mx + tx*len/2, rz = mz + tz*len/2;
    var b = self.pos.length/3, u1 = u0 + len/bay, v1 = h/fh;
    self.pos.push(lx, y0, lz, rx, y0, rz, rx, y0 + h, rz, lx, y0 + h, lz);
    for(var i = 0; i < 4; i++) self.nor.push(nx, 0, nz);
    self.uv.push(u0, 0, u1, 0, u1, v1, u0, v1);
    self.idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  });
};
Walls.prototype.geometry = function(THREE){
  var g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(this.nor, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(this.uv, 2));
  g.setIndex(this.idx); g.computeBoundingSphere(); g.computeBoundingBox();
  return g;
};

/* ---------- the kit: what every kind builds with ---------- */
function Kit(c, site, opts){
  var THREE = c.THREE, F = frame(site), self = this;
  this.c = c; this.THREE = THREE; this.site = site; this.F = F;
  this.kind = KINDS[site.kind] ? site.kind : "office";
  this.K = KINDS[this.kind];
  var t = opts.tier != null ? opts.tier : site.tier;
  this.tier = Math.max(1, Math.min(5, (t | 0) || 1));
  this.R = c.rng(c.hashStr("hqcivic:" + (site.id != null ? site.id : "") + ":" + this.kind));
  this.W = F.w; this.D = F.d;
  this.g = new THREE.Group(); this.g.name = "civic:" + this.kind;
  this.g.position.set(F.x, F.y, F.z); this.g.rotation.y = F.rot;
  this.mats = {}; this.night = []; this.walls = {}; this.doors = []; this.hits = []; this.glows = [];
  this.anims = []; this.boxes = []; this.lod = []; this.top = 1; this.live = [];
  this.cr = Math.cos(F.rot); this.sr = Math.sin(F.rot);
  this.u0 = Math.floor(this.R()*8);
  this.firm = FIRMS[Math.floor(this.R()*FIRMS.length)];
  this.tint = this.pick(TINTS); this.roofCol = this.pick(ROOFS); this.frameCol = this.pick(FRAMES);
  this.title = site.name ? String(site.name) : this.K.name;
  if(site.view){ var vt = (c.api && c.api.viewTitle && c.api.viewTitle(site.view)) || []; if(vt[0]) this.title = vt[0]; this.viewTip = vt[1]; }
  this.hex = "#" + this.K.col.toString(16).padStart(6, "0");
  self.base();
}
var KP = Kit.prototype;
// the lot's local point (lx, lz) in the world (m)
KP.world = function(lx, lz){ return {x: this.F.x + lx*this.cr + lz*this.sr, z: this.F.z - lx*this.sr + lz*this.cr}; };
KP.r = function(a, b){ return a + (b - a)*this.R(); };
KP.pick = function(a){ return a[Math.floor(this.R()*a.length) % a.length]; };
// a material, one per (colour, options) in this building, so like parts merge
KP.m = function(col, o){
  var key = col + ":" + JSON.stringify(o || {});
  return this.mats[key] || (this.mats[key] = this.c.mat(col, o));
};
// a material that lights at night: emissive col2 at intensity day / night
KP.n = function(col, col2, day, night, o){
  var key = "n:" + col + ":" + col2 + ":" + day + ":" + night + ":" + JSON.stringify(o || {});
  if(this.mats[key]) return this.mats[key];
  var m = this.c.emis(col, col2, night, o); this.night.push({m: m, day: day, night: night});
  return (this.mats[key] = m);
};
KP.box = function(w, h, d, m, x, y, z, p){ return this.c.box(w, h, d, m, x, y, z, p || this.g); };
KP.cyl = function(rt, rb, h, m, x, y, z, seg, p){ return this.c.cyl(rt, rb, h, m, x, y, z, p || this.g, seg || 16); };
KP.sph = function(r, m, x, y, z, p){ return this.c.sph(r, m, x, y, z, p || this.g); };
KP.mesh = function(geo, m, x, y, z, p){
  var o = new this.THREE.Mesh(geo, m); o.position.set(x, y, z); o.castShadow = true; o.receiveShadow = true; (p || this.g).add(o); return o;
};
// the front edge of a d-deep thing set back from the site's front, kept inside the site
KP.back = function(d, set){ return Math.max(-this.D/2 + d/2, this.D/2 - (set != null ? set : SETBACK) - d/2); };
// note a mass for the camera boxes and the building's top
KP.note = function(cx, cz, w, d, y0, y1, noLod){
  var o = this.world(cx, cz);
  if(!noLod) this.lod.push({x: o.x, z: o.z, w: w, d: d, rot: this.F.rot, y0: this.F.y + y0, y1: this.F.y + y1});
  var a = this.world(cx - w/2, cz - d/2), b = this.world(cx + w/2, cz + d/2), e = this.world(cx - w/2, cz + d/2), f = this.world(cx + w/2, cz - d/2), Y = this.F.y;
  this.boxes.push({min: {x: Math.min(a.x, b.x, e.x, f.x), y: Y + y0, z: Math.min(a.z, b.z, e.z, f.z)},
                   max: {x: Math.max(a.x, b.x, e.x, f.x), y: Y + y1, z: Math.max(a.z, b.z, e.z, f.z)},
                   o: {x: o.x, z: o.z, hw: w/2, hd: d/2, rot: this.F.rot, y0: y0}});   // the mass itself, turned (what blocks you)
  this.top = Math.max(this.top, y1);
};

// The paved base: the site's polygon (or its rectangle), a hand's breadth thick.
KP.base = function(){
  var THREE = this.THREE, pave = this.m(0x8d969e, {roughness: 0.92});
  if(this.F.poly){
    var sh = new THREE.Shape();
    this.F.poly.forEach(function(p, i){ if(i) sh.lineTo(p[0], -p[1]); else sh.moveTo(p[0], -p[1]); });
    var geo = new THREE.ExtrudeGeometry(sh, {depth: PLINTH, bevelEnabled: false});
    geo.rotateX(-PI/2);                                    // (x, y, z) -> (x, z, -y): the shape lies flat, PLINTH up
    var o = this.mesh(geo, pave, 0, 0, 0); o.castShadow = false;
  } else {
    this.box(this.W, PLINTH, this.D, pave, 0, PLINTH/2, 0).castShadow = false;
  }
};
// floors of lit windows in a style, with a flat roof (o.roof false: none, the caller roofs it)
// -> {x, z, w, d, y0, top (the roof's top)}
KP.mass = function(style, cx, cz, w, d, floors, o){
  o = o || {};
  var S = STYLES[style] || STYLES.office, fh = o.fh || S.bay[1], y0 = o.y0 != null ? o.y0 : PLINTH, h = Math.max(1, floors)*fh;
  var W = this.walls[style] || (this.walls[style] = new Walls());
  W.add(cx, cz, w, d, y0, h, S.bay[0], fh, this.u0 + Math.floor(this.R()*8), o.sides);
  var top = y0 + h;
  if(o.roof !== false){
    this.box(w + 0.3, 0.4, d + 0.3, this.m(o.roofCol || this.roofCol, {roughness: 0.85}), cx, top + 0.2, cz);
    top += 0.4;
  }
  this.note(cx, cz, w, d, y0, top);
  return {x: cx, z: cz, w: w, d: d, y0: y0, top: top};
};
// a pitched roof over w x d at height y: ridge along x (alongZ: along z), rise high
KP.gable = function(cx, cz, w, d, y, rise, m, alongZ){
  var THREE = this.THREE, span = alongZ ? w : d, len = alongZ ? d : w;
  var sh = new THREE.Shape(); sh.moveTo(-span/2 - 0.3, 0); sh.lineTo(span/2 + 0.3, 0); sh.lineTo(0, rise); sh.lineTo(-span/2 - 0.3, 0);
  var geo = new THREE.ExtrudeGeometry(sh, {depth: len + 0.4, bevelEnabled: false});
  geo.translate(0, 0, -(len + 0.4)/2);
  if(!alongZ) geo.rotateY(PI/2);
  this.note(cx, cz, w, d, y, y + rise);
  return this.mesh(geo, m, cx, y, cz);
};
// a hipped (four-sided) roof
KP.hip = function(cx, cz, w, d, y, rise, m){
  var geo = new this.THREE.ConeGeometry(Math.SQRT1_2, 1, 4, 1); geo.rotateY(PI/4); geo.translate(0, 0.5, 0);
  var o = this.mesh(geo, m, cx, y, cz); o.scale.set(w + 0.4, rise, d + 0.4);
  this.note(cx, cz, w, d, y, y + rise);
  return o;
};
// a half cylinder, flat side down, its axis along x (alongZ: along z)
KP.barrel = function(cx, cz, len, r, y, m, alongZ){
  var geo = new this.THREE.CylinderGeometry(r, r, len, 18, 1, false, 0, PI); geo.rotateZ(PI/2);
  if(alongZ) geo.rotateY(PI/2);
  this.note(cx, cz, alongZ ? 2*r : len, alongZ ? len : 2*r, y, y + r);
  return this.mesh(geo, m, cx, y, cz);
};
KP.dome = function(r, x, y, z, m){
  this.note(x, z, 2*r, 2*r, y, y + r);
  return this.mesh(new this.THREE.SphereGeometry(r, 20, 10, 0, 2*PI, 0, PI/2), m, x, y, z);
};
// a row of n columns from x0 to x1 at z, standing on y0, h tall
KP.columns = function(n, x0, x1, z, y0, h, r, m){
  for(var i = 0; i < n; i++){ var x = n > 1 ? x0 + (x1 - x0)*i/(n - 1) : (x0 + x1)/2; this.cyl(r, r*1.1, h, m, x, y0 + h/2, z, 12); }
};
// n steps up to height top, the lowest at front edge z, each run deep
KP.steps = function(cx, z, w, n, top, run, m){
  for(var i = 0; i < n; i++){ var h = top*(i + 1)/n, dd = run*(n - i); this.box(w, h, dd, m, cx, h/2, z - dd/2); }
};
KP.tree = function(x, z, s){
  s = s || 1;
  this.cyl(0.18*s, 0.25*s, 1.6*s, this.m(0x5a3d2a, {roughness: 0.9}), x, PLINTH + 0.8*s, z, 6);
  this.sph(1.5*s, this.m(0x3c8a4f, {roughness: 0.9}), x, PLINTH + 2.6*s, z);
};
// a lamp post with a head lit at night and its glow (glow: false for none)
KP.lamp = function(x, z, h, col, glow){
  h = h || 4; col = col || 0xffd9a0;
  this.cyl(0.07, 0.09, h, this.m(0x2b3440, {metalness: 0.6, roughness: 0.4}), x, PLINTH + h/2, z, 8);
  this.box(0.5, 0.18, 0.5, this.n(0xf6efe0, col, 0.15, 2), x, PLINTH + h + 0.09, z);
  if(glow !== false) this.glow(col, x, PLINTH + h, z, 2.4, 0.6);
};
KP.glow = function(col, x, y, z, s, op){ var gl = this.c.glow(col, s, op); gl.position.set(x, y, z); this.g.add(gl); this.glows.push(gl); return gl; };
KP.fence = function(x0, z0, x1, z1, h){
  h = h || 1.4; var m = this.m(0x6f7b86, {metalness: 0.5, roughness: 0.5}), y = PLINTH;
  var sides = [[x0, z0, x1, z0], [x1, z0, x1, z1], [x1, z1, x0, z1], [x0, z1, x0, z0]], self = this;
  sides.forEach(function(s){
    var len = Math.hypot(s[2] - s[0], s[3] - s[1]), along = s[1] === s[3];
    self.box(along ? len : 0.06, 0.06, along ? 0.06 : len, m, (s[0] + s[2])/2, y + h, (s[1] + s[3])/2);
    self.box(along ? len : 0.06, 0.06, along ? 0.06 : len, m, (s[0] + s[2])/2, y + h*0.45, (s[1] + s[3])/2);
    var n = Math.max(1, Math.round(len/4));
    for(var i = 0; i <= n; i++) self.box(0.08, h, 0.08, m, s[0] + (s[2] - s[0])*i/n, y + h/2, s[1] + (s[3] - s[1])*i/n);
  });
};
// a flat sign (canvas text) facing rot (0: +z), its middle at (x, y, z)
KP.sign = function(text, w, h, x, y, z, rot, fg, bg){
  var c = this.c, THREE = this.THREE, s = c.short(String(text).toUpperCase(), 18);
  var T = c.canvasTex(512, 128, function(g){
    g.fillStyle = bg || "#0b1622"; g.fillRect(0, 0, 512, 128);
    g.fillStyle = fg || "#e9eff3"; g.font = "700 64px system-ui, sans-serif"; g.textAlign = "center"; g.textBaseline = "middle";
    g.fillText(s, 256, 68);
  });
  var o = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({map: T.t, toneMapped: false}));
  o.position.set(x, y, z); o.rotation.y = rot || 0; this.g.add(o);
  if(!this.signMesh) this.signMesh = o;                     // the first sign is the name: a live door's hit too
  return o;
};
// A door at (lx, lz) on a wall facing rot (0: +z): its leaves and lit frame, and its entry in
// doors. o: {w, h, rot, kind, main (the front door: live when the site has a view, or it is the
// town hall's), noMesh}.
KP.door = function(lx, lz, o){
  o = o || {};
  var THREE = this.THREE, w = o.w || 2.4, h = o.h || 3, rot = o.rot || 0, sr = Math.sin(rot), crt = Math.cos(rot);
  var fx = lx + sr*DOOR_OUT, fz = lz + crt*DOOR_OUT, wp = this.world(fx, fz), Y = this.F.y + PLINTH;
  var kind = o.kind || this.kind, live = !!o.main && (!!this.site.view || kind === "townhall");
  var view = live && this.site.view ? String(this.site.view) : null;
  var d = {x: wp.x, z: wp.z, y: Y, kind: kind, front: new THREE.Vector3(wp.x, Y, wp.z), label: this.title, live: live};
  if(view) d.view = view;
  d.tip = this.title + (live ? (this.viewTip ? ": " + this.viewTip : kind === "townhall" && !view ? ": open the town hall" : ": go in") : "");
  if(!o.noMesh){
    var leaf = this.box(w, h, 0.14, live ? this.n(0x0b1622, this.K.col, 0.2, 0.5) : this.m(0x26303a, {roughness: 0.4, metalness: 0.3}),
      lx + sr*0.08, PLINTH + h/2, lz + crt*0.08);
    leaf.rotation.y = rot;
    var fr = this.box(w + 0.3, 0.14, 0.18, this.n(0x1b2530, 0xfff1d6, 0.1, 1.6), lx + sr*0.1, PLINTH + h + 0.07, lz + crt*0.1);
    fr.rotation.y = rot;
    if(live){ leaf.userData.door = d; this.hits.push(leaf); this.live.push(d); }
  } else if(live) this.live.push(d);
  this.doors.push(d);
  return d;
};

/* ---------- props ---------- */
function wheels(k, m, pts, r, p){
  pts.forEach(function(q){ var w = k.cyl(r, r, 0.3, m, q[0], r, q[1], 12, p); w.rotation.z = PI/2; });
}
// a vehicle prop on the ground: a body, a cab, wheels; nose to +z, then turned rot about (x, z)
KP.vehicle = function(type, x, z, rot){
  var THREE = this.THREE, p = new THREE.Group(); p.position.set(x, PLINTH, z); p.rotation.y = rot || 0; this.g.add(p);
  var tyre = this.m(0x1d2126, {roughness: 0.9}), glass = this.m(0x22323f, {roughness: 0.2, metalness: 0.4});
  if(type === "fire"){
    var red = this.m(0xc8282a, {roughness: 0.45, metalness: 0.2}), steel = this.m(0xc4ccd4, {metalness: 0.8, roughness: 0.3});
    this.box(2.5, 2.2, 7.4, red, 0, 1.6, -0.6, p); this.box(2.5, 2.6, 2.2, red, 0, 1.8, 3.6, p);
    this.box(2.3, 0.9, 0.08, glass, 0, 2.5, 4.72, p);
    this.box(0.5, 0.3, 6.4, steel, -0.5, 2.95, -0.8, p); this.box(0.5, 0.3, 6.4, steel, 0.5, 2.95, -0.8, p);   // the ladder's rails
    for(var i = 0; i < 9; i++) this.box(1.5, 0.08, 0.1, steel, 0, 3.0, -3.8 + i*0.75, p);
    this.box(1.8, 0.18, 0.3, this.n(0x400000, 0xff2a2a, 0.6, 2.4), 0, 3.2, 3.6, p);
    wheels(this, tyre, [[-1.2, 3.4], [1.2, 3.4], [-1.2, -1.6], [1.2, -1.6], [-1.2, -3.2], [1.2, -3.2]], 0.55, p);
  } else if(type === "ambulance"){
    var white = this.m(0xf2f4f6, {roughness: 0.5}), stripe = this.m(0xd23b3b, {roughness: 0.5});
    this.box(2.1, 2.3, 4.2, white, 0, 1.55, -0.5, p); this.box(2.1, 1.6, 1.6, white, 0, 1.2, 2.3, p);
    this.box(2.14, 0.3, 5.8, stripe, 0, 1.3, 0.3, p); this.box(1.9, 0.6, 0.06, glass, 0, 1.7, 3.12, p);
    this.box(1.4, 0.16, 0.3, this.n(0x10204a, 0x4f8cff, 0.6, 2.4), 0, 2.78, 1.4, p);
    wheels(this, tyre, [[-1.05, 2.0], [1.05, 2.0], [-1.05, -1.8], [1.05, -1.8]], 0.42, p);
  } else if(type === "police"){
    var w2 = this.m(0xf2f4f6, {roughness: 0.5}), blue = this.m(0x23408f, {roughness: 0.5});
    this.box(1.8, 0.7, 4.4, w2, 0, 0.75, 0, p); this.box(1.6, 0.6, 2.2, blue, 0, 1.4, -0.2, p);
    this.box(1.82, 0.2, 4.42, blue, 0, 0.8, 0, p); this.box(1.0, 0.14, 0.3, this.n(0x10204a, 0x4f8cff, 0.6, 2.4), 0, 1.78, -0.2, p);
    wheels(this, tyre, [[-0.9, 1.4], [0.9, 1.4], [-0.9, -1.4], [0.9, -1.4]], 0.34, p);
  } else if(type === "bus"){
    var bc = this.m(this.tier >= 3 ? 0x2f8f6a : 0xe0a33a, {roughness: 0.5});
    this.box(2.5, 2.9, 11, bc, 0, 1.85, 0, p); this.box(2.54, 0.9, 10.4, glass, 0, 2.4, 0, p);
    wheels(this, tyre, [[-1.25, 3.6], [1.25, 3.6], [-1.25, -3.4], [1.25, -3.4]], 0.5, p);
  } else if(type === "van"){
    var y = this.m(0xe8c23a, {roughness: 0.5});
    this.box(2.0, 2.2, 4.8, y, 0, 1.45, 0, p); this.box(1.8, 0.7, 0.06, glass, 0, 1.9, 2.42, p);
    wheels(this, tyre, [[-1, 1.6], [1, 1.6], [-1, -1.6], [1, -1.6]], 0.4, p);
  } else if(type === "trailer"){
    var tc = this.m(this.pick([0xd8dde2, 0x3f6fae, 0xb84a3a]), {roughness: 0.6});
    this.box(2.5, 2.9, 12, tc, 0, 2.6, 0, p); this.box(2.4, 2.4, 2.4, this.m(0x2e3a46, {roughness: 0.5}), 0, 1.9, 7.4, p);
    wheels(this, tyre, [[-1.2, -4.4], [1.2, -4.4], [-1.2, -3.2], [1.2, -3.2], [-1.2, 7.2], [1.2, 7.2]], 0.5, p);
  } else if(type === "tractor"){
    var gr = this.m(0x3f9a4a, {roughness: 0.5});
    this.box(1.6, 1.2, 3, gr, 0, 1.3, 0, p); this.box(1.4, 1.4, 1.3, glass, 0, 2.4, -0.6, p);
    wheels(this, tyre, [[-0.95, -0.9], [0.95, -0.9]], 0.85, p);
    wheels(this, tyre, [[-0.85, 1.1], [0.85, 1.1]], 0.5, p);
  } else if(type === "plane"){
    var hull = this.m(0xeef1f4, {roughness: 0.4, metalness: 0.3}), tail = this.m(0x2f6fb8, {roughness: 0.5});
    var f = this.cyl(1.9, 1.9, 34, hull, 0, 3.2, 0, 16, p); f.rotation.x = PI/2;
    var nose = this.sph(1.9, hull, 0, 3.2, 17, p); nose.scale.set(1, 1, 1.6);
    var aft = this.cyl(1.9, 0.5, 6, hull, 0, 3.6, -20, 16, p); aft.rotation.x = -PI/2;
    this.box(34, 0.4, 5, hull, 0, 2.6, 0.5, p); this.box(12, 0.3, 2.6, hull, 0, 4.2, -21, p);
    this.box(0.4, 6, 4, tail, 0, 6.6, -21, p);
    [-7, 7].forEach(function(ex){ var e = this.cyl(1, 1, 3.6, this.m(0x9aa4ae, {metalness: 0.7, roughness: 0.3}), ex, 1.7, 1.8, 14, p); e.rotation.x = PI/2; }, this);
    wheels(this, tyre, [[0, 13], [-2.6, -1], [2.6, -1]], 0.6, p);
  }
  return p;
};
// shipping containers in stacks over the w x d yard at (cx, cz)
KP.containers = function(cx, cz, w, d, high){
  var cols = [0xb84a3a, 0x3f6fae, 0x3f9a6a, 0xd8a03a], mats = cols.map(function(c){ return this.m(c, {roughness: 0.7}); }, this);
  var nx = Math.max(1, Math.floor(w/3)), nz = Math.max(1, Math.floor(d/13));
  for(var ix = 0; ix < nx; ix++) for(var iz = 0; iz < nz; iz++){
    var h = 1 + Math.floor(this.R()*high);
    for(var l = 0; l < h; l++) this.box(2.4, 2.5, 12, mats[Math.floor(this.R()*4)], cx - w/2 + 1.5 + ix*3, PLINTH + 1.25 + l*2.55, cz - d/2 + 6.5 + iz*13);
  }
};
// a pier: a deck on piles, len along z from z0 to z1, w wide, standing at deck height y
KP.pier = function(cx, z0, z1, w, y){
  var len = Math.abs(z1 - z0), zc = (z0 + z1)/2, wood = this.m(0x8a6a4a, {roughness: 0.9}), pile = this.m(0x4e4034, {roughness: 0.9});
  this.box(w, 0.4, len, wood, cx, y - 0.2, zc);
  var o = this.world(cx, zc); this.lod.push({x: o.x, z: o.z, w: w, d: len, rot: this.F.rot, y0: this.F.y + y - 0.4, y1: this.F.y + y});   // the deck, far off
  var n = Math.max(2, Math.round(len/6));
  for(var i = 0; i <= n; i++){ var z = Math.min(z0, z1) + len*i/n;
    this.cyl(0.25, 0.25, y + 3, pile, cx - w/2 + 0.3, (y - 3)/2, z, 8); this.cyl(0.25, 0.25, y + 3, pile, cx + w/2 - 0.3, (y - 3)/2, z, 8); }
  var bol = this.m(0x2b3440, {metalness: 0.5, roughness: 0.5});
  for(i = 0; i < n; i++){ var bz = Math.min(z0, z1) + len*(i + 0.5)/n; this.cyl(0.18, 0.22, 0.6, bol, cx - w/2 + 0.4, y + 0.3, bz, 8); this.cyl(0.18, 0.22, 0.6, bol, cx + w/2 - 0.4, y + 0.3, bz, 8); }
};
// a gantry crane over the quay at (x, z), its boom out over the water (+z), h tall
KP.crane = function(x, z, h, col){
  var m = this.m(col, {roughness: 0.6, metalness: 0.3}), cab = this.m(0x2b3440, {roughness: 0.5}), s = 9;
  [[-s/2, -3], [s/2, -3], [-s/2, 3], [s/2, 3]].forEach(function(q){ this.box(0.7, h, 0.7, m, x + q[0], PLINTH + h/2, z + q[1]); }, this);
  this.box(s + 0.7, 0.8, 0.8, m, x, PLINTH + h*0.45, z - 3); this.box(s + 0.7, 0.8, 0.8, m, x, PLINTH + h*0.45, z + 3);
  this.box(1.4, 1.2, 34, m, x, PLINTH + h + 0.6, z + 6);                   // the boom, mostly out over the water
  this.box(s + 1, 1, 1.2, m, x, PLINTH + h, z - 3); this.box(s + 1, 1, 1.2, m, x, PLINTH + h, z + 3);
  this.box(2.2, 2, 2.6, cab, x, PLINTH + h - 1.2, z + 6);
  this.box(3, 2.2, 4, this.m(0x59636e, {roughness: 0.8}), x, PLINTH + h + 2.3, z - 10);   // the counterweight
  this.box(0.3, 0.3, 0.3, this.n(0x400000, 0xff3030, 0.3, 2.5), x, PLINTH + h + 1.4, z + 22.8);
  this.note(x, z + 6, s + 1, 36, 0, h + 3.4, true);              // a lattice: no solid box far off
};

/* ---------- the kinds ---------- */
var BUILD = {};

BUILD.townhall = function(k){
  var T = k.tier, stone = k.m(0xd8d0bf, {roughness: 0.75}), roof = k.m(0x4f6b5a, {roughness: 0.7});
  var bw = Math.min(k.W*0.8, 30 + T*4), wings = T >= 5 && k.W - bw >= 22, bd = Math.min(k.D*0.55, 22), fl = 2 + (T >= 3) + (T >= 5), zc = k.back(bd, 9);
  var M = k.mass("stone", 0, zc, bw, bd, fl, {roof: T < 4, roofCol: 0x6d6a63});
  if(T >= 4) k.hip(0, zc, bw, bd, M.top, 3.2, roof);
  if(wings){ [-1, 1].forEach(function(s){ k.mass("stone", s*(bw/2 + 5), zc - 2, 10, bd - 6, fl - 1, {roofCol: 0x6d6a63}); }); }
  // the portico: columns, the entablature and pediment over the steps
  var pz = zc + bd/2 + 2, pw = Math.min(bw*0.55, 18), ch = Math.min(M.top - 1.4, 9);
  k.columns(4 + 2*(T >= 3), -pw/2 + 0.6, pw/2 - 0.6, pz + 1.2, PLINTH + 0.9, ch - 0.9, 0.45, stone);
  k.box(pw + 0.6, 1.1, 4, stone, 0, PLINTH + ch + 0.55, pz);
  k.gable(0, pz, pw + 0.6, 4, PLINTH + ch + 1.1, 2.2, stone, true);
  k.steps(0, pz + 4, pw + 2, 4, 0.9, 0.7, stone);
  k.sign(k.title, pw*0.7, 0.9, 0, PLINTH + ch + 0.55, pz + 2.05, 0, "#3a2a10", "#efe2c4");
  // the clock tower, a clock face on each side, and its spire
  var tw = Math.max(3.4, Math.min(6, bw*0.16)), th = M.top + 6 + T*2, tz = zc - bd*0.1;
  k.box(tw, th, tw, stone, 0, th/2, tz); k.note(0, tz, tw, tw, 0, th);
  k.box(tw + 0.5, 0.5, tw + 0.5, stone, 0, th + 0.25, tz);
  var face = k.n(0xf3ead2, 0xfff1c8, 0.15, 1.6), hand = k.m(0x1b1f24, {roughness: 0.5});
  [0, PI/2, PI, -PI/2].forEach(function(a){
    var sx = Math.sin(a), sz = Math.cos(a), r = tw*0.36, f = k.cyl(r, r, 0.1, face, sx*(tw/2 + 0.05), th - 2.4, tz + sz*(tw/2 + 0.05), 24);
    f.rotation.set(PI/2, 0, 0); f.rotation.y = a; f.rotation.order = "YXZ";
    var h1 = k.box(0.12, r*0.7, 0.06, hand, sx*(tw/2 + 0.14), th - 2.4 + r*0.33, tz + sz*(tw/2 + 0.14)); h1.rotation.y = a;
    var h2 = k.box(r*0.5, 0.12, 0.06, hand, sx*(tw/2 + 0.14) + Math.cos(a)*r*0.24, th - 2.4, tz + sz*(tw/2 + 0.14) - Math.sin(a)*r*0.24); h2.rotation.y = a;
  });
  var sp = k.mesh(new k.THREE.ConeGeometry(tw*0.75, 4 + T, 4), roof, 0, th + 0.5 + (4 + T)/2, tz); sp.rotation.y = PI/4;
  k.top = Math.max(k.top, th + 4.5 + T);
  // flags and lamps out front
  var pole = k.m(0xc4ccd4, {metalness: 0.8, roughness: 0.3});
  [-1, 1].forEach(function(s){
    k.cyl(0.08, 0.1, 9, pole, s*(pw/2 + 3), PLINTH + 4.5, pz + 4.5, 8);
    k.box(0.05, 1.2, 1.9, k.m(s < 0 ? 0x2f6fb8 : 0xd94b4b, {roughness: 0.8}), s*(pw/2 + 3), PLINTH + 8.2, pz + 3.5);
    k.lamp(s*(pw/2 + 1.2), pz + 4.6, 4);
  });
  k.door(0, zc + bd/2, {w: 3, h: 3.6, kind: "townhall", main: true});
  if(T >= 2) k.door(-bw/2 + 3, zc + bd/2, {w: 1.6, h: 2.6, kind: "entrance"});
};

BUILD.clinic = function(k){
  var w = Math.min(k.W*0.85, 20), d = Math.min(k.D*0.75, 14), zc = k.back(d, 3), M = k.mass("white", 0, zc, w, d, 1 + (k.tier >= 3));
  var green = k.n(0x1f6b3a, 0x46e07a, 0.4, 2.2), y = M.top - 1.8;
  k.box(2.2, 0.7, 0.2, green, w/2 - 2.4, y, zc + d/2 + 0.12); k.box(0.7, 2.2, 0.2, green, w/2 - 2.4, y, zc + d/2 + 0.12);
  k.box(4, 0.25, 2.6, k.m(0xeceff2, {roughness: 0.6}), 0, PLINTH + 3.4, zc + d/2 + 1.3);                 // the canopy
  k.sign(k.title, 5, 0.9, -w/4, PLINTH + 3.1 + (k.tier >= 3 ? 3.6 : 0), zc + d/2 + 0.06, 0, "#1f6b3a", "#f2f7f3");
  k.tree(-w/2 + 1.5, k.D/2 - 1.5, 0.8); k.tree(w/2 - 1.5, k.D/2 - 1.5, 0.8);
  k.lamp(2.6, zc + d/2 + 2.6, 3.4);
  k.door(0, zc + d/2, {w: 2.2, main: true});
};

BUILD.hospital = function(k){
  var T = k.tier, w = Math.min(k.W*0.6, 34), d = Math.min(k.D*0.5, 22), fl = 3 + Math.floor(T*1.5), side = k.R() < 0.5 ? -1 : 1;
  var zc = k.back(d, 10), M = k.mass("white", 0, zc, w, d, fl);
  if(T >= 2){ var ww = Math.min((k.W - w)/2 - 1, 14); if(ww > 4) k.mass("white", side*(w/2 + ww/2), zc + 2, ww, d - 4, 2 + (T >= 4)); }
  // the red cross: on the facade and on a plate on the roof
  var red = k.n(0x8a1a1a, 0xff3b3b, 0.5, 2.4), cy = M.top - 2.6;
  k.box(3, 0.9, 0.2, red, 0, cy, zc + d/2 + 0.12); k.box(0.9, 3, 0.2, red, 0, cy, zc + d/2 + 0.12);
  k.box(5, 0.1, 5, k.m(0xf4f4f4, {roughness: 0.7}), -w/4, M.top + 0.05, zc);
  k.box(3.6, 0.12, 1.1, red, -w/4, M.top + 0.12, zc); k.box(1.1, 0.12, 3.6, red, -w/4, M.top + 0.12, zc);
  if(T >= 4){                                                         // the helipad
    k.cyl(4.2, 4.2, 0.2, k.m(0x3a434c, {roughness: 0.9}), w/4, M.top + 0.6, zc, 24);
    var hm = k.m(0xf4f4f4, {roughness: 0.7});
    k.box(0.4, 0.05, 3, hm, w/4 - 1, M.top + 0.72, zc); k.box(0.4, 0.05, 3, hm, w/4 + 1, M.top + 0.72, zc); k.box(2, 0.05, 0.4, hm, w/4, M.top + 0.72, zc);
    k.cyl(4.25, 4.25, 0.06, k.n(0x103020, 0x46e07a, 0.2, 1.6), w/4, M.top + 0.72, zc, 24);
    k.top = Math.max(k.top, M.top + 1);
  }
  // the ambulance bay: a canopy on posts at the other front corner, ambulances under it
  var bx = -side*(w/2 - 5), bz = zc + d/2 + 4.5, steel = k.m(0xb7c0c9, {metalness: 0.6, roughness: 0.4});
  k.box(10, 0.4, 8, k.m(0xeceff2, {roughness: 0.6}), bx, PLINTH + 4.6, bz);
  [[-4.6, -3.6], [4.6, -3.6], [-4.6, 3.6], [4.6, 3.6]].forEach(function(q){ k.cyl(0.15, 0.15, 4.4, steel, bx + q[0], PLINTH + 2.2, bz + q[1], 8); });
  k.sign("Emergency", 6, 0.8, bx, PLINTH + 5.3, bz + 4.05, 0, "#ffffff", "#c42a2a");
  k.vehicle("ambulance", bx - 2.2, bz + 0.4, PI); if(T >= 3) k.vehicle("ambulance", bx + 2.2, bz + 0.4, PI);
  k.door(bx, zc + d/2, {w: 3, kind: "emergency"});
  k.sign(k.title, Math.min(w*0.5, 12), 1.2, 0, M.top - 0.9, zc + d/2 + 0.06, 0, "#c42a2a", "#f4f6f8");
  k.door(side*w/6, zc + d/2, {w: 3, h: 3.2, main: true});
  k.lamp(side*w/6 + 3, zc + d/2 + 3, 4);
};

BUILD.fire = function(k){
  var T = k.tier, n = 2 + (T >= 3) + (T >= 5), bay = 4.6, w = Math.min(k.W*0.9, Math.max(n*bay + 7, 18)), d = Math.min(k.D*0.75, 18);
  var zc = k.back(d, 9), M = k.mass("brick", 0, zc, w, d, 2, {fh: 4});
  var dark = k.m(0x1a1f25, {roughness: 0.8}), frame = k.m(0xb72a2a, {roughness: 0.5}), roll = k.m(0xc9d1d9, {roughness: 0.5, metalness: 0.3});
  var x0 = -w/2 + 1.5 + bay/2, open = Math.floor(k.R()*n);
  for(var i = 0; i < n; i++){
    var x = x0 + i*bay;
    k.box(bay - 0.6, 4, 0.1, dark, x, PLINTH + 2, zc + d/2 + 0.02);                                // the bay
    k.box(bay - 0.2, 0.4, 0.3, frame, x, PLINTH + 4.2, zc + d/2 + 0.1);                             // its red lintel
    if(i !== open) k.box(bay - 0.7, 3.9, 0.14, roll, x, PLINTH + 1.95, zc + d/2 + 0.08);           // a closed door
    k.box(0.12, 0.02, 9, k.m(0xffd34a, {roughness: 0.6}), x - bay/2 + 0.3, PLINTH + 0.01, zc + d/2 + 4.5);   // the apron's lines
  }
  k.box(n*bay + 1, 0.04, 9, k.m(0x9ea5ac, {roughness: 0.9}), x0 + (n - 1)*bay/2, PLINTH, zc + d/2 + 4.5);
  k.vehicle("fire", x0 + open*bay, zc + d/2 + 1.2, 0);
  // the hose tower
  var tx = w/2 - 2.2, th = M.top + 6;
  k.box(3.4, th, 3.4, k.m(0x9a5a44, {roughness: 0.8}), tx, th/2, zc - d/2 + 2.2); k.note(tx, zc - d/2 + 2.2, 3.4, 3.4, 0, th);
  k.hip(tx, zc - d/2 + 2.2, 3.4, 3.4, th, 2, k.m(0x3a4552, {roughness: 0.7}));
  k.sign(k.title + " " + (1 + Math.floor(k.R()*20)), Math.min(w*0.6, 12), 1, x0 + (n - 1)*bay/2, PLINTH + 5.6, zc + d/2 + 0.06, 0, "#ffffff", "#9e1f1f");
  k.box(0.6, 0.6, 0.3, k.n(0x400000, 0xff2a2a, 0.4, 2.4), w/2 - 1.2, PLINTH + 3.6, zc + d/2 + 0.15);
  k.door(w/2 - 2, zc + d/2, {w: 1.6, h: 2.6, main: true});
};

BUILD.police = function(k){
  var T = k.tier, w = Math.min(k.W*0.8, 26), d = Math.min(k.D*0.65, 16), zc = k.back(d, 6);
  var M = k.mass("office", 0, zc, w, d, 2 + (T >= 3) + (T >= 5), {roofCol: 0x2c3b52});
  k.box(w + 0.32, 0.5, d + 0.32, k.m(0x23408f, {roughness: 0.5}), 0, PLINTH + 3.8, zc);                 // the blue band
  k.sign(k.title, Math.min(w*0.5, 9), 1, 0, PLINTH + 4.8, zc + d/2 + 0.18, 0, "#ffffff", "#23408f");
  // the blue lamps: a pair either side of the door, blinking in turn
  // (B's blue is one step off A's: KP.n shares a material per colour, and these two blink apart)
  var A = k.n(0x10204a, 0x3f7bff, 0.6, 2.6), B = k.n(0x10204a, 0x3f7cff, 0.6, 2.6), post = k.m(0x2b3440, {metalness: 0.6});
  [[-2.2, A], [2.2, B]].forEach(function(q){ k.cyl(0.08, 0.1, 2.8, post, q[0], PLINTH + 1.4, zc + d/2 + 1.6, 8); k.sph(0.32, q[1], q[0], PLINTH + 3, zc + d/2 + 1.6); });
  k.glow(0x3f7bff, -2.2, PLINTH + 3, zc + d/2 + 1.6, 2, 0.6); k.glow(0x3f7bff, 2.2, PLINTH + 3, zc + d/2 + 1.6, 2, 0.6);
  k.blink = [A, B];
  k.box(1.6, 0.3, 0.6, A, -w/4, M.top + 0.15, zc); k.box(1.6, 0.3, 0.6, B, w/4, M.top + 0.15, zc);
  var cars = 1 + (T >= 2) + (T >= 4);
  for(var i = 0; i < cars; i++) k.vehicle("police", -w/2 + 2 + i*3, Math.min(k.D/2 - 3, zc + d/2 + 4.5), 0);
  k.cyl(0.07, 0.09, 8, k.m(0xc4ccd4, {metalness: 0.8}), w/2 - 1.5, PLINTH + 4, zc + d/2 + 2, 8);
  k.box(0.05, 1, 1.6, k.m(0x2f6fb8, {roughness: 0.8}), w/2 - 1.5, PLINTH + 7.3, zc + d/2 + 1.1);
  k.door(0, zc + d/2, {w: 2.4, main: true});
};

BUILD.school = function(k){
  var T = k.tier, fl = 2 + (T >= 4), w = Math.min(k.W*0.9, 40), d = Math.min(k.D*0.3, 12), side = k.R() < 0.5 ? -1 : 1;
  var zc = -k.D/2 + d/2 + 1, M = k.mass("brick", 0, zc, w, d, fl);
  var ww = Math.min(10, k.W*0.25), wd = Math.max(2, Math.min(k.D*0.6, 22, k.D/2 - 1 - (zc + d/2)));   // kept inside the site
  k.mass("brick", side*(w/2 - ww/2), zc + d/2 + wd/2, ww, wd, fl - (T < 3));
  var gl = Math.min(12, k.D/2 - 1 - (zc + d/2));
  if(T >= 3 && gl >= 6) k.barrel(-side*(w/2 - 7), zc + d/2 + gl/2, gl, 5, PLINTH, k.m(0x7d8a96, {metalness: 0.4, roughness: 0.5}), true);   // the gym
  // the yard: asphalt, court lines, hoops, a fence
  var yx = -side*(ww/2), yw = Math.min(k.W - ww - 4, 28), yz = zc + d/2 + 2 + Math.min(k.D - d - 6, 18)/2, yd = Math.min(k.D - d - 6, 18);
  k.box(yw, 0.04, yd, k.m(0x4a525b, {roughness: 0.95}), yx, PLINTH + 0.02, yz);
  var line = k.m(0xf2f2f2, {roughness: 0.8}), lw = yw*0.6, ld = yd*0.7;
  [[lw, 0.12, 0, -ld/2], [lw, 0.12, 0, ld/2], [0.12, ld, -lw/2, 0], [0.12, ld, lw/2, 0], [lw, 0.12, 0, 0]].forEach(function(q){ k.box(q[0], 0.02, q[1], line, yx + q[2], PLINTH + 0.05, yz + q[3]); });
  var steel = k.m(0xc4ccd4, {metalness: 0.7, roughness: 0.3});
  [-1, 1].forEach(function(s){ k.cyl(0.08, 0.08, 3, steel, yx, PLINTH + 1.5, yz + s*(ld/2 + 0.6), 8); k.box(1.4, 1, 0.08, k.m(0xf4f4f4), yx, PLINTH + 3, yz + s*(ld/2 + 0.5)); });
  k.fence(yx - yw/2, yz - yd/2, yx + yw/2, yz + yd/2, 1.6);
  k.cyl(0.07, 0.09, 8, steel, side*(w/2 - ww - 2), PLINTH + 4, zc + d/2 + 1.5, 8);
  k.box(0.05, 1, 1.6, k.m(0x2f6fb8, {roughness: 0.8}), side*(w/2 - ww - 2), PLINTH + 7.3, zc + d/2 + 0.6);
  k.sign(k.title, Math.min(w*0.4, 10), 1, 0, M.top - 1, zc + d/2 + 0.06, 0, "#ffffff", "#7a3a2a");
  k.tree(-side*(w/2 - 2), k.D/2 - 2, 0.9);
  k.door(side*(w/2 - ww/2), zc + d/2 + wd, {w: 2.4, main: true});
};

BUILD.university = function(k){
  var T = k.tier, stone = k.m(0xd8d0bf, {roughness: 0.75}), w = Math.min(k.W*0.7, 44), d = Math.min(k.D*0.3, 16);
  var zc = -k.D/2 + d/2 + 1, fl = 3 + (T >= 4), M = k.mass("stone", 0, zc, w, d, fl, {roof: false});
  k.gable(0, zc, w, d, M.top, 4, k.m(0x4a4f5a, {roughness: 0.7}));
  // the wings, either side of the quad: as deep as the site leaves in front of the hall, the walk to its door clear
  var ww = Math.min(10, w/2 - 5), wd = Math.min(14, k.D/2 - 1 - (zc + d/2 + 2));
  if(T >= 3 && ww >= 3 && wd >= 4) [-1, 1].forEach(function(s){ k.mass("brick", s*(w/2 - ww/2), zc + d/2 + 2 + wd/2, ww, wd, fl - 1); });
  // the quad
  var qd = Math.min(k.D - d - 6, 22);
  k.box(Math.min(w - 22, 30), 0.06, qd, k.m(0x5a9a4f, {roughness: 0.95}), 0, PLINTH + 0.03, zc + d/2 + 2 + qd/2);
  for(var i = 0; i < 2 + T; i++) k.tree(-w/2 + 12 + (w - 24)*i/Math.max(1, 1 + T), zc + d/2 + 3 + qd*(i % 2 ? 0.85 : 0.15), 0.9);
  // the bell tower and spire
  var th = M.top + 8 + T*2;
  k.box(4.2, th, 4.2, stone, 0, th/2, zc - 1); k.note(0, zc - 1, 4.2, 4.2, 0, th);
  var sp = k.mesh(new k.THREE.ConeGeometry(3.1, 6, 4), k.m(0x4a4f5a, {roughness: 0.7}), 0, th + 3, zc - 1); sp.rotation.y = PI/4;
  k.box(1.8, 1.8, 0.1, k.n(0xf3ead2, 0xfff1c8, 0.15, 1.6), 0, th - 2.2, zc + 1.1);
  k.top = Math.max(k.top, th + 6);
  k.columns(4, -4, 4, zc + d/2 + 1, PLINTH, 6.5, 0.4, stone);
  k.box(10, 0.8, 2.6, stone, 0, PLINTH + 6.9, zc + d/2 + 1);
  k.sign(k.title, 8, 0.8, 0, PLINTH + 6.9, zc + d/2 + 2.35, 0, "#3a2a10", "#efe2c4");
  k.door(0, zc + d/2, {w: 3, h: 3.4, main: true});
};

BUILD.market = function(k){
  var T = k.tier, hw = Math.min(k.W*0.8, 28), hd = Math.min(k.D*0.6, 18), zc = k.back(hd, 5), h = 5 + (T >= 3);
  var steel = k.m(0x3d5566, {metalness: 0.6, roughness: 0.4}), wood = k.m(0x8a6a4a, {roughness: 0.85});
  var nx = Math.max(2, Math.round(hw/6)), nz = Math.max(2, Math.round(hd/6));
  for(var ix = 0; ix <= nx; ix++) for(var iz = 0; iz <= nz; iz++){
    if(ix && ix < nx && iz && iz < nz) continue;
    k.box(0.4, h, 0.4, steel, -hw/2 + hw*ix/nx, PLINTH + h/2, zc - hd/2 + hd*iz/nz);
    k.note(-hw/2 + hw*ix/nx, zc - hd/2 + hd*iz/nz, 0.4, 0.4, 0, PLINTH + h, true);   // a post blocks; the hall under the roof is open
  }
  k.gable(0, zc, hw, hd, PLINTH + h, 3 + T*0.4, k.m(0x6b8fa3, {roughness: 0.4, metalness: 0.4}), false);
  k.box(hw, 0.04, hd, k.m(0xa59a88, {roughness: 0.9}), 0, PLINTH + 0.02, zc);
  // the stalls: a table, crates and a striped awning each
  var stalls = 4 + T*2, awn = AWNINGS.map(function(c){ return k.m(c, {roughness: 0.8}); }), crate = k.m(0xb08a5a, {roughness: 0.9});
  var produce = [0xd94b4b, 0xe0a33a, 0x5aa04a].map(function(c){ return k.m(c, {roughness: 0.8}); });
  for(var i = 0; i < stalls; i++){
    var row = i % 2, j = i >> 1, per = Math.ceil(stalls/2), x = -hw/2 + 2.4 + (hw - 4.8)*(per > 1 ? j/(per - 1) : 0.5), z = zc + (row ? hd/2 - 2.6 : -hd/2 + 2.6);
    var face = row ? 1 : -1;
    k.box(2.6, 0.9, 1.2, wood, x, PLINTH + 0.45, z); k.note(x, z, 2.6, 1.2, 0, PLINTH + 1.1, true);   // the table blocks
    k.box(2.4, 0.2, 1, produce[i % 3], x, PLINTH + 1, z);
    k.box(0.8, 0.6, 0.8, crate, x + 1.6, PLINTH + 0.3, z - face*0.4);
    var a = k.box(2.9, 0.08, 1.6, awn[Math.floor(k.R()*awn.length)], x, PLINTH + 2.5, z + face*0.5); a.rotation.x = face*0.25;
    k.box(0.06, 2.5, 0.06, steel, x - 1.35, PLINTH + 1.25, z + face*1.15); k.box(0.06, 2.5, 0.06, steel, x + 1.35, PLINTH + 1.25, z + face*1.15);
  }
  k.sign(k.title, Math.min(hw*0.5, 10), 1.2, 0, PLINTH + h + 1, zc + hd/2 + 0.3, 0, "#ffffff", "#2f7d4a");
  k.lamp(-hw/2 - 1, zc + hd/2 + 1, 4); k.lamp(hw/2 + 1, zc + hd/2 + 1, 4, null, false);
  k.door(0, zc + hd/2, {w: 4, h: h - 0.5, main: true, noMesh: true});
};

BUILD.mall = function(k){
  var T = k.tier, w = Math.min(k.W*0.9, 70), d = Math.min(k.D*0.6, 40), zc = -k.D/2 + d/2 + 1, fl = 2 + (T >= 3) + (T >= 5);
  var M = k.mass("glass", 0, zc, w, d, fl, {fh: 4.5, roofCol: 0x6a737c});
  k.box(w + 0.4, 0.8, d + 0.4, k.n(0x0d1a24, 0x5fd3e6, 0.3, 1.4), 0, M.top - 0.6, zc);                  // the lit band
  var aw = Math.min(14, w*0.3);
  k.mass("glass", 0, zc + d/2 + 2, aw, 4, fl + 1, {fh: 4.5, roofCol: 0x6a737c});                       // the atrium
  k.box(aw + 4, 0.35, 4, k.m(0xeceff2, {roughness: 0.5}), 0, PLINTH + 4.2, zc + d/2 + 6);
  k.sign(k.title, Math.min(aw*0.9, 12), 1.8, 0, M.top + 1.6, zc + d/2 + 4.1, 0, "#ffffff", "#0e5f7a");
  // the rooftop plant and the car park in front
  for(var i = 0; i < 2 + T; i++) k.box(3, 1.6, 2.4, k.m(0x9aa4ae, {metalness: 0.5, roughness: 0.5}), -w/2 + 6 + i*((w - 12)/Math.max(1, 1 + T)), M.top + 0.8, zc - d/4);
  var pd = k.D/2 - (zc + d/2 + 8);
  if(pd > 6){
    var pz = zc + d/2 + 8 + pd/2, line = k.m(0xf2f2f2, {roughness: 0.8});
    k.box(w, 0.04, pd, k.m(0x3e454c, {roughness: 0.95}), 0, PLINTH + 0.02, pz);
    for(var x = -w/2 + 2; x <= w/2 - 2; x += 2.8){ if(Math.abs(x) < aw/2 + 2) continue; k.box(0.1, 0.02, Math.min(5, pd - 1), line, x, PLINTH + 0.05, pz); }
  }
  k.door(0, zc + d/2 + 4, {w: 4, h: 3.4, main: true});
  k.door(-w/2 + 4, zc + d/2, {w: 2.4, kind: "entrance"});
};

BUILD.bank = function(k){
  var T = k.tier, stone = k.m(0xe2dccd, {roughness: 0.7}), w = Math.min(k.W*0.85, 26), d = Math.min(k.D*0.6, 16), zc = k.back(d, 7);
  var M = k.mass("stone", 0, zc, w, d, 2 + (T >= 3) + (T >= 5), {roofCol: 0x8c8678});
  if(T >= 4) k.mass("glass", 0, zc - d/4, w*0.6, d*0.5, 4 + 2*T, {y0: M.top});
  var ch = Math.min(M.top - 1.2, 10), pz = zc + d/2 + 1.8, pw = Math.min(w*0.75, 16);
  k.columns(4 + 2*(T >= 3), -pw/2 + 0.6, pw/2 - 0.6, pz + 0.8, PLINTH + 0.8, ch - 0.8, 0.45, stone);
  k.box(pw + 0.6, 1, 3.6, stone, 0, PLINTH + ch + 0.5, pz);
  k.gable(0, pz, pw + 0.6, 3.6, PLINTH + ch + 1, 1.8, stone, true);
  k.steps(0, pz + 3.4, pw + 1.4, 4, 0.8, 0.6, stone);
  k.box(pw + 0.7, 0.18, 0.1, k.n(0x6a5420, 0xffd36a, 0.4, 1.8), 0, PLINTH + ch + 0.05, pz + 1.85);       // gilt trim
  k.sign(k.title, pw*0.6, 0.8, 0, PLINTH + ch + 0.5, pz + 1.85, 0, "#5a4410", "#f6e7b8");
  k.box(0.9, 1.6, 0.5, k.m(0x2b3440, {roughness: 0.5}), w/2 - 1.2, PLINTH + 0.8, zc + d/2 + 0.25);
  k.box(0.6, 0.4, 0.06, k.n(0x0d1a24, 0x5fd3e6, 0.5, 1.8), w/2 - 1.2, PLINTH + 1.2, zc + d/2 + 0.52);   // the cash machine
  k.lamp(-pw/2 - 1.5, pz + 3, 4); k.lamp(pw/2 + 1.5, pz + 3, 4, null, false);
  k.door(0, zc + d/2, {w: 2.6, h: 3.6, main: true});
};

BUILD.library = function(k){
  var T = k.tier, stone = k.m(0xd8d0bf, {roughness: 0.75}), w = Math.min(k.W*0.85, 30), d = Math.min(k.D*0.6, 16), zc = k.back(d, 6);
  var M = k.mass("stone", 0, zc, w, d, 2 + (T >= 4), {roofCol: 0x6d6a63});
  if(T >= 3){ k.cyl(4.2, 4.2, 2.6, stone, 0, M.top + 1.3, zc, 24); k.dome(4.4, 0, M.top + 2.6, zc, k.m(0x6f9a8a, {roughness: 0.5, metalness: 0.3})); }
  var ch = Math.min(M.top - 1.2, 7.5);
  k.columns(4, -4.2, 4.2, zc + d/2 + 1.4, PLINTH + 0.6, ch - 0.6, 0.38, stone);
  k.box(10, 0.9, 2.8, stone, 0, PLINTH + ch + 0.45, zc + d/2 + 1.4);
  k.sign(k.title, 7, 0.75, 0, PLINTH + ch + 0.45, zc + d/2 + 2.85, 0, "#2a2050", "#e9e3f6");
  k.steps(0, zc + d/2 + 4.6, 12, 3, 0.6, 0.6, stone);
  [-1, 1].forEach(function(s){ k.box(1.2, 1.2, 2, stone, s*7, PLINTH + 0.6, zc + d/2 + 3.4); k.sph(0.6, stone, s*7, PLINTH + 1.7, zc + d/2 + 3.4); });
  k.lamp(-8.6, zc + d/2 + 4, 4);
  k.door(0, zc + d/2, {w: 2.6, h: 3.4, main: true});
};

BUILD.post = function(k){
  var w = Math.min(k.W*0.85, 18), d = Math.min(k.D*0.7, 11), zc = k.back(d, 4);
  var M = k.mass("brick", 0, zc, w, d, 1 + (k.tier >= 3), {roof: false});
  k.gable(0, zc, w, d, M.top, 2.6, k.m(0x3a4552, {roughness: 0.7}));
  k.sign(k.title, Math.min(w*0.6, 9), 0.9, 0, M.top - 0.7, zc + d/2 + 0.06, 0, "#ffffff", "#c43a2a");
  var blue = k.m(0x2f5fb0, {roughness: 0.5}), red = k.m(0xc43a2a, {roughness: 0.5});
  [[-3.2, blue], [-2.2, red]].forEach(function(q){ k.box(0.7, 1.1, 0.6, q[1], q[0], PLINTH + 0.55, zc + d/2 + 1.6); k.cyl(0.35, 0.35, 0.6, q[1], q[0], PLINTH + 1.1, zc + d/2 + 1.6, 12).rotation.z = PI/2; });
  k.vehicle("van", w/2 - 2, Math.min(k.D/2 - 3, zc + d/2 + 3.5), PI/2);
  k.lamp(3.4, zc + d/2 + 1.8, 3.6);
  k.door(0, zc + d/2, {w: 2.2, main: true});
};

BUILD.transit = function(k){
  var T = k.tier, w = Math.min(k.W*0.75, 50), d = Math.min(k.D*0.45, 18), zc = k.back(d, 9);
  var M = k.mass("glass", 0, zc, w, d, 2, {fh: 4.2, roof: false});
  k.barrel(0, zc, w + 0.6, d/2 + 0.3, M.top, k.m(0x8fa9bc, {roughness: 0.3, metalness: 0.5}));
  k.box(w + 0.6, 0.5, d + 0.6, k.m(0x3d5566, {metalness: 0.5}), 0, M.top + 0.25, zc);
  k.cyl(1.3, 1.3, 0.2, k.n(0xf3ead2, 0xfff1c8, 0.15, 1.6), 0, M.top - 1.4, zc + d/2 + 0.2, 24).rotation.x = PI/2;
  k.sign(k.title, Math.min(w*0.4, 14), 1.2, 0, PLINTH + 5.4, zc + d/2 + 0.06, 0, "#ffffff", "#0e5f7a");
  // the platform canopies behind, the bus bays in front
  var steel = k.m(0x3d5566, {metalness: 0.6, roughness: 0.4}), roofM = k.m(0xd8dde2, {roughness: 0.5}), np = 2 + (T >= 3) + (T >= 5);
  var pzl = zc - d/2 - 3, room = pzl + k.D/2;
  for(var i = 0; i < np && room > 4; i++){
    var pz = pzl - i*Math.min(5, room/np);
    k.box(w*0.9, 0.9, 2.6, k.m(0xb5b1a8, {roughness: 0.9}), 0, PLINTH + 0.45, pz);
    k.box(w*0.85, 0.2, 3.2, roofM, 0, PLINTH + 4, pz);
    for(var x = -w*0.4; x <= w*0.4; x += w*0.2) k.cyl(0.12, 0.12, 3, steel, x, PLINTH + 2.5, pz, 8);
  }
  var bz = zc + d/2 + 4.5;
  k.box(Math.min(w, 30), 0.2, 1.8, k.m(0xb5b1a8, {roughness: 0.9}), 0, PLINTH + 0.1, bz);
  if(T >= 2) k.vehicle("bus", -6, bz + 3, PI/2);
  k.lamp(-w/2 + 2, bz, 5); k.lamp(w/2 - 2, bz, 5, null, false);
  k.door(0, zc + d/2, {w: 4, h: 3.6, main: true});
};

function shelter(k, x, z, len, label){
  var steel = k.m(k.frameCol, {metalness: 0.6, roughness: 0.4}), panel = k.m(0x5a7387, {roughness: 0.2, metalness: 0.4});
  k.box(len, 0.15, 1.8, k.m(0xd8dde2, {roughness: 0.5}), x, PLINTH + 2.6, z);
  k.box(len - 0.2, 2.2, 0.06, panel, x, PLINTH + 1.3, z - 0.8);
  k.box(0.06, 2.2, 1.4, panel, x - len/2 + 0.1, PLINTH + 1.3, z - 0.1);
  [-1, 1].forEach(function(s){ k.box(0.1, 2.6, 0.1, steel, x + s*(len/2 - 0.1), PLINTH + 1.3, z - 0.8); k.box(0.1, 2.6, 0.1, steel, x + s*(len/2 - 0.1), PLINTH + 1.3, z + 0.8); });
  k.box(len*0.6, 0.08, 0.45, k.m(0x8a6a4a, {roughness: 0.85}), x, PLINTH + 0.5, z - 0.5);
  k.box(0.06, 1.5, 1, k.n(0x0d1a24, 0xf4fbff, 0.3, 1.4), x + len/2 - 0.12, PLINTH + 1.3, z - 0.1);   // the lit timetable
  k.cyl(0.05, 0.05, 2.8, steel, x + len/2 + 0.5, PLINTH + 1.4, z + 0.7, 8);
  k.sign(label, 0.9, 0.5, x + len/2 + 0.5, PLINTH + 2.6, z + 0.75, 0, "#ffffff", k.hex);
  k.note(x, z, len, 1.8, 0, 2.8);
}
BUILD.busstop = function(k){
  var len = Math.max(2.4, Math.min(k.W - 1.4, 4 + k.tier*0.5));
  shelter(k, -0.4, -k.D/2 + 1, len, "Bus");
  k.box(Math.min(k.W, len + 2), 0.15, 0.3, k.m(0xb5b1a8, {roughness: 0.9}), 0, PLINTH + 0.07, k.D/2 - 0.15);   // the kerb
  k.door(0, k.D/2 - 0.6 - DOOR_OUT, {kind: "busstop", main: true, noMesh: true});
};
BUILD.tramstop = function(k){
  var len = Math.max(4, Math.min(k.W - 1, 8 + k.tier*2)), ph = 0.35;
  k.box(Math.min(k.W, len + 2), ph, k.D, k.m(0xa7adb3, {roughness: 0.9}), 0, ph/2, 0);
  k.box(Math.min(k.W, len + 2), 0.02, 0.4, k.m(0xffd34a, {roughness: 0.6}), 0, ph + 0.01, k.D/2 - 0.3);    // the tactile edge
  var g = new k.THREE.Group(); g.position.y = ph - PLINTH; k.g.add(g);
  var save = k.g; k.g = g; shelter(k, 0, -k.D/2 + 1, Math.min(len, 6), "Tram"); k.g = save;
  k.door(0, k.D/2 - 0.4 - DOOR_OUT, {kind: "tramstop", main: true, noMesh: true});
};

BUILD.port = function(k){
  var T = k.tier, P = PIERS.port(k.W, k.D), qz = P.z0;           // the quay's edge; the pier runs out from it (+z: the water)
  k.box(k.W, 0.04, k.D/2 - qz, k.m(0x6b737b, {roughness: 0.95}), 0, PLINTH + 0.02, (qz + k.D/2)/2);
  k.pier(0, P.z0, P.z1, P.w, P.y);
  var n = 1 + (T >= 3) + (T >= 5), cols = [0xe0a33a, 0xc43a2a, 0x3f6fae];
  for(var i = 0; i < n; i++) k.crane(-k.W/2 + 10 + i*Math.min(16, (k.W - 20)/Math.max(1, n)), qz - 2, 18 + T*2, cols[i % 3]);
  var yd = Math.max(10, qz + k.D/2 - 16);
  k.containers(k.W/6, -k.D/2 + 2 + yd/2, k.W*0.5, yd, 1 + Math.min(3, T));
  var sw = Math.min(24, k.W*0.3), sd = Math.min(16, k.D*0.3), sx = -k.W/2 + sw/2 + 2, sz = -k.D/2 + sd/2 + 2;
  var S = k.mass("plain", sx, sz, sw, sd, 2, {fh: 4.5, roof: false});
  k.gable(sx, sz, sw, sd, S.top, 2.4, k.m(0x5f7080, {metalness: 0.4, roughness: 0.5}));
  k.sign(k.title, 8, 1, sx, S.top - 1, sz + sd/2 + 0.06, 0, "#ffffff", "#0e5f7a");
  k.lamp(4, qz - 1, 6); k.lamp(-4, k.D/2 + 20, 6, null, true);
  k.door(sx, sz + sd/2, {w: 2.4, kind: "entrance"});
  k.door(0, P.z1 - DOOR_OUT - 0.6, {kind: "port", main: true, noMesh: true});   // where the ferries tie up
};

BUILD.dock = function(k){
  var P = PIERS.dock(k.W, k.D), pw = P.w;
  k.pier(0, P.z0, P.z1, pw, P.y);
  var bw = Math.min(k.W*0.8, 6), bz = -k.D/2 + 3;
  var M = k.mass("white", 0, bz, bw, 4, 1, {roofCol: 0x2f6fb8});
  k.sign(k.title, bw*0.8, 0.7, 0, M.top + 0.6, bz + 2.06, 0, "#ffffff", "#0e5f7a");
  k.lamp(-pw/2 + 0.4, 2, 4); k.lamp(pw/2 - 0.4, k.D/2, 4);
  k.box(1.6, 0.05, 1.6, k.m(0xffd34a, {roughness: 0.6}), 0, PLINTH + 0.63, k.D/2 + 4);
  k.door(0, bz + 2, {w: 1.8, h: 2.4, kind: "entrance"});
  k.door(0, P.z1 - DOOR_OUT - 0.4, {kind: "dock", main: true, noMesh: true});     // the boats come in here
};

// The airport's landside terminal (airport spec, section 5). The airfield, skybridge, concourse, tower and the
// rest are games/hqairbldg.js, drawn from the airfield layout. Site frame: u = -z (local) runs from the curb
// (u -80) out toward the airfield (u +80), v = -x. A 36 x 132 hall: two blocking side masses (2 floors, 12 m to
// the eaves) either side of a walk-through nave (|v| <= 6): flat from the door to u 0, then a ramp up to the gate
// level at u 56 and a mezzanine to the skybridge at u 66. A wave roof at 14..16 m, the curb canopy, the sign.
var AIRPORT_NAVE = {halfW: 6, ramp0: 0, ramp1: 56, mez1: 66, y0: PLINTH, y1: 5.0};   // = HQV.hqAirbldg.NAVE
var AIRPORT_HALL = {halfW: 18, halfD: 66, eaves: 12, roof0: 14, crown: 1.2, wave: 0.45, waveLen: 44, thick: 0.35,
                    canopy: {u0: -80, u1: -66, halfW: 19.5, y: 5.0}, islands: [[-50, -42], [-39, -31], [-28, -20]], skyW: 8, skyTop: 9.5};
BUILD.airport = function(k){
  var THREE = k.THREE, N = AIRPORT_NAVE, H = AIRPORT_HALL, sx = k.W/40, sz = k.D/160;
  function Z(u){ return -u*sz; }                                   // local z of frame u
  var hw = H.halfW*sx, hd = H.halfD*sz, nw = N.halfW*sx;
  var pave = k.m(0x8d969e, {roughness: 0.92}), stone = k.m(0xd9d4c8, {roughness: 0.6}), frameM = k.m(0x3a4652, {metalness: 0.6, roughness: 0.35});
  var white = k.m(0xeef1f3, {roughness: 0.45, metalness: 0.2}), desk = k.m(0xcfd6dc, {roughness: 0.5}), dark = k.m(0x23292f, {roughness: 0.7});
  var ramp = k.m(0xb39c80, {roughness: 0.7});                    // warm stone: the ramp reads against the floor
  // glass: built with a stand-in opaque material in its own group, merged there, then given the real (transparent) one
  var gl = new THREE.Group(); k.g.add(gl);
  var tmp = k.m(0x10fe03), glass = new THREE.MeshStandardMaterial({color: 0x9cc6dc, roughness: 0.08, metalness: 0.35, transparent: true, opacity: 0.36,
    depthWrite: false, emissive: new THREE.Color(0xffd9a0), emissiveIntensity: 0});
  k.night.push({m: glass, day: 0, night: 0.3});
  function pane(w, h, d, x, y, z){ return k.box(w, h, d, tmp, x, y, z, gl); }
  // the skirt: down from the plinth past the ground (it falls to -0.6 m under the site's back)
  k.box(k.W, 1.3, k.D, pave, 0, -0.65, 0).castShadow = false;
  // side masses: blocking, two floors to the eaves
  // (their nave sides are plain panelled walls: a window facade 132 m long seen end-on from the nave shimmers)
  [-1, 1].forEach(function(s){
    k.mass("terminal", s*(nw + hw)/2, 0, hw - nw, 2*hd, 2, {fh: (H.eaves - PLINTH)/2, roofCol: 0x6b7680, sides: [[0, 1], [s, 0], [0, -1]]});
    k.box(0.2, H.eaves - PLINTH, 2*hd, stone, s*(nw + 0.1), (H.eaves + PLINTH)/2, 0);
  });
  // the wave roof: a closed slab over the hall, its underside 14 m at the eaves rising to the crown, waving along u
  function under(x, z){ var a = x/(hw + 1), w = 0.5 - 0.5*Math.cos(2*PI*(z/sz)/H.waveLen); return H.roof0 + H.crown*(1 - a*a) + H.wave*w; }
  (function(){
    var NX = 16, NZ = 66, x0 = -hw - 1, x1 = hw + 1, z0 = -hd - 1, z1 = hd + 1, pos = [], idx = [], i, j;
    function vtx(x, y, z){ pos.push(x, y, z); return pos.length/3 - 1; }
    var top = [], bot = [];
    for(j = 0; j <= NZ; j++) for(i = 0; i <= NX; i++){
      var x = x0 + (x1 - x0)*i/NX, z = z0 + (z1 - z0)*j/NZ, y = under(x, z);
      top.push(vtx(x, y + H.thick, z)); bot.push(vtx(x, y, z));
    }
    var ceil = [];                                                // the underside: its own, softly lit, material
    function q(a, b, c2, d, out){ (out || idx).push(a, b, c2, a, c2, d); }
    for(j = 0; j < NZ; j++) for(i = 0; i < NX; i++){
      var a = j*(NX + 1) + i, b = a + 1, c2 = a + NX + 2, d = a + NX + 1;
      q(top[a], top[d], top[c2], top[b]); q(bot[a], bot[b], bot[c2], bot[d], ceil);
    }
    for(i = 0; i < NX; i++){ q(top[i], top[i + 1], bot[i + 1], bot[i]); var e = NZ*(NX + 1) + i; q(top[e + 1], top[e], bot[e], bot[e + 1]); }
    for(j = 0; j < NZ; j++){ var l = j*(NX + 1), r = l + NX; q(top[l + NX + 1], top[l], bot[l], bot[l + NX + 1]); q(top[r], top[r + NX + 1], bot[r + NX + 1], bot[r]); }
    function geoOf(ix){
      var g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(ix);
      g = g.toNonIndexed(); g.computeVertexNormals(); g.computeBoundingBox(); g.computeBoundingSphere(); return g;
    }
    var geo = geoOf(idx);
    k.mesh(geo, k.m(0xe4e8ec, {roughness: 0.4, metalness: 0.35}), 0, 0, 0);
    k.mesh(geoOf(ceil), k.m(0xe9ecee, {roughness: 0.85, emissive: 0x5a5f66}), 0, 0, 0);
    k.note(0, 0, x1 - x0, z1 - z0, H.roof0, geo.boundingBox.max.y);   // the real top of the wave
  })();
  // glazing: the clerestory over the side masses, the nave's curtain walls front and back (the door, the skybridge)
  var eave = H.eaves + 0.4;
  [-1, 1].forEach(function(s){
    pane(0.08, under(s*hw, 0) - eave, 2*hd, s*hw, (eave + under(s*hw, 0))/2, 0);
    [-1, 1].forEach(function(f){ pane(hw - nw, under(s*(nw + hw)/2, f*hd) - eave, 0.08, s*(nw + hw)/2, (eave + under(s*(nw + hw)/2, f*hd))/2, f*hd); });
  });
  var PW = 1.5, doorW = 2.6, doorH = 3.8, sbw = H.skyW/2*sx, sbt = H.skyTop;
  [hd, -hd].forEach(function(z, fi){
    for(var x = -nw; x < nw - 1e-6; x += PW){
      var xc = x + PW/2, top = under(xc, z) - 0.05, y0 = PLINTH;
      if(fi === 0 && Math.abs(xc) < doorW){ y0 = PLINTH + doorH; }                              // over the door
      if(fi === 1 && Math.abs(xc) < sbw){ pane(PW, N.y1 - PLINTH, 0.08, xc, (PLINTH + N.y1)/2, z); y0 = sbt; }   // the skybridge's way in
      pane(PW, top - y0, 0.08, xc, (top + y0)/2, z);
      // the mullion: none across the door's opening (over it only), nor across the skybridge's way in
      if(fi === 0 && Math.abs(x) < doorW) k.box(0.1, top - PLINTH - doorH, 0.18, frameM, x, (top + PLINTH + doorH)/2, z);
      else if(fi === 1 && Math.abs(x) < sbw){ k.box(0.1, N.y1 - PLINTH, 0.18, frameM, x, (N.y1 + PLINTH)/2, z); k.box(0.1, top - sbt, 0.18, frameM, x, (top + sbt)/2, z); }
      else k.box(0.1, top - PLINTH, 0.18, frameM, x, (top + PLINTH)/2, z);
    }
    k.box(0.1, under(nw, z) - PLINTH, 0.18, frameM, nw, (under(nw, z) + PLINTH)/2, z);
    [doorH + PLINTH, 8.4, 12].forEach(function(y){ k.box(2*nw, 0.1, 0.16, frameM, 0, y, z); });
  });
  // the automatic door: its glass leaves slid open, a lit lintel
  [-1, 1].forEach(function(s){ pane(doorW, doorH - 0.1, 0.06, s*(doorW + doorW/2), PLINTH + doorH/2, hd - 0.2); });
  k.box(2*doorW + 0.4, 0.22, 0.24, k.n(0x1b2530, 0xfff1d6, 0.1, 1.6), 0, PLINTH + doorH + 0.05, hd + 0.08);
  k.door(0, hd, {w: 2*doorW, h: doorH, main: true, kind: "airport", noMesh: true});
  [-1, 1].forEach(function(s){ k.door(s*(nw + hw)/2, hd, {w: 2.4, h: 3, kind: "entrance"}); });
  // the nave: the floor, check-in islands (low, blocking, 2 m aisles), the ramp and the mezzanine
  k.box(2*nw, 0.02, hd, stone, 0, PLINTH + 0.01, hd/2);
  H.islands.forEach(function(r){
    var zc = (Z(r[0]) + Z(r[1]))/2, len = Math.abs(Z(r[1]) - Z(r[0]));
    [-1, 1].forEach(function(s){
      var xc = s*3.25*sx;
      k.box(1.5*sx, 1.1, len, desk, xc, PLINTH + 0.55, zc);
      k.box(0.5*sx, 0.06, len, dark, xc + s*0.45*sx, PLINTH + 1.13, zc);
      k.box(0.15, 1.2, len, k.n(0x0d1a24, 0x5fd3e6, 0.25, 1.1), xc + s*0.68*sx, PLINTH + 1.7, zc);
      k.note(xc, zc, 1.5*sx, len, 0, 2.3, true);
    });
  });
  (function(){
    var sh = new THREE.Shape(), r0 = N.ramp0*sz, r1 = N.ramp1*sz;           // in (u, y): extruded across the nave
    sh.moveTo(r0, PLINTH); sh.lineTo(r1, PLINTH); sh.lineTo(r1, N.y1); sh.lineTo(r0, PLINTH);
    var geo = new THREE.ExtrudeGeometry(sh, {depth: 2*nw - 0.02, bevelEnabled: false});
    geo.rotateY(PI/2);                                                       // shape x (u) -> -z, extrusion -> +x
    k.mesh(geo, ramp, -nw + 0.01, 0, 0);
  })();
  k.box(2*nw - 0.02, N.y1 - PLINTH, (N.mez1 - N.ramp1)*sz - 0.2, ramp, 0, (N.y1 + PLINTH)/2, Z((N.ramp1 + N.mez1)/2) + 0.1);
  [-1, 1].forEach(function(s){
    var len = Math.hypot((N.ramp1 - N.ramp0)*sz, N.y1 - PLINTH), rail = k.box(0.08, 0.08, len, frameM, s*(nw - 0.25), (PLINTH + N.y1)/2 + 1.0, Z((N.ramp0 + N.ramp1)/2));
    rail.rotation.x = Math.atan2(N.y1 - PLINTH, (N.ramp1 - N.ramp0)*sz);    // up toward -z
  });
  // the departures board over the aisle, facing the door
  var BW = 512, BH = 144, T = k.c.canvasTex(BW, BH, null);
  var bm = new THREE.Mesh(new THREE.PlaneGeometry(8, 2.25), new THREE.MeshBasicMaterial({map: T.t, toneMapped: false}));
  bm.position.set(0, 6.2, Z(-8)); k.g.add(bm);
  k.board = function(lines){
    var g = T.g; if(!g) return;
    g.fillStyle = "#0b1622"; g.fillRect(0, 0, BW, BH);
    g.fillStyle = "#ffb347"; g.font = "700 22px system-ui, sans-serif"; g.textAlign = "left"; g.textBaseline = "top"; g.fillText("DEPARTURES", 14, 8);
    g.fillStyle = "#e9eff3"; g.font = "600 17px ui-monospace, monospace";
    (lines || []).slice(0, 5).forEach(function(l, i){ g.fillText(k.c.short(Array.isArray(l) ? l.join("  ") : String(l == null ? "" : l), 40), 14, 40 + i*20); });
    if(T.t) T.t.needsUpdate = true;
  };
  k.board([]);
  // the curb canopy (does not block), its downlights and columns, the sign over it, lamps
  var C = H.canopy, cz0 = Z(C.u1), cz1 = Math.min(Z(C.u0), k.D/2) - 0.15, czc = (cz0 + cz1)/2, cd = cz1 - cz0, cw = C.halfW*sx;
  k.box(2*cw, 0.35, cd, white, 0, C.y + 0.175, czc); k.note(0, czc, 2*cw, cd, C.y, C.y + 0.35);
  for(var dx = -15; dx <= 15; dx += 6) [0.3, 0.75].forEach(function(f){ k.box(1.2, 0.05, 1.2, k.n(0xf6efe0, 0xfff1d6, 0.15, 1.8), dx*sx, C.y - 0.02, cz0 + cd*f); });
  [-17, -9, 9, 17].forEach(function(x){ k.cyl(0.2, 0.24, C.y - PLINTH, frameM, x*sx, PLINTH + (C.y - PLINTH)/2, cz1 - 1.2, 12); });
  k.sign(k.title, 16*sx, 1.6, 0, C.y + 1.3, cz1 - 0.12, 0, "#ffffff", "#0e5f7a");
  k.box(16*sx + 0.4, 2, 0.2, white, 0, C.y + 1.3, cz1 - 0.24); k.note(0, cz1 - 0.24, 16*sx + 0.4, 0.2, C.y + 0.35, C.y + 2.3, true);
  k.lamp(-cw + 0.5, cz1 - 0.6, 4.3); k.lamp(cw - 0.5, cz1 - 0.6, 4.3);
  // the nave as the City walks it (world): the door, the ramp's foot and top, the mezzanine's end
  var a = k.world(0, Z(N.ramp0)), b = k.world(0, Z(N.ramp1)), m = k.world(0, Z(N.mez1)), d0 = k.world(0, hd);
  k.nave = {halfW: nw, door: [d0.x, d0.z], a: [a.x, a.z], b: [b.x, b.z], mez: [m.x, m.z], y0: k.F.y + N.y0, y1: k.F.y + N.y1};
  if(HQV.hqMerge && HQV.hqMerge.mergeStatic) HQV.hqMerge.mergeStatic(THREE, gl);
  gl.traverse(function(o){ if(o.material === tmp) o.material = glass; });
};

BUILD.power = function(k){
  var T = k.tier, w = Math.min(k.W*0.55, 40), d = Math.min(k.D*0.4, 20), zc = k.back(d, 8);
  var M = k.mass("plain", -k.W/2 + w/2 + 2, zc, w, d, 3, {fh: 5, roof: false}), hx = M.x;
  k.gable(hx, zc, w, d, M.top, 3, k.m(0x5f7080, {metalness: 0.4, roughness: 0.5}));
  // the stacks, banded red and white, a red lamp on each
  var n = 2 + (T >= 3) + (T >= 5), sh = 30 + T*6, red = k.m(0xc43a2a, {roughness: 0.6}), white = k.m(0xeeeeee, {roughness: 0.6});
  var lampM = k.n(0x400000, 0xff3030, 0.3, 2.5);
  for(var i = 0; i < n; i++){
    var sx = hx - w/2 + 3 + i*Math.min(6, (w - 6)/Math.max(1, n - 1)), sz = zc - d/2 - 3;
    k.cyl(1.1, 1.6, sh, k.m(0xc9c4ba, {roughness: 0.8}), sx, PLINTH + sh/2, sz, 14);
    for(var b = 0; b < 3; b++) k.cyl(1.2, 1.2, 2, b % 2 ? white : red, sx, PLINTH + sh - 1 - b*2, sz, 14);
    k.sph(0.35, lampM, sx, PLINTH + sh + 0.3, sz);
    k.note(sx, sz, 3.2, 3.2, 0, sh + 0.6);
  }
  k.glow(0xff3030, hx - w/2 + 3, PLINTH + sh + 0.4, zc - d/2 - 3, 3, 0.7);
  if(T >= 3){                                                          // the cooling tower
    var r = Math.min(12, k.W*0.15), pts = [], ct = r*2.4;
    for(var j = 0; j <= 10; j++){ var u = j/10; pts.push(new k.THREE.Vector2(r*(0.62 + 0.38*Math.pow(2*u - 1.05, 2)), u*ct)); }
    var tx = k.W/2 - r - 2, tzz = -k.D/2 + r + 2;
    k.mesh(new k.THREE.LatheGeometry(pts, 28), k.m(0xc9c4ba, {roughness: 0.85, side: 2}), tx, PLINTH, tzz);
    k.note(tx, tzz, 2*r, 2*r, 0, ct);
  }
  // the switchyard: transformers behind a fence
  var yx = k.W/2 - 10, yz = k.D/2 - 9, steel = k.m(0x8a949e, {metalness: 0.6, roughness: 0.4});
  k.fence(yx - 7, yz - 5, yx + 7, yz + 5, 2);
  for(i = 0; i < 3; i++){ k.box(2.4, 2.2, 1.8, k.m(0x6b7b5a, {roughness: 0.7}), yx - 4.5 + i*4.5, PLINTH + 1.1, yz);
    for(var q = -1; q <= 1; q++) k.cyl(0.12, 0.18, 1.4, steel, yx - 4.5 + i*4.5 + q*0.7, PLINTH + 2.9, yz, 8); }
  k.sign(k.title, 10, 1.2, hx, M.top - 1.2, zc + d/2 + 0.06, 0, "#ffffff", "#7a4a10");
  k.door(hx, zc + d/2, {w: 2.4, main: true});
};

BUILD.water = function(k){
  var T = k.tier, r = Math.min(k.W, k.D)*0.24 + T*0.3, lh = 14 + T*2, steel = k.m(0x8a949e, {metalness: 0.6, roughness: 0.4});
  var tankM = k.m(0x7fa7c4, {roughness: 0.5, metalness: 0.3});
  [[-1, -1], [1, -1], [1, 1], [-1, 1]].forEach(function(s){ k.cyl(0.25, 0.32, lh, steel, s[0]*r*0.7, PLINTH + lh/2, s[1]*r*0.7 - 1, 8); });
  for(var b = 1; b <= 2; b++){ var y = PLINTH + lh*b/3;
    k.box(r*1.4, 0.15, 0.15, steel, 0, y, -r*0.7 - 1); k.box(r*1.4, 0.15, 0.15, steel, 0, y, r*0.7 - 1);
    k.box(0.15, 0.15, r*1.4, steel, -r*0.7, y, -1); k.box(0.15, 0.15, r*1.4, steel, r*0.7, y, -1); }
  var th = r*1.4;
  k.cyl(r, r, th, tankM, 0, PLINTH + lh + th/2, -1, 24);
  k.mesh(new k.THREE.ConeGeometry(r + 0.2, r*0.6, 24), k.m(0x56606b, {roughness: 0.7}), 0, PLINTH + lh + th + r*0.3, -1);
  k.sph(0.3, k.n(0x400000, 0xff3030, 0.3, 2.5), 0, PLINTH + lh + th + r*0.6 + 0.2, -1);
  k.note(0, -1, 2*r, 2*r, 0, lh + th + r*0.6);
  k.sign(k.title, r*1.4, r*0.45, 0, PLINTH + lh + th/2, r - 1 + 0.05, 0, "#ffffff", "#2f6f9c");
  var pw = Math.min(5, k.W*0.4), pz = k.D/2 - 2.4;
  k.mass("brick", k.W/2 - pw/2 - 0.5, pz, pw, 3.4, 1, {fh: 3});
  k.door(k.W/2 - pw/2 - 0.5, pz + 1.7, {w: 1.2, h: 2.2, main: true});
};

BUILD.stadium = function(k){
  var T = k.tier, rx = k.W/2 - 2, rz = k.D/2 - 2, R = 30, hgt = 10 + T*3, pts = [], THREE = k.THREE;
  // the bowl: a lathe of terraces round an oval, inner radius 0.62 R
  var steps = 6 + T, ri = R*0.62;
  pts.push(new THREE.Vector2(ri, 0));
  for(var i = 0; i < steps; i++){ var r0 = ri + (R - ri)*i/steps, r1 = ri + (R - ri)*(i + 1)/steps, y = 1 + hgt*i/steps;
    pts.push(new THREE.Vector2(r0, y), new THREE.Vector2(r1, y)); }
  pts.push(new THREE.Vector2(R, hgt + 1.5), new THREE.Vector2(R + 0.6, hgt + 1.5), new THREE.Vector2(R + 0.6, 0));
  var bowl = k.mesh(new THREE.LatheGeometry(pts, 48), k.m(k.pick([0xa7adb3, 0xb3a89a, 0x9aa7b3, 0xb0b0a4]), {roughness: 0.85, side: 2}), 0, PLINTH, 0);
  bowl.scale.set(rx/(R + 0.6), 1, rz/(R + 0.6));
  var band = k.mesh(new THREE.CylinderGeometry(R + 0.7, R + 0.7, 1.2, 48, 1, true), k.n(0x0d1a24, k.K.col, 0.2, 1.6), 0, PLINTH + hgt - 1, 0);
  band.scale.copy(bowl.scale);
  if(T >= 4){                                                          // a roof ring over the upper terraces
    var rp = [new THREE.Vector2(R*0.84, hgt + 5), new THREE.Vector2(R + 0.8, hgt + 6.5), new THREE.Vector2(R + 0.8, hgt + 6), new THREE.Vector2(R*0.84, hgt + 4.6)];
    k.mesh(new THREE.LatheGeometry(rp, 48), k.m(0xeceff2, {roughness: 0.5, side: 2}), 0, PLINTH, 0).scale.copy(bowl.scale);
  }
  k.note(0, 0, 2*rx, 2*rz, 0, hgt + (T >= 4 ? 6.5 : 1.5));
  // the pitch and its lines
  var px = rx*ri/(R + 0.6)*1.3, pz = rz*ri/(R + 0.6)*1.3, line = k.m(0xf2f2f2, {roughness: 0.8});
  k.box(px*1.1, 0.06, pz*1.1, k.m(0x3f8f45, {roughness: 0.95}), 0, PLINTH + 0.03, 0);
  [[px*0.9, 0.15, 0, -pz*0.42], [px*0.9, 0.15, 0, pz*0.42], [0.15, pz*0.84, -px*0.45, 0], [0.15, pz*0.84, px*0.45, 0], [0.15, pz*0.84, 0, 0]].forEach(function(q){
    k.box(q[0], 0.02, q[1], line, q[2], PLINTH + 0.07, q[3]); });
  // floodlights
  if(T >= 2){
    var mast = k.m(0x8a949e, {metalness: 0.6, roughness: 0.4}), head = k.n(0x3a3a3a, 0xfff6e0, 0, 2.6), mh = hgt + 12;
    [[-1, -1], [1, -1], [1, 1], [-1, 1]].forEach(function(s){
      var x = s[0]*rx*0.78, z = s[1]*rz*0.78;
      k.cyl(0.35, 0.5, mh, mast, x, PLINTH + mh/2, z, 8); var hd = k.box(4, 2.4, 0.4, head, x, PLINTH + mh, z); hd.rotation.y = Math.atan2(-x, -z);
      k.glow(0xfff6e0, x, PLINTH + mh, z, 7, 0.55);
    });
    k.top = Math.max(k.top, mh + 1.2);
  }
  k.sign(k.title, 14, 2, 0, PLINTH + hgt - 3.5, rz + 0.8, 0, "#ffffff", "#2f7d4a");
  k.door(0, rz, {w: 5, h: 4, main: true});
  k.door(0, -rz, {w: 5, h: 4, rot: PI, kind: "entrance"});
};

// zone buildings
BUILD.office = function(k){
  var T = k.tier, fl = [3, 5, 8, 12, 18][T - 1] + Math.floor(k.R()*3), w = Math.min(k.W*0.8, 30), d = Math.min(k.D*0.75, 26), zc = k.back(d, 3);
  var pod = k.mass("office", 0, zc, w, d, 2, {roofCol: 0x6a737c});
  var tw = w*0.82, td = d*0.82, low = T >= 4 ? Math.ceil(fl*0.6) : fl - 2;
  var A = k.mass("glass", 0, zc - 0.4, tw, td, Math.max(1, low), {y0: pod.top});
  var top = A.top;
  if(T >= 4) top = k.mass("glass", 0, zc - 0.8, tw*0.7, td*0.7, fl - 2 - low, {y0: A.top}).top;
  k.box(Math.min(tw*0.4, 6), 2, Math.min(td*0.4, 5), k.m(0x9aa4ae, {metalness: 0.5, roughness: 0.5}), 0, top + 1, zc - 0.8);
  if(T >= 4){ k.cyl(0.15, 0.25, 10, k.m(0xc4ccd4, {metalness: 0.8}), 2, top + 5, zc - 1, 8); k.sph(0.3, k.n(0x400000, 0xff3030, 0.3, 2.5), 2, top + 10.2, zc - 1); k.top = Math.max(k.top, top + 10.5); }
  k.sign(k.firm, Math.min(w*0.6, 10), 1.1, 0, pod.top - 1.4, zc + d/2 + 0.06, 0, "#ffffff", "#24384a");
  k.door(0, zc + d/2, {w: 3, main: true});
};

BUILD.campus = function(k){
  var T = k.tier, n = 2 + (T >= 3) + (T >= 5), lawn = k.m(0x5a9a4f, {roughness: 0.95});
  k.box(k.W*0.9, 0.06, k.D*0.9, lawn, 0, PLINTH + 0.03, 0);
  var pw = Math.min(k.W*0.42, 30), pd = Math.min(k.D*0.3, 16), solar = k.m(0x1f2f4f, {roughness: 0.3, metalness: 0.5}), main = null;
  var spots = [[-1, -1], [1, -1], [-1, 1], [1, 1], [0, 0]];
  for(var i = 0; i < n; i++){
    var s = spots[i], x = s[0]*(k.W/2 - pw/2 - 2), z = s[1]*(k.D/2 - pd/2 - 3);
    if(i === 4){ pw *= 0.6; pd *= 0.6; }
    var M = k.mass("glass", x, z, pw, pd, 2 + (T >= 4 && i < 2), {fh: 4, roofCol: 0xe8ecef});
    for(var p = 0; p < 3; p++){ var sp = k.box(pw*0.25, 0.08, pd*0.5, solar, x - pw*0.3 + p*pw*0.3, M.top + 0.5, z); sp.rotation.x = -0.3; }
    if(!main) main = M;
  }
  var path = k.m(0xd8d0bf, {roughness: 0.9});
  k.box(3, 0.04, k.D*0.9, path, 0, PLINTH + 0.07, 0); k.box(k.W*0.9, 0.04, 3, path, 0, PLINTH + 0.07, 0);
  for(i = 0; i < 4 + T; i++) k.tree(k.r(-k.W*0.25, k.W*0.25), k.r(-k.D*0.12, k.D*0.12) + (i % 2 ? 1 : -1)*k.D*0.12, k.r(0.7, 1.1));
  k.sign(k.firm, Math.min(pw*0.6, 10), 1, main.x, main.top - 1.2, main.z + pd/2 + 0.06, 0, "#ffffff", "#2f7d4a");
  // the bike racks and a logo totem by the front path
  var steel = k.m(0xc4ccd4, {metalness: 0.7, roughness: 0.3});
  for(i = 0; i < 4; i++){ var h = k.mesh(new k.THREE.TorusGeometry(0.4, 0.04, 6, 14, PI), steel, 3 + i*0.9, PLINTH, k.D/2 - 3); h.rotation.y = PI/2; }
  k.box(1.2, 3, 0.5, k.n(0x103020, 0x6fd38a, 0.3, 1.8), -3, PLINTH + 1.5, k.D/2 - 3);
  k.door(main.x, main.z + main.d/2, {w: 3, main: true});
};

BUILD.studio = function(k){
  var T = k.tier, n = 2 + (T >= 4) + (T >= 5), sw = Math.min(k.W*0.28, 22), sd = Math.min(k.D*0.45, 26), roofM = k.m(0x7d8a96, {metalness: 0.4, roughness: 0.5});
  var paint = k.m(0x2b3440, {roughness: 0.7});
  for(var i = 0; i < n; i++){
    var x = -k.W/2 + sw/2 + 2 + i*Math.min(sw + 3, (k.W - sw - 4)/Math.max(1, n - 1)), z = -k.D/2 + sd/2 + 2;
    if(n === 1) x = 0;
    var M = k.mass("plain", x, z, sw, sd, 1, {fh: 12, roof: false});
    k.barrel(x, z, sd + 0.4, sw/2, M.top, roofM, true).scale.y = 0.4;
    k.box(3, 3, 0.1, paint, x, PLINTH + 8, z + sd/2 + 0.06);                       // the stage number's plate
    k.box(5, 5.4, 0.12, k.m(0xb5b1a8, {roughness: 0.6, metalness: 0.3}), x + sw/4, PLINTH + 2.7, z + sd/2 + 0.06);   // the elephant door
    k.box(0.5, 0.5, 0.3, k.n(0x400000, 0xff2a2a, 0.2, 2.4), x - sw/4, PLINTH + 4, z + sd/2 + 0.15);   // the red light: rolling
  }
  // the backlot: false fronts braced from behind
  var bz = k.D/2 - 10, styles = ["brick", "stone", "white"], brace = k.m(0x8a6a4a, {roughness: 0.9}), nf = 2 + Math.min(3, T);
  for(i = 0; i < nf; i++){
    var fw = Math.min(8, (k.W*0.5)/nf), fx = -k.W/2 + 3 + fw/2 + i*(fw + 0.6);
    k.mass(styles[i % 3], fx, bz, fw, 0.3, 2 + (i % 2), {sides: [[0, 1]], roofCol: 0x6d6a63});
    k.box(0.15, 5, 0.15, brace, fx, PLINTH + 2.5, bz - 1.4).rotation.x = 0.5;
  }
  // the gate: two pylons, a beam with the sign
  var gx = k.W/4;
  k.box(1.2, 6, 1.2, paint, gx - 5, PLINTH + 3, k.D/2 - 2); k.box(1.2, 6, 1.2, paint, gx + 5, PLINTH + 3, k.D/2 - 2);
  k.box(11.2, 1.2, 1, paint, gx, PLINTH + 6.6, k.D/2 - 2);
  k.sign(k.firm + " Studios", 9, 1, gx, PLINTH + 6.6, k.D/2 - 1.45, 0, "#ffb347", "#1a1410");
  k.lamp(gx - 5, k.D/2 - 0.8, 4); k.lamp(gx + 5, k.D/2 - 0.8, 4, null, false);
  k.door(gx, k.D/2 - 2, {w: 8, h: 5, main: true, noMesh: true, kind: "studio"});
};

BUILD.finance = function(k){
  var T = k.tier, fl = [4, 7, 11, 16, 24][T - 1] + Math.floor(k.R()*3), w = Math.min(k.W*0.8, 28), d = Math.min(k.D*0.8, 26), zc = k.back(d, 4);
  var base = k.mass("stone", 0, zc, w, d, 3, {roofCol: 0x8c8678});
  var A = k.mass("glass", 0, zc, w*0.78, d*0.78, Math.max(1, fl - 3), {y0: base.top, roof: false});
  var gold = k.n(0x6a5420, 0xffd36a, 0.4, 1.8), top = A.top;
  for(var s = 0; s < 2 + (T >= 4); s++){                                 // the stepped crown
    var f = 0.7 - s*0.16; k.box(w*0.78*f + 0.4, 1.6, d*0.78*f + 0.4, k.m(0x2c3b4a, {roughness: 0.4, metalness: 0.5}), 0, top + 0.8, zc);
    k.box(w*0.78*f + 0.5, 0.2, d*0.78*f + 0.5, gold, 0, top + 1.5, zc); top += 1.6;
  }
  if(T >= 4){ k.cyl(0.1, 0.4, 12, k.m(0xc4ccd4, {metalness: 0.8}), 0, top + 6, zc, 8); top += 12; }
  k.note(0, zc, w*0.78, d*0.78, base.top, top);
  k.sign(k.firm, Math.min(w*0.6, 10), 1, 0, base.top - 1.2, zc + d/2 + 0.06, 0, "#f6e7b8", "#2c3b4a");
  k.door(0, zc + d/2, {w: 3, h: 3.6, main: true});
};

BUILD.biotech = function(k){
  var T = k.tier, w = Math.min(k.W*0.4, 24), d = Math.min(k.D*0.55, 20), fl = 2 + (T >= 3) + (T >= 5), zc = k.back(d, 6);
  var A = k.mass("white", -w/2 - 2, zc, w, d, fl), B = k.mass("white", w/2 + 2, zc, w, d, Math.max(2, fl - 1));
  k.box(4, 3, 3, k.m(0x7fb8a0, {roughness: 0.2, metalness: 0.4}), 0, PLINTH + 3 + 3.6, zc);   // the glass bridge
  var steel = k.m(0xb7c0c9, {metalness: 0.6, roughness: 0.4});
  [A, B].forEach(function(M){
    for(var i = 0; i < 3; i++) k.cyl(0.5, 0.5, 2.4, steel, M.x - M.w/3 + i*M.w/3, M.top + 1.2, M.z - M.d/4, 12);
    var duct = k.box(M.w*0.8, 0.9, 0.9, steel, M.x, M.top + 0.45, M.z + M.d/4); duct.castShadow = true;
  });
  // the helix out front
  var hx = 0, hz = Math.min(k.D/2 - 3, zc + d/2 + 4), a = k.m(0x6fd38a, {roughness: 0.4}), b = k.m(0x5fd3e6, {roughness: 0.4});
  for(var j = 0; j < 12; j++){ var t = j*0.55, y = PLINTH + 0.6 + j*0.4;
    k.sph(0.22, a, hx + Math.cos(t)*0.9, y, hz + Math.sin(t)*0.9); k.sph(0.22, b, hx - Math.cos(t)*0.9, y, hz - Math.sin(t)*0.9);
    k.box(1.8, 0.06, 0.06, steel, hx, y, hz).rotation.y = -t; }
  k.sign(k.firm + " Bio", Math.min(w*0.7, 10), 1, A.x, A.top - 1.2, zc + d/2 + 0.06, 0, "#1f6b3a", "#f2f7f3");
  k.door(A.x, zc + d/2, {w: 2.6, main: true});
};

BUILD.media = function(k){
  var T = k.tier, fl = [3, 5, 7, 10, 14][T - 1] + Math.floor(k.R()*2), w = Math.min(k.W*0.8, 26), d = Math.min(k.D*0.75, 22), zc = k.back(d, 4);
  var M = k.mass("glass", 0, zc, w, d, fl, {roofCol: 0x3a3f4a});
  // the big screen on the front, in the firm's colours
  var col = ["#e0559b", "#5fd3e6", "#ffb347", "#6fd38a"], firm = k.firm, sh = Math.min(fl*3.6*0.5, 14);
  var T2 = k.c.canvasTex(256, 128, function(g){
    for(var i = 0; i < 4; i++){ g.fillStyle = col[i]; g.fillRect(i*64, 0, 64, 128); }
    g.fillStyle = "rgba(10,16,24,.6)"; g.fillRect(0, 44, 256, 40);
    g.fillStyle = "#fff"; g.font = "700 30px system-ui, sans-serif"; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(k.c.short(firm.toUpperCase(), 14), 128, 66);
  });
  var scr = new k.THREE.Mesh(new k.THREE.PlaneGeometry(w*0.7, sh), new k.THREE.MeshBasicMaterial({map: T2.t, toneMapped: false}));
  scr.position.set(0, M.top - sh/2 - 1.5, zc + d/2 + 0.08); k.g.add(scr);
  // the mast and dishes on the roof
  var steel = k.m(0xc4ccd4, {metalness: 0.8, roughness: 0.3}), mh = 8 + T*3;
  [[-0.6, -0.6], [0.6, -0.6], [0, 0.6]].forEach(function(q){ k.box(0.15, mh, 0.15, steel, -w/4 + q[0], M.top + mh/2, zc + q[1]); });
  for(var b = 1; b < 4; b++) k.box(1.4, 0.1, 1.4, steel, -w/4, M.top + mh*b/4, zc);
  k.sph(0.3, k.n(0x400000, 0xff3030, 0.3, 2.5), -w/4, M.top + mh + 0.3, zc);
  for(var i = 0; i < 1 + (T >= 3); i++){ var dsh = k.dome(1.3, w/4 + i*3 - 1.5, M.top + 1.6, zc, k.m(0xeceff2, {roughness: 0.5, side: 2})); dsh.rotation.x = -1.1; }
  k.top = Math.max(k.top, M.top + mh + 0.6);
  k.sign(k.firm + " Media", Math.min(w*0.5, 9), 0.9, 0, PLINTH + 4.2, zc + d/2 + 0.06, 0, "#ffffff", "#5a1f3e");
  k.door(0, zc + d/2, {w: 3, main: true});
};

BUILD.warehouse = function(k){
  var T = k.tier, w = Math.min(k.W*0.92, 60), d = Math.min(k.D*0.6, 30), zc = -k.D/2 + d/2 + 1;
  var M = k.mass("plain", 0, zc, w, d, 1, {fh: 7 + T, roof: false}), roofM = k.m(0x7d8a96, {metalness: 0.4, roughness: 0.5});
  var saw = k.R() < 0.5 || T >= 4;
  if(saw){ var ns = Math.max(2, Math.round(w/8));                        // a sawtooth roof
    for(var i = 0; i < ns; i++){ var x = -w/2 + w*(i + 0.5)/ns, sh = new k.THREE.Shape(); sh.moveTo(-w/ns/2, 0); sh.lineTo(w/ns/2, 0); sh.lineTo(w/ns/2, 2.4); sh.lineTo(-w/ns/2, 0);
      var gg = new k.THREE.ExtrudeGeometry(sh, {depth: d + 0.4, bevelEnabled: false}); gg.translate(0, 0, -(d + 0.4)/2); k.mesh(gg, roofM, x, M.top, zc); }
    k.note(0, zc, w, d, M.top, M.top + 2.4);
  } else k.gable(0, zc, w, d, M.top, 2.2, roofM, true);
  // the loading docks: roll doors, bumpers, a trailer backed up to one
  var nd = Math.max(2, Math.min(3 + T, Math.floor(w/6))), roll = k.m(0xc9d1d9, {roughness: 0.5, metalness: 0.3}), bump = k.m(0x1d2126, {roughness: 0.9});
  for(i = 0; i < nd; i++){ var dx = -w/2 + w*(i + 0.5)/nd;
    k.box(3.4, 3.6, 0.14, roll, dx, PLINTH + 2.2, zc + d/2 + 0.08);
    k.box(0.3, 0.6, 0.3, bump, dx - 1.9, PLINTH + 1, zc + d/2 + 0.2); k.box(0.3, 0.6, 0.3, bump, dx + 1.9, PLINTH + 1, zc + d/2 + 0.2); }
  k.box(w, 1.2, 2.4, k.m(0x9ea5ac, {roughness: 0.9}), 0, PLINTH + 0.6, zc + d/2 + 1.2);   // the dock's apron
  var tz = zc + d/2 + 2.4 + 6.5;
  if(tz + 7 < k.D/2 + 4) k.vehicle("trailer", -w/2 + w*0.5/nd, tz, PI);
  var pal = k.m(0xb08a5a, {roughness: 0.9});
  for(i = 0; i < 2 + T; i++) k.box(1.2, 0.8 + (i % 3)*0.4, 1, pal, w/2 - 2 - (i % 4)*1.4, PLINTH + 0.4 + (i % 3)*0.2, zc + d/2 + 3 + Math.floor(i/4)*1.4);
  k.sign(k.firm + " Logistics", Math.min(w*0.4, 14), 1.2, 0, M.top - 1.2, zc + d/2 + 0.06, 0, "#ffffff", "#7a4a10");
  k.lamp(-w/2 + 1, zc + d/2 + 3, 6);
  k.door(w/2 - 2, zc + d/2, {w: 1.6, h: 2.6, main: true});
};

BUILD.farm = function(k){
  var T = k.tier, red = k.m(0xa8322a, {roughness: 0.8}), trim = k.m(0xf2efe6, {roughness: 0.8}), roofM = k.m(0x4a4f5a, {roughness: 0.7});
  // the fields: rows in two greens over the back of the site
  var fd = k.D*0.5, fz = -k.D/2 + fd/2 + 1, rows = Math.max(4, Math.floor(fd/2.2)), g1 = k.m(0x5a9a3f, {roughness: 0.95}), g2 = k.m(0x8aa84a, {roughness: 0.95});
  k.box(k.W*0.94, 0.05, fd, k.m(0x6b5040, {roughness: 0.95}), 0, PLINTH + 0.02, fz);
  for(var i = 0; i < rows; i++) k.box(k.W*0.9, 0.35, 0.9, i % 2 ? g1 : g2, 0, PLINTH + 0.2, fz - fd/2 + 1 + i*(fd - 2)/(rows - 1));
  k.fence(-k.W*0.47, fz - fd/2, k.W*0.47, fz + fd/2, 1.1);
  // the barn: walls, a gambrel roof, big doors
  var bw = Math.min(k.W*0.35, 16), bd = Math.min(k.D*0.3, 12), bx = -k.W/4, bz = k.D/2 - bd/2 - 4, bh = 5;
  k.box(bw, bh, bd, red, bx, PLINTH + bh/2, bz); k.note(bx, bz, bw, bd, 0, bh + 5);
  k.gable(bx, bz, bw, bd, PLINTH + bh, 2.6, roofM, true);
  k.gable(bx, bz, bw*0.6, bd, PLINTH + bh + 2, 2.2, roofM, true);
  k.box(4, 3.8, 0.12, trim, bx, PLINTH + 1.9, bz + bd/2 + 0.07);
  k.box(3.6, 3.4, 0.14, red, bx, PLINTH + 1.9, bz + bd/2 + 0.1);
  // silos
  // as many as stand between the barn and the farmhouse (hx, 9 m wide)
  var ns = 1 + (T >= 3) + (T >= 5), sm = k.m(0xc4ccd4, {metalness: 0.6, roughness: 0.4}), hx = k.W/4;
  while(ns > 0 && bx + bw/2 + 3 + (ns - 1)*4.4 + 2 > hx - 5) ns--;
  for(i = 0; i < ns; i++){ var sx = bx + bw/2 + 3 + i*4.4, sh = 10 + T*2;
    k.cyl(1.9, 1.9, sh, sm, sx, PLINTH + sh/2, bz - 1, 16); k.dome(1.95, sx, PLINTH + sh, bz - 1, sm); k.note(sx, bz - 1, 4, 4, 0, sh + 2); }
  // the farmhouse
  var hz = k.D/2 - 7, H = k.mass("white", hx, hz, 9, 7, 2, {fh: 3, roof: false});
  k.gable(hx, hz, 9, 7, H.top, 2.4, k.m(0x6a3a2a, {roughness: 0.7}));
  k.vehicle("tractor", 0, k.D/2 - 4, PI/2);
  k.tree(hx + 6, hz, 1);
  k.door(bx, bz + bd/2, {w: 3.6, h: 3.4, main: true, noMesh: true, kind: "farm"});
  k.door(hx, hz + 3.5, {w: 1.2, h: 2.3, kind: "entrance"});
};

/* ---------- piers ---------- */
function pierOf(site){
  var mk = site && PIERS[site.kind]; if(!mk) return [];
  var F = frame(site), P = mk(F.w, F.d), cr = Math.cos(F.rot), sr = Math.sin(F.rot);
  function w(lx, lz){ return [F.x + lx*cr + lz*sr, F.z - lx*sr + lz*cr]; }      // as KP.world
  return [{poly: [w(-P.w/2, P.z0), w(P.w/2, P.z0), w(P.w/2, P.z1), w(-P.w/2, P.z1)], y: F.y + P.y, head: w(0, P.z1), dir: [sr, cr], w: P.w}];
}
function deckAt(decks, x, z){
  for(var i = 0; i < (decks || []).length; i++) if(inPoly(decks[i].poly, x, z)) return decks[i].y;
  return null;
}

/* ---------- build ---------- */
function build(c, site, opts){
  site = site || {}; opts = opts || {};
  var THREE = c.THREE, k = new Kit(c, site, opts);
  BUILD[k.kind](k);
  // the window walls: one mesh per style, its windows lit at night
  Object.keys(k.walls).forEach(function(st){
    var T = styleTex(c, st), m = new THREE.MeshStandardMaterial({color: k.tint, map: T.map, emissiveMap: T.emi, emissive: new THREE.Color(0xffffff),
      emissiveIntensity: 1, roughness: 0.55, metalness: 0.15});
    k.night.push({m: m, day: 0, night: 1});
    var o = new THREE.Mesh(k.walls[st].geometry(THREE), m); o.castShadow = true; o.receiveShadow = true; o.name = "civic:walls:" + st; k.g.add(o);
    if(k.live.length){ o.userData.door = k.live[0]; k.hits.push(o); }
  });
  if(k.live.length && k.signMesh){ k.signMesh.userData.door = k.live[0]; k.hits.push(k.signMesh); }
  // a site that opens something carries its name over the roof
  if(k.live.length && c.label){ var lb = c.label(k.title, k.hex, 0.9); lb.position.set(0, k.top + 3, 0); k.g.add(lb); }
  // static parts: one mesh per material. The night and blink materials get a unique intensity for
  // the merge, so two that only look alike now never share a mesh (each is set on its own later).
  var M = HQV.hqMerge;
  if(M && typeof M.mergeStatic === "function"){
    k.night.forEach(function(r, i){ r.m.emissiveIntensity = 1000 + i; });
    M.mergeStatic(THREE, k.g, {keep: function(o){ return !!(o.userData && o.userData.door); }});
  }
  var night = opts.night != null ? !!opts.night : true;
  function apply(){ k.night.forEach(function(r){ r.m.emissiveIntensity = night ? r.night : r.day; }); k.glows.forEach(function(gl){ gl.visible = night; }); }
  apply();
  return {g: k.g, doors: k.doors, hits: k.hits, glows: k.glows, boxes: k.boxes, lod: k.lod, tint: k.tint, decks: pierOf(site),
    top: k.top, kind: k.kind, tier: k.tier, nave: k.nave || null,
    // the airport's departures board: lines of text (canvas fillText, never markup)
    setBoard: function(lines){ if(k.board) k.board(Array.isArray(lines) ? lines : []); },
    x: k.F.x, y: k.F.y, z: k.F.z, rot: k.F.rot, w: k.W, d: k.D,
    setNight: function(n){ night = !!n; apply(); },
    // the police lamps blink in turn; k (0..1) is the motion scale (Calm: 0)
    animate: function(t, dt, kk){
      kk = kk == null ? 1 : kk;
      if(k.blink){ var on = kk > 0 ? ((t*1.6) % 1) < 0.5 : true; k.blink[0].emissiveIntensity = on ? 2.6 : 0.3; k.blink[1].emissiveIntensity = on ? 0.3 : 2.6; }
    }};
}

HQV.hqCivic = {build: build, fit: fit, frame: frame, pierOf: pierOf, deckAt: deckAt, KINDS: KINDS, STYLES: STYLES, AIRPORT_NAVE: AIRPORT_NAVE};
})();
