/* Valley: Kart Racing. Arcade cars on tile-built tracks, made from Kenney's CC0 Starter
 * Kit Racing models, solo time trials or races of up to 8 in an Arena room.
 *
 * Rendering is the vendored three.js r186 (games/vendor/), imported only when this game
 * opens; without WebGL2 the same race runs as a top-down map. The car handling is an
 * original re-implementation in the spirit of the kit's (no Godot code is used).
 *
 * Multiplayer: you drive your own car here and send where it is ~20 times a second
 * (x, z in cm, yaw, speed, your clock); the Arena server (backend/app/kart.py) runs a
 * 15 Hz tick that checks every frame (on the road, not faster than a car, laps in order),
 * keeps the standings and sends one snapshot per tick. Other cars are drawn ~100 ms in
 * the past from those snapshots (plus measured jitter), extrapolated briefly across gaps.
 * A frame the server refuses comes back as a "fix" and your car is put back. Only these
 * numbers, a car id and your lap travel; nothing transcript-derived.
 *
 * The KART-TRACK block mirrors backend/app/kart.py (tests/test_kart_sync.py checks both
 * against each other under node).
 */
(function(){
"use strict";
var HQV = window.HQV; if(!HQV || !HQV.api || !HQV.engine) return;
// Shared helpers, three.js loading and snapshot timing: games/engine.js.
var E = HQV.engine;
var now = E.now, clamp = E.clamp, hex = E.hex, angLerp = E.angLerp, calm = E.calm, say = E.say,
    tokens = E.tokens, myClock = E.myClock, hasWebGL2 = E.hasWebGL2, fmt = E.fmtTime;
var api = HQV.api, MP = HQV.mp || null;

/* KART-TRACK BEGIN */
var KT = (function(){
  // the kit's 10 m pieces drawn at SCALE 1.5 (15 m tiles, a 13.5 m road): room for 8 cars
  var SCALE = 1.5, TILE = 15, HALF = 7.5, ROAD_HALF = 6.75, R_IN = 0.75, R_MID = 7.5, R_OUT = 14.25;
  var DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]];
  function compileTrack(path){
    var col = 0, row = 0, d = 0, tiles = [], cells = {};
    for(var i = 0; i < path.length; i++){
      var ch = path.charAt(i), key = col+","+row;
      if("FSLR".indexOf(ch) < 0 || cells[key] != null) throw new Error("bad track at tile "+i);
      var o = ch === "R" ? (d + 1) % 4 : ch === "L" ? (d + 3) % 4 : d;
      var t = {col: col, row: row, kind: ch === "L" || ch === "R" ? "C" : ch, d: d, o: o};
      if(t.kind === "C"){ var e = DIRS[(d + 2) % 4], x = DIRS[o]; t.pivot = [(e[0] + x[0])*HALF, (e[1] + x[1])*HALF]; }
      cells[key] = i; tiles.push(t); d = o; col += DIRS[d][0]; row += DIRS[d][1];
    }
    if(col !== 0 || row !== 0 || d !== 0 || path.charAt(0) !== "F") throw new Error("track does not close on its start line");
    return {tiles: tiles, cells: cells, n: tiles.length};
  }
  function cellOf(v){ return Math.floor((v + HALF)/TILE); }
  // [tile index, 0..1 along it, metres off the centre line] or null off the track's tiles
  function locate(tr, x, z){
    var i = tr.cells[cellOf(x)+","+cellOf(z)];
    if(i == null) return null;
    var t = tr.tiles[i], lx = x - t.col*TILE, lz = z - t.row*TILE;
    if(t.kind !== "C"){
      var h = DIRS[t.d], along = lx*h[0] + lz*h[1], lat = lx*-h[1] + lz*h[0];
      return [i, Math.min(1, Math.max(0, (along + HALF)/TILE)), lat];
    }
    var vx = lx - t.pivot[0], vz = lz - t.pivot[1], r = Math.sqrt(vx*vx + vz*vz);
    var ax = -DIRS[t.o][0], az = -DIRS[t.o][1], ang = Math.abs(Math.atan2(ax*vz - az*vx, ax*vx + az*vz));
    return [i, Math.min(1, Math.max(0, ang/(Math.PI/2))), r - R_MID];
  }
  // [x, z, yaw degrees] at track distance u, lat metres right of the centre line
  function pointAt(tr, u, lat){
    lat = lat || 0;
    var n = tr.n, w = ((u % n) + n) % n, i = Math.min(n - 1, Math.floor(w)), s = w - i, t = tr.tiles[i];
    var cx = t.col*TILE, cz = t.row*TILE;
    if(t.kind !== "C"){
      var h = DIRS[t.d];
      return [cx + h[0]*(s*TILE - HALF) - h[1]*lat, cz + h[1]*(s*TILE - HALF) + h[0]*lat, ((Math.atan2(h[0], -h[1])*180/Math.PI) + 360) % 360];
    }
    var a0x = -DIRS[t.o][0], a0z = -DIRS[t.o][1], a1x = DIRS[t.d][0], a1z = DIRS[t.d][1], th = s*Math.PI/2;
    var turn = t.o === (t.d + 1) % 4 ? 1 : -1, rad = R_MID - lat*turn;
    var vx = a0x*Math.cos(th) + a1x*Math.sin(th), vz = a0z*Math.cos(th) + a1z*Math.sin(th);
    var tx = -a0x*Math.sin(th) + a1x*Math.cos(th), tz = -a0z*Math.sin(th) + a1z*Math.cos(th);
    return [cx + t.pivot[0] + vx*rad, cz + t.pivot[1] + vz*rad, ((Math.atan2(tx, -tz)*180/Math.PI) + 360) % 360];
  }
  function gridSlot(k){
    if(SCALE === 1) return [k % 2 === 0 ? -2 : 2, 3 + Math.floor(k/2)*3.2 + (k % 2 ? 1.6 : 0)];   // 1.9.0 servers
    return [k % 2 === 0 ? -3 : 3, 4 + Math.floor(k/2)*4 + (k % 2 ? 2 : 0)];
  }
  var K = {DIRS: DIRS, compileTrack: compileTrack, cellOf: cellOf, locate: locate, pointAt: pointAt, gridSlot: gridSlot};
  // Race at the scale the Arena referees: a server from before the wider tracks sends none
  // (its roads are the kit's own 10 m tiles), and positions must match its geometry exactly.
  K.setScale = function(s){
    s = s === 1 ? 1 : 1.5;
    SCALE = s; TILE = 10*s; HALF = TILE/2; ROAD_HALF = 4.5*s; R_IN = 0.5*s; R_MID = 5*s; R_OUT = 9.5*s;
    K.SCALE = SCALE; K.TILE = TILE; K.HALF = HALF; K.ROAD_HALF = ROAD_HALF; K.R_IN = R_IN; K.R_MID = R_MID; K.R_OUT = R_OUT;
  };
  K.setScale(SCALE);
  return K;
})();
/* KART-TRACK END */

/* ---------- handling (browser only: the server checks, it doesn't simulate) ---------- */
var VMAX = 30, VREV = 8, CAR_R = 0.85, TURN = 2.3, DRIFT_TURN = 1.45, STEP = 1/120;
var SEND_EVERY = 0.05, KEEPALIVE = 1.0, CD_SECS = 3;
var INTERP = 0.1, JIT_MAX = 0.2, EXTRAP = 0.25, SNAPS = 10;
var CARS = [{f: "vehicle-truck-red", n: "Red truck"}, {f: "vehicle-truck-green", n: "Green truck"},
            {f: "vehicle-truck-purple", n: "Purple truck"}, {f: "vehicle-truck-yellow", n: "Yellow truck"},
            {f: "vehicle-motorcycle", n: "Motorcycle"}];
var CAR_SWATCH = ["#d8433a", "#3aa86a", "#8a3fd8", "#e0b325", "#3a6fd8"];
var LAP_CHOICES = [1, 2, 3, 4, 5];

function nameOf(p){ return (p && (p.displayName || p.handle)) || "Racer"; }

