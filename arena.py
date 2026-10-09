"""
Arena client: publishes derived stats to the multiplayer backend.

THE PRIVACY BOUNDARY LIVES HERE. Claude HQ reads your transcripts; this module
decides what -- if anything -- leaves the machine. It sends daily *counts* only:
prompts, tool calls, artifacts, tokens. It never sends prompt text, replies,
file paths, project or folder names, session ids, or session titles. Pantry
actions (Poke Coins, food, gifts) send only the fields in _PANTRY_KEYS; which
session ate, and how tired it was, stays on this machine.

Two deliberate details:

  * Tool names are allowlisted against BUILT-IN Claude Code tools. An MCP tool
    is named `mcp__<server>__<tool>` and routinely carries an employer's or a
    client's name, so anything unrecognised is bucketed as "Other".
  * Cost is opt-in and off by default. Spend is salary- and employer-adjacent.

The device token is kept in `arena-link.json`, NOT in `config.json`, because
`config.json` is served to the browser by /api/config.

Stdlib only, to keep Claude HQ's "no pip install" promise.
"""
import json
import os
import re
import ssl
import uuid
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

# Mirrors KNOWN_TOOLS in the backend's app/schemas.py. Keep the two in sync.
KNOWN_TOOLS = frozenset({
    "Bash", "BashOutput", "KillShell", "Read", "Write", "Edit", "NotebookEdit",
    "Glob", "Grep", "Task", "Agent", "WebFetch", "WebSearch", "TodoWrite",
    "ExitPlanMode", "EnterPlanMode", "SlashCommand", "Skill", "AskUserQuestion",
    "Artifact", "Workflow", "Monitor", "ToolSearch",
})

SCHEMA_VERSION = 1
PUBLISH_WINDOW_DAYS = 30
PUBLISH_INTERVAL_SECS = 300
NUDGE_POLL_SECS = 30
_HTTP_TIMEOUT = 20

# Injected by dashboard.py at startup to avoid a circular import.
_scan_file = None
_load_config = None
_link_path = None

_lock = threading.Lock()
_last = {"at": None, "ok": None, "error": None, "accepted": 0}


def init(scan_file, load_config, here):
    global _scan_file, _load_config, _link_path
    _scan_file = scan_file
    _load_config = load_config
    _link_path = os.path.join(here, "arena-link.json")


# --- local state files -----------------------------------------------------
# Identical copies of dashboard._atomic_write_text / _atomic_write_json /
# _load_json_guarded (dashboard imports arena, so arena cannot import it back).
# Keep the two in sync; tests/test_atomic_state.py checks they behave alike.

def _atomic_write_text(path, text, mode=0o600):
    """Write `text` to `path` atomically with permissions `mode`. Raises OSError
    on failure (the original file is left untouched). A symlinked `path` is
    resolved first, so the real file is replaced and the link is kept."""
    path = os.path.realpath(path)
    d = os.path.dirname(path)
    fd, tmp = tempfile.mkstemp(dir=d, prefix="." + os.path.basename(path) + "-",
                               suffix=".tmp")
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            fd = None
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        if fd is not None:
            try:
                os.close(fd)
            except OSError:
                pass
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _atomic_write_json(path, data, mode=0o600):
    """json.dump `data` to `path` atomically (see _atomic_write_text)."""
    _atomic_write_text(path, json.dumps(data, indent=2), mode=mode)


def _load_json_guarded(path, default=None):
    """Parsed JSON from `path`, or `default` if it is missing/unreadable/corrupt.
    A file that exists but does not parse is renamed to <name>.corrupt-<ts>;
    permission and other I/O errors never quarantine."""
    try:
        with open(path, "rb") as f:
            raw = f.read()
            seen = os.fstat(f.fileno())
    except OSError:
        return default
    try:
        return json.loads(raw.decode("utf-8"))
    except ValueError:  # JSONDecodeError and UnicodeDecodeError
        # Only quarantine the very file we read: a concurrent atomic save may
        # already have swapped a good file in, which must not be moved aside.
        try:
            now = os.stat(path)
        except OSError:
            return default
        if (now.st_ino, now.st_dev, now.st_size, now.st_mtime_ns) != \
                (seen.st_ino, seen.st_dev, seen.st_size, seen.st_mtime_ns):
            return default
        dest = "%s.corrupt-%d" % (path, int(time.time() * 1000))
        try:
            os.replace(path, dest)
        except OSError:
            pass
        return default


# --- link file (holds the device token; never served to the browser) --------

def load_link():
    data = _load_json_guarded(_link_path, {}) if _link_path else {}
    return data if isinstance(data, dict) else {}


def save_link(data):
    """Persist the link atomically, 0600 from the first byte (the token is never
    world-readable, even briefly). Raises OSError if it could not be written."""
    with _lock:
        _atomic_write_json(_link_path, data)
        return data


def clear_link():
    with _lock:
        try:
            os.remove(_link_path)
        except OSError:
            pass


# --- payload ---------------------------------------------------------------

