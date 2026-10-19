//! Ported from the LocalRouteTests / Wiring classes of tests/test_cali_proxy.py,
//! test_pantry_proxy.py, test_cups_proxy.py and test_maps_proxy.py: the real
//! router on an ephemeral 127.0.0.1 port, with the Arena transport stubbed.
//! Bodies are validated locally, POSTs need the CSRF token, and Arena answers
//! (refusals, failures) reach the page.

mod py_common;

use claudehq::ext;
use py_common::*;
use serde_json::{json, Value};

fn counts(mh: i64, ws: i64) -> Value {
    json!({"mildHard": mh, "mildSoft": 0, "wildHard": 0, "wildSoft": ws})
}

fn order(diners: Value) -> Value {
    json!({"requestId": RID, "diners": diners})
}

fn catalog() -> Value {
    json!([
        {"kind": "berry", "name": "Berry", "plural": "Berries", "price": 1, "restoreMins": 20, "revives": false},
        {"kind": "riceball", "name": "Rice Ball", "plural": "Rice Balls", "price": 2, "restoreMins": 45, "revives": false},
        {"kind": "bento", "name": "Bento", "plural": "Bentos", "price": 3, "restoreMins": 120, "revives": false},
        {"kind": "tonic", "name": "Revive Tonic", "plural": "Revive Tonics", "price": 5, "restoreMins": 0, "revives": true},
    ])
}

// ---- cali (test_cali_proxy.LocalRouteTests) ----------------------------------

#[test]
fn cali_board_window_and_orders() {
    let srv = serve();
    let sent = stub(&srv.app, "https://arena.example", reply(200, json!({"entries": []})));
    assert_eq!(http_get(&srv, "/api/arena/cali/board?window=7d").0, 200);
    assert_eq!(http_get(&srv, "/api/arena/cali/board?window=lastseason").0, 200);
    http_get(&srv, "/api/arena/cali/board?window=forever");
    assert_eq!(http_get(&srv, "/api/arena/cali/orders").0, 200);
    let s = sent.lock().unwrap();
    let urls: Vec<&str> = s.iter().map(|x| x.1.as_str()).collect();
    assert_eq!(urls, [
        "https://arena.example/v1/cali/board?window=7d",
        "https://arena.example/v1/cali/board?window=lastseason",
        "https://arena.example/v1/cali/board?window=season",
        "https://arena.example/v1/cali/orders",
    ]);
    assert!(s.iter().all(|x| x.0 == "GET" && x.3.is_none()));
}

#[test]
fn cali_post_order_forwards_the_clean_body() {
    let srv = serve();
    let r = reply(200, json!({"entries": []}));
    let sent = stub(&srv.app, "https://arena.example", r.clone());
    let (code, _) = http_post(&srv, "/api/arena/cali/order", &order(json!([{"name": "Ana", "tacos": counts(3, 0), "sessionId": SID}])), true);
    assert_eq!(code, 200);
    let (code, _) = http_post(&srv, "/api/arena/cali/order",
        &order(json!([{"name": "Ana", "tacos": counts(0, 2), "items": {"guac": 1, "burrito": 1}}])), true);
    assert_eq!(code, 200);
    {
        let s = sent.lock().unwrap();
        assert_eq!((s[0].0.as_str(), s[0].1.as_str()), ("POST", "https://arena.example/v1/cali/orders"));
        assert_eq!(s[0].3, Some(json!({"requestId": RID, "diners": [{"tacos": counts(3, 0), "name": "Ana"}], "note": ""})));
        assert_eq!(s[1].3.as_ref().unwrap()["diners"], json!([{"tacos": counts(0, 2), "items": {"burrito": 1, "guac": 1}, "name": "Ana"}]));
        // menu order, not the page's order
        assert_eq!(s[1].3.as_ref().unwrap()["diners"][0]["items"].as_object().unwrap().keys().collect::<Vec<_>>(), ["burrito", "guac"]);
    }
    // A bad body and a missing token never reach the Arena.
    let (code, body) = http_post(&srv, "/api/arena/cali/order", &order(json!([])), true);
    assert_eq!(code, 400);
    assert!(body["error"].as_str().unwrap().contains("diners"));
    assert_eq!(http_post(&srv, "/api/arena/cali/order", &order(json!([{"name": "Ana"}])), false).0, 403);
    assert_eq!(sent.lock().unwrap().len(), 2);
    // Arena refusals pass through; no answer is a 502.
    *r.lock().unwrap() = (404, json!({"detail": "no such person: ghost"}));
    let (code, body) = http_post(&srv, "/api/arena/cali/order", &order(json!([{"name": "Ana"}])), true);
    assert_eq!((code, body["detail"].as_str()), (404, Some("no such person: ghost")));
    *r.lock().unwrap() = (0, json!({"error": "connection refused"}));
    let (code, body) = http_get(&srv, "/api/arena/cali/board");
    assert_eq!(code, 502);
    assert!(body.get("error").is_some());
    assert_no_leaks(&sent);
}

