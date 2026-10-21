/* Claude HQ: the airfield's ground, markings, lights and field furniture (HQV.hqAirport3d), drawn from the airfield
 * layout L (docs/plans/airport-spec.md sections 3, 4, 9 and 10; HQV.hqAirfield.layout, the Commons fixture
 * tests/fixtures/airfield_commons.json). City metres, yaw 0 faces +z.
 *
 *   plan(L, {ground}) -> P   pure (no THREE, no DOM). ground(x, z) is the terrain height (landside roads follow it,
 *                            and it tells land from water along the platform's edge; without it every edge is water
 *                            and the landside sits at L.ySite). P = {
 *       y: the layer heights over L.y, surf: [{c, q, two}] the untextured surfaces (one vertex-coloured mesh: grass,
 *       service zones, shoulders, pads, taxiways, the service road, landside roads, rock, walls, parapets), q is a quad
 *       [x0, y0, z0, .. x3, y3, z3]; runway {q, uv}; apron [{q}] (world UVs); paint {white, yellow, red, black: [q]};
 *       lights [{x, y, z, g, end?, a?, i?, alt?}] (g: edge, centre, thr, tdz, appr, apprRed, tedge, tcl, stop, flood,
 *       obst, sock); papi [{x, y, z, end, i}]; rabbit [[[x, y, z] x 14, 420 m out first] per end];
 *       fixtures {boxes: [{x, y, z, w, h, d, yaw, c}], cyls: [{x, z, y0, y1, r0, r1, seg, c}]};
 *       fence [[[x, z], [x, z]]] (fenceY); signs [{x, y, z, yaw, cell}] + cells [{text, kind}]; masts [{x, z, h}];
 *       pools [{x, z, r}]; socks [{x, y, z}]; holds [{c, d, end}]; edges {water, land} (5 m pieces) }
 *   lampColor(l, endIdx, clear, blinkOn) -> [r, g, b] (linear) or null (off): the colour rules of section 4
 *   papiWhite(i, elevDeg)    box i (0 = inner) shows white above PAPI_DEG[i]
 *   create(c, L, o) -> A     c: the hq3d ctx (THREE, mat, canvasTex); o: {ground, night, detail, endIdx}
 *     A.g                    the group (world = city metres; add it at the city's origin)
 *     A.setNight(n)          lamps full bright and their glow (one Points cloud), sign faces lit, sodium pools on
 *     A.setRunway(endIdx)    the in-use end (an index into L.runway.ends): edge, centreline, threshold, TDZ, approach
 *     A.setHold(endIdx, c)   that end's stop bar goes dark while c (its departure is lining up)
 *     A.setWind({yaw, speed}) the socks ease toward yaw (where they point: downwind) and droop below 12 m/s
 *     A.setDetail(level)     2 near (all), 1 mid (ground, white + yellow paint, lamps + glow + rabbit at night),
 *                            0 far (ground, white paint, glow at night). Toggles `visible` only.
 *     A.update(dt, t, cam)   PAPI against cam's elevation, obstruction blink (1 Hz), the rabbit (2 Hz), socks
 *     A.stats() -> {lamps, glow, tris, canvasBytes, detail, night, endIdx}     A.dispose()
 * Draw calls: ground 3 (vertex-coloured mesh, runway rubber canvas, apron joint canvas), paint 4, lamps + glow +
 * PAPI + rabbit + pools 5, fixtures 1, signs 1, fence 1, socks 1: 16 at night near, 8 mid, 5 far.
 */
(function(){
"use strict";
var root = typeof window !== "undefined" ? window : self;
var HQV = root.HQV = root.HQV || {};

// layer heights over L.y (later in the vertex mesh = higher: a tie at distance goes to the upper layer)
var Y = {grass: 0, svc: 0.02, shoulder: 0.03, pad: 0.04, apron: 0.05, taxi: 0.06, rwy: 0.07, road: 0.08, paint: 0.1, ink: 0.095};
var COL = {grass: 0x6f8f4f, rwy: 0x2b2d30, rubber: 0x1f2023, conc: 0x8a8a85, rwyShoulder: 0x4a4d52, taxi: 0x3a3d42,
           taxiShoulder: 0x55585c, apron: 0xa8a69e, pad: 0x55575b, road: 0x3a3d42, walk: 0xa49f94, curb: 0xc4c0b6,
           rock: 0x7d776c, wall: 0x75726b, svc: 0x98968e, parapet: 0xa3a097,
           white: 0xf2f2ee, yellow: 0xf2c230, red: 0xc8281e, black: 0x16171a,
           steel: 0x8d939a, galv: 0x9aa1a6, deck: 0x6f6a62, pile: 0x5b5750, shed: 0xd8d4c8, roof: 0x5d6670,
           antenna: 0xe9e9e4, frame: 0x30343a, signBody: 0x202226, orange: 0xf06a1c, sockWhite: 0xf4f2ec};
var LIGHT = {white: [1, 0.96, 0.86], yellow: [1, 0.72, 0.14], red: [1, 0.07, 0.04], green: [0.1, 1, 0.35],
             blue: [0.15, 0.35, 1], sodium: [1, 0.43, 0.12], strobe: [1, 1, 1]};
var LAMP_OFF = [0.07, 0.07, 0.07];
var PAPI_DEG = [3.5, 3.17, 2.83, 2.5];
var DAY_LAMP = 0.35;
var MASTS_H = 25, SOCK_POLE = 6, SOCK_LEN = 3.6;

/* ---------- small pure helpers ---------- */
function num(v, d){ v = +v; return isFinite(v) ? v : d; }
function hashStr(s){ var h = 0x811c9dc5; s = String(s); for(var i = 0; i < s.length; i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h >>> 0; }
function rng(seed){ var a = seed >>> 0 || 1; return function(){ a = (a + 0x6D2B79F5) >>> 0; var t = a; t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0)/4294967296; }; }
function unit(dx, dz){ var l = Math.hypot(dx, dz) || 1; return [dx/l, dz/l]; }
function inPoly(P, x, z){ var c = false; for(var i = 0, j = P.length - 1; i < P.length; j = i++){ var a = P[i], b = P[j];
  if((a[1] > z) !== (b[1] > z) && x < (b[0] - a[0])*(z - a[1])/(b[1] - a[1]) + a[0]) c = !c; } return c; }
function distSeg(px, pz, a, b){ var dx = b[0] - a[0], dz = b[1] - a[1], l2 = dx*dx + dz*dz, t = l2 > 0 ? ((px - a[0])*dx + (pz - a[1])*dz)/l2 : 0;
  t = Math.max(0, Math.min(1, t)); return Math.hypot(px - a[0] - dx*t, pz - a[1] - dz*t); }
function distPoly(px, pz, pts){ var d = Infinity; for(var i = 0; i + 1 < pts.length; i++) d = Math.min(d, distSeg(px, pz, pts[i], pts[i + 1])); return d; }
function lenOf(pts){ var s = 0; for(var i = 0; i + 1 < pts.length; i++) s += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]); return s; }
// the point and heading at arc length s along a polyline
function along(pts, s){
  var acc = 0;
  for(var i = 0; i + 1 < pts.length; i++){
    var a = pts[i], b = pts[i + 1], l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if(acc + l >= s || i + 2 === pts.length){ var t = l > 0 ? Math.max(0, Math.min(1, (s - acc)/l)) : 0;
      return {p: [a[0] + (b[0] - a[0])*t, a[1] + (b[1] - a[1])*t], d: unit(b[0] - a[0], b[1] - a[1])}; }
    acc += l;
  }
  return {p: pts[0].slice(), d: [0, 1]};
}
// a polyline re-sampled at <= step m (corners kept)
function densify(pts, step){
  var out = [pts[0]];
  for(var i = 0; i + 1 < pts.length; i++){
    var a = pts[i], b = pts[i + 1], n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1])/step));
    for(var k = 1; k <= n; k++) out.push([a[0] + (b[0] - a[0])*k/n, a[1] + (b[1] - a[1])*k/n]);
  }
  return out;
}
// the part of a polyline between arc lengths s0 and s1
function cut(pts, s0, s1){
  var out = [along(pts, s0).p], acc = 0;
  for(var i = 0; i + 1 < pts.length; i++){ acc += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]); if(acc > s0 && acc < s1) out.push(pts[i + 1]); }
  out.push(along(pts, s1).p); return out;
}
function frameOf(L){
  var f = L.frame || {}, o = f.o || [0, 0], B = f.B || [1, 0], T = f.T || [0, 1];
  return {o: o, B: B, T: T, RU: num(f.RU, 0),
    w: function(u, v){ return [o[0] + u*B[0] + v*T[0], o[1] + u*B[1] + v*T[1]]; },
    f: function(x, z){ var dx = x - o[0], dz = z - o[1]; return [dx*B[0] + dz*B[1], dx*T[0] + dz*T[1]]; }};
}
function rectF(F, poly){
  var r = [Infinity, -Infinity, Infinity, -Infinity];
  (poly || []).forEach(function(p){ var q = F.f(p[0], p[1]); r[0] = Math.min(r[0], q[0]); r[1] = Math.max(r[1], q[0]); r[2] = Math.min(r[2], q[1]); r[3] = Math.max(r[3], q[1]); });
  return r;
}
// axis-aligned (frame) rectangle difference: r minus every rectangle in cuts -> [rect]
function rectMinus(r, cuts){
  var out = [r];
  cuts.forEach(function(c){
    var next = [];
    out.forEach(function(a){
      if(c[0] >= a[1] || c[1] <= a[0] || c[2] >= a[3] || c[3] <= a[2]){ next.push(a); return; }
      if(c[0] > a[0]) next.push([a[0], c[0], a[2], a[3]]);
      if(c[1] < a[1]) next.push([c[1], a[1], a[2], a[3]]);
      var u0 = Math.max(a[0], c[0]), u1 = Math.min(a[1], c[1]);
      if(c[2] > a[2]) next.push([u0, u1, a[2], c[2]]);
      if(c[3] < a[3]) next.push([u0, u1, c[3], a[3]]);
    });
    out = next;
  });
  return out;
}
function same(a, b){ return JSON.stringify(a) === JSON.stringify(b); }

/* ---------- quads ---------- */
function quad(a, b, c, d, ya, yb, yc, yd){ return [a[0], ya, a[1], b[0], yb, b[1], c[0], yc, c[1], d[0], yd, d[1]]; }
function flat(a, b, c, d, y){ return quad(a, b, c, d, y, y, y, y); }
function segQ(a, b, w, y){ var d = unit(b[0] - a[0], b[1] - a[1]), n = [-d[1]*w/2, d[0]*w/2];
  return flat([a[0] + n[0], a[1] + n[1]], [b[0] + n[0], b[1] + n[1]], [b[0] - n[0], b[1] - n[1]], [a[0] - n[0], a[1] - n[1]], y); }