/* ---------- data + three.js, loaded on demand ---------- */
var DATA = null, DATA_P = null, TRACKS = {};
// An Arena from 1.9.0 ("legacy") referees the first three tracks only, at their original
// short layouts (`legacy` in tracks.json) and the kit's 1x scale; it sends no "scale" and no
// "tracks" (and no view at all between races). Newer servers say both. Solo is never legacy.
var LEGACY = null, SERVER_IDS = null;
function compileTracks(){
  TRACKS = {};
  ((DATA && DATA.tracks) || []).forEach(function(t){
    var path = LEGACY ? t.legacy : t.path; if(typeof path !== "string") return;
    try { var c = KT.compileTrack(path); c.id = t.id; c.name = t.name; c.laps = t.laps|0 || 3;
      c.theme = t.theme || {}; c.scenery = t.scenery || "forest"; TRACKS[t.id] = c; } catch(e){} });
}
// Switch tracks, scale and top speed to match the server (or solo). True if anything changed.
function useServer(legacy){
  legacy = !!legacy;
  if(legacy === LEGACY && Object.keys(TRACKS).length) return false;
  LEGACY = legacy; KT.setScale(legacy ? 1 : 1.5); VMAX = legacy ? 26 : 30; compileTracks(); return true;
}
// Track ids this race can use: the server's list in a room, everything solo.
function trackIds(mp){
  var all = ((DATA && DATA.tracks) || []).map(function(t){ return t.id; }).filter(function(id){ return TRACKS[id]; });
  if(!mp || !SERVER_IDS) return all;
  return all.filter(function(id){ return SERVER_IDS.indexOf(id) >= 0; });
}
function randomOf(list){
  if(!list.length) return null;
  var r = new Uint32Array(1);
  try { crypto.getRandomValues(r); } catch(e){ r[0] = Date.now(); }
  return list[r[0] % list.length];
}
function loadData(){
  if(DATA_P) return DATA_P;
  DATA_P = fetch("/games/kart/tracks.json").then(function(r){ if(!r.ok) throw new Error("tracks "+r.status); return r.json(); })
    .then(function(j){
      DATA = j; LEGACY = null; useServer(false);
      return j;
    }, function(e){ DATA_P = null; throw e; });
  return DATA_P;
}
function kartLib(){ return E.lib(); }
function loadGlb(lib, name){ return E.loadGlb(lib, "kart", name); }
function ksave(){
  var s = api.save; if(!s) return {best: {}};
  if(!s.kart || typeof s.kart !== "object" || Array.isArray(s.kart)) s.kart = {};
  if(!s.kart.best || typeof s.kart.best !== "object") s.kart.best = {};
  return s.kart;
}

/* =============================== the game view =============================== */
var CUR = null;

