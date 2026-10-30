/* Claude HQ: the airfield (HQV.hqAirfield). Pure: no THREE, no DOM.
 *
 * One layout L for drawing, walking and flying the Commons airport (docs/plans/airport-spec.md, sections 2, 3, 7, 10).
 * The landside terminal stays on the civic site; everything airside is a reclaimed platform offshore, one slab at L.y,
 * with a 1600 m runway (18/36) parallel to the coast. tools/airfield_fixture.js is the reference generator and
 * tests/fixtures/airfield_commons.json its output for claude-hq@2; layout() reproduces it.
 *
 *   layout(W, site)              -> L | {ok: false, why}       (W: a packed world, site: its airport site or null)
 *   toFrame(L, x, z) -> [u, v]   toWorld(L, u, v) -> [x, z]    the site frame: world = o + u*B + v*T
 *   floorAt(L, x, z)             -> L.y on a platform polygon or an approach/localizer pier, else null
 *   onPavement(L, x, z)          -> "runway"|"taxiway"|"road"|"apron"|null   (taxiway = centreline ± width/2)
 *   shoulderAt(L, x, z)          -> "runway"|"taxiway"|null    on a shoulder and not on pavement
 *   landsideAt(L, x, z)          -> the landside's drawn surface over the ground (m: curb walk 0.3, its roads 0.15) | null
 *   landsideRoads(site)          -> {access, forecourt, roadW} from the site alone (hqnav routes on them) | null
 *   curbDoor(site)               -> {x, z, yaw}: the drop-off curb's middle, the terminal's door for arriving | null
 *   airsideY(L, x, z, ground)    -> a planned airport's airside entrance road's top off the platform (L.airside: from the
 *                                forecourt round to the apron's service road through the security gate), ramped up to
 *                                the platform where the land falls away | null;  airsideWall(L, x, z, ground) its parapet
 *   end(L, standId, endIdx, cx, cz, {stopDist})   -> the v2 end (7.3) in archipelago metres, or null
 *   uturns(L) -> {"A1/AB", "A6/AB": [[x, z]...]}  the arrivals' U-turn from A onto B at each end link (not in L.curves:
 *                                the fixture's A?/A and A?/B fillets overlap there); painted with the curves
 *   runwayEnd(world, ms) -> 0|1  windAt(world, ms, L?) -> {end, yaw, speed}
 *   timetable(world, dests, fromMs, toMs) -> [{id, type, cls, stand, end, tRunway, slot, period, airframe, airline, reg, far}]
 *   SLOT, PERIOD, GAP (s), slotBase(world, m), slotAt(world, ms), hash(s)
 *
 * Frame: yaw 0 faces +z and grows toward +x (hqair). Site frame: B = -front (out from the city), T = [B.z, -B.x].
 */
