"""tools/vehicle_fetch.py: the licence filter, the ranking and the normalisation maths (no network)."""
import importlib.util
import math
import os
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
spec = importlib.util.spec_from_file_location("vehicle_fetch", os.path.join(ROOT, "tools", "vehicle_fetch.py"))
F = importlib.util.module_from_spec(spec)
spec.loader.exec_module(F)

M3 = {"id": "bmw-m3-competition", "kind": "car", "brand": "BMW", "model": "M3 Competition", "gen": "G80", "lengthM": 4.79}
DUKE = {"id": "ktm-390-duke", "kind": "bike", "brand": "KTM", "model": "390 Duke", "gen": "2024", "lengthM": 2.0}


def res(name, label="CC Attribution", faces=20000, tex=3, uid=None, likes=10, downloadable=True, tags=()):
    return {"uid": uid or name, "name": name, "license": {"label": label}, "isDownloadable": downloadable,
            "archives": {"glb": {"faceCount": faces, "textureCount": tex}}, "likeCount": likes,
            "tags": [{"name": t} for t in tags], "viewerUrl": "https://sketchfab.com/3d-models/x",
            "user": {"username": "someone", "displayName": "Some One"},
            "thumbnails": {"images": [{"url": "https://t/256", "width": 256}, {"url": "https://t/720", "width": 720}]}}


class Licences(unittest.TestCase):
    def test_kept_and_dropped(self):
        keep = ["CC0 Public Domain", "CC Attribution", "CC Attribution-ShareAlike"]
        drop = ["CC Attribution-NonCommercial", "CC Attribution-NonCommercial-ShareAlike", "CC Attribution-NoDerivs",
                "CC Attribution-NonCommercial-NoDerivs", "Free Standard", "Standard", "Editorial", ""]
        self.assertEqual([F.licence_ok(res("x", l)) for l in keep], ["cc0", "by", "by-sa"])
        self.assertEqual([F.licence_ok(res("x", l)) for l in drop], [None] * len(drop))

    def test_not_downloadable_is_dropped(self):
        self.assertIsNone(F.licence_ok(res("x", downloadable=False)))

    def test_slug_form_too(self):
        self.assertEqual(F.licence_ok({"license": {"slug": "by-sa"}, "isDownloadable": True}), "by-sa")

    def test_spdx_in_candidates(self):
        sc, r = F.rank(M3, [res("BMW M3 G80 Competition", "CC0 Public Domain")])[0]
        self.assertEqual(F.candidate(sc, r)["licence"], "CC0-1.0")