def build_payload(projects_dir, share_cost=False, trainer_name="", days=PUBLISH_WINDOW_DAYS):
    """Aggregate the last `days` days of activity into the wire allowlist."""
    import glob

    today = datetime.now(timezone.utc).date()
    window_start = today - timedelta(days=days - 1)

    per_day = {}  # date -> accumulator

    for path in glob.glob(os.path.join(projects_dir, "*", "*.jsonl")):
        agg = _scan_file(path)
        if agg is None:
            continue
        for diso, dd in agg.get("per_day", {}).items():
            try:
                d = datetime.fromisoformat(diso).date() if "T" in diso else \
                    datetime.strptime(diso, "%Y-%m-%d").date()
            except Exception:
                continue
            if d < window_start or d > today:
                continue
            acc = per_day.setdefault(d, {
                "prompts": 0, "tools": 0, "artifacts": 0, "replies": 0,
                "input": 0, "output": 0, "cacheRead": 0, "cacheCreation": 0,
                "cost": 0.0, "tools_by_name": {},
            })
            acc["prompts"] += dd.get("prompts", 0)
            acc["tools"] += dd.get("tools", 0)
            acc["artifacts"] += dd.get("artifacts", 0)
            acc["replies"] += dd.get("replies", 0)
            acc["input"] += dd.get("input", 0)
            acc["output"] += dd.get("output", 0)
            acc["cacheRead"] += dd.get("cacheRead", 0)
            acc["cacheCreation"] += dd.get("cacheCreation", 0)
            acc["cost"] += dd.get("cost", 0.0)
            for name, count in (dd.get("tools_by_name") or {}).items():
                # Bucket here, before the name can reach the network.
                safe = name if name in KNOWN_TOOLS else "Other"
                acc["tools_by_name"][safe] = acc["tools_by_name"].get(safe, 0) + count

    out_days = []
    for d in sorted(per_day):
        acc = per_day[d]
        day = {
            "date": d.isoformat(),
            "prompts": int(acc["prompts"]),
            "tools": int(acc["tools"]),
            "artifacts": int(acc["artifacts"]),
            "replies": int(acc["replies"]),
            "tokens": {
                "input": int(acc["input"]),
                "output": int(acc["output"]),
                "cacheRead": int(acc["cacheRead"]),
                "cacheCreation": int(acc["cacheCreation"]),
            },
            "toolBreakdown": sorted(
                ({"name": n, "count": int(c)} for n, c in acc["tools_by_name"].items()),
                key=lambda t: -t["count"],
            )[:32],
        }
        if share_cost:
            day["costUSD"] = round(acc["cost"], 4)
        out_days.append(day)

    return {
        "schemaVersion": SCHEMA_VERSION,
        "trainerName": trainer_name or "",
        "days": out_days,
    }


# --- transport -------------------------------------------------------------

_ssl_ctx = None


def _ssl_context():
    """A verifying SSL context that also works on python.org macOS builds.

    Those builds ship with an EMPTY CA store until the user runs
    "Install Certificates.command", so every HTTPS call fails with
    CERTIFICATE_VERIFY_FAILED. If the default store is empty, trust the macOS
    system roots (stdlib only), then certifi if it happens to be installed.
    Verification is never disabled."""
    global _ssl_ctx
    if _ssl_ctx is not None:
        return _ssl_ctx
    ctx = ssl.create_default_context()
    if not ctx.cert_store_stats().get("x509_ca"):
        try:
            pem = subprocess.run(
                ["/usr/bin/security", "find-certificate", "-a", "-p",
                 "/System/Library/Keychains/SystemRootCertificates.keychain"],
                capture_output=True, text=True, timeout=10).stdout
            if pem:
                ctx.load_verify_locations(cadata=pem)
        except Exception:
            pass
    if not ctx.cert_store_stats().get("x509_ca"):
        try:
            import certifi
            ctx.load_verify_locations(cafile=certifi.where())
        except Exception:
            pass
    _ssl_ctx = ctx
    return ctx


def _request(method, url, token=None, body=None):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Accept", "application/json")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", "Bearer %s" % token)
    try:
        with urllib.request.urlopen(req, timeout=_HTTP_TIMEOUT,
                                    context=_ssl_context()) as resp:
            raw = resp.read().decode("utf-8")
            return resp.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as e:
        try:
            body = json.loads(e.read().decode("utf-8"))
        except Exception:
            return e.code, {"error": e.reason}
        return e.code, _with_error(body)
    except Exception as e:
        return 0, {"error": str(e)}


def _request_raw(method, url, token=None):
    """Like _request, but returns the body as raw bytes plus its content type,
    for non-JSON payloads (audio clips). Returns (status, content_type, bytes)."""
    req = urllib.request.Request(url, method=method)
    if token:
        req.add_header("Authorization", "Bearer %s" % token)
    try:
        with urllib.request.urlopen(req, timeout=_HTTP_TIMEOUT,
                                    context=_ssl_context()) as resp:
            return resp.status, resp.headers.get("Content-Type", ""), resp.read()
    except urllib.error.HTTPError as e:
        return e.code, "", b""
    except Exception:
        return 0, "", b""