// left/right edge points of a polyline at half-width w/2 (mitred; closed when the last point repeats the first)
function edges(pts, w){
  var n = pts.length, closed = n > 2 && Math.hypot(pts[0][0] - pts[n - 1][0], pts[0][1] - pts[n - 1][1]) < 1e-6, out = [];
  for(var i = 0; i < n; i++){
    var p = pts[i], ip = i > 0 ? i - 1 : (closed ? n - 2 : -1), inx = i < n - 1 ? i + 1 : (closed ? 1 : -1);
    var d0 = ip >= 0 ? unit(p[0] - pts[ip][0], p[1] - pts[ip][1]) : null, d1 = inx >= 0 ? unit(pts[inx][0] - p[0], pts[inx][1] - p[1]) : null;
    var d = d0 && d1 ? unit(d0[0] + d1[0], d0[1] + d1[1]) : (d0 || d1), nx = -d[1], nz = d[0], k = 1;
    if(d0 && d1) k = 1/Math.max(0.35, -d0[1]*nx + d0[0]*nz);
    out.push([[p[0] + nx*w/2*k, p[1] + nz*w/2*k], [p[0] - nx*w/2*k, p[1] - nz*w/2*k]]);
  }
  return out;
}
function ribbon(list, pts, w, y, yAt){
  var E = edges(pts, w);
  for(var i = 0; i + 1 < E.length; i++){
    var a = E[i][0], b = E[i + 1][0], c = E[i + 1][1], d = E[i][1];
    list.push(yAt ? quad(a, b, c, d, yAt(a), yAt(b), yAt(c), yAt(d)) : flat(a, b, c, d, y));
  }
}
// dashes along each straight segment of a polyline (restarting at every corner)
function dashes(list, pts, w, y, dash, gap, yAt){
  for(var i = 0; i + 1 < pts.length; i++){
    var a = pts[i], b = pts[i + 1], l = Math.hypot(b[0] - a[0], b[1] - a[1]), d = unit(b[0] - a[0], b[1] - a[1]);
    for(var s = gap/2; s + dash <= l + 1e-6; s += dash + gap){
      var p = [a[0] + d[0]*s, a[1] + d[1]*s], q = [a[0] + d[0]*(s + dash), a[1] + d[1]*(s + dash)];
      if(yAt){ var Q = segQ(p, q, w, 0); Q[1] = yAt([Q[0], Q[2]]); Q[4] = yAt([Q[3], Q[5]]); Q[7] = yAt([Q[6], Q[8]]); Q[10] = yAt([Q[9], Q[11]]); list.push(Q); }
      else list.push(segQ(p, q, w, y));
    }
  }
}
// seven-segment digits: str laid out about origin o, `up` and `right` unit vectors, height h, width w, stroke s
var SEGS = {"0": "abcdef", "1": "1", "2": "abdeg", "3": "abcdg", "4": "bcfg", "5": "acdfg", "6": "acdefg", "7": "abc", "8": "abcdefg", "9": "abcdfg"};
function digits(list, str, o, up, right, h, w, s, gap, y, grow){
  str = String(str).replace(/[^0-9]/g, "").slice(0, 3); grow = grow || 0;
  var total = str.length*w + Math.max(0, str.length - 1)*gap, x0 = -total/2;
  function rect(xa, xb, ya, yb){
    xa -= grow; xb += grow; ya -= grow; yb += grow;
    var P = function(x, v){ return [o[0] + right[0]*x + up[0]*v, o[1] + right[1]*x + up[1]*v]; };
    list.push(flat(P(xa, ya), P(xb, ya), P(xb, yb), P(xa, yb), y));
  }
  for(var k = 0; k < str.length; k++){
    var x = x0 + k*(w + gap), segs = SEGS[str[k]] || "";
    if(segs === "1"){ rect(x + (w - s)/2, x + (w + s)/2, 0, h); continue; }
    for(var j = 0; j < segs.length; j++){
      var g = segs[j];
      if(g === "a") rect(x, x + w, h - s, h);
      else if(g === "b") rect(x + w - s, x + w, h/2, h);
      else if(g === "c") rect(x + w - s, x + w, 0, h/2);
      else if(g === "d") rect(x, x + w, 0, s);
      else if(g === "e") rect(x, x + s, 0, h/2);
      else if(g === "f") rect(x, x + s, h/2, h);
      else if(g === "g") rect(x, x + w, h/2 - s/2, h/2 + s/2);
    }
  }
}

