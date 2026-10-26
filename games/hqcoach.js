/* Claude HQ: buses and trams you ride (HQV.hqCoach, HQ 3.15, docs/plans/transport-revamp.md 3.2).
 *
 * Pure top half (no THREE, no DOM; tests/test_hqcoach.py runs it under node):
 *   atlasLayout(entries, {w, cellW, cellH}) -> {w, h, cells: [{key, short, to, text, x, y, w, h, u0, v0, u1, v1}], white}
 *       the shared destination-display atlas: one cell per "line + terminus" text, a white cell for plain colours
 *   occupied(kind, vehicle, ms, seed) -> {seats: [i...], standing: [j...]}   HQV.hqCommute.occupied when loaded
 *       (checked), else a seeded fallback from the vehicle's load; the same for everyone
 *   figures(kind, occ) -> [{x, y, z, yaw, pose: "sit"|"stand", seat}]  vehicle-local (traffic SEATS / STANDS)
 *   toWorld(kind, v, p) -> {x, y, z, yaw}       a vehicle-local point on a vehicle row (a tram's two sections)
 *   doorOpen(doors, calm) / kneel(kind, doors, calm)   the door and kneel poses (Calm: pose only, no slide)
 *   lineOf(v) / nearOn(line, p, dy)   a row's centre line, front to back, and its point nearest p (dy m up): where a
 *       vehicle's sound comes from (a 27 m tram sounds from the part of it beside you)
 * view(c, sim, opts) -> V (the View contract, plan 5.4) over the traffic sim's buses and trams:
 *   far additions (every bus and tram): lit destination displays from the atlas, route colour bands and warm
 *     windows at night in one merged mesh; seated passengers in the windows as one InstancedMesh
 *   near detail (the vehicle you board or ride, plus up to 2 others within 40 m): the 12 m bus (3 double plug
 *     doors, 6 cm kneel, 31 seats, poles, straps, a wheelchair bay with a fold-down seat, STOP buttons, an LED
 *     ceiling, a dot-matrix next-stop display, a driver) and the 27 m tram (two sections and the articulation with
 *     its bellows, a cab at each end, 4 double doors a side, 48 seats 2+1 in facing bays, ceiling grab rails, an
 *     information screen per section, a driver in the leading cab); three draw calls each (body, lit + glass,
 *     door leaves), the people (seated, standing) in two instanced meshes for all of them
 *   V.update(ms, dt, cam), V.focus(vehicleId|null), V.requestStop(vehicleId), V.hide() -> {id: true} for
 *   traffic.view's update (the near ones are drawn here), V.drawCalls(), V.triangles(), V.tools.shotCam(name)
 *   ("tram-interior", "bus-interior", "tram-stop", "tram-junction"), V.dispose().
 * opts = {calm(), reduced(), night(), sfx(name, o), traffic() -> the frame's traffic.at() list (poses with the
 * obstacle lag), W (for stop names), parent (a THREE.Object3D to add to)}. Sounds through opts.sfx, every bus and
 * tram's where it happens (o.pos, o.kind: games/engine.js fades and pans it by its kind and keeps the nearest few):
 * "door" + "hiss" (doors opening, kind door), "air-brake" (a bus at its stop, bus), "tram-bell" (a tram's doors shut,
 * bell, at its leading cab); "stop-bell" (S, aboard) is yours and centred. Rides are free: nothing here takes a fare.
 */
