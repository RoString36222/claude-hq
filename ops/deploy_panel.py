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
ARENA_DIR = os.environ.get("ARENA_DIR", "/repo")
ARENA_DOMAIN = os.environ.get("ARENA_DOMAIN", "")
PANEL_BASE_URL = os.environ.get("PANEL_BASE_URL", "")
DEPLOY_LOG = os.environ.get("ARENA_DEPLOY_LOG", "/repo/.arena-deploy.log")
BRANCH = os.environ.get("ARENA_BRANCH", "main")
HEALTH_URL = os.environ.get("ARENA_HEALTH_URL", "http://app:8080/health")

CLIENT_ID = os.environ.get("PANEL_GITHUB_CLIENT_ID", "")
CLIENT_SECRET = os.environ.get("PANEL_GITHUB_CLIENT_SECRET", "")
SECRET_KEY = os.environ.get("PANEL_SECRET_KEY", "")
ALLOWED = {u.strip().lower() for u in os.environ.get("PANEL_ALLOWED_USERS", "").split(",") if u.strip()}

SESSION_TTL = 12 * 3600
COOKIE = "arena_panel"


def _sign(payload: str) -> str:
    mac = hmac.new(SECRET_KEY.encode(), payload.encode(), hashlib.sha256).hexdigest()
    return f"{payload}.{mac}"


def _verify(token: str, purpose: str = "") -> str | None:
    """Check a signed token, optionally requiring a purpose prefix.

    Purpose-bound tokens carry "<purpose>:" *inside* the signed payload, so a
    session cookie cannot be replayed as a CSRF token or the reverse. The
    prefix therefore has to stay in the string the MAC is verified against --
    stripping it before calling here is what made every CSRF check fail.
    """
    try:
        payload, mac = token.rsplit(".", 1)
        login, exp = payload.split("|", 1)
    except ValueError:
        return None
    if not hmac.compare_digest(mac, hmac.new(SECRET_KEY.encode(), payload.encode(), hashlib.sha256).hexdigest()):
        return None
    if float(exp) < time.time():
        return None
    if purpose:
        want = purpose + ":"
        if not login.startswith(want):
            return None
        login = login[len(want):]
    elif ":" in login:
        # An unprefixed call must not accept a purpose-bound token.
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
    # Reached over the compose network by service name, not 127.0.0.1: the
    # panel runs in its own container, so loopback is the panel itself (:8090)
    # and never the app. The app is `expose`d, not published, so it has no
    # host port either -- a loopback probe cannot succeed in either layout.
    code, _ = run(["curl", "-fsS", "--max-time", "5", HEALTH_URL], timeout=15)
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


