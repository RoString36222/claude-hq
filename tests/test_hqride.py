"""The riding core (games/hqride.js, HQ 3.15 transport revamp plan 3.5 / 5.5).

node loads hqride.js (and world.js for station names) against a stub `window` and runs the scenarios on fake
Services with exact timetables: the planner picks the fastest, keeps the change minimum and the underground add,
caps the options at 3 and plans an Island Link leg to a world; the session advances by time (walk, wait, board,
seated, alight, done), picks seats by the rules (window on the pavement side, any seat, standing at the rail),
alights early on request and gives a level, still seat camera under Calm; station names are unique and
deterministic on the @2 fixture; the announcer never uses a non-local voice; tickets and achievements persist
through a fake localStorage and survive a throwing one. Skipped when node is not installed. Stdlib only."""
import json
import math
import os
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")

HARNESS = r"""
var fs = require("fs"), zlib = require("zlib"), root = %(root)s;
var store = {}, LS = {getItem: function(k){ return k in store ? store[k] : null; }, setItem: function(k, v){ store[k] = String(v); }, removeItem: function(k){ delete store[k]; }};
global.window = {HQV: {}, localStorage: LS};
function load(f){ new Function(fs.readFileSync(root + "/games/" + f, "utf8"))(); }
load("world.js"); load("hqride.js");
var R = window.HQV.hqRide, out = {};
var S = 1000, T0 = 1700000000000 - (1700000000000 %% 3600000);

// ---- fake Services: lines along stops, a vehicle leaves the first stop every headway (from offset), hop s per stop ----
function makeSvc(mode, defs, lineDefs){
  var stops = defs.map(function(d){ return {id: d.id, name: d.name || d.id, x: d.x, y: 0, z: d.z, mode: mode, lines: [], kind: "stop", under: !!d.under}; });
  var byId = {}; stops.forEach(function(s){ byId[s.id] = s; });
  lineDefs.forEach(function(L){ L.stops.forEach(function(id){ byId[id].lines.push(L.id); }); });
  function trip(lineId, from, to, ms){
    var L = lineDefs.filter(function(l){ return l.id === lineId; })[0]; if(!L) return null;
    var i = L.stops.indexOf(from), j = L.stops.indexOf(to); if(i < 0 || j <= i) return null;
    var dwell = 20*S, k = Math.max(0, Math.ceil((ms - T0 - L.offset*S - i*L.hop*S - dwell)/(L.headway*S)));
    var dep0 = T0 + L.offset*S + k*L.headway*S, arrive = dep0 + i*L.hop*S, depart = arrive + dwell, reach = dep0 + j*L.hop*S;
    var A = byId[from], B = byId[to], yaw = Math.atan2(B.x - A.x, B.z - A.z), fx = Math.sin(yaw), fz = Math.cos(yaw), rx = -Math.cos(yaw), rz = Math.sin(yaw);
    var st = []; for(var q = i; q <= j; q++) st.push({id: L.stops[q], name: byId[L.stops[q]].name, at: dep0 + q*L.hop*S});
    function pose(ms){
      var u = ms <= depart ? 0 : ms >= reach ? 1 : (ms - depart)/(reach - depart);
      var moving = ms > depart && ms < reach;
      return {x: A.x + (B.x - A.x)*u, y: 0, z: A.z + (B.z - A.z)*u, yaw: yaw, pitch: 0, speed: moving ? 10 : 0,
              doors: ms >= arrive && ms <= depart ? 1 : 0, under: !!(L.under && moving && u > 0.3 && u < 0.7), done: ms >= reach};
    }
    var LAT = [0.9, 0.4, -0.4, -0.9];
    return {mode: mode, line: L.id, short: L.short, vehicle: L.id + ":" + k, from: from, to: to, fromName: A.name, toName: B.name,
            arrive: arrive, depart: depart, reach: reach, stops: st, seats: 8, standing: 4, world: L.world,
            pose: pose,
            seat: function(n, ms){ var p = pose(ms), lat = n < 8 ? LAT[n %% 4] : 0, f = n < 8 ? (n >> 2)*1.0 : (n - 8)*0.8;
              return {x: p.x + rx*lat + fx*f, y: 0.45, z: p.z + rz*lat + fz*f, yaw: yaw}; },
            door: function(ms){ var p = pose(ms); return {x: p.x + rx*1.3, z: p.z + rz*1.3}; }};
  }
  return {mode: mode,
    lines: function(){ return lineDefs.map(function(L){ return {id: L.id, mode: mode, name: L.id, short: L.short, color: "#ff0000", stops: L.stops.slice(), headway: L.headway, loop: false, world: L.world}; }); },
    stops: function(){ return stops; },
    stopsNear: function(x, z, r){ return stops.map(function(s){ return {id: s.id, name: s.name, dist: Math.hypot(s.x - x, s.z - z), mode: mode, lines: s.lines}; })
      .filter(function(s){ return s.dist <= r; }).sort(function(a, b){ return a.dist - b.dist || (a.id < b.id ? -1 : 1); }); },
    departures: function(){ return []; }, trip: trip, vehicles: function(){ return []; }};
}
var tram = makeSvc("tram", [{id: "a0", x: 0, z: 0}, {id: "a1", x: 500, z: 0}, {id: "a2", x: 1000, z: 0}, {id: "a3", x: 2000, z: 0}],
                   [{id: "T1", short: "T1", stops: ["a0", "a1", "a2", "a3"], headway: 300, offset: 0, hop: 100}]);
var metro = makeSvc("metro", [{id: "m0", x: 0, z: 100, under: true}, {id: "m1", x: 2000, z: 100, under: true}],
                    [{id: "M1", short: "M1", stops: ["m0", "m1"], headway: 120, offset: 30, hop: 150, under: true}]);
var bus = makeSvc("bus", [{id: "b0", x: 500, z: 50}, {id: "b1", x: 2000, z: 50}],
                  [{id: "B1", short: "B1", stops: ["b0", "b1"], headway: 600, offset: 130, hop: 200}]);
var link = makeSvc("link", [{id: "c0", x: 0, z: -50}, {id: "c1", x: 9000, z: -50}],
                   [{id: "IL", short: "IL", stops: ["c0", "c1"], headway: 300, offset: 60, hop: 400, world: "claude-hq@3"}]);
[tram, metro, bus, link].forEach(R.register);
out.services = R.services().map(function(s){ return s.mode; });
out.near = R.stopsNear(0, 0, 120).map(function(s){ return [s.id, Math.round(s.dist), s.mode]; });
R.register(makeSvc("tram", [], [])); out.replaced = R.services().length; R.register(tram);

function brief(p){ return {reach: (p.reach - T0)/S, depart: (p.depart - T0)/S, changes: p.changes, sig: p.sig, world: p.world || null,
  legs: p.legs.map(function(l){ return l.mode === "walk" ? ["walk", l.secs] : [l.mode, l.line, l.from, l.to, (l.depart - T0)/S, (l.reach - T0)/S]; })}; }
out.plan = R.plan({x: 0, z: 0}, {x: 2000, z: 0}, T0).map(brief);
out.planChange = R.plan({stop: "a0"}, {x: 2000, z: 50}, T0, {modes: ["tram", "bus"]}).map(brief);
out.planLater = R.plan({x: 0, z: 0}, {x: 2000, z: 0}, T0 + 30*S).map(brief);
out.planWorld = R.plan({x: 0, z: 0}, {world: "claude-hq@3"}, T0).map(brief);
out.planNone = R.plan({x: 50000, z: 0}, {x: 2000, z: 0}, T0).length;
out.planToStop = R.plan({x: 0, z: 0}, {stop: "m1"}, T0, {modes: ["metro"]}).map(brief);

// ---- the session ----
var C = {occ: null}; window.HQV.hqCommute = {occupied: function(){ return C.occ || {seats: [], standing: []}; }};
function ride(o){
  var said = [], ended = [], under = [], travel = [];
  var t = o.trip || tram.trip("T1", "a0", "a2", T0);
  var s = R.session({trip: t, announce: function(x){ said.push(x); }, calm: function(){ return o.calm !== false; },
    me: function(){ return o.me || {x: 0, z: 0}; }, onEnd: function(r){ ended.push(r); }, sfx: function(){},
    under: function(on){ under.push(on); }, travel: function(tr){ travel.push(tr.world); }});
  return {s: s, t: t, said: said, ended: ended, under: under, travel: travel};
}
C.occ = null;
var r1 = ride({}), ph = [];
[[-60, null], [0, null], [0.6, "carry"], [1.3, "carry"], [50, null], [105, null], [200, null], [200.6, "carry"], [201.3, null]].forEach(function(st){
  var ms = T0 + st[0]*S; r1.s.step(ms);
  var e = [st[0], r1.s.phase];
  if(st[1]){ var c = r1.s.carry(ms); e.push(c ? c.anim : null, c && c.hands || null); }
  ph.push(e);
});
out.session = {phases: ph, ended: r1.ended, said: r1.said};
// seat choice and the camera, Calm on
var r2 = ride({}); r2.s.step(T0 - 10*S); r2.s.step(T0); r2.s.step(T0 + 1.3*S);
var info2 = r2.s.info(T0 + 50*S), seatAt = r2.t.seat(info2.seat, T0 + 50*S), seatAt2 = r2.t.seat(info2.seat, T0 + 80*S);
var cA = r2.s.camPose(T0 + 50*S, {yaw: 0, pitch: 0}, "seat"), cB = r2.s.camPose(T0 + 80*S, {yaw: 0, pitch: 0}, "seat");
var cW = r2.s.camPose(T0 + 50*S, {yaw: 3, pitch: 2}, "seat");
out.calmCam = {seat: info2.seat, standing: info2.standing, upA: cA.up, upB: cB.up, fov: cA.fov,
  offA: [cA.pos.x - seatAt.x, cA.pos.y - seatAt.y, cA.pos.z - seatAt.z], offB: [cB.pos.x - seatAt2.x, cB.pos.y - seatAt2.y, cB.pos.z - seatAt2.z],
  lookYaw: Math.atan2(cW.look.x - cW.pos.x, cW.look.z - cW.pos.z), seatYaw: seatAt.yaw,
  lookPitch: Math.atan2(cW.look.y - cW.pos.y, Math.hypot(cW.look.x - cW.pos.x, cW.look.z - cW.pos.z)),
  window: r2.s.camPose(T0 + 50*S, {yaw: 0, pitch: 0}, "window"), chase: r2.s.camPose(T0 + 50*S, {yaw: 0, pitch: 0}, "chase")};
// Calm off: the camera sways while moving
var r3 = ride({calm: false}); r3.s.step(T0 - 10*S); r3.s.step(T0); r3.s.step(T0 + 1.3*S);
var i3 = r3.s.info(T0 + 50*S), d1 = r3.s.camPose(T0 + 50*S, {}, "seat"), d2 = r3.s.camPose(T0 + 50.7*S, {}, "seat");
var s1 = r3.t.seat(i3.seat, T0 + 50*S), s2 = r3.t.seat(i3.seat, T0 + 50.7*S);
out.swayCam = {up: d1.up, offA: [d1.pos.x - s1.x, d1.pos.y - s1.y, d1.pos.z - s1.z], offB: [d2.pos.x - s2.x, d2.pos.y - s2.y, d2.pos.z - s2.z]};
// seat rules
function pickWith(occ){ C.occ = occ; var r = ride({}); r.s.step(T0 - 10*S); r.s.step(T0); r.s.step(T0 + 1.3*S); var i = r.s.info(T0 + 2*S), c = r.s.carry(T0 + 2*S);
  return {phase: r.s.phase, seat: i.seat, standing: i.standing, spot: i.spot, anim: c && c.anim, hands: c && c.hands || null, cam: r.s.camPose(T0 + 50*S, {}, "seat"), carry: c}; }
out.seats = {free: pickWith({seats: [], standing: []}), win0: pickWith({seats: [0], standing: []}), wins: pickWith({seats: [0, 4], standing: []}),
             full: pickWith({seats: [0, 1, 2, 3, 4, 5, 6, 7], standing: []}), fuller: pickWith({seats: [0, 1, 2, 3, 4, 5, 6, 7], standing: [0]})};
var fs0 = out.seats.full, ff = tram.trip("T1", "a0", "a2", T0).seat(8, T0 + 50*S);
out.seats.standEye = fs0.cam.pos.y - ff.y;
C.occ = null;
// alight early, missed, cancel
var r4 = ride({}); r4.s.step(T0); r4.s.step(T0 + 1.3*S); r4.s.step(T0 + 30*S); r4.s.alightNext();
var to4 = r4.s.info().to; r4.s.step(T0 + 99*S); var p99 = r4.s.phase; r4.s.step(T0 + 100*S); var p100 = r4.s.phase; r4.s.step(T0 + 101.3*S);
out.early = {to: to4, p99: p99, p100: p100, end: r4.s.phase, ended: r4.ended};
var r5 = ride({me: {x: 300, z: 0}}); r5.s.step(T0 - 10*S); var walkPh = r5.s.phase; r5.s.step(T0 + 30*S);
out.missed = {walk: walkPh, end: r5.s.phase, ended: r5.ended};
var r6 = ride({}); r6.s.step(T0 - 10*S); r6.s.cancel(); out.cancel = {phase: r6.s.phase, ended: r6.ended, carry: r6.s.carry(T0)};
var r7 = ride({}); r7.s.step(T0); r7.s.step(T0 + 1.3*S); r7.s.step(T0 + 30*S); r7.s.requestStop(); out.request = r7.s.info();
// metro: under() follows the vehicle; link: handed to hqTravel at departure
var r8 = ride({trip: metro.trip("M1", "m0", "m1", T0), me: {x: 0, z: 100}}), t8 = r8.t;
for(var ms = t8.arrive - 5*S; ms <= t8.reach + 3*S; ms += 1*S) r8.s.step(ms);
out.metro = {under: r8.under, end: r8.s.phase, ended: r8.ended};
var r9 = ride({trip: link.trip("IL", "c0", "c1", T0), me: {x: 0, z: -50}}), t9 = r9.t;
for(ms = t9.arrive - 5*S; ms <= t9.depart + 5*S; ms += 1*S) r9.s.step(ms);
out.link = {travel: r9.travel, phase: r9.s.phase};

// ---- seatCam, pure ----
var sp = {x: 10, y: 1, z: 5, yaw: 0.3}, vp = {x: 10, y: 0.5, z: 4, yaw: 0.3, speed: 15, accel: -1.2};
out.seatCam = {calm: [R.seatCam(sp, vp, {yaw: 0, pitch: 0}, "seat", true, {t: 1000}), R.seatCam(sp, vp, {yaw: 0, pitch: 0}, "seat", true, {t: 9000})],
               moving: [R.seatCam(sp, vp, {}, "seat", false, {t: 1000}), R.seatCam(sp, vp, {}, "seat", false, {t: 9000})],
               stand: R.seatCam(sp, vp, {}, "seat", true, {standing: true})};

// ---- station names on the @2 fixture ----
function names(order){
  var doc = JSON.parse(zlib.gunzipSync(fs.readFileSync(root + "/tests/fixtures/claude-hq@2.json.gz")));
  var W = window.HQV.world.pack(doc), sites = W.sites.filter(function(s){ return s.kind === "busstop" || s.kind === "tramstop" || s.kind === "transit" || s.kind === "port"; });
  if(order < 0) sites = sites.slice().reverse();
  return sites.map(function(s){ return {id: s.id, x: s.x/100, z: s.z/100, name: R.stationName(W, s.x/100, s.z/100, "stop")}; });
}
var N1 = names(1), N2 = names(1), N3 = names(-1);
var again = (function(){ var doc = JSON.parse(zlib.gunzipSync(fs.readFileSync(root + "/tests/fixtures/claude-hq@2.json.gz"))), W = window.HQV.world.pack(doc);
  var a = R.stationName(W, 0, 0, "stop"), b = R.stationName(W, 0.5, 0.5, "stop"); return [a, b]; })();
var bare = R.stationName({id: "w", sites: [{id: "p", kind: "port", x: 0, z: 0}], edges: []}, 5, 5, "pier");
var byId = {}; N1.forEach(function(r){ byId[r.id] = r.name; });
out.names = {n1: N1, same: JSON.stringify(N1) === JSON.stringify(N2), reverseSame: N3.every(function(r){ return byId[r.id] === r.name; }), again: again, bare: bare};

// ---- board text ----
var D = new Date(T0 + 45*60*S);
out.due = {boarding: R.dueText(T0 + 10*S, T0, true), due: R.dueText(T0 + 30*S, T0, false), min: R.dueText(T0 + 5.5*60*S, T0, false),
           clock: R.dueText(T0 + 45*60*S, T0, false), hhmm: (D.getHours() < 10 ? "0" : "") + D.getHours() + ":" + (D.getMinutes() < 10 ? "0" : "") + D.getMinutes(),
           rows: R.boardRows([{short: "T1", to: "Harbour", at: T0 + 120*S, boarding: false, delay: 0, plat: "1"}, {short: "M2", to: "Central", at: T0, boarding: true},
                              {short: "T2", to: "Park", at: T0 + 300*S, delay: 180}, {short: "B", to: "X", at: T0}, {short: "C", to: "Y", at: T0}], T0),
           noCanvas: R.boardTexture({}, [], {})};

// ---- boards: a shared atlas within 150 m, redrawn at most every 5 s ----
var draws = 0;
window.document = {createElement: function(){ return {width: 0, height: 0, getContext: function(){
  var g = {}; ["fillRect", "strokeRect", "fillText"].forEach(function(k){ g[k] = function(){ if(k === "fillText") draws++; }; }); return g; }}; }};
var FT = {CanvasTexture: function(cv){ this.image = cv; this.needsUpdate = false; }, SRGBColorSpace: "srgb"};
var b1 = R.boardTexture(FT, [{badge: "T1", dest: "Harbour", due: "2 min"}], {at: {x: 0, z: 0}, ms: T0});
var b2 = R.boardTexture(FT, [], {at: {x: 100, z: 0}, ms: T0}), b3 = R.boardTexture(FT, [], {at: {x: 400, z: 0}, ms: T0});
var d0 = draws, r1 = b1.draw([{badge: "T1", dest: "Harbour", due: "1 min"}], T0 + 2*S), r2 = b1.draw([{badge: "T1", dest: "Harbour", due: "due"}], T0 + 5.5*S);
var uvGeo = {attributes: {uv: {count: 2, ys: [0, 1], getY: function(i){ return this.ys[i]; }, setY: function(i, v){ this.ys[i] = v; }}}};
b2.applyUv(uvGeo);
out.board = {shared: b1.texture === b2.texture, far: b1.texture !== b3.texture, slots: [b1.slot, b2.slot, b3.slot], early: r1, late: r2, drew: draws > d0, uv: uvGeo.attributes.uv.ys, v: [b2.uv.v0, b2.uv.v1]};
delete window.document;

// ---- the announcer: local voices only ----
function synth(voices){ var spoken = []; return {spoken: spoken, getVoices: function(){ return voices; }, speak: function(u){ spoken.push({text: u.text, voice: u.voice && u.voice.name}); }}; }
function U(text){ this.text = text; }
var remote = {name: "Cloud", lang: "en-US", localService: false}, local = {name: "Local", lang: "en-GB", localService: true}, fr = {name: "Fr", lang: "fr-FR", localService: true};
var sA = synth([remote, fr, local]), annA = [], A1 = R.announcer({announce: function(t){ annA.push(t); }, synth: sA, Utterance: U, calm: function(){ return true; }});
var resA = A1.say("Next stop: Harbour Street.");
var sB = synth([remote]), annB = [], A2 = R.announcer({announce: function(t){ annB.push(t); }, synth: sB, Utterance: U, calm: function(){ return true; }});
var resB = A2.say("Next stop: Harbour Street.");
var sC = synth([local]), A3 = R.announcer({announce: function(){}, synth: sC, Utterance: U, voiceOn: function(){ return false; }});
A3.say("Quiet.");
// chime: a fake audio context; under Calm no chime; otherwise the chime plays and speech waits for it
function fakeCtx(){
  var made = {n: 0};
  function P(){ return {value: 0, setValueAtTime: function(){}, exponentialRampToValueAtTime: function(){}, linearRampToValueAtTime: function(){}, setTargetAtTime: function(){}}; }
  function node(extra){ made.n++; var o = {connect: function(){}, disconnect: function(){}, start: function(){}, stop: function(){}}; for(var k in extra) o[k] = extra[k]; return o; }
  return {made: made, currentTime: 0, sampleRate: 8000, destination: {},
    createGain: function(){ return node({gain: P()}); }, createOscillator: function(){ return node({type: "", frequency: P()}); },
    createBiquadFilter: function(){ return node({type: "", frequency: P(), Q: P()}); },
    createBuffer: function(c, n){ var d = new Float32Array(n); return {getChannelData: function(){ return d; }}; },
    createBufferSource: function(){ return node({buffer: null, loop: false, playbackRate: P()}); }};
}
var ctx = fakeCtx(), later = [], sD = synth([local]);
var A4 = R.announcer({announce: function(){}, synth: sD, Utterance: U, calm: function(){ return false; }, audio: function(){ return ctx; }, later: function(f){ later.push(f); }});
var resD = A4.say("Mind the gap."); var spokenBefore = sD.spoken.length; later.forEach(function(f){ f(); });
var ctx2 = fakeCtx(), A5 = R.announcer({announce: function(){}, synth: synth([local]), Utterance: U, calm: function(){ return true; }, audio: function(){ return ctx2; }});
A5.say("Calm.");
out.voice = {a: sA.spoken, annA: annA, resA: resA, b: sB.spoken, annB: annB, resB: resB, off: sC.spoken.length, chimeRes: resD, before: spokenBefore, after: sD.spoken,
             calmNodes: ctx2.made.n, pick: R.localVoice([remote, fr, local]).name, none: R.localVoice([remote])};
// every sound builds on a context, and mute / no context give nothing
var sounds = {}; R.SFX.forEach(function(n){ var c = fakeCtx(), h = R.sfx(c, n, {gain: 0.5, speed: 10}); if(h){ h.set({speed: 20}); h.stop(); } sounds[n] = [!!h, c.made.n]; });
// a loop is ONE voice per context and name: asked for again it is refreshed (no new nodes), {stop: true}
// ends it, and one nobody refreshes ends by itself (the metro asked for a new "motor" every 0.5 s, never stopped one)
var lc = fakeCtx(), l1 = R.sfx(lc, "motor", {speed: 0.5}), ln = lc.made.n, same = true;
for(var li = 0; li < 20; li++){ lc.currentTime += 0.5; if(R.sfx(lc, "motor", {speed: 0.6}) !== l1) same = false; }
var aliveFed = l1.alive(), madeFed = lc.made.n - ln;
lc.currentTime += 5; var aliveLeft = l1.alive(), l2 = R.sfx(lc, "motor", {speed: 0.6});
var l3 = R.sfx(lc, "rotor", {gain: 0.4}), st = R.sfx(lc, "rotor", {stop: true});
out.loops = {same: same, aliveFed: aliveFed, madeFed: madeFed, aliveLeft: aliveLeft, fresh: !!l2 && l2 !== l1, stopNull: st === null, rotorDead: !l3.alive()};
out.sfx = {sounds: sounds, mute: R.sfx(fakeCtx(), "door-chime", {mute: true}), noCtx: R.sfx(null, "door-chime"), unknown: R.sfx(fakeCtx(), "explosion"), zero: R.sfx(fakeCtx(), "ring", {gain: 0})};

// ---- tickets and achievements: persisted, and surviving a throwing localStorage ----
out.sessionAch = R.achievements.list().filter(function(a){ return a.done; }).map(function(a){ return a.id; }).sort();
R.achievements.reset();
var tk = []; for(var n = 0; n < 34; n++) tk.push(R.tickets.add({mode: "tram", line: "T1", from: "a0", to: "a2", depart: T0 + n*S, made: T0 + n*S, evil: "<script>"}));
var list1 = R.tickets.list();
var unlocked = []; R.achievements.onUnlock(function(a){ unlocked.push(a.id); });
var g1 = R.achievements.record({type: "ride", mode: "tram", line: "T1", city: "c", cityLines: ["T1", "M1"], hour: 8, standing: true});
var g2 = R.achievements.record({type: "ride", mode: "metro", line: "M1", city: "c", cityLines: ["T1", "M1"], hour: 2, endToEnd: true});
for(n = 0; n < 10; n++) R.achievements.record({type: "fare", stars: n === 3 ? 5 : 4});
R.achievements.record({type: "heli"}); R.achievements.record({type: "heli"});
R.achievements.record({type: "ride", mode: "link", line: "IL", linkDir: "out"});
var hop1 = R.achievements.list().filter(function(a){ return a.id === "island-hopper"; })[0].progress;
R.achievements.record({type: "ride", mode: "link", line: "IL", linkDir: "back"});
var stored = JSON.parse(store.hq_ride_achv), storedT = JSON.parse(store.hq_ride_tickets);
// a fresh module over the same storage sees them
load("hqride.js"); var R2 = window.HQV.hqRide;
var persisted = {tickets: R2.tickets.list().length, newest: R2.tickets.list()[0].depart, done: R2.achievements.list().filter(function(a){ return a.done; }).map(function(a){ return a.id; }).sort()};
// a throwing localStorage
window.localStorage = {getItem: function(){ throw new Error("denied"); }, setItem: function(){ throw new Error("denied"); }};
load("hqride.js"); var R3 = window.HQV.hqRide, thrown = null, t3, l3, a3;
try { t3 = R3.tickets.add({mode: "bus", line: "B1", from: "b0", to: "b1", depart: T0, made: T0}); l3 = R3.tickets.list(); R3.tickets.remove(t3.id);
      a3 = R3.achievements.record({type: "heli"}); } catch(e){ thrown = String(e); }
Object.defineProperty(window, "localStorage", {get: function(){ throw new Error("SecurityError"); }, configurable: true});
var t4 = null; try { load("hqride.js"); t4 = window.HQV.hqRide.tickets.add({mode: "bus", made: T0}); window.HQV.hqRide.tickets.list(); } catch(e){ thrown = String(e); }
out.store = {n: list1.length, newest: (list1[0].depart - T0)/S, oldest: (list1[list1.length - 1].depart - T0)/S, ids: list1.map(function(t){ return t.id; }).length,
  uniqueIds: Object.keys(list1.reduce(function(o, t){ o[t.id] = 1; return o; }, {})).length, kind: list1[0].kind, evil: "evil" in list1[0],
  g1: g1, g2: g2, unlocked: unlocked, hop1: hop1, list: R.achievements.list(), stats: R.achievements.stats(), storedFares: stored.fares, storedTickets: storedT.length,
  persisted: persisted, thrown: thrown, l3: l3 && l3.length, a3: a3, t4: !!(t4 && t4.id),
  removed: R.tickets.remove(list1[0].id), afterRemove: R.tickets.list().length};
console.log(JSON.stringify(out));
"""


