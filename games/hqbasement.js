/* Claude HQ 3.4: the Basement Garage (B1), under your HQ. HQV.hqWorlds.basement and HQV.hqBasement.
 *
 * A lavish private garage, entered by the car lift from the street (drive on, drive down) or by the person lift
 * from the Lobby: polished dark epoxy with mirrored light strips, instanced columns with uplights, continuous LED
 * ceiling strips, your HQ's name in neon on the back wall, a showcase gallery of fifteen turntable plinths [3.5.4]:
 * S1-S3 for the starter car, motorbike and bicycle, then one per bay (bay i on slot 3 + i; only the bays your level
 * has unlocked are lit, the rest are dim plinths reading "Unlocks at level N"), each with a spot, a halo and a
 * placard naming what stands on it, an EV charging corner, a lounge behind glass (with an open doorway), the car-lift platform, the person-lift
 * doors and the garage-manager kiosk. Everything decorative is seeded from hashStr(uid), so your basement looks
 * the same every visit and different from a friend's.
 *
 * A rig world (camModes) at y = 0; the underground is purely visual (low ceiling, no sky, dark ambience).
 *
 * Talks to its peers only when they are there (each optional):
 *   HQV.hqCarLift   mesh(c, opts) for the pad, padSpot()
 *   HQV.hqGarageMgr homes(), onChange(fn), transfer(id, home, bay), kiosk(c, from)
 *   HQV.hqBasementFx liftArrival / lobbyRide / plinths / trophyWall / lounge / lighting / photoSpot
 *   HQV.hqGarage    mine(), onChange(fn)      HQV.hqVehicleModels build(c, entry, paint)
 *
 * Pure helpers (HQV.hqBasement): layout(level|{max, r}, r), slotPose(s), bayPose(i), fitR(r), nameFor(h), basementMax(level), lockLevel(i),
 * paintHex(entry, paint), basementRows(list, homes), blockedAt(L, x, z, riding), adopt(w, ride), toast(c, msg).
 */