def _with_error(body):
    """FastAPI reports a failure as {"detail": ...}, but the dashboard page reads
    "error" -- without this the real reason ("no such person", "you cannot nudge
    yourself") never reached the toast. Validation errors come as a list."""
    if not isinstance(body, dict) or "error" in body or "detail" not in body:
        return body
    detail = body["detail"]
    if isinstance(detail, list):
        detail = "; ".join(
            str(item.get("msg", item)) if isinstance(item, dict) else str(item)
            for item in detail
        )
    return dict(body, error=str(detail))


def _base_url():
    cfg = _load_config()
    return (cfg.get("arenaUrl") or "").rstrip("/")


def pair(code, label=""):
    """Redeem a pairing code for a device token and remember it."""
    base = _base_url()
    if not base:
        return 400, {"error": "set the Arena server URL first"}
    status, body = _request("POST", base + "/v1/auth/pair",
                            body={"code": code.strip().upper(), "label": label or "claude-hq"})
    if status == 200 and body.get("token"):
        try:
            save_link({
                "url": base,
                "token": body["token"],
                "handle": body.get("handle", ""),
                "displayName": body.get("displayName", ""),
                "avatarUrl": body.get("avatarUrl", ""),
            })
        except OSError as e:
            return 500, {"error": "paired, but could not save the device token: %s" % e}
        return 200, {"ok": True, "handle": body.get("handle", "")}
    return status or 502, {"error": body.get("detail") or body.get("error") or "pairing failed"}


def publish(projects_dir):
    """Push the current window. Returns (status, body)."""
    link = load_link()
    token = link.get("token")
    base = link.get("url") or _base_url()
    if not token or not base:
        return 400, {"error": "not paired"}

    cfg = _load_config()
    payload = build_payload(
        projects_dir,
        share_cost=bool(cfg.get("arenaShareCost")),
        trainer_name=cfg.get("trainerName") or "",
    )
    status, body = _request("POST", base + "/v1/stats", token=token, body=payload)
    _last.update({
        "at": datetime.now(timezone.utc).isoformat(),
        "ok": status == 200,
        "error": None if status == 200 else (body.get("detail") or body.get("error") or "HTTP %s" % status),
        "accepted": body.get("accepted", 0) if status == 200 else 0,
    })
    return status, body


def preview(projects_dir):
    """Build the exact payload publish() would send, WITHOUT sending it.

    Lets the page show the user precisely what leaves the machine before they
    ever connect. No token or pairing required -- it only reads local files."""
    cfg = _load_config()
    payload = build_payload(
        projects_dir,
        share_cost=bool(cfg.get("arenaShareCost")),
        trainer_name=cfg.get("trainerName") or "",
    )
    return 200, payload


def board(window="season"):
    link = load_link()
    token, base = link.get("token"), link.get("url") or _base_url()
    if not token or not base:
        return 400, {"error": "not paired"}
    return _request("GET", "%s/v1/board?window=%s" % (base, window), token=token)


def list_sounds():
    """List the soundboard clips the Arena host is serving. Names are filenames."""
    link = load_link()
    token, base = link.get("token"), link.get("url") or _base_url()
    if not token or not base:
        return 400, {"error": "not paired"}
    return _request("GET", base + "/v1/sounds", token=token)


def get_sound(file):
    """Fetch one soundboard clip's bytes. Returns (status, content_type, bytes)."""
    link = load_link()
    token, base = link.get("token"), link.get("url") or _base_url()
    if not token or not base:
        return 400, "", b""
    return _request_raw("GET", base + "/v1/sounds/" + urllib.parse.quote(file),
                        token=token)


def is_paired():
    """True when we hold a device token and know where the Arena host is."""
    link = load_link()
    return bool(link.get("token") and (link.get("url") or _base_url()))


def upload_sound(filename, data, content_type):
    """Push one clip to the Arena host's sounds dir (raw bytes in the body, the
    name as a query param). Returns (status, json). Mirrors _request's error
    handling but sends bytes rather than JSON."""
    link = load_link()
    token, base = link.get("token"), link.get("url") or _base_url()
    if not token or not base:
        return 400, {"error": "not paired"}
    url = base + "/v1/sounds?name=" + urllib.parse.quote(filename)
    req = urllib.request.Request(url, data=data, method="POST")
    req.add_header("Accept", "application/json")
    req.add_header("Content-Type", content_type or "application/octet-stream")
    req.add_header("Authorization", "Bearer %s" % token)
    try:
        with urllib.request.urlopen(req, timeout=_HTTP_TIMEOUT,
                                    context=_ssl_context()) as resp:
            raw = resp.read().decode("utf-8")
            return resp.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as e:
        try:
            return e.code, _with_error(json.loads(e.read().decode("utf-8")))
        except Exception:
            return e.code, {"error": e.reason}
    except Exception as e:
        return 0, {"error": str(e)}


