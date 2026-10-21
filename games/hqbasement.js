/* Claude HQ 3.4: the Basement Garage (B1), under your HQ. HQV.hqWorlds.basement and HQV.hqBasement.
 *
 * A lavish private garage, entered by the car lift from the street (drive on, drive down) or by the person lift
 * from the Lobby: polished dark epoxy with mirrored light strips, instanced columns with uplights, continuous LED
 * ceiling strips, your HQ's name in neon on the back wall, 12 numbered bays (only the ones your level has
 * unlocked are lit; the rest read "Unlocks at level N"), three showcase turntables S1-S3 for the starter car,
 * motorbike and bicycle, an EV charging corner, a lounge behind glass, the car-lift platform, the person-lift
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
 * Pure helpers (HQV.hqBasement): layout(level|{max}), bayPose(i), nameFor(h), basementMax(level), lockLevel(i),
 * paintHex(entry, paint), basementRows(list, homes), blockedAt(L, x, z, riding), adopt(w, ride), toast(c, msg).
 */
(function(){
"use strict";
var HQV = window.HQV = window.HQV || {};
HQV.hqWorlds = HQV.hqWorlds || {};

var PI = Math.PI;
var HW = 32, HD = 20;            // half width (x) and half depth (z), metres: a 64 x 40 floor
var CEIL = 4.6, CAM_CEIL = 4.2;  // the slab, and where the camera stops under it
var NBAYS = 12, BAY_W = 4.6, BAY_X0 = -17, ROW_Z = 13;
var PAD = {x: 24.5, z: 6.5, w: 7, d: 6.2, yaw: -PI/2};          // the car-lift platform (the city bay's footprint)
var PLINTH_R = 2.3, PLINTHS = [{x: 12, z: -13}, {x: 19, z: -13}, {x: 26, z: -13}];
var LIFT = {x: -HW + 0.3, z: 9};                                 // the person-lift doors, on the left wall
var KIOSK = {x: -24.5, z: 3.2};
var LOUNGE = {x0: -HW, x1: -22.6, z0: -HD, z1: -6};              // behind glass, back left
var EV = {x: 13, z: 16.4};                                       // the charging corner, front right
var COLS = [];
[-19.3, -10.1, -0.9, 8.3].forEach(function(x){ COLS.push({x: x, z: -8.4}, {x: x, z: 8.4}); });
COLS.push({x: 16, z: -6.5}, {x: 16, z: 1.2});

function basementMax(level){ var l = Math.max(0, Math.floor(+level || 0)); return Math.min(NBAYS, 4 + Math.floor(l/5)); }
// the level a bay unlocks at: max > i  <=>  floor(level/5) >= i - 3
function lockLevel(i){ return Math.max(0, (i - 3)*5); }
function bayPose(i){
  i = i | 0; var row = i < 6 ? 0 : 1, k = row ? i - 6 : i;
  return {i: i, x: BAY_X0 + k*BAY_W, z: row ? ROW_Z : -ROW_Z, yaw: row ? PI : 0, w: 3.4, d: 5.6, label: String(i + 1)};
}
function layout(level){
  var max = level && typeof level === "object" ? Math.max(0, Math.min(NBAYS, level.max | 0)) : basementMax(level);
  var bays = [];
  for(var i = 0; i < NBAYS; i++){ var b = bayPose(i); b.lit = i < max; b.unlock = lockLevel(i); bays.push(b); }
  return {W: 2*HW, D: 2*HD, ceil: CEIL, max: max, bays: bays,
          plinths: PLINTHS.map(function(p, n){ return {x: p.x, z: p.z, r: PLINTH_R, yaw: PI/6, label: "S" + (n + 1), kind: ["car", "moto", "bike"][n]}; }),
          pad: {x: PAD.x, z: PAD.z, w: PAD.w, d: PAD.d, yaw: PAD.yaw},
          lift: {x: LIFT.x, z: LIFT.z, front: {x: LIFT.x + 2.2, z: LIFT.z, yaw: PI/2}},
          kiosk: {x: KIOSK.x, z: KIOSK.z}, lounge: LOUNGE, ev: EV, cols: COLS.slice()};
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
  if(x < LOUNGE.x1 + 0.35 && z < LOUNGE.z1 + 0.35) return true;                               // the lounge glass
  if(!riding) for(var p = 0; p < PLINTHS.length; p++) if(Math.hypot(x - PLINTHS[p].x, z - PLINTHS[p].z) < PLINTH_R - 0.2) return true;
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
  var P = w && w.pad || PAD, bs = w && w.bikes;
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

HQV.hqBasement = {layout: layout, bayPose: bayPose, nameFor: nameFor, basementMax: basementMax, lockLevel: lockLevel,
  paintHex: paintHex, basementRows: basementRows, blockedAt: blockedAt, adopt: adopt, toast: toast,
  PAD: PAD, NBAYS: NBAYS, CEIL: CEIL, CAM_CEIL: CAM_CEIL, BOUNDS: [-HW, HW, -HD, HD]};

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
  var accent = col.accent, neon = [0xff4fd8, 0x4fe3ff, 0xffb347, 0x7dff9a][Math.floor(R()*4)];
  var Fx = HQV.hqBasementFx, Mgr = HQV.hqGarageMgr, Lift = HQV.hqCarLift;
  var L = layout(h.level), hits = [], doors = [], bikes = [], anims = [];
  var st = new THREE.Group(); st.name = "basement:static"; S.add(st);      // static: merged at the end
  var dyn = new THREE.Group(); dyn.name = "basement:dyn"; S.add(dyn);
  var mat = c.mat, box = c.box;
  function basic(color, o){ return new THREE.MeshBasicMaterial(Object.assign({color: color, toneMapped: false}, o || {})); }

  // light: dim and warm-cool, the strips do the rest
  S.background = new THREE.Color(0x05070a);
  S.fog = new THREE.Fog(0x05070a, 26, 70);
  var hemi = new THREE.HemisphereLight(0x9fb8d8, 0x0b0d10, 1.1); S.add(hemi);
  var keyL = new THREE.DirectionalLight(0xdfe8ff, 0.7); keyL.position.set(-6, CEIL - 0.2, 4); keyL.castShadow = true;
  keyL.shadow.mapSize.set(1024, 1024); var sc = keyL.shadow.camera; sc.left = -HW; sc.right = HW; sc.top = HD; sc.bottom = -HD; sc.far = 30;
  S.add(keyL); S.add(keyL.target);
  var pts = [];
  [[-8, -6, 0xfff1d6, 26], [8, 4, 0xdfe8ff, 22], [19, -13, 0xffe2b0, 30], [-27, -13, 0xffc58a, 18]].forEach(function(p){
    var l = new THREE.PointLight(p[2], p[3], 26, 2); l.position.set(p[0], CEIL - 0.6, p[1]); l.userData.base = p[3]; S.add(l); pts.push(l); });

  // the floor: dark epoxy, a reflection from a little strip-lit environment (no realtime mirror)
  var envMap = null;
  try {
    var env = c.canvasTex(256, 128, function(g, W){ g.fillStyle = "#06080b"; g.fillRect(0, 0, 256, 128); g.fillStyle = "#cfe3ff";
      for(var i = 0; i < 8; i++) g.fillRect(i*32 + 8, 4, 18, 12); g.fillStyle = "#2a3644"; g.fillRect(0, 70, 256, 58); });
    if(env && env.t){ envMap = env.t; envMap.mapping = THREE.EquirectangularReflectionMapping; }
  } catch(e){}
  var floor = new THREE.Mesh(new THREE.PlaneGeometry(2*HW, 2*HD), new THREE.MeshStandardMaterial({color: 0x15191f, roughness: 0.15, metalness: 0.55, envMap: envMap, envMapIntensity: 0.9}));
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
      if(gr){ gr.addColorStop(0, "rgba(200,225,255,0)"); gr.addColorStop(0.5, "rgba(200,225,255,.16)"); gr.addColorStop(1, "rgba(200,225,255,0)"); g.fillStyle = gr; }
      else g.fillStyle = "rgba(200,225,255,.12)";
      g.fillRect(X(-HW + 2), zz - 10, X(HW - 2) - X(-HW + 2), 20); }
    L.bays.forEach(function(b){
      var x0 = X(b.x - b.w/2), x1 = X(b.x + b.w/2), zf = Z(b.z + (b.z < 0 ? b.d/2 : -b.d/2)), zb = Z(b.z - (b.z < 0 ? b.d/2 : -b.d/2));
      g.strokeStyle = b.lit ? "rgba(255,255,255,.85)" : "rgba(140,150,160,.35)"; g.lineWidth = 5;
      g.beginPath(); g.moveTo(x0, zf); g.lineTo(x0, zb); g.lineTo(x1, zb); g.lineTo(x1, zf); g.stroke();
      if(b.lit){ g.fillStyle = "rgba(255,179,71,.07)"; g.fillRect(x0, Math.min(zf, zb), x1 - x0, Math.abs(zb - zf)); }
      g.textAlign = "center"; g.fillStyle = b.lit ? (HEX.amber || "#ffb347") : "rgba(160,170,180,.5)";
      g.font = "800 64px system-ui, sans-serif"; g.fillText(b.label, X(b.x), Z(b.z) + 22);
      if(!b.lit){ g.font = "600 22px system-ui, sans-serif"; g.fillText("Unlocks at level " + b.unlock, X(b.x), Z(b.z) + 64); }
    });
    // aisle chevrons toward the car lift, and the lift pad's hatching
    g.fillStyle = "rgba(255,179,71,.35)";
    for(var ax = -22; ax < 18; ax += 6){ var cx = X(ax), cz = Z(0); g.beginPath(); g.moveTo(cx, cz - 26); g.lineTo(cx + 26, cz); g.lineTo(cx, cz + 26); g.lineTo(cx + 10, cz); g.fill(); }
    g.strokeStyle = "rgba(255,210,60,.7)"; g.lineWidth = 6; g.strokeRect(X(PAD.x - PAD.d/2 - 0.3), Z(PAD.z - PAD.w/2 - 0.3), (PAD.d + 0.6)*u, (PAD.w + 0.6)*u);
    PLINTHS.forEach(function(p, n){ g.fillStyle = "rgba(255,255,255,.55)"; g.font = "800 40px system-ui, sans-serif"; g.textAlign = "center"; g.fillText("S" + (n + 1), X(p.x), Z(p.z + PLINTH_R + 0.7)); });
    mk.t.needsUpdate = true;
  }

  // walls and the ceiling slab (concrete), with a skirting light line
  var conc = mat(0x2b3036, {roughness: 0.92}), slabM = mat(0x2a2f35, {roughness: 0.95});
  box(2*HW, 0.4, 2*HD, slabM, 0, CEIL + 0.2, 0, st, true);
  box(2*HW, CEIL, 0.5, conc, 0, CEIL/2, -HD - 0.25, st); box(2*HW, CEIL, 0.5, conc, 0, CEIL/2, HD + 0.25, st);
  box(0.5, CEIL, 2*HD, conc, -HW - 0.25, CEIL/2, 0, st); box(0.5, CEIL, 2*HD, conc, HW + 0.25, CEIL/2, 0, st);
  var skirt = basic(accent);
  box(2*HW, 0.05, 0.05, skirt, 0, 0.12, -HD + 0.03, st, true); box(2*HW, 0.05, 0.05, skirt, 0, 0.12, HD - 0.03, st, true);
  box(0.05, 0.05, 2*HD, skirt, -HW + 0.03, 0.12, 0, st, true); box(0.05, 0.05, 2*HD, skirt, HW - 0.03, 0.12, 0, st, true);
  // a timber-slat feature wall behind the neon
  var slat = mat(0x6b4529, {roughness: 0.6});
  for(var sx = -16; sx <= 4; sx += 0.42) box(0.22, CEIL - 0.6, 0.12, slat, sx, (CEIL - 0.6)/2 + 0.2, -HD + 0.07, st);

  // the LED ceiling strips: one InstancedMesh; the columns and their uplights: two more
  var stripG = new THREE.BoxGeometry(1, 0.06, 0.22), strips = [];
  for(var s = -3; s <= 3; s++) strips.push([0, s*4.2, 2*HW - 4]);
  for(var xs = -24; xs <= 24; xs += 12) strips.push([xs, 0, 0.9, 2*HD - 4]);
  var stripI = new THREE.InstancedMesh(stripG, basic(0xeaf3ff), strips.length), m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), v1 = new THREE.Vector3(), v2 = new THREE.Vector3();
  strips.forEach(function(sp, i){
    if(sp.length === 3) m4.compose(v1.set(sp[0], CEIL - 0.04, sp[1]), q.identity(), v2.set(sp[2], 1, 1));
    else m4.compose(v1.set(sp[0], CEIL - 0.04, sp[1]), q.identity(), v2.set(0.22, 1, sp[3]/0.22));
    stripI.setMatrixAt(i, m4);
  });
  stripI.name = "basement:strips"; S.add(stripI);
  var colI = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.42, 0.42, CEIL, 20), mat(0xd9dee3, {roughness: 0.35, metalness: 0.2}), COLS.length);
  var upI = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.43, 0.75, 1.6, 20, 1, true), basic(accent, {transparent: true, opacity: 0.1, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide}), COLS.length);
  COLS.forEach(function(p, i){ m4.compose(v1.set(p.x, CEIL/2, p.z), q.identity(), v2.set(1, 1, 1)); colI.setMatrixAt(i, m4);
    m4.compose(v1.set(p.x, 0.8, p.z), q.identity(), v2.set(1, 1, 1)); upI.setMatrixAt(i, m4); });
  colI.castShadow = true; colI.receiveShadow = true; colI.name = "basement:columns"; upI.name = "basement:uplights"; S.add(colI); S.add(upI);
  // a light bar over every bay, lit in amber when unlocked (instance colours)
  var barI = new THREE.InstancedMesh(new THREE.BoxGeometry(2.8, 0.05, 0.16), basic(0xffffff), NBAYS), tint = new THREE.Color();
  function drawBars(){
    L.bays.forEach(function(b, i){ m4.compose(v1.set(b.x, CEIL - 0.05, b.z + (b.z < 0 ? -1.2 : 1.2)), q.identity(), v2.set(1, 1, 1)); barI.setMatrixAt(i, m4);
      barI.setColorAt(i, tint.setHex(b.lit ? 0xffc979 : 0x2a3038)); });
    barI.instanceMatrix.needsUpdate = true; if(barI.instanceColor) barI.instanceColor.needsUpdate = true;
  }
  barI.name = "basement:baybars"; S.add(barI);

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

  // the showcase turntables S1-S3 with spot cones; the starters stand on them
  var plinthM = mat(0x0f1216, {roughness: 0.2, metalness: 0.7}), ringM = basic(accent);
  var discs = [], cones = [];
  L.plinths.forEach(function(p){
    var base = new THREE.Mesh(new THREE.CylinderGeometry(p.r, p.r + 0.1, 0.06, 48), plinthM); base.position.set(p.x, 0.03, p.z); base.receiveShadow = true; st.add(base);
    var ring = new THREE.Mesh(new THREE.TorusGeometry(p.r + 0.02, 0.025, 6, 64), ringM); ring.rotation.x = -PI/2; ring.position.set(p.x, 0.065, p.z); dyn.add(ring);
    var disc = new THREE.Mesh(new THREE.CylinderGeometry(p.r - 0.12, p.r - 0.12, 0.02, 48), mat(0x23282f, {roughness: 0.25, metalness: 0.6})); disc.position.set(p.x, 0.07, p.z); disc.userData.anim = 1; dyn.add(disc);
    discs.push(disc);
    var cone = new THREE.Mesh(new THREE.CylinderGeometry(0.25, p.r, CEIL - 0.1, 32, 1, true), basic(0xfff3d9, {transparent: true, opacity: 0.08, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide}));
    cone.position.set(p.x, (CEIL - 0.1)/2, p.z); dyn.add(cone); cones.push(cone);
    var tag = c.label ? c.label(p.label + " · Showcase", HEX.amber || "#ffb347", 0.42) : null; if(tag){ tag.position.set(p.x, 3.4, p.z); dyn.add(tag); }
  });

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
  var glass = mat(0xbfe3f5, {transparent: true, opacity: 0.14, roughness: 0.04, metalness: 0.1});
  var gx = LOUNGE.x1, gz = LOUNGE.z1;
  var gw1 = new THREE.Mesh(new THREE.BoxGeometry(0.06, CEIL - 0.1, gz - LOUNGE.z0), glass); gw1.position.set(gx, (CEIL - 0.1)/2, (gz + LOUNGE.z0)/2); dyn.add(gw1);
  var gw2 = new THREE.Mesh(new THREE.BoxGeometry(gx - LOUNGE.x0, CEIL - 0.1, 0.06), glass); gw2.position.set((gx + LOUNGE.x0)/2, (CEIL - 0.1)/2, gz); dyn.add(gw2);
  var frameM = mat(0x2c3238, {metalness: 0.8, roughness: 0.3});
  box(0.1, 0.1, gz - LOUNGE.z0, frameM, gx, CEIL - 0.05, (gz + LOUNGE.z0)/2, st); box(gx - LOUNGE.x0, 0.1, 0.1, frameM, (gx + LOUNGE.x0)/2, CEIL - 0.05, gz, st);
  var sofa = mat(0x40242e, {roughness: 0.95}), cush = mat(0x5a3341, {roughness: 0.95});
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
  hits.push(gw1, gw2); gw1.userData.tip = gw2.userData.tip = "The B1 lounge: a sofa, a bar and a screen, behind glass";

  // the car-lift platform (games/hqcarlift.js when it is there, else a plain chevroned pad), door up to the street
  var liftDoor = {view: "@base", kind: "carlift", label: "Car lift", tip: "Car lift: drive on to go up to the street (G)",
                  front: new THREE.Vector3(PAD.x - PAD.d/2 - 1.4, 0, PAD.z)};
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
  if(!kioskDoor.front) kioskDoor.front = new THREE.Vector3(KIOSK.x + 1.4, 0, KIOSK.z);
  doors.push(kioskDoor);
  if(c.label){ var kTag = c.label("Garage manager", HEX.cyan || "#4fe3ff", 0.42); kTag.position.set(KIOSK.x, 2.4, KIOSK.z); dyn.add(kTag); }

  // a few plants, seeded
  if(c.plant){ var pr = c.rng ? c.rng(seed ^ 0x9e3) : R; [[-21.5, -18.5], [9.5, -18.6], [30.6, -18.4], [-21.4, 18.4], [30.6, 18.4]].forEach(function(p, n){
    try { var pp = c.plant(p[0], p[1], 0.9 + pr()*0.4, (seed + n) % 997); if(pp && pp.parent !== st && pp.isObject3D){ /* c.plant adds itself to the scene */ } } catch(e){} }); }

  // the experience layer (games/hqbasementfx.js): each optional
  var fxPl = null, fxLounge = null, fxPhoto = null, fxTrophy = null, fxArr = null;
  function fx(name){ var a = Array.prototype.slice.call(arguments, 1); try { return Fx && typeof Fx[name] === "function" ? Fx[name].apply(Fx, a) : null; } catch(e){ return null; } }
  fxPl = fx("plinths", c, dyn, L.plinths.map(function(p, i){ return {x: p.x, z: p.z, r: p.r, disc: discs[i], cone: cones[i], label: p.label}; }));
  fxTrophy = fx("trophyWall", c, dyn, {x: 9.5, y: 2.2, z: -HD + 0.2, yaw: 0, w: 8});
  fxLounge = fx("lounge", c, dyn, {x: -27, z: -14, screen: lsScreen});
  fxPhoto = fx("photoSpot", c, dyn, {x: 19, z: -6.8, yaw: PI});

  /* -------- the vehicles: the starters on their turntables, and your basement-homed owned vehicles in their bays */
  function addStarter(model, kind, n, extra){
    var p = L.plinths[n], yaw = p.yaw; model.g.position.set(p.x, 0, p.z); model.g.rotation.y = yaw; S.add(model.g);
    model.g.traverse(function(o){ if(o.isMesh){ o.castShadow = true; } });
    var b = Object.assign({g: model.g, x: p.x, z: p.z, yaw: yaw, id: "lot:" + me + ":" + kind, stay: true, home: {x: p.x, z: p.z, yaw: yaw}, plinth: n}, extra);
    if(kind !== "bike") b.kind = kind;            // a bicycle: no kind, as hq3d.js expects
    bikes.push(b); return b;
  }
  try { if(c.car) addStarter(c.car(col.paint, col.accent, col.plate), "car", 0, {color: col.paint, accent: col.accent, plate: col.plate}); } catch(e){}
  try { if(c.moto) addStarter(c.moto(col.accent, col.paint, col.plate), "moto", 1, {color: col.accent, accent: col.paint, plate: col.plate}); } catch(e){}
  try { if(c.bike) addStarter(c.bike(col.accent, col.paint), "bike", 2, {color: col.accent, accent: col.paint}); } catch(e){}

  var ownProps = {}, homesNow = null, listNow = null;
  function catEntry(id){
    var C = (c.catalogue && c.catalogue()) || HQV.hqVehicleCatalogue || null, vs = C && (C.vehicles || C);
    if(!Array.isArray(vs)) return null;
    for(var i = 0; i < vs.length; i++) if(vs[i] && vs[i].id === id) return vs[i];
    return null;
  }
  function riddenOff(b){ return b && b.g && b.g.parent && b.g.parent !== S; }       // hq3d has it under you
  function rebuildOwn(){
    if(dead) return;
    var max = homesNow && homesNow.available !== false && homesNow.basement ? homesNow.basement.max : L.max;
    if(max !== L.max){ L = layout({max: max}); drawMarks(); drawBars(); }
    var rows = homesNow && homesNow.available !== false ? basementRows(listNow, homesNow, max) : [], want = {};
    rows.forEach(function(r){ want["own:" + r.id] = r; });
    Object.keys(ownProps).forEach(function(k){
      var b = ownProps[k], r = want[k];
      if(r && b.bay === r.bay && b.vehicle_id === r.vehicle_id && b.paintIdx === r.paint) return;
      if(riddenOff(b)) return;
      var i = bikes.indexOf(b); if(i >= 0) bikes.splice(i, 1);
      if(b.g.parent) b.g.parent.remove(b.g);
      delete ownProps[k];
    });
    rows.forEach(function(r){
      var k = "own:" + r.id; if(ownProps[k]) return;
      var entry = catEntry(r.vehicle_id); if(!entry || !HQV.hqVehicleModels || !HQV.hqVehicleModels.build) return;
      var hex = paintHex(entry, r.paint), P = bayPose(r.bay), rig;
      try { rig = HQV.hqVehicleModels.build(c, entry, hex); } catch(e){ return; }
      if(!rig || !rig.g) return;
      var g = new THREE.Group(); g.add(rig.g); g.position.set(P.x, 0, P.z); g.rotation.y = P.yaw; S.add(g);
      var o = {key: k, ownId: r.id, vehicleId: r.vehicle_id, color: hex, world: "basement", x: P.x, z: P.z, yaw: P.yaw, home: {x: P.x, z: P.z, yaw: P.yaw}, stored: false, basement: true, bay: r.bay};
      var b = {g: g, x: P.x, z: P.z, yaw: P.yaw, color: hex, paint: Math.max(0, r.paint | 0), paintIdx: r.paint, kind: r.vehicle_id, vehicle_id: r.vehicle_id, id: k, stay: true,
               world: w, rig: rig, own: o, home: {x: P.x, z: P.z, yaw: P.yaw}, bay: r.bay};
      bikes.push(b); ownProps[k] = b;
    });
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

  drawMarks(); drawBars(); drawLounge(0);
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
  w.spawnFrom = {city: padSpot, lobby: {x: LIFT.x + 2.4, z: LIFT.z, yaw: PI/2}, base: padSpot};
  w.home = w.spawnFrom.lobby;
  w.blocked = function(x, z){ var m = c.motion && c.motion(); return blockedAt(L, x, z, !!(m && m.ride)); };
  w.stale = false;
  w.onEnter = function(from, opts){
    refresh(true);
    var dir = from === "lobby" ? "lobby" : "down";
    if(from === "lobby") fxArr = fx("lobbyRide", c, w);
    else fxArr = fx("liftArrival", c, w, {dir: "down"});
    if(Lift && Lift.create) try { liftState = Lift.create({dir: "down", depth: 6, k: (opts && opts.k != null) ? opts.k : 1}); } catch(e){ liftState = null; }
    if(dir === "lobby") pOpen = 1;
  };
  w.setTime = function(night, weather){
    hemi.intensity = night ? 0.9 : 1.15;
    pts.forEach(function(l){ l.intensity = l.userData.base*(night ? 1.15 : 1); l.color.setHex(night ? 0xffe0b8 : 0xfff1d6); });
    fx("lighting", w, {night: !!night, weather: weather || null});
  };
  w.onData = function(){};
  w.onLook = function(){};
  var acc = 0, turn = 0;
  w.update = function(t, dt, k){
    if(k == null) k = 1; dt = Math.min(0.1, Math.max(0, dt || 0));
    acc += dt; if(acc > 0.12){ acc = 0; if(k > 0) drawLounge(t); }
    anims.forEach(function(f){ try { f(t, k); } catch(e){} });
    // the turntables: 0.25 rad/s, scaled by k (still in Calm); a starter at home turns with its disc
    var dTurn = 0.25*k*dt; turn += dTurn;
    if(fxPl && fxPl.update) fxPl.update(t, dt, k); else discs.forEach(function(d){ d.rotation.y = turn; });
    if(dTurn) bikes.forEach(function(b){
      if(b.plinth == null || riddenOff(b) || !b.home) return;
      if(Math.hypot(b.x - b.home.x, b.z - b.home.z) > 0.05) return;
      b.yaw += dTurn; b.g.rotation.y = b.yaw;
    });
    cones.forEach(function(cn, i){ cn.material.opacity = 0.07 + 0.025*Math.sin(t*1.3*k + i); });
    // the person-lift doors open as you come near
    var av = c.avatar && c.avatar();
    var want = av && Math.hypot(av.x - LIFT.x, av.z - LIFT.z) < 3.4 ? 1 : 0;
    pOpen += (want - pOpen)*Math.min(1, dt*4); pdl.position.x = -0.6 - pOpen*1.05; pdr.position.x = 0.6 + pOpen*1.05; plight.intensity = pOpen*24;
    if(liftState && Lift && Lift.step){ try { Lift.step(liftState, dt); if(carLift && carLift.update) carLift.update(liftState); if(liftState.done) liftState = null; } catch(e){ liftState = null; } }
    if(fxArr && fxArr.update){ try { fxArr.update(t, dt, k); if(fxArr.done && fxArr.done()) fxArr = null; } catch(e){ fxArr = null; } }
    if(fxLounge && fxLounge.update) try { fxLounge.update(t, dt, k); } catch(e){}
  };
  w.drawCalls = function(){ return merged ? merged.after : null; };
  w.destroy = function(){ dead = true; unsubs.forEach(function(u){ try { if(typeof u === "function") u(); } catch(e){} }); unsubs = []; };
  w.refresh = refresh;
  refresh(false);
  return w;
};
})();
