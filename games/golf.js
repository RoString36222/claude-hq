/* Valley: Mini Golf. 3D putting on Kenney's CC0 minigolf tiles, solo practice or with
 * friends in an Arena room.
 *
 * Rendering is three.js r186 (MIT), vendored unmodified except import paths under
 * games/vendor/ and imported only when this game opens. The ball physics is integer-only
 * (the GOLF-SIM block below) and mirrors backend/app/golf.py line for line: in a room the
 * server rolls every shot and this file replays the same simulation to animate it, so all
 * players see the same roll. Only shot integers, course coordinates, a yaw, an animation
 * id and a character id ever travel; nothing transcript-derived.
 * If WebGL2, the import or a model fails, the same game runs as a top-down map view.
 *
 * Multiplayer smoothness: my own putt rolls the moment I release (the same integer sim the
 * server runs) and the server's "shot" with my seq only confirms it (eased onto the server's
 * roll if they ever differ, rewound if refused). Other golfers are drawn from a small buffer
 * of timed snapshots (the sender's clock rides along as the sequence number q), ~100 ms plus
 * measured jitter behind, extrapolated briefly across gaps. Positions go out at <= 10/s and
 * only on change, with a final "rest" frame and a 2 s keepalive. A dropped room socket shows
 * "Reconnecting…"; the lobby shell re-joins and the server hands the round back.
 */
