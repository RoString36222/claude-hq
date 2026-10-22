/* Claude HQ 3.2: landmarks and an amusement park in the 3D City (HQV.hqSpectacle; games/hqcity3d.js wires it in).
 *
 * claim(W, tier)   Decide, once per world doc, what stands where; pure and deterministic (tests/test_hqspectacle.py).
 *   The park: the largest park-district block with no lots and no sites on it, at least PARK_MIN m a side, shrunk
 *   until no road runs inside it. It becomes a site {kind: "funpark"} so the trees keep off it (world.js trees()
 *   skips sites), the residents count it as a park (npcsim PARK_SITE) and Go to lists it (hqnav KINDS).
 *   Landmarks: up to MAX_MARKS of the biggest building lots in the downtown / finance / office / commercial / tech
 *   districts, LANDMARK_GAP m apart and clear of the park. Each lot's kind becomes "landmark", so worldgeom draws
 *   no generic tower there and world.js no longer blocks it (create() blocks the landmark's own footprint), and
 *   a named site {kind: "landmark"} on it puts it in Go to. Nothing here touches the server's world generator:
 *   every client claims the same blocks and lots from the same doc.
 *   -> W.spectacle = {park: {x, z, w, d, rot, block, gate: {x, z}} | null, marks: [{lot, x, z, s, rot, type, name}]}
 *
 * coasterPlan(a, b, hm)   the coaster's control points in the park's frame (pure; the tests check its clearances).
 *
 * create(c, W, o) -> the drawn landmarks and park, and riding them (needs THREE through hq3d's ctx):
 *   o: {scene, ground(x, z), owner (the city's owner id), city() (its CityState), say(text), avatar()}
 *   The park is free for everyone (HQ 3.6): no tickets, the turnstile always open.
 *   -> {g, update(t, dt, cam), setNight(n), blocked(x, z), use(p), carry(), camPose(), riding(), destroy()}
 *
 * The ticket is a "park" fare on the city (POST /api/arena/city/:owner/fare): server-authoritative and paid to that
 * city's treasury, once per UTC day. An Arena that does not sell park passes yet (its CityState has no `park`)
 * opens the gate as a free preview instead of locking a park nobody could enter.
 *
 * Rides run on the shared UTC clock like the trains, so everyone sees the same coaster at the same moment, and
 * riding one is following a seat on that motion for a lap or a cycle. In Calm (and reduced motion) the camera
 * watches the ride from the platform instead of riding it (a first-person coaster is a vestibular hazard), and
 * nothing blinks or chases.
 *
 * Textures: games/city/ (CC0 from ambientCG and Poly Haven; LICENSE-assets.txt there).
 */
