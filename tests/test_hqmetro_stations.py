"""Stations walked, not jumped (games/hqmetro.js layout, hqride.js session, camrig.js closed rooms).

node runs the pure halves against tests/test_hqmetro.py's synthetic metro layer:
  - the layout: every entrance's foot (and a passage's way in) on the street side of the gates, every stair head past
    them, room between a foot and a gate line; the hall's floor open over a stair's well; a stair walked on and off
    only at its ends (never through its side walls); a passage reaching into the hall with both its walls; the rooms a
    camera may be in (the hall, a platform, not over the hall's ceiling) and the camera's ray stopped at a ceiling.
  - the ride session with walkOn (a departure chosen on the board below the street): no boarding from where you stand
    when the train comes in, only through a door you walk up to (S.boardAt), and the walk in and out walked (no step of
    it longer than a walk) at any length.
  - camrig: q.hard pulls the camera in at once and, too close to the head, goes to the eyes (the avatar hidden).
Skipped when node is not installed. Stdlib only."""
import json
import os
import shutil
import subprocess
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tests"))
NODE = shutil.which("node")
import test_hqmetro  # noqa: E402  (its metro fixture)

SRC = r"""
const fs = require("fs");
const root = %(root)s, doc = %(doc)s;
global.window = {HQV: {}}; global.self = window;
["hqride", "hqmetro", "camrig"].forEach(f => new Function(fs.readFileSync(root + "/games/" + f + ".js", "utf8"))());
const H = window.HQV.hqMetro, R = window.HQV.hqRide, CR = window.HQV.camrig, out = {};
const sim = H.create(doc, {tier: 5}), L = sim.layout();
// ---- the layout
out.st = L.stations.map(S => {
  const h = S.hall, ents = L.entrances.filter(E => E.station === S.id);
  const wayIn = E => { if(!E.pass) return E.foot; const r = E.pass.r; return {x: r.cx + r.s*r.hl, z: r.cz + r.c*r.hl}; };
  const feet = ents.filter(E => E.kind !== "lift").map(E => { const P = wayIn(E); return {paid: L.paidAt(P.x, S.hallY + 0.1, P.z), u: H.rLocal(h, P.x, P.z).u}; });
  const heads = S.stairs.map(f => { const r = f.r, P = {x: r.cx - r.s*(r.hl - 0.6), z: r.cz - r.c*(r.hl - 0.6)}; return L.paidAt(P.x, S.hallY + 0.05, P.z); });
  // over a stair's well (2 m down it, its middle): no hall floor, the stair's
  const f0 = S.stairs[0], W = {x: f0.r.cx - f0.r.s*(f0.r.hl - 2.5), z: f0.r.cz - f0.r.c*(f0.r.hl - 2.5)}, ww = L.walkable(W.x, S.hallY, W.z);
  // through the stair's side 4 m down it, from the hall's floor beside it: blocked; along it from its head: not
  const P4 = {x: f0.r.cx - f0.r.s*(f0.r.hl - 4), z: f0.r.cz - f0.r.c*(f0.r.hl - 4)}, side = {x: P4.x + f0.r.c*(f0.r.hw + 0.6), z: P4.z - f0.r.s*(f0.r.hw + 0.6)};
  const head = {x: f0.r.cx - f0.r.s*f0.r.hl, z: f0.r.cz - f0.r.c*f0.r.hl}, down = {x: f0.r.cx - f0.r.s*(f0.r.hl - 0.4), z: f0.r.cz - f0.r.c*(f0.r.hl - 0.4)};
  const passEnds = ents.filter(E => E.pass).map(E => { const r = E.pass.r; return [-1, 1].every(k => !!H.inRect(h, r.cx + r.s*r.hl + k*r.hw*r.c, r.cz + r.c*r.hl - k*r.hw*r.s)); });
  const p0 = S.plats[0];
  return {id: S.id, feet: feet, gates: S.gates, heads: heads, well: ww ? {kind: ww.kind, y: ww.y - S.hallY} : null,
    sideBlocked: L.stepBlocked(side.x, side.z, P4.x, P4.z, S.hallY), headOk: L.stepBlocked(head.x, head.z, down.x, down.z, S.hallY), passEnds: passEnds,
    camHall: L.camInside(S.x, S.hallY + 1.6, S.z), camPlat: L.camInside(p0.r.cx, p0.y0 + 1.6, p0.r.cz), camAbove: L.camInside(S.x, S.hallY + 6, S.z),
    hitUp: L.camHit({x: S.x, y: S.hallY + 1.6, z: S.z}, {x: S.x + 3, y: S.hallY + 9, z: S.z}), ceil: L.ceilAt(S.x, S.hallY + 1.6, S.z) - S.hallY};
});
// ---- walk-on boarding
const T0 = Date.UTC(2026, 9, 30, 12, 0, 0);
let v = null; for(let t = 0; t < 900 && !v; t++){ v = sim.vehicles(T0 + t*1000).find(q => q.stop === "metro:2" && q.doors >= 0.99) || null; if(v) v.t = T0 + t*1000; }
const ru = sim.runOf(v), trip = sim.trip(v.line, "metro:2", ru.last === "metro:2" ? "metro:0" : ru.last, v.t - 60000);
const door = sim.doorsOf(v)[2], me = {x: door.x + 3, y: door.y, z: door.z};
const S = R.session({trip: trip, me: () => me, calm: () => true, announce: () => {}, walkOn: true});
const ph = [];
for(let ms = trip.arrive - 20000; ms <= trip.arrive + 3000; ms += 1000){ S.step(ms, me); ph.push(S.phase); }
const early = S.boardAt(door, trip.arrive - 5000, me);
const ok = S.boardAt(door, trip.arrive + 3500, me);
let prev = null, maxStep = 0, dur = 0;
for(let ms = trip.arrive + 3500; ms < trip.arrive + 12000; ms += 50){ S.step(ms, me); const c = S.carry(ms); if(S.phase === "board"){ dur = ms - (trip.arrive + 3500); } if(c && prev && S.phase === "board") maxStep = Math.max(maxStep, Math.hypot(c.x - prev.x, c.z - prev.z)); prev = c; }
out.walkOn = {waiting: ph, early: early, ok: ok, phase: S.phase, maxStep: maxStep, dur: dur};
// ---- the camera in closed rooms
const rig = CR.create({mode: "chase", seed: "t"}), tgt = {x: 0, y: 0, z: 0, yaw: 0, speed: 0};
const q = {ground: () => 0, hit: (a, b) => 0.1, hard: true}, q2 = {ground: () => 0, hit: (a, b) => 1, hard: true};
let pose = null; for(let i = 0; i < 3; i++) pose = CR.step(rig, tgt, 0.016, q2);
const far = Math.hypot(pose.pos.x, pose.pos.z);
pose = CR.step(rig, tgt, 0.016, q);
out.cam = {far: far, tightHide: !!pose.hideAvatar, tightY: pose.pos.y, tightD: Math.hypot(pose.pos.x, pose.pos.z), near: pose.near};
console.log(JSON.stringify(out));
"""


