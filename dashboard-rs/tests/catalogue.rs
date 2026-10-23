//! games/vehicles/catalogue.json (the vehicle catalogue) and games/hqvehicles.js (its loader's helpers).
//!
//! The rules in docs/plans/dealership-spec.md: classes by kind, type and cc band; 1 to 4 listed vehicles per
//! class (slots 1-4, HQ 3.9; a class's own `slots` raises that, as the Formula 1 grid's 11 do, HQ 3.17); stable
//! ids; specs, dimensions and paints in sane ranges. (Ported from tests/test_hqvehicles.py.)
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::process::Command;

use regex::Regex;
use serde_json::Value;

const BIKE_TYPES: &[&str] = &["naked", "sport", "adventure", "cruiser", "scooter", "dirt", "classic", "hypersport"];
const CAR_TYPES: &[&str] = &["hatch", "sedan", "coupe", "suv", "pickup", "hyper", "super", "formula"];
const BIKE_BANDS: &[&str] = &["400", "950", "over950"];
const CAR_BANDS: &[&str] = &["2000", "3000", "5000", "over5000", "ev"];
const LAYOUTS: &[&str] = &["single", "parallel-twin", "v-twin", "boxer-twin", "inline-3", "inline-4", "inline-6", "v4", "crossplane-4",
    "v-twin-45", "v6", "v8", "v10", "v12", "w16", "v16", "electric"];
const ASPIRATION: &[&str] = &["na", "supercharged", "turbo", "twin-turbo", "quad-turbo", "electric"];
const SOUNDS: &[&str] = &["single", "twin", "vtwin", "boxer", "four", "six", "v6", "v8", "w16", "v16", "electric", "turbo4", "turbo6", "v8tt",
    "v10", "v12", "v4", "triple", "crossplane", "supercharged", "longstroke", "twin270", "vtwin45"];
const DRIVES: &[&str] = &["rwd", "fwd", "awd"];
const MAX_SLOTS: u64 = 4;

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
}
fn cat() -> Value {
    serde_json::from_str(&std::fs::read_to_string(root().join("games/vehicles/catalogue.json")).unwrap()).unwrap()
}
fn s(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}
fn f(v: &Value) -> f64 {
    v.as_f64().unwrap_or(f64::NAN)
}
fn classes(c: &Value) -> HashMap<String, Value> {
    c["classes"].as_array().unwrap().iter().map(|k| (s(&k["id"]).to_string(), k.clone())).collect()
}
fn vehicles(c: &Value) -> &Vec<Value> {
    c["vehicles"].as_array().unwrap()
}
/// coins per class tier (the spec's Economy) for when prices are set; tier 0 is the free starters.
/// FREE FOR ALL FOR NOW: every price is 0 (allowed in any tier) and every class's minLevel is 0.
fn price_band(tier: u64) -> (i64, i64) {
    match tier {
        0 => (0, 0),
        1 => (800, 1500),
        2 => (2500, 5000),
        3 => (8000, 15000),
        4 => (25000, 40000),
        _ => (100000, 500000),
    }
}
/// The spec's bands, written out again independently of games/hqvehicles.js.
fn band_of(kind: &str, cc: i64, electric: bool) -> &'static str {
    if electric {
        "ev"
    } else if kind == "bike" {
        if cc <= 400 { "400" } else if cc <= 950 { "950" } else { "over950" }
    } else if cc <= 2000 {
        "2000"
    } else if cc <= 3000 {
        "3000"
    } else if cc <= 5000 {
        "5000"
    } else {
        "over5000"
    }
}
fn slots_of(class: &Value) -> u64 {
    class["slots"].as_u64().unwrap_or(MAX_SLOTS)
}
fn listed(v: &Value, classes: &HashMap<String, Value>) -> bool {
    let max = classes.get(s(&v["class"])).map_or(MAX_SLOTS, slots_of);
    v["slot"].as_u64().is_some_and(|n| (1..=max).contains(&n))
}

