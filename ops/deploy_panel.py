"""
Arena deploy panel — a small control surface for a self-hosted instance.

Deliberate choices:

  * Stdlib only. This runs on the HOST, not in a container, because it drives
    git and docker compose. Adding a venv and dependencies to a box whose whole
    job is running containers is the wrong trade, and a smaller dependency
    surface on the thing that can execute deploys is worth the extra code.

  * Binds the loopback or the Docker bridge gateway only -- never a public
    interface. Caddy terminates TLS and proxies to it.

  * There is no free-form command input. Actions are a fixed set, so a bug in
    request parsing cannot become arbitrary execution.

  * Access is a hardcoded allowlist of GitHub logins checked on EVERY request,
    not just at login -- removing someone from the list logs them out at once
    rather than whenever their cookie happens to expire.
"""
import hashlib
import hmac
import html
import http.cookies
import json
import os
import secrets
import subprocess
import time
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("PANEL_PORT", "8090"))
# Caddy runs in a container, so 127.0.0.1 on the host is unreachable to it.
# The installer sets this to the Docker bridge gateway (e.g. 172.17.0.1),
# which containers and the host can reach but nothing outside can.
BIND = os.environ.get("PANEL_BIND", "127.0.0.1")
ARENA_DIR = os.environ.get("ARENA_DIR", "/root/claude-hq")
ARENA_DOMAIN = os.environ.get("ARENA_DOMAIN", "")
PANEL_BASE_URL = os.environ.get("PANEL_BASE_URL", "")
DEPLOY_LOG = os.environ.get("ARENA_DEPLOY_LOG", "/var/log/arena-deploy.log")
BRANCH = os.environ.get("ARENA_BRANCH", "main")

CLIENT_ID = os.environ.get("PANEL_GITHUB_CLIENT_ID", "")
CLIENT_SECRET = os.environ.get("PANEL_GITHUB_CLIENT_SECRET", "")
SECRET_KEY = os.environ.get("PANEL_SECRET_KEY", "")
ALLOWED = {u.strip().lower() for u in os.environ.get("PANEL_ALLOWED_USERS", "").split(",") if u.strip()}

SESSION_TTL = 12 * 3600
COOKIE = "arena_panel"


def _sign(payload: str) -> str:
    mac = hmac.new(SECRET_KEY.encode(), payload.encode(), hashlib.sha256).hexdigest()
    return f"{payload}.{mac}"


def _verify(token: str) -> str | None:
    try:
        payload, mac = token.rsplit(".", 1)
        login, exp = payload.split("|", 1)
    except ValueError:
        return None
    if not hmac.compare_digest(mac, hmac.new(SECRET_KEY.encode(), payload.encode(), hashlib.sha256).hexdigest()):
        return None
    if float(exp) < time.time():
        return None
    # Re-checked on every request: removing a login revokes access immediately.
    return login if login.lower() in ALLOWED else None


def run(args, cwd=None, timeout=600):
    p = subprocess.run(args, cwd=cwd, capture_output=True, text=True, timeout=timeout)
    return p.returncode, (p.stdout + p.stderr).strip()


def git(*args):
    return run(["git", *args], cwd=ARENA_DIR)[1]


def status():
    run(["git", "fetch", "origin", BRANCH, "--quiet"], cwd=ARENA_DIR, timeout=60)
    local = git("rev-parse", "HEAD")[:7]
    remote = git("rev-parse", f"origin/{BRANCH}")[:7]
    behind = git("rev-list", "--count", f"HEAD..origin/{BRANCH}") or "0"
    pending = git("log", "--oneline", f"HEAD..origin/{BRANCH}") if behind != "0" else ""
    code, _ = run(["curl", "-fsS", "--max-time", "5", "http://127.0.0.1:8080/health"], timeout=15)
    try:
        with open(DEPLOY_LOG) as f:
            log = "".join(f.readlines()[-40:])
    except OSError:
        log = "(no deploy log yet)"
    return {
        "local": local, "remote": remote, "behind": int(behind or 0),
        "pending": pending, "healthy": code == 0,
        "subject": git("log", "-1", "--pretty=%s"),
        "when": git("log", "-1", "--pretty=%cr"),
        "log": log,
    }


