/* Claude HQ: stand-in 3D bodies for the vehicle catalogue (HQV.hqVehicleModels), docs/plans/dealership-spec.md.
 *
 * Every catalogue vehicle drives from the start: until its real glTF model is imported, it gets a body built
 * here from its kind and type (car: hatch, sedan, coupe, suv, hyper, an electric sedan; bike: naked, sport,
 * adventure) from its real size (drawn at SCALE, below), with cheap brand cues (BMW kidneys and angel eyes, the
 * Bugatti horseshoe, C-line and quad LEDs, KTM's orange trellis and split headlight, the GS beak and X light) and
 * the starters' level of detail (3.5.5): a car's round-shouldered tyres, alloys, discs and calipers, shut lines,
 * handles, plates, indicators, fogs, wipers, fin, SUV rails and cladding, splitter and diffuser; a bike's round
 * tyres (wire spokes on the big adventure bikes), discs and calipers, chain and sprockets, radiator, fins, tank
 * stripe, fork legs, grips, levers, dash, skid plate, winglets.
 *
 *   build(c, entry, paint, opts) -> rig     c: the hq3d ctx (c.THREE; c.car / c.moto for the starters), or THREE
 *     rig = {g, wheels, steer, spin, R, radii, seat, grips, feet, lean, hats, riderK, brake(on), roll(d, st),
 *            setPaint(hex), paint (the body material), standin, entry, dims, ready (a Promise when a model loads)}
 *     The same shape as games/hq3d.js carModel / motoModel, so hq3d seats a rider (a-seat, a-grip-l/r, a-foot-l/r)
 *     and rolls it the same way: forward is +z, model-local +x is LEFT, wheels on the ground (y 0), each wheel a
 *     group spun about x; a car's front wheels sit in "steer-l" / "steer-r" holders and its steering wheel is
 *     "spin"; a bike's bars, fork and front wheel are "steer". g.userData.rig is the rig.
 *     The starters (entry.starter, or no class) are hq3d's own car and motorbike (c.car / c.moto), unchanged.
 *   dims(entry) -> {lengthM, widthM, heightM, wheelbaseM}   entry.dims, else typical for its kind and type (true metres)
 *   SCALE = {bike, car}   the display scale: every catalogue body is drawn this much over its true size, so it sits in
 *     the starters' scale family (hq3d draws its motorbike at 1.2× round big-headed riders, its hatch tall and chunky).
 *     The one knob: the body, wheels, rider anchors and a real model all scale with it; hq3d's collision box and
 *     wheelbase, the camera, the car park's impostors read shown(entry). Handling (speeds, acceleration) does not.
 *   scaleOf(entry) -> SCALE[kind]     shown(entry) -> dims(entry) × scaleOf(entry), as drawn
 *   styleOf(entry) -> {kind: "car" | "bike", type, brand, ev}
 *   triangles(rig), drawCalls(rig)     what it costs (the stand-in's own meshes)
 *
 * Budget: under 6k triangles per vehicle (about 2.6-3.5k a bike, 3.9-4.8k a car), 8-10 draw calls a bike, 14 a car.
 * Each rigid piece (the body; each wheel; a bike's steering; a car's steering wheel; a car's wheel holder, for its
 * caliper) is merged into one mesh per material, and the body uses at most five: paint (recolourable, one
 * per vehicle), trim (vertex coloured: black, greys, chrome, KTM orange), glass, lights (vertex coloured, unlit)
 * and the tail lights (unlit; brighter on the brake). Geometry is built once per catalogue entry and shared by
 * every copy; only the paint and tail materials are per vehicle.
 *
 * Real models: when entry.model3d.file is set, build() also loads it (opts.loader, a GLTFLoader, or c.L.loader;
 * from opts.base, default "/games/") and swaps it in when it arrives: scaled to model3d.lengthM (else the
 * entry's length), centred, wheels on the ground; the material named model3d.paintMaterial takes the paint;
 * nodes named wheel-0..3 (or model3d.wheels) become the wheels. The stand-in shows meanwhile.
 */