(function(){
"use strict";
var HQV = window.HQV = window.HQV || {};
HQV.hqWorlds = HQV.hqWorlds || {};

var PI = Math.PI;
var HW = 32, HD = 20;            // half width (x) and half depth (z), metres: a 64 x 40 floor
var CEIL = 4.6, CAM_CEIL = 4.2;  // the slab, and where the camera stops under it
var NBAYS = 12, NSTART = 3, NSLOTS = NSTART + NBAYS;
var PAD = {x: 24.5, z: 6.5, w: 7, d: 6.2, yaw: -PI/2};          // the car-lift platform (the city bay's footprint)
// [3.5.4] one showcase gallery: every B1 vehicle on its own plinth. Slots 0-2 the starters (S1-S3, by the walnut
// wall), 3-14 the twelve bays (bay i = slot 3 + i, so the Arena's bay index maps 1:1). Two rows of turntables on one
// pitch: [3.11.1] seven along the back wall (right to left, clear of the lounge), eight down the front (left to right).
// The radius fits the largest vehicle as drawn (fitted at runtime from the catalogue's shown dims and the built
// models' bounding boxes), capped so neighbours never touch: 3.45 m takes the 5.8 m i7 turning with room to spare.
var GAL = {back: -15.6, front: 14.4, pitch: 7.25, xBack: -18.8, xFront: -25.4, nBack: 7};
var R_MIN = 2.3, R_DEF = 3.0, R_MAX = Math.round((GAL.pitch - 0.35)/2*100)/100, CARD_OFF = R_MAX + 0.45;   // 3.45 m
var PLINTH_R = R_DEF;
var LIFT = {x: -HW + 0.3, z: 9};                                 // the person-lift doors, on the left wall
var KIOSK = {x: -24.5, z: 3.2};
var LOUNGE = {x0: -HW, x1: -22.6, z0: -HD, z1: -6};              // behind glass, back left
var LDOOR = {z0: -10.7, z1: -8.3};                               // [3.5.4] the lounge's open doorway in its hall-side glass
var LFURN = [[-27.5, -12.6, 2.2, 0.7], [-29.9, -10.9, 0.65, 1.7], [-27.4, -10.6, 1.2, 0.65], [-27.2, -18.4, 2.9, 0.5]];   // sofas, table, bar: [x, z, half w, half d]
var EV = {x: 13, z: 16.4};                                       // the charging corner, front right
var COLS = [];
[-19.3, -10.1, -0.9, 8.3].forEach(function(x){ COLS.push({x: x, z: -8.4}, {x: x, z: 8.4}); });
COLS.push({x: 16, z: -6.5}, {x: 16, z: 1.2});

function basementMax(level){ var l = Math.max(0, Math.floor(+level || 0)); return Math.min(NBAYS, 4 + Math.floor(l/5)); }
// the level a bay unlocks at: max > i  <=>  floor(level/5) >= i - 3
function lockLevel(i){ return Math.max(0, (i - 3)*5); }
// a gallery slot's pose: the back row runs right to left from the walnut wall, the front row left to right
function slotPose(s){
  s = Math.max(0, Math.min(NSLOTS - 1, s | 0));
  var back = s < GAL.nBack, k = back ? GAL.nBack - 1 - s : s - GAL.nBack;
  return {slot: s, x: Math.round(((back ? GAL.xBack : GAL.xFront) + k*GAL.pitch)*100)/100, z: back ? GAL.back : GAL.front, yaw: back ? PI/6 : PI + PI/6, face: back ? 1 : -1};
}
function bayPose(i){
  i = i | 0; var P = slotPose(NSTART + i);
  return {i: i, x: P.x, z: P.z, yaw: P.yaw, w: 2*R_MAX, d: 2*R_MAX, label: String(i + 1), slot: P.slot};
}
function fitR(r){ r = +r; return isFinite(r) && r > 0 ? Math.max(R_MIN, Math.min(R_MAX, r)) : R_DEF; }
function layout(level, r){
  var max = level && typeof level === "object" ? Math.max(0, Math.min(NBAYS, level.max | 0)) : basementMax(level);
  r = fitR(r != null ? r : level && typeof level === "object" ? level.r : null);
  var bays = [], plinths = [];
  for(var i = 0; i < NBAYS; i++){ var b = bayPose(i); b.lit = i < max; b.unlock = lockLevel(i); bays.push(b); }
  for(var s = 0; s < NSLOTS; s++){
    var P = slotPose(s), bay = s >= NSTART ? s - NSTART : null;
    plinths.push({slot: s, x: P.x, z: P.z, r: r, yaw: P.yaw, face: P.face, bay: bay, lit: bay == null || bay < max, unlock: bay == null ? 0 : lockLevel(bay),
      label: bay == null ? "S" + (s + 1) : String(bay + 1), kind: bay == null ? ["car", "moto", "bike"][s] : null,
      card: {x: P.x, z: P.z + P.face*CARD_OFF}});
  }
  return {W: 2*HW, D: 2*HD, ceil: CEIL, max: max, r: r, bays: bays, plinths: plinths,
          pad: {x: PAD.x, z: PAD.z, w: PAD.w, d: PAD.d, yaw: PAD.yaw},
          lift: {x: LIFT.x, z: LIFT.z, front: {x: LIFT.x + 2.2, z: LIFT.z, yaw: PI/2}},
          kiosk: {x: KIOSK.x, z: KIOSK.z}, lounge: {x0: LOUNGE.x0, x1: LOUNGE.x1, z0: LOUNGE.z0, z1: LOUNGE.z1, door: {z0: LDOOR.z0, z1: LDOOR.z1}}, ev: EV, cols: COLS.slice()};
}
function nameFor(h){
  if(HQV.hqCityName && h) try { return String(HQV.hqCityName(h)); } catch(e){}
  var s = h && h.look && typeof h.look.sign === "string" && h.look.sign.trim();
  return s || ((h && (h.trainerName || h.displayName || h.handle)) || "Claude") + "'s HQ";
}
// a paint index into the catalogue entry's paints (or "#rrggbb", or a 24-bit number) -> a 24-bit number
function paintHex(entry, paint){
  var ps = entry && entry.paints;
  if(typeof paint === "number" && paint >= 0 && paint < 64 && (paint | 0) === paint && ps && ps[paint]) paint = ps[paint].hex || ps[paint];
  if(typeof paint === "string" && /^#[0-9a-fA-F]{6}$/.test(paint)) return parseInt(paint.slice(1), 16);
  if(typeof paint === "number" && paint >= 64 && paint <= 0xffffff) return paint | 0;
  var p0 = ps && ps[0]; p0 = p0 && (p0.hex || p0);
  return typeof p0 === "string" && /^#[0-9a-fA-F]{6}$/.test(p0) ? parseInt(p0.slice(1), 16) : 0x8a96a3;
}
// the owned vehicles drawn here: homed in the basement and not out on the street; each with a bay (its own, else
// the lowest free one), so two never share a bay
function basementRows(list, homes, max){
  var H = (homes && homes.homes) || {}, out = [], used = {};
  max = max == null ? NBAYS : Math.max(0, Math.min(NBAYS, max | 0));
  (Array.isArray(list) ? list : []).forEach(function(v){
    if(!v || v.id == null || typeof v.vehicle_id !== "string" || v.parked) return;
    var h = H[v.id]; if(!h || h.home !== "basement") return;
    out.push({v: v, bay: h.bay != null && isFinite(h.bay) ? h.bay | 0 : null});
  });
  out.sort(function(a, b){ return String(a.v.id) < String(b.v.id) ? -1 : 1; });
  out.forEach(function(r){ if(r.bay != null && r.bay >= 0 && r.bay < NBAYS && !used[r.bay]) used[r.bay] = 1; else r.bay = null; });
  out.forEach(function(r){ if(r.bay != null) return; for(var i = 0; i < NBAYS; i++) if(!used[i]){ used[i] = 1; r.bay = i; return; } r.bay = -1; });
  return out.filter(function(r){ return r.bay >= 0; }).map(function(r){ return {id: r.v.id, vehicle_id: r.v.vehicle_id, paint: r.v.paint, bay: r.bay, lit: r.bay < max}; });
}
function blockedAt(L, x, z, riding){
  if(x < -HW + 0.7 || x > HW - 0.7 || z < -HD + 0.7 || z > HD - 0.7) return true;
  for(var i = 0; i < COLS.length; i++) if(Math.abs(x - COLS[i].x) < 0.65 && Math.abs(z - COLS[i].z) < 0.65) return true;
  // the lounge glass [3.5.5: with an open doorway in the hall-side wall], and its furniture on foot
  if(Math.abs(x - LOUNGE.x1) < 0.35 && z < LOUNGE.z1 + 0.35 && !(z > LDOOR.z0 + 0.3 && z < LDOOR.z1 - 0.3)) return true;
  if(Math.abs(z - LOUNGE.z1) < 0.35 && x < LOUNGE.x1 + 0.35) return true;
  if(!riding) for(var f = 0; f < LFURN.length; f++) if(Math.abs(x - LFURN[f][0]) < LFURN[f][2] + 0.25 && Math.abs(z - LFURN[f][1]) < LFURN[f][3] + 0.25) return true;
  // every gallery plinth (and its placard post) on foot; riding drives on and off them
  var PL = (L && L.plinths) || layout(0).plinths;
  if(!riding) for(var p = 0; p < PL.length; p++){
    if(Math.hypot(x - PL[p].x, z - PL[p].z) < (PL[p].r || PLINTH_R) - 0.2) return true;
    if(PL[p].card && Math.hypot(x - PL[p].card.x, z - PL[p].card.z) < 0.3) return true;
  }
  if(Math.hypot(x - KIOSK.x, z - KIOSK.z) < 0.6) return true;
  if(Math.abs(x - EV.x) < 4.2 && z > EV.z + 1.6) return true;                                  // the chargers against the front wall
  return false;
}

// a small, accessible status toast (textContent only), in the 3D view's element
var toastT = null;
function toast(c, msg){
  try {
    var host = (c && c.el) || (typeof document !== "undefined" && document.body); if(!host || !host.appendChild || typeof document === "undefined") return null;
    var t = host.querySelector && host.querySelector(".hqbasement-toast");
    if(!t){ t = document.createElement("div"); t.className = "hqbasement-toast"; t.setAttribute("role", "status"); t.setAttribute("aria-live", "polite");
      t.style.cssText = "position:absolute;left:50%;bottom:84px;transform:translateX(-50%);padding:8px 14px;border-radius:10px;font:600 13px system-ui,sans-serif;" +
        "background:var(--hq-panel,var(--panel,rgba(14,25,35,.92)));color:var(--hq-ink,var(--ink,#e8eef4));border:1px solid var(--hq-line,var(--line,rgba(255,179,71,.6)));z-index:30;pointer-events:none;max-width:80%;text-align:center";
      host.appendChild(t); }
    t.textContent = String(msg); t.style.opacity = "1";
    if(toastT) clearTimeout(toastT); toastT = setTimeout(function(){ t.style.opacity = "0"; }, 3600);
    return t;
  } catch(e){ return null; }
}

// Arriving by car lift: the carried ride stands on the pad. One of your own (own:<id>) is homed in the basement
// (which also clears where it was parked); a full basement keeps it on the pad anyway, as visitor parking.
function adopt(w, ride){
  var b = ride && (ride.B || ride.prop || ride), id = (ride && ride.id) || (b && b.id), c = w && w.ctx;
  var res = {placed: false, ownId: null, pending: null};
  if(!id) return res;
  var P = w && (w.arrive || w.pad) || PAD, bs = w && w.bikes;   // [3.5.1] off the pad, facing in
  if(b && b.g && b.id === id && bs && bs.indexOf(b) < 0) bs.push(b);
  if(b && b.g){ b.x = P.x; b.z = P.z; b.yaw = P.yaw; if(b.g.position) b.g.position.set(P.x, 0, P.z); if(b.g.rotation) b.g.rotation.y = P.yaw; res.placed = true;
    if(w) b.world = w; }
  var m = /^own:(.+)$/.exec(String(id));
  if(!m) return res;
  res.ownId = m[1];
  var M = HQV.hqGarageMgr;
  if(!(M && M.transfer)) return res;
  if(M.homeOf && M.homeOf(res.ownId) === "basement"){ return res; }
  try {
    res.pending = Promise.resolve(M.transfer(res.ownId, "basement")).then(function(r){
      var bay = M.bayOf ? M.bayOf(res.ownId) : null;
      toast(c, "Welcome home. Parked in B1" + (bay != null ? ", bay " + (bay + 1) : "") + ".");
      return {ok: true, bay: bay};
    }, function(err){
      var full = err && (err.code === 409 || err.code === "full" || /full/i.test(String(err.msg || "")));
      toast(c, full ? "The basement is full: it stays on the lift pad as visitor parking." : "Couldn't home it in B1 just now; it stays on the pad.");
      return {ok: false, full: !!full};
    });
  } catch(e){}
  return res;
}

// [3.5.3] many flat quads in ONE geometry (one draw): each {c: centre, u: half-width axis, v: half-height axis, uv:
// [u0, v0, u1, v1]}; it faces u x v. For the wall-washes, halos and posters (additive or textured, so not mergeable).
function quadGeo(THREE, list){
  var pos = [], uv = [], nrm = [], idx = [];
  list.forEach(function(q, n){
    var c0 = q.c, u = q.u, v = q.v, t = q.uv || [0, 0, 1, 1];
    var nx = u[1]*v[2] - u[2]*v[1], ny = u[2]*v[0] - u[0]*v[2], nz = u[0]*v[1] - u[1]*v[0], l = Math.sqrt(nx*nx + ny*ny + nz*nz) || 1;
    [[-1, -1, t[0], t[1]], [1, -1, t[2], t[1]], [1, 1, t[2], t[3]], [-1, 1, t[0], t[3]]].forEach(function(k){
      pos.push(c0[0] + k[0]*u[0] + k[1]*v[0], c0[1] + k[0]*u[1] + k[1]*v[1], c0[2] + k[0]*u[2] + k[1]*v[2]);
      uv.push(k[2], k[3]); nrm.push(nx/l, ny/l, nz/l); });
    var b = n*4; idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  });
  var g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nrm, 3)); g.setIndex(idx);
  return g;
}

HQV.hqBasement = {layout: layout, quadGeo: quadGeo, bayPose: bayPose, slotPose: slotPose, fitR: fitR, nameFor: nameFor, basementMax: basementMax, lockLevel: lockLevel,
  paintHex: paintHex, basementRows: basementRows, blockedAt: blockedAt, adopt: adopt, toast: toast,
  PAD: PAD, NBAYS: NBAYS, NSLOTS: NSLOTS, R_MAX: R_MAX, CEIL: CEIL, CAM_CEIL: CAM_CEIL, BOUNDS: [-HW, HW, -HD, HD]};

/* ---------------------------------------------------------------------------------------------- the world */
HQV.hqWorlds.basement = function(c, w){
  var THREE = c.THREE, S = w.scene, HEX = c.HEX || {}, COL = c.COL || {};
  var me = (c.api && c.api.me && c.api.me()) || "me";
  var look = (c.look && c.look()) || {};
  var h = {userId: me, isYou: true, look: look, level: c.level ? c.level() : 1};
  var seed = (c.hashStr ? c.hashStr : function(s){ var x = 7; for(var i = 0; i < s.length; i++) x = (x*31 + s.charCodeAt(i)) >>> 0; return x; })("basement:" + me);
  var R = c.rng ? c.rng(seed) : function(){ seed = (seed*1664525 + 1013904223) >>> 0; return seed/4294967296; };
  var col = HQV.hqLotColors ? HQV.hqLotColors(look) : {paint: 0x2a3c50, accent: 0xffb347};
  if(HQV.hqPlated) try { HQV.hqPlated(col, h); } catch(e){}
  // [3.5.3] the name sign glows warm (amber, honey, apricot, champagne): a showroom, not a club
  var accent = col.accent, neon = [0xffb347, 0xffc979, 0xff9f5a, 0xffd59a][Math.floor(R()*4)];
  var Fx = HQV.hqBasementFx, Mgr = HQV.hqGarageMgr, Lift = HQV.hqCarLift;
  var L = layout(h.level), hits = [], doors = [], bikes = [], anims = [];
  var st = new THREE.Group(); st.name = "basement:static"; S.add(st);      // static: merged at the end
  var dyn = new THREE.Group(); dyn.name = "basement:dyn"; S.add(dyn);
  var mat = c.mat, box = c.box;
  function basic(color, o){ return new THREE.MeshBasicMaterial(Object.assign({color: color, toneMapped: false}, o || {})); }

  // light [3.5.3]: a lavish private showroom, bright and warm (~3000 K). A strong warm hemisphere fill so walls and
  // floor read, one shadowed key, the four ceiling pools; the coves, wall-washes and halos below are emissive or
  // additive gradients (no extra real lights)
  var WARM = 0xffd9a8, WARM_HI = 0xffe6c4;
  S.background = new THREE.Color(0x2a221b);
  S.fog = new THREE.Fog(0x2a221b, 40, 95);
  var hemi = new THREE.HemisphereLight(0xfff0dc, 0xb4a48e, 2.1); S.add(hemi);
  var keyL = new THREE.DirectionalLight(WARM_HI, 0.9); keyL.position.set(-6, CEIL - 0.2, 4); keyL.castShadow = true;
  keyL.shadow.mapSize.set(1024, 1024); var sc = keyL.shadow.camera; sc.left = -HW; sc.right = HW; sc.top = HD; sc.bottom = -HD; sc.far = 30;
  S.add(keyL); S.add(keyL.target);
  var pts = [];
  [[-8, -6, 0xffe2b8, 34], [8, 4, 0xffe6c4, 30], [19, -13, 0xffd49a, 36], [-27, -13, 0xffb978, 30]].forEach(function(p){
    var l = new THREE.PointLight(p[2], p[3], 26, 2); l.position.set(p[0], CEIL - 0.6, p[1]); l.userData.base = p[3]; S.add(l); pts.push(l); });

  // the floor [3.5.3]: polished warm-grey stone slabs (a seeded canvas: tone, cloud, a few veins, fine joints), the
  // sheen from a little warm strip-lit environment (no realtime mirror)
  var envMap = null;
  try {
    var env = c.canvasTex(256, 128, function(g, W){ g.fillStyle = "#3a2e24"; g.fillRect(0, 0, 256, 128); g.fillStyle = "#ffe6c4";
      for(var i = 0; i < 8; i++) g.fillRect(i*32 + 8, 4, 18, 12); g.fillStyle = "#ffcf96"; g.fillRect(0, 40, 256, 6);
      g.fillStyle = "#8a7a68"; g.fillRect(0, 46, 256, 30); g.fillStyle = "#5a4c3e"; g.fillRect(0, 76, 256, 52); });
    if(env && env.t){ envMap = env.t; envMap.mapping = THREE.EquirectangularReflectionMapping; }
  } catch(e){}
  var stoneR = c.rng ? c.rng(seed ^ 0x7f1) : R;
  var stone = c.canvasTex(1024, 640, function(g){
    if(!g || !g.fillRect) return;
    g.fillStyle = "#d6cdbf"; g.fillRect(0, 0, 1024, 640);
    for(var sx = 0; sx < 16; sx++) for(var sz = 0; sz < 10; sz++){      // 4 m slabs, each a touch different
      var v = Math.floor(stoneR()*14) - 7; g.fillStyle = "rgb(" + (214 + v) + "," + (205 + v) + "," + (191 + v) + ")"; g.fillRect(sx*64, sz*64, 64, 64); }
    for(var k = 0; k < 140; k++){ g.fillStyle = "rgba(" + (stoneR() < 0.5 ? "255,248,236" : "150,138,122") + ",.06)";
      g.beginPath(); g.arc(stoneR()*1024, stoneR()*640, 10 + stoneR()*40, 0, 7); g.fill(); }
    g.lineCap = "round";
    for(var vn = 0; vn < 22; vn++){ var x0 = stoneR()*1024, y0 = stoneR()*640;
      g.strokeStyle = "rgba(120,106,90," + (0.12 + stoneR()*0.16) + ")"; g.lineWidth = 0.8 + stoneR()*1.4; g.beginPath(); g.moveTo(x0, y0);
      g.bezierCurveTo(x0 + (stoneR() - 0.5)*160, y0 + (stoneR() - 0.5)*120, x0 + (stoneR() - 0.5)*240, y0 + (stoneR() - 0.5)*160, x0 + (stoneR() - 0.5)*320, y0 + (stoneR() - 0.5)*200); g.stroke(); }
    g.fillStyle = "rgba(110,98,84,.2)";
    for(var j = 0; j <= 16; j++) g.fillRect(j*64 - 0.5, 0, 1, 640); for(var jz = 0; jz <= 10; jz++) g.fillRect(0, jz*64 - 0.5, 1024, 1);
  });
  var floorM = new THREE.MeshStandardMaterial({color: 0xffffff, map: stone && stone.t, roughness: 0.26, metalness: 0.12, envMap: envMap, envMapIntensity: 0.75});
  floorM.userData.rough0 = 0.26; floorM.userData.env0 = 0.75;   // hqbasementfx lighting() restores these when dry
  var floor = new THREE.Mesh(new THREE.PlaneGeometry(2*HW, 2*HD), floorM);
  floor.rotation.x = -PI/2; floor.receiveShadow = true; S.add(floor);
  // the floor markings (bays, numbers, locks, aisle arrows) and the "mirrored" strips: one canvas, one draw call
  var mk = c.canvasTex(2048, 1280);
  var marks = new THREE.Mesh(new THREE.PlaneGeometry(2*HW, 2*HD), new THREE.MeshBasicMaterial({map: mk.t, transparent: true, depthWrite: false, toneMapped: false}));
  marks.rotation.x = -PI/2; marks.position.y = 0.012; marks.renderOrder = 1; S.add(marks);
  function drawMarks(){
    var g = mk.g, u = 2048/(2*HW); if(!g) return;
    function X(x){ return (x + HW)*u; } function Z(z){ return (z + HD)*u; }
    g.clearRect(0, 0, 2048, 1280);
    // the reflections of the ceiling strips: long soft streaks along x
    for(var s = -3; s <= 3; s++){ var zz = Z(s*4.2), gr = g.createLinearGradient ? g.createLinearGradient(0, zz - 10, 0, zz + 10) : null;
      if(gr){ gr.addColorStop(0, "rgba(255,236,206,0)"); gr.addColorStop(0.5, "rgba(255,236,206,.22)"); gr.addColorStop(1, "rgba(255,236,206,0)"); g.fillStyle = gr; }
      else g.fillStyle = "rgba(255,236,206,.16)";
      g.fillRect(X(-HW + 2), zz - 10, X(HW - 2) - X(-HW + 2), 20); }
    // [3.5.4] no painted bays any more: each vehicle has a plinth; a faint bronze ring on the stone round each one
    L.plinths.forEach(function(p){ g.strokeStyle = p.lit ? "rgba(120,86,48,.45)" : "rgba(110,100,88,.25)"; g.lineWidth = 4;
      g.beginPath(); g.arc(X(p.x), Z(p.z), (R_MAX + 0.2)*u, 0, 2*PI); g.stroke(); });
    // aisle chevrons toward the car lift, and the lift pad's hatching
    g.fillStyle = "rgba(214,128,30,.6)";
    for(var ax = -22; ax < 18; ax += 6){ var cx = X(ax), cz = Z(0); g.beginPath(); g.moveTo(cx, cz - 26); g.lineTo(cx + 26, cz); g.lineTo(cx, cz + 26); g.lineTo(cx + 10, cz); g.fill(); }
    g.strokeStyle = "rgba(214,160,20,.9)"; g.lineWidth = 8; g.strokeRect(X(PAD.x - PAD.d/2 - 0.3), Z(PAD.z - PAD.w/2 - 0.3), (PAD.d + 0.6)*u, (PAD.w + 0.6)*u);
    mk.t.needsUpdate = true;
  }

  // walls and the ceiling slab [3.5.3: warm light plaster and a mid-tone soffit], with a skirting light line
  var conc = mat(0xb3a898, {roughness: 0.85}), slabM = mat(0xe3ded6, {roughness: 0.9});
  box(2*HW, 0.4, 2*HD, slabM, 0, CEIL + 0.2, 0, st, true);
  box(2*HW, CEIL, 0.5, conc, 0, CEIL/2, -HD - 0.25, st); box(2*HW, CEIL, 0.5, conc, 0, CEIL/2, HD + 0.25, st);
  box(0.5, CEIL, 2*HD, conc, -HW - 0.25, CEIL/2, 0, st); box(0.5, CEIL, 2*HD, conc, HW + 0.25, CEIL/2, 0, st);
  var skirt = basic(accent);
  box(2*HW, 0.05, 0.05, skirt, 0, 0.12, -HD + 0.03, st, true); box(2*HW, 0.05, 0.05, skirt, 0, 0.12, HD - 0.03, st, true);
  box(0.05, 0.05, 2*HD, skirt, -HW + 0.03, 0.12, 0, st, true); box(0.05, 0.05, 2*HD, skirt, HW - 0.03, 0.12, 0, st, true);
  // a timber-slat feature wall behind the neon
  var slat = mat(0x8a5a34, {roughness: 0.55});
  for(var sx = -16; sx <= 4; sx += 0.42) box(0.22, CEIL - 0.6, 0.12, slat, sx, (CEIL - 0.6)/2 + 0.2, -HD + 0.07, st);

  /* [3.5.3] the showroom pass: all static and merged (one draw per material), or one quad mesh per effect */
  var coveM = basic(WARM), metalM = mat(0xc9c2b6, {metalness: 0.85, roughness: 0.32});
  // dark-walnut slats behind the showcase plinths, on a near-black backing, a warm LED line top and bottom
  var walnut = mat(0x4a2c1a, {roughness: 0.5}), backM = mat(0x1e1510, {roughness: 0.7});
  box(16.8, CEIL - 0.5, 0.05, backM, 22.6, (CEIL - 0.5)/2 + 0.15, -HD + 0.03, st);
  for(var wx = 14.4; wx <= 30.9; wx += 0.36) box(0.2, CEIL - 0.7, 0.1, walnut, wx, (CEIL - 0.7)/2 + 0.25, -HD + 0.1, st);
  box(16.8, 0.04, 0.06, coveM, 22.6, 0.2, -HD + 0.16, st, true); box(16.8, 0.04, 0.06, coveM, 22.6, CEIL - 0.4, -HD + 0.16, st, true);
  // brushed-metal dado trims round the room
  box(2*HW - 0.4, 0.06, 0.04, metalM, 0, 1.05, -HD + 0.04, st, true); box(2*HW - 0.4, 0.06, 0.04, metalM, 0, 1.05, HD - 0.04, st, true);
  box(0.04, 0.06, 2*HD - 0.4, metalM, -HW + 0.04, 1.05, 0, st, true); box(0.04, 0.06, 2*HD - 0.4, metalM, HW - 0.04, 1.05, 0, st, true);
  // warm cove strips along every wall-ceiling edge
  box(2*HW - 0.4, 0.06, 0.08, coveM, 0, CEIL - 0.06, -HD + 0.12, st, true); box(2*HW - 0.4, 0.06, 0.08, coveM, 0, CEIL - 0.06, HD - 0.12, st, true);
  box(0.08, 0.06, 2*HD - 0.4, coveM, -HW + 0.12, CEIL - 0.06, 0, st, true); box(0.08, 0.06, 2*HD - 0.4, coveM, HW - 0.12, CEIL - 0.06, 0, st, true);
  // the floating ceiling panel over the aisle (the oak of the slats, so it merges with them), cove-lit underneath (just above where the camera stops)
  var PNL = {x: -3, z: 0, w: 34, d: 7, y: CEIL - 0.22};
  box(PNL.w, 0.1, PNL.d, slat, PNL.x, PNL.y, PNL.z, st, true);
  box(PNL.w - 0.3, 0.04, 0.06, coveM, PNL.x, PNL.y - 0.07, PNL.z - PNL.d/2 + 0.15, st, true); box(PNL.w - 0.3, 0.04, 0.06, coveM, PNL.x, PNL.y - 0.07, PNL.z + PNL.d/2 - 0.15, st, true);
  box(0.06, 0.04, PNL.d - 0.3, coveM, PNL.x - PNL.w/2 + 0.15, PNL.y - 0.07, PNL.z, st, true); box(0.06, 0.04, PNL.d - 0.3, coveM, PNL.x + PNL.w/2 - 0.15, PNL.y - 0.07, PNL.z, st, true);
  // wall-washers: scalloped warm pools down every wall from the cove, one additive mesh; a halo round the panel
  var washT = c.canvasTex(256, 256, function(g){ if(!g || !g.createRadialGradient) return; g.clearRect(0, 0, 256, 256);
    var lg = g.createLinearGradient(0, 0, 0, 256); lg.addColorStop(0, "rgba(255,214,160,.55)"); lg.addColorStop(0.35, "rgba(255,200,140,.12)"); lg.addColorStop(1, "rgba(255,200,140,0)");
    g.fillStyle = lg; g.fillRect(0, 0, 256, 256);
    var rg = g.createRadialGradient(128, 0, 4, 128, 0, 230); rg.addColorStop(0, "rgba(255,222,176,.75)"); rg.addColorStop(0.45, "rgba(255,196,130,.28)"); rg.addColorStop(1, "rgba(255,196,130,0)");
    g.fillStyle = rg; g.fillRect(0, 0, 256, 256); });
  var addM = function(t, op){ return new THREE.MeshBasicMaterial({map: t, color: 0xffffff, transparent: true, opacity: op, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, side: THREE.DoubleSide}); };
  if(washT && washT.t){
    washT.t.wrapS = THREE.RepeatWrapping; washT.t.needsUpdate = true;
    var WH = 1.9, wy = CEIL - 0.1 - WH, pitch = 4.2;   // 3.8 m tall bands, a pool every 4.2 m
    var wash = new THREE.Mesh(quadGeo(THREE, [
      {c: [0, wy, -HD + 0.17], u: [HW, 0, 0], v: [0, WH, 0], uv: [0, 0, 2*HW/pitch, 1]},
      {c: [0, wy, HD - 0.02], u: [-HW, 0, 0], v: [0, WH, 0], uv: [0, 0, 2*HW/pitch, 1]},
      {c: [-HW + 0.02, wy, 0], u: [0, 0, -HD], v: [0, WH, 0], uv: [0, 0, 2*HD/pitch, 1]},
      {c: [HW - 0.02, wy, 0], u: [0, 0, HD], v: [0, WH, 0], uv: [0, 0, 2*HD/pitch, 1]}]), addM(washT.t, 0.9));
    wash.name = "basement:wash"; wash.renderOrder = 2; dyn.add(wash);
  }
  var haloT = c.canvasTex(256, 128, function(g){ if(!g || !g.fillRect) return; g.clearRect(0, 0, 256, 128);
    g.shadowColor = "rgba(255,206,150,1)"; g.shadowBlur = 28; g.fillStyle = "rgba(255,214,166,.9)"; g.fillRect(34, 34, 188, 60); });
  if(haloT && haloT.t){ var halo = new THREE.Mesh(quadGeo(THREE, [{c: [PNL.x, CEIL - 0.006, PNL.z], u: [PNL.w/2 + 2.4, 0, 0], v: [0, 0, PNL.d/2 + 1.8]}]), addM(haloT.t, 0.8));
    halo.name = "basement:panelHalo"; dyn.add(halo); }

  // the LED ceiling strips: one InstancedMesh; the columns and their uplights: two more
  var stripG = new THREE.BoxGeometry(1, 0.06, 0.22), strips = [];
  for(var s = -3; s <= 3; s++) strips.push([0, s*4.2, 2*HW - 4]);
  for(var xs = -24; xs <= 24; xs += 12) strips.push([xs, 0, 0.9, 2*HD - 4]);
  var stripI = new THREE.InstancedMesh(stripG, basic(0xffe2b8), strips.length), m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), v1 = new THREE.Vector3(), v2 = new THREE.Vector3();
  strips.forEach(function(sp, i){
    if(sp.length === 3) m4.compose(v1.set(sp[0], CEIL - 0.04, sp[1]), q.identity(), v2.set(sp[2], 1, 1));
    else m4.compose(v1.set(sp[0], CEIL - 0.04, sp[1]), q.identity(), v2.set(0.22, 1, sp[3]/0.22));
    stripI.setMatrixAt(i, m4);
  });
  stripI.name = "basement:strips"; S.add(stripI);
  var colI = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.42, 0.42, CEIL, 20), mat(0xe6ddd0, {roughness: 0.35, metalness: 0.2}), COLS.length);
  var upI = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.43, 0.75, 1.6, 20, 1, true), basic(accent, {transparent: true, opacity: 0.1, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide}), COLS.length);
  COLS.forEach(function(p, i){ m4.compose(v1.set(p.x, CEIL/2, p.z), q.identity(), v2.set(1, 1, 1)); colI.setMatrixAt(i, m4);
    m4.compose(v1.set(p.x, 0.8, p.z), q.identity(), v2.set(1, 1, 1)); upI.setMatrixAt(i, m4); });
  colI.castShadow = true; colI.receiveShadow = true; colI.name = "basement:columns"; upI.name = "basement:uplights"; S.add(colI); S.add(upI);
  // [3.5.4] a round ceiling spot over every gallery plinth, warm when its slot is unlocked (instance colours)
  var barI = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.34, 0.34, 0.08, 20), basic(0xffffff), NSLOTS), tint = new THREE.Color();
  function drawBars(){
    L.plinths.forEach(function(p, i){ m4.compose(v1.set(p.x, CEIL - 0.04, p.z), q.identity(), v2.set(1, 1, 1)); barI.setMatrixAt(i, m4);
      barI.setColorAt(i, tint.setHex(p.lit ? 0xffd9a0 : 0x5a5046)); });
    barI.instanceMatrix.needsUpdate = true; if(barI.instanceColor) barI.instanceColor.needsUpdate = true;
  }
  barI.name = "basement:spots"; S.add(barI);

  // your HQ's name in neon on the back wall
  var nameTex = c.canvasTex(1024, 256), name = nameFor(h);
  (function(){ var g = nameTex.g; if(!g) return; var hx = "#" + ("00000" + neon.toString(16)).slice(-6);
    g.clearRect(0, 0, 1024, 256); g.textAlign = "center"; g.font = "800 112px system-ui, sans-serif";
    g.shadowColor = hx; g.shadowBlur = 36; g.fillStyle = hx; g.fillText(c.short ? c.short(name.toUpperCase(), 16) : name.toUpperCase().slice(0, 16), 512, 150);
    g.shadowBlur = 8; g.fillStyle = "#ffffff"; g.fillText(c.short ? c.short(name.toUpperCase(), 16) : name.toUpperCase().slice(0, 16), 512, 150);
    g.shadowBlur = 0; g.font = "600 34px ui-monospace, Menlo, monospace"; g.fillStyle = hx; g.fillText("B1 · PRIVATE GARAGE", 512, 222);
    nameTex.t.needsUpdate = true; })();
  var sign = c.screen(13, 3.25, nameTex.t, true); sign.position.set(-6, 2.7, -HD + 0.16); dyn.add(sign);
  if(c.glow){ var sgl = c.glow(neon, 16, 0.22); sgl.position.set(-6, 2.7, -HD + 0.6); dyn.add(sgl); anims.push(function(t, k){ sgl.material.opacity = 0.18 + 0.05*Math.sin(t*2.3*k); }); }

  // [3.5.4] the showcase gallery: a plinth for every B1 vehicle (the starters and all twelve bays). Each is a bronze
  // base, a dark turntable disc, an accent ring, a warm spot cone and an under-plinth halo; each part is ONE
  // InstancedMesh over all fifteen slots (a constant handful of draws), scaled to the fitted radius. A locked slot
  // is a dim empty plinth (no cone, a faint halo) whose placard reads "Unlocks at level N".
  var bronzeM = mat(0x8a6238, {roughness: 0.3, metalness: 0.85});
  var baseG = new THREE.CylinderGeometry(1, 1.04, 0.06, 48), discG = new THREE.CylinderGeometry(1, 1, 0.02, 48);
  var ringG = new THREE.TorusGeometry(1, 0.012, 6, 64); ringG.rotateX(-PI/2);
  var coneG = new THREE.CylinderGeometry(0.08, 1, CEIL - 0.1, 32, 1, true), haloG = new THREE.PlaneGeometry(2, 2); haloG.rotateX(-PI/2);
  var baseI = new THREE.InstancedMesh(baseG, bronzeM, NSLOTS), discI = new THREE.InstancedMesh(discG, mat(0x3a2f26, {roughness: 0.25, metalness: 0.6}), NSLOTS);
  var ringI = new THREE.InstancedMesh(ringG, basic(0xffffff), NSLOTS);
  var coneI = new THREE.InstancedMesh(coneG, basic(0xffd9a0, {transparent: true, opacity: 0.1, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide}), NSLOTS);
  baseI.receiveShadow = true; discI.receiveShadow = true;
  baseI.name = "basement:plinths"; discI.name = "basement:discs"; ringI.name = "basement:rings"; coneI.name = "basement:cones";
  [baseI, discI, ringI, coneI].forEach(function(o){ o.frustumCulled = false; dyn.add(o); });
  var pHaloT = c.canvasTex(128, 128, function(g){ if(!g || !g.createRadialGradient) return; g.clearRect(0, 0, 128, 128);
    var rg = g.createRadialGradient(64, 64, 30, 64, 64, 64); rg.addColorStop(0, "rgba(255,206,150,.85)"); rg.addColorStop(0.35, "rgba(255,190,120,.35)"); rg.addColorStop(1, "rgba(255,190,120,0)");
    g.fillStyle = rg; g.fillRect(0, 0, 128, 128); });
  var haloI = pHaloT && pHaloT.t ? new THREE.InstancedMesh(haloG, addM(pHaloT.t, 0.9), NSLOTS) : null;
  if(haloI){ haloI.name = "basement:plinthHalo"; haloI.renderOrder = 2; haloI.frustumCulled = false; dyn.add(haloI); }
  var accentC = new THREE.Color(accent), dimC = new THREE.Color(0x3a332c), fullC = new THREE.Color(0xffffff), lowC = new THREE.Color(0x5a5046);
  function drawPlinths(){
    L.plinths.forEach(function(p, i){
      var r = p.r, lit = p.lit;
      m4.compose(v1.set(p.x, 0.03, p.z), q.identity(), v2.set(r, 1, r)); baseI.setMatrixAt(i, m4);
      baseI.setColorAt(i, lit ? fullC : lowC);
      m4.compose(v1.set(p.x, 0.07, p.z), q.identity(), v2.set(r - 0.12, 1, r - 0.12)); discI.setMatrixAt(i, m4);
      discI.setColorAt(i, lit ? fullC : lowC);
      m4.compose(v1.set(p.x, 0.065, p.z), q.identity(), v2.set(r + 0.02, 1, r + 0.02)); ringI.setMatrixAt(i, m4);
      ringI.setColorAt(i, lit ? accentC : dimC);
      m4.compose(v1.set(p.x, (CEIL - 0.1)/2, p.z), q.identity(), lit ? v2.set(r, 1, r) : v2.set(1e-4, 1e-4, 1e-4)); coneI.setMatrixAt(i, m4);
      if(haloI){ m4.compose(v1.set(p.x, 0.02, p.z), q.identity(), v2.set(r*1.75, 1, r*1.75)); haloI.setMatrixAt(i, m4);
        haloI.setColorAt(i, tint.setScalar(lit ? 1 : 0.18)); }
    });
    [baseI, discI, ringI, coneI, haloI].forEach(function(o){ if(!o) return; o.instanceMatrix.needsUpdate = true; if(o.instanceColor) o.instanceColor.needsUpdate = true; });
  }

  // a small museum placard on a brushed post in front of every plinth, facing the aisle: one atlas, one quad mesh
  // (4 x 4 cells of 512 x 256), redrawn only when what it says changes
  var CW = 0.6, CH = 0.3, cardT = c.canvasTex(2048, 1024), cardSig = "";
  if(cardT && cardT.t){
    var cardM = new THREE.Mesh(quadGeo(THREE, L.plinths.map(function(p, i){ var f = p.face, cx = i % 4, cy = Math.floor(i/4);
      return {c: [p.card.x, 0.86, p.card.z], u: [f*CW, 0, 0], v: [0, CH*0.8, -f*CH*0.6], uv: [cx/4, 1 - (cy + 1)/4, (cx + 1)/4, 1 - cy/4]}; })),
      new THREE.MeshBasicMaterial({map: cardT.t, toneMapped: false, color: 0xf2e8da}));
    cardM.name = "basement:placards"; dyn.add(cardM);
  }
  L.plinths.forEach(function(p){ box(0.06, 0.7, 0.06, metalM, p.card.x, 0.35, p.card.z, st, true); });
  function drawCards(rows){
    var g = cardT && cardT.g; if(!g || !g.fillRect) return;
    var info = L.plinths.map(function(p, i){
      if(p.bay == null) return {t: ["Car", "Motorbike", "Bicycle"][i] || "Starter", s: "Your starter \u00b7 S" + (i + 1), lit: true};
      var r = rows[p.bay];
      if(r){ var e = r.entry || {}, nm = ((e.brand || "") + " " + (e.model || r.vehicle_id || "")).trim();
        return {t: nm || String(r.vehicle_id || "Vehicle"), s: (e.year ? e.year + " \u00b7 " : "") + "Bay " + (p.bay + 1), lit: true}; }
      return p.lit ? {t: "Bay " + (p.bay + 1), s: "Free \u00b7 drive one down", lit: true} : {t: "Bay " + (p.bay + 1), s: "Unlocks at level " + p.unlock, lit: false};
    });
    var sig = JSON.stringify(info); if(sig === cardSig) return; cardSig = sig;
    g.clearRect(0, 0, 2048, 1024); g.textAlign = "center";
    info.forEach(function(it, i){
      var x0 = (i % 4)*512, y0 = Math.floor(i/4)*256;
      g.fillStyle = it.lit ? "#1d1611" : "#2a2622"; g.fillRect(x0 + 6, y0 + 6, 500, 244);
      g.strokeStyle = it.lit ? "#b8894f" : "#5a5046"; g.lineWidth = 6; g.strokeRect(x0 + 16, y0 + 16, 480, 224);
      g.fillStyle = it.lit ? "#f4e6d0" : "#8a8076"; g.font = "800 50px system-ui, sans-serif";
      g.fillText(c.short ? c.short(it.t, 18) : String(it.t).slice(0, 18), x0 + 256, y0 + 118);
      g.fillStyle = it.lit ? (HEX.amber || "#ffb347") : "#8a8076"; g.font = "600 30px system-ui, sans-serif";
      g.fillText(c.short ? c.short(it.s, 30) : String(it.s).slice(0, 30), x0 + 256, y0 + 182);
    });
    cardT.t.needsUpdate = true;
  }

  // the EV charging corner: three chargers with glowing rings and a green floor glyph
  for(var e = 0; e < 3; e++){
    var ex = EV.x - 3 + e*3, chg = new THREE.Group(); chg.position.set(ex, 0, HD - 0.6); st.add(chg);
    box(0.7, 1.7, 0.4, mat(0xe8edf2, {roughness: 0.3, metalness: 0.3}), 0, 0.85, 0, chg);
    box(0.5, 0.3, 0.02, basic(0x0a1a12), 0, 1.3, -0.21, chg, true);
    var ringE = new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.03, 8, 24), basic(0x37ff8b)); ringE.position.set(ex, 0.9, HD - 0.82); dyn.add(ringE);
    anims.push((function(rg, ph){ return function(t, k){ rg.material.color.setHSL(0.39, 1, 0.45 + 0.15*Math.sin(t*2*k + ph)); }; })(ringE, e*1.7));
  }
  if(c.label){ var evTag = c.label("EV charging", "#37ff8b", 0.4); evTag.position.set(EV.x, 2.6, HD - 0.8); dyn.add(evTag); }

  // the lounge behind glass: sofas, a bar with a back-lit shelf, a screen
  var glass = mat(0x3a2818, {transparent: true, opacity: 0.32, roughness: 0.04, metalness: 0.35});   // [3.5.3] smoked bronze
  var gx = LOUNGE.x1, gz = LOUNGE.z1;
  // [3.5.4] the hall-side glass has an open doorway (LDOOR, 2.4 m) between bronze posts under a bronze header
  var GH = CEIL - 0.1, gw1 = new THREE.Mesh(new THREE.BoxGeometry(0.06, GH, LDOOR.z0 - LOUNGE.z0), glass); gw1.position.set(gx, GH/2, (LDOOR.z0 + LOUNGE.z0)/2); dyn.add(gw1);
  var gw3 = new THREE.Mesh(new THREE.BoxGeometry(0.06, GH, gz - LDOOR.z1), glass); gw3.position.set(gx, GH/2, (gz + LDOOR.z1)/2); dyn.add(gw3);
  var DOOR_H = 2.7;
  box(0.08, GH - DOOR_H, LDOOR.z1 - LDOOR.z0, glass, gx, DOOR_H + (GH - DOOR_H)/2, (LDOOR.z0 + LDOOR.z1)/2, dyn);   // a transom of glass over it
  [LDOOR.z0, LDOOR.z1].forEach(function(z){ box(0.14, DOOR_H, 0.1, bronzeM, gx, DOOR_H/2, z, st, true); });
  box(0.16, 0.12, LDOOR.z1 - LDOOR.z0 + 0.1, bronzeM, gx, DOOR_H + 0.06, (LDOOR.z0 + LDOOR.z1)/2, st, true);
  var gw2 = new THREE.Mesh(new THREE.BoxGeometry(gx - LOUNGE.x0, CEIL - 0.1, 0.06), glass); gw2.position.set((gx + LOUNGE.x0)/2, (CEIL - 0.1)/2, gz); dyn.add(gw2);
  var frameM = metalM;
  box(0.1, 0.1, gz - LOUNGE.z0, frameM, gx, CEIL - 0.05, (gz + LOUNGE.z0)/2, st); box(gx - LOUNGE.x0, 0.1, 0.1, frameM, (gx + LOUNGE.x0)/2, CEIL - 0.05, gz, st);
  var sofa = mat(0x7a4a2c, {roughness: 0.7}), cush = mat(0xd9c3a2, {roughness: 0.95});   // cognac leather, cream cushions
  box(5.2, 0.03, 4.0, mat(0x9a6a4a, {roughness: 1}), -27.6, 0.015, -11.2, st, true);          // a wool rug under it all
  box(0.06, 0.04, gz - LOUNGE.z0 - 0.4, coveM, gx - 0.25, CEIL - 0.08, (gz + LOUNGE.z0)/2, st, true);   // the lounge's own cove,
  box(gx - LOUNGE.x0 - 0.4, 0.04, 0.06, coveM, (gx + LOUNGE.x0)/2, CEIL - 0.08, gz - 0.25, st, true);    // warm through the glass
  box(0.4, 0.04, 0.4, metalM, -24.2, 1.6, -7.2, st, true); box(0.04, 1.6, 0.04, metalM, -24.2, 0.8, -7.2, st, true);   // a floor lamp
  box(0.5, 0.36, 0.5, coveM, -24.2, 1.8, -7.2, st, true);
  box(4.2, 0.45, 1.0, sofa, -27.5, 0.3, -12.5, st); box(4.2, 0.85, 0.3, sofa, -27.5, 0.7, -13.05, st);
  box(1.0, 0.45, 3.2, sofa, -29.9, 0.3, -10.9, st); box(0.3, 0.85, 3.2, sofa, -30.45, 0.7, -10.9, st);
  [-28.9, -27.5, -26.1].forEach(function(x){ box(1.3, 0.16, 0.85, cush, x, 0.6, -12.4, st); });
  box(2.2, 0.06, 1.1, mat(0x8a5a35, {roughness: 0.4}), -27.4, 0.48, -10.6, st);
  box(5.6, 1.1, 0.7, mat(0x14171b, {metalness: 0.5, roughness: 0.3}), -27.2, 0.55, -18.4, st);
  box(5.6, 0.06, 0.8, mat(0xd8cdb8, {roughness: 0.2}), -27.2, 1.13, -18.4, st);
  box(5.4, 0.04, 0.3, basic(0xffb347), -27.2, 2.0, -19.6, st, true); box(5.4, 0.04, 0.3, basic(0xffb347), -27.2, 2.7, -19.6, st, true);
  var bottleR = c.rng ? c.rng(seed ^ 0x51) : R;
  for(var bt = 0; bt < 14; bt++){ var bh = 0.22 + bottleR()*0.18, bc = new THREE.Color().setHSL(bottleR(), 0.6, 0.45);
    var bm = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, bh, 8), mat(bc.getHex(), {roughness: 0.15, metalness: 0.2})); bm.position.set(-29.6 + bt*0.36, (bt < 7 ? 2.02 : 2.72) + bh/2, -19.6); st.add(bm); }
  var lsTex = c.canvasTex(512, 288), lsScreen = c.screen(3.2, 1.8, lsTex.t); lsScreen.position.set(-31.7, 2.2, -12); lsScreen.rotation.y = PI/2; dyn.add(lsScreen);
  function drawLounge(t){ var g = lsTex.g; if(!g) return; g.fillStyle = "#08101a"; g.fillRect(0, 0, 512, 288);
    for(var i = 0; i < 6; i++){ var y = 144 + Math.sin(t*0.6 + i)*60; g.fillStyle = "hsla(" + ((i*50 + t*12) % 360) + ",80%,60%,.6)"; g.beginPath(); g.arc(80 + i*70, y, 18, 0, 7); g.fill(); }
    g.fillStyle = HEX.amber || "#ffb347"; g.font = "700 30px system-ui, sans-serif"; g.fillText("B1 LOUNGE", 20, 40); lsTex.t.needsUpdate = true; }
  if(c.label){ var lTag = c.label("Lounge", HEX.amber || "#ffb347", 0.45); lTag.position.set(-27, 3.6, -6.2); dyn.add(lTag); }
  hits.push(gw1, gw2, gw3); gw1.userData.tip = gw2.userData.tip = gw3.userData.tip = "The B1 lounge: a sofa, a bar and a screen; walk in through the doorway";

  // the car-lift platform (games/hqcarlift.js when it is there, else a plain chevroned pad), door up to the street
  var liftDoor = {view: "@base", kind: "carlift", label: "Car lift", tip: "Car lift: drive on to go up to the street (G)",
                  front: new THREE.Vector3(PAD.x, 0, PAD.z)};   // [3.5.1] the trigger is ON the pad: it used to sit just
                  // off its basement side, on the way out, so the first W after arriving sent you straight back up
  var carLift = null;
  if(Lift && Lift.mesh) try { carLift = Lift.mesh(c, {w: PAD.w, d: PAD.d, level: "B1", dir: "up"}); } catch(e){ carLift = null; }
  var padG;
  if(carLift && carLift.g){ padG = carLift.g; }
  else {
    padG = new THREE.Group();
    var chev = c.canvasTex(256, 256, function(g){ g.fillStyle = "#1c2026"; g.fillRect(0, 0, 256, 256); g.fillStyle = "#f2c230";
      for(var i = -2; i < 8; i++){ g.beginPath(); g.moveTo(i*40, 0); g.lineTo(i*40 + 20, 0); g.lineTo(i*40 + 60, 256); g.lineTo(i*40 + 40, 256); g.fill(); } });
    var plat = new THREE.Mesh(new THREE.BoxGeometry(PAD.w, 0.08, PAD.d), new THREE.MeshStandardMaterial({map: chev.t, roughness: 0.5, metalness: 0.4})); plat.position.y = 0.04; padG.add(plat);
    [-1, 1].forEach(function(sd){ var rail = new THREE.Mesh(new THREE.BoxGeometry(0.12, CEIL, 0.12), mat(0x9aa6b2, {metalness: 0.85, roughness: 0.25})); rail.position.set(sd*(PAD.w/2 + 0.1), CEIL/2, -PAD.d/2); padG.add(rail); });
  }
  padG.position.set(PAD.x, 0, PAD.z); padG.rotation.y = PAD.yaw + PI; dyn.add(padG);
  padG.traverse(function(o){ if(o.isMesh){ o.userData.door = liftDoor; hits.push(o); } });
  doors.push(liftDoor);
  if(c.label){ var clTag = c.label("Car lift ▲ G Street", "#f2c230", 0.5); clTag.position.set(PAD.x, 3.7, PAD.z); dyn.add(clTag); }
  var liftState = null;

  // the person-lift doors on the left wall, up to the Lobby
  var pl = new THREE.Group(); pl.position.set(LIFT.x, 0, LIFT.z); pl.rotation.y = PI/2; dyn.add(pl);
  box(3.0, 4.0, 0.25, mat(0x8d9aa6, {metalness: 0.85, roughness: 0.25}), 0, 2.0, 0, pl);
  box(2.4, 3.4, 0.1, mat(0x0a1118), 0, 1.7, 0.1, pl);
  var dm = mat(0xc9b37a, {metalness: 0.95, roughness: 0.18});
  var pdl = box(1.18, 3.35, 0.08, dm, -0.6, 1.7, 0.18, pl), pdr = box(1.18, 3.35, 0.08, dm, 0.6, 1.7, 0.18, pl);
  var pit = c.canvasTex(512, 96, function(g){ g.fillStyle = "#06100a"; g.fillRect(0, 0, 512, 96); g.fillStyle = HEX.amber || "#ffb347"; g.font = "600 44px ui-monospace, Menlo, monospace"; g.fillText("▲ G  Lobby", 18, 62); });
  var pind = c.screen(2.2, 0.42, pit.t); pind.position.set(0, 3.75, 0.14); pl.add(pind);
  var plight = new THREE.PointLight(0xfff1d6, 0, 8, 2); plight.position.set(0, 2.2, 0.8); pl.add(plight);
  var lobbyDoor = {view: "@lobby", kind: "lift", label: "Lift", tip: "Lift: up to the Lobby (G)", front: new THREE.Vector3(LIFT.x + 2.0, 0, LIFT.z)};
  pl.traverse(function(o){ if(o.isMesh){ o.userData.door = lobbyDoor; hits.push(o); } });
  doors.push(lobbyDoor);
  if(c.label){ var plTag = c.label("Lift ▲ G Lobby", HEX.amber || "#ffb347", 0.5); plTag.position.set(LIFT.x + 0.8, 4.0, LIFT.z); dyn.add(plTag); }
  var pOpen = 0;

  // the garage-manager kiosk (games/hqgaragemgr.js), else a pedestal of our own that opens it
  var kioskDoor = null;
  if(Mgr && Mgr.kiosk) try {
    var K = Mgr.kiosk(c, "basement");
    if(K && K.g){ K.g.position.set(KIOSK.x, 0, KIOSK.z); K.g.rotation.y = PI/2; dyn.add(K.g); (K.hits || []).forEach(function(o){ hits.push(o); }); kioskDoor = K.door || null; }
  } catch(e){ kioskDoor = null; }
  if(!kioskDoor){
    kioskDoor = {view: "garage:open", from: "basement", label: "Garage manager", tip: "Garage manager: move vehicles between B1 and the common garage"};
    var kg = new THREE.Group(); kg.position.set(KIOSK.x, 0, KIOSK.z); kg.rotation.y = PI/2; dyn.add(kg);
    var kp = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.4, 1.1, 20), mat(0x20262d, {metalness: 0.7, roughness: 0.3})); kp.position.y = 0.55; kg.add(kp);
    var kt = c.canvasTex(256, 160, function(g){ g.fillStyle = "#08131c"; g.fillRect(0, 0, 256, 160); g.fillStyle = HEX.amber || "#ffb347"; g.font = "700 26px system-ui, sans-serif"; g.textAlign = "center";
      g.fillText("GARAGE", 128, 60); g.fillStyle = HEX.ink || "#e8eef4"; g.font = "500 18px system-ui, sans-serif"; g.fillText("B1 ⇄ Common", 128, 100); });
    var ks = c.screen(0.8, 0.5, kt.t); ks.position.set(0, 1.35, 0.1); ks.rotation.x = -0.45; kg.add(ks);
    kg.traverse(function(o){ if(o.isMesh){ o.userData.door = kioskDoor; o.userData.tip = "Garage manager"; hits.push(o); } });
  }
  // [integrate] E's kiosk front is local to the kiosk (rotated PI/2 here): turn it into basement coordinates
  if(kioskDoor.front && !kioskDoor.front.isVector3){ var kf = kioskDoor.front, kx = +kf.x || 0, kz = +kf.z || 0;
    kioskDoor.front = new THREE.Vector3(KIOSK.x + kz*Math.sin(PI/2) + kx*Math.cos(PI/2), 0, KIOSK.z + kz*Math.cos(PI/2) - kx*Math.sin(PI/2)); }
  if(!kioskDoor.front) kioskDoor.front = new THREE.Vector3(KIOSK.x + 1.4, 0, KIOSK.z);
  doors.push(kioskDoor);
  if(c.label){ var kTag = c.label("Garage manager", HEX.cyan || "#4fe3ff", 0.42); kTag.position.set(KIOSK.x, 2.4, KIOSK.z); dyn.add(kTag); }

  // a few plants, seeded
  // [3.5.3] more of them, and they go into the static group so they merge (a pot + four greens, not ten draws a plant)
  if(c.plant){ var pr = c.rng ? c.rng(seed ^ 0x9e3) : R, kids0 = S.children.slice();
    // [3.5.4] the back-wall ones stand between the gallery plinths, against the wall
    [[-21.5, -18.5], [13.8, -18.8], [30.6, -18.4], [-21.4, 18.4], [30.6, 18.4],
     [-0.7, -18.8], [31, -3.2], [-31, -3.5], [-31, 15.5], [-31.1, -15.6], [-8.9, 18.8]].forEach(function(p, n){
      try { c.plant(p[0], p[1], 0.9 + pr()*0.4, (seed + n) % 997); } catch(e){} });
    S.children.slice().forEach(function(o){ if(kids0.indexOf(o) < 0 && o !== st && o !== dyn && o.isGroup) st.add(o); }); }

  // [3.5.3] framed posters on the front wall: the HQ's own name and level, drawn here (no third-party art); one
  // atlas, one quad mesh; the brushed-metal frames merge with the trims
  var posR = c.rng ? c.rng(seed ^ 0x2b7) : R, lvl = Math.max(1, h.level | 0), nm = (c.short ? c.short(name.toUpperCase(), 14) : name.toUpperCase().slice(0, 14));
  var posT = c.canvasTex(1024, 512, function(g){
    if(!g || !g.fillRect) return;
    var inks = ["#ffb347", "#ffd59a", "#ff9f5a", "#e9d3b0"], bgs = ["#2a1a10", "#efe4d2", "#14181d", "#6b3a22"];
    for(var i = 0; i < 4; i++){ var x0 = i*256, ink = inks[(i + Math.floor(posR()*4)) % 4];
      g.fillStyle = bgs[i]; g.fillRect(x0, 0, 256, 512); g.textAlign = "center";
      if(i === 0){ g.fillStyle = ink; g.beginPath(); g.arc(x0 + 128, 190, 86, 0, 7); g.fill();
        g.fillStyle = "#2a1a10"; for(var k = 0; k < 6; k++) g.fillRect(x0 + 30, 200 + k*14, 196, 5);
        g.fillStyle = "#f4e6d0"; g.font = "800 30px system-ui, sans-serif"; g.fillText(nm, x0 + 128, 360);
        g.font = "600 16px ui-monospace, Menlo, monospace"; g.fillStyle = ink; g.fillText("B1 · PRIVATE GARAGE", x0 + 128, 392); }
      else if(i === 1){ g.fillStyle = "#2a1a10"; g.font = "600 22px ui-monospace, Menlo, monospace"; g.fillText("LEVEL", x0 + 128, 110);
        g.font = "900 150px system-ui, sans-serif"; g.fillStyle = "#c2662a"; g.fillText(String(lvl), x0 + 128, 280);
        g.fillStyle = "#2a1a10"; for(var s2 = 0; s2 < 3; s2++) g.fillRect(x0 + 40, 330 + s2*18, 176, 8);
        g.font = "700 18px system-ui, sans-serif"; g.fillText(nm, x0 + 128, 440); }
      else if(i === 2){ g.strokeStyle = ink; g.lineWidth = 6;
        for(var a2 = 0; a2 < 5; a2++){ g.beginPath(); g.arc(x0 + 128, 330, 40 + a2*22, PI, 2*PI); g.stroke(); }
        g.fillStyle = ink; g.fillRect(x0 + 24, 330, 208, 4);
        g.font = "800 26px system-ui, sans-serif"; g.fillText("SHOWCASE", x0 + 128, 410); g.font = "600 16px ui-monospace, Menlo, monospace"; g.fillText("S1 · S2 · S3", x0 + 128, 440); }
      else { g.fillStyle = ink; for(var d2 = 0; d2 < 9; d2++){ g.globalAlpha = 0.25 + d2*0.08; g.fillRect(x0 + 28 + d2*22, 380 - d2*30, 16, 30 + d2*30); }
        g.globalAlpha = 1; g.fillStyle = "#f4e6d0"; g.font = "800 28px system-ui, sans-serif"; g.fillText("NIGHT DRIVE", x0 + 128, 450);
        g.font = "600 15px ui-monospace, Menlo, monospace"; g.fillText(nm + " · LV " + lvl, x0 + 128, 476); }
      g.strokeStyle = "rgba(255,255,255,.18)"; g.lineWidth = 2; g.strokeRect(x0 + 12, 12, 232, 488); }
  });
  if(posT && posT.t){ var PX = [-22, -12, -2, 6.4], PW = 0.62, PH = 1.24, PY = 2.75;
    var post = new THREE.Mesh(quadGeo(THREE, PX.map(function(x, i){ return {c: [x, PY, HD - 0.07], u: [-PW, 0, 0], v: [0, PH, 0], uv: [i/4, 0, (i + 1)/4, 1]}; })),
      new THREE.MeshBasicMaterial({map: posT.t, toneMapped: false, color: 0xe8e0d4}));
    post.name = "basement:posters"; dyn.add(post);
    PX.forEach(function(x){ box(2*PW + 0.16, 2*PH + 0.16, 0.05, metalM, x, PY, HD - 0.03, st, true); }); }

  // the experience layer (games/hqbasementfx.js): each optional
  var fxPl = null, fxLounge = null, fxPhoto = null, fxTrophy = null, fxArr = null;
  function fx(name){ var a = Array.prototype.slice.call(arguments, 1); try { return Fx && typeof Fx[name] === "function" ? Fx[name].apply(Fx, a) : null; } catch(e){ return null; } }
  // the turntables' discs are instanced and round (their turn is invisible): the fx hook gets a pivot per slot to keep time with
  fxPl = fx("plinths", c, dyn, L.plinths.map(function(p){ return {x: p.x, z: p.z, r: p.r, turn: new THREE.Object3D(), label: p.label}; }));
  fxTrophy = fx("trophyWall", c, dyn, {x: 9.5, y: 2.2, z: -HD + 0.2, yaw: 0, w: 8});
  fxLounge = fx("lounge", c, dyn, {x: -27, z: -14, screen: lsScreen});
  fxPhoto = fx("photoSpot", c, dyn, {x: 19, z: -6.8, yaw: PI});

  /* -------- the vehicles: every one on its gallery plinth, the starters on S1-S3, your basement-homed owned vehicles
     on their bay's plinth (slot 3 + bay) */
  // [3.5.4] the plinths fit the largest vehicle: the catalogue's dims as drawn (HQV.hqVehicleModels.shown), and the bounding box of
  // every model actually built here (so a model rescaled elsewhere still fits); capped at R_MAX so neighbours never touch
  var need = 0, bbA = new THREE.Box3(), bbB = new THREE.Box3();
  function halfDiag(root){
    if(!root || !root.traverse) return 0;
    try {
      bbA.makeEmpty(); root.updateMatrixWorld(true);
      var inv = new THREE.Matrix4().copy(root.matrixWorld).invert(), rel = new THREE.Matrix4();
      root.traverse(function(o){ if(!o.isMesh || o.isSprite || !o.geometry || o.visible === false) return;
        if(!o.geometry.boundingBox) o.geometry.computeBoundingBox();
        rel.multiplyMatrices(inv, o.matrixWorld); bbB.copy(o.geometry.boundingBox).applyMatrix4(rel); bbA.union(bbB); });
      if(bbA.isEmpty()) return 0;
      return Math.hypot(bbA.max.x - bbA.min.x, bbA.max.z - bbA.min.z)/2;
    } catch(e){ return 0; }
  }
  function catList(){ var C = (c.catalogue && c.catalogue()) || HQV.hqVehicleCatalogue || null, vs = C && (C.vehicles || C); return Array.isArray(vs) ? vs : []; }
  (function(){ var VM = HQV.hqVehicleModels; if(!VM || !VM.dims) return;
    catList().forEach(function(e){ try { var d = VM.shown ? VM.shown(e) : VM.dims(e); if(d && d.lengthM > 0) need = Math.max(need, Math.hypot(d.lengthM, d.widthM || 0)/2); } catch(err){} }); })();
  function fit(h){
    if(h > need) need = h;
    var r = need > 0 ? fitR(need + 0.2) : R_DEF;
    if(Math.abs(r - L.r) < 0.01) return;
    L = layout({max: L.max, r: r}); drawPlinths(); drawMarks();
    bikes.forEach(function(b){ if(b.gallery != null) b.reach = r + 0.8; });
  }
  function measure(root){ var h = halfDiag(root); if(h > 0) fit(h); }
  fit(0);
  function addStarter(model, kind, n, extra){
    var p = L.plinths[n], yaw = p.yaw; measure(model.g); model.g.position.set(p.x, 0, p.z); model.g.rotation.y = yaw; S.add(model.g);
    model.g.traverse(function(o){ if(o.isMesh){ o.castShadow = true; } });
    var b = Object.assign({g: model.g, x: p.x, z: p.z, yaw: yaw, id: "lot:" + me + ":" + kind, stay: true, home: {x: p.x, z: p.z, yaw: yaw}, plinth: n, gallery: n,
                             reach: L.r + 0.8}, extra);   // reach: get on from the plinth's edge (on foot the plinth keeps you r - 0.2 away) [3.5.1]
    if(kind !== "bike") b.kind = kind;            // a bicycle: no kind, as hq3d.js expects
    bikes.push(b); return b;
  }
  // [3.13] the starters in their tune (games/hqtuning.js: this browser keeps it), rebuilt on their plinth after a save
  var Tn = HQV.hqTuning, VMs = HQV.hqVehicleModels;
  function starterModel(kind){
    var tn = Tn ? Tn.of("starter:" + kind) : null, pl = tn && tn.plate ? tn.plate : col.plate;
    var m = kind === "car" ? c.car(col.paint, col.accent, pl) : c.moto(col.accent, col.paint, pl);
    if(tn && m && VMs && VMs.tuneStarter) try { VMs.tuneStarter(THREE, m, tn, kind === "car" ? "car" : "bike"); } catch(e){}
    return m;
  }
  try { if(c.car) addStarter(starterModel("car"), "car", 0, {color: col.paint, accent: col.accent, plate: col.plate}); } catch(e){}
  try { if(c.moto) addStarter(starterModel("moto"), "moto", 1, {color: col.accent, accent: col.paint, plate: col.plate}); } catch(e){}
  try { if(c.bike) addStarter(c.bike(col.accent, col.paint), "bike", 2, {color: col.accent, accent: col.paint}); } catch(e){}

  var ownProps = {}, homesNow = null, listNow = null;
  function catEntry(id){
    var vs = catList();
    for(var i = 0; i < vs.length; i++) if(vs[i] && vs[i].id === id) return vs[i];
    return null;
  }
  function riddenOff(b){ return b && b.g && b.g.parent && b.g.parent !== S; }       // hq3d has it under you
  function rebuildOwn(){
    if(dead) return;
    var max = homesNow && homesNow.available !== false && homesNow.basement ? homesNow.basement.max : L.max;
    if(max !== L.max){ L = layout({max: max, r: L.r}); drawMarks(); drawBars(); drawPlinths(); }
    var rows = homesNow && homesNow.available !== false ? basementRows(listNow, homesNow, max) : [], want = {}, byBay = {};
    rows.forEach(function(r){ want["own:" + r.id] = r; r.entry = catEntry(r.vehicle_id); byBay[r.bay] = r;
      r.tune = HQV.hqTuning ? HQV.hqTuning.of("own:" + r.id) : null; r.tsig = r.tune ? JSON.stringify(r.tune) : ""; });   // [3.13] its tune
    Object.keys(ownProps).forEach(function(k){
      var b = ownProps[k], r = want[k];
      if(r && b.bay === r.bay && b.vehicle_id === r.vehicle_id && b.paintIdx === r.paint && b.tsig === r.tsig) return;
      if(riddenOff(b)) return;
      var i = bikes.indexOf(b); if(i >= 0) bikes.splice(i, 1);
      if(b.g.parent) b.g.parent.remove(b.g);
      delete ownProps[k];
    });
    rows.forEach(function(r){
      var k = "own:" + r.id; if(ownProps[k]) return;
      var entry = r.entry; if(!entry || !HQV.hqVehicleModels || !HQV.hqVehicleModels.build) return;
      var hex = paintHex(entry, r.paint), P = L.plinths[NSTART + r.bay] || bayPose(r.bay), rig;
      try { rig = HQV.hqVehicleModels.build(c, entry, hex, {tune: r.tune}); } catch(e){ return; }
      if(!rig || !rig.g) return;
      measure(rig.g);
      if(rig.ready && rig.ready.then) rig.ready.then(function(){ if(!dead) measure(rig.g); }, function(){});   // a model3d swapped in: measure again
      var g = new THREE.Group(); g.add(rig.g); g.position.set(P.x, 0, P.z); g.rotation.y = P.yaw; S.add(g);
      g.traverse(function(o){ if(o.isMesh) o.castShadow = true; });
      var o = {key: k, ownId: r.id, vehicleId: r.vehicle_id, color: hex, world: "basement", x: P.x, z: P.z, yaw: P.yaw, home: {x: P.x, z: P.z, yaw: P.yaw}, stored: false, basement: true, bay: r.bay};
      var b = {g: g, x: P.x, z: P.z, yaw: P.yaw, color: hex, paint: Math.max(0, r.paint | 0), paintIdx: r.paint, kind: r.vehicle_id, vehicle_id: r.vehicle_id, id: k, stay: true,
               world: w, rig: rig, own: o, home: {x: P.x, z: P.z, yaw: P.yaw}, bay: r.bay, gallery: NSTART + r.bay, reach: L.r + 0.8, tsig: r.tsig};
      bikes.push(b); ownProps[k] = b;
    });
    drawCards(byBay);
  }
  var dead = false, unsubs = [];
  function refresh(fresh){
    var G = HQV.hqGarage, M = HQV.hqGarageMgr;
    var pl1 = G && G.mine ? Promise.resolve().then(function(){ return G.mine(fresh); }).catch(function(){ return null; }) : Promise.resolve(null);
    var pl2 = M && M.homes ? Promise.resolve().then(function(){ return M.homes(fresh); }).catch(function(){ return null; }) : Promise.resolve(null);
    return Promise.all([pl1, pl2]).then(function(r){ if(r[0]) listNow = r[0]; if(r[1]) homesNow = r[1]; rebuildOwn(); });
  }
  try { if(HQV.hqGarage && HQV.hqGarage.onChange) unsubs.push(HQV.hqGarage.onChange(function(l){ listNow = l; rebuildOwn(); })); } catch(e){}
  try { if(Mgr && Mgr.onChange) unsubs.push(Mgr.onChange(function(H){ homesNow = H; rebuildOwn(); })); } catch(e){}
  // [3.13] a starter tuned at the shop: its plinth's model in the new tune (one you have driven off keeps its look)
  try { if(Tn && Tn.onChange) unsubs.push(Tn.onChange(function(key){
    if(dead) return;
    var kind = key === "starter:car" ? "car" : key === "starter:moto" ? "moto" : null; if(!kind) return;
    bikes.forEach(function(b){
      if(b.plinth == null || b.kind !== kind || b.own || riddenOff(b)) return;
      var m = null; try { m = starterModel(kind); } catch(e){ m = null; }
      if(!m || !m.g) return;
      m.g.position.copy(b.g.position); m.g.rotation.copy(b.g.rotation); m.g.visible = b.g.visible;
      m.g.traverse(function(o){ if(o.isMesh) o.castShadow = true; });
      if(b.g.parent) b.g.parent.remove(b.g);
      S.add(m.g); b.g = m.g;
    });
  })); } catch(e){}

  drawMarks(); drawBars(); drawPlinths(); drawCards({}); drawLounge(0);
  // merge the static group: a few draw calls for walls, slats, sofas, bar and plinth bases
  var merged = null;
  try { if(HQV.hqMerge && HQV.hqMerge.mergeStatic) merged = HQV.hqMerge.mergeStatic(THREE, st); } catch(e){}

  /* -------- the world's shape (see mount() in hq3d.js) */
  var padSpot = {x: PAD.x, z: PAD.z, yaw: PAD.yaw};
  w.ctx = c; w.pad = padSpot; w.layout = function(){ return L; };
  w.floor = floor; w.hits = hits; w.doors = doors; w.bikes = bikes;
  w.span = 14; w.zoom = 1; w.camY = 1.8; w.follow = 0.8; w.camPitch = 0.5;
  w.camModes = ["chase", "near", "fp", "classic", "photo"]; w.startMode = "chase";
  w.bounds = [-HW, HW, -HD, HD];
  w.groundY = function(){ return 0; };
  w.camHit = function(from, to){
    var t = 1;
    if(to.y > CAM_CEIL && to.y !== from.y){ var u = (CAM_CEIL - from.y)/(to.y - from.y); if(u >= 0 && u < t) t = u; }
    [[to.x, from.x, -HW + 0.4, HW - 0.4], [to.z, from.z, -HD + 0.4, HD - 0.4]].forEach(function(a){
      var d = a[0] - a[1]; if(!d) return;
      if(a[0] < a[2]){ var u1 = (a[2] - a[1])/d; if(u1 >= 0 && u1 < t) t = u1; }
      if(a[0] > a[3]){ var u2 = (a[3] - a[1])/d; if(u2 >= 0 && u2 < t) t = u2; }
    });
    return Math.max(0, Math.min(1, t));
  };
  w.spawn = {x: LIFT.x + 2.4, z: LIFT.z, yaw: PI/2};
  // [3.5.1] off the car lift you (and what you rode) arrive just off the pad, facing into B1, clear of its trigger
  var arriveSpot = {x: PAD.x + Math.sin(PAD.yaw)*(PAD.d/2 + 2.6), z: PAD.z + Math.cos(PAD.yaw)*(PAD.d/2 + 2.6), yaw: PAD.yaw};
  w.arrive = arriveSpot;
  w.spawnFrom = {city: arriveSpot, lobby: {x: LIFT.x + 2.4, z: LIFT.z, yaw: PI/2}, base: arriveSpot};
  w.home = w.spawnFrom.lobby;
  w.blocked = function(x, z){ var m = c.motion && c.motion(); return blockedAt(L, x, z, !!(m && m.ride)); };
  w.stale = false;
  w.onEnter = function(from, opts){
    refresh(true);
    fx("enter", c, w);   // [integrate] lets valet() animate props in this live world
    var dir = from === "lobby" ? "lobby" : "down";
    if(from === "lobby") fxArr = fx("lobbyRide", c, w);
    else fxArr = fx("liftArrival", c, w, {dir: "down"});
    var k0 = (opts && opts.k != null) ? opts.k : (c.E && c.E.calm && c.E.calm() ? 0 : lastK);
    if(Lift && Lift.create && dir === "down") try { liftState = Lift.create({dir: "down", depth: 6, k: k0}); } catch(e){ liftState = null; }
    floorChip(k0);
    if(dir === "lobby") pOpen = 1;
  };
  w.setTime = function(night, weather){
    hemi.intensity = night ? 1.8 : 2.1;
    pts.forEach(function(l, i){ l.intensity = l.userData.base*(night ? 1.1 : 1); l.color.setHex(night ? 0xffcf96 : (i === 3 ? 0xffb978 : WARM_HI)); });
    fx("lighting", w, {night: !!night, weather: weather || null});
  };
  w.onData = function(){};
  w.onLook = function(){};
  // the floor indicator for the ride down (car lift or person lift): G -> B1 lit as the platform passes, doors, then it
  // fades; in Calm it shows B1 at once and fades quickly. Text only (textContent), theme tokens, polite live region.
  var chip = null, chipT = 0, chipK = 1, chipSaid = false;
  function floorChip(k){
    chipK = k; chipT = 0; chipSaid = false; if(!c.el || !document.createElement) return;
    if(!chip){ chip = document.createElement("div"); chip.className = "hqb1-floor"; chip.setAttribute("role", "status"); chip.setAttribute("aria-live", "polite");
      chip.style.cssText = "position:absolute;top:14px;left:14px;display:flex;gap:6px;align-items:center;padding:6px 12px;border-radius:999px;"
        + "background:var(--panel,#111a);color:var(--ink,#eee);border:1px solid var(--line,#333);font:600 13px/1 var(--mono,ui-monospace,monospace);pointer-events:none;z-index:5;transition:opacity .35s";
      ["G", "\u25bc", "B1", ""].forEach(function(tx, i){ var sp = document.createElement("span"); sp.textContent = tx; if(i === 3){ sp.style.fontWeight = "400"; sp.style.color = "var(--muted,#999)"; } chip.appendChild(sp); });
      c.el.appendChild(chip); }
    chip.style.opacity = "1"; chip.hidden = false; chipDraw(k < 0.5 ? "B1" : "G", k < 0.5 ? "" : "doors closing");
  }
  function chipDraw(floor, note){
    if(!chip) return; var sp = chip.children;
    sp[0].style.color = floor === "G" ? "var(--gold,#f2c230)" : "var(--faint,#666)"; sp[2].style.color = floor === "B1" ? "var(--gold,#f2c230)" : "var(--faint,#666)";
    if(sp[3].textContent !== note) sp[3].textContent = note;
    if(floor === "B1" && !chipSaid){ chipSaid = true; sp[3].textContent = note || "B1 \u00b7 your basement garage"; }
  }
  function chipStep(dt){
    if(!chip || chip.hidden) return;
    chipT += dt;
    var ls = liftState, fs = fxArr && fxArr.state ? fxArr.state() : null;
    if(ls) chipDraw(ls.floor, ls.phase === "closing" ? "doors closing" : ls.phase === "moving" ? "going down" : ls.phase === "opening" ? "doors opening" : "");
    else if(fs && fs.floor) chipDraw(fs.floor === "B1" || fs.floor === -1 ? "B1" : "G", "");
    else chipDraw("B1", "");
    var hold = chipK < 0.5 ? 0.9 : 1.6;
    if(!ls && (!fxArr || chipK < 0.5) && chipT > hold){ chip.style.opacity = "0"; if(chipT > hold + 0.5) chip.hidden = true; }
  }
  var acc = 0, turn = 0, lastK = 1;
  w.update = function(t, dt, k){
    if(k == null) k = 1; lastK = k; dt = Math.min(0.1, Math.max(0, dt || 0));
    acc += dt; if(acc > 0.12){ acc = 0; if(k > 0) drawLounge(t); }
    anims.forEach(function(f){ try { f(t, k); } catch(e){} });
    // the turntables: 0.25 rad/s, scaled by k (still in Calm); a starter at home turns with its disc
    var dTurn = 0.25*k*dt; turn += dTurn;
    if(fxPl && fxPl.update) fxPl.update(t, dt, k);
    if(dTurn) bikes.forEach(function(b){   // [3.5.4] every vehicle at home on its gallery plinth turns, not only the starters
      if(b.gallery == null || riddenOff(b) || !b.home) return;
      if(Math.hypot(b.x - b.home.x, b.z - b.home.z) > 0.05) return;
      b.yaw += dTurn; b.g.rotation.y = b.yaw;
    });
    coneI.material.opacity = 0.08 + 0.02*Math.sin(t*1.3*k);
    // the person-lift doors open as you come near
    var av = c.avatar && c.avatar();
    var want = av && Math.hypot(av.x - LIFT.x, av.z - LIFT.z) < 3.4 ? 1 : 0;
    pOpen += (want - pOpen)*Math.min(1, dt*4); pdl.position.x = -0.6 - pOpen*1.05; pdr.position.x = 0.6 + pOpen*1.05; plight.intensity = pOpen*24;
    if(liftState && Lift && Lift.step){ try { Lift.step(liftState, dt); if(carLift && carLift.update) carLift.update(liftState, t, k); if(liftState.done) liftState = null; } catch(e){ liftState = null; } }
    if(fxArr && fxArr.update){ try { fxArr.update(t, dt, k); if(fxArr.done && fxArr.done()) fxArr = null; } catch(e){ fxArr = null; } }
    if(fxLounge && fxLounge.update) try { fxLounge.update(t, dt, k); } catch(e){}
    fx("update", t, dt, k);   // [integrate] valet drives + lift rides
    chipStep(dt);
  };
  w.drawCalls = function(){ return merged ? merged.after : null; };
  w.onLeave = function(){ if(chip) chip.hidden = true; };
  w.destroy = function(){ dead = true; if(chip && chip.parentNode) chip.parentNode.removeChild(chip); chip = null; fx("leave"); unsubs.forEach(function(u){ try { if(typeof u === "function") u(); } catch(e){} }); unsubs = []; };
  w.refresh = refresh;
  refresh(false);
  return w;
};
})();
