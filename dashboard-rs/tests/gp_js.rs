//! Grand Prix's pure JS under node (docs/plans/grand-prix-spec.md, section 6): games/gp/circuit.js builds every
//! circuit in games/gp/circuits.json into a closed rally-shaped stage, the lap tracker keeps track limits, and
//! games/rally/physics.js drives the Formula 1 spec (carSpec) round Monaco and Monza on the test autopilot.
//! games/gp.js registers with a stub Valley. Skipped where node is not installed.
use std::path::PathBuf;
use std::process::Command;

use serde_json::Value;

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
}

/// Runs `script` under node with the repo root as argv[1] and parses its stdout as JSON; None without node.
fn node(script: &str) -> Option<Value> {
    let out = match Command::new("node").arg("-e").arg(script).arg(root()).output() {
        Ok(o) => o,
        Err(_) => {
            eprintln!("node not installed: Grand Prix JS checks skipped");
            return None;
        }
    };
    assert!(out.status.success(), "node failed:\n{}", String::from_utf8_lossy(&out.stderr));
    Some(serde_json::from_slice(&out.stdout).unwrap_or_else(|e| panic!("not JSON ({e}):\n{}", String::from_utf8_lossy(&out.stdout))))
}

const PRELUDE: &str = r#"
const fs = require('fs'), path = require('path'), R0 = process.argv[1];
const C = require(path.join(R0, 'games/gp/circuit.js')), P = require(path.join(R0, 'games/rally/physics.js'));
const SL = C.useSlick(P);
const doc = JSON.parse(fs.readFileSync(path.join(R0, 'games/gp/circuits.json'), 'utf8'));
const cat = JSON.parse(fs.readFileSync(path.join(R0, 'games/vehicles/catalogue.json'), 'utf8'));
const grid = cat.vehicles.filter(v => v.class === 'car.formula.2000').sort((a, b) => a.slot - b.slot);
"#;

