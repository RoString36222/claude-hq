/* Claude HQ: Claude Cabs (HQV.hqCabs), docs/plans/transport-revamp.md 3.9 and 5.9 (part `cabs`).
 *
 * Ride: pick a destination and a class in the phone; a driver is matched (a seeded name, rating, plate and model),
 * the cab drives to the kerb beside you on the hqCall engine (games/hqcall.js), E gets you in (rear kerb-side seat,
 * pillion on a bike), the NPC driver takes the hqnav route at street speed, and at the end you get out at the kerb.
 * Everything is free (D4): there is no price anywhere. Heli and water taxi classes hand over to deps.heli
 * (games/hqhelicall.js) and deps.water (part `water`).
 * Drive (D5, score only): with "Drive for Claude Cabs" on, while you are in a car, requests arrive (a pure function
 * of the world, the minute and the slot), you accept one, stop beside the NPC, they get in the back, you drive to the
 * drop-off and get a score and a star rating. Score, fares and the rating average stay in this browser
 * (localStorage, guarded); nothing goes to a server, and there are no coins.
 *
 * Pure (node-tested, tests/test_hqcabs.py), metres, yaw 0 faces +z, increasing yaw turns left, the right of travel is
 * (-cos yaw, sin yaw) (as games/traffic.js and games/hqcall.js):
 *   classes()                         -> [{id, name, seats, vehicleCat, speed, desc}]  (bike, go, cab, xl, lux, heli, water)
 *   quote(W, from, to, cls, ms, seed) -> {cls, metres, secs, eta}   metres along the hqnav drive route (straight x 1.3 when
 *                                        there is none; straight for a heli), secs at street speed, eta (s) from a seeded
 *                                        nearest-driver distance that changes once a minute
 *   driverFor(seed, rideKey, cls, cat)-> {name, rating (4.6..5.0), plate, modelId, model, paint ("#rrggbb")}
 *   requests(W, ms, seed, near)       -> driver-mode offers live at ms: [{id, at, expires, pickup {x, z, yaw}, npc {x, z},
 *                                        drop {x, z, yaw, name}, metres, pickupM}]; slot k = floor(ms / SLOT_MS), each slot
 *                                        offers with a seeded chance, for OFFER_MS; near {x, z, r}: pickups within r
 *   rateDrive(log)                    -> 1..5 stars   log = {samples: [{t (s), v (m/s), street}], kerb (hits)}
 *   scoreTrip(log)                    -> {points, stars, parts: {distance, onTime, smooth}}  log also {metres, secs, expect}
 *   driverStats() / recordFare(r)     -> {score, fares, rating (average stars, 0 with none)}  localStorage, guarded
 *   etaSay(prev, eta)                 -> true when an ETA announcement is due (each 30 s mark, and at 1 min)
 *   seatOf(cls) / seatWorld(pose, seat) the rear kerb-side seat (pillion on a bike) in the vehicle's frame / in the world
 *   revs(v, electric)                 -> the cab engine's revs at v m/s (engineSound's 900..7600); voices: by class
 * Controller (THREE optional: with no c.THREE it runs headless, for the tests and a hidden tab):
 *   mount(c, w, deps) -> {request(dest, cls, ms) -> handle, cancel(), state(), quote(dest, cls), classes(), use(),
 *          driver: {on(bool) -> {ok, text}, offers(), accept(id) -> bool, state(), bump()}, carry(ms), camPose(ms, look),
 *          driverRig(), update(ms, dt), drawCalls(), tools: {shotCam(name)}, announces: true, dispose()}
 *     w = {W (the packed world, or a function returning it), me() -> {x, y, z, yaw, speed, driving: bool, street: bool,
 *          kerbHits}, ground(x, z), group (the Object3D the cabs hang from; default c.scene), seed, now()}
 *     deps = {call (HQV.hqCall), route(from, to) -> {pts, len} (default hqnav), snap(x, z) -> {x, z, ux, uz, half}
 *          (default hqnav), announce, toast, sfx(name, {pos, kind}), calm(), models (HQV.hqVehicleModels),
 *          catalogue (cat or fn), heli (the hqHeliCall controller), water ({taxi(fromPier, toPier)}),
 *          showRoute(pts | null, label), fade(ms), tickets (HQV.hqRide.tickets), achievements (HQV.hqRide.achievements),
 *          seatCam (HQV.hqRide.seatCam)}
 *     handle = {state() -> {phase: "matching"|"coming"|"here"|"riding"|"done"|"cancelled", eta, metres, driver, cls,
 *          dest, canSkip, skipping, exit}, cancel(), board() (E), skip(), rate(stars), driver}
 * Sounds (Sound PR B), each where it is: the cab's engine (a pool of one, kind vehicle: its model's voice and revs from
 * its speed, while it comes, waits, drives you and lets you out), its indicator as it pulls up (vehicle) and its door
 * chime as you get in and out (door); in driver mode your passenger's door chime is your own car's (own). The match
 * chime is the phone's (UI, centred).
 * Drawing: every cab is one instance of a stand-in body scaled to its catalogue model's size (hqVehicleModels.dims),
 * in its seeded paint, a terracotta band and door decals (one vertex-coloured livery mesh) and a lit CLAUDE CABS roof
 * sign (a canvas texture): paint + livery + sign + figures (drivers, passengers) + the pickup beacon = at most 5 draw
 * calls for every cab at once (a bike adds none: bikes are their own two instanced meshes, and you never see a car and
 * a bike cab together). Calm (deps.calm()) and prefers-reduced-motion: the beacon is a still ring, Skip ahead is a
 * fade, no pulsing. No DOM here; no random numbers (everything is seeded).
 */
