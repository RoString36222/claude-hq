/* Claude HQ: the sea round the islands (HQV.ocean): water, the other islands on the horizon, wakes.
 *
 * Pure core (node-tested, tests/test_ocean.py): no THREE and no DOM until mount() is called.
 *   waveAt(x, z, t)              the sea's height (m): three gentle swells, the same sum the water
 *                                shader displaces with (GLSL generated from WAVES), so boats bob on
 *                                the waves you see
 *   setArchipelago(data, current) GET /v1/archipelago's {commons: {world, x, z}, islands: [{owner, name,
 *                                world, x, z, tier}]} (metres; island entries may add docks: [[x, z]],
 *                                metres from their centre, once a doc has been seen) and the world id you
 *                                are on. Everything here is then in that island's frame (it sits at 0, 0).
 *                                -> {dx, dz}: the new island's offset from the old one (subtract it from
 *                                anything you keep, such as the boat, when an island streams in)
 *   nearestIsland(x, z)          the nearest island you are NOT on: {world, owner, name, tier, x, z, dist,
 *                                shore, arrive, dock}; arrive = within ARRIVE.dock m of one of its docks
 *                                (when known), else within ARRIVE.coast m of its coast: time to stream it in
 *   horizon(cx, cz, out)         per-frame impostor placement for a camera at (cx, cz): every other
 *                                island at its bearing, pulled in to HORIZON m (scaled to keep its size
 *                                in view) when further; -> count, out = [x, z, scale, yaw, tier] per island
 *   seaOf(doc, wave, tier)       a WorldDoc v2 (layers.island) as hqboat's sea: {land, docks, y, wave, boat}.
 *                                wave (default) is waveAt at sea and RIVER_Y on the river's water: the river is
 *                                calm, its surface RIVER_Y m over sea level, so a hull floats level on it.
 *                                land(x, z) is the coast polygon minus the river's water (layers.river.poly), plus
 *                                the bridge decks over it (edges with bridge: true, within half their width; with
 *                                `tier`, only those open at that tier): you walk and drive to the bank or over a
 *                                bridge. boat = the same sea for a hull: a bridge deck is not land to it (it
 *                                passes under), everything else is sea.land as it is then (piers added by the City)
 *                                @3 (layers.water): every lake, canal and the marina is water too (off its islands),
 *                                floating at its body's y (body.level, raised to RIVER_Y over the sea when lower: the
 *                                same y games/world.js waterOf gives and the water is drawn at) with no swell; every
 *                                pier and the breakwater (BREAKWATER_HALF m round its line) is land, for people and for
 *                                hulls alike; a bridge over a canal is a deck as over the river. sea.piers lists the piers
 *                                (metres, yaw). A doc without layers.water is exactly as before.
 *   riverOf(doc)                 the river's water polygon (metres) and its bridge decks, or null
 *   waterOf(doc)                 layers.water in metres for the boats: {bodies: [{id, kind, poly, islands, y, inWater(x, z)}],
 *                                piers, onDeck(x, z) (a pier or the breakwater), bodyAt(x, z), coast}, or null
 *   waterHeard(L, coast, calm, seaY) where the water is heard from for ears at L (Sound PR B): the sea's surf on the
 *                                nearest point of the coast, each calm water (calmOf(river, water)) under you or at its
 *                                nearest bank, within WATER_M m -> [{id, x, y, z, lvl}]
 *   wakePush / wakeStrip         a boat's wake as a trail of points, and the strip that draws it
 * material()                    the sea material of the mounted ocean (null when none is), for other water at sea level
 * riverMaterial()               the mounted ocean's calm-water material (null when none is): the sea's own uniforms,
 *                               tint, glint and ripples, but no waves in its vertices. A vertex attribute aLake (0..1;
 *                               absent or 0 on the river) turns it into the calm lake variant: ripples at 35% and more
 *                               of the sky's tint in it (the @3 lakes, games/worldgeom.js waterGeo). The river wears it RIVER_Y m
 *                               over sea level, over the highest crest, so the sea plane under it never shows through
 *                               (a river drawn with waves on its few, far-apart outline vertices had the sea plane's
 *                               crests poke through it in stripes)
 * mount(c, parent) -> {g, step(t, dt, cam), setTime(night), setSun(dir), setRiver(R), setWater(Wd), wake(boats), dispose, drawCalls}:
 * setRiver(riverOf(doc)) lays wakes on the river's calm surface, setWater(waterOf(doc)) on the @3 bodies'; step() also
 * voices the water where it meets you (waterHeard: games/engine.js E.loop "water" in a pool, the nearest two); a polar-grid
 * sea plane that follows the camera (a shader: waves, fresnel sky, sun or moon glint, day/night tint,
 * the scene's fog), island impostors as seven InstancedMeshes (one silhouette, a skyline per tier and one
 * for the Commons: the draw calls stay seven for any number of islands) and a fading foam V behind each boat.
 */
