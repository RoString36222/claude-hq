"""games/hqnetsmooth.js: other players drawn smoothly, run under node against a simulated network.

The simulation is the real pipeline's shape: the sender samples on a jittery 125 ms timer, the Arena forwards the
latest frame on its own 125 ms tick (phase drifting against the sender's, so frames are lost or repeated), the network
adds 0-40 ms, and the receiver draws at 60 fps. A car goes round a 60 m curve at 30 m/s, then a walker strolls.
Measured on what is drawn: the error against where they really were DELAY s before, and the jerk (the largest change
in drawn speed between frames), with the sender's clock ("motion") and without it (an older Arena).
"""
import json
import os
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")
SCRIPT = r"""
const fs = require('fs'), path = require('path');
global.window = {HQV: {}}; eval(fs.readFileSync(path.join(process.argv[1], 'games', 'hqnetsmooth.js'), 'utf8'));
const NS = window.HQV.hqNetSmooth;
let seed = 7; function rnd(){ seed = (seed*1103515245 + 12345) & 0x7fffffff; return seed/0x7fffffff; }
// the truth: a car at v m/s round a circle of radius R (or a walker on a straight line)
function truth(kind, t){
  if(kind === 'car'){ const R = 60, v = 30, a = v*t/R; return {x: R*Math.sin(a), z: R - R*Math.cos(a), yaw: a, vx: v*Math.cos(a), vz: v*Math.sin(a), yr: v/R}; }
  return {x: 1.4*t, z: 0, yaw: Math.PI/2, vx: 1.4, vz: 0, yr: 0};
}
function run(kind, motion, opts){
  opts = opts || {};
  seed = opts.seed || 7;
  const T = NS.track(), DUR = 12, senderClock0 = 5e5;      // the sender's clock has its own origin
  // sends: a timer at 125 ms +-20 ms
  const sends = []; for (let t = 0; t < DUR; ) { sends.push(t); t += 0.125 + (rnd() - 0.5)*0.04 + (rnd() < 0.05 ? 0.06 : 0); }
  // the Arena ticks at 125 ms with its own phase; each tick forwards the latest frame it holds (even if unchanged)
  const arrivals = []; let si = 0, held = null;
  for (let tk = 0.037; tk < DUR + 0.5; tk += 0.125) {
    while (si < sends.length && sends[si] <= tk) { held = sends[si]; si++; }
    if (held != null) arrivals.push({at: tk + 0.02 + rnd()*0.04 + (opts.spike && rnd() < 0.05 ? 0.15 : 0), sent: held});
  }
  arrivals.sort((a, b) => a.at - b.at);
  let ai = 0, maxErr = 0, sumErr = 0, nErr = 0, maxJerk = 0, prev = null, prevV = null, jumps = 0, maxYawErr = 0;
  const D = motion ? NS.DELAY : NS.DELAY_RX;
  for (let now = 0; now < DUR; now += 1/60) {
    while (ai < arrivals.length && arrivals[ai].at <= now) {
      const s = arrivals[ai++], tr = truth(kind, s.sent);
      const r = v => Math.round(v);                         // presence rounds: cm, whole degrees
      const f = {x: r(tr.x*100)/100, z: r(tr.z*100)/100, yaw: r(tr.yaw*180/Math.PI)*Math.PI/180, pitch: 0, y: null};
      if (motion) Object.assign(f, {t: Math.round(senderClock0 + s.sent*1000), vx: r(tr.vx*100)/100, vz: r(tr.vz*100)/100, yr: r(tr.yr*180/Math.PI)*Math.PI/180});
      NS.push(T, f, now);
    }
    const S = NS.sample(T, now); if (!S) continue;
    if (S.jump) jumps++;
    if (now > 1.5) {
      const tr = truth(kind, now - D - (motion ? 0.02 : 0.04)); // DELAY behind, after the quickest delivery (their clock) or the mean
      const e = Math.hypot(S.x - tr.x, S.z - tr.z); maxErr = Math.max(maxErr, e); sumErr += e; nErr++;
      maxYawErr = Math.max(maxYawErr, Math.abs(Math.atan2(Math.sin(S.yaw - tr.yaw), Math.cos(S.yaw - tr.yaw))));
      if (prev) {
        const v = Math.hypot(S.x - prev.x, S.z - prev.z)*60;
        if (prevV != null) maxJerk = Math.max(maxJerk, Math.abs(v - prevV));
        prevV = v;
      }
    }
    prev = {x: S.x, z: S.z};
  }
  return {maxErr, meanErr: sumErr/nErr, maxJerk, jumps, maxYawErr};
}
// the old way (hq3d.js before): velocity from arrival times, dead reckoning, a spring (omega 10), a 6 m snap
function runOld(kind){
  seed = 7;
  const DUR = 12, sends = []; for (let t = 0; t < DUR; ) { sends.push(t); t += 0.125 + (rnd() - 0.5)*0.04 + (rnd() < 0.05 ? 0.06 : 0); }
  const arrivals = []; let si = 0, held = null;
  for (let tk = 0.037; tk < DUR + 0.5; tk += 0.125) { while (si < sends.length && sends[si] <= tk) { held = sends[si]; si++; } if (held != null) arrivals.push({at: tk + 0.02 + rnd()*0.04, sent: held}); }
  arrivals.sort((a, b) => a.at - b.at);
  let P = {x: 0, z: 0, sx: 0, sz: 0, at: null, tx: null, tz: null, vx: 0, vz: 0}, ai = 0, prev = null, prevV = null, maxJerk = 0, snaps = 0;
  function spring(x, v, g, w, dt){ const e = Math.exp(-w*dt), d = x - g, c = v + w*d; return [g + (d + c*dt)*e, (v - w*c*dt)*e]; }
  for (let now = 0; now < DUR; now += 1/60) {
    while (ai < arrivals.length && arrivals[ai].at <= now) {
      const s = arrivals[ai++], tr = truth(kind, s.sent), nx = Math.round(tr.x*100)/100, nz = Math.round(tr.z*100)/100;
      if (P.at != null && now - P.at > 0.02 && now - P.at < 1) { const ia = 1/(now - P.at); P.vx = (nx - P.tx)*ia; P.vz = (nz - P.tz)*ia; }
      P.at = now; P.tx = nx; P.tz = nz;
    }
    if (P.tx == null) continue;
    const lead = Math.min(0.3, now - P.at), gx = P.tx + P.vx*lead, gz = P.tz + P.vz*lead;
    if (Math.hypot(gx - P.x, gz - P.z) > 6) { P.x = gx; P.z = gz; P.sx = P.sz = 0; snaps++; }
    else { const a = spring(P.x, P.sx, gx, 10, 1/60), b = spring(P.z, P.sz, gz, 10, 1/60); P.x = a[0]; P.sx = a[1]; P.z = b[0]; P.sz = b[1]; }
    if (now > 1.5 && prev) { const v = Math.hypot(P.x - prev.x, P.z - prev.z)*60; if (prevV != null) maxJerk = Math.max(maxJerk, Math.abs(v - prevV)); prevV = v; }
    prev = {x: P.x, z: P.z};
  }
  return {maxJerk, snaps};
}
const out = {car: run('car', true), carRx: run('car', false), walk: run('walk', true), walkRx: run('walk', false),
             carSpike: run('car', true, {spike: true, seed: 11}), old: runOld('car')};
// a teleport starts afresh, flagged once; a stale frame changes nothing
{ const T = NS.track(); NS.push(T, {t: 1000, x: 0, z: 0, yaw: 0, vx: 10, vz: 0}, 0); NS.push(T, {t: 1125, x: 1.25, z: 0, yaw: 0, vx: 10, vz: 0}, 0.13);
  NS.push(T, {t: 1250, x: 500, z: 0, yaw: 0, vx: 0, vz: 0}, 0.26); const S = NS.sample(T, 0.6);
  out.tele = {x: S.x, jump: S.jump, again: NS.sample(T, 0.62).jump};
  NS.push(T, {t: 1200, x: -99, z: 0, yaw: 0}, 0.7); out.stale = NS.sample(T, 0.8).x; }
// yaw across +-pi goes the short way
{ const T = NS.track(); NS.push(T, {t: 0, x: 0, z: 0, yaw: 3.1, vx: 0, vz: 0, yr: 0.4}, 0); NS.push(T, {t: 125, x: 0, z: 0, yaw: -3.13, vx: 0, vz: 0, yr: 0.4}, 0.125);
  const S = NS.sample(T, 0.2 + 0.0625); out.wrapYaw = S.yaw; }
console.log(JSON.stringify(out));
"""


