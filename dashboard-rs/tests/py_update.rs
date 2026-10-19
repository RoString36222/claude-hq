//! The Update button (ported from tests/test_update.py, plus the build into
//! Rust): status against an upstream, fast-forward only, refusing local edits
//! and diverged history, the stale-code restart, and the `cargo build
//! --release --locked` that runs before every restart. Throwaway git repos and
//! a fake cargo on PATH; the restart is a hook, so this process is never
//! replaced.

use claudehq::actions::{is_launch_agent, LAUNCH_LABEL};
use claudehq::app::{App, Paths};
use serde_json::json;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// PATH and HOME are process-wide: the tests that change them take turns.
static ENV: Mutex<()> = Mutex::new(());

fn git(cwd: &Path, args: &[&str]) {
    let out = Command::new("git")
        .arg("-C")
        .arg(cwd)
        .args(args)
        .env("GIT_AUTHOR_NAME", "t")
        .env("GIT_AUTHOR_EMAIL", "t@t")
        .env("GIT_COMMITTER_NAME", "t")
        .env("GIT_COMMITTER_EMAIL", "t@t")
        .output()
        .unwrap();
    assert!(out.status.success(), "{:?}", out);
}

struct Repo {
    tmp: tempfile::TempDir,
    other: PathBuf,
    mine: PathBuf,
}

impl Repo {
    /// origin.git with one commit (a.txt and dashboard-rs/Cargo.toml), cloned to `mine`.
    fn new() -> Repo {
        let tmp = tempfile::tempdir().unwrap();
        let origin = tmp.path().join("origin.git");
        let other = tmp.path().join("other");
        let mine = tmp.path().join("mine");
        assert!(Command::new("git").args(["init", "-q", "--bare", "-b", "main"]).arg(&origin).status().unwrap().success());
        assert!(Command::new("git").args(["clone", "-q"]).arg(&origin).arg(&other).output().unwrap().status.success());
        std::fs::create_dir_all(other.join("dashboard-rs")).unwrap();
        std::fs::write(other.join("dashboard-rs/Cargo.toml"), "[package]\n").unwrap();
        std::fs::write(other.join("a.txt"), "one").unwrap();
        git(&other, &["add", "a.txt", "dashboard-rs/Cargo.toml"]);
        git(&other, &["commit", "-q", "-m", "first"]);
        git(&other, &["push", "-q", "origin", "HEAD:main"]);
        assert!(Command::new("git").args(["clone", "-q"]).arg(&origin).arg(&mine).output().unwrap().status.success());
        Repo { tmp, other, mine }
    }

    fn push_upstream(&self, msg: &str) {
        std::fs::write(self.other.join("a.txt"), msg).unwrap();
        git(&self.other, &["commit", "-qam", msg]);
        git(&self.other, &["push", "-q", "origin", "HEAD:main"]);
    }

    /// A cargo that logs its arguments and builds target/release/claudehq,
    /// or fails like a compile error while `fail` exists.
    fn fake_cargo(&self) -> PathBuf {
        let bin = self.tmp.path().join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let t = self.tmp.path().display();
        let script = format!(
            "#!/bin/sh\necho \"$@\" >> '{t}/cargo.args'\nif [ -e '{t}/fail' ]; then echo 'error[E0425]: boom' >&2; exit 101; fi\n\
             for a; do m=\"$a\"; done\nd=$(dirname \"$m\")\nmkdir -p \"$d/target/release\" && touch \"$d/target/release/claudehq\"\n"
        );
        let p = bin.join("cargo");
        std::fs::write(&p, script).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        bin
    }

    fn cargo_calls(&self) -> Vec<String> {
        std::fs::read_to_string(self.tmp.path().join("cargo.args")).unwrap_or_default().lines().map(String::from).collect()
    }
}

/// An App on `mine` whose restart records the binary it would exec.
type Restarts = Arc<Mutex<Vec<Option<PathBuf>>>>;

fn app(r: &Repo, boot_code_sig: Option<Option<i128>>) -> (App, Restarts) {
    let state = r.tmp.path().join("state");
    let mut p = Paths::new(&state, &state.join("home"));
    p.here = r.mine.clone();
    let mut app = App::new(p);
    if let Some(sig) = boot_code_sig {
        app.boot_code_sig = sig;
    }
    let restarts = Arc::new(Mutex::new(Vec::new()));
    let r2 = restarts.clone();
    *app.restart_hook.write().unwrap() = Some(Arc::new(move |bin| r2.lock().unwrap().push(bin)));
    (app, restarts)
}

