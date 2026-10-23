/* Claude HQ: stunts across the 3D City (HQV.hqStunts; games/hqcity3d.js places and draws them, games/hq3d.js flies you).
 *
 * Every city gets its own set, read off its generated layout (pure, deterministic: every client builds the same):
 *   loop     MEGA LOOP: a 26 m loop-the-loop with a corkscrew offset, on the straightest open ground nearest the middle.
 *   cannon   SKY CANNON (two): a 14 m kicker fires you 200-640 m over the rooftops, through three rings of fire, onto a
 *            landing ramp; the lowest launch angle whose flight clears the skyline by SKY_GAP m.
 *   bigair   BIG AIR: the same, 70-190 m.
 *   river    RIVER LEAP (up to three): square across the river, bank to bank.
 *   sea      SEA LAUNCH: on an island, a kicker at the coast that throws you out over open sea to splash down.
 * Every jump has a boost pad on its run-up: it sets the exact speed its flight was built for, so any car, motorbike
 * or bicycle lands it. A landing ramp follows that flight just under it to the target, then runs straight down along
 * the fall there: a touch-down anywhere on it is along it.
 *
 * claim(W, tier, Q) -> W.stunts = {list, pieces, pads, loops, hoops}   memoised; after the shops, before the City
 *   indexes or builds anything. Open land is a GRID m grid: no road (and ROAD_GAP m of pavement), river, sea, site,
 *   HQ lot, tower district or another stunt. A building lot elsewhere may be cleared (at most MAX_LOTS a stunt): it is
 *   retyped "stunt" (l.was keeps the kind; world.js cacheCopy puts it back), so nothing is drawn there or blocks it.
 *   Each stunt registers a named site {kind: "stunt"} (Go to lists it; trees keep off) and its other parts unnamed
 *   {kind: "stuntland"}. A deck sits flush with the ground where you drive on (and a landing's where you drive off).
 *   stunt = {id (kind:x:z, stable), kind, name, x, z, yaw, pieces, pads, hoops, loops, jump | null, respawn {x, z, yaw}}
 *   piece = {kind, x, z (its u = 0), ux, uz, len, hw, base (m), prof: [height over base every PROF_STEP m]}
 *   pad   = {x, z, ux, uz, len, hw, v (m/s), yaw}            hoop = {x, y, z, ux, uz, r}
 *   jump  = {lip {x, y, z}, ux, uz, theta, v, D, Dland, target {x, y, z}, apex, t, splash}
 *   loop  = {x, y, z (its start), ux, uz, R, shift, vmin}
 *
 * Pure (node-tested, tests/test_hqstunts.py): surfaceAt, slopeAt, padAt, loopAt, launchSpeed, flightY, kickerGeom,
 *   newAir / airStep (the exact parabola: the same flight at any frame rate) / landing / score, hoopCross, loopPose;
 *   api(S) -> the queries hq3d flies by (no drawing needed).
 * create(c, W, o) -> {g, update(t, dt, cam), setNight, drawCalls, destroy, list}   o: {scene, ground(x, z)}
 *   One stunt draws in at most six meshes (structure, neon, pads, rings, sign, its posts), hidden past FAR m.
 */
