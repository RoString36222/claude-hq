"""The metro in real tunnels (games/hqmetro.js, docs/plans/transport-revamp.md 3.3, 5.3, 5.4, 5.7).

node runs the pure half against a synthetic @3 metro layer (written below, cm like the doc): the timetable (headway,
dwell, acceleration limits, both directions, no two trains on one stretch of track), the under flag flipping at the
portal mouth, departures in order, seats inside their car, the walkable floors (platforms, halls, stairs; never the
track), entrances and exits, determinism and the tunnel LOD. A second node run builds the view with the vendored
three.js and checks the draw-call and triangle budgets at the tour cameras. The @3 fixtures are used when present.
Skipped when node is not installed. Stdlib only."""
import json
import math
import os
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")
Q = 65536


def metro_fixture():
    """A metro layer (cm): M1 east-west at z = 0 (depot west, portal, cut-and-cover, bored, a bend, a headshunt east),
    M2 north-south at x = 0, deeper (bored from the south terminus, cut-and-cover, a portal, depot north). They cross
    at Central (0, 0), M1 above M2. Street level 2 m. One Island Link underground platform near Central."""
    street = 200
    m1 = [[-95000, street, 0], [-85000, street, 0], [-75000, -800, 0], [-60000, -1100, 0], [-30000, -1100, 0],
          [0, -1100, 0], [30000, -1100, 2000], [45000, -1100, 6000], [95000, -1100, 6000]]
    m1k = ["open", "portal", "cutcover", "bored", "bored", "bored", "bored", "bored"]
    m2 = [[0, -1800, -95000], [0, -1800, -30000], [0, -1800, 0], [0, -1800, 30000], [0, -1800, 60000],
          [0, -1200, 70000], [0, street, 82000], [0, street, 95000]]
    m2k = ["bored", "bored", "bored", "bored", "cutcover", "portal", "open"]
    stations, entrances, holes = [], [], []

    def add_station(sid, x, z, rail, along, lines, plat="side", hall=None):
        y = rail + 110
        ents = []
        for j, (lat, k) in enumerate([(1600, "stairs"), (-1600, "escalator"), (2200, "lift")]):
            # beside the station, on the pavement, going down along the track
            fx, fz = along
            lx, lz = fz, -fx            # left of the track direction (Q16)
            ex = x + lx*lat//Q - fx*(1200 + 800*j)//Q
            ez = z + lz*lat//Q - fz*(1200 + 800*j)//Q
            eid = "ent:%d" % len(entrances)
            hole = [[ex - 250, ez - 250], [ex + 250, ez - 250], [ex + 250, ez + 250], [ex - 250, ez + 250]]
            entrances.append({"id": eid, "station": sid, "x": ex, "z": ez, "y": street, "front": [fx, fz], "w": 400,
                              "d": 1000, "kind": k, "hole": hole})
            holes.append(hole)
            ents.append(eid)
        stations.append({"id": sid, "x": x, "y": y, "z": z, "along": along, "len": 9000, "platform": plat,
                         "lines": lines, "hall_y": hall if hall is not None else rail + 660, "entrances": ents})

    add_station("metro:0", -55000, 0, -1100, [Q, 0], ["M1"])
    add_station("metro:1", 0, 0, -1100, [Q, 0], ["M1", "M2"], plat="island", hall=-400)
    add_station("metro:2", 60000, 6000, -1100, [Q, 0], ["M1"])
    add_station("metro:3", 85000, 6000, -1100, [Q, 0], ["M1"])
    add_station("metro:4", 0, -80000, -1800, [0, Q], ["M2"])
    add_station("metro:5", 0, -35000, -1800, [0, Q], ["M2"])
    add_station("metro:6", 0, 45000, -1800, [0, Q], ["M2"])
    portals = [
        {"id": "portal:0", "line": "M1", "x": -85000, "z": 0, "y": street, "front": [Q, 0], "w": 1600, "len": 10000,
         "hole": [[-85000, -800], [-75000, -800], [-75000, 800], [-85000, 800]]},
        {"id": "portal:1", "line": "M2", "x": 0, "z": 82000, "y": street, "front": [0, -Q], "w": 1600, "len": 12000,
         "hole": [[-800, 70000], [800, 70000], [800, 82000], [-800, 82000]]},
    ]
    holes += [p["hole"] for p in portals]
    depots = [
        {"id": "depot:0", "line": "M1", "poly": [[-99000, -3500], [-86000, -3500], [-86000, 3500], [-99000, 3500]],
         "tracks": [[[-98000, street, z], [-87000, street, z]] for z in (-2400, -1200, 1200, 2400)]},
        {"id": "depot:1", "line": "M2", "poly": [[-3500, 86000], [3500, 86000], [3500, 99000], [-3500, 99000]],
         "tracks": [[[x, street, 87000], [x, street, 98000]] for x in (-2400, -1200, 1200)]},
    ]
    metro = {"lines": [
        {"id": "M1", "stations": ["metro:0", "metro:1", "metro:2", "metro:3"], "path": m1, "kinds": m1k, "depot": "depot:0", "tier": 1},
        {"id": "M2", "stations": ["metro:4", "metro:5", "metro:1", "metro:6"], "path": m2, "kinds": m2k, "depot": "depot:1", "tier": 1}],
        "stations": stations, "entrances": entrances, "portals": portals, "depots": depots, "holes": holes}
    rail = {"lines": [], "stations": [{"id": "rail:0", "kind": "underground", "x": 4000, "y": -2400, "z": -6000,
                                       "along": [Q, 0], "len": 9000, "platforms": 2, "lines": ["IL"], "stairs": []}], "sea": None}
    return {"id": "test:metro@3", "seed": "test:metro@3", "version": 3, "layers": {"metro": metro, "rail": rail}}


