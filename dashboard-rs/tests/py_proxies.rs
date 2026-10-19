//! Ported from tests/test_boss_proxy.py, test_cups_proxy.py, test_loot_proxy.py,
//! test_maps_proxy.py, test_prestige_proxy.py and test_skills_proxy.py: the HQ
//! 2.5 proxy extensions forward only a validated id or an allowlisted body, the
//! reporters send counts only and only when opted in, and every POST route is a
//! CSRF-guarded POST path. The Arena transport (and `gh`) are stubbed.

mod py_common;

use claudehq::{ext, server, worksignals};
use indexmap::IndexMap;
use py_common::*;
use regex::Regex;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

const UID: &str = "0f8fad5b-d9cb-469f-a165-70867728950e";

fn urls(sent: &Sent) -> Vec<String> {
    sent.lock().unwrap().iter().map(|x| x.1.clone()).collect()
}

fn re(p: &str) -> Regex {
    Regex::new(p).unwrap()
}

// ---- boss ------------------------------------------------------------------

fn spec() -> Value {
    json!({"sp": 1, "st": 4, "br": null, "mg": null, "sh": false})
}

fn with(k: &str, v: Value) -> Value {
    let mut x = spec();
    x[k] = v;
    x
}

#[test]
fn boss_routes_and_wire() {
    let gets: Vec<&str> = ext::GET.iter().map(|(p, _)| *p).filter(|p| p.starts_with("/api/arena/boss")).collect();
    assert_eq!(gets, ["/api/arena/boss", "/api/arena/boss/badges"]);
    let posts: Vec<&str> = ext::POST.iter().map(|(p, _)| *p).filter(|p| p.starts_with("/api/arena/boss")).collect();
    assert_eq!(posts, ["/api/arena/boss/fight"]);
    assert!(server::post_paths().contains(&"/api/arena/boss/fight"));

    let (_d, app) = app();
    let sent = stub(&app, "https://arena.example", reply(200, json!({"ok": true})));
    let (state, badges, fight) = (ext_get("/api/arena/boss"), ext_get("/api/arena/boss/badges"), ext_post("/api/arena/boss/fight"));
    assert_eq!(state(&app, &arg(&[])).0, 200);
    assert_eq!(sent.lock().unwrap()[0], ("GET".into(), "https://arena.example/v1/boss".into(), Some("T".into()), None));
    sent.lock().unwrap().clear();
    badges(&app, &arg(&[]));
    badges(&app, &arg(&[("u", "me")]));
    badges(&app, &arg(&[("u", UID)]));
    assert_eq!(urls(&sent), [
        "https://arena.example/v1/boss/badges/me".to_string(),
        "https://arena.example/v1/boss/badges/me".to_string(),
        format!("https://arena.example/v1/boss/badges/{}", UID),
    ]);
    sent.lock().unwrap().clear();
    for bad in ["../x", "abc", &format!("{}/x", UID), "ME"] {
        assert_eq!(badges(&app, &arg(&[("u", bad)])).0, 400, "{}", bad);
    }
    assert!(sent.lock().unwrap().is_empty());

    let mega = json!({"sp": 3, "st": 4, "br": null, "mg": "charizard-mega-x", "sh": 1});
    assert_eq!(fight(&app, &json!({"requestId": "boss-0123456789abcdef", "team": [spec(), mega]})).0, 200);
    {
        let s = sent.lock().unwrap();
        assert_eq!((s[0].0.as_str(), s[0].1.as_str(), s[0].2.as_deref()), ("POST", "https://arena.example/v1/boss/fight", Some("T")));
        assert_eq!(s[0].3, Some(json!({"requestId": "boss-0123456789abcdef", "team": [spec(),
            {"sp": 3, "st": 4, "br": null, "mg": "charizard-mega-x", "sh": true}]})));
    }
    // A request id is minted when absent; unknown top-level keys never leave.
    fight(&app, &json!({"team": [spec()], "title": "x", "sessionId": "s"}));
    let body = sent.lock().unwrap()[1].3.clone().unwrap();
    assert_eq!(top_keys(&body), set(&["requestId", "team"]));
    assert!(re(r"^boss-[0-9a-f]{32}$").is_match(body["requestId"].as_str().unwrap()));
    assert_no_leaks(&sent);
}

#[test]
fn boss_refuses_bad_teams_and_ids_locally() {
    let (_d, app) = app();
    let sent = stub(&app, "https://arena.example", reply(200, json!({"ok": true})));
    let fight = ext_post("/api/arena/boss/fight");
    let seven = Value::Array(vec![spec(); 7]);
    let mut extra = spec();
    extra["name"] = json!("Sparky");
    for team in [json!(null), json!("x"), json!([]), seven, json!([1]), json!([extra]), json!([{"sp": 1, "st": 4}]),
                 json!([with("sp", json!(true))]), json!([with("sp", json!(1.0))]), json!([with("st", json!(5))]),
                 json!([with("sp", json!(-1))]), json!([with("br", json!("x"))]), json!([with("mg", json!("<b>"))]),
                 json!([with("sh", json!(2))]), json!([with("path", json!("/x"))])] {
        let (code, resp) = fight(&app, &json!({"team": team}));
        assert_eq!(code, 400, "{}", team);
        assert!(resp.get("error").is_some());
    }
    for rid in [json!("short"), json!("x".repeat(65)), json!("has space in it ok"), json!(12345678901234567i64)] {
        assert_eq!(fight(&app, &json!({"team": [spec()], "requestId": rid})).0, 400, "{}", rid);
    }
    assert!(sent.lock().unwrap().is_empty());
}

