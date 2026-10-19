//! The HTTP gates on a real 127.0.0.1 server (ported from the route tests in
//! test_scanner.py, test_atomic_state.py, test_games.py, test_pantry_proxy.py,
//! test_maps_proxy.py, test_cups_proxy.py): Host check, CSRF, Origin, body
//! caps, UUID-only session routes, the games allowlist and the save endpoint.

use claudehq::app::{App, Paths};
use claudehq::server;
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::Path;
use std::sync::Arc;

struct Srv {
    port: u16,
    app: Arc<App>,
    _dir: tempfile::TempDir,
    _rt: tokio::runtime::Runtime,
}

fn repo() -> &'static Path {
    Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap()
}

fn serve() -> Srv {
    let dir = tempfile::tempdir().unwrap();
    let mut p = Paths::new(dir.path(), &dir.path().join("home"));
    p.projects_dir = dir.path().join("projects");
    p.cursor_projects_dir = dir.path().join("cursor");
    // @include paths are relative to the root, like dashboard.py's HERE.
    std::os::unix::fs::symlink(repo().join("ui"), dir.path().join("ui")).unwrap();
    p.index_html = repo().join("index.html");
    p.games_dir = repo().join("games");
    std::fs::create_dir_all(&p.projects_dir).unwrap();
    let app = Arc::new(App::new(p));
    *app.agents_hook.write().unwrap() = Some(Arc::new(|| (Vec::new(), None)));
    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
    let listener = rt.block_on(tokio::net::TcpListener::bind("127.0.0.1:0")).unwrap();
    let port = listener.local_addr().unwrap().port();
    let router = server::router(app.clone());
    rt.spawn(async move { axum::serve(listener, router).await.unwrap() });
    Srv { port, app, _dir: dir, _rt: rt }
}

/// (status, headers lowercased, body)
fn raw(port: u16, req: &str, body: &[u8]) -> (u16, String, Vec<u8>) {
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    s.write_all(req.as_bytes()).unwrap();
    s.write_all(body).unwrap();
    let mut buf = Vec::new();
    s.read_to_end(&mut buf).unwrap();
    let split = buf.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
    let head = String::from_utf8_lossy(&buf[..split]).to_lowercase();
    let status: u16 = head.split_whitespace().nth(1).unwrap().parse().unwrap();
    let mut body = buf[split + 4..].to_vec();
    if head.contains("transfer-encoding: chunked") {
        body = dechunk(&body);
    }
    (status, head, body)
}

fn dechunk(mut b: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    while let Some(i) = b.windows(2).position(|w| w == b"\r\n") {
        let n = usize::from_str_radix(std::str::from_utf8(&b[..i]).unwrap().trim(), 16).unwrap_or(0);
        if n == 0 {
            break;
        }
        out.extend_from_slice(&b[i + 2..i + 2 + n]);
        b = &b[i + 4 + n..];
    }
    out
}

fn get(port: u16, path: &str, extra: &str) -> (u16, String, Vec<u8>) {
    raw(port, &format!("GET {} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n{}\r\n", path, extra), b"")
}

fn post(srv: &Srv, path: &str, body: &[u8], extra: &str, token: bool) -> (u16, Value) {
    let tok = if token { format!("X-HQ-Token: {}\r\n", srv.app.csrf_token) } else { String::new() };
    let cl = if extra.to_lowercase().contains("content-length") { String::new() } else { format!("Content-Length: {}\r\n", body.len()) };
    let (code, _, b) = raw(
        srv.port,
        &format!("POST {} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\nContent-Type: application/json\r\n{}{}{}\r\n", path, tok, cl, extra),
        body,
    );
    (code, serde_json::from_slice(&b).unwrap_or(Value::Null))
}

#[test]
fn host_gate_and_index() {
    let srv = serve();
    let (code, _, body) = raw(srv.port, "GET /api/config HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n", b"");
    assert_eq!((code, body.as_slice()), (403, &b"Forbidden: local access only\n"[..]));
    let (code, head, body) = get(srv.port, "/", "");
    assert_eq!(code, 200);
    assert!(head.contains("content-type: text/html; charset=utf-8"));
    let html = String::from_utf8(body).unwrap();
    assert!(html.contains(&srv.app.csrf_token), "len {} head {}", html.len(), &html[..200.min(html.len())]);
    assert!(!html.contains("__HQ_CSRF__"));
    assert!(!html.contains("@include ui/"));
    assert!(html.contains("\"use strict\";\nvar $ = function(id)"));
    let fz = format!("var FZ_SCALE_MINS = {};", (claudehq::fatigue::CERTAIN_SECS / 60.0) as i64);
    assert!(html.lines().any(|l| l.trim() == fz));
    let (code, head, _) = raw(srv.port, "HEAD /api/export.csv HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n", b"");
    assert_eq!(code, 200);
    assert!(head.contains("content-disposition: attachment; filename=\"claude-hq-sessions.csv\""));
}

