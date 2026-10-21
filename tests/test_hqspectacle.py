"""games/hqspectacle.js: what the 3D City's landmarks and amusement park claim, run under node on the fixtures.

claim() decides on the client, from the world doc alone, which park block becomes the amusement park and which
building lots become landmarks; every client must decide the same, never on a road, never under a tree, and
never touch the server's world generator. The drawing half needs THREE and is checked in the browser
(tools/ui_smoke.py); here: the claim, the coaster's layout, and the house rules in the source.
"""
import json
import os
import re
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")
SCRIPT = r"""
const fs = require('fs'), zlib = require('zlib'), path = require('path'), R0 = process.argv[1];
global.window = {HQV: {}}; global.self = window;
for (const f of ['world.js', 'hqnav.js', 'hqspectacle.js']) eval(fs.readFileSync(path.join(R0, 'games', f), 'utf8'));
const WD = window.HQV.world, SP = window.HQV.hqSpectacle, NAV = window.HQV.hqnav;
const doc = f => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(R0, 'tests/fixtures', f + '.json.gz'))));
const W = WD.pack(doc('claude-hq@2')), lotsBefore = W.lots.length, sitesBefore = W.sites.length;
const leg = W.districts.legend, kindsBefore = {};
W.lots.forEach(l => { kindsBefore[l.id] = l.kind; });
const S = SP.claim(W, 5), out = {park: S.park, marks: S.marks, sitesAdded: W.sites.length - sitesBefore, lotsSame: W.lots.length === lotsBefore};
out.again = SP.claim(W, 5) === S && W.sites.length - sitesBefore === out.sitesAdded;
// the same doc, packed afresh, claims the same
const S2 = SP.claim(WD.pack(doc('claude-hq@2')), 5);
out.same = JSON.stringify(S2) === JSON.stringify(S);
// the park: its block, clear of roads and trees, registered as a site with a name and a front at its gate
const P = S.park, blk = W.blocks.filter(b => b.id === P.block)[0];
out.parkDistrict = leg[blk.district];
out.parkOnEmptyBlock = !lotsBefore || W.lots.every(l => l.block !== P.block);
let roads = 0, trees = 0;
const cr = Math.cos(P.rot), sr = Math.sin(P.rot);
for (let i = 0; i <= 40; i++) for (let j = 0; j <= 40; j++) {
  const lx = (i/40 - 0.5)*P.w, lz = (j/40 - 0.5)*P.d, x = P.x + lx*cr + lz*sr, z = P.z - lx*sr + lz*cr;
  const r = WD.nearestRoad(W, x, z, 40); if (r && r.dist <= r.half) roads++;
}
WD.trees(W).forEach(t => { const dx = t.x - P.x, dz = t.z - P.z, lx = dx*cr - dz*sr, lz = dx*sr + dz*cr; if (Math.abs(lx) < P.w/2 && Math.abs(lz) < P.d/2) trees++; });
const site = W.sites.filter(s => s.kind === 'funpark')[0];
Object.assign(out, {roads, trees, siteName: site && site.name, siteFront: site && site.front});
// you walk the terrain in the park and on a landmark's lot: their sites name ground, they don't flatten it
out.walk = [[P.x, P.z], [P.x + P.w/3, P.z + P.d/3]].concat(S.marks.map(m => [m.x, m.z]))
  .map(([x, z]) => Math.abs(WD.groundAt(W, x, z) - WD.heightAt(W, x, z)));
out.siteY = [site.y, WD.heightCm(W, site.x, site.z)];
// the gate is at the park's local -z end
out.gateEnd = Math.hypot(P.gate.x - (P.x - Math.sin(P.rot)*P.d/2), P.gate.z - (P.z - Math.cos(P.rot)*P.d/2));
// landmarks: their lots stop being generic buildings (and stop blocking in world.js), each has a named site
out.markLots = S.marks.map(m => { const l = W.lots.filter(x => x.id === m.lot)[0];
  return {kind: l.kind, was: kindsBefore[m.lot], district: leg[l.district], blocks: WD.blockedAt(W, m.x, m.z), site: !!W.sites.filter(s => s.id === 'landmark:' + m.lot && s.name === m.name)[0]}; });
out.gaps = []; S.marks.forEach((a, i) => S.marks.forEach((b, j) => { if (j > i) out.gaps.push(Math.hypot(a.x - b.x, a.z - b.z)); }));
out.fromPark = S.marks.map(m => Math.max(Math.abs(m.x - P.x) - Math.max(P.w, P.d)/2, Math.abs(m.z - P.z) - Math.max(P.w, P.d)/2));
// Go to lists them by their own names
const pl = NAV.places(W, 5, {x: 0, z: 0});
out.places = pl.filter(p => p.kind === 'funpark' || p.kind === 'landmark').map(p => p.label);
// the coaster: inside the fence, the entrance walkable under it, the station level, the crest the top
const C = SP.coasterPlan(P.w/2, P.d/2, 46), a = P.w/2, b = P.d/2;
out.coaster = {inside: C.pts.every(p => Math.abs(p.x) <= a - 6 + 1e-6 && Math.abs(p.z) <= b - 6 + 1e-6),
  over: C.pts.filter(p => p.tag === 'over').map(p => p.y), station: C.pts.filter(p => /^station/.test(p.tag)).map(p => p.y),
  crest: C.pts.filter(p => p.tag === 'crest')[0].y, top: Math.max(...C.pts.map(p => p.y)), R: C.R, loopTop: C.pts.filter(p => p.tag === 'looptop')[0].y};
// an island at its first tier: whatever it claims, it claims without throwing, and only what that tier shows
const Wi = WD.pack(doc('island@2')), Si = SP.claim(Wi, 1);
out.island = {park: !!Si.park, marks: Si.marks.length,
  shown: Si.marks.every(m => { const l = Wi.lots.filter(x => x.id === m.lot)[0]; return l.min_tier == null || l.min_tier <= 1; })};
// the world cache (world.js cacheCopy) never keeps a claim: a claim made by older code read back from
// IndexedDB was trusted forever (W.spectacle short-circuits claim), with its old sites (y 0: underground)
const Wk = WD.pack(doc('claude-hq@2')), lotsK = {}; Wk.lots.forEach(l => { lotsK[l.id] = l.kind; });
SP.claim(Wk, 5);
const cc = WD.cacheCopy(Wk);
out.cache = {spectacle: 'spectacle' in cc, claimedSites: cc.sites.filter(s => s.claimed || s.kind === 'funpark' || s.kind === 'landmark').length,
  landmarkLots: cc.lots.filter(l => l.kind === 'landmark' || l.was != null).length, kindsBack: cc.lots.every(l => l.kind === lotsK[l.id]),
  liveKept: !!Wk.spectacle && Wk.sites.some(s => s.kind === 'funpark'), sharedLots: cc.lots.some((l, i) => l === Wk.lots[i])};
console.log(JSON.stringify(out));
"""


