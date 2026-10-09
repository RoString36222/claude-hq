/* Valley: Platformer Rush. Run, jump and double-jump through floating islands to the
 * flag, coins on the way; made from Kenney's CC0 Starter Kit 3D Platformer models. Solo
 * it's a time trial per level; in an Arena room up to 8 players race to the flag or
 * play co-op (the whole lobby shares one coin goal against the clock).
 *
 * Rendering is the vendored three.js r186 (games/vendor/), imported only when this game
 * opens; without WebGL2 the same run plays on a top-down map. The character controller
 * is an original re-implementation (no Godot code is used): camera-relative movement,
 * acceleration, gravity, coyote time, jump buffering, a double jump, and box collision
 * against the level's solids, resolved per axis.
 *
 * Multiplayer: you run your own character here and send where it is ~20 times a second
 * (x, y, z in cm, yaw, an animation id, your game clock); the Arena server
 * (backend/app/platformer.py) runs a 15 Hz tick that checks every frame (inside the
 * level, no faster than a run, no higher than a jump and a double jump allow, never
 * inside a platform), owns the checkpoints, the coins and the flag, and sends one
 * snapshot per tick. Other players are drawn ~100 ms in the past from those snapshots
 * (plus measured jitter), extrapolated briefly across gaps. Fall off and the server
 * puts you back on your last checkpoint. Only these numbers and a character tint travel;
 * nothing transcript-derived.
 *
 * The PLAT-LEVEL block mirrors backend/app/platformer.py (tests/test_platformer_sync.py
 * checks both against each other under node).
 */
