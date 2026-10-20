/* Claude HQ: the air side of a City (HQV.hqair): helipads and helicopters, the Commons' air base and its
 * aircraft carrier, and fighter jets flying over the islands.
 *
 * Pure core (tests/test_hqheli.py runs it under node): no THREE, no DOM, no clock.
 *   jetsAt(ms, P) -> [{id, x, y, z, yaw, pitch, roll, ab, v}]   where every jet is at wall-clock time ms (Date.now():
 *                   everyone sees the same sortie). P = {cx, cz (the island's centre), seed (the world's hash),
 *                   carrier: {x, z, yaw, deck} or null}. A sortie every CYCLE ms, picked by a hash of its number:
 *                   a pair on a straight flyover, a pair on a racetrack over the city (in, a banked half circle,
 *                   out), or (with a carrier) one jet catapulted off its bow while another traps on its stern.
 *   rectHit(R, x, z) is (x, z) inside the turned rectangle R = {x, z, hw, hd, rot}
 * create(c, S, o) -> A: what a City (games/hqcity3d.js) draws and asks. o = {W (the world doc), sea (ocean.js
 *   seaOf, or null), commons (bool: the air base and the carrier), civics (hqcivic buildings), blocked(x, z) and
 *   groundY(x, z) (the City's, before this), night}.
 *   A.props(mine) -> the helicopters you can fly (hq3d bikes: {g, x, y, z, yaw, kind, id, stay}); mine = your HQ
 *     entry ({x, z, lot}) puts a pad and your own helicopter by it, once
 *   A.blocked(x, z), A.groundAt(x, z) (pads and the base's apron, else null), A.floor(x, z) (what a helicopter
 *     lands on here: the apron, a hangar roof, the carrier's deck; else null), A.landSpot(st) (where you step out of
 *     a helicopter on the ground at st, or null: never at sea, a roof pad's building gives you its door)
 *   A.update(t, dt, k (the motion scale), cam), A.setNight(n), A.destroy()
 */
