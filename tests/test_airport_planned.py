"""A planned (City Gen v5) airport's client parts, run under node: the pier deck over the sea (games/hqairport3d.js),
the airside entrance road with its security gate and guard post (games/hqairfield.js L.airside, games/hqairbldg.js
boomStep / boomAt), and the tower and radar standing landside of the apron.

The Commons fixture (claude-hq@2) stands in for the world: its airport site with a planned 2.2 km runway
(site.runway, as backend v5/doc.rs writes it) is laid out the planned way."""
import json
import os
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")
SCRIPT = r"""
const fs = require('fs'), zlib = require('zlib'), path = require('path'), R0 = process.argv[1];
global.window = {HQV: {}};
for(const f of ['world', 'hqairfield', 'hqair', 'hqairport3d', 'hqairbldg']) eval(fs.readFileSync(path.join(R0, 'games', f + '.js'), 'utf8'));
const H = window.HQV, WD = H.world, AF = H.hqAirfield, A3 = H.hqAirport3d, ABL = H.hqAirbldg;
const W = WD.pack(JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(R0, 'tests/fixtures/claude-hq@2.json.gz')))));
const s0 = W.sites.filter(s => s.kind === 'airport')[0], site = Object.assign({}, s0, {runway: {x: 0, z: 0, dir: [0, 65536], len: 220000, side: 1, area: []}});
const L = AF.layout(W, site), hAt = (x, z) => WD.heightAt(W, x, z), out = {ok: L.ok, pier: !!L.pier};
const P3 = A3.plan(L, {ground: hAt}), PB = ABL.plan(L), Y = A3.Y;
function ground(x, z){
  const f = AF.floorAt(L, x, z);
  if(f != null){ const pv = AF.onPavement(L, x, z); return f + (pv ? Y[pv === 'runway' ? 'rwy' : pv === 'taxiway' ? 'taxi' : pv] || 0 : 0); }
  const ly = AF.landsideAt(L, x, z); if(ly != null) return hAt(x, z) + ly;
  const ay = AF.airsideY(L, x, z, hAt); if(ay != null) return ay;
  return hAt(x, z);
}
function segD(a, b, x, z){ const dx = b[0] - a[0], dz = b[1] - a[1], l = dx*dx + dz*dz; let t = l ? ((x - a[0])*dx + (z - a[1])*dz)/l : 0; t = Math.max(0, Math.min(1, t)); return Math.hypot(x - a[0] - dx*t, z - a[1] - dz*t); }
const fenceAt = (x, z) => P3.fence.some(f => segD(f[0], f[1], x, z) <= 0.6);
const down = {k: 0, hold: 0};
function blocked(x, z){
  if(ABL.hallAt(PB, x, z, 0.3)) return 'hall';
  if(fenceAt(x, z)) return 'fence';
  if(AF.airsideWall(L, x, z, hAt)) return 'parapet';
  if(ABL.blockedAt(PB, x, z, ground(x, z))) return 'building';
  return ABL.boomAt(PB, down, x, z) ? 'boom' : null;
}
// ---- drive the entrance from the forecourt to its end on the service road and 15 m on along it, centre and 2.5 m off
const A = L.airside || {road: []}, R = A.road.concat([AF.toWorld(L, L.frame.RU - 218, -126)]);
const drive = {steps: 0, worst: 0, blocks: [], boom: 0, n: 0};
for(const off of [-2.5, 0, 2.5]){
  let prev = null;
  for(let i = 0; i + 1 < R.length; i++){
    const a = R[i], b = R[i + 1], dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz), nx = -dz/l, nz = dx/l;
    for(let t = 0; t < l; t += 0.35){
      const x = a[0] + dx*t/l + nx*off, z = a[1] + dz*t/l + nz*off, y = ground(x, z), bk = blocked(x, z);
      drive.n++;
      if(bk === 'boom') drive.boom++; else if(bk && drive.blocks.length < 10) drive.blocks.push([bk, AF.toFrame(L, x, z)]);
      if(prev != null){ drive.worst = Math.max(drive.worst, Math.abs(y - prev)); if(Math.abs(y - prev) > 0.4) drive.steps++; }
      prev = y;
    }
  }
}
out.drive = drive;
const end = A.road[A.road.length - 1];
out.end = end ? {floor: AF.floorAt(L, end[0], end[1]), pave: AF.onPavement(L, end[0], end[1])} : null;
// the fence: open across the road only; the parapet where the causeway stands high
const edge = A.road[A.road.length - 2];
out.gap = edge ? {onRoad: P3.fence.filter(f => segD(f[0], f[1], edge[0], edge[1]) < 4).length,
                  beside: P3.fence.filter(f => segD(f[0], f[1], edge[0], edge[1]) < 12).length} : null;
const ck = PB.checkpoint;
out.checkpoint = ck ? {post: ABL.blockedAt(PB, ...ABL.toWorld(L, (ck.post.u0 + ck.post.u1)/2, (ck.post.v0 + ck.post.v1)/2), ck.y),
  postOffApron: AF.floorAt(L, ...ABL.toWorld(L, (ck.post.u0 + ck.post.u1)/2, (ck.post.v0 + ck.post.v1)/2)) == null,
  postBeside: Math.hypot((ck.post.u0 + ck.post.u1)/2 - ck.a[0], (ck.post.v0 + ck.post.v1)/2 - ck.a[1]) < 5,
  gateOffPlatform: AF.floorAt(L, ck.c[0], ck.c[1]) == null, raise: ground(ck.c[0], ck.c[1]) - hAt(ck.c[0], ck.c[1])} : null;
// ---- the boom: a car at 15 m/s from 40 m out (it lifts in time), then gone (down again); a parked car keeps it up;
// snap (Calm) in one step
function run(speed, from, secs, snap){
  const st = {k: 0, hold: 0}, c = ck.c, back = A.road[A.road.length - 6], dl = Math.hypot(c[0] - back[0], c[1] - back[1]), d0 = [(c[0] - back[0])/dl, (c[1] - back[1])/dl], log = [];
  for(let i = 0; i < secs*20; i++){
    const d = from - speed*i/20, car = {x: c[0] - d0[0]*d, z: c[1] - d0[1]*d, yaw: Math.atan2(d0[0], d0[1]), speed: speed};
    ABL.boomStep(st, PB, 0.05, [car], snap);
    log.push({t: i/20, d: d, k: st.k, hit: Math.abs(d) < 0.5 && ABL.boomAt(PB, st, c[0], c[1])});
  }
  return log;
}
const fast = run(15, 40, 14, false);
out.boom = {hit: fast.some(e => e.hit), upAt: (fast.find(e => e.k >= 1) || {}).t, downAt: (fast.find(e => e.d < 0 && e.k === 0) || {}).t,
            parked: run(0, 3, 10, false).slice(-1)[0].k, snap: run(0, 3, 0.05, true)[0].k, idle: ABL.boomStep({k: 1, hold: 0}, PB, 0.05, [], true).k};
// ---- the pier: piles under the deck over the sea only, the deck's underside, no rock revetment
const COL = {pile: 0x5b5750, deck: 0x6f6a62, rock: 0x7d776c};
const piles = P3.surf.filter(s => s.c === COL.pile && !s.two), soff = P3.surf.filter(s => s.c === COL.deck && s.two);
let pileBad = 0;
piles.forEach(s => { const q = s.q, x = (q[0] + q[3])/2, z = (q[2] + q[5])/2; if(AF.floorAt(L, x, z) == null || hAt(x, z) > L.sea) pileBad++; });
out.pier = {piles: piles.length, pileBad: pileBad, soffits: soff.length, rock: P3.surf.filter(s => s.c === COL.rock).length, water: P3.edges.water};
// ---- the tower and the radar landside of the apron
out.tower = [L.landside.tower, L.landside.asr].map(t => AF.floorAt(L, t.x, t.z));
process.stdout.write(JSON.stringify(out));
"""


