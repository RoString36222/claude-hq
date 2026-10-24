/* Grand Prix: circuits as stages (HQ 3.17, docs/plans/grand-prix-spec.md). Pure code (no DOM, no three.js):
 * node runs it in the tests (dashboard-rs/tests/gp_js.rs) and the browser loads it as window.HQV.gpCircuit.
 *
 *   load()               -> Promise<doc>   games/gp/circuits.json, fetched once
 *   list(doc)            -> [{id, name, location, lengthM, round}]   the calendar by round, then the classics by name
 *   find(doc, id)        -> a circuit or null
 *   build(circuit, opts) -> stage   the Valley Rally stage shape (games/rally/stage.js build(): pts, grid, env,
 *                           scenery, roadHalf, locate, pointAtS...) for a closed loop, plus:
 *       loop: true, lapLength, sectors [s1, s2], slots (the grid boxes, pole first), kerbs [{s0, s1}],
 *       barrier (lateral distance of the walls), street, circuit {id, name, location, round, lengthM}
 *   tracker(stage)       -> {update(x, z, t, dt) -> [events], ...}   laps, sectors and track limits
 *   carSpec(vehicle)     -> a games/rally/physics.js spec for a catalogue Formula 1 car
 *   autopilot(stage, car, hint) -> {throttle, brake, steer, analog}   a driver for the tests
 *
 * Frames as in the rally: x east, z south, heading 0 = north (-z), right of travel = (cos h, sin h).
 * Everything seeded from the circuit id (mulberry32(hashStr(...))), so every client builds the same circuit.
 */
