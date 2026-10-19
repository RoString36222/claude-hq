//! Ported from tests/test_pantry_proxy.py (PantryBodyTests, OverlayTests,
//! RoutesAndConfigTests, the off-payload eat cases) and test_cali_proxy.py
//! (CaliBodyTests, ArenaAllowlistTests): what the page may ask for, and the
//! allowlists that rebuild every pantry / cali body before it leaves.

mod py_common;

use claudehq::arena::cali_order;
use claudehq::handlers::{cali_body, overlay_food_effects, pantry_body};
use py_common::*;
use serde_json::{json, Value};

// ---- pantry bodies -----------------------------------------------------------

fn ok(action: &str, body: Value) -> Value {
    let clean = pantry_body(action, &body).unwrap_or_else(|e| panic!("{} {} -> {}", action, body, e));
    assert!(clean.get("sessionId").is_none());
    clean
}

#[test]
fn pantry_body_buy_eat_give() {
    assert_eq!(ok("buy", json!({"requestId": RID, "kind": "berry", "qty": 5}))["qty"], 5);
    assert_eq!(pantry_body("buy", &json!({"requestId": RID, "kind": "pizza"})), Err("unknown food"));
    assert_eq!(ok("eat", json!({"requestId": RID, "kind": "tonic", "sessionId": SID, "retry": true})), json!({"requestId": RID, "kind": "tonic"}));
    let coins_only = ok("give", json!({"requestId": RID, "toHandle": "gary", "coins": 5}));
    assert!(coins_only.get("kind").is_none());
    assert_eq!((coins_only["qty"].clone(), coins_only["note"].clone()), (json!(0), json!("")));
    ok("give", json!({"requestId": RID, "toHandle": "gary", "kind": "tonic", "qty": 3}));
}

#[test]
fn pantry_body_give_errors() {
    for (extra, want) in [
        (json!({"coins": 0, "qty": 0}), "a gift needs Poke Coins or food"),
        (json!({"kind": "berry", "qty": 0, "coins": 1}), "pick an amount for that food"),
        (json!({"coins": "2"}), "coins must be a whole number from 0 to 5"),
        (json!({"kind": "berry", "qty": true}), "qty must be a whole number from 0 to 3"),
        (json!({"toHandle": "", "coins": 1}), "invalid handle"),
        (json!({"toHandle": "x".repeat(65), "coins": 1}), "invalid handle"),
    ] {
        let mut b = json!({"requestId": RID, "toHandle": "gary"});
        for (k, v) in extra.as_object().unwrap() {
            b[k] = v.clone();
        }
        assert_eq!(pantry_body("give", &b), Err(want), "{}", extra);
    }
}

#[test]
fn pantry_note_is_printable_and_a_non_string_is_dropped() {
    let note = format!("  for   your \u{0}sleepy\tVoltkit \u{1b}{}", "z".repeat(200));
    let n = ok("give", json!({"requestId": RID, "toHandle": "gary", "coins": 1, "note": note}))["note"].as_str().unwrap().to_string();
    assert!(n.chars().all(|c| !c.is_control()), "{:?}", n);
    assert_eq!(ok("give", json!({"requestId": RID, "toHandle": "gary", "coins": 1, "note": 42}))["note"], "");
}

// ---- the catalog overlay -------------------------------------------------------

#[test]
fn overlay_keeps_server_fields_in_order_and_drops_unknown_kinds() {
    let mut cat: Vec<Value> = json!([{"kind": "berry", "price": 1}, {"kind": "riceball", "price": 2}, {"kind": "bento", "price": 3},
                                     {"kind": "tonic", "price": 5}]).as_array().unwrap().clone();
    for c in cat.iter_mut() {
        c["restoreMins"] = json!(999);
    }
    cat.push(json!({"kind": "pizza", "price": 1}));
    cat.push(json!("junk"));
    let out = overlay_food_effects(json!({"coins": 3, "catalog": cat}));
    let kinds: Vec<&str> = out["catalog"].as_array().unwrap().iter().map(|c| c["kind"].as_str().unwrap()).collect();
    assert_eq!(kinds, ["berry", "riceball", "bento", "tonic"]);
    assert_eq!(out["catalog"][2]["restoreMins"], 120);
    assert_eq!(out["catalog"][1]["price"], 2);
    let t = &out["catalog"][3];
    assert_eq!((t["restoreMins"].clone(), t["revives"].clone(), t["wakeToMins"].clone()), (json!(0), json!(true), json!(105)));

    let by = overlay_food_effects(json!({"catalog": [
        {"kind": "pumpkinstew", "price": 2, "basePrice": 3, "inStock": true, "special": true, "season": "fall"},
        {"kind": "strawberry", "price": 1, "basePrice": 1, "inStock": false, "special": false, "season": "spring"},
        {"kind": "elixir", "price": 7, "restoreMins": 0, "revives": false},
    ]}));
    let p = &by["catalog"][0];
    assert_eq!((p["restoreMins"].clone(), p["wakeToMins"].clone()), (json!(135), json!(null)));
    assert_eq!((p["price"].clone(), p["basePrice"].clone(), p["special"].clone(), p["season"].clone()), (json!(2), json!(3), json!(true), json!("fall")));
    assert_eq!(by["catalog"][1]["inStock"], false);
    let e = &by["catalog"][2];
    assert_eq!((e["restoreMins"].clone(), e["revives"].clone(), e["wakeToMins"].clone()), (json!(60), json!(true), json!(45)));
}

