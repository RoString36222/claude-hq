/* Claude HQ: calling a helicopter (HQV.hqHeliCall), docs/plans/transport-revamp.md 3.10 and 5.10 (part `cabs`).
 *
 * From the phone (Claude Cabs -> Heli, or Vehicles -> Helicopters) you pick a landing spot: the nearest helipad (the
 * airport apron, the hospital's pad, an HQ roof with a pad, the marina breakwater) or the nearest open area at least
 * 26 x 26 m clear of buildings, roads, water and trees within 400 m. A Claude Cabs helicopter (anyone; free, D4) or your
 * own (owners) flies a scripted pure path: cruise at 90 m, a 12 degree glideslope down, a flare, a hover-taxi and a
 * vertical landing. Rotor-wash dust (Calm: none) and its rotor: one held loop at the heli (deps.sfx("rotor", {pos,
 * kind: "heli", rate})), moved every frame and Doppler-shifted towards the listener, stopped once the heli has gone.
 * Board on foot (rear left seat); a cab heli then flies you to your destination with the camera in the cabin (V cycles
 * to chase). Your own heli lands and is handed back (handle.landed()) for hq3d's mountOn.
 *
 * Pure (node-tested, tests/test_hqhelicall.py), metres, yaw 0 faces +z, increasing yaw turns left:
 *   spots(W, x, z, r, extra)  -> [{id, x, y, z, kind: "pad"|"open", name, dist}] by distance then id: every pad (any
 *                                distance; extra.roofs [{id, x, y, z, name}] are HQ roofs with a pad) and up to OPEN_N
 *                                open areas within r (default 400) of (x, z)
 *   clearAt(W, x, z, half)    -> true when the square of side 2*half round (x, z) is open ground (no building, lot, site,
 *                                road, water, river, sea, hole or tree, slope under SLOPE m)
 *   path(from, to, opts)      -> {len, T, D, H, yaw, glide (rad), segs, pose(t) -> {x, y, z, yaw, pitch, roll, rotor, rpm,
 *                                phase, agl, vx, vy, vz, done}}   opts = {start: "ground"|"cruise", end: "land"|"cruise",
 *                                cruise (m, 90)}. Phases: spool, lift, climb, cruise, glide, flare, taxi, land, settle.
 *   doppler(src {x, y, z, vx, vy, vz}, ear {x, y, z}) -> the pitch factor c / (c - v toward you)
 * Controller: mount(c, w, deps) -> {spots(r), call(spot, {own}) -> handle, fly(dest), use(), current(), carry(ms),
 *             camPose(ms, look), update(ms, dt), drawCalls(), tools: {shotCam(name)}, dispose()}
 *   w = {W, me() -> {x, y, z}, ground(x, z), group, roofs() -> [{id, x, y, z, name}], now()}
 *   deps = {announce, sfx(name, opts), calm(), night(), models: HQV.hqheli, paintOf(vehicleId) -> 0xrrggbb,
 *           achievements, seatCam}
 *   handle = {state() -> {phase: "coming"|"here"|"riding"|"done"|"leaving"|"cancelled", eta, spot, dest, own}, cancel(),
 *             landed() -> {x, y, z, yaw, vehicleId} | null (own heli, once down), release() (own: hq3d took it over)}
 */
