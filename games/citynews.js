/* Claude HQ 3D city: the news ticker and the incident alerts (HQV.cityNews, docs/plans/city-sim.md 2.6).
 *
 * Reads the event director (games/citysim.js, D) and reports what the city is doing:
 *   ticker   one line at the top of the City HUD, rotating through the headlines every ROT_MS (a pure function of
 *            the UTC ms, so every player sees the same line): active incidents first (fire, crime, medical, crash,
 *            by severity), then the day's scheduled events (match, market, festival, school) and rush hour
 *            "🚒 Fire at Elm Street — 3 engines responding", "🚓 Bank robbery: chase on Ring Road",
 *            "🏟️ Match tonight 19:00", "🛍️ Market day"
 *            The headline text is world data (street names): textContent only. A new headline slides in, unless
 *            Calm (html.hq-calm or reduced motion), where it is swapped in place.
 *   announce a visually hidden aria-live="polite" region gets a new incident's headline, at most one per ANN_GAP
 *            (the ticker itself is not live, so its rotation is never read out); the latest waiting one is read
 *            when the gap has passed, if the incident is still on
 *   toast    o.say(text) when an incident starts within NEAR_M of o.me() (once per event, at most one per TOAST_GAP)
 *   alerts   alerts(ms) -> [{x, z, kind}] (m) for the minimap (games/hqminimap.js frame({alerts})): the active
 *            incidents that are not done
 *
 * HQV.cityNews.create(stage, D, {say(text), me() -> {x, z}, tzMin?}) -> {update(ms), alerts(ms), destroy(), el}
 *   D: D.active(ms) -> [Ev], D.events(fromMs, toMs) -> [Ev], D.phase(ev, ms), D.at(ms) (all optional, guarded)
 *   Ev: {id, kind, start, end, x, z (m), street, severity, label, units: [{kind}]}
 *   tzMin: the city's offset from UTC in minutes for "19:00" (default D.tzMin, else 0)
 * Pure helpers, node-tested (tests/test_citynews.py): headline(ev, ms, D, tzMin), headlines(D, ms, tzMin),
 * rotation(list, ms), isIncident(kind), distM(a, b).
 */
