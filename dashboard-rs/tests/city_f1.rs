//! The F1 grid in the City (HQ 3.17, docs/plans/grand-prix-spec.md sections 1.4 and 3): every catalogue F1 car builds
//! its `formula` body (games/hqvehiclemodels.js) at its size with the rig the City rides, derives grippy capped
//! street handling (games/hqvehiclephys.js) with the `v6` voice (games/engine.js), and the dealership
//! (games/hqdealer.js) lists and shows all eleven. Node runs the JS with the vendored three.js; skipped where node
//! is not installed.
use std::path::PathBuf;
use std::process::Command;

use serde_json::Value;

const SCRIPT: &str = r#"
import fs from "fs";
const root = process.argv[1];
const THREE = await import(root + "/games/vendor/three-module.js");
const AC = class { constructor(){ this.state = "running"; this.sampleRate = 8000; this.destination = {}; } get currentTime(){ return 0; } resume(){ return Promise.resolve(); } };
globalThis.window = {HQV: {}, matchMedia: () => ({matches: false}), AudioContext: AC};
globalThis.document = {documentElement: {classList: {contains: () => false}}, createElement: () => ({})};
globalThis.localStorage = {getItem: () => null, setItem(){}};
for (const f of ["engine", "hqvehicles", "hqvehiclephys", "hqvehiclemodels", "hqdealer"])
  new Function("window", "document", fs.readFileSync(root + "/games/" + f + ".js", "utf8"))(window, document);
const H = window.HQV, V = H.hqVehicleModels, P = H.hqVehiclePhys, E = H.engine, D = H.hqDealer;
const cat = JSON.parse(fs.readFileSync(root + "/games/vehicles/catalogue.json", "utf8"));
const grid = cat.vehicles.filter(v => v.body === "formula");
const v3 = () => new THREE.Vector3();
const wpos = o => { o.updateWorldMatrix(true, false); return o.getWorldPosition(v3()).toArray(); };
// as three.js stores a colour (linear, when colour management is on)
const hexRgb = h => { const c = new THREE.Color(parseInt(h.slice(1), 16)); return [c.r, c.g, c.b]; };
const out = {cars: [], phys: [], engines: E.engines || [], v6: E.engineHz ? [E.engineHz("v6", 900).hz, E.engineHz("v6", 7600).hz] : null};
for (const v of grid){
  const r = V.build(THREE, v, 0x3366cc); r.g.updateMatrixWorld(true);
  const b = new THREE.Box3().setFromObject(r.g), s = b.getSize(v3()), tb = new THREE.Box3(); r.wheels.forEach(w => tb.expandByObject(w));
  // the livery's accent is baked into the trim's vertex colours
  const acc = hexRgb(v.livery.accent); let accent = false;
  r.meshes.filter(m => m.userData.mk === "trim").forEach(m => { const c = m.geometry.attributes.color; if(!c) return;
    for(let i = 0; i < c.count && !accent; i++) if(Math.abs(c.getX(i) - acc[0]) < 0.01 && Math.abs(c.getY(i) - acc[1]) < 0.01 && Math.abs(c.getZ(i) - acc[2]) < 0.01) accent = true; });
  const w0 = r.wheels[0].rotation.x; r.roll(1, 0.5);
  out.cars.push({id: v.id, kind: r.kind, size: s.toArray(), minY: b.min.y, tyreW: tb.max.x - tb.min.x, shown: V.shown(v), tris: V.triangles(r), dc: V.drawCalls(r),
    wheels: r.wheels.map(w => ({name: w && w.name, p: w ? wpos(w) : null})), radii: r.radii, rolled: r.wheels[0].rotation.x - w0,
    anchors: ["a-seat", "a-grip-l", "a-grip-r", "a-foot-l", "a-foot-r"].map(n => !!r.g.getObjectByName(n)),
    seat: wpos(r.seat), grips: r.grips.map(wpos), steer: r.steer.map(h => h && h.name), spin: !!r.spin, hats: r.hats, riderK: r.riderK,
    accent, paintIsRig: r.meshes.some(m => m.userData.mk === "paint" && m.material === r.paint), tail: r.meshes.some(m => m.userData.mk === "tail")});
  const cls = String(v.class).split(".");
  out.phys.push(Object.assign({id: v.id}, P.derive({kind: "car", type: v.body || cls[1], spec: v.spec, dims: v.dims, sound: v.sound})));
}
const hyper = cat.vehicles.find(v => v.id === "bugatti-chiron-super-sport");
out.hyper = P.derive({kind: "car", type: hyper.body, spec: hyper.spec, dims: hyper.dims, sound: hyper.sound});
out.voiceFor = P.voiceFor(grid[0].spec, "car");
out.rwdSlideMax = P.SLIDE.rwd.max;
// the dealership: the panel model and the flagship's layout (the Commons lot, 63.65 x 39.15 m)
const M = D.model(cat, {garage: true}), items = [];
let f1Section = null;
M.tabs.forEach(k => k.sections.forEach(s => { if(s.type === "formula") f1Section = {label: s.label, kind: k.kind, n: s.classes.reduce((a, c) => a + c.vehicles.length, 0)};
  s.classes.forEach(cl => cl.vehicles.forEach(v => items.push({kind: k.kind, id: v.id, grid: !!cl.grid}))); }));
