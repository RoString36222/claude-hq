//! Ported from tests/test_hq3d.py (HqArenaBoundary, ProgressBoundary): what an
//! open HQ sends the Arena is allowlisted, ids in the URL are validated, the
//! progression reads are plain GETs, and the crew counts are three numbers.

use claudehq::app::{App, Paths};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

type Sent = Arc<Mutex<Vec<(String, String, Option<Value>)>>>;

/// A paired app whose Arena transport records every request instead of sending it.
fn paired() -> (tempfile::TempDir, App, Sent) {
    let dir = tempfile::tempdir().unwrap();
    let app = App::new(Paths::new(dir.path(), &dir.path().join("home")));
    *app.agents_hook.write().unwrap() = Some(Arc::new(|| (Vec::new(), None)));
    app.save_link(&json!({"token": "tok", "url": "https://arena.test"})).unwrap();
    let sent: Sent = Arc::new(Mutex::new(Vec::new()));
    let s2 = sent.clone();
    *app.arena.transport.write().unwrap() = Some(Arc::new(move |m, u, _t, b| {
        s2.lock().unwrap().push((m.to_string(), u.to_string(), b.cloned()));
        (200, json!({}))
    }));
    (dir, app, sent)
}

#[test]
fn only_open_look_and_counts_leave() {
    let (_d, app, sent) = paired();
    app.arena_hq_update(
        Some(&json!(true)),
        Some(&json!({"paint": "#224466", "sign": "Mine", "cwd": "/Users/me", "title": "secret"})),
        Some(&json!({"working": 3, "needs": 1, "idle": 99, "sessionId": "x"})),
    );
    let s = sent.lock().unwrap();
    let (m, url, body) = s.last().unwrap();
    assert_eq!((m.as_str(), url.as_str()), ("PUT", "https://arena.test/v1/hq/me"));
    assert_eq!(
        body.as_ref().unwrap(),
        &json!({"open": true, "look": {"paint": "#224466", "sign": "Mine"}, "crew": {"working": 3, "needs": 1, "idle": 64}})
    );
}

#[test]
fn visit_validates_the_user_id() {
    let (_d, app, sent) = paired();
    assert_eq!(app.arena_hq_visit("../../v1/admin").0, 400);
    assert!(sent.lock().unwrap().is_empty());
    app.arena_hq_visit("11111111-2222-3333-4444-555555555555");
    assert!(sent.lock().unwrap().last().unwrap().1.ends_with("/v1/hq/11111111-2222-3333-4444-555555555555"));
}

#[test]
fn crew_counts_are_three_numbers() {
    let (_d, app, _sent) = paired();
    let c = app.hq_crew_counts();
    let o = c.as_object().unwrap();
    let mut keys: Vec<&str> = o.keys().map(|k| k.as_str()).collect();
    keys.sort();
    assert_eq!(keys, ["idle", "needs", "working"]);
    assert!(o.values().all(|v| v.is_i64()));
}

#[test]
fn progress_reads_are_get_only_and_validated() {
    let (_d, app, sent) = paired();
    app.arena_progress();
    app.arena_leaderboards("kart", Some("meadow"));
    app.arena_profile("me");
    {
        let s = sent.lock().unwrap();
        let got: Vec<(&str, &str, Option<&Value>)> =
            s.iter().map(|(m, u, b)| (m.as_str(), u.split("arena.test").nth(1).unwrap(), b.as_ref())).collect();
        assert_eq!(
            got,
            [("GET", "/v1/progress/me", None), ("GET", "/v1/leaderboards/kart?key=meadow", None), ("GET", "/v1/profile/me", None)]
        );
    }
    assert_eq!(app.arena_leaderboards("chess", None).0, 400);
    assert_eq!(app.arena_profile("../admin").0, 400);
    assert_eq!(sent.lock().unwrap().len(), 3);
    app.arena_leaderboards("golf", Some("../../x"));
    assert!(sent.lock().unwrap().last().unwrap().1.ends_with("/v1/leaderboards/golf"));
}
