/* Claude HQ: City play feature playstreet (HQ 3.22): the street reacts to you. Registers with HQV.cityPlay (games/cityplay.js).
 *
 *   reactions   people near a car going faster than FLINCH_V within FLINCH_R m step and hop out of its way; one it
 *               actually reaches dives aside (emit "ram" {what: "person"}): nobody is hurt. A "blast" or "shot" sends
 *               everyone within PANIC_R m running away from it for PANIC_S s, then they walk back to where they were going.
 *               All of it is view-side (npcdraw's setOverride: this frame's drawn rows move), the sim never changes.
 *   knocks      a cafe table, a bin or a stall (citylife.furniture, worldbuild draws them; and cityevents3d's market
 *               stalls) you drive into faster than KNOCK_V tumbles over and lies there instead of stopping you
 *               (through(x, z), asked by hqcity3d's blocked()); emit "ram" {what: "prop"}. Each stands up again after
 *               KNOCK_S s or once you are KNOCK_FAR m away.
 *   snacks      on foot at a food stall or a cafe's tables, E buys a snack (free: no coins, D4): a toast, a snack held
 *               up a moment, and "fed" for FED_S s (your sprint x FED_MUL; kept in ctx.store, this browser only).
 *   moments     a few things going on round the centre, a pure function of (world, seed, local clock): a busker playing
 *               (a small crowd, a quiet tune from the engine's chimes nearby), a broken-down car up on the kerb with its
 *               hazards blinking and its driver beside it, a dog running loose with its owner chasing it. They stand on
 *               footpaths, never on a carriageway (moments(W, seed, ms), momentRows(W, m, ms, N): pure, node-tested).
 * Pure helpers: HQV.playStreet {streets, moments, momentRows, foodSpots, snackOf, flee, KNOCKABLE}. Nothing leaves the
 * machine; nothing here uses Math.random. */
