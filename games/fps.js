/* Valley: Blaster Arena. A cartoon first-person arena shooter on a courtyard built from
 * Kenney's CC0 Starter Kit FPS blocks: a solo target range, or a free-for-all of up to 8
 * in an Arena room (first to the kill limit, or most kills when the clock runs out).
 *
 * Rendering is the vendored three.js r186 (games/vendor/), imported only when this game
 * opens; without WebGL2 the same match runs as a top-down map. Players are Kenney's Mini
 * Characters (games/golf/). The movement and blaster handling are an original
 * re-implementation in the spirit of the kit's (no Godot code is used).
 *
 * Multiplayer: you run and aim here (your own movement is predicted, your shots show at
 * once) and send where you are ~20 times a second (x, y, z in cm, yaw/pitch, your clock);
 * the Arena server (backend/app/fps.py) runs a 20 Hz tick that checks every move and
 * judges every shot with lag compensation: a shot carries your clock, the last snapshot
 * you had and how far behind you were drawing the others, and the server rewinds them to
 * what you saw (the round trip it measures itself; your claimed delay is capped). Others
 * are drawn ~100 ms in the past from the server's snapshots (plus measured jitter). Hit
 * markers, damage and kills come from the server. Only these numbers, a weapon and a
 * character id travel; nothing transcript-derived.
 *
 * The FPS-SHARED block mirrors backend/app/fps.py (tests/test_fps_sync.py runs both under
 * node and checks they agree).
 */
