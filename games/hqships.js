/* Claude HQ: the ships (HQV.hqShips): the ferry for now (cruise ships and cargo ships follow).
 *
 *   ferry(c, opts) -> F   c: the hq3d ctx (THREE, mat); opts {name, funnel (hex)}
 *     F.g        the group: origin on the waterline at the hull's middle, forward +z, model +x is LEFT (port)
 *     F.seats    [Object3D]: benches on the open sun deck, a rider sits at seat.position (facing +z)
 *     F.update(dt, speed (m/s), night (bool))   the wake's flow and strength, the window glow
 *     F.clone()  another ferry sharing every geometry and material (the wake keeps its own)
 *     F.dispose()
 * Every part is merged by material (hull, white, deck, glass, funnel, dark, lifeboats, lights): about ten
 * draw calls a ship. Sizes: 38 m long, 10 m beam, the main deck 3 m over the water, the sun deck at 5.6 m.
 */
(function(){
"use strict";
var HQV = window.HQV = window.HQV || {};
var PI = Math.PI;

var L = 38, HALF = 19, DECK = 3.0, SUN = 5.6, BRIDGE = 7.6;

// one BufferGeometry from [geometry, matrix] pairs (positions, normals; non-indexed)
function merge(THREE, parts){
  var pos = [], nor = [];
  parts.forEach(function(p){
    var g = p[0].index ? p[0].toNonIndexed() : p[0];
    g.applyMatrix4(p[1]);
    if(!g.attributes.normal) g.computeVertexNormals();
    var a = g.attributes.position.array, n = g.attributes.normal.array;
    for(var i = 0; i < a.length; i++){ pos.push(a[i]); nor.push(n[i]); }
    if(g !== p[0]) g.dispose();
    p[0].dispose();
  });
  var out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  out.computeBoundingSphere();
  return out;
}
function Parts(THREE){
  var by = {};
  var m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), s = new THREE.Vector3(), p = new THREE.Vector3();
  function add(key, geo, x, y, z, rx, ry, rz, sx, sy, sz){
    e.set(rx || 0, ry || 0, rz || 0); q.setFromEuler(e); p.set(x || 0, y || 0, z || 0); s.set(sx || 1, sy || 1, sz || 1);
    (by[key] = by[key] || []).push([geo, m4.clone().compose(p, q, s)]);
  }
  return {
    by: by,
    box: function(key, w, h, d, x, y, z, ry){ add(key, new THREE.BoxGeometry(w, h, d), x, y, z, 0, ry); },
    cyl: function(key, r0, r1, h, x, y, z, rx, rz, seg){ add(key, new THREE.CylinderGeometry(r0, r1, h, seg || 12), x, y, z, rx, 0, rz); },
    geo: function(key, g, x, y, z){ add(key, g, x, y, z); },
    ball: function(key, r, x, y, z, sx, sy, sz){ add(key, new THREE.SphereGeometry(r, 12, 8), x, y, z, 0, 0, 0, sx, sy, sz); }
  };
}

// the hull's stations [z, half beam at the gunwale, gunwale y, half beam at the chine, chine y, keel y], stern first
var STATIONS = [[-HALF, 4.7, DECK, 4.5, -0.5, -1.9], [-14, 5.0, DECK, 4.8, -0.8, -2.2], [0, 5.0, DECK + 0.1, 4.8, -0.8, -2.2],
                [9, 4.8, DECK + 0.3, 4.2, -0.6, -2.1], [14.5, 3.7, DECK + 0.6, 2.6, -0.2, -1.8], [HALF + 0.6, 0.25, DECK + 1.1, 0.12, 1.4, 0.3]];
function beamAt(z){
  for(var i = 1; i < STATIONS.length; i++) if(z <= STATIONS[i][0]){
    var a = STATIONS[i - 1], b = STATIONS[i], u = (z - a[0])/(b[0] - a[0]);
    return a[1] + (b[1] - a[1])*u;
  }
  return 0.2;
}
function deckGeo(THREE, inset, z0, z1){
  var sh = new THREE.Shape(), n = 24, i, z;
  // the outline in (x, -z), laid flat by rotateX(-90°): shape y -> -z, its normal up
  for(i = 0; i <= n; i++){ z = z0 + (z1 - z0)*i/n; var b = Math.max(0.1, beamAt(z) - inset); i ? sh.lineTo(b, -z) : sh.moveTo(b, -z); }
  for(i = n; i >= 0; i--){ z = z0 + (z1 - z0)*i/n; sh.lineTo(-Math.max(0.1, beamAt(z) - inset), -z); }
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
      var s = new THREE.Object3D(); s.position.set(x, SUN + 0.8, z); seats.push(s);
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
  return finish(c, g, seats, M, geos, nameM, nameG, true);
}

// the wake: a long strip of foam behind the stern, its texture flowing, its strength with the speed
function wake(c, ft){
  var THREE = c.THREE, geo = new THREE.PlaneGeometry(1, 1, 1, 8), a = geo.attributes.position.array;
  // a fan: 10 m wide at the stern, 34 m wide 110 m behind
  for(var i = 0; i < a.length; i += 3){
    var v = a[i + 1] + 0.5, w = 10 + 24*v;
    a[i] = a[i]*w; a[i + 1] = v*110;          // rotateX(-90°) puts plane y at -z: behind the stern
  }
  geo.attributes.position.needsUpdate = true;
  geo.rotateX(-PI/2);
  var m = new THREE.MeshBasicMaterial({color: 0xffffff, map: ft, transparent: true, opacity: 0, depthWrite: false});
  var o = new THREE.Mesh(geo, m); o.position.set(0, 0.06, -HALF + 1); o.renderOrder = 2; o.name = "ferry-wake";
  return {o: o, m: m, geo: geo};
}
function finish(c, g, seats, M, geos, nameM, nameG, own){
  var THREE = c.THREE, ft = foamTex(THREE), W = ft ? wake(c, ft) : null, flow = 0, lit = -1;
  if(W) g.add(W.o);
  var F = {g: g, seats: seats};
  F.update = function(dt, speed, night){
    var v = Math.abs(+speed || 0);
    if(W){
      flow = (flow + dt*v/40) % 1; ft.offset.y = flow;
      W.m.opacity += (Math.min(0.8, v/14) - W.m.opacity)*(1 - Math.exp(-dt*3));
      W.o.visible = W.m.opacity > 0.01;
    }
    var want = night ? 1.6 : 0.15;
    if(want !== lit){ lit = want; M.glass.emissiveIntensity = want; }
  };
  F.clone = function(){
    var g2 = g.clone(true), s2 = [];
    g2.children.slice().forEach(function(o){ if(o.name === "ferry-wake") g2.remove(o); });
    g2.traverse(function(o){ if(o.isObject3D && !o.isMesh && o !== g2) s2.push(o); });
    return finish(c, g2, s2, M, [], null, null, false);
  };
  F.dispose = function(){
    if(W){ W.geo.dispose(); W.m.dispose(); if(ft) ft.dispose(); }
    if(own){ geos.forEach(function(x){ x.dispose(); }); Object.keys(M).forEach(function(k){ M[k].dispose(); });
             if(nameM){ if(nameM.map) nameM.map.dispose(); nameM.dispose(); } if(nameG) nameG.dispose(); }
    if(g.parent) g.parent.remove(g);
  };
  return F;
}

HQV.hqShips = {ferry: ferry, LENGTH: L, SUN_DECK: SUN, merge: merge};
})();