(function(){
"use strict";
var HQV = window.HQV = window.HQV || {};

/* ---------- small helpers ---------- */
function hyp(x, z){ return Math.sqrt(x*x + z*z); }
function r3(x){ return Math.round(x*1000)/1000; }
function mod(a, n){ return ((a % n) + n) % n; }
function hash(s){ s = String(s == null ? "" : s); var h = 2166136261; for(var i = 0; i < s.length; i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h; }
function inPoly(P, x, z){
  var c = false;
  if(!P || !P.length) return false;
  for(var i = 0, j = P.length - 1; i < P.length; j = i++){
    var a = P[i], b = P[j];
    if((a[1] > z) !== (b[1] > z) && x < (b[0] - a[0])*(z - a[1])/(b[1] - a[1]) + a[0]) c = !c;
  }
  return c;
}
function wrap(a){ while(a > Math.PI) a -= 2*Math.PI; while(a <= -Math.PI) a += 2*Math.PI; return a; }

/* ---------- the layout (a port of tools/airfield_fixture.js; offsets relative to RU exactly as there) ---------- */
// RU_PLAN: a planned runway's distance (m) from the terminal (backend v5/airport.rs TERMINAL_CM)
var RU_PLAN = 317;
var CLEAR = 6, SEA = -4, LEN = 1600, RW_W = 45, SH = 7.5, PAD = 60, GATE_FLOOR = 5.0, R_TURN = 40, R_LEAD = 30, R_EXIT = 300, R_JOIN = 150;

function arc(c, r, a0, a1, out){
  var n = Math.max(2, Math.ceil(Math.abs(a1 - a0)*r/2));
  for(var i = 0; i <= n; i++){ var a = a0 + (a1 - a0)*i/n; out.push([c[0] + r*Math.cos(a), c[1] + r*Math.sin(a)]); }
  return out;
}
// the fillet (frame) at corner P from incoming unit d1 to outgoing unit d2, radius R: points from tangent-in to tangent-out
function fillet(P, d1, d2, R){
  var cr = d1[0]*d2[1] - d1[1]*d2[0], dot = d1[0]*d2[0] + d1[1]*d2[1], th = Math.atan2(Math.abs(cr), dot), t = R*Math.tan(th/2);
  var p0 = [P[0] - d1[0]*t, P[1] - d1[1]*t], s = cr > 0 ? 1 : -1, n1 = [-s*d1[1], s*d1[0]], c = [p0[0] + n1[0]*R, p0[1] + n1[1]*R];
  var a0 = Math.atan2(p0[1] - c[1], p0[0] - c[0]), p1 = [P[0] + d2[0]*t, P[1] + d2[1]*t], a1 = a0 + s*th;
  var pts = arc(c, R, a0, a1, []); pts[0] = p0; pts[pts.length - 1] = p1;
  return {pts: pts, t: t};
}
function unitv(a, b){ var l = Math.hypot(b[0] - a[0], b[1] - a[1]); return [(b[0] - a[0])/l, (b[1] - a[1])/l]; }

// the landside roads (site frame m): the forecourt loop, its curb lane at u LS_CURB_U, and the access road out to the
// street; on a planned (City Gen v5) airport the access starts where the generator's Terminal Road ends (backend
// v5/doc.rs ACCESS_UV: u -152, a road's half width short of the airport's box)
var LS_FORECOURT = [[-88, -62], [-88, 62], [-120, 62], [-120, -62], [-88, -62]], LS_CURB_U = -88, LS_ROAD_W = 8, LS_WALK = 4;
// a planned airport's airside entrance (L.airside): its corners' radius, the apron side it enters by (v), the boom that far
// out of the platform's edge, its top at the platform's service road (hqairport3d Y.road over L.y) and the ramp's grade
// up to it where the land falls away (the road on a walled causeway there)
var AS_R = 12, AS_EDGE_V = -150, AS_GATE_OUT = 2, AS_DECK = 0.08, AS_GRADE = 0.06;
// its parapet's width outside the road, and the height over the land (m) from which it has one (hqairport3d draws it)
var AS_WALL = 0.45, AS_RAISED = 0.3;
function accessOf(site){ return [[site && site.runway && +site.runway.len > 0 ? -152 : -146, -8], [-120, -8]]; }
// the site frame of an airport site (as build): o, B = -front, T = [B.z, -B.x]; null without a front
function siteFrame(site){
  var fr = site && site.front, fl = fr ? Math.hypot(+fr[0] || 0, +fr[1] || 0) : 0;
  if(!(fl > 0) || !isFinite(+site.x) || !isFinite(+site.z)) return null;
  var B = [-fr[0]/fl, -fr[1]/fl];
  return {o: [site.x/100, site.z/100], B: B, T: [B[1], -B[0]]};
}
function siteW(f, u, v){ return [r3(f.o[0] + u*f.B[0] + v*f.T[0]), r3(f.o[1] + u*f.B[1] + v*f.T[1])]; }
// the landside roads of an airport site without its layout (HQV.hqnav routes on them): {access, forecourt, roadW} | null
function landsideRoads(site){
  var f = siteFrame(site); if(!f) return null;
  function W2(pts){ return pts.map(function(p){ return siteW(f, p[0], p[1]); }); }
  return {access: W2(accessOf(site)), forecourt: W2(LS_FORECOURT), roadW: LS_ROAD_W};
}
// where you arrive at the terminal (HQV.hqnav and HQV.hqCity3d doorOf): the drop-off curb's middle, at the curb face
// (the lane's edge, where its sidewalk starts), facing out to the forecourt -> {x, z, yaw} | null without a front
function curbDoor(site){
  var f = siteFrame(site); if(!f) return null;
  var p = siteW(f, LS_CURB_U + LS_ROAD_W/2, 0);
  return {x: p[0], z: p[1], yaw: Math.atan2(-f.B[0], -f.B[1])};
}
// how far over the ground (m) the landside's drawn surfaces stand at (x, z), as hqairport3d draws them on the terrain:
// the curb's sidewalk 0.3 (its 4 m on the terminal side of the curb lane, along the forecourt), the access road and
// the forecourt loop 0.15; null off them
function landsideAt(L, x, z){
  var g = geom(L); if(!g || !g.land) return null;
  x = +x; z = +z;
  if(!isFinite(x) || !isFinite(z) || !inBox(g.land.bb, x, z)) return null;
  var q = toFrame(L, x, z), u = q[0], v = q[1], uW = LS_CURB_U + LS_ROAD_W/2;
  if(u < g.land.u0) return null;                          // short of the access road's street end (drawn from there)
  if(u >= uW && u <= uW + LS_WALK && v >= g.land.v0 && v <= g.land.v1) return 0.3;
  return nearStrip(g.land.roads, x, z, 0) ? 0.15 : null;
}

function findSite(W){
  var S = W && W.sites ? W.sites : [];
  for(var i = 0; i < S.length; i++) if(S[i] && S[i].kind === "airport") return S[i];
  return null;
}

function layout(W, site){
  var WD = HQV.world;
  if(!W || !WD || typeof WD.heightAt !== "function" || typeof WD.surfaceAt !== "function") return {ok: false, why: "no world"};
  site = site || findSite(W);
  if(!site) return {ok: false, why: "no airport site"};
  var fr = site.front, fl = fr ? Math.hypot(+fr[0] || 0, +fr[1] || 0) : 0;
  if(!(fl > 0) || !isFinite(+site.x) || !isFinite(+site.z)) return {ok: false, why: "bad site"};
  try { return build(W, WD, site, fl); }
  catch(e){ return {ok: false, why: "layout failed: " + (e && e.message ? e.message : e)}; }
}

function build(W, WD, site, fl){
  var F = [site.front[0]/fl, site.front[1]/fl], B = [-F[0], -F[1]], T = [B[1], -B[0]], O = [site.x/100, site.z/100];
  var half = +W.half || 0, ySite = (+site.y || 0)/100;
  function wp(u, v){ return [r3(O[0] + u*B[0] + v*T[0]), r3(O[1] + u*B[1] + v*T[1])]; }
  function wd(du, dv){ return [r3(du*B[0] + dv*T[0]), r3(du*B[1] + dv*T[1])]; }
  function yawOf(d){ return r3(Math.atan2(d[0], d[1])); }
  function rect(u0, u1, v0, v1){ return [wp(u0, v0), wp(u1, v0), wp(u1, v1), wp(u0, v1)]; }
  function W2(pts){ return pts.map(function(p){ return wp(p[0], p[1]); }); }
  function airRects(RU){
    return [[RU - 241, RU - 129, -150, 150], [RU - 195, RU - 129, -245, -150], [RU - 180, RU - 129, 150, 245], [RU - 170, RU + 70, -860, 860],
            [RU - 215, RU - 170, -480, -360], [RU - 215, RU - 170, -340, -270], [RU - 215, RU - 170, 320, 470]];
  }
  // the airside, grown by CLEAR, touches no road, sidewalk, lot, block or OTHER site (siteAt only to exempt our own id);
  // the platform (highest ground under it + 0.3, up to 0.1) is at most 0.5 m above the site
  function fits(RU){
    var hi = -1e9, R = airRects(RU);
    for(var k = 0; k < R.length; k++){
      var r = R[k];
      for(var u = r[0] - CLEAR; u <= r[1] + CLEAR + 1e-6; u += 2) for(var v = r[2] - CLEAR; v <= r[3] + CLEAR + 1e-6; v += 2){
        var p = wp(u, v), inner = u >= r[0] && u <= r[1] && v >= r[2] && v <= r[3];
        if(inner) hi = Math.max(hi, WD.heightAt(W, p[0], p[1]));
        if(Math.abs(p[0]) >= half - 2 || Math.abs(p[1]) >= half - 2) continue;
        var s = WD.surfaceAt(W, p[0], p[1]), st = WD.siteAt ? WD.siteAt(W, p[0], p[1]) : null;
        if(s === "road" || s === "sidewalk" || s === "lot" || (WD.blockedAt && WD.blockedAt(W, p[0], p[1])) || (s === "site" && !(st && st.id === site.id))) return null;
      }
    }
    var y = Math.max(Math.ceil((hi + 0.3)*10)/10, SEA + 1.5);
    return y <= ySite + 0.5 ? y : null;
  }
  // City Gen v5 (@4): the runway is planned (site.runway, its length in cm); the terminal stands RU_PLAN from it (the
  // site's x, z), the airfield laid to it: no search, no exits off a short runway (the far-end link), the service
  // buildings drawn in along it, the touchdown and its aids scaled to its length
  var rw = site.runway && +site.runway.len > 0 ? site.runway : null, RL = rw ? (+rw.len)/100 : LEN, KV = RL/LEN;
  var RU = null;
  if(rw) RU = RU_PLAN;
  else for(var ru = 355; ru <= 455 && RU == null; ru += 10) if(fits(ru) != null) RU = ru;
  if(RU == null) return {ok: false, why: "no runway fits"};

  var HALF = RL/2, UA = RU - 110, UB = RU - 152, U_HOLD = RU - 50, U_HOLDPT = U_HOLD - 19, U_STAND = RU - 193;
  var U_CONC0 = RU - 241, U_CONC1 = RU - 223, U_SVC = RU - 218, U_LANE_N = RU - 175, U_LANE_S = RU - 168.5, V_LINK = HALF + 15;
  // design lines (straight centrelines), frame
  var lines = {RWY: [[RU, -HALF], [RU, HALF]], A: [[UA, -V_LINK], [UA, V_LINK]], B: [[UB, -V_LINK], [UB, V_LINK]],
               A1: [[UB, -V_LINK], [RU, -V_LINK]], A6: [[UB, V_LINK], [RU, V_LINK]]};
  var tanE = Math.tan(30*Math.PI/180), dvE = (RU - UA)/tanE;
  var exitDefs = rw ? [] : [{id: "A4", end: "36", along: 1000}, {id: "A5", end: "36", along: 1250}, {id: "A3", end: "18", along: 1000}, {id: "A2", end: "18", along: 1250}];
  exitDefs.forEach(function(e){ var sg = e.end === "36" ? 1 : -1, v0 = sg*(-HALF + e.along); lines[e.id] = [[RU, v0], [UA, v0 + sg*dvE]]; e.v0 = v0; e.sg = sg; });
  // turn curves
  var curves = {};
  function corner(id, P, from, to, R){ var f = fillet(P, from, to, R); curves[id] = f.pts; return f; }
  [-1, 1].forEach(function(sg){
    var Lk = sg < 0 ? "A1" : "A6", vL = sg*V_LINK;
    corner(Lk + "/B", [UB, vL], [0, sg], [1, 0], R_TURN);
    corner(Lk + "/A", [UA, vL], [0, sg], [-1, 0], R_TURN);
    corner(Lk + "/RWY", [RU, vL], [1, 0], [0, -sg], R_TURN);
  });
  exitDefs.forEach(function(e){
    var d = unitv(lines[e.id][0], lines[e.id][1]);
    corner(e.id + "/RWY", [RU, e.v0], [0, e.sg], d, R_EXIT);
    corner(e.id + "/A", [UA, e.v0 + e.sg*dvE], d, [0, e.sg], R_JOIN);
  });
  // stands
  var stands = [], k;
  for(k = 1; k <= 6; k++) stands.push({id: String(k), kind: "contact", v: -110 + 44*(k - 1), span: 36, len: 38, nose: 19.05});
  [[21, -172], [22, -198], [23, -224]].forEach(function(s){ stands.push({id: String(s[0]), kind: "commuter", v: s[1], span: 16, len: 16, nose: 8}); });
  stands.forEach(function(s){
    var u = s.kind === "contact" ? U_STAND : RU - 183;
    s.u = u;
    ["36", "18"].forEach(function(end){
      var sg = end === "36" ? -1 : 1, f = fillet([UB, s.v], [0, sg], [-1, 0], R_LEAD);
      curves["S" + s.id + "/" + end] = f.pts.concat([[u, s.v]]);
    });
  });
  function endOf(id){
    var sg = id === "36" ? 1 : -1, thr = [RU, -sg*HALF], left = id === "36" ? [-1, 0] : [1, 0];
    function at(a, b){ return [thr[0] + left[0]*b, thr[1] + sg*a]; }
    function wpa(a, b){ var p = at(a, b); return wp(p[0], p[1]); }
    var papi = [0, 1, 2, 3].map(function(i){ return wpa(300*KV, RW_W/2 + 15 + 9*i); });
    var appr = []; for(var a = 30; a <= 420; a += 30) appr.push(wpa(-a, 0));
    return {id: id, thr: wp(thr[0], thr[1]), dir: wd(0, sg), left: wd(left[0], left[1]), yaw: yawOf(wd(0, sg)), len: RL,
      lineup: wp(RU, -sg*(V_LINK - R_TURN)), hold: wp(U_HOLDPT, -sg*V_LINK), holdLine: [wp(U_HOLD, -sg*V_LINK - 12.5), wp(U_HOLD, -sg*V_LINK + 12.5)],
      touchdown: r3(330*KV), aim: r3(310*KV),
      exits: exitDefs.filter(function(e){ return e.end === id; }).map(function(e){ return {id: e.id, along: e.along}; })
        .concat([{id: id === "36" ? "A6" : "A1", along: RL + 15}]),
      papi: papi, glideslope: wpa(320*KV, -(RW_W/2 + 37.5)), localizer: wp(RU, sg*(HALF + 100)), windsock: wpa(150*KV, RW_W/2 + 40),
      approach: appr, crossbar: r3(300*KV), pad: [wp(RU, -sg*HALF), wp(RU, -sg*(HALF + PAD))]};
  }
  // (along a planned runway the service row is drawn in to the strip's ends, past the apron's 245 m)
  var KS = rw ? Math.min(1, (HALF + PAD - 10)/480) : 1;
  var air = {
    apron: [rect(U_CONC0, RU - 129, -150, 150), rect(RU - 195, RU - 129, -245, -150), rect(RU - 180, RU - 129, 150, 245)],
    main: [rect(RU - 170, RU + 70, -HALF - PAD, HALF + PAD)],
    service: {fuel: rect(RU - 215, RU - 170, -480*KS, -360*KS), fire: rect(RU - 215, RU - 170, -340*KS, -270*KS), hangars: rect(RU - 215, RU - 170, 320*KS, 470*KS), depot: rect(RU - 180, RU - 170, 150, 245)}
  };
  function sampleMax(poly){
    var xs = poly.map(function(p){ return p[0]; }), zs = poly.map(function(p){ return p[1]; }), hi = -1e9;
    var x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs), z0 = Math.min.apply(null, zs), z1 = Math.max.apply(null, zs);
    for(var x = x0; x <= x1; x += 3) for(var z = z0; z <= z1; z += 3){ if(inPoly(poly, x, z)) hi = Math.max(hi, WD.heightAt(W, x, z)); }
    return hi;
  }
  var service = air.service, svcList = [service.fuel, service.fire, service.hangars, service.depot];
  var polys = air.apron.concat(air.main, svcList), hi = -1e9;
  polys.forEach(function(p){ hi = Math.max(hi, sampleMax(p)); });
  var Y = r3(Math.max(Math.ceil((hi + 0.3)*10)/10, SEA + 1.5));
  function mapObj(o, f){ var r = {}; Object.keys(o).forEach(function(key){ r[key] = f(o[key]); }); return r; }
  // (a planned airfield's apron starts at u 76: the tower and the radar stand landside of it, beside the hall)
  var tw = rw ? wp(20, -110) : wp(95, -100), asr = rw ? wp(20, 110) : wp(110, 110);
  var out = {
    v: 1, ok: true, world: W.id, site: site.id, frame: {o: O, B: wd(1, 0), T: wd(0, 1), RU: RU}, y: Y, ySite: ySite, sea: SEA,
    runway: {c: wp(RU, 0), dir: wd(0, 1), len: RL, w: RW_W, shoulder: SH, pad: PAD, ends: [endOf("36"), endOf("18")]},
    lines: mapObj(lines, W2),
    widths: {RWY: RW_W, A: 18, B: 18, A1: 18, A6: 18, A2: 18, A3: 18, A4: 18, A5: 18, shoulder: 3.5},
    curves: mapObj(curves, W2),
    stands: stands.map(function(s){
      var o = wp(s.u, s.v);
      return {id: s.id, kind: s.kind, x: o[0], z: o[1], yaw: yawOf(wd(-1, 0)), span: s.span, len: s.len,
        nose: wp(s.u - s.nose, s.v), stop: [wp(s.u - s.nose, s.v - 3), wp(s.u - s.nose, s.v + 3)],
        box: rect(s.u - s.nose - 3, s.u - s.nose + s.len + 3, s.v - s.span/2 - 4, s.v + s.span/2 + 4),
        lead: {"36": "S" + s.id + "/36", "18": "S" + s.id + "/18"}};
    }),
    apron: air.apron, platform: air.apron.concat(air.main, svcList), service: service,
    concourse: rect(U_CONC0, U_CONC1, -150, 150),
    serviceRoad: W2([[U_LANE_S, -240], [U_LANE_S, -141], [U_SVC, -141], [U_SVC, 141], [U_LANE_N, 141], [U_LANE_N, 240]]), serviceRoadW: 6,
    landside: {
      terminal: rect(-66, 66, -18, 18), canopy: rect(-80, -66, -19.5, 19.5), skybridge: {a: wp(66, 0), b: wp(U_CONC0, 0), w: 8, floor: GATE_FLOOR},
      forecourt: W2(LS_FORECOURT), access: W2(accessOf(site)), roadW: LS_ROAD_W,
      curb: {dropoff: W2([[LS_CURB_U, -20], [LS_CURB_U, 20]]), taxi: W2([[-88, 24], [-88, 56]]), bus: W2([[-88, -56], [-88, -24]])},
      carpark: rect(-60, -4, 30, 86), carparkBridge: W2([[-40, 18], [-40, 30]]),
      tower: {x: tw[0], z: tw[1], h: 66}, asr: {x: asr[0], z: asr[1], h: 25}
    },
    keepOut: {capsule: {a: wp(RU, -HALF - 420), b: wp(RU, HALF + 420), r: 180},
              corridors: [{a: wp(RU, -HALF), b: wp(RU, -HALF - 4000), r: 250}, {a: wp(RU, HALF), b: wp(RU, HALF + 4000), r: 250}]}
  };
  if(rw){
    // the runway runs out over the sea: where there is no land under it the platform is a pier deck (hqairport3d)
    out.pier = true;
    // the airside entrance: off the forecourt's -v leg, round to the apron's service road (its corner at U_SVC, -141),
    // through the security gate where it meets the platform's land edge (the apron's side at v -150)
    var A0 = [-104, -62], A1 = [-104, -200], A2 = [U_SVC, -200], A3 = [U_SVC, -141];
    var f1 = fillet(A1, [0, -1], [1, 0], AS_R), f2 = fillet(A2, [1, 0], [0, 1], AS_R);
    var ap = [A0].concat(f1.pts, f2.pts, [[U_SVC, AS_EDGE_V], A3]), cum = 0;
    for(k = 1; k < ap.length - 1; k++) cum += Math.hypot(ap[k][0] - ap[k - 1][0], ap[k][1] - ap[k - 1][1]);
    // the boom AS_GATE_OUT m out of the edge (its pivot on the guard post's side, its rest across the road, each
    // post's foot on the land: y the road's top there), the guard post beside the pivot outside the fence (the apron
    // inside it is the buses' stop), on a plinth up from the land (g its lowest) to the road's level
    var ga = wp(U_SVC + LS_ROAD_W/2 + 0.6, AS_EDGE_V - AS_GATE_OUT), gb = wp(U_SVC - LS_ROAD_W/2 - 0.6, AS_EDGE_V - AS_GATE_OUT), gc = wp(U_SVC, AS_EDGE_V - AS_GATE_OUT);
    var gy = r3(Math.max(WD.heightAt(W, gc[0], gc[1]) + 0.15, Y + AS_DECK - AS_GATE_OUT*AS_GRADE));
    out.airside = {road: W2(ap), roadW: LS_ROAD_W, sEdge: r3(cum), yEdge: r3(Y + AS_DECK), grade: AS_GRADE,
      gate: {a: ga, b: gb, s: r3(cum - AS_GATE_OUT), y: gy, ga: r3(WD.heightAt(W, ga[0], ga[1])), gb: r3(WD.heightAt(W, gb[0], gb[1]))},
      post: rect(U_SVC + LS_ROAD_W/2 + 1.5, U_SVC + LS_ROAD_W/2 + 5.5, AS_EDGE_V - AS_GATE_OUT - 4.4, AS_EDGE_V - AS_GATE_OUT - 0.4)};
    out.airside.gate.pg = r3(Math.min.apply(null, out.airside.post.map(function(q){ return WD.heightAt(W, q[0], q[1]); })));
  }
  return out;
}

/* ---------- frame ---------- */
function frameOf(L){ var f = L && L.frame; return f && f.o && f.B && f.T ? f : null; }
function toFrame(L, x, z){
  var f = frameOf(L); if(!f) return [0, 0];
  var dx = (+x || 0) - f.o[0], dz = (+z || 0) - f.o[1];
  return [dx*f.B[0] + dz*f.B[1], dx*f.T[0] + dz*f.T[1]];
}
function toWorld(L, u, v){
  var f = frameOf(L); if(!f) return [0, 0];
  u = +u || 0; v = +v || 0;
  return [f.o[0] + u*f.B[0] + v*f.T[0], f.o[1] + u*f.B[1] + v*f.T[1]];
}

/* ---------- derived geometry, cached on L (non-enumerable, so L still deep-equals the fixture) ---------- */
function bbox(pts, m){
  var b = [1e18, -1e18, 1e18, -1e18];
  for(var i = 0; i < pts.length; i++){ b[0] = Math.min(b[0], pts[i][0]); b[1] = Math.max(b[1], pts[i][0]); b[2] = Math.min(b[2], pts[i][1]); b[3] = Math.max(b[3], pts[i][1]); }
  b[0] -= m; b[1] += m; b[2] -= m; b[3] += m; return b;
}
function inBox(b, x, z){ return x >= b[0] && x <= b[1] && z >= b[2] && z <= b[3]; }
function segDist(a, b, x, z){
  var dx = b[0] - a[0], dz = b[1] - a[1], l2 = dx*dx + dz*dz, t = l2 > 0 ? ((x - a[0])*dx + (z - a[1])*dz)/l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return hyp(x - a[0] - dx*t, z - a[1] - dz*t);
}
function lineDist(P, x, z){ var d = 1e18; for(var i = 1; i < P.length; i++) d = Math.min(d, segDist(P[i - 1], P[i], x, z)); return d; }
// a strip: polyline P with half width hw (+ margin m for the bbox)
function strip(P, hw, m){ return {P: P, hw: hw, bb: bbox(P, hw + (m || 0))}; }
function inRectAxes(c, d, hl, hw, x, z){   // a rectangle centred c, unit along d, half length hl along d, half width hw across
  var dx = x - c[0], dz = z - c[1];
  return Math.abs(dx*d[0] + dz*d[1]) <= hl && Math.abs(dx*d[1] - dz*d[0]) <= hw;
}

function geom(L){
  if(!L || L.ok === false) return null;
  if(L._g) return L._g;
  var g = {platform: [], apron: [], taxi: [], roads: [], piers: [], heads: [], rw: null, shoulder: 3.5};
  (L.platform || []).forEach(function(p){ if(p && p.length >= 3) g.platform.push({P: p, bb: bbox(p, 0)}); });
  (L.apron || []).forEach(function(p){ if(p && p.length >= 3) g.apron.push({P: p, bb: bbox(p, 0)}); });
  var wid = L.widths || {}, sh = wid.shoulder != null ? +wid.shoulder : 3.5;
  g.shoulder = sh;
  Object.keys(L.lines || {}).forEach(function(id){
    if(id === "RWY") return;
    g.taxi.push(strip(L.lines[id], (wid[id] != null ? +wid[id] : 18)/2, sh));
  });
  Object.keys(L.curves || {}).forEach(function(id){
    if(id.charAt(0) === "S") return;                       // stand lead-ins are apron taxilanes, not taxiway pavement
    var base = id.split("/")[0];
    g.taxi.push(strip(L.curves[id], (wid[base] != null ? +wid[base] : 18)/2, sh));
  });
  if(L.serviceRoad && L.serviceRoad.length >= 2) g.roads.push(strip(L.serviceRoad, (+L.serviceRoadW || 6)/2, 0));
  var ls = L.landside || {}, rw2 = (+ls.roadW || 8)/2, lr = [];
  if(ls.access && ls.access.length >= 2) lr.push(strip(ls.access, rw2, 0));
  if(ls.forecourt && ls.forecourt.length >= 2) lr.push(strip(ls.forecourt, rw2, 0));
  lr.forEach(function(s){ g.roads.push(s); });
  // the landside's drawn surfaces (landsideAt): its road strips, the forecourt's v span and the box round them and the walk
  if(lr.length && L.frame){
    var lv = [Infinity, -Infinity], lp = [];
    lr.forEach(function(s){ s.P.forEach(function(p){ lp.push(p); }); });
    (ls.forecourt || []).forEach(function(p){ var q = toFrame(L, p[0], p[1]); lv[0] = Math.min(lv[0], q[1]); lv[1] = Math.max(lv[1], q[1]); });
    g.land = {roads: lr, v0: lv[0], v1: lv[1], bb: bbox(lp, rw2 + LS_WALK + 1), u0: ls.access && ls.access.length ? toFrame(L, ls.access[0][0], ls.access[0][1])[0] : -Infinity};
  }
  // the airside entrance (a planned airport): its centreline with arc lengths; on the platform it is service road
  var AS = L.airside;
  if(AS && AS.road && AS.road.length >= 2){
    var ahw = (+AS.roadW || 8)/2, aS = [0];
    for(var ai = 1; ai < AS.road.length; ai++) aS.push(aS[ai - 1] + hyp(AS.road[ai][0] - AS.road[ai - 1][0], AS.road[ai][1] - AS.road[ai - 1][1]));
    g.air = {P: AS.road, S: aS, hw: ahw, sEdge: +AS.sEdge || 0, yEdge: +AS.yEdge || 0, grade: +AS.grade || 0.06, bb: bbox(AS.road, ahw + 1)};
    g.roads.push(strip(AS.road.slice(-2), ahw, 0));
  }
  var R = L.runway;
  if(R && R.c && R.dir){
    g.rw ={c: R.c, d: R.dir, hl: (+R.len || 0)/2 + (+R.pad || 0), hw: (+R.w || 0)/2, sh: +R.shoulder || 0};
    (R.ends || []).forEach(function(E){
      if(!E) return;
      var ap = E.approach || [], pe = E.pad && E.pad[1];
      if(pe && ap.length) g.piers.push(strip([pe, ap[ap.length - 1]], 1.5, 0));
      if(E.localizer && E.dir) g.heads.push({c: E.localizer, d: E.dir, hl: 5, hw: 17});
    });
  }
  try { Object.defineProperty(L, "_g", {value: g, enumerable: false, configurable: true, writable: true}); } catch(e){ /* frozen: no cache */ }
  return g;
}

/* ---------- ground queries ---------- */
function floorAt(L, x, z){
  var g = geom(L), i;
  if(!g) return null;
  x = +x; z = +z;
  if(!isFinite(x) || !isFinite(z)) return null;
  for(i = 0; i < g.platform.length; i++) if(inBox(g.platform[i].bb, x, z) && inPoly(g.platform[i].P, x, z)) return L.y;
  for(i = 0; i < g.piers.length; i++){ var s = g.piers[i]; if(inBox(s.bb, x, z) && lineDist(s.P, x, z) <= s.hw) return L.y; }
  for(i = 0; i < g.heads.length; i++){ var h = g.heads[i]; if(inRectAxes(h.c, h.d, h.hl, h.hw, x, z)) return L.y; }
  return null;
}
// the airside entrance (L.airside): the nearest point of its centreline to (x, z) -> {d, s (arc length)}
function airsideNear(a, x, z){
  var best = null;
  for(var i = 1; i < a.P.length; i++){
    var p = a.P[i - 1], q = a.P[i], dx = q[0] - p[0], dz = q[1] - p[1], l2 = dx*dx + dz*dz, t = l2 > 0 ? ((x - p[0])*dx + (z - p[1])*dz)/l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    var d = hyp(x - p[0] - dx*t, z - p[1] - dz*t);
    if(!best || d < best.d) best = {d: d, s: a.S[i - 1] + Math.sqrt(l2)*t};
  }
  return best;
}
// its top at arc length s over ground gy: the landside's 0.15 on the land, and up its ramp (grade) to the platform's
// service road at the platform's edge (sEdge) where the land falls away
function airsideTop(a, s, gy){ return Math.max(gy + 0.15, a.yEdge - Math.max(0, a.sEdge - s)*a.grade); }
function groundOf(ground, x, z){ var h = typeof ground === "function" ? +ground(x, z) : +ground; return isFinite(h) ? h : 0; }
// the entrance road's drawn top (m) at (x, z) off the platform (ground: the terrain's height, a function or a number),
// or null off it and on the platform (floorAt's there)
function airsideY(L, x, z, ground){
  var g = geom(L), a = g && g.air; if(!a) return null;
  x = +x; z = +z;
  if(!isFinite(x) || !isFinite(z) || !inBox(a.bb, x, z)) return null;
  var q = airsideNear(a, x, z);
  if(!q || q.d > a.hw || q.s > a.sEdge) return null;
  return airsideTop(a, q.s, groundOf(ground, x, z));
}
// on the parapet of its causeway (just outside the road, where it stands over 0.3 m above the land): what a vehicle
// runs into instead of driving off the side
function airsideWall(L, x, z, ground){
  var g = geom(L), a = g && g.air; if(!a) return false;
  x = +x; z = +z;
  if(!isFinite(x) || !isFinite(z) || !inBox(a.bb, x, z)) return false;
  var q = airsideNear(a, x, z);
  if(!q || q.d <= a.hw || q.d > a.hw + AS_WALL || q.s >= a.sEdge) return false;
  var gy = groundOf(ground, x, z);
  return airsideTop(a, q.s, gy) - gy > AS_RAISED;
}
function onRunway(g, x, z, extra){
  var r = g.rw; if(!r) return false;
  return inRectAxes(r.c, r.d, r.hl, r.hw + (extra || 0), x, z);
}
function nearStrip(list, x, z, extra){
  for(var i = 0; i < list.length; i++){ var s = list[i]; if(inBox(s.bb, x, z) && lineDist(s.P, x, z) <= s.hw + (extra || 0)) return true; }
  return false;
}
function onPavement(L, x, z){
  var g = geom(L);
  if(!g) return null;
  x = +x; z = +z;
  if(!isFinite(x) || !isFinite(z)) return null;
  if(onRunway(g, x, z, 0)) return "runway";
  if(nearStrip(g.taxi, x, z, 0)) return "taxiway";
  if(nearStrip(g.roads, x, z, 0)) return "road";
  for(var i = 0; i < g.apron.length; i++) if(inBox(g.apron[i].bb, x, z) && inPoly(g.apron[i].P, x, z)) return "apron";
  return null;
}
// a runway or taxiway shoulder (not pavement for taxiing, but no vehicle ground either)
function shoulderAt(L, x, z){
  var g = geom(L);
  if(!g) return null;
  x = +x; z = +z;
  if(!isFinite(x) || !isFinite(z)) return null;
  if(onRunway(g, x, z, 0) || nearStrip(g.taxi, x, z, 0)) return null;
  if(g.rw && onRunway(g, x, z, g.rw.sh)) return "runway";
  if(nearStrip(g.taxi, x, z, g.shoulder)) return "taxiway";
  return null;
}

/* ---------- ends (7.3): polylines built only from L.lines and L.curves (drawn = flown) ---------- */
var JET_TOUCH = 64, JET_DEC = 2.6, EXIT_V = 15, STEP_MAX = 5;
function same(a, b, eps){ return Math.abs(a[0] - b[0]) <= eps && Math.abs(a[1] - b[1]) <= eps; }
function rev(P){ return (P || []).slice().reverse(); }
function copyPts(P){ return (P || []).map(function(p){ return [p[0], p[1]]; }); }
function headOut(P){ var n = P.length; return n >= 2 ? unitv(P[n - 2], P[n - 1]) : [0, 0]; }
function segX(a, b, c, d){   // the intersection of segments ab and cd: [x, z, t on ab] or null
  var r = [b[0] - a[0], b[1] - a[1]], s = [d[0] - c[0], d[1] - c[1]], den = r[0]*s[1] - r[1]*s[0];
  if(Math.abs(den) < 1e-12) return null;
  var qp = [c[0] - a[0], c[1] - a[1]], t = (qp[0]*s[1] - qp[1]*s[0])/den, u = (qp[0]*r[1] - qp[1]*r[0])/den;
  if(t < 0 || t > 1 || u < 0 || u > 1) return null;
  return [a[0] + r[0]*t, a[1] + r[1]*t];
}
// join path P (in place) to piece Q: straight on when Q starts ahead on P's heading, else splice at their crossing
function join(P, Q){
  if(!Q || !Q.length) return P;
  if(!P.length){ Array.prototype.push.apply(P, copyPts(Q)); return P; }
  var e = P[P.length - 1], q = Q[0];
  if(same(e, q, 0.01)){ Array.prototype.push.apply(P, copyPts(Q.slice(1))); return P; }
  var h = headOut(P), w = [q[0] - e[0], q[1] - e[1]], fwd = w[0]*h[0] + w[1]*h[1], side = Math.abs(w[0]*h[1] - w[1]*h[0]);
  if(P.length < 2 || (fwd > 0 && side < 0.5)){ Array.prototype.push.apply(P, copyPts(Q)); return P; }
  // the pieces overlap (two fillets on a short link): leave P where it crosses Q
  for(var i = 1; i < P.length; i++) for(var j = 1; j < Q.length; j++){
    var X = segX(P[i - 1], P[i], Q[j - 1], Q[j]);
    if(X){ P.length = i; P.push(X); Array.prototype.push.apply(P, copyPts(Q.slice(j))); return P; }
  }
  Array.prototype.push.apply(P, copyPts(Q));
  return P;
}
function densify(P, cx, cz){
  var out = [];
  for(var i = 0; i < P.length; i++){
    var p = [P[i][0] + cx, P[i][1] + cz];
    if(out.length){
      var a = out[out.length - 1], d = hyp(p[0] - a[0], p[1] - a[1]);
      if(d < 1e-6) continue;
      var n = Math.ceil(d/STEP_MAX - 1e-9);
      for(var k = 1; k < n; k++) out.push([a[0] + (p[0] - a[0])*k/n, a[1] + (p[1] - a[1])*k/n]);
    }
    out.push(p);
  }
  return out;
}
function alongOf(E, p){ return (p[0] - E.thr[0])*E.dir[0] + (p[1] - E.thr[1])*E.dir[1]; }
function offOf(E, p){ return Math.abs((p[0] - E.thr[0])*E.dir[1] - (p[1] - E.thr[1])*E.dir[0]); }
// the link whose runway fillet ends at E.lineup (where departures from E line up)
function depLinkOf(L, E){
  var C = L.curves || {}, ids = Object.keys(C);
  for(var i = 0; i < ids.length; i++){
    var m = /^(.+)\/RWY$/.exec(ids[i]);
    if(m && C[ids[i]].length && same(C[ids[i]][C[ids[i]].length - 1], E.lineup, 0.5)) return m[1];
  }
  return null;
}
// the runway fillet of exit id, oriented to leave the centreline (the far-end link's fillet runs the other way)
function exitCurve(L, E, id){
  var C = (L.curves || {})[id + "/RWY"];
  if(!C || C.length < 2) return null;
  return offOf(E, C[0]) <= offOf(E, C[C.length - 1]) ? copyPts(C) : rev(C);
}
// the U-turn from A onto B at a link (an arrival's turn off A, along the link and back down B). A and B are only 42 m
// apart, so the two R 40 fillets A?/A and A?/B overlap; this one arc of radius (B - A)/2, tangent to A, the link's
// centreline and B, replaces them. Painted and lit with the other curves (uturns(L)). sg: +1 the +v link, -1 the -v one.
function uturnOf(L, link){
  var A = L.lines && L.lines.A, Bl = L.lines && L.lines.B, K = L.lines && L.lines[link], f = frameOf(L);
  if(!A || !Bl || !K || !f) return null;
  var uA = toFrame(L, A[0][0], A[0][1])[0], uB = toFrame(L, Bl[0][0], Bl[0][1])[0], vL = toFrame(L, K[0][0], K[0][1])[1];
  var sg = vL >= 0 ? 1 : -1, um = (uA + uB)/2, rt = Math.abs(uA - uB)/2, vc = vL - sg*rt, n = Math.max(4, Math.ceil(Math.PI*rt/2)), out = [];
  for(var i = 0; i <= n; i++){ var ph = Math.PI*i/n, q = toWorld(L, um + (uA - um)*Math.cos(ph), vc + sg*rt*Math.sin(ph)); out.push([r3(q[0]), r3(q[1])]); }
  return out;
}
function uturns(L){
  var out = {};
  if(!L || L.ok === false || !L.lines) return out;
  ["A1", "A6"].forEach(function(k){ var u = uturnOf(L, k); if(u) out[k + "/AB"] = u; });
  return out;
}
function stopDistOf(o){ return o && o.stopDist != null && isFinite(+o.stopDist) ? +o.stopDist : (JET_TOUCH*JET_TOUCH - EXIT_V*EXIT_V)/(2*JET_DEC); }

function end(L, standId, endIdx, cx, cz, o){
  if(!L || L.ok === false || !L.runway || !L.curves || !L.lines) return null;
  var E = (L.runway.ends || [])[endIdx | 0], st = null, i;
  for(i = 0; i < (L.stands || []).length; i++) if(String(L.stands[i].id) === String(standId)) st = L.stands[i];
  if(!E || !st || !st.lead) return null;
  cx = +cx || 0; cz = +cz || 0;
  var C = L.curves, S = C[st.lead[E.id]], dl = depLinkOf(L, E), far = E.exits && E.exits.length ? E.exits[E.exits.length - 1].id : null;
  if(!S || !dl || !far || !C[dl + "/B"] || !C[dl + "/RWY"] || !C[far + "/A"] || !C[far + "/B"]) return null;
  // departure: push back along the lead-in, B to the link, the link to the hold; then the link and its fillet to line-up
  var push = rev(S), taxi = [push[push.length - 1]];
  join(taxi, C[dl + "/B"]); join(taxi, [E.hold]);
  var line = [E.hold];
  join(line, C[dl + "/RWY"]);
  var lu = line[line.length - 1];
  line[line.length - 1] = [E.lineup[0], E.lineup[1]];
  if(hyp(lu[0] - E.lineup[0], lu[1] - E.lineup[1]) < 0.5) line.splice(line.length - 1, 0, [E.lineup[0] - E.dir[0]*0.5, E.lineup[1] - E.dir[1]*0.5]);
  // arrival: the first exit whose fillet starts at least td + stopDist past the threshold (else the far-end link)
  var td = E.touchdown != null ? +E.touchdown : 330, need = td + stopDistOf(o), ex = null, exC = null, exitAt = null;
  for(i = 0; i < E.exits.length; i++){
    var c = exitCurve(L, E, E.exits[i].id);
    if(!c) continue;
    var a = alongOf(E, c[0]);
    ex = E.exits[i]; exC = c; exitAt = a;
    if(a >= need) break;
  }
  if(!exC) return null;
  var exit = copyPts(exC), atax;
  if(ex.id !== far && C[ex.id + "/A"]){
    join(exit, C[ex.id + "/A"]);                                   // exit line + the join onto A (heading E.dir)
    atax = [exit[exit.length - 1]];
    var ut = uturnOf(L, far);
    if(ut) join(atax, ut);                                         // A to the far link, the U-turn onto B
    else { join(atax, C[far + "/A"]); join(atax, rev(C[far + "/B"])); }
  } else {
    // the far-end link: the reversed runway fillet, then along the link to where it crosses A
    var A = L.lines.A, e0 = exit[exit.length - 1], h = headOut(exit), cr = null;
    if(A && A.length >= 2) cr = segX(e0, [e0[0] + h[0]*1e4, e0[1] + h[1]*1e4], A[0], A[1]);
    if(cr) join(exit, [cr]);
    atax = [exit[exit.length - 1]];
  }
  if(ex.id === far || !C[ex.id + "/A"]) join(atax, rev(C[far + "/B"]));   // off the link onto B, running the flow's way
  join(atax, S);                                                   // B to the stand's lead-in, nose-in to the stand
  var y = L.y;
  return {v: 2, kind: "jet", y: y, site: L.site, end: E.id, stand: {id: st.id, x: st.x + cx, z: st.z + cz, yaw: st.yaw},
    dep: {push: densify(push, cx, cz), taxi: densify(taxi, cx, cz), line: densify(line, cx, cz), dir: [E.dir[0], E.dir[1]],
          len: E.len - alongOf(E, E.lineup)},
    arr: {thr: [E.thr[0] + cx, E.thr[1] + cz], dir: [E.dir[0], E.dir[1]], td: td, exitAt: exitAt, exitId: ex.id,
          exit: densify(exit, cx, cz), taxi: densify(atax, cx, cz)}};
}

/* ---------- periods, runway in use, wind (7.1) ---------- */
var SLOT = 240, SLOTS = 8, GAP = 480, PERIOD = SLOT*SLOTS + GAP;   // seconds
var OFF = {jetArr: 0, comDep: 60, jetDep: 120, comArr: 180};        // seconds into a slot
var AIRWAYS = [-2.6, -2.05, -1.57, -1.1, -0.55];                    // jets' outbound bearings (yaw, rad): seaward of the Commons
var AIRLINES = ["Archipelago Air", "Tokenline", "Context Airways", "Gradient Air"], COMMUTER = "Isle Hopper";
var COMMONS_YAW = [0, Math.PI];
function T0(world){ return hash(String(world) + "|slots") % (PERIOD*1000); }
function slotBase(world, m){
  m = Math.floor(+m || 0);
  var p = Math.floor(m/SLOTS);
  return T0(world) + p*PERIOD*1000 + mod(m, SLOTS)*SLOT*1000;
}
// the slot whose base is the latest at or before ms (inside a gap: the period's last slot)
function slotAt(world, ms){
  var rel = (+ms || 0) - T0(world), p = Math.floor(rel/(PERIOD*1000)), k = Math.floor((rel - p*PERIOD*1000)/(SLOT*1000));
  return p*SLOTS + Math.min(SLOTS - 1, Math.max(0, k));
}
function periodAt(world, ms){ return Math.floor(((+ms || 0) - T0(world))/(PERIOD*1000)); }
function runwayEnd(world, ms){
  var pre = hash(String(world) + "|wind") % 2;
  return hash(String(world) + "|" + periodAt(world, ms)) % 10 < 7 ? pre : 1 - pre;
}
function windAt(world, ms, L){
  var e = runwayEnd(world, ms), ends = L && L.runway && L.runway.ends, E = ends && ends[e];
  var land = E && isFinite(+E.yaw) ? +E.yaw : COMMONS_YAW[e];
  var h = hash(String(world) + "|gust|" + Math.floor((+ms || 0)/300000));
  var jit = ((h % 1000)/999*2 - 1)*0.35, speed = 3 + ((h >>> 10) % 1000)/999*9;
  return {end: e, yaw: wrap(land + Math.PI + jit), speed: speed};
}

/* ---------- the timetable (7.2) ---------- */
function regOf(world, af){
  var h = hash(String(world) + "|reg|" + af), s = "HQ-";
  for(var i = 0; i < 3; i++){ s += String.fromCharCode(65 + h % 26); h = Math.floor(h/26); }
  return s;
}
function movement(world, m, kind, dests){
  var p = Math.floor(m/SLOTS), base = slotBase(world, m), e = runwayEnd(world, base), N = dests.length, af, mv;
  if(kind === "jetArr" || kind === "jetDep"){
    var arr = kind === "jetArr";
    af = "J" + (arr ? m : m - 4);
    mv = {type: arr ? "arr" : "dep", cls: "jet", stand: String(mod(arr ? m : m - 4, 6) + 1),
          far: AIRWAYS[hash(String(world) + "|far|" + af + "|" + (arr ? "a" : "d")) % AIRWAYS.length],
          airline: AIRLINES[hash(String(world) + "|airline|" + af) % AIRLINES.length]};
  } else {
    if(!N) return null;
    var ca = kind === "comArr";
    af = "C" + (ca ? m : m - 3);
    mv = {type: ca ? "arr" : "dep", cls: "commuter", stand: String(21 + mod(m, 3)), far: dests[mod(ca ? m + 1 : m, N)], airline: COMMUTER};
  }
  mv.id = m + ":" + mv.cls + ":" + mv.type;
  mv.end = e; mv.tRunway = base + OFF[kind]*1000; mv.slot = m; mv.period = p; mv.airframe = af; mv.reg = regOf(world, af);
  return mv;
}
var KINDS_ORDER = ["jetArr", "comDep", "jetDep", "comArr"];
function timetable(world, dests, fromMs, toMs){
  fromMs = +fromMs; toMs = +toMs;
  if(!isFinite(fromMs) || !isFinite(toMs) || toMs < fromMs) return [];
  var D = (dests || []).filter(function(d){ return d != null && d !== ""; }).map(String).sort();
  var m0 = slotAt(world, fromMs) - 1, m1 = slotAt(world, toMs) + 1, out = [];
  if(m1 - m0 > 20000) m1 = m0 + 20000;                               // a guard, not a feature: ~83 days
  for(var m = m0; m <= m1; m++) for(var k = 0; k < KINDS_ORDER.length; k++){
    var mv = movement(world, m, KINDS_ORDER[k], D);
    if(mv && mv.tRunway >= fromMs && mv.tRunway <= toMs) out.push(mv);
  }
  out.sort(function(a, b){ return a.tRunway - b.tRunway; });
  return out;
}

HQV.hqAirfield = {layout: layout, uturns: uturns, toFrame: toFrame, toWorld: toWorld, floorAt: floorAt, onPavement: onPavement, shoulderAt: shoulderAt,
                  landsideAt: landsideAt, landsideRoads: landsideRoads, curbDoor: curbDoor, airsideY: airsideY, airsideWall: airsideWall,
                  airsideTop: function(L, s, gy){ var g = geom(L); return g && g.air ? airsideTop(g.air, +s || 0, +gy || 0) : null; }, AS_WALL: AS_WALL, AS_RAISED: AS_RAISED,
                  end: end, runwayEnd: runwayEnd, windAt: windAt, timetable: timetable, slotBase: slotBase, slotAt: slotAt, periodAt: periodAt,
                  hash: hash, SLOT: SLOT, SLOTS: SLOTS, PERIOD: PERIOD, GAP: GAP, OFF: OFF, AIRWAYS: AIRWAYS, AIRLINES: AIRLINES, COMMUTER: COMMUTER};
})();