/// Run `f` with `dir` first on PATH and HOME at `home`.
fn with_env<T>(dir: &Path, home: &Path, keep_path: bool, f: impl FnOnce() -> T) -> T {
    let _g = ENV.lock().unwrap_or_else(|e| e.into_inner());
    let (old_path, old_home) = (std::env::var_os("PATH"), std::env::var_os("HOME"));
    let rest = if keep_path { old_path.clone().unwrap_or_default().into_string().unwrap() } else { "/usr/bin:/bin".into() };
    std::env::set_var("PATH", format!("{}:{}", dir.display(), rest));
    std::env::set_var("HOME", home);
    let out = f();
    match old_path {
        Some(p) => std::env::set_var("PATH", p),
        None => std::env::remove_var("PATH"),
    }
    match old_home {
        Some(h) => std::env::set_var("HOME", h),
        None => std::env::remove_var("HOME"),
    }
    out
}

fn after_restart_timer() {
    std::thread::sleep(Duration::from_millis(1300)); // the restart fires on a 1s timer
}

#[test]
fn up_to_date_neither_builds_nor_restarts() {
    let r = Repo::new();
    let bin = r.fake_cargo();
    let (app, restarts) = app(&r, None);
    let resp = with_env(&bin, r.tmp.path(), true, || {
        let st = app.update_status(true);
        assert_eq!((st["ok"].clone(), st["behind"].clone(), st["ahead"].clone(), st["dirty"].clone(), st["stale"].clone()),
                   (json!(true), json!(0), json!(0), json!(false), json!(false)));
        app.update_and_restart()
    });
    assert_eq!(resp.0, 200);
    assert_eq!(resp.1["updated"], false);
    after_restart_timer();
    assert!(restarts.lock().unwrap().is_empty());
    assert!(r.cargo_calls().is_empty());
}

#[test]
fn a_pull_builds_with_cargo_locked_and_restarts_into_the_build() {
    let r = Repo::new();
    let bin = r.fake_cargo();
    let (app, restarts) = app(&r, None);
    r.push_upstream("second");
    let (code, resp) = with_env(&bin, r.tmp.path(), true, || {
        assert_eq!(app.update_status(true)["behind"], 1);
        app.update_and_restart()
    });
    assert_eq!(code, 200, "{}", resp);
    assert_eq!((resp["updated"].clone(), resp["restarting"].clone(), resp["server"].clone()), (json!(true), json!(true), json!("rust")));
    assert_eq!(std::fs::read_to_string(r.mine.join("a.txt")).unwrap(), "second");
    let manifest = r.mine.join("dashboard-rs/Cargo.toml");
    assert_eq!(r.cargo_calls(), vec![format!("build --release --locked --manifest-path {}", manifest.display())]);
    after_restart_timer();
    assert_eq!(*restarts.lock().unwrap(), vec![Some(r.mine.join("dashboard-rs/target/release/claudehq"))]);
}

#[test]
fn a_failed_build_keeps_this_server_running() {
    let r = Repo::new();
    let bin = r.fake_cargo();
    std::fs::write(r.tmp.path().join("fail"), "").unwrap();
    let (app, restarts) = app(&r, None);
    r.push_upstream("second");
    let (code, resp) = with_env(&bin, r.tmp.path(), true, || app.update_and_restart());
    assert_eq!(code, 409);
    let err = resp["error"].as_str().unwrap();
    assert!(err.contains("keeps running the old build"), "{}", err);
    assert!(err.contains("cargo build failed: error[E0425]: boom"), "{}", err);
    assert_eq!(std::fs::read_to_string(r.mine.join("a.txt")).unwrap(), "second"); // the pull itself landed
    after_restart_timer();
    assert!(restarts.lock().unwrap().is_empty());
}

#[test]
fn no_cargo_says_so_and_keeps_running() {
    let r = Repo::new();
    let empty = r.tmp.path().join("nobin");
    std::fs::create_dir_all(&empty).unwrap();
    let (app, restarts) = app(&r, None);
    r.push_upstream("second");
    // PATH without cargo, HOME without ~/.cargo/bin/cargo
    let (code, resp) = with_env(&empty, r.tmp.path(), false, || app.update_and_restart());
    assert_eq!(code, 409);
    assert!(resp["error"].as_str().unwrap().contains("cargo is not installed"), "{}", resp);
    after_restart_timer();
    assert!(restarts.lock().unwrap().is_empty());
}

