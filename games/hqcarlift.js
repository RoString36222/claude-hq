/* Claude HQ 3.4: the car lift (HQV.hqCarLift), between your lot's street bay and your basement garage (B1).
 *
 * Everything here is pure (no THREE, no DOM) except mesh(), so tests/test_hqcarlift.py drives it under node.
 *
 *   create({dir: "down"|"up", depth: 6, k: 1, approach: 0.4}) -> state {phase, t, y, doors, done, p, floor, dir, depth, D}
 *     The lift's ride: approach -> closing (0.8 s) -> moving (3 s, eased) -> opening (0.8 s) -> done.
 *     y runs 0 -> -depth going down (the reverse going up), monotonic; doors is how open the doors are (1 open,
 *     0 shut); p the whole ride's progress 0..1; floor "G" | "B1" (what the indicator shows). Calm (k < 0.5): the
 *     whole ride takes about CALM_TOTAL (0.3 s), so the lift is instant-ish.
 *   step(s, dt) -> s: advances it (dt in s; a long frame carries over into the next phases, so it is frame-rate
 *     independent). durations(k), total(k): the phase lengths.
 *   padLocal() -> {x, z, w, d, yaw}: the bay in the lot's frame, the footprint of the old garage
 *     (HQV.hqLotExtras.garage), so garagePlace and hqLotExtraBlocked still hold.
 *   streetSpot(C, E?) -> {x, y, z, yaw, camYaw}: on the street apron in front of the bay, facing the road (away
 *     from the tower). E: your HQ's {x, z, rot, garage: {x, z, s}} when the caller has it (hqcity3d's E), else
 *     C.homeLot, else derived from C.home (your door, as hqcity3d's at()).
 *   padSpot(L?) -> {x, y, z, yaw, camYaw}: the platform in the basement (L.pad overrides the default spot).
 *   carries(from, to, ride, door) -> bool: you keep your ride through this door (a carlift door, riding a car,
 *     motorbike or bicycle; never a board, a boat or an aircraft).
 *   arm(door) / armed(): the door walkInto used (arm(null) clears it).
 *   liftSite(C, uid, E?) -> {cp, site}: the carpark's duck type (find/bays/bayFor/assign/exitPath/entryPath/
 *     entrance/stored/groundAt/blockedAt/camHit/layout) for a vehicle that lives in your basement: called, it
 *     rises out of the bay (rise(): a create({dir: "up"}) state for the caller to play) and drives off the apron;
 *     sent back, it drives onto the pad and sinks. stored() fires onStored(fn) listeners.
 *   mesh(ctx, opts) -> {g, platform, doors, screen, chase, update(state, t, k), setNight(on), drawCalls(), dispose()}
 *     The bay: glass shaft walls, a chevroned platform, a light chase round the frame, the indicator screen
 *     ("B1 ▼ / G ▲"), a canopy sign "CAR LIFT" and sliding doors. opts: {level: "G"|"B1", w, d, depth, h,
 *     accent (hex), label}. The street bay and the basement platform are this one mesh, so they match.
 */
