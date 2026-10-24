/* Claude HQ: the phone's transit and info apps (HQ 3.15 transport revamp, plan 3.12 apps 1-3, 12-14, part `phone`).
 *
 * Pushed onto HQV.hqPhoneQueue (games/hqphone.js mounts them):
 *   tickets       journey planner over host.ride.plan (from here or a place; to a place, a station, The Commons or an
 *                 island; leave now or at a time): up to 3 options with their legs, times, changes and below-ground
 *                 notes. Book saves a free ticket (host.ride.tickets.add), Go starts the ride (host.startRide(plan)).
 *                 An island with no option gets "Take the Island Link" (host.travel.link). My tickets. Airport check-in:
 *                 host.air.flights(ms), check in -> a seeded seat (window or aisle) and gate, a boarding pass card with a
 *                 seeded decorative pattern. Everything is free (D4): no fares, no coins.
 *   departures    nearest stops and stations by distance, each expanding to its live board (a real <table>), refreshed
 *                 every 5 s; mode chips (a radiogroup); favourites (stars, localStorage)
 *   map           a schematic SVG of every line (line colours, station ticks, interchange rings, water in blue,
 *                 underground stretches dashed), live vehicle dots (each second; Calm: every 5 s, no tweening), tap a
 *                 station for its board, tap a vehicle to Track it (host.track), chips, +/- zoom, pinch, wheel, arrow
 *                 keys pan, and a text list of every line and station for screen readers
 *   achievements  host.ride.achievements.list() with progress bars, and the Claude Cabs driver score, rating and fares
 *                 (HQV.hqCabs.driverStats) when present
 *   notes         patch notes from /games/patchnotes.json (local), newest first, the newest expanded
 *   settings      transit voice, text-only announcements, 12/24 h clock, default cab class (HQV.hqPhone.prefs); the
 *                 SMS / Nearby / Calls opt-ins through host.social.enabled() / setEnabled() with "what is shared"
 * Pure (node-tested, tests/test_hqphone.py): HQV.hqPhoneApps = {CHIPS, chipMatch, fmtClock, fmtMins, fmtDist, planModel,
 *   boardModel, departuresModel, favs, mapModel, project, vehiclesModel, seatFor, gateFor, passPattern, notesModel,
 *   cmpVersion, achModel, GLYPHS}
 * DOM: createElement / createElementNS / textContent only. Nothing leaves the machine.
 */