/* ---------- plan (pure) ---------- */
function plan(L, opts){
  L = L || {}; opts = opts || {};
  if(!L.ok || !L.runway || !L.frame) return null;
  var F = frameOf(L), RU = F.RU, y0 = num(L.y, 0), sea = num(L.sea, -4), ySite = num(L.ySite, y0);
  var ground = typeof opts.ground === "function" ? opts.ground : null;
  var gAt = function(x, z){ var h = ground ? +ground(x, z) : NaN; return isFinite(h) ? h : null; };
  var yLand = function(p){ var h = gAt(p[0], p[1]); return (h != null ? h : ySite) + 0.15; };
  var R = L.runway, ends = R.ends || [], E0 = ends[0], len = num(R.len, 1600), RW = num(R.w, 45), SH = num(R.shoulder, 7.5), PAD = num(R.pad, 60);
  var W = L.widths || {}, TW = num(W.A, 18), TSH = num(W.shoulder, 3.5), lines = L.lines || {}, curves = {};
  // the curves plus the arrivals' A -> B U-turns at the end links (HQV.hqAirfield.uturns: flown, so painted and lit)
  var UT = HQV.hqAirfield && HQV.hqAirfield.uturns ? HQV.hqAirfield.uturns(L) : {};
  [L.curves || {}, UT].forEach(function(o){ Object.keys(o).forEach(function(k){ curves[k] = o[k]; }); });
  var P = {y: {}, surf: [], runway: null, apron: [], paint: {white: [], yellow: [], red: [], black: []}, lights: [], papi: [], rabbit: [],
           fixtures: {boxes: [], cyls: []}, fence: [], fenceY: y0 + 0.1, signs: [], cells: [], masts: [], pools: [], socks: [], holds: [],
           edges: {water: 0, land: 0}};
  Object.keys(Y).forEach(function(k){ P.y[k] = y0 + Y[k]; });
  var yP = y0 + Y.paint, PW = P.paint;
  function pE(E, a, l){ return [E.thr[0] + E.dir[0]*a + E.left[0]*l, E.thr[1] + E.dir[1]*a + E.left[1]*l]; }
  function rectE(list, E, a0, a1, l0, l1, y){ list.push(flat(pE(E, a0, l0), pE(E, a1, l0), pE(E, a1, l1), pE(E, a0, l1), y)); }
  function surf(q, c, two){ P.surf.push({c: c, q: q, two: !!two}); }
  function box(x, y, z, w, h, d, yaw, c){ P.fixtures.boxes.push({x: x, y: y, z: z, w: w, h: h, d: d, yaw: yaw || 0, c: c}); }
  function cyl(x, z, ya, yb, r0, r1, seg, c){ P.fixtures.cyls.push({x: x, z: z, y0: ya, y1: yb, r0: r0, r1: r1, seg: seg || 8, c: c}); }
  function yawOf(d){ return Math.atan2(d[0], d[1]); }
  var exitIds = ["A2", "A3", "A4", "A5"].filter(function(k){ return lines[k]; });
  var taxiIds = ["A", "B", "A1", "A6"].filter(function(k){ return lines[k]; }).concat(exitIds);
  var curveIds = Object.keys(curves).filter(function(k){ return !/^S/.test(k); });
  var apronR = (L.apron || []).map(function(p){ return rectF(F, p); });
  var onApron = function(x, z){ return (L.apron || []).some(function(p){ return inPoly(p, x, z); }); };
  var onRunway = function(x, z, extra){ var q = F.f(x, z), qr = F.f(R.c[0], R.c[1]); return Math.abs(q[0] - RU) < RW/2 + (extra || 0) && Math.abs(q[1] - qr[1]) < len/2 + PAD; };
  // within r of another taxiway's centreline or a non-stand curve (bounding boxes first: this runs per metre of edge)
  var others = taxiIds.map(function(k){ return {id: k, pts: lines[k]}; }).concat(curveIds.map(function(k){ return {id: k.split("/")[0], pts: curves[k]}; }));
  others.forEach(function(t){ var b = [Infinity, -Infinity, Infinity, -Infinity];
    t.pts.forEach(function(p){ b[0] = Math.min(b[0], p[0]); b[1] = Math.max(b[1], p[0]); b[2] = Math.min(b[2], p[1]); b[3] = Math.max(b[3], p[1]); }); t.box = b; });
  function onOther(x, z, own, r){
    for(var i = 0; i < others.length; i++){
      var t = others[i], b = t.box;
      if(t.id === own || x < b[0] - r || x > b[1] + r || z < b[2] - r || z > b[3] + r) continue;
      if(distPoly(x, z, t.pts) < r) return true;
    }
    return false;
  }

  /* ----- surfaces: grass (main strip minus the apron), service zones, shoulders, pads, taxiways ----- */
  var main = (L.platform || []).filter(function(p){
    return !(L.apron || []).some(function(a){ return same(a, p); }) && !Object.keys(L.service || {}).some(function(k){ return same(L.service[k], p); });
  });
  main.forEach(function(p){
    rectMinus(rectF(F, p), apronR).forEach(function(r){ surf(flat(F.w(r[0], r[2]), F.w(r[1], r[2]), F.w(r[1], r[3]), F.w(r[0], r[3]), P.y.grass), COL.grass); });
  });
  ["fuel", "fire", "hangars"].forEach(function(k){ var p = (L.service || {})[k]; if(p && p.length === 4) surf(flat(p[0], p[1], p[2], p[3], P.y.svc), COL.svc); });
  // runway shoulders (the pads' too) and the taxiways' shoulders under their asphalt
  [[RW/2, RW/2 + SH], [-RW/2 - SH, -RW/2]].forEach(function(l){ var q = []; rectE(q, E0, -PAD, len + PAD, l[0], l[1], P.y.shoulder); surf(q[0], COL.rwyShoulder); });
  function bLine(){ // B only off the apron (on it the apron is B's pavement)
    var pts = lines.B, out = [];
    if(!pts) return out;
    var a = F.f(pts[0][0], pts[0][1]), b = F.f(pts[1][0], pts[1][1]), vA = Math.min(a[1], b[1]), vB = Math.max(a[1], b[1]), u = a[0];
    var cov = apronR.filter(function(r){ return r[0] <= u - TW/2 - TSH && r[1] >= u + TW/2 + TSH; }), lo = Infinity, hi = -Infinity;
    cov.forEach(function(r){ lo = Math.min(lo, r[2]); hi = Math.max(hi, r[3]); });
    if(!(lo < hi)) return [pts];
    if(vA < lo) out.push([F.w(u, vA), F.w(u, lo)]);
    if(vB > hi) out.push([F.w(u, hi), F.w(u, vB)]);
    return out;
  }
  var paved = [];   // [pts] every taxiway centreline that gets pavement
  taxiIds.forEach(function(k){ if(k === "B") paved = paved.concat(bLine()); else paved.push(lines[k]); });
  curveIds.forEach(function(k){ paved.push(curves[k]); });
  paved.forEach(function(pts){ var q = []; ribbon(q, pts, TW + 2*TSH, P.y.shoulder); q.forEach(function(x){ surf(x, COL.taxiShoulder); }); });
  // blast pads beyond along -25; between there and the threshold A1/A6 cross the end: full-width taxiway asphalt
  var PADT = Math.min(PAD, 25);
  ends.forEach(function(E){ var q = []; rectE(q, E, -PAD, -PADT, -RW/2, RW/2, P.y.pad); surf(q[0], COL.pad); });
  paved.forEach(function(pts){ var q = []; ribbon(q, pts, TW, P.y.taxi, null); q.forEach(function(x){ surf(x, COL.taxi); }); });
  ends.forEach(function(E){ var q = []; rectE(q, E, -PADT, 0, -RW/2, RW/2, P.y.taxi); surf(q[0], COL.taxi); });
  // the apron service road (taxiway asphalt) with white edges and a dashed centre
  if(L.serviceRoad && L.serviceRoad.length > 1){
    var sw = num(L.serviceRoadW, 6), sq = [];
    ribbon(sq, L.serviceRoad, sw, P.y.road); sq.forEach(function(x){ surf(x, COL.road); });
    var SE = edges(L.serviceRoad, sw - 0.4);
    ribbon(PW.white, SE.map(function(e){ return e[0]; }), 0.2, yP + 0.01);
    ribbon(PW.white, SE.map(function(e){ return e[1]; }), 0.2, yP + 0.01);
    dashes(PW.white, L.serviceRoad, 0.15, yP + 0.01, 3, 3);
  }
  // the runway (rubber canvas) and the apron (joint-grid canvas): their own materials
  var rq = flat(pE(E0, 0, -RW/2), pE(E0, len, -RW/2), pE(E0, len, RW/2), pE(E0, 0, RW/2), P.y.rwy);
  P.runway = {q: rq, uv: [0, 1, 0, 0, 1, 0, 1, 1]};
  (L.apron || []).forEach(function(p){ if(p.length === 4) P.apron.push({q: flat(p[0], p[1], p[2], p[3], P.y.apron)}); });

  /* ----- landside: access road, the forecourt loop, the curb's sidewalk (all on the terrain) ----- */
  var LS = L.landside || {}, rw = num(LS.roadW, 8);
  [LS.access, LS.forecourt].forEach(function(pts){
    if(!pts || pts.length < 2) return;
    var d = densify(pts, 4), q = []; ribbon(q, d, rw, 0, yLand); q.forEach(function(x){ surf(x, COL.road); });
  });
  if(LS.forecourt && LS.forecourt.length > 2){
    var fc = densify(LS.forecourt, 4), FE = edges(fc, rw - 0.5);
    ribbon(PW.white, FE.map(function(e){ return e[0]; }), 0.15, 0, function(p){ return yLand(p) + 0.02; });
    ribbon(PW.white, FE.map(function(e){ return e[1]; }), 0.15, 0, function(p){ return yLand(p) + 0.02; });
    dashes(PW.white, LS.forecourt, 0.15, 0, 3, 6, function(p){ return yLand(p) + 0.02; });
  }
  if(LS.access && LS.access.length > 1) dashes(PW.white, LS.access, 0.15, 0, 3, 6, function(p){ return yLand(p) + 0.02; });
  var curb = LS.curb || {};
  if(curb.dropoff && LS.forecourt){
    // the curb leg: the sidewalk on its terminal side (toward +u), raised 0.15 m, with a light curb stone
    var c0 = F.f(curb.dropoff[0][0], curb.dropoff[0][1]), fcR = rectF(F, LS.forecourt), uC = c0[0], uW = uC + rw/2;
    var yw = function(p){ return yLand(p) + 0.15; };
    for(var vs = fcR[2]; vs < fcR[3] - 1e-6; vs += 4){
      var v1 = Math.min(fcR[3], vs + 4), a = F.w(uW, vs), b = F.w(uW, v1), cc = F.w(uW + 4, v1), dd = F.w(uW + 4, vs);
      surf(quad(a, b, cc, dd, yw(a), yw(b), yw(cc), yw(dd)), COL.walk);
      surf(quad(a, b, b, a, yw(a), yw(b), yLand(b), yLand(a)), COL.curb, true);
    }
    // bays on the curb lane: drop-off (white), taxi rank and bus bay (yellow)
    [["dropoff", PW.white], ["taxi", PW.yellow], ["bus", PW.yellow]].forEach(function(b){
      var seg = curb[b[0]]; if(!seg) return;
      var s0 = F.f(seg[0][0], seg[0][1]), s1 = F.f(seg[1][0], seg[1][1]), va = Math.min(s0[1], s1[1]), vb = Math.max(s0[1], s1[1]);
      var ua = uC + 0.4, ub = uC + rw/2 - 0.3, yl = function(p){ return yLand(p) + 0.02; };
      [[ua, va, ua, vb], [ub, va, ub, vb], [ua, va, ub, va], [ua, vb, ub, vb]].forEach(function(e){
        var Q = segQ(F.w(e[0], e[1]), F.w(e[2], e[3]), 0.15, 0); Q[1] = yl([Q[0], Q[2]]); Q[4] = yl([Q[3], Q[5]]); Q[7] = yl([Q[6], Q[8]]); Q[10] = yl([Q[9], Q[11]]); b[1].push(Q);
      });
    });
  }

  /* ----- the platform's edge: rock revetment + parapet over water, a retaining wall + fence over land ----- */
  var plats = [], seen = {};
  (L.platform || []).forEach(function(p){ var k = JSON.stringify(p); if(!seen[k] && p.length > 2){ seen[k] = 1; plats.push(p); } });
  var inAny = function(x, z){ return plats.some(function(p){ return inPoly(p, x, z); }); };
  var pieces = {}, conc = L.concourse || null;
  plats.forEach(function(p){
    for(var k = 0; k < p.length; k++){
      var a = p[k], b = p[(k + 1) % p.length], l = Math.hypot(b[0] - a[0], b[1] - a[1]), d = unit(b[0] - a[0], b[1] - a[1]);
      var nrm = [d[1], -d[0]];
      // the outward side, by testing (either winding)
      var mx = (a[0] + b[0])/2, mz = (a[1] + b[1])/2;
      if(inPoly(p, mx + nrm[0]*0.2, mz + nrm[1]*0.2)) nrm = [-nrm[0], -nrm[1]];
      // break the edge where another polygon's corner sits on it (that is where it stops or starts being shared),
      // then into pieces of <= 5 m
      var cuts = [0, l];
      plats.forEach(function(q){ if(q !== p) q.forEach(function(v){ var t = (v[0] - a[0])*d[0] + (v[1] - a[1])*d[1];
        if(t > 0.01 && t < l - 0.01 && Math.abs((v[0] - a[0])*d[1] - (v[1] - a[1])*d[0]) < 0.01) cuts.push(t); }); });
      cuts.sort(function(x, y){ return x - y; });
      var spans = [];
      for(var ci2 = 0; ci2 + 1 < cuts.length; ci2++){ var t0 = cuts[ci2], t1 = cuts[ci2 + 1], m2 = Math.max(1, Math.ceil((t1 - t0)/5));
        for(var sk = 0; sk < m2; sk++) if(t1 - t0 > 0.01) spans.push([t0 + (t1 - t0)*sk/m2, t0 + (t1 - t0)*(sk + 1)/m2]); }
      for(var s = 0; s < spans.length; s++){
        var pa = [a[0] + d[0]*spans[s][0], a[1] + d[1]*spans[s][0]], pb = [a[0] + d[0]*spans[s][1], a[1] + d[1]*spans[s][1]];
        var m = [(pa[0] + pb[0])/2, (pa[1] + pb[1])/2];
        if(inAny(m[0] + nrm[0]*0.25, m[1] + nrm[1]*0.25)) continue;
        var key = Math.round(m[0]*10) + ":" + Math.round(m[1]*10);
        if(pieces[key]) continue;
        var g = gAt(m[0] + nrm[0]*3, m[1] + nrm[1]*3), water = g == null || g < sea + 0.2;
        pieces[key] = {a: pa, b: pb, n: nrm, water: water, g: g, poly: p, conc: !!(conc && distPoly(m[0], m[1], conc.concat([conc[0]])) < 0.3)};
      }
    }
  });
  var corners = {};
  Object.keys(pieces).forEach(function(key){
    var e = pieces[key], a = e.a, b = e.b, n = e.n;
    var ao = [a[0] + n[0]*6, a[1] + n[1]*6], bo = [b[0] + n[0]*6, b[1] + n[1]*6];
    if(e.water){
      P.edges.water++;
      surf(quad(a, b, bo, ao, y0, y0, sea - 1.5, sea - 1.5), COL.rock, true);
      var ai = [a[0] - n[0]*0.4, a[1] - n[1]*0.4], bi = [b[0] - n[0]*0.4, b[1] - n[1]*0.4], yt = y0 + Y.shoulder + 1;
      surf(flat(ai, bi, b, a, yt), COL.parapet);
      surf(quad(a, b, b, a, yt, yt, y0, y0), COL.parapet, true);
      surf(quad(ai, bi, bi, ai, yt, yt, y0, y0), COL.parapet, true);
      [a, b].forEach(function(p){ var ck = Math.round(p[0]*10) + ":" + Math.round(p[1]*10); (corners[ck] = corners[ck] || {p: p, n: []}).n.push(n); });
    } else {
      P.edges.land++;
      var bot = Math.min(e.g != null ? e.g : y0, y0) - 0.5, top = y0 + 0.1, ao5 = [a[0] + n[0]*0.5, a[1] + n[1]*0.5], bo5 = [b[0] + n[0]*0.5, b[1] + n[1]*0.5];
      if(e.g == null || e.g < y0 + 0.05){
        surf(quad(ao5, bo5, bo5, ao5, top, top, bot, bot), COL.wall, true);
        surf(flat(a, b, bo5, ao5, top), COL.wall);
      }
      if(!e.conc){
        // 0.25 m out, on the wall's top; an end that meets another platform polygon (a concave corner) stops short of it
        var fa = [a[0] + n[0]*0.25, a[1] + n[1]*0.25], fb = [b[0] + n[0]*0.25, b[1] + n[1]*0.25], fd = unit(fb[0] - fa[0], fb[1] - fa[1]);
        var touch = function(q){ return plats.some(function(o){ return o !== e.poly && (inPoly(o, q[0], q[1]) || distPoly(q[0], q[1], o.concat([o[0]])) < 0.1); }); };
        if(touch(fa)) fa = [fa[0] + fd[0]*0.3, fa[1] + fd[1]*0.3];
        if(touch(fb)) fb = [fb[0] - fd[0]*0.3, fb[1] - fd[1]*0.3];
        P.fence.push([fa, fb]);
      }
    }
  });
  // convex corners over water: fill the wedge between two revetments
  Object.keys(corners).forEach(function(k){
    var C = corners[k]; if(C.n.length !== 2) return;
    var n1 = C.n[0], n2 = C.n[1]; if(n1[0]*n2[0] + n1[1]*n2[1] > 0.99) return;
    var mid = unit(n1[0] + n2[0], n1[1] + n2[1]), p = C.p;
    var o1 = [p[0] + n1[0]*6, p[1] + n1[1]*6], om = [p[0] + mid[0]*6, p[1] + mid[1]*6], o2 = [p[0] + n2[0]*6, p[1] + n2[1]*6];
    surf(quad(p, o1, om, p, y0, sea - 1.5, sea - 1.5, y0), COL.rock, true);
    surf(quad(p, om, o2, p, y0, sea - 1.5, sea - 1.5, y0), COL.rock, true);
  });
  // fence posts every piece (<= 5 m) on the wall's top
  P.fence.forEach(function(f){ cyl(f[0][0], f[0][1], P.fenceY, P.fenceY + 2.45, 0.05, 0.05, 6, COL.galv); });

  /* ----- runway markings (each end; along = m past its threshold) ----- */
  ends.forEach(function(E){
    for(var i = 0; i < 6; i++) [1, -1].forEach(function(sg){ var cl = sg*(2.625 + 3.5*i); rectE(PW.white, E, 6, 51, cl - 0.875, cl + 0.875, yP); });
    var desig = String(E.id || "").replace(/[^0-9]/g, "");
    digits(PW.white, desig, pE(E, 63, 0), E.dir, [-E.left[0], -E.left[1]], 18, 6, 1.5, 3, yP);
    [1, -1].forEach(function(sg){
      rectE(PW.white, E, 310, 355, sg > 0 ? 11 : -20, sg > 0 ? 20 : -11, yP);
      [[150, 3], [450, 2], [600, 2], [750, 1], [900, 1]].forEach(function(t){
        for(var k = 0; k < t[1]; k++){ var l0 = 11 + k*3.3; rectE(PW.white, E, t[0], t[0] + 22.5, sg > 0 ? l0 : -l0 - 1.8, sg > 0 ? l0 + 1.8 : -l0, yP); }
      });
    });
    // blast pad chevrons (yellow, 45 deg, apex toward the runway), every 15 m beyond along -25, clipped at the pad's end
    for(var ap = -25; ap > -PAD + 1; ap -= 15) [1, -1].forEach(function(sg){
      var reach = Math.min(RW/2 - 0.9, ap + PAD - 0.5);
      if(reach > 1) PW.yellow.push(segQ(pE(E, ap, 0), pE(E, ap - reach, sg*reach), 0.9, yP));
    });
  });
  for(var ca = 90; ca + 36 <= len - 90 + 1e-6; ca += 60) rectE(PW.white, E0, ca, ca + 36, -0.45, 0.45, yP);
  rectE(PW.white, E0, 0, len, RW/2 - 0.9, RW/2, yP); rectE(PW.white, E0, 0, len, -RW/2, -RW/2 + 0.9, yP);

  /* ----- taxi markings ----- */
  // centrelines: every line (off the runway itself; exits only between their two curves) and every curve
  function lineSpan(k){
    var pts = lines[k], l = lenOf(pts), s0 = 0, s1 = l;
    if(exitIds.indexOf(k) >= 0){
      var cr = curves[k + "/RWY"], ca2 = curves[k + "/A"];
      if(cr){ var pe = cr[cr.length - 1]; s0 = Math.hypot(pe[0] - pts[0][0], pe[1] - pts[0][1]); }
      if(ca2){ var ps = ca2[0]; s1 = Math.hypot(ps[0] - pts[0][0], ps[1] - pts[0][1]); }
    } else {
      // clip the runway (and its pads): the lead-on curves carry the line there
      var on = function(s){ var q = along(pts, s).p; return onRunway(q[0], q[1], 0); };
      while(s0 < l && on(s0)) s0 += 0.5;
      while(s1 > s0 && on(s1)) s1 -= 0.5;
    }
    return s1 > s0 ? cut(pts, s0, s1) : null;
  }
  var tlines = {};
  taxiIds.forEach(function(k){ var p = lineSpan(k); if(p){ tlines[k] = p; ribbon(PW.yellow, p, 0.3, yP); } });
  Object.keys(curves).forEach(function(k){ ribbon(PW.yellow, curves[k], 0.3, yP); });
  // double yellow edge lines on the straight sides of A and B, broken at junction mouths and on the apron
  // an edge point is free unless it is on the apron or the runway, or a probe just outside it lands on another
  // taxiway's asphalt (a junction's mouth; the far side of a T stays continuous)
  function freeEdge(k, x, z, px, pz){ return !onApron(x, z) && !onRunway(x, z, SH) && !onOther(px, pz, k, TW/2 + 0.5); }
  function sideRuns(k, lat, step, fn){
    var pts = lines[k]; if(!pts) return;
    var d = unit(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]), n = [-d[1], d[0]], l = lenOf(pts), run = null, pl = (lat > 0 ? 1 : -1)*(TW/2 + 2);
    for(var s = 0; s <= l + 1e-6; s += step){
      var x = pts[0][0] + d[0]*s + n[0]*lat, z = pts[0][1] + d[1]*s + n[1]*lat;
      var ok = freeEdge(k, x, z, pts[0][0] + d[0]*s + n[0]*pl, pts[0][1] + d[1]*s + n[1]*pl);
      if(ok && !run) run = [[x, z], [x, z]]; else if(ok) run[1] = [x, z];
      if((!ok || s + step > l + 1e-6) && run){ if(Math.hypot(run[1][0] - run[0][0], run[1][1] - run[0][1]) > 1) fn(run); run = null; }
    }
  }
  ["A", "B"].forEach(function(k){
    [1, -1].forEach(function(sg){
      [TW/2 - 0.125, TW/2 - 0.625].forEach(function(o){ sideRuns(k, sg*o, 1, function(r){ PW.yellow.push(segQ(r[0], r[1], 0.25, yP)); }); });
    });
  });
  // runway-holding positions: A1/A6 (the ends' hold lines) and every exit where it crosses u = RU - 50
  ends.forEach(function(E, ei){
    if(!E.holdLine || !E.hold) return;
    var hl = E.holdLine, c = [(hl[0][0] + hl[1][0])/2, (hl[0][1] + hl[1][1])/2];
    var id = ["A1", "A6"].filter(function(k){ return lines[k]; }).sort(function(a, b){ return distPoly(c[0], c[1], lines[a]) - distPoly(c[0], c[1], lines[b]); })[0] || "";
    P.holds.push({c: c, d: unit(c[0] - E.hold[0], c[1] - E.hold[1]), end: ei, id: id, w: TW + 2});
  });
  exitIds.forEach(function(k){
    var pts = lines[k], a = F.f(pts[0][0], pts[0][1]), b = F.f(pts[1][0], pts[1][1]), uh = RU - 50;
    if((a[0] - uh)*(b[0] - uh) > 0) return;
    var t = (uh - a[0])/(b[0] - a[0]), c = [pts[0][0] + (pts[1][0] - pts[0][0])*t, pts[0][1] + (pts[1][1] - pts[0][1])*t];
    P.holds.push({c: c, d: unit(pts[0][0] - pts[1][0], pts[0][1] - pts[1][1]), end: null, id: k, w: TW + 2});
  });
  P.holds.forEach(function(h){
    var d = h.d, n = [-d[1], d[0]], hw = h.w/2;
    [0, 0.6, 1.2, 1.8].forEach(function(o, j){
      var a = [h.c[0] + d[0]*o - n[0]*hw, h.c[1] + d[1]*o - n[1]*hw], b = [h.c[0] + d[0]*o + n[0]*hw, h.c[1] + d[1]*o + n[1]*hw];
      if(j < 2) PW.yellow.push(segQ(a, b, 0.3, yP)); else dashes(PW.yellow, [a, b], 0.3, yP, 1, 1);
    });
  });

  /* ----- apron markings: stop bars, stand numbers (yellow on black), stand boxes (red) ----- */
  var Bd = F.B, Td = F.T;
  (L.stands || []).forEach(function(st){
    if(st.stop) PW.yellow.push(segQ(st.stop[0], st.stop[1], 0.6, yP));
    if(st.box && st.box.length === 4){
      var bx = st.box.concat([st.box[0]]);
      for(var i = 0; i < 4; i++){
        var a = bx[i], b = bx[i + 1], d = unit(b[0] - a[0], b[1] - a[1]), cx = (st.box[0][0] + st.box[2][0])/2, cz = (st.box[0][1] + st.box[2][1])/2;
        var nn = [-d[1], d[0]], m = [(a[0] + b[0])/2, (a[1] + b[1])/2], s = ((cx - m[0])*nn[0] + (cz - m[1])*nn[1]) > 0 ? 0.1 : -0.1;
        PW.red.push(segQ([a[0] + nn[0]*s, a[1] + nn[1]*s], [b[0] + nn[0]*s, b[1] + nn[1]*s], 0.2, yP));
      }
      var r = rectF(F, st.box), vS = F.f(st.x, st.z)[1], o = F.w(r[1] - 1.6, vS), up = [-Bd[0], -Bd[1]];
      digits(PW.black, st.id, o, up, Td, 4, 2.4, 0.45, 0.8, y0 + Y.ink, 0.3);
      digits(PW.yellow, st.id, o, up, Td, 4, 2.4, 0.45, 0.8, yP);
    }
  });

  /* ----- lights ----- */
  var LT = P.lights;
  function lamp(p, y, g, x){ var l = {x: p[0], y: y, z: p[1], g: g}; if(x) for(var k in x) l[k] = x[k]; LT.push(l); return l; }
  var yFlush = y0 + Y.rwy + 0.06, yEdge = y0 + Y.rwy + 0.2;
  for(var ea = 0; ea <= len + 1e-6; ea += 50) [1, -1].forEach(function(sg){ lamp(pE(E0, ea, sg*(RW/2 + 1)), yEdge, "edge", {a: ea, side: sg}); });
  var nC = Math.floor(len/15), cOff = (len - nC*15)/2;
  for(var ci = 0; ci <= nC; ci++) if(cOff + ci*15 <= len) lamp(pE(E0, cOff + ci*15, 0.6), yFlush, "centre", {a: cOff + ci*15, i: ci});
  ends.forEach(function(E, ei){
    for(var i = 0; i < 16; i++) lamp(pE(E, -1, -RW/2 + 3*i), yEdge, "thr", {end: ei});
    for(var ta = 30; ta <= 900 + 1e-6; ta += 30) [11.5, 13, 14.5, -11.5, -13, -14.5].forEach(function(l){ lamp(pE(E, ta, l), yFlush, "tdz", {end: ei}); });
    var ap = E.approach || [], rab = [];
    ap.forEach(function(q){
      var dist = Math.hypot(q[0] - E.thr[0], q[1] - E.thr[1]), yl = dist <= PAD + 1e-6 ? yEdge : y0 + 1.25;
      for(var l = -2; l <= 2; l++) lamp([q[0] + E.left[0]*l, q[1] + E.left[1]*l], yl, "appr", {end: ei, d: dist});
      if(Math.abs(dist - num(E.crossbar, 300)) < 1) for(var cb = -14; cb <= 14; cb += 2) lamp([q[0] + E.left[0]*cb, q[1] + E.left[1]*cb], yl, "appr", {end: ei, d: dist, cross: 1});
      if(dist <= 180 + 1e-6) [6, 7, 8, -6, -7, -8].forEach(function(l){ lamp([q[0] + E.left[0]*l, q[1] + E.left[1]*l], yl, "apprRed", {end: ei, d: dist}); });
      rab.push([q[0], yl + 0.35, q[1]]);
    });
    P.rabbit.push(rab.reverse());
    (E.papi || []).forEach(function(q, i){ P.papi.push({x: q[0], y: y0 + 0.5, z: q[1], end: ei, i: i}); });
  });
  // taxiway edge lights (blue, every 30 m) on the free straight edges of A, B, A1 and A6
  ["A", "B", "A1", "A6"].forEach(function(k){
    var pts = lines[k]; if(!pts) return;
    var d = unit(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]), n = [-d[1], d[0]], l = lenOf(pts);
    for(var s = 15; s <= l - 5; s += 30) [1, -1].forEach(function(sg){
      var x = pts[0][0] + d[0]*s + n[0]*sg*(TW/2 + 0.75), z = pts[0][1] + d[1]*s + n[1]*sg*(TW/2 + 0.75);
      var px = pts[0][0] + d[0]*s + n[0]*sg*(TW/2 + 2), pz = pts[0][1] + d[1]*s + n[1]*sg*(TW/2 + 2);
      if(!onRunway(x, z, SH + 2) && freeEdge(k, x, z, px, pz) && !onOther(x, z, k, TW/2 + 0.5)) lamp([x, z], y0 + Y.taxi + 0.2, "tedge");
    });
  });
  // taxiway centreline lights (green; green/yellow inside the runway strip, u > RU - 50) on exits and curves
  var tcl = exitIds.filter(function(k){ return tlines[k]; }).map(function(k){ return tlines[k]; }).concat(curveIds.map(function(k){ return curves[k]; }));
  tcl.forEach(function(pts){
    var l = lenOf(pts), j = 0;
    for(var s = 7.5; s <= l; s += 15, j++){ var q = along(pts, s).p, strip = F.f(q[0], q[1])[0] > RU - 50; lamp(q, y0 + Y.taxi + 0.06, "tcl", {alt: !!(strip && (j % 2))}); }
  });
  // stop bars: 12 lamps across each holding position, 0.3 m on its taxiway side
  P.holds.forEach(function(h){
    var d = h.d, n = [-d[1], d[0]], hw = h.w/2 - 0.5;
    for(var i = 0; i < 12; i++){ var o = -hw + 2*hw*i/11; lamp([h.c[0] - d[0]*0.45 + n[0]*o, h.c[1] - d[1]*0.45 + n[1]*o], y0 + Y.taxi + 0.12, "stop", {end: h.end}); }
  });

  /* ----- apron floodlight masts: between the stands at the head of stand, and 2 at the commuter stands' head ----- */
  var concR = conc ? rectF(F, conc) : null, contact = (L.stands || []).filter(function(s){ return s.kind === "contact"; }),
      comm = (L.stands || []).filter(function(s){ return s.kind === "commuter"; });
  var mastAt = [];
  if(concR && contact.length){
    var vs = contact.map(function(s){ return F.f(s.x, s.z)[1]; }).sort(function(a, b){ return a - b; }), uM = concR[1] + 1.3, gapV = vs.length > 1 ? vs[1] - vs[0] : 44;
    mastAt.push([uM, vs[0] - gapV/2]);
    for(var mi = 0; mi + 1 < vs.length; mi++) mastAt.push([uM, (vs[mi] + vs[mi + 1])/2]);
    mastAt.push([uM, vs[vs.length - 1] + gapV/2]);
  }
  if(comm.length){
    var cb2 = comm.map(function(s){ return rectF(F, s.box); }), u0c = Math.min.apply(null, cb2.map(function(r){ return r[0]; })) - 0.5;
    var vHi = Math.max.apply(null, cb2.map(function(r){ return r[3]; })), vLo = Math.min.apply(null, cb2.map(function(r){ return r[2]; }));
    mastAt.push([u0c, vHi], [u0c, vLo - 4]);
  }
  mastAt.forEach(function(m){
    var p = F.w(m[0], m[1]);
    P.masts.push({x: p[0], z: p[1], h: MASTS_H, r: 0.35});
    cyl(p[0], p[1], y0, y0 + MASTS_H, 0.35, 0.22, 10, COL.steel);
    box(p[0], y0 + 0.3, p[1], 1.1, 0.6, 1.1, 0, COL.svc);
    var hp = F.w(m[0] + 0.5, m[1]);
    box(hp[0], y0 + MASTS_H - 0.1, hp[1], 1.0, 0.3, 6.2, yawOf(Td), COL.frame);
    [-2.25, -0.75, 0.75, 2.25].forEach(function(o){ var q = F.w(m[0] + 0.7, m[1] + o); lamp(q, y0 + MASTS_H - 0.55, "flood"); });
    lamp(p, y0 + MASTS_H + 0.35, "obst");
    var pc = F.w(m[0] + 22, m[1]); P.pools.push({x: pc[0], z: pc[1], r: 28});
  });

  /* ----- fixtures: approach-light piers, localizers, glideslopes, windsocks ----- */
  function pileDown(x, z, top, r){ var g = gAt(x, z), bot = Math.max(g != null ? g : sea - 8, sea - 12); if(bot < top - 0.2) cyl(x, z, bot, top, r, r, 8, COL.pile); }
  ends.forEach(function(E){
    var ap = E.approach || [], last = ap.length ? ap[ap.length - 1] : null, yaw = yawOf(E.dir);
    if(!last) return;
    var dmax = Math.hypot(last[0] - E.thr[0], last[1] - E.thr[1]);
    // the catwalk, pad end -> the last bar, 3 m wide, in 30 m spans on piles
    for(var a = -PAD; a > -dmax - 1e-6; a -= 30){
      var b = Math.max(-dmax, a - 30), c = pE(E, (a + b)/2, 0);
      box(c[0], y0 - 0.2, c[1], 3, 0.4, a - b, yaw, COL.deck);
      [1.3, -1.3].forEach(function(l){ var r = pE(E, (a + b)/2, l); box(r[0], y0 + 0.95, r[1], 0.08, 0.08, a - b, yaw, COL.galv); });
    }
    ap.forEach(function(q){
      var dist = Math.hypot(q[0] - E.thr[0], q[1] - E.thr[1]); if(dist <= PAD + 1e-6) return;
      var cross = Math.abs(dist - num(E.crossbar, 300)) < 1, red = dist <= 180 + 1e-6, half = cross ? 14.5 : red ? 8.5 : 2.5;
      pileDown(q[0], q[1], y0 - 0.4, 0.35);
      box(q[0], y0 + 0.5, q[1], 0.2, 1.0, 0.2, yaw, COL.galv);
      box(q[0], y0 + 1.07, q[1], half*2, 0.14, 0.14, yaw, COL.galv);
      if(half > 3) [half - 1.5, -half + 1.5].forEach(function(l){ var r = [q[0] + E.left[0]*l, q[1] + E.left[1]*l];
        pileDown(r[0], r[1], y0 + 1.0, 0.2); });
    });
    lamp(last, y0 + 1.8, "obst");
    // the localizer for this end sits past the far end, on the other end's pier: 34 x 10 m head, 16 posts, a shed
    if(E.localizer){
      var lc = E.localizer, d = E.dir, n = E.left, at = function(al, la){ return [lc[0] + d[0]*al + n[0]*la, lc[1] + d[1]*al + n[1]*la]; };
      box(lc[0], y0 - 0.25, lc[1], 34, 0.5, 10, yaw, COL.deck);
      [[-4, -16], [-4, 16], [4, -16], [4, 16], [-4, 0], [4, 0]].forEach(function(o){ var q = at(o[0], o[1]); pileDown(q[0], q[1], y0 - 0.5, 0.35); });
      for(var i = 0; i < 16; i++){ var q = at(-2, -15 + 2*i); box(q[0], y0 + 1, q[1], 0.14, 2, 0.14, yaw, COL.galv); box(q[0], y0 + 2.05, q[1], 0.35, 0.18, 0.7, yaw, COL.antenna); }
      var bm = at(-2, 0); box(bm[0], y0 + 1.2, bm[1], 30.5, 0.12, 0.12, yaw, COL.galv);
      var sh = at(2.5, 10); box(sh[0], y0 + 1.3, sh[1], 4, 2.6, 3, yaw, COL.shed); box(sh[0], y0 + 2.7, sh[1], 4.3, 0.2, 3.3, yaw, COL.roof);
      lamp(at(-2, -15.5), y0 + 2.4, "obst"); lamp(at(-2, 15.5), y0 + 2.4, "obst");
    }
    if(E.glideslope){
      var gs = E.glideslope, toR = unit(R.c[0] + E.dir[0]*((gs[0] - R.c[0])*E.dir[0] + (gs[1] - R.c[1])*E.dir[1]) - gs[0],
                                         R.c[1] + E.dir[1]*((gs[0] - R.c[0])*E.dir[0] + (gs[1] - R.c[1])*E.dir[1]) - gs[1]);
      cyl(gs[0], gs[1], y0, y0 + 12, 0.25, 0.16, 8, COL.steel);
      [4, 7.5, 11].forEach(function(h){ box(gs[0] + toR[0]*0.45, y0 + h, gs[1] + toR[1]*0.45, 0.9, 0.5, 1.3, yawOf(toR), COL.antenna); });
      box(gs[0] - toR[0]*3.5, y0 + 1.25, gs[1] - toR[1]*3.5, 3, 2.5, 2.5, yawOf(toR), COL.shed);
      lamp(gs, y0 + 12.3, "obst");
    }
    if(E.windsock){
      var ws = E.windsock;
      cyl(ws[0], ws[1], y0, y0 + SOCK_POLE, 0.09, 0.07, 8, COL.white);
      cyl(ws[0], ws[1], y0, y0 + 0.4, 0.6, 0.6, 10, COL.svc);
      P.socks.push({x: ws[0], y: y0 + SOCK_POLE - 0.2, z: ws[1]});
      lamp(ws, y0 + SOCK_POLE + 0.15, "sock");
    }
  });

  /* ----- signs: mandatory "18-36" both sides of every hold (3 m off the shoulder), location sign beside it ----- */
  var ids = ends.map(function(E){ return String(E.id || "").replace(/[^0-9]/g, "").slice(0, 2); });
  function cell(text, kind){ for(var i = 0; i < P.cells.length; i++) if(P.cells[i].text === text && P.cells[i].kind === kind) return i;
    P.cells.push({text: text, kind: kind}); return P.cells.length - 1; }
  function sign(p, faceDir, cFront, cBack){
    var yaw = yawOf(faceDir);
    P.signs.push({x: p[0], y: y0 + 0.6, z: p[1], yaw: yaw, front: cFront, back: cBack, w: 2.5, h: 1.2});
    box(p[0], y0 + 1.2, p[1], 2.5, 1.2, 0.3, yaw, COL.signBody);
    [-0.9, 0.9].forEach(function(o){ var q = [p[0] + Math.cos(yaw)*o, p[1] - Math.sin(yaw)*o]; box(q[0], y0 + 0.3, q[1], 0.12, 0.6, 0.12, yaw, COL.galv); });
  }
  if(ids.length === 2) P.holds.forEach(function(h){
    var d = h.d, n = [-d[1], d[0]], face = [-d[0], -d[1]];
    // turning left from heading d runs along the end whose landing direction has a positive dot with d's left
    var leftV = [d[1], -d[0]], li = (ends[0].dir[0]*leftV[0] + ends[0].dir[1]*leftV[1]) > 0 ? 0 : 1;
    var txt = ids[li] + "-" + ids[1 - li], back = ids[1 - li] + "-" + ids[li], loc = h.id;
    [1, -1].forEach(function(sg){
      var off = TW/2 + TSH + 3 + 1.25, q = [h.c[0] - d[0]*1.5 + n[0]*sg*off, h.c[1] - d[1]*1.5 + n[1]*sg*off];
      sign(q, face, cell(txt, "mand"), cell(back, "mand"));
      if(sg > 0 && /^A[0-9]?$/.test(loc)){ var q2 = [q[0] + n[0]*sg*2.8, q[1] + n[1]*sg*2.8]; sign(q2, face, cell(loc, "loc"), cell(loc, "loc")); }
    });
  });
  // "A" / "B" location signs where A1 and A6 meet them (on the grass, facing the link's traffic)
  ["A1", "A6"].forEach(function(k){
    var pts = lines[k]; if(!pts || !lines.A || !lines.B) return;
    var d = unit(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]), vOut = F.f(pts[0][0], pts[0][1])[1] > 0 ? 1 : -1;
    [["A", lines.A[0]], ["B", lines.B[0]]].forEach(function(t){
      var u = F.f(t[1][0], t[1][1])[0], v = F.f(pts[0][0], pts[0][1])[1], q = F.w(u + (t[0] === "A" ? TW/2 + TSH + 3 : -(TW/2 + TSH + 2.2)), v - vOut*(TW/2 + TSH + 8));
      if(!onApron(q[0], q[1])) sign(q, d, cell(t[0], "loc"), cell(t[0], "loc"));
    });
  });
  return P;
}

