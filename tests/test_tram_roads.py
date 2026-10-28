"""Trams on their own roads (City Gen v4 phase 9, HQ 3.32).

A tram street in an @3 doc is a tram version of its road class: an edge's `tram` says how the track is laid
("centre-bed": double track in a raised, kerbed bed down the middle, `bed` cm wide; "shared-double" / "shared-single":
the tram in the inner lane), and a station's tramstop site is a 40 x 3 m platform (w 4000, d 300) along the track.
node loads world.js, traffic.js, worldgeom.js, hqtramway.js and hqcivic.js against a stub `window` and checks, on the
regenerated tests/fixtures/claude-hq@3.json.gz (and island@3 where it has trams): world.pack / docOf keep `tram` and
`bed`; the bed is raised paving (surfaceAt / roadY), never carriageway; no car drives on a centre bed while the sim
runs; the trams' rails lie inside the bed and the trams ride on it; every station draws a 40 m island on its platform
(between the tracks on a bed) with a ticket machine and a departure board; the bed is drawn as a raised strip with
the tram marks at its kerbs; and the older docs (claude-hq@2, the synthetic hub city) are laid out as before.
Skipped without node. Stdlib only."""
import json
import os
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIX = os.path.join(ROOT, "tests", "fixtures")
NODE = shutil.which("node")

