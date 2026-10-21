/* Claude HQ: the multi-storey vehicle garage (HQV.hqCarpark), docs/plans/dealership-spec.md "The vehicle garage".
 *
 * Every city has one (the generator's civic site "carpark": the Commons' is the biggest), and every owned vehicle
 * lives in it: called, it drives out (down the helix, out of the front) and along the roads to you; left behind,
 * it drives back and parks in its bay. Each vehicle has a fixed bay, deterministic from its owner's id and its own
 * id, so every client sees the same car in the same bay.
 *
 * The building, in the site's frame (+z: its front, toward the road; x across it): a HELIX ramp tower at the -x
 * end (one turn per level, a lane of LANE m round a core) and the DECK beside it: a cross aisle along the tower,
 * then aisles running along x with a row of bays either side. Level l's floor is LEVEL_H*l over the site's
 * ground; the top level is an open roof deck. The helix meets each level at its +x side (angle 0), through an
 * opening in the tower's wall; the ground level opens to the street at the front, at the cross aisle.
 *
 * Pure (node-tested, no THREE):
 *   find(W)                     -> the city's carpark site (a copy with `levels`: 6 on the Commons, 3 on an
 *                                  island) or null
 *   layout(site)                -> L: the frame and every dimension (cached per site)
 *   bays(site)                  -> [{i, level, x, y, z, yaw, lx, lz, aisle, side}]  (world m; yaw: the car's
 *                                  heading parked nose-in; deterministic, level by level)
 *   assign(site, keys)          -> {key: bay index}: each key ("<owner id>:<vehicle id>") its own bay: its hash
 *                                  picks one, a taken bay passes to the next free one (keys placed in hash order,
 *                                  so the same set of keys gives the same bays on every client)
 *   bayFor(site, playerId, vehicleKey, taken?) -> the bay assign() gives "<playerId>:<vehicleKey>" (taken: bay
 *                                  indices already in use), or null when the garage is full
 *   exitPath(bay[, site])       -> [{x, y, z}] (world m): from the bay out to its aisle, along to the cross aisle,
 *                                  down the helix to the ground, out of the front, to the entrance
 *   entryPath(bay[, site])      -> the same, reversed: from the entrance to the bay
 *   stored(site, bay, {key, vehicleId, color}) -> a vehicle the calling part (games/hqcall.js) has driven back is
 *                                  shown parked in that bay of the drawn garage (the moving one is the caller's to
 *                                  hide); false when that garage is not drawn or the vehicle is unknown
 *   entrance(site, G?)          -> {x, z, yaw (facing out, to the street), door: {x, z}, road}: the kerb in front
 *                                  of the exit; given a road graph G (HQV.hqnav.graph), x/z are its nearest road
 *                                  point (HQV.hqnav.snap) and road is that snap
 *   groundAt(site, x, z, y)     -> the surface under (x, z) nearest the height y (a floor or the helix), or null
 *                                  outside the building
 *   blockedAt(site, x, z, y)    -> walls, the helix core and walls, the tower's corners and the columns, at height y
 *   camHit(site, from, to)      -> 0..1: where along the camera's ray the first floor over `from` stops it (1: none)
 * Drawing (THREE):
 *   build(c, site, opts)        -> B = {g, setNight(n), fleet(list), store(bay, o), update(cam), drawCalls(), dispose()}
 *     c: the hq3d ctx or {THREE}. opts: {night, catalogue (the catalogue, or a function returning it: stored()
 *     looks vehicle ids up in it)}. g is in world coordinates.
 *     B.fleet([{key, entry (catalogue), paint (hex number or "#rrggbb")}]): parks them in their bays: every one an
 *     instance of a car or a bike silhouette in its paint (two draw calls for the whole fleet), and the one nearest
 *     the camera (within NEAR m) as its full model (HQV.hqVehicleModels).
 */
