/* Claude HQ: the parts of Arena City, shared by both Cities.
 *
 * The fountain, the bike park, the skatepark and what stands beside every HQ (its garage, car,
 * motorbike and bicycle). Moved out of games/hqcity.js unchanged, so the legacy City
 * (HQV.hqWorlds.city) and the generated 3D City (games/hqcity3d.js, HQV.hqWorlds.city3d) build
 * the same things. Every part takes the hq3d ctx `c` and the group to build into; nothing here
 * touches THREE until a part is called, so node can load the file with only a window stub.
 */
(function(){
"use strict";
var HQV = window.HQV = window.HQV || {};

/* ---------- the fountain: a stone basin, two bowls, falling water, a jet on top ---------- */
var FOUNT_R = 4.4;
// {g, step(t), R}: g stands at (x, y, z) in parent; step(t) runs the water (still under Calm)
function fountain(c, parent, x, y, z){
  var THREE = c.THREE, PI = c.PI, COL = c.COL, mat = c.mat;
  function lathe(pts, m, ly, p){
    var o = new THREE.Mesh(new THREE.LatheGeometry(pts.map(function(q){ return new THREE.Vector2(q[0], q[1]); }), 48), m);
    o.position.y = ly || 0; o.castShadow = true; o.receiveShadow = true; p.add(o); return o;
  }
  var g = new THREE.Group(), stone = mat(0xb9c2cb, {roughness: 0.7}), stone2 = mat(0x8f9aa6, {roughness: 0.75});
  // the basin: a low stone wall with a rim to sit on, and a water surface inside
  lathe([[3.9, 0], [4.4, 0], [4.45, 0.62], [4.3, 0.74], [4.0, 0.74], [3.92, 0.62], [3.9, 0.12], [0, 0.12]], stone, 0, g);
  var rip = c.canvasTex(256, 256, function(gx){
    gx.fillStyle = "#1d6f93"; gx.fillRect(0, 0, 256, 256);
    var R = c.rng(31); for(var i = 0; i < 70; i++){ gx.strokeStyle = "rgba(170,230,255," + (0.08 + R()*0.2) + ")"; gx.lineWidth = 1 + R()*2;
      gx.beginPath(); gx.ellipse(R()*256, R()*256, 8 + R()*30, 3 + R()*8, 0, 0, 7); gx.stroke(); }
  });
  rip.t.wrapS = rip.t.wrapT = THREE.RepeatWrapping; rip.t.repeat.set(3, 3);
  var waterM = new THREE.MeshStandardMaterial({map: rip.t, color: 0x7fd0f0, emissive: new THREE.Color(COL.cyan), emissiveIntensity: 0.28,
    transparent: true, opacity: 0.88, roughness: 0.15, metalness: 0.1});
  var pool = new THREE.Mesh(new THREE.CircleGeometry(3.9, 48), waterM); pool.rotation.x = -PI/2; pool.position.y = 0.52; g.add(pool);
  // the column and two bowls, each spilling a sheet of water into the one below
  lathe([[0.85, 0], [0.7, 0.15], [0.5, 0.3], [0.45, 1.2], [0.6, 1.45], [0, 1.45]], stone2, 0.1, g);
  lathe([[0.35, 0], [1.9, 0.2], [2.05, 0.32], [1.95, 0.38], [1.75, 0.3], [0.3, 0.18]], stone, 1.48, g);
  var bowl1 = new THREE.Mesh(new THREE.CircleGeometry(1.78, 40), waterM); bowl1.rotation.x = -PI/2; bowl1.position.y = 1.83; g.add(bowl1);
  lathe([[0.42, 0], [0.3, 0.2], [0.24, 0.85], [0.36, 1.0], [0, 1.0]], stone2, 1.75, g);
  lathe([[0.2, 0], [1.0, 0.12], [1.1, 0.24], [1.02, 0.29], [0.9, 0.22], [0.18, 0.12]], stone, 2.72, g);
  var bowl2 = new THREE.Mesh(new THREE.CircleGeometry(0.93, 32), waterM); bowl2.rotation.x = -PI/2; bowl2.position.y = 2.98; g.add(bowl2);
  lathe([[0.16, 0], [0.12, 0.25], [0.2, 0.4], [0.07, 0.62], [0, 0.66]], stone2, 2.95, g);
  var sheetT = c.canvasTex(64, 256, function(gx){
    gx.clearRect(0, 0, 64, 256); var R = c.rng(57);
    for(var i = 0; i < 26; i++){ var sx = R()*64, h = 30 + R()*120, sy = R()*256; gx.fillStyle = "rgba(200,240,255," + (0.25 + R()*0.45) + ")"; gx.fillRect(sx, sy, 1 + R()*2.5, h); gx.fillRect(sx, sy - 256, 1 + R()*2.5, h); }
  });
  sheetT.t.wrapS = sheetT.t.wrapT = THREE.RepeatWrapping; sheetT.t.repeat.set(14, 1);
  var sheetM = new THREE.MeshBasicMaterial({map: sheetT.t, transparent: true, opacity: 0.75, depthWrite: false, side: THREE.DoubleSide, toneMapped: false});
  var sheet1 = new THREE.Mesh(new THREE.CylinderGeometry(2.04, 2.22, 1.32, 48, 1, true), sheetM); sheet1.position.y = 1.18; g.add(sheet1);
  var sheet2 = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.24, 0.96, 40, 1, true), sheetM); sheet2.position.y = 2.53; g.add(sheet2);
  // the jet: drops thrown up from the top that arc down into the top bowl
  var NJ = 160, jp = new Float32Array(NJ*3), jr = c.rng(71), jets = [];
  for(var i = 0; i < NJ; i++) jets.push({a: jr()*PI*2, v: 0.55 + jr()*0.45, o: jr()});
  var jg = new THREE.BufferGeometry(); jg.setAttribute("position", new THREE.BufferAttribute(jp, 3));
  var jet = new THREE.Points(jg, new THREE.PointsMaterial({color: 0xcff2ff, size: 0.09, transparent: true, opacity: 0.9, depthWrite: false, toneMapped: false}));
  g.add(jet);
  var glow = c.glow(COL.cyan, 7, 0.25); glow.position.y = 1.2; g.add(glow);
  g.position.set(x, y, z); parent.add(g);
  function step(t){
    var calm = c.E.calm(), tt = calm ? 0 : t;        // Calm / reduced motion: still water
    rip.t.offset.set(tt*0.02, tt*0.035);
    sheetT.t.offset.y = tt*0.9;
    jet.visible = !calm;
    if(calm) return;
    for(var n = 0; n < jets.length; n++){
      var j = jets[n], u = (t*0.8 + j.o) % 1, r = u*0.82*j.v, jy = 3.6 + u*1.5*j.v - u*u*(1.5*j.v + 0.55);
      jp[n*3] = Math.cos(j.a)*r; jp[n*3 + 1] = jy; jp[n*3 + 2] = Math.sin(j.a)*r;
    }
    jet.geometry.attributes.position.needsUpdate = true;
  }
  return {g: g, step: step, R: FOUNT_R};
}

