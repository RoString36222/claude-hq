/* Claude HQ: opening bridges over the river (HQV.hqBridges), so the ferries (games/hqvoyage.js) sail through.
 *
 *   find(W) -> [bridge]   pure: every bridge edge's span over the river's water (worldgeom.bridgeGaps: exactly what
 *                         roadTile(.., gap) leaves out), as {id, edge, kind, a, b ({x, y, z} the gap's ends, y the
 *                         road's top), axis [dx, dz] (a -> b), left [lx, lz], len, y, width (parapet to parapet),
 *                         half, cw, walk, waterY}. kind by hash of the id: "bascule" (two leaves hinged at the
 *                         banks, rising LEAF_UP), "lift" (the span rises between four steel towers to clear LIFT_CLEAR
 *                         over the water) or "swing" (each half swings 90 deg on a drum pier at its bank, to lie along
 *                         the bank: a pier in mid-river would leave a ferry no room on a 24 m river).
 *   create(c, W, scene, opts) -> B   c: the hq3d ctx (THREE); opts.tier shows the bridges open at that city tier
 *     B.update(dt, ships)   ships [{x, z, yaw, speed}] in this city's metres: a bridge opens for a ship within OPEN_NEAR
 *                           heading for it or within HOLD_NEAR of it, stays open while one is within HOLD_NEAR and
 *                           closes CLOSE_AFTER s after the last has gone. Before it opens its lights flash and its
 *                           barrier arms come down (WARN s); it opens and closes in MOVE s (a constant-rate phase,
 *                           smoothstepped: frame-rate independent), faster when a ship would otherwise arrive first.
 *     B.open(id) -> 0..1    B.blockedAt(x, z): on a gap while its span is not fully down, or at a lowered barrier
 *     B.obstacles() -> [{x, z, r}]   for games/traffic.js at(): the inbound lanes at each lowered barrier
 *     B.list()  the bridges (find's objects)     B.state(id) {u, bar, lights}     B.dispose()
 * Each bridge is one group: the fixed parts (abutments, towers, cabins, piers, barrier posts) merged into one mesh
 * of vertex colours, every moving part (a leaf, a span, an arm) its own merged mesh, the warning lamps two meshes
 * whose materials flash in turn. Frames: the bridge's local +z runs a -> b, +x is its left, y = 0 is the road's top.
 */