(function(){
"use strict";
var root = typeof window !== "undefined" ? window : self;
var HQV = root.HQV = root.HQV || {};

var NEAR_R = 40, NEAR_N = 3, FAR_R = 600, PAX_R = 220, PAX_CAP = 900, ATLAS_W = 1024, CELL_W = 256, CELL_H = 32, MAX_CHARS = 22;
var KNEEL = 0.06, DOOR_SLIDE = 0.62, DOOR_OUT = 0.08;
var BODY = {bus: {len: 12, wid: 2.55, h: 3.0}, tram: {len: 13, wid: 2.65, h: 3.3}};

function clamp(v, a, b){ return v < a ? a : v > b ? b : v; }
function num(v, d){ return typeof v === "number" && isFinite(v) ? v : d; }
function smooth(t){ t = clamp(t, 0, 1); return t*t*(3 - 2*t); }
function hash32(str){
  str = String(str == null ? "" : str);
  var h = 0x811c9dc5;
  for(var i = 0; i < str.length; i++){ h ^= str.charCodeAt(i) & 0xff; h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
function h01(seed, a, b){
  var h = (Math.imul(seed | 0, 0x27d4eb2d) + Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b); h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35); h ^= h >>> 16;
  return (h >>> 0)/4294967296;
}
function T(){ return HQV.traffic || {}; }
function seatsOf(kind){ var S = T().SEATS; return S && S[kind] ? S[kind] : []; }
function standsOf(kind){ var S = T().STANDS; return S && S[kind] ? S[kind] : []; }
// [3.22.3] the side traffic keeps to (traffic.js SIDE, -1 the left): the bus is drawn for the right (doors on the
// right, the driver on the left) and mirrored by it, so its doors are on the kerb side
function sideOf(){ var S = T().SIDE; return S === 1 || S === -1 ? S : -1; }
function floorOf(kind){ var F = T().FLOOR; return F && F[kind] != null ? F[kind] : 0.36; }

/* ---------- the destination atlas ---------- */
function fit(text){ text = String(text == null ? "" : text).replace(/\s+/g, " ").trim(); return text.length > MAX_CHARS ? text.slice(0, MAX_CHARS - 1) + "." : text; }
function atlasLayout(entries, o){
  o = o || {};
  var W = num(o.w, ATLAS_W), cw = num(o.cellW, CELL_W), ch = num(o.cellH, CELL_H), cols = Math.max(1, Math.floor(W/cw)), seen = {}, list = [];
  (entries || []).forEach(function(e){
    var short = String(e && e.short != null ? e.short : ""), to = String(e && e.to != null ? e.to : ""), key = short + "|" + to;
    if(seen[key]) return;
    seen[key] = 1; list.push({key: key, short: short, to: to, text: fit(short + "  " + to)});
  });
  var rows = Math.ceil((list.length + 1)/cols), H = 32;
  while(H < rows*ch && H < 2048) H *= 2;
  var cap = Math.floor(H/ch)*cols - 1;
  function rect(k){ var x = (k % cols)*cw, y = Math.floor(k/cols)*ch; return {x: x, y: y, w: cw, h: ch, u0: x/W, u1: (x + cw)/W, v0: 1 - (y + ch)/H, v1: 1 - y/H}; }
  var cells = list.slice(0, cap).map(function(e, i){ var r = rect(i + 1); for(var k in e) r[k] = e[k]; return r; });
  var white = rect(0); white.key = "white";
  // sample the middle of the white cell (avoids filtering across its border)
  white.uc = (white.u0 + white.u1)/2; white.vc = (white.v0 + white.v1)/2;
  return {w: W, h: H, cols: cols, cellW: cw, cellH: ch, cells: cells, white: white};
}

/* ---------- passengers ---------- */
function occupied(kind, v, ms, seed){
  kind = kind === "tram" ? "tram" : "bus";
  var N = seatsOf(kind).length, M = standsOf(kind).length, H = HQV.hqCommute, out = null;
  if(H && typeof H.occupied === "function"){
    try { out = H.occupied(kind, v.id, v.trip != null ? v.trip : 0, N, M, ms, seed); } catch(e){ out = null; }
    if(out && Array.isArray(out.seats) && Array.isArray(out.standing)){
      var s = {}, t = {};
      out = {seats: out.seats.filter(function(i){ i = i | 0; if(i < 0 || i >= N || s[i]) return false; s[i] = 1; return true; }).map(function(i){ return i | 0; }),
             standing: out.standing.filter(function(j){ j = j | 0; if(j < 0 || j >= M || t[j]) return false; t[j] = 1; return true; }).map(function(j){ return j | 0; })};
      return out;
    }
  }
  // the fallback: the load fills seats in a seeded order; above 1 they stand (1.15 = every spot)
  var load = clamp(num(v.load, 0.3), 0, 1.15), nS = Math.min(N, Math.round(Math.min(1, load)*N)), nT = load > 1 ? Math.min(M, Math.round((load - 1)/0.15*M)) : 0;
  var key = hash32(v.id), trip = num(v.trip, 0) | 0;
  function pick(n, total, salt){
    var idx = [];
    for(var i = 0; i < total; i++) idx.push([h01((seed | 0) ^ salt, key + trip*31, i), i]);
    idx.sort(function(a, b){ return a[0] - b[0] || a[1] - b[1]; });
    return idx.slice(0, n).map(function(p){ return p[1]; }).sort(function(a, b){ return a - b; });
  }
  return {seats: pick(nS, N, 0x51), standing: pick(nT, M, 0x7a)};
}
function figures(kind, occ){
  var S = seatsOf(kind), St = standsOf(kind), out = [];
  ((occ && occ.seats) || []).forEach(function(i){ var p = S[i]; if(p) out.push({x: p.x, y: 0, z: p.z, yaw: p.yaw, pose: "sit", seat: i}); });
  ((occ && occ.standing) || []).forEach(function(j){ var p = St[j]; if(p) out.push({x: p.x, y: 0, z: p.z, yaw: p.yaw, pose: "stand", seat: S.length + j}); });
  return out;
}
// a vehicle-local point (y above the floor) in world space on a vehicle row {x, y, z, yaw, parts?}
function toWorld(kind, v, p){
  var x = p.x, z = p.z, base = v, sec = T().SPEC && T().SPEC.tram ? T().SPEC.tram.sec : 13;
  if(kind === "tram" && v.parts && v.parts.length === 2){ var d = z >= 0 ? sec/2 + 0.5 : -sec/2 - 0.5; base = z >= 0 ? v.parts[0] : v.parts[1]; z -= d; }
  var c = Math.cos(base.yaw), s = Math.sin(base.yaw);
  return {x: base.x + x*c + z*s, y: base.y + floorOf(kind) + num(p.y, 0), z: base.z - x*s + z*c, yaw: base.yaw + num(p.yaw, 0)};
}
function doorOpen(doors, calm){ doors = clamp(num(doors, 0), 0, 1); return calm ? (doors > 0.5 ? 1 : 0) : smooth(doors); }
function kneel(kind, doors, calm){ return kind !== "bus" ? 0 : KNEEL*(calm ? (num(doors, 0) > 0 ? 1 : 0) : smooth(num(doors, 0)*2)); }
// a row's centre line, front to back: a bus's two ends, a tram's front end, its sections' middles and its rear end
function lineOf(v){
  v = v || {};
  var P = v.kind === "tram" && v.parts && v.parts.length === 2 ? v.parts : [v], h = (BODY[v.kind] || BODY.bus).len/2, a = P[0], b = P[P.length - 1];
  function end(q, k){ var yw = num(q.yaw, 0); return {x: num(q.x, 0) + k*Math.sin(yw)*h, y: num(q.y, 0), z: num(q.z, 0) + k*Math.cos(yw)*h}; }
  var out = [end(a, 1)];
  if(P.length > 1) out.push(end(a, 0), end(b, 0));
  out.push(end(b, -1));
  return out;
}
// the point of a centre line nearest p ({x, z}), dy m up
function nearOn(line, p, dy){
  var px = num(p && p.x, 0), pz = num(p && p.z, 0), bd = Infinity, best = line && line[0] ? {x: line[0].x, y: line[0].y, z: line[0].z} : {x: px, y: 0, z: pz};
  for(var i = 0; line && i + 1 < line.length; i++){
    var a = line[i], b = line[i + 1], ex = b.x - a.x, ez = b.z - a.z, l2 = ex*ex + ez*ez;
    var t = l2 > 1e-9 ? clamp(((px - a.x)*ex + (pz - a.z)*ez)/l2, 0, 1) : 0, x = a.x + ex*t, z = a.z + ez*t, d = (px - x)*(px - x) + (pz - z)*(pz - z);
    if(d < bd){ bd = d; best = {x: x, y: a.y + (b.y - a.y)*t, z: z}; }
  }
  best.y += num(dy, 0);
  return best;
}

/* ---------- geometry builders (plain arrays; THREE only wraps them) ---------- */
// (mx = -1 mirrors x: each quad is turned over so it still faces out, and its uv rect still reads the right way round)
function Builder(rgba, mx){ this.pos = []; this.col = []; this.uv = []; this.rgba = !!rgba; this.mx = mx === -1 ? -1 : 1; }
Builder.prototype.tri = function(a, b, c, col, uv){
  this.pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
  for(var i = 0; i < 3; i++){ this.col.push(col[0], col[1], col[2]); if(this.rgba) this.col.push(col[3] != null ? col[3] : 1); }
  if(uv) this.uv.push(uv[0], uv[1], uv[2], uv[3], uv[4], uv[5]); else this.uv.push(0, 0, 0, 0, 0, 0);
};
// a quad a-b-c-d (counter-clockwise from its front), uv rect [u0, v0, u1, v1]
Builder.prototype.quad = function(a, b, c, d, col, r){
  var u = r || [0, 0, 0, 0];
  if(this.mx < 0){ var m = function(p){ return [-p[0], p[1], p[2]]; }, a0 = a; a = m(b); b = m(a0); var c0 = c; c = m(d); d = m(c0); }
  this.tri(a, b, c, col, [u[0], u[1], u[2], u[1], u[2], u[3]]);
  this.tri(a, c, d, col, [u[0], u[1], u[2], u[3], u[0], u[3]]);
};
Builder.prototype.box = function(x, y, z, w, h, d, col, yaw){
  var c = Math.cos(yaw || 0), s = Math.sin(yaw || 0), hw = w/2, hd = d/2;
  function p(u, v, k){ return [x + u*c + k*s, y + v, z - u*s + k*c]; }
  var P = [p(-hw, 0, -hd), p(hw, 0, -hd), p(hw, 0, hd), p(-hw, 0, hd), p(-hw, h, -hd), p(hw, h, -hd), p(hw, h, hd), p(-hw, h, hd)];
  var F = [[4, 7, 6, 5], [0, 1, 2, 3], [0, 4, 5, 1], [1, 5, 6, 2], [2, 6, 7, 3], [3, 7, 4, 0]];
  var self = this;
  F.forEach(function(f){ self.quad(P[f[0]], P[f[1]], P[f[2]], P[f[3]], col); });
};
// an upright n-sided prism (a pole) from y0 to y1
Builder.prototype.pole = function(x, y0, y1, z, r, col, n){
  n = n || 6;
  for(var i = 0; i < n; i++){
    var a = i/n*2*Math.PI, b = (i + 1)/n*2*Math.PI;
    var p0 = [x + Math.cos(a)*r, y0, z + Math.sin(a)*r], p1 = [x + Math.cos(b)*r, y0, z + Math.sin(b)*r];
    this.quad(p0, [p0[0], y1, p0[2]], [p1[0], y1, p1[2]], p1, col);
  }
};
// a horizontal rail along z from z0 to z1 at (x, y)
Builder.prototype.rail = function(x, y, z0, z1, r, col){ this.box(x, y - r, (z0 + z1)/2, 2*r, 2*r, Math.abs(z1 - z0), col); };
// a vertical rectangle facing +x (side = 1) or -x at lateral x, from z0..z1, y0..y1 (uv rect r)
// (wound and mapped to read the right way round from the side it faces)
Builder.prototype.side = function(x, y0, y1, z0, z1, side, col, r){
  if(side > 0) this.quad([x, y0, z1], [x, y0, z0], [x, y1, z0], [x, y1, z1], col, r);
  else this.quad([x, y0, z0], [x, y0, z1], [x, y1, z1], [x, y1, z0], col, r);
};
// a vertical rectangle facing +z (side = 1) or -z at z, from x0..x1
Builder.prototype.end = function(z, y0, y1, x0, x1, side, col, r){
  if(side > 0) this.quad([x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z], col, r);
  else this.quad([x1, y0, z], [x0, y0, z], [x0, y1, z], [x1, y1, z], col, r);
};

var C = {floor: [0.52, 0.53, 0.55], floor2: [0.44, 0.45, 0.47], paint: [0.93, 0.93, 0.9], skirt: [0.22, 0.24, 0.27], roof: [0.85, 0.86, 0.86],
         inner: [0.86, 0.85, 0.82], seat: [0.2, 0.33, 0.55], seatPri: [0.62, 0.22, 0.3], frame: [0.3, 0.31, 0.34], pole: [0.95, 0.78, 0.12],
         strap: [0.15, 0.15, 0.16], stop: [0.85, 0.12, 0.12], bay: [0.2, 0.45, 0.8], dash: [0.12, 0.13, 0.15], bellows: [0.12, 0.12, 0.13],
         wheel: [0.1, 0.1, 0.11], rail: [0.72, 0.74, 0.77], cab: [0.16, 0.17, 0.19], door: [0.55, 0.6, 0.66]};
var GLASS = [0.55, 0.7, 0.8, 0.2], LED = [1, 0.98, 0.92, 1], AMBER = [1, 0.62, 0.12, 1], WARM = [1, 0.82, 0.55, 1];

// The bus, vehicle-local (+x left, +z forward, y from the road), floor at FLOOR; opaque body and fittings
function busBody(lineCol){
  var B = new Builder(false, sideOf()), F = floorOf("bus"), L = 12, hw = 1.275, top = 3.0, doors = T().DOORS ? T().DOORS.bus : [5.0, 0.3, -2.75], dw = 0.6;
  B.box(0, F - 0.04, 0, 2.5, 0.04, 11.9, C.floor);                               // grey speckle floor
  for(var k = -5; k <= 5; k += 2) B.box(0, F + 0.001, k, 2.3, 0.002, 0.9, C.floor2);
  B.box(0, top - 0.06, 0, 2.55, 0.06, 12, C.roof);                              // roof
  B.box(0, top - 0.1, 0, 2.3, 0.04, 11.6, C.inner);                             // ceiling liner
  // lower body both sides (the right side gapped at the doors), a colour band, the ends
  [1, -1].forEach(function(side){
    var x = side*hw, gaps = side < 0 ? doors : [];
    var cuts = [-6].concat(gaps.reduce(function(a, z){ return a.concat([z - dw, z + dw]); }, []).sort(function(a, b){ return a - b; })).concat([6]);
    for(var i = 0; i + 1 < cuts.length; i += 2){
      var z0 = cuts[i], z1 = cuts[i+1];
      if(z1 - z0 < 0.05) continue;
      B.box(x - side*0.03, 0.3, (z0 + z1)/2, 0.06, 0.75, z1 - z0, C.paint);
      B.box(x - side*0.025, 0.55, (z0 + z1)/2, 0.07, 0.18, z1 - z0, lineCol);
      // window pillars every 1.2 m and the cant rail above the glass
      for(var z = z0 + 0.03; z < z1; z += 1.2) B.box(x - side*0.03, 1.05, z, 0.06, top - 1.15, 0.08, C.paint);
      B.box(x - side*0.03, 2.55, (z0 + z1)/2, 0.06, top - 2.6, z1 - z0, C.paint);
    }
  });
  B.box(0, 0.3, -5.97, 2.55, top - 0.35, 0.06, C.paint);                         // rear wall
  B.box(0, 0.3, 5.97, 2.55, 0.85, 0.06, C.paint);                                // front below the windscreen
  B.box(0, 2.55, 5.97, 2.55, 0.4, 0.06, C.paint);
  [[-1.1, 3.6], [1.1, 3.6], [-1.1, -3.8], [1.1, -3.8]].forEach(function(w){ B.box(w[0], 0, w[1], 0.32, 1.0, 1.0, C.wheel); });
  B.box(1.1, F, 3.6, 0.5, 0.45, 1.3, C.frame); B.box(-1.1, F, 3.6, 0.5, 0.45, 1.3, C.frame);     // wheel arches
  // seats from SEATS (priority seats in red): pan, back, frame leg
  // ([3.22.3] SEATS are already mirrored for the side traffic keeps to: drawn as laid out for the right, B mirrors them back)
  seatsOf("bus").forEach(function(s){
    var col = s.priority ? C.seatPri : C.seat, x = s.x*B.mx;
    B.box(x, F + s.y - 0.08, s.z, 0.44, 0.08, 0.44, col);
    B.box(x, F + s.y, s.z - 0.2, 0.44, 0.5, 0.06, col);
    B.box(x, F, s.z, 0.06, s.y - 0.08, 0.06, C.frame);
  });
  // the wheelchair bay: a fold-down seat against the wall, a blue floor mark, a back pad
  B.box(1.15, F + 0.42, 0.25, 0.08, 0.06, 0.44, C.seat); B.box(0.6, F + 0.002, 0.25, 0.9, 0.003, 1.3, C.bay);
  B.box(1.2, F + 0.5, -0.4, 0.05, 0.5, 0.8, C.frame);
  // yellow grab poles floor to ceiling by the doors and along the aisle, with STOP buttons; straps on the rails
  [[-0.95, 4.35], [-0.95, 0.95], [-0.95, -0.35], [-0.95, -2.1], [-0.95, -3.4], [0.15, 2.3], [0.15, -1.8], [0.15, -3.6], [0.6, 1.1], [0.6, -0.6]].forEach(function(p){
    B.pole(p[0], F, top - 0.1, p[1], 0.02, C.pole, 6);
    B.box(p[0], F + 1.2, p[1], 0.07, 0.09, 0.07, C.stop);
  });
  [0.45, -0.45].forEach(function(x){
    B.rail(x, top - 0.25, -5.2, 4.6, 0.016, C.pole);
    for(var z = -4.8; z < 4.6; z += 0.6){ B.box(x, top - 0.6, z, 0.02, 0.34, 0.02, C.strap); B.box(x, top - 0.68, z, 0.12, 0.08, 0.025, C.strap); }
  });
  // the driver's cab: seat, dashboard, wheel, a screen behind
  B.box(0.62, F + 0.1, 5.05, 0.5, 0.35, 0.5, C.cab); B.box(0.62, F + 0.45, 4.85, 0.5, 0.6, 0.08, C.cab);
  B.box(0.6, F + 0.6, 5.7, 1.2, 0.35, 0.35, C.dash); B.box(0.62, F + 1.0, 5.45, 0.42, 0.42, 0.04, C.dash);
  B.box(0.62, F + 0.2, 4.6, 0.9, 1.6, 0.04, C.frame);
  return B;
}
// glass, LED strips, door-edge lights, the displays: rgba vertex colours and uvs into the per-vehicle canvas
function busLit(R){
  var B = new Builder(true, sideOf()), F = floorOf("bus"), hw = 1.275, top = 3.0, doors = T().DOORS ? T().DOORS.bus : [5.0, 0.3, -2.75], dw = 0.6, idx = {};
  [1, -1].forEach(function(side){ B.side(side*(hw + 0.005), 1.05, 2.55, -5.95, 5.95, side, GLASS, R.white); });
  B.end(5.98, 1.15, 2.55, -1.2, 1.2, 1, GLASS, R.white);                          // windscreen
  B.end(-5.98, 1.3, 2.4, -1.0, 1.0, -1, GLASS, R.white);
  [0.7, -0.7].forEach(function(x){ B.quad([x - 0.06, top - 0.11, -5.6], [x + 0.06, top - 0.11, -5.6], [x + 0.06, top - 0.11, 5.4], [x - 0.06, top - 0.11, 5.4], LED, R.white); });
  // door-edge lights: two thin strips per door (inside, the right side); their colours change in update()
  idx.door = [B.col.length/4];
  doors.forEach(function(z){ [z - dw - 0.02, z + dw + 0.02].forEach(function(zz){ B.side(-hw + 0.07, F + 0.1, 2.4, zz - 0.02, zz + 0.02, 1, AMBER, R.white); }); });
  idx.door.push(B.col.length/4);
  // the next-stop display (dot matrix) over the aisle facing back, the STOP sign beside it
  B.end(4.4, 2.5, 2.82, -0.7, 0.7, -1, [1, 1, 1, 1], R.matrix);
  idx.stop = [B.col.length/4];
  B.end(4.38, 2.25, 2.45, 0.75, 1.15, -1, [1, 1, 1, 0.25], R.stop);
  B.end(-0.2, 2.6, 2.82, -0.35, 0.35, -1, [1, 1, 1, 0.25], R.stop);
  idx.stop.push(B.col.length/4);
  // the outside destination display over the windscreen and on the door side
  B.end(6.02, 2.58, 2.86, -0.85, 0.85, 1, [1, 1, 1, 1], R.matrix);
  B.side(-hw - 0.01, 2.6, 2.85, 3.0, 4.2, -1, [1, 1, 1, 1], R.matrix);
  B.idx = idx;
  return B;
}
// door leaves: [{x, z, side (+1 left), dir (+1 opens toward +z)}] vehicle-local ([3.22.3] on the kerb side: -SIDE)
function busLeaves(){ var D = T().DOORS ? T().DOORS.bus : [5.0, 0.3, -2.75], out = [], sd = -sideOf(); D.forEach(function(z){ out.push({x: 1.24*sd, z: z - 0.3, side: sd, dir: -1}, {x: 1.24*sd, z: z + 0.3, side: sd, dir: 1}); }); return out; }

// One tram section, section-local: the cab at +z (z 5..6.5), the articulation at -z (-6.5..-7); the rear section
// is this one turned round, so seats are SEATS.tram[0..23] shifted by -7
function tramBody(lineCol){
  var B = new Builder(false), F = floorOf("tram"), hw = 1.325, top = 3.3, half = 6.5, dz = 7, D = T().DOORS ? T().DOORS.tram : [10.6, 3.6], dw = 0.65;
  var doorsL = [D[0] - dz, D[1] - dz];
  B.box(0, F - 0.04, -0.25, 2.55, 0.04, 12.5, C.floor);
  B.box(0, top - 0.06, 0, 2.5, 0.06, 13, C.roof);
  B.box(0, top - 0.12, 0, 2.3, 0.04, 12.6, C.inner);
  B.box(0, top, 2.4, 0.9, 0.35, 2.4, C.frame);                                   // roof equipment
  [1, -1].forEach(function(side){
    var x = side*hw, cuts = [-half].concat(doorsL.reduce(function(a, z){ return a.concat([z - dw, z + dw]); }, []).sort(function(a, b){ return a - b; })).concat([half]);
    for(var i = 0; i + 1 < cuts.length; i += 2){
      var z0 = cuts[i], z1 = cuts[i+1];
      if(z1 - z0 < 0.05) continue;
      B.box(x - side*0.03, 0.25, (z0 + z1)/2, 0.06, 0.8, z1 - z0, C.paint);
      B.box(x - side*0.025, 0.45, (z0 + z1)/2, 0.07, 0.16, z1 - z0, lineCol);
      for(var z = z0 + 0.03; z < z1; z += 1.05) B.box(x - side*0.03, 1.05, z, 0.06, top - 1.2, 0.05, C.paint);     // thin pillars
      B.box(x - side*0.03, 2.85, (z0 + z1)/2, 0.06, top - 2.9, z1 - z0, C.paint);
    }
  });
  // the cab: a bulkhead with a door, the console, the driver's seat
  B.box(0, F, 5.0, 2.55, top - F - 0.15, 0.05, C.cab);
  B.box(0, F + 0.65, 5.9, 1.9, 0.3, 0.5, C.dash); B.box(0, F + 0.1, 5.4, 0.5, 0.35, 0.5, C.cab);
  B.box(0, 0.25, 6.47, 2.65, 0.85, 0.06, C.paint); B.box(0, 2.95, 6.47, 2.65, 0.35, 0.06, C.paint);
  // the articulation: half a turntable disc in the floor, half the bellows
  B.box(0, F - 0.035, -6.75, 1.9, 0.03, 0.5, C.floor2);
  [1, -1].forEach(function(side){ for(var k = 0; k < 4; k++) B.box(side*1.2, 0.35 + k*0.02, -6.62 - k*0.11, 0.12, top - 0.45, 0.06, C.bellows); });
  B.box(0, top - 0.25, -6.75, 2.3, 0.2, 0.5, C.bellows);
  // bogies
  [3.6, -4.4].forEach(function(z){ B.box(0, 0, z, 2.2, 0.35, 2.2, C.wheel); });
  // seats (the front half of SEATS.tram), with frames
  seatsOf("tram").slice(0, 24).forEach(function(s){
    var z = s.z - dz, back = s.yaw ? 0.2 : -0.2, col = s.priority ? C.seatPri : C.seat;
    B.box(s.x, F + s.y - 0.08, z, 0.44, 0.08, 0.44, col);
    B.box(s.x, F + s.y, z + back, 0.44, 0.52, 0.06, col);
    B.box(s.x, F, z, 0.06, s.y - 0.08, 0.06, C.frame);
  });
  // ceiling grab rails over the aisle, upright poles by each door, handholds on the seat backs
  B.rail(-0.24, top - 0.35, -6.2, 4.8, 0.016, C.rail); B.rail(0.55, top - 0.35, -6.2, 4.8, 0.016, C.rail);
  doorsL.forEach(function(z){ [z - 0.75, z + 0.75].forEach(function(zz){ B.pole(0, F, top - 0.12, zz, 0.02, C.rail, 6); }); });
  return B;
}
function tramLit(R){
  var B = new Builder(true), F = floorOf("tram"), hw = 1.325, top = 3.3, dz = 7, D = T().DOORS ? T().DOORS.tram : [10.6, 3.6], dw = 0.65, idx = {};
  var doorsL = [D[0] - dz, D[1] - dz];
  [1, -1].forEach(function(side){ B.side(side*(hw + 0.005), 1.0, 2.85, -6.45, 6.45, side, GLASS, R.white); });
  B.end(6.5, 1.1, 2.9, -1.2, 1.2, 1, GLASS, R.white);
  [0.3, -0.3].forEach(function(x){ B.quad([x - 0.05, top - 0.13, -6.3], [x + 0.05, top - 0.13, -6.3], [x + 0.05, top - 0.13, 4.9], [x - 0.05, top - 0.13, 4.9], LED, R.white); });
  idx.door = [B.col.length/4];
  doorsL.forEach(function(z){ [1, -1].forEach(function(side){ [z - dw - 0.02, z + dw + 0.02].forEach(function(zz){ B.side(side*(hw - 0.07), F + 0.1, 2.5, zz - 0.02, zz + 0.02, -side, AMBER, R.white); }); }); });
  idx.door.push(B.col.length/4);
  // a passenger information screen per section (over the aisle, facing the articulation) and the STOP signs
  B.end(4.95, 2.45, 2.85, -0.6, 0.6, -1, [1, 1, 1, 1], R.matrix);
  B.end(-1.0, 2.6, 2.9, -0.5, 0.5, -1, [1, 1, 1, 1], R.screen);
  idx.stop = [B.col.length/4];
  B.end(4.93, 2.2, 2.4, 0.7, 1.1, -1, [1, 1, 1, 0.25], R.stop);
  idx.stop.push(B.col.length/4);
  B.end(6.53, 2.95, 3.2, -0.8, 0.8, 1, [1, 1, 1, 1], R.matrix);                  // the outside destination display
  B.idx = idx;
  return B;
}
function tramLeaves(){
  var D = T().DOORS ? T().DOORS.tram : [10.6, 3.6], out = [];
  [D[0] - 7, D[1] - 7].forEach(function(z){ [1, -1].forEach(function(side){ out.push({x: side*1.29, z: z - 0.33, side: side, dir: -1}, {x: side*1.29, z: z + 0.33, side: side, dir: 1}); }); });
  return out;
}
// the per-vehicle canvas: rows of the atlas-like layout (512 x 128)
var CANVAS = {w: 512, h: 128};
function canvasRects(){
  function r(x, y, w, h){ return [x/CANVAS.w, 1 - (y + h)/CANVAS.h, (x + w)/CANVAS.w, 1 - y/CANVAS.h]; }
  return {matrix: r(0, 0, 512, 64), white: r(8, 72, 16, 16), stop: r(128, 64, 128, 64), screen: r(256, 64, 256, 64)};
}

/* ---------- view (THREE from c.THREE, only inside view()) ---------- */
function view(c, sim, opts){
  opts = opts || {};
  var THREE = c.THREE, group = new THREE.Group(); group.name = "hqcoach";
  var Tr = T(), svc = {bus: Tr.service ? Tr.service(sim, "bus", {W: opts.W}) : null, tram: Tr.service ? Tr.service(sim, "tram", {W: opts.W}) : null};
  var seed = sim && sim.seed != null ? sim.seed | 0 : 0;
  var mtx = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(0, 0, 0, "YXZ"), pv = new THREE.Vector3(), sv = new THREE.Vector3(1, 1, 1), col = new THREE.Color();
  var calmF = typeof opts.calm === "function" ? opts.calm : function(){ return false; };
  var reducedF = typeof opts.reduced === "function" ? opts.reduced : function(){ return false; };
  function still(){ return !!(calmF() || reducedF()); }
  function sfx(name, so){ if(typeof opts.sfx === "function") try { opts.sfx(name, so); } catch(err){} }
  function canvas(w, h){
    if(typeof document === "undefined" || !document.createElement) return null;
    try { var cv = document.createElement("canvas"); cv.width = w; cv.height = h; return cv.getContext("2d") ? cv : null; } catch(err){ return null; }
  }

  /* --- the destination atlas (grows as new texts appear; drawn cell by cell) --- */
  var atlasEntries = [], atlas = atlasLayout([]), atlasCv = canvas(ATLAS_W, 512), atlasTex = atlasCv ? new THREE.CanvasTexture(atlasCv) : null, atlasDrawn = {};
  function atlasCell(short, to){
    var key = short + "|" + to;
    for(var i = 0; i < atlas.cells.length; i++) if(atlas.cells[i].key === key) return atlas.cells[i];
    atlasEntries.push({short: short, to: to});
    var H0 = atlas.h;
    atlas = atlasLayout(atlasEntries, {w: ATLAS_W});
    if(atlasCv && atlas.h !== atlasCv.height){ atlasCv.height = Math.max(atlas.h, 32); atlasDrawn = {}; if(atlasTex){ atlasTex.dispose(); atlasTex = new THREE.CanvasTexture(atlasCv); farMat.map = atlasTex; farMat.needsUpdate = true; } }
    if(H0 !== atlas.h) atlasDrawn = {};
    drawAtlas();
    for(i = 0; i < atlas.cells.length; i++) if(atlas.cells[i].key === key) return atlas.cells[i];
    return null;
  }
  function drawAtlas(){
    if(!atlasCv) return;
    var g = atlasCv.getContext("2d"), any = false;
    if(!atlasDrawn.white){ g.fillStyle = "#ffffff"; g.fillRect(atlas.white.x, atlas.white.y, atlas.white.w, atlas.white.h); atlasDrawn.white = 1; any = true; }
    atlas.cells.forEach(function(cl){
      if(atlasDrawn[cl.key]) return;
      g.fillStyle = "#101010"; g.fillRect(cl.x, cl.y, cl.w, cl.h);
      g.fillStyle = "#ffb43a"; g.font = "bold 22px monospace"; g.textBaseline = "middle"; g.textAlign = "left";
      g.fillText(cl.text, cl.x + 6, cl.y + cl.h/2 + 1);
      atlasDrawn[cl.key] = 1; any = true;
    });
    if(any && atlasTex) atlasTex.needsUpdate = true;
  }
  var farMat = new THREE.MeshBasicMaterial({map: atlasTex, vertexColors: true, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1});
  var farMesh = new THREE.Mesh(new THREE.BufferGeometry(), farMat); farMesh.name = "hqcoach-far"; farMesh.frustumCulled = false; group.add(farMesh);

  /* --- people: far passengers (seated silhouettes), near seated and standing figures --- */
  var figs = HQV.hqCommute && HQV.hqCommute.figures ? (function(){ try { return HQV.hqCommute.figures(THREE); } catch(err){ return null; } })() : null;
  function person(seated){
    var g = new THREE.CylinderGeometry(0.19, 0.23, seated ? 0.62 : 1.25, 7); g.translate(0, seated ? 0.86 : 0.68, 0);
    var h = new THREE.SphereGeometry(0.16, 8, 6); h.translate(0, seated ? 1.36 : 1.48, 0);
    var parts = [g, h];
    if(seated){ var lap = new THREE.BoxGeometry(0.4, 0.16, 0.46); lap.translate(0, 0.52, 0.18); parts.push(lap); }
    var pos = [];
    parts.forEach(function(p){ var n = p.index ? p.toNonIndexed() : p, a = n.attributes.position.array; for(var i = 0; i < a.length; i++) pos.push(a[i]); if(n !== p) n.dispose(); p.dispose(); });
    var out = new THREE.BufferGeometry(); out.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); out.computeVertexNormals(); return out;
  }
  var silG = (function(){ var g = new THREE.CylinderGeometry(0.2, 0.22, 0.6, 5); g.translate(0, 0.86, 0); var h = new THREE.SphereGeometry(0.15, 5, 4); h.translate(0, 1.32, 0);
    var pos = []; [g, h].forEach(function(p){ var n = p.index ? p.toNonIndexed() : p, a = n.attributes.position.array; for(var i = 0; i < a.length; i++) pos.push(a[i]); if(n !== p) n.dispose(); p.dispose(); });
    var out = new THREE.BufferGeometry(); out.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); out.computeVertexNormals(); return out; })();
  var peopleM = figs && figs.material ? figs.material : new THREE.MeshStandardMaterial({roughness: 0.8});
  var silM = new THREE.MeshLambertMaterial({color: 0x2a2c33});
  function inst(name, geo, mat, n){ var m = new THREE.InstancedMesh(geo, mat, n); m.name = "hqcoach-" + name; m.count = 0; m.frustumCulled = false; group.add(m); return m; }
  var farPax = inst("passengers", silG, silM, PAX_CAP);
  var seatedG = figs && figs.seated ? figs.seated : person(true), standG = figs && figs.standing ? figs.standing : person(false);
  var seatedI = inst("seated", seatedG, peopleM, 200), standI = inst("standing", standG, peopleM, 120);
  [seatedI, standI].forEach(function(m){ m.castShadow = true; });

  /* --- near models: per slot, built per kind on first use --- */
  var bodyGeo = {}, bodyMat = new THREE.MeshStandardMaterial({vertexColors: true, roughness: 0.6, metalness: 0.1}), doorMat = new THREE.MeshStandardMaterial({color: 0x9fb4c4, roughness: 0.25, metalness: 0.2, transparent: true, opacity: 0.55});
  var leafG = new THREE.BoxGeometry(0.04, 2.0, 0.62); leafG.translate(0, 1.0 + 0.36, 0);
  var R = canvasRects(), slots = [];
  function geoOf(B, rgba){
    var g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(B.pos, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(B.col, rgba ? 4 : 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(B.uv, 2));
    g.computeVertexNormals(); g.computeBoundingSphere();
    return g;
  }
  function lineColRGB(line){ var h = Tr.lineColor ? Tr.lineColor(line) : 0xd23b3b; return [((h >> 16) & 255)/255, ((h >> 8) & 255)/255, (h & 255)/255]; }
  function model(slot, kind, line){
    var key = kind + "|" + line;
    if(slot.models[key]) return slot.models[key];
    var n = kind === "tram" ? 2 : 1;
    if(!bodyGeo[key]) bodyGeo[key] = geoOf(kind === "tram" ? tramBody(lineColRGB(line)) : busBody(lineColRGB(line)), false);
    var LB = kind === "tram" ? tramLit(R) : busLit(R), litGeo = geoOf(LB, true);
    var cv = canvas(CANVAS.w, CANVAS.h), tex = cv ? new THREE.CanvasTexture(cv) : null;
    var litMat = new THREE.MeshBasicMaterial({map: tex, vertexColors: true, transparent: true, depthWrite: false, toneMapped: false, side: THREE.DoubleSide});
    var body = new THREE.InstancedMesh(bodyGeo[key], bodyMat, n), lit = new THREE.InstancedMesh(litGeo, litMat, n);
    var leaves = kind === "tram" ? tramLeaves() : busLeaves(), doors = new THREE.InstancedMesh(leafG, doorMat, leaves.length*n);
    [body, lit, doors].forEach(function(m, i){ m.name = "hqcoach-near-" + ["body", "lit", "doors"][i]; m.frustumCulled = false; m.visible = false; group.add(m); });
    body.castShadow = true; body.receiveShadow = true;
    var M = {kind: kind, line: line, n: n, body: body, lit: lit, doors: doors, leaves: leaves, litGeo: litGeo, idx: LB.idx, cv: cv, tex: tex, litMat: litMat, text: "", stopOn: null, doorLit: null};
    if(cv){ var g = cv.getContext("2d"); g.fillStyle = "#ffffff"; g.fillRect(0, 64, 128, 64); }
    slot.models[key] = M;
    return M;
  }
  for(var si = 0; si < NEAR_N; si++) slots.push({models: {}, vid: null, prev: null});

  /* --- state --- */
  var focusId = null, stopReq = {}, lastMs = 0, lastList = null, hideIds = {}, triCache = 0;
  function rowsAt(ms){
    var out = [], tl = typeof opts.traffic === "function" ? opts.traffic() : null, byId = {};
    (tl || []).forEach(function(v){ if(v.kind === "bus" || v.kind === "tram") byId[v.id] = v; });
    ["bus", "tram"].forEach(function(kind){
      if(!svc[kind]) return;
      svc[kind].vehicles(ms).forEach(function(v){
        var t = byId[v.id];
        if(t){ v.x = t.x; v.y = t.y; v.z = t.z; v.yaw = t.yaw; v.speed = t.speed; if(t.parts) v.parts = t.parts; }
        v.kind = kind; out.push(v);
      });
    });
    return out;
  }
  function put(m, i, x, y, z, yaw, s){ e.set(0, yaw, 0); q.setFromEuler(e); pv.set(x, y, z); sv.set(s || 1, s || 1, s || 1); mtx.compose(pv, q, sv); m.setMatrixAt(i, mtx); }
  // the section poses of a row: [{x, y, z, yaw}] (a tram's rear section turned round, as traffic.view draws it)
  function sectionsOf(v){ return v.kind === "tram" && v.parts ? [v.parts[0], {x: v.parts[1].x, y: v.parts[1].y, z: v.parts[1].z, yaw: v.parts[1].yaw + Math.PI}] : [v]; }

  function update(ms, dt, cam){
    ms = num(ms, 0); lastMs = ms;
    cam = cam || {x: 0, y: 0, z: 0};
    var night = typeof opts.night === "function" ? !!opts.night() : false, calm = still();
    var list = rowsAt(ms); lastList = list;
    list.forEach(function(v){ v.d = Math.hypot(v.x - num(cam.x, 0), v.z - num(cam.z, 0)); });
    // the near set: the focused vehicle, then the nearest within 40 m
    var near = list.filter(function(v){ return v.id === focusId; }).concat(list.filter(function(v){ return v.id !== focusId && v.d <= NEAR_R; }).sort(function(a, b){ return a.d - b.d || (a.id < b.id ? -1 : 1); })).slice(0, NEAR_N);
    hideIds = {};
    near.forEach(function(v){ hideIds[v.id] = true; });
    // keep a vehicle in the slot it had
    var free = slots.filter(function(s){ return !near.some(function(v){ return v.id === s.vid; }); });
    near.forEach(function(v){ if(!slots.some(function(s){ return s.vid === v.id; })){ var s = free.shift(); if(s){ s.vid = v.id; s.prev = null; } } });
    slots.forEach(function(s){ if(!near.some(function(v){ return v.id === s.vid; })) s.vid = null; });
    var nSeat = 0, nStand = 0;
    slots.forEach(function(s){
      var v = near.filter(function(x){ return x.id === s.vid; })[0];
      Object.keys(s.models).forEach(function(k){ var M = s.models[k]; M.body.visible = M.lit.visible = M.doors.visible = false; });
      if(!v) return;
      var M = model(s, v.kind, v.line), secs = sectionsOf(v), dOpen = doorOpen(v.doors, calm), kn = kneel(v.kind, v.doors, calm);
      M.body.visible = M.lit.visible = M.doors.visible = true;
      secs.forEach(function(p, k){
        // a kneeling bus leans its door side down: drawn as a drop of the whole body (pose only under Calm)
        put(M.body, k, p.x, p.y - kn, p.z, p.yaw); put(M.lit, k, p.x, p.y - kn, p.z, p.yaw);
        var c0 = Math.cos(p.yaw), s0 = Math.sin(p.yaw);
        M.leaves.forEach(function(L, j){
          // doors on the kerb side (SIDE x the right of travel: [3.22.3] the left) open: a tram's rear section is turned
          // round, so its other side
          var ks = -sideOf(), opens = v.kind === "bus" ? L.side === ks : (k === 0 ? L.side === ks : L.side === -ks), o = opens ? dOpen : 0;
          var lx = L.x + L.side*DOOR_OUT*Math.min(1, o*3), lz = L.z + L.dir*DOOR_SLIDE*o;
          put(M.doors, k*M.leaves.length + j, p.x + lx*c0 + lz*s0, p.y - kn, p.z - lx*s0 + lz*c0, p.yaw);
        });
      });
      M.body.count = M.lit.count = secs.length; M.doors.count = secs.length*M.leaves.length;
      [M.body, M.lit, M.doors].forEach(function(m){ m.instanceMatrix.needsUpdate = true; });
      // door-edge lights: lit while the doors move or stand open; they blink only while moving (not under Calm)
      var moving = v.doors > 0 && v.doors < 1, on = v.doors > 0 && (!moving || calm || Math.floor(ms/300) % 2 === 0);
      if(M.doorLit !== on){ M.doorLit = on; alphaRange(M, M.idx.door, on ? 1 : 0.05); }
      var req = !!stopReq[v.id];
      if(M.stopOn !== req){ M.stopOn = req; alphaRange(M, M.idx.stop, req ? 1 : 0.25); }
      // the displays: next stop, line and destination
      var nx = v.next, text = (v.short || "") + " " + (v.to || "") + "|" + (nx ? (nx.here ? nx.name : "Next stop: " + nx.name) : "") + "|" + (req ? 1 : 0);
      if(text !== M.text){ M.text = text; drawDisplay(M, v, nx, req); }
      var prev = s.prev;
      s.prev = {doors: v.doors, speed: v.speed};
      if(v.doors <= 0 && prev && prev.doors > 0 && stopReq[v.id]) delete stopReq[v.id];
      // the people aboard (and the driver in the leading cab)
      figures(v.kind, occupied(v.kind, v, ms, seed)).forEach(function(f){
        var w = toWorld(v.kind, v, f);
        if(f.pose === "sit"){ if(nSeat < seatedI.instanceMatrix.count){ put(seatedI, nSeat, w.x, w.y - kn, w.z, w.yaw); tint(seatedI, nSeat, v.id, f.seat); nSeat++; } }
        else if(nStand < standI.instanceMatrix.count){ put(standI, nStand, w.x, w.y - kn, w.z, w.yaw); tint(standI, nStand, v.id, f.seat); nStand++; }
      });
      var dr = toWorld(v.kind, v, v.kind === "tram" ? {x: 0, y: 0, z: 12.4, yaw: 0} : {x: 0.62, y: 0, z: 5.05, yaw: 0});
      if(nSeat < seatedI.instanceMatrix.count){ put(seatedI, nSeat, dr.x, dr.y - kn, dr.z, dr.yaw); tint(seatedI, nSeat, v.id, -1); nSeat++; }
    });
    seatedI.count = nSeat; standI.count = nStand;
    [seatedI, standI].forEach(function(m){ m.instanceMatrix.needsUpdate = true; if(m.instanceColor) m.instanceColor.needsUpdate = true; });
    sounds(list, cam);
    far(list, night, cam);
  }
  // the sounds of every bus and tram within FAR_R, where they happen: doors opening and their hiss at the vehicle's
  // part nearest your ears, a bus's air brakes as it stops at a stop, a tram's bell at its leading cab once its doors
  // have shut. Each kind's reach (door 40 m, bus 180 m, bell 250 m) and its nearest-few limit are games/engine.js's.
  var was = {};
  function sounds(list, cam){
    var E = HQV.engine, ear = null, next = {};
    try { ear = E && E.listenerAt ? E.listenerAt() : null; } catch(err){ ear = null; }
    ear = ear || cam;
    list.forEach(function(v){
      var p = was[v.id], L = null;
      next[v.id] = {doors: v.doors, speed: v.speed};
      if(!p || !(v.d <= FAR_R)) return;                              // first seen: no edge yet
      if(p.doors <= 0 && v.doors > 0){ L = lineOf(v); var at = nearOn(L, ear, 1.2); sfx("door", {pos: at, kind: "door"}); sfx("hiss", {pos: at, kind: "door"}); }
      if(v.kind === "bus" && p.speed > 0.3 && v.speed <= 0.3 && v.next && v.next.here) sfx("air-brake", {pos: nearOn(L || lineOf(v), ear, 0.6), kind: "bus"});
      if(v.kind === "tram" && p.doors > 0 && v.doors <= 0){ var f = (L || lineOf(v))[0]; sfx("tram-bell", {pos: {x: f.x, y: f.y + 1, z: f.z}, kind: "bell"}); }
    });
    was = next;
  }
  function tint(m, i, vid, k){
    var P = HQV.hqCommute && HQV.hqCommute.paint ? (function(){ try { return HQV.hqCommute.paint(vid + ":" + k); } catch(err){ return null; } })() : null;
    function ch(x){ x = num(x, 0.5); return clamp(x > 1 ? x/255 : x, 0, 1); }
    if(P && P.shirt) col.setRGB(ch(P.shirt[0]), ch(P.shirt[1]), ch(P.shirt[2]));
    else col.setHSL(h01(seed, hash32(vid), k + 7), 0.45, 0.32 + 0.3*h01(seed, hash32(vid), k + 99));
    m.setColorAt(i, col);
  }
  function alphaRange(M, r, a){
    var A = M.litGeo.attributes.color;
    for(var i = r[0]; i < r[1]; i++) A.array[i*4 + 3] = a;
    A.needsUpdate = true;
  }
  function drawDisplay(M, v, nx, req){
    if(!M.cv) return;
    var g = M.cv.getContext("2d");
    g.fillStyle = "#0b0b0b"; g.fillRect(0, 0, 512, 64);
    // amber dot-matrix: the text, then a grid of dark lines to read as dots
    g.fillStyle = "#ffb43a"; g.font = "bold 26px monospace"; g.textBaseline = "middle"; g.textAlign = "left";
    g.fillText(fit((v.short || "") + " " + (v.to || "")), 10, 18);
    g.fillText(fit(nx ? (nx.here ? nx.name : "Next: " + nx.name) : ""), 10, 46);
    g.fillStyle = "rgba(0,0,0,0.35)";
    for(var x = 0; x < 512; x += 4) g.fillRect(x, 0, 1, 64);
    for(var y = 0; y < 64; y += 4) g.fillRect(0, y, 512, 1);
    g.fillStyle = req ? "#d01818" : "#3a1010"; g.fillRect(128, 64, 128, 64);
    g.fillStyle = "#ffffff"; g.font = "bold 40px sans-serif"; g.textAlign = "center"; g.fillText("STOP", 192, 98);
    g.fillStyle = "#0c2a4a"; g.fillRect(256, 64, 256, 64);
    g.fillStyle = "#e8f0ff"; g.font = "bold 20px sans-serif"; g.textAlign = "left";
    g.fillText(fit((v.short || "") + " to " + (v.to || "")), 266, 82);
    g.fillText(fit(nx ? nx.name : ""), 266, 108);
    if(M.tex) M.tex.needsUpdate = true;
  }
  // far additions: displays at both ends (the door side too on a bus), colour bands, warm windows at night,
  // and the seated passengers in the windows
  function far(list, night, cam){
    var P = [], U = [], Cc = [], wv = atlas.white, nPax = 0;
    function quadW(a, b, cc, d, col4, rc){
      P.push(a[0], a[1], a[2], b[0], b[1], b[2], cc[0], cc[1], cc[2], a[0], a[1], a[2], cc[0], cc[1], cc[2], d[0], d[1], d[2]);
      U.push(rc[0], rc[1], rc[2], rc[1], rc[2], rc[3], rc[0], rc[1], rc[2], rc[3], rc[0], rc[3]);
      for(var i = 0; i < 6; i++) Cc.push(col4[0], col4[1], col4[2]);
    }
    var whiteR = [wv.uc, wv.vc, wv.uc, wv.vc];
    list.forEach(function(v){
      if(v.d > FAR_R) return;
      var kind = v.kind, lc = lineColRGB(v.line), cell = atlasCell(v.short || "", v.to || ""), rc = cell ? [cell.u0, cell.v0, cell.u1, cell.v1] : whiteR, isNear = !!hideIds[v.id];
      sectionsOf(v).forEach(function(p, k){
        var c0 = Math.cos(p.yaw), s0 = Math.sin(p.yaw);
        function w(x, y, z){ return [p.x + x*c0 + z*s0, p.y + y, p.z - x*s0 + z*c0]; }
        var hl = kind === "tram" ? 6.5 : 6, hw = (kind === "tram" ? 2.65 : 2.55)/2 + 0.012, y0 = kind === "tram" ? 2.72 : 2.5, y1 = y0 + 0.26;
        if(!isNear){
          // destination display on the front of this section (a tram's rear section is turned round: its back)
          quadW(w(-0.75, y0, hl + 0.03), w(0.75, y0, hl + 0.03), w(0.75, y1, hl + 0.03), w(-0.75, y1, hl + 0.03), [1, 1, 1], rc);
          // (the bus's door side display: [3.22.3] on the kerb side, -SIDE x +x, wound to face out)
          if(kind === "bus"){ var sx = -sideOf()*hw, za = sx < 0 ? 3.0 : 4.3, zb = 7.3 - za; quadW(w(sx, y0, za), w(sx, y0, zb), w(sx, y1, zb), w(sx, y1, za), [1, 1, 1], rc); }
          // route colour bands both sides
          var by = kind === "tram" ? 0.45 : 0.55;
          quadW(w(hw, by, -hl), w(hw, by, hl), w(hw, by + 0.16, hl), w(hw, by + 0.16, -hl), lc, whiteR);
          quadW(w(-hw, by, hl), w(-hw, by, -hl), w(-hw, by + 0.16, -hl), w(-hw, by + 0.16, hl), lc, whiteR);
          if(night){
            var wy0 = kind === "tram" ? 1.15 : 1.25, wy1 = kind === "tram" ? 2.8 : 2.55;
            quadW(w(hw + 0.004, wy0, -hl + 0.6), w(hw + 0.004, wy0, hl - 0.8), w(hw + 0.004, wy1, hl - 0.8), w(hw + 0.004, wy1, -hl + 0.6), WARM, whiteR);
            quadW(w(-hw - 0.004, wy0, hl - 0.8), w(-hw - 0.004, wy0, -hl + 0.6), w(-hw - 0.004, wy1, -hl + 0.6), w(-hw - 0.004, wy1, hl - 0.8), WARM, whiteR);
          }
        }
      });
      if(isNear || v.d > PAX_R) return;
      figures(kind, occupied(kind, v, lastMs, seed)).forEach(function(f){
        if(f.pose !== "sit" || nPax >= PAX_CAP) return;
        var p = toWorld(kind, v, f);
        put(farPax, nPax++, p.x, p.y, p.z, p.yaw);
      });
    });
    farPax.count = nPax; farPax.instanceMatrix.needsUpdate = true;
    var g = farMesh.geometry;
    g.setAttribute("position", new THREE.Float32BufferAttribute(P, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(U, 2));
    g.setAttribute("color", new THREE.Float32BufferAttribute(Cc, 3));
    g.computeBoundingSphere();
    farMesh.visible = P.length > 0;
  }
  function focus(id){ focusId = id == null ? null : String(id); }
  function requestStop(id){ id = id == null ? focusId : String(id); if(id && !stopReq[id]){ stopReq[id] = true; sfx("stop-bell"); } return !!id; }
  function drawCalls(){
    var n = 0;
    group.children.forEach(function(m){ if(m.visible && (m.isInstancedMesh ? m.count > 0 : m.geometry.attributes.position && m.geometry.attributes.position.count > 0)) n++; });
    return n;
  }
  // by budget line (plan 3.14): far additions, near interiors, the people aboard
  function drawCallsBy(){
    var o = {far: 0, near: 0, people: 0};
    group.children.forEach(function(m){
      if(!m.visible || !(m.isInstancedMesh ? m.count > 0 : m.geometry.attributes.position && m.geometry.attributes.position.count > 0)) return;
      if(m === farMesh || m === farPax) o.far++; else if(m === seatedI || m === standI) o.people++; else o.near++;
    });
    return o;
  }
  function triangles(){
    var t = 0;
    group.children.forEach(function(m){
      if(!m.visible) return;
      var g = m.geometry, per = g.index ? g.index.count/3 : (g.attributes.position ? g.attributes.position.count/3 : 0);
      t += m.isInstancedMesh ? per*m.count : per;
    });
    return Math.round(t);
  }
  // fixed cameras for the screenshot tour: inside the focused (else the first) bus or tram, a stop, a junction
  function shotCam(name){
    var list = lastList || rowsAt(lastMs);
    function veh(kind){ return list.filter(function(v){ return v.kind === kind && v.id === focusId; })[0] || list.filter(function(v){ return v.kind === kind; })[0]; }
    function cam(kind, v, a, b, fov){ var p = toWorld(kind, v, a), l = toWorld(kind, v, b); return {pos: {x: p.x, y: p.y, z: p.z}, look: {x: l.x, y: l.y, z: l.z}, fov: fov}; }
    if(name === "bus-interior"){ var b = veh("bus"); return b ? cam("bus", b, {x: 0.2*sideOf(), y: 1.55, z: -4.6}, {x: -0.2*sideOf(), y: 1.2, z: 5}, 70) : null; }
    if(name === "tram-interior"){ var t = veh("tram"); return t ? cam("tram", t, {x: -0.2, y: 1.6, z: 11.4}, {x: 0, y: 1.2, z: -11}, 70) : null; }
    if(name === "tram-stop" && svc.tram){
      var st = svc.tram.stops()[0];
      if(!st) return null;
      return {pos: {x: st.x + 14, y: st.y + 4, z: st.z + 14}, look: {x: st.x, y: st.y + 1, z: st.z}, fov: 55};
    }
    if(name === "tram-junction" && Tr.tramPaths && sim && sim.layout){
      var turn = Tr.tramPaths(null, 5, sim).filter(function(p){ return p.kind === "turn" && p.pts.length > 6; })[0];
      if(!turn) return null;
      var m = Math.floor(turn.pts.length/6)*3;
      return {pos: {x: turn.pts[m] + 16, y: turn.pts[m+1] + 13, z: turn.pts[m+2] + 16}, look: {x: turn.pts[m], y: turn.pts[m+1], z: turn.pts[m+2]}, fov: 55};
    }
    return null;
  }
  function dispose(){
    slots.forEach(function(s){ Object.keys(s.models).forEach(function(k){ var M = s.models[k]; M.litGeo.dispose(); M.litMat.dispose(); if(M.tex) M.tex.dispose(); M.body.dispose(); M.lit.dispose(); M.doors.dispose(); }); });
    Object.keys(bodyGeo).forEach(function(k){ bodyGeo[k].dispose(); });
    [farMesh.geometry, silG, leafG].forEach(function(g){ g.dispose(); });
    if(!figs){ seatedG.dispose(); standG.dispose(); peopleM.dispose(); }
    [farMat, silM, bodyMat, doorMat].forEach(function(m){ m.dispose(); });
    if(atlasTex) atlasTex.dispose();
    [farPax, seatedI, standI].forEach(function(m){ m.dispose(); });
    if(group.parent) group.parent.remove(group);
  }
  drawAtlas();
  if(opts.parent) opts.parent.add(group);
  return {group: group, update: update, focus: focus, requestStop: requestStop, hide: function(){ return hideIds; }, drawCalls: drawCalls, drawCallsBy: drawCallsBy, triangles: triangles,
          services: svc, atlas: function(){ return atlas; }, tools: {shotCam: shotCam}, dispose: dispose};
}

HQV.hqCoach = {atlasLayout: atlasLayout, occupied: occupied, figures: figures, toWorld: toWorld, doorOpen: doorOpen, kneel: kneel, lineOf: lineOf, nearOn: nearOn, view: view,
               NEAR_R: NEAR_R, NEAR_N: NEAR_N, MAX_CHARS: MAX_CHARS, KNEEL: KNEEL, BODY: BODY,
               _: {busBody: busBody, tramBody: tramBody, busLit: busLit, tramLit: tramLit, busLeaves: busLeaves, tramLeaves: tramLeaves, canvasRects: canvasRects, fit: fit}};
})();
