"""The local pantry proxy in dashboard.py: request validation, the catalog
effect overlay, the eat flow (state gate, meal ledger, retries) and the local
routes. The Arena is always stubbed; nothing here touches the network.
Stdlib only.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import types
import unittest
import urllib.error
import urllib.request
from datetime import datetime, timezone
from http.server import ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
sys.path.insert(0, HERE)

import arena  # noqa: E402
import dashboard  # noqa: E402
from test_arena import FORBIDDEN_KEYS, _collect_keys  # noqa: E402

SID = "11111111-1111-4111-8111-111111111111"
OTHER_SID = "22222222-2222-4222-8222-222222222222"
RID = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d"

CATALOG = [
    {"kind": "berry", "name": "Berry", "plural": "Berries", "emoji": "\U0001FAD0",
     "price": 1, "restoreMins": 20, "revives": False},
    {"kind": "riceball", "name": "Rice Ball", "plural": "Rice Balls", "emoji": "\U0001F359",
     "price": 2, "restoreMins": 45, "revives": False},
    {"kind": "bento", "name": "Bento", "plural": "Bentos", "emoji": "\U0001F371",
     "price": 3, "restoreMins": 120, "revives": False},
    {"kind": "tonic", "name": "Revive Tonic", "plural": "Revive Tonics", "emoji": "\U0001F9C3",
     "price": 5, "restoreMins": 0, "revives": True},
]


def iso(t):
    return datetime.fromtimestamp(t, tz=timezone.utc).isoformat()


def ago(secs):
    """A whole-second epoch, so it survives the ISO round trip exactly."""
    return float(int(time.time()) - secs)


class PantryBodyTests(unittest.TestCase):
    def ok(self, action, body):
        clean, err = dashboard.pantry_body(action, body)
        self.assertIsNone(err, err)
        self.assertNotIn("sessionId", clean)
        return clean

    def err(self, action, body):
        clean, err = dashboard.pantry_body(action, body)
        self.assertIsNone(clean)
        return err

    def test_claim_is_empty(self):
        self.assertEqual(self.ok("claim", {"requestId": RID, "sessionId": SID}), {})

    def test_unknown_action(self):
        self.assertEqual(self.err("steal", {"requestId": RID}), "unknown pantry action")

    def test_request_id(self):
        for bad in (None, 7, "short", "has a space here!!", "x" * 65, RID + "\n", "claim:2026-09-28"):
            with self.subTest(rid=bad):
                self.assertEqual(self.err("buy", {"requestId": bad, "kind": "berry"}),
                                 "invalid requestId")

    def test_buy(self):
        self.assertEqual(self.ok("buy", {"requestId": RID, "kind": "bento", "sessionId": SID,
                                         "title": "x", "extra": 1}),
                         {"requestId": RID, "kind": "bento", "qty": 1})
        self.assertEqual(self.ok("buy", {"requestId": RID, "kind": "berry", "qty": 5})["qty"], 5)
        self.assertEqual(self.err("buy", {"requestId": RID, "kind": "pizza"}), "unknown food")
        for bad in (True, "2", 0, 6, 1.0, None):
            with self.subTest(qty=bad):
                self.assertEqual(self.err("buy", {"requestId": RID, "kind": "berry", "qty": bad}),
                                 "qty must be a whole number from 1 to 5")

    def test_eat(self):
        self.assertEqual(self.ok("eat", {"requestId": RID, "kind": "tonic", "sessionId": SID,
                                         "retry": True}),
                         {"requestId": RID, "kind": "tonic"})
        self.assertEqual(self.err("eat", {"requestId": RID}), "unknown food")

    def test_give(self):
        clean = self.ok("give", {"requestId": RID, "toHandle": "  gary ", "coins": 2,
                                 "kind": "berry", "qty": 1, "note": "hi", "sessionId": SID})
        self.assertEqual(clean, {"requestId": RID, "toHandle": "gary", "coins": 2,
                                 "kind": "berry", "qty": 1, "note": "hi"})
        coins_only = self.ok("give", {"requestId": RID, "toHandle": "gary", "coins": 5})
        self.assertNotIn("kind", coins_only)
        self.assertEqual((coins_only["qty"], coins_only["note"]), (0, ""))
        self.ok("give", {"requestId": RID, "toHandle": "gary", "kind": "tonic", "qty": 3})

    def test_give_errors(self):
        base = {"requestId": RID, "toHandle": "gary"}
        cases = [
            ({}, "a gift needs Poke Coins or food"),
            ({"coins": 0, "qty": 0}, "a gift needs Poke Coins or food"),
            ({"qty": 1}, "pick a food for that amount"),
            ({"kind": "berry"}, "pick an amount for that food"),
            ({"kind": "berry", "qty": 0, "coins": 1}, "pick an amount for that food"),
            ({"kind": "pizza", "qty": 1}, "unknown food"),
            ({"coins": 6}, "coins must be a whole number from 0 to 5"),
            ({"coins": True}, "coins must be a whole number from 0 to 5"),
            ({"coins": "2"}, "coins must be a whole number from 0 to 5"),
            ({"kind": "berry", "qty": 4}, "qty must be a whole number from 0 to 3"),
            ({"kind": "berry", "qty": True}, "qty must be a whole number from 0 to 3"),
            ({"toHandle": "ga ry", "coins": 1}, "invalid handle"),
            ({"toHandle": "", "coins": 1}, "invalid handle"),
            ({"toHandle": None, "coins": 1}, "invalid handle"),
            ({"toHandle": "x" * 65, "coins": 1}, "invalid handle"),
        ]
        for extra, want in cases:
            with self.subTest(extra=extra):
                self.assertEqual(self.err("give", dict(base, **extra)), want)

    def test_note_is_cleaned_and_clipped(self):
        # Same rule as the server's GiveRequest validator: drop non-printables
        # (tabs and newlines included), then collapse spaces, then clip.
        note = "  for   your \x00sleepy\tVoltkit \x1b" + "z" * 200
        clean = self.ok("give", {"requestId": RID, "toHandle": "gary", "coins": 1, "note": note})
        self.assertEqual(len(clean["note"]), 80)
        self.assertTrue(clean["note"].startswith("for your sleepyVoltkit zz"), clean["note"])
        self.assertTrue(all(c.isprintable() for c in clean["note"]))
        self.assertEqual(self.ok("give", {"requestId": RID, "toHandle": "gary", "coins": 1,
                                          "note": 42})["note"], "")


class OverlayTests(unittest.TestCase):
    def test_overlays_local_effects_and_drops_unknown_kinds(self):
        server = {"coins": 3, "catalog": [dict(c, restoreMins=999) for c in CATALOG]
                  + [{"kind": "pizza", "price": 1}, "junk"]}
        out = dashboard._overlay_food_effects(server)
        self.assertEqual([c["kind"] for c in out["catalog"]],
                         ["berry", "riceball", "bento", "tonic"])
        by = {c["kind"]: c for c in out["catalog"]}
        self.assertEqual((by["berry"]["restoreMins"], by["berry"]["revives"],
                          by["berry"]["wakeToMins"]), (20, False, None))
        self.assertEqual(by["bento"]["restoreMins"], 120)
        self.assertEqual((by["tonic"]["restoreMins"], by["tonic"]["revives"],
                          by["tonic"]["wakeToMins"]), (0, True, 105))
        self.assertEqual(by["riceball"]["price"], 2)      # server fields are kept
        self.assertEqual(out["coins"], 3)
        self.assertEqual(server["catalog"][0]["restoreMins"], 999)  # input not mutated

    def test_elixir_wakes_lower_and_new_fields_pass_through(self):
        server = {"catalog": [
            {"kind": "elixir", "price": 7, "basePrice": 7, "inStock": True, "special": False,
             "season": "all", "restoreMins": 0, "revives": False},
            {"kind": "pumpkinstew", "price": 2, "basePrice": 3, "inStock": True,
             "special": True, "season": "fall"},
            {"kind": "strawberry", "price": 1, "basePrice": 1, "inStock": False,
             "special": False, "season": "spring"}]}
        by = {c["kind"]: c for c in dashboard._overlay_food_effects(server)["catalog"]}
        self.assertEqual((by["elixir"]["restoreMins"], by["elixir"]["revives"],
                          by["elixir"]["wakeToMins"]), (60, True, 45))
        self.assertEqual((by["pumpkinstew"]["restoreMins"], by["pumpkinstew"]["wakeToMins"]),
                         (135, None))
        self.assertEqual((by["pumpkinstew"]["price"], by["pumpkinstew"]["basePrice"],
                          by["pumpkinstew"]["special"], by["pumpkinstew"]["season"]),
                         (2, 3, True, "fall"))
        self.assertIs(by["strawberry"]["inStock"], False)

    def test_passes_through_other_shapes(self):
        for resp in ({"error": "not paired"}, {"catalog": "x"}, [], None):
            self.assertEqual(dashboard._overlay_food_effects(resp), resp)


class RoutesAndConfigTests(unittest.TestCase):
    def test_post_paths_include_the_pantry(self):
        for action in ("claim", "buy", "eat", "give"):
            self.assertIn("/api/arena/pantry/" + action, dashboard.POST_PATHS)
        for old in ("/api/action", "/api/config", "/api/meta", "/api/arena/pair",
                    "/api/arena/unpair", "/api/arena/publish", "/api/arena/ticket",
                    "/api/arena/nudge"):
            self.assertIn(old, dashboard.POST_PATHS)

    def test_creature_fatigue_config(self):
        self.assertIs(dashboard.DEFAULT_CONFIG["creatureFatigue"], True)
        self.assertIs(dashboard._validate_config({})["creatureFatigue"], True)
        self.assertIs(dashboard._validate_config({"creatureFatigue": False})["creatureFatigue"],
                      False)
        self.assertIs(dashboard._validate_config({"creatureFatigue": 0})["creatureFatigue"], False)
        off = dict(dashboard.DEFAULT_CONFIG, creatureFatigue=False)
        # Absent keeps the current value; unknown keys never get in.
        self.assertIs(dashboard._validate_config({"theme": "forest"}, base=off)["creatureFatigue"],
                      False)
        self.assertIs(dashboard._validate_config({"creatureFatigue": "yes"}, base=off)
                      ["creatureFatigue"], True)
        self.assertNotIn("fatigue", dashboard._validate_config({"fatigue": True}))


class PantryEatTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self._orig = {
            "MEALS_PATH": dashboard.MEALS_PATH,
            "PROJECTS_DIR": dashboard.PROJECTS_DIR,
            "load_config": dashboard.load_config,
            "build_payload_memo": dashboard.build_payload_memo,
            "session_fatigue_now": dashboard.session_fatigue_now,
            "record_meal": dashboard.record_meal,
        }
        self._pantry = arena.pantry
        dashboard.MEALS_PATH = os.path.join(self._tmp.name, "meals.json")
        dashboard.PROJECTS_DIR = os.path.join(self._tmp.name, "projects")
        os.makedirs(os.path.join(dashboard.PROJECTS_DIR, "proj"))
        self.state = "tired"
        self.fatigue_on = True
        dashboard.load_config = lambda: dict(dashboard.DEFAULT_CONFIG,
                                             creatureFatigue=self.fatigue_on)
        dashboard.build_payload_memo = self._memo
        dashboard.session_fatigue_now = lambda sess: {"state": "fresh",
                                                      "sid": sess.get("sessionId")}
        self.calls = []
        self.reply = (200, {})
        arena.pantry = self._fake_pantry

    def tearDown(self):
        for k, v in self._orig.items():
            setattr(dashboard, k, v)
        arena.pantry = self._pantry
        dashboard._EAT_INFLIGHT.clear()
        with dashboard._scan_lock:
            for p in [p for p in dashboard._scan_cache if p.startswith(self._tmp.name)]:
                dashboard._scan_cache.pop(p, None)
        self._tmp.cleanup()

    def _transcript(self, sid, busy_mins):
        """A transcript outside the payload (no real prompt, so build_payload
        skips it) whose Claude worked the last `busy_mins` minutes, writing a
        record every few minutes as a real turn does (a turn_duration never
        reaches back across a quiet stretch the page showed as rest)."""
        now = int(time.time())
        path = os.path.join(dashboard.PROJECTS_DIR, "proj", sid + ".jsonl")
        with open(path, "w", encoding="utf-8") as f:
            f.write(json.dumps({"type": "user", "timestamp": iso(now - busy_mins * 60),
                                "message": {"content": "<command-name>/go</command-name>"}})
                    + "\n")
            for m in range(busy_mins - 4, 0, -4):
                f.write(json.dumps({"type": "assistant", "timestamp": iso(now - m * 60),
                                    "message": {"content": [{"type": "text", "text": "step"}]}})
                        + "\n")
            f.write(json.dumps({"type": "system", "subtype": "turn_duration",
                                "durationMs": busy_mins * 60 * 1000,
                                "timestamp": iso(now)}) + "\n")
        return path

    def _memo(self):
        creature = {"species": 3}
        if self.fatigue_on:
            creature["fatigue"] = {"state": self.state}
        return {"sessions": [{"sessionId": SID, "kind": "interactive", "rawStatus": "idle",
                              "creature": creature}]}

    def _fake_pantry(self, action=None, body=None):
        self.calls.append((action, body))
        return self.reply

    def _server_eat(self, kind="berry", at=None, replayed=False):
        at = ago(30) if at is None else at
        return 200, {"op": "eat", "replayed": replayed, "kind": kind, "restoreMins": 20,
                     "revives": False, "at": iso(at), "coins": 4, "catalog": list(CATALOG),
                     "items": {"berry": 0, "riceball": 0, "bento": 0, "tonic": 0}}

    def eat(self, kind="berry", sid=SID, rid=RID, **extra):
        return dashboard.pantry_eat(dict({"sessionId": sid, "kind": kind, "requestId": rid},
                                         **extra))

    def test_invalid_input(self):
        self.assertEqual(self.eat(sid="nope")[0], 400)
        self.assertEqual(self.eat(sid=SID + "\n")[0], 400)
        self.assertEqual(self.eat(rid="bad id")[0], 400)
        self.assertEqual(self.eat(kind="pizza")[0], 400)
        self.assertEqual(self.calls, [])

    def test_unknown_session(self):
        code, resp = self.eat(sid=OTHER_SID)
        self.assertEqual((code, resp), (404, {"error": "unknown session"}))
        self.assertEqual(self.calls, [])

    def test_session_outside_the_payload_eats_by_the_drawers_fatigue(self):
        # The drawer can open a transcript the payload skips (no real prompt,
        # or past the archive cap) and shows its creature.fatigue; the eat gate
        # must judge the same fatigue instead of answering "unknown session".
        self._transcript(OTHER_SID, 80)
        detail = dashboard.build_session_detail(OTHER_SID)
        self.assertEqual(detail["creature"]["fatigue"]["state"], "tired")
        self.reply = self._server_eat("berry")
        code, resp = self.eat("berry", sid=OTHER_SID)
        self.assertEqual(code, 200, resp)
        self.assertEqual(self.calls, [("eat", {"requestId": RID, "kind": "berry"})])
        self.assertEqual(resp["sessionId"], OTHER_SID)
        self.assertEqual([k for _, k in dashboard.load_meals()[OTHER_SID]], ["berry"])
        # The meal shows up in the drawer's fatigue too.
        detail = dashboard.build_session_detail(OTHER_SID)
        self.assertEqual(detail["creature"]["fatigue"]["lastMeal"]["kind"], "berry")

    def test_session_outside_the_payload_keeps_the_gate(self):
        self._transcript(OTHER_SID, 20)          # rested
        code, resp = self.eat("berry", sid=OTHER_SID)
        self.assertEqual((code, resp["code"]), (409, "not_hungry"))
        self.fatigue_on = False
        self.assertNotIn("fatigue", dashboard.build_session_detail(OTHER_SID)["creature"])
        code, resp = self.eat("berry", sid=OTHER_SID)
        self.assertEqual((code, resp["code"]), (409, "fatigue_off"))
        self.assertEqual(self.calls, [])

    def test_state_gate(self):
        cases = [("rested", "berry", "not_hungry"), ("unconscious", "berry", "fainted"),
                 ("unconscious", "bento", "fainted"), ("tired", "tonic", "not_fainted"),
                 ("fatigued", "tonic", "not_fainted"), ("unconscious", "hotpot", "fainted"),
                 ("tired", "elixir", "not_fainted"), ("fatigued", "elixir", "not_fainted"),
                 ("rested", "elixir", "not_hungry")]
        for state, kind, want in cases:
            with self.subTest(state=state, kind=kind):
                self.state = state
                code, resp = self.eat(kind)
                self.assertEqual((code, resp["code"]), (409, want))
                self.assertTrue(resp["error"])
        self.assertEqual(self.calls, [])
        self.assertEqual(dashboard.load_meals(), {})

    def test_fainted_takes_any_revive_item(self):
        for i, kind in enumerate(("tonic", "elixir")):
            with self.subTest(kind=kind):
                self.state = "unconscious"
                rid = RID[:-1] + str(i)
                self.reply = self._server_eat(kind)
                code, resp = self.eat(kind, rid=rid)
                self.assertEqual(code, 200, resp)
                self.assertEqual(self.calls[-1], ("eat", {"requestId": rid, "kind": kind}))
                self.assertEqual(resp["meal"]["revives"], True)
        self.assertEqual(sorted(k for _, k in dashboard.load_meals()[SID]), ["elixir", "tonic"])

    def test_fatigue_off(self):
        self.fatigue_on = False
        code, resp = self.eat()
        self.assertEqual((code, resp["code"]), (409, "fatigue_off"))
        self.assertEqual(self.calls, [])

    def test_success_records_one_meal_and_answers_with_it(self):
        server_at = ago(42)
        self.reply = self._server_eat("berry", at=server_at)
        gen = dashboard._payload_memo["gen"]
        code, resp = self.eat("berry")
        self.assertEqual(code, 200)
        self.assertEqual(self.calls, [("eat", {"requestId": RID, "kind": "berry"})])
        self.assertEqual(resp["sessionId"], SID)
        self.assertEqual(resp["meal"], {"kind": "berry", "at": iso(server_at),
                                        "restoreMins": 20, "revives": False})
        self.assertEqual(resp["fatigue"], {"state": "fresh", "sid": SID})
        self.assertEqual(resp["catalog"][3]["wakeToMins"], 105)  # overlaid
        self.assertEqual(dashboard.load_meals(), {SID: [(server_at, "berry")]})
        self.assertGreater(dashboard._payload_memo["gen"], gen)

        # The same requestId again: a local replay, no network, no second meal.
        code, resp = self.eat("berry")
        self.assertEqual(code, 200)
        self.assertEqual((resp["op"], resp["replayed"], resp["kind"]), ("eat", True, "berry"))
        self.assertEqual(resp["meal"]["at"], iso(server_at))
        self.assertNotIn("coins", resp)
        self.assertEqual(len(self.calls), 1)

        # The same requestId for another session (or food) is refused.
        self.assertEqual(self.eat("berry", sid=OTHER_SID)[1]["code"], "rid_reused")
        self.assertEqual(self.eat("bento")[1]["code"], "rid_reused")
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(len(dashboard.load_meals()[SID]), 1)

    def test_server_time_in_the_future_is_clamped_to_now(self):
        self.reply = self._server_eat("bento", at=time.time() + 3600)
        before = time.time()
        self.assertEqual(self.eat("bento")[0], 200)
        (at, kind), = dashboard.load_meals()[SID]
        self.assertEqual(kind, "bento")
        self.assertTrue(before <= at <= time.time())

    def test_arena_unreachable_is_pending(self):
        for code in (0, 500, 503):
            with self.subTest(code=code):
                self.reply = (code, {"error": "boom"})
                status, resp = self.eat()
                self.assertEqual(status, 202)
                self.assertEqual((resp["pending"], resp["requestId"]), (True, RID))
                self.assertIn("retry", resp["error"])
        self.assertEqual(dashboard.load_meals(), {})

    def test_retry_skips_the_gate_and_keeps_the_original_time(self):
        self.state = "rested"   # the creature rested while the first try was lost
        original = ago(600)
        self.reply = self._server_eat("riceball", at=original, replayed=True)
        code, resp = self.eat("riceball", retry=True)
        self.assertEqual(code, 200)
        self.assertEqual(dashboard.load_meals(), {SID: [(original, "riceball")]})
        self.assertEqual(self.eat("riceball", retry="yes")[0], 200)  # now a local replay

    def test_server_refusal_passes_through(self):
        self.reply = (409, {"detail": "you have no Berries left",
                            "error": "you have no Berries left"})
        self.assertEqual(self.eat(), self.reply)
        self.reply = (404, {"detail": "Not Found", "error": "Not Found"})
        self.assertEqual(self.eat(), self.reply)
        self.assertEqual(dashboard.load_meals(), {})

    def test_unexpected_success_body_is_not_a_meal(self):
        self.reply = self._server_eat("bento")   # asked for a berry
        self.assertEqual(self.eat("berry")[0], 502)
        self.assertEqual(dashboard.load_meals(), {})

    def test_ledger_write_failure_is_pending_then_recorded_once(self):
        def broken(*a, **k):
            raise OSError("disk full")
        dashboard.record_meal = broken
        self.reply = self._server_eat("berry")
        code, resp = self.eat("berry")
        self.assertEqual((code, resp["pending"]), (202, True))
        self.assertEqual(dashboard.load_meals(), {})

        dashboard.record_meal = self._orig["record_meal"]
        self.state = "rested"
        self.assertEqual(self.eat("berry", retry=True)[0], 200)
        self.assertEqual(self.eat("berry", retry=True)[0], 200)
        self.assertEqual(len(dashboard.load_meals()[SID]), 1)
        self.assertEqual(len(self.calls), 2)

    def test_in_flight_duplicate_is_pending(self):
        dashboard._EAT_INFLIGHT.add(RID)
        self.assertEqual(self.eat(), (202, {"pending": True, "requestId": RID}))
        self.assertEqual(self.calls, [])

    def test_old_server_replay_is_recorded_but_outside_the_walk(self):
        old = ago(30 * 3600)
        self.reply = self._server_eat("bento", at=old, replayed=True)
        self.assertEqual(self.eat("bento", retry=True)[0], 200)
        meals = dashboard.load_meals()[SID]
        self.assertEqual(meals, [(old, "bento")])
        now = time.time()
        spans = [[now - 2 * 3600, now]]
        self.assertEqual(dashboard.fatigue_for(SID, spans, now, meals=meals),
                         dashboard.fatigue_for(SID, spans, now))

    def test_wire_never_carries_the_session(self):
        self.reply = self._server_eat("berry")
        self.eat("berry", title="secret", path="/Users/me/x", retry=True)
        for _, body in self.calls:
            self.assertEqual(_collect_keys(body) & FORBIDDEN_KEYS, set())


class LocalRouteTests(unittest.TestCase):
    """The real Handler on an ephemeral 127.0.0.1 port, Arena stubbed."""

    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), dashboard.Handler)
        cls.port = cls.server.server_address[1]
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(5)

    def setUp(self):
        self._pantry = arena.pantry
        self.calls = []
        self.reply = (200, {"coins": 1, "catalog": list(CATALOG)})

        def fake(action=None, body=None):
            self.calls.append((action, body))
            return self.reply
        arena.pantry = fake

    def tearDown(self):
        arena.pantry = self._pantry

    def call(self, method, path, body=None, token=True):
        req = urllib.request.Request(
            "http://127.0.0.1:%d%s" % (self.port, path), method=method,
            data=json.dumps(body).encode("utf-8") if body is not None else None)
        req.add_header("Content-Type", "application/json")
        if token:
            req.add_header("X-HQ-Token", dashboard.CSRF_TOKEN)
        try:
            with self.opener.open(req, timeout=10) as resp:
                return resp.status, json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            try:
                return e.code, json.loads(e.read().decode("utf-8"))
            finally:
                e.close()

    def test_get_pantry_overlays_and_is_read_only(self):
        code, body = self.call("GET", "/api/arena/pantry")
        self.assertEqual(code, 200)
        self.assertEqual(self.calls, [(None, None)])
        self.assertEqual(body["catalog"][3]["wakeToMins"], 105)

    def test_get_passes_errors_through(self):
        self.reply = (404, {"detail": "Not Found", "error": "Not Found"})
        self.assertEqual(self.call("GET", "/api/arena/pantry"), self.reply)
        self.reply = (400, {"error": "not paired"})
        self.assertEqual(self.call("GET", "/api/arena/pantry"), self.reply)
        self.reply = (0, {"error": "timed out"})
        self.assertEqual(self.call("GET", "/api/arena/pantry"), (502, {"error": "timed out"}))

    def test_post_buy_forwards_the_clean_body(self):
        code, body = self.call("POST", "/api/arena/pantry/buy",
                               {"requestId": RID, "kind": "bento", "sessionId": SID})
        self.assertEqual(code, 200)
        self.assertEqual(self.calls, [("buy", {"requestId": RID, "kind": "bento", "qty": 1})])
        self.assertEqual(body["catalog"][0]["restoreMins"], 20)

    def test_post_claim_and_give(self):
        self.assertEqual(self.call("POST", "/api/arena/pantry/claim", {})[0], 200)
        self.assertEqual(self.call("POST", "/api/arena/pantry/give",
                                   {"requestId": RID, "toHandle": "gary", "coins": 1})[0], 200)
        self.assertEqual([c[0] for c in self.calls], ["claim", "give"])

    def test_post_validation_and_network_failures(self):
        code, body = self.call("POST", "/api/arena/pantry/buy", {"requestId": RID,
                                                                 "kind": "berry", "qty": 9})
        self.assertEqual((code, body), (400, {"error": "qty must be a whole number from 1 to 5"}))
        self.reply = (0, {"error": "timed out"})
        self.assertEqual(self.call("POST", "/api/arena/pantry/claim", {}),
                         (502, {"error": "timed out"}))
        self.assertEqual([c[0] for c in self.calls], ["claim"])

    def test_unknown_pantry_path_is_a_local_404(self):
        self.assertEqual(self.call("POST", "/api/arena/pantry/steal", {}),
                         (404, {"error": "not found"}))
        self.assertEqual(self.calls, [])

    def test_post_requires_the_csrf_token(self):
        code, _ = self.call("POST", "/api/arena/pantry/claim", {}, token=False)
        self.assertEqual(code, 403)
        self.assertEqual(self.calls, [])


class NotifyTests(unittest.TestCase):
    def setUp(self):
        self._sp = dashboard.subprocess
        self.argv = []
        dashboard.subprocess = types.SimpleNamespace(
            run=lambda argv, **kw: self.argv.append(argv), DEVNULL=subprocess.DEVNULL)

    def tearDown(self):
        dashboard.subprocess = self._sp

    def test_sound_and_silent(self):
        dashboard._notify("\U0001F44B Ash nudged you", "Ash nudged you: hi")
        dashboard._notify("\U0001F381 Gary sent you a gift", "2 Poke Coins", False)
        loud, quiet = self.argv[0][2], self.argv[1][2]
        self.assertTrue(loud.endswith(' sound name "Ping"'))
        self.assertNotIn("sound name", quiet)
        self.assertIn("\U0001F381 Gary sent you a gift", quiet)
        self.assertNotIn("\\u", loud + quiet)

    def test_quotes_cannot_break_out(self):
        s = dashboard._applescript_str('a "quoted" \\ note\x07\n')
        self.assertEqual(s, '"a \\"quoted\\" \\\\ note"')

    @unittest.skipUnless(sys.platform == "darwin" and shutil.which("osascript"), "macOS only")
    def test_applescript_parses_emoji_titles(self):
        # `return` parses the literal without showing a notification.
        title = '\U0001F381 Gary "G" sent you a gift \\ é'
        out = subprocess.run(["osascript", "-e", "return " + dashboard._applescript_str(title)],
                             capture_output=True, text=True, timeout=20)
        self.assertEqual(out.stdout.rstrip("\n"), title, out.stderr)


if __name__ == "__main__":
    unittest.main()
