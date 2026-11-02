//! Mission Control ops (HQ 3.38): the git facts each desk's hologram shows, and the
//! ops wall's CI board.
//!
//! git: for a session's cwd, the repo it is in (its folder name and, for a GitHub
//! `origin`, `owner/name`) and the checked-out branch. Read straight from `.git`
//! (HEAD and config, a worktree's `gitdir:` file), no `git` process; cached per cwd
//! for GIT_TTL_SECS. Rides in /api/sessions as `git` (null outside a repo).
//!
//! GET /api/mc/ops -> {gh, ok, fetchedAt, repos: [{slug, self, branches: [{branch,
//! state, runs, failing}], error?}], deploy: null}. The CI runs of the GitHub repos
//! the live sessions are in (and this HQ's own), through the user's `gh` CLI and its
//! existing auth: the server runs `gh run list` / `gh run view`, never reads a token,
//! and caches the result OPS_TTL_SECS. No `gh`, no network or a repo gh cannot see:
//! the board says so quietly (`gh: false`, `ok: false`, a repo's `error`).
//! There is no local deploy panel to read, so `deploy` is always null.

use crate::app::App;
use crate::ext::Resp;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, RwLock};

pub const GIT_TTL_SECS: f64 = 10.0;
pub const OPS_TTL_SECS: f64 = 90.0;
pub const REPOS_MAX: usize = 6;
pub const BRANCHES_MAX: usize = 6;
pub const RUNS_LIMIT: usize = 30;
/// `gh run view` lookups for failing job names, per repo per refresh.
pub const FAIL_LOOKUPS: usize = 3;
pub const FAILING_MAX: usize = 4;

#[derive(Default)]
pub struct McOpsState {
    git: Mutex<HashMap<String, (f64, Value)>>,
    ops: Mutex<OpsCache>,
    /// Test seam: the repos to ask about instead of the sessions' ones.
    pub slugs_hook: RwLock<Option<Vec<String>>>,
}

#[derive(Default)]
struct OpsCache {
    at: f64,
    value: Option<Value>,
    refreshing: bool,
}

// ---------------------------------------------------------------------------
// git (pure parts first)
// ---------------------------------------------------------------------------

/// `.git/HEAD`: the branch name, or `@` + a short sha when detached.
pub fn parse_head(s: &str) -> Option<String> {
    let s = s.trim();
    if let Some(r) = s.strip_prefix("ref:") {
        let r = r.trim();
        let name = r.strip_prefix("refs/heads/").unwrap_or(r);
        return (!name.is_empty()).then(|| name.to_string());
    }
    (s.len() >= 7 && s.bytes().all(|b| b.is_ascii_hexdigit())).then(|| format!("@{}", &s[..7]))
}

fn slug_ok(s: &str) -> bool {
    let mut parts = s.split('/');
    let ok = |p: Option<&str>| p.is_some_and(|p| !p.is_empty() && p != "." && p != ".." && p.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b)));
    ok(parts.next()) && ok(parts.next()) && parts.next().is_none()
}

/// `owner/name` from a GitHub remote url (https, ssh, scp-like), else None.
pub fn github_slug(url: &str) -> Option<String> {
    let u = url.trim();
    let rest = ["https://github.com/", "http://github.com/", "ssh://git@github.com/", "git@github.com:", "git://github.com/"]
        .iter()
        .find_map(|p| u.strip_prefix(p))
        .or_else(|| u.strip_prefix("https://").and_then(|r| r.split_once('@')).and_then(|(_, r)| r.strip_prefix("github.com/")))?;
    let rest = rest.trim_end_matches('/');
    let rest = rest.strip_suffix(".git").unwrap_or(rest);
    slug_ok(rest).then(|| rest.to_string())
}

/// The `url` of `[remote "origin"]` in a git config, as a GitHub slug.
pub fn parse_origin_slug(config: &str) -> Option<String> {
    let mut in_origin = false;
    for line in config.lines() {
        let l = line.trim();
        if l.starts_with('[') {
            in_origin = l.replace(' ', "") == "[remote\"origin\"]";
            continue;
        }
        if in_origin {
            if let Some((k, v)) = l.split_once('=') {
                if k.trim() == "url" {
                    return github_slug(v);
                }
            }
        }
    }
    None
}

