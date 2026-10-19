//! The rest of tests/test_payload_slim.py (payload.rs::cards_trim_text_and_detail_keeps_it,
//! stream_sig_ignores_clock_and_ages and memo_invalidation_mid_build_is_not_fresh
//! cover the core): lastPrompt trimming, the live card's firstPrompt, the full
//! lastPrompt in the detail, the export leaving its input alone, and the blob
//! being the payload serialised.

use claudehq::app::{App, Paths};
use claudehq::payload::{LIVE_PROMPT_MAX, LIVE_REPLY_MAX};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;

const SID: &str = "44444444-4444-4444-8444-444444444444";
const TS: &str = "2026-09-01T10:00:00.000Z";

fn long_prompt() -> String {
    format!("please analyse {}", "x".repeat(20000))
}

fn long_reply() -> String {
    format!("done: {}", "y".repeat(5000))
}

fn chars(v: &Value) -> usize {
    v.as_str().unwrap().chars().count()
}

#[test]
fn slim_cards_and_full_text() {
    let d = tempfile::tempdir().unwrap();
    let mut p = Paths::new(d.path(), &d.path().join("home"));
    p.projects_dir = d.path().join("projects");
    p.cursor_projects_dir = d.path().join("cursor");
    let path = p.projects_dir.join("proj").join(format!("{}.jsonl", SID));
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let recs = [
        json!({"type": "user", "timestamp": TS, "message": {"content": long_prompt()}}),
        json!({"type": "assistant", "timestamp": TS, "message": {"id": "m1", "model": "claude-opus-5-5",
               "content": [{"type": "text", "text": long_reply()}], "usage": {"input_tokens": 1, "output_tokens": 1}}}),
    ];
    std::fs::write(&path, recs.iter().map(|r| format!("{}\n", r)).collect::<String>()).unwrap();
    let app = App::new(p);
    *app.agents_hook.write().unwrap() = Some(Arc::new(|| (Vec::new(), None)));

    let card = app.build_archived_session(&path, SID, &HashMap::new(), false, None);
    assert!(chars(&card["lastPrompt"]) <= LIVE_PROMPT_MAX);
    assert!(card["firstPrompt"].as_str().unwrap().starts_with("please analyse"));

    let agent = match json!({"sessionId": SID, "cwd": "/tmp/proj", "kind": "interactive", "status": "idle"}) {
        Value::Object(o) => o,
        _ => unreachable!(),
    };
    let live = app.build_session(&agent, &HashMap::new(), false);
    assert!(chars(&live["firstPrompt"]) <= LIVE_PROMPT_MAX);
    assert!(chars(&live["lastReply"]) <= LIVE_REPLY_MAX);

    let detail = app.build_session_detail(SID).unwrap();
    assert_eq!(detail["lastPromptFull"], long_prompt());

    let input = [card];
    let out = app.full_text_sessions(&input);
    assert_eq!(out[0]["firstPrompt"], long_prompt());
    assert!(chars(&input[0]["firstPrompt"]) <= LIVE_PROMPT_MAX); // input untouched

    let p = app.build_payload_memo();
    let (blob, _) = app.build_payload_blob();
    assert_eq!(serde_json::from_str::<Value>(&blob).unwrap(), *p);
}
