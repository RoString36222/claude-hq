//! Ported from tests/test_games.py and test_hq3d.py (the Python server's cases):
//! the games/ allowlist (names, subfolders, content types, no traversal, no
//! symlink escape), cache headers and ETags, the save endpoint's limits, and
//! index.html picking up a ui/ edit without a restart.

use claudehq::app::{App, Paths, GAMES_SAVE_MAX};
use claudehq::server;
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::Path;
use std::sync::Arc;

fn repo() -> &'static Path {
    Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap()
}

/// An app rooted in a temp dir that serves the repo's games/ folder.
fn app() -> (tempfile::TempDir, Arc<App>) {
    let dir = tempfile::tempdir().unwrap();
    let mut p = Paths::new(dir.path(), &dir.path().join("home"));
    p.games_dir = repo().join("games");
    (dir, Arc::new(App::new(p)))
}

#[test]
fn serves_allowlisted_files_with_their_types() {
    let (_d, app) = app();
    let (body, ctype) = app.game_file("core.js").unwrap();
    assert!(String::from_utf8_lossy(&body).contains("HQV"));
    assert!(ctype.starts_with("application/javascript"));
    assert!(app.game_file("games.css").unwrap().1.starts_with("text/css"));
    for (name, ctype) in [
        ("vendor/three-module.js", "application/javascript"),
        ("vendor/three-core.js", "application/javascript"),
        ("vendor/three-gltf-loader.js", "application/javascript"),
        ("golf/courses.json", "application/json"),
        ("golf/straight.glb", "model/gltf-binary"),
        ("golf/colormap.png", "image/png"),
        ("kart/tracks.json", "application/json"),
        ("kart/track-corner.glb", "model/gltf-binary"),
        ("kart/vehicle-motorcycle.glb", "model/gltf-binary"),
        ("kart/smoke.png", "image/png"),
        ("platformer/levels.json", "application/json"),
        ("platformer/character.glb", "model/gltf-binary"),
        ("platformer/platform-grass-large-round.glb", "model/gltf-binary"),
        ("platformer/colormap.png", "image/png"),
        ("platformer/blob-shadow.png", "image/png"),
        ("fps/map.json", "application/json"),
        ("fps/blaster-repeater.glb", "model/gltf-binary"),
        ("fps/wall-high.glb", "model/gltf-binary"),
        ("fps/colormap.png", "image/png"),
        ("fps/burst.png", "image/png"),
    ] {
        let got = app.game_file(name).unwrap_or_else(|| panic!("{}", name));
        assert!(got.1.starts_with(ctype), "{}", name);
    }
}

#[test]
fn rejects_everything_else() {
    let (_d, app) = app();
    let long = format!("{}.js", "a".repeat(60));
    for bad in ["../dashboard.py", "..%2fdashboard.py", ".hidden.js", "core.py", "Core.js", "sub/core.js", "", "core.js\n", &long, "missing.js"] {
        assert!(app.game_file(bad).is_none(), "{:?}", bad);
    }
    for bad in [
        "vendor/../dashboard.py", "vendor/x.css", "golf/Textures/colormap.png", "golf/a/b.glb",
        "golf/X.glb", "vendor/three.core.js", "golf/x.js", "golf/x.glb\n", "vendor/", "golf/.x.glb",
        "golf/LICENSE-kenney.txt", "vendor/LICENSE-three.txt", "other/three-module.js",
        "golf/missing.glb", "golf//straight.glb", "golf/straight.glb/", "/golf/straight.glb",
        "kart/LICENSE-kenney.txt", "kart/x.js", "kart/../dashboard.py", "karts/track-corner.glb",
        "platformer/LICENSE-kenney.txt", "platformer/x.js", "platformer/../dashboard.py",
        "platformer/Textures/colormap.png", "platformers/coin.glb", "platformer/Coin.glb",
        "platformer/missing.glb", "platformer/coin.glb/",
        "fps/LICENSE-kenney.txt", "fps/x.js", "fps/../dashboard.py", "fps/Textures/colormap.png",
        "fpss/blaster.glb", "fps/Blaster.glb", "fps/missing.glb", "fps/blaster.glb/", "fps/a/b.glb",
    ] {
        assert!(app.game_file(bad).is_none(), "{:?}", bad);
    }
}

#[test]
fn hq_scene_files_are_served_and_never_cached() {
    let (_d, app) = app();
    for name in ["engine.js", "hq3d.js", "hqlobby.js", "hqbase.js", "hqskate.js", "hqcity.js"] {
        assert!(app.game_file(name).is_some(), "{}", name);
        assert_eq!(server::game_cache_control(name), "no-store", "{}", name);
    }
}