#[test]
fn boss_unpaired_is_local() {
    let (_d, app) = app();
    let sent = stub(&app, "https://arena.example", reply(200, json!({})));
    app.clear_link();
    assert_eq!(ext_get("/api/arena/boss")(&app, &arg(&[])).0, 400);
    assert_eq!(ext_get("/api/arena/boss/badges")(&app, &arg(&[("u", "me")])).0, 400);
    assert_eq!(ext_post("/api/arena/boss/fight")(&app, &json!({"team": [spec()]})).0, 400);
    assert!(sent.lock().unwrap().is_empty());
}

// ---- cups ------------------------------------------------------------------

#[test]
fn cups_are_get_only_and_validate_ids() {
    assert!(ext::POST.iter().all(|(p, _)| !p.starts_with("/api/arena/cups")));
    let gets: Vec<&str> = ext::GET.iter().map(|(p, _)| *p).filter(|p| p.starts_with("/api/arena/cups")).collect();
    assert_eq!(gets, ["/api/arena/cups", "/api/arena/cups/one", "/api/arena/cups/season", "/api/arena/cups/trophies"]);

    let (_d, app) = app();
    let sent = stub(&app, "https://arena.example", reply(200, json!({"week": "2026-W41", "cups": []})));
    let (list, one, season, trophies) = (ext_get("/api/arena/cups"), ext_get("/api/arena/cups/one"), ext_get("/api/arena/cups/season"), ext_get("/api/arena/cups/trophies"));
    assert_eq!(list(&app, &arg(&[])).0, 200);
    assert_eq!(sent.lock().unwrap()[0].1, "https://arena.example/v1/cups");
    assert_eq!(sent.lock().unwrap()[0].2.as_deref(), Some("T"));
    assert_eq!(one(&app, &arg(&[("id", "cup-2026-W41-kart")])).0, 200);
    assert_eq!(urls(&sent).last().unwrap(), "https://arena.example/v1/cups/cup-2026-W41-kart");
    let n = sent.lock().unwrap().len();
    for bad in ["", "cup-2026-W41-td", "cup-2026-W54-kart", "cup-2026-W00-golf", "cup-2026-W41-kart/../x", "cup-2026-W41-kart?x=1",
                "../v1/admin", "cup-26-W41-kart", "CUP-2026-W41-kart"] {
        assert_eq!(one(&app, &arg(&[("id", bad)])).0, 400, "{}", bad);
    }
    // The server hands the id over untrimmed; a trailing newline is refused.
    assert_eq!(one(&app, &|_k: &str| "cup-2026-W41-kart\n".to_string()).0, 400);
    assert_eq!(sent.lock().unwrap().len(), n);
    for g in ["kart", "plat", "golf", "fps", "type", "bowl"] {
        assert_eq!(one(&app, &arg(&[("id", &format!("cup-2026-W53-{}", g))])).0, 200, "{}", g);
    }

    season(&app, &arg(&[]));
    assert_eq!(urls(&sent).last().unwrap(), "https://arena.example/v1/cups/season");
    season(&app, &arg(&[("season", "2026-09")]));
    assert_eq!(urls(&sent).last().unwrap(), "https://arena.example/v1/cups/season?season=2026-09");
    trophies(&app, &arg(&[]));
    assert_eq!(urls(&sent).last().unwrap(), "https://arena.example/v1/cups/trophies/me");
    trophies(&app, &arg(&[("u", UID)]));
    assert_eq!(*urls(&sent).last().unwrap(), format!("https://arena.example/v1/cups/trophies/{}", UID));
    let n = sent.lock().unwrap().len();
    for bad in ["2026-13", "2026-9", "26-09", "2026-09&x=1", "2026-00"] {
        assert_eq!(season(&app, &arg(&[("season", bad)])).0, 400, "{}", bad);
    }
    for bad in ["alice".to_string(), "../me".into(), UID.to_uppercase(), format!("{}x", UID), "me/../x".into()] {
        assert_eq!(trophies(&app, &arg(&[("u", &bad)])).0, 400, "{}", bad);
    }
    assert_eq!(sent.lock().unwrap().len(), n);
    for (m, url, _, body) in sent.lock().unwrap().iter() {
        assert_eq!(m, "GET", "{}", url);
        assert!(body.is_none(), "{}", url);
    }

    // A link with no token is not paired: nothing leaves.
    app.save_link(&json!({"url": "https://arena.example"})).unwrap();
    sent.lock().unwrap().clear();
    for g in [list, season, trophies] {
        assert_eq!(g(&app, &arg(&[])).0, 400);
    }
    assert_eq!(one(&app, &arg(&[("id", "cup-2026-W41-golf")])).0, 400);
    assert!(sent.lock().unwrap().is_empty());
}

