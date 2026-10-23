"""Curved roads (games/roadsmooth.js, docs/plans/city-sim.md Part 1).

roadsmooth.js is pure, so node loads it with world.js against a stub `window`, packs the Commons (claude-hq@2), an
island (island@2) and Arena City (claude-hq@1), smooths each and prints the numbers; the Python side checks them:
no point farther than the cap from the original polyline, none inside a lot or a site, chain ends on their nodes,
interior splits shared and near theirs, no kinks left (heading change between 3 m samples bounded), bridges
untouched, deterministic and idempotent, fast; and the junction corner arcs. Skipped when node is not installed.
Stdlib only."""
import json
import os
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")
FIXTURES = ["claude-hq@2.json.gz", "island@2.json.gz", "claude-hq@1.json.gz"]

HARNESS = r"""
var fs = require("fs"), zlib = require("zlib"), root = %(root)s;
global.window = {HQV: {}};
new Function(fs.readFileSync(root + "/games/world.js", "utf8"))();
new Function(fs.readFileSync(root + "/games/roadsmooth.js", "utf8"))();
var WD = window.HQV.world, RS = window.HQV.roadSmooth, out = {};
var DEG = 180/Math.PI, LIMIT = {local: 12, street: 12, arterial: 8, avenue: 8, highway: 24, ring: 24};

function load(f){ return JSON.parse(zlib.gunzipSync(fs.readFileSync(root + "/tests/fixtures/" + f))); }
function poly(p){ var o = []; for(var i = 0; i + 2 < p.length; i += 3) o.push([p[i]/100, p[i+1]/100, p[i+2]/100]); return o; }
function segD(x, z, A, B){
  var dx = B[0] - A[0], dz = B[2] - A[2], l2 = dx*dx + dz*dz, t = l2 ? Math.max(0, Math.min(1, ((x - A[0])*dx + (z - A[2])*dz)/l2)) : 0;
  return Math.hypot(x - A[0] - dx*t, z - A[2] - dz*t);
}
function polyD(x, z, P){ var b = Infinity; for(var i = 0; i < P.length - 1; i++) b = Math.min(b, segD(x, z, P[i], P[i+1])); return b; }
function inPoly(x, z, R){
  var c = false;
  for(var i = 0, j = R.length - 1; i < R.length; j = i++){
    var xi = R[i][0], zi = R[i][1], xj = R[j][0], zj = R[j][1];
    if((zi > z) !== (zj > z) && x < (xj - xi)*(z - zi)/(zj - zi) + xi) c = !c;
  }
  return c;
}
function areas(W){
  return W.lots.concat(W.sites).map(function(o){
    if(o.poly && o.poly.length >= 3) return {id: o.id, ring: o.poly.map(function(p){ return [p[0]/100, p[1]/100]; })};
    var x0 = (o.x - o.w/2)/100, x1 = (o.x + o.w/2)/100, z0 = (o.z - o.d/2)/100, z1 = (o.z + o.d/2)/100;
    return {id: o.id, ring: [[x0, z0], [x1, z0], [x1, z1], [x0, z1]]};
  });
}
// pack() without the smoothing (world.js calls roadSmooth.smooth itself once roadsmooth.js is loaded)
function raw(doc){ var rs = window.HQV.roadSmooth; delete window.HQV.roadSmooth; try { return WD.pack(doc); } finally { window.HQV.roadSmooth = rs; } }
function heading(p, i){ return Math.atan2(p[3*i+3] - p[3*i], p[3*i+5] - p[3*i+2]); }
function dh(a, b){ var d = Math.abs(b - a) % (2*Math.PI); return d > Math.PI ? 2*Math.PI - d : d; }

FIX.forEach(function(f){
  var doc = load(f), W = raw(doc), W2 = raw(doc), N = {}, inc = {};
  W.nodes.forEach(function(n){ N[n.id] = n; });
  W.edges.forEach(function(e){ (inc[e.a] = inc[e.a] || []).push(e); (inc[e.b] = inc[e.b] || []).push(e); });
  var orig = W.edges.map(function(e){ return Array.from(e.pts); });
  // timing: the first smooth (cold) and the mean of three more (each restarts from pts0)
  var t0 = Date.now(); RS.smooth(W); var cold = Date.now() - t0;
  t0 = Date.now(); for(var r = 0; r < 3; r++) RS.smooth(W); var warm = (Date.now() - t0)/3;
  RS.smooth(W2);
  var WP = WD.pack(doc);   // world.js pack() with roadsmooth.js loaded: the same curves, the originals in pts0
  var o = {edges: W.edges.length, cold: cold, warm: warm, det: true, packed: true, pts0: true, bridges: 0, bridgeSame: true,
           devMax: 0, devOver: 0, inArea: 0, inAreaOrig: 0, endBad: 0, splitBad: 0, splitFar: 0, chainEnds: 0, splits: 0,
           stepMax: 0, headOver: [], kinksSmoothed: 0, kinksBefore: 0, kinksAfter: 0, kinksExempt: 0, pts: 0, ptsOrig: 0, smoothed: W.smoothed};
  W.edges.forEach(function(e, i){
    if(JSON.stringify(Array.from(e.pts)) !== JSON.stringify(Array.from(W2.edges[i].pts))) o.det = false;
    if(!WP.smoothed || JSON.stringify(Array.from(e.pts)) !== JSON.stringify(Array.from(WP.edges[i].pts)) ||
       JSON.stringify(Array.from(WP.edges[i].pts0)) !== JSON.stringify(orig[i])) o.packed = false;
    if(JSON.stringify(Array.from(e.pts0)) !== JSON.stringify(orig[i])) o.pts0 = false;
    o.pts += e.pts.length/3; o.ptsOrig += orig[i].length/3;
    if(e.bridge){ o.bridges++; if(JSON.stringify(Array.from(e.pts)) !== JSON.stringify(orig[i])) o.bridgeSame = false; }
  });
  function chainable(id){
    var L = inc[id]; if(!L || L.length !== 2 || L[0] === L[1]) return false;
    return !L[0].bridge && !L[1].bridge && L[0].cls === L[1].cls && L[0].width === L[1].width;
  }
  function nearBridge(id){   // a degree-2 node within the bridge lock of a bridge end (corners there stay)
    var n = N[id], hit = false;
    W.edges.forEach(function(e){ if(e.bridge){ [N[e.a], N[e.b]].forEach(function(m){ if(Math.hypot(m.x - n.x, m.z - n.z)/100 < RS.LOCK + 25) hit = true; }); } });
    return hit;
  }
  // deviation: from the original polylines of this edge and of the edges at its two nodes
  var A = areas(W);
  W.edges.forEach(function(e){
    if(e.bridge) return;
    var cap = RS.CAP*e.width/200, near = [e].concat(inc[e.a] || [], inc[e.b] || []).map(function(x){ return poly(x.pts0); });
    var P = e.pts;
    for(var k = 0; k + 2 < P.length; k += 3){
      var x = P[k]/100, z = P[k+2]/100, d = Infinity;
      near.forEach(function(Q){ d = Math.min(d, polyD(x, z, Q)); });
      o.devMax = Math.max(o.devMax, d - cap);
      if(d > cap + 0.011) o.devOver++;
      for(var q = 0; q < A.length; q++) if(inPoly(x, z, A[q].ring)){ o.inArea++; break; }
      if(k > 0) o.stepMax = Math.max(o.stepMax, Math.hypot(P[k] - P[k-3], P[k+2] - P[k-1])/100);
    }
    var Q0 = e.pts0;
    for(k = 0; k + 2 < Q0.length; k += 3) for(q = 0; q < A.length; q++) if(inPoly(Q0[k]/100, Q0[k+2]/100, A[q].ring)){ o.inAreaOrig++; break; }
    // the paved edges too: half the width (less 5 cm) either side, square to the road
    function edgesIn(P){
      var n = P.length/3, hw = e.width/200 - 0.05, c = 0;
      for(var i = 0; i < n; i++){
        var a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1), dx = (P[3*b] - P[3*a])/100, dz = (P[3*b+2] - P[3*a+2])/100, l = Math.hypot(dx, dz);
        if(!(l > 1e-6)) continue;
        for(var sd = -1; sd <= 1; sd += 2){
          var x = P[3*i]/100 - dz/l*hw*sd, z = P[3*i+2]/100 + dx/l*hw*sd;
          for(var q2 = 0; q2 < A.length; q2++) if(inPoly(x, z, A[q2].ring)){ c++; break; }
        }
      }
      return c;
    }
    o.edgeIn = (o.edgeIn || 0) + edgesIn(P); o.edgeInOrig = (o.edgeInOrig || 0) + edgesIn(Q0);
  });
  function turnAtNode(id){
    var L = inc[id]; if(!L || L.length !== 2) return 0;
    function dir(e){ var q = e.pts0, n = q.length/3, s = e.a === +id ? 0 : n - 1, t = e.a === +id ? 1 : n - 2;
      return [q[3*t] - q[3*s], q[3*t+2] - q[3*s+2]]; }
    var a = dir(L[0]), b = dir(L[1]);
    return Math.PI - Math.acos(Math.max(-1, Math.min(1, (a[0]*b[0] + a[1]*b[1])/Math.hypot(a[0], a[1])/Math.hypot(b[0], b[1]))));
  }
  // endpoints: chain ends exactly on the original points; interior splits shared by both edges, near the node
  Object.keys(inc).forEach(function(id){
    var L = inc[id], n = N[id];
    L.forEach(function(e){
      if(e.bridge) return;
      var atA = e.a === +id, p = e.pts, j = atA ? 0 : p.length - 3, q = e.pts0, jq = atA ? 0 : q.length - 3;
      if(!chainable(id)){
        o.chainEnds++;
        if(p[j] !== q[jq] || p[j+1] !== q[jq+1] || p[j+2] !== q[jq+2] || p[j] !== n.x || p[j+2] !== n.z) o.endBad++;
      }
    });
    if(chainable(id)){
      o.splits++;
      var e = L[0], f = L[1], pe = e.a === +id ? 0 : e.pts.length - 3, pf = f.a === +id ? 0 : f.pts.length - 3;
      if(e.pts[pe] !== f.pts[pf] || e.pts[pe+1] !== f.pts[pf+1] || e.pts[pe+2] !== f.pts[pf+2]) o.splitBad++;
      // the split is the curve's nearest point to the node: at most cap/cos(theta/2) from it on a corner of theta
      var cap = RS.CAP*e.width/200/Math.cos(Math.min(turnAtNode(id), 3)/2);
      if(Math.hypot(e.pts[pe] - n.x, e.pts[pe+2] - n.z)/100 > cap + 0.011) o.splitFar++;
    }
  });
  // headings: every turn between consecutive samples, across the degree-2 nodes too. A turn belongs to the nearer
  // node of its edge; at a corner of theta > 50 deg (or short arms) the cap allows no wider arc than
  // R = min(cap/(1 - cos(theta/2)), 0.45 arm/tan(theta/2)), so there the bound is 3 m/R (+15%).
  function lenOf(e){ var q = e.pts0, s = 0; for(var k = 3; k < q.length; k += 3) s += Math.hypot(q[k] - q[k-3], q[k+2] - q[k-1])/100; return s; }
  function allowed(e, id){
    var lim = LIMIT[e.cls] || 12;
    if(id == null) return lim;
    var th = turnAtNode(id), L = inc[id], cap = RS.CAP*e.width/200*0.95, h = th/2;
    if(th < 1e-3) return lim;
    var R = Math.min(cap/(1 - Math.cos(h)), 0.45*Math.min(lenOf(L[0]), lenOf(L[1]))/Math.tan(h));
    // a fillet the lots held tighter (W.smoothed.tight: its radius; 0: left sharp, as the server drew it)
    var T = W.smoothed && W.smoothed.tight, tr = T ? T[id] : null;
    if(tr != null){ if(!(tr > 0)) return Infinity; R = Math.min(R, tr); }
    return Math.max(lim, 3/R*DEG*1.15 + 0.5);
  }
  function check(e, t, x, z, id, where){
    var lim = allowed(e, id);
    if(t*DEG > lim) o.headOver.push({edge: e.id, cls: e.cls, turn: +(t*DEG).toFixed(1), lim: +lim.toFixed(1), node: id, where: where, x: x, z: z});
  }
  function owner(e, x, z){
    var a = N[e.a], b = N[e.b], id = Math.hypot(x*100 - a.x, z*100 - a.z) < Math.hypot(x*100 - b.x, z*100 - b.z) ? e.a : e.b;
    return chainable(id) ? id : null;
  }
  W.edges.forEach(function(e){
    if(e.bridge) return;
    var p = e.pts, n = p.length/3;
    for(var i = 1; i < n - 1; i++) check(e, dh(heading(p, i - 1), heading(p, i)), p[3*i]/100, p[3*i+2]/100, owner(e, p[3*i]/100, p[3*i+2]/100), "edge");
  });
  Object.keys(inc).forEach(function(id){
    if(!chainable(id)) return;
    var e = inc[id][0], f = inc[id][1];
    function hOut(x){ var p = x.pts, n = p.length/3; return x.a === +id ? heading(p, 0) : heading(p, n - 2) + Math.PI; }
    function hOut0(x){ var p = x.pts0, n = p.length/3; return x.a === +id ? heading(p, 0) : heading(p, n - 2) + Math.PI; }
    var before = Math.PI - dh(hOut0(e), hOut0(f)), after = Math.PI - dh(hOut(e), hOut(f));
    if(before > 25/DEG){
      o.kinksBefore++;
      if(nearBridge(id) || (W.smoothed.tight && W.smoothed.tight[id] === 0)) o.kinksExempt++;
      else if(after < before - 1/DEG) o.kinksSmoothed++;   // (and within allowed(), checked below)
      else o.kinksAfter++;
    }
    var n = N[id];
    if(!nearBridge(id)) check(e, after, n.x/100, n.z/100, +id, "node");
  });
  o.headOver = o.headOver.filter(function(h){ return h.node == null || !nearBridge(h.node); });
  o.headOverN = o.headOver.length; o.headOver = o.headOver.slice(0, 8);
  // junction corners at every 3+ way node
  var jc = {nodes: 0, arcs: 0, bad: 0, rMax: 0, ex: []};
  Object.keys(inc).forEach(function(id){
    if(inc[id].length < 3) return;
    jc.nodes++;
    RS.junctionCorners(W, +id).forEach(function(c){
      jc.arcs++;
      var ea = W.edges.filter(function(x){ return x.id === c.a; })[0], eb = W.edges.filter(function(x){ return x.id === c.b; })[0];
      jc.rMax = Math.max(jc.rMax, c.r - Math.min(RS.CORNER_R[ea.cls], RS.CORNER_R[eb.cls]));
      // the arc starts on a's kerb, ends on b's, and stays off both carriages
      function dl(e, P){ var Q = poly(e.pts); return polyD(P[0], P[1], Q); }
      var hwA = (ea.width - 2*ea.walk)/200, hwB = (eb.width - 2*eb.walk)/200, s = c.pts[0], t = c.pts[c.pts.length - 1];
      var ok = Math.abs(dl(ea, s) - hwA) < 0.05 && Math.abs(dl(eb, t) - hwB) < 0.05 && c.pts.length >= 3;
      c.pts.forEach(function(P){ if(dl(ea, P) < hwA - 0.05 || dl(eb, P) < hwB - 0.05) ok = false; });
      if(!ok){ jc.bad++; if(jc.ex.length < 3) jc.ex.push({node: +id, a: c.a, b: c.b, r: c.r, s: dl(ea, s) - hwA, t: dl(eb, t) - hwB,
        mn: Math.min.apply(null, c.pts.map(function(P){ return Math.min(dl(ea, P) - hwA, dl(eb, P) - hwB); }))}); }
    });
  });
  jc.deg2 = RS.junctionCorners(W, +Object.keys(inc).filter(function(id){ return inc[id].length === 2; })[0]).length;
  o.jc = jc;
  // docOf sees the curves
  var dv = WD.docOf(W), e0 = W.edges.filter(function(e){ return !e.bridge && e.pts.length !== e.pts0.length; })[0];
  o.docOf = e0 ? dv.layers.roads.edges[W.edges.indexOf(e0)].points.length === e0.pts.length/3 : null;
  out[f] = o;
});
console.log(JSON.stringify(out));
"""