(function(){
"use strict";
var HQV = window.HQV = window.HQV || {};
var PI = Math.PI;

// the display scale per kind (see the header): a catalogue bike's box (length × height × width) then matches the
// starter motorbike's (a superbike a touch over it), every car's at least the starter hatch's; tests/test_hqvehiclemodels.py
var SCALE = {bike: 1.3, car: 1.08};
// typical sizes (m) for a kind and type, when the catalogue entry gives none
var DIMS = {
  "car.hatch":  {lengthM: 4.36, widthM: 1.80, heightM: 1.46, wheelbaseM: 2.67},
  "car.sedan":  {lengthM: 4.79, widthM: 1.90, heightM: 1.44, wheelbaseM: 2.86},
  "car.coupe":  {lengthM: 4.58, widthM: 1.88, heightM: 1.39, wheelbaseM: 2.75},
  "car.suv":    {lengthM: 4.92, widthM: 2.00, heightM: 1.75, wheelbaseM: 2.98},
  "car.pickup": {lengthM: 5.37, widthM: 2.03, heightM: 1.90, wheelbaseM: 3.32},
  "car.hyper":  {lengthM: 4.54, widthM: 2.04, heightM: 1.21, wheelbaseM: 2.71},
  "car.ev":     {lengthM: 4.78, widthM: 1.85, heightM: 1.45, wheelbaseM: 2.86},
  "bike.naked": {lengthM: 2.05, widthM: 0.84, heightM: 1.20, wheelbaseM: 1.40},
  "bike.sport": {lengthM: 2.07, widthM: 0.74, heightM: 1.15, wheelbaseM: 1.44},
  "bike.adventure": {lengthM: 2.21, widthM: 0.95, heightM: 1.45, wheelbaseM: 1.52}
};
// body proportions: heights as a share of the height (belt line, the nose's top, the tail's top); lengths in
// m from the axles: cowl (the windscreen's foot behind the front axle, × wheelbase), ws (the windscreen's run
// back), roofEnd / glassEnd (the roof's end and the rear glass's foot from the rear axle; negative: behind it),
// fo (the front overhang's share of both overhangs), seat (hip height over the ground clearance)
var CAR = {
  hatch: {R: 0.34, gc: 0.14, belt: 0.62, nose: 0.52, tail: 0.66, cowl: 0.28, ws: 0.62, roofEnd: -0.42, glassEnd: -0.62, seat: 0.30, fo: 0.48},
  sedan: {R: 0.35, gc: 0.13, belt: 0.62, nose: 0.50, tail: 0.64, cowl: 0.34, ws: 0.66, roofEnd: 0.05, glassEnd: -0.35, seat: 0.27, fo: 0.46},
  coupe: {R: 0.35, gc: 0.12, belt: 0.61, nose: 0.46, tail: 0.62, cowl: 0.37, ws: 0.82, roofEnd: 0.12, glassEnd: -0.62, seat: 0.24, fo: 0.47},
  suv:   {R: 0.40, gc: 0.20, belt: 0.60, nose: 0.58, tail: 0.62, cowl: 0.30, ws: 0.62, roofEnd: -0.62, glassEnd: -0.80, seat: 0.40, fo: 0.48},
  hyper: {R: 0.36, gc: 0.10, belt: 0.66, nose: 0.46, tail: 0.66, cowl: 0.20, ws: 0.90, roofEnd: 0.90, glassEnd: -0.30, seat: 0.20, fo: 0.43},
  ev:    {R: 0.35, gc: 0.13, belt: 0.62, nose: 0.48, tail: 0.63, cowl: 0.30, ws: 0.74, roofEnd: 0.12, glassEnd: -0.45, seat: 0.27, fo: 0.46}
};
// bikes: wheel radii (rear, front), the steering head's height, the seat's height, bars, lean in a bend
var BIKE = {
  naked:     {Rr: 0.31, Rf: 0.30, head: 0.94, seat: 0.82, lean: 0.45},
  sport:     {Rr: 0.31, Rf: 0.30, head: 0.90, seat: 0.84, lean: 0.52},
  adventure: {Rr: 0.34, Rf: 0.37, head: 1.04, seat: 0.87, lean: 0.40}
};
var COL = {
  black: 0x15171a, dark: 0x24272c, grey: 0x4a4f57, steel: 0x8d959e, alu: 0xc9ced4, chrome: 0xdfe4ea,
  ktm: 0xff6a00, gold: 0xc9a227, bmwBlue: 0x1c69d4, tyre: 0x141518,
  head: 0xfff8ea, drl: 0xe8f4ff, amber: 0xffa31a, red: 0xff2a34
};
var VCOL = {trim: 1, light: 1, wheel: 1, tail: 1};

function kindType(entry){
  entry = entry || {};
  var cls = String(entry["class"] || "").split("."), kind = entry.kind || cls[0] || "car", type = entry.type || cls[1] || "";
  var band = entry.band || cls[2] || "", sp = entry.spec || {};
  kind = kind === "moto" || kind === "motorbike" ? "bike" : kind;
  return {kind: kind === "bike" ? "bike" : "car", type: type, band: band, electric: !!sp.electric || band === "ev"};
}
function styleOf(entry){
  var k = kindType(entry), brand = String((entry && entry.brand) || "").toLowerCase().replace(/[^a-z]/g, "");
  var type = k.type;
  if(k.kind === "car"){
    if(type === "sedan" && k.electric) type = "ev";
    if(!CAR[type]) type = type === "pickup" ? "suv" : "sedan";
  } else if(!BIKE[type]) type = type === "dirt" ? "adventure" : "naked";
  return {kind: k.kind, type: type, brand: brand, ev: k.electric};
}
function dims(entry){
  var st = styleOf(entry), cls = kindType(entry), d = (entry && entry.dims) || {};
  var base = DIMS[st.kind + "." + (cls.type === "pickup" ? "pickup" : st.type)] || DIMS[st.kind === "bike" ? "bike.naked" : "car.sedan"];
  var out = {};
  ["lengthM", "widthM", "heightM", "wheelbaseM"].forEach(function(k){ out[k] = +d[k] > 0 ? +d[k] : base[k]; });
  if(entry && entry.model3d && +entry.model3d.lengthM > 0 && !(+d.lengthM > 0)) out.lengthM = +entry.model3d.lengthM;
  return out;
}
function scaleOf(entry){ var k = SCALE[styleOf(entry).kind]; return +k > 0 ? +k : 1; }
function shown(entry){
  var d = dims(entry), k = scaleOf(entry), out = {};
  Object.keys(d).forEach(function(n){ out[n] = Math.round(d[n]*k*1000)/1000; });
  return out;
}
function isM(entry){ return /\bM\d|\bM\b|Competition|CSL/.test(String((entry && entry.model) || "")); }

/* ---------- the builder: parts gathered per rigid piece and material, merged once ---------- */
function Builder(T){
  this.T = T; this.m = new T.Matrix4(); this.q = new T.Quaternion(); this.e = new T.Euler();
  this.v = new T.Vector3(); this.one = new T.Vector3(1, 1, 1); this.c = new T.Color();
}
Builder.prototype.node = function(parent, name, x, y, z){
  var g = new this.T.Group(); if(name) g.name = name; g.position.set(x || 0, y || 0, z || 0);
  g.userData.parts = {}; parent.add(g); return g;
};
Builder.prototype.put = function(node, mk, geo, col){
  var T = this.T, g = geo.index ? geo.toNonIndexed() : geo;
  if(g !== geo) geo.dispose();
  ["uv", "uv1", "uv2"].forEach(function(a){ if(g.attributes[a]) g.deleteAttribute(a); });
  if(VCOL[mk]){
    this.c.set(col == null ? 0xffffff : col);
    var n = g.attributes.position.count, a = new Float32Array(n*3);
    for(var i = 0; i < n; i++){ a[i*3] = this.c.r; a[i*3 + 1] = this.c.g; a[i*3 + 2] = this.c.b; }
    g.setAttribute("color", new T.BufferAttribute(a, 3));
  }
  (node.userData.parts[mk] = node.userData.parts[mk] || []).push(g);
  return g;
};
// a geometry placed at (x, y, z) turned by (rx, ry, rz)
Builder.prototype.add = function(node, mk, geo, col, x, y, z, rx, ry, rz){
  this.e.set(rx || 0, ry || 0, rz || 0); this.q.setFromEuler(this.e); this.v.set(x || 0, y || 0, z || 0);
  this.m.compose(this.v, this.q, this.one); geo.applyMatrix4(this.m);
  return this.put(node, mk, geo, col);
};
Builder.prototype.box = function(node, mk, col, w, h, d, x, y, z, rx, ry, rz){
  return this.add(node, mk, new this.T.BoxGeometry(w, h, d), col, x, y, z, rx, ry, rz);
};
// a bar (square) or rod (round) from a to b ([x, y, z])
Builder.prototype.bar = function(node, mk, col, a, b, w, d, round){
  var T = this.T, dv = new T.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]), len = Math.max(0.001, dv.length());
  var geo = round ? new T.CylinderGeometry(w, w, len, 6) : new T.BoxGeometry(w, len, d == null ? w : d);
  this.q.setFromUnitVectors(new T.Vector3(0, 1, 0), dv.clone().normalize());
  this.v.set((a[0] + b[0])/2, (a[1] + b[1])/2, (a[2] + b[2])/2);
  this.m.compose(this.v, this.q, this.one); geo.applyMatrix4(this.m);
  return this.put(node, mk, geo, col);
};
// a side profile (a shape in (z, y)) extruded across the width w, centred on x 0
Builder.prototype.side = function(node, mk, col, pts, w, bevel, curve){
  var T = this.T, s = shapeOf(T, pts), b = bevel || 0;
  // the bevel starts inside the outline (bevelOffset), so the profile keeps its exact size
  var g = new T.ExtrudeGeometry(s, {depth: Math.max(0.002, w - 2*b), bevelEnabled: b > 0, bevelThickness: b, bevelSize: b, bevelOffset: -b,
                                    bevelSegments: 1, curveSegments: curve || 5});
  g.rotateY(-PI/2); g.translate((w - 2*b)/2, 0, 0);
  return this.put(node, mk, g, col);
};
// a tapered block (a car's greenhouse, its roof): a bottom and a top rectangle, each {z0 (front), z1 (back), y, w}
Builder.prototype.frustum = function(node, mk, col, b, t){
  var T = this.T, P = [], hw = b.w/2, tw = t.w/2;
  var v = {bfl: [hw, b.y, b.z0], bfr: [-hw, b.y, b.z0], brl: [hw, b.y, b.z1], brr: [-hw, b.y, b.z1],
           tfl: [tw, t.y, t.z0], tfr: [-tw, t.y, t.z0], trl: [tw, t.y, t.z1], trr: [-tw, t.y, t.z1]};
  function quad(a, bb, c, d){ [a, bb, c, a, c, d].forEach(function(k){ P.push(v[k][0], v[k][1], v[k][2]); }); }
  quad("bfr", "bfl", "tfl", "tfr");      // front (the windscreen)
  quad("brl", "brr", "trr", "trl");      // back
  quad("bfl", "brl", "trl", "tfl");      // left (+x)
  quad("brr", "bfr", "tfr", "trr");      // right
  quad("tfr", "tfl", "trl", "trr");      // top
  quad("bfl", "bfr", "brr", "brl");      // bottom
  var g = new T.BufferGeometry(); g.setAttribute("position", new T.BufferAttribute(new Float32Array(P), 3)); g.computeVertexNormals();
  return this.put(node, mk, g, col);
};
// a flat rounded rectangle facing +z (a grille, a kidney), w × h, d deep, centred at (x, y, z)
Builder.prototype.plate = function(node, mk, col, w, h, d, r, x, y, z, rz){
  var T = this.T, g = new T.ExtrudeGeometry(rrShape(T, w, h, r), {depth: d, bevelEnabled: false, curveSegments: 3});
  g.translate(0, 0, -d/2);
  return this.add(node, mk, g, col, x, y, z, 0, 0, rz || 0);
};
function shapeOf(T, pts){
  var s = new T.Shape();
  pts.forEach(function(p, i){
    if(i === 0) s.moveTo(p[0], p[1]);
    else if(p.length === 4) s.quadraticCurveTo(p[2], p[3], p[0], p[1]);        // [x, y, cx, cy]: a curve through the control point
    else if(p.arc) s.absarc(p[0], p[1], p.arc[0], p.arc[1], p.arc[2], true);  // an arch (over a wheel)
    else s.lineTo(p[0], p[1]);
  });
  return s;
}
function arcPt(cz, cy, r){ var p = [cz, cy]; p.arc = [r, PI, 0]; return p; }
function rrShape(T, w, h, r){
  var s = new T.Shape(), x = -w/2, y = -h/2; r = Math.max(0.001, Math.min(r, w/2, h/2));
  s.moveTo(x + r, y); s.lineTo(x + w - r, y); s.quadraticCurveTo(x + w, y, x + w, y + r); s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h); s.lineTo(x + r, y + h); s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r); s.quadraticCurveTo(x, y, x + r, y); return s;
}
// merge a piece's parts into one mesh per material
function finish(T, root){
  root.traverse(function(o){
    var parts = o.userData && o.userData.parts; if(!parts) return;
    delete o.userData.parts;
    Object.keys(parts).forEach(function(mk){
      var list = parts[mk], n = 0, col = !!VCOL[mk];
      list.forEach(function(g){ n += g.attributes.position.count; });
      var P = new Float32Array(n*3), N = new Float32Array(n*3), C = col ? new Float32Array(n*3) : null, at = 0;
      list.forEach(function(g){
        var c = g.attributes.position.count;
        P.set(g.attributes.position.array, at*3); N.set(g.attributes.normal.array, at*3);
        if(C) C.set(g.attributes.color.array, at*3);
        at += c; g.dispose();
      });
      var out = new T.BufferGeometry();
      out.setAttribute("position", new T.BufferAttribute(P, 3)); out.setAttribute("normal", new T.BufferAttribute(N, 3));
      if(C) out.setAttribute("color", new T.BufferAttribute(C, 3));
      out.computeBoundingSphere();
      var m = new T.Mesh(out); m.userData.mk = mk; m.name = "mk:" + mk;
      m.castShadow = mk === "paint" || mk === "trim" || mk === "wheel"; m.receiveShadow = mk !== "glass";
      if(mk === "glass") m.renderOrder = 2;
      o.add(m);
    });
  });
  return root;
}
function anchor(T, p, name, x, y, z){ var o = new T.Object3D(); o.name = name; o.position.set(x, y, z); p.add(o); return o; }

