/* Claude HQ: the ships (HQV.hqShips): the ferry, the cruise ship and the container ship.
 *
 *   ferry(c, opts) -> F   c: the hq3d ctx (THREE, mat); opts {name, funnel (hex)}
 *     F.g        the group: origin on the waterline at the hull's middle, forward +z, model +x is LEFT (port)
 *     F.seats    [Object3D]: benches on the open sun deck, a rider sits at seat.position (facing +z)
 *     F.update(dt, speed (m/s), night (bool))   the wake's flow and strength, the window glow
 *     F.clone()  another ferry sharing every geometry and material (the wake keeps its own)
 *     F.dispose()
 * Every part is merged by material (hull, white, deck, glass, funnel, dark, lifeboats, lights): about ten
 * draw calls a ship. Sizes: 38 m long, 10 m beam, the main deck 3 m over the water, the sun deck at 5.6 m.
 *
 *   cruise(c, opts) -> the same API: 120 m, 21 m beam, seven decks of balconies over a white hull, the pool deck
 *     on top (CRUISE.POOL m) with coloured loungers (its seats), a raked funnel, lifeboats, the radar mast. ~15 draws.
 *   cargo(c, opts)  -> the same API: a 95 m container ship, dark hull, the bridge house aft, ~200 containers in one
 *     vertex-coloured mesh, three deck cranes; its seats are on the bridge wings; F.containers. ~14 draws.
 *   Both take opts {name, funnel (hex)}; cargo also {seed} (which containers, how high).
 */