#[test]
fn class_ids_kinds_bands_and_tiers() {
    let c = cat();
    let cls = classes(&c);
    assert_eq!(cls.len(), c["classes"].as_array().unwrap().len(), "class ids are unique");
    for (cid, k) in &cls {
        if cid == "starter" {
            assert_eq!((k["tier"].as_u64(), k["minLevel"].as_u64()), (Some(0), Some(0)));
            continue;
        }
        let parts: Vec<&str> = cid.split('.').collect();
        assert_eq!(parts.len(), 3, "{cid}");
        let (kind, typ, band) = (parts[0], parts[1], parts[2]);
        assert_eq!((s(&k["kind"]), s(&k["type"]), s(&k["band"])), (kind, typ, band), "{cid}");
        assert!(if kind == "bike" { BIKE_TYPES } else { CAR_TYPES }.contains(&typ), "{cid}");
        assert!(if kind == "bike" { BIKE_BANDS } else { CAR_BANDS }.contains(&band), "{cid}");
        assert!((1..=5).contains(&k["tier"].as_u64().unwrap_or(0)), "{cid}");
        assert!(k["minLevel"].as_u64().is_some_and(|l| l <= 100), "{cid}: the level a class needs, 0 = no gate");
        assert!(!s(&k["label"]).trim().is_empty(), "{cid}");
        if let Some(n) = k.get("slots") {
            assert!(n.as_u64().is_some_and(|n| (MAX_SLOTS..=12).contains(&n)), "{cid}: slots {n}");
        }
        if typ == "hyper" {
            assert!(["over5000", "ev"].contains(&band), "a hypercar is over 5000 cc or electric");
            assert_eq!(k["tier"], 5);
        }
        if band != "ev" {
            assert!(s(&k["label"]).contains("cc"), "{cid}: labels say the band in cc");
        }
    }
}

#[test]
fn ids_are_unique_and_stable_in_form() {
    let c = cat();
    let re = Regex::new(r"^[a-z0-9]+(-[a-z0-9]+)*$").unwrap();
    let mut seen = HashSet::new();
    for v in vehicles(&c) {
        let id = s(&v["id"]);
        assert!(seen.insert(id), "{id} twice");
        assert!(re.is_match(id) && id.len() <= 48, "{id}");
    }
}

#[test]
fn every_vehicle_is_in_a_class_that_fits_it() {
    let c = cat();
    let cls = classes(&c);
    for v in vehicles(&c) {
        let id = s(&v["id"]);
        let k = cls.get(s(&v["class"])).unwrap_or_else(|| panic!("{id}: no class"));
        if v["class"] == "starter" {
            assert_eq!((s(&v["slot"]), v["price"].as_i64()), ("starter", Some(0)), "{id}");
            continue;
        }
        let sp = &v["spec"];
        let el = sp["electric"].as_bool().unwrap();
        assert_eq!(band_of(s(&k["kind"]), sp["cc"].as_i64().unwrap(), el), s(&k["band"]), "{id}: {} cc is not band {}", sp["cc"], k["band"]);
        assert_eq!(v["body"], k["type"], "{id}: the stand-in body is the class type");
    }
}

#[test]
fn slots_per_class() {
    let c = cat();
    let cls = classes(&c);
    let mut by: HashMap<&str, Vec<u64>> = HashMap::new();
    for v in vehicles(&c) {
        let id = s(&v["id"]);
        let max = cls.get(s(&v["class"])).map_or(MAX_SLOTS, slots_of);
        match &v["slot"] {
            Value::String(t) => assert!(t == "reserve" || t == "starter", "{id}: slot {t}"),
            n => {
                let n = n.as_u64().unwrap_or(0);
                assert!((1..=max).contains(&n), "{id}: slot {n} of {max}");
                by.entry(s(&v["class"])).or_default().push(n);
            }
        }
    }
    for (cid, mut sl) in by {
        let max = cls.get(cid).map_or(MAX_SLOTS, slots_of) as usize;
        assert!(sl.len() <= max, "{cid}");
        sl.sort();
        assert_eq!(sl, (1..=sl.len() as u64).collect::<Vec<_>>(), "{cid}: slots filled in order from 1, each once");
    }
}

#[test]
fn specs_are_sane() {
    let c = cat();
    for v in vehicles(&c) {
        let (id, sp) = (s(&v["id"]), &v["spec"]);
        let bike = s(&v["class"]).starts_with("bike.") || BIKE_TYPES.contains(&s(&v["body"]));
        assert!(LAYOUTS.contains(&s(&sp["layout"])), "{id}");
        assert!(ASPIRATION.contains(&s(&sp["aspiration"])), "{id}");
        assert!(DRIVES.contains(&s(&sp["drive"])), "{id}");
        assert!(sp["hybrid"].is_boolean(), "{id}");
        assert!(SOUNDS.contains(&s(&v["sound"])), "{id}: sound {}", v["sound"]);
        let (cc, gears) = (sp["cc"].as_i64().unwrap(), sp["gears"].as_i64().unwrap());
        if sp["electric"] == true {
            assert_eq!((cc, sp["cyl"].as_i64().unwrap(), s(&sp["layout"]), s(&sp["aspiration"]), s(&v["sound"])), (0, 0, "electric", "electric", "electric"), "{id}");
            assert_eq!(gears, 1, "{id}");
        } else {
            // a scooter's CVT is one gear (games/hqvehiclephys.js: the revs climb with the speed)
            let geared = (4..=10).contains(&gears) || (v["body"] == "scooter" && gears == 1);
            assert!((50..=9000).contains(&cc) && (1..=16).contains(&sp["cyl"].as_i64().unwrap()) && geared, "{id}");
        }
        let (kw, kg, top) = (f(&sp["powerKw"]), f(&sp["massKg"]), f(&sp["topKmh"]));
        if bike {
            assert_eq!(sp["drive"], "rwd", "{id}");
            assert!((5.0..=200.0).contains(&kw) && (90.0..=350.0).contains(&kg) && (60.0..=330.0).contains(&top), "{id}");
        } else {
            assert!((30.0..=1500.0).contains(&kw) && (700.0..=3500.0).contains(&kg) && (60.0..=460.0).contains(&top), "{id}");
        }
        if !sp["torqueNm"].is_null() {
            assert!((10.0..=2000.0).contains(&f(&sp["torqueNm"])), "{id}");
        }
        if !sp["zeroTo100s"].is_null() {
            assert!((1.5..=20.0).contains(&f(&sp["zeroTo100s"])), "{id}");
        }
        assert!((1950..=2030).contains(&v["year"].as_i64().unwrap()), "{id}");
    }
}