#[test]
fn assets_revalidate_and_game_scripts_never_cache() {
    for name in ["vendor/three-core.js", "golf/straight.glb", "golf/courses.json"] {
        assert_eq!(server::game_cache_control(name), "no-cache", "{}", name);
    }
    for name in ["golf.js", "multi.js", "games.css", "vendor/../golf.js", ""] {
        assert_eq!(server::game_cache_control(name), "no-store", "{:?}", name);
    }
    let a = server::game_etag(b"abc");
    assert_eq!(a, server::game_etag(b"abc"));
    assert_ne!(a, server::game_etag(b"abd"));
    assert!(regex::Regex::new(r#"^"[0-9a-f]{20}"$"#).unwrap().is_match(&a), "{}", a);
}

#[test]
fn rejects_a_symlink_escaping_the_folder() {
    let dir = tempfile::tempdir().unwrap();
    let games = dir.path().join("games");
    std::fs::create_dir_all(games.join("golf")).unwrap();
    std::fs::write(games.join("golf").join("courses.json"), "[]").unwrap();
    std::fs::write(dir.path().join("secret.json"), "{}").unwrap();
    std::os::unix::fs::symlink(dir.path().join("secret.json"), games.join("golf").join("zz-escape.json")).unwrap();
    std::os::unix::fs::symlink(dir.path().join("secret.json"), games.join("zz-escape.js")).unwrap();
    let mut p = Paths::new(dir.path(), &dir.path().join("home"));
    p.games_dir = games;
    let app = App::new(p);
    assert!(app.game_file("golf/courses.json").is_some());
    assert!(app.game_file("golf/zz-escape.json").is_none());
    assert!(app.game_file("zz-escape.js").is_none());
}

#[test]
fn ui_edit_shows_up_without_restart() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("ui/app")).unwrap();
    let probe = dir.path().join("ui/app/zz-probe.js");
    std::fs::write(&probe, "var ZZ_PROBE = 1;\n").unwrap();
    std::fs::write(dir.path().join("index.html"), "<body><script>\n//@include ui/app/zz-probe.js\n</script>\n</body>\n").unwrap();
    let app = App::new(Paths::new(dir.path(), &dir.path().join("home")));
    let html = app.assemble_index().ok().unwrap();
    assert!(html.contains("var ZZ_PROBE = 1;"));
    assert!(!html.contains("@include"));
    std::fs::write(&probe, "var ZZ_PROBE = 2;\n").unwrap();
    // a different mtime even on coarse clocks
    let f = std::fs::File::options().write(true).open(&probe).unwrap();
    f.set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_000_000_000)).unwrap();
    assert!(app.assemble_index().ok().unwrap().contains("var ZZ_PROBE = 2;"));
}

// ---------------------------------------------------------------------------
// The save endpoint and static route over HTTP (beyond tests/http.rs)
// ---------------------------------------------------------------------------

struct Srv {
    port: u16,
    app: Arc<App>,
    _dir: tempfile::TempDir,
    _rt: tokio::runtime::Runtime,
}

fn serve() -> Srv {
    let (dir, app) = app();
    *app.agents_hook.write().unwrap() = Some(Arc::new(|| (Vec::new(), None)));
    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
    let listener = rt.block_on(tokio::net::TcpListener::bind("127.0.0.1:0")).unwrap();
    let port = listener.local_addr().unwrap().port();
    let router = server::router(app.clone());
    rt.spawn(async move { axum::serve(listener, router).await.unwrap() });
    Srv { port, app, _dir: dir, _rt: rt }
}

fn raw(port: u16, head: &str, body: &[u8]) -> (u16, Vec<u8>) {
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    s.write_all(head.as_bytes()).unwrap();
    s.write_all(body).unwrap();
    let mut buf = Vec::new();
    s.read_to_end(&mut buf).unwrap();
    let split = buf.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
    let status = String::from_utf8_lossy(&buf[..split]).split_whitespace().nth(1).unwrap().parse().unwrap();
    (status, buf[split + 4..].to_vec())
}

fn post_save(srv: &Srv, body: &Value) -> u16 {
    let b = body.to_string();
    raw(
        srv.port,
        &format!(
            "POST /api/games/state HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\nContent-Type: application/json\r\nX-HQ-Token: {}\r\nContent-Length: {}\r\n\r\n",
            srv.app.csrf_token,
            b.len()
        ),
        b.as_bytes(),
    )
    .0
}

#[test]
fn save_rejects_bad_saves_and_writes_nothing() {
    let srv = serve();
    assert_eq!(post_save(&srv, &json!({"state": [1]})), 400);
    assert_eq!(post_save(&srv, &json!({"nope": 1})), 400);
    let big = json!({"state": {"x": "y".repeat(GAMES_SAVE_MAX + 10)}});
    assert!([400, 413].contains(&post_save(&srv, &big)));
    assert!(!srv.app.paths.games_save.exists());
}

#[test]
fn static_route_serves_and_refuses_traversal() {
    let srv = serve();
    let get = |p: &str| raw(srv.port, &format!("GET {} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n", p), b"").0;
    assert_eq!(get("/games/core.js"), 200);
    for bad in ["/games/..%2fdashboard.py", "/games/../dashboard-rs/Cargo.toml", "/games/vendor/..%2f..%2fREADME.md"] {
        assert_eq!(get(bad), 404, "{}", bad);
    }
}
