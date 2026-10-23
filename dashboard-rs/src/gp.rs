//! Grand Prix data (HQ 3.17, docs/plans/grand-prix-spec.md): the circuits file games/gp/circuits.json and
//! the F1 grid in games/vehicles/catalogue.json. `build_circuits` is the converter behind the `f1circuits`
//! tool (src/bin/f1circuits.rs); the tests check the committed files the browser loads.
use serde_json::{json, Map, Value};

const R_EQ: f64 = 6_378_137.0;

/// [[lon, lat], ...] -> [[x, z], ...] metres round the bounding-box centre (x east, z south).
pub fn to_local(coords: &[[f64; 2]]) -> Vec<[f64; 2]> {
    let (mut lo0, mut lo1, mut la0, mut la1) = (f64::MAX, f64::MIN, f64::MAX, f64::MIN);
    for c in coords {
        lo0 = lo0.min(c[0]);
        lo1 = lo1.max(c[0]);
        la0 = la0.min(c[1]);
        la1 = la1.max(c[1]);
    }
    let (lon0, lat0) = ((lo0 + lo1) / 2.0, (la0 + la1) / 2.0);
    let kz = 1f64.to_radians() * R_EQ;
    let kx = kz * lat0.to_radians().cos();
    coords.iter().map(|c| [(c[0] - lon0) * kx, -(c[1] - lat0) * kz]).collect()
}

/// The length of the closed loop through `pts` (back to the first point).
pub fn loop_length(pts: &[[f64; 2]]) -> f64 {
    let n = pts.len();
    (0..n).map(|i| {
        let (a, b) = (pts[i], pts[(i + 1) % n]);
        (b[0] - a[0]).hypot(b[1] - a[1])
    }).sum()
}

fn r1(v: f64) -> f64 {
    (v * 10.0).round() / 10.0
}

/// The circuits document from the source GeoJSON and its season calendar (a list of `{id}` in round order).
pub fn build_circuits(geo: &Value, calendar: &Value) -> Value {
    let rounds: Vec<&str> = calendar.as_array().map_or(vec![], |a| a.iter().filter_map(|c| c["id"].as_str()).collect());
    let mut out: Vec<Value> = Vec::new();
    for f in geo["features"].as_array().into_iter().flatten() {
        let (p, g) = (&f["properties"], &f["geometry"]);
        if g["type"] != "LineString" {
            continue;
        }
        let mut coords: Vec<[f64; 2]> = g["coordinates"].as_array().into_iter().flatten()
            .filter_map(|c| Some([c.get(0)?.as_f64()?, c.get(1)?.as_f64()?])).collect();
        if coords.len() < 8 {
            continue;
        }
        let (a, b) = (coords[0], coords[coords.len() - 1]);
        if (a[0] - b[0]).hypot(a[1] - b[1]) < 1e-7 {
            coords.pop();
        }
        let mut pts = to_local(&coords);
        let (want, have) = (p["length"].as_f64().unwrap_or(0.0), loop_length(&pts));
        let k = if want > 0.0 && have > 0.0 && (0.8..1.25).contains(&(want / have)) { want / have } else { 1.0 };
        for q in pts.iter_mut() {
            *q = [r1(q[0] * k), r1(q[1] * k)];
        }
        let id = p["id"].as_str().unwrap_or("").to_string();
        let round = rounds.iter().position(|r| *r == id).map(|i| i + 1);
        out.push(json!({
            "id": id, "name": p["Name"], "location": p["Location"].as_str().unwrap_or(""),
            "lengthM": loop_length(&pts).round() as i64, "opened": p["opened"], "firstGp": p["firstgp"],
            "round": round, "pts": pts,
        }));
    }
    out.sort_by(|a, b| {
        let key = |c: &Value| (c["round"].is_null(), c["round"].as_u64().unwrap_or(0), c["name"].as_str().unwrap_or("").to_string());
        key(a).cmp(&key(b))
    });
    json!({
        "version": 1,
        "note": "Grand Prix circuits (docs/plans/grand-prix-spec.md). Built by dashboard-rs/src/bin/f1circuits.rs from bacinger/f1-circuits (MIT, see LICENSE-f1-circuits.md). x east, z south, metres; a closed loop from the start line in the race direction.",
        "source": "https://github.com/bacinger/f1-circuits",
        "calendar": 2026,
        "circuits": out,
    })
}

/// The file as committed: the header keys one per line, then one circuit per line (diffs stay readable).
pub fn write_circuits(doc: &Value) -> String {
    let mut s = String::from("{\n");
    for k in ["version", "note", "source", "calendar"] {
        s += &format!("  {}: {},\n", json!(k), doc[k]);
    }
    s += "  \"circuits\": [\n";
    let rows: Vec<String> = doc["circuits"].as_array().into_iter().flatten().map(|c| format!("    {c}")).collect();
    s += &rows.join(",\n");
    s += "\n  ]\n}\n";
    s
}