def ws_ticket():
    """Mint a short-lived ticket so the page can open a websocket directly.

    The long-lived device token stays here and never reaches the browser.
    """
    link = load_link()
    token, base = link.get("token"), link.get("url") or _base_url()
    if not token or not base:
        return 400, {"error": "not paired"}
    status, body = _request("POST", base + "/v1/auth/ticket", token=token)
    if status == 200:
        body["wsUrl"] = base.replace("https://", "wss://").replace("http://", "ws://")
    return status, body


def send_nudge(to_handle, note=""):
    """Ask the Arena server to nudge another member (by handle). Persists server
    side so it also reaches them when their Arena tab is closed."""
    link = load_link()
    token, base = link.get("token"), link.get("url") or _base_url()
    if not token or not base:
        return 400, {"error": "not paired"}
    return _request("POST", base + "/v1/nudge", token=token,
                    body={"toHandle": to_handle, "note": note or ""})


def drain_nudges():
    """Fetch + clear nudges waiting for this user. Returns a list (may be empty)."""
    link = load_link()
    token, base = link.get("token"), link.get("url") or _base_url()
    if not token or not base:
        return []
    status_code, body = _request("GET", base + "/v1/nudges", token=token)
    if status_code == 200 and isinstance(body, dict):
        nudges = body.get("nudges")
        return nudges if isinstance(nudges, list) else []
    return []


# --- pantry (Poke Coins, food, gifts) ---------------------------------------
#
# The server is the only authority for coins and food. What crosses the wire is
# the allowlist in _PANTRY_KEYS: which session ate, and its fatigue, never leave
# the machine (dashboard.py keeps that in meals.json).

# Mirrors CATALOG in backend app/pantry.py. Keep in sync.
FOOD_KINDS = ("berry", "bread", "riceball", "coffee", "bento", "noodles", "hotpot",
              "tonic", "elixir", "strawberry", "dango", "omelette", "watermelon",
              "shavedice", "curry", "apple", "sweetpotato", "pumpkinstew",
              "chestnuts", "cocoa", "oden")
FOOD_LABELS = {
    "berry": ("Berry", "Berries"),
    "bread": ("Bread Loaf", "Bread Loaves"),
    "riceball": ("Rice Ball", "Rice Balls"),
    "coffee": ("Coffee", "Coffees"),
    "bento": ("Bento", "Bentos"),
    "noodles": ("Noodle Bowl", "Noodle Bowls"),
    "hotpot": ("Hot Pot", "Hot Pots"),
    "tonic": ("Revive Tonic", "Revive Tonics"),
    "elixir": ("Honey Elixir", "Honey Elixirs"),
    "strawberry": ("Strawberry", "Strawberries"),
    "dango": ("Hanami Dango", "Hanami Dango"),
    "omelette": ("Garden Omelette", "Garden Omelettes"),
    "watermelon": ("Watermelon Slice", "Watermelon Slices"),
    "shavedice": ("Shaved Ice", "Shaved Ices"),
    "curry": ("Summer Curry", "Summer Curries"),
    "apple": ("Apple", "Apples"),
    "sweetpotato": ("Baked Sweet Potato", "Baked Sweet Potatoes"),
    "pumpkinstew": ("Pumpkin Stew", "Pumpkin Stews"),
    "chestnuts": ("Bag of Chestnuts", "Bags of Chestnuts"),
    "cocoa": ("Hot Cocoa", "Hot Cocoas"),
    "oden": ("Oden Skewer", "Oden Skewers"),
}
PANTRY_ACTIONS = ("claim", "buy", "eat", "give")
_PANTRY_KEYS = ("requestId", "kind", "qty", "coins", "toHandle", "note")

# A server without the pantry routes answers the drain with 404; stop asking
# for a while instead of hitting it every poll.
GIFT_DRAIN_BACKOFF_SECS = 1800
_gift_drain_off_until = 0.0


def _authed():
    """(token, base) when paired, else (None, None)."""
    link = load_link()
    token, base = link.get("token"), link.get("url") or _base_url()
    if not token or not base:
        return None, None
    return token, base


def pantry(action=None, body=None):
    """GET the pantry state (action None), or POST one pantry action.

    Only _PANTRY_KEYS are forwarded: this is the privacy boundary, so a
    sessionId, title or path can never reach the server, even through a bug in
    the caller."""
    token, base = _authed()
    if not token:
        return 400, {"error": "not paired"}
    if action is None:
        return _request("GET", base + "/v1/pantry", token=token)
    if action not in PANTRY_ACTIONS:
        return 400, {"error": "unknown pantry action"}
    body = body if isinstance(body, dict) else {}
    return _request("POST", base + "/v1/pantry/" + action, token=token,
                    body={k: body[k] for k in _PANTRY_KEYS if k in body})


_QUEST_REWARD_KEYS = ("requestId", "kind", "questId", "tier", "coins")


def quest_reward(request_id, kind, quest_id, tier, coins):
    """Claim coins for a completed quest or achievement. Privacy-safe: only the
    quest catalog id and date leave the machine (encoded in request_id)."""
    token, base = _authed()
    if not token:
        return 400, {"error": "not paired"}
    body = {"requestId": request_id, "kind": kind, "questId": quest_id, "coins": coins}
    if tier is not None:
        body["tier"] = tier
    return _request("POST", base + "/v1/pantry/reward", token=token, body=body)