#[test]
fn post_paths_and_the_fatigue_switch() {
    let posts = claudehq::server::post_paths();
    for p in ["/api/arena/pantry/claim", "/api/arena/pantry/buy", "/api/arena/pantry/eat", "/api/arena/pantry/give", "/api/action", "/api/config",
              "/api/meta", "/api/arena/pair", "/api/arena/unpair", "/api/arena/publish", "/api/arena/ticket", "/api/arena/nudge"] {
        assert!(posts.contains(&p), "{}", p);
    }
    assert_eq!(claudehq::app::default_config()["creatureFatigue"], true);
    assert_eq!(claudehq::app::validate_config(&json!({}), None)["creatureFatigue"], true);
    assert_eq!(claudehq::app::validate_config(&json!({"creatureFatigue": false}), None)["creatureFatigue"], false);
}

// ---- eating for a session outside the payload ----------------------------------

fn iso(t: i64) -> String {
    chrono::DateTime::from_timestamp(t, 0).unwrap().to_rfc3339()
}

/// A transcript the payload skips (no real prompt) whose Claude worked the last
/// `busy_mins` minutes, writing a record every few minutes as a real turn does.
fn transcript(app: &claudehq::app::App, sid: &str, busy_mins: i64) {
    let now = chrono::Utc::now().timestamp();
    let mut s = json!({"type": "user", "timestamp": iso(now - busy_mins * 60), "message": {"content": "<command-name>/go</command-name>"}}).to_string() + "\n";
    let mut m = busy_mins - 4;
    while m > 0 {
        s += &(json!({"type": "assistant", "timestamp": iso(now - m * 60), "message": {"content": [{"type": "text", "text": "step"}]}}).to_string() + "\n");
        m -= 4;
    }
    s += &(json!({"type": "system", "subtype": "turn_duration", "durationMs": busy_mins * 60 * 1000, "timestamp": iso(now)}).to_string() + "\n");
    let p = app.paths.projects_dir.join("proj").join(format!("{}.jsonl", sid));
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, s).unwrap();
}

fn server_eat(kind: &str) -> (u16, Value) {
    (200, json!({"op": "eat", "replayed": false, "kind": kind, "at": iso(chrono::Utc::now().timestamp() - 30), "coins": 4, "catalog": []}))
}

#[test]
fn off_payload_session_eats_by_the_drawers_fatigue() {
    let (_d, app) = app();
    let sent = stub(&app, "https://arena.example", reply(server_eat("berry").0, server_eat("berry").1));
    transcript(&app, OTHER_SID, 80);
    assert_eq!(app.build_session_detail(OTHER_SID).unwrap()["creature"]["fatigue"]["state"], "tired");
    let (code, resp) = app.pantry_eat(&json!({"sessionId": OTHER_SID, "kind": "berry", "requestId": RID}));
    assert_eq!(code, 200, "{}", resp);
    assert_eq!(resp["sessionId"], OTHER_SID);
    assert_eq!(sent.lock().unwrap().iter().map(|x| x.3.clone().unwrap()).collect::<Vec<_>>(), [json!({"requestId": RID, "kind": "berry"})]);
    assert_eq!(app.load_meals(None)[OTHER_SID].iter().map(|m| m.1.as_str()).collect::<Vec<_>>(), ["berry"]);
    assert_eq!(app.build_session_detail(OTHER_SID).unwrap()["creature"]["fatigue"]["lastMeal"]["kind"], "berry");
}

#[test]
fn off_payload_session_keeps_the_gate() {
    let (_d, app) = app();
    let sent = stub(&app, "https://arena.example", reply(200, json!({})));
    transcript(&app, OTHER_SID, 20);
    let (code, resp) = app.pantry_eat(&json!({"sessionId": OTHER_SID, "kind": "berry", "requestId": RID}));
    assert_eq!((code, resp["code"].as_str()), (409, Some("not_hungry")));
    app.save_config(&json!({"creatureFatigue": false})).unwrap();
    // The payload memo would carry the old fatigue until it expires (as in the
    // Python server); expire it now, as the next rebuild would.
    app.invalidate_payload_memo();
    assert!(app.build_session_detail(OTHER_SID).unwrap()["creature"].get("fatigue").is_none());
    let (code, resp) = app.pantry_eat(&json!({"sessionId": OTHER_SID, "kind": "berry", "requestId": RID}));
    assert_eq!((code, resp["code"].as_str()), (409, Some("fatigue_off")));
    assert!(sent.lock().unwrap().is_empty());
}

