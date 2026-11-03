/* Claude HQ: HQ growth (HQ 3.37), a township that grows with its owner's Claude work. Plain JS, no build step.
 *
 * Every township (City Gen v5 HQ lot) has two neighbouring plots reserved beside it on its street (the doc's lot.annex:
 * the first past its way out, the second past its way in). Its owner's worker-hours (the Arena's build, hqwork.rs:
 * {pts, lots, stages}) add them one at a time: a plot added starts at bare ground and climbs foundations, buildings,
 * amenities and a landmark, then the next plot is added. Its wall moves out round every plot it has (groundRing). Every
 * live Claude session (crew.working + crew.needs) is a builder on the plot being built: a hard hat and a hi-vis vest,
 * carrying planks from the site's store or hammering at the work, under a tower crane while there is building to do.
 * A plot not yet added is fenced off: "Room to grow".
 *
 * Pure (tested under node, tests/test_hq_growth.py): buildOf, annexRings, groundRing, activeSite, sitePlan, crewPlan,
 * crewAt. Drawn (three.js, the City's c): siteBuild (static: merged with its lot), crewBuild (the builders and the
 * crane: animated, never merged) and crewStep. Deterministic (mulberry32 over the owner's id: the same plan every visit); Calm
 * or reduced motion: the builders stand at their work and the crane holds still. Every word drawn is on a canvas. */