const L = D.layout({w: 63.65, d: 39.15}, items, true);
out.dealer = {f1Section, onSale: H.hqVehicles.onSale(cat).map(c => c.id), items: items.length, cells: L.cells.length, gallery: L.gallery,
  hall: L.hall, gridCells: L.cells.filter(c => c.grid).map(c => ({x: c.x, z: c.z, y: c.y, rx: c.rx, rz: c.rz, id: items[c.i].id})),
  floorCells: L.cells.filter(c => !c.grid).map(c => ({x: c.x, z: c.z, r: c.r}))};
console.log(JSON.stringify(out));
"#;

fn run() -> Option<Value> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    let out = match Command::new("node").arg("--input-type=module").arg("-e").arg(SCRIPT).arg(&root).output() {
        Ok(o) => o,
        Err(_) => {
            eprintln!("node not installed: the City's F1 checks are skipped");
            return None;
        }
    };
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    let text = String::from_utf8_lossy(&out.stdout);
    Some(serde_json::from_str(text.lines().last().unwrap_or("{}")).unwrap())
}
fn f(v: &Value) -> f64 {
    v.as_f64().unwrap_or(f64::NAN)
}

#[test]
fn the_grid_in_the_city() {
    let Some(o) = run() else { return };
    let cars = o["cars"].as_array().unwrap();
    assert_eq!(cars.len(), 11, "every F1 car of the catalogue");

    // the formula body: at its size, on the ground, on budget, with the rig hq3d rides
    for c in cars {
        let id = c["id"].as_str().unwrap();
        let (s, d) = (&c["size"], &c["shown"]);
        assert_eq!(c["kind"], "car", "{id}");
        assert!((f(&s[2]) / f(&d["lengthM"]) - 1.0).abs() < 0.05, "{id}: length {s} vs {d}");
        assert!((f(&s[1]) / f(&d["heightM"]) - 1.0).abs() < 0.05, "{id}: height {s} vs {d}");
        assert!((f(&c["tyreW"]) / f(&d["widthM"]) - 1.0).abs() < 0.05, "{id}: the track, tyre to tyre");
        assert!(f(&c["minY"]).abs() < 0.02, "{id}: on the ground");
        assert!(c["tris"].as_u64().unwrap() < 6000 && c["dc"].as_u64().unwrap() <= 16, "{id}: budget {} tris, {} draws", c["tris"], c["dc"]);
        let w = c["wheels"].as_array().unwrap();
        assert_eq!(w.iter().map(|x| x["name"].as_str().unwrap_or("")).collect::<Vec<_>>(), ["wheel-0", "wheel-1", "wheel-2", "wheel-3"], "{id}");
        let mut zs: Vec<f64> = w.iter().map(|x| f(&x["p"][2])).collect();
        zs.sort_by(f64::total_cmp);
        assert!((zs[3] - zs[0] - f(&d["wheelbaseM"])).abs() < 0.01, "{id}: wheels on the wheelbase");
        for (x, r) in w.iter().zip(c["radii"].as_array().unwrap()) {
            assert!((f(&x["p"][1]) - f(r)).abs() < 0.01, "{id}: a wheel touching the ground");
        }
        assert!(f(&c["rolled"]) > 0.5 / 0.5, "{id}: the wheels roll");
        assert_eq!(c["anchors"], serde_json::json!([true, true, true, true, true]), "{id}: the rider's anchors");
        assert_eq!(c["steer"], serde_json::json!(["steer-l", "steer-r"]), "{id}");
        assert_eq!((c["spin"].as_bool(), c["hats"].as_bool()), (Some(true), Some(false)), "{id}: a steering wheel, no hats in the cockpit");
        assert!((0.4..=0.85).contains(&f(&c["riderK"])), "{id}");
        let (seat, grips) = (&c["seat"], c["grips"].as_array().unwrap());
        assert!(f(&seat[0]).abs() < 0.01, "{id}: a single-seater sits its driver in the middle");
        assert!(f(&seat[1]) < 0.35, "{id}: low");
        assert!(grips.iter().all(|g| f(&g[2]) > f(&seat[2])), "{id}: hands ahead of the hips");
        assert!(c["accent"] == true && c["paintIsRig"] == true && c["tail"] == true, "{id}: the livery's accent, the chosen paint, a rain light");
    }

    // handling: grippier and quicker to stop than a hypercar, barely sliding, never rolling, at its real 345 km/h
    let hy = &o["hyper"];
    for p in o["phys"].as_array().unwrap() {
        let id = p["id"].as_str().unwrap();
        assert!((f(&p["top"]) - 345.0 / 3.6).abs() < 0.5, "{id}: top {}", p["top"]);
        assert_eq!(p["eng"], "v6", "{id}");
        assert_eq!((p["type"].as_str(), p["drive"].as_str()), (Some("formula"), Some("rwd")), "{id}");
        assert!(f(&p["grip"]) >= 1.0 && f(&p["slip"]) <= 0.15 && f(&p["roll"]) == 0.0, "{id}: {p}");
        assert!(f(&p["brake"]) > f(&hy["brake"]), "{id}: stops shorter than a hypercar");
        assert!(f(&p["slide"]["max"]) < f(&o["rwdSlideMax"]) && f(&p["slide"]["grip"]) > f(&hy["slide"]["grip"]), "{id}: its tail stays put");
        assert!(f(&p["acc"]) > 0.0 && p["gears"].as_array().unwrap().len() == 8, "{id}");
    }
    assert_eq!(o["voiceFor"], "v6", "a turbo V6 is the F1 voice");
    assert_eq!(o["hyper"]["eng"], "w16", "other cars keep theirs");

    // the v6 voice: listed, and it climbs with the rpm
    assert!(o["engines"].as_array().unwrap().iter().any(|e| e == "v6"), "games/engine.js has a v6 voice");
    let hz = o["v6"].as_array().expect("engineHz");
    assert!(f(&hz[1]) > f(&hz[0]) * 2.0, "v6 {hz:?}");

    // the dealership: on sale, a Formula 1 section with all eleven, and the flagship shows the whole lineup
    let dl = &o["dealer"];
    assert!(dl["onSale"].as_array().unwrap().iter().any(|c| c == "car.formula.2000"));
    assert_eq!(dl["f1Section"]["label"], "Formula 1");
    assert_eq!((dl["f1Section"]["kind"].as_str(), dl["f1Section"]["n"].as_u64()), (Some("car"), Some(11)));
    assert_eq!(dl["cells"], dl["items"], "the flagship shows every vehicle on sale, the F1 grid included");
    let gal = &dl["gallery"];
    let gc = dl["gridCells"].as_array().unwrap();
    assert_eq!(gc.len(), 11, "the grid stands on the gallery");
    let h = &dl["hall"];
    for (i, c) in gc.iter().enumerate() {
        assert!(f(&c["y"]) > 3.0 && f(&c["y"]) < f(&h["h"]) - 1.5, "the gallery is half way up, under the roof");
        assert!(f(&c["x"]) - f(&c["rx"]) >= f(&h["x0"]) && f(&c["x"]) + f(&c["rx"]) <= f(&h["x1"]), "inside the hall");
        assert!(f(&c["z"]) - f(&c["rz"]) >= f(&gal["z0"]) && f(&c["z"]) + f(&c["rz"]) <= f(&gal["z1"]), "on the gallery");
        if i > 0 {
            assert!(f(&c["x"]) - f(&gc[i - 1]["x"]) >= f(&c["rx"]) * 2.0, "side by side, not overlapping");
        }
    }
    let fc = dl["floorCells"].as_array().unwrap();
    for i in 0..fc.len() {
        for j in i + 1..fc.len() {
            let (a, b) = (&fc[i], &fc[j]);
            let dd = (f(&a["x"]) - f(&b["x"])).hypot(f(&a["z"]) - f(&b["z"]));
            assert!(dd >= f(&a["r"]) + f(&b["r"]) - 1e-6, "floor turntables {i} and {j} overlap");
        }
    }
}