(function(){
"use strict";
var HQV = window.HQV = window.HQV || {};

var DUR = {approach: 0.4, closing: 0.8, moving: 3.0, opening: 0.8};
var ORDER = ["approach", "closing", "moving", "opening", "done"];
var CALM_TOTAL = 0.3, DEPTH = 6, HQ_DOOR = 4.8, SPAWN_OUT = 2.6, APRON = 3.2;
var PAD0 = {x: 13.0, z: 6.7, w: 7.0, d: 6.2, h: 3.0};
var BASE_PAD = {x: -26, z: 0, yaw: Math.PI/2};
var NO_LIFT = /skate|board|boat|ship|yacht|kayak|ferry|heli|plane|air|jet|glider|drone/i;

function num(v, d){ v = +v; return isFinite(v) ? v : d; }
function clamp(v, a, b){ return v < a ? a : v > b ? b : v; }
function ease(x){ x = clamp(x, 0, 1); return clamp(x*x*x*(x*(x*6 - 15) + 10), 0, 1); }   // smootherstep: gentle start and stop

/* ---------- the ride ---------- */
function durations(k, approach){
  var D = {approach: approach != null ? Math.max(0, num(approach, DUR.approach)) : DUR.approach,
           closing: DUR.closing, moving: DUR.moving, opening: DUR.opening};
  if(num(k, 1) < 0.5){
    var sum = D.approach + D.closing + D.moving + D.opening, f = sum > 0 ? CALM_TOTAL/sum : 0;
    Object.keys(D).forEach(function(p){ D[p] *= f; });
  }
  return D;
}
function total(k, approach){ var D = durations(k, approach); return D.approach + D.closing + D.moving + D.opening; }
function create(o){
  o = o || {};
  var dir = o.dir === "up" ? "up" : "down", depth = Math.max(0.5, num(o.depth, DEPTH));
  var s = {dir: dir, depth: depth, k: num(o.k, 1), D: durations(o.k, o.approach), phase: "approach", t: 0, el: 0,
           y: 0, doors: 1, done: false, p: 0, floor: "G"};
  s.T = s.D.approach + s.D.closing + s.D.moving + s.D.opening;
  apply(s);
  return s;
}
function apply(s){
  var D = s.D, a = s.phase === "moving" ? (D.moving > 0 ? ease(s.t/D.moving) : 1) : (s.phase === "opening" || s.phase === "done") ? 1 : 0;
  s.y = s.dir === "down" ? -s.depth*a : -s.depth*(1 - a);
  s.y = clamp(s.y, -s.depth, 0); if(s.y === 0) s.y = 0;     // in range, never -0
  s.doors = s.phase === "approach" ? 1 : s.phase === "closing" ? 1 - clamp(D.closing > 0 ? s.t/D.closing : 1, 0, 1)
          : s.phase === "moving" ? 0 : s.phase === "opening" ? clamp(D.opening > 0 ? s.t/D.opening : 1, 0, 1) : 1;
  s.p = s.T > 0 ? clamp(s.el/s.T, 0, 1) : 1;
  s.floor = s.y < -s.depth/2 ? "B1" : "G";
  s.done = s.phase === "done";
  return s;
}
function step(s, dt){
  if(!s || s.done) return s;
  dt = num(dt, 0); if(dt < 0) dt = 0;
  s.el += dt; s.t += dt;
  // a long frame runs on through the phases it covers
  for(var guard = 0; guard < 8 && s.phase !== "done"; guard++){
    var len = s.D[s.phase] || 0;
    if(s.t < len) break;
    s.t -= len;
    s.phase = ORDER[ORDER.indexOf(s.phase) + 1];
  }
  if(s.phase === "done") s.t = 0;
  return apply(s);
}

/* ---------- where the bay is ---------- */
function padLocal(){
  var G = (HQV.hqLotExtras && HQV.hqLotExtras.garage) || PAD0;
  return {x: num(G.x, PAD0.x), z: num(G.z, PAD0.z), w: num(G.w, PAD0.w), d: num(G.d, PAD0.d), yaw: 0};
}
function toWorld(p, lx, lz){ var cr = Math.cos(p.rot), sr = Math.sin(p.rot); return {x: p.x + lx*cr + lz*sr, z: p.z - lx*sr + lz*cr}; }
// your lot's frame {x, z, rot} and its bay {x, z, s} (lot frame), from E, C.homeLot or C.home
function lotOf(C, E){
  var L = E && isFinite(E.x) && isFinite(E.rot) ? E : C && C.homeLot && isFinite(C.homeLot.x) ? C.homeLot : null;
  var P = padLocal(), p = null, gar = null;
  if(L){ p = {x: +L.x, z: +L.z, rot: num(L.rot, 0)}; gar = L.garage || null; }
  else {
    var h = C && C.home; if(!h || !isFinite(h.x) || !isFinite(h.z)) return null;
    var r = num(h.yaw, 0), fx = Math.sin(r), fz = Math.cos(r), back = HQ_DOOR + SPAWN_OUT;
    p = {x: h.x - fx*back, z: h.z - fz*back, rot: r};
  }
  if(!gar || !isFinite(gar.x) || !isFinite(gar.z)) gar = {x: P.x, z: P.z, s: 1};
  return {p: p, gar: {x: +gar.x, z: +gar.z, s: gar.s === -1 ? -1 : 1}, P: P, y: num(C && C.home && C.home.y, 0)};
}
function pose(x, y, z, yaw){ return {x: x, y: y, z: z, yaw: yaw, camYaw: yaw + 0.55}; }
// lot-frame points of the bay: its middle, its door line and the apron's far end
function lotPoints(F){
  var g = F.gar, d = F.P.d;
  return {pad: toWorld(F.p, g.x, g.z), door: toWorld(F.p, g.x, g.z + d/2), apron: toWorld(F.p, g.x, g.z + d/2 + APRON)};
}
function streetSpot(C, E){
  var F = lotOf(C, E); if(!F) return null;
  var Q = lotPoints(F);
  return pose(Q.apron.x, F.y, Q.apron.z, F.p.rot);          // the lot's +z: out of the bay, away from the tower
}
function padSpot(L){
  var P = (L && L.pad) || BASE_PAD, yaw = num(P.yaw, BASE_PAD.yaw);
  return pose(num(P.x, BASE_PAD.x), num(P.y, 0), num(P.z, BASE_PAD.z), yaw);
}

/* ---------- the hand-off through a door ---------- */
var ARMED = null;
function arm(door){ ARMED = door && typeof door === "object" ? door : null; return ARMED; }
function armed(){ return ARMED; }
function liftable(ride){
  if(!ride || typeof ride !== "object") return false;
  var b = ride.b && typeof ride.b === "object" ? ride.b : ride;
  if(b.boat || b.heli || ride.boat || ride.heli) return false;
  var k = String(ride.kind != null ? ride.kind : b.kind != null ? b.kind : "bike");
  return !NO_LIFT.test(k);
}
function carries(from, to, ride, door){
  var d = door || ARMED;
  return !!(d && d.kind === "carlift" && liftable(ride));
}

/* ---------- calling a basement-homed vehicle: the carpark's duck type ---------- */
var STORED = [];
function onStored(fn){ if(typeof fn === "function") STORED.push(fn); return function(){ STORED = STORED.filter(function(f){ return f !== fn; }); }; }
function siteBay(site){
  var a = site.pad, b = {i: 0, level: 0, x: a.x, y: 0, z: a.z, yaw: a.yaw, lx: 0, lz: 0, aisle: 0, side: 1, site: site.id, lift: true};
  Object.defineProperty(b, "_site", {value: site, enumerable: false});
  return b;
}
function line(a, b, n){ var out = []; for(var i = 0; i <= n; i++){ var f = i/n; out.push({x: a.x + (b.x - a.x)*f, y: 0, z: a.z + (b.z - a.z)*f}); } return out; }
var CP = {
  find: function(){ return null; },
  layout: function(site){ return {levels: 1, W: site ? site.w : PAD0.w, D: site ? site.d : PAD0.d, base: 0, H: 0}; },
  bays: function(site){ return site && site.pad ? [siteBay(site)] : []; },
  bayFor: function(site){ return site && site.pad ? siteBay(site) : null; },
  assign: function(site, keys){ var o = {}; (keys || []).slice(0, 1).forEach(function(k){ o[String(k)] = 0; }); return o; },
  // from the pad, out of the door, to the end of the apron (all at y 0: the rise is played before, rise())
  exitPath: function(bay, site){
    site = site || (bay && bay._site); if(!site) return [];
    var a = line(site.pad, site.door, 3), b = line(site.door, site.apron, 3).slice(1);
    return a.concat(b);
  },
  entryPath: function(bay, site){ return CP.exitPath(bay, site).reverse(); },
  entrance: function(site, G){
    if(!site) return null;
    var a = site.apron, out = {x: a.x, z: a.z, yaw: site.rot, door: {x: site.door.x, z: site.door.z}, road: null}, N = HQV.hqnav;
    if(G && N && N.snap){ try { var s = N.snap(G, a.x, a.z); if(s){ out.road = s; out.x = s.x; out.z = s.z; } } catch(e){} }
    return out;
  },
  stored: function(site, bay, o){
    var ev = {site: site, bay: bay, o: o || {}, uid: site && site.uid};
    STORED.slice().forEach(function(fn){ try { fn(ev); } catch(e){} });
    return true;
  },
  groundAt: function(){ return 0; },
  blockedAt: function(){ return false; },
  camHit: function(){ return null; },
  toLocal: function(site, x, z){ return {x: x - site.pad.x, z: z - site.pad.z}; },
  levelY: function(){ return 0; },
  build: function(){ return null; }                      // the bay is drawn by mesh(), on your lot
};
function liftSite(C, uid, E){
  var F = lotOf(C, E); if(!F) return null;
  var Q = lotPoints(F), r = F.p.rot;
  var site = {id: "carlift:" + String(uid == null ? "me" : uid), kind: "carlift", uid: uid, rot: r, w: F.P.w, d: F.P.d,
              pad: {x: Q.pad.x, z: Q.pad.z, yaw: r}, door: Q.door, apron: Q.apron};
  return {cp: CP, site: site};
}
// the vehicle's climb out of B1 before it drives off (or, sent home, its sink back down)
function rise(k){ return create({dir: "up", k: k, approach: 0}); }
function sink(k){ return create({dir: "down", k: k, approach: 0}); }

/* ---------- the mesh ---------- */
function chevronTex(THREE, accent){
  if(typeof document === "undefined" || !document.createElement) return null;
  try {
    var cv = document.createElement("canvas"); cv.width = 128; cv.height = 128; var g = cv.getContext("2d"); if(!g) return null;
    g.fillStyle = "#1d2228"; g.fillRect(0, 0, 128, 128);
    g.fillStyle = accent; g.strokeStyle = accent; g.lineWidth = 9;
    for(var y = -32; y < 160; y += 32){ g.beginPath(); g.moveTo(14, y + 24); g.lineTo(64, y); g.lineTo(114, y + 24); g.stroke(); }
    g.fillStyle = "rgba(255,255,255,.05)"; for(var i = 0; i < 128; i += 8) g.fillRect(i, 0, 1, 128);
    var t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace || t.colorSpace; return t;
  } catch(e){ return null; }
}
function textTex(THREE, w, h, draw){
  if(typeof document === "undefined" || !document.createElement) return null;
  try {
    var cv = document.createElement("canvas"); cv.width = w; cv.height = h; var g = cv.getContext("2d"); if(!g) return null;
    var t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace || t.colorSpace;
    return {t: t, redraw: function(a){ draw(g, a); t.needsUpdate = true; }};
  } catch(e){ return null; }
}
function hexCss(n){ n = (+n | 0) & 0xffffff; return "#" + ("000000" + n.toString(16)).slice(-6); }
function screenDraw(g, a){
  var W = g.canvas.width, H = g.canvas.height, up = a.floor === "G";
  g.fillStyle = "#06090d"; g.fillRect(0, 0, W, H);
  g.font = "bold 44px system-ui, sans-serif"; g.textBaseline = "middle"; g.textAlign = "center";
  g.fillStyle = up ? "#57f2a0" : "#3a4a44"; g.fillText("G ▲", W*0.27, H/2);
  g.fillStyle = up ? "#3a4a44" : "#ffb347"; g.fillText("B1 ▼", W*0.73, H/2);
  g.fillStyle = a.moving ? "#ffd27a" : "#2a3138"; g.fillRect(W*0.5 - 2, 10, 4, H - 20);
}
function mesh(ctx, opts){
  opts = opts || {};
  var THREE = (ctx && ctx.THREE) || (ctx && ctx.Group ? ctx : null) || window.THREE;
  if(!THREE) return null;
  var P = padLocal(), w = num(opts.w, P.w), d = num(opts.d, P.d), h = num(opts.h, 3.2), depth = num(opts.depth, DEPTH);
  var basement = opts.level === "B1", accent = opts.accent != null ? (+opts.accent | 0) : 0xffb347;
  var g = new THREE.Group(); g.name = "carlift:" + (basement ? "B1" : "G");
  var stat = new THREE.Group(); g.add(stat);
  var boxG = new THREE.BoxGeometry(1, 1, 1);
  function box(m, x, y, z, sx, sy, sz, parent){ var o = new THREE.Mesh(boxG, m); o.position.set(x, y, z); o.scale.set(sx, sy, sz); o.receiveShadow = true; (parent || stat).add(o); return o; }
  var M = {
    frame: new THREE.MeshStandardMaterial({color: 0x2b3138, roughness: 0.35, metalness: 0.85}),
    pit: new THREE.MeshStandardMaterial({color: 0x101317, roughness: 0.95}),
    deck: new THREE.MeshStandardMaterial({color: 0x3a4048, roughness: 0.4, metalness: 0.7}),
    glass: new THREE.MeshStandardMaterial({color: 0x9fd6ff, roughness: 0.05, metalness: 0.3, transparent: true, opacity: 0.22, depthWrite: false}),
    trim: new THREE.MeshStandardMaterial({color: accent, emissive: accent, emissiveIntensity: 0.8, roughness: 0.5}),
    door: new THREE.MeshStandardMaterial({color: 0xc7ced6, roughness: 0.25, metalness: 0.9}),
    chase: new THREE.MeshBasicMaterial({color: 0xffffff})
  };
  M.deck.userData = {};
  var hw = w/2, hd = d/2, post = 0.18;
  // the frame: four posts, the header over the door, the back and sides in glass (left unmerged: transparent)
  [[-hw, -hd], [hw, -hd], [-hw, hd], [hw, hd]].forEach(function(c){ box(M.frame, c[0], h/2, c[1], post, h, post); });
  box(M.frame, 0, h + 0.1, 0, w + 0.3, 0.2, d + 0.3);                 // the roof slab
  box(M.trim, 0, h - 0.05, hd + 0.16, w + 0.3, 0.08, 0.04);           // the accent line over the door
  box(M.glass, 0, h/2, -hd, w - post, h - 0.1, 0.05);
  box(M.glass, -hw, h/2, 0, 0.05, h - 0.1, d - post);
  box(M.glass, hw, h/2, 0, 0.05, h - 0.1, d - post);
  // the shaft (pit) below the street bay: its walls run down `depth`; in B1 the shaft goes up instead
  var sy = basement ? h + depth/2 : -depth/2;
  box(M.pit, 0, sy, -hd + 0.05, w, depth, 0.1); box(M.pit, -hw + 0.05, sy, 0, 0.1, depth, d); box(M.pit, hw - 0.05, sy, 0, 0.1, depth, d);
  box(M.pit, 0, basement ? h + depth : -depth, 0, w, 0.1, d);
  // the platform: a deck with chevrons and glowing edges (it moves: never merged)
  var platform = new THREE.Group(); platform.userData.anim = 1; g.add(platform);
  var deck = box(M.deck, 0, -0.06, 0, w - 0.25, 0.12, d - 0.25, platform); deck.castShadow = true;
  var tex = chevronTex(THREE, hexCss(accent));
  var chevM = tex ? new THREE.MeshStandardMaterial({map: tex, roughness: 0.55, metalness: 0.2}) : new THREE.MeshStandardMaterial({color: 0x23282e, roughness: 0.6});
  var chev = new THREE.Mesh(new THREE.PlaneGeometry(w - 0.9, d - 0.9), chevM); chev.rotation.x = -Math.PI/2; chev.position.y = 0.005; platform.add(chev);
  box(M.trim, 0, 0.01, -hd + 0.2, w - 0.4, 0.03, 0.06, platform); box(M.trim, 0, 0.01, hd - 0.2, w - 0.4, 0.03, 0.06, platform);
  box(M.trim, -hw + 0.2, 0.01, 0, 0.06, 0.03, d - 0.4, platform); box(M.trim, hw - 0.2, 0.01, 0, 0.06, 0.03, d - 0.4, platform);
  // the light chase: one InstancedMesh of small lamps up the four posts and along the header
  var N = 0, spots = [];
  [[-hw, -hd], [hw, -hd], [-hw, hd], [hw, hd]].forEach(function(c){ for(var k = 0; k < 6; k++) spots.push([c[0], 0.3 + k*(h - 0.5)/5, c[1] + (c[1] > 0 ? 0.11 : -0.11)]); });
  for(var i = 0; i < 9; i++) spots.push([-hw + 0.4 + i*(w - 0.8)/8, h - 0.22, hd + 0.2]);
  N = spots.length;
  var chase = new THREE.InstancedMesh(new THREE.BoxGeometry(0.09, 0.09, 0.09), M.chase, N); chase.userData.anim = 1;
  var m4 = new THREE.Matrix4(), col = new THREE.Color();
  spots.forEach(function(s, j){ m4.makeTranslation(s[0], s[1], s[2]); chase.setMatrixAt(j, m4); col.setHex(0x2a2f36); chase.setColorAt(j, col); });
  g.add(chase);
  // the sliding doors (they open sideways into the walls)
  var dw = w/2 - post, doorL = box(M.door, -dw/2, h/2 - 0.1, hd + 0.08, dw, h - 0.3, 0.06, g), doorR = box(M.door, dw/2, h/2 - 0.1, hd + 0.08, dw, h - 0.3, 0.06, g);
  doorL.userData.anim = 1; doorR.userData.anim = 1;
  var doors = {L: doorL, R: doorR, w: dw};
  // the indicator screen beside the door and the canopy sign
  var scr = textTex(THREE, 256, 96, screenDraw), screenM = scr ? new THREE.MeshBasicMaterial({map: scr.t}) : new THREE.MeshBasicMaterial({color: 0x0b1a12});
  var screen = new THREE.Mesh(new THREE.PlaneGeometry(1.3, 0.5), screenM); screen.position.set(hw + 0.55, 1.9, hd + 0.12); screen.userData.anim = 1; g.add(screen);
  box(M.frame, hw + 0.55, 1.9, hd + 0.08, 1.42, 0.62, 0.05);
  var label = String(opts.label || "CAR LIFT");
  var sign = textTex(THREE, 512, 96, function(gx){
    var W = gx.canvas.width, H = gx.canvas.height; gx.fillStyle = "#0b0e12"; gx.fillRect(0, 0, W, H);
    gx.font = "bold 58px system-ui, sans-serif"; gx.textAlign = "center"; gx.textBaseline = "middle";
    gx.fillStyle = hexCss(accent); gx.fillText(label, W/2, H/2 + 2);
  });
  if(sign) sign.redraw({});
  var signM = sign ? new THREE.MeshBasicMaterial({map: sign.t}) : new THREE.MeshStandardMaterial({color: 0x0b0e12, emissive: accent, emissiveIntensity: 0.4});
  var signMesh = new THREE.Mesh(new THREE.PlaneGeometry(Math.min(w - 0.4, 4.2), 0.78), signM); signMesh.position.set(0, h + 0.62, hd + 0.2); g.add(signMesh);
  box(M.frame, 0, h + 0.62, hd + 0.15, Math.min(w - 0.4, 4.2) + 0.16, 0.9, 0.06);
  if(HQV.hqMerge && HQV.hqMerge.mergeStatic){ try { HQV.hqMerge.mergeStatic(THREE, stat); } catch(e){} }

  var lastFloor = null, lastMoving = null, night = false;
  function drawScreen(floor, moving){
    if(floor === lastFloor && moving === lastMoving) return;
    lastFloor = floor; lastMoving = moving; if(scr) scr.redraw({floor: floor, moving: moving});
  }
  drawScreen(basement ? "B1" : "G", false);
  // state: a create() state (or null: at rest, here); t: the clock (s), k: the motion scale (Calm 0)
  function update(state, t, k){
    var y = 0, open = 1, floor = basement ? "B1" : "G", moving = false;
    if(state){
      y = basement ? state.y + state.depth : state.y;      // in B1 the platform comes down from (or goes up to) the street
      open = state.doors; moving = state.phase === "moving"; floor = state.floor;
      // only the doors of the floor the platform is at open
      var here = basement ? state.floor === "B1" : state.floor === "G"; if(!here) open = 0;
    }
    platform.position.y = y;
    var slide = clamp(open, 0, 1)*doors.w*0.92;
    doorL.position.x = -doors.w/2 - slide; doorR.position.x = doors.w/2 + slide;
    drawScreen(floor, moving);
    // the chase: a band of light runs round the frame while the lift moves (steady when Calm or at rest)
    k = num(k, 1); t = num(t, 0);
    var head = moving && k > 0 ? (t*14*k) % N : -1;
    for(var j = 0; j < N; j++){
      var on = head < 0 ? (night ? 0.55 : 0.35) : Math.max(0.12, 1 - ((head - j + N) % N)/5);
      col.setHex(accent).multiplyScalar(on); chase.setColorAt(j, col);
    }
    if(chase.instanceColor) chase.instanceColor.needsUpdate = true;
  }
  function setNight(on){ night = !!on; M.trim.emissiveIntensity = night ? 1.6 : 0.8; update(null, 0, 0); }
  function drawCalls(){ var n = 0; g.traverse(function(o){ if(o.isMesh && o.visible) n++; }); return n; }
  function dispose(){
    g.traverse(function(o){ if(o.geometry && o.geometry !== boxG) o.geometry.dispose(); });
    boxG.dispose(); Object.keys(M).forEach(function(k){ M[k].dispose(); }); chevM.dispose(); screenM.dispose(); signM.dispose();
    if(tex) tex.dispose(); if(scr) scr.t.dispose(); if(sign) sign.t.dispose();
  }
  update(null, 0, 0);
  return {g: g, platform: platform, doors: doors, screen: screen, chase: chase, update: update, setNight: setNight, drawCalls: drawCalls, dispose: dispose,
          size: {w: w, d: d, h: h, depth: depth}};
}

HQV.hqCarLift = {create: create, step: step, durations: durations, total: total, ease: ease,
                 padLocal: padLocal, streetSpot: streetSpot, padSpot: padSpot, lotOf: lotOf,
                 carries: carries, liftable: liftable, arm: arm, armed: armed,
                 liftSite: liftSite, onStored: onStored, rise: rise, sink: sink, cp: CP,
                 mesh: mesh, DUR: DUR, CALM_TOTAL: CALM_TOTAL, DEPTH: DEPTH, BASE_PAD: BASE_PAD};
})();
