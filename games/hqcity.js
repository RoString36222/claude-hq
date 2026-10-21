/* Claude HQ 2.1: Arena City, the street of open HQs.
 *
 * Everyone who opened their HQ to visitors has a building in a city of square blocks:
 * a grid of roads, the plaza on the middle block, each HQ on a block of its own facing
 * the road, built from that HQ's level, paint, accent, sign (its name, on the banners)
 * and decor. Your own building is one of them. Walk up to someone's front door to go
 * into their HQ as a visitor (their Lobby); your own door takes you into your Lobby.
 * Every tab of HQ has a building too (games/hqbase.js, HQV.hqViews): its door opens it.
 *
 * A floor of the 3D HQ: registered as HQV.hqWorlds.city and built by games/hq3d.js.
 * The street comes from ctx.api.city() (the Arena's list of open HQs: counts and
 * cosmetics only) and is rebuilt when that list changes (w.onCity). Everyone gets
 * the same layout from the same list (sorted by user id; the view buildings are a fixed
 * list), so the people walking the street (live presence, room "hq_city") stand in the
 * same places for everyone.
 */
(function(){
"use strict";
var HQV = window.HQV = window.HQV || {};
HQV.hqWorlds = HQV.hqWorlds || {};

var SKATE_DX = 11;          // the skatepark's centre, this far from the fountain (the bike park is on the other side)
var MAX_LOTS = 12;          // an Arena has a handful of members (5 today); room to spare
var BLOCK_W = 36, BLOCK_D = 26;   // a block: room for a whole campus with both wings (m)
var ROAD = 8;               // the road round every block (m)
var HQ_Z = 2, VIEW_Z = 6;   // how far forward of the block's middle each kind of building stands
var VIEW_DEPTH = 7;         // a view building's depth (games/hqbase.js VB_D)

// The city's layout from the list: who stands on which block. Pure, so it is easy to test.
// The plaza takes the middle block; HQs the blocks nearest it (by user id), then the view
// buildings. Every building faces +z, onto the road along the front of its block.
function layout(list){
  var hs = (list || []).filter(function(h){ return h && typeof h.userId === "string"; })
    .sort(function(a, b){ return a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0; });
  if(hs.length > MAX_LOTS){
    var you = hs.filter(function(h){ return h.isYou; });
    hs = hs.filter(function(h){ return !h.isYou; }).slice(0, MAX_LOTS - you.length).concat(you)
      .sort(function(a, b){ return a.userId < b.userId ? -1 : 1; });
  }
  var views = HQV.hqViews || [];
  var n = hs.length + views.length + 1, cols = Math.ceil(Math.sqrt(n)), rows = Math.ceil(n/cols);
  var PX = BLOCK_W + ROAD, PZ = BLOCK_D + ROAD;
  function cx(i){ return (i - (cols - 1)/2)*PX; }
  function cz(j){ return (j - (rows - 1)/2)*PZ; }
  var pi = Math.floor((cols - 1)/2), pj = Math.floor((rows - 1)/2), cells = [];
  for(var j = 0; j < rows; j++) for(var i = 0; i < cols; i++) if(i !== pi || j !== pj) cells.push({i: i, j: j, d: (i - pi)*(i - pi) + (j - pj)*(j - pj)});
  cells.sort(function(a, b){ return a.d - b.d || a.j - b.j || a.i - b.i; });
  function lot(cell, dz, front){
    var x = cx(cell.i), z = cz(cell.j) + dz;
    return {x: x, z: z, rot: 0, dx: 0, dz: 1, block: {x: cx(cell.i), z: cz(cell.j)}, door: {x: x, z: z + front}};
  }
  return {cols: cols, rows: rows, W: cols*PX, D: rows*PZ, plaza: {x: cx(pi), z: cz(pj)},
    lots: hs.map(function(h, k){ return Object.assign(lot(cells[k], HQ_Z, 4.8), {h: h}); }),          // under the canopy
    views: views.map(function(v, k){ return Object.assign(lot(cells[hs.length + k], VIEW_Z, VIEW_DEPTH/2 + 1.2), {v: v}); })};
}
HQV.hqCityLayout = layout;

// What stands beside every HQ, in its lot's own frame (the door faces +z, the road is at z 11):
// a garage in front of the right wing with its door to the road, and inside it, side by side and
// all facing out, the HQ's car, its motorbike and its bicycle. Drive or ride any of them (E).
// Clear of the tower, both wings and the path to the door; see tests/test_hq3d.py.
var LOT_EXTRAS = {
  garage: {x: 13.0, z: 6.7, w: 7.0, d: 6.2, h: 3.0},
  car: {x: 14.5, z: 7.8, yaw: 0, len: 3.9, wid: 1.76},  // forward is +z: nose at the open door
  moto: {x: 12.2, z: 8.2, yaw: 0},
  bike: {x: 10.8, z: 8.3, yaw: 0}
};
HQV.hqLotExtras = LOT_EXTRAS;
// what you cannot walk (or drive) through, in the lot's frame: the garage's three walls, and
// the car while it is parked (carParked; not while you are driving it), in its garage or, given
// at = {x, z, yaw} (lot frame), wherever it was left. The bike is not.
function lotExtraBlocked(x, z, carParked, at){
  var G = LOT_EXTRAS.garage, T = 0.2 + 0.3;   // wall + a body's width
  var inX = Math.abs(x - G.x) < G.w/2 + 0.3, inZ = z > G.z - G.d/2 - 0.3 && z < G.z + G.d/2;
  if(inX && Math.abs(z - (G.z - G.d/2)) < T) return true;                          // back wall
  if(inZ && (Math.abs(x - (G.x - G.w/2)) < T || Math.abs(x - (G.x + G.w/2)) < T)) return true;   // side walls
  return false;   // [basement 3.4] the car lives in the basement now: no car box (carParked, at, K kept for callers)
}
HQV.hqLotExtraBlocked = lotExtraBlocked;
// an HQ's own colours, read the way its building reads them (games/hqbase.js): paint and accent
function lotColors(look){
  look = look || {};
  var hex = function(v, d){ return /^#[0-9a-f]{6}$/i.test(v || "") ? parseInt(v.slice(1), 16) : d; };
  return {paint: hex(look.paint, 0x2a3c50), accent: hex(look.accent, 0xffb347)};
}
HQV.hqLotColors = lotColors;
function nameOf(h){
  var s = h.look && typeof h.look.sign === "string" && h.look.sign.trim();
  return s || ((h.trainerName || h.displayName || h.handle || "Someone") + "'s HQ");
}
HQV.hqCityName = nameOf;
// the lot's colours plus its plate text: the HQ's name, on its car's and motorbike's number plates
function plated(col, h){ col.plate = nameOf(h); return col; }
HQV.hqPlated = plated;

HQV.hqWorlds.city = function(c, w){
  var THREE = c.THREE, PI = c.PI, S = w.scene, COL = c.COL, HEX = c.HEX;
  var mat = c.mat, emis = c.emis, box = c.box, cyl = c.cyl, sph = c.sph;
  var hits = [], doors = [], night = true;
  var api = c.api || {};

  var hemi = new THREE.HemisphereLight(0xbcd7ff, 0x223322, 2.2); S.add(hemi);
  var sun = new THREE.DirectionalLight(0xffffff, 2.2); sun.position.set(40, 70, 30); sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048); S.add(sun); S.add(sun.target);
  var skyBg = {
    night: c.canvasTex(512, 512, function(g){ var gr = g.createLinearGradient(0, 0, 0, 512); gr.addColorStop(0, "#040a12"); gr.addColorStop(0.6, "#0b1826"); gr.addColorStop(1, "#16304a"); g.fillStyle = gr; g.fillRect(0, 0, 512, 512); var R = c.rng(9); for(var i = 0; i < 220; i++){ g.fillStyle = "rgba(255,255,255," + (0.25 + R()*0.7) + ")"; g.fillRect(R()*512, R()*330, 1, 1); } }).t,
    day: c.canvasTex(512, 512, function(g){ var gr = g.createLinearGradient(0, 0, 0, 512); gr.addColorStop(0, "#5ea6dc"); gr.addColorStop(1, "#cfe8f7"); g.fillStyle = gr; g.fillRect(0, 0, 512, 512); }).t
  };
  var grassT = c.canvasTex(256, 256, function(g){ var R = c.rng(4); g.fillStyle = "#1f3d2c"; g.fillRect(0, 0, 256, 256);
    for(var i = 0; i < 900; i++){ g.fillStyle = R() < 0.5 ? "rgba(46,92,58,.5)" : "rgba(22,48,33,.5)"; g.fillRect(R()*256, R()*256, 2 + R()*5, 2 + R()*5); } });
  grassT.t.wrapS = grassT.t.wrapT = THREE.RepeatWrapping;
  var paveT = c.canvasTex(256, 256, function(g){ g.fillStyle = "#3b4c5c"; g.fillRect(0, 0, 256, 256); g.strokeStyle = "rgba(255,255,255,.08)"; g.lineWidth = 2;
    for(var i = 0; i <= 256; i += 32){ g.beginPath(); g.moveTo(i, 0); g.lineTo(i, 256); g.stroke(); g.beginPath(); g.moveTo(0, i); g.lineTo(256, i); g.stroke(); } });
  paveT.t.wrapS = paveT.t.wrapT = THREE.RepeatWrapping;

  var streetG = new THREE.Group(); S.add(streetG);
  var city = {W: 80, D: 60, plaza: {x: 0, z: 0}, lots: [], views: []}, sig = null, lampGlows = [], cars = [], dyn = {facMats: [], glows: [], beacons: [], flags: [], leds: []};
  var fount = null, bikes = [], skate = null;
  var floor = null;
  function flat(geo, m, y){ var o = new THREE.Mesh(geo, m); o.rotation.x = -PI/2; o.position.y = y; o.receiveShadow = true; streetG.add(o); return o; }

  // one HQ on its lot: the same building as that HQ's own Base (games/hqbase.js), front facing the middle
  var lotsB = [], viewsB = [];
  function building(L){
    var h = L.h, cos = h.cos || {}, crew = h.crew || {}, name = nameOf(h);
    var g = new THREE.Group(); g.position.set(L.x, 0, L.z); g.rotation.y = L.rot; streetG.add(g);
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
      doorFront: function(){ return new THREE.Vector3(L.door.x, 0, L.door.z); }
    });
    g.add(B.g); B.setLive((crew.working | 0) + (crew.needs | 0)); B.setNight(night);
    var sub = c.label((h.isYou ? "You · " : "") + (crew.working | 0) + " working · " + (crew.needs | 0) + " need them", HEX.green, 0.7);
    sub.position.set(0, B.top() + 5.6, 0); g.add(sub);
    B.hits.forEach(function(o){ hits.push(o); }); B.doors.forEach(function(d){ doors.push(d); });
    L.B = B; L.H = B.top() + 2; L.fade = {g: B.g, on: false}; lotsB.push(B);
    var cr = Math.cos(L.rot), sr = Math.sin(L.rot);                               // the lot's frame -> the street's
    var X = HQV.hqCityParts.lotExtras(c, g, plated(lotColors(h.look), h), L.rot, function(x, z){ return {x: L.x + x*cr + z*sr, z: L.z - x*sr + z*cr}; }, null, h.userId, null, h.isYou);
    (X.hits || []).forEach(function(o){ hits.push(o); }); (X.doors || []).forEach(function(d){ doors.push(d); });   // [basement 3.4] the car lift
    X.glows.forEach(function(gl){ lampGlows.push(gl); }); L.car = X.car; L.garage = X.garage;
    X.items.forEach(function(b){ bikes.push(b); });
  }
  // the garage beside an HQ and its car, motorbike and bicycle: HQV.hqCityParts.lotExtras (games/hqcityparts.js)
  // one tab's building (games/hqbase.js): its door opens that tab
  function viewBuilding(L){
    var V = HQV.hqViewBuilding(c, L.v, {doorFront: function(){ return new THREE.Vector3(L.door.x, 0, L.door.z); }});
    V.g.position.set(L.x, 0, L.z); V.g.rotation.y = L.rot; streetG.add(V.g); V.setNight(night);
    V.hits.forEach(function(o){ hits.push(o); }); V.doors.forEach(function(d){ doors.push(d); });
    L.B = V; L.H = V.top() + 2; L.fade = {g: V.g, on: false}; viewsB.push(V);
  }

  function build(){
    var list = (api.city && api.city()) || [];
    var key = JSON.stringify(list.map(function(h){ return [h.userId, h.level, h.look, h.cos, h.crew, !!h.isYou]; }));
    if(key === sig) return; sig = key;
    while(streetG.children.length) streetG.remove(streetG.children[0]);
    hits.length = 0; doors.length = 0; lampGlows.length = 0; cars.length = 0; lotsB.length = 0; viewsB.length = 0;
    dyn = {facMats: [], glows: [], beacons: [], flags: [], leds: []};
    city = layout(list);
    var W = city.W, D = city.D, PX = BLOCK_W + ROAD, PZ = BLOCK_D + ROAD, P = city.plaza;
    var OX = W/2 + 22, OZ = D/2 + 22;                                   // the edge of the world, past the trees
    var gm = new THREE.MeshStandardMaterial({map: grassT.t, roughness: 0.95}); grassT.t.repeat.set(OX/6, OZ/6);
    floor = flat(new THREE.PlaneGeometry(2*OX, 2*OZ), gm, 0);
    // the roads: one along every row and column edge of the blocks, kerbs and a dashed middle line
    var roadM = mat(0x2a2f36, {roughness: 0.9}), kerbM = mat(0x8e9aa6), dashes = [];
    var xs = [], zs = [];
    for(var ri = 0; ri <= city.cols; ri++) xs.push(-W/2 + ri*PX);
    for(var rj = 0; rj <= city.rows; rj++) zs.push(-D/2 + rj*PZ);
    zs.forEach(function(z){ flat(new THREE.PlaneGeometry(W + ROAD, ROAD), roadM, 0.03).position.z = z;
      for(var x = -W/2; x < W/2; x += 2.6) if(!xs.some(function(x2){ return Math.abs(x - x2) < ROAD/2 + 0.6; })) dashes.push([x, z, 0]); });
    xs.forEach(function(x){ flat(new THREE.PlaneGeometry(ROAD, D + ROAD), roadM, 0.031).position.x = x;
      for(var z = -D/2; z < D/2; z += 2.6) if(!zs.some(function(z2){ return Math.abs(z - z2) < ROAD/2 + 0.6; })) dashes.push([x, z, PI/2]); });
    var dash = new THREE.InstancedMesh(new THREE.BoxGeometry(1.2, 0.02, 0.14), new THREE.MeshBasicMaterial({color: 0xffc86e, toneMapped: false}), Math.max(1, dashes.length));
    var m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
    dashes.forEach(function(d, n){ q.setFromAxisAngle(up, d[2]); m4.compose(new THREE.Vector3(d[0], 0.05, d[1]), q, new THREE.Vector3(1, 1, 1)); dash.setMatrixAt(n, m4); });
    dash.count = dashes.length; streetG.add(dash);
    // the blocks: a paved pavement round a lawn; the plaza block is paved all over
    paveT.t.repeat.set(BLOCK_W/5, BLOCK_D/5);
    var paveM = new THREE.MeshStandardMaterial({map: paveT.t, roughness: 0.9});
    for(var bi = 0; bi < city.cols; bi++) for(var bj = 0; bj < city.rows; bj++){
      var bx = -W/2 + (bi + 0.5)*PX, bz = -D/2 + (bj + 0.5)*PZ;
      var pv = flat(new THREE.PlaneGeometry(BLOCK_W, BLOCK_D), paveM, 0.02); pv.position.x = bx; pv.position.z = bz;
      var kb = flat(new THREE.PlaneGeometry(BLOCK_W + 0.3, BLOCK_D + 0.3), kerbM, 0.018); kb.position.x = bx; kb.position.z = bz;
      if(bx === P.x && bz === P.z) continue;
      var lawn = flat(new THREE.PlaneGeometry(BLOCK_W - 4, BLOCK_D - 4), gm, 0.022); lawn.position.x = bx; lawn.position.z = bz;
    }
    // the plaza on the middle block: a fountain, the bike park beside it, and the city's name
    var parts = HQV.hqCityParts;
    fount = parts.fountain(c, streetG, P.x, 0, P.z);
    bikes = parts.bikePark(c, streetG, P.x + 8.6, 0, P.z);
    skate = parts.skatePark(c, streetG, P.x - SKATE_DX, 0, P.z); w.skatepark = skate;
    if(skate) skate.boards.forEach(function(b){ bikes.push(b); });
    var nb = city.lots.length;
    var cityL = c.label("Arena City · " + nb + " HQ" + (nb === 1 ? "" : "s"), HEX.amber, 1.3); cityL.position.set(P.x, 6.4, P.z); streetG.add(cityL);
    function tree(x, z, sc){ var tg = new THREE.Group(); tg.position.set(x, 0, z); tg.scale.setScalar(sc); streetG.add(tg);
      cyl(0.2, 0.28, 1.2, mat(0x5a3d2a), 0, 0.6, 0, tg, 8);
      for(var cn = 0; cn < 3; cn++) c.add(new THREE.Mesh(new THREE.ConeGeometry(1.3 - cn*0.3, 1.6, 8), mat([0x2f6b45, 0x2a5f3d, 0x357a4f][cn])), 0, 1.6 + cn*0.9, 0, tg); }
    [[1, -1], [1, 1]].forEach(function(k){                                     // (the other two corners are the skatepark)
      var pt = new THREE.Group(); pt.position.set(P.x + k[0]*(BLOCK_W/2 - 3), 0, P.z + k[1]*(BLOCK_D/2 - 3)); streetG.add(pt);
      cyl(0.2, 0.28, 1.2, mat(0x5a3d2a), 0, 0.6, 0, pt, 8); sph(1.2, mat(0x3c8a4f, {roughness: 0.9}), 0, 2.1, 0, pt); });
    // street lamps on the corner of every crossing
    function lamp(x, z){ cyl(0.07, 0.1, 3.4, mat(0x2b3a48, {metalness: 0.6}), x, 1.7, z, streetG, 8); sph(0.16, emis(0xfff1d6, 0xffd9a0, 2), x, 3.3, z, streetG);
      var gl = c.glow(0xffd9a0, 2.2, 0.8); gl.position.set(x, 3.25, z); streetG.add(gl); lampGlows.push(gl); }
    xs.forEach(function(x){ zs.forEach(function(z){ lamp(x + ROAD/2 + 0.8, z + ROAD/2 + 0.8); }); });
    // trees round the edge of the city
    var tr = c.rng(77), nt = Math.min(160, Math.round((W + D)/3));
    for(var t = 0; t < nt; t++){
      var side = tr()*4 | 0, u = tr()*2 - 1, out = ROAD/2 + 4 + tr()*12;
      var tx = side < 2 ? u*(W/2 + 10) : (side === 2 ? -1 : 1)*(W/2 + out), tz = side < 2 ? (side === 0 ? -1 : 1)*(D/2 + out) : u*(D/2 + 10);
      tree(tx, tz, 0.8 + tr()*0.6);
    }
    // cars round the road on the edge of the city: [colour, speed (m/s; the sign is the way round)]
    [[0xd14a5c, 6], [0x4a7bd1, -5], [0xe0e4e8, 5.5], [0xffb347, -4.5], [0x3fa66a, 5], [0x8a4ad1, -6]].forEach(function(cd, n){
      var k = new THREE.Group(), bodyM = mat(cd[0], {metalness: 0.6, roughness: 0.3});
      box(1.9, 0.45, 0.95, bodyM, 0, 0.42, 0, k); box(1.0, 0.42, 0.85, mat(0x0b1622, {metalness: 0.6, roughness: 0.15}), -0.1, 0.82, 0, k);
      var lane = cd[1] > 0 ? -1.4 : 1.4, ax = W/2 + lane, az = D/2 + lane;
      streetG.add(k); cars.push({g: k, s: n/6*2*(2*ax + 2*az), v: cd[1], ax: ax, az: az});
    });
    city.lots.forEach(building);
    city.views.forEach(viewBuilding);
    w.floor = floor; w.bounds = [-OX + 2, OX - 2, -OZ + 2, OZ - 2];
    applyTime();
  }
  // Arriving: at your own door, or (right after a visit) the door of the HQ you just left. Worked out
  // when you arrive, not when the street was built: a street built during a visit used to keep
  // sending you to that HQ's door ever after. The camera stands on the street side, looking at the
  // building's front (a little off-axis). home: the pavement at your door, while your HQ is on the street.
  function lotOf(pick){ return city.lots.filter(pick)[0] || null; }
  function at(L){ return L ? {x: L.door.x + L.dx*2.6, z: L.door.z + L.dz*2.6, yaw: Math.atan2(L.dx, L.dz), camYaw: L.rot + 0.55}
                           : {x: city.plaza.x, z: city.plaza.z + 7, yaw: 0}; }
  function mine(){ return lotOf(function(L){ return L.h.isYou; }); }
  Object.defineProperty(w, "spawn", {get: function(){
    var back = api.cityReturn && api.cityReturn(), ret = back ? lotOf(function(L){ return L.h.userId === back; }) : null;
    return at(ret || mine());
  }, configurable: true});
  Object.defineProperty(w, "home", {get: function(){ var L = mine(); return L ? at(L) : null; }, configurable: true});
  w.spawnFrom = {};
  Object.defineProperty(w.spawnFrom, "lobby", {get: function(){ return at(mine()); }, enumerable: true});

  /* ---------- the fountain, the skatepark and the bike park: games/hqcityparts.js ---------- */
  var FOUNT_R = HQV.hqCityParts.FOUNT_R;

  function applyTime(){
    lotsB.concat(viewsB).forEach(function(B){ B.setNight(night); });
    lampGlows.forEach(function(g){ g.material.opacity = night ? 0.85 : 0.08; });
  }
  function blocked(x, z){
    if(Math.abs(x) > city.W/2 + 18 || Math.abs(z) > city.D/2 + 18) return true;
    if(Math.hypot(x - city.plaza.x, z - city.plaza.z) < FOUNT_R + 0.35) return true;   // the fountain
    if(skate && HQV.hqSkatePark.walkBlocked(x - skate.cx, z - skate.cz)) return true;      // its ramps (on foot or wheels; boards ride them)
    var all = city.lots.concat(city.views);
    for(var i = 0; i < all.length; i++){
      var L = all[i], rx = x - L.x, rz = z - L.z, c0 = Math.cos(-L.rot), s0 = Math.sin(-L.rot);
      var lx = rx*c0 + rz*s0, lz = -rx*s0 + rz*c0;              // into the lot's own frame
      if(L.B && L.B.blockedLocal(lx, lz)) return true;
      // its garage, and its car (where it stands: you may have parked it in the street) unless you drive it
      if(L.h && lotExtraBlocked(lx, lz, !L.car || L.car.g.visible, L.car && {x: L.car.g.position.x, z: L.car.g.position.z, yaw: L.car.g.rotation.y})) return true;
    }
    return false;
  }

  build();
  w.hits = hits; w.doors = doors; w.span = 18; w.zoom = 0.8; w.camY = 2.5; w.follow = 1; w.camPitch = 0.72;
  w.blocked = blocked;
  Object.defineProperty(w, "bikes", {get: function(){ return bikes; }, configurable: true});
  // where each HQ stands now ({u, x, z}): hq3d.js keeps you (and what you parked) with your block
  // when someone joins or leaves and the street is laid out again
  Object.defineProperty(w, "lots", {get: function(){ return city.lots.map(function(L){ return {u: L.h.userId, x: L.x, z: L.z}; }); }, configurable: true});
  w.onCity = function(){ build(); };
  w.setTime = function(n){ night = n; S.background = n ? skyBg.night : skyBg.day; S.fog = new THREE.Fog(n ? 0x0f1f30 : 0xb8dcf2, 90, 220);
    hemi.intensity = n ? 1.3 : 2.4; sun.intensity = n ? 0.7 : 2.4; sun.color.set(n ? 0xa9b8ff : 0xfff2dc);
    var sc = sun.shadow.camera, R = Math.max(city.W, city.D)/2 + 30; sc.left = -R; sc.right = R; sc.top = R; sc.bottom = -R; sc.far = 260; sc.updateProjectionMatrix(); applyTime(); };
  w.onLook = function(){ sig = null; build(); };
  // A building between you and the camera fades (games/hqbase.js), so you are never lost behind a tower.
  var fadeAcc = 0;
  function cutaway(){ HQV.hqCutaway(c, city.lots.concat(city.views)); fadeGarages(); }
  // Inside a garage (on foot, or getting into the car or onto a bike) its roof would hide you from
  // the camera above: it fades to a ghost while you are under it, and the whole garage does while
  // it stands between you and the camera (as the buildings do, games/hqbase.js cutaway).
  function ghost(g, on){
    g.traverse(function(o){ if(!o.isMesh) return; var m = o.material;
      m.transparent = on; m.opacity = on ? 0.18 : 1; m.depthWrite = !on; m.needsUpdate = true; o.castShadow = !on; });
  }
  function fadeGarages(){
    var me = c.avatar(), v = c.view && c.view(), G = LOT_EXTRAS.garage; if(!me || !v) return;
    var ux = Math.sin(v.yaw), uz = Math.cos(v.yaw), reach = G.h/Math.max(0.2, Math.tan(v.pitch)) + 4;
    city.lots.forEach(function(L){
      if(!L.garage) return;
      var rx = me.x - L.x, rz = me.z - L.z, c0 = Math.cos(-L.rot), s0 = Math.sin(-L.rot);
      var lx = rx*c0 + rz*s0, lz = -rx*s0 + rz*c0;
      var inside = Math.abs(lx - G.x) < G.w/2 + 0.6 && lz > G.z - G.d/2 - 0.6 && lz < G.z + G.d/2 + 1.2;
      // the garage's middle in the street's frame, against the line from you to the camera
      var gx = L.x + G.x*Math.cos(L.rot) + G.z*Math.sin(L.rot) - me.x, gz = L.z - G.x*Math.sin(L.rot) + G.z*Math.cos(L.rot) - me.z;
      var along = gx*ux + gz*uz, side = Math.abs(gx*uz - gz*ux);
      var hides = !inside && along > 0.5 && along < reach && side < Math.max(G.w, G.d)/2 + 0.8;
      var on = hides ? 2 : inside ? 1 : 0;
      if(L.garage.on === on) return;
      L.garage.on = on; ghost(L.garage.top, on > 0); ghost(L.garage.walls, on === 2);
    });
  }
  // a point s metres round the rectangle with half-sides ax, az (clockwise seen from above), and its heading
  function rectAt(s, ax, az){
    var per = 4*(ax + az); s = ((s % per) + per) % per;
    if(s < 2*ax) return {x: -ax + s, z: -az, dx: 1, dz: 0}; s -= 2*ax;
    if(s < 2*az) return {x: ax, z: -az + s, dx: 0, dz: 1}; s -= 2*az;
    if(s < 2*ax) return {x: ax - s, z: az, dx: -1, dz: 0}; s -= 2*ax;
    return {x: -ax, z: az - s, dx: 0, dz: -1};
  }
  w.update = function(t, dt, k){
    fadeAcc += dt; if(fadeAcc > 0.15){ fadeAcc = 0; cutaway(); }
    lotsB.concat(viewsB).forEach(function(B){ B.animate(t, dt, k); });
    if(fount) fount.step(t);
    cars.forEach(function(cr){ cr.s += cr.v*dt*k; var p = rectAt(cr.s, cr.ax, cr.az), sg = cr.v < 0 ? -1 : 1;
      cr.g.position.set(p.x, 0, p.z); cr.g.rotation.y = Math.atan2(-p.dz*sg, p.dx*sg); });
  };
  return w;
};
})();