/* ---------- the skatepark (games/hqskate.js is its shape and physics) ---------- */
// Two quarter pipes facing each other, a fun box in the middle, a ledge and a rail, and a row of
// boards at one end: walk up to one and press E. Built from HQV.hqSkatePark, so every ramp you
// see is the one you ride on. The park is never rotated (the skate sim is not). opts.boardsSide:
// +1 (default) puts the boards along x = +HW - 0.5 facing -x; -1 along x = -HW + 0.5 facing +x.
// Returns {cx, cz, boards: [{g, x, z, yaw, color, kind: "skate"}]} (null without hqSkatePark);
// the caller adds the boards to its rideables.
function skatePark(c, parent, cx, y, cz, opts){
  var SP = HQV.hqSkatePark; if(!SP) return null;
  var THREE = c.THREE, PI = c.PI, HEX = c.HEX, mat = c.mat, emis = c.emis, box = c.box, cyl = c.cyl;
  var side = opts && opts.boardsSide < 0 ? -1 : 1;
  var g = new THREE.Group(); g.position.set(cx, y, cz); parent.add(g);
  var concrete = mat(0xa7b0b9, {roughness: 0.85}), wall = mat(0x77818b, {roughness: 0.9}), steel = mat(0xc4ccd4, {metalness: 0.85, roughness: 0.25});
  var paint = emis(0xffb347, 0xffb347, 0.25);
  var floorM = new THREE.MeshStandardMaterial({color: 0x8f99a3, roughness: 0.8});
  var fl = new THREE.Mesh(new THREE.PlaneGeometry(2*SP.HW, 2*SP.HD), floorM); fl.rotation.x = -PI/2; fl.position.y = 0.025; fl.receiveShadow = true; g.add(fl);
  [-1, 1].forEach(function(sx){ box(0.08, 0.02, 2*SP.HD, paint, sx*(SP.HW - 0.05), 0.04, 0, g, true); });   // painted edges
  // an extruded profile: pts are (along z, up) pairs; it is laid across the park's width (x)
  function profile(pts, depth, m){
    var sh = new THREE.Shape(); sh.moveTo(pts[0][0], pts[0][1]); for(var i = 1; i < pts.length; i++) sh.lineTo(pts[i][0], pts[i][1]);
    var o = new THREE.Mesh(new THREE.ExtrudeGeometry(sh, {depth: depth, bevelEnabled: false}), m); o.castShadow = true; o.receiveShadow = true; return o;
  }
  var Q = SP.QP;
  [-1, 1].forEach(function(end){
    var pts = [[Q.from, 0]];
    for(var i = 1; i <= 24; i++){ var t = Q.run*i/24; pts.push([Q.from + t, SP.height(0, end*(Q.from + t))]); }
    pts.push([Q.from + Q.run + 0.4, SP.QP_TOP], [Q.from + Q.run + 0.4, 0]);
    var qp = profile(pts, 2*SP.HW, [wall, concrete]);
    qp.rotation.y = end > 0 ? -PI/2 : PI/2; qp.position.x = end > 0 ? SP.HW : -SP.HW; g.add(qp);
    var cop = cyl(0.06, 0.06, 2*SP.HW, steel, 0, SP.QP_TOP + 0.02, end*(Q.from + Q.run), g, 10); cop.rotation.z = PI/2;   // the coping
  });
  var B = SP.BOX, box1 = profile([[-B.hd, 0], [-B.flat, B.top], [B.flat, B.top], [B.hd, 0]], 2*B.hw, [wall, concrete]);
  box1.rotation.y = -PI/2; box1.position.x = B.hw; g.add(box1);
  var Lg = SP.LEDGE;
  box(Lg.x1 - Lg.x0, Lg.top, 2*Lg.hd, wall, (Lg.x0 + Lg.x1)/2, Lg.top/2, 0, g);
  box(0.06, 0.04, 2*Lg.hd, steel, Lg.x1 - 0.03, Lg.top + 0.01, 0, g);              // its steel edge (grind it)
  var R = SP.RAIL, rail = cyl(0.04, 0.04, 2*R.hd, steel, R.x, R.top, 0, g, 10); rail.rotation.x = PI/2;
  [-R.hd, 0, R.hd].forEach(function(z){ cyl(0.03, 0.03, R.top, steel, R.x, R.top/2, z, g, 8); });
  // the boards, side by side at one end, noses into the park
  var list = [], cols = [0xff6b5b, 0x5fd3e6, 0xffb347, 0x9b8cf0];
  cols.forEach(function(col, i){
    var lx = side > 0 ? SP.HW - 0.5 : -(SP.HW - 0.5), lz = -7.2 + i*0.55, yaw = side > 0 ? -PI/2 : PI/2, Bd = c.board(col);
    Bd.g.position.set(lx, 0, lz); Bd.g.rotation.y = yaw; g.add(Bd.g);
    list.push({g: Bd.g, x: cx + lx, z: cz + lz, yaw: yaw, color: col, kind: "skate", id: "skate:" + i});
  });
  var sign = c.label("🛹 Skatepark · press E on a board", HEX.amber, 0.7); sign.position.set(side*(SP.HW - 0.5), 2.4, -6.4); g.add(sign);
  return {cx: cx, cz: cz, boards: list};
}