(function(){
"use strict";
var root = typeof window !== "undefined" ? window : self;
var HQV = root.HQV = root.HQV || {};

var KINDS = ["bascule", "lift", "swing"];
var OPEN_NEAR = 250, HOLD_NEAR = 60, CLOSE_AFTER = 6, WARN = 5, MOVE = 8, BAR_K = 1.8, FAST_MAX = 30, BOW = 24;
var LEAF_UP = 80*Math.PI/180, LIFT_CLEAR = 14, BARRIER_AT = 9, LIFT = 0.04, KERB = 0.15;
var DECK_T = 0.9, PARA_W = 0.25, PARA_H = 0.35, RAIL_H = 1.05;
var COL = {asphalt: 0x2a2b2e, walk: 0x8f8c84, deck: 0xa6a49d, under: 0x6b6b69, rail: 0x56606a, yellow: 0xf2bd38,
           white: 0xeeeeea, concrete: 0x9a9890, dark: 0x2a2d31, steelL: 0x50707f, steelB: 0x9b3a2c, steelS: 0x3f6f4a,
           cabin: 0xe9dfc8, roof: 0x7a3b2c, glass: 0x22303d, red: 0xd02a22, wheel: 0x2b2f33, weight: 0x6d6a63};

function hashStr(s){
  var h = 0x811c9dc5;
  for(var i = 0; i < s.length; i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}
function smooth(u){ u = Math.max(0, Math.min(1, u)); return u*u*(3 - 2*u); }

/* ---------- find (pure) ---------- */
// an edge's polyline in metres with arc lengths (as worldgeom's prep: repeated points dropped)
function poly(e){
  var p = e.pts, P = [], S = [];
  for(var j = 0; j < p.length/3; j++){
    var q = {x: p[3*j]/100, y: p[3*j+1]/100, z: p[3*j+2]/100};
    if(P.length){ var L = P[P.length - 1], d = Math.hypot(q.x - L.x, q.z - L.z); if(d < 1e-6) continue; S.push(S[S.length - 1] + d); }
    else S.push(0);
    P.push(q);
  }
  return {P: P, S: S};
}
function pointAt(E, s){
  var P = E.P, S = E.S, n = P.length, j = 0;
  s = Math.max(0, Math.min(S[n - 1], s));
  while(j < n - 2 && S[j + 1] < s) j++;
  var a = P[j], b = P[j + 1], L = S[j + 1] - S[j], t = L > 0 ? (s - S[j])/L : 0;
  return {x: a.x + (b.x - a.x)*t, y: a.y + (b.y - a.y)*t, z: a.z + (b.z - a.z)*t};
}
function find(W, tier){
  var Gm = HQV.worldgeom;
  if(!W || !W.river || !Gm || !Gm.bridgeGaps) return [];
  var V = tier != null && Gm.view ? Gm.view(W, tier) : W, byId = {}, out = [];
  (V.edges || []).forEach(function(e){ byId[e.id] = e; });
  var waterY = Gm.seaY(V) + (Gm.RIVER_LIFT || 0);
  Gm.bridgeGaps(V).forEach(function(g){
    var e = byId[g.id]; if(!e) return;
    var E = poly(e);
    g.runs.forEach(function(r, k){
      var a = pointAt(E, r[0]), b = pointAt(E, r[1]), dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz);
      if(len < 2) return;
      var id = "bridge:" + g.id + (k ? ":" + k : ""), y = (a.y + b.y)/2 + LIFT;
      var edge = g.walk > 0 ? g.half : g.cw;
      out.push({id: id, edge: g.id, kind: KINDS[hashStr(id) % KINDS.length], a: {x: a.x, y: y, z: a.z}, b: {x: b.x, y: y, z: b.z},
                axis: [dx/len, dz/len], left: [dz/len, -dx/len], len: len, y: y, width: 2*(edge + PARA_W),
                half: g.half, cw: g.cw, walk: g.walk, edgeO: edge, waterY: waterY});
    });
  });
  return out;
}

/* ---------- the shared state machine (pure) ---------- */
// one bridge's motion: u the span's phase (0 down .. 1 open, constant rate), bar the arms (0 up .. 1 down, eased)
function newState(){ return {u: 0, bar: 0, hold: 0, warn: 0, active: false, flash: 0}; }
function centre(b){ return {x: (b.a.x + b.b.x)/2, z: (b.a.z + b.b.z)/2}; }
function step(b, st, dt, ships){
  dt = Math.max(0, Math.min(1, +dt || 0));
  var c = centre(b), need = false, fast = 1;
  (ships || []).forEach(function(s){
    if(!s || !isFinite(s.x) || !isFinite(s.z)) return;
    var dx = c.x - s.x, dz = c.z - s.z, d = Math.hypot(dx, dz), v = Math.abs(+s.speed || 0);
    var toward = Math.sin(+s.yaw || 0)*dx + Math.cos(+s.yaw || 0)*dz > 0;
    if(d < HOLD_NEAR) need = true;
    if(d < OPEN_NEAR && toward && v > 0.3){
      need = true;
      // its bow (half a ferry ahead) reaches the deck in eta s: what is left to do must be done by then
      var eta = Math.max(0.25, (d - b.width/2 - BOW)/v), left = Math.max(0, WARN - st.warn) + (1 - st.u)*MOVE;
      if(left > eta) fast = Math.max(fast, Math.min(FAST_MAX, left/eta));
    }
  });
  st.hold = need ? CLOSE_AFTER : Math.max(0, st.hold - dt);
  st.active = need || st.hold > 0;
  var barGoal;
  if(st.active){
    barGoal = 1;
    st.warn += dt*fast;
    if(st.warn >= WARN) st.u = Math.min(1, st.u + dt*fast/MOVE);
  } else {
    st.u = Math.max(0, st.u - dt/MOVE);
    if(st.u <= 0){ st.warn = 0; barGoal = 0; } else barGoal = 1;
  }
  st.bar += (barGoal - st.bar)*(1 - Math.exp(-BAR_K*fast*dt));
  if(Math.abs(barGoal - st.bar) < 0.002) st.bar = barGoal;
  st.lights = st.active || st.u > 0 || st.bar > 0.02;
  st.flash = st.lights ? st.flash + dt : 0;
  return st;
}

/* ---------- geometry: boxes, cylinders and beams merged with vertex colours ---------- */
function Builder(THREE){
  var parts = [], m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), s = new THREE.Vector3(1, 1, 1), p = new THREE.Vector3();
  var UPV = new THREE.Vector3(0, 1, 0);
  function add(g, col, mtx){ parts.push([g, mtx, new THREE.Color(col)]); }
  var B = {
    n: function(){ return parts.length; },
    box: function(col, w, h, d, x, y, z, rx, ry, rz){
      e.set(rx || 0, ry || 0, rz || 0); q.setFromEuler(e); p.set(x, y, z);
      add(new THREE.BoxGeometry(w, h, d), col, m4.clone().compose(p, q, s));
    },
    // a box between x0..x1, y0..y1, z0..z1
    span: function(col, x0, x1, y0, y1, z0, z1){ B.box(col, Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0), (x0 + x1)/2, (y0 + y1)/2, (z0 + z1)/2); },
    cyl: function(col, r0, r1, h, x, y, z, rx, rz, seg){
      e.set(rx || 0, 0, rz || 0); q.setFromEuler(e); p.set(x, y, z);
      add(new THREE.CylinderGeometry(r0, r1, h, seg || 12), col, m4.clone().compose(p, q, s));
    },
    // a square bar of side t from (x0, y0, z0) to (x1, y1, z1)
    beam: function(col, t, x0, y0, z0, x1, y1, z1){
      var d = new THREE.Vector3(x1 - x0, y1 - y0, z1 - z0), L = d.length();
      if(L < 1e-4) return;
      q.setFromUnitVectors(UPV, d.normalize()); p.set((x0 + x1)/2, (y0 + y1)/2, (z0 + z1)/2);
      add(new THREE.BoxGeometry(t, L, t), col, m4.clone().compose(p, q, s));
    },
    geo: function(){
      var pos = [], nor = [], cl = [];
      parts.forEach(function(it){
        var g = it[0].index ? it[0].toNonIndexed() : it[0];
        g.applyMatrix4(it[1]);
        var a = g.attributes.position.array, n = g.attributes.normal.array, c = it[2];
        for(var i = 0; i < a.length; i += 3){ pos.push(a[i], a[i+1], a[i+2]); nor.push(n[i], n[i+1], n[i+2]); cl.push(c.r, c.g, c.b); }
        if(g !== it[0]) g.dispose();
        it[0].dispose();
      });
      parts = [];
      var out = new THREE.BufferGeometry();
      out.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      out.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
      out.setAttribute("color", new THREE.Float32BufferAttribute(cl, 3));
      out.computeBoundingSphere();
      return out;
    }
  };
  return B;
}