/* ---------- light colour rules (pure) ---------- */
function lampColor(l, endIdx, clear, blinkOn){
  endIdx = endIdx === 1 ? 1 : 0; l = l || {};
  var len = num(l.len, 1600);
  switch(l.g){
    case "edge": { var a = endIdx === 0 ? l.a : len - l.a; return len - a < 600 - 1e-6 ? LIGHT.yellow : LIGHT.white; }
    case "centre": { var a2 = endIdx === 0 ? l.a : len - l.a, rem = len - a2;
      return rem < 300 ? LIGHT.red : rem < 900 ? ((l.i % 2) ? LIGHT.red : LIGHT.white) : LIGHT.white; }
    case "thr": return l.end === endIdx ? LIGHT.green : LIGHT.red;
    case "tdz": case "appr": return l.end === endIdx ? LIGHT.white : null;
    case "apprRed": return l.end === endIdx ? LIGHT.red : null;
    case "tedge": return LIGHT.blue;
    case "tcl": return l.alt ? LIGHT.yellow : LIGHT.green;
    case "stop": return l.end != null && clear && clear[l.end] ? null : LIGHT.red;
    case "flood": return LIGHT.sodium;
    case "obst": return blinkOn ? LIGHT.red : null;
    case "sock": return LIGHT.white;
  }
  return LIGHT.white;
}
function papiWhite(i, elevDeg){ return elevDeg > PAPI_DEG[Math.max(0, Math.min(3, i | 0))]; }