@unittest.skipUnless(NODE, "node not installed")
class NetSmooth(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        r = subprocess.run([NODE, "-e", SCRIPT, ROOT], capture_output=True, text=True, timeout=120)
        if r.returncode:
            raise AssertionError(r.stderr[-3000:])
        cls.o = json.loads(r.stdout.strip().splitlines()[-1])

    def test_a_car_is_smooth_and_on_its_line(self):
        c = self.o["car"]
        self.assertLess(c["maxErr"], 2.0, c)                 # m off where it was DELAY s ago, at 30 m/s (a steady ~30 ms lag)
        self.assertLess(c["meanErr"], 1.0, c)
        self.assertLess(c["maxJerk"], 3, c)                  # m/s between frames: no lurch (it was 487 m/s, below)
        self.assertLess(c["maxYawErr"], 0.06, c)
        self.assertEqual(c["jumps"], 0)

    def test_far_smoother_than_before(self):
        self.assertGreater(self.o["old"]["maxJerk"], 50*self.o["car"]["maxJerk"], self.o)
        self.assertGreater(self.o["old"]["snaps"], 10, "the old spring kept snapping a 30 m/s car")

    def test_without_the_senders_clock_still_smooth(self):
        c = self.o["carRx"]
        self.assertLess(c["maxErr"], 2.5, c)
        self.assertLess(c["maxJerk"], 9, c)
        self.assertLess(c["maxJerk"], self.o["old"]["maxJerk"], self.o)

    def test_a_walker(self):
        for k in ("walk", "walkRx"):
            w = self.o[k]
            self.assertLess(w["maxErr"], 0.15, (k, w))
            self.assertLess(w["maxJerk"], 0.5, (k, w))

    def test_late_spikes(self):
        c = self.o["carSpike"]
        self.assertLess(c["maxErr"], 2.5, c)
        self.assertEqual(c["jumps"], 0)

    def test_teleport_stale_and_wrap(self):
        self.assertEqual(self.o["tele"], {"x": 500, "jump": True, "again": False})
        self.assertEqual(self.o["stale"], 500)
        self.assertGreater(abs(self.o["wrapYaw"]), 3.1, "the short way round, not through 0")


if __name__ == "__main__":
    unittest.main()
