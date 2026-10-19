"""Creature fatigue, frontend side: index.html mirrors two of the server's
fatigue constants; drift breaks the meter. The walk, the scan-time collector
and the payload wiring are tested in Rust (dashboard-rs/src/fatigue.rs,
tests/scanner.rs, tests/py_fatigue.rs). Run with:
    python3 -m unittest discover -s tests
"""
import os
import re
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import hq  # noqa: E402

FATIGUE_RS = os.path.join(hq.ROOT, "dashboard-rs", "src", "fatigue.rs")


def _secs(name):
    with open(FATIGUE_RS, encoding="utf-8") as f:
        m = re.search(r"pub const %s: f64 = ([0-9.]+);" % name, f.read())
    assert m, "no %s in fatigue.rs" % name
    return int(float(m.group(1)))


class UiSyncTests(unittest.TestCase):
    def test_fz_constants_in_index_html(self):
        lines = {ln.strip() for ln in hq.assemble_index().splitlines()}
        for want in ("var FZ_SCALE_MINS = %d;" % (_secs("CERTAIN_SECS") // 60),
                     "var FZ_TIRED_MINS = %d;" % (_secs("TIRED_SECS") // 60)):
            self.assertTrue(want in lines, "index.html has no line %r" % want)


if __name__ == "__main__":
    unittest.main()
