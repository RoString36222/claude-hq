/* Claude HQ: the city's event director (HQV.citySim, Living City plan 2.1), a pure simulation.
 *
 * HQV.citySim.create(doc, {seed, tier, coverage, tzMin}) -> D. Every event is a pure function of (world doc, tier,
 * coverage, seed, UTC ms): two clients with the same inputs see the same fire at the same moment, with no server
 * traffic, whatever order they ask in. The doc is a WorldDoc as npcsim and traffic get it (layers.roads nodes and
 * edges with points, sites, lots, districts; cm); edges, sites and lots above the tier are not there yet.
 *   seed      a number, or a string hashed (default: the doc's id)
 *   tier      1..5 (default 1): scales the rates (TIER_K) and the patrols
 *   coverage  0..1 per service, {fire|safety, police, health} or one number for all (percentages 0..100 are read
 *             as such; default 1). Poor cover: more fires and robberies, slower turnout and drives, longer scenes.
 *   tzMin     the city's clock, minutes east of UTC (default 0): school, market, match, festival and rush are
 *             local-day events on it, so every player shares one schedule.
 *
 * Kinds (KINDS): emergencies in seeded UTC windows (one window of KINDS[k].win s holds at most one, with
 * probability rate x tier x cover x time of day x window, as traffic.js rawIncident):
 *   fire      a building lot (never an HQ), severity 1..3: that many engines from the nearest fire stations by
 *             road (a station's second engine leaves 90 s after its first), police at severity 3. Never two at
 *             once on one lot. `clear` (the engines winning) comes at 65% of the time on scene.
 *   medical   a home (lot door), a workplace (site) or a street: an ambulance from the nearest hospital or clinic,
 *             then to the nearest hospital (`dest`; a clinic when there is none yet) and home. `who` picks the
 *             resident (npcsim).
 *   crime     the bank, the market, the mall or a shop lot: a getaway car flees along `route` (a seeded run of
 *             1.2-3 km, arterials preferred) to a roadblock at its last node; 2-3 police chase it `lag` s behind.
 *   crash     a junction (3+ roads): police, a tow truck (+ an ambulance to hospital at severity 2+).
 * Rounds: `patrol` (every 2 h UTC window, 2-4 police cars by tier and cover, each on a loop `route` from its
 * station), `delivery` (hourly, 07-19 local, a van round from each post office, market, mall and warehouse).
 * Local days: `match` (stadium, Wed 19:30, Sat 15:00, Sun 17:00: fans 45 min before `kick`, 2 h, out by 40 min
 * after), `market` (Wed, Sat 07-13), `school` (each school, Mon-Fri, bell 08:00 and 15:00, school buses),
 * `festival` (the funpark or the town hall, Fri-Sun 18:00-23:30), `rush` (Mon-Fri 07-09, 17-19).
 *
 * Ev = {id, kind, start, end, x, z, node, site, lot, street, severity, label, units, dispatch, arrive, clear, done,
 *       dest?, route?, routeLen?, block?, kick?, bell?, who?}; times are UTC ms, x/z metres, node a road node id,
 *       site a site id, lot a lot id (or null), route road node ids, block (a robbery's) the roadblock {x, z} at the
 *       route's last node and {fx, fz} the node before it (m).
 * Unit = {kind, station (site id; null for the getaway), home (its road node id), node (where it goes),
 *         dispatch, arrive, leave, back (ms), drop? (an ambulance at the hospital), lag? (a chaser, s)}.
 *   kind: "fire" | "ambulance" | "police" | "tow" | "van" | "schoolbus" | "getaway". dispatch >= ev.start,
 *   arrive >= dispatch, leave >= arrive, back >= leave, ev.end = the last back (or the scene's own end).
 * D.events(fromMs, toMs)  events overlapping [from, to), by start then id
 * D.active(ms)            events with start <= ms < end
 * D.phase(ev, ms)         "reported" (before dispatch) -> "responding" -> "onscene" (from the first arrival) ->
 *                         "clearing" (from `clear`) -> "done" (every unit has left the scene; returning)
 * D.at(ms)                {rush: 0..1, match, market, school, festival: the active Ev or null}
 * D.unitsAt(ms)           [{ev, unit, phase, from: {x, z}, to: {x, z}}], the units out at ms; phase "responding",
 *                         "chase" (getaway and chasers), "onscene", "transport" (to `dest`), "returning",
 *                         "patrol" / "round" (along ev.route from and back to the station)
 * D.rates                 the mean events per hour of each windowed kind with these options
 * D.dist(a, b)            road metres between two node ids (Infinity: not connected)
 * D.sites, D.tier, D.coverage, D.tzMin  the sites at this tier (by id, metres) and the options as read
 * Road distances: Dijkstra from each station's node (and the scene's hospital), cached per instance.
 * Pure core: no THREE, no DOM, no Math.random, so node (tests/test_citysim.py) and the page both load it.
 */
