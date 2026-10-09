"""HQ 2.5 prestige: local proxy routes (stdlib only).

GET  /api/arena/prestige?u=me|<uuid>  -> the Arena's /v1/prestige/me or /v1/prestige/<uuid>
POST /api/arena/prestige/claim        -> /v1/prestige {requestId}

Privacy: the only thing that leaves this machine is the claim's requestId (a
random id minted here when the page sends none or a malformed one).
"""
import re
import uuid

import arena

_RID_RE = re.compile(r"^[A-Za-z0-9_-]{16,64}$")


def get_prestige(arg):
    u = arg("u") or "me"
    if u != "me" and not arena._valid_user_id(u):
        return 400, {"error": "bad user id"}
    token, base = arena._authed()
    if not token:
        return 400, {"error": "not paired"}
    return arena._request("GET", base + "/v1/prestige/" + u, token=token)


def post_claim(body):
    body = body if isinstance(body, dict) else {}
    rid = body.get("requestId")
    if not isinstance(rid, str) or not _RID_RE.match(rid):
        rid = "prestige-" + uuid.uuid4().hex[:24]
    token, base = arena._authed()
    if not token:
        return 400, {"error": "not paired"}
    return arena._request("POST", base + "/v1/prestige", token=token, body={"requestId": rid})


GET = {"/api/arena/prestige": get_prestige}
POST = {"/api/arena/prestige/claim": post_claim}
