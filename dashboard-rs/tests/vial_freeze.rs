//! The Overflow Vial freeze, pinned from the live machine (2026-10-31).
//!
//! The ledger held `{"version": 1, "deposits": [], "spent": [], "seenPrompts": 1267}`
//! while 16 Apex cards carried 1204 surplus prompts — 6020 XP the Village said
//! had been poured and the bank refused to hold. The global watermark is a
//! high-water mark over a sum that can fall (a card leaving the list), so once
//! it got ahead of the live total it gated every later pour.
//!
//! These tests replay that exact state through the real `payload_vial` and
//! require the bank to pay what the pour already promised.

use claudehq::app::{App, Paths};
use claudehq::creature::STAGE_THRESHOLDS;
use serde_json::{json, Value};
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;

/// The 16 Apex cards as the live payload listed them: sessionId -> surplus
/// prompts past Apex (promptCount - 70). Sums to 1204; `vialPoured` summed to 6020.
const LIVE_CARDS: [(&str, i64); 16] = [
    ("02829144-325e-4cf6-b4ca-baea8b19bda7", 70),
    ("1682da5b-7223-4b04-bd0b-7f8aba96e117", 40),
    ("1a9212dd-c9ef-4cc7-ae25-32172e9001f5", 16),
    ("2cc4b798-4d61-431d-9898-177a0e8a3194", 17),
    ("3afadeab-7eae-492d-919f-e07afcf559e8", 34),
    ("43e59a61-0604-42f8-9b87-ee8dd0601d19", 304),
    ("4f2121c6-3e3e-4020-aa3b-e891eed026d9", 41),
    ("6ad2cd90-9eca-442f-9bb3-bf4011f45829", 55),
    ("7e94a797-9260-4aa5-8d56-aa381f99d777", 160),
    ("8cd91942-bb44-45a4-a957-783cf39db166", 77),
    ("92572aa0-b8ab-45dc-8bb4-661e45859c5a", 9),
    ("a1b862eb-10fd-4adb-82ce-d3f8c29e4beb", 27),
    ("d148adbf-99b1-4e40-abe3-5dbff53df909", 278),
    ("e6cb3eb4-ea04-4cae-8f2b-af1808fccdd0", 71),
    ("ecef0ceb-692b-4c37-a1b2-e2375632b65e", 2),
    ("ede711e3-557f-49bf-8b75-6d9b9e79e6f0", 3),
];

/// The ledger exactly as the live machine held it on 2026-10-31 20:24 IST.
const FROZEN_LEDGER: &str = r#"{"version": 1, "deposits": [], "spent": [], "seenPrompts": 1267}"#;

const LIVE_SURPLUS: i64 = 1204;
const LIVE_XP: i64 = 6020;

fn apex() -> i64 {
    STAGE_THRESHOLDS[STAGE_THRESHOLDS.len() - 1]
}

fn app_with_ledger(ledger: &str) -> (PathBuf, App) {
    // One dir per call: these tests run in parallel in the same process, and a
    // shared dir means one test wipes another's ledger mid-run.
    let d: PathBuf = std::env::temp_dir().join(format!("vial-freeze-{}-{}", std::process::id(), {
        use std::sync::atomic::{AtomicU64, Ordering};
        static N: AtomicU64 = AtomicU64::new(0);
        N.fetch_add(1, Ordering::Relaxed)
    }));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(d.join("home")).unwrap();
    let mut p = Paths::new(&d, &d.join("home"));
    p.projects_dir = d.join("projects");
    p.cursor_projects_dir = d.join("cursor");
    p.vial = d.join("vial.json");
    std::fs::create_dir_all(&p.projects_dir).unwrap();
    std::fs::create_dir_all(&p.cursor_projects_dir).unwrap();
    std::fs::write(&p.vial, ledger).unwrap();
    (d, App::new(p))
}

fn live_sessions() -> Vec<Value> {
    LIVE_CARDS
        .iter()
        .map(|(sid, sur)| json!({"sessionId": sid, "promptCount": apex() + sur}))
        .collect()
}

