/* Claude HQ: handling from a vehicle's real specs (HQV.hqVehiclePhys), docs/plans/dealership-spec.md.
 *
 * Pure (tests/test_hqvehiclephys.py runs it under node): no THREE, no DOM, no clock.
 *   derive(entry) -> V   a games/hq3d.js VEHICLES entry for a catalogue vehicle (games/hqvehicles.json):
 *     top (m/s), acc (m/s² from a standstill), rev, lean, box, motor, gears (m/s where each gear tops out),
 *     eng (a games/engine.js voice), slide (the powerslide, as hq3d's car and moto) and, new:
 *     floor (how much pull is left near the top: hq3d pulls acc*max(floor, 1 - v/top); an electric
 *     motor keeps more), brake (m/s² on the brakes), roll (rad of body roll at full lock and speed),
 *     drive, mass (kg), grip (0..1 launch grip), slip (0..1 how readily the tail steps out), kind.
 *   accFor(top, t0100, floor) -> acc   the acc that reaches 100 km/h in t0100 s under hq3d's pull curve
 *   t0100(top, acc, floor) -> s        the other way round (Infinity when 100 km/h is past `top`)
 *   estimate0100(spec, kind) -> s      from power-to-weight when the maker gives no figure
 *   voiceFor(spec, kind) -> name       the engine voice for a layout
 * entry = {kind: "car"|"bike", type: "sedan"|"coupe"|"suv"|"hatch"|"pickup"|"hyper"|"super"|"naked"|"sport"|
 *          "adventure"|"cruiser"|"scooter"|"dirt", spec: {cc, cyl, layout, aspiration, electric, powerKw,
 *          torqueNm, massKg, drive, topKmh, zeroTo100s, gears}, dims: {lengthM, widthM, heightM, wheelbaseM},
 *          sound (optional: a voice name that overrides voiceFor)}
 * Real figures go in; the game's caps (CAP_KMH) keep a hypercar inside a city.
 */
