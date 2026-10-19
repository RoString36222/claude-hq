//! The rest of tests/test_needs_you.py (payload.rs::needs_you_detection covers
//! the open question, an answered question, the Bash hint, the wait states and
//! an unknown status): plan approval, orphaned questions, stale tabs, the
//! scanner's latest pending ask, every likelyAwaiting rule, background blocked.

use claudehq::app::{App, Paths};
use claudehq::{py, scan};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;

const SID: &str = "33333333-3333-4333-8333-333333333333";

fn ago(secs: f64) -> String {
    py::iso_from_ts(py::now_ts() - secs).unwrap()
}

fn asst(blocks: Value, ts: String, mid: &str) -> Value {
    json!({"type": "assistant", "timestamp": ts, "message": {"id": mid, "model": "claude-opus-5-5", "content": blocks, "usage": {"input_tokens": 1, "output_tokens": 1}}})
}

fn user(content: Value, ts: String, mode: Option<&str>) -> Value {
    let mut r = json!({"type": "user", "timestamp": ts, "message": {"content": content}});
    if let Some(m) = mode {
        r["permissionMode"] = json!(m);
    }
    r
}

fn tool_use(id: &str, name: &str, input: Value) -> Value {
    json!({"type": "tool_use", "id": id, "name": name, "input": input})
}

fn tool_result(id: &str) -> Value {
    json!([{"type": "tool_result", "tool_use_id": id, "content": "ok"}])
}

fn ask() -> Value {
    tool_use("ask1", "AskUserQuestion", json!({"questions": [{"question": "Which   table should I use?", "options": []}]}))
}

struct Case {
    _d: tempfile::TempDir,
    app: App,
    path: PathBuf,
}

fn case() -> Case {
    let d = tempfile::tempdir().unwrap();
    let mut p = Paths::new(d.path(), &d.path().join("home"));
    p.projects_dir = d.path().join("projects");
    p.cursor_projects_dir = d.path().join("cursor");
    let path = p.projects_dir.join("proj").join(format!("{}.jsonl", SID));
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    Case { _d: d, app: App::new(p), path }
}

impl Case {
    fn write(&self, recs: &[Value]) {
        let s: String = recs.iter().map(|r| format!("{}\n", r)).collect();
        std::fs::write(&self.path, s).unwrap();
        // rewrites within the same second must not hit a stale scan cache
        let f = std::fs::File::options().write(true).open(&self.path).unwrap();
        f.set_modified(std::time::SystemTime::now() + std::time::Duration::from_secs(rand_secs())).unwrap();
    }

    fn session(&self, recs: &[Value], status: &str, kind: &str) -> Value {
        self.write(recs);
        let key = if kind == "interactive" { "status" } else { "state" };
        let agent = match json!({"sessionId": SID, "cwd": "/tmp/proj", "kind": kind, "pid": 4242, key: status}) {
            Value::Object(o) => o,
            _ => unreachable!(),
        };
        self.app.build_session(&agent, &HashMap::new(), false)
    }

    fn live(&self, recs: &[Value], status: &str) -> Value {
        self.session(recs, status, "interactive")
    }
}

/// A distinct mtime per write so the (mtime, size)-keyed scan cache rescans.
fn rand_secs() -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static N: AtomicU64 = AtomicU64::new(1);
    N.fetch_add(1, Ordering::Relaxed)
}

#[test]
fn open_question_carries_waiting_since() {
    let c = case();
    let s = c.live(&[user(json!("help me"), ago(60.0), Some("default")), asst(json!([ask()]), ago(50.0), "m1")], "busy");
    assert_eq!(s["status"], "needs");
    assert!(py::truthy(&s["waitingSince"]));
}

#[test]
fn plan_approval_is_needs() {
    let c = case();
    let s = c.live(&[user(json!("plan it"), ago(60.0), None), asst(json!([tool_use("p1", "ExitPlanMode", json!({"plan": "x"}))]), ago(50.0), "m1")], "idle");
    assert_eq!(s["status"], "needs");
    assert_eq!(s["alertKind"], "plan");
    assert_eq!(s["alert"], "Waiting for you to approve a plan");
}