HARNESS = r"""
import fs from "fs";
import zlib from "zlib";
import { createRequire } from "module";
const root = %(root)s, FIX = root + "/tests/fixtures/", require = createRequire(root + "/tests/");
globalThis.window = {HQV: {}};
globalThis.self = globalThis.window;
for (const f of ["world", "traffic", "worldgeom", "hqtramway", "hqcivic"]) new Function(fs.readFileSync(root + "/games/" + f + ".js", "utf8"))();
const THREE = await import(root + "/games/vendor/three-module.js");
const H = window.HQV, T = H.traffic, TW = H.hqTramway, WD = H.world, G = H.worldgeom, C = H.hqCivic, out = {};
const ALL = {x: 0, z: 0}, FAR = 1e6;
function gz(p){ return JSON.parse(zlib.gunzipSync(fs.readFileSync(FIX + p)).toString("utf8")); }
function segD(px, pz, ax, az, bx, bz){
  const ux = bx - ax, uz = bz - az, l = ux*ux + uz*uz, t = l > 1e-12 ? Math.max(0, Math.min(1, ((px - ax)*ux + (pz - az)*uz)/l)) : 0;
  return [Math.hypot(px - ax - ux*t, pz - az - uz*t), t];
}
// distance from (x, z) to a packed edge's centre line (m), and whether the nearest point is alongside (not past an end)
function edgeD(e, x, z){
  const p = e.pts, n = p.length/3;
  let b = 1e9, along = false;
  for(let i = 0; i + 1 < n; i++){
    const r = segD(x, z, p[3*i]/100, p[3*i+2]/100, p[3*i+3]/100, p[3*i+5]/100);
    if(r[0] < b){ b = r[0]; along = !((i === 0 && r[1] <= 0) || (i === n - 2 && r[1] >= 1)); }
  }
  return [b, along];
}

/* ---------- the @3 Commons ---------- */
const doc = gz("claude-hq@3.json.gz"), W = WD.pack(doc), D = WD.docOf(W);
const raw = {};
doc.layers.roads.edges.forEach(function(e){ raw[e.id] = e; });
const tramRaw = doc.layers.roads.edges.filter(function(e){ return e.tram; });
out.fields = {
  raw: tramRaw.length, beds: tramRaw.filter(function(e){ return e.bed > 0; }).length,
  lays: Array.from(new Set(tramRaw.map(function(e){ return e.tram; }))).sort(),
  packed: W.edges.filter(function(e){ return raw[e.id].tram ? e.tram === raw[e.id].tram && (e.bed || 0) === (raw[e.id].bed || 0) : e.tram === undefined && e.bed === undefined; }).length,
  edges: W.edges.length,
  docOf: D.layers.roads.edges.filter(function(e){ return raw[e.id].tram ? e.tram === raw[e.id].tram && (e.bed || 0) === (raw[e.id].bed || 0) : !("tram" in e) && !("bed" in e); }).length,
  again: WD.pack(D).edges.filter(function(e, i){ return e.tram === W.edges[i].tram && e.bed === W.edges[i].bed; }).length,
  bedWithMedian: tramRaw.filter(function(e){ return e.bed > 0 && e.median > 0; }).length
};

// the bed is raised paving: the middle of every centre-bed edge's run (its junction trims kept clear) is "sidewalk",
// SIDEWALK_UP over the road beside it; the lanes beside the bed are road
const beds = W.edges.filter(function(e){ return e.tram === "centre-bed" && e.bed > 0; });
let bedPts = 0, bedUp = 0, laneRoad = 0, upErr = 0;
WD.surfaceAt(W, 0, 0);
const MID = W.index.mid;     // each edge's arc lengths and junction trims (the bed stops short of a junction box)
beds.forEach(function(e){
  const p = e.pts, n = p.length/3, M = MID[W.edges.indexOf(e)];
  for(let i = 0; i + 1 < n; i++){
    const sm = (M.cum[i] + M.cum[i + 1])/2;
    if(sm < M.t[0] + 0.5 || sm > M.len - M.t[1] - 0.5) continue;
    const ax = p[3*i]/100, az = p[3*i+2]/100, bx = p[3*i+3]/100, bz = p[3*i+5]/100, l = Math.hypot(bx - ax, bz - az);
    if(l < 0.5) continue;
    const mx = (ax + bx)/2, mz = (az + bz)/2, nx = -(bz - az)/l, nz = (bx - ax)/l, h = e.bed/200;
    // only well inside the street's own run: no other road's carriageway within reach (the same bed carrying on is)
    const lane = (e.width - 2*e.walk)/200 - 1.5, own = W.edges.every(function(f){ return f === e || (f.bed === e.bed && f.name === e.name) || edgeD(f, mx, mz)[0] > f.width/200 + 2; });
    if(!own) continue;
    [0, h - 0.4, -(h - 0.4)].forEach(function(o){
      const x = mx + nx*o, z = mz + nz*o;
      bedPts++;
      if(WD.surfaceAt(W, x, z) !== "sidewalk") return;
      bedUp++;
      const yb = WD.roadY(W, x, z), yr = WD.roadY(W, mx + nx*lane, mz + nz*lane);
      if(yb != null && yr != null) upErr = Math.max(upErr, Math.abs(yb - yr - 0.15));
    });
    [lane, -lane].forEach(function(o){ if(WD.surfaceAt(W, mx + nx*o, mz + nz*o) === "road") laneRoad++; });
  }
});
out.bed = {edges: beds.length, pts: bedPts, up: bedUp, laneRoad: laneRoad, upErr: upErr};

// the sim: per edge lay, offsets; cars outside the bed, the trams inside it
const sim = T.create(W, {tier: 5, seed: 7}), SE = sim._.edges, wid = T.SPEC.tram.wid, cw = T.SPEC.car.wid;
const lay = {};
SE.filter(function(e){ return e.tram; }).forEach(function(e){
  const k = e.tramLay || "none", L = lay[k] = lay[k] || {n: 0, offs: [], carIn: 0, bodyOut: 0};
  L.n++;
  if(L.offs.indexOf(+e.tramOff.toFixed(3)) < 0) L.offs.push(+e.tramOff.toFixed(3));
  if(e.bedH > 0){
    (e.carOffs || []).forEach(function(o){ if(Math.abs(o) - cw/2 < e.bedH) L.carIn++; });
    // inside the kerbs; on an avenue's 9.2 m bed a 3 m island between the two
    if(e.tramOff + wid/2 > e.bedH - 0.15 || e.tramOff - wid/2 < (e.bedH >= 4.6 ? 1.5 : 0.2)) L.bodyOut++;
  }
});
Object.keys(lay).forEach(function(k){ lay[k].offs.sort(); });
out.lay = lay;
const bedSE = {};
SE.forEach(function(e){ if(e.bedH > 0) bedSE[e.id] = e; });
let carSamples = 0, carOnBed = 0, tramSamples = 0, tramYErr = 0, tramOut = 0;
const byId = {};
W.edges.forEach(function(e){ byId[e.id] = e; });
for(let t = 0; t < 1800; t += 7){
  sim.at(t*1000, ALL, FAR).forEach(function(v){
    if(v.kind === "bus" || v.kind === "fire" || v.kind === "ambulance" || v.kind === "police") return;
    beds.forEach(function(e){
      const r = edgeD(e, v.x, v.z);
      if(!r[1] || r[0] > e.bed/200 + 0.5) return;
      if(v.kind === "tram"){
        if(r[0] > e.bed/200 - 0.15 || WD.surfaceAt(W, v.x, v.z) !== "sidewalk") return;
        tramSamples++;
        const y = WD.roadY(W, v.x, v.z);
        if(y != null) tramYErr = Math.max(tramYErr, Math.abs(v.y - y));
        return;
      }
      carSamples++;
      // a car's body never over the bed where the bed is drawn (raised, between its junction trims)
      if(r[0] < e.bed/200 + cw/2 - 0.05 && WD.surfaceAt(W, v.x, v.z) !== "road") carOnBed++;
    });
  });
}
out.drive = {carSamples: carSamples, carOnBed: carOnBed, tramSamples: tramSamples, tramYErr: tramYErr};

// hqtramway: the rails of every track on a centre bed lie inside it; one 40 m island per station platform
const Lay = TW.layout(W, 5, {sim}), lanesOut = T.lanes(W, 5, sim), lb = {};
lanesOut.forEach(function(o){ lb[o.i] = o; });
let railPts = 0, railOut = 0;
Lay.rails.forEach(function(r){
  const t = Lay.tracks.filter(function(x){ return x.key === r.key; })[0];
  if(!t || t.kind !== "lane") return;
  const E = lb[t.ei], e = byId[E.id];
  if(!(E.bed > 0)) return;
  // within the bed's kerbs (0.15 m), and off its middle where a centre island stands (1.5 m)
  r.P.slice(1, -1).forEach(function(q){ const d = edgeD(e, q[0], q[2]); if(!d[1]) return; railPts++; if(d[0] > E.bed - 0.15 || d[0] < (E.bed >= 4.6 ? 1.5 : 0.2)) railOut++; });
});
const sites = {};
W.sites.forEach(function(s){ sites[s.id] = s; });
const stations = W.sites.filter(function(s){ return s.kind === "tramstop" && s.w >= 4000; }), kerbStops = W.sites.filter(function(s){ return s.kind === "tramstop" && !(s.w >= 4000); });
const lanesTr = Lay.tracks.filter(function(t){ return t.kind === "lane"; });
function polyD(x, z, P){ let b = 1e9; for(let i = 1; i < P.length; i++) b = Math.min(b, segD(x, z, P[i-1][0], P[i-1][2], P[i][0], P[i][2])[0]); return b; }
out.islands = {
  stations: stations.length, kerbStops: kerbStops.length,
  platforms: Lay.islands.filter(function(I){ return I.platform; }).map(function(I){
    const s = sites[I.site], ds = lanesTr.map(function(t){ return polyD(I.x, I.z, t.P); }).sort(function(a, b){ return a - b; });
    return {site: I.site, kind: I.platform, len: +I.len.toFixed(2), w: +I.w.toFixed(2), h: I.h, both: !!I.both, w4000: s && s.w === 4000,
            at: Math.hypot(I.x - s.x/100, I.z - s.z/100) < 0.05, near: ds.slice(0, 2).map(function(d){ return +d.toFixed(2); })};
  }),
  small: Lay.islands.filter(function(I){ return !I.platform; }).map(function(I){ return {stop: I.stop, len: I.len}; }),
  oneEach: stations.every(function(s){ return Lay.islands.filter(function(I){ return I.site === s.id; }).length === 1; })
};
// the view stays within its 10 draw calls with the platforms
const V = TW.view({THREE: THREE, canvasTex: function(w, h){ return {t: new THREE.Texture()}; }}, W, 5, {sim: sim, layout: Lay});
out.draws = V.drawCalls ? V.drawCalls() : null;

out.rails = {pts: railPts, out: railOut};

// worldgeom: a centre bed is drawn as a raised, kerbed strip in setts (its walk geometry, SIDEWALK_UP over the road),
// its tram marks white lines 0.25 m outside its kerbs and dashed lines between the lanes, nothing on the bed
const TB = [0.40, 0.39, 0.37];
function near(a, b){ return Math.abs(a - b) < 1e-6; }
const longest = beds.filter(function(e){ return e.v4 === "avenue"; }).map(function(e){ return {e: e, l: e.pts.length}; }).sort(function(a, b){ return b.l - a.l || a.e.id - b.e.id; })[0].e;
const lp = longest.pts, lm = Math.floor(lp.length/6), lx = lp[3*lm]/100, lz = lp[3*lm+2]/100, lnx = (lp[3*lm+3] - lp[3*lm-3])/100, lnz = (lp[3*lm+5] - lp[3*lm-1])/100, ll = Math.hypot(lnx, lnz);
const tile = G.tileOf(lx, lz), RT = G.roadTile(W, tile.tx, tile.tz);
let bedVerts = 0, bedYErr = 0;
const marks = {};
for(let v = 0; v < RT.walk.col.length; v += 3){
  if(!(near(RT.walk.col[v], TB[0]) && near(RT.walk.col[v+1], TB[1]) && near(RT.walk.col[v+2], TB[2]))) continue;
  bedVerts++;
}
for(let v = 0; v < RT.marks.pos.length; v += 3){
  const x = RT.marks.pos[v], z = RT.marks.pos[v+2], dx = x - lx, dz = z - lz, al = (dx*lnx + dz*lnz)/ll, lat = (dx*lnz - dz*lnx)/ll;
  if(Math.abs(al) > 3 || Math.abs(lat) > 14) continue;
  marks[Math.round(Math.abs(lat)*100)] = 1;
}
out.geom = {bedVerts: bedVerts, marks: Object.keys(marks).map(Number).sort(function(a, b){ return a - b; }), bedHalf: longest.bed/200};

/* ---------- hqcivic: a station's furniture on the platform, the kerb stop as it was ---------- */
function hashStr(s){ let h = 2166136261 >>> 0; s = String(s); for(let i = 0; i < s.length; i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h >>> 0; }
function rng(seed){ let a = seed >>> 0 || 1; return function(){ a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0)/4294967296; }; }
function mat(c, o){ return new THREE.MeshStandardMaterial(Object.assign({color: c}, o || {})); }
function emis(c, e, ei, o){ const m = mat(c, o); m.emissive = new THREE.Color(e); m.emissiveIntensity = ei; return m; }
function add(o, x, y, z, p){ o.position.set(x, y, z); p.add(o); return o; }
const noop2d = new Proxy({}, {get(t, k){ return k === "measureText" ? function(){ return {width: 10}; } : (k === "createLinearGradient" || k === "createRadialGradient") ? function(){ return {addColorStop(){}}; } : function(){}; }, set(){ return true; }});
const ctx = {THREE: THREE, PI: Math.PI, rng: rng, hashStr: hashStr, mat: mat, emis: emis, add: add,
  box(w, h, d, m, x, y, z, p){ return add(new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m), x, y, z, p); },
  cyl(rt, rb, h, m, x, y, z, p, seg){ return add(new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg || 20), m), x, y, z, p); },
  sph(r, m, x, y, z, p){ return add(new THREE.Mesh(new THREE.SphereGeometry(r, 14, 10), m), x, y, z, p); },
  canvasTex(w, h, draw){ if(draw) draw(noop2d, w, h); return {c: null, g: noop2d, t: new THREE.Texture()}; },
  glow(col, s, o){ return new THREE.Sprite(new THREE.SpriteMaterial({color: col})); },
  label(t){ return new THREE.Sprite(new THREE.SpriteMaterial({})); }, short(s){ return String(s || ""); }, api: {}};
function named(B){ const n = []; B.g.traverse(function(o){ if(/^tramstop:/.test(o.name || "")) n.push(o.name); }); return n.sort(); }
function civic(s){
  const B = C.build(ctx, s, {tier: 5}), y = B.g.position.y;
  let meshes = 0; B.g.traverse(function(o){ if(o.isMesh) meshes++; });
  // what stands on the platform, in the site's own frame (+z its front): not the paved base under it all
  B.g.rotation.y = 0; B.g.position.set(0, 0, 0); B.g.updateMatrixWorld(true);
  const box = new THREE.Box3();
  B.g.traverse(function(o){ if(o.isMesh && o.geometry && o.geometry.type !== "ExtrudeGeometry") box.expandByObject(o); });
  return {names: named(B), meshes: meshes, w: +B.w.toFixed(2), d: +B.d.toFixed(2), doors: B.doors.map(function(d){ return d.kind; }),
          size: [+(box.max.x - box.min.x).toFixed(2), +(box.max.z - box.min.z).toFixed(2)], low: +box.min.y.toFixed(3), y: y};
}
out.civic = {station: civic(stations[0]), stop: kerbStops.length ? civic(kerbStops[0]) : null};

/* ---------- older docs: as before ---------- */
const city = require(FIX + "traffic_city.js"), old = {};
[["commons2", WD.pack(gz("claude-hq@2.json.gz"))], ["hub", city(1, 7, true)]].forEach(function(p){
  const name = p[0], Wo = p[1], so = T.create(Wo, {tier: 5, seed: 7}), Eo = so._.edges.filter(function(e){ return e.tram; });
  const Lo = TW.layout(Wo, 5, {sim: so});
  old[name] = {tramEdges: Eo.length, offs: Array.from(new Set(Eo.map(function(e){ return +e.tramOff.toFixed(4); }))),
               lays: Eo.filter(function(e){ return e.tramLay || e.bedH; }).length,
               fields: (Wo.edges || []).filter(function(e){ return e.tram !== undefined || e.bed !== undefined; }).length,
               carIn: Eo.filter(function(e){ return e.cars && e.carOff < 1.475 + wid/2 + 0.3 + cw/2 + 0.1 - 1e-9; }).length,
               platforms: Lo.islands.filter(function(I){ return I.platform; }).length, islands: Lo.islands.length,
               mid: name === "commons2" ? (WD.surfaceAt(Wo, 0, 0), Wo.index ? Wo.index.mid : "noindex") : null};
});
out.old = old;

/* ---------- island@3 ---------- */
if(fs.existsSync(FIX + "island@3.json.gz")){
  const Wi = WD.pack(gz("island@3.json.gz")), si = T.create(Wi, {tier: 5, seed: 7}), Li = TW.layout(Wi, 5, {sim: si});
  out.island = {tram: Wi.edges.filter(function(e){ return e.tram; }).length, beds: Wi.edges.filter(function(e){ return e.bed > 0; }).length,
                tracks: Li.stats.tracks, platforms: Li.islands.filter(function(I){ return I.platform; }).length,
                stations: Wi.sites.filter(function(s){ return s.kind === "tramstop" && s.w >= 4000; }).length};
}
console.log(JSON.stringify(out));
"""


