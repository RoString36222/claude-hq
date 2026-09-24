"""
Arena client: publishes derived stats to the multiplayer backend.

THE PRIVACY BOUNDARY LIVES HERE. Claude HQ reads your transcripts; this module
decides what -- if anything -- leaves the machine. It sends daily *counts* only:
prompts, tool calls, artifacts, tokens. It never sends prompt text, replies,
file paths, project or folder names, session ids, or session titles.

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
import threading
import time
import urllib.error
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


# --- link file (holds the device token; never served to the browser) --------

def load_link():
    try:
        with open(_link_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def save_link(data):
    with _lock:
        try:
            with open(_link_path, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2)
            os.chmod(_link_path, 0o600)
        except Exception:
            pass
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

def _request(method, url, token=None, body=None):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Accept", "application/json")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", "Bearer %s" % token)
    try:
        with urllib.request.urlopen(req, timeout=_HTTP_TIMEOUT) as resp:
            raw = resp.read().decode("utf-8")
            return resp.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode("utf-8"))
        except Exception:
            return e.code, {"error": e.reason}
    except Exception as e:
        return 0, {"error": str(e)}


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
        save_link({
            "url": base,
            "token": body["token"],
            "handle": body.get("handle", ""),
            "displayName": body.get("displayName", ""),
            "avatarUrl": body.get("avatarUrl", ""),
        })
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


def board(window="season"):
    link = load_link()
    token, base = link.get("token"), link.get("url") or _base_url()
    if not token or not base:
        return 400, {"error": "not paired"}
    return _request("GET", "%s/v1/board?window=%s" % (base, window), token=token)


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
