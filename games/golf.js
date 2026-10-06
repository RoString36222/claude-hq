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
  // Surfaces, bumpers and the shot clock that drives every moving obstacle.
  var SAND_DRAG = 150, SAND_ROLL = 420, ICE_DRAG = 6, ICE_ROLL = 22, BUMP_NUM = 5, BUMP_DEN = 4;
  var CLOCK = 2880, BLADE_GAP = 144, BLADE_HIT = 20, Z_SAND = 1, Z_ICE = 2, Z_WATER = 3;
  var ZONES = {sand: Z_SAND, ice: Z_ICE, water: Z_WATER};
  var OCT = [[1000, 0], [707, 707], [0, 1000], [-707, 707], [-1000, 0], [-707, -707], [0, -1000], [707, -707]];
  function tdiv(a, b){ return Math.trunc(a/b); }
  function isqrt(n){ if(n <= 0) return 0; var x = n, y = Math.floor((x+1)/2); while(y < x){ x = y; y = Math.floor((x + Math.floor(n/x))/2); } return x; }
  function rot(x, z, k){ k = k & 3; return k === 1 ? [z, -x] : k === 2 ? [-x, -z] : k === 3 ? [-z, x] : [x, z]; }
  function cellOf(v){ return Math.floor((v + HALF)/TILE); }
  function lexLess(a, b){ for(var i = 0; i < 4; i++){ if(a[i] !== b[i]) return a[i] < b[i]; } return false; }
  function seg(x1, z1, x2, z2, kind){ var dx = x2-x1, dz = z2-z1; return [x1, z1, dx, dz, isqrt(dx*dx + dz*dz) || 1, kind]; }
  function box(x1, z1, x2, z2){ return [[Math.min(x1, x2), Math.min(z1, z2), Math.max(x1, x2), Math.max(z1, z2)]]; }
  function compileHole(hole, pieces){
    var segs = [], seen = {}, floor = {}, voids = [], tee = null, cup = null, cols = [], rows = [];
    var slopes = [], zones = [], movers = [], bumpers = [];
    (hole.tiles || []).forEach(function(t){
      var p = pieces[t[0]] || {}, col = t[1]|0, row = t[2]|0, k = t[3]|0, cx = col*TILE, cz = row*TILE;
      floor[col+","+row] = 1; cols.push(col); rows.push(row);
      (p.segs || []).forEach(function(sg){
        var a = rot(sg[0], sg[1], k), b = rot(sg[2], sg[3], k);
        var s = [cx+a[0], cz+a[1], cx+b[0], cz+b[1]], r = [s[2], s[3], s[0], s[1]];
        var key = (lexLess(r, s) ? r : s).join(",");
        if(seen[key]) return;
        seen[key] = 1;
        segs.push(seg(s[0], s[1], s[2], s[3], 0));
      });
      (p.voids || []).forEach(function(v){
        var a = rot(v[0], v[1], k), b = rot(v[2], v[3], k);
        voids.push(box(cx+a[0], cz+a[1], cx+b[0], cz+b[1])[0]);
      });
      // a slope: a box where gravity pulls the ball along (gx, gz) every tick
      (p.slopes || []).forEach(function(v){
        var a = rot(v[0], v[1], k), b = rot(v[2], v[3], k), g = rot(v[4], v[5], k);
        slopes.push(box(cx+a[0], cz+a[1], cx+b[0], cz+b[1])[0].concat([g[0], g[1]]));
      });
      if(p.blades){
        var a = rot(p.blades[0], p.blades[1], k), b = rot(p.blades[2], p.blades[3], k);
        movers.push([0, seg(cx+a[0], cz+a[1], cx+b[0], cz+b[1], 0)]);
      }
      if(p.tee){ var te = rot(p.tee[0], p.tee[1], k); tee = [cx+te[0], cz+te[1]]; }
      if(p.cup){ var cu = rot(p.cup[0], p.cup[1], k); cup = [cx+cu[0], cz+cu[1]]; }
    });
    // per-hole surfaces: [kind, col, row, x1, z1, x2, z2] (tile-local, not rotated)
    (hole.zones || []).forEach(function(z){
      var c = (z[1]|0)*TILE, r = (z[2]|0)*TILE;
      zones.push([ZONES[z[0]]|0].concat(box(c+(z[3]|0), r+(z[4]|0), c+(z[5]|0), r+(z[6]|0))[0]));
    });
    // bumpers: [col, row, x, z, radius], an octagon that kicks the ball back harder than a wall
    (hole.bumpers || []).forEach(function(b){
      var x = (b[0]|0)*TILE + (b[2]|0), z = (b[1]|0)*TILE + (b[3]|0), r = b[4]|0, pts = OCT.map(function(o){ return [x + tdiv(r*o[0], 1000), z + tdiv(r*o[1], 1000)]; });
      pts.forEach(function(p, i){ var q = pts[(i+1) % 8]; segs.push(seg(p[0], p[1], q[0], q[1], 1)); });
      bumpers.push([x, z, r]);
    });
    // sliders: ["slider", col, row, axis (0 = x, 1 = z), half width, half depth, travel, period, phase]
    (hole.movers || []).forEach(function(m){
      if(m[0] === "slider") movers.push([1, (m[1]|0)*TILE, (m[2]|0)*TILE, m[3]|0, m[4]|0, m[5]|0, m[6]|0, m[7]|0, m[8]|0]);
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
      slopes: slopes, zones: zones, movers: movers, bumpers: bumpers,
      tee: tee, cup: cup, bbox: [Math.min.apply(null, cols)*TILE - HALF, Math.min.apply(null, rows)*TILE - HALF,
        Math.max.apply(null, cols)*TILE + HALF, Math.max.apply(null, rows)*TILE + HALF]};
  }
  function onFloor(h, x, z){
    if(!h.floor[cellOf(x)+","+cellOf(z)]) return false;
    for(var i = 0; i < h.voids.length; i++){ var v = h.voids[i]; if(v[0] < x && x < v[2] && v[1] < z && z < v[3]) return false; }
    return true;
  }
  function zoneAt(h, x, z){
    for(var i = 0; i < h.zones.length; i++){ var v = h.zones[i]; if(v[1] < x && x < v[3] && v[2] < z && z < v[4]) return v[0]; }
    return 0;
  }
  function slopeAt(h, x, z){
    for(var i = 0; i < h.slopes.length; i++){ var v = h.slopes[i]; if(v[0] < x && x < v[2] && v[1] < z && z < v[3]) return v; }
    return null;
  }
  // A slider's centre offset along its axis at clock phase ph (a triangle wave).
  function slideOff(m, ph){
    var u = (ph + m[8]) % m[7], half = tdiv(m[7], 2), tri = u < half ? u : m[7] - u;
    return -m[6] + tdiv(2*m[6]*tri, half);
  }
  // Windmill blades block their doorway while one sweeps past the bottom.
  function bladesDown(ph){ return (ph + BLADE_HIT) % BLADE_GAP < 2*BLADE_HIT; }
  // The obstacle walls that exist at clock phase ph.
  function moverSegs(h, ph){
    var out = [];
    for(var i = 0; i < h.movers.length; i++){
      var m = h.movers[i];
      if(m[0] === 0){ if(bladesDown(ph)) out.push(m[1]); continue; }
      var off = slideOff(m, ph), x = m[1] + (m[3] ? 0 : off), z = m[2] + (m[3] ? off : 0);
      var x1 = x - m[4], z1 = z - m[5], x2 = x + m[4], z2 = z + m[5];
      out.push(seg(x1, z1, x2, z1, 0), seg(x2, z1, x2, z2, 0), seg(x2, z2, x1, z2, 0), seg(x1, z2, x1, z1, 0));
    }
    return out;
  }
  function launch(ax, az, power){
    var m = isqrt(ax*ax + az*az) || 1, sp = VMIN + tdiv((power-1)*(VMAX-VMIN), 99);
    return [tdiv(ax*sp, m), tdiv(az*sp, m)];
  }
  // One shot from the shot clock's phase clk. Returns {end:[x,z], holed, oob, water, ticks}
  // (+ path: one [x,z] per tick when wanted).
  function simulate(h, bx, bz, ax, az, power, wantPath, clk){
    var sx = bx, sz = bz, v = launch(ax, az, power), vx = v[0], vz = v[1];
    var cx = h.cup[0], cz = h.cup[1], segs = h.segs, grid = h.grid, rr = R*R, path = wantPath ? [] : null;
    clk = ((clk|0) % CLOCK + CLOCK) % CLOCK;
    function done(o){ if(path){ path.push([o.end[0], o.end[1]]); o.path = path; } return o; }
    function hit(sg){
      var x1 = sg[0], z1 = sg[1], dx = sg[2], dz = sg[3], L = sg[4];
      var p = tdiv((bx-x1)*dx + (bz-z1)*dz, L);
      p = p < 0 ? 0 : (p > L ? L : p);
      var px = x1 + tdiv(dx*p, L), pz = z1 + tdiv(dz*p, L), ox = bx - px, oz = bz - pz, d2 = ox*ox + oz*oz;
      if(d2 < rr){
        var d = isqrt(d2) || 1;
        bx = px + tdiv(ox*R, d); bz = pz + tdiv(oz*R, d);
        var vn = tdiv(vx*ox + vz*oz, d), num = sg[5] ? BUMP_NUM : REST_NUM, den = sg[5] ? BUMP_DEN : REST_DEN;
        if(vn < 0){
          vx -= tdiv((den+num)*vn*ox, den*d);
          vz -= tdiv((den+num)*vn*oz, den*d);
        }
      }
    }
    for(var t = 1; t <= MAX_TICKS; t++){
      var dyn = h.movers.length ? moverSegs(h, (clk + t) % CLOCK) : [];
      var s = isqrt(vx*vx + vz*vz), n = Math.max(1, tdiv(s + SUBSTEP - 1, SUBSTEP));
      for(var j = 0; j < n; j++){
        bx += tdiv(vx, n*VS); bz += tdiv(vz, n*VS);
        var list = grid[cellOf(bx)+","+cellOf(bz)];
        if(list) for(var q = 0; q < list.length; q++) hit(segs[list[q]]);
        for(var w = 0; w < dyn.length; w++) hit(dyn[w]);
      }
      var sl = slopeAt(h, bx, bz);
      if(sl){ vx += sl[4]; vz += sl[5]; }
      s = isqrt(vx*vx + vz*vz);
      if(s > VMAX){ vx = tdiv(vx*VMAX, s); vz = tdiv(vz*VMAX, s); s = isqrt(vx*vx + vz*vz); }
      var ddx = bx - cx, ddz = bz - cz;
      if(ddx*ddx + ddz*ddz < CUP*CUP && s <= CAPTURE) return done({end:[cx, cz], holed:true, oob:false, water:false, ticks:t});
      if(!onFloor(h, bx, bz)){ if(path) path.push([bx, bz]); return done({end:[sx, sz], holed:false, oob:true, water:false, ticks:t}); }
      var zk = zoneAt(h, bx, bz);
      if(zk === Z_WATER){ if(path) path.push([bx, bz]); return done({end:[sx, sz], holed:false, oob:true, water:true, ticks:t}); }
      var dn = zk === Z_SAND ? SAND_DRAG : zk === Z_ICE ? ICE_DRAG : DRAG_NUM, rl = zk === Z_SAND ? SAND_ROLL : zk === Z_ICE ? ICE_ROLL : ROLL;
      var ns = s - tdiv(s*dn, DRAG_DEN) - rl;
      if(ns <= STOP){
        if(!sl) return done({end:[bx, bz], holed:false, oob:false, water:false, ticks:t});
        if(ns < 0) ns = 0;          // on a slope the ball never rests: gravity takes it next tick
      }
      if(s){ vx = tdiv(vx*ns, s); vz = tdiv(vz*ns, s); }
      if(path) path.push([bx, bz]);
    }
    return done({end:[bx, bz], holed:false, oob:false, water:false, ticks:MAX_TICKS});
  }
  return {compileHole:compileHole, simulate:simulate, onFloor:onFloor, zoneAt:zoneAt, slopeAt:slopeAt, moverSegs:moverSegs,
    slideOff:slideOff, bladesDown:bladesDown, isqrt:isqrt, tdiv:tdiv, cellOf:cellOf,
    C:{TILE:TILE, R:R, CUP:CUP, VS:VS, TICK:TICK, VMIN:VMIN, VMAX:VMAX, DRAG_NUM:DRAG_NUM, DRAG_DEN:DRAG_DEN, ROLL:ROLL,
       STOP:STOP, REST_NUM:REST_NUM, REST_DEN:REST_DEN, CAPTURE:CAPTURE, SUBSTEP:SUBSTEP, MAX_TICKS:MAX_TICKS,
       MAX_STROKES:MAX_STROKES, OOB_PENALTY:OOB_PENALTY, AIM_MAX:AIM_MAX, CLOCK:CLOCK, BLADE_GAP:BLADE_GAP,
       BLADE_HIT:BLADE_HIT, Z_SAND:Z_SAND, Z_ICE:Z_ICE, Z_WATER:Z_WATER}};
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
// "#rrggbb" from the course file -> 0xrrggbb (anything else -> fallback)
function hex(s, fb){ return typeof s === "string" && /^#[0-9a-f]{6}$/i.test(s) ? parseInt(s.slice(1), 16) : fb; }
// The shot clock every moving obstacle follows: wall-clock ticks, so every player sees the
// blades and gates at (nearly) the same place, and a putt sends the phase it left at.
function clockNow(){ return (Date.now()*GS.C.TICK/1000) % GS.C.CLOCK; }
function shotClock(){ return Math.floor(clockNow()) % GS.C.CLOCK; }
// How high the felt is at (x, z) above the flat floor (tile units): only the hill and
// mound pieces lift it. Drawing only: the physics uses their slope boxes.
var LIFT = {"hill-round": function(lx, lz){ var u = Math.abs(lz)/3000; return u < 1 ? 0.084*Math.pow(1 - u*u, 1.5) : 0; },
            "bump": function(lx, lz){ var u = (lx*lx + lz*lz)/(2500*2500); return u < 1 ? 0.034*(1 - u) : 0; }};
function liftAt(h, x, z){
  if(!h || !h.lifts || !h.lifts.length) return 0;
  var c = GS.cellOf(x), r = GS.cellOf(z);
  for(var i = 0; i < h.lifts.length; i++){
    var L = h.lifts[i]; if(L[1] !== c || L[2] !== r) continue;
    var dx = x - c*T, dz = z - r*T, k = (4 - (L[3] & 3)) & 3;   // undo the tile's rotation
    var lx = k === 1 ? dz : k === 2 ? -dx : k === 3 ? -dz : dx, lz = k === 1 ? -dx : k === 2 ? -dz : k === 3 ? dx : dz;
    return LIFT[L[0]](lx, lz);
  }
  return 0;
}
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
// What a course has in it, for its card ("sand, ice, windmill …").
function courseFeatures(c){
  var f = {};
  (c.holes || []).forEach(function(h){
    (h.zones || []).forEach(function(z){ f[z[0] === "water" ? "water" : z[0]] = 1; });
    if((h.bumpers || []).length) f.bumpers = 1;
    if((h.movers || []).length) f["moving gates"] = 1;
    (h.tiles || []).forEach(function(t){ if(t[0] === "windmill") f.windmill = 1; if(t[0] === "hill-round" || t[0] === "bump") f.hills = 1;
      if(t[0] === "gap") f.moats = 1; if(t[0].indexOf("tunnel") === 0) f.tunnels = 1; });
  });
  var k = Object.keys(f); return k.length ? k.join(", ") : "classic lanes";
}
function courseTheme(c){ return (c && c.theme && typeof c.theme === "object") ? c.theme : {}; }
function coursePar(c){ return (c.holes || []).reduce(function(a, h){ return a + (h.par|0); }, 0); }
// Every [course id, hole index] in the course file, in file order.
function allHoles(){
  var out = [];
  ((DATA && DATA.courses) || []).forEach(function(c){ (c.holes || []).forEach(function(_, i){ out.push([c.id, i]); }); });
  return out;
}
// "Play random": n distinct holes from every course (capped at all there are). A fresh
// seed each round (the draw is meant to differ), through the shared PRNG, not Math.random.
var RANDOM_SIZES = [5, 10, 15];
function pickMix(n){
  var all = allHoles(), r = api.rng("golf:random:"+Date.now()+":"+Math.floor(performance.now()*1000)), out = [];
  n = Math.max(0, Math.min(n|0, all.length));
  for(var i = 0; i < n; i++){ var j = i + Math.floor(r()*(all.length - i)), tmp = all[i]; all[i] = all[j]; all[j] = tmp; out.push(all[i]); }
  return out;
}
// A random round as one course: the drawn holes in play order, each remembering the course
// it came from (theme, scenery). null if any pair is unknown to this copy of the course file.
function mixCourse(mix){
  if(!Array.isArray(mix) || !mix.length) return null;
  var holes = [], src = [], ids = [], ok = true;
  mix.forEach(function(m){
    var c = Array.isArray(m) ? courseById(m[0]) : null, i = Array.isArray(m) ? m[1]|0 : -1, h = c && c.holes ? c.holes[i] : null;
    if(!h){ ok = false; return; }
    holes.push(h); src.push({course: c, idx: i}); ids.push(c.id+"."+i);
  });
  return ok ? {id: "random:"+ids.join(","), name: "Random "+holes.length, random: true, holes: holes, src: src, theme: {}} : null;
}
// The course a server view is played on (a random round builds the server's mix).
function viewCourse(view){ view = view || {}; return view.course === "random" ? mixCourse(view.mix) : courseById(view.course); }
// Where hole i of a round came from: its own course (theme, scenery seed) and its index there.
function holeSrc(c, i){ i = i|0; return c && c.src ? (c.src[i] || {course: null, idx: i}) : {course: c || null, idx: i}; }
// The scenery models a round needs: each source course's theme props.
function courseProps(c){
  var seen = {}, out = [];
  (c && c.src ? c.src.map(function(s){ return s.course; }) : [c]).forEach(function(k){
    (courseTheme(k).props || []).filter(function(n){ return typeof n === "string"; }).slice(0, 16).forEach(function(n){
      if(!seen[n]){ seen[n] = 1; out.push(n); }
    });
  });
  return out;
}
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
// Small rendered portraits of the six character looks, made once with an offscreen renderer.
var THUMBS = null, THUMBS_P = null;
function charThumbs(){
  if(THUMBS || THUMBS_P || !hasWebGL2()) return THUMBS_P || Promise.resolve(THUMBS);
  THUMBS_P = golfLib().then(function(lib){
    return Promise.all(CHARS.map(function(c){ return loadGlb(lib, c.f); })).then(function(gs){
      var THREE = lib.THREE, S = 96, cv = document.createElement("canvas"); cv.width = S; cv.height = S;
      var r = new THREE.WebGLRenderer({canvas: cv, alpha: true, antialias: true, preserveDrawingBuffer: true});
      r.setSize(S, S, false); r.outputColorSpace = THREE.SRGBColorSpace;
      var out = gs.map(function(g){
        var scene = new THREE.Scene(), obj = lib.clone(g.scene);
        scene.add(obj); scene.add(new THREE.HemisphereLight(0xffffff, 0x667788, 2.2));
        var d = new THREE.DirectionalLight(0xffffff, 1.6); d.position.set(1, 2, 3); scene.add(d);
        var box = new THREE.Box3().setFromObject(obj), size = box.getSize(new THREE.Vector3()), mid = box.getCenter(new THREE.Vector3());
        var cam = new THREE.PerspectiveCamera(30, 1, 0.01, 100), h = size.y;
        cam.position.set(mid.x, mid.y + h*0.08, mid.z + h*2.1); cam.lookAt(mid.x, mid.y + h*0.05, mid.z);
        r.render(scene, cam);
        return cv.toDataURL("image/png");
      });
      r.dispose(); THUMBS = out; return out;
    });
  }).catch(function(){ THUMBS_P = null; return null; });
  return THUMBS_P;
}
// Your own Arena identity (display name + avatar), if you're paired.
function arenaMe(){
  var y = window.ARENA && window.ARENA.you;
  if(!y || typeof y !== "object") return null;
  var name = String(y.displayName || y.handle || "").slice(0, 40);
  var av = typeof y.avatarUrl === "string" && /^https:\/\//.test(y.avatarUrl) ? y.avatarUrl : "";
  return name ? {name: name, avatar: av, handle: String(y.handle || "").slice(0, 40)} : null;
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
  var meterLabel = api.mk("span", "vg-golf-power-l", "Power");
  meter.appendChild(meterFill); meter.appendChild(meterLabel); meter.setAttribute("aria-hidden", "true");
  // Controls legend (H or ? toggles it); remembered in the Valley save.
  var keysBox = api.mk("div", "vg-golf-keys");
  hud.setAttribute("aria-live", "polite");
  cardBox.setAttribute("role", "dialog"); cardBox.setAttribute("aria-label", "Scorecard");
  var tools = api.mk("div", "vg-row vg-golf-tools");
  var load = api.mk("div", "vg-meter vg-golf-load hidden"), loadFill = api.mk("i"); load.appendChild(loadFill); load.setAttribute("aria-hidden", "true");
  var badge = api.mk("span", "vg-reconnecting vg-golf-badge hidden", "Reconnecting…"); badge.setAttribute("role", "status");
  stage.appendChild(wrap); stage.appendChild(hint); stage.appendChild(tools); stage.appendChild(keysBox);
  var CAM_SPEEDS = [["Slow", 0.5], ["Normal", 1], ["Fast", 1.6]];
  function camSensIdx(){ var i = gsave().camSpeed; return (i === 0 || i === 1 || i === 2) ? i : 0; }   // default Slow: comfortable on trackpads
  function camSens(){ return CAM_SPEEDS[camSensIdx()][1]; }
  var KEYS = {
    walk: [["W A S D / arrows", "walk"], ["Shift", "sprint"], ["E / Enter / click ball", "address the ball"], ["Q / R", "turn camera"], ["Z / X", "zoom in / out"], ["C", "overview"], ["V", "watch another player"], ["H", "hide these keys"]],
    address: [["\u2190 / \u2192", "aim (Shift = fine)"], [", / .", "nudge aim a hair"], ["\u2191 / \u2193", "power \u00b12"], ["+ / \u2212", "power \u00b15"], ["1 \u2026 9, 0", "power 10%\u2026100%"], ["Space", "putt"], ["drag back", "aim + power with mouse/trackpad"], ["Esc / E", "step away"]]
  };
  function renderKeys(){
    keysBox.textContent = "";
    if(gsave().keysHidden){ keysBox.appendChild(api.mk("span", "vg-muted", "Keys hidden \u2014 press H to show them")); return; }
    (KEYS[V.state === "address" ? "address" : "walk"]).forEach(function(r){
      var it = api.mk("span", "vg-golf-key"); it.appendChild(api.mk("kbd", null, r[0])); it.appendChild(document.createTextNode(" "+r[1])); keysBox.appendChild(it);
    });
  }
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
  function setCourse(c){
    if(typeof c === "string") c = courseById(c);
    if(!c) return false;
    if(canvas && (!V.course || V.course.id !== c.id)){   // the 3D view loads one round's models: rebuild it
      if(R3){ R3.dispose(); R3 = null; }
      canvas.remove(); canvas = null; R2 = null;
    }
    V.course = c;
    V.holes = c.holes.map(function(h){
      var ch = GS.compileHole(h, DATA.pieces);
      ch.lifts = (h.tiles || []).filter(function(t){ return LIFT[t[0]]; }).map(function(t){ return [t[0], t[1]|0, t[2]|0, t[3]|0]; });
      return ch;
    });
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
    var who = api.mk("div", "vg-golf-me"), meA = arenaMe();
    if(meA && meA.avatar){ var im = document.createElement("img"); im.src = meA.avatar; im.alt = ""; im.referrerPolicy = "no-referrer"; im.width = 28; im.height = 28; who.appendChild(im); }
    who.appendChild(api.mk("b", null, meA ? meA.name : "You"));
    if(meA && meA.handle && meA.handle !== meA.name) who.appendChild(api.mk("span", "vg-muted", "@"+meA.handle));
    if(!meA) who.appendChild(api.mk("span", "vg-muted", "Pair with the Arena to play under your name"));
    menu.appendChild(who);
    menu.appendChild(api.mk("h4", "vg-golf-h vg-golf-h2", "Look"));
    var chars = api.mk("div", "vg-golf-chars"); chars.setAttribute("role", "group"); chars.setAttribute("aria-label", "Pick a look");
    var mine = sv.char != null ? clamp(sv.char|0, 0, 5) : 0;
    CHARS.forEach(function(ch, i){
      var b = api.btn("", "vg-golf-char"+(i === mine ? " on" : ""), function(){
        sv.char = i; api.persist(); if(mp && MP) MP.send("golf", "char", {c: i}); renderMenu();
      });
      if(THUMBS && THUMBS[i]){ var ti = document.createElement("img"); ti.src = THUMBS[i]; ti.alt = ""; ti.width = 48; ti.height = 48; b.appendChild(ti); }
      b.appendChild(api.mk("span", null, "Look "+(i+1)));
      b.setAttribute("aria-label", "Look "+(i+1)); b.setAttribute("aria-pressed", i === mine ? "true" : "false");
      chars.appendChild(b);
    });
    menu.appendChild(chars);
    if(!THUMBS) charThumbs().then(function(t){ if(t && V.alive && stage.classList.contains("hidden")) renderMenu(); });   // menu still showing
    // courses
    var isHost = mp && isLobbyHost();
    menu.appendChild(api.mk("h4", "vg-golf-h", mp ? (isHost ? "Pick a course to start the round" : "Courses") : "Courses"));
    var grid = api.mk("div", "vg-golf-courses");
    DATA.courses.forEach(function(c){
      var card = api.mk("button", "vg-card vg-golf-course"); card.type = "button";
      var th = courseTheme(c), ic = api.mk("span", "vg-card-ic", typeof th.icon === "string" ? th.icon.slice(0, 4) : "⛳");
      ic.setAttribute("aria-hidden", "true"); card.appendChild(ic);
      var t = api.mk("span", "vg-card-t"); t.appendChild(api.mk("b", null, c.name));
      var best = sv.best[c.id];
      t.appendChild(api.mk("span", null, c.holes.length+" holes · par "+coursePar(c)+(best ? " · your best "+best : "")));
      if(typeof th.mood === "string") t.appendChild(api.mk("span", "vg-golf-mood", th.mood.slice(0, 40)+" · "+courseFeatures(c)));
      card.appendChild(t);
      if(mp && !isHost) card.disabled = true;
      card.addEventListener("click", function(){
        if(mp){ if(MP) MP.send("golf", "start", {course: c.id}); }
        else startPractice(c.id);
      });
      grid.appendChild(card);
    });
    menu.appendChild(grid);
    // play random: N holes drawn from every course, each with its own course's look
    var total = allHoles().length, lastK = -1;
    menu.appendChild(api.mk("h4", "vg-golf-h", "Play random"));
    menu.appendChild(api.mk("p", "vg-muted", "Holes drawn at random from every course, each keeping its own scenery."));
    var rnd = api.mk("div", "vg-row vg-golf-random"); rnd.setAttribute("role", "group"); rnd.setAttribute("aria-label", "Play random holes");
    RANDOM_SIZES.forEach(function(n){
      var k = Math.min(n, total); if(k < 1 || k === lastK) return; lastK = k;
      var lbl = k+" holes"+(k < n ? " (all "+total+" there are)" : "");
      var b = api.btn("\ud83c\udfb2 "+lbl, "", function(){
        if(mp){ if(MP) MP.send("golf", "start", {course: "random", holes: n}); }
        else startPractice(mixCourse(pickMix(n)));
      });
      b.setAttribute("aria-label", "Play "+lbl+" at random");
      if(mp && !isHost) b.disabled = true;
      rnd.appendChild(b);
    });
    menu.appendChild(rnd);
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
  function startPractice(c){
    resetPlayers();
    if(!setCourse(c)) return;
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
      // a random round's holes differ every time: no "best" to keep
      var rec = !V.course.random, prev = rec ? sv.best[id] : 0, better = rec && (!prev || total < prev);
      if(better){ sv.best[id] = total; api.persist(); }
      V.finalCard = {card: card, par: V.holes.map(function(h){ return h.par; }), done: true};
      showCard(card, "Round complete: "+total+" strokes (par "+coursePar(V.course)+")"+(better ? " · new best!" : ""), true);
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
    var vc = viewCourse(view); if(!vc) return;
    if(V.pendingHole && view.hole !== V.holeIdx && V.course && vc.id === V.course.id){ V.deferredView = view; return; }
    var fresh = !V.course || V.course.id !== vc.id;
    if(fresh){ resetPlayers(); if(!setCourse(vc)) return; }
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
      applyView(m.round || null); if(m.by && m.round && m.round.phase === "playing" && m.by.userId !== myId()) api.toast("⛳ "+MP.nameOf(m.by)+" started "+((viewCourse(m.round)||{}).name||"a round")); return; }
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
        var res = GS.simulate(V.hole, from[0], from[1], m.ax|0, m.az|0, m.power|0, true, m.clk|0);
        if(res.end[0] !== end[0] || res.end[1] !== end[1]) res.path.push(end);
        var t = now(), at = ballAt(P, t), skip = Math.min(Math.floor((t - f.t0)*GS.C.TICK), res.path.length - 1);
        P.fly = null;
        // ease from where the ball is drawn now onto the server's roll (same moment of it) over 150 ms
        startFlight(P, {from: from, path: res.path, end: end, holed: !!m.holed, oob: !!m.oob, water: !!m.water, mine: true, noSwing: true,
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
    var r = GS.simulate(V.hole, from[0], from[1], m.ax|0, m.az|0, m.power|0, true, m.clk|0);
    if(r.end[0] !== end[0] || r.end[1] !== end[1] || r.holed !== !!m.holed){ warnOnce(); r.path.push(end); }
    startFlight(P, {from: from, path: r.path, end: end, holed: !!m.holed, oob: !!m.oob, water: !!m.water});
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
        : f.water ? "Splash! Water hazard: +1, back to your last lie" : f.oob ? "Out of bounds: +1, back to your last lie" : P.done ? "Picked up at "+GS.C.MAX_STROKES+" strokes" : "";
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
    var n = V.holeIdx, clk = shotClock();
    if(V.mode === "mp"){
      // Optimistic: every client runs the server's exact integer roll, so the ball starts
      // moving now; the server's "shot" answer (same seq) only confirms it.
      V.seq++;
      if(!MP || !MP.send("golf", "shot", {ax: ax, az: az, power: power, seq: V.seq, hole: n, clk: clk})){ api.toast("Not connected to the Arena"); return; }
      V.pending = true; V.pendingAt = now();
      V.shotUndo = {hole: n, ball: P.ball.slice(), strokes: P.strokes[n]|0, done: P.done};
    }
    var res = GS.simulate(V.hole, P.ball[0], P.ball[1], ax, az, power, true, clk);
    P.strokes[n] = (P.strokes[n]|0) + 1 + (res.oob ? GS.C.OOB_PENALTY : 0);
    if(res.holed) P.done = true;
    else if(P.strokes[n] >= GS.C.MAX_STROKES){ P.strokes[n] = GS.C.MAX_STROKES; P.done = true; }
    startFlight(P, {from: [P.ball[0], P.ball[1]], path: res.path, end: res.end, holed: res.holed, oob: res.oob, water: res.water, mine: true});
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
    meterPaint();
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
  function meterPaint(){
    var pw = Math.max(1, Math.round(V.aim.p));
    meterFill.style.width = pw+"%";
    meterFill.style.backgroundSize = (10000/pw)+"% 100%";   // the colour ramp spans the whole bar, not just the fill
    var lt = "Power "+pw+"%"; if(meterLabel.textContent !== lt) meterLabel.textContent = lt;
    meter.classList.toggle("hidden", V.state !== "address");
  }
  function hudUpdate(){
    meterPaint();
    if(!V.hole){ hud.textContent = ""; hint.textContent = ""; return; }
    hud.textContent = "";
    var P = me(), n = V.holeIdx;
    hud.appendChild(api.mk("b", null, V.course.name+" · Hole "+(n+1)+"/"+V.holes.length+" · Par "+V.hole.par));
    var hs = holeSrc(V.course, n);
    hud.appendChild(api.mk("span", null, V.hole.name+(V.course.random && hs.course ? " · from "+hs.course.name : "")));
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
    var cs = api.btn("Camera: "+CAM_SPEEDS[camSensIdx()][0], "", function(){ gsave().camSpeed = (camSensIdx()+1) % 3; api.persist(); hudUpdate(); });
    cs.title = "How fast the camera turns and zooms with a mouse or trackpad";
    tools.appendChild(cs);
    renderKeys();
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
        hideCard(); if(V.mode === "practice") startPractice(V.course.random ? mixCourse(pickMix(V.holes.length)) : V.course.id);
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
      var TH = courseTheme(holeSrc(V.course, V.holeIdx).course), ph = clockNow();
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.fillStyle = css(hex(TH.island, 0x6fb35a)); g.fillRect(0, 0, W, H);
      h.tiles.forEach(function(tl){ g.fillStyle = "#4fae55"; g.fillRect(X(tl[1]*T - T/2), Y(tl[2]*T - T/2), T*s+0.5, T*s+0.5); });
      g.fillStyle = "#2c3b2c";
      h.voids.forEach(function(v){ g.fillRect(X(v[0]), Y(v[1]), (v[2]-v[0])*s, (v[3]-v[1])*s); });
      // surfaces, hills (light stripes), bumpers and the moving gates at the clock's phase
      h.zones.forEach(function(z){
        g.fillStyle = z[0] === GS.C.Z_SAND ? css(hex(TH.sand, 0xe9d59b)) : z[0] === GS.C.Z_ICE ? "#d6f0fb" : "#2f86c8";
        g.fillRect(X(z[1]), Y(z[2]), (z[3]-z[1])*s, (z[4]-z[2])*s);
      });
      g.fillStyle = "rgba(255,255,255,.18)";
      h.slopes.forEach(function(v){ g.fillRect(X(v[0]), Y(v[1]), (v[2]-v[0])*s, (v[3]-v[1])*s); });
      h.bumpers.forEach(function(b){ g.fillStyle = css(hex(TH.bumper, 0xe74c3c)); g.beginPath(); g.arc(X(b[0]), Y(b[1]), b[2]*s, 0, 7); g.fill(); });
      g.fillStyle = "#8a5a3c";
      GS.moverSegs(h, Math.floor(ph)).forEach(function(sg){ g.fillRect(Math.min(X(sg[0]), X(sg[0]+sg[2])) - 2, Math.min(Y(sg[1]), Y(sg[1]+sg[3])) - 2,
        Math.abs(sg[2])*s + 4, Math.abs(sg[3])*s + 4); });
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
      var props = courseProps(V.course);       // a random round: every source course's scenery
      var slid = V.course.holes.some(function(h){ return (h.movers || []).length; });
      var names = coursePieces(V.course).concat(["flag-red"], CHARS.map(function(c){ return c.f; }), CLUBS, props, slid ? ["block"] : []);
      var got = 0;
      V.note = "Loading 0/"+names.length; load.classList.remove("hidden"); loadFill.style.width = "4%";
      return Promise.all(names.map(function(n){ return loadGlb(lib, n).then(function(g){
          got++; V.note = "Loading "+got+"/"+names.length; hint.textContent = V.note; loadFill.style.width = Math.round(got/names.length*100)+"%"; return g; }); }))
        .then(function(){ V.note = ""; load.classList.add("hidden"); return build3d(lib, THREE, cv); },
              function(e){ load.classList.add("hidden"); throw e; });
    });
  }
  function build3d(lib, THREE, cv){
    // The theme is per hole (a random round mixes courses): applyTheme restyles the sky,
    // fog, lights, sea and tile tint when a hole from another course starts.
    var TH = {}, snow = false, themeOf;
    var renderer = new THREE.WebGLRenderer({canvas: cv, antialias: true});
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap;
    var scene = new THREE.Scene();
    // sky: a vertical gradient behind everything, fog fading the far island into it
    var gc = document.createElement("canvas"); gc.width = 2; gc.height = 256;
    var gg = gc.getContext("2d");
    var skyTex = new THREE.CanvasTexture(gc); skyTex.colorSpace = THREE.SRGBColorSpace; scene.background = skyTex;
    scene.fog = new THREE.Fog(0xdff1ff, 9, 40);
    var camera = new THREE.PerspectiveCamera(55, 1.6, 0.03, 200);
    var hemi = new THREE.HemisphereLight(0xffffff, 0x4b5b45, 2.0); scene.add(hemi);
    var sun = new THREE.DirectionalLight(0xffffff, 1.8); sun.position.set(3, 8, 4);
    sun.castShadow = true; sun.shadow.mapSize.set(1024, 1024); sun.shadow.bias = -0.0008; sun.shadow.normalBias = 0.01;
    scene.add(sun); scene.add(sun.target);
    // the sea / plain the island sits in
    var groundGeo = new THREE.PlaneGeometry(400, 400); groundGeo.rotateX(-Math.PI/2);
    var ground = new THREE.Mesh(groundGeo, new THREE.MeshLambertMaterial({color: 0x6fb35a})); ground.position.y = -0.09; scene.add(ground);
    var tint = new THREE.Color(0xffffff), tinted = {}, snowed = {};
    function applyTheme(c){
      if(themeOf === c) return;
      themeOf = c; TH = courseTheme(c); snow = !!TH.snow;
      var sky = hex((TH.sky || [])[0], 0x8fc9ef), horizon = hex((TH.sky || [])[1], 0xdff1ff);
      var grad = gg.createLinearGradient(0, 0, 0, 256);
      grad.addColorStop(0, css(sky)); grad.addColorStop(0.62, css(horizon)); grad.addColorStop(1, css(hex(TH.fog, horizon)));
      gg.clearRect(0, 0, 2, 256); gg.fillStyle = grad; gg.fillRect(0, 0, 2, 256); skyTex.needsUpdate = true;
      scene.fog.color.setHex(hex(TH.fog, horizon)); scene.fog.near = +TH.fogNear || 9; scene.fog.far = +TH.fogFar || 40;
      hemi.color.setHex(hex(TH.hemiSky, 0xffffff)); hemi.groundColor.setHex(hex(TH.hemiGround, 0x4b5b45)); hemi.intensity = +TH.hemiI || 2.0;
      sun.color.setHex(hex(TH.sun, 0xffffff)); sun.intensity = +TH.sunI || 1.8;
      ground.material.color.setHex(hex(TH.sea, 0x6fb35a));
      tint.setHex(hex(TH.tint, 0xffffff));
      // tinted / snowed material copies belong to the old theme (its hole is already off the scene)
      [tinted, snowed].forEach(function(m){ for(var k in m) m[k].dispose(); });
      tinted = {}; snowed = {};
    }
    applyTheme(holeSrc(V.course, V.holeIdx).course);
    var holeGroup = null, blades = [], sliders = [], waters = [], ballGeo = new THREE.SphereGeometry(BALL_R, 16, 12);
    var blobGeo = new THREE.CircleGeometry(1, 20); blobGeo.rotateX(-Math.PI/2);
    var blobMat = new THREE.MeshBasicMaterial({color: 0x000000, transparent: true, opacity: 0.22, depthWrite: false});
    var arrow = new THREE.ArrowHelper(new THREE.Vector3(0, 0, -1), new THREE.Vector3(), 0.5, 0xffffff, 0.08, 0.05); arrow.visible = false; scene.add(arrow);
    var raycaster = new THREE.Raycaster(), plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -FLOOR_Y), hit = new THREE.Vector3();
    var lost = function(e){ e.preventDefault(); if(V.alive){ V.note = "3D unavailable: showing the map view."; setTimeout(fallback2d, 0); } };
    cv.addEventListener("webglcontextlost", lost);
    function scene3(name){ return GLTF[name] || null; }
    // course pieces take the theme's tint (one shared copy per material); props get a dusting of snow
    function dress(o, how){
      o.traverse(function(m){
        if(!m.isMesh) return;
        m.castShadow = true; m.receiveShadow = true;
        if(how === "tile" && tint.getHex() !== 0xffffff){
          var k = m.material.uuid;
          if(!tinted[k]){ tinted[k] = m.material.clone(); tinted[k].color.multiply(tint); }
          m.material = tinted[k];
        } else if(how === "prop"){
          // Nature Kit materials leave glTF's metallic default (1.0), which renders black without an
          // environment map: make them matte. Grass tufts on rocks take the island's colour, and
          // on Snowy Peak everything gets a dusting of snow.
          m.castShadow = true; m.receiveShadow = false;
          var j = m.material.uuid, nm = m.material.name || "";
          if(!snowed[j]){
            var c = snowed[j] = m.material.clone(); c.metalness = 0; c.roughness = 0.9;
            if(/^grass$/i.test(nm) && TH.tuftTint) c.color.lerp(new THREE.Color(hex(TH.island, 0x79b95a)), snow ? 0.9 : 0.75);
            if(/^dirt$/i.test(nm) && TH.rockTint) c.color.lerp(new THREE.Color(hex(TH.rockTint, 0x9a9aa6)), 0.75);
            if(snow) c.color.lerp(new THREE.Color(0xf4f8ff), /leaf/i.test(nm) ? 0.4 : /grass/i.test(nm) ? 0.6 : 0.25);
          }
          m.material = snowed[j];
        }
      });
      return o;
    }
    function flat(w, d, color, opts){
      var g = new THREE.PlaneGeometry(w, d); g.rotateX(-Math.PI/2);
      var mt = opts && opts.standard ? new THREE.MeshStandardMaterial({color: color, roughness: opts.rough != null ? opts.rough : 0.6, metalness: 0.05,
                 transparent: !!opts.alpha, opacity: opts.alpha || 1, polygonOffset: true, polygonOffsetFactor: -2})
               : new THREE.MeshLambertMaterial({color: color, polygonOffset: true, polygonOffsetFactor: -2});
      var m = new THREE.Mesh(g, mt); m.receiveShadow = true; return m;
    }
    // an island: a rounded plate a couple of tiles wider than the hole
    function island(bb){
      var x0 = bb[0]/T - 2.2, z0 = bb[1]/T - 2.2, x1 = bb[2]/T + 2.2, z1 = bb[3]/T + 2.2, rr = 1.6, sh = new THREE.Shape();
      sh.moveTo(x0 + rr, z0); sh.lineTo(x1 - rr, z0); sh.quadraticCurveTo(x1, z0, x1, z0 + rr); sh.lineTo(x1, z1 - rr);
      sh.quadraticCurveTo(x1, z1, x1 - rr, z1); sh.lineTo(x0 + rr, z1); sh.quadraticCurveTo(x0, z1, x0, z1 - rr); sh.lineTo(x0, z0 + rr);
      sh.quadraticCurveTo(x0, z0, x0 + rr, z0);
      var g = new THREE.ExtrudeGeometry(sh, {depth: 0.09, bevelEnabled: true, bevelThickness: 0.03, bevelSize: 0.08, bevelSegments: 2, curveSegments: 6});
      g.rotateX(Math.PI/2);
      var m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({color: hex(TH.island, 0x79b95a)}));
      m.position.y = -0.003; m.receiveShadow = true; m.userData.own = true; return m;
    }
    // scenery: the theme's props scattered (deterministically) on the island, clear of the lanes
    function scatter(group, h, idx){
      var props = (TH.props || []).filter(function(n){ return scene3(n); });
      if(!props.length) return;
      var hs = holeSrc(V.course, idx), r = api.rng("golf:"+((hs.course || V.course).id)+":"+hs.idx), bb = h.bbox, placed = 0;
      var tall = /^(tree|stone-tall|rock-tall|statue|cactus-tall|crops-corn)/;
      function clear(x, z, gap){
        for(var key in h.floor){ var c = key.split(","), cx = +c[0], cz = +c[1];
          var dx = Math.max(Math.abs(x - cx) - 0.5, 0), dz = Math.max(Math.abs(z - cz) - 0.5, 0);
          if(dx*dx + dz*dz < gap*gap) return false; }
        var tx = h.tee[0]/T, tz = h.tee[1]/T;           // golfers wait to the right of the tee, and the
        if(x > tx - 0.2 && x < tx + 1.4 && z > tz - 0.4 && z < tz + 1.2) return false;   // camera looks from behind it
        if(Math.abs(x - tx) < 2.4 && z > tz && z < tz + 3.5) return false;
        return true;
      }
      for(var tries = 0; tries < 260 && placed < 34; tries++){
        var name = props[Math.floor(r()*props.length)], x = bb[0]/T - 1.9 + r()*((bb[2]-bb[0])/T + 3.8), z = bb[1]/T - 1.9 + r()*((bb[3]-bb[1])/T + 3.8);
        var big = tall.test(name);
        if(!clear(x, z, big ? 0.85 : 0.35)) continue;
        var o = dress(scene3(name).scene.clone(), "prop"), sc = (big ? 0.5 : 0.75) + r()*0.3;
        o.scale.setScalar(sc); o.position.set(x, 0, z); o.rotation.y = r()*Math.PI*2;
        group.add(o); placed++;
      }
    }
    var r = {};
    r.size = function(w, h){ renderer.setSize(w, h, false); camera.aspect = w/h; camera.updateProjectionMatrix(); };
    r.buildHole = function(){
      if(holeGroup){
        scene.remove(holeGroup);
        holeGroup.traverse(function(o){ if(o.userData && o.userData.own){ o.geometry.dispose(); o.material.dispose(); } });
      }
      applyTheme(holeSrc(V.course, V.holeIdx).course);   // a random round: this hole's own course look
      holeGroup = new THREE.Group(); blades = []; sliders = []; waters = [];
      var h = V.hole, bb = h.bbox;
      holeGroup.add(island(bb));
      h.tiles.forEach(function(tl){
        var g = scene3(tl[0]); if(!g) return;
        var o = dress(g.scene.clone(), "tile"); o.position.set(tl[1], 0, tl[2]); o.rotation.y = (tl[3]|0)*Math.PI/2; holeGroup.add(o);
        var b = o.getObjectByName("blades");
        if(b){ b.position.y -= 0.06; blades.push(b); }   // hub a touch lower, so a blade at the bottom really covers the door
      });
      // surfaces: sand, ice and water drawn on the felt
      h.zones.forEach(function(z){
        var w = (z[3]-z[1])/T, d = (z[4]-z[2])/T, m;
        if(z[0] === GS.C.Z_SAND) m = flat(w, d, hex(TH.sand, 0xe9d59b));
        else if(z[0] === GS.C.Z_ICE) m = flat(w, d, 0xdaf2ff, {standard: true, rough: 0.08, alpha: 0.82});
        else if(z[0] === GS.C.Z_WATER){ m = flat(w, d, 0x2f86c8, {standard: true, rough: 0.15, alpha: 0.9}); waters.push(m); }
        if(!m) return;
        m.userData.own = true; m.position.set((z[1]+z[3])/2/T, FLOOR_Y + (z[0] === GS.C.Z_WATER ? 0.0016 : 0.0008), (z[2]+z[4])/2/T); holeGroup.add(m);
      });
      // bumpers: a fat ring post in the theme's colour
      h.bumpers.forEach(function(b){
        var rad = b[2]/T, post = new THREE.Mesh(new THREE.CylinderGeometry(rad*0.92, rad, 0.13, 20),
          new THREE.MeshStandardMaterial({color: hex(TH.bumper, 0xe74c3c), roughness: 0.35}));
        post.position.set(b[0]/T, FLOOR_Y + 0.065, b[1]/T); post.castShadow = true; post.userData.own = true; holeGroup.add(post);
        var cap = new THREE.Mesh(new THREE.TorusGeometry(rad*0.78, rad*0.12, 8, 24), new THREE.MeshStandardMaterial({color: 0xffffff, roughness: 0.3}));
        cap.rotation.x = Math.PI/2; cap.position.set(b[0]/T, FLOOR_Y + 0.13, b[1]/T); cap.userData.own = true; holeGroup.add(cap);
      });
      // sliding gates: a Kenney block, stretched to the gate's size; moved every frame by the clock
      var bk = scene3("block");
      h.movers.forEach(function(m){
        if(m[0] !== 1 || !bk) return;
        var o = dress(bk.scene.clone(), "tile"); o.scale.set(2*m[4]/T, 0.9, 2*m[5]/T);
        holeGroup.add(o); sliders.push({o: o, m: m});
      });
      var fg = scene3("flag-red");
      if(fg){ var flag = fg.scene.clone(); flag.scale.setScalar(0.45); flag.position.set(V.hole.cup[0]/T, FLOOR_Y - 0.03, V.hole.cup[1]/T); holeGroup.add(flag); r.flag = flag; }
      scatter(holeGroup, h, V.holeIdx);
      scene.add(holeGroup);
      // the sun follows the hole so its shadows cover the whole course
      var cx = (bb[0]+bb[2])/2/T, cz = (bb[1]+bb[3])/2/T, span = Math.max(bb[2]-bb[0], bb[3]-bb[1])/T/2 + 2.6;
      sun.position.set(cx + 3, 8, cz + 4); sun.target.position.set(cx, 0, cz);
      var sc = sun.shadow.camera; sc.left = -span; sc.right = span; sc.top = span; sc.bottom = -span; sc.near = 1; sc.far = 24; sc.updateProjectionMatrix();
      V.order.forEach(function(uid){ r.removePlayer(V.players[uid]); });
      r.size(Math.max(280, wrap.clientWidth || 640), parseInt(cv.style.height, 10) || 400);
    };
    // moving obstacles at the shot clock's phase (they are part of play, so they move under Calm too)
    function placeMovers(ph){
      var BR = GS.C.BLADE_GAP*4;
      blades.forEach(function(b){ b.rotation.z = Math.PI/4 + 2*Math.PI*(ph % BR)/BR; });
      sliders.forEach(function(s){
        var m = s.m, ip = Math.floor(ph), off = GS.slideOff(m, ip % GS.C.CLOCK), off2 = GS.slideOff(m, (ip + 1) % GS.C.CLOCK), u = ph - ip;
        var o = off + (off2 - off)*u;
        s.o.position.set((m[1] + (m[3] ? 0 : o))/T, 0, (m[2] + (m[3] ? o : 0))/T);
      });
    }
    function nameTag(THREE, P){
      var text = String(P.uid === myId() ? "You" : (P.name || "Player")).slice(0, 24);
      var c = document.createElement("canvas"), g = c.getContext("2d"), fs = 34;
      g.font = "700 "+fs+"px system-ui, sans-serif";
      var w = Math.ceil(g.measureText(text).width) + 28, h = fs + 18; c.width = w; c.height = h;
      g.font = "700 "+fs+"px system-ui, sans-serif"; g.textBaseline = "middle"; g.textAlign = "center";
      g.fillStyle = "rgba(15,18,30,0.72)"; var rr = h/2;
      g.beginPath(); g.moveTo(rr, 0); g.lineTo(w-rr, 0); g.arc(w-rr, rr, rr, -Math.PI/2, Math.PI/2); g.lineTo(rr, h); g.arc(rr, rr, rr, Math.PI/2, Math.PI*1.5); g.fill();
      g.fillStyle = "#"+("000000"+(COLORS[P.color % COLORS.length]>>>0).toString(16)).slice(-6); g.beginPath(); g.arc(18, h/2, 7, 0, Math.PI*2); g.fill();
      g.fillStyle = "#ffffff"; g.fillText(text, w/2 + 6, h/2 + 1);
      var tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
      var sp = new THREE.Sprite(new THREE.SpriteMaterial({map: tex, depthTest: false, transparent: true}));
      sp.renderOrder = 10; sp.scale.set(0.26*w/h, 0.26, 1);   // ~0.13 world units tall at the avatar's 0.5 scale
      return sp;
    }
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
      // Name tag over the golfer's head: "You", or the friend's Arena name.
      var tag = nameTag(THREE, P), hb = new THREE.Box3().setFromObject(g.scene);
      if(tag){ tag.position.set(0, hb.max.y + 0.3, 0); obj.add(tag); }
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
      placeMovers(clockNow());
      waters.forEach(function(w){ w.material.opacity = calm ? 0.9 : 0.86 + 0.05*Math.sin(t*1.7); });
      V.order.forEach(function(uid){
        var P = V.players[uid];
        if(!P.mesh) P.mesh = makeAvatar(P);
        var m = P.mesh; if(!m) return;
        m.obj.position.set(P.av.x/T, FLOOR_Y + liftAt(V.hole, P.av.x, P.av.z), P.av.z/T); m.obj.rotation.y = P.av.yaw;
        m.cshadow.position.set(P.av.x/T, FLOOR_Y + 0.002, P.av.z/T);
        setAnim(m, P.av.anim);
        if(m.club){ var sw = P.av.anim === A_SWING && !calm ? Math.max(0, 1 - (t - P.swingAt)/0.6) : 0; m.club.rotation.x = -Math.sin(sw*Math.PI)*0.9; }
        m.mixer.update(dt);
        var b = ballAt(P, t), sink = P.sunk && !P.fly;
        m.ball.visible = !sink; m.bshadow.visible = !sink;
        var ly = liftAt(V.hole, b[0], b[1]);
        m.ball.position.set(b[0]/T, BALL_Y + ly, b[1]/T); m.bshadow.position.set(b[0]/T, FLOOR_Y + ly + 0.002, b[1]/T);
      });
      if(r.flag){ var any = V.order.some(function(u){ var Q = V.players[u]; return Q.sunk && !Q.fly; }); r.flag.position.y = FLOOR_Y - 0.03 + (any && !calm ? 0.08 : 0); }
      // aim arrow
      var P = me();
      if(P && V.state === "address"){
        arrow.visible = true; arrow.position.set(P.ball[0]/T, BALL_Y + liftAt(V.hole, P.ball[0], P.ball[1]), P.ball[1]/T);
        arrow.setDirection(new THREE.Vector3(Math.cos(V.aim.a), 0, Math.sin(V.aim.a)));
        arrow.setLength(0.15 + V.aim.p/100*1.4, 0.08, 0.05);
      } else arrow.visible = false;
      // camera
      var c = V.cam, F = focusPlayer(), tx, tz, dist = c.dist, yaw = c.yaw, ty = 0.15;
      if(F){
        if(F.fly){ var fb = ballAt(F, t); tx = fb[0]/T; tz = fb[1]/T; }
        else if(F === P && V.state === "address"){
          tx = P.ball[0]/T; tz = P.ball[1]/T; dist = Math.min(dist, 1.6);
          // The camera swings round behind the aim, from the keyboard or while you drag
          // (dragging aims on the screen, so turning the camera never moves the aim).
          var want = Math.atan2(Math.cos(V.aim.a), Math.sin(V.aim.a)), dy = Math.atan2(Math.sin(want - c.yaw), Math.cos(want - c.yaw));
          c.yaw += dy*(calm ? 1 : 1 - Math.exp(-(drag ? 4 : 5)*dt));
          yaw = c.yaw; }
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
      ballGeo.dispose(); blobGeo.dispose(); blobMat.dispose(); skyTex.dispose();
      [tinted, snowed].forEach(function(c){ for(var k in c) c[k].dispose(); });
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
      else if(V.state === "address" && /^[0-9]$/.test(k)){ V.aim.p = k === "0" ? 100 : (+k)*10; hudUpdate(); }
      else if(V.state === "address" && (k === "+" || k === "=" || k === "-" || k === "_")){ V.aim.p = clamp(V.aim.p + (k === "+" || k === "=" ? 5 : -5), 1, 100); hudUpdate(); }
      else if(V.state === "address" && (k === "," || k === ".")){ V.aim.a += (k === "," ? -1 : 1)*0.25*Math.PI/180; hudUpdate(); }
      else if(k === "h" || k === "?"){ var gs = gsave(); gs.keysHidden = !gs.keysHidden; api.persist(); renderKeys(); }
      else if(k === "z" || k === "x"){ V.cam.dist = clamp(V.cam.dist*(k === "z" ? 0.9 : 1.1), 1.2, 5); }
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
      if(V.state === "address"){ drag = {on: true, x: e.clientX, y: e.clientY, yaw0: V.cam.yaw}; try { cv.setPointerCapture(e.pointerId); } catch(x){} return; }
      var dx = (w[0] - P.ball[0])/T, dz = (w[1] - P.ball[1])/T;
      if(V.state === "walk" && dx*dx + dz*dz < 0.12) tryAddress();
    });
    cv.addEventListener("pointermove", function(e){
      if(orbit){ V.cam.yaw = orbit.yaw - (e.clientX - orbit.x)*0.004*camSens(); return; }
      if(drag){
        // ignore tiny jitters at the start of a trackpad drag
        if(!drag.moved && Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) < 6) return;
        drag.moved = true;
        if(R3) dragScreen(e);               // 3D: a slingshot on the screen, so the camera can swing with the aim
        else { var w = worldAt(e); if(w) dragTo(w); } }
    });
    cv.addEventListener("pointerup", function(e){
      orbit = null;
      if(!drag) return;
      var d = drag; drag = null;
      if(d.len > 0.06 && V.state === "address") shoot();
    });
    cv.addEventListener("wheel", function(e){
      if(!R3) return;
      e.preventDefault();
      // Trackpads send many small wheel events, mice a few big ones: scale by the actual delta.
      var unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1, s = camSens();
      var dy = clamp(e.deltaY*unit, -60, 60), dx = clamp(e.deltaX*unit, -60, 60);
      if(Math.abs(dy) >= Math.abs(dx)) V.cam.dist = clamp(V.cam.dist*Math.exp(dy*0.0025*s), 1.2, 5);
      else if(!V.cam.over && V.state !== "address") V.cam.yaw -= dx*0.004*s;
    }, {passive: false});
  }
  // 3D drag-to-aim, slingshot style: pull back (down the screen) to putt away from you,
  // sideways to aim. Measured on the screen against the camera's heading when the drag
  // began, not by the ground point under the pointer, so the camera is free to turn and
  // follow the aim while you drag without the aim chasing it.
  function dragScreen(e){
    var P = me(); if(!P) return;
    var dx = e.clientX - drag.x, dy = e.clientY - drag.y, px = Math.sqrt(dx*dx + dy*dy);
    var y0 = drag.yaw0, sx = Math.cos(y0)*dx + Math.sin(y0)*dy, sz = -Math.sin(y0)*dx + Math.cos(y0)*dy;
    var full = Math.max(120, (canvas && canvas.clientHeight || 400)*0.45);
    V.aim.p = clamp(Math.round(px/full*100), 1, 100);
    drag.len = V.aim.p/100*1.5;
    if(px < 4) return;
    V.aim.a = Math.atan2(sz, sx);
    hudUpdate();
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
  V.setHole = function(i){ if(V.mode === "practice" && V.holes.length) setHole(i); };   // smoke tests
  return V;
}

/* ---------- registration: a solo card and a "with friends" card ---------- */
HQV.register({id: "golf", name: "Mini Golf", icon: "⛳", desc: "3D putting on five themed courses",
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