(function(){
"use strict";
var HQV = window.HQV; if(!HQV || !HQV.api || !HQV.engine) return;
// Shared helpers, three.js loading and snapshot timing: games/engine.js.
var E = HQV.engine;
var now = E.now, clamp = E.clamp, hex = E.hex, angLerp = E.angLerp, calm = E.calm, say = E.say,
    tokens = E.tokens, myClock = E.myClock, hasWebGL2 = E.hasWebGL2;
var api = HQV.api, MP = HQV.mp || null;

/* FPS-SHARED BEGIN */
var FS = (function(){
  var R = 0.35, H = 1.8, EYE = 1.6, STEP_H = 0.55, RUN = 6.0, ACCEL = 12.0, AIR_ACCEL = 3.0, GRAVITY = 18.0;
  var JUMP_V = 6.5, FALL_MAX = 25.0, BODY_R = 0.4, BODY_H = 1.4, HEAD_R = 0.25, HEAD_TOP = 1.9;
  var WEAPONS = [
    {id: "rapid", name: "Rapid blaster", interval: 0.1, damage: 12, head: 18, mag: 30, reserve: 90, reload: 1.6,
     spread: 1.2, range: 60.0, auto: true, pack: 60},
    {id: "heavy", name: "Heavy blaster", interval: 0.8, damage: 55, head: 85, mag: 6, reserve: 18, reload: 2.0,
     spread: 0.3, range: 80.0, auto: false, pack: 12}];
  function compileMap(d){
    d = d || {};
    var boxes = (d.boxes || []).map(function(b){ return [+b[0], +b[1], +b[2], +b[3], +b[4], +b[5], String(b[6] || "block")]; });
    boxes.forEach(function(b){ if(!(b[0] < b[3] && b[1] < b[4] && b[2] < b[5])) throw new Error("box with no volume"); });
    return {id: d.id, name: d.name, bounds: (d.bounds || []).map(Number), boxes: boxes, theme: d.theme || {},
            spawns: (d.spawns || []).map(function(s){ return s.map(Number); }), pickups: d.pickups || [], targets: d.targets || []};
  }
  // index of the first solid box a player standing at (x, y, z) is inside, else -1
  function overlaps(m, x, y, z, shrink){
    shrink = shrink || 0;
    var x0 = x - R + shrink, x1 = x + R - shrink, y0 = y + shrink, y1 = y + H - shrink, z0 = z - R + shrink, z1 = z + R - shrink;
    for(var i = 0; i < m.boxes.length; i++){
      var b = m.boxes[i];
      if(x1 > b[0] && x0 < b[3] && y1 > b[1] && y0 < b[4] && z1 > b[2] && z0 < b[5]) return i;
    }
    return -1;
  }
  function topUnder(m, x, y, z){
    var best = null;
    for(var i = 0; i < m.boxes.length; i++){
      var b = m.boxes[i];
      if(x + R > b[0] && x - R < b[3] && y + H > b[1] && y < b[4] && z + R > b[2] && z - R < b[5] && (best === null || b[4] > best)) best = b[4];
    }
    return best;
  }
  // one step of the runner: s = {x, y, z, vx, vy, vz, g}; (wx, wz) the wished direction
  function move(m, s, wx, wz, jump, dt){
    var k = Math.min(1, dt*(s.g ? ACCEL : AIR_ACCEL));
    s.vx += (wx*RUN - s.vx)*k;
    s.vz += (wz*RUN - s.vz)*k;
    if(jump && s.g){ s.vy = JUMP_V; s.g = false; }
    s.vy = Math.max(-FALL_MAX, s.vy - GRAVITY*dt);
    ["x", "z"].forEach(function(ax){
      var old = s[ax];
      s[ax] = old + s["v"+ax]*dt;
      var i = overlaps(m, s.x, s.y, s.z, 0);
      if(i >= 0){
        var top = m.boxes[i][4];
        if(s.g && top - s.y > 0 && top - s.y <= STEP_H && overlaps(m, s.x, top, s.z, 0) < 0) s.y = top;
        else { s[ax] = old; s["v"+ax] = 0; }
      }
    });
    var ny = s.y + s.vy*dt;
    if(overlaps(m, s.x, ny, s.z, 0) < 0){ s.y = ny; s.g = false; }
    else if(s.vy <= 0){
      var top = topUnder(m, s.x, ny, s.z);
      if(top !== null && top <= s.y + 1e-9) s.y = top;
      s.vy = 0; s.g = true;
    } else s.vy = 0;
    return s;
  }
  function dirOf(yaw, pitch){
    var y = yaw*Math.PI/180, p = pitch*Math.PI/180, cp = Math.cos(p);
    return [Math.sin(y)*cp, Math.sin(p), -Math.cos(y)*cp];
  }
  function mb32(a){
    a = (a + 0x6D2B79F5)|0;
    var t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0)/4294967296;
  }
  // the deterministic spread (degrees of yaw, pitch) of a player's n-th shot this life
  function spreadOf(n, w){
    var s = WEAPONS[w].spread, seed = (n*2654435761 + w*40503) % 4294967296;
    return [(mb32(seed)*2 - 1)*s, (mb32(seed ^ 0x5BD1E995)*2 - 1)*s];
  }
  // distance along o + t d (t >= 0) to box b; 0 if o is inside; null: a miss
  function rayBox(o, d, b){
    var tmin = 0, tmax = Infinity;
    for(var a = 0; a < 3; a++){
      if(Math.abs(d[a]) < 1e-12){ if(o[a] < b[a] || o[a] > b[a+3]) return null; }
      else {
        var inv = 1/d[a], t1 = (b[a] - o[a])*inv, t2 = (b[a+3] - o[a])*inv;
        if(t1 > t2){ var tt = t1; t1 = t2; t2 = tt; }
        if(t1 > tmin) tmin = t1;
        if(t2 < tmax) tmax = t2;
        if(tmin > tmax) return null;
      }
    }
    return tmin;
  }
  function rayMap(m, o, d, maxd){
    var best = maxd;
    for(var i = 0; i < m.boxes.length; i++){ var t = rayBox(o, d, m.boxes[i]); if(t !== null && t < best) best = t; }
    return best;
  }
  function hitBoxes(x, y, z){
    return [[x - BODY_R, y, z - BODY_R, x + BODY_R, y + BODY_H, z + BODY_R],
            [x - HEAD_R, y + BODY_H, z - HEAD_R, x + HEAD_R, y + HEAD_TOP, z + HEAD_R]];
  }
  // [distance, head?] where the ray first meets a player at (x, y, z) nearer than maxd, else null
  function rayPlayer(o, d, x, y, z, maxd){
    var hb = hitBoxes(x, y, z), tb = rayBox(o, d, hb[0]), th = rayBox(o, d, hb[1]), best = null;
    if(tb !== null && tb < maxd) best = [tb, false];
    if(th !== null && th < maxd && (best === null || th < best[0])) best = [th, true];
    return best;
  }
  // a practice drone's centre at time t: back and forth between a and b at s m/s
  function targetAt(tg, t){
    var a = tg.a, b = tg.b, s = +tg.s, ln = Math.sqrt((b[0]-a[0])*(b[0]-a[0]) + (b[1]-a[1])*(b[1]-a[1]) + (b[2]-a[2])*(b[2]-a[2])) || 1;
    var ph = ((t*s/ln) % 2 + 2) % 2, u = ph <= 1 ? ph : 2 - ph;
    return [a[0] + (b[0]-a[0])*u, a[1] + (b[1]-a[1])*u, a[2] + (b[2]-a[2])*u];
  }
  return {R: R, H: H, EYE: EYE, STEP_H: STEP_H, RUN: RUN, ACCEL: ACCEL, AIR_ACCEL: AIR_ACCEL, GRAVITY: GRAVITY, JUMP_V: JUMP_V,
          FALL_MAX: FALL_MAX, BODY_R: BODY_R, BODY_H: BODY_H, HEAD_R: HEAD_R, HEAD_TOP: HEAD_TOP, WEAPONS: WEAPONS,
          compileMap: compileMap, overlaps: overlaps, topUnder: topUnder, move: move, dirOf: dirOf, mb32: mb32,
          spreadOf: spreadOf, rayBox: rayBox, rayMap: rayMap, hitBoxes: hitBoxes, rayPlayer: rayPlayer, targetAt: targetAt};
})();
/* FPS-SHARED END */

/* ---------- tuning (browser only) ---------- */
var STEP = 1/120, SEND_EVERY = 0.05, KEEPALIVE = 0.5, SWITCH = 0.25, RESPAWN = 3, PRACTICE_SECS = 60;
var INTERP = 0.1, JIT_MAX = 0.25, SNAPS = 12, LOOK = 0.0022, TURN_KEYS = 2.4, PITCH_MAX = 89;
var CHARS = [{f: "character-female-a", n: "Ada"}, {f: "character-male-a", n: "Abe"}, {f: "character-female-c", n: "Cleo"},
             {f: "character-male-c", n: "Cal"}, {f: "character-female-e", n: "Eve"}, {f: "character-male-e", n: "Eli"}];
var CHAR_SWATCH = ["#e0574a", "#3a6fd8", "#3aa86a", "#e0b325", "#8a3fd8", "#e07b25"];
var MINUTES = [3, 5, 10], KILLS = [10, 20, 30];
var KEYS = [["W A S D / stick", "move"], ["mouse / right stick / Q E", "look"], ["click / RT / F", "fire"], ["R / X", "reload"],
            ["1 2 / wheel / Y", "weapon"], ["Space / A", "jump"], ["Tab / Back", "scores"], ["Esc", "release the mouse"], ["H", "hide these keys"]];
var BUTTONS = {w1: {keys: ["Digit1"]}, w2: {keys: ["Digit2"]}, swap: {keys: [], pad: [3]}, shoot: {keys: ["KeyF"]},
               trig: {keys: [], pad: [7]}, turnL: {keys: ["KeyQ"]}, turnR: {keys: ["KeyE"]}, score: {keys: [], pad: [8]}};

function nameOf(p){ return String((p && (p.displayName || p.handle)) || "Player").slice(0, 24); }
function mmss(ms){ ms = Math.max(0, ms|0); var s = Math.ceil(ms/1000), m = Math.floor(s/60); s %= 60; return m+":"+(s < 10 ? "0" : "")+s; }
function fsave(){
  var s = api.save; if(!s) return {best: 0};
  if(!s.fps || typeof s.fps !== "object" || Array.isArray(s.fps)) s.fps = {};
  return s.fps;
}

/* ---------- map + three.js, loaded on demand ---------- */
// The built-in arena (the courtyard), fetched once. Each game view plays its own CURMAP:
// this one, or a user map (HQ 2.5 Map Editor) that a room's view carries inline.
var BUILTIN = null, MAP_P = null;
function loadMap(){
  if(MAP_P) return MAP_P;
  MAP_P = fetch("/games/fps/map.json").then(function(r){ if(!r.ok) throw new Error("map "+r.status); return r.json(); })
    .then(function(j){ BUILTIN = FS.compileMap(j); return BUILTIN; }, function(e){ MAP_P = null; throw e; });
  return MAP_P;
}
// A user map's canonical data (as the server sends it in view.custom) -> a compiled map, or null.
function compileCustom(data, key, name){
  if(!data || typeof data !== "object" || !Array.isArray(data.boxes) || !Array.isArray(data.spawns)) return null;
  try {
    return FS.compileMap({id: String(key || "custom"), name: String(name || "Custom map").slice(0, 32), bounds: data.bounds,
                          theme: data.theme || {}, boxes: data.boxes, spawns: data.spawns,
                          pickups: Array.isArray(data.pickups) ? data.pickups : [], targets: []});
  } catch(e){ return null; }
}
// HQ 2.5: a map the Map Editor asked to play ({doc, room}); taken by the next view that mounts.
var PENDING = null;
function fpsLib(){ return E.lib(); }
function loadGlb(lib, dir, name){ return E.loadGlb(lib, dir, name); }

/* =============================== the game view =============================== */
var CUR = null;

function makeGame(host, opts){
  var sv = fsave();
  var V = {mode: opts.mode, ctx: opts.ctx || null, alive: true, paused: false, phase: "idle", round: null, gotView: false,
    unsupported: false, map: !!sv.map, low: !!sv.low, sens: clamp(+sv.sens || 1, 0.2, 3), offline: false, note: "",
    me: {x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, g: true}, yaw: 0, pitch: 0, hp: 100, dead: false, life: 0, prot: false,
    w: 0, mag: [30, 6], res: [90, 18], reloadAt: 0, readyAt: 0, nextShot: 0, n: 0, kills: 0, deaths: 0,
    players: {}, order: [], slots: {}, mySlot: -1, items: [], feed: [], results: null, minutes: 5, limit: 20,
    goAt: 0, endsAt: 0, deadAt: 0, k: null, kq: 0, off: null, sendAt: 0, sentKey: "", fixAt: 0, score: 0, shots: 0,
    drones: [], startAt: 0, kick: 0, bob: 0, flashAt: -9, hitAt: -9, headAt: -9, hurtAt: -9, hurtDir: 0, board: false,
    tracers: [], trigWas: false, walk: false, walkDoc: null, spawnI: 0, pick: null};
  function myId(){ return V.mode === "mp" && MP ? MP.me() : "me"; }
  function W(){ return FS.WEAPONS[V.w]; }

  /* ---------- HQ 2.5: which arena this view plays ---------- */
  var CURMAP = BUILTIN;                          // the courtyard, or a user map from the room's view
  var PEND = PENDING; PENDING = null;            // a map the Map Editor sent here: walk it, or host it
  if(PEND && PEND.room && V.mode === "mp") V.pick = PEND.doc;
  // Swap the arena; the 3D scene is rebuilt only when it really changed.
  function useMap(m){ if(!m || m === CURMAP) return false; CURMAP = m; if(R3) R3.buildMap(); return true; }
  // The room's view names its arena: a user map arrives inline (view.custom), else the courtyard.
  function syncMap(view){
    var key = view && typeof view.map === "string" ? view.map : "";
    if(/^c-[0-9a-f]{12}$/.test(key) && view.custom && typeof view.custom === "object"){
      if(CURMAP && CURMAP.id === key) return false;
      var m = compileCustom(view.custom.data, key, view.custom.name);
      if(m) return useMap(m);
      V.note = "This room's map couldn't be drawn here."; return false;
    }
    return BUILTIN ? useMap(BUILTIN) : false;
  }
  function customOn(){ var A = window.ARENA; return !!(A && A.arena && A.arena.maps); }
  function myDrafts(){
    var mk = HQV.makers && HQV.makers.fps, out = [];
    try { out = mk && typeof mk.drafts === "function" ? (mk.drafts() || []) : []; } catch(e){ out = []; }
    return Array.isArray(out) ? out.filter(function(d){ return d && d.kind === "fps" && d.data; }) : [];
  }
  function storyNote(ev){ try { if(HQV.story && typeof HQV.story.note === "function") HQV.story.note(ev); } catch(e){} }

  var root = api.mk("div", "vg-golf vg-fps"), menu = api.mk("div", "vg-golf-menu"), stage = api.mk("div", "vg-golf-stage hidden");
  root.appendChild(menu); root.appendChild(stage); host.appendChild(root);
  var wrap = api.mk("div", "vg-golf-view vg-fps-view");
  var hud = api.mk("div", "vg-fps-hud"); hud.setAttribute("aria-hidden", "true");
  var cross = api.mk("div", "vg-fps-cross"), hitm = api.mk("div", "vg-fps-hitm"), hurt = api.mk("div", "vg-fps-hurt");
  var hpBox = api.mk("div", "vg-fps-hp"), hpTrack = api.mk("span", "vg-fps-hpt"), hpBar = api.mk("i"), hpNum = api.mk("b");
  hpTrack.appendChild(hpBar); hpBox.appendChild(hpTrack); hpBox.appendChild(hpNum);
  var ammoBox = api.mk("div", "vg-fps-ammo"), ammoNum = api.mk("b"), ammoName = api.mk("span"), reloadBar = api.mk("i", "vg-fps-rl");
  ammoBox.appendChild(ammoNum); ammoBox.appendChild(ammoName); ammoBox.appendChild(reloadBar);
  var topBox = api.mk("div", "vg-fps-top"), feedBox = api.mk("ol", "vg-fps-feed"), center = api.mk("div", "vg-fps-center hidden");
  var vignette = api.mk("div", "vg-fps-vig");
  [vignette, cross, hitm, hurt, hpBox, ammoBox, topBox, feedBox, center].forEach(function(n){ hud.appendChild(n); });
  var board = api.mk("div", "vg-golf-card vg-fps-board hidden"); board.setAttribute("role", "dialog"); board.setAttribute("aria-label", "Scoreboard");
  var cardBox = api.mk("div", "vg-golf-card vg-fps-card hidden"); cardBox.setAttribute("role", "dialog"); cardBox.setAttribute("aria-label", "Results");
  var pauseBox = api.mk("div", "vg-fps-pause hidden");
  var badge = api.mk("span", "vg-reconnecting vg-golf-badge hidden", "Reconnecting…"); badge.setAttribute("role", "status");
  var load = api.mk("div", "vg-meter vg-golf-load hidden"), loadFill = api.mk("i"); load.appendChild(loadFill); load.setAttribute("aria-hidden", "true");
  var hint = api.mk("p", "vg-golf-hint"), tools = api.mk("div", "vg-row vg-golf-tools"), keysBox = api.mk("div", "vg-golf-keys");
  stage.appendChild(wrap); stage.appendChild(hint); stage.appendChild(tools); stage.appendChild(keysBox);
  function renderKeys(){
    keysBox.textContent = "";
    if(fsave().keysHidden){ keysBox.appendChild(api.mk("span", "vg-muted", "Keys hidden — press H to show them")); return; }
    KEYS.forEach(function(r){ var it = api.mk("span", "vg-golf-key"); it.appendChild(api.mk("kbd", null, r[0])); it.appendChild(document.createTextNode(" "+r[1])); keysBox.appendChild(it); });
  }
  var canvas = null, R3 = null, R2 = null, IN = null, raf = 0, lastT = 0, acc = 0, ro = null, TOK = tokens(), tokAt = 0;

  /* ---------- players ---------- */
  function ensure(uid, info){
    var P = V.players[uid];
    if(!P){
      P = V.players[uid] = {uid: uid, slot: -1, name: "", ch: 0, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, hp: 100, w: 0, dead: false,
        prot: false, away: false, gone: false, kills: 0, deaths: 0, snaps: [], last: -1, jit: 0, seen: 0, mesh: null, moving: 0};
      V.order.push(uid);
    }
    if(info){ for(var k in info) P[k] = info[k]; }
    if(P.slot >= 0) V.slots[P.slot] = uid;
    return P;
  }
  function drop(uid){ var P = V.players[uid]; if(!P) return; if(R3) R3.removePlayer(P); delete V.players[uid]; V.order = V.order.filter(function(u){ return u !== uid; }); }
  function clearPlayers(){ V.order.slice().forEach(drop); V.slots = {}; }
  function others(){ return V.order.filter(function(u){ return u !== myId(); }).map(function(u){ return V.players[u]; }); }

  /* ---------- screens ---------- */
  var WB = null;    // HQ 2.1 spectate: follow any player, or stop watching
  function showStage(on){ stage.classList.toggle("hidden", !on); menu.classList.toggle("hidden", on); if(on){ ensureRenderer(); renderTools(); renderKeys(); }
    if(!WB) WB = E.watchBar(stage, {list: function(){ return Object.keys(V.players).filter(function(u){ return u !== myId() && !V.players[u].gone; }).map(function(u){ return {id: u, name: V.players[u].name}; }); },
      get: function(){ return V.watch; }, set: function(id){ V.watch = id; },
      stop: function(){ V.watch = null; resetMatch(); showStage(false); renderMenu(); }});
    WB.update(); }
  function isHost(){
    var s = MP ? MP.st("fps") : null, id = myId(), h = false;
    ((s && s.lobby) || []).forEach(function(p){ if(p.userId === id && p.host) h = true; });
    return h;
  }
  function select(label, opts, val, fn){
    var l = api.mk("label", "vg-golf-check"), s = api.mk("select", "vg-select"); s.setAttribute("aria-label", label);
    opts.forEach(function(o){ var op = api.mk("option", null, o[1]); op.value = String(o[0]); if(o[0] === val) op.selected = true; s.appendChild(op); });
    s.addEventListener("change", function(){ fn(+s.value); api.persist(); });
    l.appendChild(document.createTextNode(label+" ")); l.appendChild(s); return l;
  }
  function renderMenu(){
    if(!V.alive) return;
    menu.textContent = "";
    if(!CURMAP){ menu.appendChild(api.mk("p", "vg-muted", V.note || "Loading the arena…")); return; }
    var sv = fsave(), mp = V.mode === "mp", host = mp && isHost();
    menu.appendChild(api.mk("p", "vg-muted", mp
      ? "Free-for-all for up to 8 on "+CURMAP.name+". Everyone runs and aims on their own screen; the Arena server judges every shot (it rewinds the others to what you saw) and keeps the score."
      : "The target range on "+CURMAP.name+": hit as many flying drones as you can in "+PRACTICE_SECS+" seconds. Click the view to aim with the mouse; Esc gives the mouse back."));
    if(mp && V.unsupported) menu.appendChild(api.mk("p", "vg-msg", "This Arena server doesn't host Blaster Arena yet. You can still use the target range."));
    var top = api.mk("div", "vg-row");
    if(mp) top.appendChild(api.btn("Target range (solo)", "", function(){ V.mode = "practice"; renderMenu(); }));
    else if(V.ctx) top.appendChild(api.btn("Back to the lobby", "", function(){ V.mode = "mp"; resetMatch(); requestView(); renderMenu(); }));
    function check(label, val, fn){
      var l = api.mk("label", "vg-golf-check"), cb = api.mk("input"); cb.type = "checkbox"; cb.checked = val;
      cb.addEventListener("change", function(){ fn(cb.checked); api.persist(); });
      l.appendChild(cb); l.appendChild(document.createTextNode(" "+label)); top.appendChild(l);
    }
    check("Map view (2D)", V.map, function(v){ V.map = v; sv.map = v; });
    check("Low detail (faster on older laptops)", V.low, function(v){ V.low = v; sv.low = v; });
    var sl = api.mk("label", "vg-golf-check"), sr = api.mk("input"); sr.type = "range"; sr.min = "0.2"; sr.max = "3"; sr.step = "0.1"; sr.value = String(V.sens);
    sr.setAttribute("aria-label", "Mouse sensitivity");
    sr.addEventListener("change", function(){ V.sens = clamp(+sr.value || 1, 0.2, 3); sv.sens = V.sens; api.persist(); if(IN) IN.sens = V.sens; });
    sl.appendChild(document.createTextNode("Mouse sensitivity ")); sl.appendChild(sr); top.appendChild(sl);
    menu.appendChild(top);
    // character
    menu.appendChild(api.mk("h4", "vg-golf-h", "Your character"));
    var chars = api.mk("div", "vg-golf-chars"); chars.setAttribute("role", "group"); chars.setAttribute("aria-label", "Pick a character");
    var mine = clamp(sv.ch|0, 0, CHARS.length - 1);
    CHARS.forEach(function(c, i){
      var b = api.btn("", "vg-golf-char vg-fps-char"+(i === mine ? " on" : ""), function(){
        sv.ch = i; api.persist(); if(mp && MP) MP.send("fps", "char", {c: i}); renderMenu();
      });
      var sw = api.mk("i", "vg-fps-sw"); sw.style.background = CHAR_SWATCH[i]; sw.setAttribute("aria-hidden", "true"); b.appendChild(sw);
      b.appendChild(api.mk("span", null, c.n)); b.setAttribute("aria-pressed", i === mine ? "true" : "false");
      chars.appendChild(b);
    });
    menu.appendChild(chars);
    // HQ 2.1 spectate: a match is on and you're not in it
    if(mp && V.round && (V.round.phase === "warmup" || V.round.phase === "round") && !inMatch(V.round)){
      menu.appendChild(api.btn("Watch the match", "primary", function(){
        var first = (V.round.players || []).filter(function(p){ return p.user && !p.gone; })[0];
        if(first){ V.watch = first.user.userId; applyView(V.round); }
      }));
    }
    if(V.walk && !mp){
      menu.appendChild(api.mk("h4", "vg-golf-h", "Walk-through"));
      var rw = api.mk("div", "vg-row");
      rw.appendChild(api.btn("Walk "+CURMAP.name+" again", "primary", function(){ startWalk(V.walkDoc); }));
      rw.appendChild(api.btn("Back to the Map Editor", "", function(){ api.open("make-fps"); }));
      menu.appendChild(rw);
    }
    if(mp){
      menu.appendChild(api.mk("h4", "vg-golf-h", host ? "Start a match" : "Match"));
      menu.appendChild(mapPicker(host));
      var row = api.mk("div", "vg-row");
      var mins = MINUTES.indexOf(sv.minutes|0) >= 0 ? sv.minutes|0 : 5, kl = KILLS.indexOf(sv.kills|0) >= 0 ? sv.kills|0 : 20;
      if(host){
        row.appendChild(select("Length", MINUTES.map(function(m){ return [m, m+" minutes"]; }), mins, function(v){ sv.minutes = v; }));
        row.appendChild(select("First to", KILLS.map(function(k){ return [k, k+" kills"]; }), kl, function(v){ sv.kills = v; }));
        row.appendChild(api.btn("Start the match", "primary", function(){
          var s = fsave(), msg = {minutes: MINUTES.indexOf(s.minutes|0) >= 0 ? s.minutes|0 : 5, kills: KILLS.indexOf(s.kills|0) >= 0 ? s.kills|0 : 20};
          // HQ 2.5: a user map rides inline on the start op; the server checks it and names it by content
          if(V.pick && customOn()){ msg.map = "custom"; msg.custom = {kind: "fps", v: 1, name: String(V.pick.name || "Custom map").slice(0, 32), data: V.pick.data}; storyNote("race-custom"); }
          if(MP) MP.send("fps", "start", msg);
        }));
      } else row.appendChild(api.mk("span", "vg-muted", "Waiting for the host (★ in the lobby) to start a match."));
      menu.appendChild(row);
      if(V.results) menu.appendChild(resultsTable(V.results, "Last match"));
      if(V.round && (V.round.phase === "warmup" || V.round.phase === "round"))
        menu.appendChild(api.btn("Join the match", "primary", function(){ requestView(); }));
    } else {
      var best = sv.best|0;
      menu.appendChild(api.mk("h4", "vg-golf-h", "Target range"));
      var r2 = api.mk("div", "vg-row");
      r2.appendChild(api.btn("Start ("+PRACTICE_SECS+" s)", "primary", function(){ startPractice(); }));
      if(best) r2.appendChild(api.mk("span", "vg-muted", "Best: "+best+" drones"));
      menu.appendChild(r2);
    }
  }
  // HQ 2.5: the host picks the arena: the courtyard or one of your Map Editor maps.
  function mapPicker(host){
    var box = api.mk("div", "vg-row");
    if(!host || !customOn()){
      box.appendChild(api.mk("span", "vg-muted", "Map: "+(CURMAP ? CURMAP.name : "…")));
      if(!customOn()) V.pick = null;
      return box;
    }
    var drafts = myDrafts(), opts = [["", BUILTIN ? BUILTIN.name : "Sky Courtyard"]], val = "";
    drafts.forEach(function(d, i){ opts.push(["d"+i, "Your map: "+String(d.name || "Untitled").slice(0, 32)]); if(V.pick === d) val = "d"+i; });
    if(V.pick && !val){ opts.push(["p", "Your map: "+String(V.pick.name || "Untitled").slice(0, 32)]); val = "p"; }
    opts.push(["new", "Custom… (open the Map Editor)"]);
    var l = api.mk("label", "vg-golf-check"), sel = api.mk("select", "vg-select"); sel.setAttribute("aria-label", "Map");
    opts.forEach(function(o){ var op = api.mk("option", null, o[1]); op.value = o[0]; if(o[0] === val) op.selected = true; sel.appendChild(op); });
    sel.addEventListener("change", function(){
      var v = sel.value;
      if(v === "new"){ api.open("make-fps"); return; }
      if(v === "") V.pick = null;
      else if(v.charAt(0) === "d") V.pick = drafts[+v.slice(1)] || null;
      say(V.pick ? "Next match on "+String(V.pick.name || "your map") : "Next match on the courtyard");
    });
    l.appendChild(document.createTextNode("Map ")); l.appendChild(sel); box.appendChild(l);
    if(CURMAP && CURMAP !== BUILTIN) box.appendChild(api.mk("span", "vg-muted", "Last played: "+CURMAP.name));
    return box;
  }
  function renderTools(){
    tools.textContent = "";
    tools.appendChild(api.btn(V.mode === "mp" ? "Leave the match" : "Back to the menu", "", function(){
      if(V.mode === "mp" && MP && isHost() && (V.phase === "warmup" || V.phase === "round")){
        if(!window.confirm("End the match for everyone?")) return;
        MP.send("fps", "end");
      }
      if(IN) IN.unlock();
      resetMatch(); showStage(false); renderMenu();
    }));
    tools.appendChild(api.btn("Scores", "", function(){ V.board = !V.board; renderBoard(); }));
    if(V.walk && V.mode === "practice") tools.appendChild(api.btn("Next spawn", "", function(){
      if(!CURMAP || !CURMAP.spawns.length) return;
      V.spawnI = (V.spawnI + 1) % CURMAP.spawns.length;
      var s = CURMAP.spawns[V.spawnI]; placeMe(s[0], s[1], s[2], s[3]);
      say("Spawn "+(V.spawnI + 1)+" of "+CURMAP.spawns.length); if(canvas) canvas.focus();
    }));
  }
  function resetMatch(){
    clearPlayers(); V.phase = "idle"; V.results = null; V.feed = []; V.drones = []; V.tracers = [];
    cardBox.classList.add("hidden"); board.classList.add("hidden"); center.classList.add("hidden"); V.board = false;
    if(R3) R3.clearDynamic();
  }

  /* ---------- me ---------- */
  function placeMe(x, y, z, yawDeg){
    var M = V.me; M.x = x; M.y = y; M.z = z; M.vx = 0; M.vy = 0; M.vz = 0; M.g = true;
    if(yawDeg != null){ V.yaw = yawDeg*Math.PI/180; V.pitch = 0; }
  }
  function fullAmmo(){ V.mag = [FS.WEAPONS[0].mag, FS.WEAPONS[1].mag]; V.res = [FS.WEAPONS[0].reserve, FS.WEAPONS[1].reserve]; V.reloadAt = 0; V.n = 0; }

  /* ---------- practice: the target range ---------- */
  function startPractice(){
    if(!BUILTIN) return;
    useMap(BUILTIN);                             // practice drones fly only on the built-in map
    resetMatch(); V.mode = "practice"; V.score = 0; V.shots = 0; V.walk = false;
    var s = CURMAP.spawns[0]; placeMe(s[0], s[1], s[2], s[3]); fullAmmo(); V.hp = 100; V.dead = false;
    V.drones = CURMAP.targets.map(function(tg, i){ return {tg: tg, i: i, downUntil: 0, phase: i*1.7}; });
    V.items = CURMAP.pickups.map(function(){ return 1; });
    V.phase = "warmup"; V.goAt = now() + 3; V.endsAt = V.goAt + PRACTICE_SECS;
    showStage(true); if(R3) R3.buildMap();
    if(canvas) canvas.focus();
    say("Target range: "+PRACTICE_SECS+" seconds. Click the view to aim with the mouse.");
  }
  // HQ 2.5: walk a user map alone (no drones, no clock) to try its spawns, cover and pickups.
  function startWalk(doc){
    var m = doc && compileCustom(doc.data, "walk", doc.name);
    if(!m || !m.spawns.length){ api.toast("That map can't be walked yet: check it in the Map Editor."); return false; }
    useMap(m);
    resetMatch(); V.mode = "practice"; V.walk = true; V.walkDoc = doc; V.score = 0; V.shots = 0; V.spawnI = 0;
    var s = CURMAP.spawns[0]; placeMe(s[0], s[1], s[2], s[3]); fullAmmo(); V.hp = 100; V.dead = false;
    V.drones = []; V.items = CURMAP.pickups.map(function(){ return 1; });
    V.phase = "warmup"; V.goAt = now() + 1; V.endsAt = Infinity;
    showStage(true); if(R3) R3.buildMap();
    if(canvas) canvas.focus();
    say("Walk-through of "+CURMAP.name+". Next spawn jumps between the "+CURMAP.spawns.length+" spawns.");
    return true;
  }
  function dronePos(D, t){ var c = FS.targetAt(D.tg, t + D.phase); return c; }
  function endPractice(){
    V.phase = "done";
    var sv = fsave(), best = sv.best|0;
    if(V.score > best){ sv.best = V.score; api.persist(); api.toast("🎯 New best on the range: "+V.score+" drones"); }
    var acc2 = V.shots ? Math.round(100*V.score/V.shots) : 0;
    cardBox.textContent = "";
    cardBox.appendChild(api.mk("b", null, "Time! "+V.score+" drones · "+acc2+"% of shots"));
    var row = api.mk("div", "vg-row");
    row.appendChild(api.btn("Again", "primary", function(){ startPractice(); }));
    row.appendChild(api.btn("Menu", "", function(){ resetMatch(); showStage(false); renderMenu(); }));
    cardBox.appendChild(row); cardBox.classList.remove("hidden");
    if(IN) IN.unlock();
    say("Time is up: "+V.score+" drones hit, best "+Math.max(best, V.score)+".");
  }

  /* ---------- multiplayer: the server's view ---------- */
  function requestView(){ if(MP) MP.send("fps", "view"); }
  function inMatch(view){ return (view.players || []).some(function(p){ return p.user && p.user.userId === myId() && !p.gone; }); }
  function applyView(view){
    V.round = view; V.gotView = true;
    if(V.mode !== "mp" || !view) { renderMenu(); return; }
    syncMap(view);
    V.minutes = view.minutes|0 || 5; V.limit = view.limit|0 || 20;
    if(view.phase === "idle"){ V.watch = null; if(V.phase !== "idle"){ resetMatch(); showStage(false); } V.results = view.results || V.results; renderMenu(); return; }
    if(view.phase === "done"){ V.results = view.results; if(V.phase === "warmup" || V.phase === "round") showResults(view.results); V.watch = null; V.phase = "done"; renderMenu(); return; }
    if(inMatch(view)) V.watch = null;
    else if(!V.watch){ renderMenu(); return; }
    else if(!(view.players || []).some(function(p){ return p.user && p.user.userId === V.watch && !p.gone; })){
      var first = (view.players || []).filter(function(p){ return p.user && !p.gone; })[0]; V.watch = first ? first.user.userId : null;
      if(!V.watch){ renderMenu(); return; }
    }
    var fresh = V.phase === "idle" || V.phase === "done";
    if(fresh){ resetMatch(); V.off = null; V.k = null; }
    var seen = {};
    (view.players || []).forEach(function(p){
      var uid = p.user && p.user.userId; if(!uid) return; seen[uid] = 1;
      var P = ensure(uid, {name: nameOf(p.user), slot: p.slot|0, ch: clamp(p.char|0, 0, CHARS.length - 1), kills: p.kills|0,
        deaths: p.deaths|0, hp: p.hp|0, dead: !!p.dead, away: !!p.away, gone: !!p.gone, w: p.w|0,
        cos: (p.user && p.user.cos) || null});
      if(uid === myId()){
        V.mySlot = p.slot|0; V.kills = p.kills|0; V.deaths = p.deaths|0; V.hp = p.hp|0;
        if(fresh || V.life !== (p.e|0) || view.phase === "warmup"){
          placeMe((+p.x || 0)/100, (+p.y || 0)/100, (+p.z || 0)/100, (+p.r || 0)/100);
          V.life = p.e|0; fullAmmo(); V.w = p.w|0;
        }
        V.dead = !!p.dead;
      } else if(fresh || P.snaps.length === 0){
        P.x = (+p.x || 0)/100; P.y = (+p.y || 0)/100; P.z = (+p.z || 0)/100; P.yaw = (+p.r || 0)*Math.PI/18000;
      }
    });
    V.order.slice().forEach(function(uid){ if(!seen[uid]) drop(uid); });
    V.items = Array.isArray(view.items) ? view.items.slice() : CURMAP.pickups.map(function(){ return 1; });
    if(view.phase === "warmup"){ V.phase = "warmup"; V.goAt = now() + (view.goInMs|0)/1000; V.endsAt = V.goAt + V.minutes*60; }
    else if(view.phase === "round"){ V.phase = "round"; V.endsAt = now() + (view.msLeft|0)/1000; }
    showStage(true);
    if(fresh && R3) R3.buildMap();
    renderBoard();
  }
  function slotUid(s){ return V.slots[s]; }
  function onEvent(m){
    if(m.ev === "fps"){
      if(!CURMAP){ V.round = m.match; V.gotView = true; return; }
      applyView(m.match);
      if(m.by && m.match && m.match.phase === "warmup" && canvas) canvas.focus();
      return;
    }
    if(m.ev === "char"){ var C = V.players[m.user]; if(C){ C.ch = clamp(m.c|0, 0, CHARS.length - 1); if(R3) R3.removePlayer(C); } return; }
    if(V.mode !== "mp" || V.phase === "idle") return;
    var t = now();
    if(m.ev === "go"){ V.phase = "round"; V.endsAt = t + (m.msLeft|0)/1000; V.off = null; center.classList.add("hidden"); say("Fight!"); flashCenter("Fight!"); return; }
    if(m.ev === "snap"){ onSnap(m, t); return; }
    if(m.ev === "kill"){
      var K = V.players[m.k], D = V.players[m.v];
      if(K) K.kills = m.kills|0; if(D){ D.deaths = m.deaths|0; D.dead = true; D.deadAt = t; }
      V.feed.unshift({k: K ? K.name : "?", v: D ? D.name : "?", w: m.w|0, hs: !!m.hs, at: t, mine: m.k === myId() || m.v === myId()});
      if(m.k === myId()) E.sfx("hit");
      if(V.feed.length > 5) V.feed.length = 5;
      if(m.v === myId()){ V.dead = true; V.deadAt = t; V.deaths = m.deaths|0; V.hp = 0; say((K ? K.name : "Someone")+" got you. Respawning in "+RESPAWN+" seconds."); }
      if(m.k === myId()){ V.kills = m.kills|0; say("You got "+(D ? D.name : "someone")+(m.hs ? " with a headshot" : "")+". "+V.kills+" kills."); }
      renderFeed(); renderBoard(); return;
    }
    if(m.ev === "spawn"){
      var S = V.players[m.user];
      if(m.user === myId()){
        placeMe((+m.x || 0)/100, (+m.y || 0)/100, (+m.z || 0)/100, (+m.r || 0)/100); V.life = m.e|0; V.dead = false; V.hp = 100;
        fullAmmo(); center.classList.add("hidden"); say("You're back in.");
      } else if(S){ S.dead = false; S.snaps.length = 0; S.last = -1; S.x = (+m.x || 0)/100; S.y = (+m.y || 0)/100; S.z = (+m.z || 0)/100; S.yaw = (+m.r || 0)*Math.PI/18000; S.hp = 100; }
      return;
    }
    if(m.ev === "fix"){
      if((m.e|0) !== V.life) return;
      placeMe((+m.x || 0)/100, (+m.y || 0)/100, (+m.z || 0)/100, null); V.fixAt = t; return;
    }
    if(m.ev === "ammo"){
      if(Array.isArray(m.mag)) V.mag = [m.mag[0]|0, m.mag[1]|0];
      if(Array.isArray(m.res)) V.res = [m.res[0]|0, m.res[1]|0];
      if(!m.reloading) V.reloadAt = 0;
      return;
    }
    if(m.ev === "pick"){
      V.items[m.i|0] = 0;
      if(m.user === myId()){
        V.hp = m.hp|0; if(Array.isArray(m.res)) V.res = [m.res[0]|0, m.res[1]|0];
        var pk = CURMAP.pickups[m.i|0]; say(pk && pk.kind === "health" ? "Health pack: "+V.hp : "Ammo pack");
      }
      return;
    }
    if(m.ev === "item"){ V.items[m.i|0] = 1; return; }
    if(m.ev === "gone"){ var G = V.players[m.user]; if(G){ G.gone = true; renderBoard(); } return; }
    if(m.ev === "done"){ V.results = m.results; V.phase = "done"; showResults(m.results); if(IN) IN.unlock(); return; }
  }
  function onSnap(m, t){
    if(typeof m.ts === "number"){ var o = t - m.ts/1000; if(V.off === null || o < V.off) V.off = o; }
    if(typeof m.k === "number" && (V.k === null || m.k > V.k)){ V.k = m.k; V.kq = myClock(); }
    if(typeof m.ms === "number") V.endsAt = t + m.ms/1000;
    (m.p || []).forEach(function(e){
      if(!Array.isArray(e) || e.length < 10) return;
      var uid = slotUid(e[0]); if(!uid) return;
      var P = V.players[uid]; if(!P) return;
      var f = e[8]|0;
      P.hp = e[6]|0; P.w = e[7]|0; P.prot = !!(f & 2); P.away = !!(f & 4); P.gone = !!(f & 8);
      if(uid === myId()){ V.hp = e[6]|0; V.prot = !!(f & 2); if(f & 1) V.dead = true; return; }
      if(f & 1){ if(!P.dead) P.deadAt = t; P.dead = true; } else if(P.dead){ P.dead = false; P.snaps.length = 0; P.last = -1; }
      pushSnap(P, e, t);
    });
    (m.s || []).forEach(function(s){
      if(!Array.isArray(s) || s.length < 7) return;
      var shooter = slotUid(s[0]), end = [s[2]/100, s[3]/100, s[4]/100];
      if(shooter === myId()){
        if(s[5] >= 0){ V.hitAt = t; if(s[6]) V.headAt = t; }
        return;
      }
      var P = V.players[shooter];
      if(P) addTracer(muzzleOf(P), end, s[1]|0, t, false);
      if(s[5] === V.mySlot && P){
        V.hurtAt = t; V.hurtDir = Math.atan2(P.x - V.me.x, -(P.z - V.me.z)) - V.yaw;
      }
    });
  }
  function onError(m){
    var e = String(m.error || "");
    if(/unknown game/.test(e)){ V.unsupported = true; renderMenu(); return true; }
    return false;
  }

  /* ---------- remote players: snapshot interpolation on the server's clock ---------- */
  function pushSnap(P, e, t){
    var key = e[9]|0;
    if(key < 0 || (P.last >= 0 && key <= P.last)) return;
    P.last = key;
    var st = key/1000;
    E.jitter(P, V.off === null ? 0 : clamp(t - (st + V.off), 0, JIT_MAX));
    var sn = P.snaps, x = e[1]/100, y = e[2]/100, z = e[3]/100, L = sn[sn.length - 1];
    var tp = L && (Math.abs(x - L.x) > 6 || Math.abs(z - L.z) > 6);
    if(tp) sn.length = 0;
    sn.push({t: st, x: x, y: y, z: z, yaw: (e[4]|0)*Math.PI/18000, pitch: (e[5]|0)*Math.PI/18000});
    if(sn.length > SNAPS) sn.shift();
    if(tp || sn.length === 1){ P.x = x; P.y = y; P.z = z; P.yaw = sn[sn.length - 1].yaw; }
  }
  function sampleSnaps(P, t, dt){
    var sn = P.snaps, n = sn.length; if(!n || V.off === null) return;
    var rt = t - V.off - INTERP - P.jit, x, y, z, yaw, pitch;
    P.seen = rt;
    if(rt <= sn[0].t){ x = sn[0].x; y = sn[0].y; z = sn[0].z; yaw = sn[0].yaw; pitch = sn[0].pitch; }
    else if(rt >= sn[n-1].t){ var L = sn[n-1]; x = L.x; y = L.y; z = L.z; yaw = L.yaw; pitch = L.pitch; P.seen = L.t; }
    else {
      for(var i = n - 1; i > 0 && sn[i-1].t > rt; i--){}
      var A = sn[i-1], B = sn[i], u = (rt - A.t)/((B.t - A.t) || 1);
      x = A.x + (B.x - A.x)*u; y = A.y + (B.y - A.y)*u; z = A.z + (B.z - A.z)*u; yaw = angLerp(A.yaw, B.yaw, u); pitch = A.pitch + (B.pitch - A.pitch)*u;
    }
    var sp = dt > 0 ? Math.sqrt((x - P.x)*(x - P.x) + (z - P.z)*(z - P.z))/dt : 0;
    P.moving += ((sp > 0.6 ? 1 : 0) - P.moving)*Math.min(1, dt*8);
    P.x = x; P.y = y; P.z = z; P.yaw = yaw; P.pitch = pitch;
  }
  function muzzleOf(P){ var f = FS.dirOf(P.yaw*180/Math.PI, 0); return [P.x + f[0]*0.5 - f[2]*0.2, P.y + 1.25, P.z + f[2]*0.5 + f[0]*0.2]; }

  /* ---------- shooting ---------- */
  function eye(){ return [V.me.x, V.me.y + FS.EYE, V.me.z]; }
  function myMuzzle(){
    var f = FS.dirOf(V.yaw*180/Math.PI, V.pitch*180/Math.PI), r = [Math.cos(V.yaw), 0, Math.sin(V.yaw)], e = eye();
    return [e[0] + f[0]*0.55 + r[0]*0.22, e[1] + f[1]*0.55 - 0.2, e[2] + f[2]*0.55 + r[2]*0.22];
  }
  function canShoot(t){
    if(V.dead || V.paused) return false;
    if(V.mode === "mp" && V.phase !== "round") return false;
    if(V.mode === "practice" && V.phase !== "round") return false;
    return t >= V.readyAt && t >= V.nextShot && !V.reloadAt && V.mag[V.w] > 0;
  }
  function startReload(t){
    var w = V.w, wp = FS.WEAPONS[w];
    if(V.reloadAt || V.mag[w] >= wp.mag || V.res[w] <= 0 || V.dead) return;
    V.reloadAt = t + wp.reload;
    if(V.mode === "mp" && MP) MP.send("fps", "reload", {q: myClock(), e: V.life});
    say("Reloading");
  }
  function finishReload(t){
    if(V.reloadAt && t >= V.reloadAt){
      var w = V.w, take = Math.min(FS.WEAPONS[w].mag - V.mag[w], V.res[w]);
      V.mag[w] += take; V.res[w] -= take; V.reloadAt = 0;
    }
  }
  function switchTo(w, t){
    w = clamp(w|0, 0, FS.WEAPONS.length - 1);
    if(w === V.w || V.dead) return;
    V.w = w; V.reloadAt = 0; V.readyAt = t + SWITCH;
    if(V.mode === "mp" && MP) MP.send("fps", "weapon", {w: w, q: myClock()});
    say(FS.WEAPONS[w].name);
  }
  // Fire one shot: drawn at once; in a match the server says whether it hit.
  function fire(t){
    var wp = W(), e = eye();
    E.sfx("shot", {w: V.w});
    V.mag[V.w]--; V.nextShot = t + wp.interval; V.n++; V.shots++;
    V.flashAt = t; V.kick = calm() ? 0.15 : 1;
    var sp = FS.spreadOf(V.n, V.w), yawD = V.yaw*180/Math.PI, pitD = V.pitch*180/Math.PI;
    var d = FS.dirOf(yawD + sp[0], clamp(pitD + sp[1], -PITCH_MAX, PITCH_MAX));
    var reach = FS.rayMap(CURMAP, e, d, wp.range), end = reach, aimed = null;
    if(V.mode === "practice"){
      V.drones.forEach(function(D){
        if(D.downUntil > t) return;
        var c = dronePos(D, t - V.startAt), b = [c[0]-0.45, c[1]-0.45, c[2]-0.45, c[0]+0.45, c[1]+0.45, c[2]+0.45], h = FS.rayBox(e, d, b);
        if(h !== null && h < end){ end = h; aimed = D; }
      });
      if(aimed){ aimed.downUntil = t + 1.5; V.score++; V.hitAt = t; }
    } else {
      others().forEach(function(P){
        if(P.dead || P.gone) return;
        var h = FS.rayPlayer(e, d, P.x, P.y, P.z, end);
        if(h){ end = h[0]; aimed = P; }
      });
      // the delay you were seeing the others with: the target's if you aimed at one
      var avg = 0, n = 0; if(V.off !== null) others().forEach(function(P){ if(P.snaps.length){ avg += t - V.off - P.seen; n++; } });
      var ip = aimed && V.off !== null ? t - V.off - aimed.seen : n ? avg/n : INTERP;
      var msg = {w: V.w, ox: Math.round(e[0]*100), oy: Math.round(e[1]*100), oz: Math.round(e[2]*100),
                 r: Math.round(((yawD % 360) + 360) % 360*100), p: Math.round(pitD*100), q: myClock(), ip: Math.round(clamp(ip, 0, 1)*1000), e: V.life};
      if(V.k !== null){ msg.k = V.k; msg.kq = V.kq; }
      if(MP) MP.send("fps", "fire", msg);
    }
    addTracer(myMuzzle(), [e[0] + d[0]*end, e[1] + d[1]*end, e[2] + d[2]*end], V.w, t, true);
    if(V.mag[V.w] <= 0) startReload(t);
  }
  function addTracer(a, b, w, t, mine){
    V.tracers.push({a: a, b: b, w: w, at: t, mine: mine});
    if(V.tracers.length > 40) V.tracers.shift();
    if(R3) R3.tracer(a, b, w, mine);
  }

  /* ---------- the loop ---------- */
  var sendKeyAt = 0;
  function update(dt, t){
    if(!CURMAP) return;
    if(IN) IN.poll();
    var locked = !!(IN && IN.locked), focused = !!(canvas && document.activeElement === canvas);
    var playing = V.phase === "round" || V.phase === "warmup";
    pauseBox.classList.toggle("hidden", !(playing && !locked && !focused));
    V.paused = V.mode === "practice" && ((playing && !locked && !focused) || !!V.hqPaused);
    if(IN && IN.pressed("help")){ var s = fsave(); s.keysHidden = !s.keysHidden; api.persist(); renderKeys(); }
    if(IN && IN.pressed("score")){ V.board = !V.board; renderBoard(); }
    if(V.phase === "warmup"){
      var left = Math.ceil(V.goAt - t);
      if(left > 0 && left <= 5 && center.textContent !== String(left)){ flashCenter(String(left)); say(String(left)); }
      if(V.mode === "practice" && t >= V.goAt){ V.phase = "round"; V.startAt = t; flashCenter("Go!"); say("Go!"); }
    }
    if(V.mode === "practice" && V.phase === "round"){
      if(V.paused){ V.endsAt += dt; V.startAt += dt; }
      else if(t >= V.endsAt){ endPractice(); }
    }
    // look
    if(IN && !V.paused){
      var lk = IN.look();
      V.yaw += lk.dx*LOOK; V.pitch = clamp(V.pitch - lk.dy*LOOK, -PITCH_MAX*Math.PI/180, PITCH_MAX*Math.PI/180);
      V.yaw += ((IN.down("turnR") ? 1 : 0) - (IN.down("turnL") ? 1 : 0))*TURN_KEYS*dt;
    }
    var canMove = !V.watch && !V.dead && !V.paused && (V.phase === "round" || (V.mode === "practice" && V.phase === "warmup"));
    var ax = canMove && IN ? IN.axis("x") : 0, ay = canMove && IN ? IN.axis("y") : 0;
    var fx = Math.sin(V.yaw), fz = -Math.cos(V.yaw), rx = Math.cos(V.yaw), rz = Math.sin(V.yaw);
    var wx = fx*ay + rx*ax, wz = fz*ay + rz*ax, wl = Math.sqrt(wx*wx + wz*wz); if(wl > 1){ wx /= wl; wz /= wl; }
    var jump = canMove && IN && IN.down("jump");
    if(V.phase !== "idle" && V.phase !== "done" && !V.dead){
      acc += dt;
      while(acc >= STEP){ FS.move(CURMAP, V.me, wx, wz, jump, STEP); acc -= STEP; }
    } else acc = 0;
    var spd = Math.sqrt(V.me.vx*V.me.vx + V.me.vz*V.me.vz);
    V.bob += spd*dt*1.6;
    // weapons
    finishReload(t);
    if(IN && !V.paused && !V.dead && !V.watch){
      if(IN.pressed("w1")) switchTo(0, t);
      if(IN.pressed("w2")) switchTo(1, t);
      if(IN.pressed("swap")) switchTo(1 - V.w, t);
      var wh = IN.wheel(); if(wh) switchTo(1 - V.w, t);
      if(IN.pressed("reload")) startReload(t);
      var trig = (IN.mouse[0] && locked) || IN.down("shoot") || IN.down("trig");
      var want = W().auto ? trig : trig && !V.trigWas;
      V.trigWas = trig;
      if(want && canShoot(t)) fire(t);
      else if(want && V.mag[V.w] <= 0 && !V.reloadAt) startReload(t);
    }
    V.kick = Math.max(0, V.kick - dt*8);
    // pickups (practice: ammo refills locally; in a match the server decides)
    if(V.mode === "practice" && V.phase === "round") CURMAP.pickups.forEach(function(pk, i){
      if(!V.items[i] || pk.kind !== "ammo") return;
      if(Math.abs(V.me.x - pk.at[0]) < 1.1 && Math.abs(V.me.z - pk.at[2]) < 1.1 && Math.abs(V.me.y - pk.at[1]) < 1.2){
        V.res = [FS.WEAPONS[0].reserve*2, FS.WEAPONS[1].reserve*2]; V.items[i] = 0; V.itemBack = V.itemBack || {}; V.itemBack[i] = t + 15; say("Ammo pack");
      }
    });
    if(V.mode === "practice" && V.itemBack) Object.keys(V.itemBack).forEach(function(i){ if(t >= V.itemBack[i]){ V.items[i] = 1; delete V.itemBack[i]; } });
    others().forEach(function(P){ sampleSnaps(P, t, dt); });
    if(!V.watch) sendPos(t);
    if(V.dead && V.mode === "mp"){ var rl = Math.max(0, Math.ceil(V.deadAt + RESPAWN - t)); var txt = rl > 0 ? "Respawning in "+rl : "Respawning…";
      if(center.textContent !== txt){ center.textContent = txt; center.classList.remove("hidden"); center.dataset.until = ""; } }
    if(center.dataset.until && t > +center.dataset.until){ center.classList.add("hidden"); center.dataset.until = ""; }
  }
  function sendPos(t){
    if(V.mode !== "mp" || !MP || V.phase !== "round" || V.dead || V.offline) return;
    var M = V.me, x = Math.round(M.x*100), y = Math.round(M.y*100), z = Math.round(M.z*100);
    var r = Math.round((((V.yaw*180/Math.PI) % 360) + 360) % 360*100), p = Math.round(V.pitch*18000/Math.PI);
    var key = x+","+y+","+z+","+r+","+p;
    if(t - V.sendAt < SEND_EVERY) return;
    if(key === V.sentKey && t - V.sendAt < KEEPALIVE) return;
    V.sendAt = t; V.sentKey = key;
    var msg = {x: x, y: y, z: z, r: r, p: p, q: myClock(), e: V.life};
    if(V.k !== null){ msg.k = V.k; msg.kq = V.kq; }
    MP.send("fps", "pos", msg);
  }
  function flashCenter(txt){ center.textContent = txt; center.classList.remove("hidden"); center.dataset.until = String(now() + 1.0); }

  /* ---------- HUD ---------- */
  function hudUpdate(t){
    if(WB) WB.update();
    var wp = W(), hp = V.mode === "practice" ? 100 : clamp(V.hp, 0, 100);
    hpBar.style.width = hp+"%"; hpBox.classList.toggle("low", hp <= 30);
    var ht = String(hp); if(hpNum.textContent !== ht) hpNum.textContent = ht;
    var at = V.reloadAt ? "…" : String(V.mag[V.w]); at += " / "+V.res[V.w];
    if(ammoNum.textContent !== at) ammoNum.textContent = at;
    if(ammoName.textContent !== wp.name) ammoName.textContent = wp.name;
    reloadBar.style.width = V.reloadAt ? Math.round(100*clamp(1 - (V.reloadAt - t)/wp.reload, 0, 1))+"%" : "0";
    var tt;
    if(V.mode === "practice" && V.walk) tt = "Walk-through · "+CURMAP.name+" · spawn "+(V.spawnI + 1)+"/"+CURMAP.spawns.length;
    else if(V.mode === "practice") tt = (V.phase === "round" ? mmss((V.endsAt - t)*1000) : V.phase === "warmup" ? mmss(PRACTICE_SECS*1000) : "0:00")+" · "+V.score+(V.score === 1 ? " drone" : " drones");
    else {
      var lead = 0; V.order.forEach(function(u){ lead = Math.max(lead, V.players[u].kills|0); });
      tt = (V.phase === "round" ? mmss((V.endsAt - t)*1000) : V.phase === "done" ? "0:00" : mmss(V.minutes*60000))+" · you "+V.kills+" · top "+lead+"/"+V.limit;
    }
    if(topBox.textContent !== tt) topBox.textContent = tt;
    hitm.classList.toggle("on", t - V.hitAt < 0.15); hitm.classList.toggle("head", t - V.headAt < 0.15);
    var hurtOn = t - V.hurtAt < 0.8;
    hurt.classList.toggle("on", hurtOn);
    if(hurtOn) hurt.style.transform = "translate(-50%,-50%) rotate("+Math.round(V.hurtDir*180/Math.PI)+"deg)";
    vignette.classList.toggle("on", !calm() && t - V.hurtAt < 0.25);
    cross.classList.toggle("wide", V.w === 0);
    root.classList.toggle("vg-fps-dead", V.dead);
    if(V.feed.length && t - V.feed[V.feed.length - 1].at > 6){ V.feed = V.feed.filter(function(f){ return t - f.at <= 6; }); renderFeed(); }
  }
  function renderFeed(){
    feedBox.textContent = "";
    V.feed.forEach(function(f){
      var li = api.mk("li", f.mine ? "me" : null);
      li.appendChild(api.mk("b", null, f.k));
      li.appendChild(api.mk("span", "vg-fps-w", " "+(f.w ? "heavy" : "rapid")+(f.hs ? " · head" : "")+" "));
      li.appendChild(api.mk("b", null, f.v)); feedBox.appendChild(li);
    });
  }
  function renderBoard(){
    board.classList.toggle("hidden", !V.board);
    if(!V.board) return;
    board.textContent = "";
    board.appendChild(api.mk("b", null, V.mode === "practice" ? "Target range" : "Scores · first to "+V.limit));
    var tb = api.mk("table", "vg-golf-table"), hr = api.mk("tr");
    (V.mode === "practice" ? ["", "Drones", "Shots"] : ["Player", "Kills", "Deaths"]).forEach(function(h){ hr.appendChild(api.mk("th", null, h)); }); tb.appendChild(hr);
    var rows = V.mode === "practice" ? [{name: "You", kills: V.score, deaths: V.shots, uid: "me"}] :
      V.order.map(function(u){ return V.players[u]; }).sort(function(a, b){ return (b.kills - a.kills) || (a.deaths - b.deaths) || (a.slot - b.slot); });
    rows.forEach(function(P){
      var tr = api.mk("tr");
      tr.appendChild(api.mk("td", P.uid === myId() ? "tot" : null, P.name+(P.gone ? " (left)" : P.away ? " (away)" : "")));
      tr.appendChild(api.mk("td", null, String(P.kills|0))); tr.appendChild(api.mk("td", null, String(P.deaths|0)));
      tb.appendChild(tr);
    });
    board.appendChild(tb);
    board.appendChild(api.btn("Close", "", function(){ V.board = false; renderBoard(); if(canvas) canvas.focus(); }));
  }
  function resultsTable(rows, title){
    var box = api.mk("div", "vg-golf-score");
    box.appendChild(api.mk("b", null, title));
    var tb = api.mk("table", "vg-golf-table"), hr = api.mk("tr");
    ["#", "Player", "Kills", "Deaths"].forEach(function(h){ hr.appendChild(api.mk("th", null, h)); }); tb.appendChild(hr);
    (rows || []).forEach(function(r){
      var tr = api.mk("tr");
      tr.appendChild(api.mk("td", null, String(r.place|0)));
      tr.appendChild(api.mk("td", r.user && r.user.userId === myId() ? "tot" : null, nameOf(r.user)+(r.left ? " (left)" : "")));
      tr.appendChild(api.mk("td", null, String(r.kills|0))); tr.appendChild(api.mk("td", null, String(r.deaths|0)));
      tb.appendChild(tr);
    });
    box.appendChild(tb); return box;
  }
  function showResults(rows){
    cardBox.textContent = "";
    cardBox.appendChild(resultsTable(rows, "Match over · "+CURMAP.name));
    var row = api.mk("div", "vg-row");
    row.appendChild(api.btn(isHost() ? "Set up the next match" : "Back to the lobby", "primary", function(){ resetMatch(); showStage(false); renderMenu(); }));
    cardBox.appendChild(row); cardBox.classList.remove("hidden");
    var mine = (rows || []).filter(function(r){ return r.user && r.user.userId === myId(); })[0];
    if(mine) say("Match over: place "+mine.place+", "+mine.kills+" kills, "+mine.deaths+" deaths.");
  }

  /* ---------- renderers ---------- */
  function ensureRenderer(){
    if(canvas) return;
    wrap.textContent = "";
    pauseBox.textContent = "";
    pauseBox.appendChild(api.mk("b", null, "Paused"));
    pauseBox.appendChild(api.mk("span", null, "Click here to play (the mouse aims; Esc gives it back), or Tab here to play with the keyboard."));
    [hud, board, cardBox, pauseBox, badge, load].forEach(function(n){ wrap.appendChild(n); });
    canvas = api.mk("canvas", "vg-golf-canvas vg-fps-canvas"); canvas.tabIndex = 0;
    canvas.setAttribute("aria-label", "Blaster Arena, first person. Click to aim with the mouse, Escape releases it. W A S D move, Q and E turn, F or click fires, R reloads, 1 and 2 pick a blaster, Space jumps.");
    wrap.insertBefore(canvas, wrap.firstChild);
    if(IN) IN.destroy();
    IN = HQV.input ? HQV.input.create(wrap, {look: true, wheel: true, sensitivity: V.sens, buttons: BUTTONS}) : null;
    canvas.addEventListener("pointerdown", function(){ canvas.focus(); });
    pauseBox.addEventListener("click", function(){ if(canvas){ canvas.focus(); if(IN) IN.lock(); } });
    resize();
    if(!V.map && hasWebGL2()){
      R2 = make2d(null);
      load.classList.remove("hidden"); loadFill.style.width = "10%";
      make3d(canvas).then(function(r){
        load.classList.add("hidden");
        if(!V.alive){ r.dispose(); return; }
        R3 = r; R2 = null; R3.buildMap(); resize();
      }, function(e){
        load.classList.add("hidden");
        if(!V.alive) return;
        if(window.console) console.warn("fps 3d", e);
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
    var w = Math.max(280, wrap.clientWidth || host.clientWidth || 640), h = Math.round(Math.min(w*0.6, (window.innerHeight || 800)*0.72));
    canvas.style.height = h+"px";
    if(R3) R3.size(w, h);
    else if(R2 && R2.canvas){ var dpr = Math.min(window.devicePixelRatio || 1, 2); canvas.width = Math.round(w*dpr); canvas.height = Math.round(h*dpr); }
  }
  var hudAt = 0;
  function frame(ts){
    if(!V.alive) return;
    raf = requestAnimationFrame(frame);
    var t = ts/1000, dt = lastT ? clamp(t - lastT, 0, 0.1) : 0; lastT = t;
    try {
      if(t - tokAt > 2){ TOK = tokens(); tokAt = t; }
      var tn = now();
      update(dt, tn);
      if(R3) R3.render(dt, tn); else if(R2) R2.render(tn);
      if(t - hudAt > 0.05){ hudAt = t; hudUpdate(tn); }
    } catch(e){ if(window.console) console.error("fps frame", e); }
  }
  function onTab(e){
    if(e.code !== "Tab" || !IN || !IN.locked) return;
    e.preventDefault();
    if(e.type === "keydown" && !e.repeat){ V.board = true; renderBoard(); }
    if(e.type === "keyup"){ V.board = false; renderBoard(); }
  }
  window.addEventListener("keydown", onTab, true);
  window.addEventListener("keyup", onTab, true);

  // 2D map view: north-up, centred on you, your view as a wedge.
  function make2d(cv){
    var R = {canvas: cv};
    R.render = function(t){
      if(!cv) return;
      var g = cv.getContext("2d"), Wd = cv.width, Ht = cv.height, T = TOK;
      g.setTransform(1, 0, 0, 1, 0, 0); g.fillStyle = T.bg2; g.fillRect(0, 0, Wd, Ht);
      if(!CURMAP){ g.fillStyle = T.muted; g.font = "14px sans-serif"; g.fillText("Loading…", 16, 24); return; }
      var sc = Math.min(Wd, Ht)/34, M = V.me;
      g.save(); g.translate(Wd/2, Ht/2); g.scale(sc, sc); g.translate(-M.x, -M.z);
      CURMAP.boxes.forEach(function(b){
        if(b[4] <= 0) { g.fillStyle = T.panel2; g.fillRect(b[0], b[2], b[3] - b[0], b[5] - b[2]); return; }
        g.globalAlpha = clamp(0.35 + b[4]/5, 0.35, 1); g.fillStyle = b[6] === "wall" ? T.ink : T.muted;
        g.fillRect(b[0], b[2], b[3] - b[0], b[5] - b[2]); g.globalAlpha = 1;
      });
      CURMAP.pickups.forEach(function(pk, i){ if(!V.items[i]) return; g.fillStyle = pk.kind === "health" ? T.need : T.gold; g.beginPath(); g.arc(pk.at[0], pk.at[2], 0.4, 0, Math.PI*2); g.fill(); });
      V.drones.forEach(function(D){ if(D.downUntil > t) return; var c = dronePos(D, (V.phase === "round" ? t - V.startAt : 0)); g.fillStyle = T.need; g.fillRect(c[0] - 0.45, c[2] - 0.45, 0.9, 0.9); });
      V.tracers.forEach(function(tr){ var age = t - tr.at; if(age > 0.12) return; g.strokeStyle = tr.mine ? T.gold : T.need; g.lineWidth = 0.08; g.beginPath(); g.moveTo(tr.a[0], tr.a[2]); g.lineTo(tr.b[0], tr.b[2]); g.stroke(); });
      others().forEach(function(P){
        if(P.gone) return;
        g.globalAlpha = P.dead ? 0.3 : 1; g.fillStyle = CHAR_SWATCH[P.ch|0] || T.brand;
        g.beginPath(); g.arc(P.x, P.z, 0.45, 0, Math.PI*2); g.fill();
        g.strokeStyle = T.ink; g.lineWidth = 0.08; g.beginPath(); g.moveTo(P.x, P.z); g.lineTo(P.x + Math.sin(P.yaw)*0.8, P.z - Math.cos(P.yaw)*0.8); g.stroke();
        g.globalAlpha = 1; g.fillStyle = T.ink; g.font = "0.6px sans-serif"; g.textAlign = "center"; g.fillText(P.name, P.x, P.z - 0.7);
      });
      // me + the view wedge
      g.fillStyle = T.brand; g.globalAlpha = 0.18; g.beginPath(); g.moveTo(M.x, M.z);
      g.arc(M.x, M.z, 12, V.yaw - Math.PI/2 - 0.5, V.yaw - Math.PI/2 + 0.5); g.closePath(); g.fill(); g.globalAlpha = 1;
      g.beginPath(); g.arc(M.x, M.z, 0.45, 0, Math.PI*2); g.fill();
      g.restore();
    };
    return R;
  }

  function make3d(cv){
    return fpsLib().then(function(lib){
      var names = [["fps", "platform-large-grass"], ["fps", "platform"], ["fps", "wall-high"], ["fps", "wall-low"], ["fps", "blaster"],
                   ["fps", "blaster-repeater"], ["fps", "enemy-flying"], ["fps", "cloud"], ["fps", "grass"]]
        .concat(CHARS.map(function(c){ return ["golf", c.f]; }));
      var done = 0, GL = {};
      function tex(n){ return new Promise(function(res){ lib.tex.load("/games/fps/"+n+".png", res, null, function(){ res(null); }); }); }
      return Promise.all(names.map(function(n){ return loadGlb(lib, n[0], n[1]).then(function(g){ GL[n[1]] = g; done++; loadFill.style.width = Math.round(10 + 85*done/names.length)+"%"; }); }))
        .then(function(){ return Promise.all([tex("burst"), tex("hit")]); })
        .then(function(tx){ return build3d(lib, lib.THREE, cv, GL, tx[0], tx[1]); });
    });
  }
  function build3d(lib, THREE, cv, GL, burstTex, hitTex){
    var renderer = new THREE.WebGLRenderer({canvas: cv, antialias: !V.low});
    renderer.setPixelRatio(V.low ? 1 : Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = !V.low; renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.autoClear = false;
    var scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(75, 1.6, 0.05, 300);
    var hemi = new THREE.HemisphereLight(0xffffff, 0x667755, 2.1); scene.add(hemi);
    var sun = new THREE.DirectionalLight(0xffffff, 1.8); sun.position.set(14, 30, 10);
    sun.castShadow = !V.low; sun.shadow.mapSize.set(2048, 2048); sun.shadow.bias = -0.0005; sun.shadow.normalBias = 0.03;
    var sc = sun.shadow.camera; sc.left = -28; sc.right = 28; sc.top = 28; sc.bottom = -28; sc.near = 1; sc.far = 80;
    scene.add(sun); scene.add(sun.target);
    // the first-person blaster: its own scene and camera, drawn over the world
    var vScene = new THREE.Scene(), vCam = new THREE.PerspectiveCamera(50, 1.6, 0.01, 10);
    vScene.add(new THREE.HemisphereLight(0xffffff, 0x667755, 2.3));
    var vSun = new THREE.DirectionalLight(0xffffff, 1.4); vSun.position.set(2, 3, 2); vScene.add(vSun);
    var GUN_S = 0.2, guns = [model("blaster-repeater"), model("blaster")], gunHold = new THREE.Group(); vScene.add(gunHold);
    var mySkin = window.HQ_MYCOS && hex(window.HQ_MYCOS.blaster, null);       // HQ 2.1: the blaster skin you wear
    guns.forEach(function(g, i){ g.traverse(function(n){ if(n.isMesh){ n.castShadow = false; n.receiveShadow = false;
      if(mySkin != null){ n.material = n.material.clone(); n.material.color.setHex(mySkin); } } });
      g.scale.setScalar(GUN_S); g.rotation.y = Math.PI; g.visible = i === 0; gunHold.add(g); });
    var flash = null;
    if(burstTex){
      burstTex.colorSpace = THREE.SRGBColorSpace; burstTex.repeat.set(0.5, 1);
      flash = new THREE.Sprite(new THREE.SpriteMaterial({map: burstTex, transparent: true, depthTest: false, blending: THREE.AdditiveBlending}));
      // at the muzzle: the front face of the blaster's bounds (it looks down -z here)
      gunHold.updateMatrixWorld(true);
      var gb = new THREE.Box3().setFromObject(guns[0]);
      flash.position.set((gb.min.x + gb.max.x)/2, gb.min.y + (gb.max.y - gb.min.y)*0.62, gb.min.z - 0.02);
      flash.visible = false; gunHold.add(flash);
    }
    var mapGroup = null, dyn = new THREE.Group(); scene.add(dyn);
    var lost = function(e){ e.preventDefault(); if(V.alive) setTimeout(fallback2d, 0); };
    cv.addEventListener("webglcontextlost", lost);
    function model(name){
      var g = GL[name]; if(!g) return new THREE.Group();
      var o = lib.clone(g.scene);
      o.traverse(function(m){ if(m.isMesh){ m.castShadow = !V.low; m.receiveShadow = !V.low; } });
      return o;
    }
    function bbox(name){ var g = GL[name]; return g ? new THREE.Box3().setFromObject(g.scene) : new THREE.Box3(new THREE.Vector3(-0.5, 0, -0.5), new THREE.Vector3(0.5, 1, 0.5)); }
    var BB = {};
    // A solid box drawn as kit pieces, tiled so they keep their proportions roughly.
    var KIND = {floor: ["platform-large-grass", 8.8], block: ["platform", 2.2], step: ["platform", 1.0], crate: ["platform", 1.2],
                low: ["wall-low", 2.2], wall: ["wall-high", 1.5]};
    function boxModel(b){
      var k = KIND[b[6]] || KIND.block, name = k[0], bb = BB[name] || (BB[name] = bbox(name));
      var sx = b[3] - b[0], sy = b[4] - b[1], sz = b[5] - b[2], g = new THREE.Group();
      var along = name.indexOf("wall") === 0 && sz > sx;           // walls: the long side runs along x in the model
      var L = along ? sz : sx, D = along ? sx : sz;
      var nL = Math.max(1, Math.round(L/k[1])), nD = name.indexOf("wall") === 0 ? 1 : Math.max(1, Math.round(D/k[1]));
      var mw = bb.max.x - bb.min.x, mh = bb.max.y - bb.min.y, md = bb.max.z - bb.min.z;
      for(var i = 0; i < nL; i++) for(var j = 0; j < nD; j++){
        var o = model(name), tl = L/nL, td = D/nD, ov = name.indexOf("wall") === 0 ? 1.12 : 1.04;
        o.scale.set(tl*ov/mw, sy/mh, td*(name.indexOf("wall") === 0 ? 1 : ov)/md);
        var cl = -L/2 + tl*(i + 0.5), cd = -D/2 + td*(j + 0.5);
        o.position.set(along ? cd : cl, -bb.min.y*sy/mh, along ? cl : cd);
        if(along) o.rotation.y = Math.PI/2;
        o.position.x -= (bb.min.x + bb.max.x)/2*(along ? 0 : tl/mw); o.position.z -= (bb.min.z + bb.max.z)/2*(along ? 0 : td/md);
        g.add(o);
      }
      g.position.set((b[0] + b[3])/2, b[1], (b[2] + b[5])/2);
      return g;
    }
    function hash(a, b){ var h = (a*73856093) ^ (b*19349663); h = (h ^ (h >>> 13))*1274126177; return ((h ^ (h >>> 16)) >>> 0)/4294967296; }
    var pickMeshes = [], droneMeshes = [];
    function buildMap(){
      if(mapGroup){ scene.remove(mapGroup); }
      mapGroup = new THREE.Group(); scene.add(mapGroup);
      var th = CURMAP.theme || {};
      scene.background = new THREE.Color(hex(th.sky, 0x9fd3f0));
      scene.fog = new THREE.Fog(hex(th.fog, 0xcfe8f2), V.low ? 25 : 40, V.low ? 70 : 140);
      var under = new THREE.Mesh(new THREE.PlaneGeometry(400, 400).rotateX(-Math.PI/2), new THREE.MeshLambertMaterial({color: hex(th.ground, 0x6fb35a)}));
      under.position.y = -1.2; mapGroup.add(under);
      CURMAP.boxes.forEach(function(b){ mapGroup.add(boxModel(b)); });
      if(!V.low){
        // grass tufts and clouds, placed by a fixed hash so everyone sees the same arena
        var own = CURMAP !== BUILTIN, bd = CURMAP.bounds || [];
        for(var i = 0; i < 70; i++){
          var x = -20 + hash(i, 7)*40, z = -20 + hash(i, 13)*40;
          if(own){ x = bd[0] + hash(i, 7)*(bd[3] - bd[0]); z = bd[2] + hash(i, 13)*(bd[5] - bd[2]); }
          if(FS.overlaps(CURMAP, x, 0.05, z, 0.2) >= 0) continue;
          if(own && FS.topUnder(CURMAP, x, -0.05, z) !== 0) continue;
          var gr = model("grass"); gr.position.set(x, 0, z); gr.rotation.y = hash(i, 3)*6.28; gr.scale.setScalar(1.4); mapGroup.add(gr);
        }
        for(var c = 0; c < 9; c++){
          var cl = model("cloud"), a = c/9*Math.PI*2, r = 45 + hash(c, 5)*25;
          cl.position.set(Math.cos(a)*r, 14 + hash(c, 9)*10, Math.sin(a)*r); cl.scale.set(6 + hash(c, 2)*5, 3 + hash(c, 4)*2, 5 + hash(c, 6)*4);
          cl.traverse(function(n){ if(n.isMesh) n.castShadow = false; }); mapGroup.add(cl);
        }
      }
      pickMeshes.forEach(function(p){ scene.remove(p); }); pickMeshes = [];
      CURMAP.pickups.forEach(function(pk){
        var gp = new THREE.Group(), base = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5),
          new THREE.MeshLambertMaterial({color: pk.kind === "health" ? 0xf4f4f4 : 0x3c7a3a}));
        gp.add(base);
        if(pk.kind === "health"){
          var red = new THREE.MeshLambertMaterial({color: 0xe0574a});
          gp.add(new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.14, 0.36), red)); gp.add(new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.36, 0.52), red).rotateY(0));
          gp.add(new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.14, 0.52), red)); gp.add(new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.52, 0.36), red));
        } else {
          var gold = new THREE.MeshLambertMaterial({color: 0xe0b325});
          gp.add(new THREE.Mesh(new THREE.BoxGeometry(0.54, 0.12, 0.54), gold));
        }
        gp.position.set(pk.at[0], pk.at[1] + 0.55, pk.at[2]); scene.add(gp); pickMeshes.push(gp);
      });
      droneMeshes.forEach(function(d){ scene.remove(d); }); droneMeshes = [];
      CURMAP.targets.forEach(function(){ var d = model("enemy-flying"); d.scale.setScalar(1.5); d.visible = false; scene.add(d); droneMeshes.push(d); });
    }
    function tag(text, color){
      var c = document.createElement("canvas"), g = c.getContext("2d"); c.width = 256; c.height = 64;
      g.font = "700 30px sans-serif"; g.textAlign = "center"; g.textBaseline = "middle";
      var w = Math.min(250, g.measureText(text).width + 40);
      g.fillStyle = "rgba(20,24,32,0.72)"; g.beginPath(); if(g.roundRect) g.roundRect(128 - w/2, 8, w, 48, 18); else g.rect(128 - w/2, 8, w, 48); g.fill();
      g.fillStyle = color; g.beginPath(); g.arc(128 - w/2 + 18, 32, 7, 0, Math.PI*2); g.fill();
      g.fillStyle = "#ffffff"; g.fillText(text, 136, 33);
      var tx = new THREE.CanvasTexture(c); tx.colorSpace = THREE.SRGBColorSpace;
      var sp = new THREE.Sprite(new THREE.SpriteMaterial({map: tx, depthTest: true, transparent: true})); sp.scale.set(1.6, 0.4, 1); sp.renderOrder = 10;
      return sp;
    }
    var CH_H = null;
    function addPlayer(P){
      var g = GL[CHARS[P.ch|0].f]; if(!g) return;
      if(CH_H === null){ var hb = new THREE.Box3().setFromObject(g.scene); CH_H = Math.max(0.3, hb.max.y - hb.min.y); }
      var o = lib.clone(g.scene), holder = new THREE.Group(); holder.add(o);
      o.scale.setScalar(1.75/CH_H);
      o.traverse(function(n){ if(n.isMesh){ n.castShadow = !V.low; n.frustumCulled = false; } });
      var mixer = new THREE.AnimationMixer(o), acts = {};
      ["idle", "walk", "die"].forEach(function(n){ var cl = THREE.AnimationClip.findByName(g.animations, n); if(cl) acts[n] = mixer.clipAction(cl); });
      if(acts.die){ acts.die.setLoop(THREE.LoopOnce, 1); acts.die.clampWhenFinished = true; }
      // the blaster is held out in front at the right hand (barrel along the model's +z, its facing)
      var gun = [model("blaster-repeater"), model("blaster")];
      var skin = P.cos && hex(P.cos.blaster, null);
      gun.forEach(function(gn, i){ gn.scale.setScalar(0.34); gn.position.set(-0.36, 0.74, 0.3); gn.visible = i === 0; holder.add(gn);
        if(skin != null) gn.traverse(function(n){ if(n.isMesh){ n.material = n.material.clone(); n.material.color.setHex(skin); } }); });
      var tg = tag(P.name.slice(0, 18), CHAR_SWATCH[P.ch|0] || "#ffffff"); tg.position.set(0, 2.15, 0); holder.add(tg);
      P.mesh = {g: holder, mixer: mixer, acts: acts, cur: null, gun: gun, tag: tg, ch: P.ch}; scene.add(holder);
    }
    function setAnim(m, n){
      if(m.cur === n || !m.acts[n]) return;
      var next = m.acts[n], prev = m.acts[m.cur]; next.reset(); next.play();
      if(prev) prev.crossFadeTo(next, calm() ? 0.01 : 0.15, false);
      m.cur = n;
    }
    function removePlayer(P){ if(P && P.mesh){ scene.remove(P.mesh.g); P.mesh.mixer.stopAllAction(); P.mesh = null; } }
    var trMat = [new THREE.LineBasicMaterial({color: 0xffe08a, transparent: true}), new THREE.LineBasicMaterial({color: 0xff9a5a, transparent: true})];
    var tracers = [], puffs = [];
    var hitMat = hitTex ? new THREE.SpriteMaterial({map: hitTex, transparent: true, depthWrite: false}) : null;
    function tracer(a, b, w, mine){
      var geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(a[0], a[1], a[2]), new THREE.Vector3(b[0], b[1], b[2])]);
      var ln = new THREE.Line(geo, trMat[w ? 1 : 0].clone()); dyn.add(ln); tracers.push({o: ln, at: now()});
      if(hitMat && !V.low){ var p = new THREE.Sprite(hitMat.clone()); p.position.set(b[0], b[1], b[2]); p.scale.setScalar(0.35); dyn.add(p); puffs.push({o: p, at: now()}); }
      if(tracers.length > 30){ var x = tracers.shift(); dyn.remove(x.o); x.o.geometry.dispose(); }
    }
    function clearDynamic(){ tracers.concat(puffs).forEach(function(x){ dyn.remove(x.o); }); tracers = []; puffs = []; V.order.forEach(function(u){ removePlayer(V.players[u]); }); }
    var R = {};
    R.buildMap = buildMap; R.removePlayer = removePlayer; R.tracer = tracer; R.clearDynamic = clearDynamic;
    R.size = function(w, h){ renderer.setSize(w, h, false); camera.aspect = w/h; camera.updateProjectionMatrix(); vCam.aspect = w/h; vCam.updateProjectionMatrix(); };
    R.camera = camera;
    R.render = function(dt, t){
      var quiet = calm();
      // others
      others().forEach(function(P){
        if(P.mesh && P.mesh.ch !== P.ch) removePlayer(P);
        if(!P.mesh) addPlayer(P);
        var m = P.mesh; if(!m) return;
        m.g.visible = !P.gone && !(P.dead && t - (P.deadAt || 0) > 1.6);
        m.g.position.set(P.x, P.y, P.z); m.g.rotation.y = Math.PI - P.yaw;
        setAnim(m, P.dead ? "die" : P.moving > 0.5 ? "walk" : "idle");
        if(m.gun){ m.gun[0].visible = (P.w|0) === 0; m.gun[1].visible = (P.w|0) === 1; }
        m.mixer.update(dt);
        m.tag.visible = !P.dead;
      });
      // pickups and drones
      pickMeshes.forEach(function(p, i){ p.visible = !!V.items[i]; if(!quiet) p.rotation.y = t*1.5; p.position.y = CURMAP.pickups[i].at[1] + 0.55 + (quiet ? 0 : Math.sin(t*2 + i)*0.08); });
      droneMeshes.forEach(function(d, i){
        var D = V.drones[i]; d.visible = !!D && V.mode === "practice" && D.downUntil <= t;
        if(!D) return; var c = dronePos(D, V.phase === "round" ? t - V.startAt : 0); d.position.set(c[0], c[1] - 0.3, c[2]);
        d.rotation.y = Math.atan2(V.me.x - c[0], V.me.z - c[2]);
      });
      // effects fade
      for(var i = tracers.length - 1; i >= 0; i--){ var a = t - tracers[i].at; if(a > 0.09){ dyn.remove(tracers[i].o); tracers[i].o.geometry.dispose(); tracers.splice(i, 1); } else tracers[i].o.material.opacity = 1 - a/0.09; }
      for(var j = puffs.length - 1; j >= 0; j--){ var b = t - puffs[j].at; if(b > 0.25){ dyn.remove(puffs[j].o); puffs.splice(j, 1); } else { puffs[j].o.material.opacity = 1 - b/0.25; if(!quiet) puffs[j].o.scale.setScalar(0.35 + b*1.6); } }
      // camera: your eyes (lower when down); spectating, a chase camera behind whoever you watch
      var M = V.me, ey = V.dead ? 0.5 : FS.EYE, WP = V.watch && V.players[V.watch];
      if(WP){
        var fwx = Math.sin(WP.yaw), fwz = -Math.cos(WP.yaw);
        camera.position.set(WP.x - fwx*3.6, WP.y + 2.3, WP.z - fwz*3.6);
        camera.rotation.order = "YXZ"; camera.lookAt(WP.x + fwx*2, WP.y + 1.2, WP.z + fwz*2);
        M = WP;
      } else {
        camera.position.set(M.x, M.y + ey, M.z);
        camera.rotation.order = "YXZ"; camera.rotation.set(V.pitch + (V.dead ? -0.3 : 0), -V.yaw, V.dead && !quiet ? 0.35 : 0);
      }
      sun.position.set(M.x + 14, 30, M.z + 10); sun.target.position.set(M.x, 0, M.z);
      // the blaster in your hands: bob, recoil, a muzzle flash
      guns[0].visible = V.w === 0; guns[1].visible = V.w === 1;
      var spd = Math.sqrt(M.vx*M.vx + M.vz*M.vz), bobA = quiet ? 0 : clamp(spd/FS.RUN, 0, 1)*0.012;
      var rl = V.reloadAt ? clamp((V.reloadAt - t)/W().reload, 0, 1) : 0, dip = V.reloadAt ? Math.sin(rl*Math.PI)*0.25 : 0;
      gunHold.position.set(0.2 + Math.sin(V.bob*2)*bobA, -0.25 - Math.abs(Math.cos(V.bob*2))*bobA - dip*0.3 - (V.dead ? 1 : 0), -0.42 + V.kick*(V.w ? 0.06 : 0.03));
      gunHold.rotation.set(V.kick*(V.w ? 0.12 : 0.05) - dip, 0, 0);
      if(flash){ var fa = t - V.flashAt; flash.visible = fa < (quiet ? 0.03 : 0.05) && !V.dead; flash.scale.setScalar((quiet ? 0.07 : 0.13)*(V.w ? 1.3 : 1)); flash.material.opacity = quiet ? 0.5 : 0.95; flash.material.rotation = V.n*1.3; }
      renderer.clear();
      renderer.render(scene, camera);
      renderer.clearDepth();
      if(!V.watch) renderer.render(vScene, vCam);         // no blaster in your hands while you watch
    };
    R.dispose = function(){
      cv.removeEventListener("webglcontextlost", lost);
      clearDynamic(); renderer.dispose();
      try { var ext = renderer.getContext().getExtension("WEBGL_lose_context"); if(ext) ext.loseContext(); } catch(e){}
    };
    return R;
  }
  function onResize(){ resize(); }
  window.addEventListener("resize", onResize);
  if(typeof ResizeObserver !== "undefined"){ ro = new ResizeObserver(onResize); ro.observe(host); }
  renderKeys();
  renderMenu();
  loadMap().then(function(){ if(!V.alive) return; if(!CURMAP) CURMAP = BUILTIN;
    if(PEND && !PEND.room && V.mode === "practice"){ var pd = PEND.doc; PEND = null; if(startWalk(pd)) return; }
    renderMenu(); if(V.mode === "mp" && V.gotView) applyView(V.round); else if(V.mode === "mp") requestView(); },
    function(){ V.note = "Couldn't load the arena."; renderMenu(); });
  if(!raf) raf = requestAnimationFrame(frame);
  V.destroy = function(){
    if(WB){ WB.destroy(); WB = null; }
    V.alive = false;
    if(raf) cancelAnimationFrame(raf); raf = 0;
    window.removeEventListener("resize", onResize); if(ro) ro.disconnect();
    window.removeEventListener("keydown", onTab, true); window.removeEventListener("keyup", onTab, true);
    if(IN){ IN.destroy(); IN = null; }
    if(R3){ R3.dispose(); R3 = null; }
    root.remove();
  };
  V.onEvent = onEvent; V.onError = onError;
  V.onConn = function(on){
    V.offline = !on; badge.classList.toggle("hidden", on);
    if(!on){ V.off = null; V.k = null; others().forEach(function(P){ P.last = -1; P.snaps.length = 0; }); }
  };
  // Test hooks (the browser smoke tests; headless browsers can't lock the pointer).
  V.startPractice = startPractice;
  V.startWalk = startWalk;
  V.curMap = function(){ return CURMAP; };
  V.rendererKind = function(){ return R3 ? "3d" : R2 && R2.canvas ? "2d" : ""; };
  V.look = function(yawDeg, pitchDeg){ V.yaw = (+yawDeg || 0)*Math.PI/180; V.pitch = clamp(+pitchDeg || 0, -PITCH_MAX, PITCH_MAX)*Math.PI/180; };
  V.aimAt = function(uid){
    var P = V.players[uid]; if(!P) return null;
    var e = eye(), dx = P.x - e[0], dy = P.y + 1.0 - e[1], dz = P.z - e[2];
    V.look(Math.atan2(dx, -dz)*180/Math.PI, Math.atan2(dy, Math.sqrt(dx*dx + dz*dz))*180/Math.PI);
    return [P.x, P.y, P.z];
  };
  V.aimDrone = function(i){
    var D = V.drones[i|0]; if(!D) return null;
    var c = dronePos(D, V.phase === "round" ? now() - V.startAt : 0), e = eye(), dx = c[0] - e[0], dy = c[1] - e[1], dz = c[2] - e[2];
    V.look(Math.atan2(dx, -dz)*180/Math.PI, Math.atan2(dy, Math.sqrt(dx*dx + dz*dz))*180/Math.PI); return c;
  };
  V.shoot = function(){ var t = now(); if(canShoot(t)){ fire(t); return true; } return false; };
  V.reload = function(){ startReload(now()); };
  V.weapon = function(w){ switchTo(w, now()); };
  V.place = function(x, y, z){ placeMe(x, y, z, null); };
  V.showBoard = function(on){ V.board = !!on; renderBoard(); };
  return V;
}