(function(root){
"use strict";

function hashStr(s){ var h = 2166136261 >>> 0; s = String(s); for(var i = 0; i < s.length; i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h >>> 0; }
function mulberry32(seed){ var a = (typeof seed === "number" ? seed : hashStr(seed)) >>> 0; return function(){ a = (a + 0x6D2B79F5) >>> 0; var t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0)/4294967296; }; }
var PI = Math.PI, TAU = PI*2, DEG = PI/180;
function clamp(v, a, b){ return v < a ? a : v > b ? b : v; }
function lerp(a, b, u){ return a + (b - a)*u; }
function smooth(u){ u = clamp(u, 0, 1); return u*u*(3 - 2*u); }
function wrapAng(a){ return Math.atan2(Math.sin(a), Math.cos(a)); }

var URL = "/games/gp/circuits.json";
// street circuits: narrower, with walls close by and tarmac (not gravel) behind the kerbs
var STREET = {"mc-1929": 4.6, "az-2016": 5.2, "sg-2008": 5.2, "sa-2021": 5.2, "us-2023": 5.2, "us-2022": 5.2, "es-2026": 5.2};
// the hilly ones get real elevation (m, the swing over a lap); every other circuit stays within about 1 m
var HILLY = {"be-1925": 8, "br-1940": 6, "us-2012": 3, "at-1969": 4, "jp-1962": 3, "pt-2008": 5};
// the dry, desert and city-in-the-sand ones paint in the rally's dry-hills palette
var DRY = {"bh-2002": 1, "qa-2004": 1, "ae-2009": 1, "sa-2021": 1, "us-2023": 1, "mx-1962": 1, "za-1961": 1};
var ROAD_HALF = 6.0, KERB = 1.2, CELL = 2, STEP = 2, RC = 34, MARGIN = 130;
var S_TARMAC = 0, S_GRAVEL = 1, S_GRASS = 3;
// The circuit's racing surface: grippy slick-tyre tarmac. games/rally/physics.js looks surfaces up by index in its
// (exported) SURFACES list, so useSlick(physics) appends this one once and build(circuit, {slick}) puts its index
// under the racing line. Rally stages never use it. Kerbs and run-off stay plain tarmac (index 0).
var SLICK = {id: "slick", name: "Slick tarmac", mu: 1.8, kx: 0.10, ky: 0.12, C: 1.6, slide: 0.72, ls: 0.12, roll: 0.012, plough: 0.0, rumble: 0.03};
function useSlick(phys){
  if(!phys || !Array.isArray(phys.SURFACES)) return 0;
  if(phys.SURF_INDEX && phys.SURF_INDEX.slick != null) return phys.SURF_INDEX.slick;
  for(var i = 0; i < phys.SURFACES.length; i++) if(phys.SURFACES[i].id === "slick"){ if(phys.SURF_INDEX) phys.SURF_INDEX.slick = i; return i; }
  phys.SURFACES.push(SLICK);
  var at = phys.SURFACES.length - 1; if(phys.SURF_INDEX) phys.SURF_INDEX.slick = at;
  return at;
}

/* ---------- the data ---------- */
var P = null;
function load(){
  if(!P) P = fetch(URL).then(function(r){ if(!r.ok) throw new Error("circuits " + r.status); return r.json(); })
    .catch(function(e){ P = null; throw e; });
  return P;
}
function circuitsOf(doc){ return (doc && Array.isArray(doc.circuits) ? doc.circuits : []).filter(function(c){ return c && typeof c.id === "string" && Array.isArray(c.pts) && c.pts.length >= 8; }); }
function list(doc){
  return circuitsOf(doc).map(function(c){ return {id: c.id, name: String(c.name || c.id), location: String(c.location || ""), lengthM: c.lengthM|0, round: c.round == null ? null : c.round|0}; })
    .sort(function(a, b){
      if((a.round == null) !== (b.round == null)) return a.round == null ? 1 : -1;
      if(a.round != null && a.round !== b.round) return a.round - b.round;
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });
}
function find(doc, id){ var L = circuitsOf(doc); for(var i = 0; i < L.length; i++) if(L[i].id === id) return L[i]; return null; }

/* ---------- value noise (as games/rally/stage.js) ---------- */
function makeNoise(seed){
  var r = mulberry32(seed), perm = new Uint16Array(512), val = new Float32Array(256), i;
  for(i = 0; i < 256; i++){ perm[i] = i; val[i] = r()*2 - 1; }
  for(i = 255; i > 0; i--){ var j = Math.floor(r()*(i + 1)), t = perm[i]; perm[i] = perm[j]; perm[j] = t; }
  for(i = 0; i < 256; i++) perm[i + 256] = perm[i];
  function v(ix, iz){ return val[perm[(ix & 255) + perm[iz & 255]]]; }
  return function(x, z){
    var ix = Math.floor(x), iz = Math.floor(z), fx = x - ix, fz = z - iz, u = fx*fx*(3 - 2*fx), w = fz*fz*(3 - 2*fz);
    var A = v(ix, iz), B = v(ix + 1, iz), C = v(ix, iz + 1), D = v(ix + 1, iz + 1);
    return A + (B - A)*u + (C - A)*w + (A - B - C + D)*u*w;
  };
}

/* ---------- the centre line: a closed centripetal Catmull-Rom, every STEP m ---------- */
function centreLine(raw){
  var n = raw.length, dense = [], i;
  function Pt(k){ return raw[((k % n) + n) % n]; }
  for(i = 0; i < n; i++){
    var p0 = Pt(i - 1), p1 = Pt(i), p2 = Pt(i + 1), p3 = Pt(i + 2);
    var d01 = Math.max(1e-3, Math.pow(Math.hypot(p1[0] - p0[0], p1[1] - p0[1]), 0.5)), d12 = Math.max(1e-3, Math.pow(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]), 0.5)), d23 = Math.max(1e-3, Math.pow(Math.hypot(p3[0] - p2[0], p3[1] - p2[1]), 0.5));
    var t0 = 0, t1 = d01, t2 = t1 + d12, t3 = t2 + d23, seg = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]), m = Math.max(2, Math.ceil(seg/1.5));
    for(var j = 0; j < m; j++){
      var t = t1 + (t2 - t1)*j/m, q = [0, 0];
      for(var c = 0; c < 2; c++){
        var A1 = (t1 - t)/(t1 - t0)*p0[c] + (t - t0)/(t1 - t0)*p1[c], A2 = (t2 - t)/(t2 - t1)*p1[c] + (t - t1)/(t2 - t1)*p2[c], A3 = (t3 - t)/(t3 - t2)*p2[c] + (t - t2)/(t3 - t2)*p3[c];
        var B1 = (t2 - t)/(t2 - t0)*A1 + (t - t0)/(t2 - t0)*A2, B2 = (t3 - t)/(t3 - t1)*A2 + (t - t1)/(t3 - t1)*A3;
        q[c] = (t2 - t)/(t2 - t1)*B1 + (t - t1)/(t2 - t1)*B2;
      }
      dense.push(q);
    }
  }
  // resample by arc length: N equal steps round the loop
  var cum = [0], L = 0, nd = dense.length;
  for(i = 1; i <= nd; i++){ var a = dense[i - 1], b = dense[i % nd]; L += Math.hypot(b[0] - a[0], b[1] - a[1]); cum.push(L); }
  var N = Math.max(16, Math.round(L/STEP)), step = L/N, out = [], k = 0;
  for(i = 0; i < N; i++){
    var sv = i*step;
    while(k < nd - 1 && cum[k + 1] < sv) k++;
    var A = dense[k], B = dense[(k + 1) % nd], u = (sv - cum[k])/Math.max(1e-9, cum[k + 1] - cum[k]);
    out.push([lerp(A[0], B[0], u), lerp(A[1], B[1], u)]);
  }
  // a light closed smoothing (the source lines are hand-traced: no kinks under 10 m)
  for(var pass = 0; pass < 2; pass++){
    var tmp = [];
    for(i = 0; i < N; i++){ var sx = 0, sz = 0; for(var o = -3; o <= 3; o++){ var q2 = out[((i + o) % N + N) % N]; sx += q2[0]; sz += q2[1]; } tmp.push([sx/7, sz/7]); }
    out = tmp;
  }
  return out;
}

// does the closed line cross itself? (every 4th point; neighbours within 40 m along the line don't count)
function selfCrossing(pts){
  var n = pts.length, seg = [], i, j;
  for(i = 0; i < n; i += 4) seg.push([pts[i], pts[(i + 4) % n], i]);
  function side(a, b, c){ return (b.x - a.x)*(c.z - a.z) - (b.z - a.z)*(c.x - a.x); }
  for(i = 0; i < seg.length; i++) for(j = i + 2; j < seg.length; j++){
    var di = Math.abs(seg[i][2] - seg[j][2]); if(Math.min(di, n - di) < 24) continue;
    var A = seg[i][0], B = seg[i][1], C = seg[j][0], D = seg[j][1];
    if(Math.max(A.x, B.x) < Math.min(C.x, D.x) || Math.max(C.x, D.x) < Math.min(A.x, B.x) || Math.max(A.z, B.z) < Math.min(C.z, D.z) || Math.max(C.z, D.z) < Math.min(A.z, B.z)) continue;
    if(side(A, B, C)*side(A, B, D) < 0 && side(C, D, A)*side(C, D, B) < 0) return true;
  }
  return false;
}

