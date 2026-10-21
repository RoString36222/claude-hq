// Reference generator for the Commons airfield fixture (docs/plans/airport-spec.md, section 3).
// node tools/airfield_fixture.js <repo root> tests/fixtures/airfield_commons.json   (reference for HQV.hqAirfield.layout)
const fs = require('fs'), zlib = require('zlib'), path = require('path'), R0 = process.argv[2];
global.window = {HQV: {}};
eval(fs.readFileSync(path.join(R0, 'games', 'world.js'), 'utf8'));
const WD = window.HQV.world;
const doc = f => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(R0, 'tests/fixtures', f + '.json.gz'))));
const W = WD.pack(doc('claude-hq@2')), site = W.sites.find(s => s.kind === 'airport');
const r3 = x => Math.round(x*1000)/1000;
const fl = Math.hypot(site.front[0], site.front[1]), F = [site.front[0]/fl, site.front[1]/fl], B = [-F[0], -F[1]], T = [B[1], -B[0]], O = [site.x/100, site.z/100];
const wp = (u, v) => [r3(O[0] + u*B[0] + v*T[0]), r3(O[1] + u*B[1] + v*T[1])];
const wd = (du, dv) => [r3(du*B[0] + dv*T[0]), r3(du*B[1] + dv*T[1])];
const yawOf = d => r3(Math.atan2(d[0], d[1]));
const rect = (u0, u1, v0, v1) => [wp(u0, v0), wp(u1, v0), wp(u1, v1), wp(u0, v1)];
// ---- the cross-section (frame metres), all relative to RU
// the airside rectangles (frame: u0, u1, v0, v1) for a runway centreline at u = RU (must match `air` below)
function airRects(RU){
  return [[RU - 241, RU - 129, -150, 150], [RU - 195, RU - 129, -245, -150], [RU - 180, RU - 129, 150, 245], [RU - 170, RU + 70, -860, 860],
          [RU - 215, RU - 170, -480, -360], [RU - 215, RU - 170, -340, -270], [RU - 215, RU - 170, 320, 470]];
}
// RU: the nearest runway (355..455 m out, 10 m steps) whose airside, grown by CLEAR m, touches no road, sidewalk, lot, block or
// other site inside the world, and whose platform (highest ground under it + 0.3, up to 0.1 m) is at most 0.5 m above the site
const CLEAR = 6;
function fits(RU){
  let hi = -1e9;
  for(const r of airRects(RU)){
    for(let u = r[0] - CLEAR; u <= r[1] + CLEAR + 1e-6; u += 2) for(let v = r[2] - CLEAR; v <= r[3] + CLEAR + 1e-6; v += 2){
      const p = wp(u, v), inner = u >= r[0] && u <= r[1] && v >= r[2] && v <= r[3];
      if(inner) hi = Math.max(hi, WD.heightAt(W, p[0], p[1]));
      if(Math.abs(p[0]) >= W.half - 2 || Math.abs(p[1]) >= W.half - 2) continue;
      const s = WD.surfaceAt(W, p[0], p[1]), st = WD.siteAt ? WD.siteAt(W, p[0], p[1]) : null;
      if(s === 'road' || s === 'sidewalk' || s === 'lot' || WD.blockedAt(W, p[0], p[1]) || (s === 'site' && !(st && st.id === site.id))) return null;
    }
  }
  const y = Math.max(Math.ceil((hi + 0.3)*10)/10, -4 + 1.5);
  return y <= site.y/100 + 0.5 ? y : null;
}
let RU0 = null; for(let ru = 355; ru <= 455 && RU0 == null; ru += 10) if(fits(ru) != null) RU0 = ru;
if(RU0 == null) throw new Error('no runway fits');
const RU = RU0, LEN = 1600, HALF = LEN/2, RW_W = 45, SH = 7.5, PAD = 60;
const UA = RU - 110, UB = RU - 152, U_HOLD = RU - 50, U_HOLDPT = U_HOLD - 19, U_STAND = RU - 193, U_NOSE = U_STAND - 19;
const U_CONC0 = RU - 241, U_CONC1 = RU - 223, U_SVC = RU - 218, U_LANE_N = RU - 175, U_LANE_S = RU - 168.5, GATE_FLOOR = 5.0, V_LINK = HALF + 15, R_TURN = 40, R_LEAD = 30, R_EXIT = 300, R_JOIN = 150;
// ---- fillets
function arc(c, r, a0, a1, out){ const n = Math.max(2, Math.ceil(Math.abs(a1 - a0)*r/2)); for(let i = 0; i <= n; i++){ const a = a0 + (a1 - a0)*i/n; out.push([c[0] + r*Math.cos(a), c[1] + r*Math.sin(a)]); } return out; }
// a fillet (frame coords) at corner P between incoming unit d1 and outgoing unit d2, radius R -> points from tangent-in to tangent-out
function fillet(P, d1, d2, R){
  const cr = d1[0]*d2[1] - d1[1]*d2[0], dot = d1[0]*d2[0] + d1[1]*d2[1], th = Math.atan2(Math.abs(cr), dot), t = R*Math.tan(th/2);
  const p0 = [P[0] - d1[0]*t, P[1] - d1[1]*t], s = cr > 0 ? 1 : -1, n1 = [-s*d1[1], s*d1[0]], c = [p0[0] + n1[0]*R, p0[1] + n1[1]*R];
  const a0 = Math.atan2(p0[1] - c[1], p0[0] - c[0]), p1 = [P[0] + d2[0]*t, P[1] + d2[1]*t], a1 = a0 + s*th;
  const pts = arc(c, R, a0, a1, []); pts[0] = p0; pts[pts.length - 1] = p1; return {pts, t};
}
const unitv = (a, b) => { const l = Math.hypot(b[0] - a[0], b[1] - a[1]); return [(b[0] - a[0])/l, (b[1] - a[1])/l]; };
const W2 = pts => pts.map(p => wp(p[0], p[1]));
// ---- design lines (straight centrelines), frame coords
const lines = {
  RWY: [[RU, -HALF], [RU, HALF]],
  A: [[UA, -V_LINK], [UA, V_LINK]],
  B: [[UB, -V_LINK], [UB, V_LINK]],
  A1: [[UB, -V_LINK], [RU, -V_LINK]],
  A6: [[UB, V_LINK], [RU, V_LINK]],
};
const tanE = Math.tan(30*Math.PI/180), dvE = (RU - UA)/tanE;
const exitDefs = [ // landing end, along from threshold, name
  {id: 'A4', end: '36', along: 1000}, {id: 'A5', end: '36', along: 1250}, {id: 'A3', end: '18', along: 1000}, {id: 'A2', end: '18', along: 1250}];