#[test]
fn includes_cannot_escape_ui() {
    let srv = serve();
    for bad in ["ui/../dashboard.py", "ui/app/../../README.md", "ui/nope.js"] {
        assert!(srv.app.include_path(bad).is_err(), "{}", bad);
    }
}

#[test]
fn session_routes_take_uuids_only() {
    let srv = serve();
    let sid = "22222222-2222-4222-8222-222222222222";
    for bad in ["*", "%2A", "abc", &format!("{}*", &sid[..35]), &format!("{}x", sid)] {
        for route in ["/api/transcript/{}", "/api/session/{}", "/api/session/{}/export.md"] {
            let (code, _, _) = get(srv.port, &route.replace("{}", bad), "");
            assert_eq!(code, 404, "{}", route.replace("{}", bad));
        }
    }
    let p = srv.app.paths.projects_dir.join("proj").join(format!("{}.jsonl", sid));
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(&p, "{\"type\": \"user\", \"timestamp\": \"2026-09-01T10:00:00Z\", \"message\": {\"content\": \"hello there\"}}\n").unwrap();
    let (code, _, body) = get(srv.port, &format!("/api/transcript/{}?q=hello&limit=999&offset=-3", sid), "");
    assert_eq!(code, 200);
    let v: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!((v["total"].clone(), v["matched"].clone(), v["limit"].clone(), v["offset"].clone()), (json!(1), json!(1), json!(200), json!(0)));
    let (code, head, body) = get(srv.port, &format!("/api/session/{}/export.md", sid), "");
    assert_eq!(code, 200);
    assert!(head.contains("claude-hq-session-22222222.md"));
    assert!(String::from_utf8(body).unwrap().contains("**You:** hello there"));
}

#[test]
fn games_allowlist_etag_and_save() {
    let srv = serve();
    let (code, _, body) = get(srv.port, "/games/core.js", "");
    assert_eq!(code, 200);
    assert!(String::from_utf8_lossy(&body).contains("HQV"));
    for bad in ["/games/..%2fdashboard.py", "/games/Core.js", "/games/golf/LICENSE-kenney.txt", "/games/golf//straight.glb", "/games/vendor/x.css"] {
        assert_eq!(get(srv.port, bad, "").0, 404, "{}", bad);
    }
    for good in ["golf/courses.json", "golf/straight.glb", "vendor/three-core.js", "kart/tracks.json", "fps/map.json", "platformer/levels.json"] {
        assert!(srv.app.game_file(good).is_some(), "{}", good);
    }
    let (code, head, _) = get(srv.port, "/games/golf/courses.json", "");
    assert_eq!(code, 200);
    assert!(head.contains("cache-control: no-cache"));
    let tag = head.lines().find(|l| l.starts_with("etag:")).unwrap()[6..].trim().to_string();
    assert_eq!(get(srv.port, "/games/golf/courses.json", &format!("If-None-Match: {}\r\n", tag)).0, 304);
    assert_eq!(server::game_cache_control("golf.js"), "no-store");
    assert_eq!(server::game_cache_control("vendor/../golf.js"), "no-store");

    let (code, _, body) = get(srv.port, "/api/games/state", "");
    assert_eq!((code, serde_json::from_slice::<Value>(&body).unwrap()), (200, json!({"state": {}})));
    let st = json!({"state": {"v": 1, "inv": {"koi": 2}}});
    assert_eq!(post(&srv, "/api/games/state", st.to_string().as_bytes(), "", true).0, 200);
    assert_eq!(serde_json::from_slice::<Value>(&get(srv.port, "/api/games/state", "").2).unwrap(), json!({"state": {"v": 1, "inv": {"koi": 2}}}));
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(std::fs::metadata(&srv.app.paths.games_save).unwrap().permissions().mode() & 0o777, 0o600);
    assert_eq!(post(&srv, "/api/games/state", b"{\"state\": [1]}", "", true).0, 400);
    assert_eq!(post(&srv, "/api/games/state", b"{\"state\": {}}", "", false).0, 403);
}

