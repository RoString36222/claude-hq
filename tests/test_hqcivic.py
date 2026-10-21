"""Civic and zone buildings for the Cities (games/hqcivic.js, HQV.hqCivic).

node imports the vendored three.js, loads games/hqmerge.js and games/hqcivic.js against a stub
`window` and a stub hq3d ctx (real THREE objects, no DOM), builds every site kind at every tier
from polygon and w/d sites, and reports draw calls, doors, hits, night state, footprints and
digests; the Python side checks them (cities build spec, task cl-civic). One node process for the
whole file. Skipped when node is not installed. Stdlib only."""
import json
import math
import os
import re
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "games", "hqcivic.js")
NODE = shutil.which("node")

KINDS = ["townhall", "clinic", "hospital", "fire", "police", "school", "university", "market", "mall", "bank",
         "library", "post", "transit", "busstop", "tramstop", "port", "dock", "airport", "power", "water",
         "stadium", "office", "campus", "studio", "finance", "biotech", "media", "warehouse", "farm"]

HARNESS = r"""
var fs = require("fs"), url = require("url"), crypto = require("crypto"), root = %(root)s, KINDS = %(kinds)s;
import(url.pathToFileURL(root + "/games/vendor/three-module.js").href).then(function(THREE){
  global.window = {HQV: {}};
  ["hqmerge", "hqcivic", "ocean"].forEach(function(f){ new Function(fs.readFileSync(root + "/games/" + f + ".js", "utf8"))(); });
  var HQV = window.HQV, C = HQV.hqCivic, out = {};

  /* ---------- a stub hq3d ctx (as tests/test_hqcity3d.py), labels and glows as sprites ---------- */
  function hashStr(s){ var h = 2166136261 >>> 0; s = String(s); for(var i = 0; i < s.length; i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h >>> 0; }
  function rng(seed){ var a = seed >>> 0 || 1; return function(){ a = (a + 0x6D2B79F5) >>> 0; var t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0)/4294967296; }; }
  function mat(c, o){ return new THREE.MeshStandardMaterial(Object.assign({color: c, roughness: 0.7, metalness: 0.08}, o || {})); }
  function emis(c, e, ei, o){ var m = mat(c, o); m.emissive = new THREE.Color(e); m.emissiveIntensity = ei; return m; }
  function add(o, x, y, z, p, ns){ o.position.set(x, y, z); if(!ns){ o.castShadow = true; o.receiveShadow = true; } p.add(o); return o; }
  var texts = [];
  var noop2d = new Proxy({}, {get(t, k){ return k === "measureText" ? function(){ return {width: 10}; } : k === "fillText" ? function(s){ texts.push(String(s)); }
    : (k === "createLinearGradient" || k === "createRadialGradient") ? function(){ return {addColorStop(){}}; } : function(){}; }, set(){ return true; }});
  var c = {THREE: THREE, PI: Math.PI, COL: {amber: 0xffb347, cyan: 0x5fd3e6, green: 0x6fd38a}, HEX: {green: "#6fd38a", amber: "#ffb347", cyan: "#5fd3e6"},
    E: {calm(){ return false; }}, rng: rng, hashStr: hashStr, mat: mat, emis: emis, add: add,
    box(w, h, d, m, x, y, z, p, ns){ return add(new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m), x, y, z, p, ns); },
    cyl(rt, rb, h, m, x, y, z, p, seg){ return add(new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg || 20), m), x, y, z, p); },
    sph(r, m, x, y, z, p){ return add(new THREE.Mesh(new THREE.SphereGeometry(r, 14, 10), m), x, y, z, p); },
    canvasTex(w, h, draw){ if(draw) draw(noop2d, w, h); return {c: null, g: noop2d, t: new THREE.Texture()}; },
    glow(col, s, o){ return new THREE.Sprite(new THREE.SpriteMaterial({color: col, opacity: o, transparent: true})); },
    label(t){ var s = new THREE.Sprite(new THREE.SpriteMaterial({transparent: true})); s.name = "label:" + t; return s; },
    short(s, n){ s = String(s || ""); return s.length > n ? s.slice(0, n) : s; },
    api: {viewTitle(v){ return v === "store" ? ["Store", "buy things"] : null; }}};

  /* ---------- sites ---------- */
  var Q = 65536;
  function rectPoly(cx, cz, w, d, a){   // cm, CCW, turned by a
    var ca = Math.cos(a), sa = Math.sin(a);
    return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(function(s){ var x = s[0]*w/2, z = s[1]*d/2; return [Math.round(cx + x*ca - z*sa), Math.round(cz + x*sa + z*ca)]; });
  }
  function siteFor(kind, tier, n, poly){
    var K = C.KINDS[kind], w = K.size[0]*100, d = K.size[1]*100, a = [0, 0.5, -1.1, Math.PI][n %% 4];
    var f = [Math.round(-Math.sin(a)*Q), Math.round(Math.cos(a)*Q)], cx = 120000 + n*5000, cz = -80000 + n*3000;
    var s = {id: kind + ":" + n, kind: kind, tier: tier, y: 250, front: f};
    if(poly) s.poly = rectPoly(cx, cz, w, d, a); else { s.x = cx; s.z = cz; s.w = w; s.d = d; s.front = [0, n %% 2 ? -Q : Q]; }
    return s;
  }
  function finite(g){ var ok = true; g.traverse(function(o){ var P = o.geometry && o.geometry.attributes && o.geometry.attributes.position;
    if(P) for(var i = 0; i < P.array.length; i++) if(!isFinite(P.array[i])){ ok = false; break; } }); return ok; }
  function digest(B){
    var h = crypto.createHash("sha1"); B.g.updateMatrixWorld(true);
    B.g.traverse(function(o){
      h.update(o.type + "|" + o.name + "|" + o.matrixWorld.elements.map(function(v){ return v.toFixed(5); }).join(","));
      var P = o.geometry && o.geometry.attributes.position; if(P) h.update(Buffer.from(P.array.buffer, P.array.byteOffset, P.array.byteLength));
      var m = o.material; if(m && m.color) h.update(m.color.getHexString() + (m.emissive ? m.emissive.getHexString() + m.emissiveIntensity : ""));
    });
    h.update(JSON.stringify(B.doors.map(function(d){ return [d.x, d.z, d.kind, d.view || null, d.live]; })));
    return h.digest("hex");
  }
  function inside(P, x, z){ var ins = false; for(var i = 0, j = P.length - 1; i < P.length; j = i++){ var a = P[i], b = P[j];
    if((a[1] > z) !== (b[1] > z) && x < (b[0] - a[0])*(z - a[1])/(b[1] - a[1]) + a[0]) ins = !ins; } return ins; }

  /* ---------- every kind, every tier, polygon and w/d sites ---------- */
  var rows = [], errors = [];
  KINDS.forEach(function(kind){ for(var tier = 1; tier <= 5; tier++) for(var n = 0; n < 4; n++){
    var site = siteFor(kind, tier, n, n < 2), r = {kind: kind, tier: tier, n: n, poly: n < 2};
    try {
      var B = C.build(c, site);
      r.digest = digest(B);
      if(tier === 3 && n === 0) r.digest2 = digest(C.build(c, site));
      B.setNight(true); r.drawsNight = HQV.hqMerge.drawCount(B.g);
      B.setNight(false); r.drawsDay = HQV.hqMerge.drawCount(B.g);
      B.animate(1.3, 0.016, 1); B.animate(1.3, 0.016, 0);
      r.finite = finite(B.g);
      r.doors = B.doors.map(function(d){ return {x: d.x, z: d.z, y: d.y, kind: d.kind, view: d.view || null, live: d.live,
        fx: d.front.x, fz: d.front.z, tip: d.tip}; });
      r.hits = B.hits.length; r.hitDoors = B.hits.every(function(o){ return o.userData.door && o.userData.door.live; });
      r.top = B.top; r.merged = 0; B.g.traverse(function(o){ if(o.userData.merged) r.merged++; });
      // every door's front point is clear of the building's masses (axis-aligned sites: exact boxes)
      r.doorBlocked = site.poly ? [] : B.doors.filter(function(d){ return B.boxes.some(function(bx){
        return d.x > bx.min.x && d.x < bx.max.x && d.z > bx.min.z && d.z < bx.max.z && d.y < bx.max.y && d.y + 1.5 > bx.min.y; }); }).map(function(d){ return d.kind; });
      // the front door faces the site's front: its front point is further along front than the wall it is in
      var f = [site.front[0]/Q, site.front[1]/Q];
      r.facing = B.doors.every(function(d){ return d.kind !== kind || ((d.x - B.x)*f[0] + (d.z - B.z)*f[1]) > -B.d/2; });
      r.y = B.y; r.g = [B.g.position.x, B.g.position.y, B.g.position.z];
      // masses within the site (m, 1.5 m slack): the polygon for poly sites
      var P = site.poly ? site.poly.map(function(p){ return [p[0]/100, p[1]/100]; }) : null, outside = 0;
      if(P) B.boxes.forEach(function(bx){ var cx = (bx.min.x + bx.max.x)/2, cz = (bx.min.z + bx.max.z)/2; if(!inside(P, cx, cz)) outside++; });
      r.boxesOutside = outside; r.boxes = B.boxes.length;
      // the far-off boxes: finite, upright, and only from this building's own masses (and pier)
      r.lod = B.lod.length; r.lodOk = B.lod.every(function(b){ return [b.x, b.z, b.w, b.d, b.rot, b.y0, b.y1].every(isFinite) && b.w > 0 && b.d > 0 && b.y1 > b.y0; });
      r.tint = typeof B.tint === "number";
    } catch(e){ errors.push(kind + "@" + tier + ":" + n + " " + (e && e.stack || e)); }
    rows.push(r);
  } });
  out.rows = rows; out.errors = errors;

  /* ---------- views, the town hall, night ---------- */
  var store = C.build(c, {id: "v:store", kind: "market", tier: 2, x: 0, z: 0, y: 0, front: [0, Q], view: "store"});
  out.store = {doors: store.doors.map(function(d){ return [d.kind, d.view || null, d.live, d.tip]; }), hits: store.hits.length,
    hitView: store.hits.map(function(o){ return o.userData.door && o.userData.door.view; }),
    label: store.g.children.filter(function(o){ return /^label:/.test(o.name); }).map(function(o){ return o.name; })};
  var th = C.build(c, {id: "th", kind: "townhall", tier: 1, x: 0, z: 0, front: [0, Q]});
  out.townhall = {doors: th.doors.map(function(d){ return [d.kind, d.view || null, d.live]; }), hits: th.hits.length};
  var cl = C.build(c, {id: "cl", kind: "clinic", tier: 1, x: 0, z: 0, front: [0, Q]});
  out.clinic = {live: cl.doors.filter(function(d){ return d.live; }).length, hits: cl.hits.length, doors: cl.doors.length};
  var off = C.build(c, {id: "o", kind: "transit", tier: 5, x: 0, z: 0, front: [0, Q]}, {night: false});
  function nightState(B){ var walls = [], glows = B.glows.map(function(g){ return g.visible; });
    B.g.traverse(function(o){ if(/^civic:walls:/.test(o.name)) walls.push(o.material.emissiveIntensity); }); return {walls: walls, glows: glows}; }
  out.night = {day: nightState(off)}; off.setNight(true); out.night.night = nightState(off);
  var pol = C.build(c, {id: "p", kind: "police", tier: 3, x: 0, z: 0, front: [0, Q]});
  var lamps = []; pol.g.traverse(function(o){ if(o.material && o.material.emissive && o.material.emissive.getHex() >= 0x3f7b00 && o.material.emissive.getHex() <= 0x3f7cff) lamps.push(o.material); });
  var uniq = lamps.filter(function(m, i){ return lamps.indexOf(m) === i; });
  pol.animate(0.1, 0.016, 1); var a1 = uniq.map(function(m){ return m.emissiveIntensity; });
  pol.animate(0.45, 0.016, 1); var a2 = uniq.map(function(m){ return m.emissiveIntensity; });
  out.police = {mats: uniq.length, a1: a1, a2: a2};
  // an unknown kind builds as an office block; opts.tier overrides the site's tier
  var unk = C.build(c, {id: "u", kind: "nope", x: 0, z: 0});
  out.unknown = {kind: unk.kind, doors: unk.doors.length};
  out.tierOpt = [C.build(c, {id: "t", kind: "office", tier: 1, x: 0, z: 0}).top, C.build(c, {id: "t", kind: "office", tier: 1, x: 0, z: 0}, {tier: 5}).top];
  // variants: the same kind and tier from other ids
  out.variants = KINDS.map(function(kind){ var ds = {}; for(var i = 0; i < 6; i++) ds[digest(C.build(c, {id: "var" + i, kind: kind, tier: 3, x: 0, z: 0, front: [0, Q]}))] = 1; return Object.keys(ds).length; });
  // sign text: what the canvases were asked to draw
  texts.length = 0; C.build(c, {id: "n", kind: "library", tier: 2, x: 0, z: 0, name: "<b>Old Stacks</b>"}); out.texts = texts.slice();

  /* ---------- fit ---------- */
  var L = [[0, 0], [20, 0], [20, 8], [8, 8], [8, 20], [0, 20]], R = C.fit(L);
  var corners = [[R.cx - R.w/2, R.cz - R.d/2], [R.cx + R.w/2, R.cz - R.d/2], [R.cx + R.w/2, R.cz + R.d/2], [R.cx - R.w/2, R.cz + R.d/2]];
  out.fitL = {r: R, inside: corners.every(function(q){ return inside(L, q[0] + (q[0] > R.cx ? -1e-6 : 1e-6), q[1] + (q[1] > R.cz ? -1e-6 : 1e-6)); })};
  var sq = C.fit([[0, 0], [10, 0], [10, 6], [0, 6]]);
  out.fitSq = sq;
  var tri = [[0, 0], [30, 0], [0, 30]], RT = C.fit(tri);
  out.fitTri = {r: RT, inside: [[RT.cx - RT.w/2, RT.cz - RT.d/2], [RT.cx + RT.w/2, RT.cz - RT.d/2], [RT.cx + RT.w/2, RT.cz + RT.d/2], [RT.cx - RT.w/2, RT.cz + RT.d/2]]
    .every(function(q){ return q[0] + q[1] <= 30 + 1e-6 && q[0] >= -1e-6 && q[1] >= -1e-6; })};
  out.fitBad = C.fit(null);
  // a rotated polygon site: the frame's footprint matches the unrotated rectangle
  var fr = C.frame({kind: "office", poly: rectPoly(5000, 7000, 3000, 2000, 0.5), front: [Math.round(-Math.sin(0.5)*Q), Math.round(Math.cos(0.5)*Q)]});
  out.frame = {x: fr.x, z: fr.z, w: fr.w, d: fr.d, rot: fr.rot};
  /* ---------- piers: the deck you walk, and the berth off its head ---------- */
  out.piers = [];
  ["dock", "port"].forEach(function(kind){ for(var n = 0; n < 4; n++){
    var site = siteFor(kind, 3, n, n < 2), B = C.build(c, site), P = C.pierOf(site)[0];
    var doc = {layers: {sites: [site], island: {docks: [site.id], coast: [], sea_cm: -1500}}}, berth = HQV.ocean.docksOf(doc, function(){ return true; })[0];
    var main = B.doors.filter(function(d){ return d.kind === kind; })[0];
    // the deck's top, from its mesh: the highest wood box over the pier's middle
    var mid = [(P.poly[0][0] + P.poly[2][0])/2, (P.poly[0][1] + P.poly[2][1])/2];
    out.piers.push({kind: kind, n: n, decks: B.decks.length, y: P.y, siteY: site.y/100, w: P.w,
      onDeck: [C.deckAt(B.decks, mid[0], mid[1]), C.deckAt(B.decks, main.x, main.z), C.deckAt(B.decks, P.head[0] - P.dir[0]*0.5, P.head[1] - P.dir[1]*0.5)],
      berthOff: C.deckAt(B.decks, berth.x, berth.z), berthAhead: (berth.x - P.head[0])*P.dir[0] + (berth.z - P.head[1])*P.dir[1],
      berthSide: Math.abs((berth.x - P.head[0])*P.dir[1] - (berth.z - P.head[1])*P.dir[0]),
      berthYaw: Math.abs(Math.atan2(Math.sin(berth.yaw - Math.atan2(P.dir[0], P.dir[1])), Math.cos(berth.yaw - Math.atan2(P.dir[0], P.dir[1])))),
      // the pier points the way the site faces (out to sea)
      dirDot: P.dir[0]*site.front[0]/Q + P.dir[1]*site.front[1]/Q});
  } });
  out.noPier = [C.pierOf({kind: "office", x: 0, z: 0}).length, C.pierOf(null).length, C.deckAt([], 0, 0)];

  /* ---------- the Commons airport on its real site (airport spec, sections 5 and 11) ---------- */
  new Function(fs.readFileSync(root + "/games/world.js", "utf8"))();
  var Wd = HQV.world.pack(JSON.parse(require("zlib").gunzipSync(fs.readFileSync(root + "/tests/fixtures/claude-hq@2.json.gz"))));
  var asite = Wd.sites.filter(function(s){ return s.kind === "airport"; })[0];
  var AP = C.build(c, asite, {tier: 5}), SP = asite.poly.map(function(p){ return [p[0]/100, p[1]/100]; });
  function segD(p, a, b){ var dx = b[0] - a[0], dz = b[1] - a[1], L2 = dx*dx + dz*dz, t = L2 ? Math.max(0, Math.min(1, ((p[0] - a[0])*dx + (p[1] - a[1])*dz)/L2)) : 0; return Math.hypot(p[0] - a[0] - dx*t, p[1] - a[1] - dz*t); }
  function onSite(x, z){ if(inside(SP, x, z)) return true; for(var i = 0; i < SP.length; i++) if(segD([x, z], SP[i], SP[(i + 1) %% SP.length]) < 0.05) return true; return false; }
  AP.g.updateMatrixWorld(true);
  var apOut = [], maxY = -1e9, v3 = new THREE.Vector3();
  AP.g.traverse(function(o){
    if(!o.isMesh) return;
    var P = o.geometry.attributes.position;
    for(var i = 0; i < P.count; i++){ v3.fromBufferAttribute(P, i).applyMatrix4(o.matrixWorld); maxY = Math.max(maxY, v3.y);
      if(!onSite(v3.x, v3.z) && apOut.length < 6) apOut.push([o.name, v3.x, v3.y, v3.z]); }
  });
  var g0 = AP.g.position, fr = [asite.front[0]/Q, asite.front[1]/Q], Bv = [-fr[0], -fr[1]], Tv = [Bv[1], -Bv[0]];
  function siteW(u, v){ return [g0.x + u*Bv[0] + v*Tv[0], g0.z + u*Bv[1] + v*Tv[1]]; }
  // the City's civicBlocked (hqcity3d.js): a mass with its underside above 2.4 m does not block
  function blockedCivic(x, z){ return AP.boxes.some(function(b){ var o = b.o; if(!o || o.y0 > 2.4) return false;
    var dx = x - o.x, dz = z - o.z, cr = Math.cos(o.rot), sr = Math.sin(o.rot); return Math.abs(dx*cr - dz*sr) <= o.hw && Math.abs(dx*sr + dz*cr) <= o.hd; }); }
  var naveHit = [], massHit = 0;
  for(var u = -67.2; u <= 66; u += 0.5) [-1.5, 0, 1.5].forEach(function(v){ var w = siteW(u, v); if(blockedCivic(w[0], w[1]) && naveHit.length < 5) naveHit.push([u, v]); });
  [-12, 12].forEach(function(v){ var w = siteW(0, v); if(blockedCivic(w[0], w[1])) massHit++; });
  var isl = 0; [-3.25, 3.25].forEach(function(v){ var w = siteW(-46, v); if(blockedCivic(w[0], w[1])) isl++; });
  texts.length = 0; AP.setBoard(["09:10 HQ-ABC to Isle", ["09:30", "<i>y</i>"]]);
  var apDay = C.build(c, asite, {tier: 5, night: false});
  out.airport = {size: C.KINDS.airport.size, outside: apOut, top: AP.top, y: AP.y, maxY: maxY, naveHit: naveHit, massHit: massHit, islands: isl,
    roofNote: AP.boxes.map(function(b){ return b.max.y - AP.y; }).reduce(function(a, b){ return Math.max(a, b); }, 0),
    draws: [HQV.hqMerge.drawCount(AP.g), HQV.hqMerge.drawCount(apDay.g)], nave: AP.nave, doors: AP.doors.map(function(d){ return [d.kind, d.x, d.z]; }),
    board: texts.slice(), center: [g0.x, g0.z], boxesOutside: AP.boxes.filter(function(b){ return !onSite(b.o.x, b.o.z); }).length};
  process.stdout.write(JSON.stringify(out));
}).catch(function(e){ console.error(e && e.stack || e); process.exit(1); });
"""