// ---- loot ------------------------------------------------------------------

type GhCalls = Arc<Mutex<Vec<Vec<String>>>>;

struct Loot {
    _d: tempfile::TempDir,
    app: Arc<claudehq::app::App>,
    sent: Sent,
    reply: ReplyCell,
    rows: Arc<Mutex<usize>>,
    gh: GhCalls,
}

fn pr_rows(n: usize) -> Value {
    Value::Array((0..n).map(|i| json!({"url": format!("https://github.com/acme/secret-repo/pull/{}", i + 1)})).collect())
}

fn loot() -> Loot {
    let (d, app) = app();
    let r = reply(200, json!({"accepted": 1, "chests": [{"id": format!("ch-{}", "a".repeat(32))}]}));
    let sent = stub(&app, "https://arena.example", r.clone());
    app.save_config(&json!({"workSignals": true, "workSignalsPRs": true})).unwrap();
    let rows = Arc::new(Mutex::new(3usize));
    let gh: GhCalls = Arc::new(Mutex::new(Vec::new()));
    let (r2, g2) = (rows.clone(), gh.clone());
    *app.ext.gh_which_hook.write().unwrap() = Some(true);
    *app.ext.gh_hook.write().unwrap() = Some(Arc::new(move |argv: &[String]| {
        g2.lock().unwrap().push(argv.to_vec());
        Some((0, pr_rows(*r2.lock().unwrap()).to_string()))
    }));
    *app.ext.day_counts_hook.write().unwrap() = Some(Arc::new(|_| IndexMap::new()));
    Loot { _d: d, app, sent, reply: r, rows, gh }
}

fn assert_loot_wire_clean(l: &Loot) {
    assert_no_leaks(&l.sent);
    for (_, _, _, b) in l.sent.lock().unwrap().iter() {
        assert!(!b.as_ref().map(|b| b.to_string()).unwrap_or_default().contains("github.com"));
    }
}

fn today() -> String {
    chrono::Utc::now().date_naive().format("%Y-%m-%d").to_string()
}

#[test]
fn loot_first_scan_is_a_baseline_then_a_new_merge_reports_one() {
    let l = loot();
    ext::loot_run_once(&l.app);
    assert!(l.sent.lock().unwrap().is_empty(), "no backfill burst on the first run");
    {
        let gh = l.gh.lock().unwrap();
        assert_eq!(gh.len(), 1);
        assert_eq!(&gh[0][..6], &["gh", "search", "prs", "--author=@me", "--merged", "--merged-at"]);
        assert!(gh[0][6].starts_with(">="));
        assert_eq!(&gh[0][7..], &["--json", "url", "--limit", "50"]);
    }
    ext::loot_run_once(&l.app);
    assert!(l.sent.lock().unwrap().is_empty(), "nothing new merged");
    *l.rows.lock().unwrap() = 4;
    ext::loot_run_once(&l.app);
    {
        let s = l.sent.lock().unwrap();
        assert_eq!(s.len(), 1);
        assert_eq!((s[0].0.as_str(), s[0].1.as_str(), s[0].2.as_deref()), ("POST", "https://arena.example/v1/loot/events", Some("T")));
        let body = s[0].3.as_ref().unwrap();
        assert_eq!(top_keys(body), set(&["requestId", "type", "n", "day"]));
        assert_eq!((body["type"].as_str(), body["n"].as_i64(), body["day"].as_str()), (Some("pr_merged"), Some(1), Some(today().as_str())));
        assert!(re(r"^loot-[0-9a-f]{40}$").is_match(body["requestId"].as_str().unwrap()));
    }
    ext::loot_run_once(&l.app);
    assert_eq!(l.sent.lock().unwrap().len(), 1);
    assert_loot_wire_clean(&l);
}

#[test]
fn loot_state_file_keeps_hashes_not_urls() {
    use std::os::unix::fs::PermissionsExt;
    let l = loot();
    ext::loot_run_once(&l.app);
    let p = &l.app.paths.loot_state;
    assert_eq!(std::fs::metadata(p).unwrap().permissions().mode() & 0o777, 0o600);
    let raw = std::fs::read_to_string(p).unwrap();
    assert!(!raw.contains("github") && !raw.contains("secret-repo"));
    let st: Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(st["seen"].as_array().unwrap().len(), 3);
}

#[test]
fn loot_a_4xx_is_not_retried_but_a_5xx_is() {
    let l = loot();
    ext::loot_run_once(&l.app);
    *l.rows.lock().unwrap() = 4;
    *l.reply.lock().unwrap() = (422, json!({"error": "day must be today or yesterday (UTC)"}));
    ext::loot_run_once(&l.app);
    ext::loot_run_once(&l.app);
    assert_eq!(l.sent.lock().unwrap().len(), 1, "a 422 marks the delta sent");
    *l.rows.lock().unwrap() = 5;
    *l.reply.lock().unwrap() = (503, json!({"error": "busy"}));
    ext::loot_run_once(&l.app);
    *l.reply.lock().unwrap() = (0, json!({"error": "offline"}));
    ext::loot_run_once(&l.app);
    *l.reply.lock().unwrap() = (200, json!({"accepted": 1, "chests": []}));
    ext::loot_run_once(&l.app);
    ext::loot_run_once(&l.app);
    let s = l.sent.lock().unwrap();
    let rids: Vec<&Value> = s[1..].iter().map(|x| &x.3.as_ref().unwrap()["requestId"]).collect();
    assert_eq!(rids.len(), 3, "retried until a 2xx, then quiet");
    assert!(rids.iter().all(|r| *r == rids[0]), "a retry reuses its requestId");
}