/// The F1 class of the vehicle catalogue and its cars, in slot order.
pub fn formula_grid(cat: &Value) -> (Option<&Map<String, Value>>, Vec<&Map<String, Value>>) {
    let class = cat["classes"].as_array().into_iter().flatten().filter_map(Value::as_object).find(|c| c["type"] == "formula");
    let id = class.and_then(|c| c["id"].as_str()).unwrap_or("");
    let mut cars: Vec<&Map<String, Value>> = cat["vehicles"].as_array().into_iter().flatten().filter_map(Value::as_object)
        .filter(|v| v["class"] == id).collect();
    cars.sort_by_key(|v| v["slot"].as_u64().unwrap_or(99));
    (class, cars)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    fn load(rel: &str) -> Value {
        let p = format!("{}/../{rel}", env!("CARGO_MANIFEST_DIR"));
        serde_json::from_str(&std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("{p}: {e}"))).unwrap()
    }
    fn pts(c: &Value) -> Vec<[f64; 2]> {
        c["pts"].as_array().unwrap().iter().map(|q| [q[0].as_f64().unwrap(), q[1].as_f64().unwrap()]).collect()
    }

    #[test]
    fn local_metres_are_east_and_south() {
        // a 0.01 degree square at the equator: ~1113 m a side, north is -z
        let p = to_local(&[[0.0, 0.0], [0.01, 0.0], [0.01, 0.01], [0.0, 0.01]]);
        assert!((p[1][0] - p[0][0] - 1113.2).abs() < 0.5, "east is +x");
        assert!((p[3][1] - p[0][1] + 1113.2).abs() < 0.5, "north is -z");
        assert!((loop_length(&p) - 4452.8).abs() < 2.0);
    }

    #[test]
    fn build_scales_to_the_published_length_and_drops_the_closing_point() {
        let geo = json!({"features": [{"properties": {"id": "xx-2000", "Name": "Test Ring", "Location": "Here", "length": 5000, "opened": 2000, "firstgp": 2001},
            "geometry": {"type": "LineString", "coordinates": (0..=12).map(|i| {
                let a = (i % 12) as f64 / 12.0 * std::f64::consts::TAU;
                [0.0072 * a.cos(), 0.0072 * a.sin()]
            }).collect::<Vec<_>>()}}]});
        let d = build_circuits(&geo, &json!([{"id": "xx-2000"}]));
        let c = &d["circuits"][0];
        assert_eq!(c["pts"].as_array().unwrap().len(), 12, "the repeated first point is dropped");
        assert!((c["lengthM"].as_i64().unwrap() - 5000).abs() <= 1);
        assert_eq!(c["round"], 1);
        let back: Value = serde_json::from_str(&write_circuits(&d)).unwrap();
        assert_eq!(back, d, "the written file reads back the same");
    }

    #[test]
    fn the_committed_circuits_are_sane_loops() {
        let d = load("games/gp/circuits.json");
        let cs = d["circuits"].as_array().unwrap();
        assert!(cs.len() >= 24, "every circuit of the source: {}", cs.len());
        let mut ids = HashSet::new();
        let mut rounds = vec![];
        let id_re = regex::Regex::new(r"^[a-z]{2}-\d{4}$").unwrap();
        for c in cs {
            let id = c["id"].as_str().unwrap();
            assert!(ids.insert(id), "{id} twice");
            assert!(id_re.is_match(id), "{id}");
            assert!(!c["name"].as_str().unwrap().is_empty());
            let p = pts(c);
            assert!(p.len() >= 40, "{id}: {} points", p.len());
            let len = loop_length(&p);
            assert!((3000.0..7500.0).contains(&len), "{id}: {len} m");
            assert!((len - c["lengthM"].as_f64().unwrap()).abs() < 2.0, "{id}: lengthM is the loop");
            let n = p.len();
            for i in 0..n {
                let (a, b) = (p[i], p[(i + 1) % n]);
                assert!((a[0] - b[0]).hypot(a[1] - b[1]) < 900.0, "{id}: a gap of over 900 m at {i}");
                assert!(a[0].abs() < 2000.0 && a[1].abs() < 2000.0, "{id}: centred");
            }
            if let Some(r) = c["round"].as_u64() {
                rounds.push(r);
            }
        }
        rounds.sort();
        assert_eq!(rounds, (1..=rounds.len() as u64).collect::<Vec<_>>(), "rounds 1..n, each once");
        assert!(rounds.len() >= 20, "the season's calendar");
    }

    #[test]
    fn the_f1_grid_is_in_the_catalogue() {
        let cat = load("games/vehicles/catalogue.json");
        let (class, cars) = formula_grid(&cat);
        let class = class.expect("a formula class");
        assert_eq!(class["kind"], "car");
        let slots = class["slots"].as_u64().unwrap_or(4) as usize;
        assert_eq!(cars.len(), 11, "the 2026 grid: 11 teams");
        assert!(cars.len() <= slots, "the class lists them all");
        let mut teams = HashSet::new();
        let hex = regex::Regex::new(r"^#[0-9a-f]{6}$").unwrap();
        for (i, v) in cars.iter().enumerate() {
            assert_eq!(v["slot"].as_u64(), Some(i as u64 + 1), "{}: slots in order", v["id"]);
            assert_eq!(v["body"], "formula");
            assert!(teams.insert(v["brand"].as_str().unwrap()), "one car a team");
            let s = &v["spec"];
            assert_eq!(s["cc"], 1600);
            assert!((700..=900).contains(&s["massKg"].as_i64().unwrap()), "{}", v["id"]);
            assert!((320..=360).contains(&s["topKmh"].as_i64().unwrap()));
            let paints = v["paints"].as_array().unwrap();
            assert!(!paints.is_empty() && paints.len() <= 6);
            for p in paints {
                assert!(hex.is_match(p["hex"].as_str().unwrap()));
            }
            let liv = &v["livery"];
            for k in ["base", "accent", "trim"] {
                assert!(hex.is_match(liv[k].as_str().unwrap_or("")), "{}: livery.{k}", v["id"]);
            }
        }
    }

    #[test]
    fn the_server_copy_of_the_catalogue_matches() {
        let a = std::fs::read(format!("{}/../games/vehicles/catalogue.json", env!("CARGO_MANIFEST_DIR"))).unwrap();
        let b = std::fs::read(format!("{}/../backend/data/vehicles.json", env!("CARGO_MANIFEST_DIR"))).unwrap();
        assert!(a == b, "backend/data/vehicles.json is a byte copy of games/vehicles/catalogue.json");
    }
}