/// The exact live state: a watermark of 1267 against 1204 surplus prompts. The
/// old global gate would have said REFUSE. The per-session marks must pay the
/// 6020 XP the Village already displayed as poured.
#[test]
fn the_live_frozen_ledger_pays_what_the_pour_promised() {
    let (_d, app) = app_with_ledger(FROZEN_LEDGER);
    let now = claudehq::py::now_ts();
    let before = app.vial_read(now);
    assert_eq!(before.balance(), 0);
    assert_eq!(before.seen_prompts, 1267, "the frozen global mark");
    assert_eq!(before.seen.len(), 0, "no per-session marks had been kept");

    let mut sessions = live_sessions();
    let surplus: i64 = LIVE_CARDS.iter().map(|(_, s)| *s).sum();
    assert_eq!(surplus, LIVE_SURPLUS, "the live card list, unchanged");
    assert!(surplus <= before.seen_prompts, "this is the freeze condition");

    let v = app.payload_vial(&mut sessions);
    let after = app.vial_read(now);
    let poured: i64 = sessions.iter().map(|s| s["vialPoured"].as_i64().unwrap_or(0)).sum();

    assert_eq!(poured, LIVE_XP, "the Village displayed this as poured");
    assert_eq!(v["xp"], LIVE_XP, "the bank must hold what the pour promised");
    assert_eq!(after.balance(), LIVE_XP);
    assert_eq!(after.deposits.len(), 16, "one drop per Apex card");
    assert_eq!(after.seen.len(), 16, "one mark per Apex card");
    assert_eq!(after.seen.values().sum::<i64>(), LIVE_SURPLUS);
    // Every drop sits on the normal 24 h fuse — the catch-up is not a savings account.
    assert!(after.deposits.iter().all(|d| (now - d.at).abs() < 5.0));
    assert_eq!(v["expiresIn"], json!(86400.0));
}

/// Once paid, the same cards pour nothing more until they work past their mark.
#[test]
fn the_replay_pours_exactly_once() {
    let (_d, app) = app_with_ledger(FROZEN_LEDGER);
    let now = claudehq::py::now_ts();
    let mut sessions = live_sessions();
    let first = app.payload_vial(&mut sessions);
    assert_eq!(first["xp"], LIVE_XP);

    let second = app.payload_vial(&mut sessions);
    assert_eq!(second["xp"], LIVE_XP, "no double-drip for the same prompts");
    assert_eq!(app.vial_read(now).balance(), LIVE_XP);

    // One card works further: only its fresh surplus lands.
    sessions[6]["promptCount"] = json!(apex() + 41 + 10); // 10 more prompts
    let third = app.payload_vial(&mut sessions);
    assert_eq!(third["xp"], LIVE_XP + 50, "10 prompts past the mark -> 50 XP");
}

/// The written ledger must describe the marks, not the stale global number.
#[test]
fn the_written_ledger_trades_the_stale_global_for_per_session_marks() {
    let (_d, app) = app_with_ledger(FROZEN_LEDGER);
    let mut sessions = live_sessions();
    app.payload_vial(&mut sessions);

    let body: Value = serde_json::from_slice(&std::fs::read(&app.paths.vial).unwrap()).unwrap();
    assert_eq!(body["version"], json!(1));
    assert_eq!(body["deposits"].as_array().unwrap().len(), 16);
    assert_eq!(body["spent"].as_array().unwrap().len(), 0);
    assert_eq!(body["seenPrompts"], json!(LIVE_SURPLUS), "derived from the marks");
    let seen = body["seen"].as_object().unwrap();
    assert_eq!(seen.len(), 16);
    assert_eq!(seen["4f2121c6-3e3e-4020-aa3b-e891eed026d9"], json!(41));
    assert_eq!(seen["43e59a61-0604-42f8-9b87-ee8dd0601d19"], json!(304));
    assert_eq!(std::fs::metadata(&app.paths.vial).unwrap().permissions().mode() & 0o777, 0o600);
}

/// A card leaving the list must never freeze another card's pour — the bug.
#[test]
fn a_card_leaving_the_list_does_not_freeze_the_next_pour() {
    let (_d, app) = app_with_ledger(FROZEN_LEDGER);
    let now = claudehq::py::now_ts();
    let mut sessions = live_sessions();
    app.payload_vial(&mut sessions);

    // The biggest card leaves; the sum falls well under every mark.
    sessions.retain(|s| s["sessionId"] != json!("43e59a61-0604-42f8-9b87-ee8dd0601d19"));
    let sum: i64 = sessions.iter().map(|s| (s["promptCount"].as_i64().unwrap() - apex()).max(0)).sum();
    assert!(sum < LIVE_SURPLUS, "the total fell: {}", sum);

    // A brand-new Apex card works past Apex. A global mark would refuse it.
    sessions.push(json!({"sessionId": "zzzzzzzz-zzzz-4zzz-8zzz-zzzzzzzzzzzz", "promptCount": apex() + 40}));
    let v = app.payload_vial(&mut sessions);
    assert_eq!(v["xp"], LIVE_XP + 200, "40 surplus prompts on the new card -> 200 XP");
    let st = app.vial_read(now);
    assert_eq!(st.seen.get("zzzzzzzz-zzzz-4zzz-8zzz-zzzzzzzzzzzz"), Some(&40));
}