/* ---------- cars ---------- */
// a car's wheel: a tyre with rounded shoulders and two tread grooves, the alloy (a lip, its spokes: split pairs on an
// M car), a brake disc behind it; the caliper sits on the holder (it steers with the wheel, never spins)
function carWheel(B, holder, name, R, tw, side, rim, spokes, caliper, split){
  var T = B.T, w = B.node(holder, name), sh = Math.min(0.05, tw*0.2);
  B.add(w, "wheel", new T.CylinderGeometry(R, R, tw - 2*sh, 18, 1, true), COL.tyre, 0, 0, 0, 0, 0, PI/2);
  [1, -1].forEach(function(s){
    var t = new T.TorusGeometry(R - sh, sh, 2, 18); t.rotateY(PI/2);
    B.add(w, "wheel", t, s === side ? 0x202226 : COL.tyre, s*(tw/2 - sh), 0, 0);                    // the shoulder, the sidewall
    B.add(w, "wheel", new T.CylinderGeometry(R + 0.003, R + 0.003, 0.014, 18, 1, true), 0x08090a, s*tw*0.17, 0, 0, 0, 0, PI/2);   // a groove
  });
  var ox = side*(tw/2 + 0.004);
  B.add(w, "wheel", new T.CircleGeometry(R*0.68, 14), COL.black, ox - side*0.03, 0, 0, 0, side*PI/2, 0);   // the barrel's dark inside
  var lip = new T.TorusGeometry(R*0.68, 0.016, 3, 16); lip.rotateY(PI/2);
  B.add(w, "wheel", lip, rim, ox, 0, 0);
  B.add(w, "wheel", new T.CylinderGeometry(R*0.5, R*0.5, 0.016, 12), COL.steel, ox - side*0.075, 0, 0, 0, 0, PI/2);   // the brake disc
  var n = spokes || 5;
  for(var k = 0; k < n; k++){
    var a = k/n*PI*2;
    if(split) [-0.11, 0.11].forEach(function(da){ B.box(w, "wheel", rim, 0.018, R*0.6, 0.026, ox + side*0.006, Math.cos(a + da)*R*0.32, Math.sin(a + da)*R*0.32, a + da, 0, 0); });
    else B.box(w, "wheel", rim, 0.02, R*0.6, 0.05, ox + side*0.008, Math.cos(a)*R*0.31, Math.sin(a)*R*0.31, a, 0, 0);
  }
  B.add(w, "wheel", new T.CylinderGeometry(0.055, 0.055, 0.024, 10), COL.dark, ox + side*0.012, 0, 0, 0, 0, PI/2);
  B.add(w, "wheel", new T.CylinderGeometry(0.03, 0.03, 0.03, 8), COL.chrome, ox + side*0.016, 0, 0, 0, 0, PI/2);
  // the caliper: behind the spokes, at the back of the disc
  B.box(holder, "trim", caliper, 0.05, R*0.34, R*0.16, ox - side*0.05, R*0.06, -R*0.42, 0.25, 0, 0);
  return w;
}
function buildCar(T, entry, st, d){
  var B = new Builder(T), root = new T.Group(), body = B.node(root, "body");
  var S = CAR[st.type], L = d.lengthM, W = d.widthM, H = d.heightM, WB = d.wheelbaseM;
  var R = S.R*Math.min(1.12, Math.max(0.9, W/1.9)), gc = S.gc, ar = R + 0.06, archTop = R + ar;
  var zf = L/2 - S.fo*(L - WB), zr = zf - WB;
  var yb = Math.max(H*S.belt, archTop + 0.04), yn = Math.max(H*S.nose, gc + 0.34), yt = Math.max(H*S.tail, archTop + 0.02);
  var zA = zf - S.cowl*WB, zAr = zA - S.ws, zCr = Math.max(-L/2 + 0.2, zr + S.roofEnd), zC = Math.max(-L/2 + 0.08, zr + S.glassEnd);
  if(zCr > zAr - 0.3) zCr = zAr - 0.3;
  if(zC > zCr - 0.05) zC = zCr - 0.05;
  var brand = st.brand, bmw = brand === "bmw", bugatti = brand === "bugatti", hyper = st.type === "hyper";
  var hood = function(z){ return yn + (yb - yn)*(L/2 - 0.14 - z)/Math.max(0.1, L/2 - 0.14 - zA); };
  var deck = function(z){ return yb + (yt - yb)*(zC - z)/Math.max(0.1, zC - (-L/2 + 0.12)); };
  // the lower body: its side profile, both arches cut out; fenders swell over the wheels where the hood runs low
  var pts = [[-L/2, gc + 0.16], [-L/2 + 0.14, gc], [zr - ar, gc], [zr - ar, R], arcPt(zr, R, ar), [zr + ar, gc],
             [zf - ar, gc], [zf - ar, R], arcPt(zf, R, ar), [zf + ar, gc], [L/2 - 0.16, gc], [L/2, gc + 0.2],
             [L/2, yn - 0.09], [L/2 - 0.14, yn, L/2, yn]];
  var fz = zf, fy = Math.max(hood(fz), archTop + 0.05);
  if(fy > hood(fz) + 0.005 && zf - ar > zA + 0.05){ pts.push([zf + ar*0.9, Math.max(hood(zf + ar*0.9), (fy + hood(zf + ar*0.9))/2)]); pts.push([fz, fy]); pts.push([zf - ar, Math.max(hood(zf - ar), fy - 0.02)]); }
  pts.push([zA, yb]);
  if(zC > zr + ar){ pts.push([zC, yb]); }
  var rz = zr, ry = Math.max(deck(rz), archTop + 0.05);
  if(zC > zr && ry > deck(rz) + 0.005){ pts.push([zr + ar, Math.max(deck(zr + ar), ry - 0.02)]); pts.push([rz, ry]); pts.push([zr - ar*0.9, Math.max(deck(zr - ar*0.9), (ry + deck(zr - ar*0.9))/2)]); }
  else if(zC <= zr + ar){ pts.push([zC, Math.max(yb, archTop + 0.05)]); }
  pts.push([-L/2 + 0.12, yt]); pts.push([-L/2, yt - 0.12, -L/2, yt]);
  B.side(body, "paint", null, pts, W, 0.045, 6);
  // arch liners
  [zr, zf].forEach(function(z){ B.add(body, "trim", new T.CylinderGeometry(ar - 0.01, ar - 0.01, W*0.9, 10, 1, true, 0, PI), COL.black, 0, R, z, 0, 0, PI/2); });
  // the greenhouse: tinted glass all round, the roof, the pillars
  var gw = (hyper ? 0.76 : 0.88)*W, top = H - 0.045, tw = gw*(st.type === "suv" ? 0.88 : 0.8);
  // the greenhouse tapers in to the roof (tumblehome); the roof sits on it, a touch wider at its foot
  B.frustum(body, "glass", null, {z0: zA, z1: zC, y: yb - 0.03, w: gw}, {z0: zAr, z1: zCr, y: top, w: tw});
  B.frustum(body, "paint", null, {z0: zAr + 0.03, z1: zCr - 0.03, y: top - 0.012, w: tw + 0.03}, {z0: zAr - 0.06, z1: zCr + 0.05, y: H, w: tw - 0.06});
  var bx = function(f, sx){ return sx*(gw/2 + (tw/2 - gw/2)*f + 0.004); };
  [1, -1].forEach(function(sx){
    B.bar(body, "paint", null, [bx(0, sx), yb - 0.02, zA], [bx(1, sx), top, zAr], 0.06, 0.07);                // A pillar
    B.bar(body, hyper ? "trim" : "paint", COL.black, [bx(0, sx), yb - 0.02, zC + 0.05], [bx(1, sx), top, zCr + 0.04], 0.08, 0.15);   // C
    var zb = (zA + zC)/2 + 0.1, zbt = (zAr + zCr)/2 + 0.06;
    if(!hyper) B.bar(body, "trim", COL.black, [bx(0, sx), yb - 0.02, zb], [bx(1, sx), top, zbt], 0.035, 0.07);   // B
    B.box(body, "trim", bmw ? COL.alu : COL.black, 0.02, 0.025, Math.max(0.2, zA - zC - 0.1), sx*(gw/2 + 0.005), yb + 0.005, (zA + zC)/2);   // the belt line
    B.box(body, "paint", null, 0.07, 0.07, 0.15, sx*(W/2 + 0.05), yb + 0.08, zA - 0.12);                   // a mirror
    B.box(body, "trim", COL.black, 0.04, 0.09, Math.max(0.2, WB - 2*ar - 0.1), sx*(W/2 - 0.01), gc + 0.07, (zf + zr)/2);   // the sill
  });
  // inside: two seats, the dash; the steering wheel (spin) in front of the driver (right-hand drive: -x)
  var ys = gc + S.seat, zS = (zA + zCr)/2 + (hyper ? 0.15 : -0.05), xd = -W*0.21, head = top - 0.04 - ys;
  var k = Math.max(0.55, Math.min(1.0, head/1.22)), riderK = 0.8*k;
  [xd, -xd].forEach(function(x){
    B.box(body, "trim", COL.dark, 0.48, 0.12, 0.48, x, ys - 0.06, zS);
    B.box(body, "trim", COL.dark, 0.46, Math.min(0.62, head*0.75), 0.1, x, ys + Math.min(0.62, head*0.75)/2, zS - 0.28, -0.12, 0, 0);
  });
  B.box(body, "trim", COL.black, W*0.8, 0.12, 0.3, 0, yb - 0.02, zA - 0.12);
  var col = new T.Group(); col.position.set(xd, ys + 0.42*k, zS + 0.36*k); col.rotation.x = -0.6; root.add(col);
  var spin = B.node(col, "spin");
  B.add(spin, "trim", new T.TorusGeometry(0.15*k, 0.02, 4, 16), COL.black);
  B.box(spin, "trim", bmw && isM(entry) ? COL.bmwBlue : COL.grey, 0.06, 0.06, 0.03, 0, 0, 0);
  var gx = 0.15*k*Math.sin(1.05), gy = 0.15*k*Math.cos(1.05);
  anchor(T, spin, "a-grip-l", gx, gy, 0.02); anchor(T, spin, "a-grip-r", -gx, gy, 0.02);
  anchor(T, root, "a-foot-l", xd + 0.11, gc + 0.12, zS + 0.62*k); anchor(T, root, "a-foot-r", xd - 0.11, gc + 0.12, zS + 0.62*k);
  anchor(T, root, "a-seat", xd, ys, zS);
  // the front: lights, the grille (by brand), the bumper's intake
  var zN = L/2 + 0.004, yl = yn - 0.15;
  B.box(body, "trim", COL.black, W*0.62, 0.13, 0.06, 0, gc + 0.2, L/2 - 0.01);                         // the lower intake
  if(bugatti){
    // the horseshoe: an open ring, its gap at the top, round a dark mesh; quad LED strips each side
    var hs = Math.min(0.22, yn - gc - 0.12)*0.85, gap = 0.62*PI, tor = new T.TorusGeometry(hs, 0.025, 4, 18, 2*PI - gap);
    tor.rotateZ(PI/2 + gap/2);
    B.add(body, "trim", tor, COL.chrome, 0, gc + 0.22 + hs, zN + 0.01);
    B.add(body, "trim", new T.CircleGeometry(hs - 0.01, 14), COL.black, 0, gc + 0.22 + hs, zN + 0.005);
    [1, -1].forEach(function(sx){ for(var i = 0; i < 4; i++) B.box(body, "light", COL.drl, 0.05, 0.03, 0.02, sx*(W*0.24 + i*0.065), yl + 0.02, zN); });
  } else {
    var kid = bmw;
    [1, -1].forEach(function(sx){
      B.box(body, "trim", COL.black, W*0.24, 0.11, 0.04, sx*W*0.31, yl, zN - 0.012);                    // the headlight housing
      if(bmw){                                                                                          // angel eyes
        [0.25, 0.36].forEach(function(f){ B.add(body, "light", new T.TorusGeometry(0.042, 0.008, 3, 12), COL.drl, sx*W*f, yl, zN + 0.008); });
      } else B.box(body, "light", COL.head, W*0.2, 0.06, 0.02, sx*W*0.31, yl, zN);
    });
    if(kid){                                                                                            // the kidneys
      var tall = isM(entry) && st.type !== "suv", big = st.type === "suv" || st.ev;
      var kw = big ? 0.26 : tall ? 0.19 : 0.23, kh = big ? 0.26 : tall ? 0.3 : 0.17, ky = gc + 0.24 + kh/2 + (tall ? 0 : 0.04);
      ky = Math.min(ky, yn - 0.06 - kh/2);
      [1, -1].forEach(function(sx){
        B.plate(body, "trim", st.ev ? COL.bmwBlue : COL.alu, kw, kh, 0.03, 0.05, sx*(kw/2 + 0.02), ky, zN + 0.005);
        B.plate(body, "trim", st.ev ? COL.grey : COL.black, kw - 0.03, kh - 0.03, 0.03, 0.04, sx*(kw/2 + 0.02), ky, zN + 0.012);
        if(!st.ev) for(var j = -1; j <= 1; j++) B.box(body, "trim", COL.alu, 0.012, kh - 0.05, 0.012, sx*(kw/2 + 0.02) + j*kw*0.26, ky, zN + 0.03);   // the slats
      });
    } else if(!st.ev) B.plate(body, "trim", COL.black, W*0.42, 0.14, 0.03, 0.04, 0, yl - 0.02, zN + 0.004);
  }
  // the side: intakes ahead of the rear wheels (hypercars), Bugatti's C-line
  if(hyper) [1, -1].forEach(function(sx){ B.box(body, "trim", COL.black, 0.03, 0.26, 0.5, sx*(W/2 + 0.002), gc + 0.3, zr + ar + 0.35); });
  if(bugatti){
    [1, -1].forEach(function(sx){
      var cr = Math.min(0.42, (yb - gc)*0.6), arc = 1.15*PI, c = new T.TorusGeometry(cr, 0.03, 3, 14, arc);
      c.rotateZ(PI - arc/2); c.rotateY(-PI/2);
      B.add(body, "trim", c, COL.alu, sx*(W/2 + 0.012), gc + cr + 0.08, zA - 0.25);
    });
  }
  // the back: tail lights, the diffuser, exhausts, a lip
  var zT = -L/2 - 0.004, yr = yt - 0.2;
  B.box(body, "trim", COL.black, W*0.7, 0.12, 0.06, 0, gc + 0.12, -L/2 + 0.01);
  if(bugatti) B.box(body, "tail", COL.red, W*0.82, 0.035, 0.02, 0, yt - 0.16, zT);
  else [1, -1].forEach(function(sx){
    B.box(body, "tail", COL.red, W*0.2, 0.05, 0.02, sx*W*0.37, yr, zT);
    if(bmw) B.box(body, "tail", COL.red, 0.05, 0.1, 0.02, sx*W*0.28, yr - 0.03, zT);                 // the L
  });
  if(!st.ev){
    var nx = bmw && isM(entry) ? 4 : bugatti ? 0 : 2;
    for(var i = 0; i < nx; i++){ var ex = (i < nx/2 ? 1 : -1)*(W*0.3 + (i % 2)*0.1); B.add(body, "trim", new T.CylinderGeometry(0.045, 0.045, 0.12, 8), COL.chrome, ex, gc + 0.1, -L/2 + 0.02, PI/2, 0, 0); }
  }
  if(hyper || st.type === "coupe") B.box(body, "paint", null, W*0.8, 0.03, 0.22, 0, yt + 0.01, -L/2 + 0.2, -0.12, 0, 0);
  // detail: shut lines and handles, the plates, indicators and fog lights, wipers, the fin; an SUV's rails and arch
  // cladding, a hatch's roof spoiler, an M saloon's boot lip, a splitter and diffuser fins on the quick ones
  var two = st.type === "coupe" || hyper, zd0 = Math.min(zA, zf - ar - 0.06), zd1 = Math.max(zr + ar + 0.06, zC - 0.02);
  var shut = two ? [zd0, Math.max(zd1, (zA + zC)/2 - 0.25)] : [zd0, (zA + zC)/2 + 0.1, zd1], ly0 = gc + 0.16, ly1 = yb - 0.03;
  [1, -1].forEach(function(sx){
    var x = sx*(W/2 + 0.002);
    shut.forEach(function(z, i){
      B.box(body, "trim", COL.black, 0.012, ly1 - ly0, 0.014, x, (ly0 + ly1)/2, z);
      if(i < shut.length - 1) B.box(body, "trim", bmw ? COL.alu : COL.dark, 0.02, 0.026, 0.13, sx*(W/2 + 0.01), yb - 0.09, shut[i + 1] + 0.16);
    });
    B.box(body, "trim", COL.black, 0.06, 0.02, 0.05, sx*(W/2 + 0.01), yb + 0.06, zA - 0.1);                // the mirror's stalk
    B.box(body, "trim", COL.dark, 0.012, 0.05, 0.11, sx*(W/2 + 0.07), yb + 0.08, zA - 0.2);               // its glass
    if(!bugatti){
      B.box(body, "light", COL.amber, 0.07, 0.03, 0.02, sx*W*0.43, yl - 0.075, L/2 + 0.004);             // indicators
      B.box(body, "light", COL.head, 0.08, 0.035, 0.02, sx*W*0.37, gc + 0.21, L/2 + 0.006);              // fog lights
    }
    B.box(body, "light", COL.head, 0.08, 0.035, 0.02, sx*W*0.3, gc + 0.22, -L/2 - 0.006);                // reversing lights
    B.box(body, "trim", COL.black, W*0.26, 0.014, 0.02, sx*W*0.18, yb + 0.02, zA - 0.05, 0, sx*0.08, 0); // the wipers
    if(st.type === "suv" || st.type === "pickup"){
      [zr, zf].forEach(function(z){ var c = new T.TorusGeometry(ar + 0.012, 0.035, 3, 10, PI); c.rotateY(PI/2); B.add(body, "trim", c, COL.black, sx*(W/2 - 0.012), R, z); });
      var rx = sx*(tw/2 - 0.08), rl = Math.max(0.4, zAr - zCr - 0.1);
      B.box(body, "trim", bmw && isM(entry) ? COL.black : COL.alu, 0.035, 0.03, rl, rx, H + 0.05, (zAr + zCr)/2);
      [zAr - 0.08, zCr + 0.12].forEach(function(z){ B.box(body, "trim", COL.black, 0.04, 0.05, 0.06, rx, H + 0.02, z); });
    }
  });
  if(!(bugatti && hyper)){
    B.box(body, "trim", 0xeceee6, 0.52, 0.11, 0.012, 0, gc + 0.2, L/2 + 0.035);                            // the plates
    B.box(body, "trim", COL.dark, 0.34, 0.035, 0.004, 0, gc + 0.2, L/2 + 0.043);
  }
  B.box(body, "trim", 0xeceee6, 0.52, 0.11, 0.012, 0, gc + 0.3, -L/2 - 0.012);
  B.box(body, "trim", COL.dark, 0.34, 0.035, 0.004, 0, gc + 0.3, -L/2 - 0.02);
  if(!hyper){
    B.box(body, "tail", COL.red, 0.32, 0.03, 0.03, 0, top - 0.03, zCr - 0.02);                            // the third brake light
    B.side(body, "trim", COL.black, [[zCr + 0.08, H], [zCr + 0.12, H + 0.05], [zCr + 0.22, H]], 0.05, 0, 1);   // the fin
  }
  if(st.type === "hatch") B.box(body, "paint", null, tw*0.95, 0.035, 0.24, 0, H - 0.01, zCr - 0.02, 0.1, 0, 0);   // the roof spoiler
  if(st.type === "sedan" && bmw && isM(entry)) B.box(body, "paint", null, W*0.6, 0.025, 0.07, 0, yt + 0.012, -L/2 + 0.16);
  if(hyper || st.type === "coupe" || isM(entry)){
    B.box(body, "trim", COL.black, W*0.86, 0.022, 0.14, 0, gc + 0.012, L/2 - 0.04);                       // the splitter
    for(var fi = -2; fi <= 2; fi++) B.box(body, "trim", COL.black, 0.02, 0.12, 0.3, fi*W*0.12, gc + 0.07, -L/2 + 0.16);   // diffuser fins
  }
  // the wheels: the front ones in steer holders
  var tw = hyper ? 0.3 : 0.26, wx = W/2 - tw/2 - 0.03, rim = bugatti ? COL.alu : bmw && isM(entry) ? COL.grey : COL.steel;
  var wheels = [], cal = bugatti ? COL.alu : bmw && isM(entry) ? COL.bmwBlue : hyper ? COL.red : COL.grey;
  [[-wx, zf, "steer-l", -1], [wx, zf, "steer-r", 1], [-wx, zr, null, -1], [wx, zr, null, 1]].forEach(function(p, i){
    var h = B.node(root, p[2], p[0], R, p[1]);
    wheels.push(carWheel(B, h, "wheel-" + i, R, tw, p[3], rim, bugatti ? 7 : 5, cal, bmw && isM(entry)));
  });
  finish(T, root);
  return {g: root, meta: {kind: "car", R: R, radii: [R, R, R, R], lean: hyper ? -0.04 : -0.08, riderK: riderK}};
}