// ---- pantry (test_pantry_proxy.LocalRouteTests) ------------------------------

#[test]
fn pantry_get_overlays_and_passes_errors_through() {
    let srv = serve();
    let r = reply(200, json!({"coins": 1, "catalog": catalog()}));
    let sent = stub(&srv.app, "https://arena.example", r.clone());
    let (code, body) = http_get(&srv, "/api/arena/pantry");
    assert_eq!(code, 200);
    assert_eq!(body["catalog"][3]["wakeToMins"], 105);
    assert_eq!(sent.lock().unwrap()[0], ("GET".into(), "https://arena.example/v1/pantry".into(), Some("T".into()), None));
    for err in [(404, json!({"detail": "Not Found", "error": "Not Found"})), (400, json!({"error": "not paired"}))] {
        *r.lock().unwrap() = err.clone();
        assert_eq!(http_get(&srv, "/api/arena/pantry"), err);
    }
    *r.lock().unwrap() = (0, json!({"error": "timed out"}));
    assert_eq!(http_get(&srv, "/api/arena/pantry"), (502, json!({"error": "timed out"})));
}

#[test]
fn pantry_posts_forward_clean_bodies() {
    let srv = serve();
    let r = reply(200, json!({"coins": 1, "catalog": catalog()}));
    let sent = stub(&srv.app, "https://arena.example", r.clone());
    let (code, body) = http_post(&srv, "/api/arena/pantry/buy", &json!({"requestId": RID, "kind": "bento", "sessionId": SID}), true);
    assert_eq!(code, 200);
    assert_eq!(body["catalog"][0]["restoreMins"], 20);
    assert_eq!(sent.lock().unwrap()[0].3, Some(json!({"requestId": RID, "kind": "bento", "qty": 1})));
    assert_eq!(http_post(&srv, "/api/arena/pantry/claim", &json!({}), true).0, 200);
    assert_eq!(http_post(&srv, "/api/arena/pantry/give", &json!({"requestId": RID, "toHandle": "gary", "coins": 1}), true).0, 200);
    let tails: Vec<String> = sent.lock().unwrap().iter().map(|x| x.1.rsplit('/').next().unwrap().to_string()).collect();
    assert_eq!(tails, ["buy", "claim", "give"]);

    sent.lock().unwrap().clear();
    assert_eq!(http_post(&srv, "/api/arena/pantry/buy", &json!({"requestId": RID, "kind": "berry", "qty": 9}), true),
               (400, json!({"error": "qty must be a whole number from 1 to 5"})));
    *r.lock().unwrap() = (0, json!({"error": "timed out"}));
    assert_eq!(http_post(&srv, "/api/arena/pantry/claim", &json!({}), true), (502, json!({"error": "timed out"})));
    assert_eq!(http_post(&srv, "/api/arena/pantry/steal", &json!({}), true), (404, json!({"error": "not found"})));
    assert_eq!(http_post(&srv, "/api/arena/pantry/claim", &json!({}), false).0, 403);
    assert_eq!(sent.lock().unwrap().len(), 1, "only the claim reached the Arena");
    assert_no_leaks(&sent);
}

