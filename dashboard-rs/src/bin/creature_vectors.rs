//! The server's creature logic for HQ Notch's parity vectors
//! (notch/tools/parity_vectors.py): reads [{"sid", "prompts"}] on stdin and
//! prints [{"species", "stage", "shiny"}], with shiny under the salt given as
//! the only argument.
use claudehq::creature::{creature_for, shiny_for_species};
use serde_json::{json, Value};

fn main() {
    let salt = std::env::args().nth(1).expect("usage: creature_vectors SALT < rows.json");
    let rows: Vec<Value> = serde_json::from_reader(std::io::stdin()).expect("a JSON array on stdin");
    let out: Vec<Value> = rows
        .iter()
        .map(|r| {
            let cr = creature_for(r["sid"].as_str().unwrap_or(""), r["prompts"].as_i64().unwrap_or(0), &salt);
            let species = cr["species"].as_i64().unwrap_or(0);
            json!({"species": species, "stage": cr["stage"], "shiny": shiny_for_species(species, &salt)})
        })
        .collect();
    println!("{}", Value::Array(out));
}