#[test]
fn loot_runs_no_gh_unless_prs_on_and_gh_present() {
    let l = loot();
    l.app.save_config(&json!({"workSignalsPRs": false})).unwrap();
    ext::loot_run_once(&l.app);
    ext_get("/api/loot/status")(&l.app, &arg(&[]));
    assert!(l.gh.lock().unwrap().is_empty());
    assert!(l.sent.lock().unwrap().is_empty());

    let l = loot();
    *l.app.ext.gh_which_hook.write().unwrap() = Some(false);
    ext::loot_run_once(&l.app);
    assert!(l.gh.lock().unwrap().is_empty());
}

#[test]
fn loot_work_signals_off_or_unpaired_sends_nothing_at_all() {
    let l = loot();
    l.app.save_config(&json!({"workSignals": false, "workSignalsPRs": true})).unwrap();
    let t = today();
    *l.app.ext.day_counts_hook.write().unwrap() = Some(Arc::new(move |_| {
        [(t.clone(), [("tests_green".to_string(), 3i64)].into_iter().collect())].into_iter().collect()
    }));
    assert!(ext::loot_run_once(&l.app).get("skipped").is_some());
    assert!(l.sent.lock().unwrap().is_empty());
    assert!(l.gh.lock().unwrap().is_empty());
    assert!(!l.app.paths.loot_state.exists());

    let l = loot();
    l.app.save_link(&json!({"url": "https://arena.example"})).unwrap();
    ext::loot_run_once(&l.app);
    assert!(l.sent.lock().unwrap().is_empty());
    assert!(l.gh.lock().unwrap().is_empty());
    assert_eq!(ext_get("/api/arena/loot")(&l.app, &arg(&[])).0, 400);
}

#[test]
fn loot_worksignals_counts_report_as_deltas() {
    let l = loot();
    l.app.save_config(&json!({"workSignalsPRs": false})).unwrap();
    let t = today();
    let y = (chrono::Utc::now().date_naive() - chrono::Duration::days(1)).format("%Y-%m-%d").to_string();
    let mk = |pairs: &[(&str, i64)]| pairs.iter().map(|(k, v)| (k.to_string(), *v)).collect::<IndexMap<String, i64>>();
    let counts: Arc<Mutex<IndexMap<String, IndexMap<String, i64>>>> = Arc::new(Mutex::new(
        [(t.clone(), mk(&[("tests_green", 2), ("focus_long", 1), ("tests", 40), ("docs", 3)])),
         (y.clone(), mk(&[("tests_green", 1)])),
         ("2020-01-01".to_string(), mk(&[("tests_green", 9)]))].into_iter().collect(),
    ));
    let c2 = counts.clone();
    *l.app.ext.day_counts_hook.write().unwrap() = Some(Arc::new(move |_| c2.lock().unwrap().clone()));
    let status = ext_get("/api/loot/status");
    assert_eq!(status(&l.app, &arg(&[])).1["pending"], json!({"tests_green": 3, "focus_long": 1}));
    ext::loot_run_once(&l.app);
    let mut got: Vec<(String, String, i64)> = l.sent.lock().unwrap().iter().map(|x| {
        let b = x.3.as_ref().unwrap();
        assert_eq!(top_keys(b), set(&["requestId", "type", "n", "day"]));
        (b["type"].as_str().unwrap().into(), b["day"].as_str().unwrap().into(), b["n"].as_i64().unwrap())
    }).collect();
    got.sort();
    let mut want = vec![("focus_long".to_string(), t.clone(), 1), ("tests_green".to_string(), t.clone(), 2), ("tests_green".to_string(), y, 1)];
    want.sort();
    assert_eq!(got, want);
    counts.lock().unwrap().get_mut(&t).unwrap().insert("tests_green".into(), 9);
    ext::loot_run_once(&l.app);
    {
        let s = l.sent.lock().unwrap();
        assert_eq!(s[s.len() - 2..].iter().map(|x| x.3.as_ref().unwrap()["n"].as_i64().unwrap()).collect::<Vec<_>>(), [5, 2], "split into n<=5");
    }
    let st = status(&l.app, &arg(&[])).1;
    assert_eq!(st["pending"], json!({}));
    assert_eq!((st["enabled"].clone(), st["prs"].clone()), (json!(true), json!(false)));
    assert!(!st["lastReport"].is_null());
}

