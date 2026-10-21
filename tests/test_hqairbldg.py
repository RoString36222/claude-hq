"""The airport's airside and landside buildings (games/hqairbldg.js, HQV.hqAirbldg; airport spec, sections 5, 9, 11).

node imports the vendored three.js, loads games/hqmerge.js, games/hqcivic.js, games/hqairbldg.js and games/world.js
against a stub `window` and the stub hq3d ctx of tests/test_hqcivic.py (real THREE objects, canvases as a no-op 2D
proxy), plans and builds the Commons airfield from tests/fixtures/airfield_commons.json, and reports the walk
contract, the jet bridges, footprints and draw calls; the Python side checks them against the fixture. One node
process for the whole file. Skipped when node is not installed. Stdlib only."""
import json
import math
import os
import re
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "games", "hqairbldg.js")
FIXTURE = os.path.join(ROOT, "tests", "fixtures", "airfield_commons.json")
NODE = shutil.which("node")

HARNESS = r"""
var fs = require("fs"), url = require("url"), zlib = require("zlib"), root = %(root)s;
import(url.pathToFileURL(root + "/games/vendor/three-module.js").href).then(function(THREE){
  global.window = {HQV: {}};
  ["hqmerge", "hqcivic", "hqairbldg", "world"].forEach(function(f){ new Function(fs.readFileSync(root + "/games/" + f + ".js", "utf8"))(); });
  var HQV = window.HQV, AB = HQV.hqAirbldg, out = {};
  function hashStr(s){ var h = 2166136261 >>> 0; s = String(s); for(var i = 0; i < s.length; i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h >>> 0; }
  function rng(seed){ var a = seed >>> 0 || 1; return function(){ a = (a + 0x6D2B79F5) >>> 0; var t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0)/4294967296; }; }
  function mat(c, o){ return new THREE.MeshStandardMaterial(Object.assign({color: c, roughness: 0.7, metalness: 0.08}, o || {})); }
  function emis(c, e, ei, o){ var m = mat(c, o); m.emissive = new THREE.Color(e); m.emissiveIntensity = ei; return m; }
  function add(o, x, y, z, p, ns){ o.position.set(x, y, z); if(!ns){ o.castShadow = true; o.receiveShadow = true; } p.add(o); return o; }
  var texts = [];
  var noop2d = new Proxy({}, {get(t, k){ return k === "measureText" ? function(){ return {width: 10}; } : k === "fillText" ? function(s){ texts.push(String(s)); }
    : (k === "createLinearGradient" || k === "createRadialGradient") ? function(){ return {addColorStop(){}}; } : function(){}; }, set(){ return true; }});
  var c = {THREE: THREE, PI: Math.PI, E: {calm(){ return false; }}, rng: rng, hashStr: hashStr, mat: mat, emis: emis, add: add,
    box(w, h, d, m, x, y, z, p, ns){ return add(new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m), x, y, z, p, ns); },
    cyl(rt, rb, h, m, x, y, z, p, seg){ return add(new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg || 20), m), x, y, z, p); },
    sph(r, m, x, y, z, p){ return add(new THREE.Mesh(new THREE.SphereGeometry(r, 14, 10), m), x, y, z, p); },
    canvasTex(w, h, draw){ if(draw) draw(noop2d, w, h); return {c: null, g: noop2d, t: new THREE.Texture()}; },
    glow(col, s, o){ return new THREE.Sprite(new THREE.SpriteMaterial({color: col, opacity: o, transparent: true})); },
    label(t){ var s = new THREE.Sprite(new THREE.SpriteMaterial({transparent: true})); s.name = "label:" + t; return s; },
    short(s, n){ s = String(s || ""); return s.length > n ? s.slice(0, n) : s; }};
  var L = JSON.parse(fs.readFileSync(root + "/tests/fixtures/airfield_commons.json", "utf8"));
  var P = AB.plan(L), F = function(x, z){ return AB.toFrame(L, x, z); }, W = function(u, v){ return AB.toWorld(L, u, v); };
  out.plan = {floors: P.floors, gate: P.gate, gates: P.gates, hangarStand: P.hangarStand, tower: P.tower, asr: P.asr, zones: P.zones, blocks: P.blocks,
    bridges: P.bridges, hangars: P.hangars, piers: P.piers};
  out.deterministic = JSON.stringify(AB.plan(L)) === JSON.stringify(AB.plan(L));
  out.none = [AB.plan(null), AB.plan({ok: false, why: "x"}), AB.create(c, {ok: false}), AB.floorAt(null, 0, 0, 0), AB.blockedAt(null, 0, 0, 0), AB.gateSpot(P, "99")];
  out.NAVE = AB.NAVE; out.civicNave = HQV.hqCivic.AIRPORT_NAVE; out.K = AB.K;

  /* ---------- bridge poses (pure) ---------- */
  out.poses = P.bridges.map(function(b){
    var e = AB.bridgePose(b, 1), r = AB.bridgePose(b, 0), h = AB.bridgePose(b, 0.5);
    return {stand: b.stand, rot: b.rot, ext: {door: e.door, bogie: e.bogie, cab: AB.cabBox(e), len: e.len, pitch: e.pitch}, ret: {door: r.door, bogie: r.bogie, cab: AB.cabBox(r)},
            half: {door: h.door}};
  });

  /* ---------- the walk: door, nave, ramp, mezzanine, skybridge, gallery, every gate ---------- */
  function walk(pts){
    var y = P.ys, maxStep = 0, blocked = [], ys = [], prev = null;
    pts.forEach(function(q){
      var w = W(q[0], q[1]), f = AB.floorAt(P, w[0], w[1], y), ny = f != null ? f : P.ys;
      maxStep = Math.max(maxStep, Math.abs(ny - y)); y = ny; ys.push(y);
      if(AB.blockedAt(P, w[0], w[1], y)) blocked.push([q[0], q[1], y]);
    });
    return {maxStep: maxStep, blocked: blocked.slice(0, 5), end: y, ys: ys.filter(function(_, i){ return i %% 40 === 0; })};
  }
  function line(a, b, step){ var n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1])/step)), r = []; for(var i = 0; i <= n; i++) r.push([a[0] + (b[0] - a[0])*i/n, a[1] + (b[1] - a[1])*i/n]); return r; }
  var gu = P.conc.u1 - 6;
  out.walks = {};
  Object.keys(P.gates).forEach(function(id){
    var g = P.gates[id], gf = F(g.x, g.z);
    var pts = line([P.term.u0 - 1.2, 0], [gu, 0], 0.25).concat(line([gu, 0], [gu, gf[1]], 0.25)).concat(line([gu, gf[1]], [gf[0], gf[1]], 0.25));
    out.walks[id] = walk(pts);
  });
  var rd = W(140, 0), rp = W(125, 0);
  out.road = {floor: AB.floorAt(P, rd[0], rd[1], -1.3), floorUp: AB.floorAt(P, rd[0], rd[1], 4.9), blocked: AB.blockedAt(P, rd[0], rd[1], -1.3),
              pierBlocked: AB.blockedAt(P, W(P.piers[0][0], P.piers[0][1])[0], W(P.piers[0][0], P.piers[0][1])[1], -1)};
  var nv = W(30, 0); out.rampNoCond = [AB.floorAt(P, nv[0], nv[1], -50), AB.floorAt(P, nv[0], nv[1], null)];
  out.gateSpots = Object.keys(P.gates).map(function(id){ var s = AB.gateSpot(P, id); return {id: id, s: s, floor: AB.floorAt(P, s.x, s.z, s.y), blocked: AB.blockedAt(P, s.x, s.z, s.y)}; });
  // the concourse ground floor blocks at apron level; the gallery does not block above it
  var cg = W((P.conc.u0 + P.conc.u1)/2, 40); out.concBlock = [AB.blockedAt(P, cg[0], cg[1], L.y), AB.blockedAt(P, cg[0], cg[1], P.gate)];
  // the helicopter's floor: the tower, the concourse, the skybridge, both hangars, the car park; open apron: null
  var H0 = P.hangars[0], H1 = P.hangars[1], hc0 = W((H0.u0 + H0.u1)/2, (H0.v0 + H0.v1)/2), hc1 = W((H1.u0 + H1.u1)/2, (H1.v0 + H1.v1)/2);
  var skm = W((P.sky.u0 + P.sky.u1)/2, P.sky.v), cpm = W((P.carpark.u0 + P.carpark.u1)/2, (P.carpark.v0 + P.carpark.v1)/2);
  out.roofs = {tower: AB.roofAt(P, P.tower.x, P.tower.z), conc: AB.roofAt(P, cg[0], cg[1]), sky: AB.roofAt(P, skm[0], skm[1]), hangar0: AB.roofAt(P, hc0[0], hc0[1]),
               hangar1: AB.roofAt(P, hc1[0], hc1[1]), carpark: AB.roofAt(P, cpm[0], cpm[1]), stand: AB.roofAt(P, L.stands[0].x, L.stands[0].z), none: AB.roofAt(null, 0, 0),
               ys: P.ys, Ly: P.Ly, gate: P.gate};

  /* ---------- the civic terminal on its real site: its nave is plan(L)'s ---------- */
  var Wd = HQV.world.pack(JSON.parse(zlib.gunzipSync(fs.readFileSync(root + "/tests/fixtures/claude-hq@2.json.gz"))));
  var site = Wd.sites.filter(function(s){ return s.kind === "airport"; })[0];
  var CB = HQV.hqCivic.build(c, site, {tier: 5});
  out.civic = {nave: CB.nave, ramp0: W(AB.NAVE.ramp0, 0), ramp1: W(AB.NAVE.ramp1, 0), mez: W(AB.NAVE.mez1, 0), door: W(P.term.u0, 0)};

  /* ---------- build ---------- */
  var A = AB.create(c, L, {night: true}), D = HQV.hqMerge.drawCount;
  out.draws = {};
  [2, 1, 0].forEach(function(lv){ A.setDetail(lv); A.setNight(true); var n = D(A.g); A.setNight(false); out.draws[lv] = [n, D(A.g)]; });
  A.setDetail(2);
  out.bridgeDraws = 0; A.g.traverseVisible(function(o){ if(/^airbldg:bridge:/.test(o.name)) out.bridgeDraws++; });
  var tris = 0; A.g.traverse(function(o){ if(o.isMesh){ var g = o.geometry, n = (g.index ? g.index.count : g.attributes.position.count)/3; tris += o.isInstancedMesh ? n*o.count : n; } });
  out.tris = tris;
  // extended at the door: snapped, and eased frame-rate independently
  out.doors = {};
  P.bridges.forEach(function(b){ A.setBridge(b.stand, 1, true); out.doors[b.stand] = A.bridgeDoor(b.stand); });
  P.bridges.forEach(function(b){ A.setBridge(b.stand, 0, true); });
  var A2 = AB.create(c, L, {});
  A.setBridge("3", 1); A2.setBridge("3", 1);
  for(var i = 0; i < 120; i++) A.update(1/60, i/60);
  for(i = 0; i < 30; i++) A2.update(1/15, i/15);
  out.ease = [A.bridgeDoor("3").k, A2.bridgeDoor("3").k];
  for(i = 0; i < 1800; i++) A.update(1/60, 2 + i/60);
  out.eased = A.bridgeDoor("3");
  out.badBridge = [A.setBridge("21", 1), A.bridgeDoor("nope")];
  // everything static stays inside its footprint (frame rects/circles/capsules, 1.5 m slack); the tower's height
  A.g.updateMatrixWorld(true);
  var Z = P.zones, out1 = [], v = new THREE.Vector3(), tw = {top: -1e9, high: []};
  function inRect(r, u, w, s){ return u >= r.u0 - s && u <= r.u1 + s && w >= r.v0 - s && w <= r.v1 + s; }
  function segD(p, a, b){ var dx = b[0] - a[0], dz = b[1] - a[1], L2 = dx*dx + dz*dz, t = L2 ? Math.max(0, Math.min(1, ((p[0] - a[0])*dx + (p[1] - a[1])*dz)/L2)) : 0; return Math.hypot(p[0] - a[0] - dx*t, p[1] - a[1] - dz*t); }
  function inside(u, w){
    var s = 1.5, q = [u, w];
    return ["concourse", "fire", "fuel", "hangars", "depot", "carpark"].some(function(k){ return Z[k] && inRect(Z[k], u, w, s); }) ||
      ["skybridge", "footbridge"].some(function(k){ return Z[k] && segD(q, Z[k].a, Z[k].b) <= Z[k].r + s; }) ||
      ["tower", "asr"].some(function(k){ return Math.hypot(u - Z[k].c[0], w - Z[k].c[1]) <= Z[k].r; });
  }
  A.g.traverse(function(o){
    if(!o.isMesh || o.isInstancedMesh) return;
    var p = o.geometry.attributes.position;
    for(var j = 0; j < p.count; j++){
      v.fromBufferAttribute(p, j).applyMatrix4(o.matrixWorld); var q = F(v.x, v.z);
      if(!inside(q[0], q[1]) && out1.length < 8) out1.push([o.name, Math.round(q[0]*10)/10, Math.round(q[1]*10)/10, Math.round(v.y*10)/10]);
      if(Math.hypot(v.x - P.tower.x, v.z - P.tower.z) < 15){
        if(Math.hypot(v.x - P.tower.antenna[0], v.z - P.tower.antenna[1]) > 0.3) tw.top = Math.max(tw.top, v.y);
        else if(v.y > P.tower.top + 1 && tw.high.length < 1) tw.high.push(v.y);
        if(v.y > P.tower.top + 1 && Math.hypot(v.x - P.tower.antenna[0], v.z - P.tower.antenna[1]) > 0.3) tw.stray = true;
      }
    }
  });
  out.outside = out1; out.towerGeo = tw;
  // night: the lights; the radar turns; calm stops it
  A.setNight(true); A.update(0.016, 10.5);
  var pts = A.g.getObjectByName("airbldg:lights"); out.lights = {visible: pts.visible, n: pts.geometry.attributes.position.count};
  A.setNight(false); out.lights.day = pts.visible;
  // the departures board: text only
  texts.length = 0; A.setBoard(["10:40 TL 204 Tokenline gate 3", ["10:44", "<b>x</b>"], null]); out.boardTexts = texts.slice();
  A.dispose(); A2.dispose();
  out.disposed = true;
  process.stdout.write(JSON.stringify(out));
}).catch(function(e){ console.error(e && e.stack || e); process.exit(1); });
"""