PAGE = """<!doctype html><meta charset="utf-8"><title>Arena Deploy</title>
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<style>
 :root{color-scheme:dark;--bg:#0e1117;--card:#161b22;--line:#30363d;--ink:#e6edf3;
   --muted:#8b949e;--ok:#3fb950;--bad:#f85149;--accent:#58a6ff}
 *{box-sizing:border-box}
 body{margin:0;background:var(--bg);color:var(--ink);padding:16px;
   font:14px/1.55 ui-sans-serif,-apple-system,Segoe UI,Roboto,sans-serif}
 .wrap{max-width:46rem;margin:0 auto}
 h1{font-size:19px;margin:0 0 4px}
 .who{color:var(--muted);font-size:12.5px;margin-bottom:18px}
 .card{background:var(--card);border:1px solid var(--line);border-radius:10px;
   padding:16px;margin-bottom:14px}
 .row{display:flex;justify-content:space-between;gap:12px;padding:5px 0;flex-wrap:wrap}
 .row span:first-child{color:var(--muted)}
 code{font:13px ui-monospace,SFMono-Regular,Menlo,monospace}
 .dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px}
 .up{background:var(--ok)}.down{background:var(--bad)}
 .behind{color:var(--accent);font-weight:600}
 button{font:inherit;font-weight:600;padding:9px 16px;border-radius:7px;
   border:1px solid var(--line);background:#21262d;color:var(--ink);cursor:pointer}
 button.primary{background:var(--accent);border-color:var(--accent);color:#0b1117}
 button:disabled{opacity:.5;cursor:not-allowed}
 .actions{display:flex;gap:9px;flex-wrap:wrap;margin-top:6px}
 pre{background:#0b0f14;border:1px solid var(--line);border-radius:8px;padding:12px;
   overflow:auto;max-height:22rem;font:12px ui-monospace,Menlo,monospace;color:#9fb1c1}
 .msg{padding:9px 12px;border-radius:7px;margin-bottom:12px;font-size:13px;display:none}
 .msg.show{display:block}.msg.ok{background:#12261a;color:var(--ok)}
 .msg.err{background:#2d1618;color:var(--bad)}
</style>
<div class="wrap">
 <h1>Arena Deploy</h1>
 <div class="who">__WHO__ &middot; __DOMAIN__</div>
 <div class="msg" id="msg"></div>
 <div class="card">
  <div class="row"><span>service</span><span><i class="dot __DOTCLS__"></i>__HEALTH__</span></div>
  <div class="row"><span>running</span><code>__LOCAL__</code></div>
  <div class="row"><span>latest on __BRANCH__</span><code>__REMOTE__</code></div>
  <div class="row"><span>last commit</span><span>__SUBJECT__ <span style="color:var(--muted)">__WHEN__</span></span></div>
  __BEHIND__
  <div class="actions">
   <button class="primary" id="deploy" __DISABLED__>Deploy latest</button>
   <button id="rollback">Roll back one</button>
   <button id="refresh">Refresh</button>
  </div>
 </div>
 <div class="card"><div style="color:var(--muted);margin-bottom:8px">deploy log</div><pre id="log">__LOG__</pre></div>
</div>
<script>
var CSRF="__CSRF__";
function msg(t,cls){var m=document.getElementById("msg");m.textContent=t;m.className="msg show "+cls;}
function act(path,btn){
  var bs=document.querySelectorAll("button");bs.forEach(function(b){b.disabled=true;});
  msg("Working\\u2026","ok");
  fetch(path,{method:"POST",headers:{"X-Panel-Token":CSRF}})
   .then(function(r){return r.json();})
   .then(function(j){
     msg(j.ok?(j.message||"Done"):(j.error||"Failed"), j.ok?"ok":"err");
     setTimeout(function(){location.reload();},1800);
   })
   .catch(function(){msg("Request failed","err");bs.forEach(function(b){b.disabled=false;});});
}
document.getElementById("deploy").onclick=function(){act("/api/deploy");};
document.getElementById("rollback").onclick=function(){
  if(confirm("Roll back to the previous commit and rebuild?"))act("/api/rollback");};
document.getElementById("refresh").onclick=function(){location.reload();};
</script>
"""


