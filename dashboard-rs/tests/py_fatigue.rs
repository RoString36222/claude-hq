//! Ported from tests/test_fatigue.py: the cases not already in src/fatigue.rs,
//! tests/scanner.rs or src/payload.rs (turn-opening edge cases, the live-load
//! clock bound, the payload wiring and the memo race). Temp dirs only.

use chrono::{Duration, TimeZone, Utc};
use claudehq::app::{App, Paths};
use claudehq::{fatigue, py, scan};
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashMap};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

const BASE: f64 = 1789999200.0; // 2026-09-21T14:00:00Z
const H: f64 = 3600.0;
const M: f64 = 60.0;
const SID: &str = "00000000-0000-4000-8000-000000000000";
const KEYS: [&str; 9] = ["state", "energy", "loadMins", "mayFaint", "phase", "restInMins", "restMins", "streakMins", "lastMeal"];

fn t(secs: f64) -> String {
    let dt = Utc.timestamp_opt(BASE as i64, 0).unwrap() + Duration::milliseconds((secs * 1000.0) as i64);
    py::iso(&dt).replace("+00:00", "Z")
}

fn write(path: &Path, recs: &[Value]) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let s: String = recs.iter().map(|r| format!("{}\n", r)).collect();
    std::fs::write(path, s).unwrap();
}

fn scan(recs: &[Value]) -> scan::Agg {
    let d = tempfile::tempdir().unwrap();
    let p = d.path().join(format!("{}.jsonl", SID));
    write(&p, recs);
    scan::scan_claude(&p)
}

fn keys(v: &Value) -> BTreeSet<String> {
    v.as_object().unwrap().keys().cloned().collect()
}

fn want_keys() -> BTreeSet<String> {
    KEYS.iter().map(|k| k.to_string()).collect()
}

fn load(spans: &[[f64; 2]], now: f64) -> i64 {
    fatigue::fatigue_for(SID, spans, now, None, &[])["loadMins"].as_i64().unwrap()
}

/// Load 1 s before and 1 s after the last record lands.
fn jump_on_the_last_record(recs: &[Value], before: f64, after: f64) -> (scan::Agg, Value, Value) {
    let a = fatigue::fatigue_for(SID, &scan(&recs[..recs.len() - 1]).busy_spans, before, None, &[]);
    let agg = scan(recs);
    let b = fatigue::fatigue_for(SID, &agg.busy_spans, after, None, &[]);
    (agg, a, b)
}

#[test]
fn output_shape_and_energy_range() {
    let cases: [(&[(f64, f64)], f64, &[(f64, &str)], Option<f64>); 8] = [
        (&[(0.0, 2.0 * H)], 2.0 * H + 8.0 * M, &[], None),
        (&[(0.0, 130.0 * M)], 130.0 * M, &[(130.0 * M, "riceball")], None),
        (&[(0.0, 4.0 * H)], 4.0 * H, &[], None),
        (&[(0.0, 6.0 * H)], 6.0 * H, &[(6.0 * H, "elixir")], None),
        (&[(0.0, 3.0 * H)], 3.0 * H, &[], None),
        (&[(0.0, 30.0 * M)], 70.0 * M, &[], Some(30.0 * M)),
        (&[(0.0, 2.0 * H)], 27.0 * H, &[], None),
        (&[], 0.0, &[], None),
    ];
    for (spans, now, meals, osn) in cases {
        let sp: Vec<[f64; 2]> = spans.iter().map(|(a, b)| [BASE + a, BASE + b]).collect();
        let ml: Vec<(f64, String)> = meals.iter().map(|(t, k)| (BASE + t, k.to_string())).collect();
        let r = fatigue::fatigue_for(SID, &sp, BASE + now, osn.map(|o| BASE + o), &ml);
        assert_eq!(keys(&r), want_keys());
        let e = r["energy"].as_f64().unwrap();
        assert!((0.0..=1.0).contains(&e), "{}", e);
    }
}

#[test]
fn a_turn_opened_by_another_sessions_message_starts_there() {
    let agg = scan(&[
        json!({"type": "user", "timestamp": t(0.0), "message": {"content": "ship it"}}),
        json!({"type": "system", "subtype": "turn_duration", "durationMs": 5 * 60 * 1000, "timestamp": t(5.0 * M)}),
        json!({"type": "user", "isMeta": true, "timestamp": t(2.0 * H), "message": {"content": "Another Claude session sent a message: hi"}}),
        json!({"type": "system", "subtype": "turn_duration", "durationMs": (2.0 * H + 20.0) * 1000.0, "timestamp": t(2.0 * H + 20.0)}),
    ]);
    assert_eq!(agg.busy_spans, vec![[BASE, BASE + 5.0 * M], [BASE + 2.0 * H, BASE + 2.0 * H + 20.0]]);
}

