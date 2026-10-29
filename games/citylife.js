/* Claude HQ: city life (HQ 3.21), built AROUND City Gen v4, never into it.
 *
 * Everything here reads the finished world (HQV.world.pack's W: edges, lots, sites, districts) through one adapter
 * and is a pure function of (W, the seed in W.hash, the local clock), so every player sees the same city with no
 * server change. It never reads how the generator laid roads or lots out, so it works on today's @3 worlds and on
 * v4 worlds: v4's road classes are rows in ROAD below, nothing else. Loaded by the page and by the world worker
 * (worldbuild-worker.js, after world.js): no THREE, no DOM.
 *
 *   facts(W)                  the adapter: road(cls) -> {kind, speed}; group(lot | district index) -> "centre" |
 *                             "work" | "home" | "industry" | "green" | "civic"; frontage(lot) -> {edge, kind, corner};
 *                             stopDist(x, z) -> m to the nearest stop or station
 *   landUse(W)                lot id -> {use, ground, group, corner, front}: use "home" | "office" | "warehouse" |
 *                             "workshop"; ground "door" | "shop" | "cafe" | "lobby" | "loading"
 *   litCode(use, r) / LIT_GLSL  a window's lit attribute for its use (r: the window's own 0..1), and the shader that
 *                             lights it by the hour (offices dark at night, homes lit in the evening); litCode("shop" |
 *                             "cafe", r) a shopfront's, lit in its opening hours (shops 9-20, cafes 7-23); litAt in JS
 *   furniture(W)              benches, bins, bike racks, newsstands, food stalls and cafe tables along the kerb-side
 *                             strip of every footpath, chosen by what the lots there are for
 *   hotspots(W)               where people gather and when: cafe terraces, food stalls, stops, school gates, the park,
 *                             the stadium; crowd(spot, ms) -> how many are there at local ms
 *   demand(hour, kind)        traffic intensity 0..1 by local hour and street kind (rush hours, quiet nights): a
 *                             multiplier on the traffic slider, never on capacity
 *   mix(group, kind, hour)    what drives there: {car, taxi, van, lorry, scooter, bike} weights; pick(mix, u)
 *   events(W, ms) / closed(W, ms)  the weekly street market, Sunday's parade and roadworks, the same for everyone at
 *                             the same local time; closed -> {edge id: event kind} (v4: a closed segment's capacity is 0)
 *   signals(W), signalAt(sig, ms, heading), walkAt(sig, ms, heading)  [3.22] traffic lights at the real junctions, a
 *                             60 s two-phase cycle each with a rough green wave along the main roads (see there)
 *   parked(W)                 [3.22] cars parked along the kerbs of the local and shopping streets
 * Units: metres (W stores cm), yaw 0 faces +z, the local clock in ms (npcsim.localMs), hours 0..24.
 */
