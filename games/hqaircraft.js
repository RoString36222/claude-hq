/* Claude HQ: the aircraft and the airport's dressing (HQV.hqAircraft). Needs THREE (through the hq3d ctx).
 *
 *   airliner(c, opts) -> P   a twin-engine airliner, 38 m, the livery in the brand colour (opts.brand, hex)
 *   seaplane(c, opts) -> P   a high-wing twin on floats, 16 m
 *   amphibian(c, opts) -> P  the seaplane with wheels in its floats ("Isle Hopper" orange unless opts.brand)
 *     P.g        the group: origin on the ground (the water) under the wing, forward +z, model +x is LEFT
 *     P.place(pose, x, y, z)   put it at a games/hqair.js pose (pose.x/z replaced by the local x, z given)
 *     P.update(dt, t, night, gear (0..1), speed, phase?, o?)   the window glow, the lights, the gear, the props.
 *       phase (a games/hqair.js phase, or {phase, surface}) drives the lights: the red beacon from pushback to
 *       parked, the nose taxi light in taxi|hold|lineup|exit|pushback, the wing landing lights in lineup, takeoff,
 *       climb (< 300 m over the runway), approach, flare and rollout, the nav lights in every phase but parked,
 *       the white strobes (double flash, 1 Hz) from lineup to rollout. Without a phase the lights blink as before.
 *       o.surface "land" | "water": the amphibian shows its wheels when gear > 0.5 on land.
 *     P.setLivery(brandHex, tailHex?)   this plane's own brand material (and fin colour), disposed with it
 *     P.seat     [x, y, z] a window seat, model frame
 *     P.clone(), P.dispose()
 *   Parts are merged by material (body, brand, wing, dark, windows, gear) plus one Points for the lights
 *   (nav red / green, strobes, beacons, taxi and landing lights; a few pixels at any distance): about seven
 *   draw calls a plane. Aircraft materials are unfogged, so a plane 3 km off still reads against the haze.
 *   parked(c, kind, n) -> F  a parked fleet ("jet" or "commuter"), one InstancedMesh per material (<= 7 draw
 *     calls whatever n): F.set(i, {x, y, z, yaw}, brandHex), F.count(k), F.setNight(n), F.dispose(), F.g
 *   DOOR_L1 [x, y, z] the airliner's forward left door sill (model frame), NOSE its nose (z), SPAN its span
 *   AIRLINES the invented airlines {id: {name, color}} (archipelago: the brand colour), AIRLINE_IDS
 *   contrails(c) -> {add() -> mesh, set(mesh, [x, y, z] from, [x, y, z] to), dispose()}  white ribbons
 *   airport(c, end, o) -> A  the runway (from games/hqair.js airportEnd, local frame) on its deck and piles,
 *     edge, threshold and approach lights (InstancedMesh fixtures, Points glow at night), the sequenced
 *     flasher, the stand's lead-in line and stop bar, and the control tower's beacon.
 *     o: {ground(x, z) -> terrain y, site, tier}. A.g, A.setNight(n), A.update(t), A.dispose()
 */
