"""World boss (HQ 2.5): the local proxy for /v1/boss on the paired Arena.

Stdlib only. dashboard.py loads this as an EXT module (see its EXT list) and
routes the paths below to it; nothing else in the HQ talks to /v1/boss.

Privacy: the only thing a fight sends is the team, as battle specs
{sp, st, br, mg, sh} (species slot, stage, branch, mega key, shiny), rebuilt
here from an explicit key allowlist with every field type-checked, plus a
request id. No name, session, path or other transcript-derived value can ride
along: an unknown key is refused, never forwarded. The PR drain reuses the
counts loot already reports; this module sends none.
"""

import re
import uuid

import arena

TEAM_MAX = 6
SPEC_KEYS = ("sp", "st", "br", "mg", "sh")
_RID_RE = re.compile(r"^[A-Za-z0-9_-]{16,64}$")
_MEGA_RE = re.compile(r"^[a-z0-9-]{1,32}$")


def _is_int(v):
    return isinstance(v, int) and not isinstance(v, bool)


def clean_team(team):
    """A list of 1..6 specs with EXACTLY the keys {sp, st, br, mg, sh}, or None.

    sp/st are ints, br an int or null, mg a mega key or null, sh a bool (or 0/1).
    The server clamps the stage and range-checks the species again; this is the
    privacy filter, not the game rule."""
    if not isinstance(team, list) or not 1 <= len(team) <= TEAM_MAX:
        return None
    out = []
    for t in team:
        if not isinstance(t, dict) or set(t) != set(SPEC_KEYS):
            return None
        sp, st, br, mg, sh = (t[k] for k in SPEC_KEYS)
        if not (_is_int(sp) and 0 <= sp < 1000 and _is_int(st) and 0 <= st <= 4):
            return None
        if br is not None and not (_is_int(br) and 0 < br < 2000):
            return None
        if mg is not None and not (isinstance(mg, str) and _MEGA_RE.fullmatch(mg)):
            return None
        if isinstance(sh, bool):
            pass
        elif _is_int(sh) and sh in (0, 1):
            sh = bool(sh)
        else:
            return None
        out.append({"sp": sp, "st": st, "br": br, "mg": mg, "sh": sh})
    return out


def boss_state():
    token, base = arena._authed()
    if not token:
        return 400, {"error": "not paired"}
    return arena._request("GET", base + "/v1/boss", token=token)


def boss_badges(user):
    token, base = arena._authed()
    if not token:
        return 400, {"error": "not paired"}
    user = user or "me"
    if user != "me" and not arena._valid_user_id(user):
        return 400, {"error": "bad user id"}
    return arena._request("GET", base + "/v1/boss/badges/" + user, token=token)


def boss_fight(body):
    token, base = arena._authed()
    if not token:
        return 400, {"error": "not paired"}
    body = body if isinstance(body, dict) else {}
    team = clean_team(body.get("team"))
    if team is None:
        return 400, {"error": "pick 1 to 6 Pokémon"}
    rid = body.get("requestId")
    if rid is None:
        rid = "boss-" + uuid.uuid4().hex
    if not isinstance(rid, str) or not _RID_RE.fullmatch(rid):
        return 400, {"error": "bad request id"}
    return arena._request("POST", base + "/v1/boss/fight", token=token,
                          body={"requestId": rid, "team": team})


GET = {
    "/api/arena/boss": lambda arg: boss_state(),
    "/api/arena/boss/badges": lambda arg: boss_badges(arg("u")),
}

POST = {
    "/api/arena/boss/fight": boss_fight,
}
