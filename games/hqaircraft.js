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
 *   parked(c, kind, n) -> F  a parked fleet ("jet" or "commuter"), one InstancedMesh per material (F.setDetail(1): 3 of them; <= 7 draw
 *     calls whatever n): F.set(i, {x, y, z, yaw}, brandHex), F.count(k), F.setNight(n), F.dispose(), F.g
 *   DOOR_L1 [x, y, z] the airliner's forward left door sill (model frame), NOSE its nose (z), SPAN its span
 *   AIRLINES the invented airlines {id: {name, color}} (archipelago: the brand colour), AIRLINE_IDS
 *   contrails(c) -> {add() -> mesh, set(mesh, [x, y, z] from, [x, y, z] to), dispose()}  white ribbons
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
  var geos = [], parts = solidParts(P.by);
  Object.keys(parts).forEach(function(k){
    var geo = HQV.hqShips.merge(THREE, parts[k]), m = new THREE.Mesh(geo, M[k]);
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
    gear: c.mat(0x3a3f46, {roughness: 0.6, metalness: 0.5, fog: false}),
    solid: c.mat(0xffffff, {vertexColors: true, roughness: 0.4, metalness: 0.3, fog: false})   // the plain parts merged (SOLID)
  };
  Object.keys(extra || {}).forEach(function(k){ M[k] = extra[k]; });
  return M;
}

// the plain parts (body, trim, wings, static gear) as one vertex-coloured part, "solid": one draw for them all; the
// livery (a colour per plane), the windows (lit at night) and the extras keep their own. SOLID: mats()' colours.
var SOLID = {body: 0xf3f4f6, wing: 0xbcc3cb, dark: 0x1c2026, gear: 0x3a3f46};
function solidParts(by){
  var parts = {};
  Object.keys(by).forEach(function(k){
    if(SOLID[k] == null){ parts[k] = by[k]; return; }
    parts.solid = (parts.solid || []).concat(by[k].map(function(p){ return [p[0], p[1], SOLID[k]]; }));
  });
  return parts;
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
  var props = [];
  [1, -1].forEach(function(sx){ var d = new THREE.Mesh(g2, M2.prop); d.position.set(sx*3.0, yc + 1.05, 3.4); P.g.add(d); props.push(d); });
  P.props = props; P.discM = M2.prop;          // (the pilotable seaplane, games/hqplane.js, spins them up)
  var disp = P.dispose;
  P.dispose = function(){ disp(); if(P.own){ g2.dispose(); M2.prop.dispose(); } };
  return P;
}
function seaplane(c, opts){ return seaBuild(c, opts, false); }
function amphibian(c, opts){ return seaBuild(c, opts, true); }