// a stretch of deck from z0 to z1 (local, y = 0 the road's top): asphalt, sidewalks, the slab under them, the centre
// lines, parapets with a rail on posts
function deck(P, b, z0, z1, y0){
  y0 = y0 || 0;
  var cw = b.cw, e = b.edgeO, ho = e + PARA_W, et = b.walk > 0 ? KERB : 0, zm = (z0 + z1)/2, L = Math.abs(z1 - z0);
  P.span(COL.asphalt, -cw, cw, y0 - 0.5, y0, z0, z1);
  if(b.walk > 0){ P.span(COL.walk, cw, e, y0 - 0.5, y0 + KERB, z0, z1); P.span(COL.walk, -e, -cw, y0 - 0.5, y0 + KERB, z0, z1); }
  P.span(COL.under, -ho, ho, y0 - DECK_T, y0 - 0.5, z0, z1);
  [-0.15, 0.15].forEach(function(o){ P.span(COL.yellow, o - 0.05, o + 0.05, y0, y0 + 0.012, z0 + 0.3, z1 - 0.3); });
  [-1, 1].forEach(function(sg){
    P.span(COL.deck, sg*e, sg*ho, y0 - DECK_T, y0 + et + PARA_H, z0, z1);
    var mid = sg*(e + PARA_W/2);
    P.box(COL.rail, 0.08, 0.08, L, mid, y0 + et + RAIL_H - 0.04, zm);
    for(var t = 0.3; t < L; t += 3) P.box(COL.rail, 0.1, RAIL_H - PARA_H, 0.1, mid, y0 + et + PARA_H + (RAIL_H - PARA_H)/2, Math.min(z0, z1) + t);
  });
}
// an abutment under the gap's end at z (the water at +d), down into the river bed
function abutment(P, b, z, d){
  var ho = b.edgeO + PARA_W + 0.3, bot = b.waterY - b.y - 2;
  P.span(COL.concrete, -ho, ho, bot, -DECK_T - 0.02, z - d*0.6, z + d*1.4);
  P.span(COL.dark, -ho - 0.05, ho + 0.05, -DECK_T - 0.3, -DECK_T - 0.02, z + d*1.25, z + d*1.45);   // the bearing ledge
}
// a barrier post with its pair of lamps (lamp meshes are built by the caller) at side sg, z
function barrierPost(P, b, sg, z){
  var x = sg*(b.cw + 0.35), et = b.walk > 0 ? KERB : 0;
  P.box(COL.white, 0.22, 1.25, 0.22, x, et + 0.62, z);
  P.box(COL.red, 0.24, 0.12, 0.24, x, et + 0.9, z);
  P.box(COL.dark, 0.5, 0.6, 0.35, x, et + 1.0, z);           // the drive box at the arm's pivot
  P.box(COL.white, 0.12, 3.2, 0.12, sg*(b.edgeO + 0.6), et + 1.6, z);   // the lamp mast outside the walk
  P.box(COL.dark, 1.3, 0.16, 0.12, sg*(b.edgeO + 0.6), et + 2.9, z);
}
function lampsOf(P, b, z, d, which){
  var et = b.walk > 0 ? KERB : 0;
  [-1, 1].forEach(function(sg){
    var x = sg*(b.edgeO + 0.6), lx = x + (which ? 0.45 : -0.45);
    P.box(COL.red, 0.34, 0.34, 0.14, lx, et + 2.6, z - d*0.1);
  });
}
// an arm: from its pivot along -sg*x (to the road's middle), red and white bands
function armGeo(P, b, sg){
  var L = b.cw - 0.15, n = Math.max(2, Math.round(L/0.6));
  for(var i = 0; i < n; i++) P.box(i % 2 ? COL.white : COL.red, L/n, 0.12, 0.08, -sg*(L/n)*(i + 0.5), 0, 0);
  P.box(COL.dark, 0.4, 0.3, 0.2, sg*0.3, 0, 0);               // its counterweight behind the pivot
}
// an operator's cabin standing at (x, z) on a plinth from the water
function cabin(P, b, x, z){
  var bot = b.waterY - b.y - 1;
  P.span(COL.concrete, x - 1.6, x + 1.6, bot, -0.2, z - 1.6, z + 1.6);
  P.span(COL.cabin, x - 1.3, x + 1.3, -0.2, 2.6, z - 1.3, z + 1.3);
  P.span(COL.glass, x - 1.34, x + 1.34, 1.3, 2.2, z - 1.0, z + 1.0);
  P.span(COL.glass, x - 1.0, x + 1.0, 1.3, 2.2, z - 1.34, z + 1.34);
  P.box(COL.roof, 3.2, 0.25, 3.2, x, 2.72, z);
  P.cyl(COL.roof, 0.05, 2.1, 1.1, x, 3.4, z, 0, 0, 4);
}