class Ranking(unittest.TestCase):
    def test_right_generation_beats_another(self):
        good, old = res("BMW M3 Competition G80 2021"), res("BMW M3 E46 2003")
        self.assertGreater(F.score(M3, good), F.score(M3, old) + 30)

    def test_game_rips_and_packs_are_out_or_down(self):
        self.assertIsNone(F.score(M3, res("BMW M3 GTR NFS Most Wanted")))
        self.assertIsNone(F.score(M3, res("BMW M135i - Car Parking Multiplayer")))
        self.assertGreater(F.score(M3, res("BMW M3 G80")), F.score(M3, res("BMW E36 E46 E92 G80 M3 pack")) + 20)

    def test_lighter_model_wins_a_tie(self):
        light, heavy = res("BMW M3 G80", faces=30000), res("BMW M3 G80 ", faces=900000 // 3)
        self.assertGreater(F.score(M3, light), F.score(M3, heavy))
        self.assertIsNone(F.score(M3, res("BMW M3 G80", faces=F.FACES_MAX + 1)))

    def test_bike_model_words_and_compact_names(self):
        self.assertGreater(F.score(DUKE, res("KTM Duke 390 2024")), F.score(DUKE, res("KTM 1290 Super Duke")))
        rr = {"brand": "BMW", "model": "S 1000 RR", "kind": "bike", "gen": ""}
        self.assertGreater(F.score(rr, res("bmw s1000rr")), F.score(rr, res("bmw motorcycle")))

    def test_wrong_brand_and_kind_lose(self):
        self.assertLess(F.score(DUKE, res("Honda CB 390 Duke style")), F.score(DUKE, res("KTM 390 Duke")))
        self.assertLess(F.score(DUKE, res("KTM 390 Duke car")), F.score(DUKE, res("KTM 390 Duke")))

    def test_rank_dedups_filters_and_orders(self):
        rs = [res("BMW M3 G80", uid="a"), res("BMW M3 G80", uid="a"), res("BMW M3 G80", "CC Attribution-NonCommercial", uid="b"),
              res("BMW M3 E30", uid="c"), res("BMW M3 Competition G80", uid="d")]
        got = [r["uid"] for _, r in F.rank(M3, rs)]
        self.assertEqual(got[0], "d")
        self.assertEqual(sorted(got), ["a", "c", "d"])

    def test_every_spec_vehicle_has_queries_and_a_length(self):
        ids = [v[0] for v in F.SPEC_GRID]
        self.assertEqual(len(ids), len(set(ids)))
        for i, kind, brand, model, gen, length, queries in F.SPEC_GRID:
            self.assertIn(kind, ("car", "bike"))
            self.assertTrue(queries)
            self.assertTrue((1.8 <= length <= 2.4) if kind == "bike" else (4.0 <= length <= 5.6), i)


class Transform(unittest.TestCase):
    def check(self, bbox, length, flip=False):
        t = F.plan_transform(bbox, length, "car", flip=flip)
        mn, mx = bbox["min"], bbox["max"]
        corners = [[x, y, z] for x in (mn[0], mx[0]) for y in (mn[1], mx[1]) for z in (mn[2], mx[2])]
        P = [F.apply(t, c) for c in corners]
        xs, ys, zs = zip(*P)
        return t, (min(xs), max(xs)), (min(ys), max(ys)), (min(zs), max(zs))

    def test_long_along_z_scales_and_stands(self):
        t, xr, yr, zr = self.check({"min": [-90, 5, -230], "max": [90, 145, 230]}, 4.6)
        self.assertAlmostEqual(zr[1] - zr[0], 4.6, places=6)
        self.assertAlmostEqual(yr[0], 0, places=9)
        self.assertAlmostEqual(xr[0] + xr[1], 0, places=9)
        self.assertAlmostEqual(zr[0] + zr[1], 0, places=9)
        self.assertEqual(t["rotY"], 0)

    def test_long_along_x_turns_to_z_and_keeps_its_nose(self):
        bbox = {"min": [-2.0, -0.3, -0.9], "max": [2.6, 1.1, 0.9]}   # off-centre, nose at +x
        t, xr, yr, zr = self.check(bbox, 4.79)
        self.assertAlmostEqual(zr[1] - zr[0], 4.79, places=6)
        self.assertAlmostEqual(xr[1] - xr[0], 1.8 * 4.79 / 4.6, places=6)
        self.assertAlmostEqual(yr[0], 0, places=9)
        self.assertAlmostEqual(zr[0] + zr[1], 0, places=9)
        nose = F.apply(t, [2.6, 0, 0])
        self.assertGreater(nose[2], 2.3)                                 # +x nose -> +z forward

    def test_flip_turns_it_round(self):
        bbox = {"min": [-1, 0, -2], "max": [1, 1.4, 2]}
        a = F.apply(F.plan_transform(bbox, 4, "car"), [0, 0, 2])
        b = F.apply(F.plan_transform(bbox, 4, "car", flip=True), [0, 0, 2])
        self.assertAlmostEqual(a[2], 2, places=9)
        self.assertAlmostEqual(b[2], -2, places=9)

    def test_empty_box_is_an_error(self):
        with self.assertRaises(ValueError):
            F.plan_transform({"min": [0, 0, 0], "max": [0, 1, 0]}, 4, "car")

    def test_decimate_ratio(self):
        self.assertEqual(F.decimate_ratio(9000), 1.0)
        r = F.decimate_ratio(300000)
        self.assertLess(300000 * r, F.TRI_BUDGET)
        self.assertGreater(300000 * r, F.TRI_BUDGET * 0.9)
        self.assertGreaterEqual(F.decimate_ratio(10 ** 9), 0.01)


if __name__ == "__main__":
    unittest.main()