function makeGame(host, opts){
  var V = {mode: opts.mode, ctx: opts.ctx || null, alive: true, paused: false, track: null, laps: 3, phase: "idle",
    goAt: 0, startAt: 0, cars: {}, order: [], standings: [], results: null, finishedAt: null, lapTimes: [], lastLapAt: 0,
    sendAt: 0, sentKey: "", wrongFor: 0, note: "", round: null, gotView: false, unsupported: false, map: !!ksave().map,
    low: !!ksave().low, offline: false, cam: 0, spectate: null, fixAt: 0, lastSnapMs: 0};
  var practice = {uid: "me", name: "You"};
  function myId(){ return V.mode === "mp" && MP ? MP.me() : "me"; }
  function me(){ return V.cars[myId()] || null; }

  var root = api.mk("div", "vg-golf vg-kart"), menu = api.mk("div", "vg-golf-menu"), stage = api.mk("div", "vg-golf-stage hidden");
  root.appendChild(menu); root.appendChild(stage); host.appendChild(root);
  var wrap = api.mk("div", "vg-golf-view vg-kart-view"), hud = api.mk("div", "vg-golf-hud vg-kart-hud");
  var hudLap = api.mk("b", "vg-kart-big"), hudTime = api.mk("span", "vg-kart-time"), hudStand = api.mk("ol", "vg-kart-stand");
  hud.appendChild(hudLap); hud.appendChild(hudTime); hud.appendChild(hudStand); hud.setAttribute("aria-hidden", "true");
  var cdBox = api.mk("div", "vg-kart-cd hidden"); cdBox.setAttribute("aria-hidden", "true");
  var warn = api.mk("div", "vg-kart-warn hidden", "Wrong way!"); warn.setAttribute("aria-hidden", "true");
  var gauges = api.mk("canvas", "vg-kart-gauges"); gauges.setAttribute("aria-hidden", "true");
  var mini = api.mk("canvas", "vg-kart-mini"); mini.setAttribute("aria-hidden", "true");
  var cardBox = api.mk("div", "vg-golf-card vg-kart-card hidden"); cardBox.setAttribute("role", "dialog"); cardBox.setAttribute("aria-label", "Race results");
  var badge = api.mk("span", "vg-reconnecting vg-golf-badge hidden", "Reconnecting…"); badge.setAttribute("role", "status");
  var load = api.mk("div", "vg-meter vg-golf-load hidden"), loadFill = api.mk("i"); load.appendChild(loadFill); load.setAttribute("aria-hidden", "true");
  var hint = api.mk("p", "vg-golf-hint"), tools = api.mk("div", "vg-row vg-golf-tools"), keysBox = api.mk("div", "vg-golf-keys");
  stage.appendChild(wrap); stage.appendChild(hint); stage.appendChild(tools); stage.appendChild(keysBox);
  var KEYS = [["W / ↑ / RT", "accelerate"], ["S / ↓ / LT", "brake, reverse"], ["A D / ← → / stick", "steer"],
              ["Shift / B", "drift"], ["R / Y", "back on the road"], ["C", "camera"], ["H", "hide these keys"]];
  function renderKeys(){
    keysBox.textContent = "";
    if(ksave().keysHidden){ keysBox.appendChild(api.mk("span", "vg-muted", "Keys hidden — press H to show them")); return; }
    KEYS.forEach(function(r){ var it = api.mk("span", "vg-golf-key"); it.appendChild(api.mk("kbd", null, r[0])); it.appendChild(document.createTextNode(" "+r[1])); keysBox.appendChild(it); });
  }
  var canvas = null, R3 = null, R2 = null, IN = null, raf = 0, lastT = 0, acc = 0, ro = null, TOK = tokens(), tokAt = 0;

  /* ---------- cars ---------- */
  function ensureCar(uid, info){
    var C = V.cars[uid];
    if(!C){
      C = V.cars[uid] = {uid: uid, name: "", car: 0, slot: 0, x: 0, z: 0, yaw: 0, v: 0, w: 0, steer: 0, drift: false, u: 0,
        lap: 1, place: 0, fin: null, dnf: false, away: false, snaps: [], lastQ: -1, off: null, jit: 0, mesh: null, rpm: 900, wheel: 0};
      V.order.push(uid);
    }
    if(info){ for(var k in info) C[k] = info[k]; }
    return C;
  }
  function dropCar(uid){ var C = V.cars[uid]; if(!C) return; if(R3) R3.removeCar(C); delete V.cars[uid]; V.order = V.order.filter(function(u){ return u !== uid; }); }
  function clearCars(){ V.order.slice().forEach(dropCar); }
  function placeOnGrid(C, k){
    var g = KT.gridSlot(k); C.slot = k; C.x = g[0]; C.z = g[1]; C.yaw = 0; C.v = 0; C.w = 0; C.steer = 0; C.snaps.length = 0;
    C.u = 0.5 - g[1]/KT.TILE; C.lap = 1; C.fin = null; C.dnf = false;
  }

  /* ---------- screens ---------- */
  function showStage(on){ stage.classList.toggle("hidden", !on); menu.classList.toggle("hidden", on); if(on){ ensureRenderer(); renderTools(); renderKeys(); } }
  function isHost(){
    var s = MP ? MP.st("kart") : null, id = myId(), h = false;
    ((s && s.lobby) || []).forEach(function(p){ if(p.userId === id && p.host) h = true; });
    return h;
  }
  function renderMenu(){
    if(!V.alive) return;
    menu.textContent = "";
    if(!DATA){ menu.appendChild(api.mk("p", "vg-muted", V.note || "Loading tracks…")); return; }
    var sv = ksave(), mp = V.mode === "mp", host = mp && isHost();
    menu.appendChild(api.mk("p", "vg-muted", mp
      ? "Up to 8 racers on one track. Everyone drives their own car; the Arena server times the laps and keeps the standings."
      : "Time trial on your own: set a best lap on each track. W to go, A/D to steer, Shift to drift."));
    if(mp && V.unsupported) menu.appendChild(api.mk("p", "vg-msg", "This Arena server doesn't host Kart Racing yet. You can still race solo."));
    var top = api.mk("div", "vg-row");
    if(mp) top.appendChild(api.btn("Time trial solo", "", function(){ V.mode = "practice"; renderMenu(); }));
    else if(V.ctx) top.appendChild(api.btn("Back to the lobby", "", function(){ V.mode = "mp"; resetRace(); requestView(); renderMenu(); }));
    function check(label, val, fn){
      var l = api.mk("label", "vg-golf-check"), cb = api.mk("input"); cb.type = "checkbox"; cb.checked = val;
      cb.addEventListener("change", function(){ fn(cb.checked); api.persist(); });
      l.appendChild(cb); l.appendChild(document.createTextNode(" "+label)); top.appendChild(l);
    }
    check("Map view (2D)", V.map, function(v){ V.map = v; sv.map = v; });
    check("Low detail (faster on older laptops)", V.low, function(v){ V.low = v; sv.low = v; });
    menu.appendChild(top);
    // car
    menu.appendChild(api.mk("h4", "vg-golf-h", "Your car"));
    var cars = api.mk("div", "vg-golf-chars"); cars.setAttribute("role", "group"); cars.setAttribute("aria-label", "Pick a car");
    var mine = clamp(sv.car|0, 0, CARS.length - 1);
    CARS.forEach(function(c, i){
      var b = api.btn("", "vg-golf-char vg-kart-car"+(i === mine ? " on" : ""), function(){
        sv.car = i; api.persist(); if(mp && MP) MP.send("kart", "car", {car: i}); renderMenu();
      });
      var sw = api.mk("i", "vg-kart-sw"); sw.style.background = CAR_SWATCH[i]; sw.setAttribute("aria-hidden", "true"); b.appendChild(sw);
      b.appendChild(api.mk("span", null, c.n)); b.setAttribute("aria-pressed", i === mine ? "true" : "false");
      cars.appendChild(b);
    });
    menu.appendChild(cars);
    // laps
    var lr = api.mk("div", "vg-row"), lsel = api.mk("select", "vg-select"); lsel.setAttribute("aria-label", "Laps");
    var laps = LAP_CHOICES.indexOf(sv.laps|0) >= 0 ? sv.laps|0 : 3;
    LAP_CHOICES.forEach(function(n){ var o = api.mk("option", null, n+(n === 1 ? " lap" : " laps")); o.value = String(n); if(n === laps) o.selected = true; lsel.appendChild(o); });
    lsel.addEventListener("change", function(){ sv.laps = +lsel.value; api.persist(); });
    if(!mp || host){ lr.appendChild(api.mk("span", "vg-muted", "Race length")); lr.appendChild(lsel); menu.appendChild(lr); }
    // tracks
    menu.appendChild(api.mk("h4", "vg-golf-h", mp ? (host ? "Pick a track to start the race" : "Tracks") : "Tracks"));
    var ids = trackIds(mp);
    if(mp && LEGACY) menu.appendChild(api.mk("p", "vg-muted", "This Arena runs an older Kart Racing: the three original tracks at their first size. Update the Arena for every track."));
    var rnd = api.btn("🎲 Random track", "", function(){
      var id = randomOf(ids), n = +lsel.value || 3; if(!id) return;
      if(mp){ if(MP) MP.send("kart", "start", {track: id, laps: n}); }
      else startPractice(id, n);
    });
    if(mp && !host) rnd.disabled = true;
    var rr = api.mk("div", "vg-row"); rr.appendChild(rnd); menu.appendChild(rr);
    var grid = api.mk("div", "vg-golf-courses");
    (DATA.tracks || []).forEach(function(t){
      var tr = TRACKS[t.id]; if(!tr || ids.indexOf(t.id) < 0) return;
      var card = api.mk("button", "vg-card vg-golf-course"); card.type = "button";
      var ic = api.mk("span", "vg-card-ic", "🏁"); ic.setAttribute("aria-hidden", "true"); card.appendChild(ic);
      var tt = api.mk("span", "vg-card-t"); tt.appendChild(api.mk("b", null, t.name));
      var corners = tr.tiles.filter(function(x){ return x.kind === "C"; }).length, best = sv.best[t.id];
      tt.appendChild(api.mk("span", null, (tr.n*KT.TILE)+" m lap · "+corners+" corners"+(best ? " · best lap "+fmt(best) : "")));
      card.appendChild(tt);
      if(mp && !host) card.disabled = true;
      card.addEventListener("click", function(){
        var n = +lsel.value || 3;
        if(mp){ if(MP) MP.send("kart", "start", {track: t.id, laps: n}); }
        else startPractice(t.id, n);
      });
      grid.appendChild(card);
    });
    menu.appendChild(grid);
    if(mp){
      if(!host) menu.appendChild(api.mk("p", "vg-muted", "Waiting for the host (★ in the lobby) to pick a track."));
      if(V.results) menu.appendChild(resultsTable(V.results, "Last race"));
      if(V.round && (V.round.phase === "grid" || V.round.phase === "race") && !inRace(V.round))
        menu.appendChild(api.btn("Watch the race", "primary", function(){ applyView(V.round, true); }));
    }
  }
  function inRace(view){ return (view.players || []).some(function(p){ return p.user && p.user.userId === myId(); }); }
  function renderTools(){
    tools.textContent = "";
    tools.appendChild(api.btn(V.mode === "mp" ? "Leave the race" : "Back to tracks", "", function(){
      if(V.mode === "mp" && MP && isHost() && (V.phase === "grid" || V.phase === "race")){
        if(!window.confirm("End the race for everyone?")) return;
        MP.send("kart", "end");
      }
      resetRace(); showStage(false); renderMenu();
    }));
    tools.appendChild(api.btn("Camera", "", function(){ V.cam = (V.cam + 1) % 3; if(canvas) canvas.focus(); }));
  }
  function resetRace(){ clearCars(); V.phase = "idle"; V.track = null; V.results = null; V.finishedAt = null; cardBox.classList.add("hidden"); cdBox.classList.add("hidden"); if(R3) R3.clearTrack(); }

  /* ---------- practice: a solo time trial ---------- */
  function startPractice(id, laps){
    if(useServer(false) && R3){ R3.clearTrack(); }
    var tr = TRACKS[id]; if(!tr) return;
    resetRace(); V.mode = "practice"; V.track = tr; V.laps = laps; V.lapTimes = [];
    var C = ensureCar("me", {name: "You", car: clamp(ksave().car|0, 0, CARS.length - 1)});
    placeOnGrid(C, 0);
    V.phase = "grid"; V.goAt = now() + CD_SECS;
    showStage(true); if(R3) R3.buildTrack();
    if(canvas) canvas.focus();
  }

  /* ---------- multiplayer: the server's view ---------- */
  function requestView(){ if(MP) MP.send("kart", "view"); }
  function applyView(view, force){
    V.round = view; V.gotView = true;
    if(V.mode === "mp"){
      SERVER_IDS = view && Array.isArray(view.tracks) ? view.tracks.filter(function(x){ return typeof x === "string"; }).slice(0, 64) : null;
      if(useServer(!view || view.scale == null)){ V.track = null; if(R3) R3.clearTrack(); }
    }
    if(!view || !TRACKS[view.track]){ if(V.phase !== "idle" && V.mode === "mp"){ resetRace(); showStage(false); } renderMenu(); return; }
    if(V.mode !== "mp") return;
    var mine = inRace(view);
    if(view.phase === "idle"){ if(V.phase !== "idle"){ resetRace(); showStage(false); } renderMenu(); return; }
    if(view.phase === "done"){ V.results = view.results; if(V.phase !== "idle" && V.phase !== "done") showResults(view.results); V.phase = "done"; renderMenu(); return; }
    if(!mine && !force && V.phase === "idle"){ renderMenu(); return; }
    var fresh = !V.track || V.track.id !== view.track || V.phase === "idle" || V.phase === "done";
    V.track = TRACKS[view.track]; V.laps = view.laps|0 || 3;
    if(fresh){ resetRace(); V.track = TRACKS[view.track]; V.laps = view.laps|0 || 3; V.lapTimes = []; }
    var seen = {};
    (view.players || []).forEach(function(p){
      var uid = p.user && p.user.userId; if(!uid) return; seen[uid] = 1;
      var C = ensureCar(uid, {name: nameOf(p.user), car: clamp(p.car|0, 0, CARS.length - 1), place: p.place|0, fin: p.fin, dnf: !!p.dnf, away: !!p.away});
      if(fresh || view.phase === "grid") placeOnGrid(C, p.slot|0);
      if(view.phase === "race" && (fresh || uid !== myId())){
        C.x = (+p.x || 0)/100; C.z = (+p.z || 0)/100; C.yaw = (+p.r || 0)*Math.PI/180;
        var loc = KT.locate(V.track, C.x, C.z); if(loc) C.u = (p.lap - 1)*V.track.n + loc[0] + loc[1];
        C.lap = p.lap|0 || 1;
      }
    });
    V.order.slice().forEach(function(uid){ if(!seen[uid]) dropCar(uid); });
    V.spectate = mine ? null : (view.players[0] && view.players[0].user.userId);
    if(view.phase === "grid"){ V.phase = "grid"; V.goAt = now() + (view.goInMs|0)/1000; }
    else if(view.phase === "race"){ if(V.phase !== "race") V.startAt = now() - (view.raceMs|0)/1000; V.phase = "race"; }
    showStage(true);
    if(fresh && R3) R3.buildTrack();
    hudUpdate();
  }
  function onEvent(m){
    if(m.ev === "kart"){
      if(!DATA){ V.round = m.race; V.gotView = true; return; }
      applyView(m.race, false);
      if(m.by && m.race && m.race.phase === "grid" && canvas) canvas.focus();
      return;
    }
    if(V.mode !== "mp" || !V.track) return;
    if(m.ev === "go"){ V.phase = "race"; V.startAt = now(); V.lastLapAt = V.startAt; cdShow("GO!"); say("Go!"); return; }
    if(m.ev === "snap"){
      (m.cars || []).forEach(function(c){
        var C = V.cars[c.u]; if(!C) return;
        C.lap = c.lap|0 || C.lap;
        if(c.u !== myId()) pushSnap(C, c);
      });
      if(Array.isArray(m.order)){ V.standings = m.order.slice(0, 8); V.standings.forEach(function(u, i){ if(V.cars[u]) V.cars[u].place = i + 1; }); }
      return;
    }
    if(m.ev === "fix"){
      var M = me(); if(!M) return;
      M.x = (+m.x || 0)/100; M.z = (+m.z || 0)/100; M.yaw = (+m.r || 0)*Math.PI/180; M.v = 0; M.w = 0;
      var loc = KT.locate(V.track, M.x, M.z); if(loc){ var base = Math.floor(M.u/V.track.n)*V.track.n; M.u = base + loc[0] + loc[1]; }
      V.fixAt = now(); return;
    }
    if(m.ev === "finish"){
      var F = V.cars[m.user]; if(F) F.fin = m.ms;
      if(m.user === myId()){ V.finishedAt = now(); say("You finished in place "+m.place+", "+fmt(m.ms)); cdShow("P"+m.place+"!"); }
      else if(F) api.toast("🏁 "+F.name+" finished P"+m.place+" · "+fmt(m.ms));
      return;
    }
    if(m.ev === "dnf"){ var D = V.cars[m.user]; if(D) D.dnf = true; return; }
    if(m.ev === "done"){ V.results = m.results; V.phase = "done"; showResults(m.results); return; }
    if(m.ev === "car"){ var K = V.cars[m.user]; if(K && V.phase !== "race"){ K.car = clamp(m.car|0, 0, CARS.length - 1); if(R3) R3.removeCar(K); } return; }
  }
  function onError(m){
    var e = String(m.error || "");
    if(/unknown game/.test(e)){ V.unsupported = true; renderMenu(); return true; }
    return false;
  }

  /* ---------- results ---------- */
  function resultsTable(rows, title){
    var box = api.mk("div", "vg-golf-score");
    box.appendChild(api.mk("b", null, title));
    var tb = api.mk("table", "vg-golf-table"), hr = api.mk("tr");
    ["#", "Racer", "Time", "Best lap"].forEach(function(h){ hr.appendChild(api.mk("th", null, h)); }); tb.appendChild(hr);
    (rows || []).forEach(function(r){
      var tr = api.mk("tr"), laps = Array.isArray(r.laps) ? r.laps : [], best = null, prev = 0;
      laps.forEach(function(t){ var d = t - prev; prev = t; if(best == null || d < best) best = d; });
      tr.appendChild(api.mk("td", null, r.dnf ? "–" : String(r.place)));
      tr.appendChild(api.mk("td", r.user && r.user.userId === myId() ? "tot" : null, nameOf(r.user)));
      tr.appendChild(api.mk("td", null, r.dnf ? "DNF" : fmt(r.ms)));
      tr.appendChild(api.mk("td", null, fmt(best)));
      tb.appendChild(tr);
    });
    box.appendChild(tb); return box;
  }
  function showResults(rows){
    cardBox.textContent = "";
    cardBox.appendChild(resultsTable(rows, "Results · "+(V.track ? V.track.name : "")));
    var row = api.mk("div", "vg-row");
    if(V.mode === "mp"){
      if(isHost()) row.appendChild(api.btn("Pick the next track", "primary", function(){ resetRace(); showStage(false); renderMenu(); }));
      else row.appendChild(api.btn("Back to the lobby", "", function(){ resetRace(); showStage(false); renderMenu(); }));
    } else {
      row.appendChild(api.btn("Race again", "primary", function(){ startPractice(V.track.id, V.laps); }));
      row.appendChild(api.btn("Tracks", "", function(){ resetRace(); showStage(false); renderMenu(); }));
    }
    cardBox.appendChild(row); cardBox.classList.remove("hidden");
    var mine = (rows || []).filter(function(r){ return r.user && r.user.userId === myId(); })[0];
    if(mine) say(mine.dnf ? "Race over: did not finish" : "Race over: place "+mine.place+", "+fmt(mine.ms));
  }
  function cdShow(t){ cdBox.textContent = t; cdBox.classList.remove("hidden"); cdBox.dataset.until = String(now() + 1.1); }

  /* ---------- driving ---------- */
  // Keep a car on its tile's road; returns the wall normal it was pushed along, or null.
  function keepOnRoad(C, px, pz){
    var tr = V.track, loc = KT.locate(tr, C.x, C.z), lim = KT.ROAD_HALF - 1.0;
    if(!loc){ C.x = px; C.z = pz; return [0, 0]; }
    if(Math.abs(loc[2]) <= lim) return null;
    var t = tr.tiles[loc[0]], over = Math.abs(loc[2]) - lim, sg = loc[2] > 0 ? 1 : -1, nx, nz;
    if(t.kind !== "C"){ var h = KT.DIRS[t.d]; nx = -h[1]*sg; nz = h[0]*sg; }
    else { var cx = t.col*KT.TILE + t.pivot[0], cz = t.row*KT.TILE + t.pivot[1], vx = C.x - cx, vz = C.z - cz, r = Math.sqrt(vx*vx + vz*vz) || 1; nx = vx/r*sg; nz = vz/r*sg; }
    C.x -= nx*over; C.z -= nz*over;
    return [nx, nz];
  }
  function physics(C, dt, thr, steer, drift){
    var sp = C.v, fwd = thr > 0, brake = thr < 0;
    if(fwd) C.v += (VMAX*thr - C.v)*(1 - Math.exp(-dt*(C.v < 0 ? 4 : 0.85)));
    else if(brake && (C.v > 0.4 || C.fin != null)) C.v += (0 - C.v)*(1 - Math.exp(-dt*(C.fin != null ? 1.2 : 3.2)));   // finished: roll to a stop
    else if(brake) C.v += (-VREV*-thr - C.v)*(1 - Math.exp(-dt*1.5));
    else C.v += (0 - C.v)*(1 - Math.exp(-dt*0.45));
    var spd = Math.abs(C.v), grip = clamp(spd/6, 0, 1)*(1 - 0.32*clamp(spd/VMAX, 0, 1)), dir = C.v >= 0 ? 1 : -1;
    C.drift = !!(drift && spd > 10 && Math.abs(steer) > 0.2);
    var target = steer*TURN*grip*dir*(C.drift ? DRIFT_TURN : 1);
    C.w += (target - C.w)*(1 - Math.exp(-dt*7));
    if(C.drift) C.v *= 1 - 0.18*dt;
    C.yaw += C.w*dt;
    C.steer += (steer - C.steer)*(1 - Math.exp(-dt*10));
    var px = C.x, pz = C.z;
    C.x += Math.sin(C.yaw)*C.v*dt; C.z -= Math.cos(C.yaw)*C.v*dt;
    // other cars: push mine out (they are where the server last saw them)
    V.order.forEach(function(uid){
      var O = V.cars[uid]; if(O === C || O.dnf) return;
      var dx = C.x - O.x, dz = C.z - O.z, d2 = dx*dx + dz*dz, R = CAR_R*2;
      if(d2 < R*R && d2 > 1e-6){ var d = Math.sqrt(d2), push = (R - d)*0.6; C.x += dx/d*push; C.z += dz/d*push; C.v *= 1 - 1.5*dt; }
    });
    var n = keepOnRoad(C, px, pz);
    if(n){
      var hx = Math.sin(C.yaw), hz = -Math.cos(C.yaw), into = hx*n[0] + hz*n[1];
      if(into > 0){ C.v *= 1 - 0.55*clamp(into, 0, 1)*Math.min(1, dt*30); C.yaw += -(hx*n[1] - hz*n[0] > 0 ? 1 : -1)*into*0.6*dt*8; }
    }
    // track distance, unwrapped
    var loc = KT.locate(V.track, C.x, C.z);
    if(loc){
      var nn = V.track.n, d = loc[0] + loc[1], delta = ((d - C.u) % nn + nn) % nn;
      if(delta >= nn/2) delta -= nn;
      if(Math.abs(delta) <= 3) C.u += delta;
      // wrong way: driving against the track direction for a moment
      var dirDeg = KT.pointAt(V.track, C.u)[2]*Math.PI/180, along = Math.cos(C.yaw - dirDeg);
      V.wrongFor = along < -0.3 && Math.abs(C.v) > 3 ? V.wrongFor + dt : 0;
    }
    // engine note for the RPM gauge: follows speed, revs a little with the throttle, no gears
    var tgt = 900 + 6500*Math.pow(clamp(Math.abs(C.v)/VMAX, 0, 1), 0.85) + (thr > 0 ? 700*thr : 0);
    if(Math.abs(C.v) >= VMAX*0.985 && thr > 0.5) tgt = 7600 + (calm() ? 0 : 250*Math.sin(now()*40));
    C.rpm += (tgt - C.rpm)*(1 - Math.exp(-dt*6));
    C.wheel += C.v*dt/0.3;
    return sp;
  }
  function backOnRoad(){
    var C = me(); if(!C || !V.track) return;
    // towards the centre line, at most 2.2 m (the server allows a short hop, not a teleport)
    var p = KT.pointAt(V.track, C.u), dx = p[0] - C.x, dz = p[1] - C.z, d = Math.sqrt(dx*dx + dz*dz);
    if(d > 2.2){ C.x += dx/d*2.2; C.z += dz/d*2.2; } else { C.x = p[0]; C.z = p[1]; }
    C.yaw = p[2]*Math.PI/180; C.v = 0; C.w = 0;
  }
  function lapCheck(C){
    var tr = V.track, lap = clamp(Math.floor((C.u - 0.5)/tr.n) + 1, 1, V.laps);
    if(lap > C.lap && C.fin == null){
      var t = now(), lt = (t - (V.lastLapAt || V.startAt))*1000; V.lastLapAt = t; V.lapTimes.push(lt);
      say("Lap "+lap+" of "+V.laps+". Last lap "+fmt(lt)); cdShow("Lap "+lap+"/"+V.laps);
    }
    if(V.mode === "practice" || lap > C.lap) C.lap = Math.max(C.lap, lap);
    if(C.u >= 0.5 + V.laps*tr.n && C.fin == null && V.mode === "practice"){
      var tt = now(), last = (tt - (V.lastLapAt || V.startAt))*1000; V.lapTimes.push(last);
      C.fin = (tt - V.startAt)*1000; V.finishedAt = tt; V.phase = "done";
      var best = Math.min.apply(null, V.lapTimes), sv = ksave(), prev = sv.best[tr.id];
      if(!prev || best < prev){ sv.best[tr.id] = Math.round(best); api.persist(); api.toast("🏁 New best lap on "+tr.name+": "+fmt(best)); }
      var lapsAt = [], s = 0; V.lapTimes.forEach(function(x){ s += x; lapsAt.push(Math.round(s)); });
      showResults([{user: {userId: "me", displayName: "You"}, place: 1, ms: C.fin, dnf: false, laps: lapsAt}]);
    }
  }
  function sendPos(t){
    var C = me(); if(!C || V.mode !== "mp" || !MP || V.phase !== "race" || C.fin != null || V.offline) return;
    var x = Math.round(C.x*100), z = Math.round(C.z*100), r = Math.round(((C.yaw*180/Math.PI) % 360 + 360) % 360);
    var key = x+","+z+","+r;
    if(t - V.sendAt < SEND_EVERY) return;
    if(key === V.sentKey && t - V.sendAt < KEEPALIVE) return;
    V.sendAt = t; V.sentKey = key;
    var msg = {x: x, z: z, r: r, s: Math.round(C.v*10), q: myClock()};
    if(C.drift) msg.dr = 1;
    MP.send("kart", "pos", msg);
  }

  /* ---------- remote cars: snapshot interpolation ---------- */
  function pushSnap(C, m){
    var t = now(), q = m.q;
    if(typeof q === "number" && isFinite(q)){
      var st = E.senderTime(C, q, t, JIT_MAX);
      if(st === null) return;
      t = st;
    }
    var sn = C.snaps, last = sn[sn.length - 1];
    if(last && t <= last.t) t = last.t + 0.001;
    var x = (+m.x || 0)/100, z = (+m.z || 0)/100, tp = last && (Math.abs(x - last.x) > 12 || Math.abs(z - last.z) > 12);
    if(tp) sn.length = 0;
    sn.push({t: t, x: x, z: z, yaw: (+m.r || 0)*Math.PI/180, v: (+m.s || 0)/10, dr: !!m.dr});
    if(sn.length > SNAPS) sn.shift();
    if(tp || sn.length === 1){ C.x = x; C.z = z; C.yaw = sn[sn.length - 1].yaw; }
  }
  function sampleSnaps(C, t, dt){
    var sn = C.snaps, n = sn.length; if(!n) return;
    var rt = t - INTERP - C.jit, x, z, yaw, v, dr;
    if(rt <= sn[0].t){ x = sn[0].x; z = sn[0].z; yaw = sn[0].yaw; v = sn[0].v; dr = sn[0].dr; }
    else if(rt >= sn[n-1].t){
      var L = sn[n-1], ex = Math.min(rt - L.t, EXTRAP);
      x = L.x + Math.sin(L.yaw)*L.v*ex; z = L.z - Math.cos(L.yaw)*L.v*ex; yaw = L.yaw; v = L.v; dr = L.dr;
    } else {
      for(var i = n - 1; i > 0 && sn[i-1].t > rt; i--){}
      var A = sn[i-1], B = sn[i], u = (rt - A.t)/((B.t - A.t) || 1);
      x = A.x + (B.x - A.x)*u; z = A.z + (B.z - A.z)*u; yaw = angLerp(A.yaw, B.yaw, u); v = A.v + (B.v - A.v)*u; dr = B.dr;
    }
    var k = calm() ? 1 : 1 - Math.exp(-20*dt), ex2 = x - C.x, ez2 = z - C.z;
    if(Math.abs(ex2) > 12 || Math.abs(ez2) > 12) k = 1;
    var pyaw = C.yaw;
    C.x += ex2*k; C.z += ez2*k; C.yaw = angLerp(C.yaw, yaw, Math.min(1, k*1.5)); C.v = v; C.drift = dr;
    C.w = dt > 0 ? clamp(Math.atan2(Math.sin(C.yaw - pyaw), Math.cos(C.yaw - pyaw))/dt, -4, 4) : 0;
    C.steer = clamp(C.w/TURN, -1, 1); C.wheel += v*dt/0.3;
    C.rpm = 900 + 6500*clamp(Math.abs(v)/VMAX, 0, 1);
  }

  /* ---------- the loop ---------- */
  function update(dt, t){
    if(!V.track) return;
    if(IN) IN.poll();
    if(IN && IN.pressed("help")){ var s = ksave(); s.keysHidden = !s.keysHidden; api.persist(); renderKeys(); }
    if(IN && IN.pressed("camera")) V.cam = (V.cam + 1) % 3;
    var C = me();
    if(V.phase === "grid"){
      var left = Math.ceil(V.goAt - t);
      if(left > 0 && left <= 3){ if(cdBox.textContent !== String(left)){ cdShow(String(left)); say(String(left)); } }
      if(V.mode === "practice" && t >= V.goAt){ V.phase = "race"; V.startAt = t; V.lastLapAt = t; cdShow("GO!"); say("Go!"); }
    }
    var racing = V.phase === "race" && C && C.fin == null && !V.paused;
    var thr = racing && IN ? IN.axis("throttle") : 0, steer = racing && IN ? IN.axis("x") : 0, drift = racing && IN && IN.down("drift");
    if(racing && IN && IN.pressed("reset")) backOnRoad();
    if(C && (V.phase === "race" || V.phase === "done")){
      acc += dt;
      while(acc >= STEP){ physics(C, STEP, C.fin != null ? -0.4 : thr, C.fin != null ? 0 : steer, drift); acc -= STEP; }
      if(V.phase === "race") lapCheck(C);
    }
    V.order.forEach(function(uid){ if(uid !== myId()) sampleSnaps(V.cars[uid], t, dt); });
    sendPos(t);
    warn.classList.toggle("hidden", !(V.wrongFor > 1.2 && racing));
    if(cdBox.dataset.until && t > +cdBox.dataset.until){ cdBox.classList.add("hidden"); cdBox.dataset.until = ""; }
  }
  function hudUpdate(){
    if(!V.track){ hudLap.textContent = ""; return; }
    var C = me(), t = now(), F = C || V.cars[V.spectate] || null;
    var lap = F ? clamp(F.lap, 1, V.laps) : 1, n = V.order.length;
    var txt = "Lap "+lap+"/"+V.laps+(V.mode === "mp" && F && F.place ? " · P"+F.place+"/"+n : "");
    if(hudLap.textContent !== txt) hudLap.textContent = txt;
    var el = V.phase === "race" ? (t - V.startAt)*1000 : V.phase === "done" && C && C.fin != null ? C.fin : 0;
    if(C && C.fin != null) el = C.fin;
    var best = V.lapTimes.length ? Math.min.apply(null, V.lapTimes) : (V.mode === "practice" ? ksave().best[V.track.id] : null);
    var tt = fmt(el)+(V.lapTimes.length ? " · last "+fmt(V.lapTimes[V.lapTimes.length - 1]) : "")+(best ? " · best "+fmt(best) : "");
    if(hudTime.textContent !== tt) hudTime.textContent = tt;
    if(V.mode === "mp"){
      var sig = V.standings.join(",")+"|"+V.order.map(function(u){ var c = V.cars[u]; return c.fin != null ? "f" : c.dnf ? "d" : c.away ? "a" : ""; }).join("");
      if(hudStand.dataset.sig !== sig){
        hudStand.dataset.sig = sig; hudStand.textContent = "";
        var ord = V.standings.length ? V.standings : V.order;
        ord.forEach(function(u){ var c = V.cars[u]; if(!c) return;
          var li = api.mk("li", u === myId() ? "me" : null), sw = api.mk("i", "vg-kart-sw"); sw.style.background = CAR_SWATCH[c.car|0] || CAR_SWATCH[0];
          li.appendChild(sw); li.appendChild(document.createTextNode(" "+c.name+(c.fin != null ? " 🏁" : c.dnf ? " (out)" : c.away ? " (away)" : "")));
          hudStand.appendChild(li); });
      }
    }
  }

  /* ---------- gauges: speed + RPM, drawn on a small 2D canvas ---------- */
  function drawGauges(){
    var C = me() || V.cars[V.spectate]; if(!C) return;
    var dpr = Math.min(window.devicePixelRatio || 1, 2), W = 236, H = 124;
    if(gauges.width !== Math.round(W*dpr)){ gauges.width = Math.round(W*dpr); gauges.height = Math.round(H*dpr); }
    var g = gauges.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
    var kmh = Math.abs(C.v)*3.6;
    dial(g, 62, 64, 54, kmh, 120, 20, 10, "km/h", Math.round(kmh), null);
    dial(g, 174, 64, 54, C.rpm/1000, 8, 1, 0.5, "×1000 rpm", (C.rpm/1000).toFixed(1), 6.5);
  }
  function dial(g, cx, cy, r, val, max, major, minor, unit, label, red){
    var a0 = Math.PI*0.75, a1 = Math.PI*2.25, T = TOK;
    function ang(v){ return a0 + (a1 - a0)*clamp(v/max, 0, 1); }
    g.beginPath(); g.arc(cx, cy, r, 0, Math.PI*2); g.fillStyle = T.panel; g.globalAlpha = 0.9; g.fill(); g.globalAlpha = 1;
    g.lineWidth = 1.5; g.strokeStyle = T.line; g.stroke();
    if(red != null){ g.beginPath(); g.arc(cx, cy, r - 7, ang(red), a1); g.lineWidth = 6; g.strokeStyle = T.need; g.stroke(); }
    g.lineCap = "round";
    for(var v = 0; v <= max + 1e-6; v += minor){
      var isMaj = Math.abs(v/major - Math.round(v/major)) < 1e-6, a = ang(v), r1 = r - 4, r2 = r - (isMaj ? 13 : 9);
      g.beginPath(); g.moveTo(cx + Math.cos(a)*r1, cy + Math.sin(a)*r1); g.lineTo(cx + Math.cos(a)*r2, cy + Math.sin(a)*r2);
      g.lineWidth = isMaj ? 2 : 1; g.strokeStyle = red != null && v >= red ? T.need : T.muted; g.stroke();
      if(isMaj){
        g.fillStyle = T.muted; g.font = "600 9px "+T.mono; g.textAlign = "center"; g.textBaseline = "middle";
        g.fillText(String(Math.round(v)), cx + Math.cos(a)*(r - 22), cy + Math.sin(a)*(r - 22));
      }
    }
    var an = ang(val);
    g.beginPath(); g.moveTo(cx - Math.cos(an)*6, cy - Math.sin(an)*6); g.lineTo(cx + Math.cos(an)*(r - 8), cy + Math.sin(an)*(r - 8));
    g.lineWidth = 3; g.strokeStyle = red != null && val >= red ? T.need : T.brand; g.stroke();
    g.beginPath(); g.arc(cx, cy, 4, 0, Math.PI*2); g.fillStyle = T.ink; g.fill();
    g.fillStyle = T.ink; g.font = "700 16px "+T.mono; g.textAlign = "center"; g.textBaseline = "alphabetic";
    g.fillText(String(label), cx, cy + r*0.55);
    g.fillStyle = T.muted; g.font = "600 8px "+T.mono; g.fillText(unit, cx, cy + r*0.55 + 11);
  }
  /* ---------- minimap ---------- */
  var miniPts = null;
  function drawMini(){
    if(!V.track) return;
    var dpr = Math.min(window.devicePixelRatio || 1, 2), S = 120;
    if(mini.width !== Math.round(S*dpr)){ mini.width = Math.round(S*dpr); mini.height = Math.round(S*dpr); }
    var g = mini.getContext("2d"), tr = V.track; g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, S, S);
    if(!miniPts || miniPts.id !== tr.id){
      var pts = [], mnx = 1e9, mxx = -1e9, mnz = 1e9, mxz = -1e9;
      for(var k = 0; k <= tr.n*6; k++){ var p = KT.pointAt(tr, k/6); pts.push(p); mnx = Math.min(mnx, p[0]); mxx = Math.max(mxx, p[0]); mnz = Math.min(mnz, p[1]); mxz = Math.max(mxz, p[1]); }
      var sc = (S - 16)/Math.max(mxx - mnx, mxz - mnz, 1);
      miniPts = {id: tr.id, pts: pts, sc: sc, ox: (S - (mxx - mnx)*sc)/2 - mnx*sc, oz: (S - (mxz - mnz)*sc)/2 - mnz*sc};
    }
    var M = miniPts, T = TOK;
    g.fillStyle = T.panel; g.globalAlpha = 0.88; g.fillRect(0, 0, S, S); g.globalAlpha = 1;
    g.beginPath(); M.pts.forEach(function(p, i){ var x = p[0]*M.sc + M.ox, y = p[1]*M.sc + M.oz; if(i) g.lineTo(x, y); else g.moveTo(x, y); });
    g.lineWidth = 5; g.strokeStyle = T.line; g.lineJoin = "round"; g.stroke(); g.lineWidth = 1; g.strokeStyle = T.muted; g.stroke();
    var f = KT.pointAt(tr, 0.5); g.fillStyle = T.ink; g.fillRect(f[0]*M.sc + M.ox - 4, f[1]*M.sc + M.oz - 1, 8, 2);
    V.order.forEach(function(uid){
      var C = V.cars[uid], mine = uid === myId();
      g.beginPath(); g.arc(C.x*M.sc + M.ox, C.z*M.sc + M.oz, mine ? 4 : 3, 0, Math.PI*2);
      g.fillStyle = CAR_SWATCH[C.car|0] || T.brand; g.fill();
      if(mine){ g.lineWidth = 1.5; g.strokeStyle = T.ink; g.stroke(); }
    });
  }

  /* ---------- renderers ---------- */
  function ensureRenderer(){
    if(canvas) return;
    wrap.textContent = "";
    [hud, mini, gauges, cdBox, warn, cardBox, badge, load].forEach(function(n){ wrap.appendChild(n); });
    canvas = api.mk("canvas", "vg-golf-canvas vg-kart-canvas"); canvas.tabIndex = 0;
    canvas.setAttribute("aria-label", "Kart race. W or up arrow accelerates, S brakes, A and D steer, Shift drifts, R puts you back on the road.");
    wrap.insertBefore(canvas, wrap.firstChild);
    if(IN) IN.destroy();
    IN = HQV.input ? HQV.input.create(wrap, {}) : null;
    canvas.addEventListener("pointerdown", function(){ canvas.focus(); });
    resize();
    if(!V.map && hasWebGL2()){
      R2 = make2d(null);
      load.classList.remove("hidden"); loadFill.style.width = "10%";
      make3d(canvas).then(function(r){
        load.classList.add("hidden");
        if(!V.alive){ r.dispose(); return; }
        R3 = r; R2 = null; if(V.track) R3.buildTrack(); resize();
      }, function(){
        load.classList.add("hidden");
        if(!V.alive) return;
        V.note = "3D unavailable: showing the map view."; api.toast(V.note); fallback2d();
      });
    } else R2 = make2d(canvas);
    if(!raf) raf = requestAnimationFrame(frame);
  }
  function fallback2d(){
    if(R3){ R3.dispose(); R3 = null; }
    if(canvas){ canvas.remove(); canvas = null; }
    var m = V.map; V.map = true; ensureRenderer(); V.map = m;
  }
  function resize(){
    if(!canvas) return;
    var w = Math.max(280, wrap.clientWidth || host.clientWidth || 640), h = Math.round(Math.min(w*0.6, (window.innerHeight || 800)*0.7));
    canvas.style.height = h+"px";
    if(R3) R3.size(w, h);
    else if(R2 && R2.canvas){ var dpr = Math.min(window.devicePixelRatio || 1, 2); canvas.width = Math.round(w*dpr); canvas.height = Math.round(h*dpr); }
  }
  var hudAt = 0, gaugeAt = 0;
  function frame(ts){
    if(!V.alive) return;
    raf = requestAnimationFrame(frame);
    var t = ts/1000, dt = lastT ? clamp(t - lastT, 0, 0.1) : 0; lastT = t;
    try {
      if(t - tokAt > 2){ TOK = tokens(); tokAt = t; }
      if(!V.paused) update(dt, now());
      if(R3) R3.render(dt, now()); else if(R2) R2.render();
      if(t - hudAt > 0.1){ hudAt = t; hudUpdate(); drawMini(); }
      if(t - gaugeAt > (V.low ? 1/20 : 1/40)){ gaugeAt = t; drawGauges(); }
    } catch(e){ if(window.console) console.error("kart frame", e); }
  }

  // 2D map view: north-up, the camera centred on your car.
  function make2d(cv){
    var R = {canvas: cv};
    R.render = function(){
      if(!cv) return;
      var g = cv.getContext("2d"), W = cv.width, H = cv.height, T = TOK;
      g.setTransform(1, 0, 0, 1, 0, 0); g.fillStyle = T.bg2; g.fillRect(0, 0, W, H);
      if(!V.track){ g.fillStyle = T.muted; g.font = "14px sans-serif"; g.fillText("Loading…", 16, 24); return; }
      var F = me() || V.cars[V.spectate] || V.cars[V.order[0]], sc = Math.min(W, H)/95;
      g.save(); g.translate(W/2, H/2); g.scale(sc, sc); if(F) g.translate(-F.x, -F.z);
      var tr = V.track;
      g.beginPath(); for(var k = 0; k <= tr.n*8; k++){ var p = KT.pointAt(tr, k/8); if(k) g.lineTo(p[0], p[1]); else g.moveTo(p[0], p[1]); }
      g.lineJoin = "round"; g.lineWidth = KT.ROAD_HALF*2 + 1; g.strokeStyle = T.line; g.stroke(); g.lineWidth = KT.ROAD_HALF*2; g.strokeStyle = T.panel2; g.stroke();
      g.setLineDash([1.5, 1.5]); g.lineWidth = 0.15; g.strokeStyle = T.muted; g.stroke(); g.setLineDash([]);
      g.fillStyle = T.ink; g.fillRect(-KT.ROAD_HALF, -0.25, KT.ROAD_HALF*2, 0.5);
      V.order.forEach(function(uid){
        var C = V.cars[uid]; g.save(); g.translate(C.x, C.z); g.rotate(C.yaw);
        g.fillStyle = CAR_SWATCH[C.car|0] || T.brand; g.fillRect(-0.75, -1.4, 1.5, 2.8);
        g.fillStyle = T.ink; g.fillRect(-0.6, -1.4, 1.2, 0.5); g.restore();
      });
      g.restore();
    };
    return R;
  }

  function make3d(cv){
    return kartLib().then(function(lib){
      var names = ["track-straight", "track-corner", "track-finish", "decoration-forest", "decoration-tents", "decoration-empty"].concat(CARS.map(function(c){ return c.f; }));
      var done = 0;
      var GL = {};
      return Promise.all(names.map(function(n){ return loadGlb(lib, n).then(function(g){ GL[n] = g; done++; loadFill.style.width = Math.round(10 + 90*done/names.length)+"%"; }); }))
        .then(function(){ return new Promise(function(res){ lib.tex.load("/games/kart/smoke.png", res, null, function(){ res(null); }); }); })
        .then(function(smokeTex){ return build3d(lib, lib.THREE, cv, smokeTex, GL); });
    });
  }
  function build3d(lib, THREE, cv, smokeTex, GL){
    var renderer = new THREE.WebGLRenderer({canvas: cv, antialias: !V.low});
    renderer.setPixelRatio(V.low ? 1 : Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = !V.low; renderer.shadowMap.type = THREE.PCFShadowMap;
    var scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(62, 1.6, 0.1, 400);
    var hemi = new THREE.HemisphereLight(0xffffff, 0x556644, 2.0); scene.add(hemi);
    var sun = new THREE.DirectionalLight(0xffffff, 1.9); sun.position.set(12, 30, 8);
    sun.castShadow = !V.low; sun.shadow.mapSize.set(1024, 1024); sun.shadow.bias = -0.0006; sun.shadow.normalBias = 0.02;
    var sc = sun.shadow.camera; sc.left = -40; sc.right = 40; sc.top = 40; sc.bottom = -40; sc.near = 1; sc.far = 110;
    scene.add(sun); scene.add(sun.target);
    var groundGeo = new THREE.PlaneGeometry(1200, 1200); groundGeo.rotateX(-Math.PI/2);
    var groundMat = new THREE.MeshLambertMaterial({color: 0x76b85a}), ground = new THREE.Mesh(groundGeo, groundMat);
    ground.position.y = -0.02; ground.receiveShadow = !V.low; scene.add(ground);
    var trackGroup = null, smoke = [], smokeMat = smokeTex ? new THREE.SpriteMaterial({map: smokeTex, transparent: true, depthWrite: false, opacity: 0.6}) : null;
    var lost = function(e){ e.preventDefault(); if(V.alive) setTimeout(fallback2d, 0); };
    cv.addEventListener("webglcontextlost", lost);
    function model(name, how){
      var g = GL[name]; if(!g) return new THREE.Group();
      var o = lib.clone(g.scene);
      o.traverse(function(m){ if(m.isMesh){ m.castShadow = !V.low && how !== "ground"; m.receiveShadow = !V.low; } });
      return o;
    }
    // Scenery tint per track: "mul" multiplies the scenery's colours (autumn leaves, dry grass),
    // "add" + "addK" glows them towards a colour (a dusting of snow). One copy per material.
    var tinted = {};
    function tintDeco(o, th){
      var d = th && th.deco; if(!d || typeof d !== "object") return;
      var mul = hex(d.mul, 0xffffff), add = hex(d.add, 0), k = clamp(+d.addK || 0, 0, 1);
      o.traverse(function(m){
        if(!m.isMesh || !m.material) return;
        var key = m.material.uuid + "|" + mul + "|" + add + "|" + k;
        if(!tinted[key]){
          var c = tinted[key] = m.material.clone();
          c.color.multiply(new THREE.Color(mul));
          if(k > 0 && c.emissive){ c.emissive = new THREE.Color(add); c.emissiveIntensity = k; }
        }
        m.material = tinted[key];
      });
    }
    function hash(a, b){ var h = (a*73856093) ^ (b*19349663); h = (h ^ (h >>> 13))*1274126177; return ((h ^ (h >>> 16)) >>> 0)/4294967296; }
    function buildTrack(){
      clearTrack();
      if(!V.track) return;
      var tr = V.track, th = tr.theme || {};
      trackGroup = new THREE.Group(); scene.add(trackGroup);
      var sky = hex(th.sky, 0x9fd3f0), fog = hex(th.fog, 0xcfe8f2);
      scene.background = new THREE.Color(sky); scene.fog = new THREE.Fog(fog, V.low ? 65 : 100, V.low ? 160 : 270);
      groundMat.color.setHex(hex(th.ground, 0x76b85a));
      var minC = 1e9, maxC = -1e9, minR = 1e9, maxR = -1e9;
      tr.tiles.forEach(function(t){
        var name = t.kind === "F" ? "track-finish" : t.kind === "S" ? "track-straight" : "track-corner", o = model(name, "track"), k;
        if(t.kind === "C"){
          var px = t.pivot[0], pz = t.pivot[1];
          k = px < 0 && pz > 0 ? 0 : px > 0 && pz > 0 ? 1 : px > 0 && pz < 0 ? 2 : 3;
        } else k = t.d % 2 === 0 ? 0 : 1;
        o.position.set(t.col*KT.TILE, 0, t.row*KT.TILE); o.rotation.y = k*Math.PI/2; o.scale.setScalar(KT.SCALE);
        trackGroup.add(o);
        minC = Math.min(minC, t.col); maxC = Math.max(maxC, t.col); minR = Math.min(minR, t.row); maxR = Math.max(maxR, t.row);
      });
      if(!V.low){
        var pad = 2;
        for(var c = minC - pad; c <= maxC + pad; c++) for(var r = minR - pad; r <= maxR + pad; r++){
          if(tr.cells[c+","+r] != null) continue;
          var hv = hash(c + 1000, r + 1000), nm = hv < 0.45 ? "decoration-forest" : hv < 0.6 ? (tr.scenery === "tents" ? "decoration-tents" : "decoration-forest") : "decoration-empty";
          var d = model(nm, "ground"); d.position.set(c*KT.TILE, 0, r*KT.TILE); d.rotation.y = Math.floor(hash(r, c)*4)*Math.PI/2; d.scale.setScalar(KT.SCALE);
          tintDeco(d, th);
          trackGroup.add(d);
        }
      }
      V.order.forEach(function(uid){ removeCar(V.cars[uid]); });
    }
    function clearTrack(){
      camInit = false;
      if(trackGroup){ scene.remove(trackGroup); trackGroup = null; }
      V.order.forEach(function(uid){ removeCar(V.cars[uid]); });
      smoke.forEach(function(s){ scene.remove(s.sp); }); smoke = [];
    }
    function tag(text){
      var c = document.createElement("canvas"), g = c.getContext("2d"); c.width = 256; c.height = 64;
      g.font = "700 30px sans-serif"; g.textAlign = "center"; g.textBaseline = "middle";
      var w = Math.min(250, g.measureText(text).width + 28);
      g.fillStyle = "rgba(20,24,32,0.72)"; g.beginPath(); g.roundRect ? g.roundRect(128 - w/2, 8, w, 48, 18) : g.rect(128 - w/2, 8, w, 48); g.fill();
      g.fillStyle = "#ffffff"; g.fillText(text, 128, 33);
      var tx = new THREE.CanvasTexture(c); tx.colorSpace = THREE.SRGBColorSpace;
      var sp = new THREE.Sprite(new THREE.SpriteMaterial({map: tx, depthTest: false, transparent: true})); sp.scale.set(2.4, 0.6, 1); sp.renderOrder = 10;
      return sp;
    }
    function addCar(C){
      var o = model(CARS[C.car|0].f, "car"), wrapG = new THREE.Group(); wrapG.add(o);
      var parts = {fl: null, fr: null, wheels: [], body: null};
      o.traverse(function(n){
        if(/^wheel-front(-left)?$/.test(n.name)) parts.fl = n;
        if(n.name === "wheel-front-right") parts.fr = n;
        // steer (Y) outside the roll (X): with three's default XYZ order a steered wheel wobbles
        if(/^wheel/.test(n.name)){ n.rotation.order = "YXZ"; parts.wheels.push(n); }
        if(n.name === "body") parts.body = n;
        if(n.name === "fork") parts.fork = n;
      });
      if(C.uid !== myId()){ var tg = tag(C.name.slice(0, 18)); tg.position.set(0, 2.3, 0); wrapG.add(tg); parts.tag = tg; }
      C.mesh = {g: wrapG, p: parts}; scene.add(wrapG);
    }
    function removeCar(C){ if(C && C.mesh){ scene.remove(C.mesh.g); C.mesh = null; } }
    function puff(x, z, t){
      if(!smokeMat || V.low || calm()) return;
      var s = smoke.length >= 48 ? smoke.shift() : {sp: new THREE.Sprite(smokeMat.clone())};
      if(!s.sp.parent) scene.add(s.sp);
      s.sp.position.set(x, 0.25, z); s.sp.scale.set(0.6, 0.6, 1); s.t0 = t; s.sp.material.opacity = 0.55; smoke.push(s);
    }
    var camPos = new THREE.Vector3(0, 6, 10), look = new THREE.Vector3(), tmp = new THREE.Vector3(), camInit = false, camYaw = 0;
    var R = {};
    R.buildTrack = buildTrack; R.clearTrack = clearTrack; R.removeCar = removeCar;
    R.size = function(w, h){ renderer.setSize(w, h, false); camera.aspect = w/h; camera.updateProjectionMatrix(); };
    R.render = function(dt, t){
      if(!V.track){ renderer.render(scene, camera); return; }
      V.order.forEach(function(uid){
        var C = V.cars[uid]; if(!C.mesh) addCar(C);
        var m = C.mesh;
        m.g.position.set(C.x, 0, C.z); m.g.rotation.y = Math.PI - C.yaw;
        m.p.wheels.forEach(function(wh){ wh.rotation.x = C.wheel; });
        var st = -C.steer*0.45; if(m.p.fl) m.p.fl.rotation.y = st; if(m.p.fr) m.p.fr.rotation.y = st; if(m.p.fork) m.p.fork.rotation.y = st;
        if(m.p.body && !calm()){ m.p.body.rotation.z = clamp(-C.w*Math.abs(C.v)/VMAX*0.12, -0.12, 0.12); }
        if(m.p.tag) m.p.tag.visible = !(C.fin != null && V.phase !== "race");
        if(C.drift && Math.abs(C.v) > 8 && (C.puffN = (C.puffN|0) + 1) % 2 === 0){
          var bx = C.x - Math.sin(C.yaw)*1.2, bz = C.z + Math.cos(C.yaw)*1.2;
          puff(bx + Math.cos(C.yaw)*0.6, bz + Math.sin(C.yaw)*0.6, t); puff(bx - Math.cos(C.yaw)*0.6, bz - Math.sin(C.yaw)*0.6, t);
        }
      });
      for(var i = smoke.length - 1; i >= 0; i--){
        var s = smoke[i], age = t - s.t0;
        if(age > 0.9){ scene.remove(s.sp); smoke.splice(i, 1); continue; }
        var k = 0.6 + age*2.2; s.sp.scale.set(k, k, 1); s.sp.position.y = 0.25 + age*0.6; s.sp.material.opacity = 0.55*(1 - age/0.9);
      }
      // camera: chase (0), far chase (1), or high above (2)
      var F = me() || V.cars[V.spectate] || V.cars[V.order[0]];
      if(F){
        // The chase camera sits a fixed distance behind the car and only its heading is
        // smoothed (faster the faster you go), so at top speed the car stays big on screen
        // instead of pulling away from a camera that trails it.
        var sp = clamp(Math.abs(F.v)/VMAX, 0, 1);
        if(!camInit || calm()) camYaw = F.yaw; else camYaw = angLerp(camYaw, F.yaw, 1 - Math.exp(-dt*(3 + 5*sp)));
        camInit = true;
        var fx = Math.sin(camYaw), fz = -Math.cos(camYaw), dist = V.cam === 1 ? 12 : 6.6 + 0.6*sp, high = V.cam === 1 ? 6 : 3.0;
        if(V.cam === 2) tmp.set(F.x, 44, F.z + 0.01);
        else {
          // keep the chase camera on our side of the barriers: walk it in towards the car
          // until it is over the road, so it never looks back through a wall
          var gx = F.x - fx*dist, gz = F.z - fz*dist, lift = 0;
          for(var tries = 0; tries < 8; tries++){
            var cl = KT.locate(V.track, gx, gz);
            if(cl && Math.abs(cl[2]) < KT.ROAD_HALF - 0.3) break;
            gx = F.x + (gx - F.x)*0.8; gz = F.z + (gz - F.z)*0.8; lift += 0.35;
          }
          tmp.set(gx, high + lift, gz);
        }
        if(V.cam === 2 && camPos.y > 20) camPos.lerp(tmp, calm() ? 1 : 1 - Math.exp(-dt*4)); else camPos.copy(tmp);
        var ahead = V.cam === 2 ? 0 : 4 + 2*sp;
        look.set(F.x + Math.sin(F.yaw)*ahead, 0.8, F.z - Math.cos(F.yaw)*ahead);
        camera.position.copy(camPos); camera.lookAt(look);
        var fov = V.cam === 2 || calm() ? 60 : 60 + 6*sp;
        if(Math.abs(camera.fov - fov) > 0.1){ camera.fov += (fov - camera.fov)*Math.min(1, dt*3); camera.updateProjectionMatrix(); }
        sun.position.set(F.x + 12, 30, F.z + 8); sun.target.position.set(F.x, 0, F.z);
      }
      renderer.render(scene, camera);
    };
    R.dispose = function(){
      cv.removeEventListener("webglcontextlost", lost);
      clearTrack(); renderer.dispose();
      try { var ext = renderer.getContext().getExtension("WEBGL_lose_context"); if(ext) ext.loseContext(); } catch(e){}
    };
    return R;
  }
  function onResize(){ resize(); }
  window.addEventListener("resize", onResize);
  if(typeof ResizeObserver !== "undefined"){ ro = new ResizeObserver(onResize); ro.observe(host); }
  renderKeys();
  renderMenu();
  loadData().then(function(){ if(!V.alive) return; renderMenu(); if(V.mode === "mp" && V.gotView) applyView(V.round); else if(V.mode === "mp") requestView(); },
    function(){ V.note = "Couldn't load the tracks."; renderMenu(); });
  if(!raf) raf = requestAnimationFrame(frame);
  V.destroy = function(){
    V.alive = false;
    if(raf) cancelAnimationFrame(raf); raf = 0;
    window.removeEventListener("resize", onResize); if(ro) ro.disconnect();
    if(IN){ IN.destroy(); IN = null; }
    if(R3){ R3.dispose(); R3 = null; }
    root.remove();
  };
  V.onEvent = onEvent; V.onError = onError;
  V.onConn = function(on){
    V.offline = !on; badge.classList.toggle("hidden", on);
    if(!on) V.order.forEach(function(u){ var C = V.cars[u]; if(u !== myId()) C.lastQ = -1; });
  };
  V.startPractice = startPractice;     // smoke tests
  V.rendererKind = function(){ return R3 ? "3d" : R2 && R2.canvas ? "2d" : ""; };
  return V;
}