/* ---------- the bike park: a rack of bikes ---------- */
// Walk up to one and press E (hq3d.js does the riding). Returns the bikes: [{g, x, z, yaw, color}]
// in world coordinates. rot (default 0) turns the park about its centre: at 0 the bikes face -x.
function bikePark(c, parent, cx, y, cz, rot){
  var THREE = c.THREE, PI = c.PI, HEX = c.HEX, mat = c.mat, box = c.box;
  rot = rot || 0;
  var cr = Math.cos(rot), sr = Math.sin(rot);
  var list = [], g = new THREE.Group(); g.position.set(cx, y, cz); if(rot) g.rotation.y = rot; parent.add(g);
  var padT = c.canvasTex(128, 256, function(gx){ gx.fillStyle = "#4a5866"; gx.fillRect(0, 0, 128, 256); gx.strokeStyle = "rgba(255,255,255,.35)"; gx.lineWidth = 3;
    for(var py = 20; py < 256; py += 39){ gx.beginPath(); gx.moveTo(14, py); gx.lineTo(114, py); gx.stroke(); } });
  var pad = new THREE.Mesh(new THREE.PlaneGeometry(3.6, 9.6), new THREE.MeshStandardMaterial({map: padT.t, roughness: 0.85}));
  pad.rotation.x = -PI/2; pad.position.y = 0.035; pad.receiveShadow = true; g.add(pad);
  var steel = mat(0x9aa7b5, {metalness: 0.8, roughness: 0.3});
  // the rack: a rail with a hoop per slot, front wheels go in on the -x side
  box(0.06, 0.06, 9, steel, -0.7, 0.42, 0, g);
  var cols = [0xff6b5b, 0x5fd3e6, 0xffb347, 0x6fd38a, 0x9b8cf0, 0xe0559b];
  for(var i = 0; i < 6; i++){
    var z = -3.75 + i*1.5;
    var hoop = new THREE.Mesh(new THREE.TorusGeometry(0.34, 0.03, 6, 20, PI), steel); hoop.position.set(-0.7, 0.05, z); hoop.rotation.y = PI/2; hoop.castShadow = true; g.add(hoop);
    var B = c.bike(cols[i]); B.g.position.set(0, 0, z); B.g.rotation.y = -PI/2; g.add(B.g);
    list.push(rot ? {g: B.g, x: cx + z*sr, z: cz + z*cr, yaw: -PI/2 + rot, color: cols[i], id: "rack:" + i} : {g: B.g, x: cx, z: cz + z, yaw: -PI/2, color: cols[i], id: "rack:" + i});
  }
  var sign = c.label("🚲 Bike park · press E", HEX.green, 0.7); sign.position.set(0.9, 2.6, 0); g.add(sign);
  return list;
}