PURE = r"""
const fs = require("fs");
const root = %(root)s, doc = %(doc)s, extra = %(extra)s.map(p => JSON.parse(require("zlib").gunzipSync(fs.readFileSync(p)).toString("utf8")));
globalThis.window = {HQV: {}};
new Function(fs.readFileSync(root + "/games/hqmetro.js", "utf8"))();
const H = window.HQV.hqMetro, out = {};
const sim = H.create(doc, {tier: 5});
out.lines = sim.lines(); out.stops = sim.stops();
out.consts = {HEADWAY: H.HEADWAY, DWELL: H.DWELL, VMAX: H.VMAX, ACC: H.ACC, TRAIN_L: H.TRAIN_L, TRACK: H.TRACK, FLOOR: H.FLOOR, PITCH: H.PITCH, LOD_R: H.LOD_R};
const T0 = Date.UTC(2026, 9, 21, 8, 0, 0);
out.T0 = T0;
// departures at Central and at a side station
out.depC = sim.departures("metro:1", T0, 8);
out.dep0 = sim.departures("metro:0", T0, 6);
out.depTerm = sim.departures("metro:3", T0, 6);
// one line + direction's departures spaced by the headway; dwell = dep - arr
out.headway = (() => { const r = sim.departures("metro:2", T0, 12).filter(d => d.line === "M1" && d.plat === "1"); return r.map(d => [d.at, d.dep]); })();
// sample the vehicles every 0.25 s for 900 s: per vehicle, s and speed series
const series = {};
for(let t = 0; t <= 900; t += 0.25){
  const ms = T0 + t*1000;
  sim.vehicles(ms).forEach(v => { (series[v.id] = series[v.id] || []).push([t, v.s, v.speed, v.under ? 1 : 0, v.line, v.dir, v.x, v.z, v.kind]); });
}
// acceleration and speed limits, monotone travel, under flips (s at the flip), runs in both directions
let maxV = 0, maxA = 0, backwards = 0, flips = [], dirs = {};
Object.keys(series).forEach(id => {
  const S = series[id];
  for(let i = 1; i < S.length; i++){
    const dt = S[i][0] - S[i - 1][0];
    maxV = Math.max(maxV, S[i][2]);
    maxA = Math.max(maxA, Math.abs(S[i][2] - S[i - 1][2])/dt);
    const ds = (S[i][1] - S[i - 1][1])*S[i][5];
    if(ds < -1e-6) backwards++;
    if(S[i][3] !== S[i - 1][3]) flips.push({id, line: S[i][4], s0: S[i - 1][1], s1: S[i][1], under: S[i][3], kind0: S[i - 1][8], kind1: S[i][8]});
    // speed from positions agrees with the reported speed
  }
  dirs[S[0][4] + ":" + S[0][5]] = (dirs[S[0][4] + ":" + S[0][5]] || 0) + 1;
});
out.limits = {maxV, maxA, backwards, dirs, n: Object.keys(series).length};
out.flips = flips;
// overlap: at each sample, trains of one line and direction are at least a train length apart along the track
let minGap = Infinity;
for(let t = 0; t <= 900; t += 2){
  const vs = sim.vehicles(T0 + t*1000), g = {};
  vs.forEach(v => (g[v.line + v.dir] = g[v.line + v.dir] || []).push(v.s));
  Object.values(g).forEach(a => { a.sort((x, y) => x - y); for(let i = 1; i < a.length; i++) minGap = Math.min(minGap, a[i] - a[i - 1]); });
}
out.minGap = minGap;
// the path's portal mouth (the boundary between the portal and cutcover segments) per line
out.mouth = {};
["M1", "M2"].forEach(id => { const L = sim.lineData(id), P = L.P; for(let i = 0; i + 1 < P.kinds.length; i++){ const a = P.kinds[i], b = P.kinds[i + 1]; if((a === "portal") !== (b === "portal") && (a === "cutcover" || b === "cutcover")) out.mouth[id] = P.S[i + 1]; } out.mouth[id + "len"] = P.len; out.mouth[id + "depotAtStart"] = L.depotAtStart; });
// a trip: M1 metro:0 -> metro:2, seats, standing, door
const tr = sim.trip("M1", "metro:0", "metro:2", T0);
out.trip = tr && {from: tr.from, to: tr.to, arrive: tr.arrive, depart: tr.depart, reach: tr.reach, stops: tr.stops, seats: tr.seats, standing: tr.standing, vehicle: tr.vehicle};
if(tr){
  const ms = tr.depart + 40000, P = tr.pose(ms), seats = [];
  for(let i = 0; i < tr.seats + tr.standing; i++){
    const s = tr.seat(i, ms), car = s.car, v = sim.vehicle(tr.vehicle, ms), cp = sim.carPose(v, car);
    const dx = s.x - cp.x, dz = s.z - cp.z, lat = dx*Math.cos(cp.yaw) - dz*Math.sin(cp.yaw), along = dx*Math.sin(cp.yaw) + dz*Math.cos(cp.yaw);
    seats.push({lat, along, dy: s.y - (cp.y + H.FLOOR), stand: s.stand, car});
  }
  out.seatCheck = seats;
  out.pose = P; out.poseAtFrom = tr.pose(tr.arrive + 5000); out.poseDone = tr.pose(tr.leave + 1);
  out.door = tr.door(tr.arrive + 5000);
  out.stFrom = sim.stops().find(s => s.id === "metro:0");
  out.backTrip = (() => { const b = sim.trip("M1", "metro:2", "metro:0", T0); return b && {stops: b.stops.map(s => s.id), reach: b.reach, depart: b.depart}; })();
  out.noTrip = sim.trip("M1", "metro:0", "metro:6", T0);
}
// the layout: walkable floors, isUnder, entrances, exits
const Lay = sim.layout();
const st0 = Lay.byId["metro:0"], c1 = Lay.byId["metro:1"];
function q(x, y, z){ const w = Lay.walkable(x, y, z); return w ? w.y : null; }
const p0 = st0.plats[0], pc = p0.r;
out.walk = {
  platform: q(pc.cx, p0.y0 + 0.1, pc.cz), platformY: p0.y0,
  hall: q(st0.hall.cx, st0.hallY + 0.2, st0.hall.cz), hallY: st0.hallY,
  // the track bed: on the path at platform level, and 3.5 m off it
  trackMid: q(st0.x, p0.y0, st0.z), track: q(st0.x, p0.y0, st0.z - 3.5),
  // in the tunnel 150 m out of the station, at rail level
  tunnel: q(st0.x + 150, p0.y0 - 1, st0.z),
  far: q(5000, 0, 5000),
  stair: (() => { const f = st0.stairs[0]; const y = (f.y0 + f.y1)/2; const w = Lay.walkable(f.r.cx, y + 0.05, f.r.cz); return w && {y: w.y, kind: w.kind, mid: y}; })(),
  centralM1: (() => { const p = c1.plats.find(p => p.line === "M1"); return p && q(p.r.cx + Math.sin(p.r.yaw)*20, p.y0, p.r.cz + Math.cos(p.r.yaw)*20); })(),
  centralM2: (() => { const p = c1.plats.find(p => p.line === "M2"); return p && {got: q(p.r.cx + Math.sin(p.r.yaw)*40, p.y0, p.r.cz + Math.cos(p.r.yaw)*40), want: p.y0}; })(),
  il: (() => { const w = Lay.walkable(40, -24 + 0.1, -60); return w && w.y; })()
};
out.under = {plat: Lay.isUnder(pc.cx, p0.y0 + 1, pc.cz), tunnel: Lay.isUnder(-20000/100, -11 + 1, 0), street: Lay.isUnder(pc.cx, 2.5, pc.cz), far: Lay.isUnder(500, -11, 500), deepNowhere: Lay.isUnder(300, -30, 300)};
const E0 = Lay.entrances.find(e => e.station === "metro:0" && e.kind === "stairs");
out.ent = {at: Lay.entranceAt(E0.x + 0.5, E0.z, 3), none: Lay.entranceAt(E0.x + 50, E0.z + 50, 3), E: {id: E0.id, x: E0.x, z: E0.z, y: E0.y, yaw: E0.yaw}};
out.exit = Lay.exitTo("metro:0", E0.x, E0.z);
out.exitAny = Lay.exitTo("metro:0");
out.exitRamp = Lay.rampAt(out.exit.x, out.exit.z);
out.rampMid = (() => { const r = E0.ramp.r; const P = {x: r.cx, z: r.cz}; return Lay.rampAt(P.x, P.z); })();
out.station = Lay.stationAt(pc.cx, p0.y0, pc.cz);
// LOD: chunks within 400 m, checked by brute force
const cams = [[0, 0], [-500, 0], [700, 300], [0, 900], [3000, 3000]];
out.lod = cams.map(([x, z]) => {
  const got = sim.segmentsNear(x, z, 400).map(c => c.key).sort(), want = [];
  ["M1", "M2"].forEach(id => { const L = sim.lineData(id), P = L.P, n = Math.ceil(P.len/50);
    for(let i = 0; i < n; i++){ const s0 = i*50, s1 = Math.min(P.len, s0 + 50); let best = Infinity, under = false;
      for(let s = s0; s <= s1 + 1e-6; s += 1){ const a = H.pathAt(P, Math.min(s, s1)); best = Math.min(best, Math.hypot(a.x - x, a.z - z)); if(a.kind === "bored" || a.kind === "cutcover") under = true; }
      if(under && best <= 400 + 5) want.push({key: id + "#" + i, best}); } });
  return {got, want, near: sim.segmentsNear(x, z, 400).map(c => c.near)};
});
// determinism: a second sim and another seed
const sim2 = H.create(doc, {tier: 5}), sim3 = H.create(doc, {tier: 5, seed: "another"});
out.det = {same: JSON.stringify(sim2.vehicles(T0 + 123456)) === JSON.stringify(sim.vehicles(T0 + 123456)),
           sameDep: JSON.stringify(sim2.departures("metro:1", T0, 6)) === JSON.stringify(sim.departures("metro:1", T0, 6)),
           other: JSON.stringify(sim3.departures("metro:1", T0, 6).map(d => d.at)) !== JSON.stringify(sim.departures("metro:1", T0, 6).map(d => d.at))};
// read through HQV.world.metroOf (metres) gives the same service
window.HQV.world = {metroOf: function(W){ const m = W.layers.metro, k = 0.01, p = a => [a[0]*k, a[1]*k, a[2]*k], pp = a => a.map(q => [q[0]*k, q[1]*k]);
  return {lines: m.lines.map(l => Object.assign({}, l, {path: l.path.map(p)})),
    stations: m.stations.map(s => Object.assign({}, s, {x: s.x*k, y: s.y*k, z: s.z*k, len: s.len*k, hall_y: s.hall_y*k, along: undefined, yaw: Math.atan2(s.along[0], s.along[1])})),
    entrances: m.entrances.map(e => Object.assign({}, e, {x: e.x*k, y: e.y*k, z: e.z*k, w: e.w*k, d: e.d*k, hole: pp(e.hole)})),
    portals: m.portals.map(e => Object.assign({}, e, {x: e.x*k, y: e.y*k, z: e.z*k, w: e.w*k, len: e.len*k, hole: pp(e.hole)})),
    depots: m.depots.map(d => Object.assign({}, d, {poly: pp(d.poly), tracks: d.tracks.map(t => t.map(p))})), holes: m.holes.map(pp)}; }};
const simM = H.create(doc, {tier: 5});
out.metroOf = {deps: JSON.stringify(simM.departures("metro:1", T0, 6)) === JSON.stringify(sim.departures("metro:1", T0, 6)),
  stops: JSON.stringify(simM.stops().map(s => [s.id, Math.round(s.x*100), Math.round(s.y*100), Math.round(s.z*100)])) === JSON.stringify(sim.stops().map(s => [s.id, Math.round(s.x*100), Math.round(s.y*100), Math.round(s.z*100)]))};
delete window.HQV.world;
// the real @3 fixtures, when they exist
out.fixtures = extra.map(d => { const s = H.create(d, {tier: 5}); const ls = s.lines(), st = s.stops(); const vs = s.vehicles(T0); const L = s.layout();
  return {id: d.id, lines: ls.map(l => l.id), stops: st.length, vehicles: vs.length, ents: L.entrances.length,
    plat: st.length ? (() => { const S = L.stations[0], p = S.plats[0]; const w = p && L.walkable(p.r.cx, p.y0 + 0.1, p.r.cz); return w ? Math.abs(w.y - p.y0) : null; })() : null,
    deps: st.length ? s.departures(st[0].id, T0, 4).length : 0}; });
// an empty world
out.empty = (() => { const s = H.create({id: "x", layers: {}}, {}); return {lines: s.lines().length, stops: s.stops().length, v: s.vehicles(T0).length, d: s.departures("metro:0", T0, 4).length, t: s.trip("M1", "a", "b", T0)}; })();
console.log(JSON.stringify(out));
"""

