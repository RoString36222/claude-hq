/* Claude HQ: the riding core (HQ 3.15 transport revamp, plan 3.5 / 3.6 / 5.5, part `ride`).
 *
 * HQV.hqRide: one place every scheduled mode (bus, tram, metro, City Line, Island Link, water bus, gondola)
 * plugs into, and the one ride session that carries you on any of them. Everything is free (D4): no fares.
 *   register(service) / unregister(mode) / services()   the Service contract (plan 5.3), one per mode
 *   stopsNear(x, z, r)                  every registered service's stops near a point, by distance then id
 *   plan(from, to, ms, opts)            journey planner: walk (1.4 m/s) + up to 2 legs, a change takes at least
 *                                       60 s, a stop below ground adds 45 s to reach the street; at most 3
 *                                       options, fastest first; to {world} ends on an Island Link leg
 *   session(opts) -> S                  walk -> wait -> board (1.2 s scripted walk on) -> seated | standing ->
 *                                       alight (scripted walk off) -> done | cancelled; carry / camPose / info
 *   seatCam(seatPose, vehiclePose, look, mode, calm, extra)   the seat camera (pure; cabs, heli, gondola use it)
 *   stationName(W, x, z, kind)          the nearest named road, else the nearest site's word; unique per world
 *   dueText(at, ms, boarding, o) / boardRows(deps, ms, o)    departure board text (pure)
 *   boardTexture(THREE, rows, opts)     amber dot-matrix boards, sharing one canvas atlas within 150 m
 *   sfx(audioCtx, name, opts)           synthesised transit sounds (WebAudio only, no files); opts.pos (+ opts.kind) puts one
 *                                       in the world through HQV.engine.spatialOut; loops stop by themselves when not set()
 *   announcer(opts)                     chime (G5-E5-C5, not under Calm) + a LOCAL voice only + announce()
 *   tickets, achievements               local only (localStorage, guarded; an in-memory copy when it throws)
 * Determinism: no random numbers anywhere; names, sways and noise are pure functions of their inputs.
 * Calm (opts.calm()) keeps every text and drops every motion: the seat camera is level and still.
 * Frames: city metres, +y up, yaw 0 faces +z, the right of travel is (-cos yaw, sin yaw) (as traffic.js).
 * Pure top half (no THREE, no DOM): node loads it for tests/test_hqride.py.
 */
