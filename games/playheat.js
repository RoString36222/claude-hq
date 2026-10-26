/* Claude HQ: City play feature "heat" (HQ 3.22): the police, kept light-hearted. Registers with HQV.cityPlay
 * (games/cityplay.js); nothing here goes to a server and nobody gets hurt: being caught is a "Busted" fade.
 *
 * Heat is 0..5 stars (a fraction underneath: knocking props adds a little at a time), shown in ctx.hud's top
 * centre row "heat" and announced (ctx.api.announce) when the stars change. It is raised by
 *   your own blasts (a "blast" with mine: someone else's never counts) near people or traffic   +1 (+2 for a crowd or a police car)
 *   a tank shot ("shot")                                                                       +0.5 (at least one star; 3 s apart)
 *   ramming a person or a car (a "ram" over RAM_V m/s, a car told by the traffic near the point,
 *     or a "ram" {what: "person" | "car"} from the street feature)                             +1
 *   knocking a prop ("ram" {what: "prop"})                                                     +0.25
 *   running a red light (tsim.lightAt, when the traffic has lights; or a "red" event), only when
 *     a police car sees it (within WITNESS m) or the junction has a camera (1 in 4, seeded)    +1
 *   speeding hugely (over SPEED_V) in the centre with a police car close                       +1 (15 s apart)
 * Decay: while no police car (or the helicopter) has a line of sight to you (ctx.blocked sampled along the line, within
 * VIEW + 12 m a star), the stars drop one every lose(stars) s; hidden (in the metro, or inside the carpark) three times
 * as fast. The search zone (zone(): the last place they saw you, a radius growing with the stars) is where the unseen
 * cars look. At 0 by decay: "You lost them", a small rep reward (ctx.store "rep", shared with the jobs feature).
 * Response: pursuit cars (one per star) come out of the police station(s) and off-screen road nodes (a seeded pick),
 * drive the road graph (games/hqnav.js) toward you, then, close and seeing you, steer straight for you, each to its own
 * flank (behind, either side, ahead: boxing you in); faster with more stars. At 4+ a roadblock (two cars across the
 * road ahead of your heading), at 5 a helicopter with a searchlight cone. The cars are solid (blocked()).
 * Busted: a car within BUST_R m while you are under BUST_V m/s for BUST_S s, or one reaching you on foot: the screen
 * fades, you stand at the police station's door (ctx.c.teleport), heat 0, rep minus BUST_REP (never below 0).
 * Calm (ctx.calm()): no siren, the lightbars steady. Menus open (or the tab hidden): nothing moves, nothing decays.
 * Draws: the cars' bodies and their lightbars (two InstancedMeshes), the helicopter and its rotor, the searchlight.
 * Emits "heat" {stars, why} on every change of stars, "busted" {rep, penalty}, "escaped" {rep, reward}.
 * The feature: stars(), heat(), add(n, why), clear(), chasers() -> [{x, z, yaw, kind}], zone() -> {x, z, r} | null,
 *   heli() -> {x, y, z} | null, busting() (for tools and the Arena heat-tag mode), unseen() -> s since police last saw you.
 * The Arena's Cops & robber (games/playarena.js) drives it with tag({cops: [{x, z}]}) every frame, tag(null) to end:
 *   while on, those players are the police (they see you along the same line of sight, they witness, they bust you
 *   within BUST_R m while you are under BUST_V m/s for BUST_S s, on foot or not), no pursuit cars come (any out leave),
 *   the stars never decay and "You lost them" pays nothing; a bust then fades and takes you to the station with no rep
 *   lost, and "busted" carries {tag: true}. Their positions come from presence the page already has. */
