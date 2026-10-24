//! The City's Grand Prix Circuit (games/hqgpvenue.js, docs/plans/grand-prix-spec.md section 5) under node: where it
//! stands on the real world fixtures (after every other shop, from tier 2, idempotent), the venue it builds, the circuit
//! rows and the grid, and the panel (the car it preselects, Go). Skipped where node is not installed.
use std::path::PathBuf;
use std::process::Command;

use serde_json::{json, Value};

const HARNESS: &str = r#"
import fs from "fs";
import zlib from "zlib";
const root = process.argv[2];
const THREE = await import(root + "/games/vendor/three-module.js");
/* ---------- a small DOM ---------- */
function El(tag){ this.tagName = String(tag).toLowerCase(); this.children = []; this.parentNode = null; this.attrs = {}; this.ls = {}; this.dataset = {};
  this.style = {}; this.hidden = false; this.disabled = false; this._t = ""; this.className = ""; this.type = ""; this.id = ""; this.tabIndex = 0; this.ownerDocument = globalThis.document; }
El.prototype.appendChild = function(k){ k.parentNode = this; this.children.push(k); return k; };
El.prototype.removeChild = function(k){ var i = this.children.indexOf(k); if(i >= 0) this.children.splice(i, 1); k.parentNode = null; return k; };
Object.defineProperty(El.prototype, "textContent", {get(){ return this._t + this.children.map(k => k.textContent).join(""); }, set(v){ this.children = []; this._t = String(v); }});
El.prototype.setAttribute = function(k, v){ this.attrs[k] = String(v); };
El.prototype.getAttribute = function(k){ return this.attrs[k]; };
El.prototype.addEventListener = function(t, f){ (this.ls[t] = this.ls[t] || []).push(f); };
El.prototype.removeEventListener = function(t, f){ var L = this.ls[t] || [], i = L.indexOf(f); if(i >= 0) L.splice(i, 1); };
El.prototype.all = function(){ var o = [this]; this.children.forEach(k => { o = o.concat(k.all()); }); return o; };
El.prototype.querySelectorAll = function(sel){
  var m = /^\[role=(\w+)\]$/.exec(sel), cs = m ? null : sel.split(" ").pop().split(".").filter(Boolean);
  return this.all().slice(1).filter(n => m ? n.attrs.role === m[1] : cs.every(c => c === n.tagName || (" " + n.className + " ").indexOf(" " + c + " ") >= 0));
};
El.prototype.querySelector = function(sel){ return this.querySelectorAll(sel)[0] || null; };
El.prototype.closest = function(sel){ var c = sel.replace(".", ""); for(var n = this; n; n = n.parentNode) if((" " + n.className + " ").indexOf(" " + c + " ") >= 0) return n; return null; };
El.prototype.focus = function(){ globalThis.document.activeElement = this; };
El.prototype.fire = function(t, e){ (this.ls[t] || []).slice().forEach(f => f(Object.assign({target: this, preventDefault(){}}, e || {}))); };
El.prototype.click = function(){ this.fire("click"); };
globalThis.document = {createElement: t => new El(t), documentElement: new El("html"), activeElement: null};
const store = {};
globalThis.window = {HQV: {}, document: globalThis.document, localStorage: {getItem: k => store[k] || null, setItem(k, v){ store[k] = String(v); }}};
const circuitsDoc = JSON.parse(fs.readFileSync(root + "/games/gp/circuits.json", "utf8"));
let fetched = 0;
window.fetch = globalThis.fetch = u => { fetched++; return Promise.resolve({ok: true, json: () => Promise.resolve(circuitsDoc)}); };
for (const f of ["world", "hqmerge", "hqvehicles", "hqnav", "hqdealer", "hqcasino", "hqpets", "hqtuning", "hqgpvenue"])
  new Function(fs.readFileSync(root + "/games/" + f + ".js", "utf8"))();
const H = window.HQV, GV = H.hqGpVenue, WD = H.world;
const cat = JSON.parse(fs.readFileSync(root + "/games/vehicles/catalogue.json", "utf8"));
const out = {};