def render(login, csrf):
    s = status()
    behind = ""
    if s["behind"]:
        behind = ('<div class="row"><span>pending</span><span class="behind">'
                  f'&uarr; {s["behind"]} commit(s) not deployed</span></div>'
                  f'<pre style="max-height:8rem">{html.escape(s["pending"])}</pre>')
    return (PAGE
            .replace("__WHO__", html.escape(login))
            .replace("__DOMAIN__", html.escape(ARENA_DOMAIN or "arena"))
            .replace("__BRANCH__", html.escape(BRANCH))
            .replace("__HEALTH__", "healthy" if s["healthy"] else "not responding")
            .replace("__DOTCLS__", "up" if s["healthy"] else "down")
            .replace("__LOCAL__", html.escape(s["local"]))
            .replace("__REMOTE__", html.escape(s["remote"]))
            .replace("__SUBJECT__", html.escape(s["subject"][:70]))
            .replace("__WHEN__", html.escape(s["when"]))
            .replace("__BEHIND__", behind)
            .replace("__DISABLED__", "" if s["behind"] else "disabled")
            .replace("__LOG__", html.escape(s["log"]))
            .replace("__CSRF__", csrf))


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body, ctype="text/html; charset=utf-8", cookie=None):
        data = body.encode() if isinstance(body, str) else body
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        if cookie:
            self.send_header("Set-Cookie", cookie)
        self.end_headers()
        self.wfile.write(data)

    def _json(self, code, obj):
        self._send(code, json.dumps(obj), "application/json")

    def _login(self):
        raw = self.headers.get("Cookie", "")
        if not raw:
            return None
        jar = http.cookies.SimpleCookie()
        jar.load(raw)
        c = jar.get(COOKIE)
        return _verify(c.value) if c else None

    def _csrf(self, login):
        return _sign(f"csrf:{login}|{time.time() + SESSION_TTL}")

    # --- GET ---------------------------------------------------------------
    def do_GET(self):
        path = self.path.split("?", 1)[0]

        if path == "/auth/login":
            if not CLIENT_ID:
                return self._send(503, "<p>PANEL_GITHUB_CLIENT_ID is not set on the server.</p>")
            state = _sign(f"state:{secrets.token_hex(8)}|{time.time() + 600}")
            q = urllib.parse.urlencode({
                "client_id": CLIENT_ID,
                "redirect_uri": f"{PANEL_BASE_URL}/auth/callback",
                "scope": "read:user",
                "state": state,
            })
            self.send_response(302)
            self.send_header("Location", "https://github.com/login/oauth/authorize?" + q)
            self.end_headers()
            return

        if path == "/auth/callback":
            qs = urllib.parse.parse_qs(self.path.split("?", 1)[1] if "?" in self.path else "")
            code = (qs.get("code") or [""])[0]
            state = (qs.get("state") or [""])[0]
            if not code or not state or not state.startswith("state:"):
                return self._send(400, "<p>Bad callback.</p>")
            try:
                payload, mac = state.rsplit(".", 1)
                if not hmac.compare_digest(
                    mac, hmac.new(SECRET_KEY.encode(), payload.encode(), hashlib.sha256).hexdigest()
                ) or float(payload.split("|", 1)[1]) < time.time():
                    return self._send(400, "<p>Expired or invalid state.</p>")
            except Exception:
                return self._send(400, "<p>Invalid state.</p>")

            login = self._exchange(code)
            if login is None:
                return self._send(502, "<p>GitHub sign-in failed.</p>")
            if login.lower() not in ALLOWED:
                return self._send(403, f"<p><b>{html.escape(login)}</b> is not on the allowlist.</p>")

            token = _sign(f"{login}|{time.time() + SESSION_TTL}")
            c = f"{COOKIE}={token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age={SESSION_TTL}"
            self.send_response(302)
            self.send_header("Location", "/")
            self.send_header("Set-Cookie", c)
            self.end_headers()
            return

        if path == "/auth/logout":
            self.send_response(302)
            self.send_header("Location", "/")
            self.send_header("Set-Cookie", f"{COOKIE}=; Path=/; Max-Age=0")
            self.end_headers()
            return

        login = self._login()
        if not login:
            return self._send(200,
                '<!doctype html><meta charset="utf-8"><title>Arena Deploy</title>'
                '<body style="background:#0e1117;color:#e6edf3;font-family:system-ui;'
                'display:grid;place-items:center;height:100vh;margin:0">'
                '<div style="text-align:center"><h1>Arena Deploy</h1>'
                '<p style="color:#8b949e">Restricted to the maintainers.</p>'
                '<a href="/auth/login" style="display:inline-block;margin-top:10px;padding:10px 18px;'
                'background:#58a6ff;color:#0b1117;border-radius:7px;text-decoration:none;'
                'font-weight:600">Sign in with GitHub</a></div>')

        if path == "/":
            return self._send(200, render(login, self._csrf(login)))
        self._send(404, "<p>Not found.</p>")

    def _exchange(self, code):
        try:
            data = urllib.parse.urlencode({
                "client_id": CLIENT_ID, "client_secret": CLIENT_SECRET,
                "code": code, "redirect_uri": f"{PANEL_BASE_URL}/auth/callback",
            }).encode()
            req = urllib.request.Request("https://github.com/login/oauth/access_token", data=data)
            req.add_header("Accept", "application/json")
            with urllib.request.urlopen(req, timeout=20) as r:
                tok = json.loads(r.read().decode()).get("access_token")
            if not tok:
                return None
            req = urllib.request.Request("https://api.github.com/user")
            req.add_header("Authorization", f"Bearer {tok}")
            req.add_header("Accept", "application/vnd.github+json")
            with urllib.request.urlopen(req, timeout=20) as r:
                return json.loads(r.read().decode()).get("login")
        except Exception:
            return None

    # --- POST --------------------------------------------------------------
    def do_POST(self):
        login = self._login()
        if not login:
            return self._json(401, {"ok": False, "error": "not signed in"})
        token = self.headers.get("X-Panel-Token", "")
        if not token or _verify(token.replace("csrf:", "", 1)) != login:
            return self._json(403, {"ok": False, "error": "bad CSRF token"})

        path = self.path.split("?", 1)[0]
        if path == "/api/deploy":
            rc, out = run(["bash", f"{ARENA_DIR}/ops/autodeploy.sh"], timeout=900)
            return self._json(200, {"ok": rc == 0,
                                    "message": "Deployed" if rc == 0 else "Deploy failed — rolled back",
                                    "error": None if rc == 0 else out[-400:]})
        if path == "/api/rollback":
            prev = git("rev-parse", "HEAD~1")[:7]
            run(["git", "reset", "--hard", "HEAD~1", "--quiet"], cwd=ARENA_DIR)
            rc, out = run(["docker", "compose", "up", "-d", "--build"],
                          cwd=f"{ARENA_DIR}/backend", timeout=900)
            return self._json(200, {"ok": rc == 0,
                                    "message": f"Rolled back to {prev}",
                                    "error": None if rc == 0 else out[-400:]})
        self._json(404, {"ok": False, "error": "unknown action"})

    def log_message(self, *a):
        return


def main():
    missing = [n for n, v in [("PANEL_SECRET_KEY", SECRET_KEY),
                              ("PANEL_GITHUB_CLIENT_ID", CLIENT_ID),
                              ("PANEL_GITHUB_CLIENT_SECRET", CLIENT_SECRET),
                              ("PANEL_BASE_URL", PANEL_BASE_URL)] if not v]
    if missing:
        raise SystemExit("missing required env: " + ", ".join(missing))
    if not ALLOWED:
        raise SystemExit("PANEL_ALLOWED_USERS is empty — refusing to start with no allowlist")
    if not (BIND.startswith("127.") or BIND.startswith("172.") or BIND.startswith("10.")
            or BIND.startswith("192.168.")):
        raise SystemExit(f"refusing to bind {BIND}: panel must not listen on a public interface")
    print(f"deploy panel on {BIND}:{PORT}; allowed: {', '.join(sorted(ALLOWED))}", flush=True)
    ThreadingHTTPServer((BIND, PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