#[test]
fn loot_old_days_are_pruned() {
    let l = loot();
    let mut st = l.app.loot_load_state();
    st.insert("sent".into(), json!({"pr_merged": {"2020-01-01": 3}}));
    st.insert("prs".into(), json!({"2020-01-01": 3}));
    l.app.loot_save_state(&st).unwrap();
    ext::loot_run_once(&l.app);
    let st = l.app.loot_load_state();
    assert_eq!(st["prs"], json!({}));
    assert_eq!(st["sent"]["pr_merged"], json!({}));
}

#[test]
fn loot_open_forwards_only_the_chest_and_a_request_id() {
    let l = loot();
    let open = ext_post("/api/arena/loot/open");
    let cid = format!("ch-{}", "0123456789abcdef".repeat(2));
    assert_eq!(open(&l.app, &json!({"chestId": cid, "title": "x", "path": "/etc"})).0, 200);
    {
        let s = l.sent.lock().unwrap();
        let (m, url, _, body) = s.last().unwrap();
        assert_eq!((m.as_str(), url.as_str()), ("POST", "https://arena.example/v1/loot/open"));
        assert_eq!(top_keys(body.as_ref().unwrap()), set(&["chestId", "requestId"]));
        assert!(re(r"^open-[0-9a-f]{24}$").is_match(body.as_ref().unwrap()["requestId"].as_str().unwrap()));
    }
    open(&l.app, &json!({"chestId": cid, "requestId": "open-mine-0123456789"}));
    assert_eq!(l.sent.lock().unwrap().last().unwrap().3.as_ref().unwrap()["requestId"], "open-mine-0123456789");
    let n = l.sent.lock().unwrap().len();
    for bad in [json!(""), json!("ch-xyz"), json!(format!("ch-{}", "A".repeat(32))), json!(null), json!(7), json!("../v1/loot")] {
        assert_eq!(open(&l.app, &json!({"chestId": bad})).0, 400, "{}", bad);
    }
    assert_eq!(l.sent.lock().unwrap().len(), n);
}

#[test]
fn loot_get_proxies_and_routes_are_registered() {
    let l = loot();
    assert_eq!(ext_get("/api/arena/loot")(&l.app, &arg(&[])).0, 200);
    let last = l.sent.lock().unwrap().last().cloned().unwrap();
    assert_eq!((last.0.as_str(), last.1.as_str()), ("GET", "https://arena.example/v1/loot"));
    let posts: Vec<&str> = ext::POST.iter().map(|(p, _)| *p).filter(|p| p.contains("loot")).collect();
    assert_eq!(posts, ["/api/arena/loot/open"]);
    assert!(server::post_paths().contains(&"/api/arena/loot/open"));
    ext_get("/api/loot/status");
}

// ---- maps ------------------------------------------------------------------

const MID: &str = "m-0123456789ab";
const MAP_UID: &str = "0f1e2d3c-4b5a-4968-8776-655443322110";

fn kart() -> Value {
    json!({"tiles": "FSSSSSRSSSRSSSSSSSSRSSSRSS", "scenery": "forest", "theme": {"sky": "#9fd3f0", "fog": "#cfe8f2", "ground": "#76b85a"}})
}

fn kart_with(k: &str, v: Value) -> Value {
    let mut x = kart();
    x[k] = v;
    x
}

fn maps_app() -> (tempfile::TempDir, Arc<claudehq::app::App>, Sent) {
    let (d, app) = app();
    let sent = stub(&app, "https://arena.example/", reply(200, json!({"ok": true})));
    (d, app, sent)
}

#[test]
fn map_save_forwards_exactly_the_six_keys() {
    let (_d, app, sent) = maps_app();
    let save = ext_post("/api/arena/maps/save");
    assert_eq!(save(&app, &json!({"kind": "kart", "name": "  Loop  ", "data": kart(), "scope": "public"})).0, 200);
    {
        let s = sent.lock().unwrap();
        assert_eq!((s[0].0.as_str(), s[0].1.as_str()), ("POST", "https://arena.example/v1/maps"));
        assert_eq!(s[0].3, Some(json!({"kind": "kart", "name": "Loop", "data": kart(), "scope": "public"})));
    }
    save(&app, &json!({"id": MID, "kind": "kart", "name": "Home", "data": kart(), "scope": "room", "roomId": format!("hq_{}", MAP_UID)}));
    let body = sent.lock().unwrap().last().unwrap().3.clone().unwrap();
    assert_eq!(top_keys(&body), set(&ext::MAP_SAVE_KEYS));
    save(&app, &json!({"kind": "plat", "name": "Crew", "data": {"kill": -5}, "scope": "room", "roomId": format!("r_{}", "A".repeat(22))}));
    assert_eq!(sent.lock().unwrap().last().unwrap().3.as_ref().unwrap()["roomId"], json!(format!("r_{}", "A".repeat(22))));
    for (_, _, t, _) in sent.lock().unwrap().iter() {
        assert_eq!(t.as_deref(), Some("T"));
    }
    assert_no_leaks(&sent);
}