def drain_gifts():
    """Fetch + mark delivered the gifts that missed live delivery. Returns a list."""
    global _gift_drain_off_until
    if time.time() < _gift_drain_off_until:
        return []
    token, base = _authed()
    if not token:
        return []
    status_code, body = _request("POST", base + "/v1/pantry/gifts/drain",
                                 token=token, body={})
    if status_code == 404:
        _gift_drain_off_until = time.time() + GIFT_DRAIN_BACKOFF_SECS
        return []
    if status_code == 200 and isinstance(body, dict):
        gifts = body.get("gifts") or []
        return [g for g in gifts if isinstance(g, dict)] if isinstance(gifts, list) else []
    return []


def _count(v):
    return v if isinstance(v, int) and not isinstance(v, bool) and v > 0 else 0


def gift_notice(g):
    """(title, body) for the OS notification of one gift."""
    who = g.get("fromName") or g.get("fromHandle") or "Someone"
    if not isinstance(who, str):
        who = "Someone"
    c, q, kind = _count(g.get("coins")), _count(g.get("qty")), g.get("kind")
    parts = []
    if c:
        parts.append("%d Poke Coin%s" % (c, "" if c == 1 else "s"))
    if q and isinstance(kind, str) and kind in FOOD_LABELS:
        name, plural = FOOD_LABELS[kind]
        parts.append("%d %s" % (q, name if q == 1 else plural))
    body = " and ".join(parts) or "a gift"
    note = g.get("note") or ""
    if isinstance(note, str) and note:
        body += ": " + note
    return "\U0001F381 " + who + " sent you a gift", body


def status():
    """Connection state for the UI. Deliberately excludes the token."""
    link = load_link()
    cfg = _load_config()
    return {
        "paired": bool(link.get("token")),
        "url": link.get("url") or cfg.get("arenaUrl") or "",
        "handle": link.get("handle", ""),
        "displayName": link.get("displayName", ""),
        "avatarUrl": link.get("avatarUrl", ""),
        "enabled": bool(cfg.get("arenaEnabled")),
        "shareCost": bool(cfg.get("arenaShareCost")),
        "lastPublish": dict(_last),
    }


# --- background publisher --------------------------------------------------

def start_publisher(projects_dir):
    def loop():
        while True:
            time.sleep(PUBLISH_INTERVAL_SECS)
            try:
                cfg = _load_config()
                if cfg.get("arenaEnabled") and load_link().get("token"):
                    publish(projects_dir)
            except Exception:
                pass  # never let the publisher take down the dashboard

    t = threading.Thread(target=loop, name="arena-publisher", daemon=True)
    t.start()
    return t


def _text(v):
    """A server-sent field as display text: str as-is, numbers stringified,
    anything else (None, dict, list, bool) as ""."""
    if isinstance(v, str):
        return v
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return str(v)
    return ""


def _poll_once(notify):
    """One poller pass: nudges ping, gifts that missed live delivery arrive
    silently (notify's third argument is `sound`)."""
    for n in drain_nudges():
        try:  # one malformed item must not drop the rest of the batch
            who = _text(n.get("fromName")) or _text(n.get("fromHandle")) or "Someone"
            note = _text(n.get("note"))
            body = (who + " nudged you") + (": " + note if note else "")
            notify("👋 " + who + " nudged you", body)
        except Exception:
            continue
    for g in drain_gifts():
        try:
            notify(*gift_notice(g), False)
        except Exception:
            continue


def start_nudge_poller(notify):
    """Poll for incoming nudges and gifts and hand each to `notify(title, body[,
    sound])` so the dashboard can raise a native OS notification -- this is what
    lets a nudge reach someone whose Arena tab is closed, as long as Claude HQ
    is running."""
    def loop():
        while True:
            time.sleep(NUDGE_POLL_SECS)
            try:
                cfg = _load_config()
                if cfg.get("arenaEnabled") and load_link().get("token"):
                    _poll_once(notify)
            except Exception:
                pass  # never let the poller take down the dashboard

    t = threading.Thread(target=loop, name="arena-nudge-poller", daemon=True)
    t.start()
    return t


# --- private rooms ---------------------------------------------------------

ROOM_ID_RE = re.compile(r"^r_[A-Za-z0-9_-]{22}$")
USER_ID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


def _valid_room_id(rid):
    return isinstance(rid, str) and ROOM_ID_RE.fullmatch(rid)


def _valid_user_id(uid):
    return isinstance(uid, str) and USER_ID_RE.fullmatch(uid)


def rooms_directory():
    token, base = _authed()
    if not token:
        return 400, {"error": "not paired"}
    return _request("GET", base + "/v1/rooms/directory", token=token)


