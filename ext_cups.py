"""HQ 2.5 tournaments: the local proxy for the Arena's weekly cups.

Read-only. Every route is a GET that forwards nothing but a validated id, a
season or a user id; no body ever leaves this machine, so nothing from a
transcript can. Wired into dashboard.py through its EXT list (GET map below).

  /api/arena/cups                   -> GET /v1/cups
  /api/arena/cups/one?id=           -> GET /v1/cups/<id>
  /api/arena/cups/season?season=    -> GET /v1/cups/season?season=YYYY-MM
  /api/arena/cups/trophies?u=       -> GET /v1/cups/trophies/<me|uuid>
"""
import re

import arena

# The same shapes the Arena accepts; anything else stops here.
CUP_GAMES = ("kart", "plat", "golf", "fps", "type", "bowl")
CUP_ID_RE = re.compile(r"^cup-\d{4}-W(0[1-9]|[1-4]\d|5[0-3])-(%s)$" % "|".join(CUP_GAMES))
SEASON_RE = re.compile(r"^\d{4}-(0[1-9]|1[0-2])$")


def _get(url_tail):
    token, base = arena._authed()
    if not token:
        return 400, {"error": "not paired"}
    return arena._request("GET", base + url_tail, token=token)


def cups(arg):
    return _get("/v1/cups")


def cup_one(arg):
    cid = arg("id")
    if not CUP_ID_RE.fullmatch(cid):
        return 400, {"error": "bad cup id"}
    return _get("/v1/cups/" + cid)


def season(arg):
    s = arg("season")
    if s and not SEASON_RE.fullmatch(s):
        return 400, {"error": "season must be YYYY-MM"}
    return _get("/v1/cups/season" + ("?season=" + s if s else ""))


def trophies(arg):
    u = arg("u") or "me"
    if u != "me" and not arena.USER_ID_RE.fullmatch(u):
        return 400, {"error": "bad user id"}
    return _get("/v1/cups/trophies/" + u)


GET = {
    "/api/arena/cups": cups,
    "/api/arena/cups/one": cup_one,
    "/api/arena/cups/season": season,
    "/api/arena/cups/trophies": trophies,
}
POST = {}