PAGE = """<!doctype html><meta charset="utf-8"><title>ARENA // DEPLOY CONTROL</title>
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<style>
 /* Tactical telemetry: a deploy console, not a product page. Dark substrate,
    monospace telemetry, one hazard red, 90-degree corners everywhere. System
    font stacks only -- this box has no network and no build step, so a webfont
    would simply fail to arrive. */
 :root{color-scheme:dark;
   --bg:#0a0a0a;--panel:#121212;--line:#2a2a2a;--ink:#eaeaea;--dim:#8a8a8a;
   --red:#e61919;--green:#4af626;
   --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;
   --sans:system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
 *{box-sizing:border-box;border-radius:0}
 html{background:var(--bg)}
 body{margin:0;background:var(--bg);color:var(--ink);padding:0;
   font:13px/1.35 var(--mono);letter-spacing:.06em;text-transform:uppercase}
 /* Mechanical grain and a CRT sweep. Both inert overlays: pointer-events none,
    aria-hidden, and no layout cost. The noise is an inline data URI, not a
    fetch. */
 .grain,.scan{position:fixed;inset:0;pointer-events:none;z-index:9}
 .grain{opacity:.035;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.82' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='120' height='120' filter='url(%23n)'/%3E%3C/svg%3E")}
 /* A sweep you notice only on a flat field. At .22 it greyed the telemetry
    it lies over, which is the one thing on the page that must stay legible. */
 .scan{opacity:.5;background:repeating-linear-gradient(0deg,transparent,transparent 3px,rgba(0,0,0,.12) 3px,rgba(0,0,0,.12) 4px)}
 @media (prefers-reduced-motion:reduce){.scan{display:none}}
 .wrap{max-width:60rem;margin:0 auto;padding:clamp(14px,3vw,34px);position:relative;z-index:1}

 /* Masthead: macro type against dense metadata. */
 .masthead{display:grid;grid-template-columns:1fr auto;gap:18px;align-items:end;
   border-bottom:2px solid var(--ink);padding-bottom:10px}
 h1{font:900 clamp(2.9rem,13vw,8rem)/.84 var(--sans);letter-spacing:-.045em;
   margin:0;text-transform:uppercase}
 /* Inherits 900 otherwise, which fills the glyph's counter in and reads as a
    missing-character box rather than a mark. */
 h1 .reg{font-weight:400;font-size:.15em;vertical-align:super;letter-spacing:0;
   margin-left:.12em;color:var(--dim)}
 .sub{margin:6px 0 0;color:var(--dim);font-size:10.5px;letter-spacing:.14em}
 .ident{margin:0;display:grid;grid-template-columns:auto auto;gap:2px 10px;
   font-size:10.5px;letter-spacing:.1em;text-align:right}
 .ident dt{color:var(--dim)}
 .ident dd{margin:0}

 /* Grid determinism: a 1px gap over a line-coloured parent draws the hairlines,
    so no child needs a border of its own. */
 /* Three explicit columns, not auto-fit: auto-fit sizes tracks to the
    container and would open a fourth, empty one at wide viewports -- a dead
    lit panel in a console that is meant to read as fully populated. */
 .bay{margin:22px 0 0;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));
   gap:1px;background:var(--line);border:1px solid var(--line)}
 @media (max-width:46rem){.bay{grid-template-columns:1fr}}
 .cell{background:var(--panel);padding:13px 14px;min-height:4.6rem;
   display:flex;flex-direction:column;justify-content:space-between;gap:8px}
 .cell.wide{grid-column:1/-1}
 .cell dt{color:var(--dim);font-size:10px;letter-spacing:.16em}
 .cell dd{margin:0;font-size:15px;letter-spacing:.02em}
 .cell samp{font:inherit;font-size:15px}
 .subj{font-size:12px;letter-spacing:.04em;text-transform:none;line-height:1.4}
 .age{color:var(--dim);font-size:10.5px;text-transform:uppercase;letter-spacing:.12em}
 .dot{display:inline-block;width:7px;height:7px;margin-right:9px;vertical-align:.08em}
 /* Terminal green is spent here and nowhere else: one indicator, the one fact
    an operator opens this page to read. */
 .dot.up{background:var(--green)}
 .dot.down{background:var(--red)}
 .health.up{color:var(--green)}
 .health.down{color:var(--red)}
 .alert dd{color:var(--red)}
 .pending{margin:8px 0 0;max-height:7rem}

 /* Controls: ASCII framing from CSS so the brackets stay decorative and out of
    the accessible name. */
 .actions{display:flex;flex-wrap:wrap;gap:1px;background:var(--line);
   border:1px solid var(--line);border-top:0}
 .act{flex:1 1 11rem;font:inherit;font-size:12px;letter-spacing:.14em;
   padding:15px 12px;border:0;background:var(--panel);color:var(--ink);
   cursor:pointer;text-transform:uppercase}
 .act::before{content:"[ ";color:var(--dim)}
 .act::after{content:" ]";color:var(--dim)}
 .act:hover:not(:disabled){background:var(--ink);color:var(--bg)}
 .act:hover:not(:disabled)::before,.act:hover:not(:disabled)::after{color:var(--bg)}
 .act:focus-visible{outline:2px solid var(--red);outline-offset:-4px}
 .act.primary{color:var(--red)}
 .act.primary:hover:not(:disabled){background:var(--red);color:var(--bg)}
 .act:disabled{color:#555;cursor:not-allowed}
 .act:disabled::before,.act:disabled::after{color:#3a3a3a}

 /* Section rules that span the container, per the blueprint grid. */
 h2{display:flex;align-items:center;gap:12px;font-size:10px;letter-spacing:.2em;
   color:var(--dim);margin:26px 0 0;font-weight:400}
 h2 .rule{flex:1;height:1px;background:var(--line)}
 pre{background:var(--panel);border:1px solid var(--line);margin:8px 0 0;
   padding:13px;overflow:auto;max-height:22rem;font:11.5px/1.5 var(--mono);
   color:#b9c0c6;letter-spacing:.02em;text-transform:none;white-space:pre-wrap}
 .msg{display:none;margin-top:18px;padding:12px 14px;font-size:11.5px;
   letter-spacing:.12em;border-left:3px solid var(--line);background:var(--panel)}
 .msg.show{display:block}
 .msg.ok{border-left-color:var(--green);color:var(--green)}
 .msg.err{border-left-color:var(--red);color:var(--red)}
 .foot{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;
   margin-top:26px;padding-top:10px;border-top:1px solid var(--line);
   color:var(--dim);font-size:10px;letter-spacing:.18em}

 /* A grid track's default min-width is auto, so a long commit subject or a
    wide log line pushes the whole console past the viewport instead of
    wrapping. This page gets opened on a phone mid-incident, and a horizontal
    scrollbar over telemetry is the worst time to meet one. */
 .cell,.masthead>*{min-width:0}
 .subj,samp,pre{overflow-wrap:anywhere}
 @media (max-width:34rem){
   .masthead{grid-template-columns:1fr;align-items:start;gap:10px}
   .ident{text-align:left;grid-template-columns:auto 1fr;gap:2px 14px}
   .act{flex:1 1 100%}
 }
</style>
<div class="grain" aria-hidden="true"></div>
<div class="scan" aria-hidden="true"></div>
<main class="wrap">
 <header class="masthead">
  <div>
   <h1>Deploy<span class="reg">&reg;</span></h1>
   <p class="sub">/// arena control surface &middot; unit __DOMAIN__</p>
  </div>
  <dl class="ident">
   <dt>operator</dt><dd>__WHO__</dd>
   <dt>branch</dt><dd>__BRANCH__</dd>
  </dl>
 </header>

 <output class="msg" id="msg"></output>

 <dl class="bay">
  <div class="cell">
   <dt>service</dt>
   <dd><i class="dot __DOTCLS__"></i><span class="health __DOTCLS__">__HEALTH__</span></dd>
  </div>
  <div class="cell"><dt>running</dt><dd><samp>__LOCAL__</samp></dd></div>
  <div class="cell"><dt>head &middot; __BRANCH__</dt><dd><samp>__REMOTE__</samp></dd></div>
  <div class="cell wide"><dt>last commit</dt>
   <dd class="subj">__SUBJECT__ <span class="age">__WHEN__</span></dd></div>
  __BEHIND__
 </dl>

 <nav class="actions">
  <button class="act primary" id="deploy" __DISABLED__>deploy latest</button>
  <button class="act" id="rollback">roll back one</button>
  <button class="act" id="refresh">refresh</button>
 </nav>

 <h2>deploy log <span class="rule"></span> tail 40</h2>
 <pre id="log">__LOG__</pre>

 <footer class="foot"><span>+ arena deploy</span><span>rev 2.1</span><span>__DOMAIN__</span></footer>
</main>
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
  if(confirm("Roll back to the previous release?"))act("/api/rollback");};
document.getElementById("refresh").onclick=function(){location.reload();};
</script>
"""