/// (work tree root, its git dir, the common git dir) for a folder inside a repo.
pub fn find_git(cwd: &Path) -> Option<(PathBuf, PathBuf, PathBuf)> {
    for dir in cwd.ancestors().take(40) {
        let dot = dir.join(".git");
        if dot.is_dir() {
            return Some((dir.to_path_buf(), dot.clone(), dot));
        }
        if dot.is_file() {
            let txt = std::fs::read_to_string(&dot).ok()?;
            let gd = txt.lines().find_map(|l| l.trim().strip_prefix("gitdir:")).map(str::trim)?;
            let gd = if Path::new(gd).is_absolute() { PathBuf::from(gd) } else { dir.join(gd) };
            let common = std::fs::read_to_string(gd.join("commondir"))
                .ok()
                .map(|c| {
                    let c = c.trim();
                    if Path::new(c).is_absolute() { PathBuf::from(c) } else { gd.join(c) }
                })
                .unwrap_or_else(|| gd.clone());
            return Some((dir.to_path_buf(), gd, common));
        }
    }
    None
}

/// {repo, slug, branch} for a folder, or null outside a repo. Reads two small files.
pub fn git_info_uncached(cwd: &str) -> Value {
    if cwd.is_empty() || !Path::new(cwd).is_absolute() {
        return Value::Null;
    }
    let Some((root, gd, common)) = find_git(Path::new(cwd)) else { return Value::Null };
    let branch = std::fs::read_to_string(gd.join("HEAD")).ok().and_then(|h| parse_head(&h));
    let slug = std::fs::read_to_string(common.join("config")).ok().and_then(|c| parse_origin_slug(&c));
    // the repo's name: its GitHub name, else the main checkout's folder (a worktree's common dir is <main>/.git)
    let main = if common.file_name().is_some_and(|n| n == ".git") { common.parent().map(Path::to_path_buf) } else { None };
    let folder = main.as_deref().unwrap_or(&root).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let repo = slug.as_deref().and_then(|s| s.split('/').nth(1)).map(String::from).unwrap_or(folder);
    json!({"repo": repo, "slug": slug, "branch": branch})
}

// ---------------------------------------------------------------------------
// CI (pure parts)
// ---------------------------------------------------------------------------

fn run_state(status: &str, conclusion: &str) -> &'static str {
    if status != "completed" {
        return "running";
    }
    match conclusion {
        "success" | "skipped" | "neutral" => "pass",
        "failure" | "timed_out" | "startup_failure" | "action_required" => "fail",
        "cancelled" => "cancelled",
        _ => "other",
    }
}

/// `gh run list --json databaseId,headBranch,status,conclusion,workflowName,url,createdAt`
/// (newest first) -> the latest run of each workflow on each branch, branches in
/// order of their newest run, at most BRANCHES_MAX. A branch fails if any of its
/// workflows' latest run failed, runs while one runs, else passes.
pub fn summarize_runs(raw: &str) -> Option<Vec<Value>> {
    let rows: Value = serde_json::from_str(if raw.trim().is_empty() { "[]" } else { raw }).ok()?;
    let rows = rows.as_array()?;
    let mut order: Vec<String> = Vec::new();
    let mut by: HashMap<String, Vec<Value>> = HashMap::new();
    for r in rows {
        let s = |k: &str| r.get(k).and_then(Value::as_str).unwrap_or("").to_string();
        let branch = s("headBranch");
        if branch.is_empty() {
            continue;
        }
        if !by.contains_key(&branch) {
            if order.len() >= BRANCHES_MAX {
                continue;
            }
            order.push(branch.clone());
        }
        let runs = by.entry(branch).or_default();
        let wf = s("workflowName");
        if runs.iter().any(|x| x["workflow"] == wf.as_str()) {
            continue;
        }
        let (status, conclusion) = (s("status"), s("conclusion"));
        runs.push(json!({
            "workflow": wf, "status": status, "conclusion": conclusion,
            "state": run_state(&status, &conclusion),
            "id": r.get("databaseId").and_then(Value::as_i64),
            "url": s("url"), "at": s("createdAt"),
        }));
    }
    Some(
        order
            .into_iter()
            .map(|b| {
                let runs = by.remove(&b).unwrap_or_default();
                let has = |st: &str| runs.iter().any(|r| r["state"] == st);
                let state = if has("fail") { "fail" } else if has("running") { "running" } else if has("pass") { "pass" } else { "other" };
                json!({"branch": b, "state": state, "runs": runs, "failing": []})
            })
            .collect(),
    )
}