def room_members(room_id):
    if not _valid_room_id(room_id):
        return 400, {"error": "bad room id"}
    token, base = _authed()
    if not token:
        return 400, {"error": "not paired"}
    return _request("GET", base + "/v1/rooms/members?roomId=" +
                    urllib.parse.quote(room_id, safe=""), token=token)


def create_room(name, password):
    token, base = _authed()
    if not token:
        return 400, {"error": "not paired"}
    return _request("POST", base + "/v1/rooms/create", token=token,
                    body={"name": name, "password": password})


def join_room(room_id, password):
    if not _valid_room_id(room_id):
        return 400, {"error": "bad room id"}
    token, base = _authed()
    if not token:
        return 400, {"error": "not paired"}
    return _request("POST", base + "/v1/rooms/join", token=token,
                    body={"roomId": room_id, "password": password})


def leave_room(room_id):
    if not _valid_room_id(room_id):
        return 400, {"error": "bad room id"}
    token, base = _authed()
    if not token:
        return 400, {"error": "not paired"}
    return _request("POST", base + "/v1/rooms/leave", token=token,
                    body={"roomId": room_id})


def rename_room(room_id, name):
    if not _valid_room_id(room_id):
        return 400, {"error": "bad room id"}
    token, base = _authed()
    if not token:
        return 400, {"error": "not paired"}
    return _request("POST", base + "/v1/rooms/rename", token=token,
                    body={"roomId": room_id, "name": name})


def set_room_password(room_id, password, sign_out_others=False):
    if not _valid_room_id(room_id):
        return 400, {"error": "bad room id"}
    token, base = _authed()
    if not token:
        return 400, {"error": "not paired"}
    return _request("POST", base + "/v1/rooms/password", token=token,
                    body={"roomId": room_id, "password": password,
                          "signOutOthers": bool(sign_out_others)})


def kick_room_member(room_id, user_id):
    if not _valid_room_id(room_id):
        return 400, {"error": "bad room id"}
    if not _valid_user_id(user_id):
        return 400, {"error": "bad user id"}
    token, base = _authed()
    if not token:
        return 400, {"error": "not paired"}
    return _request("POST", base + "/v1/rooms/kick", token=token,
                    body={"roomId": room_id, "userId": user_id})


def unban_room_member(room_id, user_id):
    if not _valid_room_id(room_id):
        return 400, {"error": "bad room id"}
    if not _valid_user_id(user_id):
        return 400, {"error": "bad user id"}
    token, base = _authed()
    if not token:
        return 400, {"error": "not paired"}
    return _request("POST", base + "/v1/rooms/unban", token=token,
                    body={"roomId": room_id, "userId": user_id})


def delete_room(room_id):
    if not _valid_room_id(room_id):
        return 400, {"error": "bad room id"}
    token, base = _authed()
    if not token:
        return 400, {"error": "not paired"}
    return _request("POST", base + "/v1/rooms/delete", token=token,
                    body={"roomId": room_id})


# --------------------------------------------------------------------------- #
# Cali — California Burrito taco Tuesdays
# --------------------------------------------------------------------------- #

# "lastseason" is the whole previous calendar month (the board's champion).
CALI_WINDOWS = ("season", "30d", "7d", "all", "lastseason")
# The privacy boundary, same idea as _PANTRY_KEYS: an order carries who ate what
# and nothing else. A sessionId, title, path or project name can never reach the
# server, even through a bug in the caller.
_CALI_ORDER_KEYS = ("requestId", "date", "diners", "note")
_CALI_DINER_KEYS = ("handle", "name", "tacos", "items")
CALI_TACO_KEYS = ("mildHard", "mildSoft", "wildHard", "wildSoft")
# The rest of the menu, recorded but never priced or scored. Mirrors CALI_MENU in
# backend app/tacos.py; tests/test_cali_menu_sync.py checks it.
CALI_ITEM_KEYS = ("burrito", "ricebowl", "saladbowl", "quesadilla", "nachos",
                  "tostada", "chips", "guac", "churros", "soda", "icedtea")


def _cali_order(body):
    """Rebuild an order from allowlisted keys only, one level at a time."""
    body = body if isinstance(body, dict) else {}
    clean = {k: body[k] for k in _CALI_ORDER_KEYS if k in body and k != "diners"}
    diners = body.get("diners")
    out = []
    for d in diners if isinstance(diners, list) else []:
        if not isinstance(d, dict):
            continue
        row = {k: d[k] for k in _CALI_DINER_KEYS if k in d and k not in ("tacos", "items")}
        tacos = d.get("tacos")
        row["tacos"] = {
            k: tacos[k] for k in CALI_TACO_KEYS if isinstance(tacos, dict) and k in tacos
        }
        # Known menu keys with positive int counts only, and no key at all when
        # there are none: an Arena that predates items refuses any `items` field.
        items = d.get("items")
        items = {
            k: items[k] for k in CALI_ITEM_KEYS
            if isinstance(items, dict) and isinstance(items.get(k), int)
            and not isinstance(items.get(k), bool) and items[k] > 0
        }
        if items:
            row["items"] = items
        out.append(row)
    clean["diners"] = out
    return clean