// ---- cali bodies (test_cali_proxy.CaliBodyTests) --------------------------------

fn counts(mh: i64) -> Value {
    json!({"mildHard": mh, "mildSoft": 0, "wildHard": 0, "wildSoft": 0})
}

fn order(diners: Value) -> Value {
    json!({"requestId": RID, "diners": diners})
}

fn cali_ok(body: Value) -> Value {
    let c = cali_body(&body).unwrap_or_else(|e| panic!("{} -> {}", body, e));
    assert!(c.get("sessionId").is_none());
    c
}

#[test]
fn cali_body_keeps_what_the_arena_needs() {
    let c = cali_ok(order(json!([{"name": "Ana", "tacos": counts(3)}])));
    assert!(c.get("date").is_none());
    let c = cali_ok(order(json!([{"name": "Ana", "tacos": {"wildSoft": 2}}])));
    assert_eq!(c["diners"][0]["tacos"], json!({"mildHard": 0, "mildSoft": 0, "wildHard": 0, "wildSoft": 2}));
    let c = cali_ok(order(json!([{"handle": "ana", "name": "Ana", "tacos": counts(1)}])));
    assert_eq!((c["diners"][0]["handle"].as_str(), c["diners"][0]["name"].as_str()), (Some("ana"), Some("Ana")));
    let many: Vec<Value> = (0..21).map(|i| json!({"name": format!("P{}", i), "tacos": counts(1)})).collect();
    assert!(cali_body(&order(Value::Array(many))).unwrap_err().contains("1 to 20 diners"));
    assert_eq!(cali_body(&json!({"requestId": "short", "diners": [{"name": "Ana"}]})).unwrap_err(), "invalid requestId");
    let mut o = order(json!([{"name": "Ana", "tacos": counts(1)}]));
    o["note"] = json!(format!("  bogo night  {}", "x".repeat(200)));
    let n = cali_ok(o)["note"].as_str().unwrap().to_string();
    assert!(n.starts_with("bogo night x") && n.chars().count() <= 80, "{}", n);
    let c = cali_ok(order(json!([{"name": format!("  A{}", "n".repeat(80)), "tacos": counts(1)}])));
    assert!(c["diners"][0]["name"].as_str().unwrap().chars().count() <= 40);
    let c = cali_ok(order(json!([{"name": "Ana", "items": {"churros": 3}}])));
    assert_eq!((c["diners"][0]["items"].clone(), c["diners"][0]["tacos"].clone()), (json!({"churros": 3}), counts(0)));
    for bad in [json!(21), json!(-1), json!("2"), json!(true), json!(1.5)] {
        assert!(cali_body(&order(json!([{"name": "Ana", "items": {"burrito": bad}}]))).unwrap_err().contains("whole number"), "{}", bad);
    }
    let mut o = order(json!([{"name": "Ana", "tacos": counts(1)}]));
    for k in ["totalTacos", "paidTacos", "freeTacos"] {
        o[k] = json!(9);
    }
    let c = cali_ok(o);
    assert!(["totalTacos", "paidTacos", "freeTacos"].iter().all(|k| c.get(*k).is_none()));
}

// ---- the second gate (test_cali_proxy.ArenaAllowlistTests) ----------------------

#[test]
fn cali_order_rebuilds_from_allowlisted_keys_only() {
    let clean = cali_order(&json!({"requestId": RID, "note": "bogo night", "date": "2026-09-29", "sessionId": SID, "projectName": "stealth-startup",
        "diners": [{"handle": "ana", "name": "Ana", "tacos": counts(3), "cwd": "/Users/ana", "title": "secret"}]}));
    assert!(leaks(&clean).is_empty());
    assert_eq!(top_keys(&clean), set(&["date", "diners", "note", "requestId"]));
    assert_eq!(top_keys(&clean["diners"][0]), set(&["handle", "name", "tacos"]));
    let clean = cali_order(&json!({"requestId": RID, "diners": [{"name": "Ana", "tacos": counts(1),
        "items": {"burrito": 2, "pizza": 9, "soda": "1", "guac": true, "nachos": 0, "cwd": "/Users/ana"}}]}));
    assert_eq!(clean["diners"][0]["items"], json!({"burrito": 2}));
    assert!(leaks(&clean).is_empty());
    for items in [json!({}), json!({"nachos": 0}), json!({"pizza": 1}), json!("burrito"), json!(null)] {
        let c = cali_order(&json!({"requestId": RID, "diners": [{"name": "Ana", "tacos": counts(1), "items": items}]}));
        assert!(c["diners"][0].get("items").is_none(), "{}", items);
    }
    assert_eq!(cali_order(&json!({"requestId": RID, "diners": ["ana", null, 7]}))["diners"], json!([]));
    assert_eq!(cali_order(&json!(null)), json!({"diners": []}));
}