#[test]
fn post_gates_and_limits() {
    let srv = serve();
    assert_eq!(post(&srv, "/api/config", b"{}", "", false), (403, json!({"error": "bad or missing CSRF token"})));
    assert_eq!(post(&srv, "/api/config", b"{}", "Origin: https://evil.example\r\n", true).1["error"], "cross-site request rejected");
    assert_eq!(post(&srv, "/api/config", b"{}", "Origin: http://localhost:8765\r\n", true).0, 200);
    assert_eq!(post(&srv, "/api/config", b"{}", "Sec-Fetch-Site: cross-site\r\n", true).0, 403);
    assert_eq!(post(&srv, "/api/nope", b"{}", "", true), (404, json!({"error": "not found"})));
    assert_eq!(post(&srv, "/api/config", b"", "Content-Length: 1048577\r\n", true).0, 413);
    assert_eq!(post(&srv, "/api/arena/sounds", b"", "Content-Length: 8388609\r\n", true).0, 413);
    assert_eq!(post(&srv, "/api/config", b"", "Content-Length: 0\r\n", true).0, 200);
    let (code, _, _) = raw(srv.port, &format!("POST /api/config HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\nX-HQ-Token: {}\r\nTransfer-Encoding: chunked\r\n\r\n", srv.app.csrf_token), b"0\r\n\r\n");
    assert_eq!(code, 411);
    let (code, resp) = post(&srv, "/api/config", json!({"dailyBudgetUSD": 30}).to_string().as_bytes(), "", true);
    assert_eq!(code, 200);
    assert_eq!(resp, Value::Object(srv.app.load_config()));
    assert_eq!(post(&srv, "/api/config", b"[1]", "", true).1["error"], "bad JSON body: body must be an object");
    assert_eq!(post(&srv, "/api/meta", json!({"sessionId": "nope"}).to_string().as_bytes(), "", true).0, 400);
}

#[test]
fn arena_routes_stay_local_when_unpaired() {
    let srv = serve();
    for p in ["/api/arena/pantry", "/api/arena/cups", "/api/arena/maps/featured", "/api/arena/boss", "/api/arena/skills"] {
        let (code, _, body) = get(srv.port, p, "");
        assert_eq!((code, serde_json::from_slice::<Value>(&body).unwrap()), (400, json!({"error": "not paired"})), "{}", p);
    }
    let (code, _, body) = get(srv.port, "/api/arena/cups/one?id=cup-2026-W41-td", "");
    assert_eq!(code, 400);
    assert!(String::from_utf8_lossy(&body).contains("bad cup id"));
    for p in ["/api/arena/maps/like", "/api/arena/boss/fight", "/api/arena/pantry/claim"] {
        // No body: a refused POST is answered without reading one.
        assert_eq!(post(&srv, p, b"", "", false).0, 403, "{}", p);
    }
    assert_eq!(post(&srv, "/api/arena/pantry/steal", b"{}", "", true), (404, json!({"error": "not found"})));
    let (code, body) = post(&srv, "/api/arena/pantry/buy", json!({"requestId": "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d", "kind": "berry", "qty": 9}).to_string().as_bytes(), "", true);
    assert_eq!((code, body), (400, json!({"error": "qty must be a whole number from 1 to 5"})));
}

#[test]
fn stream_sends_a_data_frame() {
    let srv = serve();
    let mut s = TcpStream::connect(("127.0.0.1", srv.port)).unwrap();
    s.write_all(b"GET /api/stream HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").unwrap();
    let mut buf = Vec::new();
    let mut chunk = [0u8; 65536];
    while !String::from_utf8_lossy(&buf).contains("\n\n") || !String::from_utf8_lossy(&buf).contains("data: ") {
        let n = s.read(&mut chunk).unwrap();
        assert!(n > 0);
        buf.extend_from_slice(&chunk[..n]);
    }
    let text = String::from_utf8_lossy(&buf);
    assert!(text.to_lowercase().contains("content-type: text/event-stream; charset=utf-8"));
    assert!(text.contains("\"version\": \"2.6.1\""));
}

/// A session id whose Pokemon is this species (as tests/test_evo_choice.py finds one).
fn sid_for(species: u64) -> String {
    let mut i: u128 = 0;
    loop {
        let h = format!("{:032x}", i.wrapping_mul(2654435761));
        let sid = format!("{}-{}-{}-{}-{}", &h[..8], &h[8..12], &h[12..16], &h[16..20], &h[20..]);
        if claudehq::creature::session_hash_mod(&sid, 48) == species {
            return sid;
        }
        i += 1;
    }
}