def cali_board(window="season"):
    """The cali-leaderboard: Tuesdays attended, total tacos as the tiebreak."""
    token, base = _authed()
    if not token:
        return 400, {"error": "not paired"}
    if window not in CALI_WINDOWS:
        window = "season"
    return _request("GET", "%s/v1/cali/board?window=%s" % (base, window), token=token)


def cali_orders():
    """The shared dinner log, newest first."""
    token, base = _authed()
    if not token:
        return 400, {"error": "not paired"}
    return _request("GET", base + "/v1/cali/orders", token=token)


def cali_log_order(body):
    """Log one dinner. TT, the buy-1-get-1 price and TPP are all worked out
    server-side; this sends only what each person ordered."""
    token, base = _authed()
    if not token:
        return 400, {"error": "not paired"}
    return _request("POST", base + "/v1/cali/orders", token=token, body=_cali_order(body))


# ---- HQ 2.1: visit and customise HQs ---------------------------------------
# What may leave the machine about your HQ: whether it is open to visitors, how
# the building looks (paint, accent, sign) and how many crew are working, need
# you or are idle. Counts and cosmetics only; this allowlist is the boundary.
_HQ_LOOK_KEYS = ("paint", "accent", "sign")
_HQ_CREW_KEYS = ("working", "needs", "idle")


def hq_me():
    token, base = _authed()
    if not token:
        return 400, {"error": "not paired"}
    return _request("GET", base + "/v1/hq/me", token=token)


def hq_update(open_=None, look=None, crew=None):
    token, base = _authed()
    if not token:
        return 400, {"error": "not paired"}
    body = {}
    if isinstance(open_, bool):
        body["open"] = open_
    if isinstance(look, dict):
        body["look"] = {k: look[k] for k in _HQ_LOOK_KEYS if isinstance(look.get(k), str)}
    if isinstance(crew, dict):
        body["crew"] = {k: max(0, min(64, int(crew.get(k) or 0))) for k in _HQ_CREW_KEYS}
    return _request("PUT", base + "/v1/hq/me", token=token, body=body)


def hq_open():
    token, base = _authed()
    if not token:
        return 400, {"error": "not paired"}
    return _request("GET", base + "/v1/hq/open", token=token)


def hq_visit(user_id):
    token, base = _authed()
    if not token:
        return 400, {"error": "not paired"}
    if not _valid_user_id(user_id):
        return 400, {"error": "bad user id"}
    return _request("GET", base + "/v1/hq/" + user_id, token=token)



# ---- 3D character portrait ----------------------------------------------------
# A small PNG the page renders from the user's own character choices; nothing else
# rides along. Checked here as well as on the Arena.
PORTRAIT_MAX_BYTES = 64 * 1024


def portrait_png(data_url):
    """The PNG bytes of a data:image/png;base64 URL, or None if it isn't one we
    would send (not a PNG, too big, not square 32..256 px)."""
    import base64
    if not isinstance(data_url, str) or not data_url.startswith("data:image/png;base64,"):
        return None
    try:
        b = base64.b64decode(data_url.split(",", 1)[1], validate=True)
    except Exception:
        return None
    if len(b) > PORTRAIT_MAX_BYTES or len(b) < 33 or b[:8] != b"\x89PNG\r\n\x1a\n" or b[12:16] != b"IHDR":
        return None
    w, h = int.from_bytes(b[16:20], "big"), int.from_bytes(b[20:24], "big")
    return b if w == h and 32 <= w <= 256 else None


def portrait_put(png):
    token, base = _authed()
    if not token:
        return 400, {"error": "not paired"}
    req = urllib.request.Request(base + "/v1/me/portrait", data=png, method="PUT")
    req.add_header("Content-Type", "image/png")
    req.add_header("Accept", "application/json")
    req.add_header("Authorization", "Bearer %s" % token)
    try:
        with urllib.request.urlopen(req, timeout=_HTTP_TIMEOUT, context=_ssl_context()) as resp:
            raw = resp.read().decode("utf-8")
            return resp.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as e:
        try:
            return e.code, _with_error(json.loads(e.read().decode("utf-8")))
        except Exception:
            return e.code, {"error": e.reason}
    except Exception as e:
        return 0, {"error": str(e)}


def portrait_delete():
    token, base = _authed()
    if not token:
        return 400, {"error": "not paired"}
    return _request("DELETE", base + "/v1/me/portrait", token=token)


# ---- Music: Now Playing ------------------------------------------------------
# What may leave the machine about your music: the fields music.wire_track()
# keeps (title, artist, album, app, a Spotify/YouTube id, length, position,
# playing). Re-filtered here so this module holds its own boundary.
def music_now():
    token, base = _authed()
    if not token:
        return 400, {"error": "not paired"}
    return _request("GET", base + "/v1/music/now", token=token)


def music_now_put(track):
    import music
    token, base = _authed()
    if not token:
        return 400, {"error": "not paired"}
    body = music.wire_track(track)
    if body is None:
        return 400, {"error": "no track"}
    return _request("PUT", base + "/v1/music/now", token=token, body=body)