#[test]
fn another_sessions_message_after_a_slash_command_never_jumps() {
    let recs = [
        json!({"type": "user", "timestamp": t(0.0), "message": {"content": "ship it"}}),
        json!({"type": "system", "subtype": "turn_duration", "durationMs": 5 * 60 * 1000, "timestamp": t(5.0 * M)}),
        json!({"type": "user", "isMeta": true, "timestamp": t(6.0 * M), "message": {"content": "<local-command-caveat>Caveat</local-command-caveat>"}}),
        json!({"type": "user", "timestamp": t(6.0 * M), "message": {"content": "<command-name>/model</command-name>"}}),
        json!({"type": "user", "timestamp": t(6.0 * M), "message": {"content": "<local-command-stdout>Set model</local-command-stdout>"}}),
        json!({"type": "user", "isMeta": true, "timestamp": t(2.0 * H), "message": {"content": "Another Claude session sent a message: hi"}}),
        json!({"type": "system", "subtype": "turn_duration", "durationMs": (2.0 * H + 20.0) * 1000.0, "timestamp": t(2.0 * H + 20.0)}),
    ];
    let (agg, a, b) = jump_on_the_last_record(&recs, BASE + 2.0 * H + 19.0, BASE + 2.0 * H + 21.0);
    assert_eq!(agg.busy_spans, vec![[BASE, BASE + 6.0 * M], [BASE + 2.0 * H, BASE + 2.0 * H + 20.0]]);
    assert_eq!((a["state"].as_str(), b["state"].as_str()), (Some("rested"), Some("rested")));
    assert!(b["loadMins"].as_i64().unwrap() - a["loadMins"].as_i64().unwrap() <= 1);
}

#[test]
fn another_sessions_message_after_an_interrupted_turn() {
    // Esc: the interrupted turn writes no turn_duration either.
    let recs = [
        json!({"type": "user", "timestamp": t(0.0), "message": {"content": "build it"}}),
        json!({"type": "assistant", "timestamp": t(10.0), "message": {"content": [{"type": "tool_use", "id": "b1", "name": "Bash", "input": {}}]}}),
        json!({"type": "user", "timestamp": t(60.0), "message": {"content": [{"type": "tool_result", "tool_use_id": "b1", "content": "interrupted", "is_error": true}]}}),
        json!({"type": "user", "timestamp": t(60.0), "message": {"content": [{"type": "text", "text": "[Request interrupted by user for tool use]"}]}}),
        json!({"type": "user", "isMeta": true, "timestamp": t(3.0 * H), "message": {"content": "Another Claude session sent a message: hi"}}),
        json!({"type": "assistant", "timestamp": t(3.0 * H + 20.0), "message": {"content": [{"type": "text", "text": "ok"}]}}),
        json!({"type": "system", "subtype": "turn_duration", "durationMs": (3.0 * H + 30.0) * 1000.0, "timestamp": t(3.0 * H + 30.0)}),
    ];
    let (agg, a, b) = jump_on_the_last_record(&recs, BASE + 3.0 * H + 29.0, BASE + 3.0 * H + 31.0);
    assert_eq!(agg.busy_spans, vec![[BASE, BASE + 60.0], [BASE + 3.0 * H, BASE + 3.0 * H + 30.0]]);
    assert_eq!((b["state"].as_str(), b["mayFaint"].as_bool()), (Some("rested"), Some(false)));
    assert!(b["loadMins"].as_i64().unwrap() - a["loadMins"].as_i64().unwrap() <= 1);
}

#[test]
fn live_load_never_outruns_the_clock() {
    // Grow a transcript record by record, as the page sees it: load never
    // rises faster than wall time (1 min per min, +1 rounding).
    let mut recs = vec![json!({"type": "user", "timestamp": t(0.0), "message": {"content": "build it"}})];
    for i in 1..20 {
        recs.push(json!({"type": "assistant", "timestamp": t(2.0 * M * i as f64), "message": {"content": [{"type": "text", "text": "step"}]}}));
    }
    recs.extend([
        json!({"type": "assistant", "timestamp": t(39.0 * M), "message": {"content": [{"type": "tool_use", "id": "w1", "name": "Workflow", "input": {}}]}}),
        json!({"type": "user", "timestamp": t(39.0 * M + 2.0), "message": {"content": [{"type": "tool_result", "tool_use_id": "w1", "content": "launched in background"}]}}),
        json!({"type": "system", "subtype": "turn_duration", "durationMs": 40 * 60 * 1000, "timestamp": t(40.0 * M)}),
        json!({"type": "user", "timestamp": t(60.0 * M), "message": {"content": "working?"}}),
        json!({"type": "system", "subtype": "turn_duration", "durationMs": 30 * 1000, "timestamp": t(60.0 * M + 30.0)}),
        json!({"type": "user", "timestamp": t(4.0 * H), "message": {"content": "<task-notification> <task-id>w1</task-id> done"}}),
        json!({"type": "system", "subtype": "turn_duration", "durationMs": (4.0 * H + 40.0) * 1000.0, "timestamp": t(4.0 * H + 40.0)}),
    ]);
    let stamps: Vec<f64> = recs.iter().map(|r| py::ts(&py::parse_iso_utc(r["timestamp"].as_str().unwrap()).unwrap())).collect();
    let (mut prev, mut written) = (None::<i64>, usize::MAX);
    let mut spans = Vec::new();
    for minute in 0..5 * 60 {
        let now = BASE + minute as f64 * M;
        let n = stamps.iter().filter(|s| **s <= now).count();
        if n != written {
            spans = scan(&recs[..n]).busy_spans;
            written = n;
        }
        let l = load(&spans, now);
        if let Some(p) = prev {
            assert!(l - p <= 2, "load jumped at minute {}", minute);
        }
        prev = Some(l);
    }
}

