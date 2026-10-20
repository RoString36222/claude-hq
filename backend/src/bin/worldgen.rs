//! Generate a world and print it.
//!
//!   cargo run --release --bin worldgen -- claude-hq@1             summary
//!   cargo run --release --bin worldgen -- claude-hq@1 --json > w.json
//!   cargo run --release --bin worldgen -- claude-hq@1 --edits edits.json --json
//!   cargo run --release --bin worldgen -- claude-hq@1 --samples       probe points for client tests
//!   cargo run --release --bin worldgen -- claude-hq@2                 the Commons (organic)
//!   cargo run --release --bin worldgen -- user:<uuid>@2               a personal island
use std::time::Instant;

use serde::Serialize;

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
    if args.iter().any(|a| a == "--samples") {
        println!("{}", serde_json::to_string(&samples(&w)).unwrap());
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
    let classes = if w.version == 1 {
        format!("{} avenue, {} street", count("avenue"), count("street"))
    } else {
        format!("{} arterial, {} local", count("arterial"), count("local"))
    };
    println!("  roads     {} nodes, {} edges ({classes}, {} highway, {} ring)", l.roads.nodes.len(), l.roads.edges.len(),
             count("highway"), count("ring"));
    println!("  lots      {} ({} HQ in the pool)", l.lots.len(), l.lots.iter().filter(|x| x.kind == "hq").count());
    println!("  sites     {}", l.sites.iter().map(|s| s.id.as_str()).collect::<Vec<_>>().join(" "));
    println!("  json      {} KB", serde_json::to_vec(&w).unwrap().len() / 1024);
}

#[derive(Serialize)]
struct Samples {
    world: String,
    samples: Vec<Sample>,
}

/// What the generator says is at one point: for clients that must agree with it.
#[derive(Serialize)]
struct Sample {
    x: i64,
    z: i64,
    height: i64,
    /// The district's index into `layers.districts.legend`, and its name.
    district: u8,
    #[serde(rename = "districtName")]
    district_name: &'static str,
    /// Ids of the first lot / site (by id) whose footprint holds the point: its polygon
    /// in an organic world, else its rectangle, edges included.
    lot: Option<u32>,
    site: Option<String>,
}

/// Probe points: a 20 x 20 grid over the world (37 cm off the terrain lattice),
/// every 25th lot's centre, the first 3 points of every 20th road edge, every site's centre.
fn samples(w: &worldgen::WorldDoc) -> Samples {
    let l = &w.layers;
    let cell = w.size_cm / 20;
    let mut at: Vec<(i64, i64)> = Vec::new();
    for j in 0..20 {
        for i in 0..20 {
            at.push((-w.size_cm / 2 + i * cell + cell / 2 + 37, -w.size_cm / 2 + j * cell + cell / 2 + 37));
        }
    }
    at.extend(l.lots.iter().step_by(25).map(|o| (o.x, o.z)));
    at.extend(l.roads.edges.iter().step_by(20).flat_map(|e| e.points.iter().take(3).map(|q| (q[0], q[2]))));
    at.extend(l.sites.iter().map(|s| (s.x, s.z)));
    // a footprint polygon (@2) by the generator's crossing rule, else the rectangle, edges included
    let inside = |x: i64, z: i64, poly: &Option<Vec<[i64; 2]>>, ox: i64, oz: i64, ow: i64, od: i64| match poly {
        Some(p) => worldgen::organic::geom::inside((x, z), &p.iter().map(|q| (q[0], q[1])).collect::<Vec<_>>()),
        None => 2 * (x - ox).abs() <= ow && 2 * (z - oz).abs() <= od,
    };
    Samples {
        world: w.hashes.world.clone(),
        samples: at
            .into_iter()
            .map(|(x, z)| {
                let district = l.districts.at(x, z);
                Sample {
                    x,
                    z,
                    height: l.terrain.height_at(x, z),
                    district,
                    district_name: l.districts.legend[district as usize],
                    lot: l.lots.iter().find(|o| inside(x, z, &o.poly, o.x, o.z, o.w, o.d)).map(|o| o.id),
                    site: l.sites.iter().find(|s| inside(x, z, &s.poly, s.x, s.z, s.w, s.d)).map(|s| s.id.clone()),
                }
            })
            .collect(),
    }
}