(function(){
"use strict";
var HQV = window.HQV = window.HQV || {};

var MAX_CARS = 10;               // pursuit cars and roadblock cars together
var RAM_V = 8;                   // m/s: a ram that counts
var SPEED_V = 26;                // m/s: hugely speeding (about 94 km/h)
var CENTRE_R = 350;              // m: the centre, round the road graph's middle
var WITNESS = 70;                // m: a police car sees what you do
var VIEW = 60;                   // m: a car's sight at no stars (+12 a star)
var CHASE_R = 50;                // m: closer than this, seeing you, a car drives straight for you
var BUST_R = 4, BUST_V = 2, BUST_S = 3, FOOT_R = 3.2, FOOT_S = 0.5;
var BUST_REP = 5;
var CAR_HW = 0.95, CAR_HL = 2.3; // half width, half length (m)
var HELI_Y = 42;                 // m over the ground
var FADE_IN = 0.5, FADE_HOLD = 1.3, FADE_OUT = 0.6;

function num(v, d){ return typeof v === "number" && isFinite(v) ? v : d; }
function clamp(v, a, b){ return v < a ? a : v > b ? b : v; }
function wrapA(a){ a = (a + Math.PI) % (2*Math.PI); if(a < 0) a += 2*Math.PI; return a - Math.PI; }
function lose(stars){ return 12 + 6*Math.max(1, stars | 0); }          // s unseen for a star to go
function vmaxOf(stars){ return 12 + 2*clamp(stars | 0, 1, 5); }      // m/s
function want(stars){ return clamp(stars | 0, 0, 5); }               // pursuit cars

// a point s m along a route's polyline (pts [x, z, ...], cum) -> [x, z, yaw]
function along(R, s, out){
  var P = R.pts, C = R.cum, n = C.length;
  out = out || [0, 0, 0];
  if(n < 2){ out[0] = P[0] || 0; out[1] = P[1] || 0; return out; }
  s = clamp(s, 0, C[n - 1]);
  var lo = 0, hi = n - 1;
  while(hi - lo > 1){ var m = (lo + hi) >> 1; if(C[m] <= s) lo = m; else hi = m; }
  var L = C[hi] - C[lo], t = L > 0 ? (s - C[lo])/L : 0, dx = P[2*hi] - P[2*lo], dz = P[2*hi + 1] - P[2*lo + 1];
  out[0] = P[2*lo] + dx*t; out[1] = P[2*lo + 1] + dz*t; out[2] = Math.atan2(dx, dz);
  return out;
}
// a packed edge's heading at s m from its node a
function edgeYaw(e, s){
  var p = e && e.pts; if(!p || p.length < 6) return 0;
  var acc = 0;
  for(var i = 3; i + 2 < p.length; i += 3){
    var dx = (p[i] - p[i - 3])/100, dz = (p[i + 2] - p[i - 1])/100, l = Math.hypot(dx, dz);
    if(acc + l >= s || i + 3 >= p.length) return Math.atan2(dx, dz);
    acc += l;
  }
  return 0;
}
function inPoly(poly, x, z){
  var inside = false;
  for(var i = 0, j = poly.length - 1; i < poly.length; j = i++){
    var xi = poly[i][0]/100, zi = poly[i][1]/100, xj = poly[j][0]/100, zj = poly[j][1]/100;
    if((zi > z) !== (zj > z) && x < (xj - xi)*(z - zi)/(zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/* ---------- drawing ---------- */
function makeView(THREE, scene){
  var g = new THREE.Group(); g.name = "playheat";
  var mtx = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1), e = new THREE.Euler(0, 0, 0, "YXZ"), col = new THREE.Color();
  function merge(parts){
    var P = [], N = [], C = [];
    parts.forEach(function(pt){
      var geo = pt[0].index ? pt[0].toNonIndexed() : pt[0], k = new THREE.Color(pt[1]);
      e.set(pt[5] || 0, pt[6] || 0, pt[7] || 0); q.setFromEuler(e); p.set(pt[2] || 0, pt[3] || 0, pt[4] || 0);
      mtx.compose(p, q, one); geo.applyMatrix4(mtx);
      var a = geo.attributes.position.array, n = geo.attributes.normal.array;
      for(var i = 0; i < a.length; i++){ P.push(a[i]); N.push(n[i]); }
      for(i = 0; i < a.length/3; i++) C.push(k.r, k.g, k.b);
      if(geo !== pt[0]) geo.dispose();
      pt[0].dispose();
    });
    var out = new THREE.BufferGeometry();
    out.setAttribute("position", new THREE.Float32BufferAttribute(P, 3));
    out.setAttribute("normal", new THREE.Float32BufferAttribute(N, 3));
    out.setAttribute("color", new THREE.Float32BufferAttribute(C, 3));
    out.computeBoundingSphere();
    return out;
  }
  function box(w, h, d){ return new THREE.BoxGeometry(w, h, d); }
  function wheel(){ return new THREE.CylinderGeometry(0.34, 0.34, 0.24, 12); }
  // a patrol car: navy body, white doors, a dark cabin, the lightbar's base (its lamps are their own instances)
  var car = [[box(1.86, 0.55, 4.6), 0x1d2c4a, 0, 0.6, 0], [box(1.88, 0.32, 2.4), 0xf4f4f0, 0, 0.62, 0.1],
             [box(1.66, 0.55, 2.3), 0x28323e, 0, 1.15, -0.2], [box(1.6, 0.06, 2.1), 0x1d2c4a, 0, 1.45, -0.2],
             [box(1.2, 0.08, 0.3), 0x30343a, 0, 1.5, -0.2],
             [box(0.32, 0.12, 0.04), 0xfff4d0, 0.6, 0.7, 2.31], [box(0.32, 0.12, 0.04), 0xfff4d0, -0.6, 0.7, 2.31],
             [box(0.3, 0.12, 0.04), 0xc0202a, 0.62, 0.72, -2.31], [box(0.3, 0.12, 0.04), 0xc0202a, -0.62, 0.72, -2.31]];
  [-0.82, 0.82].forEach(function(x){ [-1.4, 1.4].forEach(function(z){ car.push([wheel(), 0x1c1d21, x, 0.34, z, 0, 0, Math.PI/2]); }); });
  var bodyM = new THREE.MeshStandardMaterial({vertexColors: true, roughness: 0.5, metalness: 0.2});
  var lampM = new THREE.MeshBasicMaterial({toneMapped: false});
  var body = new THREE.InstancedMesh(merge(car), bodyM, MAX_CARS);
  var lamps = new THREE.InstancedMesh(new THREE.BoxGeometry(0.5, 0.14, 0.26), lampM, MAX_CARS*2);
  [body, lamps].forEach(function(m, i){ m.count = 0; m.frustumCulled = false; m.name = i ? "playheat-lamps" : "playheat-cars"; m.instanceMatrix.setUsage(THREE.DynamicDrawUsage); g.add(m); });
  body.castShadow = true;
  // the helicopter: a cabin, a tail boom and fin, skids; its rotor turns on its own
  var heliM = new THREE.MeshStandardMaterial({vertexColors: true, roughness: 0.5, metalness: 0.25});
  var heli = new THREE.Mesh(merge([[box(1.9, 1.7, 3.4), 0x1d2c4a, 0, 0, 0], [box(1.7, 0.9, 1.4), 0x28323e, 0, 0.2, 1.4],
                                   [box(0.36, 0.36, 4.2), 0x1d2c4a, 0, 0.3, -3.6], [box(0.12, 1.1, 0.8), 0xf4f4f0, 0, 0.8, -5.5],
                                   [box(0.1, 0.1, 3.4), 0x30343a, 0.8, -1.15, 0], [box(0.1, 0.1, 3.4), 0x30343a, -0.8, -1.15, 0]]), heliM);
  heli.name = "playheat-heli"; heli.visible = false; g.add(heli);
  var rotor = new THREE.Mesh(new THREE.BoxGeometry(9, 0.06, 0.3), new THREE.MeshStandardMaterial({color: 0x202428, roughness: 0.7}));
  rotor.position.set(0, 1.05, 0); heli.add(rotor);
  // the searchlight: a cone from the helicopter down to where it looks (apex up, unit height, scaled)
  var coneG = new THREE.ConeGeometry(4, 1, 20, 1, true); coneG.translate(0, 0.5, 0);   // its base (r 4) at y 0 on the ground, its apex at y 1 (the helicopter)
  var coneM = new THREE.MeshBasicMaterial({color: 0xfff2c0, transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending});
  var cone = new THREE.Mesh(coneG, coneM); cone.name = "playheat-searchlight"; cone.visible = false; cone.renderOrder = 6; g.add(cone);
  if(scene) scene.add(g);
  var up = new THREE.Vector3(0, 1, 0), dir = new THREE.Vector3();
  function put(m, i, x, y, z, yaw, hex){
    e.set(0, yaw, 0); q.setFromEuler(e); p.set(x, y, z); mtx.compose(p, q, one); m.setMatrixAt(i, mtx);
    if(hex != null){ col.setHex(hex); m.setColorAt(i, col); }
  }
  return {
    group: g, body: body, lamps: lamps, heli: heli, cone: cone,
    draw: function(list, flash, steady, gy){
      var n = Math.min(MAX_CARS, list.length);
      for(var i = 0; i < n; i++){
        var c = list[i], y = gy(c.x, c.z), cs = Math.cos(c.yaw), sn = Math.sin(c.yaw);
        put(body, i, c.x, y, c.z, c.yaw, null);
        // model-local +x is left: the left lamp red, the right blue; blinking in turn (Calm: both steady)
        var lx = 0.32, lz = -0.2;
        var redOn = steady || ((flash + i) & 1) === 0, blueOn = steady || ((flash + i) & 1) === 1;
        put(lamps, 2*i, c.x + lx*cs + lz*sn, y + 1.6, c.z - lx*sn + lz*cs, c.yaw, redOn ? 0xff2a2a : 0x3a0c0c);
        put(lamps, 2*i + 1, c.x - lx*cs + lz*sn, y + 1.6, c.z + lx*sn + lz*cs, c.yaw, blueOn ? 0x3a6bff : 0x0c1638);
      }
      body.count = n; lamps.count = 2*n;
      body.instanceMatrix.needsUpdate = true; lamps.instanceMatrix.needsUpdate = true;
      if(lamps.instanceColor) lamps.instanceColor.needsUpdate = true;
    },
    drawHeli: function(H, look, spin, night){
      if(!H){ heli.visible = false; cone.visible = false; return; }
      heli.visible = true; heli.position.set(H.x, H.y, H.z); heli.rotation.set(0, H.yaw, 0);
      rotor.rotation.y = spin;
      if(!look){ cone.visible = false; return; }
      dir.set(H.x - look.x, H.y - look.y, H.z - look.z);
      var L = dir.length(); if(L < 1){ cone.visible = false; return; }
      dir.multiplyScalar(1/L);
      cone.visible = true; cone.position.set(look.x, look.y, look.z);
      cone.quaternion.setFromUnitVectors(up, dir); cone.scale.set(1, L, 1);
      coneM.opacity = night ? 0.26 : 0.1;
    },
    dispose: function(){
      if(scene) scene.remove(g);
      g.traverse(function(o){ if(o.geometry) o.geometry.dispose(); if(o.material) o.material.dispose(); });
    }
  };
}

/* ---------- the feature ---------- */
function create(ctx){
  ctx = ctx || {};
  var W = ctx.W, T = ctx.tsim || null, NAV = HQV.hqnav, R32 = ctx.mulberry32 || HQV.cityPlay.mulberry32, H32 = ctx.hashStr || HQV.cityPlay.hashStr;
  var seed = num(ctx.seed, 1) >>> 0, tier = T && T.tier ? T.tier : 5;
  var G = null;
  try { G = NAV && W && W.nodes && W.edges ? NAV.graph(W, tier) : null; } catch(e){ G = null; }
  var view = null;
  try { view = ctx.THREE && ctx.scene ? makeView(ctx.THREE, ctx.scene) : null; } catch(e){ view = null; }
  // the police stations' doors (games/hqnav.js doorOf), the centre, the carpark
  var stations = [];
  ((W && W.sites) || []).forEach(function(s){
    if(!s || s.kind !== "police" || (s.tier != null && (s.tier | 0) > tier)) return;
    var d = NAV && NAV.doorOf ? NAV.doorOf(s) : {x: s.x/100, z: s.z/100};
    stations.push({id: s.id, x: d.x, z: d.z, cx: s.x/100, cz: s.z/100});
  });
  stations.sort(function(a, b){ return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; });
  var centre = {x: 0, z: 0};
  if(G && G.NX && G.NX.length){
    var sx = 0, sz = 0, sn = 0;
    for(var ni = 0; ni < G.NX.length; ni++) if(G.deg[ni]){ sx += G.NX[ni]; sz += G.NZ[ni]; sn++; }
    if(sn){ centre.x = sx/sn; centre.z = sz/sn; }
  }
  var carpark = null;
  try { carpark = HQV.hqCarpark && HQV.hqCarpark.find && W ? HQV.hqCarpark.find(W) : null; } catch(e){ carpark = null; }

  var S = {
    h: 0, stars: 0, peak: 0, t: 0, ms: 0, local: 0,
    seenT: 0, seenAt: null, seen: false, losT: 0,
    me: {x: 0, y: 0, z: 0, yaw: 0}, speed: 0, ride: null, hidden: false,
    cars: [], spawnN: 0, spawnT: 0, nextId: 1,
    block: null, blockT: 0, heli: null, spin: 0,
    bustT: 0, footT: 0, busted: null, tag: null,
    cool: {}, red: null, redT: -99, msgT: 0, dead: false
  };
  var sirenPool = null, heliPool = null, fadeEl = null;

  function E(){ return (ctx.c && ctx.c.E) || HQV.engine || null; }
  function calm(){ try { return !!(ctx.calm && ctx.calm()); } catch(e){ return false; } }
  function announce(t){ try { if(ctx.api && ctx.api.announce) ctx.api.announce(t); } catch(e){} }
  function rep(){ return Math.max(0, num(+(ctx.store && ctx.store.get ? ctx.store.get("rep", 0) : 0), 0)); }
  function setRep(v){ if(ctx.store && ctx.store.set) ctx.store.set("rep", Math.max(0, Math.round(v))); }
  function cooled(k, s){ if(S.cool[k] != null && S.t - S.cool[k] < s) return false; S.cool[k] = S.t; return true; }

  function hud(){
    if(!ctx.hud) return;
    if(S.stars <= 0){ ctx.hud.clear("heat"); return; }
    var t = "WANTED ";
    for(var i = 0; i < 5; i++) t += i < S.stars ? "★" : "☆";
    ctx.hud.set("heat", t, {colour: S.stars >= 4 ? "#ff8a80" : "#ffd040"});
  }
  function msg(t, secs){ if(ctx.hud){ ctx.hud.set("heat-msg", t, {colour: "#ffffff"}); S.msgT = S.t + (secs || 3); } }
  function setHeat(h, why){
    var was = S.stars;
    S.h = clamp(num(h, 0), 0, 5);
    S.stars = Math.min(5, Math.floor(S.h + 1e-9));
    if(S.stars > S.peak) S.peak = S.stars;
    if(S.stars !== was){
      hud();
      announce(S.stars ? "Wanted level " + S.stars + " of 5" + (S.stars > was && why ? ": " + why : "") : "Wanted level clear");
      ctx.emit && ctx.emit("heat", {stars: S.stars, why: why || null});
    }
    if(S.stars <= 0){ if(S.peak) S.lastPeak = S.peak; S.peak = 0; S.seenAt = null; leaveAll(); }
  }
  function add(n, why, at){
    n = num(+n, 0);
    if(S.dead || S.busted || n <= 0) return S.stars;
    // the police know where it happened: the search starts there, now (before the first frame: where you are then)
    S.seenT = S.t; S.seenAt = at ? {x: at.x, z: at.z} : S.known ? {x: S.me.x, z: S.me.z} : null;
    setHeat(Math.max(S.h + n, n >= 0.5 ? 1 : 0), why);
    return S.stars;
  }

  /* ---- who saw it ---- */
  function police(x, z, r){
    for(var i = 0; i < S.cars.length; i++){ var c = S.cars[i]; if(!c.leave && Math.hypot(c.x - x, c.z - z) <= r) return true; }
    var tr = S.traffic || [];
    for(i = 0; i < tr.length; i++){ var v = tr[i]; if(v && v.kind === "police" && Math.hypot(v.x - x, v.z - z) <= r) return true; }
    var tc = S.tag ? S.tag.cops : [];
    for(i = 0; i < tc.length; i++) if(Math.hypot(tc[i].x - x, tc[i].z - z) <= r) return true;   // [arena] a player cop
    return false;
  }
  function camera(sig, x, z){ var k = sig != null ? String(sig) : Math.round(x/20) + "," + Math.round(z/20); return H32(seed + ":cam:" + k) % 4 === 0; }
  function ranRed(x, z, sig){
    if(S.t - S.redT < 3) return;      // one crossing, however many say so
    S.redT = S.t;
    if(police(x, z, WITNESS) || camera(sig, x, z)) add(1, "ran a red light");
  }
  function trafficNear(x, z, r){
    var out = [];
    try { if(T && T.at) out = T.at(S.ms, {x: x, z: z}, r) || []; } catch(e){ out = []; }
    return out.filter(function(v){ return v && v.kind !== "tram"; });
  }
  function peopleNear(x, z, r){
    try { return ctx.nsim && ctx.nsim.at ? (ctx.nsim.at(S.local, {x: x, z: z}, r) || []).length : 0; } catch(e){ return 0; }
  }
  function carNear(x, z, r){
    for(var i = 0; i < S.cars.length; i++) if(Math.hypot(S.cars[i].x - x, S.cars[i].z - z) <= r) return true;
    return false;
  }

  function on(kind, d){
    d = d || {};
    if(S.dead || S.busted) return;
    var x = num(d.x, S.me.x), z = num(d.z, S.me.z), at = {x: x, z: z};
    if(kind === "blast"){
      if(!d.mine) return;                          // someone else's grenade is their business
      var nTr = trafficNear(x, z, 22), nP = peopleNear(x, z, 22), cop = carNear(x, z, 22) || nTr.some(function(v){ return v.kind === "police"; });
      var n = nTr.length + nP;
      if(cop || n >= 3) add(2, "a blast in the street", at); else if(n >= 1) add(1, "a blast in the street", at);
    } else if(kind === "shot"){
      if(cooled("shot", 3)) add(0.5, "a tank shot", at);
    } else if(kind === "ram"){
      var what = d.what;
      if(what === "prop"){ if(cooled("prop", 0.5)) add(0.25, "knocking things over", at); return; }
      if(what === "person"){ if(cooled("ramp", 2)) add(1, "running someone over", at); return; }
      if(num(d.speed, what === "car" ? RAM_V + 1 : 0) <= RAM_V) return;
      if(what === "car" || carNear(x, z, 6) || trafficNear(x, z, 6).length){ if(cooled("ramc", 2)) add(1, "ramming a car", at); }
    } else if(kind === "red"){
      ranRed(x, z, d.sig);
    }
  }

  /* ---- spawning ---- */
  function snapPt(x, z){ try { return G ? NAV.snap(G, x, z) : null; } catch(e){ return null; } }
  function spawnSpot(){
    var rng = R32((seed + 7919*(++S.spawnN)) >>> 0), me = S.me;
    // every other car from the nearest station (when it is within reach), the rest off-screen at a road node
    var st = null, bd = Infinity;
    stations.forEach(function(s){ var d = Math.hypot(s.x - me.x, s.z - me.z); if(d < bd){ bd = d; st = s; } });
    if(st && (S.spawnN & 1) && bd < 300) return {x: st.x, z: st.z};
    if(!G) return st ? {x: st.x, z: st.z} : {x: me.x - Math.sin(me.yaw)*150, z: me.z - Math.cos(me.yaw)*150};
    var fx = Math.sin(me.yaw), fz = Math.cos(me.yaw), behind = [], ring = [];
    for(var i = 0; i < G.NX.length; i++){
      if(!G.deg[i]) continue;
      var dx = G.NX[i] - me.x, dz = G.NZ[i] - me.z, d = Math.hypot(dx, dz);
      if(d < 100 || d > 220) continue;
      ring.push(i); if((dx*fx + dz*fz)/d < 0.3) behind.push(i);
    }
    var L = behind.length ? behind : ring;
    if(!L.length) return st ? {x: st.x, z: st.z} : {x: me.x - fx*150, z: me.z - fz*150};
    var k = L[Math.floor(rng()*L.length) % L.length];
    return {x: G.NX[k], z: G.NZ[k]};
  }
  function newCar(x, z, yaw, kind){
    var c = {id: S.nextId++, x: x, z: z, yaw: num(yaw, 0), v: 0, kind: kind || "car", R: null, s: 0, goal: null, planT: -99, stuck: 0, routeUntil: 0,
             flank: [0, 1, -1, 2][(S.nextId) % 4], born: S.t, leave: false, sees: false};
    S.cars.push(c); return c;
  }
  function spawn(){
    if(S.cars.length >= MAX_CARS) return;
    var p = spawnSpot(), sp = snapPt(p.x, p.z);
    var x = sp && sp.d < 40 ? sp.x : p.x, z = sp && sp.d < 40 ? sp.z : p.z;
    newCar(x, z, Math.atan2(S.me.x - x, S.me.z - z), "car");
  }
  function leaveAll(){
    S.cars.forEach(function(c){ if(c.kind === "block"){ c.gone = true; return; } c.leave = true; c.R = null; c.leaveT = S.t; });
    S.cars = S.cars.filter(function(c){ return !c.gone; });
    S.block = null;
    if(S.heli) S.heli.leave = true;
  }
  function roadblock(){
    if(!G || S.block || S.ride == null || S.speed < 5 || S.t < S.blockT || S.cars.length + 2 > MAX_CARS) return;
    var me = S.me, ax = me.x + Math.sin(me.yaw)*90, az = me.z + Math.cos(me.yaw)*90, sp = snapPt(ax, az);
    S.blockT = S.t + 4;                               // try again in a bit if nothing fits
    if(!sp || sp.d > 15 || Math.hypot(sp.x - me.x, sp.z - me.z) < 55) return;
    var ry = edgeYaw(W.edges[sp.ei], sp.s), px = -Math.cos(ry), pz = Math.sin(ry), across = ry + Math.PI/2, cars = [];
    for(var k = -1; k <= 1; k += 2){
      var x = sp.x + px*2.5*k, z = sp.z + pz*2.5*k;
      cars.push(newCar(x, z, across + (k > 0 ? Math.PI : 0), "block"));
    }
    S.block = {x: sp.x, z: sp.z, t: S.t, cars: cars};
  }

  /* ---- line of sight ---- */
  function clear(ax, az, bx, bz){
    var d = Math.hypot(bx - ax, bz - az), n = Math.floor((d - 6)/3);
    for(var i = 1; i <= n; i++){
      var t = (3 + 3*i)/d;
      if(t >= 1) break;
      try { if(ctx.blocked(ax + (bx - ax)*t, az + (bz - az)*t)) return false; } catch(e){ return false; }
    }
    return true;
  }
  function hiddenNow(){
    try { if(HQV.hqUnderground && HQV.hqUnderground.under && HQV.hqUnderground.under()) return true; } catch(e){}
    if(carpark && carpark.poly && carpark.poly.length && inPoly(carpark.poly, S.me.x, S.me.z)) return true;
    return false;
  }
  function look(){
    var me = S.me, r = VIEW + 12*S.stars, any = false;
    S.hidden = hiddenNow();
    S.cars.forEach(function(c){
      c.sees = false;
      if(c.leave || S.hidden) return;
      var d = Math.hypot(c.x - me.x, c.z - me.z);
      if(d <= r && clear(c.x, c.z, me.x, me.z)){ c.sees = true; any = true; }
    });
    if(S.heli && !S.heli.leave && !S.hidden && Math.hypot(S.heli.x - me.x, S.heli.z - me.z) < 160) any = true;
    if(S.tag && !S.hidden) S.tag.cops.forEach(function(p){ if(!any && Math.hypot(p.x - me.x, p.z - me.z) <= r && clear(p.x, p.z, me.x, me.z)) any = true; });
    S.seen = any;
    if(any){ S.seenT = S.t; S.seenAt = {x: me.x, z: me.z}; }
  }

  /* ---- driving ---- */
  function hitsOther(c, x, z){
    for(var i = 0; i < S.cars.length; i++){ var o = S.cars[i]; if(o !== c && Math.hypot(o.x - x, o.z - z) < 2.8) return true; }
    return false;
  }
  function plan(c, goal){
    c.goal = {x: goal.x, z: goal.z}; c.planT = S.t; c.s = 0;
    var R = null;
    try { R = G ? NAV.route(G, {x: c.x, z: c.z}, goal, "drive") : null; } catch(e){ R = null; }
    c.R = R && R.pts && R.pts.length >= 4 ? R : null;
  }
  function follow(c, dt, vmax){
    var R = c.R, len = R.cum[R.cum.length - 1], left = len - c.s;
    var vt = Math.min(vmax, Math.sqrt(2*5*Math.max(0, left)) + 1);
    c.v += clamp(vt - c.v, -9*dt, 4*dt);
    c.s = Math.min(len, c.s + c.v*dt);
    var p = along(R, c.s);
    c.x = p[0]; c.z = p[1];
    if(c.v > 0.5) c.yaw = c.yaw + wrapA(p[2] - c.yaw)*clamp(dt*8, 0, 1);
    if(left < 1){ c.R = null; c.v = 0; }
  }
  function steer(c, dt, vmax){
    var me = S.me, fx = Math.sin(me.yaw), fz = Math.cos(me.yaw), rx = -Math.cos(me.yaw), rz = Math.sin(me.yaw);
    var d = Math.hypot(me.x - c.x, me.z - c.z), lead = S.ride ? clamp(S.speed, 0, 30)*0.4 : 0;
    var tx = me.x + fx*lead, tz = me.z + fz*lead;
    if(d < 18){   // each to its flank: behind, the right, the left, ahead (boxed in)
      var f = c.flank;
      if(f === 0){ tx -= fx*4.5; tz -= fz*4.5; } else if(f === 2){ tx += fx*6.5; tz += fz*6.5; } else { tx += rx*3.4*f; tz += rz*3.4*f; }
    }
    var dT = Math.hypot(tx - c.x, tz - c.z), want = Math.atan2(tx - c.x, tz - c.z);
    c.yaw = wrapA(c.yaw + clamp(wrapA(want - c.yaw), -2.8*dt, 2.8*dt));
    var vt = Math.min(vmax, dT*1.4);
    c.v += clamp(vt - c.v, -10*dt, 5*dt);
    var step = c.v*dt;
    if(step < 1e-4) return;
    var tries = [0, 0.5, -0.5, 1.0, -1.0];
    for(var i = 0; i < tries.length; i++){
      var y = c.yaw + tries[i], nx = c.x + Math.sin(y)*step, nz = c.z + Math.cos(y)*step, bad = false;
      if(Math.hypot(nx - me.x, nz - me.z) < 2.6) bad = true;
      else if(hitsOther(c, nx, nz)) bad = true;
      else { try { bad = !!ctx.blocked(nx, nz); } catch(e){ bad = false; } }
      if(!bad){ c.x = nx; c.z = nz; if(i) c.yaw = wrapA(c.yaw + tries[i]*0.3); c.stuck = Math.max(0, c.stuck - dt); return; }
    }
    c.v *= 0.3;
    if(Math.hypot(me.x - c.x, me.z - c.z) > 4){ c.stuck += dt; if(c.stuck > 2){ c.stuck = 0; c.routeUntil = S.t + 3; c.R = null; } }
  }
  function searchPt(c){
    var z0 = S.seenAt || {x: S.me.x, z: S.me.z}, r = 30 + 25*S.stars, ep = Math.floor(S.t/8);
    var rng = R32((seed ^ Math.imul(c.id, 2654435761) ^ Math.imul(ep + 1, 40503)) >>> 0), a = rng()*2*Math.PI, d = Math.sqrt(rng())*r;
    return {x: z0.x + Math.sin(a)*d, z: z0.z + Math.cos(a)*d};
  }
  function drive(c, dt){
    var me = S.me, vmax = vmaxOf(S.stars), d = Math.hypot(me.x - c.x, me.z - c.z);
    if(c.kind === "block") return;
    if(c.leave){
      if(!c.R && c.planT < S.t - 6){ var away = {x: c.x + (c.x - me.x)*3, z: c.z + (c.z - me.z)*3}; plan(c, away); }
      if(c.R) follow(c, dt, 11); else c.v = 0;
      if(d > 160 || S.t - c.leaveT > 25) c.gone = true;
      return;
    }
    if(c.sees && d < CHASE_R && S.t >= c.routeUntil){ c.R = null; steer(c, dt, vmax); return; }
    // on the roads: to you while they still see you (or saw you a moment ago), else round the search zone
    var recent = S.t - S.seenT < 2, goal = recent ? {x: me.x, z: me.z} : searchPt(c);
    var moved = !c.goal || Math.hypot(goal.x - c.goal.x, goal.z - c.goal.z) > (recent ? 25 : 10);
    if(!c.R ? S.t - c.planT > 1 : (moved && S.t - c.planT > 3)) plan(c, goal);
    if(c.R) follow(c, dt, vmax); else c.v = 0;
  }

  function heliStep(dt){
    var me = S.me;
    if(S.stars >= 5 && !S.heli){
      var a = (seed % 628)/100;
      S.heli = {x: me.x + Math.sin(a)*220, z: me.z + Math.cos(a)*220, y: ctx.groundY(me.x, me.z) + HELI_Y, yaw: 0, ang: a, leave: false, t: S.t};
    }
    var H = S.heli; if(!H) return;
    if(S.stars < 5) H.leave = true;
    var tx, tz;
    if(H.leave){ tx = H.x + Math.sin(H.ang)*60; tz = H.z + Math.cos(H.ang)*60; if(Math.hypot(H.x - me.x, H.z - me.z) > 400){ S.heli = null; return; } }
    else { H.ang += dt*0.25; tx = me.x + Math.sin(H.ang)*24; tz = me.z + Math.cos(H.ang)*24; }
    var dx = tx - H.x, dz = tz - H.z, d = Math.hypot(dx, dz), v = Math.min(28, d*0.8)*dt;
    if(d > 0.01){ H.x += dx/d*Math.min(d, v); H.z += dz/d*Math.min(d, v); H.yaw = H.yaw + wrapA(Math.atan2(dx, dz) - H.yaw)*clamp(dt*2, 0, 1); }
    var gy = ctx.groundY(H.x, H.z) + HELI_Y; H.y += (gy - H.y)*clamp(dt, 0, 1);
    // the searchlight lags behind you, on the ground
    if(!H.spot) H.spot = {x: me.x, z: me.z};
    var k = clamp(dt*1.5, 0, 1); H.spot.x += (me.x - H.spot.x)*k; H.spot.z += (me.z - H.spot.z)*k;
  }

  /* ---- busted ---- */
  function fade(on){
    if(typeof document === "undefined" || !document.body) return;
    try {
      if(on && !fadeEl){
        fadeEl = document.createElement("div"); fadeEl.className = "hq-play-busted"; fadeEl.setAttribute("aria-hidden", "true");
        fadeEl.style.cssText = "position:fixed;inset:0;z-index:45;pointer-events:none;display:flex;align-items:center;justify-content:center;background:rgba(8,10,16,.92);color:#ffd040;font:800 48px system-ui,sans-serif;letter-spacing:.08em;opacity:0" + (calm() ? "" : ";transition:opacity .45s ease");
        fadeEl.textContent = "BUSTED";
        document.body.appendChild(fadeEl);
        void fadeEl.offsetWidth; fadeEl.style.opacity = "1";
      } else if(!on && fadeEl){
        fadeEl.style.opacity = "0";
        var el = fadeEl; fadeEl = null;
        setTimeout(function(){ if(el.parentNode) el.parentNode.removeChild(el); }, calm() ? 0 : 600);
      }
    } catch(e){}
  }
  function bust(){
    S.busted = {t: 0, moved: false};
    msg("Busted", 4);
    if(ctx.say) ctx.say("Busted! The police are taking you to the station.");
    fade(true);
  }
  function bustStep(dt){
    var B = S.busted; B.t += dt;
    if(!B.moved && B.t >= FADE_IN + FADE_HOLD*0.5){
      B.moved = true;
      var me = S.me, st = null, bd = Infinity;
      stations.forEach(function(s){ var d = Math.hypot(s.x - me.x, s.z - me.z); if(d < bd){ bd = d; st = s; } });
      if(st && ctx.c && ctx.c.teleport){ try { ctx.c.teleport(st.x, st.z, Math.atan2(st.x - st.cx, st.z - st.cz)); } catch(e){} S.me.x = st.x; S.me.z = st.z; }
      var tagged = !!S.tag, before = rep(), after = tagged ? before : Math.max(0, before - BUST_REP);   // a game costs no rep
      setRep(after);
      S.cars = []; S.block = null; S.heli = null; S.bustT = 0; S.footT = 0;
      setHeat(0, "busted");
      var ev = {rep: after, penalty: before - after, x: st ? st.x : null, z: st ? st.z : null};
      if(tagged) ev.tag = true;
      ctx.emit && ctx.emit("busted", ev);
    }
    if(B.t >= FADE_IN + FADE_HOLD){ fade(false); }
    if(B.t >= FADE_IN + FADE_HOLD + FADE_OUT){ S.busted = null; }
  }
  function escaped(){
    var reward = 1 + Math.min(5, S.lastPeak || 0), after = rep() + reward;
    setRep(after);
    msg("You lost them", 3);
    if(ctx.say) ctx.say("You lost them. City rep +" + reward + ".");
    ctx.emit && ctx.emit("escaped", {rep: after, reward: reward});
  }

  /* ---- red lights (tsim.lightAt, when the traffic has lights) ---- */
  function lights(){
    if(!T || typeof T.lightAt !== "function" || S.ride == null){ S.red = null; return; }
    var L = null;
    try { L = T.lightAt(S.me.x, S.me.z, S.me.yaw, S.ms); } catch(e){ L = null; }
    var P = S.red;
    if(P && P.state === "red" && P.dist >= 0 && P.dist < 15 && S.speed > 5){
      var past = !L || L.sig !== P.sig || num(L.dist, 0) < 0 || num(L.dist, 0) > P.dist + 5;
      if(past) ranRed(S.me.x, S.me.z, P.sig);
    }
    S.red = L && L.state ? {state: L.state, sig: L.sig, dist: num(L.dist, 99)} : null;
  }

  function pausedNow(f){
    if(f && (f.paused || f.menu)) return true;
    try { if(typeof document !== "undefined" && document.hidden) return true; } catch(e){}
    try {
      if(HQV.townHall && HQV.townHall.isOpen && HQV.townHall.isOpen()) return true;
      if(HQV.hqGarageMgr && HQV.hqGarageMgr.isOpen && HQV.hqGarageMgr.isOpen()) return true;
    } catch(e){}
    return false;
  }

  function sound(){
    var e = E(); if(!e || typeof e.pool !== "function") return;
    try {
      if(!sirenPool) sirenPool = e.pool("siren", {voices: 2, key: function(){ return "siren"; }, make: function(){ return e.loop ? e.loop("siren") : null; },
                                                   play: function(h, s){ if(h && h.set) h.set(1, {pos: s}); }});
      var src = [];
      if(!calm()) S.cars.forEach(function(c){ if(!c.leave && c.kind === "car") src.push({id: "heat-" + c.id, x: c.x, y: ctx.groundY(c.x, c.z) + 1.5, z: c.z}); });
      sirenPool.update(src);
      if(S.heli || heliPool){
        if(!heliPool) heliPool = e.pool("heli", {voices: 1, key: function(){ return "rotor"; }, make: function(){ return e.engineSound ? e.engineSound("rotor") : null; },
                                                  play: function(h, s){ if(h && h.set) h.set(2800, {pos: s, sk: "heli"}); }});
        heliPool.update(S.heli ? [{id: "heat-heli", x: S.heli.x, y: S.heli.y, z: S.heli.z, rpm: 2800}] : []);
      }
    } catch(err){}
  }

  function draw(){
    if(!view) return;
    var steady = calm();
    view.draw(S.cars, Math.floor(S.ms/180) & 1, steady, ctx.groundY);
    var H = S.heli, spot = H && H.spot && !H.leave ? {x: H.spot.x, y: ctx.groundY(H.spot.x, H.spot.z), z: H.spot.z} : null;
    view.drawHeli(H, spot, S.spin, !!(ctx.night && ctx.night()));
  }

  function update(dt, f){
    if(S.dead) return;
    f = f || {};
    dt = clamp(num(dt, 0), 0, 0.1);
    S.ms = num(f.ms, S.ms + dt*1000); S.local = num(f.local, S.ms);
    var m = f.motion || {}, me = f.me || {};
    if(pausedNow(f)){ sound(); draw(); return; }
    S.t += dt;
    S.me = {x: num(me.x, S.me.x), y: num(me.y, 0), z: num(me.z, S.me.z), yaw: num(me.yaw, num(m.yaw, S.me.yaw))};
    S.known = true;
    if(S.stars > 0 && !S.seenAt) S.seenAt = {x: S.me.x, z: S.me.z};
    S.speed = Math.abs(num(m.speed, 0)); S.ride = m.ride || null; S.traffic = Array.isArray(f.traffic) ? f.traffic : [];
    if(S.msgT && S.t >= S.msgT){ S.msgT = 0; if(ctx.hud) ctx.hud.clear("heat-msg"); }
    if(S.busted){ bustStep(dt); sound(); draw(); return; }
    lights();
    // speeding hugely in the centre, a police car close by
    if(S.ride && S.speed > SPEED_V && Math.hypot(S.me.x - centre.x, S.me.z - centre.z) < CENTRE_R && police(S.me.x, S.me.z, 60) && cooled("speed", 15)) add(1, "speeding in the centre");
    if(S.stars > 0){
      // more cars, then the roadblock and the helicopter
      var live = S.cars.filter(function(c){ return !c.leave && c.kind === "car"; }).length;
      if(S.tag) S.cars.forEach(function(c){ c.leave = true; });              // [arena] Cops & robber: the players are the police
      else if(live < want(S.stars) && S.t >= S.spawnT){ spawn(); S.spawnT = S.t + (live ? 2.5 : 1.5); }
      if(S.stars >= 4 && !S.tag) roadblock();
      if(S.block && (S.stars < 4 || S.t - S.block.t > 45 || Math.hypot(S.block.x - S.me.x, S.block.z - S.me.z) > 160)){
        S.block.cars.forEach(function(c){ c.gone = true; }); S.block = null; S.blockT = S.t + 20;
      }
      S.losT -= dt;
      if(S.losT <= 0){ S.losT = 0.25; look(); }
      // unseen: a star goes every lose(stars) s (hidden: three times as fast)
      var need = lose(S.stars)*(S.hidden ? 0.35 : 1);
      if(!S.seen && !S.tag && S.t - S.seenT >= need){
        S.seenT = S.t;
        setHeat(S.stars - 1, "lost sight of you");
        if(S.stars === 0) escaped();
      }
    }
    heliStep(dt);
    S.spin += dt*(calm() ? 10 : 24);
    S.cars.forEach(function(c){ drive(c, dt); });
    S.cars = S.cars.filter(function(c){ return !c.gone; });
    // busted: a car right by you while you sit still, or one reaching you on foot
    if(S.stars > 0){
      var near = Infinity;
      S.cars.forEach(function(c){ if(!c.leave){ var d = Math.hypot(c.x - S.me.x, c.z - S.me.z); if(d < near) near = d; } });
      if(S.tag){                                                          // [arena] a player cop: BUST_R for BUST_S while you are slow
        var pn = Infinity;
        S.tag.cops.forEach(function(p){ var d = Math.hypot(p.x - S.me.x, p.z - S.me.z); if(d < pn) pn = d; });
        S.tag.bustT = pn <= BUST_R && S.speed < BUST_V ? S.tag.bustT + dt : 0;
        if(S.tag.bustT >= BUST_S){ S.tag.bustT = 0; bust(); }
      }
      if(!S.ride){ S.footT = near <= FOOT_R ? S.footT + dt : 0; S.bustT = 0; }
      else { S.bustT = near <= BUST_R && S.speed < BUST_V ? S.bustT + dt : 0; S.footT = 0; }
      if(!S.busted && (S.footT >= FOOT_S || S.bustT >= BUST_S)) bust();
    } else { S.bustT = 0; S.footT = 0; }
    sound(); draw();
  }

  function blocked(x, z){
    for(var i = 0; i < S.cars.length; i++){
      var c = S.cars[i], dx = x - c.x, dz = z - c.z;
      if(dx*dx + dz*dz > 9) continue;
      var cs = Math.cos(c.yaw), sn = Math.sin(c.yaw), lz = dx*sn + dz*cs, lx = dx*cs - dz*sn;
      if(Math.abs(lx) <= CAR_HW && Math.abs(lz) <= CAR_HL) return true;
    }
    return false;
  }

  function dispose(){
    if(S.dead) return; S.dead = true;
    try { if(sirenPool) sirenPool.stop(); if(heliPool) heliPool.stop(); } catch(e){}
    if(fadeEl && fadeEl.parentNode) fadeEl.parentNode.removeChild(fadeEl); fadeEl = null;
    if(ctx.hud){ ctx.hud.clear("heat"); ctx.hud.clear("heat-msg"); }
    if(view) view.dispose(); view = null;
    S.cars = []; S.heli = null;
  }

  return {
    update: update, blocked: blocked, on: on, dispose: dispose,
    stars: function(){ return S.stars; },
    heat: function(){ return S.h; },
    add: add,
    clear: function(){ S.cars.forEach(function(c){ c.gone = true; }); S.cars = []; S.block = null; S.heli = null; S.seenAt = null; setHeat(0, "cleared"); },
    chasers: function(){ return S.cars.filter(function(c){ return !c.leave; }).map(function(c){ return {x: c.x, z: c.z, yaw: c.yaw, kind: c.kind}; }); },
    zone: function(){ return S.stars > 0 && S.seenAt ? {x: S.seenAt.x, z: S.seenAt.z, r: 30 + 25*S.stars} : null; },
    heli: function(){ return S.heli ? {x: S.heli.x, y: S.heli.y, z: S.heli.z} : null; },
    busting: function(){ return !!S.busted; },
    unseen: function(){ return Math.max(0, S.t - S.seenT); },
    // [arena] Cops & robber: the player cops this frame ({cops: [{x, z}]}), or null to end the game
    tag: function(o){
      if(!o){ S.tag = null; return false; }
      var cops = (Array.isArray(o.cops) ? o.cops : []).slice(0, 8).filter(function(p){ return p && isFinite(+p.x) && isFinite(+p.z); })
                   .map(function(p){ return {x: +p.x, z: +p.z}; });
      if(!S.tag){ S.tag = {cops: cops, bustT: 0}; S.seenT = S.t; }
      else S.tag.cops = cops;
      return true;
    },
    tagBust: function(){ return S.tag ? S.tag.bustT : 0; },
    seen: function(){ return S.seen; },
    view: function(){ return view; }
  };
}

if(HQV.cityPlay && HQV.cityPlay.register) HQV.cityPlay.register({id: "heat", order: 20, create: create});
HQV.playHeat = {create: create, lose: lose, vmaxOf: vmaxOf, RAM_V: RAM_V, BUST_R: BUST_R, BUST_S: BUST_S, BUST_REP: BUST_REP};
})();