(function(){
"use strict";
var HQV = window.HQV; if(!HQV || !HQV.api) return;
var api = HQV.api, MP = HQV.mp || null;

/* GOLF-SIM BEGIN */
var GS = (function(){
  var TILE = 10000, HALF = 5000, R = 350, CUP = 670, VS = 256, TICK = 120;
  var VMIN = 30*VS, VMAX = 360*VS, DRAG_NUM = 25, DRAG_DEN = 10000, ROLL = 90, STOP = 60;
  var REST_NUM = 3, REST_DEN = 4, CAPTURE = 160*VS, SUBSTEP = 150*VS, MAX_TICKS = 1800;
  var MAX_STROKES = 8, OOB_PENALTY = 1, AIM_MAX = 4096;
  function tdiv(a, b){ return Math.trunc(a/b); }
  function isqrt(n){ if(n <= 0) return 0; var x = n, y = Math.floor((x+1)/2); while(y < x){ x = y; y = Math.floor((x + Math.floor(n/x))/2); } return x; }
  function rot(x, z, k){ k = k & 3; return k === 1 ? [z, -x] : k === 2 ? [-x, -z] : k === 3 ? [-z, x] : [x, z]; }
  function cellOf(v){ return Math.floor((v + HALF)/TILE); }
  function lexLess(a, b){ for(var i = 0; i < 4; i++){ if(a[i] !== b[i]) return a[i] < b[i]; } return false; }
  function compileHole(hole, pieces){
    var segs = [], seen = {}, floor = {}, voids = [], tee = null, cup = null, cols = [], rows = [];
    (hole.tiles || []).forEach(function(t){
      var p = pieces[t[0]] || {}, col = t[1]|0, row = t[2]|0, k = t[3]|0, cx = col*TILE, cz = row*TILE;
      floor[col+","+row] = 1; cols.push(col); rows.push(row);
      (p.segs || []).forEach(function(sg){
        var a = rot(sg[0], sg[1], k), b = rot(sg[2], sg[3], k);
        var s = [cx+a[0], cz+a[1], cx+b[0], cz+b[1]], r = [s[2], s[3], s[0], s[1]];
        var key = (lexLess(r, s) ? r : s).join(",");
        if(seen[key]) return;
        seen[key] = 1;
        var dx = s[2]-s[0], dz = s[3]-s[1];
        segs.push([s[0], s[1], dx, dz, isqrt(dx*dx + dz*dz) || 1]);
      });
      (p.voids || []).forEach(function(v){
        var a = rot(v[0], v[1], k), b = rot(v[2], v[3], k);
        voids.push([cx+Math.min(a[0], b[0]), cz+Math.min(a[1], b[1]), cx+Math.max(a[0], b[0]), cz+Math.max(a[1], b[1])]);
      });
      if(p.tee){ var te = rot(p.tee[0], p.tee[1], k); tee = [cx+te[0], cz+te[1]]; }
      if(p.cup){ var cu = rot(p.cup[0], p.cup[1], k); cup = [cx+cu[0], cz+cu[1]]; }
    });
    var grid = {};
    segs.forEach(function(sg, i){
      var loX = Math.min(sg[0], sg[0]+sg[2]) - R, hiX = Math.max(sg[0], sg[0]+sg[2]) + R;
      var loZ = Math.min(sg[1], sg[1]+sg[3]) - R, hiZ = Math.max(sg[1], sg[1]+sg[3]) + R;
      for(var c = cellOf(loX); c <= cellOf(hiX); c++) for(var r = cellOf(loZ); r <= cellOf(hiZ); r++){
        var key = c+","+r; (grid[key] = grid[key] || []).push(i);
      }
    });
    return {name: hole.name, par: hole.par|0, tiles: hole.tiles || [], segs: segs, grid: grid, floor: floor, voids: voids,
      tee: tee, cup: cup, bbox: [Math.min.apply(null, cols)*TILE - HALF, Math.min.apply(null, rows)*TILE - HALF,
        Math.max.apply(null, cols)*TILE + HALF, Math.max.apply(null, rows)*TILE + HALF]};
  }
  function onFloor(h, x, z){
    if(!h.floor[cellOf(x)+","+cellOf(z)]) return false;
    for(var i = 0; i < h.voids.length; i++){ var v = h.voids[i]; if(v[0] < x && x < v[2] && v[1] < z && z < v[3]) return false; }
    return true;
  }
  function launch(ax, az, power){
    var m = isqrt(ax*ax + az*az) || 1, sp = VMIN + tdiv((power-1)*(VMAX-VMIN), 99);
    return [tdiv(ax*sp, m), tdiv(az*sp, m)];
  }
  // One shot. Returns {end:[x,z], holed, oob, ticks} (+ path: one [x,z] per tick when wanted).
  function simulate(h, bx, bz, ax, az, power, wantPath){
    var sx = bx, sz = bz, v = launch(ax, az, power), vx = v[0], vz = v[1];
    var cx = h.cup[0], cz = h.cup[1], segs = h.segs, grid = h.grid, rr = R*R, path = wantPath ? [] : null;
    function done(o){ if(path){ path.push([o.end[0], o.end[1]]); o.path = path; } return o; }
    for(var t = 1; t <= MAX_TICKS; t++){
      var s = isqrt(vx*vx + vz*vz), n = Math.max(1, tdiv(s + SUBSTEP - 1, SUBSTEP));
      for(var j = 0; j < n; j++){
        bx += tdiv(vx, n*VS); bz += tdiv(vz, n*VS);
        var list = grid[cellOf(bx)+","+cellOf(bz)];
        if(!list) continue;
        for(var q = 0; q < list.length; q++){
          var sg = segs[list[q]], x1 = sg[0], z1 = sg[1], dx = sg[2], dz = sg[3], L = sg[4];
          var p = tdiv((bx-x1)*dx + (bz-z1)*dz, L);
          p = p < 0 ? 0 : (p > L ? L : p);
          var px = x1 + tdiv(dx*p, L), pz = z1 + tdiv(dz*p, L), ox = bx - px, oz = bz - pz, d2 = ox*ox + oz*oz;
          if(d2 < rr){
            var d = isqrt(d2) || 1;
            bx = px + tdiv(ox*R, d); bz = pz + tdiv(oz*R, d);
            var vn = tdiv(vx*ox + vz*oz, d);
            if(vn < 0){
              vx -= tdiv((REST_DEN+REST_NUM)*vn*ox, REST_DEN*d);
              vz -= tdiv((REST_DEN+REST_NUM)*vn*oz, REST_DEN*d);
            }
          }
        }
      }
      s = isqrt(vx*vx + vz*vz);
      var ddx = bx - cx, ddz = bz - cz;
      if(ddx*ddx + ddz*ddz < CUP*CUP && s <= CAPTURE) return done({end:[cx, cz], holed:true, oob:false, ticks:t});
      if(!onFloor(h, bx, bz)){ if(path) path.push([bx, bz]); return done({end:[sx, sz], holed:false, oob:true, ticks:t}); }
      var ns = s - tdiv(s*DRAG_NUM, DRAG_DEN) - ROLL;
      if(ns <= STOP) return done({end:[bx, bz], holed:false, oob:false, ticks:t});
      vx = tdiv(vx*ns, s); vz = tdiv(vz*ns, s);
      if(path) path.push([bx, bz]);
    }
    return done({end:[bx, bz], holed:false, oob:false, ticks:MAX_TICKS});
  }
  return {compileHole:compileHole, simulate:simulate, onFloor:onFloor, isqrt:isqrt, tdiv:tdiv, cellOf:cellOf,
    C:{TILE:TILE, R:R, CUP:CUP, VS:VS, TICK:TICK, VMIN:VMIN, VMAX:VMAX, DRAG_NUM:DRAG_NUM, DRAG_DEN:DRAG_DEN, ROLL:ROLL,
       STOP:STOP, REST_NUM:REST_NUM, REST_DEN:REST_DEN, CAPTURE:CAPTURE, SUBSTEP:SUBSTEP, MAX_TICKS:MAX_TICKS,
       MAX_STROKES:MAX_STROKES, OOB_PENALTY:OOB_PENALTY, AIM_MAX:AIM_MAX}};
})();
/* GOLF-SIM END */

var T = GS.C.TILE, FLOOR_Y = 0.063, BALL_R = 0.035, BALL_Y = FLOOR_Y + BALL_R;
var CHARS = [{f:"character-female-a", n:"Ada"}, {f:"character-male-a", n:"Abe"}, {f:"character-female-c", n:"Cleo"},
             {f:"character-male-c", n:"Cal"}, {f:"character-female-e", n:"Eve"}, {f:"character-male-e", n:"Eli"}];
var COLORS = [0xe74c3c, 0x3a6fd8, 0x3aa86a, 0xf2d14b, 0x8a3fd8, 0xe07b25, 0xd83aa0, 0x3ac9c9];
var CLUBS = ["club-red", "club-blue", "club-green"];
var CLIPS = ["idle", "walk", "sprint", "holding-right", "interact-right", "emote-yes", "emote-no", "sit"];
var A_IDLE = 0, A_WALK = 1, A_SPRINT = 2, A_ADDRESS = 3, A_SWING = 4, A_CHEER = 5, A_SAD = 6;
// Remote avatars are drawn from a short buffer of timed snapshots (sender clock in
// centiseconds, carried as the pos sequence number q), INTERP seconds behind plus the
// measured jitter, extrapolated briefly across gaps and snapped only on teleports.
var INTERP = 0.1, JIT_MAX = 0.2, EXTRAP = 0.2, SNAPS = 8, TELEPORT = 1.5*10000;
var POS_EVERY = 0.1, POS_KEEPALIVE = 2.0, SHOT_GAP = 0.35;
var SHOT_ERRORS = {"wait for the ball to stop":1, "that hole is over":1, "you've finished this hole":1, "bad shot":1,
  "no round is being played":1, "you're not in this round":1, "unknown game":1, "join the lobby first":1};
function css(c){ return "#"+("000000"+(c>>>0).toString(16)).slice(-6); }
function now(){ return performance.now()/1000; }
function clamp(v, a, b){ return v < a ? a : v > b ? b : v; }

/* ---------- course data (local file, same bytes as the server's copy) ---------- */
var DATA = null, DATA_P = null;
function loadData(){
  if(DATA_P) return DATA_P;
  DATA_P = fetch("/games/golf/courses.json").then(function(r){ if(!r.ok) throw new Error("courses "+r.status); return r.json(); })
    .then(function(j){ DATA = j; return j; }, function(e){ DATA_P = null; throw e; });
  return DATA_P;
}
function courseById(id){ var c = null; ((DATA && DATA.courses) || []).forEach(function(x){ if(x.id === id) c = x; }); return c; }
function coursePar(c){ return (c.holes || []).reduce(function(a, h){ return a + (h.par|0); }, 0); }
function coursePieces(c){
  var seen = {}, out = [];
  (c.holes || []).forEach(function(h){ (h.tiles || []).forEach(function(t){ if(!seen[t[0]]){ seen[t[0]] = 1; out.push(t[0]); } }); });
  return out;
}

/* ---------- three.js: imported on demand from the vendored copy ---------- */
var LIB = null, GLB = {}, GLTF = {};   // name -> loading promise / loaded glTF (shared by every hole and avatar)
function golfLib(){
  return LIB || (LIB = Promise.all([import("/games/vendor/three-module.js"), import("/games/vendor/three-gltf-loader.js"),
                                    import("/games/vendor/three-skeleton-utils.js")])
    .then(function(m){
      var THREE = m[0], manager = new THREE.LoadingManager();
      // The GLBs point at "Textures/colormap.png"; one shared copy lives next to them.
      manager.setURLModifier(function(u){ return /\/Textures\/colormap\.png$/.test(u) ? "/games/golf/colormap.png" : u; });
      return {THREE:THREE, loader:new m[1].GLTFLoader(manager), clone:m[2].clone};
    }, function(e){ LIB = null; throw e; }));
}
function loadGlb(lib, name){
  if(!/^[a-z][a-z0-9-]{0,40}$/.test(name)) return Promise.reject(new Error("bad model name"));
  return GLB[name] || (GLB[name] = new Promise(function(res, rej){
    lib.loader.load("/games/golf/"+name+".glb", function(g){ GLTF[name] = g; res(g); }, null, function(e){ delete GLB[name]; rej(e); });
  }));
}
function hasWebGL2(){
  try { var c = document.createElement("canvas"); return !!c.getContext("webgl2"); } catch(e){ return false; }
}

/* ---------- save: best totals per course + preferences (local only) ---------- */
function gsave(){
  var s = api.save; if(!s) return {best:{}};
  if(!s.golf || typeof s.golf !== "object" || Array.isArray(s.golf)) s.golf = {};
  if(!s.golf.best || typeof s.golf.best !== "object") s.golf.best = {};
  return s.golf;
}

/* =============================== the game view =============================== */
var CUR = null;          // the mounted view (one at a time)

function makeGame(host, opts){
  var V = {mode: opts.mode, ctx: opts.ctx || null, alive: true, paused: false, players: {}, order: [],
    course: null, holes: [], hole: null, holeIdx: 0, phase: "idle", state: "walk", aim: {a: -Math.PI/2, p: 40},
    keys: {}, readyAt: 0, seq: 0, pending: false, cam: {yaw: Math.PI, dist: 2.4, x: 0, y: 1.5, z: 0, tx: 0, ty: 0, tz: 0, over: false, init: false},
    view2d: !!gsave().map, spectate: 0, lastPos: 0, lastPosKey: "", warned: false, pendingHole: null, deferredView: null,
    finalCard: null, cardUntil: 0, gotView: false, unsupported: false, openSince: 0, round: null, auto: null, note: "",
    posQ: 0, shotReadyAt: 0, offline: false, stats: {n: 0, sum: 0, max: 0, slow: 0, gaps: 0, last: 0}};
  var practicePlayer = {uid: "me", name: "You"};
  function myId(){ return V.mode === "mp" && MP ? MP.me() : "me"; }
  function me(){ return V.players[myId()] || null; }

  var root = api.mk("div", "vg-golf"), menu = api.mk("div", "vg-golf-menu"), stage = api.mk("div", "vg-golf-stage hidden");
  root.appendChild(menu); root.appendChild(stage); host.appendChild(root);
  var wrap = api.mk("div", "vg-golf-view"), hud = api.mk("div", "vg-golf-hud"), hint = api.mk("p", "vg-golf-hint");
  var meter = api.mk("div", "vg-golf-power"), meterFill = api.mk("i"), cardBox = api.mk("div", "vg-golf-card hidden");
  meter.appendChild(meterFill); meter.setAttribute("aria-hidden", "true");
  hud.setAttribute("aria-live", "polite");
  cardBox.setAttribute("role", "dialog"); cardBox.setAttribute("aria-label", "Scorecard");
  var tools = api.mk("div", "vg-row vg-golf-tools");
  var load = api.mk("div", "vg-meter vg-golf-load hidden"), loadFill = api.mk("i"); load.appendChild(loadFill); load.setAttribute("aria-hidden", "true");
  var badge = api.mk("span", "vg-reconnecting vg-golf-badge hidden", "Reconnecting…"); badge.setAttribute("role", "status");
  stage.appendChild(wrap); stage.appendChild(hint); stage.appendChild(tools);
  var canvas = null, R3 = null, R2 = null, raf = 0, lastT = 0, ro = null;

  /* ---------- players ---------- */
  function ensurePlayer(uid, info){
    var P = V.players[uid];
    if(!P){
      P = V.players[uid] = {uid: uid, name: "", c: 0, color: 0, ball: [0, 0], strokes: [], done: false, fly: null, sunk: false,
        av: {x: 0, z: 0, yaw: Math.PI, anim: A_IDLE}, snaps: [], lastQ: -1, off: null, jit: 0, relA: A_IDLE, swingAt: 0, mesh: null};
      V.order.push(uid);
    }
    if(info){ for(var k in info) P[k] = info[k]; }
    return P;
  }
  function dropPlayer(uid){
    var P = V.players[uid]; if(!P) return;
    if(R3) R3.removePlayer(P);
    delete V.players[uid]; V.order = V.order.filter(function(u){ return u !== uid; });
  }
  function placeAtTee(P, i){
    var tee = V.hole.tee;
    P.ball = [tee[0], tee[1]]; P.fly = null; P.sunk = false; P.done = false;
    P.av.x = tee[0] + 2600 + (i % 4)*1700; P.av.z = tee[1] + 1500 + Math.floor(i/4)*1700; P.av.yaw = Math.PI; P.av.anim = A_IDLE; P.snaps.length = 0;
  }

  /* ---------- course + hole ---------- */
  function setCourse(id){
    var c = courseById(id); if(!c) return false;
    if(canvas && (!V.course || V.course.id !== id)){   // the 3D view loads one course's models: rebuild it
      if(R3){ R3.dispose(); R3 = null; }
      canvas.remove(); canvas = null; R2 = null;
    }
    V.course = c;
    V.holes = c.holes.map(function(h){ return GS.compileHole(h, DATA.pieces); });
    return true;
  }
  function setHole(i){
    V.holeIdx = clamp(i|0, 0, V.holes.length-1); V.hole = V.holes[V.holeIdx];
    V.order.forEach(function(uid, k){ placeAtTee(V.players[uid], k); });
    V.state = "walk"; V.pending = false; V.auto = null; V.cam.init = false;
    var cup = V.hole.cup, tee = V.hole.tee;
    V.aim.a = Math.atan2(cup[1]-tee[1], cup[0]-tee[0]);
    if(R3) R3.buildHole();
    hudUpdate();
  }

  /* ---------- screens ---------- */
  function showStage(on){ stage.classList.toggle("hidden", !on); menu.classList.toggle("hidden", on); if(on) ensureRenderer(); }
  function renderMenu(){
    if(!V.alive) return;
    menu.textContent = "";
    if(!DATA){ menu.appendChild(api.mk("p", "vg-muted", V.note || "Loading courses…")); return; }
    var sv = gsave(), mp = V.mode === "mp";
    var intro = api.mk("p", "vg-muted", mp
      ? "Everyone in the lobby plays the same course at once. Walk to your ball, aim, putt. The Arena server rolls every shot."
      : "Practice on your own. Walk to your ball with WASD, press E to address it, drag back (or use the arrows) and release.");
    menu.appendChild(intro);
    if(mp && V.unsupported){
      menu.appendChild(api.mk("p", "vg-msg", "This Arena server doesn't host Mini Golf yet. You can still practice."));
    }
    var top = api.mk("div", "vg-row");
    if(mp) top.appendChild(api.btn("Practice solo", "", function(){ V.mode = "practice"; V.round = null; renderMenu(); }));
    else if(V.ctx) top.appendChild(api.btn("Back to the lobby", "", function(){ V.mode = "mp"; resetPlayers(); requestView(); renderMenu(); }));
    var mv = api.mk("label", "vg-golf-check"), cb = api.mk("input"); cb.type = "checkbox"; cb.checked = V.view2d;
    cb.addEventListener("change", function(){ V.view2d = cb.checked; gsave().map = V.view2d; api.persist(); });
    mv.appendChild(cb); mv.appendChild(document.createTextNode(" Map view (2D)")); top.appendChild(mv);
    menu.appendChild(top);
    // character picker
    menu.appendChild(api.mk("h4", "vg-golf-h", "Your golfer"));
    var chars = api.mk("div", "vg-golf-chars"); chars.setAttribute("role", "group"); chars.setAttribute("aria-label", "Pick a golfer");
    var mine = sv.char != null ? clamp(sv.char|0, 0, 5) : 0;
    CHARS.forEach(function(ch, i){
      var b = api.btn(ch.n, "vg-golf-char"+(i === mine ? " on" : ""), function(){
        sv.char = i; api.persist(); if(mp && MP) MP.send("golf", "char", {c: i}); renderMenu();
      });
      b.setAttribute("aria-pressed", i === mine ? "true" : "false");
      chars.appendChild(b);
    });
    menu.appendChild(chars);
    // courses
    var isHost = mp && isLobbyHost();
    menu.appendChild(api.mk("h4", "vg-golf-h", mp ? (isHost ? "Pick a course to start the round" : "Courses") : "Courses"));
    var grid = api.mk("div", "vg-golf-courses");
    DATA.courses.forEach(function(c){
      var card = api.mk("button", "vg-card vg-golf-course"); card.type = "button";
      card.appendChild(api.mk("span", "vg-card-ic", c.id === "meadow" ? "🌼" : c.id === "windmill" ? "🌬️" : "🏰"));
      var t = api.mk("span", "vg-card-t"); t.appendChild(api.mk("b", null, c.name));
      var best = sv.best[c.id];
      t.appendChild(api.mk("span", null, c.holes.length+" holes · par "+coursePar(c)+(best ? " · your best "+best : "")));
      card.appendChild(t);
      if(mp && !isHost) card.disabled = true;
      card.addEventListener("click", function(){
        if(mp){ if(MP) MP.send("golf", "start", {course: c.id}); }
        else startPractice(c.id);
      });
      grid.appendChild(card);
    });
    menu.appendChild(grid);
    if(mp){
      if(!isHost) menu.appendChild(api.mk("p", "vg-muted", "Waiting for the host (★ in the lobby) to pick a course."));
      if(V.finalCard) menu.appendChild(scoreTable(V.finalCard.card, V.finalCard.par, "Last round"));
      if(V.round && V.round.phase === "playing" && !V.round.players.some(function(p){ return p.user && p.user.userId === myId(); })){
        menu.appendChild(api.btn("Watch the round", "primary", function(){ applyView(V.round, true); }));
      }
    }
  }
  function isLobbyHost(){
    var s = MP ? MP.st("golf") : null, id = myId(), h = false;
    ((s && s.lobby) || []).forEach(function(p){ if(p.userId === id && p.host) h = true; });
    return h;
  }
  function resetPlayers(){ V.order.slice().forEach(dropPlayer); V.course = null; V.hole = null; V.phase = "idle"; }

  /* ---------- practice ---------- */
  function startPractice(id){
    resetPlayers();
    if(!setCourse(id)) return;
    V.mode = "practice"; V.phase = "playing"; V.finalCard = null; V.pendingHole = null;
    var sv = gsave();
    ensurePlayer("me", {name: "You", c: sv.char != null ? clamp(sv.char|0, 0, 5) : 0, color: 1, strokes: V.holes.map(function(){ return 0; })});
    showStage(true);
    setHole(0);
    if(canvas) canvas.focus();
  }
  function practiceAfterShot(P){
    var n = V.holeIdx;
    if(!P.done) return;
    var card = {me: P.strokes.slice()};
    if(n + 1 >= V.holes.length){
      var total = P.strokes.reduce(function(a, b){ return a + b; }, 0), sv = gsave(), id = V.course.id;
      var prev = sv.best[id]; if(!prev || total < prev){ sv.best[id] = total; api.persist(); }
      V.finalCard = {card: card, par: V.holes.map(function(h){ return h.par; }), done: true};
      showCard(card, "Round complete: "+total+" strokes (par "+coursePar(V.course)+")"+(!prev || total < prev ? " · new best!" : ""), true);
      V.phase = "done";
    } else {
      showCard(card, "Hole "+(n+1)+" done", false);
      V.pendingHole = {hole: n+1, at: now() + 2.6, practice: true};
    }
  }

  /* ---------- multiplayer: server views and events ---------- */
  function requestView(){ if(MP) MP.send("golf", "view"); }
  function applyView(view, force){
    if(!V.gotView && MP){ var sv0 = gsave(); if(sv0.char != null) MP.send("golf", "char", {c: clamp(sv0.char|0, 0, 5)}); }
    V.round = view; V.gotView = true;
    if(!DATA) return;          // re-applied once the course file has loaded
    if(V.mode !== "mp" && !force){
      if(view && view.phase === "playing" && view.players.some(function(p){ return p.user && p.user.userId === myId(); })){
        V.mode = "mp"; api.toast("⛳ The round started: back to the lobby game");
      } else { renderMenu(); return; }
    }
    V.mode = "mp";
    if(!view || view.phase === "idle"){ resetPlayers(); showStage(false); renderMenu(); return; }
    if(V.pendingHole && view.hole !== V.holeIdx && view.course === (V.course && V.course.id)){ V.deferredView = view; return; }
    var fresh = !V.course || V.course.id !== view.course;
    if(fresh){ resetPlayers(); if(!setCourse(view.course)) return; }
    var keep = {};
    (view.players || []).forEach(function(p, i){
      var uid = p.user && p.user.userId; if(!uid) return;
      keep[uid] = 1;
      var P = ensurePlayer(uid), cChanged = P.c !== (p.c|0) || P.color !== (p.color|0);
      P.name = uid === myId() ? "You" : MP.nameOf(p.user); P.c = p.c|0; P.color = p.color|0;
      if(uid === myId() && V.pending && view.hole === V.holeIdx) return;   // my shot is in flight to the server: it answers with "shot"
      P.strokes = (p.strokes || []).slice(); P.done = !!p.done;
      if(cChanged && R3) R3.removePlayer(P);
    });
    V.order.slice().forEach(function(uid){ if(!keep[uid]) dropPlayer(uid); });
    V.phase = view.phase;
    V.readyAt = now() + (view.readyInMs|0)/1000;
    if(fresh || !V.hole || view.hole !== V.holeIdx) setHole(view.hole);
    (view.players || []).forEach(function(p){
      var P = V.players[p.user && p.user.userId], b = [p.ball[0]|0, p.ball[1]|0];
      if(P && P.uid === myId() && V.resync){ V.resync = false; settleMine(P, b); return; }
      if(!P || P.fly || (P.uid === myId() && V.pending)) return;
      P.ball = b;
      P.sunk = P.done && P.ball[0] === V.hole.cup[0] && P.ball[1] === V.hole.cup[1];
    });
    V.resync = false;
    var Pm = me();
    if(Pm && !Pm.fly && !V.pending){
      // never left stuck "rolling" (or "holed" on a shot the server never got)
      if(V.state === "flight" || (V.state === "done" && !Pm.done && V.phase === "playing")){ V.state = Pm.done ? "done" : "walk"; V.auto = null; }
    }
    if(V.phase === "done" && !V.finalCard) V.finalCard = {card: cardFromView(view), par: view.par, done: true};
    showStage(true);
    hudUpdate();
  }
  // After a reconnect the server's view is the truth about my ball. If my optimistic
  // roll ends where the server says, let it finish; otherwise ease the ball there.
  function settleMine(P, b){
    var f = P.fly, land = f ? (f.oob ? f.from : f.end) : P.ball;
    P.sunk = P.done && b[0] === V.hole.cup[0] && b[1] === V.hole.cup[1];
    if(f && land[0] === b[0] && land[1] === b[1]) return;          // finishFlight sets the state
    if(f || P.ball[0] !== b[0] || P.ball[1] !== b[1]){
      var at = ballAt(P, now());
      P.fly = null; P.lastFly = null; P.ball = b.slice();
      if(!api.calm()) startFlight(P, {from: b.slice(), path: [b.slice()], end: b.slice(), holed: false, oob: false, mine: true,
                                       quiet: true, blend: {x: at[0], z: at[1], t0: now(), dur: 0.2}});
    }
    if(V.state !== "address" || P.done){ V.state = P.done ? "done" : "walk"; V.auto = null; }
  }
  function cardFromView(view){ var c = {}; (view.players || []).forEach(function(p){ c[p.user.userId] = p.strokes; }); return c; }
  function onEvent(m){
    if(!V.alive) return;
    if(m.ev === "golf"){
      if(m.back && m.back !== myId() && V.players[m.back]){ V.players[m.back].lastQ = -1; }
      applyView(m.round || null); if(m.by && m.round && m.round.phase === "playing" && m.by.userId !== myId()) api.toast("⛳ "+MP.nameOf(m.by)+" started "+((courseById(m.round.course)||{}).name||"a round")); return; }
    if(m.ev === "lobby"){ if(V.mode === "mp" && !menu.classList.contains("hidden")) renderMenu(); hudUpdate(); return; }
    if(V.mode !== "mp") return;
    if(m.ev === "shot") return onShot(m);
    if(m.ev === "pos"){ var P = V.players[m.u]; if(P && m.u !== myId()) pushSnap(P, m); return; }
    if(m.ev === "char"){ var Q = V.players[m.user]; if(Q && Q.c !== (m.c|0)){ Q.c = m.c|0; if(R3) R3.removePlayer(Q); } return; }
    if(m.ev === "hole"){ V.pendingHole = {hole: m.hole|0, at: now() + (m.delayMs|0)/1000, card: m.card, shown: false}; return; }
    if(m.ev === "done"){
      V.finalCard = {card: m.card || {}, par: m.par || [], done: true, winners: m.winners || [], shown: false};
      var wins = (m.winners || []).indexOf(myId()) >= 0 && !!V.players[myId()];
      if(wins){ api.inv.add("gold", 1); }
      return;
    }
  }
  function onShot(m){
    var uid = m.user && m.user.userId, P = V.players[uid];
    if(!P || !V.hole) return;
    var mine = uid === myId(), hole = m.hole|0;
    var from = [m.from[0]|0, m.from[1]|0], end = [m.end[0]|0, m.end[1]|0];
    if(mine && V.pending && (m.seq|0) === V.seq){
      // The server's answer to my own (already rolling) shot: normally identical.
      V.pending = false;
      P.strokes[hole] = m.strokes|0; P.done = !!m.done;
      var f = P.fly || P.lastFly;
      if(hole === V.holeIdx && f && (f.end[0] !== end[0] || f.end[1] !== end[1] || f.holed !== !!m.holed || f.oob !== !!m.oob)){
        warnOnce();
        var res = GS.simulate(V.hole, from[0], from[1], m.ax|0, m.az|0, m.power|0, true);
        if(res.end[0] !== end[0] || res.end[1] !== end[1]) res.path.push(end);
        var t = now(), at = ballAt(P, t), skip = Math.min(Math.floor((t - f.t0)*GS.C.TICK), res.path.length - 1);
        P.fly = null;
        // ease from where the ball is drawn now onto the server's roll (same moment of it) over 150 ms
        startFlight(P, {from: from, path: res.path, end: end, holed: !!m.holed, oob: !!m.oob, mine: true, noSwing: true,
                        blend: {x: at[0], z: at[1], t0: t, dur: 0.15}}, skip);
        if(!P.done) V.state = "flight";
      }
      hudUpdate();
      return;
    }
    P.strokes[hole] = m.strokes|0; P.done = !!m.done;
    if(hole !== V.holeIdx || mine){ hudUpdate(); return; }     // mine without a pending seq: another tab of mine; the view resyncs
    // Remote shots replay exactly; never overlap two flights of the same ball.
    if(P.fly) finishFlight(P);
    var r = GS.simulate(V.hole, from[0], from[1], m.ax|0, m.az|0, m.power|0, true);
    if(r.end[0] !== end[0] || r.end[1] !== end[1] || r.holed !== !!m.holed){ warnOnce(); r.path.push(end); }
    startFlight(P, {from: from, path: r.path, end: end, holed: !!m.holed, oob: !!m.oob});
    hudUpdate();
  }
  function warnOnce(){ if(!V.warned){ V.warned = true; if(window.console) console.warn("golf: replay differs from the server; using the server's result"); } }
  function onError(m){
    var e = String(m.error || "");
    if(e === "unknown game"){ V.unsupported = true; if(V.mode === "mp") renderMenu(); }
    if(V.pending && SHOT_ERRORS[e]) rewindShot();
  }
  // The server refused my optimistic shot: put the ball back where it was and let me retry.
  function rewindShot(){
    var P = me(); V.pending = false;
    if(!P || !V.shotUndo) return;
    var u = V.shotUndo; V.shotUndo = null;
    var at = ballAt(P, now());
    P.fly = null; P.lastFly = null; P.strokes[u.hole] = u.strokes; P.done = u.done; P.sunk = false;
    if(u.hole === V.holeIdx){
      P.ball = u.ball.slice();
      if(!api.calm()) startFlight(P, {from: u.ball.slice(), path: [u.ball.slice()], end: u.ball.slice(), holed: false, oob: false, mine: true,
                                       quiet: true, blend: {x: at[0], z: at[1], t0: now(), dur: 0.2}});
      V.state = "address";
    }
    hudUpdate();
  }

  /* ---------- shots ---------- */
  function startFlight(P, d, skipTicks){
    d.t0 = now() - (skipTicks || 0)/GS.C.TICK; P.fly = d; P.sunk = false;
    if(!d.quiet && !d.noSwing){ P.swingAt = d.t0; if(P.uid === myId()) P.av.anim = A_SWING; }
  }
  function finishFlight(P){
    var f = P.fly; P.fly = null; P.lastFly = f;
    P.ball = f.oob ? f.from : f.end;
    if(f.holed) P.sunk = true;
    if(f.quiet){ return; }
    var mine = P.uid === myId();
    if(mine){
      P.av.anim = f.holed ? A_CHEER : f.oob ? A_SAD : A_IDLE;
      P.cheerUntil = now() + 1.6;
      V.shotReadyAt = now() + SHOT_GAP;
      V.state = P.done || f.holed ? "done" : "walk";
      var n = P.strokes[V.holeIdx]|0, par = V.hole.par;
      var msg = f.holed ? (n === 1 ? "Hole in one!" : "In the hole: "+n+" stroke"+(n === 1 ? "" : "s")+(n < par ? " (under par!)" : n === par ? " (par)" : ""))
        : f.oob ? "Out of bounds: +1, back to your last lie" : P.done ? "Picked up at "+GS.C.MAX_STROKES+" strokes" : "";
      if(msg){ api.toast((f.holed ? "⛳ " : "")+msg); say(msg); }
      if(V.mode === "practice") practiceAfterShot(P);
    }
    hudUpdate();
  }
  function say(t){ if(typeof window.announce === "function"){ try { window.announce(t); } catch(e){} } }
  function shoot(){
    var P = me(); if(!P || V.state !== "address" || P.fly || P.done) return;
    if(V.mode === "mp" && now() < V.readyAt) { api.toast("Wait for the next hole to open"); return; }
    if(V.mode === "mp" && (V.pending || now() < V.shotReadyAt)) return;
    if(V.mode === "mp" && V.offline){ api.toast("Reconnecting to the Arena…"); return; }
    var ax = Math.round(Math.cos(V.aim.a)*4096), az = Math.round(Math.sin(V.aim.a)*4096), power = clamp(Math.round(V.aim.p), 1, 100);
    if(!ax && !az) ax = 1;
    var n = V.holeIdx;
    if(V.mode === "mp"){
      // Optimistic: every client runs the server's exact integer roll, so the ball starts
      // moving now; the server's "shot" answer (same seq) only confirms it.
      V.seq++;
      if(!MP || !MP.send("golf", "shot", {ax: ax, az: az, power: power, seq: V.seq, hole: n})){ api.toast("Not connected to the Arena"); return; }
      V.pending = true; V.pendingAt = now();
      V.shotUndo = {hole: n, ball: P.ball.slice(), strokes: P.strokes[n]|0, done: P.done};
    }
    var res = GS.simulate(V.hole, P.ball[0], P.ball[1], ax, az, power, true);
    P.strokes[n] = (P.strokes[n]|0) + 1 + (res.oob ? GS.C.OOB_PENALTY : 0);
    if(res.holed) P.done = true;
    else if(P.strokes[n] >= GS.C.MAX_STROKES){ P.strokes[n] = GS.C.MAX_STROKES; P.done = true; }
    startFlight(P, {from: [P.ball[0], P.ball[1]], path: res.path, end: res.end, holed: res.holed, oob: res.oob, mine: true});
    V.state = "flight";
    hudUpdate();
  }
  function concede(){
    var P = me(); if(!P || P.done || P.fly) return;
    if(V.mode === "mp"){ MP.send("golf", "concede"); return; }
    P.strokes[V.holeIdx] = GS.C.MAX_STROKES; P.done = true; V.state = "done"; practiceAfterShot(P); hudUpdate();
  }
  function tryAddress(){
    var P = me(); if(!P || P.done || P.fly || V.phase !== "playing") return;
    var dx = (P.ball[0] - P.av.x)/T, dz = (P.ball[1] - P.av.z)/T;
    if(dx*dx + dz*dz > 0.36){ V.auto = {x: P.ball[0], z: P.ball[1]}; return; }
    V.auto = null; V.state = "address";
    hudUpdate();
  }

  /* ---------- per-frame update ---------- */
  function update(dt, t){
    var P = me(), calm = api.calm();
    // my walking
    if(P && !P.done && V.phase === "playing" && (V.state === "walk" || V.state === "done")){
      var k = V.keys, f = 0, s = 0;
      if(k.w || k.arrowup) f += 1; if(k.s || k.arrowdown) f -= 1;
      if(k.d || k.arrowright) s += 1; if(k.a || k.arrowleft) s -= 1;
      var sprint = !!k.shift, sp = (sprint ? 3.0 : 1.6)*T*dt, mx = 0, mz = 0;
      if(f || s){
        V.auto = null;
        var fy = Math.sin(V.cam.yaw), fz = Math.cos(V.cam.yaw), rx = -Math.cos(V.cam.yaw), rz = Math.sin(V.cam.yaw);
        mx = fy*f + rx*s; mz = fz*f + rz*s;
      } else if(V.auto){
        mx = V.auto.x - P.av.x; mz = V.auto.z - P.av.z;
        var dd = Math.sqrt(mx*mx + mz*mz);
        if(dd < 0.45*T){ V.auto = null; mx = mz = 0; V.state = "walk"; tryAddress(); }
      }
      var len = Math.sqrt(mx*mx + mz*mz);
      if(len > 0){
        mx /= len; mz /= len;
        var bb = V.hole.bbox;
        P.av.x = clamp(P.av.x + mx*sp, bb[0] - 2*T, bb[2] + 2*T); P.av.z = clamp(P.av.z + mz*sp, bb[1] - 2*T, bb[3] + 2*T);
        P.av.yaw = Math.atan2(mx, mz); P.av.anim = sprint ? A_SPRINT : A_WALK;
      } else if(P.av.anim === A_WALK || P.av.anim === A_SPRINT || ((P.av.anim === A_CHEER || P.av.anim === A_SAD) && t > (P.cheerUntil || 0))) P.av.anim = A_IDLE;
    }
    if(P && V.state === "address"){
      var side = 0.16*T, ca = Math.cos(V.aim.a), sa = Math.sin(V.aim.a);
      // stand beside the ball, a little behind it, facing along the aim
      P.av.x = P.ball[0] + sa*side - ca*0.04*T; P.av.z = P.ball[1] - ca*side - sa*0.04*T;
      P.av.yaw = Math.atan2(ca, sa); P.av.anim = A_ADDRESS;
    }
    // flights + remote avatars
    V.order.forEach(function(uid){
      var Q = V.players[uid];
      if(Q.fly && (t - Q.fly.t0)*GS.C.TICK >= Q.fly.path.length - 1 && (!Q.fly.blend || t - Q.fly.blend.t0 >= Q.fly.blend.dur)) finishFlight(Q);
      if(Q.uid !== myId() && Q.snaps.length) sampleSnaps(Q, t, dt, calm);
    });
    if(P && P.av.anim === A_SWING && !P.fly && V.state !== "wait" && t - P.swingAt > 0.8) P.av.anim = A_IDLE;
    // a roll that ended without finishFlight (a quiet blend, a reset) never leaves me unable to walk
    if(P && V.state === "flight" && !P.fly && !V.pending){ V.state = P.done ? "done" : "walk"; hudUpdate(); }
    // hole transitions (practice timer or the server's cut-scene)
    var flying = V.order.some(function(u){ return V.players[u].fly; });
    if(V.pendingHole && !flying){
      var ph = V.pendingHole;
      if(!ph.practice && !ph.shown){ ph.shown = true; showCard(ph.card || {}, "Hole "+(V.holeIdx+1)+" scorecard", false); }
      if(t >= ph.at){
        V.pendingHole = null; hideCard();
        if(ph.practice) setHole(ph.hole);
        else if(V.deferredView){ var dv = V.deferredView; V.deferredView = null; applyView(dv); }
      }
    }
    if(V.finalCard && V.finalCard.shown === false && !flying){
      V.finalCard.shown = true;
      var w = (V.finalCard.winners || []).map(function(u){ var Q = V.players[u]; return Q ? Q.name : "?"; });
      showCard(V.finalCard.card, w.length ? "🏆 "+w.join(" & ")+(w.length > 1 ? " tie" : " win"+(w[0] === "You" ? "" : "s")) : "Round over", true);
      if((V.finalCard.winners || []).indexOf(myId()) >= 0) api.toast("🏆 You won the round! +1 Gold Ore");
    }
    // position relay: 10/s while something changes, one "rest" frame when it stops (the
    // key differs), a keepalive every 2 s. q is my clock in centiseconds: a sequence
    // number that also lets the others place each frame on a jitter-free timeline.
    // (not while offline: a new socket that hasn't re-joined the lobby yet would only earn errors)
    if(V.mode === "mp" && P && MP && !V.offline && V.phase === "playing" && t - V.lastPos >= POS_EVERY){
      var r = ((Math.round(P.av.yaw*180/Math.PI) % 360) + 360) % 360, x = Math.round(P.av.x), z = Math.round(P.av.z);
      var key = x+","+z+","+r+","+P.av.anim;
      if(key !== V.lastPosKey || t - V.lastPos >= POS_KEEPALIVE){
        V.posQ = Math.max(V.posQ + 1, Math.floor(Date.now()/10) % 1073741824);
        if(MP.send("golf", "pos", {x: x, z: z, r: r, a: P.av.anim|0, q: V.posQ})){ V.lastPos = t; V.lastPosKey = key; }
      }
    }
    // no answer to my shot for far longer than the roll takes: ask the server where things stand
    if(V.pending && V.pendingAt && t - V.pendingAt > 8 + GS.C.MAX_TICKS/GS.C.TICK){ V.pending = false; V.shotUndo = null; requestView(); }
    if(V.mode === "mp" && MP && !V.gotView){
      if(MP.sockOpen()){ if(!V.openSince) V.openSince = t; else if(t - V.openSince > 3 && !V.unsupported){ V.unsupported = true; renderMenu(); } }
    }
    meterFill.style.width = Math.round(V.aim.p)+"%";
    meter.classList.toggle("hidden", V.state !== "address");
  }
  /* ---------- remote avatars: snapshot interpolation ---------- */
  function pushSnap(P, m){
    var q = m.q, t = now();
    if(typeof q === "number" && isFinite(q)){
      q = q|0;
      // stale or out of order (but accept a wrapped or restarted clock)
      if(P.lastQ >= 0 && q <= P.lastQ && P.lastQ - q < 536870912 && P.lastQ - q < 6000) return;
      if(P.lastQ >= 0 && q <= P.lastQ) P.off = null;           // the sender restarted: re-learn its clock
      P.lastQ = q;
      // Map the sender's clock onto mine. The offset tracks the fastest delivery seen
      // (jitter only ever adds delay) and drifts up slowly so a changed route is learnt.
      var off = t - q/100;
      if(P.off === null || off < P.off) P.off = off; else P.off += (off - P.off)*0.01;
      var st = q/100 + P.off, late = t - st;
      late = Math.min(Math.max(late, 0), JIT_MAX);
      P.jit += (late - P.jit)*(late > P.jit ? 0.3 : 0.02);   // follows the late tail, forgets it slowly
      t = st;
    }
    var x = +m.x || 0, z = +m.z || 0, sn = P.snaps, last = sn[sn.length - 1];
    if(last && t <= last.t) t = last.t + 0.001;
    var tp = last && (Math.abs(x - last.x) > TELEPORT || Math.abs(z - last.z) > TELEPORT);
    if(tp) sn.length = 0;
    sn.push({t: t, x: x, z: z, yaw: (+m.r || 0)*Math.PI/180, a: clamp(m.a|0, 0, 7)});
    if(sn.length > SNAPS) sn.shift();
    if(tp || sn.length === 1){ P.av.x = x; P.av.z = z; P.av.yaw = sn[sn.length - 1].yaw; }
  }
  function angLerp(a, b, u){ return a + Math.atan2(Math.sin(b - a), Math.cos(b - a))*u; }
  function sampleSnaps(P, t, dt, calm){
    var sn = P.snaps, rt = t - INTERP - P.jit, n = sn.length, x, z, yaw, a, sp = 0;
    if(rt <= sn[0].t){ x = sn[0].x; z = sn[0].z; yaw = sn[0].yaw; a = sn[0].a; }
    else if(rt >= sn[n-1].t){
      // past the newest frame: keep going at the last velocity for a moment, then hold
      var L = sn[n-1], K = n > 1 ? sn[n-2] : L, span = L.t - K.t, ex = Math.min(rt - L.t, EXTRAP);
      var moving = L.a === A_WALK || L.a === A_SPRINT;
      var vx = span > 0 && moving ? (L.x - K.x)/span : 0, vz = span > 0 && moving ? (L.z - K.z)/span : 0;
      x = L.x + vx*ex; z = L.z + vz*ex; yaw = L.yaw; a = L.a; sp = Math.sqrt(vx*vx + vz*vz);
    } else {
      for(var i = n - 1; i > 0 && sn[i-1].t > rt; i--){}
      var A = sn[i-1], B = sn[i], u = (rt - A.t)/(B.t - A.t || 1);
      x = A.x + (B.x - A.x)*u; z = A.z + (B.z - A.z)*u; yaw = angLerp(A.yaw, B.yaw, u); a = u < 0.5 ? A.a : B.a;
      var ddx = B.x - A.x, ddz = B.z - A.z; sp = Math.sqrt(ddx*ddx + ddz*ddz)/((B.t - A.t) || 1);
    }
    // a light 40 ms smoothing hides the rare correction after an extrapolation
    var k = calm ? 1 : 1 - Math.exp(-25*dt), ex2 = x - P.av.x, ez2 = z - P.av.z;
    if(Math.abs(ex2) > TELEPORT || Math.abs(ez2) > TELEPORT) k = 1;
    P.av.x += ex2*k; P.av.z += ez2*k; P.av.yaw = angLerp(P.av.yaw, yaw, calm ? 1 : Math.min(1, k*1.5));
    // the walk cycle follows the speed actually shown, not only the relayed id
    if(a === A_IDLE || a === A_WALK || a === A_SPRINT) a = sp > 2.2*T ? A_SPRINT : sp > 0.25*T ? A_WALK : A_IDLE;
    if(a !== P.av.anim && (a === A_SWING)) P.swingAt = t;
    P.av.anim = a;
  }
  // where a player's ball is drawn right now (units, with the flight interpolated)
  function ballAt(P, t){
    if(!P.fly) return P.ball;
    var f = P.fly, k = Math.max(0, (t - f.t0)*GS.C.TICK), i = Math.floor(k), a = f.path[Math.min(i, f.path.length-1)], b = f.path[Math.min(i+1, f.path.length-1)], u = k - i;
    var x = a[0] + (b[0]-a[0])*u, z = a[1] + (b[1]-a[1])*u;
    if(f.blend){
      var w = (t - f.blend.t0)/f.blend.dur;
      if(w < 1){ w = w*w*(3 - 2*w); x = f.blend.x + (x - f.blend.x)*w; z = f.blend.z + (z - f.blend.z)*w; }
    }
    return [x, z];
  }
  function focusPlayer(){
    var P = me();
    if(P) return P;
    var ids = V.order; if(!ids.length) return null;
    return V.players[ids[((V.spectate % ids.length) + ids.length) % ids.length]];
  }

  /* ---------- HUD + scorecard ---------- */
  function hudUpdate(){
    if(!V.hole){ hud.textContent = ""; hint.textContent = ""; return; }
    hud.textContent = "";
    var P = me(), n = V.holeIdx;
    hud.appendChild(api.mk("b", null, V.course.name+" · Hole "+(n+1)+"/"+V.holes.length+" · Par "+V.hole.par));
    hud.appendChild(api.mk("span", null, V.hole.name));
    var list = api.mk("div", "vg-golf-hud-players");
    V.order.forEach(function(uid){
      var Q = V.players[uid], row = api.mk("span", "vg-golf-hud-p"+(uid === myId() ? " me" : ""));
      var sw = api.mk("i", "vg-golf-sw"); sw.style.background = css(COLORS[Q.color % COLORS.length]); row.appendChild(sw);
      row.appendChild(document.createTextNode(Q.name+": "+(Q.strokes[n]|0)+(Q.done ? " ✓" : Q.fly ? " …" : "")));
      list.appendChild(row);
    });
    hud.appendChild(list);
    var msg;
    if(V.phase === "done") msg = "Round over.";
    else if(!P) msg = "Spectating. V cycles players, C toggles the overview.";
    else if(P.done) msg = "You're done with this hole. Waiting for the others…";
    else if(V.state === "address") msg = "Aim with ←/→ (Shift = fine), power ↑/↓ ("+Math.round(V.aim.p)+"), Space to putt. Or drag back and release. Esc cancels.";
    else if(V.state === "wait") msg = "Putting…";
    else if(V.state === "flight") msg = "Rolling…";
    else msg = "Walk with WASD (Shift sprints, Q/R turn the camera). Press E at your ball, or click it, to address.";
    hint.textContent = msg;
    tools.textContent = "";
    if(P && !P.done && V.phase === "playing") tools.appendChild(api.btn("Pick up", "ghost", concede));
    tools.appendChild(api.btn(V.view2d || !R3 ? "3D view" : "Map view", "", function(){ V.view2d = !V.view2d; gsave().map = V.view2d; api.persist(); swapRenderer(); }));
    if(V.mode === "mp" && isLobbyHost() && V.phase === "playing"){
      tools.appendChild(api.btn("Skip hole", "ghost", function(){ MP.send("golf", "skip"); }));
      tools.appendChild(api.btn("End round", "ghost", function(){ MP.send("golf", "end"); }));
    }
    if(V.mode === "practice" || V.phase === "done") tools.appendChild(api.btn(V.mode === "practice" ? "Courses" : "Back to the lobby", "", function(){
      hideCard();
      if(V.mode === "practice"){ resetPlayers(); showStage(false); renderMenu(); }
      else { showStage(false); renderMenu(); }
    }));
  }
  function scoreTable(card, par, title){
    var box = api.mk("div", "vg-golf-score");
    if(title) box.appendChild(api.mk("b", null, title));
    var tbl = api.mk("table", "vg-golf-table"), head = api.mk("tr");
    head.appendChild(api.mk("th", null, "Hole"));
    (par || []).forEach(function(_, i){ head.appendChild(api.mk("th", null, String(i+1))); });
    head.appendChild(api.mk("th", null, "Total")); tbl.appendChild(head);
    var pr = api.mk("tr", "par"); pr.appendChild(api.mk("td", null, "Par"));
    (par || []).forEach(function(p){ pr.appendChild(api.mk("td", null, String(p))); });
    pr.appendChild(api.mk("td", null, String((par || []).reduce(function(a, b){ return a + b; }, 0)))); tbl.appendChild(pr);
    Object.keys(card || {}).forEach(function(uid){
      var Q = V.players[uid], tr = api.mk("tr"), tot = 0;
      tr.appendChild(api.mk("td", null, Q ? Q.name : (uid === myId() ? "You" : "Left")));
      (par || []).forEach(function(p, i){
        var v = (card[uid] || [])[i]|0; tot += v;
        tr.appendChild(api.mk("td", v ? (v < p ? "under" : v > p ? "over" : "even") : null, v ? String(v) : "–"));
      });
      tr.appendChild(api.mk("td", "tot", String(tot))); tbl.appendChild(tr);
    });
    box.appendChild(tbl);
    return box;
  }
  function showCard(card, title, final){
    cardBox.textContent = ""; cardBox.classList.remove("hidden");
    cardBox.appendChild(scoreTable(card, V.holes.map(function(h){ return h.par; }), title));
    if(final){
      var row = api.mk("div", "vg-row");
      row.appendChild(api.btn(V.mode === "practice" ? "Play again" : "Close", "primary", function(){
        hideCard(); if(V.mode === "practice") startPractice(V.course.id);
      }));
      cardBox.appendChild(row);
    }
  }
  function hideCard(){ cardBox.classList.add("hidden"); cardBox.textContent = ""; }

  /* ---------- renderers ---------- */
  function ensureRenderer(){
    if(canvas) return;
    wrap.textContent = "";
    wrap.appendChild(hud); wrap.appendChild(meter); wrap.appendChild(cardBox); wrap.appendChild(badge); wrap.appendChild(load);
    var want3d = !V.view2d && hasWebGL2();
    canvas = api.mk("canvas", "vg-golf-canvas"); canvas.tabIndex = 0;
    canvas.setAttribute("aria-label", "Mini golf course. WASD walks, E addresses the ball, arrows aim and set power, Space putts.");
    wrap.insertBefore(canvas, wrap.firstChild);
    bindInput(canvas);
    resize();
    if(want3d){
      R2 = null;
      make3d(canvas).then(function(r){
        if(!V.alive){ r.dispose(); return; }
        R3 = r; R3.buildHole(); hudUpdate();
      }, function(e){
        if(!V.alive) return;
        V.note = "3D unavailable: showing the map view."; api.toast(V.note);
        fallback2d();
      });
      R2 = make2d(null);     // placeholder while loading: draws "Loading…"
    } else {
      if(!V.view2d) V.note = "3D unavailable: showing the map view.";
      R2 = make2d(canvas);
    }
    if(!raf) raf = requestAnimationFrame(frame);
  }
  function fallback2d(){
    if(R3){ R3.dispose(); R3 = null; }
    if(canvas){ canvas.remove(); canvas = null; }
    var v = V.view2d; V.view2d = true; ensureRenderer(); V.view2d = v;
    hudUpdate();
  }
  function swapRenderer(){
    if(R3){ R3.dispose(); R3 = null; }
    if(canvas){ canvas.remove(); canvas = null; }
    R2 = null;
    ensureRenderer(); hudUpdate();
    if(canvas) canvas.focus();
  }
  function resize(){
    if(!canvas) return;
    var w = Math.max(280, wrap.clientWidth || host.clientWidth || 640), h = Math.round(Math.min(w*0.62, (window.innerHeight || 800)*0.68));
    canvas.style.height = h+"px";
    if(R3) R3.size(w, h);
    else if(R2){ var dpr = Math.min(window.devicePixelRatio || 1, 2); canvas.width = Math.round(w*dpr); canvas.height = Math.round(h*dpr); }
  }

  function frame(ts){
    raf = 0;
    if(!V.alive) return;
    raf = requestAnimationFrame(frame);     // first, so one bad frame can never stop the loop
    var t = ts/1000, gap = lastT ? t - lastT : 0, dt = lastT ? Math.min(0.05, gap) : 0.016; lastT = t;
    var paused = V.paused || (V.ctx && V.ctx.paused) || document.hidden;
    if(!paused && V.hole && !stage.classList.contains("hidden")){
      var w0 = performance.now(), tn = now();
      update(dt, tn);
      if(R3) R3.render(dt, tn);
      else if(R2 && R2.canvas) R2.draw(tn);
      // frame-time stats (work per frame; frame gaps over 25 ms) for the smoke test
      var st = V.stats, ms = performance.now() - w0;
      if(!st.n) st.t0 = performance.now();
      st.n++; st.sum += ms; if(ms > st.max) st.max = ms; if(ms > 8) st.slow++; if(gap > 0.025 && gap < 1) st.gaps++;
    }
  }

  /* ----- 2D map view: same data and simulation, drawn top-down ----- */
  function make2d(cv){
    var r = {canvas: cv, fit: null};
    r.toWorld = function(px, py){ var f = r.fit; return f ? [(px - f.ox)/f.s, (py - f.oy)/f.s] : [0, 0]; };
    r.draw = function(t){
      var g = cv.getContext("2d"), W = cv.width, H = cv.height, h = V.hole, bb = h.bbox;
      var pad = T*0.8, bw = bb[2]-bb[0] + 2*pad, bh = bb[3]-bb[1] + 2*pad, s = Math.min(W/bw, H/bh);
      r.fit = {s: s, ox: (W - (bb[2]+bb[0])*s)/2, oy: (H - (bb[3]+bb[1])*s)/2};
      var f = r.fit;
      function X(x){ return f.ox + x*s; } function Y(z){ return f.oy + z*s; }
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.fillStyle = "#6fb35a"; g.fillRect(0, 0, W, H);
      h.tiles.forEach(function(tl){ g.fillStyle = "#4fae55"; g.fillRect(X(tl[1]*T - T/2), Y(tl[2]*T - T/2), T*s+0.5, T*s+0.5); });
      g.fillStyle = "#2c3b2c";
      h.voids.forEach(function(v){ g.fillRect(X(v[0]), Y(v[1]), (v[2]-v[0])*s, (v[3]-v[1])*s); });
      g.strokeStyle = "#d9825b"; g.lineWidth = Math.max(2, 600*s); g.lineCap = "round";
      g.beginPath(); h.segs.forEach(function(sg){ g.moveTo(X(sg[0]), Y(sg[1])); g.lineTo(X(sg[0]+sg[2]), Y(sg[1]+sg[3])); }); g.stroke();
      g.fillStyle = "#1d2a1d"; g.beginPath(); g.arc(X(h.cup[0]), Y(h.cup[1]), Math.max(3, GS.C.CUP*s), 0, 7); g.fill();
      g.fillStyle = "#e74c3c"; g.fillRect(X(h.cup[0]), Y(h.cup[1]) - 18*Math.max(1, s*1200), Math.max(6, 900*s), Math.max(4, 600*s));
      g.fillStyle = "#f5f5f5"; g.fillRect(X(h.tee[0]) - 3, Y(h.tee[1]) - 1, 6, 2);
      V.order.forEach(function(uid){
        var P = V.players[uid], col = css(COLORS[P.color % COLORS.length]);
        if(!(P.sunk && !P.fly)){
          var b = ballAt(P, t); g.fillStyle = col; g.strokeStyle = "#ffffff"; g.lineWidth = 2;
          g.beginPath(); g.arc(X(b[0]), Y(b[1]), Math.max(4, GS.C.R*1.3*s), 0, 7); g.fill(); g.stroke();
        }
        var ax = X(P.av.x), az = Y(P.av.z), rad = Math.max(6, 1100*s);
        g.globalAlpha = 0.9; g.fillStyle = col; g.beginPath(); g.arc(ax, az, rad, 0, 7); g.fill(); g.globalAlpha = 1;
        g.strokeStyle = "#1d2a1d"; g.lineWidth = 2; g.beginPath(); g.moveTo(ax, az); g.lineTo(ax + Math.sin(P.av.yaw)*rad*1.6, az + Math.cos(P.av.yaw)*rad*1.6); g.stroke();
        g.fillStyle = "#ffffff"; g.font = "bold "+Math.max(10, Math.round(12*(window.devicePixelRatio || 1)))+"px sans-serif"; g.textAlign = "center";
        g.fillText(P.name.slice(0, 14), ax, az - rad - 4);
      });
      var P = me();
      if(P && V.state === "address"){
        var L = (0.2 + V.aim.p/100*1.6)*T;
        g.strokeStyle = "#ffffff"; g.setLineDash([6, 5]); g.lineWidth = 2; g.beginPath();
        g.moveTo(X(P.ball[0]), Y(P.ball[1])); g.lineTo(X(P.ball[0] + Math.cos(V.aim.a)*L), Y(P.ball[1] + Math.sin(V.aim.a)*L)); g.stroke(); g.setLineDash([]);
      }
      if(V.note){ g.fillStyle = "rgba(0,0,0,.45)"; g.fillRect(0, H - 26, W, 26); g.fillStyle = "#ffffff"; g.textAlign = "left"; g.font = Math.round(12*(window.devicePixelRatio || 1))+"px sans-serif"; g.fillText(V.note, 8, H - 9); }
    };
    return r;
  }

  /* ----- 3D view ----- */
  function make3d(cv){
    return Promise.all([golfLib(), loadData()]).then(function(res){
      var lib = res[0], THREE = lib.THREE;
      var names = coursePieces(V.course).concat(["flag-red"], CHARS.map(function(c){ return c.f; }), CLUBS);
      var got = 0;
      V.note = "Loading 0/"+names.length; load.classList.remove("hidden"); loadFill.style.width = "4%";
      return Promise.all(names.map(function(n){ return loadGlb(lib, n).then(function(g){
          got++; V.note = "Loading "+got+"/"+names.length; hint.textContent = V.note; loadFill.style.width = Math.round(got/names.length*100)+"%"; return g; }); }))
        .then(function(){ V.note = ""; load.classList.add("hidden"); return build3d(lib, THREE, cv); },
              function(e){ load.classList.add("hidden"); throw e; });
    });
  }
  function build3d(lib, THREE, cv){
    var renderer = new THREE.WebGLRenderer({canvas: cv, antialias: true});
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    var scene = new THREE.Scene(); scene.background = new THREE.Color(0x9fd3f0);
    var camera = new THREE.PerspectiveCamera(55, 1.6, 0.03, 200);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x4b5b45, 2.2));
    var sun = new THREE.DirectionalLight(0xffffff, 1.6); sun.position.set(3, 8, 4); scene.add(sun);
    var groundGeo = new THREE.PlaneGeometry(400, 400); groundGeo.rotateX(-Math.PI/2);
    var ground = new THREE.Mesh(groundGeo, new THREE.MeshLambertMaterial({color: 0x6fb35a})); ground.position.y = -0.002; scene.add(ground);
    var holeGroup = null, blades = [], ballGeo = new THREE.SphereGeometry(BALL_R, 16, 12);
    var blobGeo = new THREE.CircleGeometry(1, 20); blobGeo.rotateX(-Math.PI/2);
    var blobMat = new THREE.MeshBasicMaterial({color: 0x000000, transparent: true, opacity: 0.22, depthWrite: false});
    var arrow = new THREE.ArrowHelper(new THREE.Vector3(0, 0, -1), new THREE.Vector3(), 0.5, 0xffffff, 0.08, 0.05); arrow.visible = false; scene.add(arrow);
    var raycaster = new THREE.Raycaster(), plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -FLOOR_Y), hit = new THREE.Vector3();
    var lost = function(e){ e.preventDefault(); if(V.alive){ V.note = "3D unavailable: showing the map view."; setTimeout(fallback2d, 0); } };
    cv.addEventListener("webglcontextlost", lost);
    function scene3(name){ return GLTF[name] || null; }
    var r = {};
    r.size = function(w, h){ renderer.setSize(w, h, false); camera.aspect = w/h; camera.updateProjectionMatrix(); };
    r.buildHole = function(){
      if(holeGroup){ scene.remove(holeGroup); }
      holeGroup = new THREE.Group(); blades = [];
      V.hole.tiles.forEach(function(tl){
        var g = scene3(tl[0]); if(!g) return;
        var o = g.scene.clone(); o.position.set(tl[1], 0, tl[2]); o.rotation.y = (tl[3]|0)*Math.PI/2; holeGroup.add(o);
        var b = o.getObjectByName("blades"); if(b) blades.push(b);
      });
      var fg = scene3("flag-red");
      if(fg){ var flag = fg.scene.clone(); flag.scale.setScalar(0.45); flag.position.set(V.hole.cup[0]/T, FLOOR_Y - 0.03, V.hole.cup[1]/T); holeGroup.add(flag); r.flag = flag; }
      scene.add(holeGroup);
      V.order.forEach(function(uid){ r.removePlayer(V.players[uid]); });
      r.size(Math.max(280, wrap.clientWidth || 640), parseInt(cv.style.height, 10) || 400);
    };
    function makeAvatar(P){
      var g = scene3(CHARS[P.c % CHARS.length].f); if(!g) return null;
      var obj = lib.clone(g.scene); obj.scale.setScalar(0.5);
      var mixer = new THREE.AnimationMixer(obj), actions = {};
      CLIPS.forEach(function(n, i){
        var clip = THREE.AnimationClip.findByName(g.animations, n); if(!clip) return;
        var a = mixer.clipAction(clip);
        if(i >= A_SWING){ a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; }
        actions[i] = a;
      });
      var club = null, arm = obj.getObjectByName("arm-right"), cg = scene3(CLUBS[P.color % CLUBS.length]);
      if(arm && cg){ club = cg.scene.clone(); club.scale.setScalar(0.5); club.position.set(0, -0.13, 0.02); arm.add(club); }
      var ball = new THREE.Mesh(ballGeo, new THREE.MeshStandardMaterial({color: COLORS[P.color % COLORS.length], roughness: 0.45}));
      var bshadow = new THREE.Mesh(blobGeo, blobMat); bshadow.scale.setScalar(BALL_R*1.1);
      var cshadow = new THREE.Mesh(blobGeo, blobMat); cshadow.scale.setScalar(0.12);
      scene.add(obj); scene.add(ball); scene.add(bshadow); scene.add(cshadow);
      return {obj: obj, mixer: mixer, actions: actions, cur: -1, club: club, ball: ball, bshadow: bshadow, cshadow: cshadow, c: P.c, color: P.color};
    }
    function setAnim(m, id){
      if(m.cur === id || !m.actions[id]) return;
      var next = m.actions[id], prev = m.actions[m.cur];
      next.reset(); next.play();
      if(prev) prev.crossFadeTo(next, api.calm() ? 0.01 : 0.2, false);
      m.cur = id;
    }
    r.removePlayer = function(P){
      var m = P && P.mesh; if(!m) return;
      [m.obj, m.ball, m.bshadow, m.cshadow].forEach(function(o){ scene.remove(o); });
      m.mixer.stopAllAction(); if(m.ball.material) m.ball.material.dispose();
      P.mesh = null;
    };
    r.pick = function(nx, ny){
      raycaster.setFromCamera({x: nx, y: ny}, camera);
      return raycaster.ray.intersectPlane(plane, hit) ? [hit.x*T, hit.z*T] : null;
    };
    r.render = function(dt, t){
      var calm = api.calm();
      blades.forEach(function(b){ if(!calm) b.rotation.z += dt*1.2; });
      V.order.forEach(function(uid){
        var P = V.players[uid];
        if(!P.mesh) P.mesh = makeAvatar(P);
        var m = P.mesh; if(!m) return;
        m.obj.position.set(P.av.x/T, FLOOR_Y, P.av.z/T); m.obj.rotation.y = P.av.yaw;
        m.cshadow.position.set(P.av.x/T, FLOOR_Y + 0.002, P.av.z/T);
        setAnim(m, P.av.anim);
        if(m.club){ var sw = P.av.anim === A_SWING && !calm ? Math.max(0, 1 - (t - P.swingAt)/0.6) : 0; m.club.rotation.x = -Math.sin(sw*Math.PI)*0.9; }
        m.mixer.update(dt);
        var b = ballAt(P, t), sink = P.sunk && !P.fly;
        m.ball.visible = !sink; m.bshadow.visible = !sink;
        m.ball.position.set(b[0]/T, BALL_Y, b[1]/T); m.bshadow.position.set(b[0]/T, FLOOR_Y + 0.002, b[1]/T);
      });
      if(r.flag){ var any = V.order.some(function(u){ var Q = V.players[u]; return Q.sunk && !Q.fly; }); r.flag.position.y = FLOOR_Y - 0.03 + (any && !calm ? 0.08 : 0); }
      // aim arrow
      var P = me();
      if(P && V.state === "address"){
        arrow.visible = true; arrow.position.set(P.ball[0]/T, BALL_Y, P.ball[1]/T);
        arrow.setDirection(new THREE.Vector3(Math.cos(V.aim.a), 0, Math.sin(V.aim.a)));
        arrow.setLength(0.15 + V.aim.p/100*1.4, 0.08, 0.05);
      } else arrow.visible = false;
      // camera
      var c = V.cam, F = focusPlayer(), tx, tz, dist = c.dist, yaw = c.yaw, ty = 0.15;
      if(F){
        if(F.fly){ var fb = ballAt(F, t); tx = fb[0]/T; tz = fb[1]/T; }
        else if(F === P && V.state === "address"){ tx = P.ball[0]/T; tz = P.ball[1]/T; yaw = Math.atan2(Math.cos(V.aim.a), Math.sin(V.aim.a)); dist = Math.min(dist, 1.6); c.yaw = yaw; }
        else { tx = F.av.x/T; tz = F.av.z/T; }
      } else { tx = V.hole.tee[0]/T; tz = V.hole.tee[1]/T; }
      var px, py, pz;
      if(c.over){
        var bb = V.hole.bbox; tx = (bb[0]+bb[2])/2/T; tz = (bb[1]+bb[3])/2/T; ty = 0;
        var span = Math.max(bb[2]-bb[0], bb[3]-bb[1])/T; px = tx; py = span*1.15 + 1; pz = tz + span*0.45;
      } else { px = tx - Math.sin(yaw)*dist; pz = tz - Math.cos(yaw)*dist; py = dist*0.62 + 0.25; }
      var k = calm || !c.init ? 1 : 1 - Math.exp(-6*dt);
      c.init = true;
      c.x += (px - c.x)*k; c.y += (py - c.y)*k; c.z += (pz - c.z)*k;
      c.tx += (tx - c.tx)*k; c.ty += (ty - c.ty)*k; c.tz += (tz - c.tz)*k;
      camera.position.set(c.x, c.y, c.z); camera.lookAt(c.tx, c.ty, c.tz);
      renderer.render(scene, camera);
    };
    r.dispose = function(){
      cv.removeEventListener("webglcontextlost", lost);
      V.order.forEach(function(uid){ r.removePlayer(V.players[uid]); });
      scene.traverse(function(o){
        if(o.geometry) o.geometry.dispose();
        var mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
        mats.forEach(function(mt){ if(mt.map) mt.map.dispose(); mt.dispose(); });
      });
      ballGeo.dispose(); blobGeo.dispose(); blobMat.dispose();
      renderer.dispose(); try { renderer.forceContextLoss(); } catch(e){}
    };
    return r;
  }

  /* ---------- input ---------- */
  var drag = null, orbit = null;
  function worldAt(e){
    var rect = canvas.getBoundingClientRect(), x = e.clientX - rect.left, y = e.clientY - rect.top;
    if(R3) return R3.pick(x/rect.width*2 - 1, -(y/rect.height*2 - 1));
    if(R2 && R2.fit){ var sc = canvas.width/rect.width; return R2.toWorld(x*sc, y*sc); }
    return null;
  }
  function bindInput(cv){
    cv.addEventListener("keydown", function(e){
      if(e.metaKey || e.ctrlKey || e.altKey) return;
      var k = e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase(), P = me(), handled = true;
      if(k === "shift"){ V.keys.shift = true; return; }
      if(V.state === "address" && (k === "arrowleft" || k === "arrowright" || k === "arrowup" || k === "arrowdown")){
        var step = (e.shiftKey ? 0.5 : 2)*Math.PI/180;
        if(k === "arrowleft") V.aim.a -= step; else if(k === "arrowright") V.aim.a += step;
        else V.aim.p = clamp(V.aim.p + (k === "arrowup" ? 2 : -2), 1, 100);
        hudUpdate();
      }
      else if(k === " " || k === "spacebar"){ if(V.state === "address") shoot(); }
      else if(k === "e" || k === "enter"){ if(V.state === "address"){ V.state = "walk"; hudUpdate(); } else tryAddress(); }
      else if(k === "escape"){ if(V.state === "address"){ V.state = "walk"; drag = null; hudUpdate(); } else handled = false; }
      else if(k === "q" || k === "r"){ V.cam.yaw += (k === "q" ? 1 : -1)*Math.PI/12; }
      else if(k === "c"){ V.cam.over = !V.cam.over; }
      else if(k === "v"){ V.spectate++; }
      else if(k === "w" || k === "a" || k === "s" || k === "d" || k.indexOf("arrow") === 0){ V.keys[k] = true; }
      else handled = false;
      if(handled) e.preventDefault();
    });
    cv.addEventListener("keyup", function(e){ var k = e.key.toLowerCase(); delete V.keys[k]; if(k === "shift") V.keys.shift = false; });
    cv.addEventListener("blur", function(){ V.keys = {}; });
    cv.addEventListener("contextmenu", function(e){ e.preventDefault(); });
    cv.addEventListener("pointerdown", function(e){
      cv.focus();
      if(e.button === 2){ if(drag){ drag = null; return; } orbit = {x: e.clientX, yaw: V.cam.yaw}; return; }
      if(e.button !== 0) return;
      var P = me(), w = worldAt(e); if(!P || !w) return;
      if(V.state === "address"){ drag = {on: true}; try { cv.setPointerCapture(e.pointerId); } catch(x){} dragTo(w); return; }
      var dx = (w[0] - P.ball[0])/T, dz = (w[1] - P.ball[1])/T;
      if(V.state === "walk" && dx*dx + dz*dz < 0.12) tryAddress();
    });
    cv.addEventListener("pointermove", function(e){
      if(orbit){ V.cam.yaw = orbit.yaw - (e.clientX - orbit.x)*0.008; return; }
      if(drag){ var w = worldAt(e); if(w) dragTo(w); }
    });
    cv.addEventListener("pointerup", function(e){
      orbit = null;
      if(!drag) return;
      var d = drag; drag = null;
      if(d.len > 0.06 && V.state === "address") shoot();
    });
    cv.addEventListener("wheel", function(e){
      if(!R3) return;
      e.preventDefault(); V.cam.dist = clamp(V.cam.dist*(e.deltaY > 0 ? 1.1 : 0.9), 1.2, 5);
    }, {passive: false});
  }
  function dragTo(w){
    var P = me(); if(!P) return;
    var dx = P.ball[0] - w[0], dz = P.ball[1] - w[1], len = Math.sqrt(dx*dx + dz*dz)/T;
    drag.len = len;
    if(len < 0.02) return;
    V.aim.a = Math.atan2(dz, dx); V.aim.p = clamp(Math.round(len/1.5*100), 1, 100);
    hudUpdate();
  }

  /* ---------- lifecycle ---------- */
  function onResize(){ resize(); }
  window.addEventListener("resize", onResize);
  if(typeof ResizeObserver === "function"){ ro = new ResizeObserver(onResize); ro.observe(wrap); }
  renderMenu();
  loadData().then(function(){ if(!V.alive) return; renderMenu(); if(V.mode === "mp" && V.gotView) applyView(V.round); },
    function(){ V.note = "Couldn't load the courses."; renderMenu(); });
  if(!raf) raf = requestAnimationFrame(frame);
  V.destroy = function(){
    V.alive = false;
    if(raf) cancelAnimationFrame(raf); raf = 0;
    window.removeEventListener("resize", onResize); if(ro) ro.disconnect();
    if(R3){ R3.dispose(); R3 = null; }
    root.remove();
  };
  V.rendererKind = function(){ return R3 ? "3d" : R2 && R2.canvas ? "2d" : ""; };
  V.ballAt = ballAt;
  V.onEvent = onEvent; V.onError = onError;
  // The room socket dropped (on=false) or came back (on=true; the shell has re-joined the
  // lobby and the server's view follows). The game keeps animating meanwhile.
  V.onConn = function(on){
    V.offline = !on; badge.classList.toggle("hidden", on);
    if(on && V.pending){
      // My shot may or may not have reached the server. Keep the ball rolling; the
      // view that follows the shell's re-join settles where it really is (settleMine).
      V.pending = false; V.shotUndo = null; V.resync = true;
    }
    if(!on){ V.order.forEach(function(u){ var Q = V.players[u]; if(u !== myId()) Q.lastQ = -1; }); }
  };
  V.startPractice = startPractice;
  return V;
}

