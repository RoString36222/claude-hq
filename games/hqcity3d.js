/* Claude HQ: Arena City in 3D, on the generated world (claude-hq@1).
 *
 * The same City as games/hqcity.js (every open HQ has a building, every HQ tab has one, the
 * plaza has the fountain, the bike park and the skatepark), placed on the WorldDoc's lots and
 * sites instead of a grid: the terrain, roads and the city's other buildings come from
 * games/world.js (the doc and its queries) and games/worldbuild.js (the meshes).
 *
 * A floor of the 3D HQ: registered as HQV.hqWorlds.city3d; games/hq3d.js builds it under the
 * world name "city" and it reports w.net = "city3d", the presence floor, so legacy and 3D
 * clients never share a room. Everyone gets the same placement from the same list: HQs sorted
 * by user id take the HQ lots in rank order (assign), so people stand in the same places.
 * assign, placeLot, placeView and pickAt are pure (HQV.hqCity3d), so node can test them.
 */
(function(){
"use strict";
var HQV = window.HQV = window.HQV || {};
HQV.hqWorlds = HQV.hqWorlds || {};

var PI = Math.PI;
var HQ_DZ = 2;              // an HQ stands this far in front of its lot's middle (the legacy HQ_Z)
var HQ_DOOR = 4.8;          // its door, in front of the building's middle (as hqcity.js lot().door)
var VIEW_BACK = 7;          // a view building's middle, this far behind its site's front edge
var VIEW_DOOR = 4.7;        // a view building's door, in front of its middle (hqbase.js VB_D/2 + 1.2)
var PAD_UP = 0.05;          // an HQ lot's paved slab stands this far above the ground; its buildings on top
var BUCKET = 64;            // the building index (camHit, occluderItems), metres
var FADE_EVERY = 0.15;      // classic mode: which buildings hide you, this often (s), as hqcity.js
var FADE_OP = 0.16;         // a faded building's opacity (as hqbase.js)
var FADE_TAU = 0.083;       // the fade's time constant (s): ~95% of the way in 0.25 s
var HQ_FAR = 250;           // an HQ (and its lot extras) further than this from the camera is not drawn (m)
var HQ_FAR_HYST = 10;       // ... and comes back inside HQ_FAR - this (no flicker on the edge)
// an HQ lot's paving tint by its district (legend name), over the paving texture; others plain
var PAVE = {hq: 0xffffff, plaza: 0xf2ece2, civic: 0xe8ecef, commercial: 0xdde4ec, residential: 0xefe2d0, industrial: 0xd2d0cb};

function byUser(a, b){ return a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0; }
function hqLots(W){
  return ((W && W.lots) || []).filter(function(l){ return l && l.kind === "hq"; })
    .sort(function(a, b){ return ((a.rank | 0) - (b.rank | 0)) || ((a.id | 0) - (b.id | 0)); });
}
// Who stands on which HQ lot: [{lot, h}]. HQs with a string userId sorted by userId, HQ lots by
// rank; the i-th HQ gets the i-th lot. More HQs than lots: the first N, but you always stay
// (you replace the last one kept). The same for every viewer of the same list.
function assign(list, W){
  var lots = hqLots(W), n = lots.length;
  var hs = (list || []).filter(function(h){ return h && typeof h.userId === "string"; }).sort(byUser);
  if(hs.length > n){
    var you = -1;
    for(var i = 0; i < hs.length; i++) if(hs[i].isYou){ you = i; break; }
    var kept = hs.slice(0, n);
    if(n > 0 && you >= n) kept[n - 1] = hs[you];
    hs = kept;
  }
  return hs.map(function(h, k){ return {lot: lots[k], h: h}; });
}
function turn(o){ var s = o && o.facing === "south" ? -1 : 1; return {s: s, rot: s > 0 ? 0 : PI}; }
// An HQ's building on its lot (m): the door faces the lot's facing ("north" = +z).
function placeLot(lot){
  lot = lot || {}; var f = turn(lot), door = lot.door || [];
  return {x: (lot.x || 0)/100, y: (door[1] || 0)/100, z: (lot.z || 0)/100 + HQ_DZ*f.s, rot: f.rot};
}
// A view building on its site (m): set back so its door and steps stay on the site.
function placeView(site){
  site = site || {}; var f = turn(site);
  return {x: (site.x || 0)/100, y: (site.y || 0)/100, z: (site.z || 0)/100 + f.s*((site.d || 0)/200 - VIEW_BACK), rot: f.rot};
}
// a point in a placed thing's own frame (lx, lz; +z is its front) -> the world
function toWorld(p, lx, lz){ var cr = Math.cos(p.rot), sr = Math.sin(p.rot); return {x: p.x + lx*cr + lz*sr, z: p.z - lx*sr + lz*cr}; }
// the HQ entry whose lot holds (x, z) (m), else null. entries: [{lot, ...}]
function pickAt(entries, x, z){
  var xc = x*100, zc = z*100;
  for(var i = 0; i < (entries || []).length; i++){
    var l = entries[i].lot;
    if(l && Math.abs(xc - l.x) <= l.w/2 && Math.abs(zc - l.z) <= l.d/2) return entries[i];
  }
  return null;
}
// segment from -> to against an axis-aligned box {min, max}: the entry t in [0, 1], or 1 (clear)
function segBox(from, to, b){
  var t0 = 0, t1 = 1, ax = ["x", "y", "z"];
  for(var i = 0; i < 3; i++){
    var a = ax[i], d = to[a] - from[a];
    if(Math.abs(d) < 1e-9){ if(from[a] < b.min[a] || from[a] > b.max[a]) return 1; continue; }
    var u = (b.min[a] - from[a])/d, v = (b.max[a] - from[a])/d;
    if(u > v){ var tt = u; u = v; v = tt; }
    if(u > t0) t0 = u; if(v < t1) t1 = v;
    if(t0 > t1) return 1;
  }
  return t0;
}
// The sun's shadow box centred on p, moved onto its own texel grid: p's light-space x and y (the
// shadow camera looks along -dir, up +y, as three's lookAt) snapped to multiples of texel, so the
// shadow map samples the same world points as the box follows you (no crawl). dir: towards the sun.
function snapShadow(p, dir, texel){
  p = p || {}; var px = +p.x || 0, py = +p.y || 0, pz = +p.z || 0;
  var dl = Math.hypot(dir.x, dir.y, dir.z) || 1, zx = dir.x/dl, zy = dir.y/dl, zz = dir.z/dl;
  var xl = Math.hypot(zz, zx) || 1, xx = zz/xl, xz = -zx/xl;                   // x = up x z (up = +y): (z.z, 0, -z.x)
  var yx = zy*xz, yy = zz*xx - zx*xz, yz = -zy*xx;                              // y = z x x
  var a = px*xx + pz*xz, b = px*yx + py*yy + pz*yz, d = px*zx + py*zy + pz*zz;
  if(texel > 0){ a = Math.round(a/texel)*texel; b = Math.round(b/texel)*texel; }
  return {x: a*xx + b*yx + d*zx, y: b*yy + d*zy, z: a*xz + b*yz + d*zz};
}
// what is part of an HQ's look (its building is rebuilt when it changes); crew counts are not
function hqKey(E){ var h = E.h || {}; return JSON.stringify([h.userId, (E.lot || {}).id, h.level, h.look, h.cos, !!h.isYou]); }
function crewText(h){ var crew = (h && h.crew) || {}; return (h && h.isYou ? "You · " : "") + (crew.working | 0) + " working · " + (crew.needs | 0) + " need them"; }
// A mesh mergeStatic must leave alone: doors and anything tagged animated or fading, materials
// something changes later (lit by night, blinking, scrolling, a canvas), see-through ones, and
// several materials on one mesh. Plain opaque stone, steel and paint merge.
function keepMesh(o){
  if(!o || !o.isMesh || o.isInstancedMesh || o.isSkinnedMesh) return true;
  var u = o.userData || {}; if(u.door || u.anim || u.fade || u.wave != null) return true;
  var m = o.material; if(!m || Array.isArray(m)) return true;
  if(m.transparent || m.map || m.emissiveMap || m.alphaMap) return true;
  return !!(m.emissive && m.emissiveIntensity > 0 && (m.emissive.r || m.emissive.g || m.emissive.b));
}
// o lies under one of roots ({uuid: 1}), looking up to (not past) top
function under(o, roots, top){ for(var p = o; p && p !== top; p = p.parent) if(roots[p.uuid]) return true; return false; }
HQV.hqCity3d = {assign: assign, placeLot: placeLot, placeView: placeView, toWorld: toWorld, pickAt: pickAt, segBox: segBox,
  snapShadow: snapShadow, hqKey: hqKey, keepMesh: keepMesh, HQ_DOOR: HQ_DOOR, VIEW_DOOR: VIEW_DOOR, HQ_FAR: HQ_FAR};

// Fading, eased: a fading building's materials stay transparent for good (set once, before they
// are first drawn), so going see-through is an opacity tween, never a shader recompile
// (needsUpdate) or a shadow toggle. L.fade: {g, on (the goal), a (0 solid .. 1 faded), mats}.
function fadeGoal(L, on){ if(L.fade) L.fade.on = on; }
function fadeStep(L, dt, k){
  var F = L.fade; if(!F || !F.mats) return;
  var goal = F.on ? 1 : 0; if(F.a === goal) return;
  F.a = k < 1 || !(dt > 0) ? goal : goal + (F.a - goal)*Math.exp(-dt/FADE_TAU);   // Calm: no tween
  if(Math.abs(F.a - goal) < 0.004) F.a = goal;
  F.mats.forEach(function(r){ r.m.opacity = r.op + (Math.min(r.op, FADE_OP) - r.op)*F.a; r.m.depthWrite = F.a < 0.05 ? r.dw : false; });
}

HQV.hqWorlds.city3d = function(c, w){
  var THREE = c.THREE, S = w.scene, COL = c.COL, HEX = c.HEX;
  var mat = c.mat, emis = c.emis, box = c.box, cyl = c.cyl, sph = c.sph;
  var WD = HQV.world, parts = HQV.hqCityParts, SP = HQV.hqSkatePark;
  var api = c.api || {};
  var hits = [], doors = [], night = true, W = null, wb = null, dead = false;

  var hemi = new THREE.HemisphereLight(0xbcd7ff, 0x223322, 2.2); S.add(hemi);
  var sun = new THREE.DirectionalLight(0xffffff, 2.2); sun.position.set(40, 70, 30); sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048); S.add(sun); S.add(sun.target);
  var skyBg = {
    night: c.canvasTex(512, 512, function(g){ var gr = g.createLinearGradient(0, 0, 0, 512); gr.addColorStop(0, "#040a12"); gr.addColorStop(0.6, "#0b1826"); gr.addColorStop(1, "#16304a"); g.fillStyle = gr; g.fillRect(0, 0, 512, 512); var R = c.rng(9); for(var i = 0; i < 220; i++){ g.fillStyle = "rgba(255,255,255," + (0.25 + R()*0.7) + ")"; g.fillRect(R()*512, R()*330, 1, 1); } }).t,
    day: c.canvasTex(512, 512, function(g){ var gr = g.createLinearGradient(0, 0, 0, 512); gr.addColorStop(0, "#5ea6dc"); gr.addColorStop(1, "#cfe8f7"); g.fillStyle = gr; g.fillRect(0, 0, 512, 512); }).t
  };
  var fog = new THREE.Fog(0x0f1f30, 300, 1600);
  var paveT = c.canvasTex(256, 256, function(g){ g.fillStyle = "#3b4c5c"; g.fillRect(0, 0, 256, 256); g.strokeStyle = "rgba(255,255,255,.08)"; g.lineWidth = 2;
    for(var i = 0; i <= 256; i += 32){ g.beginPath(); g.moveTo(i, 0); g.lineTo(i, 256); g.stroke(); g.beginPath(); g.moveTo(0, i); g.lineTo(256, i); g.stroke(); } });
  paveT.t.wrapS = paveT.t.wrapT = THREE.RepeatWrapping; paveT.t.repeat.set(7, 5);

  var staticG = new THREE.Group(), hqG = new THREE.Group();
  var hqs = [], views = [], civic = [], freeLots = [];   // placed things (entries below)
  var lampGlows = [], parkBikes = [], bikes = [], cars = [];
  var fount = null, skate = null, plaza = {x: 0, y: 0, z: 0}, sig = null;
  var bIdx = null;                                      // building lots by 64 m bucket: [{id, min, max}]

  function ground(x, z){ return W ? WD.groundAt(W, x, z) : 0; }
  function site(id){ for(var i = 0; i < W.sites.length; i++) if(W.sites[i].id === id) return W.sites[i]; return null; }
  function siteC(s){ return {x: s.x/100, y: s.y/100, z: s.z/100}; }

  /* ---------- the building index: AABBs of the world's own buildings, for the camera ---------- */
  function indexBuildings(){
    var nb = Math.max(1, Math.ceil(W.sizeCm/100/BUCKET)), half = W.half, B = [];
    for(var i = 0; i < nb*nb; i++) B.push([]);
    function bOf(v){ return Math.max(0, Math.min(nb - 1, Math.floor((v + half)/BUCKET))); }
    W.lots.forEach(function(l){
      if(l.kind !== "building") return;
      var R = WD.buildingRect(l), g0 = ground(R.x0, R.z0), g1 = ground(R.x1, R.z0), g2 = ground(R.x0, R.z1), g3 = ground(R.x1, R.z1);
      var top = Math.max(g0, g1, g2, g3) + Math.max(1, l.floors | 0)*3.5 + 1.5;
      var it = {id: l.id, min: {x: R.x0, y: Math.min(g0, g1, g2, g3) - 1, z: R.z0}, max: {x: R.x1, y: top, z: R.z1}};
      for(var bz = bOf(R.z0); bz <= bOf(R.z1); bz++) for(var bx = bOf(R.x0); bx <= bOf(R.x1); bx++) B[bz*nb + bx].push(it);
    });
    bIdx = {nb: nb, b: B, bOf: bOf};
  }
  // building-lot AABBs touching the box x0..x1, z0..z1 (each once)
  function buildingsIn(x0, x1, z0, z1){
    var out = [], seen = {}, I = bIdx; if(!I) return out;
    for(var bz = I.bOf(z0); bz <= I.bOf(z1); bz++) for(var bx = I.bOf(x0); bx <= I.bOf(x1); bx++){
      var L = I.b[bz*I.nb + bx];
      for(var i = 0; i < L.length; i++){ var it = L[i]; if(seen[it.id]) continue; seen[it.id] = 1;
        if(it.max.x >= x0 && it.min.x <= x1 && it.max.z >= z0 && it.min.z <= z1) out.push(it); }
    }
    return out;
  }
  // placed buildings (HQs, view buildings) as {id, min, max}: one box per part (an HQ's tower and wings)
  function placedIn(x0, x1, z0, z1){
    var out = [];
    hqs.concat(views).forEach(function(E){ (E.boxes || []).forEach(function(b){
      if(b.max.x >= x0 && b.min.x <= x1 && b.max.z >= z0 && b.min.z <= z1) out.push({id: E.oid, min: b.min, max: b.max}); }); });
    return out;
  }
  // the box (lot-local centre cx, cz, half sizes hw, hd, height top) in world coordinates
  function aabbOf(p, cx, cz, hw, hd, top){
    var a = toWorld(p, cx - hw, cz - hd), b = toWorld(p, cx + hw, cz + hd);
    return {min: {x: Math.min(a.x, b.x), y: p.y - 0.5, z: Math.min(a.z, b.z)}, max: {x: Math.max(a.x, b.x), y: p.y + top, z: Math.max(a.z, b.z)}};
  }
  // an HQ's boxes, matching hqBuilding's blockedLocal: the tower, then each wing (so the ground beside it stays clear)
  function hqBoxes(p, B){
    var top = B.top(), out = [aabbOf(p, 0, 0, 4.8, 3.8, top)];
    if(B.wings >= 1) out.push(aabbOf(p, -10.5, 0.5, 3, 2.8, top));
    if(B.wings >= 2) out.push(aabbOf(p, 10.5, 0.5, 3, 2.8, top));
    return out;
  }

  /* ---------- what is built once: the plaza, the view buildings, the civic plazas, the traffic ---------- */
  function buildStatic(){
    var fs = site("fountain:0"), ss = site("skatepark:0"), bs = site("bikepark:0");
    if(fs){ plaza = siteC(fs); fount = parts.fountain(c, staticG, plaza.x, plaza.y, plaza.z); }
    if(bs){ var bc = siteC(bs); parkBikes = parts.bikePark(c, staticG, bc.x, bc.y, bc.z, PI); }   // rot PI: the bikes face the fountain
    if(ss){ var sc = siteC(ss); skate = parts.skatePark(c, staticG, sc.x, sc.y, sc.z, {boardsSide: -1}); if(skate) skate.y = sc.y; }
    w.skatepark = skate; w.skateBase = skate ? skate.y : plaza.y;
    // one building per HQ tab, on view-building:0..12 in id order
    (HQV.hqViews || []).forEach(function(v, k){
      var s = site("view-building:" + k); if(!s) return;
      var p = placeView(s), dw = toWorld(p, 0, VIEW_DOOR);
      var V = HQV.hqViewBuilding(c, v, {doorFront: function(){ return new THREE.Vector3(dw.x, p.y, dw.z); }});
      V.g.position.set(p.x, p.y, p.z); V.g.rotation.y = p.rot; staticG.add(V.g); V.setNight(night);
      V.hits.forEach(function(o){ hits.push(o); }); V.doors.forEach(function(d){ doors.push(d); });
      merge(V.g, null, V);
      views.push({kind: "view", oid: "view:" + v.view, x: p.x, y: p.y, z: p.z, rot: p.rot, B: V, H: V.top() + 2, fade: {g: V.g, on: false},
        boxes: [aabbOf(p, 0, 0, 5, 4, V.top())]});
    });
    // the view-building sites no tab needs: a small civic plaza, a bench and a tree
    var benchM = mat(0x6b4f3a, {roughness: 0.8}), legM = mat(0x2b3a48, {metalness: 0.6});
    W.sites.forEach(function(s){
      var m = /^view-building:(\d+)$/.exec(s.id || ""); if(!m || (m[1] | 0) < (HQV.hqViews || []).length) return;
      var p = placeView(s), g = new THREE.Group(); g.position.set(p.x, p.y, p.z); g.rotation.y = p.rot; staticG.add(g);
      box(1.8, 0.08, 0.5, benchM, -1.6, 0.45, 0, g); box(1.8, 0.4, 0.06, benchM, -1.6, 0.7, -0.24, g);
      box(0.08, 0.45, 0.45, legM, -2.4, 0.22, 0, g); box(0.08, 0.45, 0.45, legM, -0.8, 0.22, 0, g);
      cyl(0.2, 0.28, 1.2, mat(0x5a3d2a), 1.8, 0.6, 0, g, 8); sph(1.2, mat(0x3c8a4f, {roughness: 0.9}), 1.8, 2.1, 0, g);
      var tr = toWorld(p, 1.8, 0);
      civic.push({p: p, tree: tr});
    });
    // traffic: a few cars up and down the streets round the middle, on the left of their lane
    var near = W.edges.filter(function(e){
      if((e.cls !== "street" && e.cls !== "avenue") || e.pts.length < 6) return false;
      var n = e.pts.length/3, m = (n >> 1)*3, mx = e.pts[m]/100, mz = e.pts[m + 2]/100;
      return mx*mx + mz*mz < 250*250;
    }).sort(function(a, b){ return WD.hash32(W.hash + ":car:" + a.id) - WD.hash32(W.hash + ":car:" + b.id) || a.id - b.id; }).slice(0, 6);
    [0xd14a5c, 0x4a7bd1, 0xe0e4e8, 0xffb347, 0x3fa66a, 0x8a4ad1].forEach(function(col, n){
      var e = near[n]; if(!e) return;
      var pts = [], len = [0], P = e.pts;
      for(var i = 0; i < P.length; i += 3){ pts.push({x: P[i]/100, y: P[i + 1]/100, z: P[i + 2]/100}); if(i) len.push(len[len.length - 1] + Math.hypot(pts[pts.length - 1].x - pts[pts.length - 2].x, pts[pts.length - 1].z - pts[pts.length - 2].z)); }
      var k = c.car(col, 0xe0e4e8).g;      // the drivable car's model: wheels on the ground, nose to +z
      staticG.add(k);
      var v = 5 + (n % 3), lane = (e.width - 2*e.walk)/400;
      cars.push({g: k, pts: pts, len: len, s: (n*0.37 % 1)*len[len.length - 1], dir: n % 2 ? -1 : 1, v: v, lane: lane,
        turn: 0, T: Math.max(0.6, PI*lane/v)});
    });
    // the plaza parts, civic plazas: one mesh per material; never the view buildings (they fade),
    // the bikes and boards (you ride them) or the traffic
    var roots = {};
    views.forEach(function(V){ roots[V.fade.g.uuid] = 1; });
    parkBikes.forEach(function(b){ roots[b.g.uuid] = 1; });
    if(skate) skate.boards.forEach(function(b){ roots[b.g.uuid] = 1; });
    cars.forEach(function(cr){ roots[cr.g.uuid] = 1; });
    merge(staticG, roots);
    views.forEach(tagFade); fadePrep(views);
  }
  // Up and down one street. At each end the car U-turns on a half circle round the end point,
  // from its lane to the other one, at its own speed (no snap).
  function carStep(cr, dt, k){
    var L = cr.len[cr.len.length - 1]; if(!(L > 0)) return;
    if(cr.turn > 0){ cr.turn -= dt*k; if(cr.turn <= 0){ cr.turn = 0; cr.dir = -cr.dir; } }
    else { cr.s += cr.dir*cr.v*dt*k; if(cr.s > L || cr.s < 0){ cr.s = cr.s > L ? L : 0; cr.turn = cr.T; } }
    var i = 1; while(i < cr.len.length - 1 && cr.len[i] < cr.s) i++;
    var a = cr.pts[i - 1], b = cr.pts[i], seg = (cr.len[i] - cr.len[i - 1]) || 1, u = Math.max(0, Math.min(1, (cr.s - cr.len[i - 1])/seg));
    var yaw = Math.atan2((b.x - a.x)*cr.dir, (b.z - a.z)*cr.dir), off = cr.lane;
    if(cr.turn > 0) yaw -= PI*(1 - cr.turn/cr.T);      // turning right, across the road: the offset sweeps round the end point
    cr.g.position.set(a.x + (b.x - a.x)*u + off*Math.cos(yaw), a.y + (b.y - a.y)*u + 0.04, a.z + (b.z - a.z)*u - off*Math.sin(yaw));
    cr.g.rotation.y = yaw;
  }

  /* ---------- the HQs: one rebuilt only when its look, level, cos or isYou changes ---------- */
  var slabM = new THREE.MeshStandardMaterial({map: paveT.t, roughness: 0.9});
  var freeT = c.canvasTex(256, 64, function(g){ g.fillStyle = "#0b1622"; g.fillRect(0, 0, 256, 64); g.fillStyle = "#e9eff3"; g.font = "700 34px system-ui, sans-serif";
    g.textAlign = "center"; g.textBaseline = "middle"; g.fillText("FREE LOT", 128, 34); });
  var lotsG = null, lotsSig = null, forceYou = false;
  // HQV.hqMerge.mergeStatic (games/hqmerge.js) on g, sub-groups and all, when it is loaded.
  // roots: what stays as it is (with everything under it); B: a building whose animate() moves
  // parts of g (rotor, karts, banners, icon): those stay too.
  function merge(g, roots, B){
    var M = HQV.hqMerge; if(!M || typeof M.mergeStatic !== "function") return;
    roots = Object.assign({}, roots || {}, B ? moving(B, g) : {});
    // keep() is asked of each mesh and of each group above it: a group is kept only as a root or a moving part
    M.mergeStatic(THREE, g, {keep: function(o){ return (o.isMesh && keepMesh(o)) || under(o, roots, g); }});
  }
  // {uuid: 1} of what B.animate moves under g: its pose at two times, compared (dt 0: no twinkle)
  function moving(B, g){
    if(typeof B.animate !== "function") return {};
    function pose(){ var s = {}; g.traverse(function(o){ s[o.uuid] = o.position.toArray().concat(o.quaternion.toArray(), o.scale.toArray(), [o.visible ? 1 : 0]).join(","); }); return s; }
    var a = pose(); B.animate(3.7, 0, 1); var b = pose(); B.animate(11.3, 0, 1); var d = pose(), out = {};
    Object.keys(a).forEach(function(id){ if(a[id] !== b[id] || a[id] !== d[id]) out[id] = 1; });
    return out;
  }
  // Ready the faders in list (each L.fade.g) for fading: a material used outside its building is
  // copied for it first (so fading one building never fades another), then every one is made
  // transparent once and remembers its opacity and depth write.
  function fadePrep(list){
    var use = {};                                      // material uuid -> {who uses it: 1}
    function note(o, who){ (Array.isArray(o.material) ? o.material : [o.material]).forEach(function(m){
      if(!m) return; var u = use[m.uuid] = use[m.uuid] || {}; u[who] = 1; }); }
    [hqG, staticG].forEach(function(R){ R.traverse(function(o){ if(o.isMesh) note(o, o.userData.fadeOid || "-"); }); });
    list.forEach(function(L){
      if(!L.fade || L.fade.mats) return;
      var mats = [], seen = {};
      L.fade.g.traverse(function(o){
        if(!o.isMesh) return;
        var arr = Array.isArray(o.material) ? o.material.slice() : [o.material];
        arr.forEach(function(m, i){
          if(!m) return;
          if(Object.keys(use[m.uuid] || {}).length > 1){ m = m.clone(); arr[i] = m; }
          if(seen[m.uuid]) return; seen[m.uuid] = 1;
          mats.push({m: m, op: m.opacity, dw: m.depthWrite}); m.transparent = true;
        });
        o.material = Array.isArray(o.material) ? arr : arr[0];
      });
      L.fade.mats = mats; L.fade.a = 0;
    });
  }
  function tagFade(L){ L.fade.g.traverse(function(o){ if(o.isMesh) o.userData.fadeOid = L.oid; }); }
  // Dispose what g (just taken out of the scene) used and nothing in the scene still does.
  function disposeTree(g){
    var keep = {}, gone = {};
    function mats(o){ return Array.isArray(o.material) ? o.material : o.material ? [o.material] : []; }
    S.traverse(function(o){
      if(o.geometry) keep[o.geometry.uuid] = 1;
      mats(o).forEach(function(m){ keep[m.uuid] = 1; texOf(m).forEach(function(t){ keep[t.uuid] = 1; }); });
    });
    [paveT.t, freeT.t, skyBg.night, skyBg.day, slabM].forEach(function(t){ keep[t.uuid] = 1; });
    function drop(x){ if(x && !keep[x.uuid]) gone[x.uuid] = x; }
    g.traverse(function(o){
      if(o.geometry && !o.isSprite) drop(o.geometry);          // a sprite's geometry is three's shared quad
      mats(o).forEach(function(m){ drop(m); texOf(m).forEach(drop); });
    });
    Object.keys(gone).forEach(function(id){ if(typeof gone[id].dispose === "function") gone[id].dispose(); });
  }
  function texOf(m){ var out = []; ["map", "emissiveMap", "alphaMap", "normalMap", "roughnessMap", "metalnessMap", "aoMap", "bumpMap"].forEach(function(k){ if(m[k] && m[k].isTexture) out.push(m[k]); }); return out; }
  function building(E){
    var h = E.h, cos = h.cos || {}, crew = h.crew || {}, name = HQV.hqCityName(h), p = E;
    var g = new THREE.Group(); g.position.set(p.x, p.y + PAD_UP, p.z); g.rotation.y = p.rot; hqG.add(g); E.g = g;
    var pad = new THREE.Mesh(new THREE.PlaneGeometry(30, 15), new THREE.MeshStandardMaterial({map: paveT.t, roughness: 0.9}));
    pad.rotation.x = -PI/2; pad.position.set(0, 0.02, 1.5); pad.receiveShadow = true; g.add(pad);
    if(h.isYou){ var ring = new THREE.Mesh(new THREE.RingGeometry(14.6, 15.1, 64), new THREE.MeshBasicMaterial({color: COL.amber, transparent: true, opacity: 0.5, toneMapped: false}));
      ring.rotation.x = -PI/2; ring.position.set(0, 0.04, 0.5); ring.scale.y = 0.45; g.add(ring); }
    var B = HQV.hqBuilding(c, {
      level: function(){ return Math.max(1, h.level | 0); },
      look: function(){ return Object.assign({}, h.look || {}, {sign: name, decor: cos.decor}); },
      live: function(){ return (crew.working | 0) + (crew.needs | 0); },
      campus: false,
      door: {view: h.isYou ? "@lobby" : "visit:" + h.userId, label: name, userId: h.userId,
             tip: h.isYou ? "Your HQ: go in" : name + ": walk in as a visitor"},
      doorFront: function(){ return new THREE.Vector3(E.door.x, p.y, E.door.z); }
    });
    g.add(B.g); B.setLive((crew.working | 0) + (crew.needs | 0)); B.setNight(night);
    E.subText = crewText(h);
    E.sub = c.label(E.subText, HEX.green, 0.7); E.sub.position.set(0, B.top() + 5.6, 0); g.add(E.sub);
    B.hits.forEach(function(o){ hits.push(o); }); B.doors.forEach(function(d){ doors.push(d); });
    E.B = B; E.H = B.top() + 2; E.fade = {g: B.g, on: false}; E.name = name;
    E.boxes = hqBoxes(p, B);
    // the garage apron stops at the lot's front edge (the building stands HQ_DZ in front of the lot's middle)
    var X = parts.lotExtras(c, g, HQV.hqLotColors(h.look), p.rot, function(x, z){ return toWorld(p, x, z); }, Math.min(11, (E.lot.d || 0)/200 - HQ_DZ), h.userId);
    E.glows = X.glows; E.car = X.car; E.items = X.items;
    // the building (its own meshes: it fades), then the lot round it: pad, garage, apron; never
    // the car, motorbike and bicycle (you ride them)
    merge(B.g, null, B);
    var roots = {}; roots[B.g.uuid] = 1; X.items.forEach(function(b){ roots[b.g.uuid] = 1; });
    merge(g, roots);
    tagFade(E);
  }
  // an HQ's crew changed: its windows and the line under its name, not its building
  function crewUpdate(E, h){
    E.h = h; var crew = h.crew || {}, t = crewText(h);
    E.B.setLive((crew.working | 0) + (crew.needs | 0));
    if(t === E.subText) return;
    var old = E.sub; E.subText = t;
    E.sub = c.label(t, HEX.green, 0.7); E.sub.position.copy(old.position); E.g.add(E.sub);
    E.g.remove(old); disposeTree(old);
  }
  function unbuild(E){
    E.B.hits.forEach(function(o){ var i = hits.indexOf(o); if(i >= 0) hits.splice(i, 1); });
    E.B.doors.forEach(function(d){ var i = doors.indexOf(d); if(i >= 0) doors.splice(i, 1); });
    hqG.remove(E.g); disposeTree(E.g);
  }
  function build(){
    if(!W) return;
    var list = (api.city && api.city()) || [];
    var key = JSON.stringify(list.map(function(h){ return [h.userId, h.level, h.look, h.cos, h.crew, !!h.isYou]; }));
    if(key === sig && !forceYou) return; sig = key;
    var old = {}; hqs.forEach(function(E){ old[E.oid] = E; });
    var next = [], made = [];
    assign(list, W).forEach(function(a){
      var p = placeLot(a.lot), d = toWorld(p, 0, HQ_DOOR);
      var E = {kind: "hq", oid: "hq:" + a.h.userId, lot: a.lot, h: a.h, x: p.x, y: p.y, z: p.z, rot: p.rot, door: {x: d.x, z: d.z}};
      var O = old[E.oid];
      if(O && hqKey(O) === hqKey(E) && !(forceYou && a.h.isYou)){ delete old[E.oid]; crewUpdate(O, a.h); next.push(O); return; }
      next.push(E); made.push(E);
    });
    forceYou = false;
    Object.keys(old).forEach(function(id){ unbuild(old[id]); });
    hqs = next;
    made.forEach(building);
    fadePrep(made);
    lampGlows = []; bikes = parkBikes.slice(); if(skate) skate.boards.forEach(function(b){ bikes.push(b); });
    hqs.forEach(function(E){ E.glows.forEach(function(gl){ lampGlows.push(gl); }); E.items.forEach(function(b){ bikes.push(b); }); });
    buildLots();
    // arriving: at your own door, or the door of the HQ you just visited; else the plaza's spawn
    var mine = hqs.filter(function(E){ return E.h.isYou; })[0];
    var back = api.cityReturn && api.cityReturn(), ret = hqs.filter(function(E){ return E.h.userId === back; })[0];
    w.spawn = at(ret || mine); w.spawnFrom = {lobby: at(mine)};
    applyTime();
  }
  // every HQ lot's paved slab (one draw call), the empty ones' "Free lot" signs and the City's
  // name: rebuilt when which lots are taken changes
  function buildLots(){
    var taken = {}; hqs.forEach(function(E){ taken[E.lot.id] = 1; });
    var ls = JSON.stringify(Object.keys(taken).sort());
    if(ls === lotsSig && lotsG) return; lotsSig = ls;
    if(lotsG){ hqG.remove(lotsG); disposeTree(lotsG); }
    lotsG = new THREE.Group(); hqG.add(lotsG); freeLots = [];
    var lots = hqLots(W);
    var slabs = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), slabM, Math.max(1, lots.length));
    var m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1), tint = new THREE.Color();
    var legend = (W.districts && W.districts.legend) || [];
    lots.forEach(function(l, n){
      var y = ((l.door || [])[1] || 0)/100, pv = PAVE[legend[l.district | 0]];
      m4.compose(new THREE.Vector3(l.x/100, y + (PAD_UP - 3)/2, l.z/100), q, new THREE.Vector3(l.w/100, 3 + PAD_UP, l.d/100)); slabs.setMatrixAt(n, m4);   // y-3 .. y+0.05
      slabs.setColorAt(n, tint.setHex(pv != null ? pv : 0xffffff));
      if(!taken[l.id]) freeLots.push(l);
    });
    slabs.count = lots.length; slabs.receiveShadow = true; lotsG.add(slabs);
    if(freeLots.length){
      var plate = new THREE.InstancedMesh(new THREE.BoxGeometry(2.4, 0.6, 0.08), new THREE.MeshBasicMaterial({map: freeT.t, toneMapped: false}), freeLots.length);
      var post = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.05, 0.05, 0.9, 6), mat(0x2b3a48, {metalness: 0.6}), freeLots.length);
      var up = new THREE.Vector3(0, 1, 0);
      freeLots.forEach(function(l, n){
        var f = turn(l), y = ((l.door || [])[1] || 0)/100 + PAD_UP, zf = l.z/100 + f.s*(l.d/200 - 1.5);
        q.setFromAxisAngle(up, f.rot);
        m4.compose(new THREE.Vector3(l.x/100, y + 1.05, zf), q, one); plate.setMatrixAt(n, m4);
        m4.compose(new THREE.Vector3(l.x/100, y + 0.45, zf), q, one); post.setMatrixAt(n, m4);
      });
      lotsG.add(plate); lotsG.add(post);
    }
    var nb = hqs.length;
    var cityL = c.label("Arena City · " + nb + " HQ" + (nb === 1 ? "" : "s"), HEX.amber, 1.3); cityL.position.set(plaza.x, plaza.y + 6.4, plaza.z); lotsG.add(cityL);
  }
  // where you stand arriving at an HQ (on the street side, looking at its front, a little off-axis)
  function at(E){
    if(E){ var dx = Math.sin(E.rot), dz = Math.cos(E.rot), x = E.door.x + dx*2.6, z = E.door.z + dz*2.6;
      return {x: x, y: groundY(x, z), z: z, yaw: Math.atan2(dx, dz), camYaw: E.rot + 0.55}; }
    var s = W && site("spawn:0"), sx = s ? s.x/100 : plaza.x, sz = s ? s.z/100 : plaza.z + 7;
    return {x: sx, y: groundY(sx, sz), z: sz, yaw: 0, camYaw: 0.55};
  }

  function applyTime(){
    hqs.concat(views).forEach(function(E){ if(E.B) E.B.setNight(night); });
    lampGlows.forEach(function(g){ g.material.opacity = night ? 0.85 : 0.08; });
  }
  function blocked(x, z){
    if(!W) return true;
    if(WD.blockedAt(W, x, z)) return true;
    if(fount && Math.hypot(x - fount.g.position.x, z - fount.g.position.z) < fount.R + 0.35) return true;   // the fountain
    if(skate && SP.walkBlocked(x - skate.cx, z - skate.cz)) return true;      // its ramps (on foot or wheels; boards ride them)
    var all = hqs.concat(views);
    for(var i = 0; i < all.length; i++){
      var L = all[i], rx = x - L.x, rz = z - L.z;
      if(Math.abs(rx) > 30 || Math.abs(rz) > 30) continue;
      var c0 = Math.cos(-L.rot), s0 = Math.sin(-L.rot), lx = rx*c0 + rz*s0, lz = -rx*s0 + rz*c0;   // into its own frame
      if(L.B && L.B.blockedLocal(lx, lz)) return true;
      // its garage, and its car (where it stands: you may have parked it in the street) unless you drive it
      if(L.kind === "hq" && HQV.hqLotExtraBlocked(lx, lz, !L.car || L.car.g.visible, L.car && {x: L.car.g.position.x, z: L.car.g.position.z, yaw: L.car.g.rotation.y})) return true;
    }
    for(var j = 0; j < civic.length; j++){
      var C = civic[j];
      if(Math.hypot(x - C.tree.x, z - C.tree.z) < 0.5) return true;
      var b = toWorld(C.p, -1.6, 0); if(Math.abs(x - b.x) < 1.1 && Math.abs(z - b.z) < 1.1) return true;   // the bench (either way round)
    }
    return false;
  }
  function groundY(x, z){
    if(!W) return 0;
    if(skate && SP.inPark(x - skate.cx, z - skate.cz)) return skate.y;      // the park's flat pad; the skater adds its ramps
    return WD.groundAt(W, x, z);
  }

  /* ---------- loading: the world doc, then every tile drawable ---------- */
  function setup(doc){
    if(dead) throw new Error("world unavailable: closed");     // hq3d gave up on us (timeout): build nothing
    W = doc; indexBuildings();
    wb = HQV.worldbuild.create(c, W, {scene: S, quality: 2});
    S.add(wb.root); S.add(staticG); S.add(hqG);
    buildStatic(); build();
    wb.setNight(night);
    return wb.ready;
  }
  w.whenReady = new Promise(function(res, rej){
    if(!WD || !HQV.worldbuild || !parts){ rej(new Error("world unavailable: client")); return; }
    WD.load({}).then(setup).then(function(){ res(w); }, rej);
  });
  w.whenReady.catch(function(){});      // hq3d.js handles it; no unhandled-rejection noise if it never asks
  // A newer world doc than the one this City was built on (the cached one, then the server's after a re-pin):
  // nothing here rebuilds in place. w.stale asks hq3d to drop this world and make a fresh one when you next enter the City.
  w.stale = false;
  if(WD && WD.onChange) WD.onChange(function(nw){ if(!dead && W && nw && nw.hash !== W.hash) w.stale = true; });
  // hq3d's fallback to the legacy City (timeout, rejection) drops this world: stop the tiles and their worker
  w.destroy = function(){
    dead = true;
    if(wb){ wb.destroy(); wb = null; }
    S.remove(staticG); S.remove(hqG);
  };

  /* ---------- the world contract ---------- */
  w.net = "city3d";
  w.hits = hits; w.doors = doors; w.span = 18; w.zoom = 0.8; w.camY = 2.5; w.follow = 1; w.camPitch = 0.72;
  w.bounds = [-1018, 1018, -1018, 1018];
  w.camModes = ["map", "far", "chase", "near", "fp", "classic", "photo", "cine"];
  w.startMode = "map";
  w.skateBase = 0; w.skatepark = null;
  w.spawn = {x: 0, y: 0, z: 10, yaw: 0, camYaw: 0.55}; w.spawnFrom = {lobby: w.spawn};
  w.blocked = blocked;
  w.groundY = groundY;
  Object.defineProperty(w, "bikes", {get: function(){ return bikes; }, configurable: true});
  Object.defineProperty(w, "floor", {get: function(){ return wb ? wb.terrainMeshes() : []; }, configurable: true});
  // hq3d's quality governor and the ?hqsmoke stats line reach the tiles through these
  w.setQuality = function(q){ if(wb) wb.setQuality(q); };
  w.stats = function(){ return wb ? wb.stats() : {}; };
  w.onCity = function(){ build(); };
  w.onLook = function(){ forceYou = true; build(); };      // your own look: your building again
  w.camHit = function(from, to){
    if(!W) return 1;
    var t = WD.rayGround(W, from, to);
    var x0 = Math.min(from.x, to.x), x1 = Math.max(from.x, to.x), z0 = Math.min(from.z, to.z), z1 = Math.max(from.z, to.z);
    if(Math.hypot(to.x - from.x, to.z - from.z) > 60){ var u = 60/Math.hypot(to.x - from.x, to.z - from.z);   // only what is within 60 m
      x0 = Math.min(from.x, from.x + (to.x - from.x)*u); x1 = Math.max(from.x, from.x + (to.x - from.x)*u);
      z0 = Math.min(from.z, from.z + (to.z - from.z)*u); z1 = Math.max(from.z, from.z + (to.z - from.z)*u); }
    buildingsIn(x0, x1, z0, z1).concat(placedIn(x0, x1, z0, z1)).forEach(function(b){ var h = segBox(from, to, b); if(h < t) t = h; });
    return t;
  };
  w.occluderItems = function(x, y, z){
    if(!W) return [];
    return buildingsIn(x - 40, x + 40, z - 40, z + 40).map(function(b){ return {id: b.id, min: b.min, max: b.max}; })
      .concat(placedIn(x - 40, x + 40, z - 40, z + 40));
  };
  w.setFaded = function(ids){
    ids = ids || [];
    if(wb) wb.setFaded(ids.filter(function(id){ return typeof id === "number"; }).slice(0, 8));
    hqs.concat(views).forEach(function(E){ fadeGoal(E, ids.indexOf(E.oid) >= 0); });
  };
  w.mapPick = function(x, z){
    var E = pickAt(hqs, x, z);
    if(E) return {kind: "hq", you: !!E.h.isYou, userId: E.h.userId, door: {x: E.door.x, z: E.door.z}, name: E.name, lot: {x: E.lot.x/100, z: E.lot.z/100}};
    return {kind: "point", x: x, z: z};
  };
  w.mapInfo = function(){
    return {roads: W ? WD.roadLabels(W) : [],
      hqs: hqs.map(function(E){ return {userId: E.h.userId, name: E.name, x: E.lot.x/100, y: E.y, z: E.lot.z/100, you: !!E.h.isYou}; })};
  };
  w.setTime = function(n){ night = n; S.background = n ? skyBg.night : skyBg.day; fog.color.set(n ? 0x0f1f30 : 0xb8dcf2);
    hemi.intensity = n ? 1.3 : 2.4; sun.intensity = n ? 0.7 : 2.4; sun.color.set(n ? 0xa9b8ff : 0xfff2dc);
    if(wb) wb.setNight(n); applyTime(); };
  // Fading: in classic the buildings between you and hq3d's orthographic view (as hqbase.js
  // hqCutaway decides it); in every rig mode hq3d passes the occluders to w.setFaded. Switching
  // between the two clears the other's fades. Either way the fade itself eases (fadeStep).
  function cutawayGoals(){
    var me = c.avatar(), v = c.view && c.view(); if(!me || !v) return;
    var ux = Math.sin(v.yaw), uz = Math.cos(v.yaw), tp = Math.max(0.2, Math.tan(v.pitch));
    hqs.concat(views).forEach(function(L){
      var vx = L.x - me.x, vz = L.z - me.z, along = vx*ux + vz*uz, side = Math.abs(vx*uz - vz*ux);
      fadeGoal(L, along > 2 && side < (L.side || 14) && along < L.H/tp + 8);
    });
  }
  var fadeAcc = 0, lastMode = null, shadowKey = "", SUN_DIR = {x: 0.45, y: 0.79, z: 0.34};
  w.update = function(t, dt, k, cam){
    var mode = (cam && cam.mode) || "classic";
    if(mode !== lastMode){
      if(lastMode === "classic") hqs.concat(views).forEach(function(E){ fadeGoal(E, false); });
      if(mode === "classic") w.setFaded([]);
      lastMode = mode;
    }
    if(mode === "classic"){ fadeAcc += dt; if(fadeAcc > FADE_EVERY){ fadeAcc = 0; cutawayGoals(); } }
    hqs.concat(views).forEach(function(E){ fadeStep(E, dt, k); });
    if(wb && cam && cam.frustum) wb.update(cam);
    S.fog = mode === "map" ? null : fog;
    // HQs far from the camera are not drawn (the map shows them all)
    if(cam && cam.x != null) hqs.forEach(function(E){
      var d = Math.hypot(E.x - cam.x, E.z - cam.z), vis = mode === "map" || (E.g.visible ? d < HQ_FAR : d < HQ_FAR - HQ_FAR_HYST);
      if(E.g.visible !== vis) E.g.visible = vis;
    });
    // the sun's shadow box follows you (the whole map in map mode), on its texel grid
    var me = (cam && cam.avatar) || c.avatar() || {x: 0, z: 0}, map = mode === "map", R = map ? 1024 : 60, D = map ? 1500 : 120;
    var ay = me.y != null ? me.y : groundY(me.x, me.z);
    var sp = map ? {x: 0, y: 0, z: 0} : snapShadow({x: me.x, y: ay, z: me.z}, SUN_DIR, 2*R/(sun.shadow.mapSize.x || 2048));
    sun.target.position.set(sp.x, sp.y, sp.z);
    sun.position.set(sp.x + SUN_DIR.x*D, sp.y + SUN_DIR.y*D, sp.z + SUN_DIR.z*D);
    var key = R + ":" + D;
    if(key !== shadowKey){ shadowKey = key; var sc = sun.shadow.camera; sc.left = -R; sc.right = R; sc.top = R; sc.bottom = -R; sc.near = 1; sc.far = 2*D + 200; sc.updateProjectionMatrix(); }
    hqs.concat(views).forEach(function(E){ if(E.B && (!E.g || E.g.visible)) E.B.animate(t, dt, k); });
    if(fount) fount.step(t);
    cars.forEach(function(cr){ carStep(cr, dt, k); });
  };
  w.setTime(night);
  return w;
};
})();
