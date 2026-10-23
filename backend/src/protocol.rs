//! Protocol version + capabilities per game, mirroring `PROTOCOL` in
//! backend/app/valley.py. The room welcome lists the games this Arena runs (only
//! the real-time ones here) so a client can tell "this Arena is too old for me"
//! from "I am too old for this Arena" before it joins; every game message also
//! carries `pv`. Keep in step with the Python table and games/multi.js.

use serde_json::{json, Value};

/// (game, version, capabilities) for every game this server referees, in
/// `valley.GAMES` order -- the order reaches the wire, because `arena_info`
/// builds its map by walking this and `serde_json` preserves insertion order.
///
/// Python gives every game `{"v": 1, "caps": []}` and overrides only kart
/// (valley.py:66-67), so a new game joins this table with v1 and no caps.
pub const GAMES: &[(&str, i64, &[&str])] = &[
    ("pond", 1, &[]),
    ("race", 1, &[]),
    ("duel", 1, &[]),
    ("mines", 1, &[]),
    ("farm", 1, &[]),
    ("golf", 1, &[]),
    ("kart", 2, &["scale", "tracks"]), // v2: geometry scale + server track list
    ("plat", 1, &[]),
    ("fps", 1, &[]),
    // v2: the launcher — server-flown rockets, "r"/"b" snapshot rows, 8-tall shot echoes.
    // v3: Sprinting — the pos message carries a "sp" flag; the server raises its speed cap
    // for sprinting clients to RUN x SPRINT (the two tests/strike_sync impls keep the same numbers).
    // v4: parachute respawns — a spawn may lift the life to map-height with a "drop" hint in
    // the spawn event, and the referee lets that life ride above the floor for DROP_TIME
    // seconds before the usual MAX_AIR guard kicks in (a v4 client that never drops is
    // exactly the v1-v3 shape it always was).
    // v5 + "maps": the host names an arena on start (`map`); the roster view carries it back.
    // v6 Wave C: 28 new totems, the 5 drop mechanics (hot / fused / cursed / arena events /
    // contested capture), the radar world extras, and the `cheat` event for Second Wind / Phoenix.
    // v7 Wave D: 10 arena-wide Disaster totems (Sandstorm … EMP Apocalypse), the disaster
    // clock, snap keys "di" (the live disaster) and "dm" (pending impact marks), and the
    // `disaster` event (warn/hold in ms, or {kind:"clear"}).
    // v8 Wave E: Disaster totems get their own drop ring and clock (`DIS_SLOTS` /
    // `DIS_GAP_DROP`); `di` grew a 5th field — ms until the next automatic disaster —
    // always present (row is [null,0,0,0,ms] when nothing is live) so the top bar can
    // count "⚠ disaster in Xs" down among score and time remaining.
    // v9 Wave F/G: every disaster is visual AND impact on one shared geometry.
    // `di` grows fields 5-7 (frozen seed, toxic cloud centres, sinkhole pit) so the
    // client paints the same clouds/pit the judge damages; `dm` rows grow dmg + quake
    // so impact marks carry their hit; hurricane chips DD_WIND_DMG while it shoves.
    // Player flags grow FLAG_BLIND / FLAG_SLOW (white-out veil / disaster crawl).
    // The Warden (additive on v9): `start.warden` = 1|0 (absent defaults true);
    // snap `"wd"` = [hp,max,cm_x,cm_z,ms_slab_arm,ms_slab_land,ms_laser_warn,laser_on_ms,laser_yaw_cdeg,ms_dis,ck_bits,yaw_cdeg,ms_core,ms_grip_warn,ms_grip_on,ms_grip_at];
    // event `"warden"` {phase:"rise"|"ckpt"|"dead", ck?, hp, max, x?, z?, armL?, armR?}.
    // Never use `"ev"` for that row — Out::msg owns it.
    // Match flight drones + grappling gun (still additive on v9): snap `"dr"` =
    // [[id, cm_x, cm_y, cm_z], …]; a hooked fighter carries FLAG_HOOK (1<<26) and
    // cannot shoot. The grapple is weapon index 4 (LAUNCH_W stays 3 / the rocket).
    ("strike", 9, &["maps"]),
    // v2: the generated 3D City. "alt": pos may carry h (feet height, cm) and p (pitch, deg); x/z span +-102_400 cm; floor "city3d"
    // v3: Cities. "isles": the floor may be a world's own room, "city3d:<world id>" (valley/hq.rs floor_ok)
    // "fly": a = 7 (a helicopter), 8 (an attack helicopter), at the height `h` ("alt")
    // "plane" (HQ 3.2): a = 9 (the seaplane), 10 (the prop plane), at the height `h`; a page sends them only where listed
    // v4 "vehicles": while driving (a = 5 / 6), `v` names the catalogue vehicle and `vp` its paint
    // "airliner" (HQ 3.8): a = 11 (the regional jet), 12 (the narrow-body airliner), at the height `h`; only where listed
    // "boombox" (HQ 3.11): pos may carry bb (a YouTube id), bt (its song's start, Arena-clock epoch ms) and bn (its title)
    // "convoy" (HQ 3.12): pos may carry ci (a user id you invite), cv (the user id you follow) and cg ([x, z] cm, where you lead)
    // "tuning" (HQ 3.13): while driving (a = 5 / 6), vt: the vehicle's tuning as tuning.rs's short code (at most 33 characters)
    // "pets" (HQ 3.14): pos may carry pt, up to 2 [species, variant, acc, stage, name] (backend/src/pets.rs)
    // "hqstyle" (HQ Studio, 3.15): /v1/hq/me/style + style in the HQ listing
    // "motion": pos may carry t (the sender's clock, ms), vx / vz (cm/s), yr (deg/s) and rpm, so a listener can draw
    // them smoothly between frames of their own clock (valley/hq.rs Motion)
    ("hq", 4, &["ride", "look", "skate", "drive", "alt", "isles", "fly", "plane", "vehicles", "airliner", "boombox", "convoy", "tuning", "pets", "hqstyle", "motion"]),  // "ride": a = 3 (on a bike); "look": the 3D character (`c`); "skate": a = 4 + its trick `k` and height `y`; "drive": a = 5 (a car), 6 (a motorbike)
    ("type", 1, &[]),
    ("td", 1, &[]),
    ("bowl", 1, &[]),
    // Valley Rally (HQ 2.7, Rust-only): its own hub (rally.rs).
    ("rally", 1, &[]),
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
///
/// The `party` key is load-bearing, not decoration: the page gates its whole
/// Party Mode panel on it, and without it says "This Arena doesn't run parties
/// yet" however well party.rs works.
pub fn arena_info() -> Value {
    let mut games = serde_json::Map::new();
    for (g, v, caps) in GAMES {
        games.insert((*g).to_string(), json!({"v": v, "caps": caps}));
    }
    json!({"impl": "rs", "games": games,
           "party": {"v": 1, "order": crate::valley::party::ORDER},
           // Now Playing (/v1/music/now) and listen-along rooms ({"type": "music"}).
           "music": {"v": 1}, "maps": {"v": 1}})
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn table_matches_python() {
        let info = arena_info();
        assert_eq!(info["impl"], "rs");
        assert_eq!(info["maps"], json!({"v": 1}));
        assert_eq!(info["games"]["kart"], json!({"v": 2, "caps": ["scale", "tracks"]}));
        assert_eq!(info["games"]["plat"], json!({"v": 1, "caps": []}));
        // HQ presence carries a = 3 (a bike), 4 (skating), 5 / 6 (a car / a motorbike) only where these are listed.
        // "alt" (v2): h / p ride along, x / z span the 2 km world, floor "city3d".
        // "isles" (v3): the floor may be a world's own room, city3d:<world id>.
        // "vehicles" (v4): while driving, v / vp name the catalogue vehicle and its paint.
        assert_eq!(info["games"]["hq"], json!({"v": 4, "caps": ["ride", "look", "skate", "drive", "alt", "isles", "fly", "plane", "vehicles", "airliner", "boombox", "convoy", "tuning", "pets", "hqstyle", "motion"]}));
        assert_eq!(version("fps"), 1);
        assert_eq!(version("pond"), 1);
        // An unknown game still answers 1, as Python's PROTOCOL.get(g, {}) does.
        assert_eq!(version("nosuchgame"), 1);
    }

    #[test]
    fn the_welcome_advertises_every_game_in_pythons_order() {
        // valley.py:59. The order reaches the wire, so it is asserted on the
        // serialised form -- serde_json::Map's PartialEq ignores key order.
        let info = arena_info();
        let keys: Vec<&String> = info["games"].as_object().unwrap().keys().collect();
        assert_eq!(keys, ["pond", "race", "duel", "mines", "farm", "golf", "kart",
                          "plat", "fps", "strike", "hq", "type", "td", "bowl", "rally"]
                       .iter().map(|s| s.to_string()).collect::<Vec<_>>()
                       .iter().collect::<Vec<_>>());
        // Every game this Arena advertises, it referees.
        for (g, _, _) in GAMES {
            assert!(runs(g), "{g} is advertised but runs() denies it");
        }
    }

    #[test]
    fn the_welcome_carries_the_party_key_the_page_gates_on() {
        // valley.py:72. Without this the page hides Party Mode outright.
        let info = arena_info();
        assert_eq!(info["party"], json!({"v": 1, "order": ["kart", "plat", "fps", "golf"]}));
        assert_eq!(info["maps"], json!({"v": 1}));
    }
}