/* ---------- create (THREE) ---------- */
// a growing vertex buffer: positions, normals, colours, uvs, indices
function buf(){
  return {p: [], n: [], c: [], uv: [], ix: [], v: 0,
    vert: function(x, y, z, nx, ny, nz, col, u, w){ this.p.push(x, y, z); this.n.push(nx, ny, nz); if(col) this.c.push(col[0], col[1], col[2]); this.uv.push(u || 0, w || 0); return this.v++; },
    tri: function(a, b, c){ this.ix.push(a, b, c); }};
}
function quadInto(B, q, col, two, uvFn){
  var ax = q[3] - q[0], ay = q[4] - q[1], az = q[5] - q[2], bx = q[6] - q[0], by = q[7] - q[1], bz = q[8] - q[2];
  var nx = ay*bz - az*by, ny = az*bx - ax*bz, nz = ax*by - ay*bx, l = Math.hypot(nx, ny, nz) || 1;
  nx /= l; ny /= l; nz /= l;
  var flip = !two && ny < 0; if(flip){ nx = -nx; ny = -ny; nz = -nz; }
  var ids = [];
  for(var k = 0; k < 4; k++){ var uv = uvFn ? uvFn(q[k*3], q[k*3 + 2], k) : [0, 0]; ids.push(B.vert(q[k*3], q[k*3 + 1], q[k*3 + 2], nx, ny, nz, col, uv[0], uv[1])); }
  if(flip){ B.tri(ids[0], ids[2], ids[1]); B.tri(ids[0], ids[3], ids[2]); }
  else { B.tri(ids[0], ids[1], ids[2]); B.tri(ids[0], ids[2], ids[3]); }
  if(two){
    var back = [];
    for(var j = 0; j < 4; j++){ var uv2 = uvFn ? uvFn(q[j*3], q[j*3 + 2], j) : [0, 0]; back.push(B.vert(q[j*3], q[j*3 + 1], q[j*3 + 2], -nx, -ny, -nz, col, uv2[0], uv2[1])); }
    B.tri(back[0], back[2], back[1]); B.tri(back[0], back[3], back[2]);
  }
}
function boxInto(B, b, col){
  var c = Math.cos(b.yaw || 0), s = Math.sin(b.yaw || 0), hw = b.w/2, hh = b.h/2, hd = b.d/2;
  // local x = right (cos yaw, -sin yaw), local z = forward (sin yaw, cos yaw)
  function P(x, y, z){ return [b.x + x*c + z*s, b.y + y, b.z - x*s + z*c]; }
  var F = [[[-hw, -hh, hd], [hw, -hh, hd], [hw, hh, hd], [-hw, hh, hd]], [[hw, -hh, -hd], [-hw, -hh, -hd], [-hw, hh, -hd], [hw, hh, -hd]],
           [[hw, -hh, hd], [hw, -hh, -hd], [hw, hh, -hd], [hw, hh, hd]], [[-hw, -hh, -hd], [-hw, -hh, hd], [-hw, hh, hd], [-hw, hh, -hd]],
           [[-hw, hh, hd], [hw, hh, hd], [hw, hh, -hd], [-hw, hh, -hd]], [[-hw, -hh, -hd], [hw, -hh, -hd], [hw, -hh, hd], [-hw, -hh, hd]]];
  F.forEach(function(f){
    var q = [], p;
    for(var k = 0; k < 4; k++){ p = P(f[k][0], f[k][1], f[k][2]); q.push(p[0], p[1], p[2]); }
    var ax = q[3] - q[0], ay = q[4] - q[1], az = q[5] - q[2], bx = q[6] - q[0], by = q[7] - q[1], bz = q[8] - q[2];
    var nx = ay*bz - az*by, ny = az*bx - ax*bz, nz = ax*by - ay*bx, l = Math.hypot(nx, ny, nz) || 1, ids = [];
    for(var j = 0; j < 4; j++) ids.push(B.vert(q[j*3], q[j*3 + 1], q[j*3 + 2], nx/l, ny/l, nz/l, col));
    B.tri(ids[0], ids[1], ids[2]); B.tri(ids[0], ids[2], ids[3]);
  });
}
function cylInto(B, cy, col){
  var n = Math.max(3, cy.seg | 0), top = [], bot = [];
  for(var i = 0; i <= n; i++){
    var a = i/n*Math.PI*2, ca = Math.cos(a), sa = Math.sin(a);
    bot.push(B.vert(cy.x + ca*cy.r0, cy.y0, cy.z + sa*cy.r0, ca, 0, sa, col));
    top.push(B.vert(cy.x + ca*cy.r1, cy.y1, cy.z + sa*cy.r1, ca, 0, sa, col));
  }
  for(var k = 0; k < n; k++){ B.tri(bot[k], top[k + 1], bot[k + 1]); B.tri(bot[k], top[k], top[k + 1]); }
  var cTop = B.vert(cy.x, cy.y1, cy.z, 0, 1, 0, col), ring = [];
  for(var j = 0; j <= n; j++){ var b = j/n*Math.PI*2; ring.push(B.vert(cy.x + Math.cos(b)*cy.r1, cy.y1, cy.z + Math.sin(b)*cy.r1, 0, 1, 0, col)); }
  for(var m = 0; m < n; m++) B.tri(cTop, ring[m + 1], ring[m]);
}
function geoOf(THREE, B, wantColor, wantUv){
  var g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(B.p, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(B.n, 3));
  if(wantColor) g.setAttribute("color", new THREE.Float32BufferAttribute(B.c, 3));
  if(wantUv) g.setAttribute("uv", new THREE.Float32BufferAttribute(B.uv, 2));
  g.setIndex(B.v > 65535 ? new THREE.Uint32BufferAttribute(B.ix, 1) : new THREE.Uint16BufferAttribute(B.ix, 1));
  g.computeBoundingBox(); g.computeBoundingSphere();
  return g;
}

