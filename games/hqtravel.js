/* Claude HQ: trips between islands (HQV.hqTravel, docs/plans/cities-build-spec.md, task cl-travel).
 *
 * Pure apart from two edges the host hands in: the hooks (fetch, build, fare, clock) and the
 * visited-islands memory in localStorage. No THREE, no DOM, so tests/test_hqtravel.py runs it under node.
 *   ferry   scheduled sailings (every 90 s, offset per route), 60-90 s by distance; a dock or port at both ends; free
 *   rail    30-45 s; each end is tier 4+ with a station (the transit site) or is the Commons; free
 *   plane   a short cutscene (14-20 s) then a landing played in the destination; each end is tier 5 with an
 *           airport or is the Commons airport; free
 *   fast    a fade; only to an island you have visited (the Commons is always open); 1 coin via hooks.fare
 *   boat    driven by the player (games/hqboat.js); travel only lands you: arrive(world, dockSiteId, hooks)
 * A trip loads the destination doc and city state AT departure and builds it during the ride: arrival
 * waits for both the build and the ride's minimum time, so there is no loading screen. A failed load
 * puts you back at the origin's dock (station, airport) with a message.
 * The host drives a trip with update() once a frame; every pose (vehicle, camera, fade) is a pure function
 * of the time since departure, so it is frame-rate independent.
 * Docs are WorldDoc JSON (cm); poses are metres in the origin world's frame (+z north, yaw 0 faces +z),
 * or in the destination's frame once arrived (pose.frame says which).
 * A city here is {world, tier, doc?, city?, name?, x?, z?}: x, z are its archipelago position (m) from
 * GET /v1/archipelago; doc is its WorldDoc when the client already has it (the one you stand in always is).
 */