(function(){
"use strict";
var HQV = window.HQV = window.HQV || {};
var PI = Math.PI, G = 9.81;

/* ---------- the waves ---------- */
// [direction (rad, 0 = toward +z), wavelength m, amplitude m, phase]; the speed is deep water's sqrt(g L / 2 pi)
var WAVES = [[0.6, 38, 0.16, 0.0], [2.1, 21, 0.08, 1.3], [-0.9, 11, 0.035, 2.6]];
// the calm river's surface over sea level (m): over the sum of the amplitudes above (0.275 m)
var RIVER_Y = 0.3;
var WK = WAVES.map(function(w){ var k = 2*PI/w[1]; return {dx: Math.sin(w[0])*k, dz: Math.cos(w[0])*k, w: Math.sqrt(G*k), a: w[2], p: w[3]}; });
function waveAt(x, z, t){
  var h = 0; t = +t || 0;
  for(var i = 0; i < WK.length; i++){ var q = WK[i]; h += q.a*Math.sin(q.dx*x + q.dz*z - q.w*t + q.p); }
  return h;
}
// the same sum (and its gradient) in GLSL, from the table above
function f(v){ var s = (+v).toFixed(6); return s.indexOf(".") < 0 ? s + ".0" : s; }
function waveGlsl(){
  var h = [], gx = [], gz = [];
  WK.forEach(function(q){
    var ph = "(" + f(q.dx) + "*p.x + " + f(q.dz) + "*p.y - " + f(q.w) + "*t + " + f(q.p) + ")";
    h.push(f(q.a) + "*sin" + ph); gx.push(f(q.a*q.dx) + "*cos" + ph); gz.push(f(q.a*q.dz) + "*cos" + ph);
  });
  return "float waveH(vec2 p, float t){ return " + h.join(" + ") + "; }\n" +
         "vec2 waveG(vec2 p, float t){ return vec2(" + gx.join(" + ") + ", " + gz.join(" + ") + "); }\n";
}

/* ---------- the archipelago ---------- */
// coast radius (m) of an island and of the Commons; skyline radius per tier; arrival distances;
// impostors further than HORIZON are drawn at HORIZON (inside the camera's 3 km far plane)
var COAST_R = {island: 850, commons: 1000};
var SKY_R = [120, 220, 320, 420, 520];
var ARRIVE = {dock: 400, coast: 300};
var HORIZON = 2400;
var WORLD_RE = /^(claude-hq@[0-9]+|user:[0-9a-f-]{36}@[0-9]+)$/;
var ARCH = {list: [], cur: null, ox: 0, oz: 0, ver: 0};
function num(v){ v = +v; return isFinite(v) ? v : null; }
function hash32(s){ s = String(s); var h = 0x811c9dc5; for(var i = 0; i < s.length; i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; }
function setArchipelago(data, current){
  data = data || {};
  var list = [];
  function addOne(o, commons){
    if(!o || typeof o.world !== "string" || !WORLD_RE.test(o.world)) return;
    var x = num(o.x), z = num(o.z); if(x == null || z == null) return;
    var docks = Array.isArray(o.docks) ? o.docks.filter(function(d){ return Array.isArray(d) && num(d[0]) != null && num(d[1]) != null; })
                                                .map(function(d){ return [+d[0], +d[1]]; }) : null;
    list.push({world: o.world, owner: commons ? "commons" : String(o.owner || ""), name: commons ? "The Commons" : String(o.name || ""),
               x: x, z: z, tier: commons ? 5 : Math.max(1, Math.min(5, o.tier | 0 || 1)), commons: !!commons,
               r: commons ? COAST_R.commons : COAST_R.island, docks: docks && docks.length ? docks : null, yaw: (hash32(o.world) % 6283)/1000});
  }
  addOne(data.commons, true);
  (Array.isArray(data.islands) ? data.islands : []).forEach(function(o){ addOne(o, false); });
  var here = null;
  for(var i = 0; i < list.length; i++) if(list[i].world === current){ here = list[i]; break; }
  var ox = here ? here.x : 0, oz = here ? here.z : 0, shift = {dx: ox - ARCH.ox, dz: oz - ARCH.oz};
  ARCH = {list: list, cur: here ? here.world : null, ox: ox, oz: oz, ver: ARCH.ver + 1};
  return shift;
}
// -> the nearest island you are not on (local frame), or null
function nearestIsland(x, z){
  x = +x || 0; z = +z || 0;
  var best = null, bd = Infinity, L = ARCH.list;
  for(var i = 0; i < L.length; i++){
    var o = L[i]; if(o.world === ARCH.cur) continue;
    var ix = o.x - ARCH.ox, iz = o.z - ARCH.oz, d = Math.hypot(x - ix, z - iz);
    if(d < bd){ bd = d; best = o; }
  }
  if(!best) return null;
  var bx = best.x - ARCH.ox, bz = best.z - ARCH.oz, dock = null, dd = Infinity;
  (best.docks || []).forEach(function(p){ var q = Math.hypot(x - bx - p[0], z - bz - p[1]); if(q < dd){ dd = q; dock = {x: bx + p[0], z: bz + p[1]}; } });
  return {world: best.world, owner: best.owner, name: best.name, tier: best.tier, commons: best.commons, x: bx, z: bz,
          dist: bd, shore: bd - best.r, dock: dock, arrive: dock ? dd < ARRIVE.dock : bd - best.r < ARRIVE.coast};
}
/* Flying on (a helicopter or a plane out over the sea, toward another island; 3.11.1 steadied it): which island,
   with hysteresis. Until 3.11.0 the City armed the nearest island the moment you were past the coast, whatever your
   heading, and every arming said "Flying on to …" and built that City (a long frame); a plane taking off from the
   Commons' offshore airfield was already past the coast, so a circuit round it armed, cancelled and re-armed one
   island after another, and a City you flew half-way toward was swapped in under you. Now: armed only beyond r,
   heading for the island (within FLY_ON.cone) for FLY_ON.dwell ms; cancelled when you turn back (d0 + FLY_ON.cancel)
   or come home (inside r - FLY_ON.home), then that island rests FLY_ON.cool ms; announced at most once a FLY_ON.quiet;
   swapped in only nearer it than here by FLY_ON.swap m and still heading its way.
   S: the state kept between frames (flyOnState()); st: {x, z, vx?, vz?, yaw?, speed?} (local frame); o: {r (m from
   here), now (ms), ok(world)?: may you go there}. -> {arm: S.go when just armed, say, cancel, swap} */
var FLY_ON = {cone: 0.8, dwell: 2000, cancel: 600, home: 150, cool: 20000, quiet: 60000, swap: 150, shore: 1600};
function flyOnState(){ return {go: null, cand: null, off: {}, said: {}}; }
function flyOn(S, st, o){
  var out = {arm: null, say: false, cancel: false, swap: false}, now = +o.now || 0, r = +o.r || 0;
  var x = +st.x || 0, z = +st.z || 0, dh = Math.hypot(x, z), vx = +st.vx || 0, vz = +st.vz || 0, v = Math.hypot(vx, vz), fx = 0, fz = 0;
  if(v > 3){ fx = vx/v; fz = vz/v; }
  else if((+st.speed || 0) > 3 && isFinite(st.yaw)){ fx = Math.sin(st.yaw); fz = Math.cos(st.yaw); }
  function toward(tx, tz){ var d = Math.hypot(tx - x, tz - z); return d > 0 ? (fx*(tx - x) + fz*(tz - z))/d : 1; }
  var g = S.go;
  if(g){
    var dn = Math.hypot(x - g.x, z - g.z);
    if(dn > g.d0 + FLY_ON.cancel || dh < r - FLY_ON.home){ S.off[g.world] = now + FLY_ON.cool; S.go = null; out.cancel = true; return out; }
    out.swap = dn < dh - FLY_ON.swap && toward(g.x, g.z) > 0;
    return out;
  }
  if(dh < r){ S.cand = null; return out; }
  var q = nearestIsland(x, z);
  if(!q || q.shore > FLY_ON.shore || (o.ok && !o.ok(q.world)) || (S.off[q.world] || 0) > now || toward(q.x, q.z) < FLY_ON.cone){ S.cand = null; return out; }
  if(!S.cand || S.cand.world !== q.world){ S.cand = {world: q.world, since: now}; return out; }
  if(now - S.cand.since < FLY_ON.dwell) return out;
  S.cand = null;
  S.go = out.arm = {world: q.world, x: q.x, z: q.z, d0: q.dist, name: q.name || "the island"};
  out.say = !(S.said[q.world] > now - FLY_ON.quiet); S.said[q.world] = now;
  return out;
}
// out: Float32Array (5 per island) or null (one is made); -> {n, out}
function horizon(cx, cz, out){
  var L = ARCH.list, n = 0;
  if(!out || out.length < L.length*5) out = new Float32Array(Math.max(5, L.length*5));
  cx = +cx || 0; cz = +cz || 0;
  for(var i = 0; i < L.length; i++){
    var o = L[i]; if(o.world === ARCH.cur) continue;
    var dx = o.x - ARCH.ox - cx, dz = o.z - ARCH.oz - cz, d = Math.sqrt(dx*dx + dz*dz), s = 1;
    if(d > HORIZON){ s = HORIZON/d; dx *= s; dz *= s; }
    var j = n*5;
    out[j] = cx + dx; out[j + 1] = cz + dz; out[j + 2] = s; out[j + 3] = o.yaw; out[j + 4] = o.commons ? 6 : o.tier;
    n++;
  }
  return {n: n, out: out};
}

/* ---------- a WorldDoc's coast and docks as the boats' sea ---------- */
function inPoly(P, x, z){
  var inside = false;
  for(var i = 0, j = P.length - 1; i < P.length; j = i++){
    var xi = P[i][0], zi = P[i][1], xj = P[j][0], zj = P[j][1];
    if((zi > z) !== (zj > z) && x < (xj - xi)*(z - zi)/(zj - zi) + xi) inside = !inside;
  }
  return inside;
}
// land(x, z): inside any of the coast polygons (metres), a bounding box first
function landTest(polys){
  var P = (polys || []).filter(function(p){ return p && p.length >= 3; }).map(function(p){
    var b = [Infinity, Infinity, -Infinity, -Infinity];
    p.forEach(function(q){ b[0] = Math.min(b[0], q[0]); b[1] = Math.min(b[1], q[1]); b[2] = Math.max(b[2], q[0]); b[3] = Math.max(b[3], q[1]); });
    return {p: p, b: b};
  });
  return function(x, z){
    for(var i = 0; i < P.length; i++){ var b = P[i].b; if(x >= b[0] && x <= b[2] && z >= b[1] && z <= b[3] && inPoly(P[i].p, x, z)) return true; }
    return false;
  };
}
// The dock sites' berths: BERTH_OFF m off the head of the pier games/hqcivic.js lays (pierOf), facing out
// along it: a moored hull (3.6 m at most) lies in open water just clear of the deck, in reach from its
// edge. Without hqcivic (no pier is drawn): off the site's edge on whichever side of its front is
// water, 4 m out, facing out.
var BERTH_OFF = 2.4;
function docksOf(doc, land){
  var L = (doc && doc.layers) || {}, I = L.island || {}, ids = {}, out = [];
  (I.docks || []).forEach(function(id){ ids[id] = 1; });
  land = land || landOf(doc);
  (L.sites || []).forEach(function(s){
    if(!s || !ids[s.id]) return;
    var pier = HQV.hqCivic && HQV.hqCivic.pierOf ? HQV.hqCivic.pierOf(s)[0] : null;
    if(pier){
      out.push({id: s.id, x: pier.head[0] + pier.dir[0]*BERTH_OFF, z: pier.head[1] + pier.dir[1]*BERTH_OFF, yaw: Math.atan2(pier.dir[0], pier.dir[1])});
      return;
    }
    var fr = s.front || [0, 65536], fx = (+fr[0] || 0)/65536, fz = (+fr[1] || 0)/65536, fl = Math.hypot(fx, fz) || 1;
    fx /= fl; fz /= fl;
    var cx = (+s.x || 0)/100, cz = (+s.z || 0)/100, reach = Math.max(+s.w || 0, +s.d || 0)/200 + 4;
    var a = [cx + fx*reach, cz + fz*reach], b = [cx - fx*reach, cz - fz*reach], out1 = !land(a[0], a[1]) || land(b[0], b[1]);
    var p = out1 ? a : b, sg = out1 ? 1 : -1;
    out.push({id: s.id, x: p[0], z: p[1], yaw: Math.atan2(fx*sg, fz*sg)});
  });
  return out;
}
// the river (layers.river, cm) in metres: {poly, inWater(x, z), decks: [{a: [x, z], b: [x, z], h (half width), y, tier}],
// onDeck(x, z, tier)} -- or null when the doc has none. A deck is a bridge edge's segments: within h of one is on it.
function riverOf(doc){
  var L = (doc && doc.layers) || {}, R = L.river;
  if(!R || !Array.isArray(R.poly) || R.poly.length < 3) return null;
  var poly = R.poly.filter(function(p){ return Array.isArray(p) && num(p[0]) != null && num(p[1]) != null; })
                   .map(function(p){ return [+p[0]/100, +p[1]/100]; });
  if(poly.length < 3) return null;
  var inWater = landTest([poly]), D = decksOf(doc);
  return {poly: poly, inWater: inWater, decks: D.decks, onDeck: D.onDeck};
}
// every bridge edge's deck (segments within half its width; min_tier as tier): over the river and the @3 canals
function decksOf(doc){
  var L = (doc && doc.layers) || {}, decks = [];
  ((L.roads && L.roads.edges) || []).forEach(function(e){
    if(!e || !e.bridge || !Array.isArray(e.points)) return;
    var h = (+e.width || 0)/200, t = e.min_tier != null && isFinite(+e.min_tier) ? +e.min_tier : 0;
    for(var i = 0; i + 1 < e.points.length; i++){
      var p = e.points[i], q = e.points[i + 1];
      decks.push({a: [(+p[0] || 0)/100, (+p[2] || 0)/100], b: [(+q[0] || 0)/100, (+q[2] || 0)/100], h: h, y: (+p[1] || 0)/100, tier: t});
    }
  });
  function onDeck(x, z, tier){
    for(var i = 0; i < decks.length; i++){
      var d = decks[i]; if(tier != null && d.tier > tier) continue;
      var ax = d.a[0], az = d.a[1], dx = d.b[0] - ax, dz = d.b[1] - az, L2 = dx*dx + dz*dz;
      var u = L2 > 0 ? Math.max(0, Math.min(1, ((x - ax)*dx + (z - az)*dz)/L2)) : 0;
      if(Math.hypot(x - ax - dx*u, z - az - dz*u) <= d.h) return true;
    }
    return false;
  }
  return {decks: decks, onDeck: onDeck};
}
// layers.water (@3, cm) in metres for the boats: the bodies (CCW not needed: even-odd tests) with their islands and
// the y they float at, the piers and the breakwater as decks, and the coast (coastOf: where the sea meets the island,
// for the surf the mounted ocean voices); null without the layer
var BREAKWATER_HALF = 4;
function waterOf(doc){
  var L = (doc && doc.layers) || {}, Wl = L.water;
  if(!Wl || !Array.isArray(Wl.bodies)) return null;
  var I = L.island || {}, sea = num(I.sea_cm) != null ? +I.sea_cm/100 : null;
  function ring(P){ return (Array.isArray(P) ? P : []).filter(function(p){ return Array.isArray(p) && num(p[0]) != null && num(p[1]) != null; }).map(function(p){ return [+p[0]/100, +p[1]/100]; }); }
  var bodies = [];
  Wl.bodies.forEach(function(b){
    if(!b) return;
    var poly = ring(b.poly);
    if(poly.length < 3) return;
    var level = (num(b.level) || 0)/100, isl = (b.islands || []).map(ring).filter(function(R){ return R.length >= 3; });
    var inPolyT = landTest([poly]), inIsl = landTest(isl);
    bodies.push({id: String(b.id), kind: String(b.kind || "lake"), poly: poly, islands: isl, level: level,
                 y: sea != null && level < sea + RIVER_Y ? sea + RIVER_Y : level,
                 inWater: function(x, z){ return inPolyT(x, z) && !inIsl(x, z); }});
  });
  var piers = (Wl.piers || []).filter(Boolean).map(function(p){
    var f = p.front || [0, 65536], fx = (num(f[0]) || 0)/65536, fz = (num(f[1]) || 0)/65536, fl = Math.hypot(fx, fz) || 1;
    fx /= fl; fz /= fl;
    return {id: String(p.id), body: String(p.body || ""), kind: String(p.kind || ""), x: (num(p.x) || 0)/100, y: (num(p.y) || 0)/100, z: (num(p.z) || 0)/100,
            fx: fx, fz: fz, yaw: Math.atan2(fx, fz), len: (num(p.len) || 0)/100, w: (num(p.w) || 0)/100};
  });
  var bw = ring(Wl.breakwater);
  function onDeck(x, z){
    for(var i = 0; i < piers.length; i++){
      var p = piers[i], dx = x - p.x, dz = z - p.z, a = dx*p.fx + dz*p.fz, c = dx*p.fz - dz*p.fx;
      if(Math.abs(a) <= p.len/2 && Math.abs(c) <= p.w/2) return true;   // (x, z) is the deck's middle
    }
    for(i = 0; i + 1 < bw.length; i++){
      var ax = bw[i][0], az = bw[i][1], ux = bw[i+1][0] - ax, uz = bw[i+1][1] - az, L2 = ux*ux + uz*uz;
      var u = L2 > 0 ? Math.max(0, Math.min(1, ((x - ax)*ux + (z - az)*uz)/L2)) : 0;
      if(Math.hypot(x - ax - ux*u, z - az - uz*u) <= BREAKWATER_HALF) return true;
    }
    return false;
  }
  function bodyAt(x, z){ for(var i = 0; i < bodies.length; i++) if(bodies[i].inWater(x, z)) return bodies[i]; return null; }
  return {bodies: bodies, piers: piers, breakwater: bw.length >= 2 ? bw : null, onDeck: onDeck, bodyAt: bodyAt, coast: coastOf(doc)};
}
function coastOf(doc){
  var I = ((doc && doc.layers) || {}).island || {};
  return (I.coast || []).map(function(p){ return [(+p[0] || 0)/100, (+p[1] || 0)/100]; });
}
// land(x, z) of a doc: its coast, less the river's water, plus the bridge decks (open at `tier`, or every one); @3: less
// every water body, plus every pier and the breakwater (they may stand out past the coast) and the decks over a body
function landOf(doc, tier, R, Wd){
  var coast = landTest([coastOf(doc)]);
  R = R === undefined ? riverOf(doc) : R;
  Wd = Wd === undefined ? waterOf(doc) : Wd;
  if(!R && !Wd) return coast;
  var D = Wd ? (R || decksOf(doc)) : null;
  return function(x, z){
    if(Wd && Wd.onDeck(x, z)) return true;
    if(!coast(x, z)) return false;
    if(R && R.inWater(x, z) && !R.onDeck(x, z, tier)) return false;
    if(Wd && Wd.bodyAt(x, z) && !D.onDeck(x, z, tier)) return false;
    return true;
  };
}
// -> hqboat's sea for this island: {land, docks, y, wave, boat}; tier (optional): the bridges open at that city tier
function seaOf(doc, wave, tier){
  var I = ((doc && doc.layers) || {}).island || {}, R = riverOf(doc), Wd = waterOf(doc), D = Wd ? (R || decksOf(doc)) : null;
  tier = tier != null && isFinite(+tier) ? +tier : null;
  var y0 = (+I.sea_cm || 0)/100;
  // @3: a body's calm y over the sea level (the river's RIVER_Y, or the body's own level)
  function bodyUp(x, z){ var b = Wd ? Wd.bodyAt(x, z) : null; return b ? b.y - y0 : null; }
  var calmWave = R || Wd ? function(x, z, t){ if(R && R.inWater(x, z)) return RIVER_Y; var u = bodyUp(x, z); return u != null ? u : waveAt(x, z, t); } : waveAt;
  var land = landOf(doc, tier, R, Wd), sea = {land: land, docks: docksOf(doc, land), y: y0, wave: wave || calmWave};
  sea.piers = Wd ? Wd.piers.slice() : [];
  // the hull's view: sea.land as it is when asked (the City adds its piers to it), but a bridge deck over the water
  // is open water underneath
  // The water's surface where the hulls float (HQ 3.2): the river's calm level, else sea level plus the swell on the
  // clock the drawn sea runs on (sea.clock: the City sets it every frame to the time it gives the sea's shader; sea.flat
  // in Calm, when the shader draws no swell). Boats, ferries and the seaplane all float on this one function, so
  // nothing bobs out of step with the waves drawn under it (they used to run on a clock of their own from 0).
  // level(x, z): the still water there (the river RIVER_Y up); swell(x, z, t): the waves on it (none on the river)
  sea.clock = null; sea.flat = false;
  sea.level = function(x, z){
    if(R && R.inWater(x, z)) return sea.y + RIVER_Y;
    var u = Wd ? bodyUp(x, z) : null;
    return sea.y + (u != null ? u : 0);
  };
  sea.swell = function(x, z, t){
    if(sea.flat || (R && R.inWater(x, z)) || (Wd && Wd.bodyAt(x, z))) return 0;
    var v = sea.wave(x, z, sea.clock != null ? sea.clock : t); return isFinite(v) ? v : 0;
  };
  sea.surface = function(x, z, t){ return sea.level(x, z) + sea.swell(x, z, t); };
  sea.boat = {docks: sea.docks, y: sea.y, wave: sea.wave, surface: sea.surface,
              land: function(x, z){
                if(!sea.land(x, z)) return false;
                if(R && R.inWater(x, z) && R.onDeck(x, z, tier)) return false;               // under a bridge
                return !(Wd && Wd.bodyAt(x, z) && !Wd.onDeck(x, z) && D.onDeck(x, z, tier));  // under a canal bridge
              }};
  return sea;
}

/* ---------- wakes ---------- */
// trail = {pts: [{x, z, yaw, w, t, a}]}: a point every WAKE.step m (or WAKE.dt s while moving), kept for
// WAKE.life s; the V's arms spread with age and fade out. Time-based: frame-rate independent.
var WAKE = {step: 1.5, dt: 0.25, life: 6, max: 48, spread: 0.6, arm: 0.5};
// across the strip, per point: the left arm's outer edge, crest and inner edge, then the right's inner
// edge, crest and outer edge (offsets from the centreline, m, + = left), and each one's share of the alpha:
// foam on the two crests, a little churned water between them, soft outer edges
var WAKE_A = [0, 1, 0.22, 0.22, 1, 0];
function wakePush(trail, x, z, yaw, speed, t, beam){
  trail = trail || {pts: []};
  var P = trail.pts, last = P[P.length - 1], sp = Math.abs(+speed || 0);
  if(sp > 0.4 && (!last || Math.hypot(x - last.x, z - last.z) >= WAKE.step || t - last.t >= WAKE.dt))
    P.push({x: x, z: z, yaw: yaw, w: (+beam || 1)*0.5, t: t, a: Math.min(1, sp/3)});
  while(P.length && (t - P[0].t > WAKE.life || P.length > WAKE.max)) P.shift();
  return trail;
}
// -> {n (points), k (vertices per point, 6), pos: [x, z] per vertex, newest point first, alpha per vertex}
function wakeStrip(trail, t){
  var P = (trail && trail.pts) || [], pos = [], al = [];
  for(var i = P.length - 1; i >= 0; i--){
    var p = P[i], age = Math.max(0, t - p.t), w = p.w + age*WAKE.spread, cx = Math.cos(p.yaw), sx = Math.sin(p.yaw);
    var m = WAKE.arm, off = [w + m, w, Math.max(0, w - m), -Math.max(0, w - m), -w, -w - m];
    var a = p.a*Math.max(0, 1 - age/WAKE.life);
    for(var j = 0; j < 6; j++){ pos.push(p.x + cx*off[j], p.z - sx*off[j]); al.push(a*WAKE_A[j]); }
  }
  return {n: P.length, k: 6, pos: pos, alpha: al};
}

/* ---------- drawing ---------- */
function ease(k, dt){ return 1 - Math.exp(-Math.max(0, +k || 0)*Math.max(0, +dt || 0)); }
var SEA_R = 3000, RINGS = 56, SEGS = 96;
var TINT = {day: {deep: 0x14507a, shallow: 0x2f8fb3, sky: 0xcfe8f7, sun: 0xfff1d0},
            night: {deep: 0x061a2c, shallow: 0x0f3550, sky: 0x1d3a56, sun: 0x9fb8d8}};
// rings spaced finer near the camera: r_i = SEA_R*(i/RINGS)^2
function seaGeo(THREE){
  var pos = [0, 0, 0], idx = [];
  for(var i = 1; i <= RINGS; i++){
    var r = SEA_R*Math.pow(i/RINGS, 2);
    for(var j = 0; j < SEGS; j++){ var a = j/SEGS*PI*2; pos.push(Math.sin(a)*r, 0, Math.cos(a)*r); }
  }
  for(j = 0; j < SEGS; j++) idx.push(0, 1 + j, 1 + (j + 1) % SEGS);
  for(i = 1; i < RINGS; i++){
    var a0 = 1 + (i - 1)*SEGS, a1 = 1 + i*SEGS;
    for(j = 0; j < SEGS; j++){ var j1 = (j + 1) % SEGS; idx.push(a0 + j, a1 + j, a1 + j1, a0 + j, a1 + j1, a0 + j1); }
  }
  var g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx);
  return g;
}
// sea: the waves displace the vertices; calm (the river): a flat surface with the sea's ripples, tint and glint,
// sharing the sea's uniforms object (pass U), so every per-frame update of the sea's reaches it too
function seaMaterial(THREE, calm, U){
  // calm only: aLake (0 the river, 1 a lake) scales the ripples down and the sky's tint up
  var lakeV = calm ? "attribute float aLake; varying float vLake;\n" : "", lakeF = calm ? "varying float vLake;\n" : "";
  U = U || THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
    uTime: {value: 0}, uNight: {value: 0}, uCam: {value: new THREE.Vector3()},
    uDeep: {value: new THREE.Color()}, uShallow: {value: new THREE.Color()}, uSky: {value: new THREE.Color()}, uSun: {value: new THREE.Color()},
    uSunDir: {value: new THREE.Vector3(0.4, 0.6, 0.3).normalize()}}]);
  return new THREE.ShaderMaterial({uniforms: U, fog: true,
    vertexShader: waveGlsl() +
      "uniform float uTime; uniform vec3 uCam; varying vec3 vW;\n" + lakeV + "#include <fog_pars_vertex>\n" +
      "void main(){ vec4 w = modelMatrix*vec4(position, 1.0); float fade = 1.0 - smoothstep(150.0, 600.0, distance(w.xz, uCam.xz));\n" +
      (calm ? "  vLake = aLake;\n" : "") +
      (calm ? "" : "  w.y += waveH(w.xz, uTime)*fade;\n") +
      "  vW = w.xyz; vec4 mvPosition = viewMatrix*w; gl_Position = projectionMatrix*mvPosition;\n" +
      "  #include <fog_vertex>\n}",
    fragmentShader: waveGlsl() +
      "uniform float uTime; uniform float uNight; uniform vec3 uCam; uniform vec3 uDeep; uniform vec3 uShallow; uniform vec3 uSky; uniform vec3 uSun; uniform vec3 uSunDir;\n" +
      "varying vec3 vW;\n" + lakeF + "#include <fog_pars_fragment>\n" +
      "void main(){ float d = distance(vW.xz, uCam.xz); vec2 gr = waveG(vW.xz, uTime)*(1.0 - smoothstep(400.0, 2500.0, d))" + (calm ? "*mix(1.0, 0.35, vLake)" : "") + ";\n" +
      "  vec3 n = normalize(vec3(-gr.x, 1.0, -gr.y)); vec3 v = normalize(uCam - vW);\n" +
      "  float fr = pow(1.0 - max(dot(n, v), 0.0), 4.0); vec3 col = mix(uDeep, uShallow, 0.35 + 0.65*clamp(n.y*8.0 - 7.0, 0.0, 1.0));\n" +
      "  col = mix(col, uSky, 0.15 + 0.6*fr" + (calm ? " + 0.18*vLake" : "") + "); vec3 h = normalize(uSunDir + v); float sp = pow(max(dot(n, h), 0.0), mix(180.0, 90.0, uNight));\n" +
      "  col += uSun*sp*mix(0.9, 0.35, uNight); gl_FragColor = vec4(col, 1.0);\n" +
      "  #include <fog_fragment>\n}"});
}
// the impostors' shader: vertex colours tinted by day toward a haze, by night dark with lit windows (aGlow)
function impostorMaterial(THREE){
  return new THREE.ShaderMaterial({uniforms: {uNight: {value: 0}, uHaze: {value: new THREE.Color(0xb8cde0)}, uNightHaze: {value: new THREE.Color(0x0d1a28)}},
    vertexColors: true, fog: false,
    vertexShader: "attribute float aGlow; varying vec3 vC; varying float vG;\n" +
      "void main(){ vC = color; vG = aGlow; vec4 p = vec4(position, 1.0);\n#ifdef USE_INSTANCING\n p = instanceMatrix*p;\n#endif\n" +
      " gl_Position = projectionMatrix*modelViewMatrix*p; }",
    fragmentShader: "uniform float uNight; uniform vec3 uHaze; uniform vec3 uNightHaze; varying vec3 vC; varying float vG;\n" +
      "void main(){ vec3 day = mix(vC, uHaze, 0.55); vec3 night = mix(vC*0.15, uNightHaze, 0.5) + vec3(1.0, 0.82, 0.5)*vG*0.9;\n" +
      " gl_FragColor = vec4(mix(day, night, uNight), 1.0); }"});
}
// geometry pieces with a colour and a glow per vertex, merged into one BufferGeometry
function pieces(THREE, list){
  var pos = [], col = [], glow = [], idx = [];
  list.forEach(function(p){
    var g = p.geo, base = pos.length/3, c = new THREE.Color(p.color);
    if(p.m) g.applyMatrix4(p.m);
    var P = g.attributes.position;
    for(var i = 0; i < P.count; i++){ pos.push(P.getX(i), P.getY(i), P.getZ(i)); col.push(c.r, c.g, c.b); glow.push(p.glow ? 1 : 0); }
    if(g.index) for(i = 0; i < g.index.count; i++) idx.push(base + g.index.getX(i));
    else for(i = 0; i < P.count; i++) idx.push(base + i);
  });
  var out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); out.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  out.setAttribute("aGlow", new THREE.Float32BufferAttribute(glow, 1)); out.setIndex(idx);
  return out;
}
// an island's silhouette, radius 1 (scaled by its coast radius): a sand ring and a low green hill, 10 sides
function silhouetteGeo(THREE){
  var M = new THREE.Matrix4();
  return pieces(THREE, [
    {geo: new THREE.CylinderGeometry(0.97, 1.0, 0.012, 10), color: 0xd8c79a, m: M.clone().makeTranslation(0, 0.006, 0)},
    {geo: new THREE.CylinderGeometry(0.45, 0.9, 0.06, 10), color: 0x4f8a4a, m: M.clone().makeTranslation(0, 0.042, 0)}]);
}
// a skyline for tier t (1..5, 6 the Commons): towers on a ring, taller and more of them by tier; a lit window band each
function skylineGeo(THREE, t){
  var n = 2 + t*3, R = SKY_R[Math.min(5, t) - 1], rnd = hash32("sky" + t), list = [];
  for(var i = 0; i < n; i++){
    rnd = Math.imul(rnd ^ (rnd >>> 15), 0x2c1b3c6d) >>> 0;
    var a = i/n*PI*2 + (rnd % 100)/100, r = R*(0.15 + 0.85*((rnd >>> 8) % 1000)/1000), h = 18 + t*14*(0.4 + ((rnd >>> 4) % 600)/1000);
    var w = 16 + (rnd % 18), x = Math.sin(a)*r, z = Math.cos(a)*r, M = new THREE.Matrix4();
    list.push({geo: new THREE.BoxGeometry(w, h, w), color: [0x8c9bab, 0x9aa7b4, 0x7d8b99][i % 3], m: M.clone().makeTranslation(x, 30 + h/2, z)});
    list.push({geo: new THREE.BoxGeometry(w*1.02, h*0.5, w*1.02), color: 0x8c9bab, glow: true, m: M.clone().makeTranslation(x, 30 + h*0.55, z)});
  }
  return pieces(THREE, list);
}