/// `gh run view <id> --json jobs` -> the names of its failed jobs.
pub fn failing_jobs(raw: &str) -> Vec<String> {
    let v: Value = serde_json::from_str(raw).unwrap_or(Value::Null);
    v.get("jobs")
        .and_then(Value::as_array)
        .map(|jobs| {
            jobs.iter()
                .filter(|j| matches!(j.get("conclusion").and_then(Value::as_str), Some("failure" | "timed_out" | "startup_failure")))
                .filter_map(|j| j.get("name").and_then(Value::as_str))
                .map(|n| crate::py::truncate(n, 60))
                .take(FAILING_MAX)
                .collect()
        })
        .unwrap_or_default()
}

fn argv(a: &[&str]) -> Vec<String> {
    a.iter().map(|s| s.to_string()).collect()
}

impl App {
    /// `git` for a session card (cached per cwd).
    pub fn git_info(&self, cwd: &str) -> Value {
        let now = crate::py::now_ts();
        if let Some((at, v)) = self.mcops.git.lock().unwrap().get(cwd) {
            if now - at < GIT_TTL_SECS {
                return v.clone();
            }
        }
        let v = git_info_uncached(cwd);
        let mut g = self.mcops.git.lock().unwrap();
        if g.len() > 256 {
            g.clear();
        }
        g.insert(cwd.to_string(), (now, v.clone()));
        v
    }

    /// This HQ's own repo first, then the live sessions' GitHub repos.
    fn ops_slugs(&self) -> Vec<(String, bool)> {
        if let Some(s) = self.mcops.slugs_hook.read().unwrap().clone() {
            return s.into_iter().enumerate().map(|(i, s)| (s, i == 0)).collect();
        }
        let mut out: Vec<(String, bool)> = Vec::new();
        let own = git_info_uncached(&self.paths.here.to_string_lossy());
        if let Some(s) = own.get("slug").and_then(Value::as_str) {
            out.push((s.to_string(), true));
        }
        let payload = self.build_payload_memo();
        for s in payload.get("sessions").and_then(Value::as_array).into_iter().flatten() {
            if s.get("status").and_then(Value::as_str) == Some("stale") {
                continue;
            }
            if let Some(slug) = s.pointer("/git/slug").and_then(Value::as_str) {
                if !out.iter().any(|(x, _)| x == slug) {
                    out.push((slug.to_string(), false));
                }
            }
        }
        out.truncate(REPOS_MAX);
        out
    }

    fn ops_repo(&self, slug: &str, own: bool) -> Value {
        let list = argv(&["gh", "run", "list", "-R", slug, "--limit", &RUNS_LIMIT.to_string(), "--json", "databaseId,headBranch,status,conclusion,workflowName,url,createdAt"]);
        let branches = match self.run_gh(&list) {
            Some((0, out)) => summarize_runs(&out),
            _ => None,
        };
        let Some(mut branches) = branches else {
            return json!({"slug": slug, "self": own, "branches": [], "error": "unavailable"});
        };
        let mut lookups = 0;
        for b in branches.iter_mut() {
            if b["state"] != "fail" || lookups >= FAIL_LOOKUPS {
                continue;
            }
            let mut names: Vec<String> = Vec::new();
            let ids: Vec<i64> = b["runs"].as_array().into_iter().flatten().filter(|r| r["state"] == "fail").filter_map(|r| r["id"].as_i64()).collect();
            for id in ids {
                if lookups >= FAIL_LOOKUPS {
                    break;
                }
                lookups += 1;
                if let Some((0, out)) = self.run_gh(&argv(&["gh", "run", "view", &id.to_string(), "-R", slug, "--json", "jobs"])) {
                    names.extend(failing_jobs(&out));
                }
            }
            names.truncate(FAILING_MAX);
            b["failing"] = json!(names);
        }
        json!({"slug": slug, "self": own, "branches": branches})
    }