(function(){
"use strict";
var root = typeof window !== "undefined" ? window : globalThis;
var HQV = root.HQV = root.HQV || {};
var PI = Math.PI, TAU = 2*PI, G = 9.81;

var PROF_STEP = 0.5;      // m between a piece's profile samples
var CELL = 2.5;           // m: footprint test grid
var ROAD_GAP = 1.5;       // m kept off a carriageway's edge (pavement included in half)
var RUNWAY = 30;          // m of flat run-up before a kicker (the pad sits on it)
var RUNOUT = 26;          // m of flat after a landing ramp
var DECK = 0.3;           // m: a flat deck's height
var MAX_LOTS = 8;         // building lots one stunt may clear
var SKY_GAP = 8;          // m kept over the skyline by a flight
var V_MAX = 95;           // m/s: the fastest a pad fires you
var FAR = 1100;           // m: past this from the camera a stunt is not drawn
var LOOP_R = 13;          // m
var NAMES = {cannon: "Sky Cannon", river: "River Leap", loop: "Mega Loop", bigair: "Big Air", sea: "Sea Launch"};
var NEON = {cannon: 0xff2bd6, river: 0x22e6ff, loop: 0xffd21a, bigair: 0x7cff3a, sea: 0x3a8bff};
var BAD_DISTRICT = {downtown: 1, finance: 1, office: 1};   // their towers stay: stunts only clear lower blocks' lots

function clamp(v, a, b){ return v < a ? a : v > b ? b : v; }
function hyp(a, b){ return Math.sqrt(a*a + b*b); }
function wrap(a){ return Math.atan2(Math.sin(a), Math.cos(a)); }
function hash32(s){
  var h = 0x811c9dc5; s = String(s);
  for(var i = 0; i < s.length; i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

/* ---------- profiles (heights over a piece's base, every PROF_STEP m) ---------- */
function flatProf(len, h){ var n = Math.max(2, Math.ceil(len/PROF_STEP) + 1), p = []; for(var i = 0; i < n; i++) p.push(h); return p; }
// a kicker: DECK, then a circular transition up to theta at its lip (u = len), Hk high
function kickerGeom(Hk, theta){ var R = Hk/(1 - Math.cos(theta)); return {R: R, len: R*Math.sin(theta), H: Hk}; }
function kickerProf(Hk, theta){
  var K = kickerGeom(Hk, theta), n = Math.ceil(K.len/PROF_STEP) + 1, p = [];
  for(var i = 0; i < n; i++){ var u = Math.min(K.len, i*PROF_STEP); p.push(Math.max(DECK, K.R - Math.sqrt(Math.max(0, K.R*K.R - u*u)))); }
  p[n - 1] = Math.max(DECK, Hk);
  return p;
}
function profAt(pc, u){
  if(u < 0 || u > pc.len) return null;
  var f = u/PROF_STEP, i = Math.floor(f), P = pc.prof;
  if(i >= P.length - 1) return P[P.length - 1];
  return P[i] + (P[i + 1] - P[i])*(f - i);
}
function piece(kind, x, z, ux, uz, hw, base, prof){ return {kind: kind, x: x, z: z, ux: ux, uz: uz, hw: hw, base: base, prof: prof, len: (prof.length - 1)*PROF_STEP}; }
function local(pc, x, z){ var dx = x - pc.x, dz = z - pc.z; return {u: dx*pc.ux + dz*pc.uz, l: dx*pc.uz - dz*pc.ux}; }

/* ---------- queries on a set of stunts (pure) ---------- */
function pieces(S){ return S && S.pieces ? S.pieces : []; }
function surfaceAt(S, x, z){
  var best = null, P = pieces(S);
  for(var i = 0; i < P.length; i++){
    var pc = P[i];
    if(Math.abs(x - pc.cx) > pc.rad || Math.abs(z - pc.cz) > pc.rad) continue;
    var q = local(pc, x, z); if(Math.abs(q.l) > pc.hw) continue;
    var h = profAt(pc, q.u); if(h == null) continue;
    h += pc.base; if(best == null || h > best) best = h;
  }
  return best;
}
function slopeAt(S, x, z, dx, dz){
  var n = hyp(dx, dz) || 1; dx /= n; dz /= n;
  var a = surfaceAt(S, x, z), b = surfaceAt(S, x - dx*0.5, z - dz*0.5);
  return a != null && b != null ? (a - b)/0.5 : 0;
}
function padAt(S, x, z, yaw){
  var L = S && S.pads ? S.pads : [];
  for(var i = 0; i < L.length; i++){
    var p = L[i], dx = x - p.x, dz = z - p.z, u = dx*p.ux + dz*p.uz, l = dx*p.uz - dz*p.ux;
    if(u >= 0 && u <= p.len && Math.abs(l) <= p.hw && Math.abs(wrap(yaw - p.yaw)) < 0.9) return p;
  }
  return null;
}
function loopAt(S, x, z, yaw){
  var L = S && S.loops ? S.loops : [];
  for(var i = 0; i < L.length; i++){
    var o = L[i], dx = x - o.x, dz = z - o.z, u = dx*o.ux + dz*o.uz, l = dx*o.uz - dz*o.ux;
    if(u >= -1.5 && u <= 1.5 && Math.abs(l + o.shift/2) <= 3.2 && Math.abs(wrap(yaw - Math.atan2(o.ux, o.uz))) < 0.7) return o;
  }
  return null;
}
// the speed (horizontal, m/s) that carries a launch at theta from height y1 to y2, D m on: y = y1 + x tan(theta) - g x^2/(2 v^2)
function launchSpeed(D, y1, y2, theta){
  var den = 2*(y1 - y2 + D*Math.tan(theta));
  return den > 0 ? Math.sqrt(G*D*D/den) : Infinity;
}
function flightY(J, x){ return J.lip.y + x*Math.tan(J.theta) - G*x*x/(2*J.v*J.v); }

/* ---------- flying (pure) ---------- */
// st: {x, y, z, v (horizontal), vy, head, pitch, roll, id}
function newAir(st){
  return {x: st.x, y: st.y, z: st.z, v: st.v, vy: st.vy, head: st.head, pitch: st.pitch || Math.atan2(st.vy, Math.max(1, st.v)),
          roll: st.roll || 0, spin: 0, pv: 0, sv: 0, rv: 0, t: 0, x0: st.x, z0: st.z, y0: st.y, top: st.y, hoops: 0, id: st.id || null,
          p0: null, s0: 0, r0: 0};
}
// inp: {pitch, spin, roll} each -1..1 (W/S flips, A/D spins, Shift+A/D barrel rolls). With no input the nose eases to
// the way it is going (the nearest whole turn), so a flip you let go of finishes (or falls back) by itself
function airStep(A, inp, dt){
  inp = inp || {};
  A.t += dt;                                          // the exact parabola: the same flight at any frame rate
  A.x += Math.sin(A.head)*A.v*dt; A.z += Math.cos(A.head)*A.v*dt; A.y += A.vy*dt - 0.5*G*dt*dt; A.vy -= G*dt;
  if(A.y > A.top) A.top = A.y;
  var trj = Math.atan2(A.vy, Math.max(1, A.v));
  if(A.p0 == null) A.p0 = A.pitch - trj;
  function axis(val, rate, input, target){
    if(input) return {r: input*rate, val: val + input*rate*dt};
    var tgt = target + TAU*Math.round((val - target)/TAU), k = 1 - Math.exp(-dt*4.5);
    return {r: 0, val: val + (tgt - val)*k};
  }
  var p = axis(A.pitch - trj, 5.2, inp.pitch || 0, 0); A.pitch = p.val + trj;
  var s = axis(A.spin, 6.0, inp.spin || 0, 0); A.spin = s.val;
  var r = axis(A.roll, 5.5, inp.roll || 0, 0); A.roll = r.val;
  return A;
}
// landing on ground graded groundSlope (rise per m along the way it goes): clean when the nose, the spin and the roll
// are all within a quarter-turn-ish of square
function landing(A, groundSlope){
  var trj = Math.atan(groundSlope || 0), rel = A.pitch - trj;
  var flips = Math.round(rel/TAU), spins = Math.round(A.spin/TAU), rolls = Math.round(A.roll/TAU);
  var ep = Math.abs(rel - flips*TAU), es = Math.abs(A.spin - spins*TAU), er = Math.abs(A.roll - rolls*TAU);
  var clean = ep < 0.8 && es < 0.75 && er < 0.75;
  return {clean: clean, flips: flips, spins: Math.abs(spins), rolls: Math.abs(rolls), err: Math.max(ep, es, er)};
}
function plural(n, one){ return n > 1 ? one + " x" + n : one; }
function score(A, L, extra){
  var dist = hyp(A.x - A.x0, A.z - A.z0), high = Math.max(0, A.top - A.y0), parts = [];
  var pts = Math.round(A.t*120 + high*12 + dist*2);
  if(L.flips){ parts.push(plural(Math.abs(L.flips), L.flips < 0 ? "FRONTFLIP" : "BACKFLIP")); pts += 1500*Math.abs(L.flips); }
  if(L.spins){ parts.push(plural(L.spins, "360")); pts += 800*L.spins; }
  if(L.rolls){ parts.push(plural(L.rolls, "BARREL ROLL")); pts += 1200*L.rolls; }
  if(A.hoops){ parts.push(plural(A.hoops, "RING OF FIRE")); pts += 750*A.hoops; }
  if(extra) parts.push(extra);
  var air = A.t >= 6 ? "INSANE AIR" : A.t >= 3.5 ? "MEGA AIR" : A.t >= 1.5 ? "BIG AIR" : "AIR";
  if(!L.clean) pts = Math.round(pts*0.1);
  return {points: pts, air: air, text: air + " " + A.t.toFixed(1) + " s · " + Math.round(high) + " m high · " + Math.round(dist) + " m" +
          (parts.length ? " · " + parts.join(" · ") : "") + (L.clean ? "" : " · BAIL") + "  +" + pts};
}
// does p0 -> p1 pass through ring h (its disc, facing along (ux, uz))?
function hoopCross(h, p0, p1){
  var a = (p0.x - h.x)*h.ux + (p0.z - h.z)*h.uz, b = (p1.x - h.x)*h.ux + (p1.z - h.z)*h.uz;
  if((a < 0) === (b < 0) || a === b) return false;
  var k = a/(a - b), x = p0.x + (p1.x - p0.x)*k, y = p0.y + (p1.y - p0.y)*k, z = p0.z + (p1.z - p0.z)*k;
  return hyp(hyp(x - h.x, z - h.z), y - h.y) <= h.r;
}
// the loop: phi 0..TAU from its start, rising along +u, sliding shift m left to right over the turn
function loopPose(L, phi){
  var along = L.R*Math.sin(phi), up = L.R*(1 - Math.cos(phi)), side = -L.shift/2 + L.shift*phi/TAU;
  return {x: L.x + L.ux*along + L.uz*side, y: L.y + up, z: L.z + L.uz*along - L.ux*side, pitch: phi, yaw: Math.atan2(L.ux, L.uz)};
}

/* ---------- claim: where they go (pure) ---------- */
function landOf(W, tier){
  var O = HQV.ocean;
  if(!W.island || !O || !O.seaOf) return null;
  try { var s = O.seaOf({layers: {island: W.island, river: W.river}}, null, tier); return s && s.land; } catch(e){ return null; }
}

function claim(W, tier, Q){
  if(!W) return null;
  if(W.stunts) return W.stunts;
  Q = Q || HQV.world;
  tier = tier == null ? 5 : tier | 0;
  var out = {list: []};
  if(!Q || !Q.nearestRoad || !W.lots || !W.edges){ W.stunts = out; return finish(out); }
  var leg = (W.districts && W.districts.legend) || [], full = W.half || 1024, half = full - 30, land = landOf(W, tier);
  function shown(o){ return o.min_tier == null || (o.min_tier | 0) <= tier; }
  function gnd(x, z){ return Q.groundAt(W, x, z); }
  function hCm(x, z){ return Q.heightCm ? Q.heightCm(W, Math.round(x*100), Math.round(z*100)) | 0 : Math.round(gnd(x, z)*100); }
  function wet(x, z){ return !!(W.river && Q.riverAt && Q.riverAt(W, x, z)) || !!(land && !land(x, z)); }

  // the free-land grid, GRID m a cell: 0 open, -1 not for stunts, k > 0 building lot k - 1 (cleared if a stunt needs it)
  var GRID = 4, n = Math.ceil(2*full/GRID), cells = new Int32Array(n*n);
  function ci(x, z){ var i = Math.floor((x + full)/GRID), k = Math.floor((z + full)/GRID); return i < 0 || k < 0 || i >= n || k >= n ? -1 : k*n + i; }
  function fillRect(x0, z0, x1, z1, v, keepBlocked){
    var i0 = Math.max(0, Math.floor((x0 + full)/GRID)), i1 = Math.min(n - 1, Math.floor((x1 + full)/GRID));
    var k0 = Math.max(0, Math.floor((z0 + full)/GRID)), k1 = Math.min(n - 1, Math.floor((z1 + full)/GRID));
    for(var k = k0; k <= k1; k++) for(var i = i0; i <= i1; i++){ var j = k*n + i; if(!(keepBlocked && cells[j] < 0)) cells[j] = v; }
  }
  W.lots.forEach(function(l, idx){
    if(!l) return;
    var ok = l.kind === "building" && !BAD_DISTRICT[leg[l.district]] && shown(l);
    fillRect((l.x - l.w/2)/100, (l.z - l.d/2)/100, (l.x + l.w/2)/100, (l.z + l.d/2)/100, ok ? idx + 1 : -1, true);
  });
  W.sites.forEach(function(st){ if(st) fillRect((st.x - st.w/2)/100 - 2, (st.z - st.d/2)/100 - 2, (st.x + st.w/2)/100 + 2, (st.z + st.d/2)/100 + 2, -1); });
  // the skyline, the same grid: the top of what stands on each cell (0: open ground, its trees are added per query)
  var tops = new Float32Array(n*n);
  function topRect(o, h){
    var x0 = (o.x - o.w/2)/100, x1 = (o.x + o.w/2)/100, z0 = (o.z - o.d/2)/100, z1 = (o.z + o.d/2)/100;
    var i0 = Math.max(0, Math.floor((x0 + full)/GRID)), i1 = Math.min(n - 1, Math.floor((x1 + full)/GRID));
    var k0 = Math.max(0, Math.floor((z0 + full)/GRID)), k1 = Math.min(n - 1, Math.floor((z1 + full)/GRID));
    for(var k = k0; k <= k1; k++) for(var i = i0; i <= i1; i++) if(tops[k*n + i] < h) tops[k*n + i] = h;
  }
  W.lots.forEach(function(l){ if(l && l.kind !== "stunt") topRect(l, gnd(l.x/100, l.z/100) + (l.kind === "landmark" ? 260 : Math.max(1, l.floors | 0)*3.5 + 10)); });
  W.sites.forEach(function(st){ if(st && st.kind !== "stunt" && st.kind !== "stuntland") topRect(st, gnd(st.x/100, st.z/100) + (st.kind === "landmark" ? 260 : st.kind === "funpark" ? 70 : 50)); });
  W.edges.forEach(function(e){
    if(!e || !e.pts || !shown(e)) return;
    var r = (e.width || 800)/200 + ROAD_GAP + GRID*0.71, P = e.pts;
    for(var j = 0; j + 5 < P.length; j += 3){
      var ax = P[j]/100, az = P[j + 2]/100, bx = P[j + 3]/100, bz = P[j + 5]/100, L = hyp(bx - ax, bz - az), m = Math.max(1, Math.ceil(L/2));
      for(var t = 0; t <= m; t++){ var x = ax + (bx - ax)*t/m, z = az + (bz - az)*t/m; fillRect(x - r, z - r, x + r, z + r, -1); }
    }
  });
  for(var k = 0; k < n; k++) for(var i = 0; i < n; i++){
    var x = -full + (i + 0.5)*GRID, z = -full + (k + 0.5)*GRID, j = k*n + i;
    if(cells[j] < 0) continue;
    if(Math.abs(x) > half || Math.abs(z) > half || wet(x, z)) cells[j] = -1;
  }
  // an oriented footprint (u0..u1 along (ux, uz), +-hw across) on open land; building lots under it go into lots
  function areaOk(x, z, ux, uz, u0, u1, hw, lots, st){
    st = st || 2;
    for(var u = u0; u <= u1 + 1e-6; u += st) for(var l = -hw; l <= hw + 1e-6; l += st){
      var j = ci(x + ux*u + uz*l, z + uz*u - ux*l);
      if(j < 0 || cells[j] < 0) return false;
      if(cells[j] > 0) lots[cells[j] - 1] = 1;
    }
    return true;
  }
  function block(pc){
    for(var u = -4; u <= pc.len + 4; u += 2) for(var l = -pc.hw - 4; l <= pc.hw + 4; l += 2){
      var j = ci(pc.x + pc.ux*u + pc.uz*l, pc.z + pc.uz*u - pc.ux*l); if(j >= 0) cells[j] = -1;
    }
  }
  function count(o){ return Object.keys(o).length; }
  function baseOf(x, z, ux, uz, u0, u1, hw){
    var b = -1e9;
    for(var u = u0; u <= u1 + 1e-6; u += 4) for(var l = -hw; l <= hw; l += hw) b = Math.max(b, gnd(x + ux*u + uz*l, z + uz*u - ux*l));
    return b;
  }
  // what stands at (x, z), as a height a flight must clear (open ground: its trees)
  function topAt(x, z){
    var j = ci(x, z), t = j >= 0 ? tops[j] : 0;
    return t ? t : gnd(x, z) + (wet(x, z) ? 2 : 13);
  }
  // the flight over everything between its kicker and its landing ramp (over its own structures it is clear)
  function skyOk(J, to){
    var px = J.uz, pz = -J.ux, end = to == null ? J.D - 6 : to;
    for(var x = 6; x < end; x += 5){
      var y = flightY(J, x), cx = J.lip.x + J.ux*x, cz = J.lip.z + J.uz*x;
      for(var l = -5; l <= 5; l += 5) if(y < topAt(cx + px*l, cz + pz*l) + (l ? 2 : 3)) return false;
    }
    return true;
  }
  function far(x, z, d){ return out.list.every(function(s){ return hyp(s.x - x, s.z - z) >= d; }); }

  // a jump: run-up and kicker ending at its lip (lx, lz), the landing ramp starting Dland m on (none: the sea)
  function makeJump(kind, lx, lz, ux, uz, Hk, theta, Dland, Ht, opts){
    opts = opts || {};
    var K = kickerGeom(Hk, theta), hw = opts.hw || 7, kStart = -(K.len + RUNWAY);
    // flush with the ground where you drive on (its high end stands clear of it); too steep a slope under it: no
    var bA = gnd(lx + ux*kStart, lz + uz*kStart);
    if(baseOf(lx, lz, ux, uz, kStart, 0, hw) - bA > 3) return null;
    var lip = {x: lx, y: bA + Hk, z: lz}, J = {lip: lip, ux: ux, uz: uz, theta: theta, splash: !!opts.splash, Dland: opts.splash ? 0 : Dland}, landP = null;
    if(!opts.splash){
      // the landing ramp follows the flight just under it for PRE m, meeting it at the target (Ht over its base), then runs straight
      // down along the fall there to the deck and the run-out: a flight from the pad never meets its face, and a
      // touch-down anywhere on it is along it
      var PRE = 16, sx = lx + ux*Dland, sz = lz + uz*Dland, bB = gnd(sx, sz), slopeT = 0.6;
      J.D = Dland + PRE;
      for(var pass = 0; pass < 3; pass++){
        var post = (Ht - DECK)/slopeT, endU = PRE + post + RUNOUT;
        bB = gnd(sx + ux*endU, sz + uz*endU);                       // flush where you drive off its run-out
        J.target = {x: lx + ux*J.D, y: bB + Ht, z: lz + uz*J.D};
        J.v = launchSpeed(J.D, lip.y, J.target.y, theta);
        if(!isFinite(J.v)) return null;
        slopeT = clamp(G*J.D/(J.v*J.v) - Math.tan(theta), 0.25, 1.2);
      }
      if(baseOf(sx, sz, ux, uz, 0, endU, hw + 1) - bB > 3) return null;
      var prof = [], n = Math.ceil(endU/PROF_STEP) + 1;
      for(var i = 0; i < n; i++){
        var u = i*PROF_STEP, h;
        if(u <= PRE) h = flightY(J, Dland + u) - 0.35*(1 - u/PRE) - bB;     // just under the flight, meeting it at the target
        else h = Math.max(DECK, Ht - (u - PRE)*slopeT);
        prof.push(Math.max(DECK, h));
      }
      landP = piece("landing", sx, sz, ux, uz, hw + 1, bB, prof);
    } else { J.v = opts.v; J.D = J.v*J.v*Math.sin(2*theta)/G; J.target = {x: lx + ux*J.D, y: lip.y, z: lz + uz*J.D}; }
    if(!(J.v > 4) || J.v > V_MAX) return null;
    J.t = J.D/J.v; var xa = J.v*J.v*Math.tan(theta)/G; J.apex = flightY(J, Math.min(xa, J.D));
    var kick = piece("kicker", lx - ux*K.len, lz - uz*K.len, ux, uz, hw, bA, kickerProf(Hk, theta));
    var run = piece("deck", lx + ux*kStart, lz + uz*kStart, ux, uz, hw, bA, flatProf(RUNWAY, DECK)), yaw = Math.atan2(ux, uz);
    var hoops = [], rr = kind === "cannon" ? 11 : 8;
    (kind === "cannon" ? [0.28, 0.5, 0.72] : [0.5]).forEach(function(f){
      var x = opts.splash ? xa*(0.6 + f) : J.D*f;
      hoops.push({x: lx + ux*x, y: flightY(J, x), z: lz + uz*x, ux: ux, uz: uz, r: rr});
    });
    return {kind: kind, jump: J, pieces: landP ? [run, kick, landP] : [run, kick], loops: [], hoops: hoops, yaw: yaw,
            pads: [{x: run.x + ux*4, z: run.z + uz*4, ux: ux, uz: uz, len: RUNWAY - 8, hw: hw - 1, v: J.v, yaw: yaw}],
            respawn: {x: run.x + ux*1.5, z: run.z + uz*1.5, yaw: yaw}, start: {x: run.x, z: run.z}};
  }
  function piecesOk(s, lots){ return s.pieces.every(function(pc){ return areaOk(pc.x, pc.z, pc.ux, pc.uz, 0, pc.len, pc.hw, lots); }); }
  function commit(s, name, lots){
    s.name = name; s.x = s.start.x; s.z = s.start.z;
    s.id = s.kind + ":" + Math.round(s.x) + ":" + Math.round(s.z);   // stable for this layout (your best on it is kept by it)
    s.pieces.forEach(block);
    Object.keys(lots).forEach(function(k){ var l = W.lots[k]; if(l && l.kind === "building"){ l.was = l.kind; l.kind = "stunt"; } });
    s.cleared = count(lots);
    s.pieces.forEach(function(pc, i){
      var x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
      [[0, -pc.hw], [0, pc.hw], [pc.len, -pc.hw], [pc.len, pc.hw]].forEach(function(c){
        var x = pc.x + pc.ux*c[0] + pc.uz*c[1], z = pc.z + pc.uz*c[0] - pc.ux*c[1];
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z);
      });
      var cx = (x0 + x1)/2, cz = (z0 + z1)/2;
      W.sites.push({id: s.id + ":" + i, kind: i === 0 ? "stunt" : "stuntland", name: i === 0 ? name : undefined, block: null, pad: false, claimed: 1,
                    x: Math.round(cx*100), y: hCm(cx, cz), z: Math.round(cz*100), w: Math.round((x1 - x0)*100), d: Math.round((z1 - z0)*100),
                    facing: "north", tier: 1, front: [Math.round(pc.ux*65536), Math.round(pc.uz*65536)]});
    });
    out.list.push(s);
  }
  var DIRS = 16, STEP = 16;
  function dirs(seed){ var a0 = (hash32(W.hash + seed) % 997)/997*TAU/DIRS, L = []; for(var d = 0; d < DIRS; d++){ var a = a0 + d*TAU/DIRS; L.push([Math.sin(a), Math.cos(a)]); } return L; }
  function grid(seed, fn, step){
    step = step || STEP;
    var off = hash32(W.hash + seed) % step;
    for(var z = -half + off; z <= half; z += step) for(var x = -half + off; x <= half; x += step){ var j = ci(x, z); if(j >= 0 && cells[j] === 0) fn(x, z); }
  }

  // 3. MEGA LOOP: a straight 100 m of open land, nearest the middle of the city
  (function(){
    var best = null, D8 = dirs("loop"), runL = RUNWAY + 8, len = 2*runL + 2*LOOP_R;
    grid("loop", function(x, z){
      D8.forEach(function(d){
        var lots = {}; if(!areaOk(x, z, d[0], d[1], 0, len, 8, lots, 4) || count(lots) > MAX_LOTS) return;
        var sc = hyp(x, z) + 40*count(lots);
        if(best && sc >= best.sc) return;
        if(baseOf(x, z, d[0], d[1], 0, len, 8) - gnd(x, z) > 1.5) return;      // flat enough for its one deck
        best = {sc: sc, x: x, z: z, ux: d[0], uz: d[1], lots: lots};
      });
    });
    if(!best || !far(best.x, best.z, 150)) return;
    var ux = best.ux, uz = best.uz, x0 = best.x, z0 = best.z, yaw = Math.atan2(ux, uz);
    var bse = gnd(x0, z0), lx = x0 + ux*runL, lz = z0 + uz*runL;
    commit({kind: "loop", jump: null, hoops: [], yaw: yaw, start: {x: x0, z: z0},
            pieces: [piece("deck", x0, z0, ux, uz, 8, bse, flatProf(len, DECK))],
            pads: [{x: x0 + ux*4 - uz*3, z: z0 + uz*4 + ux*3, ux: ux, uz: uz, len: runL - 12, hw: 3, v: 31, yaw: yaw}],
            loops: [{x: lx, y: bse + DECK, z: lz, ux: ux, uz: uz, R: LOOP_R, shift: 6, vmin: Math.sqrt(5*G*LOOP_R)*0.85}],
            respawn: {x: x0 + ux*1.5 - uz*3, z: z0 + uz*1.5 + ux*3, yaw: yaw}}, NAMES.loop, best.lots);
  })();

  // 1. SKY CANNON (and BIG AIR, the short one): a kicker anywhere open, the longest flight over the rooftops into a
  // landing ramp on open land, the lowest launch angle that clears the skyline
  function launcher(kind, Hk, Ht, Dmin, Dmax, hw){
    var cand = [], D8 = dirs(kind), reach = half*0.72;
    grid(kind, function(x, z){
      if(hyp(x, z) > reach) return;                 // in the city, not out in the wilds at its edge
      D8.forEach(function(d){
        var ux = d[0], uz = d[1], back = kickerGeom(Hk, 0.62).len + RUNWAY, lots = {};
        if(!areaOk(x, z, ux, uz, -back, 0, hw, lots, 4) || count(lots) > MAX_LOTS) return;
        for(var D = Dmax; D >= Dmin; D -= 12){
          var lots2 = {}; if(!areaOk(x + ux*D, z + uz*D, ux, uz, 0, Ht/Math.tan(0.35) + RUNOUT, hw + 1, lots2, 4)) continue;
          if(count(lots) + count(lots2) > MAX_LOTS) continue;
          cand.push({x: x, z: z, ux: ux, uz: uz, D: D, lots: count(lots) + count(lots2), sc: D - 6*(count(lots) + count(lots2)) - 0.2*hyp(x, z)}); break;
        }
      });
    }, 24);
    cand.sort(function(p, q){ return q.sc - p.sc || p.x - q.x || p.z - q.z; });
    for(var i = 0; i < cand.length && i < 150; i++){
      var c = cand[i];
      if(!far(c.x, c.z, 220) || !far(c.x + c.ux*c.D, c.z + c.uz*c.D, 160)) continue;
      for(var theta = 0.55; theta <= 0.9; theta += 0.08){
        var s = makeJump(kind, c.x, c.z, c.ux, c.uz, Hk, theta, c.D, Ht, {hw: hw}), lots = {};
        if(!s || !piecesOk(s, lots) || count(lots) > MAX_LOTS) continue;
        if(!skyOk(s.jump, s.jump.Dland - 2)) continue;
        commit(s, NAMES[kind], lots); return true;
      }
    }
    return false;
  }
  launcher("cannon", 14, 16, 200, 640, 7) && launcher("cannon", 14, 16, 200, 640, 7);
  launcher("bigair", 11, 9, 70, 190, 7);

  // 2. RIVER LEAP: across the river, square to its course, at most 3 and 250 m apart
  var RC = W.river && W.river.center, leaps = 0;
  if(RC && RC.length > 2){
    var order = []; for(var q = 1; q < RC.length - 1; q++) order.push(q);
    order.sort(function(a, b){ return hash32(W.hash + "rv" + a) - hash32(W.hash + "rv" + b); });
    for(var oi = 0; oi < order.length && leaps < 3; oi++){
      var q0 = order[oi], cx = RC[q0][0]/100, cz = RC[q0][1]/100;
      if(!far(cx, cz, 250)) continue;
      var tx = (RC[q0 + 1][0] - RC[q0 - 1][0])/100, tz = (RC[q0 + 1][1] - RC[q0 - 1][1])/100, tl = hyp(tx, tz) || 1;
      var sgn = hash32(W.hash + "rs" + q0) & 1 ? 1 : -1, ux = -tz/tl*sgn, uz = tx/tl*sgn;
      var w0 = null, w1 = null;
      for(var u = -80; u <= 80; u += 1){ var wt = Q.riverAt(W, cx + ux*u, cz + uz*u); if(wt && w0 == null) w0 = u; if(wt) w1 = u; else if(w0 != null && u > w1 + 3) break; }
      if(w0 == null || w1 - w0 > 90) continue;
      var done = false;
      for(var back = 40; back >= 5 && !done; back -= 5) for(var fwd = 40; fwd >= 5 && !done; fwd -= 5){
        var lipU = w0 - back, lots = {};
        var s = makeJump("river", cx + ux*lipU, cz + uz*lipU, ux, uz, 9, 0.68, w1 + fwd - lipU, 7, {hw: 6});
        if(!s || !piecesOk(s, lots) || count(lots) > MAX_LOTS || !skyOk(s.jump, s.jump.Dland ? s.jump.Dland - 2 : null)) continue;
        commit(s, NAMES.river, lots); leaps++; done = true;
      }
    }
  }

  // 4. SEA LAUNCH: on an island, a kicker at the coast aimed out over open sea
  if(land){
    var ox = 0, oz = 0, sp = W.sites.filter(function(st){ return st && st.kind === "spawn"; })[0];
    if(sp){ ox = sp.x/100; oz = sp.z/100; }
    var N = 64, a0 = (hash32(W.hash + "sea") % 1000)/1000*TAU, seaDone = false;
    for(var kk = 0; kk < N && !seaDone; kk++){
      var ang = a0 + kk*TAU/N, sux = Math.sin(ang), suz = Math.cos(ang), lastLand = null;
      for(var r = 50; r < full*1.5; r += 5){ if(land(ox + sux*r, oz + suz*r)) lastLand = r; else if(lastLand != null && r > lastLand + 40) break; }
      if(lastLand == null) continue;
      for(var back2 = 6; back2 <= 60 && !seaDone; back2 += 6){
        var lipR = lastLand - back2, lots3 = {};
        var s3 = makeJump("sea", ox + sux*lipR, oz + suz*lipR, sux, suz, 10, 0.62, 0, 0, {hw: 7, splash: true, v: 52});
        if(!s3 || !piecesOk(s3, lots3) || count(lots3) > MAX_LOTS || !far(s3.start.x, s3.start.z, 200)) continue;
        var J = s3.jump, clear = true;
        for(var xx = 8; xx < J.D && clear; xx += 6){ var fx = J.lip.x + sux*xx, fz = J.lip.z + suz*xx; if(flightY(J, xx) < topAt(fx, fz, lots3) + SKY_GAP) clear = false; }
        if(clear){ commit(s3, NAMES.sea, lots3); seaDone = true; }
      }
    }
  }

  W.index = null; W.docView = null;              // world.js rebuilds both with the new sites and lot kinds
  W.stunts = out;
  return finish(out);
}
function finish(out){
  out.pieces = []; out.pads = []; out.loops = []; out.hoops = [];
  out.list.forEach(function(s){
    s.pieces.forEach(function(pc){
      pc.cx = pc.x + pc.ux*pc.len/2; pc.cz = pc.z + pc.uz*pc.len/2; pc.rad = pc.len/2 + pc.hw + 1; pc.stunt = s.id; out.pieces.push(pc);
    });
    s.pads.forEach(function(p){ p.stunt = s.id; out.pads.push(p); });
    s.loops.forEach(function(p){ p.stunt = s.id; out.loops.push(p); });
    s.hoops.forEach(function(p){ p.stunt = s.id; out.hoops.push(p); });
  });
  return out;
}

/* ---------- drawing ---------- */
function Builder(){ this.p = []; this.c = []; }
Builder.prototype.tri = function(a, b, c, col){
  this.p.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
  for(var i = 0; i < 3; i++) this.c.push(col[0], col[1], col[2]);
};
Builder.prototype.quad = function(a, b, c, d, col){ this.tri(a, b, c, col); this.tri(a, c, d, col); };
Builder.prototype.box = function(cx, cy, cz, sx, sy, sz, yaw, col){
  var c = Math.cos(yaw), s = Math.sin(yaw), V = [];
  for(var i = 0; i < 8; i++){
    var lx = (i & 1 ? 1 : -1)*sx/2, ly = (i & 2 ? 1 : -1)*sy/2, lz = (i & 4 ? 1 : -1)*sz/2;
    V.push([cx + lx*c + lz*s, cy + ly, cz - lx*s + lz*c]);
  }
  var F = [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]];
  for(var f = 0; f < 6; f++) this.quad(V[F[f][0]], V[F[f][1]], V[F[f][2]], V[F[f][3]], col);
};
Builder.prototype.mesh = function(THREE, mat){
  if(!this.p.length) return null;
  var g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(this.p, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(this.c, 3));
  g.computeVertexNormals();
  return new THREE.Mesh(g, mat);
};
function rgb(h, k){ k = k == null ? 1 : k; return [((h >> 16) & 255)/255*k, ((h >> 8) & 255)/255*k, (h & 255)/255*k]; }
var C_RED = rgb(0xd8262e), C_WHITE = rgb(0xf2f0ea), C_SIDE = rgb(0x2a2e35), C_YEL = rgb(0xffc21a), C_STEEL = rgb(0x59636e), C_DARK = rgb(0x1c1f24);

// a piece: its deck (red and white bands, a yellow lip), its two sides and its ends down to the ground under it
function drawPiece(B, N, pc, ground, neon){
  var px = pc.uz, pz = -pc.ux, n = pc.prof.length, step = Math.max(1, Math.round(2/PROF_STEP));
  function P(u, l, y){ return [pc.x + pc.ux*u + px*l, y, pc.z + pc.uz*u + pz*l]; }
  var prev = null;
  for(var i = 0; i < n; i += step){
    var j = Math.min(n - 1, i), u = j*PROF_STEP, y = pc.base + pc.prof[j];
    var gl = Math.min(ground(P(u, -pc.hw, 0)[0], P(u, -pc.hw, 0)[2]), ground(P(u, pc.hw, 0)[0], P(u, pc.hw, 0)[2])) - 0.5;
    var cur = {u: u, y: y, g: Math.min(gl, pc.base - 0.5)};
    if(prev){
      var band = Math.floor(prev.u/4) & 1, col = pc.kind === "deck" ? C_DARK : (band ? C_RED : C_WHITE);
      if(pc.kind === "kicker" && j >= n - 1 - step) col = C_YEL;
      B.quad(P(prev.u, pc.hw, prev.y), P(cur.u, pc.hw, cur.y), P(cur.u, -pc.hw, cur.y), P(prev.u, -pc.hw, prev.y), col);
      B.quad(P(prev.u, pc.hw, prev.g), P(cur.u, pc.hw, cur.g), P(cur.u, pc.hw, cur.y), P(prev.u, pc.hw, prev.y), C_SIDE);
      B.quad(P(prev.u, -pc.hw, prev.y), P(cur.u, -pc.hw, cur.y), P(cur.u, -pc.hw, cur.g), P(prev.u, -pc.hw, prev.g), C_SIDE);
      if(pc.kind !== "deck"){                        // neon strips along both top edges
        N.quad(P(prev.u, pc.hw + 0.02, prev.y + 0.05), P(cur.u, pc.hw + 0.02, cur.y + 0.05), P(cur.u, pc.hw + 0.02, cur.y - 0.35), P(prev.u, pc.hw + 0.02, prev.y - 0.35), neon);
        N.quad(P(prev.u, -pc.hw - 0.02, prev.y - 0.35), P(cur.u, -pc.hw - 0.02, cur.y - 0.35), P(cur.u, -pc.hw - 0.02, cur.y + 0.05), P(prev.u, -pc.hw - 0.02, prev.y + 0.05), neon);
      }
    } else B.quad(P(u, -pc.hw, cur.g), P(u, pc.hw, cur.g), P(u, pc.hw, y), P(u, -pc.hw, y), C_SIDE);
    prev = cur;
    if(j === n - 1) break;
    if(i + step > n - 1 && j < n - 1) i = n - 1 - step;
  }
  if(prev) B.quad(P(prev.u, pc.hw, prev.g), P(prev.u, -pc.hw, prev.g), P(prev.u, -pc.hw, prev.y), P(prev.u, pc.hw, prev.y), C_SIDE);
  // a kicker's back: steel trusses under its high end
  if(pc.kind === "kicker" || pc.kind === "landing"){
    var hiU = pc.kind === "kicker" ? pc.len - 1 : 1, yy = pc.base + profAt(pc, hiU), yaw = Math.atan2(pc.ux, pc.uz);
    [-pc.hw + 0.4, 0, pc.hw - 0.4].forEach(function(l){ var q = P(hiU, l, 0), g0 = ground(q[0], q[2]); B.box(q[0], (yy + g0)/2, q[2], 0.5, Math.max(0.5, yy - g0), 0.5, yaw, C_STEEL); });
  }
}
function drawPad(B, p){
  var px = p.uz, pz = -p.ux, n = Math.floor(p.len/3);
  for(var i = 0; i < n; i++){
    var u = i*3 + 0.5, a = [p.x + p.ux*u + px*p.hw, 0, p.z + p.uz*u + pz*p.hw], b = [p.x + p.ux*(u + 1.6) + px*0, 0, p.z + p.uz*(u + 1.6)],
        c = [p.x + p.ux*u - px*p.hw, 0, p.z + p.uz*u - pz*p.hw], m = [p.x + p.ux*(u + 0.9), 0, p.z + p.uz*(u + 0.9)];
    B.tri(a, m, b, C_WHITE); B.tri(m, c, b, C_WHITE);
  }
}
function drawRing(B, h, tubes){
  var px = h.uz, pz = -h.ux, seg = 40, ts = 8, tr = tubes || 0.55;
  for(var i = 0; i < seg; i++) for(var j = 0; j < ts; j++){
    var V = [];
    [[i, j], [i + 1, j], [i + 1, j + 1], [i, j + 1]].forEach(function(q){
      var a = q[0]/seg*TAU, b = q[1]/ts*TAU, R = h.r + tr*Math.cos(b);
      var l = Math.cos(a)*R, y = Math.sin(a)*R, f = tr*Math.sin(b);
      V.push([h.x + px*l + h.ux*f, h.y + y, h.z + pz*l + h.uz*f]);
    });
    B.quad(V[0], V[1], V[2], V[3], (i + j) & 1 ? rgb(0xff6a00) : rgb(0xffb000));
  }
}
function drawLoop(B, N, L, neon){
  var seg = 72, hw = 3.6, prev = null;
  for(var i = 0; i <= seg; i++){
    var phi = i/seg*TAU, P = loopPose(L, phi), cx = P.x, cz = P.z;
    // the track's inward normal and its sideways axis
    var nU = -Math.sin(phi), nY = Math.cos(phi), px = L.uz, pz = -L.ux;
    var a = [cx + px*hw, P.y, cz + pz*hw], b = [cx - px*hw, P.y, cz - pz*hw];
    var cur = {a: a, b: b, a2: [a[0] - L.ux*nU*0.6, a[1] - nY*0.6, a[2] - L.uz*nU*0.6], b2: [b[0] - L.ux*nU*0.6, b[1] - nY*0.6, b[2] - L.uz*nU*0.6]};
    if(prev){
      B.quad(prev.a, cur.a, cur.b, prev.b, (i >> 2) & 1 ? C_RED : C_WHITE);
      B.quad(prev.b2, cur.b2, cur.a2, prev.a2, C_SIDE);
      B.quad(prev.a2, cur.a2, cur.a, prev.a, C_SIDE); B.quad(prev.b, cur.b, cur.b2, prev.b2, C_SIDE);
      N.quad(prev.a, cur.a, [cur.a[0], cur.a[1] + 0.35*nY, cur.a[2]], [prev.a[0], prev.a[1] + 0.35*nY, prev.a[2]], neon);
      N.quad([prev.b[0], prev.b[1] + 0.35*nY, prev.b[2]], [cur.b[0], cur.b[1] + 0.35*nY, cur.b[2]], cur.b, prev.b, neon);
    }
    prev = cur;
  }
  // two A-frame towers either side of the top
  var top = loopPose(L, PI), yaw = Math.atan2(L.ux, L.uz);
  [-1, 1].forEach(function(sd){
    var x = top.x + L.uz*(sd*6.5), z = top.z - L.ux*(sd*6.5);
    B.box(x, L.y + L.R, z, 0.7, 2*L.R + 0.6, 0.7, yaw, C_STEEL);
    B.box((x + top.x)/2, top.y + 0.6, (z + top.z)/2, 0.5, 0.5, 6.5, yaw + PI/2, C_STEEL);
  });
}
function signTex(THREE, text, col){
  if(typeof document === "undefined") return null;
  var cv = document.createElement("canvas"); cv.width = 512; cv.height = 128;
  var x = cv.getContext("2d"); if(!x) return null;
  x.fillStyle = "#101216"; x.fillRect(0, 0, 512, 128);
  x.strokeStyle = "#" + ("000000" + col.toString(16)).slice(-6); x.lineWidth = 10; x.strokeRect(6, 6, 500, 116);
  x.fillStyle = "#ffffff"; x.font = "bold 64px system-ui, sans-serif"; x.textAlign = "center"; x.textBaseline = "middle";
  x.fillText(text.toUpperCase(), 256, 68);
  var t = new THREE.CanvasTexture(cv); if(THREE.SRGBColorSpace) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function create(c, W, o){
  var THREE = c.THREE, S = W && W.stunts, ground = o.ground, g = new THREE.Group(), night = 0, groups = [], mats = [];
  g.name = "stunts";
  if(!S || !S.list.length) return null;
  var matS = new THREE.MeshStandardMaterial({vertexColors: true, roughness: 0.62, metalness: 0.15});
  var matN = new THREE.MeshBasicMaterial({vertexColors: true, toneMapped: false});
  var matP = new THREE.MeshBasicMaterial({color: 0x39ff88, toneMapped: false, transparent: true, opacity: 0.85, depthWrite: false});
  var matR = new THREE.MeshBasicMaterial({vertexColors: true, toneMapped: false});
  mats.push(matS, matN, matP, matR);
  S.list.forEach(function(s){
    var sg = new THREE.Group(), B = new Builder(), N = new Builder(), P = new Builder(), R = new Builder(), neon = rgb(NEON[s.kind] || 0xffffff);
    s.pieces.forEach(function(pc){ drawPiece(B, N, pc, ground, neon); });
    s.loops.forEach(function(L){ drawLoop(B, N, L, neon); });
    s.pads.forEach(function(p){
      var y = (surfaceAt(S, p.x + p.ux*p.len/2, p.z + p.uz*p.len/2) || ground(p.x, p.z)) + 0.04, i0 = P.p.length;
      drawPad(P, p); for(var i = i0 + 1; i < P.p.length; i += 3) P.p[i] = y;
    });
    s.hoops.forEach(function(h){ drawRing(R, h); });
    [[B, matS], [N, matN], [P, matP], [R, matR]].forEach(function(q){ var m = q[0].mesh(THREE, q[1]); if(m){ if(q[1] === matS){ m.castShadow = true; m.receiveShadow = true; } sg.add(m); } });
    // the name over the run-up
    var tx = signTex(THREE, s.name, NEON[s.kind] || 0xffffff);
    if(tx){
      var sm = new THREE.MeshBasicMaterial({map: tx, toneMapped: false, side: THREE.DoubleSide}); mats.push(sm);
      var sign = new THREE.Mesh(new THREE.PlaneGeometry(16, 4), sm), p0 = s.pieces[0];
      sign.position.set(p0.x + p0.ux*2, p0.base + 9, p0.z + p0.uz*2); sign.rotation.y = Math.atan2(p0.ux, p0.uz) + PI; sg.add(sign);
      var B2 = new Builder(), px = p0.uz, pz = -p0.ux;
      [-1, 1].forEach(function(sd){ var x = sign.position.x + px*sd*8.5, z = sign.position.z + pz*sd*8.5, g0 = ground(x, z); B2.box(x, (g0 + p0.base + 11)/2, z, 0.5, p0.base + 11 - g0, 0.5, 0, C_STEEL); });
      var post = B2.mesh(THREE, matS); if(post) sg.add(post);
    }
    sg.userData.cx = s.x; sg.userData.cz = s.z; sg.userData.r = s.jump ? s.jump.D : 80;
    g.add(sg); groups.push(sg);
  });
  if(o.scene) o.scene.add(g);
  var T = 0;
  return {
    g: g, list: S.list,
    update: function(t, dt, cam){
      T += dt || 0;
      var calm = !!(c.E && c.E.calm && c.E.calm());                // Calm: nothing pulses or flickers
      matP.opacity = calm ? 0.8 : 0.55 + 0.35*Math.abs(Math.sin(T*4));
      var f = calm ? 0.85 : 0.75 + 0.25*Math.sin(T*13)*Math.sin(T*7.3);
      matR.color.setRGB(1, f, f*0.8);
      var k = 0.65 + 0.35*night; matN.color.setRGB(k, k, k);
      var cx = cam ? (cam.x != null ? cam.x : cam.position && cam.position.x) : null, cz = cam ? (cam.z != null ? cam.z : cam.position && cam.position.z) : null;
      if(cx != null && cz != null) groups.forEach(function(sg){
        sg.visible = hyp(cx - sg.userData.cx, cz - sg.userData.cz) - sg.userData.r < FAR;
      });
    },
    setNight: function(n){ night = n ? 1 : 0; },
    drawCalls: function(){ var n = 0; g.traverse(function(m){ if(m.isMesh && m.visible && m.parent && m.parent.visible) n++; }); return n; },
    destroy: function(){
      if(g.parent) g.parent.remove(g);
      g.traverse(function(m){ if(m.isMesh && m.geometry) m.geometry.dispose(); });
      mats.forEach(function(m){ if(m.map) m.map.dispose(); m.dispose(); });
    }
  };
}

// the queries hq3d flies by, on a claimed set (no drawing needed: they work from the City's first frame)
function api(S){
  if(!S || !S.list || !S.list.length) return null;
  return {list: S.list,
    groundAt: function(x, z){ return surfaceAt(S, x, z); },
    padAt: function(x, z, yaw){ return padAt(S, x, z, yaw); },
    loopAt: function(x, z, yaw){ return loopAt(S, x, z, yaw); },
    slopeAt: function(x, z, dx, dz){ return slopeAt(S, x, z, dx, dz); },
    stuntOf: function(id){ return S.list.filter(function(s){ return s.id === id; })[0] || null; },
    hoopsCrossed: function(p0, p1){ var k = 0; S.hoops.forEach(function(h){ if(hoopCross(h, p0, p1)) k++; }); return k; }};
}

HQV.hqStunts = {claim: claim, create: create, api: api, surfaceAt: surfaceAt, slopeAt: slopeAt, padAt: padAt, loopAt: loopAt,
                launchSpeed: launchSpeed, flightY: flightY, newAir: newAir, airStep: airStep, landing: landing, score: score,
                hoopCross: hoopCross, loopPose: loopPose, kickerGeom: kickerGeom, kickerProf: kickerProf,
                profAt: profAt, G: G, NAMES: NAMES, RUNWAY: RUNWAY, LOOP_R: LOOP_R};
})();
