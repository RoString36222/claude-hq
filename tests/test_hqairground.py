"""The airport's ground vehicles (games/hqairground.js, HQV.hqAirground; airport spec rev 2, sections 6 and 11).

node loads games/hqairground.js against a stub `window` and runs a literal turnaround schedule in the
traffic() format of spec 7.3 over the Commons fixture (tests/fixtures/airfield_commons.json): six contact
stands and three commuter stands, the tug pushing a synthetic departure back along the stand's lead-in (both
flows), and arriving jets taxiing a literal polyline with a stub `ahead`. Every second it checks the rules:
no vehicle on runway or taxiway pavement (shoulders included) except the tug pushing / on its way back and
the follow-me car; every vehicle on the platform; a stand-bound vehicle only in its own stand box; the tug
at nose + 4 m; the follow-me car 70 m ahead; no jumps. Then it builds the meshes with the vendored three.js
and counts draw calls with HQV.hqMerge.drawCount. One node process for the file; skipped without node."""
import json
import os
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")

HARNESS = r"""
var fs = require("fs"), url = require("url"), root = %(root)s;
import(url.pathToFileURL(root + "/games/vendor/three-module.js").href).then(function(THREE){
  global.window = {HQV: {}};
  ["hqmerge", "hqairground"].forEach(function(f){ new Function(fs.readFileSync(root + "/games/" + f + ".js", "utf8"))(); });
  var HQV = window.HQV, G = HQV.hqAirground, out = {};
  function fixture(){ return JSON.parse(fs.readFileSync(root + "/tests/fixtures/airfield_commons.json", "utf8")); }
  var L = fixture(), PI = Math.PI;

  /* ---------- geometry for the checks (independent of the module) ---------- */
  function inPoly(P, x, z){ var ins = false; for(var i = 0, j = P.length - 1; i < P.length; j = i++){ var a = P[i], b = P[j];
    if((a[1] > z) !== (b[1] > z) && x < (b[0] - a[0])*(z - a[1])/(b[1] - a[1]) + a[0]) ins = !ins; } return ins; }
  function segDist(p, a, b){ var dx = b[0] - a[0], dz = b[1] - a[1], L2 = dx*dx + dz*dz, k = L2 ? ((p[0] - a[0])*dx + (p[1] - a[1])*dz)/L2 : 0;
    k = Math.max(0, Math.min(1, k)); return Math.hypot(p[0] - a[0] - k*dx, p[1] - a[1] - k*dz); }
  function polyDist(P, p){ var d = Infinity; for(var i = 0; i + 1 < P.length; i++) d = Math.min(d, segDist(p, P[i], P[i + 1])); return d; }
  // runway (with its shoulders, out over the blast pads) and taxiway (with shoulders) pavement
  var RW = L.runway, rwHalf = RW.w/2 + RW.shoulder, txHalf = L.widths.A/2 + L.widths.shoulder;
  var rwA = [RW.c[0] - RW.dir[0]*(RW.len/2 + RW.pad), RW.c[1] - RW.dir[1]*(RW.len/2 + RW.pad)], rwB = [RW.c[0] + RW.dir[0]*(RW.len/2 + RW.pad), RW.c[1] + RW.dir[1]*(RW.len/2 + RW.pad)];
  var taxi = Object.keys(L.lines).filter(function(k){ return k !== "RWY"; }).map(function(k){ return L.lines[k]; });
  var curves = Object.keys(L.curves).filter(function(k){ return !/^S/.test(k); }).map(function(k){ return L.curves[k]; });
  function pavement(p){
    if(segDist(p, rwA, rwB) <= rwHalf) return "runway";
    for(var i = 0; i < taxi.length; i++) if(segDist(p, taxi[i][0], taxi[i][1]) <= txHalf) return "taxiway";
    for(i = 0; i < curves.length; i++) if(polyDist(curves[i], p) <= txHalf) return "taxiway";
    return null;
  }
  function onPlatform(p){ return L.platform.some(function(P){ return inPoly(P, p[0], p[1]); }); }
  function boxOf(p){ var r = []; L.stands.forEach(function(s){ if(inPoly(s.box, p[0], p[1])) r.push(String(s.id)); }); return r; }
  // the footprint: centre, corners and edge midpoints
  function foot(q){
    var S = G.SIZE[q.type], hl = S[0]/2, hw = S[1]/2, f = [Math.sin(q.yaw), Math.cos(q.yaw)], l = [Math.cos(q.yaw), -Math.sin(q.yaw)], pts = [];
    [[0, 0], [1, 1], [1, -1], [-1, 1], [-1, -1], [1, 0], [-1, 0], [0, 1], [0, -1]].forEach(function(k){
      pts.push([q.x + f[0]*hl*k[0] + l[0]*hw*k[1], q.z + f[1]*hl*k[0] + l[1]*hw*k[1]]); });
    return pts;
  }
  var stById = {}; L.stands.forEach(function(s){ stById[String(s.id)] = s; });

  /* ---------- a literal schedule (traffic() format, spec 7.3) ---------- */
  var T0 = 1.9e12, NOSE = 19.05, AMPH = 7.4;
  function plen(P){ var s = 0; for(var i = 1; i < P.length; i++) s += Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]); return s; }
  function pat(P, s){
    if(s < 0) s = 0;
    for(var i = 1; i < P.length; i++){ var d = Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]);
      if(s <= d || i === P.length - 1){ var k = d ? Math.min(1, s/d) : 0; return {x: P[i - 1][0] + (P[i][0] - P[i - 1][0])*k, z: P[i - 1][1] + (P[i][1] - P[i - 1][1])*k,
        yaw: Math.atan2(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]), end: s > d && i === P.length - 1}; } s -= d; }
    return null;
  }
  // flows alternate by stand: odd stands 36 (B southbound), even 18
  function flowFor(id){ return (+id) %% 2 ? "36" : "18"; }
  var sched = [];
  ["1", "2", "3", "4", "5", "6"].forEach(function(id, k){ sched.push({id: id, kind: "contact", tIn: T0 + k*240000, tOut: T0 + k*240000 + 17*60000, flow: flowFor(id)}); });
  ["21", "22", "23"].forEach(function(id, k){ sched.push({id: id, kind: "commuter", tIn: T0 + 180000 + k*240000, tOut: T0 + 180000 + k*240000 + 12*60000, flow: k %% 2 ? "18" : "36"}); });
  // an arriving jet's taxi route from the end of its exit (on A) to its stand, from the fixture's lines and curves
  function arrRoute(st, flow){
    var C = L.curves[st.lead[flow]], A = L.lines.A, B = L.lines.B, s = flow === "36" ? 1 : -1, Q = C[0];
    var zA = s*640, zEnd = s*815;
    return [[A[0][0], zA], [A[0][0], zEnd], [B[0][0], zEnd], [B[0][0], Q[1]]].concat(C.slice(1));
  }
  var ARR_V = 8, LEAD_V = 2.5;
  function arrTiming(e){
    var st = stById[e.id], P = arrRoute(st, e.flow), C = L.curves[st.lead[e.flow]], lc = plen(C), lt = plen(P) - lc;
    return {P: P, lt: lt, lc: lc, T: lt/ARR_V + lc/LEAD_V};
  }
  // the arriving aircraft's distance along its route at ms (from tIn - T)
  function arrS(e, A, ms){ var t = (ms - (e.tIn - A.T*1000))/1000; return t*ARR_V <= A.lt ? t*ARR_V : A.lt + (t - A.lt/ARR_V)*LEAD_V; }
  function state(ms){
    var stands = {}, moving = [];
    sched.forEach(function(e){
      var st = stById[e.id], C = L.curves[st.lead[e.flow]], lc = plen(C), Cr = C.slice().reverse(), pushT = lc/1.0;
      var S = {airline: "tokenline", reg: "HQ-ABC", kind: e.kind === "contact" ? "jet" : "amphib", tIn: e.tIn, tOut: e.tOut, end: e.flow};
      if(ms < e.tIn - 300000) return;
      if(ms < e.tIn) S.state = "arriving";
      else if(ms < e.tOut) S.state = "turnaround";
      else if(ms < e.tOut + pushT*1000) { S.state = "pushback"; S.pushT = (ms - e.tOut)/1000; }
      else S.state = "empty";
      stands[e.id] = S;
      // the departure: pushed tail-first along the lead-in at 1 m/s, then forward along B in the flow's direction
      if(ms >= e.tOut && ms < e.tOut + (pushT + 90)*1000){
        var t = (ms - e.tOut)/1000, pose;
        if(t < pushT){ var q = pat(C, lc - t); pose = {x: q.x, z: q.z, yaw: q.yaw, phase: "pushback", rev: true}; }
        else { var d = [C[1][0] - C[0][0], C[1][1] - C[0][1]], dl = Math.hypot(d[0], d[1]), ts = t - pushT;
          pose = {x: C[0][0] + d[0]/dl*5*ts, z: C[0][1] + d[1]/dl*5*ts, yaw: Math.atan2(d[0], d[1]), phase: "taxi"}; }
        moving.push({id: "D" + e.id, cls: e.kind === "contact" ? "jet" : "commuter", kind: e.kind === "contact" ? "jet" : "amphib", pose: pose,
                     R: {standA: e.id, tPush1: pushT, endA: e.flow === "36" ? 0 : 1}, t: t});
      }
      // the arrival (jets): taxiing from the end of its exit; a while in the exit phase before that
      if(e.kind === "contact"){
        var A = arrTiming(e), t0 = e.tIn - A.T*1000;
        if(ms >= t0 - 20000 && ms < e.tIn){
          var s = arrS(e, A, ms), q2 = pat(A.P, Math.max(0, s));
          moving.push({id: "A" + e.id, cls: "jet", kind: "jet", pose: {x: q2.x, z: q2.z, yaw: q2.yaw, phase: ms < t0 ? "exit" : "taxi"},
                       R: {standB: e.id, tTD: 0, endB: e.flow === "36" ? "36" : "18"}, t: 100 + (ms - t0)/1000, _e: e, _A: A, _s: Math.max(0, s)});
        }
      }
    });
    return {stands: stands, moving: moving};
  }
  var aheadCalls = 0;
  function ahead(m, d){ aheadCalls++; var q = pat(m._A.P, m._s + d); return q && !q.end ? {x: q.x, z: q.z, yaw: q.yaw} : null; }

  /* ---------- run it: every second over 30 minutes ---------- */
  var bad = {pavement: [], platform: [], box: [], tug: [], tugReturn: [], follow: [], jump: [], cap: [], nan: []};
  var seen = {types: {}, phases: {}}, prev = {}, maxFollowErr = 0, followN = 0, pushN = 0, returnN = 0, maxReturn = 0, workSeen = {}, liftMax = 0;
  function note(list, s){ if(list.length < 12) list.push(s); }
  for(var ms = T0 - 300000; ms <= T0 + 30*60000; ms += 1000){
    var S = state(ms), P = G.poses(L, S.stands, S.moving, ms, ahead), now = {}, cnt = {};
    P.forEach(function(q){
      seen.types[q.type] = 1; seen.phases[q.phase] = 1; cnt[q.type] = (cnt[q.type] || 0) + 1;
      if(![q.x, q.y, q.z, q.yaw].every(isFinite)){ note(bad.nan, JSON.stringify(q)); return; }
      if(q.phase === "work") workSeen[q.type] = 1;
      if(q.lift) liftMax = Math.max(liftMax, q.lift);
      var t = (ms - T0)/1000, exemptPave = q.type === "followme" || (q.type === "tug" && (q.phase === "push" || q.phase === "return"));
      // a commuter stand's nose + 4 m is 0.6 m inside the apron's edge (fixture): a 6 m tug there overhangs it, so
      // near that spot only its centre is checked
      var cst = q.type === "tug" && q.stand && stById[q.stand].kind === "commuter" ? stById[q.stand] : null;
      var commuterNose = !!cst && Math.hypot(q.x - (cst.x + Math.sin(cst.yaw)*(AMPH + 4)), q.z - (cst.z + Math.cos(cst.yaw)*(AMPH + 4))) <= 6;
      foot(q).forEach(function(p, i){
        var pv = pavement(p);
        if(pv && !exemptPave) note(bad.pavement, t + "s " + q.type + " " + q.phase + " " + pv + " at " + p.map(function(v){ return v.toFixed(1); }));
        if((i === 0 || !commuterNose) && !onPlatform(p)) note(bad.platform, t + "s " + q.type + " " + q.phase + " at " + p.map(function(v){ return v.toFixed(1); }));
        boxOf(p).forEach(function(b){ if(b !== q.stand) note(bad.box, t + "s " + q.type + " (" + q.stand + ") in box " + b); });
      });
      if(q.id && q.phase !== "park"){ now[q.id] = q; var o = prev[q.id];
        if(o && Math.hypot(q.x - o.x, q.z - o.z) > 9.5) note(bad.jump, t + "s " + q.id + " " + Math.hypot(q.x - o.x, q.z - o.z).toFixed(1) + " m"); }
    });
    Object.keys(cnt).forEach(function(k){ if(cnt[k] > G.CAP[k]) note(bad.cap, k + " " + cnt[k]); });
    prev = now;
    // the tug at the nose + 4 m during the push; its way back <= 30 s
    S.moving.forEach(function(m){
      if(!m.R.standA) return;
      var tg = P.filter(function(q){ return q.type === "tug" && q.stand === m.R.standA; })[0], nose = stById[m.R.standA].kind === "commuter" ? AMPH : NOSE;
      if(m.pose.phase === "pushback"){
        pushN++;
        var want = [m.pose.x + Math.sin(m.pose.yaw)*(nose + 4), m.pose.z + Math.cos(m.pose.yaw)*(nose + 4)];
        if(!tg || tg.phase !== "push" || Math.hypot(tg.x - want[0], tg.z - want[1]) > 1) note(bad.tug, ((ms - T0)/1000) + "s stand " + m.R.standA + " " + JSON.stringify(tg));
      } else if(tg && tg.phase === "return"){ returnN++; maxReturn = Math.max(maxReturn, m.t - m.R.tPush1); if(m.t - m.R.tPush1 > 30) note(bad.tugReturn, m.R.standA + " " + (m.t - m.R.tPush1)); }
      if(tg && tg.phase === "push" && m.pose.phase !== "pushback") note(bad.tug, "push pose after the push, stand " + m.R.standA);
    });
    // the follow-me 70 m ahead (along the route) while leading
    P.filter(function(q){ return q.type === "followme" && q.phase === "lead"; }).forEach(function(q){
      var m = S.moving.filter(function(x){ return x.id === q.of; })[0];
      if(!m){ note(bad.follow, "no aircraft for " + q.of); return; }
      // the car's distance along the route, by its nearest route point
      var A = m._A.P, best = Infinity, bs = 0, acc = 0;
      for(var i = 1; i < A.length; i++){ var d = Math.hypot(A[i][0] - A[i - 1][0], A[i][1] - A[i - 1][1]);
        var k = d ? Math.max(0, Math.min(1, ((q.x - A[i - 1][0])*(A[i][0] - A[i - 1][0]) + (q.z - A[i - 1][1])*(A[i][1] - A[i - 1][1]))/(d*d))) : 0;
        var dd = Math.hypot(A[i - 1][0] + (A[i][0] - A[i - 1][0])*k - q.x, A[i - 1][1] + (A[i][1] - A[i - 1][1])*k - q.z);
        if(dd < best - 1e-9){ best = dd; bs = acc + d*k; } acc += d; }
      var err = Math.abs(bs - m._s - 70); maxFollowErr = Math.max(maxFollowErr, err); followN++;
      if(err > 5 || best > 0.5) note(bad.follow, ((ms - T0)/1000) + "s err " + err.toFixed(2) + " off " + best.toFixed(2));
      if(m.pose.phase !== "taxi") note(bad.follow, "leading before the end of the exit");
    });
  }
  out.bad = bad; out.seen = seen; out.maxFollowErr = maxFollowErr; out.followN = followN; out.pushN = pushN; out.returnN = returnN; out.maxReturn = maxReturn;
  out.workSeen = workSeen; out.liftMax = liftMax; out.aheadCalls = aheadCalls;

  /* ---------- pure: the same inputs, the same poses (a fresh copy of L, any call order) ---------- */
  var times = [T0 + 30000, T0 + 400000, T0 + 17*60000 + 20000, T0 + 21*60000 + 5000];
  var a1 = times.map(function(ms){ var S = state(ms); return JSON.stringify(G.poses(L, S.stands, S.moving, ms, ahead)); });
  var L2 = fixture();
  var a2 = times.slice().reverse().map(function(ms){ var S = state(ms); return JSON.stringify(G.poses(L2, S.stands, S.moving, ms, ahead)); }).reverse();
  out.pure = a1.every(function(s, i){ return s === a2[i]; });
  out.empty = G.poses(L, {}, [], T0, ahead).map(function(q){ return q.type + ":" + q.phase; });
  out.noL = [G.poses(null, {}, [], T0, ahead).length, G.poses({ok: false}, {}, [], T0, ahead).length];
  // archipelago metres: moving poses and ahead() offset by (cx, cz) give the same vehicles
  var off = 5000, S3 = state(T0 + 17*60000 + 20000), mv = S3.moving.map(function(m){ var c = Object.assign({}, m); c.pose = Object.assign({}, m.pose, {x: m.pose.x + off, z: m.pose.z - off}); return c; });
  var shifted = G.poses(L, S3.stands, mv, T0 + 17*60000 + 20000, function(m, d){ var q = ahead(m, d); return q ? {x: q.x + off, z: q.z - off, yaw: q.yaw} : null; }, {cx: off, cz: -off});
  var plain = G.poses(L, S3.stands, S3.moving, T0 + 17*60000 + 20000, ahead);
  out.offsetSame = shifted.length === plain.length && shifted.every(function(q, i){ var r = plain[i];
    return q.type === r.type && q.id === r.id && Math.abs(q.x - r.x) < 1e-6 && Math.abs(q.z - r.z) < 1e-6 && Math.abs(Math.sin(q.yaw - r.yaw)) < 1e-6; });

  /* ---------- the meshes: draw calls with the real THREE ---------- */
  function mat(c, o){ return new THREE.MeshStandardMaterial(Object.assign({color: c, roughness: 0.7, metalness: 0.08}, o || {})); }
  var c = {THREE: THREE, mat: mat}, V = G.create(c, L);
  // the busiest second of the run, plus every vehicle type at least once
  var busiest = null, bn = -1;
  for(ms = T0; ms <= T0 + 30*60000; ms += 10000){ var S4 = state(ms), P4 = G.poses(L, S4.stands, S4.moving, ms, ahead); if(P4.length > bn){ bn = P4.length; busiest = P4; } }
  var all = busiest.slice(); G.TYPES.forEach(function(t){ for(var i = 0; i < G.CAP[t]; i++) all.push({type: t, x: -820 + i, y: 0.1, z: 0, yaw: 0, beacon: true, lift: 1}); });
  out.draws = {};
  V.setNight(false); V.set(busiest); out.draws.day = HQV.hqMerge.drawCount(V.g); out.busiest = busiest.length;
  V.setNight(true); V.set(all); out.draws.nightAll = HQV.hqMerge.drawCount(V.g);
  out.tris = V.drawn().tris; out.drawnAll = V.drawn().n;
  V.setDetail(1); out.draws.level1 = HQV.hqMerge.drawCount(V.g); V.set([]); V.setDetail(2);
  V.setVisible(false); out.draws.hidden = HQV.hqMerge.drawCount(V.g); V.setVisible(true);
  V.set([]); out.draws.none = HQV.hqMerge.drawCount(V.g);
  V.set(all); var meshes = 0, pts = 0, casters = 0; V.g.traverse(function(o){ if(o.isMesh) meshes++; if(o.isPoints) pts++; if(o.castShadow) casters++; }); out.meshes = meshes; out.points = pts; out.casters = casters;
  // the batch's instances agree with the poses: every type at its CAP, and set([]) hides them all again
  out.capAll = G.TYPES.every(function(t){ return out.drawnAll[t] === G.CAP[t]; }) && out.drawnAll.cateringBox === G.CAP.catering;
  var disposed = 0; V.g.traverse(function(o){ if(o.geometry) o.geometry.addEventListener("dispose", function(){ disposed++; }); });
  V.dispose(); out.disposed = disposed;
  process.stdout.write(JSON.stringify(out));
}).catch(function(e){ console.error(e && e.stack || e); process.exit(1); });
"""


