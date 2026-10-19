//! The rest of tests/test_scanner.py (the cases tests/scanner.rs and the module
//! tests did not already cover): list prices, error recovery, Cursor project
//! slugs, the Cursor chat-title fallback, and resume refusing Cursor sessions.

use claudehq::app::{App, Paths};
use claudehq::{cost, py, scan};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

const TS: &str = "2026-09-01T10:00:00.000Z";
const LATER: &str = "2026-09-01T10:05:00.000Z"; // 5 minutes after TS

fn write(path: &Path, recs: &[Value]) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let s: String = recs.iter().map(|r| format!("{}\n", r)).collect();
    std::fs::write(path, s).unwrap();
}

fn scan(recs: &[Value]) -> scan::Agg {
    let d = tempfile::tempdir().unwrap();
    let p = d.path().join("22222222-2222-4222-8222-222222222222.jsonl");
    write(&p, recs);
    scan::scan_claude(&p)
}

fn asst(t: &str, mid: &str, ts: &str, api_error: bool) -> Value {
    let mut r = json!({"type": "assistant", "timestamp": ts, "message": {"id": mid, "model": "claude-sonnet-4-6",
        "content": [{"type": "text", "text": t}], "usage": {"input_tokens": 1000, "output_tokens": 500}}});
    if api_error {
        r["isApiErrorMessage"] = json!(true);
    }
    r
}

fn new_app(d: &Path) -> App {
    let mut p = Paths::new(d, &d.join("home"));
    p.projects_dir = d.join("claude");
    p.cursor_projects_dir = d.join("cursor");
    p.cursor_state_db = d.join("state.vscdb");
    std::fs::create_dir_all(&p.projects_dir).unwrap();
    App::new(p)
}

#[test]
fn current_list_prices() {
    assert_eq!(cost::price_for("claude-opus-4-6"), (5.0, 25.0));
    assert_eq!(cost::price_for("claude-fable-5-1"), (10.0, 50.0));
}

#[test]
fn a_good_reply_sets_last_good_reply() {
    let agg = scan(&[asst("hello", "m1", TS, false)]);
    let want = py::ts(&py::parse_iso_utc(TS).unwrap());
    assert_eq!(agg.last_good_reply, Some(want));
}

#[test]
fn the_error_record_itself_does_not_recover_it() {
    // The synthetic "API Error: ..." message is an assistant record with text
    // blocks: if it set last_good_reply, every error would clear on arrival.
    let agg = scan(&[asst("API Error: Overloaded", "m1", TS, true)]);
    assert_eq!(agg.last_good_reply, None);
}

#[test]
fn an_error_following_the_last_reply_stays_flagged() {
    let agg = scan(&[asst("working on it", "m1", TS, false), asst("API Error: Overloaded", "m2", LATER, true)]);
    assert_eq!(agg.errors.len(), 1);
    let now = agg.errors[0].0 + 60.0;
    assert!(scan::recent_unrecovered_error(&agg.errors, agg.last_good_reply, now).is_some());
}

#[test]
fn a_good_reply_after_the_error_marks_recovery() {
    let agg = scan(&[asst("API Error: Overloaded", "m1", TS, true), asst("sorry, here is the answer", "m2", LATER, false)]);
    assert_eq!(agg.errors.len(), 1);
    let now = agg.errors[0].0 + 60.0;
    assert!(scan::recent_unrecovered_error(&agg.errors, agg.last_good_reply, now).is_none());
}

#[test]
fn recovery_does_not_reach_back_in_time() {
    let agg = scan(&[asst("earlier good turn", "m0", TS, false), asst("API Error: Overloaded", "m1", LATER, true)]);
    let now = agg.errors[0].0 + 60.0;
    assert!(scan::recent_unrecovered_error(&agg.errors, agg.last_good_reply, now).is_some());
}

#[test]
fn the_six_hour_window_still_expires_an_unanswered_error() {
    let agg = scan(&[asst("API Error: Overloaded", "m1", TS, true)]);
    let now = agg.errors[0].0 + 6.0 * 3600.0 + 1.0;
    assert!(scan::recent_unrecovered_error(&agg.errors, agg.last_good_reply, now).is_none());
}