(function(){
"use strict";
var root = typeof window !== "undefined" ? window : globalThis;
var HQV = root.HQV = root.HQV || {};

var DEG = Math.PI/180;
var CRUISE_H = 90;            // m over the higher end
var CRUISE_V = 45;            // m/s
var GLIDE = 12*DEG;           // the glideslope
var CLIMB = 20*DEG;
var FLARE_H = 12, FLARE_L = 40, TAXI_H = 3, TAXI_L = 20;   // m
var LIFT_H = 6, SPOOL_S = 3, SETTLE_S = 2;
var OPEN_HALF = 13;           // m: a 26 x 26 m open area
var OPEN_R = 400, OPEN_N = 3, OPEN_STEP = 12, OPEN_GAP = 30;
var SLOPE = 1.6;              // m: the most the ground may rise across an open area
var ROAD_CLEAR = OPEN_HALF*1.42 + 1;   // m from a road's edge to the area's centre (its corners clear too)
var SOUND_C = 343;
var CALL_FROM = 1400;         // m: a called heli starts this far out, at cruise height
var BOARD_R = 7;

function hash32(str){
  str = String(str == null ? "" : str);
  var h = 0x811c9dc5;
  for(var i = 0; i < str.length; i++){ h ^= str.charCodeAt(i) & 0xff; h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
function clamp(v, a, b){ return v < a ? a : (v > b ? b : v); }
function num(v, d){ v = +v; return isFinite(v) ? v : d; }
function hyp(x, z){ return Math.sqrt(x*x + z*z); }
// the farthest a spatial kind is heard (games/engine.js KINDS), else d
function reach(kind, d){ var E = HQV.engine, K = E && E.spatial && E.spatial.KINDS, k = K && K[kind]; return k && k.max > 0 ? k.max : d; }

/* ---------- landing spots (pure) ---------- */
function WD(){ return HQV.world || {}; }
function sea(W){ var B = W && (W.tierBase || W), I = B && B.island; return I && I.sea_cm != null && isFinite(+I.sea_cm) ? +I.sea_cm/100 : null; }
function groundAt(W, x, z){ var A = WD(); try { return A.groundAt ? num(A.groundAt(W, x, z), 0) : 0; } catch(e){ return 0; } }
function treesNear(W, x, z, r){
  var A = WD(), L = [];
  try { L = A.trees ? A.trees(W) || [] : []; } catch(e){ L = []; }
  return L.filter(function(t){ return Math.abs(t.x - x) <= r && Math.abs(t.z - z) <= r; });
}
function clearAt(W, x, z, half, trees){
  var A = WD(); half = half > 0 ? +half : OPEN_HALF;
  if(!W || !A.blockedAt) return false;
  try {
    var road = A.nearestRoad ? A.nearestRoad(W, x, z, half*1.42 + 30) : null;
    if(road && road.dist - road.half < half*1.42 + 1) return false;
    var sl = sea(W), lo = Infinity, hi = -Infinity, n = 4, step = 2*half/n;
    for(var i = 0; i <= n; i++) for(var k = 0; k <= n; k++){
      var px = x - half + i*step, pz = z - half + k*step;
      if(A.blockedAt(W, px, pz)) return false;
      if(A.lotAt && A.lotAt(W, px, pz)) return false;
      if(A.siteAt && A.siteAt(W, px, pz)) return false;
      if(A.waterAt && W.water && A.waterAt(W, px, pz)) return false;
      if(A.riverAt && W.river && A.riverAt(W, px, pz)) return false;
      if(A.holeAt && (W.metro || W.rail) && A.holeAt(W, px, pz)) return false;
      var y = groundAt(W, px, pz);
      if(sl != null && y < sl + 0.5) return false;
      lo = Math.min(lo, y); hi = Math.max(hi, y);
    }
    if(hi - lo > SLOPE) return false;
    var TL = trees || treesNear(W, x, z, half + 4);
    for(var j = 0; j < TL.length; j++) if(Math.abs(TL[j].x - x) <= half + 3 && Math.abs(TL[j].z - z) <= half + 3) return false;
  } catch(e){ return false; }
  return true;
}
function siteFront(s){
  if(s.front && s.front.length === 2){ var fx = s.front[0]/65536, fz = s.front[1]/65536, l = hyp(fx, fz); if(l > 1e-6) return [fx/l, fz/l]; }
  return s.facing === "south" ? [0, -1] : [0, 1];
}
function siteReach(s, f){
  if(s.poly && s.poly.length){ var m = 0; s.poly.forEach(function(p){ m = Math.max(m, ((p[0] - s.x)*f[0] + (p[1] - s.z)*f[1])/100); }); return m; }
  return Math.abs(f[0])*num(s.w, 0)/200 + Math.abs(f[1])*num(s.d, 0)/200;
}
// open ground near (x, z): the nearest candidates on a lattice, at most n, at least OPEN_GAP apart
function openNear(W, x, z, r, n, half){
  var C = [], st = OPEN_STEP, out = [];
  for(var gx = -r; gx <= r; gx += st) for(var gz = -r; gz <= r; gz += st){
    var d = hyp(gx, gz); if(d <= r) C.push([d, Math.round((x + gx)*10)/10, Math.round((z + gz)*10)/10]);
  }
  C.sort(function(a, b){ return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]; });
  var TL = treesNear(W, x, z, r + half + 6), tested = 0;
  for(var i = 0; i < C.length && out.length < n && tested < 2500; i++){
    var c = C[i];
    if(out.some(function(o){ return hyp(o.x - c[1], o.z - c[2]) < OPEN_GAP; })) continue;
    tested++;
    if(!clearAt(W, c[1], c[2], half, TL)) continue;
    out.push({x: c[1], z: c[2]});
  }
  return out;
}
function spots(W, x, z, r, extra){
  x = num(x, 0); z = num(z, 0); r = r > 0 ? +r : OPEN_R; extra = extra || {};
  var out = [], A = WD();
  function add(s){ s.dist = Math.round(hyp(s.x - x, s.z - z)*10)/10; out.push(s); }
  if(W){
    (W.sites || []).forEach(function(s){
      if(!s) return;
      if(s.kind === "airport"){
        var f = siteFront(s), h = siteReach(s, f), px = s.x/100 + f[0]*(h - 22), pz = s.z/100 + f[1]*(h - 22);
        add({id: "pad:" + s.id, x: px, y: groundAt(W, px, pz), z: pz, kind: "pad", name: "Airport apron"});
      } else if(s.kind === "hospital"){
        // the hospital's pad: the nearest open ground beside it (a smaller pad, 22 m)
        var f2 = siteFront(s), h2 = siteReach(s, f2), hx = s.x/100 + f2[0]*(h2 + 16), hz = s.z/100 + f2[1]*(h2 + 16);
        var o = openNear(W, hx, hz, 90, 1, 11)[0];
        if(o) add({id: "pad:" + s.id, x: o.x, y: groundAt(W, o.x, o.z), z: o.z, kind: "pad", name: "Hospital helipad"});
      }
    });
    var V = A.waterOf ? A.waterOf(W) : null, B = V && V.breakwater;
    if(B && B.length >= 2){
      // 15 m back from the breakwater's head (the end with the lighthouse, else its last point), on its crown walk
      var lh = V.lighthouse, first = lh && hyp(B[0][0] - lh[0], B[0][1] - lh[1]) < hyp(B[B.length - 1][0] - lh[0], B[B.length - 1][1] - lh[1]);
      var a = first ? B[0] : B[B.length - 1], b = first ? B[1] : B[B.length - 2], L = hyp(a[0] - b[0], a[1] - b[1]) || 1, k = Math.min(15, L/2)/L;
      var bx = a[0] + (b[0] - a[0])*k, bz = a[1] + (b[1] - a[1])*k, by = A.deckAt ? A.deckAt(W, bx, bz) : null;
      add({id: "pad:breakwater", x: bx, y: by != null ? by : groundAt(W, bx, bz), z: bz, kind: "pad", name: "Marina breakwater"});
    }
  }
  (extra.roofs || []).forEach(function(R){
    if(!R || !isFinite(+R.x) || !isFinite(+R.z)) return;
    add({id: "roof:" + String(R.id != null ? R.id : Math.round(R.x) + "," + Math.round(R.z)), x: +R.x, y: num(R.y, 0), z: +R.z, kind: "pad", name: String(R.name || "HQ roof")});
  });
  if(W) openNear(W, x, z, r, OPEN_N, OPEN_HALF).forEach(function(o){
    add({id: "open:" + Math.round(o.x) + ":" + Math.round(o.z), x: o.x, y: groundAt(W, o.x, o.z), z: o.z, kind: "open", name: "Open ground"});
  });
  out.sort(function(p, q){ return p.dist - q.dist || (p.id < q.id ? -1 : p.id > q.id ? 1 : 0); });
  return out;
}

/* ---------- the flight path (pure) ---------- */
function path(from, to, opts){
  opts = opts || {};
  var fx = num(from && from.x, 0), fy = num(from && from.y, 0), fz = num(from && from.z, 0);
  var tx = num(to && to.x, 0), ty = num(to && to.y, 0), tz = num(to && to.z, 0);
  var start = opts.start === "cruise" ? "cruise" : "ground", end = opts.end === "cruise" ? "cruise" : "land";
  var dx = tx - fx, dz = tz - fz, D = hyp(dx, dz), ux = D > 1e-6 ? dx/D : 0, uz = D > 1e-6 ? dz/D : 1, yaw = Math.atan2(ux, uz);
  var H = start === "cruise" ? fy : Math.max(fy, ty) + num(opts.cruise, CRUISE_H);
  var segs = [], d = 0, y = fy, v = 0;
  var tanG = Math.tan(GLIDE), tanC = Math.tan(CLIMB), hF = ty + FLARE_H;
  if(end === "land"){
    // a short hop: lower the cruise so the climb (20 deg) and the glide (12 deg) both fit
    var avail = D - FLARE_L - TAXI_L, y1 = start === "ground" ? fy + LIFT_H : fy;
    if(start === "ground"){
      var Hmax = (Math.max(0, avail) + y1/tanC + hF/tanG)/(1/tanC + 1/tanG);
      H = clamp(Math.min(H, Hmax), Math.max(y1, hF), Infinity);
    }
  }
  function seg(kind, d1, y1, v1, dur){
    var S = {kind: kind, d0: d, d1: d1, y0: y, y1: y1, v0: v, v1: v1};
    S.L = hyp(d1 - d, y1 - y);
    S.dur = dur != null ? dur : (S.L > 1e-9 ? 2*S.L/Math.max(0.05, v + v1) : 0);
    segs.push(S); d = d1; y = y1; v = v1;
  }
  if(start === "ground"){
    seg("spool", d, y, 0, SPOOL_S);
    seg("lift", d, y + LIFT_H, 2);
    var climbL = Math.max(0, (H - y)/tanC);
    if(end === "land") climbL = Math.min(climbL, Math.max(0, D - FLARE_L - TAXI_L - (H - hF)/tanG));
    seg("climb", d + climbL, H, 30);
  }
  if(end === "land"){
    var gs = Math.max(d, D - FLARE_L - TAXI_L - Math.max(0, H - hF)/tanG);
    if(gs > d) seg("cruise", gs, H, CRUISE_V);
    seg("glide", Math.max(d, D - FLARE_L - TAXI_L), hF, 15);
    seg("flare", Math.max(d, D - TAXI_L), ty + TAXI_H + 1, 3);
    seg("taxi", Math.max(d, D), ty + TAXI_H, 1.5);
    seg("land", d, ty, 0.3);
    seg("settle", d, ty, 0, SETTLE_S);
  } else {
    seg("cruise", Math.max(d, D), H, CRUISE_V);
  }
  var t = 0; segs.forEach(function(S){ S.t0 = t; t += S.dur; S.t1 = t; });
  var Ttot = t, len = segs.reduce(function(a, S){ return a + S.L; }, 0);
  var spun = start === "cruise";
  function rotorAt(tt){
    // rpm 0..1: spools up over SPOOL_S on the ground, full in the air, idles down after the settle; phase = 32 x its integral
    if(spun) return {rpm: 1, phase: (tt*32) % (Math.PI*2)};
    if(tt < SPOOL_S) return {rpm: tt/SPOOL_S, phase: (16*tt*tt/SPOOL_S) % (Math.PI*2)};
    return {rpm: 1, phase: (16*SPOOL_S + 32*(tt - SPOOL_S)) % (Math.PI*2)};
  }
  function pose(tt){
    tt = clamp(num(tt, 0), 0, Ttot);
    var S = segs[segs.length - 1];
    for(var i = 0; i < segs.length; i++) if(tt <= segs[i].t1){ S = segs[i]; break; }
    var tau = tt - S.t0, a = S.dur > 0 ? (S.v1 - S.v0)/S.dur : 0, s = S.v0*tau + 0.5*a*tau*tau, f = S.L > 1e-9 ? clamp(s/S.L, 0, 1) : 1;
    if(S.dur > 0 && S.L <= 1e-9) f = 1;
    var dd = S.d0 + (S.d1 - S.d0)*f, yy = S.y0 + (S.y1 - S.y0)*f, vv = S.v0 + a*tau;
    var horiz = S.L > 1e-9 ? (S.d1 - S.d0)/S.L : 0, vert = S.L > 1e-9 ? (S.y1 - S.y0)/S.L : 0;
    var R = rotorAt(tt), done = tt >= Ttot;
    return {x: fx + ux*dd, y: yy, z: fz + uz*dd, yaw: yaw, pitch: horiz > 0.2 ? clamp(-a*0.035, -0.22, 0.22) : 0, roll: 0,
            rotor: R.phase, rpm: R.rpm, phase: S.kind, d: dd, vx: ux*vv*horiz, vy: vv*vert, vz: uz*vv*horiz, done: done};
  }
  return {len: len, T: Ttot, D: D, H: H, yaw: yaw, glide: GLIDE, segs: segs, pose: pose, from: {x: fx, y: fy, z: fz}, to: {x: tx, y: ty, z: tz}};
}
function doppler(src, ear){
  src = src || {}; ear = ear || {};
  var dx = num(ear.x, 0) - num(src.x, 0), dy = num(ear.y, 0) - num(src.y, 0), dz = num(ear.z, 0) - num(src.z, 0), L = Math.sqrt(dx*dx + dy*dy + dz*dz);
  if(L < 1e-6) return 1;
  var vt = (num(src.vx, 0)*dx + num(src.vy, 0)*dy + num(src.vz, 0)*dz)/L;
  return clamp(SOUND_C/(SOUND_C - clamp(vt, -200, 200)), 0.5, 2);
}

/* ---------- the controller ---------- */
function mount(c, w, deps){
  c = c || null; w = w || {}; deps = deps || {};
  var T = c && c.THREE ? c.THREE : null, cur = null, nowMs = 0, sndAt = -Infinity, rotor = null;
  function W(){ try { return typeof w.W === "function" ? w.W() : w.W; } catch(e){ return null; } }
  function me(){ try { return (w.me && w.me()) || {}; } catch(e){ return {}; } }
  function calm(){ try { return !!(deps.calm && deps.calm()); } catch(e){ return false; } }
  function say(t){ try { if(deps.announce) deps.announce(t); } catch(e){} }
  function sfx(n, o){ try { return deps.sfx ? deps.sfx(n, o) : null; } catch(e){ return null; } }
  // the rotor: ONE held loop at the heli (deps.sfx "rotor" with {pos, kind: "heli", rate}), moved every frame, its
  // pitch shifted by the Doppler factor towards your ears (the spatial listener, else your head); started within
  // earshot (a failed start is tried again after 400 ms), stopped once the heli has gone (left, handed over, disposed)
  function rotorStop(){ if(rotor){ try { rotor.stop(); } catch(e){} rotor = null; } sndAt = -Infinity; }
  function rotorAt(p){
    var E = HQV.engine, L = null, m = me();
    try { L = E && typeof E.listenerAt === "function" ? E.listenerAt() : null; } catch(e){ L = null; }
    var ear = L ? {x: L.x, y: L.y, z: L.z} : {x: num(m.x, 0), y: num(m.y, 0) + 1.6, z: num(m.z, 0)}, M = reach("heli", 1500);
    var at = {x: p.x, y: p.y + 2, z: p.z}, d = Math.sqrt(Math.pow(at.x - ear.x, 2) + Math.pow(at.y - ear.y, 2) + Math.pow(at.z - ear.z, 2));
    var o = {pos: at, kind: "heli", rate: doppler(p, ear)*(0.6 + 0.4*p.rpm)};
    if(rotor){ if(d > M*1.1) rotorStop(); else { try { rotor.set(o); } catch(e){} } return; }
    if(d >= M || nowMs - sndAt < 400) return;
    sndAt = nowMs;
    var h = sfx("rotor", o);
    rotor = h && typeof h.set === "function" && typeof h.stop === "function" ? h : null;
  }
  function clock(){ if(nowMs) return nowMs; try { return w.now ? +w.now() : Date.now(); } catch(e){ return 0; } }
  function roofs(){ try { return w.roofs ? w.roofs() || [] : []; } catch(e){ return []; } }
  function achv(){ return deps.achievements || (HQV.hqRide && HQV.hqRide.achievements) || null; }
  var view = null;

  function mySpots(r){ var m = me(); return spots(W(), num(m.x, 0), num(m.z, 0), r || OPEN_R, {roofs: roofs()}); }
  function landingFor(dest){
    if(!dest) return null;
    if(dest.kind === "pad" || dest.kind === "open") return dest;
    var L = spots(W(), num(dest.x, 0), num(dest.z, 0), 300, {roofs: roofs()});
    return L[0] || null;
  }
  function newHandle(spot, own){
    var t = clock(), a = (hash32(String(spot.id) + ":" + Math.floor(t/60000)) % 3600)*DEG/10, y = num(spot.y, 0) + CRUISE_H;
    var from = {x: spot.x + Math.sin(a)*CALL_FROM, y: y, z: spot.z + Math.cos(a)*CALL_FROM};
    var J = {spot: spot, own: own || null, phase: "coming", P: path(from, spot, {start: "cruise"}), t0: t, dest: null, ride: null};
    J.handle = {
      state: function(){ return {phase: J.phase, spot: J.spot, dest: J.dest, own: J.own,
                                 eta: J.phase === "coming" || J.phase === "riding" ? Math.max(0, Math.round(J.P.T - (clock() - J.t0)/1000)) : 0}; },
      cancel: function(){ if(J.phase === "coming" || J.phase === "here"){ leave(J); J.phase = "cancelled"; return true; } return false; },
      landed: function(){ if(!J.own || J.phase !== "here") return null; var p = J.P.pose(J.P.T); return {x: p.x, y: p.y, z: p.z, yaw: p.yaw, vehicleId: J.own}; },
      release: function(){ if(J.own){ J.phase = "done"; if(cur === J){ cur = null; rotorStop(); } if(view) view.hide(); return true; } return false; }
    };
    return J;
  }
  function leave(J){
    // from wherever it is now: still in the air (a cancel on the way in) it just flies off
    var p = J.P.pose((clock() - J.t0)/1000), gy = w.ground ? num(w.ground(p.x, p.z), 0) : num(J.spot.y, 0), air = p.y - gy > 3;
    var out = {x: p.x + Math.sin(p.yaw)*1500, y: (air ? p.y : p.y + CRUISE_H), z: p.z + Math.cos(p.yaw)*1500};
    J.P = path({x: p.x, y: p.y, z: p.z}, out, {start: air ? "cruise" : "ground", end: "cruise"}); J.t0 = clock(); J.phase = "leaving";
  }
  function call(spot, o){
    o = o || {};
    if(!spot || !isFinite(+spot.x) || !isFinite(+spot.z)) return null;
    if(cur && (cur.phase === "coming" || cur.phase === "here")) cur.handle.cancel();
    var J = newHandle({id: spot.id, x: +spot.x, y: num(spot.y, 0), z: +spot.z, kind: spot.kind, name: spot.name}, o.own);
    cur = J;
    if(view) view.show(J.own ? (deps.paintOf ? deps.paintOf(J.own) : null) : null, !J.own);
    say((J.own ? "Your helicopter" : "A Claude Cabs helicopter") + " is on its way to " + (spot.name || "you") + ". About " + Math.round(J.P.T) + " s.");
    try { var A = achv(); if(A && A.record) A.record({type: "heli", at: clock()}); } catch(e){}
    return J.handle;
  }
  function fly(dest){
    var J = cur; if(!J || J.own) return false;
    var L = landingFor(dest); if(!L) return false;
    J.dest = {id: L.id, x: L.x, y: num(L.y, 0), z: L.z, name: (dest && (dest.name || dest.label)) || L.name, kind: L.kind};
    if(J.phase === "riding") startRide(J);
    return true;
  }
  function startRide(J){
    var p = J.P.pose(J.P.T);
    J.P = path({x: p.x, y: p.y, z: p.z}, J.dest, {start: "ground"}); J.t0 = clock();
    say("Lifting off for " + J.dest.name + ". About " + Math.round(J.P.T) + " s.");
  }
  function use(){
    var J = cur; if(!J || J.phase !== "here" || J.own) return false;
    var m = me(), p = J.P.pose(J.P.T);
    if(hyp(num(m.x, 0) - p.x, num(m.z, 0) - p.z) > BOARD_R) return false;
    J.phase = "riding"; J.boarded = clock();
    if(J.dest) startRide(J); else say("You're aboard. Pick a destination in the phone.");
    return true;
  }
  function seatPose(J, ms){
    var p = J.P.pose((ms - J.t0)/1000), yaw = p.yaw, fx = Math.sin(yaw), fz = Math.cos(yaw), lx = Math.cos(yaw), lz = -Math.sin(yaw);
    var S = view ? view.seat() : {x: 0.4, y: 1.1, z: -0.45};
    return {x: p.x + fx*S.z + lx*S.x, y: p.y + S.y, z: p.z + fz*S.z + lz*S.x, yaw: yaw, v: p};
  }
  function update(ms, dt){
    nowMs = num(ms, nowMs);
    var J = cur; if(!J){ rotorStop(); if(view) view.update(null, 0, dt); return; }
    var t = (nowMs - J.t0)/1000, p = J.P.pose(t);
    if(J.phase === "coming" && p.done){
      // down, its rotor still turning while it waits for you (the blades and the wash show it): the loop goes on
      J.phase = "here";
      say(J.own ? "Your helicopter has landed. Press E to fly it." : "Your Claude Cabs helicopter has landed at " + (J.spot.name || "the pad") + ". Walk up and press E to board (rear left seat).");
    } else if(J.phase === "riding" && J.dest && p.done && nowMs - J.t0 > 1000){
      J.phase = "done"; J.doneAt = nowMs; say("Landed at " + J.dest.name + ". Thanks for flying Claude Cabs.");
      var m0 = J.P.pose(J.P.T); J.exit = {x: m0.x + Math.cos(m0.yaw)*2.6, z: m0.z - Math.sin(m0.yaw)*2.6, yaw: m0.yaw};
    } else if(J.phase === "done" && nowMs - J.doneAt > 4000) leave(J);
    else if((J.phase === "leaving" && p.done) || J.phase === "cancelled" && J.P.pose(t).done){ cur = null; rotorStop(); if(view) view.hide(); return; }
    // the rotor at the heli, pitched by the Doppler shift (spooling: once its rpm is up)
    if(p.rpm > 0.2) rotorAt(p);
    if(view) view.update(p, t, dt);
  }
  if(T) view = makeView(c, w, deps, calm);
  return {
    spots: mySpots, call: call, fly: fly, use: use, current: function(){ return cur ? cur.handle : null; },
    carry: function(ms){
      var J = cur; if(!J || J.phase !== "riding") return null;
      var s = seatPose(J, num(ms, clock()));
      return {x: s.x, y: s.y, z: s.z, yaw: s.yaw, anim: "sit", seat: "rear-left"};
    },
    camPose: function(ms, look){
      var J = cur; look = look || {}; if(!J || J.phase !== "riding") return null;
      var s = seatPose(J, num(ms, clock())), SC = deps.seatCam || (HQV.hqRide && HQV.hqRide.seatCam);
      var vp = {x: s.v.x, y: s.v.y, z: s.v.z, yaw: s.v.yaw, pitch: s.v.pitch, speed: hyp(s.v.vx, s.v.vz)};
      if(SC) return SC({x: s.x, y: s.y, z: s.z, yaw: s.yaw}, vp, look, look.mode || "seat", calm(), {t: ms, back: 18, up: 6});
      return {camera: true, pos: {x: s.x, y: s.y + 1.15, z: s.z}, look: {x: s.x + Math.sin(s.yaw)*10, y: s.y + 0.6, z: s.z + Math.cos(s.yaw)*10}, up: {x: 0, y: 1, z: 0}, fov: 70};
    },
    exit: function(){ return cur && cur.exit ? cur.exit : null; },
    update: update,
    drawCalls: function(){ return view ? view.drawCalls() : 0; },
    tools: {shotCam: function(name){
      var J = cur; if(!J) return null;
      var p = J.P.pose((clock() - J.t0)/1000);
      if(name === "heli-landing") return {pos: {x: J.spot.x + 30, y: num(J.spot.y, 0) + 8, z: J.spot.z + 30}, look: {x: p.x, y: p.y + 1, z: p.z}, fov: 55};
      if(name === "heli-cabin"){ var s = seatPose(J, clock()); return {pos: {x: s.x, y: s.y + 1.15, z: s.z}, look: {x: s.x + Math.sin(s.yaw)*20, y: s.y - 4, z: s.z + Math.cos(s.yaw)*20}, fov: 70}; }
      return null;
    }},
    dispose: function(){ rotorStop(); if(view) view.dispose(); view = null; cur = null; }
  };
}

/* ---------- drawing (THREE; never loaded under node) ---------- */
function makeView(c, w, deps, calmF){
  var T = c.THREE, parent = (w && w.group) || c.scene || null, HM = deps.models || HQV.hqheli;
  var g = new T.Group(); g.name = "hqhelicall"; g.visible = false;
  if(parent && parent.add) parent.add(g);
  var B = null, key = null;
  // hqheli's model is ~30 meshes; the static ones under `parent` (its fuselage, skids, boom; the blades in their
  // group) are merged into one mesh per material, so a called heli costs about a dozen draw calls, not 30+
  function merge(parentG, skip){
    var groups = {}, order = [];
    parentG.updateMatrixWorld(true);
    var inv = new T.Matrix4().copy(parentG.matrixWorld).invert(), M = new T.Matrix4();
    parentG.traverse(function(o){
      if(!o.isMesh || o === parentG) return;
      for(var q = o.parent; q && q !== parentG; q = q.parent) if(skip.indexOf(q) >= 0) return;
      if(skip.indexOf(o) >= 0 || o.material.transparent && o.material.opacity === 0) return;
      var k = o.material.uuid; if(!groups[k]){ groups[k] = {m: o.material, list: []}; order.push(k); }
      groups[k].list.push(o);
    });
    order.forEach(function(k){
      var G = groups[k]; if(G.list.length < 2) return;
      var pos = [], nor = [];
      G.list.forEach(function(o){
        M.multiplyMatrices(inv, o.matrixWorld);
        var g0 = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone(); g0.applyMatrix4(M);
        var P = g0.getAttribute("position"), N = g0.getAttribute("normal");
        for(var i = 0; i < P.count; i++){ pos.push(P.getX(i), P.getY(i), P.getZ(i)); if(N) nor.push(N.getX(i), N.getY(i), N.getZ(i)); else nor.push(0, 1, 0); }
        g0.dispose(); if(o.parent) o.parent.remove(o); o.geometry.dispose();
      });
      var mg = new T.BufferGeometry(); mg.setAttribute("position", new T.Float32BufferAttribute(pos, 3)); mg.setAttribute("normal", new T.Float32BufferAttribute(nor, 3));
      var mm = new T.Mesh(mg, G.m); mm.castShadow = true; parentG.add(mm);
    });
  }
  function slim(B0){
    try {
      merge(B0.g, [B0.rotor, B0.beam].concat(B0.tail && B0.tail.parent ? [B0.tail.parent] : []));
      merge(B0.blades, []); merge(B0.rotor, [B0.blades, B0.disc]); if(B0.tail) merge(B0.tail, []);
    } catch(e){}
  }
  // rotor-wash dust: 64 points round the skids, a pure function of time (Calm: none)
  var N = 64, pos = new Float32Array(N*3), dG = new T.BufferGeometry(); dG.setAttribute("position", new T.BufferAttribute(pos, 3));
  // soft round puffs (a radial canvas sprite), not hard squares
  var puff = null;
  try { if(typeof document !== "undefined"){ var cv = document.createElement("canvas"); cv.width = cv.height = 32; var gx = cv.getContext("2d");
    var gr = gx.createRadialGradient(16, 16, 0, 16, 16, 16); gr.addColorStop(0, "rgba(255,255,255,1)"); gr.addColorStop(1, "rgba(255,255,255,0)");
    gx.fillStyle = gr; gx.fillRect(0, 0, 32, 32); puff = new T.CanvasTexture(cv); } } catch(e){ puff = null; }
  var dust = new T.Points(dG, new T.PointsMaterial({color: 0xc8b89a, size: 1.4, map: puff, transparent: true, opacity: 0.5, depthWrite: false}));
  dust.visible = false; dust.frustumCulled = false; if(parent && parent.add) parent.add(dust);
  function show(paint, livery){
    var k = (livery ? "cab" : "own") + ":" + paint;
    if(B && key === k){ g.visible = true; return; }
    if(B){ g.remove(B.g); B = null; }
    if(HM && HM.model){
      try { B = livery ? HM.model(c, "heli", 0xf3ede2, 0xc9643b) : HM.model(c, "heli", paint != null ? paint : null, null); } catch(e){ B = null; }
      if(B){ slim(B); g.add(B.g); }
    }
    key = k; g.visible = true;
  }
  function hide(){ g.visible = false; dust.visible = false; }
  var calls = 0;
  function update(p, t, dt){
    if(!p || !g.visible){ dust.visible = false; calls = 0; return; }
    g.position.set(p.x, p.y, p.z); g.rotation.set(0, 0, 0); g.rotateY(p.yaw); g.rotateX(-p.pitch); g.rotateZ(p.roll || 0);
    if(B && HM && HM.animate) try { HM.animate(B, {rpm: p.rpm, t: t, ground: p.phase === "spool" || p.phase === "settle"}, dt, !!(deps.night && deps.night())); } catch(e){}
    var gy = w && w.ground ? num(w.ground(p.x, p.z), 0) : 0, agl = p.y - gy, calm = false; try { calm = !!calmF(); } catch(e){}
    dust.visible = !calm && agl < 15 && p.rpm > 0.5;
    if(dust.visible){
      var k = clamp(1 - agl/15, 0, 1);
      for(var i = 0; i < N; i++){
        var a = i*2.399963 + t*0.9, r = 3 + ((i*37) % 11) + ((t*6 + i*0.7) % 6), h = ((t*2 + i*0.31) % 1.6)*k;
        pos[3*i] = p.x + Math.sin(a)*r; pos[3*i + 1] = gy + 0.2 + h; pos[3*i + 2] = p.z + Math.cos(a)*r;
      }
      dG.attributes.position.needsUpdate = true;
      dust.material.opacity = 0.45*k;
    }
    calls = 0;
    g.traverse(function(o){ if((o.isMesh || o.isSprite) && o.visible){ var v = true; for(var q = o.parent; q; q = q.parent) if(!q.visible){ v = false; break; } if(v) calls++; } });
    if(dust.visible) calls++;
  }
  return {
    show: show, hide: hide, update: update, drawCalls: function(){ return calls; },
    seat: function(){ var s = B && B.seat ? B.seat.position : null; return s ? {x: -s.x, y: s.y, z: s.z - 1.3} : {x: 0.4, y: 1.1, z: -0.45}; },
    dispose: function(){
      [g, dust].forEach(function(o){ if(o.parent) o.parent.remove(o); o.traverse(function(n){ if(n.geometry) n.geometry.dispose(); }); });
      if(puff) puff.dispose(); dust.material.dispose();
    }
  };
}

HQV.hqHeliCall = {spots: spots, clearAt: clearAt, path: path, doppler: doppler, mount: mount,
                  consts: {CRUISE_H: CRUISE_H, CRUISE_V: CRUISE_V, GLIDE: GLIDE, CLIMB: CLIMB, FLARE_H: FLARE_H, FLARE_L: FLARE_L,
                           TAXI_H: TAXI_H, TAXI_L: TAXI_L, OPEN_HALF: OPEN_HALF, OPEN_R: OPEN_R, OPEN_N: OPEN_N, SLOPE: SLOPE, ROAD_CLEAR: ROAD_CLEAR}};
})();