/* ---------- the water's sound (Sound PR B) ---------- */
// Where the water is heard from, for ears at L ({x, z}): the sea's surf at the nearest point of the coast, and each calm
// water ({id, rings, inWater, b (bounds), y or up (over the sea's y), lvl}: calmOf) right under you when you are out on
// it (a boat, a bridge, a pier), else at the nearest point of its banks; only those within WATER_M m of you on the
// ground. -> [{id, x, y, z, lvl}] for the mounted ocean's pool (each a games/engine.js E.loop "water")
var WATER_M = 60;
function nearOnRing(P, x, z, best){
  for(var i = 0, j = P.length - 1; i < P.length; j = i++){
    var ax = P[j][0], az = P[j][1], dx = P[i][0] - ax, dz = P[i][1] - az, L2 = dx*dx + dz*dz;
    var u = L2 > 0 ? Math.max(0, Math.min(1, ((x - ax)*dx + (z - az)*dz)/L2)) : 0, px = ax + dx*u, pz = az + dz*u, d = Math.hypot(x - px, z - pz);
    if(d < best[2]){ best[0] = px; best[1] = pz; best[2] = d; }
  }
  return best;
}
function bounds(P){
  var b = [Infinity, Infinity, -Infinity, -Infinity];
  P.forEach(function(q){ b[0] = Math.min(b[0], q[0]); b[1] = Math.min(b[1], q[1]); b[2] = Math.max(b[2], q[0]); b[3] = Math.max(b[3], q[1]); });
  return b;
}
// the river (riverOf) and the @3 lakes, canals and marina (waterOf's bodies) as calm waters to hear
function calmOf(R, Wd){
  var out = [];
  if(R && R.poly && R.poly.length >= 3) out.push({id: "river", rings: [R.poly], inWater: R.inWater, b: bounds(R.poly), up: RIVER_Y, lvl: 0.6});
  ((Wd && Wd.bodies) || []).forEach(function(B){
    if(B && B.poly && B.poly.length >= 3) out.push({id: B.id, rings: [B.poly].concat(B.islands || []), inWater: B.inWater, b: bounds(B.poly), y: B.y, lvl: 0.5});
  });
  return out;
}
function waterHeard(L, coast, calm, seaY){
  var out = [];
  if(!L || !isFinite(+L.x) || !isFinite(+L.z)) return out;
  var x = +L.x, z = +L.z, y0 = +seaY || 0, b;
  if(coast && coast.length >= 3){ b = nearOnRing(coast, x, z, [0, 0, Infinity]); if(b[2] < WATER_M) out.push({id: "sea", x: b[0], y: y0, z: b[1], lvl: 1}); }
  (calm || []).forEach(function(C){
    if(x < C.b[0] - WATER_M || x > C.b[2] + WATER_M || z < C.b[1] - WATER_M || z > C.b[3] + WATER_M) return;
    var wy = C.y != null ? C.y : y0 + (C.up || 0);
    if(C.inWater && C.inWater(x, z)){ out.push({id: C.id, x: x, y: wy, z: z, lvl: C.lvl}); return; }
    b = [0, 0, Infinity]; C.rings.forEach(function(R){ nearOnRing(R, x, z, b); });
    if(b[2] < WATER_M) out.push({id: C.id, x: b[0], y: wy, z: b[1], lvl: C.lvl});
  });
  return out;
}