@unittest.skipUnless(NODE, "node not installed")
class TramRoads(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not os.path.exists(os.path.join(FIX, "claude-hq@3.json.gz")):
            raise unittest.SkipTest("no @3 fixture")
        src = HARNESS % {"root": json.dumps(ROOT)}
        r = subprocess.run([NODE, "--input-type=module", "-e", src], capture_output=True, text=True, timeout=600)
        if r.returncode != 0:
            raise AssertionError(r.stderr[-4000:])
        cls.o = json.loads(r.stdout.strip().splitlines()[-1])

    def test_pack_and_docof_keep_tram_and_bed(self):
        f = self.o["fields"]
        self.assertGreater(f["raw"], 10, f)
        self.assertGreater(f["beds"], 5, f)
        self.assertEqual(f["lays"], ["centre-bed", "shared-double", "shared-single"])
        self.assertEqual(f["packed"], f["edges"])       # every edge: tram / bed as in the doc, absent where absent
        self.assertEqual(f["docOf"], f["edges"])
        self.assertEqual(f["again"], f["edges"])        # pack(docOf(W)) round trip
        self.assertEqual(f["bedWithMedian"], 0)         # a centre bed stands for the median

    def test_bed_is_raised_paving(self):
        b = self.o["bed"]
        self.assertGreater(b["edges"], 10, b)
        self.assertGreater(b["pts"], 50, b)
        self.assertEqual(b["up"], b["pts"], b)          # the bed's middle and both its edges: raised, not carriageway
        self.assertEqual(b["laneRoad"], 2*b["pts"]//3, b)   # the lane beside it either side: road
        self.assertLess(b["upErr"], 0.03, b)            # 150 mm over the road

    def test_lateral_plan(self):
        lay = self.o["lay"]
        self.assertEqual(sorted(lay), ["centre-bed", "shared-double", "shared-single"])
        bed = lay["centre-bed"]
        # inside the bed: an avenue's 9.2 m bed 3.025 m out (a 3.4 m gap for the island), a collector's 7.2 m 2.025 m
        self.assertEqual(bed["offs"], [2.025, 3.025])
        self.assertEqual(bed["carIn"], 0)               # every car lane outside the bed
        self.assertEqual(bed["bodyOut"], 0)             # the tram's body inside the kerbs, clear of the middle
        # shared: the tram in the innermost lane (an avenue's 1 m median + half a 3.5 m lane; a collector's one lane)
        self.assertEqual(lay["shared-double"]["offs"], [2.75])
        self.assertEqual(lay["shared-single"]["offs"], [1.75])

    def test_no_car_on_the_bed(self):
        d = self.o["drive"]
        self.assertGreater(d["carSamples"], 100, d)
        self.assertEqual(d["carOnBed"], 0, d)
        self.assertGreater(d["tramSamples"], 20, d)
        self.assertLess(d["tramYErr"], 0.07, d)         # the trams ride on the bed, not 150 mm into it

    def test_rails_inside_the_bed(self):
        r = self.o["rails"]
        self.assertGreater(r["pts"], 50, r)
        self.assertEqual(r["out"], 0, r)

    def test_station_islands(self):
        i = self.o["islands"]
        self.assertGreater(i["stations"], 3, i)
        self.assertTrue(i["oneEach"], i)
        self.assertEqual(len(i["platforms"]), i["stations"], i)
        kinds = set()
        for p in i["platforms"]:
            self.assertTrue(p["w4000"], p)
            self.assertTrue(p["at"], p)                 # on the site's rectangle
            self.assertAlmostEqual(p["len"], 40, delta=0.3)
            self.assertAlmostEqual(p["w"], 3, delta=0.1)
            self.assertEqual(p["h"], 0.3)
            kinds.add(p["kind"])
            if p["kind"] == "centre":
                self.assertTrue(p["both"], p)           # a tactile edge each side
                # between the two tracks, each clear of the island by the tram's half width
                self.assertEqual(len(p["near"]), 2)
                for d in p["near"]:
                    self.assertGreaterEqual(d, 2.65/2 + 1.5 - 0.02, p)
                    self.assertLess(d, 3.5, p)
            else:
                self.assertGreaterEqual(p["near"][0], 2.65/2 + 1.5 - 0.02, p)
        self.assertEqual(kinds, {"centre", "kerb"})
        # the old 6 x 2.5 m kerb stops keep the island beside the track
        self.assertGreater(len(i["small"]), 0)
        for s in i["small"]:
            self.assertEqual(s["len"], 30)
        self.assertLessEqual(self.o["draws"], 10)

    def test_bed_drawn_with_marks_at_its_kerbs(self):
        g = self.o["geom"]
        self.assertEqual(g["bedHalf"], 4.6)
        self.assertGreater(g["bedVerts"], 0, g)         # the setts strip
        # white edge lines 0.25 m outside the 4.6 m half bed (12 cm wide); dashes between the two lanes each way (8.1 m)
        # may fall either side of the sampled stretch; nothing on the bed itself
        self.assertTrue({479, 491} <= set(g["marks"]), g)
        self.assertEqual([m for m in g["marks"] if m < 460], [], g)

    def test_station_furniture(self):
        s, k = self.o["civic"]["station"], self.o["civic"]["stop"]
        self.assertAlmostEqual(s["w"], 40, delta=0.2)
        self.assertAlmostEqual(s["d"], 3, delta=0.1)
        self.assertIn("tramstop:ticket", s["names"])
        self.assertIn("tramstop:board", s["names"])
        self.assertEqual(s["doors"], ["tramstop"])
        self.assertLessEqual(s["size"][1], 3.05)        # all of it on the 3 m platform
        self.assertGreaterEqual(s["low"], 0.3 - 0.13)   # standing on the island (0.3 m), not in it
        self.assertIsNotNone(k)
        self.assertEqual(k["names"], [])                # the small stop as it was: platform, tactile edge, shelter
        self.assertEqual(k["doors"], ["tramstop"])

    def test_old_docs_unchanged(self):
        for name, o in self.o["old"].items():
            self.assertGreater(o["tramEdges"], 0, name)
            self.assertEqual(o["fields"], 0, name)
            self.assertEqual(o["lays"], 0, name)
            self.assertEqual(o["offs"], [1.475], name)  # the tram by the centre line, as ever
            self.assertEqual(o["carIn"], 0, name)
            self.assertEqual(o["platforms"], 0, name)
            self.assertGreater(o["islands"], 0, name)
        self.assertIsNone(self.o["old"]["commons2"]["mid"])   # no median, no bed: roadUnder's original path

    def test_island_v3(self):
        if "island" not in self.o:
            self.skipTest("no island@3 fixture")
        i = self.o["island"]
        self.assertGreater(i["tram"], 0, i)
        self.assertGreater(i["tracks"], 0, i)
        self.assertEqual(i["platforms"], i["stations"], i)


if __name__ == "__main__":
    unittest.main()
