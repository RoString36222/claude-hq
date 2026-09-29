"""Token tests for ops/deploy_panel.py.

The panel signs three kinds of token with one HMAC helper: a session cookie,
a CSRF token and an OAuth state. Two properties matter.

Round-trip: a token the panel issues must verify. A CSRF check that can never
pass locks every POST — deploy, rebuild, restart — behind a 403.

Domain separation: the "csrf:" prefix lives *inside* the signed payload so a
stolen session cookie cannot be replayed as a CSRF token, or the reverse. A
verifier that strips the prefix before checking the MAC destroys both
properties at once.

Stdlib only. Run with:
    python3 -m unittest discover -s tests
"""
import importlib.util
import os
import sys
import time
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

# deploy_panel reads its config at import time, so the environment has to be
# set first. It also lives under ops/ rather than being importable by name.
os.environ.setdefault("PANEL_SECRET_KEY", "test-key-not-a-real-secret")
os.environ.setdefault("PANEL_ALLOWED_USERS", "alice,bob")

_spec = importlib.util.spec_from_file_location(
    "deploy_panel", os.path.join(ROOT, "ops", "deploy_panel.py"))
deploy_panel = importlib.util.module_from_spec(_spec)
sys.modules["deploy_panel"] = deploy_panel
_spec.loader.exec_module(deploy_panel)

_sign = deploy_panel._sign
_verify = deploy_panel._verify
TTL = deploy_panel.SESSION_TTL


def session_token(login, ttl=TTL):
    """Exactly what /auth/callback issues."""
    return _sign(f"{login}|{time.time() + ttl}")


def csrf_token(login, ttl=TTL):
    """Exactly what Handler._csrf issues."""
    return _sign(f"csrf:{login}|{time.time() + ttl}")


class RoundTrip(unittest.TestCase):
    def test_session_cookie_verifies(self):
        self.assertEqual(_verify(session_token("alice")), "alice")

    def test_csrf_token_verifies(self):
        # The regression this file exists for: do_POST used to strip the
        # "csrf:" prefix before verifying, so the MAC was recomputed over a
        # different string and no CSRF token could ever be accepted.
        self.assertEqual(_verify(csrf_token("alice"), "csrf"), "alice")

    def test_verifies_for_every_allowed_user(self):
        for login in ("alice", "bob"):
            self.assertEqual(_verify(csrf_token(login), "csrf"), login)


class DomainSeparation(unittest.TestCase):
    def test_csrf_token_is_not_a_session_cookie(self):
        self.assertIsNone(_verify(csrf_token("alice")))

    def test_session_cookie_is_not_a_csrf_token(self):
        self.assertIsNone(_verify(session_token("alice"), "csrf"))

    def test_wrong_purpose_is_rejected(self):
        self.assertIsNone(_verify(csrf_token("alice"), "state"))


class Rejections(unittest.TestCase):
    def test_expired_token(self):
        self.assertIsNone(_verify(csrf_token("alice", ttl=-1), "csrf"))
        self.assertIsNone(_verify(session_token("alice", ttl=-1)))

    def test_tampered_mac(self):
        tok = csrf_token("alice")
        flipped = tok[:-1] + ("0" if tok[-1] != "0" else "1")
        self.assertIsNone(_verify(flipped, "csrf"))

    def test_tampered_login(self):
        # Re-signing is required to change the login; editing it is not enough.
        tok = csrf_token("alice").replace("alice", "bob", 1)
        self.assertIsNone(_verify(tok, "csrf"))

    def test_user_not_in_allowlist(self):
        # Checked on every request, so removing a login revokes it at once.
        self.assertIsNone(_verify(csrf_token("mallory"), "csrf"))

    def test_malformed_tokens(self):
        for junk in ("", "no-dot", "a.b", "|.", "csrf:alice", "....", "x|y.z"):
            with self.subTest(token=junk):
                self.assertIsNone(_verify(junk))
                self.assertIsNone(_verify(junk, "csrf"))


if __name__ == "__main__":
    unittest.main()
