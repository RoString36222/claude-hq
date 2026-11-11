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
  ti: 0x5d6fc8, carbon: 0x1d1f24,                             // [3.13] blue-burnt titanium, carbon fibre
  orange: 0xe0641b, inconel: 0x9a8f86                          // [3.38] the One:1's pinstripes and calipers; a heat-tinted pipe
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
  ylamp: [0, 272, 192, 96], hexbadge: [192, 272, 80, 80],
  // [4.0] surface patches: white in the colour atlas, their roughness (G) and metalness (B) in the surface atlas (PBR)
  chrome: [280, 280, 32, 32], metal: [320, 280, 32, 32], satin: [360, 280, 32, 32], rubber: [400, 280, 32, 32],
  plastic: [440, 280, 32, 32], gloss: [480, 280, 32, 32], carbon: [520, 280, 64, 64]
};
// [4.0] each patch's [roughness, metalness]; any other patch (and the background) the default trim surface
var PBR = {chrome: [0.1, 1], metal: [0.28, 0.9], satin: [0.42, 0.6], rubber: [0.92, 0], plastic: [0.62, 0.02], gloss: [0.16, 0.1], carbon: [0.3, 0.35],
           tyre: [0.92, 0], honey: [0.6, 0.2], plate: [0.5, 0], stitch: [0.85, 0], knee: [0.85, 0], white: [0.5, 0.25]};
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
  // [4.0] the surface patches: plain white (the vertex colour shows), carbon a fine twill
  ["chrome", "metal", "satin", "rubber", "plastic", "gloss"].forEach(function(k){ rect(P[k], "#ffffff"); });
  clip(P.carbon, function(X, Y, W, H){ x.fillStyle = "#ffffff"; x.fillRect(X, Y, W, H); x.fillStyle = "#8d9196";
    for(var i = 0; i < W; i += 4) for(var j = 0; j < H; j += 4) if(((i + j)/4) % 2) x.fillRect(X + i, Y + j, 4, 2); else x.fillRect(X + i, Y + j + 2, 2, 2); });
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
    // [4.0] the surface atlas: roughness in green, metalness in blue, patch by patch (MeshStandardMaterial's maps)
    var cp = document.createElement("canvas"); cp.width = AW; cp.height = AH; var x = cp.getContext("2d");
    var px = function(k){ var v = PBR[k]; return "rgb(0," + Math.round(v[0]*255) + "," + Math.round(v[1]*255) + ")"; };
    x.fillStyle = px("white"); x.fillRect(0, 0, AW, AH);
    Object.keys(PBR).forEach(function(k){ var r = ATLAS[k]; if(r){ x.fillStyle = px(k); x.fillRect(r[0], r[1], r[2], r[3]); } });
    s.pbr = new T.CanvasTexture(cp); s.pbr.anisotropy = 4;
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
  var key = this.lod ? mk + "@1" : mk;                         // [4.0] LOD 1 (far) parts bin apart
  (node.userData.parts[key] = node.userData.parts[key] || []).push(g);
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
// [3.39] a flat part (built facing +z) laid at p facing along n
Builder.prototype.face = function(node, mk, col, geo, p, n){
  var T = this.T; this.q.setFromUnitVectors(new T.Vector3(0, 0, 1), new T.Vector3(n[0], n[1], n[2]).normalize()); this.v.set(p[0], p[1], p[2]);
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
// [3.38] a loft along z through cross-sections (a canopy, a roof scoop): rings [{z, p: [[x, y], ...]}], each p the left
// half (x > 0) from the bottom up, mirrored to the right; consecutive rings joined, both ends capped
Builder.prototype.loft = function(node, mk, col, rings){
  var T = this.T, P = [], sec = rings.map(function(r){
    var L = r.p.map(function(q){ return [q[0], q[1], r.z]; }), Rr = r.p.slice().reverse().map(function(q){ return [-q[0], q[1], r.z]; });
    return L.concat(Rr);                                      // round the section: left bottom up, right top down
  }), n = sec[0].length;
  function tri(a, b, c){ P.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]); }
  for(var i = 1; i < sec.length; i++) for(var j = 0; j < n; j++){
    var a = sec[i - 1][j], b = sec[i - 1][(j + 1) % n], c = sec[i][(j + 1) % n], d = sec[i][j];
    if(rings[i].z > rings[i - 1].z){ tri(a, b, c); tri(a, c, d); } else { tri(a, c, b); tri(a, d, c); }
  }
  [0, sec.length - 1].forEach(function(e){ var S = sec[e], back = (e === 0) === (rings[rings.length - 1].z > rings[0].z);
    for(var k = 1; k < n - 1; k++){ if(back) tri(S[0], S[k + 1], S[k]); else tri(S[0], S[k], S[k + 1]); } });
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
    Object.keys(parts).forEach(function(key){
      var list = parts[key], n = 0, far = /@1$/.test(key), mk = far ? key.slice(0, -2) : key, col = !!VCOL[mk];
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
      var m = new T.Mesh(out); m.userData.mk = mk; m.userData.lod = far ? 1 : 0; m.name = (far ? "lod1:" : "mk:") + mk; if(far) m.visible = false;
      m.castShadow = mk === "paint" || mk === "trim" || mk === "wheel"; m.receiveShadow = mk !== "glass";
      if(mk === "glass") m.renderOrder = 2;
      o.add(m);
    });
  });
  return root;
}
function anchor(T, p, name, x, y, z){ var o = new T.Object3D(); o.name = name; o.position.set(x, y, z); p.add(o); return o; }

/* ---------- [4.0] modelling parts (ported from the realism prototype, games/proto/parts.js) ----------
   Pure geometry makers: metres, forward +z, up +y, model-local +x is LEFT. Each returns a fresh BufferGeometry; the
   Builder places it (add / pair) and merges it per rigid piece and material. Lofts wind (a, b, c, b, d, c) so they face
   out; a designed cross-section (not a superellipse) gives a body its shoulder and tumblehome. */