(function(){
"use strict";
var root = typeof window !== "undefined" ? window : self;
var HQV = root.HQV = root.HQV || {};
function WQ(){ return HQV.world; }
// [3.22.3] the side traffic keeps to (games/traffic.js SIDE, the one switch): -1 the left, 1 the right; the kerb of the
// way of travel is SIDE x its right. Left-hand traffic when traffic.js is not loaded
function driveSide(){ var T = HQV.traffic; return T && (T.SIDE === 1 || T.SIDE === -1) ? T.SIDE : -1; }

/* ---------- the adapter: road classes ---------- */
// kind: "res" a street people live on, "shop" a street people shop on, "main" a through road, "fast" no frontage.
// @1/@2/@3's classes first, then City Gen v4's eleven (a tram version is the same class: normCls drops "+ tram").
var ROAD = {
  street: {kind: "res", speed: 30}, local: {kind: "res", speed: 30}, avenue: {kind: "main", speed: 50},
  arterial: {kind: "main", speed: 50}, highway: {kind: "fast", speed: 100}, ring: {kind: "fast", speed: 80},
  shared: {kind: "shop", speed: 20}, lane: {kind: "res", speed: 25}, collector: {kind: "shop", speed: 50},
  boulevard: {kind: "main", speed: 60}, service: {kind: "res", speed: 30}, expressway: {kind: "fast", speed: 80},
  ramp: {kind: "fast", speed: 50}, flyover: {kind: "fast", speed: 60}, underpass: {kind: "fast", speed: 60}
};
var ALIAS = {"shared-street": "shared", "local-street": "local", "service-road": "service", "slip": "ramp"};
function normCls(c){
  c = String(c == null ? "" : c).toLowerCase().replace(/[\s_]+/g, "-").replace(/[-+]*(with-)?tram$/, "").replace(/-+$/, "");
  return ALIAS[c] || c;
}
function road(cls){ var r = ROAD[normCls(cls)]; return r ? {kind: r.kind, speed: r.speed, known: true} : {kind: "res", speed: 30, known: false}; }

/* ---------- the adapter: districts ---------- */
var GROUP = {downtown: "centre", commercial: "centre", finance: "centre", oldtown: "centre", plaza: "civic",
  office: "work", tech: "work", biotech: "work", studio: "work", campus: "work", media: "work",
  residential: "home", suburb: "home", village: "home",
  industrial: "industry", port: "industry", docks: "industry", logistics: "industry",
  park: "green", forest: "green", farmland: "green", farm: "green", wild: "green", water: "green",
  civic: "civic", hq: "civic", street: "civic"};
function groupOfName(n){ return GROUP[String(n || "").toLowerCase()] || "home"; }

// (FNV-1a alone clusters on keys that differ only in a trailing id; a murmur finaliser spreads them)
function hash01(s){ var h = WQ().hash32(String(s)); h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16; return (h >>> 0)/4294967296; }
function cm(v){ return (+v || 0)/100; }

var STOP_RE = /(stop|station|metro|transit|halt)/;
function isStop(kind){ return STOP_RE.test(String(kind || "")) && !/depot/.test(String(kind)); }

var FACTS = typeof WeakMap === "function" ? new WeakMap() : null;
function facts(W){
  var F = FACTS && FACTS.get(W);
  if(F) return F;
  var Q = WQ(), legend = (W.districts && W.districts.legend) || [];
  var stops = (W.sites || []).filter(function(s){ return isStop(s.kind); }).map(function(s){ return {x: cm(s.x), z: cm(s.z), kind: s.kind}; });
  var edgeById = {};
  (W.edges || []).forEach(function(e){ edgeById[e.id] = e; });
  function districtName(lotOrIndex){
    var i = typeof lotOrIndex === "number" ? lotOrIndex : (lotOrIndex && lotOrIndex.district);
    return i != null && legend[i] != null ? String(legend[i]) : "";
  }
  function group(lotOrIndex){ return groupOfName(districtName(lotOrIndex)); }
  function stopDist(x, z){
    var b = Infinity;
    for(var i = 0; i < stops.length; i++){ var d = Math.hypot(stops[i].x - x, stops[i].z - z); if(d < b) b = d; }
    return b;
  }
  // the street a lot opens onto (at its door), and whether it is a corner (a second street, turned away, at a corner)
  function frontage(lot){
    var dx = lot.door ? cm(lot.door[0]) : cm(lot.x), dz = lot.door ? cm(lot.door[2]) : cm(lot.z);
    var n = Q.nearestRoad(W, dx, dz, 30);
    if(!n) return {edge: null, kind: "res", cls: null, corner: false, dist: Infinity};
    var corner = false, P = lot.poly || [];
    for(var k = 0; k < P.length && !corner; k++){
      // a corner: a second street, turned well away from the first, runs along the lot's own kerb at one of its corners
      var m = Q.nearestRoad(W, cm(P[k][0]), cm(P[k][1]), 20);
      if(m && m.edge !== n.edge && m.dist <= m.half + 2.5 && Math.abs(Math.sin(m.yaw - n.yaw)) > 0.7) corner = true;
    }
    var kind = road(n.cls).kind;
    if(kind === "res" && group(lot) === "centre") kind = "shop";    // a side street downtown is a shopping street
    return {edge: n.edge, kind: kind, cls: n.cls, corner: corner, dist: n.dist};
  }
  F = {W: W, road: road, group: group, districtName: districtName, stopDist: stopDist, frontage: frontage, stops: stops, edge: function(id){ return edgeById[id]; }};
  if(FACTS) FACTS.set(W, F);
  return F;
}

/* ---------- land use ---------- */
var USES = ["home", "office", "warehouse", "workshop"], GROUNDS = ["door", "shop", "cafe", "lobby", "loading"];
var USE_CACHE = typeof WeakMap === "function" ? new WeakMap() : null;
function useOf(F, lot, h, h2){
  var g = F.group(lot), fr = F.frontage(lot), floors = Math.max(1, lot.floors | 0), busy = fr.kind === "shop" || fr.kind === "main";
  var near = F.stopDist(cm(lot.x), cm(lot.z)) < 160, use = "home", ground = "door";
  if(g === "industry"){ use = h < 0.6 ? "warehouse" : "workshop"; ground = "loading"; }
  else if(g === "work"){ use = "office"; ground = busy && (fr.corner || h2 < 0.35) ? "cafe" : "lobby"; }
  else if(g === "centre"){
    use = floors >= 5 && h < 0.55 ? "office" : "home";
    ground = fr.corner ? (h2 < 0.3 ? "cafe" : h2 < 0.65 ? "shop" : "door") : (busy || near) ? (h2 < 0.5 ? "shop" : h2 < 0.62 ? "cafe" : "door") : (h2 < 0.15 ? "shop" : (use === "office" ? "lobby" : "door"));
  } else if(g === "home"){
    ground = fr.corner && busy ? (h2 < 0.3 ? "cafe" : h2 < 0.55 ? "shop" : "door") : (near && busy && h2 < 0.15 ? "shop" : "door");
  }
  if(fr.kind === "fast" && (ground === "shop" || ground === "cafe")) ground = use === "office" ? "lobby" : "door";
  return {use: use, ground: ground, group: g, corner: fr.corner, front: {edge: fr.edge, kind: fr.kind}};
}
function landUse(W){
  var M = USE_CACHE && USE_CACHE.get(W);
  if(M) return M;
  var F = facts(W);
  M = {};
  (W.lots || []).forEach(function(lot){
    if(lot.kind !== "building") return;
    M[lot.id] = useOf(F, lot, hash01(W.hash + ":use:" + lot.id), hash01(W.hash + ":ground:" + lot.id));
  });
  if(USE_CACHE) USE_CACHE.set(W, M);
  return M;
}

/* ---------- lit windows by use and hour ---------- */
// lit attribute: 0 never, 1 lit every night (the old flag, kept), 2 + i + r: kind i of LIT (the four USES, then the
// opening hours of a shop and of a cafe), lit when r is under that kind's share at that hour. LIT_GLSL is the same
// table for the building shaders (uHour, 0..24); tests/test_citylife.py holds the two to each other.
var LIT = USES.concat(["shop", "cafe"]);
function litShare(i, h){
  h = ((h % 24) + 24) % 24;
  if(i === 0) return h >= 18 && h < 23.5 ? 0.72 : h >= 6 && h < 8 ? 0.45 : h >= 23.5 || h < 6 ? 0.08 : 0.18;   // home
  if(i === 1) return h >= 8 && h < 19 ? 0.88 : h >= 19 && h < 22 ? 0.3 : 0.05;                                 // office
  if(i <= 3) return h >= 6 && h < 18 ? 0.55 : 0.06;                                                          // warehouse, workshop
  if(i === 4) return h >= 9 && h < 20 ? 0.97 : 0.04;                                                         // a shop: open 9-20
  return h >= 7 && h < 23 ? 0.97 : 0.03;                                                                     // a cafe: open 7-23
}
function litCode(use, r){ var i = LIT.indexOf(use); return i < 0 ? 1 : 2 + i + Math.min(0.999, Math.max(0, +r || 0)); }
function litAt(code, h){ if(!(code > 0)) return false; if(code < 2) return true; var i = Math.floor(code - 2); return code - 2 - i < litShare(i, ((h % 24) + 24) % 24); }
var LIT_GLSL = [
  "float hqLitShare(float i, float h){",
  "  if(i < 0.5) return (h >= 18.0 && h < 23.5) ? 0.72 : (h >= 6.0 && h < 8.0) ? 0.45 : (h >= 23.5 || h < 6.0) ? 0.08 : 0.18;",
  "  if(i < 1.5) return (h >= 8.0 && h < 19.0) ? 0.88 : (h >= 19.0 && h < 22.0) ? 0.3 : 0.05;",
  "  if(i < 3.5) return (h >= 6.0 && h < 18.0) ? 0.55 : 0.06;",
  "  if(i < 4.5) return (h >= 9.0 && h < 20.0) ? 0.97 : 0.04;",
  "  return (h >= 7.0 && h < 23.0) ? 0.97 : 0.03;",
  "}",
  "float hqLitAt(float code, float h){",
  "  if(code < 0.5) return 0.0;",
  "  if(code < 1.5) return 1.0;",
  "  float i = floor(code - 2.0);",
  "  return step(code - 2.0 - i, hqLitShare(i, h) - 0.0001);",
  "}"].join("\n");

/* ---------- footpaths ---------- */
// The kerb-side strip (0.55 m in from the kerb) of every footpath at least 1.7 m wide, clear of junctions (12 m), of
// stops (8 m) and of the lamps (which stand at the lot side). A slot every 16 m; what stands there follows the lot
// behind it. Kinds: bin, bikerack, newsstand, stall, table (a cafe's: tables and chairs, faces the road). HQ 3.36: no
// benches at the kerb any more (the pavement stays clear).
var FURN_CACHE = typeof WeakMap === "function" ? new WeakMap() : null;
function edgePts(e){ var p = e.pts || [], o = []; for(var i = 0; i + 2 < p.length; i += 3) o.push({x: p[i]/100, y: p[i + 1]/100, z: p[i + 2]/100}); return o; }
function walkAlong(P, step, from, to, fn){
  var cum = [0];
  for(var i = 1; i < P.length; i++) cum.push(cum[i - 1] + Math.hypot(P[i].x - P[i - 1].x, P[i].z - P[i - 1].z));
  var L = cum[cum.length - 1], k = 0;
  for(var s = from; s <= L - to; s += step){
    while(k < P.length - 2 && cum[k + 1] < s) k++;
    var a = P[k], b = P[k + 1], sl = cum[k + 1] - cum[k] || 1, t = (s - cum[k])/sl, dx = (b.x - a.x)/sl, dz = (b.z - a.z)/sl;
    fn({x: a.x + (b.x - a.x)*t, z: a.z + (b.z - a.z)*t, dx: dx, dz: dz, lx: dz, lz: -dx}, s, L);
  }
}
function furniture(W){
  var out = FURN_CACHE && FURN_CACHE.get(W);
  if(out) return out;
  out = [];
  var Q = WQ(), F = facts(W), U = landUse(W), nodes = {}, RP = Q.railPiersOf ? Q.railPiersOf(W) : [];
  (W.nodes || []).forEach(function(n){ nodes[n.id] = {x: cm(n.x), z: cm(n.z)}; });
  var market = (W.sites || []).filter(function(s){ return s.kind === "market"; }).map(function(s){ return {x: cm(s.x), z: cm(s.z)}; });
  (W.edges || []).forEach(function(e){
    var walk = cm(e.walk), r = road(e.cls);
    if(walk < 1.7 || r.kind === "fast") return;
    var cw = cm(e.width)/2 - walk, P = edgePts(e);
    if(P.length < 2) return;
    walkAlong(P, 16, 12, 12, function(p, s){
      [1, -1].forEach(function(sg){
        var o = sg*(cw + 0.55), x = p.x + p.lx*o, z = p.z + p.lz*o;
        if(F.stopDist(x, z) < 8 || Q.surfaceAt(W, x, z) === "road") return;      // (another road's paving near a junction)
        if(RP.some(function(q){ return Math.hypot(q.x - x, q.z - z) < q.r + 1.5; })) return;   // phase 8: clear of a City Line pier
        var bx = p.x + p.lx*sg*(cm(e.width)/2 + 3), bz = p.z + p.lz*sg*(cm(e.width)/2 + 3), lot = Q.lotAt(W, bx, bz);
        if(lot && lot.kind === "hq") return;
        var u = lot ? U[lot.id] : null, g = u ? u.group : groupOfName(Q.districtAt(W, x, z).name), h = hash01(W.hash + ":furn:" + e.id + ":" + Math.round(s) + ":" + sg);
        var kind = null;
        if(u && u.ground === "cafe" && h < 0.75) kind = "table";
        else if(market.some(function(m){ return Math.hypot(m.x - x, m.z - z) < 70; }) && h < 0.6) kind = "stall";
        else if(g === "centre" || (u && u.ground === "shop")) kind = h < 0.3 ? null : h < 0.55 ? "bin" : h < 0.72 ? "bikerack" : h < 0.8 ? "newsstand" : h < 0.86 ? "stall" : null;
        else if(g === "work") kind = h < 0.25 ? null : h < 0.5 ? "bin" : h < 0.62 ? "bikerack" : null;
        else if(g === "home" || g === "civic") kind = h < 0.18 ? null : h < 0.3 ? "bin" : null;
        else if(g === "green") kind = h < 0.4 ? null : h < 0.5 ? "bin" : null;
        if(!kind) return;
        out.push({kind: kind, x: x, z: z, yaw: Math.atan2(-sg*p.lx, -sg*p.lz), edge: e.id, side: sg, lot: lot ? lot.id : null});
      });
    });
  });
  if(FURN_CACHE) FURN_CACHE.set(W, out);
  return out;
}

/* ---------- where people gather, and when ---------- */
// hours: [[from, to], ...] local hours; days: weekdays (0 Sunday) it happens on, all when absent; cap: most there at once.
var SPOT_CACHE = typeof WeakMap === "function" ? new WeakMap() : null;
function hotspots(W){
  var out = SPOT_CACHE && SPOT_CACHE.get(W);
  if(out) return out;
  out = [];
  furniture(W).forEach(function(f, i){
    if(f.kind === "table") out.push({id: "terrace:" + i, kind: "terrace", x: f.x, z: f.z, yaw: f.yaw, r: 1.6, cap: 4, hours: [[7.5, 10.5], [12, 14.5], [17.5, 23]]});
    else if(f.kind === "stall") out.push({id: "stall:" + i, kind: "queue", x: f.x, z: f.z, yaw: f.yaw, r: 2.2, cap: 5, hours: [[8, 20]]});
  });
  (W.sites || []).forEach(function(s){
    var x = cm(s.x), z = cm(s.z), k = String(s.kind || ""), id = String(s.id);
    if(isStop(k) && !/^metro$/.test(k)) out.push({id: "stop:" + id, kind: "wait", x: x, z: z, r: 2.5, cap: 6, hours: [[6, 24]]});
    else if(k === "school") out.push({id: "school:" + id, kind: "gate", x: x, z: z, r: 7, cap: 24, hours: [[7.6, 8.4], [14.8, 15.6]], days: [1, 2, 3, 4, 5]});
    else if(k === "stadium") out.push({id: "stadium:" + id, kind: "event", x: x, z: z, r: 18, cap: 60, hours: [[15.5, 17.2]], days: [6]});
    else if(k === "market") out.push({id: "market:" + id, kind: "market", x: x, z: z, r: 12, cap: 30, hours: [[7, 14]], days: [3, 6]});
    else if(k === "park" || k === "fountain" || k === "skatepark") out.push({id: "park:" + id, kind: k === "park" ? "jog" : "linger", x: x, z: z, r: 14, cap: 10, hours: k === "park" ? [[6, 9], [17, 20]] : [[9, 21]]});
  });
  parkRuns(W, out);
  if(SPOT_CACHE) SPOT_CACHE.set(W, out);
  return out;
}
// [crowds] where no park site has a jog spot, the footpath beside parkland is the jogging track: the three longest
// footpaths (60 m and more) with park (a district named park, not its lake) along at least 80% of their park side,
// one per street. A run carries its street and side: {edge, side (+1 the left of a->b)}, x, z its middle, r half its length.
function parkRuns(W, out){
  if(out.some(function(s){ return s.kind === "jog"; })) return;
  var Q = WQ(), runs = [];
  (W.edges || []).forEach(function(e){
    if(cm(e.walk) < 1.5 || road(e.cls).kind === "fast") return;
    var P = edgePts(e), len = 0;
    for(var i = 1; i < P.length; i++) len += Math.hypot(P[i].x - P[i - 1].x, P[i].z - P[i - 1].z);
    if(P.length < 2 || len < 60) return;
    [1, -1].forEach(function(sg){
      var n = 0, k = 0, mid = null;
      walkAlong(P, 10, 5, 5, function(p, s){
        var o = sg*(cm(e.width)/2 + 6), x = p.x + p.lx*o, z = p.z + p.lz*o;
        k++;
        if(Q.districtAt(W, x, z).name === "park" && Q.surfaceAt(W, x, z) !== "water") n++;
        if(!mid || Math.abs(s - len/2) < Math.abs(mid.s - len/2)) mid = {s: s, x: p.x, z: p.z};
      });
      if(k && n >= 0.8*k) runs.push({e: e, sg: sg, len: len, mid: mid});
    });
  });
  runs.sort(function(a, b){ return b.len - a.len || a.e.id - b.e.id || b.sg - a.sg; });
  var used = {};
  runs.forEach(function(R){
    if(used[R.e.id] || Object.keys(used).length >= 3) return;
    used[R.e.id] = 1;
    out.push({id: "run:" + R.e.id + ":" + R.sg, kind: "jog", x: R.mid.x, z: R.mid.z, r: R.len/2, cap: 8, hours: [[6, 9], [17, 20]], edge: R.e.id, side: R.sg});
  });
}
function hourOf(ms){ return (((ms % 864e5) + 864e5) % 864e5)/36e5; }
function weekday(ms){ return ((Math.floor(ms/864e5) % 7) + 7 + 4) % 7; }      // 1970-01-01 was a Thursday
// how many are at a spot at local ms: rises over the first quarter hour of a window, falls over the last, with a
// per-spot, per-quarter-hour wobble (the same for everyone)
function crowd(spot, ms){
  if(spot.days && spot.days.indexOf(weekday(ms)) < 0) return 0;
  var h = hourOf(ms), best = 0;
  (spot.hours || []).forEach(function(w){
    if(h < w[0] || h >= w[1]) return;
    var edge = Math.min(1, (h - w[0])/0.25, (w[1] - h)/0.25);
    best = Math.max(best, edge);
  });
  if(!(best > 0)) return 0;
  var q = Math.floor(ms/9e5), wob = 0.55 + 0.45*hash01(spot.id + ":" + q);
  return Math.round(spot.cap*best*wob);
}

/* ---------- traffic: demand by hour, the mix by place ---------- */
function bump(h, at, w){ var d = Math.min(Math.abs(h - at), 24 - Math.abs(h - at)); return Math.exp(-0.5*(d/w)*(d/w)); }
function demand(h, kind){
  h = ((h % 24) + 24) % 24;
  var peak = Math.max(bump(h, 8.25, 0.9), bump(h, 17.75, 1.1)), day = bump(h, 13, 3.2);
  var base = kind === "fast" ? 0.22 : kind === "res" ? 0.1 : 0.14, p = kind === "res" ? 0.75 : 1;
  return Math.min(1, base + (1 - base)*Math.max(p*peak, 0.62*day));
}
var MIX = {
  centre: {car: 0.52, taxi: 0.16, van: 0.14, lorry: 0.02, scooter: 0.1, bike: 0.06},
  work: {car: 0.66, taxi: 0.1, van: 0.1, lorry: 0.02, scooter: 0.07, bike: 0.05},
  home: {car: 0.72, taxi: 0.04, van: 0.06, lorry: 0.01, scooter: 0.09, bike: 0.08},
  industry: {car: 0.42, taxi: 0.02, van: 0.26, lorry: 0.28, scooter: 0.01, bike: 0.01},
  green: {car: 0.7, taxi: 0.04, van: 0.06, lorry: 0.02, scooter: 0.08, bike: 0.1},
  civic: {car: 0.6, taxi: 0.12, van: 0.1, lorry: 0.02, scooter: 0.1, bike: 0.06},
  fast: {car: 0.68, taxi: 0.06, van: 0.1, lorry: 0.16, scooter: 0, bike: 0}
};
function mix(group, kind, h){
  var b = MIX[kind === "fast" ? "fast" : group] || MIX.home, o = {}, sum = 0;
  h = ((h % 24) + 24) % 24;
  var night = h >= 22 || h < 5.5, early = h >= 5.5 && h < 11;
  for(var k in b){
    var w = b[k];
    if(night && (k === "bike" || k === "scooter" || k === "lorry")) w *= 0.3;
    if(night && k === "taxi") w *= 2.2;
    if(early && (k === "van" || k === "lorry")) w *= 1.6;
    o[k] = w; sum += w;
  }
  for(k in o) o[k] = o[k]/sum;
  return o;
}
function pick(m, u){ var acc = 0, last = "car"; for(var k in m){ acc += m[k]; last = k; if(u < acc) return k; } return last; }

/* ---------- events on the shared clock ---------- */
// A weekly street market (Wednesday and Saturday 07:00-14:00) on the street beside the market; Sunday's parade
// (15:00-16:30) along the main roads out of the plaza; roadworks on three streets a week (weekdays 09:00-16:00),
// the streets chosen by the week. Edges listed are closed to traffic while the event is on.
var EV_CACHE = typeof WeakMap === "function" ? new WeakMap() : null;
function plan(W){
  var P = EV_CACHE && EV_CACHE.get(W);
  if(P) return P;
  var Q = WQ(), byNode = {}, mainE = [], streetE = [], pair = {}, transit = {};
  // streets a bus or tram line runs on (its path is a run of node ids): roadworks never close one, as buses and trams
  // keep their timetables through closures
  (W.edges || []).forEach(function(e){ pair[Math.min(e.a, e.b) + ":" + Math.max(e.a, e.b)] = e.id; });
  ((W.transit && W.transit.lines) || []).forEach(function(l){
    var P = l.path || [];
    for(var i = 1; i < P.length; i++){ var id = pair[Math.min(P[i - 1], P[i]) + ":" + Math.max(P[i - 1], P[i])]; if(id != null) transit[id] = true; }
  });
  (W.edges || []).forEach(function(e){
    var k = road(e.cls).kind, len = 0, p = e.pts || [];
    for(var i = 3; i + 2 < p.length; i += 3) len += Math.hypot(p[i] - p[i - 3], p[i + 2] - p[i - 1])/100;
    var E = {id: e.id, a: e.a, b: e.b, kind: k, len: len, mid: {x: cm(p[3*Math.floor(p.length/6)]), z: cm(p[3*Math.floor(p.length/6) + 2])}};
    (byNode[e.a] = byNode[e.a] || []).push(E); (byNode[e.b] = byNode[e.b] || []).push(E);
    if(k === "main") mainE.push(E); else if(k !== "fast" && len >= 30 && !transit[e.id]) streetE.push(E);
  });
  var site = function(kind){ var s = (W.sites || []).filter(function(x){ return x.kind === kind; })[0]; return s ? {x: cm(s.x), z: cm(s.z)} : null; };
  var mk = site("market"), market = null;
  if(mk){ var m = Q.nearestRoad(W, mk.x, mk.z, 60); if(m && road(m.cls).kind !== "fast") market = {edges: [m.edge], at: {x: m.x, z: m.z}}; }
  // the parade: from the main road nearest the plaza, onward along main roads, never back on itself, up to 6 edges
  var parade = null, centre = site("fountain") || {x: 0, z: 0};
  if(mainE.length){
    var start = mainE.slice().sort(function(a, b){ return Math.hypot(a.mid.x - centre.x, a.mid.z - centre.z) - Math.hypot(b.mid.x - centre.x, b.mid.z - centre.z) || a.id - b.id; })[0];
    var route = [start.id], seen = {}, cur = start, node = start.b;
    seen[start.id] = true;
    for(var n = 0; n < 5; n++){
      var next = (byNode[node] || []).filter(function(E){ return E.kind === "main" && !seen[E.id]; }).sort(function(a, b){ return a.id - b.id; })[0];
      if(!next) break;
      seen[next.id] = true; route.push(next.id); node = next.a === node ? next.b : next.a; cur = next;
    }
    parade = {edges: route, at: start.mid};
  }
  P = {market: market, parade: parade, streets: streetE.sort(function(a, b){ return a.id - b.id; })};
  if(EV_CACHE) EV_CACHE.set(W, P);
  return P;
}
function events(W, ms){
  var P = plan(W), h = hourOf(ms), wd = weekday(ms), day0 = ms - h*36e5, out = [];
  if(P.market && (wd === 3 || wd === 6) && h >= 7 && h < 14) out.push({id: "market", kind: "market", edges: P.market.edges.slice(), at: P.market.at, from: day0 + 7*36e5, to: day0 + 14*36e5});
  if(P.parade && wd === 0 && h >= 15 && h < 16.5) out.push({id: "parade", kind: "parade", edges: P.parade.edges.slice(), at: P.parade.at, from: day0 + 15*36e5, to: day0 + 16.5*36e5});
  if(P.streets.length && wd >= 1 && wd <= 5 && h >= 9 && h < 16){
    var week = Math.floor((Math.floor(ms/864e5) + 3)/7), picked = {};
    for(var k = 0; k < 3; k++){
      var i = Math.floor(hash01(W.hash + ":works:" + week + ":" + k)*P.streets.length), E = P.streets[i];
      if(picked[E.id]) continue;
      picked[E.id] = true;
      out.push({id: "works:" + E.id, kind: "roadworks", edges: [E.id], at: E.mid, from: day0 + 9*36e5, to: day0 + 16*36e5});
    }
  }
  return out;
}
function closed(W, ms){ var o = {}; events(W, ms).forEach(function(ev){ ev.edges.forEach(function(id){ o[id] = ev.kind; }); }); return o; }

/* ---------- [3.22] traffic lights at real junctions ---------- */
// signals(W) -> {node id: sig}: every node where three or more through roads (main roads, collectors, a highway's end:
// the ones traffic.js runs on) meet, one of them a main road (arterial, avenue, boulevard, highway), and every
// four-way crossing of local streets downtown (by the blocks on its corners); [3.22.1] and side streets' lights: a
// four-way where a main road crosses a side street, and one of local streets out of town, each SIDE_GAP m clear of
// every other light and only where a bus or tram waiting at it has room. Never where a highway's mainline goes on
// through (two highway arms), nor on an expressway, a ring road or a slip. Two lights a short link (LINK m) apart are
// one junction: the busier keeps its light, and an arm that is such a link has no head of its own (sig.links; the
// traffic treats the two as one box). sig:
//   {id, x, z, r: the junction box radius (m, the farthest stop line), axes: [h0, h1] the two road headings (radians,
//    atan2(dx, dz), in [0, pi): a heading and its reverse are one axis; h0 the main road's), arms: [{heading: the way
//    traffic comes in, edge, stopX, stopZ: the middle of the stop line across the lane coming in, stop: its distance
//    from the node, half: half the carriageway, axis}], kind: "main" | "local", cycle, off, green: [g0, g1], links}
// The plan: a CYCLE s cycle from off (s on the clock): axis 0 green g0, amber, all red, axis 1 green g1, amber, all
// red. off is a hash of the node, except along a straight main road, where each junction is off by the drive from
// the one before it at WAVE m/s (a rough green wave). The cycle divides 15 minutes, so the local clock (UTC plus a
// time zone) and the UTC clock the traffic runs on see the same phase. The stop line stands clear of the junction
// patch and the zebra crossing the street renderer (worldgeom.js) paints, by the same measure.
// signalAt(sig, ms, heading) -> "green" | "amber" | "red" for traffic coming in on heading at local ms; walkAt(sig,
// ms, heading) -> may someone walking along heading cross now (with the parallel traffic's green, never in its
// last WALK_CLEAR s, so never while the road they cross has green).
var SIDE_GAP = 60, SIG = {cycle: 60, amber: 3, allRed: 2, walkClear: 6, wave: 11, split: [30, 20], even: [25, 25], side: [38, 12]}, LINK = 46;
// [3.25] the least room (m) a car needs to wait at a red between the stop line and the box behind it
var QUEUE_ROOM = 8;
var FOOT_RE = /^(path|footpath|foot|footway|pedestrian|walk|walkway|trail|cycleway|cycle|steps|track)$/;
var NOSIG = {expressway: 1, ring: 1, ramp: 1, flyover: 1, underpass: 1};
function carRoad(cls){ return !FOOT_RE.test(normCls(cls)); }
function mainRoad(cls){ return normCls(cls) === "highway" || road(cls).kind === "main"; }
// a road through traffic uses (the cars of traffic.js; a collector, v4's through street): a side street where it
// meets one is a give-way turning, not a light
function through(e){ var c = normCls(e.cls), k = road(c).kind; return mainRoad(c) || c === "collector" || (k === "fast" && !NOSIG[c]); }
function angPi(a){ a = (+a || 0) % Math.PI; return a < 0 ? a + Math.PI : a; }
function axisDist(a, b){ var d = Math.abs(angPi(a) - angPi(b)); return Math.min(d, Math.PI - d); }
function modp(a, m){ a %= m; return a < 0 ? a + m : a; }
// worldgeom.js armClear: how far back from the node an arm of half width ha stays clear of one of half width hb
function armClear(ha, hb, c){
  c = Math.max(-1, Math.min(1, c));
  var s = Math.sqrt(1 - c*c);
  if(s < 1e-3) return c > 0 ? 25 : 0;
  var t = (hb + ha*c)/s;
  if(c < 0) t = Math.min(t, ha*s/-c);
  return Math.max(0, t);
}
var SIG_CACHE = typeof WeakMap === "function" ? new WeakMap() : null;
function signals(W){
  var S = SIG_CACHE && W && typeof W === "object" ? SIG_CACHE.get(W) : null;
  if(S) return S;
  S = {};
  if(!W || !W.edges || !W.nodes) return S;
  var Q = WQ(), F = facts(W), nodes = {}, inc = {}, edgeById = {};
  W.nodes.forEach(function(n){ nodes[n.id] = n; });
  var pair = {}, transit = {};
  W.edges.forEach(function(e){ pair[Math.min(e.a, e.b) + ":" + Math.max(e.a, e.b)] = e.id; });
  ((W.transit && W.transit.lines) || []).forEach(function(l){
    var P = l.path || [];
    // (how much room a waiting bus or tram needs: half its length, and a little)
    var need = /tram/.test(String(l.id || l.mode || l.kind || "")) ? 14 : 6.5;
    for(var i = 1; i < P.length; i++){ var id = pair[Math.min(P[i - 1], P[i]) + ":" + Math.max(P[i - 1], P[i])]; if(id != null) transit[id] = Math.max(transit[id] || 0, need); }
  });
  W.edges.forEach(function(e){
    if(e.a === e.b || !e.pts || e.pts.length < 6) return;
    edgeById[e.id] = e;
    (inc[e.a] = inc[e.a] || []).push(e); (inc[e.b] = inc[e.b] || []).push(e);
  });
  function lenOf(P){ var L = 0; for(var i = 1; i < P.length; i++) L += Math.hypot(P[i].x - P[i - 1].x, P[i].z - P[i - 1].z); return L; }
  // an edge seen from one of its nodes: its points from there, its length, the way out (3 m along, as worldgeom.js)
  function armOf(e, id){
    var P = edgePts(e);
    if(String(e.a) !== String(id)) P.reverse();
    var L = lenOf(P), d = Math.min(3, L), acc = 0, q = P[P.length - 1];
    for(var i = 1; i < P.length; i++){
      var l = Math.hypot(P[i].x - P[i - 1].x, P[i].z - P[i - 1].z);
      if(acc + l >= d){ var t = l > 1e-9 ? (d - acc)/l : 0; q = {x: P[i - 1].x + (P[i].x - P[i - 1].x)*t, z: P[i - 1].z + (P[i].z - P[i - 1].z)*t}; break; }
      acc += l;
    }
    var ux = q.x - P[0].x, uz = q.z - P[0].z, ul = Math.hypot(ux, uz) || 1;
    return {e: e, len: L, ux: ux/ul, uz: uz/ul, half: cm(e.width)/2, c: Math.max(1.5, (cm(e.width) - 2*cm(e.walk))/2),
            rank: mainRoad(e.cls) ? 2 : road(e.cls).kind === "shop" ? 1 : 0};
  }
  function junction(id){ return (inc[id] || []).filter(through).length >= 3; }
  var GEN = W.nodes.some(function(n){ return n.junction != null; });
  // the box traffic.js turns through at a node with no light: as far as it reaches along the roads there (m)
  function boxAt(id){
    var es = inc[id] || [], c = 0, minLen = 1e9;
    es.forEach(function(e){ c = Math.max(c, Math.max(1.5, (cm(e.width) - 2*cm(e.walk))/2)); minLen = Math.min(minLen, lenOf(edgePts(e))); });
    return Math.min(es.length >= 3 ? c + 2 : es.length === 2 ? 2.5 : 1, 0.4*minLen);
  }
  var link = {}, prio = {};
  var ids = Object.keys(inc).sort(function(a, b){ return (+a) - (+b) || (a < b ? -1 : a > b ? 1 : 0); });
  ids.forEach(function(id){
    var n = nodes[id];
    if(!n) return;
    var es = inc[id].filter(function(e){ return carRoad(e.cls); });
    if(es.length < 3) return;
    if(es.some(function(e){ return NOSIG[normCls(e.cls)]; })) return;
    if(es.filter(function(e){ return normCls(e.cls) === "highway"; }).length >= 2) return;      // a highway going on through
    var x = cm(n.x), z = cm(n.z), kind = null, side = false;
    // [3.26] City Gen v4 says which junctions have lights (the roads that meet there: generator data); a world without
    // it is lit as before
    if(GEN) kind = n.junction === "signals" ? "main" : null;
    else if(es.filter(through).length >= 3 && es.some(function(e){ return mainRoad(e.cls); })) kind = "main";
    // [3.22.1] a main road crossing a side street (a four-way, not a T: that stays a give-way turning)
    else if(es.length >= 4 && es.some(function(e){ return mainRoad(e.cls); })){ kind = "main"; side = true; }
    else if(es.length === 4 && es.every(function(e){ var k = road(e.cls).kind; return k === "res" || k === "shop"; })){
      // the blocks on the four corners (the node itself is on the street's own district)
      var nc = 0;
      for(var q = 0; q < 4 && Q.districtAt; q++){
        var d = Q.districtAt(W, x + 16*Math.cos(Math.PI/4 + q*Math.PI/2), z + 16*Math.sin(Math.PI/4 + q*Math.PI/2));
        if(d && d.k != null && d.name !== "street" && F.group(d.k) === "centre") nc++;
      }
      // ([3.22.1] and one out of town too, spaced out as a side street's light: below)
      kind = "local"; side = nc < 2;
    }
    if(!kind) return;
    var arms = es.map(function(e){ return armOf(e, id); });
    arms.forEach(function(a){
      var t = 0;
      arms.forEach(function(b){ if(b !== a) t = Math.max(t, armClear(a.half, b.half, a.ux*b.ux + a.uz*b.uz) + 0.3); });
      a.t = Math.min(t, 25, a.len*0.45);
      var zebra = /^(street|local|avenue|arterial)$/.test(String(a.e.cls)) && a.t + 5 <= a.len - 1;
      a.stop = Math.min(a.t + (zebra ? 5.6 : 0.8), a.len*0.4);
    });
    var ref = arms.slice().sort(function(p, q){ return q.rank - p.rank || q.c - p.c || p.e.id - q.e.id; })[0];
    var h0 = angPi(Math.atan2(ref.ux, ref.uz)), h1 = null, far = 0;
    arms.forEach(function(a){ var h = Math.atan2(a.ux, a.uz), dd = axisDist(h, h0); if(dd > far + 1e-9){ far = dd; h1 = angPi(h); } });
    if(far < 0.35) h1 = angPi(h0 + Math.PI/2);
    var sig = {id: n.id, x: x, z: z, r: 0, axes: [h0, h1], arms: [], kind: kind, cycle: SIG.cycle, off: null, green: null, links: []};
    var rk = [0, 0];
    arms.sort(function(p, q){ return p.e.id - q.e.id; }).forEach(function(a){
      var heading = Math.atan2(-a.ux, -a.uz), ax = axisDist(heading, h1) < axisDist(heading, h0) ? 1 : 0;
      // a short link to the next junction: one box with this one (traffic.js), no head of its own
      var far = String(a.e.a) === String(id) ? a.e.b : a.e.a;
      // ([3.25] or a link with no room for a car to wait at the red, a box behind it: City Gen v4's wider boulevards
      // and avenues make bigger boxes)
      var tight = a.len - a.stop - boxAt(far) < QUEUE_ROOM && (inc[far] || []).filter(function(e){ return carRoad(e.cls); }).length >= 3;
      if(kind === "main" && ((a.len < LINK && junction(far)) || tight)){ sig.links.push(a.e.id); link[id] = (link[id] || []).concat([String(far)]); return; }
      // the middle of the stop line: across the lane coming in (the right of the way in is (uz, -ux); [3.22.3] the
      // lane is on its kerb side, SIDE x that: the left)
      var sd = driveSide();
      sig.arms.push({heading: heading, edge: a.e.id, stop: a.stop, half: a.c, axis: ax,
                     stopX: x + a.ux*a.stop + sd*a.uz*a.c/2, stopZ: z + a.uz*a.stop - sd*a.ux*a.c/2});
      sig.r = Math.max(sig.r, a.stop);
      rk[ax] = Math.max(rk[ax], a.rank);
    });
    // ([3.22.1] a side street across a main road: a short green, so the main road's traffic barely waits)
    sig.green = (side && rk[0] > rk[1] ? SIG.side : rk[0] > rk[1] ? SIG.split : SIG.even).slice();
    if(!sig.arms.length) return;
    prio[id] = [es.filter(through).length, es.length];
    if(side){
      sig.side = true;
      sig.wait = arms.filter(function(a){ return transit[a.e.id]; }).map(function(a){
        return {far: String(String(a.e.a) === String(id) ? a.e.b : a.e.a), edge: a.e.id, room: a.len - a.stop, need: transit[a.e.id]};
      });
    }
    S[id] = sig;
  });
  // two lights a short link apart are one junction: the busier keeps its light (more through roads, more arms, the
  // lower id)
  var kept = {};
  Object.keys(S).sort(function(a, b){ var p = prio[a], q = prio[b]; return q[0] - p[0] || q[1] - p[1] || (+a) - (+b) || (a < b ? -1 : a > b ? 1 : 0); }).forEach(function(id){
    if((link[id] || []).some(function(f){ return kept[f]; })){ delete S[id]; return; }
    kept[id] = true;
  });
  // [3.22.1] a side street's light only where a bus or tram waiting at it has room for half its length (traffic.js
  // holds it by its front) between this stop line and the far end's box: that light's stop line, or the box traffic.js
  // turns through there (first with the other side streets' lights not yet counted, then once they are placed, all)
  function farTrim(w, all){
    var f = S[w.far] && (all || !S[w.far].side) ? S[w.far] : null;
    if(f){ for(var i = 0; i < f.arms.length; i++) if(f.arms[i].edge === w.edge) return f.arms[i].stop; }
    return boxAt(w.far);
  }
  function roomy(all){
    Object.keys(S).sort(function(a, b){ return (+a) - (+b) || (a < b ? -1 : a > b ? 1 : 0); }).forEach(function(id){
      if(S[id].side && S[id].wait.some(function(w){ return w.room - farTrim(w, all) < w.need; })) delete S[id];
    });
  }
  roomy(false);
  // and SIDE_GAP m clear of every other light (the others first, then by id), so a main road crossing a side street
  // every block is not a light every block
  Object.keys(S).filter(function(id){ return S[id].side; }).sort(function(a, b){ return (+a) - (+b) || (a < b ? -1 : a > b ? 1 : 0); }).forEach(function(id){
    var sg = S[id];
    if(Object.keys(S).some(function(o){ return o !== id && S[o] && Math.hypot(S[o].x - sg.x, S[o].z - sg.z) < SIDE_GAP && (!S[o].side || (+o) < (+id)); })) delete S[id];
  });
  roomy(true);
  Object.keys(S).forEach(function(id){ if(S[id].side){ delete S[id].side; delete S[id].wait; } });
  // offsets: a hash per junction, then along each straight main road the next junction a drive later (a green wave)
  function startOf(sig, ax){ return ax ? sig.green[0] + SIG.amber + SIG.allRed : 0; }
  function headOut(e, node){ var a = armOf(e, node); return Math.atan2(a.ux, a.uz); }
  function onward(node, prev){
    var hin = headOut(prev, node) + Math.PI, best = null, bd = 0.5;
    (inc[node] || []).forEach(function(e){
      if(e === prev || !mainRoad(e.cls)) return;
      var dd = Math.abs(modp(headOut(e, node) - hin + Math.PI, 2*Math.PI) - Math.PI);
      if(dd < bd){ bd = dd; best = e; }
    });
    return best;
  }
  var sids = Object.keys(S).sort(function(a, b){ return (+a) - (+b) || (a < b ? -1 : a > b ? 1 : 0); });
  sids.forEach(function(sid){
    if(S[sid].off != null) return;
    S[sid].off = hash01(W.hash + ":signal:" + sid)*SIG.cycle;
    var queue = [sid];
    while(queue.length){
      var cur = queue.shift(), sg = S[cur];
      sg.arms.forEach(function(arm){
        var e = edgeById[arm.edge];
        if(!e || !mainRoad(e.cls)) return;
        var node = String(e.a) === String(cur) ? e.b : e.a, prev = e, dist = armOf(e, cur).len, guard = 0;
        while(!S[node] && guard++ < 16 && dist <= 1500){
          var nx = onward(node, prev);
          if(!nx) break;
          dist += armOf(nx, node).len; prev = nx; node = String(nx.a) === String(node) ? nx.b : nx.a;
        }
        var nxt = S[node];
        if(!nxt || nxt.off != null || dist > 1500) return;
        var hin = headOut(prev, node) + Math.PI, axIn = axisDist(hin, nxt.axes[1]) < axisDist(hin, nxt.axes[0]) ? 1 : 0;
        nxt.off = modp(sg.off + startOf(sg, arm.axis) + dist/SIG.wave - startOf(nxt, axIn), SIG.cycle);
        queue.push(String(node));
      });
    }
  });
  if(SIG_CACHE) SIG_CACHE.set(W, S);
  return S;
}
// which of the junction's two axes traffic on heading belongs to
function sigAxis(sig, heading){ return axisDist(heading, sig.axes[1]) < axisDist(heading, sig.axes[0]) ? 1 : 0; }
// seconds into axis ax's own phase (0 = its green came on) at local ms
function sigInto(sig, ms, ax){
  var C = sig.cycle || SIG.cycle, u = modp((+ms || 0)/1000 - (+sig.off || 0), C), s = ax ? sig.green[0] + SIG.amber + SIG.allRed : 0;
  return modp(u - s, C);
}
function signalAt(sig, ms, heading){
  if(!sig || !sig.axes || !sig.green) return "amber";
  var ax = sigAxis(sig, heading), d = sigInto(sig, ms, ax), g = sig.green[ax];
  return d < g ? "green" : d < g + SIG.amber ? "amber" : "red";
}
function walkAt(sig, ms, heading){
  if(!sig || !sig.axes || !sig.green) return false;
  var ax = sigAxis(sig, heading);
  return sigInto(sig, ms, ax) < sig.green[ax] - SIG.walkClear;
}

/* ---------- [3.22] parked cars ---------- */
// parked(W) -> [{x, y, z, yaw, type: "car" | "van", paint (0..1), edge, side}]: cars along the kerbs of local and
// shopping streets (not shared streets, slip roads or anything with a bus or tram on it), facing the way the traffic
// on their side goes, a bay every PARK_STEP m, clear of the junctions (and their zebras), the stops, the doors and
// driveways of the lots behind and the hq lots, each bay full by a hash and the place (downtown most). Every car is
// wholly on its own street's carriageway. Drawn and made solid by traffic.js street(); hidden while its street is
// closed (cityLife.closed: the market's stalls stand there).
var PARK_STEP = 6.2, PARK_IN = 1.05, PARK_FILL = {centre: 0.72, home: 0.6, work: 0.5, civic: 0.45, industry: 0.35, green: 0.2};
var PARK_CACHE = typeof WeakMap === "function" ? new WeakMap() : null;
function parked(W){
  var out = PARK_CACHE && W && typeof W === "object" ? PARK_CACHE.get(W) : null;
  if(out) return out;
  out = [];
  if(!W || !W.edges) return out;
  var Q = WQ(), F = facts(W), pair = {}, transit = {}, inc = {};
  W.edges.forEach(function(e){ pair[Math.min(e.a, e.b) + ":" + Math.max(e.a, e.b)] = e.id; (inc[e.a] = inc[e.a] || []).push(e); (inc[e.b] = inc[e.b] || []).push(e); });
  ((W.transit && W.transit.lines) || []).forEach(function(l){
    var P = l.path || [];
    for(var i = 1; i < P.length; i++){ var id = pair[Math.min(P[i - 1], P[i]) + ":" + Math.max(P[i - 1], P[i])]; if(id != null) transit[id] = true; }
  });
  // how far from a node its junction (patch and zebra) reaches along e
  var SG = signals(W);
  function clearOf(node, e){
    var m = 0;
    (inc[node] || []).forEach(function(o){ if(o !== e) m = Math.max(m, cm(o.width)/2); });
    m = (inc[node] || []).length >= 3 ? m + 7 : (inc[node] || []).length === 2 ? 3 : 2;
    return SG[node] ? Math.max(m, SG[node].r + 3) : m;                 // (a light: clear of its whole junction)
  }
  W.edges.forEach(function(e){
    var c = normCls(e.cls), k = road(c).kind;
    if((k !== "res" && k !== "shop") || c === "shared" || c === "lane" || transit[e.id]) return;
    var half = (cm(e.width) - 2*cm(e.walk))/2;
    if(half < 2.9) return;
    var P = edgePts(e);
    if(P.length < 2) return;
    var y0 = P[0].y, L = 0;
    for(var i = 1; i < P.length; i++) L += Math.hypot(P[i].x - P[i - 1].x, P[i].z - P[i - 1].z);
    var from = clearOf(e.a, e) + PARK_STEP/2, to = clearOf(e.b, e) + PARK_STEP/2;
    if(L - from - to < PARK_STEP) return;
    walkAlong(P, PARK_STEP, from, to, function(p, s){
      [1, -1].forEach(function(sg){
        var o = sg*(half - PARK_IN), x = p.x + p.lx*o, z = p.z + p.lz*o;
        var h = hash01(W.hash + ":park:" + e.id + ":" + Math.round(s*10) + ":" + sg);
        var bx = p.x + p.lx*sg*(cm(e.width)/2 + 3), bz = p.z + p.lz*sg*(cm(e.width)/2 + 3), lot = Q.lotAt(W, bx, bz);
        if(lot && (lot.kind === "hq" || lot.kind === "garage")) return;
        var u = lot ? landUse(W)[lot.id] : null, g = u ? u.group : groupOfName(Q.districtAt(W, x, z).name);
        if(h >= (PARK_FILL[g] != null ? PARK_FILL[g] : 0.4)) return;
        if(F.stopDist(x, z) < 14) return;
        for(var sid in SG) if(Math.hypot(SG[sid].x - x, SG[sid].z - z) < SG[sid].r + 4) return;     // (another street's light)
        // a door or a loading bay: its kerb kept clear
        if(lot && lot.door && Math.hypot(cm(lot.door[0]) - x, cm(lot.door[2]) - z) < cm(e.width)/2 + 5) return;
        // wholly on this street's carriageway: both ends and the middle
        for(var q = -1; q <= 1; q++){
          var qx = x + p.dx*q*2.4, qz = z + p.dz*q*2.4, n = Q.nearestRoad(W, qx, qz, 12);
          if(!n || n.edge !== e.id || Q.surfaceAt(W, qx, qz) !== "road") return;
        }
        // (sg > 0 is the left of a->b: [3.22.3] with traffic on the left, its cars face a->b)
        var yaw = sg*driveSide() < 0 ? Math.atan2(p.dx, p.dz) : Math.atan2(-p.dx, -p.dz), t2 = hash01(W.hash + ":parkt:" + e.id + ":" + Math.round(s*10) + ":" + sg);
        var ny = Q.nearestRoad(W, x, z, 12);
        out.push({x: x, y: ny ? ny.y : y0, z: z, yaw: yaw, type: t2 < (g === "industry" ? 0.3 : 0.1) ? "van" : "car", paint: t2, edge: e.id, side: sg});
      });
    });
  });
  if(PARK_CACHE) PARK_CACHE.set(W, out);
  return out;
}

HQV.cityLife = {ROAD: ROAD, normCls: normCls, road: road, groupOfName: groupOfName, facts: facts,
  USES: USES, GROUNDS: GROUNDS, LIT: LIT, landUse: landUse, litShare: litShare, litCode: litCode, litAt: litAt, LIT_GLSL: LIT_GLSL,
  furniture: furniture, hotspots: hotspots, crowd: crowd, hourOf: hourOf, weekday: weekday,
  demand: demand, mix: mix, pick: pick, events: events, closed: closed,
  SIG: SIG, signals: signals, signalAt: signalAt, walkAt: walkAt, sigAxis: sigAxis, parked: parked};
})();