#[test]
fn every_circuit_builds_a_closed_stage() {
    let script = format!("{PRELUDE}{}", r#"
const out = {n: 0, slick: SL, slickAgain: C.useSlick(P), surfaces: P.SURFACES.length, list: C.list(doc).map(c => [c.id, c.round]), bad: []};
for(const c of C.list(doc)){
  const st = C.build(C.find(doc, c.id), {slick: SL}), L = st.lapLength, n = st.pts.length, a = st.pts[0], z = st.pts[n - 1];
  const why = [];
  if(!(st.loop && st.circuitStage)) why.push('not a loop');
  if(Math.hypot(a.x - z.x, a.z - z.z) > 1e-6 || Math.abs(z.s - L) > 1e-6) why.push('the ribbon does not close');
  if(Math.abs(L - c.lengthM) > 0.03*c.lengthM) why.push('length ' + L.toFixed(0) + ' vs ' + c.lengthM);
  // locate wraps: just before and just after the line
  const p0 = st.pointAtS(L - 3), p1 = st.pointAtS(3), q0 = st.locate(p0.x, p0.z, null), q1 = st.locate(p1.x, p1.z, q0.i);
  if(Math.abs(q0.s - (L - 3)) > 1 || Math.abs(q1.s - 3) > 1) why.push('locate does not wrap: ' + q0.s.toFixed(1) + ' ' + q1.s.toFixed(1));
  const pw = st.pointAtS(L + 40), pv = st.pointAtS(40);
  if(Math.hypot(pw.x - pv.x, pw.z - pv.z) > 1e-6) why.push('pointAtS does not wrap');
  // the grid boxes are on the racing surface, behind the line, inside the road
  st.slots.forEach((s, i) => {
    const q = st.locate(s.x, s.z, null);
    if(st.env.surface(s.x, s.z) !== SL || Math.abs(q.lat) > st.roadHalf - 0.9) why.push('slot ' + i + ' off the road');
    if(!(q.s > L - 80)) why.push('slot ' + i + ' not behind the line');
  });
  if(st.slots.length !== 8) why.push('8 grid boxes');
  if(!(st.sectors[0] > 0 && st.sectors[0] < st.sectors[1] && st.sectors[1] < L)) why.push('sectors');
  if(st.scenery.walls.length < L/8) why.push('walls ' + st.scenery.walls.length);
  if(!st.scenery.gantry) why.push('no gantry');
  // heights are finite and the road stays within the slope a car can climb
  let maxG = 0; for(let i = 1; i < n; i++){ const dy = st.pts[i].y - st.pts[i - 1].y, ds = st.pts[i].s - st.pts[i - 1].s; if(!isFinite(st.pts[i].y)) why.push('height'); maxG = Math.max(maxG, Math.abs(dy/ds)); }
  if(maxG > 0.12) why.push('grade ' + maxG.toFixed(3));
  // nothing on the road blocks it: no wall within the road half-width of the centre line
  let blocked = 0; for(let i = 0; i < n; i += 5){ const p = st.pts[i]; st.env.obstacles(p.x, p.z, st.roadHalf - 0.5, (ox, oz, r) => { if(Math.hypot(ox - p.x, oz - p.z) < st.roadHalf - 0.5 + r - 1.2) blocked++; }); }
  if(blocked) why.push('walls on the road: ' + blocked);
  out.n++;
  if(why.length) out.bad.push(c.id + ': ' + why.join('; '));
}
console.log(JSON.stringify(out));
"#);
    let Some(o) = node(&script) else { return };
    assert_eq!(o["bad"], serde_json::json!([]), "{:#}", o["bad"]);
    assert!(o["n"].as_u64().unwrap() >= 40, "every circuit in the file");
    assert_eq!(o["slick"], o["slickAgain"], "useSlick registers the surface once");
    assert_eq!(o["slick"].as_u64(), Some(o["surfaces"].as_u64().unwrap() - 1));
    // the calendar first, by round, then the classics
    let list = o["list"].as_array().unwrap();
    let rounds: Vec<u64> = list.iter().filter_map(|e| e[1].as_u64()).collect();
    assert!(rounds.windows(2).all(|w| w[0] < w[1]) && rounds[0] == 1);
    let first_classic = list.iter().position(|e| e[1].is_null()).unwrap();
    assert!(list[first_classic..].iter().all(|e| e[1].is_null()), "classics after the calendar");
}

#[test]
fn the_tracker_times_laps_and_keeps_track_limits() {
    let script = format!("{PRELUDE}{}", r#"
const st = C.build(C.find(doc, 'it-1922'), {slick: SL}), L = st.lapLength;
// drive the centre line (or a line offset to the side) at a steady speed, in steps of dt
function lap(T, t0, speed, lat, from, to){
  let t = t0, dt = 1/30;
  for(let s = from; s <= to; s += speed*dt){ const p = st.pointAtS(s), x = p.x + Math.cos(p.h)*lat(s), z = p.z + Math.sin(p.h)*lat(s); t += dt; T.update(x, z, t, dt).forEach(e => evs.push(e)); }
  return t;
}
let evs = [];
const T = C.tracker(st);
let t = lap(T, 0, 60, () => 0, L - 30, L + L + 30);              // out of the grid, one full lap and over the line again
const clean = evs.slice();
evs = [];
const T2 = C.tracker(st), lim = st.roadHalf + st.kerb + 2;
lap(T2, 0, 60, s => (s % L) > 1000 && (s % L) < 1400 ? lim : 0, L - 30, 2*L + 30);   // 400 m past the kerbs: ~6.7 s off
const off = evs.slice();
evs = [];
const T3 = C.tracker(st);
let t3 = lap(T3, 0, 60, () => 0, L - 30, L + 500);
const pj = st.pointAtS(L*0.7); T3.update(pj.x, pj.z, t3 + 0.1, 0.1);   // a jump: a cut or a reset
lap(T3, t3 + 0.1, 60, () => 0, L*0.7, 2*L + 30);
const cut = evs.slice();
console.log(JSON.stringify({L, clean, off, cut}));
"#);
    let Some(o) = node(&script) else { return };
    let ev = |k: &str| o[k].as_array().unwrap().clone();
    let types = |v: &Vec<Value>| v.iter().map(|e| e["type"].as_str().unwrap().to_string()).collect::<Vec<_>>();
    assert_eq!(types(&ev("clean")), ["start", "sector", "sector", "lap"], "{}", o["clean"]);
    let lap = ev("clean")[3].clone();
    let want = o["L"].as_f64().unwrap() / 60.0 * 1000.0;
    assert!((lap["ms"].as_f64().unwrap() - want).abs() < 60.0, "{lap} vs {want}");
    assert_eq!(lap["valid"], true);
    let secs: f64 = lap["sectors"].as_array().unwrap().iter().map(|v| v.as_f64().unwrap()).sum();
    assert!((secs - lap["ms"].as_f64().unwrap()).abs() < 3.0, "the sectors add up to the lap");
    let off_lap = ev("off").into_iter().find(|e| e["type"] == "lap").unwrap();
    assert_eq!(off_lap["valid"], false, "more than 4 s past the kerbs deletes the lap");
    let cut: Vec<Value> = ev("cut").into_iter().filter(|e| e["type"] == "lap").collect();
    assert!(cut.iter().all(|e| e["valid"] == false), "a jump never makes a valid lap: {cut:?}");
}

#[test]
fn the_formula_one_car_launches_and_laps_monaco_and_monza() {
    let script = format!("{PRELUDE}{}", r#"
const veh = grid[0], spec = C.carSpec(veh);
const flat = {height: () => 0, normal: (x, z, o) => { o = o || [0, 1, 0]; o[0] = 0; o[1] = 1; o[2] = 0; return o; }, surface: () => SL, obstacles: () => {}};
const car0 = P.create(spec, {assist: true, tc: true}); P.place(car0, 0, 0, 0, flat);
let t = 0, t100 = null; while(t < 6 && t100 == null){ P.step(car0, {throttle: 1, brake: 0, steer: 0}, flat, P.DT); t += P.DT; if(car0.tel.kmh >= 100) t100 = t; }
const laps = {};
for(const id of ['mc-1929', 'it-1922']){
  const st = C.build(C.find(doc, id), {slick: SL}), car = P.create(spec, {assist: true, tc: true}), s0 = st.slots[0];
  P.place(car, s0.x, s0.z, s0.h, st.env);
  const T = C.tracker(st); let tt = 0, hint = -1, top = 0, got = [];
  while(tt < 400 && got.length < 2){
    const ctl = C.autopilot(st, car, hint); hint = ctl.hint;
    P.step(car, ctl, st.env, P.DT); P.step(car, ctl, st.env, P.DT); tt += 2*P.DT;
    T.update(car.p[0], car.p[2], tt, 2*P.DT).forEach(e => { if(e.type === 'lap') got.push({ms: e.ms, valid: e.valid}); });
    top = Math.max(top, car.tel.kmh);
  }
  laps[id] = {laps: got, top: top};
}
// every team's car is the same car: the same spec but for the livery and the names
const same = grid.every(v => { const a = C.carSpec(v), b = C.carSpec(grid[0]); return a.mass === b.mass && a.cla === b.cla && JSON.stringify(a.engine) === JSON.stringify(b.engine); });
console.log(JSON.stringify({t100, want0100: veh.spec.zeroTo100s, wantTop: veh.spec.topKmh, laps, same, n: grid.length, body: spec.body, eng: spec.eng,
  colors: grid.map(v => C.carSpec(v).colors.body === v.livery.base)}));
"#);
    let Some(o) = node(&script) else { return };
    assert_eq!(o["n"], 11);
    assert_eq!((o["body"].as_str(), o["eng"].as_str()), (Some("formula"), Some("v6")));
    assert_eq!(o["same"], true, "the grid is equal");
    assert!(o["colors"].as_array().unwrap().iter().all(|b| b == true), "each car is painted its livery");
    let (t, want) = (o["t100"].as_f64().expect("reaches 100 km/h"), o["want0100"].as_f64().unwrap());
    assert!((t - want).abs() <= want * 0.15, "0-100 km/h {t:.2} s vs the catalogue's {want} s");
    for id in ["mc-1929", "it-1922"] {
        let l = &o["laps"][id];
        let laps = l["laps"].as_array().unwrap();
        assert_eq!(laps.len(), 2, "{id}: two laps on the autopilot: {l}");
        assert!(laps.iter().all(|e| e["valid"] == true), "{id}: valid laps: {l}");
    }
    let top = o["laps"]["it-1922"]["top"].as_f64().unwrap();
    assert!(top >= o["wantTop"].as_f64().unwrap() * 0.95, "Monza's straight: {top:.1} km/h");
    let monza = o["laps"]["it-1922"]["laps"][1]["ms"].as_f64().unwrap() / 1000.0;
    let monaco = o["laps"]["mc-1929"]["laps"][1]["ms"].as_f64().unwrap() / 1000.0;
    assert!((70.0..130.0).contains(&monza) && (60.0..130.0).contains(&monaco), "lap times {monza:.1} s, {monaco:.1} s");
}

#[test]
fn the_steering_limiter_keeps_the_grip_at_speed() {
    let script = format!("{PRELUDE}{}", r#"
const spec = C.carSpec(grid[0]);
console.log(JSON.stringify([5, 20, 40, 60, 90].map(v => [v, C.steerScale(spec, v, true), C.steerScale(spec, v, false)])));
"#);
    let Some(o) = node(&script) else { return };
    let rows = o.as_array().unwrap();
    for r in rows {
        let (a, k) = (r[1].as_f64().unwrap(), r[2].as_f64().unwrap());
        assert!((0.08..=1.0).contains(&a) && (0.08..=1.0).contains(&k), "{r}");
    }
    assert_eq!(rows[0][1].as_f64(), Some(1.0), "full lock at a crawl");
    let fast: Vec<f64> = rows.iter().map(|r| r[1].as_f64().unwrap()).collect();
    assert!(fast.windows(2).all(|w| w[1] <= w[0] + 1e-9), "less of the stick's lock the faster: {fast:?}");
    assert!(fast[4] < 0.3, "at 324 km/h a full stick is a fraction of its 0.34 rad");
}

#[test]
fn the_city_derives_an_f1_car_at_its_real_top_speed() {
    let script = r#"
const fs = require('fs'), path = require('path'), R0 = process.argv[1];
globalThis.window = undefined;
eval(fs.readFileSync(path.join(R0, 'games/hqvehiclephys.js'), 'utf8'));
const Ph = globalThis.HQV.hqVehiclePhys, cat = JSON.parse(fs.readFileSync(path.join(R0, 'games/vehicles/catalogue.json'), 'utf8'));
const out = cat.vehicles.filter(v => v.body === 'formula').map(v => { const d = Ph.derive({kind: 'car', type: 'formula', spec: v.spec, dims: v.dims, sound: v.sound}); return {id: v.id, top: d.top, real: v.spec.topKmh/3.6, acc: d.acc, eng: d.eng, roll: d.roll}; });
console.log(JSON.stringify({out}));
"#;
    let Some(o) = node(script) else { return };
    let out = o["out"].as_array().unwrap();
    assert_eq!(out.len(), 11);
    for v in out {
        assert!((v["top"].as_f64().unwrap() - v["real"].as_f64().unwrap()).abs() < 1e-6 && v["acc"].as_f64().unwrap() > 0.0, "{v}");
        assert_eq!(v["eng"], "v6");
    }
}

#[test]
fn gp_registers_with_the_valley_and_launches_by_id_only() {
    let script = r#"
const fs = require('fs'), path = require('path'), R0 = process.argv[1];
const games = [], opened = [];
global.window = {HQV: {api: {save: {}, persist(){}, open(id){ opened.push(id); }, mk(){ return {}; }, btn(){ return {}; }, toast(){}},
  engine: {now: () => 0, clamp: (v, a, b) => v < a ? a : v > b ? b : v, calm: () => false, say(){}, tokens: () => ({}), hasWebGL2: () => false},
  register(g){ games.push(g); }}};
global.getComputedStyle = () => ({getPropertyValue: () => ''}); global.document = {documentElement: {}};
eval(fs.readFileSync(path.join(R0, 'games/gp.js'), 'utf8'));
const H = window.HQV;
H.gpLaunch({circuit: 'mc-1929', vehicle: 'f1-ferrari-sf-26'});
const g = games[0];
console.log(JSON.stringify({id: g && g.id, name: g && g.name, mount: typeof (g && g.mount), launch: typeof H.gpLaunch, opened, badge: g && g.badge()}));
process.exit(0);
"#;
    let Some(o) = node(script) else { return };
    assert_eq!((o["id"].as_str(), o["name"].as_str(), o["mount"].as_str()), (Some("gp"), Some("Grand Prix"), Some("function")));
    assert_eq!(o["launch"], "function");
    assert_eq!(o["opened"], serde_json::json!(["gp"]), "gpLaunch opens the game");
    assert_eq!(o["badge"], "");
}
