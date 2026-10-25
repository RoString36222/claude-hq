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
 * Units: metres (W stores cm), yaw 0 faces +z, the local clock in ms (npcsim.localMs), hours 0..24.
 */
(function(){
"use strict";
var root = typeof window !== "undefined" ? window : self;
var HQV = root.HQV = root.HQV || {};
function WQ(){ return HQV.world; }

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
  office: "work", tech: "work", biotech: "work", studio: "work", campus: "work",
  residential: "home", suburb: "home", village: "home",
  industrial: "industry", port: "industry", docks: "industry",
  park: "green", forest: "green", farmland: "green", wild: "green",
  civic: "civic", hq: "civic", street: "civic"};
function groupOfName(n){ return GROUP[String(n || "").toLowerCase()] || "home"; }

function hash01(s){ return (WQ().hash32(String(s)) >>> 0)/4294967296; }
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
// behind it. Kinds: bench, bin, bikerack, newsstand, stall, table (a cafe's: tables and chairs, faces the road).
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
  var Q = WQ(), F = facts(W), U = landUse(W), nodes = {};
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
        var bx = p.x + p.lx*sg*(cm(e.width)/2 + 3), bz = p.z + p.lz*sg*(cm(e.width)/2 + 3), lot = Q.lotAt(W, bx, bz);
        if(lot && lot.kind === "hq") return;
        var u = lot ? U[lot.id] : null, g = u ? u.group : groupOfName(Q.districtAt(W, x, z).name), h = hash01(W.hash + ":furn:" + e.id + ":" + Math.round(s) + ":" + sg);
        var kind = null;
        if(u && u.ground === "cafe" && h < 0.75) kind = "table";
        else if(market.some(function(m){ return Math.hypot(m.x - x, m.z - z) < 70; }) && h < 0.6) kind = "stall";
        else if(g === "centre" || (u && u.ground === "shop")) kind = h < 0.3 ? "bench" : h < 0.55 ? "bin" : h < 0.72 ? "bikerack" : h < 0.8 ? "newsstand" : h < 0.86 ? "stall" : null;
        else if(g === "work") kind = h < 0.25 ? "bench" : h < 0.5 ? "bin" : h < 0.62 ? "bikerack" : null;
        else if(g === "home" || g === "civic") kind = h < 0.18 ? "bench" : h < 0.3 ? "bin" : null;
        else if(g === "green") kind = h < 0.4 ? "bench" : h < 0.5 ? "bin" : null;
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
  var Q = WQ(), byNode = {}, mainE = [], streetE = [];
  (W.edges || []).forEach(function(e){
    var k = road(e.cls).kind, len = 0, p = e.pts || [];
    for(var i = 3; i + 2 < p.length; i += 3) len += Math.hypot(p[i] - p[i - 3], p[i + 2] - p[i - 1])/100;
    var E = {id: e.id, a: e.a, b: e.b, kind: k, len: len, mid: {x: cm(p[3*Math.floor(p.length/6)]), z: cm(p[3*Math.floor(p.length/6) + 2])}};
    (byNode[e.a] = byNode[e.a] || []).push(E); (byNode[e.b] = byNode[e.b] || []).push(E);
    if(k === "main") mainE.push(E); else if(k !== "fast" && len >= 30) streetE.push(E);
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

HQV.cityLife = {ROAD: ROAD, normCls: normCls, road: road, groupOfName: groupOfName, facts: facts,
  USES: USES, GROUNDS: GROUNDS, LIT: LIT, landUse: landUse, litShare: litShare, litCode: litCode, litAt: litAt, LIT_GLSL: LIT_GLSL,
  furniture: furniture, hotspots: hotspots, crowd: crowd, hourOf: hourOf, weekday: weekday,
  demand: demand, mix: mix, pick: pick, events: events, closed: closed};
})();