#[test]
fn map_save_refuses_bad_bodies_locally() {
    let (_d, app, sent) = maps_app();
    let save = ext_post("/api/arena/maps/save");
    let b = |kind: &str, name: Value, data: Value, scope: &str| json!({"kind": kind, "name": name, "data": data, "scope": scope});
    let mut bad = vec![
        json!({"kind": "kart", "name": "X", "data": kart(), "scope": "public", "title": "x"}),
        b("golf", json!("X"), kart(), "public"),
        b("kart", json!(""), kart(), "public"),
        b("kart", json!("x".repeat(33)), kart(), "public"),
        b("kart", json!("<b>"), kart(), "public"),
        b("kart", json!("go to http://x"), kart(), "public"),
        b("kart", json!("www.x.io"), kart(), "public"),
        b("kart", json!("a\u{7}b"), kart(), "public"),
        b("kart", json!(5), kart(), "public"),
        b("kart", json!("X"), json!([1]), "public"),
        b("kart", json!("X"), kart_with("pad", json!("x".repeat(13 * 1024))), "public"),
        b("kart", json!("X"), kart_with("deco", json!([{"text": "hi"}])), "public"),
        b("kart", json!("X"), kart_with("path", json!("FSS")), "public"),
        b("kart", json!("X"), kart(), "friends"),
        b("kart", json!("X"), kart(), "room"),
        json!({"id": "m-XYZ", "kind": "kart", "name": "X", "data": kart(), "scope": "public"}),
        json!({"id": 7, "kind": "kart", "name": "X", "data": kart(), "scope": "public"}),
        json!(null), json!([]), json!("x"),
    ];
    for room in ["lobby", "qp_abc"] {
        let mut x = b("kart", json!("X"), kart(), "room");
        x["roomId"] = json!(room);
        bad.push(x);
    }
    let mut x = b("kart", json!("X"), kart(), "public");
    x["roomId"] = json!(format!("hq_{}", MAP_UID));
    bad.push(x);
    for body in bad {
        let (code, resp) = save(&app, &body);
        assert_eq!(code, 400, "{}", body);
        assert!(resp.get("error").is_some());
    }
    assert!(sent.lock().unwrap().is_empty());
}

#[test]
fn map_like_report_delete_hide() {
    let (_d, app, sent) = maps_app();
    let (like, report, delete, hide) = (ext_post("/api/arena/maps/like"), ext_post("/api/arena/maps/report"), ext_post("/api/arena/maps/delete"), ext_post("/api/arena/maps/hide"));
    let last = || sent.lock().unwrap().last().cloned().unwrap();
    like(&app, &json!({"id": MID, "on": true}));
    assert_eq!((last().0, last().1, last().3), ("POST".into(), format!("https://arena.example/v1/maps/{}/like", MID), Some(json!({"on": true}))));
    report(&app, &json!({"id": MID, "reason": "broken"}));
    assert_eq!((last().1, last().3), (format!("https://arena.example/v1/maps/{}/report", MID), Some(json!({"reason": "broken"}))));
    delete(&app, &json!({"id": MID}));
    assert_eq!((last().1, last().3), (format!("https://arena.example/v1/maps/{}/delete", MID), Some(json!({}))));
    hide(&app, &json!({"id": MID, "hidden": false}));
    assert_eq!(last().3, Some(json!({"hidden": false})));
    let n = sent.lock().unwrap().len();
    for (f, b) in [(like, json!({"id": MID, "on": 1})), (like, json!({"id": "../x", "on": true})), (report, json!({"id": MID, "reason": "meh"})),
                   (report, json!({"reason": "spam"})), (delete, json!({"id": format!("{}0", MID)})), (hide, json!({"id": MID})), (like, json!(null))] {
        assert_eq!(f(&app, &b).0, 400, "{}", b);
    }
    assert_eq!(sent.lock().unwrap().len(), n);
}

#[test]
fn map_reads_build_a_clean_query() {
    let (_d, app, sent) = maps_app();
    let (list, one, featured) = (ext_get("/api/arena/maps"), ext_get("/api/arena/maps/one"), ext_get("/api/arena/maps/featured"));
    let last = || sent.lock().unwrap().last().cloned().unwrap();
    list(&app, &arg(&[]));
    assert_eq!((last().0.as_str(), last().1.as_str()), ("GET", "https://arena.example/v1/maps"));
    list(&app, &arg(&[("kind", "kart"), ("sort", "week"), ("limit", "12"), ("cursor", "ab12")]));
    assert_eq!(last().1, "https://arena.example/v1/maps?kind=kart&sort=week&cursor=ab12&limit=12");
    list(&app, &arg(&[("room", &format!("hq_{}", MAP_UID))]));
    assert!(last().1.ends_with(&format!("?room=hq_{}", MAP_UID)));
    list(&app, &arg(&[("mine", "1"), ("ckey", "c-0123456789ab")]));
    assert!(last().1.ends_with("?mine=1&ckey=c-0123456789ab"));
    let n = sent.lock().unwrap().len();
    let room = format!("hq_{}", MAP_UID);
    for d in [vec![("kind", "golf")], vec![("sort", "old")], vec![("room", "qp_x")], vec![("limit", "31")], vec![("limit", "x")],
              vec![("cursor", "zz")], vec![("ckey", "meadow")], vec![("mine", "1"), ("room", room.as_str())]] {
        assert_eq!(list(&app, &arg(&d)).0, 400, "{:?}", d);
    }
    assert_eq!(sent.lock().unwrap().len(), n);
    one(&app, &arg(&[("id", MID)]));
    assert_eq!((last().0, last().1), ("GET".into(), format!("https://arena.example/v1/maps/{}", MID)));
    assert_eq!(one(&app, &arg(&[("id", "m-1/../x")])).0, 400);
    featured(&app, &arg(&[]));
    assert_eq!(last().1, "https://arena.example/v1/maps/featured");
    for (_, _, _, b) in sent.lock().unwrap().iter() {
        assert!(b.is_none());
    }

    app.clear_link();
    sent.lock().unwrap().clear();
    assert_eq!(featured(&app, &arg(&[])).0, 400);
    assert_eq!(ext_post("/api/arena/maps/save")(&app, &json!({"kind": "kart", "name": "X", "data": kart(), "scope": "public"})).0, 400);
    assert!(sent.lock().unwrap().is_empty());
}