(function(){
"use strict";
var HQV = window.HQV = window.HQV || {};
var PI = Math.PI;

var L = 38, HALF = 19, DECK = 3.0, SUN = 5.6, BRIDGE = 7.6;

// one BufferGeometry from [geometry, matrix] pairs (positions, normals; non-indexed)
// a part may carry a colour (p[2], hex): then the merged geometry has vertex colours (white where none is given)
function merge(THREE, parts){
  var pos = [], nor = [], col = [], tinted = parts.some(function(p){ return p[2] != null; }), cc = new THREE.Color();
  parts.forEach(function(p){
    var g = p[0].index ? p[0].toNonIndexed() : p[0];
    g.applyMatrix4(p[1]);
    if(!g.attributes.normal) g.computeVertexNormals();
    var a = g.attributes.position.array, n = g.attributes.normal.array;
    for(var i = 0; i < a.length; i++){ pos.push(a[i]); nor.push(n[i]); }
    if(tinted){ cc.set(p[2] != null ? p[2] : 0xffffff); for(var j = 0; j < a.length; j += 3) col.push(cc.r, cc.g, cc.b); }
    if(g !== p[0]) g.dispose();
    p[0].dispose();
  });
  var out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  if(tinted) out.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  out.computeBoundingSphere();
  return out;
}
function Parts(THREE){
  var by = {};
  var m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), s = new THREE.Vector3(), p = new THREE.Vector3();
  var tint = null;
  function add(key, geo, x, y, z, rx, ry, rz, sx, sy, sz){
    e.set(rx || 0, ry || 0, rz || 0); q.setFromEuler(e); p.set(x || 0, y || 0, z || 0); s.set(sx || 1, sy || 1, sz || 1);
    (by[key] = by[key] || []).push([geo, m4.clone().compose(p, q, s), tint]);
  }
  return {
    by: by,
    tint: function(hex){ tint = hex == null ? null : hex; },          // the colour of the parts added next (vertex colours)
    box: function(key, w, h, d, x, y, z, ry){ add(key, new THREE.BoxGeometry(w, h, d), x, y, z, 0, ry); },
    cyl: function(key, r0, r1, h, x, y, z, rx, rz, seg){ add(key, new THREE.CylinderGeometry(r0, r1, h, seg || 12), x, y, z, rx, 0, rz); },
    geo: function(key, g, x, y, z){ add(key, g, x, y, z); },
    ball: function(key, r, x, y, z, sx, sy, sz){ add(key, new THREE.SphereGeometry(r, 12, 8), x, y, z, 0, 0, 0, sx, sy, sz); }
  };
}

// the hull's stations [z, half beam at the gunwale, gunwale y, half beam at the chine, chine y, keel y], stern first
var STATIONS = [[-HALF, 4.7, DECK, 4.5, -0.5, -1.9], [-14, 5.0, DECK, 4.8, -0.8, -2.2], [0, 5.0, DECK + 0.1, 4.8, -0.8, -2.2],
                [9, 4.8, DECK + 0.3, 4.2, -0.6, -2.1], [14.5, 3.7, DECK + 0.6, 2.6, -0.2, -1.8], [HALF + 0.6, 0.25, DECK + 1.1, 0.12, 1.4, 0.3]];
function beamOf(S, z){
  for(var i = 1; i < S.length; i++) if(z <= S[i][0]){
    var a = S[i - 1], b = S[i], u = (z - a[0])/(b[0] - a[0]);
    return a[1] + (b[1] - a[1])*u;
  }
  return 0.2;
}
function beamAt(z){ return beamOf(STATIONS, z); }
function deckGeo(THREE, inset, z0, z1, beam){
  beam = beam || beamAt;
  var sh = new THREE.Shape(), n = 24, i, z;
  // the outline in (x, -z), laid flat by rotateX(-90°): shape y -> -z, its normal up
  for(i = 0; i <= n; i++){ z = z0 + (z1 - z0)*i/n; var b = Math.max(0.1, beam(z) - inset); i ? sh.lineTo(b, -z) : sh.moveTo(b, -z); }
  for(i = n; i >= 0; i--){ z = z0 + (z1 - z0)*i/n; sh.lineTo(-Math.max(0.1, beam(z) - inset), -z); }
  var g = new THREE.ShapeGeometry(sh);
  g.rotateX(-PI/2);
  return g;
}
// a white rail along a polyline of [x, z] at height y: posts every 1.6 m and a top bar
function rail(P, pts, y, h){
  for(var i = 0; i < pts.length - 1; i++){
    var a = pts[i], b = pts[i + 1], dx = b[0] - a[0], dz = b[1] - a[1], d = Math.hypot(dx, dz), ry = Math.atan2(dx, dz);
    P.box("white", 0.06, 0.06, d, (a[0] + b[0])/2, y + h, (a[1] + b[1])/2, ry);
    P.box("white", 0.04, 0.04, d, (a[0] + b[0])/2, y + h*0.5, (a[1] + b[1])/2, ry);
    for(var t = 0; t < d; t += 1.6) P.box("white", 0.06, h, 0.06, a[0] + dx*t/d, y + h/2, a[1] + dz*t/d);
  }
}
function nameTex(THREE, name){
  if(typeof document === "undefined" || !document.createElement) return null;
  var cv = document.createElement("canvas"); cv.width = 512; cv.height = 96;
  var g = cv.getContext && cv.getContext("2d"); if(!g) return null;
  g.clearRect(0, 0, 512, 96);
  g.font = "700 64px system-ui, sans-serif"; g.textAlign = "center"; g.textBaseline = "middle"; g.fillStyle = "#f4f1ea";
  g.fillText(String(name || "").slice(0, 18).toUpperCase(), 256, 50);
  var t = new THREE.CanvasTexture(cv); t.anisotropy = 4;
  return t;
}
function foamTex(THREE){
  if(typeof document === "undefined" || !document.createElement) return null;
  var cv = document.createElement("canvas"); cv.width = 128; cv.height = 256;
  var g = cv.getContext && cv.getContext("2d"); if(!g) return null;
  var img = g.createImageData(128, 256), d = img.data, seed = 7;
  function rnd(){ seed = (seed*16807) % 2147483647; return seed/2147483647; }
  for(var y = 0; y < 256; y++) for(var x = 0; x < 128; x++){
    var u = Math.abs(x - 63.5)/64, edge = Math.pow(Math.max(0, 1 - u), 0.6), streak = 0.55 + 0.45*Math.sin(x*0.45 + Math.sin(y*0.05)*3);
    var a = edge*streak*(0.55 + 0.45*rnd()), i = (y*128 + x)*4;
    d[i] = d[i + 1] = d[i + 2] = 255; d[i + 3] = Math.round(255*Math.min(1, a));
  }
  g.putImageData(img, 0, 0);
  var t = new THREE.CanvasTexture(cv); t.wrapS = THREE.ClampToEdgeWrapping; t.wrapT = THREE.RepeatWrapping;
  return t;
}

function ferry(c, opts){
  opts = opts || {};
  var THREE = c.THREE, P = Parts(THREE);
  // the hull, one lofted shell (games/hqboat.js hullGeo), and a white sheer band along its top
  P.geo("hull", HQV.hqboat.hullGeo(THREE, STATIONS));
  P.geo("deck", deckGeo(THREE, 0.15, -HALF + 0.2, HALF - 0.4), 0, DECK + 0.02, 0);
  [1, -1].forEach(function(sx){
    for(var z = -HALF + 0.5; z < HALF - 2; z += 2){
      var b0 = beamAt(z), b1 = beamAt(z + 2);
      P.box("white", 0.12, 0.9, 2.05, sx*((b0 + b1)/2 + 0.04), DECK - 0.35, z + 1, Math.atan2(sx*(b1 - b0), 2));
    }
  });
  // deck house (passenger saloon), its window band, and the wheelhouse forward of the sun deck
  P.box("white", 8.4, SUN - DECK, 20, 0, (DECK + SUN)/2, -4);
  P.box("glass", 8.5, 1.0, 18.6, 0, DECK + 1.5, -4);
  P.box("white", 8.8, 0.25, 21, 0, SUN + 0.12, -4);                          // the sun deck's floor overhang
  P.box("deck", 8.3, 0.04, 12, 0, SUN + 0.27, -9);
  P.box("white", 6.4, BRIDGE - SUN, 5, 0, (SUN + BRIDGE)/2 + 0.25, 3.5);
  P.box("glass", 6.5, 0.95, 4.2, 0, SUN + 1.45, 3.9);
  P.box("glass", 5.6, 0.95, 0.1, 0, SUN + 1.45, 6.05);
  P.box("white", 7.4, 0.2, 5.6, 0, BRIDGE + 0.35, 3.5);                      // its roof, overhanging
  // the funnel (the line's colour, a black top) on the sun deck's after end, raked back
  P.cyl("funnel", 1.0, 1.25, 3.2, 0, SUN + 1.9, -14, -0.12);
  P.cyl("dark", 1.02, 1.02, 0.5, 0, SUN + 3.5, -14.2, -0.12);
  // the mast on the wheelhouse roof, its radar and the masthead light
  P.cyl("dark", 0.08, 0.1, 3.2, 0, BRIDGE + 2.0, 3.0);
  P.box("dark", 1.8, 0.12, 0.25, 0, BRIDGE + 2.6, 3.0);
  P.ball("lightW", 0.16, 0, BRIDGE + 3.65, 3.0);
  P.ball("lightR", 0.18, 3.25, SUN + 1.5, 5.6);                              // port (left, +x) red
  P.ball("lightG", 0.18, -3.25, SUN + 1.5, 5.6);                             // starboard green
  // benches on the sun deck (the seats), lifeboats in davits alongside the saloon roof
  var seats = [];
  [-12, -9.5, -7].forEach(function(z){
    [2.2, -2.2].forEach(function(x){
      P.box("deck", 2.6, 0.08, 0.6, x, SUN + 0.75, z);
      P.box("deck", 2.6, 0.55, 0.08, x, SUN + 1.05, z - 0.3);
      P.box("dark", 0.08, 0.45, 0.5, x - 1.2, SUN + 0.5, z); P.box("dark", 0.08, 0.45, 0.5, x + 1.2, SUN + 0.5, z);
      var s = new THREE.Object3D(); s.name = "seat"; s.position.set(x, SUN + 0.8, z); seats.push(s);
    });
  });
  [1, -1].forEach(function(sx){
    [-9, 0].forEach(function(z){
      P.ball("boat", 1, sx*4.75, SUN + 0.9, z, 0.9, 0.55, 3.2);
      P.box("dark", 0.1, 1.1, 0.1, sx*4.4, SUN + 0.6, z - 2.2); P.box("dark", 0.1, 1.1, 0.1, sx*4.4, SUN + 0.6, z + 2.2);
    });
  });
  // rails: round the sun deck, round the bow on the main deck
  rail(P, [[1.4, -3], [4.1, -3], [4.1, -15], [-4.1, -15], [-4.1, -3], [-1.4, -3]], SUN + 0.25, 1.0);   // a gap to the wheelhouse
  var bow = [];
  for(var z = 6.5; z <= HALF + 0.3; z += 1.5) bow.push([beamAt(z) - 0.2, z]);
  var bowR = bow.slice(), bowL = bow.map(function(p){ return [-p[0], p[1]]; }).reverse();
  rail(P, bowR.concat(bowL), DECK + 0.05, 1.0);
  rail(P, [[4.5, -HALF + 0.5], [4.5, -14.5]], DECK + 0.05, 1.0); rail(P, [[-4.5, -HALF + 0.5], [-4.5, -14.5]], DECK + 0.05, 1.0);
  P.box("dark", 6.5, 0.6, 0.3, 0, DECK + 0.3, -HALF + 0.3);                   // the stern's car ramp, raised

  var M = {
    hull: c.mat(0x1d2f4f, {roughness: 0.45, metalness: 0.2, side: THREE.DoubleSide}),
    white: c.mat(0xf2f0ea, {roughness: 0.5}),
    deck: c.mat(0x8c7a62, {roughness: 0.85}),
    glass: c.mat(0x1a2533, {roughness: 0.15, metalness: 0.6, emissive: new THREE.Color(0xffc978), emissiveIntensity: 0}),
    funnel: c.mat(opts.funnel != null ? opts.funnel : 0xe2805e, {roughness: 0.5}),
    dark: c.mat(0x22262b, {roughness: 0.7}),
    boat: c.mat(0xff7a1a, {roughness: 0.55}),
    lightW: c.mat(0xffffff, {emissive: new THREE.Color(0xffffff), emissiveIntensity: 1.5}),
    lightR: c.mat(0xff3030, {emissive: new THREE.Color(0xff2020), emissiveIntensity: 1.5}),
    lightG: c.mat(0x30ff60, {emissive: new THREE.Color(0x20ff50), emissiveIntensity: 1.5})
  };
  var g = new THREE.Group(); g.name = "ferry";
  var geos = [];
  Object.keys(P.by).forEach(function(k){
    var geo = merge(THREE, P.by[k]), m = new THREE.Mesh(geo, M[k]);
    m.castShadow = k !== "glass" && k.indexOf("light") !== 0; m.receiveShadow = k === "deck" || k === "white";
    m.name = "ferry-" + k; g.add(m); geos.push(geo);
  });
  seats.forEach(function(s){ g.add(s); });
  // the name on both bows
  var nt = nameTex(THREE, opts.name || "Commons Star"), nameM = null, nameG = null;
  if(nt){
    nameM = new THREE.MeshBasicMaterial({map: nt, transparent: true, depthWrite: false});
    nameG = new THREE.PlaneGeometry(6.4, 1.2);
    [1, -1].forEach(function(sx){
      var o = new THREE.Mesh(nameG, nameM); o.position.set(sx*(beamAt(12) + 0.08), DECK - 0.4, 12.5); o.rotation.y = sx*PI/2;
      o.rotation.y += sx*-0.08; g.add(o);
    });
  }
  return finish(c, g, seats, M, geos, nameM, nameG, true, {w0: 10, w1: 34, len: 110, z: -HALF + 1, full: 14});
}

// ---------- the cruise ship ----------
var CL = 120, CH = 60, CDECK = 7, CTIER = 2.9, CN = 7, CPOOL = CDECK + CN*CTIER;
var CST = [[-CH, 9.4, CDECK, 9.2, -2, -4.5], [-50, 10.5, CDECK, 10.3, -3, -5], [0, 10.5, CDECK + 0.1, 10.3, -3, -5],
           [30, 10.2, CDECK + 0.4, 9.5, -2.8, -5], [45, 8, CDECK + 0.9, 6, -1.5, -4.6], [CH + 1, 0.4, CDECK + 2, 0.2, 2, 0.5]];
// the boot topping: the hull's lower shell, a hair wider, up to y
function bootStations(S, y, grow){ return S.map(function(r){ return [r[0], r[3] + grow + (r[1] - r[3])*0.15, Math.min(r[2], y), r[3] + grow, r[4], r[5] - 0.02]; }); }
// rows along the hull's sides: short boxes following its beam
function hullBands(P, key, S, ys, h, z0, z1){
  ys.forEach(function(y){
    [1, -1].forEach(function(sx){
      for(var z = z0; z < z1; z += 3){ var b0 = beamOf(S, z), b1 = beamOf(S, z + 3); P.box(key, 0.1, h, 3.05, sx*((b0 + b1)/2 + 0.03), y, z + 1.5, Math.atan2(sx*(b1 - b0), 3)); }
    });
  });
}
function build(c, P, M, name){
  var THREE = c.THREE, g = new THREE.Group(), geos = [];
  g.name = name;
  Object.keys(P.by).forEach(function(k){
    var geo = merge(THREE, P.by[k]), m = new THREE.Mesh(geo, M[k]);
    m.castShadow = k !== "glass" && k !== "pool" && k.indexOf("light") !== 0; m.receiveShadow = k === "deck" || k === "white";
    m.name = name + "-" + k; g.add(m); geos.push(geo);
  });
  return {g: g, geos: geos};
}
function names(c, g, name, at){
  var THREE = c.THREE, nt = nameTex(THREE, name), nameM = null, nameG = null;
  if(nt){
    nameM = new THREE.MeshBasicMaterial({map: nt, transparent: true, depthWrite: false});
    nameG = new THREE.PlaneGeometry(at.w, at.w*0.19);
    [1, -1].forEach(function(sx){
      var o = new THREE.Mesh(nameG, nameM); o.position.set(sx*(at.x + 0.12), at.y, at.z); o.rotation.y = sx*PI/2 - sx*at.toe; g.add(o);
    });
  }
  return {m: nameM, g: nameG};
}
function cruise(c, opts){
  opts = opts || {};
  var THREE = c.THREE, P = Parts(THREE), cb = function(z){ return beamOf(CST, z); };
  P.geo("hull", HQV.hqboat.hullGeo(THREE, CST));
  P.geo("boot", HQV.hqboat.hullGeo(THREE, bootStations(CST, 0.9, 0.06)));
  P.geo("deck", deckGeo(THREE, 0.2, -CH + 0.3, CH - 1, cb), 0, CDECK + 0.03, 0);
  hullBands(P, "glass", CST, [2.6, 4.9], 0.9, -CH + 4, 40);
  hullBands(P, "dark", CST, [CDECK - 0.3], 0.25, -CH + 1, CH - 4);
  // the decks of cabins, each a little shorter, the top ones narrower; balconies (glass doors, white slabs and
  // dividers) down both sides
  for(var k = 0; k < CN; k++){
    var y = CDECK + k*CTIER, z0 = -50 + k*1.5, z1 = 38 - k*3.2, hw = Math.min(cb(z1) - 0.6, 9.4) - Math.max(0, k - 4)*1.6, len = z1 - z0, zm = (z0 + z1)/2;
    P.box("white", 2*hw, CTIER, len, 0, y + CTIER/2, zm);
    P.box("glass", 2*hw + 0.05, 1.35, len - 2, 0, y + 1.25, zm);
    P.box("white", 2*hw + 2.4, 0.18, len - 1, 0, y + 0.09, zm);                         // the balcony floors
    P.box("white", 2*hw + 2.4, 0.08, len - 1, 0, y + 1.1, zm);                          // their rail
    for(var z = z0 + 1; z <= z1 - 1; z += 3.5) [1, -1].forEach(function(sx){ P.box("white", 1.2, 1.1, 0.12, sx*(hw + 0.6), y + 0.65, z); });
    P.box("glass", 2*hw - 1, 1.2, 0.06, 0, y + 1.35, z1 + 0.02);                         // the forward windows
  }
  // the bridge across the front of deck 5 and its wings
  var by = CDECK + 5*CTIER, bz = 38 - 5*3.2;
  P.box("white", 22, 2.6, 4, 0, by + 1.3, bz - 1.5);
  P.box("glass", 22.1, 1.0, 3.6, 0, by + 1.6, bz - 1.4);
  // the pool deck: teak, the pool, loungers in the line's colours, parasols, rails
  var pz0 = -40, pz1 = 18, pw = 8.2;
  P.box("deck", 2*pw, 0.12, pz1 - pz0, 0, CPOOL + 0.06, (pz0 + pz1)/2);
  P.box("white", 10, 0.5, 15, 0, CPOOL + 0.2, -6);
  P.box("pool", 9, 0.26, 14, 0, CPOOL + 0.34, -6);
  P.box("pool", 4, 0.3, 4, 0, CPOOL + 0.15, 8);                                           // the hot tub
  var seats = [], cols = [0xff6b6b, 0xffd166, 0x06d6a0, 0x4cc9f0, 0xef476f, 0xf8961e];
  [-6, 6].forEach(function(x, side){
    for(var i = 0; i < 6; i++){
      var z = -12 + i*2.4;
      P.tint(cols[(i + side*3) % cols.length]);
      P.box("lounger", 0.8, 0.12, 1.9, x, CPOOL + 0.45, z);
      P.box("lounger", 0.8, 0.7, 0.12, x, CPOOL + 0.75, z - 0.85);
      var st = new THREE.Object3D(); st.name = "seat"; st.position.set(x, CPOOL + 0.55, z); seats.push(st);
    }
  });
  [[-3.2, 4], [3.2, 4], [-3.2, 12], [3.2, 12]].forEach(function(p, i){
    P.tint(0xf4f1ea); P.cyl("lounger", 0.05, 0.05, 2.2, p[0], CPOOL + 1.1, p[1]);
    P.tint(cols[(i*2) % cols.length]); P.cyl("lounger", 0.01, 1.3, 0.35, p[0], CPOOL + 2.3, p[1]);
  });
  P.tint(null);
  rail(P, [[pw, pz0], [pw, pz1], [-pw, pz1], [-pw, pz0], [pw, pz0]], CPOOL + 0.1, 1.1);
  // the funnel, raked, aft of the pool; the radar mast over the bridge
  P.cyl("funnel", 2.6, 3.0, 8, 0, CPOOL + 4, -30, -0.18, 0, 16);
  P.cyl("dark", 2.62, 2.62, 1.2, 0, CPOOL + 7.9, -30.7, -0.18, 0, 16);
  P.box("white", 7, 2.5, 6, 0, CPOOL + 1.25, -30.5);
  P.cyl("dark", 0.15, 0.2, 7, 0, CPOOL + 3.5, 14);
  P.box("dark", 4, 0.2, 0.4, 0, CPOOL + 5.2, 14);
  P.box("dark", 2.6, 0.25, 0.5, 0, CPOOL + 6.4, 14, 0.4);
  P.ball("lightW", 0.3, 0, CPOOL + 7.2, 14);
  P.ball("lightR", 0.35, 11.1, by + 1.6, bz - 2);
  P.ball("lightG", 0.35, -11.1, by + 1.6, bz - 2);
  // lifeboats along deck 2, in davits
  [1, -1].forEach(function(sx){
    for(var z = -38; z <= 22; z += 7.5){
      P.ball("boat", 1, sx*10.9, CDECK + 1.6*CTIER, z, 1.3, 0.8, 3.2);
      P.box("dark", 0.15, 1.6, 0.15, sx*10.2, CDECK + 1.6*CTIER + 0.4, z - 2.5); P.box("dark", 0.15, 1.6, 0.15, sx*10.2, CDECK + 1.6*CTIER + 0.4, z + 2.5);
    }
  });
  // the bow's open deck: a rail round it, a mooring winch
  var bow = [];
  for(var zb = 40; zb <= CH; zb += 3) bow.push([cb(zb) - 0.3, zb]);
  rail(P, bow.concat(bow.map(function(p){ return [-p[0], p[1]]; }).reverse()), CDECK + 0.9, 1.1);
  P.cyl("dark", 0.8, 0.8, 2, 0, CDECK + 1.6, 48, 0, PI/2);

  var M = {
    hull: c.mat(0xf6f4ee, {roughness: 0.4, metalness: 0.1, side: THREE.DoubleSide}),
    boot: c.mat(opts.boot != null ? opts.boot : 0x1b2d52, {roughness: 0.5, side: THREE.DoubleSide}),
    white: c.mat(0xf7f6f1, {roughness: 0.5}),
    deck: c.mat(0xa58a63, {roughness: 0.85}),
    glass: c.mat(0x22384d, {roughness: 0.15, metalness: 0.5, emissive: new THREE.Color(0xffd08a), emissiveIntensity: 0}),
    pool: c.mat(0x2fb8d6, {roughness: 0.1, metalness: 0.2, emissive: new THREE.Color(0x3ad0ff), emissiveIntensity: 0.1}),
    lounger: c.mat(0xffffff, {roughness: 0.6, vertexColors: true}),
    funnel: c.mat(opts.funnel != null ? opts.funnel : 0x1f5fa8, {roughness: 0.45}),
    dark: c.mat(0x252a30, {roughness: 0.7}),
    boat: c.mat(0xff7a1a, {roughness: 0.55}),
    lightW: c.mat(0xffffff, {emissive: new THREE.Color(0xffffff), emissiveIntensity: 1.5}),
    lightR: c.mat(0xff3030, {emissive: new THREE.Color(0xff2020), emissiveIntensity: 1.5}),
    lightG: c.mat(0x30ff60, {emissive: new THREE.Color(0x20ff50), emissiveIntensity: 1.5})
  };
  var B = build(c, P, M, "cruise");
  seats.forEach(function(st){ B.g.add(st); });
  var N = names(c, B.g, opts.name || "Claude Serenade", {w: 22, x: cb(44), y: CDECK - 1.6, z: 44, toe: 0.12});
  return finish(c, B.g, seats, M, B.geos, N.m, N.g, true, {w0: 22, w1: 80, len: 300, z: -CH + 2, full: 10});
}

// ---------- the container ship ----------
var GL = 95, GH = 47.5, GDECK = 5;
var GST = [[-GH, 7.6, GDECK, 7.4, -2, -4], [-40, 8, GDECK, 7.8, -3, -4.5], [0, 8, GDECK, 7.9, -3, -4.5],
           [28, 7.8, GDECK + 0.2, 7.2, -2.8, -4.5], [39, 5.6, GDECK + 0.8, 4, -1.5, -4], [GH + 1, 0.4, GDECK + 2, 0.2, 2, 0]];
var BOX_COLS = [0xb03a2e, 0x2e86c1, 0xd35400, 0x239b56, 0x7f8c8d, 0x7d3c98, 0xd4ac0d, 0x1f618d, 0x943126, 0x117a65, 0xe5e7e9];
function cargo(c, opts){
  opts = opts || {};
  var THREE = c.THREE, P = Parts(THREE), gb = function(z){ return beamOf(GST, z); }, seed = (opts.seed | 0) || 11;
  function rnd(){ seed = (seed*16807) % 2147483647; return seed/2147483647; }
  P.geo("hull", HQV.hqboat.hullGeo(THREE, GST));
  P.geo("boot", HQV.hqboat.hullGeo(THREE, bootStations(GST, 0.6, 0.05)));
  P.geo("deck", deckGeo(THREE, 0.2, -GH + 0.3, GH - 0.6, gb), 0, GDECK + 0.03, 0);
  hullBands(P, "white", GST, [GDECK - 0.2], 0.35, -GH + 1, GH - 3);
  // the forecastle, raised at the bow, with its mast
  P.box("hull", 2*gb(40) - 0.6, 1.8, 7.5, 0, GDECK + 0.9, 41);
  P.cyl("dark", 0.15, 0.2, 7, 0, GDECK + 5, 42); P.ball("lightW", 0.3, 0, GDECK + 8.6, 42);
  // the containers: 20-footers in bays from the house to the forecastle, as wide as the hull lets them, 2-5 high
  var n = 0, CW = 2.44, CHt = 2.59, CLn = 6.06;
  for(var z = -30; z <= 33; z += 6.5){
    var rows = Math.min(6, Math.floor((2*(gb(z + 3.2) - 0.6))/(CW + 0.08)));
    P.box("dark", rows*(CW + 0.08) + 0.4, 0.5, 6.3, 0, GDECK + 0.25, z);                  // the hatch cover
    for(var r = 0; r < rows; r++){
      var x = (r - (rows - 1)/2)*(CW + 0.08), h = 2 + Math.floor(rnd()*3.99);
      for(var t = 0; t < h; t++){ P.tint(BOX_COLS[Math.floor(rnd()*BOX_COLS.length)]); P.box("boxes", CW, CHt, CLn, x, GDECK + 0.5 + CHt/2 + t*(CHt + 0.02), z); n++; }
    }
  }
  P.tint(null);
  // three deck cranes on the centreline between bays: post, cab, a jib raked forward, its hook
  [-23.5, -4, 15.5].forEach(function(z){
    P.cyl("crane", 0.9, 1.1, 16, 0, GDECK + 8, z + 3.25, 0, 0, 12);
    P.box("crane", 2.4, 2.2, 2.4, 0, GDECK + 17, z + 3.25);
    P.box("crane", 0.7, 0.7, 18, 0, GDECK + 18.5, z + 11, 0);
    P.cyl("dark", 0.04, 0.04, 6, 0, GDECK + 15.5, z + 19.5, 0, 0, 4);
  });
  // the bridge house aft: five decks, the bridge on top with wings, the funnel behind it
  var hz = -40, hy = GDECK, hd = 9;
  for(var k = 0; k < 5; k++){
    P.box("white", 14 - k*0.4, 2.8, hd, 0, hy + k*2.8 + 1.4, hz);
    P.box("glass", 14.05 - k*0.4, 0.9, hd - 2, 0, hy + k*2.8 + 1.6, hz);
  }
  var bry = hy + 5*2.8;
  P.box("white", 18, 2.6, 5, 0, bry + 1.3, hz + 1.5);
  P.box("glass", 18.1, 1.0, 4.4, 0, bry + 1.6, hz + 1.6);
  P.box("white", 19, 0.25, 6, 0, bry + 2.7, hz + 1.5);
  P.cyl("dark", 0.12, 0.16, 6, 0, bry + 5.6, hz + 1.5); P.box("dark", 3, 0.2, 0.4, 0, bry + 6.5, hz + 1.5); P.ball("lightW", 0.25, 0, bry + 8.7, hz + 1.5);
  P.box("funnel", 4, 7, 4.5, 0, bry + 1.5, hz - 5.5);
  P.box("dark", 4.05, 1, 4.55, 0, bry + 5.5, hz - 5.5);
  P.ball("lightR", 0.3, 9, bry + 1.5, hz + 3.5); P.ball("lightG", 0.3, -9, bry + 1.5, hz + 3.5);
  rail(P, [[gb(-GH + 1) - 0.3, -GH + 0.6], [-(gb(-GH + 1) - 0.3), -GH + 0.6]], GDECK + 0.05, 1.0);
  var seats = [[7.6, hz + 2.5], [-7.6, hz + 2.5]].map(function(p){ var st = new THREE.Object3D(); st.name = "seat"; st.position.set(p[0], bry + 0.3, p[1]); return st; });

  var M = {
    hull: c.mat(opts.hull != null ? opts.hull : 0x22313f, {roughness: 0.55, metalness: 0.2, side: THREE.DoubleSide}),
    boot: c.mat(0x8f2a24, {roughness: 0.6, side: THREE.DoubleSide}),
    white: c.mat(0xeeece6, {roughness: 0.55}),
    deck: c.mat(0x5d6d58, {roughness: 0.9}),
    glass: c.mat(0x1a2533, {roughness: 0.15, metalness: 0.6, emissive: new THREE.Color(0xffc978), emissiveIntensity: 0}),
    boxes: c.mat(0xffffff, {roughness: 0.75, vertexColors: true}),
    crane: c.mat(0xe8b923, {roughness: 0.6}),
    funnel: c.mat(opts.funnel != null ? opts.funnel : 0xc0392b, {roughness: 0.5}),
    dark: c.mat(0x22262b, {roughness: 0.7}),
    lightW: c.mat(0xffffff, {emissive: new THREE.Color(0xffffff), emissiveIntensity: 1.5}),
    lightR: c.mat(0xff3030, {emissive: new THREE.Color(0xff2020), emissiveIntensity: 1.5}),
    lightG: c.mat(0x30ff60, {emissive: new THREE.Color(0x20ff50), emissiveIntensity: 1.5})
  };
  var B = build(c, P, M, "cargo");
  seats.forEach(function(st){ B.g.add(st); });
  var N = names(c, B.g, opts.name || "Context Carrier", {w: 16, x: gb(36), y: GDECK - 1.2, z: 36, toe: 0.1});
  var F = finish(c, B.g, seats, M, B.geos, N.m, N.g, true, {w0: 18, w1: 60, len: 220, z: -GH + 2, full: 9});
  F.containers = n;
  return F;
}

// the wake: a long strip of foam behind the stern, its texture flowing, its strength with the speed
function wake(c, ft, wk){
  var THREE = c.THREE, geo = new THREE.PlaneGeometry(1, 1, 1, 8), a = geo.attributes.position.array;
  wk = wk || {w0: 10, w1: 34, len: 110, z: -HALF + 1};
  // a fan: w0 wide at the stern, w1 wide len behind (the ferry: 10 m, 34 m, 110 m)
  for(var i = 0; i < a.length; i += 3){
    var v = a[i + 1] + 0.5, w = wk.w0 + (wk.w1 - wk.w0)*v;
    a[i] = a[i]*w; a[i + 1] = v*wk.len;       // rotateX(-90°) puts plane y at -z: behind the stern
  }
  geo.attributes.position.needsUpdate = true;
  geo.rotateX(-PI/2);
  var m = new THREE.MeshBasicMaterial({color: 0xffffff, map: ft, transparent: true, opacity: 0, depthWrite: false});
  var o = new THREE.Mesh(geo, m); o.position.set(0, 0.06, wk.z); o.renderOrder = 2; o.name = "ferry-wake";
  return {o: o, m: m, geo: geo};
}
function finish(c, g, seats, M, geos, nameM, nameG, own, wk){
  var THREE = c.THREE, ft = foamTex(THREE), W = ft ? wake(c, ft, wk) : null, flow = 0, lit = -1;
  if(W) g.add(W.o);
  var F = {g: g, seats: seats};
  F.update = function(dt, speed, night){
    var v = Math.abs(+speed || 0);
    if(W){
      flow = (flow + dt*v/40) % 1; ft.offset.y = flow;
      W.m.opacity += (Math.min(0.8, v/(wk && wk.full || 14)) - W.m.opacity)*(1 - Math.exp(-dt*3));
      W.o.visible = W.m.opacity > 0.01;
    }
    var want = night ? 1.6 : 0.15;
    if(want !== lit){ lit = want; M.glass.emissiveIntensity = want; if(M.pool) M.pool.emissiveIntensity = night ? 0.9 : 0.1; }
  };
  F.clone = function(){
    var g2 = g.clone(true), s2 = [];
    g2.children.slice().forEach(function(o){ if(o.name === "ferry-wake") g2.remove(o); });
    g2.traverse(function(o){ if(o.isObject3D && !o.isMesh && o !== g2 && o.name === "seat") s2.push(o); });
    return finish(c, g2, s2, M, [], null, null, false, wk);
  };
  F.dispose = function(){
    if(W){ W.geo.dispose(); W.m.dispose(); if(ft) ft.dispose(); }
    if(own){ geos.forEach(function(x){ x.dispose(); }); Object.keys(M).forEach(function(k){ M[k].dispose(); });
             if(nameM){ if(nameM.map) nameM.map.dispose(); nameM.dispose(); } if(nameG) nameG.dispose(); }
    if(g.parent) g.parent.remove(g);
  };
  return F;
}

HQV.hqShips = {ferry: ferry, cruise: cruise, cargo: cargo, LENGTH: L, SUN_DECK: SUN, merge: merge,
               CRUISE: {LENGTH: CL, BEAM: 21, POOL: CPOOL}, CARGO: {LENGTH: GL, BEAM: 16}};
})();