(function(){
"use strict";
var HQV = window.HQV = window.HQV || {};
var PI = Math.PI;

function brandHex(){
  try {
    var v = getComputedStyle(document.documentElement).getPropertyValue("--brand").trim();
    if(/^#[0-9a-f]{6}$/i.test(v)) return parseInt(v.slice(1), 16);
    if(/^#[0-9a-f]{3}$/i.test(v)) return parseInt(v.slice(1).split("").map(function(ch){ return ch + ch; }).join(""), 16);
  } catch(e){}
  return 0xe2805e;
}
// the invented airlines (no real brands); archipelago flies the HQ's own brand colour
var AIRLINES = {
  archipelago: {name: "Archipelago Air", color: null},
  tokenline: {name: "Tokenline", color: 0x1f9e9a},
  context: {name: "Context Airways", color: 0x23408e},
  gradient: {name: "Gradient Air", color: 0x7a4cc2},
  islehopper: {name: "Isle Hopper", color: 0xe07a2e}
};
var AIRLINE_IDS = ["archipelago", "tokenline", "context", "gradient", "islehopper"];
function airlineColor(id){ var a = AIRLINES[id]; return a ? (a.color != null ? a.color : brandHex()) : brandHex(); }
var ISLE = 0xe07a2e;

function Parts(THREE){
  var by = {}, m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), s = new THREE.Vector3(), p = new THREE.Vector3();
  function add(key, geo, x, y, z, rx, ry, rz, sx, sy, sz){
    e.set(rx || 0, ry || 0, rz || 0); q.setFromEuler(e); p.set(x || 0, y || 0, z || 0); s.set(sx || 1, sy || 1, sz || 1);
    (by[key] = by[key] || []).push([geo, m4.clone().compose(p, q, s)]);
  }
  return {
    by: by, add: add,
    box: function(key, w, h, d, x, y, z, rx, ry, rz){ add(key, new THREE.BoxGeometry(w, h, d), x, y, z, rx, ry, rz); },
    // a cylinder along z (rx = PI/2 lays it down)
    tube: function(key, r0, r1, len, x, y, z, seg){ add(key, new THREE.CylinderGeometry(r0, r1, len, seg || 14), x, y, z, PI/2); },
    ball: function(key, r, x, y, z, sx, sy, sz){ add(key, new THREE.SphereGeometry(r, 14, 10), x, y, z, 0, 0, 0, sx, sy, sz); },
    geo: function(key, g){ add(key, g); },
    // a slab between four corners (top face), `th` thick downward: wings, fins, stabilisers
    slab: function(key, C, th, side){
      var a = [], i, n = C.length, top = C.map(function(v){ return v; }), bot = C.map(function(v){ return side ? [v[0] - th, v[1], v[2]] : [v[0], v[1] - th, v[2]]; });
      function tri(p0, p1, p2){ a.push(p0[0], p0[1], p0[2], p1[0], p1[1], p1[2], p2[0], p2[1], p2[2]); }
      tri(top[0], top[1], top[2]); tri(top[0], top[2], top[3]);
      tri(bot[0], bot[2], bot[1]); tri(bot[0], bot[3], bot[2]);
      for(i = 0; i < n; i++){ var j = (i + 1) % n; tri(top[i], bot[i], bot[j]); tri(top[i], bot[j], top[j]); }
      var g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(a, 3)); g.computeVertexNormals();
      add(key, g);
    }
  };
}
function merged(THREE, P, M, name, g){
  var geos = [];
  Object.keys(P.by).forEach(function(k){
    var geo = HQV.hqShips.merge(THREE, P.by[k]), m = new THREE.Mesh(geo, M[k]);
    m.name = name + "-" + k; m.castShadow = k !== "win"; g.add(m); geos.push(geo);
  });
  return geos;
}
// the lights: one Points cloud, colours rewritten for the blink
function lightsOf(THREE, L){
  var pos = [], col = new Float32Array(L.length*3);
  L.forEach(function(l){ pos.push(l.p[0], l.p[1], l.p[2]); });
  var g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  var m = new THREE.PointsMaterial({size: 4, sizeAttenuation: false, vertexColors: true, transparent: true, depthWrite: false, fog: false, toneMapped: false});
  var o = new THREE.Points(g, m); o.frustumCulled = false; o.name = "air-lights";
  return {o: o, g: g, m: m, L: L, col: col};
}
var NAV_COL = {red: [1, 0.12, 0.1], green: [0.15, 1, 0.3], white: [1, 1, 1], strobe: [1, 1, 1], beacon: [1, 0.1, 0.05],
               taxi: [1, 1, 0.9], landing: [1, 1, 0.92]};
var PH_TAXI = {taxi: 1, hold: 1, lineup: 1, exit: 1, pushback: 1};
var PH_LAND = {lineup: 1, takeoff: 1, climb: 1, approach: 1, flare: 1, rollout: 1};
var PH_STROBE = {lineup: 1, takeoff: 1, climb: 1, cruise: 1, descent: 1, approach: 1, flare: 1, rollout: 1};
var PH_GROUND = {pushback: 1, taxi: 1, hold: 1, lineup: 1, exit: 1, parked: 1, takeoff: 1};
// is light kind k on? (phase null: the old always-on blink, no taxi or landing lights)
function lightOn(k, phase, strobe, beacon, low){
  if(phase == null) return k === "strobe" ? strobe : k === "beacon" ? beacon : !(k === "taxi" || k === "landing");
  if(k === "beacon") return phase !== "parked" && beacon;
  if(k === "taxi") return !!PH_TAXI[phase];
  if(k === "landing") return !!PH_LAND[phase] && (phase !== "climb" || low);
  if(k === "strobe") return !!PH_STROBE[phase] && strobe;
  return phase !== "parked";
}
function blink(Lt, t, night, phase, low){
  var per = phase == null ? 1.3 : 1.0, tt = ((t % per) + per) % per;
  var col = Lt.col, strobe = tt < 0.07 || (tt > 0.16 && tt < 0.22), beacon = (((t % 1.1) + 1.1) % 1.1) < 0.16, dim = night ? 1 : 0.75;
  Lt.L.forEach(function(l, i){
    var c = NAV_COL[l.k], k = lightOn(l.k, phase, strobe, beacon, low) ? dim : 0;
    col[3*i] = c[0]*k; col[3*i + 1] = c[1]*k; col[3*i + 2] = c[2]*k;
  });
  Lt.g.attributes.color.needsUpdate = true;
  Lt.m.size = night ? 5 : 3;
}
function mats(c, brand, extra){
  var THREE = c.THREE, M = {
    body: c.mat(0xf3f4f6, {roughness: 0.35, metalness: 0.15, fog: false}),
    brand: c.mat(brand, {roughness: 0.4, metalness: 0.1, fog: false}),
    wing: c.mat(0xbcc3cb, {roughness: 0.35, metalness: 0.55, fog: false}),
    dark: c.mat(0x1c2026, {roughness: 0.4, metalness: 0.3, fog: false}),
    win: c.mat(0x26313d, {roughness: 0.2, metalness: 0.3, emissive: new THREE.Color(0xffd9a0), emissiveIntensity: 0, fog: false}),
    gear: c.mat(0x3a3f46, {roughness: 0.6, metalness: 0.5, fog: false})
  };
  Object.keys(extra || {}).forEach(function(k){ M[k] = extra[k]; });
  return M;
}

/* ---------- the airliner ---------- */
var JET_YC = 3.4, JET_R = 1.95;
// the forward left door (model +x is left): its sill, and the nose and span, as the model below draws them
var DOOR_L1 = [1.95, 2.5, 14.6], NOSE = 19.05, SPAN = 36, AMPH_NOSE = 7.4;
function fuselage(THREE, prof, yc, sweepFrom, sweepK){
  var pts = prof.map(function(p){ return new THREE.Vector2(p[1], p[0]); });          // [z, r] -> lathe (r, along)
  var g = new THREE.LatheGeometry(pts, 24);
  g.rotateX(PI/2);
  var a = g.attributes.position.array;
  // the lathe's ring runs round old y; after the turn the length is +z (old y), the ring in x-y
  for(var i = 0; i < a.length; i += 3){
    var z = a[i + 2];
    a[i + 1] += yc + (z < sweepFrom ? (sweepFrom - z)*sweepK : 0);
  }
  g.computeVertexNormals();
  return g;
}
// the airliner's parts; parked: the gear is folded into P (down, at its belly height) instead of its own mesh
function airlinerParts(THREE, parked){
  var P = Parts(THREE), yc = JET_YC, R = JET_R;
  // the fuselage, its tail swept up; [z, radius]
  var prof = [[-19, 0.2], [-18, 0.55], [-16, 1.05], [-13, 1.6], [-10, 1.92], [-8, R], [13, R], [15, 1.88], [16.5, 1.65], [17.6, 1.3], [18.4, 0.85], [18.9, 0.35], [NOSE, 0]];
  P.geo("body", fuselage(THREE, prof, yc, -9, 0.1));
  // the livery: a cheatline down each side, the tail, the engines
  [1, -1].forEach(function(sx){
    P.box("brand", 0.05, 0.42, 26, sx*(R - 0.02), yc - 0.45, 0.5);
    for(var z = -12; z <= 13.6; z += 0.85) P.box("win", 0.06, 0.34, 0.24, sx*(R + 0.005), yc + 0.32, z);
    P.box("dark", 0.06, 1.7, 0.9, sx*(R + 0.005), yc - 0.05, DOOR_L1[2]);                    // the forward door
  });
  // the cockpit's windows round the nose
  [[-0.55, 0.42], [-0.18, 0.5], [0.18, 0.5], [0.55, 0.42]].forEach(function(w){
    var a = w[0]*1.3, r = 1.52;
    P.box("dark", 0.5, 0.32, 0.55, Math.sin(a)*r, yc + Math.cos(a)*r*0.62 + 0.15, 17.1, -0.5, 0, -a);
  });
  // the wings: low, swept 25°, 5° dihedral; winglets
  [1, -1].forEach(function(sx){
    var yr = yc - 1.25, yt = yc - 1.25 + 16*0.087, xr = sx*1.8, xt = sx*17.9;
    P.slab("wing", [[xr, yr, 3.6], [xt, yt, -3.9], [xt, yt, -5.5], [xr, yr, -3.2]], 0.32);
    // the winglet, its 0.12 m thickness inboard of the tip on both sides: the span is SPAN exactly
    var wo = sx < 0 ? 0.12 : 0;
    P.slab("brand", [[xt + wo, yt, -4.3], [xt + sx*0.1 + wo, yt + 1.7, -5.6], [xt + sx*0.1 + wo, yt + 1.7, -6.1], [xt + wo, yt, -5.5]], 0.12, true);
    // the engine under the wing: nacelle, intake, exhaust, pylon
    var ex = sx*5.8, ey = yc - 2.0;
    P.tube("brand", 1.05, 0.95, 4.2, ex, ey, 4.4);
    P.tube("dark", 0.92, 0.92, 0.1, ex, ey, 6.52);
    P.tube("wing", 0.6, 0.35, 1.2, ex, ey, 1.9);
    P.box("wing", 0.3, 0.9, 3.2, ex, ey + 1.0, 3.2);
    // the flap-track fairings
    for(var k = 0; k < 3; k++){ var fx = sx*(4 + k*4.2), fz = -3.2 - (k*4.2 + 2.2)*0.467*0.45; P.box("wing", 0.25, 0.3, 1.6, fx, yr + (k*4.2 + 2.2)*0.087 - 0.4, fz); }
  });
  P.box("wing", 3.6, 0.6, 6.2, 0, yc - 1.75, 0.3);                                          // the wing-to-body fairing
  // the tail: fin (brand), stabilisers
  P.slab("brand", [[0, yc + 1.2, -11.5], [0, yc + 7.6, -16.6], [0, yc + 7.6, -18.6], [0, yc + 1.2, -18.8]], 0.36, true);
  [1, -1].forEach(function(sx){
    P.slab("wing", [[sx*0.6, yc + 0.95, -15.2], [sx*6.3, yc + 1.45, -18.4], [sx*6.3, yc + 1.45, -19.5], [sx*0.6, yc + 0.95, -18.9]], 0.18);
  });
  // the gear: its own mesh, scaled up into the belly to retract (origin at the belly); parked, it sits in P
  var GP = parked ? P : Parts(THREE), gTop = yc - R + 0.3, gy = parked ? gTop : 0;
  GP.add("gear", new THREE.CylinderGeometry(0.12, 0.12, gTop - 0.45), 0, gy - (gTop - 0.45)/2, 14.3);
  [0.22, -0.22].forEach(function(x){ GP.add("gear", new THREE.CylinderGeometry(0.42, 0.42, 0.28, 14), x, gy - (gTop - 0.42), 14.3, 0, 0, PI/2); });
  [1, -1].forEach(function(sx){
    GP.add("gear", new THREE.CylinderGeometry(0.16, 0.16, gTop - 0.6), sx*3.0, gy - (gTop - 0.6)/2, -0.8);
    [0.38, -0.38].forEach(function(dx){ [0.55, -0.55].forEach(function(dz){
      GP.add("gear", new THREE.CylinderGeometry(0.58, 0.58, 0.4, 16), sx*3.0 + dx, gy - (gTop - 0.58), -0.8 + dz, 0, 0, PI/2);
    }); });
  });
  var lights = [{k: "red", p: [17.95, yc - 1.25 + 16*0.087 + 0.1, -4.4]}, {k: "green", p: [-17.95, yc - 1.25 + 16*0.087 + 0.1, -4.4]},
                {k: "white", p: [0, yc + 1.4, -19.3]}, {k: "strobe", p: [18.05, yc - 1.25 + 16*0.087 + 0.1, -4.9]},
                {k: "strobe", p: [-18.05, yc - 1.25 + 16*0.087 + 0.1, -4.9]}, {k: "beacon", p: [0, yc + R + 0.1, -2]}, {k: "beacon", p: [0, yc - R - 0.1, 2]},
                {k: "taxi", p: [0, 1.25, 14.75]}, {k: "landing", p: [3.4, yc - 1.5, 2.75]}, {k: "landing", p: [-3.4, yc - 1.5, 2.75]}];
  return {P: P, GP: parked ? null : GP, gTop: gTop, lights: lights, seat: [-1.4, yc + 0.1, 2.0],
          // the fin's vertices in the brand mesh (for a tail colour)
          tail: function(x, y, z){ return Math.abs(x) < 0.5 && z < -11.2 && y > yc + 1.0; }};
}
function airliner(c, opts){
  opts = opts || {};
  var S = airlinerParts(c.THREE, false);
  return build(c, "airliner", S.P, S.GP, S.gTop, S.lights, opts, S.seat, null, {tail: S.tail});
}

/* ---------- the seaplane (and the amphibian: the same with wheels in its floats) ---------- */
var SEA_YC = 2.9;
// wheels: an amphibian's gear (into W; at y 0 when down); parked: into P's gear
function seaParts(THREE, amph, parked){
  var P = Parts(THREE), yc = SEA_YC;
  P.geo("body", fuselage(THREE, [[-8.2, 0.15], [-7, 0.45], [-4.5, 0.85], [-2, 1.0], [4, 1.0], [5.6, 0.85], [6.8, 0.55], [AMPH_NOSE, 0]], yc, -3, 0.12));
  [1, -1].forEach(function(sx){
    P.box("brand", 0.04, 0.28, 10.5, sx*0.99, yc - 0.3, 0.4);
    for(var z = -3.4; z <= 3.2; z += 0.95) P.box("win", 0.05, 0.36, 0.42, sx*0.995, yc + 0.2, z);
    // floats and their struts
    P.ball("body", 1, sx*2.1, 0.42, 0.2, 0.42, 0.42, 5.4);
    P.box("brand", 0.06, 0.12, 9.6, sx*(2.1 + 0.4), 0.42, 0.4);
    [-1.8, 2.0].forEach(function(z){ P.box("gear", 0.1, 2.1, 0.12, sx*1.15, 1.45, z, 0, 0, sx*0.62); });
    // the engines on the wing, their props as a blur disc
    var ex = sx*3.0;
    P.tube("body", 0.42, 0.36, 2.8, ex, yc + 1.05, 1.6);
    P.tube("dark", 0.12, 0.12, 0.4, ex, yc + 1.05, 3.15);
  });
  P.slab("wing", [[9.9, yc + 1.45, 1.9], [-9.9, yc + 1.45, 1.9], [-9.9, yc + 1.45, -0.1], [9.9, yc + 1.45, -0.1]], 0.28);
  P.box("brand", 19.8, 0.06, 0.4, 0, yc + 1.48, 1.7);
  P.slab("brand", [[0, yc + 0.5, -5.2], [0, yc + 3.8, -7.4], [0, yc + 3.8, -8.4], [0, yc + 0.5, -8.4]], 0.24, true);
  P.slab("wing", [[3.2, yc + 0.6, -6.8], [-3.2, yc + 0.6, -6.8], [-3.2, yc + 0.6, -8.3], [3.2, yc + 0.6, -8.3]], 0.14);
  [[-0.3, 6.0], [0.3, 6.0]].forEach(function(w){ P.box("dark", 0.55, 0.32, 0.4, w[0]*1.6, yc + 0.6, w[1], -0.6, 0, 0); });
  var W = null;
  if(amph){
    // the wheels: a main pair either side of each float's step and a nose wheel at its bow, bottoms at y 0
    W = parked ? P : Parts(THREE);
    [1, -1].forEach(function(sx){
      [0.5, -0.5].forEach(function(dx){
        W.add("gear", new THREE.CylinderGeometry(0.34, 0.34, 0.2, 14), sx*2.1 + dx, 0.34, -0.6, 0, 0, PI/2);
        W.add("gear", new THREE.BoxGeometry(0.12, 0.3, 0.16), sx*2.1 + dx*0.62, 0.5, -0.6);
      });
      W.add("gear", new THREE.CylinderGeometry(0.24, 0.24, 0.16, 12), sx*2.1, 0.24, 3.7, 0, 0, PI/2);
      W.add("gear", new THREE.BoxGeometry(0.1, 0.3, 0.1), sx*2.1, 0.42, 3.7);
    });
  }
  var lights = [{k: "red", p: [10.0, yc + 1.3, 0.8]}, {k: "green", p: [-10.0, yc + 1.3, 0.8]}, {k: "white", p: [0, yc + 3.9, -8.5]},
                {k: "strobe", p: [10.05, yc + 1.3, 0.4]}, {k: "strobe", p: [-10.05, yc + 1.3, 0.4]}, {k: "beacon", p: [0, yc + 1.05, -3]},
                {k: "taxi", p: [0, yc - 0.75, 6.6]}, {k: "landing", p: [4.6, yc + 1.25, 1.95]}, {k: "landing", p: [-4.6, yc + 1.25, 1.95]}];
  return {P: P, W: parked ? null : W, lights: lights, seat: [-0.6, yc - 0.1, 1.0],
          tail: function(x, y, z){ return Math.abs(x) < 0.3 && z < -5.0 && y > yc + 0.45; }};
}
function seaBuild(c, opts, amph){
  opts = opts || {};
  var THREE = c.THREE, yc = SEA_YC, S = seaParts(THREE, amph, false);
  if(amph && opts.brand == null) opts = Object.assign({}, opts, {brand: ISLE});
  var M2 = {prop: new THREE.MeshBasicMaterial({color: 0x222222, transparent: true, opacity: 0.25, depthWrite: false, side: THREE.DoubleSide, fog: false})};
  var g2 = new THREE.CircleGeometry(1.25, 20);
  var P = build(c, amph ? "amphib" : "seaplane", S.P, null, 0, S.lights, opts, S.seat, M2, {tail: S.tail, W: S.W});
  [1, -1].forEach(function(sx){ var d = new THREE.Mesh(g2, M2.prop); d.position.set(sx*3.0, yc + 1.05, 3.4); P.g.add(d); });
  var disp = P.dispose;
  P.dispose = function(){ disp(); if(P.own){ g2.dispose(); M2.prop.dispose(); } };
  return P;
}
function seaplane(c, opts){ return seaBuild(c, opts, false); }
function amphibian(c, opts){ return seaBuild(c, opts, true); }

function build(c, name, P, GP, gTop, lights, opts, seat, extra, sp){
  var THREE = c.THREE, brand = opts.brand != null ? opts.brand : brandHex();
  var M = mats(c, brand, extra), g = new THREE.Group(); g.name = name;
  var geos = merged(THREE, P, M, name, g), gearM = null, wheels = null;
  if(GP){
    var gg = HQV.hqShips.merge(THREE, GP.by.gear); geos.push(gg);
    gearM = new THREE.Mesh(gg, M.gear); gearM.position.y = gTop; gearM.name = name + "-gear"; gearM.castShadow = true; g.add(gearM);
  }
  if(sp && sp.W){
    var wg = HQV.hqShips.merge(THREE, sp.W.by.gear); geos.push(wg);
    wheels = new THREE.Mesh(wg, M.gear); wheels.name = name + "-wheels"; wheels.castShadow = true; wheels.visible = false; g.add(wheels);
  }
  var Lt = lightsOf(THREE, lights); g.add(Lt.o);
  return finish(c, g, M, geos, Lt, gearM, seat, true, {tail: sp && sp.tail, wheels: wheels});
}
function finish(c, g, M, geos, Lt, gearM, seat, own, sp){
  var THREE = c.THREE, lit = -1, A = {g: g, seat: seat, own: own}, liv = null, groundY = null, brandM = null;
  g.traverse(function(o){ if(o.isMesh && o.name === g.name + "-brand") brandM = o; });
  A.place = function(p, x, y, z){
    g.position.set(x, y, z);
    g.rotation.set(-p.pitch, p.yaw, -p.roll, "YXZ");
    g.visible = true;
  };
  A.update = function(dt, t, night, gear, speed, phase, o){
    if(phase && typeof phase === "object"){ o = phase; phase = phase.phase; }
    var want = night ? 1.4 : 0.05;
    if(want !== lit){ lit = want; M.win.emissiveIntensity = want; }
    if(phase != null && PH_GROUND[phase]) groundY = g.position.y;
    blink(Lt, t, night, phase == null ? null : String(phase), groundY == null || g.position.y - groundY < 300);
    var gv = gear == null ? 1 : gear;
    if(gearM){ gearM.visible = gv > 0.02; gearM.scale.y = Math.max(0.02, gv); }
    if(sp.wheels) sp.wheels.visible = gv > 0.5 && !!o && o.surface === "land";
  };
  // this plane's own brand material (and, with a tail colour, its own copy of the brand mesh with the fin tinted)
  A.setLivery = function(bHex, tHex){
    if(!brandM) return A;
    var b = bHex != null ? bHex : brandHex();
    if(!liv){ liv = {m: brandM.material.clone(), geo: null}; liv.m.name = g.name + "-livery"; brandM.material = liv.m; }
    if(tHex != null && tHex !== b && sp.tail && !liv.geo){
      liv.geo = brandM.geometry.clone();
      liv.geo.setAttribute("color", new THREE.Float32BufferAttribute(new Float32Array(liv.geo.attributes.position.count*3), 3));
      brandM.geometry = liv.geo; liv.m.vertexColors = true; liv.m.needsUpdate = true;
    }
    if(liv.geo){
      var P = liv.geo.attributes.position, C = liv.geo.attributes.color, cb = new THREE.Color(b), ct = new THREE.Color(tHex != null ? tHex : b);
      for(var i = 0; i < P.count; i++){ var cc = sp.tail(P.getX(i), P.getY(i), P.getZ(i)) ? ct : cb; C.setXYZ(i, cc.r, cc.g, cc.b); }
      C.needsUpdate = true; liv.m.color.setHex(0xffffff);
    } else liv.m.color.setHex(b);
    return A;
  };
  A.clone = function(){
    var g2 = g.clone(true), gm2 = null, Lt2 = null, wh2 = null;
    g2.traverse(function(o){ if(o.name === g.name + "-gear") gm2 = o; if(o.name === g.name + "-wheels") wh2 = o; if(o.isPoints) Lt2 = o; });
    // the lights are per plane (each its own phase); the meshes and materials are shared
    var lg = Lt.g.clone(); Lt2.geometry = lg;
    var B = finish(c, g2, M, [], {o: Lt2, g: lg, m: Lt.m, L: Lt.L, col: lg.attributes.color.array}, gm2, seat, false, {tail: sp.tail, wheels: wh2});
    B.lightGeo = lg;
    return B;
  };
  A.dispose = function(){
    if(liv){ liv.m.dispose(); if(liv.geo) liv.geo.dispose(); liv = null; }
    if(own){ geos.forEach(function(x){ x.dispose(); }); Object.keys(M).forEach(function(k){ M[k].dispose(); }); Lt.g.dispose(); Lt.m.dispose(); }
    else if(A.lightGeo) A.lightGeo.dispose();
    if(g.parent) g.parent.remove(g);
  };
  return A;
}

/* ---------- a parked fleet: one InstancedMesh per material, the brand colour per instance ---------- */
function parked(c, kind, n){
  var THREE = c.THREE, jet = !/^(commuter|amphib|amphibian|sea|seaplane)$/.test(String(kind || "jet"));
  n = Math.max(1, Math.min(64, n | 0 || 1));
  var S = jet ? airlinerParts(THREE, true) : seaParts(THREE, true, true), M = mats(c, 0xffffff);
  var g = new THREE.Group(); g.name = "parked-" + (jet ? "jet" : "commuter");
  var ims = [], geos = [], m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), pv = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1);
  var up = new THREE.Vector3(0, 1, 0), col = new THREE.Color(), brand = null;
  Object.keys(S.P.by).forEach(function(k){
    var geo = HQV.hqShips.merge(THREE, S.P.by[k]); geos.push(geo);
    var im = new THREE.InstancedMesh(geo, M[k], n);
    im.name = g.name + "-" + k; im.castShadow = k !== "win"; im.frustumCulled = false; im.count = 0; im.visible = false;
    if(k === "brand"){ brand = im; for(var i = 0; i < n; i++) im.setColorAt(i, col.setHex(jet ? brandHex() : ISLE)); }
    g.add(im); ims.push(im);
  });
  var F = {g: g, n: n, kind: jet ? "jet" : "commuter", tris: 0};
  geos.forEach(function(x){ F.tris += (x.index ? x.index.count : x.attributes.position.count)/3; });
  F.set = function(i, p, hex){
    i = i | 0; if(i < 0 || i >= n || !p) return F;
    pv.set(+p.x || 0, +p.y || 0, +p.z || 0); q.setFromAxisAngle(up, +p.yaw || 0); m4.compose(pv, q, one);
    ims.forEach(function(im){ im.setMatrixAt(i, m4); im.instanceMatrix.needsUpdate = true; });
    if(brand){ brand.setColorAt(i, col.setHex(hex != null ? hex : jet ? brandHex() : ISLE)); brand.instanceColor.needsUpdate = true; }
    return F;
  };
  F.count = function(k){ k = Math.max(0, Math.min(n, k | 0)); ims.forEach(function(im){ im.count = k; im.visible = k > 0; }); return F; };
  F.setNight = function(on){ M.win.emissiveIntensity = on ? 1.4 : 0.05; return F; };
  F.dispose = function(){
    ims.forEach(function(im){ im.dispose(); }); geos.forEach(function(x){ x.dispose(); }); Object.keys(M).forEach(function(k){ M[k].dispose(); });
    if(g.parent) g.parent.remove(g);
  };
  F.setNight(false);
  return F;
}

