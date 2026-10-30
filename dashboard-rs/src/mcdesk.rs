//! Mission Control desk: answer Claude Code permission prompts from HQ.
//!
//! Mechanism (the same one HQ Notch uses): the installed Notch relay
//! (~/Library/Application Support/HQNotch/hq_notch_hook.py) sends the hook's
//! PermissionRequest as one JSON line over a Unix socket and waits for one reply
//! line {"decision": "allow"|"deny", "message"}; its decision_output() turns that
//! into Claude Code's documented PermissionRequest hook output. The desk listens
//! on its own socket (HQNotch/desk.sock); the user adds one PermissionRequest
//! hook that runs that same relay with SOCKET_PATH pointed at desk.sock (see
//! `install_command`). Nothing is ever auto-approved: a request the desk is not
//! watching (no GET within WATCH_SECS), a question, or a timeout gets "pass",
//! so the terminal asks as usual.
//!
//! GET  /api/mcdesk/pending?sessionId=  -> {notchHook, deskHook, listening, install, requests, message}
//! POST /api/mcdesk/decide  {id, sessionId, decision: allow|deny}
//! POST /api/mcdesk/message -> 501 unsupported (no safe delivery hook wired yet)
//! POSTs pass server.rs do_post gates: loopback Host, per-launch x-hq-token, loopback Origin.

use crate::app::App;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub type Resp = (u16, Value);
pub const POSTS: &[&str] = &["/api/mcdesk/decide", "/api/mcdesk/message"];
pub const SOCK: &str = "desk.sock";
pub const RELAY: &str = "hq_notch_hook.py";
pub const NOTCH_MARKER: &str = "HQNotch/hq_notch_hook.py";
pub const DESK_MARKER: &str = "desk.sock";
pub const WATCH_SECS: u64 = 20;
pub const HOLD_SECS: u64 = 118;
const LINE_MAX: u64 = 1 << 20;

struct Pending {
    view: Value,
    session: String,
    reply: UnixStream,
}

pub struct Desk {
    pub root: PathBuf,
    pub settings: PathBuf,
    pending: Mutex<HashMap<u64, Pending>>,
    next: AtomicU64,
    watched: Mutex<Option<Instant>>,
    listening: Mutex<bool>,
}

fn home() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_default())
}

pub static DESK: LazyLock<Arc<Desk>> = LazyLock::new(|| {
    Desk::new(home().join("Library/Application Support/HQNotch"), home().join(".claude/settings.json"))
});

fn now() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0)
}

/// The hook command the user adds for PermissionRequest (timeout 120): the Notch relay, unchanged,
/// with its socket path pointed at the desk.
pub fn install_command(root: &std::path::Path) -> String {
    let relay = root.join(RELAY).display().to_string();
    let sock = root.join(SOCK).display().to_string();
    format!(
        "/usr/bin/python3 -c \"import importlib.util as u,sys;s=u.spec_from_file_location('r',{relay:?});m=u.module_from_spec(s);s.loader.exec_module(m);m.SOCKET_PATH={sock:?};sys.exit(m.main(sys.argv[1:]))\""
    )
}

/// The settings.json group to add under hooks.PermissionRequest.
pub fn install_entry(root: &std::path::Path) -> Value {
    json!({"matcher": "", "hooks": [{"type": "command", "command": install_command(root), "timeout": 120}]})
}

/// True when some hook command under hooks.<event> contains `marker`.
pub fn has_hook(settings: &Value, event: &str, marker: &str) -> bool {
    settings["hooks"][event].as_array().into_iter().flatten().any(|g| {
        g["hooks"].as_array().into_iter().flatten().any(|h| h["command"].as_str().is_some_and(|c| c.contains(marker)))
    })
}

/// Which hook messages the desk may hold: blocking PermissionRequest, not a question, a real
/// session id, and only while someone is watching the desk.
pub fn admissible(msg: &Value, watching: bool) -> bool {
    watching
        && msg["wantsReply"] == json!(true)
        && msg["event"] == "PermissionRequest"
        && msg["tool"]["tool"] != "AskUserQuestion"
        && msg["sessionId"].as_str().is_some_and(crate::app::is_uuid)
}

/// The exact reply line the Notch app sends (AppModel.allow / deny), never "always".
pub fn reply_for(decision: &str) -> Option<Value> {
    match decision {
        "allow" => Some(json!({"decision": "allow"})),
        "deny" => Some(json!({"decision": "deny", "message": "Denied from HQ Mission Control"})),
        _ => None,
    }
}