#[test]
fn evo_choice_endpoint() {
    let srv = serve();
    let (eevee, zard) = (sid_for(4), sid_for(1));
    let body = |v: Value| v.to_string().into_bytes();
    // needs the CSRF token and a same-site origin (a refused POST is answered without reading a body)
    assert_eq!(post(&srv, "/api/evo-choice", b"", "", false).0, 403);
    assert_eq!(post(&srv, "/api/evo-choice", b"", "Origin: https://evil.example\r\n", true).0, 403);
    // bad ids and picks: 400, nothing written
    for b in [json!({"sessionId": "../../etc", "branchDex": 470}), json!({"sessionId": eevee, "branchDex": 6}), json!({"sessionId": zard, "megaSlug": "<script>"})] {
        assert_eq!(post(&srv, "/api/evo-choice", &body(b.clone()), "", true).0, 400, "{}", b);
    }
    assert!(!srv.app.paths.evo_choices.exists());
    let (code, resp) = post(&srv, "/api/evo-choice", &body(json!({"sessionId": eevee, "branchDex": 470})), "", true);
    assert_eq!((code, resp), (200, json!({"sessionId": eevee, "evo": {"branchDex": 470}})));
    assert_eq!(Value::Object(srv.app.load_evo_choices()), json!({eevee: {"branchDex": 470}}));
}

#[test]
fn vial_spend_endpoint() {
    let srv = serve();
    let sid = "11111111-1111-4111-8111-111111111111";
    let body = |v: Value| v.to_string().into_bytes();
    assert_eq!(post(&srv, "/api/vial/spend", &body(json!({"sessionId": "x", "fromStage": 0})), "", true), (400, json!({"error": "invalid sessionId"})));
    for st in [json!(4), json!(true), json!(1.0), json!("1"), json!(null)] {
        assert_eq!(post(&srv, "/api/vial/spend", &body(json!({"sessionId": sid, "fromStage": st})), "", true), (400, json!({"error": "invalid fromStage"})));
    }
    assert_eq!(post(&srv, "/api/vial/spend", b"", "", false).0, 403);
    let (code, resp) = post(&srv, "/api/vial/spend", &body(json!({"sessionId": sid, "fromStage": 0})), "", true);
    assert_eq!((code, resp), (200, json!({"ok": false, "error": "the vial is short", "cost": 30, "balance": 0})));
    srv.app.vial_grant(100, claudehq::py::now_ts());
    let (code, resp) = post(&srv, "/api/vial/spend", &body(json!({"sessionId": sid, "fromStage": 0})), "", true);
    assert_eq!((code, resp), (200, json!({"ok": true, "cost": 30, "balance": 70})));
    // the payload carries the vial
    let (_, _, b) = get(srv.port, "/api/sessions", "");
    let p: Value = serde_json::from_slice(&b).unwrap();
    assert_eq!(p["vial"]["xp"], 70);
    assert_eq!(p["vial"]["costs"], json!({"0": 30, "1": 90, "2": 180, "3": 400}));
    assert!(String::from_utf8_lossy(&b).contains("\"expiresIn\": 86400.0"));
}

#[test]
fn notch_status_and_install_need_the_token() {
    let srv = serve();
    let (code, _, b) = get(srv.port, "/api/notch/status", "");
    assert_eq!(code, 200);
    let s: Value = serde_json::from_slice(&b).unwrap();
    assert_eq!(s.as_object().unwrap().keys().collect::<Vec<_>>(), vec!["mac", "installed", "running", "tools", "available", "job"]);
    assert_eq!(s["available"], false); // no notch/tools/install.py in this temp HQ
    assert_eq!(s["job"]["state"], "idle");
    *srv.app.ext.notch_mac_hook.write().unwrap() = Some(true);
    assert_eq!(post(&srv, "/api/notch/install", b"", "", false).0, 403);
    assert_eq!(srv.app.ext.notch_job.lock().unwrap().state, "idle");
    assert_eq!(post(&srv, "/api/notch/install", b"{}", "", true), (400, json!({"error": "notch/tools/install.py is missing from this HQ"})));
}

#[test]
fn skate_routes_stay_local_when_unpaired() {
    let srv = serve();
    let (code, _, b) = get(srv.port, "/api/arena/skate", "");
    assert_eq!((code, serde_json::from_slice::<Value>(&b).unwrap()), (400, json!({"error": "not paired"})));
    assert_eq!(post(&srv, "/api/arena/skate/combo", b"{\"total\": 0, \"tricks\": 1}", "", true).0, 400);
    assert_eq!(post(&srv, "/api/arena/skate/combo", b"{\"total\": 10, \"tricks\": 1}", "", true), (400, json!({"error": "not paired"})));
    assert!(srv.app.game_file("hqskate.js").is_some());
    assert_eq!(server::game_cache_control("hqskate.js"), "no-store");
    assert!(srv.app.game_file("strike/map.json").is_some());
}
