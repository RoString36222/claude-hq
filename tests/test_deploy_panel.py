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


# A colourised line exactly as ops/release.sh's say() prints it.
def say(text):
    return "\x1b[1;34m==>\x1b[0m " + text


RUN = "\n".join([
    "2026-10-09T06:50:01Z  new commits 4133b25 -> 843e4c6",
    "2026-10-09T06:50:01Z  releasing with ops/release.sh (impl from backend/.release.env)",
    say("Fetching main"),
    "    \x1b[32m✓\x1b[0m at 843e4c6: Merge pull request #96",
    say("Checking GitHub CI for 843e4c6"),
    say("Building rs 2026.10.09-843e4c6"),
]) + "\n"


class DeployProgress(unittest.TestCase):
    """The progress bar reads release.sh's own stage announcements.

    A bar that runs on a timer is worse than no bar on a console someone
    watches during an incident: it keeps climbing while the deploy is wedged,
    and it reaches 100% on a release that failed. Every number here comes from
    a stage that has actually been announced.
    """

    def p(self, text):
        return deploy_panel.parse_progress(text)

    def test_it_counts_the_stages_that_have_happened(self):
        r = self.p(RUN)
        self.assertEqual((r["phase"], r["idx"], r["pct"], r["state"]),
                         ("BUILD", 3, 50, "running"))

    def test_colour_escapes_do_not_hide_a_stage(self):
        """say() colourises, so an unstripped parser sees no stages at all."""
        self.assertIn("\x1b[", RUN)
        self.assertEqual(self.p(RUN)["idx"], 3)

    def test_a_finished_release_reads_as_done(self):
        r = self.p(RUN + say("Starting rs v") + "\n" + say("Released 2026.10.09-843e4c6 (rs)") + "\n")
        self.assertEqual((r["state"], r["pct"]), ("ok", 100))

    def test_a_failed_release_freezes_where_it_got_to(self):
        """The property that matters most: a failure must NOT read as finished."""
        r = self.p(RUN + "    \x1b[31m✗\x1b[0m build failed\n"
                   + say("Rolling back to 2026.10.08-4133b25 (rs)") + "\n")
        self.assertEqual(r["state"], "fail")
        self.assertEqual(r["pct"], 50)
        self.assertLess(r["pct"], 100)

    def test_an_earlier_run_in_the_log_does_not_count(self):
        """The log is appended to forever; only the newest run is the subject."""
        old = RUN + say("Released 2026.10.08-old (rs)") + "\n"
        r = self.p(old + RUN)
        self.assertEqual((r["idx"], r["state"]), (3, "running"))

    def test_nothing_yet_is_indeterminate_rather_than_zero_percent(self):
        for text in ("", "2026-10-09T06:50:01Z  new commits a -> b\n"):
            r = self.p(text)
            self.assertEqual(r["idx"], 0)
            self.assertEqual(r["pct"], 0)
            self.assertIsNone(r["phase"])

    def test_a_skipped_stage_does_not_stall_the_bar(self):
        """A Python release runs no migration, so MIGRATE never appears."""
        r = self.p(RUN + say("Starting py 2026.10.09-843e4c6") + "\n")
        self.assertEqual((r["phase"], r["pct"]), ("START", 83))

    def test_an_unrelated_stage_line_does_not_un_advance(self):
        """release.sh prints ==> lines that are not stages (a rollback banner,
        the status report). None may drag the bar back."""
        r = self.p(RUN + say("Rolling back to 2026.10.08-4133b25 (rs)") + "\n")
        self.assertEqual(r["idx"], 3)

    def test_a_second_fetch_is_a_new_run_and_resets(self):
        """Not a contradiction of the above: ==> Fetching only ever starts a
        release, so seeing it again means a SECOND deploy began. The bar has to
        follow the new one rather than keep showing the old one's progress."""
        r = self.p(RUN + say("Fetching main") + "\n")
        self.assertEqual((r["phase"], r["idx"], r["state"]), ("FETCH", 1, "running"))


class ReleasedShaTests(unittest.TestCase):
    """The panel's "running" is the released commit, not the checkout's HEAD."""

    def test_reads_the_sha_off_the_release_version(self):
        env = "# Written by ops/release.sh\nARENA_IMPL=rs\nARENA_VERSION=2026.10.08-dd04883\nARENA_APP_IMAGE=x\n"
        self.assertEqual(deploy_panel.released_sha(env), "dd04883")

    def test_no_release_yet_is_empty(self):
        self.assertEqual(deploy_panel.released_sha(""), "")
        self.assertEqual(deploy_panel.released_sha("ARENA_VERSION=local\n"), "")
        self.assertEqual(deploy_panel.released_sha(None), "")