/* ---------- build ---------- */
function build(circuit, opts){
  opts = opts || {};
  var id = String(circuit && circuit.id || "circuit"), raw = (circuit && circuit.pts || []).map(function(p){ return [+p[0] || 0, +p[1] || 0]; });
  if(raw.length < 8) throw new Error("a circuit needs at least 8 points");
  var S_ROAD = opts.slick > 0 ? opts.slick|0 : S_TARMAC;
  var street = STREET[id] != null, W = STREET[id] || ROAD_HALF, B = W + KERB + (street ? 5 : 13);
  var name = String(circuit.name || id).slice(0, 60), biome = DRY[id] ? "hills" : "forest";
  var line = centreLine(raw), N = line.length, k, i;
  var master = mulberry32(hashStr("gp|" + id));
  var terrSeed = Math.floor(master()*4294967296) >>> 0, decoSeed = Math.floor(master()*4294967296) >>> 0, elevSeed = Math.floor(master()*4294967296) >>> 0;

  /* 1. the dense line: s, heading, curvature, height */
  var pts = [], s = 0;
  for(k = 0; k < N; k++){
    if(k > 0) s += Math.hypot(line[k][0] - line[k - 1][0], line[k][1] - line[k - 1][1]);
    var A = line[(k - 1 + N) % N], Bp = line[(k + 1) % N];
    pts.push({x: line[k][0], z: line[k][1], y: 0, s: s, h: Math.atan2(Bp[0] - A[0], -(Bp[1] - A[1])), k: 0, bank: 0, surf: S_TARMAC, i: k});
  }
  var lap = s + Math.hypot(line[0][0] - line[N - 1][0], line[0][1] - line[N - 1][1]);
  var curv = new Float64Array(N);
  for(k = 0; k < N; k++){ var ha = pts[(k - 5 + N) % N].h, hb = pts[(k + 5) % N].h; curv[k] = wrapAng(hb - ha)/(10*lap/N); }
  for(k = 0; k < N; k++){ var sum = 0; for(var q = -6; q <= 6; q++) sum += curv[(k + q + N) % N]; pts[k].k = sum/13; }
  // the corner around each point (signed, the tightest within 40 m) and a kerb flag (within 14 m)
  var cw = new Float64Array(N), kerbAt = new Uint8Array(N);
  for(k = 0; k < N; k++){
    var best = 0, bk = 0;
    for(q = -20; q <= 20; q++){ var kk = pts[(k + q + N) % N].k; if(Math.abs(kk) > Math.abs(best)) best = kk; if(q >= -7 && q <= 7) bk = Math.max(bk, Math.abs(kk)); }
    cw[k] = best; kerbAt[k] = bk > 1/170 ? 1 : 0;
  }
  // height: a few seeded harmonics of the lap (so it closes), grade-limited by construction. A circuit whose line
  // crosses itself (Suzuka's figure of eight) stays flat: the heightfield has no bridges, and two heights meeting
  // at the crossing would be a step across the road.
  var crosses = selfCrossing(pts);
  var amp = crosses ? 0 : HILLY[id] || 0.8, er = mulberry32(elevSeed), harm = [];
  for(var f = 1; f <= 3; f++) harm.push({f: f, a: (0.5 + er())/f, p: er()*TAU});
  var hnorm = harm.reduce(function(t, hh){ return t + hh.a; }, 0);
  for(k = 0; k < N; k++){
    var y = 0; harm.forEach(function(hh){ y += hh.a*Math.sin(TAU*hh.f*pts[k].s/lap + hh.p); });
    pts[k].y = amp*y/hnorm;
  }
  // the closing point (the road ribbon in games/rally/scene.js draws n - 1 segments)
  var P0 = pts[0];
  pts.push({x: P0.x, z: P0.z, y: P0.y, s: lap, h: P0.h, k: P0.k, bank: 0, surf: S_TARMAC, i: N});
  var stepS = lap/N;

  function pointAtS(sv){
    sv = ((sv % lap) + lap) % lap;
    var f2 = sv/stepS, lo = Math.floor(f2) % N, u = f2 - Math.floor(f2), Pa = pts[lo], Pb = pts[lo + 1];
    return {x: lerp(Pa.x, Pb.x, u), z: lerp(Pa.z, Pb.z, u), y: lerp(Pa.y, Pb.y, u), h: Pa.h + wrapAng(Pb.h - Pa.h)*u, s: sv, k: lerp(Pa.k, Pb.k, u), bank: 0, i: lo};
  }
  function locate(x, z, hint){
    var best2 = 1e18, bi = 0, j, n2, a, span = N;
    if(hint != null && hint >= 0){ a = (hint|0) - 60; span = 121; } else a = 0;
    for(n2 = 0; n2 < span && n2 < N; n2++){
      j = ((a + n2) % N + N) % N;
      var dx = pts[j].x - x, dz = pts[j].z - z, d = dx*dx + dz*dz;
      if(d < best2){ best2 = d; bi = j; }
    }
    var Pq = pts[bi], tx = Math.sin(Pq.h), tz = -Math.cos(Pq.h), dx2 = x - Pq.x, dz2 = z - Pq.z;
    var along = dx2*tx + dz2*tz, lat = dx2*(-tz) + dz2*tx;
    return {i: bi, s: ((Pq.s + along) % lap + lap) % lap, lat: lat, d: Math.sqrt(best2)};
  }

  /* 2. the land far from the track: the road's height spread out, plus a gentle swell */
  var minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
  pts.forEach(function(p){ minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z); });
  var FC = 50, fx0 = minX - 1000, fz0 = minZ - 1000, fnx = Math.ceil((maxX - minX + 2000)/FC) + 1, fnz = Math.ceil((maxZ - minZ + 2000)/FC) + 1;
  var FAR = new Float32Array(fnx*fnz), sub = [];
  for(k = 0; k < N; k += 8) sub.push(pts[k]);
  for(var fz = 0; fz < fnz; fz++) for(var fx = 0; fx < fnx; fx++){
    var wx = fx0 + fx*FC, wz = fz0 + fz*FC, ws = 0, ys = 0;
    for(i = 0; i < sub.length; i++){ var ddx = sub[i].x - wx, ddz = sub[i].z - wz, ww = 1/(ddx*ddx + ddz*ddz + 22500); ws += ww; ys += ww*sub[i].y; }
    FAR[fz*fnx + fx] = ys/ws;
  }
  var swell = makeNoise(terrSeed);
  function natural(x, z){
    var gx = clamp((x - fx0)/FC, 0, fnx - 1.001), gz = clamp((z - fz0)/FC, 0, fnz - 1.001), ix = Math.floor(gx), iz = Math.floor(gz), u = gx - ix, w = gz - iz, i0 = iz*fnx + ix;
    var base = FAR[i0] + (FAR[i0 + 1] - FAR[i0])*u + (FAR[i0 + fnx] - FAR[i0])*w + (FAR[i0] - FAR[i0 + 1] - FAR[i0 + fnx] + FAR[i0 + fnx + 1])*u*w;
    return base - 0.2 + swell(x/90, z/90)*(street ? 0.2 : 0.9);
  }

  /* 3. the heightfield grid, with the circuit carved in */
  var x0 = Math.floor((minX - MARGIN)/CELL)*CELL, z0 = Math.floor((minZ - MARGIN)/CELL)*CELL;
  var nx = Math.ceil((maxX + MARGIN - x0)/CELL) + 1, nz = Math.ceil((maxZ + MARGIN - z0)/CELL) + 1;
  var H = new Float32Array(nx*nz), SURF = new Uint8Array(nx*nz), LAT = new Float32Array(nx*nz), IDX = new Int32Array(nx*nz), gi, gx2, gz2;
  for(gz2 = 0; gz2 < nz; gz2++) for(gx2 = 0; gx2 < nx; gx2++){ gi = gz2*nx + gx2; H[gi] = natural(x0 + gx2*CELL, z0 + gz2*CELL); SURF[gi] = street ? S_TARMAC : S_GRASS; LAT[gi] = 1e9; IDX[gi] = -1; }
  var rc = Math.ceil(RC/CELL);
  for(k = 0; k < N; k++){
    var Pk = pts[k], tx2 = Math.sin(Pk.h), tz2 = -Math.cos(Pk.h), cx = Math.round((Pk.x - x0)/CELL), cz = Math.round((Pk.z - z0)/CELL);
    for(var oz = -rc; oz <= rc; oz++){
      var gzz = cz + oz; if(gzz < 0 || gzz >= nz) continue;
      for(var ox = -rc; ox <= rc; ox++){
        var gxx = cx + ox; if(gxx < 0 || gxx >= nx) continue;
        var ii = gzz*nx + gxx, dx3 = x0 + gxx*CELL - Pk.x, dz3 = z0 + gzz*CELL - Pk.z;
        var al2 = dx3*tx2 + dz3*tz2, lt = dx3*(-tz2) + dz3*tx2;
        if(al2 < -stepS*0.75 || al2 > stepS*0.75 || Math.abs(lt) > RC) continue;
        if(Math.abs(lt) < Math.abs(LAT[ii])){ LAT[ii] = lt; IDX[ii] = k; }
      }
    }
  }
  for(gi = 0; gi < nx*nz; gi++){
    var idx = IDX[gi]; if(idx < 0) continue;
    var Pp = pts[idx], la = LAT[gi], al = Math.abs(la), side = la >= 0 ? 1 : -1, yR = Pp.y;
    if(al <= W){ H[gi] = yR - 0.03*(al/W)*(al/W); SURF[gi] = S_ROAD; continue; }
    if(al <= W + KERB){ H[gi] = yR - 0.03 + (kerbAt[idx] ? 0.035*(1 - (al - W)/KERB) : 0); SURF[gi] = S_TARMAC; continue; }
    if(al <= B){
      H[gi] = yR - 0.06 - (al - W - KERB)*0.008;
      // run-off: tarmac in the streets; gravel on the outside of a corner; grass elsewhere
      SURF[gi] = street ? S_TARMAC : (Math.abs(cw[idx]) > 1/400 && side === (cw[idx] > 0 ? -1 : 1) ? S_GRAVEL : S_GRASS);
      if(SURF[gi] === S_GRAVEL) H[gi] -= 0.08;
      continue;
    }
    var u3 = (al - B)/(RC - B);
    H[gi] = lerp(yR - 0.1 - (B - W - KERB)*0.008, H[gi], smooth(u3));
    if(street && al < B + 6) SURF[gi] = S_TARMAC; else if(!street) SURF[gi] = S_GRASS;
  }
  function height(x, z){
    var fx3 = (x - x0)/CELL, fz3 = (z - z0)/CELL;
    if(fx3 < 0 || fz3 < 0 || fx3 >= nx - 1 || fz3 >= nz - 1) return natural(x, z);
    var ix = Math.floor(fx3), iz = Math.floor(fz3), u = fx3 - ix, w = fz3 - iz, i0 = iz*nx + ix;
    var a = H[i0], b = H[i0 + 1], c = H[i0 + nx], d = H[i0 + nx + 1];
    return a + (b - a)*u + (c - a)*w + (a - b - c + d)*u*w;
  }
  function normal(x, z, out){
    out = out || [0, 1, 0];
    var e = 0.5, hx = (height(x + e, z) - height(x - e, z))/(2*e), hz = (height(x, z + e) - height(x, z - e))/(2*e);
    var l = Math.sqrt(hx*hx + 1 + hz*hz); out[0] = -hx/l; out[1] = 1/l; out[2] = -hz/l; return out;
  }
  function surface(x, z){
    var ix = Math.round((x - x0)/CELL), iz = Math.round((z - z0)/CELL);
    if(ix < 0 || iz < 0 || ix >= nx || iz >= nz) return street ? S_TARMAC : S_GRASS;
    return SURF[iz*nx + ix];
  }
  function latAt(x, z){
    var ix = Math.round((x - x0)/CELL), iz = Math.round((z - z0)/CELL);
    if(ix < 0 || iz < 0 || ix >= nx || iz >= nz) return 1e9;
    var v = LAT[iz*nx + ix]; return v > 1e8 ? 1e9 : Math.abs(v);
  }

  /* 4. walls, the grid, scenery */
  var dr = mulberry32(decoSeed), obst = {};
  function addObst(x, z, r){ var kk2 = Math.floor(x/8) + "," + Math.floor(z/8); (obst[kk2] = obst[kk2] || []).push([x, z, r]); }
  var sc = {trees: [], rocks: [], tufts: [], fences: [], chevrons: [], banners: [], arches: [], tower: null, posts: [], bales: [], flags: [],
            walls: [], stands: [], pits: null, gantry: null, blocks: []};
  // the walls: armco (or concrete in the streets) at lateral B either side, wherever this stretch is the nearest one
  for(k = 0; k < N; k++){
    var Pw = pts[k], cxh = Math.cos(Pw.h), szh = Math.sin(Pw.h);
    for(var sd = -1; sd <= 1; sd += 2){
      var bx = Pw.x + cxh*B*sd, bz = Pw.z + szh*B*sd;
      if(latAt(bx, bz) < B - 0.6) continue;
      addObst(bx, bz, 1.1);
      if(k % 2 === 0) sc.walls.push({x: bx, z: bz, y: height(bx, bz), h: Pw.h, len: stepS*2 + 0.1, kind: street ? 1 : 0, side: sd});
    }
  }
  // the grid: two by two behind the line, 8 m a row, staggered 4 m
  var slots = [];
  for(i = 0; i < 8; i++){
    var gs = lap - 14 - Math.floor(i/2)*8 - (i % 2)*4, gp = pointAtS(gs), lat2 = (i % 2 ? 1 : -1)*Math.min(2.6, W - 1.8);
    slots.push({x: gp.x + Math.cos(gp.h)*lat2, z: gp.z + Math.sin(gp.h)*lat2, h: gp.h, s: gs, lat: lat2});
  }
  // kerb runs (for the scene's red and white strips)
  var kerbs = [], run = null;
  for(k = 0; k <= N; k++){
    var on = k < N && kerbAt[k];
    if(on && !run) run = {s0: pts[k].s};
    if(!on && run){ run.s1 = pts[k - 1].s + stepS; kerbs.push(run); run = null; }
  }
  // the start: the gantry over the line, grandstands along the straight, the pit building opposite
  var g0 = pointAtS(0);
  sc.gantry = {x: g0.x, z: g0.z, y: g0.y, h: g0.h, w: B};
  var pitSide = -1, standSide = 1;
  function clearAt(x, z, need){ return latAt(x, z) >= need; }
  [[-260, 140], [-120, 140], [30, 120]].forEach(function(st2){
    var c0 = pointAtS(st2[0] + st2[1]/2), off = B + 9, xs = c0.x + Math.cos(c0.h)*off*standSide, zs = c0.z + Math.sin(c0.h)*off*standSide;
    if(clearAt(xs, zs, B + 3)) sc.stands.push({x: xs, z: zs, y: height(xs, zs), h: c0.h, len: st2[1]*0.9, depth: 14, side: standSide});
  });
  var pc = pointAtS(-60), poff = B + 10, px = pc.x + Math.cos(pc.h)*poff*pitSide, pz = pc.z + Math.sin(pc.h)*poff*pitSide;
  if(clearAt(px, pz, B + 4)) sc.pits = {x: px, z: pz, y: height(px, pz), h: pc.h, len: street ? 120 : 210, depth: 14, side: pitSide};
  // more stands at the big corners: the tightest apexes, at least 600 m apart, on the outside
  var apex = [];
  for(k = 0; k < N; k++){ var ak = Math.abs(pts[k].k); if(ak > 1/90 && ak >= Math.abs(pts[(k + 1) % N].k) && ak >= Math.abs(pts[(k - 1 + N) % N].k)) apex.push(k); }
  apex.sort(function(a, b){ return Math.abs(pts[b].k) - Math.abs(pts[a].k); });
  var used = [];
  apex.forEach(function(ka){
    if(used.length >= 5) return;
    var sa = pts[ka].s;
    if(used.some(function(u){ var d = Math.abs(u - sa); return Math.min(d, lap - d) < 600; }) || Math.min(sa, lap - sa) < 400) return;
    var outS = pts[ka].k > 0 ? -1 : 1, off = B + 10, xa = pts[ka].x + Math.cos(pts[ka].h)*off*outS, za = pts[ka].z + Math.sin(pts[ka].h)*off*outS;
    if(!clearAt(xa, za, B + 4)) return;
    used.push(sa); sc.stands.push({x: xa, z: za, y: height(xa, za), h: pts[ka].h, len: 70, depth: 12, side: outS});
  });
  // sponsor banners on the walls along the straights (the game's own made-up names)
  for(var bs = 80; bs < lap - 80; bs += 260 + dr()*220){
    var bp = pointAtS(bs), bsd = dr() < 0.5 ? -1 : 1, bo = B + 1.2, bxx = bp.x + Math.cos(bp.h)*bo*bsd, bzz = bp.z + Math.sin(bp.h)*bo*bsd;
    if(Math.abs(bp.k) < 1/400 && clearAt(bxx, bzz, B)) sc.banners.push({x: bxx, z: bzz, y: height(bxx, bzz), h: bp.h, v: Math.floor(dr()*8), side: bsd});
  }
  // beyond the walls: trees (parkland) or city blocks (the street circuits)
  var lim = street ? 1800 : 5200, cellD = street ? 26 : 13;
  for(var tz = z0 + 8; tz < z0 + (nz - 1)*CELL - 8; tz += cellD) for(var tx = x0 + 8; tx < x0 + (nx - 1)*CELL - 8; tx += cellD){
    var jx = tx + (dr() - 0.5)*cellD*0.8, jz = tz + (dr() - 0.5)*cellD*0.8, roll = dr(), kind = dr(), scl = 0.8 + dr()*0.7, rot = dr()*TAU, v = dr();
    var dl = latAt(jx, jz), near = dl < 1e8;
    if(near && dl < B + (street ? 9 : 8)) continue;
    if(street){
      if(sc.blocks.length >= lim || (!near && roll > 0.35) || roll > 0.8) continue;
      sc.blocks.push({x: jx, z: jz, y: height(jx, jz), w: 12 + kind*12, d: 12 + v*10, hgt: 10 + Math.pow(dr(), 1.6)*55, r: Math.round(rot/(PI/2))*(PI/2) + (dr() - 0.5)*0.2, v: v});
    } else {
      if(sc.trees.length >= lim || roll > (near ? 0.5 : 0.22)) continue;
      sc.trees.push({x: jx, z: jz, y: height(jx, jz), t: kind < 0.55 ? 1 : kind < 0.9 ? 0 : 2, s: scl, r: rot, v: v});
    }
  }
  // grass tufts on the verges behind the walls
  if(!street) for(var tf = 0; tf < 2600; tf++){
    var tp = pts[Math.floor(dr()*N)], ts = dr() < 0.5 ? -1 : 1, to = B + 2 + Math.pow(dr(), 1.4)*18;
    var tfx = tp.x + Math.cos(tp.h)*to*ts + (dr() - 0.5)*3, tfz = tp.z + Math.sin(tp.h)*to*ts + (dr() - 0.5)*3;
    if(latAt(tfx, tfz) < B + 1.5 || surface(tfx, tfz) !== S_GRASS) continue;
    sc.tufts.push({x: tfx, z: tfz, y: height(tfx, tfz), s: 0.6 + dr()*0.8, r: dr()*TAU, v: dr()});
  }
  function obstacles(x, z, r, cb){
    var c0 = Math.floor((x - r)/8), c1 = Math.floor((x + r)/8), d0 = Math.floor((z - r)/8), d1 = Math.floor((z + r)/8);
    for(var a = c0; a <= c1; a++) for(var b = d0; b <= d1; b++){
      var L2 = obst[a + "," + b]; if(!L2) continue;
      for(var j = 0; j < L2.length; j++) cb(L2[j][0], L2[j][1], L2[j][2]);
    }
  }

  /* 5. sectors and the line, as rally-style gates (heading in degrees) */
  var sectors = [lap/3, lap*2/3];
  var gates = [sectors[0], sectors[1], 0].map(function(sv){ var p = pointAtS(sv); return {x: p.x, z: p.z, h: ((Math.round(p.h/DEG) % 360) + 360) % 360, w: Math.round(B)}; });
  var pole = slots[0];
  var start = {x: pole.x, z: pole.z, h: ((pole.h/DEG % 360) + 360) % 360};
  var info = {id: id, name: name, location: String(circuit.location || ""), round: circuit.round == null ? null : circuit.round|0, lengthM: circuit.lengthM|0};
  return {
    seed: "gp-" + id, biome: biome, night: !!opts.night, target: lap, name: name, doc: {kind: "gp", v: 1, name: name, data: {id: id}},
    pts: pts, gates: gates, gateS: [sectors[0], sectors[1], lap], start: start, length: lap, roadLen: lap, sections: [{s0: 0, s1: lap, surf: S_TARMAC}],
    grid: {x0: x0, z0: z0, cell: CELL, nx: nx, nz: nz, h: H, surf: SURF},
    natural: natural, scenery: sc, roadHalf: W, edge: B, kerb: KERB, barrier: B, street: street,
    env: {height: height, normal: normal, surface: surface, obstacles: obstacles},
    locate: locate, pointAtS: pointAtS, latAt: latAt,
    loop: true, crosses: crosses, lapLength: lap, sectors: sectors, slots: slots, kerbs: kerbs, circuit: info, circuitStage: true
  };
}