/* ---------- contrails ---------- */
function contrails(c){
  var THREE = c.THREE, tex = null;
  if(typeof document !== "undefined" && document.createElement){
    var cv = document.createElement("canvas"); cv.width = 4; cv.height = 128;
    var x = cv.getContext && cv.getContext("2d");
    if(x){ var gr = x.createLinearGradient(0, 0, 0, 128); gr.addColorStop(0, "rgba(255,255,255,0)"); gr.addColorStop(0.75, "rgba(255,255,255,0.5)");
      gr.addColorStop(1, "rgba(255,255,255,0.75)"); x.fillStyle = gr; x.fillRect(0, 0, 4, 128); tex = new THREE.CanvasTexture(cv); }
  }
  var geo = new THREE.CylinderGeometry(1, 1, 1, 10, 1, true); geo.translate(0, 0.5, 0);
  var m = new THREE.MeshBasicMaterial({color: 0xffffff, map: tex, transparent: true, opacity: 0.85, depthWrite: false, fog: false, side: THREE.DoubleSide});
  var up = new THREE.Vector3(0, 1, 0), d = new THREE.Vector3();
  return {
    add: function(){ var o = new THREE.Mesh(geo, m); o.frustumCulled = false; o.name = "contrail"; o.renderOrder = 3; return o; },
    // from: the tail (the trail's young end), to: its far end; it widens as it ages
    set: function(o, from, to){
      d.set(from[0] - to[0], from[1] - to[1], from[2] - to[2]);
      var L = d.length(); if(L < 1){ o.visible = false; return; }
      o.position.set(to[0], to[1], to[2]); o.quaternion.setFromUnitVectors(up, d.multiplyScalar(1/L)); o.scale.set(6, L, 6); o.visible = true;
    },
    setNight: function(n){ m.color.setHex(n ? 0x8a96a8 : 0xffffff); m.opacity = n ? 0.35 : 0.85; },
    dispose: function(){ geo.dispose(); m.dispose(); if(tex) tex.dispose(); }
  };
}