VIEW = r"""
const fs = require("fs"), url = require("url");
const root = %(root)s, doc = %(doc)s;
import(url.pathToFileURL(root + "/games/vendor/three-module.js").href).then(function(THREE){
  globalThis.window = {HQV: {}};
  new Function(fs.readFileSync(root + "/games/hqmerge.js", "utf8"))();
  new Function(fs.readFileSync(root + "/games/hqmetro.js", "utf8"))();
  const H = window.HQV.hqMetro;
  // a 2D context that draws nothing
  const g2 = new Proxy({}, {get: (t, k) => k === "measureText" ? (() => ({width: 10})) : (typeof k === "string" && /^[a-z]/.test(k) && !["fillStyle","font","textAlign","textBaseline","strokeStyle","lineWidth","lineCap","globalAlpha"].includes(k)) ? (() => {}) : t[k], set: (t, k, v) => { t[k] = v; return true; }});
  const scene = new THREE.Scene(), sounds = [];
  let calm = false, avatar = null;
  const c = {THREE, scene, canvasTex: (w, h, d) => { if(d) d(g2, w, h); return {t: new THREE.Texture(), g: g2}; }, avatar: () => avatar};
  const sim = H.create(doc, {tier: 5});
  const V = H.view(c, sim, {calm: () => calm, night: () => false, sfx: (n, o) => sounds.push(o && o.screenDoors ? "screen" : n)});
  const out = {shots: {}};
  const T0 = Date.UTC(2026, 9, 21, 8, 0, 0);
  V.update(T0, 0.016, {x: -600, y: 30, z: 0});
  out.surface = {draws: V.drawCalls(), tris: V.triangles(), stats: V.stats()};
  ["entrance", "portal", "depot", "hall", "platform", "tunnel-ride", "central-interchange", "train-interior"].forEach((n, i) => {
    const cam = V.tools.shotCam(n);
    if(!cam){ out.shots[n] = null; return; }
    V.underground(cam.under);
    if(n === "train-interior"){ const v = sim.vehicles(T0 + 1000).find(v => v.under); V.focus(v.id); }
    V.update(T0 + 1000, 0.5, cam.pos); V.update(T0 + 1000, 0.5, cam.pos);
    out.shots[n] = {draws: V.drawCalls(), tris: V.triangles(), under: cam.under, pos: cam.pos, chunks: V.stats().chunks, stations: V.stats().stations,
                    walk: cam.under ? V.walkable(cam.pos.x, cam.pos.y - 1.5, cam.pos.z) : null};
    V.focus(null);
  });
  // the worst case underground: Central, every chunk of both lines in range
  V.underground(true);
  const cst = sim.layout().byId["metro:1"];
  V.update(T0 + 2000, 0.5, {x: cst.x, y: cst.hallY + 1.7, z: cst.z});
  out.central = {draws: V.drawCalls(), tris: V.triangles(), chunks: V.stats().chunks, stations: V.stats().stations};
  // the walker at a gate line: it opens (Calm: at once) with a beep
  const gate = (() => { const h = cst.hall, s = Math.sin(h.yaw), co = Math.cos(h.yaw); return {x: h.cx + s*10 + co*0.55*1 - co*4.4 + co*0.55, z: h.cz + co*10 - s*(-4.4 + 0.55)}; })();
  avatar = {x: gate.x, z: gate.z, hy: cst.hallY};
  sounds.length = 0; calm = true;
  V.update(T0 + 2500, 0.016, {x: cst.x, y: cst.hallY + 1.7, z: cst.z});
  out.gate = {beeps: sounds.filter(s => s === "validator").length};
  // back to the surface: the underground groups are hidden, the surface budget again
  V.underground(false);
  V.update(T0 + 3000, 0.016, {x: -600, y: 30, z: 0});
  out.back = {draws: V.drawCalls(), stats: V.stats()};
  // riding: sounds for the focused train
  sounds.length = 0; calm = false;
  const tr = sim.trip("M1", "metro:0", "metro:2", T0); V.focus(tr.vehicle); V.underground(true);
  for(let t = tr.arrive - 8000; t < tr.depart + 60000; t += 250){ const P = tr.pose(t); avatar = {x: P.x, z: P.z, hy: P.y}; V.update(t, 0.25, {x: P.x, y: P.y + 1.5, z: P.z}); }
  out.sounds = {chime: sounds.filter(s => s === "door-chime").length, beep: sounds.filter(s => s === "screen").length, motor: sounds.filter(s => s === "motor").length,
                joint: sounds.filter(s => s === "rail-joint").length, rumble: sounds.filter(s => s === "tunnel-rumble").length};
  V.dispose();
  out.disposed = scene.children.length;
  console.log(JSON.stringify(out));
}).catch(e => { console.error(e && e.stack || e); process.exit(1); });
"""


