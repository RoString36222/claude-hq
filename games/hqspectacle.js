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
        gx.font = "bold 132px 'Avenir Next', 'Segoe UI', sans-serif"; gx.textAlign = "center"; gx.textBaseline = "middle";
        gx.shadowColor = accent; gx.shadowBlur = 34; gx.fillStyle = "#fff8e6";
        gx.fillText((icon ? icon + "  " : "") + String(name).toUpperCase(), 512, 138);
      }).t;
      t.colorSpace = THREE.SRGBColorSpace; return t;
    }
    function signMat(tx){ var m = new THREE.MeshStandardMaterial({map: tx, emissiveMap: tx, emissive: 0xffffff, emissiveIntensity: 0.4, roughness: 0.45, side: THREE.DoubleSide}); nightMats.push({m: m, day: 0.4, night: 1.5, envDay: 0}); return m; }
    function hexOf(css){ return parseInt(String(css).slice(1), 16); }
    // a group placed in the park's frame at x, z facing yaw (its +z), and its own frame -> the park's
    function framed(x, z, yaw){
      var gp = new THREE.Group(); gp.position.set(x, 0, z); gp.rotation.y = yaw; pg.add(gp);
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
          gx.fillStyle = "#7a1f3d"; gx.font = "bold 84px 'Avenir Next', sans-serif"; gx.textAlign = "center"; gx.textBaseline = "middle"; gx.fillText("ADMIT ONE", 256, 130); }).t;
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
        var gable = new THREE.Mesh(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(sd*rw/2, roofY, rz - rd/2), new THREE.Vector3(sd*rw/2, roofY, rz + rd/2), new THREE.Vector3(sd*rw/2, roofY + Math.tan(pitch)*rd/2, rz)]), plain(acc, {rough: 0.5}));
        gable.material.side = THREE.DoubleSide; gable.geometry.computeVertexNormals(); sg.add(gable);
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
    kiosk({x: GATE + 4.8, z: -b - 2.6, yaw: PI, name: "Tickets", prop: "ticket", acc: "#ffd23f"});
    [{x: -9, z: -b*0.55, name: "Popcorn", prop: "popcorn", acc: "#ffd23f"}, {x: 9, z: -b*0.35, name: "Ice Cream", prop: "cone", acc: "#7ee0ff"},
     {x: -9, z: b*0.2, name: "Cotton Candy", prop: "candy", acc: "#ff7ad9"}].forEach(function(k){ k.yaw = k.x < 0 ? PI/2 : -PI/2; kiosk(k); });

    /* ----- the rides ----- */
    var place = {
      coaster: null,
      wheel: {x: -a*0.42, z: -b*0.36, R: clamp(Math.min(a, b)*0.42, 10, 26)},
      drop: {x: -a*0.42, z: b*0.42, H: clamp(hm*1.55, 40, 72)},
      carousel: {x: a*0.3, z: -b*0.02, r: clamp(a*0.18, 6, 9)},
      swing: {x: a*0.28, z: b*0.38, r: clamp(a*0.12, 4, 6)}
    };
    rides.push(coaster(), wheel(place.wheel), drop(place.drop), carousel(place.carousel), swinger(place.swing));
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
        cg.add(car); cars.push(car);
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
      var H = o3.H, dg = new THREE.Group(); dg.position.set(o3.x, ly(o3.x, o3.z), o3.z); pg.add(dg);
      dg.add(tower(rrect(3.2, 3.2, 0.4, 2), 0, H, 6, null, null, M.steel, TILE.steel));
      var crownM = glowMat(0xff3d7f), crown = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 2.0, 3, 16), crownM); crown.position.y = H + 1.5; dg.add(crown);
      beacon(dg, H + 3.6);
      var ringG = new THREE.Group(); dg.add(ringG);
      var ring = new THREE.Mesh(new THREE.TorusGeometry(3.2, 0.5, 8, 32), plain(0xffd23f, {metal: 0.4, rough: 0.3})); ring.rotation.x = PI/2; ringG.add(ring);
      var dropAnchors = [];
      for(var i = 0; i < 12; i++){ var an = i/12*TAU, s2 = new THREE.Mesh(new THREE.BoxGeometry(0.8, 1.2, 0.7), plain(0x22252b)); s2.position.set(Math.cos(an)*3.9, -0.3, Math.sin(an)*3.9); s2.rotation.y = -an; ringG.add(s2);
        if(i % 4){ var da = new THREE.Object3D(); da.position.set(Math.cos(an)*4.25, 0.3 - 0.8, Math.sin(an)*4.25); da.rotation.y = Math.atan2(Math.cos(an), Math.sin(an)); ringG.add(da); dropAnchors.push(da); } }
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
        spin.add(h); horses.push({g: h, body: body, ph: i*0.9});
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
      var rt = o3.r, LC = 6, sg2 = new THREE.Group(); sg2.position.set(o3.x, ly(o3.x, o3.z), o3.z); pg.add(sg2);
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
        var bk = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.6, 0.1), ch.material); bk.position.set(0, -LC + 0.3, -0.3); // the back, behind a rider facing the way it travels (+z) hang.add(bk);
        var cgeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-0.3, 0, 0), new THREE.Vector3(-0.3, -LC, 0), new THREE.Vector3(0.3, 0, 0), new THREE.Vector3(0.3, -LC, 0)]);
        hang.add(new THREE.LineSegments(cgeo, chainM));
        chairs.push({arm: arm, hang: hang});
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

    // The crowd: the City's own resident body (games/npcdraw.js: six boxes, the gait in its vertex shader) in one
    // instanced mesh. Walkers stroll three loops (the boulevard both ways, the ring, a tour of the stations), people
    // queue on the station decks and wait at the kiosks, and riders sit in the rides' seats (their anchors). Like
    // the rides, it all runs on the shared clock, so everyone sees the same crowd.
    var crowd = buildCrowd();
    function buildCrowd(){
      var ND = HQV.npcDraw; if(!ND || !ND.bodyGeometry || !ND.bodyMaterial) return null;
      function H(i, k){ return (hash32("crowd:" + i + ":" + k) % 10000)/10000; }
      function loopOf(pts){ var cum = [0]; for(var i = 1; i <= pts.length; i++){ var p0 = pts[i - 1], p1 = pts[i % pts.length]; cum.push(cum[i - 1] + Math.hypot(p1[0] - p0[0], p1[1] - p0[1])); } return {pts: pts, cum: cum, len: cum[pts.length]}; }
      var tour = rides.map(function(r){ return [r.entry.x, r.entry.z]; }).concat([[0, -b*0.45]]).sort(function(p, q){ return Math.atan2(p[0], p[1]) - Math.atan2(q[0], q[1]); });
      var loops = [loopOf([[-1.4, -b - 2], [-1.4, b*0.5], [1.4, b*0.5], [1.4, -b - 2]]),
                   loopOf([[-a*0.58, -b*0.08], [a*0.58, -b*0.08], [a*0.58, b*0.48], [-a*0.58, b*0.48]]), loopOf(tour)];
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
      if(park.crowd){ park.g.updateMatrixWorld(true); park.crowd.update(sec, dt, cam); }
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