(function(){
"use strict";
var W = typeof window !== "undefined" ? window : globalThis;
var HQV = W.HQV = W.HQV || {};

/* ---------------------------------------------------------------- pure ---- */
var CHIPS = [
  {id: "all", name: "All", modes: null},
  {id: "bus", name: "Bus", modes: ["bus"]},
  {id: "tram", name: "Tram", modes: ["tram"]},
  {id: "metro", name: "Metro", modes: ["metro"]},
  {id: "rail", name: "Rail", modes: ["rail", "link"]},
  {id: "ferry", name: "Ferry", modes: ["ferry"]},
  {id: "gondola", name: "Gondola", modes: ["gondola"]}
];
var MODE_NAME = {bus: "Bus", tram: "Tram", metro: "Metro", rail: "City Line", link: "Island Link", ferry: "Water bus",
                 gondola: "Gondola", walk: "Walk", air: "Flight", cab: "Claude Cabs"};
var UNDER_S = 45;
var MAP = 1000, PAD = 40;

function num(v, d){ v = +v; return isFinite(v) ? v : d; }
function pad2(n){ n = n | 0; return (n < 10 ? "0" : "") + n; }
function hash32(s){
  s = String(s == null ? "" : s);
  var h = 0x811c9dc5;
  for(var i = 0; i < s.length; i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
function mulberry32(a){
  return function(){
    a |= 0; a = a + 0x6D2B79F5 | 0;
    var t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function chipOf(id){ for(var i = 0; i < CHIPS.length; i++) if(CHIPS[i].id === id) return CHIPS[i]; return CHIPS[0]; }
function chipMatch(chipId, mode){ var c = chipOf(chipId); return !c.modes || c.modes.indexOf(mode) >= 0; }
function fmtClock(ms, h24){
  var d = new Date(num(ms, 0)), h = d.getHours(), m = d.getMinutes();
  if(h24) return pad2(h) + ":" + pad2(m);
  return ((h % 12) || 12) + ":" + pad2(m) + (h < 12 ? " am" : " pm");
}
function fmtMins(secs){
  var m = Math.max(0, Math.round(num(secs, 0)/60));
  if(m < 60) return m + " min";
  return Math.floor(m/60) + " h " + pad2(m % 60) + " min";
}
function fmtDist(m){
  m = Math.max(0, num(m, 0));
  if(m < 1000) return Math.round(m) + " m";
  return (m < 10000 ? (Math.round(m/100)/10).toFixed(1) : String(Math.round(m/1000))) + " km";
}
function modeName(m){ return MODE_NAME[m] || (m ? String(m).charAt(0).toUpperCase() + String(m).slice(1) : "Transit"); }

// The planner's options as text for the Tickets app. stopInfo(mode, id) -> stop | null (for the below-ground notes).
function planModel(opts, ms, h24, stopInfo){
  ms = num(ms, 0);
  return (opts || []).slice(0, 3).map(function(o, i){
    var legs = (o.legs || []).map(function(l){
      if(l.mode === "walk"){
        var to = l.to && l.to.name ? l.to.name : "your destination";
        return {kind: "walk", badge: "Walk", text: "Walk " + fmtMins(l.secs) + " to " + to, sub: "", under: false};
      }
      var fs = stopInfo ? stopInfo(l.mode, l.from) : null, ts = stopInfo ? stopInfo(l.mode, l.to) : null;
      var notes = [];
      if(fs && fs.under) notes.push("Below ground: allow " + UNDER_S + " s from the street to the platform");
      if(ts && ts.under) notes.push("Below ground at " + (l.toName || ts.name) + ": " + UNDER_S + " s up to the street");
      if(l.world) notes.push("Island Link: the other island loads during the sea crossing");
      return {kind: "ride", mode: l.mode, badge: String(l.short || l.line || modeName(l.mode)),
              text: modeName(l.mode) + " " + String(l.short || l.line || "") + ": " + (l.fromName || l.from) + " to " + (l.toName || l.to),
              sub: fmtClock(l.depart, h24) + " - " + fmtClock(l.reach, h24), under: !!((fs && fs.under) || (ts && ts.under)), notes: notes};
    });
    var rides = legs.filter(function(l){ return l.kind === "ride"; });
    var leave = num(o.leave, num(o.depart, ms)), reach = num(o.reach, ms);
    var mins = fmtMins((reach - ms)/1000);
    var changes = num(o.changes, Math.max(0, rides.length - 1)) | 0;
    var chText = changes === 0 ? "direct" : changes === 1 ? "1 change" : changes + " changes";
    var summary = fmtClock(leave, h24) + " - " + fmtClock(reach, h24) + " · " + mins + " · " + chText;
    return {i: i, leave: leave, reach: reach, mins: mins, changes: changes, changesText: chText, summary: summary,
            badges: rides.map(function(l){ return l.badge; }), legs: legs, world: o.world || null,
            label: "Option " + (i + 1) + ": leave " + fmtClock(leave, h24) + ", arrive " + fmtClock(reach, h24) + ", " + mins + ", " + chText +
                   (rides.length ? ", by " + rides.map(function(l){ return l.badge; }).join(" then ") : "")};
  });
}
function rideOf(){ return HQV.hqRide || null; }
// A stop's live board rows: [{badge, dest, plat, due}]
function boardModel(svc, stopId, ms, h24, n){
  var deps = [];
  try { deps = (svc && typeof svc.departures === "function" ? svc.departures(stopId, ms, n || 4) : []) || []; } catch(e){ deps = []; }
  var R = rideOf();
  if(R && typeof R.boardRows === "function") return R.boardRows(deps, ms, {n: n || 4, h12: !h24});
  return deps.slice(0, n || 4).map(function(d){
    var s = (num(d.at, 0) - ms)/1000, due = d.boarding ? "boarding" : s < 60 ? "due" : s < 1200 ? Math.floor(s/60) + " min" : fmtClock(d.at, h24);
    if(num(d.delay, 0) >= 60 && !d.boarding) due = "delayed +" + Math.round(d.delay/60) + " min";
    return {badge: String(d.short || d.line || ""), dest: String(d.to || ""), due: due, plat: d.plat != null ? String(d.plat) : ""};
  });
}
function svcFor(services, mode){ for(var i = 0; i < (services || []).length; i++) if(services[i] && services[i].mode === mode) return services[i]; return null; }
function favKey(mode, id){ return String(mode) + ":" + String(id); }
// Nearest stops for the Departures app (favourites first), filtered by a chip.
function departuresModel(ride, me, ms, o){
  o = o || {};
  var r = num(o.r, 1500), n = num(o.n, 12) | 0, favs = o.favs || [];
  var near = [];
  try { near = (ride && typeof ride.stopsNear === "function" ? ride.stopsNear(num(me && me.x, 0), num(me && me.z, 0), r) : []) || []; } catch(e){ near = []; }
  var services = []; try { services = (ride && ride.services && ride.services()) || []; } catch(e){}
  var seen = {}, out = [], shorts = {};
  // a line as riders know it (T1, B4), not its id in the timetable (tram:0)
  function lineNames(mode, ids){
    var M = shorts[mode];
    if(!M){ M = shorts[mode] = {}; var sv = svcFor(services, mode); try { ((sv && sv.lines && sv.lines()) || []).forEach(function(l){ if(l && l.id != null) M[String(l.id)] = String(l.short || l.id); }); } catch(e){} }
    return (ids || []).map(function(id){ return M[String(id)] || String(id); });
  }
  near.forEach(function(s){
    if(!s || s.id == null || !chipMatch(o.chip || "all", s.mode)) return;
    var k = favKey(s.mode, s.id); if(seen[k]) return; seen[k] = 1;
    out.push({key: k, id: s.id, name: String(s.name || s.id), mode: s.mode, modeName: modeName(s.mode), dist: num(s.dist, 0),
              distText: fmtDist(s.dist), lines: lineNames(s.mode, s.lines), fav: favs.indexOf(k) >= 0, under: false});
  });
  // favourites further away than r still show (looked up in their service)
  favs.forEach(function(k){
    if(seen[k]) return;
    var i = k.indexOf(":"), mode = k.slice(0, i), id = k.slice(i + 1), svc = svcFor(services, mode);
    if(!svc || !chipMatch(o.chip || "all", mode)) return;
    var st = null; try { (svc.stops() || []).forEach(function(s){ if(String(s.id) === id) st = s; }); } catch(e){}
    if(!st) return;
    seen[k] = 1;
    var dx = num(st.x, 0) - num(me && me.x, 0), dz = num(st.z, 0) - num(me && me.z, 0), d = Math.sqrt(dx*dx + dz*dz);
    out.push({key: k, id: st.id, name: String(st.name || st.id), mode: mode, modeName: modeName(mode), dist: d, distText: fmtDist(d),
              lines: lineNames(mode, st.lines), fav: true, under: !!st.under});
  });
  out.sort(function(a, b){ return (b.fav - a.fav) || (a.dist - b.dist) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0); });
  return out.slice(0, Math.max(n, out.filter(function(x){ return x.fav; }).length));
}
var FAV_KEY = "hq_phone_favs";
var favMem = null;
var favs = {
  list: function(){
    if(favMem) return favMem.slice();
    try { var s = W.localStorage && W.localStorage.getItem(FAV_KEY), a = s ? JSON.parse(s) : []; favMem = Array.isArray(a) ? a.filter(function(x){ return typeof x === "string"; }).slice(0, 50) : []; }
    catch(e){ favMem = []; }
    return favMem.slice();
  },
  toggle: function(k){
    var a = favs.list(), i = a.indexOf(k);
    if(i >= 0) a.splice(i, 1); else a.unshift(String(k));
    favMem = a.slice(0, 50);
    try { if(W.localStorage) W.localStorage.setItem(FAV_KEY, JSON.stringify(favMem)); } catch(e){}
    return i < 0;
  },
  reset: function(){ favMem = []; try { if(W.localStorage) W.localStorage.removeItem(FAV_KEY); } catch(e){} }
};

// Map projection: north up (+z at the top), east (-x) on the right (as the minimap). Points -> a 1000 x 1000 box.
function boundsOf(pts){
  var u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity;
  pts.forEach(function(p){ var u = -p[0], v = -p[1]; if(u < u0) u0 = u; if(u > u1) u1 = u; if(v < v0) v0 = v; if(v > v1) v1 = v; });
  if(!isFinite(u0)){ u0 = -500; u1 = 500; v0 = -500; v1 = 500; }
  var du = Math.max(1, u1 - u0), dv = Math.max(1, v1 - v0), s = (MAP - 2*PAD)/Math.max(du, dv);
  return {u0: u0, v0: v0, du: du, dv: dv, s: s, ou: PAD + ((MAP - 2*PAD) - du*s)/2, ov: PAD + ((MAP - 2*PAD) - dv*s)/2};
}
function project(B, x, z){
  return [Math.round((B.ou + (-num(x, 0) - B.u0)*B.s)*10)/10, Math.round((B.ov + (-num(z, 0) - B.v0)*B.s)*10)/10];
}
function okColor(c){ return typeof c === "string" && /^#[0-9a-fA-F]{6}$/.test(c) ? c : null; }
// The schematic map: {lines, stations, water, bounds}. water = HQV.world.waterOf(W) (or null).
function mapModel(services, o){
  o = o || {};
  var chip = o.chip || "all", pts = [], far = [], stopsBy = {}, lines = [], st = [];
  // the map frames this city: the Island Link's far end (the Commons, kilometres out to sea) runs off the edge
  (services || []).forEach(function(svc){
    if(!svc) return;
    var stops = []; try { stops = svc.stops() || []; } catch(e){}
    stops.forEach(function(s){ if(s && s.id != null){ stopsBy[favKey(svc.mode, s.id)] = s; (svc.mode === "link" ? far : pts).push([num(s.x, 0), num(s.z, 0)]); } });
  });
  if(!pts.length) pts = far;
  var water = [];
  var wb = o.water && Array.isArray(o.water.bodies) ? o.water.bodies : [];
  wb.forEach(function(b){
    var p = b.poly || [], ring = [];
    for(var i = 0; i + 1 < p.length; i += 2) ring.push([num(p[i], 0), num(p[i + 1], 0)]);
    if(ring.length >= 3) water.push({id: String(b.id || ""), kind: b.kind || "lake", ring: ring});
  });
  var B = boundsOf(pts.length ? pts : water.reduce(function(a, w){ return a.concat(w.ring); }, []));
  (services || []).forEach(function(svc){
    if(!svc || !chipMatch(chip, svc.mode)) return;
    var ls = []; try { ls = svc.lines() || []; } catch(e){}
    ls.forEach(function(l){
      if(!l || l.id == null) return;
      var seq = (l.stops || []).map(function(id){ return stopsBy[favKey(svc.mode, id)] || null; }).filter(Boolean);
      if(l.loop && seq.length > 2) seq = seq.concat([seq[0]]);
      var segs = [], cur = null;
      for(var i = 0; i + 1 < seq.length; i++){
        var a = seq[i], b = seq[i + 1], under = !!(a.under && b.under);
        if(!cur || cur.under !== under){ cur = {under: under, pts: [project(B, a.x, a.z)]}; segs.push(cur); }
        cur.pts.push(project(B, b.x, b.z));
      }
      lines.push({id: String(l.id), mode: svc.mode, short: String(l.short || l.id), name: String(l.name || l.short || l.id),
                  color: okColor(l.color), segs: segs, stops: seq.map(function(s){ return favKey(svc.mode, s.id); })});
    });
  });
  // stations: one per stop on a shown line; stops within 60 m of each other form one interchange (2+ lines)
  var on = {};
  lines.forEach(function(l){ l.stops.forEach(function(k){ (on[k] = on[k] || []).push(l.short); }); });
  var keys = Object.keys(on).sort(), used = {};
  keys.forEach(function(k){
    if(used[k]) return;
    var s = stopsBy[k], grp = [k]; used[k] = 1;
    keys.forEach(function(k2){
      if(used[k2]) return;
      var t = stopsBy[k2], dx = num(t.x, 0) - num(s.x, 0), dz = num(t.z, 0) - num(s.z, 0);
      if(dx*dx + dz*dz <= 3600){ grp.push(k2); used[k2] = 1; }
    });
    var ls = [], x = 0, z = 0;
    grp.forEach(function(g){ on[g].forEach(function(n){ if(ls.indexOf(n) < 0) ls.push(n); }); x += num(stopsBy[g].x, 0); z += num(stopsBy[g].z, 0); });
    var p = project(B, x/grp.length, z/grp.length), i0 = k.indexOf(":");
    st.push({key: k, id: stopsBy[k].id, mode: k.slice(0, i0), name: String(stopsBy[k].name || stopsBy[k].id), u: p[0], v: p[1], lines: ls,
             keys: grp, interchange: ls.length >= 2, under: !!stopsBy[k].under,
             unders: grp.reduce(function(o, g){ o[g] = !!stopsBy[g].under; return o; }, {})});
  });
  return {bounds: B, lines: lines, stations: st, water: water.map(function(w){ return {id: w.id, kind: w.kind, pts: w.ring.map(function(q){ return project(B, q[0], q[1]); })}; })};
}
function vehiclesModel(services, ms, B, chip){
  var out = [];
  (services || []).forEach(function(svc){
    if(!svc || !chipMatch(chip || "all", svc.mode) || typeof svc.vehicles !== "function") return;
    var col = {}; try { (svc.lines() || []).forEach(function(l){ col[String(l.id)] = {c: okColor(l.color), s: String(l.short || l.id)}; }); } catch(e){}
    var vs = []; try { vs = svc.vehicles(ms) || []; } catch(e){}
    vs.forEach(function(v){
      if(!v || v.id == null) return;
      var p = project(B, v.x, v.z), L = col[String(v.line)] || {};
      out.push({id: String(v.id), line: String(v.line), short: L.s || String(v.line), mode: svc.mode, u: p[0], v: p[1], color: L.c || null, under: !!v.under});
    });
  });
  out.sort(function(a, b){ return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; });
  return out;
}

// Airport check-in: a seeded seat (rows 1-30, A-F; A/F window, C/D aisle) and gate, the same for the same flight and you.
function seatFor(flightId, userId, pref){
  var h = hash32("seat|" + flightId + "|" + (userId || "me")), row = 1 + (h % 30);
  var letters = pref === "aisle" ? ["C", "D"] : pref === "window" ? ["A", "F"] : ["A", "B", "C", "D", "E", "F"];
  return row + letters[(h >>> 8) % letters.length];
}
// a flight's number as a traveller reads it (CA 123), from its timetable id
function flightCode(flightId){ var h = hash32("flight|" + flightId); return "CA " + (100 + (h % 900)); }
function gateFor(flightId){ var h = hash32("gate|" + flightId); return "ABC".charAt(h % 3) + (1 + ((h >>> 4) % 12)); }
// A decorative pattern for the boarding pass: bars of seeded widths and a few dots (no information in it)
function passPattern(seedKey, n){
  var rnd = mulberry32(hash32("pass|" + seedKey)), bars = [], x = 0;
  n = Math.max(8, Math.min(80, (n | 0) || 40));
  for(var i = 0; i < n && x < 200; i++){
    var w = 1 + Math.floor(rnd()*4), gap = 1 + Math.floor(rnd()*3);
    bars.push({x: x, w: w, h: 18 + Math.floor(rnd()*14)});
    x += w + gap;
  }
  var dots = [];
  for(var j = 0; j < 6; j++) dots.push({x: Math.round(rnd()*200), y: Math.round(rnd()*30), r: 1 + Math.floor(rnd()*3)});
  return {bars: bars, dots: dots, width: 200, height: 32};
}

// Patch notes: [{version, title, body}] newest first (by version; unparseable versions last, as given).
function cmpVersion(a, b){
  var pa = String(a || "").split(".").map(function(x){ return parseInt(x, 10); }), pb = String(b || "").split(".").map(function(x){ return parseInt(x, 10); });
  for(var i = 0; i < Math.max(pa.length, pb.length); i++){
    var x = isFinite(pa[i]) ? pa[i] : -1, y = isFinite(pb[i]) ? pb[i] : -1;
    if(x !== y) return x < y ? -1 : 1;
  }
  return 0;
}
function notesModel(json){
  var a = json && Array.isArray(json.entries) ? json.entries : Array.isArray(json) ? json : [];
  a = a.filter(function(e){ return e && typeof e.version === "string" && typeof e.title === "string"; })
       .map(function(e, i){ return {version: e.version.slice(0, 16), title: e.title.slice(0, 120), body: typeof e.body === "string" ? e.body.slice(0, 6000) : "", i: i}; });
  a.sort(function(x, y){ return cmpVersion(y.version, x.version) || x.i - y.i; });
  return a.map(function(e){ return {version: e.version, title: e.title, body: e.body}; });
}
function achModel(list, stats){
  var items = (list || []).map(function(a){
    var p = Math.max(0, Math.min(1, num(a.progress, a.done ? 1 : 0)));
    return {id: String(a.id), name: String(a.name || a.id), desc: String(a.desc || ""), done: !!a.done, pct: Math.round(p*100)};
  });
  var drv = null;
  if(stats && typeof stats === "object"){
    var r = num(stats.rating, 0);
    drv = {score: Math.max(0, Math.round(num(stats.score, 0))), fares: Math.max(0, num(stats.fares, 0) | 0),
           rating: r > 0 ? (Math.round(r*10)/10).toFixed(1) : "none yet"};
  }
  return {items: items, done: items.filter(function(i){ return i.done; }).length, total: items.length, driver: drv};
}

// original glyphs (24 x 24, stroked)
var GLYPHS = {
  tickets: "M4 7a2 2 0 0 0 2-2h12a2 2 0 0 0 2 2v3a2 2 0 0 0 0 4v3a2 2 0 0 0-2 2H6a2 2 0 0 0-2-2v-3a2 2 0 0 0 0-4zM14 6v12",
  departures: "M5 4h14v12H5zM5 9h14M8 13h3M14 13h2M8 16l-2 4M16 16l2 4",
  map: "M4 6l5-2 6 2 5-2v14l-5 2-6-2-5 2zM9 4v14M15 6v14",
  achievements: "M8 4h8v5a4 4 0 0 1-8 0zM8 6H5a3 3 0 0 0 3 4M16 6h3a3 3 0 0 1-3 4M12 13v4M8 20h8M10 17h4",
  notes: "M6 3h9l4 4v14H6zM15 3v4h4M9 11h7M9 15h7M9 19h4",
  settings: "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"
};
var API = HQV.hqPhoneApps = {CHIPS: CHIPS, chipMatch: chipMatch, fmtClock: fmtClock, fmtMins: fmtMins, fmtDist: fmtDist, modeName: modeName,
  planModel: planModel, boardModel: boardModel, departuresModel: departuresModel, favs: favs, favKey: favKey, mapModel: mapModel,
  project: project, boundsOf: boundsOf, vehiclesModel: vehiclesModel, seatFor: seatFor, gateFor: gateFor, passPattern: passPattern,
  notesModel: notesModel, cmpVersion: cmpVersion, achModel: achModel, GLYPHS: GLYPHS, mulberry32: mulberry32, hash32: hash32};

/* ----------------------------------------------------------------- DOM ---- */
var doc = W.document;
var SVGNS = "http://www.w3.org/2000/svg";
var Q = HQV.hqPhoneQueue = HQV.hqPhoneQueue || [];
var uidN = 0;
function uid(p){ uidN++; return "hpa-" + p + "-" + uidN; }
function mk(tag, cls, parent, text){
  var n = doc.createElement(tag);
  if(cls) n.className = cls;
  if(text != null) n.textContent = text;
  if(parent) parent.appendChild(n);
  return n;
}
function svgEl(tag, attrs, parent){
  var n = doc.createElementNS(SVGNS, tag);
  for(var k in attrs) if(Object.prototype.hasOwnProperty.call(attrs, k)) n.setAttribute(k, String(attrs[k]));
  if(parent) parent.appendChild(n);
  return n;
}
function btn(parent, text, cls, onClick, label){
  var b = mk("button", "hp-btn" + (cls ? " " + cls : ""), parent, text);
  b.type = "button";
  if(label) b.setAttribute("aria-label", label);
  if(onClick) b.addEventListener("click", onClick);
  return b;
}
function clear(n){ while(n && n.firstChild) n.removeChild(n.firstChild); }
function say(host, msg){ try { if(host && host.announce) host.announce(msg); else if(typeof W.announce === "function") W.announce(msg); } catch(e){} }
function toast(host, msg){ try { if(host && host.toast) host.toast(msg); } catch(e){} }
function hcall(host, name, args, def){
  try { if(host && typeof host[name] === "function"){ var v = host[name].apply(host, args || []); return v === undefined ? def : v; } } catch(e){}
  return def;
}
function nowOf(host){ return num(hcall(host, "now", [], Date.now()), Date.now()); }
function rideOfHost(host){ return (host && host.ride) || HQV.hqRide || null; }
function h24(host){ var P = HQV.hqPhone; return P && P.prefs ? !!P.prefs.get("phoneClock24", host) : false; }
function calmNow(host){
  if(hcall(host, "calm", [], false) || hcall(host, "reducedMotion", [], false)) return true;
  var de = doc && doc.documentElement;
  if(de && de.classList && de.classList.contains("hq-calm")) return true;
  try { return !!(W.matchMedia && W.matchMedia("(prefers-reduced-motion: reduce)").matches); } catch(e){ return false; }
}
function services(host){ var R = rideOfHost(host); try { return (R && R.services && R.services()) || []; } catch(e){ return []; } }
function stopLookup(host){
  var by = {};
  services(host).forEach(function(s){ try { (s.stops() || []).forEach(function(st){ by[favKey(s.mode, st.id)] = st; }); } catch(e){} });
  return function(mode, id){ return by[favKey(mode, id)] || null; };
}
function badgeEl(parent, text, mode){
  var b = mk("span", "hp-badge hp-m-" + (mode || "x"), parent, text);
  return b;
}
// a radiogroup of chips: arrows move and select, one chip in the tab order
function chipBar(parent, items, cur, label, onPick){
  var bar = mk("div", "hp-chips", parent);
  bar.setAttribute("role", "radiogroup");
  bar.setAttribute("aria-label", label);
  var els = [];
  items.forEach(function(c){
    var b = mk("button", "hp-chip", bar, c.name);
    b.type = "button";
    b.setAttribute("role", "radio");
    b.setAttribute("data-chip", c.id);
    b.addEventListener("click", function(){ pick(c.id, false); });
    els.push(b);
  });
  function pick(id, focus){
    els.forEach(function(b){
      var on = b.getAttribute("data-chip") === id;
      b.setAttribute("aria-checked", on ? "true" : "false");
      b.tabIndex = on ? 0 : -1;
      if(on && focus && b.focus) b.focus();
    });
    onPick(id);
  }
  bar.addEventListener("keydown", function(e){
    var i = -1;
    els.forEach(function(b, k){ if(b.getAttribute("aria-checked") === "true") i = k; });
    var j = e.key === "ArrowRight" || e.key === "ArrowDown" ? (i + 1) % els.length
          : e.key === "ArrowLeft" || e.key === "ArrowUp" ? (i - 1 + els.length) % els.length
          : e.key === "Home" ? 0 : e.key === "End" ? els.length - 1 : -1;
    if(j < 0) return;
    if(e.preventDefault) e.preventDefault();
    pick(els[j].getAttribute("data-chip"), true);
  });
  els.forEach(function(b){ var on = b.getAttribute("data-chip") === cur; b.setAttribute("aria-checked", on ? "true" : "false"); b.tabIndex = on ? 0 : -1; });
  return bar;
}
// tabs: role tablist, arrows move
function tabBar(parent, tabs, cur, onPick){
  var bar = mk("div", "hp-tabs", parent);
  bar.setAttribute("role", "tablist");
  var els = tabs.map(function(t){
    var b = mk("button", "hp-tab", bar, t.name);
    b.type = "button"; b.setAttribute("role", "tab"); b.setAttribute("data-tab", t.id);
    b.id = uid("tab");
    b.addEventListener("click", function(){ set(t.id, false); });
    return b;
  });
  function set(id, focus){
    els.forEach(function(b){
      var on = b.getAttribute("data-tab") === id;
      b.setAttribute("aria-selected", on ? "true" : "false"); b.tabIndex = on ? 0 : -1;
      if(on && focus && b.focus) b.focus();
    });
    onPick(id);
  }
  bar.addEventListener("keydown", function(e){
    var i = 0; els.forEach(function(b, k){ if(b.getAttribute("aria-selected") === "true") i = k; });
    var j = e.key === "ArrowRight" ? (i + 1) % els.length : e.key === "ArrowLeft" ? (i - 1 + els.length) % els.length : -1;
    if(j < 0) return;
    if(e.preventDefault) e.preventDefault();
    set(els[j].getAttribute("data-tab"), true);
  });
  els.forEach(function(b){ var on = b.getAttribute("data-tab") === cur; b.setAttribute("aria-selected", on ? "true" : "false"); b.tabIndex = on ? 0 : -1; });
  return {bar: bar, set: set, idOf: function(id){ var e = els.filter(function(b){ return b.getAttribute("data-tab") === id; })[0]; return e ? e.id : ""; }};
}
// a live board as a real table
function boardTable(parent, rows, caption, mode){
  var t = mk("table", "hp-board", parent);
  mk("caption", "hp-sr", t, caption);
  var th = mk("thead", "", t), tr = mk("tr", "", th);
  ["Line", "To", "Plat.", "Due"].forEach(function(h, i){ var c = mk("th", "", tr, h); c.setAttribute("scope", "col"); if(i === 2) c.setAttribute("abbr", "Platform"); });
  var tb = mk("tbody", "", t);
  tb.setAttribute("data-mode", mode || "");
  fillBoard(tb, rows);
  return tb;
}
function fillBoard(tb, rows){
  clear(tb);
  if(!rows.length){ var tr = mk("tr", "", tb), td = mk("td", "hp-muted", tr, "No departures soon"); td.setAttribute("colspan", "4"); return; }
  rows.forEach(function(r){
    var tr = mk("tr", "", tb);
    var c1 = mk("td", "", tr); badgeEl(c1, r.badge, tb.getAttribute("data-mode") || "");
    mk("td", "", tr, r.dest);
    mk("td", "", tr, r.plat || "-");
    mk("td", "hp-due", tr, r.due);
  });
}

/* ---------------------------------------------------------------- Tickets ---- */
function placesOf(host){
  var p = hcall(host, "places", [], []) || [];
  return p.filter(function(x){ return x && isFinite(+x.x) && isFinite(+x.z); }).map(function(x){
    return {id: String(x.id), name: String(x.name || x.label || x.id).slice(0, 40), x: +x.x, z: +x.z, kind: x.kind || ""};
  });
}
function islandsOf(host){
  var out = [], me = hcall(host, "me", [], {}) || {}, Wd = HQV.world || {};
  var commons = Wd.COMMONS || "claude-hq@3";
  if(me.world && me.world !== commons) out.push({world: commons, name: "The Commons"});
  (hcall(host, "islands", [], []) || []).forEach(function(i){ if(i && i.world && i.world !== me.world && i.world !== commons) out.push({world: String(i.world), name: String(i.name || "An island").slice(0, 40)}); });
  return out;
}
function renderTickets(el, host, nav, arg){
  var st = {tab: (arg && arg.tab) || "plan", results: null, ms: 0, flight: null, pref: "window"};
  var root = mk("div", "hp-app", el);
  var tabs = tabBar(root, [{id: "plan", name: "Plan"}, {id: "mine", name: "My tickets"}, {id: "air", name: "Check-in"}], st.tab, function(id){ st.tab = id; draw(); });
  var pane = mk("div", "hp-pane", root);
  pane.setAttribute("role", "tabpanel");
  var R = rideOfHost(host);
  // the planner's form (kept across tab switches)
  var form = {from: "here", to: arg && arg.to ? String(arg.to) : "", when: "now", time: ""};
  function draw(){
    clear(pane);
    pane.setAttribute("aria-labelledby", tabs.idOf(st.tab));
    if(st.tab === "plan") drawPlan(); else if(st.tab === "mine") drawMine(); else drawAir();
  }
  function destOptions(){
    var o = [];
    placesOf(host).forEach(function(p){ o.push({v: "p:" + p.id, t: p.name, g: "Places", x: p.x, z: p.z}); });
    var seen = {};
    services(host).forEach(function(s){
      try { (s.stops() || []).forEach(function(stp){
        var nm = String(stp.name || stp.id) + " (" + modeName(s.mode) + ")";
        if(seen[nm]) return; seen[nm] = 1;
        o.push({v: "s:" + s.mode + ":" + stp.id, t: nm, g: "Stops and stations", stop: stp.id, mode: s.mode});
      }); } catch(e){}
    });
    islandsOf(host).forEach(function(i){ o.push({v: "w:" + i.world, t: i.name + " (Island Link)", g: "Islands", world: i.world}); });
    return o;
  }
  function select(parent, label, options, cur, extra){
    var id = uid("sel");
    var l = mk("label", "hp-label", parent, label); l.setAttribute("for", id);
    var s = mk("select", "hp-select", parent); s.id = id;
    (extra || []).forEach(function(x){ var op = mk("option", "", s, x.t); op.value = x.v; });
    var groups = {};
    options.forEach(function(x){
      var g = groups[x.g]; if(!g){ g = groups[x.g] = mk("optgroup", "", s); g.setAttribute("label", x.g); }
      var op = mk("option", "", g, x.t); op.value = x.v;
    });
    if(cur) s.value = cur;
    return s;
  }
  function drawPlan(){
    var dests = destOptions(), byV = {};
    dests.forEach(function(d){ byV[d.v] = d; });
    var f = mk("div", "hp-form", pane);
    f.setAttribute("role", "group"); f.setAttribute("aria-label", "Plan a journey");
    var sFrom = select(f, "From", dests.filter(function(d){ return d.g !== "Islands"; }), form.from, [{v: "here", t: "Where you are"}]);
    var sTo = select(f, "To", dests, form.to, [{v: "", t: "Choose a destination"}]);
    var wg = mk("div", "hp-when", f);
    wg.setAttribute("role", "radiogroup"); wg.setAttribute("aria-label", "When");
    var nm = uid("when");
    function radio(v, text){
      var l = mk("label", "hp-radio", wg), r = mk("input", "", l); r.type = "radio"; r.name = nm; r.value = v;
      r.checked = form.when === v; l.appendChild(doc.createTextNode(" " + text));
      r.addEventListener("change", function(){ if(r.checked){ form.when = v; tIn.disabled = v !== "at"; } });
      return r;
    }
    radio("now", "Leave now"); radio("at", "Leave at");
    var tIn = mk("input", "hp-time", wg); tIn.type = "time"; tIn.value = form.time; tIn.disabled = form.when !== "at";
    tIn.setAttribute("aria-label", "Departure time");
    tIn.addEventListener("change", function(){ form.time = tIn.value; });
    btn(f, "Plan journey", "hp-primary", function(){
      form.from = sFrom.value; form.to = sTo.value; form.time = tIn.value;
      plan(byV);
    });
    var res = mk("div", "hp-results", pane);
    res.setAttribute("aria-live", "polite");
    if(st.results) drawResults(res, byV);
    st.resEl = res;
  }
  function startMs(){
    var now = nowOf(host);
    if(form.when !== "at" || !/^\d{1,2}:\d{2}$/.test(form.time)) return now;
    var p = form.time.split(":"), d = new Date(now);
    d.setHours(+p[0], +p[1], 0, 0);
    var t = d.getTime();
    if(t < now - 60000) t += 86400000;
    return t;
  }
  function plan(byV){
    var to = byV[form.to];
    if(!to){ say(host, "Choose a destination first"); st.results = null; clear(st.resEl); mk("p", "hp-muted", st.resEl, "Choose a destination first."); return; }
    var me = hcall(host, "me", [], {}) || {}, from = {x: num(me.x, 0), z: num(me.z, 0)};
    var fr = byV[form.from];
    if(fr){ if(fr.stop != null) from = {stop: fr.stop, mode: fr.mode}; else from = {x: fr.x, z: fr.z}; }
    var target = to.world ? {world: to.world} : to.stop != null ? {stop: to.stop, mode: to.mode} : {x: to.x, z: to.z};
    var ms = startMs(), opts = [];
    try { opts = (R && R.plan ? R.plan(from, target, ms, {}) : []) || []; } catch(e){ opts = []; }
    st.results = {opts: opts, ms: ms, to: to};
    drawResults(st.resEl, byV);
    say(host, opts.length ? opts.length + (opts.length === 1 ? " journey found" : " journeys found") : "No journey found");
  }
  function drawResults(res, byV){
    clear(res);
    var r = st.results; if(!r) return;
    var H = h24(host), model = planModel(r.opts, r.ms, H, stopLookup(host));
    if(!model.length){
      mk("p", "hp-muted", res, r.to.world ? "No Island Link journey from here right now." : "No journey found. Walk, or call a Claude Cab.");
      if(r.to.world && host.travel && typeof host.travel.link === "function"){
        btn(res, "Take the Island Link to " + r.to.t.replace(/ \(Island Link\)$/, ""), "hp-primary", function(){
          try { host.travel.link(r.to.world); say(host, "Island Link booked. Free."); } catch(e){}
        });
      }
      return;
    }
    var ol = mk("ol", "hp-options", res);
    ol.setAttribute("aria-label", "Journey options");
    model.forEach(function(m, i){
      var li = mk("li", "hp-card hp-option", ol);
      li.setAttribute("aria-label", m.label);
      var top = mk("div", "hp-optop", li);
      m.badges.forEach(function(b, k){ badgeEl(top, b, (r.opts[i].legs || []).filter(function(l){ return l.mode !== "walk"; })[k].mode); });
      mk("span", "hp-optsum", top, m.summary);
      var legs = mk("ul", "hp-legs", li);
      m.legs.forEach(function(l){
        var lli = mk("li", "hp-leg hp-leg-" + l.kind + (l.under ? " hp-under" : ""), legs);
        mk("span", "hp-legtext", lli, l.text);
        if(l.sub) mk("span", "hp-legsub", lli, l.sub);
        (l.notes || []).forEach(function(n){ mk("span", "hp-legnote", lli, n); });
      });
      var bar = mk("div", "hp-bar", li);
      btn(bar, "Book", "", function(){ book(r.opts[i], m); }, "Book option " + (i + 1) + " (free)");
      btn(bar, "Go", "hp-primary", function(){ goRide(r.opts[i], m); }, "Go now with option " + (i + 1));
    });
  }
  function ticketOf(o, m){
    var rides = (o.legs || []).filter(function(l){ return l.mode !== "walk"; }), a = rides[0] || {}, z = rides[rides.length - 1] || {};
    return {kind: "ticket", mode: a.mode || "walk", line: m.badges.join(" > "), short: m.badges.join(" > "),
            from: String(a.from || ""), to: String(z.to || ""), fromName: a.fromName || "", toName: z.toName || "",
            depart: num(o.depart, num(o.leave, 0)), reach: num(o.reach, 0), world: o.world || undefined};
  }
  function book(o, m){
    var T = R && R.tickets;
    if(!T || typeof T.add !== "function"){ say(host, "Tickets are not available"); return; }
    var t = T.add(ticketOf(o, m));
    say(host, "Ticket booked, free: " + (t.fromName || "") + " to " + (t.toName || ""));
    toast(host, "Ticket booked (free)");
  }
  function goRide(o, m){
    if(R && R.tickets && R.tickets.add) R.tickets.add(ticketOf(o, m));
    var S = hcall(host, "startRide", [o], null);
    var first = (o.legs || [])[0];
    say(host, S ? (first && first.mode === "walk" ? "Journey started. " + m.legs[0].text : "Journey started") : "Could not start the journey");
    if(S && nav.close) nav.close();
  }
  function drawMine(){
    var T = R && R.tickets, list = [];
    try { list = (T && T.list && T.list()) || []; } catch(e){ list = []; }
    if(!list.length){ mk("p", "hp-muted", pane, "No tickets yet. Plan a journey and book it: it is free."); return; }
    var ul = mk("ul", "hp-list", pane);
    ul.setAttribute("aria-label", "My tickets");
    var H = h24(host);
    list.forEach(function(t){
      var li = mk("li", "", ul);
      if(t.kind === "pass"){ passCard(li, t, H); }
      else {
        var c = mk("div", "hp-card hp-ticket", li);
        var top = mk("div", "hp-optop", c); badgeEl(top, String(t.short || t.line || modeName(t.mode)), t.mode);
        mk("span", "hp-optsum", top, (t.fromName || t.from || "") + " to " + (t.toName || t.to || ""));
        mk("span", "hp-legsub", c, (t.depart ? fmtClock(t.depart, H) : "") + (t.reach ? " - " + fmtClock(t.reach, H) : "") + " · Free");
      }
      btn(li, "Remove", "hp-ghost", function(){ if(T && T.remove) T.remove(t.id); say(host, "Ticket removed"); draw(); },
          "Remove ticket " + (t.toName || t.to || ""));
    });
  }
  function flightsOf(){
    var A = host.air, list = [];
    try { list = (A && typeof A.flights === "function" ? A.flights(nowOf(host)) : []) || []; } catch(e){ list = []; }
    return list.map(function(f, i){
      var at = num(f.at, num(f.depart, num(f.dep, 0))), to = String(f.toName || f.to || f.name || "Flight").slice(0, 40);
      return {id: String(f.id || (to + "@" + at)), to: to, at: at, raw: f, i: i};
    }).filter(function(f){ return f.at > 0; }).slice(0, 12);
  }
  function drawAir(){
    var fl = flightsOf(), H = h24(host);
    if(!fl.length){ mk("p", "hp-muted", pane, "No flights to check in for right now. Flights leave from the airport."); return; }
    var nm = uid("fl"), g = mk("div", "hp-flights", pane);
    g.setAttribute("role", "radiogroup"); g.setAttribute("aria-label", "Flights");
    fl.forEach(function(f){
      var l = mk("label", "hp-radio hp-flight", g), r = mk("input", "", l); r.type = "radio"; r.name = nm; r.value = f.id;
      r.checked = st.flight ? st.flight === f.id : f.i === fl[0].i;
      l.appendChild(doc.createTextNode(" " + fmtClock(f.at, H) + "  " + f.to));
      r.addEventListener("change", function(){ if(r.checked) st.flight = f.id; });
    });
    if(!st.flight) st.flight = fl[0].id;
    var pg = mk("div", "hp-when", pane), pn = uid("pref");
    pg.setAttribute("role", "radiogroup"); pg.setAttribute("aria-label", "Seat preference");
    ["window", "aisle"].forEach(function(p){
      var l = mk("label", "hp-radio", pg), r = mk("input", "", l); r.type = "radio"; r.name = pn; r.value = p; r.checked = st.pref === p;
      l.appendChild(doc.createTextNode(p === "window" ? " Window seat" : " Aisle seat"));
      r.addEventListener("change", function(){ if(r.checked) st.pref = p; });
    });
    var out = mk("div", "hp-passout", pane);
    out.setAttribute("aria-live", "polite");
    btn(pane, "Check in", "hp-primary", function(){
      var f = fl.filter(function(x){ return x.id === st.flight; })[0] || fl[0];
      var ci = null; try { ci = host.air && host.air.checkIn ? host.air.checkIn(f.raw) : null; } catch(e){ ci = null; }
      var me = hcall(host, "me", [], {}) || {};
      var seat = seatFor(f.id, me.userId, st.pref), gate = ci && typeof ci.gate === "string" && ci.gate ? ci.gate.slice(0, 6) : gateFor(f.id);
      var boards = ci && isFinite(+ci.boardsAt) ? +ci.boardsAt : f.at - 20*60000;
      var t = {kind: "pass", mode: "air", flight: f.id, to: f.to, toName: f.to, depart: f.at, reach: boards, seat: seat, gate: gate, pattern: f.id + "|" + (me.userId || "")};
      if(R && R.tickets && R.tickets.add) t = R.tickets.add(t) || t;
      clear(out);
      passCard(out, t, H);
      say(host, "Checked in. Seat " + seat + ", gate " + gate + ", boarding " + fmtClock(boards, H));
    });
    pane.appendChild(out);
  }
  draw();
  return {dispose: function(){}};
}
function passCard(parent, t, H){
  var c = mk("div", "hp-card hp-pass", parent);
  c.setAttribute("role", "group");
  c.setAttribute("aria-label", "Boarding pass to " + (t.toName || t.to || "") + ", seat " + (t.seat || "") + ", gate " + (t.gate || "") +
                 ", departs " + fmtClock(t.depart, H));
  var hd = mk("div", "hp-pass-head", c);
  mk("b", "", hd, "Boarding pass");
  mk("span", "hp-pass-free", hd, "Free");
  var grid = mk("dl", "hp-pass-grid", c);
  [["To", t.toName || t.to || ""], ["Departs", t.depart ? fmtClock(t.depart, H) : "-"], ["Boards", t.reach ? fmtClock(t.reach, H) : "-"],
   ["Gate", t.gate || "-"], ["Seat", t.seat || "-"], ["Flight", t.flight ? flightCode(t.flight) : "-"]].forEach(function(r){
    var d = mk("div", "", grid); mk("dt", "", d, r[0]); mk("dd", "", d, r[1]);
  });
  var pat = passPattern(t.pattern || t.id || t.flight || "pass");
  var s = svgEl("svg", {viewBox: "0 0 " + pat.width + " " + pat.height, "class": "hp-pass-pat", "aria-hidden": "true", focusable: "false", preserveAspectRatio: "none"}, c);
  pat.bars.forEach(function(b){ svgEl("rect", {x: b.x, y: pat.height - b.h, width: b.w, height: b.h, "class": "hp-pass-bar"}, s); });
  pat.dots.forEach(function(d){ svgEl("circle", {cx: d.x, cy: d.y, r: d.r, "class": "hp-pass-dot"}, s); });
  return c;
}

/* ------------------------------------------------------------- Departures ---- */
function renderDepartures(el, host){
  var st = {chip: "all", open: {}, rows: [], tbodies: {}, last: 0};
  var root = mk("div", "hp-app", el);
  chipBar(root, CHIPS, st.chip, "Modes", function(id){ st.chip = id; draw(); });
  var bar = mk("div", "hp-bar", root);
  btn(bar, "Update", "hp-ghost", function(){ draw(); say(host, "Departures updated"); }, "Update the nearest stops");
  var list = mk("ul", "hp-list hp-stops", root);
  list.setAttribute("aria-label", "Nearest stops and stations");
  var H = h24(host);
  function svc(mode){ return svcFor(services(host), mode); }
  function draw(){
    clear(list); st.tbodies = {};
    var me = hcall(host, "me", [], {}) || {};
    st.rows = departuresModel(rideOfHost(host), me, nowOf(host), {chip: st.chip, favs: favs.list()});
    if(!st.rows.length){ mk("li", "hp-muted", list, "No stops nearby for this mode."); return; }
    st.rows.forEach(function(r){
      var li = mk("li", "hp-stop", list);
      var row = mk("div", "hp-stoprow", li);
      var star = mk("button", "hp-star", row, r.fav ? "★" : "☆");
      star.type = "button";
      star.setAttribute("aria-pressed", r.fav ? "true" : "false");
      star.setAttribute("aria-label", "Favourite " + r.name);
      star.addEventListener("click", function(){
        var on = favs.toggle(r.key);
        star.textContent = on ? "★" : "☆"; star.setAttribute("aria-pressed", on ? "true" : "false");
        say(host, on ? r.name + " added to favourites" : r.name + " removed from favourites");
      });
      var ex = mk("button", "hp-stopbtn", row);
      ex.type = "button";
      var pid = uid("board");
      ex.setAttribute("aria-expanded", st.open[r.key] ? "true" : "false");
      ex.setAttribute("aria-controls", pid);
      mk("span", "hp-stopname", ex, r.name);
      mk("span", "hp-stopsub", ex, r.modeName + " · " + r.distText + (r.lines.length ? " · " + r.lines.join(", ") : ""));
      var box = mk("div", "hp-boardbox", li); box.id = pid; box.hidden = !st.open[r.key];
      function fill(){
        clear(box);
        var rows = boardModel(svc(r.mode), r.id, nowOf(host), H, 4);
        st.tbodies[r.key] = {tb: boardTable(box, rows, "Departures from " + r.name, r.mode), r: r};
      }
      if(st.open[r.key]) fill();
      ex.addEventListener("click", function(){
        var on = !st.open[r.key];
        if(on) st.open[r.key] = 1; else delete st.open[r.key];
        ex.setAttribute("aria-expanded", on ? "true" : "false");
        box.hidden = !on;
        if(on) fill(); else { clear(box); delete st.tbodies[r.key]; }
      });
    });
  }
  draw();
  return {
    tick: function(ms){
      if(ms - st.last < 5000) return;
      st.last = ms;
      Object.keys(st.tbodies).forEach(function(k){ var o = st.tbodies[k]; fillBoard(o.tb, boardModel(svc(o.r.mode), o.r.id, ms, H, 4)); });
    },
    dispose: function(){}
  };
}

/* ------------------------------------------------------------ Transit map ---- */
function renderMap(el, host){
  var st = {chip: "all", k: 1, cx: MAP/2, cy: MAP/2, model: null, vehEls: {}, last: 0, sel: null, ptrs: {}, pinch: null, drag: null};
  var root = mk("div", "hp-app hp-mapapp", el);
  chipBar(root, CHIPS, st.chip, "Modes", function(id){ st.chip = id; build(); });
  var wrap = mk("div", "hp-mapwrap", root);
  var svg = svgEl("svg", {viewBox: "0 0 " + MAP + " " + MAP, "class": "hp-map", role: "group", focusable: "true", tabindex: "0",
                          "aria-label": "Transit map. Arrow keys pan, plus and minus zoom. The list below has every line and station."}, wrap);
  svg.tabIndex = 0;
  var gWater = svgEl("g", {"class": "hp-map-water"}, svg);
  var gLines = svgEl("g", {"class": "hp-map-lines"}, svg);
  var gSt = svgEl("g", {"class": "hp-map-stations"}, svg);
  var gVeh = svgEl("g", {"class": "hp-map-veh"}, svg);
  var zb = mk("div", "hp-zoom", wrap);
  btn(zb, "+", "hp-zbtn", function(){ zoom(1.4); }, "Zoom in");
  btn(zb, "−", "hp-zbtn", function(){ zoom(1/1.4); }, "Zoom out");
  var detail = mk("div", "hp-mapdetail", root);
  detail.setAttribute("aria-live", "polite");
  var alt = mk("details", "hp-maplist", root);
  mk("summary", "", alt, "Lines and stations as a list");
  var altBody = mk("div", "", alt);
  var H = h24(host);

  function waterDoc(){
    var Wd = HQV.world, doc0 = hcall(host, "doc", [], null) || hcall(host, "world", [], null);
    try { return Wd && Wd.waterOf && doc0 ? Wd.waterOf(doc0) : null; } catch(e){ return null; }
  }
  function setView(){
    st.k = Math.max(1, Math.min(8, st.k));
    var half = MAP/2/st.k;
    st.cx = Math.max(half, Math.min(MAP - half, st.cx)); st.cy = Math.max(half, Math.min(MAP - half, st.cy));
    svg.setAttribute("viewBox", (st.cx - half).toFixed(1) + " " + (st.cy - half).toFixed(1) + " " + (2*half).toFixed(1) + " " + (2*half).toFixed(1));
    svg.setAttribute("data-zoom", st.k.toFixed(2));
  }
  function zoom(f){ st.k *= f; setView(); }
  function pan(du, dv){ st.cx += du/st.k; st.cy += dv/st.k; setView(); }
  function build(){
    [gWater, gLines, gSt, gVeh, altBody].forEach(clear);
    st.vehEls = {};
    var svcs = services(host);
    var m = st.model = mapModel(svcs, {chip: st.chip, water: waterDoc()});
    m.water.forEach(function(w){ svgEl("polygon", {points: w.pts.map(function(p){ return p[0] + "," + p[1]; }).join(" "), "class": "hp-water hp-water-" + w.kind}, gWater); });
    m.lines.forEach(function(l){
      l.segs.forEach(function(s){
        var pl = svgEl("polyline", {points: s.pts.map(function(p){ return p[0] + "," + p[1]; }).join(" "), "class": "hp-line hp-m-" + l.mode + (s.under ? " hp-line-under" : ""), "data-line": l.id}, gLines);
        if(l.color) pl.style.stroke = l.color;      // a validated #rrggbb from the service (inline: beats the class)
      });
    });
    // labels that would overlap one already placed are left to the station's title and the list (busiest first)
    var boxes = m.stations.map(function(s){ return [s.u - 14, s.v - 14, s.u + 14, s.v + 14]; }), labelled = {};    // the dots, then each label placed
    m.stations.filter(function(s){ return s.interchange || m.stations.length <= 24; })
      .sort(function(a, b){ return (b.lines.length - a.lines.length) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0); })
      .forEach(function(s){
        var wd = 19*s.name.length, left = s.u + 22 + wd > MAP - 8, x0 = left ? s.u - 18 - wd : s.u + 18, y0 = s.v - 22, x1 = x0 + wd, y1 = y0 + 40;
        var self = [s.u - 14, s.v - 14, s.u + 14, s.v + 14];
        if(boxes.some(function(b){ return !(b[0] === self[0] && b[1] === self[1]) && x0 < b[2] && x1 > b[0] && y0 < b[3] && y1 > b[1]; })) return;
        boxes.push([x0, y0, x1, y1]); labelled[s.key] = left ? "end" : "start";       // near the right edge: to the left of the dot
      });
    m.stations.forEach(function(s){
      var g = svgEl("g", {"class": "hp-stn" + (s.interchange ? " hp-stn-x" : ""), transform: "translate(" + s.u + " " + s.v + ")", "data-stop": s.key}, gSt);
      var title = svgEl("title", {}, g); title.textContent = s.name + " (" + s.lines.join(", ") + ")";
      if(s.interchange){ svgEl("circle", {r: 16, "class": "hp-ring"}, g); svgEl("circle", {r: 7, "class": "hp-ring-in"}, g); }
      else svgEl("circle", {r: 9, "class": "hp-tick"}, g);
      if(labelled[s.key]){
        var t = svgEl("text", {x: labelled[s.key] === "end" ? -22 : 22, y: 11, "class": "hp-stn-label", "text-anchor": labelled[s.key]}, g); t.textContent = s.name;
      }
      g.addEventListener("click", function(){ showBoard(s); });
    });
    // the text alternative
    if(!m.lines.length) mk("p", "hp-muted", altBody, "No lines for this mode here.");
    m.lines.forEach(function(l){
      var sec = mk("section", "hp-altline", altBody);
      var h = mk("h3", "", sec); badgeEl(h, l.short, l.mode); h.appendChild(doc.createTextNode(" " + l.name + " (" + modeName(l.mode) + ")"));
      var ul = mk("ul", "hp-altstops", sec);
      l.stops.forEach(function(k){
        var s = m.stations.filter(function(x){ return x.keys.indexOf(k) >= 0; })[0]; if(!s) return;
        var li = mk("li", "", ul);
        btn(li, s.name + (s.interchange ? " (change for " + s.lines.filter(function(n){ return n !== l.short; }).join(", ") + ")" : "") + (s.unders[k] ? ", below ground" : ""),
            "hp-link", function(){ showBoard(s, k); });
      });
    });
    setView();
    vehicles(nowOf(host));
  }
  // a station's board (key: which of its stops, when it is an interchange: "mode:id"; default its first)
  function showBoard(s, key){
    clear(detail);
    key = key || s.key;
    var i = key.indexOf(":"), mode = key.slice(0, i), id = key.slice(i + 1);
    st.sel = {type: "stop", s: s, id: id};
    mk("h3", "hp-dtitle", detail, s.name);
    var tb = boardTable(detail, boardModel(svcFor(services(host), mode), id, nowOf(host), H, 4), "Departures from " + s.name, mode);
    st.sel.tb = tb; st.sel.mode = mode;
    say(host, s.name + " departures shown below the map");
  }
  function showVehicle(v){
    clear(detail);
    st.sel = {type: "veh", v: v};
    var h = mk("h3", "hp-dtitle", detail); badgeEl(h, v.short, v.mode); h.appendChild(doc.createTextNode(" " + modeName(v.mode)));
    var bar = mk("div", "hp-bar", detail);
    btn(bar, "Track", "hp-primary", function(){
      var ok = hcall(host, "track", [v.id], false);
      say(host, ok === false ? "Can't track while you are riding" : "Tracking " + v.short);
    }, "Track " + modeName(v.mode) + " " + v.short);
  }
  function vehicles(ms){
    var m = st.model; if(!m) return;
    var vs = vehiclesModel(services(host), ms, m.bounds, st.chip), seen = {};
    var calm = calmNow(host);
    svg.setAttribute("data-calm", calm ? "1" : "0");
    vs.forEach(function(v){
      seen[v.id] = 1;
      var e = st.vehEls[v.id];
      if(!e){
        e = svgEl("g", {"class": "hp-veh hp-m-" + v.mode + (v.under ? " hp-veh-under" : ""), "data-veh": v.id}, gVeh);
        var c = svgEl("circle", {r: 12, "class": "hp-vdot"}, e);
        if(v.color) c.style.fill = v.color;
        var t = svgEl("title", {}, e); t.textContent = modeName(v.mode) + " " + v.short;
        e.addEventListener("click", function(){ showVehicle(v); });
        st.vehEls[v.id] = e;
      }
      // the move is a CSS transform: transitions only outside Calm (hqphone.css)
      e.style.transform = "translate(" + v.u + "px," + v.v + "px)";
      e.setAttribute("data-u", v.u); e.setAttribute("data-v", v.v);
    });
    Object.keys(st.vehEls).forEach(function(id){ if(!seen[id]){ var e = st.vehEls[id]; if(e.parentNode) e.parentNode.removeChild(e); delete st.vehEls[id]; } });
  }
  // pointer: drag pans, two pointers pinch; wheel zooms
  function svgScale(){ var r = svg.getBoundingClientRect ? svg.getBoundingClientRect() : null; return r && r.width ? MAP/st.k/r.width : 1; }
  svg.addEventListener("pointerdown", function(e){
    st.ptrs[e.pointerId] = {x: e.clientX, y: e.clientY};
    var ids = Object.keys(st.ptrs);
    if(ids.length === 2){ var a = st.ptrs[ids[0]], b = st.ptrs[ids[1]]; st.pinch = {d: Math.hypot(a.x - b.x, a.y - b.y) || 1, k: st.k}; st.drag = null; }
    else st.drag = {x: e.clientX, y: e.clientY};
  });
  svg.addEventListener("pointermove", function(e){
    if(!st.ptrs[e.pointerId]) return;
    st.ptrs[e.pointerId] = {x: e.clientX, y: e.clientY};
    var ids = Object.keys(st.ptrs);
    if(st.pinch && ids.length === 2){
      var a = st.ptrs[ids[0]], b = st.ptrs[ids[1]], d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      st.k = st.pinch.k*d/st.pinch.d; setView();
    } else if(st.drag){
      var s = svgScale();
      st.cx -= (e.clientX - st.drag.x)*s; st.cy -= (e.clientY - st.drag.y)*s; st.drag = {x: e.clientX, y: e.clientY}; setView();
    }
  });
  function up(e){ delete st.ptrs[e.pointerId]; if(Object.keys(st.ptrs).length < 2) st.pinch = null; if(!Object.keys(st.ptrs).length) st.drag = null; }
  svg.addEventListener("pointerup", up);
  svg.addEventListener("pointercancel", up);
  svg.addEventListener("wheel", function(e){ if(e.preventDefault) e.preventDefault(); zoom(e.deltaY < 0 ? 1.2 : 1/1.2); });
  svg.addEventListener("keydown", function(e){
    var step = 60;
    if(e.key === "ArrowLeft") pan(-step, 0); else if(e.key === "ArrowRight") pan(step, 0);
    else if(e.key === "ArrowUp") pan(0, -step); else if(e.key === "ArrowDown") pan(0, step);
    else if(e.key === "+" || e.key === "=") zoom(1.4); else if(e.key === "-" || e.key === "_") zoom(1/1.4);
    else return;
    if(e.preventDefault) e.preventDefault();
  });
  build();
  return {
    tick: function(ms){
      var every = calmNow(host) ? 5000 : 1000;
      if(ms - st.last < every - 50) return;
      st.last = ms;
      vehicles(ms);
      if(st.sel && st.sel.type === "stop" && st.sel.tb && Math.floor(ms/5000) !== st.sel.bucket){
        st.sel.bucket = Math.floor(ms/5000);
        fillBoard(st.sel.tb, boardModel(svcFor(services(host), st.sel.mode), st.sel.id, ms, H, 4));
      }
    },
    dispose: function(){}
  };
}

/* ----------------------------------------------------------- Achievements ---- */
function renderAchievements(el, host){
  var root = mk("div", "hp-app", el);
  var R = rideOfHost(host), list = [];
  try { list = (R && R.achievements && R.achievements.list()) || []; } catch(e){ list = []; }
  var stats = null;
  try { if(HQV.hqCabs && typeof HQV.hqCabs.driverStats === "function") stats = HQV.hqCabs.driverStats(); } catch(e){ stats = null; }
  var m = achModel(list, stats);
  mk("p", "hp-muted", root, m.done + " of " + m.total + " unlocked. Kept on this computer only.");
  if(m.driver){
    var c = mk("section", "hp-card hp-driver", root);
    var hid = uid("drv"); var h = mk("h3", "", c, "Claude Cabs driver"); h.id = hid; c.setAttribute("aria-labelledby", hid);
    var dl = mk("dl", "hp-pass-grid", c);
    [["Score", String(m.driver.score)], ["Rating", m.driver.rating === "none yet" ? "None yet" : m.driver.rating + " of 5"], ["Fares", String(m.driver.fares)]].forEach(function(r){
      var d = mk("div", "", dl); mk("dt", "", d, r[0]); mk("dd", "", d, r[1]);
    });
  }
  var ul = mk("ul", "hp-list hp-ach", root);
  ul.setAttribute("aria-label", "Achievements");
  if(!m.items.length) mk("li", "hp-muted", ul, "Achievements appear when the City is loaded.");
  m.items.forEach(function(a){
    var li = mk("li", "hp-achrow" + (a.done ? " hp-done" : ""), ul);
    var top = mk("div", "hp-achtop", li);
    mk("span", "hp-achmark", top, a.done ? "✓" : "").setAttribute("aria-hidden", "true");
    var nm = mk("b", "", top, a.name); nm.id = uid("ach");
    mk("span", "hp-legsub", li, a.desc);
    var pb = mk("div", "hp-prog", li);
    pb.setAttribute("role", "progressbar"); pb.setAttribute("aria-valuemin", "0"); pb.setAttribute("aria-valuemax", "100");
    pb.setAttribute("aria-valuenow", String(a.pct)); pb.setAttribute("aria-labelledby", nm.id);
    pb.setAttribute("aria-valuetext", a.done ? "Unlocked" : a.pct + " percent");
    var fill = mk("div", "hp-progfill", pb); fill.style.width = a.pct + "%";
  });
  return {dispose: function(){}};
}

/* ------------------------------------------------------------ Patch notes ---- */
var NOTES_URL = "/games/patchnotes.json";
function renderNotes(el, host){
  var root = mk("div", "hp-app", el), alive = true;
  var status = mk("p", "hp-muted", root, "Loading…");
  status.setAttribute("role", "status");
  function draw(entries){
    if(!alive) return;
    clear(root);
    if(!entries.length){ mk("p", "hp-muted", root, "No patch notes."); return; }
    entries.forEach(function(e, i){
      var d = mk("details", "hp-note", root);
      if(i === 0) d.open = true;
      var s = mk("summary", "", d);
      mk("span", "hp-notever", s, e.version);
      s.appendChild(doc.createTextNode(" " + e.title));
      e.body.split(/\n{2,}/).forEach(function(p){ if(p.trim()) mk("p", "", d, p.trim()); });
    });
  }
  try {
    if(typeof W.fetch !== "function") throw new Error("no fetch");
    W.fetch(NOTES_URL, {cache: "no-cache"}).then(function(r){ return r.json(); })
      .then(function(j){ draw(notesModel(j)); }, function(){ if(alive) status.textContent = "Patch notes could not be loaded."; });
  } catch(e){ status.textContent = "Patch notes could not be loaded."; }
  return {dispose: function(){ alive = false; }};
}

/* --------------------------------------------------------------- Settings ---- */
var SOCIAL_ROWS = [
  {key: "smsSend", text: "Send text messages (SMS)", hint: "Only what you type (at most 160 characters) and who it is for go through the Arena, kept until delivered and at most 7 days. Receiving is always on; block or mute anyone in Messages."},
  {key: "near", text: "Nearby chat", hint: "Lines you type (at most 200 characters) go to players within 40 m of you in the same City, shown over your head for 6 seconds. Nothing is kept."},
  {key: "calls", text: "Calls", hint: "Players in the same room can ring you. The call is audio straight between your two browsers; its setup goes to that one person only."}
];
var LOCAL_ROWS = [
  {key: "transitVoice", text: "Transit voice", hint: "Spoken stop announcements, using only this computer's own voices. Nothing is sent."},
  {key: "transitTextOnly", text: "Announcements as text only", hint: "Stop announcements show as text, with no voice and no chime."},
  {key: "phoneClock24", text: "24-hour clock", hint: "The phone's clock and departure times."}
];
var CAB_NAMES = {bike: "Bike", go: "Go (hatchback)", cab: "Cab (sedan)", xl: "XL (SUV)", lux: "Lux (EV)"};
function renderSettings(el, host){
  var P = HQV.hqPhone && HQV.hqPhone.prefs;
  var root = mk("div", "hp-app hp-settings", el);
  function toggleRow(parent, text, hint, checked, onChange, disabled){
    var row = mk("div", "hp-setrow", parent), id = uid("set");
    var l = mk("label", "hp-toggle", row), cb = mk("input", "", l);
    cb.type = "checkbox"; cb.id = id; cb.checked = !!checked; cb.disabled = !!disabled;
    l.appendChild(doc.createTextNode(" " + text));
    var h = mk("span", "hp-hint", row, hint); h.id = id + "-h"; cb.setAttribute("aria-describedby", h.id);
    cb.addEventListener("change", function(){ onChange(cb.checked, cb); });
    return cb;
  }
  var s1 = mk("section", "hp-setsec", root), h1 = mk("h3", "", s1, "Transit"); h1.id = uid("sh"); s1.setAttribute("aria-labelledby", h1.id);
  LOCAL_ROWS.forEach(function(r){
    toggleRow(s1, r.text, r.hint, P ? P.get(r.key, host) : false, function(on){ if(P) P.set(r.key, on, host); say(host, r.text + (on ? " on" : " off")); });
  });
  var cid = uid("cab"), cl = mk("label", "hp-label", s1, "Default Claude Cabs class"); cl.setAttribute("for", cid);
  var sel = mk("select", "hp-select", s1); sel.id = cid;
  (P ? P.CAB_CLASSES : ["go"]).forEach(function(c){ var o = mk("option", "", sel, CAB_NAMES[c] || c); o.value = c; });
  sel.value = P ? P.get("cabClass", host) : "go";
  sel.addEventListener("change", function(){ if(P) P.set("cabClass", sel.value, host); say(host, "Default class " + (CAB_NAMES[sel.value] || sel.value)); });
  mk("span", "hp-hint", s1, "Rides are free.");

  var s2 = mk("section", "hp-setsec", root), h2 = mk("h3", "", s2, "Messages, Nearby and Calls"); h2.id = uid("sh"); s2.setAttribute("aria-labelledby", h2.id);
  var S = host.social || W.hqPhoneSocial || null, en = {};
  try { en = S && S.enabled ? S.enabled() || {} : {}; } catch(e){ en = {}; }
  if(!S) mk("p", "hp-muted", s2, "Pair with the Arena to use these.");
  SOCIAL_ROWS.forEach(function(r){
    toggleRow(s2, r.text, r.hint, !!en[r.key], function(on, cb){
      if(!S || !S.setEnabled){ cb.checked = !on; return; }
      cb.disabled = true;
      var done = function(ok){ cb.disabled = false; if(!ok){ cb.checked = !on; say(host, "Could not change " + r.text); } else say(host, r.text + (on ? " on" : " off")); };
      try { Promise.resolve(S.setEnabled(r.key, on)).then(function(x){ done(!(x && x.ok === false)); }, function(){ done(false); }); }
      catch(e){ done(false); }
    }, !S);
  });
  mk("p", "hp-hint", root, "Photos, tickets, favourites and achievements stay on this computer.");
  return {dispose: function(){}};
}

// pushed in node too (the shell's tests drain them); render needs a document
(function(){
  Q.push({id: "tickets", name: "Tickets", order: 30, glyph: GLYPHS.tickets, dock: true, needsCity: true, render: renderTickets});
  Q.push({id: "departures", name: "Departures", order: 31, glyph: GLYPHS.departures, dock: false, needsCity: true, render: renderDepartures});
  Q.push({id: "map", name: "Transit map", order: 32, glyph: GLYPHS.map, dock: false, needsCity: true, render: renderMap});
  Q.push({id: "achievements", name: "Achievements", order: 70, glyph: GLYPHS.achievements, dock: false, needsCity: false, render: renderAchievements});
  Q.push({id: "notes", name: "Patch notes", order: 80, glyph: GLYPHS.notes, dock: false, needsCity: false, render: renderNotes});
  Q.push({id: "settings", name: "Settings", order: 90, glyph: GLYPHS.settings, dock: false, needsCity: false, render: renderSettings});
})();
API.render = {tickets: renderTickets, departures: renderDepartures, map: renderMap, achievements: renderAchievements, notes: renderNotes, settings: renderSettings};
})();