/* ---------- bikes ---------- */
// a bike's wheel: a round-profile tyre, the rim's bright lip, cast spokes (wire spokes: an adventure bike's), the
// discs (front: one or two, the rear's on the right), the rear's sprocket on the left (model-local +x)
function bikeWheel(B, p, name, R, tw, rim, discs, x, y, z, wire, sprocket){
  var T = B.T, w = B.node(p, name, x, y, z), tr = tw/2;
  var tyre = new T.TorusGeometry(R - tr, tr, 6, 22); tyre.rotateY(PI/2);
  B.add(w, "wheel", tyre, COL.tyre);
  var lip = new T.TorusGeometry(R - tw*0.95, 0.014, 3, 20); lip.rotateY(PI/2);
  B.add(w, "wheel", lip, rim);
  [1, -1].forEach(function(s){
    B.add(w, "wheel", new T.CircleGeometry(R - tw*0.95, 16), COL.black, s*tw*0.12, 0, 0, 0, s*PI/2, 0);
    if(wire){ for(var k = 0; k < 12; k++){ var a = k/12*PI*2 + (s > 0 ? 0 : PI/12); B.box(w, "wheel", COL.steel, 0.006, R - tw, 0.006, s*tw*0.14, Math.cos(a)*(R - tw)/2, Math.sin(a)*(R - tw)/2, a, 0, s*0.12); } }
    else for(var k2 = 0; k2 < 3; k2++){ var a2 = k2/3*PI*2 + (s > 0 ? 0 : PI/3); B.box(w, "wheel", rim, 0.012, R*0.6, 0.04, s*(tw*0.12 + 0.008), Math.cos(a2)*R*0.33, Math.sin(a2)*R*0.33, a2, 0, 0); }
  });
  (discs || []).forEach(function(s){
    B.add(w, "wheel", new T.CylinderGeometry(R*0.55, R*0.55, 0.008, 16), COL.steel, s*(tr + 0.03), 0, 0, 0, 0, PI/2);
    B.add(w, "wheel", new T.CylinderGeometry(R*0.3, R*0.3, 0.012, 10), COL.dark, s*(tr + 0.03), 0, 0, 0, 0, PI/2);   // the carrier
  });
  if(sprocket) B.add(w, "wheel", new T.CylinderGeometry(R*0.4, R*0.4, 0.012, 16), COL.dark, tr + 0.035, 0, 0, 0, 0, PI/2);
  B.add(w, "wheel", new T.CylinderGeometry(0.045, 0.045, tw + 0.06, 8), COL.alu, 0, 0, 0, 0, 0, PI/2);
  return w;
}
function buildBike(T, entry, st, d){
  var B = new Builder(T), root = new T.Group(), body = B.node(root, "body");
  var S = BIKE[st.type], WB = d.wheelbaseM, sc = d.heightM/DIMS["bike." + st.type].heightM;
  var Rr = S.Rr, Rf = S.Rf, zr = -WB/2, zf = WB/2, yh = S.head*sc, ys = S.seat*Math.min(1.1, Math.max(0.9, sc));
  var zh = zf - 0.3, zp = zr + WB*0.42, yp = 0.46, sp = entry.spec || {};
  var ktm = st.brand === "ktm", bmw = st.brand === "bmw", sport = st.type === "sport", adv = st.type === "adventure", naked = st.type === "naked";
  var boxer = sp.layout === "boxer" || (bmw && adv && (+sp.cc || 1300) > 900), small = (+sp.cc || 0) > 0 ? +sp.cc <= 400 : /\b[1-4]\d\d\b/.test(String(entry.model || ""));
  var frame = ktm ? COL.ktm : bmw ? COL.alu : COL.grey, accent = ktm ? COL.ktm : bmw && sport ? COL.bmwBlue : COL.grey;
  var zs0 = zr + WB*0.5, zs1 = zr + WB*0.12;
  // the frame: KTM's orange trellis, a BMW's aluminium beams
  [1, -1].forEach(function(sx){
    var x = sx*0.11;
    if(ktm){
      B.bar(body, "trim", frame, [x*0.5, yh - 0.04, zh - 0.02], [x, yp + 0.06, zp + 0.02], 0.022, null, true);
      B.bar(body, "trim", frame, [x*0.5, yh - 0.02, zh - 0.04], [x, ys - 0.06, zs0], 0.022, null, true);
      B.bar(body, "trim", frame, [x, ys - 0.06, zs0], [x, yp + 0.06, zp + 0.02], 0.018, null, true);
      B.bar(body, "trim", frame, [x, yh - 0.2, zh - 0.2], [x, ys - 0.06, zs0 + 0.12], 0.016, null, true);
    } else B.bar(body, "trim", frame, [x*0.6, yh - 0.04, zh - 0.02], [x, yp + 0.08, zp + 0.04], 0.07, 0.12);
    B.bar(body, "trim", ktm ? COL.black : bmw ? COL.alu : COL.grey, [x, yp, zp], [x*1.05, Rr, zr], 0.04, 0.07);   // the swingarm
    B.bar(body, "trim", COL.dark, [x*0.9, ys - 0.08, zs0 - 0.02], [x*0.6, ys - 0.06, zr + 0.12], 0.03, 0.04);     // the subframe
  });
  B.bar(body, "trim", accent, [0, yp + 0.04, zp - 0.02], [0, ys - 0.1, zs0 - 0.05], 0.03, null, true);         // the shock
  // the engine: a single, a twin or a four; a boxer's cylinders stand out either side
  var ew = small ? 0.26 : sport ? 0.4 : 0.34, ez = zr + WB*0.6, eh = small ? 0.34 : 0.4;
  B.box(body, "trim", COL.grey, ew, eh, 0.42, 0, 0.32 + eh/2, ez);
  B.box(body, "trim", COL.dark, ew*0.85, 0.2, 0.22, 0, 0.32 + eh + 0.06, ez + 0.08, -0.35, 0, 0);
  if(boxer) [1, -1].forEach(function(sx){ B.box(body, "trim", COL.alu, 0.22, 0.16, 0.2, sx*0.3, 0.52, ez + 0.12); B.box(body, "trim", COL.black, 0.06, 0.18, 0.22, sx*0.42, 0.52, ez + 0.12); });
  // the exhaust (right side, -x)
  if(sport) B.bar(body, "trim", COL.steel, [-0.17, 0.46, zr + WB*0.3], [-0.19, 0.58, zr + WB*0.12], 0.055, null, true);
  else if(adv) B.bar(body, "trim", COL.steel, [-0.21, 0.58, zr + WB*0.26], [-0.23, 0.7, zr + WB*0.04], 0.065, null, true);
  else B.box(body, "trim", ktm ? COL.black : COL.steel, 0.12, 0.13, small ? 0.3 : 0.4, -0.16, 0.36, zr + WB*0.45);
  B.bar(body, "trim", COL.steel, [-0.06, 0.42, ez + 0.2], [-0.14, 0.32, ez - 0.05], 0.025, null, true);       // the header
  // the tank and the shrouds (paint), the seat, the tail
  var tw = naked ? 0.36 : sport ? 0.34 : 0.44, tTop = ys + (adv ? 0.14 : 0.12);
  B.side(body, "paint", null, [[zh - 0.04, yh - 0.1], [zh - 0.06, yh + 0.03], [zs0 + 0.1, tTop, zh - 0.25, tTop + 0.03], [zs0, ys - 0.02],
                               [zs0 + 0.08, ys - 0.14], [zh - 0.16, yh - 0.24]], tw, 0.03, 4);
  if(naked || adv) [1, -1].forEach(function(sx){ B.box(body, "paint", null, 0.03, 0.2, 0.32, sx*(tw/2 + 0.02), yh - 0.2, zh - 0.18, 0.25, 0, -sx*0.18); });
  if(ktm && naked) [1, -1].forEach(function(sx){ B.box(body, "trim", COL.black, 0.02, 0.06, 0.26, sx*(tw/2 + 0.04), yh - 0.1, zh - 0.18, 0.25, 0, -sx*0.18); });
  B.side(body, "trim", COL.black, [[zs0 + 0.02, ys - 0.03], [zs0 + 0.04, ys + 0.03], [zs1, ys + (sport ? 0.08 : 0.04)], [zs1 - 0.02, ys - 0.03]], sport ? 0.26 : 0.3, 0.015, 2);
  var tip = sport ? [zr - 0.12, ys + 0.18] : adv ? [zr - 0.06, ys + 0.06] : [zr - 0.04, ys + 0.1];
  B.side(body, "paint", null, [[zs1 + 0.02, ys - 0.04], [zs1, ys + (sport ? 0.1 : 0.05)], tip, [tip[0] + 0.06, tip[1] - 0.12], [zs1 - 0.05, ys - 0.14]], sport ? 0.2 : 0.18, 0.02, 2);
  if(adv) B.box(body, "trim", COL.black, 0.32, 0.03, 0.34, 0, ys + 0.09, zr + 0.02);                         // the luggage rack
  B.box(body, "tail", COL.red, 0.1, 0.035, 0.02, 0, tip[1] - 0.06, tip[0] + 0.02);
  B.box(body, "trim", COL.dark, 0.18, 0.12, 0.012, 0, ys - 0.2, zr - 0.12, 0.4, 0, 0);                        // the plate
  [1, -1].forEach(function(sx){ B.box(body, "light", COL.amber, 0.04, 0.025, 0.04, sx*0.12, ys - 0.12, zr - 0.1); });
  B.add(body, "trim", (function(){ var g = new T.TorusGeometry(Rr + 0.04, 0.025, 3, 10, PI*0.45); g.rotateZ(PI*0.3); g.rotateY(PI/2); return g; })(), COL.black, 0, Rr, zr);   // the hugger
  // the pegs
  var fz = sport ? zr + WB*0.3 : zr + WB*0.4, fy = sport ? 0.44 : 0.36;
  [1, -1].forEach(function(sx){ B.box(body, "trim", COL.steel, 0.1, 0.025, 0.04, sx*0.2, fy, fz); });
  anchor(T, root, "a-foot-l", 0.2, fy + 0.02, fz); anchor(T, root, "a-foot-r", -0.2, fy + 0.02, fz);
  anchor(T, root, "a-seat", 0, ys + 0.02, zr + WB*(sport ? 0.3 : 0.33));
  // the front, frame-mounted: a sport bike's fairing and screen; an adventure bike's beak, fairing, screen, X light
  if(sport){
    // the fairing: a pointed nose out over the front wheel, the upper round the steering head, the lower down to the belly pan
    B.side(body, "paint", null, [[zf + 0.02, yh - 0.14], [zh + 0.14, yh + 0.07], [zh - 0.2, yh - 0.02], [zr + WB*0.52, 0.52],
                                 [zr + WB*0.6, 0.27], [zh - 0.02, 0.32], [zh + 0.14, yh - 0.42], [zf - 0.04, yh - 0.3]], 0.42, 0.07, 3);
    B.side(body, "glass", null, [[zh + 0.15, yh + 0.06], [zh - 0.08, yh + 0.2], [zh - 0.12, yh + 0.15], [zh + 0.06, yh + 0.04]], 0.28, 0.005, 1);
    [1, -1].forEach(function(sx){
      B.box(body, "light", COL.head, 0.09, 0.035, 0.03, sx*0.08, yh - 0.17, zf - 0.0, 0, sx*0.35, 0);
      B.box(body, "trim", COL.black, 0.07, 0.04, 0.05, sx*(d.widthM/2 - 0.035), yh + 0.04, zh + 0.06);         // mirrors
    });
    if(bmw) B.box(body, "trim", COL.bmwBlue, 0.02, 0.06, 0.5, 0.29, yh - 0.25, zh - 0.1, 0.4, 0, 0);
  }
  if(adv){
    B.side(body, "paint", null, [[zf + 0.16, Rf*2 + 0.06], [zf + 0.2, Rf*2 + 0.1], [zh + 0.12, yh - 0.06], [zh + 0.02, yh - 0.16]], 0.16, 0.02, 2);
    B.box(body, "paint", null, 0.38, 0.3, 0.22, 0, yh + 0.04, zh + 0.18);
    B.side(body, "glass", null, [[zh + 0.26, yh + 0.16], [zh + 0.07, yh + 0.42], [zh + 0.01, yh + 0.4], [zh + 0.18, yh + 0.14]], 0.36, 0.005, 1);
    [0.6, -0.6].forEach(function(r){ B.box(body, "light", COL.drl, 0.03, 0.2, 0.02, 0, yh + 0.04, zh + 0.3, 0, 0, r); });
    [1, -1].forEach(function(sx){ B.bar(body, "trim", COL.black, [sx*0.18, 0.62, ez + 0.3], [sx*0.36, 0.42, ez + 0.08], 0.02, null, true); });   // crash bars
  }
  // detail: the chain and its guard, the rear caliper, the radiator, the clutch cover and the head's fins, the tank's
  // stripe and cap, pillion pegs, a skid plate (adventure), winglets (an M superbike), the tail tidy
  var rtw = sport ? 0.19 : 0.16, cx = 0.12, fsz = zp + 0.08, fsy = yp - 0.02, rs = Rr*0.4;
  B.bar(body, "trim", COL.dark, [cx, fsy + 0.045, fsz], [cx, Rr + rs, zr], 0.012, 0.02);                    // the chain, top run
  B.bar(body, "trim", COL.dark, [cx, fsy - 0.045, fsz], [cx, Rr - rs, zr], 0.012, 0.02);                    // and bottom
  B.add(body, "trim", new T.CylinderGeometry(0.05, 0.05, 0.02, 10), COL.dark, cx, fsy, fsz, 0, 0, PI/2);     // the front sprocket
  B.bar(body, "trim", COL.black, [cx + 0.01, fsy + 0.09, fsz - 0.05], [cx + 0.01, Rr + rs + 0.05, zr + 0.2], 0.008, 0.05);   // the guard
  B.box(body, "trim", COL.gold, 0.04, 0.09, 0.07, -(rtw/2 + 0.05), Rr + Rr*0.45, zr - Rr*0.2, 0.5, 0, 0);   // the rear caliper
  if(!boxer){
    B.box(body, "trim", COL.dark, ew + 0.12, small ? 0.26 : 0.34, 0.05, 0, 0.32 + eh*0.65, ez + 0.3, -0.25, 0, 0);   // the radiator
    B.box(body, "trim", COL.grey, ew + 0.06, small ? 0.2 : 0.28, 0.01, 0, 0.32 + eh*0.65, ez + 0.33, -0.25, 0, 0);
  }
  B.add(body, "trim", new T.CylinderGeometry(0.12, 0.12, 0.03, 14), ktm ? COL.ktm : COL.alu, ew/2 + 0.015, 0.42, ez - 0.02, 0, 0, PI/2);   // the clutch cover
  for(var fi = 0; fi < 3; fi++) B.box(body, "trim", COL.alu, ew*0.9, 0.012, 0.25, 0, 0.32 + eh - 0.02 - fi*0.05, ez + 0.06);   // the head's fins
  B.bar(body, "trim", ktm ? COL.ktm : bmw ? (sport ? 0xd02030 : COL.bmwBlue) : 0xf0f0f0, [0, yh + 0.045, zh - 0.1], [0, tTop + 0.012, zs0 + 0.16], 0.07, 0.012);   // the stripe
  B.add(body, "trim", new T.CylinderGeometry(0.04, 0.04, 0.02, 10), COL.alu, 0.07, (yh + tTop)/2 + 0.04, (zh + zs0)/2 + 0.02);   // the filler cap
  [1, -1].forEach(function(sx){ B.box(body, "trim", COL.steel, 0.08, 0.02, 0.035, sx*0.19, fy + 0.12, zr + WB*0.18); });          // pillion pegs
  if(adv){
    B.box(body, "trim", COL.alu, ew + 0.1, 0.03, 0.5, 0, 0.27, ez + 0.02, -0.06, 0, 0);                     // the skid plate
    [1, -1].forEach(function(sx){ B.bar(body, "trim", COL.black, [sx*0.17, ys - 0.08, zr + 0.25], [sx*0.19, ys - 0.24, zr - 0.05], 0.016, null, true); });   // the rack's rails
  }
  if(sport && bmw && /\bM\b|M 1000/.test(String(entry.model || ""))) [1, -1].forEach(function(sx){ B.box(body, "trim", COL.dark, 0.09, 0.012, 0.16, sx*0.24, yh - 0.12, zh - 0.02, 0, 0, -sx*0.3); });   // winglets
  B.bar(body, "trim", COL.black, [0, tip[1] - 0.09, tip[0] + 0.04], [0, ys - 0.2, zr - 0.08], 0.05, 0.012);   // the tail tidy
  // the steering: fork, front wheel, mudguard, bars (clip-ons on a sport bike), a naked bike's headlight
  var steer = B.node(root, "steer", 0, yh, zh);
  var fx = [zf - zh, Rf - yh], forkCol = ktm ? COL.ktm : sport ? COL.gold : COL.steel;
  [1, -1].forEach(function(sx){ B.bar(steer, "trim", forkCol, [sx*0.085, 0.02, 0.02], [sx*0.085, fx[1] + 0.05, fx[0] - 0.01], 0.028, null, true); });
  B.box(steer, "trim", COL.dark, 0.24, 0.05, 0.1, 0, 0.0, 0.0);
  B.add(steer, "trim", (function(){ var g = new T.TorusGeometry(Rf + 0.035, 0.03, 3, 10, PI*0.4); g.rotateZ(PI*0.32); g.rotateY(PI/2); return g; })(), adv ? COL.black : COL.dark, 0, fx[1], fx[0]);
  var grips, by0 = 0;
  if(sport){
    [1, -1].forEach(function(sx){ B.bar(steer, "trim", COL.black, [sx*0.1, 0.0, -0.02], [sx*0.3, 0.0, -0.1], 0.016, null, true); });
    grips = [0.3, 0.0, -0.1]; by0 = 0.04;
  } else {
    var bw = Math.max(0.3, d.widthM/2 - 0.012), by = adv ? 0.2 : 0.13, bz = adv ? -0.22 : -0.17; by0 = by;
    B.bar(steer, "trim", COL.black, [bw, by, bz], [-bw, by, bz], 0.014, null, true);
    B.bar(steer, "trim", COL.dark, [0, 0.02, 0], [0, by, bz], 0.02, null, true);
    if(adv) [1, -1].forEach(function(sx){ B.box(steer, "paint", null, 0.08, 0.06, 0.12, sx*(bw - 0.02), by + 0.02, bz + 0.08); });
    [1, -1].forEach(function(sx){ B.bar(steer, "trim", COL.black, [sx*(bw - 0.12), by, bz], [sx*(bw - 0.06), by + 0.13, bz - 0.04], 0.008, null, true); B.box(steer, "trim", COL.black, 0.09, 0.05, 0.02, sx*(bw - 0.05), by + 0.15, bz - 0.04); });
    grips = [bw - 0.04, by, bz];
  }
  if(naked){
    B.box(steer, "trim", COL.black, 0.16, 0.18, 0.1, 0, -0.06, 0.12);
    if(ktm){ [1, -1].forEach(function(sx){ B.box(steer, "light", COL.head, 0.045, 0.15, 0.02, sx*0.04, -0.06, 0.175); B.box(steer, "light", COL.drl, 0.02, 0.1, 0.02, sx*0.085, -0.03, 0.17, 0, 0, sx*0.5); }); }
    else B.add(steer, "light", new T.CylinderGeometry(0.075, 0.075, 0.02, 14), COL.head, 0, -0.05, 0.18, PI/2, 0, 0);
  }
  // the fork's lower legs and axle clamps, the front calipers, the top clamp, grips, levers and their reservoirs, the dash
  [1, -1].forEach(function(sx){
    var lo = [sx*0.085, fx[1] + 0.04, fx[0] - 0.01], hi = [sx*0.085, fx[1]*0.45, fx[0]*0.45 + 0.01];
    B.bar(steer, "trim", sport || ktm ? COL.dark : COL.steel, lo, hi, 0.036, null, true);
    if(!small || sx < 0) B.box(steer, "trim", COL.gold, 0.035, 0.11, 0.06, sx*0.085, fx[1] + Rf*0.4, fx[0] - Rf*0.4, -0.6, 0, 0);
    B.add(steer, "trim", new T.CylinderGeometry(0.03, 0.03, 0.05, 8), COL.black, sx*(grips[0] + 0.035), grips[1], grips[2], 0, 0, PI/2);   // a grip
    B.bar(steer, "trim", COL.alu, [sx*(grips[0] - 0.07), grips[1] + 0.01, grips[2] + 0.04], [sx*(grips[0] + 0.03), grips[1], grips[2] + 0.07], 0.008, 0.012);   // a lever
    B.box(steer, "trim", COL.dark, 0.04, 0.035, 0.035, sx*(grips[0] - 0.09), grips[1] + 0.03, grips[2] + 0.01);   // its reservoir
  });
  B.box(steer, "trim", COL.alu, 0.22, 0.025, 0.08, 0, 0.04, -0.02);                                           // the top clamp
  B.box(steer, "trim", COL.black, 0.14, 0.09, 0.03, 0, sport ? 0.06 : by0 + 0.06, sport ? 0.02 : -0.04, -0.6, 0, 0);   // the dash
  B.box(steer, "light", 0x9fd8ff, 0.11, 0.06, 0.004, 0, sport ? 0.065 : by0 + 0.065, sport ? 0.005 : -0.055, -0.6, 0, 0);
  anchor(T, steer, "a-grip-l", grips[0], grips[1], grips[2]); anchor(T, steer, "a-grip-r", -grips[0], grips[1], grips[2]);
  var rim = ktm && naked ? COL.ktm : bmw && sport ? COL.bmwBlue : adv ? COL.alu : COL.black;
  var wire = adv && (ktm || !small);
  bikeWheel(B, root, "wheel-0", Rr, rtw, rim, [-1], 0, Rr, zr, wire, true);
  bikeWheel(B, steer, "wheel-1", Rf, 0.12, rim, small ? [-1] : [1, -1], 0, fx[1], fx[0], wire, false);
  finish(T, root);
  return {g: root, meta: {kind: "bike", R: Rr, radii: [Rr, Rf], lean: S.lean, riderK: null}};
}