(function(){
"use strict";
var ROOT = typeof window !== "undefined" ? window : globalThis;
var HQV = ROOT.HQV = ROOT.HQV || {};

var PI = Math.PI, TAU = 2*PI;
var LEVEL_H = 3.2;          // m between floors
var SLAB = 0.32;            // a floor's thickness
var LANE = 6;               // the helix lane's width
var BAY_W = 2.7, BAY_D = 5.4, AISLE = 6.4;
var WALL = 0.3;             // the outer walls' and parapets' thickness
var PARAPET = 1.1;          // their height over a floor
var HELIX_R = 9.5, HELIX_MIN = 6.2;   // the tower's radius (outer wall), at most / at least
var OUT = 3.5;              // the entrance stands this far out past the front wall (m)
var LEVELS = {commons: 6, island: 3};
var NEAR = 16;              // m from the camera: the nearest parked vehicle is drawn in full
var STEP = PI/18;           // the helix's sampling (10 degrees)
var BUILT = {};             // site id -> the drawn garage (build()), for stored()

function clamp(v, a, b){ return v < a ? a : v > b ? b : v; }
function hash(s){ var h = 2166136261; s = String(s); for(var i = 0; i < s.length; i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

/* ---------- the site ---------- */
function find(W){
  var s = ((W && W.sites) || []).filter(function(x){ return x && x.kind === "carpark"; })[0];
  if(!s) return null;
  var commons = !/^user:/.test(String((W && W.id) || ""));
  return Object.assign({}, s, {levels: s.levels || (commons ? LEVELS.commons : LEVELS.island)});
}
function frontOf(s){
  if(s.front && s.front.length === 2){
    var fx = s.front[0]/65536, fz = s.front[1]/65536, l = Math.hypot(fx, fz);
    if(l > 1e-6) return [fx/l, fz/l];
  }
  return s.facing === "south" ? [0, -1] : [0, 1];
}

var CACHE = {};
function layout(site){
  var key = [site.id, site.x, site.z, site.w, site.d, site.levels, site.y].join("|");
  if(CACHE[key]) return CACHE[key];
  var f = frontOf(site), rot = Math.atan2(f[0], f[1]), cx = (site.x || 0)/100, cz = (site.z || 0)/100;
  var ux = [Math.cos(rot), -Math.sin(rot)], uz = f;
  var W = (site.w || 3000)/100, D = (site.d || 2000)/100;
  if(site.poly && site.poly.length >= 3){
    var mx = 0, mz = 0;
    site.poly.forEach(function(p){
      var dx = p[0]/100 - cx, dz = p[1]/100 - cz;
      mx = Math.max(mx, Math.abs(dx*ux[0] + dz*ux[1])); mz = Math.max(mz, Math.abs(dx*uz[0] + dz*uz[1]));
    });
    W = 2*mx; D = 2*mz;
  }
  var levels = clamp(site.levels | 0 || (W >= 45 ? LEVELS.commons : LEVELS.island), 2, 8);
  // the tower takes a quarter of the width at most; its lane narrows in a small one (the core keeps 1.6 m)
  var R = clamp(Math.min(HELIX_R, D/2 - 0.6, W*0.25), HELIX_MIN, HELIX_R);
  var lane = Math.min(LANE, R - 0.5 - 1.6), rc = R - 0.5 - lane/2, rin = rc - lane/2, rout = rc + lane/2;
  var inner = D - 2*WALL, nA = Math.max(1, Math.floor(inner/(AISLE + 2*BAY_D))), m = inner/nA;
  // the cross aisle joins the aisles to the tower and the door; with one aisle (on the tower's axis) it is only
  // the door's lane through the front row
  var crossW = nA > 1 ? AISLE : 3.6;
  var hx = -W/2 + R, hz = 0, deckX0 = hx + R, crossX = deckX0 + crossW/2, bayX0 = deckX0 + crossW, bayX1 = W/2 - WALL;
  var bd = Math.min(BAY_D, (m - AISLE)/2), aisles = [];
  for(var a = 0; a < nA; a++) aisles.push(-D/2 + WALL + (a + 0.5)*m);
  var nb = Math.max(0, Math.floor((bayX1 - bayX0)/BAY_W));
  var L = {site: site, cx: cx, cz: cz, rot: rot, ux: ux, uz: uz, W: W, D: D, base: (site.y || 0)/100 + 0.05,
           levels: levels, H: LEVEL_H, R: R, lane: lane, crossW: crossW, rc: rc, rin: rin, rout: rout, hx: hx, hz: hz, deckX0: deckX0, crossX: crossX,
           bayX0: bayX0, bayX1: bayX1, aisles: aisles, bd: bd, nb: nb, module: m};
  // columns: between every third bay, at the back of each row
  L.cols = [];
  aisles.forEach(function(za){
    [-1, 1].forEach(function(s){
      var zc = za + s*(AISLE/2 + bd - 0.25);
      for(var k = 3; k < nb; k += 3) L.cols.push([bayX0 + k*BAY_W, zc]);
    });
  });
  CACHE[key] = L;
  return L;
}
// the site's frame <-> the world
function toWorld(L, lx, lz){ return {x: L.cx + lx*L.ux[0] + lz*L.uz[0], z: L.cz + lx*L.ux[1] + lz*L.uz[1]}; }
function toLocal(L, x, z){ var dx = x - L.cx, dz = z - L.cz; return {x: dx*L.ux[0] + dz*L.ux[1], z: dx*L.uz[0] + dz*L.uz[1]}; }
function yawOf(L, dlx, dlz){ var w = {x: dlx*L.ux[0] + dlz*L.uz[0], z: dlx*L.ux[1] + dlz*L.uz[1]}; return Math.atan2(w.x, w.z); }
function levelY(L, l){ return L.base + l*L.H; }

/* ---------- bays ---------- */
function bays(site){
  var L = layout(site);
  if(L.bays) return L.bays;
  var out = [];
  for(var l = 0; l < L.levels; l++){
    L.aisles.forEach(function(za, a){
      [-1, 1].forEach(function(s){
        var lz = za + s*(AISLE/2 + L.bd/2);
        for(var i = 0; i < L.nb; i++){
          var lx = L.bayX0 + (i + 0.5)*BAY_W, p = toWorld(L, lx, lz);
          var b = {i: out.length, level: l, x: p.x, y: levelY(L, l), z: p.z, yaw: yawOf(L, 0, s), lx: lx, lz: lz, aisle: a, side: s, site: site.id};
          Object.defineProperty(b, "_site", {value: site, enumerable: false});
          out.push(b);
        }
      });
    });
  }
  L.bays = out;
  return out;
}
function assign(site, keys, taken){
  var B = bays(site), n = B.length, used = {}, cnt = 0, out = {};
  if(!n) return out;
  (taken || []).forEach(function(j){ if(j != null && !used[j]){ used[j] = 1; cnt++; } });
  (keys || []).slice().map(String).filter(function(k, i, a){ return a.indexOf(k) === i; })
    .sort(function(a, b){ return (hash(a) - hash(b)) || (a < b ? -1 : a > b ? 1 : 0); })
    .forEach(function(k){
      if(cnt >= n) return;
      var j = hash(k) % n;
      while(used[j]) j = (j + 1) % n;
      used[j] = 1; cnt++; out[k] = j;
    });
  return out;
}
// one vehicle's bay: the one assign() gives the key "<player id>:<vehicle key>" (taken: bay indices already used)
function bayFor(site, playerId, vehicleKey, taken){
  var k = String(playerId) + ":" + String(vehicleKey), j = assign(site, [k], taken)[k];
  return j == null ? null : bays(site)[j];
}

/* ---------- paths ---------- */
function layoutOfBay(bay){
  var site = bay && bay._site;
  if(!site) throw new Error("hqCarpark: a bay from bays(site)");
  return layout(site);
}
function exitLocal(L, bay){
  var y = levelY(L, bay.level), za = L.aisles[bay.aisle], P = [];
  function add(lx, lz, yy){ P.push([lx, lz, yy]); }
  add(bay.lx, bay.lz, y);
  add(bay.lx, za, y);
  add(L.crossX, za, y);
  if(bay.level > 0){
    add(L.crossX, L.hz, y);
    add(L.hx + L.rout + 0.4, L.hz, y);
    for(var t = TAU*bay.level; t > 1e-9; t -= STEP){
      add(L.hx + L.rc*Math.cos(t), L.hz + L.rc*Math.sin(t), L.base + t/TAU*L.H);
    }
    add(L.hx + L.rc, L.hz, L.base);
    add(L.hx + L.rout + 0.4, L.hz, L.base);
    add(L.crossX, L.hz, L.base);
  }
  add(L.crossX, L.D/2 - WALL - 0.5, L.base);
  add(L.crossX, L.D/2 + OUT, L.base);
  // drop repeats (a bay on the cross aisle's own row, the ground level's helix-less route)
  return P.filter(function(p, i){ return !i || Math.hypot(p[0] - P[i - 1][0], p[1] - P[i - 1][1], p[2] - P[i - 1][2]) > 1e-6; });
}
function exitPath(bay, site){
  var L = site ? layout(site) : layoutOfBay(bay);
  return exitLocal(L, bay).map(function(p){ var w = toWorld(L, p[0], p[1]); return {x: w.x, y: p[2], z: w.z}; });
}
function entryPath(bay, site){ return exitPath(bay, site).reverse(); }
function entrance(site, G){
  var L = layout(site), w = toWorld(L, L.crossX, L.D/2 + OUT), out = {x: w.x, z: w.z, yaw: L.rot, door: {x: w.x, z: w.z}, road: null};
  var N = HQV.hqnav;
  if(G && N && N.snap){
    var s = N.snap(G, w.x, w.z);
    if(s){ out.road = s; out.x = s.x; out.z = s.z; }
  }
  return out;
}

/* ---------- the surfaces ---------- */
function inside(L, p, pad){ return Math.abs(p.x) <= L.W/2 + pad && Math.abs(p.z) <= L.D/2 + pad; }
function groundAt(site, x, z, y){
  var L = layout(site), p = toLocal(L, x, z);
  if(!inside(L, p, 0.05)) return null;
  var hint = y == null || !isFinite(y) ? L.base : y, best = null, bd = Infinity, l;
  function cand(v){ var d = Math.abs(v - hint); if(d < bd){ bd = d; best = v; } }
  var dx = p.x - L.hx, dz = p.z - L.hz, r = Math.hypot(dx, dz);
  if(r <= L.rout && r >= L.rin - 0.3){
    // in the helix's lane: the ramp, one turn a level (at the ground it starts from the ground itself)
    var th = Math.atan2(dz, dx); if(th < 0) th += TAU;
    // every turn's height here (from the turn below the ground's, so the seam at angle 0 counts both ways)
    for(l = -1; l < L.levels; l++){ var t = l + th/TAU; if(t >= -1e-9 && t <= L.levels - 1 + 1e-9) cand(L.base + t*L.H); }
    return best;
  }
  for(l = 0; l < L.levels; l++) cand(levelY(L, l));
  return best;
}
function blockedAt(site, x, z, y){
  var L = layout(site), p = toLocal(L, x, z);
  if(!inside(L, p, 0)) return false;
  var lv = ((y == null || !isFinite(y) ? L.base : y) - L.base)/L.H, li = Math.round(lv), onLevel = Math.abs(lv - li) < 0.22;
  // the outer walls (parapets on every level); the street door at the ground level's cross aisle
  if(p.x > L.W/2 - WALL || p.x < -L.W/2 + WALL || p.z > L.D/2 - WALL || p.z < -L.D/2 + WALL){
    return !(p.z > 0 && li === 0 && onLevel && Math.abs(p.x - L.crossX) < L.crossW/2);
  }
  var dx = p.x - L.hx, dz = p.z - L.hz, r = Math.hypot(dx, dz);
  var opening = dx > 0 && Math.abs(dz) < L.lane/2 && onLevel;
  if(r <= L.R){
    if(r < L.rin) return true;                       // the core
    if(r > L.rout) return !opening;                  // the tower's wall, open onto each level
    return false;
  }
  if(p.x < L.deckX0) return true;                    // the tower's corners
  if(p.x < L.deckX0 + WALL && !opening) return true; // the wall between the tower and the deck
  for(var i = 0; i < L.cols.length; i++) if(Math.hypot(p.x - L.cols[i][0], p.z - L.cols[i][1]) < 0.35) return true;
  return false;
}

// The camera: how far along from -> to (0..1) the first floor of the garage over `from` stops it (1: none), so a
// chase camera inside stays under the floor above you instead of looking down on its slab.
function camHit(site, from, to){
  var L = layout(site), a = toLocal(L, from.x, from.z), b = toLocal(L, to.x, to.z);
  if(!inside(L, a, 2) && !inside(L, b, 2)) return 1;
  var best = 1, dy = to.y - from.y;
  if(Math.abs(dy) < 1e-6) return 1;
  for(var l = 1; l < L.levels; l++){
    var yb = levelY(L, l) - SLAB - 0.15;                 // just under the slab
    if(yb <= from.y + 0.3) continue;                     // a floor at or below you does not cover you
    var t = (yb - from.y)/dy;
    if(t <= 0 || t >= best) continue;
    var x = a.x + (b.x - a.x)*t, z = a.z + (b.z - a.z)*t;
    if(x >= L.hx + L.rout && Math.abs(x) <= L.W/2 && Math.abs(z) <= L.D/2) best = t;   // the deck and its landings
    else { var r = Math.hypot(x - L.hx, z - L.hz); if(r <= L.R) best = t; }            // the helix above you
  }
  return best;
}

/* ---------- drawing ---------- */
// one silhouette per kind (unit size: x width, y height, z length; front +z): white body (takes the instance's
// paint), dark glass and tyres (paint times dark stays dark)
function silhouette(THREE, kind){
  var parts = kind === "bike"
    ? [[0, 0.33, 0.33, 0.12, 0.66, 0.26, 0.06], [0, 0.33, -0.33, 0.12, 0.66, 0.26, 0.06],
       [0, 0.55, 0.02, 0.36, 0.32, 0.56, 1], [0, 0.78, -0.18, 0.3, 0.12, 0.36, 0.08], [0, 0.85, 0.3, 0.9, 0.06, 0.06, 0.1]]
    : [[0, 0.32, 0, 1, 0.36, 1, 1], [0, 0.66, -0.06, 0.84, 0.34, 0.5, 0.2], [0, 0.74, -0.06, 0.78, 0.12, 0.44, 1],
       [0.45, 0.16, 0.32, 0.14, 0.32, 0.18, 0.05], [-0.45, 0.16, 0.32, 0.14, 0.32, 0.18, 0.05],
       [0.45, 0.16, -0.32, 0.14, 0.32, 0.18, 0.05], [-0.45, 0.16, -0.32, 0.14, 0.32, 0.18, 0.05]];
  var pos = [], nor = [], col = [];
  parts.forEach(function(q){
    var b = new THREE.BoxGeometry(q[3], q[4], q[5]).toNonIndexed(); b.translate(q[0], q[1], q[2]);
    var P = b.getAttribute("position").array, N = b.getAttribute("normal").array;
    for(var i = 0; i < P.length; i++){ pos.push(P[i]); nor.push(N[i]); }
    for(i = 0; i < P.length/3; i++) col.push(q[6], q[6], q[6]);
    b.dispose();
  });
  var g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  return g;
}
function paintHex(entry, paint){
  if(typeof paint === "number" && paint >= 0 && paint < 64 && entry && entry.paints && entry.paints[paint]) paint = entry.paints[paint].hex || entry.paints[paint];
  if(typeof paint === "string" && /^#[0-9a-fA-F]{6}$/.test(paint)) return parseInt(paint.slice(1), 16);
  if(typeof paint === "number" && paint >= 64) return paint;
  var p0 = entry && entry.paints && entry.paints[0]; p0 = p0 && (p0.hex || p0);
  return typeof p0 === "string" && /^#[0-9a-fA-F]{6}$/.test(p0) ? parseInt(p0.slice(1), 16) : 0x8a8f96;
}
function dimsOf(entry){
  var d = (entry && entry.dims) || {}, bike = entry && /^bike\./.test(String(entry.class || "")) || (entry && entry.kind === "bike");
  return {kind: bike ? "bike" : "car", l: d.lengthM || (bike ? 2.1 : 4.6), w: d.widthM || (bike ? 0.85 : 1.9), h: d.heightM || (bike ? 1.2 : 1.45)};
}
function canvasSign(THREE, text, w, h){
  if(typeof document === "undefined") return null;
  var cv = document.createElement("canvas"); cv.width = w; cv.height = h;
  var g = cv.getContext("2d"); if(!g) return null;
  g.fillStyle = "#0e2236"; g.fillRect(0, 0, w, h);
  g.fillStyle = "#1f6fd1"; g.fillRect(h*0.12, h*0.12, h*0.76, h*0.76);
  g.fillStyle = "#ffffff"; g.font = "bold " + Math.round(h*0.62) + "px sans-serif"; g.textAlign = "center"; g.textBaseline = "middle";
  g.fillText("P", h*0.5, h*0.53);
  g.textAlign = "left"; g.font = "bold " + Math.round(h*0.46) + "px sans-serif"; g.fillText(text, h*1.05, h*0.53);
  var t = new THREE.CanvasTexture(cv); if(THREE.SRGBColorSpace) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function build(c, site, opts){
  opts = opts || {};
  var THREE = c.THREE || c, L = layout(site), g = new THREE.Group(), body = new THREE.Group();
  g.name = "carpark:" + site.id;
  body.position.set(L.cx, L.base, L.cz); body.rotation.y = L.rot; g.add(body);
  var M = {
    concrete: new THREE.MeshStandardMaterial({color: 0xb4b8bc, roughness: 0.92}),
    dark: new THREE.MeshStandardMaterial({color: 0x6f757c, roughness: 0.9}),
    cladding: new THREE.MeshStandardMaterial({color: 0x2c5d8f, roughness: 0.55, metalness: 0.35}),
    line: new THREE.MeshBasicMaterial({color: 0xf2f2ee}),
    yellow: new THREE.MeshStandardMaterial({color: 0xf0bf2a, roughness: 0.6}),
    light: new THREE.MeshStandardMaterial({color: 0xffffff, emissive: 0xfff2d2, emissiveIntensity: 0.25, roughness: 0.4})
  };
  M.ramp = new THREE.MeshStandardMaterial({color: 0x8d9298, roughness: 0.95, side: THREE.DoubleSide});
  var boxG = new THREE.BoxGeometry(1, 1, 1);
  function box(m, x, y, z, w, h, d){ var o = new THREE.Mesh(boxG, m); o.position.set(x, y, z); o.scale.set(w, h, d); o.castShadow = h > 1; o.receiveShadow = true; body.add(o); return o; }
  var H = L.H, W = L.W, D = L.D, x0 = L.deckX0, dw = W/2 - x0;
  // ground slab under everything, a kerb round the front
  box(M.concrete, 0, -0.08, 0, W, 0.18, D);
  // the deck's floors (level 1 up), parapets with blue cladding, light strips under every floor
  for(var l = 0; l < L.levels; l++){
    var y = l*H;
    if(l > 0) box(M.concrete, x0 + dw/2, y - SLAB/2, 0, dw, SLAB, D);
    // parapets: back (-z), the far end (+x), the front (+z; the ground level is open between the columns)
    if(l > 0){
      box(M.concrete, x0 + dw/2, y + PARAPET/2, -D/2 + WALL/2, dw, PARAPET, WALL);
      box(M.concrete, x0 + dw/2, y + PARAPET/2, D/2 - WALL/2, dw, PARAPET, WALL);
      box(M.concrete, W/2 - WALL/2, y + PARAPET/2, 0, WALL, PARAPET, D);
      box(M.cladding, x0 + dw/2, y + PARAPET + 0.12, -D/2 + WALL/2, dw, 0.24, WALL + 0.06);
      box(M.cladding, x0 + dw/2, y + PARAPET + 0.12, D/2 - WALL/2, dw, 0.24, WALL + 0.06);
      box(M.cladding, W/2 - WALL/2, y + PARAPET + 0.12, 0, WALL + 0.06, 0.24, D);
    } else {
      box(M.concrete, x0 + dw/2, 0.45, -D/2 + WALL/2, dw, 0.9, WALL);
      box(M.concrete, W/2 - WALL/2, 0.45, 0, WALL, 0.9, D);
      var gx0 = L.crossX + L.crossW/2, gl = W/2 - gx0;             // the ground floor's front: a low wall past the door
      if(gl > 0.5) box(M.concrete, gx0 + gl/2, 0.45, D/2 - WALL/2, gl, 0.9, WALL);
      box(M.yellow, L.crossX - L.crossW/2 - 0.2, 0.5, D/2 - 0.3, 0.3, 1.0, 0.3);   // bollards either side of the door
      box(M.yellow, L.crossX + L.crossW/2 + 0.2, 0.5, D/2 - 0.3, 0.3, 1.0, 0.3);
    }
    // the wall between the tower and the deck, open at the helix's landing
    var ow = D/2 - L.lane/2;
    box(M.concrete, x0 + WALL/2, y + PARAPET/2, -(L.lane/2 + ow/2), WALL, PARAPET, ow);
    box(M.concrete, x0 + WALL/2, y + PARAPET/2, L.lane/2 + ow/2, WALL, PARAPET, ow);
    // bay lines and the aisles' centre dashes
    L.aisles.forEach(function(za){
      [-1, 1].forEach(function(s){
        var zl = za + s*(AISLE/2 + L.bd/2);
        for(var i = 0; i <= L.nb; i++) box(M.line, L.bayX0 + i*BAY_W, y + 0.012, zl, 0.1, 0.02, L.bd - 0.2);
      });
      for(var xd = x0 + 1; xd < W/2 - 1; xd += 3) box(M.line, xd, y + 0.012, za, 1.4, 0.02, 0.12);
      if(l < L.levels - 1) for(var xl = L.bayX0 + 2; xl < W/2 - 1; xl += 5.4) box(M.light, xl, y + H - SLAB - 0.05, za, 1.2, 0.06, 0.25);
    });
    // columns to the floor above
    if(l < L.levels - 1){
      L.cols.forEach(function(p){ box(M.dark, p[0], y + (H - SLAB)/2, p[1], 0.5, H - SLAB, 0.5); });
      // the facade's columns at the front and back edges
      for(var xc = x0 + 0.3; xc <= W/2; xc += Math.max(5, dw/Math.max(1, Math.round(dw/7.5)))){
        box(M.dark, Math.min(xc, W/2 - 0.3), y + (H - SLAB)/2, D/2 - 0.3, 0.55, H - SLAB, 0.55);
        box(M.dark, Math.min(xc, W/2 - 0.3), y + (H - SLAB)/2, -D/2 + 0.3, 0.55, H - SLAB, 0.55);
      }
    }
  }
  // roof: lamp posts
  var top = (L.levels - 1)*H;
  L.aisles.forEach(function(za){ for(var xr = L.bayX0 + 4; xr < W/2 - 2; xr += 10.8){ box(M.dark, xr, top + 2.5, za, 0.18, 5, 0.18); box(M.light, xr, top + 5.05, za, 0.9, 0.15, 0.45); } });
  // the helix tower: the core, the outer columns, the ramp ribbon and its parapet, a crown
  var tH = top + PARAPET + 0.6;
  var core = new THREE.Mesh(new THREE.CylinderGeometry(L.rin - 0.15, L.rin - 0.15, tH, 20), M.dark);
  core.position.set(L.hx, tH/2, L.hz); core.castShadow = true; body.add(core);
  for(var k = 0; k < 10; k++){
    var a = (k + 0.5)/10*TAU; if(Math.cos(a) > 0.8) continue;      // not across the landings
    box(M.dark, L.hx + (L.R - 0.3)*Math.cos(a), tH/2, L.hz + (L.R - 0.3)*Math.sin(a), 0.5, tH, 0.5);
  }
  var tot = TAU*(L.levels - 1), n = Math.ceil(tot/(PI/24)), rp = [], ri = [], pp = [], pi = [], yi = [], yp = [];
  for(var s = 0; s <= n; s++){
    var t = tot*s/n, cs = Math.cos(t), sn = Math.sin(t), yy = t/TAU*H;
    rp.push(L.hx + L.rin*cs, yy, L.hz + L.rin*sn, L.hx + L.rout*cs, yy, L.hz + L.rout*sn);
    // the outer parapet rises with the ramp, broken at every landing (and at the ground's)
    var ph = (t % TAU), gap = ph < 0.42 || ph > TAU - 0.12;
    pp.push(L.hx + (L.rout + 0.15)*cs, yy, L.hz + (L.rout + 0.15)*sn, L.hx + (L.rout + 0.15)*cs, yy + (gap ? 0 : PARAPET), L.hz + (L.rout + 0.15)*sn);
    yp.push(L.hx + (L.rout - 0.12)*cs, yy + 0.015, L.hz + (L.rout - 0.12)*sn, L.hx + (L.rout - 0.32)*cs, yy + 0.015, L.hz + (L.rout - 0.32)*sn);
    if(s < n){ var q = 2*s; ri.push(q, q + 1, q + 2, q + 1, q + 3, q + 2); pi.push(q, q + 2, q + 1, q + 1, q + 2, q + 3); yi.push(q, q + 1, q + 2, q + 1, q + 3, q + 2); }
  }
  function ribbon(P, I, m){ var geo = new THREE.BufferGeometry(); geo.setAttribute("position", new THREE.Float32BufferAttribute(P, 3)); geo.setIndex(I); geo.computeVertexNormals(); var o = new THREE.Mesh(geo, m); o.receiveShadow = true; body.add(o); return o; }
  ribbon(rp, ri, M.ramp); ribbon(pp, pi, M.ramp); ribbon(yp, yi, M.yellow);
  // a slab under each landing so a level's floor reaches the lane (the tower's +x side)
  for(l = 1; l < L.levels; l++) box(M.concrete, (L.hx + L.rout + x0)/2, l*H - SLAB/2, L.hz, x0 - L.hx - L.rout + 0.6, SLAB, L.lane);
  // the crown and the sign
  box(M.cladding, L.hx, tH + 0.4, L.hz, 2*L.R, 0.8, 0.6);
  box(M.cladding, L.hx, tH + 0.4, L.hz, 0.6, 0.8, 2*L.R);
  var tex = canvasSign(THREE, "GARAGE", 512, 128), sign = null;
  if(tex){
    var sm = new THREE.MeshBasicMaterial({map: tex, toneMapped: false});
    var sw = Math.min(14, dw*0.6);
    sign = new THREE.Mesh(new THREE.PlaneGeometry(sw, sw/4), sm); sign.position.set(x0 + dw/2, top + PARAPET + sw/8 + 0.4, D/2 + 0.05);
    body.add(sign);
    var blade = new THREE.Mesh(new THREE.PlaneGeometry(6, 1.5), sm); blade.position.set(L.hx, tH + 1.6, L.hz + L.R*0.2); body.add(blade);
    var blade2 = blade.clone(); blade2.rotation.y = PI; blade2.position.z = L.hz - L.R*0.2; body.add(blade2);
    var stand = new THREE.Mesh(new THREE.PlaneGeometry(4.8, 1.2), sm); stand.position.set(L.crossX, 3.6, D/2 + 0.2); body.add(stand);
  }
  var merged = HQV.hqMerge && HQV.hqMerge.mergeStatic ? HQV.hqMerge.mergeStatic(THREE, body, {keep: function(o){ return o.material && o.material.map; }}) : null;

  /* the fleet: two InstancedMeshes (cars, bikes) and the nearest one in full */
  var B = bays(site), fleetG = new THREE.Group(); g.add(fleetG);
  var silM = new THREE.MeshStandardMaterial({color: 0xffffff, vertexColors: true, roughness: 0.45, metalness: 0.3});
  var inst = {}, rows = [], full = null, fullKey = null, last = [];
  function makeInst(kind, n){
    if(inst[kind]){ fleetG.remove(inst[kind]); inst[kind].dispose(); inst[kind] = null; }
    if(!n) return;
    var im = new THREE.InstancedMesh(silhouette(THREE, kind), silM, n);
    im.name = "carpark:fleet:" + kind; im.castShadow = true; im.frustumCulled = false; inst[kind] = im; fleetG.add(im);
  }
  var m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), vp = new THREE.Vector3(), vs = new THREE.Vector3(), colr = new THREE.Color();
  function place(r, show){
    var im = inst[r.dims.kind]; if(!im) return;
    var b = B[r.bay];
    q.setFromAxisAngle(up, b.yaw); vp.set(b.x, b.y, b.z);
    if(show) vs.set(r.dims.w, r.dims.h, r.dims.l); else vs.set(0, 0, 0);
    im.setMatrixAt(r.slot, m4.compose(vp, q, vs)); im.instanceMatrix.needsUpdate = true;
  }
  function fleet(list){
    if(full){ fleetG.remove(full.g); full = null; fullKey = null; }
    list = (list || []).filter(function(v){ return v && v.entry; });
    var fixed = list.filter(function(v){ return v.bay != null && B[v.bay]; }), fixedBays = fixed.map(function(v){ return v.bay; });
    var A = assign(site, list.filter(function(v){ return fixed.indexOf(v) < 0; }).map(function(v){ return String(v.key); }), fixedBays), cnt = {car: 0, bike: 0};
    fixed.forEach(function(v){ A[String(v.key)] = v.bay; });
    last = list;
    rows = list.filter(function(v){ return A[String(v.key)] != null; }).map(function(v){
      var d = dimsOf(v.entry), r = {key: String(v.key), entry: v.entry, paint: paintHex(v.entry, v.paint), dims: d, bay: A[String(v.key)], slot: cnt[d.kind]++};
      return r;
    });
    makeInst("car", cnt.car); makeInst("bike", cnt.bike);
    rows.forEach(function(r){ var im = inst[r.dims.kind]; im.setColorAt(r.slot, colr.setHex(r.paint)); place(r, true); });
    ["car", "bike"].forEach(function(k){ if(inst[k] && inst[k].instanceColor) inst[k].instanceColor.needsUpdate = true; });
    return rows.map(function(r){ return {key: r.key, bay: r.bay}; });
  }
  function update(cam){
    if(!rows.length || !cam) return;
    var best = null, bd = NEAR;
    rows.forEach(function(r){ var b = B[r.bay], d = Math.hypot(b.x - cam.x, (b.y + 1) - (cam.y != null ? cam.y : b.y + 1), b.z - cam.z); if(d < bd){ bd = d; best = r; } });
    var key = best ? best.key : null;
    if(key === fullKey) return;
    if(full){ fleetG.remove(full.g); var old = rows.filter(function(r){ return r.key === fullKey; })[0]; if(old) place(old, true); full = null; }
    fullKey = key;
    if(!best || !HQV.hqVehicleModels) return;
    try {
      var R = HQV.hqVehicleModels.build(c, best.entry, best.paint), b = B[best.bay], h = new THREE.Group();
      h.add(R.g); h.position.set(b.x, b.y, b.z); h.rotation.y = b.yaw; fleetG.add(h); full = {g: h};
      place(best, false);
    } catch(e){ fullKey = null; }
  }
  function store(bay, o){
    var i = typeof bay === "number" ? bay : bay && bay.i;
    if(i == null || !B[i] || !o || !o.entry) return false;
    var key = String(o.key != null ? o.key : "stored:" + i);
    // it takes that bay: whoever stood there (and its own old place) gives way
    var gone = rows.filter(function(r){ return r.bay === i; }).map(function(r){ return r.key; }).concat([key]);
    fleet(last.filter(function(v){ return gone.indexOf(String(v.key)) < 0; }).concat([{key: key, entry: o.entry, paint: o.paint, bay: i}]));
    return true;
  }
  function setNight(on){ M.light.emissiveIntensity = on ? 2.4 : 0.25; }
  setNight(!!opts.night);
  function drawCalls(){ var n = 0; g.traverse(function(o){ if(o.isMesh && o.visible) n++; }); return n; }
  function dispose(){
    g.traverse(function(o){ if(o.isMesh){ if(o.geometry && o.geometry !== boxG) o.geometry.dispose(); } });
    boxG.dispose(); Object.keys(M).forEach(function(k){ M[k].dispose(); }); silM.dispose();
    if(tex) tex.dispose();
  }
  var Bo = {g: g, layout: L, setNight: setNight, fleet: fleet, store: store, update: update, drawCalls: drawCalls,
            rows: function(){ return rows.map(function(r){ return {key: r.key, bay: r.bay}; }); },
            dispose: function(){ if(BUILT[site.id] === Bo) delete BUILT[site.id]; dispose(); }, merged: merged, bays: B,
            catalogue: opts.catalogue || null};
  BUILT[site.id] = Bo;
  return Bo;
}

// The calling part (games/hqcall.js): a vehicle that has driven back into its bay is parked there (the moving one
// is the caller's to hide). o = {key, vehicleId, color (hex number or "#rrggbb"), entry?}. False when that garage
// is not drawn or the vehicle is unknown.
function stored(site, bay, o){
  var Bo = site && BUILT[site.id]; o = o || {};
  if(!Bo) return false;
  var cat = typeof Bo.catalogue === "function" ? Bo.catalogue() : Bo.catalogue;
  var entry = o.entry || (cat && cat.vehicles ? cat.vehicles.filter(function(v){ return v.id === o.vehicleId; })[0] : null);
  return Bo.store(bay, {key: o.key, entry: entry, paint: o.color != null ? o.color : o.paint});
}

HQV.hqCarpark = {find: find, bayFor: bayFor, stored: stored, camHit: camHit, layout: layout, bays: bays, assign: assign, exitPath: exitPath, entryPath: entryPath,
                 entrance: entrance, groundAt: groundAt, blockedAt: blockedAt, levelY: function(s, l){ return levelY(layout(s), l); },
                 toLocal: function(s, x, z){ return toLocal(layout(s), x, z); }, build: build,
                 LEVEL_H: LEVEL_H, LANE: LANE, BAY_W: BAY_W, AISLE: AISLE, WALL: WALL, OUT: OUT};
})();