def run_node(src, mod=False):
    args = [NODE] + (["--input-type=module"] if mod else []) + ["-e", src]
    r = subprocess.run(args, capture_output=True, text=True, timeout=300)
    if r.returncode:
        raise AssertionError(r.stderr[-4000:])
    return json.loads(r.stdout.strip().splitlines()[-1])


@unittest.skipUnless(NODE, "node not installed")
class MetroPure(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        extra = [p for p in (os.path.join(ROOT, "tests", "fixtures", n) for n in ("claude-hq@3.json.gz", "island@3.json.gz")) if os.path.exists(p)]
        cls.o = run_node(PURE % {"root": json.dumps(ROOT), "doc": json.dumps(metro_fixture()), "extra": json.dumps(extra)})
        cls.c = cls.o["consts"]

    def test_lines_and_stops(self):
        ls = {l["id"]: l for l in self.o["lines"]}
        self.assertEqual(sorted(ls), ["M1", "M2"])
        self.assertEqual(ls["M1"]["short"], "M1")
        self.assertEqual(ls["M1"]["headway"], 120)
        self.assertEqual(ls["M1"]["stops"], ["metro:0", "metro:1", "metro:2", "metro:3"])
        st = {s["id"]: s for s in self.o["stops"]}
        self.assertEqual(st["metro:1"]["name"], "Central", "the interchange is Central")
        self.assertEqual(sorted(st["metro:1"]["lines"]), ["M1", "M2"])
        self.assertTrue(all(s["under"] and s["mode"] == "metro" for s in st.values()))
        self.assertEqual(len({s["name"] for s in st.values()}), len(st), "names are unique")

    def test_headway_and_dwell(self):
        h = self.o["headway"]
        self.assertGreaterEqual(len(h), 6)
        for a, b in zip(h, h[1:]):
            self.assertEqual(b[0] - a[0], 120000)
        for arr, dep in h:
            self.assertEqual(dep - arr, 25000)

    def test_speed_and_acceleration_limits(self):
        lim = self.o["limits"]
        self.assertLessEqual(lim["maxV"], self.c["VMAX"] + 1e-9)
        self.assertGreater(lim["maxV"], self.c["VMAX"] - 0.5, "reaches top speed between far stations")
        self.assertLessEqual(lim["maxA"], self.c["ACC"] + 1e-6)
        self.assertEqual(lim["backwards"], 0, "a train never reverses during a run")

    def test_both_directions(self):
        d = self.o["limits"]["dirs"]
        for k in ("M1:1", "M1:-1", "M2:1", "M2:-1"):
            self.assertIn(k, d)
        self.assertTrue(self.o["mouth"]["M1depotAtStart"])
        self.assertFalse(self.o["mouth"]["M2depotAtStart"], "M2's depot is at the path's end")

    def test_no_two_trains_overlap_on_a_track(self):
        self.assertGreater(self.o["minGap"], self.c["TRAIN_L"] + 5)

    def test_under_flips_at_the_portal_mouth(self):
        fl = self.o["flips"]
        self.assertTrue(fl, "trains go in and out of the tunnels in 15 minutes")
        for f in fl:
            mouth = self.o["mouth"][f["line"]]
            self.assertLess(min(abs(f["s0"] - mouth), abs(f["s1"] - mouth)), 6, f)
            self.assertIn("portal", (f["kind0"], f["kind1"]))
        self.assertEqual({f["under"] for f in fl}, {0, 1}, "both ways: into the tunnel and out to the depot")

    def test_departures_ordering(self):
        for rows, n in ((self.o["depC"], 8), (self.o["dep0"], 6)):
            self.assertEqual(len(rows), n)
            ats = [r["at"] for r in rows]
            self.assertEqual(ats, sorted(ats))
            for r in rows:
                self.assertIn(r["short"], ("M1", "M2"))
                self.assertTrue(r["to"])
                self.assertEqual(r["delay"], 0)
                self.assertIn(r["plat"], ("1", "2", "3", "4"))
                self.assertEqual(r["boarding"], r["at"] <= self.o["T0"] < r["dep"])
        # Central has both lines both ways
        self.assertEqual({(r["line"], r["plat"]) for r in self.o["depC"]} >= {("M1", "1"), ("M1", "2"), ("M2", "3"), ("M2", "4")}, True)
        # the far terminus: only the trains going back (the out trains terminate there)
        self.assertTrue(self.o["depTerm"])
        self.assertEqual({r["plat"] for r in self.o["depTerm"]}, {"2"})
        self.assertEqual({r["to"] for r in self.o["depTerm"]}, {self.o["stops"][0]["name"]})

    def test_trip_and_seats(self):
        t = self.o["trip"]
        self.assertEqual([s["id"] for s in t["stops"]], ["metro:0", "metro:1", "metro:2"])
        self.assertEqual(t["depart"] - t["arrive"], 25000)
        self.assertGreater(t["reach"], t["depart"])
        self.assertEqual(t["seats"], 64)
        self.assertGreater(t["standing"], 0)
        for s in self.o["seatCheck"]:
            self.assertLess(abs(s["lat"]), 1.4, s)
            self.assertLess(abs(s["along"]), 9.5, s)
            if s["stand"]:
                self.assertAlmostEqual(s["dy"], 0, places=4)
            else:
                self.assertAlmostEqual(s["dy"], 0.45, places=4)
        self.assertEqual(sorted({s["car"] for s in self.o["seatCheck"]}), [0, 1, 2, 3])
        p = self.o["poseAtFrom"]
        st = self.o["stFrom"]
        self.assertEqual(p["speed"], 0)
        self.assertEqual(p["doors"], 1, "doors open while it stands")
        self.assertLess(math.hypot(p["x"] - st["x"], p["z"] - st["z"]), 4, "stands at the platform")
        self.assertAlmostEqual(p["y"], st["y"], places=3, msg="the floor is level with the platform")
        self.assertTrue(p["under"])
        self.assertTrue(self.o["poseDone"]["done"])
        self.assertEqual(self.o["pose"]["doors"], 0)
        # the door on the platform side: side platforms are on the right of travel (heading +x that is +z: z ~ 3.5 + 1.4)
        self.assertGreater(self.o["door"]["z"], 4.5)
        self.assertEqual(self.o["backTrip"]["stops"], ["metro:2", "metro:1", "metro:0"])
        self.assertIsNone(self.o["noTrip"])

    def test_walkable(self):
        w = self.o["walk"]
        self.assertAlmostEqual(w["platform"], w["platformY"], places=6)
        self.assertAlmostEqual(w["hall"], w["hallY"], places=6)
        self.assertIsNone(w["trackMid"], "between the tracks is not a floor")
        self.assertIsNone(w["track"], "the track is not a floor")
        self.assertIsNone(w["tunnel"], "the tunnel is not a floor")
        self.assertIsNone(w["far"])
        self.assertEqual(w["stair"]["kind"], "stairs")
        self.assertAlmostEqual(w["stair"]["y"], w["stair"]["mid"], places=4)
        self.assertIsNotNone(w["centralM1"])
        self.assertAlmostEqual(w["centralM2"]["got"], w["centralM2"]["want"], places=6, msg="M2 below M1 at Central")
        self.assertAlmostEqual(w["il"], -24, places=6, msg="the Island Link platform at railway depth")

    def test_is_under(self):
        u = self.o["under"]
        self.assertTrue(u["plat"]); self.assertTrue(u["tunnel"])
        self.assertFalse(u["street"]); self.assertFalse(u["far"]); self.assertFalse(u["deepNowhere"])

    def test_entrances_and_exits(self):
        e = self.o["ent"]
        self.assertEqual(e["at"]["id"], e["E"]["id"])
        self.assertEqual(e["at"]["station"], "metro:0")
        self.assertIsNone(e["none"])
        self.assertLess(e["at"]["foot"]["y"], e["E"]["y"] - 3, "the foot of the stairs is down in the hall")
        x = self.o["exit"]
        self.assertAlmostEqual(math.hypot(x["x"] - e["E"]["x"], x["z"] - e["E"]["z"]), 1.6, places=6)
        self.assertAlmostEqual(x["y"], e["E"]["y"], places=6)
        self.assertAlmostEqual(abs((x["yaw"] - e["E"]["yaw"] + math.pi) % (2*math.pi) - math.pi), math.pi, places=6, msg="facing away from the stairs")
        self.assertIsNone(self.o["exitRamp"], "the street side is outside the hole")
        self.assertEqual(x["id"], e["E"]["id"])
        self.assertNotEqual(self.o["exitAny"]["id"], None)
        r = self.o["rampMid"]
        self.assertEqual(r["station"], "metro:0")
        self.assertLess(r["y"], r["street"] - 2)
        self.assertEqual(self.o["station"]["id"], "metro:0")

    def test_segment_lod(self):
        for cam in self.o["lod"]:
            got = set(cam["got"])
            for n in cam["near"]:
                self.assertLessEqual(n, self.c["LOD_R"])
            for w in cam["want"]:
                if w["best"] <= 395:
                    self.assertIn(w["key"], got, "every tunnel chunk within 400 m is built")
            self.assertLessEqual(got, {w["key"] for w in cam["want"]}, "nothing further than 400 m (or not underground)")
        self.assertEqual(self.o["lod"][-1]["got"], [], "nothing near a far camera")
        self.assertTrue(self.o["lod"][0]["got"])

    def test_determinism(self):
        d = self.o["det"]
        self.assertTrue(d["same"]); self.assertTrue(d["sameDep"]); self.assertTrue(d["other"], "seeded by the world")

    def test_reads_world_metro_of(self):
        self.assertTrue(self.o["metroOf"]["deps"]); self.assertTrue(self.o["metroOf"]["stops"])

    def test_empty_world(self):
        e = self.o["empty"]
        self.assertEqual((e["lines"], e["stops"], e["v"], e["d"]), (0, 0, 0, 0))
        self.assertIsNone(e["t"])

    def test_real_fixtures_when_present(self):
        for f in self.o["fixtures"]:
            if not f["lines"]:
                continue
            self.assertGreater(f["stops"], 0, f)
            self.assertGreater(f["deps"], 0, f)
            if f["plat"] is not None:
                self.assertLess(f["plat"], 1e-6, f)


@unittest.skipUnless(NODE, "node not installed")
class MetroView(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.o = run_node(VIEW % {"root": json.dumps(ROOT), "doc": json.dumps(metro_fixture())})

    def test_surface_budget(self):
        s = self.o["surface"]
        self.assertLessEqual(s["stats"]["surfaceDraws"], 8, s)
        self.assertLessEqual(s["tris"], 60000*2, s)
        self.assertLessEqual(self.o["back"]["draws"], 8, self.o["back"])

    def test_tour_cameras_and_underground_budget(self):
        sh = self.o["shots"]
        for n in ("entrance", "portal", "depot", "hall", "platform", "tunnel-ride", "central-interchange", "train-interior"):
            self.assertIsNotNone(sh[n], n)
            if sh[n]["under"]:
                self.assertLessEqual(sh[n]["draws"], 120, (n, sh[n]))
                self.assertLessEqual(sh[n]["tris"], 400000, (n, sh[n]))
            else:
                self.assertLessEqual(sh[n]["draws"], 8, (n, sh[n]))
        for n in ("hall", "platform"):
            self.assertIsNotNone(sh[n]["walk"], n)
        c = self.o["central"]
        self.assertLessEqual(c["draws"], 120, c); self.assertLessEqual(c["tris"], 400000, c)
        self.assertGreater(c["chunks"], 0); self.assertEqual(c["stations"], 2, "Central and the M2 station 350 m south")

    def test_gate_beeps_for_the_walker(self):
        self.assertEqual(self.o["gate"]["beeps"], 1)

    def test_ride_sounds(self):
        s = self.o["sounds"]
        self.assertGreaterEqual(s["chime"], 1); self.assertGreaterEqual(s["beep"], 1)
        self.assertLessEqual(s["beep"], 8, "one double beep per train at the platform, not one per door")
        self.assertGreater(s["motor"], 0); self.assertGreater(s["joint"], 0); self.assertGreater(s["rumble"], 0)

    def test_dispose(self):
        self.assertEqual(self.o["disposed"], 0)


if __name__ == "__main__":
    unittest.main()
