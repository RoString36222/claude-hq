/* Claude HQ: stand-in 3D bodies for the vehicle catalogue (HQV.hqVehicleModels), docs/plans/dealership-spec.md.
 *
 * Every catalogue vehicle drives from the start: until its real glTF model is imported, it gets a body built
 * here from its kind and type (car: hatch, sedan, coupe, suv, hyper, an electric sedan, [3.17] a Formula 1 car; bike: naked, sport,
 * adventure) from its real size (drawn at SCALE, below), with cheap brand cues (BMW kidneys and angel eyes, the
 * Bugatti horseshoe, C-line and quad LEDs, KTM's orange trellis and split headlight, the GS beak and X light) and
 * the starters' level of detail (3.5.5): a car's round-shouldered tyres, alloys, discs and calipers, shut lines,
 * handles, plates, indicators, fogs, wipers, fin, SUV rails and cladding, splitter and diffuser; a bike's round
 * tyres (wire spokes on the big adventure bikes and the classics, solid discs on a cruiser), discs and calipers, chain and sprockets, radiator, fins, tank
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
 *   [3.13] opts.tune: the Tuning shop's tune (games/hqtuning.js; the Arena's canonical object). Rims, their colour and size,
 *     a wing, the exhaust and two-tone parts pick a blueprint of their own (shared by every copy of that tune); the finish,
 *     colours, tint and a plate of its own (one more mesh) are this vehicle's materials, rig.setTune(t) changes those live
 *     (false: the geometry differs, build again). A starter (c.car / c.moto) gets tuneStarter(). Anchors, wheels, radius
 *     and collision never change. Budgets tuned: a car <= 16 draw calls and < 8k triangles, a bike <= 12 and < 6k.
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
  "car.super":  {lengthM: 4.70, widthM: 2.00, heightM: 1.20, wheelbaseM: 2.70},
  "car.ev":     {lengthM: 4.78, widthM: 1.85, heightM: 1.45, wheelbaseM: 2.86},
  "car.formula": {lengthM: 5.30, widthM: 1.90, heightM: 0.95, wheelbaseM: 3.40},
  "bike.naked": {lengthM: 2.05, widthM: 0.84, heightM: 1.20, wheelbaseM: 1.40},
  "bike.sport": {lengthM: 2.07, widthM: 0.74, heightM: 1.15, wheelbaseM: 1.44},
  "bike.adventure": {lengthM: 2.21, widthM: 0.95, heightM: 1.45, wheelbaseM: 1.52},
  "bike.classic": {lengthM: 2.14, widthM: 0.79, heightM: 1.12, wheelbaseM: 1.40},
  "bike.cruiser": {lengthM: 2.37, widthM: 0.94, heightM: 1.10, wheelbaseM: 1.665},
  "bike.hypersport": {lengthM: 2.13, widthM: 0.75, heightM: 1.15, wheelbaseM: 1.47},
  "bike.scooter": {lengthM: 1.87, widthM: 0.69, heightM: 1.16, wheelbaseM: 1.265}
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
  hyper: {R: 0.36, gc: 0.10, belt: 0.66, nose: 0.46, tail: 0.66, cowl: 0.20, ws: 0.80, roofEnd: 0.50, glassEnd: -0.35, seat: 0.20, fo: 0.43},   // ([3.9] a real roof)
  // [3.9] a mid-engined supercar: a wedge (a low sharp nose, the windscreen's foot just behind the front axle, a long
  // rake), the cabin forward, an engine cover sloping from the roof to the tail
  super: {R: 0.35, gc: 0.10, belt: 0.60, nose: 0.36, tail: 0.68, cowl: 0.10, ws: 1.05, roofEnd: 0.75, glassEnd: -0.55, seat: 0.18, fo: 0.42},
  ev:    {R: 0.35, gc: 0.13, belt: 0.62, nose: 0.48, tail: 0.63, cowl: 0.30, ws: 0.74, roofEnd: 0.12, glassEnd: -0.45, seat: 0.27, fo: 0.46},
  // [3.17] an open-wheel single-seater (buildFormula draws it; these only keep styleOf from calling it a sedan)
  formula: {R: 0.36, gc: 0.05, belt: 0.6, nose: 0.3, tail: 0.5, cowl: 0.42, ws: 0.3, roofEnd: 0, glassEnd: 0, seat: 0.15, fo: 0.58}
};
// bikes: wheel radii (rear, front), the steering head's height, the seat's height, bars, lean in a bend
var BIKE = {
  naked:     {Rr: 0.31, Rf: 0.30, head: 0.94, seat: 0.82, lean: 0.45},
  sport:     {Rr: 0.31, Rf: 0.30, head: 0.90, seat: 0.84, lean: 0.52},
  adventure: {Rr: 0.34, Rf: 0.37, head: 1.04, seat: 0.87, lean: 0.40},
  // [3.9] a classic sits you upright (hips over the pegs, hands up and back); a cruiser low, feet forward on boards,
  // arms out to wide pulled-back bars, leaning back a touch; a hypersport tucked like a sport bike
  classic:   {Rr: 0.33, Rf: 0.34, head: 0.84, seat: 0.80, lean: 0.12},
  cruiser:   {Rr: 0.34, Rf: 0.34, head: 0.78, seat: 0.66, lean: -0.06},
  hypersport: {Rr: 0.31, Rf: 0.30, head: 0.90, seat: 0.82, lean: 0.50},
  // [3.14.1] a scooter: small wheels (10" rear, 12" front), sat upright with your feet on the floorboard
  scooter:   {Rr: 0.22, Rf: 0.23, head: 0.98, seat: 0.77, lean: 0.14}
};
var COL = {
  black: 0x15171a, dark: 0x24272c, grey: 0x4a4f57, steel: 0x8d959e, alu: 0xc9ced4, chrome: 0xdfe4ea,
  ktm: 0xff6a00, gold: 0xc9a227, bmwBlue: 0x1c69d4, tyre: 0x141518, kawa: 0x5fbf2a, brown: 0x4a3426, ducRed: 0xb3131f,
  head: 0xfff8ea, drl: 0xe8f4ff, amber: 0xffa31a, red: 0xff2a34,
  ti: 0x5d6fc8, carbon: 0x1d1f24                              // [3.13] blue-burnt titanium, carbon fibre
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
  rimtape: [400, 176, 80, 80], screen: [480, 176, 192, 80], stitch: [672, 176, 128, 80], bikehead: [800, 176, 96, 96],
  ylamp: [0, 272, 192, 96], hexbadge: [192, 272, 80, 80]
};
var UV = {};
// [3.13] two-tone paint: a paint part tagged t("tone2") samples the right half of the paint's own 2 x 1 texture (its
// second colour); every other paint part sits in the white patch's middle, the left half (the body colour)
UV.tone2 = [0.8, 0.4, 0.95, 0.6];
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
  // [3.9] a slim supercar headlight: a dark housing, a bright Y-shaped light guide lying on its side, a projector
  clip(P.ylamp, function(X, Y, W, H){
    x.fillStyle = "#24272c"; x.fillRect(X, Y, W, H); x.strokeStyle = "#ffffff"; x.lineWidth = H*0.11; x.lineCap = "round";
    x.beginPath(); x.moveTo(X + W*0.06, Y + H*0.5); x.lineTo(X + W*0.46, Y + H*0.5); x.lineTo(X + W*0.9, Y + H*0.16);
    x.moveTo(X + W*0.46, Y + H*0.5); x.lineTo(X + W*0.9, Y + H*0.84); x.stroke();
    circ(X + W*0.72, Y + H*0.5, H*0.13, "#cfe6ff");
  });
  // [3.9] a generic hexagonal badge: a gold rim, a black field, a thin inner hexagon (no emblem, no lettering)
  clip(P.hexbadge, function(X, Y, W, H){
    function hex(r, c, line){ x.beginPath(); for(var k = 0; k < 6; k++){ var a = k*PI/3; x[k ? "lineTo" : "moveTo"](X + W/2 + Math.cos(a)*r, Y + H/2 + Math.sin(a)*r); }
      x.closePath(); if(line){ x.strokeStyle = c; x.lineWidth = line; x.stroke(); } else { x.fillStyle = c; x.fill(); } }
    x.fillStyle = "#101113"; x.fillRect(X, Y, W, H); hex(W*0.48, "#c9a227"); hex(W*0.4, "#101113"); hex(W*0.24, "#c9a227", 3);
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
// [3.9] each catalogue car's own cues, by maker and model (an unknown model gets its type's defaults): its proportions
// over the type's (S), the grille and lights, the tails, the wheels (spokes, split pairs, colour) and extras (a power
// dome on the hood, wing gills, a ducktail, a Bugatti's spine)
function carLook(entry, st){
  var m = String((entry && entry.model) || ""), b = st.brand, bmw = b === "bmw";
  var L = {S: null, grille: bmw ? "wide" : null, lights: bmw ? "angel" : null, tail: null, spokes: 5, split: false, rim: null,
           dome: false, gills: false, ducktail: false, bug: null};
  if(bmw){
    if(/^M[34]\b/.test(m)){ L.grille = "tall"; L.dome = true; L.gills = true; L.split = true; }
    if(/CSL/.test(m)){ L.ducktail = true; L.rim = COL.gold; L.spokes = 6; L.split = false; L.tail = "laser"; L.S = {glassEnd: -0.78, roofEnd: 0.02}; }
    if(/^M2\b/.test(m)){ L.grille = "frameless"; L.lights = "square"; L.dome = true; L.spokes = 6; L.S = {belt: 0.63}; }
    if(/^M5\b/.test(m)){ L.grille = "wideLit"; L.lights = "slimV"; L.dome = true; L.gills = true; L.spokes = 10; }
    if(/^M135/.test(m)){ L.lights = "slim"; L.spokes = 5; L.split = true; }
    if(/^330|^M340/.test(m)){ L.spokes = /^M/.test(m) ? 5 : 10; L.split = /^M/.test(m); }
    if(/^i4\b/.test(m)){ L.grille = "closed"; L.spokes = 5; L.split = true; }
    if(/^i7\b/.test(m)){ L.grille = "xlLit"; L.lights = "split"; L.tail = "thin"; L.spokes = 10; L.S = {roofEnd: 0.28, belt: 0.6}; }
    if(/^XM\b/.test(m)){ L.grille = "xlLit"; L.lights = "split"; L.tail = "thin"; L.spokes = 10; L.rim = COL.dark; L.S = {belt: 0.64, roofEnd: -0.74, glassEnd: -0.86}; }
    if(/^X5\b/.test(m)){ L.grille = "xl"; L.lights = "hex"; L.spokes = 5; L.split = true; L.S = {roofEnd: -0.7, glassEnd: -0.86}; }
    if(/^X5 M/.test(m)){ L.gills = true; L.dome = true; }
    if(/^X3\b/.test(m)){ L.grille = "diag"; L.lights = "slimV"; L.spokes = 10; }
  }
  if(b === "bugatti"){
    L.bug = /Tourbillon/.test(m) ? "tourbillon" : /Veyron/.test(m) ? "veyron" : "chiron";
    L.spokes = L.bug === "chiron" ? 7 : 10; L.split = L.bug === "veyron";
  }
  L.S = Object.assign({}, CAR[st.type], L.S || {});
  return L;
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
    else if(r){ uv[j*2] = (r[0] + r[2])/2; uv[j*2 + 1] = (r[1] + r[3])/2; }   // [3.13] no uvs of its own (a frustum): the patch's middle
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
Builder.prototype.side = function(node, mk, col, pts, w, bevel, curve, segs){
  var T = this.T, s = shapeOf(T, pts), b = bevel || 0;
  // the bevel starts inside the outline (bevelOffset), so the profile keeps its exact size; segs > 1 rounds it
  var g = new T.ExtrudeGeometry(s, {depth: Math.max(0.002, w - 2*b), bevelEnabled: b > 0, bevelThickness: b, bevelSize: b, bevelOffset: -b,
                                    bevelSegments: segs || 1, curveSegments: curve || 5});
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
// [3.13] the Tuning shop's rims (design 1-5; 0 the car's own) and a size step (sz -1..2: the alloy grows inside the
// tyre, a lower profile; the tyre's outside, the rig's radius, never changes)
function carWheel(B, holder, name, R, tw, side, rim, spokes, caliper, split, design, sz){
  var T = B.T, w = B.node(holder, name), sh = Math.min(0.05, tw*0.2), rf = 0.68 + 0.035*(sz | 0), k = rf/0.68;
  B.add(w, "wheel", new T.CylinderGeometry(R, R, tw - 2*sh, 18, 1, true), COL.tyre, 0, 0, 0, 0, 0, PI/2);
  [1, -1].forEach(function(s){
    var t = new T.TorusGeometry(R - sh, sh, 2, 18); t.rotateY(PI/2);
    B.add(w, "wheel", t, s === side ? 0x202226 : COL.tyre, s*(tw/2 - sh), 0, 0);                    // the shoulder, the sidewall
    B.add(w, "wheel", new T.CylinderGeometry(R + 0.003, R + 0.003, 0.014, 18, 1, true), 0x08090a, s*tw*0.17, 0, 0, 0, 0, PI/2);   // a groove
  });
  var ox = side*(tw/2 + 0.004);
  B.t("tyre").ring(w, "wheel", 0xffffff, Math.min(R*(rf + 0.02), R - sh*0.9 - 0.02), R - sh*0.9, 24, side*(tw/2 + 0.003), side);   // [3.5.6] the sidewall's lettering
  B.add(w, "wheel", new T.CircleGeometry(R*rf, 14), COL.black, ox - side*0.03, 0, 0, 0, side*PI/2, 0);   // the barrel's dark inside
  var lip = new T.TorusGeometry(R*rf, design === 5 ? 0.03 : 0.016, 3, 16); lip.rotateY(PI/2);
  B.add(w, "wheel", lip, rim, ox, 0, 0);
  B.add(w, "wheel", new T.CylinderGeometry(R*0.5, R*0.5, 0.016, 12), COL.steel, ox - side*0.075, 0, 0, 0, 0, PI/2);   // the brake disc
  var n = spokes || 5, sp = function(a, wd, dp, f){ B.box(w, "wheel", rim, wd, R*0.6*k*(f || 1), dp, ox + side*0.008, Math.cos(a)*R*0.31*k*(f || 1), Math.sin(a)*R*0.31*k*(f || 1), a, 0, 0); };
  if(design === 1) for(var k1 = 0; k1 < 5; k1++) sp(k1/5*PI*2, 0.034, 0.05);                                  // five wide spokes
  else if(design === 2){                                                                                    // a cross-laced mesh in a ring
    for(var k2 = 0; k2 < 10; k2++) sp(k2/10*PI*2 + (k2 % 2 ? 0.22 : -0.22), 0.011, 0.03);
    var ring = new T.TorusGeometry(R*0.4*k, 0.01, 3, 14); ring.rotateY(PI/2); B.add(w, "wheel", ring, rim, ox + side*0.006, 0, 0);
  } else if(design === 3) for(var k3 = 0; k3 < 12; k3++) sp(k3/12*PI*2, 0.013, 0.04);                       // twelve slim spokes
  else if(design === 4){                                                                                    // an aero disc: a flat face, six vents
    B.add(w, "wheel", new T.CircleGeometry(R*rf*0.97, 16), rim, ox + side*0.01, 0, 0, 0, side*PI/2, 0);
    for(var k4 = 0; k4 < 6; k4++){ var a4 = k4/6*PI*2; B.add(w, "wheel", new T.CircleGeometry(R*0.08*k, 7), COL.black, ox + side*0.013, Math.cos(a4)*R*0.42*k, Math.sin(a4)*R*0.42*k, 0, side*PI/2, 0); }
  } else if(design === 5){                                                                                  // a deep dish: a wide polished lip, short spokes
    var step = new T.TorusGeometry(R*rf*0.8, 0.012, 3, 14); step.rotateY(PI/2); B.add(w, "wheel", step, COL.chrome, ox - side*0.012, 0, 0);
    for(var k5 = 0; k5 < 6; k5++) sp(k5/6*PI*2, 0.03, 0.04, 0.75);
  } else for(var kk = 0; kk < n; kk++){
    var a = kk/n*PI*2;
    if(split) [-0.11, 0.11].forEach(function(da){ B.box(w, "wheel", rim, 0.018, R*0.6*k, 0.026, ox + side*0.006, Math.cos(a + da)*R*0.32*k, Math.sin(a + da)*R*0.32*k, a + da, 0, 0); });
    else B.box(w, "wheel", rim, 0.02, R*0.6*k, 0.05, ox + side*0.008, Math.cos(a)*R*0.31*k, Math.sin(a)*R*0.31*k, a, 0, 0);
  }
  B.add(w, "wheel", new T.CylinderGeometry(0.055, 0.055, 0.024, 10), COL.dark, ox + side*0.012, 0, 0, 0, 0, PI/2);
  B.t("badge").add(w, "wheel", new T.CylinderGeometry(0.03, 0.03, 0.03, 10), 0xffffff, ox + side*0.016, 0, 0, 0, 0, PI/2);   // the centre cap
  // the caliper: behind the spokes, at the back of the disc
  B.box(holder, "trim", caliper, 0.05, R*0.34, R*0.16, ox - side*0.05, R*0.06, -R*0.42, 0.25, 0, 0);
  return w;
}
function buildCar(T, entry, st, d, G){
  G = G || GEO0;
  var B = new Builder(T), root = new T.Group(), body = B.node(root, "body"), t2 = function(){ return B.t("tone2"); };
  var look = carLook(entry, st), S = look.S, L = d.lengthM, W = d.widthM, H = d.heightM, WB = d.wheelbaseM;
  var R = S.R*Math.min(1.12, Math.max(0.9, W/1.9)), gc = S.gc, ar = R + 0.06, archTop = R + ar;
  var zf = L/2 - S.fo*(L - WB), zr = zf - WB;
  var yb = Math.max(H*S.belt, archTop + 0.04), yn = Math.max(H*S.nose, gc + 0.34), yt = Math.max(H*S.tail, archTop + 0.02);
  var zA = zf - S.cowl*WB, zAr = zA - S.ws, zCr = Math.max(-L/2 + 0.2, zr + S.roofEnd), zC = Math.max(-L/2 + 0.08, zr + S.glassEnd);
  if(zCr > zAr - 0.3) zCr = zAr - 0.3;
  if(zC > zCr - 0.05) zC = zCr - 0.05;
  var brand = st.brand, bmw = brand === "bmw", bugatti = brand === "bugatti", hyper = st.type === "hyper";
  // [3.9] a mid-engined car (a hypercar or a supercar) and the Lamborghini cues: trapezoid arches, Y lights, hexagons
  var sup = st.type === "super", mid = hyper || sup, lambo = brand === "lamborghini", lsup = lambo && sup;
  var sto = lambo && /\bSTO\b/.test(String(entry.model || "")), classic = lambo && /Countach/.test(String(entry.model || ""));
  var hood = function(z){ return yn + (yb - yn)*(L/2 - 0.14 - z)/Math.max(0.1, L/2 - 0.14 - zA); };
  var deck = function(z){ return yb + (yt - yb)*(zC - z)/Math.max(0.1, zC - (-L/2 + 0.12)); };
  // the lower body: its side profile, both arches cut out; fenders swell over the wheels where the hood runs low
  // (a Lamborghini's arches are half hexagons: three straight cuts, not a curve)
  var arch = function(z){ return lambo ? [[z - ar*0.5, R + ar*0.866], [z + ar*0.5, R + ar*0.866], [z + ar, R]] : [arcPt(z, R, ar), [z + ar, R]]; };
  var pts = [[-L/2, gc + 0.16], [-L/2 + 0.14, gc], [zr - ar, gc], [zr - ar, R]].concat(arch(zr), [[zr + ar, gc],
             [zf - ar, gc], [zf - ar, R]], arch(zf), [[zf + ar, gc], [L/2 - 0.16, gc], [L/2, gc + 0.2],
             [L/2, yn - 0.09], [L/2 - 0.14, yn, L/2, yn]]);
  var fz = zf, fy = Math.max(hood(fz), archTop + 0.05);
  if(fy > hood(fz) + 0.005 && zf - ar > zA + 0.05){ pts.push([zf + ar*0.9, Math.max(hood(zf + ar*0.9), (fy + hood(zf + ar*0.9))/2)]); pts.push([fz, fy]); pts.push([zf - ar, Math.max(hood(zf - ar), fy - 0.02)]); }
  pts.push([zA, yb]);
  if(zC > zr + ar){ pts.push([zC, yb]); }
  var rz = zr, ry = Math.max(deck(rz), archTop + 0.05);
  if(zC > zr && ry > deck(rz) + 0.005){ pts.push([zr + ar, Math.max(deck(zr + ar), ry - 0.02)]); pts.push([rz, ry]); pts.push([zr - ar*0.9, Math.max(deck(zr - ar*0.9), (ry + deck(zr - ar*0.9))/2)]); }
  else if(zC <= zr + ar){ pts.push([zC, Math.max(yb, archTop + 0.05)]); }
  pts.push([-L/2 + 0.12, yt]); pts.push([-L/2, yt - 0.12, -L/2, yt]);
  var shell = B.side(body, "paint", null, pts, W, lambo ? 0.045 : 0.075, 6, lambo ? 1 : 2);   // ([3.9] rounder shoulders, a Lamborghini's crisp)
  // [3.9] rounded corners in plan: the nose and the tail draw in towards their ends (9% narrower at the very end), so
  // no car reads as a box from a three-quarter view
  (function(){ var P = shell.attributes.position, rz = Math.min(0.55, L*0.12);
    for(var i = 0; i < P.count; i++){ var e = Math.max(0, (Math.abs(P.getZ(i)) - (L/2 - rz))/rz); if(e > 0) P.setX(i, P.getX(i)*(1 - 0.09*e*e)); }
    shell.computeVertexNormals(); })();
  // arch liners
  [zr, zf].forEach(function(z){ B.add(body, "trim", new T.CylinderGeometry(ar - 0.01, ar - 0.01, W*0.9, lambo ? 3 : 10, 1, true, 0, PI), COL.black, 0, R, z, 0, 0, PI/2); });
  // the greenhouse: tinted glass all round, the roof, the pillars
  var gw = (mid ? 0.76 : 0.88)*W, top = H - 0.045, tw = gw*(st.type === "suv" ? 0.88 : 0.8);
  // the greenhouse tapers in to the roof (tumblehome); the roof sits on it, a touch wider at its foot
  B.frustum(body, "glass", null, {z0: zA, z1: zC, y: yb - 0.03, w: gw}, {z0: zAr, z1: zCr, y: top, w: tw});
  if(G.two === 1) t2();                                                                                    // [3.13] a two-tone roof
  B.frustum(body, "paint", null, {z0: zAr + 0.03, z1: zCr - 0.03, y: top - 0.012, w: tw + 0.03}, {z0: zAr - 0.06, z1: zCr + 0.05, y: H, w: tw - 0.06});
  var bx = function(f, sx){ return sx*(gw/2 + (tw/2 - gw/2)*f + 0.004); };
  // [3.5.6] the window trim: chrome on the plain cars, black (shadowline) on the quick ones, aluminium on a Bugatti
  var wtc = bugatti ? COL.alu : (isM(entry) || mid || st.type === "coupe" || st.type === "hatch") ? COL.black : COL.chrome;
  [1, -1].forEach(function(sx){
    if(G.two === 1) t2();
    B.bar(body, "paint", null, [bx(0, sx), yb - 0.02, zA], [bx(1, sx), top, zAr], 0.06, 0.07);                // A pillar
    B.bar(body, hyper ? "trim" : "paint", COL.black, [bx(0, sx), yb - 0.02, zC + 0.05], [bx(1, sx), top, zCr + 0.04], sup ? 0.1 : 0.08, sup ? 0.06 : 0.15);   // C (a supercar's buttress)
    var zb = (zA + zC)/2 + 0.1, zbt = (zAr + zCr)/2 + 0.06;
    if(!mid) B.bar(body, "trim", COL.black, [bx(0, sx), yb - 0.02, zb], [bx(1, sx), top, zbt], 0.035, 0.07);   // B
    B.box(body, "trim", wtc, 0.02, 0.025, Math.max(0.2, zA - zC - 0.1), sx*(gw/2 + 0.005), yb + 0.005, (zA + zC)/2);   // the belt line
    B.bar(body, "trim", wtc, [bx(0.97, sx), top - 0.02, zAr - 0.04], [bx(0.97, sx), top - 0.02, zCr + 0.06], 0.016, 0.02);   // the window's top trim
    if(G.two === 1 || G.two === 3) t2();                                                                     // [3.13] its cap in the second tone
    B.box(body, "paint", null, 0.07, 0.07, 0.15, sx*(W/2 + 0.05), yb + 0.08, zA - 0.12);                   // a mirror
    B.box(body, "trim", COL.black, 0.04, 0.09, Math.max(0.2, WB - 2*ar - 0.1), sx*(W/2 - 0.01), gc + 0.07, (zf + zr)/2);   // the sill
  });
  // inside: two seats, the dash; the steering wheel (spin) in front of the driver (right-hand drive: -x)
  var ys = gc + S.seat, zS = (zA + zCr)/2 + (mid ? 0.15 : -0.05), xd = -W*0.21, head = top - 0.04 - ys;
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
  var zN = L/2 + 0.004, yl = lsup ? yn - 0.09 : yn - 0.15;
  if(!lambo) B.t("honey").box(body, "trim", 0xffffff, W*0.62, 0.13, 0.06, 0, gc + 0.2, L/2 - 0.01);       // the lower intake (its mesh)
  else {
    // [3.9] a wide hexagonal intake (the Urus's grille, up high), big side intakes, each a black blade over its mesh
    var hx = new T.CircleGeometry(0.5, 6); hx.scale(sup ? W*0.5 : W*0.56, sup ? 0.15 : 0.26, 1);
    B.t("honey").add(body, "trim", hx, 0xffffff, 0, sup ? gc + 0.17 : (gc + 0.24 + yl - 0.06)/2, zN + 0.006);
    [1, -1].forEach(function(sx){
      B.t("honey").box(body, "trim", 0xffffff, W*0.2, sup ? 0.17 : 0.2, 0.04, sx*W*0.36, gc + 0.19, L/2 - 0.005, 0, 0, sx*0.12);
      B.box(body, "trim", COL.black, W*0.22, 0.03, 0.05, sx*W*0.36, gc + (sup ? 0.29 : 0.31), L/2 + 0.01, 0, 0, -sx*0.32);   // the blade
    });
  }
  if(bugatti){
    // the horseshoe: an open ring, its gap at the top, round a dark mesh; quad LED strips each side
    // ([3.9] the Chiron's wide horseshoe and four LEDs in a row, the Tourbillon's tall narrow one and LEDs stacked in a
    // column, the Veyron's round one between two round projectors a side)
    var bv = look.bug, hsx = bv === "tourbillon" ? 0.78 : bv === "chiron" ? 1.12 : 1, hsy = bv === "tourbillon" ? 1.2 : bv === "chiron" ? 0.92 : 1;
    var hs = Math.min(0.22, yn - gc - 0.12)*0.85, gap = (bv === "veyron" ? 0.45 : 0.62)*PI, tor = new T.TorusGeometry(hs, 0.025, 4, 18, 2*PI - gap);
    tor.rotateZ(PI/2 + gap/2); tor.scale(hsx, hsy, 1);
    var hcy = gc + 0.22 + hs*hsy;
    B.add(body, "trim", tor, COL.chrome, 0, hcy, zN + 0.01);
    var hm = new T.CircleGeometry(hs - 0.01, 14); hm.scale(hsx, hsy, 1);
    B.t("honey").add(body, "trim", hm, 0xffffff, 0, hcy, zN + 0.005);
    [1, -1].forEach(function(sx){
      if(bv === "tourbillon") for(var i = 0; i < 4; i++) B.t("ledcell").box(body, "light", COL.drl, 0.06, 0.028, 0.02, sx*W*0.3, yl + 0.08 - i*0.045, zN);
      else if(bv === "veyron") [0.25, 0.35].forEach(function(f){ B.t("bikehead").add(body, "light", new T.CircleGeometry(0.045, 12), COL.head, sx*W*f, yl, zN + 0.006); B.add(body, "trim", new T.TorusGeometry(0.047, 0.008, 3, 12), COL.chrome, sx*W*f, yl, zN + 0.008); });
      else for(var i2 = 0; i2 < 4; i2++) B.t("ledcell").box(body, "light", COL.drl, 0.05, 0.03, 0.02, sx*(W*0.24 + i2*0.065), yl + 0.02, zN);
    });
    var bg = new T.CircleGeometry(0.035, 14); bg.scale(1.5, 1, 1);                                     // [3.5.6] an oval badge atop the horseshoe
    B.t("badge").add(body, "trim", bg, 0xffffff, 0, hcy + hs*hsy - 0.01, zN + 0.03);
  } else {
    var kid = bmw;
    [1, -1].forEach(function(sx){
      if(lambo){                                                                                        // [3.9] slim, raked, the Y inside
        var lw = sup ? W*0.27 : W*0.25, lh = sup ? 0.07 : 0.085, lr = sx*(sup ? 0.16 : 0.08);
        B.box(body, "trim", COL.black, lw + 0.03, lh + 0.025, 0.04, sx*W*0.32, yl, zN - 0.012, 0, 0, lr);
        if(classic) B.t("head").box(body, "light", COL.head, lw*0.7, lh*0.6, 0.006, sx*W*0.32, yl, zN + 0.008, 0, 0, lr);
        else B.t("ylamp").box(body, "light", 0xffffff, lw, lh, 0.006, sx*W*0.32, yl, zN + 0.008, 0, 0, lr);
        return;
      }
      var lt = look.lights;
      // [3.9] by model: slim lamps (with a vertical DRL), square ones (the M2), split (a slim DRL up high, the lamps low in
      // the bumper: the XM, the i7), angular ones with hexagonal DRL rings (the X5); else the angel eyes
      if(lt === "split"){
        B.box(body, "trim", COL.black, W*0.25, 0.045, 0.04, sx*W*0.3, yl + 0.05, zN - 0.012, 0, 0, sx*0.04);
        B.box(body, "light", COL.drl, W*0.23, 0.02, 0.006, sx*W*0.3, yl + 0.05, zN + 0.008, 0, 0, sx*0.04);
        var lly = gc + 0.4;
        B.box(body, "trim", COL.black, W*0.13, 0.1, 0.04, sx*W*0.36, lly, zN - 0.01);
        B.t("head").box(body, "light", 0xffffff, W*0.115, 0.08, 0.006, sx*W*0.36, lly, zN + 0.01);
        return;
      }
      if(lt === "hex"){
        B.box(body, "trim", COL.black, W*0.25, 0.11, 0.04, sx*W*0.31, yl, zN - 0.012, 0, 0, -sx*0.05);
        B.t("head").box(body, "light", 0xffffff, W*0.22, 0.09, 0.004, sx*W*0.31, yl, zN + 0.006, 0, 0, -sx*0.05);
        [0.25, 0.36].forEach(function(f){ var hx = new T.TorusGeometry(0.044, 0.009, 3, 6); hx.rotateZ(PI/6); B.add(body, "light", hx, COL.drl, sx*W*f, yl, zN + 0.01); });
        return;
      }
      if(lt === "slim" || lt === "slimV" || lt === "square"){
        var sq = lt === "square", hw = sq ? W*0.17 : W*0.25, hh = sq ? 0.12 : 0.075, hxp = sx*W*(sq ? 0.33 : 0.31), rz0 = sq ? 0 : sx*0.07;
        B.box(body, "trim", COL.black, hw, hh, 0.04, hxp, yl, zN - 0.012, 0, 0, rz0);
        B.t("head").box(body, "light", 0xffffff, hw*0.82, hh*0.7, 0.004, hxp, yl - 0.005, zN + 0.006, 0, 0, rz0);
        B.box(body, "light", COL.drl, hw*0.9, 0.012, 0.006, hxp, yl + hh*0.42, zN + 0.01, 0, 0, rz0);          // the DRL brow
        if(lt !== "slim") B.box(body, "light", COL.drl, 0.014, hh*0.9, 0.006, hxp - sx*hw*0.42, yl, zN + 0.012);   // its vertical stroke
        return;
      }
      B.box(body, "trim", COL.black, W*0.24, 0.11, 0.04, sx*W*0.31, yl, zN - 0.012);                    // the headlight housing
      if(bmw){                                                                                          // angel eyes, round projectors
        [0.25, 0.36].forEach(function(f){ B.add(body, "light", new T.TorusGeometry(0.042, 0.008, 3, 12), COL.drl, sx*W*f, yl, zN + 0.008); });
        B.t("head").box(body, "light", 0xffffff, W*0.22, 0.095, 0.004, sx*W*0.305, yl, zN + 0.006);
      } else B.t("head").box(body, "light", COL.head, W*0.2, 0.06, 0.02, sx*W*0.31, yl, zN);           // [3.5.6] projectors and a DRL strip
    });
    if(kid){                                                                                            // the kidneys
      // [3.9] by model: tall M3/M4 kidneys with horizontal slats down into the bumper, wide low ones (the 3 Series, the
      // M5's lit outline), the M2's frameless horizontal pair, the XXL ones (the X5; lit on the XM and the i7), the X3's
      // diagonal slats, the i4's closed panel
      var gk = look.grille, closed = gk === "closed" || st.ev;
      var KD = {tall: [0.19, 0.31, 0], wide: [0.24, 0.16, 0.04], wideLit: [0.25, 0.15, 0.05], frameless: [0.22, 0.13, 0.05], xl: [0.27, 0.28, 0.02],
                xlLit: [0.27, 0.3, 0.02], diag: [0.26, 0.2, 0.03], closed: [0.23, 0.22, 0.03]}[closed ? "closed" : gk] || [0.23, 0.17, 0.04];
      var kw = KD[0], kh = KD[1], ky = gc + 0.24 + kh/2 + KD[2], lit = /Lit$/.test(gk), slat = gk === "tall" || gk === "frameless" ? "h" : gk === "diag" ? "d" : "v";
      ky = Math.min(ky, yn - 0.06 - kh/2);
      [1, -1].forEach(function(sx){
        var kx = sx*(kw/2 + 0.02);
        B.plate(body, "trim", closed ? COL.bmwBlue : gk === "frameless" || gk === "xlLit" ? COL.black : COL.alu, kw, kh, 0.03, gk === "xlLit" ? 0.03 : 0.05, kx, ky, zN + 0.005);
        if(closed) B.plate(body, "trim", COL.grey, kw - 0.03, kh - 0.03, 0.03, 0.04, kx, ky, zN + 0.012);
        else B.t("honey").plate(body, "trim", 0xffffff, kw - 0.03, kh - 0.03, 0.03, 0.04, kx, ky, zN + 0.012);
        if(!closed){                                                                                    // the slats
          if(slat === "h") for(var j = -1; j <= 1; j++) B.box(body, "trim", gk === "tall" ? COL.black : COL.alu, kw - 0.05, 0.014, 0.012, kx, ky + j*kh*0.26, zN + 0.03);
          else for(var j2 = -1; j2 <= 1; j2++) B.box(body, "trim", COL.alu, 0.012, kh - 0.05, 0.012, kx + j2*kw*0.26, ky, zN + 0.03, 0, 0, slat === "d" ? sx*0.45 : 0);
        }
        if(lit){                                                                                        // a lit contour round the kidney
          B.box(body, "light", COL.drl, kw, 0.01, 0.006, kx, ky + kh/2, zN + 0.025); B.box(body, "light", COL.drl, kw, 0.01, 0.006, kx, ky - kh/2, zN + 0.025);
          [1, -1].forEach(function(e){ B.box(body, "light", COL.drl, 0.01, kh, 0.006, kx + e*kw/2, ky, zN + 0.025); });
        }
      });
    } else if(!st.ev && !lambo) B.t("honey").plate(body, "trim", 0xffffff, W*0.42, 0.14, 0.03, 0.04, 0, yl - 0.02, zN + 0.004);
    // [3.5.6] a generic round badge: on the grille, else on the nose above the kidneys
    if(kid) B.t("badge").add(body, "trim", new T.CircleGeometry(0.035, 14), 0xffffff, 0, yn - 0.002, L/2 - 0.08, -1.0, 0, 0);
    else if(lambo){ var hb0 = new T.CircleGeometry(0.045, 6); hb0.rotateZ(PI/2); hb0.scale(1, 1.15, 1);            // [3.9] a hexagonal shield on the nose
      B.t("hexbadge").add(body, "trim", hb0, 0xffffff, 0, sup ? yn - 0.004 : yl + 0.02, sup ? L/2 - 0.1 : zN + 0.02, sup ? -1.2 : 0, 0, 0); }
    else B.t("badge").add(body, "trim", new T.CircleGeometry(0.035, 14), 0xffffff, 0, yl - 0.02, zN + 0.022);
  }
  // the side: intakes ahead of the rear wheels (hypercars), Bugatti's C-line
  if(mid && !lambo) [1, -1].forEach(function(sx){ B.box(body, "trim", COL.black, 0.03, 0.26, 0.5, sx*(W/2 + 0.002), gc + 0.3, zr + ar + 0.35); });
  if(lsup){
    // [3.9] the big triangular side intake ahead of the rear wheel (one slab through the body: its two faces are the
    // intakes), a mesh deep inside it; a carbon blade along the door's foot
    var i0 = zr + ar + 0.04, i1 = Math.min(zr + ar + (classic ? 0.6 : 0.85), (zA + zC)/2), iy0 = gc + 0.2, iy1 = yb - 0.03;
    B.side(body, "trim", COL.black, [[i0, iy0], [i1, iy1 - 0.02], [i0, iy1]], W + 0.012, 0, 1);
    B.t("honey").box(body, "trim", 0xffffff, W + 0.004, (iy1 - iy0)*0.5, (i1 - i0)*0.35, 0, iy0 + (iy1 - iy0)*0.62, i0 + (i1 - i0)*0.2);
  }
  if(lambo && !sup) [1, -1].forEach(function(sx){                                                     // [3.9] the Urus's sharp shoulder crease
    B.box(body, "paint", null, 0.03, 0.035, L*0.72, sx*(W/2 - 0.004), yb - 0.1, -0.05, 0.035, 0, 0);
  });
  if(bugatti){
    [1, -1].forEach(function(sx){
      var cr = Math.min(0.42, (yb - gc)*0.6), arc = 1.15*PI, c = new T.TorusGeometry(cr, 0.03, 3, 14, arc);
      c.rotateZ(PI - arc/2); c.rotateY(-PI/2);
      B.add(body, "trim", c, COL.alu, sx*(W/2 + 0.012), gc + cr + 0.08, zA - 0.25);
    });
  }
  // [3.9] the M cars' power dome on the hood and the gills behind the front wheels; a Bugatti's spine (Chiron,
  // Tourbillon) down the roof and the engine cover, the Veyron's two roof scoops
  var hrun = Math.max(0.1, L/2 - 0.14 - zA), hang = Math.atan2(yb - yn, hrun);
  if(look.dome){ var hz0 = zA + 0.15, hz1 = L/2 - 0.4, hzm = (hz0 + hz1)/2; if(hz1 > hz0) B.box(body, "paint", null, W*0.3, 0.05, (hz1 - hz0)/Math.cos(hang), 0, hood(hzm) + 0.006, hzm, hang, 0, 0); }
  if(look.gills) [1, -1].forEach(function(sx){ for(var gi = 0; gi < 2; gi++) B.box(body, "trim", COL.black, 0.014, 0.026, 0.17, sx*(W/2 + 0.002), yb - 0.13 - gi*0.05, zf - ar - 0.2); });
  if(look.bug === "chiron" || look.bug === "tourbillon"){
    B.box(body, "paint", null, 0.03, 0.05, Math.max(0.2, zAr - zCr), 0, H + 0.01, (zAr + zCr)/2);
    B.bar(body, "paint", null, [0, H + 0.01, zCr + 0.02], [0, yt + 0.03, -L/2 + 0.35], 0.03, 0.05);
  }
  if(look.bug === "veyron") [1, -1].forEach(function(sx){ B.box(body, "paint", null, 0.16, 0.09, 0.36, sx*0.22, H - 0.05, zCr - 0.12, 0.25, 0, 0); B.box(body, "trim", COL.black, 0.13, 0.06, 0.02, sx*0.22, H - 0.02, zCr + 0.06); });
  // the back: tail lights, the diffuser, exhausts, a lip
  var zT = -L/2 - 0.004, yr = yt - 0.2;
  B.box(body, "trim", COL.black, W*0.7, 0.12, 0.06, 0, gc + 0.12, -L/2 + 0.01);
  if(bugatti && look.bug === "veyron") [1, -1].forEach(function(sx){ [0.3, 0.4].forEach(function(f){ B.add(body, "tail", new T.CircleGeometry(0.045, 12), COL.red, sx*W*f, yt - 0.17, zT, 0, PI, 0); }); });
  else if(bugatti){ B.t("ledbar").box(body, "tail", COL.red, W*0.82, 0.035, 0.02, 0, yt - 0.16, zT); if(look.bug === "tourbillon") B.box(body, "tail", COL.red, 0.03, 0.14, 0.02, 0, yt - 0.2, zT); }
  else if(look.tail === "thin") [1, -1].forEach(function(sx){                                         // [3.9] slim full-width-ish bars (the XM, the i7)
    B.t("ledbar").box(body, "tail", COL.red, W*0.3, 0.028, 0.02, sx*W*0.3, yr + 0.04, zT);
    B.box(body, "tail", COL.red, W*0.08, 0.06, 0.02, sx*W*0.42, yr, zT);
  });
  else if(look.tail === "laser") [1, -1].forEach(function(sx){                                        // the CSL's laser blades
    B.t("ledbar").box(body, "tail", COL.red, W*0.2, 0.05, 0.02, sx*W*0.37, yr, zT);
    [0, 1].forEach(function(k){ B.box(body, "tail", 0xffffff, W*0.14, 0.008, 0.02, sx*W*(0.35 + k*0.03), yr - 0.008 + k*0.016, zT - 0.004, 0, 0, sx*0.35); });
  });
  else if(lambo && !classic) [1, -1].forEach(function(sx){
    // [3.9] a hexagonal ring of light each side (a torus of six segments), a thin light bar running in to the middle
    var hr = new T.TorusGeometry(sup ? 0.075 : 0.065, 0.014, 3, 6); hr.rotateZ(PI/6);
    B.add(body, "tail", hr, COL.red, sx*W*(sup ? 0.36 : 0.38), yr, zT);
    B.t("ledbar").box(body, "tail", COL.red, W*(sup ? 0.2 : 0.24), 0.022, 0.02, sx*W*(sup ? 0.17 : 0.15), yr + 0.01, zT);
  });
  else [1, -1].forEach(function(sx){
    B.t("ledbar").box(body, "tail", COL.red, W*0.2, 0.05, 0.02, sx*W*0.37, yr, zT);                     // [3.5.6] an LED light bar
    if(bmw) B.box(body, "tail", COL.red, 0.05, 0.1, 0.02, sx*W*0.28, yr - 0.03, zT);                 // the L
  });
  // [3.5.6] the tips: quad on an M car or a hypercar, twin otherwise, Bugatti's one wide centre pipe; each a bright
  // open sleeve round a dark mouth
  if(!st.ev && G.ex){
    // [3.13] the Tuning shop's exhausts instead: sport (two big tips), quad, titanium (quad, blue-burnt with a gold lip)
    var tc = G.ex === 3 ? COL.ti : COL.chrome, tq = G.ex === 1 ? [[1, 0], [-1, 0]] : [[1, 0], [1, 1], [-1, 0], [-1, 1]];
    tq.forEach(function(q){
      var ex = q[0]*(W*0.28 + q[1]*0.11), r = G.ex === 1 ? 0.062 : 0.046;
      B.add(body, "trim", new T.CylinderGeometry(r, r*0.92, 0.16, 12, 1, true), tc, ex, gc + 0.1, -L/2 + 0.03, PI/2, 0, 0);
      var lp = new T.TorusGeometry(r, 0.008, 3, 12); B.add(body, "trim", lp, G.ex === 3 ? COL.gold : COL.chrome, ex, gc + 0.1, -L/2 - 0.05);
      B.add(body, "trim", new T.CircleGeometry(r*0.85, 12), 0x050505, ex, gc + 0.1, -L/2 + 0.02, 0, PI, 0);
    });
  } else if(!st.ev){
    var tip = function(ex, r, ty, seg){
      ty = ty != null ? ty : gc + 0.1; seg = seg || 12;
      B.add(body, "trim", new T.CylinderGeometry(r, r, 0.12, seg, 1, true), COL.chrome, ex, ty, -L/2 + 0.02, PI/2, 0, 0);
      B.add(body, "trim", new T.CircleGeometry(r*0.85, seg), 0x050505, ex, ty, -L/2 + 0.02, 0, PI, 0);
    };
    if(bugatti){ var bt = new T.CylinderGeometry(0.06, 0.06, 0.1, 12, 1, true); bt.scale(2.2, 1, 1); B.add(body, "trim", bt, COL.alu, 0, gc + 0.1, -L/2 + 0.02, PI/2, 0, 0);
                 var bm = new T.CircleGeometry(0.052, 12); bm.scale(2.2, 1, 1); B.add(body, "trim", bm, 0x050505, 0, gc + 0.1, -L/2 + 0.03, 0, PI, 0); }
    else if(lsup){ [-1, 1].forEach(function(s2){ tip(s2*(classic ? W*0.3 : 0.09), classic ? 0.045 : 0.058, classic ? gc + 0.1 : yt - 0.3, classic ? 12 : 6); }); }   // [3.9] hexagonal, high in the middle
    else if(lambo){ for(var ui = 0; ui < 4; ui++) tip((ui < 2 ? 1 : -1)*(W*0.3 + (ui % 2)*0.11), 0.045, gc + 0.1, 6); }
    else { var nx = isM(entry) || hyper ? 4 : 2; for(var i = 0; i < nx; i++) tip((i < nx/2 ? 1 : -1)*(W*0.3 + (i % 2)*0.1), nx > 2 ? 0.042 : 0.048); }
  }
  if(mid || st.type === "coupe") B.box(body, "paint", null, W*0.8, 0.03, 0.22, 0, yt + 0.01, -L/2 + 0.2, -0.12, 0, 0);
  if(lsup && !classic){
    // [3.9] the engine cover: black louvres across the rear glass, from the roof's end down to its foot
    for(var li = 1; li <= 4; li++){
      var lf = li/5, lz = zCr + (zC - zCr)*lf, ly = top + (yb - 0.03 - top)*lf;
      B.box(body, "trim", COL.black, tw*0.86 + (gw - tw)*lf*0.8, 0.014, 0.05, 0, ly + 0.012, lz, Math.atan2(top - yb, zCr - zC), 0, 0);
    }
  }
  if(sto){
    // the STO: a big rear wing on two struts, its endplates; a roof scoop and a fin down the engine cover
    var wy = yt + 0.3, wz = -L/2 + 0.28;
    B.box(body, "paint", null, W*0.9, 0.025, 0.3, 0, wy, wz, -0.14, 0, 0);
    [1, -1].forEach(function(sx){
      B.box(body, "paint", null, 0.02, 0.14, 0.36, sx*W*0.45, wy - 0.03, wz);
      B.bar(body, "trim", COL.black, [sx*W*0.18, yt - 0.02, wz + 0.05], [sx*W*0.18, wy - 0.01, wz], 0.025, 0.08);
    });
    B.box(body, "paint", null, 0.24, 0.05, 0.42, 0, H + 0.005, (zAr + zCr)/2 - 0.05);
    B.side(body, "paint", null, [[zCr - 0.05, H - 0.02], [zCr + 0.15, H + 0.04], [-L/2 + 0.3, yt + 0.02], [-L/2 + 0.4, yt - 0.02]], 0.02, 0, 1);
  }
  // detail: shut lines and handles, the plates, indicators and fog lights, wipers, the fin; an SUV's rails and arch
  // cladding, a hatch's roof spoiler, an M saloon's boot lip, a splitter and diffuser fins on the quick ones
  var two = st.type === "coupe" || mid, zd0 = Math.min(zA, zf - ar - 0.06), zd1 = Math.max(zr + ar + 0.06, zC - 0.02);
  var shut = two ? [zd0, Math.max(zd1, (zA + zC)/2 - 0.25)] : [zd0, (zA + zC)/2 + 0.1, zd1], ly0 = gc + 0.16, ly1 = yb - 0.03;
  [1, -1].forEach(function(sx){
    var x = sx*(W/2 + 0.002);
    shut.forEach(function(z, i){
      // (a Lamborghini's scissor door: its front shut line leans back with the A pillar; no handles to see)
      B.box(body, "trim", COL.black, 0.012, ly1 - ly0, 0.014, x, (ly0 + ly1)/2, z, lsup && i === 0 ? 0.3 : 0, 0, 0);
      if(i < shut.length - 1 && !lsup) B.box(body, "trim", bmw ? COL.alu : COL.dark, 0.02, 0.026, 0.13, sx*(W/2 + 0.01), yb - 0.09, shut[i + 1] + 0.16);
    });
    B.box(body, "trim", COL.black, 0.06, 0.02, 0.05, sx*(W/2 + 0.01), yb + 0.06, zA - 0.1);                // the mirror's stalk
    B.box(body, "trim", COL.dark, 0.012, 0.05, 0.11, sx*(W/2 + 0.07), yb + 0.08, zA - 0.2);               // its glass
    // [3.5.6] the mirror's indicator strip, the side skirt (black on the quick ones, else body colour)
    B.box(body, "light", COL.amber, 0.05, 0.012, 0.012, sx*(W/2 + 0.06), yb + 0.06, zA - 0.045, 0, -sx*0.35, 0);
    var sk = isM(entry) || mid || st.type === "coupe", skl = Math.max(0.3, WB - 2*ar - 0.08);
    B.box(body, sk ? "trim" : "paint", COL.black, 0.05, 0.035, skl, sx*(W/2 + 0.012), gc + 0.025, (zf + zr)/2);
    if(!bugatti){
      B.box(body, "light", COL.amber, 0.07, 0.03, 0.02, sx*W*0.43, yl - 0.075, L/2 + 0.004);             // indicators
      if(!lambo) B.box(body, "light", COL.head, 0.08, 0.035, 0.02, sx*W*0.37, gc + 0.21, L/2 + 0.006);   // fog lights
    }
    B.box(body, "light", COL.head, 0.08, 0.035, 0.02, sx*W*0.3, gc + 0.22, -L/2 - 0.006);                // reversing lights
    B.box(body, "trim", COL.black, W*0.26, 0.014, 0.02, sx*W*0.18, yb + 0.02, zA - 0.05, 0, sx*0.08, 0); // the wipers
    if(st.type === "suv" || st.type === "pickup"){
      [zr, zf].forEach(function(z){ var c = new T.TorusGeometry(ar + 0.012, 0.035, 3, lambo ? 3 : 10, PI); c.rotateY(PI/2); B.add(body, "trim", c, COL.black, sx*(W/2 - 0.012), R, z); });
      var rx = sx*(tw/2 - 0.08), rl = Math.max(0.4, zAr - zCr - 0.1);
      B.box(body, "trim", bmw && isM(entry) ? COL.black : COL.alu, 0.035, 0.03, rl, rx, H + 0.05, (zAr + zCr)/2);
      [zAr - 0.08, zCr + 0.12].forEach(function(z){ B.box(body, "trim", COL.black, 0.04, 0.05, 0.06, rx, H + 0.02, z); });
    }
  });
  if(!(bugatti && hyper)) B.t("plate").box(body, "trim", 0xffffff, 0.52, 0.11, 0.012, 0, gc + 0.2, L/2 + 0.035);   // the plates
  B.t("plate").box(body, "trim", 0xffffff, 0.52, 0.11, 0.012, 0, gc + 0.3, -L/2 - 0.012);
  // [3.5.6] the rear badge; the fuel (charge) flap over the rear wheel, its shut line round it
  if(lambo){ var hb1 = new T.CircleGeometry(0.04, 6); hb1.rotateZ(PI/2); hb1.scale(1, 1.15, 1); B.t("hexbadge").add(body, "trim", hb1, 0xffffff, 0, yt - (sup ? 0.12 : 0.15), -L/2 - 0.006, 0, PI, 0); }
  else B.t("badge").add(body, "trim", new T.CircleGeometry(0.035, 14), 0xffffff, 0, bugatti ? yt - 0.25 : yt - 0.15, -L/2 - 0.006, 0, PI, 0);
  var ffs = st.ev ? 1 : -1, ffy = Math.min(yb - 0.08, Math.max(archTop + 0.08, (archTop + yb)/2)), ffh = Math.min(0.11, Math.max(0.06, yb - archTop - 0.06));
  B.flank(body, "trim", COL.black, 0.17, ffh + 0.012, 0.004, 0.03, ffs*(W/2 + 0.001), ffy, zr + 0.02, ffs);
  B.flank(body, "paint", null, 0.155, ffh, 0.006, 0.025, ffs*(W/2 + 0.003), ffy, zr + 0.02, ffs);
  if(!mid){
    B.box(body, "tail", COL.red, 0.32, 0.03, 0.03, 0, top - 0.03, zCr - 0.02);                            // the third brake light
    B.side(body, "trim", COL.black, [[zCr + 0.08, H], [zCr + 0.12, H + 0.05], [zCr + 0.22, H]], 0.05, 0, 1);   // the fin
  }
  if(st.type === "hatch") B.box(body, "paint", null, tw*0.95, 0.035, 0.24, 0, H - 0.01, zCr - 0.02, 0.1, 0, 0);   // the roof spoiler
  if(st.type === "sedan" && bmw && isM(entry)) B.box(body, "paint", null, W*0.6, 0.025, 0.07, 0, yt + 0.012, -L/2 + 0.16);
  if(look.ducktail) B.box(body, "paint", null, W*0.74, 0.04, 0.17, 0, yt + 0.035, -L/2 + 0.14, 0.32, 0, 0);   // [3.9] the CSL's ducktail
  if(mid || st.type === "coupe" || isM(entry)){
    B.box(body, "trim", COL.black, W*0.86, 0.022, 0.14, 0, gc + 0.012, L/2 - 0.04);                       // the splitter
    for(var fi = -2; fi <= 2; fi++) B.box(body, "trim", COL.black, 0.02, 0.12, 0.3, fi*W*0.12, gc + 0.07, -L/2 + 0.16);   // diffuser fins
  }
  // [3.13] the Tuning shop's wings: a lip, a ducktail, a GT wing on two struts (on the roof's trailing edge when the rear
  // glass runs down to the tail: a hatch, an SUV)
  if(G.wing === 1) B.box(body, "paint", null, W*0.72, 0.028, 0.09, 0, yt + 0.018, -L/2 + 0.1, -0.18, 0, 0);
  else if(G.wing === 2) B.box(body, "paint", null, W*0.76, 0.045, 0.2, 0, yt + 0.04, -L/2 + 0.15, 0.32, 0, 0);
  else if(G.wing === 3){
    var roofW = zC < -L/2 + 0.45, gwy = roofW ? H + 0.1 : yt + 0.34, gwz = roofW ? zCr + 0.02 : -L/2 + 0.3, gby = roofW ? H - 0.01 : yt - 0.02;
    B.box(body, "trim", COL.carbon, W*0.88, 0.026, 0.3, 0, gwy, gwz, -0.12, 0, 0);
    [1, -1].forEach(function(sx){
      B.box(body, "trim", COL.carbon, 0.02, 0.15, 0.36, sx*W*0.44, gwy - 0.035, gwz);
      B.bar(body, "trim", COL.black, [sx*W*0.2, gby, gwz + 0.06], [sx*W*0.2, gwy - 0.01, gwz], 0.024, 0.08);
    });
  }
  // [3.13] two-tone stripes: a pair down the bonnet, the roof and the boot lid, laid on the side profile's top line
  if(G.two === 2){
    var topPts = pts.filter(function(p){ return !p.arc && p[1] >= archTop - 0.01; }).map(function(p){ return [p[0], p[1]]; }).sort(function(a, b){ return b[0] - a[0]; });
    var runs = [topPts.filter(function(p){ return p[0] >= zA && p[0] <= L/2 - 0.12; }), topPts.filter(function(p){ return p[0] <= zC && p[0] >= -L/2 + 0.1; })];
    [0.11, -0.11].forEach(function(x){
      runs.forEach(function(R2){ for(var si = 1; si < R2.length; si++) t2().bar(body, "paint", null, [x, R2[si - 1][1] + 0.007, R2[si - 1][0]], [x, R2[si][1] + 0.007, R2[si][0]], 0.12, 0.008); });
      t2().box(body, "paint", null, 0.12, 0.008, Math.max(0.1, zAr - zCr - 0.14), x, H + 0.004, (zAr + zCr)/2);
    });
  }
  // [3.13] a livery: a band down each flank (between the arches when the belt line sits low over them)
  if(G.two === 3){
    var yLv = Math.max((archTop + yb)/2, archTop + 0.07), full = yLv + 0.05 < yb - 0.03, zq = L/2 - Math.min(0.55, L*0.12);
    [1, -1].forEach(function(sx){
      if(full) t2().box(body, "paint", null, 0.008, 0.09, 2*zq - 0.1, sx*(W/2 + 0.003), yLv, 0);
      else t2().box(body, "paint", null, 0.008, 0.09, Math.max(0.2, WB - 2*ar - 0.1), sx*(W/2 + 0.003), Math.min(yLv, yb - 0.08), (zf + zr)/2);
      t2().box(body, "paint", null, 0.008, 0.035, Math.max(0.2, WB - 2*ar - 0.1), sx*(W/2 + 0.003), gc + 0.2, (zf + zr)/2);
    });
  }
  // the wheels: the front ones in steer holders
  var tw = mid ? 0.3 : 0.26, wx = W/2 - tw/2 - 0.03, rim = G.rimCol != null ? G.rimCol : look.rim != null ? look.rim : bugatti ? COL.alu : bmw && isM(entry) ? COL.grey : COL.steel;
  var wheels = [], cal = bugatti ? COL.alu : bmw && isM(entry) ? COL.bmwBlue : lambo ? COL.gold : hyper ? COL.red : COL.grey;
  [[-wx, zf, "steer-l", -1], [wx, zf, "steer-r", 1], [-wx, zr, null, -1], [wx, zr, null, 1]].forEach(function(p, i){
    var h = B.node(root, p[2], p[0], R, p[1]);
    wheels.push(carWheel(B, h, "wheel-" + i, R, tw, p[3], rim, lambo ? 5 : look.spokes, cal, look.split || (bmw && isM(entry) && !look.rim), G.rim, G.size));
  });
  finish(T, root);
  // [3.13] where a custom plate goes: over each atlas plate's face (x, y, z, turned ry / rx; w x h)
  var plates = [{p: [0, gc + 0.3, -L/2 - 0.0195], ry: PI, rx: 0, w: 0.5, h: 0.1}];
  if(!(bugatti && hyper)) plates.push({p: [0, gc + 0.2, L/2 + 0.0425], ry: 0, rx: 0, w: 0.5, h: 0.1});
  return {g: root, meta: {kind: "car", R: R, radii: [R, R, R, R], lean: mid ? -0.04 : -0.08, riderK: riderK, plates: plates}};
}

/* ---------- [3.17] a Formula 1 car (docs/plans/grand-prix-spec.md) ----------
   An open-wheeler at the catalogue's size: the nose and its two-element front wing, the monocoque with the cockpit, the
   halo and the airbox over the driver's head, sidepods, the engine cover and its fin, the rear wing on a pylon with its
   flap and endplates, the floor, wishbones, and exposed wheels on low-profile slicks. The chosen paint is the body; the
   team livery's accent and trim (entry.livery) are baked into the trim's vertex colours, so every team's car shares
   nothing but its shape. The driver sits in the middle, low, the head in the open; no plates, no glass. The Tuning shop's
   geometry (rims, wings, two-tone) does not apply: an F1 car keeps its own aero. */