    fn ops_fetch(&self) -> Value {
        let at = crate::py::iso_from_ts(crate::py::now_ts());
        if !self.gh_available() {
            return json!({"gh": false, "ok": false, "fetchedAt": at, "repos": [], "deploy": null, "note": "Install the GitHub CLI (gh) and run gh auth login to see CI here."});
        }
        let repos: Vec<Value> = self.ops_slugs().iter().map(|(s, own)| self.ops_repo(s, *own)).collect();
        let ok = repos.is_empty() || repos.iter().any(|r| r.get("error").is_none());
        json!({"gh": true, "ok": ok, "fetchedAt": at, "repos": repos, "deploy": null,
               "note": if ok { Value::Null } else { json!("GitHub is not reachable right now.") }})
    }

    /// The cached board; refreshed by one caller at a time once OPS_TTL_SECS old
    /// (the others get the previous board meanwhile, `refreshing: true`).
    pub fn mc_ops(&self) -> Value {
        let now = crate::py::now_ts();
        {
            let mut c = self.mcops.ops.lock().unwrap();
            if let Some(v) = &c.value {
                if now - c.at < OPS_TTL_SECS || c.refreshing {
                    let mut v = v.clone();
                    v["refreshing"] = json!(c.refreshing);
                    return v;
                }
            } else if c.refreshing {
                return json!({"gh": null, "ok": false, "repos": [], "deploy": null, "refreshing": true});
            }
            c.refreshing = true;
        }
        let v = self.ops_fetch();
        let mut c = self.mcops.ops.lock().unwrap();
        c.refreshing = false;
        c.at = crate::py::now_ts();
        c.value = Some(v.clone());
        v
    }

    /// Test seam: age the cache as if `secs` had passed.
    pub fn mc_ops_age(&self, secs: f64) {
        self.mcops.ops.lock().unwrap().at -= secs;
    }
}

