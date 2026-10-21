"""games/hqairfield.js: the airfield layout, its ends, the runway in use and the timetable, run under node.

docs/plans/airport-spec.md sections 3, 7.1-7.3, 10 and 11 (T1). tests/fixtures/airfield_commons.json is the reference."""
import json
import math
import os
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")
SCRIPT = r"""
const fs = require('fs'), zlib = require('zlib'), path = require('path'), R0 = process.argv[1];
global.window = {HQV: {}};
for(const f of ['world', 'hqairfield']) eval(fs.readFileSync(path.join(R0, 'games', f + '.js'), 'utf8'));
const WD = window.HQV.world, AF = window.HQV.hqAirfield;
const doc = f => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(R0, 'tests/fixtures', f + '.json.gz'))));
const FX = JSON.parse(fs.readFileSync(path.join(R0, 'tests/fixtures/airfield_commons.json'), 'utf8'));
const Wc = WD.pack(doc('claude-hq@2'));
const out = {};
const hyp = (x, z) => Math.hypot(x, z), DEG = Math.PI/180;
const angDiff = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
const head = (a, b) => Math.atan2(b[0] - a[0], b[1] - a[1]);
function inPoly(P, x, z){ let c = false; for(let i = 0, j = P.length - 1; i < P.length; j = i++){ const a = P[i], b = P[j]; if((a[1] > z) !== (b[1] > z) && x < (b[0] - a[0])*(z - a[1])/(b[1] - a[1]) + a[0]) c = !c; } return c; }
function segD(a, b, x, z){ const dx = b[0] - a[0], dz = b[1] - a[1], l = dx*dx + dz*dz; let t = l ? ((x - a[0])*dx + (z - a[1])*dz)/l : 0; t = Math.max(0, Math.min(1, t)); return hyp(x - a[0] - dx*t, z - a[1] - dz*t); }
function plD(P, x, z){ let d = 1e9; for(let i = 1; i < P.length; i++) d = Math.min(d, segD(P[i - 1], P[i], x, z)); return d; }
// the largest numeric difference between two JSON trees (Infinity when their shapes differ)
function diff(a, b, at, worst){
  if(typeof a === 'number' && typeof b === 'number'){ const d = Math.abs(a - b); if(d > worst.d) { worst.d = d; worst.at = at; } return; }
  if(Array.isArray(a) !== Array.isArray(b) || typeof a !== typeof b){ worst.d = Infinity; worst.at = at; return; }
  if(a && typeof a === 'object'){
    const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
    if(JSON.stringify(ka) !== JSON.stringify(kb)){ worst.d = Infinity; worst.at = at + ' keys'; return; }
    ka.forEach(k => diff(a[k], b[k], at + '.' + k, worst)); return;
  }
  if(a !== b){ worst.d = Infinity; worst.at = at; }
}

// ---- layout
const L = AF.layout(Wc), worst = {d: 0, at: ''};
diff(L, FX, 'L', worst);
out.layout = {ok: L.ok, worst: worst.d === Infinity ? 'shape@' + worst.at : worst.d, at: worst.at, exact: JSON.stringify(L) === JSON.stringify(FX),
              again: JSON.stringify(AF.layout(Wc)) === JSON.stringify(L)};
const noAir = [];
for(const id of ['claude-hq@1', 'island@2']){
  let r; try { r = AF.layout(WD.pack(doc(id))); } catch(e){ r = {threw: String(e)}; }
  noAir.push({id, ok: r.ok, why: typeof r.why, threw: r.threw || null});
}
let rn; try { rn = AF.layout(null); } catch(e){ rn = {threw: String(e)}; }
noAir.push({id: 'null', ok: rn.ok, why: typeof rn.why, threw: rn.threw || null});
out.noAir = noAir;

// ---- frame round trip
const fr = AF.toFrame(FX, -1015, 123), bk = AF.toWorld(FX, fr[0], fr[1]);
out.frame = {u: fr[0], v: fr[1], back: [bk[0], bk[1]]};

// ---- curves: each endpoint touches one of its two lines, tangent to it (tangent from the circle through 3 samples)
function circleTan(p0, p1, p2){
  const ax = p0[0], az = p0[1], bx = p1[0], bz = p1[1], cx = p2[0], cz = p2[1], d = 2*(ax*(bz - cz) + bx*(cz - az) + cx*(az - bz));
  if(Math.abs(d) < 1e-9) return head(p0, p1);
  const ux = ((ax*ax + az*az)*(bz - cz) + (bx*bx + bz*bz)*(cz - az) + (cx*cx + cz*cz)*(az - bz))/d;
  const uz = ((ax*ax + az*az)*(cx - bx) + (bx*bx + bz*bz)*(ax - cx) + (cx*cx + cz*cz)*(bx - ax))/d;
  const r = [p0[0] - ux, p0[1] - uz], t = [-r[1], r[0]], f = [p1[0] - p0[0], p1[1] - p0[1]];
  return t[0]*f[0] + t[1]*f[1] >= 0 ? Math.atan2(t[0], t[1]) : Math.atan2(-t[0], -t[1]);
}
function lineInfo(P){ return {a: P[0], b: P[1], h: head(P[0], P[1])}; }
function touches(l, p, h){
  const d = segD(l.a, l.b, p[0], p[1]) , dLine = Math.abs((p[0] - l.a[0])*Math.cos(l.h) - (p[1] - l.a[1])*Math.sin(l.h));
  const tang = Math.min(angDiff(h, l.h), angDiff(h, l.h + Math.PI));
  return {d: Math.max(d, dLine), tang: tang/DEG};
}
const curveBad = [], tanMax = {d: 0, deg: 0};
for(const [id, C] of Object.entries(FX.curves)){
  const parts = id.split('/'); let la, lb;
  if(parts[0][0] === 'S'){
    const st = FX.stands.find(s => 'S' + s.id === parts[0]);
    la = lineInfo(FX.lines.B); lb = lineInfo([[FX.lines.B[0][0], st.z], [st.x, st.z]]);
    // the arc ends where the straight to the stand begins: check the arc's end tangent there
    const arcEnd = C[C.length - 2], h1 = circleTan(C[C.length - 2], C[C.length - 3], C[C.length - 4]) + Math.PI;
    const t1 = touches(lb, arcEnd, h1), t2 = touches(lb, C[C.length - 1], head(C[C.length - 2], C[C.length - 1]));
    [t1, t2].forEach(t => { tanMax.d = Math.max(tanMax.d, t.d); tanMax.deg = Math.max(tanMax.deg, t.tang); if(t.d > 0.05 || t.tang > 1) curveBad.push([id, 'end', t]); });
    const t0 = touches(la, C[0], circleTan(C[0], C[1], C[2]));
    tanMax.d = Math.max(tanMax.d, t0.d); tanMax.deg = Math.max(tanMax.deg, t0.tang);
    if(t0.d > 0.05 || t0.tang > 1) curveBad.push([id, 'start', t0]);
    if(Math.max(...C.slice(1, -1).map((p, i) => hyp(p[0] - C[i][0], p[1] - C[i][1]))) > 2.01) curveBad.push([id, 'arc step > 2 m']);
    continue;
  }
  la = lineInfo(FX.lines[parts[0]]); lb = lineInfo(FX.lines[parts[1]]);
  const h0 = circleTan(C[0], C[1], C[2]), n = C.length, h1 = circleTan(C[n - 1], C[n - 2], C[n - 3]) + Math.PI;
  const s = [touches(la, C[0], h0), touches(lb, C[0], h0)], e = [touches(la, C[n - 1], h1), touches(lb, C[n - 1], h1)];
  const ok = (t) => t.d <= 0.05 && t.tang <= 1;
  if(!((ok(s[0]) && ok(e[1])) || (ok(s[1]) && ok(e[0])))) curveBad.push([id, s, e]);
  [s[0], s[1], e[0], e[1]].filter(ok).forEach(t => { tanMax.d = Math.max(tanMax.d, t.d); tanMax.deg = Math.max(tanMax.deg, t.tang); });
  for(let i = 1; i < n; i++) if(hyp(C[i][0] - C[i - 1][0], C[i][1] - C[i - 1][1]) > 2.01) { curveBad.push([id, 'step > 2 m', i]); break; }
}
out.curves = {n: Object.keys(FX.curves).length, bad: curveBad, tanMax};

// ---- ends: every stand x both ends, jets and amphibians
const JET = (64*64 - 15*15)/(2*2.6), AMPH = (38*38 - 15*15)/(2*2.2);
const ownBox = (st, p) => inPoly(st.box, p[0], p[1]);
const endBad = [], exits = {}, lineEnds = [], kinks = {};
let maxStep = 0, maxGap = 0, nPts = 0;
for(const st of FX.stands) for(const ei of [0, 1]) for(const [cls, sd] of [['jet', JET], ['amph', AMPH]]){
  const cx = 1000, cz = -2000, e = AF.end(FX, st.id, ei, cx, cz, {stopDist: sd}), E = FX.runway.ends[ei], tag = st.id + '/' + E.id + '/' + cls;
  if(!e){ endBad.push([tag, 'null']); continue; }
  if(e.v !== 2 || e.kind !== 'jet' || e.y !== FX.y || e.site !== FX.site) endBad.push([tag, 'header']);
  if(Math.abs(e.stand.x - st.x - cx) > 1e-9 || Math.abs(e.stand.z - st.z - cz) > 1e-9 || e.stand.yaw !== st.yaw) endBad.push([tag, 'stand']);
  const parts = [['push', e.dep.push], ['taxi', e.dep.taxi], ['line', e.dep.line], ['exit', e.arr.exit], ['atax', e.arr.taxi]];
  for(const [nm, P] of parts){
    if(!P.length){ endBad.push([tag, nm, 'empty']); continue; }
    for(let i = 1; i < P.length; i++){ const d = hyp(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]); maxStep = Math.max(maxStep, d); if(d > 5 + 1e-9) endBad.push([tag, nm, 'step', d]); }
    for(const p of P){
      nPts++;
      const x = p[0] - cx, z = p[1] - cz, s = AF.onPavement(FX, x, z);
      if(!(s === 'runway' || s === 'taxiway' || s === 'apron' || (s === 'road' && AF.floorAt(FX, x, z) != null)) && !ownBox(st, [x, z])) endBad.push([tag, nm, 'off pavement', [x, z], s]);
    }
    // heading changes > 10 degrees between consecutive steps (kinks), counted per piece
    for(let i = 2; i < P.length; i++){ const a = angDiff(head(P[i - 2], P[i - 1]), head(P[i - 1], P[i]))/DEG; if(a > 10) kinks[nm] = Math.max(kinks[nm] || 0, a); }
  }
  // continuity between the pieces
  const gaps = [[e.dep.push, e.dep.taxi], [e.dep.taxi, e.dep.line], [e.arr.exit, e.arr.taxi]];
  for(const [a, b] of gaps){ const p = a[a.length - 1], q = b[0], d = hyp(p[0] - q[0], p[1] - q[1]); maxGap = Math.max(maxGap, d); if(d > 0.5) endBad.push([tag, 'gap', d]); }
  // push starts at the stand; arrival taxi ends at it; dep.taxi ends at the hold point
  const S = [st.x + cx, st.z + cz], sp = e.dep.push[0], ae = e.arr.taxi[e.arr.taxi.length - 1], tE = e.dep.taxi[e.dep.taxi.length - 1];
  if(hyp(sp[0] - S[0], sp[1] - S[1]) > 0.05 || hyp(ae[0] - S[0], ae[1] - S[1]) > 0.05) endBad.push([tag, 'stand ends']);
  if(hyp(tE[0] - E.hold[0] - cx, tE[1] - E.hold[1] - cz) > 0.05) endBad.push([tag, 'hold']);
  // dep.line ends at E.lineup heading E.dir; push ends on B heading against the flow (tail first)
  const Ln = e.dep.line, le = Ln[Ln.length - 1], lh = head(Ln[Ln.length - 2], le);
  lineEnds.push({d: hyp(le[0] - E.lineup[0] - cx, le[1] - E.lineup[1] - cz), deg: angDiff(lh, Math.atan2(E.dir[0], E.dir[1]))/DEG});
  if(Math.abs(e.dep.len - (E.len - 25)) > 1e-6 || e.dep.dir[0] !== E.dir[0] || e.dep.dir[1] !== E.dir[1]) endBad.push([tag, 'dep dir/len', e.dep.len]);
  const pe = e.dep.push, pushHead = head(pe[pe.length - 2], pe[pe.length - 1]), flowHead = Math.atan2(0, ei === 0 ? -1 : 1);
  if(angDiff(pushHead + Math.PI, flowHead)/DEG > 2.5) endBad.push([tag, 'push heading', pushHead]);
  // arrival: thr, dir, td, the exit starts on the centreline at exitAt
  const x0 = e.arr.exit[0], along = (x0[0] - cx - E.thr[0])*E.dir[0] + (x0[1] - cz - E.thr[1])*E.dir[1];
  const off = Math.abs((x0[0] - cx - E.thr[0])*E.dir[1] - (x0[1] - cz - E.thr[1])*E.dir[0]);
  if(Math.abs(along - e.arr.exitAt) > 0.05 || off > 0.05) endBad.push([tag, 'exit start', along, off]);
  if(e.arr.td !== E.touchdown || e.arr.thr[0] !== E.thr[0] + cx || e.arr.dir[1] !== E.dir[1]) endBad.push([tag, 'arr header']);
  exits[E.id + '/' + cls] = exits[E.id + '/' + cls] || {};
  exits[E.id + '/' + cls][e.arr.exitId] = Math.round(e.arr.exitAt*10)/10;
}
const eFar = AF.end(FX, '3', 0, 0, 0, {stopDist: 5000}), eDef = AF.end(FX, '3', 1, 0, 0);
out.ends = {bad: endBad.slice(0, 20), nBad: endBad.length, maxStep, maxGap, nPts, exits, lineEnds: {d: Math.max(...lineEnds.map(l => l.d)), deg: Math.max(...lineEnds.map(l => l.deg))},
            far: {id: eFar.arr.exitId, at: eFar.arr.exitAt}, dflt: {id: eDef.arr.exitId, at: Math.round(eDef.arr.exitAt*10)/10}, kinks,
            nulls: [AF.end(FX, '99', 0, 0, 0), AF.end(FX, '3', 5, 0, 0), AF.end({ok: false}, '3', 0, 0, 0), AF.end(null, '3', 0)]};

// ---- the service road at its full width: on the platform, outside every stand box, off taxiway/runway pavement and shoulders
const SR = FX.serviceRoad, hw = FX.serviceRoadW/2, srBad = [];
let srN = 0, srDepth = 0;
for(let i = 1; i < SR.length; i++){
  const a = SR[i - 1], b = SR[i], l = hyp(b[0] - a[0], b[1] - a[1]), d = [(b[0] - a[0])/l, (b[1] - a[1])/l], n = [-d[1], d[0]];
  for(let s = -hw; s <= l + hw + 1e-9; s += 1) for(let w = -hw; w <= hw + 1e-9; w += 0.5){
    const x = a[0] + d[0]*s + n[0]*w, z = a[1] + d[1]*s + n[1]*w; srN++;
    const pv = AF.onPavement(FX, x, z), sh = AF.shoulderAt(FX, x, z);
    if(AF.floorAt(FX, x, z) == null) srBad.push(['off platform', x, z]);
    if(pv === 'runway' || pv === 'taxiway' || sh) srBad.push(['on ' + (pv || sh), x, z]);
    for(const st of FX.stands) if(inPoly(st.box, x, z)){
      // how deep into the box (the box is an axis-aligned rectangle in the site frame)
      const q = AF.toFrame(FX, x, z), bq = st.box.map(c => AF.toFrame(FX, c[0], c[1])), us = bq.map(c => c[0]), vs = bq.map(c => c[1]);
      const depth = Math.min(q[0] - Math.min(...us), Math.max(...us) - q[0], q[1] - Math.min(...vs), Math.max(...vs) - q[1]);
      srDepth = Math.max(srDepth, depth);
      if(depth > 0.05 + 1e-6) srBad.push(['stand box ' + st.id, x, z, depth]);
    }
  }
}
out.serviceRoad = {n: srN, bad: srBad.slice(0, 10), nBad: srBad.length, boxDepth: srDepth};

// ---- stand boxes inside the platform
const boxBad = [];
for(const st of FX.stands){
  const xs = st.box.map(p => p[0]), zs = st.box.map(p => p[1]);
  for(let x = Math.min(...xs); x <= Math.max(...xs) + 1e-9; x += 1) for(let z = Math.min(...zs); z <= Math.max(...zs) + 1e-9; z += 1)
    if(AF.floorAt(FX, x, z) == null) boxBad.push([st.id, x, z]);
}
out.boxes = {bad: boxBad.slice(0, 10), nBad: boxBad.length};

// ---- landside footprints vs roads, lots, blocks and other sites (2 m samples on claude-hq@2)
const ls = FX.landside, lsBad = [], lsHits = {};
const fps = {terminal: {poly: ls.terminal}, canopy: {poly: ls.canopy}, carpark: {poly: ls.carpark}, carparkBridge: {line: ls.carparkBridge, hw: 2},
             forecourt: {line: ls.forecourt, hw: ls.roadW/2}, access: {line: ls.access, hw: ls.roadW/2},
             skybridge: {line: [ls.skybridge.a, ls.skybridge.b], hw: ls.skybridge.w/2}, tower: {c: [ls.tower.x, ls.tower.z], r: 8}, asr: {c: [ls.asr.x, ls.asr.z], r: 5}};
for(const [k, f] of Object.entries(fps)){
  const pts = f.poly || f.line || [[f.c[0] - f.r, f.c[1] - f.r], [f.c[0] + f.r, f.c[1] + f.r]], m = f.hw || 0;
  const xs = pts.map(p => p[0]), zs = pts.map(p => p[1]);
  for(let x = Math.min(...xs) - m; x <= Math.max(...xs) + m + 1e-6; x += 2) for(let z = Math.min(...zs) - m; z <= Math.max(...zs) + m + 1e-6; z += 2){
    const inside = f.poly ? inPoly(f.poly, x, z) || plD(f.poly.concat([f.poly[0]]), x, z) < 1e-6 : f.line ? plD(f.line, x, z) <= f.hw : hyp(x - f.c[0], z - f.c[1]) <= f.r;
    if(!inside) continue;
    const s = WD.surfaceAt(Wc, x, z), st = WD.siteAt(Wc, x, z), blk = WD.blockedAt(Wc, x, z), u = AF.toFrame(FX, x, z)[0];
    const contact = s === 'road' || s === 'sidewalk' || s === 'lot' || blk || (s === 'site' && !(st && st.id === FX.site));
    if(!contact) continue;
    const joint = k === 'access' && hyp(x - ls.access[0][0], z - ls.access[0][1]) <= ls.roadW && (s === 'road' || s === 'sidewalk') && !blk;
    const span = k === 'skybridge' && u >= 125 && u <= 155 && (s === 'road' || s === 'sidewalk') && !blk;
    lsHits[k + (joint ? ':joint' : span ? ':span' : '')] = (lsHits[k + (joint ? ':joint' : span ? ':span' : '')] || 0) + 1;
    if(!joint && !span) lsBad.push([k, x, z, s, blk]);
  }
}
out.landside = {bad: lsBad.slice(0, 10), nBad: lsBad.length, hits: lsHits};

// ---- floorAt
const y = FX.y, fa = (x, z) => AF.floorAt(FX, x, z), E0 = FX.runway.ends[0], E1 = FX.runway.ends[1];
out.floor = {
  platform: [fa(...FX.runway.c), fa(FX.stands[0].x, FX.stands[0].z), fa(...E0.pad[1]), fa(...E1.pad[1]), fa((FX.service.fuel[0][0] + FX.service.fuel[2][0])/2, (FX.service.fuel[0][1] + FX.service.fuel[2][1])/2)],
  piers: E0.approach.concat(E1.approach).map(p => fa(p[0], p[1])).concat([fa(E0.approach[5][0] + 1.4, E0.approach[5][1]), fa(...E0.localizer), fa(E0.localizer[0] + 16, E0.localizer[1] + 4)]),
  sea: [fa(-1200, 0), fa(-1100, 0), fa(E0.approach[5][0] + 2, E0.approach[5][1]), fa(-1015, -1260), fa(-1015, 1300), fa(-1015 + 30, -1100)],
  inland: [fa(0, 0), fa(-300, 50), fa(-620, 0), fa(-700, 300)], y,
  bad: [fa(NaN, 0), AF.floorAt(null, -1015, 0), AF.floorAt({ok: false}, -1015, 0)]
};
out.pave = {rw: AF.onPavement(FX, -1015, 0), pad: AF.onPavement(FX, -1015, -850), rwShoulder: AF.onPavement(FX, -1015 + 25, 0), rwSh: AF.shoulderAt(FX, -1015 + 25, 0),
            A: AF.onPavement(FX, -905, 0), Ash: AF.shoulderAt(FX, -905 + 10.5, 0), B: AF.onPavement(FX, -863, 500), road: AF.onPavement(FX, -797, 0),
            apron: AF.onPavement(FX, FX.stands[2].x, FX.stands[2].z), access: AF.onPavement(FX, -490, -8), sea: AF.onPavement(FX, -1200, 0), inland: AF.onPavement(FX, 0, 0),
            exitCurve: AF.onPavement(FX, ...FX.curves['A4/RWY'][79]), grass: AF.onPavement(FX, -1015 + 70, 300)};

// ---- periods and the runway in use
const world = 'claude-hq@2', P = AF.PERIOD*1000, S = AF.SLOT*1000, G = AF.GAP*1000;
let prevail = 0, constBad = 0, changes = 0, changeOff = 0;
const pre = AF.hash(world + '|wind') % 2, b0 = AF.slotBase(world, 0);
for(let p = -500; p < 500; p++){
  const s0 = b0 + p*P, e = AF.runwayEnd(world, s0);
  if(e === pre) prevail++;
  for(const f of [0.001, 0.25, 0.5, 0.79, 0.81, 0.999]) if(AF.runwayEnd(world, s0 + f*P) !== e) constBad++;
  if(AF.runwayEnd(world, s0 - 1) !== e){ changes++; }
}
// changes happen exactly at period starts: scan 10 periods at 10 s and check every change sits on a boundary
let prevE = AF.runwayEnd(world, b0);
for(let t = b0; t < b0 + 10*P; t += 10000){ const e = AF.runwayEnd(world, t); if(e !== prevE){ if((t - b0) % P !== 0) changeOff++; prevE = e; } }
const w1 = AF.windAt(world, b0 + 123456, FX), w2 = AF.windAt(world, b0 + 123456, FX), w3 = AF.windAt(world, b0 + 123456);
const winds = []; for(let i = 0; i < 400; i++){ const t = b0 + i*311000, w = AF.windAt(world, t, FX); winds.push({sp: w.speed, dev: angDiff(w.yaw, FX.runway.ends[w.end].yaw + Math.PI), endOk: w.end === AF.runwayEnd(world, t)}); }
out.runway = {prevail, constBad, changes, changeOff, det: AF.runwayEnd(world, 1e12) === AF.runwayEnd(world, 1e12) && AF.runwayEnd(world, 1e12) === AF.runwayEnd('claude-hq@2', 1e12),
              wind: {same: JSON.stringify(w1) === JSON.stringify(w2), noL: Math.abs(w1.yaw - w3.yaw) < 0.002, spMin: Math.min(...winds.map(w => w.sp)), spMax: Math.max(...winds.map(w => w.sp)),
                     devMax: Math.max(...winds.map(w => w.dev)), endOk: winds.every(w => w.endOk)}};

// ---- slots and the timetable
const rt = [];
for(let m = -100; m <= 100; m++){ const b = AF.slotBase(world, m); if(AF.slotAt(world, b) !== m || AF.slotAt(world, b + S - 1) !== m) rt.push(m); }
const steps = new Set(); for(let m = -40; m < 40; m++) steps.add(AF.slotBase(world, m + 1) - AF.slotBase(world, m));
const dests = ['user:b@2', 'user:a@2', 'user:c@2'], sorted = dests.slice().sort();
const from = AF.slotBase(world, -60), to = AF.slotBase(world, 260);
const tt = AF.timetable(world, dests, from, to), tt2 = AF.timetable(world, dests.slice().reverse(), from, to);
const ttBad = [];
const bySlot = {};
for(const mv of tt){
  for(const k of ['id', 'type', 'cls', 'stand', 'end', 'tRunway', 'slot', 'period', 'airframe', 'airline', 'reg', 'far']) if(mv[k] == null) ttBad.push([mv.id, 'missing ' + k]);
  const base = AF.slotBase(world, mv.slot), off = mv.tRunway - base, pIn = (mv.tRunway - (AF.slotBase(world, mv.period*8))) ;
  (bySlot[mv.slot] = bySlot[mv.slot] || []).push(off);
  if(pIn >= 8*S) ttBad.push([mv.id, 'in a gap']);
  if(mv.period !== Math.floor(mv.slot/8)) ttBad.push([mv.id, 'period']);
  if(mv.end !== AF.runwayEnd(world, base)) ttBad.push([mv.id, 'end']);
  if(!/^HQ-[A-Z]{3}$/.test(mv.reg)) ttBad.push([mv.id, 'reg']);
  if(mv.cls === 'jet' && !(AF.AIRWAYS.indexOf(mv.far) >= 0 && AF.AIRLINES.indexOf(mv.airline) >= 0)) ttBad.push([mv.id, 'jet far/airline']);
  if(mv.cls === 'commuter'){
    const N = sorted.length, want = mv.type === 'dep' ? sorted[((mv.slot % N) + N) % N] : sorted[(((mv.slot + 1) % N) + N) % N];
    if(mv.far !== want || mv.airline !== AF.COMMUTER) ttBad.push([mv.id, 'commuter far']);
  }
  const want = {'jet:arr': 0, 'commuter:dep': 60000, 'jet:dep': 120000, 'commuter:arr': 180000}[mv.cls + ':' + mv.type];
  if(off !== want) ttBad.push([mv.id, 'offset', off]);
}
const offs = Object.values(bySlot).filter(o => o.length === 4).every(o => JSON.stringify(o.slice().sort((a, b) => a - b)) === '[0,60000,120000,180000]');
// stand reuse: every airframe arrives and leaves at one stand; one airframe per stand at a time (6 contact, 3 commuter)
const stays = {}, occBad = [];
for(const mv of tt){ const s = stays[mv.airframe] = stays[mv.airframe] || {}; s[mv.type] = mv; }
const perStand = {};
for(const [af, s] of Object.entries(stays)){
  if(s.arr && s.dep && s.arr.stand !== s.dep.stand) occBad.push([af, 'stand changes', s.arr.stand, s.dep.stand]);
  if(s.arr && s.dep && !(s.dep.tRunway > s.arr.tRunway)) occBad.push([af, 'leaves before it lands']);
  const st = (s.arr || s.dep).stand;
  (perStand[st] = perStand[st] || []).push([s.arr ? s.arr.tRunway : -Infinity, s.dep ? s.dep.tRunway : Infinity, af]);
}
for(const [st, iv] of Object.entries(perStand)){
  iv.sort((a, b) => a[0] - b[0]);
  for(let i = 1; i < iv.length; i++) if(iv[i][0] <= iv[i - 1][1]) occBad.push([st, 'double-booked', iv[i - 1][2], iv[i][2]]);
}
const standsUsed = Object.keys(perStand).sort((a, b) => a - b);
const none = AF.timetable(world, [], from, to);
out.tt = {n: tt.length, same: JSON.stringify(tt) === JSON.stringify(AF.timetable(world, dests, from, to)), orderFree: JSON.stringify(tt) === JSON.stringify(tt2),
          bad: ttBad.slice(0, 10), nBad: ttBad.length, offs, occBad: occBad.slice(0, 10), standsUsed, rt, steps: Array.from(steps).sort((a, b) => a - b),
          noCommuters: none.every(m => m.cls === 'jet') && none.length > 0, sorted: tt.every((m, i) => !i || tt[i - 1].tRunway <= m.tRunway),
          negSlots: tt.some(m => m.slot < 0), empty: [AF.timetable(world, dests, 10, 5).length, AF.timetable(world, dests, NaN, 5).length],
          consts: [AF.SLOT, AF.PERIOD, AF.GAP], T0ok: AF.slotBase(world, 0) === AF.hash(world + '|slots') % 2400000,
          hash: [AF.hash(''), AF.hash('a'), AF.hash('claude-hq@2|slots')]};
process.stdout.write(JSON.stringify(out));
"""