@unittest.skipUnless(NODE, "node is not installed")
class ClaimTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        r = subprocess.run([NODE, "-e", SCRIPT, ROOT], capture_output=True, text=True, timeout=120)
        if r.returncode:
            raise AssertionError(r.stderr)
        cls.o = json.loads(r.stdout.strip().splitlines()[-1])

    def test_the_commons_gets_a_park_and_landmarks(self):
        self.assertIsNotNone(self.o["park"])
        self.assertGreaterEqual(len(self.o["marks"]), 3)
        self.assertLessEqual(len(self.o["marks"]), 8)
        self.assertEqual(self.o["sitesAdded"], 1 + len(self.o["marks"]))
        self.assertTrue(self.o["lotsSame"])

    def test_claiming_is_idempotent_and_the_same_everywhere(self):
        self.assertTrue(self.o["again"])
        self.assertTrue(self.o["same"])

    def test_the_park_is_an_empty_park_block_clear_of_roads_and_trees(self):
        self.assertEqual(self.o["parkDistrict"], "park")
        self.assertTrue(self.o["parkOnEmptyBlock"])
        self.assertEqual(self.o["roads"], 0)
        self.assertEqual(self.o["trees"], 0)
        self.assertGreaterEqual(min(self.o["park"]["w"], self.o["park"]["d"]), 56)

    def test_you_walk_the_terrain_not_a_floor_at_zero(self):
        # a site is a level pad at its y unless pad is false; at y 0 the park sank you ~1 m underground
        self.assertTrue(all(d < 1e-9 for d in self.o["walk"]), self.o["walk"])
        self.assertEqual(self.o["siteY"][0], self.o["siteY"][1])

    def test_the_park_is_a_named_site_with_its_front_at_the_gate(self):
        self.assertEqual(self.o["siteName"], "Skyline Park")
        self.assertEqual(len(self.o["siteFront"]), 2)
        self.assertLess(self.o["gateEnd"], 0.01)

    def test_landmark_lots_stop_being_generic_buildings(self):
        for m in self.o["markLots"]:
            self.assertEqual(m["was"], "building")
            self.assertEqual(m["kind"], "landmark")
            self.assertIn(m["district"], ("downtown", "finance", "office", "commercial", "tech"))
            self.assertFalse(m["blocks"], "world.js still blocks a landmark lot (hqspectacle blocks its own footprint)")
            self.assertTrue(m["site"])

    def test_landmarks_are_spread_out_and_clear_of_the_park(self):
        self.assertTrue(all(g >= 170 for g in self.o["gaps"]), self.o["gaps"])
        self.assertTrue(all(d >= 70 for d in self.o["fromPark"]), self.o["fromPark"])
        self.assertEqual(len({m["type"] for m in self.o["marks"]}), len(self.o["marks"]), "two of the same design")

    def test_go_to_lists_the_park_and_landmarks_by_name(self):
        self.assertIn("Skyline Park", self.o["places"])
        for m in self.o["marks"]:
            self.assertIn(m["name"], self.o["places"])

    def test_the_coaster_fits_and_you_can_walk_under_it(self):
        c = self.o["coaster"]
        self.assertTrue(c["inside"])
        self.assertTrue(all(y >= 7 for y in c["over"]), c["over"])
        self.assertEqual(c["station"], [1.6, 1.6])
        self.assertEqual(c["crest"], c["top"])
        self.assertAlmostEqual(c["loopTop"], 3 + 2 * c["R"], places=6)

    def test_the_world_cache_never_keeps_a_claim(self):
        c = self.o["cache"]
        self.assertFalse(c["spectacle"])
        self.assertEqual(c["claimedSites"], 0)
        self.assertEqual(c["landmarkLots"], 0)
        self.assertTrue(c["kindsBack"])
        self.assertTrue(c["liveKept"])                 # the live W keeps its claims; only the record is clean
        self.assertFalse(c["sharedLots"])              # its own copies: a later claim cannot reach the record

    def test_an_island_claims_only_what_its_tier_shows(self):
        self.assertTrue(self.o["island"]["shown"])


