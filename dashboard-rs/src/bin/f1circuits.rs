//! Build games/gp/circuits.json (the Grand Prix circuits) from bacinger/f1-circuits (MIT).
//!
//!   cargo run --bin f1circuits -- f1-circuits.geojson f1-locations-2026.json [../games/gp/circuits.json]
//!
//! Both inputs come from <https://github.com/bacinger/f1-circuits> (MIT, Copyright (c) 2019-2025 Tomislav
//! Bacinger; the licence ships as games/gp/LICENSE-f1-circuits.md). Each circuit's centre line (lon/lat, in the
//! source's order: from the start line, in the race direction) becomes local metres round its own centre, x east
//! and z south (the Valley Rally frame: heading 0 = north = -z), scaled so the closed loop is the circuit's
//! published length. A closing point equal to the first is dropped: the line is a loop. Only geometry, names,
//! places, years and lengths are kept; nothing is fetched at runtime.
use claudehq::gp::{build_circuits, write_circuits};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() < 2 {
        eprintln!("usage: f1circuits SRC_GEOJSON CALENDAR_JSON [OUT]");
        std::process::exit(2);
    }
    let read = |p: &str| -> serde_json::Value {
        let s = std::fs::read_to_string(p).unwrap_or_else(|e| panic!("read {p}: {e}"));
        serde_json::from_str(&s).unwrap_or_else(|e| panic!("{p} is not JSON: {e}"))
    };
    let doc = build_circuits(&read(&args[0]), &read(&args[1]));
    let out = args.get(2).cloned().unwrap_or_else(|| concat!(env!("CARGO_MANIFEST_DIR"), "/../games/gp/circuits.json").to_string());
    std::fs::write(&out, write_circuits(&doc)).unwrap_or_else(|e| panic!("write {out}: {e}"));
    let n = doc["circuits"].as_array().map_or(0, Vec::len);
    println!("{n} circuits -> {out}");
}