(function(){
"use strict";
var root = typeof window !== "undefined" ? window : globalThis;
var HQV = root.HQV = root.HQV || {};

var STREET_V = 12;                 // m/s: street speed (hqCall.CRUISE, hqnav SPEED.street)
var APPROACH_V = 9;                // m/s: a cab's average coming to you (lights, turns)
var SLOT_MS = 15000, OFFER_MS = 20000, OFFER_P = 62;   // a driver-mode request slot, how long it is offered, % of slots
var NEAR_R = 1200;                 // m: pickups within this of you
var DROP_MIN = 400, DROP_MAX = 3000;
var SKIP_OVER = 1500;              // m: Skip ahead for trips longer than this
var SKIP_K = 4;                    // x speed while skipping
var STOP_R = 6, STOP_V = 1;        // driver mode: beside the NPC (m), stopped (m/s)
var DROP_R = 9;
var BOARD_MS = 2600, ALIGHT_MS = 2200;
var MATCH_MIN = 1000, MATCH_SPAN = 2000;   // ms: matching takes 1-3 s
var HARSH = 4.5;                   // m/s2: harsher braking than this is a harsh stop
var SPEED_LIMIT = 60/3.6;          // m/s on streets
var BOARD_R = 5;                   // m: E gets you in within this of the cab
var TERRACOTTA = 0xc9643b, CREAM = 0xf3ede2;
var STATS_KEY = "hq_cabs_driver", RATED_KEY = "hq_cabs_rated";
var PAINTS = ["#1f2a36", "#f3ede2", "#2f4f46", "#3a3f46", "#e9e4da", "#5a2e2a", "#26364a"];

var CLASSES = [
  {id: "bike", name: "Bike", seats: 1, vehicleCat: "bike", speed: STREET_V, near: [150, 900], desc: "Pillion on a motorbike"},
  {id: "go", name: "Go", seats: 3, vehicleCat: "car.hatch", speed: STREET_V, near: [200, 1200], desc: "A hatchback"},
  {id: "cab", name: "Cab", seats: 4, vehicleCat: "car.sedan", speed: STREET_V, near: [200, 1300], desc: "A saloon"},
  {id: "xl", name: "XL", seats: 6, vehicleCat: "car.suv", speed: STREET_V, near: [400, 1800], desc: "An SUV for six"},
  {id: "lux", name: "Lux", seats: 4, vehicleCat: "car.sedan.ev", speed: STREET_V, near: [500, 2200], desc: "An electric limousine"},
  {id: "heli", name: "Heli", seats: 4, vehicleCat: "heli", speed: 45, near: [1500, 4000], desc: "A helicopter to a helipad"},
  {id: "water", name: "Water taxi", seats: 6, vehicleCat: "boat", speed: 10, near: [300, 1500], desc: "A speedboat between piers"}
];
// fallback models per class when no catalogue is at hand (catalogue ids, games/vehicles/catalogue.json)
var MODELS = {bike: ["bmw-g-310-r", "ktm-390-duke", "royal-enfield-classic-350", "bmw-g-310-gs"], go: ["bmw-m135-xdrive"],
              cab: ["bmw-330li", "bmw-m340i"], xl: ["bmw-x5-40i", "bmw-x3-m50"], lux: ["bmw-i4-m50", "bmw-i7-m70"],
              heli: ["cab-heli"], water: ["water-taxi"]};
// original first names and surname initials (no real people)
var FIRST = ["Amara", "Bastian", "Calla", "Devraj", "Elif", "Farah", "Gideon", "Hana", "Ilario", "Jun", "Kalani", "Lior",
             "Marisol", "Nnamdi", "Odile", "Pavel", "Quilla", "Rafferty", "Saoirse", "Tomasz", "Ulla", "Vikram", "Wren",
             "Xochitl", "Yusuf", "Zinnia", "Anselm", "Bryony", "Cosmin", "Delphine", "Emeka", "Fenna", "Ghassan", "Ilse"];
var LAST = "ABCDEFGHJKLMNOPRSTVWZ";
var PLATE = "ABCDEFGHJKLMNPRSTUVWXYZ";
// the cab's engine (Sound PR B): its model's voice (hqVehiclePhys.voiceFor on its catalogue spec), else the class's;
// an automatic changing up through gears that start at CAB_GEARS m/s (a calm driver's early shifts)
var CAB_VOICE = {bike: "single", go: "turbo", cab: "turbo", xl: "turbo6", lux: "electric"};
var CAB_GEARS = [0, 4.5, 8.5, 13, 18, 24];

/* ---------- small helpers ---------- */
function hash32(str){
  str = String(str == null ? "" : str);
  var h = 0x811c9dc5;
  for(var i = 0; i < str.length; i++){ h ^= str.charCodeAt(i) & 0xff; h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
function mulberry32(a){
  a = a >>> 0;
  return function(){ a = (a + 0x6D2B79F5) >>> 0; var t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0)/4294967296; };
}
function clamp(v, a, b){ return v < a ? a : (v > b ? b : v); }
function num(v, d){ v = +v; return isFinite(v) ? v : d; }
function hyp(x, z){ return Math.sqrt(x*x + z*z); }
function dist(a, b){ return hyp(num(a && a.x, 0) - num(b && b.x, 0), num(a && a.z, 0) - num(b && b.z, 0)); }
function wrap(a){ return Math.atan2(Math.sin(a), Math.cos(a)); }
function classOf(id){ for(var i = 0; i < CLASSES.length; i++) if(CLASSES[i].id === id) return CLASSES[i]; return CLASSES[2]; }
function classes(){ return CLASSES.map(function(c){ return {id: c.id, name: c.name, seats: c.seats, vehicleCat: c.vehicleCat, speed: c.speed, desc: c.desc}; }); }
function seedOf(W, seed){ return String(seed != null ? seed : (W && (W.id || W.hash || W.seed)) || "hq"); }
var memo = typeof WeakMap === "function" ? new WeakMap() : null;
function memoOf(W){
  if(!W || typeof W !== "object") return {};
  if(memo){ var m = memo.get(W); if(!m){ m = {}; memo.set(W, m); } return m; }
  return W.__cabs || (W.__cabs = {});
}

/* ---------- roads (pure; the packed world's W.edges: pts Int32Array cm [x, y, z, ...], width / walk cm) ---------- */
var ROAD_OK = {local: 1, street: 1, arterial: 1, avenue: 1, ring: 1, residential: 1, collector: 1};
function roadEdges(W){
  var M = memoOf(W);
  if(M.edges) return M.edges;
  var out = [];
  (W && W.edges || []).forEach(function(e, i){
    if(!e || !e.pts || e.pts.length < 6 || e.bridge) return;
    if(e.cls != null && !ROAD_OK[e.cls]) return;
    var p = e.pts, n = p.length/3, cum = [0];
    for(var k = 1; k < n; k++) cum.push(cum[k - 1] + hyp((p[3*k] - p[3*k - 3])/100, (p[3*k + 2] - p[3*k - 1])/100));
    if(cum[n - 1] < 30) return;
    var half = num(e.width, 700)/200, walk = num(e.walk, 150)/100;
    out.push({i: i, e: e, cum: cum, len: cum[n - 1], half: half, carriage: Math.max(2.5, half - walk), name: e.name ? String(e.name) : ""});
  });
  M.edges = out;
  return out;
}
// [3.22.3] the side traffic keeps to (games/traffic.js SIDE, the one switch): -1 the left, 1 the right; the kerb of the
// way of travel is SIDE x its right. Left-hand traffic when traffic.js is not loaded
function driveSide(){ var T = HQV.traffic; return T && (T.SIDE === 1 || T.SIDE === -1) ? T.SIDE : -1; }
// the point f (0..1) along road r, its direction (side 1 a->b, -1 b->a), and the kerb spot / pavement point on the kerb of
// that way ([3.22.3] SIDE x its right: the left)
function roadAt(r, f, side){
  var p = r.e.pts, cum = r.cum, s = clamp(f, 0, 1)*r.len, k = 1;
  while(k < cum.length - 1 && cum[k] < s) k++;
  var L = cum[k] - cum[k - 1] || 1, t = (s - cum[k - 1])/L;
  var ax = p[3*k - 3]/100, az = p[3*k - 1]/100, bx = p[3*k]/100, bz = p[3*k + 2]/100;
  var dx = (bx - ax)/L, dz = (bz - az)/L, x = ax + (bx - ax)*t, z = az + (bz - az)*t;
  if(side < 0){ dx = -dx; dz = -dz; }
  var sd = driveSide(), off = clamp(r.carriage - 1.3, 1.6, 7)*sd, pav = (r.carriage + 1.4)*sd;
  // the right of travel is (-dz, dx)
  return {x: x, z: z, dx: dx, dz: dz, yaw: Math.atan2(dx, dz),
          kerb: {x: x - dz*off, z: z + dx*off, yaw: Math.atan2(dx, dz)}, pav: {x: x - dz*pav, z: z + dx*pav}, name: r.name};
}
// a seeded road point; near {x, z, r}: within r of it (else the nearest of the tries)
function roadPoint(W, rng, near, tries){
  var E = roadEdges(W); if(!E.length) return null;
  var best = null, bd = Infinity;
  for(var k = 0; k < (tries || 32); k++){
    var r = E[Math.floor(rng()*E.length) % E.length], f = 0.15 + 0.7*rng(), side = rng() < 0.5 ? 1 : -1;
    var q = roadAt(r, f, side);
    if(!near) return q;
    var d = dist(q.kerb, near);
    if(d <= num(near.r, NEAR_R) && d >= num(near.min, 0)) return q;
    var miss = d > num(near.r, NEAR_R) ? d - near.r : near.min - d;
    if(miss < bd){ bd = miss; best = q; }
  }
  return best;
}
function routeLen(W, from, to){
  var N = HQV.hqnav, M = memoOf(W);
  if(!N || !W || !W.edges || !W.nodes) return null;
  var key = Math.round(from.x) + "," + Math.round(from.z) + ">" + Math.round(to.x) + "," + Math.round(to.z);
  M.routes = M.routes || {};
  if(M.routes[key] !== undefined) return M.routes[key];
  var R = null;
  try { R = N.route(N.graph(W, 5), {x: from.x, z: from.z}, {x: to.x, z: to.z}, "drive"); } catch(e){ R = null; }
  var keys = Object.keys(M.routes); if(keys.length > 200) M.routes = {};
  return (M.routes[key] = R && isFinite(R.len) ? R.len : null);
}

/* ---------- quotes, drivers, offers (pure) ---------- */
function quote(W, from, to, cls, ms, seed){
  var c = classOf(cls), straight = dist(from, to), metres;
  if(c.id === "heli") metres = straight;
  else if(c.id === "water") metres = straight*1.2;
  else { var L = routeLen(W, from || {}, to || {}); metres = L != null ? L : straight*1.3; }
  var secs = metres/c.speed + (c.id === "heli" ? 75 : c.id === "water" ? 30 : 0);
  var minute = Math.floor(num(ms, 0)/60000), h = hash32(seedOf(W, seed) + ":near:" + c.id + ":" + minute);
  var near = c.near[0] + (h % 1000)/1000*(c.near[1] - c.near[0]);
  var eta = near/(c.id === "heli" ? 40 : c.id === "water" ? 9 : APPROACH_V) + (c.id === "heli" ? 40 : 2);
  return {cls: c.id, metres: Math.round(metres), secs: Math.round(secs), eta: Math.round(eta), near: Math.round(near)};
}
function catVehicles(cat){
  cat = typeof cat === "function" ? cat() : cat;
  return cat && Array.isArray(cat.vehicles) ? cat.vehicles : [];
}
function modelsFor(cls, cat){
  var c = classOf(cls), L = catVehicles(cat).filter(function(v){
    var k = String(v && v["class"] || ""), sp = v && v.spec || {};
    if(!v || !v.id || /^starter/.test(v.id)) return false;
    if(c.id === "bike") return /^bike\.(naked|adventure|classic)\./.test(k) && /\.400$/.test(k);
    if(c.id === "go") return /^car\.hatch\./.test(k);
    if(c.id === "cab") return /^car\.sedan\./.test(k) && !sp.electric && !/\.ev$/.test(k);
    if(c.id === "xl") return /^car\.suv\./.test(k);
    if(c.id === "lux") return /^car\.sedan\.ev$/.test(k) || (/^car\.sedan\./.test(k) && !!sp.electric);
    return false;
  });
  return L.length ? L : (MODELS[c.id] || MODELS.cab).map(function(id){ return {id: id}; });
}
function driverFor(seed, rideKey, cls, cat){
  var h = hash32(String(seed == null ? "hq" : seed) + "|driver|" + String(rideKey == null ? "" : rideKey) + "|" + classOf(cls).id);
  var r = mulberry32(h);
  var name = FIRST[Math.floor(r()*FIRST.length)] + " " + LAST.charAt(Math.floor(r()*LAST.length)) + ".";
  var rating = (46 + Math.floor(r()*5))/10;
  var plate = "CC" + (10 + Math.floor(r()*90)) + " " + PLATE.charAt(Math.floor(r()*PLATE.length)) + PLATE.charAt(Math.floor(r()*PLATE.length)) + PLATE.charAt(Math.floor(r()*PLATE.length));
  var L = modelsFor(cls, cat), m = L[Math.floor(r()*L.length) % L.length];
  var label = m.brand ? m.brand + " " + (m.model || m.id) : (m.model || m.id);
  return {name: name, rating: rating, plate: plate, modelId: m.id, model: String(label || m.id), paint: PAINTS[Math.floor(r()*PAINTS.length)], cls: classOf(cls).id};
}
function dropName(W, q){
  var R = HQV.hqRide;
  try { if(R && R.stationName && W) return R.stationName(W, q.x, q.z, "kerb"); } catch(e){}
  return q.name ? q.name : "the kerb";
}
function offerAt(W, seed, k, near){
  var s = seedOf(W, seed), minute = Math.floor(k*SLOT_MS/60000), slot = k - Math.floor(minute*60000/SLOT_MS);
  var h = hash32(s + ":offer:" + minute + ":" + slot);
  if(h % 100 >= OFFER_P) return null;
  var r = mulberry32(h), at = k*SLOT_MS;
  var P = roadPoint(W, r, near ? {x: near.x, z: near.z, r: num(near.r, NEAR_R)} : null, 40);
  if(!P) return null;
  var D = roadPoint(W, r, {x: P.kerb.x, z: P.kerb.z, r: DROP_MAX, min: DROP_MIN}, 40);
  if(!D) return null;
  var straight = dist(P.kerb, D.kerb);
  if(straight < DROP_MIN*0.8 || straight > DROP_MAX*1.05) return null;
  var o = {id: "o" + minute + "-" + slot, at: at, expires: at + OFFER_MS,
           pickup: {x: P.kerb.x, z: P.kerb.z, yaw: P.kerb.yaw}, npc: {x: P.pav.x, z: P.pav.z},
           drop: {x: D.kerb.x, z: D.kerb.z, yaw: D.kerb.yaw, name: dropName(W, D.kerb)},
           straight: Math.round(straight)};
  var L = routeLen(W, o.pickup, o.drop);
  o.metres = Math.round(L != null ? L : straight*1.3);
  return o;
}
function requests(W, ms, seed, near){
  if(!W) return [];
  var M = memoOf(W), k1 = Math.floor(num(ms, 0)/SLOT_MS), out = [];
  // pickups are drawn round you to the nearest 100 m, so a moving driver keeps the same offers for a while
  var nr = near ? {x: Math.round(num(near.x, 0)/100)*100, z: Math.round(num(near.z, 0)/100)*100, r: num(near.r, NEAR_R)} : null;
  var nk = nr ? nr.x + "," + nr.z + "," + nr.r : "-";
  M.offers = M.offers || {};
  for(var k = k1 - Math.ceil(OFFER_MS/SLOT_MS); k <= k1; k++){
    var key = seedOf(W, seed) + "|" + k + "|" + nk, o = M.offers[key];
    if(o === undefined){ o = M.offers[key] = offerAt(W, seed, k, nr); }
    if(o && o.at <= ms && ms < o.expires){
      var c = {}; Object.keys(o).forEach(function(f){ c[f] = o[f]; });
      if(near) c.pickupM = Math.round(dist(o.pickup, near));
      out.push(c);
    }
  }
  var ks = Object.keys(M.offers); if(ks.length > 400) M.offers = {};
  return out.sort(function(a, b){ return a.at - b.at; });
}

/* ---------- driving score (pure) ---------- */
function driveFacts(log){
  log = log || {};
  var S = Array.isArray(log.samples) ? log.samples : [], harsh = 0, inHarsh = false, fast = 0;
  for(var i = 1; i < S.length; i++){
    var a = S[i - 1], b = S[i], dt = num(b.t, 0) - num(a.t, 0);
    if(!(dt > 0)) continue;
    var dec = (num(a.v, 0) - num(b.v, 0))/dt;
    if(dec > HARSH){ if(!inHarsh) harsh++; inHarsh = true; } else inHarsh = false;
    if(b.street !== false && num(b.v, 0) > SPEED_LIMIT) fast += dt;
  }
  return {harsh: harsh, fast: fast, kerb: Math.max(0, num(log.kerb, 0) | 0)};
}
function rateDrive(log){
  var F = driveFacts(log);
  var s = 5 - F.harsh*0.6 - Math.floor(F.fast/5)*0.5 - F.kerb*0.8;
  return clamp(Math.round(s), 1, 5);
}
function scoreTrip(log){
  log = log || {};
  var stars = rateDrive(log), metres = Math.max(0, num(log.metres, 0)), secs = Math.max(0, num(log.secs, 0));
  var expect = num(log.expect, metres/9 + 20);
  var distance = Math.round(metres/10);
  var onTime = secs > 0 && secs <= expect*1.15 ? 50 : secs > 0 && secs <= expect*1.6 ? 20 : 0;
  var smooth = stars*10;
  return {points: distance + onTime + smooth, stars: stars, parts: {distance: distance, onTime: onTime, smooth: smooth}};
}
var memStore = {};
function store(){ try { var ls = root.localStorage; if(ls && typeof ls.getItem === "function") return ls; } catch(e){} return null; }
function readJson(key){
  var raw = null;
  try { var ls = store(); raw = ls ? ls.getItem(key) : null; } catch(e){ raw = null; }
  if(raw == null) raw = memStore[key] != null ? memStore[key] : null;
  try { return raw ? JSON.parse(raw) : null; } catch(e){ return null; }
}
function writeJson(key, v){
  var s = JSON.stringify(v); memStore[key] = s;
  try { var ls = store(); if(ls) ls.setItem(key, s); } catch(e){}
}
function driverStats(){
  var s = readJson(STATS_KEY) || {};
  var fares = Math.max(0, num(s.fares, 0) | 0), score = Math.max(0, num(s.score, 0) | 0), sum = Math.max(0, num(s.starSum, 0));
  return {score: score, fares: fares, rating: fares > 0 ? Math.round(sum/fares*100)/100 : 0};
}
function recordFare(r){
  r = r || {};
  var s = readJson(STATS_KEY) || {};
  var o = {score: Math.max(0, num(s.score, 0) | 0) + Math.max(0, num(r.points, 0) | 0), fares: Math.max(0, num(s.fares, 0) | 0) + 1,
           starSum: Math.max(0, num(s.starSum, 0)) + clamp(num(r.stars, 0), 0, 5)};
  writeJson(STATS_KEY, o);
  return driverStats();
}
function etaSay(prev, eta){
  if(prev == null || !isFinite(prev)) return false;
  if(prev > 60 && eta <= 60) return true;
  return Math.floor(prev/30) !== Math.floor(eta/30) && eta > 60;
}
function etaText(s){ s = Math.max(0, Math.round(num(s, 0))); return s < 60 ? s + " s" : Math.round(s/60) + " min"; }
// seats in the vehicle's frame: forward +z, model-local +x is LEFT (as hqheli / hqVehicleModels)
function seatOf(cls){
  // (the rear seat on the kerb side: x + is the left, [3.22.3] -SIDE x 0.42)
  return classOf(cls).id === "bike" ? {x: 0, y: 0.95, z: -0.42, anim: "sit", pillion: true} : {x: -0.42*driveSide(), y: 0.42, z: -0.62, anim: "sit", pillion: false};
}
function seatWorld(pose, seat){
  var yaw = num(pose.yaw, 0), fx = Math.sin(yaw), fz = Math.cos(yaw), lx = Math.cos(yaw), lz = -Math.sin(yaw);
  return {x: num(pose.x, 0) + fx*seat.z + lx*seat.x, y: num(pose.y, 0) + seat.y, z: num(pose.z, 0) + fz*seat.z + lz*seat.x, yaw: yaw};
}
// the cab's revs at v m/s, on games/engine.js engineSound's game scale (900 idle .. 7600): pulling away in first from
// idle, each higher gear from about 1,700 to 3,500 as it gathers speed; an electric motor's with the speed in one gear
function revs(v, electric){
  v = Math.abs(num(v, 0));
  if(electric) return 900 + 6600*clamp(v/40, 0, 1);
  for(var g = 1; g < CAB_GEARS.length - 1 && v >= CAB_GEARS[g]; g++){}
  var lo = CAB_GEARS[g - 1], hi = CAB_GEARS[g];
  return g === 1 ? 900 + 2600*clamp(v/hi, 0, 1) : 1700 + 1800*clamp((v - lo)/(hi - lo), 0, 1);
}

/* ---------- the controller ---------- */
function mount(c, w, deps){
  c = c || null; w = w || {}; deps = deps || {};
  var T = c && c.THREE ? c.THREE : null;
  var CALL = deps.call || HQV.hqCall;
  var job = null, drv = {on: false, phase: "off", job: null, offers: [], result: null, kerb: 0}, nowMs = 0, view = null, lastSpot = null;
  function W(){ try { return typeof w.W === "function" ? w.W() : w.W; } catch(e){ return null; } }
  function me(){ try { return (w.me && w.me()) || {}; } catch(e){ return {}; } }
  function ground(x, z){ try { return w.ground ? num(w.ground(x, z), 0) : 0; } catch(e){ return 0; } }
  function calm(){ try { return !!(deps.calm && deps.calm()); } catch(e){ return false; } }
  function say(t){ try { if(deps.announce) deps.announce(t); } catch(e){} }
  function toast(t){ try { if(deps.toast) deps.toast(t); } catch(e){} }
  // o: {pos, kind} puts a sound where it is (games/engine.js's spatial voices through hqRide.sfx); none: centred (UI)
  function sfx(n, o){ try { if(deps.sfx) deps.sfx(n, o); } catch(e){} }
  function cabAt(J, up){ var R = J && J.R; return R ? {x: num(R.x, 0), y: ground(num(R.x, 0), num(R.z, 0)) + (up != null ? up : 1), z: num(R.z, 0)} : null; }
  function meAt(){ var m = me(), x = num(m.x, 0), z = num(m.z, 0); return {x: x, y: num(m.y, ground(x, z)) + 1, z: z}; }
  // the cab's engine: a pool of one (HQV.engine.pool, kind vehicle) sounding it while it comes, waits, drives you and
  // lets you out, its revs from its speed; nothing when it is beyond earshot, no listener or the sound is off
  var engP = null;
  function voiceOf(J){
    var VP = HQV.hqVehiclePhys, L = catVehicles(deps.catalogue), e = null;
    for(var i = 0; i < L.length && !e; i++) if(L[i] && L[i].id === J.driver.modelId) e = L[i];
    if(e && e.spec && VP && typeof VP.voiceFor === "function"){ try { var v = VP.voiceFor(e.spec, J.cls.id === "bike" ? "bike" : "car"); if(v) return v; } catch(x){} }
    return CAB_VOICE[J.cls.id] || "turbo";
  }
  function engineStep(J, dt){
    var E = HQV.engine;
    if(!engP && E && typeof E.pool === "function" && typeof E.engineSound === "function")
      engP = E.pool("vehicle", {voices: 1, idle: 2, key: function(s){ return s.voice; },
        make: function(s){ return E.engineSound(s.voice); },
        play: function(h, s){ h.set(s.rpm, {thr: s.thr, speed: s.v, pos: s, sk: "vehicle"}); }});
    if(!engP) return;
    var L = [];
    if(J && !J.delegated && J.R && (J.phase === "coming" || J.phase === "here" || J.phase === "riding" || J.phase === "done")){
      var v = Math.abs(num(J.R.v, 0)), acc = dt > 0 && J.vWas != null ? (v - J.vWas)/dt : 0, voice = J.voice || (J.voice = voiceOf(J)), at = cabAt(J, 0.6);
      J.vWas = v;
      L.push({id: "cab:" + J.key, voice: voice, x: at.x, y: at.y, z: at.z, v: v, rpm: revs(v, voice === "electric"), thr: v < 0.3 ? 0.1 : clamp(0.3 + acc*0.25, 0, 1)});
    }
    engP.update(L);
  }
  function show(pts, label){ try { if(deps.showRoute) deps.showRoute(pts, label); } catch(e){} }
  function seed(){ return seedOf(W(), w.seed); }
  function clock(ms){ if(ms != null && isFinite(ms)) return +ms; if(nowMs) return nowMs; try { return w.now ? +w.now() : Date.now(); } catch(e){ return 0; } }
  function tickets(){ return deps.tickets || (HQV.hqRide && HQV.hqRide.tickets) || null; }
  function achv(){ return deps.achievements || (HQV.hqRide && HQV.hqRide.achievements) || null; }
  function record(ev){ try { var A = achv(); if(A && A.record) A.record(ev); } catch(e){} }

  // a road route {pts: [x, z, ...], len} from a to b
  function routeFor(a, b){
    try {
      if(deps.route){ var R0 = deps.route(a, b); if(R0 && R0.pts && R0.pts.length >= 4) return R0; }
      var N = HQV.hqnav, Wd = W();
      if(N && Wd && Wd.edges && Wd.nodes){ var R = N.route(N.graph(Wd, 5), {x: a.x, z: a.z}, {x: b.x, z: b.z}, "drive"); if(R && R.pts && R.pts.length >= 4) return R; }
    } catch(e){}
    return {pts: [a.x, a.z, b.x, b.z], len: dist(a, b)};
  }
  // the road beside (x, z): {x, z, ux, uz, half} for hqCall.kerb
  function snapRoad(x, z){
    try {
      if(deps.snap){ var s0 = deps.snap(x, z); if(s0) return s0; }
      var N = HQV.hqnav, Wd = W();
      if(N && Wd && Wd.edges){
        var s = N.snap(N.graph(Wd, 5), x, z), e = s && Wd.edges[s.ei];
        if(e && e.pts){
          var p = e.pts, n = p.length/3, best = 0, bd = Infinity;
          for(var k = 0; k < n - 1; k++){ var mx = (p[3*k] + p[3*k + 3])/200, mz = (p[3*k + 2] + p[3*k + 5])/200, d = hyp(mx - s.x, mz - s.z); if(d < bd){ bd = d; best = k; } }
          var ux = (p[3*best + 3] - p[3*best])/100, uz = (p[3*best + 5] - p[3*best + 2])/100, ul = hyp(ux, uz) || 1;
          return {x: s.x, z: s.z, ux: ux/ul, uz: uz/ul, half: Math.max(2.5, (num(e.width, 700) - 2*num(e.walk, 150))/200)};
        }
      }
    } catch(e2){}
    return null;
  }
  function kerbFor(pts, x, z){
    var road = snapRoad(x, z);
    if(road && CALL && CALL.kerb) return CALL.kerb(road, CALL.arrival ? CALL.arrival(pts) : null);
    var n = pts.length, dx = pts[n - 2] - pts[n - 4], dz = pts[n - 1] - pts[n - 3];
    return {x: x, z: z, yaw: Math.atan2(dx, dz)};
  }
  function runAlong(pts, spot){
    var path = CALL && CALL.pathFor ? CALL.pathFor(pts, spot) : pts;
    return {path: path, R: CALL.run(path, 0)};
  }

  /* ----- riding ----- */
  function newHandle(J){
    var H = {
      driver: J.driver,
      state: function(){
        var R = J.R;
        return {phase: J.phase, cls: J.cls.id, dest: J.dest, driver: J.driver, quote: J.quote,
                eta: J.phase === "matching" ? J.quote.eta : J.phase === "coming" && R ? etaOf(R) : J.phase === "riding" && R ? Math.round((R.len - R.s)/STREET_V*(J.skipping ? 1/SKIP_K : 1)) : 0,
                metres: R && (J.phase === "coming" || J.phase === "riding") ? Math.max(0, Math.round(R.len - R.s)) : J.phase === "matching" ? J.quote.near : 0,
                canSkip: J.phase === "riding" && !!J.R && J.R.len - J.R.s > SKIP_OVER && !J.skipping, skipping: !!J.skipping, exit: J.exit || null,
                rated: J.rated || 0, sub: J.sub ? (J.sub.state ? J.sub.state() : null) : null};
      },
      cancel: function(){ return cancelJob(J); },
      board: function(){ return boardJob(J); },
      skip: function(){ return skipJob(J); },
      rate: function(n){ return rateJob(J, n); }
    };
    return H;
  }
  function etaOf(R){ return CALL && CALL.etaOf ? CALL.etaOf(R) : Math.max(1, Math.round((R.len - R.s)/(STREET_V*0.62) + 1)); }
  function cancelJob(J){
    if(!J || J.phase === "done" || J.phase === "cancelled") return false;
    if(J.sub && J.sub.cancel) try { J.sub.cancel(); } catch(e){}
    J.phase = "cancelled"; show(null); say("Claude Cabs: your ride is cancelled.");
    if(job === J) job = null;
    return true;
  }
  function request(dest, cls, ms){
    var t = clock(ms), C = classOf(cls), m = me();
    if(!dest || !isFinite(+dest.x) || !isFinite(+dest.z)) return null;
    if(job) cancelJob(job);
    var key = seed() + ":" + Math.floor(t/1000) + ":" + Math.round(num(m.x, 0)) + ":" + Math.round(num(m.z, 0));
    var J = {cls: C, dest: {x: +dest.x, z: +dest.z, name: String(dest.name || dest.label || "your destination")}, phase: "matching", t0: t,
             matchAt: t + MATCH_MIN + hash32(key) % MATCH_SPAN, key: key,
             quote: quote(W(), {x: num(m.x, 0), z: num(m.z, 0)}, dest, C.id, t, w.seed), driver: driverFor(seed(), key, C.id, deps.catalogue)};
    J.handle = newHandle(J);
    job = J;
    if(C.id === "heli" || C.id === "water"){
      var sub = null;
      try {
        if(C.id === "heli" && deps.heli){
          var spots = deps.heli.spots ? deps.heli.spots() : [];
          sub = spots && spots[0] ? deps.heli.call(spots[0], {own: null}) : null;
          if(sub && deps.heli.fly) deps.heli.fly(J.dest);
        } else if(C.id === "water" && deps.water && deps.water.taxi){
          var pf = nearestPier(m), pt = nearestPier(J.dest);
          sub = pf && pt && pf.id !== pt.id ? deps.water.taxi(pf, pt) : null;
        }
      } catch(e){ sub = null; }
      if(!sub){ J.phase = "cancelled"; job = null; say(C.id === "heli" ? "No helicopter can land near you right now." : "No water taxi can reach you here."); return J.handle; }
      J.sub = sub; J.phase = "coming"; J.delegated = true;
      return J.handle;
    }
    say("Claude Cabs: finding you a " + C.name + "…");
    return J.handle;
  }
  function nearestPier(p){
    var WD = HQV.world, V = WD && WD.waterOf ? WD.waterOf(W()) : null, best = null, bd = Infinity;
    (V && V.piers || []).forEach(function(q){ var d = dist(q, p); if(d < bd){ bd = d; best = q; } });
    return best;
  }
  function spawnFor(J, m){
    var Wd = W(), r = mulberry32(hash32(J.key + ":spawn")), want = J.quote.near;
    var P = Wd ? roadPoint(Wd, r, {x: num(m.x, 0), z: num(m.z, 0), r: want*1.25, min: want*0.6}, 40) : null;
    if(P) return {x: P.x, z: P.z};
    var a = r()*Math.PI*2;
    return {x: num(m.x, 0) + Math.sin(a)*Math.min(want, 300), z: num(m.z, 0) + Math.cos(a)*Math.min(want, 300)};
  }
  function matched(J){
    var m = me(), from = spawnFor(J, m), RR = routeFor(from, {x: num(m.x, 0), z: num(m.z, 0)});
    var spot = kerbFor(RR.pts, num(m.x, 0), num(m.z, 0)), A = runAlong(RR.pts, spot);
    J.R = A.R; J.path = A.path; J.spot = spot; J.phase = "coming"; J.lastEta = etaOf(J.R);
    show(A.path, "Your Claude Cab");
    var d = J.driver;
    say("Matched: " + d.name + " (" + d.rating.toFixed(1) + " stars) in a " + d.model + ", plate " + d.plate + ". Arriving in " + etaText(J.lastEta) + ".");
    sfx("chime");
  }
  function boardJob(J){
    if(!J || J.phase !== "here" || !J.R) return false;
    var m = me();
    if(dist(m, {x: J.R.x, z: J.R.z}) > BOARD_R + 1.5) return false;
    var door = cabAt(J);                                                   // its door, at the kerb you get in at
    var RR = routeFor({x: J.R.x, z: J.R.z}, J.dest), spot = kerbFor(RR.pts, J.dest.x, J.dest.z), A = runAlong(RR.pts, spot);
    J.R = A.R; J.path = A.path; J.phase = "riding"; J.rideAt = clock(); J.from = {x: m.x, z: m.z};
    show(A.path, J.dest.name);
    sfx("door-chime", {pos: door, kind: "door"});
    say("Riding to " + J.dest.name + ". About " + etaText(J.R.len/STREET_V) + "." + (J.R.len > SKIP_OVER ? " You can skip ahead in the phone." : ""));
    return true;
  }
  function skipJob(J){
    if(!J || J.phase !== "riding" || !J.R || J.R.len - J.R.s <= SKIP_OVER || J.skipping) return false;
    if(calm()){
      // Calm: a fade and a cut to the last stretch, no fast-forward
      try { if(deps.fade) deps.fade(600); } catch(e){}
      var R = J.R, s = Math.max(R.s, R.len - 150);
      if(CALL.pointAt){ var p = CALL.pointAt(R, s); R.s = s; R.x = p.x; R.z = p.z; } else R.s = s;
      say("Skipped ahead: nearly at " + J.dest.name + ".");
      return true;
    }
    J.skipping = true;
    say("Skipping ahead.");
    return true;
  }
  function rateJob(J, n){
    n = clamp(Math.round(num(n, 0)), 1, 5);
    if(!J || J.phase !== "done") return false;
    J.rated = n;
    var L = readJson(RATED_KEY); L = Array.isArray(L) ? L : [];
    L.unshift({name: J.driver.name, plate: J.driver.plate, stars: n, at: clock()});
    writeJson(RATED_KEY, L.slice(0, 30));
    say("Thanks: you gave " + J.driver.name + " " + n + (n === 1 ? " star." : " stars."));
    return true;
  }
  function finish(J){
    J.phase = "done"; J.doneAt = clock(); J.skipping = false;
    var R = J.R, yaw = num(R.yaw, 0);
    J.exit = {x: R.x - Math.cos(yaw)*1.8*driveSide(), z: R.z + Math.sin(yaw)*1.8*driveSide(), yaw: yaw};   // out on the kerb side ([3.22.3] the left)
    show(null);
    sfx("door-chime", {pos: cabAt(J), kind: "door"});
    say("You've arrived at " + J.dest.name + ". Thanks for riding Claude Cabs.");
    try {
      var Tk = tickets();
      if(Tk && Tk.add) Tk.add({mode: "cab", line: J.cls.name, from: "Pickup", to: J.dest.name, depart: J.rideAt || J.t0, made: J.doneAt});
    } catch(e){}
    var hour = new Date(J.doneAt).getUTCHours();
    record({type: "ride", mode: "cab", line: J.cls.id, hour: hour, at: J.doneAt});
  }
  function stepRider(ms, dt){
    var J = job; if(!J) return;
    if(J.delegated){
      var st = J.sub && J.sub.state ? J.sub.state() : null, ph = st && (st.phase || st);
      if(ph === "done" || ph === "cancelled"){ J.phase = ph; if(ph === "done") record({type: "ride", mode: "cab", line: J.cls.id, at: ms}); job = null; }
      else if(ph) J.phase = ph;
      return;
    }
    if(J.phase === "matching" && ms >= J.matchAt) matched(J);
    else if(J.phase === "coming"){
      CALL.step(J.R, dt, Infinity);
      var e = etaOf(J.R);
      if(etaSay(J.lastEta, e)) say("Your Claude Cab is " + etaText(e) + " away.");
      J.lastEta = e;
      if(J.R.done){ J.phase = "here"; J.hereAt = ms; sfx("indicator", {pos: cabAt(J, 0.8), kind: "vehicle"}); say("Your Claude Cab is here: " + J.driver.model + ", plate " + J.driver.plate + ". Press E to get in."); }
    } else if(J.phase === "riding"){
      CALL.step(J.R, dt*(J.skipping ? SKIP_K : 1), Infinity);
      if(J.skipping && J.R.len - J.R.s < 120) J.skipping = false;
      if(J.R.done) finish(J);
    } else if(J.phase === "done" && ms - J.doneAt > 8000){ job = null; }
  }

  /* ----- driver mode ----- */
  function drvState(){
    var D = drv.job, m = me();
    return {on: drv.on, phase: drv.phase, offer: D ? D.offer : null, result: drv.result,
            metres: D ? Math.round(drv.phase === "pickup" ? dist(m, D.offer.pickup) : drv.phase === "trip" ? dist(m, D.offer.drop) : 0) : 0,
            stats: driverStats()};
  }
  function driverOn(on){
    if(!on){ drv.on = false; drv.phase = "off"; drv.job = null; show(null); say("You're off duty."); return {ok: true, text: "Off duty."}; }
    if(!me().driving) return {ok: false, text: "Get in a car first: one of yours (C to call it)."};
    drv.on = true; drv.phase = "idle"; drv.result = null;
    say("You're driving for Claude Cabs. Requests will come in here.");
    return {ok: true, text: "On duty."};
  }
  function offers(){
    if(!drv.on || drv.phase !== "idle") return [];
    var m = me();
    return requests(W(), clock(), w.seed, {x: num(m.x, 0), z: num(m.z, 0), r: NEAR_R});
  }
  function accept(id){
    if(!drv.on || drv.phase !== "idle") return false;
    var o = offers().filter(function(x){ return x.id === id; })[0];
    if(!o) return false;
    drv.job = {offer: o, log: {samples: [], kerb: 0}, kerb0: num(me().kerbHits, 0)};
    drv.phase = "pickup"; drv.result = null;
    var m = me(), RR = routeFor({x: num(m.x, 0), z: num(m.z, 0)}, o.pickup);
    show(RR.pts, "Pick up at " + dropName(W(), o.pickup));
    say("Accepted. Pick up your passenger " + Math.round(dist(m, o.pickup)) + " m away, at the beacon.");
    return true;
  }
  function stepDriver(ms){
    var D = drv.job; if(!drv.on || !D) return;
    var m = me(), v = Math.abs(num(m.speed, 0)), o = D.offer;
    if(drv.phase === "pickup"){
      if(!m.driving){ return; }
      if(dist(m, o.pickup) <= STOP_R && v < STOP_V){ drv.phase = "boarding"; D.t = ms; say("Your passenger is getting in."); sfx("door-chime", {pos: meAt(), kind: "own"}); }
    } else if(drv.phase === "boarding"){
      if(ms - D.t >= BOARD_MS){
        drv.phase = "trip"; D.t0 = ms; D.kerb0 = num(m.kerbHits, 0);
        var RR = routeFor({x: num(m.x, 0), z: num(m.z, 0)}, o.drop);
        D.expect = num(RR.len, o.metres)/9 + 20;
        show(RR.pts, "Drop off at " + o.drop.name);
        say("Take them to " + o.drop.name + ".");
      }
    } else if(drv.phase === "trip"){
      var L = D.log.samples, t = (ms - D.t0)/1000;
      if(!L.length || t - L[L.length - 1].t >= 0.25) L.push({t: t, v: v, street: m.street !== false});
      D.log.kerb = Math.max(0, num(m.kerbHits, 0) - D.kerb0) + drv.kerb;
      if(dist(m, o.drop) <= DROP_R && v < STOP_V){ drv.phase = "alighting"; D.t = ms; sfx("door-chime", {pos: meAt(), kind: "own"}); }
    } else if(drv.phase === "alighting"){
      if(ms - D.t >= ALIGHT_MS){
        var secs = (D.t - D.t0)/1000, res = scoreTrip({samples: D.log.samples, kerb: D.log.kerb, metres: o.metres, secs: secs, expect: D.expect});
        var stats = recordFare(res);
        drv.result = {points: res.points, stars: res.stars, parts: res.parts, totals: stats, to: o.drop.name};
        record({type: "fare", stars: res.stars, at: ms});
        drv.phase = "idle"; drv.job = null; drv.kerb = 0; show(null);
        say("Fare done: " + res.points + " points, " + res.stars + (res.stars === 1 ? " star" : " stars") + ". Driver score " + stats.score + ".");
      }
    }
  }

  /* ----- drawing ----- */
  function vehicleY(x, z){ return ground(x, z); }
  function cabsToDraw(ms){
    var L = [];
    var J = job;
    if(J && !J.delegated && J.R && (J.phase === "coming" || J.phase === "here" || J.phase === "riding" || J.phase === "done")){
      L.push({x: J.R.x, z: J.R.z, yaw: J.R.yaw, cls: J.cls.id, paint: J.driver.paint, modelId: J.driver.modelId, driver: true,
              passenger: J.phase === "riding" ? null : null});
    }
    return L;
  }
  function figuresToDraw(ms){
    var F = [], J = job, D = drv.job, m = me();
    if(J && !J.delegated && J.R && J.phase !== "matching" && J.phase !== "cancelled"){
      var dp = seatWorld({x: J.R.x, y: vehicleY(J.R.x, J.R.z), z: J.R.z, yaw: J.R.yaw}, J.cls.id === "bike" ? {x: 0, y: 0.95, z: 0.05} : {x: 0.42, y: 0.42, z: 0.2});
      F.push({x: dp.x, y: dp.y - 0.45, z: dp.z, yaw: dp.yaw, seated: true});
    }
    if(D && drv.on){
      var o = D.offer, car = {x: num(m.x, 0), y: num(m.y, vehicleY(num(m.x, 0), num(m.z, 0))), z: num(m.z, 0), yaw: num(m.yaw, 0)};
      var rear = seatWorld(car, {x: -0.42, y: 0.42, z: -0.62}), door = seatWorld(car, {x: -1.6, y: 0, z: -0.62});
      if(drv.phase === "pickup") F.push({x: o.npc.x, y: vehicleY(o.npc.x, o.npc.z), z: o.npc.z, yaw: o.pickup.yaw + Math.PI/2, seated: false});
      else if(drv.phase === "boarding" || drv.phase === "alighting"){
        var k = clamp((ms - D.t)/(drv.phase === "boarding" ? BOARD_MS : ALIGHT_MS), 0, 1), a = drv.phase === "boarding" ? o.npc : door, b = drv.phase === "boarding" ? door : o.npc;
        if(drv.phase === "alighting") b = {x: o.drop.x - Math.cos(o.drop.yaw)*3, z: o.drop.z + Math.sin(o.drop.yaw)*3};
        F.push({x: a.x + (b.x - a.x)*k, y: vehicleY(a.x, a.z), z: a.z + (b.z - a.z)*k, yaw: Math.atan2(b.x - a.x, b.z - a.z), seated: false});
      } else if(drv.phase === "trip") F.push({x: rear.x, y: rear.y - 0.45, z: rear.z, yaw: rear.yaw, seated: true});
    }
    return F;
  }
  function beaconAt(){
    var D = drv.job; if(!drv.on || !D) return null;
    if(drv.phase === "pickup" || drv.phase === "boarding") return D.offer.npc;
    if(drv.phase === "trip") return D.offer.drop;
    return null;
  }
  if(T) view = makeView(c, w, deps, calm);

  var api = {
    announces: true,
    classes: classes,
    quote: function(dest, cls){ var m = me(); return quote(W(), {x: num(m.x, 0), z: num(m.z, 0)}, dest, cls, clock(), w.seed); },
    request: request,
    cancel: function(){ return job ? cancelJob(job) : false; },
    current: function(){ return job ? job.handle : null; },
    state: function(){ return job ? job.handle.state() : {phase: "idle"}; },
    use: function(){ return job ? boardJob(job) : false; },
    driver: {on: driverOn, offers: offers, accept: accept, state: drvState, bump: function(){ if(drv.job && drv.phase === "trip") drv.kerb++; }},
    carry: function(ms){
      var J = job;
      if(!J || J.delegated || J.phase !== "riding" || !J.R) return null;
      var y = vehicleY(J.R.x, J.R.z), s = seatOf(J.cls.id), p = seatWorld({x: J.R.x, y: y, z: J.R.z, yaw: J.R.yaw}, s);
      return {x: p.x, y: p.y, z: p.z, yaw: p.yaw, anim: "sit", pillion: s.pillion, seat: s.pillion ? "pillion" : driveSide() < 0 ? "rear-left" : "rear-right"};
    },
    camPose: function(ms, look){
      var J = job; look = look || {};
      if(!J || J.delegated || J.phase !== "riding" || !J.R) return null;
      var y = vehicleY(J.R.x, J.R.z), s = seatOf(J.cls.id), p = seatWorld({x: J.R.x, y: y, z: J.R.z, yaw: J.R.yaw}, s);
      var SC = deps.seatCam || (HQV.hqRide && HQV.hqRide.seatCam);
      var vp = {x: J.R.x, y: y, z: J.R.z, yaw: J.R.yaw, pitch: 0, speed: J.R.v};
      // hqRide.seatCam puts the eye EYE_SIT (1.15 m) over the pose it is given: in a car that is the road (eyes about
      // 1.15 m up, under the roof); on a bike's pillion, 0.45 m higher
      if(SC) return SC({x: p.x, y: y + (s.pillion ? 0.45 : 0), z: p.z, yaw: p.yaw}, vp, look, look.mode || "seat", calm(), {t: ms, back: 9, up: 4});
      return {camera: true, pos: {x: p.x, y: p.y + 0.75, z: p.z}, look: {x: p.x + Math.sin(p.yaw)*10, y: p.y + 0.6, z: p.z + Math.cos(p.yaw)*10}, up: {x: 0, y: 1, z: 0}, fov: 70};
    },
    // the anchors a real NPC driver avatar can be seated on with hq3d's ridePose (seat, grips, feet): null headless
    driverRig: function(){ return view ? view.rig() : null; },
    update: function(ms, dt){
      nowMs = num(ms, nowMs); dt = clamp(num(dt, 0), 0, 0.25);
      stepRider(nowMs, dt); stepDriver(nowMs); engineStep(job, dt);
      if(view) view.update(nowMs, dt, cabsToDraw(nowMs), figuresToDraw(nowMs), beaconAt());
    },
    drawCalls: function(){ return view ? view.drawCalls() : 0; },
    tools: {
     // the screenshot tour: the cab coming to you jumps to the last few metres of its way (as a skip would)
     arrive: function(){
      var J = job; if(!J || J.phase !== "coming" || !J.R) return false;
      var R = J.R, s = Math.max(R.s || 0, R.len - 6);
      if(CALL && CALL.pointAt){ var p = CALL.pointAt(R, s); R.s = s; R.x = p.x; R.z = p.z; } else R.s = s;
      return true;
     },
     shotCam: function(name){
      var J = job, m = me();
      if(name === "cab-arrive" && J && J.R){ var y = vehicleY(J.R.x, J.R.z), yw = num(J.R.yaw, 0);
        return {pos: {x: J.R.x - Math.cos(yw)*7 + Math.sin(yw)*6, y: y + 2.2, z: J.R.z + Math.sin(yw)*7 + Math.cos(yw)*6}, look: {x: J.R.x, y: y + 1, z: J.R.z}, fov: 50}; }
      if(name === "cab-interior" && J && J.R){ var cp = api.camPose(clock(), {}); return cp ? {pos: cp.pos, look: cp.look, fov: cp.fov || 70} : null; }
      if(name === "driver-pickup"){ var b = beaconAt(); if(!b) return null; var by = vehicleY(b.x, b.z);
        return {pos: {x: num(m.x, b.x) + (num(m.x, b.x) - b.x)*0.3, y: by + 6, z: num(m.z, b.z) + (num(m.z, b.z) - b.z)*0.3 - 8}, look: {x: b.x, y: by + 2, z: b.z}, fov: 55}; }
      return null;
    }},
    dispose: function(){ if(engP){ engP.stop(); engP = null; } if(view) view.dispose(); view = null; job = null; drv.on = false; drv.job = null; }
  };
  return api;
}

/* ---------- drawing (THREE; never loaded under node) ---------- */
function makeView(c, w, deps, calmF){
  var T = c.THREE, parent = (w && w.group) || c.scene || null;
  var g = new T.Group(); g.name = "hqcabs";
  if(parent && parent.add) parent.add(g);
  var CAP = 8;
  function rgb(hex){ return [((hex >> 16) & 255)/255, ((hex >> 8) & 255)/255, (hex & 255)/255]; }
  // a box's triangles into flat arrays (position, normal, colour), centred at (x, y, z)
  function pushBox(A, w0, h, d, x, y, z, col){
    var G = new T.BoxGeometry(w0, h, d); G.translate(x, y, z);
    var P = G.getAttribute("position"), N = G.getAttribute("normal"), I = G.index, C = rgb(col);
    for(var i = 0; i < I.count; i++){ var k = I.getX(i); A.p.push(P.getX(k), P.getY(k), P.getZ(k)); A.n.push(N.getX(k), N.getY(k), N.getZ(k)); A.c.push(C[0], C[1], C[2]); }
    G.dispose();
  }
  function pushCyl(A, r, wdt, x, y, z, col){
    var G = new T.CylinderGeometry(r, r, wdt, 12); G.rotateZ(Math.PI/2); G.translate(x, y, z);
    var P = G.getAttribute("position"), N = G.getAttribute("normal"), I = G.index, C = rgb(col);
    for(var i = 0; i < I.count; i++){ var k = I.getX(i); A.p.push(P.getX(k), P.getY(k), P.getZ(k)); A.n.push(N.getX(k), N.getY(k), N.getZ(k)); A.c.push(C[0], C[1], C[2]); }
    G.dispose();
  }
  function geo(A){
    var G = new T.BufferGeometry();
    G.setAttribute("position", new T.Float32BufferAttribute(A.p, 3)); G.setAttribute("normal", new T.Float32BufferAttribute(A.n, 3));
    G.setAttribute("color", new T.Float32BufferAttribute(A.c, 3));
    return G;
  }
  // a reference saloon 4.8 x 1.9 x 1.45 m (scaled per instance to its model's size); forward +z, +x is left
  var paintA = {p: [], n: [], c: []}, livA = {p: [], n: [], c: []};
  pushBox(paintA, 1.9, 0.56, 4.8, 0, 0.62, 0, 0xffffff);
  pushBox(paintA, 1.62, 0.06, 2.2, 0, 1.42, -0.25, 0xffffff);
  pushBox(livA, 1.92, 0.12, 4.82, 0, 0.62, 0, TERRACOTTA);                        // the band
  pushBox(livA, 1.64, 0.5, 2.3, 0, 1.15, -0.25, 0x223040);                        // glass
  [1, -1].forEach(function(s){
    pushBox(livA, 0.02, 0.32, 0.62, s*0.965, 0.82, 0.55, CREAM);                  // door decals
    pushBox(livA, 0.02, 0.32, 0.62, s*0.965, 0.82, -0.85, CREAM);
    pushBox(livA, 0.025, 0.12, 0.12, s*0.97, 0.82, 0.55, TERRACOTTA);
    pushBox(livA, 0.025, 0.12, 0.12, s*0.97, 0.82, -0.85, TERRACOTTA);
    pushCyl(livA, 0.34, 0.24, s*0.84, 0.34, 1.5, 0x1b1d20); pushCyl(livA, 0.34, 0.24, s*0.84, 0.34, -1.5, 0x1b1d20);
    pushBox(livA, 0.3, 0.1, 0.04, s*0.62, 0.72, 2.41, 0xfff6e0); pushBox(livA, 0.3, 0.1, 0.04, s*0.62, 0.74, -2.41, 0xd02020);
  });
  // a bike: one frame/tank/seat block (paint) and wheels + band (livery), 2.1 m long
  var bikeP = {p: [], n: [], c: []}, bikeL = {p: [], n: [], c: []};
  pushBox(bikeP, 0.34, 0.3, 0.9, 0, 0.82, 0.15, 0xffffff); pushBox(bikeP, 0.3, 0.12, 0.7, 0, 0.92, -0.45, 0xffffff);
  pushCyl(bikeL, 0.32, 0.12, 0, 0.32, 0.72, 0x1b1d20); pushCyl(bikeL, 0.32, 0.14, 0, 0.32, -0.72, 0x1b1d20);
  pushBox(bikeL, 0.36, 0.06, 0.9, 0, 0.7, 0.15, TERRACOTTA); pushBox(bikeL, 0.06, 0.5, 0.06, 0, 0.75, 0.65, 0x333333);
  pushBox(bikeL, 0.62, 0.04, 0.04, 0, 1.05, 0.6, 0x222222);
  // a person 1.7 m (legs, torso, head); a seated one is drawn 0.45 m lower (legs inside the car)
  var figA = {p: [], n: [], c: []};
  pushBox(figA, 0.36, 0.8, 0.22, 0, 0.4, 0, 0x2c3440); pushBox(figA, 0.44, 0.6, 0.26, 0, 1.1, 0, 0x7a5a48); pushBox(figA, 0.22, 0.24, 0.24, 0, 1.55, 0, 0xd9b08c);
  var paintM = new T.MeshStandardMaterial({color: 0xffffff, roughness: 0.4, metalness: 0.3});
  var livM = new T.MeshStandardMaterial({vertexColors: true, roughness: 0.5, metalness: 0.2});
  var figM = new T.MeshStandardMaterial({vertexColors: true, roughness: 0.8});
  function inst(G, M, n){ var m = new T.InstancedMesh(G, M, n); m.count = 0; m.visible = false; m.frustumCulled = false; g.add(m); return m; }
  var carP = inst(geo(paintA), paintM, CAP), carL = inst(geo(livA), livM, CAP), bkP = inst(geo(bikeP), paintM, CAP), bkL = inst(geo(bikeL), livM, CAP);
  var figs = inst(geo(figA), figM, CAP*2);
  // the lit roof sign: CLAUDE CABS on a canvas (cream on terracotta), unlit so it reads at night
  var signTex = null;
  try {
    var doc = root.document, cv = doc && doc.createElement ? doc.createElement("canvas") : null;
    if(cv && cv.getContext){
      cv.width = 256; cv.height = 64; var x2 = cv.getContext("2d");
      if(x2){ x2.fillStyle = "#c9643b"; x2.fillRect(0, 0, 256, 64); x2.fillStyle = "#f3ede2"; x2.font = "800 34px system-ui, sans-serif";
              x2.textAlign = "center"; x2.textBaseline = "middle"; x2.fillText("CLAUDE CABS", 128, 34); signTex = new T.CanvasTexture(cv); }
    }
  } catch(e){ signTex = null; }
  var signG = new T.BoxGeometry(0.95, 0.26, 0.24); signG.translate(0, 1.6, -0.3);
  var sign = inst(signG, new T.MeshBasicMaterial(signTex ? {map: signTex, toneMapped: false} : {color: 0xe08a62, toneMapped: false}), CAP);
  // the pickup beacon: a soft light column (Calm: a still ring on the ground)
  var colG = new T.CylinderGeometry(1.6, 1.6, 34, 24, 1, true); colG.translate(0, 17, 0);
  var beamM = new T.MeshBasicMaterial({color: 0xffc27a, transparent: true, opacity: 0.22, depthWrite: false, blending: T.AdditiveBlending, side: T.DoubleSide});
  var beam = new T.Mesh(colG, beamM); beam.visible = false; g.add(beam);
  var ringG = new T.RingGeometry(2.2, 2.8, 40); ringG.rotateX(-Math.PI/2);
  var ring = new T.Mesh(ringG, new T.MeshBasicMaterial({color: 0xffc27a, transparent: true, opacity: 0.85, depthWrite: false, side: T.DoubleSide})); ring.visible = false; g.add(ring);
  // the anchors an NPC driver avatar can be seated on (hq3d ridePose: seat, grips, feet; +x is left, forward +z)
  var rigG = new T.Group(); rigG.name = "hqcabs-driver"; g.add(rigG);
  function anchor(x, y, z){ var o = new T.Object3D(); o.position.set(x, y, z); rigG.add(o); return o; }
  var RIG = {g: rigG, seat: anchor(0.42, 0.5, 0.2), grips: [anchor(0.6, 1.0, 0.72), anchor(0.24, 1.0, 0.72)],
             feet: [anchor(0.52, 0.25, 1.15), anchor(0.32, 0.25, 1.15)], lean: 0, riderK: 1, hats: false, brake: function(){}};
  var M4 = new T.Matrix4(), Q = new T.Quaternion(), V = new T.Vector3(), S = new T.Vector3(), UP = new T.Vector3(0, 1, 0), COL = new T.Color();
  function dimsOf(modelId){
    var VM = (deps && deps.models) || HQV.hqVehicleModels, cat = deps && deps.catalogue, e = null;
    var L = catVehicles(cat); for(var i = 0; i < L.length; i++) if(L[i].id === modelId){ e = L[i]; break; }
    try { if(VM && e && VM.shown) return VM.shown(e); if(VM && e && VM.dims) return VM.dims(e); } catch(x){}
    return null;
  }
  var dimCache = {};
  function scaleFor(cab){
    var k = cab.cls + ":" + cab.modelId; if(dimCache[k]) return dimCache[k];
    var D = dimsOf(cab.modelId), s;
    if(cab.cls === "bike") s = D ? [D.widthM/0.8, D.heightM/1.15, D.lengthM/2.1] : [1, 1, 1];
    else s = D ? [D.widthM/1.9, D.heightM/1.45, D.lengthM/4.8] : cab.cls === "xl" ? [1.06, 1.2, 1.03] : cab.cls === "go" ? [0.95, 1.02, 0.9] : [1, 1, 1];
    return (dimCache[k] = s);
  }
  var nCalls = 0;
  function update(ms, dt, cabs, people, bc){
    var nc = 0, nb = 0, nf = 0, calm = false; try { calm = !!calmF(); } catch(e){}
    cabs.forEach(function(cab){
      var y = w && w.ground ? num(w.ground(cab.x, cab.z), 0) : 0, s = scaleFor(cab);
      Q.setFromAxisAngle(UP, num(cab.yaw, 0)); V.set(cab.x, y, cab.z); S.set(s[0], s[1], s[2]); M4.compose(V, Q, S);
      COL.set(cab.paint || "#1f2a36");
      if(cab.cls === "bike"){ if(nb < CAP){ bkP.setMatrixAt(nb, M4); bkL.setMatrixAt(nb, M4); bkP.setColorAt(nb, COL); nb++; } }
      else if(nc < CAP){ carP.setMatrixAt(nc, M4); carL.setMatrixAt(nc, M4); sign.setMatrixAt(nc, M4); carP.setColorAt(nc, COL); nc++; }
      if(cab.driver && cab.cls !== "bike"){ rigG.position.set(cab.x, y, cab.z); rigG.rotation.set(0, num(cab.yaw, 0), 0); }
    });
    people.forEach(function(f){
      if(nf >= CAP*2) return;
      Q.setFromAxisAngle(UP, num(f.yaw, 0)); V.set(f.x, num(f.y, 0), f.z); S.set(1, 1, 1); M4.compose(V, Q, S); figs.setMatrixAt(nf++, M4);
    });
    [[carP, nc], [carL, nc], [sign, nc], [bkP, nb], [bkL, nb], [figs, nf]].forEach(function(p){
      p[0].count = p[1]; p[0].visible = p[1] > 0; p[0].instanceMatrix.needsUpdate = true; if(p[0].instanceColor) p[0].instanceColor.needsUpdate = true;
    });
    beam.visible = !!bc && !calm; ring.visible = !!bc && calm;
    if(bc){
      var by = w && w.ground ? num(w.ground(bc.x, bc.z), 0) : 0;
      beam.position.set(bc.x, by, bc.z); ring.position.set(bc.x, by + 0.06, bc.z);
      if(!calm) beamM.opacity = 0.18 + 0.06*Math.sin(ms/700);           // a slow breath (pure of time)
    }
    nCalls = [carP, carL, sign, bkP, bkL, figs, beam, ring].filter(function(m){ return m.visible; }).length;
  }
  return {
    update: update, rig: function(){ return RIG; }, drawCalls: function(){ return nCalls; },
    dispose: function(){
      if(g.parent) g.parent.remove(g);
      g.traverse(function(o){ if(o.geometry) o.geometry.dispose(); if(o.material && o.material.dispose) o.material.dispose(); });
      if(signTex) signTex.dispose();
    }
  };
}

HQV.hqCabs = {classes: classes, classOf: classOf, quote: quote, driverFor: driverFor, requests: requests, rateDrive: rateDrive,
              scoreTrip: scoreTrip, driverStats: driverStats, recordFare: recordFare, etaSay: etaSay, etaText: etaText,
              seatOf: seatOf, seatWorld: seatWorld, roadEdges: roadEdges, mount: mount, hash32: hash32, revs: revs, voices: CAB_VOICE,
              consts: {STREET_V: STREET_V, SLOT_MS: SLOT_MS, OFFER_MS: OFFER_MS, NEAR_R: NEAR_R, DROP_MIN: DROP_MIN, DROP_MAX: DROP_MAX,
                       SKIP_OVER: SKIP_OVER, SKIP_K: SKIP_K, STOP_R: STOP_R, STOP_V: STOP_V, HARSH: HARSH, SPEED_LIMIT: SPEED_LIMIT,
                       MATCH_MIN: MATCH_MIN, MATCH_SPAN: MATCH_SPAN, STATS_KEY: STATS_KEY}};
})();
