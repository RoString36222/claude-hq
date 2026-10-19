//! Shared helpers for the py_arena_* / py_proxies / py_routes tests (ported
//! from the Python arena and proxy tests): a temp-dir App, a stubbed Arena
//! transport that records every request, the privacy key lists, and a real
//! 127.0.0.1 server on an ephemeral port. Nothing here reaches a network.
#![allow(dead_code)]

use claudehq::app::{App, Paths};
use claudehq::ext;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::{Arc, Mutex};

/// Keys that must never appear anywhere in a body sent to the Arena.
pub const FORBIDDEN_KEYS: [&str; 16] = [
    "prompt", "prompts_text", "reply", "text", "content", "path", "paths", "cwd", "folder", "project", "projectName",
    "sessionId", "sessionTitle", "title", "file", "files",
];

/// Local creature-fatigue and meal-ledger state: never in the stats payload.
/// (requestId legitimately goes to the pantry routes, never to /v1/stats.)
pub const LOCAL_ONLY_KEYS: [&str; 6] = ["fatigue", "busy_spans", "open_tool_since", "meals", "lastMeal", "requestId"];

pub const RID: &str = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
pub const SID: &str = "11111111-1111-4111-8111-111111111111";
pub const OTHER_SID: &str = "22222222-2222-4222-8222-222222222222";

/// (method, url, token, body)
pub type Sent = Arc<Mutex<Vec<(String, String, Option<String>, Option<Value>)>>>;
pub type ReplyCell = Arc<Mutex<(u16, Value)>>;

pub fn app() -> (tempfile::TempDir, Arc<App>) {
    let d = tempfile::tempdir().unwrap();
    let mut p = Paths::new(d.path(), &d.path().join("home"));
    p.projects_dir = d.path().join("projects");
    p.cursor_projects_dir = d.path().join("cursor");
    p.cursor_state_db = d.path().join("state.vscdb");
    std::fs::create_dir_all(&p.projects_dir).unwrap();
    std::fs::create_dir_all(&p.cursor_projects_dir).unwrap();
    let app = Arc::new(App::new(p));
    *app.agents_hook.write().unwrap() = Some(Arc::new(|| (Vec::new(), None)));
    (d, app)
}

pub fn reply(code: u16, body: Value) -> ReplyCell {
    Arc::new(Mutex::new((code, body)))
}

/// Pair the app (token "T" at `url`) and record every request; answer `reply`.
pub fn stub(app: &App, url: &str, reply: ReplyCell) -> Sent {
    stub_fn(app, url, move |_m, _u| reply.lock().unwrap().clone())
}

/// Pair the app and answer each request with `f(method, url)`.
pub fn stub_fn(app: &App, url: &str, f: impl Fn(&str, &str) -> (u16, Value) + Send + Sync + 'static) -> Sent {
    app.save_link(&json!({"token": "T", "url": url, "handle": "ann"})).unwrap();
    let sent: Sent = Arc::new(Mutex::new(Vec::new()));
    let s2 = sent.clone();
    *app.arena.transport.write().unwrap() = Some(Arc::new(move |m, u, t, b| {
        s2.lock().unwrap().push((m.to_string(), u.to_string(), t.map(String::from), b.cloned()));
        f(m, u)
    }));
    sent
}

pub fn collect_keys(v: &Value, out: &mut HashSet<String>) {
    match v {
        Value::Object(o) => {
            for (k, x) in o {
                out.insert(k.clone());
                collect_keys(x, out);
            }
        }
        Value::Array(a) => a.iter().for_each(|x| collect_keys(x, out)),
        _ => {}
    }
}

pub fn keys(v: &Value) -> HashSet<String> {
    let mut ks = HashSet::new();
    collect_keys(v, &mut ks);
    ks
}

/// The forbidden keys found anywhere in `v`.
pub fn leaks(v: &Value) -> Vec<String> {
    let ks = keys(v);
    FORBIDDEN_KEYS.iter().filter(|k| ks.contains(**k)).map(|k| k.to_string()).collect()
}

/// Every recorded body is free of forbidden keys.
pub fn assert_no_leaks(sent: &Sent) {
    for (_, url, _, body) in sent.lock().unwrap().iter() {
        if let Some(b) = body {
            assert!(leaks(b).is_empty(), "{} leaked {:?}", url, leaks(b));
        }
    }
}

/// The top-level keys of an object, as a set.
pub fn top_keys(v: &Value) -> HashSet<String> {
    v.as_object().unwrap().keys().cloned().collect()
}

pub fn set(ks: &[&str]) -> HashSet<String> {
    ks.iter().map(|k| k.to_string()).collect()
}

/// A query-string accessor like the server's: missing = "".
pub fn arg(m: &[(&str, &str)]) -> impl Fn(&str) -> String {
    let m: Vec<(String, String)> = m.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
    move |k| m.iter().find(|(x, _)| x == k).map(|(_, v)| v.trim().to_string()).unwrap_or_default()
}

pub fn ext_get(path: &str) -> ext::GetFn {
    ext::GET.iter().find(|(p, _)| *p == path).unwrap_or_else(|| panic!("no GET {}", path)).1
}

pub fn ext_post(path: &str) -> ext::PostFn {
    ext::POST.iter().find(|(p, _)| *p == path).unwrap_or_else(|| panic!("no POST {}", path)).1
}

// ---- a real server on 127.0.0.1:0 ------------------------------------------

pub struct Srv {
    pub port: u16,
    pub app: Arc<App>,
    _dir: tempfile::TempDir,
    _rt: tokio::runtime::Runtime,
}

pub fn serve() -> Srv {
    let (dir, app) = app();
    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
    let listener = rt.block_on(tokio::net::TcpListener::bind("127.0.0.1:0")).unwrap();
    let port = listener.local_addr().unwrap().port();
    let router = claudehq::server::router(app.clone());
    rt.spawn(async move { axum::serve(listener, router).await.unwrap() });
    Srv { port, app, _dir: dir, _rt: rt }
}

/// (status, body as JSON)
pub fn raw(port: u16, req: &str, body: &[u8]) -> (u16, Value) {
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
    (status, serde_json::from_slice(&body).unwrap_or(Value::Null))
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

pub fn http_get(srv: &Srv, path: &str) -> (u16, Value) {
    raw(srv.port, &format!("GET {} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n", path), b"")
}

pub fn http_post(srv: &Srv, path: &str, body: &Value, token: bool) -> (u16, Value) {
    let tok = if token { format!("X-HQ-Token: {}\r\n", srv.app.csrf_token) } else { String::new() };
    // A refused POST is answered without reading the body (see http.rs), so
    // an unauthenticated one sends none rather than race a connection reset.
    let data = if token { serde_json::to_vec(body).unwrap() } else { Vec::new() };
    raw(
        srv.port,
        &format!(
            "POST {} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\nContent-Type: application/json\r\n{}Content-Length: {}\r\n\r\n",
            path,
            tok,
            data.len()
        ),
        &data,
    )
}