/* ---------- the airport's dressing ---------- */
function airport(c, end, o){
  o = o || {};
  var THREE = c.THREE, P = Parts(THREE), ground = o.ground || function(){ return 0; };
  var u = end.dir, thr = end.thr, L = end.len, y = end.y, ry = Math.atan2(u[0], u[1]), W = 30;
  function at(a, b){ return [thr[0] + u[0]*a + u[1]*b, thr[1] + u[1]*a - u[0]*b]; }   // a along the runway, b to its left
  // the deck: a slab from just behind the threshold to past the far end, on piles where the land falls away
  var a0 = -20, a1 = L + 25, mid = at((a0 + a1)/2, 0);
  P.box("asphalt", W, 2.0, a1 - a0, mid[0], y - 1.0, mid[1], 0, ry);
  P.box("conc", W + 2, 0.4, a1 - a0 + 2, mid[0], y - 1.9, mid[1], 0, ry);
  for(var a = a0 + 5; a <= a1; a += 25) [-W/2 + 2, 0, W/2 - 2].forEach(function(b){
    var p = at(a, b), gy = Math.min(ground(p[0], p[1]), 0) - 3;
    if(y - 2 - gy > 1.5) P.add("conc", new THREE.CylinderGeometry(0.8, 0.9, y - 2 - gy, 10), p[0], (y - 2 + gy)/2, p[1]);
  });
  // markings: the centreline, piano keys and the aiming point at the landing (seaward) end, side stripes
  for(a = 30; a < L - 30; a += 24){ var q = at(a, 0); P.box("paint", 0.9, 0.04, 12, q[0], y + 0.02, q[1], 0, ry); }
  [-1, 1].forEach(function(s){ for(var k = 0; k < 5; k++){ var pk = at(L - 8, s*(2.4 + k*2.6)); P.box("paint", 1.6, 0.04, 14, pk[0], y + 0.02, pk[1], 0, ry);
                                                        var pk2 = at(6, s*(2.4 + k*2.6)); P.box("paint", 1.6, 0.04, 10, pk2[0], y + 0.02, pk2[1], 0, ry); }
                                var am = at(L - 90, s*5); P.box("paint", 2.4, 0.04, 30, am[0], y + 0.02, am[1], 0, ry);
                                var sd = at((a0 + a1)/2, s*(W/2 - 1.2)); P.box("paint", 0.5, 0.04, a1 - a0 - 4, sd[0], y + 0.02, sd[1], 0, ry); });
  // the stand: a yellow lead-in line from the threshold to the stand, and its stop bar; a stand sign
  var st = at(-(HQV.hqAir ? HQV.hqAir.STAND_BACK : 25), 0), sy = Math.max(y, ground(st[0], st[1]) + 0.2);
  var li = at(-12, 0);
  P.box("yellow", 0.35, 0.05, 26, li[0], sy + 0.02, li[1], 0, ry);
  var sb = at(-(HQV.hqAir ? HQV.hqAir.STAND_BACK : 25) - 17, 0);
  P.box("yellow", 6, 0.05, 0.5, sb[0], sy + 0.02, sb[1], 0, ry);
  var mk = new THREE.Group();
  // the light fixtures (InstancedMesh): runway edges, the green threshold bar at the landing end, red at the other, approach bars
  var spots = {edge: [], green: [], red: [], appr: [], pole: []};
  for(a = 0; a <= L; a += 30) [-1, 1].forEach(function(s){ var p = at(a, s*(W/2 + 0.6)); spots.edge.push([p[0], y + 0.15, p[1]]); });
  for(var b = -W/2; b <= W/2; b += 3){ var pg = at(L + 3, b); spots.green.push([pg[0], y + 0.15, pg[1]]); var pr = at(-19, b); spots.red.push([pr[0], y + 0.15, pr[1]]); }
  for(a = L + 30; a <= L + 330; a += 30){
    var wide = a === L + 150 ? 15 : 4;
    for(b = -wide; b <= wide; b += wide > 4 ? 2.5 : 2){ var pa = at(a, b), gy2 = Math.min(ground(pa[0], pa[1]), 0); spots.appr.push([pa[0], y + 0.6, pa[1]]); }
    var pp = at(a, 0), gy3 = Math.min(ground(pp[0], pp[1]), 0);
    spots.pole.push([pp[0], (y + 0.5 + gy3 - 3)/2, pp[1], y + 0.5 - gy3 + 3]);
  }
  var M = {
    asphalt: c.mat(0x2b3036, {roughness: 0.95}), conc: c.mat(0x9a9d9f, {roughness: 0.9}), paint: c.mat(0xf2f2f2, {roughness: 0.8}),
    yellow: c.mat(0xf2c230, {roughness: 0.7})
  };
  var g = new THREE.Group(); g.name = "airport-dressing";
  var geos = merged(THREE, P, M, "airport", g);
  g.children.forEach(function(m){ m.castShadow = false; m.receiveShadow = true; });
  var LM = {
    edge: c.mat(0x666666, {emissive: new THREE.Color(0xfff2c8), emissiveIntensity: 0.3}),
    green: c.mat(0x225522, {emissive: new THREE.Color(0x30ff70), emissiveIntensity: 0.3}),
    red: c.mat(0x552222, {emissive: new THREE.Color(0xff3020), emissiveIntensity: 0.3}),
    appr: c.mat(0x666666, {emissive: new THREE.Color(0xffffff), emissiveIntensity: 0.3}),
    pole: c.mat(0xd0d3d6, {roughness: 0.6})
  };
  var fixG = new THREE.BoxGeometry(0.45, 0.3, 0.45), poleG = new THREE.CylinderGeometry(0.18, 0.18, 1, 6), m4 = new THREE.Matrix4(), inst = [];
  Object.keys(spots).forEach(function(k){
    var S = spots[k]; if(!S.length) return;
    var im = new THREE.InstancedMesh(k === "pole" ? poleG : fixG, LM[k], S.length);
    S.forEach(function(p, i){ m4.makeTranslation(p[0], p[1], p[2]); if(k === "pole") m4.scale(new THREE.Vector3(1, p[3], 1)); im.setMatrixAt(i, m4); });
    im.instanceMatrix.needsUpdate = true; im.name = "airport-lights-" + k; g.add(im); inst.push(im);
  });
  // their glow at night: one Points cloud (a few pixels at any distance), and the sequenced flasher running in
  var glowPos = [], glowCol = [];
  function glow(list, rgb){ list.forEach(function(p){ glowPos.push(p[0], p[1] + 0.3, p[2]); glowCol.push(rgb[0], rgb[1], rgb[2]); }); }
  glow(spots.edge, [1, 0.9, 0.65]); glow(spots.green, [0.2, 1, 0.4]); glow(spots.red, [1, 0.15, 0.1]); glow(spots.appr, [1, 1, 0.95]);
  var gg = new THREE.BufferGeometry(); gg.setAttribute("position", new THREE.Float32BufferAttribute(glowPos, 3)); gg.setAttribute("color", new THREE.Float32BufferAttribute(glowCol, 3));
  var gm = new THREE.PointsMaterial({size: 3.5, sizeAttenuation: false, vertexColors: true, transparent: true, depthWrite: false, fog: false, toneMapped: false});
  var gp = new THREE.Points(gg, gm); gp.frustumCulled = false; gp.name = "airport-glow"; g.add(gp);
  var fl = new THREE.BufferGeometry(); fl.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0], 3));
  var fm = new THREE.PointsMaterial({color: 0xffffff, size: 9, sizeAttenuation: false, transparent: true, depthWrite: false, fog: false, toneMapped: false});
  var fp = new THREE.Points(fl, fm); fp.frustumCulled = false; g.add(fp);
  // the control tower's beacon (hqcivic's tower: right of the terminal, its cab at 24 + 4 tier m), green and white in turn
  var tw = null;
  if(o.site){
    var T = o.tier || 5, W0 = (o.site.w || 0)/100, D0 = (o.site.d || 0)/100, tw0 = Math.min(W0*0.6, 60 + T*20), td = Math.min(D0*0.18, 30), tz = D0/2 - 4 - td/2;
    var lx = tw0/2 + 14, lz = tz - 4, f = [-u[0], -u[1]], rr = Math.atan2(f[0], f[1]), cx = o.site.x/100, cz = o.site.z/100;
    var wx = cx + lx*Math.cos(rr) + lz*Math.sin(rr), wz = cz - lx*Math.sin(rr) + lz*Math.cos(rr), wy = ground(cx, cz) + 0.12 + 24 + T*4 + 5.4;
    var tb = new THREE.BufferGeometry(); tb.setAttribute("position", new THREE.Float32BufferAttribute([wx, wy, wz], 3));
    var tm = new THREE.PointsMaterial({color: 0x30ff70, size: 7, sizeAttenuation: false, transparent: true, depthWrite: false, fog: false, toneMapped: false});
    var tp = new THREE.Points(tb, tm); tp.frustumCulled = false; g.add(tp);
    var bm = c.mat(0x222222, {emissive: new THREE.Color(0x30ff70), emissiveIntensity: 1.5});
    var bc = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 0.7, 10), bm); bc.position.set(wx, wy - 0.2, wz); g.add(bc);
    tw = {tb: tb, tm: tm, bm: bm, bc: bc};
  }
  var night = false, A = {g: g, stand: st};
  A.setNight = function(n){
    night = !!n;
    var k = n ? 2.6 : 0.25;
    ["edge", "green", "red", "appr"].forEach(function(key){ LM[key].emissiveIntensity = k; });
    gp.visible = night; fp.visible = night;
  };
  A.update = function(t){
    if(night){
      // the rabbit: a white flash running in along the approach bars to the threshold, twice a second
      var ph = (t*2) % 1, aa = L + 330 - ph*300, q = at(aa, 0);
      fl.attributes.position.setXYZ(0, q[0], y + 0.9, q[1]); fl.attributes.position.needsUpdate = true; fm.opacity = ph < 0.92 ? 1 : 0;
    }
    if(tw){ var green = (t % 2) < 1; tw.tm.color.setHex(green ? 0x30ff70 : 0xffffff); tw.bm.emissive.setHex(green ? 0x30ff70 : 0xffffff); tw.tm.size = night ? 8 : 4; }
  };
  A.dispose = function(){
    geos.forEach(function(x){ x.dispose(); }); Object.keys(M).forEach(function(k){ M[k].dispose(); }); Object.keys(LM).forEach(function(k){ LM[k].dispose(); });
    fixG.dispose(); poleG.dispose(); gg.dispose(); gm.dispose(); fl.dispose(); fm.dispose();
    if(tw){ tw.tb.dispose(); tw.tm.dispose(); tw.bm.dispose(); tw.bc.geometry.dispose(); }
    if(g.parent) g.parent.remove(g);
  };
  A.setNight(false);
  return A;
}

HQV.hqAircraft = {airliner: airliner, seaplane: seaplane, amphibian: amphibian, parked: parked, contrails: contrails, airport: airport,
                  brandHex: brandHex, airlineColor: airlineColor, AIRLINES: AIRLINES, AIRLINE_IDS: AIRLINE_IDS,
                  DOOR_L1: DOOR_L1, NOSE: NOSE, SPAN: SPAN, AMPH_NOSE: AMPH_NOSE};
})();