@unittest.skipUnless(NODE, "node not installed")
class TestPlannedAirport(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        r = subprocess.run([NODE, "-e", SCRIPT, ROOT], capture_output=True, text=True, timeout=300)
        if r.returncode != 0:
            raise AssertionError("node failed: " + r.stderr[-3000:])
        cls.o = json.loads(r.stdout)

    def test_a_planned_layout_is_a_pier(self):
        self.assertTrue(self.o["ok"])
        self.assertTrue(self.o["pier"])

    def test_the_entrance_drives_from_the_forecourt_onto_the_service_road(self):
        d = self.o["drive"]
        self.assertGreater(d["n"], 2000)
        self.assertEqual(d["blocks"], [], "nothing but the boom across the way")
        self.assertEqual(d["steps"], 0, f"no step over 0.4 m (worst {d['worst']:.2f})")
        self.assertGreater(d["boom"], 0, "the boom, down, closes the road")
        self.assertIsNotNone(self.o["end"]["floor"], "it ends on the platform")
        self.assertEqual(self.o["end"]["pave"], "road")

    def test_the_fence_is_open_across_the_road_only(self):
        g = self.o["gap"]
        self.assertEqual(g["onRoad"], 0)
        self.assertGreater(g["beside"], 0, "the fence goes on either side of the gate")

    def test_the_guard_post_and_gate(self):
        c = self.o["checkpoint"]
        self.assertTrue(c["post"], "the guard post is solid")
        self.assertTrue(c["postOffApron"], "outside the fence (the apron inside it is the buses' stop)")
        self.assertTrue(c["postBeside"], "beside the boom's pivot")
        self.assertTrue(c["gateOffPlatform"], "the boom stands just outside the platform's edge")
        self.assertGreaterEqual(c["raise"], 0.1)

    def test_the_boom_lifts_for_a_car_and_comes_down_after(self):
        b = self.o["boom"]
        self.assertFalse(b["hit"], "a car at 15 m/s from 40 m out never meets the boom down")
        self.assertIsNotNone(b["upAt"])
        self.assertIsNotNone(b["downAt"], "down again once the car has gone")
        self.assertEqual(b["parked"], 1, "a car waiting at it keeps it up")
        self.assertEqual(b["snap"], 1, "Calm: it snaps open")
        self.assertEqual(b["idle"], 0, "Calm: and shut")

    def test_the_pier_stands_on_piles_over_the_sea(self):
        p = self.o["pier"]
        self.assertGreater(p["piles"], 400)
        self.assertEqual(p["pileBad"], 0, "every pile under the deck, in the sea")
        self.assertGreater(p["soffits"], 0, "the deck's underside")
        self.assertEqual(p["rock"], 0, "no rock revetment on a pier")
        self.assertGreater(p["water"], 0)

    def test_the_tower_and_radar_stand_landside(self):
        self.assertEqual(self.o["tower"], [None, None])


if __name__ == "__main__":
    unittest.main()