/* ---------- where it stands: after the dealership, the casino, the Pet shop and the Tuning shop ---------- */
const gz = p => JSON.parse(zlib.gunzipSync(fs.readFileSync(p)).toString("utf8"));
function placed(file, id, tier){
  const W = WD.pack(gz(root + "/tests/fixtures/" + file)); W.id = id;
  const others = [H.hqDealer.place(W, tier), H.hqCasino.place(W, tier), H.hqPets.place(W), H.hqTuning.place(W, tier)].filter(Boolean);
  const s = GV.place(W, tier);
  if(!s) return {site: null};
  const lot = W.lots.filter(l => l.id === s.lot)[0], F = H.hqDealer.frame(s);
  return {site: {id: s.id, kind: s.kind, tier: s.tier, name: s.name}, lotKind: lot.kind, same: GV.place(W, tier) === s,
    F: {w: F.w, d: F.d}, ownLot: others.every(o => o.lot !== s.lot), others: others.length,
    places: H.hqnav.places(W, tier, {x: 0, z: 0}).filter(p => p.kind === "gp").map(p => ({label: p.label, icon: p.icon})), W};
}
const pc = placed("claude-hq@2.json.gz", "claude-hq@2", 5);
out.place = Object.assign({}, pc, {W: undefined});
out.place1 = placed("claude-hq@2.json.gz", "claude-hq@2", 1).site;
out.island = placed("island@2.json.gz", "user:x@2", 3).site;

/* ---------- the venue ---------- */
function mat(c, o){ return new THREE.MeshStandardMaterial(Object.assign({color: c, roughness: 0.7}, o || {})); }
function add(o, x, y, z, p){ o.position.set(x, y, z); p.add(o); return o; }
var c = {THREE, mat, box(w, h, d, m, x, y, z, p){ return add(new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m), x, y, z, p); },
  canvasTex(w, h, draw){ return {t: new THREE.Texture()}; }, glow(col, s, o){ return new THREE.Sprite(new THREE.SpriteMaterial({color: col, opacity: o, transparent: true})); }};
const B = GV.build(c, GV.place(pc.W, 5), {tier: 5, night: true});
let dc = 0; B.g.traverse(o => { if((o.isMesh || o.isSprite) && o.visible) dc++; });
B.setNight(false); const dayGlows = B.glows.filter(s => s.visible).length; B.setNight(true);
out.build = {dc, kind: B.kind, doors: B.doors.map(d => ({kind: d.kind, live: d.live, label: d.label, hit: B.hits[0].userData.door === d})),
  boxes: B.boxes.length, lod: B.lod.length, insideDoor: B.inside(B.door.x, B.door.z) || Math.hypot(B.door.x - B.doors[0].x, B.door.z - B.doors[0].z) < 4,
  insideFar: B.inside(B.x + 500, B.z + 500), top: B.top, dayGlows, nightGlows: B.glows.filter(s => s.visible).length};

/* ---------- circuits and the grid ---------- */
const list = await GV.circuits(), again = await GV.circuits();
const rows = GV.rows(list);
out.rows = {fetched, same: list === again, n: list.length, first: rows.slice(0, 2), sections: rows.filter(r => r.section).map(r => r.section),
  rounds: rows.filter(r => typeof r.round === "number").map(r => r.round), classicsSorted: (() => { const k = rows.slice(rows.findIndex(r => r.section === "Classics") + 1).map(r => r.name); return k.join("|") === k.slice().sort((a, b) => a.localeCompare(b)).join("|"); })(),
  empty: GV.rows(null).length};
out.grid = GV.grid(cat).map(v => v.brand);

/* ---------- the panel ---------- */
const stage = new El("div"), gone = [];
let driving = null;
const ui = GV.mountPanel(stage, {catalogue: () => cat, driving: () => driving, owned: () => ["bmw-m3-competition", "f1-williams-fw48"],
  go(o){ gone.push(o); }, onClose(g){ gone.push({closed: g}); }});
ui.open(); await new Promise(r => setTimeout(r, 0)); await new Promise(r => setTimeout(r, 0));
const R = ui.root, q = s => R.querySelectorAll(s);
out.panel = {role: R.getAttribute("role"), open: ui.isOpen(), cars: q(".hqgpv-car").length, options: q("[role=option]").length,
  ownedPick: q(".hqgpv-car").filter(b => b.getAttribute("aria-checked") === "true").map(b => b.dataset.id),
  firstPicked: q("[role=option]").filter(n => n.getAttribute("aria-selected") === "true").map(n => n.dataset.id)};
q("[role=option]").filter(n => n.dataset.id === "mc-1929")[0].click();
q(".hqgpv-car").filter(b => b.dataset.id === "f1-ferrari-sf-26")[0].click();
out.panel.chosen = R.querySelector(".hqgpv-chosen").textContent;
R.querySelector(".hqgpv-go").click();
out.panel.gone = gone.slice(); out.panel.closed = !ui.isOpen();
driving = "f1-mclaren-mcl40"; ui.open(); await new Promise(r => setTimeout(r, 0));
out.panel.drivingPick = q(".hqgpv-car").filter(b => b.getAttribute("aria-checked") === "true").map(b => b.dataset.id);
out.panel.keyOwned = GV.owns({target: q(".hqgpv-car")[0]}) && !GV.owns({target: new El("div")});
console.log(JSON.stringify(out));
"#;

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").canonicalize().unwrap()
}

