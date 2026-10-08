"""Room-socket parity: drive a live Arena and check the frames it sends back.

The same checks run against either implementation, so a divergence shows up as
a FAIL on one side and a PASS on the other rather than as a reading of two
transcripts:

    (cd backend-rs && cargo build)
    uv run python scripts/socket_parity.py              # the Rust Arena
    IMPL=py uv run python scripts/socket_parity.py      # the Python Arena

It starts its own server on a throwaway database (schema from the Rust baseline
migration, which was generated from the Alembic head), makes two users with
device tokens, and exercises presence, nudges, WebRTC signalling, lobby chat
(cleaning, the rate limit and the backlog a joiner catches up on), unknown
message types, the loadtest stats route and the Quick Play queue.

Where the two are deliberately different the check says so and asserts both
sides: today that is Mini Golf, which Python referees and the Rust Arena does
not yet, so Rust must refuse the queue rather than match people into a room
where no game ever starts.

PORT= picks the port (default 8791). The server log is kept, and printed on
a failure.
"""
import asyncio, hashlib, json, os, sqlite3, subprocess, sys, tempfile, time, uuid
import httpx, websockets

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
IMPL = os.environ.get("IMPL", "rs")
PORT = int(os.environ.get("PORT", "8791"))
BASE = f"http://127.0.0.1:{PORT}"
WS = f"ws://127.0.0.1:{PORT}"

def mkuser(db, handle, gh):
    uid = str(uuid.uuid4())
    tok = "hqd_test_" + handle
    h = hashlib.sha256(tok.encode()).hexdigest()
    c = sqlite3.connect(db)
    c.execute("INSERT INTO users (id,github_id,handle,display_name,avatar_url,trainer_name,"
              "is_active,created_at) VALUES (?,?,?,?,'','',1,datetime('now'))",
              (uid, gh, handle, handle.title()))
    c.execute("INSERT INTO devices (id,user_id,token_hash,label,revoked) VALUES (?,?,?,'t',0)",
              (str(uuid.uuid4()), uid, h))
    c.commit(); c.close()
    return uid, tok

async def ticket(tok):
    async with httpx.AsyncClient(base_url=BASE) as c:
        r = await c.post("/v1/auth/ticket", headers={"Authorization": f"Bearer {tok}"})
        r.raise_for_status()
        return r.json()["ticket"]

async def recv(ws, timeout=1.0):
    out = []
    while True:
        try:
            out.append(json.loads(await asyncio.wait_for(ws.recv(), timeout)))
        except (asyncio.TimeoutError, websockets.ConnectionClosed):
            return out

FAILS = []
def check(name, ok, detail=""):
    print(("  PASS  " if ok else "  FAIL  ") + name + (f"   {detail}" if detail and not ok else ""))
    if not ok:
        FAILS.append(name)

