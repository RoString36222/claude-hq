//! Atomic local state through the App (ported from tests/test_atomic_state.py):
//! config, session meta, the dex salt and the arena link are written 0600 with
//! no temp left behind, corrupt files are quarantined, unwritable state is an
//! error the routes answer with 500, the Close action's guards, and the POST
//! Content-Length gate. Temp dirs and an ephemeral 127.0.0.1 server only.

use claudehq::app::{App, Paths};
use claudehq::{server, state};
use serde_json::{json, Map, Value};
use std::fs;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::Command;
use std::sync::Arc;

const SID: &str = "11111111-1111-4111-8111-111111111111";

fn mode(p: &Path) -> u32 {
    fs::metadata(p).unwrap().permissions().mode() & 0o777
}

fn names(dir: &Path) -> Vec<String> {
    let mut v: Vec<String> = fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    v.sort();
    v
}

fn corrupt_copies(p: &Path) -> usize {
    let base = format!("{}.corrupt-", p.file_name().unwrap().to_string_lossy());
    names(p.parent().unwrap()).iter().filter(|n| n.starts_with(&base)).count()
}

/// An App whose state files live in a fresh folder (and nothing else does).
fn app_in(dir: &Path) -> App {
    let mut p = Paths::new(dir, &dir.join("home"));
    p.projects_dir = dir.join("home/projects");
    p.cursor_projects_dir = dir.join("home/cursor");
    let app = App::new(p);
    *app.agents_hook.write().unwrap() = Some(Arc::new(|| (Vec::new(), None)));
    app
}

#[test]
fn a_failed_write_keeps_the_old_file_and_cleans_up() {
    let d = tempfile::tempdir().unwrap();
    let p = d.path().join("keep.json");
    state::atomic_write_json(&p, &json!({"v": 1}), 0o600).unwrap();
    fs::set_permissions(d.path(), fs::Permissions::from_mode(0o500)).unwrap();
    let res = state::atomic_write_json(&p, &json!({"v": 2}), 0o600);
    fs::set_permissions(d.path(), fs::Permissions::from_mode(0o700)).unwrap();
    if unsafe { libc::geteuid() } != 0 {
        assert!(res.is_err());
        assert_eq!(state::load_json_guarded(&p), Some(json!({"v": 1})));
    }
    assert_eq!(names(d.path()), ["keep.json"]);
}

#[test]
fn a_symlinked_state_file_reads_through_the_link() {
    let d = tempfile::tempdir().unwrap();
    let (real, link) = (d.path().join("real.json"), d.path().join("link.json"));
    fs::write(&real, "{}").unwrap();
    std::os::unix::fs::symlink(&real, &link).unwrap();
    state::atomic_write_json(&link, &json!({"via": "link"}), 0o600).unwrap();
    assert_eq!(state::load_json_guarded(&link), Some(json!({"via": "link"})));
    assert_eq!(names(d.path()), ["link.json", "real.json"]);
}

#[test]
fn config_is_saved_private_and_corrupt_config_is_quarantined() {
    let d = tempfile::tempdir().unwrap();
    let app = app_in(d.path());
    let saved = app.save_config(&json!({"dailyBudgetUSD": 25})).unwrap();
    assert_eq!(app.load_config(), saved);
    assert_eq!(mode(&app.paths.config), 0o600);
    assert_eq!(names(d.path()), ["config.json"]);
    fs::write(&app.paths.config, "{oops").unwrap();
    assert_eq!(app.load_config(), claudehq::app::validate_config(&json!({}), None));
    assert_eq!(corrupt_copies(&app.paths.config), 1);
    assert!(!app.paths.config.exists()); // quarantined, not overwritten
}

#[test]
fn meta_is_saved_private_and_corrupt_meta_is_quarantined() {
    let d = tempfile::tempdir().unwrap();
    let app = app_in(d.path());
    let patch: Map<String, Value> = match json!({"pinned": true, "note": "hi"}) {
        Value::Object(o) => o,
        _ => unreachable!(),
    };
    let entry = app.save_meta(SID, &patch).unwrap();
    assert_eq!(app.load_meta()[SID], entry);
    assert_eq!(mode(&app.paths.meta), 0o600);
    assert_eq!(names(d.path()), ["sessions-meta.json"]);
    fs::write(&app.paths.meta, "[[[").unwrap();
    assert!(app.load_meta().is_empty());
    assert_eq!(corrupt_copies(&app.paths.meta), 1);
}