def seg_dist(p, a, b):
    dx, dz = b[0] - a[0], b[1] - a[1]
    l2 = dx * dx + dz * dz
    t = max(0.0, min(1.0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / l2)) if l2 else 0.0
    return math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dz * t)


def poly_dist(p, pts):
    return min(seg_dist(p, pts[i], pts[i + 1]) for i in range(len(pts) - 1))


def in_poly(P, x, z):
    ins = False
    j = len(P) - 1
    for i in range(len(P)):
        a, b = P[i], P[j]
        if (a[1] > z) != (b[1] > z) and x < (b[0] - a[0]) * (z - a[1]) / (b[1] - a[1]) + a[0]:
            ins = not ins
        j = i
    return ins


def rect_bounds(poly):
    xs = [p[0] for p in poly]
    zs = [p[1] for p in poly]
    return min(xs), max(xs), min(zs), max(zs)


@unittest.skipUnless(NODE, "node not installed")
class TestHqAirbldg(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        js = HARNESS % {"root": json.dumps(ROOT)}
        p = subprocess.run([NODE, "-e", js], capture_output=True, text=True, timeout=300)
        if p.returncode != 0:
            raise AssertionError("node harness failed:\n" + p.stderr)
        cls.r = json.loads(p.stdout)
        with open(FIXTURE, encoding="utf-8") as f:
            cls.L = json.load(f)
        cls.stands = {s["id"]: s for s in cls.L["stands"]}

    def door_of(self, s):
        fwd = (math.sin(s["yaw"]), math.cos(s["yaw"]))
        left = (math.cos(s["yaw"]), -math.sin(s["yaw"]))
        return (s["x"] + 14.6 * fwd[0] + 1.95 * left[0], self.L["y"] + 2.5, s["z"] + 14.6 * fwd[1] + 1.95 * left[1])

    def test_plan_basics(self):
        self.assertTrue(self.r["deterministic"])
        self.assertEqual(self.r["none"], [None, None, None, None, False, None])
        self.assertAlmostEqual(self.r["plan"]["gate"], self.L["ySite"] + 5.0, places=6)
        self.assertEqual(len(self.r["plan"]["bridges"]), 6)
        self.assertEqual(sorted(b["stand"] for b in self.r["plan"]["bridges"]), ["1", "2", "3", "4", "5", "6"])

    def test_extended_cab_door_at_the_l1_door(self):
        for b in self.r["poses"]:
            want = self.door_of(self.stands[b["stand"]])
            got = self.r["doors"][b["stand"]]
            self.assertLessEqual(math.hypot(got["x"] - want[0], got["z"] - want[2]), 0.6, b["stand"])
            self.assertLessEqual(abs(got["y"] - want[1]), 0.3, b["stand"])
            # the pure pose agrees with the drawn instance
            self.assertLess(math.dist(b["ext"]["door"], [got["x"], got["y"], got["z"]]), 1e-3, b["stand"])
            # ~17 m of tunnel, ~8 degrees down
            self.assertTrue(14 <= b["ext"]["len"] <= 19, b["ext"]["len"])
            self.assertTrue(0.10 <= b["ext"]["pitch"] <= 0.18, b["ext"]["pitch"])

    def test_bridges_ease_frame_rate_independently(self):
        a, b = self.r["ease"]
        self.assertGreater(a, 0.3)
        self.assertLess(a, 0.99)
        self.assertAlmostEqual(a, b, places=6)
        e = self.r["eased"]
        want = self.door_of(self.stands["3"])
        self.assertEqual(e["k"], 1)
        self.assertLessEqual(math.hypot(e["x"] - want[0], e["z"] - want[2]), 0.6)
        self.assertEqual(self.r["badBridge"], [False, None])

    def test_retracted_clear_of_stand_and_lead_in(self):
        for b in self.r["poses"]:
            s = self.stands[b["stand"]]
            x0, x1, z0, z1 = rect_bounds(s["box"])
            cab = b["ret"]["cab"]
            # cab footprint >= 2 m from the stand box (every stand's, not just its own)
            for t in self.L["stands"]:
                bx0, bx1, bz0, bz1 = rect_bounds(t["box"])
                for p in cab:
                    dx = max(bx0 - p[0], 0, p[0] - bx1)
                    dz = max(bz0 - p[1], 0, p[1] - bz1)
                    self.assertGreaterEqual(math.hypot(dx, dz), 2.0, (b["stand"], t["id"]))
            # and from the lead-in swept path: the aircraft (span, nose 19.05 m, tail 19 m) along every lead curve
            for key in s["lead"].values():
                pts = self.L["curves"][key]
                for i in range(len(pts)):
                    a = pts[max(0, i - 1)]
                    c = pts[min(len(pts) - 1, i + 1)]
                    h = (c[0] - a[0], c[1] - a[1])
                    hl = math.hypot(*h) or 1
                    h = (h[0] / hl, h[1] / hl)
                    for p in cab:
                        rel = (p[0] - pts[i][0], p[1] - pts[i][1])
                        along = rel[0] * h[0] + rel[1] * h[1]
                        side = abs(rel[0] * h[1] - rel[1] * h[0])
                        inside = -19 - 2 <= along <= 19.05 + 2 and side <= s["span"] / 2 + 2
                        self.assertFalse(inside, (b["stand"], key, i))

    def test_nothing_on_the_service_road(self):
        road = self.L["serviceRoad"]
        half = self.L["serviceRoadW"] / 2
        K = self.r["K"]
        for b in self.r["poses"]:
            self.assertGreaterEqual(poly_dist(b["rot"], road), half + K["COL_R"], b["stand"])
            self.assertLessEqual(K["COL_R"], 0.7)
            for st in ("ext", "ret"):
                self.assertGreaterEqual(poly_dist(b[st]["bogie"], road), half + K["BOGIE_R"], (b["stand"], st))
            # extended, the bogie stands inside its stand box
            x0, x1, z0, z1 = rect_bounds(self.stands[b["stand"]]["box"])
            bx, bz = b["ext"]["bogie"]
            r = K["BOGIE_R"]
            self.assertTrue(x0 + r <= bx <= x1 - r and z0 + r <= bz <= z1 - r, b["stand"])
        # no block (piers, masts, buildings) on the road
        F = self.r["plan"]
        for blk in F["blocks"]:
            if "c" in blk:
                w = self.to_world(*blk["c"])
                self.assertGreaterEqual(poly_dist(w, road), half + blk["r"], blk)

    def to_world(self, u, v):
        f = self.L["frame"]
        B = f["B"]
        T = (B[1], -B[0])
        return (f["o"][0] + u * B[0] + v * T[0], f["o"][1] + u * B[1] + v * T[1])

    def test_floor_continuity_door_to_every_gate(self):
        for sid, w in self.r["walks"].items():
            self.assertLessEqual(w["maxStep"], 0.5, sid)
            self.assertEqual(w["blocked"], [], sid)
            self.assertAlmostEqual(w["end"], self.r["plan"]["gate"], places=6, msg=sid)
        self.assertEqual(sorted(self.r["walks"]), sorted(self.stands))

    def test_skybridge_is_not_the_road(self):
        rd = self.r["road"]
        self.assertIsNone(rd["floor"])
        self.assertAlmostEqual(rd["floorUp"], self.r["plan"]["gate"], places=6)
        self.assertFalse(rd["blocked"])
        self.assertTrue(rd["pierBlocked"])
        # the ramp starts at the ground: no yRef condition
        a, b = self.r["rampNoCond"]
        self.assertAlmostEqual(a, b, places=6)
        self.assertAlmostEqual(a, 0.12 + (5.0 - 0.12) * 30 / 56, places=6)
        self.assertEqual(self.r["concBlock"], [True, False])

    def test_gate_spots(self):
        self.assertEqual(sorted(g["id"] for g in self.r["gateSpots"]), sorted(self.stands))
        for g in self.r["gateSpots"]:
            self.assertIsNotNone(g["s"], g["id"])
            self.assertAlmostEqual(g["floor"], g["s"]["y"], places=6, msg=g["id"])
            self.assertFalse(g["blocked"], g["id"])
            if self.stands[g["id"]]["kind"] == "contact":
                # facing its stand
                s = self.stands[g["id"]]
                d = (s["x"] - g["s"]["x"], s["z"] - g["s"]["z"])
                self.assertLess(abs(math.atan2(math.sin(math.atan2(*d) - g["s"]["yaw"]), math.cos(math.atan2(*d) - g["s"]["yaw"]))), 0.6, g["id"])
        com = [g for g in self.r["gateSpots"] if self.stands[g["id"]]["kind"] == "commuter"]
        u, v = self.r_frame(com[0]["s"]["x"], com[0]["s"]["z"])
        self.assertAlmostEqual(v, -142, places=6)              # the south end (v0 -150), clear of its end wall

    def r_frame(self, x, z):
        f = self.L["frame"]
        B = f["B"]
        T = (B[1], -B[0])
        dx, dz = x - f["o"][0], z - f["o"][1]
        return dx * B[0] + dz * B[1], dx * T[0] + dz * T[1]

    def test_civic_nave_matches_the_plan(self):
        self.assertEqual(self.r["NAVE"], self.r["civicNave"])
        nave = [f for f in self.r["plan"]["floors"] if f["id"] == "nave"][0]
        N = self.r["NAVE"]
        self.assertEqual((nave["v0"], nave["v1"]), (-N["halfW"], N["halfW"]))
        self.assertEqual((nave["ramp"]["u0"], nave["ramp"]["u1"]), (N["ramp0"], N["ramp1"]))
        self.assertAlmostEqual(nave["ramp"]["y0"], self.L["ySite"] + N["y0"], places=6)
        self.assertAlmostEqual(nave["ramp"]["y1"], self.L["ySite"] + N["y1"], places=6)
        cv = self.r["civic"]
        for k, want in (("a", "ramp0"), ("b", "ramp1"), ("mez", "mez"), ("door", "door")):
            self.assertLess(math.dist(cv["nave"][k], cv[want]), 0.01, k)
        self.assertAlmostEqual(cv["nave"]["halfW"], N["halfW"], places=6)
        self.assertAlmostEqual(cv["nave"]["y0"], nave["ramp"]["y0"], places=6)
        self.assertAlmostEqual(cv["nave"]["y1"], nave["ramp"]["y1"], places=6)
        # the skybridge floor starts where the mezzanine ends, at the same height
        sky = [f for f in self.r["plan"]["floors"] if f["id"] == "skybridge"][0]
        self.assertEqual(sky["u0"], N["mez1"])
        self.assertAlmostEqual(sky["y"], nave["ramp"]["y1"], places=6)

    def test_everything_inside_its_footprint(self):
        self.assertEqual(self.r["outside"], [])
        P = self.r["plan"]
        Z = P["zones"]
        for blk in P["blocks"]:
            z = Z.get(blk["zone"])
            if blk["zone"] == "terminal" or z is None:
                continue
            if "u0" in z:
                if "c" in blk:
                    self.assertTrue(z["u0"] <= blk["c"][0] - blk["r"] and blk["c"][0] + blk["r"] <= z["u1"], blk)
                else:
                    self.assertTrue(z["u0"] - 1e-6 <= blk["u0"] and blk["u1"] <= z["u1"] + 1e-6 and z["v0"] - 1e-6 <= blk["v0"] and blk["v1"] <= z["v1"] + 1e-6, blk)
        # the hangar plane fits its open hangar, nose to the doors
        hs = P["hangarStand"]
        u, v = self.r_frame(hs["x"], hs["z"])
        H = [h for h in P["hangars"] if h["open"]][0]
        self.assertTrue(H["u0"] < u - 19 and u + 19.05 < H["u1"] and H["v0"] < v - 18 and v + 18 < H["v1"])
        self.assertAlmostEqual(hs["y"], self.L["y"], places=6)

    def test_roofs_for_the_helicopter(self):
        r = self.r["roofs"]
        self.assertAlmostEqual(r["tower"], r["ys"] + 66, places=3)
        self.assertGreaterEqual(r["conc"], r["gate"] + 7)
        self.assertGreater(r["sky"], r["gate"] + 4)
        self.assertAlmostEqual(r["hangar0"], r["Ly"] + 22, places=3)
        self.assertAlmostEqual(r["hangar1"], r["Ly"] + 22, places=3)
        self.assertGreater(r["carpark"], r["ys"] + 12)
        self.assertIsNone(r["stand"])
        self.assertIsNone(r["none"])

    def test_tower(self):
        t = self.r["plan"]["tower"]
        self.assertAlmostEqual(t["h"], self.L["landside"]["tower"]["h"])
        tg = self.r["towerGeo"]
        self.assertAlmostEqual(tg["top"], self.L["ySite"] + 66, delta=1)
        self.assertFalse(tg.get("stray"))
        self.assertTrue(tg["high"] and max(tg["high"]) <= t["antennaTop"] + 0.01)
        self.assertAlmostEqual(self.r["plan"]["asr"]["rate"], 1.26)

    def test_draw_calls(self):
        d = {int(k): v for k, v in self.r["draws"].items()}
        self.assertLessEqual(max(d[2]), 28, d)
        self.assertLessEqual(self.r["bridgeDraws"], 5)
        self.assertEqual(self.r["bridgeDraws"], 5)
        self.assertLessEqual(max(d[1]), 7, d)
        self.assertLessEqual(max(d[0]), 1, d)
        self.assertEqual(d[0][1], 0)
        for lv in (2, 1, 0):
            self.assertGreaterEqual(d[lv][0], d[lv][1])
        self.assertLessEqual(self.r["tris"], 140000)

    def test_night_lights_and_board(self):
        self.assertTrue(self.r["lights"]["visible"])
        self.assertFalse(self.r["lights"]["day"])
        self.assertGreater(self.r["lights"]["n"], 20)
        t = self.r["boardTexts"]
        self.assertIn("DEPARTURES", t)
        self.assertIn("10:40 TL 204 Tokenline gate 3", t)
        self.assertIn("10:44  <b>x</b>", t)     # canvas text, never markup
        self.assertTrue(self.r["disposed"])


class TestHqAirbldgSource(unittest.TestCase):
    def setUp(self):
        with open(SRC, encoding="utf-8") as f:
            self.src = f.read()

    def test_house_rules(self):
        self.assertNotIn("Math.random", self.src)
        self.assertNotIn("innerHTML", self.src)
        self.assertIsNone(re.search(r"Math\.min\(\s*1\s*,\s*dt", self.src))
        self.assertIn("HQV.hqAirbldg", self.src)
        self.assertIn("Math.exp(-RATE*dt)", self.src)


if __name__ == "__main__":
    unittest.main()
