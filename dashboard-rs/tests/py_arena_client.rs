//! Ported from tests/test_arena.py, test_arena_nudge.py, test_arena_pantry.py,
//! test_arena_rooms.py and test_quest_proxy.py: the Arena client is THE privacy
//! boundary. Only daily counts go to /v1/stats, pantry/quest bodies are rebuilt
//! from allowlists, nudges and gifts become notifications, and room / user ids
//! are checked before any request. The transport is stubbed throughout.

mod py_common;

use claudehq::arena::{self, PANTRY_ACTIONS, PANTRY_KEYS};
use claudehq::{handlers, server};
use py_common::*;
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

const ROOM: &str = "r_ABCDEFGHIJKLMNOPQRSTUv";
const UID: &str = "01234567-89ab-cdef-0123-456789abcdef";

fn iso_now() -> String {
    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

// ---- /v1/stats payload (test_arena.BuildPayloadTests) -----------------------

#[test]
fn stats_payload_is_counts_only() {
    let (_d, app) = app();
    let p = app.paths.projects_dir.join("some-project").join("session.jsonl");
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    let now = iso_now();
    let recs = [
        json!({"type": "user", "timestamp": now, "cwd": "/Users/me/client", "sessionId": "s", "message": {"content": "deploy the secret plan"}}),
        json!({"type": "assistant", "timestamp": now, "message": {"id": "m1", "model": "claude-sonnet-4-5",
            "usage": {"input_tokens": 100, "output_tokens": 200, "cache_read_input_tokens": 50, "cache_creation_input_tokens": 25},
            "content": [{"type": "tool_use", "id": "a", "name": "Bash", "input": {"command": "ls /secret"}},
                        {"type": "tool_use", "id": "b", "name": "Bash", "input": {}},
                        {"type": "tool_use", "id": "c", "name": "mcp__acme_corp__deploy", "input": {"path": "/secret"}}]}}),
    ];
    std::fs::write(&p, recs.iter().map(|r| r.to_string() + "\n").collect::<String>()).unwrap();

    let payload = app.arena_build_payload(false, "Ash", 30);
    assert_eq!(payload["trainerName"], "Ash");
    let day = &payload["days"][0];
    let names: Vec<&str> = day["toolBreakdown"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
    assert!(names.contains(&"Bash") && names.contains(&"Other"), "{:?}", names);
    assert!(!names.contains(&"mcp__acme_corp__deploy"));
    assert_eq!((day["prompts"].as_i64(), day["tools"].as_i64(), day["tokens"]["output"].as_i64()), (Some(1), Some(3), Some(200)));
    // No forbidden or local-only key anywhere, and no raw string from the transcript.
    let ks = keys(&payload);
    let bad: Vec<&&str> = FORBIDDEN_KEYS.iter().chain(LOCAL_ONLY_KEYS.iter()).filter(|k| ks.contains(**k)).collect();
    assert!(bad.is_empty(), "payload leaked keys: {:?}", bad);
    let blob = payload.to_string();
    for s in ["acme_corp", "/secret", "secret plan", "/Users/me", "some-project"] {
        assert!(!blob.contains(s), "{} leaked", s);
    }
    // Cost is opt-in.
    assert!(day.get("costUSD").is_none());
    assert!(app.arena_build_payload(true, "", 30)["days"][0]["costUSD"].is_number());
}

// ---- pantry wire (test_arena.PantryWireTests, test_arena_pantry) ------------

#[test]
fn pantry_wire_never_carries_forbidden_or_local_keys() {
    let (_d, app) = app();
    let sent = stub(&app, "https://arena.example", reply(200, json!({})));
    let mut leaky = serde_json::Map::new();
    for k in FORBIDDEN_KEYS.iter().chain(LOCAL_ONLY_KEYS.iter()) {
        leaky.insert(k.to_string(), json!("x"));
    }
    for (k, v) in [("requestId", json!("a".repeat(16))), ("kind", json!("berry")), ("qty", json!(1)), ("coins", json!(1)), ("toHandle", json!("gary")), ("note", json!("hi"))] {
        leaky.insert(k.into(), v);
    }
    let leaky = Value::Object(leaky);
    for action in PANTRY_ACTIONS {
        app.arena_pantry(Some(action), Some(&leaky));
    }
    let s = sent.lock().unwrap();
    assert_eq!(s.len(), PANTRY_ACTIONS.len());
    for (_, url, _, body) in s.iter() {
        let ks = keys(body.as_ref().unwrap());
        for k in FORBIDDEN_KEYS.iter().chain(LOCAL_ONLY_KEYS.iter()).filter(|k| **k != "requestId") {
            assert!(!ks.contains(*k), "{} carried {}", url, k);
        }
        assert!(top_keys(body.as_ref().unwrap()).iter().all(|k| PANTRY_KEYS.contains(&k.as_str())), "{}", url);
    }
}

#[test]
fn pantry_get_and_actions_post_exact_bodies() {
    let (_d, app) = app();
    let r = reply(200, json!({"coins": 0}));
    let sent = stub(&app, "https://arena.example", r.clone());
    assert_eq!(app.arena_pantry(None, None), (200, json!({"coins": 0})));
    assert_eq!(sent.lock().unwrap()[0], ("GET".into(), "https://arena.example/v1/pantry".into(), Some("T".into()), None));
    let give = json!({"requestId": RID, "toHandle": "gary", "coins": 2, "kind": "berry", "qty": 1, "note": "hi"});
    let cases = [
        ("claim", json!({}), json!({})),
        ("buy", json!({"requestId": RID, "kind": "bento", "qty": 2}), json!({"requestId": RID, "kind": "bento", "qty": 2})),
        ("eat", json!({"requestId": RID, "kind": "tonic"}), json!({"requestId": RID, "kind": "tonic"})),
        ("give", give.clone(), give),
    ];
    for (action, body, want) in cases {
        sent.lock().unwrap().clear();
        app.arena_pantry(Some(action), Some(&body));
        assert_eq!(
            *sent.lock().unwrap(),
            vec![("POST".to_string(), format!("https://arena.example/v1/pantry/{}", action), Some("T".to_string()), Some(want))],
            "{}", action
        );
    }
    // Unknown actions (the drain path included) make no request.
    sent.lock().unwrap().clear();
    assert_eq!(app.arena_pantry(Some("steal"), Some(&json!({"requestId": RID}))), (400, json!({"error": "unknown pantry action"})));
    assert_eq!(app.arena_pantry(Some("gifts/drain"), None), (400, json!({"error": "unknown pantry action"})));
    assert!(sent.lock().unwrap().is_empty());
    // Not paired: nothing at all.
    app.clear_link();
    assert_eq!(app.arena_pantry(Some("claim"), Some(&json!({}))), (400, json!({"error": "not paired"})));
    assert!(sent.lock().unwrap().is_empty());
}

#[test]
fn gift_drain_shapes() {
    let (_d, app) = app();
    let r = reply(200, json!({"gifts": [{"id": "g1", "fromHandle": "ash", "coins": 2}, "junk"]}));
    let sent = stub(&app, "https://arena.example", r.clone());
    assert_eq!(app.arena_drain_gifts(), vec![json!({"id": "g1", "fromHandle": "ash", "coins": 2})]);
    assert_eq!(sent.lock().unwrap()[0], ("POST".into(), "https://arena.example/v1/pantry/gifts/drain".into(), Some("T".into()), Some(json!({}))));
    for bad in [(500, json!({"error": "boom"})), (0, json!({"error": "offline"})), (200, json!({})), (200, json!({"gifts": "x"})), (200, json!([]))] {
        *r.lock().unwrap() = bad.clone();
        assert!(app.arena_drain_gifts().is_empty(), "{:?}", bad);
    }
    assert_no_leaks(&sent);
}

#[test]
fn gift_notice_text() {
    let o = |v: Value| v.as_object().unwrap().clone();
    assert_eq!(arena::gift_notice(&o(json!({"fromHandle": "ash", "coins": 1, "qty": 0, "kind": null}))),
               ("\u{1F381} ash sent you a gift".to_string(), "1 Poke Coin".to_string()));
    assert_eq!(arena::gift_notice(&o(json!({"fromName": "Ash", "kind": "berry", "qty": 1}))).1, "1 Berry");
    assert_eq!(arena::gift_notice(&o(json!({"fromName": 7, "coins": true, "qty": "2", "kind": ["berry"], "note": 5}))).0,
               "\u{1F381} Someone sent you a gift");
}

// ---- nudges (test_arena_nudge) ---------------------------------------------

#[test]
fn send_nudge_posts_handle_and_note() {
    let (_d, app) = app();
    let sent = stub(&app, "https://arena.example", reply(200, json!({"queued": true, "deliveredLive": 0})));
    let (code, _) = app.arena_send_nudge("gary", Some(&json!("come play")));
    assert_eq!(code, 200);
    assert_eq!(sent.lock().unwrap()[0],
               ("POST".into(), "https://arena.example/v1/nudge".into(), Some("T".into()), Some(json!({"toHandle": "gary", "note": "come play"}))));
    app.clear_link();
    let (code, resp) = app.arena_send_nudge("gary", None);
    assert_eq!(code, 400);
    assert!(resp["error"].as_str().unwrap().contains("not paired"));
    assert_eq!(sent.lock().unwrap().len(), 1);
}

#[test]
fn drain_nudges_returns_a_list_and_tolerates_errors() {
    let (_d, app) = app();
    let r = reply(200, json!({"nudges": [{"fromHandle": "ash"}]}));
    stub(&app, "https://arena.example", r.clone());
    assert_eq!(app.arena_drain_nudges(), vec![json!({"fromHandle": "ash"})]);
    *r.lock().unwrap() = (500, json!({"error": "boom"}));
    assert!(app.arena_drain_nudges().is_empty());
    *r.lock().unwrap() = (200, json!({"nudges": "oops"}));
    assert!(app.arena_drain_nudges().is_empty());
}

/// An Arena without /v1/nudge answers 404 {"detail": "Not Found"}; the page
/// tells that apart from a missing person by `error`. Served by a one-shot
/// listener on 127.0.0.1, so no real Arena is involved.
#[test]
fn http_error_detail_reaches_the_page_as_error() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let t = std::thread::spawn(move || {
        let (mut s, _) = listener.accept().unwrap();
        // Read the whole request (head + Content-Length body) before answering,
        // or the client may still be writing when the socket closes.
        let mut req = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            let n = s.read(&mut chunk).unwrap();
            req.extend_from_slice(&chunk[..n]);
            if let Some(end) = req.windows(4).position(|w| w == b"\r\n\r\n") {
                let head = String::from_utf8_lossy(&req[..end]).to_lowercase();
                let len: usize = head.lines().find_map(|l| l.strip_prefix("content-length:")).map(|v| v.trim().parse().unwrap()).unwrap_or(0);
                if req.len() >= end + 4 + len {
                    break;
                }
            }
            if n == 0 {
                break;
            }
        }
        let body = b"{\"detail\": \"Not Found\"}";
        let head = format!("HTTP/1.1 404 Not Found\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
        s.write_all(head.as_bytes()).unwrap();
        s.write_all(body).unwrap();
    });
    let (status, body) = arena::http_request("POST", &format!("http://127.0.0.1:{}/v1/nudge", port), None, Some(&json!({})));
    t.join().unwrap();
    assert_eq!(status, 404);
    assert_eq!(body["error"], "Not Found");
}

// ---- the poller pass (test_arena_nudge.PollerTests, test_arena_pantry.PollOnceTests)

type Fired = Arc<Mutex<Vec<(String, String, bool)>>>;

fn poll(app: &claudehq::app::App, fail_on: Option<&'static str>) -> Vec<(String, String, bool)> {
    let fired: Fired = Arc::new(Mutex::new(Vec::new()));
    let f2 = fired.clone();
    app.arena_poll_once(&move |t: &str, b: &str, s: bool| {
        if fail_on.map(|x| t.contains(x)).unwrap_or(false) {
            return Err("notifier down".into());
        }
        f2.lock().unwrap().push((t.into(), b.into(), s));
        Ok(())
    });
    let v = fired.lock().unwrap().clone();
    v
}

fn f(t: &str, b: &str, s: bool) -> (String, String, bool) {
    (t.into(), b.into(), s)
}

#[test]
fn one_poll_pings_per_nudge_and_gifts_are_silent() {
    let (_d, app) = app();
    stub_fn(&app, "https://arena.example", |_m, u| {
        if u.ends_with("/v1/nudges") {
            (200, json!({"nudges": [{"fromName": "Ash", "note": "come look"}, {"fromHandle": "gary", "note": ""}]}))
        } else {
            (200, json!({"gifts": [{"fromName": "Gary", "coins": 2, "kind": "riceball", "qty": 1, "note": "for your sleepy Voltkit"}]}))
        }
    });
    assert_eq!(poll(&app, None), vec![
        f("\u{1F44B} Ash nudged you", "Ash nudged you: come look", true),
        f("\u{1F44B} gary nudged you", "gary nudged you", true),
        f("\u{1F381} Gary sent you a gift", "2 Poke Coins and 1 Rice Ball: for your sleepy Voltkit", false),
    ]);
}

#[test]
fn nothing_waiting_notifies_nothing() {
    let (_d, app) = app();
    stub_fn(&app, "https://arena.example", |_m, u| {
        if u.ends_with("/v1/nudges") { (200, json!({"nudges": []})) } else { (200, json!({"gifts": []})) }
    });
    assert!(poll(&app, None).is_empty());
}

#[test]
fn an_old_server_without_gifts_still_delivers_nudges() {
    let (_d, app) = app();
    stub_fn(&app, "https://arena.example", |_m, u| {
        if u.ends_with("/v1/nudges") {
            (200, json!({"nudges": [{"fromName": "Ash"}]}))
        } else {
            (404, json!({"detail": "Not Found", "error": "Not Found"}))
        }
    });
    let mut all = poll(&app, None);
    all.extend(poll(&app, None));
    assert_eq!(all, vec![f("\u{1F44B} Ash nudged you", "Ash nudged you", true); 2]);
    assert!(*app.arena.gift_off_until.lock().unwrap() > 0.0);
}

#[test]
fn a_failing_notify_does_not_drop_the_rest() {
    let (_d, app) = app();
    stub_fn(&app, "https://arena.example", |_m, u| {
        if u.ends_with("/v1/nudges") {
            (200, json!({"nudges": [{"fromName": "Boom"}, {"fromName": "Ash"}]}))
        } else {
            (200, json!({"gifts": []}))
        }
    });
    assert_eq!(poll(&app, Some("Boom")), vec![f("\u{1F44B} Ash nudged you", "Ash nudged you", true)]);
}

// ---- rooms (test_arena_rooms) ----------------------------------------------

#[test]
fn room_and_user_ids() {
    for good in [ROOM, "r_0123456789abcdef_ghi-k"] {
        assert!(arena::valid_room_id(&json!(good)), "{}", good);
    }
    for bad in [json!(""), json!("lobby"), json!("r_short"), json!("r_ABCDEFGHIJKLMNOPQRSTUv!"), json!("R_ABCDEFGHIJKLMNOPQRSTUv"), json!(123), json!(null)] {
        assert!(!arena::valid_room_id(&bad), "{}", bad);
    }
    assert!(arena::valid_user_id(UID));
    for bad in ["", "not-a-uuid", "01234567-89AB-CDEF-0123-456789ABCDEF"] {
        assert!(!arena::valid_user_id(bad), "{}", bad);
    }
}

#[test]
fn room_body_errors() {
    let e = |op: &str, b: Value| handlers::room_body_error(&format!("/api/arena/rooms/{}", op), b.as_object().unwrap());
    let has = |op: &str, b: Value, word: &str| {
        let err = e(op, b.clone()).unwrap_or_else(|| panic!("{} {} accepted", op, b));
        assert!(err.contains(word), "{} {} -> {}", op, b, err);
    };
    has("create", json!({}), "name");
    has("create", json!({"name": "hi"}), "password");
    has("create", json!({"name": "a".repeat(201), "password": "secret123"}), "name");
    has("create", json!({"name": "   ", "password": "secret123"}), "name");
    has("create", json!({"name": "test", "password": ""}), "password");
    assert_eq!(e("create", json!({"name": "My Room", "password": "secret123"})), None);
    has("join", json!({}), "roomId");
    has("join", json!({"roomId": ROOM}), "password");
    has("join", json!({"roomId": "bad", "password": "secret123"}), "roomId");
    has("leave", json!({}), "roomId");
    has("leave", json!({"roomId": "bad"}), "roomId");
    assert_eq!(e("leave", json!({"roomId": ROOM})), None);
    has("rename", json!({"roomId": ROOM}), "name");
    has("password", json!({"roomId": ROOM}), "password");
    has("kick", json!({"roomId": ROOM}), "userId");
    has("kick", json!({"roomId": ROOM, "userId": "not-uuid"}), "userId");
    has("unban", json!({"roomId": ROOM}), "userId");
    has("delete", json!({}), "roomId");
    has("password", json!({"roomId": ROOM, "password": "secret123", "signOutOthers": "yes"}), "signOutOthers");
    assert_eq!(e("password", json!({"roomId": ROOM, "password": "secret123", "signOutOthers": true})), None);
}

#[test]
fn room_posts_are_post_paths() {
    let posts = server::post_paths();
    for p in handlers::ARENA_ROOM_POSTS {
        assert!(posts.contains(&p), "{} not in post_paths", p);
    }
}

#[test]
fn room_proxies_refuse_bad_ids_before_any_request() {
    let (_d, app) = app();
    let sent = stub(&app, "https://arena.example", reply(200, json!({})));
    assert_eq!(app.arena_room_members("bad").0, 400);
    let o = |v: Value| v.as_object().unwrap().clone();
    for (op, body) in [
        ("join", json!({"roomId": "bad", "password": "pw"})),
        ("leave", json!({"roomId": "bad"})),
        ("rename", json!({"roomId": "bad", "name": "New Name"})),
        ("password", json!({"roomId": "bad", "password": "newpw123"})),
        ("delete", json!({"roomId": "bad"})),
        ("kick", json!({"roomId": ROOM, "userId": "bad"})),
        ("unban", json!({"roomId": ROOM, "userId": "bad"})),
    ] {
        assert_eq!(app.arena_room_post(op, &o(body)).0, 400, "{}", op);
    }
    assert!(sent.lock().unwrap().is_empty());
}

// ---- quest rewards (test_quest_proxy) ---------------------------------------

#[test]
fn quest_reward_wire() {
    let (_d, app) = app();
    let sent = stub(&app, "https://arena.example", reply(200, json!({"ok": true, "coins": 12, "reward": 2})));
    assert_eq!(app.arena_quest_reward("quest:d_prompts_10:2026-09-29", "quest", "d_prompts_10", None, 2).0, 200);
    app.arena_quest_reward("ach:a_prompts:bronze", "achievement", "a_prompts", Some("bronze"), 3);
    app.arena_quest_reward("quest:d_active:2026-09-29", "quest", "d_active", None, 1);
    {
        let s = sent.lock().unwrap();
        assert_eq!((s[0].0.as_str(), s[0].1.as_str(), s[0].2.as_deref()), ("POST", "https://arena.example/v1/pantry/reward", Some("T")));
        assert_eq!(s[0].3, Some(json!({"requestId": "quest:d_prompts_10:2026-09-29", "kind": "quest", "questId": "d_prompts_10", "coins": 2})));
        assert_eq!(s[1].3.as_ref().unwrap()["tier"], "bronze");
        assert_eq!(s[1].3.as_ref().unwrap()["kind"], "achievement");
    }
    assert_no_leaks(&sent);
    app.clear_link();
    assert_eq!(app.arena_quest_reward("quest:x:y", "quest", "x", None, 1).0, 400);
    assert_eq!(sent.lock().unwrap().len(), 3);
}

#[test]
fn quest_request_ids_use_their_own_pattern() {
    let (_d, app) = app();
    let sent = stub(&app, "https://arena.example", reply(200, json!({"ok": true})));
    let body = |rid: &str| json!({"requestId": rid, "kind": "quest", "questId": "d_prompts_10", "coins": 2});
    for good in ["quest:d_prompts_10:2026-09-29", "ach:a_prompts:bronze"] {
        assert_eq!(handlers::quest_reward(&app, &body(good)).0, 200, "{}", good);
    }
    for bad in ["hack:injection:attempt", "", RID] {
        assert_eq!(handlers::quest_reward(&app, &body(bad)), (400, json!({"error": "invalid requestId"})), "{}", bad);
    }
    assert_eq!(sent.lock().unwrap().len(), 2);
}