// an F1 wheel: a slick (no grooves) with rounded shoulders, the sidewall band, a dark wheel cover over five spokes
function f1Wheel(B, holder, name, R, tw, side, rimCol){
  var T = B.T, w = B.node(holder, name), sh = Math.min(0.06, tw*0.18), ox = side*(tw/2 + 0.003);
  B.add(w, "wheel", new T.CylinderGeometry(R, R, tw - 2*sh, 20, 1, true), COL.tyre, 0, 0, 0, 0, 0, PI/2);
  [1, -1].forEach(function(s){ var t = new T.TorusGeometry(R - sh, sh, 3, 20); t.rotateY(PI/2); B.add(w, "wheel", t, COL.tyre, s*(tw/2 - sh), 0, 0); });
  B.t("tyre").ring(w, "wheel", 0xffffff, R*0.64, R - sh*0.9, 24, side*(tw/2 + 0.002), side);   // the sidewall's band
  B.add(w, "wheel", new T.CircleGeometry(R*0.62, 16), rimCol, ox, 0, 0, 0, side*PI/2, 0);           // the wheel cover
  B.add(w, "wheel", new T.CircleGeometry(R*0.62, 16), COL.black, -ox, 0, 0, 0, -side*PI/2, 0);     // the inside
  for(var k = 0; k < 5; k++){ var a = k/5*PI*2; B.box(w, "wheel", COL.dark, 0.018, R*0.5, 0.02, ox + side*0.004, Math.cos(a)*R*0.27, Math.sin(a)*R*0.27, a, 0, 0); }
  B.add(w, "wheel", new T.CylinderGeometry(0.05, 0.05, 0.03, 10), COL.alu, ox + side*0.01, 0, 0, 0, 0, PI/2);   // the centre nut
  return w;
}
function buildFormula(T, entry, st, d){
  var B = new Builder(T), root = new T.Group(), body = B.node(root, "body");
  var L = d.lengthM, W = d.widthM, H = d.heightM, WB = d.wheelbaseM;
  var lv = (entry && entry.livery) || {}, acc = hexNum(lv.accent), trimC = hexNum(lv.trim);
  if(acc == null) acc = COL.dark;
  if(trimC == null) trimC = COL.black;
  var R = Math.min(0.37, H*0.38), twF = Math.min(0.32, W*0.16), twR = Math.min(0.4, W*0.2), gc = 0.05;
  var fo = (L - WB)*0.58, zf = L/2 - fo, zr = zf - WB, zCk = zf - WB*0.42, mw = Math.min(0.62, W*0.32);
  // the nose (narrow) and the monocoque, engine cover and airbox (one profile each)
  B.side(body, "paint", null, [[L/2, 0.17], [L/2 - 0.06, 0.26], [zf + 0.15, 0.44], [zf + 0.15, 0.2], [L/2 - 0.3, 0.13]], 0.32, 0.04, 4, 2);
  B.side(body, "paint", null, [[zf + 0.2, 0.46], [zCk + 0.45, 0.58], [zCk - 0.4, 0.6], [zCk - 0.5, H - 0.08], [zCk - 0.85, H - 0.1],
                               [zr + 0.2, 0.56], [-L/2 + 0.6, 0.44], [-L/2 + 0.6, 0.18], [zr + 0.4, gc + 0.06], [zf + 0.2, gc + 0.1]], mw, 0.06, 5, 2);
  B.bar(body, "trim", acc, [0, 0.272, L/2 - 0.07], [0, 0.447, zf + 0.15], 0.1, 0.012);                     // the stripe down the nose
  B.box(body, "trim", COL.black, mw*0.78, 0.03, 0.8, 0, 0.605, zCk);                                       // the cockpit's padded rim
  B.box(body, "trim", COL.black, 0.22, 0.14, 0.02, 0, H - 0.17, zCk - 0.5);                                // the airbox's mouth
  B.side(body, "paint", null, [[zCk - 0.85, H - 0.1], [zr + 0.2, 0.64], [zr + 0.2, 0.56], [zCk - 0.85, H - 0.13]], 0.02, 0, 1);   // the fin
  // sidepods: an intake each, the livery's accent down the flank, a mirror on a stalk
  [1, -1].forEach(function(sx){
    var px = sx*(mw/2 + 0.22);
    B.side(body, "paint", null, [[zCk + 0.25, 0.14], [zCk + 0.25, 0.5], [zCk - 0.3, 0.52], [zr + 0.45, 0.3], [zr + 0.45, 0.12]], 0.5, 0.06, 4, 2).translate(px, 0, 0);
    B.box(body, "trim", COL.black, 0.38, 0.22, 0.02, px, 0.36, zCk + 0.26);
    B.box(body, "trim", acc, 0.008, 0.07, 1.2, px + sx*0.252, 0.32, zCk - 0.45);
    B.bar(body, "trim", COL.carbon, [sx*mw/2, 0.58, zCk + 0.3], [sx*(mw/2 + 0.18), 0.66, zCk + 0.3], 0.015, 0.03);
    B.box(body, "paint", null, 0.12, 0.05, 0.03, sx*(mw/2 + 0.2), 0.66, zCk + 0.3);
  });
  // the floor, the halo
  B.box(body, "trim", COL.carbon, W*0.58, 0.03, WB - 0.5, 0, gc + 0.015, (zf + zr)/2 - 0.1);
  B.bar(body, "trim", COL.carbon, [0, 0.58, zCk + 0.42], [0, 0.8, zCk + 0.24], 0.025, null, true);
  [1, -1].forEach(function(sx){ B.pipe(body, "trim", COL.carbon, [[0, 0.8, zCk + 0.24], [sx*0.2, 0.81, zCk + 0.12], [sx*0.27, 0.8, zCk - 0.12], [sx*0.26, 0.72, zCk - 0.36], [sx*0.24, 0.6, zCk - 0.42]], 0.025); });
  // the front wing (two elements and the endplates) and the rear wing (the main plane, the flap, the endplates, the
  // beam wing, the pylon); the rain light under it
  B.box(body, "trim", trimC, W*0.96, 0.025, 0.42, 0, 0.09, L/2 - 0.24, -0.08, 0, 0);
  B.box(body, "trim", acc, W*0.9, 0.02, 0.2, 0, 0.15, L/2 - 0.36, -0.35, 0, 0);
  [1, -1].forEach(function(sx){ B.box(body, "trim", trimC, 0.02, 0.2, 0.5, sx*W*0.48, 0.15, L/2 - 0.26); });
  B.box(body, "trim", trimC, W*0.53, 0.035, 0.32, 0, H - 0.12, -L/2 + 0.22, -0.15, 0, 0);
  B.box(body, "trim", acc, W*0.53, 0.02, 0.16, 0, H - 0.03, -L/2 + 0.14, -0.4, 0, 0);
  [1, -1].forEach(function(sx){ B.box(body, "trim", trimC, 0.02, 0.42, 0.42, sx*W*0.27, H - 0.21, -L/2 + 0.21); });
  B.box(body, "trim", trimC, W*0.5, 0.02, 0.14, 0, 0.42, -L/2 + 0.3);
  B.box(body, "trim", COL.carbon, 0.03, H - 0.56, 0.12, 0, (0.44 + H - 0.12)/2, -L/2 + 0.3);
  B.box(body, "tail", COL.red, 0.12, 0.05, 0.02, 0, 0.34, -L/2 + 0.595);
  // wishbones, front and rear: an upper and a lower arm to each wheel
  [[zf, twF], [zr, twR]].forEach(function(a){
    [1, -1].forEach(function(sx){
      var hub = sx*(W/2 - a[1] - 0.02), ix = sx*mw*0.38;
      B.bar(body, "trim", COL.carbon, [ix, 0.38, a[0]], [hub, R + 0.06, a[0]], 0.02, null, true);
      B.bar(body, "trim", COL.carbon, [ix, 0.18, a[0]], [hub, R - 0.08, a[0]], 0.02, null, true);
    });
  });
  // the driver, low in the middle: hips behind the cockpit's middle, legs out along the nose, a rectangular wheel
  var ys = 0.2, zS = zCk - 0.2, riderK = 0.5;
  B.box(body, "trim", COL.dark, 0.4, 0.06, 0.5, 0, ys - 0.05, zS);
  var col = new T.Group(); col.position.set(0, 0.5, zS + 0.48); col.rotation.x = -0.9; root.add(col);
  var spin = B.node(col, "spin");
  B.box(spin, "trim", COL.black, 0.27, 0.12, 0.03, 0, 0, 0);
  B.t("screen").box(spin, "light", 0xffffff, 0.1, 0.05, 0.01, 0, 0.01, 0.017);
  [1, -1].forEach(function(sx){ B.box(spin, "trim", COL.dark, 0.04, 0.13, 0.04, sx*0.13, -0.01, 0); });
  anchor(T, spin, "a-grip-l", 0.13, 0, 0.02); anchor(T, spin, "a-grip-r", -0.13, 0, 0.02);
  anchor(T, root, "a-foot-l", 0.1, 0.26, zS + 0.95); anchor(T, root, "a-foot-r", -0.1, 0.26, zS + 0.95);
  anchor(T, root, "a-seat", 0, ys, zS);
  // the wheels: the front ones in steer holders
  var wheels = [];
  [[-(W/2 - twF/2), zf, "steer-l", -1, twF], [W/2 - twF/2, zf, "steer-r", 1, twF], [-(W/2 - twR/2), zr, null, -1, twR], [W/2 - twR/2, zr, null, 1, twR]].forEach(function(p, i){
    var h = B.node(root, p[2], p[0], R, p[1]);
    wheels.push(f1Wheel(B, h, "wheel-" + i, R, p[4], p[3], trimC));
  });
  finish(T, root);
  return {g: root, meta: {kind: "car", R: R, radii: [R, R, R, R], lean: -0.02, riderK: riderK, plates: []}};
}