(function(){
"use strict";
var HQV = window.HQV = window.HQV || {};
var PI = Math.PI;

/* ---------- the sorties (pure) ---------- */
var CYCLE = 60000;                 // ms per sortie
var JET = {fly: 210, race: 180, R: 520, L: 3200, alt: 210, raceAlt: 320, launch: 30, trap: 70, glide: 0.061};
function hash(n){ n = (n | 0) ^ 0x9e3779b9; n = Math.imul(n ^ (n >>> 16), 0x85ebca6b); n = Math.imul(n ^ (n >>> 13), 0xc2b2ae35); return (n ^ (n >>> 16)) >>> 0; }
function u01(n){ return (hash(n) % 100000)/100000; }
function clamp(v, a, b){ return v < a ? a : v > b ? b : v; }
// a jet at p heading h (unit, xz) -> pose; the wingman: back, to the right, up
function pose(id, x, y, z, hx, hz, pitch, roll, ab, v){ return {id: id, x: x, y: y, z: z, yaw: Math.atan2(hx, hz), pitch: pitch || 0, roll: roll || 0, ab: ab || 0, v: v || 0}; }
function wing(p, id, back, side, up){
  var hx = Math.sin(p.yaw), hz = Math.cos(p.yaw);
  return pose(id, p.x - hx*back - hz*side, p.y + up, p.z - hz*back + hx*side, hx, hz, p.pitch, p.roll, p.ab, p.v);
}
function jetsAt(ms, P){
  P = P || {};
  var n = Math.floor(ms/CYCLE), u = (ms - n*CYCLE)/1000, seed = (P.seed | 0) + n*7919, kind = hash(seed) % 3;
  var th = u01(seed + 1)*PI*2, dx = Math.sin(th), dz = Math.cos(th), cx = (+P.cx || 0) + (u01(seed + 2) - 0.5)*500, cz = (+P.cz || 0) + (u01(seed + 3) - 0.5)*500;
  var out = [], lead;
  if(kind === 2 && P.carrier){
    var K = P.carrier, fx = Math.sin(K.yaw), fz = Math.cos(K.yaw), lx = Math.cos(K.yaw), lz = -Math.sin(K.yaw), dy = K.deck;
    function at(a, b){ return [K.x + lx*a + fx*b, K.z + lz*a + fz*b]; }
    // the launch: 6 s on the catapult, then 0 -> 75 m/s down the bow in 2.5 s, then climbing away
    if(u < 40){
      var s, v, y = dy, pitch = 0, ab = 0.4;
      if(u < 6){ s = 0; v = 0; ab = u > 4 ? 1 : 0.2; }
      else if(u < 8.5){ var tl = u - 6; s = 0.5*JET.launch*tl*tl; v = JET.launch*tl; ab = 1; }
      else {
        var tc = u - 8.5, T1 = 125/14, ta2 = Math.min(tc, T1);
        v = 75 + 14*ta2; s = 94 + 75*ta2 + 7*ta2*ta2 + 200*Math.max(0, tc - T1);
        y = dy + Math.min(420, tc*tc*1.6 + tc*4); pitch = Math.min(0.35, tc*0.12); ab = tc < 6 ? 1 : 0.5;
      }
      var q = at(4, 18 + s); out.push(pose("cat", q[0], y, q[1], fx, fz, pitch, 0, ab, v));
    }
    // the trap: down the glide slope onto the stern, caught in 2 s, parked till the sortie ends
    if(u > 22){
      var tt = 45 - u, sb, yb, vb;
      if(tt > 0){ sb = -JET.trap*tt; yb = dy + JET.glide*JET.trap*tt; vb = JET.trap; }
      else { var ta = Math.min(2, -tt); sb = JET.trap*ta - 17.5*ta*ta; yb = dy; vb = Math.max(0, JET.trap - 35*ta); }
      var r = at(-6, -85 + sb); out.push(pose("trap", r[0], yb, r[1], fx, fz, tt > 0 ? 0.08 : 0, 0, tt > 0 ? 0.3 : 0, vb));
    }
    return out;
  }
  if(kind === 1){
    // the racetrack: in along d, a banked half circle round the city, out the way it came
    var R = JET.R, L = JET.L, sr = JET.race*u, nx = dz, nz = -dx, ph, px, pz, hx, hz, roll = 0;
    if(sr > 2*L + PI*R) return out;
    if(sr < L){ px = cx - nx*R - dx*(L - sr); pz = cz - nz*R - dz*(L - sr); hx = dx; hz = dz; }
    else if(sr < L + PI*R){
      ph = (sr - L)/R; px = cx + (-nx*Math.cos(ph) + dx*Math.sin(ph))*R; pz = cz + (-nz*Math.cos(ph) + dz*Math.sin(ph))*R;
      hx = nx*Math.sin(ph) + dx*Math.cos(ph); hz = nz*Math.sin(ph) + dz*Math.cos(ph); roll = 1.0*Math.min(1, Math.min(sr - L, L + PI*R - sr)/120);
    } else { var s2 = sr - L - PI*R; px = cx + nx*R - dx*s2; pz = cz + nz*R - dz*s2; hx = -dx; hz = -dz; }
    // turning toward +n (to the right of d): right side down (roll positive)
    lead = pose("a", px, JET.raceAlt, pz, hx, hz, 0, roll, 0.35, JET.race);
    out.push(lead, wing(lead, "b", 26, 20, 4));
    return out;
  }
  // the flyover: straight across, low, afterburners lit
  var sf = JET.fly*u - 1.5*JET.L;
  if(sf > JET.L*1.5) return out;
  var alt = JET.alt - 40 + u01(seed + 4)*80;
  lead = pose("a", cx + dx*sf, alt, cz + dz*sf, dx, dz, 0, 0, 1, JET.fly);
  out.push(lead, wing(lead, "b", 30, -22, 3));
  return out;
}
function rectHit(R, x, z){
  var dx = x - R.x, dz = z - R.z, c = Math.cos(R.rot || 0), s = Math.sin(R.rot || 0);
  var lx = dx*c - dz*s, lz = dx*s + dz*c;                       // into the rectangle's frame (inverse of toWorld)
  return Math.abs(lx) <= R.hw && Math.abs(lz) <= R.hd;
}
// a point in a frame (centre x, z; turned rot): local (lx, lz) -> world, as hqcity3d's toWorld
function toW(F, lx, lz){ var c = Math.cos(F.rot), s = Math.sin(F.rot); return {x: F.x + lx*c + lz*s, z: F.z - lx*s + lz*c}; }

/* ---------- the meshes ---------- */
function kit(c, parent){
  var THREE = c.THREE, M = {};
  function m(col, o){ var k = col + JSON.stringify(o || {}); return M[k] || (M[k] = c.mat(col, o)); }
  function mesh(geo, mt, x, y, z, p){ var o = new THREE.Mesh(geo, mt); o.position.set(x || 0, y || 0, z || 0); o.castShadow = true; o.receiveShadow = true; (p || parent).add(o); return o; }
  return {THREE: THREE, m: m,
    n: function(col, e, ei){ var k = "n" + col + ":" + e + ":" + ei; if(!M[k]){ M[k] = c.mat(col, {roughness: 0.5}); M[k].emissive = new THREE.Color(e); M[k].emissiveIntensity = ei; } return M[k]; },
    mesh: mesh,
    box: function(w, h, d, mt, x, y, z, p){ return mesh(new THREE.BoxGeometry(w, h, d), mt, x, y, z, p); },
    cyl: function(rt, rb, h, mt, x, y, z, p, seg){ return mesh(new THREE.CylinderGeometry(rt, rb, h, seg || 14), mt, x, y, z, p); },
    // a flat polygon [[x, z]...] extruded up by h (its base at y)
    slab: function(pts, h, mt, y, p){
      var sh = new THREE.Shape(); pts.forEach(function(q, i){ if(i) sh.lineTo(q[0], -q[1]); else sh.moveTo(q[0], -q[1]); });
      var geo = new THREE.ExtrudeGeometry(sh, {depth: h, bevelEnabled: false}); geo.rotateX(-PI/2);
      return mesh(geo, mt, 0, y || 0, 0, p);
    }};
}
// A fighter jet, nose +z, its wheels' bottom at y 0 (about 16 m long, 10 m span). -> {g, ab: [flame meshes], glow}
function jetModel(c, col){
  var THREE = c.THREE, g = new THREE.Group(), K = kit(c, g);
  var body = K.m(col == null ? 0x6f7a84 : col, {roughness: 0.5, metalness: 0.45}), dark = K.m(0x2a3036, {roughness: 0.6, metalness: 0.5});
  var canopy = K.m(0x1d3550, {roughness: 0.1, metalness: 0.7}), Y = 1.9;
  K.cyl(0.85, 0.75, 9, body, 0, Y, -0.5).rotation.x = PI/2;
  K.cyl(0.02, 0.85, 4.5, body, 0, Y, 6.25).rotation.x = PI/2;
  var cp = K.mesh(new THREE.SphereGeometry(1, 14, 8, 0, PI*2, 0, PI/2), canopy, 0, Y + 0.55, 2.6); cp.scale.set(0.55, 0.6, 1.7);
  [1, -1].forEach(function(s){
    K.box(0.9, 1.1, 3.2, dark, s*1.05, Y - 0.2, 1.2);                                   // the intakes
    K.slab([[s*0.6, 2.2], [s*5.2, -3.2], [s*5.2, -4.2], [s*0.6, -4.4]], 0.18, body, Y - 0.15);          // the wing
    K.slab([[s*0.5, -4.6], [s*2.8, -6.6], [s*2.8, -7.1], [s*0.5, -7.0]], 0.12, body, Y);                  // the tailplane
    var tail = K.box(0.14, 2.6, 2.2, body, s*0.75, Y + 1.7, -5.9); tail.rotation.z = s*0.25; tail.rotation.x = 0.35;
    K.cyl(0.42, 0.48, 1.2, dark, s*0.48, Y, -5.6).rotation.x = PI/2;                   // the nozzles
    K.cyl(0.06, 0.06, Y - 0.3, K.m(0x9aa3ad, {metalness: 0.8}), s*1.3, (Y - 0.3)/2 + 0.3, -1.2, null, 6);
    K.cyl(0.3, 0.3, 0.22, dark, s*1.3, 0.3, -1.2).rotation.z = PI/2;
  });
  K.cyl(0.05, 0.05, Y - 0.3, K.m(0x9aa3ad, {metalness: 0.8}), 0, (Y - 0.3)/2 + 0.3, 4.2, null, 6);
  K.cyl(0.25, 0.25, 0.2, dark, 0, 0.25, 4.2).rotation.z = PI/2;
  var fm = new THREE.MeshBasicMaterial({color: 0xffa040, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false});
  var ab = [1, -1].map(function(s){
    var f = new THREE.Mesh(new THREE.ConeGeometry(0.38, 3.2, 12, 1, true), fm); f.rotation.x = -PI/2; f.position.set(s*0.48, Y, -7.8); g.add(f); return f;
  });
  var glow = c.glow ? c.glow(0xff9a40, 4, 0) : new THREE.Object3D(); glow.position.set(0, Y, -6.6); g.add(glow);
  return {g: g, ab: ab, fm: fm, glow: glow};
}
function merge(c, g){
  var Mg = HQV.hqMerge; if(!Mg || typeof Mg.mergeStatic !== "function") return;
  try { Mg.mergeStatic(c.THREE, g, {keep: function(o){ return !!(o.userData && o.userData.anim); }}); } catch(e){}
}
// a helipad: a dark disc, a white ring and H, a green edge that lights at night
function padModel(c, r, p, x, y, z, rot, glows){
  var THREE = c.THREE, K = kit(c, p), g = new THREE.Group(); g.position.set(x, y, z); g.rotation.y = rot || 0; p.add(g);
  var white = K.m(0xf2f2f2, {roughness: 0.7});
  K.cyl(r, r, 0.12, K.m(0x2f363d, {roughness: 0.9}), 0, 0.06, 0, g, 28);
  var ring = new THREE.Mesh(new THREE.RingGeometry(r*0.78, r*0.86, 32), white); ring.rotation.x = -PI/2; ring.position.y = 0.13; g.add(ring);
  K.box(0.5, 0.03, r*0.9, white, -r*0.25, 0.13, 0, g); K.box(0.5, 0.03, r*0.9, white, r*0.25, 0.13, 0, g); K.box(r*0.5, 0.03, 0.5, white, 0, 0.13, 0, g);
  for(var i = 0; i < 8; i++){
    var a = i/8*PI*2, l = K.box(0.25, 0.15, 0.25, K.n(0x103020, 0x46e07a, 1.6), Math.sin(a)*r*0.97, 0.15, Math.cos(a)*r*0.97, g);
    if(glows && c.glow && i % 2 === 0){ var gl = c.glow(0x46e07a, 1.4, 0.8); gl.position.set(x + Math.sin(a + (rot || 0))*r, y + 0.4, z + Math.cos(a + (rot || 0))*r); glows.push(gl); p.add(gl); }
  }
  return g;
}

/* ---------- a City's air side ---------- */
function create(c, S, o){
  var THREE = c.THREE, WD = HQV.world, H = HQV.hqheli, E = HQV.engine || {};
  var W = o.W, sea = o.sea, root = new THREE.Group(); root.name = "air"; S.add(root);
  var blockR = [], floorR = [], groundR = [], pads = [], props = [], glows = [], nightM = [], anims = [];
  var radar = null, carrier = null, homeDone = false, night = o.night != null ? !!o.night : true, dead = false;
  var A = {base: null, carrier: null, home: null, pads: pads, seed: 0};
  var jets = [], roar = null, boomAt = {}, seed = WD && WD.hash32 ? WD.hash32(String(W.id || "")) : 7; A.seed = seed;
  function gy(x, z){ return o.groundY ? o.groundY(x, z) : WD.groundAt(W, x, z); }
  function land(x, z){ return !sea || sea.land(x, z); }
  // is the turned rectangle F (x, z, rot, hw, hd) clear for something built: on land, off the roads, sites and lots
  // (sites: allowed ones), nothing blocking, flat to within tol m. -> its highest ground, else null
  function clear(F, ok, tol, quick){
    var lo = Infinity, hi = -Infinity, st = quick ? Math.max(F.hw, F.hd) : 5;
    for(var a = -F.hw; a <= F.hw + 0.01; a += Math.min(st, F.hw || 1)){
      for(var b = -F.hd; b <= F.hd + 0.01; b += Math.min(st, F.hd || 1)){
        var p = toW(F, a, b);
        if(!land(p.x, p.z)) return null;
        var s = WD.surfaceAt(W, p.x, p.z);
        if(!ok(s, p.x, p.z) || (o.blocked && o.blocked(p.x, p.z))) return null;
        var h = gy(p.x, p.z); if(h < lo) lo = h; if(h > hi) hi = h;
        if(hi - lo > tol) return null;
      }
    }
    return hi;
  }
  // the nearest clear spot to (cx, cz), rings rmin..rmax m out; -> {x, z, rot, hw, hd, y} or null
  function findSpot(cx, cz, hw, hd, rot, rmin, rmax, ok, tol){
    for(var r = rmin; r <= rmax; r += 12){
      var n = Math.max(1, Math.round(PI*2*r/14));
      for(var i = 0; i < n; i++){
        var a = i/n*PI*2, F = {x: cx + Math.sin(a)*r, z: cz + Math.cos(a)*r, rot: rot, hw: hw, hd: hd};
        if(clear(F, ok, tol, true) == null) continue;
        var y = clear(F, ok, tol, false);
        if(y != null){ F.y = y; return F; }
      }
    }
    return null;
  }
  function grass(s){ return s === "grass" || s === "park"; }
  function quiet(B){ Object.keys(B.lights).forEach(function(k){ B.lights[k].visible = false; }); }
  function heliProp(kind, x, y, z, yaw, col, acc, id){
    var B = H.model(c, kind, col, acc), g = B.g; g.position.set(x, y, z); g.rotation.y = yaw; root.add(g);
    quiet(B);
    merge(c, g);
    var p = {g: g, x: x, y: y, z: z, yaw: yaw, kind: kind, color: col, accent: acc, id: id, stay: true};
    props.push(p); return p;
  }
  function addPad(x, y, z, r, rot, site, at){
    padModel(c, r, root, x, y, z, rot, glows);
    var P = {x: x, y: y + 0.12, z: z, r: r, site: site || null, at: at || null}; pads.push(P);
    if(!site) groundR.push({x: x, z: z, hw: r, hd: r, rot: 0, y: y + 0.12, circle: r});
    return P;
  }

  /* the Commons: the air base by the airport, and the carrier offshore */
  var airport = null;
  (W.sites || []).forEach(function(s){ if(s.kind === "airport" && !airport) airport = s; });
  if(o.commons && airport) buildBase();
  if(o.commons && sea) buildCarrier();
  // a pad on the roof of every hospital and clinic; an air ambulance on the hospitals' (or the first clinic's)
  var amb = 0;
  (o.civics || []).filter(function(B){ return B.kind === "hospital"; }).concat((o.civics || []).filter(function(B){ return B.kind === "clinic"; }))
    .forEach(function(B){
      var b = (B.boxes || [])[0]; if(!b || !b.o) return;
      var r = Math.min(4.5, b.o.hw - 0.6, b.o.hd - 0.6); if(r < 3.2) return;
      var site = null; (W.sites || []).forEach(function(s){ if(Math.abs(s.x/100 - B.x) < 0.5 && Math.abs(s.z/100 - B.z) < 0.5) site = s; });
      addPad(b.o.x, b.max.y + 0.02, b.o.z, r, b.o.rot, site || {x: B.x*100, z: B.z*100, front: null}, {kind: B.kind});
      if(B.kind === "hospital" || amb === 0){ amb++; heliProp("heli", b.o.x, b.max.y + 0.14, b.o.z, b.o.rot, 0xf4f4f4, 0xd0262b, "heli:" + B.kind + ":" + Math.round(B.x) + ":" + Math.round(B.z)); }
    });

  function buildBase(){
    var f = airport.front || [65536, 0], fl = Math.hypot(f[0], f[1]) || 1, rot = Math.atan2(f[0]/fl, f[1]/fl) + PI/2;
    var ax = airport.x/100, az = airport.z/100;
    var F = findSpot(ax, az, 56, 40, rot, 60, 520, grass, 2.5) || findSpot(ax, az, 56, 40, rot + PI/2, 60, 520, grass, 3);
    if(!F) return;
    var g = new THREE.Group(); g.position.set(F.x, F.y, F.z); g.rotation.y = F.rot; root.add(g);
    var K = kit(c, g), concrete = K.m(0x80878e, {roughness: 0.95}), yellow = K.m(0xe3b23c, {roughness: 0.8}), white = K.m(0xeeeeee, {roughness: 0.8});
    var olive = K.m(0x56604a, {roughness: 0.75}), steel = K.m(0x8e979f, {roughness: 0.45, metalness: 0.6}), darkS = K.m(0x30363c, {roughness: 0.6, metalness: 0.4});
    K.box(112, 2.2, 80, concrete, 0, -1.05, 0);
    groundR.push({x: F.x, z: F.z, hw: 56, hd: 40, rot: F.rot, y: F.y + 0.05});
    // the taxi lines
    K.box(100, 0.02, 0.5, yellow, 0, 0.07, 6); K.box(0.5, 0.02, 30, yellow, 46, 0.07, 20);
    for(var i = 0; i < 4; i++) K.box(0.5, 0.02, 12, yellow, -42 + i*14, 0.07, 12);
    // the hangars: walls, a barrel roof, doors part open, lit inside at night
    var inside = K.n(0x2a2a20, 0xffe2a8, 0.0);
    nightM.push([inside, 1.4, 0]);
    [-36, -8, 20].forEach(function(hx){
      var hz = -26;
      K.box(26, 5, 22, olive, hx, 2.5, hz);
      var roof = K.mesh(new THREE.CylinderGeometry(13, 13, 22, 20, 1, false, -PI/2, PI), olive, hx, 5, hz); roof.rotation.x = -PI/2; roof.scale.set(1, 1, 0.45);
      K.box(9, 7.5, 0.3, darkS, hx - 5.5, 3.75, hz + 11.05); K.box(9, 7.5, 0.3, darkS, hx + 5.5, 3.75, hz + 11.2);
      K.box(4, 7, 0.2, inside, hx, 3.5, hz + 10.9);
      K.box(26.4, 0.6, 0.3, yellow, hx, 0.3, hz + 11.3);
      var p = toW(F, hx, hz); blockR.push({x: p.x, z: p.z, hw: 13.2, hd: 11.2, rot: F.rot}); floorR.push({x: p.x, z: p.z, hw: 13, hd: 11, rot: F.rot, y: F.y + 10.8});
    });
    // the control tower
    var tx = 47, tz = -28;
    K.cyl(2.2, 2.8, 18, K.m(0xd8dde2, {roughness: 0.6}), tx, 9, tz);
    var cab = K.n(0x1c3a52, 0x9ad8ff, 0.2); nightM.push([cab, 1.1, 0.2]);
    K.cyl(4.2, 3.4, 3.4, cab, tx, 19.7, tz, null, 12); K.cyl(4.6, 4.6, 0.5, darkS, tx, 21.6, tz, null, 12);
    K.cyl(0.1, 0.1, 4, steel, tx, 23.8, tz, null, 6); K.box(0.4, 0.4, 0.4, K.n(0x400000, 0xff3030, 2.5), tx, 25.9, tz);
    var tp = toW(F, tx, tz); blockR.push({x: tp.x, z: tp.z, hw: 3, hd: 3, rot: F.rot}); floorR.push({x: tp.x, z: tp.z, hw: 4.6, hd: 4.6, rot: F.rot, y: F.y + 21.9});
    // the radar: a dish on a mast, turning
    var rx = 47, rz = 30;
    K.cyl(0.5, 0.8, 7, steel, rx, 3.5, rz);
    radar = new THREE.Group(); radar.position.set(rx, 7.4, rz); radar.userData.anim = true; g.add(radar);
    var dish = K.mesh(new THREE.SphereGeometry(4.2, 18, 8, 0, PI*2, 0, PI*0.32), K.m(0xeceff2, {roughness: 0.4, metalness: 0.3, side: THREE.DoubleSide}), 0, 1.8, -1.2, radar);
    dish.rotation.x = -PI/2 + 0.35;
    K.cyl(0.08, 0.08, 3.4, steel, 0, 1.9, 0.6, radar, 6).rotation.x = PI/2 - 0.35;
    K.box(1.4, 1.2, 1.4, darkS, 0, 0.2, 0, radar);
    var rp = toW(F, rx, rz); blockR.push({x: rp.x, z: rp.z, hw: 1, hd: 1, rot: 0});
    // the fence: posts and rails round the edge, a gate in the middle of the front
    var fm = K.m(0x5d666e, {roughness: 0.6, metalness: 0.5});
    [[-1, 0], [1, 0], [0, -1], [0, 1]].forEach(function(e){
      var len = e[0] ? 80 : 112, along = e[0] ? "z" : "x", ex = e[0]*56, ez = e[1]*40;
      for(var s = -len/2; s <= len/2 + 0.01; s += 4){
        if(e[1] === 1 && Math.abs(s) < 8) continue;
        K.box(0.15, 2.6, 0.15, fm, along === "x" ? s : ex, 1.3, along === "x" ? ez : s);
      }
      [0.9, 2.4].forEach(function(h){
        if(e[1] === 1){ [-1, 1].forEach(function(sg){ K.box(48, 0.08, 0.08, fm, sg*32, h, ez); }); }
        else K.box(along === "x" ? len : 0.08, 0.08, along === "x" ? 0.08 : len, fm, ex, h, along === "x" ? ez : 0);
      });
      var mid = toW(F, ex, ez);
      if(e[1] === 1){ [-1, 1].forEach(function(sg){ var q = toW(F, sg*32, ez); blockR.push({x: q.x, z: q.z, hw: 24, hd: 0.3, rot: F.rot}); }); }
      else blockR.push({x: mid.x, z: mid.z, hw: e[0] ? 0.3 : 56, hd: e[0] ? 40 : 0.3, rot: F.rot});
    });
    // the gate's barrier and a sign
    K.box(0.4, 1.2, 0.4, K.m(0xd23b3b), -8, 0.6, 40); var bar = K.box(15, 0.15, 0.15, K.m(0xf2f2f2), -0.5, 1.15, 40); bar.rotation.z = 0.05;
    if(c.label){ var lb = c.label("Air Base", 0x7fae5a, 1.6); lb.position.set(0, 14, 40); g.add(lb); }
    // floodlights at the corners, a windsock
    [[-54, -38], [54, -38], [-54, 38], [54, 38]].forEach(function(q){
      K.cyl(0.2, 0.3, 12, steel, q[0], 6, q[1], null, 8); K.box(1.6, 0.6, 0.6, K.n(0x333333, 0xfff1c8, 1.5), q[0], 12.2, q[1]);
      if(c.glow){ var gl = c.glow(0xfff1c8, 6, 0.7); var w = toW(F, q[0], q[1]); gl.position.set(w.x, F.y + 12.2, w.z); root.add(gl); glows.push(gl); }
    });
    K.cyl(0.08, 0.08, 6, steel, 30, 3, 34, null, 6);
    var sock = K.cyl(0.25, 0.6, 2.4, K.m(0xff7a1a, {roughness: 0.7}), 30, 5.7, 35.2, null, 10); sock.rotation.x = PI/2 - 0.2;
    // the jets on the line, in front of the hangars
    [-44, -28, -12, 4].forEach(function(jx, i){ var J = jetModel(c, i % 2 ? 0x707b84 : 0x66717a); J.g.position.set(jx, 0, 14); g.add(J.g); J.ab.forEach(function(f){ J.g.remove(f); }); J.g.remove(J.glow);
      var q = toW(F, jx, 14); blockR.push({x: q.x, z: q.z, hw: 5, hd: 8, rot: F.rot}); });
    // the attack helicopters: one on its pad for show, one you can fly
    var p1 = toW(F, 18, 26), p2 = toW(F, 34, 26);
    var B = H.model(c, "attack"); quiet(B); B.g.position.set(18, 0.12, 26); g.add(B.g);
    padModel(c, 7, g, 18, 0, 26, 0, null); padModel(c, 7, g, 34, 0, 26, 0, null);
    pads.push({x: p1.x, y: F.y + 0.17, z: p1.z, r: 7}, {x: p2.x, y: F.y + 0.17, z: p2.z, r: 7});
    blockR.push({x: p1.x, z: p1.z, hw: 1.6, hd: 6, rot: F.rot});
    // a civilian pair on the apron's far end (the airport's helipads)
    var c1 = toW(F, -40, 32), c2 = toW(F, -24, 32);
    padModel(c, 6, g, -40, 0, 32, 0, null); padModel(c, 6, g, -24, 0, 32, 0, null);
    pads.push({x: c1.x, y: F.y + 0.17, z: c1.z, r: 6}, {x: c2.x, y: F.y + 0.17, z: c2.z, r: 6});
    merge(c, g);
    heliProp("attack", p2.x, F.y + 0.17, p2.z, F.rot, null, null, "heli:base:attack");
    heliProp("heli", c1.x, F.y + 0.17, c1.z, F.rot, 0x1f4e8c, 0xf2f2f2, "heli:airport:1");
    heliProp("heli", c2.x, F.y + 0.17, c2.z, F.rot, 0x222831, 0xe8b730, "heli:airport:2");
    A.base = {x: F.x, y: F.y, z: F.z, rot: F.rot};
  }

  function buildCarrier(){
    var bear = airport ? Math.atan2(airport.x, airport.z) : PI*1.5, best = null;
    for(var i = 0; i < 72 && !best; i++){
      var a = bear + (i % 2 ? 1 : -1)*Math.ceil(i/2)*PI/36, sx = Math.sin(a), sz = Math.cos(a), rc = null;
      for(var r = 200; r < 1500; r += 10){
        var ok = true; for(var q = 0; q <= 80; q += 20) if(sea.land(sx*(r + q), sz*(r + q))){ ok = false; break; }
        if(ok){ rc = r; break; }
      }
      if(rc == null) continue;
      var Kp = {x: sx*(rc + 230), z: sz*(rc + 230), rot: a + PI/2, hw: 24, hd: 140}, wet = true;
      for(var u = -1; u <= 1 && wet; u += 0.5) for(var v = -1; v <= 1; v += 0.25){ var p = toW(Kp, u*Kp.hw, v*Kp.hd); if(sea.land(p.x, p.z)){ wet = false; break; } }
      if(wet) best = Kp;
    }
    if(!best) return;
    var Y = sea.y || 0, deck = 18, g = new THREE.Group(); g.position.set(best.x, Y, best.z); g.rotation.y = best.rot; root.add(g);
    var K = kit(c, g), grey = K.m(0x6c757d, {roughness: 0.7, metalness: 0.2}), deckM = K.m(0x3b4046, {roughness: 0.95}), hullM = K.m(0x5d666e, {roughness: 0.75, metalness: 0.2});
    var white = K.m(0xf2f2f2, {roughness: 0.8}), yellow = K.m(0xe3b23c, {roughness: 0.8}), red = K.m(0x8a2a22, {roughness: 0.8});
    // the hull: tapered to a bow, a red boot topping at the waterline
    var hull = [[-15, -118], [15, -118], [16, 40], [12, 95], [3, 122], [-3, 122], [-12, 95], [-16, 40]];
    K.slab(hull, deck - 1, hullM, -4);
    K.slab(hull.map(function(p){ return [p[0]*1.01, p[1]*1.002]; }), 1.2, red, -0.6);
    // the flight deck, wider than the hull, the angled deck out over the port (+x) side
    var dk = [[-17, -126], [22, -126], [26, -40], [21, 20], [18, 60], [14, 110], [4, 128], [-4, 128], [-14, 110], [-19, 60], [-19, -60]];
    K.slab(dk, 1.2, deckM, deck - 1.2);
    // the markings: the angled deck's centre line and edges, the bow catapults, the island's foul line
    var ang = 0.16, mk = new THREE.Group(); mk.position.set(6, deck + 0.04, -60); mk.rotation.y = ang; g.add(mk);
    for(var z = -60; z < 150; z += 14) K.box(0.6, 0.02, 7, white, 0, 0, z, mk);
    [-11, 11].forEach(function(x){ K.box(0.35, 0.02, 200, white, x, 0, 45, mk); });
    [4, -6].forEach(function(x){ K.box(0.4, 0.02, 100, yellow, x, deck + 0.04, 70); });
    K.box(0.4, 0.02, 230, yellow, -12, deck + 0.04, 0);
    // the island: the bridge, the funnel, the mast and its radars
    var ix = -15, iz = 18;
    K.box(8, 12, 30, grey, ix, deck + 6, iz); K.box(7, 5, 18, grey, ix, deck + 14.5, iz + 3);
    var bw = K.n(0x14212c, 0x9ad8ff, 0.2); nightM.push([bw, 1.0, 0.15]);
    K.box(7.2, 1.2, 18.2, bw, ix, deck + 15.5, iz + 3);
    K.box(5, 6, 6, grey, ix, deck + 15, iz - 9);
    K.cyl(0.3, 0.4, 12, K.m(0x9aa3ad, {metalness: 0.7}), ix, deck + 23, iz + 5, null, 8);
    var crad = new THREE.Group(); crad.position.set(ix, deck + 28, iz + 5); crad.userData.anim = true; g.add(crad);
    K.box(5, 0.8, 0.3, K.m(0xd8dde2), 0, 0, 0, crad); anims.push(function(dt, k){ crad.rotation.y += dt*2.2*k; });
    K.box(0.4, 0.4, 0.4, K.n(0x400000, 0xff3030, 2.5), ix, deck + 29.5, iz + 5);
    K.box(1.4, 3, 1.6, white, ix + 4.2, deck + 6, iz - 6);          // the hull number's plate
    // the jets parked along the starboard edge, a helicopter aft of the island
    [[-12, -40], [-12, -24], [-12, 52], [-12, 68], [-12, 84]].forEach(function(q){ var J = jetModel(c, 0x7a848d); J.g.position.set(q[0], deck, q[1]); J.g.rotation.y = -PI/2 + 0.6; g.add(J.g); J.ab.forEach(function(f){ J.g.remove(f); }); J.g.remove(J.glow); });
    var hb = H.model(c, "heli", 0x6c757d, 0x3b4046); quiet(hb); hb.g.position.set(-10, deck, -70); hb.g.rotation.y = PI/2; g.add(hb.g);
    // deck-edge lights
    if(c.glow) for(var e = -120; e <= 120; e += 30) [-1, 1].forEach(function(s){ var gl = c.glow(s > 0 ? 0x46e07a : 0xffd27a, 1.6, 0.8); var w = toW(best, s*18, e); gl.position.set(w.x, Y + deck + 0.4, w.z); root.add(gl); glows.push(gl); });
    merge(c, g);
    carrier = {x: best.x, z: best.z, yaw: best.rot, deck: Y + deck};
    // what a helicopter can land on: the deck (two boxes: the bow and the angled deck); the island stands up from it
    floorR.push({x: best.x, z: best.z, hw: 16, hd: 120, rot: best.rot, y: Y + deck});
    var ad = toW(best, 8, -40); floorR.push({x: ad.x, z: ad.z, hw: 13, hd: 75, rot: best.rot, y: Y + deck});
    var il = toW(best, ix, iz); floorR.push({x: il.x, z: il.z, hw: 4.5, hd: 16, rot: best.rot, y: Y + deck + 17});
    A.carrier = carrier;
  }

  /* the jets in the sky: a pool of four */
  for(var j = 0; j < 4; j++){ var J = jetModel(c, 0x6f7a84); merge(c, J.g); J.g.visible = false; root.add(J.g); jets.push(J); }

  A.props = function(mine){
    if(mine && !homeDone){
      homeDone = true;
      var L = mine.lot || {}, lx = L.x != null ? L.x/100 : mine.x, lz = L.z != null ? L.z/100 : mine.z;
      var F = findSpot(lx, lz, 8, 8, mine.rot || 0, 22, 140, grass, 1.2);
      if(F){ addPad(F.x, F.y, F.z, 7, F.rot, null, {kind: "home"}); heliProp("heli", F.x, F.y + 0.12, F.z, F.rot + PI, 0xc8323c, 0xf2f2f2, "heli:home"); A.home = F; }
    }
    return props;
  };
  A.blocked = function(x, z){ for(var i = 0; i < blockR.length; i++) if(rectHit(blockR[i], x, z)) return true; return false; };
  A.groundAt = function(x, z){
    for(var i = 0; i < groundR.length; i++){ var R = groundR[i];
      if(R.circle ? Math.hypot(x - R.x, z - R.z) <= R.circle : rectHit(R, x, z)) return R.y; }
    return null;
  };
  A.floor = function(x, z){
    var y = A.groundAt(x, z);
    for(var i = 0; i < floorR.length; i++) if(rectHit(floorR[i], x, z) && (y == null || floorR[i].y > y)) y = floorR[i].y;
    return y;
  };
  // stepping out: on the ground beside it; on a roof pad, at its building's door (the stairs); never at sea
  A.landSpot = function(st){
    if(!st || !st.ground) return null;
    for(var i = 0; i < pads.length; i++){ var P = pads[i];
      if(P.site && Math.hypot(st.x - P.x, st.z - P.z) < P.r + 2){
        var s = P.site, f = s.front || [0, 65536], fl = Math.hypot(f[0], f[1]) || 1, r = (s.d || 1200)/200 + 1.5;
        return {x: s.x/100 + f[0]/fl*r, z: s.z/100 + f[1]/fl*r, yaw: Math.atan2(f[0], f[1])};
      }
    }
    if(!land(st.x, st.z)) return null;
    if(st.y - gy(st.x, st.z) > 1.5 && A.groundAt(st.x, st.z) == null) return null;     // a roof with no stairs down
    var cy = Math.cos(st.yaw), sy = Math.sin(st.yaw);
    var offs = [[3, 0.5], [-3, 0.5], [3.4, -1.5], [-3.4, -1.5], [0, 7], [0, -8]];
    for(var k = 0; k < offs.length; k++){
      var x = st.x + offs[k][0]*cy + offs[k][1]*sy, z = st.z - offs[k][0]*sy + offs[k][1]*cy;
      if(land(x, z) && !(o.blocked && o.blocked(x, z))) return {x: x, z: z, yaw: st.yaw};
    }
    return null;
  };
  function poseJet(J, p){
    J.g.visible = true; J.g.position.set(p.x, p.y, p.z);
    J.g.rotation.set(0, 0, 0); J.g.rotation.order = "YXZ"; J.g.rotation.set(-p.pitch, p.yaw, p.roll);
    var a = clamp(p.ab, 0, 1);
    J.fm.opacity = 0.15 + 0.75*a; J.ab.forEach(function(f){ f.scale.set(1, 0.5 + a*1.3, 1); });
    if(J.glow.material) J.glow.material.opacity = 0.25 + 0.6*a;
  }
  A.update = function(t, dt, k, cam){
    if(dead) return;
    k = k == null ? 1 : k;
    if(radar) radar.rotation.y += dt*1.1*k;
    anims.forEach(function(f){ f(dt, k); });
    var now = Date.now(), P = jetsAt(now, {cx: 0, cz: 0, seed: A.seed, carrier: carrier}), near = Infinity;
    for(var i = 0; i < jets.length; i++){
      var p = P[i];
      if(!p){ jets[i].g.visible = false; continue; }
      poseJet(jets[i], p);
      if(cam && cam.x != null){
        var d = Math.hypot(p.x - cam.x, p.y - (+cam.y || 0), p.z - cam.z);
        if(p.v > 20) near = Math.min(near, d);
        // the boom: once per jet per sortie, when it passes within 260 m of you
        var key = p.id + ":" + Math.floor(now/CYCLE);
        if(d < 260 && p.v > 150 && !boomAt[key]){ boomAt[key] = 1; if(E.sfx){ E.sfx("door"); E.sfx("shot"); } }
      }
    }
    if(Object.keys(boomAt).length > 20) boomAt = {};
    // the roar: one noise band for all of them, louder the nearer the nearest
    if(near < 1500 && E.noiseLoop){
      if(!roar) roar = E.noiseLoop(320, 0.8);
      roar.set(clamp(0.5/(1 + Math.pow(near/180, 2)), 0, 0.5), 220 + 900/(1 + near/200));
    }
  };
  A.setNight = function(n){
    night = !!n;
    glows.forEach(function(gl){ gl.visible = night; });
    nightM.forEach(function(q){ q[0].emissiveIntensity = night ? q[1] : q[2]; });
  };
  A.destroy = function(){
    dead = true; S.remove(root);
    if(roar){ try { roar.stop(); } catch(e){} roar = null; }
  };
  A.setNight(night);
  HQV.hqair.last = A;                 // for tools (tools/ui_smoke.py sessions): the City's air side
  return A;
}

HQV.hqair = {CYCLE: CYCLE, JET: JET, jetsAt: jetsAt, rectHit: rectHit, hash: hash, create: create, jetModel: jetModel};
})();