/* ---------- laps, sectors, track limits ---------- */
// update(x, z, t, dt) after each physics advance: t the race clock (s). Events:
//   {type: "start", t}            the first time over the line: the first lap's clock starts
//   {type: "sector", n (1|2), ms} a sector time on this lap
//   {type: "lap", n, ms, valid, sectors: [ms, ms, ms]}
// A lap counts only after both sectors in order. It is invalid (shown, never saved as a best) after more than
// 4 s with all four wheels past the kerbs, a moment more than 20 m from the centre line, or a jump (a cut or a reset).
function tracker(st){
  var L = st.lapLength, lim = st.roadHalf + st.kerb + 0.95;
  var T = {hint: -1, s: null, started: false, lapT0: 0, secT0: 0, sec: 0, secs: [], lapsDone: 0, laps: [], offT: 0, invalid: false, lat: 0, d: 0};
  T.reset = function(){ T.s = null; T.hint = -1; T.invalid = true; };
  T.update = function(x, z, t, dt){
    var ev = [], q = st.locate(x, z, T.hint);
    T.hint = q.i; T.lat = q.lat; T.d = q.d;
    if(T.s == null){ T.s = q.s; return ev; }
    var ds = q.s - T.s; if(ds > L/2) ds -= L; else if(ds < -L/2) ds += L;
    if(Math.abs(ds) > 60) T.invalid = true;
    if(T.started){
      if(Math.abs(q.lat) > lim) T.offT += dt || 0;
      if(Math.abs(q.lat) > 20 || T.offT > 4) T.invalid = true;
    }
    var prev = T.s, cur = q.s;
    // over the line (forwards, by wrap)
    if(ds > 0 && prev > L - 80 && cur < 80 && Math.abs(ds) <= 60){
      var u = (L - prev)/ds, tc = t - (dt || 0)*(1 - clamp(u, 0, 1));
      if(!T.started){ T.started = true; T.lapT0 = tc; T.secT0 = tc; T.sec = 0; T.secs = []; T.offT = 0; T.invalid = false; ev.push({type: "start", t: tc}); }
      else if(T.sec === 2){
        var ms = Math.round((tc - T.lapT0)*1000);
        T.secs.push(Math.round((tc - T.secT0)*1000));
        T.lapsDone++;
        var lapEv = {type: "lap", n: T.lapsDone, ms: ms, valid: !T.invalid, sectors: T.secs.slice()};
        T.laps.push(lapEv); ev.push(lapEv);
        T.lapT0 = tc; T.secT0 = tc; T.sec = 0; T.secs = []; T.offT = 0; T.invalid = false;
      }
    } else if(T.started && ds > 0 && Math.abs(ds) <= 60 && T.sec < 2){
      var sv = st.sectors[T.sec];
      if(prev < sv && cur >= sv){
        var u2 = (sv - prev)/ds, tc2 = t - (dt || 0)*(1 - clamp(u2, 0, 1)), sm = Math.round((tc2 - T.secT0)*1000);
        T.secs.push(sm); T.secT0 = tc2; T.sec++;
        ev.push({type: "sector", n: T.sec, ms: sm});
      }
    }
    T.s = cur;
    return ev;
  };
  // the running lap time (s) and the distance into the lap (m)
  T.lapTime = function(t){ return T.started ? Math.max(0, t - T.lapT0) : 0; };
  T.into = function(){ return T.s == null ? 0 : T.s; };
  return T;
}