def render(login, csrf):
    s = status()
    behind = ""
    if s["behind"]:
        # Inside the <dl>, so it has to be a dt/dd group: a bare <pre> there
        # would not be valid markup.
        behind = ('<div class="cell wide alert"><dt>pending</dt>'
                  f'<dd>&uarr; {s["behind"]} commit(s) not deployed'
                  f'<pre class="pending">{html.escape(s["pending"])}</pre></dd></div>')
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
        if not token or _verify(token, "csrf") != login:
            return self._json(403, {"ok": False, "error": "bad CSRF token"})

        path = self.path.split("?", 1)[0]
        if path == "/api/deploy":
            rc, out = run(["bash", f"{ARENA_DIR}/ops/autodeploy.sh"], timeout=900)
            return self._json(200, {"ok": rc == 0,
                                    "message": "Deployed" if rc == 0 else "Deploy failed — rolled back",
                                    "error": None if rc == 0 else out[-400:]})
        if path == "/api/rollback":
            # Delegated, like /api/deploy. This used to `git reset --hard HEAD~1`
            # and rebuild with a bare `docker compose`, which had two problems:
            # compose reads only backend/.env, so it rebuilt as the PYTHON Arena
            # whatever was actually released, and a rebuild of the previous
            # commit is not the previous release -- ops/release.sh restores an
            # earlier stamped IMAGE without rebuilding, which is both faster and
            # the only version that is known to have been healthy.
            rc, out = run(["bash", f"{ARENA_DIR}/ops/release.sh", "rollback"], timeout=900)
            return self._json(200, {"ok": rc == 0,
                                    "message": "Rolled back" if rc == 0 else "Rollback failed",
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
    # In a container with no published port, Docker provides the isolation and
    # binding all interfaces is correct. On a host it is not, so the refusal
    # stands unless the container image explicitly says otherwise.
    in_container = os.environ.get("PANEL_IN_CONTAINER") == "1"
    if not in_container and not (
        BIND.startswith("127.") or BIND.startswith("172.")
        or BIND.startswith("10.") or BIND.startswith("192.168.")
    ):
        raise SystemExit(f"refusing to bind {BIND}: panel must not listen on a public interface")
    print(f"deploy panel on {BIND}:{PORT}; allowed: {', '.join(sorted(ALLOWED))}", flush=True)
    ThreadingHTTPServer((BIND, PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
