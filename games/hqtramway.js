/* Claude HQ: the street tramway (HQV.hqTramway, HQ 3.15, docs/plans/transport-revamp.md 3.1).
 *
 * layout(W, tier, opts) -> Lay, pure (no THREE, no DOM; tests/test_hqtramway.py runs it under node): everything
 * is laid on the tracks the trams drive (HQV.traffic.tramPaths / lanes / tramStops, the same numbers the sim uses),
 *   tracks     the centre lines: each lane, each turn curve through a junction box, each terminus crossover
 *   rails      two per track at standard gauge (1.435 m between the inner faces of the 0.07 m heads), a 0.04 m
 *              groove inside each head, flush 0.01 m above the road
 *   diamonds   where two tracks cross away from their ends
 *   crossovers each terminus crossover: switch blades at both ends, a point-motor box, a check rail
 *   beds       reserved stretches (a lane over 60 m) get their own asphalt with white edge lines and TRAM stencils
 *              every 120 m; within 25 m of a stop the bed is setts; beside a park, grass
 *   poles      every 30 m at most, closer on curves so the contact wire (a chord between registration points,
 *              staggered +-0.2 m) never strays more than 0.4 m off the track; centre poles with twin arms where an
 *              arterial carries a tram each way, kerb-side poles with one arm elsewhere
 *   wires      contact wire 5.6 m up, a messenger above it, droppers, pull-offs on curves (line segments)
 *   islands    a 0.3 m boarding island with a yellow ribbed tactile edge at every stop, and a totem in the line
 *              colour with the line badge (the shelter is hqcivic's); [3.32] a station whose site is a 40 x 3 m platform
 *              (City Gen v4 phase 9) gets one island on the site's rectangle: down the middle of a centre bed between
 *              the tracks (tactile both sides) or at the kerb (tactile on the track side). The tracks themselves follow
 *              traffic.js's offsets: inside a centre bed (on it, 0.15 m up), in the innermost lane of a shared street;
 *              a centre bed is the reservation already (worldgeom.js draws it), so no asphalt or setts overlay on it
 * view(c, W, tier, opts) -> V: draws it in at most 10 draw calls (rails, bed, stencils, furniture, badges, poles,
 * arms, insulators, wires); rails, bed and wire within 480 m of the camera, poles within 300 m (120 m cells,
 * rebuilt when the camera changes cell). V.update(ms, dt, cam), V.setNight(on), V.drawCalls(), V.triangles(),
 * V.tools.shotCam(name), V.dispose(). Nothing moves, so Calm has nothing to stop here.
 */
