"""Shared privacy-key helpers for the tests that check what may leave the
machine (test_story.py, test_trackedit.py import these).

The Arena client tests that lived here (stats payload bucketing, cost opt-in,
pantry allowlist) are Rust tests now: dashboard-rs/tests/py_arena_client.rs,
next to the module tests in dashboard-rs/src/arena.rs.
"""

# Any key that must never appear anywhere in a body sent to the Arena.
# Mirrors FORBIDDEN_KEYS in dashboard-rs/tests/py_common/mod.rs.
FORBIDDEN_KEYS = {
    "prompt", "prompts_text", "reply", "text", "content", "path", "paths",
    "cwd", "folder", "project", "projectName", "sessionId", "sessionTitle",
    "title", "file", "files",
}


def _collect_keys(obj):
    keys = set()
    if isinstance(obj, dict):
        for k, v in obj.items():
            keys.add(k)
            keys |= _collect_keys(v)
    elif isinstance(obj, list):
        for v in obj:
            keys |= _collect_keys(v)
    return keys
