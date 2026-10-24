"""HQ Notch installer: settings.json hook merge touches only our entries; generated
PokeData.swift stays in sync with ui/app/06-trainer-packs.js."""
import importlib.util
import os
import subprocess
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)


def load(name, rel):
    spec = importlib.util.spec_from_file_location(name, os.path.join(REPO, rel))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


inst = load("hqn_install", "notch/tools/install.py")

OTHER = {"type": "command", "command": "/usr/local/bin/other-hook", "timeout": 5}


class MergeTests(unittest.TestCase):
    def test_install_into_empty(self):
        s = inst.merge_hooks({}, True)
        self.assertEqual(sorted(s["hooks"]), sorted(inst.EVENTS))
        h = s["hooks"]["PermissionRequest"][0]["hooks"][0]
        self.assertEqual(h["timeout"], 120)
        self.assertIn(inst.MARKER, h["command"])
        self.assertEqual(s["hooks"]["Stop"][0]["hooks"][0]["timeout"], 10)
        ask = [g for g in s["hooks"]["PreToolUse"] if g.get("matcher") == "AskUserQuestion"]
        self.assertEqual(len(ask), 1)
        self.assertTrue(ask[0]["hooks"][0]["command"].endswith(" --ask"))
        self.assertEqual(ask[0]["hooks"][0]["timeout"], inst.ASK_TIMEOUT)
        self.assertEqual(len(s["hooks"]["PreToolUse"]), 2)   # generic + --ask

    def test_install_is_idempotent_and_keeps_others(self):
        base = {"model": "opus", "hooks": {"Stop": [{"hooks": [OTHER]}],
                                           "PreToolUse": [{"matcher": "Bash", "hooks": [OTHER]}]}}
        once = inst.merge_hooks(base, True)
        twice = inst.merge_hooks(once, True)
        self.assertEqual(once, twice)
        self.assertEqual(once["model"], "opus")
        self.assertIn({"hooks": [OTHER]}, once["hooks"]["Stop"])
        self.assertIn({"matcher": "Bash", "hooks": [OTHER]}, once["hooks"]["PreToolUse"])
        self.assertEqual(sum(inst.is_ours(h) for g in once["hooks"]["Stop"] for h in g["hooks"]), 1)

    def test_uninstall_restores(self):
        base = {"hooks": {"Stop": [{"hooks": [OTHER]}]}, "env": {"A": "1"}}
        self.assertEqual(inst.merge_hooks(inst.merge_hooks(base, True), False), base)
        self.assertEqual(inst.merge_hooks(inst.merge_hooks({}, True), False), {})

    def test_mixed_group_keeps_foreign_hook(self):
        ours = {"type": "command", "command": inst.hook_command()}
        base = {"hooks": {"Stop": [{"hooks": [OTHER, ours]}]}}
        self.assertEqual(inst.merge_hooks(base, False), {"hooks": {"Stop": [{"hooks": [OTHER]}]}})

    def test_input_not_mutated(self):
        base = {"hooks": {"Stop": [{"hooks": [OTHER]}]}}
        inst.merge_hooks(base, True)
        self.assertEqual(base, {"hooks": {"Stop": [{"hooks": [OTHER]}]}})


class SdkFallbackTests(unittest.TestCase):
    NAMES = ["MacOSX.sdk", "MacOSX26.sdk", "MacOSX26.5.sdk", "MacOSX27.0.sdk", "MacOSX27.sdk", "notes.txt"]

    def test_picks_newest_older_major(self):
        self.assertEqual(inst.fallback_sdk(self.NAMES, 27), "MacOSX26.5.sdk")

    def test_none_when_nothing_older(self):
        self.assertIsNone(inst.fallback_sdk(["MacOSX.sdk", "MacOSX27.sdk"], 27))
        self.assertIsNone(inst.fallback_sdk([], 27))

    def test_compares_versions_not_strings(self):
        self.assertEqual(inst.fallback_sdk(["MacOSX9.sdk", "MacOSX15.4.sdk", "MacOSX15.10.sdk"], 26), "MacOSX15.10.sdk")


class PokeDataSyncTests(unittest.TestCase):
    def test_generated_swift_is_current(self):
        r = subprocess.run([sys.executable, os.path.join(REPO, "notch", "tools", "gen_pokedata.py"), "--check"],
                           capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)


if __name__ == "__main__":
    unittest.main()
