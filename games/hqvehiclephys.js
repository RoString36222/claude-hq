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
 *   engineFor(spec, kind, voice, gears) -> E   its real revs and gearing (spec.engine, researched per vehicle; the voice's
 *                                     typical revs where a figure is missing): {idle, red, limit, k (rpm per m/s in each
 *                                     gear, from the gear ratios, primary and final drive and the rear tyre; else from
 *                                     `gears`), shiftUp, launch, electric, motorMax, cyl, tone} (tone: the exhaust's
 *                                     depth, rasp, crackle, induction, whistle, 0..1, for games/engine.js)
 *   tyreCirc("190/55 ZR17") -> m       a tyre's rolling circumference (3% squat under load)
 *   gearState(E) -> G / gearStep(G, inp, E, dt) -> out   the gearbox and clutch, per frame (games/hq3d.js drives on it):
 *     inp = {thr 0..1, brake (S held), clutch (X held), up / down / toggle (a press this frame: . , G), speed (m/s,
 *     signed)}. G.manual: you shift (. up, , down, through neutral below 1st); else it shifts itself at the redline
 *     under power, half way up the revs when cruising, and down as the revs sag. A downshift is rev-matched (the
 *     revs jump to the lower gear's, a throttle blip), refused if it would over-rev; each gear tops out at its
 *     limiter (out.cap: you bounce off it, the speed held). The clutch in (or neutral, or mid-shift) frees the
 *     engine: W revs it to the limiter; let it out with the revs up at low speed and it launches with wheelspin.
 *     Automatic: brake and throttle together at a standstill hold the revs for a launch. Off the throttle the
 *     engine brakes harder in a lower gear. With a quickshifter (E.qs) an upshift under power is a 50 ms ignition
 *     cut (event "qs"): the drive barely drops, no clutch, no lift; without one a manual upshift takes 0.18 s.
 *     out = {rpm, gear (-1 R, 0 N, 1..n), manual, drive (0..1.8 on the engine's pull), cap (m/s), engineBrake
 *            (m/s^2), limiter, slip (0..1 wheelspin), launch (held at a standstill), events: ["up", "down",
 *            "refused", "manual", "auto", "launch"]}
 * entry = {kind: "car"|"bike", type: "sedan"|"coupe"|"suv"|"hatch"|"pickup"|"hyper"|"super"|"naked"|"sport"|
 *          "adventure"|"cruiser"|"scooter"|"dirt"|"classic"|"hypersport"|"formula" ([3.17] an F1 car), spec: {cc, cyl, layout, aspiration, electric, powerKw,
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
var LEAN = {naked: 0.42, sport: 0.5, adventure: 0.34, cruiser: 0.3, scooter: 0.36, dirt: 0.4, classic: 0.36, hypersport: 0.48};
// body roll by type (rad at full lock and speed); hq3d's starter car has none
var ROLL = {hatch: 0, sedan: 0.035, coupe: 0.025, hyper: 0.015, super: 0.018, suv: 0.075, pickup: 0.08, formula: 0};
// [3.17] an F1 car (docs/plans/grand-prix-spec.md): downforce and slicks. It barely slides, launches on every bit of
// its grip, stops in a car length and does not roll; still capped at the city's 300 km/h like every car.
var FORMULA = {grip: 1, slip: 0.12, brake: 19, slide: {min: 11, turn: 1.12, grip: 4.6, max: 0.16, bleed: 4.8}};
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
    // [3.9] specific output (kW per litre) tells a lazy long-stroke single or 270-degree twin from a revvy one
    var kwl = num(spec.powerKw, 0)*1000/Math.max(1, num(spec.cc, 1000));
    if(cyl <= 1 || lay === "single") return kwl > 0 && kwl < 60 ? "longstroke" : "single";
    if(/supercharg/.test(String(spec.aspiration || "").toLowerCase())) return "supercharged";
    if(/boxer/.test(lay)) return "boxer";
    if(/v/.test(lay) && cyl === 2) return /45/.test(lay) ? "vtwin45" : "vtwin";
    if(cyl === 2) return kwl > 0 && kwl < 65 ? "twin270" : "twin";
    if(cyl === 3) return "triple";
    if(/^v/.test(lay) && cyl === 4) return "v4";
    if(/crossplane/.test(lay)) return "crossplane";
    return "four";
  }
  if(lay === "w16" || (cyl >= 16 && /w/.test(lay))) return "w16";
  if(cyl >= 16) return "v16";
  var turbo = /turbo/.test(String(spec.aspiration || "").toLowerCase());   // a turbo car: its whistle and blow-off
  if(cyl >= 12) return "v12";                                              // [3.9] a V12 (the Revuelto, the Countach)
  if(cyl >= 10) return "v10";                                              // a V10 (the Huracán)
  if(cyl >= 8) return turbo ? "v8tt" : "v8";
  if(cyl === 6 && lay === "v6" && turbo) return "v6";                     // [3.17] the F1 turbo-hybrid V6
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

// a voice's typical idle and redline (games/engine.js ENGINES), where the research found no figure
var ENGINE_VOICES = {single: 1, twin: 1, vtwin: 1, boxer: 1, four: 1, v4: 1, triple: 1, crossplane: 1, supercharged: 1, longstroke: 1,
                     twin270: 1, vtwin45: 1, turbo4: 1, turbo6: 1, v8tt: 1, v8: 1, six: 1, v10: 1, v12: 1, w16: 1, v16: 1, electric: 1};
var REVS = {single: [1500, 10500], twin: [1300, 10200], vtwin: [1250, 10000], boxer: [1050, 9000], four: [1200, 14000],
            v4: [1250, 14500], triple: [1150, 12650], crossplane: [1350, 13800], supercharged: [1100, 12500],
            longstroke: [800, 6100], twin270: [1050, 7250], vtwin45: [850, 5500], turbo4: [800, 6500], turbo6: [700, 7000],
            v8tt: [650, 7200], v8: [700, 6200], six: [750, 7400], v10: [1000, 8500], v12: [950, 9500], w16: [900, 6700],
            v16: [1000, 9000], turbo: [850, 6800], v6: [4000, 12000], bike: [1400, 11500], electric: [0, 16000]};   // [3.17] v6: the F1 turbo-hybrid
function tyreCirc(t){
  var m = /(\d{2,3})\s*\/\s*(\d{2,3})\s*[A-Z]*\s*-?\s*R?\s*(\d{2}(?:\.\d)?)/i.exec(String(t || ""));   // 190/55 ZR17, 120/80-18
  if(!m) return null;
  var d = (+m[3])*0.0254 + 2*(+m[1])*(+m[2])/100/1000;
  return Math.PI*d*0.97;
}
function engineFor(spec, kind, voice, gears){
  spec = spec || {};
  var R = spec.engine || {}, base = REVS[voice] || REVS[kind === "bike" ? "four" : "turbo6"], electric = !!spec.electric || voice === "electric";
  var E = {electric: electric, cyl: num(spec.cyl, 0) || null, tone: R.tone || null};
  if(electric){
    E.idle = 0; E.motorMax = num(R.motorMax, 16000); E.red = E.motorMax; E.limit = E.motorMax; E.k = null; E.shiftUp = Infinity; E.launch = 0;
    return E;
  }
  E.idle = num(R.idle, base[0]);
  var red = num(R.red, null), lim = num(R.limit, null);
  if(red == null && lim != null) red = lim - (kind === "bike" ? 400 : 250);
  if(red == null) red = num(R.power, 0) > 0 ? Math.round(R.power*1.06/100)*100 : base[1];
  if(lim == null) lim = red + (kind === "bike" ? 400 : 250);
  E.red = red; E.limit = Math.max(lim, red);
  // rpm per m/s in each gear: engine turns = wheel turns x primary x gear x final
  var circ = tyreCirc(R.tyre), ratios = Array.isArray(R.ratios) && R.ratios.length ? R.ratios.filter(function(r){ return +r > 0; }) : null;
  if(circ && ratios && ratios.length){
    var pr = num(R.primary, 1), fd = num(R.final, 1);
    E.k = ratios.map(function(r){ return Math.round(60*pr*r*fd/circ*1000)/1000; });
  } else if(gears && gears.length) E.k = gears.map(function(v){ return Math.round(E.red/Math.max(1, v)*1000)/1000; });
  else E.k = null;
  E.shiftUp = Math.round(E.red*0.97);
  E.launch = Math.round(E.idle + (E.red - E.idle)*(kind === "bike" ? 0.3 : 0.28));
  // a quickshifter (spec.engine.qs, else: a sporty bike of 70 kW or more, or a car with a 7+ speed DCT / automatic):
  // upshifts under power with a 50 ms ignition cut, no clutch, no lift
  var gears = num(spec.gears, 0);
  E.qs = typeof R.qs === "boolean" ? R.qs : kind === "bike" ? num(spec.powerKw, 0) >= 70 : gears >= 7;
  return E;
}

// The automatic's choice: the gear for what the driver is doing. Flat out (thr > 0.85): the lowest gear below the shift
// point (the most power: up at the redline, a kickdown skips straight down). Part throttle: the gear whose revs come
// closest to a target that rises with the pedal. Braking: revs kept in the pulling band (a downshift at a time, ready
// for the exit). Coasting: a relaxed band. A gear is a candidate only between 1.05 x idle and the shift point; with a
// comfort margin (6% of the rev range) the current gear is kept rather than hunting.
// Drive modes (Shift+G): how high the automatic holds the revs (want), where it shifts flat out (shift, of the shift
// point), how fast a shift is (shiftT), and the exhaust (gain, pops: games/engine.js). Sport is the car as it comes.
var MODES = {
  comfort: {label: "Comfort", want: 0.75, shift: 0.82, shiftT: 1.4, gain: 0.82, pops: 0.15},
  sport:   {label: "Sport",   want: 1,    shift: 1,    shiftT: 1,   gain: 1,    pops: 1},
  track:   {label: "Track",   want: 1.2,  shift: 1,    shiftT: 0.6, gain: 1.15, pops: 1.6}
};
var MODE_ORDER = ["comfort", "sport", "track"];
function modeOf(m){ return MODES[m] || MODES.sport; }
function autoGear(E, K, v, thr, brake, mode){
  var n = K.length, span = E.red - E.idle, best = 1, bd = Infinity, i, M = modeOf(mode), top = E.shiftUp*M.shift;
  function rpm(g){ return v*K[g - 1]; }
  if(thr > 0.85){
    for(i = 1; i <= n; i++) if(rpm(i) <= top*0.995) return i;
    return n;
  }
  var want = E.idle + span*Math.min(0.85, M.want*(thr > 0.05 ? 0.2 + 0.45*thr : brake ? 0.45 : 0.22));
  var lo = E.idle*1.05, hi = E.shiftUp*(thr > 0.05 || brake ? 0.92 : 0.8);
  for(i = 1; i <= n; i++){
    var r = rpm(i); if(r > hi) continue;
    var d = Math.abs(r - want) + (r < lo ? span : 0);
    if(d < bd - 1e-9){ bd = d; best = i; }
  }
  return best;
}
/* Nitrous (K held): a 4 s charge that refills in about 16 s. N = {charge 0..1}; -> true while it fires. */
function nitroStep(N, held, thr, speed, dt){
  dt = Math.max(0, Math.min(0.1, +dt || 0));
  if(N.charge <= 0.001) N.dry = true; else if(N.charge >= 0.15) N.dry = false;   // run dry: it waits for 15% back
  var on = !!held && thr > 0.3 && speed > 2 && !N.dry;
  N.charge = Math.max(0, Math.min(1, N.charge + (on ? -0.25 : 0.06)*dt));
  N.on = on;
  return on;
}
/* The performance timer: from a standstill it times 0-100 km/h, 0-200 km/h and the quarter mile (402.3 m, with the speed
   at the line). P = {}; -> [{kind: "0-100" | "0-200" | "quarter", t (s), v? (m/s)}] when one is reached. Stopping again
   (or reversing) re-arms it; a run that slows below half its best speed is abandoned. */
function perfStep(P, speed, dt){
  dt = Math.max(0, Math.min(0.1, +dt || 0)); var v = +speed || 0, out = [];
  if(v < 0.3){ if(v > -0.3){ P.armed = true; P.run = false; } return out; }
  if(P.armed && !P.run){ P.run = true; P.t = 0; P.d = 0; P.vmax = 0; P.got = {}; P.armed = false; }
  if(!P.run) return out;
  P.t += dt; P.d += v*dt; P.vmax = Math.max(P.vmax, v);
  if(!P.got["0-100"] && v >= 100/3.6){ P.got["0-100"] = 1; out.push({kind: "0-100", t: P.t}); }
  if(!P.got["0-200"] && v >= 200/3.6){ P.got["0-200"] = 1; out.push({kind: "0-200", t: P.t}); }
  if(!P.got.quarter && P.d >= 402.3){ P.got.quarter = 1; out.push({kind: "quarter", t: P.t, v: v}); P.run = false; }
  if(P.run && v < P.vmax*0.5) P.run = false;
  return out;
}
/* Wheelies and stoppies on a motorbike (F held). W = {p (rad: + front up, - rear up), pv, dist, kind}; inp = {trick,
   thr 0..1, brake, speed (m/s), gear, rpmFrac (rpm/redline)}. A wheelie lifts with the throttle in a low gear and the
   revs up and balances near BAL; past LOOP it loops out (a bail). A stoppie lifts the rear under hard braking above
   STOPPIE_V; past OVER it goes over the bars (a bail). Calm: none. -> {events: [{kind: "start"|"end"|"bail", trick,
   dist}]} with W.p to draw. */
var BAL = 1.05, LOOP = 1.38, OVER = -0.78, STOPPIE_V = 4;
function wheelieStep(W, inp, dt){
  dt = Math.max(0, Math.min(0.1, +dt || 0)); inp = inp || {};
  var ev = [], thr = clamp(+inp.thr || 0, 0, 1), v = Math.abs(+inp.speed || 0), was = W.kind || null;
  var low = (inp.gear | 0) <= 1 ? 1 : (inp.gear | 0) === 2 ? 0.85 : (inp.gear | 0) === 3 ? 0.55 : 0.3, k = 1 - Math.exp(-dt*7);
  var power = low*(0.45 + 0.55*clamp(+inp.rpmFrac || 0, 0, 1));
  if(inp.trick && inp.brake && v > STOPPIE_V && W.p <= 0.05){
    // the rear rises toward a height set by the speed; over 20 m/s it keeps going: over the bars
    var tgt = v > 20 ? OVER - 0.2 : -Math.min(0.62, 0.12 + v/26);
    W.pv += ((tgt - W.p)*5 - W.pv)*k;
  } else if(inp.trick && thr > 0.25 && v > 0.8 && W.p >= -0.05){
    // up to the balance point quickly, then the throttle keeps creeping it past: feather it (tap W) to hold it there
    var want = W.p < BAL*0.92 ? 2.4*power*thr : 0.1*thr*power + (W.p > BAL ? 0.07 : 0);
    W.pv += (want - W.pv)*k;
  } else if(inp.trick && W.p > 0){
    W.pv += (-1.1 - W.pv)*k;                                            // off the throttle with F held: it settles slowly
  } else if(Math.abs(W.p) < 0.01){ W.p = 0; W.pv = 0; }               // on both wheels
  else {
    W.pv += ((W.p > 0 ? -3.2 : 3.2)*Math.min(1, Math.abs(W.p)*3 + 0.2) - W.pv)*k;   // back down on both wheels
  }
  var p0 = W.p; W.p += W.pv*dt;
  if(p0*W.p < 0 && !(inp.trick && (W.p < 0 ? inp.brake : thr > 0.25))){ W.p = 0; W.pv = 0; }   // it lands on both wheels, no bounce into the other trick
  if(W.p < 0.002 && W.p > -0.002 && !inp.trick){ W.p = 0; W.pv = 0; }
  if(was === null && W.p > 0.12){ W.kind = "wheelie"; W.dist = 0; ev.push({kind: "start", trick: "wheelie"}); }
  else if(was === null && W.p < -0.1){ W.kind = "stoppie"; W.dist = 0; ev.push({kind: "start", trick: "stoppie"}); }
  if(W.kind) W.dist += v*dt;
  if(W.p > LOOP || W.p < OVER){
    ev.push({kind: "bail", trick: W.kind || (W.p > 0 ? "wheelie" : "stoppie"), dist: W.dist || 0});
    W.p = 0; W.pv = 0; W.kind = null; W.dist = 0;
  } else if(W.kind && ((W.kind === "wheelie" && W.p < 0.05) || (W.kind === "stoppie" && W.p > -0.04))){
    ev.push({kind: "end", trick: W.kind, dist: W.dist});
    W.kind = null;
    if(W.p < 0) { W.p = Math.max(W.p, -0.04); }
  }
  if(W.p < 0 && v < 0.5){ W.pv = 3; }                                  // a stoppie never sticks at a standstill
  return {events: ev, p: W.p};
}
function gearState(E){ return {gear: 1, rpm: E && E.idle || 900, shiftT: 0, manual: false, clutchWas: false, launchT: 0, slip0: 0, held: false}; }
function gearStep(G, inp, E, dt){
  inp = inp || {}; dt = Math.max(0, Math.min(0.1, +dt || 0));
  var thr = clamp(+inp.thr || 0, 0, 1), sp = +inp.speed || 0, v = Math.abs(sp), ev = [];
  var out = {rpm: G.rpm, gear: G.gear, manual: G.manual, qs: !!(E && E.qs), drive: 1, cap: Infinity, engineBrake: 0, limiter: false, slip: 0, launch: false, events: ev};
  if(!E) return out;
  if(E.electric){                                         // one gear: revs with the road speed, no clutch, no limiter
    G.gear = sp < -0.3 ? -1 : 1; G.rpm = E.motorMax*clamp(v/Math.max(1, inp.top || 60), 0, 1);
    out.rpm = G.rpm; out.gear = G.gear; out.engineBrake = thr < 0.05 ? 1.2 : 0; return out;
  }
  var K = E.k, n = K ? K.length : 0; if(!n) return out;
  if(inp.toggle){ G.manual = !G.manual; ev.push(G.manual ? "manual" : "auto"); if(!G.manual && G.gear < 1) G.gear = 1; }
  function at(g){ return v*K[Math.max(0, Math.min(n, g) - 1)]; }
  G.shiftT = Math.max(0, G.shiftT - dt);
  var g = G.gear | 0;
  if(G.manual){
    if(inp.up && g < n){ var qs = E.qs && thr > 0.4 && g > 0; g = g + 1; G.shiftT = qs ? 0.05 : 0.18; ev.push("up"); if(qs) ev.push("qs"); }
    else if(inp.down){
      if(g > 1 && at(g - 1) > E.limit*0.99) ev.push("refused");            // it would over-rev: the box says no
      else if(g > 1){ g--; G.shiftT = 0.14; G.blipTo = at(g); ev.push("down"); }
      else if(g === 1){ g = 0; ev.push("down"); }                         // below 1st: neutral
    }
  } else {
    if(g < 1) g = 1;
    G.since = (G.since || 0) + dt;
    if(sp < 0 || v < 1.2){ if(g !== 1 && G.shiftT <= 0){ g = 1; G.since = 0; } }
    else if(G.shiftT <= 0){
      var M = modeOf(inp.mode), tg = autoGear(E, K, v, thr, !!inp.brake, inp.mode), cur = at(g);
      if(tg !== g && thr <= 0.85 && cur < E.shiftUp*0.92 && cur > E.idle*1.05){
        // keep this gear unless the other is clearly better (no hunting between two close gears)
        var span = E.red - E.idle, want = E.idle + span*Math.min(0.85, M.want*(thr > 0.05 ? 0.2 + 0.45*thr : inp.brake ? 0.45 : 0.22));
        if(Math.abs(at(tg) - want) > Math.abs(cur - want) - span*0.06) tg = g;
      }
      if(cur >= E.shiftUp*(thr > 0.85 ? M.shift : 1) && g < n){   // never sit on the limiter (Comfort shifts early): up now
        tg = Math.max(tg, g + 1);
      }
      if(tg > g && (G.since >= 0.45 || cur >= E.shiftUp)){
        var aq = E.qs && thr > 0.4; g++; G.shiftT = aq ? 0.05 : 0.25*M.shiftT; G.since = 0; ev.push("up"); if(aq) ev.push("qs");
      } else if(tg < g && (G.since >= (thr > 0.85 ? 0.12 : 0.3))){
        // a kickdown drops straight to the gear it wants; otherwise one gear at a time, each rev-matched
        var to = thr > 0.85 ? tg : g - 1;
        g = to; G.shiftT = 0.18; G.since = 0; G.blipTo = at(g); ev.push("down");
      }
    }
  }
  G.gear = g;
  // the clutch: held, in neutral, or for the moment of a shift the engine turns free of the wheels
  var free = !!inp.clutch || g === 0 || G.shiftT > 0.06, rpm = G.rpm;
  // automatic launch control: brake and throttle at a standstill hold the revs up, the car held
  var hold = !G.manual && inp.brake && thr > 0.3 && v < 0.6;
  if(hold){ free = true; out.launch = true; if(!G.held) ev.push("launch"); }
  if(free){
    // a downshift blips the revs up to the lower gear's (rev-matched) while the clutch is in for it
    var want = hold ? Math.min(E.limit, E.launch + (E.red - E.launch)*0.35)
             : G.shiftT > 0 && G.blipTo ? Math.min(E.limit, G.blipTo*1.04) : E.idle + thr*(E.limit - E.idle);
    rpm += want > rpm ? Math.min(want - rpm, E.red*(G.blipTo ? 6 : 1.9)*dt) : -Math.min(rpm - want, E.red*1.2*dt);
    if(thr > 0.9 && !hold && rpm >= E.limit - 60){ rpm = E.limit - 220*((G.limPh = ((G.limPh || 0) + dt*24) % 1)); out.limiter = true; }
    out.drive = g === 0 || inp.clutch || hold ? 0 : 0.35;              // mid-shift a little still gets through
  } else {
    var wheel = Math.max(at(g), E.idle);
    // pulling away in 1st the clutch slips the revs up to the launch rpm under throttle
    if(g === 1 && v < 6) wheel = Math.max(wheel, E.idle + (E.launch - E.idle)*thr*(1 - v/6));
    // let out with the revs well above the wheels at low speed: a launch, the tyres spinning
    var rel = (G.clutchWas || G.held) && G.rpm > wheel + 1500 && v < 12;
    if(rel){ G.launchT = 0.9; G.slip0 = clamp((G.rpm - wheel)/(E.red*0.55), 0.3, 1); ev.push("launch"); }
    // rev-matched: the revs meet the wheels fast (a downshift jumps them up, its blip), never a slow slide
    var k = 1 - Math.exp(-dt*(G.shiftT > 0 ? 40 : 22));
    rpm += (wheel - rpm)*k;
    out.cap = E.limit/K[Math.max(0, g - 1)];
    if(at(g) >= E.limit - 40 && thr > 0.05){ rpm = E.limit - 220*((G.limPh = ((G.limPh || 0) + dt*24) % 1)); out.limiter = true; out.drive = 0; }
    out.engineBrake = thr < 0.05 ? (0.5 + 3.2*clamp((rpm - E.idle)/(E.red - E.idle), 0, 1))*(G.manual ? 1.25 : 1) : 0;
  }
  if(G.launchT > 0){
    G.launchT = Math.max(0, G.launchT - dt);
    out.slip = G.slip0*(G.launchT/0.9); out.drive *= 1 + 0.8*out.slip;  // the launch's kick, fading as the tyres bite
  }
  if(G.shiftT <= 0) G.blipTo = 0;
  G.clutchWas = !!inp.clutch; G.held = hold;
  G.rpm = clamp(rpm, E.idle*0.85, E.limit);
  out.rpm = G.rpm; out.gear = sp < -0.3 && g > 0 ? -1 : g; out.manual = G.manual;
  return out;
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
    eng: (spec.engine && ENGINE_VOICES[spec.engine.voice] && spec.engine.voice) || entry.sound || voiceFor(spec, kind),
    floor: floor,
    // heavier stops longer: 14 m/s² up to 1.6 t, down to 11 at 2.8 t (a bike with its rider: 14)
    brake: kind === "bike" ? BRAKE : Math.round(clamp(BRAKE - (mass - 1600)/400, 11, BRAKE)*10)/10,
    roll: kind === "bike" ? 0 : (ROLL[type] != null ? ROLL[type] : 0.03),
    grip: kind === "bike" ? 0.8 : GRIP[drive], slip: kind === "bike" ? 0.5 : SLIP[drive]
  };
  // [revs] its real revs and gearing; where the gearing is known, each gear tops out at its real redline speed
  V.engine = engineFor(spec, kind, V.eng, V.gears);
  if(V.engine.k && !electric && spec.engine && spec.engine.ratios) V.gears = V.engine.k.map(function(k){ return Math.round(V.engine.red/k*10)/10; });
  var S = SLIDE[kind === "bike" ? "bike" : drive];
  if(kind === "car" && type === "formula"){ S = FORMULA.slide; V.grip = FORMULA.grip; V.slip = FORMULA.slip; V.brake = FORMULA.brake; }
  V.slide = {min: S.min, turn: S.turn, grip: S.grip, max: S.max, bleed: S.bleed};
  return V;
}

HQV.hqVehiclePhys = {derive: derive, accFor: accFor, t0100: t0100, timeTo: timeTo, estimate0100: estimate0100,
                     voiceFor: voiceFor, gearsFor: gearsFor, engineFor: engineFor, tyreCirc: tyreCirc, gearState: gearState, gearStep: gearStep, autoGear: autoGear, MODES: MODES, MODE_ORDER: MODE_ORDER,
                     nitroStep: nitroStep, perfStep: perfStep, wheelieStep: wheelieStep, WHEELIE: {BAL: BAL, LOOP: LOOP, OVER: OVER, STOPPIE_V: STOPPIE_V}, REVS: REVS, CAP_KMH: CAP_KMH, SLIDE: SLIDE, LEAN: LEAN, ROLL: ROLL,
                     FLOOR: FLOOR, FLOOR_EV: FLOOR_EV, FORMULA: FORMULA};
})();