(function(){
"use strict";
var root = typeof window !== "undefined" ? window : self;
var HQV = root.HQV = root.HQV || {};

var FLINCH_V = 12, FLINCH_R = 6, DIVE_R = 1.9, DIVE_V = 3;   // m/s, m: a speeding car's reach, a car that reaches you
var PANIC_R = 25, PANIC_S = 10, PANIC_V = 3.6, PANIC_MAX = 18, BACK_S = 5;   // m, s, m/s, m, s (walking back)
var KNOCK_V = 6, KNOCK_S = 90, KNOCK_FAR = 110, KNOCK_MAX = 24, TUMBLE_S = 0.75;
var KNOCKABLE = {table: 1, bin: 1, stall: 1};
var FED_S = 120, FED_MUL = 1.1, SNACK_R = 2.6, SNACK_GAP = 15;
var MOMENT_SLOT = 1200000, MOMENT_NEAR = 160, MOMENT_CANDS = 40;   // 20 min a moment; drawn within 160 m; picked from the 40 central streets
var MOMENT_IDS = 900000000;          // ids of the moments' people (well above any npcsim id)
var KINDS = [["busker", 2, 9, 21], ["breakdown", 1, 7, 22], ["dog", 2, 7, 20]];   // kind, how many at once, from, to (local hours)
var SNACKS = {
  stall: ["a hot pretzel", "a falafel wrap", "a bag of roasted chestnuts", "a samosa", "a paper cone of chips", "a fruit cup", "a bao bun", "a slice of pizza"],
  table: ["a croissant and a flat white", "a slice of carrot cake", "a cinnamon bun", "an iced latte and a cookie", "a toastie", "a pain au chocolat"]
};
var SAY = {
  busker: ["Any requests? I know three songs.", "Thanks for listening!", "Coins not needed, a smile will do."],
  crowd: ["They're really good, aren't they?", "I could listen all day.", "One more song!"],
  driver: ["Broke down, of all days. The tow truck's on its way.", "Hazards on, bonnet up. Nothing else I can do.", "Don't suppose you know engines?"],
  chaser: ["Biscuit! Come back here!", "Sorry! He's never done this before!", "Somebody grab his lead!"]
};

function hash01(s){ var h = 2166136261 >>> 0; s = String(s); for(var i = 0; i < s.length; i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b) >>> 0; h ^= h >>> 13; return (h >>> 0)/4294967296; }
function rng(a){ a = a >>> 0 || 1; return function(){ a = (a + 0x6D2B79F5) >>> 0; var t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0)/4294967296; }; }
function clamp(v, a, b){ return v < a ? a : v > b ? b : v; }
function hourOf(ms){ return (((ms % 864e5) + 864e5) % 864e5)/36e5; }
function WQ(){ return HQV.world; }
function CL(){ return HQV.cityLife; }

/* ---------- pure: the central streets with footpaths ---------- */
// [{id, P: [{x, y, z}], cum, len, half, walk, c (the carriageway's half), cls}], nearest the centre first: footpaths of
// at least 2 m on centre and civic streets and shopping streets, 50 m and longer (cached per world)
var ST_CACHE = typeof WeakMap === "function" ? new WeakMap() : null;
function streets(W){
  if(!W || !W.edges) return [];
  var out = ST_CACHE && ST_CACHE.get(W);
  if(out) return out;
  out = [];
  var C = CL(), Q = WQ();
  if(!C || !Q) return out;
  W.edges.forEach(function(e){
    var walk = (e.walk | 0)/100, half = (e.width | 0)/200, r = C.road(e.cls);
    if(walk < 2 || r.kind === "fast" || !e.pts || e.pts.length < 6) return;
    var P = [], cum = [0];
    for(var i = 0; i + 2 < e.pts.length; i += 3) P.push({x: e.pts[i]/100, y: e.pts[i + 1]/100, z: e.pts[i + 2]/100});
    for(i = 1; i < P.length; i++) cum.push(cum[i - 1] + Math.hypot(P[i].x - P[i - 1].x, P[i].z - P[i - 1].z));
    var len = cum[cum.length - 1]; if(len < 50) return;
    var mid = P[P.length >> 1], g = "home";
    try { g = C.groupOfName(Q.districtAt(W, mid.x, mid.z).name); } catch(err){ g = "home"; }
    if(!(g === "centre" || g === "civic" || r.kind === "shop")) return;
    out.push({id: e.id, P: P, cum: cum, len: len, half: half, walk: walk, c: half - walk, cls: e.cls, mx: mid.x, mz: mid.z});
  });
  if(out.length){
    var cx = 0, cz = 0; out.forEach(function(s){ cx += s.mx; cz += s.mz; }); cx /= out.length; cz /= out.length;
    out.forEach(function(s){ s.d = Math.hypot(s.mx - cx, s.mz - cz); });
    out.sort(function(a, b){ return a.d - b.d || a.id - b.id; });
  }
  if(ST_CACHE) ST_CACHE.set(W, out);
  return out;
}
// a point s m along street S, lat m left of its a->b (the left of (dx, dz) is (dz, -dx)) -> {x, y, z, ux, uz, lx, lz}
function along(S, s, lat){
  s = clamp(s, 0, S.len);
  var k = 0, P = S.P, C = S.cum; while(k < P.length - 2 && C[k + 1] < s) k++;
  var l = C[k + 1] - C[k] || 1, t = (s - C[k])/l, ux = (P[k + 1].x - P[k].x)/l, uz = (P[k + 1].z - P[k].z)/l;
  return {x: P[k].x + (P[k + 1].x - P[k].x)*t + uz*lat, y: P[k].y + (P[k + 1].y - P[k].y)*t, z: P[k].z + (P[k + 1].z - P[k].z)*t - ux*lat, ux: ux, uz: uz, lx: uz, lz: -ux};
}
function footOk(W, x, z){ var Q = WQ(), s = Q ? Q.surfaceAt(W, x, z) : "sidewalk"; return s !== "road" && s !== "lot" && s !== "water" && s !== "edge"; }

/* ---------- pure: the street moments ---------- */
// what is going on at local ms: [{kind, id, slot, street, s, side, x, y, z, yaw}] (a moment's anchor: the busker, the
// car, the middle of the dog's run), each a pure function of (W, seed, ms); none where its footpath has no room
function moments(W, seed, ms){
  var S = streets(W), out = [], cands = S.slice(0, MOMENT_CANDS);
  if(!cands.length) return out;
  var h = hourOf(ms);
  KINDS.forEach(function(K, ki){
    if(h < K[2] || h >= K[3]) return;
    for(var i = 0; i < K[1]; i++){
      var off = Math.floor(hash01(seed + ":mo:" + K[0] + ":" + i)*MOMENT_SLOT), q = Math.floor((ms - off)/MOMENT_SLOT);
      var g = rng(Math.floor(hash01(seed + ":m:" + K[0] + ":" + i + ":" + q)*4294967296)), st = cands[Math.floor(g()*cands.length)];
      var side = g() < 0.5 ? 1 : -1, s = 16 + g()*Math.max(1, st.len - 32);
      var m = {kind: K[0], id: ki*100 + i, slot: q, street: st.id, s: s, side: side, g: Math.floor(g()*1e6)};
      var lat, p;
      if(K[0] === "breakdown"){
        if(st.walk < 2.4) continue;                                     // no room up on this kerb
        lat = side*(st.c + 0.95);
      } else lat = side*(st.c + st.walk*(K[0] === "busker" ? 0.72 : 0.5));
      p = along(st, s, lat);
      if(!footOk(W, p.x, p.z)) continue;
      m.x = p.x; m.y = WQ() ? WQ().groundAt(W, p.x, p.z, true) : p.y; m.z = p.z;
      m.yaw = K[0] === "breakdown" ? Math.atan2(p.ux*side, p.uz*side) : Math.atan2(-p.lx*side, -p.lz*side);   // the car along the kerb; the busker faces the road
      out.push(m);
    }
  });
  return out;
}
// the people (and the loose dog) of moment m at local ms: npcdraw rows {id, lk (a look among N residents), x, y, z,
// yaw, anim, speed, say, isDog?, role}; the car itself is not a row (the feature draws it)
function momentRows(W, m, ms, N){
  var S = null, all = streets(W), out = [];
  for(var i = 0; i < all.length; i++) if(all[i].id === m.street){ S = all[i]; break; }
  if(!S) return out;
  N = Math.max(1, N | 0);
  var base = MOMENT_IDS + m.id*1000 + (m.slot & 1)*500, Q = WQ();
  function look(j){ return Math.floor(hash01("lk:" + m.street + ":" + m.slot + ":" + m.id + ":" + j)*N); }
  function gy(x, z){ return Q ? Q.groundAt(W, x, z, true) : m.y; }
  function line(kind, j){ var L = SAY[kind]; return L[Math.floor(hash01(kind + ":" + m.g + ":" + j + ":" + Math.floor(ms/600000))*L.length)]; }
  if(m.kind === "busker"){
    out.push({id: base, lk: look(0), x: m.x, y: m.y, z: m.z, yaw: m.yaw, anim: "idle", speed: 0, say: line("busker", 0), role: "busker"});
    // the crowd along the footpath either side, facing the busker
    var n = 3 + (m.g % 3);
    for(var j = 1; j <= n; j++){
      var sd = j & 1 ? 1 : -1, a = m.s + sd*(1.6 + 0.7*Math.ceil(j/2)), lat = m.side*(S.c + S.walk*(0.3 + 0.4*hash01("cl:" + m.g + ":" + j)));
      var p = along(S, a, lat);
      if(!footOk(W, p.x, p.z)) continue;
      out.push({id: base + j, lk: look(j), x: p.x, y: gy(p.x, p.z), z: p.z, yaw: Math.atan2(m.x - p.x, m.z - p.z), anim: "idle", speed: 0, say: line("crowd", j), role: "crowd"});
    }
  } else if(m.kind === "breakdown"){
    var dl = m.side*(S.c + Math.min(S.walk - 0.35, 2.75)), pd = along(S, m.s + 2.6*(m.g & 1 ? 1 : -1), dl);
    if(footOk(W, pd.x, pd.z)) out.push({id: base, lk: look(0), x: pd.x, y: gy(pd.x, pd.z), z: pd.z, yaw: Math.atan2(m.x - pd.x, m.z - pd.z), anim: "idle", speed: 0, say: line("driver", 0), role: "driver"});
  } else if(m.kind === "dog"){
    // round and round a 30 m stretch of footpath (there and back), the owner 3.5 m behind
    var span = Math.max(6, Math.min(30, S.len - 30)), lo = clamp(m.s - span/2, 15, S.len - 15 - span), tt = ms/1000 + (m.g % 1000);   // clear of the junctions
    var pp = function(d){ var M = ((d % (2*span)) + 2*span) % (2*span); return M < span ? {p: M, dir: 1} : {p: 2*span - M, dir: -1}; };
    var lat2 = m.side*(S.c + S.walk*0.5), qd = pp(tt*3.4), qo = pp(tt*3.4 - 3.5);
    var a1 = along(S, lo + qd.p, lat2), a2 = along(S, lo + qo.p, lat2);
    out.push({id: base + 1, lk: 0, x: a1.x, y: gy(a1.x, a1.z), z: a1.z, yaw: Math.atan2(a1.ux*qd.dir, a1.uz*qd.dir), anim: "walk", speed: 3.4, isDog: 1, role: "dog"});
    out.push({id: base, lk: look(0), x: a2.x, y: gy(a2.x, a2.z), z: a2.z, yaw: Math.atan2(a2.ux*qo.dir, a2.uz*qo.dir), anim: "jog", speed: 3.4, say: line("chaser", 0), role: "chaser"});
  }
  return out;
}

/* ---------- pure: snacks, fleeing ---------- */
// the food stalls and cafe tables (citylife.furniture): [{kind: "stall" | "table", x, z, yaw, open: [from, to]}]
var FOOD_CACHE = typeof WeakMap === "function" ? new WeakMap() : null;
function foodSpots(W){
  if(!W) return [];
  var out = FOOD_CACHE && FOOD_CACHE.get(W);
  if(out) return out;
  out = [];
  var C = CL();
  if(C && C.furniture){ try { C.furniture(W).forEach(function(f){ if(f.kind === "stall" || f.kind === "table") out.push({kind: f.kind, x: f.x, z: f.z, yaw: f.yaw, open: f.kind === "stall" ? [8, 20] : [7, 23]}); }); } catch(e){ out = []; } }
  if(FOOD_CACHE) FOOD_CACHE.set(W, out);
  return out;
}
// what spot sells today (a pure pick by the spot and the local day)
function snackOf(seed, spot, ms){
  var L = SNACKS[spot.kind] || SNACKS.stall;
  return L[Math.floor(hash01(seed + ":snack:" + Math.round(spot.x*10) + ":" + Math.round(spot.z*10) + ":" + Math.floor(ms/864e5))*L.length)];
}
// how far (m) someone has run from a blast age s ago (out at PANIC_V for PANIC_S s, at most PANIC_MAX, then back over BACK_S)
function flee(age){
  age = +age || 0;
  if(age <= 0) return 0;
  if(age < PANIC_S) return Math.min(PANIC_MAX, PANIC_V*age);
  var top = Math.min(PANIC_MAX, PANIC_V*PANIC_S);
  return age < PANIC_S + BACK_S ? top*(1 - (age - PANIC_S)/BACK_S) : 0;
}

/* ---------- the feature ---------- */
function create(ctx){
  ctx = ctx || {};
  var THREE = ctx.THREE, S = ctx.scene, W = ctx.W, seed = String(ctx.seed != null ? ctx.seed : "city"), dead = false;
  var F = {ms: Date.now(), local: 0, me: null, motion: null, cam: null};   // the last frame's
  var group = THREE && S ? new THREE.Group() : null;
  if(group){ group.name = "playstreet"; S.add(group); }
  var reacts = {}, blasts = [], knocks = [], rammed = {}, lastFed = 0, snackFx = null, fedShown = -1, musicAt = 0, beat = 0;
  var momList = [], momKey = null, momMesh = {};
  var food = [], foodGrid = {};
  try { food = foodSpots(W); } catch(e){ food = []; }
  food.forEach(function(sp, i){ var k = Math.floor(sp.x/8) + "," + Math.floor(sp.z/8); (foodGrid[k] = foodGrid[k] || []).push(i); });
  function now(){ return Date.now(); }
  function nres(){ return Math.max(1, (ctx.nsim && ctx.nsim.population) | 0); }
  function wb(){ return typeof ctx.wb === "function" ? ctx.wb() : null; }
  function gy(x, z){ try { return ctx.groundY ? ctx.groundY(x, z) : 0; } catch(e){ return 0; } }
  function fast(){
    var m = F.motion;
    return !!(m && m.ride && !m.air && !m.boat && (+m.speed || 0) > KNOCK_V);
  }
  function near(x, z, r){ var me = F.me; return !!(me && Math.hypot(x - me.x, z - me.z) < r); }

  /* ----- moments: what is on near the camera, refreshed every 2 s ----- */
  function refreshMoments(local){
    var k = Math.floor(local/2000);
    if(k === momKey) return;
    momKey = k;
    var all = [];
    try { all = moments(W, seed, local); } catch(e){ all = []; }
    var cam = F.cam || F.me;
    momList = cam ? all.filter(function(m){ return Math.hypot(m.x - cam.x, m.z - cam.z) < MOMENT_NEAR + 40; }) : [];
    var want = {};
    momList.forEach(function(m){ want[m.kind + ":" + m.id + ":" + m.slot] = m; });
    Object.keys(momMesh).forEach(function(k2){ if(!want[k2]){ dropMesh(momMesh[k2]); delete momMesh[k2]; } });
    Object.keys(want).forEach(function(k2){ if(!momMesh[k2]) momMesh[k2] = momentMesh(want[k2]); });
  }
  function box(w, h, d, col, basic){
    var M = basic ? THREE.MeshBasicMaterial : THREE.MeshLambertMaterial;
    return new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new M({color: col}));
  }
  function dropMesh(o){
    if(!o || !o.g) return;
    if(o.g.parent) o.g.parent.remove(o.g);
    o.g.traverse(function(n){ if(n.isMesh && !n.shared){ if(n.geometry) n.geometry.dispose(); if(n.material) n.material.dispose(); } });
  }
  // the car (a broken-down one: body, cabin, wheels, the bonnet up, four hazard lamps) or the busker's guitar
  function momentMesh(m){
    if(!group) return null;
    var g = new THREE.Group(), o = {g: g, m: m, lamps: []};
    if(m.kind === "breakdown"){
      var cols = [0x3d6fd1, 0xc8326e, 0xf2f2ee, 0x2f3b4c, 0x6fd38a, 0xd8443a], col = cols[m.g % cols.length];
      var body = box(1.8, 0.6, 4.2, col); body.position.y = 0.55; g.add(body);
      var cab = box(1.6, 0.55, 2.1, col); cab.position.set(0, 1.12, -0.25); g.add(cab);
      var glass = box(1.62, 0.36, 1.6, 0x2a3442); glass.position.set(0, 1.16, -0.2); g.add(glass);
      var bonnet = box(1.7, 0.06, 1.2, col); bonnet.position.set(0, 1.25, 1.7); bonnet.rotation.x = -0.9; g.add(bonnet);
      [[-0.85, 1.35], [0.85, 1.35], [-0.85, -1.35], [0.85, -1.35]].forEach(function(w){
        var wh = new THREE.Mesh(new THREE.CylinderGeometry(0.33, 0.33, 0.24, 12), new THREE.MeshLambertMaterial({color: 0x1f1f24}));
        wh.rotation.z = Math.PI/2; wh.position.set(w[0], 0.33, w[1]); g.add(wh);
      });
      [[-0.75, 0.62, 2.11], [0.75, 0.62, 2.11], [-0.75, 0.62, -2.11], [0.75, 0.62, -2.11]].forEach(function(p){
        var l = box(0.22, 0.12, 0.05, 0xffa21a, true); l.position.set(p[0], p[1], p[2]); g.add(l); o.lamps.push(l);
      });
      g.position.set(m.x, m.y + 0.12, m.z); g.rotation.y = m.yaw;    // up on the kerb
      g.rotation.z = -m.side*0.035;
    } else if(m.kind === "busker"){
      var gb = box(0.34, 0.42, 0.1, 0xb07a3a); gb.position.set(0.05, 1.0, 0.25); gb.rotation.z = 0.5; g.add(gb);
      var neck = box(0.05, 0.55, 0.04, 0x5a3a1a); neck.position.set(-0.17, 1.33, 0.25); neck.rotation.z = 0.5; g.add(neck);
      var cse = box(0.9, 0.12, 0.34, 0x2f2f36); cse.position.set(0.1, 0.06, 0.75); g.add(cse);   // the open case in front
      g.position.set(m.x, m.y, m.z); g.rotation.y = m.yaw;
    } else return null;
    group.add(g);
    return o;
  }
  // npcdraw extras: the moments' people and the loose dogs near the camera
  function extras(tMs){
    if(dead || !momList.length) return null;
    var out = [], N = nres();
    momList.forEach(function(m){ try { out = out.concat(momentRows(W, m, tMs, N)); } catch(e){} });
    return out;
  }

  /* ----- reactions: view-side moves of this frame's drawn rows ----- */
  function setReact(r, kind, ux, uz, t, extra){
    var cur = reacts[r.id];
    if(cur && cur.kind === "panic" && kind !== "dive" && !(kind === "panic" && t > cur.t0)) return cur;
    if(cur && cur.kind === kind && t - cur.t0 < 1500) return cur;
    reacts[r.id] = {kind: kind, ux: ux, uz: uz, t0: t, d: extra || 0, ox: 0, oz: 0};
    return reacts[r.id];
  }
  function override(list, tMs, dt, player){
    if(dead) return;
    var t = now(), me = F.me, m = F.motion, spd = m && m.ride && !m.air && !m.boat ? +m.speed || 0 : 0;
    blasts = blasts.filter(function(b){ return t - b.t < (PANIC_S + BACK_S)*1000; });
    var hx = me ? Math.sin(+me.yaw || 0) : 0, hz = me ? Math.cos(+me.yaw || 0) : 1;
    for(var i = 0; i < list.length; i++){
      var r = list[i]; if(!r || r.isDog || r.anim === "drive") continue;
      // a blast or a shot within PANIC_R: run from it
      for(var b = 0; b < blasts.length; b++){
        var B = blasts[b], bx = r.x - B.x, bz = r.z - B.z, bd = Math.hypot(bx, bz);
        if(bd < PANIC_R && (!reacts[r.id] || reacts[r.id].kind !== "panic" || reacts[r.id].t0 < B.t)){
          if(bd < 1e-3){ bx = Math.sin(r.id); bz = Math.cos(r.id); bd = 1; }
          setReact(r, "panic", bx/bd, bz/bd, B.t);
        }
      }
      // a car: out of its way (or diving, when it reaches them)
      if(me && spd > DIVE_V){
        var dx = r.x - me.x, dz = r.z - me.z, d = Math.hypot(dx, dz);
        if(d < FLINCH_R){
          var lat = dx*hz - dz*hx, sg = lat >= 0 ? 1 : -1, ux = hz*sg, uz = -hx*sg;     // the side of the car's line they are on
          if(d < DIVE_R){
            setReact(r, "dive", ux, uz, t);
            if(!rammed[r.id] || t - rammed[r.id] > 5000){ rammed[r.id] = t; if(ctx.emit) ctx.emit("ram", {what: "person", x: r.x, z: r.z, speed: spd, id: r.id}); }
          } else if(spd > FLINCH_V && (dx*hx + dz*hz) > -2) setReact(r, "flinch", ux, uz, t);
        }
      }
      var R = reacts[r.id]; if(!R) continue;
      var age = (t - R.t0)/1000, dist = 0, hop = 0, anim = null;
      if(R.kind === "panic"){
        dist = flee(age); if(age >= PANIC_S + BACK_S){ delete reacts[r.id]; continue; }
        anim = age < PANIC_S && dist < PANIC_MAX - 0.01 ? "jog" : age < PANIC_S ? "idle" : "walk";
      } else if(R.kind === "flinch"){
        if(age > 3.5){ delete reacts[r.id]; continue; }
        dist = age < 0.45 ? 2.2*age/0.45 : age < 2.5 ? 2.2 : 2.2*(1 - (age - 2.5)/1);
        hop = age < 0.45 ? Math.sin(Math.PI*age/0.45)*0.35 : 0; anim = age < 0.45 ? "jog" : age < 2.5 ? "idle" : "walk";
      } else {
        if(age > 5){ delete reacts[r.id]; continue; }
        dist = age < 0.5 ? 3.2*age/0.5 : age < 3.5 ? 3.2 : 3.2*(1 - (age - 3.5)/1.5);
        hop = age < 0.5 ? Math.sin(Math.PI*age/0.5)*0.55 : 0; anim = age < 0.5 ? "jog" : age < 3.5 ? "idle" : "walk";
      }
      var ox = R.ux*dist, oz = R.uz*dist;
      // not into a building or the water: shorten the step until it is somewhere to stand
      if(W && WQ() && dist > 0.5){
        for(var tries = 0; tries < 3; tries++){
          var sf = WQ().surfaceAt(W, r.x + ox, r.z + oz);
          if(sf !== "lot" && sf !== "water" && sf !== "edge") break;
          ox *= 0.5; oz *= 0.5;
        }
      }
      r.x += ox; r.z += oz; r.y = (+r.y || 0) + hop;
      if(anim){
        r.anim = anim;
        if(anim === "jog"){ r.speed = PANIC_V; r.yaw = Math.atan2(R.ux, R.uz); }
        else if(anim === "walk"){ r.speed = 1.3; r.yaw = Math.atan2(-R.ux, -R.uz); }
        else { r.speed = 0; if(R.kind === "panic") r.yaw = Math.atan2(-R.ux, -R.uz); }   // looking back at it
      }
      if(r.ax != null){ r.ax = r.x; r.az = r.z; }
    }
    // drop the ones nobody drew for a while
    if((t/1000 | 0) % 5 === 0){ Object.keys(reacts).forEach(function(k){ var R2 = reacts[k]; if(t - R2.t0 > 20000) delete reacts[k]; }); }
  }
  if(ctx.ndraw && ctx.ndraw.setExtras){ ctx.ndraw.setExtras(extras); ctx.ndraw.setOverride(override); }

  /* ----- knocks ----- */
  function stallGroup(st){
    var g = new THREE.Group(), cols = [0xd8443a, 0xe6b422, 0x5aa040];
    var counter = box(2.6, 0.85, 0.75, 0xb08a5a); counter.position.set(0, 0.43, 0.7); g.add(counter);
    var canopy = box(2.8, 0.07, 2.4, st.col != null ? st.col : 0xd8443a); canopy.position.set(0, 2.3, 0.1); g.add(canopy);
    [[-1.3, -1.0], [1.3, -1.0], [-1.3, 1.0], [1.3, 1.0]].forEach(function(c){ var p = box(0.07, 2.3, 0.07, 0x6a6f76); p.position.set(c[0], 1.15, c[1]); g.add(p); });
    cols.forEach(function(c, i){ var cr = box(0.6, 0.18, 0.45, c); cr.position.set(-0.8 + 0.8*i, 1.0, 0.7); g.add(cr); });
    return g;
  }
  function knock(o, src, key, piece){
    var t = now(), me = F.me, yaw = me ? +me.yaw || 0 : 0, spd = F.motion ? +F.motion.speed || 0 : 0;
    var outer = group ? new THREE.Group() : null, pivot = outer ? new THREE.Group() : null;
    if(outer){
      outer.position.set(o.x, (o.y != null ? o.y : gy(o.x, o.z)), o.z); outer.rotation.y = yaw;
      outer.add(pivot);
      if(piece){ piece.rotation.y = (o.yaw || 0) - yaw; pivot.add(piece); }
      group.add(outer);
    }
    var K = {key: key, src: src, o: o, t0: t, yaw: yaw, slide: Math.min(4.5, spd*0.28), r: o.kind === "bin" ? 0.27 : o.kind === "table" ? 0.45 : 0.9,
             outer: outer, pivot: pivot, piece: piece, x0: o.x, z0: o.z, y0: outer ? outer.position.y : 0};
    knocks.push(K);
    while(knocks.length > KNOCK_MAX) unknock(knocks[0]);
    if(ctx.emit) ctx.emit("ram", {what: "prop", kind: o.kind, x: o.x, z: o.z, speed: spd});
    var E = HQV.engine; if(E && E.sfxAt){ try { E.sfxAt("hit", {x: o.x, y: K.y0 + 0.5, z: o.z}, {kind: "door"}); } catch(e){} }
    return K;
  }
  function unknock(K){
    var i = knocks.indexOf(K); if(i >= 0) knocks.splice(i, 1);
    if(K.outer && K.outer.parent) K.outer.parent.remove(K.outer);
    if(K.piece){
      if(K.src === "furn"){ if(K.piece.dispose) K.piece.dispose(); }
      else K.piece.traverse(function(n){ if(n.isMesh){ n.geometry.dispose(); n.material.dispose(); } });
    }
    if(K.src === "furn"){ var B = wb(); if(B && B.furnitureKnock) B.furnitureKnock(K.o, false); }
    else if(K.src === "cev" && ctx.cev && ctx.cev.unknock) ctx.cev.unknock(K.key);
  }
  function stepKnocks(){
    var t = now(), cam = F.cam || F.me;
    knocks.slice().forEach(function(K){
      var age = (t - K.t0)/1000;
      if(age > KNOCK_S || (cam && Math.hypot(K.x0 - cam.x, K.z0 - cam.z) > KNOCK_FAR)){ unknock(K); return; }
      if(!K.outer) return;
      var f = Math.min(1, age/TUMBLE_S), e = 1 - (1 - f)*(1 - f), a = (Math.PI/2)*e, fx = Math.sin(K.yaw), fz = Math.cos(K.yaw);
      K.pivot.rotation.x = a;
      K.outer.position.set(K.x0 + fx*K.slide*e, K.y0 + Math.sin(a)*K.r*0.9 + (f < 1 ? Math.sin(Math.PI*f)*0.25 : 0), K.z0 + fz*K.slide*e);
    });
  }
  // hqcity3d's blocked() asks: the furniture or market stall at (x, z) gives way when you drive into it fast
  function through(x, z){
    if(dead || !fast() || !near(x, z, 6)) return false;
    var B = wb(), o = B && B.furnitureNear ? B.furnitureNear(x, z, 0) : null;
    if(o){
      if(!KNOCKABLE[o.kind]) return false;
      if(!B.furnitureKnock(o, true)) return false;
      knock({kind: o.kind, x: o.x, y: o.y, z: o.z, yaw: o.yaw, c: o.c}, "furn", B.furnitureKey ? B.furnitureKey(o) : null, group && B.furnitureMesh ? B.furnitureMesh(o) : null);
      return true;
    }
    if(ctx.cev && ctx.cev.knockAt){
      var st = null; try { st = ctx.cev.knockAt(x, z); } catch(e){ st = null; }
      if(st){ knock({kind: "stall", x: st.x, y: st.y, z: st.z, yaw: st.yaw}, "cev", st.key, group ? stallGroup(st) : null); return true; }
    }
    return false;
  }

  /* ----- snacks ----- */
  function foodNear(x, z){
    var best = null, bd = SNACK_R*SNACK_R;
    for(var gx = Math.floor((x - SNACK_R)/8); gx <= Math.floor((x + SNACK_R)/8); gx++)
      for(var gz = Math.floor((z - SNACK_R)/8); gz <= Math.floor((z + SNACK_R)/8); gz++){
        var L = foodGrid[gx + "," + gz]; if(!L) continue;
        for(var i = 0; i < L.length; i++){ var sp = food[L[i]], d = (sp.x - x)*(sp.x - x) + (sp.z - z)*(sp.z - z); if(d < bd){ bd = d; best = sp; } }
      }
    return best;
  }
  function onFoot(){ var m = F.motion; return !m || !m.ride; }
  function isOpen(sp, local){ var h = hourOf(local); return h >= sp.open[0] && h < sp.open[1]; }
  function localNow(){ try { return ctx.local ? ctx.local(Date.now()) : Date.now(); } catch(e){ return Date.now(); } }
  function prompt(p){
    if(dead || !p || !onFoot()) return null;
    var sp = foodNear(+p.x || 0, +p.z || 0); if(!sp) return null;
    var local = localNow();
    if(!isOpen(sp, local)) return (sp.kind === "table" ? "Cafe" : "Stall") + " closed: opens at " + sp.open[0] + ":00";
    return "E  " + (sp.kind === "table" ? "Order " : "Buy ") + snackOf(seed, sp, local) + " (free)";
  }
  function fedUntil(){ var v = ctx.store && ctx.store.get ? +ctx.store.get("streetFedUntil", 0) : 0; return isFinite(v) ? v : 0; }
  function use(p){
    if(dead || !p || !onFoot()) return false;
    var sp = foodNear(+p.x || 0, +p.z || 0); if(!sp) return false;
    var local = localNow(), t = now();
    if(!isOpen(sp, local)){ if(ctx.say) ctx.say("Closed for now. It opens at " + sp.open[0] + ":00."); return true; }
    if(t - lastFed < SNACK_GAP*1000){ if(ctx.say) ctx.say("You're still full from the last one."); return true; }
    lastFed = t;
    var item = snackOf(seed, sp, local);
    if(ctx.store && ctx.store.set) ctx.store.set("streetFedUntil", t + FED_S*1000);
    if(ctx.say) ctx.say("You enjoy " + item + ". Fed: you sprint a little faster for " + Math.round(FED_S/60) + " minutes.");
    if(ctx.emit) ctx.emit("snack", {x: sp.x, z: sp.z, kind: sp.kind});
    snackFxStart();
    return true;
  }
  function snackFxStart(){
    if(!group) return;
    if(snackFx){ group.remove(snackFx.g); snackFx.g.traverse(function(n){ if(n.isMesh){ n.geometry.dispose(); n.material.dispose(); } }); }
    var g = new THREE.Group(), cone = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.26, 10), new THREE.MeshLambertMaterial({color: 0xd9a35a}));
    cone.rotation.x = Math.PI; g.add(cone);
    var top = new THREE.Mesh(new THREE.SphereGeometry(0.1, 10, 8), new THREE.MeshLambertMaterial({color: 0xf4e3c8})); top.position.y = 0.16; g.add(top);
    group.add(g); snackFx = {g: g, t0: now()};
  }
  function stepSnack(){
    var t = now();
    if(snackFx){
      var age = (t - snackFx.t0)/1000, me = F.me;
      if(age > 2.6 || !me){ group.remove(snackFx.g); snackFx.g.traverse(function(n){ if(n.isMesh){ n.geometry.dispose(); n.material.dispose(); } }); snackFx = null; }
      else {
        var fx = Math.sin(+me.yaw || 0), fz = Math.cos(+me.yaw || 0), sc = age < 1.6 ? 1 : Math.max(0.05, 1 - (age - 1.6));   // eaten: it shrinks away
        snackFx.g.position.set(me.x + fx*0.35, (+me.y || 0) + 1.25 + (ctx.calm && ctx.calm() ? 0 : Math.sin(age*7)*0.04), me.z + fz*0.35);
        snackFx.g.scale.setScalar(sc);
      }
    }
    var left = Math.ceil((fedUntil() - t)/1000);
    if(left > 0){
      if(left !== fedShown){ fedShown = left; if(ctx.hud) ctx.hud.set("fed", "Fed: sprint +10%  " + Math.floor(left/60) + ":" + (left % 60 < 10 ? "0" : "") + (left % 60), {colour: "#ffd27a"}); }
    } else if(fedShown !== -1){ fedShown = -1; if(ctx.hud) ctx.hud.clear("fed"); }
  }

  /* ----- the moments' meshes and the busker's tune ----- */
  function stepMoments(local){
    refreshMoments(local);
    var t = now(), calm = !!(ctx.calm && ctx.calm()), on = calm || Math.floor(t/600) % 2 === 0;
    Object.keys(momMesh).forEach(function(k){ var o = momMesh[k]; if(o) o.lamps.forEach(function(l){ l.visible = on; }); });
    // a chime now and then near a busker (the engine's own short notes, as an ambient source: quiet, and off at 0%)
    var me = F.me, E = HQV.engine;
    if(!me || !E || !E.sfxAt || t < musicAt) return;
    for(var i = 0; i < momList.length; i++){
      var m = momList[i]; if(m.kind !== "busker" || Math.hypot(m.x - me.x, m.z - me.z) > 22) continue;
      var pat = ["sink", "ui", "ui", "sink", "ui", "sink", "ui", "ui"];
      try { E.sfxAt(pat[beat % pat.length], {x: m.x, y: m.y + 1.2, z: m.z}, {kind: "fountain", gain: 0.5}); } catch(e){}
      beat++; musicAt = t + 520; return;
    }
    musicAt = t + 1000;
  }

  return {
    update: function(dt, f){
      if(dead) return;
      f = f || {};
      F.ms = f.ms || Date.now(); F.local = f.local != null ? f.local : F.ms; F.me = f.me || null; F.motion = f.motion || null; F.cam = f.cam && f.cam.x != null ? f.cam : f.me || null;
      stepKnocks();
      stepSnack();
      try { stepMoments(F.local); } catch(e){}
    },
    // the broken-down car is solid (you walk or drive round it)
    blocked: function(x, z){
      for(var k in momMesh){
        var o = momMesh[k]; if(!o || o.m.kind !== "breakdown") continue;
        var m = o.m, dx = x - m.x, dz = z - m.z, s = Math.sin(m.yaw), c = Math.cos(m.yaw);
        if(Math.abs(dx*s + dz*c) <= 2.15 && Math.abs(dx*c - dz*s) <= 0.95) return true;
      }
      return false;
    },
    through: through,
    prompt: prompt,
    use: use,
    sprintMul: function(){ return now() < fedUntil() ? FED_MUL : 1; },
    on: function(kind, d){
      d = d || {};
      if((kind === "blast" || kind === "shot") && isFinite(+d.x) && isFinite(+d.z)){
        blasts.push({x: +d.x, z: +d.z, t: now()});
        if(blasts.length > 8) blasts.shift();
      }
    },
    // for tools and tests
    state: function(){ return {knocked: knocks.length, reacting: Object.keys(reacts).length, blasts: blasts.length, moments: momList.length, fed: now() < fedUntil()}; },
    dispose: function(){
      if(dead) return;
      knocks.slice().forEach(unknock);
      Object.keys(momMesh).forEach(function(k){ dropMesh(momMesh[k]); });
      momMesh = {};
      if(snackFx && group){ group.remove(snackFx.g); snackFx = null; }
      if(ctx.ndraw && ctx.ndraw.setExtras){ ctx.ndraw.setExtras(null); ctx.ndraw.setOverride(null); }
      if(ctx.hud) ctx.hud.clear("fed");
      if(group && group.parent) group.parent.remove(group);
      dead = true;
    }
  };
}

HQV.playStreet = {streets: streets, moments: moments, momentRows: momentRows, foodSpots: foodSpots, snackOf: snackOf, flee: flee, along: along,
                  KNOCKABLE: KNOCKABLE, KNOCK_V: KNOCK_V, FLINCH_V: FLINCH_V, PANIC_R: PANIC_R, PANIC_S: PANIC_S, FED_MUL: FED_MUL, FED_S: FED_S,
                  MOMENT_IDS: MOMENT_IDS, create: create};
if(HQV.cityPlay && HQV.cityPlay.register) HQV.cityPlay.register({id: "playstreet", order: 40, create: create});
})();