// Under a roof the sun never reaches: a lamp lights the paint (no extra light, so a city of
// garages costs nothing more to draw).
function lamplit(gr){ gr.traverse(function(o){ var m = o.material; if(m && m.color && m.emissive && !(m.emissiveIntensity > 0.5)){
  m.emissive.copy(m.color); m.emissiveIntensity = 0.28; } }); }

/* ---------- beside every HQ: the car-lift bay down to its B1 basement garage [basement 3.4] ---------- */
// Built into g (the HQ's group, the lot's frame: the door faces +z, the road is at z 11) in the HQ's colours
// col {paint, accent}, on the old garage's footprint (HQV.hqLotExtras.garage). rot is the lot's turn and
// toWorld(lx, lz) -> {x, z} maps the lot's frame to the world. apronEnd: the lot-local z the apron runs to
// (default 11). at: where the bay stands on a v2 lot {x, z, s}, else the legacy spot. mine: your own HQ (its
// door goes down to "@basement"; anyone else's is a visit). The car, motorbike and bicycle moved down to the
// basement's showcase (games/hqbasement.js): items is []. Returns {items, glows, car: null, garage: {top,
// walls, on}, hits, doors, door, lift}: lift is HQV.hqCarLift.mesh's {update(state)} when that is loaded.
function lotExtras(c, g, col, rot, toWorld, apronEnd, uid, at, mine){
  var THREE = c.THREE, PI = c.PI, mat = c.mat, emis = c.emis, box = c.box;
  var X = HQV.hqLotExtras, G = X.garage, glows = [], hits = [];
  var AE = apronEnd != null ? apronEnd : 11, sx = at && at.s === -1 ? -1 : 1, ox = at ? at.x - sx*G.x : 0, oz = at ? at.z - G.z : 0;
  function lx(x){ return ox + sx*x; }
  var gg = new THREE.Group(); gg.position.set(lx(G.x), 0, oz + G.z); g.add(gg);
  var walls = new THREE.Group(), top = new THREE.Group(); gg.add(walls); gg.add(top);
  var frameM = mat(0x2a3139, {metalness: 0.85, roughness: 0.3}), trimM = emis(col.accent, col.accent, 0.6);
  var glassM = mat(0x9fd6ee, {transparent: true, opacity: 0.22, roughness: 0.05, metalness: 0.2});
  var lift = null, CL = HQV.hqCarLift;
  if(CL && typeof CL.mesh === "function"){
    try { lift = CL.mesh(c, {w: G.w, d: G.d, h: G.h, col: col}); } catch(e){ lift = null; }
    if(lift && lift.g) walls.add(lift.g); else lift = null;
  }
  if(!lift){
    // the shaft (no car lift module): a sunk platform with chevrons, glass sides and back, steel posts
    var chev = c.canvasTex(128, 128, function(gx){ gx.fillStyle = "#1b2128"; gx.fillRect(0, 0, 128, 128); gx.fillStyle = "#f2b234";
      for(var k = -1; k < 5; k++){ gx.beginPath(); gx.moveTo(0, k*32); gx.lineTo(64, k*32 + 24); gx.lineTo(128, k*32); gx.lineTo(128, k*32 + 10); gx.lineTo(64, k*32 + 34); gx.lineTo(0, k*32 + 10); gx.fill(); } });
    var plat = new THREE.Mesh(new THREE.BoxGeometry(G.w - 0.6, 0.08, G.d - 0.4), new THREE.MeshStandardMaterial({map: chev.t, roughness: 0.55, metalness: 0.4}));
    plat.position.set(0, 0.04, 0); plat.receiveShadow = true; walls.add(plat);
    box(G.w, 0.14, 0.2, frameM, 0, 0.07, G.d/2 - 0.1, walls);                     // the sill
    box(0.06, G.h, G.d - 0.2, glassM, -G.w/2 + 0.1, G.h/2, 0, walls);
    box(0.06, G.h, G.d - 0.2, glassM, G.w/2 - 0.1, G.h/2, 0, walls);
    box(G.w - 0.2, G.h, 0.06, glassM, 0, G.h/2, -G.d/2 + 0.1, walls);
    [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(function(q){ box(0.2, G.h, 0.2, frameM, q[0]*(G.w/2 - 0.1), G.h/2, q[1]*(G.d/2 - 0.1), walls); });
  }
  // the canopy over it: a slab with an accent edge and the CAR LIFT sign (the same either way)
  box(G.w + 0.4, 0.22, G.d + 0.4, mat(0x1f262e, {roughness: 0.6, metalness: 0.4}), 0, G.h + 0.11, 0, top);
  box(G.w + 0.42, 0.08, 0.06, trimM, 0, G.h + 0.02, G.d/2 + 0.2, top);
  var sign = c.canvasTex(512, 96, function(gx){ gx.fillStyle = "#0a1016"; gx.fillRect(0, 0, 512, 96); gx.fillStyle = "#f2b234"; gx.font = "800 52px system-ui, sans-serif";
    gx.textAlign = "center"; gx.fillText(mine ? "\u25bc CAR LIFT \u00b7 B1" : "CAR LIFT", 256, 66); });
  var sg = c.screen(G.w*0.62, 0.62, sign.t); sg.position.set(0, G.h + 0.55, G.d/2 + 0.22); top.add(sg);
  var gl = c.glow(0xffd9a0, 2.2, 0.7); gl.position.set(0, G.h - 0.2, G.d/2 + 0.45); gg.add(gl); glows.push(gl);
  var inside = c.glow(0xbfe9ff, 3.0, 0.35); inside.position.set(0, G.h - 0.4, 0); gg.add(inside); glows.push(inside);
  // the apron from the bay to the road, with two guide lines in the accent
  var apron = new THREE.Mesh(new THREE.PlaneGeometry(G.w - 0.4, Math.max(0.1, AE - (oz + G.z + G.d/2))), mat(0x323a43, {roughness: 0.9}));
  apron.rotation.x = -PI/2; apron.position.set(lx(G.x), 0.03, (oz + G.z + G.d/2 + AE)/2); apron.receiveShadow = true; g.add(apron);
  // the door: drive (or walk) onto the platform. Yours goes down; anyone else's is their HQ, as a visitor
  var fp = toWorld(lx(G.x), oz + G.z + 0.4);
  var door = {view: mine ? "@basement" : "visit:" + uid, kind: "carlift", userId: uid, label: "Car lift",
              tip: mine ? "Car lift: down to your B1 basement garage (drive on, or walk on)" : "Their car lift: visit their HQ",
              front: new THREE.Vector3(fp.x, 0, fp.z)};
  [sg].forEach(function(o){ o.userData.door = door; hits.push(o); });
  return {items: [], glows: glows, car: null, garage: {top: top, walls: walls, on: 0}, hits: hits, doors: [door], door: door, lift: lift};
}

HQV.hqCityParts = {fountain: fountain, bikePark: bikePark, skatePark: skatePark, lotExtras: lotExtras, lamplit: lamplit, FOUNT_R: FOUNT_R};
})();