@unittest.skipUnless(NODE, "node not installed")
class TestHqAirground(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        js = HARNESS % {"root": json.dumps(ROOT)}
        p = subprocess.run([NODE, "-e", js], capture_output=True, text=True, timeout=600)
        if p.returncode != 0:
            raise AssertionError("node harness failed:\n" + p.stderr)
        cls.r = json.loads(p.stdout)

    def test_every_vehicle_type_and_job_runs(self):
        types = set(self.r["seen"]["types"])
        self.assertEqual(types, {"tug", "tractor", "cart", "belt", "dispenser", "tanker", "catering", "followme", "bus", "arff"})
        for t in ("belt", "tractor", "dispenser", "catering", "bus", "tug"):
            self.assertIn(t, self.r["workSeen"], t + " never reached its spot")
        for ph in ("park", "drive", "work", "push", "return", "lead", "off"):
            self.assertIn(ph, self.r["seen"]["phases"])
        self.assertEqual(self.r["bad"]["nan"], [])
        self.assertGreater(self.r["liftMax"], 1.0)
        self.assertLessEqual(self.r["liftMax"], 3.0)

    def test_deterministic(self):
        self.assertTrue(self.r["pure"])
        self.assertTrue(self.r["offsetSame"])
        self.assertEqual(self.r["noL"], [0, 0])
        # with no traffic: only the parked ones (the tanker, the fire trucks, the waiting bus, the depot)
        self.assertTrue(all(x.endswith(":park") for x in self.r["empty"]), self.r["empty"])
        self.assertIn("tanker:park", self.r["empty"])
        self.assertEqual(self.r["empty"].count("arff:park"), 2)

    def test_off_runway_and_taxiway_pavement(self):
        self.assertEqual(self.r["bad"]["pavement"], [])

    def test_on_the_platform(self):
        self.assertEqual(self.r["bad"]["platform"], [])

    def test_only_their_own_stand_box(self):
        self.assertEqual(self.r["bad"]["box"], [])

    def test_tug_at_the_nose_while_pushing(self):
        self.assertGreater(self.r["pushN"], 100)
        self.assertEqual(self.r["bad"]["tug"], [])
        self.assertGreater(self.r["returnN"], 0)
        self.assertLessEqual(self.r["maxReturn"], 30)
        self.assertEqual(self.r["bad"]["tugReturn"], [])

    def test_follow_me_70_m_ahead(self):
        self.assertGreater(self.r["followN"], 100)
        self.assertLessEqual(self.r["maxFollowErr"], 5)
        self.assertEqual(self.r["bad"]["follow"], [])

    def test_no_jumps_and_within_capacity(self):
        self.assertEqual(self.r["bad"]["jump"], [])
        self.assertEqual(self.r["bad"]["cap"], [])

    def test_draw_calls(self):
        d = self.r["draws"]
        self.assertLessEqual(d["day"], 2, d)               # one BatchedMesh for every vehicle, one Points cloud
        self.assertLessEqual(d["nightAll"], 2, d)
        self.assertEqual(self.r["meshes"], 1)
        self.assertEqual(self.r["casters"], 0)
        self.assertTrue(self.r["capAll"], self.r["drawnAll"])
        self.assertEqual(self.r["points"], 1)
        self.assertEqual(d["level1"], 0)
        self.assertEqual(d["hidden"], 0)
        self.assertEqual(d["none"], 0)
        self.assertLessEqual(self.r["tris"], 40000)
        self.assertEqual(self.r["disposed"], 2)             # the batch's and the beacons' geometry


# the real chain: hqAirfield's timetable and ends -> hqair.traffic -> poses (no stubs): R.standA / R.standB are the
# ends' stand objects there, and the tug and the follow-me car must still find their aircraft
REAL = r"""
var fs = require("fs"), root = %(root)s;
global.window = {HQV: {}};
["hqairfield", "hqair", "hqairground"].forEach(function(f){ new Function(fs.readFileSync(root + "/games/" + f + ".js", "utf8"))(); });
var HQV = window.HQV, AF = HQV.hqAirfield, A = HQV.hqAir, G = HQV.hqAirground;
var L = JSON.parse(fs.readFileSync(root + "/tests/fixtures/airfield_commons.json", "utf8"));
var ISLES = {"island:a@2": [3200, -2600], "island:b@2": [-3400, 2900]};
var ctx = {L: L, world: "claude-hq@2", dests: Object.keys(ISLES), cx: 0, cz: 0,
  farEnd: function(m){ return A.nominalAirport(Math.sin(m.far)*9000, Math.cos(m.far)*9000, [0, 0]); },
  islandEnd: function(w){ return A.dockEnd(null, ISLES[w][0], ISLES[w][1], [0, 0]); }};
var t0 = AF.slotBase(ctx.world, 2000), o = {cache: new Map(), holds: new Map()}, out = {push: 0, pushNear: 0, pushFar: [], lead: 0, arrTaxi: 0, tugPh: {}, fmPh: {}};
function ahead(e, d){ return A.aheadOf(e.R, e.pose.along, d); }
for(var s = 0; s < 3*3600; s += 2){
  var now = t0 + s*1000, tr = A.traffic(AF, ctx, now, o), P = G.poses(L, tr.stands, tr.moving, now, ahead, {cx: 0, cz: 0});
  P.forEach(function(q){ if(q.type === "tug") out.tugPh[q.phase] = 1; if(q.type === "followme") out.fmPh[q.phase] = 1; });
  tr.moving.forEach(function(m){
    var p = m.pose, f = [Math.sin(p.yaw), Math.cos(p.yaw)];
    if(m.cls === "jet" && m.type === "arr" && p.phase === "taxi") out.arrTaxi++;
    if(p.phase !== "pushback" || m.pose.speed < 0.2) return;
    out.push++;
    var nose = m.cls === "jet" ? 19.05 : 7.4, want = [p.x + f[0]*(nose + 4), p.z + f[1]*(nose + 4)];
    var near = P.some(function(q){ return q.type === "tug" && q.phase === "push" && Math.hypot(q.x - want[0], q.z - want[1]) < 3; });
    if(near) out.pushNear++; else if(out.pushFar.length < 5) out.pushFar.push([s, m.id]);
  });
  if(P.some(function(q){ return q.type === "followme" && q.phase === "lead"; })) out.lead++;
}
process.stdout.write(JSON.stringify(out));
"""


@unittest.skipUnless(NODE, "node not installed")
class TestHqAirgroundRealTraffic(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        p = subprocess.run([NODE, "-e", REAL % {"root": json.dumps(ROOT)}], capture_output=True, text=True, timeout=600)
        if p.returncode != 0:
            raise AssertionError("node harness failed:\n" + p.stderr)
        cls.r = json.loads(p.stdout)

    def test_the_tug_pushes_every_pushback(self):
        self.assertGreater(self.r["push"], 100)
        self.assertEqual(self.r["pushFar"], [])
        self.assertEqual(self.r["pushNear"], self.r["push"])
        for ph in ("push", "return"):
            self.assertIn(ph, self.r["tugPh"])

    def test_the_follow_me_car_leads_arriving_jets(self):
        self.assertGreater(self.r["arrTaxi"], 100)
        self.assertIn("lead", self.r["fmPh"])
        self.assertGreater(self.r["lead"], 30)


if __name__ == "__main__":
    unittest.main()