(function(){
"use strict";
var root = typeof window !== "undefined" ? window : self;
var HQV = root.HQV = root.HQV || {};

var GAUGE = 1.435, HEAD = 0.07, GROOVE = 0.04, RAIL_C = GAUGE/2 + HEAD/2, RAIL_Y = 0.01, BED_Y = 0.006;
var POLE_MAX = 30, CHORD = 0.4, STAGGER = 0.2, WIRE_H = 5.6, MESSENGER = 0.9, SAG = 0.55, POLE_H = 7.2;
var RESERVED = 60, STENCIL = 120, SETTS = 25, ISLAND_H = 0.3, ISLAND_L = 30, ENVELOPE = 1.45;
var PLATFORM_W = 4000;   // [3.32] a tramstop site this wide (cm) or wider is a station's platform (40 m x 3 m)
var CELL = 120, FAR_RAIL = 480, FAR_POLE = 300;
var STEP = 1;    // track samples (m) for poles, beds and the chord rule

function clamp(v, a, b){ return v < a ? a : v > b ? b : v; }
function num(v, d){ return typeof v === "number" && isFinite(v) ? v : d; }
function hash32(str){
  str = String(str == null ? "" : str);
  var h = 0x811c9dc5;
  for(var i = 0; i < str.length; i++){ h ^= str.charCodeAt(i) & 0xff; h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

/* ---------- polylines (flat [x, y, z, ...]) ---------- */
function ptsOf(flat){ var out = []; for(var i = 0; i + 2 < flat.length; i += 3) out.push([flat[i], flat[i+1], flat[i+2]]); return out; }
function cumOf(P){ var c = [0]; for(var i = 1; i < P.length; i++) c.push(c[i-1] + Math.hypot(P[i][0] - P[i-1][0], P[i][2] - P[i-1][2])); return c; }
// point, unit tangent at arc length s
function at(P, C, s, o){
  o = o || {};
  var n = P.length, L = C[n-1];
  s = clamp(s, 0, L);
  var lo = 0, hi = n - 1;
  while(hi - lo > 1){ var m = (lo + hi) >> 1; if(C[m] <= s) lo = m; else hi = m; }
  var d = C[hi] - C[lo], t = d > 1e-9 ? (s - C[lo])/d : 0, a = P[lo], b = P[hi];
  o.x = a[0] + (b[0] - a[0])*t; o.y = a[1] + (b[1] - a[1])*t; o.z = a[2] + (b[2] - a[2])*t;
  var dx = b[0] - a[0], dz = b[2] - a[2], l = Math.hypot(dx, dz) || 1;
  o.tx = dx/l; o.tz = dz/l;
  return o;
}
// samples every `step` m (both ends included): [{s, x, y, z, tx, tz}]
function sample(P, step){
  var C = cumOf(P), L = C[C.length - 1], n = Math.max(1, Math.ceil(L/step - 1e-9)), out = [];
  for(var i = 0; i <= n; i++) out.push(at(P, C, L*i/n, {s: L*i/n}));
  return out;
}
// the polyline moved `off` m to the right of travel (right = (-tz, tx)... in this frame right of travel is
// (-cos yaw, sin yaw) with forward (sin yaw, cos yaw), i.e. right = (-tz, tx)), mitred joins
function offset(P, off){
  var n = P.length, out = [];
  for(var i = 0; i < n; i++){
    var a = P[Math.max(0, i - 1)], b = P[i], c = P[Math.min(n - 1, i + 1)];
    var d1x = b[0] - a[0], d1z = b[2] - a[2], d2x = c[0] - b[0], d2z = c[2] - b[2], l1 = Math.hypot(d1x, d1z), l2 = Math.hypot(d2x, d2z);
    if(l1 < 1e-9){ d1x = d2x; d1z = d2z; l1 = l2; }
    if(l2 < 1e-9){ d2x = d1x; d2z = d1z; l2 = l1; }
    l1 = l1 || 1; l2 = l2 || 1;
    var nx = -(d1z/l1 + d2z/l2), nz = d1x/l1 + d2x/l2, nl = Math.hypot(nx, nz);
    if(nl < 1e-6){ nx = -d1z/l1; nz = d1x/l1; nl = 1; }
    nx /= nl; nz /= nl;
    var cs = nx*(-d1z/l1) + nz*(d1x/l1), k = off/Math.max(0.5, cs);
    out.push([b[0] + nx*k, b[1], b[2] + nz*k]);
  }
  return out;
}
function segPointDist(px, pz, ax, az, bx, bz){
  var ux = bx - ax, uz = bz - az, l = ux*ux + uz*uz, t = l > 1e-12 ? clamp(((px - ax)*ux + (pz - az)*uz)/l, 0, 1) : 0;
  return Math.hypot(px - ax - ux*t, pz - az - uz*t);
}
function nearPoly(x, z, P){ var b = Infinity; for(var i = 1; i < P.length; i++) b = Math.min(b, segPointDist(x, z, P[i-1][0], P[i-1][2], P[i][0], P[i][2])); return b; }
function segCross(ax, az, bx, bz, cx, cz, dx, dz){
  var rx = bx - ax, rz = bz - az, sx = dx - cx, sz = dz - cz, den = rx*sz - rz*sx;
  if(Math.abs(den) < 1e-9) return null;
  var t = ((cx - ax)*sz - (cz - az)*sx)/den, u = ((cx - ax)*rz - (cz - az)*rx)/den;
  if(t < 0 || t > 1 || u < 0 || u > 1) return null;
  return {x: ax + rx*t, z: az + rz*t, t: t, u: u};
}

/* ---------- districts: is (x, z) in a park? (packed W or doc layers) ---------- */
function parkTest(W){
  var D = W && (W.districts || (W.layers && W.layers.districts)), sites = (W && (W.sites || (W.layers && W.layers.sites))) || [];
  var parks = sites.filter(function(s){ return /^(park|garden|gardens)$/.test(String(s.kind || "")); }).map(function(s){ return [s.x/100, s.z/100]; });
  var k = D && (D.k || D.kinds), legend = D && D.legend, pi = legend ? legend.indexOf("park") : -1, cell = D ? (D.cell || D.cell_cm || 800)/100 : 8, origin = D ? (D.origin != null ? D.origin : D.origin_cm != null ? D.origin_cm : 0)/100 : 0, n = D ? D.n | 0 : 0;
  return function(x, z){
    if(k && pi >= 0 && n > 0){
      var ix = Math.floor((x - origin)/cell), iz = Math.floor((z - origin)/cell);
      if(ix >= 0 && iz >= 0 && ix < n && iz < n && k[iz*n + ix] === pi) return true;
    }
    for(var i = 0; i < parks.length; i++) if(Math.hypot(parks[i][0] - x, parks[i][1] - z) < 40) return true;
    return false;
  };
}

/* ---------- layout ---------- */
function layout(W, tier, opts){
  opts = opts || {};
  var T = HQV.traffic;
  if(!T || !W) return empty();
  // [3.22.3] the side traffic keeps to (traffic.js SIDE: -1 the left): the kerb of the way of travel is SD x its right
  var SD = T.SIDE === 1 ? 1 : -1;
  var sim = opts.sim || null, lanes = T.lanes(W, tier, sim), paths = T.tramPaths(W, tier, sim), stops = T.tramStops(W, tier, sim);
  var laneByI = {};
  lanes.forEach(function(E){ laneByI[E.i] = E; });
  var ground = typeof opts.ground === "function" ? opts.ground
    : (HQV.world && HQV.world.roadY && W.edges && W.edges[0] && W.edges[0].pts && W.index !== undefined ? function(x, z){ return HQV.world.roadY(W, x, z); } : null);
  function gy(x, y, z){ if(!ground) return y; var g = ground(x, z); return typeof g === "number" && isFinite(g) ? g : y; }
  var isPark = parkTest(W);

  var tracks = paths.map(function(p){
    var P = ptsOf(p.pts).map(function(q){ return [q[0], gy(q[0], q[1], q[2]), q[2]]; }), C = cumOf(P);
    return {key: p.key, kind: p.kind, line: p.line, lines: p.lines.slice(), ei: p.ei != null ? p.ei : null, dir: p.dir != null ? p.dir : null,
            node: p.node != null ? p.node : null, P: P, len: C[C.length - 1]};
  }).filter(function(t){ return t.P.length >= 2 && t.len > 0.05; });
  var byKey = {};
  tracks.forEach(function(t){ byKey[t.key] = t; });

  // ---- rails: both sides of every track ----
  var rails = [];
  tracks.forEach(function(t){
    [-1, 1].forEach(function(side){ rails.push({key: t.key, side: side, P: offset(t.P, side*RAIL_C)}); });
  });

  // ---- diamonds: two tracks crossing away from their ends ----
  var diamonds = [];
  function bbox(P){ var b = [Infinity, Infinity, -Infinity, -Infinity]; P.forEach(function(p){ b[0] = Math.min(b[0], p[0]); b[1] = Math.min(b[1], p[2]); b[2] = Math.max(b[2], p[0]); b[3] = Math.max(b[3], p[2]); }); return b; }
  tracks.forEach(function(t){ t.box = bbox(t.P); t.C = cumOf(t.P); });
  for(var i = 0; i < tracks.length; i++) for(var j = i + 1; j < tracks.length; j++){
    var A = tracks[i], B = tracks[j];
    if(A.box[0] > B.box[2] + 1 || B.box[0] > A.box[2] + 1 || A.box[1] > B.box[3] + 1 || B.box[1] > A.box[3] + 1) continue;
    if(A.kind === "xover" || B.kind === "xover") continue;
    for(var a = 1; a < A.P.length; a++) for(var b = 1; b < B.P.length; b++){
      var h = segCross(A.P[a-1][0], A.P[a-1][2], A.P[a][0], A.P[a][2], B.P[b-1][0], B.P[b-1][2], B.P[b][0], B.P[b][2]);
      if(!h) continue;
      var sa = A.C[a-1] + (A.C[a] - A.C[a-1])*h.t, sb = B.C[b-1] + (B.C[b] - B.C[b-1])*h.u;
      if(sa < 1.5 || sa > A.len - 1.5 || sb < 1.5 || sb > B.len - 1.5) continue;
      var ux = A.P[a][0] - A.P[a-1][0], uz = A.P[a][2] - A.P[a-1][2], vx = B.P[b][0] - B.P[b-1][0], vz = B.P[b][2] - B.P[b-1][2];
      var ang = Math.abs(Math.atan2(ux*vz - uz*vx, ux*vx + uz*vz));
      if(ang > Math.PI/2) ang = Math.PI - ang;
      if(ang < 0.2) continue;
      if(diamonds.some(function(d){ return Math.hypot(d.x - h.x, d.z - h.z) < 2; })) continue;
      diamonds.push({x: h.x, y: gy(h.x, A.P[a][1], h.z), z: h.z, a: A.key, b: B.key, angle: ang, yaw: Math.atan2(ux, uz)});
    }
  }

  // ---- crossovers: switch blades at both ends, a point-motor box beside the toe, a check rail ----
  var crossovers = [];
  tracks.forEach(function(t){
    if(t.kind !== "xover") return;
    var n = t.P.length, p0 = t.P[0], p1 = t.P[n-1], q = at(t.P, t.C, 0, {}), e = at(t.P, t.C, t.len, {});
    var yaw = Math.atan2(q.tx, q.tz), rx = -q.tz, rz = q.tx;
    // which way the crossover leans (+1 to the right of travel): the side the inner rail of the curve is on
    var lean = (p1[0] - p0[0])*rx + (p1[2] - p0[2])*rz > 0 ? 1 : -1;
    crossovers.push({key: t.key, line: t.line, x: p0[0], y: p0[1], z: p0[2], yaw: yaw, lean: lean, len: t.len,
                     from: {x: p0[0], z: p0[2]}, to: {x: p1[0], z: p1[2]}, toYaw: Math.atan2(e.tx, e.tz),
                     motor: {x: p0[0] - rx*lean*2.1, y: p0[1], z: p0[2] - rz*lean*2.1, yaw: yaw},
                     check: offset(t.P, -lean*(RAIL_C - 0.09))});
  });

  // ---- stops: islands (merged per stop and direction) and totems ----
  // [3.32] City Gen v4 phase 9: a station whose site is a platform (w >= PLATFORM_W, its poly a rectangle along the
  // track) gets one island on that rectangle for every line and both ways: down the middle of a centre bed between the
  // two tracks (a tactile edge each side), or at the kerb (a tactile edge on the track side). Kerb stops on a lot and
  // older docs keep the island beside the track.
  var islands = [], totems = [], siteById = {};
  ((W.sites || (W.layers && W.layers.sites)) || []).forEach(function(s){ if(s && s.kind === "tramstop" && s.id != null) siteById[s.id] = s; });
  stops.forEach(function(st){
    var E = st.ei != null ? laneByI[st.ei] : null, tr = byKey["L:" + st.ei + ":" + st.dir];
    var P = platformOf(siteById[st.id], st, E);
    if(P){
      var have = islands.filter(function(I){ return I.site === P.site; })[0];
      if(have){ if(have.lines.indexOf(st.line) < 0) have.lines.push(st.line); return; }
      islands.push(P);
      return;
    }
    // the island runs along the track the tram stands on (its tangent there, the way the tram faces)
    var yaw = st.yaw, bt = null, bd = Infinity;
    tracks.forEach(function(t){ if(t.kind === "lane"){ var d = nearPoly(st.x, st.z, t.P); if(d < bd){ bd = d; bt = t; } } });
    if(bt && bd < 1){
      var best = 0, bk = Infinity;
      for(var k = 0; k < bt.P.length; k++){ var dd = Math.hypot(bt.P[k][0] - st.x, bt.P[k][2] - st.z); if(dd < bk){ bk = dd; best = k; } }
      var a = bt.P[Math.max(0, best - 1)], b = bt.P[Math.min(bt.P.length - 1, best + 1)], ty = Math.atan2(b[0] - a[0], b[2] - a[2]);
      yaw = Math.cos(ty - st.yaw) >= 0 ? ty : ty + Math.PI;
    }
    var fx = Math.sin(yaw), fz = Math.cos(yaw), rx = -fz, rz = fx;
    var inner = (T.SPEC.tram.wid/2 + 0.05), w = 1.2, kerb = false;
    if(E){
      var tramOff = E.tramOff || 1.475, half = E.half || 4;
      if(E.bus[st.dir] && E.busOff != null){ inner = E.busOff + T.SPEC.bus.wid/2 + 0.05 - tramOff; w = 2.0; kerb = true; }
      else w = Math.max(1.2, half - tramOff - inner);
    }
    var sameDir = islands.filter(function(I){ return I.stop === st.id && I.ei === st.ei && I.dir === st.dir && Math.hypot(I.x - st.x, I.z - st.z) < ISLAND_L; })[0];
    if(sameDir){ if(sameDir.lines.indexOf(st.line) < 0) sameDir.lines.push(st.line); return; }
    var off = inner + w/2, y = gy(st.x, st.y, st.z), side = SD;
    // on the kerb side of the stopped tram ([3.22.3] its left), unless that is on another track (a terminus stop after
    // the crossover, where the tram stands on the departure track): then on its other side, the kerb side of that track
    function clashes(sd){
      var x = st.x + rx*off*sd, z = st.z + rz*off*sd;
      return tracks.some(function(t){ return t.kind === "lane" && nearPoly(x, z, t.P) < T.SPEC.tram.wid/2 + w/2; });
    }
    if(clashes(SD) && !clashes(-SD)) side = -SD;
    var I = {id: "island:" + st.id + ":" + (st.ei != null ? st.ei : "x") + ":" + st.dir, stop: st.id, line: st.line, lines: [st.line], ei: st.ei, dir: st.dir,
             x: st.x + rx*off*side, y: y, z: st.z + rz*off*side, yaw: yaw, side: side, len: ISLAND_L, w: w, h: ISLAND_H, inner: inner, kerb: kerb,
             track: {x: st.x, z: st.z}, onTrack: !!tr};
    islands.push(I);
  });
  // a station's platform from its site: the poly's long side for the yaw (the way the stopped tram faces), its short
  // side for the width; the island's top ISLAND_H over the track it serves (on the bed for a centre one)
  function platformOf(s, st, E){
    if(!s || !(s.w >= PLATFORM_W) || !s.poly || s.poly.length < 4) return null;
    var Q = s.poly.map(function(p){ return [(+p[0] || 0)/100, (+p[1] || 0)/100]; }), cx = 0, cz = 0, lb = 0, la = Infinity, ty = 0;
    Q.forEach(function(p){ cx += p[0]/Q.length; cz += p[1]/Q.length; });
    for(var i = 0; i < Q.length; i++){
      var a = Q[i], b = Q[(i + 1) % Q.length], l = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if(l > lb){ lb = l; ty = Math.atan2(b[0] - a[0], b[1] - a[1]); }
      if(l > 0.05) la = Math.min(la, l);
    }
    if(!(lb > 4) || !(la > 0.5) || !isFinite(la)) return null;
    var yaw = Math.cos(ty - st.yaw) >= 0 ? ty : ty + Math.PI, rx = -Math.cos(yaw), rz = Math.sin(yaw);
    var centre = !!(E && E.bed > 0), along = (cx - st.x)*rx + (cz - st.z)*rz, side = along >= 0 ? 1 : -1;
    var y = gy(cx, st.y, cz);   // (the ground at its middle: a centre bed's top, the footpath, the road; hqcity3d.js stands hqcivic.js's shelter on the same)
    return {id: "island:" + s.id, site: s.id, stop: st.id, line: st.line, lines: [st.line], ei: st.ei, dir: st.dir, x: cx, y: y, z: cz, yaw: yaw,
            side: side, both: centre, platform: centre ? "centre" : "kerb", len: lb, w: la, h: ISLAND_H, inner: Math.abs(along) - la/2, kerb: !centre,
            track: {x: st.x, z: st.z}, onTrack: true};
  }
  islands.forEach(function(I){
    var fx = Math.sin(I.yaw), fz = Math.cos(I.yaw);
    I.lines.sort();
    I.lines.forEach(function(line, k){
      var d = I.len/2 - 1.2 - k*0.9;
      totems.push({island: I.id, line: line, short: T.shortOf ? T.shortOf(line, "tram") : String(line), color: T.lineColor ? T.lineColor(line) : 0xd23b3b,
                   x: I.x + fx*d, y: I.y + I.h, z: I.z + fz*d, yaw: I.yaw, h: 2.6});
    });
  });

  // ---- chains: lanes joined through gentle bends (a short turn piece: a node with no crossing road) into the
  // stretches a passenger sees as one track; beds and poles run along chains, not the doc's short edges ----
  var twoWay = {};
  lanes.forEach(function(E){ if(E.tram && byKey["L:" + E.i + ":0"] && byKey["L:" + E.i + ":1"] && /^(arterial|avenue|highway|ring)$/.test(E.cls)) twoWay[E.i] = E; });
  function classOf(t){ return t.kind !== "lane" ? "x" : twoWay[t.ei] ? "two" + t.dir : "one"; }
  var chains = [], cur = null;
  tracks.forEach(function(t){
    if(t.kind === "xover") return;
    var bend = t.kind === "turn" && t.len <= 5.5, cls = t.kind === "lane" ? classOf(t) : bend ? null : "turn";
    var last = cur && cur.P[cur.P.length - 1], joins = last && Math.hypot(last[0] - t.P[0][0], last[2] - t.P[0][2]) < 0.5;
    if(cur && joins && cls !== "turn" && cur.cls !== "turn" && (cls == null || cur.cls == null || cls === cur.cls)){
      cur.P = cur.P.concat(t.P.slice(1)); cur.keys.push(t.key);
      if(cls != null) cur.cls = cls;
      if(t.kind === "lane" && cur.E == null){ cur.E = laneByI[t.ei]; cur.dir = t.dir; }
      return;
    }
    cur = {keys: [t.key], kind: t.kind === "lane" || bend ? "run" : "turn", cls: cls, P: t.P.slice(), E: t.kind === "lane" ? laneByI[t.ei] : null, dir: t.dir};
    chains.push(cur);
  });
  chains.forEach(function(ch){ ch.C = cumOf(ch.P); ch.len = ch.C[ch.C.length - 1]; if(ch.cls == null) ch.cls = "one"; });

  // ---- beds: runs of asphalt (a reserved stretch over 60 m), setts (near a stop) or grass (by a park) ----
  var beds = [], stencils = [];
  chains.forEach(function(ch){
    // ([3.32] a centre bed is the reservation, in setts already (worldgeom.js): only grass by a park over it)
    var S = sample(ch.P, 2), onBed = !!(ch.E && ch.E.bed > 0), reserved = ch.kind === "run" && ch.len > RESERVED && !onBed, run = null, sinceStencil = STENCIL/2;
    S.forEach(function(p, k){
      var near = !onBed && stops.some(function(st){ return Math.hypot(st.x - p.x, st.z - p.z) < SETTS; });
      var kind = near ? "setts" : isPark(p.x - p.tz*3.5, p.z + p.tx*3.5) || isPark(p.x + p.tz*3.5, p.z - p.tx*3.5) ? "grass" : reserved ? "asphalt" : null;
      if(!run || run.kind !== kind){
        if(run && run.kind && run.P.length >= 2) beds.push(run);
        var tail = run && run.P.length ? run.P[run.P.length - 1] : null;
        run = {key: ch.keys[0], kind: kind, P: kind && tail ? [tail] : []};
      }
      if(kind) run.P.push([p.x, p.y, p.z]);
      if(k) sinceStencil += S[k].s - S[k-1].s;
      if(kind === "asphalt" && sinceStencil >= STENCIL && p.s > 6 && ch.len - p.s > 6){ sinceStencil = 0; stencils.push({key: ch.keys[0], x: p.x, y: p.y, z: p.z, yaw: Math.atan2(p.tx, p.tz)}); }
    });
    if(run && run.kind && run.P.length >= 2) beds.push(run);
  });

  // ---- overhead line: poles and registration points ----
  var poles = [], spans = [];
  function devOf(S, i0, j, r0, r1){
    var worst = 0;
    for(var k = Math.max(0, i0); k <= Math.min(S.length - 1, j); k++){ var d = segPointDist(S[k].x, S[k].z, r0.x, r0.z, r1.x, r1.z); if(d > worst) worst = d; }
    return worst;
  }
  function reg(p, st){ return {s: p.s, x: p.x - p.tz*st, y: p.y, z: p.z + p.tx*st, st: st}; }   // st > 0: to the right
  // greedy spans along samples S (STEP m apart): each as long as it can be (<= 30 m) with the chord between the
  // staggered registration points within `limit` of the track
  function spanPts(S, limit){
    var out = [reg(S[0], STAGGER)], i0 = 0, cur = STAGGER, n = S.length - 1;
    while(i0 < n){
      var best = null;
      for(var j = Math.min(n, i0 + Math.round(POLE_MAX/STEP)); j > i0 && !best; j--){
        [-cur, cur].forEach(function(st){
          if(best) return;
          var r1 = reg(S[j], st);
          if(devOf(S, i0, j, out[out.length - 1], r1) <= limit) best = {j: j, r: r1};
        });
      }
      if(!best) best = {j: Math.min(n, i0 + 1), r: reg(S[Math.min(n, i0 + 1)], -cur)};
      out.push(best.r); cur = best.r.st; i0 = best.j;
    }
    return out;
  }
  function addPole(key, kind, x, y, z, yaw, arm, twin, r){
    var p = {key: key, kind: kind, x: x, y: y, z: z, yaw: yaw, arm: arm, twin: !!twin, reg: {x: r.x, z: r.z}};
    poles.push(p);
    return p;
  }
  // the lane (a traffic.lanes row) under point p of chain ch: its nearest lane track's ([3.32] a chain can run on from a
  // centre bed's tracks into a shared street's, each with its own offset)
  function laneAt(ch, p){
    var best = ch.E, bd = Infinity;
    ch.keys.forEach(function(k){
      var t = byKey[k];
      if(!t || t.kind !== "lane" || !laneByI[t.ei]) return;
      var d = nearPoly(p.x, p.z, t.P);
      if(d < bd){ bd = d; best = laneByI[t.ei]; }
    });
    return best;
  }
  function centrePole(ch, p, r){
    var E = laneAt(ch, p), to = E && E.tramOff != null ? E.tramOff : 1.475;
    // the centre line is tramOff away from the kerb of either track (left of travel = (tz, -tx); [3.22.3] SD x that)
    return addPole(ch.keys[0], "centre", p.x + SD*p.tz*to, p.y, p.z - SD*p.tx*to, Math.atan2(p.tx, p.tz), to + STAGGER + 0.35, true, r);
  }
  // pass 1: every chain but the dir-1 track of a two-way arterial
  chains.forEach(function(ch){
    if(ch.cls === "two1") return;
    var S = sample(ch.P, STEP), regs = spanPts(S, ch.cls === "two0" ? CHORD*0.8 : CHORD), turnSide = 0;
    spans.push({key: ch.keys[0], keys: ch.keys, P: ch.P, S: S, regs: regs, poles: true});
    if(ch.kind === "turn"){ var a0 = at(ch.P, ch.C, 0, {}), a1 = at(ch.P, ch.C, ch.len, {}); turnSide = a0.tx*a1.tz - a0.tz*a1.tx > 0 ? -1 : 1; }
    regs.forEach(function(r, k){
      var p = at(ch.P, ch.C, r.s, {}), rx = -p.tz, rz = p.tx, yaw = Math.atan2(p.tx, p.tz);
      if(ch.kind === "turn"){
        if(k === 0 || k === regs.length - 1) return;      // the joining stretches' end poles hold those
        // ([3.22.3] on the outside of the curve, further out or else inside it where another track runs there)
        var lt = [4.2, 6.5, -4.2].map(function(m){ return m*turnSide; }).filter(function(m){
          return !tracks.some(function(t){ return t.kind === "lane" && nearPoly(p.x + rx*m, p.z + rz*m, t.P) < T.SPEC.tram.wid/2 + 0.3; });
        })[0];
        if(lt == null) return;
        addPole(ch.keys[0], "curve", p.x + rx*lt, p.y, p.z + rz*lt, yaw + (lt > 0 ? Math.PI/2 : -Math.PI/2), Math.abs(lt) + 0.3, false, r);
      } else if(ch.cls === "two0") centrePole(ch, p, r);
      else {
        var E = laneAt(ch, p), half = E ? E.half : 4, to = E && E.tramOff != null ? E.tramOff : 1.475, edge = half;
        if(E && E.bus[ch.dir] && E.busOff != null) edge = Math.max(half, E.busOff + 1.3);
        var lat = edge + 0.45 - to;
        addPole(ch.keys[0], "kerb", p.x + SD*rx*lat, p.y, p.z + SD*rz*lat, yaw + SD*Math.PI/2, lat + STAGGER + 0.3, false, r);   // ([3.22.3] the kerb: SD)
      }
    });
  });
  // pass 2: the dir-1 tracks of two-way arterials hang from the centre poles already there (the nearest point
  // of the track to each), with a pole added mid-span wherever a chord would stray or a span run over 30 m
  chains.forEach(function(ch){
    if(ch.cls !== "two1") return;
    var S = sample(ch.P, STEP), idx = [];
    poles.forEach(function(q){
      if(q.kind !== "centre") return;
      var best = -1, bd = 3.2;
      for(var k = 0; k < S.length; k++){ var d = Math.hypot(S[k].x - q.x, S[k].z - q.z); if(d < bd){ bd = d; best = k; } }
      if(best >= 0 && idx.indexOf(best) < 0) idx.push(best);
    });
    if(idx.indexOf(0) < 0) idx.push(0);
    if(idx.indexOf(S.length - 1) < 0) idx.push(S.length - 1);
    idx.sort(function(a, b){ return a - b; });
    var regs = [reg(S[idx[0]], STAGGER)], guard = 0;
    // the wire on from the last registration point to sample i1, halved (a pole of its own at each middle, own) until
    // every chord keeps within CHORD and 30 m ([3.22.3] both halves: the first was taken on trust before)
    function hang(i1, own){
      var last = regs[regs.length - 1], i0 = Math.round(last.s/STEP), r1 = reg(S[i1], -last.st);
      if(i1 - i0 > 1 && (devOf(S, i0, i1, last, r1) > CHORD || S[i1].s - S[i0].s > POLE_MAX) && guard++ < 24){
        hang(Math.round((i0 + i1)/2), true); hang(i1, own); return;
      }
      regs.push(r1);
      if(own) centrePole(ch, at(ch.P, ch.C, r1.s, {}), r1);
    }
    for(var k = 1; k < idx.length; k++){ guard = 0; hang(idx[k], false); }
    spans.push({key: ch.keys[0], keys: ch.keys, P: ch.P, S: S, regs: regs, poles: true, shared: true});
  });
  // the crossovers' wire: registration points only (held by the parallel tracks' poles)
  tracks.forEach(function(t){
    if(t.kind !== "xover") return;
    var Sx = sample(t.P, STEP);
    spans.push({key: t.key, keys: [t.key], P: t.P, S: Sx, regs: spanPts(Sx, CHORD), poles: false});
  });
  // two poles of one kind within 2 m (at the ends of joining tracks) are one pole
  var keep = [];
  poles.forEach(function(p){ if(!keep.some(function(q){ return q.kind === p.kind && Math.hypot(q.x - p.x, q.z - p.z) < 2; })) keep.push(p); });
  poles = keep;

  // ---- wires: contact (staggered chords), messenger (sagging), droppers, pull-offs ----
  var contact = [], messenger = [], droppers = [], pulloffs = [];
  spans.forEach(function(sp){
    var R = sp.regs;
    for(var k = 1; k < R.length; k++){
      var a = R[k-1], b = R[k], ya = a.y + WIRE_H, yb = b.y + WIRE_H, L = Math.hypot(b.x - a.x, b.z - a.z);
      if(L < 0.05) continue;
      contact.push(a.x, ya, a.z, b.x, yb, b.z);
      var N = 4, prev = null;
      for(var m = 0; m <= N; m++){
        var u = m/N, x = a.x + (b.x - a.x)*u, z = a.z + (b.z - a.z)*u, y = ya + (yb - ya)*u + MESSENGER - SAG*4*u*(1 - u);
        if(prev) messenger.push(prev[0], prev[1], prev[2], x, y, z);
        prev = [x, y, z];
      }
      var nd = Math.max(1, Math.floor(L/6));
      for(m = 1; m < nd; m++){
        var v = m/nd, dx = a.x + (b.x - a.x)*v, dz = a.z + (b.z - a.z)*v, dy = ya + (yb - ya)*v;
        droppers.push(dx, dy, dz, dx, dy + MESSENGER - SAG*4*v*(1 - v), dz);
      }
    }
    // a pull-off where the wire is held to the outside of a curve (two spans in a row on one side)
    for(k = 1; k + 1 < R.length; k++){
      if(R[k].st === R[k-1].st || R[k].st === R[k+1].st){
        var p = sp.S[clamp(Math.round(R[k].s/STEP), 0, sp.S.length - 1)], side = R[k].st > 0 ? 1 : -1;
        pulloffs.push(R[k].x, R[k].y + WIRE_H, R[k].z, R[k].x - p.tz*side*0.9, R[k].y + WIRE_H + 0.05, R[k].z + p.tx*side*0.9);
      }
    }
  });

  return {tier: tier, tracks: tracks, rails: rails, diamonds: diamonds, crossovers: crossovers, beds: beds, stencils: stencils,
          poles: poles, spans: spans, wires: {contact: contact, messenger: messenger, droppers: droppers, pulloffs: pulloffs},
          islands: islands, totems: totems,
          stats: {tracks: tracks.length, poles: poles.length, diamonds: diamonds.length, crossovers: crossovers.length, islands: islands.length,
                  km: tracks.reduce(function(a, t){ return a + t.len; }, 0)/1000}};
}
function empty(){ return {tier: 0, tracks: [], rails: [], diamonds: [], crossovers: [], beds: [], stencils: [], poles: [], spans: [],
                          wires: {contact: [], messenger: [], droppers: [], pulloffs: []}, islands: [], totems: [], stats: {tracks: 0, poles: 0, km: 0}}; }

/* ---------- pure geometry: per 120 m cell, flat arrays the view uploads ---------- */
// colours (linear-ish 0..1)
var COL = {head: [0.78, 0.8, 0.83], groove: [0.08, 0.08, 0.09], blade: [0.86, 0.87, 0.9], check: [0.62, 0.63, 0.66], frog: [0.2, 0.2, 0.22],
           asphalt: [0.2, 0.21, 0.23], setts: [0.42, 0.39, 0.35], setts2: [0.36, 0.33, 0.3], grass: [0.3, 0.5, 0.24], edge: [0.92, 0.92, 0.9],
           island: [0.66, 0.65, 0.62], tactile: [0.95, 0.78, 0.12], kerb: [0.55, 0.55, 0.53], motor: [0.35, 0.38, 0.33], totem: [0.18, 0.19, 0.21]};
function cellKey(x, z){ return Math.floor(x/CELL) + "," + Math.floor(z/CELL); }
function geometry(Lay){
  var cells = {};
  function cell(x, z){ var k = cellKey(x, z); return cells[k] || (cells[k] = {key: k, cx: (Math.floor(x/CELL) + 0.5)*CELL, cz: (Math.floor(z/CELL) + 0.5)*CELL,
                                                                             rails: {pos: [], col: []}, bed: {pos: [], col: []}, stencil: {pos: [], uv: []}, wires: {pos: []}}); }
  function quad(B, a, b, c, d, col){
    B.pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], a[0], a[1], a[2], c[0], c[1], c[2], d[0], d[1], d[2]);
    if(B.col) for(var i = 0; i < 6; i++) B.col.push(col[0], col[1], col[2]);
  }
  // a flat strip along P between lateral offsets o0 and o1 (m right of travel), lifted dy
  function strip(target, P, o0, o1, dy, colFn){
    var L = offset(P, o0), R = offset(P, o1);
    for(var i = 1; i < P.length; i++){
      var mx = (P[i][0] + P[i-1][0])/2, mz = (P[i][2] + P[i-1][2])/2, B = cell(mx, mz)[target];
      quad(B, [L[i-1][0], L[i-1][1] + dy, L[i-1][2]], [R[i-1][0], R[i-1][1] + dy, R[i-1][2]], [R[i][0], R[i][1] + dy, R[i][2]], [L[i][0], L[i][1] + dy, L[i][2]], colFn(i));
    }
  }
  function fine(P, step){ return sample(P, step).map(function(p){ return [p.x, p.y, p.z]; }); }
  // rails: per rail, the polished head and the dark groove on the gauge side
  Lay.tracks.forEach(function(t){
    var P = t.kind === "lane" ? t.P : fine(t.P, 1.5);
    [-1, 1].forEach(function(side){
      var c = side*RAIL_C, h0 = c - HEAD/2, h1 = c + HEAD/2, g0 = side > 0 ? h0 - GROOVE : h1, g1 = side > 0 ? h0 : h1 + GROOVE;
      strip("rails", P, Math.min(h0, h1), Math.max(h0, h1), RAIL_Y, function(){ return COL.head; });
      strip("rails", P, Math.min(g0, g1), Math.max(g0, g1), RAIL_Y - 0.001, function(){ return COL.groove; });
    });
  });
  Lay.crossovers.forEach(function(X){
    var P = fine(X.check, 1);
    strip("rails", P, -HEAD/2, HEAD/2, RAIL_Y + 0.002, function(){ return COL.check; });
    // switch blades: 4 m tapered strips at both ends, inside the stock rails
    [[X.from, X.yaw, 1], [X.to, X.toYaw, -1]].forEach(function(e){
      var fx = Math.sin(e[1]), fz = Math.cos(e[1]), rx = -fz, rz = fx, y = X.y + RAIL_Y + 0.003;
      [-1, 1].forEach(function(side){
        var c = side*(RAIL_C - HEAD), B = cell(e[0].x, e[0].z).rails;
        var a = [e[0].x + rx*c, y, e[0].z + rz*c], b = [e[0].x + rx*c + fx*4*e[2], y, e[0].z + rz*c + fz*4*e[2]];
        quad(B, a, [a[0] + rx*0.01, y, a[2] + rz*0.01], [b[0] + rx*HEAD*side, y, b[2] + rz*HEAD*side], b, COL.blade);
      });
    });
  });
  Lay.diamonds.forEach(function(D){
    var B = cell(D.x, D.z).rails, y = D.y + RAIL_Y + 0.002, s = 0.9, c = Math.cos(D.yaw), sn = Math.sin(D.yaw);
    function p(u, v){ return [D.x + u*c + v*sn, y, D.z - u*sn + v*c]; }
    quad(B, p(-s, -s), p(s, -s), p(s, s), p(-s, s), COL.frog);
  });
  // bed overlays and the white edge lines of a reserved stretch
  Lay.beds.forEach(function(b){
    var P = fine(b.P, 1), col = COL[b.kind] || COL.asphalt;
    strip("bed", P, -1.0, 1.0, BED_Y, function(i){ return b.kind === "setts" ? ((i & 1) ? COL.setts : COL.setts2) : col; });
    if(b.kind === "asphalt") [-1, 1].forEach(function(side){ strip("bed", P, side*ENVELOPE - 0.06, side*ENVELOPE + 0.06, BED_Y + 0.001, function(){ return COL.edge; }); });
  });
  // TRAM stencils: 1.2 x 3.6 m quads reading towards the oncoming tram
  Lay.stencils.forEach(function(s){
    var B = cell(s.x, s.z).stencil, fx = Math.sin(s.yaw), fz = Math.cos(s.yaw), rx = -fz, rz = fx, y = s.y + BED_Y + 0.002, w = 0.6, l = 1.8;
    function p(u, v){ return [s.x + rx*u + fx*v, y, s.z + rz*u + fz*v]; }
    var a = p(-w, -l), b = p(w, -l), c = p(w, l), d = p(-w, l);
    B.pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], a[0], a[1], a[2], c[0], c[1], c[2], d[0], d[1], d[2]);
    B.uv.push(0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1);
  });
  // wires (line segment pairs)
  ["contact", "messenger", "droppers", "pulloffs"].forEach(function(k){
    var A = Lay.wires[k];
    for(var i = 0; i + 5 < A.length; i += 6) cell((A[i] + A[i+3])/2, (A[i+2] + A[i+5])/2).wires.pos.push(A[i], A[i+1], A[i+2], A[i+3], A[i+4], A[i+5]);
  });

  // static street furniture: islands with their tactile edge, totems, point-motor boxes (one merged mesh)
  var furn = {pos: [], col: []}, badges = {pos: [], uv: [], slot: []};
  function boxAt(x, y, z, yaw, w, h, d, col){
    var c = Math.cos(yaw), s = Math.sin(yaw);
    function p(u, v, k){ return [x + u*c + k*s, y + v, z - u*s + k*c]; }
    var hw = w/2, hd = d/2, P = [p(-hw, 0, -hd), p(hw, 0, -hd), p(hw, 0, hd), p(-hw, 0, hd), p(-hw, h, -hd), p(hw, h, -hd), p(hw, h, hd), p(-hw, h, hd)];
    [[4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]].forEach(function(f){ quad(furn, P[f[0]], P[f[1]], P[f[2]], P[f[3]], col); });
  }
  Lay.islands.forEach(function(I){
    var fx = Math.sin(I.yaw), fz = Math.cos(I.yaw), rx = -fz, rz = fx;
    boxAt(I.x, I.y, I.z, I.yaw, I.w, I.h, I.len, COL.island);
    // the tactile edge: ribs across a 0.4 m yellow band along the track side ([3.32] both sides of a centre platform)
    (I.both ? [-1, 1] : [-(I.side || 1)]).forEach(function(sd){
      var e = sd*(I.w/2 - 0.2), ribs = Math.floor(I.len/0.3);
      boxAt(I.x + rx*e, I.y + I.h, I.z + rz*e, I.yaw, 0.4, 0.004, I.len, COL.tactile);
      for(var k = 0; k < ribs; k += 2){
        var d = -I.len/2 + (k + 0.5)*0.3;
        boxAt(I.x + rx*e + fx*d, I.y + I.h + 0.004, I.z + rz*e + fz*d, I.yaw, 0.36, 0.006, 0.12, COL.tactile);
      }
    });
  });
  Lay.totems.forEach(function(t, k){
    var cc = [((t.color >> 16) & 255)/255, ((t.color >> 8) & 255)/255, (t.color & 255)/255];
    boxAt(t.x, t.y, t.z, t.yaw, 0.32, t.h - 0.55, 0.14, COL.totem);
    boxAt(t.x, t.y + t.h - 0.55, t.z, t.yaw, 0.5, 0.55, 0.16, cc);
    // the badge (text from the atlas) on both faces
    var c = Math.cos(t.yaw), s = Math.sin(t.yaw), y0 = t.y + t.h - 0.5, y1 = t.y + t.h - 0.05, hw = 0.22;
    [0.0805, -0.0805].forEach(function(dd, f){
      function p(u, v){ return [t.x + u*c + dd*s, v, t.z - u*s + dd*c]; }
      var a = p(f ? hw : -hw, y0), b = p(f ? -hw : hw, y0), q = p(f ? -hw : hw, y1), r = p(f ? hw : -hw, y1);
      badges.pos.push(a[0], a[1], a[2], b[0], b[1], b[2], q[0], q[1], q[2], a[0], a[1], a[2], q[0], q[1], q[2], r[0], r[1], r[2]);
      badges.slot.push(k);
    });
  });
  Lay.crossovers.forEach(function(X){ boxAt(X.motor.x, X.motor.y, X.motor.z, X.motor.yaw, 0.5, 0.35, 1.1, COL.motor); });
  return {cells: cells, furniture: furn, badges: badges};
}
function triCount(arr){ return Math.floor(arr.length/9); }