@unittest.skipUnless(NODE, "node not installed")
class TestHqAirfield(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        r = subprocess.run([NODE, "-e", SCRIPT, ROOT], capture_output=True, text=True, timeout=300)
        if r.returncode != 0:
            raise AssertionError("node failed: " + r.stderr[-3000:])
        cls.o = json.loads(r.stdout)

    def test_layout_reproduces_the_fixture(self):
        lay = self.o["layout"]
        self.assertTrue(lay["ok"])
        self.assertIsInstance(lay["worst"], (int, float), lay)
        self.assertLessEqual(lay["worst"], 0.01, lay)
        self.assertTrue(lay["again"], "layout() must be deterministic")

    def test_no_airport_site_is_not_ok(self):
        for r in self.o["noAir"]:
            self.assertIsNone(r["threw"], r)
            self.assertIs(r["ok"], False, r)
            self.assertEqual(r["why"], "string", r)

    def test_frame(self):
        f = self.o["frame"]
        self.assertAlmostEqual(f["u"], 395, places=6)      # world x = -620 - u, z = v on the Commons
        self.assertAlmostEqual(f["v"], 123, places=6)
        self.assertAlmostEqual(f["back"][0], -1015, places=6)
        self.assertAlmostEqual(f["back"][1], 123, places=6)

    def test_curves_are_tangent_to_their_lines(self):
        c = self.o["curves"]
        self.assertEqual(c["n"], 32)
        self.assertEqual(c["bad"], [])
        self.assertLessEqual(c["tanMax"]["d"], 0.05)
        self.assertLessEqual(c["tanMax"]["deg"], 1.0)

    def test_ends_are_continuous_and_on_pavement(self):
        e = self.o["ends"]
        self.assertEqual(e["nBad"], 0, e["bad"])
        self.assertLessEqual(e["maxStep"], 5.0 + 1e-9)
        self.assertLessEqual(e["maxGap"], 0.5)
        self.assertGreater(e["nPts"], 5000)
        self.assertEqual(e["nulls"], [None, None, None, None])

    def test_heading_kinks(self):
        # A and B are 42 m apart but A?/A and A?/B are R 40 fillets that overlap; arrivals off A take uturns(L), one
        # R 21 arc tangent to A, the link and B, so no ground path kinks anywhere (> 10 deg between 5 m steps).
        k = self.o["ends"]["kinks"]
        self.assertEqual(k, {}, k)

    def test_line_up_is_exact(self):
        le = self.o["ends"]["lineEnds"]
        self.assertLessEqual(le["d"], 0.05)
        self.assertLessEqual(le["deg"], 1.0)

    def test_exit_choice(self):
        # curve starts 919.6 (A4/A3) and 1169.6 (A5/A2): jets need 330 + 744 -> A5/A2, amphibians 330 + 277 -> A4/A3
        ex = self.o["ends"]["exits"]
        self.assertEqual(ex["36/jet"], {"A5": 1169.6})
        self.assertEqual(ex["18/jet"], {"A2": 1169.6})
        self.assertEqual(ex["36/amph"], {"A4": 919.6})
        self.assertEqual(ex["18/amph"], {"A3": 919.6})
        self.assertEqual(self.o["ends"]["dflt"], {"id": "A2", "at": 1169.6})     # no stopDist: the jet's
        self.assertEqual(self.o["ends"]["far"]["id"], "A6")                       # nothing fits: the far-end link
        self.assertAlmostEqual(self.o["ends"]["far"]["at"], 1575, places=3)

    def test_service_road(self):
        s = self.o["serviceRoad"]
        self.assertGreater(s["n"], 1000)
        self.assertEqual(s["nBad"], 0, s["bad"])
        # KNOWN FIXTURE DEFECT (reported, the fixture is read-only): the road's apron-side edge is at u = RU - 215 = 180 and the
        # contact stand boxes start at u = RU - 193 - 19.05 - 3 = 179.95, so the road's edge runs 5 cm into boxes 1..6.
        # Tolerated here at exactly that depth; anything deeper fails.
        self.assertLessEqual(s["boxDepth"], 0.05 + 1e-6)

    def test_stand_boxes_on_the_platform(self):
        self.assertEqual(self.o["boxes"]["nBad"], 0, self.o["boxes"]["bad"])

    def test_landside_footprints_are_clear(self):
        ls = self.o["landside"]
        self.assertEqual(ls["nBad"], 0, ls["bad"])
        # the two intended contacts exist (so the sampling really reaches the street and the ring road)
        self.assertGreater(ls["hits"].get("access:joint", 0), 0, ls["hits"])
        self.assertGreater(ls["hits"].get("skybridge:span", 0), 0, ls["hits"])

    def test_floor(self):
        f = self.o["floor"]
        y = f["y"]
        self.assertEqual(f["platform"], [y]*5)
        self.assertEqual(f["piers"], [y]*len(f["piers"]))
        self.assertEqual(f["sea"], [None]*len(f["sea"]))
        self.assertEqual(f["inland"], [None]*len(f["inland"]))
        self.assertEqual(f["bad"], [None, None, None])

    def test_pavement_kinds(self):
        p = self.o["pave"]
        self.assertEqual(p["rw"], "runway")
        self.assertEqual(p["pad"], "runway")
        self.assertIsNone(p["rwShoulder"])
        self.assertEqual(p["rwSh"], "runway")
        self.assertEqual(p["A"], "taxiway")
        self.assertEqual(p["Ash"], "taxiway")
        self.assertEqual(p["B"], "taxiway")
        self.assertEqual(p["road"], "road")
        self.assertEqual(p["apron"], "apron")
        self.assertEqual(p["access"], "road")
        self.assertEqual(p["exitCurve"], "taxiway")
        self.assertIsNone(p["sea"])
        self.assertIsNone(p["inland"])
        self.assertIsNone(p["grass"])

    def test_runway_in_use(self):
        r = self.o["runway"]
        self.assertTrue(r["det"])
        self.assertTrue(600 <= r["prevail"] <= 800, r["prevail"])       # about 70% prevailing over 1000 periods
        self.assertEqual(r["constBad"], 0)                               # constant within a period, the gap included
        self.assertGreater(r["changes"], 50)
        self.assertEqual(r["changeOff"], 0)                              # changes only at period boundaries
        w = r["wind"]
        self.assertTrue(w["same"] and w["noL"] and w["endOk"], w)
        self.assertGreaterEqual(w["spMin"], 3)
        self.assertLessEqual(w["spMax"], 12)
        self.assertLessEqual(w["devMax"], 0.35 + 1e-9)

    def test_slots(self):
        t = self.o["tt"]
        self.assertEqual(t["consts"], [240, 2400, 480])
        self.assertTrue(t["T0ok"])
        self.assertEqual(t["rt"], [])                                    # slotBase/slotAt round trip, negative m too
        self.assertEqual(t["steps"], [240000, 720000])                   # 240 s apart, plus the 480 s gap after each 8th
        self.assertEqual(t["hash"], [2166136261, 3826002220, t["hash"][2]])

    def test_timetable(self):
        t = self.o["tt"]
        self.assertGreater(t["n"], 1000)
        self.assertTrue(t["same"], "deterministic")
        self.assertTrue(t["orderFree"], "dests are sorted inside")
        self.assertTrue(t["sorted"])
        self.assertTrue(t["negSlots"])
        self.assertEqual(t["nBad"], 0, t["bad"])
        self.assertTrue(t["offs"], "movements 60 s apart within a slot")
        self.assertTrue(t["noCommuters"])
        self.assertEqual(t["empty"], [0, 0])

    def test_stand_reuse_never_double_books(self):
        t = self.o["tt"]
        self.assertEqual(t["occBad"], [])
        self.assertEqual(t["standsUsed"], ["1", "2", "3", "4", "5", "6", "21", "22", "23"])


if __name__ == "__main__":
    unittest.main()