impl Desk {
    pub fn new(root: PathBuf, settings: PathBuf) -> Arc<Desk> {
        Arc::new(Desk {
            root,
            settings,
            pending: Mutex::new(HashMap::new()),
            next: AtomicU64::new(1),
            watched: Mutex::new(None),
            listening: Mutex::new(false),
        })
    }

    fn watching(&self) -> bool {
        self.watched.lock().unwrap().is_some_and(|t| t.elapsed() < Duration::from_secs(WATCH_SECS))
    }

    pub fn start(self: &Arc<Self>) -> Result<(), String> {
        let mut on = self.listening.lock().unwrap();
        if *on {
            return Ok(());
        }
        if !self.root.is_dir() {
            return Err("HQ Notch is not installed".into());
        }
        let path = self.root.join(SOCK);
        if path.exists() {
            if UnixStream::connect(&path).is_ok() {
                return Err("another HQ server is answering desk.sock".into());
            }
            let _ = std::fs::remove_file(&path);
        }
        let l = UnixListener::bind(&path).map_err(|e| e.to_string())?;
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
        let me = self.clone();
        std::thread::spawn(move || {
            for s in l.incoming().flatten() {
                let me = me.clone();
                std::thread::spawn(move || me.serve(s));
            }
        });
        *on = true;
        Ok(())
    }

    fn serve(&self, s: UnixStream) {
        let _ = s.set_read_timeout(Some(Duration::from_secs(5)));
        let Ok(rd) = s.try_clone() else { return };
        let mut r = BufReader::new(rd);
        let mut line = Vec::new();
        if (&mut r).take(LINE_MAX).read_until(b'\n', &mut line).is_err() {
            return;
        }
        let Ok(msg) = serde_json::from_slice::<Value>(&line) else { return };
        let mut w = s;
        if msg["wantsReply"] != json!(true) {
            return;
        }
        if !admissible(&msg, self.watching()) {
            let _ = w.write_all(b"{\"decision\":\"pass\"}\n");
            return;
        }
        let id = self.next.fetch_add(1, Ordering::SeqCst);
        let session = msg["sessionId"].as_str().unwrap_or("").to_string();
        let view = json!({"id": id, "sessionId": session, "tool": msg["tool"]["tool"], "target": msg["tool"]["target"],
            "input": msg["toolInput"], "cwd": msg["cwd"], "at": now()});
        self.pending.lock().unwrap().insert(id, Pending { view, session, reply: w });
        let _ = r.get_ref().set_read_timeout(Some(Duration::from_secs(HOLD_SECS)));
        let mut b = [0u8; 64];
        while let Ok(n) = r.read(&mut b) {
            if n == 0 {
                break;
            }
        }
        self.pending.lock().unwrap().remove(&id); // hook gave up or timed out: the terminal asks
    }

    pub fn view(self: &Arc<Self>, session: &str) -> Value {
        *self.watched.lock().unwrap() = Some(Instant::now());
        let started = self.start();
        let settings: Value = std::fs::read_to_string(&self.settings).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(json!({}));
        let notch = self.root.join(RELAY).is_file() && has_hook(&settings, "PermissionRequest", NOTCH_MARKER);
        let desk = self.root.join(RELAY).is_file() && has_hook(&settings, "PermissionRequest", DESK_MARKER);
        let mut reqs: Vec<Value> = self.pending.lock().unwrap().values()
            .filter(|p| session.is_empty() || p.session == session).map(|p| p.view.clone()).collect();
        reqs.sort_by_key(|v| v["id"].as_u64());
        json!({"notchHook": notch, "deskHook": desk, "listening": started.is_ok(),
            "error": started.err(),
            "install": {"steps": [
                "1. Install HQ Notch: python3 notch/tools/install.py",
                "2. In ~/.claude/settings.json add this group under hooks.PermissionRequest:"],
                "entry": install_entry(&self.root)},
            "requests": reqs,
            "message": {"supported": false, "reason": "Sending a message to a running session needs a delivery hook that is not installed in this build; nothing is typed into terminals."}})
    }

    pub fn decide(&self, id: u64, session: &str, decision: &str) -> Resp {
        let Some(reply) = reply_for(decision) else { return (400, json!({"error": "decision must be allow or deny"})) };
        let mut map = self.pending.lock().unwrap();
        if !map.get(&id).is_some_and(|p| p.session == session) {
            return (404, json!({"error": "that request is no longer waiting"}));
        }
        let mut p = map.remove(&id).unwrap();
        drop(map);
        let ok = p.reply.write_all(format!("{}\n", reply).as_bytes()).is_ok();
        let _ = p.reply.shutdown(std::net::Shutdown::Write);
        if ok { (200, json!({"ok": true, "decision": decision})) } else { (410, json!({"error": "the hook already gave up"})) }
    }
}