(function(){
var HQV = (typeof window !== "undefined" ? window : globalThis).HQV = (typeof window !== "undefined" ? window : globalThis).HQV || {};

var V100 = 100/3.6;                                   // m/s
var CAP_KMH = {car: 300, bike: 280};                  // the game's top speed caps (the spec's)
var FLOOR = 0.25, FLOOR_EV = 0.45;                    // pull left near the top: hq3d's 0.25; a motor keeps more
var RIDER_KG = 75;                                    // a bike's figures are without its rider
// A powerslide by drivetrain, as hq3d's: from `min` m/s, turning `turn` times as hard, the tail letting go
// with `grip`/s, at most `max` rad sideways, bleeding `bleed` m/s² at full slip. RWD is today's car.
var SLIDE = {
  rwd: {min: 7, turn: 1.3,  grip: 2.2, max: 0.62, bleed: 3.4},
  awd: {min: 8, turn: 1.2,  grip: 3.0, max: 0.42, bleed: 3.8},
  fwd: {min: 9, turn: 1.12, grip: 3.6, max: 0.28, bleed: 4.2},
  bike: {min: 8, turn: 1.35, grip: 3.2, max: 0.32, bleed: 3}
};
var SLIP = {rwd: 0.8, awd: 0.35, fwd: 0.2};           // how readily the tail steps out
var GRIP = {rwd: 0.75, awd: 1, fwd: 0.7};             // launch grip
var LAUNCH = {rwd: 2.7, awd: 2.2, fwd: 4.2, bike: 2.6};   // s: the quickest 0-100 its tyres allow
// how far a bike leans into a turn, by type (the starter motorbike is a naked: hq3d's 0.42)
var LEAN = {naked: 0.42, sport: 0.5, adventure: 0.34, cruiser: 0.3, scooter: 0.36, dirt: 0.4};
// body roll by type (rad at full lock and speed); hq3d's starter car has none
var ROLL = {hatch: 0, sedan: 0.035, coupe: 0.025, hyper: 0.015, super: 0.018, suv: 0.075, pickup: 0.08};
var BRAKE = 14;                                       // m/s², hq3d's

function clamp(x, a, b){ return x < a ? a : x > b ? b : x; }
function num(x, d){ x = +x; return isFinite(x) ? x : d; }

// Time from a standstill to `v` under hq3d's pull, acc*max(floor, 1 - u/top): exponential until the pull
// reaches `floor`, constant after. Infinity when `v` is past the top speed.
function timeTo(v, top, acc, floor){
  if(v >= top) return Infinity;
  var vk = top*(1 - floor);                           // where the pull bottoms out
  if(v <= vk) return -(top/acc)*Math.log(1 - v/top);
  return -(top/acc)*Math.log(floor) + (v - vk)/(acc*floor);
}
function t0100(top, acc, floor){ return timeTo(V100, top, acc, floor == null ? FLOOR : floor); }
// The acc giving 0 -> `v` in `t` s (timeTo scales as 1/acc).
function accFor(top, t, floor, v){ return timeTo(v == null ? V100 : v, top, 1, floor == null ? FLOOR : floor)/t; }

// 0-100 km/h from power-to-weight (a fit through a light hatch, an M3 and a superbike), never quicker than
// its tyres allow
function estimate0100(spec, kind){
  var kg = num(spec.massKg, kind === "bike" ? 180 : 1500) + (kind === "bike" ? RIDER_KG : 0);
  var kw = Math.max(5, num(spec.powerKw, 60)), drive = kind === "bike" ? "bike" : (spec.drive || "rwd");
  return Math.max(LAUNCH[drive] || 2.7, 0.915*Math.pow(kg/kw, 0.95));
}

function voiceFor(spec, kind){
  spec = spec || {};
  if(spec.electric) return "electric";
  var cyl = num(spec.cyl, 0), lay = String(spec.layout || "").toLowerCase();
  if(kind === "bike"){
    if(cyl <= 1 || lay === "single") return "single";
    if(/boxer/.test(lay)) return "boxer";
    if(/v/.test(lay) && cyl === 2) return "vtwin";
    if(cyl === 2) return "twin";
    return "four";
  }
  if(lay === "w16" || (cyl >= 16 && /w/.test(lay))) return "w16";
  if(cyl >= 16) return "v16";
  var turbo = /turbo/.test(String(spec.aspiration || "").toLowerCase());   // a turbo car: its whistle and blow-off
  if(cyl >= 12) return "v12";                                              // [3.9] a V12 (the Revuelto, the Countach)
  if(cyl >= 10) return "v10";                                              // a V10 (the Huracán)
  if(cyl >= 8) return turbo ? "v8tt" : "v8";
  if(cyl >= 6) return turbo ? "turbo6" : "six";
  if(/boxer/.test(lay)) return "boxer";
  return turbo ? "turbo4" : "four";
}

// Where each gear tops out, as hq3d's starters: top*1.045*(i/n)^p (cars 0.95, bikes 0.84); one gear for a motor
function gearsFor(top, n, kind, electric){
  if(electric) return [Math.round(top*1.045*10)/10];
  n = clamp(Math.round(num(n, 5)), 1, 8);
  var p = kind === "bike" ? 0.84 : 0.95, G = [];
  for(var i = 1; i <= n; i++) G.push(Math.round(top*1.045*Math.pow(i/n, p)*10)/10);
  return G;
}

function derive(entry){
  entry = entry || {};
  var kind = entry.kind === "bike" ? "bike" : "car", spec = entry.spec || {}, dims = entry.dims || {};
  var type = entry.type || (kind === "bike" ? "naked" : "hatch"), electric = !!spec.electric;
  var drive = kind === "bike" ? "rwd" : (spec.drive === "fwd" || spec.drive === "awd" ? spec.drive : "rwd");
  var topU = num(spec.topKmh, kind === "bike" ? 150 : 170)/3.6;            // the real top speed
  var top = Math.min(topU, CAP_KMH[kind]/3.6);
  var floor = electric ? FLOOR_EV : FLOOR;
  var t = num(spec.zeroTo100s, 0) > 0 ? +spec.zeroTo100s : estimate0100(spec, kind);
  // acc from the real 0-100 on the game's (capped) top speed; a car that cannot reach 100 km/h is timed to 85% of its
  // top, scaled from its 0-100 (the starters)
  var acc;
  if(topU > V100*1.02) acc = accFor(top, t, floor);
  else { var vr = topU*0.85; acc = accFor(topU, t*vr/V100, floor, vr); }
  var mass = num(spec.massKg, kind === "bike" ? 180 : 1500);
  var L = num(dims.lengthM, kind === "bike" ? 1.9 : 3.95), W = num(dims.widthM, kind === "bike" ? 0.8 : 1.65);
  var V = {
    kind: kind, type: type, drive: kind === "bike" ? "rwd" : drive, mass: mass,
    top: Math.round(top*100)/100, acc: Math.round(acc*100)/100, rev: kind === "bike" ? 3 : 5,
    lean: kind === "bike" ? (LEAN[type] != null ? LEAN[type] : 0.42) : 0,
    box: [kind === "bike" ? 0 : Math.round(W*0.4*100)/100, Math.round(L*0.42*100)/100],
    motor: true, gears: gearsFor(top, spec.gears, kind, electric),
    eng: entry.sound || voiceFor(spec, kind),
    floor: floor,
    // heavier stops longer: 14 m/s² up to 1.6 t, down to 11 at 2.8 t (a bike with its rider: 14)
    brake: kind === "bike" ? BRAKE : Math.round(clamp(BRAKE - (mass - 1600)/400, 11, BRAKE)*10)/10,
    roll: kind === "bike" ? 0 : (ROLL[type] != null ? ROLL[type] : 0.03),
    grip: kind === "bike" ? 0.8 : GRIP[drive], slip: kind === "bike" ? 0.5 : SLIP[drive]
  };
  var S = SLIDE[kind === "bike" ? "bike" : drive];
  V.slide = {min: S.min, turn: S.turn, grip: S.grip, max: S.max, bleed: S.bleed};
  return V;
}

HQV.hqVehiclePhys = {derive: derive, accFor: accFor, t0100: t0100, timeTo: timeTo, estimate0100: estimate0100,
                     voiceFor: voiceFor, gearsFor: gearsFor, CAP_KMH: CAP_KMH, SLIDE: SLIDE, LEAN: LEAN, ROLL: ROLL,
                     FLOOR: FLOOR, FLOOR_EV: FLOOR_EV};
})();