(function(){
"use strict";
var root = typeof window !== "undefined" ? window : self;
var HQV = root.HQV = root.HQV || {};

var MIN = 60000, HOUR = 3600000, DAY = 86400000;
var TIER_K = [0.5, 0.7, 1, 1.25, 1.5];
var SPEED = {fire: 11, ambulance: 13, police: 14, tow: 9, van: 8, schoolbus: 7, getaway: 17};   // m/s, door to door
var TURNOUT = {fire: 75, ambulance: 50, police: 30, tow: 240, van: 0, schoolbus: 0};          // s at full cover
var STATIONS = {fire: ["fire"], ambulance: ["hospital", "clinic"], police: ["police"], tow: ["carpark", "warehouse", "transit", "police"],
                van: ["post", "warehouse", "mall", "market"], schoolbus: ["transit", "school"]};
var COVER = {fire: "fire", ambulance: "health", police: "police"};
var LOOK = 3*HOUR;              // no event lasts longer: how far back a query looks for windows still running
var MAX_P = 0.95;               // a window's chance never goes above this
var GETAWAY = [1200, 3000];     // a getaway run (m)
var BEAT = [900, 2000], ROUND = [1200, 2500], STOP_S = 45;   // patrol beat, van round (m), a van's stop (s)
var SHOPS = {commercial: 1, downtown: 1, oldtown: 1};       // districts whose building lots are shops
var NOT_WORK = {busstop: 1, tramstop: 1, spawn: 1, fountain: 1, skatepark: 1, bikepark: 1, funpark: 1, landmark: 1};
var NAMES = {bank: "the Bank", market: "the Market", mall: "the Mall", stadium: "the Stadium", funpark: "the Park",
             townhall: "the Town Hall", school: "the School", hospital: "the Hospital", clinic: "the Clinic"};

// Every kind: windowed ones have a base rate (events per hour at tier 3, full cover) and a window (s); `day` ones
// follow the local calendar. tod: the 24 h shape of the rate (normalised below to a mean of 1).
var KINDS = {
  fire:     {label: "Fire", rate: 0.8, win: 900, emergency: true,
             tod: [8, 8, 8, 8, 8, 8, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 13, 13, 13, 13, 13, 13, 10]},
  medical:  {label: "Medical call", rate: 2, win: 600, emergency: true,
             tod: [5, 5, 5, 5, 5, 5, 8, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 8, 8]},
  crime:    {label: "Robbery", rate: 0.6, win: 900, emergency: true,
             tod: [15, 15, 15, 15, 15, 6, 6, 6, 6, 6, 8, 8, 8, 8, 8, 8, 8, 8, 13, 13, 13, 13, 13, 13]},
  crash:    {label: "Crash", rate: 1, win: 900, emergency: true,
             tod: [4, 4, 4, 4, 4, 4, 10, 20, 20, 20, 10, 10, 10, 10, 10, 10, 10, 20, 20, 20, 7, 7, 7, 7]},
  patrol:   {label: "Patrol", win: 7200},
  delivery: {label: "Delivery round", win: 3600},
  match:    {label: "Match", day: true},
  market:   {label: "Market day", day: true},
  school:   {label: "School run", day: true},
  festival: {label: "Festival", day: true},
  rush:     {label: "Rush hour", day: true}
};
var ORDER = Object.keys(KINDS);
ORDER.forEach(function(k){
  var t = KINDS[k].tod; if(!t) return;
  var s = 0; t.forEach(function(v){ s += v; });
  KINDS[k].tod = t.map(function(v){ return v*24/s; });
});
var MATCHES = [[3, 19.5], [6, 15], [0, 17]];       // [weekday (0 Sunday), kick-off local hour]
var MARKET_DAYS = {3: 1, 6: 1}, FESTIVAL_DAYS = {5: 1, 6: 1, 0: 1};

/* ---------- small maths ---------- */
function clamp(v, a, b){ return v < a ? a : v > b ? b : v; }
function num(v, d){ return typeof v === "number" && isFinite(v) ? v : d; }
function hash32(str){
  str = String(str == null ? "" : str);
  var h = 0x811c9dc5;
  for(var i = 0; i < str.length; i++){ h ^= str.charCodeAt(i) & 0xff; h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
// a deterministic number in [0, 1) from a seed and two integers (traffic.js h01)
function h01(seed, a, b){
  var h = (Math.imul(seed | 0, 0x27d4eb2d) + Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b); h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35); h ^= h >>> 16;
  return (h >>> 0)/4294967296;
}
function floorDiv(a, b){ return Math.floor(a/b); }
// a weekday, 0 Sunday, of a local day number (1970-01-01, day 0, was a Thursday)
function weekday(day){ return ((day + 4) % 7 + 7) % 7; }
// a local hour's position inside [a, b) as a 0..1..0 bump
function bump(h, a, b){ return h <= a || h >= b ? 0 : Math.sin(Math.PI*(h - a)/(b - a)); }

function coverOf(c){
  var o = {fire: 1, police: 1, health: 1};
  function v(x){ x = num(x, null); if(x == null) return null; if(x > 1) x /= 100; return clamp(x, 0, 1); }
  if(typeof c === "number"){ var a = v(c); o.fire = o.police = o.health = a; }
  else if(c && typeof c === "object"){
    var f = v(c.fire != null ? c.fire : c.safety), p = v(c.police), h = v(c.health != null ? c.health : c.ambulance);
    if(f != null) o.fire = f; if(p != null) o.police = p; if(h != null) o.health = h;
  }
  return o;
}

/* ---------- build ---------- */
function create(doc, o){
  o = o || {};
  doc = doc || {};
  var L = doc.layers || doc, R = L.roads || {nodes: doc.nodes, edges: doc.edges};
  var tier = clamp(num(o.tier, 1) | 0, 1, 5);
  var seed = typeof o.seed === "number" ? o.seed | 0 : hash32(o.seed != null ? o.seed : (doc.id || "city"));
  var tz = clamp(num(o.tzMin, 0), -900, 900)*MIN;
  var cov = coverOf(o.coverage);
  function covK(unitKind){ var k = COVER[unitKind]; return k ? cov[k] : 1; }
  function slowK(c){ return 1 + 0.5*(1 - c); }     // drives and scenes take longer under poor cover

  // the road graph at this tier: node index i, adjacency [v, len m, arterial]
  var nodeIds = [], nodeIx = {}, nx = [], nz = [];
  (R.nodes || []).forEach(function(n){
    if(n == null || nodeIx.hasOwnProperty(n.id)) return;
    nodeIx[n.id] = nodeIds.length; nodeIds.push(n.id); nx.push(num(n.x, 0)/100); nz.push(num(n.z, 0)/100);
  });
  var N = nodeIds.length, adj = [], names = [];
  for(var i = 0; i < N; i++){ adj.push([]); names.push(null); }
  (R.edges || []).forEach(function(e){
    if(!e || (e.min_tier != null && (e.min_tier | 0) > tier)) return;
    var a = nodeIx[e.a], b = nodeIx[e.b];
    if(a == null || b == null || a === b) return;
    var len = 0, P = e.points;
    if(P && P.length >= 2) for(var j = 1; j < P.length; j++) len += Math.hypot(num(P[j][0], 0) - num(P[j-1][0], 0), num(P[j][2], 0) - num(P[j-1][2], 0))/100;
    else len = Math.hypot(nx[a] - nx[b], nz[a] - nz[b]);
    if(!(len > 0.5)) return;
    var cls = String(e["class"] || e.cls || "street"), art = cls === "arterial" || cls === "avenue" || cls === "ring" || cls === "highway";
    adj[a].push({v: b, len: len, art: art}); adj[b].push({v: a, len: len, art: art});
    var nm = typeof e.name === "string" && e.name ? e.name : null;
    [a, b].forEach(function(x){ if(nm && (!names[x] || (art && !names[x].art))) names[x] = {name: nm, art: art}; });
  });
  var live = [];
  for(i = 0; i < N; i++) if(adj[i].length) live.push(i);
  function nearestNode(x, z){
    var best = -1, bd = Infinity;
    for(var k = 0; k < live.length; k++){ var j = live[k], d = (nx[j] - x)*(nx[j] - x) + (nz[j] - z)*(nz[j] - z); if(d < bd){ bd = d; best = j; } }
    return best;
  }
  function street(n){ return n >= 0 && names[n] ? names[n].name : ""; }

  // Dijkstra from a node, cached: {d: Float64Array, p: Int32Array (previous node)}
  var dCache = {};
  function from(src){
    if(dCache[src]) return dCache[src];
    var d = new Float64Array(N), p = new Int32Array(N), done = new Uint8Array(N), heap = [];
    for(var k = 0; k < N; k++){ d[k] = Infinity; p[k] = -1; }
    d[src] = 0; heap.push([0, src]);
    while(heap.length){
      var top = heap[0], last = heap.pop();
      if(heap.length){ heap[0] = last; down(heap, 0); }
      var u = top[1];
      if(done[u]) continue;
      done[u] = 1;
      var A = adj[u];
      for(var m = 0; m < A.length; m++){
        var v = A[m].v, nd = top[0] + A[m].len;
        if(nd < d[v] - 1e-9){ d[v] = nd; p[v] = u; heap.push([nd, v]); up(heap, heap.length - 1); }
      }
    }
    return (dCache[src] = {d: d, p: p});
  }
  function less(a, b){ return a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]); }
  function up(h, k){ while(k > 0){ var q = (k - 1) >> 1; if(!less(h[k], h[q])) break; var t = h[k]; h[k] = h[q]; h[q] = t; k = q; } }
  function down(h, k){
    for(;;){ var l = 2*k + 1, r = l + 1, m = k;
      if(l < h.length && less(h[l], h[m])) m = l;
      if(r < h.length && less(h[r], h[m])) m = r;
      if(m === k) return; var t = h[k]; h[k] = h[m]; h[m] = t; k = m; }
  }
  function dist(a, b){ return a < 0 || b < 0 ? Infinity : from(a).d[b]; }
  // the node path a -> b (a, ..., b), or null
  function path(a, b){
    var F = from(a), out = [b];
    if(!isFinite(F.d[b])) return null;
    for(var v = b; v !== a; ){ v = F.p[v]; if(v < 0) return null; out.push(v); }
    return out.reverse();
  }

  // sites at this tier, each with its road node
  var sites = [], siteById = {}, byKind = {};
  (L.sites || []).forEach(function(s){
    if(!s || s.id == null || (s.tier != null && (s.tier | 0) > tier)) return;
    var S = {id: s.id, kind: String(s.kind || ""), x: num(s.x, 0)/100, z: num(s.z, 0)/100};
    S.node = nearestNode(S.x, S.z);
    if(S.node < 0) return;
    sites.push(S); siteById[S.id] = S;
    (byKind[S.kind] = byKind[S.kind] || []).push(S);
  });
  function sitesOf(kinds){ var out = []; kinds.forEach(function(k){ (byKind[k] || []).forEach(function(s){ out.push(s); }); }); return out; }
  // the stations for a unit kind, nearest to node n by road first (reachable ones only)
  function nearest(unitKind, n, kinds){
    return sitesOf(kinds || STATIONS[unitKind]).map(function(s){ return {s: s, d: dist(s.node, n)}; })
      .filter(function(q){ return isFinite(q.d); })
      .sort(function(a, b){ return a.d - b.d || (String(a.s.id) < String(b.s.id) ? -1 : 1); })
      .map(function(q){ return q.s; });
  }

  // building lots at this tier (their door), lazily given a road node
  var legend = (L.districts && L.districts.legend) || [];
  var lots = [], shops = [];
  (L.lots || []).forEach(function(l){
    if(!l || l.kind !== "building" || (l.min_tier != null && (l.min_tier | 0) > tier)) return;
    var dr = l.door && l.door.length >= 3 ? l.door : null;
    var P = {id: l.id, x: num(dr ? dr[0] : l.x, 0)/100, z: num(dr ? dr[2] : l.z, 0)/100, node: null};
    lots.push(P);
    if(SHOPS[legend[l.district]]) shops.push(P);
  });
  function nodeOf(P){ if(P.node == null) P.node = nearestNode(P.x, P.z); return P.node; }
  var work = sites.filter(function(s){ return !NOT_WORK[s.kind] && !STATIONS.ambulance.concat("fire", "police").some(function(k){ return k === s.kind; }); });
  var junctions = live.filter(function(j){ return adj[j].length >= 3; });
  var robbable = sitesOf(["bank", "market", "mall"]);
  var centre = (byKind.townhall || [])[0] || {x: 0, z: 0, node: nearestNode(0, 0), id: null};

  // the effective rate per hour of each windowed emergency kind
  var tk = TIER_K[tier - 1], rates = {
    fire: KINDS.fire.rate*tk*(1 + 0.8*(1 - cov.fire)),
    medical: KINDS.medical.rate*tk*(1 + 0.3*(1 - cov.health)),
    crime: KINDS.crime.rate*tk*(1 + 0.8*(1 - cov.police)),
    crash: KINDS.crash.rate*tk
  };
  var kix = {}; ORDER.forEach(function(k, j){ kix[k] = j + 1; });
  function rnd(kind, w, j){ return h01(seed + Math.imul(kix[kind], 0x9e3779b1), w, j); }
  function localHour(sec){ var t = sec*1000 + tz; return ((t % DAY) + DAY) % DAY/HOUR; }

  /* ---------- units ---------- */
  // a unit of `kind` from station st to node n, setting off `delay` s after t (s)
  function unit(kind, st, n, t, delay){
    var c = covK(kind), d = dist(st.node, n);
    var disp = t + TURNOUT[kind]*(1 + 1.5*(1 - c)) + (delay || 0);
    return {kind: kind, station: st.id, home: st.node, node: n, dispatch: disp, arrive: disp + d/SPEED[kind]*slowK(c), leave: 0, back: 0};
  }
  // leave node n at t (s) and drive home
  function goHome(u, n, t){ u.leave = t; u.back = t + dist(u.home, n)/SPEED[u.kind]*slowK(covK(u.kind)); return u; }
  function scene(ev, P, n){ ev.x = P.x; ev.z = P.z; ev.node = n; ev.street = street(n); }
  function base(kind, id, t){
    return {id: id, kind: kind, start: t, end: t, x: 0, z: 0, node: null, site: null, lot: null, street: "", severity: 1,
            label: KINDS[kind].label, units: [], dispatch: t, arrive: t, clear: t};
  }
  // the timing summary from the units (s), then every time to integer ms and node indices to ids
  function finish(ev, clear, sceneEnd){
    var U = ev.units, resp = U.filter(function(u){ return u.kind !== "getaway"; });
    if(resp.length){
      ev.dispatch = Math.min.apply(null, resp.map(function(u){ return u.dispatch; }));
      ev.arrive = Math.min.apply(null, resp.map(function(u){ return u.arrive; }));
    }
    var lastLeave = U.length ? Math.max.apply(null, U.map(function(u){ return u.leave; })) : num(sceneEnd, ev.start);
    ev.clear = clamp(clear != null ? clear : lastLeave, ev.arrive, Math.max(ev.arrive, lastLeave, num(sceneEnd, 0)));
    ev.end = Math.max(num(sceneEnd, 0), lastLeave, U.length ? Math.max.apply(null, U.map(function(u){ return u.back; })) : 0, ev.clear);
    ev.done = Math.max(lastLeave, ev.clear);
    ["start", "end", "dispatch", "arrive", "clear", "done", "kick", "bell"].forEach(function(f){ if(ev[f] != null) ev[f] = Math.round(ev[f]*1000); });
    U.forEach(function(u){
      ["dispatch", "arrive", "leave", "back", "drop"].forEach(function(f){ if(u[f] != null) u[f] = Math.round(u[f]*1000); });
      u.home = u.home != null && u.home >= 0 ? nodeIds[u.home] : null; u.node = nodeIds[u.node];
    });
    ev.node = ev.node != null && ev.node >= 0 ? nodeIds[ev.node] : null;
    if(ev.route) ev.route = ev.route.map(function(j){ return nodeIds[j]; });
    return ev;
  }

  // a seeded run along the roads from node a of about `want` m: never straight back the way it came (unless a
  // dead end), a node not yet on the run 4x and an arterial 3x as likely as the others
  function walk(a, want, kind, w, salt){
    var out = [a], seen = {}, len = 0, u = a, prev = -1;
    seen[a] = 1;
    function wt(q){ return (seen[q.v] ? 1 : 4)*(q.art ? 3 : 1); }
    for(var step = 0; len < want && step < 400; step++){
      var opts = adj[u].filter(function(q){ return q.v !== prev; });
      if(!opts.length) opts = adj[u];
      if(!opts.length) break;
      var tot = 0; opts.forEach(function(q){ tot += wt(q); });
      var r = rnd(kind, w, salt + step)*tot, pick = opts[opts.length - 1];
      for(var k = 0; k < opts.length; k++){ r -= wt(opts[k]); if(r < 0){ pick = opts[k]; break; } }
      out.push(pick.v); seen[pick.v] = 1; len += pick.len; prev = u; u = pick.v;
    }
    return {path: out, len: len};
  }
  // a loop from node a: a run out, the shortest way back (from a's cached Dijkstra, the roads run both ways)
  function loop(a, want, kind, w, salt){
    var W = walk(a, want, kind, w, salt), end = W.path[W.path.length - 1], back = end === a ? [a] : path(a, end);
    if(!back) return null;
    return {path: W.path.concat(back.reverse().slice(1)), len: W.len + dist(a, end)};
  }

  /* ---------- emergencies: one window, at most one event ---------- */
  function chance(kind, w){
    var K = KINDS[kind], h = Math.floor(localHour(w*K.win)) % 24;
    return Math.min(MAX_P, rates[kind]*K.tod[h]*K.win/3600);
  }
  function sev(kind, w, c){
    var u = rnd(kind, w, 9);
    return u < 0.08 + 0.1*(1 - c) ? 3 : u < 0.38 + 0.2*(1 - c) ? 2 : 1;
  }
  var raw = {};
  function rawFire(w){
    var key = "f" + w;
    if(raw.hasOwnProperty(key)) return raw[key];
    var ev = null, K = KINDS.fire;
    if(lots.length && rnd("fire", w, 1) < chance("fire", w)){
      var t = w*K.win + rnd("fire", w, 3)*K.win, P = lots[Math.floor(rnd("fire", w, 2)*lots.length)], n = nodeOf(P);
      var st = nearest("fire", n);
      if(st.length){
        ev = base("fire", "fire:" + w, t);
        scene(ev, P, n); ev.lot = P.id; ev.severity = sev("fire", w, cov.fire);
        ev.label = "Fire" + (ev.street ? " on " + ev.street : "");
        var used = {};
        for(var j = 0; j < ev.severity; j++){
          var s = st[Math.min(j, st.length - 1)], again = used[s.id] || 0;
          used[s.id] = again + 1;
          ev.units.push(unit("fire", s, n, t, again*90));
        }
        if(ev.severity >= 3){ var pol = nearest("police", n)[0]; if(pol) ev.units.push(unit("police", pol, n, t, 0)); }
        var arrive = Math.min.apply(null, ev.units.map(function(u){ return u.arrive; }));
        var burn = [480, 900, 1500][ev.severity - 1]*(0.8 + 0.4*rnd("fire", w, 4))*slowK(cov.fire);
        var out = Math.max(arrive + burn, Math.max.apply(null, ev.units.map(function(u){ return u.arrive; })) + 120);
        ev.units.forEach(function(u, k){ goHome(u, n, out + 30*k); });
        finish(ev, arrive + 0.65*(out - arrive));
      }
    }
    return (raw[key] = ev);
  }
  // a fire is called off when an earlier window's fire is still burning on the same lot
  function genFire(w){
    var ev = rawFire(w);
    if(!ev) return [];
    for(var k = 1; k*KINDS.fire.win*1000 < LOOK; k++){ var e = rawFire(w - k); if(e && e.lot === ev.lot && e.end > ev.start) return []; }
    return [ev];
  }
  function genMedical(w){
    var K = KINDS.medical;
    if(rnd("medical", w, 1) >= chance("medical", w)) return [];
    var t = w*K.win + rnd("medical", w, 3)*K.win, u = rnd("medical", w, 2), P, n, ev = base("medical", "medical:" + w, t);
    if(u < 0.55 && lots.length){ P = lots[Math.floor(rnd("medical", w, 4)*lots.length)]; n = nodeOf(P); ev.lot = P.id; }
    else if(u < 0.85 && work.length){ P = work[Math.floor(rnd("medical", w, 4)*work.length)]; n = P.node; ev.site = P.id; }
    else if(live.length){ n = live[Math.floor(rnd("medical", w, 4)*live.length)]; P = {x: nx[n], z: nz[n]}; }
    else return [];
    var st = nearest("ambulance", n)[0], H = nearest("ambulance", n, ["hospital"])[0] || nearest("ambulance", n, ["clinic"])[0];
    if(!st || !H) return [];
    scene(ev, P, n); ev.severity = sev("medical", w, cov.health); ev.dest = H.id;
    ev.who = Math.floor(rnd("medical", w, 5)*2147483647);
    ev.label = "Medical call" + (ev.street ? " on " + ev.street : "");
    var A = unit("ambulance", st, n, t, 0), c = covK("ambulance");
    A.leave = A.arrive + (240 + 180*ev.severity*rnd("medical", w, 6))*slowK(c);
    A.drop = A.leave + dist(H.node, n)/SPEED.ambulance*slowK(c);
    A.back = A.drop + 120 + dist(H.node, st.node)/SPEED.ambulance*slowK(c);
    ev.units.push(A);
    return [finish(ev)];
  }
  function genCrime(w){
    var K = KINDS.crime;
    if(rnd("crime", w, 1) >= chance("crime", w)) return [];
    var t = w*K.win + rnd("crime", w, 3)*K.win, u = rnd("crime", w, 2), P, n, ev = base("crime", "crime:" + w, t);
    if((u < 0.5 || !shops.length) && robbable.length){ P = robbable[Math.floor(rnd("crime", w, 4)*robbable.length)]; n = P.node; ev.site = P.id; }
    else if(shops.length){ P = shops[Math.floor(rnd("crime", w, 4)*shops.length)]; n = nodeOf(P); ev.lot = P.id; }
    else return [];
    var pol = nearest("police", n)[0];
    if(!pol) return [];
    var run = walk(n, GETAWAY[0] + (GETAWAY[1] - GETAWAY[0])*rnd("crime", w, 5), "crime", w, 100);
    if(run.path.length < 2) return [];
    scene(ev, P, n); ev.severity = sev("crime", w, cov.police);
    ev.label = "Robbery at " + (ev.site != null ? NAMES[P.kind] || "a shop" : "a shop" + (ev.street ? " on " + ev.street : ""));
    ev.route = run.path; ev.routeLen = Math.round(run.len);
    var block = run.path[run.path.length - 1], bq = run.path[run.path.length - 2];
    ev.block = {x: nx[block], z: nz[block], fx: nx[bq], fz: nz[bq]};
    var c = covK("police"), arrest = (240 + 180*rnd("crime", w, 6))*slowK(c);
    var g = {kind: "getaway", station: null, home: null, node: block, dispatch: t + 20 + 40*rnd("crime", w, 7)};
    g.arrive = g.dispatch + run.len/SPEED.getaway; g.leave = g.back = g.arrive + arrest;
    ev.units.push(g);
    for(var j = 0; j < 2 + (ev.severity >= 2 ? 1 : 0); j++){
      var lag = Math.min(6, 3 + 1.2*j + rnd("crime", w, 10 + j));
      var p = {kind: "police", station: pol.id, home: pol.node, node: block, lag: Math.round(lag*10)/10,
               dispatch: g.dispatch + lag, arrive: g.arrive + lag};
      ev.units.push(goHome(p, block, g.arrive + arrest));
    }
    return [finish(ev)];
  }
  function genCrash(w){
    var K = KINDS.crash;
    if(!junctions.length || rnd("crash", w, 1) >= chance("crash", w)) return [];
    var t = w*K.win + rnd("crash", w, 3)*K.win, n = junctions[Math.floor(rnd("crash", w, 2)*junctions.length)];
    var pol = nearest("police", n)[0], tow = nearest("tow", n)[0];
    if(!pol || !tow) return [];
    var ev = base("crash", "crash:" + w, t);
    scene(ev, {x: nx[n], z: nz[n]}, n); ev.severity = sev("crash", w, cov.police);
    var other = adj[n].map(function(q){ return street(q.v); }).filter(function(s){ return s && s !== ev.street; })[0];
    ev.label = "Crash" + (ev.street ? " at " + ev.street + (other ? " & " + other : "") : "");
    var P = unit("police", pol, n, t, 0), T = unit("tow", tow, n, t, 0);
    var out = Math.max(T.arrive, P.arrive) + (300 + 300*rnd("crash", w, 4))*slowK(cov.police);
    ev.units.push(goHome(P, n, out + 30), goHome(T, n, out));
    if(ev.severity >= 2){
      var st = nearest("ambulance", n)[0], H = nearest("ambulance", n, ["hospital"])[0] || nearest("ambulance", n, ["clinic"])[0];
      if(st && H){
        var A = unit("ambulance", st, n, t, 0), c = covK("ambulance");
        A.leave = A.arrive + 300*slowK(c); A.drop = A.leave + dist(H.node, n)/SPEED.ambulance*slowK(c);
        A.back = A.drop + 120 + dist(H.node, st.node)/SPEED.ambulance*slowK(c);
        ev.dest = H.id; ev.units.push(A);
      }
    }
    return [finish(ev, Math.max(T.arrive, P.arrive))];
  }
  /* ---------- rounds ---------- */
  function genPatrol(w){
    var K = KINDS.patrol, pol = byKind.police || [], out = [];
    if(!pol.length) return out;
    var n = Math.max(1, Math.round([2, 2, 3, 3, 4][tier - 1]*(0.5 + 0.5*cov.police))), t0 = w*K.win, t1 = t0 + K.win;
    for(var j = 0; j < n; j++){
      var st = pol[j % pol.length], L2 = loop(st.node, BEAT[0] + (BEAT[1] - BEAT[0])*rnd("patrol", w, j), "patrol", w, 1000*(j + 1));
      if(!L2 || L2.path.length < 2) continue;
      var ev = base("patrol", "patrol:" + w + ":" + j, t0);
      scene(ev, st, st.node); ev.site = st.id; ev.route = L2.path; ev.routeLen = Math.round(L2.len);
      ev.label = "Patrol" + (ev.street ? " from " + ev.street : "");
      ev.units.push({kind: "police", station: st.id, home: st.node, node: st.node, dispatch: t0, arrive: t0, leave: t1, back: t1});
      out.push(finish(ev, t1, t1));
    }
    return out;
  }
  function genDelivery(w){
    var K = KINDS.delivery, h = localHour(w*K.win), out = [];
    if(h < 7 || h >= 19) return out;
    sitesOf(STATIONS.van).forEach(function(st, j){
      if(rnd("delivery", w, j) >= 0.5) return;
      var R2 = loop(st.node, ROUND[0] + (ROUND[1] - ROUND[0])*rnd("delivery", w, 50 + j), "delivery", w, 1000*(j + 1));
      if(!R2 || R2.path.length < 2) return;
      var t = w*K.win + rnd("delivery", w, 100 + j)*K.win/2, ev = base("delivery", "delivery:" + w + ":" + j, t);
      scene(ev, st, st.node); ev.site = st.id; ev.route = R2.path; ev.routeLen = Math.round(R2.len);
      ev.label = "Delivery round" + (NAMES[st.kind] ? " from " + NAMES[st.kind] : "");
      var back = t + R2.len/SPEED.van + STOP_S*Math.min(8, R2.path.length - 1);
      ev.units.push({kind: "van", station: st.id, home: st.node, node: st.node, dispatch: t, arrive: t, leave: back, back: back});
      out.push(finish(ev, back, back));
    });
    return out;
  }
  var GEN = {fire: genFire, medical: genMedical, crime: genCrime, crash: genCrash, patrol: genPatrol, delivery: genDelivery};

  /* ---------- local days ---------- */
  // the UTC seconds of a local day's hour
  function utc(day, h){ return (day*DAY + h*HOUR - tz)/1000; }
  function genDay(day){
    var dow = weekday(day), out = [];
    // match days
    var stad = (byKind.stadium || [])[0];
    if(stad) MATCHES.forEach(function(m, j){
      if(m[0] !== dow) return;
      var kick = utc(day, m[1]), ev = base("match", "match:" + day + ":" + j, kick - 2700);
      scene(ev, stad, stad.node); ev.site = stad.id; ev.kick = kick; ev.label = "Match at the Stadium";
      var pol = nearest("police", stad.node)[0];
      if(pol) for(var k = 0; k < (tier >= 3 ? 2 : 1); k++) ev.units.push(goHome(unit("police", pol, stad.node, ev.start, 60*k), stad.node, kick + 2*3600 + 1800));
      out.push(finish(ev, kick + 2*3600, kick + 2*3600 + 2400));
    });
    // market days
    var mk = (byKind.market || [])[0];
    if(mk && MARKET_DAYS[dow]){
      var ev = base("market", "market:" + day, utc(day, 7));
      scene(ev, mk, mk.node); ev.site = mk.id; ev.label = "Market day";
      // (never the market itself: a van from there would have nowhere to drive)
      var vans = nearest("van", mk.node).filter(function(s){ return s.id !== mk.id && s.node !== mk.node; });
      // in turn, 40 min apart: one van at a time at the stalls (the street by a market holds one)
      for(var k = 0; k < 2 && vans.length; k++) ev.units.push(goHome(unit("van", vans[k % vans.length], mk.node, ev.start, 2400*k), mk.node, ev.start + 1800 + 2400*k));
      out.push(finish(ev, utc(day, 12.5), utc(day, 13)));
    }
    // school runs
    if(dow >= 1 && dow <= 5) (byKind.school || []).forEach(function(sc, j){
      [[7.5, 8, 8.5], [14 + 2/3, 15, 15 + 2/3]].forEach(function(T, half){
        var ev = base("school", "school:" + day + ":" + j + ":" + half, utc(day, T[0])), bell = utc(day, T[1]);
        scene(ev, sc, sc.node); ev.site = sc.id; ev.bell = bell; ev.label = half ? "School's out" : "School run";
        // a transit depot or another school, never this one (its buses would have nowhere to drive)
        var depot = nearest("schoolbus", sc.node).filter(function(s){ return s.id !== sc.id && s.node !== sc.node; });
        for(var k = 0; k < (tier >= 3 ? 2 : 1) && depot.length; k++){
          var B = unit("schoolbus", depot[0], sc.node, ev.start, 120*k);
          ev.units.push(goHome(B, sc.node, Math.max(B.arrive + 120, bell + (half ? 300 : -120) + 60*k)));
        }
        out.push(finish(ev, bell, utc(day, T[2])));
      });
    });
    // festival evenings
    var fp = (byKind.funpark || byKind.townhall || [])[0];
    if(fp && FESTIVAL_DAYS[dow]){
      var fe = base("festival", "festival:" + day, utc(day, 18));
      scene(fe, fp, fp.node); fe.site = fp.id; fe.label = "Festival at " + (NAMES[fp.kind] || "the plaza");
      out.push(finish(fe, utc(day, 23), utc(day, 23.5)));
    }
    // rush hours
    if(dow >= 1 && dow <= 5) [[7, 9], [17, 19]].forEach(function(T, j){
      var ev = base("rush", "rush:" + day + ":" + j, utc(day, T[0]));
      scene(ev, centre, centre.node); ev.label = j ? "Evening rush hour" : "Morning rush hour";
      out.push(finish(ev, utc(day, T[1]), utc(day, T[1])));
    });
    return out;
  }

  /* ---------- queries ---------- */
  var cache = {}, cacheN = 0;
  function memo(key, fn){
    if(cache.hasOwnProperty(key)) return cache[key];
    if(++cacheN > 6000){ cache = {}; cacheN = 1; raw = {}; }
    return (cache[key] = fn());
  }
  function byStart(a, b){ return a.start - b.start || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0); }
  function events(fromMs, toMs){
    fromMs = num(fromMs, 0); toMs = num(toMs, fromMs);
    var out = [];
    if(!(toMs > fromMs)) return out;
    function take(list){ list.forEach(function(e){ if(e.start < toMs && e.end > fromMs) out.push(e); }); }
    Object.keys(GEN).forEach(function(k){
      var win = KINDS[k].win*1000, w0 = floorDiv(fromMs - LOOK, win), w1 = floorDiv(toMs, win);
      for(var w = w0; w <= w1; w++) take(memo(k + w, function(){ return GEN[k](w); }));
    });
    var d0 = floorDiv(fromMs + tz - LOOK, DAY), d1 = floorDiv(toMs + tz, DAY);
    for(var d = d0; d <= d1; d++) take(memo("d" + d, function(){ return genDay(d); }));
    return out.sort(byStart);
  }
  function active(ms){ ms = num(ms, 0); return events(ms, ms + 1).filter(function(e){ return e.start <= ms && ms < e.end; }); }
  var PHASES = ["reported", "responding", "onscene", "clearing", "done"];
  function phase(ev, ms){
    if(!ev) return "done";
    ms = num(ms, 0);
    return ms < ev.dispatch ? PHASES[0] : ms < ev.arrive ? PHASES[1] : ms < ev.clear ? PHASES[2] : ms < ev.done ? PHASES[3] : PHASES[4];
  }
  function first(list, kind){ for(var i = 0; i < list.length; i++) if(list[i].kind === kind) return list[i]; return null; }
  function at(ms){
    ms = num(ms, 0);
    var d = floorDiv(ms + tz, DAY), h = (ms + tz - d*DAY)/HOUR, dow = weekday(d), list = [];
    [d - 1, d].forEach(function(x){ memo("d" + x, function(){ return genDay(x); }).forEach(function(e){ if(e.start <= ms && ms < e.end) list.push(e); }); });
    list.sort(byStart);
    var rush = dow >= 1 && dow <= 5 ? Math.max(bump(h, 7, 9), bump(h, 17, 19)) : 0;
    return {rush: Math.round(rush*1000)/1000, match: first(list, "match"), market: first(list, "market"),
            school: first(list, "school"), festival: first(list, "festival")};
  }
  function siteXZ(id){ var s = siteById[id]; return s ? {x: s.x, z: s.z} : null; }
  function nodeXZ(id){ var j = nodeIx[id]; return j != null ? {x: nx[j], z: nz[j]} : null; }
  function unitsAt(ms){
    ms = num(ms, 0);
    var out = [];
    active(ms).forEach(function(ev){
      var here = {x: ev.x, z: ev.z};
      ev.units.forEach(function(u){
        if(ms < u.dispatch || ms >= u.back) return;
        var home = u.station != null ? siteXZ(u.station) : nodeXZ(ev.node), tgt = nodeXZ(u.node) || here, ph, a, b;
        if(ev.kind === "patrol" || ev.kind === "delivery"){ ph = ev.kind === "patrol" ? "patrol" : "round"; a = b = home; }
        else if(ms < u.arrive){
          if(ev.kind === "crime"){ ph = "chase"; a = here; b = tgt; }
          else { ph = "responding"; a = home; b = tgt; }
        }
        else if(ms < u.leave){ ph = "onscene"; a = b = tgt; }
        else if(u.drop != null && ms < u.drop){ ph = "transport"; a = tgt; b = siteXZ(ev.dest) || tgt; }
        else { ph = "returning"; a = u.drop != null ? siteXZ(ev.dest) || tgt : tgt; b = home || tgt; }
        if(u.kind === "getaway" && ph === "returning") return;
        out.push({ev: ev, unit: u, phase: ph, from: a, to: b});
      });
    });
    return out;
  }
  var ratesOut = {}; Object.keys(rates).forEach(function(k){ ratesOut[k] = rates[k]; });
  return {events: events, active: active, phase: phase, at: at, unitsAt: unitsAt, rates: ratesOut,
          dist: function(a, b){ return dist(nodeIx[a] != null ? nodeIx[a] : -1, nodeIx[b] != null ? nodeIx[b] : -1); },
          sites: siteById, tier: tier, coverage: cov, tzMin: tz/MIN};
}

HQV.citySim = {create: create, KINDS: KINDS, STATIONS: STATIONS, SPEED: SPEED, PHASES: ["reported", "responding", "onscene", "clearing", "done"],
               weekday: weekday, hash32: hash32};
})();
