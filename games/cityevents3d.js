/* Claude HQ: the street events of city life drawn in the 3D City (HQV.cityEvents3d, HQ 3.21).
 *
 * HQV.cityLife.events(W, localMs) says what is on (the weekly street market, Sunday's parade, the week's roadworks)
 * and on which edges; this file only draws it, near the camera, and makes its barriers solid. Built around City Gen
 * v4, never into it: it reads the finished world's edges (centre line, width, footpath) and nodes, nothing about how
 * they were laid out, and every prop is a pure function of (W, the seed in W.hash, the event), so every player at the
 * same local time sees the same stalls, cones and flags.
 *
 *   pieces(W, ev)            the props of one event: {stalls, barriers, cones, signs, plant, rails, poles, flags,
 *                            strings, solid}; each {x, y, z, yaw, ...} in metres (yaw 0 faces +z), solid [{x, z, yaw,
 *                            hx, hz}] the footprints that block (hx across, hz along the yaw)
 *     market     stalls with coloured canopies in the carriageway along both kerbs, backs to the kerb
 *     roadworks  a barrier across the carriageway at each end with a ROAD CLOSED plate facing out, a pit fenced
 *                with cones in the middle, a digger and a compressor beside it
 *     parade     crowd barriers along both kerbs (a gap every few to let people through) and bunting across the
 *                road between poles on every edge of the route
 *   create(THREE, scene, W, opts) -> {group, update(localMs, cam), blocked(x, z), info(), drawCalls(), dispose()}
 *                            an event is built (one merged, vertex-coloured mesh; the roadworks' plates a second, with
 *                            the sign texture) while it is on and the camera is within NEAR m of it, dropped past FAR
 * Draw calls: one per event near you, two for roadworks (at most a market and three roadworks at once: 7).
 */
