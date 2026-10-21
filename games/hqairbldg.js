/* Claude HQ: the airport's airside and landside buildings (HQV.hqAirbldg), drawn from the airfield layout L
 * (docs/plans/airport-spec.md, sections 3 and 5; L is HQV.hqAirfield.layout(), fixture tests/fixtures/airfield_commons.json).
 *
 * The civic terminal on the site is games/hqcivic.js (BUILD.airport). Everything else is here: the skybridge over
 * Ring Road 5, the concourse with its gate-level gallery, six jet bridges, the control tower with its beacon, the
 * approach radar, the fire station, two hangars, the fuel farm, the ground-support depot and the multi-storey car
 * park with its cars and the taxis at the curb.
 *
 *   plan(L) -> P (pure: no THREE, no DOM), or null when L has no airfield:
 *     {floors, blocks, gates: {standId: {x, y, z, yaw}}, bridges: [{stand, rot: [x, z], y0, ext, ret, legTop}],
 *      hangarStand: {x, y, z, yaw}, tower, asr, zones, props, gate (gate-level floor y), ...}
 *   floorAt(P, x, z, yRef) -> the walkable height of the terminal nave (door, ramp, mezzanine), the skybridge or the
 *     concourse gallery under (x, z), or null (the caller uses the ground). Off the nave, a floor counts only when
 *     yRef >= floor - 1.5, so walking Ring Road 5 under the skybridge stays on the road.
 *   blockedAt(P, x, z, y) -> true when a wall, glass facade or prop at that level stands at (x, z).
 *   roofAt(P, x, z) -> the top of whatever stands at (x, z) (roofs, the tower, the hangars), or null: the helicopter's floor.
 *   gateSpot(P, standId) -> {x, y, z, yaw}: in the gallery at the glass facing the stand; commuter stands (bus
 *     boarding): the gallery's south end, a few metres in from its end wall, facing up the gallery. null for an unknown stand.
 *   bridgePose(b, k) -> the pose of jet bridge b at extension k (0 retracted .. 1 at the door): {yaw, len, y1, cabYaw,
 *     E, door: [x, y, z] (cab door sill), bogie: [x, z], pitch}.
 *   create(c, L, o) -> {g, plan, setBridge(id, k, snap), setBoard(lines), setNight(n), setDetail(level),
 *     update(dt, t, motion), bridgeDoor(id), stats(), dispose()} or null without an airfield.
 *     c: the hq3d ctx (THREE, mat, emis, canvasTex, rng, hashStr, short). o: {night}.
 *     Static parts merge per material (HQV.hqMerge); the jet bridges are 5 InstancedMeshes for all six, the cars
 *     one InstancedMesh, and every night light here is one Points cloud. setDetail(2|1|0) only toggles visibility
 *     (2: everything; 1: one merged far mesh per material, the parked cars and the lights; 0: the lights at night).
 *   NAVE: the terminal nave's ramp and mezzanine, shared with HQV.hqCivic.AIRPORT_NAVE (tests/test_hqairbldg.py
 *     checks they match).
 * tests/test_hqairbldg.py runs it under node against the vendored three.js.
 */