#[test]
fn a_checkout_without_dashboard_rs_restarts_as_is() {
    let r = Repo::new();
    git(&r.other, &["rm", "-rq", "dashboard-rs"]);
    git(&r.other, &["commit", "-qm", "no rust"]);
    git(&r.other, &["push", "-q", "origin", "HEAD:main"]);
    let bin = r.fake_cargo();
    let (app, restarts) = app(&r, None);
    let (code, resp) = with_env(&bin, r.tmp.path(), true, || app.update_and_restart());
    assert_eq!(code, 200, "{}", resp);
    assert!(r.cargo_calls().is_empty());
    after_restart_timer();
    assert_eq!(*restarts.lock().unwrap(), vec![None]);
}

#[test]
fn refuses_local_edits_and_diverged_history() {
    let r = Repo::new();
    let bin = r.fake_cargo();
    let (app, restarts) = app(&r, None);
    r.push_upstream("second");
    std::fs::write(r.mine.join("a.txt"), "my edit").unwrap();
    let (code, resp) = with_env(&bin, r.tmp.path(), true, || app.update_and_restart());
    assert_eq!(code, 409);
    assert!(resp["error"].as_str().unwrap().contains("local changes"));
    assert_eq!(std::fs::read_to_string(r.mine.join("a.txt")).unwrap(), "my edit");
    git(&r.mine, &["checkout", "--", "a.txt"]);
    std::fs::write(r.mine.join("b.txt"), "local").unwrap();
    git(&r.mine, &["add", "b.txt"]);
    git(&r.mine, &["commit", "-qm", "local work"]);
    let (code, resp) = with_env(&bin, r.tmp.path(), true, || app.update_and_restart());
    assert_eq!(code, 409);
    assert!(resp["error"].as_str().unwrap().contains("diverged"));
    after_restart_timer();
    assert!(restarts.lock().unwrap().is_empty());
    assert!(r.cargo_calls().is_empty());
}

#[test]
fn status_is_cached_until_forced() {
    let r = Repo::new();
    let (app, _) = app(&r, None);
    app.update_status(true);
    r.push_upstream("second");
    assert_eq!(app.update_status(false)["behind"], 0);
    assert_eq!(app.update_status(true)["behind"], 1);
}

#[test]
fn stale_code_rebuilds_and_restarts_without_pulling() {
    // The binary on disk changed after this process started: nothing to fetch,
    // but the server must rebuild and restart to run it.
    let r = Repo::new();
    let bin = r.fake_cargo();
    let (app, restarts) = app(&r, Some(Some(-1)));
    let (code, resp) = with_env(&bin, r.tmp.path(), true, || {
        assert_eq!(app.update_status(true)["stale"], true);
        assert_eq!(app.update_status(false)["stale"], true); // fresh even when cached
        app.update_and_restart()
    });
    assert_eq!(code, 200, "{}", resp);
    assert_eq!((resp["updated"].clone(), resp["restarting"].clone(), resp["server"].clone()), (json!(false), json!(true), json!("rust")));
    assert_eq!(r.cargo_calls().len(), 1);
    after_restart_timer();
    assert_eq!(*restarts.lock().unwrap(), vec![Some(r.mine.join("dashboard-rs/target/release/claudehq"))]);
}

#[test]
fn stale_code_with_a_failed_build_keeps_running() {
    let r = Repo::new();
    let bin = r.fake_cargo();
    std::fs::write(r.tmp.path().join("fail"), "").unwrap();
    let (app, restarts) = app(&r, Some(Some(-1)));
    let (code, resp) = with_env(&bin, r.tmp.path(), true, || app.update_and_restart());
    assert_eq!(code, 409);
    assert!(resp["error"].as_str().unwrap().starts_with("cargo build failed"), "{}", resp);
    after_restart_timer();
    assert!(restarts.lock().unwrap().is_empty());
}

#[test]
fn not_stale_by_default_and_the_payload_carries_the_boot_id() {
    let r = Repo::new();
    let (app, _) = app(&r, None);
    assert_eq!(app.update_status(true)["stale"], false);
    assert_eq!(app.boot_id.len(), 16);
    assert!(app.boot_id.chars().all(|c| c.is_ascii_hexdigit()));
    assert_eq!(app.build_payload()["boot"], app.boot_id);
}

#[test]
fn only_the_named_launchd_job_counts_as_the_launch_agent() {
    assert!(is_launch_agent(Some(LAUNCH_LABEL)));
    assert!(!is_launch_agent(None)); // an orphan under pid 1 (nohup ... &) has no job name
    assert!(!is_launch_agent(Some("application.com.apple.Terminal.123")));
    assert!(!is_launch_agent(Some("")));
}