#[test]
fn answered_question_has_no_alert_kind() {
    let c = case();
    let s = c.live(&[user(json!("help me"), ago(60.0), None), asst(json!([ask()]), ago(50.0), "m1"), user(tool_result("ask1"), ago(40.0), None)], "idle");
    assert_eq!(s["status"], "idle");
    assert!(s["alertKind"].is_null());
}

#[test]
fn new_prompt_or_interrupt_clears_an_orphaned_question() {
    let c = case();
    for closer in [json!("go on instead"), json!([{"type": "text", "text": "[Request interrupted by user]"}])] {
        let s = c.live(&[user(json!("help me"), ago(60.0), None), asst(json!([ask()]), ago(50.0), "m1"), user(closer.clone(), ago(40.0), None)], "idle");
        assert_eq!(s["status"], "idle", "{}", closer);
    }
}

#[test]
fn question_on_a_stale_tab_stays_stale() {
    let c = case();
    let s = c.live(&[user(json!("help me"), ago(3.0 * 86400.0), None), asst(json!([ask()]), ago(3.0 * 86400.0 - 10.0), "m1")], "idle");
    assert_eq!(s["status"], "stale");
}

#[test]
fn scanner_keeps_latest_pending_ask() {
    let c = case();
    c.write(&[user(json!("x"), ago(60.0), None), asst(json!([ask()]), ago(50.0), "m1"), asst(json!([tool_use("p1", "ExitPlanMode", json!({}))]), ago(40.0), "m2")]);
    let agg = scan::scan_claude(&c.path);
    let pa = agg.pending_ask.unwrap();
    assert_eq!((pa.kind, pa.text.as_str()), ("plan", ""));
}

fn recs(mode: &str, name: &str, open_for: f64) -> Vec<Value> {
    vec![user(json!("run it"), ago(open_for + 5.0), Some(mode)), asst(json!([tool_use("b1", name, json!({"command": "ls"}))]), ago(open_for), "m1")]
}

#[test]
fn no_hint_in_auto_or_bypass_mode() {
    let c = case();
    for mode in ["auto", "bypassPermissions"] {
        assert!(c.live(&recs(mode, "Bash", 60.0), "busy")["likelyAwaiting"].is_null(), "{}", mode);
    }
}

#[test]
fn no_hint_for_a_fresh_tool_or_ungated_tool() {
    let c = case();
    assert!(c.live(&recs("default", "Bash", 5.0), "busy")["likelyAwaiting"].is_null());
    assert!(c.live(&recs("default", "Read", 60.0), "busy")["likelyAwaiting"].is_null());
}

#[test]
fn edits_are_not_gated_in_accept_edits_mode() {
    let c = case();
    assert!(c.live(&recs("acceptEdits", "Edit", 60.0), "busy")["likelyAwaiting"].is_null());
    assert!(!c.live(&recs("acceptEdits", "Bash", 60.0), "busy")["likelyAwaiting"].is_null());
    assert!(!c.live(&recs("default", "mcp__x__y", 60.0), "busy")["likelyAwaiting"].is_null());
}

#[test]
fn no_hint_once_the_tool_returns() {
    let c = case();
    let mut r = recs("default", "Bash", 60.0);
    r.push(user(tool_result("b1"), ago(1.0), None));
    assert!(c.live(&r, "busy")["likelyAwaiting"].is_null());
}

#[test]
fn no_hint_when_not_working() {
    let c = case();
    assert!(c.live(&recs("default", "Bash", 60.0), "idle")["likelyAwaiting"].is_null());
}

#[test]
fn background_blocked_unchanged() {
    let c = case();
    let s = c.session(&[user(json!("hi"), ago(30.0), None)], "blocked", "background");
    assert_eq!(s["status"], "needs");
    assert_eq!(s["alertKind"], "blocked");
}