/* ---------- materials, the cache, the rig ---------- */
var PER = typeof WeakMap === "function" ? new WeakMap() : null;   // per three.js (keyed on its Mesh class: a module namespace is frozen)
function store(T){
  var s = PER && PER.get(T.Mesh);
  if(!s){ s = {bp: {}, mats: null}; if(PER) PER.set(T.Mesh, s); }
  return s;
}
function shared(T){
  var st = store(T);
  if(st.mats) return st.mats;
  return (st.mats = {
    trim: new T.MeshStandardMaterial({vertexColors: true, roughness: 0.55, metalness: 0.35}),
    wheel: new T.MeshStandardMaterial({vertexColors: true, roughness: 0.62, metalness: 0.4}),
    glass: new T.MeshStandardMaterial({color: 0x16202a, metalness: 0.6, roughness: 0.06, transparent: true, opacity: 0.62, depthWrite: false}),
    light: new T.MeshBasicMaterial({vertexColors: true})
  });
}
function keyOf(entry, st, d, k){ return [entry.id || "?", st.kind, st.type, st.brand, st.ev ? 1 : 0, d.lengthM, d.widthM, d.heightM, d.wheelbaseM, k].join("|"); }
function blueprint(T, entry){
  var st = styleOf(entry), d = dims(entry), k = scaleOf(entry), key = keyOf(entry, st, d, k), BP = store(T).bp;
  if(BP[key]) return BP[key];
  var bp = st.kind === "bike" ? buildBike(T, entry, st, d) : buildCar(T, entry, st, d);
  return (BP[key] = {st: st, d: d, k: k, bp: k === 1 ? bp : scaled(bp, k)});
}
// the display scale, baked into the blueprint: every node's offset and every vertex × k (rotations kept), so the
// rig's anchors, wheel radii and positions are all in shown metres and the rig's root stays at scale 1
function scaled(bp, k){
  bp.g.traverse(function(o){
    if(o !== bp.g) o.position.multiplyScalar(k);
    if(o.isMesh){ o.geometry.scale(k, k, k); o.geometry.computeBoundingSphere(); }
  });
  var m = bp.meta;
  m.R *= k; m.radii = m.radii.map(function(r){ return r*k; });
  if(m.riderK) m.riderK = Math.min(0.85, m.riderK*k);      // the same driver, in the same share of the bigger cabin
  return bp;
}
function paintOf(entry, paint){
  if(paint != null) return paint;
  var p = entry && entry.paints && entry.paints[0];
  return p != null ? p : 0x2a4d8f;
}
function isStarter(entry){ return !entry || entry.starter === true || !(entry["class"] || entry.kind || entry.type); }