// ---- payload wiring ------------------------------------------------------------

fn app() -> (tempfile::TempDir, Arc<App>, std::path::PathBuf) {
    let d = tempfile::tempdir().unwrap();
    let mut p = Paths::new(d.path(), &d.path().join("home"));
    p.projects_dir = d.path().join("projects");
    p.cursor_projects_dir = d.path().join("cursor");
    p.cursor_state_db = d.path().join("state.vscdb");
    std::fs::create_dir_all(&p.projects_dir).unwrap();
    std::fs::create_dir_all(&p.cursor_projects_dir).unwrap();
    let app = Arc::new(App::new(p));
    *app.agents_hook.write().unwrap() = Some(Arc::new(|| (Vec::new(), None)));
    // A user prompt 70 min ago, then a tool that has been running for 40 min.
    let now = py::now_ts();
    let path = app.paths.projects_dir.join("proj").join(format!("{}.jsonl", SID));
    write(&path, &[
        json!({"type": "user", "timestamp": py::iso_from_ts(now - 70.0 * M), "message": {"content": "build it"}}),
        json!({"type": "assistant", "timestamp": py::iso_from_ts(now - 40.0 * M), "message": {"content": [{"type": "tool_use", "id": "t1", "name": "Bash", "input": {}}]}}),
    ]);
    (d, app, path)
}

fn agent(status: &str) -> py::Obj {
    json!({"sessionId": SID, "kind": "interactive", "status": status}).as_object().unwrap().clone()
}

#[test]
fn busy_interactive_session_with_an_open_tool_keeps_tiring() {
    let (_d, app, _) = app();
    let busy = app.build_session(&agent("busy"), &HashMap::new(), true);
    let idle = app.build_session(&agent("idle"), &HashMap::new(), true);
    let fz = &busy["creature"]["fatigue"];
    assert_eq!(keys(fz), want_keys());
    assert_eq!(fz["phase"], "active");
    assert!(fz["loadMins"].as_i64().unwrap() >= 39);
    assert_eq!(idle["creature"]["fatigue"]["phase"], "resting");
    assert_eq!(idle["creature"]["fatigue"]["loadMins"], 0);
}

#[test]
fn toggle_off_removes_the_key() {
    let (_d, app, path) = app();
    let s = app.build_session(&agent("busy"), &HashMap::new(), false);
    assert!(s["creature"].get("fatigue").is_none());
    let a = app.build_archived_session(&path, SID, &HashMap::new(), false, None);
    assert!(a["creature"].get("fatigue").is_none());
    let a = app.build_archived_session(&path, SID, &HashMap::new(), true, None);
    assert_eq!(keys(&a["creature"]["fatigue"]), want_keys());
}

#[test]
fn session_detail_carries_the_creature() {
    let (_d, app, path) = app();
    let detail = app.build_session_detail(SID).unwrap();
    assert_eq!(keys(&detail["creature"]["fatigue"]), want_keys());
    let agg = app.scan_file(&path).unwrap();
    assert_eq!(detail["creature"]["species"], app.creature_for(SID, agg.prompt_count)["species"]);
    // The payload's own card wins when the session is in it.
    assert_eq!(detail["creature"], app.payload_session(SID).unwrap()["creature"]);
    // Off the payload: fatigue only when the toggle is on, rested without a scan.
    assert_eq!(keys(&app.offpayload_fatigue(SID, Some(&agg)).unwrap()), want_keys());
    assert_eq!(app.offpayload_fatigue(SID, None).unwrap(), fatigue::rested());
    app.save_config(&json!({"creatureFatigue": false})).unwrap();
    assert!(app.offpayload_fatigue(SID, Some(&agg)).is_none());
}

#[test]
fn invalidation_during_a_build_is_not_cached_as_fresh() {
    let (_d, app, _) = app();
    // A meal lands mid-build: the hook runs inside build_payload.
    let fired = Arc::new(AtomicBool::new(false));
    let weak = Arc::downgrade(&app);
    let f = fired.clone();
    *app.agents_hook.write().unwrap() = Some(Arc::new(move || {
        if !f.swap(true, Ordering::SeqCst) {
            if let Some(a) = weak.upgrade() {
                a.invalidate_payload_memo();
            }
        }
        (Vec::new(), None)
    }));
    app.invalidate_payload_memo();
    let first = app.build_payload_memo();
    assert!(fired.load(Ordering::SeqCst));
    let second = app.build_payload_memo();
    assert!(!Arc::ptr_eq(&first, &second), "a build raced by an invalidation was served as fresh");
    // A quiet build is cached.
    assert!(Arc::ptr_eq(&second, &app.build_payload_memo()));
}
