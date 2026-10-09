"""Loot from real work (HQ 2.5): the local reporter and the page's proxy routes.

A merged PR, a green test run or a long focus session drops a chest on the
Arena. They are detected HERE, on this machine, and the only thing that leaves
it is {requestId, type, n, day}: the event TYPE, a small count and a UTC day.

  * tests_green / focus_long come from worksignals.day_counts() (the skill-tree
    feature's scan); without it only PRs report.
  * PRs are counted by running `gh` locally, and only when the user turned on
    BOTH workSignals and workSignalsPRs. Each PR url is hashed with a local salt
    and kept only as that hash, to tell new merges from ones already counted.
    Titles, urls, repos and numbers never leave the machine (gh is asked for the
    url alone, and the url never leaves this process).
  * The first PR scan only records what is already merged (no backfill burst).

State lives in loot-state.json (0600, git-ignored):
    {salt, seen:[<=500 hashes] | absent before the first scan,
     prs:{day:count}, sent:{type:{day:count}}}
with days older than KEEP_DAYS pruned. A 2xx or 4xx answer marks a delta sent
(never retried); 5xx and network errors are retried next cycle.

Stdlib only, like the rest of the local HQ.
"""
import hashlib
import json
import os
import re
import secrets
import shutil
import subprocess
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone

import arena

try:
    import worksignals
except Exception:  # the skill-tree feature is optional
    worksignals = None

TYPES = ("pr_merged", "tests_green", "focus_long")
INTERVAL_SECS = 1800
FIRST_DELAY_SECS = 90
GH_TIMEOUT_SECS = 20
GH_LIMIT = 50
PR_WINDOW_DAYS = 7
SEEN_MAX = 500
KEEP_DAYS = 3
MAX_N = 5
STATE_NAME = "loot-state.json"
_CHEST_RE = re.compile(r"^ch-[0-9a-f]{32}$")
_RID_RE = re.compile(r"^[A-Za-z0-9_-]{16,64}$")

# Swappable in tests.
_run = subprocess.run
_which = shutil.which
_load_config = None
_base_dir = os.path.dirname(os.path.abspath(__file__))

_lock = threading.Lock()
_last = {"report": None}
_thread = None


def _cfg():
    try:
        return (_load_config() if _load_config else {}) or {}
    except Exception:
        return {}


def _state_path():
    return os.path.join(_base_dir, STATE_NAME)


def _today():
    return datetime.now(timezone.utc).date()


def load_state():
    """The reporter's state, self-healing: a missing or corrupt file starts over
    (with a fresh salt and, so, a fresh no-backfill baseline)."""
    try:
        with open(_state_path(), "r", encoding="utf-8") as f:
            st = json.load(f)
        if not isinstance(st, dict):
            st = {}
    except Exception:
        st = {}
    if not isinstance(st.get("salt"), str) or len(st["salt"]) < 16:
        st = {"salt": secrets.token_hex(16)}
    if "seen" in st and not isinstance(st["seen"], list):
        st.pop("seen")
    for k in ("prs", "sent"):
        if not isinstance(st.get(k), dict):
            st[k] = {}
    for t in list(st["sent"]):
        if t not in TYPES or not isinstance(st["sent"][t], dict):
            st["sent"].pop(t)
    return st


def save_state(st):
    path = _state_path()
    tmp = path + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(st, f)
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def _prune(st, today):
    keep = (today - timedelta(days=KEEP_DAYS)).isoformat()
    st["prs"] = {d: n for d, n in st["prs"].items() if isinstance(d, str) and d >= keep}
    for t in st["sent"]:
        st["sent"][t] = {d: n for d, n in st["sent"][t].items() if isinstance(d, str) and d >= keep}


def _hash(salt, url):
    return hashlib.sha256((salt + "|" + url).encode("utf-8")).hexdigest()[:24]


def gh_available():
    try:
        return bool(_which("gh"))
    except Exception:
        return False


def scan_prs(st, today):
    """Count newly merged PRs (by salted url hash) onto today's tally. Returns
    how many were new, or None when gh failed (nothing is recorded then)."""
    since = (today - timedelta(days=PR_WINDOW_DAYS)).isoformat()
    try:
        r = _run(["gh", "search", "prs", "--author=@me", "--merged",
                  "--merged-at", ">=" + since, "--json", "url", "--limit", str(GH_LIMIT)],
                 capture_output=True, text=True, timeout=GH_TIMEOUT_SECS)
    except Exception:
        return None
    if getattr(r, "returncode", 1) != 0:
        return None
    try:
        rows = json.loads(r.stdout or "[]")
    except Exception:
        return None
    if not isinstance(rows, list):
        return None
    hashes = []
    for row in rows:
        url = row.get("url") if isinstance(row, dict) else None
        if isinstance(url, str) and url:
            hashes.append(_hash(st["salt"], url))
    if "seen" not in st:
        # First run: what is merged already is the baseline, not loot.
        st["seen"] = hashes[-SEEN_MAX:]
        return 0
    seen = set(st["seen"])
    new = [h for h in dict.fromkeys(hashes) if h not in seen]
    if new:
        st["seen"] = (st["seen"] + new)[-SEEN_MAX:]
        day = today.isoformat()
        st["prs"][day] = int(st["prs"].get(day, 0)) + len(new)
    return len(new)