@unittest.skipUnless(NODE, "node is not installed")
class RoadSmoothTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        src = HARNESS.replace("%(root)s", json.dumps(ROOT))
        src = "var FIX = " + json.dumps(FIXTURES) + ";\n" + src
        res = subprocess.run([NODE, "-e", src], capture_output=True, text=True, timeout=240)
        if res.returncode != 0:
            raise AssertionError(res.stderr[-4000:])
        cls.out = json.loads(res.stdout.strip().splitlines()[-1])

    def each(self):
        return [(f, self.out[f]) for f in FIXTURES]

    def test_deviation_cap(self):
        for f, o in self.each():
            self.assertEqual(o["devOver"], 0, (f, o["devMax"]))

    def test_nothing_inside_lots_or_sites(self):
        for f, o in self.each():
            self.assertEqual(o["inAreaOrig"], 0, f)   # the server's roads are clear of them ...
            self.assertEqual(o["inArea"], 0, f)       # ... and so are the curves
            self.assertEqual(o["edgeInOrig"], 0, f)   # the paved edges (centre +- half the width) too ...
            self.assertEqual(o["edgeIn"], 0, f)       # ... curved as well

    def test_endpoints(self):
        for f, o in self.each():
            self.assertGreater(o["chainEnds"], 0)
            self.assertEqual(o["endBad"], 0, f)     # chain ends: the node's exact original point
            self.assertEqual(o["splitBad"], 0, f)   # interior splits: both edges share the point
            self.assertEqual(o["splitFar"], 0, f)   # ... within the cap of the node

    def test_no_kinks_left(self):
        for f, o in self.each():
            self.assertEqual(o["headOverN"], 0, (f, o["headOver"]))
            self.assertEqual(o["kinksAfter"], 0, f)
            self.assertLessEqual(o["stepMax"], 3.02, f)
        self.assertGreater(self.out["claude-hq@2.json.gz"]["kinksSmoothed"], 20)
        self.assertGreater(self.out["island@2.json.gz"]["kinksSmoothed"], 50)

    def test_bridges_untouched(self):
        self.assertGreater(self.out["claude-hq@2.json.gz"]["bridges"], 0)
        for f, o in self.each():
            self.assertTrue(o["bridgeSame"], f)
            self.assertTrue(o["pts0"], f)

    def test_deterministic(self):
        for f, o in self.each():
            self.assertTrue(o["det"], f)            # two packs agree byte for byte (and smooth() is idempotent)
            self.assertTrue(o["packed"], f)         # world.js pack() smooths by itself when roadsmooth.js is loaded
            self.assertEqual(o["smoothed"]["v"], 2)
            # corners a lot sits snug inside are drawn tighter, never left sharp (on @1 nearly all are)
            tight = o["smoothed"]["tight"]
            self.assertEqual([k for k, r in tight.items() if not r > 0], [], f)
            if "@2" in f:
                self.assertLess(len(tight), 0.5*o["splits"], f)    # most keep their full arc
            self.assertTrue(o["docOf"], f)          # world.docOf hands the curves to traffic / npcsim

    def test_fast(self):
        for f, o in self.each():
            self.assertLess(o["warm"], 300, f)
            self.assertLess(o["cold"], 600, f)

    def test_junction_corners(self):
        for f, o in self.each():
            jc = o["jc"]
            self.assertGreater(jc["arcs"], jc["nodes"], f)   # most junctions get several rounded corners
            self.assertEqual(jc["bad"], 0, (f, jc["ex"]))
            self.assertLessEqual(jc["rMax"], 1e-9, f)
            self.assertEqual(jc["deg2"], 0, f)


if __name__ == "__main__":
    unittest.main()