@unittest.skipUnless(NODE, "node not installed")
class StationsWalked(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        p = subprocess.run([NODE, "-e", SRC % {"root": json.dumps(ROOT), "doc": json.dumps(test_hqmetro.metro_fixture())}],
                           capture_output=True, text=True, timeout=120)
        if p.returncode != 0:
            raise AssertionError("node failed:\n" + p.stderr[-4000:])
        cls.o = json.loads(p.stdout.strip().splitlines()[-1])

    def test_feet_on_the_street_side_and_heads_past_the_gates(self):
        for s in self.o["st"]:
            for f in s["feet"]:
                self.assertIs(f["paid"], False, s["id"])
                for g in s["gates"]:
                    self.assertGreater(abs(f["u"] - g["u"]), 2.5, s["id"] + ": room between a way in and a gate line")
            self.assertTrue(all(h is True for h in s["heads"]), s["id"])

    def test_the_hall_is_open_over_a_well(self):
        for s in self.o["st"]:
            self.assertEqual(s["well"]["kind"], "stairs", s["id"])
            self.assertLess(s["well"]["y"], -0.5, s["id"])

    def test_stairs_are_walked_on_at_their_ends_only(self):
        for s in self.o["st"]:
            self.assertTrue(s["sideBlocked"], s["id"])
            self.assertFalse(s["headOk"], s["id"])

    def test_passages_reach_into_the_hall(self):
        for s in self.o["st"]:
            self.assertTrue(all(s["passEnds"]), s["id"])

    def test_camera_rooms(self):
        for s in self.o["st"]:
            self.assertEqual(s["camHall"], "hall", s["id"])
            self.assertEqual(s["camPlat"], "platform", s["id"])
            self.assertIsNone(s["camAbove"], s["id"])                 # over the hall's ceiling: nothing to see
            self.assertLess(s["hitUp"], 0.5, s["id"])                 # a camera ray up through the ceiling stops short
            self.assertAlmostEqual(s["ceil"], 3.6, places=3)

    def test_walk_on_boarding(self):
        w = self.o["walkOn"]
        self.assertNotIn("board", w["waiting"])                       # the train comes in: you are not swept aboard
        self.assertFalse(w["early"])                                   # before it stands there: no
        self.assertTrue(w["ok"])                                       # at an open door while it stands: in
        self.assertIn(w["phase"], ("seated", "standing"))
        self.assertGreaterEqual(w["dur"], 1150)
        self.assertLess(w["maxStep"], 0.25)                            # 50 ms apart: walked, never a jump

    def test_hard_camera(self):
        c = self.o["cam"]
        self.assertGreater(c["far"], 3)                                # free: well back
        self.assertTrue(c["tightHide"])                                # a wall at once behind you: at your eyes
        self.assertLess(c["tightD"], 0.05)
        self.assertAlmostEqual(c["tightY"], 1.65, places=2)
        self.assertLessEqual(c["near"], 0.1)


if __name__ == "__main__":
    unittest.main()