(function(){
"use strict";
var HQV = window.HQV = window.HQV || {};

var COMMONS = "claude-hq@2";
var ISLAND_RE = /^user:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}@[0-9]+$/;
var WORLD_RE = /^claude-hq@[0-9]+$/;
var VISITED_KEY = "hq_travel_visited", VISITED_MAX = 200;

// per mode: the ride's minimum seconds (lerped by distance), cruise speed (m/s), cruise height (m),
// the arrival segment played in the destination (s), and the site kinds it leaves from and lands at
var MODES = {
  ferry: {min: 60, max: 90, speed: 12, height: 0, arrive: 0, kinds: ["port", "dock"], free: true},
  rail:  {min: 30, max: 45, speed: 45, height: 6, arrive: 0, kinds: ["transit"], tier: 4, free: true},
  plane: {min: 14, max: 20, speed: 120, height: 420, arrive: 6, kinds: ["airport"], tier: 5, free: true},
  fast:  {min: 1.5, max: 1.5, speed: 0, height: 0, arrive: 0.5, kinds: ["spawn", "townhall"], fee: 1}
};
var ORDER = ["ferry", "rail", "plane", "fast"];
var FERRY_EVERY = 90000;        // ms between sailings on a route
var NEAR = 3000, FAR = 15000;   // archipelago distances (m) mapped onto a mode's min..max ride time
var LOAD_TIMEOUT = 45;          // s past the ride's minimum before a load that never settles counts as failed
var FADE = 0.5;                 // fast travel: fade out / in (s)

function clamp(v, a, b){ return v < a ? a : v > b ? b : v; }
function lerp(a, b, t){ return a + (b - a)*t; }
function smootherstep(t){ t = clamp(t, 0, 1); return t*t*t*(t*(t*6 - 15) + 10); }
function v3(x, y, z){ return {x: x, y: y, z: z}; }

/* ---------- ids and rooms ---------- */
function validWorld(w){ return typeof w === "string" && (WORLD_RE.test(w) || ISLAND_RE.test(w)); }
function isCommons(w){ return w === COMMONS; }
function isIsland(w){ return typeof w === "string" && ISLAND_RE.test(w); }
// the net room for an island's players; null for anything that is not a world id
function roomFor(w){ return validWorld(w) ? "city3d:" + w : null; }

/* ---------- visited islands (a per-viewer convenience; unreadable storage = nothing visited) ---------- */
function store(){ try { return window.localStorage || null; } catch(e){ return null; } }
function visitedList(){
  var s = store(), raw = null;
  if(!s) return [];
  try { raw = s.getItem(VISITED_KEY); } catch(e){ return []; }
  var a = null;
  try { a = JSON.parse(raw || "[]"); } catch(e){ a = null; }
  return Array.isArray(a) ? a.filter(validWorld) : [];
}
function markVisited(w){
  if(!validWorld(w)) return;
  var a = visitedList();
  if(a.indexOf(w) >= 0) return;
  a.push(w);
  if(a.length > VISITED_MAX) a = a.slice(a.length - VISITED_MAX);
  var s = store();
  if(s) try { s.setItem(VISITED_KEY, JSON.stringify(a)); } catch(e){}
}
function unlocked(w){ return isCommons(w) || visitedList().indexOf(w) >= 0; }

/* ---------- sites ---------- */
function tierOf(c){ return isCommons(c.world) && c.tier == null ? 5 : clamp((c.tier | 0) || 1, 1, 5); }
function sitesOf(doc){ return (doc && doc.layers && doc.layers.sites) || []; }
// the first site (by id) of the given kinds, in kind order, that exists at this tier
function findSite(doc, kinds, tier){
  var sites = sitesOf(doc);
  for(var k = 0; k < kinds.length; k++){
    var hit = null;
    for(var i = 0; i < sites.length; i++){
      var s = sites[i];
      if(s.kind !== kinds[k] || (s.tier != null && s.tier > tier)) continue;
      if(!hit || String(s.id) < String(hit.id)) hit = s;
    }
    if(hit) return hit;
  }
  return null;
}
function siteById(doc, id){
  var sites = sitesOf(doc);
  for(var i = 0; i < sites.length; i++) if(sites[i].id === id) return sites[i];
  return null;
}
// Does this city have a mode's terminal? From its doc when we have it; otherwise presumed from the
// profile: every island has docks, a station from tier 4 and an airport at tier 5; the Commons has all.
function hasTerminal(c, mode){
  var M = MODES[mode], tier = tierOf(c);
  if(M.tier && !isCommons(c.world) && tier < M.tier) return false;
  if(c.doc) return !!findSite(c.doc, M.kinds, isCommons(c.world) ? 5 : tier);
  return isCommons(c.world) || isIsland(c.world);
}

/* ---------- options ---------- */
function distance(a, b){
  if(!isFinite(a.x) || !isFinite(a.z) || !isFinite(b.x) || !isFinite(b.z)) return null;
  return Math.hypot(b.x - a.x, b.z - a.z);
}
function rideSeconds(mode, from, to){
  var M = MODES[mode], d = distance(from, to);
  return d == null ? M.min : lerp(M.min, M.max, clamp((d - NEAR)/(FAR - NEAR), 0, 1));
}
// FNV-1a over the route (order-free), so both directions share sailings
function routeHash(a, b){
  var s = a < b ? a + "|" + b : b + "|" + a, h = 2166136261;
  for(var i = 0; i < s.length; i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h;
}
// the next ferry sailing at or after nowMs: the same for every client
function nextSailing(fromWorld, toWorld, nowMs){
  var off = (routeHash(fromWorld, toWorld) % (FERRY_EVERY/1000))*1000;
  return Math.ceil((nowMs - off)/FERRY_EVERY)*FERRY_EVERY + off;
}
// The ways from one city to another: [{mode, seconds, fee, departs?}], or [] for the same city.
// "boat" is listed when both ends have docks; the player drives it, so start() refuses it.
function options(from, to, nowMs){
  if(!from || !to || !validWorld(from.world) || !validWorld(to.world) || from.world === to.world) return [];
  var out = [];
  ORDER.forEach(function(m){
    var M = MODES[m], ok = m === "fast" ? unlocked(to.world) : hasTerminal(from, m) && hasTerminal(to, m);
    if(!ok) return;
    var o = {mode: m, seconds: rideSeconds(m, from, to), fee: M.fee || 0};
    if(m === "ferry" && nowMs != null) o.departs = nextSailing(from.world, to.world, nowMs);
    out.push(o);
  });
  if(hasTerminal(from, "ferry") && hasTerminal(to, "ferry")) out.push({mode: "boat", seconds: null, fee: 0, self: true});
  return out;
}

/* ---------- spawns ---------- */
// A site's yaw and a point just outside it on the side its door faces (m). front is a Q16 unit vector;
// @1 sites carry facing "north" (+z) / "south" instead.
function frontOf(s){
  if(s.front && s.front.length === 2){
    var fx = s.front[0]/65536, fz = s.front[1]/65536, l = Math.hypot(fx, fz);
    if(l > 1e-6) return [fx/l, fz/l];
  }
  return s.facing === "south" ? [0, -1] : [0, 1];
}
function halfDepth(s, f){
  if(s.poly && s.poly.length){
    var m = 0;
    s.poly.forEach(function(p){ m = Math.max(m, ((p[0] - s.x)*f[0] + (p[1] - s.z)*f[1])/100); });
    return m;
  }
  return Math.max(s.w || 0, s.d || 0)/200;
}
function spawnAt(world, s){
  if(!s) return {world: world, site: null, x: 0, y: 0, z: 0, yaw: 0};
  var f = frontOf(s), h = halfDepth(s, f) + 2;
  return {world: world, site: s.id, x: s.x/100 + f[0]*h, y: (s.y || 0)/100, z: s.z/100 + f[1]*h, yaw: Math.atan2(f[0], f[1])};
}
// where a mode leaves from / lands in a city (its terminal, else the spawn, town hall, any dock, the origin)
function terminal(c, mode, doc){
  var tier = isCommons(c.world) ? 5 : tierOf(c);
  return findSite(doc, MODES[mode].kinds, tier) || findSite(doc, ["spawn", "townhall", "port", "dock"], tier);
}

/* ---------- the ride: vehicle, camera and fade as pure functions of time ---------- */
// The trip frame: the departure site, heading toward the destination (else out to sea, away from the door).
function frameOf(mode, from, to, site){
  var o = spawnAt(from.world, site), d = distance(from, to), yaw;
  if(d != null && d > 1) yaw = Math.atan2(to.x - from.x, to.z - from.z);
  else yaw = site ? Math.atan2(-frontOf(site)[0], -frontOf(site)[1]) : 0;
  return {x: o.x, y: o.y, z: o.z, yaw: yaw};
}
function toWorld(F, side, up, fwd){
  var s = Math.sin(F.yaw), c = Math.cos(F.yaw);
  // +x LEFT of the heading in model space (camrig's convention); side here is metres to the right
  return v3(F.x + s*fwd - c*side, F.y + up, F.z + c*fwd + s*side);
}
// the vehicle at time t (s) of a ride of T seconds: along the heading, eased in and out; the plane climbs
function vehicleAt(mode, F, T, t){
  var M = MODES[mode], u = clamp(t/T, 0, 1), L = M.speed*T*0.53, along = L*smootherstep(u), y = M.height;
  if(mode === "plane") y = M.height*smootherstep(u/0.35);
  return {pos: toWorld(F, 0, y, along), yaw: F.yaw, u: u};
}
// camera shots relative to the vehicle (back, up, side m), cross-faded at these fractions of the ride
var SHOTS = {
  ferry: [{u: 0, back: 22, up: 9, side: 0}, {u: 0.3, back: 45, up: 22, side: 18},
          {u: 0.65, back: 4, up: 7, side: 40}, {u: 1, back: -35, up: 10, side: 12}],
  rail:  [{u: 0, back: 18, up: 6, side: 0}, {u: 0.4, back: 10, up: 4, side: 24}, {u: 1, back: -30, up: 8, side: 8}],
  plane: [{u: 0, back: 40, up: 8, side: 0}, {u: 0.35, back: 30, up: -6, side: 50}, {u: 1, back: 70, up: 25, side: 10}]
};
function shotAt(list, u){
  for(var i = 1; i < list.length; i++) if(u <= list[i].u){
    var a = list[i - 1], b = list[i], e = smootherstep((u - a.u)/(b.u - a.u));
    return {back: lerp(a.back, b.back, e), up: lerp(a.up, b.up, e), side: lerp(a.side, b.side, e)};
  }
  return list[list.length - 1];
}
// The ride's cinematic pose at t (s): {frame: "from", camera, pos, look, up, fov, fade, vehicle}, the shape
// camrig's step() returns, so the host can render it as a cinematic. Fast travel has no vehicle: the camera
// is the host's own and only the fade matters (camera: false, pos and look null).
function ridePose(mode, F, T, t){
  if(mode === "fast") return {frame: "from", camera: false, pos: null, look: null, up: v3(0, 1, 0), fov: 65,
                              fade: smootherstep(t/FADE), vehicle: null};
  var V = vehicleAt(mode, F, T, t), S = shotAt(SHOTS[mode], V.u);
  var vf = {x: V.pos.x, y: V.pos.y, z: V.pos.z, yaw: F.yaw};
  return {frame: "from", camera: true, pos: toWorld(vf, S.side, S.up, -S.back), look: toWorld(vf, 0, 2, 8),
          up: v3(0, 1, 0), fov: mode === "plane" ? 55 : 60, fade: 0, vehicle: V};
}
// The landing (plane) or fade-in (fast) in the destination, t seconds after arrival, ending on the spawn.
function arrivePose(mode, spawn, t){
  var M = MODES[mode], u = clamp(t/(M.arrive || 1), 0, 1);
  if(mode !== "plane") return {frame: "to", camera: false, pos: null, look: null, up: v3(0, 1, 0), fov: 65,
                               fade: mode === "fast" ? 1 - smootherstep(u) : 0, vehicle: null};
  var F = {x: spawn.x, y: spawn.y, z: spawn.z, yaw: spawn.yaw + Math.PI}, e = smootherstep(u);
  // final approach: from 600 m out and 120 m up, onto the airport's apron
  var p = toWorld(F, 0, 120*(1 - e), -600*(1 - e));
  var veh = {pos: p, yaw: spawn.yaw + Math.PI, u: u}, vf = {x: p.x, y: p.y, z: p.z, yaw: F.yaw};
  return {frame: "to", camera: true, pos: toWorld(vf, 30, 10 + 4*e, -50), look: toWorld(vf, 0, 2, 10),
          up: v3(0, 1, 0), fov: 55, fade: 0, vehicle: veh};
}

/* ---------- trips ---------- */
var NAMES = {ferry: "dock", rail: "station", plane: "airport", fast: "plaza"};
function failMsg(mode, to, why){
  var where = to.name ? String(to.name) : "the island";
  return why === "fare" ? "Fast travel needs " + MODES.fast.fee + " coin; you're still here."
       : "Couldn't reach " + where + ". You're back at the " + NAMES[mode] + ".";
}

// start(mode, from, to, hooks) -> a trip (ok: true) or {ok: false, error}. hooks:
//   fetchDoc(world) -> Promise<WorldDoc>, fetchCity(world)? -> Promise<CityState>, buildWorld(doc, city) -> Promise,
//   fare(kind, to)? -> Promise (fast travel only), onProgress(p)?, onArrive(spawn, built), now()? (ms; Date.now)
// The host calls trip.update() every frame and renders trip.pose().
function start(mode, from, to, hooks){
  hooks = hooks || {};
  if(!MODES[mode]) return {ok: false, error: mode === "boat" ? "Take the helm: boats are driven, not booked." : "No such way to travel."};
  var opts = options(from, to);
  if(!opts.some(function(o){ return o.mode === mode; }))
    return {ok: false, error: mode === "fast" ? "Fast travel opens once you've visited." : "That way isn't open between these cities."};
  var clock = hooks.now || function(){ return Date.now(); };
  var M = MODES[mode], t0 = clock(), originSite = terminal(from, mode, from.doc);
  var trip = {ok: true, mode: mode, from: from.world, to: to.world, room: roomFor(to.world),
    seconds: rideSeconds(mode, from, to), phase: "boarding", startedAt: t0, departAt: null,
    loadStartedAt: null, builtAt: null, arrivedAt: null, spawn: null, message: null,
    frame: frameOf(mode, from, to, originSite)};
  var doc = null, city = null, built = null, ok = false, err = null, ended = false;
  markVisited(from.world);
  if(mode === "ferry") trip.departAt = nextSailing(from.world, to.world, t0);

  function progress(){
    if(!hooks.onProgress) return;
    var t = trip.departAt != null ? Math.max(0, (clock() - trip.departAt)/1000) : 0;
    hooks.onProgress({phase: trip.phase, mode: mode, t: t, seconds: trip.seconds, frac: clamp(t/trip.seconds, 0, 1),
                      loaded: ok ? "built" : doc ? "doc" : err ? "failed" : trip.loadStartedAt != null ? "loading" : "waiting",
                      departs: trip.phase === "boarding" ? trip.departAt : null});
  }
  function depart(){
    trip.phase = "riding";
    if(trip.departAt == null) trip.departAt = clock();
    trip.loadStartedAt = clock();
    // the doc and the city state together, then the build, all while the ride plays
    Promise.all([Promise.resolve().then(function(){ return hooks.fetchDoc(to.world); }),
                 Promise.resolve().then(function(){ return hooks.fetchCity ? hooks.fetchCity(to.world) : to.city || null; })])
      .then(function(r){
        if(ended) return null;
        doc = r[0]; city = r[1];
        if(!doc || !doc.layers) throw new Error("bad doc");
        return Promise.resolve(hooks.buildWorld(doc, city));
      })
      .then(function(b){ if(!ended && doc){ built = b; ok = true; trip.builtAt = clock(); } },
            function(e){ if(!ended) err = e || new Error("load failed"); });
  }
  function fail(why){
    // the fade as it stood (fast travel may be mid fade-out): the failed pose fades back in from there
    trip.failFade = trip.pose().fade;
    trip.failedAt = clock();
    ended = true;
    trip.phase = "failed";
    trip.message = failMsg(mode, to, why);
    var sp = spawnAt(from.world, originSite);
    sp.failed = true; sp.message = trip.message;
    trip.spawn = sp;
    progress();
    if(hooks.onArrive) hooks.onArrive(sp, null);
  }
  function arrive(){
    // the tier the city state just fetched says, else the one the archipelago listed
    var at = {world: to.world, tier: city && city.tier != null ? city.tier : to.tier};
    trip.spawn = spawnAt(to.world, terminal(at, mode, doc));
    // the moment both the ride and the build were done, not the frame that noticed: the landing stays frame-rate independent
    trip.arrivedAt = Math.max(trip.departAt + trip.seconds*1000, trip.builtAt);
    trip.phase = M.arrive ? "arriving" : "done";
    markVisited(to.world);
    progress();
    if(hooks.onArrive) hooks.onArrive(trip.spawn, built);
  }

  // advance the trip; returns its phase
  trip.update = function(){
    var now = clock();
    if(trip.phase === "boarding" && now >= trip.departAt) depart();
    if(trip.phase === "riding" || trip.phase === "holding"){
      var t = (now - trip.departAt)/1000;
      if(err) fail("load");
      else if(ok && t >= trip.seconds) arrive();
      else if(t >= trip.seconds + LOAD_TIMEOUT) fail("load");
      else { if(t >= trip.seconds) trip.phase = "holding"; progress(); }
    } else if(trip.phase === "arriving"){
      if((now - trip.arrivedAt)/1000 >= M.arrive){ trip.phase = "done"; ended = true; progress(); }
    } else if(trip.phase === "boarding") progress();
    if(trip.phase === "done") ended = true;
    return trip.phase;
  };
  // the cinematic for the camera rig (and the vehicle and fade) now
  trip.pose = function(){
    var now = clock();
    if(trip.phase === "arriving" || trip.phase === "done") return arrivePose(mode, trip.spawn, (now - trip.arrivedAt)/1000);
    // back at the origin terminal: no cinematic, and any fade lifts
    if(trip.phase === "failed") return {frame: "from", camera: false, pos: null, look: null, up: v3(0, 1, 0), fov: 65,
                                        fade: trip.failFade*(1 - smootherstep((now - trip.failedAt)/1000/FADE)), vehicle: null};
    var t = trip.departAt != null && trip.phase !== "boarding" ? (now - trip.departAt)/1000 : 0;
    return ridePose(mode, trip.frame, trip.seconds, t);
  };

  if(mode === "fast"){
    trip.phase = "paying";
    Promise.resolve().then(function(){ return hooks.fare ? hooks.fare("fast", to) : null; })
      .then(function(){ if(!ended) depart(); }, function(){ if(!ended) fail("fare"); });
  } else if(mode !== "ferry") depart();
  return trip;
}

// A boat (games/hqboat.js) reached an island's dock: load and build it, then spawn on that dock.
// Resolves with the spawn; a failed load resolves {failed: true, message} and you stay on the water.
function arrive(world, dockSiteId, hooks){
  hooks = hooks || {};
  if(!validWorld(world)) return Promise.resolve({failed: true, world: null, message: "That's not an island."});
  var doc = null;
  return Promise.all([Promise.resolve().then(function(){ return hooks.fetchDoc(world); }),
                      Promise.resolve().then(function(){ return hooks.fetchCity ? hooks.fetchCity(world) : null; })])
    .then(function(r){
      doc = r[0];
      if(!doc || !doc.layers) throw new Error("bad doc");
      return hooks.buildWorld(doc, r[1]);
    })
    .then(function(b){
      var s = siteById(doc, dockSiteId) || findSite(doc, ["dock", "port", "spawn"], 5), sp = spawnAt(world, s);
      markVisited(world);
      if(hooks.onArrive) hooks.onArrive(sp, b);
      return sp;
    }, function(){
      var sp = {failed: true, world: null, message: "Couldn't moor here; the island didn't load."};
      if(hooks.onArrive) hooks.onArrive(sp, null);
      return sp;
    });
}

HQV.hqTravel = {MODES: MODES, ORDER: ORDER, COMMONS: COMMONS, FERRY_EVERY: FERRY_EVERY, LOAD_TIMEOUT: LOAD_TIMEOUT,
  options: options, start: start, arrive: arrive, roomFor: roomFor, nextSailing: nextSailing, rideSeconds: rideSeconds,
  visited: visitedList, markVisited: markVisited, unlocked: unlocked, spawnAt: spawnAt, ridePose: ridePose,
  arrivePose: arrivePose, smootherstep: smootherstep};
})();