/* ---------- create ---------- */
function create(c, W, scene, opts){
  opts = opts || {};
  var THREE = c.THREE, list = find(W, opts.tier), items = [], geos = [], mats = [];
  var M = new THREE.MeshStandardMaterial({vertexColors: true, roughness: 0.72, metalness: 0.12});
  mats.push(M);
  var group = new THREE.Group(); group.name = "bridges";
  if(scene) scene.add(group);
  function mesh(P, parent, mat, shadow){
    var g = P.geo(); geos.push(g);
    var m = new THREE.Mesh(g, mat || M); m.castShadow = shadow !== false; m.receiveShadow = true; parent.add(m); return m;
  }
  function lampMat(){
    var m = new THREE.MeshStandardMaterial({color: 0x4a1210, emissive: new THREE.Color(0xff2a14), emissiveIntensity: 0, roughness: 0.4});
    mats.push(m); return m;
  }

  list.forEach(function(b){
    var g = new THREE.Group(); g.name = "bridge-" + b.kind;
    g.position.set(b.a.x, b.y, b.a.z); g.rotation.y = Math.atan2(b.axis[0], b.axis[1]);
    group.add(g);
    var L = b.len, ho = b.edgeO + PARA_W, P = Builder(THREE), it = {b: b, g: g, st: newState(), parts: {}};
    // fixed: abutments, barrier posts, the kind's own towers / cabins / piers
    abutment(P, b, 0, 1); abutment(P, b, L, -1);
    [[-BARRIER_AT, -1], [L + BARRIER_AT, 1]].forEach(function(e){ [-1, 1].forEach(function(sg){ barrierPost(P, b, sg, e[0]); }); });
    var swingSide = hashStr(b.id + ":side") & 1 ? 1 : -1;
    if(b.kind === "bascule"){
      [0, L].forEach(function(z){ [-1, 1].forEach(function(sg){ cabin(P, b, sg*(ho + 2.0), z + (z ? 1.2 : -1.2)); }); });
    } else if(b.kind === "lift"){
      var rise = Math.max(1, LIFT_CLEAR - (b.y - DECK_T - b.waterY)), trussH = 4.2, topY = rise + trussH + 3.5, bot = b.waterY - b.y - 1.5;
      it.rise = rise;
      [-1.4, L + 1.4].forEach(function(z){
        [-1, 1].forEach(function(sg){
          var x = sg*(ho + 1.3), h = 0.9;
          [[-h, -h], [h, -h], [-h, h], [h, h]].forEach(function(o){ P.box(COL.steelL, 0.32, topY - bot, 0.32, x + o[0], (topY + bot)/2, z + o[1]); });
          P.span(COL.concrete, x - 1.6, x + 1.6, bot - 0.5, -0.3, z - 1.6, z + 1.6);
          for(var y = 0.5; y < topY - 1; y += 3){
            [[-h, h, -h, -h], [-h, h, h, h], [-h, -h, -h, h], [h, h, -h, h]].forEach(function(f){
              P.beam(COL.steelL, 0.14, x + f[0], y, z + f[2], x + f[1], y, z + f[3]);
              P.beam(COL.steelL, 0.1, x + f[0], y, z + f[2], x + f[1], y + 3, z + f[3]);
            });
          }
        });
        // the machinery house across the top, its sheaves
        P.span(COL.steelL, -(ho + 2.4), ho + 2.4, topY - 0.6, topY + 0.2, z - 1.1, z + 1.1);
        P.span(COL.cabin, -(ho + 2.2), -(ho + 0.4), topY + 0.2, topY + 2.2, z - 1.0, z + 1.0);
        P.span(COL.cabin, ho + 0.4, ho + 2.2, topY + 0.2, topY + 2.2, z - 1.0, z + 1.0);
        P.span(COL.roof, -(ho + 2.4), -(ho + 0.2), topY + 2.2, topY + 2.45, z - 1.2, z + 1.2);
        P.span(COL.roof, ho + 0.2, ho + 2.4, topY + 2.2, topY + 2.45, z - 1.2, z + 1.2);
        [-1, 1].forEach(function(sg){ P.cyl(COL.wheel, 1.0, 1.0, 0.3, sg*(ho + 0.2), topY + 0.8, z, 0, Math.PI/2, 16); });
      });
      it.topY = topY;
    } else {
      [0, L].forEach(function(z, i){
        var d = i ? -1 : 1, bot = b.waterY - b.y - 2, r = Math.max(3.2, ho*0.6);
        P.cyl(COL.concrete, r, r + 0.4, -DECK_T - 0.25 - bot, 0, (bot - DECK_T - 0.25)/2, z, 0, 0, 20);
        P.cyl(COL.dark, r - 0.4, r - 0.4, 0.3, 0, -DECK_T - 0.1, z, 0, 0, 20);                 // the rack ring
        cabin(P, b, -swingSide*(ho + 2.0), z - d*1.2);
      });
    }
    mesh(P, g);

    // lamps: two per post mast, flashing in turn
    var mA = lampMat(), mB = lampMat();
    [[-BARRIER_AT, -1], [L + BARRIER_AT, 1]].forEach(function(e){ lampsOf(P, b, e[0], e[1], 0); });
    mesh(P, g, mA, false);
    [[-BARRIER_AT, -1], [L + BARRIER_AT, 1]].forEach(function(e){ lampsOf(P, b, e[0], e[1], 1); });
    mesh(P, g, mB, false);
    it.lamps = [mA, mB];

    // arms: pivots on the posts, one each side of each end
    var et = b.walk > 0 ? KERB : 0;
    it.arms = [];
    [-BARRIER_AT, L + BARRIER_AT].forEach(function(z){
      [-1, 1].forEach(function(sg){
        var pg = new THREE.Group(); pg.position.set(sg*(b.cw + 0.35), et + 1.0, z); g.add(pg);
        armGeo(P, b, sg); mesh(P, pg);
        it.arms.push({g: pg, sg: sg});
      });
    });

    // the moving spans
    var gap = 0.03;
    if(b.kind === "bascule"){
      var Lh = L/2;
      it.leaves = [0, 1].map(function(k){
        var pg = new THREE.Group(), d = k ? -1 : 1;
        pg.position.set(0, -DECK_T, k ? L : 0); g.add(pg);
        var z0 = 0, z1 = d*(Lh - gap);
        deck(P, b, z0, z1, DECK_T);
        // the main girders under it, deepest at the heel; the counterweight tail behind the hinge
        [-1, 1].forEach(function(sg){
          var x = sg*b.cw*0.62;
          P.beam(COL.steelB, 0.35, x, -0.2, 0, x, -0.2, d*(Lh - 1));
          P.span(COL.steelB, x - 0.18, x + 0.18, -1.3, 0, 0, d*Math.min(4, Lh/3));
        });
        for(var t = 3; t < Lh - 1; t += 3) P.span(COL.steelB, -b.cw*0.62, b.cw*0.62, -0.45, -0.05, d*t - 0.12, d*t + 0.12);
        P.span(COL.weight, -ho + 0.3, ho - 0.3, -2.4, -0.1, -d*3.0, -d*0.2);
        // a red band on its tip: seen from the river when it stands up
        P.span(COL.red, -ho, ho, DECK_T + 0.02, DECK_T + 0.16, z1 - d*0.25, z1);
        mesh(P, pg);
        return {g: pg, d: d};
      });
    } else if(b.kind === "lift"){
      var sp = new THREE.Group(); g.add(sp);
      deck(P, b, gap, L - gap);
      var tr = 4.2, panels = Math.max(4, Math.round(L/5)), pl = (L - 2*gap)/panels;
      [-1, 1].forEach(function(sg){
        var x = sg*(ho + 0.2), et2 = b.walk > 0 ? KERB : 0;
        P.box(COL.steelL, 0.4, 0.45, L - 2*gap, x, et2 + 0.2, L/2);                // bottom chord
        P.box(COL.steelL, 0.4, 0.4, L - 2*gap - 2*pl, x, tr, L/2);                 // top chord
        for(var i = 0; i <= panels; i++){
          var z = gap + i*pl;
          if(i > 0 && i < panels) P.box(COL.steelL, 0.22, tr - et2 - 0.2, 0.22, x, (tr + et2 + 0.2)/2, z);
          if(i < panels){
            var zt0 = i === 0 ? z : z, zt1 = z + pl;
            if(i === 0) P.beam(COL.steelL, 0.3, x, et2 + 0.2, z, x, tr, z + pl/2 + pl/2);
            else if(i === panels - 1) P.beam(COL.steelL, 0.3, x, tr, z, x, et2 + 0.2, z + pl);
            else P.beam(COL.steelL, 0.2, x, (i % 2 ? tr : et2 + 0.2), zt0, x, (i % 2 ? et2 + 0.2 : tr), zt1);
          }
        }
      });
      for(var i2 = 1; i2 < panels; i2++) P.box(COL.steelL, 2*(ho + 0.2), 0.25, 0.25, 0, tr, gap + i2*pl);   // top bracing
      [gap + pl, L - gap - pl].forEach(function(z){ P.box(COL.yellow, 2*ho - 0.8, 0.5, 0.2, 0, tr - 0.5, z); });   // portal boards
      mesh(P, sp);
      it.span = sp;
      // counterweights in the towers, and the cables from the sheaves to the span's corners
      var cwG = new THREE.Group(); g.add(cwG);
      [-1.4, L + 1.4].forEach(function(z){ [-1, 1].forEach(function(sg){ P.box(COL.weight, 1.3, 3.2, 1.3, sg*(ho + 1.3), it.topY - 2.4, z); }); });
      mesh(P, cwG);
      it.cw = cwG;
      var cab = new THREE.Group(); cab.position.y = it.topY + 0.8; g.add(cab);
      [gap + 0.4, L - gap - 0.4].forEach(function(z){ [-1, 1].forEach(function(sg){ P.box(COL.dark, 0.07, 1, 0.07, sg*(ho + 0.2), -0.5, z); }); });
      mesh(P, cab, null, false);
      it.cables = cab; it.trussTop = tr;
    } else {
      var Lh2 = L/2;
      it.leaves = [0, 1].map(function(k){
        var pg = new THREE.Group(), d = k ? -1 : 1;
        pg.position.set(0, 0, k ? L : 0); g.add(pg);
        var z1 = d*(Lh2 - gap);
        deck(P, b, 0, z1);
        // a camelback pony truss each side, deepest over the pier
        var n = Math.max(3, Math.round(Lh2/3.5)), pl2 = (Lh2 - gap)/n, et3 = b.walk > 0 ? KERB : 0;
        function hAt(t){ return et3 + 1.2 + 2.2*(1 - t/(Lh2 - gap)); }
        [-1, 1].forEach(function(sg){
          var x = sg*(ho + 0.15);
          P.box(COL.steelS, 0.32, 0.4, Lh2 - gap, x, et3 + 0.2, z1/2);
          for(var i = 0; i < n; i++){
            var t0 = i*pl2, t1 = (i + 1)*pl2;
            P.beam(COL.steelS, 0.3, x, hAt(t0), d*t0, x, hAt(t1), d*t1);
            P.box(COL.steelS, 0.2, hAt(t0) - et3 - 0.2, 0.2, x, (hAt(t0) + et3 + 0.2)/2, d*t0);
            P.beam(COL.steelS, 0.16, x, hAt(t0), d*t0, x, et3 + 0.2, d*t1);
          }
        });
        mesh(P, pg);
        return {g: pg, d: d};
      });
      it.swingSide = swingSide;
    }
    items.push(it);
    pose(it);
  });

  function pose(it){
    var o = smooth(it.st.u), b = it.b;
    if(b.kind === "bascule") it.leaves.forEach(function(l){ l.g.rotation.x = -l.d*LEAF_UP*o; });
    else if(b.kind === "lift"){
      var r = it.rise*o;
      it.span.position.y = r; it.cw.position.y = -r;
      it.cables.scale.y = Math.max(0.05, it.topY + 0.8 - (it.trussTop + r));
    } else it.leaves.forEach(function(l){
      l.g.rotation.y = l.d*it.swingSide*(Math.PI/2)*o;
      l.g.position.y = 0.08*Math.min(1, o*12);                  // jacked up off its wedges first
    });
    var a = it.st.bar;
    it.arms.forEach(function(A){ A.g.rotation.z = -A.sg*(Math.PI/2)*(1 - a); });
    var on = it.st.lights, ph = Math.floor(it.st.flash*1.6) % 2;
    it.lamps[0].emissiveIntensity = on && !ph ? 2.4 : 0;
    it.lamps[1].emissiveIntensity = on && ph ? 2.4 : 0;
  }
  function byId(id){ for(var i = 0; i < items.length; i++) if(items[i].b.id === id) return items[i]; return null; }
  function local(b, x, z){
    var dx = x - b.a.x, dz = z - b.a.z;
    return {s: dx*b.axis[0] + dz*b.axis[1], o: dx*b.left[0] + dz*b.left[1]};
  }

  return {
    group: group,
    list: function(){ return list.slice(); },
    update: function(dt, ships){ items.forEach(function(it){ step(it.b, it.st, dt, ships); pose(it); }); },
    open: function(id){ var it = byId(id); return it ? smooth(it.st.u) : 0; },
    state: function(id){ var it = byId(id); return it ? {u: it.st.u, bar: it.st.bar, lights: !!it.st.lights, active: it.st.active} : null; },
    blockedAt: function(x, z){
      for(var i = 0; i < items.length; i++){
        var it = items[i], b = it.b;
        if(it.st.u <= 0 && it.st.bar < 0.5) continue;
        var p = local(b, x, z);
        if(Math.abs(p.o) > b.width/2 + 0.3) continue;
        if(it.st.u > 0 && p.s >= -0.3 && p.s <= b.len + 0.3) return true;
        if(it.st.bar >= 0.5 && Math.abs(p.o) <= b.cw && (Math.abs(p.s + BARRIER_AT) < 0.4 || Math.abs(p.s - b.len - BARRIER_AT) < 0.4)) return true;
      }
      return false;
    },
    // the inbound half of the road at each barrier that is down or coming down (traffic drives on the right)
    obstacles: function(){
      var out = [];
      items.forEach(function(it){
        var b = it.b;
        if(!(it.st.bar > 0.05 || it.st.u > 0)) return;
        [[-BARRIER_AT - 0.8, -1], [b.len + BARRIER_AT + 0.8, 1]].forEach(function(e){
          for(var o = 0.6; o <= b.cw - 0.3; o += 1.0){
            var lo = e[1]*o;    // inbound from a's side drives +axis, its right is -left; from b's side the other way
            out.push({x: b.a.x + b.axis[0]*e[0] + b.left[0]*lo, z: b.a.z + b.axis[1]*e[0] + b.left[1]*lo, r: 0.3});
          }
        });
      });
      return out;
    },
    dispose: function(){
      if(group.parent) group.parent.remove(group);
      geos.forEach(function(x){ x.dispose(); }); mats.forEach(function(m){ m.dispose(); });
      geos = []; mats = []; items = [];
    }
  };
}

HQV.hqBridges = {find: find, create: create, step: step, newState: newState, KINDS: KINDS,
                 OPEN_NEAR: OPEN_NEAR, HOLD_NEAR: HOLD_NEAR, CLOSE_AFTER: CLOSE_AFTER, WARN: WARN, MOVE: MOVE, LIFT_CLEAR: LIFT_CLEAR};
})();