/* ---------- bikes ---------- */
// a bike's wheel: a round-profile tyre, the rim's bright lip, cast spokes (wire spokes: an adventure bike's), the
// discs (front: one or two, the rear's on the right), the rear's sprocket on the left (model-local +x)
// [3.13] the Tuning shop's rims (design 1-5: five-spoke, Y-spoke, wire, solid disc, ten-spoke; 0 the bike's own) and
// a size step (sz -1..2: the rim grows inside the tyre; the tyre's outside never changes)
function bikeWheel(B, p, name, R, tw, rim, discs, x, y, z, wire, sprocket, tape, solid, design, sz){
  var T = B.T, w = B.node(p, name, x, y, z), tr = tw/2, ri = R - tw*(0.95 - 0.1*(sz | 0)), k = ri/(R - tw*0.95);
  if(design === 3){ wire = true; solid = false; } else if(design === 4){ solid = true; wire = false; } else if(design){ wire = false; solid = false; }
  var tyre = new T.TorusGeometry(R - tr, tr, 6, 22); tyre.rotateY(PI/2);
  B.add(w, "wheel", tyre, COL.tyre);
  var lip = new T.TorusGeometry(ri, 0.014, 3, 20); lip.rotateY(PI/2);
  B.add(w, "wheel", lip, rim);
  [1, -1].forEach(function(s){
    B.t("rimtape").add(w, "wheel", new T.CircleGeometry(ri, 20), tape || COL.grey, s*tw*0.12, 0, 0, 0, s*PI/2, 0);   // [3.5.6] its rim tape
    var spk = function(a, wd, dp){ B.box(w, "wheel", rim, wd, R*0.6*k, dp, s*(tw*0.12 + 0.008), Math.cos(a)*R*0.33*k, Math.sin(a)*R*0.33*k, a, 0, 0); };
    if(solid) B.add(w, "wheel", new T.CircleGeometry(ri, 20), rim, s*(tw*0.12 + 0.006), 0, 0, 0, s*PI/2, 0);   // [3.9] a cruiser's solid disc
    else if(wire){ for(var kw = 0; kw < 12; kw++){ var a = kw/12*PI*2 + (s > 0 ? 0 : PI/12); B.box(w, "wheel", COL.steel, 0.006, ri - tw*0.05, 0.006, s*tw*0.14, Math.cos(a)*(ri - tw*0.05)/2, Math.sin(a)*(ri - tw*0.05)/2, a, 0, s*0.12); } }
    else if(design === 1) for(var k1 = 0; k1 < 5; k1++) spk(k1/5*PI*2 + (s > 0 ? 0 : PI/5), 0.012, 0.03);
    else if(design === 2) for(var k6 = 0; k6 < 3; k6++) [-0.13, 0.13].forEach(function(da){ spk(k6/3*PI*2 + da + (s > 0 ? 0 : PI/3), 0.009, 0.03); });
    else if(design === 5) for(var k5 = 0; k5 < 10; k5++) spk(k5/10*PI*2 + (s > 0 ? 0 : PI/10), 0.007, 0.025);
    else for(var k2 = 0; k2 < 3; k2++){ var a2 = k2/3*PI*2 + (s > 0 ? 0 : PI/3); spk(a2, 0.012, 0.04); }
  });
  (discs || []).forEach(function(s){
    B.add(w, "wheel", new T.CylinderGeometry(R*0.55, R*0.55, 0.008, 16), COL.steel, s*(tr + 0.03), 0, 0, 0, 0, PI/2);
    B.add(w, "wheel", new T.CylinderGeometry(R*0.3, R*0.3, 0.012, 10), COL.dark, s*(tr + 0.03), 0, 0, 0, 0, PI/2);   // the carrier
  });
  if(sprocket) B.add(w, "wheel", new T.CylinderGeometry(R*0.4, R*0.4, 0.012, 16), COL.dark, tr + 0.035, 0, 0, 0, 0, PI/2);
  B.add(w, "wheel", new T.CylinderGeometry(0.045, 0.045, tw + 0.06, 8), COL.alu, 0, 0, 0, 0, 0, PI/2);
  return w;
}
function buildBike(T, entry, st, d, G){
  G = G || GEO0;
  var B = new Builder(T), root = new T.Group(), body = B.node(root, "body"), t2 = function(){ return B.t("tone2"); };
  var S = BIKE[st.type], WB = d.wheelbaseM, sc = d.heightM/DIMS["bike." + st.type].heightM;
  var Rr = S.Rr, Rf = S.Rf, zr = -WB/2, zf = WB/2, yh = S.head*sc, ys = S.seat*Math.min(1.1, Math.max(0.9, sc));
  var zh = zf - 0.3, zp = zr + WB*0.42, yp = 0.46, sp = entry.spec || {};
  var ktm = st.brand === "ktm", bmw = st.brand === "bmw", sport = st.type === "sport" || st.type === "hypersport", adv = st.type === "adventure", naked = st.type === "naked";
  // [3.9] the new bikes: a classic, a cruiser, a hypersport; and each maker's own cues
  var hyp = st.type === "hypersport", classic = st.type === "classic", cruiser = st.type === "cruiser", br = st.brand;
  var duc = br === "ducati", kawa = br === "kawasaki", ren = br === "royalenfield", hd = br === "harleydavidson", tri = br === "triumph", yam = br === "yamaha", suz = br === "suzuki";
  var fresh = duc || kawa || ren || hd || tri || yam || suz || classic || cruiser || hyp, cyl = Math.max(1, Math.round(+sp.cyl || 0) || 2);
  // [3.9] the existing makers' models, each its own face: KTM's 390 / 990 / 1390 Duke heads, the RC's single lamp, the
  // Adventures' vertical split lamps; BMW's round G 310 R lamp, the F 900 R's angular one, the S 1000 R's brows, the
  // S 1000 RR's asymmetric pair, the G 310 GS's asymmetric lamps (the R 1300 GS keeps its X)
  var mdl = String(entry.model || ""), d990 = ktm && /990/.test(mdl), sdr = ktm && /1390 Super Duke/.test(mdl), f900 = bmw && /F 900/.test(mdl);
  var s1kr = bmw && /S 1000 R$/.test(mdl), s1krr = bmw && /S 1000 RR/.test(mdl), m1k = bmw && /M 1000/.test(mdl), g310gs = bmw && /G 310 GS/.test(mdl);
  var ssa = duc || kawa || sdr, trellis = ktm || kawa, twinShock = classic, old = classic || cruiser;
  var boxer = sp.layout === "boxer" || (bmw && adv && (+sp.cc || 1300) > 900), small = (+sp.cc || 0) > 0 ? +sp.cc <= 400 : /\b[1-4]\d\d\b/.test(String(entry.model || ""));
  var frame = ktm ? COL.ktm : kawa ? COL.kawa : bmw ? COL.alu : old || duc || yam ? COL.black : COL.grey, accent = ktm ? COL.ktm : bmw && sport ? COL.bmwBlue : COL.grey;
  var zs0 = zr + WB*0.5, zs1 = zr + WB*0.12, rtw0 = cruiser ? 0.24 : classic ? 0.13 : sport ? 0.19 : 0.16;
  // the frame: KTM's orange trellis, a BMW's aluminium beams
  [1, -1].forEach(function(sx){
    var x = sx*0.11;
    if(trellis){
      B.bar(body, "trim", frame, [x*0.5, yh - 0.04, zh - 0.02], [x, yp + 0.06, zp + 0.02], 0.022, null, true);
      B.bar(body, "trim", frame, [x*0.5, yh - 0.02, zh - 0.04], [x, ys - 0.06, zs0], 0.022, null, true);
      B.bar(body, "trim", frame, [x, ys - 0.06, zs0], [x, yp + 0.06, zp + 0.02], 0.018, null, true);
      B.bar(body, "trim", frame, [x, yh - 0.2, zh - 0.2], [x, ys - 0.06, zs0 + 0.12], 0.016, null, true);
      // [3.5.6] the trellis's triangulation: two more tubes between the rails
      var m1 = [x*0.75, (yh - 0.04 + yp + 0.06)/2, (zh - 0.02 + zp + 0.02)/2], m2 = [x*0.8, (yh - 0.02 + ys - 0.06)/2, (zh - 0.04 + zs0)/2];
      B.bar(body, "trim", frame, m1, m2, 0.014, null, true);
      B.bar(body, "trim", frame, m1, [x, ys - 0.06, zs0], 0.014, null, true);
    } else if(old){                                                                                    // [3.9] a steel cradle
      B.bar(body, "trim", frame, [x*0.3, yh - 0.06, zh - 0.02], [x*0.8, 0.24, zh - 0.14], 0.02, null, true);
      B.bar(body, "trim", frame, [x*0.8, 0.24, zh - 0.14], [x, 0.24, zp], 0.02, null, true);
      B.bar(body, "trim", frame, [x*0.3, yh - 0.02, zh - 0.04], [x*0.7, ys - 0.08, zs0], 0.02, null, true);
    } else B.bar(body, "trim", frame, [x*0.6, yh - 0.04, zh - 0.02], [x, yp + 0.08, zp + 0.04], 0.07, 0.12);
    // the swingarm (a Ducati's and the H2's single-sided, on the left)
    if(!ssa || sx > 0) B.bar(body, "trim", ktm ? COL.black : bmw || ssa ? COL.alu : old ? COL.black : COL.grey, [x*(ssa ? 1.2 : 1), yp, zp], [x*(ssa ? 1.3 : 1.05), Rr, zr], ssa ? 0.06 : 0.04, ssa ? 0.11 : 0.07);
    B.bar(body, "trim", COL.dark, [x*0.9, ys - 0.08, zs0 - 0.02], [x*0.6, ys - 0.06, zr + 0.12], 0.03, 0.04);     // the subframe
  });
  // the shock: its body, the spring round it (by brand), a piggyback reservoir
  var sa = [0, yp + 0.04, zp - 0.02], sb = [0, ys - 0.1, zs0 - 0.05], sl = function(f){ return [sa[0] + (sb[0] - sa[0])*f, sa[1] + (sb[1] - sa[1])*f, sa[2] + (sb[2] - sa[2])*f]; };
  if(twinShock) [1, -1].forEach(function(sx){                                                         // [3.9] a classic's twin shocks
    var ta = [sx*0.15, Rr + 0.05, zr + 0.06], tb = [sx*0.14, ys - 0.07, zr + WB*0.24];
    B.bar(body, "trim", COL.dark, ta, tb, 0.016, null, true);
    B.spring(body, "trim", COL.chrome, [ta[0], ta[1] + 0.06, ta[2] + 0.02], [tb[0], tb[1] - 0.04, tb[2] - 0.02], 0.032, 0.006, 4);
  });
  else if(!cruiser){
    B.bar(body, "trim", COL.dark, sa, sb, 0.022, null, true);
    B.spring(body, "trim", ktm ? COL.ktm : kawa ? COL.kawa : sport ? COL.gold : bmw ? 0xd8dde3 : 0xc8302c, sl(0.18), sl(0.78), 0.04, 0.007, 6);
    B.bar(body, "trim", COL.gold, sl(0.85), [0.06, sb[1] - 0.02, sb[2] - 0.02], 0.022, null, true);
  }
  // [3.5.6] the swingarm's pivot bolt, the chain adjusters and axle nuts at its back, the chain slider
  B.add(body, "trim", new T.CylinderGeometry(0.025, 0.025, 0.28, 8), COL.alu, 0, yp, zp, 0, 0, PI/2);
  [1, -1].forEach(function(sx){
    B.box(body, "trim", COL.alu, 0.014, 0.034, 0.07, sx*0.145, Rr, zr + 0.05);
    B.add(body, "trim", new T.CylinderGeometry(0.022, 0.022, 0.016, 6), COL.chrome, sx*0.153, Rr, zr, 0, 0, PI/2);
  });
  B.box(body, "trim", COL.black, 0.02, 0.02, 0.2, 0.115, yp + (Rr - yp)*0.25 + 0.035, zp - 0.25*(zp - zr), Math.atan2(yp - Rr, zp - zr), 0, 0);
  // the engine: a single, a twin or a four; a boxer's cylinders stand out either side
  var ew = small ? 0.26 : sport ? 0.4 : 0.34, ez = zr + WB*0.6, eh = small ? 0.34 : 0.4;
  if(cruiser){
    // [3.9] the 45-degree V-twin: a crankcase, two finned barrels in a V with chrome rocker boxes, the round air cleaner
    ew = 0.26; eh = 0.22; ez = zr + WB*0.62;
    B.box(body, "trim", COL.dark, ew, eh, 0.5, 0, 0.27 + eh/2, ez);
    [0.4, -0.4].forEach(function(a, i){
      var bz = ez + (i ? -0.1 : 0.1), c0 = [0, 0.47, bz], dz = Math.sin(a), dy = Math.cos(a);
      B.box(body, "trim", COL.alu, 0.17, 0.3, 0.17, 0, c0[1] + dy*0.15, bz + dz*0.15, a, 0, 0);
      for(var f = 0; f < 4; f++) B.box(body, "trim", COL.grey, 0.21, 0.012, 0.21, 0, c0[1] + dy*(0.06 + f*0.06), bz + dz*(0.06 + f*0.06), a, 0, 0);
      B.box(body, "trim", COL.chrome, 0.19, 0.07, 0.19, 0, c0[1] + dy*0.33, bz + dz*0.33, a, 0, 0);
    });
    B.add(body, "trim", new T.CylinderGeometry(0.13, 0.13, 0.06, 16), COL.chrome, -0.16, 0.66, ez, 0, 0, PI/2);
    B.add(body, "trim", new T.CylinderGeometry(0.15, 0.15, 0.04, 16), COL.chrome, 0.15, 0.36, ez + 0.08, 0, 0, PI/2);   // the primary cover
  } else {
    if(old){ ew = cyl > 1 ? 0.32 : 0.22; eh = 0.32; }
    B.box(body, "trim", old ? COL.alu : COL.grey, ew, eh, 0.42, 0, 0.32 + eh/2, ez);
    B.box(body, "trim", old ? COL.alu : COL.dark, ew*0.85, 0.2, 0.22, 0, 0.32 + eh + 0.06, ez + 0.08, old ? -0.12 : -0.35, 0, 0);
  }
  if(boxer) [1, -1].forEach(function(sx){ B.box(body, "trim", COL.alu, 0.22, 0.16, 0.2, sx*0.3, 0.52, ez + 0.12); B.box(body, "trim", COL.black, 0.06, 0.18, 0.22, sx*0.42, 0.52, ez + 0.12); });
  // the exhaust (right side, -x)
  // [3.5.6] the system: a header per cylinder (a boxer's from its heads) curling down under the engine to a
  // collector, a link pipe to the end can (sport: short and high on the side; adventure: big and high; naked: low,
  // under the belly), its end cap, mouth and clamp
  var ca, cb, cr, cans = [], shiny = old ? COL.chrome : COL.steel;
  // [3.9] by maker: a Panigale's two short cans stacked under the seat, the Hayabusa's pair, a classic's peashooters
  // (one on the single, two on the twin), the Fat Boy's staggered shotgun pair; the R1 and the Triumph's short belly box
  if(duc) cans = [[[-0.15, 0.5, zr + WB*0.36], [-0.16, 0.6, zr + WB*0.14], 0.045], [[-0.15, 0.4, zr + WB*0.36], [-0.16, 0.5, zr + WB*0.16], 0.04]];
  else if(suz) cans = [1, -1].map(function(sx){ return [[sx*0.17, 0.42, zr + WB*0.38], [sx*0.19, 0.56, zr - 0.02], 0.06]; });
  else if(ren) cans = (cyl > 1 ? [-1, 1] : [-1]).map(function(sx){ return [[sx*0.15, 0.3, zr + WB*0.5], [sx*0.17, 0.39, zr - 0.1], 0.042]; });
  else if(hd) cans = [[[-0.21, 0.28, zr + WB*0.62], [-0.23, 0.3, zr - 0.08], 0.05], [[-0.21, 0.42, zr + WB*0.48], [-0.23, 0.44, zr + 0.02], 0.05]];
  else if(sport && !yam) cans = [[[-0.17, 0.46, zr + WB*0.3], [-0.19, 0.58, zr + WB*0.12], 0.055]];
  else if(adv) cans = [[[-0.21, 0.58, zr + WB*0.26], [-0.23, 0.7, zr + WB*0.04], 0.065]];
  // [3.13] the Tuning shop's exhausts instead: a fat slip-on can, a pair tucked under the tail, a long titanium end can
  var canCol = shiny;
  if(G.ex === 1) cans = [[[-0.2, 0.48, zr + WB*0.34], [-0.22, 0.6, zr + WB*0.1], 0.064]];
  else if(G.ex === 2) cans = [1, -1].map(function(sx){ return [[sx*0.08, ys - 0.17, zr + WB*0.2], [sx*0.08, ys - 0.1, zr - 0.06], 0.045]; });
  else if(G.ex === 3){ cans = [[[-0.19, 0.44, zr + WB*0.44], [-0.22, 0.68, zr - 0.06], 0.05]]; canCol = COL.ti; }
  var can = function(a, b, r){
    B.bar(body, "trim", canCol, a, b, r, null, true);
    var cd = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], cn = Math.hypot(cd[0], cd[1], cd[2]), cu = cd.map(function(v){ return v/cn; });
    var cp = function(f){ return [a[0] + cd[0]*f, a[1] + cd[1]*f, a[2] + cd[2]*f]; };
    B.bar(body, "trim", old ? COL.chrome : sport ? COL.dark : COL.black, cp(0.86), [b[0] + cu[0]*0.02, b[1] + cu[1]*0.02, b[2] + cu[2]*0.02], r + 0.006, null, true);   // the end cap
    B.bar(body, "trim", 0x050505, b, [b[0] + cu[0]*0.025, b[1] + cu[1]*0.025, b[2] + cu[2]*0.025], r*0.45, null, true);                   // the mouth
    B.bar(body, "trim", COL.dark, cp(0.04), cp(0.12), r + 0.004, null, true);                                                             // the clamp
  };
  cans.forEach(function(c){ can(c[0], c[1], c[2]); });
  if(cans.length){ ca = cans[0][0]; cb = cans[0][1]; cr = cans[0][2]; }
  else {
    var nl = small ? 0.3 : 0.4, nz = zr + WB*0.45;
    B.box(body, "trim", ktm ? COL.black : COL.steel, 0.12, 0.13, nl, -0.16, 0.36, nz);
    [0.03, -0.03].forEach(function(dx){ B.add(body, "trim", new T.CylinderGeometry(0.022, 0.022, 0.03, 8), COL.dark, -0.16 + dx, 0.34, nz - nl/2 - 0.01, PI/2, 0, 0); });   // twin outlets
    ca = [-0.13, 0.36, nz + nl/2 - 0.02];
  }
  var col0 = [-0.1, 0.26, ez - 0.15], nh = boxer ? 2 : fresh ? Math.min(4, cyl) : small ? 1 : sport ? 4 : 2;
  if(hd && !G.ex){                                                                                     // the shotgun headers, one per barrel
    B.pipe(body, "trim", COL.chrome, [[-0.06, 0.68, ez + 0.3], [-0.16, 0.5, ez + 0.36], [-0.21, 0.3, ez + 0.2], cans[0][0]], 0.028);
    B.pipe(body, "trim", COL.chrome, [[-0.06, 0.7, ez - 0.28], [-0.17, 0.56, ez - 0.2], cans[1][0]], 0.028);
  } else {
    for(var hi = 0; hi < nh; hi++){
      var hx = boxer ? (hi ? -1 : 1)*0.36 : -ew/2 + ew*(hi + 0.5)/nh, hy = boxer ? 0.48 : 0.32 + eh*0.8;
      B.pipe(body, "trim", shiny, [[hx, hy, boxer ? ez + 0.18 : ez + 0.2], [hx*0.95, 0.33, ez + 0.24], [hx*0.5 - 0.03, 0.25, ez + 0.06], col0], 0.018);
    }
    B.pipe(body, "trim", shiny, [col0, [-0.14, 0.3, col0[2] - 0.08], ca], 0.03);                         // the link pipe
    for(var ci = 1; ci < cans.length; ci++) B.pipe(body, "trim", shiny, [col0, [cans[ci][0][0]*0.6, 0.27, col0[2] - 0.04], cans[ci][0]], 0.028);
  }
  // the tank and the shrouds (paint), the seat, the tail
  var tw = cruiser ? 0.42 : classic ? 0.34 : naked ? 0.36 : sport ? 0.34 : 0.44, tTop = ys + (adv ? 0.14 : 0.12);
  if(old){
    // [3.9] a teardrop tank (fat at the front, tapering to the seat) along the backbone; a cruiser's chrome console
    var tl = cruiser ? 0.62 : 0.5, th = cruiser ? 0.25 : 0.22, tk = new T.SphereGeometry(0.5, 12, 7), tp = tk.attributes.position;
    for(var ti = 0; ti < tp.count; ti++){ var tz = tp.getZ(ti); tp.setX(ti, tp.getX(ti)*(0.72 + 0.4*(tz + 0.5))); tp.setY(ti, tp.getY(ti)*(0.85 + 0.3*(tz + 0.5))); }
    tk.computeVertexNormals(); tk.scale(tw, th, tl);
    var tky = cruiser ? ys + 0.22 : ys + 0.1, tkz = cruiser ? (zh + zs0)/2 - 0.02 : (zh + zs0)/2 + 0.04;
    B.add(body, "paint", tk, null, 0, tky, tkz, cruiser ? 0.06 : 0.1, 0, 0);
    tTop = tky + th*0.5;
    if(G.two === 2) t2().box(body, "paint", null, 0.06, 0.012, tl*0.7, 0, tTop + 0.002, tkz, cruiser ? 0.06 : 0.1, 0, 0);   // [3.13] a tank stripe
    if(cruiser) B.box(body, "trim", COL.chrome, 0.08, 0.02, tl*0.6, 0, tTop - 0.005, tkz - 0.04, 0.06, 0, 0);
    [1, -1].forEach(function(sx){ B.t("badge").add(body, "trim", new T.CircleGeometry(0.035, 12), 0xffffff, sx*(tw/2 - 0.01), tky, tkz + 0.06, 0, sx*PI/2, 0); });   // a generic round tank badge
    if(classic) [1, -1].forEach(function(sx){ B.t("knee").box(body, "trim", 0xffffff, 0.012, 0.1, 0.14, sx*(tw/2 - 0.03), tky - 0.02, tkz - 0.12, 0, 0, -sx*0.1); });   // knee pads
    if(classic) [1, -1].forEach(function(sx){ if(G.two === 3) t2(); B.box(body, "paint", null, 0.04, 0.16, 0.22, sx*0.13, ys - 0.14, zs0 - 0.12); });   // the side boxes
  } else {
    B.side(body, "paint", null, [[zh - 0.04, yh - 0.1], [zh - 0.06, yh + 0.03], [zs0 + 0.1, tTop, zh - 0.25, tTop + 0.03], [zs0, ys - 0.02],
                                 [zs0 + 0.08, ys - 0.14], [zh - 0.16, yh - 0.24]], tw, 0.03, 4);
    if(G.two === 2){                                                                                   // [3.13] a stripe over the tank's top line
      var tq0 = [zs0 + 0.1, tTop], tqc = [zh - 0.25, tTop + 0.03], tq1 = [zh - 0.06, yh + 0.03], qp = function(u){ return [(1 - u)*(1 - u)*tq0[0] + 2*u*(1 - u)*tqc[0] + u*u*tq1[0], (1 - u)*(1 - u)*tq0[1] + 2*u*(1 - u)*tqc[1] + u*u*tq1[1]]; };
      for(var qi = 0; qi < 3; qi++){ var qa = qp(0.08 + qi*0.28), qb = qp(0.08 + (qi + 1)*0.28); t2().bar(body, "paint", null, [0, qa[1] + 0.007, qa[0]], [0, qb[1] + 0.007, qb[0]], 0.07, 0.01); }
    }
    [1, -1].forEach(function(sx){ B.t("knee").box(body, "trim", 0xffffff, 0.012, 0.12, 0.17, sx*(tw/2 + 0.004), ys + 0.0, zs0 + 0.2, 0, 0, -sx*0.06); });   // [3.5.6] knee pads
  }
  if(naked || adv) [1, -1].forEach(function(sx){ if(G.two === 3) t2(); B.box(body, "paint", null, 0.03, 0.2, 0.32, sx*(tw/2 + 0.02), yh - 0.2, zh - 0.18, 0.25, 0, -sx*0.18); });
  if(ktm && naked) [1, -1].forEach(function(sx){ B.box(body, "trim", COL.black, 0.02, 0.06, 0.26, sx*(tw/2 + 0.04), yh - 0.1, zh - 0.18, 0.25, 0, -sx*0.18); });
  var tip = sport ? [zr - (suz ? 0.2 : 0.12), ys + 0.18] : adv ? [zr - 0.06, ys + 0.06] : [zr - 0.04, ys + 0.1];
  // a fender (paint) round a wheel: an open band, from angle a0 to a1 (0 = ahead, PI/2 = over the top)
  var fender = function(node, Rw, wdt, a0, a1, y, z){ return B.add(node, "paint", new T.CylinderGeometry(Rw + 0.05, Rw + 0.05, wdt, 12, 1, true, a0, a1 - a0), null, 0, y, z, 0, 0, PI/2); };
  if(classic && cyl < 2){
    // [3.9] the Classic's sprung solo saddle (two springs under its nose... and tail) and a separate pillion pad
    B.t("stitch").box(body, "trim", COL.brown, 0.27, 0.06, 0.3, 0, ys + 0.02, zs0 - 0.16, -0.06, 0, 0);
    [1, -1].forEach(function(sx){ B.spring(body, "trim", COL.chrome, [sx*0.08, ys - 0.1, zs0 - 0.3], [sx*0.08, ys - 0.01, zs0 - 0.28], 0.025, 0.005, 4); });
    B.t("stitch").box(body, "trim", COL.brown, 0.22, 0.05, 0.2, 0, ys - 0.01, zs1 + 0.02);
  } else if(cruiser){
    B.side(body, "trim", COL.black, [[zs0 + 0.06, ys - 0.03], [zs0 + 0.08, ys + 0.06], [zs0 - 0.12, ys + 0.0], [zs0 - 0.34, ys + 0.03], [zs1 + 0.04, ys + 0.13], [zs1, ys - 0.03]], 0.38, 0.02, 2);
  } else B.side(body, "trim", COL.black, [[zs0 + 0.02, ys - 0.03], [zs0 + 0.04, ys + (classic ? 0.05 : 0.03)], [zs1, ys + (sport ? 0.08 : classic ? 0.05 : 0.04)], [zs1 - 0.02, ys - 0.03]], sport ? 0.26 : 0.3, 0.015, 2);
  var py = ys - 0.2, pz = zr - 0.12;
  if(old){
    // a deep rear fender over the wheel (the tail), a round tail lamp and the plate on its back
    if(G.two === 3) t2();                                                                            // [3.13] a livery: the rear fender
    fender(body, cruiser ? Rr - 0.02 : Rr, rtw0 + 0.08, PI*0.3, PI*(cruiser ? 0.98 : 1.02), Rr, zr);
    var ta = PI*(cruiser ? 0.74 : 0.82), tly = Rr + Math.sin(ta)*(Rr + 0.06), tlz = zr + Math.cos(ta)*(Rr + 0.06);
    B.add(body, "tail", new T.CylinderGeometry(0.045, 0.045, 0.03, 12), COL.red, 0, tly + 0.04, tlz - 0.02, PI/2, 0, 0);
    tip = [tlz, tly + 0.1]; py = tly - 0.1; pz = tlz - 0.03;
  } else {
    if(G.two === 3) t2();                                                                            // [3.13] a livery: the tail unit
    B.side(body, "paint", null, [[zs1 + 0.02, ys - 0.04], [zs1, ys + (sport ? 0.1 : 0.05)], tip, [tip[0] + 0.06, tip[1] - 0.12], [zs1 - 0.05, ys - 0.14]], sport ? 0.2 : 0.18, 0.02, 2);
    B.t("ledbar").box(body, "tail", COL.red, 0.1, 0.035, 0.02, 0, tip[1] - 0.06, tip[0] + 0.02);         // [3.5.6] an LED bar
  }
  if(adv) B.box(body, "trim", COL.black, 0.32, 0.03, 0.34, 0, ys + 0.09, zr + 0.02);                         // the luggage rack
  B.t("plate").box(body, "trim", 0xffffff, 0.18, 0.12, 0.012, 0, py, pz, 0.4, 0, 0);                         // the plate
  // [3.5.6] its hanger: two struts up to the tail tidy, the plate light over it
  if(!old) [1, -1].forEach(function(sx){ B.bar(body, "trim", COL.black, [sx*0.07, ys - 0.15, zr - 0.1], [sx*0.05, ys - 0.12, zr - 0.02], 0.008, null, true); });
  B.box(body, "light", COL.head, 0.05, 0.012, 0.02, 0, ys - 0.13, zr - 0.1);
  [1, -1].forEach(function(sx){ B.box(body, "light", COL.amber, 0.04, 0.025, 0.04, sx*0.12, ys - 0.12, zr - 0.1); });
  if(!old) B.add(body, "trim", (function(){ var g = new T.TorusGeometry(Rr + 0.04, 0.025, 3, 10, PI*0.45); g.rotateZ(PI*0.3); g.rotateY(PI/2); return g; })(), COL.black, 0, Rr, zr);   // the hugger
  // the pegs (a classic's under the hips; a cruiser's forward controls: floorboards ahead of the engine)
  var fz = sport ? zr + WB*0.3 : cruiser ? zr + WB*0.86 : classic ? zr + WB*0.45 : zr + WB*0.4, fy = sport ? 0.44 : cruiser ? 0.34 : classic ? 0.32 : 0.36;
  if(cruiser) [1, -1].forEach(function(sx){ B.box(body, "trim", COL.black, 0.13, 0.025, 0.3, sx*0.25, fy - 0.03, fz); B.box(body, "trim", COL.chrome, 0.015, 0.03, 0.3, sx*0.315, fy - 0.025, fz); });
  else [1, -1].forEach(function(sx){ B.box(body, "trim", COL.steel, 0.1, 0.025, 0.04, sx*0.2, fy, fz); });
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
  var fx0 = cruiser ? 0.25 : 0.2;
  anchor(T, root, "a-foot-l", fx0, fy + 0.02, fz); anchor(T, root, "a-foot-r", -fx0, fy + 0.02, fz);
  anchor(T, root, "a-seat", 0, ys + 0.02, zr + WB*(sport ? 0.3 : classic ? 0.37 : cruiser ? 0.31 : 0.33));
  // the front, frame-mounted: a sport bike's fairing and screen; an adventure bike's beak, fairing, screen, X light
  if(sport){
    // the fairing: a pointed nose out over the front wheel, the upper round the steering head, the lower down to the belly pan
    // ([3.9] the Hayabusa's longer, rounder nose and fuller flanks)
    if(suz) B.side(body, "paint", null, [[zf + 0.1, yh - 0.18], [zh + 0.12, yh + 0.08, zf + 0.06, yh + 0.02], [zh - 0.22, yh - 0.0], [zr + WB*0.5, 0.56],
                                         [zr + WB*0.58, 0.26], [zh - 0.04, 0.3], [zh + 0.16, yh - 0.44], [zf + 0.06, yh - 0.34, zf + 0.12, yh - 0.26]], 0.46, 0.08, 5);
    else B.side(body, "paint", null, [[zf + 0.02, yh - 0.14], [zh + 0.14, yh + 0.07], [zh - 0.2, yh - 0.02], [zr + WB*0.52, 0.52],
                                 [zr + WB*0.6, 0.27], [zh - 0.02, 0.32], [zh + 0.14, yh - 0.42], [zf - 0.04, yh - 0.3]], 0.42, 0.07, 3);
    B.side(body, "glass", null, [[zh + 0.15, yh + 0.06], [zh - 0.08, yh + 0.2], [zh - 0.12, yh + 0.15], [zh + 0.06, yh + 0.04]], 0.28, 0.005, 1);
    var zn = suz ? zf + 0.06 : zf;
    [1, -1].forEach(function(sx){
      if(duc){                                                                                        // [3.9] a Panigale's DRL slashes over dark intakes, its biplane winglets
        B.box(body, "light", COL.drl, 0.1, 0.014, 0.012, sx*0.085, yh - 0.13, zf - 0.01, 0, sx*0.35, -sx*0.32);
        B.t("honey").box(body, "trim", 0xffffff, 0.07, 0.05, 0.02, sx*0.07, yh - 0.2, zf - 0.03, 0, sx*0.35, 0);
        [0, 0.06].forEach(function(dy){ B.box(body, "trim", COL.dark, 0.1, 0.012, 0.16, sx*0.25, yh - 0.12 - dy, zh - 0.02, 0, 0, -sx*0.25); });
      } else if(yam){                                                                                 // the R1's slim DRL slits high on the nose
        B.box(body, "light", COL.drl, 0.09, 0.012, 0.012, sx*0.1, yh - 0.12, zf - 0.02, 0, sx*0.4, -sx*0.3);
      } else if(kawa){                                                                                // the H2's brow, its chrome-mirror flanks and carbon wings
        B.box(body, "light", COL.drl, 0.08, 0.01, 0.01, sx*0.07, yh - 0.15, zf - 0.01, 0, sx*0.35, -sx*0.2);
        B.box(body, "trim", COL.chrome, 0.012, 0.16, 0.42, sx*0.215, yh - 0.32, zh - 0.08, 0.3, 0, -sx*0.12);
        B.box(body, "trim", COL.dark, 0.09, 0.012, 0.13, sx*0.23, yh - 0.08, zh - 0.0, 0, 0, -sx*0.3);
      } else if(suz){                                                                                 // the Hayabusa's position lamps, ram-air mouths, chrome strake
        B.box(body, "light", COL.drl, 0.05, 0.012, 0.012, sx*0.07, yh - 0.12, zn - 0.03, 0, sx*0.4, 0);
        B.t("honey").box(body, "trim", 0xffffff, 0.05, 0.06, 0.02, sx*0.075, yh - 0.25, zn - 0.04, 0, sx*0.35, 0);
        B.box(body, "trim", COL.chrome, 0.012, 0.025, 0.5, sx*0.235, yh - 0.36, zh - 0.12, 0.12, 0, 0);
      } else if(ktm){                                                                                 // [3.9] the RC: DRL slashes either side of one lamp
        B.box(body, "light", COL.drl, 0.08, 0.012, 0.012, sx*0.08, yh - 0.15, zf - 0.01, 0, sx*0.35, -sx*0.45);
      } else if(s1krr){                                                                               // the S 1000 RR's asymmetric pair: round left, wide right
        if(sx > 0) B.t("bikehead").add(body, "light", new T.CircleGeometry(0.04, 12), COL.head, 0.075, yh - 0.17, zf + 0.004, 0, 0.35, 0);
        else B.t("head").box(body, "light", COL.head, 0.11, 0.04, 0.03, -0.08, yh - 0.17, zf, 0, -0.35, 0);
        B.box(body, "light", COL.drl, 0.06, 0.008, 0.01, sx*0.09, yh - 0.13, zf - 0.01, 0, sx*0.35, -sx*0.25);
      } else {
        B.t("head").box(body, "light", COL.head, 0.09, 0.035, 0.03, sx*0.08, yh - 0.17, zf - 0.0, 0, sx*0.35, 0);
        B.box(body, "light", COL.drl, 0.07, 0.008, 0.01, sx*0.09, yh - 0.145, zf - 0.01, 0, sx*0.35, -sx*0.25);   // [3.5.6] the DRL brow
      }
      B.box(body, "trim", COL.black, 0.07, 0.04, 0.05, sx*(d.widthM/2 - 0.035), yh + 0.04, zh + 0.06);         // mirrors
    });
    if(yam){                                                                                          // the M1 face: a big dark mouth, the projector inside it
      B.t("honey").box(body, "trim", 0xffffff, 0.15, 0.09, 0.02, 0, yh - 0.22, zf - 0.02, -0.2, 0, 0);
      B.t("bikehead").add(body, "light", new T.CircleGeometry(0.03, 12), COL.head, 0, yh - 0.22, zf + 0.0);
    }
    if(kawa){
      B.t("head").box(body, "light", COL.head, 0.09, 0.04, 0.02, 0, yh - 0.2, zf - 0.005);                     // one central lamp
      B.bar(body, "trim", COL.black, [0.16, yh - 0.24, zf - 0.08], [0.17, 0.62, ez + 0.12], 0.05, null, true);  // the ram-air duct on the left
    }
    if(suz) B.t("head").box(body, "light", COL.head, 0.07, 0.13, 0.02, 0, yh - 0.2, zn - 0.005);           // the stacked vertical headlight
    if(ktm) B.t("head").box(body, "light", COL.head, 0.08, 0.06, 0.02, 0, yh - 0.19, zf - 0.005);         // the RC's one lamp
    if(bmw) B.box(body, "trim", COL.bmwBlue, 0.02, 0.06, 0.5, 0.29, yh - 0.25, zh - 0.1, 0.4, 0, 0);
  }
  if(adv){
    B.side(body, "paint", null, [[zf + 0.16, Rf*2 + 0.06], [zf + 0.2, Rf*2 + 0.1], [zh + 0.12, yh - 0.06], [zh + 0.02, yh - 0.16]], 0.16, 0.02, 2);
    B.box(body, "paint", null, 0.38, 0.3, 0.22, 0, yh + 0.04, zh + 0.18);
    B.side(body, "glass", null, [[zh + 0.26, yh + 0.16], [zh + 0.07, yh + 0.42], [zh + 0.01, yh + 0.4], [zh + 0.18, yh + 0.14]], 0.36, 0.005, 1);
    if(ktm) [1, -1].forEach(function(sx){                                                             // [3.9] a KTM's vertical split lamps
      B.t("head").box(body, "light", COL.head, 0.05, 0.17, 0.006, sx*0.045, yh + 0.03, zh + 0.293);
      B.box(body, "light", COL.drl, 0.014, 0.19, 0.006, sx*0.1, yh + 0.04, zh + 0.296, 0, 0, sx*0.15);
    });
    else if(g310gs){                                                                                  // the G 310 GS: an asymmetric pair
      B.t("bikehead").add(body, "light", new T.CircleGeometry(0.06, 14), COL.head, 0.07, yh + 0.04, zh + 0.296);
      var ov = new T.CircleGeometry(0.06, 14); ov.scale(1.3, 0.75, 1); B.t("bikehead").add(body, "light", ov, COL.head, -0.07, yh + 0.03, zh + 0.296);
    } else {
      [0.6, -0.6].forEach(function(r){ B.box(body, "light", COL.drl, 0.03, 0.2, 0.02, 0, yh + 0.04, zh + 0.3, 0, 0, r); });
      B.t("bikehead").box(body, "light", COL.head, 0.17, 0.15, 0.004, 0, yh + 0.04, zh + 0.293);            // [3.5.6] the projector behind the X
    }
    [1, -1].forEach(function(sx){ B.bar(body, "trim", COL.black, [sx*0.18, 0.62, ez + 0.3], [sx*0.36, 0.42, ez + 0.08], 0.02, null, true); });   // crash bars
  }
  // detail: the chain and its guard, the rear caliper, the radiator, the clutch cover and the head's fins, the tank's
  // stripe and cap, pillion pegs, a skid plate (adventure), winglets (an M superbike), the tail tidy
  var rtw = rtw0, cx = cruiser ? 0.16 : 0.12, fsz = zp + 0.08, fsy = yp - 0.02, rs = Rr*0.4;
  B.bar(body, "trim", COL.dark, [cx, fsy + 0.045, fsz], [cx, Rr + rs, zr], 0.012, 0.02);                    // the chain, top run
  B.bar(body, "trim", COL.dark, [cx, fsy - 0.045, fsz], [cx, Rr - rs, zr], 0.012, 0.02);                    // and bottom
  B.add(body, "trim", new T.CylinderGeometry(0.05, 0.05, 0.02, 10), COL.dark, cx, fsy, fsz, 0, 0, PI/2);     // the front sprocket
  B.bar(body, "trim", COL.black, [cx + 0.01, fsy + 0.09, fsz - 0.05], [cx + 0.01, Rr + rs + 0.05, zr + 0.2], 0.008, 0.05);   // the guard
  B.box(body, "trim", COL.gold, 0.04, 0.09, 0.07, -(rtw/2 + 0.05), Rr + Rr*0.45, zr - Rr*0.2, 0.5, 0, 0);   // the rear caliper
  if(!boxer && !old){
    B.box(body, "trim", COL.dark, ew + 0.12, small ? 0.26 : 0.34, 0.05, 0, 0.32 + eh*0.65, ez + 0.3, -0.25, 0, 0);   // the radiator
    B.t("radfin").box(body, "trim", 0xffffff, ew + 0.06, small ? 0.2 : 0.28, 0.01, 0, 0.32 + eh*0.65, ez + 0.33, -0.25, 0, 0);
  }
  B.add(body, "trim", new T.CylinderGeometry(0.12, 0.12, 0.03, 14), ktm ? COL.ktm : COL.alu, ew/2 + 0.015, 0.42, ez - 0.02, 0, 0, PI/2);   // the clutch cover
  if(!cruiser) for(var fi = 0; fi < (classic ? 6 : 3); fi++) B.box(body, "trim", classic ? COL.grey : COL.alu, ew*(classic ? 1.15 : 0.9), 0.012, classic ? 0.3 : 0.25, 0, 0.32 + eh + (classic ? 0.12 : -0.02) - fi*0.045, ez + 0.06);   // the head's fins (a classic's air-cooled barrel)
  if(!old) B.bar(body, "trim", ktm ? COL.ktm : bmw ? (sport ? 0xd02030 : COL.bmwBlue) : duc ? COL.alu : kawa ? COL.kawa : 0xf0f0f0, [0, yh + 0.045, zh - 0.1], [0, tTop + 0.012, zs0 + 0.16], 0.07, 0.012);   // the stripe
  B.add(body, "trim", new T.CylinderGeometry(0.04, 0.04, 0.02, 10), COL.alu, 0.07, (yh + tTop)/2 + 0.04, (zh + zs0)/2 + 0.02);   // the filler cap
  [1, -1].forEach(function(sx){ B.box(body, "trim", COL.steel, 0.08, 0.02, 0.035, sx*0.19, fy + 0.12, zr + WB*0.18); });          // pillion pegs
  if(adv){
    B.box(body, "trim", COL.alu, ew + 0.1, 0.03, 0.5, 0, 0.27, ez + 0.02, -0.06, 0, 0);                     // the skid plate
    [1, -1].forEach(function(sx){ B.bar(body, "trim", COL.black, [sx*0.17, ys - 0.08, zr + 0.25], [sx*0.19, ys - 0.24, zr - 0.05], 0.016, null, true); });   // the rack's rails
  }
  if(m1k || s1krr) [1, -1].forEach(function(sx){ B.box(body, "trim", COL.dark, m1k ? 0.09 : 0.07, 0.012, m1k ? 0.16 : 0.12, sx*0.24, yh - 0.12, zh - 0.02, 0, 0, -sx*0.3); });   // winglets (the M's bigger)
  if(m1k) [0.3, 0.35].forEach(function(x, i){ B.box(body, "trim", i ? COL.bmwBlue : 0xd02030, 0.02, 0.03, 0.5, x - 0.06, yh - 0.31 - i*0.035, zh - 0.1, 0.4, 0, 0); });   // the M stripes
  if(!old) B.bar(body, "trim", COL.black, [0, tip[1] - 0.09, tip[0] + 0.04], [0, ys - 0.2, zr - 0.08], 0.05, 0.012);   // the tail tidy
  // the steering: fork, front wheel, mudguard, bars (clip-ons on a sport bike), a naked bike's headlight
  var steer = B.node(root, "steer", 0, yh, zh);
  var fx = [zf - zh, Rf - yh], forkCol = ktm ? COL.ktm : sport ? COL.gold : old ? COL.chrome : COL.steel;
  [1, -1].forEach(function(sx){ B.bar(steer, "trim", forkCol, [sx*0.085, 0.02, 0.02], [sx*0.085, fx[1] + 0.05, fx[0] - 0.01], 0.028, null, true); });
  B.box(steer, "trim", COL.dark, 0.24, 0.05, 0.1, 0, 0.0, 0.0);
  if(old) fender(steer, Rf, (cruiser ? 0.16 : 0.1) + 0.06, cruiser ? PI*0.2 : PI*0.05, PI*0.78, fx[1], fx[0]);   // [3.9] a classic's deep front fender
  else B.add(steer, "trim", (function(){ var g = new T.TorusGeometry(Rf + 0.035, 0.03, 3, 10, PI*0.4); g.rotateZ(PI*0.32); g.rotateY(PI/2); return g; })(), adv ? COL.black : COL.dark, 0, fx[1], fx[0]);
  var grips, by0 = 0;
  if(sport){
    var cw = fresh ? Math.max(0.26, d.widthM/2 - 0.09) : 0.3;
    [1, -1].forEach(function(sx){ B.bar(steer, "trim", COL.black, [sx*0.1, 0.0, -0.02], [sx*cw, 0.0, -0.1], 0.016, null, true); });
    grips = [cw, 0.0, -0.1]; by0 = 0.04;
  } else {
    // ([3.9] a classic's bars up and back; a cruiser's wide pull-back bars on risers)
    var bw = Math.max(0.3, d.widthM/2 - 0.012), by = adv ? 0.2 : old ? 0.16 : 0.13, bz = adv ? -0.22 : cruiser ? -0.3 : classic ? -0.14 : -0.17; by0 = by;
    if(cruiser){
      B.pipe(steer, "trim", COL.chrome, [[bw, by, bz], [0.14, by + 0.03, -0.07], [-0.14, by + 0.03, -0.07], [-bw, by, bz]], 0.015);
      [1, -1].forEach(function(sx){ B.bar(steer, "trim", COL.chrome, [sx*0.05, 0.03, 0], [sx*0.06, by + 0.03, -0.07], 0.016, null, true); });
    } else {
      B.bar(steer, "trim", old ? COL.chrome : COL.black, [bw, by, bz], [-bw, by, bz], 0.014, null, true);
      B.bar(steer, "trim", COL.dark, [0, 0.02, 0], [0, by, bz], 0.02, null, true);
    }
    if(adv) [1, -1].forEach(function(sx){ B.box(steer, "paint", null, 0.08, 0.06, 0.12, sx*(bw - 0.02), by + 0.02, bz + 0.08); });
    [1, -1].forEach(function(sx){ B.bar(steer, "trim", COL.black, [sx*(bw - 0.12), by, bz], [sx*(bw - 0.06), by + 0.13, bz - 0.04], 0.008, null, true); B.box(steer, "trim", COL.black, 0.09, 0.05, 0.02, sx*(bw - 0.05), by + 0.15, bz - 0.04); });
    grips = [bw - 0.04, by, bz];
  }
  if(old){
    // [3.9] a round headlamp in a chrome bucket and ring (the Classic's under its nacelle, with two pilot lamps); the
    // Fat Boy's bigger one between chrome fork shrouds
    var hr = cruiser ? 0.11 : 0.085, hz = cruiser ? 0.2 : 0.16, hy = cruiser ? -0.1 : -0.07;
    B.add(steer, "trim", new T.CylinderGeometry(hr, hr*0.85, 0.12, 14), COL.chrome, 0, hy, hz - 0.05, PI/2, 0, 0);
    var ring = new T.TorusGeometry(hr, 0.012, 3, 16); B.add(steer, "trim", ring, COL.chrome, 0, hy, hz + 0.012);
    B.t("bikehead").add(steer, "light", new T.CircleGeometry(hr - 0.008, 16), COL.head, 0, hy, hz + 0.014);
    if(ren && cyl < 2){
      B.box(steer, "paint", null, 0.2, 0.06, 0.16, 0, hy + hr + 0.01, hz - 0.08, -0.15, 0, 0);
      [1, -1].forEach(function(sx){ B.add(steer, "light", new T.CylinderGeometry(0.022, 0.022, 0.03, 10), COL.head, sx*0.12, hy - 0.02, hz - 0.04, PI/2, 0, 0); });
    }
    if(cruiser) [1, -1].forEach(function(sx){ B.bar(steer, "trim", COL.chrome, [sx*0.1, 0.0, 0.0], [sx*0.1, fx[1]*0.45, fx[0]*0.45 + 0.01], 0.055, null, true); });
  }
  if(naked){
    B.box(steer, "trim", COL.black, 0.16, 0.18, 0.1, 0, -0.06, 0.12);
    if(tri){                                                                                           // [3.9] the Triumph's bug eyes
      [1, -1].forEach(function(sx){ var e = new T.CylinderGeometry(0.06, 0.06, 0.03, 14); e.rotateX(PI/2); e.scale(1, 1.3, 1);
        B.add(steer, "trim", e, COL.black, sx*0.065, -0.06, 0.15); var f = new T.CircleGeometry(0.05, 14); f.scale(1, 1.3, 1);
        B.t("bikehead").add(steer, "light", f, COL.head, sx*0.065, -0.06, 0.167); });
      B.box(steer, "paint", null, 0.2, 0.08, 0.03, 0, 0.06, 0.12, -0.5, 0, 0);                              // the fly screen
    } else if(d990){                                                                                  // [3.9] the 990: two thin vertical DRLs over a wide lamp
      [1, -1].forEach(function(sx){ B.box(steer, "light", COL.drl, 0.018, 0.13, 0.02, sx*0.055, -0.03, 0.175, 0, 0, sx*0.12); });
      B.t("head").box(steer, "light", COL.head, 0.09, 0.05, 0.02, 0, -0.11, 0.17);
    } else if(sdr){                                                                                   // the 1390: a split lamp clasped by DRL pincers
      [1, -1].forEach(function(sx){ B.box(steer, "light", COL.head, 0.04, 0.12, 0.02, sx*0.032, -0.06, 0.175);
        B.box(steer, "light", COL.drl, 0.016, 0.09, 0.02, sx*0.08, -0.01, 0.17, 0, 0, sx*0.6); B.box(steer, "light", COL.drl, 0.016, 0.09, 0.02, sx*0.08, -0.11, 0.17, 0, 0, -sx*0.6); });
    } else if(ktm){ [1, -1].forEach(function(sx){ B.box(steer, "light", COL.head, 0.045, 0.15, 0.02, sx*0.04, -0.06, 0.175); B.box(steer, "light", COL.drl, 0.02, 0.1, 0.02, sx*0.085, -0.03, 0.17, 0, 0, sx*0.5); }); }
    else if(f900){                                                                                    // an angular lamp under a V of DRL
      B.t("head").box(steer, "light", COL.head, 0.13, 0.07, 0.02, 0, -0.07, 0.175);
      [1, -1].forEach(function(sx){ B.box(steer, "light", COL.drl, 0.08, 0.014, 0.02, sx*0.04, -0.02, 0.178, 0, 0, -sx*0.3); });
    } else if(s1kr){                                                                                  // a wide, narrow lamp under two brows
      B.t("head").box(steer, "light", COL.head, 0.15, 0.045, 0.02, 0, -0.08, 0.175);
      [1, -1].forEach(function(sx){ B.box(steer, "light", COL.drl, 0.07, 0.012, 0.02, sx*0.045, -0.035, 0.178, 0, 0, sx*0.25); });
    } else B.t("bikehead").add(steer, "light", new T.CylinderGeometry(0.075, 0.075, 0.02, 16), COL.head, 0, -0.05, 0.18, PI/2, 0, 0);
  }
  // the fork's lower legs and axle clamps, the front calipers, the top clamp, grips, levers and their reservoirs, the dash
  [1, -1].forEach(function(sx){
    var lo = [sx*0.085, fx[1] + 0.04, fx[0] - 0.01], hi = [sx*0.085, fx[1]*0.45, fx[0]*0.45 + 0.01];
    B.bar(steer, "trim", sport || ktm ? COL.dark : classic ? COL.black : COL.steel, lo, hi, classic ? 0.042 : 0.036, null, true);   // ([3.9] a classic's gaiters)
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
  var rim = G.rimCol != null ? G.rimCol : ktm && naked ? COL.ktm : bmw && sport ? COL.bmwBlue : adv || cruiser ? COL.alu : classic ? COL.chrome : yam ? COL.grey : COL.black;
  var wire = adv && (ktm || !small) || classic;
  var tape = rim === COL.black ? (ktm ? COL.ktm : bmw ? COL.bmwBlue : 0xf0f0f0) : rim === COL.ktm ? 0xf4f4f4 : COL.black;
  if(wire) tape = COL.black;
  bikeWheel(B, root, "wheel-0", Rr, rtw, rim, [-1], 0, Rr, zr, wire, true, tape, cruiser, G.rim, G.size);
  bikeWheel(B, steer, "wheel-1", Rf, cruiser ? 0.16 : classic ? 0.1 : 0.12, rim, small || (classic && cyl < 2) ? [-1] : [1, -1], 0, fx[1], fx[0], wire, false, tape, cruiser, G.rim, G.size);
  finish(T, root);
  // [3.13] where a custom plate goes: over the atlas plate's back face (tilted with it)
  var pn = [0, Math.sin(0.4), -Math.cos(0.4)];
  return {g: root, meta: {kind: "bike", R: Rr, radii: [Rr, Rf], lean: S.lean, riderK: null,
                          plates: [{p: [pn[0]*0.0075, py + pn[1]*0.0075, pz + pn[2]*0.0075], ry: PI, rx: 0.4, w: 0.17, h: 0.11}]}};
}

// [3.14.1] a step-through scooter: a leg shield and apron in front, a flat floorboard, the body under a long seat
// over the engine-and-swingarm unit (left) and the silencer (right), a handlebar cover carrying the lamp and the
// clocks, a grab rail; seats for three (the rider, then two behind: a-seat-1, a-seat-2)
function buildScooter(T, entry, st, d, G){
  G = G || GEO0;
  var B = new Builder(T), root = new T.Group(), body = B.node(root, "body"), t2 = function(){ return B.t("tone2"); };
  var S = BIKE.scooter, WB = d.wheelbaseM, sc = d.heightM/DIMS["bike.scooter"].heightM, L = d.lengthM, W = d.widthM;
  var Rr = S.Rr, Rf = S.Rf, zr = -WB/2, zf = WB/2, yh = S.head*sc, ys = S.seat*Math.min(1.1, Math.max(0.9, sc));
  var zh = zf - 0.16, yf = 0.3, zfl0 = zf - 0.3, zfl1 = zr + WB*0.5, zt = -L/2 + 0.05, bw = Math.min(0.42, W*0.62);
  // the leg shield and the front apron (a wedge from the front fender's top up to the bar cover)
  B.side(body, "paint", null, [[zf - 0.22, yf - 0.04], [zf - 0.02, yf + 0.12], [zf + 0.04, yh - 0.3, zf + 0.06, yf + 0.4], [zh + 0.02, yh - 0.1],
                               [zh - 0.08, yh - 0.12], [zfl0 + 0.02, yf + 0.3, zfl0 + 0.04, yh - 0.4], [zfl0, yf]], 0.34, 0.02);
  t2().box(body, "paint", null, 0.36, 0.04, 0.12, 0, yh - 0.42, zf + 0.0, -1.2, 0, 0);                         // the apron's crease
  B.box(body, "trim", COL.dark, 0.3, 0.42, 0.02, 0, yf + 0.3, zfl0 - 0.02, 0.12, 0, 0);                          // the inner shield, its hook
  B.box(body, "trim", COL.black, 0.05, 0.04, 0.03, 0, yf + 0.5, zfl0 - 0.04);
  [1, -1].forEach(function(sx){                                                                                    // the apron's indicators
    B.box(body, "light", COL.amber, 0.06, 0.03, 0.03, sx*0.13, yh - 0.36, zf + 0.02, -0.5, sx*0.4, 0);
  });
  B.t("bikehead").plate(body, "light", COL.head, 0.12, 0.07, 0.02, 0.02, 0, yh - 0.28, zf + 0.06, 0);           // the apron lamp
  // the floorboard, its rubber mat, the frame under it
  B.box(body, "trim", COL.dark, 0.34, 0.05, zfl0 - zfl1, 0, yf - 0.02, (zfl0 + zfl1)/2);
  B.box(body, "trim", COL.black, 0.3, 0.012, zfl0 - zfl1 - 0.06, 0, yf + 0.01, (zfl0 + zfl1)/2);
  [1, -1].forEach(function(sx){ B.box(body, "paint", null, 0.03, 0.1, zfl0 - zfl1 + 0.04, sx*0.18, yf - 0.06, (zfl0 + zfl1)/2); });
  // the body: from the floor's end up under the seat and back over the rear wheel to the tail
  var bodyPts = [[zfl1 + 0.02, yf - 0.06], [zfl1, ys - 0.12, zfl1 + 0.02, ys - 0.24], [zr + 0.05, ys - 0.03], [zt + 0.06, ys - 0.06, zt - 0.02, ys - 0.03],
                 [zt, ys - 0.2], [zr - 0.02, Rr + 0.2, zr - 0.12, Rr + 0.18], [zr + 0.22, Rr + 0.14], [zr + 0.3, yf - 0.08]];
  B.side(body, "paint", null, bodyPts, bw, 0.03, 6, 2);
  if(G.two === 2 || G.two === 3) t2().box(body, "paint", null, bw + 0.01, 0.025, 0.4, 0, ys - 0.14, zr + 0.18, 0.05, 0, 0);   // a side stripe
  B.box(body, "trim", COL.chrome, bw + 0.012, 0.02, 0.22, 0, ys - 0.2, zfl1 - 0.12, -0.25, 0, 0);               // the side garnish
  // the seat: long and flat, a step for the pillion
  B.side(body, "trim", COL.black, [[zfl1 - 0.02, ys - 0.02], [zfl1 + 0.02, ys + 0.06, zfl1, ys + 0.05], [zr + 0.05, ys + 0.07], [zr - 0.02, ys + 0.1],
                                   [zt + 0.1, ys + 0.09, zt + 0.06, ys + 0.1], [zt + 0.08, ys - 0.01]], bw - 0.04, 0.025, 5, 2);
  B.box(body, "trim", COL.dark, bw - 0.02, 0.012, L*0.42, 0, ys + 0.0, (zfl1 + zt)/2 + 0.06);                   // its piping
  // the grab rail round the seat's back, the tail lamp and indicators, the plate on its hanger
  [1, -1].forEach(function(sx){ B.bar(body, "trim", COL.alu, [sx*(bw/2 - 0.01), ys + 0.02, zr + 0.06], [sx*(bw/2 - 0.03), ys + 0.04, zt + 0.08], 0.016, null, true); });
  B.bar(body, "trim", COL.alu, [bw/2 - 0.03, ys + 0.04, zt + 0.08], [-(bw/2 - 0.03), ys + 0.04, zt + 0.08], 0.016, null, true);
  B.box(body, "tail", COL.red, 0.2, 0.06, 0.03, 0, ys - 0.12, zt - 0.01, 0.3, 0, 0);
  [1, -1].forEach(function(sx){ B.box(body, "light", COL.amber, 0.05, 0.03, 0.02, sx*0.14, ys - 0.13, zt + 0.0, 0.3, 0, 0); });
  var py = Rr + 0.24, pz = zt + 0.02;
  B.box(body, "trim", COL.black, 0.16, 0.2, 0.02, 0, py + 0.05, pz + 0.04, 0.4, 0, 0);
  B.t("plate").box(body, "trim", 0xf2f2f2, 0.16, 0.1, 0.006, 0, py, pz, 0.4, PI, 0);
  // the rear mudguard; the engine-and-swingarm unit and its belt cover (left), the silencer and its guard (right), the shock
  B.add(body, "trim", new T.CylinderGeometry(Rr + 0.04, Rr + 0.04, 0.14, 10, 1, true, PI*0.15, PI*0.65), COL.black, 0, Rr, zr, 0, 0, PI/2);
  B.side(body, "trim", COL.grey, [[zr + 0.38, 0.32], [zr + 0.36, 0.14], [zr - 0.02, Rr - 0.06], [zr - 0.06, Rr + 0.06], [zr + 0.1, Rr + 0.14], [zr + 0.38, 0.34]], 0.08, 0.01);
  B.box(body, "trim", COL.dark, 0.012, 0.16, 0.42, 0.09, Rr + 0.03, zr + 0.17, -0.12, 0, 0);
  B.box(body, "trim", COL.black, 0.14, 0.14, 0.16, 0, 0.26, zr + 0.42);
  B.bar(body, "trim", COL.dark, [-0.14, 0.2, zr + 0.25], [-0.17, Rr + 0.02, zr - 0.18], 0.06, 0.09);
  B.add(body, "trim", new T.CylinderGeometry(0.05, 0.045, 0.3, 10), COL.steel, -0.17, Rr + 0.03, zr - 0.08, PI/2 - 0.12, 0, 0);
  B.box(body, "trim", COL.black, 0.02, 0.06, 0.22, -0.22, Rr + 0.08, zr - 0.06, -0.12, 0, 0);
  B.bar(body, "trim", COL.dark, [0.1, Rr + 0.02, zr - 0.02], [0.1, ys - 0.12, zr + 0.1], 0.02, null, true);
  B.spring(body, "trim", COL.alu, [0.1, Rr + 0.06, zr - 0.01], [0.1, ys - 0.16, zr + 0.09], 0.03, 0.006, 5);
  B.box(body, "trim", COL.dark, 0.05, 0.03, 0.18, 0, 0.14, zfl1 + 0.05);                                       // the centre stand, folded
  // the pillion's footrests (folded out), behind the floorboard
  [1, -1].forEach(function(sx){ B.box(body, "trim", COL.black, 0.07, 0.02, 0.06, sx*(bw/2 + 0.04), yf + 0.02, zr + 0.36); });
  anchor(T, root, "a-foot-l", 0.11, yf + 0.03, zfl0 - 0.12); anchor(T, root, "a-foot-r", -0.11, yf + 0.03, zfl0 - 0.12);
  anchor(T, root, "a-seat", 0, ys + 0.06, zfl1 - 0.05);
  anchor(T, root, "a-seat-1", 0, ys + 0.08, zfl1 - 0.37);
  anchor(T, root, "a-seat-2", 0, ys + 0.1, zfl1 - 0.66);
  // the steering: one fork leg each side under a full front fender, the bar cover (the clocks in it), bars, mirrors
  var steer = B.node(root, "steer", 0, yh, zh);
  var fx = [zf - zh, Rf - yh];
  [1, -1].forEach(function(sx){ B.bar(steer, "trim", COL.dark, [sx*0.07, -0.22, 0.0], [sx*0.07, fx[1] + 0.04, fx[0] - 0.01], 0.026, null, true); });
  B.add(steer, "paint", new T.CylinderGeometry(Rf + 0.04, Rf + 0.04, 0.13, 12, 1, true, PI*0.05, PI*0.75), null, 0, fx[1], fx[0], 0, 0, PI/2);
  B.side(steer, "paint", null, [[0.12, -0.02], [0.14, 0.06, 0.15, 0.03], [0.06, 0.12], [-0.12, 0.11], [-0.16, 0.04, -0.17, 0.08], [-0.1, -0.03]], 0.48, 0.02, 4, 2);
  B.box(steer, "trim", COL.black, 0.2, 0.02, 0.12, 0, 0.118, -0.04, 0.25, 0, 0);
  B.box(steer, "light", 0x9fd8ff, 0.14, 0.008, 0.08, 0, 0.122, -0.04, 0.25, 0, 0);                               // the clocks
  var grips = [0.33, 0.04, -0.06];
  [1, -1].forEach(function(sx){
    B.add(steer, "trim", new T.CylinderGeometry(0.026, 0.026, 0.11, 8), COL.black, sx*(grips[0] - 0.02), grips[1], grips[2], 0, 0, PI/2);
    B.bar(steer, "trim", COL.alu, [sx*0.22, grips[1] + 0.01, grips[2] + 0.04], [sx*(grips[0] + 0.02), grips[1], grips[2] + 0.06], 0.007, 0.012);
    B.bar(steer, "trim", COL.black, [sx*0.18, 0.1, -0.02], [sx*0.25, 0.13, -0.04], 0.008, null, true);   // the mirrors
    B.box(steer, "trim", COL.black, 0.11, 0.06, 0.02, sx*0.28, 0.15, -0.04, 0, sx*0.2, 0);
  });
  anchor(T, steer, "a-grip-l", grips[0], grips[1], grips[2]); anchor(T, steer, "a-grip-r", -grips[0], grips[1], grips[2]);
  var rim = G.rimCol != null ? G.rimCol : COL.grey;
  bikeWheel(B, root, "wheel-0", Rr, 0.1, rim, [], 0, Rr, zr, false, false, COL.black, false, G.rim || 0, G.size);
  bikeWheel(B, steer, "wheel-1", Rf, 0.09, rim, [1], 0, fx[1], fx[0], false, false, COL.black, false, G.rim || 0, G.size);
  finish(T, root);
  var pn = [0, Math.sin(0.4), -Math.cos(0.4)];
  return {g: root, meta: {kind: "bike", R: Rr, radii: [Rr, Rf], lean: S.lean, riderK: null, seats: 3,
                          plates: [{p: [pn[0]*0.0075, py + pn[1]*0.0075, pz + pn[2]*0.0075], ry: PI, rx: 0.4, w: 0.16, h: 0.1}]}};
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
// [3.13] a blueprint per catalogue entry and tuned geometry (rims, rim colour, size, wing, exhaust, two-tone parts): a
// stock vehicle keys as it always did, so every untuned copy still shares one
function blueprint(T, entry, G){
  G = G || GEO0;
  var st = styleOf(entry), d = dims(entry), k = scaleOf(entry), sig = geoSig(G), key = keyOf(entry, st, d, k) + (sig ? "|t:" + sig : ""), BP = store(T).bp;
  if(BP[key]) return BP[key];
  var bp = st.kind === "bike" ? (st.type === "scooter" ? buildScooter(T, entry, st, d, G) : buildBike(T, entry, st, d, G))
    : st.type === "formula" ? buildFormula(T, entry, st, d) : buildCar(T, entry, st, d, G);
  return (BP[key] = {st: st, d: d, k: k, bp: k === 1 ? bp : scaled(bp, k)});
}

/* ---------- [3.13] tuning (games/hqtuning.js, the Tuning shop) ----------
   A tune is the Arena's canonical object (backend/src/tuning.rs): {finish, color, two_tone, color2, rim, rim_color,
   rim_size, tint, wing, exhaust, plate}; colours "#rrggbb" or null, anything missing is stock. Geometry (rims and their
   colour, the size step, a wing, the exhaust, two-tone parts) picks the blueprint; the rest is per-vehicle material:
   the finish, the colours (a 2 x 1 texel map carries the second tone), the window tint, the plate (one more mesh). */
var FINISH = {gloss: [0.55, 0.3], matte: [0.12, 0.86], metallic: [0.85, 0.24], pearl: [0.45, 0.14], chrome: [0.92, 0.1]};
var TINT = [null, [0.6, 0x141c24], [0.78, 0x0b1016], [0.92, 0x040506]];
var TWO = {none: 0, roof: 1, stripe: 2, livery: 3}, WING = {none: 0, lip: 1, ducktail: 2, gt: 3};
var EXH = {stock: 0, sport: 1, quad: 2, titanium: 3, slipon: 1, underseat: 2, endcan: 3};
var GEO0 = {rim: 0, rimCol: null, size: 0, wing: 0, ex: 0, two: 0};
function hexNum(h){ return typeof h === "string" && /^#[0-9a-fA-F]{6}$/.test(h) ? parseInt(h.slice(1), 16) : null; }
function geoOf(tune, kind){
  var t = tune || {}, bike = kind === "bike", two = TWO[t.two_tone] | 0;
  if(two && hexNum(t.color2) == null) two = 0;
  return {rim: Math.max(0, Math.min(5, t.rim | 0)), rimCol: hexNum(t.rim_color), size: Math.max(-1, Math.min(2, t.rim_size | 0)),
          wing: bike ? 0 : WING[t.wing] | 0, ex: EXH[t.exhaust] | 0, two: bike && two === 1 ? 0 : two};
}
function geoSig(G){ return G.rim || G.rimCol != null || G.size || G.wing || G.ex || G.two ? [G.rim, G.rimCol == null ? "-" : G.rimCol, G.size, G.wing, G.ex, G.two].join(",") : ""; }
function plateClean(s){ s = String(s == null ? "" : s).toUpperCase().replace(/[^A-Z0-9 -]/g, "").replace(/\s+/g, " ").trim(); return s.slice(0, 8); }
// one canvas texture per plate text, shared by every vehicle wearing it (node, the tests: none, plain white)
function plateTex(T, txt){
  var st = store(T); st.plates = st.plates || {};
  if(st.plates[txt] !== undefined) return st.plates[txt];
  st.plates[txt] = null;
  if(typeof document === "undefined" || !document.createElement || !T.CanvasTexture) return null;
  try {
    var cv = document.createElement("canvas"); cv.width = 256; cv.height = 64; var g = cv.getContext("2d");
    g.fillStyle = "#eceee6"; g.fillRect(0, 0, 256, 64); g.strokeStyle = "#202226"; g.lineWidth = 5; g.strokeRect(4, 4, 248, 56);
    g.fillStyle = "#16181b"; g.textAlign = "center"; g.textBaseline = "middle";
    var px = 46; g.font = "700 " + px + "px ui-monospace, Menlo, monospace";
    while(px > 18 && g.measureText(txt).width > 228){ px -= 2; g.font = "700 " + px + "px ui-monospace, Menlo, monospace"; }
    g.fillText(txt, 128, 34);
    var t = new T.CanvasTexture(cv); if(T.SRGBColorSpace) t.colorSpace = T.SRGBColorSpace; t.anisotropy = 4;
    st.plates[txt] = t;
  } catch(e){ st.plates[txt] = null; }
  return st.plates[txt];
}
// the plates' quads (front and back, or a bike's one), in one geometry per blueprint
function plateGeo(T, bp){
  if(bp.plateGeo) return bp.plateGeo;
  var P = [], N = [], U = [];
  (bp.meta.plates || []).forEach(function(q){
    var g = new T.PlaneGeometry(q.w, q.h); g.rotateY(q.ry || 0); if(q.rx) g.rotateX(q.rx); g.translate(q.p[0], q.p[1], q.p[2]);
    var n = g.toNonIndexed(); g.dispose();
    P.push.apply(P, n.attributes.position.array); N.push.apply(N, n.attributes.normal.array); U.push.apply(U, n.attributes.uv.array); n.dispose();
  });
  var out = new T.BufferGeometry();
  out.setAttribute("position", new T.BufferAttribute(new Float32Array(P), 3)); out.setAttribute("normal", new T.BufferAttribute(new Float32Array(N), 3));
  out.setAttribute("uv", new T.BufferAttribute(new Float32Array(U), 2)); out.computeBoundingSphere();
  return (bp.plateGeo = out);
}
function setFinish(m, fin, col){
  var f = FINISH[fin] || FINISH.gloss; m.metalness = f[0]; m.roughness = f[1];
  if(m.emissive){ m.emissive.setHex(0x000000); m.emissiveIntensity = 1; }
  if(fin === "pearl" && m.emissive){ m.emissive.setHex(col); m.emissiveIntensity = 0.07; }        // a soft glow off the base coat
  if(fin === "chrome" && m.emissive){ m.emissive.setHex(0xffffff); m.emissiveIntensity = 0.06; }  // no environment map: a little lift
  m.needsUpdate = true;
}
// the materials a tune sets on a built catalogue rig: finish, colour, second tone, tint; returns nothing
function tuneMats(T, rig, t, baseHex){
  t = t || {};
  var pm = rig.paint, col = hexNum(t.color), c1 = col != null ? col : baseHex, two = rig.tuneGeo && rig.tuneGeo.two, c2 = hexNum(t.color2);
  rig.baseHex = baseHex;
  if(two && c2 != null && T.DataTexture){
    var d = rig.toneData || (rig.toneData = new Uint8Array(8)), tex = rig.toneTex;
    [c1, c2].forEach(function(c, i){ d[i*4] = (c >> 16) & 255; d[i*4 + 1] = (c >> 8) & 255; d[i*4 + 2] = c & 255; d[i*4 + 3] = 255; });
    if(!tex){
      tex = rig.toneTex = new T.DataTexture(d, 2, 1, T.RGBAFormat);
      tex.magFilter = tex.minFilter = T.NearestFilter; tex.generateMipmaps = false; if(T.SRGBColorSpace) tex.colorSpace = T.SRGBColorSpace;
    }
    tex.needsUpdate = true; pm.map = tex; pm.color.setHex(0xffffff);
  } else { pm.map = null; pm.color.setHex(c1); }
  setFinish(pm, t.finish, c1);
  if(rig.glbPaint) rig.glbPaint.forEach(function(m){ m.color.setHex(c1); setFinish(m, t.finish, c1); });
  // the window tint: the shared glass, or this vehicle's own darker copy
  var lvl = Math.max(0, Math.min(3, t.tint | 0)), M = shared(T);
  if(lvl && TINT[lvl]){
    var gm = rig.glassTint || (rig.glassTint = M.glass.clone());
    gm.opacity = TINT[lvl][0]; gm.color.setHex(TINT[lvl][1]);
    rig.meshes.forEach(function(m){ if(m.userData.mk === "glass") m.material = gm; });
  } else rig.meshes.forEach(function(m){ if(m.userData.mk === "glass") m.material = M.glass; });
  // the plate: its own text (the HQ's name stays the default where the page passes it), else the atlas plates show
  var txt = plateClean(t.plate);
  if(rig.plateMesh){
    if(txt){ var map = plateTex(T, txt); rig.plateMesh.visible = true; if(rig.plateMesh.material.map !== map){ rig.plateMesh.material.map = map; rig.plateMesh.material.needsUpdate = true; } }
    else rig.plateMesh.visible = false;
  }
  rig.tune = t;
}
// the display scale, baked into the blueprint: every node's offset and every vertex × k (rotations kept), so the
// rig's anchors, wheel radii and positions are all in shown metres and the rig's root stays at scale 1
function scaled(bp, k){
  bp.g.traverse(function(o){
    if(o !== bp.g) o.position.multiplyScalar(k);
    if(o.isMesh){ o.geometry.scale(k, k, k); o.geometry.computeBoundingSphere(); }
  });
  var m = bp.meta;
  if(m.plates) m.plates.forEach(function(q){ q.p = q.p.map(function(v){ return v*k; }); q.w *= k; q.h *= k; });
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
  var tune = opts.tune || null;
  if(isStarter(entry) && c && !c.Mesh){                 // the starters: hq3d's own car and motorbike
    var bike = styleOf(entry).kind === "bike", sr = null;
    if(bike && c.moto) sr = c.moto(paintOf(entry, paint), opts.accent, tune && plateClean(tune.plate) ? plateClean(tune.plate) : opts.plate);
    if(!bike && c.car) sr = c.car(paintOf(entry, paint), opts.accent, tune && plateClean(tune.plate) ? plateClean(tune.plate) : opts.plate);
    if(sr){ if(tune) tuneStarter(T, sr, tune, bike ? "bike" : "car"); return sr; }
  }
  var kind0 = styleOf(entry || {}).kind, G = geoOf(tune, kind0);
  var B = blueprint(T, entry || {}, G), bp = B.bp, M = shared(T);
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
  var car = bp.meta.kind === "car", on = null, lit = false;
  var rig = {
    g: g, entry: entry, dims: B.d, scale: B.k, kind: bp.meta.kind, paint: pm, standin: get("body"), meshes: meshes,
    wheels: car ? [0, 1, 2, 3].map(function(i){ return get("wheel-" + i); }) : [get("wheel-0"), get("wheel-1")],
    steer: car ? [get("steer-l"), get("steer-r")] : get("steer"), spin: car ? get("spin") : null,
    R: bp.meta.R, radii: bp.meta.radii.slice(), lean: bp.meta.lean,
    seat: get("a-seat"), grips: [get("a-grip-l"), get("a-grip-r")], feet: [get("a-foot-l"), get("a-foot-r")],
    brake: function(b){ b = !!b; if(b === on) return; on = b; tail.color.setHex(b ? 0xffffff : lit ? 0xc8c8c8 : 0x8c8c8c); },
    // [3.12] lights on (games/hqdrive.js): the tails glow brighter (the lamps share one unlit material, always bright)
    lights: function(l){ lit = !!l; if(!on) tail.color.setHex(lit ? 0xc8c8c8 : 0x8c8c8c); },
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
  // [3.13] tuned: a plate of its own (one more mesh, on the body: it hides with the stand-in), the materials
  rig.tuneGeo = G;
  if(tune){
    if(plateClean(tune.plate) && bp.meta.plates && bp.meta.plates.length && rig.standin){
      var plm = new T.Mesh(plateGeo(T, bp), new T.MeshStandardMaterial({color: 0xffffff, roughness: 0.6}));
      plm.name = "mk:plate"; plm.userData.mk = "plate"; rig.standin.add(plm); meshes.push(plm); rig.plateMesh = plm;
    }
    tuneMats(T, rig, tune, paintOf(entry, paint));
    rig.setPaint = function(hex){ rig.baseHex = hex; tuneMats(T, rig, Object.assign({}, rig.tune, {color: null}), hex); };
  }
  // the material half of a new tune, live (the Tuning shop's preview); geometry changes need a new build (sameGeo says)
  rig.setTune = function(t2){ if(!rig.tuneGeo || geoSig(geoOf(t2, rig.kind)) !== geoSig(rig.tuneGeo) || !!plateClean(t2 && t2.plate) !== !!rig.plateMesh) return false; tuneMats(T, rig, t2 || {}, rig.baseHex != null ? rig.baseHex : paintOf(entry, paint)); return true; };
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

/* [3.13] a starter's tune (hq3d's own car and motorbike: games/hq3d.js vehicle(), rig.M its materials): the finish and
   colour on its paint, the second tone on its accent stripes, the rim colour and size, the tint, a wing (a car) and
   exhaust tips, as one small extra group (two meshes: the wing in the paint, the tips in chrome). Rim designs and the
   plate's text (passed to c.car / c.moto) are the build's. */
function tuneStarter(T, rig, t, kind){
  if(!rig || !rig.g || !rig.M) return rig;
  t = t || {};
  var M = rig.M, col = hexNum(t.color), c2 = hexNum(t.color2);
  if(col != null && M.paint) M.paint.color.setHex(col);
  if(M.paint) setFinish(M.paint, t.finish, M.paint.color.getHex());
  if(t.two_tone && t.two_tone !== "none" && c2 != null && M.accent) M.accent.color.setHex(c2);
  var rc = hexNum(t.rim_color); if(rc != null && M.rim) M.rim.color.setHex(rc);
  var lvl = Math.max(0, Math.min(3, t.tint | 0));
  if(lvl && TINT[lvl]) ["glass", "tint"].forEach(function(k){ if(M[k]){ M[k].opacity = TINT[lvl][0]; M[k].color.setHex(TINT[lvl][1]); } });
  var sz = Math.max(-1, Math.min(2, t.rim_size | 0));
  if(sz) rig.g.traverse(function(o){ if(o.isMesh && o.userData.mk === "rim" && o.parent && /^wheel-/.test(o.parent.name || "")){ o.scale.y = o.scale.z = 1 + 0.04*sz; } });
  var old = rig.g.getObjectByName("tune:extras"); if(old) rig.g.remove(old);
  var bb = new T.Box3().setFromObject(rig.g), ex = new T.Group(); ex.name = "tune:extras";
  var wing = kind === "bike" ? 0 : WING[t.wing] | 0, exh = EXH[t.exhaust] | 0, pg = [], cg = [];
  function at(geo, x, y, z, rx){ if(rx) geo.rotateX(rx); geo.translate(x, y, z); return geo; }
  if(wing){
    var w = bb.max.x - bb.min.x, zb = bb.min.z, yt = bb.max.y;
    if(wing === 1) pg.push(at(new T.BoxGeometry(w*0.7, 0.03, 0.12), 0, yt - 0.02, zb + 0.32, -0.15));
    else if(wing === 2) pg.push(at(new T.BoxGeometry(w*0.72, 0.05, 0.22), 0, yt - 0.01, zb + 0.32, 0.3));
    else { pg.push(at(new T.BoxGeometry(w*0.86, 0.03, 0.3), 0, yt + 0.12, zb + 0.35, -0.12));
           [1, -1].forEach(function(sx){ pg.push(at(new T.BoxGeometry(0.03, 0.16, 0.06), sx*w*0.22, yt + 0.04, zb + 0.38)); }); }
  }
  if(exh){
    var n = exh === 1 ? 2 : 4, wd = bb.max.x - bb.min.x, r = kind === "bike" ? 0.045 : exh === 1 ? 0.06 : 0.045;
    for(var i = 0; i < (kind === "bike" ? 1 : n); i++){
      var x = kind === "bike" ? -wd*0.28 : (i < n/2 ? 1 : -1)*(wd*0.28 + (n > 2 ? (i % 2)*0.11 : 0));
      cg.push(at(new T.CylinderGeometry(r, r*0.92, kind === "bike" ? 0.36 : 0.16, 10, 1, true), x, kind === "bike" ? 0.5 : 0.3, bb.min.z + (kind === "bike" ? 0.3 : 0.04), PI/2 + (kind === "bike" ? -0.25 : 0)));
    }
  }
  function merge(list, m){
    if(!list.length) return;
    var P = [], N = [];
    list.forEach(function(g){ var n = g.index ? g.toNonIndexed() : g; P.push.apply(P, n.attributes.position.array); N.push.apply(N, n.attributes.normal.array); if(n !== g) n.dispose(); g.dispose(); });
    var out = new T.BufferGeometry(); out.setAttribute("position", new T.BufferAttribute(new Float32Array(P), 3)); out.setAttribute("normal", new T.BufferAttribute(new Float32Array(N), 3));
    var mesh = new T.Mesh(out, m); mesh.castShadow = true; ex.add(mesh);
  }
  merge(pg, M.paint || new T.MeshStandardMaterial({color: 0x333333}));
  merge(cg, exh === 3 ? new T.MeshStandardMaterial({color: COL.ti, metalness: 0.9, roughness: 0.25}) : (M.chrome || new T.MeshStandardMaterial({color: COL.chrome, metalness: 0.9, roughness: 0.2})));
  if(ex.children.length) rig.g.add(ex);
  rig.tune = t;
  return rig;
}

function triangles(rig){ var t = 0; (rig.meshes || []).forEach(function(m){ var g = m.geometry; t += (g.index ? g.index.count : g.attributes.position.count)/3; }); return Math.round(t); }
function drawCalls(rig){ return (rig.meshes || []).length; }
function clearCache(T){ var BP = store(T).bp; Object.keys(BP).forEach(function(k){ BP[k].bp.g.traverse(function(o){ if(o.isMesh) o.geometry.dispose(); }); delete BP[k]; }); }

HQV.hqVehicleModels = {build: build, dims: dims, shown: shown, scaleOf: scaleOf, SCALE: SCALE, styleOf: styleOf, triangles: triangles, drawCalls: drawCalls, clearCache: clearCache,
                       DIMS: DIMS, CAR: CAR, BIKE: BIKE,
                       // [3.13] tuning: the geometry a tune picks (sameGeo: can setTune apply it live?), a starter's tune
                       geoOf: geoOf, geoSig: geoSig, sameGeo: function(a, b, kind){ return geoSig(geoOf(a, kind)) === geoSig(geoOf(b, kind)); },
                       tuneStarter: tuneStarter, plateClean: plateClean, FINISH: FINISH};
})();