(function(){
"use strict";
var root = typeof window !== "undefined" ? window : self;
var HQV = root.HQV = root.HQV || {};

var DEG = Math.PI/180, MIN = 60000, HOUR = 3600000, DAY = 86400000;
var WALK_V = 1.4;              // m/s, the planner's walking pace
var CHANGE_MIN = 60;           // s: a change takes at least this
var UNDER_ADD = 45;            // s: from the street to a platform below ground (and back)
var WALK_R = 800;              // m: stops considered at either end of a journey
var CHANGE_R = 220;            // m: a change may walk to another stop this close
var PER_END = 5;               // nearest stops per service tried at each end
var MAX_OPTS = 3;
var BOARD_S = 1.2, ALIGHT_S = 1.2;
var AT_STOP = 12, LEFT_STOP = 40;   // m: at the stop / walked away from it
var ANN_AFTER = 5000;          // ms after leaving a stop the next one is announced
var EYE_SIT = 1.15, EYE_STAND = 1.62, YAW_MAX = 150*DEG, PITCH_MAX = 50*DEG, FOV = 70;
var BOARD_EVERY = 5000, BOARD_SHARE = 150;

/* ---------- small helpers ---------- */
function hash32(str){
  str = String(str == null ? "" : str);
  if(/[^\x00-\x7f]/.test(str)) str = unescape(encodeURIComponent(str));
  var h = 0x811c9dc5;
  for(var i = 0; i < str.length; i++){ h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
function clamp(v, a, b){ return v < a ? a : (v > b ? b : v); }
function num(v, d){ v = +v; return isFinite(v) ? v : d; }
function fn(f, d){ return typeof f === "function" ? f : function(){ return d; }; }
function d2(a, b){ var dx = num(a.x, 0) - num(b.x, 0), dz = num(a.z, 0) - num(b.z, 0); return Math.sqrt(dx*dx + dz*dz); }
function walkSecs(m){ return Math.max(0, m)/WALK_V; }
function v3(x, y, z){ return {x: x, y: y, z: z}; }
function wrap(a){ return Math.atan2(Math.sin(a), Math.cos(a)); }

/* ---------- the service registry ---------- */
var SVC = [], VER = 0, STOPS = null;
function register(s){
  if(!s || !s.mode) return false;
  unregister(s.mode);
  SVC.push(s); VER++; STOPS = null;
  return true;
}
function unregister(mode){
  var n = SVC.length;
  SVC = SVC.filter(function(s){ return s.mode !== mode; });
  if(SVC.length !== n){ VER++; STOPS = null; }
}
function services(){ return SVC.slice(); }
function call(s, name){ try { return typeof s[name] === "function" ? s[name].apply(s, [].slice.call(arguments, 2)) : null; } catch(e){ return null; } }
// every stop of every service: [{stop, svc}], cached until the registry changes
function allStops(list){
  if(!list && STOPS) return STOPS;
  var out = [];
  (list || SVC).forEach(function(s){ (call(s, "stops") || []).forEach(function(st){ if(st && st.id != null) out.push({stop: st, svc: s}); }); });
  if(!list) STOPS = out;
  return out;
}
function stopsNear(x, z, r){
  var out = [];
  SVC.forEach(function(s){
    (call(s, "stopsNear", x, z, r) || []).forEach(function(st){
      out.push({id: st.id, name: st.name, dist: num(st.dist, 0), mode: st.mode || s.mode, lines: (st.lines || []).slice()});
    });
  });
  out.sort(function(a, b){ return a.dist - b.dist || (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0); });
  return out;
}

/* ---------- the journey planner ---------- */
function access(st){ return st && st.under ? UNDER_ADD : 0; }
function linesAt(svc, stopId){ return (call(svc, "lines") || []).filter(function(l){ return l && (l.stops || []).indexOf(stopId) >= 0; }); }
// the nearest stops of each service within WALK_R of p: [{stop, svc, m}]
function ends(list, p){
  var out = [];
  list.forEach(function(s){
    var near = allStops(list === SVC ? null : list).filter(function(e){ return e.svc === s; })
      .map(function(e){ return {stop: e.stop, svc: s, m: d2(e.stop, p)}; })
      .filter(function(e){ return e.m <= WALK_R; })
      .sort(function(a, b){ return a.m - b.m || (String(a.stop.id) < String(b.stop.id) ? -1 : 1); });
    out = out.concat(near.slice(0, PER_END));
  });
  return out;
}
function findStop(list, id, mode){
  var all = allStops(list === SVC ? null : list), hit = null;
  for(var i = 0; i < all.length; i++) if(all[i].stop.id === id && (!mode || all[i].svc.mode === mode)){ hit = all[i]; break; }
  return hit;
}
function legOf(svc, line, t, fromStop, toStop){
  var L = {mode: t.mode || svc.mode, line: t.line != null ? t.line : line.id, short: t.short || line.short || line.id,
           from: fromStop.id, to: toStop.id, fromName: t.fromName || fromStop.name, toName: t.toName || toStop.name,
           depart: t.depart, reach: t.reach, trip: t};
  if(t.world) L.world = t.world;
  return L;
}
function plan(from, to, ms, opts){
  opts = opts || {}; ms = num(ms, 0); from = from || {}; to = to || {};
  var list = SVC.filter(function(s){ return !opts.modes || opts.modes.indexOf(s.mode) >= 0; });
  if(to.world) list = SVC.filter(function(s){ return !opts.modes || opts.modes.indexOf(s.mode) >= 0 || s.mode === "link"; });
  if(!list.length) return [];
  var mine = list.length === SVC.length ? SVC : list;
  // where you start: a stop, or the stops near a point (walk + access)
  var O = [];
  if(from.stop != null){ var fs = findStop(mine, from.stop, from.mode); if(fs) O.push({stop: fs.stop, svc: fs.svc, m: 0, at: true}); }
  else ends(mine, from).forEach(function(e){ O.push(e); });
  if(!O.length) return [];
  // where you may finish: stopId -> {stop, tail secs}; or a link leg to a world
  var D = null, toStop = null;
  if(to.world){ D = null; }
  else if(to.stop != null){ toStop = findStop(mine, to.stop, to.mode); if(!toStop) return []; D = {}; D[key(toStop.svc, toStop.stop.id)] = {stop: toStop.stop, tail: 0}; }
  else { D = {}; ends(mine, to).forEach(function(e){ D[key(e.svc, e.stop.id)] = {stop: e.stop, tail: access(e.stop) + walkSecs(e.m), m: e.m}; }); }
  function key(svc, id){ return svc.mode + "\u0001" + id; }
  function finals(svc, line, fromId){   // [stop] where this line may end the journey
    var out = [];
    (line.stops || []).forEach(function(sid){
      if(sid === fromId) return;
      if(to.world){ if(svc.mode === "link") out.push(sid); }
      else if(D[key(svc, sid)]) out.push(sid);
    });
    return out;
  }
  function stopObj(svc, id){ var f = findStop([svc], id); return f ? f.stop : {id: id, name: String(id), x: 0, z: 0}; }
  function okTrip(t, ready){ return t && num(t.depart, -Infinity) >= ready - 1 && num(t.reach, -Infinity) >= num(t.depart, 0); }
  function worldOk(t, line){ return !to.world || t.world === to.world || (!t.world && line.world === to.world); }
  function tailOf(svc, sid){ if(to.world) return 0; var e = D[key(svc, sid)]; return e ? e.tail : 0; }
  var found = [], transfers = {};
  function transfersAt(st){   // stops you may change to from st (st itself first)
    var k = String(st.id) + "@" + st.x + "," + st.z;
    if(transfers[k]) return transfers[k];
    var out = [];
    allStops(mine === SVC ? null : mine).forEach(function(e){
      var m = d2(e.stop, st);
      if(m <= CHANGE_R) out.push({stop: e.stop, svc: e.svc, m: m});
    });
    return (transfers[k] = out);
  }
  O.forEach(function(o){
    var lead = o.at ? 0 : walkSecs(o.m), ready1 = ms + (lead + (o.at ? 0 : access(o.stop)))*1000;
    linesAt(o.svc, o.stop.id).forEach(function(line){
      // one leg
      finals(o.svc, line, o.stop.id).forEach(function(sid){
        var t = call(o.svc, "trip", line.id, o.stop.id, sid, ready1);
        if(!okTrip(t, ready1) || !worldOk(t, line)) return;
        var ds = stopObj(o.svc, sid);
        found.push({o: o, legs: [legOf(o.svc, line, t, o.stop, ds)], reach: t.reach + tailOf(o.svc, sid)*1000, end: ds, endSvc: o.svc});
      });
      if(opts.maxLegs === 1) return;
      // two legs: ride to m, change (walk to m2), ride on another line
      (line.stops || []).forEach(function(mid){
        if(mid === o.stop.id) return;
        var t1 = call(o.svc, "trip", line.id, o.stop.id, mid, ready1);
        if(!okTrip(t1, ready1)) return;
        var ms1 = stopObj(o.svc, mid);
        transfersAt(ms1).forEach(function(x){
          var both = ms1.under && x.stop.under && x.stop !== ms1;
          var ch = Math.max(CHANGE_MIN, walkSecs(x.m)) + (both || x.stop === ms1 ? 0 : access(ms1) + access(x.stop));
          var ready2 = t1.reach + ch*1000;
          linesAt(x.svc, x.stop.id).forEach(function(line2){
            if(line2.id === line.id && x.svc === o.svc) return;
            finals(x.svc, line2, x.stop.id).forEach(function(sid){
              var t2 = call(x.svc, "trip", line2.id, x.stop.id, sid, ready2);
              if(!okTrip(t2, ready2) || !worldOk(t2, line2)) return;
              var ds = stopObj(x.svc, sid), legs = [legOf(o.svc, line, t1, o.stop, ms1)];
              if(x.stop !== ms1) legs.push({mode: "walk", from: {x: ms1.x, z: ms1.z, name: ms1.name, stop: ms1.id}, to: {x: x.stop.x, z: x.stop.z, name: x.stop.name, stop: x.stop.id}, secs: Math.round(walkSecs(x.m))});
              legs.push(legOf(x.svc, line2, t2, x.stop, ds));
              found.push({o: o, legs: legs, reach: t2.reach + tailOf(x.svc, sid)*1000, end: ds, endSvc: x.svc});
            });
          });
        });
      });
    });
  });
  // assemble: walk legs at the ends, then fastest first, one option per line sequence
  var out = found.map(function(f){
    var legs = [], o = f.o, first = f.legs[0], last = f.legs[f.legs.length - 1];
    if(!o.at && o.m > 0.5) legs.push({mode: "walk", from: {x: num(from.x, 0), z: num(from.z, 0)}, to: {x: o.stop.x, z: o.stop.z, name: o.stop.name, stop: o.stop.id}, secs: Math.round(walkSecs(o.m))});
    legs = legs.concat(f.legs);
    if(!to.world && to.stop == null){
      var e = D[key(f.endSvc, f.end.id)];
      if(e && e.m > 0.5) legs.push({mode: "walk", from: {x: f.end.x, z: f.end.z, name: f.end.name, stop: f.end.id}, to: {x: num(to.x, 0), z: num(to.z, 0)}, secs: Math.round(walkSecs(e.m))});
    }
    var rides = f.legs.filter(function(l){ return l.mode !== "walk"; });
    var leave = num(first.trip.arrive, first.depart) - ((o.at ? 0 : walkSecs(o.m) + access(o.stop))*1000);
    var opt = {legs: legs, depart: first.depart, leave: Math.round(Math.min(leave, first.depart)), reach: Math.round(f.reach), changes: rides.length - 1,
               secs: Math.round((f.reach - ms)/1000), sig: rides.map(function(l){ return l.mode + ":" + l.line; }).join(">")};
    if(last.world) opt.world = last.world;
    return opt;
  });
  out.sort(function(a, b){ return a.reach - b.reach || a.changes - b.changes || b.leave - a.leave || (a.sig < b.sig ? -1 : a.sig > b.sig ? 1 : 0); });
  var seen = {}, res = [];
  for(var i = 0; i < out.length && res.length < (opts.max || MAX_OPTS); i++){
    if(seen[out[i].sig]) continue;
    seen[out[i].sig] = 1; res.push(out[i]);
  }
  return res;
}

/* ---------- the seat camera (pure) ---------- */
// seatPose {x, y (seat surface or floor), z, yaw}; vehiclePose {x, y, z, yaw, pitch, speed, accel?};
// look {yaw, pitch} (rad, the drag/arrow offset); mode "seat"|"window"|"chase"; calm: level and still.
// extra {standing, t (ms), reduced, back, up}
function seatCam(seatPose, vehiclePose, look, mode, calm, extra){
  seatPose = seatPose || {}; extra = extra || {}; look = look || {};
  var vp = vehiclePose || seatPose, still = !!calm || !!extra.reduced;
  var sx = num(seatPose.x, 0), sy = num(seatPose.y, 0), sz = num(seatPose.z, 0);
  var vyaw = num(vp.yaw, num(seatPose.yaw, 0)), ly = clamp(num(look.yaw, 0), -YAW_MAX, YAW_MAX), lp = clamp(num(look.pitch, 0), -PITCH_MAX, PITCH_MAX);
  var fx = Math.sin(vyaw), fz = Math.cos(vyaw), rx = -Math.cos(vyaw), rz = Math.sin(vyaw);
  var speed = Math.abs(num(vp.speed, 0)), t = num(extra.t, 0)/1000, pos, yaw, pitch;
  if(mode === "chase"){
    var back = num(extra.back, 16), up = num(extra.up, 7), cyaw = vyaw + ly;
    var cx = num(vp.x, sx), cy = num(vp.y, sy), cz = num(vp.z, sz);
    pos = v3(cx - Math.sin(cyaw)*back, cy + up, cz - Math.cos(cyaw)*back);
    var lk = v3(cx + fx*4, cy + 1.6, cz + fz*4);
    return {camera: true, pos: pos, look: lk, up: v3(0, 1, 0), fov: FOV, mode: "chase"};
  }
  var eye = extra.standing ? EYE_STAND : EYE_SIT;
  if(mode === "window"){
    var lat = (sx - num(vp.x, sx))*rx + (sz - num(vp.z, sz))*rz, side = lat >= 0 ? 1 : -1;
    pos = v3(sx + rx*side*0.3, sy + eye, sz + rz*side*0.3);
    yaw = Math.atan2(rx*side, rz*side) + clamp(ly, -60*DEG, 60*DEG);
    pitch = -4*DEG + clamp(lp, -30*DEG, 30*DEG);
  } else {
    pos = v3(sx, sy + eye, sz);
    yaw = num(seatPose.yaw, vyaw) + ly;
    pitch = lp + num(vp.pitch, 0);
  }
  var upv = v3(0, 1, 0);
  if(!still){
    // a tiny sway with speed, and a lurch forward while braking (pure functions of time: no randomness)
    var k = Math.min(1, speed/20);
    var sw = 0.012*k*Math.sin(t*1.7), bob = 0.006*k*Math.sin(t*2.3 + 1);
    pos.x += rx*sw; pos.z += rz*sw; pos.y += bob;
    var acc = num(vp.accel, 0);
    if(acc < -0.3){ var l = clamp(-acc*0.025, 0, 0.06); pos.x += fx*l; pos.z += fz*l; pitch -= clamp(-acc*0.01, 0, 0.03); }
    var roll = 0.006*k*Math.sin(t*1.1);
    upv = v3(rx*Math.sin(roll), Math.cos(roll), rz*Math.sin(roll));
  }
  var cp = Math.cos(pitch);
  return {camera: true, pos: pos, look: v3(pos.x + Math.sin(yaw)*cp*10, pos.y + Math.sin(pitch)*10, pos.z + Math.cos(yaw)*cp*10),
          up: upv, fov: FOV, mode: mode === "window" ? "window" : "seat"};
}

/* ---------- the ride session ---------- */
var CAM_MODES = ["seat", "window", "chase"];
function seatSide(trip, i, ms){   // the seat's lateral offset (m, + = the right of travel: the pavement side)
  var p = call(trip, "pose", ms), s = call(trip, "seat", i, ms);
  if(!p || !s) return 0;
  return (num(s.x, 0) - num(p.x, 0))*(-Math.cos(num(p.yaw, 0))) + (num(s.z, 0) - num(p.z, 0))*Math.sin(num(p.yaw, 0));
}
// first free window seat on the pavement side, else any free seat, else a standing spot (hands on the rail)
function chooseSeat(trip, occ, ms){
  var N = Math.max(0, num(trip.seats, 0) | 0), M = Math.max(0, num(trip.standing, 0) | 0);
  occ = occ || {seats: [], standing: []};
  var taken = {}, st = {}, i;
  (occ.seats || []).forEach(function(k){ taken[k] = 1; });
  (occ.standing || []).forEach(function(k){ st[k] = 1; });
  var meta = Array.isArray(trip.seatMeta) ? trip.seatMeta : null, lat = [], maxR = 0;
  if(!meta){ for(i = 0; i < N; i++){ lat[i] = seatSide(trip, i, ms); if(lat[i] > maxR) maxR = lat[i]; } }
  for(i = 0; i < N; i++){
    if(taken[i]) continue;
    var win = meta ? !!(meta[i] && meta[i].window) && (meta[i].side == null ? true : meta[i].side === "right" || meta[i].side > 0)
                   : maxR > 0.2 && lat[i] >= maxR - 0.25;
    if(win) return {seat: i, standing: false, window: true};
  }
  for(i = 0; i < N; i++) if(!taken[i]) return {seat: i, standing: false, window: false};
  for(i = 0; i < M; i++) if(!st[i]) return {seat: N + i, spot: i, standing: true};
  return {seat: N + Math.max(0, M - 1), spot: Math.max(0, M - 1), standing: true};
}
function lerpP(a, b, f){ return {x: a.x + (b.x - a.x)*f, y: num(a.y, 0) + (num(b.y, 0) - num(a.y, 0))*f, z: a.z + (b.z - a.z)*f}; }

function session(o){
  o = o || {};
  var trip = o.trip; if(!trip) return null;
  var calm = fn(o.calm, false), announce = fn(o.announce, null), toast = fn(o.toast, null), sfxf = fn(o.sfx, null), meF = fn(o.me, null);
  var say = o.announcer && typeof o.announcer.say === "function" ? function(t){ o.announcer.say(t, {chime: true}); } : announce;
  var S = {phase: "walk"}, t0 = 0, pick = null, lastUnder = null, handed = false, annK = -1, closing = false, arrivedSaid = false;
  var boardFrom = null, alightPath = null, endIdx, endAt, stopReq = false, ended = false, focused = false, lastMs = null;
  var stops = Array.isArray(trip.stops) ? trip.stops : [];
  var fromIdx = 0;
  for(var i = 0; i < stops.length; i++) if(stops[i] && stops[i].id === trip.from){ fromIdx = i; break; }
  endIdx = stops.length - 1;
  for(i = stops.length - 1; i > fromIdx; i--) if(stops[i] && stops[i].id === trip.to){ endIdx = i; break; }
  endAt = num(trip.reach, 0);
  var at = o.at || o.stop || call(trip, "door", num(trip.arrive, 0)) || call(trip, "pose", num(trip.arrive, 0)) || {x: 0, z: 0};
  var label = (trip.short || trip.line || "") + "";
  var modeWord = {bus: "Bus", tram: "Tram", metro: "Train", rail: "Train", link: "Island Link", ferry: "Water bus", gondola: "Cabin"}[trip.mode] || "Service";
  function sfx(n, so){ try { sfxf(n, so); } catch(e){} }           // so.pos + so.kind: where it is (the validator, the stop bell: centred)
  // your vehicle's door cues are your own things (engine.js kind "own": full level while the camera rides with you,
  // fading only from a detached one), heard from your seat, before you have one from the door you board at. Not from
  // the vehicle's pose: that is its middle, 20-30 m from a seat in an end car of a 72 m train
  function mine(ms){ return {pos: seatPose(ms) || call(trip, "door", ms) || at, kind: "own"}; }
  function poseAt(ms){ return call(trip, "pose", ms) || {x: at.x, y: 0, z: at.z, yaw: 0, speed: 0, doors: 0, under: false}; }
  function end(reason){
    if(ended) return; ended = true;
    S.phase = reason === "done" ? "done" : "cancelled";
    if(focused && o.view && typeof o.view.focus === "function"){ try { o.view.focus(null); } catch(e){} }
    if(lastUnder && reason !== "done" && typeof o.under === "function"){ /* the integrator decides where you surface */ }
    if(reason === "done") recordRide();
    if(typeof o.onEnd === "function"){ try { o.onEnd(reason); } catch(e){} }
  }
  function recordRide(){
    try {
      var lines = [];
      SVC.forEach(function(s){ (call(s, "lines") || []).forEach(function(l){ if(l && l.id != null) lines.push(String(l.id)); }); });
      var lineDef = null;
      SVC.forEach(function(s){ if(s.mode === trip.mode) (call(s, "lines") || []).forEach(function(l){ if(l && l.id === trip.line) lineDef = l; }); });
      var ls = lineDef ? lineDef.stops || [] : [], endTo = stops[endIdx] ? stops[endIdx].id : trip.to;
      var e2e = ls.length >= 2 && ((trip.from === ls[0] && endTo === ls[ls.length - 1]) || (trip.from === ls[ls.length - 1] && endTo === ls[0]));
      var dir = null;
      if(trip.world){
        var W = HQV.world, own = W && typeof W.ownerOf === "function" ? W.ownerOf(trip.world) : (/^claude-hq@/.test(String(trip.world)) ? "commons" : "x");
        dir = own === "commons" ? "out" : "back";
      }
      achievements.record({type: "ride", mode: trip.mode, line: String(trip.line), city: o.world || "city", cityLines: lines,
                           hour: hourOf(num(trip.depart, 0)), standing: !!(pick && pick.standing), endToEnd: e2e,
                           summit: !!(trip.summit || (stops[endIdx] && stops[endIdx].summit)), linkDir: dir});
    } catch(e){}
  }
  function nextStop(ms){
    for(var k = fromIdx + 1; k <= endIdx; k++) if(stops[k] && num(stops[k].at, 0) > ms) return k;
    return endIdx;
  }
  function changeText(k){
    var st = stops[k]; if(!st) return "";
    var here = null, other = {};
    allStops().forEach(function(e){ if(e.stop.id === st.id && e.svc.mode === trip.mode) here = e.stop; });
    if(!here) return "";
    allStops().forEach(function(e){
      if(d2(e.stop, here) > CHANGE_R) return;
      (e.stop.lines || []).forEach(function(lid){ if(String(lid) !== String(trip.line)) other[lineShort(e.svc, lid)] = 1; });
    });
    var names = Object.keys(other).sort();
    if(!names.length) return "";
    return " Change here for " + (names.length === 1 ? names[0] : names.slice(0, -1).join(", ") + " and " + names[names.length - 1]) + ".";
  }
  // when you get off: the trip's reach at its own end stop, else the earlier stop's time
  function stopTime(){ var st = stops[endIdx]; return !st || st.id === trip.to || endIdx === stops.length - 1 ? endAt : num(st.at, endAt); }
  function seatPose(ms){
    if(!pick) return null;
    return call(trip, "seat", pick.seat, ms);
  }
  S.step = function(ms, me){
    ms = num(ms, 0); me = me || meF(); lastMs = ms;
    if(ended) return S.phase;
    var p;
    if(S.phase === "walk" || S.phase === "wait"){
      if(ms > num(trip.depart, 0)){ say("You missed the " + modeWord.toLowerCase() + " " + label + "."); end("missed"); return S.phase; }
      if(S.phase === "walk"){
        if(!me || d2(me, at) <= AT_STOP){
          S.phase = "wait";
          var mins = Math.max(0, Math.round((num(trip.arrive, ms) - ms)/MIN));
          say(modeWord + " " + label + " to " + (trip.toName || trip.to) + (mins > 0 ? " comes in " + mins + " min." : " is due."));
        }
      } else if(me && d2(me, at) > LEFT_STOP){ say("You left the stop."); end("left"); return S.phase; }
      if(S.phase === "wait" && ms >= num(trip.arrive, 0)){
        p = poseAt(ms);
        if(!arrivedSaid){ arrivedSaid = true; say(modeWord + " " + label + " to " + (trip.toName || trip.to) + " arriving, doors open."); sfx(trip.mode === "tram" ? "tram-bell" : "door-chime", mine(ms)); }
        if(num(p.doors, 1) >= 0.5 || ms >= num(trip.arrive, 0) + 1500){
          var occ = null;
          var C = HQV.hqCommute;
          if(C && typeof C.occupied === "function") occ = C.occupied(trip.mode, trip.vehicle, String(trip.vehicle) + ":" + num(trip.depart, 0), trip.seats, trip.standing, num(trip.depart, 0), o.seed != null ? o.seed : "");
          pick = chooseSeat(trip, occ, ms);
          boardFrom = me ? {x: me.x, y: num(me.y, num(p.y, 0)), z: me.z} : {x: at.x, y: num(p.y, 0), z: at.z};
          t0 = ms; S.phase = "board"; sfx("validator");
          if(o.view && typeof o.view.focus === "function"){ try { o.view.focus(trip.vehicle); focused = true; } catch(e){} }
        }
      }
      return S.phase;
    }
    if(S.phase === "board"){
      if(ms - t0 >= BOARD_S*1000){
        S.phase = pick.standing ? "standing" : "seated";
        lastUnder = !!poseAt(ms).under;
        say(pick.standing ? "No seats free: you stand and hold the rail." : "You take a seat.");
      }
      return S.phase;
    }
    if(S.phase === "seated" || S.phase === "standing"){
      p = poseAt(ms);
      if(!closing && ms >= num(trip.depart, 0) - 3000){ closing = true; sfx("door-chime", mine(ms)); sfx("door-hiss", mine(ms)); }
      if(trip.world && !handed && ms >= num(trip.depart, 0)){ handed = true; if(typeof o.travel === "function"){ try { o.travel(trip); } catch(e){} } }
      var u = !!p.under;
      if(u !== lastUnder){ lastUnder = u; if(typeof o.under === "function"){ try { o.under(u); } catch(e){} } announce(u ? "Going underground." : "Back above ground."); }
      var k = nextStop(ms), prevAt = k - 1 >= fromIdx && stops[k - 1] ? num(stops[k - 1].at, num(trip.depart, 0)) : num(trip.depart, 0);
      if(k > fromIdx && k !== annK && ms >= Math.max(prevAt, num(trip.depart, 0)) + ANN_AFTER){
        annK = k;
        var st = stops[k] || {};
        say((k === endIdx ? "Next stop: " + (st.name || st.id) + ". This is your stop." : "Next stop: " + (st.name || st.id) + ".") + changeText(k));
      }
      var stopAt = stopTime();
      if(ms >= stopAt){
        var sp = seatPose(ms) || p, door = call(trip, "door", ms) || {x: p.x, z: p.z};
        var right = 1.6, yaw = num(p.yaw, 0);
        var kerb = {x: door.x - Math.cos(yaw)*right, y: num(p.y, 0), z: door.z + Math.sin(yaw)*right};
        alightPath = {a: {x: sp.x, y: num(p.y, 0), z: sp.z}, b: {x: door.x, y: num(p.y, 0), z: door.z}, c: kerb};
        t0 = ms; S.phase = "alight"; sfx("door-chime", mine(ms));
        var es = stops[endIdx] || {};
        say("This is " + (es.name || trip.toName || trip.to) + ". Doors open.");
      }
      return S.phase;
    }
    if(S.phase === "alight" && ms - t0 >= ALIGHT_S*1000){ say("You're at " + ((stops[endIdx] || {}).name || trip.toName || trip.to) + "."); end("done"); }
    return S.phase;
  };
  // the 1.2 s scripted walks: a -> b over the first 40 %, b -> c after
  function walkAlong(a, b, c, f){
    f = clamp(f, 0, 1);
    var p = f < 0.4 ? lerpP(a, b, f/0.4) : lerpP(b, c, (f - 0.4)/0.6), q = f < 0.4 ? [a, b] : [b, c];
    var dx = q[1].x - q[0].x, dz = q[1].z - q[0].z;
    p.yaw = dx*dx + dz*dz > 1e-6 ? Math.atan2(dx, dz) : 0;
    return p;
  }
  S.carry = function(ms){
    ms = num(ms, 0);
    if(S.phase === "board" && pick){
      var door = call(trip, "door", ms) || at, sp = seatPose(ms) || door, vp = poseAt(ms);
      var w = walkAlong(boardFrom, {x: door.x, y: num(vp.y, 0), z: door.z}, {x: sp.x, y: num(vp.y, 0), z: sp.z}, (ms - t0)/(BOARD_S*1000));
      return {x: w.x, y: w.y, z: w.z, yaw: w.yaw, anim: "walk"};
    }
    if(S.phase === "seated" || S.phase === "standing"){
      var s = seatPose(ms); if(!s) return null;
      var r = {x: num(s.x, 0), y: num(s.y, 0), z: num(s.z, 0), yaw: num(s.yaw, 0), anim: S.phase === "seated" ? "sit" : "stand"};
      if(S.phase === "standing") r.hands = "rail";
      return r;
    }
    if(S.phase === "alight" && alightPath){
      var a = walkAlong(alightPath.a, alightPath.b, alightPath.c, (ms - t0)/(ALIGHT_S*1000));
      return {x: a.x, y: a.y, z: a.z, yaw: a.yaw, anim: "walk"};
    }
    return null;
  };
  S.camPose = function(ms, look, mode){
    ms = num(ms, 0);
    if(S.phase !== "seated" && S.phase !== "standing") return null;
    var s = seatPose(ms); if(!s) return null;
    var vp = poseAt(ms), prev = poseAt(ms - 400), v = {};
    for(var k in vp) v[k] = vp[k];
    v.accel = (num(vp.speed, 0) - num(prev.speed, 0))/0.4;
    return seatCam(s, v, look, CAM_MODES.indexOf(mode) >= 0 ? mode : "seat", !!calm(), {standing: S.phase === "standing", t: ms, reduced: !!o.reduced});
  };
  S.requestStop = function(){
    if(S.phase !== "seated" && S.phase !== "standing") return false;
    var ok = S.alightNext(true);
    if(ok){ stopReq = true; sfx("stop-bell"); }
    return ok;
  };
  S.alightNext = function(quiet){
    if(S.phase === "walk" || S.phase === "wait"){ end("cancelled"); return true; }
    if(S.phase !== "seated" && S.phase !== "standing") return false;
    var ms = lastMs != null ? lastMs : (o.now ? num(o.now(), 0) : Date.now()), k = nextStop(ms);
    if(k < endIdx) endIdx = k;
    var st = stops[endIdx] || {};
    announce((quiet === true ? "Stop requested: " : "Getting off at ") + (st.name || st.id || trip.toName) + ".");
    return true;
  };
  S.cancel = function(force){
    if(ended) return false;
    if(!force && (S.phase === "seated" || S.phase === "standing")) return S.alightNext();
    end("cancelled"); return true;
  };
  S.info = function(ms){
    ms = ms != null ? num(ms, 0) : lastMs != null ? lastMs : (o.now ? num(o.now(), 0) : Date.now());
    var k = nextStop(ms), st = stops[k] || {}, es = stops[endIdx] || {};
    return {phase: S.phase, mode: trip.mode, line: trip.line, short: trip.short, vehicle: trip.vehicle,
            nextStop: {id: st.id, name: st.name || String(st.id || ""), at: num(st.at, 0)},
            to: es.name || trip.toName || trip.to, reach: stopTime(),
            seat: pick && !pick.standing ? pick.seat : null, standing: !!(pick && pick.standing), spot: pick && pick.standing ? pick.spot : null,
            under: !!lastUnder, stopRequested: stopReq, world: trip.world || null,
            arrive: num(trip.arrive, 0), depart: num(trip.depart, 0),         // when it reaches your stop and leaves it, and where you board
            door: {x: num(at.x, 0), z: num(at.z, 0)}};                         // (the tour waits there and skips ahead)
  };
  S.trip = trip;
  return S;
}
function lineShort(svc, id){
  var l = (call(svc, "lines") || []).filter(function(x){ return x && x.id === id; })[0];
  return l ? String(l.short || l.id) : String(id);
}
function hourOf(ms){
  var off = 0; try { off = new Date(ms).getTimezoneOffset(); } catch(e){}
  var l = ms - off*MIN; return (((l % DAY) + DAY) % DAY)/HOUR;
}

/* ---------- station names (pure, unique per world, independent of the order they are asked in) ---------- */
// A stop on a named road (within 90 m) is named from its place along that road: the road's length is cut into
// NAME_STEP m pieces and piece k is the road's name (k = 0), then the name with each suffix in a seeded order,
// then the same with a number ("Graph Avenue", "Graph Avenue Gate", ... "Graph Avenue 2"). Off the roads the
// nearest site's word, the piece by its rank among sites of that kind, the ring and the octant round it.
// Stops in the same piece share the name (an interchange is one name); different pieces never do.
var SUFFIX = ["Street", "Square", "Gate", "Park"], NAME_STEP = 120;
var KIND_WORD = {transit: "Central", port: "Harbour", dock: "Quay", airport: "Airport", stadium: "Stadium", hospital: "Hospital",
  university: "University", market: "Market", mall: "Mall", townhall: "Town Hall", school: "School", library: "Library",
  fountain: "Fountain", skatepark: "Skatepark", bikepark: "Bike Park", police: "Police", fire: "Fire Station", bank: "Bank",
  post: "Post Office", power: "Power Station", water: "Waterworks", clinic: "Clinic", carpark: "Car Park", campus: "Campus",
  studio: "Studios", office: "Offices", farm: "Farm", metro: "Central", rail: "Station", marina: "Marina"};
var NAME_MEMO = typeof WeakMap === "function" ? new WeakMap() : null, NAME_LIST = [];
function memoOf(W){
  if(NAME_MEMO){ var m = NAME_MEMO.get(W); if(!m){ m = {cache: {}, labels: null, sites: null}; NAME_MEMO.set(W, m); } return m; }
  for(var i = 0; i < NAME_LIST.length; i++) if(NAME_LIST[i].W === W) return NAME_LIST[i].m;
  var mm = {cache: {}, labels: null, sites: null}; NAME_LIST.push({W: W, m: mm}); return mm;
}
function titleWord(k){ k = String(k || "Stop"); return k.charAt(0).toUpperCase() + k.slice(1); }
function pieceName(base, k, h, plainFirst){
  k = Math.max(0, k | 0);
  var per = plainFirst ? SUFFIX.length + 1 : SUFFIX.length, i = k % per, round = Math.floor(k/per), name;
  if(plainFirst) name = i === 0 ? base : base + " " + SUFFIX[(h + i - 1) % SUFFIX.length];
  else name = base + " " + SUFFIX[(h + i) % SUFFIX.length];
  return round > 0 ? name + " " + (round + 1) : name;
}
function stationName(W, x, z, kind){
  x = num(x, 0); z = num(z, 0);
  if(!W || typeof W !== "object") return "Stop";
  var M = memoOf(W), ck = Math.round(x*10) + "," + Math.round(z*10) + "," + (kind || "");
  if(M.cache[ck]) return M.cache[ck];
  var WD = HQV.world, wid = String(W.id || W.seed || ""), name = null;
  if(!M.labels){
    var labs = [];
    try { labs = WD && typeof WD.roadLabels === "function" && W.edges ? WD.roadLabels(W) : []; } catch(e){ labs = []; }
    var off = {};
    M.labels = labs.filter(function(L){ return L && L.name && L.pts && L.pts.length >= 2; }).map(function(L){
      var cum = [0];
      for(var j = 1; j < L.pts.length; j++) cum.push(cum[j - 1] + Math.sqrt(Math.pow(L.pts[j][0] - L.pts[j-1][0], 2) + Math.pow(L.pts[j][1] - L.pts[j-1][1], 2)));
      var o = off[L.name] || 0; off[L.name] = o + cum[cum.length - 1] + NAME_STEP;   // a gap: pieces of two polylines never merge
      return {name: String(L.name), pts: L.pts, cum: cum, off: o};
    });
  }
  var bd = 90, best = null;
  M.labels.forEach(function(L){
    for(var j = 0; j + 1 < L.pts.length; j++){
      var ax = L.pts[j][0], az = L.pts[j][1], dx = L.pts[j+1][0] - ax, dz = L.pts[j+1][1] - az, l2 = dx*dx + dz*dz;
      var t = l2 > 0 ? clamp(((x - ax)*dx + (z - az)*dz)/l2, 0, 1) : 0, qx = ax + dx*t - x, qz = az + dz*t - z, d = Math.sqrt(qx*qx + qz*qz);
      if(d < bd - 1e-9 || (Math.abs(d - bd) <= 1e-9 && best && L.name < best.name)){ bd = d; best = {name: L.name, s: L.off + L.cum[j] + Math.sqrt(l2)*t}; }
    }
  });
  if(best) name = pieceName(best.name, Math.floor(best.s/NAME_STEP), hash32(wid + ":stn:" + best.name), true);
  else {
    if(!M.sites){
      var rank = {};
      M.sites = (W.sites || []).filter(function(s){ return s && KIND_WORD[s.kind]; }).slice()
        .sort(function(a, b){ return String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0; })
        .map(function(s){ var w = KIND_WORD[s.kind]; rank[w] = (rank[w] || 0) + 1; return {x: num(s.x, 0)/100, z: num(s.z, 0)/100, id: String(s.id), word: w, rank: rank[w] - 1}; });
    }
    var bs = Infinity, sk = null;
    M.sites.forEach(function(s){ var d = d2(s, {x: x, z: z}); if(d < bs - 1e-9){ bs = d; sk = s; } });
    if(sk){
      var oct = Math.floor((((Math.atan2(x - sk.x, z - sk.z) + 2*Math.PI) % (2*Math.PI)) + 1e-9)/(Math.PI/4)) % 8;
      var k = sk.rank*16 + Math.min(1, Math.floor(bs/150))*8 + (bs < 1 ? 0 : oct);
      name = sk.word === "Central" && k === 0 ? "Central" : pieceName(sk.word, k, hash32(wid + ":stn:" + sk.word), false);
    } else {
      var base = KIND_WORD[kind] || titleWord(kind);
      name = base + " " + (10 + hash32(wid + ":cell:" + Math.round(x/NAME_STEP) + ":" + Math.round(z/NAME_STEP)) % 90);
    }
  }
  M.cache[ck] = name;
  return name;
}

/* ---------- departure boards ---------- */
function pad2(n){ return (n < 10 ? "0" : "") + n; }
function clockText(ms, o){
  o = o || {};
  var d = new Date(num(ms, 0)), h = d.getHours(), m = d.getMinutes();
  if(o.h12){ var ap = h < 12 ? "am" : "pm"; h = h % 12 || 12; return h + ":" + pad2(m) + ap; }
  return pad2(h) + ":" + pad2(m);
}
// "boarding" while doors are open, "due" under a minute, "N min" under 20, else HH:MM (city clock)
function dueText(at, ms, boarding, o){
  if(boarding) return "boarding";
  var s = (num(at, 0) - num(ms, 0))/1000;
  if(s < 60) return "due";
  if(s < 20*60) return Math.floor(s/60) + " min";
  return clockText(at, o);
}
// departures (sim.departures rows) -> board rows {badge, dest, due, plat}
function boardRows(deps, ms, o){
  return (deps || []).slice(0, (o && o.n) || 4).map(function(d){
    var due = dueText(d.at, ms, d.boarding, o);
    if(num(d.delay, 0) >= 60 && !d.boarding) due = "delayed +" + Math.round(d.delay/60) + " min";
    return {badge: String(d.short || d.line || ""), dest: String(d.to || ""), due: due, plat: d.plat != null ? String(d.plat) : ""};
  });
}
var ATLAS = [], SLOTS = 8, CW = 512, SH = 128;
function boardTexture(THREE, rows, opts){
  opts = opts || {};
  var doc = root.document;
  if(!THREE || !doc || typeof doc.createElement !== "function") return null;
  var at = opts.at || null, A = null, i;
  for(i = 0; i < ATLAS.length && !A; i++){
    var a = ATLAS[i];
    if(a.THREE !== THREE || a.free.length === 0) continue;
    if(!at || !a.at || d2(a.at, at) <= BOARD_SHARE) A = a;
  }
  if(!A){
    var cv = doc.createElement("canvas"); cv.width = CW; cv.height = SH*SLOTS;
    var tex = new THREE.CanvasTexture(cv);
    if(THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    A = {THREE: THREE, at: at ? {x: at.x, z: at.z} : null, canvas: cv, g: cv.getContext("2d"), texture: tex, free: []};
    for(i = 0; i < SLOTS; i++) A.free.push(i);
    ATLAS.push(A);
  }
  var slot = A.free.shift(), last = -Infinity, nowF = fn(opts.now, null);
  var v0 = 1 - (slot + 1)/SLOTS, v1 = 1 - slot/SLOTS;
  function paint(rs){
    var g = A.g; if(!g) return;
    var y0 = slot*SH, rowH = SH/4;
    g.fillStyle = "#0b0805"; g.fillRect(0, y0, CW, SH);
    g.textBaseline = "middle"; g.font = "bold 22px monospace";
    for(var r = 0; r < 4; r++){
      var row = rs && rs[r], cy = y0 + rowH*r + rowH/2;
      if(!row) continue;
      g.fillStyle = "#ffb000";
      g.strokeStyle = "#ffb000"; g.lineWidth = 2; g.strokeRect(6, cy - 12, 52, 24);
      g.textAlign = "center"; g.fillText(String(row.badge || "").slice(0, 3), 32, cy + 1);
      g.textAlign = "left"; g.fillText(String(row.dest || "").slice(0, 22), 70, cy + 1);
      g.textAlign = "right"; g.fillText(String(row.due || ""), CW - 8, cy + 1);
    }
    // the dot matrix: dark gaps every 3 px
    g.fillStyle = "rgba(11,8,5,0.6)";
    for(var gy = y0; gy < y0 + SH; gy += 3) g.fillRect(0, gy, CW, 1);
    for(var gx = 0; gx < CW; gx += 3) g.fillRect(gx, y0, 1, SH);
    A.texture.needsUpdate = true;
  }
  var B = {
    texture: A.texture, slot: slot, uv: {u0: 0, v0: v0, u1: 1, v1: v1}, aspect: CW/SH,
    draw: function(rs, ms, force){
      ms = ms != null ? num(ms, 0) : (nowF() != null ? num(nowF(), 0) : Date.now());
      if(!force && ms - last < BOARD_EVERY) return false;
      last = ms; paint(rs); return true;
    },
    // a PlaneGeometry's uv onto this board's strip of the shared atlas
    applyUv: function(geo){
      var uv = geo && geo.attributes && geo.attributes.uv; if(!uv) return geo;
      for(var k = 0; k < uv.count; k++) uv.setY(k, v0 + uv.getY(k)*(v1 - v0));
      uv.needsUpdate = true; return geo;
    },
    dispose: function(){ if(A.free.indexOf(slot) < 0) A.free.push(slot); }
  };
  B.draw(rows, opts.ms != null ? opts.ms : undefined, true);
  return B;
}

/* ---------- sound (WebAudio only) ---------- */
var NOISE = typeof WeakMap === "function" ? new WeakMap() : null;
function noiseBuf(ctx){
  var b = NOISE && NOISE.get(ctx); if(b) return b;
  var rate = num(ctx.sampleRate, 44100), n = Math.floor(rate*1.5);
  b = ctx.createBuffer(1, n, rate);
  var d = b.getChannelData(0), a = 0x9e3779b9;
  for(var i = 0; i < n; i++){ a = (Math.imul(a, 1664525) + 1013904223) >>> 0; d[i] = a/2147483648 - 1; }   // seeded: the same hiss every time
  if(NOISE) NOISE.set(ctx, b);
  return b;
}
var SFX_NAMES = ["door-chime", "door-hiss", "validator", "stop-bell", "tram-bell", "air-brake", "motor", "rail-joint", "tunnel-rumble",
                 "gondola-clunk", "ferry-horn", "indicator", "rotor", "ring", "dial", "shutter", "chime",
                 "door", "hiss", "engine-hum", "gangway-clank", "water-lap", "gondola-rumble", "gondola-wind", "ship-horn"];
// The loops can never leak, whoever holds them: each falls silent HOLD s (opts.ttl) after it was last asked for or
// set() (a dead man's switch) and its nodes stop soon after; set() on one that stopped starts it again, and
// {stop: true} (or mute) ends it. An unplaced loop is ONE live voice per context and name: asking for it again
// refreshes the live one (its speed, its gain) instead of starting another (the metro asked for a new "motor" every
// 0.5 s and never stopped one: a growing stack of sawtooths droned on everywhere). A placed one (opts.pos) is one
// voice per handle, held by its caller (a pool's slot, a station's bull wheel) and set() with its place every frame.
var LOOPS = {"motor": 1, "tunnel-rumble": 1, "rotor": 1, "engine-hum": 1, "gondola-rumble": 1, "gondola-wind": 1}, HOLD = 0.6;
// opts.pos ({x, y, z}): where the sound is, through games/engine.js's spatial graph (the distance fade, the pan, each
// kind's voice limit); opts.kind is its spatial kind, by default:
var NAME_KIND = {"door-chime": "door", "door-hiss": "door", "validator": "door", "door": "door", "hiss": "door", "gangway-clank": "door",
  "stop-bell": "bell", "tram-bell": "bell", "air-brake": "bus", "motor": "metro", "rail-joint": "metro", "tunnel-rumble": "metro",
  "gondola-clunk": "gondola", "gondola-rumble": "gondola", "gondola-wind": "gondola", "ferry-horn": "horn", "ship-horn": "horn",
  "engine-hum": "boat", "water-lap": "water", "indicator": "vehicle", "rotor": "heli", "ring": "ui", "dial": "ui", "shutter": "ui", "chime": "ui"};
// how long each one-shot sounds (s): its voice is held that long (the one-shot voice limit)
var SFX_DUR = {"door-chime": 0.95, "chime": 1.2, "door-hiss": 0.75, "validator": 0.2, "stop-bell": 0.95, "tram-bell": 0.95, "air-brake": 0.6,
  "rail-joint": 0.3, "gondola-clunk": 0.35, "ferry-horn": 1.8, "ship-horn": 3.1, "indicator": 0.45, "ring": 1.05, "dial": 2.05, "shutter": 0.15,
  "door": 0.65, "hiss": 0.6, "gangway-clank": 0.45, "water-lap": 1.6};
function rateOf(o, d){ var r = num(o && o.rate, d); return clamp(r > 0 ? r : d, 0.5, 2); }   // Doppler: every pitch times rate
function sfx(ctx, name, opts){
  opts = opts || {};
  if(!ctx || SFX_NAMES.indexOf(name) < 0) return null;
  var live = LOOPS[name] && !opts.pos ? (ctx.__hqLoops || (ctx.__hqLoops = {})) : null;   // the context's unplaced loops
  if(live && live[name] && !live[name].alive()) delete live[name];
  if(live && (opts.stop || opts.mute)){ if(live[name]) live[name].stop(); return null; }
  if(opts.mute || opts.stop) return null;
  var vol = clamp(num(opts.gain, num(opts.volume, 1)), 0, 1);
  if(live && live[name]){ live[name].set(opts); return live[name]; }
  if(vol <= 0) return null;
  if(LOOPS[name]) return held(ctx, name, opts, vol, live);
  var V = spot(ctx, name, opts, false); if(V === false) return null;
  var H = make(ctx, name, opts, vol, V);
  if(!H && V) V.end(0);
  return H;
}
// the spatial voice for a sound at opts.pos: null when it is not positional (no pos, no engine, a UI sound, another
// AudioContext), false when it is not heard (too far, the kind's voices all nearer, sound off)
function spot(ctx, name, opts, hold){
  if(!opts.pos) return null;
  var E = HQV.engine; if(!E || typeof E.spatialOut !== "function") return null;
  var kind = opts.kind || NAME_KIND[name] || "door";
  if(kind === "ui") return null;
  var V = null; try { V = E.spatialOut(kind, opts.pos, {hold: hold, dur: SFX_DUR[name] || 1, key: opts.key}); } catch(e){ V = null; }
  if(!V) return false;
  if(V.ctx !== ctx){ try { V.end(0); } catch(e){} return null; }
  return V;
}
// a loop's handle: one voice at a time, made afresh when the last one stopped (no set() for a while), so set() always
// sounds. live (an unplaced loop): the context's register, one live voice per name; a handle whose voice stopped and
// was replaced there sets the live one instead of starting a second
function held(ctx, name, opts, vol, live){
  var o = {}, k; for(k in opts) o[k] = opts[k];
  function fresh(){ var V = spot(ctx, name, o, true); if(V === false) return null; var h = make(ctx, name, o, vol, V); if(!h && V) V.end(0); return h; }
  var cur = fresh(); if(!cur) return null;
  var H = {name: name, loop: true,
    set: function(o2){
      o2 = o2 || {}; for(var k2 in o2) o[k2] = o2[k2];
      if(o2.gain != null || o2.volume != null) vol = clamp(num(o2.gain, num(o2.volume, vol)), 0, 1);
      if(!cur || num(ctx.currentTime, 0) >= cur.stopAt - 0.02){
        if(live && live[name] && live[name] !== H && live[name].alive()){ live[name].set(o2); return; }
        if(cur) cur.stop(); cur = fresh(); if(!cur) return;
        if(live) live[name] = H;
      }
      cur.set(o2);
    },
    stop: function(){ if(cur){ cur.stop(); cur = null; } if(live && live[name] === H) delete live[name]; },
    alive: function(){ return !!cur && num(ctx.currentTime, 0) < cur.stopAt; }};
  if(live) live[name] = H;
  return H;
}
function make(ctx, name, opts, vol, V){
  try {
    var t = num(ctx.currentTime, 0) + num(opts.delay, 0) + (V ? num(V.delay, 0) : 0), nodes = [];
    var out = ctx.createGain(); out.gain.value = vol; out.connect(V ? V.out : (opts.dest || ctx.destination)); nodes.push(out);
    var env = function(g, t0, peak, dur, attack){
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t0 + (attack || 0.01));
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    };
    var tone = function(f, t0, dur, type, peak, attack){
      var os = ctx.createOscillator(), g = ctx.createGain();
      os.type = type || "sine"; os.frequency.setValueAtTime(f, t0);
      env(g, t0, peak, dur, attack); os.connect(g); g.connect(out); os.start(t0); os.stop(t0 + dur + 0.05);
      nodes.push(os, g); return os;
    };
    var noise = function(t0, dur, ftype, freq, peak, loop, attack){
      var src = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
      src.buffer = noiseBuf(ctx); src.loop = !!loop;
      f.type = ftype || "bandpass"; f.frequency.setValueAtTime(freq || 1000, t0);
      if(loop){ g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t0 + (attack || 0.3)); }
      else env(g, t0, peak, dur, attack);
      src.connect(f); f.connect(g); g.connect(out); src.start(t0); if(!loop) src.stop(t0 + dur + 0.05);
      nodes.push(src, f, g); return {src: src, f: f, g: g};
    };
    var loopH = null, sp = clamp(num(opts.speed, 0), 0, 60), rt = rateOf(opts, 1);
    switch(name){
      case "door-chime": tone(659.3, t, 0.35, "sine", 0.35); tone(523.3, t + 0.22, 0.35, "sine", 0.35); tone(392, t + 0.44, 0.5, "sine", 0.35); break;
      case "chime": tone(784, t, 0.4, "sine", 0.3); tone(659.3, t + 0.28, 0.4, "sine", 0.3); tone(523.3, t + 0.56, 0.6, "sine", 0.3); break;
      case "door-hiss": noise(t, 0.7, "highpass", 2500, 0.25, false, 0.02); break;
      case "validator": tone(1568, t, 0.12, "square", 0.12, 0.004); break;
      case "stop-bell": tone(1318.5, t, 0.9, "sine", 0.3, 0.003); tone(2637, t, 0.5, "sine", 0.1, 0.003); break;
      case "tram-bell": tone(880, t, 0.5, "triangle", 0.35, 0.003); tone(1760, t, 0.3, "sine", 0.12, 0.003);
                        tone(880, t + 0.28, 0.6, "triangle", 0.35, 0.003); tone(1760, t + 0.28, 0.3, "sine", 0.12, 0.003); break;
      case "air-brake": noise(t, 0.55, "bandpass", 2200, 0.35, false, 0.005); break;
      case "rail-joint": tone(62, t, 0.12, "sine", 0.4, 0.003); noise(t, 0.05, "bandpass", 900, 0.15, false, 0.002);
                         tone(62, t + 0.14, 0.12, "sine", 0.4, 0.003); noise(t + 0.14, 0.05, "bandpass", 900, 0.15, false, 0.002); break;
      case "gondola-clunk": tone(90, t, 0.3, "sine", 0.45, 0.003); noise(t, 0.08, "lowpass", 600, 0.2, false, 0.002); break;
      case "ferry-horn": tone(110, t, 1.7, "sawtooth", 0.25, 0.12); tone(165, t, 1.7, "sawtooth", 0.18, 0.12); break;
      case "indicator": noise(t, 0.025, "highpass", 3000, 0.25, false, 0.001); noise(t + 0.38, 0.025, "highpass", 2200, 0.2, false, 0.001); break;
      case "ring": tone(440, t, 0.4, "sine", 0.2, 0.01); tone(480, t, 0.4, "sine", 0.2, 0.01);
                   tone(440, t + 0.6, 0.4, "sine", 0.2, 0.01); tone(480, t + 0.6, 0.4, "sine", 0.2, 0.01); break;
      case "dial": tone(350, t, 2, "sine", 0.15, 0.02); tone(440, t, 2, "sine", 0.15, 0.02); break;
      case "shutter": noise(t, 0.03, "highpass", 4000, 0.4, false, 0.001); noise(t + 0.07, 0.04, "highpass", 2500, 0.3, false, 0.001); break;
      // a sliding door's run, then its thunk; a bus's pneumatic doors; a gangway's steel landing; water slapping a pier
      case "door": noise(t, 0.45, "bandpass", 700, 0.22, false, 0.05); tone(130, t + 0.4, 0.2, "sine", 0.3, 0.004); break;
      case "hiss": noise(t, 0.55, "highpass", 3400, 0.22, false, 0.01); noise(t, 0.3, "bandpass", 1800, 0.08, false, 0.01); break;
      case "gangway-clank": tone(180, t, 0.25, "triangle", 0.35, 0.002); tone(247, t + 0.09, 0.3, "triangle", 0.25, 0.002);
                            noise(t, 0.12, "bandpass", 1300, 0.18, false, 0.002); break;
      case "water-lap": noise(t, 0.9, "lowpass", 650, 0.22, false, 0.18); noise(t + 0.55, 1, "lowpass", 480, 0.14, false, 0.22); break;
      case "ship-horn": tone(73.4, t, 3, "sawtooth", 0.3, 0.3); tone(110, t, 3, "sawtooth", 0.16, 0.3); break;   // a ship's deep horn
      case "motor": {
        var os = ctx.createOscillator(), lp = ctx.createBiquadFilter(), g = ctx.createGain();
        os.type = "sawtooth"; os.frequency.setValueAtTime((110 + sp*18)*rt, t);
        lp.type = "lowpass"; lp.frequency.setValueAtTime(900, t);
        g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.08, t + 0.3);
        os.connect(lp); lp.connect(g); g.connect(out); os.start(t); nodes.push(os, lp, g);
        loopH = {set: function(o2){ sp = clamp(num(o2.speed, sp), 0, 60); rt = rateOf(o2, rt); os.frequency.setTargetAtTime((110 + sp*18)*rt, num(ctx.currentTime, 0), 0.2); }};
        break;
      }
      case "tunnel-rumble": { var nr = noise(t, 0, "lowpass", 180, 0.3, true, 0.5);
        loopH = {set: function(o2){ sp = clamp(num(o2.speed, sp), 0, 60); nr.g.gain.setTargetAtTime(0.05 + 0.3*clamp(sp/22, 0, 1), num(ctx.currentTime, 0), 0.3); }}; break; }
      case "rotor": {          // the blades' slap and the turbine's noise, both shifted by opts.rate (Doppler)
        var nn = noise(t, 0, "lowpass", 400*rt, 0.35, true, 0.4), lfo = ctx.createOscillator(), lg = ctx.createGain();
        lfo.type = "sine"; lfo.frequency.setValueAtTime((14 + sp*0.2)*rt, t); lg.gain.value = 0.3;
        lfo.connect(lg); lg.connect(nn.g.gain); lfo.start(t); nodes.push(lfo, lg);
        loopH = {set: function(o2){ sp = clamp(num(o2.speed, sp), 0, 60); rt = rateOf(o2, rt); var n = num(ctx.currentTime, 0);
          lfo.frequency.setTargetAtTime((14 + sp*0.2)*rt, n, 0.3); nn.f.frequency.setTargetAtTime(400*rt, n, 0.3); }};
        break;
      }
      case "engine-hum": {     // a boat's diesel throbbing under the deck (speed: m/s)
        var eo = ctx.createOscillator(), elp = ctx.createBiquadFilter(), eg = ctx.createGain(), el = ctx.createOscillator(), eld = ctx.createGain();
        eo.type = "sawtooth"; eo.frequency.setValueAtTime((46 + sp*2.5)*rt, t);
        elp.type = "lowpass"; elp.frequency.setValueAtTime(260, t);
        eg.gain.setValueAtTime(0.0001, t); eg.gain.exponentialRampToValueAtTime(0.12, t + 0.5);
        el.type = "sine"; el.frequency.setValueAtTime(5.5, t); eld.gain.value = 0.04;
        eo.connect(elp); elp.connect(eg); eg.connect(out); el.connect(eld); eld.connect(eg.gain); eo.start(t); el.start(t);
        nodes.push(eo, elp, eg, el, eld);
        loopH = {set: function(o2){ sp = clamp(num(o2.speed, sp), 0, 60); rt = rateOf(o2, rt); eo.frequency.setTargetAtTime((46 + sp*2.5)*rt, num(ctx.currentTime, 0), 0.3); }};
        break;
      }
      case "gondola-rumble": { // the bull wheel turning: a low drone, the haul rope's rumble, the sheaves' beat
        var gw = ctx.createOscillator(), gg = ctx.createGain(), gr = noise(t, 0, "lowpass", 140, 0.18, true, 0.6), gl = ctx.createOscillator(), gld = ctx.createGain();
        gw.type = "sine"; gw.frequency.setValueAtTime(38 + sp*1.5, t); gg.gain.setValueAtTime(0.0001, t); gg.gain.exponentialRampToValueAtTime(0.1, t + 0.6);
        gl.type = "sine"; gl.frequency.setValueAtTime(0.8 + sp*0.25, t); gld.gain.value = 0.06;
        gw.connect(gg); gg.connect(out); gl.connect(gld); gld.connect(gr.g.gain); gw.start(t); gl.start(t);
        nodes.push(gw, gg, gl, gld);
        loopH = {set: function(o2){ sp = clamp(num(o2.speed, sp), 0, 60); var n = num(ctx.currentTime, 0);
          gl.frequency.setTargetAtTime(0.8 + sp*0.25, n, 0.3); gw.frequency.setTargetAtTime(38 + sp*1.5, n, 0.3); }};
        break;
      }
      case "gondola-wind": {   // wind past your cabin, gusting slowly, louder with the speed
        var wn = noise(t, 0, "bandpass", 420 + sp*30, 0.16, true, 0.8), wl = ctx.createOscillator(), wld = ctx.createGain();
        wn.f.Q.setValueAtTime(0.7, t); wl.type = "sine"; wl.frequency.setValueAtTime(0.23, t); wld.gain.value = 0.08;
        wl.connect(wld); wld.connect(wn.g.gain); wl.start(t); nodes.push(wl, wld);
        loopH = {set: function(o2){ sp = clamp(num(o2.speed, sp), 0, 60); wn.f.frequency.setTargetAtTime(420 + sp*30, num(ctx.currentTime, 0), 0.5); }};
        break;
      }
    }
    var H = {name: name, loop: !!loopH, stopAt: Infinity, stop: function(){
      try { var n2 = num(ctx.currentTime, 0); if(out.gain.cancelScheduledValues) out.gain.cancelScheduledValues(n2);
        out.gain.setTargetAtTime(0.0001, n2, 0.08); H.stopAt = n2 + 0.4;
        nodes.forEach(function(nd){ if(nd && typeof nd.stop === "function"){ try { nd.stop(n2 + 0.4); } catch(e){} } }); } catch(e){}
      if(V){ try { V.end(0.4); } catch(e){} }
    }, set: function(){}};
    if(loopH){
      // the dead man's switch: full level now, silent ttl s on (HOLD, or opts.ttl) unless set() comes again; a rolling
      // stop keeps the nodes' end ~1-2 s past the last set(), so a loop nobody set()s any more stops by itself
      var ttl = Math.max(0.5, num(opts.ttl, HOLD));
      var hold = function(n){
        var p = out.gain;
        if(p.cancelScheduledValues) p.cancelScheduledValues(n);
        p.setTargetAtTime(vol, n, 0.05); p.setTargetAtTime(0.0001, n + ttl, 0.08);
        if(n + ttl + 0.4 > H.stopAt || H.stopAt === Infinity){
          H.stopAt = n + ttl + 1.2;
          nodes.forEach(function(nd){ if(nd && typeof nd.stop === "function"){ try { nd.stop(H.stopAt); } catch(e){} } });
        }
      };
      H.set = function(o2){
        o2 = o2 || {};
        if(o2.gain != null || o2.volume != null) vol = clamp(num(o2.gain, num(o2.volume, vol)), 0, 1);   // a refresh's gain
        hold(Math.max(t, num(ctx.currentTime, 0))); try { loopH.set(o2); } catch(e){} if(V && o2.pos) V.move(o2.pos);
      };
      hold(t);
    }
    return H;
  } catch(e){ return null; }
}

/* ---------- the announcer: chime, then a LOCAL voice only ---------- */
function localVoice(voices, lang){
  var L = (voices || []).filter(function(v){ return v && v.localService === true; });
  if(!L.length) return null;
  lang = String(lang || "en").toLowerCase();
  var pref = L.filter(function(v){ return String(v.lang || "").toLowerCase().indexOf(lang) === 0; });
  return (pref[0] || L[0]);
}
function announcer(o){
  o = o || {};
  var calm = fn(o.calm, false), voiceOn = typeof o.voiceOn === "function" ? o.voiceOn : function(){ return true; };
  var later = typeof o.later === "function" ? o.later : function(f, ms){ return root.setTimeout ? root.setTimeout(f, ms) : f(); };
  function speak(text){
    var syn = o.synth || root.speechSynthesis, U = o.Utterance || root.SpeechSynthesisUtterance;
    if(!syn || !U || typeof syn.getVoices !== "function") return false;
    var v = localVoice(syn.getVoices(), o.lang);
    if(!v) return false;                       // never a network voice: text only
    var u = new U(text); u.voice = v; u.lang = v.lang; u.rate = 1;
    try { syn.speak(u); return true; } catch(e){ return false; }
  }
  return {
    say: function(text, so){
      so = so || {}; text = String(text == null ? "" : text).slice(0, 300);
      if(!text) return {chime: false, voice: false};
      if(typeof o.announce === "function"){ try { o.announce(text); } catch(e){} }
      var chimed = false, ctx = typeof o.audio === "function" ? o.audio() : null;
      if(so.chime !== false && !calm() && ctx){
        // into o.dest, else the engine's master (the Game sounds volume) when it is the same context, else the speakers
        var dest = typeof o.dest === "function" ? o.dest() : o.dest || null, E = HQV.engine;
        if(!dest && E && typeof E.audioOut === "function"){ var A = null; try { A = E.audioOut(); } catch(e){} if(A && A.ctx === ctx) dest = A.out; }
        chimed = !!sfx(ctx, "chime", {gain: typeof o.gain === "function" ? o.gain() : 1, mute: typeof o.mute === "function" && o.mute(), dest: dest || undefined});
      }
      var on = false; try { on = !!voiceOn(); } catch(e){}
      if(!on) return {chime: chimed, voice: false};
      if(chimed){ later(function(){ speak(text); }, 1100); return {chime: true, voice: "later"}; }
      return {chime: false, voice: speak(text)};
    },
    voice: function(){ var syn = o.synth || root.speechSynthesis; return syn && syn.getVoices ? localVoice(syn.getVoices(), o.lang) : null; }
  };
}

/* ---------- local storage, guarded (an in-memory copy when it throws) ---------- */
var MEM = {};
function lsGet(k){
  var v = null;
  try { var ls = root.localStorage; if(ls) v = ls.getItem(k); } catch(e){ v = null; }
  if(v == null && MEM[k] != null) v = MEM[k];
  return v;
}
function lsSet(k, v){ MEM[k] = v; try { var ls = root.localStorage; if(ls) ls.setItem(k, v); } catch(e){} }
function jget(k, d){ var s = lsGet(k); if(s == null) return d; try { var o = JSON.parse(s); return o == null ? d : o; } catch(e){ return d; } }

/* ---------- free tickets and boarding passes ---------- */
var T_KEY = "hq_ride_tickets", T_MAX = 30;
var T_FIELDS = ["id", "kind", "mode", "line", "short", "from", "to", "fromName", "toName", "depart", "reach", "seat", "gate", "flight", "world", "made", "pattern"];
function cleanTicket(t){
  var o = {};
  T_FIELDS.forEach(function(k){
    var v = t[k];
    if(v == null) return;
    if(typeof v === "number"){ if(isFinite(v)) o[k] = v; }
    else if(typeof v === "string" || typeof v === "boolean") o[k] = typeof v === "string" ? v.slice(0, 80) : v;
  });
  return o;
}
var tickets = {
  list: function(){ var a = jget(T_KEY, []); return Array.isArray(a) ? a.filter(function(t){ return t && t.id; }) : []; },
  add: function(t){
    t = cleanTicket(t || {});
    if(t.made == null) t.made = Date.now();
    if(!t.kind) t.kind = t.gate || t.flight ? "pass" : "ticket";
    if(!t.id) t.id = "T" + Math.floor(t.made/1000).toString(36).toUpperCase() + (hash32(JSON.stringify(t)) % 1679616).toString(36).toUpperCase();
    var a = tickets.list().filter(function(x){ return x.id !== t.id; });
    a.unshift(t);
    a.sort(function(x, y){ return num(y.made, 0) - num(x.made, 0); });
    lsSet(T_KEY, JSON.stringify(a.slice(0, T_MAX)));
    return t;
  },
  remove: function(id){ var a = tickets.list(), b = a.filter(function(x){ return x.id !== id; }); lsSet(T_KEY, JSON.stringify(b)); return b.length !== a.length; },
  clear: function(){ lsSet(T_KEY, "[]"); }
};

/* ---------- achievements (local only) ---------- */
var A_KEY = "hq_ride_achv";
var ALL_MODES = ["bus", "tram", "metro", "rail", "link", "ferry", "gondola", "cab"];
var ACH = [
  {id: "line-collector", name: "Line collector", desc: "Ride every line in a city."},
  {id: "all-aboard", name: "All aboard", desc: "Ride every kind of transport: bus, tram, metro, rail, Island Link, water bus, gondola and a Claude Cab."},
  {id: "rush-hour", name: "Rush hour", desc: "Stand on a full tram."},
  {id: "night-owl", name: "Night owl", desc: "Ride after 01:00 city time."},
  {id: "up-the-hill", name: "Up the hill", desc: "Take the gondola to the summit."},
  {id: "mole", name: "Mole", desc: "Ride a metro line end to end."},
  {id: "island-hopper", name: "Island hopper", desc: "Ride the Island Link both ways."},
  {id: "cabbie", name: "Cabbie", desc: "Drive 10 Claude Cabs fares.", goal: 10},
  {id: "five-stars", name: "Five stars", desc: "Earn a 5-star driver rating."},
  {id: "high-flyer", name: "High flyer", desc: "Call a helicopter."}
];
var LISTEN = [];
function aState(){
  var s = jget(A_KEY, null);
  if(!s || typeof s !== "object") s = {};
  s.done = s.done && typeof s.done === "object" ? s.done : {};
  s.lines = s.lines && typeof s.lines === "object" ? s.lines : {};
  s.total = s.total && typeof s.total === "object" ? s.total : {};
  s.modes = Array.isArray(s.modes) ? s.modes : [];
  s.link = Array.isArray(s.link) ? s.link : [];
  s.fares = num(s.fares, 0) | 0;
  return s;
}
function uniq(a){ var o = {}, r = []; a.forEach(function(x){ x = String(x); if(!o[x]){ o[x] = 1; r.push(x); } }); return r; }
function progressOf(s, id){
  switch(id){
    case "line-collector": {
      var best = 0;
      Object.keys(s.lines).forEach(function(c){ var tot = num(s.total[c], 0); if(tot > 0) best = Math.max(best, Math.min(1, s.lines[c].length/tot)); });
      return best;
    }
    case "all-aboard": return s.modes.filter(function(m){ return ALL_MODES.indexOf(m) >= 0; }).length/ALL_MODES.length;
    case "island-hopper": return s.link.length/2;
    case "cabbie": return Math.min(1, s.fares/10);
    default: return s.done[id] ? 1 : 0;
  }
}
var achievements = {
  list: function(){
    var s = aState();
    return ACH.map(function(a){ return {id: a.id, name: a.name, desc: a.desc, done: !!s.done[a.id], at: s.done[a.id] || null, progress: s.done[a.id] ? 1 : progressOf(s, a.id)}; });
  },
  stats: function(){ var s = aState(); return {fares: s.fares, modes: s.modes.slice(), link: s.link.slice()}; },
  onUnlock: function(f){ if(typeof f === "function") LISTEN.push(f); return function(){ LISTEN = LISTEN.filter(function(g){ return g !== f; }); }; },
  // event: {type: "ride", mode, line, city, cityLines, hour, standing, endToEnd, summit, linkDir: "out"|"back"}
  //        {type: "fare", stars?} (a driver fare done), {type: "rating", stars}, {type: "heli"}
  record: function(ev){
    ev = ev || {};
    var s = aState(), got = [], at = num(ev.at, Date.now());
    function unlock(id){ if(!s.done[id]){ s.done[id] = at; got.push(id); } }
    if(ev.type === "ride"){
      var mode = String(ev.mode || "");
      if(mode){ s.modes = uniq(s.modes.concat([mode])); }
      var city = String(ev.city || "city");
      if(ev.line != null && mode !== "cab"){
        s.lines[city] = uniq((s.lines[city] || []).concat([String(ev.line)]));
        if(Array.isArray(ev.cityLines) && ev.cityLines.length) s.total[city] = uniq(ev.cityLines.map(String)).length;
        var tot = uniq((ev.cityLines || []).map(String));
        if(tot.length && tot.every(function(l){ return s.lines[city].indexOf(l) >= 0; })) unlock("line-collector");
      }
      if(ALL_MODES.every(function(m){ return s.modes.indexOf(m) >= 0; })) unlock("all-aboard");
      if(mode === "tram" && ev.standing) unlock("rush-hour");
      var h = num(ev.hour, 12);
      if(h >= 1 && h < 5) unlock("night-owl");
      if(mode === "gondola" && ev.summit) unlock("up-the-hill");
      if(mode === "metro" && ev.endToEnd) unlock("mole");
      if(mode === "link" && (ev.linkDir === "out" || ev.linkDir === "back")){ s.link = uniq(s.link.concat([ev.linkDir])); if(s.link.length >= 2) unlock("island-hopper"); }
    } else if(ev.type === "fare"){
      s.fares++;
      if(s.fares >= 10) unlock("cabbie");
      if(num(ev.stars, 0) >= 5) unlock("five-stars");
    } else if(ev.type === "rating"){ if(num(ev.stars, 0) >= 5) unlock("five-stars"); }
    else if(ev.type === "heli") unlock("high-flyer");
    lsSet(A_KEY, JSON.stringify(s));
    got.forEach(function(id){
      var a = ACH.filter(function(x){ return x.id === id; })[0];
      LISTEN.slice().forEach(function(f){ try { f({id: a.id, name: a.name, desc: a.desc}); } catch(e){} });
    });
    return got;
  },
  reset: function(){ lsSet(A_KEY, "{}"); }
};

HQV.hqRide = {register: register, unregister: unregister, services: services, stopsNear: stopsNear, plan: plan, session: session,
  seatCam: seatCam, chooseSeat: chooseSeat, stationName: stationName, dueText: dueText, clockText: clockText, boardRows: boardRows,
  boardTexture: boardTexture, sfx: sfx, SFX: SFX_NAMES, announcer: announcer, localVoice: localVoice, tickets: tickets,
  achievements: achievements, ACHIEVEMENTS: ACH, ALL_MODES: ALL_MODES, hash32: hash32,
  consts: {WALK_V: WALK_V, CHANGE_MIN: CHANGE_MIN, UNDER_ADD: UNDER_ADD, WALK_R: WALK_R, CHANGE_R: CHANGE_R, MAX_OPTS: MAX_OPTS,
           BOARD_S: BOARD_S, ALIGHT_S: ALIGHT_S, EYE_SIT: EYE_SIT, EYE_STAND: EYE_STAND, YAW_MAX: YAW_MAX, PITCH_MAX: PITCH_MAX, FOV: FOV,
           BOARD_EVERY: BOARD_EVERY, BOARD_SHARE: BOARD_SHARE, NAME_STEP: NAME_STEP}};
})();