@unittest.skipUnless(NODE, "node is not installed")
class HqRideTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        js = HARNESS % {"root": json.dumps(ROOT)}
        env = dict(os.environ, TZ="UTC")
        p = subprocess.run([NODE, "-e", js], capture_output=True, text=True, timeout=120, env=env)
        if p.returncode != 0:
            raise AssertionError("node failed:\n" + p.stderr[-4000:])
        cls.r = json.loads(p.stdout.strip().splitlines()[-1])

    def close(self, a, b, tol=1e-6, msg=None):
        self.assertLessEqual(abs(a - b), tol, msg or "%r != %r" % (a, b))

    # ---- registry ----
    def test_registry(self):
        r = self.r
        self.assertEqual(r["services"], ["tram", "metro", "bus", "link"])
        self.assertEqual(r["replaced"], 4)                         # one service per mode: re-registering replaces
        self.assertEqual(r["near"][0], ["a0", 0, "tram"])
        self.assertEqual([n[0] for n in r["near"]], ["a0", "c0", "m0"])

    # ---- the planner ----
    def test_planner_fastest_first_and_capped(self):
        p = self.r["plan"]
        self.assertEqual(len(p), 3)                                # at most 3 options
        reaches = [o["reach"] for o in p]
        self.assertEqual(reaches, sorted(reaches))
        # the tram: no walk, leaves a0 at T0+20 s (20 s dwell), reaches a3 at 300 s, the target is at a3
        self.assertEqual(p[0]["sig"], "tram:T1")
        self.assertEqual(p[0]["legs"], [["tram", "T1", "a0", "a3", 20, 300]])
        self.close(p[0]["reach"], 300, 0.001)
        # the metro: walk 100 m (71.4 s) + 45 s down = 116.4 s, so the 170 s train (not the 50 s one); +45 s up, walk 100 m
        self.assertEqual(p[1]["sig"], "metro:M1")
        self.assertEqual(p[1]["legs"][1][4], 170)
        self.close(p[1]["reach"], 300 + 45 + 100 / 1.4, 0.002)
        self.assertEqual(p[1]["legs"][0], ["walk", 71])
        self.assertEqual(p[1]["changes"], 0)

    def test_planner_change_minimum(self):
        p = self.r["planChange"]
        sigs = [o["sig"] for o in p]
        self.assertIn("tram:T1>bus:B1", sigs)
        two = p[sigs.index("tram:T1>bus:B1")]
        self.assertEqual(two["changes"], 1)
        # the tram reaches a1 at 100 s; the walk to b0 is 50 m (36 s) but a change takes 60 s: the 150 s bus is gone
        legs = two["legs"]
        self.assertEqual(legs[0][:4], ["tram", "T1", "a0", "a1"])
        self.assertEqual(legs[1], ["walk", 36])
        self.assertEqual(legs[2][:4], ["bus", "B1", "b0", "b1"])
        self.assertEqual(legs[2][4], 750)
        # T1 direct to a3 and a 50 m walk is faster: first
        self.assertEqual(p[0]["sig"], "tram:T1")

    def test_planner_later_start_and_none(self):
        p = self.r["planLater"]
        # from T0 + 30 s the 20 s tram is gone: the next leaves at 320 s
        tram = [o for o in p if o["sig"] == "tram:T1"][0]
        self.assertEqual(tram["legs"][0][4], 320)
        self.assertEqual(self.r["planNone"], 0)
        ts = self.r["planToStop"]
        self.assertEqual(len(ts), 1)
        self.assertEqual(ts[0]["legs"][-1][:4], ["metro", "M1", "m0", "m1"])
        self.close(ts[0]["reach"], 300, 0.001)                     # arriving at the stop itself: no tail

    def test_planner_link_to_a_world(self):
        p = self.r["planWorld"]
        self.assertTrue(p)
        self.assertEqual(p[0]["world"], "claude-hq@3")
        self.assertEqual(p[0]["legs"][-1][:4], ["link", "IL", "c0", "c1"])

    # ---- the session ----
    def test_session_phases_advance_by_time(self):
        s = self.r["session"]
        want = [[-60, "wait"], [0, "board"], [0.6, "board", "walk", None], [1.3, "seated", "sit", None], [50, "seated"],
                [105, "seated"], [200, "alight"], [200.6, "alight", "walk", None], [201.3, "done"]]
        self.assertEqual(s["phases"], want)
        self.assertEqual(s["ended"], ["done"])
        said = " | ".join(s["said"])
        self.assertIn("arriving, doors open", said)
        self.assertIn("Next stop: a2. This is your stop.", said)
        self.assertNotIn("coins", said.lower())                    # D4: free
        self.assertNotIn("fare", said.lower())

    def test_seat_choice(self):
        s = self.r["seats"]
        self.assertEqual((s["free"]["phase"], s["free"]["seat"]), ("seated", 0))     # window seat, pavement (right) side
        self.assertEqual(s["win0"]["seat"], 4)                                       # the next pavement window seat
        self.assertEqual(s["wins"]["seat"], 1)                                       # no window: any free seat
        self.assertEqual(s["free"]["anim"], "sit")
        full = s["full"]
        self.assertEqual((full["phase"], full["standing"], full["spot"], full["anim"], full["hands"]), ("standing", True, 0, "stand", "rail"))
        self.assertIsNone(full["seat"])
        self.assertEqual(s["fuller"]["spot"], 1)
        self.close(s["standEye"], 1.62, 1e-9)

    def test_calm_camera_level_and_still(self):
        c = self.r["calmCam"]
        self.assertEqual(c["upA"], {"x": 0, "y": 1, "z": 0})
        self.assertEqual(c["upB"], {"x": 0, "y": 1, "z": 0})
        self.assertEqual(c["fov"], 70)
        for off in (c["offA"], c["offB"]):
            self.close(off[0], 0, 1e-9)
            self.close(off[1], 1.15, 1e-9)
            self.close(off[2], 0, 1e-9)
        # the look is clamped to +-150 deg yaw, +-50 deg pitch
        d = (c["lookYaw"] - c["seatYaw"] - math.radians(150) + math.pi) % (2 * math.pi) - math.pi
        self.close(d, 0, 1e-6)
        self.close(c["lookPitch"], math.radians(50), 1e-6)
        self.assertEqual(c["window"]["up"], {"x": 0, "y": 1, "z": 0})
        self.assertEqual(c["chase"]["up"], {"x": 0, "y": 1, "z": 0})
        self.assertGreater(c["chase"]["pos"]["y"], 5)

    def test_motion_only_without_calm(self):
        m = self.r["swayCam"]
        self.assertNotEqual(m["offA"], m["offB"])
        sc = self.r["seatCam"]
        self.assertEqual(sc["calm"][0]["pos"], sc["calm"][1]["pos"])
        self.assertEqual(sc["calm"][0]["up"], {"x": 0, "y": 1, "z": 0})
        self.assertNotEqual(sc["moving"][0]["pos"], sc["moving"][1]["pos"])
        self.assertLess(abs(sc["moving"][0]["pos"]["y"] - 2.15), 0.02)     # tiny
        self.close(sc["stand"]["pos"]["y"], 1 + 1.62, 1e-9)

    def test_alight_early_missed_cancel(self):
        e = self.r["early"]
        self.assertEqual(e["to"], "a1")
        self.assertEqual((e["p99"], e["p100"], e["end"]), ("seated", "alight", "done"))
        self.assertEqual(self.r["missed"], {"walk": "walk", "end": "cancelled", "ended": ["missed"]})
        self.assertEqual(self.r["cancel"], {"phase": "cancelled", "ended": ["cancelled"], "carry": None})
        self.assertTrue(self.r["request"]["stopRequested"])
        self.assertEqual(self.r["request"]["to"], "a1")

    def test_session_records_the_ride(self):
        # the metro ride m0 -> m1 is the whole of M1: Mole, recorded when the session ends
        self.assertIn("mole", self.r["sessionAch"])

    def test_metro_under_and_link_travel(self):
        m = self.r["metro"]
        self.assertEqual(m["under"], [True, False])
        self.assertEqual((m["end"], m["ended"]), ("done", ["done"]))
        self.assertEqual(self.r["link"]["travel"], ["claude-hq@3"])

    # ---- station names ----
    def test_station_names_unique_and_deterministic(self):
        n = self.r["names"]
        self.assertTrue(n["same"])
        rows = n["n1"]
        self.assertGreater(len(rows), 20)
        for i, a in enumerate(rows):
            self.assertTrue(a["name"])
            for b in rows[i + 1:]:
                if a["name"] == b["name"]:     # one name means one place (stops in one 120 m piece of a road share it)
                    self.assertLessEqual(math.hypot(a["x"] - b["x"], a["z"] - b["z"]), 120 + 2 * 90, (a, b))
        self.assertTrue(n["reverseSame"])      # independent of the order modules ask in
        self.assertGreater(len({a["name"] for a in rows}), len(rows) // 2)
        # memoised per world: a point within 30 m gets the same name
        self.assertEqual(n["again"][0], n["again"][1])
        self.assertIn(n["bare"].split(" ")[0], ("Harbour",))
        self.assertIn(n["bare"].split(" ")[1], ("Street", "Square", "Gate", "Park"))

    # ---- boards ----
    def test_board_text(self):
        d = self.r["due"]
        self.assertEqual(d["boarding"], "boarding")
        self.assertEqual(d["due"], "due")
        self.assertEqual(d["min"], "5 min")
        self.assertEqual(d["clock"], d["hhmm"])
        self.assertEqual(len(d["rows"]), 4)
        self.assertEqual(d["rows"][0], {"badge": "T1", "dest": "Harbour", "due": "2 min", "plat": "1"})
        self.assertEqual(d["rows"][1]["due"], "boarding")
        self.assertEqual(d["rows"][2]["due"], "delayed +3 min")
        self.assertIsNone(d["noCanvas"])

    def test_board_atlas(self):
        b = self.r["board"]
        self.assertTrue(b["shared"])                                # boards within 150 m share one canvas
        self.assertTrue(b["far"])
        self.assertEqual(b["slots"], [0, 1, 0])
        self.assertFalse(b["early"])                                # at most every 5 s
        self.assertTrue(b["late"])
        self.assertTrue(b["drew"])
        self.assertEqual(b["uv"], b["v"])

    def test_source_rules(self):
        for f in ("hqride.js", "hqcommute.js"):
            with open(os.path.join(ROOT, "games", f), encoding="utf-8") as fh:
                src = fh.read()
            self.assertNotIn("Math.random", src, f)
            self.assertNotIn("innerHTML", src, f)
            self.assertNotRegex(src, r"https?://", f)
            self.assertNotIn("coins", src, f)                      # D4: everything is free

    # ---- voice ----
    def test_announcer_only_local_voices(self):
        v = self.r["voice"]
        self.assertEqual(v["a"], [{"text": "Next stop: Harbour Street.", "voice": "Local"}])    # en local, not the cloud one
        self.assertEqual(v["annA"], ["Next stop: Harbour Street."])
        self.assertEqual(v["b"], [])                                   # only a network voice: text only
        self.assertEqual(v["annB"], ["Next stop: Harbour Street."])
        self.assertFalse(v["resB"]["voice"])
        self.assertEqual(v["off"], 0)                                  # voice off in settings
        self.assertEqual(v["pick"], "Local")
        self.assertIsNone(v["none"])
        # the chime plays first (not under Calm), then the voice
        self.assertTrue(v["chimeRes"]["chime"])
        self.assertEqual(v["before"], 0)
        self.assertEqual(len(v["after"]), 1)
        self.assertEqual(v["calmNodes"], 0)

    def test_sfx(self):
        s = self.r["sfx"]
        for name, (ok, nodes) in s["sounds"].items():
            self.assertTrue(ok, name)
            self.assertGreater(nodes, 1, name)
        for want in ("door-chime", "door-hiss", "validator", "stop-bell", "tram-bell", "air-brake", "motor", "rail-joint",
                     "tunnel-rumble", "gondola-clunk", "ferry-horn", "indicator", "rotor", "ring", "dial", "shutter"):
            self.assertIn(want, s["sounds"])
        self.assertIsNone(s["mute"])
        self.assertIsNone(s["noCtx"])
        self.assertIsNone(s["unknown"])
        self.assertIsNone(s["zero"])

    def test_loops_cannot_pile_up(self):
        L = self.r["loops"]
        self.assertTrue(L["same"])                 # asked again: the same live voice
        self.assertEqual(L["madeFed"], 0)          # 20 asks, no new nodes
        self.assertTrue(L["aliveFed"])
        self.assertFalse(L["aliveLeft"])           # nobody asked for 5 s: gone by itself
        self.assertTrue(L["fresh"])
        self.assertTrue(L["stopNull"])
        self.assertTrue(L["rotorDead"])            # {stop: true} ends the live one

    # ---- tickets, achievements ----
    def test_tickets_persist_newest_30(self):
        s = self.r["store"]
        self.assertEqual(s["n"], 30)
        self.assertEqual((s["newest"], s["oldest"]), (33, 4))
        self.assertEqual(s["uniqueIds"], 30)
        self.assertEqual(s["kind"], "ticket")
        self.assertFalse(s["evil"])                                    # only the known fields are kept
        self.assertEqual(s["storedTickets"], 30)
        self.assertEqual(s["persisted"]["tickets"], 30)
        self.assertEqual(s["persisted"]["newest"], self.r["store"]["newest"] * 1000 + 1700000000000 - (1700000000000 % 3600000))
        self.assertTrue(s["removed"])
        self.assertEqual(s["afterRemove"], 29)

    def test_achievements(self):
        s = self.r["store"]
        self.assertEqual(s["g1"], ["rush-hour"])
        self.assertEqual(sorted(s["g2"]), ["line-collector", "mole", "night-owl"])
        done = {a["id"] for a in s["list"] if a["done"]}
        self.assertEqual(done, {"rush-hour", "line-collector", "mole", "night-owl", "cabbie", "five-stars", "high-flyer", "island-hopper"})
        self.assertEqual(s["unlocked"].count("high-flyer"), 1)        # once
        self.assertEqual(s["hop1"], 0.5)
        aa = [a for a in s["list"] if a["id"] == "all-aboard"][0]
        self.assertFalse(aa["done"])
        self.close(aa["progress"], 3 / 8)
        self.assertEqual(len(s["list"]), 10)
        self.assertEqual(s["stats"]["fares"], 10)
        self.assertEqual(s["storedFares"], 10)
        self.assertEqual(s["persisted"]["done"], sorted(done))

    def test_throwing_storage(self):
        s = self.r["store"]
        self.assertIsNone(s["thrown"])
        self.assertEqual(s["l3"], 1)                                   # kept in memory for the session
        self.assertEqual(s["a3"], ["high-flyer"])
        self.assertTrue(s["t4"])


if __name__ == "__main__":
    unittest.main()