@unittest.skipUnless(NODE, "node not installed")
class TestHqCivic(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        js = HARNESS % {"root": json.dumps(ROOT), "kinds": json.dumps(KINDS)}
        p = subprocess.run([NODE, "-e", js], capture_output=True, text=True, timeout=300)
        if p.returncode != 0:
            raise AssertionError("node harness failed:\n" + p.stderr)
        cls.r = json.loads(p.stdout)

    def test_every_kind_builds_at_every_tier(self):
        self.assertEqual(self.r["errors"], [])
        self.assertEqual(len(self.r["rows"]), len(KINDS)*5*4)
        for row in self.r["rows"]:
            self.assertTrue(row["finite"], row["kind"])
            self.assertGreater(row["top"], 1.5, row["kind"])

    def test_far_boxes(self):
        for row in self.r["rows"]:
            self.assertTrue(row["lodOk"], row["kind"])
            self.assertTrue(row["tint"], row["kind"])
            if row["kind"] not in ("busstop", "tramstop"):
                self.assertGreater(row["lod"], 0, row["kind"] + ": nothing to draw far off")

    def test_piers(self):
        self.assertEqual(len(self.r["piers"]), 8)
        for p in self.r["piers"]:
            tag = "%s:%d" % (p["kind"], p["n"])
            self.assertEqual(p["decks"], 1, tag)
            self.assertAlmostEqual(p["y"], p["siteY"] + 0.72, 6, msg=tag)
            # you stand on the deck at its middle, at its main door (the boats' and ferries') and at its head
            for y in p["onDeck"]:
                self.assertAlmostEqual(y, p["y"], 6, msg=tag)
            # the berth is open water just off the head, straight out, facing out
            self.assertIsNone(p["berthOff"], tag)
            self.assertAlmostEqual(p["berthAhead"], 2.4, 6, msg=tag)
            self.assertLess(p["berthSide"], 1e-6, tag)
            self.assertLess(p["berthYaw"], 1e-6, tag)
            self.assertGreater(p["dirDot"], 0.999, tag)
        self.assertEqual(self.r["noPier"], [0, 0, None])

    def test_under_40_draw_calls(self):
        worst = {}
        for row in self.r["rows"]:
            k = row["kind"]
            worst[k] = max(worst.get(k, 0), row["drawsNight"], row["drawsDay"])
            self.assertGreaterEqual(row["drawsNight"], row["drawsDay"])
        over = {k: v for k, v in worst.items() if v >= 40}
        self.assertEqual(over, {}, worst)
        # and the merge did something: every kind has merged meshes (at least at its top tier)
        for k in KINDS:
            self.assertGreater(max(row["merged"] for row in self.r["rows"] if row["kind"] == k and row["tier"] == 5), 0, k)

    def test_deterministic(self):
        for row in self.r["rows"]:
            if "digest2" in row:
                self.assertEqual(row["digest"], row["digest2"], row["kind"])
        # identical sites in the sweep give identical digests; ids give variants
        for k, n in zip(KINDS, self.r["variants"]):
            self.assertGreaterEqual(n, 2, k)

    def test_tiers_grow(self):
        tops = {}
        for row in self.r["rows"]:
            if row["n"] == 0:
                tops.setdefault(row["kind"], {})[row["tier"]] = row["top"]
        for k, t in tops.items():
            self.assertGreaterEqual(t[5], t[1], k)
        for k in ["office", "finance", "hospital", "media", "power", "stadium", "townhall"]:
            self.assertGreater(tops[k][5], tops[k][1] + 2, k)
        a, b = self.r["tierOpt"]
        self.assertGreater(b, a)

    def test_doors_present_and_facing_front(self):
        for row in self.r["rows"]:
            self.assertGreaterEqual(len(row["doors"]), 1, row["kind"])
            for d in row["doors"]:
                for v in ("x", "z", "y", "fx", "fz"):
                    self.assertTrue(isinstance(d[v], (int, float)), (row["kind"], v))
                self.assertAlmostEqual(d["x"], d["fx"], places=6)
                self.assertAlmostEqual(d["y"], row["y"] + 0.12, places=6)
            # you can stand at every door, and the doors are within the footprint's depth
            self.assertEqual(row["doorBlocked"], [], (row["kind"], row["tier"], row["n"]))
            self.assertTrue(row["facing"], (row["kind"], row["n"]))
            self.assertAlmostEqual(row["y"], 2.5, places=6)
        # without a view only the town hall has a live door, kind "townhall"
        for row in self.r["rows"]:
            live = [d for d in row["doors"] if d["live"]]
            if row["kind"] == "townhall":
                self.assertEqual([d["kind"] for d in live], ["townhall"])
                self.assertGreaterEqual(row["hits"], 2)
                self.assertTrue(row["hitDoors"])
            else:
                self.assertEqual(live, [], row["kind"])
                self.assertEqual(row["hits"], 0, row["kind"])

    def test_view_door(self):
        s = self.r["store"]
        live = [d for d in s["doors"] if d[2]]
        self.assertEqual(len(live), 1)
        self.assertEqual(live[0][1], "store")
        self.assertEqual(live[0][3], "Store: buy things")
        self.assertGreaterEqual(s["hits"], 1)
        self.assertTrue(all(v == "store" for v in s["hitView"]))
        self.assertEqual(s["label"], ["label:Store"])
        t = self.r["townhall"]
        self.assertIn(["townhall", None, True], t["doors"])
        c = self.r["clinic"]
        self.assertEqual((c["live"], c["hits"]), (0, 0))
        self.assertGreaterEqual(c["doors"], 1)

    def test_masses_stand_on_the_site(self):
        for row in self.r["rows"]:
            if row["poly"] and row["kind"] not in ("port", "dock"):   # cranes and piers reach out over the water
                self.assertEqual(row["boxesOutside"], 0, (row["kind"], row["tier"], row["n"]))
            self.assertGreater(row["boxes"], 0, row["kind"])

    def test_night(self):
        n = self.r["night"]
        self.assertTrue(n["day"]["walls"] and all(v == 0 for v in n["day"]["walls"]))
        self.assertTrue(all(v == 1 for v in n["night"]["walls"]))
        self.assertTrue(n["night"]["glows"] and all(n["night"]["glows"]))
        self.assertFalse(any(n["day"]["glows"]))

    def test_police_lamps_blink_in_turn(self):
        p = self.r["police"]
        self.assertEqual(p["mats"], 2)
        self.assertNotEqual(p["a1"], p["a2"])
        self.assertEqual(sorted(p["a1"]), sorted(p["a2"]))

    def test_unknown_kind_and_sign_text(self):
        self.assertEqual(self.r["unknown"], {"kind": "office", "doors": 1})
        # site names reach the sign as canvas text (never markup)
        self.assertIn("<B>OLD STACKS</B>", self.r["texts"])

    def test_airport_terminal_on_its_site(self):
        a = self.r["airport"]
        self.assertEqual(a["size"], [40, 160])                 # matches the backend's site
        self.assertEqual(a["outside"], [])                      # every vertex (canopy, roof, skirt) on the site polygon
        self.assertEqual(a["boxesOutside"], 0)
        self.assertEqual(a["center"], [-620, 0])
        # note() records the real tops: the wave roof at 14..16 m
        self.assertAlmostEqual(a["top"], a["maxY"] - a["y"], delta=0.02)
        self.assertAlmostEqual(a["roofNote"], a["top"], delta=1e-6)
        self.assertTrue(15.8 <= a["top"] <= 16.05, a["top"])
        self.assertTrue(a["draws"][0] < 40 and a["draws"][1] < 40, a["draws"])
        self.assertLessEqual(max(a["draws"]), 30, a["draws"])

    def test_airport_nave_walks_through(self):
        a = self.r["airport"]
        # the centre aisle from the door to u = 0 (and on up the ramp) has no blocking mass below 2.4 m ...
        self.assertEqual(a["naveHit"], [])
        # ... while the side masses and the check-in islands do block
        self.assertEqual(a["massHit"], 2)
        self.assertEqual(a["islands"], 2)
        n = a["nave"]
        self.assertAlmostEqual(n["y1"] - n["y0"], 5.0 - 0.12, places=6)
        self.assertLess(math.dist(n["door"], [-554, 0]), 0.01)
        self.assertLess(math.dist(n["a"], [-620, 0]), 0.01)
        self.assertLess(math.dist(n["b"], [-676, 0]), 0.01)
        self.assertLess(math.dist(n["mez"], [-686, 0]), 0.01)
        main = [d for d in a["doors"] if d[0] == "airport"]
        self.assertEqual(len(main), 1)
        self.assertAlmostEqual(main[0][1], -552.8, places=6)     # 1.2 m out of the front wall (u -66)
        self.assertIn("DEPARTURES", a["board"])
        self.assertIn("09:30  <i>y</i>", a["board"])

    def test_fit(self):
        f = self.r["fitL"]
        self.assertTrue(f["inside"])
        self.assertGreater(f["r"]["w"]*f["r"]["d"], 40)
        sq = self.r["fitSq"]
        self.assertAlmostEqual(sq["w"], 10, places=6)
        self.assertAlmostEqual(sq["d"], 6, places=6)
        t = self.r["fitTri"]
        self.assertTrue(t["inside"])
        self.assertGreater(t["r"]["w"]*t["r"]["d"], 100)
        self.assertEqual(self.r["fitBad"]["w"], 0)
        fr = self.r["frame"]
        self.assertAlmostEqual(fr["x"], 50, places=1)
        self.assertAlmostEqual(fr["z"], 70, places=1)
        self.assertAlmostEqual(fr["w"], 30, delta=0.1)
        self.assertAlmostEqual(fr["d"], 20, delta=0.1)
        self.assertAlmostEqual(fr["rot"], -0.5, places=3)


class TestHqCivicSource(unittest.TestCase):
    def setUp(self):
        with open(SRC, encoding="utf-8") as f:
            self.src = f.read()

    def test_house_rules(self):
        self.assertNotIn("Math.random", self.src)
        self.assertNotIn("innerHTML", self.src)
        self.assertIsNone(re.search(r"Math\.min\(\s*1\s*,\s*dt", self.src))
        self.assertIn("HQV.hqCivic", self.src)

    def test_every_kind_has_a_builder(self):
        for k in KINDS:
            self.assertRegex(self.src, r"BUILD\.%s = function" % k)
            self.assertRegex(self.src, r"\n  %s: \{name:" % k)


if __name__ == "__main__":
    unittest.main()