// a box whose edges and corners are rounded to r (every vertex pushed out from an inner box, the normals set round)
function rbox(T, w, h, d, r, seg){
  r = Math.max(0.0005, Math.min(r, w/2, h/2, d/2)); seg = seg || 2;
  var g = new T.BoxGeometry(w, h, d, seg*2, seg*2, seg*2), p = g.attributes.position, n = g.attributes.normal;
  var hx = w/2 - r, hy = h/2 - r, hz = d/2 - r;
  for(var i = 0; i < p.count; i++){
    var x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    var cx = Math.max(-hx, Math.min(hx, x)), cy = Math.max(-hy, Math.min(hy, y)), cz = Math.max(-hz, Math.min(hz, z));
    var dx = x - cx, dy = y - cy, dz = z - cz, l = Math.sqrt(dx*dx + dy*dy + dz*dz);
    if(l < 1e-9) continue;
    dx /= l; dy /= l; dz /= l;
    n.setXYZ(i, dx, dy, dz); p.setXYZ(i, cx + dx*r, cy + dy*r, cz + dz*r);
  }
  return g;
}
// a side silhouette ([z, y] points round the outline) extruded across to width w, centred on x 0, soft bevel
function prof(T, pts, w, bevel, cseg){
  var s = new T.Shape(); bevel = bevel == null ? 0.01 : bevel;
  pts.forEach(function(p, i){ if(i) s.lineTo(p[0], p[1]); else s.moveTo(p[0], p[1]); });
  s.closePath();
  var depth = Math.max(0.001, w - 2*bevel);
  var g = new T.ExtrudeGeometry(s, {depth: depth, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: cseg || 2, curveSegments: 6});
  g.translate(0, 0, -depth/2); g.rotateY(-PI/2); g.computeVertexNormals();
  return g;
}
// the same through a smooth closed curve (Catmull-Rom) round the points: tanks, fairings, seats, mudguards
function sprof(T, pts, w, bevel, n){
  var c = new T.CatmullRomCurve3(pts.map(function(p){ return new T.Vector3(p[0], p[1], 0); }), true, "centripetal");
  return prof(T, c.getPoints(n || 32).slice(0, -1).map(function(v){ return [v.x, v.y]; }), w, bevel);
}
// a flat outline ([x, y] points) facing +z, d deep (centred on z 0), uvs flat across its face: lamps, grilles, intakes
function flat(T, pts, d, bevel, smooth){
  var s = new T.Shape(), P = pts;
  if(smooth){ var c = new T.CatmullRomCurve3(pts.map(function(p){ return new T.Vector3(p[0], p[1], 0); }), true, "centripetal"); P = c.getPoints(smooth).slice(0, -1).map(function(v){ return [v.x, v.y]; }); }
  P.forEach(function(p, i){ if(i) s.lineTo(p[0], p[1]); else s.moveTo(p[0], p[1]); });
  s.closePath();
  var b = bevel || 0, g = new T.ExtrudeGeometry(s, {depth: Math.max(0.001, d - 2*b), bevelEnabled: b > 0, bevelThickness: b, bevelSize: b, bevelSegments: 1, curveSegments: 4});
  g.translate(0, 0, -(d - 2*b)/2);
  var p = g.attributes.position, uv = g.attributes.uv, x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9, i;
  for(i = 0; i < p.count; i++){ x0 = Math.min(x0, p.getX(i)); x1 = Math.max(x1, p.getX(i)); y0 = Math.min(y0, p.getY(i)); y1 = Math.max(y1, p.getY(i)); }
  for(i = 0; i < p.count; i++) uv.setXY(i, (p.getX(i) - x0)/Math.max(1e-4, x1 - x0), (p.getY(i) - y0)/Math.max(1e-4, y1 - y0));
  return g;
}
// a round tube through 3D points [x, y, z] (bars, frame tubes, headers, rails)
function tubeG(T, pts, r, seg, rad, closed){
  var c = new T.CatmullRomCurve3(pts.map(function(p){ return new T.Vector3(p[0], p[1], p[2]); }), !!closed, "centripetal");
  return new T.TubeGeometry(c, seg || 16, r, rad || 8, !!closed);
}
// a straight cylinder (or cone) from a to b
function rodG(T, a, b, r0, r1, rad, open){
  var A = new T.Vector3(a[0], a[1], a[2]), Bv = new T.Vector3(b[0], b[1], b[2]), len = Math.max(0.0005, A.distanceTo(Bv));
  var g = new T.CylinderGeometry(r1 == null ? r0 : r1, r0, len, rad || 8, 1, !!open);
  g.translate(0, len/2, 0);
  g.applyQuaternion(new T.Quaternion().setFromUnitVectors(new T.Vector3(0, 1, 0), Bv.clone().sub(A).normalize()));
  g.translate(A.x, A.y, A.z);
  return g;
}
// a disc / drum about the x axis (wheel parts): radius r, thickness t
function discG(T, r, t, seg, r2){ var g = new T.CylinderGeometry(r2 == null ? r : r2, r, t, seg || 24); g.rotateZ(PI/2); return g; }
function ringG(T, R, tr, seg, rad){ var g = new T.TorusGeometry(R, tr, rad || 6, seg || 32); g.rotateY(PI/2); return g; }
// a tyre: a lathe of a rounded section about x; rim radius rr, outer R, section width w; sq squares the shoulder (a car
// tyre ~0.7, a bike's round 0); grooves cut circumferential tread grooves
function tyreG(T, rr, R, w, seg, sq, grooves, k){
  var pts = [], n = k || 12, h = R - rr, i;
  sq = sq || 0;
  for(i = 0; i <= n; i++){
    var a = -PI/2 + PI*i/n, c = Math.cos(a), s = Math.sin(a);
    var sc = Math.sign(s)*Math.pow(Math.abs(s), 1 - sq*0.75), cc = Math.pow(Math.max(0, c), 1 - sq*0.6);
    var r = rr + h*(0.35 + 0.65*cc), x = (w/2)*sc;
    if(grooves && Math.abs(sc) < 0.6 && cc > 0.9){ var gi = Math.abs(Math.sin(sc*PI*grooves)); if(gi < 0.25) r -= 0.006; }
    pts.push(new T.Vector2(r, x));
  }
  pts.unshift(new T.Vector2(rr, -w*0.46)); pts.push(new T.Vector2(rr, w*0.46));
  var g = new T.LatheGeometry(pts, seg || 40);
  g.rotateZ(PI/2);
  return g;
}
// a loft through cross-section rings (each [[x, y], ...], the same count) at stations zs; closed: the ring wraps
function loftG(T, rings, zs, closed){
  var n = rings[0].length, m = rings.length, pos = [], idx = [], i, j;
  for(i = 0; i < m; i++) for(j = 0; j < n; j++) pos.push(rings[i][j][0], rings[i][j][1], zs[i]);
  var seg = closed ? n : n - 1;
  for(i = 0; i < m - 1; i++) for(j = 0; j < seg; j++){
    var a = i*n + j, b = i*n + (j + 1) % n, c = (i + 1)*n + j, d = (i + 1)*n + (j + 1) % n;
    idx.push(a, b, c, b, d, c);
  }
  var g = new T.BufferGeometry();
  g.setAttribute("position", new T.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
  return g;
}
// a grid patch through rows of 3D points (P[i][j] = [x, y, z]); flip turns it to face the other way
function gridG(T, P, flip){
  var m = P.length, n = P[0].length, pos = [], idx = [], i, j;
  for(i = 0; i < m; i++) for(j = 0; j < n; j++) pos.push(P[i][j][0], P[i][j][1], P[i][j][2]);
  for(i = 0; i < m - 1; i++) for(j = 0; j < n - 1; j++){
    var a = i*n + j, b = a + 1, c = a + n, d = c + 1;
    if(flip) idx.push(a, c, b, b, c, d); else idx.push(a, b, c, b, d, c);
  }
  var g = new T.BufferGeometry();
  g.setAttribute("position", new T.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
  var uv = new Float32Array(m*n*2);
  for(i = 0; i < m; i++) for(j = 0; j < n; j++){ uv[(i*n + j)*2] = j/Math.max(1, n - 1); uv[(i*n + j)*2 + 1] = i/Math.max(1, m - 1); }
  g.setAttribute("uv", new T.BufferAttribute(uv, 2));
  return g;
}
// close a loft's end: a fan from the ring's centre at z; dir +1 faces forward (+z), -1 back
function capG(T, ring, z, dir){
  var cx = 0, cy = 0, pos = [], idx = [], i;
  ring.forEach(function(p){ cx += p[0]; cy += p[1]; }); cx /= ring.length; cy /= ring.length;
  pos.push(cx, cy, z); ring.forEach(function(p){ pos.push(p[0], p[1], z); });
  for(i = 0; i < ring.length; i++){ var a = 1 + i, b = 1 + (i + 1) % ring.length; if(dir > 0) idx.push(0, a, b); else idx.push(0, b, a); }
  var g = new T.BufferGeometry();
  g.setAttribute("position", new T.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
  var nn = g.attributes.normal; for(i = 0; i < nn.count; i++) nn.setXYZ(i, 0, 0, dir);
  return g;
}
// a piecewise-smooth lookup through [t, value] keys (cosine-eased between them)
function curveF(keys){
  var K = keys.slice().sort(function(a, b){ return a[0] - b[0]; });
  return function(t){
    if(t <= K[0][0]) return K[0][1];
    for(var i = 1; i < K.length; i++) if(t <= K[i][0]){ var u = (t - K[i - 1][0])/Math.max(1e-6, K[i][0] - K[i - 1][0]), e = (1 - Math.cos(u*PI))/2; return K[i - 1][1] + (K[i][1] - K[i - 1][1])*e; }
    return K[K.length - 1][1];
  };
}
// mirror across x = 0 (the winding fixed so it still faces out)
function flipX(g){
  var p = g.attributes.position, n = g.attributes.normal, i;
  for(i = 0; i < p.count; i++){ p.setX(i, -p.getX(i)); if(n) n.setX(i, -n.getX(i)); }
  if(g.index){ var a = g.index.array; for(i = 0; i < a.length; i += 3){ var t = a[i + 1]; a[i + 1] = a[i + 2]; a[i + 2] = t; } g.index.needsUpdate = true; }
  else Object.keys(g.attributes).forEach(function(k){
    var at = g.attributes[k], s = at.itemSize, arr = at.array;
    for(var j = 0; j < at.count; j += 3) for(var q = 0; q < s; q++){ var tt = arr[(j + 1)*s + q]; arr[(j + 1)*s + q] = arr[(j + 2)*s + q]; arr[(j + 2)*s + q] = tt; }
  });
  return g;
}
// narrow across x toward the back: sF at z >= zF, sB at z <= zB (knee cut-outs, a tank's waist)
function taperX(g, zF, zB, sF, sB){
  var p = g.attributes.position;
  for(var i = 0; i < p.count; i++){ var t = Math.max(0, Math.min(1, (p.getZ(i) - zB)/(zF - zB))); p.setX(i, p.getX(i)*(sB + (sF - sB)*t)); }
  g.computeVertexNormals();
  return g;
}
// bulge a geometry's sides out by a smooth bump: x *= 1 + k*f(y, z) (a tank's knee bulge, a fender flare)
function bulgeX(g, f){
  var p = g.attributes.position;
  for(var i = 0; i < p.count; i++) p.setX(i, p.getX(i)*(1 + f(p.getY(i), p.getZ(i))));
  g.computeVertexNormals();
  return g;
}
function xf(T, g, x, y, z, rx, ry, rz){
  if(rx || ry || rz) g.applyMatrix4(new T.Matrix4().makeRotationFromEuler(new T.Euler(rx || 0, ry || 0, rz || 0, "YXZ")));
  if(x || y || z) g.translate(x || 0, y || 0, z || 0);
  return g;
}
// the Builder's two placing calls for the new parts: a geometry at (x, y, z) turned (YXZ), and a mirrored pair
Builder.prototype.at = function(node, mk, col, geo, x, y, z, rx, ry, rz){ return this.put(node, mk, xf(this.T, geo, x, y, z, rx, ry, rz), col); };
Builder.prototype.pair = function(node, mk, col, make, x, y, z, rx, ry, rz){
  var uvr = this.uvr, a = this.at(node, mk, col, make(), x, y, z, rx, ry, rz);
  this.uvr = uvr; this.put(node, mk, flipX(xf(this.T, make(), x, y, z, rx, ry, rz)), col);
  return a;
};
// mirror across z = 0 (a part built for the nose, laid on the tail), the winding fixed
function flipZ(g){
  var p = g.attributes.position, n = g.attributes.normal, i;
  for(i = 0; i < p.count; i++){ p.setZ(i, -p.getZ(i)); if(n) n.setZ(i, -n.getZ(i)); }
  if(g.index){ var a = g.index.array; for(i = 0; i < a.length; i += 3){ var t = a[i + 1]; a[i + 1] = a[i + 2]; a[i + 2] = t; } g.index.needsUpdate = true; }
  else Object.keys(g.attributes).forEach(function(k){
    var at = g.attributes[k], s = at.itemSize, arr = at.array;
    for(var j = 0; j < at.count; j += 3) for(var q = 0; q < s; q++){ var tt = arr[(j + 1)*s + q]; arr[(j + 1)*s + q] = arr[(j + 2)*s + q]; arr[(j + 2)*s + q] = tt; }
  });
  return g;
}
// split a loft by material: pick(i, j) -> a key (or null: left out) per quad; returns {key: geometry}
function loftSplit(T, rings, zs, closed, pick){
  var n = rings[0].length, m = rings.length, pos = [], idx = {}, i, j;
  for(i = 0; i < m; i++) for(j = 0; j < n; j++) pos.push(rings[i][j][0], rings[i][j][1], zs[i]);
  var seg = closed ? n : n - 1;
  for(i = 0; i < m - 1; i++) for(j = 0; j < seg; j++){
    var k = pick(i, j); if(!k) continue;
    var a = i*n + j, b = i*n + (j + 1) % n, c = (i + 1)*n + j, d = (i + 1)*n + (j + 1) % n;
    (idx[k] = idx[k] || []).push(a, b, c, b, d, c);
  }
  var full = new T.BufferGeometry(); full.setAttribute("position", new T.Float32BufferAttribute(pos, 3));
  var all = []; Object.keys(idx).forEach(function(k){ all = all.concat(idx[k]); });
  full.setIndex(all); full.computeVertexNormals();                 // smooth normals across the seams
  var out = {};
  Object.keys(idx).forEach(function(k){ var g = new T.BufferGeometry(); g.setAttribute("position", full.attributes.position.clone()); g.setAttribute("normal", full.attributes.normal.clone()); g.setIndex(idx[k]); out[k] = g; });
  return out;
}

/* ---------- [3.39] doors: each its own piece on a pivot, opened before you climb in and shut after ----------
   entry.door (the catalogue, researched from the real cars): hinged (a front hinge, the door swings out), scissor (a
   hinge at the front, the door turns straight up), butterfly (hinged on the A pillar: up and out), dihedral (a
   Koenigsegg's synchro-helix: the door pushes out from the body and turns up 90 degrees about the front of the sill),
   autoskin (the Regera's robotised dihedral doors: both open themselves), gullwing (hinged at the roof), none (bikes,
   an open-wheeler). A door is a node "door-l" (+x) or "door-r" (-x, the driver's: right-hand drive) at its pivot. */
var DOOR_TYPES = {hinged: 1, scissor: 1, butterfly: 1, dihedral: 1, autoskin: 1, gullwing: 1, none: 1};
function doorType(entry, st){
  var t = entry && entry.door;
  if(DOOR_TYPES[t] === 1) return t;
  if(st.kind === "bike" || st.type === "formula") return "none";
  if(st.brand === "koenigsegg") return /Regera/.test(String(entry.model || "")) ? "autoskin" : "dihedral";
  return "hinged";
}
// a door's pose at f (0 shut .. 1 open) on side sx: [dx, dy, dz, rx, ry, rz] off its pivot (rotations applied y, then x)
function doorPose(type, f, sx){
  f = Math.max(0, Math.min(1, +f || 0));
  var e = f*f*(3 - 2*f);
  if(type === "scissor") return [sx*0.03*e, 0, 0, 1.2*e, -sx*0.1*e, 0];
  if(type === "butterfly") return [sx*0.05*e, 0, 0, 0.95*e, -sx*0.5*e, -sx*0.35*e];
  if(type === "dihedral" || type === "autoskin"){                      // out first (the helix), turning up all the way
    var out = Math.min(1, e*2.4);
    return [sx*0.3*out, 0, 0.03*out, PI/2*e, -sx*0.12*Math.sin(PI*e), 0];
  }
  if(type === "gullwing") return [0, 0, 0, 0, 0, sx*1.2*e];
  if(type === "none") return [0, 0, 0, 0, 0, 0];
  return [0, 0, 0, 0, -sx*1.1*e, 0];                                  // hinged
}
// how long a door takes to open (s): a robotised one is slower and smooth, a big dihedral door a touch slower than a hinge
var DOOR_S = {hinged: 0.45, scissor: 0.6, butterfly: 0.6, dihedral: 0.7, autoskin: 0.95, gullwing: 0.6};
// a Koenigsegg's doors: each a piece of the lofted shell from the door's shut lines (zF to zR, over the sill to the
// shoulder), its side pane (the canopy's side band from the screen's foot back) and its mirror, on a pivot at the front
// of the sill; the shell under each door dark (the opening)
function aeroGeo(T, c, t, w, k, n){
  var U = [], Lo = [];
  n = n || 7;
  for(var i = 0; i <= n; i++){
    var x = i/n, th = 5*t*(0.2969*Math.sqrt(x) - 0.126*x - 0.3516*x*x + 0.2843*x*x*x - 0.1036*x*x*x*x), cm = k*c*4*x*(1 - x);
    U.push([-x*c, cm + th]); Lo.push([-x*c, cm - th]);
  }
  var s = new T.Shape(); s.moveTo(U[0][0], U[0][1]);
  for(var j = 1; j <= n; j++) s.lineTo(U[j][0], U[j][1]);
  for(var m = n - 1; m >= 1; m--) s.lineTo(Lo[m][0], Lo[m][1]);
  var g = new T.ExtrudeGeometry(s, {depth: w, bevelEnabled: false, curveSegments: 1});
  g.rotateY(-PI/2); g.translate(w/2, 0, 0);
  return g;
}
function tyreR(t){ return (t[2]*0.0254 + 2*t[0]*t[1]/100000)/2; }
/* ---------- [4.0] cars: one lofted body generator, each catalogue car its own parameters ----------
   The body is the realism prototype's (games/proto/car.js): a loft of a designed cross-section (a rocker, a convex door,
   the shoulder line, the tumblehome to a crowned top) along curves for the top line, the sill and the plan width, the
   wheel arches carved out of the flanks, both ends rounded and capped; the greenhouse a second loft (glass) with its
   roof, pillars and window trim laid over it; lamps, grilles and intakes seated flush on the real skin (skinZ). Each
   family (hatch, saloon, coupe, SUV, a mid-engined supercar, a hypercar) sets the proportions, each model its own cues
   from photos and spec sheets: tyre sizes, overhangs, the BMW kidneys (tall, wide, frameless, XL, lit), the
   Lamborghini Y and hexagon lamps and intakes, the Bugatti horseshoe, C-line and quad LEDs, the Koenigsegg's fender-tip
   lamps, side scoop and wing or fins. No logos, badges or marks. LOD 1 (far) is the same body from far fewer stations. */
// tyres [width mm, aspect %, rim in]: front, rear (researched spec sheets)
var TYRES = {
  "bmw-m135-xdrive": [[235, 35, 19], [235, 35, 19]], "bmw-330li": [[225, 45, 18], [225, 45, 18]],
  "bmw-m3-competition": [[275, 35, 19], [285, 30, 20]], "bmw-m340i": [[225, 40, 19], [255, 35, 19]],
  "bmw-m5": [[285, 40, 20], [295, 35, 21]], "bmw-i4-m50": [[245, 40, 19], [255, 40, 19]], "bmw-i7-m70": [[255, 40, 21], [285, 35, 21]],
  "bmw-m2": [[275, 35, 19], [285, 30, 20]], "bmw-m4-csl": [[275, 35, 19], [285, 30, 20]],
  "bmw-x5-40i": [[275, 40, 21], [275, 40, 21]], "bmw-x3-m50": [[255, 45, 20], [285, 40, 20]],
  "bmw-x5-m-competition": [[295, 35, 21], [315, 30, 22]], "bmw-xm": [[275, 35, 23], [315, 30, 23]],
  "bugatti-chiron-super-sport": [[285, 30, 20], [355, 25, 21]], "bugatti-tourbillon": [[285, 35, 20], [345, 30, 21]],
  "bugatti-veyron": [[265, 35, 20], [365, 30, 21]],
  "koenigsegg-jesko-absolut": [[265, 35, 20], [325, 30, 21]], "koenigsegg-agera-rs": [[265, 35, 19], [345, 30, 20]],
  "koenigsegg-one-1": [[265, 35, 19], [345, 30, 20]], "koenigsegg-regera": [[255, 35, 19], [335, 30, 20]],
  "lamborghini-temerario": [[265, 35, 20], [325, 30, 21]], "lamborghini-countach-lp400": [[205, 70, 14], [215, 70, 14]],
  "lamborghini-revuelto": [[265, 35, 20], [345, 30, 21]], "lamborghini-huracan-sto": [[245, 30, 20], [305, 30, 20]],
  "lamborghini-urus-performante": [[285, 40, 22], [325, 35, 22]]
};
// the families: heights as shares of the height (the nose's top, the bonnet at the front axle, the belt at the
// windscreen's foot, the deck at the rear glass's foot, the tail's top), the cabin in metres (cowl: the screen's foot
// behind the front axle; ws its run back; roofEnd / glassEnd from the rear axle, + ahead), the glasshouse's width at its
// foot and at the roof (shares of the half width), the plan (nose, waist, tail shares), front overhang share, clearance
var FAM = {
  hatch: {sec: "saloon", h: [0.5, 0.6, 0.64, 0.68, 0.66], cab: [0.5, 0.86, -0.06, -0.62], gw: 0.8, tw: 0.64, plan: [0.86, 0.985, 0.9], fo: 0.52, gc: 0.13, seat: 0.3},
  sedan: {sec: "saloon", h: [0.53, 0.61, 0.66, 0.72, 0.69], cab: [0.57, 0.93, 0.43, -0.23], gw: 0.82, tw: 0.62, plan: [0.88, 0.985, 0.9], fo: 0.44, gc: 0.13, seat: 0.27},
  coupe: {sec: "saloon", h: [0.52, 0.61, 0.66, 0.72, 0.7], cab: [0.6, 1.0, 0.3, -0.36], gw: 0.82, tw: 0.6, plan: [0.88, 0.985, 0.9], fo: 0.45, gc: 0.12, seat: 0.24},
  ev:    {sec: "saloon", h: [0.52, 0.6, 0.65, 0.71, 0.69], cab: [0.6, 0.95, 0.3, -0.45], gw: 0.82, tw: 0.6, plan: [0.88, 0.985, 0.9], fo: 0.45, gc: 0.13, seat: 0.27},
  suv:   {sec: "suv", h: [0.53, 0.6, 0.64, 0.66, 0.62], cab: [0.42, 0.82, -0.72, -0.92], gw: 0.85, tw: 0.74, plan: [0.9, 0.99, 0.92], fo: 0.46, gc: 0.2, seat: 0.4},
  super: {sec: "super", h: [0.33, 0.62, 0.64, 0.74, 0.7], cab: [0.16, 1.05, 0.9, -0.62], gw: 0.72, tw: 0.44, plan: [0.8, 0.9, 0.9], fo: 0.48, gc: 0.1, seat: 0.18, hood: 0.07},
  hyper: {sec: "super", h: [0.37, 0.62, 0.65, 0.76, 0.73], cab: [0.28, 0.9, 0.72, -0.35], gw: 0.74, tw: 0.48, plan: [0.82, 0.92, 0.9], fo: 0.47, gc: 0.1, seat: 0.2, hood: 0.05}
};
// the designed cross-sections ([u, v]: u x / half width, v 0 sill .. 1 top), left side from the sill up to the centre
var SECS = {
  saloon: [[0.95, 0.06], [0.985, 0.18], [1.0, 0.42], [0.99, 0.6], [0.978, 0.7], [0.955, 0.735], [0.9, 0.8], [0.8, 0.9], [0.64, 0.975], [0.32, 1.0], [0.0, 1.006]],
  suv: [[0.95, 0.05], [0.99, 0.2], [1.0, 0.45], [0.995, 0.62], [0.985, 0.73], [0.96, 0.77], [0.9, 0.84], [0.8, 0.92], [0.6, 0.98], [0.3, 1.0], [0.0, 1.004]],
  super: [[0.92, 0.06], [0.975, 0.2], [1.0, 0.36], [0.985, 0.52], [0.95, 0.64], [0.88, 0.76], [0.76, 0.87], [0.58, 0.95], [0.3, 0.99], [0.0, 1.0]]
};
// each model's cues (an unknown model gets its family's defaults). grille: a BMW kidney style; lamp / tail: the
// lamp graphics; rim: the wheel design; extras as flags. dh / dcab: offsets on the family's heights and cabin.
function carSpec(entry, st, d){
  var id = String((entry && entry.id) || ""), m = String((entry && entry.model) || ""), b = st.brand;
  var F = FAM[st.type === "formula" ? "sedan" : st.type] || FAM.sedan, ty = st.type;
  if(ty === "ev" && /i4/.test(m)) F = FAM.ev;
  var P = {fam: ty, sec: F.sec, h: F.h.slice(), cab: F.cab.slice(), gw: F.gw, tw: F.tw, plan: F.plan.slice(), fo: F.fo, gc: F.gc, seat: F.seat,
           hood: F.hood || 0, brand: b, id: id, grille: null, lamp: "slim", tail: "bar", rim: "multi", spokes: 10, rimCol: COL.alu,
           cal: COL.grey, ex: "twin", roof: null, wing: 0, gill: false, dome: false, skirt: false, intake: false, cline: false,
           diff: false, rails: false, hatch: ty === "hatch" || ty === "suv", mid: ty === "super" || ty === "hyper"};
  var tz = TYRES[id];
  if(!tz){ var R0 = {hatch: 18, sedan: 18, coupe: 19, ev: 19, suv: 20, super: 20, hyper: 20}[ty] || 18; tz = [[d.widthM > 1.95 ? 275 : 235, 40, R0], [d.widthM > 1.95 ? 305 : 245, 40, R0]]; }
  P.tf = tz[0]; P.tr = tz[1];
  if(b === "bmw"){
    var M = /^M\d|^M\b|Competition|CSL|M50|M70|M340|M135/.test(m);
    P.grille = "wide"; P.lamp = "bmw"; P.tail = "bmwL"; P.rim = M ? "twin" : "multi"; P.spokes = M ? 5 : 10; P.rimCol = M ? COL.grey : COL.alu;
    P.cal = M ? COL.bmwBlue : COL.grey; P.ex = M ? "quad" : "twin"; P.diff = M;
    if(/^M[34]\b/.test(m)){ P.grille = "tall"; P.dome = true; P.gill = true; P.roof = COL.carbon; P.wing = 1; }
    if(/CSL/.test(m)){ P.wing = 2; P.rimCol = COL.gold; P.rim = "y"; P.spokes = 5; P.cal = COL.red; P.tail = "laser"; P.cab[3] -= 0.12; }
    if(/^M2\b/.test(m)){ P.grille = "frameless"; P.dome = true; P.rim = "y"; P.spokes = 6; P.roof = COL.carbon; P.cab[2] -= 0.08; }
    if(/^M5\b/.test(m)){ P.grille = "wideLit"; P.dome = true; P.gill = true; P.rim = "multi"; P.spokes = 10; P.rimCol = COL.dark; }
    if(/^M135/.test(m)){ P.grille = "wide"; P.rim = "y"; P.spokes = 5; P.wing = 1; }
    if(/^330/.test(m)){ P.rim = "multi"; P.spokes = 10; }
    if(/^i4\b/.test(m)){ P.grille = "closed"; P.ex = null; P.rim = "aero"; P.spokes = 5; }
    if(/^i7\b/.test(m)){ P.grille = "xlLit"; P.lamp = "split"; P.tail = "thin"; P.ex = null; P.rim = "aero"; P.spokes = 10; P.cab[2] += 0.18; }
    if(/^XM\b/.test(m)){ P.grille = "xm"; P.lamp = "split"; P.tail = "thin"; P.rim = "multi"; P.spokes = 10; P.rimCol = COL.dark; P.rails = false; P.ex = "quadV"; }
    if(/^X5\b/.test(m)){ P.grille = "xl"; P.lamp = "bmw"; P.rails = true; }
    if(/^X5 M/.test(m)){ P.gill = true; P.dome = true; P.rails = false; P.rimCol = COL.grey; }
    if(/^X3\b/.test(m)){ P.grille = "diag"; P.rails = true; P.rim = "y"; P.spokes = 5; }
  }
  if(b === "lamborghini"){
    P.lamp = "lamboY"; P.tail = "lamboY"; P.rim = "lambo"; P.spokes = 5; P.rimCol = COL.dark; P.cal = COL.gold; P.ex = "hex"; P.intake = true; P.diff = true;
    if(/Temerario/.test(m)){ P.lamp = "lamboHex"; P.tail = "lamboHex"; P.ex = "centreBig"; }
    if(/Revuelto/.test(m)){ P.ex = "centreHigh"; P.wing = 0; P.rim = "lambo"; }
    if(/STO/.test(m)){ P.wing = 4; P.ex = "twinHigh"; P.fin = true; P.scoop = true; P.rimCol = COL.alu; P.rim = "centre"; P.spokes = 10; }
    if(/Countach/.test(m)){ P.lamp = "popup"; P.tail = "lp400"; P.rim = "telephone"; P.spokes = 5; P.rimCol = COL.alu; P.cal = COL.dark; P.ex = "quad"; P.intake = false; P.diff = false; P.naca = true; P.periscope = true; P.h = [0.4, 0.55, 0.64, 0.8, 0.78]; P.cab = [0.05, 1.05, 0.95, -0.58]; P.hood = 0; P.tw = 0.5; P.plan = [0.86, 0.94, 0.92]; P.sharp = true; }
    if(/Urus/.test(m)){ P.lamp = "lamboY"; P.tail = "lamboY"; P.rim = "lambo"; P.spokes = 10; P.grilleL = "hex"; P.ex = "quad"; P.cal = COL.gold; P.intake = false; P.rails = false; P.h[0] = 0.5; P.cab = [0.36, 0.9, -0.55, -0.88]; P.tw = 0.66; }
    else P.sharp = true;
  }
  if(b === "bugatti"){
    P.grilleL = "horseshoe"; P.lamp = "quad"; P.tail = "bugBar"; P.rim = "bug"; P.spokes = 7; P.rimCol = COL.alu; P.cal = COL.alu; P.cline = true; P.ex = "bug"; P.diff = true; P.wing = 5;
    if(/Tourbillon/.test(m)){ P.lamp = "vert"; P.tail = "bugX"; P.spokes = 10; P.rim = "turbine"; }
    if(/Veyron/.test(m)){ P.lamp = "oval"; P.tail = "veyron"; P.rim = "twin"; P.spokes = 5; P.ex = "centre"; P.cline = true; P.h = [0.42, 0.57, 0.63, 0.74, 0.72]; P.tw = 0.52; P.wing = 5; }
  }
  if(b === "koenigsegg"){
    P.koen = /Jesko/.test(m) ? "jesko" : /Regera/.test(m) ? "regera" : /One/.test(m) ? "one" : "agera";
    P.lamp = "koen"; P.tail = P.koen === "agera" || P.koen === "one" ? "round" : "koenBar"; P.rim = "mesh"; P.spokes = {jesko: 10, agera: 7, one: 8, regera: 9}[P.koen];
    P.rimCol = P.koen === "agera" || P.koen === "one" ? COL.carbon : COL.alu; P.cal = P.koen === "one" ? COL.orange : COL.red; P.intake = true; P.scoopK = true;
    P.ex = P.koen === "jesko" ? "oval" : P.koen === "regera" ? "ovalChrome" : "centre"; P.diff = true; P.hood = 0.035;
    P.wing = P.koen === "agera" ? 6 : P.koen === "one" ? 7 : 0; P.fins = P.koen === "jesko"; P.periscope = P.koen === "one";
    P.fo = {jesko: 0.44, agera: 0.53, one: 0.514, regera: 0.5}[P.koen];
    P.cab = {jesko: [0.3, 0.86, 0.6, -0.92], agera: [0.34, 0.8, 0.55, -0.2], one: [0.34, 0.8, 0.55, -0.24], regera: [0.34, 0.84, 0.55, -0.4]}[P.koen];
    P.h = {jesko: [0.33, 0.6, 0.63, 0.76, 0.72], agera: [0.4, 0.62, 0.65, 0.8, 0.78], one: [0.4, 0.62, 0.65, 0.8, 0.78], regera: [0.43, 0.63, 0.66, 0.78, 0.76]}[P.koen];
    P.tw = 0.5; P.gw = 0.76; P.plan = [P.koen === "jesko" ? 0.7 : 0.82, 0.9, P.koen === "jesko" ? 0.8 : 0.92];
  }
  if(P.mid && !P.grille && !P.grilleL && b !== "lamborghini" && b !== "koenigsegg") P.grilleL = "mouth";
  return P;
}

// the body's shape: curves along z, the cross-section, the surface (z, s, side) and the skin search; P from carSpec
function carShape(T, P, d){
  var L = d.lengthM, W = d.widthM, H = d.heightM, WB = d.wheelbaseM, hw = W/2;
  var Rf = tyreR(P.tf), Rr = tyreR(P.tr), zN = L/2, zT = -L/2, zf = zN - P.fo*(L - WB), zr = zf - WB, gc = P.gc;
  var hh = P.h.map(function(k){ return k*H; });
  hh[1] = Math.max(hh[1], 2*Rf + 0.1); hh[3] = Math.max(hh[3], P.mid ? 2*Rr + 0.12 : hh[3]);   // over the wheels (the arches carve below)
  var zA = zf - P.cab[0], zAr = zA - P.cab[1], zCr = zr + P.cab[2], zC = Math.max(zT + 0.12, zr + P.cab[3]);
  if(zCr > zAr - 0.25) zCr = zAr - 0.25;
  if(zC > zCr - 0.1) zC = zCr - 0.1;
  var top = curveF([[zT, hh[4] - 0.07*H], [zT + 0.07, hh[4]], [zT + 0.22, Math.max(hh[4], hh[3] - 0.01)], [zC, hh[3]], [zA, hh[2]],
                    [zf, hh[1]]].concat(P.mid ? [[zN - 0.4, hh[0] + 0.14*H], [zN - 0.12, hh[0] + 0.04*H]] : [[zN - 0.14, hh[0] + 0.035*H]]).concat([[zN, hh[0]]]));
  var bot = curveF([[zT, gc + 0.16], [zT + 0.16, gc + 0.07], [zr - Rr - 0.1, gc + 0.03], [zr + Rr + 0.1, gc], [zf - Rf - 0.1, gc],
                    [zf + Rf + 0.1, gc + 0.03], [zN - 0.1, gc + 0.06], [zN, gc + 0.12]]);
  var pl = P.plan, mid = P.mid;
  var half = curveF([[zT, (pl[2] - 0.08)*hw], [zT + 0.2, (0.96 + pl[2])/2*hw], [zT + 0.45, 0.975*hw], [zr, hw], [zr + Rr + 0.25, (mid ? pl[1] + 0.04 : 0.99)*hw], [(zf + zr)/2, (mid ? pl[1] : 0.985)*hw],
                     [zf - Rf - 0.1, (mid ? 0.97 : 0.99)*hw], [zf, hw], [zN - 0.45, 0.965*hw], [zN - 0.2, (0.9 + pl[0])/2*hw], [zN, (pl[0] - 0.1)*hw]]);
  var arF = Rf + 0.035, arR = Rr + 0.04, acF = Rf + 0.012, acR = Rr + 0.012;
  var archY = function(z){
    var y = -9, dz = Math.abs(z - zf); if(dz < arF) y = acF + Math.sqrt(arF*arF - dz*dz);
    dz = Math.abs(z - zr); if(dz < arR) y = Math.max(y, acR + Math.sqrt(arR*arR - dz*dz));
    return y;
  };
  var flare = function(z){ var f = Math.max(0, 1 - Math.abs(z - zf)/(arF + 0.25)), r = Math.max(0, 1 - Math.abs(z - zr)/(arR + 0.3)); return Math.max(f*f, r*r*(mid ? 1.4 : 1)); };
  var SEC = SECS[P.sec] || SECS.saloon, capF = mid ? 0.09 : 0.06, capR = 0.07;
  // the section as a polyline sampled by arc length, both halves (left from the sill over the top to the right sill)
  var secPts = function(n){
    var c = new T.CatmullRomCurve3(SEC.concat(SEC.slice(0, -1).reverse().map(function(q){ return [-q[0], q[1]]; })).map(function(q){ return new T.Vector3(q[0], q[1], 0); }), false, "centripetal", 0.5);
    return c.getSpacedPoints(n).map(function(q){ return [q.x, q.y]; });
  };
  var uOfV = function(v){                                 // the section's u at height v (its side, below the crown)
    if(v <= SEC[0][1]) return SEC[0][0];
    for(var q = 1; q < SEC.length; q++) if(v <= SEC[q][1]){ var a = SEC[q - 1], b = SEC[q]; return a[0] + (b[0] - a[0])*(v - a[1])/(b[1] - a[1]); }
    return 0;
  };
  var dome = function(z, u){                              // a power dome (BMW M), or the valley between a supercar's fenders
    var k = 0;
    if(P.dome && z > zf - 0.2 && z < zA + 0.1){ var t = Math.sin(Math.min(1, Math.max(0, (z - zf + 0.2)/(zA - zf + 0.3)))*PI); k += 0.018*t*Math.exp(-u*u/0.04); }
    if(P.hood && z > zA - 0.05){ var t2 = Math.min(1, (z - zA + 0.05)/0.4)*Math.min(1, (zN - z)/0.3); k -= P.hood*t2*Math.exp(-u*u/0.25); }
    return k;
  };
  var station = function(z){
    var w = half(z), yt = top(z), yb = bot(z), past = Math.max(z - (zN - capF), (zT + capR) - z, 0), cl = z > 0 ? capF : capR;
    var k = past > 0 ? Math.sqrt(Math.max(0.02, 1 - (past/cl)*(past/cl))) : 1, h = (yt - yb)*(0.45 + 0.55*k);
    w *= 0.4 + 0.6*k;
    return {w: w, yb: yb + (yt - yb - h)*0.5, h: h, ay: archY(z), fl: flare(z)};
  };
  var surf = function(z, u, v){
    var S = station(z), y = S.yb + v*S.h + (v > 0.9 ? dome(z, u) : 0);
    if(y < S.ay) y = S.ay;
    var fx = 1 + 0.025*S.fl*Math.max(0, 1 - Math.abs(v - 0.55)/0.4);
    return [u*S.w*fx, y, z];
  };
  // the skin's z at (x, y) at the front (end +1) or the back (-1): walk in from the end until the section holds the point
  var skinZ = function(x, y, end){
    var lo = end > 0 ? zN - 0.9 : zT + 0.9, hi = end > 0 ? zN + 0.01 : zT - 0.01;
    for(var it = 0; it < 26; it++){
      var mz = (lo + hi)/2, S = station(mz), v = (y - S.yb)/S.h;
      if(v >= 0 && v <= 1.0 && Math.abs(x) <= uOfV(v)*S.w) lo = mz; else hi = mz;
    }
    return lo;
  };
  // a part laid onto an end's skin (end +1 the nose, -1 the tail): built facing +z round (0, 0) with x across (+x the
  // car's left, at either end), each vertex projected along z onto the skin at (cx + x, cy + y) and lifted out by
  // its own depth plus out, so a lamp, grille or intake hugs the curved nose or tail
  var onEnd = function(geo, cx, cy, end, out){
    var p = geo.attributes.position, lim = end > 0 ? zN - 0.75 : zT + 0.75;
    if(end < 0) flipZ(geo);
    for(var i = 0; i < p.count; i++){
      var x = cx + p.getX(i), y = cy + p.getY(i), z = skinZ(x, y, end);
      z = end > 0 ? Math.max(z, lim) : Math.min(z, lim);
      p.setXYZ(i, x, y, z + p.getZ(i) + end*(out || 0));
    }
    return geo;
  };
  // a point on the side skin (z, v) on side sx, lifted out by off along its normal: {p, n}
  var side = function(z, v, sx, off){
    var u = uOfV(v), a = surf(z, u, v), bz = surf(z + 0.01, u, v), bv = surf(z, uOfV(v + 0.01), v + 0.01);
    var t1 = [bz[0] - a[0], bz[1] - a[1], bz[2] - a[2]], t2 = [bv[0] - a[0], bv[1] - a[1], bv[2] - a[2]];
    var n = [t1[1]*t2[2] - t1[2]*t2[1], t1[2]*t2[0] - t1[0]*t2[2], t1[0]*t2[1] - t1[1]*t2[0]], l = Math.hypot(n[0], n[1], n[2]) || 1;
    if(n[0] < 0) l = -l;
    n = [n[0]/l, n[1]/l, n[2]/l]; off = off || 0;
    return {p: [sx*(a[0] + n[0]*off), a[1] + n[1]*off, a[2] + n[2]*off], n: [sx*n[0], n[1], n[2]]};
  };
  // the top skin at (z, x): its height (the bonnet, the deck)
  var topY = function(z, x){ var S = station(z), u = Math.min(1, Math.abs(x)/Math.max(0.01, S.w)), v = 1; for(var q = SEC.length - 1; q > 0; q--) if(SEC[q][0] >= u){ var a = SEC[q], b = SEC[q + 1] || SEC[q]; v = b[0] === a[0] ? a[1] : a[1] + (b[1] - a[1])*(u - a[0])/(b[0] - a[0]); break; } return surf(z, u, v)[1]; };
  // the greenhouse: the roof line, its section from the belt (a 0) round to the other belt (a PI)
  var rk = mid ? [[zC, top(zC) - 0.005], [zCr, H*0.86], [(zCr + zAr)/2 - 0.1, H], [zAr, H*0.975], [zA, top(zA) - 0.005]]
               : [[zC, top(zC) - 0.005], [zCr, H*0.975], [(zCr + zAr)/2, H], [zAr, H*0.975], [zA, top(zA) - 0.005]];
  if(P.hatch && !mid) rk = [[zC, top(zC) - 0.005], [zC + 0.1, H*0.93], [zCr, H*0.99], [(zCr + zAr)/2, H], [zAr, H*0.975], [zA, top(zA) - 0.005]];
  var roof = curveF(rk);
  var gh = function(z, a, grow){
    var yb = top(z) - 0.02, yt = Math.max(yb + 0.001, roof(z)), wb = half(z)*P.gw, wt = half(z)*P.tw;
    var c = Math.cos(a), s = Math.sin(a), e = Math.pow(Math.abs(s), 0.5), sc = Math.sign(c)*Math.pow(Math.abs(c), 0.5);
    var y = yb + (yt - yb)*e, x = sc*(wb + (wt - wb)*e);
    return [x*(1 + (grow || 0)), y + (grow || 0)*0.6];
  };
  return {L: L, W: W, H: H, WB: WB, hw: hw, Rf: Rf, Rr: Rr, zN: zN, zT: zT, zf: zf, zr: zr, gc: gc, zA: zA, zAr: zAr, zCr: zCr, zC: zC,
          top: top, bot: bot, half: half, roof: roof, station: station, surf: surf, secPts: secPts, uOfV: uOfV, skinZ: skinZ,
          onEnd: onEnd, side: side, topY: topY, gh: gh, arF: arF, arR: arR, acF: acF, acR: acR, capF: capF, capR: capR};
}

// a patch on the side skin over z0..z1 (z0 the front) and v0..v1, lifted out by off; both sides unless sx given
function sidePatch(B, node, mk, col, S, z0, z1, v0, v1, nz, nv, off, sx, rel){
  var uvr = B.uvr;
  [1, -1].forEach(function(s){
    if(sx && s !== sx) return;
    var rows = [];
    for(var i = 0; i <= nz; i++){ var z = z0 + (z1 - z0)*i/nz, r = []; for(var j = 0; j <= nv; j++){ var q = S.side(z, v0 + (v1 - v0)*j/nv, s, off).p; r.push(rel ? [q[0] - rel[0], q[1] - rel[1], q[2] - rel[2]] : q); } rows.push(r); }
    B.uvr = uvr; B.put(node, mk, gridOut(B.T, rows, [s, 0, 0]), col);
  });
}
// a strip along the side skin through a path of [z, v] points, w wide: a shut line, a chrome line, the C-line
function sideLine(B, node, mk, col, S, path, w, off, sx, rel){
  var uvr = B.uvr;
  [1, -1].forEach(function(s){
    if(sx && s !== sx) return;
    var rows = [[], []];
    path.forEach(function(q, i){
      var nx = path[Math.min(path.length - 1, i + 1)], pv = path[Math.max(0, i - 1)], h = S.station(q[0]).h;
      var dz = nx[0] - pv[0], dy = (nx[1] - pv[1])*h, l = Math.hypot(dz, dy) || 1, oz = -dy/l*w/2, oy = dz/l*w/2;
      var a = S.side(q[0] + oz, q[1] + oy/h, s, off).p, b = S.side(q[0] - oz, q[1] - oy/h, s, off).p;
      if(rel){ a = [a[0] - rel[0], a[1] - rel[1], a[2] - rel[2]]; b = [b[0] - rel[0], b[1] - rel[1], b[2] - rel[2]]; }
      rows[0].push(a); rows[1].push(b);
    });
    B.uvr = uvr; B.put(node, mk, gridOut(B.T, rows, [s, 0, 0]), col);
  });
}
// a grid through rows of points, wound to face along want ([x, y, z])
function gridOut(T, rows, want){
  var a = rows[0][0], b = rows[0][1] || rows[0][0], c = rows[1][0];
  var u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  var n = [u[1]*v[2] - u[2]*v[1], u[2]*v[0] - u[0]*v[2], u[0]*v[1] - u[1]*v[0]];
  return gridG(T, rows, n[0]*want[0] + n[1]*want[1] + n[2]*want[2] < 0);
}
// a car's wheel (in its node, spun about x): the tyre (a lathe, square shoulders, tread grooves), the rim's barrel,
// lip and spokes by design, the centre and nuts, the disc behind; LOD 1 a drum and two faces
function carWheel2(B, holder, name, R, tw, sx, P, G, lod){
  var T = B.T, w = holder.getObjectByName ? (holder.getObjectByName(name) || B.node(holder, name)) : B.node(holder, name);
  if(!w.userData.parts) w.userData.parts = {};
  var rim = P.rimIn*0.0254/2 + 0.012*(G.size | 0), rr = Math.min(R - 0.05, rim), rimCol = G.rimCol != null ? G.rimCol : P.rimCol;
  var design = G.rim ? ["", "twin", "multi", "y", "mesh", "aero"][G.rim] : P.rim, n = G.rim ? [0, 5, 10, 5, 12, 6][G.rim] : P.spokes;
  if(lod){
    B.t("rubber").at(w, "wheel", COL.tyre, new T.CylinderGeometry(R, R, tw, 16, 1, false), 0, 0, 0, 0, 0, PI/2);
    var f = new T.CircleGeometry(rr*0.98, 12); f.rotateY(sx*PI/2); B.t("satin").at(w, "wheel", rimCol, f, sx*(tw/2 + 0.002), 0, 0);
    return w;
  }
  B.t("rubber").at(w, "wheel", COL.tyre, tyreG(T, rr - 0.004, R, tw, 36, 0.75, 2, 12), 0, 0, 0);
  var ox = sx*(tw/2 - 0.03);                                                     // the rim's face plane
  B.t("satin").at(w, "wheel", COL.dark, new T.CylinderGeometry(rr - 0.006, rr - 0.006, tw*0.86, 36, 1, true), 0, 0, 0, 0, 0, PI/2);   // the barrel
  B.t("metal").at(w, "wheel", rimCol, ringG(T, rr - 0.008, 0.012, 40, 6), ox + sx*0.008, 0, 0);                                     // the lip
  var spoke = function(a, r0, r1, wd, th, dish, tw2){
    var g = rbox(T, th, r1 - r0, wd, Math.min(wd, th)*0.45, 1), p = g.attributes.position;
    for(var i = 0; i < p.count; i++){ var t = (p.getY(i) + (r1 - r0)/2)/(r1 - r0); p.setZ(i, p.getZ(i)*(1 - (1 - (tw2 || 0.7))*t)); p.setX(i, p.getX(i) + sx*dish*(t - 1)); }
    g.translate(0, (r0 + r1)/2, 0); g.computeVertexNormals(); g.rotateX(a);
    return g;
  };
  var r0 = 0.07, r1 = rr - 0.012, dish = design === "aero" ? 0.005 : 0.035;
  for(var k = 0; k < n; k++){
    var a = k/n*PI*2;
    if(design === "twin"){ [-1, 1].forEach(function(s2){ B.t("metal").at(w, "wheel", rimCol, spoke(a + s2*0.11, r0, r1, 0.026, 0.024, dish, 0.8), ox, 0, 0); }); }
    else if(design === "y"){ B.t("metal").at(w, "wheel", rimCol, spoke(a, r0, (r0 + r1)*0.55, 0.05, 0.03, dish*0.5, 0.8), ox, 0, 0);
      [-1, 1].forEach(function(s2){ var g = spoke(0, (r0 + r1)*0.5, r1, 0.03, 0.026, dish*0.5, 0.8); g.rotateX(a + s2*0.16); B.t("metal").at(w, "wheel", rimCol, g, ox, 0, 0); }); }
    else if(design === "aero"){ B.t("metal").at(w, "wheel", rimCol, spoke(a, r0, r1, 0.12, 0.02, dish, 0.9), ox, 0, 0); }
    else if(design === "lambo"){ var g2 = spoke(a, r0, r1, 0.07, 0.03, dish, 0.5); B.t("metal").at(w, "wheel", rimCol, g2, ox, 0, 0); B.t("gloss").at(w, "wheel", COL.black, spoke(a + PI/n, r0 + 0.04, r1 - 0.03, 0.02, 0.018, dish, 1), ox - sx*0.004, 0, 0); }
    else if(design === "telephone"){ if(k === 0){ B.t("metal").at(w, "wheel", rimCol, discG(T, r1, 0.02, 40), ox - sx*0.01, 0, 0); } B.t("gloss").at(w, "wheel", COL.black, rbox(T, 0.02, 0.06, 0.035, 0.012, 1), ox + sx*0.002, Math.cos(a)*(rr*0.62), Math.sin(a)*(rr*0.62)); }
    else if(design === "turbine"){ var g3 = spoke(a, r0, r1, 0.04, 0.016, dish, 1.4); g3.rotateX(0.25); B.t("metal").at(w, "wheel", rimCol, g3, ox, 0, 0); }
    else B.t("metal").at(w, "wheel", rimCol, spoke(a, r0, r1, design === "mesh" || design === "bug" ? 0.024 : 0.034, 0.026, dish, design === "bug" ? 1.3 : 0.75), ox, 0, 0);
  }
  if(design === "mesh" || design === "centre"){ B.t("metal").at(w, "wheel", rimCol, ringG(T, rr*0.55, 0.01, 30, 4), ox - sx*0.016, 0, 0); }
  B.t("metal").at(w, "wheel", rimCol, discG(T, 0.075, 0.03, 20), ox - sx*0.02, 0, 0);                                               // the hub
  if(design === "centre" || design === "bug" || design === "mesh") B.t("chrome").at(w, "wheel", COL.chrome, discG(T, 0.035, 0.05, 6), ox, 0, 0);   // a centre lock
  else { B.t("gloss").at(w, "wheel", COL.black, discG(T, 0.032, 0.02, 16), ox + sx*0.002, 0, 0);
    for(var j = 0; j < 5; j++){ var aj = j/5*PI*2; B.t("chrome").at(w, "wheel", COL.chrome, discG(T, 0.009, 0.02, 6), ox - sx*0.002, Math.cos(aj)*0.05, Math.sin(aj)*0.05); } }
  B.t("metal").at(w, "wheel", COL.steel, discG(T, rr*0.8, 0.026, 40), sx*(-0.005), 0, 0);                                         // the disc
  B.t("satin").at(w, "wheel", COL.dark, discG(T, rr*0.42, 0.04, 20), sx*0.01, 0, 0);                                              // its hat
  return w;
}
// the caliper (on the holder: it steers with the wheel and never spins), behind the top of the disc
function carCaliper(B, node, mk, rr, tw, sx, col, x0, y0, z0){
  var T = B.T, g = rbox(T, 0.05, rr*0.5, 0.1, 0.02, 1);
  B.t("satin").at(node, mk, col, g, x0 + sx*0.035, y0 + Math.cos(0.7)*rr*0.6, z0 - Math.sin(0.7)*rr*0.6, -0.7, 0, 0);
}

// a lamp / grille outline helper set: rounded rectangles and polygons in a part's own (x across, y up) plane
function rrPts(w, h, r, n){
  var out = [], q = [[w/2 - r, h/2 - r, 0], [-w/2 + r, h/2 - r, PI/2], [-w/2 + r, -h/2 + r, PI], [w/2 - r, -h/2 + r, PI*1.5]];
  n = n || 3; r = Math.max(0.001, Math.min(r, w/2, h/2));
  q.forEach(function(c){ for(var i = 0; i <= n; i++){ var a = c[2] + PI/2*i/n; out.push([c[0] + Math.cos(a)*r, c[1] + Math.sin(a)*r]); } });
  return out;
}
function ovalPts(w, h, n){ var o = []; for(var i = 0; i < (n || 20); i++){ var a = i/(n || 20)*PI*2; o.push([Math.cos(a)*w/2, Math.sin(a)*h/2]); } return o; }
function hexPts(r, sx, sy){ var o = []; for(var i = 0; i < 6; i++){ var a = i*PI/3; o.push([Math.cos(a)*r*(sx || 1), Math.sin(a)*r*(sy || 1)]); } return o; }
function mirX(pts, o){ return o < 0 ? pts.map(function(p){ return [-p[0], p[1]]; }).reverse() : pts; }
// a bar between two points in a part's plane (a DRL stroke): [x0, y0] to [x1, y1], w thick, d deep
function strokeG(T, a, b, w, d){
  var dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 0.001, nx = -dy/l*w/2, ny = dx/l*w/2;
  return flat(T, [[a[0] + nx, a[1] + ny], [a[0] - nx, a[1] - ny], [b[0] - nx, b[1] - ny], [b[0] + nx, b[1] + ny]], d || 0.01);
}

// the lamps at an end: [mk, colour, patch, geometry, depth-out] in the lamp's plane (+x outward when o > 0)
function lampParts(T, kind, o, end){
  var L = [], G = function(mk, col, pat, geo, out){ L.push([mk, col, pat, geo, out || 0]); };
  var housing = function(pts, d){ G("trim", COL.black, "gloss", flat(T, mirX(pts, o), d || 0.03, 0.004, 0), 0.004); };
  var st = function(a, b, w, mk, col){ G(mk || "light", col == null ? COL.drl : col, null, strokeG(T, [a[0]*o, a[1]], [b[0]*o, b[1]], w || 0.012, 0.012), 0.016); };
  if(end > 0){
    if(kind === "bmw"){
      housing([[-0.16, -0.04], [0.19, -0.055], [0.215, 0.03], [0.17, 0.05], [-0.15, 0.048]]);
      [-0.07, 0.08].forEach(function(x){ st([x - 0.035, 0.03], [x + 0.035, 0.03]); st([x - 0.035, 0.03], [x - 0.035, -0.035]); G("trim", COL.chrome, "chrome", discFace(T, 0.022), 0.012); L[L.length - 1][3].translate(o*(x + 0.01), -0.005, 0); });
      st([-0.14, -0.045], [0.18, -0.052], 0.008, "light", COL.amber);
    } else if(kind === "split"){
      housing([[-0.17, -0.016], [0.22, -0.022], [0.24, 0.016], [-0.16, 0.018]], 0.02); st([-0.15, 0], [0.22, -0.004], 0.014);
    } else if(kind === "lamboY"){
      housing([[-0.2, -0.015], [0.22, -0.065], [0.26, 0.03], [-0.19, 0.045]]);
      st([0.02, 0.0], [0.02, 0.04]); st([0.02, 0.0], [-0.03, -0.028]); st([0.02, 0.0], [0.07, -0.03]); st([0.02, 0.04], [0.24, 0.026]); st([0.02, 0.04], [-0.17, 0.04]);
    } else if(kind === "lamboHex"){
      housing([[-0.2, -0.02], [0.2, -0.06], [0.25, 0.03], [-0.19, 0.04]]);
      var hx = hexPts(0.036, 1.2, 1); for(var i = 0; i < 6; i++) st([hx[i][0] + 0.03, hx[i][1]], [hx[(i + 1) % 6][0] + 0.03, hx[(i + 1) % 6][1]], 0.009);
    } else if(kind === "quad"){
      housing([[-0.2, -0.028], [0.2, -0.04], [0.22, 0.028], [-0.19, 0.035]], 0.03);
      [[-0.1, 0.012], [-0.02, 0.012], [-0.1, -0.018], [-0.02, -0.018]].forEach(function(p){ G("light", COL.head, null, flat(T, mirX(rrPts(0.05, 0.024, 0.006), o).map(function(q){ return [q[0] + p[0]*o, q[1] + p[1]]; }), 0.012), 0.018); });
      st([0.04, 0.02], [0.19, 0.012], 0.008);
    } else if(kind === "vert"){
      housing([[0.12, -0.09], [0.2, -0.08], [0.21, 0.06], [0.15, 0.065]], 0.03);
      [0.04, 0.0, -0.04].forEach(function(y){ st([0.15, y], [0.19, y + 0.004], 0.018, "light", COL.head); });
    } else if(kind === "oval"){
      G("trim", COL.black, "gloss", flat(T, ovalPts(0.26, 0.12, 24).map(function(q){ return [q[0]*o + 0.0, q[1]]; }), 0.03), 0.004);
      [-0.05, 0.05].forEach(function(x){ G("light", COL.head, null, discFace(T, 0.035), 0.018); L[L.length - 1][3].translate(x*o, 0, 0); });
    } else if(kind === "koen"){
      housing([[-0.1, -0.035], [0.12, -0.04], [0.13, 0.03], [-0.09, 0.04]], 0.025);
      [0.016, -0.006, -0.026].forEach(function(y){ st([-0.07, y], [0.1, y], 0.008, "light", COL.head); });
    } else if(kind === "popup"){
      G("trim", COL.black, null, flat(T, [[-0.2, 0.003], [0.2, 0.003], [0.2, 0.006], [-0.2, 0.006]], 0.006), 0.001);
      G("light", COL.amber, null, flat(T, rrPts(0.1, 0.035, 0.008), 0.01), 0.008); L[L.length - 1][3].translate(o*0.1, -0.12, 0);
    } else if(kind === "round"){
      G("trim", COL.chrome, "chrome", discFace(T, 0.1), 0.004); G("light", COL.head, null, discFace(T, 0.075), 0.014);
    } else {
      housing(rrPts(0.36, 0.09, 0.03)); st([-0.15, -0.03], [0.16, -0.03], 0.012);
    }
  } else {
    var red = function(pts, out){ G("tail", COL.red, "ledbar", flat(T, mirX(pts, o), 0.014), out || 0.01); };
    var smoke = function(pts){ G("trim", 0x2a0b0d, "gloss", flat(T, mirX(pts, o), 0.02), 0.004); };
    if(kind === "bmwL"){
      smoke([[-0.2, -0.05], [0.24, -0.06], [0.25, 0.045], [-0.2, 0.05]]);
      red([[-0.17, 0.02], [0.2, 0.012], [0.2, 0.032], [-0.15, 0.036]]); red([[0.17, -0.045], [0.2, -0.045], [0.2, 0.02], [0.17, 0.02]]);
      red([[-0.17, -0.03], [0.05, -0.034], [0.05, -0.02], [-0.17, -0.016]]);
    } else if(kind === "laser"){
      smoke([[-0.2, -0.04], [0.24, -0.05], [0.25, 0.04], [-0.2, 0.045]]);
      [-0.02, 0.0, 0.02].forEach(function(y, i){ red([[-0.16 + i*0.03, y], [0.22, y - 0.03], [0.22, y - 0.022], [-0.16 + i*0.03, y + 0.008]]); });
    } else if(kind === "thin"){
      smoke([[-0.25, -0.02], [0.24, -0.024], [0.25, 0.02], [-0.25, 0.022]]); red([[-0.24, -0.006], [0.24, -0.01], [0.24, 0.006], [-0.24, 0.008]]);
    } else if(kind === "lamboY"){
      smoke([[-0.16, -0.06], [0.22, -0.05], [0.24, 0.05], [-0.14, 0.04]]);
      st([0.04, 0.0], [0.04, 0.045], 0.016, "tail", COL.red); st([0.04, 0.0], [-0.02, -0.04], 0.016, "tail", COL.red); st([0.04, 0.0], [0.11, -0.04], 0.016, "tail", COL.red);
    } else if(kind === "lamboHex"){
      smoke(hexPts(0.08, 1.4, 0.8)); var hx2 = hexPts(0.06, 1.4, 0.8);
      for(var k2 = 0; k2 < 6; k2++) st(hx2[k2], hx2[(k2 + 1) % 6], 0.012, "tail", COL.red);
    } else if(kind === "round"){
      [[0.0, 0], [0.13, 0.005]].forEach(function(p){ G("tail", COL.red, "ledcell", discFace(T, 0.048), 0.012); L[L.length - 1][3].translate(p[0]*o, p[1], 0); });
    } else if(kind === "koenBar"){
      smoke([[-0.06, -0.025], [0.24, -0.03], [0.25, 0.025], [-0.06, 0.03]]); red([[-0.04, -0.008], [0.23, -0.012], [0.23, 0.008], [-0.04, 0.01]]);
    } else if(kind === "veyron"){
      [[0.02, 0], [0.13, 0.0]].forEach(function(p){ G("tail", COL.red, "ledcell", discFace(T, 0.045), 0.012); L[L.length - 1][3].translate(p[0]*o, p[1], 0); });
    } else if(kind === "lp400"){
      G("light", COL.amber, null, flat(T, mirX([[0.02, -0.04], [0.1, -0.04], [0.1, 0.04], [0.02, 0.04]], o), 0.012), 0.01);
      red([[0.1, -0.04], [0.26, -0.04], [0.26, 0.04], [0.1, 0.04]]);
    } else if(kind === "bugBar" || kind === "bugX"){
      // a single light bar across the whole tail: drawn once (from the left side) as one strip over the centre
      if(o > 0){ G("trim", COL.black, "gloss", flat(T, [[-0.8, -0.035], [0.8, -0.035], [0.8, 0.03], [-0.8, 0.03]], 0.02), 0.004);
        G("tail", COL.red, "ledbar", flat(T, [[-0.78, -0.01], [0.78, -0.01], [0.78, 0.008], [-0.78, 0.008]], 0.014), 0.012);
        if(kind === "bugX") [[-0.18, 1], [0.18, -1]].forEach(function(q){ G("tail", COL.red, null, strokeG(T, [q[0], 0], [q[0] + q[1]*0.1, -0.09], 0.012, 0.012), 0.012); }); }
    } else {
      smoke(rrPts(0.36, 0.1, 0.02)); red(rrPts(0.32, 0.06, 0.015));
    }
  }
  return L;
}
function discFace(T, r){ var g = new T.CylinderGeometry(r, r, 0.012, 20); g.rotateX(PI/2); var uv = g.attributes.uv, p = g.attributes.position; for(var i = 0; i < p.count; i++) uv.setXY(i, p.getX(i)/(2*r) + 0.5, p.getY(i)/(2*r) + 0.5); return g; }

// the grille: BMW kidneys by style, the Bugatti horseshoe, a Lamborghini hexagon, a mouth; laid on the nose
function grilleParts(B, body, S, P, yG){
  var T = B.T, at = function(mk, col, pat, geo, cx, cy, out){ if(pat) B.t(pat); B.put(body, mk, S.onEnd(geo, cx, cy, 1, out || 0), col); };
  var k = P.grille, hw = S.hw;
  if(k){
    var D = {tall: [0.24, 0.42, 0.06, 0.04, "h"], wide: [0.3, 0.16, 0.05, 0.03, "v"], frameless: [0.27, 0.15, 0.015, 0.025, "h"], wideLit: [0.33, 0.2, 0.06, 0.03, "v"],
             xl: [0.32, 0.3, 0.07, 0.035, "v"], xlLit: [0.38, 0.28, 0.06, 0.03, "v"], xm: [0.34, 0.3, 0.03, 0.03, "v"], closed: [0.2, 0.3, 0.06, 0.04, "c"], diag: [0.3, 0.24, 0.05, 0.03, "d"]}[k] || [0.3, 0.16, 0.05, 0.03, "v"];
    var w = D[0], h = D[1], r = D[2], gap = D[3], cy = yG - h/2 + (k === "tall" || k === "closed" ? -0.02 : 0.04);
    [1, -1].forEach(function(o){
      var cx = o*(w/2 + gap/2), pts = k === "xm" ? [[w/2, h*0.25], [w*0.3, h/2], [-w/2, h/2], [-w/2, -h*0.3], [-w*0.3, -h/2], [w/2, -h/2]].map(function(p){ return [p[0]*o, p[1]]; }) : rrPts(w, h, r);
      var frameCol = k === "frameless" || k === "closed" || P.fam === "suv" && k !== "xl" ? COL.black : k === "tall" ? COL.black : COL.chrome;
      at("trim", frameCol, frameCol === COL.chrome ? "chrome" : "gloss", flat(T, pts, 0.035, 0.006), cx, cy, -0.004);
      var inner = pts.map(function(p){ return [p[0]*0.86, p[1]*0.84]; });
      at("trim", k === "closed" ? 0x2c3036 : COL.black, k === "closed" ? "gloss" : "honey", flat(T, inner, 0.02), cx, cy, 0.006);
      if(k === "wideLit" || k === "xlLit") at("light", COL.drl, null, flat(T, pts.map(function(p){ return [p[0]*0.99, p[1]*0.98]; }).concat(inner.slice().reverse()), 0.006), cx, cy, 0.022);
      var nS = D[4] === "h" ? 5 : D[4] === "v" ? Math.round(w/0.035) : D[4] === "d" ? 6 : 0;
      for(var i = 0; i < nS; i++){
        var t = (i + 0.5)/nS - 0.5, g;
        if(D[4] === "h") g = rbox(T, w*0.8, 0.012, 0.012, 0.004, 1), g.translate(0, t*h*0.8, 0.012);
        else if(D[4] === "v") g = rbox(T, 0.01, h*0.78, 0.012, 0.004, 1), g.translate(t*w*0.82, 0, 0.012);
        else { g = rbox(T, 0.01, h*0.9, 0.012, 0.004, 1); g.rotateZ(0.5*o); g.translate(t*w*0.8, 0, 0.012); }
        at("trim", k === "frameless" || k === "tall" ? COL.dark : COL.chrome, "chrome", g, cx, cy, 0.01);
      }
    });
  }
  if(P.grilleL === "horseshoe"){
    var hs = []; for(var j = 0; j <= 16; j++){ var a = PI*0.05 + PI*0.9*j/16; hs.push([Math.cos(a + PI)*0.15, -Math.sin(a)*0.14 + 0.06]); }
    hs = hs.concat([[0.15, 0.13], [-0.15, 0.13]]).reverse();
    var hsy = yG - 0.08;
    at("trim", COL.chrome, "chrome", flat(T, hs, 0.04, 0.008), 0, hsy, -0.004);
    at("trim", COL.black, "honey", flat(T, hs.map(function(p){ return [p[0]*0.85, (p[1] - 0.04)*0.85 + 0.04]; }), 0.02), 0, hsy, 0.01);
  }
  if(P.grilleL === "hex"){
    at("trim", COL.black, "honey", flat(T, [[0.42, 0.06], [0.3, -0.12], [-0.3, -0.12], [-0.42, 0.06], [-0.3, 0.1], [0.3, 0.1]], 0.03, 0.005), 0, yG - 0.12, 0.0);
  }
}

// the lower front: intakes, splitter, fogs; the rear: diffuser, tips; by family
function intakeParts(B, body, S, P, yI){
  var T = B.T, hw = S.hw, at = function(mk, col, pat, geo, cx, cy, end, out){ if(pat) B.t(pat); B.put(body, mk, S.onEnd(geo, cx, cy, end, out || 0), col); };
  var bmw = P.brand === "bmw", M = P.diff && bmw, lam = P.brand === "lamborghini", bug = P.brand === "bugatti", koe = !!P.koen;
  if(P.lamp === "popup"){ at("trim", COL.black, "honey", flat(T, rrPts(0.9, 0.07, 0.02), 0.02), 0, yI + 0.02, 1, 0.002); return; }
  if(lam && !(P.fam === "suv")){
    [1, -1].forEach(function(o){ at("trim", COL.black, "honey", flat(T, mirX([[0.08, 0.08], [0.42, 0.04], [0.5, -0.06], [0.4, -0.1], [0.1, -0.06]], o), 0.03, 0.004), o*hw*0.5, yI, 1, 0.0); });
    at("trim", COL.black, "honey", flat(T, [[0.32, 0.03], [-0.32, 0.03], [-0.26, -0.04], [0.26, -0.04]], 0.03), 0, yI - 0.02, 1, 0.0);
  } else if(bug){
    [1, -1].forEach(function(o){ at("trim", COL.black, "honey", flat(T, mirX(rrPts(0.3, 0.16, 0.05), o), 0.03, 0.004), o*hw*0.62, yI + 0.04, 1, 0.0); });
  } else if(koe){
    at("trim", COL.black, "honey", flat(T, rrPts(hw*1.2, 0.12, 0.05), 0.03, 0.004), 0, yI + 0.03, 1, 0.0);
  } else {
    var cw = M ? 0.62 : 0.7, ch = M ? 0.13 : 0.08;
    at("trim", COL.black, "honey", flat(T, [[cw/2, ch/2], [-cw/2, ch/2], [-cw/2 + 0.04, -ch/2], [cw/2 - 0.04, -ch/2]], 0.03, 0.004), 0, yI - (M ? 0.0 : 0.03), 1, 0.0);
    [1, -1].forEach(function(o){
      if(M || P.fam === "suv") at("trim", COL.black, "honey", flat(T, mirX([[0.0, 0.1], [0.14, 0.12], [0.16, -0.08], [0.02, -0.08]], o), 0.03, 0.004), o*hw*0.68, yI + 0.03, 1, 0.0);
      else at("trim", COL.black, "gloss", flat(T, mirX([[0.0, 0.03], [0.16, 0.06], [0.17, -0.04], [0.01, -0.04]], o), 0.02, 0.003), o*hw*0.7, yI + 0.04, 1, 0.0);
    });
  }
  // the splitter, under the nose
  if(M || P.mid) B.t("carbon").at(body, "trim", COL.carbon, rbox(T, S.W*0.8, 0.02, 0.12, 0.008, 1), 0, S.gc + 0.012, S.skinZ(0, S.gc + 0.04, 1) - 0.04);
}
function rearParts(B, body, S, P, G){
  var T = B.T, hw = S.hw, at = function(mk, col, pat, geo, cx, cy, out){ if(pat) B.t(pat); B.put(body, mk, S.onEnd(geo, cx, cy, -1, out || 0), col); };
  var yD = S.gc + 0.13, ex = P.ex;
  if(G.ex && ex) ex = G.ex === 1 ? "twin" : "quad";
  if(P.diff || P.mid) at("trim", COL.carbon, "carbon", flat(T, [[-hw*0.86, 0.1], [hw*0.86, 0.1], [hw*0.8, -0.09], [-hw*0.8, -0.09]], 0.05, 0.006), 0, yD, 0.0);
  else at("trim", COL.black, "plastic", flat(T, [[-hw*0.86, 0.06], [hw*0.86, 0.06], [hw*0.8, -0.06], [-hw*0.8, -0.06]], 0.04, 0.006), 0, yD - 0.02, 0.0);
  if(P.diff || P.mid) for(var f = -3; f <= 3; f++) B.t("carbon").at(body, "trim", COL.carbon, rbox(T, 0.012, 0.08, 0.3, 0.004, 1), f*hw*0.16, S.gc + 0.05, S.zT + 0.2);
  var tip = function(x, y, r, rr2){
    var col = G.ex === 3 ? COL.ti : COL.chrome;
    var g = rr2 ? flat(T, ovalPts(r*2, rr2*2, 18), 0.1, 0.008) : discFace(T, r).scale(1, 1, 7);
    at("trim", col, "chrome", g, x, y, 0.025);
    var gi = rr2 ? flat(T, ovalPts(r*1.7, rr2*1.7, 18), 0.1) : discFace(T, r*0.82).scale(1, 1, 7.5);
    at("trim", COL.black, "rubber", gi, x, y, 0.03);
  };
  if(!ex) return;
  var y0 = S.gc + 0.12;
  if(ex === "twin") [1, -1].forEach(function(o){ tip(o*hw*0.62, y0, 0.045); });
  else if(ex === "quad") [1, -1].forEach(function(o){ tip(o*hw*0.56, y0, 0.043); tip(o*hw*0.72, y0, 0.043); });
  else if(ex === "quadV") [1, -1].forEach(function(o){ tip(o*hw*0.6, y0 + 0.05, 0.038); tip(o*hw*0.6, y0 - 0.04, 0.038); });
  else if(ex === "hex") [1, -1].forEach(function(o){ tip(o*0.1, S.H*0.42, 0.05); });
  else if(ex === "centreBig") tip(0, S.H*0.44, 0.075);
  else if(ex === "centreHigh") [1, -1].forEach(function(o){ tip(o*0.09, S.H*0.5, 0.045); });
  else if(ex === "twinHigh") [1, -1].forEach(function(o){ tip(o*0.07, S.H*0.52, 0.05); });
  else if(ex === "bug") [-0.16, -0.06, 0.06, 0.16].forEach(function(x){ tip(x, y0 + 0.02, 0.04); });
  else if(ex === "centre") tip(0, y0 + 0.03, 0.08, 0.05);
  else if(ex === "oval") tip(0, S.H*0.5, 0.15, 0.06);
  else if(ex === "ovalChrome") tip(0, y0 + 0.05, 0.12, 0.05);
}

/* the car */
function buildCar(T, entry, st, d, G){
  G = G || GEO0;
  var P = carSpec(entry, st, d), S = carShape(T, P, d), B = new Builder(T), root = new T.Group(), body = B.node(root, "body");
  var L = S.L, W = S.W, H = S.H, hw = S.hw, zf = S.zf, zr = S.zr, gc = S.gc, zN = S.zN, zT = S.zT, mid = P.mid;
  var dtype = doorType(entry, st), hasDoors = dtype !== "none";
  var twF = P.tf[0]/1000, twR = P.tr[0]/1000;
  // the doors: the front door from just behind the front arch back to the B pillar (a supercar's to its scoop)
  var zD0 = zf - S.arF - 0.06, zD1 = Math.max(zr + S.arR + (mid ? 0.6 : 0.12), zD0 - (mid ? 1.3 : P.fam === "coupe" ? 1.28 : 1.06));
  var vLo = 0.1, vHi = 0.8, four = !mid && P.fam !== "coupe";
  var zRD1 = zr + S.arR + 0.04;                                  // a rear door's back edge (over the rear arch)
  var tone2 = function(){ return G.two ? B.t("tone2") : B; };
  var secN = function(lod){ return S.secPts(lod ? 22 : 56); };
  var stations = function(lod){
    var n = lod ? 30 : 92, zs = [], i;
    for(i = 0; i <= n; i++){ var u = i/n; zs.push(zT + (zN - zT)*(0.55*(0.5 - 0.5*Math.cos(u*PI)) + 0.45*u)); }
    if(!lod) [[zf, S.arF], [zr, S.arR]].forEach(function(a){ for(var k = 0; k <= 16; k++){ var t = -1 + 2*k/16; zs.push(a[0] + t*(a[1] + 0.02)); } zs.push(a[0] - a[1] - 0.005, a[0] + a[1] + 0.005); });
    if(!lod && hasDoors){ zs.push(zD0, zD1, zD0 + 0.002, zD1 - 0.002); }
    zs = zs.filter(function(z){ return z >= zT && z <= zN; }).sort(function(a, b){ return a - b; });
    return zs.filter(function(z, k){ return !k || z - zs[k - 1] > 0.004; });
  };
  var LODS = [0, 1];
  LODS.forEach(function(lod){
    B.lod = lod;
    var zs = stations(lod), ring = secN(lod), under = [[-0.95, 0.06], [-0.8, 0.0], [0, -0.005], [0.8, 0.0], [0.95, 0.06]];
    var up = [], dn = [], vs = ring.map(function(q){ return q[1]; }), us = ring.map(function(q){ return q[0]; });
    zs.forEach(function(z){ up.push(ring.map(function(q){ var p = S.surf(z, q[0], q[1]); return [p[0], p[1]]; })); dn.push(under.map(function(q){ var p = S.surf(z, q[0], q[1]); return [p[0], p[1]]; })); });
    var parts = loftSplit(T, up, zs, false, function(i, j){
      if(lod || !hasDoors) return "paint";
      var z = (zs[i] + zs[i + 1])/2, v = (vs[j] + vs[j + 1])/2, u = (us[j] + us[j + 1])/2;
      return z < zD0 && z > zD1 && v > vLo && v < vHi && Math.abs(u) > 0.5 ? "trim" : "paint";
    });
    if(parts.paint) B.put(body, "paint", parts.paint);
    if(parts.trim) B.put(body, "trim", parts.trim, COL.dark);
    B.t("plastic").put(body, "trim", loftG(T, dn, zs, false), COL.black);
    var endRing = function(i){ return up[i].concat(dn[i].slice(1, -1)); };
    B.put(body, "paint", capG(T, endRing(0), zs[0], -1)); B.put(body, "paint", capG(T, endRing(zs.length - 1), zs[zs.length - 1], 1));
    // the greenhouse: glass, the roof over it, the pillars and the window line
    var NG = lod ? 12 : 46, NA = lod ? 10 : 26, gz = [], gR = [], ga = [];
    for(var i = 0; i <= NG; i++){ var z = S.zC + (S.zA - S.zC)*i/NG; gz.push(z); }
    for(var j = 0; j <= NA; j++) ga.push(PI*j/NA);
    gz.forEach(function(z){ gR.push(ga.map(function(a){ return S.gh(z, a); })); });
    var zB = zD1 + 0.03, glassPick = function(i, j){
      if(lod || !hasDoors) return "glass";
      var z = (gz[i] + gz[i + 1])/2, a = (ga[j] + ga[j + 1])/2;
      return z < S.zA && z > zB && (a < PI*0.3 || a > PI*0.7) ? null : "glass";
    };
    var gp = loftSplit(T, gR, gz, false, glassPick); if(gp.glass) B.put(body, "glass", gp.glass);
    var band = function(z0, z1, a0, a1, grow, nz, na){
      var zz = [], rr = [];
      for(var q = 0; q <= nz; q++){ var z2 = z0 + (z1 - z0)*q/nz; zz.push(z2); var r2 = []; for(var k = 0; k <= na; k++) r2.push(S.gh(z2, a0 + (a1 - a0)*k/na, grow)); rr.push(r2); }
      return loftG(T, rr, zz, false);
    };
    var nzr = lod ? 6 : 22, roofZ0 = S.zCr - (mid ? 0.0 : 0.04), roofZ1 = S.zAr + 0.04;
    if(G.two === 1) tone2();
    else if(P.roof != null) B.t("carbon");
    B.put(body, G.two === 1 || P.roof == null ? "paint" : "trim", band(roofZ0, roofZ1, PI*0.29, PI*0.71, 0.006, nzr, lod ? 6 : 12), P.roof);
    [[0.015, 0.31], [0.69, PI/PI - 0.015]].forEach(function(r){
      var a0 = r[0]*PI, a1 = r[1]*PI;
      B.put(body, "paint", band(S.zC, S.zCr + 0.02, a0, a1, 0.006, lod ? 4 : 12, lod ? 3 : 8));         // the C pillars
      if(!lod) B.put(body, "paint", band(S.zAr + 0.02, S.zA, r[0] < 0.5 ? 0.25*PI : 0.69*PI, r[0] < 0.5 ? 0.31*PI : 0.75*PI, 0.006, 14, 3));   // the A pillars
    });
    if(!lod){
      var trimC = P.mid || /M|CSL/.test(String(entry.model || "")) && P.brand === "bmw" ? COL.black : COL.chrome;
      B.t(trimC === COL.chrome ? "chrome" : "gloss").put(body, "trim", band(S.zC + 0.02, S.zA - 0.04, 0.0, 0.0015*PI, 0.009, 20, 1), trimC);
      B.t(trimC === COL.chrome ? "chrome" : "gloss").put(body, "trim", band(S.zC + 0.02, S.zA - 0.04, 0.9985*PI, PI, 0.009, 20, 1), trimC);
      if(!mid) [[0.015, 0.29], [0.71, 0.985]].forEach(function(r){ B.t("gloss").put(body, "trim", band(zB - 0.07, zB + 0.01, r[0]*PI, r[1]*PI, 0.007, 2, 6), COL.black); });   // the B pillars
    }
    // the arch liners (dark), so you never see through the body round a wheel
    [[zf, S.arF, S.acF, twF], [zr, S.arR, S.acR, twR]].forEach(function(a){
      [1, -1].forEach(function(sx){
        var g = new T.CylinderGeometry(a[1] - 0.004, a[1] - 0.004, a[3] + 0.1, lod ? 8 : 20, 1, true, 0, PI);
        g.rotateZ(PI/2); g.scale(1, 1, 1); flipX(g);
        B.t("rubber").at(body, "trim", COL.black, g, sx*(hw - (a[3] + 0.1)/2 - 0.01), a[2], a[0]);
      });
    });
    // the lamps, front and back, and the grille / intakes
    // lamp heights from the end stations (a share of the way up), their centres and scale from the width there
    var sF = S.station(zN - (mid ? 0.32 : 0.2)), sR = S.station(zT + 0.2), vL = P.fam === "suv" ? 0.7 : mid ? 0.8 : 0.74, vT = mid ? 0.72 : 0.68;
    var yL = sF.yb + vL*sF.h, yT = sR.yb + vT*sR.h, wF = S.uOfV(vL)*sF.w, wR = S.uOfV(vT)*sR.w;
    var lx = wF*(P.lamp === "koen" ? 0.7 : 0.6), tx = wR*0.62, lsc = Math.min(1.2, (wF*0.97 - lx)/0.22), tsc = Math.min(1.2, (wR*0.98 - tx)/0.23);
    if(lod){
      [1, -1].forEach(function(o){
        B.put(body, "light", S.onEnd(flat(T, rrPts(0.32, 0.07, 0.02), 0.01), o*lx, yL, 1, 0.006), COL.drl);
        B.put(body, "tail", S.onEnd(flat(T, rrPts(0.34, 0.07, 0.02), 0.01), o*tx, yT, -1, 0.006), COL.red);
      });
      B.put(body, "trim", S.onEnd(flat(T, rrPts(hw*1.1, 0.12, 0.04), 0.01), 0, gc + 0.22, 1, 0.004), COL.black);
      return;
    }
    [1, -1].forEach(function(o){
      lampParts(T, P.lamp, o, 1).forEach(function(q){ if(q[2]) B.t(q[2]); B.put(body, q[0], S.onEnd(q[3].scale(lsc, lsc, 1), o*lx, yL, 1, q[4]), q[1]); });
      if(P.tail === "bugBar" || P.tail === "bugX"){ if(o > 0) lampParts(T, P.tail, 1, -1).forEach(function(q){ if(q[2]) B.t(q[2]); B.put(body, q[0], S.onEnd(q[3], 0, yT, -1, q[4]), q[1]); }); }
      else lampParts(T, P.tail, o, -1).forEach(function(q){ if(q[2]) B.t(q[2]); B.put(body, q[0], S.onEnd(q[3].scale(tsc, tsc, 1), o*tx, yT, -1, q[4]), q[1]); });
    });
    grilleParts(B, body, S, P, yL + 0.02);
    intakeParts(B, body, S, P, gc + 0.2);
    rearParts(B, body, S, P, G);
    // the plates (the atlas plate), front unless a Bugatti hypercar
    var pry = gc + 0.3;
    B.t("plate").put(body, "trim", S.onEnd(flat(T, rrPts(0.52, 0.11, 0.01), 0.012), 0, pry, -1, 0.01), 0xffffff);
    if(P.brand !== "bugatti") B.t("plate").put(body, "trim", S.onEnd(flat(T, rrPts(0.52, 0.11, 0.01), 0.012), 0, gc + 0.16, 1, 0.012), 0xffffff);
    S.plates = [{p: [0, pry, S.skinZ(0, pry, -1) - 0.0215], ry: PI, rx: 0, w: 0.5, h: 0.1}];
    if(P.brand !== "bugatti") S.plates.push({p: [0, gc + 0.16, S.skinZ(0, gc + 0.16, 1) + 0.0225], ry: 0, rx: 0, w: 0.5, h: 0.1});
    // the flanks: shut lines, sills, gills, the C-line, scoops, a two-tone livery
    if(hasDoors){
      if(four){ sideLine(B, body, "trim", COL.black, S, [[zRD1, vLo + 0.05], [zRD1, vHi], [zD1 - 0.02, vHi]], 0.007, 0.002); }
    }
    B.t(P.mid || P.diff ? "carbon" : "plastic");
    sidePatch(B, body, "trim", P.mid || P.diff ? COL.carbon : COL.black, S, zf - S.arF - 0.02, zr + S.arR + 0.02, 0.0, 0.1, 10, 2, 0.006);
    if(P.gill) sidePatch(B.t("honey"), body, "trim", COL.black, S, zf - S.arF - 0.04, zf - S.arF - 0.2, 0.5, 0.6, 3, 2, 0.005);
    if(P.intake || P.scoopK){
      var zi0 = zr + S.arR + (P.scoopK ? 0.75 : 0.62), zi1 = zr + S.arR + 0.03;
      B.t("honey"); sidePatch(B, body, "trim", COL.black, S, zi0, zi1, 0.32, P.scoopK ? 0.82 : 0.72, 6, 6, 0.004);
    }
    if(P.naca) sidePatch(B.t("gloss"), body, "trim", COL.black, S, zD1 + 0.15, zD1 - 0.35, 0.78, 0.95, 5, 3, 0.002);
    if(P.cline){
      var cp = [[zD1 + 0.1, 0.99], [zD1 - 0.14, 0.82], [zD1 - 0.24, 0.55], [zD1 - 0.16, 0.25], [zD1 + 0.12, 0.1], [zD0 - 0.05, 0.08], [zf - S.arF - 0.05, 0.12]];
      sideLine(B.t("chrome"), body, "trim", COL.chrome, S, cp, 0.035, 0.006);
      B.t("honey"); sidePatch(B, body, "trim", COL.black, S, zD1 - 0.02, zD1 - 0.2, 0.32, 0.78, 4, 6, 0.0);
    }
    if(G.two === 3){ tone2(); sidePatch(B, body, "paint", null, S, zN - 0.25, zT + 0.25, 0.3, 0.42, 30, 2, 0.003); }
    if(G.two === 2) [0.1, -0.1].forEach(function(x){
      var rows = [[], []];
      for(var q = 0; q <= 30; q++){ var z = zT + 0.12 + (zN - 0.14 - zT - 0.12)*q/30; if(z < S.zA && z > S.zC) z = S.zA; [x - 0.06, x + 0.06].forEach(function(xx, k){ rows[k].push([xx, Math.max(S.topY(z, xx), z < S.zA && z > S.zC ? 0 : 0) + 0.004, z]); }); }
      tone2(); B.put(body, "paint", gridOut(T, rows, [0, 1, 0]));
    });
    // wipers, the roof's fin, rails
    [0.0, -0.5].forEach(function(x){ B.t("gloss").at(body, "trim", COL.black, rodG(T, [x*hw + 0.02, S.top(S.zA) + 0.01, S.zA + 0.04], [x*hw + hw*0.5, S.top(S.zA) + 0.03, S.zA + 0.02], 0.006, 0.006, 4)); });
    if(!mid) B.t("gloss").at(body, "trim", COL.black, sprof(T, [[0.0, 0], [-0.16, 0], [-0.12, 0.05]], 0.05, 0.008), 0, S.roof(S.zCr + 0.1) + 0.004, S.zCr + 0.18);
    if(P.rails) [1, -1].forEach(function(sx){ B.t("metal").at(body, "trim", COL.alu, tubeG(T, [[sx*hw*P.tw*0.82, S.roof(S.zAr) - 0.01, S.zAr - 0.05], [sx*hw*P.tw*0.82, H + 0.025, (S.zAr + S.zCr)/2], [sx*hw*P.tw*0.82, S.roof(S.zCr) + 0.0, S.zCr + 0.02]], 0.014, 12, 6)); });
    // the aero: a lip, a ducktail, the STO's wing and fin, the Agera's wing, the One:1's swan neck, the Jesko's fins
    var wing = G.wing ? [0, 1, 2, 4][G.wing] : P.wing, yDeck = S.topY(zT + 0.2, 0);
    if(wing === 1) B.at(body, "paint", null, rbox(T, W*0.62, 0.02, 0.08, 0.008, 1), 0, yDeck + 0.008, zT + 0.12, -0.15);
    if(wing === 2) B.at(body, "paint", null, sprof(T, [[0.1, 0], [-0.12, 0.0], [-0.13, 0.06]], W*0.72, 0.012), 0, yDeck - 0.012, zT + 0.12);
    if(wing === 4 || wing === 6 || wing === 7){
      var wy = wing === 4 ? S.H*0.9 : S.H*0.88, wz = zT + (wing === 7 ? 0.32 : 0.25), ww = W*(wing === 4 ? 0.9 : 0.82);
      B.t("carbon").at(body, "trim", COL.carbon, aeroGeo(T, 0.34, 0.09, ww, 0.06, 6), 0, wy, wz + 0.17, -0.12);
      [1, -1].forEach(function(sx){
        B.t("carbon").at(body, "trim", COL.carbon, rbox(T, 0.012, 0.16, 0.42, 0.005, 1), sx*ww/2, wy - 0.02, wz);
        if(wing === 7) B.t("carbon").at(body, "trim", COL.carbon, tubeG(T, [[sx*0.3, yDeck, wz + 0.25], [sx*0.3, wy + 0.08, wz + 0.15], [sx*0.3, wy + 0.04, wz + 0.0]], 0.018, 10, 6));
        else B.t("carbon").at(body, "trim", COL.carbon, rbox(T, 0.02, wy - yDeck, 0.12, 0.008, 1), sx*0.32, (wy + yDeck)/2, wz + 0.05);
      });
    }
    if(wing === 5) B.t("carbon").at(body, "trim", COL.carbon, rbox(T, W*0.7, 0.02, 0.32, 0.01, 1), 0, yDeck + 0.006, zT + 0.3);
    if(G.wing === 3){
      var gy = P.hatch && !mid ? H + 0.08 : yDeck + 0.3, gz2 = P.hatch && !mid ? S.zCr + 0.0 : zT + 0.3, gb = P.hatch && !mid ? S.roof(S.zCr) : yDeck;
      B.t("carbon").at(body, "trim", COL.carbon, aeroGeo(T, 0.3, 0.09, W*0.86, 0.06, 6), 0, gy, gz2 + 0.15, -0.12);
      [1, -1].forEach(function(sx){ B.t("carbon").at(body, "trim", COL.carbon, rbox(T, 0.012, 0.14, 0.36, 0.005, 1), sx*W*0.43, gy - 0.02, gz2); B.t("gloss").at(body, "trim", COL.black, rbox(T, 0.02, gy - gb, 0.09, 0.006, 1), sx*W*0.2, (gy + gb)/2, gz2 + 0.03); });
    }
    if(P.fins) [1, -1].forEach(function(sx){ B.t("carbon").at(body, "trim", COL.carbon, prof(T, [[0.3, 0], [-0.5, 0], [-0.55, 0.22], [-0.2, 0.18]], 0.012, 0.004), sx*0.42, S.top(zr) - 0.02, zr - 0.25); });
    if(P.fin) B.at(body, "paint", null, prof(T, [[0.4, 0], [-0.7, 0], [-0.75, 0.16], [0.0, 0.04]], 0.012, 0.004), 0, S.roof(S.zCr) - 0.03, S.zCr - 0.1);
    if(P.scoop) B.t("gloss").at(body, "trim", COL.black, sprof(T, [[0.25, 0], [-0.25, 0], [-0.2, 0.09], [0.15, 0.08]], 0.24, 0.02), 0, S.roof(S.zCr + 0.2) - 0.02, S.zCr + 0.2);
    if(P.periscope) B.t("gloss").at(body, "trim", COL.black, sprof(T, [[0.18, 0], [-0.25, 0], [-0.22, 0.07], [0.12, 0.06]], 0.22, 0.02), 0, S.roof(S.zCr + 0.1) - 0.03, S.zCr + 0.12);
    // the rear calipers (they never steer): on the body
    [1, -1].forEach(function(sx){ carCaliper(B, body, "trim", P.tr[2]*0.0127, twR, sx, P.cal, sx*(hw - 0.02 - twR/2), S.Rr, zr); });
  });
  B.lod = 0;
  // the doors: each a piece of the shell on a pivot at its front (paint skin inside and out, its pane, its mirror)
  if(hasDoors) [1, -1].forEach(function(sx){
    var pv = S.side(zD0, (vLo + vHi)/2, sx, 0).p, dn = B.node(root, sx > 0 ? "door-l" : "door-r", pv[0], pv[1], pv[2]);
    sidePatch(B, dn, "paint", null, S, zD0 - 0.006, zD1 + 0.006, vLo + 0.012, vHi - 0.008, 20, 24, 0.005, sx, pv);   // inset: its shut lines the dark opening
    var rows = [];
    for(var i = 0; i <= 6; i++){ var z = zD0 + (zD1 - zD0)*i/6, r = []; for(var j = 0; j <= 4; j++){ var q = S.side(z, vLo + (vHi - vLo)*j/4, sx, -0.03).p; r.push([q[0] - pv[0], q[1] - pv[1], q[2] - pv[2]]); } rows.push(r); }
    B.put(dn, "paint", gridOut(T, rows, [-sx, 0, 0]));
    // the pane: the greenhouse's side over the door
    var zB2 = zD1 + 0.03, gz = [], gr = [];
    for(var k = 0; k <= 10; k++){ var z2 = zB2 + (S.zA - zB2)*k/10; gz.push(z2); var rr2 = []; for(var m = 0; m <= 8; m++){ var a = sx > 0 ? 0.3*PI*m/8 : PI - 0.3*PI*(8 - m)/8, p2 = S.gh(z2, a, 0.003); rr2.push([p2[0] - pv[0], p2[1] - pv[1]]); } gr.push(rr2); }
    B.put(dn, "glass", loftG(T, gr, gz.map(function(z){ return z - pv[2]; }), false));
    // the handle (flush, body colour) and the mirror on its stalk
    var hp = S.side(zD1 + 0.18, 0.74, sx, 0.008).p; B.at(dn, "paint", null, rbox(T, 0.02, 0.025, 0.16, 0.01, 1), hp[0] - pv[0], hp[1] - pv[1], hp[2] - pv[2]);
    var my = S.top(S.zA - 0.1) + 0.07, mz = S.zA - 0.12, mx = sx*(S.half(mz)*0.97 + 0.07);
    B.at(dn, "paint", null, rodG(T, [sx*S.half(mz)*P.gw*0.98 - pv[0], my - 0.06 - pv[1], mz + 0.05 - pv[2]], [mx - sx*0.06 - pv[0], my - pv[1], mz - pv[2]], 0.018, 0.012, 6));
    B.at(dn, "paint", null, rbox(T, 0.16, 0.09, 0.09, 0.035, 2), mx - pv[0], my - pv[1], mz - pv[2], 0, sx*0.12, 0);
    B.at(dn, "glass", null, rbox(T, 0.14, 0.07, 0.01, 0.004, 1), mx - pv[0], my - pv[1], mz - 0.046 - pv[2], 0, sx*0.12, 0);
  });
  B.lod = 1;                                                                                 // far: the mirrors on the body
  [1, -1].forEach(function(sx){ var mz = S.zA - 0.12; B.at(body, "paint", null, rbox(T, 0.16, 0.09, 0.09, 0.035, 1), sx*(S.half(mz)*0.97 + 0.07), S.top(S.zA - 0.1) + 0.07, mz); });
  B.lod = 0;
  // inside: two seats, the dash, the cluster and screen, the console; the steering wheel (spin) before the driver (-x)
  var ys = gc + P.seat, zS = S.zA - Math.min(1.05, (S.zA - S.zCr)*(mid ? 0.62 : 0.66)), xd = -W*0.21, head = S.H - 0.04 - ys;
  var k = Math.max(0.55, Math.min(1.0, head/1.22)), riderK = 0.8*k, hb = Math.min(0.62, head*0.75), yb = S.top(S.zA);
  [xd, -xd].forEach(function(x){
    B.t("stitch").at(body, "trim", 0x2a2b2f, rbox(T, 0.48, 0.13, 0.5, 0.05, 2), x, ys - 0.06, zS);
    B.t("stitch").at(body, "trim", 0x2a2b2f, rbox(T, 0.46, hb, 0.12, 0.05, 2), x, ys + hb/2, zS - 0.28, -0.14);
    if(ys + hb + 0.16 < S.H - 0.03) B.at(body, "trim", COL.dark, rbox(T, 0.26, 0.14, 0.1, 0.04, 1), x, ys + hb + 0.09, zS - 0.3 - 0.13*(hb + 0.08));
  });
  B.t("plastic").at(body, "trim", COL.black, rbox(T, W*(mid ? 0.7 : 0.8), 0.14, 0.34, 0.05, 1), 0, yb - 0.04, S.zA - 0.14);
  B.t("gauges").at(body, "light", 0xffffff, rbox(T, 0.3, 0.09, 0.012, 0.004, 1), xd, yb + 0.06, S.zA - 0.27, -0.35);
  B.t("screen").at(body, "light", 0xffffff, rbox(T, 0.28, 0.13, 0.012, 0.004, 1), 0, yb + 0.07, S.zA - 0.22, -0.25);
  var cTop = Math.min(yb - 0.08, ys + 0.2), cLen = Math.max(0.3, S.zA - zS - 0.2);
  B.at(body, "trim", COL.dark, rbox(T, 0.17, Math.max(0.05, cTop - ys + 0.12), cLen, 0.03, 1), 0, (cTop + ys - 0.12)/2, zS + 0.02 + cLen/2);
  var col = new T.Group(); col.position.set(xd, ys + 0.42*k, zS + 0.36*k); col.rotation.x = -0.6; root.add(col);
  var spin = B.node(col, "spin");
  B.t("rubber").at(spin, "trim", COL.black, new T.TorusGeometry(0.155*k, 0.018, 6, 24), 0, 0, 0);
  B.at(spin, "trim", P.brand === "bmw" && P.diff ? COL.bmwBlue : COL.dark, rbox(T, 0.08, 0.07, 0.04, 0.015, 1), 0, 0, 0);
  [PI/2, -PI/2, PI].forEach(function(a){ B.at(spin, "trim", COL.dark, rbox(T, 0.03, 0.15*k, 0.016, 0.006, 1), Math.sin(a)*0.075*k, Math.cos(a)*0.075*k, 0, 0, 0, -a); });
  var gx = 0.155*k*Math.sin(1.05), gy = 0.155*k*Math.cos(1.05);
  anchor(T, spin, "a-grip-l", gx, gy, 0.02); anchor(T, spin, "a-grip-r", -gx, gy, 0.02);
  anchor(T, root, "a-foot-l", xd + 0.11, gc + 0.12, zS + 0.62*k); anchor(T, root, "a-foot-r", xd - 0.11, gc + 0.12, zS + 0.62*k);
  anchor(T, root, "a-seat", xd, ys, zS);
  // the wheels: the front ones in steer holders, their calipers on the holders
  var radii = [S.Rf, S.Rf, S.Rr, S.Rr];
  [[-1, zf, "steer-l"], [1, zf, "steer-r"], [-1, zr, null], [1, zr, null]].forEach(function(p, i){
    var front = i < 2, tw = front ? twF : twR, Rw = radii[i], xw = p[0]*(hw - 0.02 - tw/2);
    var h = B.node(root, p[2], xw, Rw, p[1]), PP = Object.assign({}, P, {rimIn: (front ? P.tf : P.tr)[2]});
    B.lod = 0; var w = carWheel2(B, h, "wheel-" + i, Rw, tw, p[0], PP, G, 0);
    if(front) carCaliper(B, h, "wheel", PP.rimIn*0.0127, tw, p[0], P.cal, 0, 0, 0);
    B.lod = 1; carWheel2(B, h, "wheel-" + i, Rw, tw, p[0], PP, G, 1); void w;
  });
  B.lod = 0;
  finish(T, root);
  return {g: root, meta: {kind: "car", R: S.Rr, radii: radii, lean: mid ? -0.04 : -0.08, riderK: riderK, plates: S.plates || [], door: dtype}};
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
  // [3.5.6] the glass tinted so the cabin reads through it ([3.39] less see-through: the cabin in shadow)
  return (st.mats = {
    trim: new T.MeshStandardMaterial({vertexColors: true, roughness: st.pbr ? 1 : 0.55, metalness: st.pbr ? 1 : 0.35, map: map, roughnessMap: st.pbr || null, metalnessMap: st.pbr || null}),
    wheel: new T.MeshStandardMaterial({vertexColors: true, roughness: st.pbr ? 1 : 0.62, metalness: st.pbr ? 1 : 0.4, map: map, roughnessMap: st.pbr || null, metalnessMap: st.pbr || null}),
    glass: new T.MeshStandardMaterial({color: 0x0e151c, metalness: 0.6, roughness: 0.04, transparent: true, opacity: 0.84, depthWrite: false}),   // ([3.39] darker: the cabin a shadow behind it)
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
    rig.meshes.concat(rig.lodMeshes || []).forEach(function(m){ if(m.userData.mk === "glass") m.material = gm; });
  } else rig.meshes.concat(rig.lodMeshes || []).forEach(function(m){ if(m.userData.mk === "glass") m.material = M.glass; });
  // the plate: its own text (the HQ's name stays the default where the page passes it), else the atlas plates show
  var txt = plateClean(t.plate);
  if(rig.plateMesh){
    if(txt){ var map = plateTex(T, txt); rig.plateOn = true; rig.plateMesh.visible = !rig.lod; if(rig.plateMesh.material.map !== map){ rig.plateMesh.material.map = map; rig.plateMesh.material.needsUpdate = true; } }
    else { rig.plateOn = false; rig.plateMesh.visible = false; }
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

/* [3.39] the doors on a built rig: rig.doors [{g, sx, f}], rig.doorType (doorType above)
     rig.setDoors(f, which)   poses them now: f 0 shut .. 1 open; which "driver" (default: -x, right-hand drive) or "both"
     rig.doorsPlay(dir, {calm, which}) -> seconds   opens the door(s), holds while you climb in ("in") or out ("out"), shuts
       them (the Regera's Autoskin opens both at once). Calm (Calm or reduced motion): no swing, they snap open, then shut.
     rig.doorTick(t)   steps it (t in s, default now); the doors' own meshes call it as they draw, so a parked car shuts
       its door with no frame hook of its own */
function nowS(){ return (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now())/1000; }
function doorRig(rig, type, get){
  var doors = [], anim = null;
  [["door-l", 1], ["door-r", -1]].forEach(function(d){ var g = get(d[0]); if(g) doors.push({g: g, sx: d[1], p0: g.position.clone(), f: 0}); });
  rig.doors = doors; rig.doorType = type;
  function pose(d, f){
    var P = doorPose(type, f, d.sx); d.f = Math.max(0, Math.min(1, f));
    d.g.position.set(d.p0.x + P[0], d.p0.y + P[1], d.p0.z + P[2]); d.g.rotation.set(P[3], P[4], P[5], "YXZ");
  }
  function sel(which){ return doors.filter(function(d){ return which === "both" || type === "autoskin" || d.sx < 0; }); }
  rig.setDoors = function(f, which){ anim = null; sel(which).forEach(function(d){ pose(d, +f || 0); }); };
  rig.doorTick = function(t){
    if(!anim) return false;
    var a = anim, u = (t == null ? nowS() : t) - a.t0, f;
    if(u >= a.open*2 + a.hold){ f = 0; anim = null; }
    else if(a.calm) f = 1;
    else f = u < a.open ? u/a.open : u < a.open + a.hold ? 1 : 1 - (u - a.open - a.hold)/a.open;
    a.list.forEach(function(d){ pose(d, f); });
    return true;
  };
  rig.doorsPlay = function(dir, o){
    o = o || {};
    if(!doors.length || type === "none") return 0;
    var open = DOOR_S[type] || 0.5, hold = dir === "out" ? 0.55 : 0.5;
    anim = {t0: nowS(), open: open, hold: hold, calm: !!o.calm, list: sel(o.which)};
    rig.doorTick(anim.t0);
    return open*2 + hold;
  };
  doors.forEach(function(d){
    d.g.traverse(function(m){ if(m.isMesh) m.onBeforeRender = function(){ if(anim && rig.doorTick()) d.g.updateMatrixWorld(true); }; });
  });
}
/* [4.0] level of detail: every catalogue rig carries two sets of meshes, LOD 0 (near: the full model, rig.meshes) and LOD 1
   (far: the same body from a coarse loft, drum wheels, flat lamps; rig.lodMeshes, hidden). rig.setLod(0 | 1) picks one;
   by itself the rig switches as it draws: past LOD_FAR m from the camera to LOD 1, back inside LOD_NEAR m (a bike's
   nearer). rig.lodLock = true holds the current one (a showroom close-up). */
var LOD_D = {car: [26, 32], bike: [16, 20]};
function lodRig(T, rig, car){
  var D = LOD_D[car ? "car" : "bike"], v = new T.Vector3(), c = new T.Vector3();
  rig.setLod = function(l){
    l = l && rig.lodMeshes.length ? 1 : 0; rig.lod = l;
    rig.meshes.forEach(function(m){ if(m.userData.mk !== "plate" || rig.plateOn) m.visible = !l; });
    rig.lodMeshes.forEach(function(m){ m.visible = !!l; });
    return rig;
  };
  var hook = function(r, sc, cam){
    if(!cam || cam.isOrthographicCamera || rig.lodLock || !rig.lodMeshes.length) return;
    rig.g.getWorldPosition(v); c.setFromMatrixPosition(cam.matrixWorld);
    var dd = v.distanceTo(c);
    if(!rig.lod && dd > D[1]) rig.setLod(1); else if(rig.lod && dd < D[0]) rig.setLod(0);
  };
  rig.meshes.concat(rig.lodMeshes).forEach(function(m){ if(m.userData.mk === "paint" && m.parent && m.parent.name === "body") m.onBeforeRender = hook; });
}
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
  var pm = new (T.MeshPhysicalMaterial || T.MeshStandardMaterial)({color: paintOf(entry, paint), metalness: 0.55, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.08});
  pm.userData.paint = true;
  var tail = new T.MeshBasicMaterial({vertexColors: true, color: 0x8c8c8c, map: atlasTex(T, store(T))});
  var meshes = [], far = [];
  g.traverse(function(o){
    if(!o.isMesh) return;
    var mk = o.userData.mk; (o.userData.lod ? far : meshes).push(o);
    o.material = mk === "paint" ? pm : mk === "tail" ? tail : M[mk] || M.trim;
  });
  function get(n){ return g.getObjectByName(n); }
  var car = bp.meta.kind === "car", on = null, lit = false;
  var rig = {
    g: g, entry: entry, dims: B.d, scale: B.k, kind: bp.meta.kind, paint: pm, standin: get("body"), meshes: meshes, lodMeshes: far, lod: 0,
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
  if(bp.meta.seats) rig.seats = bp.meta.seats;
  lodRig(T, rig, car);
  doorRig(rig, bp.meta.door || "none", get);
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

// [4.0] lod 1: the far set
function triangles(rig, lod){ var t = 0; ((lod ? rig.lodMeshes : rig.meshes) || []).forEach(function(m){ var g = m.geometry; t += (g.index ? g.index.count : g.attributes.position.count)/3; }); return Math.round(t); }
function drawCalls(rig, lod){ return ((lod ? rig.lodMeshes : rig.meshes) || []).length; }
function clearCache(T){ var BP = store(T).bp; Object.keys(BP).forEach(function(k){ BP[k].bp.g.traverse(function(o){ if(o.isMesh) o.geometry.dispose(); }); delete BP[k]; }); }

HQV.hqVehicleModels = {build: build, dims: dims, shown: shown, scaleOf: scaleOf, SCALE: SCALE, styleOf: styleOf, triangles: triangles, drawCalls: drawCalls, clearCache: clearCache,
                       DIMS: DIMS, CAR: CAR, BIKE: BIKE,
                       // [3.13] tuning: the geometry a tune picks (sameGeo: can setTune apply it live?), a starter's tune
                       geoOf: geoOf, geoSig: geoSig, sameGeo: function(a, b, kind){ return geoSig(geoOf(a, kind)) === geoSig(geoOf(b, kind)); },
                       tuneStarter: tuneStarter, plateClean: plateClean, FINISH: FINISH};
})();