#[test]
fn a_recovered_error_stops_flagging_live_and_detail() {
    let d = tempfile::tempdir().unwrap();
    let sid = "22222222-2222-4222-8222-222222222222";
    let ago = |s: f64| py::iso_from_ts(py::now_ts() - s).unwrap();
    let agent = match json!({"sessionId": sid, "cwd": "/tmp/proj", "kind": "interactive", "status": "idle"}) {
        Value::Object(o) => o,
        _ => unreachable!(),
    };
    let err = asst("API Error: Overloaded", "m1", &ago(120.0), true);
    for (recs, want) in [(vec![err.clone()], "needs"), (vec![err, asst("here it is", "m2", &ago(60.0), false)], "idle")] {
        let app = new_app(d.path()); // cold scan cache: the rewritten transcript is re-read
        *app.agents_hook.write().unwrap() = Some(std::sync::Arc::new(|| (Vec::new(), None)));
        write(&app.paths.projects_dir.join("proj").join(format!("{}.jsonl", sid)), &recs);
        assert_eq!(app.build_session(&agent, &HashMap::new(), false)["status"], want);
        assert_eq!(app.build_session_detail(sid).unwrap()["status"], want);
    }
}

#[test]
fn find_transcript_rejects_glob_characters() {
    let d = tempfile::tempdir().unwrap();
    let app = new_app(d.path());
    let sid = "22222222-2222-4222-8222-222222222222";
    write(&app.paths.projects_dir.join("proj").join(format!("{}.jsonl", sid)), &[json!({"type": "user"})]);
    assert!(app.find_transcript(sid).is_some());
    assert_eq!(app.find_transcript(&format!("{}?", &sid[..35])), None);
}

#[test]
fn slug_resolves_hyphenated_directory() {
    let d = tempfile::Builder::new().prefix("hq-cursor-").tempdir().unwrap();
    let real = d.path().canonicalize().unwrap();
    let slug = real.to_string_lossy().trim_start_matches('/').replace('/', "-");
    let got = PathBuf::from(scan::path_from_project_slug(&slug));
    assert_eq!(got.canonicalize().unwrap(), real);
}

const CSID: &str = "33333333-3333-4333-8333-333333333333";

fn cursor_transcript(app: &App) -> PathBuf {
    let path = app.paths.cursor_projects_dir.join("Users-ada-demo/agent-transcripts").join(CSID).join(format!("{}.jsonl", CSID));
    write(&path, &[json!({"role": "user", "message": {"content": [{"type": "text", "text": "<user_query>You're reading it exactly right and the first message is long</user_query>"}]}})]);
    path
}

#[test]
fn card_heading_uses_cursor_chat_title_and_blank_falls_back() {
    let d = tempfile::tempdir().unwrap();
    let app = new_app(d.path());
    let path = cursor_transcript(&app);
    let con = rusqlite::Connection::open(&app.paths.cursor_state_db).unwrap();
    con.execute("CREATE TABLE composerHeaders (composerId TEXT PRIMARY KEY, value TEXT)", []).unwrap();
    con.execute("INSERT INTO composerHeaders VALUES (?1, ?2)", [CSID, "{\"name\": \"  Extend chat data support  \", \"subtitle\": \"Edited dashboard.py\"}"]).unwrap();
    let card = app.build_archived_session(&path, CSID, &HashMap::new(), false, Some("idle"));
    assert_eq!(card["title"], "Extend chat data support");
    assert!(card["firstPrompt"].as_str().unwrap().contains("You're reading it exactly right"));
    // A blank stored name keeps the first message.
    con.execute("UPDATE composerHeaders SET value=?1 WHERE composerId=?2", ["{\"name\": \"   \"}", CSID]).unwrap();
    drop(con);
    let f = std::fs::File::options().write(true).open(&app.paths.cursor_state_db).unwrap();
    f.set_modified(std::time::SystemTime::now() + std::time::Duration::from_secs(5)).unwrap();
    let card = app.build_archived_session(&path, CSID, &HashMap::new(), false, Some("idle"));
    assert_eq!(card["title"], "You're reading it exactly right and the first message is long");
}

#[test]
fn resume_refuses_cursor() {
    let d = tempfile::tempdir().unwrap();
    let app = new_app(d.path());
    cursor_transcript(&app);
    let (code, resp) = app.action_resume(Some(&json!(CSID)));
    assert_eq!(code, 400);
    assert!(resp["error"].as_str().unwrap().contains("Cursor"));
}