/// GET /api/mc/ops (registered in ext::GET).
pub fn get_ops(app: &App, _arg: &dyn Fn(&str) -> String) -> Resp {
    (200, app.mc_ops())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::testutil::app;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    #[test]
    fn head_and_remote_parsing() {
        assert_eq!(parse_head("ref: refs/heads/feat/mission-control-ops\n").as_deref(), Some("feat/mission-control-ops"));
        assert_eq!(parse_head("9f630ed1234567890abcdef\n").as_deref(), Some("@9f630ed"));
        assert_eq!(parse_head(""), None);
        assert_eq!(parse_head("garbage"), None);
        for u in ["git@github.com:RoString36222/claude-hq.git", "https://github.com/RoString36222/claude-hq", "https://github.com/RoString36222/claude-hq.git/",
                  "ssh://git@github.com/RoString36222/claude-hq.git", "https://tok@github.com/RoString36222/claude-hq.git"] {
            assert_eq!(github_slug(u).as_deref(), Some("RoString36222/claude-hq"), "{u}");
        }
        for u in ["https://gitlab.com/a/b", "git@github.com:a", "https://github.com/a/b/c", "https://github.com/../b", "", "https://github.com/a b/c"] {
            assert_eq!(github_slug(u), None, "{u}");
        }
        let cfg = "[core]\n\turl = nope\n[remote \"upstream\"]\n\turl = git@github.com:x/y.git\n[remote \"origin\"]\n\turl = git@github.com:me/proj.git\n\tfetch = +refs/heads/*\n";
        assert_eq!(parse_origin_slug(cfg).as_deref(), Some("me/proj"));
        assert_eq!(parse_origin_slug("[remote \"upstream\"]\nurl = git@github.com:x/y.git\n"), None);
        assert_eq!(parse_origin_slug(""), None);
    }

    #[test]
    fn git_info_reads_repos_and_worktrees() {
        let d = tempfile::tempdir().unwrap();
        let main = d.path().join("proj");
        std::fs::create_dir_all(main.join(".git/worktrees/wt")).unwrap();
        std::fs::create_dir_all(main.join("src/deep")).unwrap();
        std::fs::write(main.join(".git/HEAD"), "ref: refs/heads/main\n").unwrap();
        std::fs::write(main.join(".git/config"), "[remote \"origin\"]\n\turl = https://github.com/me/proj.git\n").unwrap();
        let v = git_info_uncached(&main.join("src/deep").to_string_lossy());
        assert_eq!(v, json!({"repo": "proj", "slug": "me/proj", "branch": "main"}));
        // a worktree: .git is a file pointing at <main>/.git/worktrees/wt, whose commondir is ../..
        let wt = d.path().join("wt");
        std::fs::create_dir_all(&wt).unwrap();
        std::fs::write(wt.join(".git"), format!("gitdir: {}\n", main.join(".git/worktrees/wt").display())).unwrap();
        std::fs::write(main.join(".git/worktrees/wt/HEAD"), "ref: refs/heads/feat/x\n").unwrap();
        std::fs::write(main.join(".git/worktrees/wt/commondir"), "../..\n").unwrap();
        let v = git_info_uncached(&wt.to_string_lossy());
        assert_eq!(v["branch"], "feat/x");
        assert_eq!(v["slug"], "me/proj");
        // no origin on GitHub: the folder name, no slug
        std::fs::write(main.join(".git/config"), "").unwrap();
        assert_eq!(git_info_uncached(&main.to_string_lossy()), json!({"repo": "proj", "slug": null, "branch": "main"}));
        // outside a repo, relative, empty
        let lone = d.path().join("lone");
        std::fs::create_dir_all(&lone).unwrap();
        assert_eq!(git_info_uncached(&lone.to_string_lossy()), Value::Null);
        assert_eq!(git_info_uncached("relative/path"), Value::Null);
        assert_eq!(git_info_uncached(""), Value::Null);
    }

    #[test]
    fn runs_are_summarized_per_branch() {
        let raw = json!([
            {"databaseId": 5, "headBranch": "main", "status": "completed", "conclusion": "failure", "workflowName": "CI", "url": "u5", "createdAt": "t5"},
            {"databaseId": 4, "headBranch": "feat/a", "status": "in_progress", "conclusion": "", "workflowName": "CI", "url": "u4", "createdAt": "t4"},
            {"databaseId": 3, "headBranch": "main", "status": "completed", "conclusion": "success", "workflowName": "CI", "url": "u3", "createdAt": "t3"},
            {"databaseId": 2, "headBranch": "main", "status": "completed", "conclusion": "success", "workflowName": "Pages", "url": "u2", "createdAt": "t2"},
            {"databaseId": 1, "headBranch": "feat/b", "status": "completed", "conclusion": "success", "workflowName": "CI", "url": "u1", "createdAt": "t1"},
            {"databaseId": 0, "headBranch": "", "status": "completed", "conclusion": "success", "workflowName": "CI"},
            "odd row"
        ]).to_string();
        let b = summarize_runs(&raw).unwrap();
        assert_eq!(b.iter().map(|x| x["branch"].as_str().unwrap()).collect::<Vec<_>>(), ["main", "feat/a", "feat/b"]);
        assert_eq!(b[0]["state"], "fail");
        assert_eq!(b[0]["runs"].as_array().unwrap().len(), 2, "latest CI + latest Pages");
        assert_eq!(b[1]["state"], "running");
        assert_eq!(b[2]["state"], "pass");
        assert_eq!(summarize_runs("").unwrap().len(), 0);
        assert_eq!(summarize_runs("not json"), None);
        assert_eq!(summarize_runs("{}"), None);
        let many: Vec<Value> = (0..20).map(|i| json!({"headBranch": format!("b{i}"), "status": "completed", "conclusion": "success", "workflowName": "CI"})).collect();
        assert_eq!(summarize_runs(&Value::from(many).to_string()).unwrap().len(), BRANCHES_MAX);
        let jobs = json!({"jobs": [{"name": "test", "conclusion": "failure"}, {"name": "lint", "conclusion": "success"}, {"name": "build", "conclusion": "timed_out"}, {"conclusion": "failure"}]});
        assert_eq!(failing_jobs(&jobs.to_string()), ["test", "build"]);
        assert!(failing_jobs("nope").is_empty());
    }

    fn fake_gh(app: &App, fail_list: bool) -> Arc<AtomicUsize> {
        let calls = Arc::new(AtomicUsize::new(0));
        let c = calls.clone();
        *app.ext.gh_which_hook.write().unwrap() = Some(true);
        *app.ext.gh_hook.write().unwrap() = Some(Arc::new(move |argv: &[String]| {
            c.fetch_add(1, Ordering::SeqCst);
            assert!(!argv.iter().any(|a| a.contains("token")), "never asks gh for a token");
            if argv[1..3] == ["run".to_string(), "list".to_string()] {
                if fail_list {
                    return Some((1, String::new()));
                }
                return Some((0, json!([{"databaseId": 9, "headBranch": "main", "status": "completed", "conclusion": "failure", "workflowName": "CI"}]).to_string()));
            }
            Some((0, json!({"jobs": [{"name": "cargo test", "conclusion": "failure"}]}).to_string()))
        }));
        calls
    }

    #[test]
    fn ops_board_caches_and_degrades() {
        let (_d, app) = app();
        *app.mcops.slugs_hook.write().unwrap() = Some(vec!["me/hq".into(), "me/other".into()]);
        // no gh at all: a quiet board, no calls
        *app.ext.gh_which_hook.write().unwrap() = Some(false);
        let v = app.mc_ops();
        assert_eq!((v["gh"].clone(), v["ok"].clone()), (json!(false), json!(false)));
        assert!(v["note"].as_str().unwrap().contains("gh auth login"));
        // cached: flipping gh on changes nothing until the TTL passes
        let calls = fake_gh(&app, false);
        assert_eq!(app.mc_ops()["gh"], false);
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        app.mc_ops_age(OPS_TTL_SECS + 1.0);
        let v = app.mc_ops();
        assert_eq!(v["ok"], true);
        assert_eq!(v["repos"][0]["self"], true);
        assert_eq!(v["repos"][0]["branches"][0]["failing"], json!(["cargo test"]));
        assert_eq!(v["deploy"], Value::Null);
        let n = calls.load(Ordering::SeqCst);
        assert_eq!(n, 4, "two lists, two failing-job lookups");
        app.mc_ops();
        app.mc_ops();
        assert_eq!(calls.load(Ordering::SeqCst), n, "served from the cache");
        // gh fails (offline / no access): each repo says unavailable, the board is not ok
        let (_d2, app2) = crate::app::testutil::app();
        *app2.mcops.slugs_hook.write().unwrap() = Some(vec!["me/hq".into()]);
        fake_gh(&app2, true);
        let v = app2.mc_ops();
        assert_eq!(v["gh"], true);
        assert_eq!(v["ok"], false);
        assert_eq!(v["repos"][0]["error"], "unavailable");
        assert!(!v.to_string().to_lowercase().contains("token"));
    }

    #[test]
    fn sessions_carry_git_and_last_tool() {
        let (d, app) = app();
        let repo = d.path().join("work/proj");
        std::fs::create_dir_all(repo.join(".git")).unwrap();
        std::fs::write(repo.join(".git/HEAD"), "ref: refs/heads/feat/holo\n").unwrap();
        std::fs::write(repo.join(".git/config"), "[remote \"origin\"]\n url = git@github.com:me/proj.git\n").unwrap();
        let cwd = repo.to_string_lossy().into_owned();
        *app.agents_hook.write().unwrap() = Some(Arc::new(move || {
            (vec![json!({"sessionId": "11111111-2222-3333-4444-555555555555", "cwd": cwd, "kind": "interactive", "status": "busy"})], None)
        }));
        let p = app.build_payload();
        let s = &p["sessions"][0];
        assert_eq!(s["git"], json!({"repo": "proj", "slug": "me/proj", "branch": "feat/holo"}));
        assert!(s.get("lastTool").is_some());
        // and the ops board asks about that repo
        assert_eq!(app.ops_slugs().iter().map(|(s, _)| s.as_str()).collect::<Vec<_>>(), ["me/proj"]);
    }
}
