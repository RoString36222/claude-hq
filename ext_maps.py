"""Local proxy for the Arena map gallery (HQ 2.5 Workshop).

The page calls these; the device token stays here. What leaves the machine on
a save is exactly {id?, kind, name, data, scope, roomId?}: the map's kind, the
name its maker typed, the map geometry, and where it is shared. Likes, reports,
deletes and hides send a map id plus a flag or a reason word. Nothing here ever
reads a transcript.

GET  /api/arena/maps            ?kind&sort&room&mine&ckey&cursor&limit
GET  /api/arena/maps/one        ?id=m-<12 hex>
GET  /api/arena/maps/featured
POST /api/arena/maps/save       {id?, kind, name, data, scope, roomId?}
POST /api/arena/maps/like       {id, on}
POST /api/arena/maps/report     {id, reason}
POST /api/arena/maps/delete     {id}
POST /api/arena/maps/hide       {id, hidden}

stdlib only.
"""
import json
import re
import urllib.parse

import arena

MAP_ID_RE = re.compile(r"^m-[0-9a-f]{12}$")
CKEY_RE = re.compile(r"^c-[0-9a-f]{12}$")
ROOM_RE = re.compile(
    r"^(hq_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|r_[A-Za-z0-9_-]{22})$")
CURSOR_RE = re.compile(r"^[0-9a-f]{2,400}$")
KINDS = ("kart", "plat", "fps")
SCOPES = ("private", "room", "public")
SORTS = ("new", "top", "week")
REASONS = ("spam", "offensive", "broken", "other")
MAX_DATA = 12 * 1024
MAX_NAME = 32
SAVE_KEYS = ("id", "kind", "name", "data", "scope", "roomId")
# Keys that must never travel in a body, at any depth (tests/test_arena.py).
# No map format uses them, so a map carrying one is refused, not trimmed.
FORBIDDEN = frozenset((
    "prompt", "prompts_text", "reply", "text", "content", "path", "paths", "cwd", "folder",
    "project", "projectName", "sessionId", "sessionTitle", "title", "file", "files"))


def _keys(v, depth=0):
    if depth > 12:
        return {"<deep>"}
    out = set()
    if isinstance(v, dict):
        for k, x in v.items():
            out.add(k)
            out |= _keys(x, depth + 1)
    elif isinstance(v, list):
        for x in v:
            out |= _keys(x, depth + 1)
    return out


def clean_name(raw):
    """The name as the Arena will store it, or None when it would be refused
    there (empty, too long, markup, a link, control characters)."""
    if not isinstance(raw, str):
        return None
    s = raw.strip()
    if not s or len(s) > MAX_NAME:
        return None
    low = s.lower()
    if "<" in s or ">" in s or "http" in low or "www." in low:
        return None
    if any(ord(c) < 32 or 127 <= ord(c) < 160 for c in s):
        return None
    return s


def _authed():
    token, base = arena._authed()
    if not token:
        return None, None
    return token, base.rstrip("/")


def _not_paired():
    return 400, {"error": "not paired"}


def _bad(msg):
    return 400, {"error": msg}


# ------------------------------------------------------------------ reads --

def list_maps(arg):
    token, base = _authed()
    if not token:
        return _not_paired()
    q = {}
    kind = arg("kind")
    if kind:
        if kind not in KINDS:
            return _bad("bad kind")
        q["kind"] = kind
    sort = arg("sort")
    if sort:
        if sort not in SORTS:
            return _bad("bad sort")
        q["sort"] = sort
    room = arg("room")
    if room:
        if not ROOM_RE.fullmatch(room):
            return _bad("bad room")
        q["room"] = room
    if arg("mine") == "1":
        q["mine"] = "1"
    ckey = arg("ckey")
    if ckey:
        if not CKEY_RE.fullmatch(ckey):
            return _bad("bad ckey")
        q["ckey"] = ckey
    cursor = arg("cursor")
    if cursor:
        if not CURSOR_RE.fullmatch(cursor):
            return _bad("bad cursor")
        q["cursor"] = cursor
    limit = arg("limit")
    if limit:
        if not limit.isdigit() or not 1 <= int(limit) <= 30:
            return _bad("bad limit")
        q["limit"] = str(int(limit))
    if "mine" in q and "room" in q:
        return _bad("pick mine or room")
    url = base + "/v1/maps" + ("?" + urllib.parse.urlencode(q) if q else "")
    return arena._request("GET", url, token=token)