def music_now_clear():
    token, base = _authed()
    if not token:
        return 400, {"error": "not paired"}
    return _request("DELETE", base + "/v1/music/now", token=token)

# ---- HQ 2.1: progression, leaderboards, trainer profiles (read-only) --------
_GAMES = ("kart", "plat", "fps", "golf")


def progress():
    token, base = _authed()
    if not token:
        return 400, {"error": "not paired"}
    return _request("GET", base + "/v1/progress/me", token=token)


def leaderboards(game, key=None):
    token, base = _authed()
    if not token:
        return 400, {"error": "not paired"}
    if game not in _GAMES:
        return 400, {"error": "unknown game"}
    q = ""
    if isinstance(key, str) and re.fullmatch(r"[a-z0-9_-]{1,40}", key):
        q = "?key=" + key
    return _request("GET", base + "/v1/leaderboards/" + game + q, token=token)


def profile(user_id):
    token, base = _authed()
    if not token:
        return 400, {"error": "not paired"}
    if user_id != "me" and not _valid_user_id(user_id):
        return 400, {"error": "bad user id"}
    return _request("GET", base + "/v1/profile/" + user_id, token=token)


def server_stats():
    """The Arena's own numbers (memory, CPU, uptime, rooms, people online, game loops)."""
    token, base = _authed()
    if not token:
        return 400, {"error": "not paired"}
    return _request("GET", base + "/v1/server/stats", token=token)


# ---- HQ 2.1: cosmetics and the Valley market --------------------------------
_COS_SLOTS = ("kart", "runner", "blaster", "ball", "frame", "decor")
_MARKET_CATS = ("fish", "crop", "ore", "gem", "misc")


def cosmetics(action=None, body=None):
    """GET the wardrobe (action None), or POST buy {item} / equip {slot, item}."""
    token, base = _authed()
    if not token:
        return 400, {"error": "not paired"}
    if action is None:
        return _request("GET", base + "/v1/cosmetics", token=token)
    body = body if isinstance(body, dict) else {}
    item = body.get("item")
    if item is not None and not (isinstance(item, str) and re.fullmatch(r"[a-z]-[a-z]{2,12}", item)):
        return 400, {"error": "bad item"}
    if action == "buy":
        return _request("POST", base + "/v1/cosmetics/buy", token=token,
                        body={"requestId": "cos-" + uuid.uuid4().hex[:24], "item": item})
    if action == "equip":
        slot = body.get("slot")
        if slot not in _COS_SLOTS:
            return 400, {"error": "unknown slot"}
        return _request("POST", base + "/v1/cosmetics/equip", token=token, body={"slot": slot, "item": item})
    return 400, {"error": "unknown cosmetics action"}


def market_sell(cat, qty):
    token, base = _authed()
    if not token:
        return 400, {"error": "not paired"}
    if cat not in _MARKET_CATS or not isinstance(qty, int) or isinstance(qty, bool) or not 1 <= qty <= 10:
        return 400, {"error": "sell 1 to 10 of one kind"}
    return _request("POST", base + "/v1/market/sell", token=token,
                    body={"requestId": "sell-" + uuid.uuid4().hex[:24], "cat": cat, "qty": qty})


# ---- HQ 2.1: crews ----------------------------------------------------------
def crews(action=None, body=None):
    """GET the crew board ('board') or yours ('mine'); POST create / join / leave."""
    token, base = _authed()
    if not token:
        return 400, {"error": "not paired"}
    if action in (None, "board"):
        return _request("GET", base + "/v1/crews", token=token)
    if action == "mine":
        return _request("GET", base + "/v1/crews/mine", token=token)
    body = body if isinstance(body, dict) else {}
    if action == "create":
        clean = {k: str(body.get(k) or "")[:40] for k in ("name", "tag", "color")}
        return _request("POST", base + "/v1/crews/create", token=token, body=clean)
    if action == "join":
        return _request("POST", base + "/v1/crews/join", token=token, body={"code": str(body.get("code") or "")[:12]})
    if action == "leave":
        return _request("POST", base + "/v1/crews/leave", token=token, body={})
    return 400, {"error": "unknown crews action"}


# ---- HQ 2.1: Quick Play -------------------------------------------------------
QUICKPLAY_GAMES = ("kart", "plat", "fps", "golf", "type")


def quickplay(action, body=None):
    """Join a game's matchmaking queue, poll it, or leave. Only the game name is sent."""
    token, base = _authed()
    if not token:
        return 400, {"error": "not paired"}
    if action == "status":
        return _request("GET", base + "/v1/quickplay/status", token=token)
    if action == "join":
        game = (body or {}).get("game") if isinstance(body, dict) else None
        if game not in QUICKPLAY_GAMES:
            return 400, {"error": "unknown game"}
        return _request("POST", base + "/v1/quickplay/join", token=token, body={"game": game})
    if action == "leave":
        return _request("POST", base + "/v1/quickplay/leave", token=token, body={})
    return 400, {"error": "unknown quickplay action"}