pub fn get_pending(_app: &App, arg: &dyn Fn(&str) -> String) -> Resp {
    (200, DESK.view(&arg("sessionId")))
}

pub fn post(path: &str, body: &Value) -> Resp {
    match path {
        "/api/mcdesk/decide" => {
            let id = body["id"].as_u64().unwrap_or(0);
            DESK.decide(id, body["sessionId"].as_str().unwrap_or(""), body["decision"].as_str().unwrap_or(""))
        }
        "/api/mcdesk/message" => (501, json!({"supported": false, "error": "unsupported",
            "reason": "no safe delivery mechanism is installed; HQ never types into terminals"})),
        _ => (404, json!({"error": "not found"})),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const SID: &str = "123e4567-e89b-12d3-a456-426614174000";

    fn hook_msg(tool: &str) -> String {
        format!("{}\n", json!({"v": 1, "event": "PermissionRequest", "sessionId": SID, "wantsReply": true,
            "tool": {"tool": tool, "target": "ls"}, "toolInput": {"command": "ls -la"}, "cwd": "/tmp"}))
    }

    fn ask(desk: &Arc<Desk>, tool: &str) -> (UnixStream, u64) {
        let mut c = UnixStream::connect(desk.root.join(SOCK)).unwrap();
        c.write_all(hook_msg(tool).as_bytes()).unwrap();
        for _ in 0..100 {
            let v = desk.view(SID);
            if let Some(id) = v["requests"][0]["id"].as_u64() {
                return (c, id);
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        (c, 0)
    }

    fn read_line(c: UnixStream) -> Value {
        let mut s = String::new();
        BufReader::new(c).read_line(&mut s).unwrap();
        serde_json::from_str(&s).unwrap()
    }

    #[test]
    fn allow_and_deny_round_trip() {
        let t = tempfile::tempdir().unwrap();
        let desk = Desk::new(t.path().to_path_buf(), t.path().join("settings.json"));
        let v = desk.view("");
        assert_eq!(v["listening"], true);
        assert_eq!(v["message"]["supported"], false);
        let (c, id) = ask(&desk, "Bash");
        assert!(id > 0);
        assert_eq!(desk.view(SID)["requests"][0]["input"]["command"], "ls -la");
        assert_eq!(desk.decide(id, "other", "allow").0, 404);
        assert_eq!(desk.decide(id, SID, "always").0, 400);
        assert_eq!(desk.decide(id, SID, "allow").0, 200);
        assert_eq!(read_line(c), json!({"decision": "allow"}));
        let (c, id) = ask(&desk, "Bash");
        assert_eq!(desk.decide(id, SID, "deny").0, 200);
        assert_eq!(read_line(c)["decision"], "deny");
        assert_eq!(desk.decide(id, SID, "allow").0, 404);
    }

    #[test]
    fn questions_and_unwatched_pass() {
        let msg: Value = serde_json::from_str(&hook_msg("Bash")).unwrap();
        assert!(admissible(&msg, true));
        assert!(!admissible(&msg, false));
        let q: Value = serde_json::from_str(&hook_msg("AskUserQuestion")).unwrap();
        assert!(!admissible(&q, true));
        let t = tempfile::tempdir().unwrap();
        let desk = Desk::new(t.path().to_path_buf(), t.path().join("settings.json"));
        desk.view("");
        let mut c = UnixStream::connect(t.path().join(SOCK)).unwrap();
        c.write_all(hook_msg("AskUserQuestion").as_bytes()).unwrap();
        assert_eq!(read_line(c), json!({"decision": "pass"}));
    }

    #[test]
    fn hook_detection() {
        let root = PathBuf::from("/x/HQNotch");
        let s = json!({"hooks": {"PermissionRequest": [install_entry(&root)]}});
        assert!(has_hook(&s, "PermissionRequest", DESK_MARKER));
        assert!(has_hook(&s, "PermissionRequest", NOTCH_MARKER));
        assert!(!has_hook(&json!({}), "PermissionRequest", DESK_MARKER));
        assert_eq!(post("/api/mcdesk/message", &json!({})).0, 501);
    }
}