async def main():
    tmp = tempfile.mkdtemp(prefix="arena-parity-")
    db = os.path.join(tmp, "a.db")
    # One schema for both: the Rust baseline migration, which was generated
    # from the Alembic head and is all CREATE ... IF NOT EXISTS.
    sqlite3.connect(db).executescript(
        open(f"{REPO}/backend-rs/migrations/0001_baseline.sql").read())
    url = f"sqlite+aiosqlite:///{db}" if IMPL == "py" else f"sqlite:///{db}"
    env = dict(os.environ, ARENA_DATABASE_URL=url, ARENA_BIND_PORT=str(PORT),
               ARENA_BIND_HOST="127.0.0.1", ARENA_SECRET_KEY="parity-secret",
               ARENA_EXPOSE_REALTIME_STATS="1", RUST_LOG="warn")
    log = open(os.path.join(tmp, "server.log"), "w")
    if IMPL == "py":
        cmd = ["uv", "run", "--no-dev", "uvicorn", "app.main:app", "--host", "127.0.0.1",
               "--port", str(PORT), "--log-level", "warning"]
        cwd = f"{REPO}/backend"
    else:
        cmd = [f"{REPO}/backend-rs/target/debug/arena"]
        cwd = f"{REPO}/backend-rs"
    print(f"--- {IMPL} ---")
    proc = subprocess.Popen(cmd, env=env, cwd=cwd, stderr=log, stdout=log)
    try:
        for _ in range(200):
            try:
                if httpx.get(BASE + "/health", timeout=0.5).status_code == 200:
                    break
            except Exception:
                pass
            time.sleep(0.1)
        else:
            sys.exit("server never came up: " + open(os.path.join(tmp, "server.log")).read())

        u1, t1 = mkuser(db, "ada", 9001)
        u2, t2 = mkuser(db, "linus", 9002)
        k1, k2 = await ticket(t1), await ticket(t2)
        room = "lobby"

        async with websockets.connect(f"{WS}/v1/rooms/{room}/ws?ticket={k1}") as a:
            w1 = json.loads(await a.recv())
            check("welcome carries a chat backlog", w1.get("chat") == [], repr(w1.get("chat")))
            async with websockets.connect(f"{WS}/v1/rooms/{room}/ws?ticket={k2}") as b:
                w2 = json.loads(await b.recv())
                await recv(a, 0.3)   # drain the join event

                # --- nudge -------------------------------------------------
                await a.send(json.dumps({"type": "nudge", "to": u2, "note": "come look\x07"}))
                got_b, got_a = await recv(b, 0.6), await recv(a, 0.6)
                nud = [m for m in got_b if m.get("type") == "nudge"]
                ack = [m for m in got_a if m.get("type") == "nudge_ack"]
                check("nudge reaches the target", len(nud) == 1, repr(got_b))
                check("nudge note is stripped of control chars",
                      nud and nud[0]["note"] == "come look", repr(nud))
                check("nudge names the sender", nud and nud[0]["from"]["userId"] == u1)
                check("nudge_ack reports one delivery",
                      ack == [{"type": "nudge_ack", "to": u2, "delivered": 1}], repr(ack))
                check("the sender does not receive its own nudge",
                      not [m for m in got_a if m.get("type") == "nudge"])

                await a.send(json.dumps({"type": "nudge"}))
                e = await recv(a, 0.5)
                check("a nudge with no target is an error",
                      e == [{"type": "error", "error": "nudge needs a target userId"}], repr(e))

                # --- signal ------------------------------------------------
                await b.send(json.dumps({"type": "signal", "to": u1, "data": {"sdp": "v=0"}}))
                got_a, got_b = await recv(a, 0.6), await recv(b, 0.4)
                sig = [m for m in got_a if m.get("type") == "signal"]
                check("signal reaches only the target",
                      len(sig) == 1 and sig[0]["data"] == {"sdp": "v=0"}, repr(got_a))
                check("signal is never echoed to the sender",
                      not [m for m in got_b if m.get("type") == "signal"], repr(got_b))
                check("signal names the sender", sig and sig[0]["from"]["userId"] == u2)

                await b.send(json.dumps({"type": "signal", "to": u1}))
                e = await recv(b, 0.5)
                check("a signal with no data is an error",
                      e == [{"type": "error", "error": "signal data must be an object"}], repr(e))
                await b.send(json.dumps({"type": "signal", "data": {}}))
                e = await recv(b, 0.5)
                check("a signal with no target is an error",
                      e == [{"type": "error", "error": "signal needs a target userId"}], repr(e))

                # --- chat --------------------------------------------------
                await a.send(json.dumps({"type": "say",
                                         "data": {"kind": "chat", "text": "  hi\tthere\n\nall  "}}))
                got_b = await recv(b, 0.6)
                await recv(a, 0.3)
                chat = [m for m in got_b if m.get("type") == "say"]
                check("chat text is cleaned and folded",
                      chat and chat[0]["data"] == {"kind": "chat", "text": "hi there all"}, repr(chat))
                check("chat carries a server id and timestamp",
                      chat and len(chat[0].get("id", "")) == 12
                      and chat[0].get("at", "").endswith("+00:00"), repr(chat))

                await a.send(json.dumps({"type": "say", "data": {"kind": "chat", "text": "   "}}))
                e = await recv(a, 0.5)
                check("an empty chat message is an error",
                      e == [{"type": "error", "error": "chat: empty message"}], repr(e))
                await a.send(json.dumps({"type": "say", "data": {"kind": "chat", "text": 7}}))
                e = await recv(a, 0.5)
                check("a non-string chat message is an error",
                      e == [{"type": "error", "error": "chat: text must be a string"}], repr(e))

                for i in range(9):
                    await a.send(json.dumps({"type": "say", "data": {"kind": "chat", "text": f"m{i}"}}))
                got_a = await recv(a, 0.8)
                errs = [m for m in got_a if m.get("type") == "error"]
                check("the ninth message in ten seconds is rate-limited",
                      len(errs) == 2 and errs[0]["error"]
                      == "chat: slow down — at most 8 messages every 10 seconds",
                      repr(errs))
                await recv(b, 0.4)

                # --- unknown type ------------------------------------------
                await a.send(json.dumps({"type": "wat"}))
                e = await recv(a, 0.5)
                check("an unknown message type is answered",
                      e == [{"type": "error", "error": "unknown message type: 'wat'"}], repr(e))

            # --- chat history for a joiner ---------------------------------
            k3 = await ticket(t2)
            async with websockets.connect(f"{WS}/v1/rooms/{room}/ws?ticket={k3}") as c:
                w3 = json.loads(await c.recv())
                texts = [m["data"]["text"] for m in w3.get("chat", [])]
                # Eight: the allowance is 8 per 10s and ten chats were sent,
                # so the last two were refused and never stored.
                check("a joiner catches up on the backlog, oldest first",
                      texts == ["hi there all"] + [f"m{i}" for i in range(7)], repr(texts))

        # --- the env-gated loadtest route ---------------------------------
        async with httpx.AsyncClient(base_url=BASE) as c:
            r = await c.get("/v1/realtime/stats")
            check("GET /v1/realtime/stats answers when the flag is set",
                  r.status_code == 200 and set(r.json()) == {"running", "max", "rooms"},
                  f"{r.status_code} {r.text[:120]}")
            r = await c.post("/v1/quickplay/join", json={"game": "golf"},
                             headers={"Authorization": f"Bearer {t1}"})
            # The one deliberate divergence: Python referees Mini Golf, this
            # Rust build does not, so it must refuse the queue instead of
            # matching people into a room where nothing ever starts.
            if IMPL == "py":
                check("Quick Play queues Golf on an Arena that runs it",
                      r.json().get("state") == "waiting", f"{r.status_code} {r.text[:160]}")
            else:
                check("Quick Play refuses a game this Arena cannot run",
                      r.status_code == 200 and r.json().get("state") == "error"
                      and "Golf" not in r.json().get("error", ""),
                      f"{r.status_code} {r.text[:160]}")
            r = await c.post("/v1/quickplay/join", json={"game": "kart"},
                             headers={"Authorization": f"Bearer {t1}"})
            check("Quick Play still queues a game it can run",
                  r.status_code == 200 and r.json().get("state") == "waiting",
                  f"{r.status_code} {r.text[:160]}")
    finally:
        proc.terminate()
        try:
            proc.wait(5)
        except subprocess.TimeoutExpired:
            proc.kill()
        log.close()
    print()
    if FAILS:
        print(f"{len(FAILS)} failed: " + ", ".join(FAILS))
        print("--- server log ---")
        print(open(os.path.join(tmp, "server.log")).read()[-2000:])
        sys.exit(1)
    print("all checks passed")

asyncio.run(main())
