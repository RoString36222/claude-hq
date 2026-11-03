/* Claude HQ: tunnel mouths (HQV.hqPortals). City Gen v5 (@4): wherever a rail or metro line goes from its tunnel to the
 * open the doc carries a portal: layers.rail.portals (the City Line's mouths, backend/src/worldgen/v5/rail.rs) and
 * layers.metro.portals (each metro depot's, v5/metro.rs), each {id, line, x, z (the headwall on the track's centre line),
 * y (the ground there), front (Q16, into the tunnel), w (the cutting's width), len (headwall to where the rail meets the
 * ground), hole (the cutting's terrain hole, cut by worldgeom)}, all cm.
 *
 * Pure top half (no THREE, no DOM; tests/test_hqportals.py runs it under node):
 *   plan(W) -> [P]  every portal in metres, memoised per world: {id, line, kind ("rail" | "metro"), name, color, x, y, z,
 *                   yaw (facing out of the tunnel, yaw 0 = +z), w, len, rail (the rail at the headwall), clear (the
 *                   mouth's height over the rail), walls (false: this cutting's walls are another portal's, a cutting
 *                   between two tunnels), full (false: a metro portal, whose trench, walls and headwall hqmetro.js draws:
 *                   only the fence, the lights and its mouth's dark far end are added here), secs: [{x, z, yaw, rail, land}] every SEC m from the
 *                   headwall to the open end (yaw along the way out, land the street level beside the cutting)}
 *   blocked(W, x, z, yNow)  true on a cutting's walls, coping and fence, the headwall, and over the cutting itself unless
 *                   yNow is down at its track: from the land you cannot walk, ride or drive into a cutting (the fence
 *                   stops you); the track in it is the trains'
 *   NAMES           the line names on the headwalls' plates
 * Drawing (needs THREE through hq3d's ctx): view(c, W, opts) -> V {g, update(), setNight(on), drawCalls(), dispose(),
 *   tools: {plan(), shotCam(name)}}: for a rail portal the concrete headwall over the mouth with a framed surround, its
 *   name plate (line name and portal number), two floodlights over the mouth; the trench floor and the retaining walls
 *   either side of the cutting, their coping; a short box tunnel into the hillside lit by wall lights through its first
 *   metres; on every cutting (metro too) a safety fence along both copings and across the headwall: posts, rails and a
 *   chain-link panel. Four draw calls: the concrete (vertex colours), the fence's mesh panels, the lights, the plates
 *   (one canvas atlas). Static: nothing moves, so Calm and reduced motion change nothing. Never Math.random.
 */
