//! Generate a world and print it.
//!
//!   cargo run --release --bin worldgen -- claude-hq@1             summary
//!   cargo run --release --bin worldgen -- claude-hq@1 --json > w.json
//!   cargo run --release --bin worldgen -- claude-hq@1 --edits edits.json --json
use std::time::Instant;

#[path = "../worldgen/mod.rs"]
#[allow(dead_code)] // the server uses parts this tool does not
mod worldgen;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let id = args.first().map(String::as_str).unwrap_or("claude-hq@1");
    let edits: Vec<worldgen::Edit> = match args.iter().position(|a| a == "--edits") {
        Some(k) => {
            let path = args.get(k + 1).expect("--edits needs a file");
            serde_json::from_str(&std::fs::read_to_string(path).expect("read edits")).expect("edits are a JSON list")
        }
        None => Vec::new(),
    };
    let t0 = Instant::now();
    let w = match worldgen::generate(id, &edits) {
        Ok(w) => w,
        Err(e) => {
            eprintln!("worldgen: {e}");
            std::process::exit(1);
        }
    };
    let ms = t0.elapsed().as_millis();
    if args.iter().any(|a| a == "--json") {
        println!("{}", serde_json::to_string(&w).unwrap());
        return;
    }
    let l = &w.layers;
    let hs = &l.terrain.heights;
    let count = |k: &str| l.roads.edges.iter().filter(|e| e.class == k).count();
    println!("world {}  ({} ms)  fingerprint {}", w.id, ms, w.hashes.world);
    println!("  terrain   {}x{} vertices, {} m apart, heights {}..{} m", l.terrain.n, l.terrain.n, l.terrain.cell_cm / 100,
             hs.iter().min().unwrap() / 100, hs.iter().max().unwrap() / 100);
    println!("  blocks    {}", l.blocks.len());
    let mut by = std::collections::BTreeMap::new();
    for b in &l.blocks {
        *by.entry(l.districts.legend[b.district as usize]).or_insert(0) += 1;
    }
    println!("            {by:?}");
    println!("  roads     {} nodes, {} edges ({} avenue, {} street, {} country)", l.roads.nodes.len(), l.roads.edges.len(),
             count("avenue"), count("street"), count("country"));
    println!("  lots      {} ({} HQ in the pool)", l.lots.len(), l.lots.iter().filter(|x| x.kind == "hq").count());
    println!("  sites     {}", l.sites.iter().map(|s| s.id.as_str()).collect::<Vec<_>>().join(" "));
    println!("  json      {} KB", serde_json::to_vec(&w).unwrap().len() / 1024);
}