(function(){
"use strict";
var root = typeof window !== "undefined" ? window : self;
var HQV = root.HQV = root.HQV || {};

var NEAR = 420, FAR = 560;                 // m from the event's nearest edge point: built inside NEAR, dropped past FAR
var STALL_STEP = 3.3, STALL_W = 2.8, STALL_D = 2.2, KERB_IN = 1.3;   // a stall every 3.3 m, 2.8 x 2.2 m, centred 1.3 m in
var RAIL_LEN = 2.3, RAIL_GAP = 1.6, RAIL_RUN = 4, BUNT_STEP = 16, FLAG_STEP = 0.7;
var CANOPY = [0xd8443a, 0x2f7fd1, 0x2fa36b, 0xe6b422, 0xe07a2c, 0x8a55c8, 0xf2f2ee, 0x1aa3b8, 0xc8326e];
var FLAGS = [0xd8443a, 0xf2f2ee, 0x2f7fd1, 0xe6b422, 0x2fa36b];

function hash01(s){
  s = String(s);
  var h = 0x811c9dc5;
  for(var i = 0; i < s.length; i++){ h ^= s.charCodeAt(i) & 0xff; h = Math.imul(h, 0x01000193); }
  return (h >>> 0)/4294967296;
}
function cm(v){ return (+v || 0)/100; }

/* ---------- the edges an event stands on ---------- */
var GEO = typeof WeakMap === "function" ? new WeakMap() : null;
function geoOf(W){
  var G = GEO && GEO.get(W);
  if(G) return G;
  G = {edges: {}, nodes: {}, inc: {}};
  (W.nodes || []).forEach(function(n){ G.nodes[n.id] = {x: cm(n.x), z: cm(n.z)}; });
  (W.edges || []).forEach(function(e){
    G.edges[e.id] = e;
    (G.inc[e.a] = G.inc[e.a] || []).push(e); (G.inc[e.b] = G.inc[e.b] || []).push(e);
  });
  if(GEO) GEO.set(W, G);
  return G;
}
function half(e){ return Math.max(1.5, (num(e.width, 1200) - 2*num(e.walk, 200))/200); }
function num(v, d){ return typeof v === "number" && isFinite(v) ? v : d; }
// an edge as a line: points, lengths, half the carriageway, and how far back from each node its junction box reaches
function lineOf(W, id){
  var G = geoOf(W), e = G.edges[id];
  if(!e || !e.pts || e.pts.length < 6) return null;
  var P = [], cum = [0], p = e.pts;
  for(var i = 0; i + 2 < p.length; i += 3) P.push({x: p[i]/100, y: p[i + 1]/100, z: p[i + 2]/100});
  for(i = 1; i < P.length; i++) cum.push(cum[i - 1] + Math.hypot(P[i].x - P[i - 1].x, P[i].z - P[i - 1].z));
  var L = cum[cum.length - 1], c = half(e);
  function box(node){
    var m = 0;
    (G.inc[node] || []).forEach(function(o){ if(o.id !== e.id) m = Math.max(m, half(o)); });
    return m ? Math.min(m + 2.5, 0.3*L) : 0.5;
  }
  return {e: e, id: id, P: P, cum: cum, L: L, c: c, t0: box(e.a), t1: box(e.b),
    // the point s m along, its direction (dx, dz), its left (lx, lz) and yaw (travel a -> b)
    at: function(s){
      s = Math.max(0, Math.min(L, s));
      var k = 0;
      while(k < P.length - 2 && cum[k + 1] < s) k++;
      var a = P[k], b = P[k + 1], sl = cum[k + 1] - cum[k] || 1, t = (s - cum[k])/sl, dx = (b.x - a.x)/sl, dz = (b.z - a.z)/sl;
      return {x: a.x + (b.x - a.x)*t, y: a.y + (b.y - a.y)*t, z: a.z + (b.z - a.z)*t, dx: dx, dz: dz, lx: dz, lz: -dx, yaw: Math.atan2(dx, dz)};
    }};
}
function off(p, o){ return {x: p.x + p.lx*o, z: p.z + p.lz*o}; }

/* ---------- the props of an event (pure) ---------- */
function pieces(W, ev){
  var out = {stalls: [], barriers: [], cones: [], signs: [], plant: [], rails: [], poles: [], flags: [], strings: [], solid: []};
  if(!W || !ev) return out;
  var seed = String(W.hash || W.id || "") + ":" + ev.id + ":";
  (ev.edges || []).forEach(function(id){
    var E = lineOf(W, id);
    if(!E || E.L < 8) return;
    if(ev.kind === "market") market(E, seed, out);
    else if(ev.kind === "roadworks") works(E, seed, out);
    else if(ev.kind === "parade") parade(E, seed, out);
  });
  return out;
}
function market(E, seed, out){
  var a = E.t0 + STALL_W/2 + 0.6, b = E.L - E.t1 - STALL_W/2 - 0.6, i = 0;
  for(var s = a; s <= b; s += STALL_STEP, i++){
    var p = E.at(s);
    [1, -1].forEach(function(sg){
      var q = off(p, sg*(E.c - KERB_IN)), h = hash01(seed + i + ":" + sg);
      if(h < 0.08) return;                                   // a gap now and then
      // its back to the kerb: it faces the middle of the street
      var yaw = Math.atan2(-sg*p.lx, -sg*p.lz);
      out.stalls.push({x: q.x, y: p.y, z: q.z, yaw: yaw, col: CANOPY[Math.floor(hash01(seed + "c" + i + ":" + sg)*CANOPY.length)], h: h});
      out.solid.push({x: q.x, z: q.z, yaw: yaw, hx: STALL_W/2, hz: STALL_D/2});
    });
  }
}
function works(E, seed, out){
  var ends = [[E.t0 + 0.8, 1], [E.L - E.t1 - 0.8, -1]];
  ends.forEach(function(en){
    var p = E.at(en[0]), n = Math.max(1, Math.ceil(2*E.c/2)), w = 2*E.c/n;
    for(var k = 0; k < n; k++){
      var q = off(p, -E.c + w*(k + 0.5));
      out.barriers.push({x: q.x, y: p.y, z: q.z, yaw: p.yaw, len: w - 0.1});        // (its boards along its local x: across the road)
    }
    out.solid.push({x: p.x, z: p.z, yaw: p.yaw, hx: E.c, hz: 0.35});
    // the plate, a step out in front, facing the traffic that comes up to it; cones either side of it
    var fx = -en[1]*p.dx, fz = -en[1]*p.dz, sx = p.x + fx*1.4, sz = p.z + fz*1.4;
    out.signs.push({x: sx, y: p.y, z: sz, yaw: Math.atan2(fx, fz)});
    out.solid.push({x: sx, z: sz, yaw: Math.atan2(fx, fz), hx: 0.75, hz: 0.3});
    [-0.55, 0.55].forEach(function(f){ var c = off(p, f*E.c); out.cones.push({x: c.x + fx*2.4, y: p.y, z: c.z + fz*2.4}); });
  });
  // the pit, to one side of the middle, fenced with cones; the digger beyond it, the compressor before it
  var sg = hash01(seed + "side") < 0.5 ? 1 : -1, mid = E.L/2, d = Math.max(3, Math.min(8, (E.L - E.t0 - E.t1)*0.25)), wd = Math.max(1.6, E.c*0.8);
  var p = E.at(mid), q = off(p, sg*E.c*0.45);
  out.plant.push({kind: "pit", x: q.x, y: p.y, z: q.z, yaw: p.yaw, w: wd, d: d});
  out.solid.push({x: q.x, z: q.z, yaw: p.yaw, hx: wd/2 + 0.3, hz: d/2 + 0.3});
  for(var u = -d/2; u <= d/2 + 1e-6; u += Math.max(1.2, d/6)) [-1, 1].forEach(function(f){
    out.cones.push({x: q.x + p.dx*u + p.lx*f*(wd/2 + 0.3), y: p.y, z: q.z + p.dz*u + p.lz*f*(wd/2 + 0.3)});
  });
  var g = E.at(Math.min(E.L - E.t1 - 2, mid + d/2 + 3)), gq = off(g, sg*E.c*0.4);
  out.plant.push({kind: "digger", x: gq.x, y: g.y, z: gq.z, yaw: g.yaw + Math.PI});
  out.solid.push({x: gq.x, z: gq.z, yaw: g.yaw, hx: 1.3, hz: 1.9});
  var k = E.at(Math.max(E.t0 + 2, mid - d/2 - 2.4)), kq = off(k, sg*E.c*0.45);
  out.plant.push({kind: "compressor", x: kq.x, y: k.y, z: kq.z, yaw: k.yaw});
  out.solid.push({x: kq.x, z: kq.z, yaw: k.yaw, hx: 0.7, hz: 1.3});
}
function parade(E, seed, out){
  var a = E.t0 + 1, b = E.L - E.t1 - 1, i = 0;
  [1, -1].forEach(function(sg){
    i = 0;
    for(var s = a; s + RAIL_LEN <= b; i++){
      var p = E.at(s + RAIL_LEN/2), q = off(p, sg*(E.c - 0.35));
      out.rails.push({x: q.x, y: p.y, z: q.z, yaw: p.yaw});
      out.solid.push({x: q.x, z: q.z, yaw: p.yaw, hx: 0.2, hz: RAIL_LEN/2});
      s += RAIL_LEN + ((i + 1) % RAIL_RUN ? 0.05 : RAIL_GAP);
    }
  });
  // bunting: a string across the road between two poles every BUNT_STEP m, sagging 0.8 m, a flag every 0.7 m
  for(var s = a + BUNT_STEP/2, j = 0; s <= b; s += BUNT_STEP, j++){
    var p = E.at(s), r = E.c + 0.6, A = off(p, r), B = off(p, -r), y0 = p.y + 5.2;
    out.poles.push({x: A.x, y: p.y, z: A.z}, {x: B.x, y: p.y, z: B.z});
    var n = Math.max(2, Math.round(2*r/FLAG_STEP)), m = Math.max(1, Math.floor(n/6)), pts = [];
    for(var k = 0; k <= n; k++){
      var t = k/n, pt = {x: A.x + (B.x - A.x)*t, y: y0 - 0.8*4*t*(1 - t), z: A.z + (B.z - A.z)*t};
      pts.push(pt);
      // (yaw: the pennant's width, its local x, runs along the string, across the road)
      if(k > 0 && k < n) out.flags.push({x: pt.x, y: pt.y, z: pt.z, yaw: p.yaw, col: FLAGS[(j + k) % FLAGS.length]});
    }
    for(var k0 = 0; k0 < n; k0 = Math.min(n, k0 + m)) out.strings.push({a: pts[k0], b: pts[Math.min(n, k0 + m)]});
  }
}

/* ---------- drawing ---------- */
var SIGN_TEX = null;
function signTexture(THREE){
  if(SIGN_TEX) return SIGN_TEX;
  if(typeof document === "undefined" || !document.createElement) return null;
  try {
    var cv = document.createElement("canvas"); cv.width = 256; cv.height = 128;
    var g = cv.getContext("2d");
    if(!g) return null;
    g.fillStyle = "#c8202a"; g.fillRect(0, 0, 256, 128);
    g.fillStyle = "#ffffff"; g.fillRect(9, 9, 238, 110);
    g.fillStyle = "#c8202a"; g.font = "bold 46px sans-serif"; g.textAlign = "center"; g.textBaseline = "middle";
    g.fillText("ROAD", 128, 44); g.fillText("CLOSED", 128, 88);
    SIGN_TEX = new THREE.CanvasTexture(cv);
    if(THREE.SRGBColorSpace) SIGN_TEX.colorSpace = THREE.SRGBColorSpace;
  } catch(e){ SIGN_TEX = null; }
  return SIGN_TEX;
}

function create(THREE, scene, W, opts){
  opts = opts || {};
  var group = new THREE.Group(), built = {}, last = {key: null, x: null, z: null}, list = [];
  group.name = "city-events";
  if(scene && scene.add) scene.add(group);
  var mat = new THREE.MeshStandardMaterial({vertexColors: true, roughness: 0.7, metalness: 0.05});
  var tex = signTexture(THREE), signMat = tex ? new THREE.MeshStandardMaterial({map: tex, roughness: 0.6}) : new THREE.MeshStandardMaterial({color: 0xd8262c, roughness: 0.6});
  var m1 = new THREE.Matrix4(), m2 = new THREE.Matrix4(), qq = new THREE.Quaternion(), eu = new THREE.Euler(0, 0, 0, "YXZ"), v3 = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1);

  // a merged geometry: parts added with (geometry, colour, piece pose x y z yaw, local x y z, local rx ry rz)
  function Merge(uv){ this.P = []; this.N = []; this.C = []; this.U = uv ? [] : null; }
  Merge.prototype.add = function(g, hex, px, py, pz, yaw, lx, ly, lz, rx, ry, rz){
    var G = g.index ? g.toNonIndexed() : g, k = new THREE.Color(hex);
    m1.makeRotationY(yaw || 0); m1.setPosition(px, py, pz);
    eu.set(rx || 0, ry || 0, rz || 0); qq.setFromEuler(eu); v3.set(lx || 0, ly || 0, lz || 0); m2.compose(v3, qq, one);
    m1.multiply(m2); G.applyMatrix4(m1);
    var a = G.attributes.position.array, n = G.attributes.normal.array, i;
    for(i = 0; i < a.length; i++){ this.P.push(a[i]); this.N.push(n[i]); }
    for(i = 0; i < a.length/3; i++) this.C.push(k.r, k.g, k.b);
    if(this.U){ var uu = G.attributes.uv ? G.attributes.uv.array : null; for(i = 0; i < a.length/3; i++){ this.U.push(uu ? uu[2*i] : 0, uu ? uu[2*i + 1] : 0); } }
    if(G !== g) G.dispose();
    g.dispose();
  };
  Merge.prototype.geometry = function(){
    if(!this.P.length) return null;
    var out = new THREE.BufferGeometry();
    out.setAttribute("position", new THREE.Float32BufferAttribute(this.P, 3));
    out.setAttribute("normal", new THREE.Float32BufferAttribute(this.N, 3));
    out.setAttribute("color", new THREE.Float32BufferAttribute(this.C, 3));
    if(this.U) out.setAttribute("uv", new THREE.Float32BufferAttribute(this.U, 2));
    out.computeBoundingSphere();
    return out;
  };
  function box(w, h, d){ return new THREE.BoxGeometry(w, h, d); }
  function cyl(r0, r1, h, n){ return new THREE.CylinderGeometry(r0, r1, h, n || 8); }
  // a flag: a pennant, both faces (no double-sided material)
  function flag(){
    var g = new THREE.BufferGeometry(), w = 0.22, h = 0.34;
    g.setAttribute("position", new THREE.Float32BufferAttribute([-w, 0, 0, w, 0, 0, 0, -h, 0, w, 0, 0, -w, 0, 0, 0, -h, 0], 3));
    g.computeVertexNormals();
    return g;
  }

  function stall(M, s){
    var x = s.x, y = s.y, z = s.z, yaw = s.yaw, hw = STALL_W/2 - 0.08, hd = STALL_D/2 - 0.08, wood = 0xb08a5a;
    [[-hw, -hd], [hw, -hd], [-hw, hd], [hw, hd]].forEach(function(c, i){ M.add(box(0.07, i < 2 ? 2.1 : 2.4, 0.07), 0x6a6f76, x, y, z, yaw, c[0], (i < 2 ? 2.1 : 2.4)/2, c[1]); });
    M.add(box(STALL_W - 0.2, 0.85, 0.75), wood, x, y, z, yaw, 0, 0.43, hd - 0.4);                   // the counter, at the front
    M.add(box(STALL_W - 0.3, 0.06, 0.8), 0xf2efe6, x, y, z, yaw, 0, 0.88, hd - 0.4);
    // the goods on the counter, by the stall's own number: crates of fruit, folded cloth, flowers
    var gc = s.h < 0.4 ? [0xd8443a, 0xe6b422, 0x5aa040] : s.h < 0.7 ? [0x2f7fd1, 0xc8326e, 0xf2f2ee] : [0xe07a2c, 0xc8326e, 0x8a55c8];
    gc.forEach(function(c, i){ M.add(box(0.6, 0.18, 0.45), c, x, y, z, yaw, -0.8 + 0.8*i, 1.0, hd - 0.4); });
    M.add(box(STALL_W, 0.07, STALL_D + 0.3), s.col, x, y, z, yaw, 0, 2.3, 0.1, 0.14);              // the canopy, sloping to the front
    M.add(box(STALL_W, 0.22, 0.04), s.col, x, y, z, yaw, 0, 2.05, hd + 0.4);                       // its valance
    M.add(box(STALL_W, 0.08, 0.05), 0xf2f2ee, x, y, z, yaw, 0, 1.92, hd + 0.4);
  }
  function barrier(M, b){
    var hl = b.len/2;
    [-hl + 0.12, hl - 0.12].forEach(function(lx){
      M.add(box(0.12, 0.08, 0.6), 0x2a2c30, b.x, b.y, b.z, b.yaw, lx, 0.04, 0);
      M.add(box(0.06, 1.0, 0.06), 0xd9dde2, b.x, b.y, b.z, b.yaw, lx, 0.55, 0);
    });
    M.add(box(b.len, 0.26, 0.04), 0xf2f2ee, b.x, b.y, b.z, b.yaw, 0, 0.92, 0);
    for(var k = -hl + 0.25; k < hl - 0.1; k += 0.5) M.add(box(0.25, 0.27, 0.05), 0xc8202a, b.x, b.y, b.z, b.yaw, k + 0.125, 0.92, 0);
    M.add(box(0.12, 0.12, 0.12), 0xffa020, b.x, b.y, b.z, b.yaw, 0, 1.12, 0);                    // the lamp
  }
  function cone(M, c){
    M.add(box(0.38, 0.04, 0.38), 0x2a2c30, c.x, c.y, c.z, 0, 0, 0.02, 0);
    M.add(cyl(0.035, 0.17, 0.6, 8), 0xff6a1a, c.x, c.y, c.z, 0, 0, 0.34, 0);
    M.add(cyl(0.085, 0.11, 0.1, 8), 0xf2f2ee, c.x, c.y, c.z, 0, 0, 0.42, 0);
  }
  function sign(M, S, g){
    M.add(box(0.06, 1.05, 0.06), 0x6a6f76, g.x, g.y, g.z, g.yaw, -0.5, 0.52, -0.03);
    M.add(box(0.06, 1.05, 0.06), 0x6a6f76, g.x, g.y, g.z, g.yaw, 0.5, 0.52, -0.03);
    M.add(box(0.7, 0.05, 0.5), 0x2a2c30, g.x, g.y, g.z, g.yaw, 0, 0.03, -0.03);
    M.add(box(1.44, 0.74, 0.03), 0x9aa0a8, g.x, g.y, g.z, g.yaw, 0, 1.4, -0.03);                  // the plate's back
    S.add(new THREE.PlaneGeometry(1.4, 0.7), 0xffffff, g.x, g.y, g.z, g.yaw, 0, 1.4, -0.01);
  }
  function plant(M, p){
    var x = p.x, y = p.y, z = p.z, yaw = p.yaw;
    if(p.kind === "pit"){
      M.add(box(p.w, 0.06, p.d), 0x3a2e24, x, y, z, yaw, 0, 0.03, 0);
      M.add(box(p.w*0.7, 0.35, 0.9), 0x7a6650, x, y, z, yaw, p.w*0.1, 0.17, p.d/2 - 0.6);           // the spoil heap
      M.add(box(0.5, 0.04, p.d*0.8), 0x9aa0a8, x, y, z, yaw, -p.w*0.25, 0.08, 0);                     // a steel plate
    } else if(p.kind === "digger"){
      var Y = 0xe8b020;
      [-0.85, 0.85].forEach(function(lx){ M.add(box(0.5, 0.55, 2.9), 0x2a2c30, x, y, z, yaw, lx, 0.28, 0); });
      M.add(box(1.9, 0.8, 2.1), Y, x, y, z, yaw, 0, 0.95, -0.25);
      M.add(box(1.0, 1.25, 1.1), Y, x, y, z, yaw, 0.38, 1.95, -0.2);
      M.add(box(1.02, 0.7, 0.9), 0x28323e, x, y, z, yaw, 0.38, 2.1, -0.18);
      M.add(box(0.28, 0.28, 2.4), Y, x, y, z, yaw, -0.35, 1.9, 1.35, -0.55);                       // the boom
      M.add(box(0.24, 0.24, 1.6), Y, x, y, z, yaw, -0.35, 1.75, 2.65, 0.9);                        // the stick
      M.add(box(0.7, 0.45, 0.45), 0x30343a, x, y, z, yaw, -0.35, 0.65, 3.0);                       // the bucket
    } else if(p.kind === "compressor"){
      M.add(box(1.1, 0.85, 1.5), 0xe07a2c, x, y, z, yaw, 0, 0.85, 0);
      M.add(box(1.12, 0.12, 1.52), 0x2a2c30, x, y, z, yaw, 0, 1.3, 0);
      [-0.62, 0.62].forEach(function(lx){ M.add(cyl(0.3, 0.3, 0.16, 12), 0x1c1d21, x, y, z, yaw, lx, 0.3, 0, 0, 0, Math.PI/2); });
      M.add(box(0.08, 0.08, 1.0), 0x2a2c30, x, y, z, yaw, 0, 0.45, 1.2);                           // the drawbar
    }
  }
  function rail(M, r){
    var hl = RAIL_LEN/2;
    M.add(box(0.05, 0.05, RAIL_LEN), 0xb8bec6, r.x, r.y, r.z, r.yaw, 0, 1.05, 0);
    M.add(box(0.05, 0.05, RAIL_LEN), 0xb8bec6, r.x, r.y, r.z, r.yaw, 0, 0.22, 0);
    M.add(box(0.02, 0.8, RAIL_LEN - 0.1), 0x8a9199, r.x, r.y, r.z, r.yaw, 0, 0.63, 0);
    [-hl + 0.1, hl - 0.1].forEach(function(lz){ M.add(box(0.6, 0.04, 0.06), 0x8a9199, r.x, r.y, r.z, r.yaw, 0, 0.02, lz); });
  }
  function build(ev){
    var P = pieces(W, ev), M = new Merge(false), S = new Merge(true);
    P.stalls.forEach(function(s){ stall(M, s); });
    P.barriers.forEach(function(b){ barrier(M, b); });
    P.cones.forEach(function(c){ cone(M, c); });
    P.signs.forEach(function(g){ sign(M, S, g); });
    P.plant.forEach(function(p){ plant(M, p); });
    P.rails.forEach(function(r){ rail(M, r); });
    P.poles.forEach(function(p){ M.add(cyl(0.06, 0.07, 5.3, 6), 0x6a6f76, p.x, p.y, p.z, 0, 0, 2.65, 0); });
    P.strings.forEach(function(s){
      var dx = s.b.x - s.a.x, dy = s.b.y - s.a.y, dz = s.b.z - s.a.z, h = Math.hypot(dx, dz), L = Math.hypot(h, dy);
      M.add(box(0.025, 0.025, L), 0xf2f2ee, (s.a.x + s.b.x)/2, (s.a.y + s.b.y)/2, (s.a.z + s.b.z)/2, Math.atan2(dx, dz), 0, 0, 0, -Math.atan2(dy, h));
    });
    P.flags.forEach(function(f){ M.add(flag(), f.col, f.x, f.y, f.z, f.yaw, 0, 0, 0); });
    var g = new THREE.Group(), meshes = [];
    g.name = "city-event-" + ev.id;
    [[M.geometry(), mat], [S.geometry(), signMat]].forEach(function(x){
      if(!x[0]) return;
      var m = new THREE.Mesh(x[0], x[1]);
      m.castShadow = true; m.receiveShadow = true; m.name = g.name; g.add(m); meshes.push(m);
    });
    group.add(g);
    // the near test and blocked()'s quick reject: the event's footprint box, and its edges' points
    var bb = [Infinity, Infinity, -Infinity, -Infinity], pts = [];
    (ev.edges || []).forEach(function(id){ var E = lineOf(W, id); if(E) E.P.forEach(function(p){ pts.push(p); }); });
    P.solid.forEach(function(r){ var R = Math.max(r.hx, r.hz); bb[0] = Math.min(bb[0], r.x - R); bb[1] = Math.min(bb[1], r.z - R); bb[2] = Math.max(bb[2], r.x + R); bb[3] = Math.max(bb[3], r.z + R); });
    return {ev: ev, g: g, meshes: meshes, P: P, bb: bb, pts: pts};
  }
  function drop(id){
    var B = built[id];
    if(!B) return;
    B.meshes.forEach(function(m){ m.geometry.dispose(); });
    group.remove(B.g);
    delete built[id];
  }
  function distTo(ev, x, z){
    var best = Infinity;
    (ev.edges || []).forEach(function(id){ var E = lineOf(W, id); if(E) E.P.forEach(function(p){ best = Math.min(best, Math.hypot(p.x - x, p.z - z)); }); });
    return best;
  }
  // each frame: what is on at the local time (looked up every 5 s or 25 m), built near you and dropped far away
  function update(localMs, cam){
    var CL = HQV.cityLife;
    if(!CL || !CL.events || !W) return;
    var U = HQV.hqUnderground, under = !!(U && U.under && U.under());
    if(group.visible === under) group.visible = !under;           // [3.15] below the street: none of it
    var cx = cam && cam.x != null ? +cam.x : 0, cz = cam && cam.z != null ? +cam.z : 0, key = Math.floor(num(+localMs, 0)/5000);
    if(key === last.key && last.x != null && Math.hypot(cx - last.x, cz - last.z) < 25) return;
    last.key = key; last.x = cx; last.z = cz;
    var on = {};
    try { list = CL.events(W, +localMs) || []; } catch(e){ list = []; }
    list.forEach(function(ev){
      var d = distTo(ev, cx, cz);
      if(built[ev.id] ? d <= FAR : d <= NEAR){ on[ev.id] = 1; if(!built[ev.id]) built[ev.id] = build(ev); }
    });
    Object.keys(built).forEach(function(id){ if(!on[id]) drop(id); });
  }
  function blocked(x, z){
    if(!group.visible) return false;
    for(var id in built){
      var B = built[id], b = B.bb;
      if(x < b[0] || x > b[2] || z < b[1] || z > b[3]) continue;
      var S = B.P.solid;
      for(var i = 0; i < S.length; i++){
        var r = S[i], dx = x - r.x, dz = z - r.z, s = Math.sin(r.yaw), c = Math.cos(r.yaw);
        if(Math.abs(dx*s + dz*c) <= r.hz && Math.abs(dx*c - dz*s) <= r.hx) return true;
      }
    }
    return false;
  }
  function info(){
    var o = {events: Object.keys(built).sort(), on: list.map(function(ev){ return ev.id; }), stalls: 0, barriers: 0, cones: 0, signs: 0, plant: 0, rails: 0, flags: 0, solid: 0};
    Object.keys(built).forEach(function(id){ var P = built[id].P; ["stalls", "barriers", "cones", "signs", "plant", "rails", "flags", "solid"].forEach(function(k){ o[k] += P[k].length; }); });
    o.drawCalls = drawCalls();
    return o;
  }
  function drawCalls(){ var n = 0; for(var id in built) n += built[id].meshes.length; return group.visible ? n : 0; }
  function dispose(){
    Object.keys(built).forEach(drop);
    mat.dispose(); signMat.dispose();
    if(group.parent) group.parent.remove(group);
  }
  return {group: group, update: update, blocked: blocked, info: info, drawCalls: drawCalls, dispose: dispose};
}

HQV.cityEvents3d = {pieces: pieces, create: create, NEAR: NEAR, FAR: FAR};
})();