fn run() -> Option<Value> {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("gp_venue.mjs");
    std::fs::write(&file, HARNESS).unwrap();
    let out = match Command::new("node").arg(&file).arg(root()).output() {
        Ok(o) => o,
        Err(_) => {
            eprintln!("node not installed: Grand Prix venue checks skipped");
            return None;
        }
    };
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    Some(serde_json::from_slice(&out.stdout).unwrap())
}

#[test]
fn the_grand_prix_circuit_in_the_city() {
    let Some(o) = run() else { return };
    // where it stands
    let p = &o["place"];
    assert_eq!(p["site"], json!({"id": "gp:0", "kind": "gp", "tier": 2, "name": "Grand Prix Circuit"}));
    assert_eq!(p["lotKind"], "gp", "the lot is the venue's now (worldbuild draws no building there)");
    assert_eq!(p["same"], true, "idempotent");
    assert_eq!(p["ownLot"], true, "a lot none of the other shops took");
    assert_eq!(p["others"], 4, "the dealership, the casino, the Pet shop and the Tuning shop placed first");
    assert!(p["F"]["w"].as_f64().unwrap() >= 26.0 && p["F"]["d"].as_f64().unwrap() >= 22.0, "{}", p["F"]);
    assert_eq!(p["places"], json!([{"label": "Grand Prix Circuit", "icon": "🏁"}]), "Go to lists it");
    assert!(o["place1"].is_null(), "not below tier 2");
    assert_eq!(o["island"]["id"], "gp:0", "an island from tier 2 has one too");
    // the venue
    let b = &o["build"];
    assert_eq!(b["kind"], "gp");
    assert_eq!(b["doors"], json!([{"kind": "gp", "live": true, "label": "Grand Prix Circuit", "hit": true}]));
    assert_eq!((b["boxes"].as_u64(), b["lod"].as_u64()), (Some(2), Some(2)), "the pit building and the grandstand block");
    assert_eq!((b["insideDoor"].as_bool(), b["insideFar"].as_bool()), (Some(true), Some(false)));
    assert!(b["top"].as_f64().unwrap() > 6.0);
    assert!(b["dc"].as_u64().unwrap() <= 40, "draw calls: {}", b["dc"]);
    assert_eq!(b["dayGlows"], 0);
    assert_eq!(b["nightGlows"], 4);
    // circuits and the grid
    let r = &o["rows"];
    assert_eq!((r["fetched"].as_u64(), r["same"].as_bool()), (Some(1), Some(true)), "fetched once");
    assert_eq!(r["n"], 40);
    assert_eq!(r["sections"], json!(["2026 calendar", "Classics"]));
    assert_eq!(r["first"], json!([{"section": "2026 calendar"}, {"id": "au-1953", "name": "Albert Park Circuit", "location": "Melbourne", "lengthM": 5278, "round": 1}]));
    let rounds: Vec<u64> = r["rounds"].as_array().unwrap().iter().map(|v| v.as_u64().unwrap()).collect();
    assert_eq!(rounds, (1..=rounds.len() as u64).collect::<Vec<_>>(), "the calendar in round order");
    assert_eq!(r["classicsSorted"], true);
    assert_eq!(r["empty"], 0);
    assert_eq!(o["grid"], json!(["McLaren", "Ferrari", "Red Bull Racing", "Mercedes-AMG", "Aston Martin", "Alpine", "Williams", "Racing Bulls", "Haas", "Audi", "Cadillac"]));
    // the panel
    let pn = &o["panel"];
    assert_eq!(pn["role"], "dialog");
    assert_eq!((pn["open"].as_bool(), pn["cars"].as_u64(), pn["options"].as_u64()), (Some(true), Some(11), Some(40)));
    assert_eq!(pn["ownedPick"], json!(["f1-williams-fw48"]), "an F1 car you own is preselected");
    assert_eq!(pn["firstPicked"], json!(["au-1953"]), "round 1 is picked to start");
    assert_eq!(pn["chosen"], "Circuit de Monaco · Ferrari SF-26");
    assert_eq!(pn["gone"], json!([{"closed": true}, {"circuit": "mc-1929", "vehicle": "f1-ferrari-sf-26"}]), "Go closes the panel and opens the Grand Prix");
    assert_eq!(pn["closed"], true);
    assert_eq!(pn["drivingPick"], json!(["f1-mclaren-mcl40"]), "the F1 car you drive comes with you");
    assert_eq!(pn["keyOwned"], true);
}