/* ---------- the prop plane (HQ 3.2: one you fly) ---------- */
// A small high-wing single (original design): 7.6 m long, 10.4 m span, a two-blade propeller, retractable tricycle gear.
// P.prop (the spinning blades), P.disc (their blur), P.seat; the gear retracts with update(..., gear).
var PROP_YC = 1.5;
function propPlane(c, opts){
  opts = opts || {};
  var THREE = c.THREE, P = Parts(THREE), yc = PROP_YC, yw = yc + 0.74;
  P.geo("body", fuselage(THREE, [[-4.4, 0.1], [-3.2, 0.3], [-1.4, 0.58], [0.2, 0.68], [1.7, 0.64], [2.6, 0.5], [3.05, 0.34], [3.2, 0]], yc, -1.6, 0.1));
  [1, -1].forEach(function(sx){
    P.box("brand", 0.04, 0.16, 5.6, sx*0.6, yc - 0.12, -0.9);                          // the cheatline
    P.box("win", 0.05, 0.36, 0.9, sx*0.62, yc + 0.3, 0.2);                             // the cabin's side windows
    P.box("win", 0.05, 0.3, 0.6, sx*0.55, yc + 0.28, -0.75);
    // the wing strut, fuselage to wing
    P.add("gear", new THREE.CylinderGeometry(0.035, 0.035, 2.3), sx*1.25, yc + 0.18, 0.15, 0, 0, -sx*1.05);
  });
  P.box("win", 1.0, 0.42, 0.06, 0, yc + 0.42, 1.1, -0.75, 0, 0);                      // the windscreen
  // the wing (high, on top of the cabin), its brand tips; the tail
  P.slab("wing", [[5.2, yw, 1.05], [-5.2, yw, 1.05], [-5.2, yw, -0.45], [5.2, yw, -0.45]], 0.16);
  [1, -1].forEach(function(sx){ P.box("brand", 0.5, 0.17, 1.52, sx*4.95, yw - 0.08, 0.3); });
  P.slab("brand", [[0, yc + 0.3, -2.9], [0, yc + 1.75, -3.95], [0, yc + 1.75, -4.45], [0, yc + 0.3, -4.4]], 0.12, true);
  P.slab("wing", [[1.75, yc + 0.2, -3.75], [-1.75, yc + 0.2, -3.75], [-1.75, yc + 0.2, -4.4], [1.75, yc + 0.2, -4.4]], 0.08);
  // the cowling and the spinner
  P.tube("dark", 0.5, 0.55, 0.3, 0, yc, 2.8, 16);
  P.add("brand", new THREE.ConeGeometry(0.2, 0.42, 14), 0, yc, 3.35, PI/2);
  // the gear: its own mesh, scaled up into the belly (origin at the belly) to retract
  var GP = Parts(THREE), gTop = yc - 0.55, wr = 0.24;
  GP.add("gear", new THREE.CylinderGeometry(0.05, 0.05, gTop - wr), 0, -(gTop - wr)/2, 2.1);
  GP.add("gear", new THREE.CylinderGeometry(wr*0.85, wr*0.85, 0.14, 14), 0, -(gTop - wr*0.85), 2.1, 0, 0, PI/2);
  [1, -1].forEach(function(sx){
    GP.add("gear", new THREE.CylinderGeometry(0.05, 0.05, gTop - wr), sx*1.0, -(gTop - wr)/2, -0.15, 0, 0, sx*0.35);
    GP.add("gear", new THREE.CylinderGeometry(wr, wr, 0.16, 14), sx*1.3, -(gTop - wr), -0.15, 0, 0, PI/2);
  });
  var lights = [{k: "red", p: [5.25, yw - 0.05, 0.3]}, {k: "green", p: [-5.25, yw - 0.05, 0.3]}, {k: "white", p: [0, yc + 1.8, -4.45]},
                {k: "strobe", p: [5.3, yw - 0.05, 0.0]}, {k: "strobe", p: [-5.3, yw - 0.05, 0.0]}, {k: "beacon", p: [0, yc + 0.7, -1.4]}];
  var M2 = {prop: new THREE.MeshBasicMaterial({color: 0x222222, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide, fog: false})};
  var S = build(c, "propplane", P, GP, gTop, lights, opts, [0.3, yc - 0.35, 0.6], M2);
  // the propeller: two blades (they turn) and a blur disc (it shows as they spin up)
  var prop = new THREE.Group(); prop.position.set(0, yc, 3.12); S.g.add(prop);
  var bladeM = c.mat(0x1c2026, {roughness: 0.5});
  [1, -1].forEach(function(s){ var b = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.95, 0.04), bladeM); b.position.y = s*0.5; b.rotation.y = s*0.25; prop.add(b); });
  var disc = new THREE.Mesh(new THREE.CircleGeometry(1.0, 24), M2.prop); disc.position.set(0, yc, 3.16); S.g.add(disc);
  S.prop = prop; S.disc = disc; S.discM = M2.prop;
  return S;
}

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
var FAR_PARTS = {solid: 1, body: 1, brand: 1, wing: 1};
function parked(c, kind, n){
  var THREE = c.THREE, jet = !/^(commuter|amphib|amphibian|sea|seaplane)$/.test(String(kind || "jet"));
  n = Math.max(1, Math.min(64, n | 0 || 1));
  var S = jet ? airlinerParts(THREE, true) : seaParts(THREE, true, true), M = mats(c, 0xffffff);
  var g = new THREE.Group(); g.name = "parked-" + (jet ? "jet" : "commuter");
  var ims = [], geos = [], m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), pv = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1);
  var up = new THREE.Vector3(0, 1, 0), col = new THREE.Color(), brand = null;
  var parts = solidParts(S.P.by);
  Object.keys(parts).forEach(function(k){
    var geo = HQV.hqShips.merge(THREE, parts[k]); geos.push(geo);
    var im = new THREE.InstancedMesh(geo, M[k], n);
    im.name = g.name + "-" + k; im.castShadow = k !== "win"; im.frustumCulled = false; im.count = 0; im.visible = false; im.userData.part = k;
    if(k === "brand"){ brand = im; for(var i = 0; i < n; i++) im.setColorAt(i, col.setHex(jet ? brandHex() : ISLE)); }
    g.add(im); ims.push(im);
  });
  var F = {g: g, n: n, kind: jet ? "jet" : "commuter", tris: 0};
  geos.forEach(function(x){ F.tris += (x.index ? x.index.count : x.attributes.position.count)/3; });
  // the shadow: one invisible caster for every casting part (one shadow-pass draw for the fleet, not five)
  var sp = [];
  ims.forEach(function(im){ if(!im.castShadow) return; var a = im.geometry.attributes.position.array; for(var i = 0; i < a.length; i++) sp.push(a[i]); im.castShadow = false; });
  var sgeo = new THREE.BufferGeometry(); sgeo.setAttribute("position", new THREE.Float32BufferAttribute(sp, 3)); sgeo.computeBoundingSphere(); geos.push(sgeo);
  var shm = new THREE.InstancedMesh(sgeo, new THREE.MeshBasicMaterial({colorWrite: false, depthWrite: false}), n);
  shm.name = g.name + "-shadow"; shm.castShadow = true; shm.frustumCulled = false; shm.count = 0; shm.visible = false; shm.userData.part = "shadow";
  M.shadow = shm.material; g.add(shm); ims.push(shm);
  F.set = function(i, p, hex){
    i = i | 0; if(i < 0 || i >= n || !p) return F;
    pv.set(+p.x || 0, +p.y || 0, +p.z || 0); q.setFromAxisAngle(up, +p.yaw || 0); m4.compose(pv, q, one);
    ims.forEach(function(im){ im.setMatrixAt(i, m4); im.instanceMatrix.needsUpdate = true; });
    if(brand){ brand.setColorAt(i, col.setHex(hex != null ? hex : jet ? brandHex() : ISLE)); brand.instanceColor.needsUpdate = true; }
    return F;
  };
  // level 1 (far): only the body, the livery and the wings (3 draw calls); the windows, trim and gear from level 2
  var level = 2, shown = 0;
  function vis(){ ims.forEach(function(im){ im.count = shown; im.visible = shown > 0 && (level >= 2 || FAR_PARTS[im.userData.part] === 1); }); }
  F.count = function(k){ shown = Math.max(0, Math.min(n, k | 0)); vis(); return F; };
  F.setDetail = function(lv){ level = (lv | 0) >= 2 ? 2 : 1; vis(); return F; };
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

HQV.hqAircraft = {airliner: airliner, seaplane: seaplane, amphibian: amphibian, propPlane: propPlane, parked: parked, contrails: contrails,
                  brandHex: brandHex, airlineColor: airlineColor, AIRLINES: AIRLINES, AIRLINE_IDS: AIRLINE_IDS,
                  DOOR_L1: DOOR_L1, NOSE: NOSE, SPAN: SPAN, AMPH_NOSE: AMPH_NOSE, PROP_YC: PROP_YC};
})();
