"""Movable HQ garages (City Gen v4 phase 10, HQ 3.33), the server side: where a user's car-lift garage bay sits in their
own HQ lot, as four integers {lot, x, z, r}.

The behaviour is tested in Rust (backend/src/hqgarage/tests.rs: validation, storage, the routes over HTTP and the HQ
listing; dashboard-rs/src/arena.rs and dashboard-rs/tests/http.rs: the local proxy's allowlist, its gates and the 404
pass-through). This pins the wiring between the pieces so one side cannot be dropped without the other noticing.
"""
import os
import re
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def read(*p):
    with open(os.path.join(ROOT, *p), encoding="utf-8") as f:
        return f.read()


class ArenaGarageRoutes(unittest.TestCase):
    def test_the_arena_routes_and_listing(self):
        hq = read("backend", "src", "hq.rs")
        self.assertIn('"/v1/hq/me/garage"', hq)
        for h in ("get_mine", "put_mine", "delete_mine"):
            self.assertIn("crate::hqgarage::" + h, hq)
        # garage is the last field of HqOut, after style, and skipped when unset
        out = hq[hq.index("struct HqOut {"):]
        out = out[:out.index("\n}\n")]
        self.assertLess(out.index("style: Option<Value>"), out.index("garage: Option<crate::hqgarage::GarageSpot>"))
        self.assertTrue(out.rstrip().endswith("garage: Option<crate::hqgarage::GarageSpot>,"))
        self.assertEqual(hq.count("out.garage = "), 4, "/me, PUT /me, the open list and a visit")
        g = read("backend", "src", "hqgarage.rs")
        self.assertIn("pub(crate) const X_MAX: i64 = 400;", g)
        self.assertIn("pub(crate) const Z_MAX: i64 = 300;", g)
        self.assertIn("pub(crate) const R_MAX: i64 = 3;", g)
        self.assertIn('matches!(k.as_str(), "lot" | "x" | "z" | "r")', g)
        self.assertIn("UNPROCESSABLE_ENTITY", g)
        self.assertIn("save_allowed", g)

    def test_the_migration(self):
        sql = read("backend", "migrations", "0026_hq_garage.sql")
        self.assertIn("CREATE TABLE IF NOT EXISTS hq_garage", sql)
        for col in ("user_id VARCHAR(36) NOT NULL PRIMARY KEY", "lot INTEGER", "x INTEGER", "z INTEGER", "r INTEGER", "updated_at TEXT"):
            self.assertIn(col, sql)

    def test_the_capability(self):
        proto = read("backend", "src", "protocol.rs")
        self.assertEqual(len(re.findall(r'"transit", "garage", "phone"', proto)), 2, "the table and its pinned test")


class LocalProxy(unittest.TestCase):
    def test_routes_are_post_and_get_with_an_allowlisted_body(self):
        server = read("dashboard-rs", "src", "server.rs")
        posts = server[server.index("pub fn post_paths()"):]
        posts = posts[:posts.index("v.extend(")]
        self.assertIn('"/api/arena/hq/garage"', posts)
        self.assertIn('"/api/arena/hq/garage/reset"', posts)
        self.assertIn("app.arena_hq_garage()", server)
        self.assertIn("app.arena_hq_garage_put(body)", server)
        self.assertIn("app.arena_hq_garage_reset()", server)
        arena = read("dashboard-rs", "src", "arena.rs")
        body = arena[arena.index("pub fn hq_garage_body"):]
        body = body[:body.index("\n}\n")]
        self.assertIn('matches!(k.as_str(), "lot" | "x" | "z" | "r")', body)
        self.assertIn('json!({"lot": lot, "x": x, "z": z, "r": r})', body, "a fresh body, never the page's own value")
        self.assertIn('self.authed_send("PUT", "/v1/hq/me/garage", b)', arena)
        self.assertIn('"DELETE", &format!("{}/v1/hq/me/garage", b)', arena)
        self.assertIn('self.authed_get("/v1/hq/me/garage")', arena)

    def test_the_egress_is_documented(self):
        self.assertIn("/api/arena/hq/garage", read("AGENTS.md"))
        readme = read("README.md")
        privacy = readme[readme.index("## 🔒 Privacy & security"):readme.index("## 🗂️ Files")]
        self.assertIn("`{lot, x, z, r}`", privacy)
        arena = read("dashboard-rs", "src", "arena.rs")
        self.assertIn("Egress: exactly four small integers about your own", arena)


if __name__ == "__main__":
    unittest.main()