/* ---------- registration: a solo card and a "with friends" card ---------- */
HQV.register({id: "golf", name: "Mini Golf", icon: "⛳", desc: "3D putting practice on three courses",
  mount: function(el){ if(CUR) CUR.destroy(); CUR = makeGame(el, {mode: "practice"}); },
  unmount: function(){ if(CUR){ CUR.destroy(); CUR = null; } },
  pause: function(){ if(CUR) CUR.paused = true; },
  resume: function(){ if(CUR) CUR.paused = false; }});

if(MP){
  MP.handlers.golf = {
    on: function(m){ if(CUR && CUR.ctx) CUR.onEvent(m); },
    onError: function(m){ if(CUR && CUR.ctx) CUR.onError(m); },
    render: function(){}
  };
  MP.register("golf", "⛳", "3D mini golf together: walk, aim, putt", function(ctx){
    if(CUR) CUR.destroy();
    var g = CUR = makeGame(ctx.box, {mode: "mp", ctx: ctx});
    ctx.onConn = function(on){ if(g.alive) g.onConn(on); };
    ctx.stop = function(){ g.destroy(); if(CUR === g) CUR = null; };
  });
}
HQV.golfSim = GS;     // for the browser smoke test
HQV.golfDebug = function(){ return CUR; };
})();