(function(){
"use strict";
var HQV = window.HQV = window.HQV || {};

var PI = Math.PI;
// The nave of the civic terminal (site frame u, metres): a walk-through hall |v| <= halfW; flat from the door to
// u = ramp0, a ramp up to the gate level at u = ramp1, then a mezzanine to u = mez1 where the skybridge starts.
// y0/y1 are above the site's y. Must equal HQV.hqCivic.AIRPORT_NAVE.
var NAVE = {halfW: 6, ramp0: 0, ramp1: 56, mez1: 66, y0: 0.12, y1: 5.0};
var ROOF = 12;              // concourse roof (m above the gate level's site y) at its crown, about
var SAW = 1.5;              // floorAt: a floor above you counts within this much (m)
// jet bridges (m)
var DRUM_OUT = 1.2;         // the rotunda column stands this far out of the concourse's apron face
var DRUM_BACK = 12;         // ... and this far toward -v of its stand
var DRUM_R = 1.8, COL_R = 0.6;
var CAB_D = 3.2, CAB_W = 3.2, CAB_H = 3.0;
var TUN_IN = {from: 0.8, len: 9.5, w: 2.6, h: 2.9};
var TUN_OUT = {into: 0.3, len: 8.5, w: 2.95, h: 3.25};
var RET_LEN = 12;           // retracted: drum centre to cab centre, along the facade toward +v
var BOGIE_BACK = 4.5;       // the bogie stands this far behind the cab centre, under the outer tunnel
var BOGIE_R = 0.6;          // its footprint radius (leg and wheels)
var RATE = 0.6;             // 1/s: bridge easing
var DOOR = [1.95, 2.5, 14.6];   // hqaircraft's forward left door: model x (left), sill y, z
var NIGHT_PX = 5;

/* ---------- the site frame ---------- */
function frameOf(L){
  var f = (L && L.frame) || {}, B = f.B || [-1, 0], o = f.o || [0, 0];
  return {o: [+o[0] || 0, +o[1] || 0], B: [+B[0] || 0, +B[1] || 0], T: [+B[1] || 0, -(+B[0] || 0)]};
}
function toW(F, u, v){ return [F.o[0] + u*F.B[0] + v*F.T[0], F.o[1] + u*F.B[1] + v*F.T[1]]; }
function toF(F, x, z){ var dx = x - F.o[0], dz = z - F.o[1]; return [dx*F.B[0] + dz*F.B[1], dx*F.T[0] + dz*F.T[1]]; }
function yawOf(dx, dz){ return Math.atan2(dx, dz); }
function dirW(F, du, dv){ return [du*F.B[0] + dv*F.T[0], du*F.B[1] + dv*F.T[1]]; }
function rectOf(F, poly){
  var r = {u0: Infinity, u1: -Infinity, v0: Infinity, v1: -Infinity};
  (poly || []).forEach(function(p){ var q = toF(F, p[0], p[1]); r.u0 = Math.min(r.u0, q[0]); r.u1 = Math.max(r.u1, q[0]); r.v0 = Math.min(r.v0, q[1]); r.v1 = Math.max(r.v1, q[1]); });
  ["u0", "u1", "v0", "v1"].forEach(function(k){ r[k] = Math.round(r[k]*1000)/1000; });
  return r;
}
function angDiff(a, b){ var d = a - b; return Math.atan2(Math.sin(d), Math.cos(d)); }
function clamp01(k){ k = +k; return k > 0 ? (k < 1 ? k : 1) : 0; }

/* ---------- the plan (pure) ---------- */
function plan(L){
  if(!L || L.ok === false || !L.frame || !L.landside || !L.concourse || !L.stands) return null;
  var F = frameOf(L), ys = +L.ySite || 0, Ly = L.y != null ? +L.y : ys, S = L.landside;
  var sb = S.skybridge || {}, GATE = ys + (sb.floor != null ? +sb.floor : 5);
  var term = rectOf(F, S.terminal), conc = rectOf(F, L.concourse);
  var sa = toF(F, sb.a[0], sb.a[1]), sbb = toF(F, sb.b[0], sb.b[1]), sw = +sb.w || 8;
  var P = {v: 1, F: F, ys: ys, Ly: Ly, gate: GATE, term: term, conc: conc,
    sky: {u0: Math.min(sa[0], sbb[0]), u1: Math.max(sa[0], sbb[0]), v: (sa[1] + sbb[1])/2, w: sw, roof: GATE + 4.5},
    floors: [], blocks: [], gates: {}, bridges: [], props: {seats: [], desks: [], signs: []}, zones: {}};
  var hs = sw/2;
  // ---- walkable floors (frame rects); the nave first (it has no yRef condition: it starts at the ground)
  P.floors.push({id: "nave", u0: term.u0, u1: term.u1, v0: -NAVE.halfW, v1: NAVE.halfW, free: true,
    ramp: {u0: NAVE.ramp0, u1: NAVE.ramp1, y0: ys + NAVE.y0, y1: ys + NAVE.y1}});
  P.floors.push({id: "skybridge", u0: term.u1, u1: conc.u0 + 1, v0: P.sky.v - hs + 0.3, v1: P.sky.v + hs - 0.3, y: GATE});
  P.floors.push({id: "gallery", u0: conc.u0 + 1, u1: conc.u1 - 1, v0: conc.v0 + 2, v1: conc.v1 - 2, y: GATE});
  // ---- blocks: {u0, u1, v0, v1, y0, y1, zone} or {c: [u, v], r, y0, y1, zone}
  function blk(zone, u0, u1, v0, v1, y0, y1){ P.blocks.push({zone: zone, u0: Math.min(u0, u1), u1: Math.max(u0, u1), v0: Math.min(v0, v1), v1: Math.max(v0, v1), y0: y0, y1: y1}); }
  function circ(zone, u, v, r, y0, y1){ P.blocks.push({zone: zone, c: [u, v], r: r, y0: y0, y1: y1}); }
  var top = GATE + 7;
  blk("concourse", conc.u0, conc.u1, conc.v0, conc.v1, Ly - 1, GATE - 0.1);                    // the ops floor
  blk("concourse", conc.u0, conc.u0 + 1, conc.v0, P.sky.v - hs, GATE, top);                   // landside wall
  blk("concourse", conc.u0, conc.u0 + 1, P.sky.v + hs, conc.v1, GATE, top);
  blk("concourse", conc.u1 - 1, conc.u1, conc.v0, conc.v1, GATE, top);                          // the apron glass
  blk("concourse", conc.u0, conc.u1, conc.v0, conc.v0 + 2, GATE, top);                          // its ends
  blk("concourse", conc.u0, conc.u1, conc.v1 - 2, conc.v1, GATE, top);
  blk("skybridge", P.sky.u0, conc.u0 + 1, P.sky.v - hs - 0.1, P.sky.v - hs + 0.3, GATE, P.sky.roof);   // its glass sides
  blk("skybridge", P.sky.u0, conc.u0 + 1, P.sky.v + hs - 0.3, P.sky.v + hs + 0.1, GATE, P.sky.roof);
  blk("terminal", term.u1 - 0.3, term.u1 + 0.3, P.sky.v + hs - 0.3, NAVE.halfW + 0.5, GATE - 0.5, GATE + 9);   // the nave's back wall at the mezzanine
  blk("terminal", term.u1 - 0.3, term.u1 + 0.3, -NAVE.halfW - 0.5, P.sky.v - hs + 0.3, GATE - 0.5, GATE + 9);
  P.piers = [];
  [P.sky.u0 + (P.sky.u1 - P.sky.u0)*((125 - 66)/88), P.sky.u1 - 2].forEach(function(u){
    [-2.5, 2.5].forEach(function(dv){ P.piers.push([u, P.sky.v + dv]); circ("skybridge", u, P.sky.v + dv, 0.45, ys - 3, GATE - 0.45); });
  });
  // ---- gallery props: seats and gate desks per contact stand, the commuter lounge at the south end
  var contact = L.stands.filter(function(s){ return s.kind === "contact"; }), commuter = L.stands.filter(function(s){ return s.kind === "commuter"; });
  function seat(v0, v1){
    [[3, 4.2], [5.4, 6.6]].forEach(function(r){ var p = {u0: conc.u0 + r[0], u1: conc.u0 + r[1], v0: v0, v1: v1, y0: GATE, y1: GATE + 0.9}; P.props.seats.push(p); blk("concourse", p.u0, p.u1, p.v0, p.v1, p.y0, p.y1); });
  }
  contact.forEach(function(s){
    var vk = toF(F, s.x, s.z)[1];
    seat(vk - 8, vk + 8);
    var d = {u0: conc.u0 + 7, u1: conc.u0 + 8.6, v0: vk + 10, v1: vk + 13, y0: GATE, y1: GATE + 1.1}; P.props.desks.push(d); blk("concourse", d.u0, d.u1, d.v0, d.v1, d.y0, d.y1);
    P.props.signs.push({id: s.id, u: conc.u0 + 9.5, v: vk});
  });
  if(commuter.length) seat(conc.v0 + 8, conc.v0 + 18);
  // ---- gate spots
  var face = yawOf(F.B[0], F.B[1]);
  contact.forEach(function(s){
    var vk = toF(F, s.x, s.z)[1], p = toW(F, conc.u1 - 1.6, vk);        // close to the glass: the nose and bridge under the VDGS
    P.gates[s.id] = {x: p[0], y: GATE, z: p[1], yaw: face};
  });
  if(commuter.length){
    var cu = 0, cv = 0;
    commuter.forEach(function(s){ var q = toF(F, s.x, s.z); cu += q[0]/commuter.length; cv += q[1]/commuter.length; });
    // clear of the end wall and its sign, facing up the gallery (stepping off an Isle Hopper you look along it)
    var su = conc.u1 - 6, sv = conc.v0 + 8, p = toW(F, su, sv), d = dirW(F, 0, 1);
    commuter.forEach(function(s){ P.gates[s.id] = {x: p[0], y: GATE, z: p[1], yaw: yawOf(d[0], d[1])}; });
  }
  // ---- jet bridges, one per contact stand
  contact.forEach(function(s){
    var vk = toF(F, s.x, s.z)[1], rot = toW(F, conc.u1 + DRUM_OUT, vk - DRUM_BACK);
    var fwd = [Math.sin(s.yaw), Math.cos(s.yaw)], left = [Math.cos(s.yaw), -Math.sin(s.yaw)];
    var door = [s.x + DOOR[2]*fwd[0] + DOOR[0]*left[0], s.z + DOOR[2]*fwd[1] + DOOR[0]*left[1]], dy = Ly + DOOR[1];
    var n = [-left[0], -left[1]], E = [door[0] - n[0]*CAB_D/2, door[1] - n[1]*CAB_D/2];
    var len = Math.hypot(E[0] - rot[0], E[1] - rot[1]);
    var ext = {yaw: yawOf(E[0] - rot[0], E[1] - rot[1]), len: len, y1: dy, cabYaw: yawOf(n[0], n[1])};
    // retracted along the facade toward +v, the cab low enough that the bogie's leg (fixed) still meets the tunnel
    var fb = GATE - (GATE - dy)*(len - BOGIE_BACK)/len;
    var ty = dirW(F, 0, 1);
    var ret = {yaw: yawOf(ty[0], ty[1]), len: RET_LEN, y1: GATE - (GATE - fb)*RET_LEN/(RET_LEN - BOGIE_BACK), cabYaw: face};
    P.bridges.push({stand: s.id, rot: rot, y0: GATE, ext: ext, ret: ret, legTop: fb - 0.25 - Ly, door: [door[0], dy, door[1]]});
  });
  // ---- landside: the tower, the radar
  var tw = S.tower || {x: 0, z: 0, h: 66}, as = S.asr || {x: 0, z: 0, h: 25}, tf = toF(F, tw.x, tw.z), af = toF(F, as.x, as.z);
  P.tower = {x: tw.x, z: tw.z, u: tf[0], v: tf[1], y: ys, h: +tw.h || 66, top: ys + (+tw.h || 66), antennaTop: ys + (+tw.h || 66) + 4};
  var aw = toW(F, tf[0] + 2.4, tf[1]); P.tower.antenna = aw;
  P.asr = {x: as.x, z: as.z, u: af[0], v: af[1], y: ys, h: +as.h || 25, rate: 1.26};
  blk("tower", tf[0] - 7, tf[0] + 7, tf[1] - 7, tf[1] + 7, ys - 1, ys + 66); blk("asr", af[0] - 4, af[0] + 4, af[1] - 4, af[1] + 4, ys - 1, ys + 25);
  // ---- zones (frame rects / circles / capsules): what each part must stay inside
  var Z = P.zones, sv = L.service || {};
  Z.concourse = conc; Z.skybridge = {a: [P.sky.u0, P.sky.v], b: [P.sky.u1, P.sky.v], r: hs + 0.5};
  Z.tower = {c: [tf[0], tf[1]], r: 15}; Z.asr = {c: [af[0], af[1]], r: 15};
  ["fire", "fuel", "hangars", "depot"].forEach(function(k){ if(sv[k]) Z[k] = rectOf(F, sv[k]); });
  Z.carpark = rectOf(F, S.carpark);
  if(S.carparkBridge){ var b0 = toF(F, S.carparkBridge[0][0], S.carparkBridge[0][1]), b1 = toF(F, S.carparkBridge[1][0], S.carparkBridge[1][1]); Z.footbridge = {a: b0, b: b1, r: 2.5}; }
  // ---- the fire station, hangars, fuel farm, depot, car park (frame rects inside their zones)
  if(Z.fire){ var fz = Z.fire;
    P.fire = {hall: {u0: fz.u0 + 8, u1: fz.u0 + 26, v0: fz.v0 + 3, v1: fz.v0 + 40}, office: {u0: fz.u0 + 12, u1: fz.u0 + 26, v0: fz.v0 + 40, v1: fz.v0 + 54},
              tower: {u0: fz.u0 + 10, u1: fz.u0 + 13.5, v0: fz.v0 + 56, v1: fz.v0 + 59.5}, bays: 5, door: 6};
    [P.fire.hall, P.fire.office, P.fire.tower].forEach(function(r){ blk("fire", r.u0, r.u1, r.v0, r.v1, Ly - 1, Ly + 30); });
  }
  if(Z.hangars){ var hz = Z.hangars, hu1 = hz.u1 - 1;
    // the open one's doors slide into pockets beside its walls (60/6 m each side): keep them inside the zone
    P.hangars = [{u0: hz.u0, u1: hu1, v0: hz.v0 + 2, v1: hz.v0 + 62, open: false}, {u0: hz.u0, u1: hu1, v0: hz.v1 - 74, v1: hz.v1 - 14, open: true}];
    P.hangars.forEach(function(h){
      if(!h.open){ blk("hangars", h.u0, h.u1, h.v0, h.v1, Ly - 1, Ly + 22); return; }
      blk("hangars", h.u0, h.u0 + 0.6, h.v0, h.v1, Ly - 1, Ly + 22);
      blk("hangars", h.u0, h.u1, h.v0, h.v0 + 0.6, Ly - 1, Ly + 22); blk("hangars", h.u0, h.u1, h.v1 - 0.6, h.v1, Ly - 1, Ly + 22);
    });
    var H = P.hangars[1], hp = toW(F, H.u0 + 22, (H.v0 + H.v1)/2);
    P.hangarStand = {x: hp[0], y: Ly, z: hp[1], yaw: face};
  } else P.hangarStand = null;
  if(Z.fuel){ var uz = Z.fuel, tc = [uz.u0 + 11.5, uz.u0 + 33.5], vb = uz.v0 + 2;
    P.fuel = {tanks: [[tc[0], vb + 21], [tc[1], vb + 21], [tc[0], vb + 42], [tc[1], vb + 42]], r: 9, h: 12,
              bund: {u0: uz.u0 + 1, u1: uz.u1 - 1, v0: vb + 9, v1: vb + 54.5}, office: {u0: uz.u1 - 15, u1: uz.u1 - 3, v0: uz.v1 - 18, v1: uz.v1 - 6},
              rack: {u: uz.u0 + 6, v0: vb + 55, v1: uz.v1 - 2}};
    blk("fuel", P.fuel.bund.u0, P.fuel.bund.u1, P.fuel.bund.v0, P.fuel.bund.v1, Ly - 1, Ly + 13);
    blk("fuel", P.fuel.office.u0, P.fuel.office.u1, P.fuel.office.v0, P.fuel.office.v1, Ly - 1, Ly + 4.5);
  }
  if(Z.depot){ var dz = Z.depot;
    P.depot = {shed: {u0: dz.u0 + 0.5, u1: dz.u1 - 0.5, v0: dz.v1 - 4.4, v1: dz.v1 - 0.4}, bays: {u0: dz.u0 + 0.5, u1: dz.u1 - 0.5, v0: dz.v1 - 49, v1: dz.v1 - 7}};
    blk("depot", P.depot.shed.u0, P.depot.shed.u1, P.depot.shed.v0, P.depot.shed.v1, Ly - 1, Ly + 4.5);
  }
  var cp = Z.carpark;
  P.carpark = {u0: cp.u0, u1: cp.u1, v0: cp.v0, v1: cp.v1, levels: [ys, ys + 3.2, ys + 6.4, ys + 9.6], ramp: {u0: cp.u1 - 5, u1: cp.u1 - 0.6}};
  blk("carpark", cp.u0, cp.u1, cp.v0, cp.v1, ys - 1, ys + 12.5);
  return P;
}

function floorY(f, u){
  if(!f.ramp) return f.y;
  var r = f.ramp;
  if(u <= r.u0) return r.y0;
  if(u >= r.u1) return r.y1;
  return r.y0 + (r.y1 - r.y0)*(u - r.u0)/(r.u1 - r.u0);
}
function floorAt(P, x, z, yRef){
  if(!P || !P.floors) return null;
  var q = toF(P.F, +x || 0, +z || 0), u = q[0], v = q[1];
  for(var i = 0; i < P.floors.length; i++){
    var f = P.floors[i];
    if(u < f.u0 || u > f.u1 || v < f.v0 || v > f.v1) continue;
    var y = floorY(f, u);
    if(f.free || yRef == null || +yRef >= y - SAW) return y;
  }
  return null;
}
function inBlock(b, u, v){
  if(b.c) return Math.hypot(u - b.c[0], v - b.c[1]) <= b.r;
  return u >= b.u0 && u <= b.u1 && v >= b.v0 && v <= b.v1;
}
function blockedAt(P, x, z, y){
  if(!P || !P.blocks) return false;
  var q = toF(P.F, +x || 0, +z || 0), yy = y != null && isFinite(+y) ? +y : P.ys;
  for(var i = 0; i < P.blocks.length; i++){
    var b = P.blocks[i];
    if(b.y0 < yy + 1.6 && b.y1 > yy + 0.4 && inBlock(b, q[0], q[1])) return true;
  }
  return false;
}
// the top of whatever stands at (x, z): a wall's or a building's roof, the concourse's and skybridge's roofs, the
// hangars, the tower's cab; null over open ground. What a helicopter lands on or runs into.
function roofAt(P, x, z){
  if(!P || !P.blocks) return null;
  var q = toF(P.F, +x || 0, +z || 0), u = q[0], v = q[1], y = null, i;
  function up(h){ if(y == null || h > y) y = h; }
  for(i = 0; i < P.blocks.length; i++) if(inBlock(P.blocks[i], u, v)) up(P.blocks[i].y1);
  var C = P.conc, S = P.sky;
  if(C && u >= C.u0 && u <= C.u1 && v >= C.v0 && v <= C.v1) up(P.gate + ROOF - 4.4);
  if(S && u >= S.u0 && u <= S.u1 && Math.abs(v - S.v) <= S.w/2 + 0.2) up(S.roof + 0.3);
  (P.hangars || []).forEach(function(h){ if(u >= h.u0 && u <= h.u1 && v >= h.v0 && v <= h.v1) up(P.Ly + 22); });
  return y;
}
function gateSpot(P, id){
  var g = P && P.gates && P.gates[String(id)];
  return g ? {x: g.x, y: g.y, z: g.z, yaw: g.yaw} : null;
}
function bridgePose(b, k){
  k = clamp01(k);
  var r = b.ret, e = b.ext;
  var yaw = r.yaw + angDiff(e.yaw, r.yaw)*k, len = r.len + (e.len - r.len)*k, y1 = r.y1 + (e.y1 - r.y1)*k, cy = r.cabYaw + angDiff(e.cabYaw, r.cabYaw)*k;
  var dx = Math.sin(yaw), dz = Math.cos(yaw), E = [b.rot[0] + dx*len, b.rot[1] + dz*len], nx = Math.sin(cy), nz = Math.cos(cy);
  return {yaw: yaw, len: len, y1: y1, cabYaw: cy, E: E, door: [E[0] + nx*CAB_D/2, y1, E[1] + nz*CAB_D/2],
          bogie: [b.rot[0] + dx*(len - BOGIE_BACK), b.rot[1] + dz*(len - BOGIE_BACK)], pitch: Math.atan2(b.y0 - y1, len)};
}
// the cab's footprint (world xz, 4 corners) at pose p
function cabBox(p){
  var nx = Math.sin(p.cabYaw), nz = Math.cos(p.cabYaw), tx = nz, tz = -nx, c = [p.door[0] - nx*CAB_D/2, p.door[2] - nz*CAB_D/2];
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(function(s){ return [c[0] + s[0]*tx*CAB_W/2 + s[1]*nx*CAB_D/2, c[1] + s[0]*tz*CAB_W/2 + s[1]*nz*CAB_D/2]; });
}

/* ---------- drawing ---------- */
// vertex-coloured parts in one geometry: [{geo, col, m (Matrix4, optional)}]
function vgeo(THREE, parts){
  var pos = [], nor = [], col = [], c = new THREE.Color();
  parts.forEach(function(p){
    var g = p.geo.index ? p.geo.toNonIndexed() : p.geo.clone();
    if(p.m) g.applyMatrix4(p.m);
    if(!g.attributes.normal) g.computeVertexNormals();
    c.setHex(p.col);
    var P = g.attributes.position, N = g.attributes.normal;
    for(var i = 0; i < P.count; i++){ pos.push(P.getX(i), P.getY(i), P.getZ(i)); nor.push(N.getX(i), N.getY(i), N.getZ(i)); col.push(c.r, c.g, c.b); }
    g.dispose(); p.geo.dispose();
  });
  var out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  out.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  out.computeBoundingSphere(); out.computeBoundingBox();
  return out;
}
function M4(THREE, x, y, z, ry, rx){
  var m = new THREE.Matrix4(), q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rx || 0, ry || 0, 0, "YXZ"));
  return m.compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(1, 1, 1));
}
function boxAt(THREE, w, h, d, x, y, z){ var g = new THREE.BoxGeometry(w, h, d); g.translate(x, y, z); return g; }

