/* Claude HQ: the parts of Arena City, shared by both Cities.
 *
 * The fountain, the bike park, the skatepark and what stands beside every HQ (its garage, car,
 * motorbike and bicycle, and its lot's finish by level: lotDress). Moved out of games/hqcity.js unchanged, so the legacy City
 * (HQV.hqWorlds.city) and the generated 3D City (games/hqcity3d.js, HQV.hqWorlds.city3d) build
 * the same things. Every part takes the hq3d ctx `c` and the group to build into; nothing here
 * touches THREE until a part is called, so node can load the file with only a window stub.
 */
(function(){
"use strict";
var HQV = window.HQV = window.HQV || {};

/* ---------- the fountain: a stone basin, two bowls, falling water, a jet on top ---------- */
var FOUNT_R = 4.4;
// {g, step(t), R, at}: g stands at (x, y, z) in parent; step(t) runs the water (still under Calm); at {x, y, z}: its
// falling water's middle, in parent's frame (where it is heard)
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
  // at: where its water falls, in the parent's frame ([Sound PR B] games/hqcity3d.js plays the fountain there; [3.35]
  // its id is its place in the fountain kind's pool)
  return {g: g, step: step, R: FOUNT_R, at: {id: "fountain", x: x, y: y + 1.6, z: z}};
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
// (default 11). at: where the bay stands on a v2 lot {x, z, s, f, r}, else the legacy spot ([3.33] r: its door's quarter
// turns, 0 to the road .. 2 away; 1 and 3 sideways, with an 8 m apron out of the side door and the driveway from its end
// to the road, at.way; a moved bay). mine: your own HQ (its
// door goes down to "@basement"; anyone else's is a visit). The car, motorbike and bicycle moved down to the
// basement's showcase (games/hqbasement.js): items is []. Returns {items, glows, car: null, garage: {top,
// walls, on}, hits, doors, door, lift, move}: lift is HQV.hqCarLift.mesh's {update(state)} when that is loaded; move
// [3.33] your own bay's "Move garage" plate (a hit with userData.garageMove; not a door), else null.
function lotExtras(c, g, col, rot, toWorld, apronEnd, uid, at, mine){
  var THREE = c.THREE, PI = c.PI, mat = c.mat, emis = c.emis, box = c.box;
  var X = HQV.hqLotExtras, G = X.garage, glows = [], hits = [];
  var AE = apronEnd != null ? apronEnd : 11, sx = at && at.s === -1 ? -1 : 1, ox = at ? at.x - sx*G.x : 0, oz = at ? at.z - G.z : 0;
  var fz = at && at.f === -1 ? -1 : 1;     // the way its door faces: the road (+z), or away from the HQ (a bay behind it)
  var rq = at && (at.r === 0 || at.r === 1 || at.r === 2 || at.r === 3) ? at.r : fz < 0 ? 2 : 0;   // [3.33] its quarter turns
  if(rq === 0 || rq === 2) fz = rq === 2 ? -1 : 1;
  function lx(x){ return ox + sx*x; }
  var gg = new THREE.Group(); gg.position.set(lx(G.x), 0, oz + G.z); if(rq === 2) gg.rotation.y = PI; else if(rq) gg.rotation.y = rq*PI/2; g.add(gg);
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
  // (facing away from the HQ: a short apron behind it, the lot's back)
  var apronM = mat(0x323a43, {roughness: 0.9}), fp;
  if(rq % 2){
    // [3.33] a side door: the 8 m apron out of it, then the driveway from its end along the lot to the road (at.way)
    var ux = rq === 1 ? 1 : -1, bx = lx(G.x), bz = oz + G.z, s0 = bx + ux*G.d/2, s1 = s0 + ux*8;
    var sa = new THREE.Mesh(new THREE.PlaneGeometry(8, G.w - 0.4), apronM);
    sa.rotation.x = -PI/2; sa.position.set((s0 + s1)/2, 0.03, bz); sa.receiveShadow = true; g.add(sa);
    fp = toWorld(bx + ux*0.4, bz);
  } else {
    var a0 = oz + G.z + fz*G.d/2, a1 = fz > 0 ? AE : a0 - 3.2;
    var apron = new THREE.Mesh(new THREE.PlaneGeometry(G.w - 0.4, Math.max(0.1, Math.abs(a1 - a0))), apronM);
    apron.rotation.x = -PI/2; apron.position.set(lx(G.x), 0.03, (a0 + a1)/2); apron.receiveShadow = true; g.add(apron);
    // the door: drive (or walk) onto the platform. Yours goes down; anyone else's is their HQ, as a visitor
    fp = toWorld(lx(G.x), oz + G.z + fz*0.4);
  }
  // [3.33] a moved bay's driveway: each leg of at.way (lot frame) as a strip of paving 3.5 m wide
  var way = at && Array.isArray(at.way) ? at.way : null;
  if(way && way.length >= 2) for(var wi = 1; wi < way.length; wi++){
    var wa = way[wi - 1], wb = way[wi], wl = Math.hypot(wb.x - wa.x, wb.z - wa.z);
    if(!(wl > 0.1) || !isFinite(wl)) continue;
    var strip = new THREE.Mesh(new THREE.PlaneGeometry(3.3, wl + 3.3), apronM);
    strip.rotation.order = "YXZ"; strip.rotation.y = Math.atan2(wb.x - wa.x, wb.z - wa.z); strip.rotation.x = -PI/2;
    strip.position.set((wa.x + wb.x)/2, 0.035, (wa.z + wb.z)/2); strip.receiveShadow = true; g.add(strip);
  }
  var door = {view: mine ? "@basement" : "visit:" + uid, kind: "carlift", userId: uid, label: "Car lift",
              tip: mine ? "Car lift: down to your B1 basement garage (drive on, or walk on)" : "Their car lift: visit their HQ",
              front: new THREE.Vector3(fp.x, 0, fp.z)};
  [sg].forEach(function(o){ o.userData.door = door; hits.push(o); });
  // [3.33] your own bay: a "Move garage" plate on a post by its door (click: placement mode, games/hq3d.js garageView)
  var move = null;
  if(mine){
    var mp = c.canvasTex(256, 96, function(gx){ gx.fillStyle = "#0a1016"; gx.fillRect(0, 0, 256, 96); gx.fillStyle = "#7fd6ff"; gx.font = "800 34px system-ui, sans-serif";
      gx.textAlign = "center"; gx.fillText("MOVE \u21c4", 128, 44); gx.font = "600 22px system-ui, sans-serif"; gx.fillStyle = "#c9d3dc"; gx.fillText("GARAGE", 128, 78); });
    box(0.08, 1.2, 0.08, frameM, -G.w/2 - 0.55, 0.6, G.d/2 + 0.25, gg);
    move = c.screen(0.9, 0.34, mp.t); move.position.set(-G.w/2 - 0.55, 1.35, G.d/2 + 0.3); gg.add(move);
    move.userData.garageMove = true; move.userData.tip = "Move your garage: place it anywhere on your lot";
  }
  return {items: [], glows: glows, car: null, garage: {top: top, walls: walls, on: 0}, hits: hits, doors: [door], door: door, lift: lift, move: move};
}

/* ---------- an HQ lot's finish: the poshness of its owner's level, on the same lot for everyone ---------- */
// Every HQ lot is the same size; what its owner's usage (the HQ level) buys is the finish round the buildings, in tiers:
// 0 plain paving; 1 (level 10) lawns, trees and lamps; 2 (level 25) a stone forecourt, a fountain, planters and flag
// poles; 3 (level 40) marble paving, a gold trim round the lot and valet cars at the kerb. Built into g (the HQ's group,
// its frame: the door to +z) on R, the lot's outline in that frame (hqcity3d lotRing); keep: [[x, z, hx, hz]] what it
// stands clear of (the building, the walk to its door, the garage, its apron and driveway). Deterministic per owner
// (c.rng, mulberry32, seeded by uid). Pure placement in dressPlan (node-tested); lotDress builds it.
var DRESS_LEVELS = [10, 25, 40];
var DRESS_Y = 0.19;          // the lot's own ground (worldgeom: KERB + LIFT + PAD, 0.23 m) over the HQ's group (PAD_UP, 0.05 m): flat finish just on it
function dressTier(level){ level = level | 0; var t = 0; for(var i = 0; i < DRESS_LEVELS.length; i++) if(level >= DRESS_LEVELS[i]) t = i + 1; return t; }
function ringIn(R, x, z){
  var inside = false;
  for(var i = 0, j = R.length - 1; i < R.length; j = i++){
    var xi = R[i][0], zi = R[i][1], xj = R[j][0], zj = R[j][1];
    if((zi > z) !== (zj > z) && x < (xj - xi)*(z - zi)/(zj - zi) + xi) inside = !inside;
  }
  return inside;
}
// -> [{kind: "tree" | "lamp" | "planter" | "fountain" | "flag" | "car" | "lawn" | "forecourt", x, z, ...}] (lot frame, m)
function dressPlan(R, level, uid, keep, rngOf){
  var out = [], tier = dressTier(level);
  if(!R || R.length < 3) return out;
  keep = keep || [];
  var rnd = rngOf ? rngOf("lot:" + String(uid || "")) : function(){ return 0.5; };
  var x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  R.forEach(function(q){ x0 = Math.min(x0, q[0]); x1 = Math.max(x1, q[0]); z0 = Math.min(z0, q[1]); z1 = Math.max(z1, q[1]); });
  var used = [];
  // a piece of half size (hx, hz) at (x, z): inside the lot (its corners, a margin in), clear of keep and of what is placed
  function free(x, z, hx, hz){
    for(var i = -1; i <= 1; i += 2) for(var j = -1; j <= 1; j += 2) if(!ringIn(R, x + i*(hx + 0.4), z + j*(hz + 0.4))) return false;
    var all = keep.concat(used);
    for(var k = 0; k < all.length; k++){ var K = all[k]; if(Math.abs(x - K[0]) < hx + K[2] + 0.3 && Math.abs(z - K[1]) < hz + K[3] + 0.3) return false; }
    return true;
  }
  function put(o, hx, hz){ if(!free(o.x, o.z, hx, hz)) return false; used.push([o.x, o.z, hx, hz]); out.push(o); return true; }
  var foot = keep[0] || [0, 0, 0, 0], back = foot[1] - foot[3], front = foot[1] + foot[3];
  if(tier >= 1){
    // the lawns: behind the building and down its sides (flat: drawn under what stands on them)
    if(back - z0 > 2) out.push({kind: "lawn", x: (x0 + x1)/2, z: (z0 + back)/2, w: x1 - x0 - 1.2, d: back - z0 - 0.9});
    [-1, 1].forEach(function(sd){ var a = sd < 0 ? x0 : foot[0] + sd*foot[2], b = sd < 0 ? foot[0] - foot[2] : x1;
      if(b - a > 2) out.push({kind: "lawn", x: (a + b)/2, z: (back + front)/2, w: b - a - 1.0, d: front - back}); });
    // the trees: a row along the back and down the sides, about 5 m apart, each a little off the line
    var spots = [];
    for(var tx = x0 + 2.5; tx <= x1 - 2.5; tx += 5) spots.push([tx, z0 + 1.8]);
    for(var tz = z0 + 6.5; tz <= front; tz += 5){ spots.push([x0 + 1.8, tz]); spots.push([x1 - 1.8, tz]); }
    spots.forEach(function(q){ var x = q[0] + (rnd() - 0.5)*1.2, z = q[1] + (rnd() - 0.5)*0.8;
      put({kind: "tree", x: x, z: z, h: 4 + rnd()*2.5, cone: rnd() < 0.35}, 0.5, 0.5); });
  }
  if(tier >= 2){
    // the forecourt: stone across the front between the building and the pavement
    if(z1 - front > 2) out.push({kind: "forecourt", x: (x0 + x1)/2, z: (front + z1)/2, w: x1 - x0 - 1.2, d: z1 - front - 0.6});
    // the fountain: the first free spot either side of the walk, nearest the door
    var fz = front + (z1 - front)*0.4;
    [[7, fz], [-7, fz], [10, fz], [-10, fz], [13, fz], [-13, fz]].some(function(q){ return put({kind: "fountain", x: q[0], z: q[1], r: 1.8}, 1.9, 1.9); });
    // the planters flanking the walk to the door, and three flag poles at a front corner
    [[-2.6, front + 2.2], [2.6, front + 2.2], [-2.6, z1 - 1.6], [2.6, z1 - 1.6]].forEach(function(q){ put({kind: "planter", x: q[0], z: q[1]}, 0.5, 0.5); });
    [1, -1].some(function(sd){ var fx = sd*(x1 - 2.2), fzz = front + 1.6;
      if(!free(fx, fzz, 1.6, 0.4)) return false;
      [-1.2, 0, 1.2].forEach(function(o){ put({kind: "flag", x: fx + o, z: fzz, h: 7 + (o === 0 ? 1 : 0)}, 0.15, 0.15); });
      return true; });
  }
  if(tier >= 3){
    // the valet cars: two or three at the kerb, nose to tail, their colours the owner's own
    var PAL = [0x0e0f12, 0xf2f2f0, 0x8a0f1e, 0x13294b, 0xb9a06a, 0x3a3f45], n = 2 + (rnd() < 0.5 ? 1 : 0), placed = 0;
    for(var cx = x1 - 3; cx >= x0 + 3 && placed < n; cx -= 0.5){
      if(put({kind: "car", x: cx, z: z1 - 2.4, yaw: Math.PI/2, col: PAL[Math.floor(rnd()*PAL.length) % PAL.length]}, 2.2, 1.0)){ placed++; cx -= 4.2; }
    }
  }
  // the lamps along the frontage (last: round what stands there)
  if(tier >= 1) for(var lx = x0 + 3; lx <= x1 - 3; lx += 4) if(put({kind: "lamp", x: lx, z: z1 - 1.2, gold: tier >= 3}, 0.2, 0.2)) lx += 4;
  return out;
}
function lotDress(c, g, R, level, uid, keep, night){
  var THREE = c.THREE, PI = c.PI, mat = c.mat, tier = dressTier(level);
  var plan = dressPlan(R, level, uid, keep, function(k){ return c.rng(c.hashStr(k)); });
  var glows = [], blocks = [];
  var leaf = mat(0x3f8a4f, {roughness: 0.85}), leaf2 = mat(0x2e6b3d, {roughness: 0.85}), bark = mat(0x5b4331, {roughness: 0.9});
  var lawn = mat(0x5f9a4a, {roughness: 0.95}), stone = mat(tier >= 3 ? 0xece8e0 : 0xb9b3a8, {roughness: tier >= 3 ? 0.35 : 0.8});
  var steel = mat(0x3a4048, {metalness: 0.7, roughness: 0.35}), gold = mat(0xd8b34a, {metalness: 0.9, roughness: 0.25});
  function flat(m, w, d, x, z, y){ var o = new THREE.Mesh(new THREE.PlaneGeometry(w, d), m); o.rotation.x = -PI/2; o.position.set(x, y, z); o.receiveShadow = true; g.add(o); return o; }
  plan.forEach(function(o){
    if(o.kind === "lawn") flat(lawn, o.w, o.d, o.x, o.z, DRESS_Y + 0.012);
    else if(o.kind === "forecourt") flat(stone, o.w, o.d, o.x, o.z, DRESS_Y + 0.008);
    else if(o.kind === "tree"){
      c.cyl(0.12, 0.16, o.h*0.45, bark, o.x, o.h*0.225, o.z, g, 6);
      if(o.cone) c.add(new THREE.Mesh(new THREE.ConeGeometry(1.3, o.h*0.75, 8), leaf2), o.x, o.h*0.62, o.z, g);
      else { var cr = c.sph(1.4, leaf, o.x, o.h*0.68, o.z, g); cr.scale.set(1, 1.15, 1); }
      blocks.push([o.x, o.z, 0.35]);
    } else if(o.kind === "lamp"){
      c.cyl(0.06, 0.08, 4.2, o.gold ? gold : steel, o.x, 2.1, o.z, g, 6);
      c.box(0.5, 0.12, 0.5, o.gold ? gold : steel, o.x, 4.25, o.z, g);
      var gl = c.glow(0xffd9a0, 2.4, night ? 0.85 : 0.08); gl.position.set(o.x, 4.05, o.z); g.add(gl); glows.push(gl);
      blocks.push([o.x, o.z, 0.25]);
    } else if(o.kind === "planter"){
      c.box(0.9, 0.6, 0.9, stone, o.x, 0.3, o.z, g); c.sph(0.5, leaf2, o.x, 0.85, o.z, g);
      blocks.push([o.x, o.z, 0.6]);
    } else if(o.kind === "fountain"){
      c.cyl(o.r, o.r + 0.1, 0.55, stone, o.x, 0.27, o.z, g, 24);
      var wm = new THREE.MeshStandardMaterial({color: 0x5fb8dc, emissive: new THREE.Color(c.COL.cyan), emissiveIntensity: 0.2, roughness: 0.1, transparent: true, opacity: 0.88});
      c.cyl(o.r - 0.15, o.r - 0.15, 0.04, wm, o.x, 0.5, o.z, g, 24);
      c.cyl(0.25, 0.35, 1.3, stone, o.x, 0.95, o.z, g, 10); c.cyl(0.8, 0.2, 0.2, tier >= 3 ? gold : stone, o.x, 1.65, o.z, g, 16);
      blocks.push([o.x, o.z, o.r + 0.3]);
    } else if(o.kind === "flag"){
      c.cyl(0.05, 0.06, o.h, tier >= 3 ? gold : steel, o.x, o.h/2, o.z, g, 6);
      c.box(1.1, 0.7, 0.03, mat([0xc23b3b, 0x2f5fa8, 0xe8c24a][Math.abs(Math.round(o.x*10)) % 3], {roughness: 0.8}), o.x + 0.58, o.h - 0.5, o.z, g);
      blocks.push([o.x, o.z, 0.2]);
    } else if(o.kind === "car" && typeof c.car === "function"){
      var V = c.car(o.col, 0xd8b34a); V.g.position.set(o.x, 0, o.z); V.g.rotation.y = o.yaw; g.add(V.g);
      blocks.push([o.x, o.z, 0, 2.1, 0.95]);
    }
  });
  if(tier >= 3){
    // the gold trim round the lot: a thin band along each edge of its outline
    for(var i = 0, j = R.length - 1; i < R.length; j = i++){
      var a = R[j], b = R[i], len = Math.hypot(b[0] - a[0], b[1] - a[1]); if(!(len > 0.5)) continue;
      var t = c.box(len, 0.08, 0.14, gold, (a[0] + b[0])/2, DRESS_Y + 0.03, (a[1] + b[1])/2, g); t.rotation.y = -Math.atan2(b[1] - a[1], b[0] - a[0]);
    }
  }
  return {tier: tier, plan: plan, glows: glows, blocks: blocks};
}
// what the finish blocks at (x, z), the lot frame: a disc [x, z, r] or a box [x, z, 0, hx, hz]
function dressBlocked(D, x, z){
  var B = D && D.blocks; if(!B) return false;
  for(var i = 0; i < B.length; i++){ var b = B[i];
    if(b[2] > 0 ? Math.hypot(x - b[0], z - b[1]) < b[2] : Math.abs(x - b[0]) < b[3] && Math.abs(z - b[1]) < b[4]) return true; }
  return false;
}

/* ---------- an HQ lot's marks: its kerb all round and its plaque at the street front ---------- */
// Every HQ lot, taken or free, shows where it starts and ends (a low kerb a little inside its outline, so two lots side by
// side show two lines) and, at its street edge, a plaque: the lot's number and its owner's name, or "Available". Yours is
// amber. In the lot's frame (the door to +z, the street), on R (hqcity3d lotRing); keep: [[x, z, hx, hz]] what the plaque
// stands clear of (the building, its walk, the garage and its way out, the finish). Pure placement in markPlan.
var KERB_IN = 0.3, KERB_W = 0.4, KERB_H = 0.16;            // m: the kerb's inset from the outline, its width and height (0.11 m over the lot)
var PLAQUE = {w: 2.6, h: 1.25, d: 0.14, base: 0.45, up: 0.4};   // the plaque's panel (w x h x d) on a stone base, its bottom up
// a convex outline with every edge moved d m inwards (each corner where its two moved edges meet)
function insetRing(R, d){
  var n = R.length, area = 0;
  for(var i = 0; i < n; i++){ var p = R[i], q = R[(i + 1) % n]; area += p[0]*q[1] - q[0]*p[1]; }
  var sg = area > 0 ? 1 : -1, L = [];
  for(var k = 0; k < n; k++){                           // each edge as a point and a direction, moved along its inward normal
    var a = R[k], b = R[(k + 1) % n], dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1, nx = -dz/l*sg, nz = dx/l*sg;
    L.push({x: a[0] + nx*d, z: a[1] + nz*d, dx: dx/l, dz: dz/l});
  }
  return R.map(function(q, k){
    var A = L[(k + n - 1) % n], B = L[k], den = A.dx*B.dz - A.dz*B.dx;
    if(Math.abs(den) < 1e-9) return [B.x, B.z];
    var t = ((B.x - A.x)*B.dz - (B.z - A.z)*B.dx)/den;
    return [A.x + A.dx*t, A.z + A.dz*t];
  });
}
// -> {kerb: [outer ring, inner ring], plaque: {x, z, rot} | null} (lot frame, m). The plaque stands just inside the street
// edge (the edge facing +z most), turned along it, at the first spot along it clear of keep, the ends first (the walk to
// the door is in the middle).
function markPlan(R, keep){
  var out = {kerb: null, plaque: null};
  if(!R || R.length < 3) return out;
  keep = keep || [];
  out.kerb = [insetRing(R, KERB_IN), insetRing(R, KERB_IN + KERB_W)];
  var best = null;
  for(var i = 0, j = R.length - 1; i < R.length; j = i++){
    var a = R[j], b = R[i], len = Math.hypot(b[0] - a[0], b[1] - a[1]); if(!(len > 4)) continue;
    var nz = Math.abs(b[0] - a[0])/len, mz = (a[1] + b[1])/2;
    if(!best || nz > best.nz + 0.05 || (Math.abs(nz - best.nz) <= 0.05 && mz > best.mz)) best = {a: a, b: b, len: len, nz: nz, mz: mz};
  }
  if(!best) return out;
  var ux = (best.b[0] - best.a[0])/best.len, uz = (best.b[1] - best.a[1])/best.len;
  if(ux < 0){ ux = -ux; uz = -uz; var t = best.a; best.a = best.b; best.b = t; }     // a -> b runs +x
  var inw = KERB_IN + KERB_W + PLAQUE.base/2 + 0.1, hw = PLAQUE.w/2 + 0.1, hd = PLAQUE.base/2 + 0.1;
  var mx = (best.a[0] + best.b[0])/2, mzz = (best.a[1] + best.b[1])/2, rot = Math.atan2(-uz, ux);
  var bx = hw*Math.abs(ux) + hd*Math.abs(uz), bz = hw*Math.abs(uz) + hd*Math.abs(ux);    // its footprint's box in the lot's frame
  var tries = [], lim = best.len/2 - hw - 0.8;
  for(var s = lim; s >= 0; s -= 0.5){ tries.push(s); if(s > 0) tries.push(-s); }
  for(var k = 0; k < tries.length; k++){
    var sx = mx + ux*tries[k] + uz*inw, sz = mzz + uz*tries[k] - ux*inw;    // along the edge, then inward (-z side)
    var ok = keep.every(function(K){ return !(Math.abs(sx - K[0]) < bx + K[2] && Math.abs(sz - K[1]) < bz + K[3]); });
    if(ok){ out.plaque = {x: sx, z: sz, rot: rot}; return out; }
  }
  out.plaque = {x: mx + ux*Math.max(0, lim) + uz*inw, z: mzz + uz*Math.max(0, lim) - ux*inw, rot: rot};
  return out;
}
// the plaque's words: {num: "LOT 12", name (the owner's, or "Available"), tag: "YOUR LOT" | "HQ LOT"}; n the lot's number (its rank + 1)
function plaqueText(n, owner, mine){
  var name = typeof owner === "string" ? owner.replace(/\s+/g, " ").trim().slice(0, 28) : "";
  return {num: "LOT " + Math.max(1, n | 0), name: mine ? (name || "You") : name || "Available", tag: mine ? "YOUR LOT" : "HQ LOT"};
}
// Builds the marks into g (the lot's group, its frame). o: {n, owner, mine, keep, night}. -> {plan, blocks, mats (lit at
// night: setNight), panel}
function lotMarks(c, g, R, o){
  o = o || {};
  var THREE = c.THREE, PI = c.PI, mat = c.mat, plan = markPlan(R, o.keep), mine = !!o.mine, free = !o.owner && !mine;
  var out = {plan: plan, blocks: [], mats: [], panel: null, setNight: function(on){ out.mats.forEach(function(m){ m.emissiveIntensity = on ? m.userData.night : m.userData.day; }); }};
  if(!plan.kerb) return out;
  var col = mine ? 0xffb347 : free ? 0x5fbf6e : 0x2fa9c0;   // the minimap's colours: yours amber, taken cyan, free green
  var kerbM = new THREE.MeshStandardMaterial({color: col, roughness: 0.6, emissive: new THREE.Color(col)});
  kerbM.userData.day = 0; kerbM.userData.night = mine ? 0.75 : 0.4; out.mats.push(kerbM);
  var sh = new THREE.Shape(), hole = new THREE.Path();
  plan.kerb[0].forEach(function(q, k){ if(k) sh.lineTo(q[0], -q[1]); else sh.moveTo(q[0], -q[1]); });
  plan.kerb[1].forEach(function(q, k){ if(k) hole.lineTo(q[0], -q[1]); else hole.moveTo(q[0], -q[1]); });
  sh.holes.push(hole);
  var kerb = new THREE.Mesh(new THREE.ExtrudeGeometry(sh, {depth: KERB_H, bevelEnabled: false, curveSegments: 1}), kerbM);
  kerb.rotation.x = -PI/2; kerb.position.y = DRESS_Y; kerb.receiveShadow = true; g.add(kerb);
  var P = plan.plaque; if(!P) return out;
  var T = plaqueText(o.n, o.owner, mine);
  var bg = mine ? "#ffb347" : "#13202c", ink = mine ? "#1b1206" : "#eef3f6", acc = mine ? "#1b1206" : free ? "#7fd18b" : "#5fd3e6";
  var tex = c.canvasTex(256, 128, function(x){
    x.fillStyle = bg; x.fillRect(0, 0, 256, 128);
    x.fillStyle = acc; x.fillRect(0, 0, 256, 6); x.fillRect(0, 122, 256, 6);
    x.textAlign = "center"; x.textBaseline = "middle"; x.fillStyle = ink;
    x.font = "800 40px system-ui, sans-serif"; x.fillText(T.num, 128, 36);
    var fs = 26; x.font = "700 " + fs + "px system-ui, sans-serif";
    while(fs > 13 && x.measureText(T.name).width > 236){ fs -= 1; x.font = "700 " + fs + "px system-ui, sans-serif"; }
    x.fillText(T.name, 128, 76);
    x.fillStyle = acc; x.font = "800 15px system-ui, sans-serif"; x.fillText(T.tag, 128, 106);
  });
  var face = new THREE.MeshBasicMaterial({map: tex.t, toneMapped: false}), side = mat(mine ? 0xd8b34a : 0x2b3a48, {metalness: 0.5, roughness: 0.4});
  var pg = new THREE.Group(); pg.position.set(P.x, DRESS_Y, P.z); pg.rotation.y = P.rot; g.add(pg);
  c.box(PLAQUE.w + 0.2, PLAQUE.up, PLAQUE.base, mat(0x8f8a80, {roughness: 0.85}), 0, PLAQUE.up/2, 0, pg);
  var panel = new THREE.Mesh(new THREE.BoxGeometry(PLAQUE.w, PLAQUE.h, PLAQUE.d), [side, side, side, side, face, face]);
  panel.position.set(0, PLAQUE.up + PLAQUE.h/2, 0); panel.castShadow = true; pg.add(panel); out.panel = panel;
  // what it blocks, in the lot's frame: a box along the edge (turned: its bounding box)
  var cr = Math.abs(Math.cos(P.rot)), sr = Math.abs(Math.sin(P.rot)), bw = (PLAQUE.w + 0.2)/2, bd = PLAQUE.base/2;
  out.blocks.push([P.x, P.z, 0, bw*cr + bd*sr, bw*sr + bd*cr]);
  out.setNight(!!o.night);
  return out;
}

HQV.hqCityParts = {fountain: fountain, bikePark: bikePark, skatePark: skatePark, lotExtras: lotExtras, lamplit: lamplit, FOUNT_R: FOUNT_R,
  lotDress: lotDress, dressPlan: dressPlan, dressTier: dressTier, dressBlocked: dressBlocked, DRESS_LEVELS: DRESS_LEVELS, DRESS_Y: DRESS_Y,
  lotMarks: lotMarks, markPlan: markPlan, plaqueText: plaqueText, insetRing: insetRing, PLAQUE: PLAQUE};
})();