/* ---------- registration: a solo card and a "with friends" card ---------- */
HQV.register({id: "kart", name: "Kart Racing", icon: "🏎️", desc: "Arcade racing on three tracks: beat your best lap",
  mount: function(el){ if(CUR) CUR.destroy(); CUR = makeGame(el, {mode: "practice"}); },
  unmount: function(){ if(CUR){ CUR.destroy(); CUR = null; } },
  pause: function(){ if(CUR) CUR.paused = true; },
  resume: function(){ if(CUR) CUR.paused = false; }});

if(MP){
  MP.handlers.kart = {
    on: function(m){ if(CUR && CUR.ctx) CUR.onEvent(m); },
    onError: function(m){ return CUR && CUR.ctx ? CUR.onError(m) : false; },
    render: function(){}
  };
  MP.register("kart", "🏎️", "Race up to 8 friends: the server keeps the laps", function(ctx){
    if(CUR) CUR.destroy();
    var g = CUR = makeGame(ctx.box, {mode: "mp", ctx: ctx});
    ctx.onConn = function(on){ if(g.alive) g.onConn(on); };
    ctx.onRejoin = function(){ if(g.alive && MP) MP.send("kart", "view"); };
    ctx.stop = function(){ g.destroy(); if(CUR === g) CUR = null; };
  });
}
HQV.kartTrack = KT;      // for the browser smoke test
HQV.kartDebug = function(){ return CUR; };
})();