function build(c, entry, paint, opts){
  opts = opts || {};
  var T = c && c.Mesh ? c : c && c.THREE;
  if(!T) throw new Error("hqVehicleModels.build: no THREE");
  if(isStarter(entry) && c && !c.Mesh){                 // the starters: hq3d's own car and motorbike
    var bike = styleOf(entry).kind === "bike";
    if(bike && c.moto) return c.moto(paintOf(entry, paint));
    if(!bike && c.car) return c.car(paintOf(entry, paint));
  }
  var B = blueprint(T, entry || {}), bp = B.bp, M = shared(T);
  var g = bp.g.clone(true);
  var pm = new T.MeshStandardMaterial({color: paintOf(entry, paint), metalness: 0.55, roughness: 0.3});
  pm.userData.paint = true;
  var tail = new T.MeshBasicMaterial({vertexColors: true, color: 0x8c8c8c});
  var meshes = [];
  g.traverse(function(o){
    if(!o.isMesh) return;
    var mk = o.userData.mk; meshes.push(o);
    o.material = mk === "paint" ? pm : mk === "tail" ? tail : M[mk] || M.trim;
  });
  function get(n){ return g.getObjectByName(n); }
  var car = bp.meta.kind === "car", on = null;
  var rig = {
    g: g, entry: entry, dims: B.d, scale: B.k, kind: bp.meta.kind, paint: pm, standin: get("body"), meshes: meshes,
    wheels: car ? [0, 1, 2, 3].map(function(i){ return get("wheel-" + i); }) : [get("wheel-0"), get("wheel-1")],
    steer: car ? [get("steer-l"), get("steer-r")] : get("steer"), spin: car ? get("spin") : null,
    R: bp.meta.R, radii: bp.meta.radii.slice(), lean: bp.meta.lean,
    seat: get("a-seat"), grips: [get("a-grip-l"), get("a-grip-r")], feet: [get("a-foot-l"), get("a-foot-r")],
    brake: function(b){ b = !!b; if(b === on) return; on = b; tail.color.setHex(b ? 0xffffff : 0x8c8c8c); },
    setPaint: function(hex){ pm.color.setHex(hex); if(rig.glbPaint) rig.glbPaint.forEach(function(m){ m.color.setHex(hex); }); },
    // roll forward d metres with the bars / front wheels turned st (-1..1)
    roll: function(dd, s){
      rig.wheels.forEach(function(w, i){ if(w) w.rotation.x += dd/(rig.radii[i] || rig.R); });
      if(s == null) return;
      if(car){ rig.steer.forEach(function(h){ if(h) h.rotation.y = s*0.5; }); if(rig.spin) rig.spin.rotation.z = -s*1.6; }
      else if(rig.steer) rig.steer.rotation.y = s*0.4;
    },
    ready: null
  };
  if(car){ rig.hats = false; rig.riderK = bp.meta.riderK; }
  g.userData.rig = rig; g.name = "vehicle:" + ((entry && entry.id) || "?");
  var m3 = entry && entry.model3d;
  if(m3 && m3.file){
    var loader = opts.loader || (c && c.L && c.L.loader);
    if(loader) rig.ready = attachModel(T, rig, m3, loader, opts.base == null ? "/games/" : opts.base);
  }
  return rig;
}