/* ---------- view (THREE from c.THREE, only inside view()) ---------- */
function view(c, W, tier, opts){
  opts = opts || {};
  var THREE = c.THREE, Lay = opts.layout || layout(W, tier, {sim: opts.sim, ground: opts.ground}), G = geometry(Lay);
  var group = new THREE.Group(); group.name = "hqtramway";
  var night = false, lastCell = null, mtx = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(0, 0, 0, "YXZ"),
      pv = new THREE.Vector3(), sv = new THREE.Vector3(1, 1, 1);
  var railM = new THREE.MeshStandardMaterial({vertexColors: true, roughness: 0.35, metalness: 0.6, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3});
  var bedM = new THREE.MeshStandardMaterial({vertexColors: true, roughness: 0.95, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2});
  var furnM = new THREE.MeshStandardMaterial({vertexColors: true, roughness: 0.8, metalness: 0.05});
  var poleM = new THREE.MeshStandardMaterial({color: 0x5b6168, roughness: 0.6, metalness: 0.4});
  var insM = new THREE.MeshStandardMaterial({color: 0x7a3b22, roughness: 0.5});
  var wireM = new THREE.LineBasicMaterial({color: 0x2a2c30});
  var stencilTex = canvasTex(256, 64, function(g){ g.fillStyle = "#ffffff"; g.font = "bold 52px sans-serif"; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText("TRAM", 128, 34); });
  var stencilM = new THREE.MeshBasicMaterial({color: 0xf2f2ee, map: stencilTex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4});
  // badges: an atlas of the stops' line badges, 4 x 4 cells
  var shorts = [], cols = [];
  Lay.totems.forEach(function(t){ if(shorts.indexOf(t.short) < 0){ shorts.push(t.short); cols.push(t.color); } });
  var badgeTex = canvasTex(256, 256, function(g){
    shorts.forEach(function(sh, k){
      var x = (k % 4)*64, y = Math.floor(k/4)*64, col = cols[k];
      g.fillStyle = "#ffffff"; g.fillRect(x + 2, y + 2, 60, 60);
      g.fillStyle = "#" + ("00000" + (col >>> 0).toString(16)).slice(-6); g.fillRect(x + 6, y + 6, 52, 52);
      g.fillStyle = "#ffffff"; g.font = "bold 30px sans-serif"; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(sh, x + 32, y + 34);
    });
  });
  var badgeM = new THREE.MeshBasicMaterial({map: badgeTex, color: 0xffffff});

  function canvasTex(w, h, draw){
    if(typeof document === "undefined" || !document.createElement) return null;
    try {
      var cv = document.createElement("canvas"); cv.width = w; cv.height = h;
      var g = cv.getContext("2d"); if(!g) return null;
      draw(g);
      var t = new THREE.CanvasTexture(cv); t.anisotropy = 4;
      return t;
    } catch(err){ return null; }
  }
  function meshOf(name, mat, lines){
    var geo = new THREE.BufferGeometry(), m = lines ? new THREE.LineSegments(geo, mat) : new THREE.Mesh(geo, mat);
    m.name = "hqtramway-" + name; m.frustumCulled = false; m.receiveShadow = !lines; m.matrixAutoUpdate = false;
    group.add(m); return m;
  }
  function upload(m, pos, col, uv, normalsUp){
    var geo = m.geometry;
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    if(col) geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
    if(uv) geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    if(normalsUp){
      var n = new Float32Array(pos.length);
      for(var i = 1; i < n.length; i += 3) n[i] = 1;
      geo.setAttribute("normal", new THREE.BufferAttribute(n, 3));
    }
    geo.computeBoundingSphere();
    m.visible = pos.length > 0;
  }
  var rails = meshOf("rails", railM), bed = meshOf("bed", bedM), stencil = meshOf("stencils", stencilM), wires = meshOf("wires", wireM, true);
  var furn = meshOf("furniture", furnM), badge = meshOf("badges", badgeM);
  upload(furn, G.furniture.pos, G.furniture.col, null, false); furn.geometry.computeVertexNormals();
  (function(){
    var uv = [];
    G.badges.slot.forEach(function(k){
      var i = shorts.indexOf(Lay.totems[k].short), u0 = (i % 4)/4, v1 = 1 - Math.floor(i/4)/4, u1 = u0 + 0.25, v0 = v1 - 0.25;
      uv.push(u0, v0, u1, v0, u1, v1, u0, v0, u1, v1, u0, v1);
    });
    upload(badge, G.badges.pos, null, uv, false); badge.geometry.computeVertexNormals();
  })();
  // instanced poles, arms, insulators (all of them; the visible ones are written on a cell change)
  var poleG = new THREE.CylinderGeometry(0.09, 0.12, POLE_H, 8); poleG.translate(0, POLE_H/2, 0);
  var armG = new THREE.BoxGeometry(1, 0.08, 0.08); armG.translate(0.5, 0, 0);
  var insG = new THREE.CylinderGeometry(0.05, 0.05, 0.28, 6); insG.rotateZ(Math.PI/2);
  var nArms = Lay.poles.reduce(function(a, p){ return a + (p.twin ? 2 : 1); }, 0);
  var poleI = inst("poles", poleG, poleM, Math.max(1, Lay.poles.length)), armI = inst("arms", armG, poleM, Math.max(1, nArms)), insI = inst("insulators", insG, insM, Math.max(1, nArms));
  function inst(name, geo, mat, n){
    var m = new THREE.InstancedMesh(geo, mat, n);
    m.name = "hqtramway-" + name; m.count = 0; m.frustumCulled = false; m.castShadow = true;
    group.add(m); return m;
  }
  function put(m, i, x, y, z, yaw, sx){
    e.set(0, yaw, 0); q.setFromEuler(e); pv.set(x, y, z); sv.set(sx || 1, 1, 1); mtx.compose(pv, q, sv); m.setMatrixAt(i, mtx);
  }
  function rebuild(cx, cz){
    var keys = Object.keys(G.cells).filter(function(k){ var C = G.cells[k]; return Math.hypot(C.cx - cx, C.cz - cz) <= FAR_RAIL + CELL*0.71; }).sort();
    function cat(part, field){ var out = []; keys.forEach(function(k){ var a = G.cells[k][part][field]; for(var i = 0; i < a.length; i++) out.push(a[i]); }); return out; }
    upload(rails, cat("rails", "pos"), cat("rails", "col"), null, true);
    upload(bed, cat("bed", "pos"), cat("bed", "col"), null, true);
    upload(stencil, cat("stencil", "pos"), null, cat("stencil", "uv"), true);
    upload(wires, cat("wires", "pos"), null, null, false);
    var n = 0, a = 0;
    Lay.poles.forEach(function(p){
      if(Math.hypot(p.x - cx, p.z - cz) > FAR_POLE) return;
      put(poleI, n++, p.x, p.y, p.z, 0);
      // an arm from the pole over each track it holds, at 6.0 m, with an insulator near its tip
      var dirs = p.twin ? [p.yaw + Math.PI/2, p.yaw - Math.PI/2] : [p.yaw];
      dirs.forEach(function(yw){
        var len = p.twin ? p.arm : p.arm, y = p.y + WIRE_H + 0.45;
        put(armI, a, p.x, y, p.z, yw - Math.PI/2, len);
        var fx = Math.sin(yw), fz = Math.cos(yw);
        put(insI, a, p.x + fx*(len - 0.5), y, p.z + fz*(len - 0.5), yw - Math.PI/2);
        a++;
      });
    });
    poleI.count = n; armI.count = a; insI.count = a;
    [poleI, armI, insI].forEach(function(m){ m.instanceMatrix.needsUpdate = true; });
  }
  function setNight(on){
    night = !!on;
    // polished heads catch the street lights: a little self-light at night
    railM.emissive.setRGB(night ? 0.12 : 0, night ? 0.12 : 0, night ? 0.13 : 0);
    furnM.emissive.setRGB(night ? 0.03 : 0, night ? 0.03 : 0, night ? 0.03 : 0);
  }
  function update(ms, dt, cam){
    if(opts.night) setNight(!!opts.night());
    if(!cam) return;
    var k = cellKey(num(cam.x, 0), num(cam.z, 0));
    if(k !== lastCell){ lastCell = k; rebuild((Math.floor(num(cam.x, 0)/CELL) + 0.5)*CELL, (Math.floor(num(cam.z, 0)/CELL) + 0.5)*CELL); }
  }
  function drawCalls(){ var n = 0; group.children.forEach(function(m){ if(m.visible && (m.isInstancedMesh ? m.count > 0 : m.geometry.attributes.position && m.geometry.attributes.position.count > 0)) n++; }); return n; }
  function triangles(){
    var t = 0;
    group.children.forEach(function(m){
      if(!m.visible || m.isLineSegments) return;
      var g = m.geometry, per = g.index ? g.index.count/3 : (g.attributes.position ? g.attributes.position.count/3 : 0);
      t += m.isInstancedMesh ? per*m.count : per;
    });
    return Math.round(t);
  }
  function shotCam(name){
    if(name === "tram-junction" && Lay.diamonds.length + Lay.tracks.length){
      var D = Lay.diamonds[0] || (function(){ var t = Lay.tracks.filter(function(x){ return x.kind === "turn"; })[0] || Lay.tracks[0], p = t.P[Math.floor(t.P.length/2)]; return {x: p[0], y: p[1], z: p[2]}; })();
      return {pos: {x: D.x + 18, y: D.y + 14, z: D.z + 18}, look: {x: D.x, y: D.y, z: D.z}, fov: 55};
    }
    if(name === "tram-stop" && Lay.islands.length){
      var I = Lay.islands[0], fx = Math.sin(I.yaw), fz = Math.cos(I.yaw), rx = -fz, rz = fx;
      return {pos: {x: I.x + fx*22 + rx*7, y: I.y + 3.2, z: I.z + fz*22 + rz*7}, look: {x: I.x, y: I.y + 1.2, z: I.z}, fov: 55};
    }
    if(name === "tram-crossover" && Lay.crossovers.length){
      var X = Lay.crossovers[0];
      return {pos: {x: X.x - Math.sin(X.yaw)*12, y: X.y + 9, z: X.z - Math.cos(X.yaw)*12}, look: {x: (X.from.x + X.to.x)/2, y: X.y, z: (X.from.z + X.to.z)/2}, fov: 55};
    }
    return null;
  }
  function dispose(){
    group.children.slice().forEach(function(m){ m.geometry.dispose(); if(m.dispose && m.isInstancedMesh) m.dispose(); });
    [railM, bedM, furnM, poleM, insM, wireM, stencilM, badgeM].forEach(function(m){ m.dispose(); });
    [stencilTex, badgeTex].forEach(function(t){ if(t) t.dispose(); });
    if(group.parent) group.parent.remove(group);
  }
  setNight(false);
  if(opts.parent) opts.parent.add(group);
  return {group: group, layout: Lay, update: update, setNight: setNight, drawCalls: drawCalls, triangles: triangles, focus: function(){},
          tools: {shotCam: shotCam}, dispose: dispose};
}

HQV.hqTramway = {layout: layout, geometry: geometry, view: view, triCount: triCount,
                 GAUGE: GAUGE, HEAD: HEAD, GROOVE: GROOVE, RAIL_C: RAIL_C, RAIL_Y: RAIL_Y, POLE_MAX: POLE_MAX, CHORD: CHORD, STAGGER: STAGGER,
                 WIRE_H: WIRE_H, ISLAND_H: ISLAND_H, SETTS: SETTS, STENCIL: STENCIL, RESERVED: RESERVED, CELL: CELL, FAR_RAIL: FAR_RAIL, FAR_POLE: FAR_POLE,
                 _: {sample: sample, offset: offset, segPointDist: segPointDist, cumOf: cumOf, ptsOf: ptsOf}};
})();