(function(){
"use strict";
var HQV = window.HQV; if(!HQV || !HQV.api || !HQV.engine) return;
// Shared helpers, three.js loading and snapshot timing: games/engine.js.
var E = HQV.engine;
var now = E.now, clamp = E.clamp, hex = E.hex, angLerp = E.angLerp, calm = E.calm, say = E.say,
    tokens = E.tokens, myClock = E.myClock, hasWebGL2 = E.hasWebGL2, fmt = E.fmtTime, dist3 = E.dist3;
var api = HQV.api, MP = HQV.mp || null;

/* PLAT-LEVEL BEGIN */
var PL = (function(){
  var PR = 0.3, PH = 0.9, CENTER = 0.45;
  // name: [shape, width x, depth z, height] before scale and rotation
  var MODELS = {"platform": ["box", 2, 2, 0.5], "platform-medium": ["box", 3, 3, 0.5], "platform-large": ["box", 5, 5, 0.5],
    "platform-falling": ["box", 2.2, 2.2, 0.5], "platform-grass-large-round": ["round", 5, 5, 0.5],
    "brick": ["box", 1, 1, 1], "block-coin": ["box", 1, 1, 1]};
  function solidOf(b){
    var M = MODELS[b.m]; if(!M) throw new Error("unknown model "+b.m);
    var s = b.s != null ? +b.s : 1, w = M[1], d = M[2], h = M[3];
    if((((b.r|0) % 180) + 180) % 180 === 90){ var k = w; w = d; d = k; }
    var x = +b.x, y = +b.y, z = +b.z;
    return {m: b.m, x0: x - w*s/2, x1: x + w*s/2, y0: y, y1: y + h*s, z0: z - d*s/2, z1: z + d*s/2, cx: x, cz: z,
            r: M[0] === "round" ? w*s/2 : 0};
  }
  function compileLevel(lv){
    var solids = (lv.solids || []).map(solidOf);
    if(!solids.length) throw new Error("a level needs solids");
    var top = -1e9, x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
    solids.forEach(function(s){ top = Math.max(top, s.y1); x0 = Math.min(x0, s.x0); x1 = Math.max(x1, s.x1); z0 = Math.min(z0, s.z0); z1 = Math.max(z1, s.z1); });
    function pts(a){ return (a || []).map(function(p){ return [+p[0], +p[1], +p[2]]; }); }
    var kill = +lv.kill;
    return {id: lv.id, name: lv.name, kill: kill, solids: solids, spawns: pts(lv.spawns), cps: pts(lv.cps), coins: pts(lv.coins),
            flag: pts([lv.flag])[0], goal: lv.coopGoal|0, secs: lv.coopSecs != null ? +lv.coopSecs : 180,
            bounds: [x0 - 12, x1 + 12, kill - 6, top + 10, z0 - 12, z1 + 12]};
  }
  // (x, z) over the footprint grown by m (shrunk if m < 0)
  function inFoot(s, x, z, m){
    if(s.r > 0){ var dx = x - s.cx, dz = z - s.cz; return dx*dx + dz*dz <= (s.r + m)*(s.r + m); }
    return s.x0 - m <= x && x <= s.x1 + m && s.z0 - m <= z && z <= s.z1 + m;
  }
  // top of the highest solid under (x, z) that feet at y stand on or hover at most tol above
  function support(L, x, y, z, m, tol){
    var best = null;
    for(var i = 0; i < L.solids.length; i++){
      var s = L.solids[i];
      if(s.y1 - 0.05 <= y && y <= s.y1 + tol && inFoot(s, x, z, m) && (best === null || s.y1 > best)) best = s.y1;
    }
    return best;
  }
  function inside(L, x, y, z){
    for(var i = 0; i < L.solids.length; i++){
      var s = L.solids[i];
      if(s.y0 + 0.1 < y && y < s.y1 - 0.15 && inFoot(s, x, z, -0.05)) return true;
    }
    return false;
  }
  function segDist(a, b, p){
    var abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2], apx = p[0] - a[0], apy = p[1] - a[1], apz = p[2] - a[2];
    var L = abx*abx + aby*aby + abz*abz, u = L <= 1e-12 ? 0 : Math.max(0, Math.min(1, (apx*abx + apy*aby + apz*abz)/L));
    var dx = apx - abx*u, dy = apy - aby*u, dz = apz - abz*u;
    return Math.sqrt(dx*dx + dy*dy + dz*dz);
  }
  return {PR: PR, PH: PH, CENTER: CENTER, MODELS: MODELS, solidOf: solidOf, compileLevel: compileLevel, inFoot: inFoot,
          support: support, inside: inside, segDist: segDist};
})();
/* PLAT-LEVEL END */

/* ---------- the character (browser only: the server checks, it doesn't simulate) ---------- */
var RUN = 6, ACC = 45, ACC_AIR = 22, DEC = 50, GRAV = 26, JUMP = 8.6, DJUMP = 7.8, FALL_MAX = 20;
var COYOTE = 0.1, JBUF = 0.12, STEP_UP = 0.3, STEP = 1/120;
var SEND_EVERY = 0.05, KEEPALIVE = 1.0, CD_SECS = 3;
var INTERP = 0.1, JIT_MAX = 0.2, EXTRAP = 0.25, SNAPS = 10;
var COIN_TAKE = 0.75, CP_R = 2.0, FLAG_R = 1.6, RESPAWN_FADE = 0.6;
var A_IDLE = 0, A_RUN = 1, A_JUMP = 2, A_FALL = 3, A_DJUMP = 4;
var CHARS = [{n: "Classic", c: 0xffffff}, {n: "Coral", c: 0xff9a8a}, {n: "Mint", c: 0x9ff0c4},
             {n: "Sunny", c: 0xffe07a}, {n: "Grape", c: 0xc6a2ff}, {n: "Ocean", c: 0x8ec9ff}];
var CHAR_SWATCH = ["#e8eef4", "#ff9a8a", "#9ff0c4", "#ffe07a", "#c6a2ff", "#8ec9ff"];
var MODES = [["race", "Race"], ["coop", "Co-op"]];

function fmtS(ms){ ms = Math.max(0, ms|0); var s = Math.ceil(ms/1000), m = Math.floor(s/60); s = s % 60; return m+":"+(s < 10 ? "0" : "")+s; }
function nameOf(p){ return (p && (p.displayName || p.handle)) || "Runner"; }

/* ---------- data + three.js, loaded on demand ---------- */
var DATA = null, DATA_P = null, LEVELS = {};
function loadData(){
  if(DATA_P) return DATA_P;
  DATA_P = fetch("/games/platformer/levels.json").then(function(r){ if(!r.ok) throw new Error("levels "+r.status); return r.json(); })
    .then(function(j){
      DATA = j; LEVELS = {};
      (j.levels || []).forEach(function(lv){ try { var L = PL.compileLevel(lv); L.theme = lv.theme || {}; L.deco = lv.deco || []; L.route = lv.route || [];
        LEVELS[lv.id] = L; } catch(e){} });
      return j;
    }, function(e){ DATA_P = null; throw e; });
  return DATA_P;
}
// HQ 2.5: a level made in the Level Editor (games/leveledit.js), compiled with the same PL
// block as the built-in ones. In a room it arrives in the server's view as custom:{name, data}
// under its c- key; solo (a test run or a 3D preview) it gets a local id.
function compileCustom(id, name, data){
  data = data || {};
  var src = {}; for(var k in data) src[k] = data[k];
  src.id = id; src.name = String(name || "Custom level").slice(0, 32);
  var L = PL.compileLevel(src);
  L.theme = src.theme || {}; L.deco = src.deco || []; L.route = src.route || []; L.src = src; L.custom = true;
  return L;
}
function registerCustom(id, custom){
  if(!custom || typeof custom !== "object") return null;
  try { var L = compileCustom(id, custom.name, custom.data); LEVELS[id] = L; return L; } catch(e){ return null; }
}
function mapsOn(){ var A = window.ARENA; return !!(A && A.arena && A.arena.maps); }
function storyNote(ev){ try { if(HQV.story && HQV.story.note) HQV.story.note(ev); } catch(e){} }
function editorDrafts(){
  var m = HQV.makers && HQV.makers.plat, out = [];
  try { out = m && typeof m.drafts === "function" ? (m.drafts() || []) : []; } catch(e){ out = []; }
  return out.filter(function(d){ return d && d.kind === "plat" && d.data && typeof d.name === "string"; });
}
function platLib(){ return E.lib(); }
function loadGlb(lib, name){ return E.loadGlb(lib, "platformer", name); }
function psave(){
  var s = api.save; if(!s) return {best: {}};
  if(!s.plat || typeof s.plat !== "object" || Array.isArray(s.plat)) s.plat = {};
  if(!s.plat.best || typeof s.plat.best !== "object") s.plat.best = {};
  return s.plat;
}

/* =============================== the game view =============================== */
var CUR = null;

function makeGame(host, opts){
  var V = {mode: opts.mode, ctx: opts.ctx || null, alive: true, paused: false, level: null, play: "race", phase: "idle",
    goAt: 0, startAt: 0, ps: {}, order: [], standings: [], results: null, win: null, finishedAt: null,
    sendAt: 0, sentKey: "", note: "", round: null, gotView: false, unsupported: false, map: !!psave().map,
    low: !!psave().low, offline: false, spectate: null, taken: {}, mine: {}, pend: {}, roomCoins: 0, goal: 0, limitMs: 0,
    respawn: null, simQ: Math.floor(performance.now()/10), camYaw: 0, camPitch: 0.42, camDist: 7, camFar: false, auto: null, lastCoinSay: 0,
    preview: false, onExit: typeof opts.onExit === "function" ? opts.onExit : null, customPick: false};
  function myId(){ return V.mode === "mp" && MP ? MP.me() : "me"; }
  function me(){ return V.ps[myId()] || null; }

  var root = api.mk("div", "vg-golf vg-plat"), menu = api.mk("div", "vg-golf-menu"), stage = api.mk("div", "vg-golf-stage hidden");
  root.appendChild(menu); root.appendChild(stage); host.appendChild(root);
  var wrap = api.mk("div", "vg-golf-view vg-plat-view"), hud = api.mk("div", "vg-golf-hud vg-plat-hud");
  var hudTitle = api.mk("b", "vg-plat-big"), hudTime = api.mk("span", "vg-plat-time"), hudCp = api.mk("span", "vg-plat-line");
  var hudCoins = api.mk("span", "vg-plat-line"), bar = api.mk("div", "vg-meter vg-plat-bar"), barFill = api.mk("i"), hudStand = api.mk("ol", "vg-plat-stand");
  bar.appendChild(barFill);
  [hudTitle, hudTime, hudCp, hudCoins, bar, hudStand].forEach(function(n){ hud.appendChild(n); });
  hud.setAttribute("aria-hidden", "true");
  var cdBox = api.mk("div", "vg-plat-cd hidden"); cdBox.setAttribute("aria-hidden", "true");
  var fade = api.mk("div", "vg-plat-fade hidden"), fadeTxt = api.mk("span", null, "Respawning…"); fade.appendChild(fadeTxt); fade.setAttribute("aria-hidden", "true");
  var cardBox = api.mk("div", "vg-golf-card vg-plat-card hidden"); cardBox.setAttribute("role", "dialog"); cardBox.setAttribute("aria-label", "Results");
  var badge = api.mk("span", "vg-reconnecting vg-golf-badge hidden", "Reconnecting…"); badge.setAttribute("role", "status");
  var load = api.mk("div", "vg-meter vg-golf-load hidden"), loadFill = api.mk("i"); load.appendChild(loadFill); load.setAttribute("aria-hidden", "true");
  var hint = api.mk("p", "vg-golf-hint"), tools = api.mk("div", "vg-row vg-golf-tools"), keysBox = api.mk("div", "vg-golf-keys");
  stage.appendChild(wrap); stage.appendChild(hint); stage.appendChild(tools); stage.appendChild(keysBox);
  var KEYS = [["W A S D / ↑ ← ↓ → / stick", "run (camera-relative)"], ["Space / A", "jump, again in the air to double-jump"],
              ["Mouse (click to lock) / right-drag / right stick", "turn the camera"], ["Q / E", "turn the camera"],
              ["C", "camera near / far"], ["R / Y", "back to your checkpoint"], ["H", "hide these keys"]];
  function renderKeys(){
    keysBox.textContent = "";
    if(psave().keysHidden){ keysBox.appendChild(api.mk("span", "vg-muted", "Keys hidden — press H to show them")); return; }
    KEYS.forEach(function(r){ var it = api.mk("span", "vg-golf-key"); it.appendChild(api.mk("kbd", null, r[0])); it.appendChild(document.createTextNode(" "+r[1])); keysBox.appendChild(it); });
  }
  var canvas = null, R3 = null, R2 = null, IN = null, raf = 0, lastT = 0, acc = 0, ro = null, TOK = tokens(), tokAt = 0;
  var lookX = 0, lookY = 0, jumpLatch = false, lookAt = 0;

  /* ---------- players ---------- */
  function ensureP(uid, info){
    var P = V.ps[uid];
    if(!P){
      P = V.ps[uid] = {uid: uid, name: "", chr: 0, slot: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, yaw: Math.PI, ground: true,
        coy: 0, buf: 0, jumps: 0, anim: A_IDLE, cp: 0, coins: 0, place: 0, fin: null, dnf: false, away: false, snaps: [], lastQ: -1,
        off: null, jit: 0, mesh: null, landAt: -9, djAt: -9, jumpAt: -9};
      V.order.push(uid);
    }
    if(info){ for(var k in info) P[k] = info[k]; }
    return P;
  }
  function dropP(uid){ var P = V.ps[uid]; if(!P) return; if(R3) R3.removeP(P); delete V.ps[uid]; V.order = V.order.filter(function(u){ return u !== uid; }); }
  function clearPs(){ V.order.slice().forEach(dropP); }
  function placeAt(P, p){
    P.x = p[0]; P.y = p[1]; P.z = p[2]; P.vx = 0; P.vy = 0; P.vz = 0; P.ground = true; P.jumps = 0; P.coy = 0; P.buf = 0;
    P.anim = A_IDLE; P.snaps.length = 0;
  }
  function placeOnSpawn(P, k){
    var L = V.level, s = L.spawns[k % L.spawns.length];
    placeAt(P, s); P.slot = k; P.yaw = Math.PI; P.cp = 0; P.fin = null; P.dnf = false; P.coins = 0;
  }

  /* ---------- screens ---------- */
  function showStage(on){ stage.classList.toggle("hidden", !on); menu.classList.toggle("hidden", on); if(on){ ensureRenderer(); renderTools(); renderKeys(); } }
  function isHost(){
    var s = MP ? MP.st("plat") : null, id = myId(), h = false;
    ((s && s.lobby) || []).forEach(function(p){ if(p.userId === id && p.host) h = true; });
    return h;
  }
  function renderMenu(){
    if(!V.alive) return;
    menu.textContent = "";
    if(!DATA){ menu.appendChild(api.mk("p", "vg-muted", V.note || "Loading levels…")); return; }
    var sv = psave(), mp = V.mode === "mp", host = mp && isHost();
    menu.appendChild(api.mk("p", "vg-muted", mp
      ? "Up to 8 runners on floating islands. Race to the flag (every checkpoint first), or play co-op: the whole lobby shares one coin goal against the clock. The Arena server keeps the checkpoints, coins and times."
      : "Time trial on your own: run, jump and double-jump to the flag through every checkpoint. Coins on the way show the route."));
    if(mp && V.unsupported) menu.appendChild(api.mk("p", "vg-msg", "This Arena server doesn't host Platformer Rush yet. You can still play solo."));
    var top = api.mk("div", "vg-row");
    if(mp) top.appendChild(api.btn("Time trial solo", "", function(){ V.mode = "practice"; renderMenu(); }));
    else if(V.ctx) top.appendChild(api.btn("Back to the lobby", "", function(){ V.mode = "mp"; resetRun(); requestView(); renderMenu(); }));
    function check(label, val, fn){
      var l = api.mk("label", "vg-golf-check"), cb = api.mk("input"); cb.type = "checkbox"; cb.checked = val;
      cb.addEventListener("change", function(){ fn(cb.checked); api.persist(); });
      l.appendChild(cb); l.appendChild(document.createTextNode(" "+label)); top.appendChild(l);
    }
    check("Map view (2D)", V.map, function(v){ V.map = v; sv.map = v; });
    check("Low detail (faster on older laptops)", V.low, function(v){ V.low = v; sv.low = v; });
    menu.appendChild(top);
    menu.appendChild(api.mk("h4", "vg-golf-h", "Your runner"));
    var chars = api.mk("div", "vg-golf-chars"); chars.setAttribute("role", "group"); chars.setAttribute("aria-label", "Pick a runner colour");
    var mine = clamp(sv.char|0, 0, CHARS.length - 1);
    CHARS.forEach(function(c, i){
      var b = api.btn("", "vg-golf-char vg-plat-char"+(i === mine ? " on" : ""), function(){
        sv.char = i; api.persist(); if(mp && MP) MP.send("plat", "char", {char: i}); renderMenu();
      });
      var sw = api.mk("i", "vg-plat-sw"); sw.style.background = CHAR_SWATCH[i]; sw.setAttribute("aria-hidden", "true"); b.appendChild(sw);
      b.appendChild(api.mk("span", null, c.n)); b.setAttribute("aria-pressed", i === mine ? "true" : "false");
      chars.appendChild(b);
    });
    menu.appendChild(chars);
    var playMode = sv.mode === "coop" ? "coop" : "race";
    if(mp && host){
      var mr = api.mk("div", "vg-row"); mr.setAttribute("role", "radiogroup"); mr.setAttribute("aria-label", "Mode");
      mr.appendChild(api.mk("span", "vg-muted", "Mode"));
      MODES.forEach(function(m){
        var b = api.btn(m[1], m[0] === playMode ? "primary" : "", function(){ sv.mode = m[0]; api.persist(); renderMenu(); });
        b.setAttribute("role", "radio"); b.setAttribute("aria-checked", m[0] === playMode ? "true" : "false");
        mr.appendChild(b);
      });
      menu.appendChild(mr);
    }
    menu.appendChild(api.mk("h4", "vg-golf-h", mp ? (host ? "Pick a level to start "+(playMode === "coop" ? "co-op" : "the race") : "Levels") : "Levels"));
    var grid = api.mk("div", "vg-golf-courses");
    (DATA.levels || []).forEach(function(lv){
      var L = LEVELS[lv.id]; if(!L) return;
      var card = api.mk("button", "vg-card vg-golf-course"); card.type = "button";
      var ic = api.mk("span", "vg-card-ic", "🏝️"); ic.setAttribute("aria-hidden", "true"); card.appendChild(ic);
      var tt = api.mk("span", "vg-card-t"); tt.appendChild(api.mk("b", null, L.name));
      var best = sv.best[L.id], hi = 0; L.solids.forEach(function(s){ hi = Math.max(hi, s.y1); });
      tt.appendChild(api.mk("span", null, L.cps.length+" checkpoints · "+L.coins.length+" coins · "+Math.round(hi)+" m climb"+
        (mp && playMode === "coop" ? " · co-op goal "+L.goal+" in "+fmtS(L.secs*1000) : "")+(best && !mp ? " · best "+fmt(best) : "")));
      card.appendChild(tt);
      if(mp && !host) card.disabled = true;
      card.addEventListener("click", function(){
        if(mp){ if(MP) MP.send("plat", "start", {level: L.id, mode: playMode}); }
        else startPractice(L.id);
      });
      grid.appendChild(card);
    });
    menu.appendChild(grid);
    renderCustomPicker(mp, host, playMode);
    if(mp){
      if(!host) menu.appendChild(api.mk("p", "vg-muted", "Waiting for the host (★ in the lobby) to pick a level and a mode."));
      if(V.results) menu.appendChild(resultsTable(V.results, "Last run", V.play));
      if(V.round && (V.round.phase === "grid" || V.round.phase === "run") && !inRun(V.round))
        menu.appendChild(api.btn("Watch", "primary", function(){ applyView(V.round, true); }));
    }
  }
  // HQ 2.5: levels from the Level Editor. In a room only the host starts one, and only on an
  // Arena that takes custom levels (arena.maps); solo they play as a time trial.
  function startCustom(doc, playMode){
    if(!MP || !doc) return false;
    var ok = MP.send("plat", "start", {level: "custom", mode: playMode, custom: {kind: "plat", v: 1, name: doc.name, data: doc.data}});
    if(ok){ storyNote("race-custom"); say("Starting "+doc.name); }
    return ok;
  }
  function renderCustomPicker(mp, host, playMode){
    var drafts = editorDrafts(), pend = HQV.platPending && HQV.platPending.doc;
    if(mp && !mapsOn()) return;
    if(!mp && !drafts.length) return;
    if(mp && !host){
      if(pend) menu.appendChild(api.mk("p", "vg-msg", "Only the host can start “"+pend.name+"”. Ask them, or host a room of your own."));
      return;
    }
    var box = api.mk("div", "vg-plat-custom");
    if(mp && pend){
      var go = api.btn("Start your level: "+pend.name, "primary", function(){ if(startCustom(pend, playMode)) HQV.platPending = null; });
      box.appendChild(go);
    }
    var tog = api.btn(V.customPick ? "Custom… ▾" : "Custom…", "", function(){ V.customPick = !V.customPick; renderMenu(); });
    tog.setAttribute("aria-expanded", V.customPick ? "true" : "false");
    box.appendChild(tog);
    if(V.customPick){
      var list = api.mk("div", "vg-golf-courses");
      if(!drafts.length){
        list.appendChild(api.mk("p", "vg-muted", "No levels yet. Build one in the Level Editor."));
        if(HQV.makers && HQV.makers.plat) list.appendChild(api.btn("Open the Level Editor", "", function(){ api.open(HQV.makers.plat.game || "make-plat"); }));
      }
      drafts.forEach(function(d, i){
        var card = api.mk("button", "vg-card vg-golf-course"); card.type = "button";
        var ic = api.mk("span", "vg-card-ic", "🛠️"); ic.setAttribute("aria-hidden", "true"); card.appendChild(ic);
        var tt = api.mk("span", "vg-card-t"); tt.appendChild(api.mk("b", null, d.name));
        var dd = d.data || {};
        tt.appendChild(api.mk("span", null, ((dd.solids || []).length)+" platforms · "+((dd.cps || []).length)+" checkpoints · "+((dd.coins || []).length)+" coins"));
        card.appendChild(tt);
        card.addEventListener("click", function(){
          if(mp) startCustom(d, playMode);
          else { var L = registerCustom("local-"+i, d); if(L) startPractice(L.id); else api.toast("That level doesn't load: open it in the Level Editor"); }
        });
        list.appendChild(card);
      });
      box.appendChild(list);
    }
    menu.appendChild(box);
  }
  function inRun(view){ return (view.players || []).some(function(p){ return p.user && p.user.userId === myId(); }); }
  function renderTools(){
    tools.textContent = "";
    tools.appendChild(api.btn(V.mode === "mp" ? "Leave the run" : V.onExit ? "Back to the editor" : "Back to levels", "", function(){
      if(V.mode === "mp" && MP && isHost() && (V.phase === "grid" || V.phase === "run")){
        if(!window.confirm("End the run for everyone?")) return;
        MP.send("plat", "end");
      }
      if(V.onExit && V.mode !== "mp"){ V.onExit(); return; }
      resetRun(); showStage(false); renderMenu();
    }));
    tools.appendChild(api.btn("Camera", "", function(){ V.camFar = !V.camFar; if(canvas) canvas.focus(); }));
  }
  function resetRun(){
    clearPs(); V.phase = "idle"; V.level = null; V.preview = false; V.results = null; V.finishedAt = null; V.taken = {}; V.mine = {}; V.pend = {};
    V.roomCoins = 0; V.respawn = null; V.auto = null; V.win = null;
    cardBox.classList.add("hidden"); cdBox.classList.add("hidden"); fade.classList.add("hidden"); if(R3) R3.clearLevel();
  }

  /* ---------- practice: a solo time trial ---------- */
  function startPractice(id){
    var L = LEVELS[id]; if(!L) return;
    resetRun(); V.mode = "practice"; V.play = "race"; V.level = L;
    var P = ensureP("me", {name: "You", chr: clamp(psave().char|0, 0, CHARS.length - 1), cos: window.HQ_MYCOS || null});
    placeOnSpawn(P, 0);
    V.camYaw = 0; V.phase = "grid"; V.goAt = now() + CD_SECS;
    showStage(true); if(R3) R3.buildLevel();
    if(canvas) canvas.focus();
  }

  // HQ 2.5: the Level Editor's 3D preview: the level drawn by this renderer, the runner
  // standing on spawn 1, the camera turning round it (Q / E / the mouse; still in Calm).
  function startPreview(id){
    var L = LEVELS[id]; if(!L) return;
    resetRun(); V.mode = "practice"; V.play = "race"; V.level = L; V.preview = true;
    var P = ensureP("me", {name: "You", chr: clamp(psave().char|0, 0, CHARS.length - 1), cos: window.HQ_MYCOS || null});
    placeOnSpawn(P, 0);
    V.camYaw = 0.6; V.camFar = true; V.phase = "preview";
    showStage(true); if(R3) R3.buildLevel();
  }
  V.focusAt = function(p){ var P = me(); if(V.preview && P && p) placeAt(P, [+p[0] || 0, +p[1] || 0, +p[2] || 0]); };

  /* ---------- multiplayer: the server's view ---------- */
  function requestView(){ if(MP) MP.send("plat", "view"); }
  function applyView(view, force){
    V.round = view; V.gotView = true;
    if(view && view.custom && typeof view.level === "string" && !LEVELS[view.level]) registerCustom(view.level, view.custom);
    if(!view || !LEVELS[view.level]){ if(V.phase !== "idle" && V.mode === "mp"){ resetRun(); showStage(false); } renderMenu(); return; }
    if(V.mode !== "mp") return;
    var mine = inRun(view);
    if(view.phase === "idle"){ if(V.phase !== "idle"){ resetRun(); showStage(false); } renderMenu(); return; }
    if(view.phase === "done"){
      V.results = view.results; V.play = view.mode === "coop" ? "coop" : "race"; V.win = view.win;
      if(V.phase !== "idle" && V.phase !== "done") showResults(view.results, {win: view.win, total: (view.taken || []).length, goal: view.goal});
      V.phase = "done"; renderMenu(); return;
    }
    if(!mine && !force && V.phase === "idle"){ renderMenu(); return; }
    var fresh = !V.level || V.level.id !== view.level || V.phase === "idle" || V.phase === "done";
    if(fresh){ resetRun(); V.camYaw = 0; }
    V.level = LEVELS[view.level]; V.play = view.mode === "coop" ? "coop" : "race"; V.goal = view.goal|0; V.limitMs = view.limitMs|0;
    V.taken = {}; (view.taken || []).forEach(function(i){ V.taken[i] = 1; }); V.roomCoins = (view.taken || []).length;
    var seen = {};
    (view.players || []).forEach(function(p){
      var uid = p.user && p.user.userId; if(!uid) return; seen[uid] = 1;
      var P = ensureP(uid, {name: nameOf(p.user), chr: clamp(p.char|0, 0, CHARS.length - 1), place: p.place|0, fin: p.fin, dnf: !!p.dnf,
        away: !!p.away, cp: p.cp|0, coins: p.coins|0, cos: (p.user && p.user.cos) || null});
      if(uid === myId()){ V.mine = {}; (p.got || []).forEach(function(i){ V.mine[i] = 1; }); }
      if(fresh || view.phase === "grid") placeOnSpawn(P, p.slot|0);
      if(view.phase === "run" && (fresh || uid !== myId())){ placeAt(P, [(+p.x || 0)/100, (+p.y || 0)/100, (+p.z || 0)/100]); P.yaw = (+p.r || 0)*Math.PI/180; }
      P.cp = p.cp|0; P.coins = p.coins|0;
    });
    V.order.slice().forEach(function(uid){ if(!seen[uid]) dropP(uid); });
    V.spectate = mine ? null : (view.players[0] && view.players[0].user.userId);
    if(view.phase === "grid"){ V.phase = "grid"; V.goAt = now() + (view.goInMs|0)/1000; }
    else if(view.phase === "run"){ if(V.phase !== "run") V.startAt = now() - (view.runMs|0)/1000; V.phase = "run"; }
    showStage(true);
    if(fresh && R3) R3.buildLevel();
    hudUpdate();
  }
  function onEvent(m){
    if(m.ev === "plat"){
      // tell the lobby the colour saved from last time (the server keeps it between runs)
      if(!V.charSent && MP && psave().char != null){ V.charSent = true; MP.send("plat", "char", {char: clamp(psave().char|0, 0, CHARS.length - 1)}); }
      if(!DATA){ V.round = m.run; V.gotView = true; return; }
      applyView(m.run, false);
      if(m.by && m.run && m.run.phase === "grid" && canvas) canvas.focus();
      if(HQV.platPending && V.mode === "mp" && isHost() && mapsOn() && (!m.run || m.run.phase === "idle" || m.run.phase === "done")){
        var pd = HQV.platPending; HQV.platPending = null;
        if(!startCustom(pd.doc, pd.mode === "coop" ? "coop" : "race")) HQV.platPending = pd;
      }
      return;
    }
    if(V.mode !== "mp" || !V.level) return;
    var M = me();
    if(m.ev === "go"){ V.phase = "run"; V.startAt = now(); cdShow("GO!"); say("Go!"); return; }
    if(m.ev === "snap"){
      (m.ps || []).forEach(function(c){
        var P = V.ps[c.u]; if(!P) return;
        if(c.cp != null) P.cp = c.cp|0;
        if(c.u !== myId()) pushSnap(P, c);
      });
      if(Array.isArray(m.order)){ V.standings = m.order.slice(0, 8); V.standings.forEach(function(u, i){ if(V.ps[u]) V.ps[u].place = i + 1; }); }
      return;
    }
    if(m.ev === "fix"){
      if(!M) return;
      placeAt(M, [(+m.x || 0)/100, (+m.y || 0)/100, (+m.z || 0)/100]); return;
    }
    if(m.ev === "spawn"){
      if(!M) return;
      placeAt(M, [(+m.x || 0)/100, (+m.y || 0)/100, (+m.z || 0)/100]); M.cp = m.cp|0;
      faceNext(M); V.respawn = null; fade.classList.add("hidden");
      if(V.auto) autoFromCp(); return;
    }
    if(m.ev === "cp"){
      var C = V.ps[m.user]; if(C) C.cp = m.cp|0;
      if(m.user === myId()){ var n = V.level.cps.length; cdShow("Checkpoint "+m.cp+"/"+n); say("Checkpoint "+m.cp+" of "+n+(m.cp === n && V.play === "race" ? ". Now the flag!" : "")); }
      return;
    }
    if(m.ev === "coin"){
      var K = V.ps[m.user]; if(K) K.coins = m.n|0;
      if(V.play === "coop"){ V.taken[m.id] = 1; V.roomCoins = m.room|0; }
      if(m.user === myId()){ V.mine[m.id] = 1; delete V.pend[m.id]; coinSay(m.n|0); E.sfx("coin"); }
      if(R3) R3.coinPop(m.id, m.user === myId() || V.play === "coop");
      return;
    }
    if(m.ev === "finish"){
      var F = V.ps[m.user]; if(F) F.fin = m.ms;
      if(m.user === myId()){ V.finishedAt = now(); say("You reached the flag in place "+m.place+", "+fmt(m.ms)); cdShow("P"+m.place+"!"); }
      else if(F) api.toast("🚩 "+F.name+" reached the flag · P"+m.place+" · "+fmt(m.ms));
      return;
    }
    if(m.ev === "dnf"){ var D = V.ps[m.user]; if(D) D.dnf = true; return; }
    if(m.ev === "done"){
      V.results = m.results; V.phase = "done"; V.win = m.win;
      showResults(m.results, {win: m.win, total: m.total, goal: m.goal, ms: m.ms}); return;
    }
    if(m.ev === "char"){ var H = V.ps[m.user]; if(H && V.phase !== "run"){ H.chr = clamp(m.char|0, 0, CHARS.length - 1); if(R3) R3.removeP(H); } return; }
  }
  function onError(m){
    var e = String(m.error || "");
    if(/unknown game/.test(e)){ V.unsupported = true; renderMenu(); return true; }
    return false;
  }
  function coinSay(n){ if(n >= V.lastCoinSay + 10 || n < V.lastCoinSay){ V.lastCoinSay = n - (n % 10); if(n % 10 === 0 && n) say(n+" coins"); } }

  /* ---------- results ---------- */
  function resultsTable(rows, title, play){
    var box = api.mk("div", "vg-golf-score");
    box.appendChild(api.mk("b", null, title));
    var tb = api.mk("table", "vg-golf-table"), hr = api.mk("tr");
    (play === "coop" ? ["#", "Runner", "Coins"] : ["#", "Runner", "Time", "Coins"]).forEach(function(h){ hr.appendChild(api.mk("th", null, h)); });
    tb.appendChild(hr);
    (rows || []).forEach(function(r){
      var tr = api.mk("tr");
      tr.appendChild(api.mk("td", null, play !== "coop" && r.dnf ? "–" : String(r.place)));
      tr.appendChild(api.mk("td", r.user && r.user.userId === myId() ? "tot" : null, nameOf(r.user)));
      if(play !== "coop") tr.appendChild(api.mk("td", null, r.dnf ? "DNF" : fmt(r.ms)));
      tr.appendChild(api.mk("td", null, String(r.coins|0)));
      tb.appendChild(tr);
    });
    box.appendChild(tb); return box;
  }
  function showResults(rows, info){
    info = info || {};
    cardBox.textContent = "";
    if(V.play === "coop"){
      var head = info.win ? "Goal reached! "+(info.total|0)+"/"+(info.goal|0)+" coins together" : "Time's up: "+(info.total|0)+"/"+(info.goal|0)+" coins";
      cardBox.appendChild(api.mk("p", "vg-plat-verdict"+(info.win ? " win" : ""), head));
    }
    cardBox.appendChild(resultsTable(rows, "Results · "+(V.level ? V.level.name : ""), V.play));
    var row = api.mk("div", "vg-row");
    if(V.mode === "mp"){
      if(isHost()) row.appendChild(api.btn("Pick the next level", "primary", function(){ resetRun(); showStage(false); renderMenu(); }));
      else row.appendChild(api.btn("Back to the lobby", "", function(){ resetRun(); showStage(false); renderMenu(); }));
    } else {
      row.appendChild(api.btn("Run again", "primary", function(){ startPractice(V.level.id); }));
      if(V.onExit) row.appendChild(api.btn("Back to the editor", "", function(){ V.onExit(); }));
      else row.appendChild(api.btn("Levels", "", function(){ resetRun(); showStage(false); renderMenu(); }));
    }
    cardBox.appendChild(row); cardBox.classList.remove("hidden");
    try { if(document.pointerLockElement) document.exitPointerLock(); } catch(e){}
    var mine = (rows || []).filter(function(r){ return r.user && r.user.userId === myId(); })[0];
    if(V.play === "coop") say(info.win ? "Co-op goal reached with "+(info.total|0)+" coins" : "Time's up with "+(info.total|0)+" of "+(info.goal|0)+" coins");
    else if(mine) say(mine.dnf ? "Run over: did not finish" : "Run over: place "+mine.place+", "+fmt(mine.ms));
  }
  function cdShow(t){ E.sfx(t === "GO!" ? "go" : /^\d$/.test(t) ? "count" : "finish"); cdBox.textContent = t; cdBox.classList.remove("hidden"); cdBox.dataset.until = String(now() + 1.1); }

  /* ---------- the character controller ---------- */
  function physics(P, dt, wx, wz, jp){
    var L = V.level, sol = L.solids, i, s;
    // run: accelerate towards the wished velocity, faster on the ground
    var tx = wx*RUN, tz = wz*RUN, ac = P.ground ? (wx || wz ? ACC : DEC) : ACC_AIR;
    var dx = tx - P.vx, dz = tz - P.vz, dl = Math.sqrt(dx*dx + dz*dz), mx = ac*dt;
    if(dl > mx){ dx *= mx/dl; dz *= mx/dl; }
    P.vx += dx; P.vz += dz;
    // jump: buffered a moment before landing, allowed a moment after leaving an edge (coyote)
    if(jp) P.buf = JBUF; else P.buf = Math.max(0, P.buf - dt);
    P.coy = P.ground ? COYOTE : Math.max(0, P.coy - dt);
    if(P.buf > 0 && P.jumps === 0 && (P.ground || P.coy > 0)){ P.vy = JUMP; P.jumps = 1; P.ground = false; P.coy = 0; P.buf = 0; P.jumpAt = now(); E.sfx("jump"); }
    else if(jp && !P.ground && P.jumps < 2 && P.coy <= 0){ P.vy = DJUMP; P.jumps = 2; P.buf = 0; P.djAt = now(); E.sfx("djump"); }
    P.vy = Math.max(P.vy - GRAV*dt, -FALL_MAX);
    // vertical: land on tops, bump heads on bottoms
    var ny = P.y + P.vy*dt, was = P.ground; P.ground = false;
    for(i = 0; i < sol.length; i++){
      s = sol[i];
      if(!PL.inFoot(s, P.x, P.z, PL.PR - 0.05)) continue;
      if(P.vy <= 0 && P.y >= s.y1 - 0.05 && ny <= s.y1){ ny = s.y1; P.vy = 0; P.ground = true; }
      else if(P.vy > 0 && P.y + PL.PH <= s.y0 + 0.05 && ny + PL.PH > s.y0){ ny = s.y0 - PL.PH; P.vy = 0; }
    }
    P.y = ny;
    // horizontal, one axis at a time: step up small ledges, slide along walls
    moveAxis(P, P.vx*dt, 0); moveAxis(P, 0, P.vz*dt);
    // still standing on something?
    if(!P.ground && P.vy <= 0){
      var top = PL.support(L, P.x, P.y, P.z, PL.PR - 0.05, 0.03);
      if(top !== null){ P.y = top; P.vy = 0; P.ground = true; }
    }
    if(P.ground){ P.jumps = 0; if(!was && P.vy === 0) P.landAt = now(); }
    // facing and animation
    var sp = Math.sqrt(P.vx*P.vx + P.vz*P.vz);
    if(sp > 0.3) P.yaw = angLerp(P.yaw, Math.atan2(P.vx, P.vz), 1 - Math.exp(-dt*12));
    P.anim = P.ground ? (sp > 0.6 ? A_RUN : A_IDLE) : P.jumps === 2 && P.vy > 0 ? A_DJUMP : P.vy > 0 ? A_JUMP : A_FALL;
  }
  function moveAxis(P, ddx, ddz){
    if(!ddx && !ddz) return;
    var sol = V.level.solids, i, s;
    P.x += ddx; P.z += ddz;
    for(i = 0; i < sol.length; i++){
      s = sol[i];
      if(!(P.y < s.y1 - 0.02 && P.y + PL.PH > s.y0 + 0.02)) continue;
      if(!PL.inFoot(s, P.x, P.z, PL.PR)) continue;
      if(s.y1 - P.y <= STEP_UP && P.vy <= 0 && !PL.inside(V.level, P.x, s.y1, P.z)){ P.y = s.y1; P.vy = 0; P.ground = true; continue; }
      if(s.r > 0){
        var vx = P.x - s.cx, vz = P.z - s.cz, d = Math.sqrt(vx*vx + vz*vz) || 1, R = s.r + PL.PR + 0.001;
        P.x = s.cx + vx/d*R; P.z = s.cz + vz/d*R;
        var into = (P.vx*vx + P.vz*vz)/d; if(into < 0){ P.vx -= into*vx/d; P.vz -= into*vz/d; }
      } else if(ddx){
        P.x = ddx > 0 ? s.x0 - PL.PR - 0.001 : s.x1 + PL.PR + 0.001; P.vx = 0;
      } else {
        P.z = ddz > 0 ? s.z0 - PL.PR - 0.001 : s.z1 + PL.PR + 0.001; P.vz = 0;
      }
    }
  }
  function nextTarget(P){ var L = V.level; return P.cp < L.cps.length ? L.cps[P.cp] : L.flag; }
  function faceNext(P){ var t = nextTarget(P); V.camYaw = Math.atan2(t[0] - P.x, -(t[2] - P.z)); P.yaw = Math.atan2(t[0] - P.x, t[2] - P.z); }
  function respawnPoint(P){ var L = V.level; return P.cp > 0 ? L.cps[P.cp - 1] : L.spawns[P.slot % L.spawns.length]; }
  function startRespawn(){
    var P = me(); if(!P || V.respawn || P.fin != null) return;
    V.respawn = {at: now(), sent: 0};
    fadeTxt.textContent = "Respawning…"; fade.classList.remove("hidden"); fade.classList.toggle("calm", calm());
    say("Respawning at your checkpoint");
  }
  function respawnTick(t){
    var R = V.respawn, P = me(); if(!R || !P) return;
    P.vx = 0; P.vz = 0; P.vy = 0;
    if(V.mode === "mp"){
      if(t - R.at >= 0.25 && t - R.sent > 1.0 && MP && !V.offline){ R.sent = t; MP.send("plat", "respawn"); }
      return;
    }
    if(t - R.at >= RESPAWN_FADE){ placeAt(P, respawnPoint(P)); faceNext(P); V.respawn = null; fade.classList.add("hidden"); if(V.auto) autoFromCp(); }
  }
  // practice: the client keeps its own checkpoints, coins and the flag (the same rules the server keeps in a room)
  function reachLocal(P, a0, a1){
    var L = V.level;
    if(V.mode !== "mp"){
      if(P.cp < L.cps.length){ var c = L.cps[P.cp]; if(PL.segDist(a0, a1, [c[0], c[1] + PL.CENTER, c[2]]) <= CP_R){
        P.cp++; cdShow("Checkpoint "+P.cp+"/"+L.cps.length); say("Checkpoint "+P.cp+" of "+L.cps.length); } }
      if(P.cp >= L.cps.length && P.fin == null && PL.segDist(a0, a1, [L.flag[0], L.flag[1] + PL.CENTER, L.flag[2]]) <= FLAG_R) finishPractice(P);
    }
    for(var i = 0; i < L.coins.length; i++){
      if(V.mine[i] || V.pend[i] || (V.play === "coop" && V.taken[i])) continue;
      if(PL.segDist(a0, a1, L.coins[i]) <= COIN_TAKE){
        if(V.mode === "mp") V.pend[i] = now();
        else { V.mine[i] = 1; P.coins++; coinSay(P.coins); E.sfx("coin"); }
        if(R3) R3.coinPop(i, true);
      }
    }
  }
  function finishPractice(P){
    var t = now(), L = V.level; P.fin = (t - V.startAt)*1000; V.finishedAt = t; V.phase = "done";
    var sv = psave(), prev = sv.best[L.id];
    if(L.custom) api.toast("🚩 "+L.name+" finished in "+fmt(P.fin));
    else if(!prev || P.fin < prev){ sv.best[L.id] = Math.round(P.fin); api.persist(); api.toast("🚩 New best on "+L.name+": "+fmt(P.fin)); }
    showResults([{user: {userId: "me", displayName: "You"}, place: 1, ms: P.fin, dnf: false, coins: P.coins}]);
  }
  function sendPos(t){
    var P = me(); if(!P || V.mode !== "mp" || !MP || V.phase !== "run" || P.fin != null || V.offline || V.respawn) return;
    var x = Math.round(P.x*100), y = Math.round(P.y*100), z = Math.round(P.z*100), r = Math.round(((P.yaw*180/Math.PI) % 360 + 360) % 360);
    var key = x+","+y+","+z+","+r+","+P.anim;
    if(t - V.sendAt < SEND_EVERY) return;
    if(key === V.sentKey && t - V.sendAt < KEEPALIVE) return;
    V.sendAt = t; V.sentKey = key;
    // q is the simulation clock, not the wall clock: if this tab stalls, the character
    // moves in slow motion and its clock with it, so the referee's timing stays honest
    MP.send("plat", "pos", {x: x, y: y, z: z, r: r, a: P.anim, q: Math.floor(V.simQ) % 1073741824});
  }

  /* ---------- autopilot: runs the level's route with the real controller (smoke tests) ---------- */
  function autoFromCp(){
    var P = me(), A = V.auto; if(!P || !A) return;
    var L = V.level, k = 0;
    if(P.cp > 0){ var c = L.cps[P.cp - 1]; L.route.forEach(function(w, i){ if(Math.abs(w[0] - c[0]) + Math.abs(w[2] - c[2]) < 0.01) k = i + 1; }); }
    A.i = k; A.air = null;
  }
  function autoInput(P){
    var A = V.auto, R = V.level.route, w = R[A.i];
    if(!w) return {x: 0, z: 0, j: false};
    if(A.air){                                     // in the air on a jump arc: keep its speed, double-jump at the top
      var j = false;
      if(A.air.kind === "d" && !A.air.dj && P.vy <= 0){ A.air.dj = true; j = true; }
      if(P.ground && now() - A.air.t0 > 0.1){ A.air = null; A.i++; return {x: 0, z: 0, j: false}; }
      return {x: A.air.wx, z: A.air.wz, j: j};
    }
    var dx = w[0] - P.x, dz = w[2] - P.z, d = Math.sqrt(dx*dx + dz*dz);
    if(w[3] === "w"){
      if(d < 0.2){ A.i++; return autoInput(P); }
      var k = Math.min(1, d/0.6);
      return {x: dx/d*k, z: dz/d*k, j: false};
    }
    // take off: set the arc's velocity (the route's arcs run at a constant horizontal speed) and jump
    var dh = w[1] - P.y, T;
    if(w[3] === "j") T = (JUMP + Math.sqrt(Math.max(0, JUMP*JUMP - 2*GRAV*dh)))/GRAV;
    else T = JUMP/GRAV + (DJUMP + Math.sqrt(Math.max(0, DJUMP*DJUMP + 2*GRAV*(JUMP*JUMP/(2*GRAV) - dh))))/GRAV;
    var v = Math.min(RUN, d/T);
    P.vx = dx/d*v; P.vz = dz/d*v;
    A.air = {kind: w[3], wx: dx/d*v/RUN, wz: dz/d*v/RUN, dj: false, t0: now()};
    return {x: A.air.wx, z: A.air.wz, j: true};
  }

  /* ---------- remote players: snapshot interpolation ---------- */
  function pushSnap(P, m){
    var t = now(), q = m.q;
    if(typeof q === "number" && isFinite(q)){
      var st = E.senderTime(P, q, t, JIT_MAX);
      if(st === null) return;
      t = st;
    }
    var sn = P.snaps, last = sn[sn.length - 1];
    if(last && t <= last.t) t = last.t + 0.001;
    var x = (+m.x || 0)/100, y = (+m.y || 0)/100, z = (+m.z || 0)/100;
    var tp = !!m.tp || (last && (Math.abs(x - last.x) > 8 || Math.abs(z - last.z) > 8 || Math.abs(y - last.y) > 8));
    if(tp) sn.length = 0;
    sn.push({t: t, x: x, y: y, z: z, yaw: (+m.r || 0)*Math.PI/180, a: clamp(m.a|0, 0, 4)});
    if(sn.length > SNAPS) sn.shift();
    if(tp || sn.length === 1){ P.x = x; P.y = y; P.z = z; P.yaw = sn[sn.length - 1].yaw; P.snap = true; }
  }
  function sampleSnaps(P, t, dt){
    var sn = P.snaps, n = sn.length; if(!n) return;
    var rt = t - INTERP - P.jit, x, y, z, yaw, a;
    if(rt <= sn[0].t){ x = sn[0].x; y = sn[0].y; z = sn[0].z; yaw = sn[0].yaw; a = sn[0].a; }
    else if(rt >= sn[n-1].t){
      var Lz = sn[n-1], Pv = n > 1 ? sn[n-2] : Lz, span = Lz.t - Pv.t || 1, ex = Math.min(rt - Lz.t, EXTRAP);
      x = Lz.x + (Lz.x - Pv.x)/span*ex; z = Lz.z + (Lz.z - Pv.z)/span*ex; y = Lz.y; yaw = Lz.yaw; a = Lz.a;
    } else {
      for(var i = n - 1; i > 0 && sn[i-1].t > rt; i--){}
      var A = sn[i-1], B = sn[i], u = (rt - A.t)/((B.t - A.t) || 1);
      x = A.x + (B.x - A.x)*u; y = A.y + (B.y - A.y)*u; z = A.z + (B.z - A.z)*u; yaw = angLerp(A.yaw, B.yaw, u); a = u < 0.5 ? A.a : B.a;
    }
    var k = calm() || P.snap ? 1 : 1 - Math.exp(-20*dt); P.snap = false;
    P.x += (x - P.x)*k; P.y += (y - P.y)*k; P.z += (z - P.z)*k; P.yaw = angLerp(P.yaw, yaw, Math.min(1, k*1.5));
    if(a === A_DJUMP && P.anim !== A_DJUMP) P.djAt = now();
    if(a === A_JUMP && P.anim !== A_JUMP && P.anim !== A_DJUMP) P.jumpAt = now();
    P.anim = a; P.ground = a === A_IDLE || a === A_RUN;
  }

  /* ---------- the loop ---------- */
  function wishFromInput(){
    var ix = IN ? IN.axis("x") : 0, iy = IN ? IN.axis("y") : 0, l = Math.sqrt(ix*ix + iy*iy);
    if(l > 1){ ix /= l; iy /= l; }
    var yaw = V.map ? 0 : V.camYaw, fx = Math.sin(yaw), fz = -Math.cos(yaw), rx = Math.cos(yaw), rz = Math.sin(yaw);
    return {x: fx*iy + rx*ix, z: fz*iy + rz*ix};
  }
  function update(dt, t){
    if(!V.level) return;
    if(IN) IN.poll();
    if(IN && IN.pressed("help")){ var s = psave(); s.keysHidden = !s.keysHidden; api.persist(); renderKeys(); }
    if(IN && IN.pressed("camera")) V.camFar = !V.camFar;
    // camera: mouse (locked or right-drag), right stick, Q / E
    var lk = IN ? IN.look() : {dx: 0, dy: 0};
    lk.dx += lookX; lk.dy += lookY; lookX = 0; lookY = 0;
    V.camYaw += lk.dx*0.0045; V.camPitch = clamp(V.camPitch + lk.dy*0.003, 0.12, 1.25);
    if(IN && IN.keys){ if(IN.keys.KeyQ) V.camYaw -= 2.2*dt; if(IN.keys.KeyE) V.camYaw += 2.2*dt; }
    var P = me();
    if(V.preview){ if(!calm() && t - lookAt > 2) V.camYaw += dt*0.25; if(lk.dx || lk.dy || (IN && IN.keys && (IN.keys.KeyQ || IN.keys.KeyE))) lookAt = t; return; }
    if(V.phase === "grid"){
      var left = Math.ceil(V.goAt - t);
      if(left > 0 && left <= 3){ if(cdBox.textContent !== String(left)){ cdShow(String(left)); say(String(left)); } }
      if(V.mode === "practice" && t >= V.goAt){ V.phase = "run"; V.startAt = t; cdShow("GO!"); say("Go!"); }
    }
    var running = V.phase === "run" && P && P.fin == null && !V.paused && !V.respawn;
    if(running && IN && IN.pressed("reset")) startRespawn();
    if(P && (V.phase === "run" || V.phase === "done" || V.phase === "grid")){
      var jp = running && ((IN && IN.pressed("jump")) || jumpLatch), wish = running ? wishFromInput() : {x: 0, z: 0};
      acc += dt;
      while(acc >= STEP){
        if(V.auto && running){ var ai = autoInput(P); wish = {x: ai.x, z: ai.z}; jp = ai.j || false; }
        var a0 = [P.x, P.y + PL.CENTER, P.z];
        physics(P, STEP, wish.x, wish.z, jp); jp = false; V.simQ += STEP*100;
        if(running) reachLocal(P, a0, [P.x, P.y + PL.CENTER, P.z]);
        acc -= STEP;
      }
      if(running && P.y < V.level.kill) startRespawn();
    }
    jumpLatch = false;
    // the camera drifts round behind a runner who moves without turning it (never in the map view)
    if(lk.dx || lk.dy || (IN && IN.keys && (IN.keys.KeyQ || IN.keys.KeyE))) lookAt = t;
    if(P && !V.map && t - lookAt > 1.2 && V.phase === "run"){
      var hs = Math.sqrt(P.vx*P.vx + P.vz*P.vz);
      if(hs > 1.5){ var want = Math.atan2(P.vx, -P.vz), dd = Math.atan2(Math.sin(want - V.camYaw), Math.cos(want - V.camYaw));
        if(Math.abs(dd) < 2.6) V.camYaw += dd*Math.min(1, dt*0.9*hs/RUN); }
    }
    respawnTick(t);
    for(var k in V.pend) if(t - V.pend[k] > 1.5) delete V.pend[k];
    V.order.forEach(function(uid){ if(uid !== myId()) sampleSnaps(V.ps[uid], t, dt); });
    sendPos(t);
    if(cdBox.dataset.until && t > +cdBox.dataset.until){ cdBox.classList.add("hidden"); cdBox.dataset.until = ""; }
  }
  var WB = null;    // HQ 2.1 spectate: follow any runner
  function watchList(){ return V.order.filter(function(u){ return u !== myId() && V.ps[u]; }).map(function(u){ return {id: u, name: V.ps[u].name}; }); }
  function hudUpdate(){
    if(!WB) WB = E.watchBar(stage, {list: watchList, get: function(){ return me() ? null : V.spectate; }, set: function(id){ V.spectate = id; }});
    WB.update();
    if(!V.level){ hudTitle.textContent = ""; return; }
    var P = me(), t = now(), F = P || V.ps[V.spectate] || null, L = V.level, coop = V.play === "coop";
    var title = (V.preview ? "Preview" : V.mode === "practice" ? "Time trial" : coop ? "Co-op" : "Race")+" · "+L.name+(V.mode === "mp" && !coop && F && F.place ? " · P"+F.place+"/"+V.order.length : "");
    if(hudTitle.textContent !== title) hudTitle.textContent = title;
    var el = V.phase === "run" ? (t - V.startAt)*1000 : 0;
    if(P && P.fin != null) el = P.fin;
    var tt;
    if(coop){ tt = V.phase === "run" ? "⏱ "+fmtS(V.limitMs - el)+" left" : V.phase === "grid" ? "⏱ "+fmtS(V.limitMs) : ""; }
    else { var best = V.mode === "practice" ? psave().best[L.id] : null; tt = "⏱ "+fmt(el)+(best ? " · best "+fmt(best) : ""); }
    if(hudTime.textContent !== tt) hudTime.textContent = tt;
    var cp = F ? F.cp : 0, ct = coop ? "Checkpoint "+cp+"/"+L.cps.length : F && F.fin != null ? "Flag reached 🚩" : cp >= L.cps.length ? "All checkpoints · run to the flag 🚩" : "Checkpoint "+cp+"/"+L.cps.length;
    if(hudCp.textContent !== ct) hudCp.textContent = ct;
    var mineN = P ? (V.mode === "mp" ? P.coins : P.coins) : 0;
    var cc = "🪙 "+mineN+(coop ? " · team "+V.roomCoins+"/"+V.goal : " / "+L.coins.length);
    if(hudCoins.textContent !== cc) hudCoins.textContent = cc;
    bar.classList.toggle("hidden", !coop);
    if(coop){ var w = Math.round(100*clamp(V.roomCoins/(V.goal || 1), 0, 1))+"%"; if(barFill.style.width !== w) barFill.style.width = w; }
    if(V.mode === "mp"){
      var sig = V.standings.join(",")+"|"+V.order.map(function(u){ var c = V.ps[u]; return (c.fin != null ? "f" : c.dnf ? "d" : c.away ? "a" : "")+(coop ? c.coins : c.cp); }).join(",");
      if(hudStand.dataset.sig !== sig){
        hudStand.dataset.sig = sig; hudStand.textContent = "";
        var ord = (V.standings.length ? V.standings : V.order).slice();
        if(coop) ord.sort(function(a, b){ return ((V.ps[b] || {}).coins|0) - ((V.ps[a] || {}).coins|0); });
        ord.forEach(function(u){ var c = V.ps[u]; if(!c) return;
          var li = api.mk("li", u === myId() ? "me" : null), sw = api.mk("i", "vg-plat-sw"); sw.style.background = CHAR_SWATCH[c.chr|0] || CHAR_SWATCH[0];
          li.appendChild(sw); li.appendChild(document.createTextNode(" "+c.name+(coop ? " · 🪙"+(c.coins|0) : " · "+(c.fin != null ? "🚩" : "cp "+c.cp))+(c.dnf ? " (out)" : c.away ? " (away)" : "")));
          hudStand.appendChild(li); });
      }
    }
  }

  /* ---------- renderers ---------- */
  function ensureRenderer(){
    if(canvas) return;
    wrap.textContent = "";
    [hud, cdBox, fade, cardBox, badge, load].forEach(function(n){ wrap.appendChild(n); });
    canvas = api.mk("canvas", "vg-golf-canvas vg-plat-canvas"); canvas.tabIndex = 0;
    canvas.setAttribute("aria-label", "Platformer. W A S D or the arrows run, Space jumps and jumps again in the air, Q and E turn the camera, R goes back to your checkpoint.");
    wrap.insertBefore(canvas, wrap.firstChild);
    if(IN) IN.destroy();
    IN = HQV.input ? HQV.input.create(wrap, {extraKeys: ["KeyQ", "KeyE"]}) : null;
    canvas.addEventListener("pointerdown", function(e){
      canvas.focus();
      if(e.button === 0 && R3 && !V.map && V.phase !== "done"){ try { var r = canvas.requestPointerLock && canvas.requestPointerLock(); if(r && r.catch) r.catch(function(){}); } catch(err){} }
    });
    canvas.addEventListener("contextmenu", function(e){ e.preventDefault(); });
    // a tap shorter than one frame still jumps (the input layer polls once a frame)
    canvas.addEventListener("keydown", function(e){ if(e.code === "Space" && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) jumpLatch = true; });
    resize();
    if(!V.map && hasWebGL2()){
      R2 = make2d(null);
      load.classList.remove("hidden"); loadFill.style.width = "10%";
      make3d(canvas).then(function(r){
        load.classList.add("hidden");
        if(!V.alive){ r.dispose(); return; }
        R3 = r; R2 = null; if(V.level) R3.buildLevel(); resize();
      }, function(e){
        load.classList.add("hidden");
        if(!V.alive) return;
        if(window.console) console.error("platformer 3d", e);
        V.note = "3D unavailable: showing the map view."; api.toast(V.note); fallback2d();
      });
    } else R2 = make2d(canvas);
    if(!raf) raf = requestAnimationFrame(frame);
  }
  function onMouse(e){
    if(!canvas) return;
    if(document.pointerLockElement === canvas){ lookX += e.movementX || 0; lookY += e.movementY || 0; }
    else if((e.buttons & 2) && e.target === canvas){ lookX += e.movementX || 0; lookY += e.movementY || 0; }
  }
  document.addEventListener("pointermove", onMouse);
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
  var hudAt = 0;
  function frame(ts){
    if(!V.alive) return;
    raf = requestAnimationFrame(frame);
    var t = ts/1000, dt = lastT ? clamp(t - lastT, 0, 0.25) : 0; lastT = t;
    try {
      if(t - tokAt > 2){ TOK = tokens(); tokAt = t; }
      if(!V.paused) update(dt, now());
      if(R3) R3.render(dt, now()); else if(R2) R2.render();
      if(t - hudAt > 0.1){ hudAt = t; hudUpdate(); }
    } catch(e){ if(window.console) console.error("platformer frame", e); }
  }
  function coinHidden(i){ return !!(V.mine[i] || V.pend[i] || (V.play === "coop" && V.taken[i])); }

  // 2D map view: north-up, centred on your runner; platforms shaded by height.
  function make2d(cv){
    var R = {canvas: cv};
    R.render = function(){
      if(!cv) return;
      var g = cv.getContext("2d"), W = cv.width, H = cv.height, T = TOK;
      g.setTransform(1, 0, 0, 1, 0, 0); g.fillStyle = T.bg2; g.fillRect(0, 0, W, H);
      if(!V.level){ g.fillStyle = T.muted; g.font = "14px sans-serif"; g.fillText("Loading…", 16, 24); return; }
      var F = me() || V.ps[V.spectate] || V.ps[V.order[0]], sc = Math.min(W, H)/34, L = V.level;
      g.save(); g.translate(W/2, H/2); g.scale(sc, sc); if(F) g.translate(-F.x, -F.z);
      var lo = 1e9, hi = -1e9; L.solids.forEach(function(s){ lo = Math.min(lo, s.y1); hi = Math.max(hi, s.y1); });
      L.solids.slice().sort(function(a, b){ return a.y1 - b.y1; }).forEach(function(s){
        // higher platforms drawn later and tinted stronger with the accent
        function shape(){ g.beginPath(); if(s.r > 0) g.arc(s.cx, s.cz, s.r, 0, Math.PI*2); else g.rect(s.x0, s.z0, s.x1 - s.x0, s.z1 - s.z0); }
        shape(); g.fillStyle = T.panel; g.fill();
        g.globalAlpha = 0.12 + 0.4*(s.y1 - lo)/((hi - lo) || 1); g.fillStyle = T.brand; g.fill(); g.globalAlpha = 1;
        g.lineWidth = 0.1; g.strokeStyle = T.muted; g.stroke();
        g.fillStyle = T.ink; g.font = "0.5px "+T.mono; g.textAlign = "center";
        g.fillText(s.y1.toFixed(1)+" m", s.cx, s.cz + 0.2);
      });
      L.cps.forEach(function(c, i){ g.beginPath(); g.arc(c[0], c[2], 1.0, 0, Math.PI*2); g.lineWidth = 0.15;
        g.strokeStyle = F && i < F.cp ? T.good : F && i === F.cp ? T.brand : T.muted; g.stroke(); });
      g.fillStyle = T.need; g.fillRect(L.flag[0] - 0.1, L.flag[2] - 0.9, 0.2, 0.9); g.beginPath(); g.moveTo(L.flag[0] + 0.1, L.flag[2] - 0.9);
      g.lineTo(L.flag[0] + 0.8, L.flag[2] - 0.65); g.lineTo(L.flag[0] + 0.1, L.flag[2] - 0.4); g.fill();
      g.fillStyle = T.gold; L.coins.forEach(function(c, i){ if(coinHidden(i)) return; g.beginPath(); g.arc(c[0], c[2], 0.22, 0, Math.PI*2); g.fill(); });
      V.order.forEach(function(uid){
        var P = V.ps[uid]; g.save(); g.translate(P.x, P.z); g.rotate(-P.yaw + Math.PI);
        g.beginPath(); g.arc(0, 0, 0.5, 0, Math.PI*2); g.fillStyle = CHAR_SWATCH[P.chr|0] || T.brand; g.fill();
        g.lineWidth = uid === myId() ? 0.16 : 0.08; g.strokeStyle = T.ink; g.stroke();
        g.beginPath(); g.moveTo(0, -0.7); g.lineTo(0.25, -0.35); g.lineTo(-0.25, -0.35); g.fillStyle = T.ink; g.fill();
        g.restore();
        if(uid !== myId()){ g.fillStyle = T.ink; g.font = "0.6px sans-serif"; g.textAlign = "center"; g.fillText(P.name.slice(0, 16), P.x, P.z - 0.8); }
      });
      g.restore();
      if(F){ g.fillStyle = T.ink; g.font = "600 13px "+T.mono; g.textAlign = "left"; g.fillText("height "+F.y.toFixed(1)+" m", 10, H - 12); }
    };
    return R;
  }

  function make3d(cv){
    return platLib().then(function(lib){
      var names = ["platform", "platform-medium", "platform-large", "platform-falling", "platform-grass-large-round", "brick", "block-coin",
                   "coin", "flag", "cloud", "grass", "grass-small", "character"];
      var done = 0, GL = {};
      return Promise.all(names.map(function(n){ return loadGlb(lib, n).then(function(g){ GL[n] = g; done++; loadFill.style.width = Math.round(10 + 85*done/names.length)+"%"; }); }))
        .then(function(){ return new Promise(function(res){ lib.tex.load("/games/platformer/blob-shadow.png", res, null, function(){ res(null); }); }); })
        .then(function(shadowTex){ return build3d(lib, lib.THREE, cv, shadowTex, GL); });
    });
  }
  function build3d(lib, THREE, cv, shadowTex, GL){
    var renderer = new THREE.WebGLRenderer({canvas: cv, antialias: !V.low});
    renderer.setPixelRatio(V.low ? 1 : Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = !V.low; renderer.shadowMap.type = THREE.PCFShadowMap;
    var scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(60, 1.6, 0.1, 500);
    var hemi = new THREE.HemisphereLight(0xffffff, 0x8899aa, 1.9); scene.add(hemi);
    var sun = new THREE.DirectionalLight(0xffffff, 2.0); sun.position.set(10, 25, 6);
    sun.castShadow = !V.low; sun.shadow.mapSize.set(1024, 1024); sun.shadow.bias = -0.0005; sun.shadow.normalBias = 0.02;
    var sc = sun.shadow.camera; sc.left = -22; sc.right = 22; sc.top = 22; sc.bottom = -22; sc.near = 1; sc.far = 80;
    scene.add(sun); scene.add(sun.target);
    var seaGeo = new THREE.PlaneGeometry(1600, 1600); seaGeo.rotateX(-Math.PI/2);
    var seaMat = new THREE.MeshLambertMaterial({color: 0x5aa9e6}), sea = new THREE.Mesh(seaGeo, seaMat); scene.add(sea);
    var shadowMat = shadowTex ? new THREE.MeshBasicMaterial({map: shadowTex, transparent: true, depthWrite: false, opacity: 0.6}) : null;
    var shadowGeo = new THREE.PlaneGeometry(1, 1); shadowGeo.rotateX(-Math.PI/2);
    var levelGroup = null, coinObjs = [], cpObjs = [], flagObj = null, pops = [];
    var lost = function(e){ e.preventDefault(); if(V.alive) setTimeout(fallback2d, 0); };
    cv.addEventListener("webglcontextlost", lost);
    function model(name, cast){
      var g = GL[name]; if(!g) return new THREE.Group();
      var o = lib.clone(g.scene);
      o.traverse(function(m){ if(m.isMesh){ m.castShadow = !V.low && cast; m.receiveShadow = !V.low; } });
      return o;
    }
    function ring(color, r, op){
      var m = new THREE.Mesh(new THREE.TorusGeometry(r, 0.07, 8, 40), new THREE.MeshBasicMaterial({color: color, transparent: true, opacity: op}));
      m.rotation.x = Math.PI/2; return m;
    }
    function buildLevel(){
      clearLevel();
      if(!V.level) return;
      var L = V.level, th = L.theme || {};
      levelGroup = new THREE.Group(); scene.add(levelGroup);
      scene.background = new THREE.Color(hex(th.sky, 0x8fd3ff));
      scene.fog = new THREE.Fog(hex(th.fog, 0xcdeeff), V.low ? 40 : 60, V.low ? 110 : 170);
      seaMat.color.setHex(hex(th.sea, 0x5aa9e6)); sea.position.y = L.kill - 1.5;
      sun.color.setHex(hex(th.light, 0xffffff));
      (L.src ? [L.src] : (DATA.levels || [])).forEach(function(lv){
        if(lv.id !== L.id) return;
        (lv.solids || []).forEach(function(b){
          var o = model(b.m, true); o.position.set(+b.x, +b.y, +b.z); o.rotation.y = (+b.r || 0)*Math.PI/180;
          if(b.s) o.scale.setScalar(+b.s);
          levelGroup.add(o);
        });
      });
      (L.deco || []).forEach(function(d){
        if(V.low && d.m !== "cloud") return;
        if(!/^(grass|grass-small|cloud)$/.test(d.m)) return;
        var o = model(d.m, false); o.position.set(+d.x, +d.y, +d.z); o.rotation.y = (+d.r || 0)*Math.PI/180;
        if(d.s) o.scale.setScalar(+d.s);
        if(d.m === "cloud") o.traverse(function(m){ if(m.isMesh){ m.castShadow = false; m.receiveShadow = false; } });
        levelGroup.add(o);
      });
      coinObjs = L.coins.map(function(c){ var o = model("coin", true); o.scale.setScalar(1.5); o.position.set(c[0], c[1] - 0.31, c[2]); levelGroup.add(o); return o; });
      cpObjs = L.cps.map(function(c){
        var g = new THREE.Group(), f = model("flag", true); f.scale.setScalar(1.3); f.position.set(0.9, 0, 0.9); g.add(f);
        var rg = ring(0xffffff, 1.0, 0.55); rg.position.y = 0.06; g.add(rg); g.position.set(c[0], c[1], c[2]);
        levelGroup.add(g); return {g: g, ring: rg};
      });
      flagObj = new THREE.Group();
      var fl = model("flag", true); fl.scale.setScalar(2.4); flagObj.add(fl);
      var fr = ring(0xffd24a, 1.4, 0.8); fr.position.y = 0.06; flagObj.add(fr); flagObj.ring = fr;
      flagObj.position.set(L.flag[0], L.flag[1], L.flag[2]); flagObj.rotation.y = -Math.PI/4; levelGroup.add(flagObj);
      V.order.forEach(function(uid){ removeP(V.ps[uid]); });
      camInit = false;
    }
    function clearLevel(){
      camInit = false;
      if(levelGroup){ scene.remove(levelGroup); levelGroup = null; }
      coinObjs = []; cpObjs = []; flagObj = null; pops = [];
      V.order.forEach(function(uid){ removeP(V.ps[uid]); });
    }
    function tag(text){
      var c = document.createElement("canvas"), g = c.getContext("2d"); c.width = 256; c.height = 64;
      g.font = "700 30px sans-serif"; g.textAlign = "center"; g.textBaseline = "middle";
      var w = Math.min(250, g.measureText(text).width + 28);
      g.fillStyle = "rgba(20,24,32,0.72)"; g.beginPath(); g.roundRect ? g.roundRect(128 - w/2, 8, w, 48, 18) : g.rect(128 - w/2, 8, w, 48); g.fill();
      g.fillStyle = "#ffffff"; g.fillText(text, 128, 33);
      var tx = new THREE.CanvasTexture(c); tx.colorSpace = THREE.SRGBColorSpace;
      var sp = new THREE.Sprite(new THREE.SpriteMaterial({map: tx, depthTest: false, transparent: true})); sp.scale.set(2.0, 0.5, 1); sp.renderOrder = 10;
      return sp;
    }
    var CLIP = {}; CLIP[A_IDLE] = "idle"; CLIP[A_RUN] = "walk"; CLIP[A_JUMP] = "jump"; CLIP[A_FALL] = "jump"; CLIP[A_DJUMP] = "jump";
    function addP(P){
      var g = GL.character, outer = new THREE.Group(), body = new THREE.Group(), o = lib.clone(g.scene);
      var tint = CHARS[P.chr|0] ? CHARS[P.chr|0].c : 0xffffff;
      var worn = P.cos && hex(P.cos.runner, null); if(worn != null) tint = worn;      // HQ 2.1 runner colour
      o.traverse(function(m){ if(m.isMesh){ m.castShadow = !V.low; m.receiveShadow = false; if(tint !== 0xffffff){ m.material = m.material.clone(); m.material.color.setHex(tint); } } });
      body.add(o); outer.add(body);
      var mixer = new THREE.AnimationMixer(o), actions = {};
      ["idle", "walk", "jump"].forEach(function(n){ var clip = THREE.AnimationClip.findByName(g.animations, n); if(clip) actions[n] = mixer.clipAction(clip); });
      if(actions.jump){ actions.jump.setLoop(THREE.LoopOnce, 1); actions.jump.clampWhenFinished = true; }
      var sh = shadowMat ? new THREE.Mesh(shadowGeo, shadowMat) : null; if(sh){ sh.scale.setScalar(0.9); scene.add(sh); }
      var tg = null; if(P.uid !== myId()){ tg = tag(P.name.slice(0, 18)); tg.position.set(0, 1.55, 0); outer.add(tg); }
      P.mesh = {g: outer, body: body, mixer: mixer, actions: actions, cur: "", sh: sh, tag: tg, chr: P.chr|0}; scene.add(outer);
    }
    function removeP(P){ if(P && P.mesh){ scene.remove(P.mesh.g); if(P.mesh.sh) scene.remove(P.mesh.sh); P.mesh.mixer.stopAllAction(); P.mesh = null; } }
    function play(m, name, restart){
      var a = m.actions[name]; if(!a) return;
      if(m.cur === name && !restart) return;
      var prev = m.actions[m.cur];
      a.reset(); a.play();
      if(prev && prev !== a) prev.crossFadeTo(a, calm() ? 0.01 : 0.12, false);
      m.cur = name;
    }
    function coinPop(i, mine){
      var o = coinObjs[i]; if(!o) return;
      if(calm() || !mine){ o.visible = false; return; }
      pops.push({o: o, t0: now(), y: o.position.y});
    }
    function topBelow(x, y, z){
      var best = null; V.level.solids.forEach(function(s){ if(s.y1 <= y + 0.05 && PL.inFoot(s, x, z, 0) && (best === null || s.y1 > best)) best = s.y1; });
      return best;
    }
    var camPos = new THREE.Vector3(0, 6, 10), look = new THREE.Vector3(), want = new THREE.Vector3(), camInit = false;
    function camBlocked(x, y, z){
      var sol = V.level.solids;
      for(var i = 0; i < sol.length; i++){
        var s = sol[i];
        if(y > s.y0 - 0.25 && y < s.y1 + 0.25 && PL.inFoot(s, x, z, 0.25)) return true;
      }
      return false;
    }
    var R = {};
    R.buildLevel = buildLevel; R.clearLevel = clearLevel; R.removeP = removeP; R.coinPop = coinPop;
    R.size = function(w, h){ renderer.setSize(w, h, false); camera.aspect = w/h; camera.updateProjectionMatrix(); };
    R.render = function(dt, t){
      if(!V.level){ renderer.render(scene, camera); return; }
      var cm = calm();
      coinObjs.forEach(function(o, i){
        var hid = coinHidden(i);
        if(hid && !pops.some(function(p){ return p.o === o; })) o.visible = false; else if(!hid) o.visible = true;
        if(!cm) o.rotation.y = t*2.4 + i*0.4;
      });
      for(var pi = pops.length - 1; pi >= 0; pi--){
        var pp = pops[pi], age = t - pp.t0;
        if(age > 0.35){ pp.o.visible = false; pp.o.position.y = pp.y; pp.o.scale.setScalar(1.5); pops.splice(pi, 1); continue; }
        pp.o.position.y = pp.y + age*3; pp.o.scale.setScalar(1.5*(1 - age/0.35*0.6)); pp.o.rotation.y += dt*20;
      }
      var F = me() || V.ps[V.spectate] || V.ps[V.order[0]];
      cpObjs.forEach(function(c, i){
        var next = F && i === F.cp, passed = F && i < F.cp;
        c.ring.material.color.setHex(passed ? 0x7bd36a : next ? 0x3fb6ff : 0xffffff);
        c.ring.material.opacity = next ? (cm ? 0.95 : 0.7 + 0.25*Math.sin(t*4)) : passed ? 0.8 : 0.35;
      });
      if(flagObj){ var ready = F && F.cp >= V.level.cps.length; flagObj.visible = V.play !== "coop"; flagObj.ring.material.opacity = ready ? (cm ? 1 : 0.75 + 0.25*Math.sin(t*4)) : 0.4; }
      V.order.forEach(function(uid){
        var P = V.ps[uid];
        if(P.mesh && P.mesh.chr !== (P.chr|0)) removeP(P);
        if(!P.mesh) addP(P);
        var m = P.mesh;
        m.g.position.set(P.x, P.y, P.z); m.g.rotation.y = P.yaw;
        var an = CLIP[P.anim] || "idle";
        play(m, an, (P.anim === A_DJUMP || P.anim === A_JUMP) && ((m.djSeen !== P.djAt && P.anim === A_DJUMP) || (m.jSeen !== P.jumpAt && P.anim === A_JUMP)));
        m.djSeen = P.djAt; m.jSeen = P.jumpAt;
        if(an === "walk" && m.actions.walk) m.actions.walk.timeScale = clamp(Math.sqrt(P.vx*P.vx + P.vz*P.vz)/RUN, 0.4, 1)*1.6 + (uid === myId() ? 0 : 0.6);
        // squash on landing, stretch on take-off, a spin on the double jump (none in Calm)
        var sy = 1, ry = 0;
        if(!cm){
          var la = t - P.landAt, ja = t - P.jumpAt, da = t - P.djAt;
          if(la < 0.15) sy = 1 - 0.22*Math.sin(la/0.15*Math.PI);
          else if(ja < 0.15) sy = 1 + 0.18*Math.sin(ja/0.15*Math.PI);
          if(da < 0.4) ry = (da/0.4)*Math.PI*2;
        }
        m.body.scale.set(1/Math.sqrt(sy), sy, 1/Math.sqrt(sy)); m.body.rotation.y = ry;
        m.mixer.update(dt);
        if(m.sh){ var tb = topBelow(P.x, P.y, P.z); m.sh.visible = tb !== null && P.y - tb < 12; if(tb !== null){ m.sh.position.set(P.x, tb + 0.03, P.z); m.sh.scale.setScalar(0.9*clamp(1 - (P.y - tb)/8, 0.35, 1)); } }
        if(m.tag) m.tag.visible = !(P.fin != null && V.phase !== "run");
      });
      // camera: orbit behind the runner, pulled in so it never ends up inside a platform
      if(F){
        var dist = V.camFar ? 11 : V.camDist, tx = F.x, ty = F.y + 1.1, tz = F.z;
        var cp = Math.cos(V.camPitch), sp = Math.sin(V.camPitch), fx = Math.sin(V.camYaw), fz = -Math.cos(V.camYaw);
        var dx = -fx*cp, dy = sp, dz = -fz*cp, d = dist;
        for(var s = 0.4; s <= dist; s += 0.2){ if(camBlocked(tx + dx*s, ty + dy*s, tz + dz*s)){ d = Math.max(0.6, s - 0.3); break; } }
        want.set(tx + dx*d, ty + dy*d, tz + dz*d);
        var k = cm || !camInit ? 1 : 1 - Math.exp(-dt*10); camInit = true;
        camPos.lerp(want, k);
        look.set(tx, ty, tz);
        camera.position.copy(camPos); camera.lookAt(look);
        sun.position.set(F.x + 10, F.y + 25, F.z + 6); sun.target.position.set(F.x, F.y, F.z);
      }
      renderer.render(scene, camera);
    };
    R.dispose = function(){
      cv.removeEventListener("webglcontextlost", lost);
      clearLevel(); renderer.dispose();
      try { var ext = renderer.getContext().getExtension("WEBGL_lose_context"); if(ext) ext.loseContext(); } catch(e){}
    };
    return R;
  }
  function onResize(){ resize(); }
  window.addEventListener("resize", onResize);
  if(typeof ResizeObserver !== "undefined"){ ro = new ResizeObserver(onResize); ro.observe(host); }
  renderKeys();
  renderMenu();
  loadData().then(function(){
    if(!V.alive) return; renderMenu();
    if(opts.custom && V.mode !== "mp"){
      var L = registerCustom("local-test", opts.custom);
      if(!L){ V.note = "That level doesn't load."; api.toast(V.note); return; }
      if(opts.preview) startPreview(L.id); else startPractice(L.id);
      return;
    }
    if(V.mode === "mp" && V.gotView) applyView(V.round); else if(V.mode === "mp") requestView(); },
    function(){ V.note = "Couldn't load the levels."; renderMenu(); });
  if(!raf) raf = requestAnimationFrame(frame);
  V.destroy = function(){
    if(WB){ WB.destroy(); WB = null; }
    V.alive = false;
    if(raf) cancelAnimationFrame(raf); raf = 0;
    window.removeEventListener("resize", onResize); if(ro) ro.disconnect();
    document.removeEventListener("pointermove", onMouse);
    try { if(canvas && document.pointerLockElement === canvas) document.exitPointerLock(); } catch(e){}
    if(IN){ IN.destroy(); IN = null; }
    if(R3){ R3.dispose(); R3 = null; }
    root.remove();
  };
  V.onEvent = onEvent; V.onError = onError;
  V.onConn = function(on){
    V.offline = !on; badge.classList.toggle("hidden", on);
    if(!on) V.order.forEach(function(u){ var P = V.ps[u]; if(u !== myId()) P.lastQ = -1; });
  };
  V.startPractice = startPractice;     // smoke tests
  V.autopilot = function(on){ V.auto = on ? {i: 0, air: null} : null; if(on) autoFromCp(); };
  V.me = me;
  V.rendererKind = function(){ return R3 ? "3d" : R2 && R2.canvas ? "2d" : ""; };
  return V;
}

/* ---------- registration: a solo card and a "with friends" card ---------- */
HQV.register({id: "plat", name: "Platformer Rush", icon: "🏝️", desc: "Jump and double-jump across floating islands to the flag",
  mount: function(el){ if(CUR) CUR.destroy(); CUR = makeGame(el, {mode: "practice"}); },
  unmount: function(){ if(CUR){ CUR.destroy(); CUR = null; } },
  pause: function(){ if(CUR) CUR.paused = true; },
  resume: function(){ if(CUR) CUR.paused = false; }});

if(MP){
  MP.handlers.plat = {
    on: function(m){ if(CUR && CUR.ctx) CUR.onEvent(m); },
    onError: function(m){ return CUR && CUR.ctx ? CUR.onError(m) : false; },
    render: function(){}
  };
  MP.register("plat", "🏝️", "Race or co-op through floating islands, up to 8", function(ctx){
    if(CUR) CUR.destroy();
    var g = CUR = makeGame(ctx.box, {mode: "mp", ctx: ctx});
    ctx.onConn = function(on){ if(g.alive) g.onConn(on); };
    ctx.onRejoin = function(){ if(g.alive && MP) MP.send("plat", "view"); };
    ctx.stop = function(){ g.destroy(); if(CUR === g) CUR = null; };
  });
}
HQV.platLevel = PL;      // for the browser smoke test
// HQ 2.5: the Level Editor test-runs and previews its level in this game's renderer, in its own
// box (opts: {custom: {name, data}, preview?, onExit}); a room start goes through HQV.platPending.
HQV.platPlay = function(host, opts){ return makeGame(host, {mode: "practice", custom: opts && opts.custom, preview: !!(opts && opts.preview), onExit: opts && opts.onExit}); };
HQV.platCompileCustom = compileCustom;
HQV.platDebug = function(){ return CUR; };
})();