(function(){
"use strict";
var HQV = window.HQV = window.HQV || {};

var STAGES = ["bare ground", "foundations", "buildings", "amenities", "landmark"];
var ANNEXES = 2;          // the plots a township may add (the Arena's hqwork ANNEXES, the generator's lot.annex)
var CREW_MAX = 8;         // builders drawn on one site at most (a busy owner's live sessions past this still count, unseen)
var CREW_NEAR = 160;      // builders and crane drawn only within this (m) of the camera
var SITE_IN = 3;          // what a plot holds stands this far (m) inside its outline (its fence or the township's wall)
var WALK = 1.3;           // a builder's walking speed (m/s)
var LANDMARKS = ["clock", "spire", "dome"];
var PI = Math.PI;

function mulberry32(a){ return function(){ a = (a + 0x6D2B79F5) | 0; var t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0)/4294967296; }; }
function hashStr(s){ var h = 2166136261 >>> 0; s = String(s == null ? "" : s); for(var i = 0; i < s.length; i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h >>> 0; }
function rngOf(k){ return mulberry32(hashStr(k)); }
function whole(v, lo, hi, d){ return typeof v === "number" && isFinite(v) && Math.floor(v) === v ? Math.max(lo, Math.min(hi, v)) : d; }

// An HQ's build from the Arena's listing (h.build), checked: {pts, lots: 1..3, stages: [-1..4, -1..4]}; none (an older
// Arena, or no work reported yet): one lot, nothing added. A later plot is never ahead of an earlier one.
function buildOf(h){
  var b = h && h.build, out = {pts: 0, lots: 1, stages: [-1, -1]};
  if(!b || typeof b !== "object") return out;
  out.pts = whole(b.pts, 0, 1e6, 0);
  var st = Array.isArray(b.stages) ? b.stages : [];
  for(var k = 0; k < ANNEXES; k++){ var s = whole(st[k], -1, 4, -1); out.stages[k] = k > 0 && out.stages[k - 1] < 4 ? -1 : s; }
  out.lots = 1 + out.stages.filter(function(s){ return s >= 0; }).length;
  return out;
}
// the doc's lot.annex outlines (cm, world) in the lot's frame for a lot placed at p ({x, z, rot}, m): [ring | null] by plot
function annexRings(lot, p){
  if(!lot || !Array.isArray(lot.annex) || !p) return [];
  var cr = Math.cos(p.rot || 0), sr = Math.sin(p.rot || 0);
  return lot.annex.slice(0, ANNEXES).map(function(a){
    var P = a && Array.isArray(a.poly) ? a.poly : null;
    if(!P || P.length < 3 || !P.every(function(q){ return q && isFinite(+q[0]) && isFinite(+q[1]); })) return null;
    return P.map(function(q){ var dx = q[0]/100 - p.x, dz = q[1]/100 - p.z; return [dx*cr - dz*sr, dx*sr + dz*cr]; });
  });
}
function bounds(R){
  var b = {x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity};
  (R || []).forEach(function(q){ b.x0 = Math.min(b.x0, q[0]); b.x1 = Math.max(b.x1, q[0]); b.z0 = Math.min(b.z0, q[1]); b.z1 = Math.max(b.z1, q[1]); });
  return b;
}
// The township's ground in its frame: its lot R and the plots it has added (the first n of rings) as one rectangle, the
// outline its wall runs round (hqcityparts townPlan reads its bounds); R itself with none added
function groundRing(R, rings, n){
  if(!R || R.length < 3) return R;
  var all = R.slice(), k;
  for(k = 0; k < Math.min(n | 0, (rings || []).length); k++) if(rings[k]) all = all.concat(rings[k]);
  if(all.length === R.length) return R;
  var b = bounds(all);
  return [[b.x0, b.z1], [b.x1, b.z1], [b.x1, b.z0], [b.x0, b.z0]];
}
// Where the builders work: the first added plot not yet at its landmark ("build"); with none added, the first plot,
// being cleared ("clear"); with every added one finished, the last added, kept up ("tend"). -> {k, mode}
function activeSite(B){
  B = B || buildOf(null);
  for(var k = 0; k < ANNEXES; k++) if(B.stages[k] >= 0 && B.stages[k] < 4) return {k: k, mode: "build"};
  if(B.stages[0] < 0) return {k: 0, mode: "clear"};
  return {k: Math.max(0, B.lots - 2), mode: "tend"};
}

/* A plot's plan at a stage, in the lot's frame (m) on its outline R: {items, spots, store, blocks, crane}. stage -1: not
   yet added (gravel, a rope fence on its open sides, a "Room to grow" sign); 0 bare ground (survey pegs and lines where
   its buildings will stand, a site hut, pallets); 1 foundations (a slab with rebar under each); 2 buildings; 3 amenities
   (lawn, paths, trees, benches, lamps, a pond in the middle); 4 its landmark in the middle (a clock tower, a spire or a
   glass dome, by its owner's seed). o: {seed (the owner's id and the plot), side (+1: the plot is on the township's +x
   side, so its open side is +x), active (the builders' site: a crane while there is building to do, scaffolds round the
   buildings going up)}. Items: {kind, x, z, w?, d?, h?, ...}; spots: where a builder works [[x, z, yaw]]; store: the
   pallets they carry from [x, z]; blocks: what you walk into [x, z, 0, hx, hz]. */
function sitePlan(R, stage, o){
  o = o || {};
  var out = {items: [], spots: [], store: null, blocks: [], crane: null};
  if(!R || R.length < 3) return out;
  stage = whole(stage, -1, 4, -1);
  var b = bounds(R), m = SITE_IN, x0 = b.x0 + m, x1 = b.x1 - m, z0 = b.z0 + m, z1 = b.z1 - m - 1;   // (a metre more off its street wall)
  if(!(x1 - x0 > 10 && z1 - z0 > 10)) return out;
  var side = o.side === -1 ? -1 : 1, rnd = rngOf("hqgrowth:" + (o.seed || "") ), cx = (x0 + x1)/2, cz = (z0 + z1)/2;
  var W = x1 - x0, D = z1 - z0;
  function item(it){ out.items.push(it); return it; }
  function block(x, z, hx, hz){ out.blocks.push([x, z, 0, hx, hz]); }
  // the plot's buildings: two at its back corners, one at the front on its open side (sizes and floors by the seed)
  var bl = [];
  [[-1, 0], [1, 0], [side, 1]].forEach(function(q, i){
    var w = i < 2 ? Math.min(W*0.36, 15 + rnd()*4) : Math.min(W*0.3, 11 + rnd()*3), d = i < 2 ? 13 + rnd()*4 : 10 + rnd()*3;
    var x = q[0] < 0 ? x0 + w/2 : x1 - w/2, z = q[1] ? z1 - 4 - d/2 : z0 + d/2;
    bl.push({x: x, z: z, w: w, d: d, h: 3.2*(i < 2 ? 3 + Math.floor(rnd()*3) : 2 + Math.floor(rnd()*2)), hue: Math.floor(rnd()*4)});
  });
  var mid = {x: cx - side*4, z: cz + 2};                 // the middle: a pond, then the landmark (clear of the three)
  var land = LANDMARKS[Math.floor(rnd()*LANDMARKS.length) % LANDMARKS.length];
  out.store = [cx + side*2, z0 + 3.5];
  if(stage < 0){
    item({kind: "ground", x: cx, z: cz, w: W + 2*m, d: D + 2*m + 1, col: "gravel"});
    // the rope fence on its three open sides (the fourth is the township's wall, or another plot): posts 4 m apart
    var fx = side > 0 ? b.x1 - 0.4 : b.x0 + 0.4, f;
    for(f = b.z0 + 0.4; f <= b.z1 - 0.4 + 1e-6; f += 4) item({kind: "post", x: fx, z: f});
    for(f = Math.min(b.x0, b.x1) + 0.4; f <= b.x1 - 0.4 + 1e-6; f += 4){ item({kind: "post", x: f, z: b.z1 - 0.4}); item({kind: "post", x: f, z: b.z0 + 0.4}); }
    item({kind: "rope", x0: b.x0 + 0.4, x1: b.x1 - 0.4, z0: b.z0 + 0.4, z1: b.z1 - 0.4, open: side});
    item({kind: "sign", x: cx, z: b.z1 - 1.6, text: "ROOM TO GROW"});
    block(cx, b.z1 - 1.6, 1.4, 0.2);
    out.spots = bl.map(function(B){ return [B.x, B.z + B.d/2 + 1.2, 0]; });
    return out;
  }
  item({kind: "ground", x: cx, z: cz, w: W + 2*m, d: D + 2*m + 1, col: stage <= 1 ? "dirt" : stage === 2 ? "paved" : "lawn"});
  if(stage <= 1){
    // the site hut and its pallets (the builders' store)
    item({kind: "hut", x: cx + side*(W/2 - 6), z: cz + 2, w: 5, d: 2.6, h: 2.6}); block(cx + side*(W/2 - 6), cz + 2, 2.6, 1.4);
    item({kind: "pallets", x: out.store[0], z: out.store[1]}); block(out.store[0], out.store[1], 1.0, 0.7);
  }
  bl.forEach(function(B, i){
    if(stage === 0){
      // survey pegs at its corners, the lines between them
      [[-1, -1], [1, -1], [1, 1], [-1, 1]].forEach(function(s){ item({kind: "peg", x: B.x + s[0]*B.w/2, z: B.z + s[1]*B.d/2}); });
      item({kind: "lines", x: B.x, z: B.z, w: B.w, d: B.d});
      out.spots.push([B.x + (i % 2 ? -1 : 1)*B.w/2, B.z + B.d/2 + 0.8, PI]);
    } else if(stage === 1){
      item({kind: "slab", x: B.x, z: B.z, w: B.w, d: B.d, h: 0.5}); block(B.x, B.z, B.w/2, B.d/2);
      item({kind: "rebar", x: B.x, z: B.z, w: B.w, d: B.d});
      out.spots.push([B.x, B.z + B.d/2 + 0.9, PI], [B.x - B.w/2 - 0.9, B.z, PI/2]);
    } else {
      item({kind: "building", x: B.x, z: B.z, w: B.w, d: B.d, h: B.h, hue: B.hue, door: 1}); block(B.x, B.z, B.w/2, B.d/2);
      if(o.active && stage === 2) item({kind: "scaffold", x: B.x, z: B.z, w: B.w, d: B.d, h: B.h});
      out.spots.push([B.x + (i % 2 ? -1 : 1)*(B.w/2 - 2), B.z + B.d/2 + 1.6, PI]);
    }
  });
  if(stage === 1){ item({kind: "mixer", x: cx - side*3, z: z0 + 4}); block(cx - side*3, z0 + 4, 1.1, 1.1); }
  if(stage >= 3){
    item({kind: "path", x: cx, z: (mid.z + z1)/2 + 1, w: 3, d: z1 - mid.z + 2});
    for(var t = 0; t < 6; t++){ var tx = x0 + 2 + (W - 4)*(t + 0.5)/6; item({kind: "tree", x: tx, z: z1 - 1.2 + (rnd() - 0.5)*0.4, h: 4.5 + rnd()*2, cone: rnd() < 0.35}); }
    [[-3.4, 0], [3.4, 0]].forEach(function(q){ item({kind: "bench", x: mid.x + q[0], z: mid.z + 6.5, yaw: 0}); block(mid.x + q[0], mid.z + 6.5, 0.9, 0.3); });
    [[-6, 6], [6, 6]].forEach(function(q){ item({kind: "lamp", x: mid.x + q[0], z: mid.z + q[1]}); });
    if(stage === 3){ item({kind: "pond", x: mid.x, z: mid.z, r: 4.2}); out.blocks.push([mid.x, mid.z, 4.2]); }
  }
  if(stage >= 4){
    item({kind: "plaza", x: mid.x, z: mid.z, r: 6});
    item({kind: "landmark", x: mid.x, z: mid.z, style: land, h: land === "spire" ? 26 : land === "clock" ? 18 : 9});
    out.blocks.push([mid.x, mid.z, land === "dome" ? 4.6 : 2.4]);
    out.spots.push([mid.x + 5, mid.z + 5, -PI*0.75]);
  }
  if(stage >= 3 && !out.spots.length) out.spots.push([mid.x, mid.z + 7.5, PI]);
  // the tower crane: at the back, between the two back buildings, while the plot is being built (not at its landmark)
  if(o.active && stage < 4){ out.crane = {x: cx, z: z0 + 2.4, h: 22 + Math.round(rnd()*6), jib: 18}; block(cx, z0 + 2.4, 1.1, 1.1); }
  return out;
}
// The builders: n of them (the HQ's live sessions, at most CREW_MAX) on a site's plan: the odd ones hammer at a work spot,
// the even ones carry from the store to one and back. Deterministic by the owner's seed. -> [{role, spot: [x, z, yaw], from,
// phase, skin}]
var SKIN = [0xf1c7a3, 0xd9a273, 0xa86b45, 0x6e4529, 0xe8b894];
function crewPlan(n, plan, seed){
  n = Math.max(0, Math.min(CREW_MAX, n | 0));
  var out = [], spots = plan && plan.spots && plan.spots.length ? plan.spots : null;
  if(!spots) return out;
  var r = rngOf("hqcrew:" + (seed || "")), store = plan.store || [spots[0][0], spots[0][1] - 4];
  for(var i = 0; i < n; i++){
    var s = spots[i % spots.length], off = Math.floor(i/spots.length)*1.4;
    var at = [s[0] + Math.cos(s[2] || 0)*off, s[1], s[2] || 0];
    out.push({role: i % 2 ? "hammer" : "carry", spot: at, from: store, phase: r()*10, skin: SKIN[Math.floor(r()*SKIN.length) % SKIN.length]});
  }
  return out;
}
// Where a builder is at time t (s): {x, z, yaw, walk (0..1 the stride), swing (0..1 the hammer), load (carrying)}. A carrier
// walks store -> spot with a plank, pauses 2 s, walks back empty, pauses 1.5 s; a hammerer stands at its spot and swings.
// calm: at the spot, still.
function crewAt(w, t, calm){
  var s = w.spot, out = {x: s[0], z: s[1], yaw: s[2] || 0, walk: 0, swing: 0, load: false};
  if(calm) return out;
  t = (+t || 0) + w.phase;
  if(w.role === "hammer"){ out.swing = 0.5 - 0.5*Math.cos(t*2*PI*1.4); return out; }
  var f = w.from, dx = s[0] - f[0], dz = s[1] - f[1], L = Math.hypot(dx, dz) || 1, go = L/WALK, T = 2*go + 3.5, u = ((t % T) + T) % T;
  var k, back = false;
  if(u < go) k = u/go; else if(u < go + 2) k = 1; else if(u < 2*go + 2){ k = 1 - (u - go - 2)/go; back = true; } else k = 0;
  var moving = (u < go) || (u >= go + 2 && u < 2*go + 2);
  out.x = f[0] + dx*k; out.z = f[1] + dz*k;
  out.yaw = moving ? Math.atan2(back ? -dx : dx, back ? -dz : dz) : (k >= 1 ? s[2] || 0 : Math.atan2(dx, dz));
  out.walk = moving ? 0.5 - 0.5*Math.cos(u*2*PI*1.6) : 0;
  out.load = !back && u < go + 2;
  return out;
}

/* ---------- drawn ---------- */
var GROUND_COL = {gravel: 0x9a948a, dirt: 0x8a6a4a, paved: 0xb9b4aa, lawn: 0x5f9a4a};
var BLD_COL = [0xd9cbb3, 0xc4d2dc, 0xe0c9c0, 0xcfd8c4];
// A plot's plan (sitePlan) into g (the lot's group, its frame; the caller merges it). y: the lot's ground there. -> {blocks}
function siteBuild(c, g, P, y){
  var THREE = c.THREE, mat = c.mat, Y = y || 0.03;
  if(!P || !P.items) return {blocks: []};
  var M = {};
  function m(k, col, o){ return M[k] || (M[k] = mat(col, o || {roughness: 0.85})); }
  function plane(w, d, mt, x, z, h){ var q = new THREE.Mesh(new THREE.PlaneGeometry(w, d), mt); q.rotation.x = -PI/2; q.position.set(x, Y + (h || 0), z); q.receiveShadow = true; g.add(q); return q; }
  function disc(r, mt, x, z, h){ var q = new THREE.Mesh(new THREE.CircleGeometry(r, 24), mt); q.rotation.x = -PI/2; q.position.set(x, Y + (h || 0), z); g.add(q); return q; }
  function cylr(rt, rb, h, mt, x, y0, z, seg){ var q = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg || 10), mt); q.position.set(x, y0, z); q.castShadow = true; g.add(q); return q; }
  P.items.forEach(function(it){
    var k = it.kind;
    if(k === "ground") plane(it.w, it.d, m("g:" + it.col, GROUND_COL[it.col] || 0x9a948a), it.x, it.z, 0.005);
    else if(k === "post") c.box(0.12, 1.0, 0.12, m("post", 0x6b5a45), it.x, Y + 0.5, it.z, g);
    else if(k === "rope"){
      var rm = m("rope", 0xd23a2e, {roughness: 0.6}), xo = it.open > 0 ? it.x1 : it.x0;
      c.box(it.x1 - it.x0, 0.05, 0.05, rm, (it.x0 + it.x1)/2, Y + 0.85, it.z1, g);
      c.box(it.x1 - it.x0, 0.05, 0.05, rm, (it.x0 + it.x1)/2, Y + 0.85, it.z0, g);
      c.box(0.05, 0.05, it.z1 - it.z0, rm, xo, Y + 0.85, (it.z0 + it.z1)/2, g);
    } else if(k === "sign"){
      var T = signTex(c, it.text), face = T.m || (T.m = new c.THREE.MeshBasicMaterial({map: T.t, toneMapped: false}));
      c.box(0.12, 1.6, 0.12, m("post", 0x6b5a45), it.x - 1.2, Y + 0.8, it.z, g); c.box(0.12, 1.6, 0.12, m("post", 0x6b5a45), it.x + 1.2, Y + 0.8, it.z, g);
      [1, -1].forEach(function(s){ var f = new THREE.Mesh(new THREE.PlaneGeometry(2.8, 0.7), face); f.position.set(it.x, Y + 1.5, it.z + s*0.03); if(s < 0) f.rotation.y = PI; g.add(f); });
    } else if(k === "hut"){
      c.box(it.w, it.h, it.d, m("hut", 0x2f6fb0, {roughness: 0.6, metalness: 0.2}), it.x, Y + it.h/2, it.z, g);
      c.box(it.w + 0.2, 0.12, it.d + 0.2, m("hutroof", 0xe9e4d8), it.x, Y + it.h + 0.06, it.z, g);
    } else if(k === "pallets"){
      c.box(1.8, 0.3, 1.2, m("pallet", 0xb08a5a), it.x, Y + 0.15, it.z, g);
      c.box(1.6, 0.5, 1.0, m("plank", 0xd8b98a), it.x, Y + 0.55, it.z, g);
    } else if(k === "peg") c.box(0.08, 0.6, 0.08, m("peg", 0xff7a1a), it.x, Y + 0.3, it.z, g);
    else if(k === "lines"){
      var lm = m("line", 0xf4f1ea);
      [[0, 1], [0, -1]].forEach(function(q){ c.box(it.w, 0.02, 0.03, lm, it.x, Y + 0.25, it.z + q[1]*it.d/2, g); });
      [[1, 0], [-1, 0]].forEach(function(q){ c.box(0.03, 0.02, it.d, lm, it.x + q[0]*it.w/2, Y + 0.25, it.z, g); });
    } else if(k === "slab") c.box(it.w, it.h, it.d, m("slab", 0xa9a59c), it.x, Y + it.h/2, it.z, g);
    else if(k === "rebar"){
      var bm = m("rebar", 0x7a3f25, {roughness: 0.5, metalness: 0.6});
      for(var rx = -it.w/2 + 1; rx <= it.w/2 - 1 + 1e-6; rx += 3) [-1, 1].forEach(function(s){ c.box(0.06, 1.4, 0.06, bm, it.x + rx, Y + 1.2, it.z + s*(it.d/2 - 0.6), g); });
    } else if(k === "building"){
      var wm = m("bld" + it.hue, BLD_COL[it.hue % BLD_COL.length], {roughness: 0.75}), gm = m("glass", 0x5b7f99, {roughness: 0.2, metalness: 0.4});
      c.box(it.w, it.h, it.d, wm, it.x, Y + it.h/2, it.z, g);
      for(var fl = 1; fl*3.2 < it.h; fl++) c.box(it.w + 0.04, 1.3, it.d + 0.04, gm, it.x, Y + fl*3.2 - 1.2, it.z, g);   // window bands
      c.box(it.w + 0.3, 0.3, it.d + 0.3, m("coping", 0x6b7078), it.x, Y + it.h + 0.15, it.z, g);
    } else if(k === "scaffold"){
      var sm = m("scaf", 0xc7ccd1, {roughness: 0.4, metalness: 0.7}), dm = m("deck", 0xb08a5a);
      [-1, 1].forEach(function(s){ for(var sx = -it.w/2; sx <= it.w/2 + 1e-6; sx += it.w/3) c.box(0.08, it.h + 1, 0.08, sm, it.x + sx, Y + (it.h + 1)/2, it.z + s*(it.d/2 + 1), g); });
      for(var lv = 2; lv < it.h; lv += 3.2) [-1, 1].forEach(function(s){ c.box(it.w, 0.06, 0.9, dm, it.x, Y + lv, it.z + s*(it.d/2 + 0.6), g); });
    } else if(k === "mixer"){
      var mm = m("mixer", 0xff9a1f, {roughness: 0.5}); cylr(0.7, 0.9, 1.4, mm, it.x, Y + 1.2, it.z); c.box(1.4, 0.5, 1.6, m("mixbase", 0x3a3f45), it.x, Y + 0.25, it.z, g);
    } else if(k === "path") plane(it.w, it.d, m("path", 0xd8cfbf), it.x, it.z, 0.012);
    else if(k === "plaza") disc(it.r, m("plaza", 0xe6e0d4), it.x, it.z, 0.014);
    else if(k === "tree"){
      cylr(0.18, 0.22, it.h*0.45, m("bark", 0x5b4331), it.x, Y + it.h*0.225, it.z, 6);
      var leaf = m("leaf", 0x3f8a4f);
      if(it.cone) cylr(0, 1.5, it.h*0.7, leaf, it.x, Y + it.h*0.6, it.z, 8);
      else { var s2 = new THREE.Mesh(new THREE.SphereGeometry(1.6, 8, 6), leaf); s2.position.set(it.x, Y + it.h*0.7, it.z); s2.castShadow = true; g.add(s2); }
    } else if(k === "bench"){ c.box(1.8, 0.1, 0.5, m("benchw", 0x8a5a3a), it.x, Y + 0.45, it.z, g); c.box(1.8, 0.45, 0.08, m("benchw", 0x8a5a3a), it.x, Y + 0.7, it.z + 0.22, g); }
    else if(k === "lamp"){ cylr(0.06, 0.08, 3.6, m("lampp", 0x2a3139, {metalness: 0.6, roughness: 0.4}), it.x, Y + 1.8, it.z, 6); c.box(0.4, 0.2, 0.4, m("lampb", 0xffe3b0, {emissive: new THREE.Color(0xffd9a0), emissiveIntensity: 0.6}), it.x, Y + 3.7, it.z, g); }
    else if(k === "pond"){ disc(it.r + 0.5, m("rim", 0xb9b3a8), it.x, it.z, 0.016); disc(it.r, m("water", 0x3f7fa8, {roughness: 0.1, metalness: 0.2}), it.x, it.z, 0.03); }
    else if(k === "landmark") landmark(c, g, it, Y, m);
  });
  return {blocks: P.blocks || []};
}
function landmark(c, g, it, Y, m){
  var THREE = c.THREE, stone = m("lm", 0xece8e0, {roughness: 0.4}), gold = m("lmgold", 0xd8b34a, {metalness: 0.9, roughness: 0.25});
  c.box(4.4, 0.8, 4.4, stone, it.x, Y + 0.4, it.z, g);
  if(it.style === "clock"){
    c.box(3, it.h, 3, stone, it.x, Y + 0.8 + it.h/2, it.z, g);
    [[0, 1.52, 0], [0, -1.52, PI], [1.52, 0, PI/2], [-1.52, 0, -PI/2]].forEach(function(q){
      var f = new THREE.Mesh(new THREE.CircleGeometry(1.1, 24), m("face", 0xf8f4e8, {roughness: 0.3})); f.position.set(it.x + q[0], Y + it.h - 1.6, it.z + q[1]); f.rotation.y = q[2]; g.add(f); });
    var cap = new THREE.Mesh(new THREE.ConeGeometry(2.3, 3.2, 4), gold); cap.position.set(it.x, Y + 0.8 + it.h + 1.6, it.z); cap.rotation.y = PI/4; g.add(cap);
  } else if(it.style === "spire"){
    var s = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 1.8, it.h, 8), stone); s.position.set(it.x, Y + 0.8 + it.h/2, it.z); s.castShadow = true; g.add(s);
    var o = new THREE.Mesh(new THREE.SphereGeometry(0.7, 12, 8), gold); o.position.set(it.x, Y + 0.8 + it.h + 0.5, it.z); g.add(o);
  } else {
    var d = new THREE.Mesh(new THREE.SphereGeometry(4.2, 20, 10, 0, 2*PI, 0, PI/2), m("dome", 0x9fd6ee, {roughness: 0.05, metalness: 0.3, transparent: true, opacity: 0.75}));
    d.position.set(it.x, Y + 0.8, it.z); g.add(d);
    var t = new THREE.Mesh(new THREE.SphereGeometry(1.2, 10, 8), m("lmtree", 0x3f8a4f)); t.position.set(it.x, Y + 2.2, it.z); g.add(t);
  }
}
var SIGNTEX = {};
function signTex(c, text){
  if(SIGNTEX.c !== c) SIGNTEX = {c: c};
  if(SIGNTEX[text]) return SIGNTEX[text];
  return (SIGNTEX[text] = c.canvasTex(512, 128, function(x){
    x.fillStyle = "#13202c"; x.fillRect(0, 0, 512, 128); x.fillStyle = "#ffd21f"; x.fillRect(0, 0, 512, 10); x.fillRect(0, 118, 512, 10);
    x.fillStyle = "#f4f1ea"; x.font = "800 52px system-ui, sans-serif"; x.textAlign = "center"; x.textBaseline = "middle"; x.fillText(String(text).slice(0, 24), 256, 66);
  }));
}
// The builders (crewPlan) and the crane (plan.crane) into a group of their own (animated: never merged), in the lot's frame
// at y. -> {g, men: [{w, g, legs, arm, plank}], crane: {jib} | null}
function crewBuild(c, plan, crew, y){
  var THREE = c.THREE, mat = c.mat, g = new THREE.Group(), Y = y || 0.03, out = {g: g, men: [], crane: null};
  var vest = mat(0xff7a1a, {roughness: 0.7}), hat = mat(0xffd21f, {roughness: 0.4}), dark = mat(0x2a3139, {roughness: 0.8}), wood = mat(0xd8b98a);
  (crew || []).forEach(function(w){
    var man = new THREE.Group(), skin = mat(w.skin, {roughness: 0.8});
    var legs = [-0.12, 0.12].map(function(x){ var L = new THREE.Group(); L.position.set(x, 0.85, 0); c.box(0.16, 0.85, 0.18, dark, 0, -0.42, 0, L); man.add(L); return L; });
    c.box(0.46, 0.62, 0.26, vest, 0, 1.17, 0, man);
    var head = new THREE.Mesh(new THREE.SphereGeometry(0.15, 10, 8), skin); head.position.set(0, 1.62, 0); man.add(head);
    var hh = new THREE.Mesh(new THREE.SphereGeometry(0.18, 10, 6, 0, 2*PI, 0, PI/2), hat); hh.position.set(0, 1.66, 0); man.add(hh);
    c.box(0.42, 0.03, 0.42, hat, 0, 1.66, 0.03, man);
    var arm = new THREE.Group(); arm.position.set(0.3, 1.42, 0); c.box(0.12, 0.6, 0.12, vest, 0, -0.3, 0, arm); man.add(arm);
    if(w.role === "hammer"){ c.box(0.05, 0.36, 0.05, dark, 0, -0.62, 0.12, arm); c.box(0.12, 0.08, 0.2, dark, 0, -0.78, 0.2, arm); }
    var plank = w.role === "carry" ? c.box(0.2, 0.08, 2.4, wood, 0, 1.95, 0, man) : null;
    g.add(man); out.men.push({w: w, g: man, legs: legs, arm: arm, plank: plank});
  });
  if(plan && plan.crane){
    var C = plan.crane, steel = mat(0xffc21f, {roughness: 0.5, metalness: 0.3}), cg = new THREE.Group(); cg.position.set(C.x, Y, C.z); g.add(cg);
    c.box(1.2, C.h, 1.2, steel, 0, C.h/2, 0, cg);
    var jib = new THREE.Group(); jib.position.set(0, C.h, 0); cg.add(jib);
    c.box(0.8, 0.8, C.jib + 6, steel, 0, 0.4, C.jib/2 - 3, jib);
    c.box(1.6, 1.4, 2, dark, 0, -0.4, -4.2, jib);                                 // its counterweight
    c.box(1.5, 1.4, 1.5, mat(0xe9e4d8), 0.9, -0.5, 0.8, jib);                      // its cab
    c.box(0.04, C.h*0.6, 0.04, dark, 0, -C.h*0.3, C.jib*0.7, jib);                 // the hook's line
    out.crane = {jib: jib};
  }
  return out;
}
// One frame: each builder where crewAt puts it (stride, swing, plank), the crane's jib slewing slowly; calm: still
function crewStep(C, t, calm){
  if(!C) return;
  C.men.forEach(function(M){
    var a = crewAt(M.w, t, calm);
    M.g.position.set(a.x, 0.03, a.z); M.g.rotation.y = a.yaw;
    M.legs[0].rotation.x = (a.walk - 0.5)*0.9*(a.walk ? 1 : 0); M.legs[1].rotation.x = -M.legs[0].rotation.x;
    M.arm.rotation.x = M.w.role === "hammer" ? -0.4 - a.swing*1.6 : a.load ? -2.6 : (a.walk - 0.5)*0.6;
    if(M.plank) M.plank.visible = a.load;
  });
  if(C.crane) C.crane.jib.rotation.y = calm ? 0.6 : 0.6 + Math.sin((+t || 0)*0.08)*1.1;
}
// The words under an HQ's name for its growth: "2 lots · buildings" (none on one lot with nothing added)
function growthText(B){
  B = B || buildOf(null);
  var A = activeSite(B), s = B.stages[A.k];
  if(B.lots <= 1) return "";
  return B.lots + " lots · " + (A.mode === "tend" ? "complete" : STAGES[Math.max(0, s)]);
}

HQV.hqGrowth = {STAGES: STAGES, ANNEXES: ANNEXES, CREW_MAX: CREW_MAX, CREW_NEAR: CREW_NEAR, LANDMARKS: LANDMARKS,
  buildOf: buildOf, annexRings: annexRings, groundRing: groundRing, activeSite: activeSite, sitePlan: sitePlan,
  crewPlan: crewPlan, crewAt: crewAt, siteBuild: siteBuild, crewBuild: crewBuild, crewStep: crewStep, growthText: growthText};
})();