(function(){
"use strict";
var root = typeof window !== "undefined" ? window : self;
var HQV = root.HQV = root.HQV || {};

var SEC = 2;                 // m between a cutting's sections
var COPING = 0.35;           // m: the coping's top over the land beside the cutting
var COPE_W = 0.6;            // m: the coping's width (it covers the terrain hole's edge)
var FENCE_H = 1.8;           // m: the safety fence on the coping
var FENCE_POST = 2.5;        // m between its posts
var MOUTH_IN = 15;           // m of box tunnel drawn into the hillside behind the headwall
var LIGHT_EVERY = 3;         // m between the mouth's wall lights
var HEAD_WING = 2.5;         // m the headwall reaches past the cutting's walls either side
var HEAD_T = 1.0;            // m: the headwall's thickness
var PARAPET = 1.0;           // m: the headwall's parapet over the land at the mouth
var CLEAR = {rail: 6.5, metro: 5.6};   // m: the mouth's soffit over the rail (rail.rs CLEAR_CM less its roof; hqmetro's 5.6)
var TRACK_LEVEL = 3;         // m: within this over a cutting's rail you are down at its track (not on the land)
var BLOCK_PAD = 0.3;         // m past the fence that still blocks (a body's radius)
var NAMES = {CL: "City Line", IL: "Island Link", M1: "Red line", M2: "Blue line", M3: "Green line", M4: "Yellow line"};
var COLORS = {CL: "#2e6b4c", IL: "#6d4bb3", M1: "#d23a32", M2: "#2f6fd6", M3: "#2fa36b", M4: "#e0a020"};
var HEX = {concrete: 0xb9b5ab, concreteD: 0x8f8b82, joint: 0x6f6b64, inside: 0x4a4844, floor: 0x5d5a55, ballast: 0x6b665e,
           steel: 0x3d4a52, frame: 0xa9a59b, lamp: 0xfff1cf, lampHead: 0x2b2f33};

function fin(v, d){ v = +v; return isFinite(v) ? v : d; }
function hyp(a, b){ return Math.sqrt(a*a + b*b); }
function WD(){ return HQV.world || null; }
function q16(f){ var x = f ? fin(f[0], 0) : 0, z = f ? fin(f[1], 0) : 1, l = hyp(x, z); return l > 1e-9 ? [x/l, z/l] : [0, 1]; }
var MEMO = typeof WeakMap === "function" ? new WeakMap() : null;
function memo(W){
  if(!MEMO || !W || typeof W !== "object") return {};
  var m = MEMO.get(W);
  if(!m){ m = {}; MEMO.set(W, m); }
  return m;
}
// a line's path [[x, y, z]] (m) by id: the rail layer's (world.js railOf, else W.rail / layers.rail in cm), the metro's
function pathsOf(W){
  var out = {}, Q = WD();
  function cmPath(P){ return (P || []).filter(function(p){ return p && p.length >= 3; }).map(function(p){ return [fin(p[0], 0)/100, fin(p[1], 0)/100, fin(p[2], 0)/100]; }); }
  var R = Q && Q.railOf && W.rail ? Q.railOf(W) : null;
  if(R) R.lines.forEach(function(l){ out["rail:" + l.id] = l.path; });
  else { var L = W.rail || (W.layers && W.layers.rail); ((L && L.lines) || []).forEach(function(l){ if(l) out["rail:" + l.id] = cmPath(l.path); }); }
  var M = Q && Q.metroOf && W.metro ? Q.metroOf(W) : null;
  if(M) M.lines.forEach(function(l){ out["metro:" + l.id] = l.path; });
  else { var ML = W.metro || (W.layers && W.layers.metro); ((ML && ML.lines) || []).forEach(function(l){ if(l) out["metro:" + l.id] = cmPath(l.path); }); }
  return out;
}
function rawPortals(W, layer){
  var L = W[layer] || (W.layers && W.layers[layer]);
  return (L && Array.isArray(L.portals) ? L.portals : []).filter(function(p){ return p && p.line != null && isFinite(+p.x) && isFinite(+p.z); });
}
// the land beside a cutting: the street level over its hole (world.js), else the portal's own ground
function landAt(W, x, z, dflt){
  var Q = WD();
  if(Q && Q.streetAt) { try { var y = Q.streetAt(W, x, z); if(isFinite(y)) return y; } catch(e){} }
  return dflt;
}
// a path's cumulative lengths and the point s m along it {x, y, z, dx, dz}
function cum(P){ var s = [0]; for(var i = 1; i < P.length; i++) s.push(s[i - 1] + hyp(P[i][0] - P[i - 1][0], P[i][2] - P[i - 1][2])); return s; }
function along(P, S, s){
  var n = P.length, i = 1;
  s = Math.max(0, Math.min(S[n - 1], s));
  while(i < n - 1 && S[i] < s) i++;
  var a = P[i - 1], b = P[i], L = S[i] - S[i - 1], f = L > 1e-9 ? (s - S[i - 1])/L : 0, dx = b[0] - a[0], dz = b[2] - a[2], dl = hyp(dx, dz) || 1;
  return {x: a[0] + dx*f, y: a[1] + (b[1] - a[1])*f, z: a[2] + dz*f, dx: dx/dl, dz: dz/dl};
}
function nearest(P, S, x, z){
  var best = {d: Infinity, s: 0};
  for(var i = 1; i < P.length; i++){
    var a = P[i - 1], b = P[i], ux = b[0] - a[0], uz = b[2] - a[2], L2 = ux*ux + uz*uz;
    var t = L2 > 0 ? Math.max(0, Math.min(1, ((x - a[0])*ux + (z - a[2])*uz)/L2)) : 0, qx = a[0] + ux*t - x, qz = a[2] + uz*t - z, d = qx*qx + qz*qz;
    if(d < best.d){ best.d = d; best.s = S[i - 1] + (S[i] - S[i - 1])*t; }
  }
  return best;
}

function plan(W){
  if(!W || typeof W !== "object") return [];
  var M = memo(W);
  if(M.plan) return M.plan;
  var paths = pathsOf(W), out = [], seen = {};
  [["rail", "rail"], ["metro", "metro"]].forEach(function(kl){
    var kind = kl[0];
    rawPortals(W, kl[1]).forEach(function(p, k){
      var line = String(p.line), P = paths[kind + ":" + line];
      if(!P || P.length < 2) return;
      var S = cum(P), x = fin(p.x, 0)/100, z = fin(p.z, 0)/100, y = fin(p.y, 0)/100, f = q16(p.front), len = Math.max(4, fin(p.len, 0)/100);
      var w = Math.max(6, fin(p.w, 1200)/100), s0 = nearest(P, S, x, z).s, a0 = along(P, S, s0);
      // out of the tunnel: the way along the path away from its front
      var dir = (a0.dx*f[0] + a0.dz*f[1]) > 0 ? -1 : 1, s1 = Math.max(0, Math.min(S[S.length - 1], s0 + dir*len));
      var n = Math.max(1, Math.ceil(Math.abs(s1 - s0)/SEC)), secs = [];
      for(var i = 0; i <= n; i++){
        var q = along(P, S, s0 + (s1 - s0)*i/n);
        secs.push({x: q.x, z: q.z, yaw: Math.atan2(q.dx*dir, q.dz*dir), rail: q.y, land: landAt(W, q.x, q.z, y)});
      }
      // a cutting between two tunnels is one cutting: its walls once
      var key = kind + ":" + line + ":" + Math.round(Math.min(s0, s1)) + ":" + Math.round(Math.max(s0, s1));
      var walls = !seen[key]; seen[key] = 1;
      out.push({id: String(p.id != null ? p.id : kind + "-portal:" + k), line: line, kind: kind, name: NAMES[line] || ("Line " + line), color: COLORS[line] || "#7a7f86",
                x: x, y: y, z: z, yaw: Math.atan2(-f[0], -f[1]), w: w, len: len, rail: a0.y, clear: CLEAR[kind], walls: walls, full: kind === "rail",
                n: out.filter(function(o){ return o.line === line; }).length + 1, secs: secs});
    });
  });
  M.plan = out;
  return out;
}

/* ---------- physics: the fenced cuttings and the headwalls as convex quads in a grid ---------- */
var CELL = 16;
function blockIndex(W){
  var M = memo(W);
  if(M.block !== undefined) return M.block;
  var list = [], grid = {};
  function add(Q, rail){
    var b = {x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity};
    Q.forEach(function(q){ b.x0 = Math.min(b.x0, q[0]); b.x1 = Math.max(b.x1, q[0]); b.z0 = Math.min(b.z0, q[1]); b.z1 = Math.max(b.z1, q[1]); });
    var h = {Q: Q, b: b, rail: rail};
    list.push(h);
    for(var j = Math.floor(b.z0/CELL); j <= Math.floor(b.z1/CELL); j++) for(var i = Math.floor(b.x0/CELL); i <= Math.floor(b.x1/CELL); i++) (grid[i + "," + j] = grid[i + "," + j] || []).push(h);
  }
  function lat(s, l, u){ var c = Math.cos(s.yaw), si = Math.sin(s.yaw); return [s.x + c*l + si*(u || 0), s.z - si*l + c*(u || 0)]; }
  plan(W).forEach(function(p){
    var r = p.w/2 + COPE_W + BLOCK_PAD, S = p.secs;
    if(p.walls) for(var i = 1; i < S.length; i++){
      var A = S[i - 1], B = S[i];
      add([lat(A, -r), lat(B, -r), lat(B, r), lat(A, r)], Math.min(A.rail, B.rail));
    }
    // the headwall and its wings, behind the mouth
    var H = S[0], wr = p.w/2 + HEAD_WING + BLOCK_PAD;
    add([lat(H, -wr, -HEAD_T - BLOCK_PAD), lat(H, wr, -HEAD_T - BLOCK_PAD), lat(H, wr, BLOCK_PAD), lat(H, -wr, BLOCK_PAD)], -Infinity);
  });
  M.block = list.length ? {list: list, grid: grid} : null;
  return M.block;
}
function inQuad(Q, x, z){
  var s = 0;
  for(var i = 0; i < 4; i++){
    var a = Q[i], b = Q[(i + 1) % 4], c = (b[0] - a[0])*(z - a[1]) - (b[1] - a[1])*(x - a[0]);
    if(Math.abs(c) < 1e-12) continue;
    if(!s) s = c > 0 ? 1 : -1; else if((c > 0 ? 1 : -1) !== s) return false;
  }
  return true;
}
function blocked(W, x, z, yNow){
  if(!W) return false;
  var B = blockIndex(W);
  if(!B) return false;
  var L = B.grid[Math.floor(x/CELL) + "," + Math.floor(z/CELL)];
  if(!L) return false;
  var y = yNow != null && isFinite(+yNow) ? +yNow : null;
  for(var i = 0; i < L.length; i++){
    var h = L[i];
    if(x < h.b.x0 || x > h.b.x1 || z < h.b.z0 || z > h.b.z1 || !inQuad(h.Q, x, z)) continue;
    if(y != null && y < h.rail + TRACK_LEVEL) continue;          // down at the track: the cutting's floor is yours
    return true;
  }
  return false;
}

/* ---------- drawing ---------- */
function view(c, W, opts){
  opts = opts || {};
  var THREE = c && c.THREE;
  if(!THREE || !W) return null;
  var P = plan(W);
  if(!P.length) return null;
  var g = new THREE.Group(); g.name = "portals";
  // builders: flat-shaded triangles with vertex colours (the concrete, the lights) or none (the fence's panels)
  function B(){ return {p: [], c: [], n: []}; }
  var Bc = B(), Bf = B(), Bl = B(), plates = [];
  function tri(b, A, C, D, hex){
    var ux = C[0] - A[0], uy = C[1] - A[1], uz = C[2] - A[2], vx = D[0] - A[0], vy = D[1] - A[1], vz = D[2] - A[2];
    var nx = uy*vz - uz*vy, ny = uz*vx - ux*vz, nz = ux*vy - uy*vx, nl = Math.sqrt(nx*nx + ny*ny + nz*nz) || 1;
    var col = new THREE.Color(hex);
    [A, C, D].forEach(function(q){ b.p.push(q[0], q[1], q[2]); b.n.push(nx/nl, ny/nl, nz/nl); b.c.push(col.r, col.g, col.b); });
  }
  function quad(b, A, C, D, E, hex){ tri(b, A, C, D, hex); tri(b, A, D, E, hex); }
  // a section's frame: l across (+ to the left of the way out), y up, u along the way out
  function at(s, l, y, u){ var co = Math.cos(s.yaw), si = Math.sin(s.yaw); u = u || 0; return [s.x + co*l + si*u, y, s.z - si*l + co*u]; }
  function box(b, s, l, y, u, hl, hy, hu, hex){
    var X = [l - hl, l + hl], Y = [y - hy, y + hy], U = [u - hu, u + hu];
    function v(i, j, k){ return at(s, X[i], Y[j], U[k]); }
    quad(b, v(0,0,1), v(1,0,1), v(1,1,1), v(0,1,1), hex); quad(b, v(1,0,0), v(0,0,0), v(0,1,0), v(1,1,0), hex);
    quad(b, v(0,0,0), v(0,0,1), v(0,1,1), v(0,1,0), hex); quad(b, v(1,0,1), v(1,0,0), v(1,1,0), v(1,1,1), hex);
    quad(b, v(0,1,1), v(1,1,1), v(1,1,0), v(0,1,0), hex); quad(b, v(0,0,0), v(1,0,0), v(1,0,1), v(0,0,1), hex);
  }
  function fenceRun(s0, l0, u0, s1, l1, u1, y0, y1, start){
    // a run of fence between two coping points (frames s0/s1, across l, along u, coping tops y0/y1): posts, top and mid
    // rails, the mesh panel
    var A = at(s0, l0, y0, u0), C = at(s1, l1, y1, u1);
    quad(Bf, A, C, [C[0], y1 + FENCE_H - 0.05, C[2]], [A[0], y0 + FENCE_H - 0.05, A[2]], 0xffffff);
    [FENCE_H, FENCE_H*0.5, 0.12].forEach(function(h){
      var dx = C[0] - A[0], dz = C[2] - A[2], L = hyp(dx, dz) || 1, nx = -dz/L*0.025, nz = dx/L*0.025;
      quad(Bc, [A[0] + nx, y0 + h, A[2] + nz], [C[0] + nx, y1 + h, C[2] + nz], [C[0] + nx, y1 + h + 0.05, C[2] + nz], [A[0] + nx, y0 + h + 0.05, A[2] + nz], HEX.steel);
      quad(Bc, [A[0] - nx, y0 + h, A[2] - nz], [A[0] - nx, y0 + h + 0.05, A[2] - nz], [C[0] - nx, y1 + h + 0.05, C[2] - nz], [C[0] - nx, y1 + h, C[2] - nz], HEX.steel);
    });
    if(start) box(Bc, s0, l0, y0 + FENCE_H/2, u0, 0.04, FENCE_H/2, 0.04, HEX.steel);
    box(Bc, s1, l1, y1 + FENCE_H/2, u1, 0.04, FENCE_H/2, 0.04, HEX.steel);
  }
  P.forEach(function(p, pi){
    var S = p.secs, hw = p.w/2, H = S[0], roof = H.rail + p.clear;
    // the coping's top at a section: the land beside the cutting (hqmetro's metro portals: their constant top)
    function top(s){ return p.full ? Math.max(s.land, s.rail + 0.5) + COPING : p.y + 1.1; }
    var copeOut = p.full ? hw + COPE_W : hw + 0.45;
    if(p.walls){
      var fenceAcc = 0, last = null;
      for(var i = 1; i < S.length; i++){
        var A = S[i - 1], C = S[i], tA = top(A), tC = top(C);
        if(p.full){
          // the trench floor; the retaining walls' inner faces from below the floor to the coping; the coping and its
          // outer face down into the land (it hides the terrain hole's edge)
          quad(Bc, at(A, -hw, A.rail - 0.55), at(C, -hw, C.rail - 0.55), at(C, hw, C.rail - 0.55), at(A, hw, A.rail - 0.55), HEX.floor);
          [-1, 1].forEach(function(e){
            quad(Bc, at(A, e*hw, A.rail - 0.6), at(C, e*hw, C.rail - 0.6), at(C, e*hw, tC), at(A, e*hw, tA), (i & 1) ? HEX.concrete : HEX.concreteD);
            quad(Bc, at(A, e*hw, tA), at(C, e*hw, tC), at(C, e*copeOut, tC), at(A, e*copeOut, tA), HEX.frame);
            quad(Bc, at(A, e*copeOut, tA), at(C, e*copeOut, tC), at(C, e*copeOut, C.land - 0.6), at(A, e*copeOut, A.land - 0.6), HEX.concreteD);
          });
          // a cable trough and drain along each wall's foot
          [-1, 1].forEach(function(e){ quad(Bc, at(A, e*(hw - 0.6), A.rail - 0.3), at(C, e*(hw - 0.6), C.rail - 0.3), at(C, e*hw, C.rail - 0.3), at(A, e*hw, A.rail - 0.3), HEX.joint); });
        }
        // the fence along both copings, a post every FENCE_POST m (where the wall stands over the land)
        fenceAcc += hyp(C.x - A.x, C.z - A.z);
        if(fenceAcc >= FENCE_POST || i === S.length - 1){
          var F0 = last || S[0], tl = top(F0), tn = top(C), fl = p.full ? hw + 0.25 : hw + 0.25;
          if(Math.max(F0.land, C.land) - Math.min(F0.rail, C.rail) > 0.8)
            [-1, 1].forEach(function(e){ fenceRun(F0, e*fl, 0, C, e*fl, 0, tl, tn, !last); });
          last = C; fenceAcc = 0;
        }
      }
    }
    // the headwall over the mouth (a rail portal's; hqmetro draws a metro portal's): its parapet over the land, at least a
    // metre over the soffit; the face, its surround, the back and top, the wings past the walls
    var land0 = H.land, tw = Math.max(land0 + PARAPET, roof + 1.2), wr = hw + HEAD_WING;
    if(p.full){
      quad(Bc, at(H, -wr, roof, 0), at(H, wr, roof, 0), at(H, wr, tw, 0), at(H, -wr, tw, 0), HEX.concrete);                // the face over the opening
      [-1, 1].forEach(function(e){ quad(Bc, at(H, e*hw, H.rail - 0.6, 0), at(H, e*wr, H.rail - 0.6, 0), at(H, e*wr, roof, 0), at(H, e*hw, roof, 0), HEX.concrete); });
      quad(Bc, at(H, -wr, tw, 0), at(H, wr, tw, 0), at(H, wr, tw, -HEAD_T), at(H, -wr, tw, -HEAD_T), HEX.frame);           // its top
      quad(Bc, at(H, -wr, land0 - 0.5, -HEAD_T), at(H, wr, land0 - 0.5, -HEAD_T), at(H, wr, tw, -HEAD_T), at(H, -wr, tw, -HEAD_T), HEX.concreteD);
      [-1, 1].forEach(function(e){ quad(Bc, at(H, e*wr, H.rail - 0.6, 0), at(H, e*wr, H.rail - 0.6, -HEAD_T), at(H, e*wr, tw, -HEAD_T), at(H, e*wr, tw, 0), HEX.concreteD); });
      // the surround: a lintel and two pilasters standing 0.25 m proud round the opening, a cornice under the parapet
      box(Bc, H, 0, roof + 0.3, 0.12, hw + 0.4, 0.3, 0.13, HEX.frame);
      [-1, 1].forEach(function(e){ box(Bc, H, e*(hw + 0.2), (H.rail - 0.55 + roof)/2, 0.12, 0.2, (roof - H.rail + 0.55)/2, 0.13, HEX.frame); });
      box(Bc, H, 0, tw - 0.15, 0.15, wr + 0.1, 0.15, 0.16, HEX.frame);
      // the mouth: MOUTH_IN m of box tunnel into the hillside, dark inside, lit along its walls
      quad(Bc, at(H, -hw, roof, 0), at(H, hw, roof, 0), at(H, hw, roof, -MOUTH_IN), at(H, -hw, roof, -MOUTH_IN), HEX.inside);
      quad(Bc, at(H, -hw, H.rail - 0.55, 0), at(H, -hw, H.rail - 0.55, -MOUTH_IN), at(H, hw, H.rail - 0.55, -MOUTH_IN), at(H, hw, H.rail - 0.55, 0), HEX.floor);
      [-1, 1].forEach(function(e){ quad(Bc, at(H, e*hw, H.rail - 0.6, 0), at(H, e*hw, H.rail - 0.6, -MOUTH_IN), at(H, e*hw, roof, -MOUTH_IN), at(H, e*hw, roof, 0), HEX.inside); });
      quad(Bc, at(H, -hw, H.rail - 0.6, -MOUTH_IN), at(H, hw, H.rail - 0.6, -MOUTH_IN), at(H, hw, roof, -MOUTH_IN), at(H, -hw, roof, -MOUTH_IN), 0x1d1c1a);
      // two floodlights on the face over the opening, lamps down at the track
      [-1, 1].forEach(function(e){
        box(Bc, H, e*hw*0.6, roof + 0.85, 0.35, 0.35, 0.18, 0.3, HEX.lampHead);
        box(Bl, H, e*hw*0.6, roof + 0.66, 0.4, 0.28, 0.02, 0.22, HEX.lamp);
      });
      // the name plate on the face, over the surround
      var pw = Math.min(2*hw - 1, 8), ph = pw/5, py = Math.min(tw - 0.45 - ph/2, roof + 0.75 + ph/2 + 0.6);
      plates.push({p: p, s: H, w: pw, h: ph, y: py});
    }
    // a metro mouth's 12 m box (hqmetro's) closed at its far end, so the hillside is not seen through it
    if(!p.full) quad(Bc, at(H, -hw, H.rail - 0.6, -11.9), at(H, hw, H.rail - 0.6, -11.9), at(H, hw, roof, -11.9), at(H, -hw, roof, -11.9), 0x1d1c1a);
    // the mouth's lights: both walls through its first metres (a metro mouth's walls are hqmetro's, 12 m deep)
    var lightsIn = p.full ? MOUTH_IN - 1 : 11, lh = H.rail + (p.full ? 4.6 : 4.0);
    for(var u = 1.5; u <= lightsIn; u += LIGHT_EVERY){
      [-1, 1].forEach(function(e){ box(Bl, H, e*(hw - 0.06), lh, -u, 0.05, 0.08, 0.6, HEX.lamp); });
    }
    // and the fence across the headwall's top (a metro portal's: along its parapet)
    var ft = p.full ? tw : p.y + 1.1, fw = p.full ? wr : hw + 0.45;
    fenceRun(H, -fw, -HEAD_T*0.5, H, fw, -HEAD_T*0.5, ft, ft, true);
  });
  function mesh(b, mat){
    if(!b.p.length) return null;
    var geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(b.p, 3));
    geo.setAttribute("normal", new THREE.Float32BufferAttribute(b.n, 3));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(b.c, 3));
    geo.computeBoundingSphere();
    var m = new THREE.Mesh(geo, mat); g.add(m);
    return m;
  }
  // the concrete and the lights go before the sea (games/ocean.js, renderOrder -10) and mark the stencil wherever they
  // draw, so the sea plane under the island is not drawn down a cutting (as hqmetro's street works, worldbuild's cuttings)
  function stencilMark(m){ m.stencilWrite = true; m.stencilRef = 1; m.stencilFunc = THREE.AlwaysStencilFunc; m.stencilZPass = THREE.ReplaceStencilOp; return m; }
  var mats = {
    concrete: stencilMark(new THREE.MeshStandardMaterial({vertexColors: true, roughness: 0.92, metalness: 0.04, side: THREE.DoubleSide})),
    fence: new THREE.MeshStandardMaterial({color: 0x9aa4a8, roughness: 0.6, metalness: 0.5, transparent: true, opacity: 0.32, depthWrite: false, side: THREE.DoubleSide}),
    light: stencilMark(new THREE.MeshBasicMaterial({vertexColors: true}))
  };
  function solid(m){ if(m){ m.castShadow = true; m.receiveShadow = true; m.renderOrder = -20; } return m; }
  var mc = solid(mesh(Bc, mats.concrete)), mf = mesh(Bf, mats.fence), ml = mesh(Bl, mats.light);
  if(ml) ml.renderOrder = -20;
  // the plates: one canvas atlas, a row each (line colour band, the name, the portal's number)
  var tex = null, mp = null;
  if(plates.length && typeof document !== "undefined"){
    var RW = 512, RH = 102, cv = document.createElement("canvas");
    cv.width = RW; cv.height = RH*plates.length;
    var x2 = cv.getContext("2d");
    if(x2){
      plates.forEach(function(pl, k){
        var y0 = k*RH;
        x2.fillStyle = "#f3f1ea"; x2.fillRect(0, y0, RW, RH);
        x2.fillStyle = pl.p.color; x2.fillRect(0, y0, 26, RH);
        x2.fillStyle = "#1f2326"; x2.font = "bold 50px system-ui, -apple-system, Segoe UI, sans-serif"; x2.textBaseline = "middle";
        x2.fillText(pl.p.name.toUpperCase(), 46, y0 + RH*0.40, RW - 60);
        x2.font = "600 24px system-ui, -apple-system, Segoe UI, sans-serif"; x2.fillStyle = "#4a5056";
        x2.fillText("Tunnel portal " + pl.p.n, 48, y0 + RH*0.80, RW - 60);
        x2.strokeStyle = "#1f2326"; x2.lineWidth = 4; x2.strokeRect(2, y0 + 2, RW - 4, RH - 4);
      });
      tex = new THREE.CanvasTexture(cv);
      if(THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
      var pos = [], uv = [], nor = [];
      plates.forEach(function(pl, k){
        var s = pl.s, hwp = pl.w/2, hp = pl.h/2, v0 = 1 - (k + 1)/plates.length, v1 = 1 - k/plates.length, uo = 0.27;
        // (it reads from the cutting: the reader faces back along the way out, so their left is -l)
        var A = at(s, -hwp, pl.y - hp, uo), C = at(s, hwp, pl.y - hp, uo), D = at(s, hwp, pl.y + hp, uo), E = at(s, -hwp, pl.y + hp, uo);
        [[A, 0, v0], [C, 1, v0], [D, 1, v1], [A, 0, v0], [D, 1, v1], [E, 0, v1]].forEach(function(q){
          pos.push(q[0][0], q[0][1], q[0][2]); uv.push(q[1], q[2]); nor.push(Math.sin(s.yaw), 0, Math.cos(s.yaw));
        });
        box(Bc, s, 0, pl.y, 0.2, hwp + 0.08, hp + 0.08, 0.06, HEX.steel);
      });
      var pg = new THREE.BufferGeometry();
      pg.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); pg.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
      pg.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
      mats.plate = new THREE.MeshStandardMaterial({map: tex, roughness: 0.55, metalness: 0.05});
      mp = new THREE.Mesh(pg, mats.plate); g.add(mp);
      // (the plates' backing boxes went into the concrete: rebuild it with them)
      if(mc){ g.remove(mc); mc.geometry.dispose(); }
      mc = solid(mesh(Bc, mats.concrete));
    }
  }
  var parent = opts.parent || c.scene;
  if(parent && opts.attach !== false) parent.add(g);
  var night = null;
  function setNight(on){
    on = !!on;
    if(on === night) return;
    night = on;
    // the mouth's lights are lit day and night (it is dark inside); brighter against the dark
    mats.light.color.setScalar(on ? 1.0 : 0.85);
  }
  setNight(typeof opts.night === "function" ? !!opts.night() : false);
  return {
    g: g, group: g,
    update: function(){ if(typeof opts.night === "function") setNight(opts.night()); },
    setNight: setNight,
    drawCalls: function(){ return (mc ? 1 : 0) + (mf ? 1 : 0) + (ml ? 1 : 0) + (mp ? 1 : 0); },
    tools: {
      plan: function(){ return P; },
      // the tour's cameras: "portal:<id>" from over the cutting's open end, down it to the mouth; "portal-mouth:<id>"
      // at the track looking into the mouth
      shotCam: function(name){
        var m = /^(portal|portal-mouth):(.*)$/.exec(String(name || ""));
        var p = m && P.filter(function(q){ return q.id === m[2]; })[0];
        if(!p) return null;
        var H = p.secs[0], E = p.secs[p.secs.length - 1], fx = Math.sin(H.yaw), fz = Math.cos(H.yaw);
        if(m[1] === "portal") return {pos: {x: E.x + fx*12 + Math.cos(H.yaw)*(p.w*0.9), y: Math.max(E.land, E.rail) + 9, z: E.z + fz*12 - Math.sin(H.yaw)*(p.w*0.9)}, look: {x: H.x, y: H.rail + 3, z: H.z}, fov: 60};
        return {pos: {x: H.x + fx*22, y: H.rail + 2.2, z: H.z + fz*22}, look: {x: H.x, y: H.rail + 2.8, z: H.z}, fov: 65};
      }
    },
    dispose: function(){
      if(g.parent) g.parent.remove(g);
      [mc, mf, ml, mp].forEach(function(m){ if(m) m.geometry.dispose(); });
      Object.keys(mats).forEach(function(k){ mats[k].dispose(); });
      if(tex) tex.dispose();
    }
  };
}

HQV.hqPortals = {plan: plan, blocked: blocked, view: view, NAMES: NAMES,
                 consts: {SEC: SEC, COPING: COPING, COPE_W: COPE_W, FENCE_H: FENCE_H, MOUTH_IN: MOUTH_IN, TRACK_LEVEL: TRACK_LEVEL, BLOCK_PAD: BLOCK_PAD}};
})();