def _ws_counts(days):
    """worksignals.day_counts, whatever its argument shape; {} when absent."""
    fn = getattr(worksignals, "day_counts", None) if worksignals else None
    if not callable(fn):
        return {}
    for arg in (len(days), list(days)):
        try:
            out = fn(arg)
            return out if isinstance(out, dict) else {}
        except TypeError:
            continue
        except Exception:
            return {}
    return {}


def local_counts(st, today):
    """{type: {day: cumulative count}} for today and yesterday (the only days
    the Arena accepts)."""
    days = [(today - timedelta(days=1)).isoformat(), today.isoformat()]
    ws = _ws_counts(days)
    out = {t: {} for t in TYPES}
    for d in days:
        row = ws.get(d) if isinstance(ws.get(d), dict) else {}
        for t in ("tests_green", "focus_long"):
            try:
                n = int(row.get(t, 0) or 0)
            except Exception:
                n = 0
            if n > 0:
                out[t][d] = n
        n = int(st["prs"].get(d, 0) or 0)
        if n > 0:
            out["pr_merged"][d] = n
    return out


def pending(st, counts):
    """{type: units detected but not yet sent}."""
    out = {}
    for t in TYPES:
        for d, n in counts.get(t, {}).items():
            delta = n - int(st["sent"].get(t, {}).get(d, 0) or 0)
            if delta > 0:
                out[t] = out.get(t, 0) + delta
    return out


def request_id(salt, uid, kind, day, cumulative):
    raw = "%s|%s|%s|%s|%d" % (salt, uid, kind, day, cumulative)
    return "loot-" + hashlib.sha256(raw.encode("utf-8")).hexdigest()[:40]


def report(st, counts, token, base, uid):
    """Send every unsent delta. Returns the chests the Arena minted."""
    chests = []
    for t in TYPES:
        for d in sorted(counts.get(t, {})):
            sent = st["sent"].setdefault(t, {})
            while counts[t][d] > int(sent.get(d, 0) or 0):
                have = int(sent.get(d, 0) or 0)
                n = min(MAX_N, counts[t][d] - have)
                body = {"requestId": request_id(st["salt"], uid, t, d, have + n),
                        "type": t, "n": n, "day": d}
                code, resp = arena._request("POST", base + "/v1/loot/events", token=token, body=body)
                if not code or code >= 500:
                    break  # retried next cycle
                sent[d] = have + n  # 2xx and 4xx alike: never retried
                if 200 <= code < 300 and isinstance(resp, dict):
                    chests.extend(c for c in (resp.get("chests") or []) if isinstance(c, dict))
    return chests


def run_once():
    """One reporter cycle. Does nothing at all unless paired and opted in."""
    cfg = _cfg()
    if not cfg.get("workSignals"):
        return {"skipped": "workSignals is off"}
    token, base = arena._authed()
    if not token:
        return {"skipped": "not paired"}
    with _lock:
        st = load_state()
        today = _today()
        if cfg.get("workSignalsPRs") and gh_available():
            scan_prs(st, today)
        counts = local_counts(st, today)
        try:
            uid = str((arena.load_link() or {}).get("handle") or "")
        except Exception:
            uid = ""
        chests = report(st, counts, token, base, uid)
        _prune(st, today)
        save_state(st)
        _last["report"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    return {"chests": len(chests)}


def _loop():
    time.sleep(FIRST_DELAY_SECS)
    while True:
        try:
            run_once()
        except Exception:
            pass
        time.sleep(INTERVAL_SECS)


def start(ctx):
    global _load_config, _base_dir, _thread
    ctx = ctx or {}
    if callable(ctx.get("load_config")):
        _load_config = ctx["load_config"]
    if isinstance(ctx.get("base_dir"), str) and ctx["base_dir"]:
        _base_dir = ctx["base_dir"]
    if _thread is None:
        _thread = threading.Thread(target=_loop, name="loot-reporter", daemon=True)
        _thread.start()


# --- page routes ---------------------------------------------------------- #

def get_loot(arg):
    token, base = arena._authed()
    if not token:
        return 400, {"error": "not paired"}
    return arena._request("GET", base + "/v1/loot", token=token)


def get_status(arg):
    cfg = _cfg()
    token, _ = arena._authed()
    enabled = bool(cfg.get("workSignals")) and bool(token)
    prs = enabled and bool(cfg.get("workSignalsPRs")) and gh_available()
    pend = {}
    if enabled:
        with _lock:
            st = load_state()
            pend = pending(st, local_counts(st, _today()))
    return 200, {"enabled": enabled, "prs": prs, "pending": pend, "lastReport": _last["report"]}


def post_open(body):
    body = body if isinstance(body, dict) else {}
    cid = body.get("chestId")
    if not isinstance(cid, str) or not _CHEST_RE.match(cid):
        return 400, {"error": "bad chest id"}
    rid = body.get("requestId")
    if not isinstance(rid, str) or not _RID_RE.match(rid):
        rid = "open-" + uuid.uuid4().hex[:24]
    token, base = arena._authed()
    if not token:
        return 400, {"error": "not paired"}
    return arena._request("POST", base + "/v1/loot/open", token=token,
                          body={"chestId": cid, "requestId": rid})


GET = {"/api/arena/loot": get_loot, "/api/loot/status": get_status}
POST = {"/api/arena/loot/open": post_open}