// the sea material of the ocean mounted now (null when none is), and its calm twin the river wears (games/worldbuild.js):
// the same uniforms, so the river shows the tint and glint of the sea it meets, without its waves
var LIVE = {mat: null, river: null};
function mount(c, parent){
  var THREE = c.THREE, g = new THREE.Group(); g.name = "ocean"; parent.add(g);
  var seaM = seaMaterial(THREE), sea = new THREE.Mesh(seaGeo(THREE), seaM); sea.frustumCulled = false; sea.renderOrder = -10; g.add(sea);
  // [3.15] where the metro's street works (its wells, stairs and trenches: games/hqmetro.js, drawn first) marked the
  // stencil, the sea under the island is not drawn: you look down a stairwell, not at water 4 m down
  seaM.stencilWrite = true; seaM.stencilWriteMask = 0; seaM.stencilFunc = THREE.NotEqualStencilFunc; seaM.stencilRef = 1;
  var riverM = seaMaterial(THREE, true, seaM.uniforms), river = null, water = null;
  LIVE.mat = seaM; LIVE.river = riverM;
  var impM = impostorMaterial(THREE), cap = 0, sil = null, sky = [], buf = null, seen = -1;
  var night = 0, nightGoal = 0, tmp = {d: new THREE.Color(), n: new THREE.Color()};
  function tint(){
    var U = seaM.uniforms;
    [["uDeep", "deep"], ["uShallow", "shallow"], ["uSky", "sky"], ["uSun", "sun"]].forEach(function(k){
      U[k[0]].value.copy(tmp.d.setHex(TINT.day[k[1]])).lerp(tmp.n.setHex(TINT.night[k[1]]), night);
    });
    U.uNight.value = night; impM.uniforms.uNight.value = night;
  }
  // (re)build the instanced meshes when the archipelago grows past what they hold
  function build(n){
    if(sil){ g.remove(sil); sil.dispose(); sky.forEach(function(m){ g.remove(m); m.dispose(); }); }
    cap = Math.max(8, n);
    sil = new THREE.InstancedMesh(silhouetteGeo(THREE), impM, cap); sil.frustumCulled = false; sil.count = 0; g.add(sil);
    sky = [1, 2, 3, 4, 5, 6].map(function(t){ var m = new THREE.InstancedMesh(skylineGeo(THREE, t), impM, cap); m.frustumCulled = false; m.count = 0; g.add(m); return m; });
  }
  build(ARCH.list.length);
  // one matrix: yaw about y, uniform scale, at (x, y, z)
  function put(m, i, x, y, z, s, yaw){
    var e = m.instanceMatrix.array, o = i*16, cy = Math.cos(yaw)*s, sy = Math.sin(yaw)*s;
    e[o] = cy; e[o + 1] = 0; e[o + 2] = -sy; e[o + 3] = 0; e[o + 4] = 0; e[o + 5] = s; e[o + 6] = 0; e[o + 7] = 0;
    e[o + 8] = sy; e[o + 9] = 0; e[o + 10] = cy; e[o + 11] = 0; e[o + 12] = x; e[o + 13] = y; e[o + 14] = z; e[o + 15] = 1;
  }
  function impostors(cx, cz){
    if(ARCH.ver !== seen){ seen = ARCH.ver; if(ARCH.list.length > cap) build(ARCH.list.length); }
    var H = horizon(cx, cz, buf); buf = H.out;
    var counts = [0, 0, 0, 0, 0, 0], ns = 0, by = H.out;
    for(var i = 0; i < H.n; i++){
      var j = i*5, x = by[j], z = by[j + 1], s = by[j + 2], yaw = by[j + 3], t = by[j + 4] | 0, R = t === 6 ? COAST_R.commons : COAST_R.island;
      put(sil, ns++, x, 0, z, R*s, yaw);
      var m = sky[t - 1]; put(m, counts[t - 1]++, x, 0, z, s, yaw);
    }
    sil.count = ns; sil.instanceMatrix.needsUpdate = true;
    sky.forEach(function(m, k){ m.count = counts[k]; m.instanceMatrix.needsUpdate = true; });
    return H.n;
  }
  // [Sound PR B] the water heard where it meets you (waterHeard): the sea on the coast (setWater's coast), the river and
  // the calm waters at their banks; each an E.loop "water" (the Ambient sounds volume: full within 4 m, gone past 60 m),
  // the nearest two. An older engine: silent, as before.
  var E = c.E || {}, coast = null, stillW = [];
  var waterP = E.pool && E.loop && E.listenerAt ? E.pool("water", {voices: 2, make: function(){ return E.loop("water"); },
    play: function(h, s){ h.set(s.lvl, {pos: s}); }}) : null;
  // wakes: one ribbon per boat id, rebuilt from its trail each frame
  var wakeM = new THREE.MeshBasicMaterial({color: 0xf4fbff, vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: true});
  var wakes = {}, clock = 0;
  function ribbon(){
    var geo = new THREE.BufferGeometry(), n = WAKE.max*6;
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n*3), 3));
    geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(n*4), 4));
    var idx = [];
    for(var i = 0; i < WAKE.max - 1; i++) for(var j = 0; j < 5; j++){ var a = i*6 + j, b = a + 6; idx.push(a, b, a + 1, a + 1, b, b + 1); }
    geo.setIndex(idx); geo.setDrawRange(0, 0);
    var m = new THREE.Mesh(geo, wakeM); m.frustumCulled = false; m.renderOrder = -9; g.add(m);
    return {m: m, trail: {pts: []}};
  }
  var o = {g: g, sea: sea, sil: function(){ return sil; }, sky: function(){ return sky; },
    setTime: function(n){ nightGoal = n ? 1 : 0; },
    // the river (riverOf(doc), or null): wakes on it lie on its calm surface, and it is heard at its banks
    setRiver: function(R){ river = R || null; stillW = calmOf(river, water); },
    // the @3 bodies (waterOf(doc), or null): wakes on them lie on their calm surface (y over the sea's); they and the
    // coast (the sea's surf) are heard
    setWater: function(Wd){ water = Wd || null; coast = water && water.coast && water.coast.length >= 3 ? water.coast : null; stillW = calmOf(river, water); },
    // the direction toward the sun (or the moon by night) for the glint: {x, y, z}
    setSun: function(d){ if(d && isFinite(d.x) && isFinite(d.y) && isFinite(d.z)) seaM.uniforms.uSunDir.value.set(d.x, d.y, d.z).normalize(); },
    // boats = [{id, x, z, yaw, speed, beam}]: push each trail; a boat no longer listed lets its wake fade then goes
    wake: function(boats){
      var live = {};
      (boats || []).forEach(function(b){ if(!b || b.id == null) return; live[b.id] = 1; var w = wakes[b.id] || (wakes[b.id] = ribbon()); wakePush(w.trail, +b.x || 0, +b.z || 0, +b.yaw || 0, b.speed, clock, b.beam); });
      Object.keys(wakes).forEach(function(id){ if(!live[id]){ var w = wakes[id]; wakePush(w.trail, 0, 0, 0, 0, clock); if(!w.trail.pts.length){ g.remove(w.m); w.m.geometry.dispose(); delete wakes[id]; } } });
    },
    // t: seconds (the scene's clock), dt: this frame, cam: {x, y, z} -> how many impostors drawn
    step: function(t, dt, cam){
      cam = cam || {x: 0, y: 0, z: 0}; clock = +t || 0;
      night += (nightGoal - night)*ease(1.5, dt); tint();
      var calm = c.E && c.E.calm && c.E.calm();
      seaM.uniforms.uTime.value = calm ? 0 : clock; seaM.uniforms.uCam.value.set(cam.x || 0, cam.y || 0, cam.z || 0);
      sea.position.set(Math.round((cam.x || 0)/32)*32, 0, Math.round((cam.z || 0)/32)*32);     // snapped: the grid never swims
      Object.keys(wakes).forEach(function(id){
        var w = wakes[id], S = wakeStrip(w.trail, clock), P = w.m.geometry.attributes.position, C = w.m.geometry.attributes.color;
        for(var i = 0; i < S.n*6; i++){
          var x = S.pos[i*2], z = S.pos[i*2 + 1];
          var wb = water ? water.bodyAt(x, z) : null;
          P.array[i*3] = x; P.array[i*3 + 1] = 0.03 + (river && river.inWater(x, z) ? RIVER_Y : wb ? wb.y : calm ? 0 : waveAt(x, z, clock)); P.array[i*3 + 2] = z;
          C.array[i*4] = C.array[i*4 + 1] = C.array[i*4 + 2] = 1; C.array[i*4 + 3] = S.alpha[i]*0.8;
        }
        P.needsUpdate = true; C.needsUpdate = true; w.m.geometry.setDrawRange(0, Math.max(0, S.n - 1)*30);
      });
      if(waterP) waterP.update(waterHeard(E.listenerAt(), coast, stillW, g.position.y));
      return impostors(cam.x || 0, cam.z || 0);
    },
    drawCalls: function(){ return 1 + 1 + sky.length + Object.keys(wakes).length; },
    dispose: function(){
      if(waterP){ waterP.stop(); waterP = null; }
      parent.remove(g);
      g.traverse(function(m){ if(m.geometry) m.geometry.dispose(); });
      if(LIVE.mat === seaM) LIVE.mat = null;
      if(LIVE.river === riverM) LIVE.river = null;
      seaM.dispose(); riverM.dispose(); impM.dispose(); wakeM.dispose();
    }};
  tint();
  return o;
}

HQV.ocean = {WAVES: WAVES, COAST_R: COAST_R, SKY_R: SKY_R, ARRIVE: ARRIVE, HORIZON: HORIZON, WAKE: WAKE,
  waveAt: waveAt, waveGlsl: waveGlsl, setArchipelago: setArchipelago, nearestIsland: nearestIsland, horizon: horizon,
  FLY_ON: FLY_ON, flyOn: flyOn, flyOnState: flyOnState,
  inPoly: inPoly, landTest: landTest, coastOf: coastOf, docksOf: docksOf, seaOf: seaOf, riverOf: riverOf, waterOf: waterOf,
  BREAKWATER_HALF: BREAKWATER_HALF,
  material: function(){ return LIVE.mat; }, riverMaterial: function(){ return LIVE.river; }, RIVER_Y: RIVER_Y,
  wakePush: wakePush, wakeStrip: wakeStrip, mount: mount, waterHeard: waterHeard, calmOf: calmOf, WATER_M: WATER_M,
  current: function(){ return {world: ARCH.cur, x: ARCH.ox, z: ARCH.oz, count: ARCH.list.length}; }};
})();