function create(c, L, o){
  var P = plan(L); if(!P || !c || !c.THREE) return null;
  o = o || {};
  var THREE = c.THREE, F = P.F, ys = P.ys, Ly = P.Ly, G = P.gate;
  var g = new THREE.Group(); g.name = "hqairbldg";
  var near = new THREE.Group(); near.name = "airbldg:near";
  var far = new THREE.Group(); far.name = "airbldg:far";
  // the frame group: local (u, y, -v)
  [near, far].forEach(function(fg){ fg.position.set(F.o[0], 0, F.o[1]); fg.rotation.y = Math.atan2(-F.B[1], F.B[0]); g.add(fg); });
  var mats = {}, nightList = [], textures = [], tgt = near;
  function M(key, hex, op){ return mats[key] || (mats[key] = c.mat(hex, op)); }
  function N(key, hex, em, day, night, op){
    if(mats[key]) return mats[key];
    var m = c.emis(hex, em, night, op); nightList.push({m: m, day: day, night: night}); return (mats[key] = m);
  }
  var concrete = M("concrete", 0xc9c6bd, {roughness: 0.88}), white = M("white", 0xe9edf0, {roughness: 0.5, metalness: 0.15}),
    metal = M("metal", 0x56616b, {roughness: 0.4, metalness: 0.6}), roofM = M("roof", 0xaab3bb, {roughness: 0.45, metalness: 0.45, side: THREE.DoubleSide}),
    doorM = M("door", 0xb3bbc3, {roughness: 0.55, metalness: 0.35}), red = M("red", 0xc2312a, {roughness: 0.5}),
    floorM = M("floor", 0xd8d2c4, {roughness: 0.6}), seatM = M("seat", 0x2f5f9e, {roughness: 0.6}),
    lit = N("lit", 0x3a4652, 0xffe2b0, 0, 1.3, {roughness: 0.4}), lamp = N("lamp", 0xf6efe0, 0xffc070, 0.1, 2.2, {roughness: 0.4});
  // glass is transparent: built with a stand-in opaque material, merged, then swapped (one draw call each)
  var glassTmp = M("glassTmp", 0x10fe01), cabTmp = M("cabTmp", 0x10fe02);
  var glass = new THREE.MeshStandardMaterial({color: 0x9cc6dc, roughness: 0.08, metalness: 0.35, transparent: true, opacity: 0.38, depthWrite: false,
    emissive: new THREE.Color(0xffd9a0), emissiveIntensity: 0});
  var cabGlass = new THREE.MeshStandardMaterial({color: 0x6fa8b8, roughness: 0.05, metalness: 0.4, transparent: true, opacity: 0.5, depthWrite: false,
    emissive: new THREE.Color(0x5fe0c8), emissiveIntensity: 0});
  nightList.push({m: glass, day: 0, night: 0.5}, {m: cabGlass, day: 0, night: 0.45});

  function add(geo, m, x, y, z, p){ var me = new THREE.Mesh(geo, m); me.position.set(x || 0, y || 0, z || 0); me.castShadow = true; me.receiveShadow = true; (p || tgt).add(me); return me; }
  // a frame box: u0..u1, v0..v1, y0..y1 (absolute y)
  function fbox(u0, u1, v0, v1, y0, y1, m, p){
    var du = Math.abs(u1 - u0), dv = Math.abs(v1 - v0), dh = Math.abs(y1 - y0);
    if(!(du > 1e-4 && dv > 1e-4 && dh > 1e-4)) return null;
    return add(new THREE.BoxGeometry(du, dh, dv), m, (u0 + u1)/2, (y0 + y1)/2, -(v0 + v1)/2, p);
  }
  function fcyl(u, v, rt, rb, y0, y1, seg, m, p, open){ return add(new THREE.CylinderGeometry(rt, rb, y1 - y0, seg || 16, 1, !!open), m, u, (y0 + y1)/2, -v, p); }
  // a beam between two frame points [u, y, v]
  function beam(a, b, s, m, p){
    var A = new THREE.Vector3(a[0], a[1], -a[2]), B2 = new THREE.Vector3(b[0], b[1], -b[2]), d = B2.clone().sub(A), len = d.length();
    var me = add(new THREE.BoxGeometry(s, len, s), m, (A.x + B2.x)/2, (A.y + B2.y)/2, (A.z + B2.z)/2, p);
    me.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
    return me;
  }

  /* ---- the sign atlas (stand numbers, gate signs, names): one canvas, 4 x 8 cells of 128 x 64 ---- */
  var CELLS = [], cellOf = {};
  function cell(key, text, fg, bg, px){ if(cellOf[key] != null) return; cellOf[key] = CELLS.length; CELLS.push({text: String(text), fg: fg, bg: bg, px: px}); }
  P.bridges.forEach(function(b){ cell("vdgs:" + b.stand, b.stand, "#ffd23a", "#05070a", 46); cell("gate:" + b.stand, "GATE " + b.stand, "#ffffff", "#123a6b", 30); });
  cell("gate:bus", "GATES 21-23", "#ffffff", "#123a6b", 20); cell("fire", "FIRE STATION", "#ffffff", "#9e1f1f", 18);
  cell("park", "P  PARKING", "#ffffff", "#1f4f9e", 22); cell("hangar", "HANGAR", "#1b1f24", "#f2c230", 28); cell("fuel", "FUEL", "#ffffff", "#2e7d4a", 30);
  var atlas = c.canvasTex(512, 512, function(gx){
    CELLS.forEach(function(e, i){
      var x = (i % 4)*128, y = Math.floor(i/4)*64;
      gx.fillStyle = e.bg; gx.fillRect(x, y, 128, 64);
      gx.fillStyle = e.fg; gx.font = "700 " + e.px + "px system-ui, sans-serif"; gx.textAlign = "center"; gx.textBaseline = "middle";
      gx.fillText(e.text, x + 64, y + 34);
    });
  });
  textures.push(atlas.t);
  var signM = new THREE.MeshBasicMaterial({map: atlas.t, toneMapped: false}); mats.sign = signM;
  // a sign plane w x h showing cell key, its middle at frame (u, y, v), facing frame direction (du, dv)
  function sign(key, w, h, u, y, v, du, dv){
    var i = cellOf[key]; if(i == null) return null;
    var geo = new THREE.PlaneGeometry(w, h), uv = geo.attributes.uv, c0 = (i % 4)/4, r0 = Math.floor(i/4);
    for(var j = 0; j < uv.count; j++) uv.setXY(j, c0 + uv.getX(j)/4, 1 - (r0 + 1)/8 + uv.getY(j)/8);
    var me = add(geo, signM, u, y, -v); me.castShadow = false;
    me.rotation.y = Math.atan2(du, -dv);                     // the plane's +z to frame (du, dv) (local z = -v)
    return me;
  }

  /* ---- the departures board (gallery): a canvas setBoard() redraws ---- */
  var BW = 512, BH = 136, boardTex = c.canvasTex(BW, BH, null), boardLines = [];
  textures.push(boardTex.t);
  function drawBoard(){
    var gx = boardTex.g; if(!gx) return;
    gx.fillStyle = "#0b1622"; gx.fillRect(0, 0, BW, BH);
    gx.fillStyle = "#ffb347"; gx.font = "700 20px system-ui, sans-serif"; gx.textAlign = "left"; gx.textBaseline = "top";
    gx.fillText("DEPARTURES", 12, 8);
    gx.fillStyle = "#e9eff3"; gx.font = "600 16px ui-monospace, monospace";
    for(var i = 0; i < Math.min(5, boardLines.length); i++) gx.fillText(boardLines[i], 12, 36 + i*19);
    if(boardTex.t) boardTex.t.needsUpdate = true;
  }
  drawBoard();
  var boardM = new THREE.MeshBasicMaterial({map: boardTex.t, toneMapped: false}); mats.board = boardM;

  var C = P.conc, sky = P.sky, hs = sky.w/2;
  /* ---- skybridge: floor, spandrels, glass, mullions, roof, girders, piers ---- */
  fbox(sky.u0, C.u0, sky.v - hs, sky.v + hs, G - 0.45, G, white);
  fbox(sky.u0, C.u0, sky.v - hs - 0.2, sky.v - hs, G - 1.25, G + 0.9, white); fbox(sky.u0, C.u0, sky.v + hs, sky.v + hs + 0.2, G - 1.25, G + 0.9, white);
  fbox(sky.u0, C.u0, sky.v - hs - 0.05, sky.v - hs + 0.05, G + 0.9, sky.roof, glassTmp); fbox(sky.u0, C.u0, sky.v + hs - 0.05, sky.v + hs + 0.05, G + 0.9, sky.roof, glassTmp);
  fbox(sky.u0, C.u0, sky.v - hs, sky.v + hs, G, G + 0.03, floorM);
  for(var u = sky.u0 + 1.5; u < C.u0; u += 3){ [-1, 1].forEach(function(s){ fbox(u - 0.07, u + 0.07, sky.v + s*(hs + 0.08) - 0.07, sky.v + s*(hs + 0.08) + 0.07, G + 0.9, sky.roof, metal); }); }
  (function(){                                      // a shallow arched roof over the tube
    var sh = new THREE.Shape(), n = 10, i, rr = hs + 0.35;
    for(i = 0; i <= n; i++){ var x = -rr + 2*rr*i/n; if(i) sh.lineTo(x, 0.55*(1 - (x/rr)*(x/rr))); else sh.moveTo(x, 0); }
    for(i = n; i >= 0; i--){ var x2 = -rr + 2*rr*i/n; sh.lineTo(x2, 0.55*(1 - (x2/rr)*(x2/rr)) + 0.25); }
    var geo = new THREE.ExtrudeGeometry(sh, {depth: C.u0 - sky.u0, bevelEnabled: false});
    geo.rotateY(PI/2);                              // shape x -> -z (frame v), extrude -> +x (frame u)
    add(geo, white, sky.u0, sky.roof, -sky.v);
  })();
  P.piers.forEach(function(p){ fcyl(p[0], p[1], 0.45, 0.5, ys - 3, G - 1.25, 12, concrete); });
  [P.piers[0][0], P.piers[P.piers.length - 1][0]].forEach(function(u){ fbox(u - 0.6, u + 0.6, sky.v - 3.2, sky.v + 3.2, G - 1.9, G - 1.25, concrete); });

  /* ---- concourse: ops floor with roller doors, the gate-level slab, gallery glass, roof, signs, boards ---- */
  fbox(C.u0, C.u1, C.v0, C.v1, Ly - 0.5, G - 0.5, concrete);
  fbox(C.u0 - 0.2, C.u1 + 0.4, C.v0 - 0.2, C.v1 + 0.2, G - 0.5, G, white);
  fbox(C.u0 + 0.6, C.u1 - 0.6, C.v0 + 0.6, C.v1 - 0.6, G, G + 0.02, floorM);
  fbox(C.u0 - 0.05, C.u0 + 0.05, C.v0 + 2, C.v1 - 2, Ly + 1.2, Ly + 3.2, lit);                 // landside ops windows
  var roller = [];
  P.bridges.forEach(function(b){ var vk = toF(F, b.rot[0], b.rot[1])[1] + DRUM_BACK; roller.push(vk + 7, vk + 15); });
  for(var rv = C.v0 + 6; rv < C.v0 + 40; rv += 9) roller.push(rv);
  roller.forEach(function(v){ fbox(C.u1, C.u1 + 0.12, v - 2, v + 2, Ly, Ly + 3.6, doorM); fbox(C.u1, C.u1 + 0.2, v - 2.3, v + 2.3, Ly + 3.6, Ly + 3.9, metal); });
  var roofU = function(u){ var t = (u - (C.u0 + C.u1)/2)/((C.u1 - C.u0)/2 + 1); return G + ROOF - 6 + 1.0*(1 - t*t); };   // underside
  var gTop = roofU(C.u1 - 0.5) - 0.05;
  fbox(C.u1 - 0.55, C.u1 - 0.45, C.v0 + 0.6, C.v1 - 0.6, G, gTop, glassTmp);                        // the apron facade
  for(var mv = C.v0 + 1.5; mv <= C.v1 - 1.5; mv += 3) fbox(C.u1 - 0.42, C.u1 - 0.3, mv - 0.06, mv + 0.06, G, gTop, metal);
  fbox(C.u1 - 0.42, C.u1 - 0.3, C.v0 + 0.6, C.v1 - 0.6, G + 3.2, G + 3.32, metal);
  // landside wall: panels, a band of glass, the skybridge's opening
  [[C.v0 + 0.6, sky.v - hs], [sky.v + hs, C.v1 - 0.6]].forEach(function(r){
    fbox(C.u0, C.u0 + 0.4, r[0], r[1], G, G + 0.9, white); fbox(C.u0, C.u0 + 0.4, r[0], r[1], G + 3.4, roofU(C.u0 + 0.5), white);
    fbox(C.u0 + 0.1, C.u0 + 0.2, r[0], r[1], G + 0.9, G + 3.4, glassTmp);
  });
  fbox(C.u0, C.u0 + 0.4, sky.v - hs, sky.v + hs, sky.roof + 0.3, roofU(C.u0 + 0.5), white);
  [C.v0, C.v1].forEach(function(v, i){ var s = i ? -1 : 1; fbox(C.u0, C.u1 - 0.5, v + s*0.2, v + s*0.6, G, roofU(C.u1 - 1), white); });
  (function(){                                      // the curved roof, along v, with an overhang to the apron
    var sh = new THREE.Shape(), n = 12, i, a = C.u0 - 0.6, b = C.u1 + 1.0, y0 = roofU(a);
    for(i = 0; i <= n; i++){ var u = a + (b - a)*i/n, y = roofU(u) - y0; if(i) sh.lineTo(u, y); else sh.moveTo(u, y); }
    for(i = n; i >= 0; i--){ var u2 = a + (b - a)*i/n; sh.lineTo(u2, roofU(u2) - y0 + 0.35); }
    var depth = C.v1 - C.v0 + 1, geo = new THREE.ExtrudeGeometry(sh, {depth: depth, bevelEnabled: false});
    geo.translate(0, 0, -C.v1 - 0.5);              // extruded along +z (= -v): from v1 + 0.5 down to v0 - 0.5
    add(geo, roofM, 0, y0, 0);
  })();
  P.top = roofU((C.u0 + C.u1)/2) + 0.35;
  // a softly lit flat ceiling under the curved roof (its underside faces away from every light: black from inside)
  fbox(C.u0 + 0.4, C.u1 - 0.5, C.v0 + 0.6, C.v1 - 0.6, gTop - 0.12, gTop, N("ceil", 0xe6e2d8, 0xfff1d6, 0.35, 0.7, {roughness: 0.8}));
  // gallery: seats, gate desks, gate signs, the departures boards; VDGS boards outside, facing each stand
  P.props.seats.forEach(function(s){ fbox(s.u0, s.u1, s.v0, s.v1, G, G + 0.45, seatM); fbox(s.u0 + 0.8, s.u1, s.v0, s.v1, G + 0.45, s.y1, seatM); });
  P.props.desks.forEach(function(d){ fbox(d.u0, d.u1, d.v0, d.v1, G, d.y1 - 0.05, white); fbox(d.u0 - 0.05, d.u1 + 0.05, d.v0 - 0.05, d.v1 + 0.05, d.y1 - 0.05, d.y1, metal); });
  P.props.signs.forEach(function(s){
    sign("gate:" + s.id, 2.4, 1.2, s.u - 0.03, G + 3.8, s.v, -1, 0); sign("gate:" + s.id, 2.4, 1.2, s.u + 0.03, G + 3.8, s.v, 1, 0);
    fbox(s.u - 0.05, s.u + 0.05, s.v - 0.05, s.v + 0.05, G + 4.4, roofU(s.u), metal);
    sign("vdgs:" + s.id, 1.6, 0.8, C.u1 + 0.32, G + 4.4, s.v, 1, 0);
    fbox(C.u1 + 0.05, C.u1 + 0.28, s.v - 0.9, s.v + 0.9, G + 3.9, G + 4.9, metal);
  });
  sign("gate:bus", 2.4, 1.2, C.u1 - 6, G + 3.8, C.v0 + 6, -1, 0); sign("gate:bus", 2.4, 1.2, C.u1 - 6, G + 3.8, C.v0 + 5.94, 0, 1);
  [-60, 0, 60].forEach(function(dv){
    var v = sky.v + dv, by = dv ? G + 4.6 : sky.roof + 1.0, me = add(new THREE.PlaneGeometry(5.6, 1.5), boardM, C.u0 + 0.45, by, -v);
    me.rotation.y = PI/2; me.castShadow = false;                                    // faces +u, into the gallery
  });

  /* ---- jet bridges: 5 InstancedMeshes for all six (drum + column static; inner, outer, cab, bogie move) ---- */
  var nb = P.bridges.length, bg = new THREE.Group(); bg.name = "airbldg:bridges"; g.add(bg);
  var bmat = c.mat(0xffffff, {vertexColors: true, roughness: 0.5, metalness: 0.3}); mats.bridge = bmat;
  var GREY = 0xd5dade, DARK = 0x2a3440, STEEL = 0x6b757e, BLACK = 0x1a1d21;
  var colH = G - 0.6 - Ly;
  var drumGeo = vgeo(THREE, [
    {geo: new THREE.CylinderGeometry(COL_R, COL_R, colH, 12), col: STEEL, m: M4(THREE, 0, colH/2, 0)},
    {geo: new THREE.CylinderGeometry(DRUM_R, DRUM_R, 3.8, 16), col: GREY, m: M4(THREE, 0, colH + 1.9, 0)},
    {geo: new THREE.CylinderGeometry(DRUM_R + 0.03, DRUM_R + 0.03, 0.9, 16), col: DARK, m: M4(THREE, 0, colH + 2.3, 0)},
    {geo: new THREE.CylinderGeometry(DRUM_R + 0.25, DRUM_R + 0.25, 0.3, 16), col: STEEL, m: M4(THREE, 0, colH + 3.95, 0)}]);
  function tunnelGeo(T, back){
    var z0 = back ? -T.len : 0;
    return vgeo(THREE, [
      {geo: boxAt(THREE, T.w, T.h + 0.25, T.len, 0, (T.h + 0.25)/2 - 0.25, z0 + T.len/2), col: GREY},
      {geo: boxAt(THREE, T.w + 0.04, 0.8, T.len - 0.6, 0, 1.6, z0 + T.len/2), col: DARK},
      {geo: boxAt(THREE, T.w + 0.08, 0.12, T.len, 0, T.h + 0.06, z0 + T.len/2), col: STEEL}]);
  }
  var cabGeo = vgeo(THREE, [
    {geo: boxAt(THREE, CAB_W, CAB_H + 0.3, CAB_D - 0.5, 0, (CAB_H + 0.3)/2 - 0.3, -CAB_D/2 - 0.25), col: GREY},
    {geo: boxAt(THREE, CAB_W + 0.04, 1.0, CAB_D - 0.9, 0, 1.7, -CAB_D/2 - 0.25), col: DARK},
    {geo: boxAt(THREE, CAB_W - 0.2, CAB_H - 0.1, 0.5, 0, (CAB_H - 0.1)/2, -0.25), col: BLACK},                // the bellows
    {geo: boxAt(THREE, CAB_W + 0.3, 0.25, 0.9, 0, CAB_H + 0.05, -0.45), col: STEEL}]);                        // the canopy
  var bogieGeo = vgeo(THREE, [
    {geo: boxAt(THREE, 0.4, P.bridges.length ? P.bridges[0].legTop : 3, 0.4, 0, (P.bridges.length ? P.bridges[0].legTop : 3)/2, 0), col: STEEL},
    {geo: boxAt(THREE, 1.1, 0.25, 0.5, 0, 0.6, 0), col: STEEL},
    {geo: boxAt(THREE, 0.25, 0.9, 0.9, -0.45, 0.45, 0), col: BLACK}, {geo: boxAt(THREE, 0.25, 0.9, 0.9, 0.45, 0.45, 0), col: BLACK}]);
  function inst(geo, name){ var im = new THREE.InstancedMesh(geo, bmat, Math.max(1, nb)); im.name = "airbldg:bridge:" + name; im.count = nb; im.castShadow = true; im.receiveShadow = true; im.frustumCulled = false; bg.add(im); return im; }
  var IM = {drum: inst(drumGeo, "drum"), inner: inst(tunnelGeo(TUN_IN, false), "inner"), outer: inst(tunnelGeo(TUN_OUT, true), "outer"), cab: inst(cabGeo, "cab"), bogie: inst(bogieGeo, "bogie")};
  var bk = P.bridges.map(function(){ return {k: 0, want: 0, dirty: true}; }), bIndex = {};
  P.bridges.forEach(function(b, i){ bIndex[b.stand] = i; IM.drum.setMatrixAt(i, M4(THREE, b.rot[0], Ly, b.rot[1], 0)); });
  IM.drum.instanceMatrix.needsUpdate = true;
  function placeBridge(i){
    var b = P.bridges[i], p = bridgePose(b, bk[i].k), dx = Math.sin(p.yaw), dz = Math.cos(p.yaw), sl = (b.y0 - p.y1)/p.len;
    function at(h){ return [b.rot[0] + dx*h, b.y0 - sl*h, b.rot[1] + dz*h]; }
    var a = at(TUN_IN.from), e = at(p.len - CAB_D/2 + TUN_OUT.into);
    IM.inner.setMatrixAt(i, M4(THREE, a[0], a[1], a[2], p.yaw, p.pitch));
    IM.outer.setMatrixAt(i, M4(THREE, e[0], e[1], e[2], p.yaw, p.pitch));
    IM.cab.setMatrixAt(i, M4(THREE, p.door[0], p.door[1], p.door[2], p.cabYaw));
    IM.bogie.setMatrixAt(i, M4(THREE, p.bogie[0], Ly, p.bogie[1], p.yaw));
    bk[i].dirty = false;
  }
  function flushBridges(){
    var any = false;
    for(var i = 0; i < nb; i++) if(bk[i].dirty){ placeBridge(i); any = true; }
    if(any) ["inner", "outer", "cab", "bogie"].forEach(function(k){ IM[k].instanceMatrix.needsUpdate = true; });
  }
  flushBridges();

  /* ---- control tower ---- */
  var T = P.tower, tu = T.u, tv = T.v, ty = T.y;
  fbox(tu - 7, tu + 7, tv - 7, tv + 7, ty - 1.5, ty + 7, concrete);
  fbox(tu - 7.05, tu + 7.05, tv - 7.05, tv + 7.05, ty + 2.5, ty + 5.5, glassTmp);
  fcyl(tu, tv, 3.0, 4.2, ty, ty + 54, 20, concrete);
  fcyl(tu, tv, 4.8, 4.4, ty + 50, ty + 54, 8, white);
  fcyl(tu, tv, 5.2, 4.8, ty + 54, ty + 56, 8, white);
  fcyl(tu, tv, 6.6, 5.0, ty + 56, ty + 62, 8, cabTmp, null, true);               // the cab glass, sloping out ~15 degrees
  for(var a8 = 0; a8 < 8; a8++){ var an = (a8 + 0.5)*PI/4; beam([tu + Math.cos(an)*5.0*0.924, ty + 56, tv + Math.sin(an)*5.0*0.924], [tu + Math.cos(an)*6.6*0.924, ty + 62, tv + Math.sin(an)*6.6*0.924], 0.14, metal); }
  fcyl(tu, tv, 5.0, 5.0, ty + 55.9, ty + 56.05, 8, floorM);
  fcyl(tu, tv, 7.1, 6.8, ty + 62, ty + 62.9, 8, white);
  fcyl(tu, tv, 2.6, 3.0, ty + 62.9, ty + 64.6, 8, white);
  fcyl(tu, tv, 0.5, 0.6, ty + 64.6, ty + 65.1, 10, metal);
  fcyl(tu + 2.4, tv, 0.08, 0.14, ty + 62.9, T.antennaTop, 6, metal);             // the antenna, to 70 m
  var beacon = new THREE.Group(); beacon.userData.anim = true; beacon.position.set(tu, ty + 65.1, -tv); near.add(beacon);
  add(vgeo(THREE, [{geo: new THREE.CylinderGeometry(0.45, 0.5, 0.9, 12), col: 0x3a4652, m: M4(THREE, 0, 0.45, 0)},
    {geo: boxAt(THREE, 0.5, 0.45, 0.12, 0, 0.45, 0.48), col: 0xffffff}, {geo: boxAt(THREE, 0.5, 0.45, 0.12, 0, 0.45, -0.48), col: 0x2bff7a}]),
    new THREE.MeshBasicMaterial({vertexColors: true, toneMapped: false}), 0, 0, 0, beacon);

  /* ---- approach radar: a 25 m lattice mast and a turning dish ---- */
  var A = P.asr, au = A.u, av = A.v, ah = A.y + A.h;
  fbox(au - 4, au + 4, av - 4, av + 4, A.y - 1, A.y + 0.4, concrete);
  [[-1, -1], [1, -1], [1, 1], [-1, 1]].forEach(function(s, i, all){
    beam([au + s[0]*3, A.y, av + s[1]*3], [au + s[0]*1.2, ah, av + s[1]*1.2], 0.28, metal);
    var n2 = all[(i + 1) % 4];
    for(var l = 0; l < 5; l++){
      var h0 = A.y + l*A.h/5, h1 = A.y + (l + 1)*A.h/5, r0 = 3 - 1.8*l/5, r1 = 3 - 1.8*(l + 1)/5;
      beam([au + s[0]*r0, h0, av + s[1]*r0], [au + n2[0]*r1, h1, av + n2[1]*r1], 0.12, metal);
      beam([au + s[0]*r1, h1, av + s[1]*r1], [au + n2[0]*r1, h1, av + n2[1]*r1], 0.12, metal);
    }
  });
  fbox(au - 1.8, au + 1.8, av - 1.8, av + 1.8, ah, ah + 0.3, metal);
  var dish = new THREE.Group(); dish.position.set(au, ah + 0.3, -av); near.add(dish);
  (function(){
    add(new THREE.CylinderGeometry(0.45, 0.6, 1.4, 12), metal, 0, 0.7, 0, dish);
    var dg = new THREE.CylinderGeometry(13, 13, 4.4, 14, 1, true, -0.5, 1.0); dg.translate(0, 0, -13);   // a curved sheet, its middle at the axis
    var d = add(dg, M("dish", 0xf2f4f6, {roughness: 0.5, metalness: 0.3, side: THREE.DoubleSide}), 0, 3.6, 0.9, dish); d.rotation.x = -0.18;
    add(new THREE.BoxGeometry(0.2, 0.2, 4.2), metal, 0, 3.0, -1.4, dish);              // the feed, on the concave side
    add(new THREE.BoxGeometry(0.6, 0.6, 0.8), metal, 0, 3.1, -3.4, dish);
    if(HQV.hqMerge) HQV.hqMerge.mergeStatic(THREE, dish);
    dish.userData.anim = true;
  })();

  /* ---- fire station: five bays with red doors facing +u, office, lookout, hose tower ---- */
  if(P.fire){
    var FS = P.fire, fz = P.zones.fire, H1 = FS.hall;
    fbox(fz.u0 + 0.5, fz.u1 - 0.5, fz.v0 + 0.5, fz.v1 - 0.5, Ly, Ly + 0.05, concrete);
    fbox(H1.u0, H1.u1, H1.v0, H1.v1, Ly, Ly + 8.5, white);
    fbox(H1.u0 - 0.2, H1.u1 + 0.3, H1.v0 - 0.2, H1.v1 + 0.2, Ly + 8.0, Ly + 8.6, red);                     // the red fascia
    fbox(H1.u0 + 0.1, H1.u1, H1.v0 + 0.1, H1.v1 - 0.1, Ly + 8.6, Ly + 8.7, roofM);
    var bw = (H1.v1 - H1.v0)/FS.bays;
    for(var i5 = 0; i5 < FS.bays; i5++){ var vc = H1.v0 + bw*(i5 + 0.5);
      fbox(H1.u1, H1.u1 + 0.15, vc - FS.door/2, vc + FS.door/2, Ly, Ly + 6, red);
      for(var st = 1; st < 6; st++) fbox(H1.u1 + 0.15, H1.u1 + 0.18, vc - FS.door/2, vc + FS.door/2, Ly + st - 0.04, Ly + st + 0.04, doorM);
    }
    var O = FS.office; fbox(O.u0, O.u1, O.v0, O.v1, Ly, Ly + 7, white);
    fbox(O.u1, O.u1 + 0.08, O.v0 + 1, O.v1 - 1, Ly + 1.2, Ly + 2.6, lit); fbox(O.u1, O.u1 + 0.08, O.v0 + 1, O.v1 - 1, Ly + 4.4, Ly + 5.8, lit);
    fbox(O.u1 - 7, O.u1 - 1, O.v0 + 3, O.v1 - 3, Ly + 7, Ly + 10.2, glassTmp); fbox(O.u1 - 7.3, O.u1 - 0.7, O.v0 + 2.7, O.v1 - 2.7, Ly + 10.2, Ly + 10.6, red);
    var TW = FS.tower; fbox(TW.u0, TW.u1, TW.v0, TW.v1, Ly, Ly + 30, concrete); fbox(TW.u0 - 0.1, TW.u1 + 0.1, TW.v0 - 0.1, TW.v1 + 0.1, Ly + 27, Ly + 28.5, red);
    sign("fire", 7, 1.75, H1.u1 + 0.25, Ly + 7.4, (H1.v0 + H1.v1)/2, 1, 0);
  }

  /* ---- hangars: 60 x 45 with a 22 m barrel roof, doors facing B; the north one open (an airliner inside) ---- */
  (P.hangars || []).forEach(function(H){
    var vc = (H.v0 + H.v1)/2, span = H.v1 - H.v0, depth = H.u1 - H.u0, wallH = Ly + 15;
    fbox(H.u0, H.u0 + 0.6, H.v0, H.v1, Ly, wallH, white);
    fbox(H.u0, H.u1, H.v0, H.v0 + 0.6, Ly, wallH, white); fbox(H.u0, H.u1, H.v1 - 0.6, H.v1, Ly, wallH, white);
    fbox(H.u1 - 0.6, H.u1, H.v0, H.v1, Ly + 14, wallH, white);
    var rg = new THREE.CylinderGeometry(span/2, span/2, depth + 0.6, 24, 1, true, 0, PI); rg.rotateZ(PI/2); rg.scale(1, 7/(span/2), 1);
    add(rg, roofM, (H.u0 + H.u1)/2, wallH, -vc);
    [H.u0 + 0.05, H.u1 - 0.05].forEach(function(u){                      // the gable ends under the barrel
      var sh = new THREE.Shape(), n = 16;
      for(var j = 0; j <= n; j++){ var a = PI*j/n, x = Math.cos(a)*span/2, y = Math.sin(a)*7; if(j) sh.lineTo(x, y); else sh.moveTo(x, y); }
      var ge = new THREE.ShapeGeometry(sh); ge.rotateY(PI/2); add(ge, roofM, u, wallH, -vc);
    });
    fbox(H.u0 + 0.6, H.u1 - 0.6, H.v0 + 0.6, H.v1 - 0.6, Ly, Ly + 0.04, concrete);
    var pw = (span - 1.2)/6;
    for(var p6 = 0; p6 < 6; p6++){
      var v0 = H.v0 + 0.6 + p6*pw, side = p6 < 3 ? -1 : 1, slot = p6 < 3 ? p6 : 5 - p6;
      if(H.open) v0 = side < 0 ? H.v0 - pw : H.v1;                     // slid into the pockets beside the walls
      var du = H.open ? 0.4*slot : 0;
      fbox(H.u1 - 0.25 + du, H.u1 - 0.05 + du, v0, v0 + pw, Ly, Ly + 14, doorM);
    }
    sign("hangar", 8, 4, H.u1 + 0.05, Ly + 16.5, vc, 1, 0);
  });

  /* ---- fuel farm: four tanks in a bund, a pipe rack toward the apron, an office ---- */
  if(P.fuel){
    var FU = P.fuel, bd = FU.bund;
    fbox(bd.u0, bd.u1, bd.v0, bd.v1, Ly, Ly + 0.05, concrete);
    fbox(bd.u0, bd.u1, bd.v0, bd.v0 + 0.4, Ly, Ly + 1.5, concrete); fbox(bd.u0, bd.u1, bd.v1 - 0.4, bd.v1, Ly, Ly + 1.5, concrete);
    fbox(bd.u0, bd.u0 + 0.4, bd.v0, bd.v1, Ly, Ly + 1.5, concrete); fbox(bd.u1 - 0.4, bd.u1, bd.v0, bd.v1, Ly, Ly + 1.5, concrete);
    FU.tanks.forEach(function(t){
      fcyl(t[0], t[1], FU.r, FU.r, Ly, Ly + FU.h, 32, white);
      var cone = new THREE.ConeGeometry(FU.r + 0.2, 1.2, 32, 1, true); add(cone, white, t[0], Ly + FU.h + 0.6, -t[1]);
      fcyl(t[0], t[1], FU.r + 0.05, FU.r + 0.05, Ly + 8, Ly + 8.6, 32, red);
    });
    var rk = FU.rack;
    for(var pv = rk.v0; pv <= rk.v1; pv += 6){ fbox(rk.u - 1.4, rk.u - 1.2, pv - 0.1, pv + 0.1, Ly, Ly + 4, metal); fbox(rk.u + 1.2, rk.u + 1.4, pv - 0.1, pv + 0.1, Ly, Ly + 4, metal); fbox(rk.u - 1.4, rk.u + 1.4, pv - 0.1, pv + 0.1, Ly + 3.6, Ly + 3.8, metal); }
    [-0.8, 0, 0.8].forEach(function(du){ var pg = new THREE.CylinderGeometry(0.22, 0.22, rk.v1 - rk.v0, 8); pg.rotateX(PI/2); add(pg, metal, rk.u + du, Ly + 4.05, -(rk.v0 + rk.v1)/2); });
    var FO = FU.office; fbox(FO.u0, FO.u1, FO.v0, FO.v1, Ly, Ly + 4, white); fbox(FO.u0 - 0.2, FO.u1 + 0.2, FO.v0 - 0.2, FO.v1 + 0.2, Ly + 4, Ly + 4.3, metal);
    fbox(FO.u1, FO.u1 + 0.06, FO.v0 + 1, FO.v1 - 1, Ly + 1.2, Ly + 2.6, lit);
    sign("fuel", 3, 1.5, FO.u1 + 0.1, Ly + 3.2, (FO.v0 + FO.v1)/2, 1, 0);
  }

  /* ---- ground-support depot: a low shed, marked parking bays ---- */
  if(P.depot){
    var DS = P.depot.shed, DB = P.depot.bays, mid2 = (DB.u0 + DB.u1)/2;
    fbox(DS.u0, DS.u1, DS.v0, DS.v1, Ly, Ly + 4.2, white); fbox(DS.u0 - 0.2, DS.u1 + 0.2, DS.v0 - 0.3, DS.v1 + 0.2, Ly + 4.2, Ly + 4.5, metal);
    [DS.u0 + 2.3, DS.u1 - 2.3].forEach(function(u){ fbox(u - 1.8, u + 1.8, DS.v0 - 0.1, DS.v0, Ly, Ly + 3.4, doorM); });
    var paint = white;
    for(var bv = DB.v0; bv <= DB.v1 + 0.01; bv += 3.8){ fbox(DB.u0, mid2 - 0.6, bv - 0.08, bv + 0.08, Ly, Ly + 0.03, paint); fbox(mid2 + 0.6, DB.u1, bv - 0.08, bv + 0.08, Ly, Ly + 0.03, paint); }
    fbox(DB.u0, DB.u0 + 0.16, DB.v0, DB.v1, Ly, Ly + 0.03, paint); fbox(DB.u1 - 0.16, DB.u1, DB.v0, DB.v1, Ly, Ly + 0.03, paint);
  }

  /* ---- the multi-storey car park: 4 decks at 3.2 m, parapets, a ramp, a core, roof lamps, the footbridge ---- */
  var CP = P.carpark, rp = CP.ramp, lv = CP.levels;
  fbox(CP.u0, CP.u1, CP.v0, CP.v1, lv[0] - 0.3, lv[0] + 0.05, concrete);
  for(var li = 1; li < lv.length; li++){
    fbox(CP.u0, rp.u0, CP.v0, CP.v1, lv[li] - 0.3, lv[li], concrete);
    fbox(rp.u0, CP.u1, CP.v0, CP.v0 + 18, lv[li] - 0.3, lv[li], concrete);
    var pe = lv[li], ph = pe + 1.1;
    fbox(CP.u0, CP.u1, CP.v1 - 0.25, CP.v1, pe, ph, concrete); fbox(CP.u0, CP.u0 + 0.25, CP.v0, CP.v1, pe, ph, concrete); fbox(CP.u1 - 0.25, CP.u1, CP.v0, CP.v1, pe, ph, concrete);
    if(li === 2 && P.zones.footbridge){ var gu = P.zones.footbridge.a[0];                 // the footbridge's gap
      fbox(CP.u0, gu - 2, CP.v0, CP.v0 + 0.25, pe, ph, concrete); fbox(gu + 2, CP.u1, CP.v0, CP.v0 + 0.25, pe, ph, concrete); }
    else fbox(CP.u0, CP.u1, CP.v0, CP.v0 + 0.25, pe, ph, concrete);
    // the ramp up to this deck in the strip along u1
    var r0 = lv[li - 1], rl = CP.v1 - (CP.v0 + 18) - 2, slope = Math.atan2(pe - r0, rl);
    var rmp = fbox(rp.u0, rp.u1, CP.v0 + 18, CP.v0 + 18 + Math.hypot(rl, pe - r0), (r0 + pe)/2 - 0.15, (r0 + pe)/2 + 0.15, concrete);
    if(rmp){ rmp.position.z = -(CP.v0 + 18 + rl/2); rmp.rotation.x = slope; }   // low at v0 + 18 (local +z end), high at v1 - 2
  }
  var colU = [CP.u0 + 0.4, CP.u0 + 6, CP.u0 + 25, CP.u0 + 44, CP.u1 - 0.4];
  for(var cu = 0; cu < colU.length; cu++) for(var cv = 0; cv < 8; cv++){ var vv = CP.v0 + 0.4 + (CP.v1 - CP.v0 - 0.8)*cv/7; fbox(colU[cu] - 0.25, colU[cu] + 0.25, vv - 0.25, vv + 0.25, lv[0], lv[3], concrete); }
  var fbA = P.zones.footbridge;
  if(fbA){
    var fu = fbA.a[0], fy = lv[2];
    fbox(fu - 3, fu + 5, CP.v0 + 0.3, CP.v0 + 6, lv[0], lv[3] + 2.6, concrete);                           // the stair and lift core
    fbox(fu - 2, fu + 2, Math.min(fbA.a[1], fbA.b[1]), CP.v0, fy - 0.35, fy, white);
    fbox(fu - 2, fu - 1.9, Math.min(fbA.a[1], fbA.b[1]), CP.v0, fy, fy + 2.6, glassTmp); fbox(fu + 1.9, fu + 2, Math.min(fbA.a[1], fbA.b[1]), CP.v0, fy, fy + 2.6, glassTmp);
    fbox(fu - 2.15, fu + 2.15, Math.min(fbA.a[1], fbA.b[1]), CP.v0, fy + 2.6, fy + 2.9, white);
    sign("park", 4, 2, fu + 1, lv[3] + 1.4, CP.v0 - 0.56, 0, -1);
  }
  var lampPts = [];
  [[0.2, 0.2], [0.5, 0.2], [0.8, 0.2], [0.2, 0.8], [0.5, 0.8], [0.8, 0.8]].forEach(function(f){
    var u2 = CP.u0 + (rp.u0 - CP.u0)*f[0], v2 = CP.v0 + (CP.v1 - CP.v0)*f[1];
    fbox(u2 - 0.08, u2 + 0.08, v2 - 0.08, v2 + 0.08, lv[3], lv[3] + 5, metal); fbox(u2 - 0.35, u2 + 0.35, v2 - 0.35, v2 + 0.35, lv[3] + 5, lv[3] + 5.2, lamp);
    lampPts.push([u2, lv[3] + 5, v2]);
  });

  /* ---- merge the near group; swap the glass back in ---- */
  if(HQV.hqMerge && HQV.hqMerge.mergeStatic){
    nightList.forEach(function(r, i){ r.m.emissiveIntensity = 1000 + i; });
    HQV.hqMerge.mergeStatic(THREE, near, {keep: function(m){ return m.parent && m.parent.userData && m.parent.userData.anim; }});
  }
  near.traverse(function(m){ if(m.material === glassTmp) m.material = glass; else if(m.material === cabTmp) m.material = cabGlass; });
  near.traverse(function(m){ if(m.isMesh && m.material === signM){ m.castShadow = false; } });

  /* ---- cars: one InstancedMesh, parked in the car park, taxis at the rank, cars at the drop-off ---- */
  var carGeo = vgeo(THREE, [
    {geo: boxAt(THREE, 1.8, 0.75, 4.4, 0, 0.62, 0), col: 0xffffff},
    {geo: boxAt(THREE, 1.62, 0.6, 2.3, 0, 1.28, -0.25), col: 0x9a9a9a},
    {geo: boxAt(THREE, 1.66, 0.42, 2.0, 0, 1.3, -0.25), col: 0x1d2630},
    {geo: boxAt(THREE, 1.9, 0.5, 0.8, 0, 0.38, 1.35), col: 0x15181c}, {geo: boxAt(THREE, 1.9, 0.5, 0.8, 0, 0.38, -1.35), col: 0x15181c}]);
  var R = c.rng(c.hashStr("hqairbldg:cars")), PAL = [0xd8dde2, 0x2b2f36, 0x8c939b, 0xb33a3a, 0x2f5f9e, 0xf4f4f4, 0x4a5a3a, 0x9a8a6a, 0x6a3a5a];
  var cars = [];
  var rows = [CP.u0 + 3.5, CP.u0 + 8.5, CP.u0 + 22.5, CP.u0 + 27.5, CP.u0 + 41.5, CP.u0 + 46.5];
  lv.forEach(function(y, l){
    rows.forEach(function(ru, ri){
      for(var v = CP.v0 + 8; v <= CP.v1 - 3; v += 2.6){
        if(R() > (l === 3 ? 0.35 : 0.62)) continue;
        var pw2 = toW(F, ru, v), d = dirW(F, ri % 2 ? 1 : -1, 0);
        cars.push({x: pw2[0], y: y + (l ? 0 : 0.05), z: pw2[1], yaw: yawOf(d[0], d[1]), col: PAL[Math.floor(R()*PAL.length) % PAL.length]});
      }
    });
  });
  var curb = (L.landside && L.landside.curb) || {};
  function along(seg, n, col){
    if(!seg || seg.length < 2) return;
    var a = seg[0], b = seg[1], d = [b[0] - a[0], b[1] - a[1]], len = Math.hypot(d[0], d[1]) || 1, off = dirW(F, 2, 0);
    for(var i = 0; i < n; i++){ var t = (i + 0.5)/n; cars.push({x: a[0] + d[0]*t + off[0], y: ys + 0.02, z: a[1] + d[1]*t + off[1], yaw: yawOf(d[0]/len, d[1]/len), col: col != null ? col : PAL[Math.floor(R()*PAL.length) % PAL.length]}); }
  }
  along(curb.taxi, 4, 0xf2c230); along(curb.dropoff, 6, null);
  var carM = c.mat(0xffffff, {vertexColors: true, roughness: 0.45, metalness: 0.35}); mats.car = carM;
  var carIM = new THREE.InstancedMesh(carGeo, carM, Math.max(1, cars.length)); carIM.name = "airbldg:cars"; carIM.count = cars.length; carIM.frustumCulled = false;
  var cc = new THREE.Color();
  cars.forEach(function(k, i){ carIM.setMatrixAt(i, M4(THREE, k.x, k.y, k.z, k.yaw)); carIM.setColorAt(i, cc.setHex(k.col)); });
  carIM.instanceMatrix.needsUpdate = true; if(carIM.instanceColor) carIM.instanceColor.needsUpdate = true;
  g.add(carIM);

  /* ---- the far meshes (detail 1): one merged mesh per material ---- */
  tgt = far;
  // the glazing and the tower cab keep the near tint (and its glow at night), so the switch at 600 m does not pop
  var farL = M("farLight", 0xd2d6da, {roughness: 0.8}), farD = M("farDark", 0x3a434c, {roughness: 0.9});
  var farG = N("farGlass", 0x86a8ba, 0xffd9a0, 0, 0.32, {roughness: 0.15, metalness: 0.35}), farC = N("farCab", 0x5f95a3, 0x5fe0c8, 0, 0.3, {roughness: 0.1, metalness: 0.4});
  fbox(C.u0, C.u1, C.v0, C.v1, Ly, G + 1, farL); fbox(C.u0, C.u1, C.v0, C.v1, G + 1, G + 6, farG); fbox(C.u0 - 0.5, C.u1 + 1, C.v0, C.v1, G + 6, P.top, farL);
  fbox(sky.u0, C.u0, sky.v - hs, sky.v + hs, G - 0.45, G + 0.9, farL); fbox(sky.u0, C.u0, sky.v - hs, sky.v + hs, G + 0.9, sky.roof, farG);
  fcyl(tu, tv, 3.0, 4.2, ty, ty + 56, 8, farL); fcyl(tu, tv, 6.6, 5.0, ty + 56, ty + 62, 8, farC); fcyl(tu, tv, 7, 7, ty + 62, ty + 65, 8, farL);
  fbox(au - 0.8, au + 0.8, av - 0.8, av + 0.8, A.y, ah + 2, farL);
  (P.hangars || []).forEach(function(H){ fbox(H.u0, H.u1, H.v0, H.v1, Ly, Ly + 19, farL); });
  if(P.fire){ fbox(P.fire.hall.u0, P.fire.hall.u1, P.fire.hall.v0, P.fire.hall.v1, Ly, Ly + 9, farL); fbox(P.fire.tower.u0, P.fire.tower.u1, P.fire.tower.v0, P.fire.tower.v1, Ly, Ly + 30, farL); }
  if(P.fuel) P.fuel.tanks.forEach(function(t){ fcyl(t[0], t[1], P.fuel.r, P.fuel.r, Ly, Ly + P.fuel.h, 12, farL); });
  // the car park as the near one reads from afar: open decks with parapets on its columns, the core, the roof lamps
  for(var fc = 0; fc < colU.length; fc++) for(var fv = 0; fv < 8; fv++){ var fvv = CP.v0 + 0.4 + (CP.v1 - CP.v0 - 0.8)*fv/7; fbox(colU[fc] - 0.25, colU[fc] + 0.25, fvv - 0.25, fvv + 0.25, lv[0], lv[3], farL); }
  for(var fl2 = 0; fl2 < lv.length; fl2++){
    fbox(CP.u0, CP.u1, CP.v0, CP.v1, lv[fl2] - 0.3, lv[fl2], farL);
    if(fl2){ fbox(CP.u0, CP.u1, CP.v0, CP.v0 + 0.3, lv[fl2], lv[fl2] + 1.1, farL); fbox(CP.u0, CP.u1, CP.v1 - 0.3, CP.v1, lv[fl2], lv[fl2] + 1.1, farL);
             fbox(CP.u0, CP.u0 + 0.3, CP.v0, CP.v1, lv[fl2], lv[fl2] + 1.1, farL); fbox(CP.u1 - 0.3, CP.u1, CP.v0, CP.v1, lv[fl2], lv[fl2] + 1.1, farL); }
  }
  if(fbA) fbox(fbA.a[0] - 3, fbA.a[0] + 5, CP.v0 + 0.3, CP.v0 + 6, lv[0], lv[3] + 2.6, farL);
  lampPts.forEach(function(p){ fbox(p[0] - 0.1, p[0] + 0.1, p[2] - 0.1, p[2] + 0.1, lv[3], lv[3] + 5, farD); fbox(p[0] - 0.35, p[0] + 0.35, p[2] - 0.35, p[2] + 0.35, lv[3] + 5, lv[3] + 5.2, farL); });
  if(P.depot) fbox(P.depot.shed.u0, P.depot.shed.u1, P.depot.shed.v0, P.depot.shed.v1, Ly, Ly + 4.5, farL);
  if(HQV.hqMerge && HQV.hqMerge.mergeStatic) HQV.hqMerge.mergeStatic(THREE, far);
  tgt = near;

  /* ---- night lights: one Points cloud ---- */
  var pts = [], blink = [], beaconI = -1;
  function pt(u, y, v, hex, kind){ var w = toW(F, u, v); pts.push({x: w[0], y: y, z: w[1], c: new THREE.Color(hex)}); if(kind === "blink") blink.push(pts.length - 1); return pts.length - 1; }
  pt(T.u + 2.4, T.antennaTop + 0.15, T.v, 0xff2a2a, "blink");
  beaconI = pt(T.u, ty + 66.35, T.v, 0xffffff);                           // just over the housing (not inside it)
  for(var a2 = 0; a2 < 8; a2++){ var an2 = (a2 + 0.5)*PI/4; pt(T.u + Math.cos(an2)*5.8, ty + 59, T.v + Math.sin(an2)*5.8, 0x5fe0c8); }
  pt(au, ah + 4.8, av, 0xff2a2a, "blink");
  (P.hangars || []).forEach(function(H){ [H.u0, H.u1].forEach(function(u){ pt(u, Ly + 22.2, (H.v0 + H.v1)/2, 0xff2a2a, "blink"); });
    if(H.open) for(var q = 0; q < 6; q++) pt(H.u0 + 8 + (q % 3)*12, Ly + 15, H.v0 + 15 + Math.floor(q/3)*30, 0xfff1d6); });
  if(P.fire) pt((P.fire.tower.u0 + P.fire.tower.u1)/2, Ly + 30.3, (P.fire.tower.v0 + P.fire.tower.v1)/2, 0xff2a2a, "blink");
  [C.v0 + 1, C.v1 - 1].forEach(function(v){ pt(C.u1 + 0.5, P.top + 0.2, v, 0xff2a2a, "blink"); });
  for(var gv = C.v0 + 4; gv <= C.v1 - 4; gv += 8) pt((C.u0 + C.u1)/2 + 2, roofU((C.u0 + C.u1)/2) - 0.3, gv, 0xfff1d6);   // the gallery's ceiling lights
  for(var su = sky.u0 + 2; su < C.u0; su += 4){ pt(su, sky.roof - 0.3, sky.v - hs + 0.4, 0xfff1d6); pt(su, sky.roof - 0.3, sky.v + hs - 0.4, 0xfff1d6); }
  lampPts.forEach(function(p){ pt(p[0], p[1] - 0.1, p[2], 0xffb060); });
  for(var l2 = 1; l2 < 4; l2++) for(var q2 = 0; q2 < 6; q2++) pt(CP.u0 + 6 + (q2 % 3)*18, lv[l2] - 0.4, CP.v0 + 14 + Math.floor(q2/3)*28, 0xe8f4ff);
  P.bridges.forEach(function(b){ var w = toF(F, b.rot[0], b.rot[1]); pt(w[0], b.y0 + 3.9, w[1], 0xffe2b0); });
  var pos = new Float32Array(pts.length*3), col = new Float32Array(pts.length*3);
  pts.forEach(function(p, i){ pos[i*3] = p.x; pos[i*3 + 1] = p.y; pos[i*3 + 2] = p.z; col[i*3] = p.c.r; col[i*3 + 1] = p.c.g; col[i*3 + 2] = p.c.b; });
  var pg2 = new THREE.BufferGeometry(); pg2.setAttribute("position", new THREE.BufferAttribute(pos, 3)); pg2.setAttribute("color", new THREE.BufferAttribute(col, 3));
  pg2.computeBoundingSphere();
  var ptsM = new THREE.PointsMaterial({size: NIGHT_PX, sizeAttenuation: false, vertexColors: true, transparent: true, depthWrite: false, fog: false, toneMapped: false});
  var points = new THREE.Points(pg2, ptsM); points.name = "airbldg:lights"; points.frustumCulled = false; g.add(points);

  /* ---- state ---- */
  var night = o.night != null ? !!o.night : false, level = 2;
  function apply(){
    nightList.forEach(function(r){ r.m.emissiveIntensity = night ? r.night : r.day; });
    near.visible = level >= 2; bg.visible = level >= 2; carIM.visible = level >= 1; far.visible = level === 1;
    points.visible = night;
  }
  apply();
  var blinkOn = null, beaconPh = -1;
  var api = {
    g: g, plan: P,
    setBridge: function(id, k, snap){
      var i = bIndex[String(id)]; if(i == null) return false;
      bk[i].want = clamp01(k); if(snap){ bk[i].k = bk[i].want; bk[i].dirty = true; flushBridges(); }
      return true;
    },
    setBoard: function(lines){
      var sh = c.short || function(s, n){ s = String(s || ""); return s.length > n ? s.slice(0, n) : s; };
      boardLines = (Array.isArray(lines) ? lines : []).slice(0, 5).map(function(l){ return sh(Array.isArray(l) ? l.join("  ") : String(l == null ? "" : l), 40); });
      drawBoard();
    },
    setNight: function(n){ night = !!n; apply(); },
    setDetail: function(lv2){ lv2 = lv2 | 0; level = lv2 >= 2 ? 2 : lv2 <= 0 ? 0 : 1; apply(); },
    update: function(dt, t, motion){
      dt = Math.max(0, +dt || 0); t = +t || 0; var mo = motion == null ? 1 : +motion || 0;
      var kk = 1 - Math.exp(-RATE*dt);
      for(var i = 0; i < nb; i++){
        var b = bk[i]; if(b.k === b.want) continue;
        b.k += (b.want - b.k)*kk; if(Math.abs(b.want - b.k) < 1e-4) b.k = b.want;
        b.dirty = true;
      }
      if(level >= 2) flushBridges();
      dish.rotation.y = mo > 0 ? (t*A.rate) % (2*PI) : 0;
      beacon.rotation.y = mo > 0 ? (t*PI/1.1) % (2*PI) : 0;
      if(!night) return;
      var on = (t % 1) < 0.5, ph = (t % 2.2)/2.2, fl = ph < 0.1 ? 0 : (ph >= 0.5 && ph < 0.6) ? 1 : 2, C2 = pg2.attributes.color;
      if(on !== blinkOn){ blinkOn = on; blink.forEach(function(i){ var p = pts[i], s = on ? 1 : 0.08; C2.setXYZ(i, p.c.r*s, p.c.g*s, p.c.b*s); }); C2.needsUpdate = true; }
      if(fl !== beaconPh){ beaconPh = fl; C2.setXYZ(beaconI, fl === 0 ? 1 : fl === 1 ? 0.17 : 0.05, fl === 0 ? 1 : fl === 1 ? 1 : 0.07, fl === 0 ? 1 : fl === 1 ? 0.48 : 0.05); C2.needsUpdate = true; }
    },
    // the cab door's sill (world) from the drawn instance, for tests and tools
    bridgeDoor: function(id){
      var i = bIndex[String(id)]; if(i == null) return null;
      flushBridges();
      var m = new THREE.Matrix4(); IM.cab.getMatrixAt(i, m); var v = new THREE.Vector3(0, 0, 0).applyMatrix4(m);
      return {x: v.x, y: v.y, z: v.z, k: bk[i].k};
    },
    stats: function(){ return {level: level, night: night, bridges: nb, cars: cars.length, lights: pts.length, draws: HQV.hqMerge ? HQV.hqMerge.drawCount(g) : null}; },
    dispose: function(){
      var seen = [];
      g.traverse(function(m){
        if(m.geometry) m.geometry.dispose();
        var ms = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
        ms.forEach(function(x){ if(seen.indexOf(x) < 0){ seen.push(x); x.dispose(); } });
      });
      Object.keys(mats).forEach(function(k){ if(seen.indexOf(mats[k]) < 0) mats[k].dispose(); });
      textures.forEach(function(t){ if(t && t.dispose) t.dispose(); });
      if(g.parent) g.parent.remove(g);
    }
  };
  return api;
}

HQV.hqAirbldg = {plan: plan, floorAt: floorAt, blockedAt: blockedAt, roofAt: roofAt, gateSpot: gateSpot, bridgePose: bridgePose, cabBox: cabBox, create: create,
  NAVE: NAVE, toFrame: function(L, x, z){ return toF(frameOf(L), x, z); }, toWorld: function(L, u, v){ return toW(frameOf(L), u, v); },
  K: {DRUM_OUT: DRUM_OUT, DRUM_BACK: DRUM_BACK, DRUM_R: DRUM_R, COL_R: COL_R, CAB_D: CAB_D, CAB_W: CAB_W, BOGIE_R: BOGIE_R, BOGIE_BACK: BOGIE_BACK, RET_LEN: RET_LEN, DOOR: DOOR}};
})();