#[test]
fn unwritable_config_and_meta_are_errors() {
    let d = tempfile::tempdir().unwrap();
    let mut p = Paths::new(d.path(), &d.path().join("home"));
    p.config = d.path().join("missing-dir/config.json");
    p.meta = d.path().join("missing-dir/meta.json");
    let app = App::new(p);
    assert!(app.save_config(&json!({"dailyBudgetUSD": 25})).is_err());
    assert!(app.save_meta(SID, &Map::new()).is_err());
}

#[test]
fn dex_salt_is_private_and_survives_an_unwritable_dir() {
    let d = tempfile::tempdir().unwrap();
    let app = app_in(d.path());
    let s = app.dex_salt();
    assert_eq!(fs::read_to_string(&app.paths.dex_seed).unwrap(), s);
    assert_eq!(mode(&app.paths.dex_seed), 0o600);
    assert_eq!(names(d.path()), [".dex-seed"]);

    let mut p = app.paths.clone();
    p.dex_seed = d.path().join("missing/.dex-seed");
    let s = App::new(p).dex_salt();
    assert_eq!(s.len(), 16);
    assert!(s.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f')));
}

#[test]
fn the_arena_link_is_private_and_corrupt_or_odd_links_read_empty() {
    let d = tempfile::tempdir().unwrap();
    let app = app_in(d.path());
    app.save_link(&json!({"token": "T", "url": "https://arena.example"})).unwrap();
    assert_eq!(app.load_link()["token"], "T");
    assert_eq!(mode(&app.paths.arena_link), 0o600);
    assert_eq!(names(d.path()), ["arena-link.json"]);
    fs::write(&app.paths.arena_link, "{\"token\": \"T\"").unwrap();
    assert!(app.load_link().is_empty());
    assert_eq!(corrupt_copies(&app.paths.arena_link), 1);
    fs::write(&app.paths.arena_link, "[1, 2]").unwrap();
    assert!(app.load_link().is_empty());
}

// ---- Close -------------------------------------------------------------------

/// A process whose command line says claude (perl keeps its argv as given).
struct Proc(std::process::Child);

impl Proc {
    fn spawn(tag: &str) -> Proc {
        Proc(Command::new("perl").args(["-e", "sleep 30", tag]).spawn().unwrap())
    }
    fn pid(&self) -> i64 {
        self.0.id() as i64
    }
    fn running(&mut self) -> bool {
        self.0.try_wait().unwrap().is_none()
    }
    fn exited(&mut self) -> bool {
        for _ in 0..100 {
            if !self.running() {
                return true;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        false
    }
}

impl Drop for Proc {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn agents(app: &App, list: Value) {
    let v = list.as_array().unwrap().clone();
    *app.agents_hook.write().unwrap() = Some(Arc::new(move || (v.clone(), None)));
}

#[test]
fn close_refuses_a_pid_absent_from_the_agent_list() {
    let d = tempfile::tempdir().unwrap();
    let app = app_in(d.path());
    let mut p = Proc::spawn("claude-unlisted");
    agents(&app, json!([{"kind": "interactive", "pid": p.pid() + 100000}]));
    let (code, resp) = app.action_close(Some(&json!(p.pid())));
    assert_eq!(code, 400);
    assert!(resp["error"].as_str().unwrap().contains("not a live interactive"));
    assert!(p.running());
}

#[test]
fn close_says_why_it_cannot_verify() {
    let d = tempfile::tempdir().unwrap();
    let app = app_in(d.path());
    let mut p = Proc::spawn("claude-session");
    *app.agents_hook.write().unwrap() = Some(Arc::new(|| (vec![], Some("claude CLI not found on PATH".into()))));
    let (code, resp) = app.action_close(Some(&json!(p.pid())));
    assert_eq!(code, 503);
    let e = resp["error"].as_str().unwrap();
    assert!(e.contains("cannot verify live sessions") && e.contains("claude CLI not found"), "{}", e);
    assert!(p.running());
}

#[test]
fn close_ends_a_live_interactive_claude() {
    let d = tempfile::tempdir().unwrap();
    let app = app_in(d.path());
    // an agent without a kind counts as interactive
    let mut p = Proc::spawn("claude-session");
    agents(&app, json!([{"pid": p.pid()}]));
    let (code, resp) = app.action_close(Some(&json!(p.pid())));
    assert_eq!((code, resp["pid"].clone()), (200, json!(p.pid())));
    assert!(p.exited());
    // junk entries are skipped and a string pid is accepted
    let mut p = Proc::spawn("claude-session");
    agents(&app, json!([{"kind": "interactive", "pid": p.pid()}, "junk", {"pid": "7"}]));
    let (code, resp) = app.action_close(Some(&json!(p.pid().to_string())));
    assert_eq!((code, resp["pid"].clone()), (200, json!(p.pid())));
    assert!(p.exited());
}

// ---- POST gates on a real server ----------------------------------------------

struct Srv {
    port: u16,
    app: Arc<App>,
    _rt: tokio::runtime::Runtime,
}

fn serve(app: App) -> Srv {
    let app = Arc::new(app);
    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
    let listener = rt.block_on(tokio::net::TcpListener::bind("127.0.0.1:0")).unwrap();
    let port = listener.local_addr().unwrap().port();
    let router = server::router(app.clone());
    rt.spawn(async move { axum::serve(listener, router).await.unwrap() });
    Srv { port, app, _rt: rt }
}

/// POST with the CSRF token and the given Content-Length header line (or none).
fn post(srv: &Srv, path: &str, body: &[u8], length: Option<&str>) -> (u16, Value) {
    let cl = length.map(|l| format!("Content-Length: {}\r\n", l)).unwrap_or_default();
    let head = format!(
        "POST {} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\nContent-Type: application/json\r\nX-HQ-Token: {}\r\n{}\r\n",
        path, srv.app.csrf_token, cl
    );
    let mut s = TcpStream::connect(("127.0.0.1", srv.port)).unwrap();
    s.write_all(head.as_bytes()).unwrap();
    s.write_all(body).unwrap();
    let mut buf = Vec::new();
    let _ = s.read_to_end(&mut buf); // a reset after the reply is fine
    let text = String::from_utf8_lossy(&buf);
    let status: u16 = text.split_whitespace().nth(1).unwrap().parse().unwrap();
    let body = text.split_once("\r\n\r\n").map(|x| x.1).unwrap_or("");
    (status, serde_json::from_str(body).unwrap_or(Value::Null))
}

#[test]
fn the_sound_body_cap_fits_the_largest_clip() {
    assert_eq!(server::post_body_limit("/api/config"), 1024 * 1024);
    assert_eq!(server::post_body_limit("/api/arena/sounds"), 8 * 1024 * 1024);
    // base64 of the largest allowed clip, plus JSON framing, must fit
    const _: () = assert!(server::MAX_SOUND_POST_BODY > claudehq::handlers::MAX_SOUND_UPLOAD * 4 / 3 + 4096);
}

#[test]
fn content_length_is_required_and_must_be_a_number() {
    let d = tempfile::tempdir().unwrap();
    let srv = serve(app_in(d.path()));
    assert_eq!(post(&srv, "/api/config", b"", None).0, 411);
    for bad in ["abc", "-5", "1e3", "\u{b2}"] {
        assert_eq!(post(&srv, "/api/config", b"", Some(bad)).0, 400, "{}", bad);
    }
    assert!(!srv.app.paths.config.exists());
}

#[test]
fn a_failed_state_write_is_a_500() {
    let d = tempfile::tempdir().unwrap();
    let mut app = app_in(d.path());
    app.paths.config = d.path().join("missing-dir/config.json");
    app.paths.meta = d.path().join("missing-dir/meta.json");
    let srv = serve(app);
    let body = json!({"dailyBudgetUSD": 30}).to_string();
    let (code, resp) = post(&srv, "/api/config", body.as_bytes(), Some(&body.len().to_string()));
    assert_eq!(code, 500);
    assert!(resp["error"].as_str().unwrap().contains("could not save"), "{}", resp);
    let body = json!({"sessionId": SID, "pinned": true}).to_string();
    let (code, resp) = post(&srv, "/api/meta", body.as_bytes(), Some(&body.len().to_string()));
    assert_eq!(code, 500);
    assert!(resp["error"].as_str().unwrap().contains("could not save"), "{}", resp);
}