/* ---------- the car: a rally physics spec for a Formula 1 car ---------- */
// The 2026 rules: a 1.6 L V6 turbo with a 350 kW motor (about 750 kW), 768 kg with the driver (798 with fuel),
// active aero; every team's car is the same here, only the livery differs. Tuned in node (dashboard-rs/tests/gp_js.rs):
// 0-100 km/h about 2.5 s and the top speed on Monza's straight at the physics cap (342 km/h).
function carSpec(v){
  v = v || {};
  var sp = v.spec || {}, dm = v.dims || {}, lv = v.livery || {};
  var mass = clamp((+sp.massKg || 768) + 30, 700, 900), kw = clamp(+sp.powerKw || 750, 400, 900), k = kw/750;
  var wb = clamp(+dm.wheelbaseM || 3.4, 2.8, 3.7), a = wb*0.54, track = clamp((+dm.widthM || 1.9) - 0.3, 1.4, 1.8);
  var curve = [[3000, 260], [5000, 430], [7000, 560], [9000, 640], [10500, 670], [11500, 640], [12500, 590], [13000, 540]].map(function(p){ return [p[0], Math.round(p[1]*k)]; });
  return {
    id: String(v.id || "f1"), name: String((v.brand || "Formula") + " " + (v.model || "1")).slice(0, 40), kind: "Formula 1", drive: "rwd", eng: "v6",
    plate: String(v.model || "F1").toUpperCase().slice(0, 9), note: "1.6 L V6 turbo hybrid · " + Math.round(kw) + " kW", body: "formula", livery: lv, vehicleId: v.id || null,
    mass: mass, inertia: [900, 1050, 260], a: a, b: wb - a, track: track, hpY: 0.1, lfree: 0.12, travel: 0.07, radius: 0.36, wheelI: 1.2,
    spring: [190000, 170000], bump: [9500, 8800], rebound: [12500, 11500], arb: [42000, 32000],
    engine: {idle: 4500, redline: 12000, limiter: 12500, launch: 7000, inertia: 0.09, turbo: 0, brake: 65, curve: curve},
    gears: [4.30, 3.75, 3.21, 2.63, 2.15, 1.76, 1.44, 1.18], reverse: 4.4, final: 4.0, eff: 0.93, shiftUp: 11900, shiftTime: 0.04,
    split: 0, centre: [0, 0], frontDiff: [0, 0], rearDiff: [220, 0.35],
    brake: 18000, bias: 0.58, hand: 1500, cda: 1.12, cla: 4.0, lock: 0.40, rcLift: 0.26, kyF: 1.2, kyR: 0.8,
    colors: {body: lv.base || "#d02020", stripe: lv.accent || "#f4f4f2", stripe2: lv.trim || "#151515", rim: "#20242a", glass: "#1d2733"}
  };
}

