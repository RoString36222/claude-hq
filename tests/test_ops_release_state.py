"""No ops script may start or rebuild the Arena without the release state.

ops/release.sh records which implementation is live in backend/.release.env and
layers it with --env-file. Compose reads only backend/.env on its own, so a bare
`docker compose up` falls back to the defaults in docker-compose.yml --
claude-hq-arena-py:local, built from backend/Dockerfile. On a host running the
Rust Arena that silently brings the Python one back, and nothing alerts, because
the Python Arena is healthy too.

That is exactly what ops/autodeploy.sh did: every push to main undid a Rust
release. Layering the env file is not sufficient either -- ARENA_APP_IMAGE is a
stamped tag, and `up --build` would build a new commit into the previous
release's tag, which makes `release.sh status` lie and `release.sh rollback`
restore a tag that already holds the newer code.

So: either delegate to ops/release.sh, or pass both --env-files, or name
services that are not `app`. This test allows those three and nothing else.
"""
import os
import re
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OPS = os.path.join(ROOT, "ops")

# release.sh is the one script allowed to drive compose freely: it is what
# writes the release state in the first place.
OWNER = "release.sh"


def ops_sources():
    for name in sorted(os.listdir(OPS)):
        if not name.endswith((".sh", ".py")) or name == OWNER:
            continue
        with open(os.path.join(OPS, name), encoding="utf-8") as f:
            yield name, f.read()


def strip_noise(text, is_python):
    """Comments and (for shell) log/echo lines, so prose about the bug does not
    read as the bug."""
    out = []
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("#"):
            continue
        if not is_python and re.match(r"^(log|info|echo|warn|say|ok|die)\b", stripped):
            continue
        out.append(line)
    return "\n".join(out)


class OpsRespectTheReleaseState(unittest.TestCase):
    def test_no_script_brings_up_app_from_compose_defaults(self):
        for name, src in ops_sources():
            body = strip_noise(src, name.endswith(".py"))
            # Every compose invocation that could create or rebuild a container.
            for m in re.finditer(r"docker[\s,\"']+compose(.{0,200}?)(?:\n|$)", body):
                call = m.group(1)
                if not re.search(r"\b(up|run|build|create)\b", call):
                    continue          # ps / logs / stop / exec cannot change the image
                with self.subTest(script=name, call=call.strip()[:90]):
                    layered = ".release.env" in call or "--env-file" in call
                    # A call that names only non-app services cannot replace the
                    # Arena. `up -d` with no service name brings up everything.
                    named = re.search(r"\b(panel|caddy|migrate)\b", call) and \
                        not re.search(r"\bapp\b", call)
                    self.assertTrue(
                        layered or named,
                        f"{name} drives compose without the release state; it would "
                        f"rebuild the Arena from docker-compose.yml's Python defaults",
                    )

    def test_the_dc_helpers_layer_both_env_files(self):
        """A script with a dc() wrapper must layer .env AND .release.env."""
        for name, src in ops_sources():
            if not re.search(r"^dc\(\)", src, re.M):
                continue
            with self.subTest(script=name):
                self.assertIn(".release.env", src, f"{name}'s dc() ignores the release state")
                self.assertIn("/.env", src, f"{name}'s dc() drops .env, which holds the secrets")

    def test_autodeploy_delegates_the_release(self):
        """It must not reimplement the release: that is how it shipped the wrong
        Arena, and how its own health probe took the board down twice before."""
        with open(os.path.join(OPS, "autodeploy.sh"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("release.sh", src)
        body = strip_noise(src, False)
        self.assertNotIn("docker compose", body,
                         "autodeploy.sh is driving compose again instead of delegating")

    def test_the_panel_delegates_both_buttons(self):
        with open(os.path.join(OPS, "deploy_panel.py"), encoding="utf-8") as f:
            src = f.read()
        for action, script in (("/api/deploy", "autodeploy.sh"), ("/api/rollback", "release.sh")):
            # The HANDLER, not the first mention -- the page's own JavaScript
            # posts to these paths and would match first.
            i = src.index(f'path == "{action}"')
            window = src[i:i + 700]
            with self.subTest(action=action):
                self.assertIn(script, window, f"{action} no longer delegates to {script}")


if __name__ == "__main__":
    unittest.main()