function create(c, L, o){
  o = o || {};
  var THREE = c.THREE, P = plan(L, {ground: o.ground});
  if(!P) return null;
  var g = new THREE.Group(); g.name = "airport-ground";
  var geos = [], mats = [], texs = [], canv = [], tmp = new THREE.Color();
  var R = rng(hashStr(String(L.world || "") + "|airport3d")), canvasBytes = 0;
  function lin(hex){ tmp.setHex(hex); return [tmp.r, tmp.g, tmp.b]; }
  function tex(w, h, draw){ var T = c.canvasTex(w, h, draw); canvasBytes += w*h*4; texs.push(T.t); canv.push(T); return T.t; }
  function std(hex, opts){ var m = c.mat(hex, opts || {}); mats.push(m); return m; }
  function mesh(geo, m, name, shadow){ var x = new THREE.Mesh(geo, m); x.name = name; x.receiveShadow = !!shadow; x.castShadow = false; geos.push(geo); g.add(x); return x; }

  /* ----- canvases: ground noise (multiplies the vertex colours), runway rubber, apron joints, sign atlas, fence ----- */
  var noise = tex(128, 128, function(cx, w, h){
    var id = cx.createImageData ? cx.createImageData(w, h) : null;
    if(id && id.data){ for(var i = 0; i < w*h; i++){ var v = 228 + Math.floor(R()*27); id.data[i*4] = v; id.data[i*4 + 1] = v; id.data[i*4 + 2] = v; id.data[i*4 + 3] = 255; } cx.putImageData(id, 0, 0); }
    else { cx.fillStyle = "#f0f0f0"; cx.fillRect(0, 0, w, h); }
  });
  noise.wrapS = noise.wrapT = THREE.RepeatWrapping;
  var lenR = num(L.runway.len, 1600);
  var rubber = tex(128, 2048, function(cx, w, h){
    cx.fillStyle = "#2b2d30"; cx.fillRect(0, 0, w, h);
    var mpp = lenR/h, i, y, a;
    for(i = 0; i < 2600; i++){ var gx = Math.floor(R()*w), gy = Math.floor(R()*h), gv = R() < 0.35 ? "rgba(255,255,255," : "rgba(0,0,0,";
      cx.fillStyle = gv + (0.02 + R()*0.03).toFixed(3) + ")"; cx.fillRect(gx, gy, 1, 1 + Math.floor(R()*3)); }
    // rubber: the touchdown zones, 300..900 m in from each end, heaviest on the main-gear tracks (about +-4.5 m)
    [0, 1].forEach(function(e){
      for(i = 0; i < 900; i++){
        var al = 300 + R()*600, k = 1 - Math.abs(al - 550)/400, lat = (R() < 0.5 ? -1 : 1)*(1.5 + R()*R()*9) + (R() - 0.5)*2;
        y = (e ? lenR - al : al)/mpp; var x = (lat/45 + 0.5)*w;
        a = Math.max(0.05, Math.min(0.5, k*0.4*R()));
        cx.fillStyle = "rgba(24,25,28," + a.toFixed(3) + ")"; cx.fillRect(x - 1.5, e ? y - 30 - R()*40 : y, 2 + R()*3, 30 + R()*60);
      }
    });
    // concrete for the first 6 m at each end
    cx.fillStyle = "#8a8a85"; var cpx = Math.max(2, Math.round(6/mpp)); cx.fillRect(0, 0, w, cpx); cx.fillRect(0, h - cpx, w, cpx);
  });
  rubber.anisotropy = 8;
  var apronT = tex(256, 256, function(cx, w, h){
    cx.fillStyle = "#a8a69e"; cx.fillRect(0, 0, w, h);
    for(var i = 0; i < 4; i++) for(var j = 0; j < 4; j++){ var t = Math.floor(R()*9) - 4; cx.fillStyle = "rgba(" + (t > 0 ? "255,255,255," : "0,0,0,") + (Math.abs(t)/100).toFixed(3) + ")"; cx.fillRect(i*64, j*64, 64, 64); }
    for(var k = 0; k < 1400; k++){ cx.fillStyle = "rgba(60,58,52," + (0.02 + R()*0.04).toFixed(3) + ")"; cx.fillRect(Math.floor(R()*w), Math.floor(R()*h), 1 + Math.floor(R()*3), 1 + Math.floor(R()*3)); }
    for(var s = 0; s < 5; s++){ cx.fillStyle = "rgba(40,38,34,0.05)"; cx.beginPath(); cx.arc(R()*w, R()*h, 4 + R()*14, 0, 7); cx.fill(); }
    cx.fillStyle = "rgba(80,78,72,0.32)";
    for(var q = 0; q < 4; q++){ cx.fillRect(q*64, 0, 1, h); cx.fillRect(0, q*64, w, 1); }
  });
  apronT.wrapS = apronT.wrapT = THREE.RepeatWrapping; apronT.anisotropy = 8;
  var atlas = tex(512, 256, function(cx){
    P.cells.forEach(function(cl, i){
      var x = (i % 4)*128, y = Math.floor(i/4)*64, mand = cl.kind === "mand";
      cx.fillStyle = mand ? "#c8201a" : "#111214"; cx.fillRect(x, y, 128, 64);
      cx.strokeStyle = mand ? "#f4f4f0" : "#f2c230"; cx.lineWidth = 3; cx.strokeRect(x + 4, y + 4, 120, 56);
      cx.fillStyle = mand ? "#f4f4f0" : "#f2c230"; cx.font = "700 36px system-ui, sans-serif"; cx.textAlign = "center"; cx.textBaseline = "middle";
      cx.fillText(String(cl.text).slice(0, 6), x + 64, y + 34);
    });
  });
  var fenceT = tex(64, 64, function(cx, w, h){
    cx.clearRect(0, 0, w, h); cx.strokeStyle = "rgba(170,176,180,1)"; cx.lineWidth = 2;
    for(var i = -64; i < 128; i += 16){ cx.beginPath(); cx.moveTo(i, 0); cx.lineTo(i + 64, 64); cx.stroke(); cx.beginPath(); cx.moveTo(i + 64, 0); cx.lineTo(i, 64); cx.stroke(); }
    cx.fillStyle = "rgba(150,156,160,1)"; cx.fillRect(0, 0, w, 3); cx.fillRect(0, h - 3, w, 3);
  });
  fenceT.wrapS = THREE.RepeatWrapping;

  /* ----- ground: one vertex-coloured mesh + runway + apron ----- */
  var GB = buf(), colCache = {};
  P.surf.forEach(function(s){ var col = colCache[s.c] || (colCache[s.c] = lin(s.c)); quadInto(GB, s.q, col, s.two, function(x, z){ return [x/24, z/24]; }); });
  var groundM = std(0xffffff, {vertexColors: true, map: noise, roughness: 0.95, metalness: 0});
  var groundMesh = mesh(geoOf(THREE, GB, true, true), groundM, "airport-ground-vc", true);
  var RB = buf(); quadInto(RB, P.runway.q, null, false, function(x, z, k){ return [P.runway.uv[k*2], P.runway.uv[k*2 + 1]]; });
  var rwyM = std(0xffffff, {map: rubber, roughness: 0.9, metalness: 0, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1});
  var rwyMesh = mesh(geoOf(THREE, RB, false, true), rwyM, "airport-runway", true);
  var AB = buf(); P.apron.forEach(function(a){ quadInto(AB, a.q, null, false, function(x, z){ return [x/20, z/20]; }); });
  var apronM = std(0xffffff, {map: apronT, roughness: 0.85, metalness: 0});
  var apronMesh = mesh(geoOf(THREE, AB, false, true), apronM, "airport-apron", true);

  /* ----- paint: one mesh per colour ----- */
  var paint = {};
  ["white", "yellow", "red", "black"].forEach(function(k){
    var B = buf(); P.paint[k].forEach(function(q){ quadInto(B, q, null, false); });
    var m = std(COL[k], {roughness: 0.6, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4});
    paint[k] = mesh(geoOf(THREE, B, false, false), m, "airport-paint-" + k, true);
  });

  /* ----- fixtures (merged, vertex colours), signs, fence ----- */
  var XB = buf(), xc = {};
  function xcol(h){ return xc[h] || (xc[h] = lin(h)); }
  P.fixtures.boxes.forEach(function(b){ boxInto(XB, b, xcol(b.c)); });
  P.fixtures.cyls.forEach(function(cy){ cylInto(XB, cy, xcol(cy.c)); });
  var fixM = std(0xffffff, {vertexColors: true, roughness: 0.75, metalness: 0.1});
  var fixMesh = mesh(geoOf(THREE, XB, true, false), fixM, "airport-fixtures", false);
  var SB = buf();
  P.signs.forEach(function(s){
    var cs = Math.cos(s.yaw), sn = Math.sin(s.yaw), hw = s.w/2, yb = s.y + 0.02, yt = s.y + 0.02 + s.h - 0.04;
    [[s.front, 0.16], [s.back, -0.16]].forEach(function(f){
      var ci = f[0], u0 = (ci % 4)/4, v0 = 1 - Math.floor(ci/4)/4, u1 = u0 + 0.25, v1 = v0 - 0.25, side = f[1] > 0 ? 1 : -1;
      var fx = s.x + sn*f[1], fz = s.z + cs*f[1], rx = cs*side, rz = -sn*side;   // the face's right, seen from in front of it
      var q = [fx - rx*hw, yb, fz - rz*hw, fx + rx*hw, yb, fz + rz*hw, fx + rx*hw, yt, fz + rz*hw, fx - rx*hw, yt, fz - rz*hw];
      var uv = [[u0, v1], [u1, v1], [u1, v0], [u0, v0]], ids = [];
      for(var k = 0; k < 4; k++) ids.push(SB.vert(q[k*3], q[k*3 + 1], q[k*3 + 2], sn*side, 0, cs*side, null, uv[k][0], uv[k][1]));
      SB.tri(ids[0], ids[1], ids[2]); SB.tri(ids[0], ids[2], ids[3]);
    });
  });
  var signM = std(0xffffff, {map: atlas, emissive: new THREE.Color(0xffffff), emissiveMap: atlas, emissiveIntensity: 0.05, roughness: 0.6});
  var signMesh = mesh(geoOf(THREE, SB, false, true), signM, "airport-signs", false);
  var FB = buf(), fu = 0;
  P.fence.forEach(function(f){
    var a = f[0], b = f[1], l = Math.hypot(b[0] - a[0], b[1] - a[1]), y = P.fenceY, h = 2.4, d = unit(b[0] - a[0], b[1] - a[1]), ids = [];
    [[a, y, fu], [b, y, fu + l/2.4], [b, y + h, fu + l/2.4], [a, y + h, fu]].forEach(function(v, k){ ids.push(FB.vert(v[0][0], v[1], v[0][1], -d[1], 0, d[0], null, v[2], k < 2 ? 0 : 1)); });
    FB.tri(ids[0], ids[1], ids[2]); FB.tri(ids[0], ids[2], ids[3]); fu += l/2.4;
  });
  var fenceM = std(0xc8ccd0, {map: fenceT, alphaTest: 0.4, side: THREE.DoubleSide, roughness: 0.6, metalness: 0.3});
  var fenceMesh = mesh(geoOf(THREE, FB, false, true), fenceM, "airport-fence", false);

  /* ----- windsocks: one instanced cone, five bands ----- */
  var KB = buf(), nb = 5, segs = 10, r0 = 0.45, r1 = 0.22;
  for(var bi = 0; bi < nb; bi++){
    var z0 = bi/nb*SOCK_LEN, z1 = (bi + 1)/nb*SOCK_LEN, ra = r0 + (r1 - r0)*bi/nb, rb = r0 + (r1 - r0)*(bi + 1)/nb, col = lin(bi % 2 ? COL.sockWhite : COL.orange), ring0 = [], ring1 = [];
    for(var si = 0; si <= segs; si++){ var an = si/segs*Math.PI*2, ca = Math.cos(an), sa = Math.sin(an);
      ring0.push(KB.vert(ca*ra, sa*ra, z0, ca, sa, 0, col)); ring1.push(KB.vert(ca*rb, sa*rb, z1, ca, sa, 0, col)); }
    for(var sj = 0; sj < segs; sj++){ KB.tri(ring0[sj], ring1[sj + 1], ring1[sj]); KB.tri(ring0[sj], ring0[sj + 1], ring1[sj + 1]); }
  }
  var sockGeo = geoOf(THREE, KB, true, false); geos.push(sockGeo);
  var sockM = std(0xffffff, {vertexColors: true, side: THREE.DoubleSide, roughness: 0.8, emissive: new THREE.Color(0x000000)});
  var socks = new THREE.InstancedMesh(sockGeo, sockM, Math.max(1, P.socks.length)); socks.name = "airport-socks"; socks.count = P.socks.length; g.add(socks);
  var sockS = P.socks.map(function(){ return {yaw: 0, droop: 0.6}; }), wind = {yaw: num(((L.runway.ends || [])[0] || {}).yaw, 0) + Math.PI, speed: 6};
  var M4 = new THREE.Matrix4(), Q4 = new THREE.Quaternion(), V3 = new THREE.Vector3(), S3 = new THREE.Vector3(1, 1, 1), EU = new THREE.Euler(0, 0, 0, "YXZ");
  function droopOf(sp){ return 0.09 + 0.87*Math.max(0, Math.min(1, (12 - sp)/9)); }
  function poseSocks(t){
    for(var i = 0; i < P.socks.length; i++){
      var s = P.socks[i], st = sockS[i], fl = Math.sin(t*3.1 + i)*0.035*Math.min(1, wind.speed/8);
      EU.set(st.droop + fl, st.yaw + fl*0.6, 0, "YXZ"); Q4.setFromEuler(EU); V3.set(s.x, s.y, s.z); S3.set(1, 1, 1);
      M4.compose(V3, Q4, S3); socks.setMatrixAt(i, M4);
    }
    socks.instanceMatrix.needsUpdate = true;
  }
  sockS.forEach(function(st){ st.yaw = wind.yaw; st.droop = droopOf(wind.speed); });
  poseSocks(0); socks.computeBoundingSphere();

  /* ----- lights: lamps (one InstancedMesh), glow (Points), PAPI (InstancedMesh), rabbit (Points), pools ----- */
  var LT = P.lights, n = LT.length, lenRw = lenR;
  LT.forEach(function(l){ l.len = lenRw; });
  var lampGeo = new THREE.BoxGeometry(0.45, 0.3, 0.45); geos.push(lampGeo);
  var lampM = new THREE.MeshBasicMaterial({color: 0xffffff, toneMapped: false}); mats.push(lampM);
  var lamps = new THREE.InstancedMesh(lampGeo, lampM, Math.max(1, n)); lamps.name = "airport-lamps"; lamps.count = n; g.add(lamps);
  var SC = {flood: [2.2, 0.8, 1.1], obst: [0.9, 0.9, 0.9], centre: [0.8, 0.35, 0.8], tdz: [0.8, 0.35, 0.8], tcl: [0.7, 0.35, 0.7], stop: [0.7, 0.6, 0.7], sock: [0.6, 0.6, 0.6]};
  var glowPos = new Float32Array((n + P.papi.length)*3), glowCol = new Float32Array((n + P.papi.length)*3), obstIx = [];
  LT.forEach(function(l, i){
    var sc = SC[l.g] || [1, 1, 1]; V3.set(l.x, l.y, l.z); Q4.identity(); S3.set(sc[0], sc[1], sc[2]); M4.compose(V3, Q4, S3); lamps.setMatrixAt(i, M4);
    glowPos[i*3] = l.x; glowPos[i*3 + 1] = l.y + 0.25; glowPos[i*3 + 2] = l.z;
    if(l.g === "obst") obstIx.push(i);
  });
  P.papi.forEach(function(p, k){ var j = n + k; glowPos[j*3] = p.x; glowPos[j*3 + 1] = p.y + 0.2; glowPos[j*3 + 2] = p.z; });
  lamps.instanceMatrix.needsUpdate = true;
  lamps.setColorAt(0, tmp.setRGB(1, 1, 1));   // makes instanceColor
  lamps.computeBoundingSphere();
  var gg = new THREE.BufferGeometry(); gg.setAttribute("position", new THREE.BufferAttribute(glowPos, 3)); gg.setAttribute("color", new THREE.BufferAttribute(glowCol, 3));
  gg.computeBoundingSphere(); geos.push(gg);
  var glowM = new THREE.PointsMaterial({size: 3.5, sizeAttenuation: false, vertexColors: true, transparent: true, depthWrite: false, fog: false,
    toneMapped: false, blending: THREE.AdditiveBlending}); mats.push(glowM);
  var glow = new THREE.Points(gg, glowM); glow.name = "airport-glow"; glow.frustumCulled = false; g.add(glow);
  var papiGeo = new THREE.BoxGeometry(1.8, 0.7, 1.0); geos.push(papiGeo);
  var papiM = new THREE.MeshBasicMaterial({color: 0xffffff, toneMapped: false}); mats.push(papiM);
  var papi = new THREE.InstancedMesh(papiGeo, papiM, Math.max(1, P.papi.length)); papi.name = "airport-papi"; papi.count = P.papi.length; g.add(papi);
  var papiState = P.papi.map(function(){ return -1; });
  P.papi.forEach(function(p, k){
    var E = L.runway.ends[p.end] || {}, yaw = num(E.yaw, 0);
    EU.set(0, yaw, 0, "YXZ"); Q4.setFromEuler(EU); V3.set(p.x, p.y, p.z); S3.set(1, 1, 1); M4.compose(V3, Q4, S3); papi.setMatrixAt(k, M4);
    papi.setColorAt(k, tmp.setRGB(1, 0.07, 0.04));
  });
  papi.instanceMatrix.needsUpdate = true; papi.computeBoundingSphere();
  var rg = new THREE.BufferGeometry(), rabPos = new Float32Array(3); rg.setAttribute("position", new THREE.BufferAttribute(rabPos, 3)); geos.push(rg);
  var rabM = new THREE.PointsMaterial({color: 0xffffff, size: 11, sizeAttenuation: false, transparent: true, depthWrite: false, fog: false, toneMapped: false,
    blending: THREE.AdditiveBlending}); mats.push(rabM);
  var rabbit = new THREE.Points(rg, rabM); rabbit.name = "airport-rabbit"; rabbit.frustumCulled = false; g.add(rabbit);
  // sodium light pools: an additive fan, bright in the middle, nothing at the rim
  var PB = buf(), sod = [LIGHT.sodium[0]*0.32, LIGHT.sodium[1]*0.32, LIGHT.sodium[2]*0.32], ctr = PB.vert(0, 0, 0, 0, 1, 0, sod), rim = [];
  for(var pi = 0; pi <= 24; pi++){ var pa = pi/24*Math.PI*2; rim.push(PB.vert(Math.cos(pa), 0, Math.sin(pa), 0, 1, 0, [0, 0, 0])); }
  for(var pj = 0; pj < 24; pj++) PB.tri(ctr, rim[pj + 1], rim[pj]);
  var poolGeo = geoOf(THREE, PB, true, false); geos.push(poolGeo);
  var poolM = new THREE.MeshBasicMaterial({vertexColors: true, transparent: true, depthWrite: false, toneMapped: false, blending: THREE.AdditiveBlending,
    polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -8}); mats.push(poolM);
  var pools = new THREE.InstancedMesh(poolGeo, poolM, Math.max(1, P.pools.length)); pools.name = "airport-pools"; pools.count = P.pools.length; g.add(pools);
  P.pools.forEach(function(p, k){ V3.set(p.x, num(L.y, 0) + Y.paint + 0.06, p.z); Q4.identity(); S3.set(p.r, 1, p.r); M4.compose(V3, Q4, S3); pools.setMatrixAt(k, M4); });
  pools.instanceMatrix.needsUpdate = true; pools.computeBoundingSphere();

  /* ----- state ----- */
  var st = {night: !!o.night, detail: 2, endIdx: o.endIdx === 1 ? 1 : 0, clear: [false, false], blink: false, papiDirty: true};
  function setLamp(i, rgb){
    var on = rgb || LAMP_OFF;
    lamps.instanceColor.setXYZ(i, on[0], on[1], on[2]);
    var gc = rgb || [0, 0, 0]; glowCol[i*3] = gc[0]; glowCol[i*3 + 1] = gc[1]; glowCol[i*3 + 2] = gc[2];
  }
  function recolor(){
    for(var i = 0; i < n; i++) setLamp(i, lampColor(LT[i], st.endIdx, st.clear, st.blink));
    lamps.instanceColor.needsUpdate = true; gg.attributes.color.needsUpdate = true;
  }
  function vis(){
    var d = st.detail, nt = st.night;
    groundMesh.visible = rwyMesh.visible = apronMesh.visible = true;
    paint.white.visible = true; paint.yellow.visible = d >= 1; paint.red.visible = paint.black.visible = d >= 2;
    lamps.visible = d >= 2 || (d === 1 && nt); glow.visible = nt; rabbit.visible = nt && d >= 1;
    papi.visible = d >= 2; pools.visible = nt && d >= 2;
    fixMesh.visible = signMesh.visible = fenceMesh.visible = socks.visible = d >= 2;
  }
  var A = {g: g, plan: P};
  A.setNight = function(v){
    st.night = !!v && v !== 0;
    lampM.color.setScalar(st.night ? 1 : DAY_LAMP);
    signM.emissiveIntensity = st.night ? 0.85 : 0.05;
    sockM.emissive.setHex(st.night ? 0x2a2018 : 0x000000);
    vis();
  };
  A.setRunway = function(i){ i = i === 1 ? 1 : 0; if(i !== st.endIdx){ st.endIdx = i; recolor(); } };
  A.setHold = function(i, clear){ i = i === 1 ? 1 : 0; clear = !!clear; if(st.clear[i] !== clear){ st.clear[i] = clear; recolor(); } };
  A.setWind = function(w){ w = w || {}; wind.yaw = num(w.yaw, wind.yaw); wind.speed = Math.max(0, num(w.speed, wind.speed)); };
  A.setDetail = function(level){ level = level | 0; st.detail = Math.max(0, Math.min(2, level)); vis(); };
  var camV = new THREE.Vector3();
  A.update = function(dt, t, camera){
    dt = Math.max(0, num(dt, 0)); t = num(t, 0);
    var b = (t % 1 + 1) % 1 < 0.5;
    if(b !== st.blink){ st.blink = b; for(var i = 0; i < obstIx.length; i++) setLamp(obstIx[i], lampColor(LT[obstIx[i]], st.endIdx, st.clear, b));
      lamps.instanceColor.needsUpdate = true; gg.attributes.color.needsUpdate = true; }
    if(rabbit.visible){
      var seq = P.rabbit[st.endIdx] || [], k = seq.length ? Math.floor(((t*2) % 1 + 1) % 1*seq.length) : -1;
      if(k >= 0){ var q = seq[Math.min(seq.length - 1, k)]; rabPos[0] = q[0]; rabPos[1] = q[1]; rabPos[2] = q[2]; rg.attributes.position.needsUpdate = true; }
    }
    if(camera && camera.position && P.papi.length){
      if(camera.getWorldPosition) camera.getWorldPosition(camV); else camV.copy(camera.position);
      var ch = false;
      for(var j = 0; j < P.papi.length; j++){
        var p = P.papi[j], el = Math.atan2(camV.y - p.y, Math.hypot(camV.x - p.x, camV.z - p.z))*180/Math.PI, w = papiWhite(p.i, el) ? 1 : 0;
        if(w !== papiState[j]){ papiState[j] = w; ch = true; var rgb = w ? LIGHT.white : LIGHT.red;
          papi.setColorAt(j, tmp.setRGB(rgb[0], rgb[1], rgb[2])); var gi = n + j; glowCol[gi*3] = rgb[0]; glowCol[gi*3 + 1] = rgb[1]; glowCol[gi*3 + 2] = rgb[2]; }
      }
      if(ch){ papi.instanceColor.needsUpdate = true; gg.attributes.color.needsUpdate = true; }
    }
    if(socks.visible && P.socks.length){
      var kk = 1 - Math.exp(-1.2*dt), dr = droopOf(wind.speed);
      for(var si2 = 0; si2 < sockS.length; si2++){
        var ss = sockS[si2], dy = Math.atan2(Math.sin(wind.yaw - ss.yaw), Math.cos(wind.yaw - ss.yaw));
        ss.yaw += dy*kk; ss.droop += (dr - ss.droop)*kk;
      }
      poseSocks(t);
    }
  };
  A.papiState = function(){ return papiState.slice(); };
  A.stats = function(){
    var tris = 0;
    g.traverse(function(x){ if(!x.geometry) return; var gi = x.geometry, cnt = gi.index ? gi.index.count/3 : (gi.attributes.position ? gi.attributes.position.count/3 : 0);
      tris += x.isPoints ? 0 : cnt*(x.isInstancedMesh ? x.count : 1); });
    return {lamps: n, glow: n + P.papi.length, papi: P.papi.length, tris: Math.round(tris), canvasBytes: canvasBytes, detail: st.detail, night: st.night,
            endIdx: st.endIdx, signs: P.signs.length, fence: P.fence.length, masts: P.masts.length};
  };
  A.lampColors = function(){ var out = []; for(var i = 0; i < n; i++) out.push([lamps.instanceColor.getX(i), lamps.instanceColor.getY(i), lamps.instanceColor.getZ(i)]); return out; };
  A.dispose = function(){
    if(g.parent) g.parent.remove(g);
    geos.forEach(function(x){ x.dispose(); }); mats.forEach(function(x){ x.dispose(); }); texs.forEach(function(x){ if(x && x.dispose) x.dispose(); });
    canv.forEach(function(T){ if(T && T.c){ T.c.width = 0; T.c.height = 0; } });
    [lamps, papi, pools, socks].forEach(function(x){ if(x.dispose) x.dispose(); });
    geos = []; mats = []; texs = []; canv = [];
  };
  recolor(); A.setNight(st.night); A.setDetail(o.detail != null ? o.detail : 2);
  return A;
}

HQV.hqAirport3d = {plan: plan, create: create, lampColor: lampColor, papiWhite: papiWhite, PAPI_DEG: PAPI_DEG, COL: COL, LIGHT: LIGHT, Y: Y};
})();