/* ---------- the steering limiter ---------- */
// The physics gives a stick at least 0.34 rad of lock at any speed (and a key 0.08): far past what a single-seater
// can use at 300 km/h. steerScale(spec, v, analog) is the share of that lock the grip can use at speed v (m/s), so
// a full key or stick asks for the tightest corner the car can take, not a spin. 1 below about 100 km/h.
function steerScale(spec, v, analog){
  spec = spec || {}; v = Math.max(0, +v || 0);
  var wb = (spec.a || 1.8) + (spec.b || 1.6), qd = 0.5*1.2*(spec.cla || 0)/(spec.mass || 800), lock0 = spec.lock || 0.4;
  var lock = analog ? Math.max(0.34, lock0/(1 + v/30)) : Math.max(0.08, lock0/(1 + Math.max(0, v - 3)/5));
  if(v < 1) return 1;
  var aLat = 1.7*(9.81 + qd*v*v), dmax = Math.atan(wb*aLat/(v*v)) + 0.05;
  return clamp(dmax/lock, 0.08, 1);
}

/* ---------- a driver for the tests (and the browser smoke test) ---------- */
// Looks ahead along the centre line: the fastest each corner allows with the downforce, braked for in time; steers
// by pure pursuit. Analog values (a stick).
function autopilot(st, car, hint, opts){
  if(!st || !car) return {throttle: 0, brake: 0, steer: 0, analog: true};
  opts = opts || {};
  var sp = car.spec, v = car.tel ? car.tel.speed : 0, q = st.locate(car.p[0], car.p[2], hint);
  var mu = opts.mu || 1.45, Gg = 9.81, qd = 0.5*1.2*(sp.cla || 0)/sp.mass, want = 99, pace = opts.pace || 0.86;
  // the fastest a corner of curvature k allows: v^2 k = mu (g + qd v^2)
  function vmax(k){ k = Math.abs(k); var den = k - mu*qd*pace; return den <= 1e-6 ? 99 : Math.sqrt(mu*Gg*pace/den); }
  // braking (m/s^2) at speed u: the tyres' grip plus the downforce's
  function dec(u){ return Math.min(38, mu*0.8*(Gg + qd*u*u)); }
  var look = Math.max(80, v*v/(2*dec(v*0.6)) + 50);
  for(var d = 0; d <= look; d += 5){
    var p = st.pointAtS(q.s + d), vk = vmax(p.k), dd = Math.max(0, d - 4 - v*0.15);
    want = Math.min(want, Math.sqrt(vk*vk + 2*dec(vk)*dd));
  }
  // steering: the path's curvature a little ahead (feed-forward) plus its heading and the lateral error
  var wb = sp.a + sp.b, M = car.M, ch = Math.atan2(-M[2], M[8]);
  var A = st.pointAtS(q.s + Math.max(3, v*0.18)), Bh = st.pointAtS(q.s + Math.max(5, v*0.3));
  var eh = wrapAng(Bh.h - ch), delta = Math.atan(wb*A.k)*1.1 + 0.85*eh - clamp(q.lat, -4, 4)*0.035;
  var lock = Math.max(0.34, sp.lock/(1 + v/30)), lim = steerScale(sp, v, true);
  var e = want - v, st2 = clamp(delta/lock, -lim, lim);
  // lift while the steering is at its limit (the throttle would only push the nose wide)
  var thr = e > 0 ? clamp(e/2.5, 0.25, 1) : 0; if(Math.abs(st2) >= lim*0.98 && v > 8) thr = Math.min(thr, 0.3);
  return {throttle: thr, brake: e < -1 ? clamp(-e/5, 0, 1) : 0, steer: st2, handbrake: 0, analog: true, hint: q.i, want: want};
}

var API = {URL: URL, SLICK: SLICK, useSlick: useSlick, steerScale: steerScale, load: load, list: list, find: find, build: build, tracker: tracker, carSpec: carSpec, autopilot: autopilot,
           STREET: STREET, ROAD_HALF: ROAD_HALF, KERB: KERB, hashStr: hashStr, mulberry32: mulberry32};
if(typeof module === "object" && module.exports) module.exports = API;
else { root.HQV = root.HQV || {}; root.HQV.gpCircuit = API; }
})(typeof window !== "undefined" ? window : this);