class SourceTests(unittest.TestCase):
    def setUp(self):
        self.js = open(os.path.join(ROOT, "games", "hqspectacle.js"), encoding="utf-8").read()
        self.city = open(os.path.join(ROOT, "games", "hqcity3d.js"), encoding="utf-8").read()

    def test_no_random_in_anything_seen_twice(self):
        self.assertNotIn("Math.random(", self.js)

    def test_calm_watches_the_ride_instead_of_riding_it(self):
        # a first-person coaster is a vestibular hazard: Calm (and reduced motion, E.calm) watches from the platform
        self.assertRegex(self.js, r"camPose: function\(\)\{[\s\S]{0,200}if\(E\.calm\(\)\)")
        self.assertIn("up: {x: 0, y: 1, z: 0}, fov: 55", self.js)

    def test_the_ticket_is_the_arenas_park_fare(self):
        self.assertIn('"/fare", {kind: "park"}', self.js)
        # nothing on the page grants a pass: only a CityState from the Arena or a paid fare sets it
        self.assertEqual(len(re.findall(r"\bpass = true\b", self.js)), 2)

    def test_every_texture_is_vendored_and_licensed(self):
        folder = os.path.join(ROOT, "games", "city")
        lic = open(os.path.join(folder, "LICENSE-assets.txt"), encoding="utf-8").read()
        self.assertIn("CC0", lic)
        names = set(re.findall(r'pbr\("([a-z]+)"', self.js))
        self.assertTrue(names)
        for n in names:
            for part in ("col", "nrm", "rgh"):
                f = "%s-%s.jpg" % (n, part)
                self.assertTrue(os.path.isfile(os.path.join(folder, f)), f)
        for f in os.listdir(folder):
            if f.endswith(".jpg"):
                self.assertIn(f, lic, f)

    def test_the_city_claims_before_it_indexes_or_builds(self):
        i_claim = self.city.index("HQV.hqSpectacle.claim(W, tier)")
        self.assertLess(i_claim, self.city.index("indexBuildings();\n    wb = HQV.worldbuild.create"))

    def test_every_ride_seat_is_in_the_worlds_frame(self):
        # the coaster's track is drawn in the park's frame; its seat was returned in it, so a rider rode a ghost
        # coaster ~350 m away beside the plaza. Every seat goes through a matrixWorld / localToWorld now.
        seat = self.js[self.js.index('id: "coaster"'):]
        seat = seat[seat.index("seat: function(sec){"):][:400]
        self.assertIn("applyMatrix4(M)", seat)
        self.assertIn("transformDirection(M)", seat)
        for rid in ("wheel", "drop", "carousel", "swing"):
            body = self.js[self.js.index('id: "%s"' % rid):]
            body = body[body.index("seat: function"):][:420]
            self.assertIn("localToWorld", body, rid)

    def test_a_refused_ticket_never_opens_the_gate(self):
        # the page's arenaPost resolves {ok, status, j} whatever the status
        buy = self.js[self.js.index("function buy()"):][:1600]
        self.assertIn("if(!r || r.ok !== true){ refused(j.detail || j.error); return; }", buy)
        self.assertLess(buy.index("r.ok !== true"), buy.index("pass = true"))

    def test_sites_name_ground_without_flattening_it(self):
        self.assertEqual(self.js.count("pad: false"), 2)
        world = open(os.path.join(ROOT, "games", "world.js"), encoding="utf-8").read()
        self.assertIn("if(s.pad !== false) I.padList.push", world)

    def test_the_crowd_is_the_citys_residents_body(self):
        self.assertIn("ND.bodyGeometry()", self.js)
        self.assertIn("ND.bodyMaterial(THREE, U)", self.js)
        npc = open(os.path.join(ROOT, "games", "npcdraw.js"), encoding="utf-8").read()
        self.assertIn("bodyMaterial: bodyMaterial", npc)

    def test_mouse_looks_around_on_a_ride_and_orbits_on_foot(self):
        hq = open(os.path.join(ROOT, "games", "hq3d.js"), encoding="utf-8").read()
        self.assertIn("if(tripHeld()){ drag = {", hq)                    # a drag on a ride is yours to look with
        self.assertIn("D.applyAxisAngle(Uu, tripLook.yaw);", hq)
        self.assertIn("tripLook.yaw = 0; tripLook.pitch = 0; return;", hq)   # it recentres when the ride lets go
        self.assertIn('orbit: !!CHASE[m] && (e.button === 0 || e.button === 2)', hq)
        self.assertIn("if(!d || d.trip || d.moved > 5) return;", hq)      # a drag is never a click

    def test_riding_comes_first_in_the_city_hooks(self):
        self.assertIn("var p = spx && spx.carry(); return p ||", self.city)
        self.assertIn("var p = spx && spx.camPose(); return p ||", self.city)
        self.assertIn("if(spx && spx.use(p)) return true;", self.city)


if __name__ == "__main__":
    unittest.main()
