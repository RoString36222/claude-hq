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
 *   o: {scene, ground(x, z), owner (the city's owner id), city() (its CityState, which carries the caller's
 *       park: {price, pass} from an Arena that sells passes), post(path, body) -> Promise, say(text), avatar()}
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
      W.sites.push({id: "funpark:" + b.id, kind: "funpark", name: PARK_NAME, block: b.id, pad: false, x: Math.round(cx*100), y: hCm(cx, cz), z: Math.round(cz*100),
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
    var l = byId[m.lot]; l.kind = "landmark";
    W.sites.push({id: "landmark:" + m.lot, kind: "landmark", name: m.name, block: l.block, pad: false, x: l.x, y: hCm(l.x/100, l.z/100), z: l.z,
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
    steel: pbr("steel", {metal: 0.9, rough: 0.6, env: 1.0})
  };
  var TILE = {glass: 10, grid: 12, office: 14, stone: 12, steel: 4};
  function plain(col, o2){ o2 = o2 || {}; return new THREE.MeshStandardMaterial({color: col, roughness: o2.rough != null ? o2.rough : 0.55, metalness: o2.metal || 0, envMap: o2.env ? env : null, envMapIntensity: o2.env || 0}); }
  function glowMat(col){ var m = new THREE.MeshStandardMaterial({color: col, emissive: col, emissiveIntensity: 0.25, roughness: 0.4}); nightMats.push({m: m, day: 0.25, night: 2.2, envDay: 0}); return m; }

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
  function cone(r0, r1, h, mat, y, seg){ var m = new THREE.Mesh(new THREE.CylinderGeometry(r1, r0, h, seg || 16), mat); m.position.y = y + h/2; m.castShadow = true; return m; }

  /* ---------- landmarks ---------- */
  var beacons = [], marks = [], landG = new THREE.Group(); landG.name = "landmarks"; g.add(landG);
  function beacon(gp, y){
    var b = new THREE.Mesh(new THREE.SphereGeometry(0.8, 10, 8), new THREE.MeshBasicMaterial({color: 0xff2a2a}));
    b.position.y = y; gp.add(b);
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
      return s*0.47;
    },
    // a three-lobed tower climbing in setbacks to a long spire
    spire: function(gp, s, H){
      var R = s*0.42, tiers = [0, 0.3, 0.5, 0.64, 0.75, 0.84, 0.9];
      tiers.forEach(function(t0, i){
        var t1 = i + 1 < tiers.length ? tiers[i + 1] : 0.95, k = 1 - i*0.12;
        var base = section(function(a){ return R*k*(1 + 0.24*Math.cos(3*a + i*0.35)); }, 72);
        gp.add(tower(base, t0*H, t1*H, 4, function(u){ return lerp(1, 0.97, u); }, null, M.grid, TILE.grid));
      });
      gp.add(cone(R*0.16, R*0.01, H*0.28, M.steel, H*0.95));
      beacon(gp, H*1.23 + 1); floods(gp, s*0.55, 0xfff1d0);
      return R*1.2;
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
      return R*0.85;
    },
    // twin eight-pointed towers in setbacks with a skybridge between them
    twins: function(gp, s, H){
      var R = s*0.235, gap = s*0.1, off = gap/2 + R, steps = [[0, 0.58, 1], [0.58, 0.72, 0.86], [0.72, 0.82, 0.72], [0.82, 0.9, 0.58], [0.9, 0.94, 0.44]];
      [-1, 1].forEach(function(sd){
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
      return [{x: -off, z: 0, r: R*1.1}, {x: off, z: 0, r: R*1.1}];
    },
    // an observation tower: a concrete shaft, a glass sky-deck ringed in light, a second pod and an antenna
    needle: function(gp, s, H){
      var r0 = Math.min(9, s*0.24);
      gp.add(tower(section(function(){ return r0; }, 40), 0, H*0.78, 6, function(u){ return lerp(1, 0.42, u); }, null, M.stone, TILE.stone));
      for(var i = 0; i < 3; i++){                                    // three fins round the foot
        var f = new THREE.Mesh(new THREE.BoxGeometry(1.6, H*0.16, r0*2.6), M.stone); var a = i/3*TAU;
        f.position.set(Math.sin(a)*r0*1.1, H*0.08, Math.cos(a)*r0*1.1); f.rotation.y = a; f.castShadow = true; gp.add(f);
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
      return r0*1.6;
    },
    // an art deco stone tower stepping back to a crown of lit sunbursts
    regent: function(gp, s, H){
      var tiers = [[1, 0.45], [0.82, 0.2], [0.66, 0.13], [0.52, 0.09]], y = 0;
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
      return s*0.47;
    }
  };
  var HMUL = {twist: 1, spire: 1.15, lantern: 0.72, twins: 0.82, needle: 1.35, regent: 0.9};
  spec.marks.forEach(function(m){
    var gp = new THREE.Group(), s = Math.max(16, m.s*0.9), H = clamp(s*7.5, 190, 360)*(HMUL[m.type] || 1);
    gp.position.set(m.x, ground(m.x, m.z) - 0.2, m.z); gp.rotation.y = m.rot; gp.name = "landmark:" + m.type;
    var foot = BUILD[m.type](gp, s, H);
    landG.add(gp);
    var cr = Math.cos(m.rot), sr = Math.sin(m.rot);
    var circles = (Array.isArray(foot) ? foot : [{x: 0, z: 0, r: foot}]).map(function(f){ return {x: m.x + f.x*cr + f.z*sr, z: m.z - f.x*sr + f.z*cr, r: f.r}; });
    marks.push({m: m, g: gp, H: H, circles: circles});
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
    var hits = [], segs = [], bulbs = [], glows = [], rides = [];
    var hm = clamp(Math.min(P.w, P.d)*0.42, 26, 46);

    // the path: the boulevard from the gate and a ring round the middle
    var paveT = c.canvasTex(128, 128, function(gx){
      gx.fillStyle = "#c9c2b4"; gx.fillRect(0, 0, 128, 128); gx.strokeStyle = "rgba(90,80,70,.35)"; gx.lineWidth = 2;
      for(var i = 0; i <= 128; i += 32){ gx.beginPath(); gx.moveTo(i, 0); gx.lineTo(i, 128); gx.stroke(); gx.beginPath(); gx.moveTo(0, i); gx.lineTo(128, i); gx.stroke(); }
    }).t;
    paveT.wrapS = paveT.wrapT = THREE.RepeatWrapping;
    function slab(x0, z0, x1, z1){
      var w = Math.abs(x1 - x0), d = Math.abs(z1 - z0), t = paveT.clone(); t.needsUpdate = true; t.repeat.set(w/4, d/4);
      var m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), new THREE.MeshStandardMaterial({map: t, roughness: 0.95}));
      m.rotation.x = -PI/2; m.position.set((x0 + x1)/2, ly((x0 + x1)/2, (z0 + z1)/2) + 0.06, (z0 + z1)/2); m.receiveShadow = true; pg.add(m);
    }
    slab(-3.5, -b, 3.5, b*0.55);
    slab(-a*0.62, -b*0.12, a*0.62, -b*0.04); slab(-a*0.62, b*0.44, a*0.62, b*0.52);
    slab(-a*0.62, -b*0.12, -a*0.54, b*0.52); slab(a*0.54, -b*0.12, a*0.62, b*0.52);

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
    // the ticket booth beside the gate
    var boothM = plain(0xff7a59, {rough: 0.5});
    var booth = new THREE.Mesh(new THREE.BoxGeometry(2.4, 2.6, 2.2), boothM); booth.position.set(GATE + 4.5, ly(GATE + 4.5, -b + 2.5) + 1.3, -b + 2.5); booth.castShadow = true; pg.add(booth);
    var roof = new THREE.Mesh(new THREE.ConeGeometry(2.2, 1.2, 4), plain(0xfff0d6)); roof.rotation.y = PI/4; roof.position.set(booth.position.x, booth.position.y + 1.9, booth.position.z); pg.add(roof);
    hits.push({x: booth.position.x, z: booth.position.z, r: 1.6});
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
    // food stalls along the boulevard
    var awnT = c.canvasTex(64, 64, function(gx){ for(var s2 = 0; s2 < 8; s2++){ gx.fillStyle = s2 % 2 ? "#fff4e0" : "#e63946"; gx.fillRect(s2*8, 0, 8, 64); } }).t;
    awnT.colorSpace = THREE.SRGBColorSpace;
    [[-9, -b*0.55], [9, -b*0.35], [-9, b*0.2]].forEach(function(p){
      var st = new THREE.Mesh(new THREE.BoxGeometry(3.2, 2.4, 2.4), plain(0xf7e8c8)); st.position.set(p[0], ly(p[0], p[1]) + 1.2, p[1]); st.castShadow = true; pg.add(st);
      var aw = new THREE.Mesh(new THREE.BoxGeometry(3.8, 0.15, 3.2), new THREE.MeshStandardMaterial({map: awnT, roughness: 0.6})); aw.position.set(p[0], st.position.y + 1.45, p[1]); aw.rotation.x = 0.12; pg.add(aw);
      hits.push({x: p[0], z: p[1], r: 2.1});
    });

    /* ----- the rides ----- */
    var place = {
      coaster: null,
      wheel: {x: -a*0.42, z: -b*0.36, R: clamp(Math.min(a, b)*0.42, 10, 26)},
      drop: {x: -a*0.42, z: b*0.42, H: clamp(hm*1.55, 40, 72)},
      carousel: {x: a*0.3, z: -b*0.02, r: clamp(a*0.18, 6, 9)},
      swing: {x: a*0.28, z: b*0.38, r: clamp(a*0.12, 4, 6)}
    };
    rides.push(coaster(), wheel(place.wheel), drop(place.drop), carousel(place.carousel), swinger(place.swing));

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
      var cg = new THREE.Group(); cg.name = "coaster"; pg.add(cg);
      cg.add(sweep([0.55, 0], 0.09, railM)); cg.add(sweep([-0.55, 0], 0.09, railM)); cg.add(sweep([0, -0.45], 0.22, spineM));
      var led = sweep([0, -0.72], 0.05, glowMat(0x4fd1ff)); cg.add(led);
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
      // the station: a platform on the inside of the track, a roof
      var st0 = Pt[iStop], plat = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.3, 22), plain(0x9aa3ad, {rough: 0.9}));
      plat.position.set(st0.x - 2.6, ly(st0.x - 2.6, st0.z) + 0.15, st0.z); plat.receiveShadow = true; cg.add(plat);
      var sroof = new THREE.Mesh(new THREE.BoxGeometry(6.4, 0.3, 24), plain(0x5f2bd9, {rough: 0.5})); sroof.position.set(st0.x - 1.2, plat.position.y + 3.6, st0.z); cg.add(sroof);
      // the train: four cars
      var carM = plain(0x1d4ed8, {metal: 0.6, rough: 0.25, env: 1}), seatM = plain(0x111318, {rough: 0.8}), cars = [];
      for(i = 0; i < 4; i++){
        var car = new THREE.Group(), body = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.7, 2.2), carM); body.position.y = 0.35; body.castShadow = true; car.add(body);
        var seat = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.6, 0.2), seatM); seat.position.set(0, 0.85, -0.6); car.add(seat);
        if(i === 0){ var nose = new THREE.Mesh(new THREE.ConeGeometry(0.75, 1.1, 4), carM); nose.rotation.set(PI/2, PI/4, 0); nose.position.set(0, 0.35, 1.6); car.add(nose); }
        cg.add(car); cars.push(car);
      }
      var CAR_GAP = 2.7/ds, LAP_NAME = "Comet";
      var stP = {x: st0.x - 2.6, z: st0.z - 4};
      return {
        id: "coaster", name: LAP_NAME, icon: "🎢", entry: stP, exit: {x: st0.x - 2.6, z: st0.z + 7},
        // the ride you board is the next train out: from its dwell to back in the station
        next: function(sec){ var tau = ((sec % LAP) + LAP) % LAP; return tau < DWELL - 3 ? sec - tau : sec - tau + LAP; },
        dur: LAP, board: DWELL - 1,
        update: function(sec){
          var f = sAt(sec);
          cars.forEach(function(car, ci){ var fr = frame(f - ci*CAR_GAP); car.position.copy(fr.p); bas.makeBasis(fr.sd, fr.up, fr.t); car.quaternion.setFromRotationMatrix(bas); });
        },
        seat: function(sec){ var fr = frame(sAt(sec)); return {p: fr.p.clone().addScaledVector(fr.up, 1.45).addScaledVector(fr.t, -0.3), t: fr.t, up: fr.up}; },
        watch: {x: st0.x - 26, z: st0.z + 30, y: 18}
      };
    }
    // the Ferris wheel: 24 gondolas that stay level, a rim of lights
    function wheel(o3){
      var R = o3.R, hub = R + 4.5, wg = new THREE.Group(); wg.position.set(o3.x, ly(o3.x, o3.z), o3.z); pg.add(wg);
      var rimM = plain(0xf5f5f5, {metal: 0.6, rough: 0.3, env: 0.8}), rot = new THREE.Group(); rot.position.y = hub; wg.add(rot);
      [-1.6, 1.6].forEach(function(x){ var rim = new THREE.Mesh(new THREE.TorusGeometry(R, 0.28, 8, 96), rimM); rim.rotation.y = PI/2; rim.position.x = x; rot.add(rim);
        for(var i = 0; i < 24; i++){ var an = i/24*TAU, sp = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, R, 4), rimM); sp.position.set(x, Math.cos(an)*R/2, Math.sin(an)*R/2); sp.rotation.x = an; rot.add(sp); } });
      var hubM = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.1, 4, 16), rimM); hubM.rotation.z = PI/2; rot.add(hubM);
      [-1, 1].forEach(function(sd){ [-1, 1].forEach(function(fz){ wg.add(tube([[sd*3.2, 0, fz*R*0.5], [sd*2.1, hub, 0]], 0.35, rimM, 6)); hits.push({x: o3.x + sd*3.2, z: o3.z + fz*R*0.5, r: 0.6}); }); });
      var gonds = [], gcols = [0xff4f6d, 0xffd23f, 0x3bceac, 0x5f6bff, 0xff8c42, 0xc86bfa];
      for(var i = 0; i < 24; i++){
        var gd = new THREE.Group(), cab = new THREE.Mesh(new THREE.CylinderGeometry(1.15, 1.0, 1.7, 12), plain(gcols[i % 6], {rough: 0.35, metal: 0.2, env: 0.5}));
        cab.position.y = -1.6; gd.add(cab);
        var gr = new THREE.Mesh(new THREE.ConeGeometry(1.25, 0.6, 12), rimM); gr.position.y = -0.5; gd.add(gr);
        wg.add(gd); gonds.push(gd);
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
        id: "wheel", name: "Skywheel", icon: "🎡", entry: {x: o3.x + 5, z: o3.z - 2}, exit: {x: o3.x + 5, z: o3.z + 2},
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
      var H = o3.H, dg = new THREE.Group(); dg.position.set(o3.x, ly(o3.x, o3.z), o3.z); pg.add(dg);
      dg.add(tower(rrect(3.2, 3.2, 0.4, 2), 0, H, 6, null, null, M.steel, TILE.steel));
      var crownM = glowMat(0xff3d7f), crown = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 2.0, 3, 16), crownM); crown.position.y = H + 1.5; dg.add(crown);
      beacon(dg, H + 3.6);
      var ringG = new THREE.Group(); dg.add(ringG);
      var ring = new THREE.Mesh(new THREE.TorusGeometry(3.2, 0.5, 8, 32), plain(0xffd23f, {metal: 0.4, rough: 0.3})); ring.rotation.x = PI/2; ringG.add(ring);
      for(var i = 0; i < 12; i++){ var an = i/12*TAU, s2 = new THREE.Mesh(new THREE.BoxGeometry(0.8, 1.2, 0.7), plain(0x22252b)); s2.position.set(Math.cos(an)*3.9, -0.3, Math.sin(an)*3.9); s2.rotation.y = -an; ringG.add(s2); }
      hits.push({x: o3.x, z: o3.z, r: 2.6});
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
        id: "drop", name: "Freefall", icon: "🚀", entry: {x: o3.x + 6, z: o3.z}, exit: {x: o3.x + 6, z: o3.z + 2},
        next: function(sec){ var t = ((sec % CYC) + CYC) % CYC; return t < 7 ? sec - t : sec - t + CYC; }, dur: CYC - 2, board: 0,
        update: function(sec){ ringG.position.y = yAt(sec); },
        seat: function(sec){ var p = new THREE.Vector3(Math.sin(face)*4.6, yAt(sec) + 0.6, Math.cos(face)*4.6); dg.localToWorld(p);
          var t = new THREE.Vector3(Math.sin(face), -0.28, Math.cos(face)).transformDirection(dg.matrixWorld); return {p: p, t: t, up: new THREE.Vector3(0, 1, 0)}; },
        watch: {x: o3.x + 24, z: o3.z - 10, y: 8}
      };
    }
    // the carousel: horses that rise and fall under a striped canopy edged in bulbs
    function carousel(o3){
      var r = o3.r, cg2 = new THREE.Group(); cg2.position.set(o3.x, ly(o3.x, o3.z), o3.z); pg.add(cg2);
      var gold = plain(0xd4a52c, {metal: 0.9, rough: 0.25, env: 1}), white = plain(0xfaf7f0, {rough: 0.4});
      var basem = new THREE.Mesh(new THREE.CylinderGeometry(r + 0.4, r + 0.6, 0.5, 40), plain(0x7a1f3d)); basem.position.y = 0.25; cg2.add(basem);
      var spin = new THREE.Group(); cg2.add(spin);
      var deck = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 0.2, 40), plain(0xc9b38a)); deck.position.y = 0.6; spin.add(deck);
      var col = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 0.8, 4.4, 16), gold); col.position.y = 2.8; spin.add(col);
      var stripes = c.canvasTex(256, 32, function(gx){ for(var s2 = 0; s2 < 16; s2++){ gx.fillStyle = s2 % 2 ? "#fff1d6" : "#d7263d"; gx.fillRect(s2*16, 0, 16, 32); } }).t;
      stripes.colorSpace = THREE.SRGBColorSpace;
      var canopy = new THREE.Mesh(new THREE.ConeGeometry(r + 0.8, 2.6, 40, 1, true), new THREE.MeshStandardMaterial({map: stripes, side: THREE.DoubleSide, roughness: 0.6}));
      canopy.position.y = 6.2; spin.add(canopy);
      var horses = [], hb = new THREE.SphereGeometry(0.5, 12, 8);
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
        spin.add(h); horses.push({g: h, body: body, ph: i*0.9});
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
        id: "carousel", name: "Carousel", icon: "🎠", entry: {x: o3.x + r + 2.4, z: o3.z}, exit: {x: o3.x + r + 2.4, z: o3.z + 2},
        next: function(sec){ var t = ((sec % CYC) + CYC) % CYC; return t >= RUN ? sec - t + CYC : sec - t + CYC; }, dur: RUN, board: 0,
        update: function(sec){ spin.rotation.y = -angAt(sec); horses.forEach(function(h, k){ h.body.position.y = bob(sec, k); }); },
        seat: function(sec){ var h = horses[outer], p = new THREE.Vector3(0, bob(sec, outer) + 1.05, 0); h.g.localToWorld(p);
          var t = new THREE.Vector3(0, -0.1, 1).transformDirection(h.g.matrixWorld); return {p: p, t: t, up: new THREE.Vector3(0, 1, 0)}; },
        watch: {x: o3.x + r + 9, z: o3.z + 6, y: 4}
      };
    }
    // the wave swinger: chairs flung out on chains under a spinning, tilting crown
    function swinger(o3){
      var rt = o3.r, LC = 6, sg2 = new THREE.Group(); sg2.position.set(o3.x, ly(o3.x, o3.z), o3.z); pg.add(sg2);
      var mast = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.2, 13, 16), plain(0x3d5afe, {metal: 0.5, rough: 0.35, env: 0.6})); mast.position.y = 6.5; mast.castShadow = true; sg2.add(mast);
      var top = new THREE.Group(); top.position.y = 13; sg2.add(top);
      var crownT = c.canvasTex(256, 32, function(gx){ for(var s2 = 0; s2 < 16; s2++){ gx.fillStyle = s2 % 2 ? "#ffe066" : "#7b2ff7"; gx.fillRect(s2*16, 0, 16, 32); } }).t;
      crownT.colorSpace = THREE.SRGBColorSpace;
      var hat = new THREE.Mesh(new THREE.ConeGeometry(rt + 1.2, 2.2, 32, 1, true), new THREE.MeshStandardMaterial({map: crownT, side: THREE.DoubleSide, roughness: 0.5})); hat.position.y = 1.4; top.add(hat);
      var rim = new THREE.Mesh(new THREE.TorusGeometry(rt + 1.1, 0.25, 6, 48), glowMat(0xff9de2)); rim.rotation.x = PI/2; rim.position.y = 0.3; top.add(rim);
      var chairs = [], chainM = new THREE.LineBasicMaterial({color: 0x888c93});
      for(var i = 0; i < 16; i++){
        var arm = new THREE.Group(), an = i/16*TAU; arm.rotation.y = -an; top.add(arm);
        var hang = new THREE.Group(); hang.position.x = rt; arm.add(hang);
        var ch = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.12, 0.6), plain([0xff4f6d, 0x3bceac, 0xffd23f, 0x5f6bff][i % 4])); ch.position.y = -LC; hang.add(ch);
        var bk = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.6, 0.1), ch.material); bk.position.set(0, -LC + 0.3, -0.3); // the back, behind a rider facing the way it travels (+z) hang.add(bk);
        var cgeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-0.3, 0, 0), new THREE.Vector3(-0.3, -LC, 0), new THREE.Vector3(0.3, 0, 0), new THREE.Vector3(0.3, -LC, 0)]);
        hang.add(new THREE.LineSegments(cgeo, chainM));
        chairs.push({arm: arm, hang: hang});
      }
      hits.push({x: o3.x, z: o3.z, r: 1.4});
      var CYC = 44, RUN = 36, WMAX = TAU/5.2;
      function omega(t){ return t < 6 ? WMAX*ease(t/6) : t < RUN - 6 ? WMAX : t < RUN ? WMAX*(1 - ease((t - RUN + 6)/6)) : 0; }
      var FULL = turned(omega, RUN, RUN);
      function angAt(sec){ var t = ((sec % CYC) + CYC) % CYC; return (Math.floor(sec/CYC) % 1000)*FULL + turned(omega, t, RUN); }
      function swingAt(sec){ var t = ((sec % CYC) + CYC) % CYC, w = omega(t), th = 0.3;
        for(var it = 0; it < 6; it++) th = Math.atan(w*w*(rt + LC*Math.sin(th))/G); return th; }
      return {
        id: "swing", name: "Starswing", icon: "🌀", entry: {x: o3.x + rt + LC + 3, z: o3.z}, exit: {x: o3.x + rt + LC + 3, z: o3.z + 2},
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

    // every bulb in the park: one instanced mesh, coloured by day and chasing by night
    var bulbI = new THREE.InstancedMesh(new THREE.SphereGeometry(0.07, 6, 5), new THREE.MeshBasicMaterial({color: 0xffffff}), Math.max(1, bulbs.length)), dmb = new THREE.Object3D();
    bulbs.forEach(function(p, j){ dmb.position.set(p.x, p.y, p.z); dmb.updateMatrix(); bulbI.setMatrixAt(j, dmb.matrix); });
    pg.add(bulbI);

    // collision in the park's frame: the fence (but the gate's gap), posts, rides and the low track
    var grid = {}, CELL = 8;
    hits.forEach(function(h){ var k = Math.floor(h.x/CELL) + ":" + Math.floor(h.z/CELL); (grid[k] = grid[k] || []).push(h); });
    function blockedL(lx, lz, gateOpen){
      if(lx < -a - 1.5 || lx > a + 1.5 || lz < -b - 1.5 || lz > b + 1.5) return false;
      for(var j = 0; j < segs.length; j++){
        var s4 = segs[j], dx = s4[2] - s4[0], dz = s4[3] - s4[1], L2 = dx*dx + dz*dz, u = L2 ? clamp(((lx - s4[0])*dx + (lz - s4[1])*dz)/L2, 0, 1) : 0;
        if(Math.hypot(lx - (s4[0] + u*dx), lz - (s4[1] + u*dz)) < 0.45) return true;
      }
      if(!gateOpen && Math.abs(lz + b) < 0.6 && Math.abs(lx) < GATE) return true;     // the turnstile
      var cx2 = Math.floor(lx/CELL), cz2 = Math.floor(lz/CELL);
      for(var ix = -1; ix <= 1; ix++) for(var iz = -1; iz <= 1; iz++){
        var L3 = grid[(cx2 + ix) + ":" + (cz2 + iz)]; if(!L3) continue;
        for(var q2 = 0; q2 < L3.length; q2++) if(Math.hypot(lx - L3[q2].x, lz - L3[q2].z) < L3[q2].r) return true;
      }
      return false;
    }
    return {g: pg, a: a, b: b, gate: {x: 0, z: -b - 2.5}, booth: {x: GATE + 4.5, z: -b - 1.5}, rides: rides, bulbs: bulbs, bulbI: bulbI, glows: glows,
            balloons: balloons, blockedL: blockedL, toW: toW, toL: toL, ly: ly, inside: function(lx, lz){ return lx > -a && lx < a && lz > -b && lz < b; }};
  }

  /* ---------- tickets, rides and the prompt ---------- */
  var pass = false, buying = false, riding = null, prompt = null, promptAt = null, lastPassCheck = 0;
  function ticket(){
    var st = o.city ? o.city() : null, pk = st && st.park;
    if(!pk || typeof pk !== "object") return {sold: false, price: 0, pass: true};        // an Arena without park passes: a free preview
    return {sold: true, price: Math.max(0, pk.price | 0), pass: pass || !!pk.pass};
  }
  function buy(){
    var tk = ticket(); if(!tk.sold || tk.pass || buying) return;
    if(!o.post){ say("The ticket booth needs the Arena."); return; }
    buying = true; say("Buying a day pass to " + PARK_NAME + "…");
    function refused(m){
      say(/fare is|coins/i.test(String(m || "")) ? "A day pass is " + tk.price + " Poke Coins: you don't have enough." : "The ticket booth couldn't sell a pass right now.");
    }
    // the page's arenaPost resolves {ok, status, j} whatever the status: only an ok answer is a pass
    o.post("/api/arena/city/" + encodeURIComponent(o.owner || "commons") + "/fare", {kind: "park"}).then(function(r){
      buying = false;
      var j = r && typeof r === "object" && r.j && typeof r.j === "object" ? r.j : {};
      if(!r || r.ok !== true){ refused(j.detail || j.error); return; }
      pass = true;
      var coins = j.coins != null ? " You have " + (j.coins | 0) + " Poke Coins left." : "";
      say("Welcome to " + PARK_NAME + "! Your day pass is good until midnight UTC." + coins);
      if(E.sfx) E.sfx("coin");
    }, function(e){ buying = false; refused(e && e.message); });
  }
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
    var tk = ticket();
    if(!tk.pass){ say("You need a day pass for " + r.name + ": buy one at the gate."); return; }
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
      var tk = ticket();
      text = !tk.sold ? "🎡 " + PARK_NAME + " · free preview" : tk.pass ? "🎡 " + PARK_NAME + " · pass OK" : "🎟️ Day pass · " + tk.price + " coins (E)";
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
  var inst = {
    g: g,
    spec: spec,
    setNight: function(n){
      night = !!n;
      nightMats.forEach(function(x){ x.m.emissiveIntensity = night ? x.night : x.day; if(x.envDay) x.m.envMapIntensity = night ? x.envDay*0.18 : x.envDay; });
      beacons.forEach(function(b){ if(b.flood) b.flood.material.opacity = night ? 0.32 : 0; });
      if(park) park.glows.forEach(function(gl){ gl.material.opacity = night ? 0.75 : 0; });
    },
    update: function(t, dt, cam){
      if(dead) return;
      var sec = nowSec(), calm = E.calm();
      // aviation lights: blink by night (steady in Calm), off by day
      var on = night && (calm || (sec % 1.6) < 0.5);
      beacons.forEach(function(b){ if(b.m){ b.m.visible = night; if(b.gl) b.gl.material.opacity = on ? 0.9 : 0; } });
      marks.forEach(function(M2){ var r2 = M2.g.userData.ring; if(r2 && night && !calm) r2.material.emissive.setHSL((sec*0.05) % 1, 0.9, 0.5); });
      if(!park) return;
      park.g.updateMatrixWorld();
      park.rides.forEach(function(r){ r.update(sec, night, calm); });
      // the bulbs: warm white by day, chasing colours by night (steady in Calm)
      var key = night ? (calm ? "n" : "c" + Math.floor(sec*6)) : "d";
      if(key !== lastNightKey){
        lastNightKey = key;
        park.bulbs.forEach(function(bp, j){
          if(!night) col.setRGB(0.62, 0.6, 0.55); else col.setHSL(((bp.k + (calm ? 0 : sec*0.15)) % 1 + 1) % 1, 0.85, 0.62);
          park.bulbI.setColorAt(j, col);
        });
        if(park.bulbI.instanceColor) park.bulbI.instanceColor.needsUpdate = true;
      }
      park.balloons.forEach(function(bl){ var u = bl.userData; bl.position.set(u.bx + (calm ? 0 : Math.sin(sec*0.8 + u.ph)*0.12), park.ly(u.bx, u.bz) + 3.2 + (calm ? 0 : Math.sin(sec*1.1 + u.ph)*0.15), u.bz); });
      // a pass bought on another device shows up on the next CityState read
      if(!pass && sec - lastPassCheck > 5){ lastPassCheck = sec; var tk = ticket(); if(tk.sold && tk.pass) pass = true; }
      // riding: off at the end of the lap or cycle
      if(riding && sec >= riding.until) leave(true);
      promptUi(riding ? null : nearest());
    },
    blocked: function(x, z){
      for(var i = 0; i < marks.length; i++) for(var j = 0; j < marks[i].circles.length; j++){
        var cc = marks[i].circles[j]; if(Math.abs(x - cc.x) < cc.r && Math.abs(z - cc.z) < cc.r && Math.hypot(x - cc.x, z - cc.z) < cc.r) return true;
      }
      if(!park) return false;
      var L = park.toL(x, z);
      return park.blockedL(L.x, L.z, ticket().pass);
    },
    use: function(p){
      if(riding){
        var sec = nowSec();
        if(sec < riding.t0){ riding = null; say("You stepped out of the queue."); return true; }
        say("Hold on: you're mid-ride!"); return true;
      }
      var n = nearest(); if(!n) return false;
      if(n.kind === "gate"){ var tk = ticket(); if(tk.sold && !tk.pass) buy(); else say(tk.sold ? "Your day pass is good: enjoy " + PARK_NAME + "!" : PARK_NAME + " is a free preview until this Arena sells passes."); return true; }
      if(n.kind === "ride"){ board(n.ride); return true; }
      return false;
    },
    // where you are held: on the platform while you wait, then in your seat
    carry: function(){
      if(!riding || !park) return null;
      var sec = nowSec(), r = riding.r;
      if(sec < riding.t0 + r.board){ var e = park.toW(r.entry.x, r.entry.z); return {x: e.x, y: park.g.position.y + park.ly(r.entry.x, r.entry.z), z: e.z, yaw: 0}; }
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
      var s = r.seat(sec, riding.k), lk = s.p.clone().addScaledVector(s.t, 12);
      return {camera: true, pos: {x: s.p.x, y: s.p.y, z: s.p.z}, look: {x: lk.x, y: lk.y, z: lk.z}, up: {x: s.up.x, y: s.up.y, z: s.up.z}, fov: r.id === "coaster" ? 78 : 66};
    },
    riding: function(){ return riding ? {id: riding.r.id, name: riding.r.name, t0: riding.t0, until: riding.until} : null; },
    // for tools and tests: a ride's seat at any clock time (s), as {p, t, up}, and its cycle
    seatAt: function(id, sec, k){
      var r = park && park.rides.filter(function(x){ return x.id === id; })[0]; if(!r) return null;
      r.update(sec, night, false); park.g.updateMatrixWorld(true); var s0 = r.seat(sec, k | 0);
      return {p: {x: s0.p.x, y: s0.p.y, z: s0.p.z}, t: {x: s0.t.x, y: s0.t.y, z: s0.t.z}, up: {x: s0.up.x, y: s0.up.y, z: s0.up.z}, next: r.next(sec), dur: r.dur};
    },
    // for tools and tests: the park's frame and its rides
    debug: function(){ return park ? {park: spec.park, rides: park.rides.map(function(r){ return {id: r.id, name: r.name, entry: park.toW(r.entry.x, r.entry.z)}; }), gate: park.toW(park.gate.x, park.gate.z), pass: ticket()} : null; },
    destroy: function(){
      dead = true; if(prompt && prompt.parentNode) prompt.parentNode.removeChild(prompt); prompt = null;
      S.remove(g);
      g.traverse(function(x){ if(x.geometry) x.geometry.dispose(); });
    }
  };
  inst.setNight(!!o.night);
  return inst;
}

HQV.hqSpectacle = {claim: claim, create: create, coasterPlan: coasterPlan, TYPES: TYPES, NAMES: NAMES, PARK_NAME: PARK_NAME,
  PARK_MIN: PARK_MIN, MAX_MARKS: MAX_MARKS, LANDMARK_GAP: LANDMARK_GAP, hash32: hash32};
})();
