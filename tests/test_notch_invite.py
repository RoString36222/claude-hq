"""HQ Notch from HQ (ui/app/37-notch-invite.js): the page's invite wiring. The server's
side (status, the one-click install, its routes) is tested in dashboard-rs."""
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tests"))
import hq  # noqa: E402


class Page(unittest.TestCase):
    def test_wiring(self):
        html = hq.assemble_index()
        self.assertIn("function notchInviteCheck(", html)
        with open(os.path.join(ROOT, "ui", "app", "37-notch-invite.js"), encoding="utf-8") as f:
            js = f.read()
        self.assertIn('if(!s || !s.mac || !s.available) return;', js)            # only on a Mac, only with the notch shipped
        self.assertIn('if(s.installed){ notchInviteRemember("installed"); return; }', js)
        self.assertIn('if(typeof currentModal === "function" && currentModal())', js)   # never over another dialog
        self.assertIn('"X-HQ-Token": CSRF', js)
        self.assertNotIn("innerHTML", js)
        self.assertIn("function openNotchInvite(", js)                           # reopen by hand any time
        self.assertIn('id="setNotchOpen"', html)                                 # ...from Settings
        self.assertIn('label:"HQ Notch"', html)                                   # ...and the command palette
        self.assertNotIn("function el(", js)                                    # 00-core.js owns el()
        with open(os.path.join(ROOT, "ui", "app", "09-drawer.js"), encoding="utf-8") as f:
            drawer = f.read()
        self.assertIn('$("notchInviteBack").classList.contains("open")', drawer)  # focus stays in it


if __name__ == "__main__":
    unittest.main()