def one_map(arg):
    token, base = _authed()
    if not token:
        return _not_paired()
    mid = arg("id")
    if not MAP_ID_RE.fullmatch(mid or ""):
        return _bad("bad map id")
    return arena._request("GET", base + "/v1/maps/" + mid, token=token)


def featured(arg):
    token, base = _authed()
    if not token:
        return _not_paired()
    return arena._request("GET", base + "/v1/maps/featured", token=token)


# ----------------------------------------------------------------- writes --

def save_body(body):
    """The exact body forwarded for a save, or (None, error)."""
    if not isinstance(body, dict):
        return None, "bad body"
    extra = set(body) - set(SAVE_KEYS)
    if extra:
        return None, "unexpected field"
    out = {}
    mid = body.get("id")
    if mid is not None:
        if not isinstance(mid, str) or not MAP_ID_RE.fullmatch(mid):
            return None, "bad map id"
        out["id"] = mid
    kind = body.get("kind")
    if kind not in KINDS:
        return None, "bad kind"
    out["kind"] = kind
    name = clean_name(body.get("name"))
    if name is None:
        return None, "names are 1-32 characters, with no links or < >"
    out["name"] = name
    data = body.get("data")
    if not isinstance(data, dict):
        return None, "data must be an object"
    try:
        size = len(json.dumps(data, separators=(",", ":"), ensure_ascii=False).encode("utf-8"))
    except (TypeError, ValueError):
        return None, "bad map data"
    if size > MAX_DATA:
        return None, "map data is over 12 KiB"
    if _keys(data) & (FORBIDDEN | {"<deep>"}):
        return None, "map data has a field maps don't use"
    out["data"] = data
    scope = body.get("scope")
    if scope not in SCOPES:
        return None, "bad scope"
    out["scope"] = scope
    room = body.get("roomId")
    if scope == "room":
        if not isinstance(room, str) or not ROOM_RE.fullmatch(room):
            return None, "bad room"
        out["roomId"] = room
    elif room is not None:
        return None, "roomId goes with scope room"
    return out, None


def save(body):
    token, base = _authed()
    if not token:
        return _not_paired()
    clean, err = save_body(body)
    if err:
        return _bad(err)
    return arena._request("POST", base + "/v1/maps", token=token, body=clean)


def _id_of(body):
    mid = body.get("id") if isinstance(body, dict) else None
    return mid if isinstance(mid, str) and MAP_ID_RE.fullmatch(mid) else None


def _flag(body, key):
    v = body.get(key) if isinstance(body, dict) else None
    return v if isinstance(v, bool) else None


def like(body):
    token, base = _authed()
    if not token:
        return _not_paired()
    mid, on = _id_of(body), _flag(body, "on")
    if not mid or on is None:
        return _bad("bad like")
    return arena._request("POST", base + "/v1/maps/" + mid + "/like", token=token, body={"on": on})


def report(body):
    token, base = _authed()
    if not token:
        return _not_paired()
    mid = _id_of(body)
    reason = body.get("reason") if isinstance(body, dict) else None
    if not mid or reason not in REASONS:
        return _bad("bad report")
    return arena._request("POST", base + "/v1/maps/" + mid + "/report", token=token,
                          body={"reason": reason})


def delete(body):
    token, base = _authed()
    if not token:
        return _not_paired()
    mid = _id_of(body)
    if not mid:
        return _bad("bad map id")
    return arena._request("POST", base + "/v1/maps/" + mid + "/delete", token=token, body={})


def hide(body):
    token, base = _authed()
    if not token:
        return _not_paired()
    mid, hidden = _id_of(body), _flag(body, "hidden")
    if not mid or hidden is None:
        return _bad("bad hide")
    return arena._request("POST", base + "/v1/maps/" + mid + "/hide", token=token,
                          body={"hidden": hidden})


GET = {
    "/api/arena/maps": list_maps,
    "/api/arena/maps/one": one_map,
    "/api/arena/maps/featured": featured,
}

POST = {
    "/api/arena/maps/save": save,
    "/api/arena/maps/like": like,
    "/api/arena/maps/report": report,
    "/api/arena/maps/delete": delete,
    "/api/arena/maps/hide": hide,
}