// ---- cups (test_cups_proxy.CupsDashboardRouteTests) --------------------------

#[test]
fn cups_routes_answer_through_the_server() {
    let srv = serve();
    let sent = stub_fn(&srv.app, "https://arena.example", |_m, u| (200, json!({"ok": true, "url": u})));
    let uid = "0f8fad5b-d9cb-469f-a165-70867728950e";
    for (path, tail) in [
        ("/api/arena/cups".to_string(), "/v1/cups".to_string()),
        ("/api/arena/cups/one?id=cup-2026-W41-bowl".into(), "/v1/cups/cup-2026-W41-bowl".into()),
        ("/api/arena/cups/season?season=2026-10".into(), "/v1/cups/season?season=2026-10".into()),
        (format!("/api/arena/cups/trophies?u={}", uid), format!("/v1/cups/trophies/{}", uid)),
    ] {
        let (code, resp) = http_get(&srv, &path);
        assert_eq!(code, 200, "{}", path);
        assert!(resp["url"].as_str().unwrap().ends_with(&tail), "{}", path);
    }
    let (code, resp) = http_get(&srv, "/api/arena/cups/one?id=cup-2026-W41-td");
    assert_eq!(code, 400);
    assert!(resp.get("error").is_some());
    let s = sent.lock().unwrap();
    assert_eq!(s.len(), 4);
    assert!(s.iter().all(|x| x.0 == "GET" && x.3.is_none()));
}

// ---- maps (test_maps_proxy.Wiring) -------------------------------------------

#[test]
fn every_maps_post_is_csrf_guarded() {
    let srv = serve();
    let sent = stub(&srv.app, "https://arena.example", reply(200, json!({"maps": []})));
    let posts = claudehq::server::post_paths();
    for (p, _) in ext::POST.iter().filter(|(p, _)| p.starts_with("/api/arena/maps")) {
        assert!(posts.contains(p), "{}", p);
        assert_eq!(http_post(&srv, p, &json!({"id": "m-0123456789ab", "on": true}), false).0, 403, "{}", p);
    }
    assert!(sent.lock().unwrap().is_empty());
}

#[test]
fn maps_routes_reach_the_arena() {
    let srv = serve();
    let sent = stub(&srv.app, "https://arena.example", reply(200, json!({"maps": []})));
    assert_eq!(http_get(&srv, "/api/arena/maps?kind=kart&sort=top"), (200, json!({"maps": []})));
    assert_eq!(sent.lock().unwrap().last().unwrap().1, "https://arena.example/v1/maps?kind=kart&sort=top");
    assert_eq!(http_get(&srv, "/api/arena/maps/one?id=nope").0, 400);
    assert_eq!(http_get(&srv, "/api/arena/maps/featured").0, 200);
    let kart = json!({"tiles": "FSSSSSRSSSRSSSSSSSSRSSSRSS", "scenery": "forest", "theme": {"sky": "#9fd3f0"}});
    let body = json!({"kind": "kart", "name": "Loop", "data": kart, "scope": "public"});
    assert_eq!(http_post(&srv, "/api/arena/maps/save", &body, true).0, 200);
    assert_eq!(sent.lock().unwrap().last().unwrap().3, Some(body));
    assert_eq!(http_post(&srv, "/api/arena/maps/like", &json!({"id": "m-0123456789ab", "on": true}), true).0, 200);
    assert_eq!(sent.lock().unwrap().last().unwrap().1, "https://arena.example/v1/maps/m-0123456789ab/like");
}