/* ---------- a real model, swapped in when it has loaded ---------- */
var GLB = {};
function loadGlb(loader, url){
  return GLB[url] || (GLB[url] = new Promise(function(res, rej){
    loader.load(url, function(gl){ res(gl.scene || gl); }, undefined, function(e){ delete GLB[url]; rej(e); });
  }));
}
function attachModel(T, rig, m3, loader, base){
  var url = /^(https?:)?\//.test(m3.file) ? m3.file : base + m3.file;
  return loadGlb(loader, url).then(function(scene){
    if(rig.disposed) return rig;
    var o = scene.clone(true), box = new T.Box3().setFromObject(o), size = box.getSize(new T.Vector3());
    var len = (+m3.lengthM > 0 ? +m3.lengthM : rig.dims.lengthM)*(rig.scale || 1), s = len/Math.max(1e-3, size.z);
    var wrap = new T.Group(); wrap.name = "glb";
    o.scale.multiplyScalar(s);
    box.setFromObject(o);
    var ctr = box.getCenter(new T.Vector3());
    o.position.x -= ctr.x; o.position.z -= ctr.z; o.position.y -= box.min.y;
    wrap.add(o);
    // paint: the named material, one copy per vehicle
    var pname = m3.paintMaterial, seen = {}, paints = [];
    o.traverse(function(n){
      if(!n.isMesh) return;
      n.castShadow = true; n.receiveShadow = true;
      var mats = Array.isArray(n.material) ? n.material : [n.material];
      mats = mats.map(function(m){
        if(!m || !pname || m.name !== pname) return m;
        if(!seen[m.uuid]){ seen[m.uuid] = m.clone(); seen[m.uuid].color.copy(rig.paint.color); seen[m.uuid].userData.paint = true; paints.push(seen[m.uuid]); }
        return seen[m.uuid];
      });
      n.material = Array.isArray(n.material) ? mats : mats[0];
    });
    rig.glbPaint = paints;
    // wheels: named nodes take over; the front ones steer about y after they spin about x
    var names = m3.wheels || (rig.kind === "car" ? ["wheel-0", "wheel-1", "wheel-2", "wheel-3"] : ["wheel-0", "wheel-1"]);
    var found = names.map(function(n){ return o.getObjectByName(n); });
    rig.g.add(wrap);
    if(rig.standin) rig.standin.visible = false;
    rig.g.traverse(function(n){ if(/^wheel-\d$/.test(n.name) && !isInside(n, wrap)) n.visible = false; });
    if(rig.spin) rig.spin.visible = false;
    if(found.every(Boolean)){
      found.forEach(function(w){ w.rotation.order = "YXZ"; });
      rig.wheels.length = 0; found.forEach(function(w){ rig.wheels.push(w); });
      rig.radii = found.map(function(w){ var b = new T.Box3().setFromObject(w); return Math.max(0.05, (b.max.y - b.min.y)/2); });
      if(rig.kind === "car") rig.steer = [found[0], found[1]];
      else rig.steer = found[1];
    } else rig.wheels.length = 0;
    rig.model = "glb";
    return rig;
  });
}
function isInside(n, root){ for(var p = n; p; p = p.parent) if(p === root) return true; return false; }

function triangles(rig){ var t = 0; (rig.meshes || []).forEach(function(m){ var g = m.geometry; t += (g.index ? g.index.count : g.attributes.position.count)/3; }); return Math.round(t); }
function drawCalls(rig){ return (rig.meshes || []).length; }
function clearCache(T){ var BP = store(T).bp; Object.keys(BP).forEach(function(k){ BP[k].bp.g.traverse(function(o){ if(o.isMesh) o.geometry.dispose(); }); delete BP[k]; }); }

HQV.hqVehicleModels = {build: build, dims: dims, shown: shown, scaleOf: scaleOf, SCALE: SCALE, styleOf: styleOf, triangles: triangles, drawCalls: drawCalls, clearCache: clearCache,
                       DIMS: DIMS, CAR: CAR, BIKE: BIKE};
})();
