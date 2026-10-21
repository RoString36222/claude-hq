/* Claude HQ: stand-in 3D bodies for the vehicle catalogue (HQV.hqVehicleModels), docs/plans/dealership-spec.md.
 *
 * Every catalogue vehicle drives from the start: until its real glTF model is imported, it gets a body built
 * here from its kind and type (car: hatch, sedan, coupe, suv, hyper, an electric sedan; bike: naked, sport,
 * adventure) from its real size (drawn at SCALE, below), with cheap brand cues (BMW kidneys and angel eyes, the
 * Bugatti horseshoe, C-line and quad LEDs, KTM's orange trellis and split headlight, the GS beak and X light) and
 * the starters' level of detail (3.5.5): a car's round-shouldered tyres, alloys, discs and calipers, shut lines,
 * handles, plates, indicators, fogs, wipers, fin, SUV rails and cladding, splitter and diffuser; a bike's round
 * tyres (wire spokes on the big adventure bikes), discs and calipers, chain and sprockets, radiator, fins, tank
 * stripe, fork legs, grips, levers, dash, skid plate, winglets. 3.5.6 adds the next layer, mostly as patches of one
 * shared detail atlas (a canvas drawn once, below) rather than geometry: a car's cabin through lighter glass (seats
 * with headrests, the glowing cluster and centre screen, console, steering-wheel spokes), projector headlights with a
 * DRL strip, LED tail bars, honeycomb grille mesh, generic round badges, tyre sidewall lettering, quad/twin/centre
 * exhaust tips, side skirts, chrome or black window trim, mirror indicators, a fuel flap, lettered plates; a bike's
 * headers, collector and end can, the shock's spring and reservoir, swingarm pivot and chain adjusters, foot controls,
 * brake hoses and cables, fork caps, bar-end weights, knee pads, rim tape, a plate hanger, trellis triangulation.
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
 * Budget: under 6k triangles per vehicle (about 3.8-5.0k a bike, 4.4-5.4k a car), 8-10 draw calls a bike, 14 a car
 * (the atlas adds none: every textured part rides a material the vehicle already draws).
 * Each rigid piece (the body; each wheel; a bike's steering; a car's steering wheel; a car's wheel holder, for its
 * caliper) is merged into one mesh per material, and the body uses at most five: paint (recolourable, one
 * per vehicle), trim (vertex coloured: black, greys, chrome, KTM orange), glass, lights (vertex coloured, unlit)
 * and the tail lights (unlit; brighter on the brake); trim, wheel, lights and tail also sample the detail atlas.
 * Geometry is built once per catalogue entry and shared by every copy; only the paint and tail materials are per vehicle.
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

// [3.5.6] the detail atlas: one small canvas, drawn once per three.js and shared by every vehicle's trim, wheel,
// light and tail materials (it multiplies the vertex colours). A part that names no patch samples the white one,
// so it looks as before; a patch is [x, y, w, h] in the canvas. Generic art only: no logos, no lettering of brands.
var AW = 1024, AH = 512;
var ATLAS = {
  white: [0, 0, 64, 64], honey: [64, 0, 256, 128], head: [320, 0, 192, 96], ledbar: [512, 0, 256, 64],
  gauges: [768, 0, 256, 128], ledcell: [512, 64, 64, 64], radfin: [576, 64, 128, 64],
  tyre: [0, 128, 1024, 48], plate: [0, 192, 192, 64], knee: [192, 192, 128, 64], badge: [320, 176, 80, 80],
  rimtape: [400, 176, 80, 80], screen: [480, 176, 192, 80], stitch: [672, 176, 128, 80], bikehead: [800, 176, 96, 96]
};
var UV = {};
Object.keys(ATLAS).forEach(function(k){
  var r = ATLAS[k], i = k === "white" ? r[2]/2 - 1 : 1.5;        // inset off the patch's edge (the white one: its middle)
  UV[k] = [(r[0] + i)/AW, 1 - (r[1] + r[3] - i)/AH, (r[0] + r[2] - i)/AW, 1 - (r[1] + i)/AH];
});
function drawAtlas(cv){
  var x = cv.getContext("2d"), P = ATLAS;
  function rect(r, c){ x.fillStyle = c; x.fillRect(r[0], r[1], r[2], r[3]); }
  function clip(r, f){ x.save(); x.beginPath(); x.rect(r[0], r[1], r[2], r[3]); x.clip(); f(r[0], r[1], r[2], r[3]); x.restore(); }
  function circ(cx, cy, rr, c, line){ x.beginPath(); x.arc(cx, cy, rr, 0, PI*2); if(line){ x.strokeStyle = c; x.lineWidth = line; x.stroke(); } else { x.fillStyle = c; x.fill(); } }
  rect(P.white, "#ffffff");
  // a honeycomb grille mesh: dark cells, lighter webs
  clip(P.honey, function(X, Y, W, H){
    x.fillStyle = "#0b0c0e"; x.fillRect(X, Y, W, H); x.strokeStyle = "#5d636b"; x.lineWidth = 2.2;
    for(var row = 0; row * 11 < H + 12; row++) for(var col = 0; col * 18 < W + 18; col++){
      var cx = X + col*18 + (row % 2 ? 9 : 0), cy = Y + row*11; x.beginPath();
      for(var k = 0; k < 6; k++){ var a = PI/6 + k*PI/3; x[k ? "lineTo" : "moveTo"](cx + Math.cos(a)*6.4, cy + Math.sin(a)*6.4); }
      x.closePath(); x.stroke();
    }
  });
  // a headlight: a dark housing, two projector lenses, an LED daytime strip along its foot
  clip(P.head, function(X, Y, W, H){
    x.fillStyle = "#5a616b"; x.fillRect(X, Y, W, H);
    [0.27, 0.73].forEach(function(f){ circ(X + W*f, Y + H*0.42, H*0.3, "#2a2e33"); circ(X + W*f, Y + H*0.42, H*0.22, "#ffffff"); circ(X + W*f - 4, Y + H*0.36, H*0.07, "#cfe6ff"); });
    x.fillStyle = "#ffffff"; x.fillRect(X + W*0.06, Y + H*0.82, W*0.88, H*0.1);
  });
  // a tail light bar: a glowing light guide over a row of LED cells
  clip(P.ledbar, function(X, Y, W, H){
    x.fillStyle = "#3a0d10"; x.fillRect(X, Y, W, H);
    x.fillStyle = "#ffffff"; x.fillRect(X, Y + H*0.16, W, H*0.18);
    for(var i = 0; i < 16; i++){ x.fillStyle = "#e0e0e0"; x.fillRect(X + 4 + i*W/16, Y + H*0.5, W/16 - 8, H*0.34); }
  });
  // the instrument cluster: two dials and a strip of screen
  clip(P.gauges, function(X, Y, W, H){
    x.fillStyle = "#07090c"; x.fillRect(X, Y, W, H);
    [0.25, 0.75].forEach(function(f){ circ(X + W*f, Y + H*0.5, H*0.36, "#5fb6ff", 4); x.strokeStyle = "#ff5a3c"; x.lineWidth = 4; x.beginPath(); x.moveTo(X + W*f, Y + H*0.5); x.lineTo(X + W*f + H*0.22, Y + H*0.3); x.stroke(); });
    x.fillStyle = "#1d3b55"; x.fillRect(X + W*0.42, Y + H*0.3, W*0.16, H*0.4);
  });
  clip(P.ledcell, function(X, Y, W, H){ x.fillStyle = "#30353b"; x.fillRect(X, Y, W, H); for(var i = 0; i < 3; i++) for(var j = 0; j < 2; j++){ x.fillStyle = "#ffffff"; x.fillRect(X + 6 + i*19, Y + 10 + j*24, 14, 18); } });
  // a radiator core: fine fins in a frame
  clip(P.radfin, function(X, Y, W, H){ x.fillStyle = "#2b2f35"; x.fillRect(X, Y, W, H); x.fillStyle = "#8b929b"; for(var i = 0; i < W; i += 4) x.fillRect(X + i, Y + 6, 1.5, H - 12); });
  // a tyre's sidewall: generic size and load codes, raised in a shade lighter than the rubber
  clip(P.tyre, function(X, Y, W, H){
    x.fillStyle = "#1c1d21"; x.fillRect(X, Y, W, H); x.fillStyle = "#7e8289"; x.font = "bold 30px sans-serif"; x.textBaseline = "middle";
    ["275/35 R19 100Y", "HQ SPORT", "275/35 R19 100Y", "RADIAL TUBELESS"].forEach(function(s, i){ x.fillText(s, X + 20 + i*W/4, Y + H/2); });
  });
  // a number plate: white, a thin border, generic characters
  clip(P.plate, function(X, Y, W, H){
    x.fillStyle = "#eceee6"; x.fillRect(X, Y, W, H); x.strokeStyle = "#202226"; x.lineWidth = 3; x.strokeRect(X + 3, Y + 3, W - 6, H - 6);
    x.fillStyle = "#16181b"; x.font = "bold 40px sans-serif"; x.textAlign = "center"; x.textBaseline = "middle"; x.fillText("HQ 35 6", X + W/2, Y + H/2 + 2); x.textAlign = "start";
  });
  // a knee pad: ribbed rubber
  clip(P.knee, function(X, Y, W, H){ x.fillStyle = "#1a1b1e"; x.fillRect(X, Y, W, H); x.fillStyle = "#3b3e44"; for(var i = 4; i < W; i += 10) x.fillRect(X + i, Y + 4, 4, H - 8); });
  // a generic round badge: a bright rim, a dark field, a bright centre
  clip(P.badge, function(X, Y, W, H){ x.fillStyle = "#16181b"; x.fillRect(X, Y, W, H); circ(X + W/2, Y + H/2, W*0.46, "#d9dee4"); circ(X + W/2, Y + H/2, W*0.36, "#1d2a3a"); circ(X + W/2, Y + H/2, W*0.14, "#c9ced4"); });
  // a wheel face with its rim tape: black, a bright ring near the edge (tinted by the vertex colour)
  clip(P.rimtape, function(X, Y, W, H){ x.fillStyle = "#000000"; x.fillRect(X, Y, W, H); circ(X + W/2, Y + H/2, W*0.43, "#ffffff", W*0.05); });
  // the centre screen: a map-ish dark panel
  clip(P.screen, function(X, Y, W, H){
    x.fillStyle = "#0b1622"; x.fillRect(X, Y, W, H); x.strokeStyle = "#3d6f99"; x.lineWidth = 3;
    x.beginPath(); x.moveTo(X + 10, Y + H*0.8); x.lineTo(X + W*0.4, Y + H*0.45); x.lineTo(X + W*0.62, Y + H*0.6); x.lineTo(X + W - 10, Y + H*0.2); x.stroke();
    x.fillStyle = "#22384d"; x.fillRect(X + W*0.72, Y + 8, W*0.24, H - 16);
  });
  // seat leather: channels and stitching
  clip(P.stitch, function(X, Y, W, H){
    x.fillStyle = "#2b2d32"; x.fillRect(X, Y, W, H); x.fillStyle = "#1c1e22";
    for(var i = 0; i < 5; i++) x.fillRect(X + W*0.12 + i*W*0.17, Y + H*0.1, 3, H*0.8);
    x.strokeStyle = "#8a8f98"; x.lineWidth = 1; x.setLineDash([3, 3]); x.strokeRect(X + 5, Y + 5, W - 10, H - 10); x.setLineDash([]);
  });
  // a round bike headlight: a projector, a ring of daytime LEDs
  clip(P.bikehead, function(X, Y, W, H){ x.fillStyle = "#2a2d31"; x.fillRect(X, Y, W, H); circ(X + W/2, Y + H/2, W*0.4, "#ffffff", W*0.07); circ(X + W/2, Y + H/2, W*0.2, "#ffffff"); circ(X + W/2, Y + H/2, W*0.09, "#cfe6ff"); });
}
function atlasTex(T, s){
  if(s.atlas !== undefined) return s.atlas;
  s.atlas = null;
  if(typeof document === "undefined" || !document.createElement || !T.CanvasTexture) return null;   // node (the tests): plain colours
  try {
    var cv = document.createElement("canvas"); cv.width = AW; cv.height = AH; drawAtlas(cv);
    var t = new T.CanvasTexture(cv); if(T.SRGBColorSpace) t.colorSpace = T.SRGBColorSpace; t.anisotropy = 4;
    s.atlas = t;
  } catch(e){ s.atlas = null; }
  return s.atlas;
}

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
// t("patch"): the next part shows that patch of the detail atlas (chainable: B.t("honey").plate(...))
Builder.prototype.t = function(name){ this.uvr = UV[name] || null; return this; };
// a geometry built along +y from its origin, laid from a to b
Builder.prototype.along = function(node, mk, col, geo, a, b){
  var T = this.T, dv = new T.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  this.q.setFromUnitVectors(new T.Vector3(0, 1, 0), dv.normalize()); this.v.set(a[0], a[1], a[2]);
  this.m.compose(this.v, this.q, this.one); geo.applyMatrix4(this.m);
  return this.put(node, mk, geo, col);
};
// a thin pipe through the points (a cable, a hose, a header): a round rod per leg
Builder.prototype.pipe = function(node, mk, col, pts, r){
  for(var i = 1; i < pts.length; i++) this.bar(node, mk, col, pts[i - 1], pts[i], r, null, true);
};
// a coil spring from a to b: a helix of n turns, radius rr, wire w
Builder.prototype.spring = function(node, mk, col, a, b, rr, w, n){
  var T = this.T, len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]), c = new T.Curve();
  c.getPoint = function(t, out){ out = out || new T.Vector3(); var an = t*n*PI*2; return out.set(Math.cos(an)*rr, t*len, Math.sin(an)*rr); };
  return this.along(node, mk, col, new T.TubeGeometry(c, Math.round(n*8), w, 3, false), a, b);
};
// a flat rounded panel on a car's flank (a fuel flap), w (along z) × h, facing out on side sx
Builder.prototype.flank = function(node, mk, col, w, h, d, r, x, y, z, sx){
  var g = new this.T.ExtrudeGeometry(rrShape(this.T, w, h, r), {depth: d, bevelEnabled: false, curveSegments: 3});
  g.translate(0, 0, -d/2);
  return this.add(node, mk, g, col, x, y, z, 0, sx*PI/2, 0);
};
// a flat ring facing ±x (a tyre's sidewall), its uvs polar: u round it, v out from r0 to r1
Builder.prototype.ring = function(node, mk, col, r0, r1, seg, x, side){
  var T = this.T, g = new T.RingGeometry(r0, r1, seg, 1), uv = g.attributes.uv;
  for(var i = 0; i < uv.count; i++) uv.setXY(i, (i % (seg + 1))/seg, i < seg + 1 ? 0 : 1);
  return this.add(node, mk, g, col, x, 0, 0, 0, side*PI/2, 0);
};
Builder.prototype.node = function(parent, name, x, y, z){
  var g = new this.T.Group(); if(name) g.name = name; g.position.set(x || 0, y || 0, z || 0);
  g.userData.parts = {}; parent.add(g); return g;
};
Builder.prototype.put = function(node, mk, geo, col){
  var T = this.T, g = geo.index ? geo.toNonIndexed() : geo;
  if(g !== geo) geo.dispose();
  ["uv1", "uv2"].forEach(function(a){ if(g.attributes[a]) g.deleteAttribute(a); });
  // the atlas patch named by t() for this one part (its own 0..1 uvs squeezed into it), else the white patch
  var r = this.uvr, src = g.attributes.uv, nv = g.attributes.position.count, uv = new Float32Array(nv*2), w = UV.white;
  this.uvr = null;
  for(var j = 0; j < nv; j++){
    if(r && src){ uv[j*2] = r[0] + Math.min(1, Math.max(0, src.getX(j)))*(r[2] - r[0]); uv[j*2 + 1] = r[1] + Math.min(1, Math.max(0, src.getY(j)))*(r[3] - r[1]); }
    else { uv[j*2] = w[0]; uv[j*2 + 1] = w[1]; }
  }
  g.setAttribute("uv", new T.BufferAttribute(uv, 2));
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
  // a textured plate: its uvs projected flat across its face (an extrusion's own are in metres)
  var p = g.attributes.position, uv = g.attributes.uv;
  for(var i = 0; i < p.count; i++) uv.setXY(i, p.getX(i)/w + 0.5, p.getY(i)/h + 0.5);
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
      var P = new Float32Array(n*3), N = new Float32Array(n*3), U = new Float32Array(n*2), C = col ? new Float32Array(n*3) : null, at = 0;
      list.forEach(function(g){
        var c = g.attributes.position.count;
        P.set(g.attributes.position.array, at*3); N.set(g.attributes.normal.array, at*3); U.set(g.attributes.uv.array, at*2);
        if(C) C.set(g.attributes.color.array, at*3);
        at += c; g.dispose();
      });
      var out = new T.BufferGeometry();
      out.setAttribute("position", new T.BufferAttribute(P, 3)); out.setAttribute("normal", new T.BufferAttribute(N, 3));
      out.setAttribute("uv", new T.BufferAttribute(U, 2));
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
  B.t("tyre").ring(w, "wheel", 0xffffff, R*0.7, R - sh*0.9, 24, side*(tw/2 + 0.003), side);              // [3.5.6] the sidewall's lettering
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
  B.t("badge").add(w, "wheel", new T.CylinderGeometry(0.03, 0.03, 0.03, 10), 0xffffff, ox + side*0.016, 0, 0, 0, 0, PI/2);   // the centre cap
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
  // [3.5.6] the window trim: chrome on the plain cars, black (shadowline) on the quick ones, aluminium on a Bugatti
  var wtc = bugatti ? COL.alu : (isM(entry) || hyper || st.type === "coupe" || st.type === "hatch") ? COL.black : COL.chrome;
  [1, -1].forEach(function(sx){
    B.bar(body, "paint", null, [bx(0, sx), yb - 0.02, zA], [bx(1, sx), top, zAr], 0.06, 0.07);                // A pillar
    B.bar(body, hyper ? "trim" : "paint", COL.black, [bx(0, sx), yb - 0.02, zC + 0.05], [bx(1, sx), top, zCr + 0.04], 0.08, 0.15);   // C
    var zb = (zA + zC)/2 + 0.1, zbt = (zAr + zCr)/2 + 0.06;
    if(!hyper) B.bar(body, "trim", COL.black, [bx(0, sx), yb - 0.02, zb], [bx(1, sx), top, zbt], 0.035, 0.07);   // B
    B.box(body, "trim", wtc, 0.02, 0.025, Math.max(0.2, zA - zC - 0.1), sx*(gw/2 + 0.005), yb + 0.005, (zA + zC)/2);   // the belt line
    B.bar(body, "trim", wtc, [bx(0.97, sx), top - 0.02, zAr - 0.04], [bx(0.97, sx), top - 0.02, zCr + 0.06], 0.016, 0.02);   // the window's top trim
    B.box(body, "paint", null, 0.07, 0.07, 0.15, sx*(W/2 + 0.05), yb + 0.08, zA - 0.12);                   // a mirror
    B.box(body, "trim", COL.black, 0.04, 0.09, Math.max(0.2, WB - 2*ar - 0.1), sx*(W/2 - 0.01), gc + 0.07, (zf + zr)/2);   // the sill
  });
  // inside: two seats, the dash; the steering wheel (spin) in front of the driver (right-hand drive: -x)
  var ys = gc + S.seat, zS = (zA + zCr)/2 + (hyper ? 0.15 : -0.05), xd = -W*0.21, head = top - 0.04 - ys;
  var k = Math.max(0.55, Math.min(1.0, head/1.22)), riderK = 0.8*k;
  var hb = Math.min(0.62, head*0.75);
  [xd, -xd].forEach(function(x){
    B.t("stitch").box(body, "trim", 0xffffff, 0.48, 0.12, 0.48, x, ys - 0.06, zS);
    B.t("stitch").box(body, "trim", 0xffffff, 0.46, hb, 0.1, x, ys + hb/2, zS - 0.28, -0.12, 0, 0);
    if(ys + hb + 0.16 < top - 0.03) B.box(body, "trim", COL.dark, 0.26, 0.13, 0.09, x, ys + hb + 0.085, zS - 0.29 - 0.12*(hb + 0.08));   // [3.5.6] a headrest
  });
  B.box(body, "trim", COL.black, W*0.8, 0.12, 0.3, 0, yb - 0.02, zA - 0.12);
  // [3.5.6] the cabin through the glass: the cluster and the centre screen (they glow), the console and its selector
  B.t("gauges").box(body, "light", 0xffffff, 0.3, 0.09, 0.01, xd, yb + 0.07, zA - 0.25, -0.35, 0, 0);
  B.box(body, "trim", COL.black, 0.34, 0.03, 0.08, xd, yb + 0.12, zA - 0.23);                             // the cluster's hood
  B.t("screen").box(body, "light", 0xffffff, 0.26, 0.13, 0.01, 0, yb + 0.1, zA - 0.2, -0.25, 0, 0);
  var cTop = Math.min(yb - 0.08, ys + 0.2), cLen = Math.max(0.3, zA - zS - 0.2);
  B.box(body, "trim", COL.dark, 0.16, cTop - ys + 0.12, cLen, 0, (cTop + ys - 0.12)/2, zS + 0.02 + cLen/2);
  B.box(body, "trim", COL.chrome, 0.04, 0.06, 0.05, 0, cTop + 0.03, zS + 0.25);
  var col = new T.Group(); col.position.set(xd, ys + 0.42*k, zS + 0.36*k); col.rotation.x = -0.6; root.add(col);
  var spin = B.node(col, "spin");
  B.add(spin, "trim", new T.TorusGeometry(0.15*k, 0.02, 4, 16), COL.black);
  B.box(spin, "trim", bmw && isM(entry) ? COL.bmwBlue : COL.grey, 0.06, 0.06, 0.03, 0, 0, 0);
  [PI/2, -PI/2, PI].forEach(function(a){ B.box(spin, "trim", COL.dark, 0.022, 0.15*k, 0.016, Math.sin(a)*0.075*k, Math.cos(a)*0.075*k, 0, 0, 0, -a); });   // [3.5.6] its spokes
  var gx = 0.15*k*Math.sin(1.05), gy = 0.15*k*Math.cos(1.05);
  anchor(T, spin, "a-grip-l", gx, gy, 0.02); anchor(T, spin, "a-grip-r", -gx, gy, 0.02);
  anchor(T, root, "a-foot-l", xd + 0.11, gc + 0.12, zS + 0.62*k); anchor(T, root, "a-foot-r", xd - 0.11, gc + 0.12, zS + 0.62*k);
  anchor(T, root, "a-seat", xd, ys, zS);
  // the front: lights, the grille (by brand), the bumper's intake
  var zN = L/2 + 0.004, yl = yn - 0.15;
  B.t("honey").box(body, "trim", 0xffffff, W*0.62, 0.13, 0.06, 0, gc + 0.2, L/2 - 0.01);                  // the lower intake (its mesh)
  if(bugatti){
    // the horseshoe: an open ring, its gap at the top, round a dark mesh; quad LED strips each side
    var hs = Math.min(0.22, yn - gc - 0.12)*0.85, gap = 0.62*PI, tor = new T.TorusGeometry(hs, 0.025, 4, 18, 2*PI - gap);
    tor.rotateZ(PI/2 + gap/2);
    B.add(body, "trim", tor, COL.chrome, 0, gc + 0.22 + hs, zN + 0.01);
    B.t("honey").add(body, "trim", new T.CircleGeometry(hs - 0.01, 14), 0xffffff, 0, gc + 0.22 + hs, zN + 0.005);
    [1, -1].forEach(function(sx){ for(var i = 0; i < 4; i++) B.t("ledcell").box(body, "light", COL.drl, 0.05, 0.03, 0.02, sx*(W*0.24 + i*0.065), yl + 0.02, zN); });
    var bg = new T.CircleGeometry(0.035, 14); bg.scale(1.5, 1, 1);                                     // [3.5.6] an oval badge atop the horseshoe
    B.t("badge").add(body, "trim", bg, 0xffffff, 0, gc + 0.22 + 2*hs - 0.01, zN + 0.03);
  } else {
    var kid = bmw;
    [1, -1].forEach(function(sx){
      B.box(body, "trim", COL.black, W*0.24, 0.11, 0.04, sx*W*0.31, yl, zN - 0.012);                    // the headlight housing
      if(bmw){                                                                                          // angel eyes, round projectors
        [0.25, 0.36].forEach(function(f){ B.add(body, "light", new T.TorusGeometry(0.042, 0.008, 3, 12), COL.drl, sx*W*f, yl, zN + 0.008); });
        B.t("head").box(body, "light", 0xffffff, W*0.22, 0.095, 0.004, sx*W*0.305, yl, zN + 0.006);
      } else B.t("head").box(body, "light", COL.head, W*0.2, 0.06, 0.02, sx*W*0.31, yl, zN);           // [3.5.6] projectors and a DRL strip
    });
    if(kid){                                                                                            // the kidneys
      var tall = isM(entry) && st.type !== "suv", big = st.type === "suv" || st.ev;
      var kw = big ? 0.26 : tall ? 0.19 : 0.23, kh = big ? 0.26 : tall ? 0.3 : 0.17, ky = gc + 0.24 + kh/2 + (tall ? 0 : 0.04);
      ky = Math.min(ky, yn - 0.06 - kh/2);
      [1, -1].forEach(function(sx){
        B.plate(body, "trim", st.ev ? COL.bmwBlue : COL.alu, kw, kh, 0.03, 0.05, sx*(kw/2 + 0.02), ky, zN + 0.005);
        if(st.ev) B.plate(body, "trim", COL.grey, kw - 0.03, kh - 0.03, 0.03, 0.04, sx*(kw/2 + 0.02), ky, zN + 0.012);
        else B.t("honey").plate(body, "trim", 0xffffff, kw - 0.03, kh - 0.03, 0.03, 0.04, sx*(kw/2 + 0.02), ky, zN + 0.012);
        if(!st.ev) for(var j = -1; j <= 1; j++) B.box(body, "trim", COL.alu, 0.012, kh - 0.05, 0.012, sx*(kw/2 + 0.02) + j*kw*0.26, ky, zN + 0.03);   // the slats
      });
    } else if(!st.ev) B.t("honey").plate(body, "trim", 0xffffff, W*0.42, 0.14, 0.03, 0.04, 0, yl - 0.02, zN + 0.004);
    // [3.5.6] a generic round badge: on the grille, else on the nose above the kidneys
    if(kid) B.t("badge").add(body, "trim", new T.CircleGeometry(0.035, 14), 0xffffff, 0, yn - 0.002, L/2 - 0.08, -1.0, 0, 0);
    else B.t("badge").add(body, "trim", new T.CircleGeometry(0.035, 14), 0xffffff, 0, yl - 0.02, zN + 0.022);
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
  if(bugatti) B.t("ledbar").box(body, "tail", COL.red, W*0.82, 0.035, 0.02, 0, yt - 0.16, zT);
  else [1, -1].forEach(function(sx){
    B.t("ledbar").box(body, "tail", COL.red, W*0.2, 0.05, 0.02, sx*W*0.37, yr, zT);                     // [3.5.6] an LED light bar
    if(bmw) B.box(body, "tail", COL.red, 0.05, 0.1, 0.02, sx*W*0.28, yr - 0.03, zT);                 // the L
  });
  // [3.5.6] the tips: quad on an M car or a hypercar, twin otherwise, Bugatti's one wide centre pipe; each a bright
  // open sleeve round a dark mouth
  if(!st.ev){
    var tip = function(ex, r){
      B.add(body, "trim", new T.CylinderGeometry(r, r, 0.12, 12, 1, true), COL.chrome, ex, gc + 0.1, -L/2 + 0.02, PI/2, 0, 0);
      B.add(body, "trim", new T.CircleGeometry(r*0.85, 12), 0x050505, ex, gc + 0.1, -L/2 + 0.02, 0, PI, 0);
    };
    if(bugatti){ var bt = new T.CylinderGeometry(0.06, 0.06, 0.1, 12, 1, true); bt.scale(2.2, 1, 1); B.add(body, "trim", bt, COL.alu, 0, gc + 0.1, -L/2 + 0.02, PI/2, 0, 0);
                 var bm = new T.CircleGeometry(0.052, 12); bm.scale(2.2, 1, 1); B.add(body, "trim", bm, 0x050505, 0, gc + 0.1, -L/2 + 0.03, 0, PI, 0); }
    else { var nx = isM(entry) || hyper ? 4 : 2; for(var i = 0; i < nx; i++) tip((i < nx/2 ? 1 : -1)*(W*0.3 + (i % 2)*0.1), nx > 2 ? 0.042 : 0.048); }
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
    // [3.5.6] the mirror's indicator strip, the side skirt (black on the quick ones, else body colour)
    B.box(body, "light", COL.amber, 0.05, 0.012, 0.012, sx*(W/2 + 0.06), yb + 0.06, zA - 0.045, 0, -sx*0.35, 0);
    var sk = isM(entry) || hyper || st.type === "coupe", skl = Math.max(0.3, WB - 2*ar - 0.08);
    B.box(body, sk ? "trim" : "paint", COL.black, 0.05, 0.035, skl, sx*(W/2 + 0.012), gc + 0.025, (zf + zr)/2);
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
  if(!(bugatti && hyper)) B.t("plate").box(body, "trim", 0xffffff, 0.52, 0.11, 0.012, 0, gc + 0.2, L/2 + 0.035);   // the plates
  B.t("plate").box(body, "trim", 0xffffff, 0.52, 0.11, 0.012, 0, gc + 0.3, -L/2 - 0.012);
  // [3.5.6] the rear badge; the fuel (charge) flap over the rear wheel, its shut line round it
  B.t("badge").add(body, "trim", new T.CircleGeometry(0.035, 14), 0xffffff, 0, bugatti ? yt - 0.25 : yt - 0.15, -L/2 - 0.006, 0, PI, 0);
  var ffs = st.ev ? 1 : -1, ffy = Math.min(yb - 0.08, Math.max(archTop + 0.08, (archTop + yb)/2)), ffh = Math.min(0.11, Math.max(0.06, yb - archTop - 0.06));
  B.flank(body, "trim", COL.black, 0.17, ffh + 0.012, 0.004, 0.03, ffs*(W/2 + 0.001), ffy, zr + 0.02, ffs);
  B.flank(body, "paint", null, 0.155, ffh, 0.006, 0.025, ffs*(W/2 + 0.003), ffy, zr + 0.02, ffs);
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
function bikeWheel(B, p, name, R, tw, rim, discs, x, y, z, wire, sprocket, tape){
  var T = B.T, w = B.node(p, name, x, y, z), tr = tw/2;
  var tyre = new T.TorusGeometry(R - tr, tr, 6, 22); tyre.rotateY(PI/2);
  B.add(w, "wheel", tyre, COL.tyre);
  var lip = new T.TorusGeometry(R - tw*0.95, 0.014, 3, 20); lip.rotateY(PI/2);
  B.add(w, "wheel", lip, rim);
  [1, -1].forEach(function(s){
    B.t("rimtape").add(w, "wheel", new T.CircleGeometry(R - tw*0.95, 20), tape || COL.grey, s*tw*0.12, 0, 0, 0, s*PI/2, 0);   // [3.5.6] its rim tape
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
  var zs0 = zr + WB*0.5, zs1 = zr + WB*0.12, rtw0 = sport ? 0.19 : 0.16;
  // the frame: KTM's orange trellis, a BMW's aluminium beams
  [1, -1].forEach(function(sx){
    var x = sx*0.11;
    if(ktm){
      B.bar(body, "trim", frame, [x*0.5, yh - 0.04, zh - 0.02], [x, yp + 0.06, zp + 0.02], 0.022, null, true);
      B.bar(body, "trim", frame, [x*0.5, yh - 0.02, zh - 0.04], [x, ys - 0.06, zs0], 0.022, null, true);
      B.bar(body, "trim", frame, [x, ys - 0.06, zs0], [x, yp + 0.06, zp + 0.02], 0.018, null, true);
      B.bar(body, "trim", frame, [x, yh - 0.2, zh - 0.2], [x, ys - 0.06, zs0 + 0.12], 0.016, null, true);
      // [3.5.6] the trellis's triangulation: two more tubes between the rails
      var m1 = [x*0.75, (yh - 0.04 + yp + 0.06)/2, (zh - 0.02 + zp + 0.02)/2], m2 = [x*0.8, (yh - 0.02 + ys - 0.06)/2, (zh - 0.04 + zs0)/2];
      B.bar(body, "trim", frame, m1, m2, 0.014, null, true);
      B.bar(body, "trim", frame, m1, [x, ys - 0.06, zs0], 0.014, null, true);
    } else B.bar(body, "trim", frame, [x*0.6, yh - 0.04, zh - 0.02], [x, yp + 0.08, zp + 0.04], 0.07, 0.12);
    B.bar(body, "trim", ktm ? COL.black : bmw ? COL.alu : COL.grey, [x, yp, zp], [x*1.05, Rr, zr], 0.04, 0.07);   // the swingarm
    B.bar(body, "trim", COL.dark, [x*0.9, ys - 0.08, zs0 - 0.02], [x*0.6, ys - 0.06, zr + 0.12], 0.03, 0.04);     // the subframe
  });
  // the shock: its body, the spring round it (by brand), a piggyback reservoir
  var sa = [0, yp + 0.04, zp - 0.02], sb = [0, ys - 0.1, zs0 - 0.05], sl = function(f){ return [sa[0] + (sb[0] - sa[0])*f, sa[1] + (sb[1] - sa[1])*f, sa[2] + (sb[2] - sa[2])*f]; };
  B.bar(body, "trim", COL.dark, sa, sb, 0.022, null, true);
  B.spring(body, "trim", ktm ? COL.ktm : sport ? COL.gold : bmw ? 0xd8dde3 : 0xc8302c, sl(0.18), sl(0.78), 0.04, 0.007, 6);
  B.bar(body, "trim", COL.gold, sl(0.85), [0.06, sb[1] - 0.02, sb[2] - 0.02], 0.022, null, true);
  // [3.5.6] the swingarm's pivot bolt, the chain adjusters and axle nuts at its back, the chain slider
  B.add(body, "trim", new T.CylinderGeometry(0.025, 0.025, 0.28, 8), COL.alu, 0, yp, zp, 0, 0, PI/2);
  [1, -1].forEach(function(sx){
    B.box(body, "trim", COL.alu, 0.014, 0.034, 0.07, sx*0.145, Rr, zr + 0.05);
    B.add(body, "trim", new T.CylinderGeometry(0.022, 0.022, 0.016, 6), COL.chrome, sx*0.153, Rr, zr, 0, 0, PI/2);
  });
  B.box(body, "trim", COL.black, 0.02, 0.02, 0.2, 0.115, yp + (Rr - yp)*0.25 + 0.035, zp - 0.25*(zp - zr), Math.atan2(yp - Rr, zp - zr), 0, 0);
  // the engine: a single, a twin or a four; a boxer's cylinders stand out either side
  var ew = small ? 0.26 : sport ? 0.4 : 0.34, ez = zr + WB*0.6, eh = small ? 0.34 : 0.4;
  B.box(body, "trim", COL.grey, ew, eh, 0.42, 0, 0.32 + eh/2, ez);
  B.box(body, "trim", COL.dark, ew*0.85, 0.2, 0.22, 0, 0.32 + eh + 0.06, ez + 0.08, -0.35, 0, 0);
  if(boxer) [1, -1].forEach(function(sx){ B.box(body, "trim", COL.alu, 0.22, 0.16, 0.2, sx*0.3, 0.52, ez + 0.12); B.box(body, "trim", COL.black, 0.06, 0.18, 0.22, sx*0.42, 0.52, ez + 0.12); });
  // the exhaust (right side, -x)
  // [3.5.6] the system: a header per cylinder (a boxer's from its heads) curling down under the engine to a
  // collector, a link pipe to the end can (sport: short and high on the side; adventure: big and high; naked: low,
  // under the belly), its end cap, mouth and clamp
  var ca, cb, cr;
  if(sport){ ca = [-0.17, 0.46, zr + WB*0.3]; cb = [-0.19, 0.58, zr + WB*0.12]; cr = 0.055; }
  else if(adv){ ca = [-0.21, 0.58, zr + WB*0.26]; cb = [-0.23, 0.7, zr + WB*0.04]; cr = 0.065; }
  if(ca){
    B.bar(body, "trim", COL.steel, ca, cb, cr, null, true);
    var cd = [cb[0] - ca[0], cb[1] - ca[1], cb[2] - ca[2]], cn = Math.hypot(cd[0], cd[1], cd[2]), cu = cd.map(function(v){ return v/cn; });
    var cp = function(f){ return [ca[0] + cd[0]*f, ca[1] + cd[1]*f, ca[2] + cd[2]*f]; };
    B.bar(body, "trim", sport ? COL.dark : COL.black, cp(0.86), [cb[0] + cu[0]*0.02, cb[1] + cu[1]*0.02, cb[2] + cu[2]*0.02], cr + 0.006, null, true);   // the end cap
    B.bar(body, "trim", 0x050505, cb, [cb[0] + cu[0]*0.025, cb[1] + cu[1]*0.025, cb[2] + cu[2]*0.025], cr*0.45, null, true);                   // the mouth
    B.bar(body, "trim", COL.dark, cp(0.04), cp(0.12), cr + 0.004, null, true);                                                                   // the clamp
  } else {
    var nl = small ? 0.3 : 0.4, nz = zr + WB*0.45;
    B.box(body, "trim", ktm ? COL.black : COL.steel, 0.12, 0.13, nl, -0.16, 0.36, nz);
    [0.03, -0.03].forEach(function(dx){ B.add(body, "trim", new T.CylinderGeometry(0.022, 0.022, 0.03, 8), COL.dark, -0.16 + dx, 0.34, nz - nl/2 - 0.01, PI/2, 0, 0); });   // twin outlets
    ca = [-0.13, 0.36, nz + nl/2 - 0.02];
  }
  var col0 = [-0.1, 0.26, ez - 0.15], nh = boxer ? 2 : small ? 1 : sport ? 4 : 2;
  for(var hi = 0; hi < nh; hi++){
    var hx = boxer ? (hi ? -1 : 1)*0.36 : -ew/2 + ew*(hi + 0.5)/nh, hy = boxer ? 0.48 : 0.32 + eh*0.8;
    B.pipe(body, "trim", COL.steel, [[hx, hy, boxer ? ez + 0.18 : ez + 0.2], [hx*0.95, 0.33, ez + 0.24], [hx*0.5 - 0.03, 0.25, ez + 0.06], col0], 0.018);
  }
  B.pipe(body, "trim", COL.steel, [col0, [-0.14, 0.3, col0[2] - 0.08], ca], 0.03);                         // the link pipe
  // the tank and the shrouds (paint), the seat, the tail
  var tw = naked ? 0.36 : sport ? 0.34 : 0.44, tTop = ys + (adv ? 0.14 : 0.12);
  B.side(body, "paint", null, [[zh - 0.04, yh - 0.1], [zh - 0.06, yh + 0.03], [zs0 + 0.1, tTop, zh - 0.25, tTop + 0.03], [zs0, ys - 0.02],
                               [zs0 + 0.08, ys - 0.14], [zh - 0.16, yh - 0.24]], tw, 0.03, 4);
  [1, -1].forEach(function(sx){ B.t("knee").box(body, "trim", 0xffffff, 0.012, 0.12, 0.17, sx*(tw/2 + 0.004), ys + 0.0, zs0 + 0.2, 0, 0, -sx*0.06); });   // [3.5.6] knee pads
  if(naked || adv) [1, -1].forEach(function(sx){ B.box(body, "paint", null, 0.03, 0.2, 0.32, sx*(tw/2 + 0.02), yh - 0.2, zh - 0.18, 0.25, 0, -sx*0.18); });
  if(ktm && naked) [1, -1].forEach(function(sx){ B.box(body, "trim", COL.black, 0.02, 0.06, 0.26, sx*(tw/2 + 0.04), yh - 0.1, zh - 0.18, 0.25, 0, -sx*0.18); });
  B.side(body, "trim", COL.black, [[zs0 + 0.02, ys - 0.03], [zs0 + 0.04, ys + 0.03], [zs1, ys + (sport ? 0.08 : 0.04)], [zs1 - 0.02, ys - 0.03]], sport ? 0.26 : 0.3, 0.015, 2);
  var tip = sport ? [zr - 0.12, ys + 0.18] : adv ? [zr - 0.06, ys + 0.06] : [zr - 0.04, ys + 0.1];
  B.side(body, "paint", null, [[zs1 + 0.02, ys - 0.04], [zs1, ys + (sport ? 0.1 : 0.05)], tip, [tip[0] + 0.06, tip[1] - 0.12], [zs1 - 0.05, ys - 0.14]], sport ? 0.2 : 0.18, 0.02, 2);
  if(adv) B.box(body, "trim", COL.black, 0.32, 0.03, 0.34, 0, ys + 0.09, zr + 0.02);                         // the luggage rack
  B.t("ledbar").box(body, "tail", COL.red, 0.1, 0.035, 0.02, 0, tip[1] - 0.06, tip[0] + 0.02);           // [3.5.6] an LED bar
  B.t("plate").box(body, "trim", 0xffffff, 0.18, 0.12, 0.012, 0, ys - 0.2, zr - 0.12, 0.4, 0, 0);            // the plate
  // [3.5.6] its hanger: two struts up to the tail tidy, the plate light over it
  [1, -1].forEach(function(sx){ B.bar(body, "trim", COL.black, [sx*0.07, ys - 0.15, zr - 0.1], [sx*0.05, ys - 0.12, zr - 0.02], 0.008, null, true); });
  B.box(body, "light", COL.head, 0.05, 0.012, 0.02, 0, ys - 0.13, zr - 0.1);
  [1, -1].forEach(function(sx){ B.box(body, "light", COL.amber, 0.04, 0.025, 0.04, sx*0.12, ys - 0.12, zr - 0.1); });
  B.add(body, "trim", (function(){ var g = new T.TorusGeometry(Rr + 0.04, 0.025, 3, 10, PI*0.45); g.rotateZ(PI*0.3); g.rotateY(PI/2); return g; })(), COL.black, 0, Rr, zr);   // the hugger
  // the pegs
  var fz = sport ? zr + WB*0.3 : zr + WB*0.4, fy = sport ? 0.44 : 0.36;
  [1, -1].forEach(function(sx){ B.box(body, "trim", COL.steel, 0.1, 0.025, 0.04, sx*0.2, fy, fz); });
  // [3.5.6] the foot controls: the gear lever and its linkage (left), the brake pedal, its master cylinder and the hose
  // back to the rear caliper (right); the heel guards
  B.bar(body, "trim", COL.alu, [0.17, fy - 0.01, fz - 0.02], [0.19, fy + 0.03, fz + 0.18], 0.008, 0.014);
  B.box(body, "trim", COL.black, 0.05, 0.016, 0.016, 0.2, fy + 0.035, fz + 0.18);
  B.bar(body, "trim", COL.steel, [0.17, fy + 0.0, fz + 0.06], [0.15, fy + 0.11, fz + 0.08], 0.006, null, true);
  B.bar(body, "trim", COL.alu, [-0.17, fy - 0.01, fz - 0.02], [-0.19, fy - 0.03, fz + 0.18], 0.008, 0.014);
  B.box(body, "trim", COL.black, 0.05, 0.016, 0.02, -0.2, fy - 0.03, fz + 0.18);
  B.add(body, "trim", new T.CylinderGeometry(0.014, 0.014, 0.07, 8), COL.dark, -0.16, fy + 0.08, fz - 0.04);
  B.pipe(body, "trim", COL.black, [[-0.16, fy + 0.12, fz - 0.04], [-0.14, yp + 0.02, zp - 0.12], [-(rtw0/2 + 0.05), Rr + 0.02, zr + 0.2], [-(rtw0/2 + 0.05), Rr + Rr*0.4, zr - Rr*0.15]], 0.006);
  [1, -1].forEach(function(sx){ B.box(body, "trim", COL.alu, 0.008, 0.11, 0.12, sx*0.185, fy + 0.07, fz - 0.03, 0.2, 0, 0); });
  anchor(T, root, "a-foot-l", 0.2, fy + 0.02, fz); anchor(T, root, "a-foot-r", -0.2, fy + 0.02, fz);
  anchor(T, root, "a-seat", 0, ys + 0.02, zr + WB*(sport ? 0.3 : 0.33));
  // the front, frame-mounted: a sport bike's fairing and screen; an adventure bike's beak, fairing, screen, X light
  if(sport){
    // the fairing: a pointed nose out over the front wheel, the upper round the steering head, the lower down to the belly pan
    B.side(body, "paint", null, [[zf + 0.02, yh - 0.14], [zh + 0.14, yh + 0.07], [zh - 0.2, yh - 0.02], [zr + WB*0.52, 0.52],
                                 [zr + WB*0.6, 0.27], [zh - 0.02, 0.32], [zh + 0.14, yh - 0.42], [zf - 0.04, yh - 0.3]], 0.42, 0.07, 3);
    B.side(body, "glass", null, [[zh + 0.15, yh + 0.06], [zh - 0.08, yh + 0.2], [zh - 0.12, yh + 0.15], [zh + 0.06, yh + 0.04]], 0.28, 0.005, 1);
    [1, -1].forEach(function(sx){
      B.t("head").box(body, "light", COL.head, 0.09, 0.035, 0.03, sx*0.08, yh - 0.17, zf - 0.0, 0, sx*0.35, 0);
      B.box(body, "light", COL.drl, 0.07, 0.008, 0.01, sx*0.09, yh - 0.145, zf - 0.01, 0, sx*0.35, -sx*0.25);   // [3.5.6] the DRL brow
      B.box(body, "trim", COL.black, 0.07, 0.04, 0.05, sx*(d.widthM/2 - 0.035), yh + 0.04, zh + 0.06);         // mirrors
    });
    if(bmw) B.box(body, "trim", COL.bmwBlue, 0.02, 0.06, 0.5, 0.29, yh - 0.25, zh - 0.1, 0.4, 0, 0);
  }
  if(adv){
    B.side(body, "paint", null, [[zf + 0.16, Rf*2 + 0.06], [zf + 0.2, Rf*2 + 0.1], [zh + 0.12, yh - 0.06], [zh + 0.02, yh - 0.16]], 0.16, 0.02, 2);
    B.box(body, "paint", null, 0.38, 0.3, 0.22, 0, yh + 0.04, zh + 0.18);
    B.side(body, "glass", null, [[zh + 0.26, yh + 0.16], [zh + 0.07, yh + 0.42], [zh + 0.01, yh + 0.4], [zh + 0.18, yh + 0.14]], 0.36, 0.005, 1);
    [0.6, -0.6].forEach(function(r){ B.box(body, "light", COL.drl, 0.03, 0.2, 0.02, 0, yh + 0.04, zh + 0.3, 0, 0, r); });
    B.t("bikehead").box(body, "light", COL.head, 0.17, 0.15, 0.004, 0, yh + 0.04, zh + 0.293);              // [3.5.6] the projector behind the X
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
    B.t("radfin").box(body, "trim", 0xffffff, ew + 0.06, small ? 0.2 : 0.28, 0.01, 0, 0.32 + eh*0.65, ez + 0.33, -0.25, 0, 0);
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
    else B.t("bikehead").add(steer, "light", new T.CylinderGeometry(0.075, 0.075, 0.02, 16), COL.head, 0, -0.05, 0.18, PI/2, 0, 0);
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
  // [3.5.6] the fork caps and their adjusters, bar-end weights, the front brake hose(s) down to the calipers, the
  // clutch and throttle cables back to the headstock
  [1, -1].forEach(function(sx){
    B.add(steer, "trim", new T.CylinderGeometry(0.03, 0.03, 0.024, 10), sport ? COL.gold : ktm ? COL.ktm : COL.alu, sx*0.085, 0.064, 0.0);
    B.add(steer, "trim", new T.CylinderGeometry(0.011, 0.011, 0.016, 6), COL.gold, sx*0.085, 0.082, 0.0);
    B.add(steer, "trim", new T.CylinderGeometry(0.022, 0.022, 0.014, 8), sport ? COL.alu : COL.dark, sx*(grips[0] + 0.066), grips[1], grips[2], 0, 0, PI/2);
    if(sx < 0 || !small) B.pipe(steer, "trim", COL.black, [[sx*0.03, 0.0, 0.07], [sx*0.11, fx[1]*0.5, fx[0]*0.5 + 0.035], [sx*0.1, fx[1] + Rf*0.4 + 0.07, fx[0] - Rf*0.4 + 0.02]], 0.006);
  });
  B.pipe(steer, "trim", COL.black, [[-(grips[0] - 0.09), grips[1] + 0.03, grips[2] + 0.01], [-0.06, 0.03, 0.07], [sport || small ? -0.03 : 0.03, 0.0, 0.07]], 0.006);   // the brake line to its splitter
  B.pipe(steer, "trim", COL.black, [[grips[0] - 0.09, grips[1] + 0.0, grips[2] + 0.02], [0.08, 0.0, 0.05], [0.05, -0.12, -0.04]], 0.006);   // the clutch cable
  B.pipe(steer, "trim", COL.black, [[-(grips[0] - 0.02), grips[1] - 0.02, grips[2] + 0.02], [-0.08, -0.01, 0.04], [-0.04, -0.12, -0.04]], 0.005);   // the throttle
  B.box(steer, "trim", COL.black, 0.14, 0.09, 0.03, 0, sport ? 0.06 : by0 + 0.06, sport ? 0.02 : -0.04, -0.6, 0, 0);   // the dash
  B.box(steer, "light", 0x9fd8ff, 0.11, 0.06, 0.004, 0, sport ? 0.065 : by0 + 0.065, sport ? 0.005 : -0.055, -0.6, 0, 0);
  anchor(T, steer, "a-grip-l", grips[0], grips[1], grips[2]); anchor(T, steer, "a-grip-r", -grips[0], grips[1], grips[2]);
  var rim = ktm && naked ? COL.ktm : bmw && sport ? COL.bmwBlue : adv ? COL.alu : COL.black;
  var wire = adv && (ktm || !small);
  var tape = rim === COL.black ? (ktm ? COL.ktm : bmw ? COL.bmwBlue : 0xf0f0f0) : rim === COL.ktm ? 0xf4f4f4 : COL.black;
  if(wire) tape = COL.black;
  bikeWheel(B, root, "wheel-0", Rr, rtw, rim, [-1], 0, Rr, zr, wire, true, tape);
  bikeWheel(B, steer, "wheel-1", Rf, 0.12, rim, small ? [-1] : [1, -1], 0, fx[1], fx[0], wire, false, tape);
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
  var map = atlasTex(T, st);
  // [3.5.6] the glass a lighter tint, so the cabin reads through it
  return (st.mats = {
    trim: new T.MeshStandardMaterial({vertexColors: true, roughness: 0.55, metalness: 0.35, map: map}),
    wheel: new T.MeshStandardMaterial({vertexColors: true, roughness: 0.62, metalness: 0.4, map: map}),
    glass: new T.MeshStandardMaterial({color: 0x1d2a36, metalness: 0.5, roughness: 0.05, transparent: true, opacity: 0.42, depthWrite: false}),
    light: new T.MeshBasicMaterial({vertexColors: true, map: map})
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
  var tail = new T.MeshBasicMaterial({vertexColors: true, color: 0x8c8c8c, map: atlasTex(T, store(T))});
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