exitDefs.forEach(e => { const sg = e.end === '36' ? 1 : -1, v0 = sg*(-HALF + e.along); lines[e.id] = [[RU, v0], [UA, v0 + sg*dvE]]; e.v0 = v0; e.sg = sg; });
// ---- turn curves (each traversed both ways where used)
const curves = {};
function corner(id, P, from, to, R){ const f = fillet(P, from, to, R); curves[id] = f.pts; return f; }
[-1, 1].forEach(sg => { // sg -1: south end (A1), +1: north end (A6)
  const L = sg < 0 ? 'A1' : 'A6', vL = sg*V_LINK;
  corner(L + '/B', [UB, vL], [0, sg], [1, 0], R_TURN);          // B running to the end, onto the link toward the runway
  corner(L + '/A', [UA, vL], [0, sg], [-1, 0], R_TURN);         // A running to the end, onto the link toward B (arrivals)
  corner(L + '/RWY', [RU, vL], [1, 0], [0, -sg], R_TURN);        // the link onto the runway, lining up away from this end
});
exitDefs.forEach(e => {
  const d = unitv(lines[e.id][0], lines[e.id][1]);
  corner(e.id + '/RWY', [RU, e.v0], [0, e.sg], d, R_EXIT);
  corner(e.id + '/A', [UA, e.v0 + e.sg*dvE], d, [0, e.sg], R_JOIN);
});
// ---- stands
const stands = [];
for(let k = 1; k <= 6; k++) stands.push({id: String(k), kind: 'contact', v: -110 + 44*(k - 1), span: 36, len: 38, nose: 19.05});   // boxes inside v ±132: a vehicle lane at v ±141
[[21, -172], [22, -198], [23, -224]].forEach(s => stands.push({id: String(s[0]), kind: 'commuter', v: s[1], span: 16, len: 16, nose: 8}));
stands.forEach(s => {
  const u = s.kind === 'contact' ? U_STAND : RU - 183;               // commuters: nose stop at RU - 191 (inside the apron's south notch)
  s.u = u;
  ['36', '18'].forEach(end => {
    // the lead-in (36: from B southbound; 18: northbound) and the same arc pushed back for departures the same way
    const sg = end === '36' ? -1 : 1, P = [UB, s.v];
    const f = fillet(P, [0, sg], [-1, 0], R_LEAD);
    const pts = f.pts.concat([[u, s.v]]);
    curves['S' + s.id + '/' + end] = pts;
  });
});
// ---- ends, their furniture
function endOf(id){
  const sg = id === '36' ? 1 : -1, thr = [RU, -sg*HALF], left = id === '36' ? [-1, 0] : [1, 0];   // frame: left of +v is -u
  const at = (a, b) => [thr[0] + left[0]*b, thr[1] + sg*a];
  const papi = [0, 1, 2, 3].map(i => wp(...at(300, RW_W/2 + 15 + 9*i)));
  const appr = []; for(let a = 30; a <= 420; a += 30) appr.push(wp(...at(-a, 0)));
  return {id, thr: wp(...thr), dir: wd(0, sg), left: wd(...left), yaw: yawOf(wd(0, sg)), len: LEN,
    lineup: wp(RU, -sg*(V_LINK - R_TURN)), hold: wp(U_HOLDPT, -sg*V_LINK), holdLine: [wp(U_HOLD, -sg*V_LINK - 12.5), wp(U_HOLD, -sg*V_LINK + 12.5)],
    touchdown: 330, aim: 310, exits: exitDefs.filter(e => e.end === id).map(e => ({id: e.id, along: e.along}))
      .concat([{id: id === '36' ? 'A6' : 'A1', along: LEN + 15}]),
    papi, glideslope: wp(...at(320, -(RW_W/2 + 37.5))), localizer: wp(RU, sg*(HALF + 100)), windsock: wp(...at(150, RW_W/2 + 40)),
    approach: appr, crossbar: 300, pad: [wp(RU, -sg*HALF), wp(RU, -sg*(HALF + PAD))]};
}
// ---- footprints (polygons, world), heights
const air = {
  apron: [rect(U_CONC0, RU - 129, -150, 150), rect(RU - 195, RU - 129, -245, -150), rect(RU - 180, RU - 129, 150, 245)],
  main: [rect(RU - 170, RU + 70, -HALF - PAD, HALF + PAD)],
  service: {fuel: rect(RU - 215, RU - 170, -480, -360), fire: rect(RU - 215, RU - 170, -340, -270), hangars: rect(RU - 215, RU - 170, 320, 470), depot: rect(RU - 180, RU - 170, 150, 245)},
};
function sampleMax(poly){ let xs = poly.map(p => p[0]), zs = poly.map(p => p[1]), hi = -1e9, bad = [];
  for(let x = Math.min(...xs); x <= Math.max(...xs); x += 3) for(let z = Math.min(...zs); z <= Math.max(...zs); z += 3){
    if(!inPoly(poly, x, z)) continue; hi = Math.max(hi, WD.heightAt(W, x, z));
    if(Math.abs(x) < W.half - 2 && Math.abs(z) < W.half - 2){ const s = WD.surfaceAt(W, x, z); if(s === 'road' || s === 'sidewalk' || s === 'lot') bad.push([r3(x), r3(z), s]); } }
  return {hi, bad}; }