#[test]
fn dimensions_are_sane() {
    let c = cat();
    for v in vehicles(&c) {
        let (id, d, body) = (s(&v["id"]), &v["dims"], s(&v["body"]));
        // a single-seater is long, low and wide-tracked: its own ranges
        let (ln, wd, ht) = if BIKE_TYPES.contains(&body) {
            ((1.6, 2.6), (0.6, 1.2), (0.9, 1.6))
        } else if body == "formula" {
            ((4.5, 6.0), (1.6, 2.1), (0.85, 1.2))
        } else {
            ((3.0, 6.0), (1.4, 2.2), (1.0, 2.1))
        };
        let (l, w, h, wb) = (f(&d["lengthM"]), f(&d["widthM"]), f(&d["heightM"]), f(&d["wheelbaseM"]));
        assert!(l >= ln.0 && l <= ln.1 && w >= wd.0 && w <= wd.1 && h >= ht.0 && h <= ht.1, "{id}: {d}");
        assert!(0.55 * l <= wb && wb < l, "{id}: {d}");
    }
}

#[test]
fn paints_and_prices() {
    let c = cat();
    let cls = classes(&c);
    let hex = Regex::new(r"^#[0-9a-f]{6}$").unwrap();
    for v in vehicles(&c) {
        let id = s(&v["id"]);
        let ps = v["paints"].as_array().unwrap();
        assert!((4..=6).contains(&ps.len()), "{id}: {} paints", ps.len());
        let names: HashSet<&str> = ps.iter().map(|p| s(&p["name"])).collect();
        assert_eq!(names.len(), ps.len(), "{id}: paint names unique");
        for p in ps {
            assert!(hex.is_match(s(&p["hex"])) && !s(&p["name"]).trim().is_empty(), "{id}: {p}");
        }
        let (lo, hi) = price_band(cls[s(&v["class"])]["tier"].as_u64().unwrap());
        let pr = v["price"].as_i64().expect("an integer price");
        assert!(pr == 0 || (lo..=hi).contains(&pr), "{id}: {pr} not 0 or in tier band {lo}-{hi}");
        if let Some(l) = v.get("livery") {
            for k in ["base", "accent", "trim"] {
                assert!(hex.is_match(s(&l[k])), "{id}: livery.{k}");
            }
        }
    }
}

#[test]
fn model3d_when_present_is_credited() {
    let c = cat();
    let re = Regex::new(r"^vehicles/[a-z][a-z0-9-]{0,40}\.glb$").unwrap();
    for v in vehicles(&c) {
        let m = &v["model3d"];
        if m.is_null() {
            continue;
        }
        assert!(re.is_match(s(&m["file"])), "{}", v["id"]);
        for k in ["licence", "author", "source"] {
            assert!(!s(&m[k]).trim().is_empty(), "{}: {k}", v["id"]);
        }
        assert!(s(&m["source"]).starts_with("https://"));
    }
}

#[test]
fn brand_and_model_are_text() {
    let c = cat();
    for v in vehicles(&c) {
        for k in ["brand", "model"] {
            let t = s(&v[k]);
            assert!(!t.trim().is_empty() && t.chars().count() <= 48, "{}: {k}", v["id"]);
        }
        assert!(v["pickedBy"].is_array());
    }
}