// ---- prestige --------------------------------------------------------------

#[test]
fn prestige_proxy() {
    let puid = "0123abcd-0000-4000-8000-00000000beef";
    let (_d, app) = app();
    let sent = stub(&app, "https://arena.test", reply(200, json!({"stars": 1})));
    let (get, claim) = (ext_get("/api/arena/prestige"), ext_post("/api/arena/prestige/claim"));
    assert_eq!(get(&app, &arg(&[])).0, 200);
    get(&app, &arg(&[("u", puid)]));
    {
        let s = sent.lock().unwrap();
        assert_eq!(s[0], ("GET".into(), "https://arena.test/v1/prestige/me".into(), Some("T".into()), None));
        assert_eq!(s[1].1, format!("https://arena.test/v1/prestige/{}", puid));
    }
    sent.lock().unwrap().clear();
    for u in ["../me".to_string(), "bob".into(), format!("{}x", puid), "me/../x".into()] {
        assert_eq!(get(&app, &arg(&[("u", &u)])).0, 400, "{}", u);
    }
    assert!(sent.lock().unwrap().is_empty());

    for b in [json!({"requestId": "prestige-abcdef0123456789", "stars": 9, "title": "x"}), json!({}), json!({"requestId": "bad id"}), json!(null)] {
        claim(&app, &b);
    }
    {
        let s = sent.lock().unwrap();
        assert_eq!(s.len(), 4);
        for (m, url, tok, body) in s.iter() {
            assert_eq!((m.as_str(), url.as_str(), tok.as_deref()), ("POST", "https://arena.test/v1/prestige", Some("T")));
            let body = body.as_ref().unwrap();
            assert_eq!(top_keys(body), set(&["requestId"]));
            assert!(re(r"^[A-Za-z0-9_-]{16,64}$").is_match(body["requestId"].as_str().unwrap()));
        }
        assert_eq!(s[0].3.as_ref().unwrap()["requestId"], "prestige-abcdef0123456789");
    }

    app.clear_link();
    sent.lock().unwrap().clear();
    assert_eq!(claim(&app, &json!({})).0, 400);
    assert_eq!(get(&app, &arg(&[])).0, 400);
    assert!(sent.lock().unwrap().is_empty());
    assert!(server::post_paths().contains(&"/api/arena/prestige/claim"));
}

// ---- skills ----------------------------------------------------------------

type Days = Arc<Mutex<IndexMap<String, IndexMap<String, i64>>>>;

fn skills_app() -> (tempfile::TempDir, Arc<claudehq::app::App>, Sent, ReplyCell, Days) {
    let (d, app) = app();
    let r = reply(200, json!({"ok": true}));
    let sent = stub(&app, "https://arena.example", r.clone());
    let full: IndexMap<String, i64> = worksignals::KEYS.iter().map(|k| (k.to_string(), 3)).collect();
    let mut two = full.clone();
    two.insert("tests".into(), 7);
    let days: Days = Arc::new(Mutex::new([("2026-10-09".to_string(), full), ("2026-10-10".to_string(), two)].into_iter().collect()));
    let d2 = days.clone();
    *app.ext.day_counts_hook.write().unwrap() = Some(Arc::new(move |_| d2.lock().unwrap().clone()));
    (d, app, sent, r, days)
}

#[test]
fn skills_report_body_is_exactly_day_and_seven_counts() {
    let (_d, app, sent, _r, _days) = skills_app();
    app.save_config(&json!({"workSignals": true})).unwrap();
    assert_eq!(ext::skills_report_once(&app), 2);
    {
        let s = sent.lock().unwrap();
        assert_eq!(s.len(), 2);
        for (m, url, tok, body) in s.iter() {
            assert_eq!((m.as_str(), url.as_str(), tok.as_deref()), ("POST", "https://arena.example/v1/skills/report", Some("T")));
            let body = body.as_ref().unwrap();
            assert_eq!(top_keys(body), set(&["day", "counts"]));
            assert_eq!(top_keys(&body["counts"]), set(&worksignals::SKILL_CATS));
            assert!(body["counts"].as_object().unwrap().values().all(|v| v.as_i64().map(|n| (0..=200).contains(&n)).unwrap_or(false)));
            assert!(re(r"^\d{4}-\d{2}-\d{2}$").is_match(body["day"].as_str().unwrap()));
        }
        assert_eq!(s.iter().map(|x| x.3.as_ref().unwrap()["day"].as_str().unwrap().to_string()).collect::<Vec<_>>(), ["2026-10-09", "2026-10-10"]);
        assert_eq!(s[1].3.as_ref().unwrap()["counts"]["tests"], 7);
    }
    let last = app.ext.skills_last.lock().unwrap().clone().unwrap();
    assert_eq!((last["ok"].clone(), last["days"].clone()), (json!(true), json!(2)));
    assert_no_leaks(&sent);
}