function inPoly(P, x, z){ let c = false; for(let i = 0, j = P.length - 1; i < P.length; j = i++){ const a = P[i], b = P[j]; if((a[1] > z) !== (b[1] > z) && x < (b[0] - a[0])*(z - a[1])/(b[1] - a[1]) + a[0]) c = !c; } return c; }
const polys = air.apron.concat(air.main, Object.values(air.service));
let hi = -1e9; polys.forEach(p => { const r = sampleMax(p); hi = Math.max(hi, r.hi); if(r.bad.length) console.error('ROAD in footprint', JSON.stringify(r.bad.slice(0, 4))); });
const Y = r3(Math.max(Math.ceil((hi + 0.3)*10)/10, -4 + 1.5));
const out = {
  v: 1, ok: true, world: W.id, site: site.id, frame: {o: O, B: wd(1, 0), T: wd(0, 1), RU}, y: Y, ySite: site.y/100, sea: -4,
  runway: {c: wp(RU, 0), dir: wd(0, 1), len: LEN, w: RW_W, shoulder: SH, pad: PAD, ends: [endOf('36'), endOf('18')]},
  lines: Object.fromEntries(Object.entries(lines).map(([k, v]) => [k, W2(v)])),
  widths: {RWY: RW_W, A: 18, B: 18, A1: 18, A6: 18, A2: 18, A3: 18, A4: 18, A5: 18, shoulder: 3.5},
  curves: Object.fromEntries(Object.entries(curves).map(([k, v]) => [k, W2(v)])),
  stands: stands.map(s => ({id: s.id, kind: s.kind, x: wp(s.u, s.v)[0], z: wp(s.u, s.v)[1], yaw: yawOf(wd(-1, 0)), span: s.span, len: s.len,
    nose: wp(s.u - s.nose, s.v), stop: [wp(s.u - s.nose, s.v - 3), wp(s.u - s.nose, s.v + 3)], box: rect(s.u - s.nose - 3, s.u - s.nose + s.len + 3, s.v - s.span/2 - 4, s.v + s.span/2 + 4),
    lead: {'36': 'S' + s.id + '/36', '18': 'S' + s.id + '/18'}})),
  apron: air.apron, platform: air.apron.concat(air.main, Object.values(air.service)), service: air.service,
  concourse: rect(U_CONC0, U_CONC1, -150, 150),
  // the apron service road (6 m, on the platform, outside every stand box): head-of-stand along the concourse (rotunda
  // columns at u = concourse face + 1.2 stay clear of it), round the stand row at v ±141, north into the depot, south
  // along the commuter stands' tails (between their boxes and B's shoulder)
  serviceRoad: W2([[U_LANE_S, -240], [U_LANE_S, -141], [U_SVC, -141], [U_SVC, 141], [U_LANE_N, 141], [U_LANE_N, 240]]), serviceRoadW: 6,
  landside: {
    terminal: rect(-66, 66, -18, 18), canopy: rect(-80, -66, -19.5, 19.5), skybridge: {a: wp(66, 0), b: wp(U_CONC0, 0), w: 8, floor: GATE_FLOOR},
    forecourt: W2([[-88, -62], [-88, 62], [-120, 62], [-120, -62], [-88, -62]]), access: W2([[-146, -8], [-120, -8]]), roadW: 8,
    curb: {dropoff: W2([[-88, -20], [-88, 20]]), taxi: W2([[-88, 24], [-88, 56]]), bus: W2([[-88, -56], [-88, -24]])},
    carpark: rect(-60, -4, 30, 86), carparkBridge: W2([[-40, 18], [-40, 30]]),
    tower: {x: wp(95, -100)[0], z: wp(95, -100)[1], h: 66}, asr: {x: wp(110, 110)[0], z: wp(110, 110)[1], h: 25},
  },
  keepOut: {capsule: {a: wp(RU, -HALF - 420), b: wp(RU, HALF + 420), r: 180}, corridors: [{a: wp(RU, -HALF), b: wp(RU, -HALF - 4000), r: 250}, {a: wp(RU, HALF), b: wp(RU, HALF + 4000), r: 250}]},
};
fs.writeFileSync(process.argv[3], JSON.stringify(out));
console.log('y', Y, 'hi', r3(hi), 'stands', out.stands.length, 'curves', Object.keys(out.curves).length, 'bytes', fs.statSync(process.argv[3]).size);
console.log('thr36', out.runway.ends[0].thr, 'thr18', out.runway.ends[1].thr, 'stand1', out.stands[0].x, out.stands[0].z, out.stands[0].yaw);
