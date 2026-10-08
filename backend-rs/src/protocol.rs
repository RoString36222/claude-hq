//! Protocol version + capabilities per game, mirroring `PROTOCOL` in
//! backend/app/valley.py. The room welcome lists the games this Arena runs (only
//! the real-time ones here) so a client can tell "this Arena is too old for me"
//! from "I am too old for this Arena" before it joins; every game message also
//! carries `pv`. Keep in step with the Python table and games/multi.js.

use serde_json::{json, Value};

/// (game, version, capabilities) for every game this server referees.
pub const GAMES: &[(&str, i64, &[&str])] = &[
    ("kart", 2, &["scale", "tracks"]), // v2: geometry scale + server track list
    ("plat", 1, &[]),
    ("fps", 1, &[]),
];

/// The protocol version of game `g` (1 for a game this server does not know).
pub fn version(g: &str) -> i64 {
    GAMES.iter().find(|(n, _, _)| *n == g).map(|(_, v, _)| *v).unwrap_or(1)
}

/// Does this Arena referee game `g`? The one place anything asks, so a game
/// landing in [`GAMES`] opens every surface gated on it at once.
pub fn runs(g: &str) -> bool {
    GAMES.iter().any(|(n, _, _)| *n == g)
}

/// What this Arena runs, for the room welcome.
pub fn arena_info() -> Value {
    let mut games = serde_json::Map::new();
    for (g, v, caps) in GAMES {
        games.insert((*g).to_string(), json!({"v": v, "caps": caps}));
    }
    json!({"impl": "rs", "games": games})
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn table_matches_python() {
        let info = arena_info();
        assert_eq!(info["impl"], "rs");
        assert_eq!(info["games"]["kart"], json!({"v": 2, "caps": ["scale", "tracks"]}));
        assert_eq!(info["games"]["plat"], json!({"v": 1, "caps": []}));
        assert_eq!(version("fps"), 1);
        assert_eq!(version("pond"), 1);
    }
}