#[test]
fn the_starters_are_todays_car_and_motorbike() {
    let c = cat();
    let by: HashMap<&str, &Value> = vehicles(&c).iter().map(|v| (s(&v["id"]), v)).collect();
    let (car, moto) = (&by["starter-car"]["spec"], &by["starter-moto"]["spec"]);
    // hq3d.js VEHICLES: car top 22 m/s, moto 24 m/s, both 5 gears
    assert!((f(&car["topKmh"]) / 3.6 - 22.0).abs() <= 0.5);
    assert!((f(&moto["topKmh"]) / 3.6 - 24.0).abs() <= 0.5);
    assert_eq!((car["gears"].as_i64(), moto["gears"].as_i64()), (Some(5), Some(5)));
}

const LOADER: &str = r#"
const fs = require('fs'), path = require('path'), R0 = process.argv[1];
global.window = {HQV: {}};
let fetched = 0;
global.fetch = u => { fetched++; return Promise.resolve({ok: true, json: () => Promise.resolve(JSON.parse(fs.readFileSync(path.join(R0, u.replace(/^\//, '')), 'utf8')))}); };
eval(fs.readFileSync(path.join(R0, 'games/hqvehicles.js'), 'utf8'));
const V = window.HQV.hqVehicles;
(async () => {
  const cat = await V.load(), again = await V.load();
  const cls = V.classes(cat).map(c => c.id), sale = V.onSale(cat).map(c => c.id);
  console.log(JSON.stringify({
    same: cat === again, fetched, url: V.URL,
    bands: [V.bandOf('bike', 399), V.bandOf('bike', 400), V.bandOf('bike', 401), V.bandOf('bike', 950), V.bandOf('bike', 951),
            V.bandOf('car', 1998), V.bandOf('car', 2000), V.bandOf('car', 2993), V.bandOf('car', 4395), V.bandOf('car', 7993),
            V.bandOf('car', 0, true), V.bandOf('bike', 0, true)],
    cls, sale,
    hyper: V.byClass(cat, 'car.hyper.over5000').map(v => [v.id, v.slot]),
    formula: V.byClass(cat, 'car.formula.2000').filter(v => V.isSlot(v, cat)).length,
    get: V.get(cat, 'ktm-390-duke') && V.get(cat, 'ktm-390-duke').model, none: V.get(cat, 'nope'),
    empty: [V.classes(null).length, V.byClass(null, 'x').length, V.onSale({}).length]
  }));
})();
"#;

/// The loader's helpers under node (skipped where node is not installed).
#[test]
fn loader_helpers_under_node() {
    let out = match Command::new("node").arg("-e").arg(LOADER).arg(root()).output() {
        Ok(o) => o,
        Err(_) => {
            eprintln!("node not installed: loader checks skipped");
            return;
        }
    };
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    let o: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(o["same"], true, "loaded once");
    assert_eq!(o["fetched"], 1);
    assert_eq!(o["url"], "/games/vehicles/catalogue.json");
    assert_eq!(o["bands"], serde_json::json!(["400", "400", "950", "950", "over950", "2000", "2000", "3000", "5000", "over5000", "ev", "ev"]));
    let cls: Vec<&str> = o["cls"].as_array().unwrap().iter().map(s).collect();
    assert!(!cls.contains(&"starter"));
    let kinds: Vec<&str> = cls.iter().map(|c| c.split('.').next().unwrap()).collect();
    let mut sorted = kinds.clone();
    sorted.sort();
    assert_eq!(kinds, sorted, "bikes before cars");
    assert_eq!(cls.iter().filter(|c| c.starts_with("bike.naked.")).copied().collect::<Vec<_>>(), ["bike.naked.400", "bike.naked.950", "bike.naked.over950"]);
    // on sale: every class listing 1 to its slots (4 unless the class says)
    let c = cat();
    let k = classes(&c);
    let mut full: Vec<&str> = c["classes"].as_array().unwrap().iter().map(|x| s(&x["id"])).filter(|cid| {
        let n = vehicles(&c).iter().filter(|v| s(&v["class"]) == *cid && listed(v, &k)).count() as u64;
        *cid != "starter" && n >= 1 && n <= slots_of(&k[*cid])
    }).collect();
    full.sort();
    let mut sale: Vec<&str> = o["sale"].as_array().unwrap().iter().map(s).collect();
    sale.sort();
    assert_eq!(sale, full);
    assert!(full.len() >= 10 && full.contains(&"car.formula.2000"));
    assert_eq!(o["formula"], 11, "all 11 of the grid are listed");
    assert_eq!(o["hyper"], serde_json::json!([["bugatti-chiron-super-sport", 1], ["bugatti-tourbillon", 2], ["bugatti-veyron", "reserve"]]));
    assert_eq!(o["get"], "390 Duke");
    assert!(o["none"].is_null());
    assert_eq!(o["empty"], serde_json::json!([0, 0, 0]));
}