(function(){
"use strict";
var HQV = window.HQV = window.HQV || {};

var ROT_MS = 7000;                 // a headline stays this long
var POLL_MS = 500;                 // D.active is read at most this often
var AHEAD_MS = 12*3600e3;          // scheduled events this far ahead make the ticker
var AHEAD_POLL_MS = 60e3;          // and are looked up at most once a minute
var ANN_GAP = 30e3;                // at most one screen-reader announcement per 30 s
var TOAST_GAP = 20e3;              // at most one nearby toast per 20 s
var NEAR_M = 400;                  // an incident this close to you starts with a toast
var FRESH_MS = 90e3;               // ...when it started this recently (no toasts for old fires on load)
var MAX_ALERTS = 16;
var INCIDENT = {fire: 4, crime: 3, medical: 2, crash: 1};   // kind -> rank on the ticker
var SCHED = {match: 1, market: 1, festival: 1, school: 1};

function num(v, d){ v = +v; return isFinite(v) ? v : d; }
function isIncident(kind){ return INCIDENT.hasOwnProperty(kind); }
function distM(a, b){ return Math.hypot(num(a && a.x, 0) - num(b && b.x, 0), num(a && a.z, 0) - num(b && b.z, 0)); }
function pad2(n){ n = n|0; return (n < 10 ? "0" : "") + n; }
// "19:00" in the city's time zone
function clock(ms, tzMin){
  var m = Math.floor((num(ms, 0) + num(tzMin, 0)*60e3)/60e3), day = ((m % 1440) + 1440) % 1440;
  return pad2(Math.floor(day/60)) + ":" + pad2(day % 60);
}
function localDay(ms, tzMin){ return Math.floor((num(ms, 0) + num(tzMin, 0)*60e3)/86400e3); }
function localHour(ms, tzMin){ return (((num(ms, 0) + num(tzMin, 0)*60e3) % 86400e3) + 86400e3) % 86400e3/3600e3; }
function street(ev){
  var s = ev && typeof ev.street === "string" ? ev.street.trim() : "";
  return s || "a city street";
}
function unitCount(ev, kind){
  var n = 0, U = ev && ev.units;
  if(U && U.length) for(var i = 0; i < U.length; i++) if(U[i] && U[i].kind === kind) n++;
  return n;
}
function phaseOf(D, ev, ms){
  if(D && typeof D.phase === "function"){ try { return D.phase(ev, ms); } catch(e){} }
  var s = num(ev && ev.start, 0), e = num(ev && ev.end, s);
  return ms < s ? "upcoming" : ms >= e ? "done" : "responding";
}
// "today 15:00" / "tonight 19:00" / "tomorrow 08:00" for a scheduled event ahead
function when(start, ms, tzMin){
  var d = localDay(start, tzMin) - localDay(ms, tzMin), t = clock(start, tzMin);
  if(d <= 0) return (localHour(start, tzMin) >= 17 ? "tonight " : "today ") + t;
  return (d === 1 ? "tomorrow " : "") + t;
}

// One event's headline at ms ("" when it has none: patrols, deliveries, done incidents).
function headline(ev, ms, D, tzMin){
  if(!ev) return "";
  var k = ev.kind, ph = phaseOf(D, ev, ms), on = ms >= num(ev.start, 0) && ms < num(ev.end, Infinity);
  var lab = typeof ev.label === "string" && ev.label.trim() ? ev.label.trim() : "";
  if(ph === "done") return "";
  switch(k){
    case "fire": {
      var n = Math.max(1, unitCount(ev, "fire")), eng = n + (n === 1 ? " engine" : " engines");
      return "🚒 Fire at " + street(ev) + " — " +
        (ph === "clearing" ? "under control" : ph === "onscene" ? eng + " on scene" : eng + " responding");
    }
    case "crime": {
      var what = lab || "Robbery";
      return "🚓 " + what + ": " + (ph === "clearing" ? "suspects caught on " : "chase on ") + street(ev);
    }
    case "medical":
      return "🚑 Medical emergency on " + street(ev) + " — " +
        (ph === "clearing" ? "patient on the way to hospital" : ph === "onscene" ? "paramedics on scene" : "ambulance responding");
    case "crash":
      return "🚧 Crash at " + street(ev) + " — " + (ph === "clearing" ? "being cleared" : "expect delays");
    case "match":
      return on ? "🏟️ Match on now at the stadium" : "🏟️ Match " + when(ev.start, ms, tzMin);
    case "market":
      return on ? "🛍️ Market day" : "🛍️ Market day " + when(ev.start, ms, tzMin);
    case "festival":
      return on ? "🎡 Festival on at the park" : "🎡 Festival " + when(ev.start, ms, tzMin);
    case "school":
      return on ? "🏫 School run: watch for children" : "";
  }
  return "";
}

// The ticker's lines at ms: [{id, kind, text, ev}], incidents first (rank, then severity, then the newest), then
// scheduled events (soonest first, one per kind), then rush hour.
function headlines(D, ms, tzMin, act, ahead){
  if(!D) return [];
  act = act || safe(D, "active", [ms]);
  ahead = ahead || safe(D, "events", [ms, ms + AHEAD_MS]);
  var inc = [], sch = [], seen = {}, kinds = {}, i, ev, t;
  for(i = 0; i < act.length; i++){
    ev = act[i]; if(!ev || seen[ev.id]) continue;
    t = headline(ev, ms, D, tzMin); if(!t) continue;
    seen[ev.id] = 1;
    if(isIncident(ev.kind)) inc.push({id: ev.id, kind: ev.kind, text: t, ev: ev});
    else if(SCHED[ev.kind] && !kinds[ev.kind]){ kinds[ev.kind] = 1; sch.push({id: ev.id, kind: ev.kind, text: t, ev: ev, at: num(ev.start, 0)}); }
  }
  inc.sort(function(a, b){
    return (INCIDENT[b.kind] - INCIDENT[a.kind]) || (num(b.ev.severity, 1) - num(a.ev.severity, 1)) ||
      (num(b.ev.start, 0) - num(a.ev.start, 0)) || (String(a.id) < String(b.id) ? -1 : 1);
  });
  var up = ahead.filter(function(e){ return e && SCHED[e.kind] && num(e.start, 0) > ms; })
    .sort(function(a, b){ return num(a.start, 0) - num(b.start, 0); });
  for(i = 0; i < up.length; i++){
    ev = up[i]; if(seen[ev.id] || kinds[ev.kind]) continue;
    t = headline(ev, ms, D, tzMin); if(!t) continue;
    kinds[ev.kind] = 1; seen[ev.id] = 1;
    sch.push({id: ev.id, kind: ev.kind, text: t, ev: ev, at: num(ev.start, 0)});
  }
  sch.sort(function(a, b){ return a.at - b.at; });
  var out = inc.concat(sch), st = safe(D, "at", [ms], null);
  if(st && num(st.rush, 0) >= 0.5) out.push({id: "rush", kind: "rush", text: "🚌 Rush hour: buses are full, roads are busy", ev: null});
  return out;
}
function safe(D, fn, args, d){
  if(D && typeof D[fn] === "function"){ try { var r = D[fn].apply(D, args); if(r != null) return r; } catch(e){} }
  return d !== undefined ? d : [];
}
// The line on show at ms: the same for every player.
function rotation(list, ms){
  if(!list || !list.length) return null;
  return list[Math.floor(num(ms, 0)/ROT_MS) % list.length];
}

function calmNow(doc){
  try {
    var de = doc && doc.documentElement;
    if(de && de.classList && de.classList.contains("hq-calm")) return true;
    return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  } catch(e){ return false; }
}

function create(stage, D, o){
  o = o || {};
  var doc = window.document || (typeof document !== "undefined" ? document : null);
  var say = typeof o.say === "function" ? o.say : function(){};
  var me = typeof o.me === "function" ? o.me : function(){ return null; };
  var tzMin = o.tzMin != null ? num(o.tzMin, 0) : num(D && D.tzMin, 0);
  var alive = true, root = null, line = null, live = null;
  var act = [], actAt = -Infinity, ahead = [], aheadAt = -Infinity, list = [], shown = "";
  var known = {}, lastAnn = -Infinity, pendAnn = null, lastToast = -Infinity;

  if(doc && stage){
    root = doc.createElement("div");
    root.className = "citynews";
    root.setAttribute("aria-label", "City news");
    root.hidden = true;
    line = doc.createElement("span");
    line.className = "citynews-line";
    line.setAttribute("aria-hidden", "true");     // the rotation is visual; the live region below speaks
    root.appendChild(line);
    live = doc.createElement("div");
    live.className = "citynews-sr";
    live.setAttribute("aria-live", "polite");
    live.setAttribute("role", "status");
    root.appendChild(live);
    stage.appendChild(root);
  }

  function refresh(ms){
    if(ms - actAt >= POLL_MS || ms < actAt){ actAt = ms; act = safe(D, "active", [ms]); if(!Array.isArray(act)) act = []; }
    if(ms - aheadAt >= AHEAD_POLL_MS || ms < aheadAt){ aheadAt = ms; ahead = safe(D, "events", [ms, ms + AHEAD_MS]); if(!Array.isArray(ahead)) ahead = []; }
  }

  function update(ms){
    if(!alive) return;
    ms = num(ms, 0);
    refresh(ms);
    list = headlines(D, ms, tzMin, act, ahead);
    // new incidents: a toast when near you and fresh, else a (rate-limited) announcement
    var you = null;
    for(var i = 0; i < list.length; i++){
      var h = list[i];
      if(!h.ev || !isIncident(h.kind) || known[h.id]) continue;
      known[h.id] = 1;
      if(you === null){ try { you = me() || false; } catch(e){ you = false; } }
      var fresh = ms - num(h.ev.start, ms) <= FRESH_MS;
      if(you && fresh && ms - lastToast >= TOAST_GAP && distM(you, h.ev) <= NEAR_M){
        lastToast = ms; lastAnn = ms;               // say() toasts and announces it
        if(pendAnn && pendAnn.id === h.id) pendAnn = null;
        say("Nearby: " + h.text);
      } else if(fresh){
        pendAnn = {id: h.id, text: h.text};
      }
    }
    if(pendAnn && ms - lastAnn >= ANN_GAP){
      var still = null;
      for(var j = 0; j < list.length; j++) if(list[j].id === pendAnn.id){ still = list[j]; break; }
      if(still && live){ live.textContent = still.text; lastAnn = ms; }
      pendAnn = null;
    }
    if(!root) return;
    var cur = rotation(list, ms), text = cur ? cur.text : "";
    if(text === shown) return;
    shown = text;
    root.hidden = !text;
    line.textContent = text;
    if(text){
      root.setAttribute("data-kind", cur.kind);
      // slide in (CSS, gated by Calm there too); restart by toggling the class
      var cl = line.classList;
      if(cl){ cl.remove("citynews-roll"); if(!calmNow(doc)){ void line.offsetWidth; cl.add("citynews-roll"); } }
    }
  }

  function alerts(ms){
    if(!alive) return [];
    ms = num(ms, 0);
    refresh(ms);
    var out = [];
    for(var i = 0; i < act.length && out.length < MAX_ALERTS; i++){
      var ev = act[i];
      if(!ev || !isIncident(ev.kind) || !isFinite(+ev.x) || !isFinite(+ev.z)) continue;
      if(phaseOf(D, ev, ms) === "done") continue;
      out.push({x: +ev.x, z: +ev.z, kind: ev.kind});
    }
    return out;
  }

  function destroy(){
    if(!alive) return;
    alive = false;
    if(root && root.parentNode) root.parentNode.removeChild(root);
    root = line = live = null; act = ahead = list = []; known = {};
  }

  return {el: root, update: update, alerts: alerts, destroy: destroy,
          headlines: function(){ return list.slice(); }};
}

HQV.cityNews = {create: create, headline: headline, headlines: headlines, rotation: rotation, isIncident: isIncident,
                distM: distM, clock: clock, ROT_MS: ROT_MS, ANN_GAP: ANN_GAP, TOAST_GAP: TOAST_GAP, NEAR_M: NEAR_M};
})();