(function(){
"use strict";
var root = typeof window !== "undefined" ? window : globalThis;
var HQV = root.HQV = root.HQV || {};
var PI = Math.PI, TAU = PI*2, G = 9.81;

var PARK_MIN = 70, PARK_INSET = 7, MAX_MARKS = 8, LANDMARK_GAP = 170, MARK_MIN = 16;
var MARK_DISTRICTS = {downtown: 1, finance: 1, office: 1, commercial: 1, tech: 1};
var TYPES = ["twist", "spire", "lantern", "twins", "needle", "regent"];
var NAMES = {twist: "The Helix", spire: "Aurora Spire", lantern: "The Lantern", twins: "Gemini Towers",
             needle: "Beacon Tower", regent: "The Regent"};
var PARK_NAME = "Skyline Park";
// [3.11.1] fireworks are heard only within BOOM_M of the camera, fading to nothing at that edge
var BOOM_M = 1000;
function boomVol(dist){ dist = +dist; return isFinite(dist) && dist >= 0 && dist < BOOM_M ? 0.55*(1 - dist/BOOM_M) : 0; }

function hash32(s){
  var h = 0x811c9dc5; s = String(s);
  for(var i = 0; i < s.length; i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
function clamp(v, a, b){ return v < a ? a : (v > b ? b : v); }
function lerp(a, b, k){ return a + (b - a)*k; }
function ease(t){ t = clamp(t, 0, 1); return t*t*(3 - 2*t); }
function angOf(front, facing){
  if(front && front.length === 2 && (front[0] || front[1])) return Math.atan2(front[0], front[1]);
  return facing === "south" ? PI : facing === "east" ? PI/2 : facing === "west" ? -PI/2 : 0;
}

// The largest axis-aligned rectangle inside block b that no road (pavements and a margin included) or river
// crosses: the block rasterised into CELL m cells, then the maximal-rectangle histogram sweep. A block is a
// polygon whose bounding box roads cut into from any side, so shrinking the box about its middle is not enough.
var CELL = 3, ROAD_MARGIN = 2.5, EDGE = 2;
function inPoly(P, x, z){
  var c = false;
  for(var i = 0, j = P.length - 1; i < P.length; j = i++){
    var xi = P[i][0], zi = P[i][1], xj = P[j][0], zj = P[j][1];
    if((zi > z) !== (zj > z) && x < (xj - xi)*(z - zi)/(zj - zi) + xi) c = !c;
  }
  return c;
}
function freeRect(W, b, Q){
  if(!Q || !Q.nearestRoad) return null;
  var x0 = (b.x - b.w/2)/100, z0 = (b.z - b.d/2)/100, nx = Math.floor(b.w/100/CELL), nz = Math.floor(b.d/100/CELL);
  var poly = (b.poly || []).map(function(p){ return [p[0]/100, p[1]/100]; }), h = new Array(nx), best = null;
  for(var i = 0; i < nx; i++) h[i] = 0;
  function free(x, z){
    if(poly.length >= 3 && !inPoly(poly, x, z)) return false;
    var r = Q.nearestRoad(W, x, z, 40);
    if(r && r.dist <= r.half + ROAD_MARGIN) return false;
    return !(W.river && Q.riverAt && Q.riverAt(W, x, z));
  }
  for(var k = 0; k < nz; k++){
    var zc = z0 + (k + 0.5)*CELL;
    for(i = 0; i < nx; i++) h[i] = free(x0 + (i + 0.5)*CELL, zc) ? h[i] + 1 : 0;
    var st = [];
    for(i = 0; i <= nx; i++){
      var hi = i < nx ? h[i] : 0;
      while(st.length && h[st[st.length - 1]] >= hi){
        var top = st.pop(), hh = h[top], left = st.length ? st[st.length - 1] + 1 : 0, ww = i - left;
        var wm = ww*CELL - 2*EDGE, dm = hh*CELL - 2*EDGE;
        if(Math.min(wm, dm) > 0 && (!best || wm*dm > best.w*best.d))
          best = {x: x0 + (left + ww/2)*CELL, z: zc + CELL/2 - hh*CELL/2, w: wm, d: dm};
      }
      st.push(i);
    }
  }
  if(best){                                           // no longer than 2.2 to 1: the layout is drawn for that
    if(best.d > best.w*2.2) best.d = best.w*2.2;
    if(best.w > best.d*2.2) best.w = best.d*2.2;
  }
  return best;
}

/* ---------- claim: what stands where (pure) ---------- */
function claim(W, tier, Q){
  if(!W) return null;
  if(W.spectacle) return W.spectacle;
  Q = Q || HQV.world;
  tier = tier == null ? 5 : tier | 0;
  var leg = (W.districts && W.districts.legend) || [], out = {park: null, marks: []};
  var used = {};
  (W.lots || []).forEach(function(l){ if(l) used[l.block] = 1; });
  (W.sites || []).forEach(function(s){ if(s) used[s.block] = 1; });
  function shown(o){ return o.min_tier == null || (o.min_tier | 0) <= tier; }
  // a site's y is its ground in cm (residents and traffic read it); the terrain's, since these sites are no pads
  function hCm(x, z){ return Q && Q.heightCm ? Q.heightCm(W, Math.round(x*100), Math.round(z*100)) | 0 : 0; }

  // the park: the largest empty park block
  var best = null;
  (W.blocks || []).forEach(function(b){
    if(!b || leg[b.district] !== "park" || used[b.id] || !shown(b)) return;
    if(Math.min(b.w, b.d)/100 < PARK_MIN) return;
    // ranked by the clear rectangle inside it, not the block: roads can cut a big block down
    var R = freeRect(W, b, Q); if(!R || Math.min(R.w, R.d) < PARK_MIN - 2*PARK_INSET) return;
    var a = R.w*R.d;
    if(!best || a > best.a || (a === best.a && b.id < best.b.id)) best = {b: b, a: a, R: R};
  });
  if(best){
    var b = best.b, R = best.R, cx = R ? R.x : 0, cz = R ? R.z : 0, w = R ? R.w : 0, d = R ? R.d : 0;
    if(R && Math.min(w, d) >= PARK_MIN - 2*PARK_INSET){
      // the long axis is the park's local z; the gate is on the short side nearer a road
      var longZ = d >= w, lw = longZ ? w : d, ld = longZ ? d : w;
      var ends = longZ ? [[0, -1], [0, 1]] : [[-1, 0], [1, 0]];
      var pick = ends.map(function(e){
        var x = cx + e[0]*ld/2, z = cz + e[1]*ld/2, r = Q && Q.nearestRoad ? Q.nearestRoad(W, x, z, 200) : null;
        var dist = r ? r.dist : 1e9;
        return {e: e, d: dist};
      }).sort(function(p, q){ return p.d - q.d || p.e[0] - q.e[0] || p.e[1] - q.e[1]; })[0].e;
      var rot = Math.atan2(-pick[0], -pick[1]);       // local -z points at the gate
      out.park = {x: cx, z: cz, w: lw, d: ld, rot: rot, block: b.id,
                  gate: {x: cx + pick[0]*ld/2, z: cz + pick[1]*ld/2}};
      W.sites.push({id: "funpark:" + b.id, kind: "funpark", name: PARK_NAME, block: b.id, pad: false, claimed: 1, x: Math.round(cx*100), y: hCm(cx, cz), z: Math.round(cz*100),
                    w: Math.round((longZ ? lw : ld)*100), d: Math.round((longZ ? ld : lw)*100),
                    facing: "north", tier: 1, front: [Math.round(pick[0]*65536), Math.round(pick[1]*65536)]});
    }
  }

  // the landmarks: the biggest lots in the busy districts, spread out
  var cand = (W.lots || []).filter(function(l){
    return l && l.kind === "building" && MARK_DISTRICTS[leg[l.district]] && shown(l) && Math.min(l.w, l.d)/100 >= MARK_MIN;
  }).sort(function(p, q){ return (q.w*q.d - p.w*p.d) || (p.id - q.id); });
  var P = out.park, order = TYPES.slice().sort(function(p, q){ return hash32(W.hash + p) - hash32(W.hash + q); });
  for(var i = 0; i < cand.length && out.marks.length < MAX_MARKS; i++){
    var l = cand[i], x = l.x/100, z = l.z/100;
    if(P && Math.abs(x - P.x) < Math.max(P.w, P.d)/2 + 70 && Math.abs(z - P.z) < Math.max(P.w, P.d)/2 + 70) continue;
    if(out.marks.some(function(m){ return Math.hypot(m.x - x, m.z - z) < LANDMARK_GAP; })) continue;
    var type = order[out.marks.length % order.length];
    out.marks.push({lot: l.id, x: x, z: z, s: Math.min(l.w, l.d)/100 - 2, rot: angOf(l.front, l.facing), type: type, name: NAMES[type]});
  }
  var byId = {};
  (W.lots || []).forEach(function(l){ if(l) byId[l.id] = l; });
  out.marks.forEach(function(m){
    var l = byId[m.lot]; l.was = l.kind; l.kind = "landmark";       // world.js cacheCopy puts it back
    W.sites.push({id: "landmark:" + m.lot, kind: "landmark", name: m.name, block: l.block, pad: false, claimed: 1, x: l.x, y: hCm(l.x/100, l.z/100), z: l.z,
                  w: l.w, d: l.d, facing: l.facing, front: l.front, tier: 1});
  });
  W.index = null; W.docView = null;       // world.js rebuilds both with the new sites and lot kinds
  W.spectacle = out;
  return out;
}

/* ---------- the coaster's layout (pure) ----------
   In the park's frame (x across, z along, the gate at -z): the station on the +x side heading +z, a straight lift
   hill up that side, a first drop turning across the far end, a vertical loop down the -x side, two airtime hills,
   and a sweeping turn back over the entrance (high enough to walk under) into the brake run. */
function coasterPlan(a, b, hm){
  var A = a - 7, B = b - 7, N = b - 13, H = hm, R = Math.max(7, Math.min(11, hm*0.25)), pts = [];
  function p(x, y, z, tag){ pts.push({x: x, y: y, z: z, tag: tag || null}); }
  p(A, 1.6, -N*0.74, "station0"); p(A, 1.6, -N*0.42, "station1");
  p(A, 3, -N*0.2, "lift0"); p(A, H*0.55, B*0.2); p(A, H, B*0.52, "lift1");
  p(A*0.86, H + 0.6, B*0.76, "crest"); p(A*0.5, H*0.82, B*0.95);
  p(0, 6, B); p(-A*0.55, 3.2, B*0.93); p(-A, 3.6, B*0.62);
  var cz = B*0.3, cy = 3 + R;
  for(var i = 0; i < 16; i++){                        // the loop, drifting 3 m sideways so it clears itself
    var f = i/16*TAU;
    p(-A + 3*(i/16), cy - R*Math.cos(f), cz - R*Math.sin(f), i === 8 ? "looptop" : null);
  }
  p(-A + 3, 3, B*0.02); p(-A + 3, H*0.42, -B*0.2, "hill1"); p(-A + 3, 4, -B*0.38); p(-A + 3, H*0.26, -B*0.54, "hill2");
  p(-A*0.75, 7.2, -N*0.86, "over"); p(0, 7.6, -N, "over"); p(A*0.7, 7.2, -N*0.95, "over"); p(A, 3, -N*0.86, "brake");
  return {pts: pts, A: A, B: B, N: N, R: R, loop: {y: cy, z: cz}};
}

// The angle a ride has turned t s into a cycle whose speed is omega(t): midpoint steps of 0.25 s. The full
// cycle uses the same sum, so the next cycle starts exactly where this one stopped.
function turned(omega, t, run){
  var a = 0, end = Math.min(t, run);
  for(var s = 0; s < end; s += 0.25) a += omega(s + 0.125)*Math.min(0.25, end - s);
  return a;
}

// The fireworks (HQ 3.6): a show over the park every SHOW_EVERY s of the shared clock (by night, not in Calm),
// SHOW_LEN s long, ending in a FINALE of shells four times as fast. shells(a, b, s0, s1): every shell whose burst falls
// in [s0, s1), in the park's frame (a, b: its half width and depth), the same for everyone: when, from where, how high,
// what kind and colours. Shell i of a show draws in slot i % FW_SLOTS: no two in one slot are ever alive together.
var SHOW_EVERY = 480, SHOW_LEN = 90, FINALE = 14, FW_RISE = 1.8, FW_SLOTS = 32, FW_LIVE = 6.5;
var FW_KINDS = ["peony", "ring", "willow", "chrysanthemum", "strobe"], FW_WEIGHT = [38, 16, 18, 18, 10];
var FW_COLS = [[0xff3355, 0xffc0a0], [0x3399ff, 0xc8f0ff], [0x55ff7a, 0xfff3a0], [0xffc22e, 0xff5a1a], [0xc061ff, 0xff9fdc],
               [0xffffff, 0x9fd0ff], [0xff5fa8, 0x5fffe8], [0xff9f1c, 0xfff08a], [0x29e0ff, 0xb46bff]];
var FW_T = null;
function showAt(sec){ var t = ((sec % SHOW_EVERY) + SHOW_EVERY) % SHOW_EVERY; return t < SHOW_LEN ? {t: t, start: sec - t, n: Math.floor(sec/SHOW_EVERY)} : null; }
function shellTimes(){                                  // a show's launch times: a steady pace with salvos, then the finale
  var out = [], t = 2, i = 0;
  while(t < SHOW_LEN - FINALE - 2){
    out.push(t); i++;
    if(i % 12 === 0){ out.push(t + 0.35, t + 0.7); t += 1.0; }
    t += 1.15 + (hash32("fw:t:" + i) % 1000)/1000*0.9;
  }
  for(t = SHOW_LEN - FINALE; t < SHOW_LEN - 1.5; t += 0.3) out.push(t);
  return out;
}
function shells(a, b, s0, s1){
  FW_T = FW_T || shellTimes();
  var out = [];
  for(var n = Math.floor((s0 - SHOW_LEN - FW_RISE)/SHOW_EVERY); n <= Math.floor(s1/SHOW_EVERY); n++){
    var S0 = n*SHOW_EVERY;
    for(var i = 0; i < FW_T.length; i++){
      var tb = S0 + FW_T[i] + FW_RISE; if(tb < s0 || tb >= s1) continue;
      var fin = FW_T[i] >= SHOW_LEN - FINALE, h = (function(n2, i2){ return function(k){ return (hash32("fw:" + n2 + ":" + i2 + ":" + k) % 100000)/100000; }; })(n, i);
      var w = h("k")*100, kind = 0; for(var j = 0, acc = 0; j < FW_KINDS.length; j++){ acc += FW_WEIGHT[j]; if(w < acc){ kind = j; break; } }
      if(fin && kind === 2) kind = 0;                   // the finale bursts big and bright, no slow willows
      var cp = FW_COLS[Math.floor(h("c")*FW_COLS.length)], lx = (h("x")*2 - 1)*a*0.7, lz = b - 4 - h("z")*6;
      out.push({t: tb, i: i, slot: i % FW_SLOTS, show: n, kind: FW_KINDS[kind], k: kind, launch: {x: lx, z: lz},
                burst: {x: lx + (h("dx") - 0.5)*18, y: 42 + h("y")*30 + (fin ? 8 : 0), z: lz - 8 - h("dz")*18},
                col: cp[0], col2: cp[1], size: (fin ? 1.2 : 1)*(0.85 + h("s")*0.35), seed: h("r")});
    }
  }
  return out.sort(function(p, q){ return p.t - q.t || p.i - q.i; });
}

/* ---------- drawing ---------- */
var TEXC = {};          // textures, shared by every City built on this page (the renderer re-uploads as needed)
function create(c, W, o){
  o = o || {};
  var THREE = c.THREE, E = c.E, Lb = c.L, S = o.scene, spec = W && W.spectacle;
  var g = new THREE.Group(); g.name = "spectacle";
  if(!spec || !THREE){ return {g: g, update: function(){}, setNight: function(){}, blocked: function(){ return false; },
    use: function(){ return false; }, carry: function(){ return null; }, camPose: function(){ return null; }, riding: function(){ return null; }, destroy: function(){} }; }
  S.add(g);
  var ground = o.ground || function(){ return 0; };
  var night = false, dead = false;

  /* materials */
  function tex(name, srgb){
    var url = "/games/city/" + name + ".jpg";
    if(TEXC[url]) return TEXC[url];
    var t = (Lb && Lb.tex ? Lb.tex : new THREE.TextureLoader()).load(url);
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8;
    if(srgb) t.colorSpace = THREE.SRGBColorSpace;
    return (TEXC[url] = t);
  }
  var env = (function(){
    var url = "/games/city/sky.jpg";
    if(!TEXC[url]){ var t = (Lb && Lb.tex ? Lb.tex : new THREE.TextureLoader()).load(url); t.mapping = THREE.EquirectangularReflectionMapping; t.colorSpace = THREE.SRGBColorSpace; TEXC[url] = t; }
    return TEXC[url];
  })();
  var nightMats = [];   // {m, day, night} emissive intensities
  function pbr(name, o2){
    o2 = o2 || {};
    var m = new THREE.MeshStandardMaterial({map: tex(name + "-col", true), normalMap: tex(name + "-nrm"), roughnessMap: tex(name + "-rgh"),
      roughness: o2.rough != null ? o2.rough : 1, metalness: o2.metal || 0, envMap: env, envMapIntensity: o2.env != null ? o2.env : 1,
      color: o2.color != null ? o2.color : 0xffffff});
    if(o2.emi){ m.emissiveMap = tex(name + (o2.emi === true ? "-emi" : o2.emi), true); m.emissive = new THREE.Color(o2.emiCol != null ? o2.emiCol : 0xffffff); }
    m.emissiveIntensity = 0;
    if(o2.emi) nightMats.push({m: m, day: 0, night: o2.emiNight != null ? o2.emiNight : 1.3, envDay: m.envMapIntensity});
    else nightMats.push({m: m, day: 0, night: 0, envDay: m.envMapIntensity});
    return m;
  }
  // glass: the facade's own colour lights its panes at night (Facade001 has no emission map)
  var M = {
    glass: pbr("glass", {metal: 0.7, rough: 0.5, env: 1.7, emi: "-col", emiCol: 0xffd9a0, emiNight: 0.95}),
    grid: pbr("grid", {metal: 0.6, rough: 0.7, env: 1.0, emi: "-col", emiCol: 0xfff1d0, emiNight: 0.6}),
    office: pbr("office", {metal: 0.5, rough: 0.8, env: 0.9, emi: true, emiCol: 0xfff0d0, emiNight: 1.6}),
    stone: pbr("stone", {metal: 0.05, rough: 1, env: 0.4, emi: true, emiCol: 0xffe2b0, emiNight: 1.5}),
    steel: pbr("steel", {metal: 0.9, rough: 0.6, env: 1.0}),
    // the park's: paving for its promenades, boards for its decks, tiles for its roofs, corrugated steel cladding
    pave: pbr("pave", {rough: 1, env: 0.2}),
    deck: pbr("deck", {rough: 1, env: 0.35}),
    roof: pbr("roof", {rough: 1, env: 0.25}),
    corr: pbr("corr", {metal: 0.75, rough: 1, env: 0.7})
  };
  var TILE = {glass: 10, grid: 12, office: 14, stone: 12, steel: 4, pave: 3, deck: 2.4, roof: 2.6, corr: 2.2};
  // materials are shared by colour and settings, so pieces of one colour merge into one draw call (mergeInto)
  var MATS = {};
  function plain(col, o2){
    o2 = o2 || {}; var key = "p" + col + ":" + (o2.rough != null ? o2.rough : 0.55) + ":" + (o2.metal || 0) + ":" + (o2.env || 0);
    return MATS[key] || (MATS[key] = new THREE.MeshStandardMaterial({color: col, roughness: o2.rough != null ? o2.rough : 0.55, metalness: o2.metal || 0, envMap: o2.env ? env : null, envMapIntensity: o2.env || 0}));
  }
  function glowMat(col){
    var key = "g" + col; if(MATS[key]) return MATS[key];
    var m = new THREE.MeshStandardMaterial({color: col, emissive: col, emissiveIntensity: 0.25, roughness: 0.4}); nightMats.push({m: m, day: 0.25, night: 2.2, envDay: 0});
    return (MATS[key] = m);
  }

  /* geometry: a loft of closed sections, UVs in metres so a facade tiles evenly whatever the shape */
  function loft(rings, tile, cap){
    var n = rings[0].pts.length, row = n + 1, pos = [], uv = [], idx = [];
    rings.forEach(function(r){
      var acc = 0;
      for(var i = 0; i <= n; i++){
        var p = r.pts[i % n];
        if(i > 0){ var q = r.pts[i - 1]; acc += Math.hypot(p[0] - q[0], p[1] - q[1]); }
        pos.push(p[0], r.y, p[1]); uv.push(acc/tile, r.y/tile);
      }
    });
    for(var j = 0; j < rings.length - 1; j++) for(var i = 0; i < n; i++){
      var a = j*row + i, b = a + 1, cc = a + row, d = cc + 1;
      idx.push(a, cc, b, b, cc, d);
    }
    if(cap !== false){                                   // a flat roof: a fan from the middle
      var top = rings[rings.length - 1], base = pos.length/3, mx = 0, mz = 0;
      top.pts.forEach(function(p){ mx += p[0]; mz += p[1]; }); mx /= n; mz /= n;
      pos.push(mx, top.y, mz); uv.push(0, 0);
      top.pts.forEach(function(p){ pos.push(p[0], top.y, p[1]); uv.push(p[0]/tile, p[1]/tile); });
      for(i = 0; i < n; i++) idx.push(base, base + 1 + (i + 1) % n, base + 1 + i);
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx); geo.computeVertexNormals();
    return geo;
  }
  function section(fn, n){ var out = []; for(var i = 0; i < n; i++){ var t = i/n*TAU, r = fn(t); out.push([r*Math.cos(t), r*Math.sin(t)]); } return out; }
  function rrect(w, d, r, per){
    per = per || 6; r = Math.min(r, w/2 - 0.01, d/2 - 0.01);
    var out = [], cs = [[w/2 - r, d/2 - r, 0], [-w/2 + r, d/2 - r, PI/2], [-w/2 + r, -d/2 + r, PI], [w/2 - r, -d/2 + r, 1.5*PI]];
    cs.forEach(function(cn){ for(var i = 0; i <= per; i++){ var a = cn[2] + i/per*PI/2; out.push([cn[0] + r*Math.cos(a), cn[1] + r*Math.sin(a)]); } });
    return out;
  }
  function xform(pts, sc, rot){ var cr = Math.cos(rot), sr = Math.sin(rot); return pts.map(function(p){ var x = p[0]*sc, z = p[1]*sc; return [x*cr - z*sr, x*sr + z*cr]; }); }
  // a tower: base section scaled by sc(u) and turned by tw(u) from y0 to y1, one ring per `step` m
  function tower(base, y0, y1, step, sc, tw, mat, tile, cap){
    var rings = [], n = Math.max(1, Math.ceil((y1 - y0)/step));
    for(var i = 0; i <= n; i++){ var u = i/n; rings.push({y: lerp(y0, y1, u), pts: xform(base, sc ? sc(u) : 1, tw ? tw(u) : 0)}); }
    var m = new THREE.Mesh(loft(rings, tile, cap), mat); m.castShadow = true; m.receiveShadow = true;
    return m;
  }
  function tube(pts, r, mat, seg){
    var curve = new THREE.CatmullRomCurve3(pts.map(function(p){ return new THREE.Vector3(p[0], p[1], p[2]); }));
    var m = new THREE.Mesh(new THREE.TubeGeometry(curve, seg || pts.length*2, r, 5, false), mat); m.castShadow = true; return m;
  }
  // a box whose faces carry UVs in metres, so a tiled texture keeps its scale whatever the box's size;
  // mat may be an array in BoxGeometry's face order (+x, -x, +y, -y, +z, -z)
  function mbox(w, h, d, mat, tile){
    var geo = new THREE.BoxGeometry(w, h, d), uv = geo.attributes.uv, n = geo.attributes.normal;
    for(var i = 0; i < uv.count; i++){
      var ax = Math.abs(n.getX(i)), ay = Math.abs(n.getY(i));
      uv.setXY(i, uv.getX(i)*(ax > 0.5 ? d : w)/tile, uv.getY(i)*(ay > 0.5 ? d : h)/tile);
    }
    var m = new THREE.Mesh(geo, mat); m.castShadow = true; m.receiveShadow = true; return m;
  }
  // Merge the meshes under `group` into one mesh per material, in the group's own frame (a draw call each instead
  // of one per piece). `deep`: every mesh below it (a static group: a station, a kiosk); else only its own
  // children, so a moving part inside (a horse that bobs, a chair that swings) keeps moving. Instanced and
  // skinned meshes, lines and plain Object3Ds (riders' anchors) are left as they are.
  function mergeInto(group, deep, skip){
    group.updateMatrixWorld(true);
    var inv = new THREE.Matrix4().copy(group.matrixWorld).invert(), by = new Map(), drop = [], m = new THREE.Matrix4();
    function take(o){
      if(!o.isMesh || o.isInstancedMesh || o.isSkinnedMesh || o.children.length) return false;
      var g0 = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone();
      m.multiplyMatrices(inv, o.matrixWorld); g0.applyMatrix4(m);
      if(!g0.attributes.normal) g0.computeVertexNormals();
      var mats = Array.isArray(o.material) ? o.material : [o.material], groups = Array.isArray(o.material) && g0.groups.length ? g0.groups : [{start: 0, count: g0.attributes.position.count, materialIndex: 0}];
      groups.forEach(function(gr){
        var mt = mats[gr.materialIndex | 0]; if(!mt) return;
        var e = by.get(mt) || {mat: mt, p: [], n: [], u: [], shadow: o.castShadow}; by.set(mt, e);
        var P = g0.attributes.position.array, N = g0.attributes.normal.array, U = g0.attributes.uv ? g0.attributes.uv.array : null;
        for(var v = gr.start; v < gr.start + gr.count; v++){
          e.p.push(P[3*v], P[3*v + 1], P[3*v + 2]); e.n.push(N[3*v], N[3*v + 1], N[3*v + 2]);
          if(U) e.u.push(U[2*v], U[2*v + 1]); else e.u.push(0, 0);
        }
      });
      g0.dispose(); drop.push(o); return true;
    }
    function walk(o){ if(skip && skip(o)) return; if(!take(o)) o.children.slice().forEach(walk); }
    if(deep) group.children.slice().forEach(walk); else group.children.slice().forEach(take);
    drop.forEach(function(o){ if(o.parent) o.parent.remove(o); });
    by.forEach(function(e){
      var geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(e.p, 3)); geo.setAttribute("normal", new THREE.Float32BufferAttribute(e.n, 3));
      geo.setAttribute("uv", new THREE.Float32BufferAttribute(e.u, 2)); geo.computeBoundingSphere();
      var mesh = new THREE.Mesh(geo, e.mat); mesh.castShadow = e.shadow !== false; mesh.receiveShadow = true; group.add(mesh);
    });
    return group;
  }
  function cone(r0, r1, h, mat, y, seg){ var m = new THREE.Mesh(new THREE.CylinderGeometry(r1, r0, h, seg || 16), mat); m.position.y = y + h/2; m.castShadow = true; return m; }

  /* ---------- landmarks ---------- */
  var beacons = [], marks = [], landG = new THREE.Group(); landG.name = "landmarks"; g.add(landG);
  function beacon(gp, y){
    var b = new THREE.Mesh(new THREE.SphereGeometry(0.8, 10, 8), new THREE.MeshBasicMaterial({color: 0xff2a2a}));
    b.position.y = y; b.userData.keep = true; gp.add(b);
    var gl = c.glow ? c.glow(0xff3030, 26, 0.9) : null; if(gl){ gl.position.y = y; gp.add(gl); }
    beacons.push({m: b, gl: gl});
  }
  function floods(gp, r, col){
    if(!c.glow) return;
    for(var i = 0; i < 4; i++){ var gl = c.glow(col, r*2.4, 0.0); var a = i/4*TAU + PI/4; gl.position.set(Math.cos(a)*r, r*0.6, Math.sin(a)*r); gp.add(gl); beacons.push({flood: gl}); }
  }
  var BUILD = {
    // a glass tower turning a quarter turn as it rises, tapering, with a mast
    twist: function(gp, s, H){
      var base = rrect(s, s*0.84, s*0.2, 6);
      gp.add(tower(base, 0, H, 4, function(u){ return lerp(1, 0.74, Math.pow(u, 1.2)); }, function(u){ return u*PI/2; }, M.glass, TILE.glass));
      gp.add(cone(s*0.06, s*0.012, H*0.13, M.steel, H));
      var ring = new THREE.Mesh(new THREE.TorusGeometry(s*0.33, 0.45, 6, 48), glowMat(0x7fd8ff)); ring.rotation.x = PI/2; ring.position.y = H + 0.6; gp.add(ring);
      beacon(gp, H*1.13 + 1); floods(gp, s*0.6, 0x9fd8ff);
      return [base];
    },
    // a three-lobed tower climbing in setbacks to a long spire
    spire: function(gp, s, H){
      var R = s*0.42, tiers = [0, 0.3, 0.5, 0.64, 0.75, 0.84, 0.9];
      var foot = null;
      tiers.forEach(function(t0, i){
        var t1 = i + 1 < tiers.length ? tiers[i + 1] : 0.95, k = 1 - i*0.12;
        var base = section(function(a){ return R*k*(1 + 0.24*Math.cos(3*a + i*0.35)); }, 72);
        gp.add(tower(base, t0*H, t1*H, 4, function(u){ return lerp(1, 0.97, u); }, null, M.grid, TILE.grid));
        if(!i) foot = base;
      });
      gp.add(cone(R*0.16, R*0.01, H*0.28, M.steel, H*0.95));
      beacon(gp, H*1.23 + 1); floods(gp, s*0.55, 0xfff1d0);
      return [foot];
    },
    // a glass bullet wrapped in a steel diagrid
    lantern: function(gp, s, H){
      var R = s*0.46, rings = [], n = 40;
      function rad(u){ return R*Math.pow(Math.max(0.0001, Math.sin(PI*(0.22 + 0.78*u))), 0.6); }
      for(var i = 0; i <= n; i++){ var u = i/n; rings.push({y: u*H, pts: section(function(){ return rad(u); }, 56)}); }
      var body = new THREE.Mesh(loft(rings, TILE.glass, false), M.glass); body.castShadow = true; gp.add(body);
      var dark = plain(0x20262e, {metal: 0.8, rough: 0.4, env: 0.8});
      for(var h = 0; h < 2; h++) for(var k = 0; k < 14; k++){
        var pts = [];
        for(i = 0; i <= 24; i++){ var u2 = i/24, a = k/14*TAU + (h ? 1 : -1)*u2*TAU*0.62; pts.push([Math.cos(a)*rad(u2)*1.012, u2*H*0.985, Math.sin(a)*rad(u2)*1.012]); }
        gp.add(tube(pts, 0.32, dark, 60));
      }
      var cap = new THREE.Mesh(new THREE.SphereGeometry(R*0.12, 16, 10), glowMat(0xffe8b0)); cap.position.y = H*0.985; gp.add(cap);
      beacon(gp, H + 2); floods(gp, s*0.55, 0xbfe6ff);
      return [rings[0].pts];
    },
    // twin eight-pointed towers in setbacks with a skybridge between them
    twins: function(gp, s, H){
      var R = s*0.235, gap = s*0.1, off = gap/2 + R, steps = [[0, 0.58, 1], [0.58, 0.72, 0.86], [0.72, 0.82, 0.72], [0.82, 0.9, 0.58], [0.9, 0.94, 0.44]], feet = [];
      [-1, 1].forEach(function(sd){
        feet.push(section(function(a){ return R*(1 + 0.09*Math.cos(8*a)); }, 96).map(function(p){ return [p[0] + sd*off, p[1]]; }));
        var tg = new THREE.Group(); tg.position.x = sd*off; gp.add(tg);
        steps.forEach(function(st){
          var base = section(function(a){ return R*st[2]*(1 + 0.09*Math.cos(8*a)); }, 96);
          tg.add(tower(base, st[0]*H, st[1]*H, 3.5, null, null, M.office, TILE.office));
        });
        tg.add(cone(R*0.16, R*0.02, H*0.18, M.steel, H*0.94));
        beacon(tg, H*1.12 + 1);
      });
      var by = H*0.42, bridge = new THREE.Mesh(new THREE.BoxGeometry(gap + R*0.6, 5, 3.4), M.steel); bridge.position.y = by; bridge.castShadow = true; gp.add(bridge);
      [-1, 1].forEach(function(sd){ gp.add(tube([[sd*gap*0.15, by - 2.5, 0], [sd*(gap/2 + R*0.6), by - 30, 0]], 0.55, M.steel, 8)); });
      floods(gp, s*0.6, 0xfff0d0);
      return feet;
    },
    // an observation tower: a concrete shaft, a glass sky-deck ringed in light, a second pod and an antenna
    needle: function(gp, s, H){
      var r0 = Math.min(9, s*0.24);
      var shaft = section(function(){ return r0; }, 40), feet = [shaft];
      gp.add(tower(shaft, 0, H*0.78, 6, function(u){ return lerp(1, 0.42, u); }, null, M.stone, TILE.stone));
      for(var i = 0; i < 3; i++){                                    // three fins round the foot
        var f = new THREE.Mesh(new THREE.BoxGeometry(1.6, H*0.16, r0*2.6), M.stone); var a = i/3*TAU;
        f.position.set(Math.sin(a)*r0*1.1, H*0.08, Math.cos(a)*r0*1.1); f.rotation.y = a; f.castShadow = true; gp.add(f);
        // the fin's footprint: its box turned by a about y ((lx, lz) -> (lx cos a + lz sin a, -lx sin a + lz cos a))
        feet.push([[-0.8, -r0*1.3], [0.8, -r0*1.3], [0.8, r0*1.3], [-0.8, r0*1.3]].map(function(q){
          return [f.position.x + q[0]*Math.cos(a) + q[1]*Math.sin(a), f.position.z - q[0]*Math.sin(a) + q[1]*Math.cos(a)]; }));
      }
      var py = H*0.66, prof = [[0.42, 0], [1.8, 3], [2.05, 7], [2.05, 11], [1.6, 14], [0.42, 16]], rings = [];
      prof.forEach(function(p){ rings.push({y: py + p[1], pts: section(function(){ return r0*p[0]; }, 64)}); });
      var pod = new THREE.Mesh(loft(rings, TILE.glass), M.glass); pod.castShadow = true; gp.add(pod);
      var ring = new THREE.Mesh(new THREE.TorusGeometry(r0*2.06, 0.5, 6, 72), glowMat(0x7fffd4)); ring.rotation.x = PI/2; ring.position.y = py + 9; gp.add(ring);
      gp.userData.ring = ring;
      rings = []; [[0.36, 0], [0.9, 2.5], [0.9, 5], [0.36, 7]].forEach(function(p){ rings.push({y: H*0.76 + p[1], pts: section(function(){ return r0*p[0]; }, 40)}); });
      gp.add(new THREE.Mesh(loft(rings, TILE.glass), M.glass));
      gp.add(cone(r0*0.16, r0*0.03, H*0.22, M.steel, H*0.78));
      beacon(gp, H + 1); floods(gp, r0*2.2, 0xfff0c0);
      return feet;
    },
    // an art deco stone tower stepping back to a crown of lit sunbursts
    regent: function(gp, s, H){
      var tiers = [[1, 0.45], [0.82, 0.2], [0.66, 0.13], [0.52, 0.09]], y = 0, foot = rrect(s, s*0.9, 1.4, 3);
      tiers.forEach(function(t){ var h = t[1]*H; gp.add(tower(rrect(s*t[0], s*t[0]*0.9, 1.4, 3), y, y + h, 4, null, null, M.stone, TILE.stone)); y += h; });
      var cw = s*0.42, crown = glowMat(0xfff2c8);
      for(var i = 0; i < 6; i++){
        var u = i/6, r = cw*(1 - u*0.85)/2, cy = y + u*H*0.12;
        var sun = new THREE.Mesh(new THREE.CylinderGeometry(r*0.92, r, H*0.02, 24, 1, true), i % 2 ? M.steel : crown); sun.position.y = cy + H*0.01; gp.add(sun);
        for(var k = 0; k < 10; k++){
          var tri = new THREE.Mesh(new THREE.ConeGeometry(r*0.22, H*0.03, 3), crown), a = k/10*TAU;
          tri.position.set(Math.cos(a)*r, cy + H*0.025, Math.sin(a)*r); gp.add(tri);
        }
      }
      gp.add(cone(cw*0.08, cw*0.01, H*0.16, M.steel, y + H*0.12));
      beacon(gp, y + H*0.28 + 1); floods(gp, s*0.6, 0xffe2b0);
      return [foot];
    }
  };
  var HMUL = {twist: 1, spire: 1.15, lantern: 0.72, twins: 0.82, needle: 1.35, regent: 0.9};
  spec.marks.forEach(function(m){
    var gp = new THREE.Group(), s = Math.max(16, m.s*0.9), H = clamp(s*7.5, 190, 360)*(HMUL[m.type] || 1);
    gp.position.set(m.x, ground(m.x, m.z) - 0.2, m.z); gp.rotation.y = m.rot; gp.name = "landmark:" + m.type;
    var foot = BUILD[m.type](gp, s, H);
    landG.add(gp);
    mergeInto(gp, true, function(o){ return o.userData.keep; });
    var cr = Math.cos(m.rot), sr = Math.sin(m.rot);
    // what blocks you: the tower's own outline at the ground (each builder returns its base rings), turned and
    // moved into the world, each with its bounds for a quick reject
    var polys = foot.map(function(P){
      var W2 = P.map(function(q){ return [m.x + q[0]*cr + q[1]*sr, m.z - q[0]*sr + q[1]*cr]; }), b = {x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity};
      W2.forEach(function(q){ b.x0 = Math.min(b.x0, q[0]); b.x1 = Math.max(b.x1, q[0]); b.z0 = Math.min(b.z0, q[1]); b.z1 = Math.max(b.z1, q[1]); });
      return {P: W2, b: b};
    });
    marks.push({m: m, g: gp, H: H, polys: polys});
  });

  /* ---------- the park ---------- */
  var P = spec.park, park = null;
  if(P) park = buildPark(P);
  function buildPark(P){
    var pg = new THREE.Group(); pg.name = "funpark";
    var gy = ground(P.x, P.z); pg.position.set(P.x, gy, P.z); pg.rotation.y = P.rot; g.add(pg);
    var a = P.w/2, b = P.d/2, cr = Math.cos(P.rot), sr = Math.sin(P.rot);
    function toW(lx, lz){ return {x: P.x + lx*cr + lz*sr, z: P.z - lx*sr + lz*cr}; }
    function toL(x, z){ var dx = x - P.x, dz = z - P.z; return {x: dx*cr - dz*sr, z: dx*sr + dz*cr}; }
    function ly(lx, lz){ var w = toW(lx, lz); return ground(w.x, w.z) - gy; }
    var hits = [], segs = [], bulbs = [], glows = [], rides = [], statics = [], movers = [], dynRoots = [];
    var track = [], paved = [], zones = [];   // the coaster's samples; paved rectangles; rides' sweeps (for the scenery)
    var hm = clamp(Math.min(P.w, P.d)*0.42, 26, 46);

    // the paths, paved, laid over the ground as it lies (a flat slab floats or sinks on a slope)
    function paveArea(x0, z0, x1, z1){
      var w = x1 - x0, d = z1 - z0, geo = new THREE.PlaneGeometry(w, d, Math.max(1, Math.ceil(w/2)), Math.max(1, Math.ceil(d/2)));
      geo.rotateX(-PI/2);
      var Pp = geo.attributes.position, Uv = geo.attributes.uv;
      for(var i = 0; i < Pp.count; i++){
        var x = Pp.getX(i) + (x0 + x1)/2, z = Pp.getZ(i) + (z0 + z1)/2;
        Pp.setXYZ(i, x, ly(x, z) + 0.07, z); Uv.setXY(i, x/TILE.pave, z/TILE.pave);
      }
      geo.computeVertexNormals();
      paved.push([x0, z0, x1, z1]);
      var m = new THREE.Mesh(geo, M.pave); m.receiveShadow = true; pg.add(m); return m;
    }
    paveArea(-3.5, -b - 3, 3.5, b*0.55);                                  // the boulevard, from outside the gate
    paveArea(-9, -b - 3, 9, -b + 6);                                       // the entrance plaza
    paveArea(-a*0.62, -b*0.12, a*0.62, -b*0.04); paveArea(-a*0.62, b*0.44, a*0.62, b*0.52);
    paveArea(-a*0.62, -b*0.12, -a*0.54, b*0.52); paveArea(a*0.54, -b*0.12, a*0.62, b*0.52);
    var rects = [];                                                       // blocked boxes in the park's frame
    function rectHit(x, z, yaw, w, d){ rects.push({x: x, z: z, c: Math.cos(yaw), s: Math.sin(yaw), hw: w/2, hd: d/2}); }

    // the fence, with the gate in the middle of the near side
    var GATE = 3.6, fenceM = plain(0x1f3b33, {metal: 0.6, rough: 0.4}), posts = [];
    function fence(x0, z0, x1, z1){
      var L = Math.hypot(x1 - x0, z1 - z0), n = Math.max(1, Math.round(L/2.5));
      for(var i = 0; i <= n; i++) posts.push([lerp(x0, x1, i/n), lerp(z0, z1, i/n)]);
      [0.55, 1.45].forEach(function(h){
        var r = new THREE.Mesh(new THREE.BoxGeometry(L, 0.08, 0.08), fenceM);
        r.position.set((x0 + x1)/2, ly((x0 + x1)/2, (z0 + z1)/2) + h, (z0 + z1)/2); r.rotation.y = -Math.atan2(z1 - z0, x1 - x0); pg.add(r);
      });
      segs.push([x0, z0, x1, z1]);
    }
    fence(-a, -b, -GATE, -b); fence(GATE, -b, a, -b); fence(a, -b, a, b); fence(a, b, -a, b); fence(-a, b, -a, -b);
    var postI = new THREE.InstancedMesh(new THREE.BoxGeometry(0.14, 1.7, 0.14), fenceM, posts.length), dm = new THREE.Object3D();
    posts.forEach(function(p, i){ dm.position.set(p[0], ly(p[0], p[1]) + 0.85, p[1]); dm.updateMatrix(); postI.setMatrixAt(i, dm.matrix); });
    pg.add(postI);

    // the gate: two pylons, an arch and a marquee sign in lights
    var pylonM = plain(0xf2efe6, {rough: 0.6}), signT = c.canvasTex(1024, 192, function(gx){
      var gr = gx.createLinearGradient(0, 0, 0, 192); gr.addColorStop(0, "#2b1055"); gr.addColorStop(1, "#7b2ff7");
      gx.fillStyle = gr; gx.fillRect(0, 0, 1024, 192);
      gx.font = "bold 112px 'Avenir Next', 'Segoe UI', sans-serif"; gx.textAlign = "center"; gx.textBaseline = "middle";
      gx.shadowColor = "#ff4fd8"; gx.shadowBlur = 28; gx.fillStyle = "#fff6c8"; gx.fillText(PARK_NAME.toUpperCase(), 512, 100);
    }).t;
    signT.colorSpace = THREE.SRGBColorSpace;
    [-1, 1].forEach(function(sd){ var py = new THREE.Mesh(loft([{y: 0, pts: rrect(1.8, 1.8, 0.5, 3)}, {y: 9, pts: rrect(1.4, 1.4, 0.4, 3)}], 3), pylonM); py.position.set(sd*(GATE + 0.9), ly(sd*GATE, -b), -b); py.castShadow = true; pg.add(py); });
    var arch = new THREE.Mesh(new THREE.TorusGeometry(GATE + 0.9, 0.32, 8, 32, PI), glowMat(0xff5fd2)); arch.position.set(0, ly(0, -b) + 9, -b); pg.add(arch);
    var signM = new THREE.MeshStandardMaterial({map: signT, emissiveMap: signT, emissive: 0xffffff, emissiveIntensity: 0.35, side: THREE.DoubleSide, roughness: 0.5});
    nightMats.push({m: signM, day: 0.35, night: 1.4, envDay: 0});
    var sign = new THREE.Mesh(new THREE.PlaneGeometry(2*GATE + 3, (2*GATE + 3)*192/1024), signM); sign.position.set(0, ly(0, -b) + 7.2, -b - 0.05); sign.rotation.y = PI; pg.add(sign);
    for(var i = 0; i < 28; i++){ var u = i/27; bulbs.push({x: lerp(-GATE - 1.4, GATE + 1.4, u), y: ly(0, -b) + 8.6, z: -b - 0.1, k: u}); bulbs.push({x: lerp(-GATE - 1.4, GATE + 1.4, u), y: ly(0, -b) + 5.8, z: -b - 0.1, k: 1 - u}); }
    // a bunch of balloons by the gate
    var balloonCols = [0xff4f6d, 0xffd23f, 0x3bceac, 0x5f6bff, 0xff8c42, 0xc86bfa], balloons = [];
    for(i = 0; i < 6; i++){
      var bl = new THREE.Mesh(new THREE.SphereGeometry(0.42, 14, 10), plain(balloonCols[i], {rough: 0.25}));
      bl.scale.y = 1.18; bl.userData = {bx: -GATE - 4 + (i % 3)*0.5, bz: -b + 2 + Math.floor(i/3)*0.5, ph: i*1.3}; pg.add(bl); balloons.push(bl);
    }

    // lamp posts down the boulevard, strung with bulbs
    var lampM = plain(0x2c2f36, {metal: 0.7, rough: 0.4}), lamps = [];
    for(var z = -b + 10; z <= b*0.55; z += 14){ [-1, 1].forEach(function(sd){ lamps.push([sd*4.6, z]); }); }
    lamps.forEach(function(p){
      var lp = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.12, 5.6, 6), lampM); lp.position.set(p[0], ly(p[0], p[1]) + 2.8, p[1]); pg.add(lp);
      var gl = new THREE.Mesh(new THREE.SphereGeometry(0.28, 10, 8), glowMat(0xfff1c4)); gl.position.set(p[0], ly(p[0], p[1]) + 5.7, p[1]); pg.add(gl);
      if(c.glow){ var sp = c.glow(0xffe6a8, 6, 0); sp.position.copy(gl.position); pg.add(sp); glows.push(sp); }
      hits.push({x: p[0], z: p[1], r: 0.3});
    });
    for(i = 0; i + 2 < lamps.length; i += 2){                  // catenaries across and along
      [[lamps[i], lamps[i + 1]], [lamps[i], lamps[i + 2]]].forEach(function(pr){
        var p0 = pr[0], p1 = pr[1];
        for(var k = 1; k < 12; k++){ var u2 = k/12, sag = Math.sin(u2*PI)*0.7; bulbs.push({x: lerp(p0[0], p1[0], u2), y: ly(p0[0], p0[1]) + 5.4 - sag, z: lerp(p0[1], p1[1], u2), k: (k + i)/12 % 1}); }
      });
    }
    // food kiosks along the boulevard, each with its sign and what it sells up on its roof
    var awnT = c.canvasTex(64, 64, function(gx){ for(var s2 = 0; s2 < 8; s2++){ gx.fillStyle = s2 % 2 ? "#fff4e0" : "#e63946"; gx.fillRect(s2*8, 0, 8, 64); } }).t;
    awnT.colorSpace = THREE.SRGBColorSpace; awnT.wrapS = awnT.wrapT = THREE.RepeatWrapping;
    var kiosks = [];

    // a lit sign: the name in warm neon on a dark board edged in the accent colour
    function signTex(name, icon, accent){
      var t = c.canvasTex(1024, 256, function(gx){
        var gr = gx.createLinearGradient(0, 0, 1024, 256); gr.addColorStop(0, "#0f1220"); gr.addColorStop(1, "#2a1240");
        gx.fillStyle = gr; gx.fillRect(0, 0, 1024, 256);
        gx.strokeStyle = accent; gx.lineWidth = 12; gx.strokeRect(14, 14, 996, 228);
        var label = (icon ? icon + "  " : "") + String(name).toUpperCase(), fs = 132;
        gx.font = "bold " + fs + "px 'Avenir Next', 'Segoe UI', sans-serif";
        var tw = gx.measureText(label).width; if(tw > 930){ fs = Math.floor(fs*930/tw); gx.font = "bold " + fs + "px 'Avenir Next', 'Segoe UI', sans-serif"; }   // a long name fits the board
        gx.textAlign = "center"; gx.textBaseline = "middle";
        gx.shadowColor = accent; gx.shadowBlur = 34; gx.fillStyle = "#fff8e6";
        gx.fillText(label, 512, 138);
      }).t;
      t.colorSpace = THREE.SRGBColorSpace; return t;
    }
    function signMat(tx){ var m = new THREE.MeshStandardMaterial({map: tx, emissiveMap: tx, emissive: 0xffffff, emissiveIntensity: 0.4, roughness: 0.45, side: THREE.DoubleSide}); nightMats.push({m: m, day: 0.4, night: 1.5, envDay: 0}); return m; }
    function hexOf(css){ return parseInt(String(css).slice(1), 16); }
    // a group placed in the park's frame at x, z facing yaw (its +z), and its own frame -> the park's
    function framed(x, z, yaw){
      var gp = new THREE.Group(); gp.position.set(x, 0, z); gp.rotation.y = yaw; pg.add(gp); statics.push(gp);
      var cc = Math.cos(yaw), ss = Math.sin(yaw);
      return {g: gp, L: function(lx, lz){ return {x: x + lx*cc + lz*ss, z: z - lx*ss + lz*cc}; }};
    }
    // A kiosk: a boarded counter under a striped awning, corrugated walls, a tiled roof, a lit sign and
    // what it sells, giant, up on top. k: {x, z, yaw, name, prop, acc}
    function kiosk(k){
      var F = framed(k.x, k.z, k.yaw), gk = F.g, base = ly(k.x, k.z) - 0.2, acc = hexOf(k.acc);
      gk.position.y = base;
      var counter = mbox(3.4, 1.15, 0.7, M.deck, TILE.deck); counter.position.set(0, 0.58, 0.9); gk.add(counter);
      var top = mbox(3.6, 0.08, 0.85, plain(0xf5efe4, {rough: 0.35}), 1); top.position.set(0, 1.19, 0.92); gk.add(top);
      var back = mbox(3.4, 2.9, 0.18, M.corr, TILE.corr); back.position.set(0, 1.45, -1); gk.add(back);
      [-1, 1].forEach(function(sd){ var sw = mbox(0.18, 2.9, 2.2, M.corr, TILE.corr); sw.position.set(sd*1.62, 1.45, 0.05); gk.add(sw); });
      var lamp = new THREE.Mesh(new THREE.BoxGeometry(2.8, 0.06, 0.4), glowMat(0xfff1c4)); lamp.position.set(0, 2.75, 0.2); gk.add(lamp);
      var roof = mbox(3.9, 0.16, 2.8, M.roof, TILE.roof); roof.position.set(0, 3.0, 0.05); roof.rotation.x = 0.08; gk.add(roof);
      var at = awnT.clone(); at.needsUpdate = true; at.repeat.set(2, 1);
      var awn = new THREE.Mesh(new THREE.PlaneGeometry(3.7, 1.3), new THREE.MeshStandardMaterial({map: at, roughness: 0.7, side: THREE.DoubleSide}));
      awn.position.set(0, 2.55, 1.55); awn.rotation.x = -1.05; awn.castShadow = true; gk.add(awn);
      for(var q = 0; q < 9; q++){ var sc = new THREE.Mesh(new THREE.ConeGeometry(0.21, 0.24, 8), plain(q % 2 ? 0xfff4e0 : 0xe63946)); sc.rotation.x = PI; sc.position.set(-1.64 + q*0.41, 1.98, 2.06); gk.add(sc); }
      var sb = new THREE.Mesh(new THREE.BoxGeometry(3.0, 0.75, 0.16), signMat(signTex(k.name, "", k.k || k.acc))); sb.position.set(0, 3.55, 0.8); gk.add(sb);
      var edge = new THREE.Mesh(new THREE.BoxGeometry(3.1, 0.05, 0.2), glowMat(acc)); edge.position.set(0, 3.15, 0.8); gk.add(edge);
      prop(gk, k.prop, 0, 3.95, -0.25);
      rectHit(k.x, k.z, k.yaw, 3.6, 2.6);
      // where its customers stand: in front of the counter
      var cust = [];
      for(q = 0; q < 3; q++){ var pp = F.L(-0.9 + q*0.9, 2.0 + (q % 2)*0.35); cust.push({x: pp.x, z: pp.z, yaw: k.yaw + PI}); }
      kiosks.push({x: k.x, z: k.z, cust: cust});
    }
    // what a kiosk sells, giant, on its roof
    var stripeT = c.canvasTex(64, 16, function(gx){ for(var s2 = 0; s2 < 8; s2++){ gx.fillStyle = s2 % 2 ? "#ffffff" : "#e63946"; gx.fillRect(s2*8, 0, 8, 16); } }).t;
    stripeT.colorSpace = THREE.SRGBColorSpace;
    function prop(gk, kind, x, y, z){
      var pgp = new THREE.Group(); pgp.position.set(x, y, z); gk.add(pgp);
      if(kind === "popcorn"){
        var bucket = new THREE.Mesh(new THREE.CylinderGeometry(0.75, 0.55, 1.3, 20, 1, true), new THREE.MeshStandardMaterial({map: stripeT, roughness: 0.5, side: THREE.DoubleSide}));
        bucket.position.y = 0.65; pgp.add(bucket);
        var corn = plain(0xffe9a0, {rough: 0.9}), R = c.rng(5);
        for(var i = 0; i < 22; i++){ var k = new THREE.Mesh(new THREE.SphereGeometry(0.17 + R()*0.08, 8, 6), corn); var a2 = R()*TAU, rr = R()*0.6; k.position.set(Math.cos(a2)*rr, 1.3 + R()*0.35, Math.sin(a2)*rr); pgp.add(k); }
      } else if(kind === "cone"){
        var waffle = new THREE.Mesh(new THREE.ConeGeometry(0.5, 1.4, 16), plain(0xd9a35b, {rough: 0.8})); waffle.rotation.x = PI; waffle.position.y = 0.7; pgp.add(waffle);
        [0xffc6d9, 0xbff0d4, 0x6f4e37].forEach(function(cl, j){ var sc = new THREE.Mesh(new THREE.SphereGeometry(0.55 - j*0.08, 18, 12), plain(cl, {rough: 0.6})); sc.position.y = 1.5 + j*0.62; pgp.add(sc); });
        var cherry = new THREE.Mesh(new THREE.SphereGeometry(0.14, 10, 8), plain(0xd7263d, {rough: 0.25})); cherry.position.y = 3.15; pgp.add(cherry);
      } else if(kind === "candy"){
        var stick = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.6, 8), plain(0xfaf3e0)); stick.position.y = 0.8; pgp.add(stick);
        var fluff = plain(0xff9fd6, {rough: 1}), R2 = c.rng(9);
        for(var j2 = 0; j2 < 14; j2++){ var f = new THREE.Mesh(new THREE.SphereGeometry(0.35 + R2()*0.2, 12, 8), fluff); var a3 = R2()*TAU, r3 = R2()*0.45; f.position.set(Math.cos(a3)*r3, 1.9 + R2()*0.7, Math.sin(a3)*r3); pgp.add(f); }
      } else if(kind === "ticket"){
        var tkT = c.canvasTex(512, 256, function(gx){ gx.fillStyle = "#ffd23f"; gx.fillRect(0, 0, 512, 256); gx.strokeStyle = "#7a1f3d"; gx.setLineDash([14, 10]); gx.lineWidth = 8; gx.strokeRect(22, 22, 468, 212);
          gx.fillStyle = "#7a1f3d"; gx.font = "bold 84px 'Avenir Next', sans-serif"; gx.textAlign = "center"; gx.textBaseline = "middle"; gx.fillText("FREE ENTRY", 256, 130); }).t;
        tkT.colorSpace = THREE.SRGBColorSpace;
        var tk = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.1, 0.08), new THREE.MeshStandardMaterial({map: tkT, roughness: 0.6})); tk.position.y = 0.7; tk.rotation.z = 0.12; pgp.add(tk);
      }
      return pgp;
    }
    // A ride's station: a boarded deck at boarding height up steps from the path, a tiled gable roof on steel
    // posts with a lit eave, the ride's sign in neon edged in bulbs, a queue of brass posts and velvet ropes,
    // an operator's booth and planters. Its front (+z) faces the path; `back` runs the roof back over a track.
    // o: {x, z, yaw, w, d, top (deck height in the park's frame, null: 0.9 over the ground), back, name, icon, accent}
    // -> {entry, exit, queue: [{x, y, z, yaw}] (park frame), top}
    function station(o){
      var F = framed(o.x, o.z, o.yaw), sg = F.g, L = F.L, acc = hexOf(o.accent), w = o.w, d = o.d, back = o.back || 0;
      var lows = [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, 0]].map(function(q){ var p = L(q[0]*w/2, q[1]*d/2); return ly(p.x, p.z); });
      var base = Math.min.apply(null, lows) - 0.15, top = o.top != null ? o.top : Math.max.apply(null, lows) + 0.9, h = top - base;
      var deck = mbox(w, h, d, [M.corr, M.corr, M.deck, M.corr, M.corr, M.corr], TILE.deck); deck.position.set(0, base + h/2, 0); sg.add(deck);
      var trim = mbox(w + 0.1, 0.12, d + 0.1, glowMat(acc), 1); trim.position.set(0, top - 0.25, 0); sg.add(trim);
      // steps up from the path in front
      var fy = ly(L(0, d/2 + 1).x, L(0, d/2 + 1).z), rise = Math.max(0, top - fy), nS = Math.max(1, Math.ceil(rise/0.24));
      for(var k = 0; k < nS; k++){
        var yt = top - (k + 1)*rise/nS, st = mbox(3.2, Math.max(0.05, yt - base), 0.42, M.deck, TILE.deck);
        st.position.set(0, base + (yt - base)/2, d/2 + 0.21 + k*0.42); sg.add(st);
      }
      // posts and a gable roof (the ridge along x) in roofing tiles, a lit eave strip along the front
      var postH = 3.3, roofY = top + postH, rd = d + back + 1.2, rw = w + 1.2, rz = -back/2, pitch = 0.36;
      [[-1, 1], [1, 1], [-1, -1], [1, -1]].forEach(function(q){
        var pz = q[1] > 0 ? d/2 - 0.3 : -d/2 - back + 0.3, post = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.13, postH, 10), M.steel);
        post.position.set(q[0]*(w/2 - 0.3), top + postH/2, pz); post.castShadow = true; sg.add(post);
        if(q[1] < 0 && back > 0){ var gyb = ly(L(q[0]*(w/2 - 0.3), pz).x, L(q[0]*(w/2 - 0.3), pz).z), full = roofY - gyb;   // posts behind, down to the ground
          var lp = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.16, full, 10), M.steel); lp.position.set(q[0]*(w/2 - 0.3), gyb + full/2, pz); lp.castShadow = true; sg.add(lp); }
      });
      [-1, 1].forEach(function(sd){
        var slab = mbox(rw, 0.14, rd/2/Math.cos(pitch) + 0.15, M.roof, TILE.roof);
        slab.position.set(0, roofY + Math.tan(pitch)*rd/4, rz + sd*rd/4); slab.rotation.x = sd*pitch; sg.add(slab);
        var gm = MATS["gable" + acc] || (MATS["gable" + acc] = new THREE.MeshStandardMaterial({color: acc, roughness: 0.5, side: THREE.DoubleSide}));
        var gable = new THREE.Mesh(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(sd*rw/2, roofY, rz - rd/2), new THREE.Vector3(sd*rw/2, roofY, rz + rd/2), new THREE.Vector3(sd*rw/2, roofY + Math.tan(pitch)*rd/2, rz)]), gm);
        gable.geometry.computeVertexNormals(); sg.add(gable);
      });
      var ridge = mbox(rw + 0.1, 0.2, 0.3, M.steel, TILE.steel); ridge.position.set(0, roofY + Math.tan(pitch)*rd/2 + 0.05, rz); sg.add(ridge);
      var eave = new THREE.Mesh(new THREE.BoxGeometry(rw, 0.08, 0.08), glowMat(acc)); eave.position.set(0, roofY - 0.02, rz + rd/2); sg.add(eave);
      var ceil = new THREE.Mesh(new THREE.BoxGeometry(w - 0.4, 0.05, d + back - 0.4), glowMat(0xfff4dc)); ceil.position.set(0, roofY - 0.1, rz); sg.add(ceil);
      // the sign, standing on the front of the roof, in bulbs
      var sw = Math.min(w*0.9, 7.5), sh = sw/4, sy = roofY + Math.tan(pitch)*rd/4 + sh/2 + 0.35;
      var sign = new THREE.Mesh(new THREE.PlaneGeometry(sw, sh), signMat(signTex(o.name, o.icon, o.accent))); sign.position.set(0, sy, rz + rd/4 + 0.2); sg.add(sign);
      var frame = mbox(sw + 0.3, sh + 0.3, 0.12, M.steel, TILE.steel); frame.position.set(0, sy, rz + rd/4 + 0.12); sg.add(frame);
      for(k = 0; k <= 16; k++){ var u = k/16; [sy + sh/2 + 0.1, sy - sh/2 - 0.1].forEach(function(by, j){ var p = L(lerp(-sw/2, sw/2, u), rz + rd/4 + 0.28); bulbs.push({x: p.x, y: by, z: p.z, k: j ? 1 - u : u}); }); }
      // the queue: brass posts, velvet ropes, three switchbacks across the deck
      var brass = plain(0xd4a52c, {metal: 0.9, rough: 0.25, env: 1}), velvet = plain(0xa4133c, {rough: 0.7}), queue = [];
      var rows = Math.max(1, Math.min(3, Math.floor((d - 0.6)/1.0)));
      for(var r = 0; r < rows; r++){
        var qz = d/2 - 0.6 - r*1.0, x0 = -w/2 + 0.6 + (r % 2 ? 1.6 : 0), x1 = w/2 - 0.6 - (r % 2 ? 0 : 1.6), n = Math.max(2, Math.round((x1 - x0)/1.4) + 1), pts = [];
        for(var j = 0; j < n; j++){
          var px = lerp(x0, x1, j/(n - 1)), ps = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.05, 0.95, 8), brass); ps.position.set(px, top + 0.47, qz - 0.5); sg.add(ps);
          var cap = new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 6), brass); cap.position.set(px, top + 0.96, qz - 0.5); sg.add(cap);
          pts.push([px, top + 0.88, qz - 0.5]); if(j < n - 1) pts.push([lerp(px, lerp(x0, x1, (j + 1)/(n - 1)), 0.5), top + 0.74, qz - 0.5]);
        }
        sg.add(tube(pts, 0.03, velvet, pts.length*4));
        for(j = 0; j < 4; j++){ var qp = L(lerp(x0 + 0.4, x1 - 0.4, (j + 0.5)/4), qz - 0.05); queue.push({x: qp.x, y: top, z: qp.z, yaw: o.yaw + (r % 2 ? -PI/2 : PI/2)}); }
      }
      // the operator's booth at the back corner: glazed, lit inside
      var bx = w/2 - 1.0, bz = -d/2 + 0.8, bo = mbox(1.5, 2.2, 1.3, M.corr, TILE.corr); bo.position.set(bx, top + 1.1, bz); sg.add(bo);
      var win = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 0.9), M.glass); win.position.set(bx, top + 1.5, bz + 0.66); sg.add(win);
      var bl = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.05, 0.9), glowMat(0xfff1c4)); bl.position.set(bx, top + 2.12, bz); sg.add(bl);
      // planters either side of the steps
      var leaf = plain(0x3f8f4f, {rough: 0.9}), bloom = plain(acc, {rough: 0.6});
      [-1, 1].forEach(function(sd){
        var pl = mbox(0.9, 0.6, 0.9, M.deck, TILE.deck), pp = d/2 + 0.6; pl.position.set(sd*2.2, fy + 0.3, pp); sg.add(pl);
        for(var b2 = 0; b2 < 4; b2++){ var bu = new THREE.Mesh(new THREE.SphereGeometry(0.28, 10, 8), b2 === 3 ? bloom : leaf); bu.position.set(sd*2.2 + (b2 % 2 - 0.5)*0.32, fy + 0.75 + (b2 === 3 ? 0.2 : 0), pp + (b2 > 1 ? 0.16 : -0.16)); sg.add(bu); }
      });
      rectHit(o.x - (back/2)*Math.sin(o.yaw), o.z - (back/2)*Math.cos(o.yaw), o.yaw, w, d + back);
      var en = L(0, d/2 + 0.42*nS + 1.4), ex = L(w/2 + 1.4, d/2 + 1.2);
      return {entry: {x: en.x, z: en.z}, exit: {x: ex.x, z: ex.z}, queue: queue, top: top};
    }

    // the ticket booth by the gate and the food kiosks down the boulevard (after the builders' textures above)
    kiosk({x: GATE + 4.8, z: -b - 2.6, yaw: PI, name: "Welcome", prop: "ticket", acc: "#ffd23f"});
    [{x: -9, z: -b*0.55, name: "Popcorn", prop: "popcorn", acc: "#ffd23f"}, {x: 9, z: -b*0.35, name: "Ice Cream", prop: "cone", acc: "#7ee0ff"},
     {x: -9, z: b*0.2, name: "Cotton Candy", prop: "candy", acc: "#ff7ad9"}].forEach(function(k){ k.yaw = k.x < 0 ? PI/2 : -PI/2; kiosk(k); });

    /* ----- the rides ----- */
    var place = {
      coaster: null,
      wheel: {x: -a*0.42, z: -b*0.36, R: clamp(Math.min(a, b)*0.42, 10, 26)},
      drop: {x: -a*0.42, z: b*0.42, H: clamp(hm*1.55, 40, 72)},
      carousel: {x: a*0.3, z: -b*0.02, r: clamp(a*0.18, 6, 9)},
      swing: {x: a*0.28, z: b*0.38, r: clamp(a*0.12, 4, 6)},
      galleon: a >= 30 && b >= 48 ? {x: -a*0.04, z: b*0.69} : null     // behind the boulevard's end, where the park is long enough
    };
    rides.push(coaster(), wheel(place.wheel), drop(place.drop), carousel(place.carousel), swinger(place.swing));
    if(place.galleon) rides.push(galleon(place.galleon));
    zones.push({x: place.wheel.x, z: place.wheel.z, hw: 4, hd: place.wheel.R + 2}, {x: place.drop.x, z: place.drop.z, hw: 5.5, hd: 5.5},
               {x: place.carousel.x, z: place.carousel.z, hw: place.carousel.r + 1.5, hd: place.carousel.r + 1.5},
               {x: place.swing.x, z: place.swing.z, hw: place.swing.r + 8, hd: place.swing.r + 8});
    if(place.galleon) zones.push({x: place.galleon.x, z: place.galleon.z, hw: 17, hd: 5.5});
    // every ride's station: you walk up to its steps, queue on its deck and board from there
    rides.forEach(function(r){
      var o3 = r.stationAt; if(!o3) return;
      var st = station({x: o3.x, z: o3.z, yaw: o3.yaw, w: o3.w, d: o3.d, back: o3.back, top: o3.top, name: r.name, icon: r.icon, accent: r.accent});
      r.entry = st.entry; r.exit = st.exit; r.queue = st.queue; r.deckTop = st.top;
    });

    // the coaster
    function coaster(){
      var plan = coasterPlan(a, b, hm), V = plan.pts.map(function(p){ return new THREE.Vector3(p.x, p.y, p.z); });
      var curve = new THREE.CatmullRomCurve3(V, true, "centripetal", 0.5), len = curve.getLength(), N = Math.ceil(len/0.5);
      var Pt = curve.getSpacedPoints(N); Pt.pop(); N = Pt.length;
      var ds = len/N, Tg = [], Up = [], Sd = [], q = new THREE.Quaternion();
      for(var i = 0; i < N; i++) Tg.push(Pt[(i + 1) % N].clone().sub(Pt[(i - 1 + N) % N]).normalize());
      Up[0] = new THREE.Vector3(0, 1, 0).addScaledVector(Tg[0], -Tg[0].y).normalize();
      for(i = 1; i < N; i++){ q.setFromUnitVectors(Tg[i - 1], Tg[i]); var u = Up[i - 1].clone().applyQuaternion(q); u.addScaledVector(Tg[i], -u.dot(Tg[i])).normalize(); Up.push(u); }
      // close the frame: spread whatever twist the lap left over the whole lap
      q.setFromUnitVectors(Tg[N - 1], Tg[0]); var uc = Up[N - 1].clone().applyQuaternion(q);
      var tw = Math.atan2(uc.clone().cross(Up[0]).dot(Tg[0]), uc.dot(Up[0]));
      for(i = 0; i < N; i++){ Up[i].applyAxisAngle(Tg[i], tw*i/N); Sd.push(Up[i].clone().cross(Tg[i]).normalize()); }
      function near(tag){ var p = plan.pts.filter(function(x){ return x.tag === tag; })[0], best = 0, bd = 1e9; for(var j = 0; j < N; j++){ var d = Pt[j].distanceToSquared(new THREE.Vector3(p.x, p.y, p.z)); if(d < bd){ bd = d; best = j; } } return best; }
      var i0 = near("station0"), i1 = near("station1"), iStop = Math.round((i0 + i1 + (i1 < i0 ? N : 0))/2) % N, iLift = near("lift0"), iTop = near("crest");
      // the speed along the lap, from the stop: roll out, the chain, then gravity less friction, then the brakes
      var DWELL = 12, vS = [], Tm = [0], hc = Pt[iTop].y, vTop = 4.2, BRAKE = 45, MU = 0.02;
      var stopAt = 0, liftAt = (iLift - iStop + N) % N, topAt = (iTop - iStop + N) % N;
      for(var j = 0; j < N; j++){
        var k = (iStop + j) % N, v;
        if(j < liftAt) v = 2.6; else if(j <= topAt) v = vTop;
        else v = Math.sqrt(Math.max(9, vTop*vTop + 2*G*(hc - Pt[k].y) - 2*MU*G*(j - topAt)*ds));
        var left = (N - j)*ds; if(left < BRAKE && j > topAt) v = Math.min(v, lerp(2.6, v, left/BRAKE));
        vS.push(v);
      }
      for(j = 1; j <= N; j++) Tm.push(Tm[j - 1] + ds/(0.5*(vS[j - 1] + vS[j % N])));
      var LAP = DWELL + Tm[N];
      function sAt(sec){                                   // samples along from the stop, fractional
        var tau = ((sec % LAP) + LAP) % LAP; if(tau < DWELL) return 0;
        tau -= DWELL; var lo = 0, hi = N;
        while(hi - lo > 1){ var mid = (lo + hi) >> 1; if(Tm[mid] <= tau) lo = mid; else hi = mid; }
        return lo + (tau - Tm[lo])/Math.max(1e-6, Tm[lo + 1] - Tm[lo]);
      }
      function frame(f){                                   // f: samples from the stop -> the track's frame there
        var k0 = Math.floor(f), u = f - k0, a1 = (iStop + k0 + N*4) % N, b1 = (a1 + 1) % N;
        return {p: Pt[a1].clone().lerp(Pt[b1], u), t: Tg[a1].clone().lerp(Tg[b1], u).normalize(), up: Up[a1].clone().lerp(Up[b1], u).normalize(), sd: Sd[a1].clone().lerp(Sd[b1], u).normalize()};
      }
      // the track: two rails and a spine swept along the frames, ties, and supports to the ground
      function sweep(off, r, mat){
        var pos = [], idx = [], RS = 6, step = 2;
        for(var j2 = 0; j2 <= N; j2 += step){
          var k2 = j2 % N, cen = Pt[k2].clone().addScaledVector(Sd[k2], off[0]).addScaledVector(Up[k2], off[1]);
          for(var m2 = 0; m2 < RS; m2++){ var an = m2/RS*TAU, v2 = cen.clone().addScaledVector(Up[k2], Math.cos(an)*r).addScaledVector(Sd[k2], Math.sin(an)*r); pos.push(v2.x, v2.y, v2.z); }
        }
        var rows = pos.length/3/RS;
        for(j2 = 0; j2 < rows - 1; j2++) for(m2 = 0; m2 < RS; m2++){ var a2 = j2*RS + m2, b2 = j2*RS + (m2 + 1) % RS, c2 = a2 + RS, d2 = b2 + RS; idx.push(a2, b2, c2, b2, d2, c2); }
        var geo = new THREE.BufferGeometry(); geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); geo.setIndex(idx); geo.computeVertexNormals();
        var mesh = new THREE.Mesh(geo, mat); mesh.castShadow = true; return mesh;
      }
      var railM = plain(0xe8304a, {metal: 0.5, rough: 0.35, env: 0.6}), spineM = plain(0xf4f1ea, {metal: 0.4, rough: 0.45, env: 0.5});
      var cg = new THREE.Group(); cg.name = "coaster"; pg.add(cg); dynRoots.push(cg);
      cg.add(sweep([0.55, 0], 0.09, railM)); cg.add(sweep([-0.55, 0], 0.09, railM)); cg.add(sweep([0, -0.45], 0.22, spineM));
      var led = sweep([0, -0.72], 0.05, glowMat(0x4fd1ff)); cg.add(led);
      // chase lights down both rails' outsides, a rainbow that runs along the lap by night (the park's bulbs)
      for(i = 0; i < N; i += 3) [-1, 1].forEach(function(sd){ var lp = Pt[i].clone().addScaledVector(Sd[i], sd*0.74).addScaledVector(Up[i], 0.02); bulbs.push({x: lp.x, y: lp.y, z: lp.z, k: (i/N*6) % 1}); });
      track = Pt;
      var nT = Math.floor(N/2.4), ties = new THREE.InstancedMesh(new THREE.BoxGeometry(1.3, 0.12, 0.16), spineM, nT), mx = new THREE.Matrix4(), bas = new THREE.Matrix4();
      for(i = 0; i < nT; i++){ var kk = Math.floor(i*N/nT); bas.makeBasis(Sd[kk], Up[kk], Tg[kk]); mx.copy(bas).setPosition(Pt[kk].clone().addScaledVector(Up[kk], -0.2)); ties.setMatrixAt(i, mx); }
      cg.add(ties);
      var sup = [];
      for(i = 0; i < N; i += 10){
        var p = Pt[i], gyl = ly(p.x, p.z);
        if(p.y - gyl < 2.4 || Up[i].y < 0.3) continue;                      // low track, or the loop's top half
        if(Math.abs(p.x) < 4.6 && p.z < -b*0.5) continue;                    // keep the entrance clear to walk under
        sup.push({x: p.x, z: p.z, y0: gyl, y1: p.y - 0.6});
        hits.push({x: p.x, z: p.z, r: 0.55});
      }
      var supI = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.22, 0.3, 1, 8), spineM, Math.max(1, sup.length)), dm2 = new THREE.Object3D();
      sup.forEach(function(s2, j3){ dm2.position.set(s2.x, (s2.y0 + s2.y1)/2, s2.z); dm2.scale.set(1, s2.y1 - s2.y0, 1); dm2.updateMatrix(); supI.setMatrixAt(j3, dm2.matrix); });
      supI.castShadow = true; cg.add(supI);
      for(i = 0; i < N; i += 4){ var p2 = Pt[i]; if(p2.y - ly(p2.x, p2.z) < 2.4) hits.push({x: p2.x, z: p2.z, r: 1.1}); }   // ground-level track blocks
      var st0 = Pt[iStop];
      // the train: four cars in glossy clearcoat paint, two bucket seats each under shoulder restraints, the
      // front one with a nose and headlights; anchors[] are where riders sit (the front-left seat is yours)
      var paints = [0xff3b5c, 0xffb627, 0x2ec4b6, 0x4361ee], cars = [], anchors = [];
      var leather = plain(0x17181d, {rough: 0.55}), bar = plain(0xffd23f, {metal: 0.3, rough: 0.35}), chrome = M.steel;
      for(i = 0; i < 4; i++){
        var car = new THREE.Group(), paint = new THREE.MeshPhysicalMaterial({color: paints[i], metalness: 0.35, roughness: 0.28, clearcoat: 1, clearcoatRoughness: 0.06, envMap: env, envMapIntensity: 0.9});
        var rings = [{y: 0.12, pts: rrect(1.3, 2.0, 0.3, 5)}, {y: 0.3, pts: rrect(1.56, 2.3, 0.4, 5)}, {y: 0.78, pts: rrect(1.6, 2.36, 0.42, 5)}];
        var tub = new THREE.Mesh(loft(rings, 1, false), paint); tub.castShadow = true; car.add(tub);
        // a chrome lip round the tub's edge (a frame: the seats and riders stay in view)
        [[0, 1.17, 1.64, 0.08], [0, -1.17, 1.64, 0.08], [0.79, 0, 0.08, 2.4], [-0.79, 0, 0.08, 2.4]].forEach(function(f){
          var lip = mbox(f[2], 0.07, f[3], chrome, TILE.steel); lip.position.set(f[0], 0.8, f[1]); car.add(lip); });
        var bogie = mbox(1.2, 0.22, 1.7, chrome, TILE.steel); bogie.position.y = 0.0; car.add(bogie);
        [-0.36, 0.36].forEach(function(sx, si){
          var sb = mbox(0.56, 0.14, 0.55, leather, 1); sb.position.set(sx, 0.5, -0.05); car.add(sb);
          var bk = mbox(0.56, 0.75, 0.14, leather, 1); bk.position.set(sx, 0.9, -0.36); bk.rotation.x = -0.12; car.add(bk);
          var hd = mbox(0.4, 0.3, 0.12, leather, 1); hd.position.set(sx, 1.42, -0.42); car.add(hd);
          var harness = new THREE.Mesh(new THREE.TorusGeometry(0.23, 0.045, 8, 16, PI), bar); harness.position.set(sx, 1.05, -0.12); harness.rotation.set(0, PI/2, PI/2); car.add(harness);
          var an = new THREE.Object3D(); an.position.set(sx, 0.56 - 0.8, -0.02); car.add(an);
          if(!(i === 0 && si === 0)) anchors.push(an);
        });
        if(i === 0){
          var nose = new THREE.Mesh(loft([{y: 0, pts: rrect(1.5, 0.66, 0.24, 4)}, {y: 0.9, pts: rrect(0.8, 0.36, 0.14, 4)}], 1, true), paint);
          nose.rotation.x = PI/2; nose.position.set(0, 0.42, 1.18); car.add(nose);
          [-0.4, 0.4].forEach(function(hx){ var hl = new THREE.Mesh(new THREE.SphereGeometry(0.1, 10, 8), glowMat(0xfff6d8)); hl.position.set(hx, 0.5, 1.75); car.add(hl); });
        }
        cg.add(car); cars.push(car); movers.push(car);
      }
      var CAR_GAP = 2.7/ds, LAP_NAME = "Comet";
      var stP = {x: st0.x - 2.6, z: st0.z - 4};
      // where its station goes: a deck along the inside of the track at the stop, the roof back over the track
      var stationAt = {x: st0.x - 0.95 - 1.7, z: st0.z, yaw: -PI/2, w: 20, d: 3.4, back: 3.2, top: st0.y + 0.25};
      return {
        id: "coaster", name: LAP_NAME, icon: "🎢", accent: "#ff3b5c", entry: stP, exit: {x: st0.x - 2.6, z: st0.z + 7}, stationAt: stationAt, anchors: anchors,
        // the ride you board is the next train out: from its dwell to back in the station
        next: function(sec){ var tau = ((sec % LAP) + LAP) % LAP; return tau < DWELL - 3 ? sec - tau : sec - tau + LAP; },
        dur: LAP, board: DWELL - 1,
        update: function(sec){
          var f = sAt(sec);
          cars.forEach(function(car, ci){ var fr = frame(f - ci*CAR_GAP); car.position.copy(fr.p); bas.makeBasis(fr.sd, fr.up, fr.t); car.quaternion.setFromRotationMatrix(bas); });
        },
        // the track is drawn in the park's frame: the seat goes to the world's, like every other ride's
        // (it was left in the park's, so a rider rode a ghost coaster beside the plaza)
        seat: function(sec){
          var fr = frame(sAt(sec)), M = cg.matrixWorld;
          return {p: fr.p.clone().addScaledVector(fr.up, 1.45).addScaledVector(fr.t, -0.3).applyMatrix4(M),
                  t: fr.t.clone().transformDirection(M), up: fr.up.clone().transformDirection(M)};
        },
        watch: {x: st0.x - 26, z: st0.z + 30, y: 18}
      };
    }
    // the Ferris wheel: 24 gondolas that stay level, a rim of lights
    function wheel(o3){
      var R = o3.R, hub = R + 4.5, wg = new THREE.Group(); wg.position.set(o3.x, ly(o3.x, o3.z), o3.z); pg.add(wg); dynRoots.push(wg);
      var rimM = plain(0xf5f5f5, {metal: 0.6, rough: 0.3, env: 0.8}), rot = new THREE.Group(); rot.position.y = hub; wg.add(rot);
      [-1.6, 1.6].forEach(function(x){ var rim = new THREE.Mesh(new THREE.TorusGeometry(R, 0.28, 8, 96), rimM); rim.rotation.y = PI/2; rim.position.x = x; rot.add(rim);
        for(var i = 0; i < 24; i++){ var an = i/24*TAU, sp = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, R, 4), rimM); sp.position.set(x, Math.cos(an)*R/2, Math.sin(an)*R/2); sp.rotation.x = an; rot.add(sp); } });
      var hubM = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.1, 4, 16), rimM); hubM.rotation.z = PI/2; rot.add(hubM); movers.push(rot);
      [-1, 1].forEach(function(sd){ [-1, 1].forEach(function(fz){ wg.add(tube([[sd*3.2, 0, fz*R*0.5], [sd*2.1, hub, 0]], 0.35, rimM, 6)); hits.push({x: o3.x + sd*3.2, z: o3.z + fz*R*0.5, r: 0.6}); }); });
      var gonds = [], gcols = [0xff4f6d, 0xffd23f, 0x3bceac, 0x5f6bff, 0xff8c42, 0xc86bfa];
      for(var i = 0; i < 24; i++){
        var gd = new THREE.Group(), cab = new THREE.Mesh(new THREE.CylinderGeometry(1.15, 1.0, 1.7, 12), plain(gcols[i % 6], {rough: 0.35, metal: 0.2, env: 0.5}));
        cab.position.y = -1.6; gd.add(cab);
        var gr = new THREE.Mesh(new THREE.ConeGeometry(1.25, 0.6, 12), rimM); gr.position.y = -0.5; gd.add(gr);
        wg.add(gd); gonds.push(gd); movers.push(gd);
      }
      var rimBulbs = [];
      for(i = 0; i < 72; i++){ var an2 = i/72*TAU; rimBulbs.push({x: 0, y: Math.cos(an2)*(R + 0.35), z: Math.sin(an2)*(R + 0.35), k: i/72}); }
      var bI = new THREE.InstancedMesh(new THREE.SphereGeometry(0.2, 6, 5), new THREE.MeshBasicMaterial({color: 0xffffff}), rimBulbs.length), dmw = new THREE.Object3D();
      rimBulbs.forEach(function(p, j){ dmw.position.set(p.x, p.y, p.z); dmw.updateMatrix(); bI.setMatrixAt(j, dmw.matrix); });
      rot.add(bI);
      var PERIOD = 150, w = TAU/PERIOD, col = new THREE.Color();
      function ang(sec, i2){ return ((sec % PERIOD)/PERIOD)*TAU + i2/24*TAU; }
      hits.push({x: o3.x, z: o3.z, r: 1.4});
      return {
        id: "wheel", name: "Skywheel", icon: "🎡", accent: "#3bceac", stationAt: {x: o3.x + 4.2, z: o3.z, yaw: PI/2, w: 8, d: 4, top: ly(o3.x, o3.z) + 2.05}, anchors: [], entry: {x: o3.x + 5, z: o3.z - 2}, exit: {x: o3.x + 5, z: o3.z + 2},
        // a gondola is at the bottom every PERIOD/24 s; ride it all the way round
        next: function(sec){ var per = PERIOD/24, ph = ((sec % per) + per) % per; return sec - ph + per; }, dur: PERIOD, board: 0,
        pick: function(sec){ var best = 0, bd = 9; for(var j = 0; j < 24; j++){ var a2 = ((ang(sec, j) % TAU) + TAU) % TAU, d = Math.min(a2, TAU - a2); if(d < bd){ bd = d; best = j; } } return best; },
        update: function(sec, nt, calm){
          var a0 = ((sec % PERIOD)/PERIOD)*TAU; rot.rotation.x = a0;
          gonds.forEach(function(gd, j){ var an = ang(sec, j); gd.position.set(0, hub - Math.cos(an)*R, -Math.sin(an)*R); });
          if(nt || bI.userData.day !== !nt){
            bI.userData.day = !nt;
            for(var j2 = 0; j2 < rimBulbs.length; j2++){
              if(!nt) col.setRGB(0.85, 0.85, 0.82); else col.setHSL(((rimBulbs[j2].k + (calm ? 0 : sec*0.08)) % 1 + 1) % 1, 1, 0.6);
              bI.setColorAt(j2, col);
            }
            if(bI.instanceColor) bI.instanceColor.needsUpdate = true;
          }
        },
        seat: function(sec, k){ var gd = gonds[k], an = ang(sec, k), p = new THREE.Vector3(0.5, gd.position.y - 1.4, gd.position.z); wg.localToWorld(p);
          var out = new THREE.Vector3(0.75, -0.3, -Math.sin(an)*1.1).normalize().transformDirection(wg.matrixWorld); return {p: p, t: out, up: new THREE.Vector3(0, 1, 0)}; },
        watch: {x: o3.x + R*1.4, z: o3.z - R*0.8, y: 6}, g: wg
      };
    }
    // the drop tower: up slowly, a pause with the whole city below, then a free fall
    function drop(o3){
      var H = o3.H, dg = new THREE.Group(); dg.position.set(o3.x, ly(o3.x, o3.z), o3.z); pg.add(dg); dynRoots.push(dg);
      dg.add(tower(rrect(3.2, 3.2, 0.4, 2), 0, H, 6, null, null, M.steel, TILE.steel));
      var crownM = glowMat(0xff3d7f), crown = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 2.0, 3, 16), crownM); crown.position.y = H + 1.5; dg.add(crown);
      beacon(dg, H + 3.6);
      for(var yb = 2; yb < H; yb += 0.9) [[1, 1], [-1, 1], [-1, -1], [1, -1]].forEach(function(q){ bulbs.push({x: o3.x + q[0]*1.68, y: ly(o3.x, o3.z) + yb, z: o3.z + q[1]*1.68, k: (yb/H*1.5) % 1}); });
      var ringG = new THREE.Group(); dg.add(ringG);
      var ring = new THREE.Mesh(new THREE.TorusGeometry(3.2, 0.5, 8, 32), plain(0xffd23f, {metal: 0.4, rough: 0.3})); ring.rotation.x = PI/2; ringG.add(ring);
      var dropAnchors = [];
      for(var i = 0; i < 12; i++){ var an = i/12*TAU, s2 = new THREE.Mesh(new THREE.BoxGeometry(0.8, 1.2, 0.7), plain(0x22252b)); s2.position.set(Math.cos(an)*3.9, -0.3, Math.sin(an)*3.9); s2.rotation.y = -an; ringG.add(s2);
        if(i % 4){ var da = new THREE.Object3D(); da.position.set(Math.cos(an)*4.25, 0.3 - 0.8, Math.sin(an)*4.25); da.rotation.y = Math.atan2(Math.cos(an), Math.sin(an)); ringG.add(da); dropAnchors.push(da); } }
      hits.push({x: o3.x, z: o3.z, r: 2.6}); movers.push(ringG);
      var CYC = 48, top = H - 5, low = 1.4, BR = 26, tf = Math.sqrt(2*(top - BR)/G);
      function yAt(sec){
        var t = ((sec % CYC) + CYC) % CYC;
        if(t < 10) return low;
        if(t < 26) return lerp(low, top, ease((t - 10)/16));
        if(t < 31) return top;
        if(t < 31 + tf){ var u = t - 31; return top - 0.5*G*u*u; }
        var vb = G*tf, tb = t - 31 - tf, dec = vb*vb/(2*(BR - low));                 // ~1.7 g of brakes
        return tb >= vb/dec ? low : BR - (vb*tb - 0.5*dec*tb*tb);
      }
      // seat 0 faces out of the park, away from its middle
      var face = Math.atan2(-o3.x, -o3.z) + PI;
      return {
        id: "drop", name: "Freefall", icon: "🚀", accent: "#ff3d7f", stationAt: {x: o3.x + 7.2, z: o3.z, yaw: PI/2, w: 7, d: 4, top: ly(o3.x, o3.z) + 1.1}, anchors: dropAnchors, entry: {x: o3.x + 6, z: o3.z}, exit: {x: o3.x + 6, z: o3.z + 2},
        next: function(sec){ var t = ((sec % CYC) + CYC) % CYC; return t < 7 ? sec - t : sec - t + CYC; }, dur: CYC - 2, board: 0,
        update: function(sec){ ringG.position.y = yAt(sec); },
        seat: function(sec){ var p = new THREE.Vector3(Math.sin(face)*4.6, yAt(sec) + 0.6, Math.cos(face)*4.6); dg.localToWorld(p);
          var t = new THREE.Vector3(Math.sin(face), -0.28, Math.cos(face)).transformDirection(dg.matrixWorld); return {p: p, t: t, up: new THREE.Vector3(0, 1, 0)}; },
        watch: {x: o3.x + 24, z: o3.z - 10, y: 8}
      };
    }
    // the carousel: horses that rise and fall under a striped canopy edged in bulbs
    function carousel(o3){
      var r = o3.r, cg2 = new THREE.Group(); cg2.position.set(o3.x, ly(o3.x, o3.z), o3.z); pg.add(cg2); dynRoots.push(cg2);
      var gold = plain(0xd4a52c, {metal: 0.9, rough: 0.25, env: 1}), white = plain(0xfaf7f0, {rough: 0.4});
      var basem = new THREE.Mesh(new THREE.CylinderGeometry(r + 0.4, r + 0.6, 0.5, 40), plain(0x7a1f3d)); basem.position.y = 0.25; cg2.add(basem);
      var spin = new THREE.Group(); cg2.add(spin);
      var deck = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 0.2, 40), plain(0xc9b38a)); deck.position.y = 0.6; spin.add(deck);
      var col = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 0.8, 4.4, 16), gold); col.position.y = 2.8; spin.add(col);
      var stripes = c.canvasTex(256, 32, function(gx){ for(var s2 = 0; s2 < 16; s2++){ gx.fillStyle = s2 % 2 ? "#fff1d6" : "#d7263d"; gx.fillRect(s2*16, 0, 16, 32); } }).t;
      stripes.colorSpace = THREE.SRGBColorSpace;
      var canopy = new THREE.Mesh(new THREE.ConeGeometry(r + 0.8, 2.6, 40, 1, true), new THREE.MeshStandardMaterial({map: stripes, side: THREE.DoubleSide, roughness: 0.6}));
      canopy.position.y = 6.2; spin.add(canopy);
      var horses = [], hb = new THREE.SphereGeometry(0.5, 12, 8), carAnchors = [];
      for(var i = 0; i < 16; i++){
        var ring2 = i < 6 ? 0.52 : 0.84, cnt = i < 6 ? 6 : 10, idx = i < 6 ? i : i - 6, an = idx/cnt*TAU + (i < 6 ? 0.3 : 0);
        var h = new THREE.Group(); h.position.set(Math.cos(an)*r*ring2, 0, Math.sin(an)*r*ring2); h.rotation.y = -an;
        var pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 4.4, 6), gold); pole.position.y = 2.9; h.add(pole);
        var body = new THREE.Group(); h.add(body);
        var torso = new THREE.Mesh(hb, i % 3 === 0 ? plain(0x2b2b2b) : white); torso.scale.set(0.55, 0.5, 1.15); body.add(torso);
        var neck = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.75, 0.3), torso.material); neck.position.set(0, 0.42, 0.48); neck.rotation.x = -0.5; body.add(neck);
        var head = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.28, 0.58), torso.material); head.position.set(0, 0.78, 0.72); body.add(head);
        var saddle = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.1, 0.5), plain([0xd7263d, 0x1b998b, 0x5f6bff][i % 3])); saddle.position.y = 0.28; body.add(saddle);
        [[-0.18, 0.4], [0.18, 0.4], [-0.18, -0.4], [0.18, -0.4]].forEach(function(lg){ var leg = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.7, 5), torso.material); leg.position.set(lg[0], -0.55, lg[1]); leg.rotation.x = lg[1] > 0 ? -0.5 : 0.4; body.add(leg); });
        spin.add(h); horses.push({g: h, body: body, ph: i*0.9}); movers.push(body);
        if(i !== 6 && i % 3 !== 1){ var ca = new THREE.Object3D(); ca.position.set(0, 0.33 - 0.8, -0.05); body.add(ca); carAnchors.push(ca); }
      }
      var edge = [];
      for(i = 0; i < 40; i++){ var an2 = i/40*TAU; edge.push(new THREE.Vector3(Math.cos(an2)*(r + 0.8), 4.9, Math.sin(an2)*(r + 0.8))); }
      var eI = new THREE.InstancedMesh(new THREE.SphereGeometry(0.13, 6, 5), new THREE.MeshBasicMaterial({color: 0xffe9a8}), edge.length), dmc = new THREE.Object3D();
      edge.forEach(function(p, j){ dmc.position.copy(p); dmc.updateMatrix(); eI.setMatrixAt(j, dmc.matrix); }); spin.add(eI);
      hits.push({x: o3.x, z: o3.z, r: r + 0.6});
      var CYC = 64, RUN = 48, W2 = TAU/14;
      function omega(t){ return W2*(t < 4 ? ease(t/4) : t < RUN - 4 ? 1 : t < RUN ? 1 - ease((t - RUN + 4)/4) : 0); }
      var FULL = turned(omega, RUN, RUN);
      function angAt(sec){ var t = ((sec % CYC) + CYC) % CYC; return (Math.floor(sec/CYC) % 1000)*FULL + turned(omega, t, RUN); }
      function bob(sec, k){ return 1.35 + 0.32*Math.sin(sec*2.2 + horses[k].ph); }
      var outer = 6;      // the first outer-ring horse is the one you get
      return {
        id: "carousel", name: "Carousel", icon: "🎠", accent: "#ffd23f", stationAt: {x: o3.x + r + 3.0, z: o3.z, yaw: PI/2, w: 6, d: 3.2, top: ly(o3.x, o3.z) + 0.6}, anchors: carAnchors, entry: {x: o3.x + r + 2.4, z: o3.z}, exit: {x: o3.x + r + 2.4, z: o3.z + 2},
        next: function(sec){ var t = ((sec % CYC) + CYC) % CYC; return t >= RUN ? sec - t + CYC : sec - t + CYC; }, dur: RUN, board: 0,
        update: function(sec){ spin.rotation.y = -angAt(sec); horses.forEach(function(h, k){ h.body.position.y = bob(sec, k); }); },
        seat: function(sec){ var h = horses[outer], p = new THREE.Vector3(0, bob(sec, outer) + 1.05, 0); h.g.localToWorld(p);
          var t = new THREE.Vector3(0, -0.1, 1).transformDirection(h.g.matrixWorld); return {p: p, t: t, up: new THREE.Vector3(0, 1, 0)}; },
        watch: {x: o3.x + r + 9, z: o3.z + 6, y: 4}
      };
    }
    // the wave swinger: chairs flung out on chains under a spinning, tilting crown
    function swinger(o3){
      var rt = o3.r, LC = 6, sg2 = new THREE.Group(); sg2.position.set(o3.x, ly(o3.x, o3.z), o3.z); pg.add(sg2); dynRoots.push(sg2);
      var MH = LC + 1.6, mast = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.2, MH, 16), plain(0x3d5afe, {metal: 0.5, rough: 0.35, env: 0.6})); mast.position.y = MH/2; mast.castShadow = true; sg2.add(mast);
      var top = new THREE.Group(); top.position.y = MH; sg2.add(top);
      var crownT = c.canvasTex(256, 32, function(gx){ for(var s2 = 0; s2 < 16; s2++){ gx.fillStyle = s2 % 2 ? "#ffe066" : "#7b2ff7"; gx.fillRect(s2*16, 0, 16, 32); } }).t;
      crownT.colorSpace = THREE.SRGBColorSpace;
      var hat = new THREE.Mesh(new THREE.ConeGeometry(rt + 1.2, 2.2, 32, 1, true), new THREE.MeshStandardMaterial({map: crownT, side: THREE.DoubleSide, roughness: 0.5})); hat.position.y = 1.4; top.add(hat);
      var rim = new THREE.Mesh(new THREE.TorusGeometry(rt + 1.1, 0.25, 6, 48), glowMat(0xff9de2)); rim.rotation.x = PI/2; rim.position.y = 0.3; top.add(rim);
      var chairs = [], chainM = new THREE.LineBasicMaterial({color: 0x888c93}), swingAnchors = [];
      for(var i = 0; i < 16; i++){
        var arm = new THREE.Group(), an = i/16*TAU; arm.rotation.y = -an; top.add(arm);
        var hang = new THREE.Group(); hang.position.x = rt; arm.add(hang);
        var ch = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.12, 0.6), plain([0xff4f6d, 0x3bceac, 0xffd23f, 0x5f6bff][i % 4])); ch.position.y = -LC; hang.add(ch);
        var bk = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.6, 0.1), ch.material); bk.position.set(0, -LC + 0.3, -0.3); hang.add(bk);   // the back, behind a rider facing the way it travels (+z)
        var cgeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-0.3, 0, 0), new THREE.Vector3(-0.3, -LC, 0), new THREE.Vector3(0.3, 0, 0), new THREE.Vector3(0.3, -LC, 0)]);
        hang.add(new THREE.LineSegments(cgeo, chainM));
        chairs.push({arm: arm, hang: hang}); movers.push(hang);
        if(i){ var sa = new THREE.Object3D(); sa.position.set(0, -LC + 0.06 - 0.8, 0); hang.add(sa); swingAnchors.push(sa); }
      }
      hits.push({x: o3.x, z: o3.z, r: 1.4});
      var CYC = 44, RUN = 36, WMAX = TAU/5.2;
      function omega(t){ return t < 6 ? WMAX*ease(t/6) : t < RUN - 6 ? WMAX : t < RUN ? WMAX*(1 - ease((t - RUN + 6)/6)) : 0; }
      var FULL = turned(omega, RUN, RUN);
      function angAt(sec){ var t = ((sec % CYC) + CYC) % CYC; return (Math.floor(sec/CYC) % 1000)*FULL + turned(omega, t, RUN); }
      function swingAt(sec){ var t = ((sec % CYC) + CYC) % CYC, w = omega(t), th = 0.3;
        for(var it = 0; it < 6; it++) th = Math.atan(w*w*(rt + LC*Math.sin(th))/G); return th; }
      return {
        id: "swing", name: "Starswing", icon: "🌀", accent: "#8d5cf6", stationAt: {x: o3.x + rt + LC*0.85 + 2.7, z: o3.z, yaw: PI/2, w: 6, d: 3.4, top: ly(o3.x, o3.z) + 0.5}, anchors: swingAnchors, entry: {x: o3.x + rt + LC + 3, z: o3.z}, exit: {x: o3.x + rt + LC + 3, z: o3.z + 2},
        next: function(sec){ var t = ((sec % CYC) + CYC) % CYC; return sec - t + CYC; }, dur: RUN, board: 0,
        update: function(sec, nt, calm){
          var t = ((sec % CYC) + CYC) % CYC, th = swingAt(sec);
          top.rotation.y = -angAt(sec);
          top.rotation.z = calm ? 0 : Math.sin(sec*0.5)*0.12*Math.min(1, omega(t)/WMAX);
          chairs.forEach(function(ch){ ch.hang.rotation.z = th; });
        },
        seat: function(sec){ var ch = chairs[0], p = new THREE.Vector3(0, -LC + 0.9, 0); ch.hang.localToWorld(p);
          var t = new THREE.Vector3(0, -0.15, 1).transformDirection(ch.hang.matrixWorld); return {p: p, t: t, up: new THREE.Vector3(0, 1, 0)}; },
        watch: {x: o3.x + rt + LC + 14, z: o3.z - 8, y: 5}
      };
    }

    // The Storm Galleon: a swinging ship on two arms between A-frames, rocked higher each swing to past 70 degrees and
    // back. Its benches step up toward bow and stern, where the drops are biggest; you ride the stern row, facing the mast.
    function galleon(o3){
      var PIV = 12.5, ARM = 9.5, HL = 7, sg3 = new THREE.Group(); sg3.position.set(o3.x, ly(o3.x, o3.z), o3.z); pg.add(sg3); dynRoots.push(sg3);
      var frameM = plain(0x23305c, {metal: 0.6, rough: 0.35, env: 0.6}), goldM = plain(0xe9b949, {metal: 0.85, rough: 0.28, env: 1});
      [-1, 1].forEach(function(sz){
        [-1, 1].forEach(function(sx){ sg3.add(tube([[sx*8.5, 0, sz*4.3], [0, PIV, sz*3.5]], 0.38, frameM, 8)); hits.push({x: o3.x + sx*8.5, z: o3.z + sz*4.3, r: 0.8}); });
        sg3.add(tube([[-4.3, PIV*0.5, sz*3.9], [4.3, PIV*0.5, sz*3.9]], 0.2, frameM, 4));
        var foot = mbox(1.6, 0.35, 1.6, plain(0x9aa0a8, {rough: 0.9}), 1); [-1, 1].forEach(function(sx){ var f2 = foot.clone(); f2.position.set(sx*8.5, 0.15, sz*4.3); sg3.add(f2); });
      });
      var axle = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 7.8, 18), goldM); axle.rotation.x = PI/2; axle.position.y = PIV; sg3.add(axle);
      [-1, 1].forEach(function(sz){ var hubc = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, 0.3, 18), goldM); hubc.rotation.x = PI/2; hubc.position.set(0, PIV, sz*3.95); sg3.add(hubc); });
      var sw = new THREE.Group(); sw.position.y = PIV; sg3.add(sw);
      [-1, 1].forEach(function(sz){ [-1, 1].forEach(function(sx){ sw.add(tube([[0, 0, sz*3.0], [sx*3.4, -ARM + 0.9, sz*2.7]], 0.2, frameM, 6)); }); });
      var ship = new THREE.Group(); ship.position.y = -ARM; sw.add(ship);
      // the hull: a U section swept bow to stern, wide amidships, the gunwale rising to both ends, the keel a little
      function topY(x){ var u = Math.min(1, Math.abs(x)/HL); return 0.75 + 2.2*Math.pow(u, 2.5); }
      function botY(x){ var u = Math.min(1, Math.abs(x)/HL); return -1.1 + 0.9*u*u; }
      function halfW(x){ var u = Math.min(1, Math.abs(x)/HL); return 0.08 + 2.42*Math.pow(Math.max(0, 1 - Math.pow(u, 2.4)), 0.55); }
      function inside(x, y){ var t3 = topY(x), s3 = clamp((t3 - y)/(t3 - botY(x)), 0, 1); return halfW(x)*Math.sqrt(1 - s3*s3); }
      var hullT = c.canvasTex(1024, 256, function(gx){
        gx.fillStyle = "#14213d"; gx.fillRect(0, 0, 1024, 256);
        gx.strokeStyle = "rgba(255,255,255,0.07)"; gx.lineWidth = 2; for(var y4 = 96; y4 < 256; y4 += 14){ gx.beginPath(); gx.moveTo(0, y4); gx.lineTo(1024, y4); gx.stroke(); }
        gx.fillStyle = "#e9b949"; gx.fillRect(0, 0, 1024, 14); gx.fillRect(0, 84, 1024, 8);
        gx.fillStyle = "#9b1d20"; gx.fillRect(0, 14, 1024, 70);
        for(var q4 = 0; q4 < 8; q4++){ var cx4 = 64 + q4*128; gx.fillStyle = "#e9b949"; gx.beginPath(); gx.arc(cx4, 49, 27, 0, TAU); gx.fill();
          gx.fillStyle = q4 % 2 ? "#1d4e89" : "#f4f1de"; gx.beginPath(); gx.arc(cx4, 49, 21, 0, TAU); gx.fill();
          gx.fillStyle = "#e9b949"; gx.beginPath(); for(var k4 = 0; k4 < 10; k4++){ var r4 = k4 % 2 ? 7 : 16, an4 = k4/10*TAU - PI/2; gx.lineTo(cx4 + Math.cos(an4)*r4, 49 + Math.sin(an4)*r4); } gx.fill(); }
      }).t;
      hullT.colorSpace = THREE.SRGBColorSpace; hullT.wrapS = THREE.RepeatWrapping;
      var NX = 36, NV = 14, hp = [], hu = [], hi = [];
      for(var i = 0; i <= NX; i++){ var x = -HL + 2*HL*i/NX, t3 = topY(x), b3 = botY(x), w3 = halfW(x);
        for(var j = 0; j <= NV; j++){ var v = j/NV*PI, cv = Math.cos(v); hp.push(x, t3 - (t3 - b3)*Math.sin(v), w3*cv); hu.push(i/NX*2, Math.abs(cv)); } }
      for(i = 0; i < NX; i++) for(j = 0; j < NV; j++){ var A0 = i*(NV + 1) + j, B0 = A0 + NV + 1; hi.push(A0, B0, A0 + 1, A0 + 1, B0, B0 + 1); }
      var hg = new THREE.BufferGeometry(); hg.setAttribute("position", new THREE.Float32BufferAttribute(hp, 3)); hg.setAttribute("uv", new THREE.Float32BufferAttribute(hu, 2)); hg.setIndex(hi); hg.computeVertexNormals();
      var hull = new THREE.Mesh(hg, new THREE.MeshStandardMaterial({map: hullT, roughness: 0.45, metalness: 0.15, side: THREE.DoubleSide, envMap: env, envMapIntensity: 0.6})); hull.castShadow = true; ship.add(hull);
      // the gunwale's gold rail, lamps along it, and the benches in rows across the deck, stepping up to the ends
      var railPts = [[], []]; for(i = 0; i <= 24; i++){ var xr = -HL*0.97 + 2*HL*0.97*i/24; railPts[0].push([xr, topY(xr) + 0.05, halfW(xr)]); railPts[1].push([xr, topY(xr) + 0.05, -halfW(xr)]); }
      railPts.forEach(function(rp){ ship.add(tube(rp, 0.09, goldM, 48)); });
      for(i = 1; i < 12; i++){ var xl = -HL*0.9 + 2*HL*0.9*i/12; [-1, 1].forEach(function(sz){ var lb = new THREE.Mesh(new THREE.SphereGeometry(0.11, 8, 6), glowMat(0xfff1c4)); lb.position.set(xl, topY(xl) + 0.18, sz*halfW(xl)); ship.add(lb); }); }
      function deckY(x){ return -0.15 + 1.25*Math.pow(Math.max(0, Math.abs(x) - 0.8)/(HL - 0.8), 1.5); }
      var benchM = plain(0x9b1d20, {rough: 0.5}), anchors = [], ROWS = [-5, -3.8, -2.5, -1.2, 1.2, 2.5, 3.8, 5];
      ROWS.forEach(function(xr){
        var sg4 = xr > 0 ? 1 : -1, dy = deckY(xr), hw = inside(xr, dy) - 0.06;
        var plat = mbox(1.3, 0.7, 2*hw, M.deck, TILE.deck); plat.position.set(xr, dy - 0.35, 0); ship.add(plat);
        var seat = mbox(0.5, 0.1, 2*hw - 0.3, benchM, 1); seat.position.set(xr, dy + 0.42, 0); ship.add(seat);
        var back = mbox(0.08, 0.6, 2*hw - 0.3, benchM, 1); back.position.set(xr + sg4*0.26, dy + 0.75, 0); ship.add(back);
        ship.add(tube([[xr - sg4*0.32, dy + 0.75, -hw + 0.2], [xr - sg4*0.32, dy + 0.75, hw - 0.2]], 0.04, goldM, 2));
        for(var zz = -hw + 0.5; zz <= hw - 0.4; zz += 1.25){
          if(Math.abs(zz - 0.3) < 1.0) continue;                                    // the middle aisle: your seat, and a clear view down the deck
          var an = new THREE.Object3D(); an.position.set(xr, dy + 0.47 - 0.8, zz); an.rotation.y = -sg4*PI/2; ship.add(an); anchors.push(an);
        }
      });
      // the mast and its sail (an original compass-star emblem), a crow's nest, a pennant, lanterns, a gold scroll at the bow
      var woodM = plain(0x5b3a24, {rough: 0.8});
      var mast = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.2, 7.6, 10), woodM); mast.position.y = -0.15 + 3.8; ship.add(mast);
      var nest = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.45, 0.5, 12, 1, true), new THREE.MeshStandardMaterial({color: 0x5b3a24, roughness: 0.8, side: THREE.DoubleSide})); nest.position.y = 6.2; ship.add(nest);
      var yard = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 4.6, 8), woodM); yard.rotation.x = PI/2; yard.position.y = 5.5; ship.add(yard);
      var sailT = c.canvasTex(512, 512, function(gx){
        gx.fillStyle = "#f4ead2"; gx.fillRect(0, 0, 512, 512); gx.strokeStyle = "rgba(120,90,50,0.25)"; gx.lineWidth = 3;
        for(var x4 = 64; x4 < 512; x4 += 64){ gx.beginPath(); gx.moveTo(x4, 0); gx.lineTo(x4, 512); gx.stroke(); }
        gx.translate(256, 250); gx.fillStyle = "#9b1d20";
        for(var k4 = 0; k4 < 16; k4++){ var r4 = k4 % 4 === 0 ? 170 : k4 % 2 ? 46 : 105, an4 = k4/16*TAU - PI/2; if(!k4) gx.beginPath(); gx.lineTo(Math.cos(an4)*r4, Math.sin(an4)*r4); }
        gx.closePath(); gx.fill(); gx.fillStyle = "#e9b949"; gx.beginPath(); gx.arc(0, 0, 30, 0, TAU); gx.fill();
      }).t;
      sailT.colorSpace = THREE.SRGBColorSpace;
      var sgeo = new THREE.PlaneGeometry(4.2, 3.4, 8, 6), sp3 = sgeo.attributes.position;
      for(i = 0; i < sp3.count; i++){ var su = sp3.getX(i)/2.1, sv = sp3.getY(i)/1.7; sp3.setZ(i, 0.55*(1 - su*su)*(1 - 0.4*sv*sv)); }
      sgeo.computeVertexNormals();
      var sail = new THREE.Mesh(sgeo, new THREE.MeshStandardMaterial({map: sailT, roughness: 0.85, side: THREE.DoubleSide})); sail.position.set(0.15, 3.7, 0); sail.rotation.y = PI/2 - 0.55; ship.add(sail);
      var pen = new THREE.Mesh(new THREE.ConeGeometry(0.28, 2.2, 3), plain(0x9b1d20, {rough: 0.6})); pen.rotation.z = PI/2; pen.position.set(-1.1, 7.25, 0); ship.add(pen);
      [-1, 1].forEach(function(sx){ var ln = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.5, 0.34), glowMat(0xffb35c)); ln.position.set(sx*(HL - 0.45), topY(HL - 0.45) + 0.45, 0); ship.add(ln); });
      var scroll = new THREE.Mesh(new THREE.TorusGeometry(0.55, 0.13, 8, 24, PI*1.5), goldM); scroll.position.set(HL + 0.1, topY(HL) + 0.1, 0); scroll.rotation.z = -0.6; ship.add(scroll);
      var rig = []; [[-HL + 0.3, topY(HL - 0.3)], [HL - 0.3, topY(HL - 0.3)]].forEach(function(e){ rig.push(new THREE.Vector3(e[0], e[1], 0), new THREE.Vector3(0, 7.3, 0)); });
      ship.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(rig), new THREE.LineBasicMaterial({color: 0x3a2a1a})));
      mergeInto(sw, true);
      mergeInto(sg3, true, function(o){ return o === sw; });
      rectHit(o3.x, o3.z, 0, 21, 6.5);                      // under the swing
      // the motion: rocked up to 75 degrees over 14 s, held, rocked down; the pendulum's own period
      var CYC = 58, RUN = 46, AMAX = 1.3, PER = TAU*Math.sqrt(ARM*1.08/G);
      function amp(t){ return t < 14 ? AMAX*ease(t/14) : t < RUN - 12 ? AMAX : t < RUN ? AMAX*(1 - ease((t - RUN + 12)/12)) : 0; }
      function thAt(sec){ var t = ((sec % CYC) + CYC) % CYC; return t >= RUN ? 0 : amp(t)*Math.sin(TAU*t/PER); }
      var ax = new THREE.Vector3(0, 0, 1), m4 = new THREE.Matrix4();
      function onShip(sec, x, y, z){ return new THREE.Vector3(x, y - ARM, z).applyAxisAngle(ax, thAt(sec)).add(new THREE.Vector3(0, PIV, 0)); }
      return {
        id: "galleon", name: "Storm Galleon", icon: "⚓", accent: "#ffb703",
        stationAt: {x: o3.x, z: o3.z - 8.4, yaw: PI, w: 8, d: 3.4, top: ly(o3.x, o3.z - 8.4) + 0.9}, anchors: anchors,
        entry: {x: o3.x, z: o3.z - 10.6}, exit: {x: o3.x + 2, z: o3.z - 10.6},
        next: function(sec){ var t = ((sec % CYC) + CYC) % CYC; return sec - t + CYC; }, dur: RUN, board: 0,
        update: function(sec){ sw.rotation.z = thAt(sec); },
        seat: function(sec){
          var dy = deckY(-5), p = onShip(sec, -5, dy + 1.5, 0.3), f = onShip(sec, -4, dy + 1.32, 0.3).sub(p).normalize(), up = onShip(sec, -5, dy + 2.5, 0.3).sub(p).normalize();
          sg3.updateMatrixWorld(); m4.extractRotation(sg3.matrixWorld);
          return {p: sg3.localToWorld(p), t: f.applyMatrix4(m4), up: up.applyMatrix4(m4)};
        },
        watch: {x: o3.x + 18, z: o3.z - 14, y: 7}
      };
    }

    // ----- the grounds (HQ 3.6) -----
    // The walkers' loops (the boulevard both ways, the ring, a tour of the stations): the crowd walks them and the
    // scenery keeps off them
    var walkPts = [[[-1.4, -b - 2], [-1.4, b*0.5], [1.4, b*0.5], [1.4, -b - 2]],
                   [[-a*0.58, -b*0.08], [a*0.58, -b*0.08], [a*0.58, b*0.48], [-a*0.58, b*0.48]],
                   rides.map(function(r){ return [r.entry.x, r.entry.z]; }).concat([[0, -b*0.45]]).sort(function(p, q){ return Math.atan2(p[0], p[1]) - Math.atan2(q[0], q[1]); })];
    function segDist(px, pz, x0, z0, x1, z1){ var dx = x1 - x0, dz = z1 - z0, L2 = dx*dx + dz*dz, u = L2 ? clamp(((px - x0)*dx + (pz - z0)*dz)/L2, 0, 1) : 0; return Math.hypot(px - x0 - u*dx, pz - z0 - u*dz); }
    // somewhere clear for a thing r m across: inside the fence, off the paths and the walkers' loops, clear of the rides,
    // their stations and sweeps, and from under the coaster where it runs low
    function clearAt(x, z, r){
      if(Math.abs(x) > a - 2.2 - r || Math.abs(z) > b - 2.2 - r) return false;
      var i, j;
      for(i = 0; i < paved.length; i++){ var q = paved[i]; if(x > q[0] - r - 0.8 && x < q[2] + r + 0.8 && z > q[1] - r - 0.8 && z < q[3] + r + 0.8) return false; }
      for(i = 0; i < hits.length; i++){ var h = hits[i]; if(Math.abs(x - h.x) < h.r + r + 0.8 && Math.hypot(x - h.x, z - h.z) < h.r + r + 0.8) return false; }
      for(i = 0; i < rects.length; i++){ var R3 = rects[i], dx = x - R3.x, dz = z - R3.z; if(Math.abs(dx*R3.c - dz*R3.s) < R3.hw + r + 1 && Math.abs(dx*R3.s + dz*R3.c) < R3.hd + r + 1) return false; }
      for(i = 0; i < zones.length; i++){ var zn = zones[i]; if(Math.abs(x - zn.x) < zn.hw + r && Math.abs(z - zn.z) < zn.hd + r) return false; }
      for(i = 0; i < walkPts.length; i++){ var L = walkPts[i]; for(j = 0; j < L.length; j++){ var p0 = L[j], p1 = L[(j + 1) % L.length]; if(segDist(x, z, p0[0], p0[1], p1[0], p1[1]) < r + 2) return false; } }
      for(i = 0; i < track.length; i += 2){ var t3 = track[i]; if(Math.abs(x - t3.x) < r + 2.6 && Math.abs(z - t3.z) < r + 2.6 && t3.y - ly(t3.x, t3.z) < 13) return false; }
      return true;
    }
    function Hs(k){ return (hash32("park:" + k) % 100000)/100000; }

    // The lagoon: water in a stone coping under the coaster's low pass, ripples on it, lit from below by night, and a
    // dancing fountain in it: eleven jets choreographed on the shared clock, coloured by night
    var lagoon = null;
    if(a >= 32 && b >= 48){
      var lx0 = a*0.36, lz0 = -b*0.66, lrx = Math.min(8, a*0.2), lrz = Math.min(8.5, b*0.14), lo = 1e9, hi2 = -1e9;
      for(var li = 0; li < 24; li++){ var la = li/24*TAU; [0, 0.6, 1.1].forEach(function(f){ var gy2 = ly(lx0 + Math.cos(la)*(lrx + 1)*f, lz0 + Math.sin(la)*(lrz + 1)*f); lo = Math.min(lo, gy2); hi2 = Math.max(hi2, gy2); }); }
      var yw = hi2 + 0.12, WT = {value: 0};
      var cop = new THREE.Shape(); cop.absellipse(0, 0, lrx + 0.9, lrz + 0.9, 0, TAU, false, 0);
      var hole = new THREE.Path(); hole.absellipse(0, 0, lrx, lrz, 0, TAU, true, 0); cop.holes.push(hole);
      var cg3 = new THREE.ExtrudeGeometry(cop, {depth: yw + 0.4 - (lo - 0.3), bevelEnabled: false, curveSegments: 48}); cg3.rotateX(-PI/2);
      var cuv = cg3.attributes.uv; for(var ci = 0; ci < cuv.count; ci++) cuv.setXY(ci, cuv.getX(ci)/TILE.pave, cuv.getY(ci)/TILE.pave);
      var coping = new THREE.Mesh(cg3, M.pave); coping.position.set(lx0, lo - 0.3, lz0); coping.castShadow = coping.receiveShadow = true; pg.add(coping);
      var wm = new THREE.MeshStandardMaterial({color: 0x0b4f66, roughness: 0.08, metalness: 0.05, envMap: env, envMapIntensity: 0.55, emissive: 0x0b4a7a, emissiveIntensity: 0});
      wm.onBeforeCompile = function(sh){
        sh.uniforms.uWT = WT;
        sh.vertexShader = sh.vertexShader.replace("#include <common>", "#include <common>\nvarying vec3 vLW;").replace("#include <begin_vertex>", "#include <begin_vertex>\nvLW = (modelMatrix*vec4(transformed, 1.0)).xyz;");
        sh.fragmentShader = sh.fragmentShader.replace("#include <common>", "#include <common>\nuniform float uWT;\nvarying vec3 vLW;").replace("#include <normal_fragment_maps>",
          "#include <normal_fragment_maps>\nvec2 wq = vLW.xz;\nvec3 wn = vec3(0.06*sin(wq.x*1.9 + uWT*1.4) + 0.04*sin((wq.x + wq.y)*3.1 - uWT*2.3) + 0.02*sin(wq.x*7.0 - uWT*3.7), 0.0,\n" +
          "  0.06*cos(wq.y*1.7 - uWT*1.2) + 0.04*cos((wq.x - wq.y)*2.7 + uWT*1.9) + 0.02*cos(wq.y*6.3 + uWT*3.1));\nnormal = normalize(normal + mat3(viewMatrix)*wn);");
      };
      wm.customProgramCacheKey = function(){ return "hq-lagoon"; };
      var wg3 = new THREE.ShapeGeometry(new THREE.Shape().absellipse(0, 0, lrx + 0.05, lrz + 0.05, 0, TAU, false, 0), 48); wg3.rotateX(-PI/2);
      var water = new THREE.Mesh(wg3, wm); water.position.set(lx0, yw, lz0); water.receiveShadow = true; pg.add(water); dynRoots.push(water);
      // the fountain's basin in the middle and the nozzles round it, ringed in light
      var basin = new THREE.Mesh(new THREE.CylinderGeometry(1.3, 1.5, 0.5, 24), M.pave); basin.position.set(lx0, yw + 0.05, lz0); pg.add(basin);
      var jets = [{x: 0, z: 0}]; for(var ji = 0; ji < 10; ji++){ var ja = ji/10*TAU; jets.push({x: Math.cos(ja)*lrx*0.62, z: Math.sin(ja)*lrz*0.62}); }
      jets.forEach(function(J, k){ var nz = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.22, 0.25, 10), plain(0xc9ccd1, {metal: 0.8, rough: 0.3, env: 0.8})); nz.position.set(lx0 + J.x, yw + (k ? 0.08 : 0.38), lz0 + J.z); pg.add(nz);
        var rg = new THREE.Mesh(new THREE.TorusGeometry(0.32, 0.05, 6, 16), glowMat(0x9fe8ff)); rg.rotation.x = PI/2; rg.position.set(lx0 + J.x, yw + (k ? 0.03 : 0.33), lz0 + J.z); pg.add(rg); });
      var NJ = jets.length, JP = 150, nP = NJ*JP, fpos = new Float32Array(3*nP), fj = new Float32Array(nP), fph = new Float32Array(2*nP), Rf = c.rng(31);
      jets.forEach(function(J, k){ for(var q = 0; q < JP; q++){ var n2 = k*JP + q; fpos[3*n2] = lx0 + J.x; fpos[3*n2 + 1] = yw + (k ? 0.15 : 0.45); fpos[3*n2 + 2] = lz0 + J.z; fj[n2] = k; fph[2*n2] = q/JP; fph[2*n2 + 1] = Rf(); } });
      var fgeo = new THREE.BufferGeometry(); fgeo.setAttribute("position", new THREE.BufferAttribute(fpos, 3)); fgeo.setAttribute("aJet", new THREE.BufferAttribute(fj, 1)); fgeo.setAttribute("aPh", new THREE.BufferAttribute(fph, 2));
      var hs = [], cs = []; for(ji = 0; ji < NJ; ji++){ hs.push(1); cs.push(new THREE.Vector3(1, 1, 1)); }
      var FU = {uT: {value: 0}, uScale: {value: 600}, uNight: {value: 0}, uLean: {value: 0}, uH: {value: hs}, uCol: {value: cs}, uCen: {value: new THREE.Vector3(lx0, yw, lz0)}};
      var fmat = new THREE.ShaderMaterial({uniforms: FU, transparent: true, depthWrite: false,
        vertexShader: ["#define NJ " + NJ, "#define TMAX 3.4", "attribute float aJet; attribute vec2 aPh;", "uniform float uT, uScale, uNight, uLean; uniform float uH[NJ]; uniform vec3 uCol[NJ]; uniform vec3 uCen;",
          "varying vec3 vC; varying float vA;",
          "void main(){",
          "  int j = int(aJet + 0.5); float h = clamp(uH[j], 0.2, 13.5), v0 = sqrt(19.62*h), T = 2.0*v0/9.81;",
          "  float s = fract(uT/TMAX + aPh.x)*TMAX, u = s/T;",
          "  vec2 o = position.xz - uCen.xz; float L = length(o); vec2 d = L > 0.01 ? o/L : vec2(0.0); float an = aPh.y*6.2832;",
          "  vec2 sd = (j == 0 ? 0.0 : uLean)*d*v0*0.32 + vec2(cos(an), sin(an))*(0.1 + 0.22*aPh.y);",
          "  vec3 p = position + vec3(sd.x*s, v0*s - 4.905*s*s, sd.y*s);",
          "  vA = u < 1.0 ? smoothstep(0.0, 0.05, u)*(1.0 - smoothstep(0.82, 1.0, u)) : 0.0;",
          "  vC = mix(vec3(0.93, 0.97, 1.0), uCol[j], uNight);",
          "  vec4 mv = modelViewMatrix*vec4(p, 1.0); gl_Position = projectionMatrix*mv;",
          "  gl_PointSize = vA > 0.01 ? clamp(mix(0.16, 0.42, u)*(j == 0 ? 1.4 : 1.0)*uScale/max(1.0, -mv.z), 1.0, 48.0) : 0.0;",
          "}"].join("\n"),
        fragmentShader: ["uniform float uNight; varying vec3 vC; varying float vA;",
          "void main(){ vec2 q = gl_PointCoord - 0.5; float r2 = dot(q, q)*4.0, g = exp(-r2*3.0); float al = vA*g*mix(0.5, 0.9, uNight); if(al < 0.01) discard; gl_FragColor = vec4(vC*mix(1.0, 1.5, uNight), al); }"].join("\n")});
      var spray = new THREE.Points(fgeo, fmat); spray.frustumCulled = false; spray.renderOrder = 4; pg.add(spray); dynRoots.push(spray);
      spray.onBeforeRender = function(r, sc, cam){ FU.uScale.value = r.domElement.height/(2*Math.tan((cam.fov || 55)*PI/360)); };
      // the choreography: four figures of 36 s, each easing in from the last; steady in Calm
      var jetH = function(sec, j, calm){
        if(calm) return j ? 2.4 : 6;
        function fig(m, t){
          if(m === 0) return j ? 1.4 + 3.4*Math.pow(0.5 + 0.5*Math.sin(t*2.4 - j*0.628), 2) : 7;              // a wave chasing round
          if(m === 1){ var pz = Math.pow(0.5 + 0.5*Math.sin(t*1.7), 3); return j ? 1 + 5*pz : 3 + 9.5*pz; }   // all together, pulsing
          if(m === 2) return j ? 0.6 + 4.8*clamp(0.5 + 1.6*Math.sin(t*PI/1.6 + j*PI), 0, 1) : 5;              // odd and even in turn
          return j ? 3.4 + 0.6*Math.sin(t*3 + j) : 4 + 9*clamp((t % 36)/30, 0, 1);                               // the crown, the centre climbing
        }
        var m = Math.floor(sec/36) % 4, w = ease(((sec % 36) + 36) % 36/3);
        return lerp(fig((m + 3) % 4, sec), fig(m, sec), w);
      };
      hits.push({x: lx0, z: lz0, r: 1});
      for(var gx2 = -lrx - 1; gx2 <= lrx + 1; gx2 += 1.6) for(var gz2 = -lrz - 1; gz2 <= lrz + 1; gz2 += 1.6){
        if((gx2*gx2)/((lrx + 1)*(lrx + 1)) + (gz2*gz2)/((lrz + 1)*(lrz + 1)) <= 1) hits.push({x: lx0 + gx2, z: lz0 + gz2, r: 0.95});
      }
      zones.push({x: lx0, z: lz0, hw: lrx + 2, hd: lrz + 2});
      lagoon = {water: water, wm: wm, WT: WT, FU: FU, spray: spray, fmat: fmat, NJ: NJ, jetH: jetH};
    }

    // The food court: parasol tables by the cotton candy, strung with lights
    var parasolTs = [["#e63946", "#fff4e0"], ["#2a9d8f", "#f1faee"], ["#ffb703", "#fffbea"]].map(function(cp){
      var t = c.canvasTex(256, 32, function(gx){ for(var s2 = 0; s2 < 16; s2++){ gx.fillStyle = s2 % 2 ? cp[1] : cp[0]; gx.fillRect(s2*16, 0, 16, 32); } }).t; t.colorSpace = THREE.SRGBColorSpace; return t; });
    var parasolMs = parasolTs.map(function(t){ return new THREE.MeshStandardMaterial({map: t, roughness: 0.7, side: THREE.DoubleSide}); });
    var tableM = plain(0xf5f1e8, {rough: 0.4}), poleM = plain(0xc9ccd1, {metal: 0.8, rough: 0.35}), stoolM = plain(0x2a9d8f, {rough: 0.5}), tops = [];
    for(var tz = b*0.04; tz <= b*0.32; tz += 3.6) [-a*0.47, -a*0.37].forEach(function(tx){
      if(!clearAt(tx, tz, 1.5)) return;
      var gy3 = ly(tx, tz), tg = new THREE.Group(); tg.position.set(tx, gy3, tz); pg.add(tg);
      var top = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.62, 0.06, 18), tableM); top.position.y = 0.76; tg.add(top);
      var leg = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 2.5, 6), poleM); leg.position.y = 1.25; tg.add(leg);
      for(var sk = 0; sk < 4; sk++){ var sa2 = sk*PI/2 + 0.4, st2 = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.46, 10), stoolM); st2.position.set(Math.cos(sa2)*1.0, 0.23, Math.sin(sa2)*1.0); tg.add(st2); }
      var para = new THREE.Mesh(new THREE.ConeGeometry(1.55, 0.6, 16, 1, true), parasolMs[tops.length % 3]); para.position.y = 2.45; para.castShadow = true; tg.add(para);
      hits.push({x: tx, z: tz, r: 1.1}); tops.push([tx, gy3 + 2.75, tz]);
    });
    for(var ti = 0; ti + 1 < tops.length; ti++){ var t0 = tops[ti], t1 = tops[ti + 1];
      for(var tk = 1; tk < 9; tk++){ var tu = tk/9; bulbs.push({x: lerp(t0[0], t1[0], tu), y: lerp(t0[1], t1[1], tu) - Math.sin(tu*PI)*0.5, z: lerp(t0[2], t1[2], tu), k: (tk + ti*3)/9 % 1}); } }
    if(tops.length) zones.push({x: -a*0.42, z: b*0.18, hw: a*0.08 + 1.6, hd: b*0.16});

    // Trees and flower beds wherever the lawn is clear: blossom and green crowns, beds of one colour each
    var trees = [], beds = [];
    for(var gx3 = -a + 4; gx3 < a - 3; gx3 += 4.4) for(var gz3 = -b + 4; gz3 < b - 3; gz3 += 4.4){
      var key = Math.round(gx3) + ":" + Math.round(gz3), jx = gx3 + (Hs(key + "x") - 0.5)*2.2, jz = gz3 + (Hs(key + "z") - 0.5)*2.2;
      if(trees.length < 90 && Hs(key + "k") < 0.62 && clearAt(jx, jz, 1.9)){ trees.push({x: jx, z: jz, h: 3.2 + Hs(key + "h")*2.6, s: 1.1 + Hs(key + "s")*0.6, c: Hs(key + "c")}); hits.push({x: jx, z: jz, r: 0.35}); }
      else if(beds.length < 40 && clearAt(jx, jz, 1.4)) beds.push({x: jx, z: jz, c: Hs(key + "b")});
    }
    if(trees.length){
      var trunkI = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.15, 0.24, 1, 7), plain(0x6b4a2f, {rough: 0.9}), trees.length);
      var crownI = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), new THREE.MeshStandardMaterial({color: 0xffffff, roughness: 0.85, flatShading: true}), trees.length*3);
      var CROWN = [0xf7a8c4, 0xffc4dd, 0xf28db2, 0x4f9a3a, 0x6bb04c, 0x3f8a4f, 0x7cc35a, 0x5aa04a], dt2 = new THREE.Object3D(), ccol = new THREE.Color();
      trees.forEach(function(t, k){
        var gy4 = ly(t.x, t.z);
        dt2.position.set(t.x, gy4 + t.h*0.5, t.z); dt2.scale.set(1, t.h, 1); dt2.rotation.set(0, 0, 0); dt2.updateMatrix(); trunkI.setMatrixAt(k, dt2.matrix);
        var hex = CROWN[Math.floor(t.c*CROWN.length)];
        for(var q = 0; q < 3; q++){ var qa = q*2.1 + t.c*6, qr = q ? 0.55*t.s : 0;
          dt2.position.set(t.x + Math.cos(qa)*qr, gy4 + t.h + (q ? -0.25 : 0.35)*t.s, t.z + Math.sin(qa)*qr); dt2.scale.setScalar(t.s*(q ? 0.8 : 1.05)); dt2.rotation.set(qa, qa*0.7, 0); dt2.updateMatrix();
          crownI.setMatrixAt(3*k + q, dt2.matrix); ccol.setHex(hex).offsetHSL(0, 0, (q - 1)*0.04); crownI.setColorAt(3*k + q, ccol); }
      });
      trunkI.castShadow = crownI.castShadow = true; crownI.receiveShadow = true; pg.add(trunkI); pg.add(crownI);
    }
    if(beds.length){
      var FLOW = [[0xff4f6d, 0xffd6e0], [0xffd23f, 0xfff4c2], [0x8d5cf6, 0xe6dcff], [0xff8c42, 0xffe0c7], [0xff6fb5, 0xffffff], [0x3a86ff, 0xdbe8ff]];
      var soilI = new THREE.InstancedMesh(new THREE.CylinderGeometry(1.15, 1.25, 0.3, 20), plain(0x4a3426, {rough: 1}), beds.length);
      var edgeI = new THREE.InstancedMesh(new THREE.TorusGeometry(1.24, 0.1, 6, 28), plain(0xd8d2c4, {rough: 0.8}), beds.length);
      var FPB = 46, flowI = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.12, 0), new THREE.MeshStandardMaterial({color: 0xffffff, roughness: 0.6}), beds.length*FPB);
      var leafI = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.2, 0), plain(0x3f8a3a, {rough: 0.9}), beds.length*20);
      var db = new THREE.Object3D(), fc = new THREE.Color();
      beds.forEach(function(bd, k){
        var gy5 = ly(bd.x, bd.z), pal = FLOW[Math.floor(bd.c*FLOW.length)], Rb = c.rng(100 + k);
        db.rotation.set(0, 0, 0); db.scale.setScalar(1); db.position.set(bd.x, gy5 + 0.1, bd.z); db.updateMatrix(); soilI.setMatrixAt(k, db.matrix);
        db.rotation.set(PI/2, 0, 0); db.position.set(bd.x, gy5 + 0.22, bd.z); db.updateMatrix(); edgeI.setMatrixAt(k, db.matrix);
        for(var q = 0; q < FPB; q++){ var fa = Rb()*TAU, fr = Math.sqrt(Rb())*1.0; db.rotation.set(Rb()*3, Rb()*3, 0); db.scale.setScalar(0.8 + Rb()*0.6);
          db.position.set(bd.x + Math.cos(fa)*fr, gy5 + 0.34 + Rb()*0.22, bd.z + Math.sin(fa)*fr); db.updateMatrix(); flowI.setMatrixAt(k*FPB + q, db.matrix);
          fc.setHex(q % 5 === 4 ? pal[1] : pal[0]); flowI.setColorAt(k*FPB + q, fc); }
        for(q = 0; q < 20; q++){ var la2 = Rb()*TAU, lr = Math.sqrt(Rb())*1.0; db.rotation.set(0, Rb()*3, 0); db.scale.setScalar(0.9 + Rb()*0.7);
          db.position.set(bd.x + Math.cos(la2)*lr, gy5 + 0.3, bd.z + Math.sin(la2)*lr); db.updateMatrix(); leafI.setMatrixAt(k*20 + q, db.matrix); }
      });
      [soilI, edgeI, flowI, leafI].forEach(function(im){ im.receiveShadow = true; pg.add(im); });
    }

    // Searchlights: four beams sweeping the night sky, from either side of the gate and the far corners
    var beams = [];
    var beamGeo = new THREE.CylinderGeometry(6, 0.3, 160, 32, 1, true); beamGeo.translate(0, 80, 0);
    var beamM = new THREE.ShaderMaterial({transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, uniforms: {uA: {value: 0}},
      vertexShader: "varying vec2 vUv; varying vec3 vN; varying vec3 vV; void main(){ vUv = uv; vec4 mv = modelViewMatrix*vec4(position, 1.0); vN = normalize(normalMatrix*normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix*mv; }",
      fragmentShader: "uniform float uA; varying vec2 vUv; varying vec3 vN; varying vec3 vV; void main(){ float f = abs(dot(normalize(vN), normalize(vV))); float al = uA*pow(f, 2.5)*pow(1.0 - vUv.y, 1.4); if(al < 0.002) discard; gl_FragColor = vec4(0.78, 0.87, 1.0, al); }"});
    [[-(GATE + 8), -b + 2.5, 0.3], [GATE + 8, -b + 2.5, 2.1], [-(a - 3), b - 3, 3.9], [a - 3, b - 3, 5.3]].forEach(function(q){
      var hg2 = new THREE.Group(); hg2.position.set(q[0], ly(q[0], q[1]), q[1]); pg.add(hg2);
      var drum = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.65, 0.8, 16), plain(0x2c2f36, {metal: 0.7, rough: 0.4})); drum.position.y = 0.4; hg2.add(drum);
      var piv = new THREE.Group(); piv.position.set(q[0], ly(q[0], q[1]) + 0.9, q[1]); pg.add(piv); dynRoots.push(piv);
      var tilt = new THREE.Group(); piv.add(tilt);
      var lens = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.12, 16), glowMat(0xeaf4ff)); tilt.add(lens);
      var beam = new THREE.Mesh(beamGeo, beamM); beam.frustumCulled = false; tilt.add(beam);
      hits.push({x: q[0], z: q[1], r: 0.8}); beams.push({piv: piv, tilt: tilt, beam: beam, ph: q[2]});
    });

    // The fireworks: one Points cloud, every star's flight worked out in its vertex shader from its shell's launch,
    // burst, kind and colours (uniforms, FW_SLOTS shells at once), so a whole show is one draw call. Drawn in the
    // spectacle's own group, so it is seen from across the city when the park itself is not drawn.
    var fwG = new THREE.Group(); fwG.position.copy(pg.position); fwG.rotation.y = pg.rotation.y; g.add(fwG);
    var FW_STARS = 160, FW_TRAIL = 12, fwPer = FW_STARS + FW_TRAIL + 1, fwN = FW_SLOTS*fwPer;
    var fSlot = new Float32Array(fwN), fDir = new Float32Array(3*fwN), fR = new Float32Array(2*fwN), Rw = c.rng(77);
    for(var fs = 0; fs < FW_SLOTS; fs++) for(var fj2 = 0; fj2 < fwPer; fj2++){
      var fk = fs*fwPer + fj2; fSlot[fk] = fs; fR[2*fk] = Rw();
      if(fj2 < FW_STARS){ var fy = 1 - 2*(fj2 + 0.5)/FW_STARS, frad = Math.sqrt(1 - fy*fy), fth = fj2*2.39996 + Rw()*0.25;   // a Fibonacci sphere
        fDir[3*fk] = Math.cos(fth)*frad; fDir[3*fk + 1] = fy; fDir[3*fk + 2] = Math.sin(fth)*frad; }
      else if(fj2 < FW_STARS + FW_TRAIL) fR[2*fk + 1] = -0.02 - (fj2 - FW_STARS)*0.04;     // the rising shell's sparks, each a little behind
      else fR[2*fk + 1] = 1;                                                                 // the flash
    }
    var fwGeo = new THREE.BufferGeometry(); fwGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(3*fwN), 3));
    fwGeo.setAttribute("aSlot", new THREE.BufferAttribute(fSlot, 1)); fwGeo.setAttribute("aDir", new THREE.BufferAttribute(fDir, 3)); fwGeo.setAttribute("aR", new THREE.BufferAttribute(fR, 2));
    function v4s(){ var o4 = []; for(var i4 = 0; i4 < FW_SLOTS; i4++) o4.push(new THREE.Vector4(0, 0, 0, -1e4)); return o4; }
    var WU = {uTime: {value: 0}, uScale: {value: 600}, uA: {value: v4s()}, uB: {value: v4s()}, uC: {value: v4s()}, uD: {value: v4s()}};
    var fwMat = new THREE.ShaderMaterial({uniforms: WU, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: ["#define K " + FW_SLOTS, "#define RISE " + FW_RISE.toFixed(2),
        "attribute float aSlot; attribute vec3 aDir; attribute vec2 aR;",
        "uniform float uTime, uScale; uniform vec4 uA[K]; uniform vec4 uB[K]; uniform vec4 uC[K]; uniform vec4 uD[K];",
        "varying vec3 vCol; varying float vA;",
        "void main(){",
        "  int s = int(aSlot + 0.5); vec4 A = uA[s], B = uB[s], C = uC[s], D = uD[s];",
        "  float t = uTime - A.w, kind = B.w, a = 0.0, size = 1.0; vec3 p = A.xyz; vCol = C.rgb;",
        "  if(aR.y < 0.0){",                                                       // the shell rising, slowing, its sparks behind
        "    float L = -aR.y, tt = t - L, u = clamp((tt + RISE)/RISE, 0.0, 1.0), e = 1.0 - (1.0 - u)*(1.0 - u);",
        "    p = mix(B.xyz, A.xyz, e) + vec3(sin(tt*23.0 + aR.x*6.0), 0.0, cos(tt*19.0))*0.3*L;",
        "    a = (tt > -RISE && tt < 0.0) ? 1.0 - L*1.8 : 0.0; size = mix(0.9, 0.35, L*2.0); vCol = vec3(1.0, 0.72, 0.38);",
        "  } else if(aR.y > 0.5){",                                                // the flash as it bursts, lighting the smoke
        "    a = (t > 0.0 && t < 1.0) ? exp(-t*6.0)*0.32 : 0.0; size = 46.0*C.w; vCol = mix(vec3(1.0), C.rgb, 0.55);",
        "  } else {",
        "    vec3 d = aDir; float sd = D.w*6.2832, cs = cos(sd), sn = sin(sd); d = vec3(d.x*cs - d.z*sn, d.y, d.x*sn + d.z*cs);",
        "    float sp = 25.0*C.w*(0.93 + 0.14*aR.x), k = 1.7, gg = 3.0, life = 3.0;",
        "    if(kind > 0.5 && kind < 1.5){ d = normalize(vec3(d.x, d.y*0.05, d.z)); float tl = D.w*1.4 - 0.7, ct = cos(tl), st = sin(tl); d = vec3(d.x, d.y*ct - d.z*st, d.y*st + d.z*ct); }",
        "    else if(kind > 1.5 && kind < 2.5){ k = 1.2; gg = 6.5; life = 5.0; sp *= 0.85; }",
        "    else if(kind > 2.5 && kind < 3.5){ life = 3.6; }",
        "    float f = (1.0 - exp(-k*t))/k;",
        "    p = A.xyz + d*sp*f + vec3(0.0, -0.5*gg*t*t, 0.0);",
        "    a = t > 0.0 && t < life ? 1.0 - smoothstep(life*0.45, life, t) : 0.0;",
        "    if(kind > 3.5 && t > 0.7) a *= step(0.5, fract(t*7.0 + aR.x*13.0));",
        "    if(kind > 2.5 && kind < 3.5) a *= 0.7 + 0.3*sin(t*40.0 + aR.x*30.0);",
        "    vec3 c2 = (kind > 1.5 && kind < 2.5) ? vec3(1.0, 0.7, 0.28) : D.rgb;",
        "    vCol = mix(vec3(1.0, 0.97, 0.9), mix(C.rgb, c2, smoothstep(0.35, 0.85, t/life + aR.x*0.15)), smoothstep(0.0, 0.2, t));",
        "    size = mix(1.8, 0.9, clamp(t/life, 0.0, 1.0))*C.w;",
        "  }",
        "  vec4 mv = modelViewMatrix*vec4(p, 1.0); gl_Position = projectionMatrix*mv; vA = a;",
        "  gl_PointSize = a > 0.003 ? clamp(size*uScale/max(1.0, -mv.z), 1.5, 240.0) : 0.0;",
        "}"].join("\n"),
      fragmentShader: ["varying vec3 vCol; varying float vA;",
        "void main(){ vec2 q = gl_PointCoord - 0.5; float r2 = dot(q, q)*4.0, g = exp(-r2*3.5), core = exp(-r2*18.0);",
        "  float al = vA*(g*0.8 + core*0.7); if(al < 0.004) discard; gl_FragColor = vec4(vCol*(1.0 + core*0.8), al); }"].join("\n")});
    var fwPts = new THREE.Points(fwGeo, fwMat); fwPts.frustumCulled = false; fwPts.renderOrder = 6; fwPts.visible = false; fwG.add(fwPts);
    fwPts.onBeforeRender = function(r, sc, cam){ WU.uScale.value = r.domElement.height/(2*Math.tan((cam.fov || 55)*PI/360)); };

    // fewer draw calls: every static group to a mesh per material, every moving part merged within itself
    pg.updateMatrixWorld(true);
    movers.forEach(function(mv){ mergeInto(mv, false); });
    var dyn = new Set(dynRoots.concat(balloons));
    mergeInto(pg, true, function(o){ return dyn.has(o); });

    // The crowd: the City's own resident body (games/npcdraw.js: six boxes, the gait in its vertex shader) in one
    // instanced mesh. Walkers stroll three loops (the boulevard both ways, the ring, a tour of the stations), people
    // queue on the station decks and wait at the kiosks, and riders sit in the rides' seats (their anchors). Like
    // the rides, it all runs on the shared clock, so everyone sees the same crowd.
    var crowd = buildCrowd();
    function buildCrowd(){
      var ND = HQV.npcDraw; if(!ND || !ND.bodyGeometry || !ND.bodyMaterial) return null;
      function H(i, k){ return (hash32("crowd:" + i + ":" + k) % 10000)/10000; }
      function loopOf(pts){ var cum = [0]; for(var i = 1; i <= pts.length; i++){ var p0 = pts[i - 1], p1 = pts[i % pts.length]; cum.push(cum[i - 1] + Math.hypot(p1[0] - p0[0], p1[1] - p0[1])); } return {pts: pts, cum: cum, len: cum[pts.length]}; }
      var loops = walkPts.map(loopOf);
      var members = [], NW = 48, i;
      for(i = 0; i < NW; i++) members.push({kind: "walk", loop: loops[i % 3], v: 0.9 + H(i, "v")*0.6, off: H(i, "o"), lat: (H(i, "l") - 0.5)*1.6, dir: i % 3 === 1 && i % 2 ? -1 : 1});
      rides.forEach(function(r){ (r.queue || []).forEach(function(q, j){ if(H(j, r.id) < 0.75) members.push({kind: "stand", x: q.x, y: q.y, z: q.z, yaw: q.yaw}); }); });
      kiosks.forEach(function(k){ k.cust.forEach(function(q){ members.push({kind: "stand", x: q.x, z: q.z, yaw: q.yaw}); }); });
      rides.forEach(function(r){ (r.anchors || []).forEach(function(an){ members.push({kind: "ride", an: an}); }); });
      var Gb = ND.bodyGeometry(), n = members.length, geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(Gb.pos, 3)); geo.setAttribute("normal", new THREE.BufferAttribute(Gb.nrm, 3));
      geo.setIndex(new THREE.BufferAttribute(Gb.idx, 1));
      geo.setAttribute("aPart", new THREE.BufferAttribute(Gb.part, 1)); geo.setAttribute("aLimb", new THREE.BufferAttribute(Gb.limb, 1)); geo.setAttribute("aPivot", new THREE.BufferAttribute(Gb.pivot, 1));
      var gait = new Float32Array(3*n), shirt = new Float32Array(3*n), pants = new Float32Array(3*n), skin = new Float32Array(3*n), col = new THREE.Color();
      var SH = [0xe63946, 0xf4a261, 0x2a9d8f, 0x264653, 0xe9c46a, 0x8d5cf6, 0xff6fb5, 0x3a86ff, 0xffbe0b, 0x06d6a0, 0xef476f, 0x118ab2, 0xf1faee, 0x222831];
      var PA = [0x2b2d42, 0x3d405b, 0x1d3557, 0x6c584c, 0xadb5bd, 0x14213d, 0x5e503f];
      var SK = [0xf1c27d, 0xe0ac69, 0xc68642, 0x8d5524, 0xffdbac, 0x5c3a21];
      members.forEach(function(m, k){
        gait[3*k] = H(k, "ph")*TAU; gait[3*k + 1] = m.kind === "walk" ? m.v/1.5 : 0.3; gait[3*k + 2] = m.kind === "walk" ? 0.55 : m.kind === "ride" ? 0 : 0.04;
        [[shirt, SH], [pants, PA], [skin, SK]].forEach(function(pr, j){ var hx = pr[1][Math.floor(H(k, "c" + j)*pr[1].length)]; if(!j) m.shirtHex = hx;
          col.setHex(hx); pr[0][3*k] = col.r; pr[0][3*k + 1] = col.g; pr[0][3*k + 2] = col.b; });
        m.look = Math.floor(H(k, "char")*Math.max(1, (ND.CHAR_FILES || []).length));
      });
      [["aGait", gait], ["aShirt", shirt], ["aPants", pants], ["aSkin", skin]].forEach(function(at){ geo.setAttribute(at[0], new THREE.InstancedBufferAttribute(at[1], 3)); });
      var U = {uNpcTime: {value: 0}}, mesh = new THREE.InstancedMesh(geo, ND.bodyMaterial(THREE, U), n);
      mesh.frustumCulled = false; mesh.castShadow = true; mesh.name = "funpark:crowd"; g.add(mesh);
      var m4 = new THREE.Matrix4(), q4 = new THREE.Quaternion(), p4 = new THREE.Vector3(), s4 = new THREE.Vector3(1, 1, 1), up = new THREE.Vector3(0, 1, 0);
      var ZERO = new THREE.Matrix4().makeScale(0, 0, 0), Mw = members.map(function(){ return new THREE.Matrix4(); }), wq4 = new THREE.Quaternion(), wp4 = new THREE.Vector3(), ws4 = new THREE.Vector3();
      function walkAt(m, sec){
        var Lp = m.loop, s0 = ((m.off*Lp.len + m.dir*m.v*sec) % Lp.len + Lp.len) % Lp.len, k = 0;
        while(k < Lp.pts.length - 1 && Lp.cum[k + 1] <= s0) k++;
        var p0 = Lp.pts[k], p1 = Lp.pts[(k + 1) % Lp.pts.length], seg = (Lp.cum[k + 1] - Lp.cum[k]) || 1, u = (s0 - Lp.cum[k])/seg;
        var dx = (p1[0] - p0[0])/seg, dz = (p1[1] - p0[1])/seg;
        return {x: p0[0] + (p1[0] - p0[0])*u - dz*m.lat, z: p0[1] + (p1[1] - p0[1])*u + dx*m.lat, yaw: Math.atan2(dx*m.dir, dz*m.dir)};
      }
      // Near: the City's own detailed residents (games/npcdraw.js's near level of detail): the six Kenney
      // characters, skinned, walking / idling / sitting, their clothes tinted by their shirt, for the NEAR_MAX
      // nearest within NEAR m (let go at NEAR_OUT, so the edge does not flicker). Pooled per look and reused;
      // until a look has loaded, and beyond NEAR, a person is the instanced body.
      var CHARS = ND.CHAR_FILES || [], NEAR = 40, NEAR_OUT = 44, NEAR_MAX = 36, SC = 1.7/0.72, TINT = 0.45;
      var free = {}, made = 0, loadingN = 0, held = {};                  // held[member] = character
      function loadChar(k){
        if(!E.loadGlb || !Lb || !CHARS[k] || made + loadingN >= NEAR_MAX + 6) return;
        loadingN++;
        E.loadGlb(Lb, "golf", CHARS[k]).then(function(gl){
          loadingN--; if(dead) return;
          var o = Lb.clone(gl.scene), mixer = new THREE.AnimationMixer(o), acts = {}, ch = {o: o, mixer: mixer, acts: acts, mats: [], cur: null, k: k};
          ["idle", "walk", "sit"].forEach(function(n){ var cl = THREE.AnimationClip.findByName(gl.animations, n); if(cl) acts[n] = mixer.clipAction(cl); });
          o.scale.setScalar(SC);
          o.traverse(function(n){
            if(!n.isMesh) return; n.castShadow = true; n.frustumCulled = false;
            n.material = Array.isArray(n.material) ? n.material.map(function(mm){ return mm.clone(); }) : n.material.clone();
            (Array.isArray(n.material) ? n.material : [n.material]).forEach(function(mm){ if(mm.color) ch.mats.push(mm); });
          });
          made++; (free[k] = free[k] || []).push(ch);
        }, function(){ loadingN--; });
      }
      function anim(ch, n, speed){
        var a2 = ch.acts[n] || ch.acts.idle; if(!a2) return;
        if(ch.cur !== n){ a2.reset().fadeIn(0.25).play(); if(ch.cur && ch.acts[ch.cur] && ch.acts[ch.cur] !== a2) ch.acts[ch.cur].fadeOut(0.25); ch.cur = n; }
        a2.timeScale = speed == null ? 1 : speed;
      }
      function release(k){ var ch = held[k]; if(!ch) return; delete held[k]; g.remove(ch.o); (free[ch.k] = free[ch.k] || []).push(ch); }
      var nearAcc = 1;
      return {mesh: mesh, n: n, members: members, near: function(){ return Object.keys(held).length; }, update: function(sec, dt, cam){
        if(!cam || cam.x == null){ Object.keys(held).forEach(release); return; }      // out of range: nothing to pose
        U.uNpcTime.value = sec % 600;
        var k, m;
        // everyone's pose in the world
        for(k = 0; k < n; k++){
          m = members[k];
          if(m.kind === "ride"){ m.an.updateWorldMatrix(true, false); Mw[k].copy(m.an.matrixWorld); continue; }
          var lx, lz, yaw;
          if(m.kind === "walk"){ var wq = walkAt(m, sec); lx = wq.x; lz = wq.z; yaw = wq.yaw; } else { lx = m.x; lz = m.z; yaw = m.yaw; }
          p4.set(lx, m.y != null ? m.y : ly(lx, lz), lz).applyMatrix4(pg.matrixWorld);
          q4.setFromAxisAngle(up, yaw + P.rot); Mw[k].compose(p4, q4, s4);
        }
        // who is near (a few times a second): nearest first, under NEAR (NEAR_OUT for those already near)
        nearAcc += dt || 0;
        if(cam && cam.x != null && nearAcc > 0.25){
          nearAcc = 0;
          var cand = [];
          for(k = 0; k < n; k++){
            var e3 = Mw[k].elements, dx3 = e3[12] - cam.x, dy3 = e3[13] - (cam.y || 0), dz3 = e3[14] - cam.z, d2 = dx3*dx3 + dy3*dy3 + dz3*dz3, r = held[k] ? NEAR_OUT : NEAR;
            if(d2 < r*r) cand.push([d2, k]);
          }
          cand.sort(function(p, q){ return p[0] - q[0] || p[1] - q[1]; });
          var want = {}; cand.slice(0, NEAR_MAX).forEach(function(c2){ want[c2[1]] = 1; });
          Object.keys(held).forEach(function(kk){ if(!want[kk]) release(kk); });
          Object.keys(want).forEach(function(kk){
            if(held[kk]) return;
            var mm = members[kk], list = free[mm.look];
            if(list && list.length){
              var ch = list.pop(); held[kk] = ch; g.add(ch.o); ch.cur = null;
              var w = new THREE.Color(0xffffff).lerp(new THREE.Color(mm.shirtHex), TINT); ch.mats.forEach(function(mt){ mt.color.copy(w); });
            } else loadChar(mm.look);
          });
        } else if(!cam || cam.x == null){ Object.keys(held).forEach(release); }
        // draw: a detailed character where one is held (its body hidden), the body everywhere else
        for(k = 0; k < n; k++){
          m = members[k]; var chr = held[k];
          if(!chr){ mesh.setMatrixAt(k, Mw[k]); continue; }
          mesh.setMatrixAt(k, ZERO);
          Mw[k].decompose(wp4, wq4, ws4);
          if(m.kind === "ride") wp4.add(up.clone().applyQuaternion(wq4).multiplyScalar(0.35));   // Kenney's sit pose: hips at chair height
          chr.o.position.copy(wp4); chr.o.quaternion.copy(wq4);
          anim(chr, m.kind === "walk" ? "walk" : m.kind === "ride" ? "sit" : "idle", m.kind === "walk" ? m.v/1.4 : 1);
          chr.mixer.update(dt || 0);
        }
        mesh.instanceMatrix.needsUpdate = true;
      }};
    }

    // every bulb in the park: one instanced mesh, coloured by day and chasing by night
    var bulbI = new THREE.InstancedMesh(new THREE.SphereGeometry(0.07, 6, 5), new THREE.MeshBasicMaterial({color: 0xffffff}), Math.max(1, bulbs.length)), dmb = new THREE.Object3D();
    bulbs.forEach(function(p, j){ dmb.position.set(p.x, p.y, p.z); dmb.updateMatrix(); bulbI.setMatrixAt(j, dmb.matrix); });
    pg.add(bulbI);
    // and by night each bulb's glow: soft dots that keep a few pixels across from afar, so the lit park reads from the city
    var glowPos = new Float32Array(3*bulbs.length), glowCol = new Float32Array(3*bulbs.length);
    bulbs.forEach(function(p, j){ glowPos[3*j] = p.x; glowPos[3*j + 1] = p.y; glowPos[3*j + 2] = p.z; });
    var glowGeo = new THREE.BufferGeometry(); glowGeo.setAttribute("position", new THREE.BufferAttribute(glowPos, 3)); glowGeo.setAttribute("color", new THREE.BufferAttribute(glowCol, 3));
    var GU = {uScale: {value: 600}}, glowPts = new THREE.Points(glowGeo, new THREE.ShaderMaterial({uniforms: GU, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: "uniform float uScale; varying vec3 vC; void main(){ vC = color; vec4 mv = modelViewMatrix*vec4(position, 1.0); gl_Position = projectionMatrix*mv; gl_PointSize = clamp(0.8*uScale/max(1.0, -mv.z), 2.0, 64.0); }",
      fragmentShader: "varying vec3 vC; void main(){ vec2 q = gl_PointCoord - 0.5; float r2 = dot(q, q)*4.0; float al = exp(-r2*4.5)*0.7 + exp(-r2*22.0)*0.6; if(al < 0.01) discard; gl_FragColor = vec4(vC*1.25, al); }"}));
    glowPts.frustumCulled = false; glowPts.visible = false; glowPts.renderOrder = 3; pg.add(glowPts);
    glowPts.onBeforeRender = function(r, sc, cam){ GU.uScale.value = r.domElement.height/(2*Math.tan((cam.fov || 55)*PI/360)); };

    // collision in the park's frame: the fence (but the gate's gap), posts, rides and the low track
    var grid = {}, CELL = 8;
    hits.forEach(function(h){ var k = Math.floor(h.x/CELL) + ":" + Math.floor(h.z/CELL); (grid[k] = grid[k] || []).push(h); });
    function blockedL(lx, lz, gateOpen){
      if(lx < -a - 6 || lx > a + 6 || lz < -b - 6 || lz > b + 6) return false;
      for(var j = 0; j < segs.length; j++){
        var s4 = segs[j], dx = s4[2] - s4[0], dz = s4[3] - s4[1], L2 = dx*dx + dz*dz, u = L2 ? clamp(((lx - s4[0])*dx + (lz - s4[1])*dz)/L2, 0, 1) : 0;
        if(Math.hypot(lx - (s4[0] + u*dx), lz - (s4[1] + u*dz)) < 0.45) return true;
      }
      if(!gateOpen && Math.abs(lz + b) < 0.6 && Math.abs(lx) < GATE) return true;     // the turnstile
      for(var q3 = 0; q3 < rects.length; q3++){                                         // stations and kiosks
        var R3 = rects[q3], dx3 = lx - R3.x, dz3 = lz - R3.z;
        if(Math.abs(dx3*R3.c - dz3*R3.s) < R3.hw && Math.abs(dx3*R3.s + dz3*R3.c) < R3.hd) return true;
      }
      var cx2 = Math.floor(lx/CELL), cz2 = Math.floor(lz/CELL);
      for(var ix = -1; ix <= 1; ix++) for(var iz = -1; iz <= 1; iz++){
        var L3 = grid[(cx2 + ix) + ":" + (cz2 + iz)]; if(!L3) continue;
        for(var q2 = 0; q2 < L3.length; q2++) if(Math.hypot(lx - L3[q2].x, lz - L3[q2].z) < L3[q2].r) return true;
      }
      return false;
    }
    return {g: pg, a: a, b: b, crowd: crowd, gate: {x: 0, z: -b - 2.5}, booth: {x: GATE + 4.8, z: -b - 4.6}, rides: rides, bulbs: bulbs, bulbI: bulbI, glows: glows,
            balloons: balloons, blockedL: blockedL, toW: toW, toL: toL, ly: ly, inside: function(lx, lz){ return lx > -a && lx < a && lz > -b && lz < b; },
            fx: {lagoon: lagoon, beams: beams, glowPts: glowPts, glowCol: glowGeo.attributes.color, fwG: fwG, fwPts: fwPts, WU: WU, trees: trees.length, beds: beds.length, tables: tops.length}};
  }

  /* ---------- tickets, rides and the prompt ---------- */
  var riding = null, prompt = null, promptAt = null;   // the park is free for everyone (HQ 3.6): no tickets, the turnstile always open
  function say(t){ if(o.say) o.say(t); }
  function nowSec(){ return Date.now()/1000; }
  function avatarL(){ var me = o.avatar ? o.avatar() : null; return me && park ? {w: me, l: park.toL(me.x, me.z)} : null; }
  function nearest(){
    var A = avatarL(); if(!A || !park) return null;
    var L = A.l, best = null, bd = 3.6;
    function at(kind, p, ride){ var d = Math.hypot(L.x - p.x, L.z - p.z); if(d < bd){ bd = d; best = {kind: kind, ride: ride}; } }
    at("gate", park.gate, null); at("gate", park.booth, null);
    park.rides.forEach(function(r){ at("ride", r.entry, r); });
    return best;
  }
  function board(r){
    var sec = nowSec(), t0 = r.next(sec), k = r.pick ? r.pick(t0) : 0;
    riding = {r: r, t0: t0, until: t0 + r.dur, k: k, waitSaid: false};
    var wait = Math.max(0, Math.round(t0 - sec));
    say(wait > 1 ? r.name + ": the next ride starts in " + wait + " s. Hang on here." : "Hold on tight: " + r.name + "!");
  }
  function leave(done){
    var r = riding && riding.r; riding = null;
    if(!r || !park) return;
    var ex = park.toW(r.exit.x, r.exit.z);
    if(c.teleport) c.teleport(ex.x, ex.z, 0);
    if(done) say("Thanks for riding " + r.name + "!");
  }
  function promptUi(n){
    var text = null;
    if(riding) text = null;
    else if(n && n.kind === "gate"){
      text = "🎡 " + PARK_NAME + " · free entry";
    } else if(n && n.kind === "ride") text = n.ride.icon + " Ride " + n.ride.name + " (E)";
    if(!c.el) return;
    if(!text){ if(prompt) prompt.hidden = true; return; }
    if(!prompt){
      prompt = document.createElement("button"); prompt.type = "button"; prompt.className = "hq3d-ride hq3d-fun";
      prompt.addEventListener("click", function(){ inst.use({}); });
      c.el.appendChild(prompt);
    }
    if(prompt.textContent !== text) prompt.textContent = text;
    prompt.hidden = false;
  }

  var col = new THREE.Color(), lastNightKey = null;
  // The park's grounds and shows each frame (HQ 3.6): the fountain's jets and the lagoon's ripples, its underwater
  // lights by night; the searchlights' sweep; every bulb's glow by night
  function parkFx(sec, cam, calm, mid){
    var F = park.fx, Lg = F.lagoon;
    F.glowPts.visible = night;
    if(Lg){
      Lg.spray.visible = !mid; Lg.WT.value = calm ? 0 : sec % 3600;
      Lg.FU.uT.value = sec % 340; Lg.FU.uLean.value = calm ? 0 : 0.5 + 0.5*Math.sin(sec*0.21);
      for(var j = 0; j < Lg.NJ; j++){
        Lg.FU.uH.value[j] = Lg.jetH(sec, j, calm);
        col.setHSL(((sec*(calm ? 0 : 0.04) + j*0.09) % 1 + 1) % 1, 0.9, 0.62); Lg.FU.uCol.value[j].set(col.r, col.g, col.b);
      }
      Lg.wm.emissiveIntensity = night ? 0.55 : 0; if(night) Lg.wm.emissive.setHSL(((sec*(calm ? 0 : 0.03)) % 1 + 1) % 1, 0.7, 0.35);
    }
    F.beams.forEach(function(bm){
      bm.piv.rotation.y = bm.ph + (calm ? 0 : Math.sin(sec*0.23 + bm.ph)*1.2 + sec*0.05);
      bm.tilt.rotation.x = 0.3 + (calm ? 0 : 0.16*Math.sin(sec*0.31 + bm.ph*2));
      bm.beam.material.uniforms.uA.value = night ? 0.085 : 0;
    });
  }
  // The fireworks: the shells of the show in progress into their slots, a boom for each as it bursts (the sound
  // arriving at the speed of sound), and a word when a show starts. Only by night, never in Calm.
  var fwSaid = -1, fwLast = 0, boomBuf = null;
  function fireworks(sec, cam, calm, dc){
    var F = park.fx, on = night && !calm && (showAt(sec) || showAt(sec - FW_LIVE));
    F.fwPts.visible = !!on; if(!on){ fwLast = sec; return; }
    var base = Math.floor(sec/SHOW_EVERY)*SHOW_EVERY, U = F.WU, sh = showAt(sec);
    U.uTime.value = sec - base;
    for(var i = 0; i < FW_SLOTS; i++) U.uA.value[i].w = -1e4;
    var list = shells(park.a, park.b, sec - FW_LIVE, sec + FW_RISE + 0.05);
    list.forEach(function(s2){
      var A = U.uA.value[s2.slot], B = U.uB.value[s2.slot], C = U.uC.value[s2.slot], D = U.uD.value[s2.slot];
      A.set(s2.burst.x, s2.burst.y, s2.burst.z, s2.t - base); B.set(s2.launch.x, park.ly(s2.launch.x, s2.launch.z) + 0.4, s2.launch.z, s2.k);
      col.setHex(s2.col); C.set(col.r, col.g, col.b, s2.size); col.setHex(s2.col2); D.set(col.r, col.g, col.b, s2.seed);
      if(s2.t > fwLast && s2.t <= sec && cam && cam.x != null){
        var w = park.toW(s2.burst.x, s2.burst.z), d = Math.hypot(w.x - cam.x, park.g.position.y + s2.burst.y - (cam.y || 0), w.z - cam.z);
        if(d < BOOM_M) boom(d, s2.i);
      }
    });
    fwLast = sec;
    if(sh && sh.n !== fwSaid){ fwSaid = sh.n; if(dc < 1600 && sh.t < 5) say("🎆 Fireworks over " + PARK_NAME + "!"); }
  }
  function boom(dist, seed){
    var vol = boomVol(dist); if(!(vol > 0)) return;
    var A = E.ambientOut ? E.ambientOut() : E.audioOut ? E.audioOut() : null; if(!A) return;
    try {
      var ac = A.ctx;
      if(!boomBuf || boomBuf.sampleRate !== ac.sampleRate){
        var n = Math.floor(ac.sampleRate*1.6), r = c.rng(5), last = 0; boomBuf = ac.createBuffer(1, n, ac.sampleRate); var d = boomBuf.getChannelData(0);
        for(var q = 0; q < n; q++){ var tq = q/ac.sampleRate; last = (last + 0.06*(r()*2 - 1))/1.06; d[q] = (last*5 + (tq < 0.03 ? (r()*2 - 1)*0.8 : 0))*Math.exp(-tq*3.2); }
      }
      var src = ac.createBufferSource(), lp = ac.createBiquadFilter(), gn = ac.createGain(), t0 = ac.currentTime + dist/343;
      src.buffer = boomBuf; src.playbackRate.value = 0.8 + (seed % 7)*0.06;
      lp.type = "lowpass"; lp.frequency.value = 260 + 1400*Math.max(0, 1 - dist/BOOM_M);
      gn.gain.value = vol;
      src.connect(lp); lp.connect(gn); gn.connect(A.out); src.start(t0);
    } catch(e){}
  }

  var inst = {
    g: g,
    spec: spec,
    setNight: function(n){
      night = !!n;
      nightMats.forEach(function(x){ x.m.emissiveIntensity = night ? x.night : x.day; if(x.envDay) x.m.envMapIntensity = night ? x.envDay*0.18 : x.envDay; });
      beacons.forEach(function(b){ if(b.flood) b.flood.material.opacity = night ? 0.32 : 0; });
      if(park) park.glows.forEach(function(gl){ gl.material.opacity = night ? 0.75 : 0; });
      if(park && park.fx.lagoon){ var Lg = park.fx.lagoon; Lg.fmat.blending = night ? THREE.AdditiveBlending : THREE.NormalBlending; Lg.fmat.needsUpdate = true; Lg.FU.uNight.value = night ? 1 : 0; }
      if(park) park.fx.beams.forEach(function(bm){ bm.beam.visible = night; });
      lastNightKey = null;
    },
    update: function(t, dt, cam){
      if(dead) return;
      var sec = nowSec(), calm = E.calm();
      // aviation lights: blink by night (steady in Calm), off by day
      var on = night && (calm || (sec % 1.6) < 0.5);
      beacons.forEach(function(b){ if(b.m){ b.m.visible = night; if(b.gl) b.gl.material.opacity = on ? 0.9 : 0; } });
      marks.forEach(function(M2){ var r2 = M2.g.userData.ring; if(r2 && night && !calm) r2.material.emissive.setHSL((sec*0.05) % 1, 0.9, 0.5); });
      if(!park) return;
      // distance: the park's small things (crowd, bulbs, balloons) only near it, the park itself only in sight
      var pc = spec.park, dc = cam && cam.x != null ? Math.hypot(cam.x - pc.x, cam.z - pc.z) : 0, far = !riding && dc > 1100, mid = !riding && dc > 250;
      park.g.visible = !far;
      fireworks(sec, cam, calm, dc);
      if(park.crowd) park.crowd.mesh.visible = !mid;
      park.bulbI.visible = !mid;
      park.balloons.forEach(function(bl){ bl.visible = !mid; });
      if(far){ promptUi(null); return; }
      park.g.updateMatrixWorld();
      park.rides.forEach(function(r){ r.update(sec, night, calm); });
      if(park.crowd && !mid){ park.g.updateMatrixWorld(true); park.crowd.update(sec, dt, cam); }
      else if(park.crowd) park.crowd.update(sec, dt, null);             // let its detailed characters go
      // the bulbs: warm white by day, chasing colours by night (steady in Calm)
      var key = night ? (calm ? "n" : "c" + Math.floor(sec*6)) : "d";
      if(key !== lastNightKey){
        lastNightKey = key;
        park.bulbs.forEach(function(bp, j){
          if(!night) col.setRGB(0.62, 0.6, 0.55); else col.setHSL(((bp.k + (calm ? 0 : sec*0.15)) % 1 + 1) % 1, 0.85, 0.62);
          park.bulbI.setColorAt(j, col);
          park.fx.glowCol.setXYZ(j, col.r, col.g, col.b);
        });
        if(park.bulbI.instanceColor) park.bulbI.instanceColor.needsUpdate = true;
        park.fx.glowCol.needsUpdate = true;
      }
      park.balloons.forEach(function(bl){ var u = bl.userData; bl.position.set(u.bx + (calm ? 0 : Math.sin(sec*0.8 + u.ph)*0.12), park.ly(u.bx, u.bz) + 3.2 + (calm ? 0 : Math.sin(sec*1.1 + u.ph)*0.15), u.bz); });
      parkFx(sec, cam, calm, mid);
      // riding: off at the end of the lap or cycle
      if(riding && sec >= riding.until) leave(true);
      promptUi(riding ? null : nearest());
    },
    blocked: function(x, z){
      for(var i = 0; i < marks.length; i++) for(var j = 0; j < marks[i].polys.length; j++){
        var pp = marks[i].polys[j], bb = pp.b; if(x >= bb.x0 && x <= bb.x1 && z >= bb.z0 && z <= bb.z1 && inPoly(pp.P, x, z)) return true;
      }
      if(!park) return false;
      var L = park.toL(x, z);
      return park.blockedL(L.x, L.z, true);
    },
    use: function(p){
      if(riding){
        var sec = nowSec();
        if(sec < riding.t0){ riding = null; say("You stepped out of the queue."); return true; }
        say("Hold on: you're mid-ride!"); return true;
      }
      var n = nearest(); if(!n) return false;
      if(n.kind === "gate"){ say("Welcome to " + PARK_NAME + "! Entry is free: walk on in."); return true; }
      if(n.kind === "ride"){ board(n.ride); return true; }
      return false;
    },
    // where you are held: on the platform while you wait, then in your seat
    carry: function(){
      if(!riding || !park) return null;
      var sec = nowSec(), r = riding.r;
      if(sec < riding.t0 + r.board){                // waiting your turn at the head of the queue, on the deck
        var q0 = r.queue && r.queue[0], qx = q0 ? q0.x : r.entry.x, qz = q0 ? q0.z : r.entry.z, e = park.toW(qx, qz);
        return {x: e.x, y: park.g.position.y + (q0 ? q0.y : park.ly(qx, qz)), z: e.z, yaw: (q0 ? q0.yaw : 0) + spec.park.rot};
      }
      var s = r.seat(sec, riding.k);
      return {x: s.p.x, y: s.p.y - 1.2, z: s.p.z, yaw: Math.atan2(s.t.x, s.t.z)};
    },
    camPose: function(){
      if(!riding || !park) return null;
      var sec = nowSec(), r = riding.r;
      if(sec < riding.t0 + r.board) return null;
      if(E.calm()){                                   // watch it from the platform, level and still
        var wp = park.toW(r.watch.x, r.watch.z), s0 = r.seat(sec, riding.k);
        return {camera: true, pos: {x: wp.x, y: park.g.position.y + r.watch.y, z: wp.z}, look: {x: s0.p.x, y: s0.p.y, z: s0.p.z}, up: {x: 0, y: 1, z: 0}, fov: 55};
      }
      var s = r.seat(sec, riding.k), eye = s.p.clone(), lk;
      if(r.id === "coaster"){                       // sit back in the second row: the front car and the rails ahead in view
        // your seat: the front car's left one (side = up x forward is the car's +x), eyes ahead of the headrest
        var side = s.up.clone().cross(s.t).normalize();
        eye.addScaledVector(s.t, 0.25).addScaledVector(s.up, 0.15).addScaledVector(side, -0.36);
        lk = s.p.clone().addScaledVector(s.t, 14).addScaledVector(s.up, -2.6);
      } else lk = s.p.clone().addScaledVector(s.t, 12);
      return {camera: true, pos: {x: eye.x, y: eye.y, z: eye.z}, look: {x: lk.x, y: lk.y, z: lk.z}, up: {x: s.up.x, y: s.up.y, z: s.up.z}, fov: r.id === "coaster" ? 80 : 66};
    },
    riding: function(){ return riding ? {id: riding.r.id, name: riding.r.name, t0: riding.t0, until: riding.until} : null; },
    // for tools and tests: a ride's seat at any clock time (s), as {p, t, up}, and its cycle
    seatAt: function(id, sec, k){
      var r = park && park.rides.filter(function(x){ return x.id === id; })[0]; if(!r) return null;
      r.update(sec, night, false); park.g.updateMatrixWorld(true); var s0 = r.seat(sec, k | 0);
      return {p: {x: s0.p.x, y: s0.p.y, z: s0.p.z}, t: {x: s0.t.x, y: s0.t.y, z: s0.t.z}, up: {x: s0.up.x, y: s0.up.y, z: s0.up.z}, next: r.next(sec), dur: r.dur};
    },
    // for tools and tests: the park's frame and its rides
    debug: function(){ return park ? {park: spec.park, rides: park.rides.map(function(r){ return {id: r.id, name: r.name, entry: park.toW(r.entry.x, r.entry.z)}; }), gate: park.toW(park.gate.x, park.gate.z), free: true} : null; },
    destroy: function(){
      dead = true; if(prompt && prompt.parentNode) prompt.parentNode.removeChild(prompt); prompt = null;
      S.remove(g);
      g.traverse(function(x){ if(x.geometry) x.geometry.dispose(); });
    }
  };
  inst.setNight(!!o.night);
  return inst;
}

HQV.hqSpectacle = {boomVol: boomVol, BOOM_M: BOOM_M, claim: claim, create: create, coasterPlan: coasterPlan, TYPES: TYPES, NAMES: NAMES, PARK_NAME: PARK_NAME,
  shells: shells, showAt: showAt, SHOW_EVERY: SHOW_EVERY, SHOW_LEN: SHOW_LEN, FW_SLOTS: FW_SLOTS, FW_RISE: FW_RISE, FW_LIVE: FW_LIVE, FW_KINDS: FW_KINDS,
  PARK_MIN: PARK_MIN, MAX_MARKS: MAX_MARKS, LANDMARK_GAP: LANDMARK_GAP, hash32: hash32};
})();
