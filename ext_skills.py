"""HQ 2.5 skill tree: the local proxy and the opt-in reporter.

  GET  /api/arena/skills?u=me|<uuid>  your tree, or someone's public tiers + title
  POST /api/arena/skills/title        {title: "<cat>-3" | "<cat>-5" | null}
  GET  /api/skills/local              {enabled, days:{day:{cat:n}}, lastReport}

The reporter (start) runs only while the HQ is paired AND config.workSignals is
true (off by default; the page asks once). Every 15 minutes -- and right after
the switch is turned on -- it sends, per UTC day of the last seven, the seven
skill-category counts from worksignals and nothing else: body {day, counts}.
No tool names, commands, file names, paths, repos or text. Failures are silent;
the last outcome is kept in memory for /api/skills/local.
"""
import re
import threading
import time
from datetime import datetime, timezone

import arena
import worksignals

REPORT_EVERY_SECS = 15 * 60
# How often the loop wakes to notice workSignals being switched on.
POLL_SECS = 60
FIRST_DELAY_SECS = 45
REPORT_DAYS = 7

_TITLE_RE = re.compile(r"^(?:%s)-(?:3|5)$" % "|".join(worksignals.SKILL_CATS))

_state = {"lastReport": None, "sent": {}, "load_config": None}
_lock = threading.Lock()


def _enabled(load_config=None):
    lc = load_config or _state.get("load_config") or getattr(arena, "_load_config", None)
    try:
        cfg = lc() if lc else {}
    except Exception:
        cfg = {}
    return (cfg if isinstance(cfg, dict) else {}).get("workSignals") is True


# --- routes ------------------------------------------------------------------

def get_skills(arg):
    who = arg("u") or "me"
    token, base = arena._authed()
    if not token:
        return 400, {"error": "not paired"}
    if who != "me" and not arena.USER_ID_RE.fullmatch(who):
        return 400, {"error": "bad user id"}
    return arena._request("GET", base + "/v1/skills/" + who, token=token)


def post_title(body):
    body = body if isinstance(body, dict) else {}
    if "title" not in body:
        return 400, {"error": "title required"}
    title = body.get("title")
    if title is not None and not (isinstance(title, str) and _TITLE_RE.fullmatch(title)):
        return 400, {"error": "unknown title"}
    token, base = arena._authed()
    if not token:
        return 400, {"error": "not paired"}
    return arena._request("POST", base + "/v1/skills/title", token=token, body={"title": title})


def get_local(arg):
    days = worksignals.report_counts(worksignals.day_counts(REPORT_DAYS))
    with _lock:
        last = dict(_state["lastReport"]) if _state["lastReport"] else None
    return 200, {"enabled": _enabled(), "days": days, "lastReport": last}


GET = {
    "/api/arena/skills": get_skills,
    "/api/skills/local": get_local,
}
POST = {
    "/api/arena/skills/title": post_title,
}


# --- the reporter --------------------------------------------------------------

def report_once(load_config=None, now=None):
    """Send the last seven days' skill counts when paired and opted in. Returns
    the number of POSTs made. Only {day, counts} with the seven categories is
    ever sent; a day already sent with the same counts is skipped."""
    if not _enabled(load_config):
        return 0
    token, base = arena._authed()
    if not token:
        return 0
    days = worksignals.report_counts(worksignals.day_counts(REPORT_DAYS, now=now))
    posted = 0
    ok = True
    code_seen = None
    for day in sorted(days):
        counts = days[day]
        if not any(counts.values()):
            continue
        with _lock:
            if _state["sent"].get(day) == counts:
                continue
        code, _resp = arena._request("POST", base + "/v1/skills/report", token=token,
                                     body={"day": day, "counts": dict(counts)})
        posted += 1
        code_seen = code
        if 200 <= (code or 0) < 300:
            with _lock:
                _state["sent"][day] = dict(counts)
        else:
            ok = False
    with _lock:
        keep = set(days)
        _state["sent"] = {d: v for d, v in _state["sent"].items() if d in keep}
        if posted:
            _state["lastReport"] = {
                "at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "ok": ok, "days": posted, "code": code_seen or 0,
            }
    return posted


def start(ctx):
    """Wire the scanner and start the reporter thread (daemon; errors silent)."""
    ctx = ctx if isinstance(ctx, dict) else {}
    if ctx.get("scan_file") and ctx.get("iter_transcript_paths"):
        worksignals.init(ctx["scan_file"], ctx["iter_transcript_paths"])
    lc = ctx.get("load_config")
    _state["load_config"] = lc

    def loop():
        time.sleep(FIRST_DELAY_SECS)
        last = 0.0
        was_on = False
        while True:
            try:
                # "On" means opted in AND paired; switching on (or pairing)
                # reports at once, then every REPORT_EVERY_SECS.
                on = _enabled(lc) and arena._authed()[0] is not None
                if on and (not was_on or time.time() - last >= REPORT_EVERY_SECS):
                    last = time.time()
                    report_once(lc)
                was_on = on
            except Exception:
                pass
            time.sleep(POLL_SECS)

    t = threading.Thread(target=loop, name="skills-reporter", daemon=True)
    t.start()
    return t