/* ---------- registration: a solo card and a "with friends" card ---------- */
HQV.register({id: "fps", name: "Blaster Arena", icon: "🎯", desc: "Target range: blast the flying drones in 60 seconds",
  mount: function(el){ if(CUR) CUR.destroy(); CUR = makeGame(el, {mode: "practice"}); },
  unmount: function(){ if(CUR){ CUR.destroy(); CUR = null; } },
  pause: function(){ if(CUR) CUR.hqPaused = true; },
  resume: function(){ if(CUR) CUR.hqPaused = false; }});

if(MP){
  MP.handlers.fps = {
    on: function(m){ if(CUR && CUR.ctx) CUR.onEvent(m); },
    onError: function(m){ return CUR && CUR.ctx ? CUR.onError(m) : false; },
    render: function(){}
  };
  MP.register("fps", "🎯", "Free-for-all for up to 8: the server judges every shot", function(ctx){
    if(CUR) CUR.destroy();
    var g = CUR = makeGame(ctx.box, {mode: "mp", ctx: ctx});
    ctx.onConn = function(on){ if(g.alive) g.onConn(on); };
    ctx.onRejoin = function(){ if(g.alive && MP) MP.send("fps", "view"); };
    ctx.stop = function(){ g.destroy(); if(CUR === g) CUR = null; };
  });
}
// HQ 2.5: the Map Editor plays a MapDoc here. room: open the "with friends" card with it
// picked for the host's next start; else a solo walk-through on the solo card.
HQV.fpsPlay = function(doc, room){
  if(!doc || typeof doc !== "object" || !doc.data) return false;
  PENDING = {doc: doc, room: !!room};
  api.open(room ? "mp-fps" : "fps");
  return true;
};
HQV.fpsShared = FS;      // for the browser smoke test and tests/test_fps_sync.py
HQV.fpsDebug = function(){ return CUR; };
})();