#[test]
fn skills_report_needs_work_signals_and_pairing() {
    let (_d, app, sent, _r, _days) = skills_app();
    for cfg in [json!({}), json!({"workSignals": false}), json!({"workSignals": "yes"})] {
        app.save_config(&cfg).unwrap();
        assert_eq!(ext::skills_report_once(&app), 0, "{}", cfg);
    }
    app.save_config(&json!({"workSignals": true})).unwrap();
    app.clear_link();
    assert_eq!(ext::skills_report_once(&app), 0);
    assert!(sent.lock().unwrap().is_empty());
}

#[test]
fn skills_unchanged_days_are_not_resent_and_failures_retry() {
    let (_d, app, sent, r, days) = skills_app();
    app.save_config(&json!({"workSignals": true})).unwrap();
    ext::skills_report_once(&app);
    sent.lock().unwrap().clear();
    assert_eq!(ext::skills_report_once(&app), 0);
    days.lock().unwrap().get_mut("2026-10-10").unwrap().insert("docs".into(), 9);
    *r.lock().unwrap() = (503, json!({"error": "down"}));
    assert_eq!(ext::skills_report_once(&app), 1);
    assert_eq!(app.ext.skills_last.lock().unwrap().as_ref().unwrap()["ok"], false);
    *r.lock().unwrap() = (200, json!({"ok": true}));
    assert_eq!(ext::skills_report_once(&app), 1);
    // An all-zero day is never sent.
    *days.lock().unwrap() = [("2026-10-08".to_string(), worksignals::KEYS.iter().map(|k| (k.to_string(), 0)).collect())].into_iter().collect();
    assert_eq!(ext::skills_report_once(&app), 0);
}

#[test]
fn skills_routes() {
    let (_d, app, sent, _r, _days) = skills_app();
    let (get, title, local) = (ext_get("/api/arena/skills"), ext_post("/api/arena/skills/title"), ext_get("/api/skills/local"));
    get(&app, &arg(&[]));
    get(&app, &arg(&[("u", "me")]));
    get(&app, &arg(&[("u", UID)]));
    assert_eq!(urls(&sent), ["https://arena.example/v1/skills/me".to_string(), "https://arena.example/v1/skills/me".into(), format!("https://arena.example/v1/skills/{}", UID)]);
    assert!(sent.lock().unwrap().iter().all(|s| s.0 == "GET" && s.3.is_none()));
    sent.lock().unwrap().clear();
    for bad in ["../me".to_string(), "x".into(), format!("{}/x", UID), "me?x=1".into()] {
        assert_eq!(get(&app, &arg(&[("u", &bad)])).0, 400, "{}", bad);
    }
    assert!(sent.lock().unwrap().is_empty());

    assert_eq!(title(&app, &json!({"title": "tests-3"})).0, 200);
    title(&app, &json!({"title": null}));
    {
        let s = sent.lock().unwrap();
        assert_eq!(s.iter().map(|x| x.3.clone().unwrap()).collect::<Vec<_>>(), [json!({"title": "tests-3"}), json!({"title": null})]);
        assert!(s.iter().all(|x| x.0 == "POST" && x.1.ends_with("/v1/skills/title")));
    }
    sent.lock().unwrap().clear();
    for bad in [json!({}), json!({"title": "tests-4"}), json!({"title": "magic-3"}), json!({"title": 3}), json!({"title": "tests-3 "}), json!(null)] {
        assert_eq!(title(&app, &bad).0, 400, "{}", bad);
    }
    assert!(sent.lock().unwrap().is_empty());

    let (code, resp) = local(&app, &arg(&[]));
    assert_eq!(code, 200);
    assert_eq!(top_keys(&resp), set(&["enabled", "days", "lastReport"]));
    for d in resp["days"].as_object().unwrap().values() {
        assert_eq!(top_keys(d), set(&worksignals::SKILL_CATS));
    }
    assert!(sent.lock().unwrap().is_empty());
    assert!(server::post_paths().contains(&"/api/arena/skills/title"));
}

#[test]
fn work_signals_default_off() {
    let c = claudehq::app::default_config();
    assert_eq!((c["workSignals"].clone(), c["workSignalsPRs"].clone()), (json!(false), json!(false)));
    let on = claudehq::app::validate_config(&json!({"workSignals": true, "workSignalsPRs": true}), Some(&c));
    assert_eq!((on["workSignals"].clone(), on["workSignalsPRs"].clone()), (json!(true), json!(true)));
}
