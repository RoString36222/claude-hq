/* Valley: Strikezone. A team shooter (amber vs cyan) on tight arena maps — Harbor
 * Dockyard (container lanes, warehouse chokepoint) and Dune Compound (desert rooms
 * and passages). The host picks the map; bots patrol its waypoint graph.
 * The host picks the side size (X vs X); when a side is short of players the Arena
 * server fills it with bots that patrol, chase and shoot.
 *
 * Rendering is the vendored three.js r186 (games/vendor/), imported only when this game
 * opens; without WebGL2 the same match runs as a top-down map. Players are Kenney's Mini
 * Characters (games/golf/); the arena blocks are Kenney's CC0 Starter Kit FPS pieces
 * (games/fps/), recoloured per box for the dockyard. An original re-implementation in
 * the spirit of the kit's (no Godot code is used).
 *
 * Multiplayer: you run and aim here (your own movement is predicted, your shots show at
 * once) and send where you are ~20 times a second; the Arena server (backend/app/strike.py)
 * runs a 20 Hz tick that checks every move and judges every shot with lag compensation.
 * Team-mates can't be hit. The team score is any member's kill; the round ends at the
 * kill limit, the clock, or when a side empties. Only numbers, a weapon and a character
 * id travel; nothing transcript-derived.
 *
 * The STRIKE-SHARED block mirrors backend/app/strike.py (tests/test_strike_sync.py runs
 * both under node and checks they agree).
 */
(function(){
"use strict";
var HQV = window.HQV; if(!HQV || !HQV.api || !HQV.engine) return;
// Shared helpers, three.js loading and snapshot timing: games/engine.js.
var E = HQV.engine;
var now = E.now, clamp = E.clamp, hex = E.hex, angLerp = E.angLerp, calm = E.calm, say = E.say,
    tokens = E.tokens, myClock = E.myClock, hasWebGL2 = E.hasWebGL2;
var api = HQV.api, MP = HQV.mp || null;

/* STRIKE-SHARED BEGIN */
var FS = (function(){
  var R = 0.35, H = 1.8, EYE = 1.6, STEP_H = 0.55, RUN = 6.0, ACCEL = 12.0, AIR_ACCEL = 3.0, GRAVITY = 18.0;
  var SPRINT = 1.35;   // hold Shift (or stick click): RUN × SPRINT while a movement key is down (v3)
  // sprint stamina (client-side; the server only watches raw speed): a full tank covers
  // STAMINA_MAX/STAMINA_DRAIN = 8 s of sprint, drained Shift still moves — barely (SLOW)
  var STAMINA_MAX = 100, STAMINA_DRAIN = 12.5, STAMINA_REGEN = 14, SPRINT_SLOW = 0.015;
  // v4: respawns are parachute drops — a spawn lifts you to this height and you steer a
  // gentle glide down for up to DROP_TIME seconds (the Arena too accepts "drop" hints and
  // relaxes its action-air guard while a drop still has legs)
  var DROP_HEIGHT = 11.0, DROP_TIME = 3.0, DROP_SINK = 2.8, DROP_DRIFT = 4.5;
  var JUMP_V = 6.5, FALL_MAX = 25.0, BODY_R = 0.4, BODY_H = 1.4, HEAD_R = 0.25, HEAD_TOP = 1.9;
  // the void: below the deck (or off the map box) with nothing to stand on. A fall-out
  // used to be an endless free-fall with no way back — VOID_SECS later the judge puts
  // you back under a canopy (that wait IS the penalty).
  var VOID_Y = -2.0, VOID_SECS = 10.0;
  // the wings/leap/speed totems' movement numbers, shared with both Arena referees so
  // the caps they enforce and the physics the browser runs stay the same numbers
  var LEAP_MULT = 3.0, SPEED_MULT = 2.0, WING_TOP = 9.0, WING_RISE = 4.0, WING_SINK = 2.0, WING_DRIFT = 6.0;
  var WEAPONS = [
    {id: "rapid", name: "Rapid smg", interval: 0.1, damage: 12, head: 18, mag: 30, reserve: 90, reload: 1.6,
     spread: 1.2, range: 60.0, auto: true, pack: 60},
    {id: "marksman", name: "Marksman rifle", interval: 0.8, damage: 75, head: 112, mag: 5, reserve: 15, reload: 2.2,
     spread: 0.3, range: 120.0, auto: false, pack: 10},
    {id: "revolver", name: "Revolver", interval: 0.5, damage: 50, head: 75, mag: 6, reserve: 24, reload: 2.2,
     spread: 0.5, range: 70.0, auto: false, pack: 12},
    {id: "launcher", name: "Launcher", interval: 1.2, damage: 120, head: 120, mag: 1, reserve: 5, reload: 2.5,
     spread: 0.0, range: 60.0, auto: false, pack: 2},
    // the grappling gun: zero damage. Hook a match drone and swing; hook a foe and drag
    // them in (they cannot shoot while hooked). 5 hooks; ammo crates refill the reserve.
    // Real players only — bots never roll this one.
    {id: "grapple", name: "Grappling gun", interval: 0.9, damage: 0, head: 0, mag: 5, reserve: 5, reload: 2.2,
     spread: 0.0, range: 40.0, auto: false, pack: 5}];
  // the launcher's rocket: a real missile that flies and blasts — the Arena server flies and
  // judges it in multiplayer (snapshots carry it), the browser flies it solo. All impls agree.
  var LAUNCH = WEAPONS[3];
  // weapon indices (twins: backend/src/strike.rs). LAUNCH_W must stay the rocket's slot —
  // every `w == NW - 1` rocket path is really "is the launcher".
  var GRAPPLE_W = 4, LAUNCH_W = 3, BOT_WEAPON_MAX = 4;
  // match flight drones (grapple anchors): deterministic routes inside the map bounds.
  var DRONE_Y = 7.5, DRONE_R = 0.8, DRONE_N = 8, DRONE_PHASE = 1.3;
  var GRAPPLE_TIME = 2.5, GRAPPLE_SWING = 11.0, GRAPPLE_UP = 6.0, GRAPPLE_PULL = 18.0, HOOK_LOCK = 2.0;
	var GRAPPLE_RISE = 4.0;
  var MISSILE_V = 22.0, MISSILE_G = 6.0, MISSILE_TTL = 3.5, BLAST_R = 4.0, DIRECT_R = 0.8;
  // blast damage by distance from the explosion (direct hit / falloff to BLAST_R)
  function blastDamage(dist, direct){
    if(direct) return 120;
    if(dist >= BLAST_R) return 0;
    return Math.round(75 - (75 - 25)*(dist/BLAST_R));
  }
  // proximity crush for disaster marks (Meteor / Thunder / Quake): the blast you stand
  // under is the one that hurts. Full peak inside 0.35 of the radius, falling to 0.45 of
  // the peak at the rim. Twin: mark_damage in backend/src/strike.rs (DD_NEAR_R / DD_NEAR_MIN).
  function markDamage(dist, r, dmg){
    r = +r; if(!(r > 0)) r = 1;
    dist = Math.max(0, +dist);
    var u = Math.min(1, dist / r), near = 0.35, min = 0.45;
    var k = u <= near ? 1 : min + (1 - min) * (1 - (u - near) / (1 - near));
    return Math.max(1, Math.round((dmg|0) * k));
  }
  function compileMap(d){
    d = d || {};
    var boxes = (d.boxes || []).map(function(b){ return [+b[0], +b[1], +b[2], +b[3], +b[4], +b[5], String(b[6] || "block")]; });
    boxes.forEach(function(b){ if(!(b[0] < b[3] && b[1] < b[4] && b[2] < b[5])) throw new Error("box with no volume"); });
    var out = {id: d.id, name: d.name, bounds: (d.bounds || []).map(Number), boxes: boxes, theme: d.theme || {},
            spawns: (d.spawns || []).map(function(s){ return s.map(Number); }), pickups: d.pickups || [], targets: d.targets || [],
            // [x, z, standY] — the stand height is 0 when the map ships a bare [x, z]
            waypoints: (d.waypoints || []).map(function(w){ return [+w[0], +w[1], w[2] != null ? +w[2] : 0]; }), nav: []};
    out.nav = buildNav(out);
    return out;
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
  // true when this body is in the void: off the map box, under the deck with no slab
  // to land on, or already past VOID_Y. (A gap in the floor — Sandbar's water — counts.)
  function inVoid(m, x, y, z){
    if(x !== x || y !== y || z !== z) return true;
    if(y < VOID_Y) return true;
    var b = m.bounds;
    if(x < b[0] - 2 || x > b[3] + 2 || z < b[2] - 2 || z > b[5] + 2) return true;
    if(y < 0.05 && topUnder(m, x, y - 0.2, z) === null) return true;
    return false;
  }
  // one step of the runner: s = {x, y, z, vx, vy, vz, g}; (wx, wz) the wished direction.
  // sprint scales the speed you accelerate toward (omitted/false everywhere but the v3 hold).
  // topMult/jumpMult: the speed and leap totems' multipliers (default 1 — every other
  // caller passes nothing, so the shared numbers below stay the referee's word).
  function move(m, s, wx, wz, jump, dt, sprint, topMult, jumpMult, gravMult){
    var top = RUN*(sprint ? SPRINT : 1)*(topMult || 1);
    var k = Math.min(1, dt*(s.g ? ACCEL : AIR_ACCEL));
    s.vx += (wx*top - s.vx)*k;
    s.vz += (wz*top - s.vz)*k;
    if(jump && s.g){ s.vy = JUMP_V*(jumpMult || 1); s.g = false; }
    // gravMult (default 1) is the Gravity Flip / low-gravity arena event — the frozen
    // Python twin and the parity test call move() without it, so its default is the
    // same GRAVITY*dt it always was
    s.vy = Math.max(-FALL_MAX, s.vy - GRAVITY*(gravMult != null ? gravMult : 1)*dt);
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
  // walkable adjacency over the patrol points (rooms + passages). Built once per map so
  // bots can path around adobe instead of pressing a wall forever.
  function losMap(m, a, b){
    var d = [b[0]-a[0], b[1]-a[1], b[2]-a[2]], ln = Math.sqrt(d[0]*d[0] + d[1]*d[1] + d[2]*d[2]);
    if(ln < 1e-6) return true;
    d = [d[0]/ln, d[1]/ln, d[2]/ln];
    return rayMap(m, a, d, ln - 0.001) >= ln - 0.001;
  }
  function wpY(w){ return (w && w[2] != null) ? +w[2] : 0; }
  function buildNav(m){
    // m.waypoints only — the dockyard fallback table lives outside this block.
    // Each point is [x, z, standY]. A hop is walkable when the rise is a step-up
    // (<= STEP_H) and the eye-to-eye ray is clear at each point's own height, so
    // stair chains link ground to deck and a deck never bridges straight down.
    var wps = (m && m.waypoints) ? m.waypoints : [];
    var n = wps.length, adj = [], i, j;
    for(i = 0; i < n; i++) adj.push([]);
    for(i = 0; i < n; i++){
      for(j = i + 1; j < n; j++){
        var dx = wps[i][0] - wps[j][0], dz = wps[i][1] - wps[j][1];
        if(dx*dx + dz*dz > 12.0*12.0) continue;
        var yi = wpY(wps[i]), yj = wpY(wps[j]);
        if(Math.abs(yi - yj) > STEP_H) continue;
        if(losMap(m, [wps[i][0], yi + 0.9, wps[i][1]], [wps[j][0], yj + 0.9, wps[j][1]])){
          adj[i].push(j); adj[j].push(i);
        }
      }
    }
    return adj;
  }
  function nearestWp(m, wps, x, z, y){
    // prefer the nearest waypoint we can actually see at our own height — through a
    // wall the Euclidean nearest lives in the next room, and a deck point under our
    // feet is not a hop we can walk
    y = y != null ? y : 0;
    var best = 0, bd = 1e18, vis = -1, bvd = 1e18;
    for(var i = 0; i < wps.length; i++){
      var wy = wpY(wps[i]);
      var d = (wps[i][0] - x)*(wps[i][0] - x) + (wps[i][1] - z)*(wps[i][1] - z) + (wy - y)*(wy - y);
      if(d < bd){ bd = d; best = i; }
      if(d < bvd && Math.abs(wy - y) <= STEP_H + 0.05 &&
         losMap(m, [x, y + 0.9, z], [wps[i][0], wy + 0.9, wps[i][1]])){ bvd = d; vis = i; }
    }
    return vis >= 0 ? vis : best;
  }
  function bfsWp(adj, a, b){
    if(a === b) return [a];
    var prev = new Array(adj.length), q = [a], head = 0, i;
    for(i = 0; i < adj.length; i++) prev[i] = -1;
    prev[a] = a;
    while(head < q.length){
      var u = q[head++];
      if(u === b){
        var path = [], cur = b;
        for(;;){
          path.push(cur);
          var p = prev[cur];
          if(p < 0 || p === cur) break;
          cur = p;
        }
        return path.reverse();
      }
      for(i = 0; i < adj[u].length; i++){
        var v = adj[u][i];
        if(prev[v] < 0){ prev[v] = u; q.push(v); }
      }
    }
    return null;
  }
  // next walkable hop toward (tx, tz): follow the room/passage graph, or go straight
  // when the destination is already visible. y/ty are stand heights (default 0).
  function navNext(m, x, z, tx, tz, wps, nav, y, ty){
    wps = wps || (m && m.waypoints) || [];
    nav = nav || (m && m.nav) || [];
    y = y != null ? y : 0;
    ty = ty != null ? ty : 0;
    if(!wps.length || nav.length !== wps.length) return [tx, tz];
    // only cut to the destination when THIS body can see it at our height — a hop
    // that sees it is not enough, or the bot walks the wall between here and there
    if(Math.abs(y - ty) <= STEP_H && losMap(m, [x, y + 0.9, z], [tx, ty + 0.9, tz])) return [tx, tz];
    var a = nearestWp(m, wps, x, z, y), b = nearestWp(m, wps, tx, tz, ty);
    var path = bfsWp(nav, a, b);
    if(!path || path.length < 2) return [tx, tz];
    var hop = 1;
    while(hop + 1 < path.length && Math.hypot(wps[path[hop]][0] - x, wps[path[hop]][1] - z) < 1.4) hop++;
    return [wps[path[hop]][0], wps[path[hop]][1]];
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
  // Match flight drones: DRONE_N ping-pong lanes drawn from the map bounds so every
  // shipped / user map gets anchors without a new JSON field. Twin: grapple_routes.
  function grappleRoutes(b){
    b = (b && b.length >= 6) ? b : [-42, -1, -30, 42, 12, 30];
    var x0 = +b[0], z0 = +b[2], x1 = +b[3], z1 = +b[5];
    if(!(x1 > x0 + 1)) x1 = x0 + 84;
    if(!(z1 > z0 + 1)) z1 = z0 + 60;
    var y = DRONE_Y, inset = 5.0;
    var xs = x0 + inset, xe = x1 - inset, zs = z0 + inset, ze = z1 - inset;
    if(xe < xs) xe = xs + 1;
    if(ze < zs) ze = zs + 1;
    var xq = xs + (xe - xs)/3, xq2 = xs + (xe - xs)*2/3;
    var zq = zs + (ze - zs)/3, zq2 = zs + (ze - zs)*2/3;
    // eight slow sky lanes — each drone on its own path: four long east–west rows,
    // two north–south columns, and two mid diagonals (deterministic, bounds-inset).
    return [
      {a: [xs, y, zs],  b: [xe, y, zs],  s: 3.2},
      {a: [xs, y, zq],  b: [xe, y, zq],  s: 3.6},
      {a: [xs, y, zq2], b: [xe, y, zq2], s: 3.0},
      {a: [xs, y, ze],  b: [xe, y, ze],  s: 3.4},
      {a: [xq, y, zs],  b: [xq, y, ze],  s: 3.5},
      {a: [xq2, y, zs], b: [xq2, y, ze], s: 3.1},
      {a: [xs, y, zs],  b: [xe, y, ze],  s: 3.3},
      {a: [xe, y, zs],  b: [xs, y, ze],  s: 3.7}
    ];
  }
  // first match-drone hit along the ray: [dist, index] or null. Twin: drone_hit.
  function droneHit(o, d, routes, t, maxd){
    var best = null, bi = -1;
    for(var i = 0; i < (routes || []).length; i++){
      var tg = routes[i], c = targetAt(tg, t);
      var b = [c[0]-DRONE_R, c[1]-DRONE_R*0.7, c[2]-DRONE_R, c[0]+DRONE_R, c[1]+DRONE_R*0.7, c[2]+DRONE_R];
      var h = rayBox(o, d, b);
      if(h !== null && h < maxd && (best === null || h < best)){ best = h; bi = i; }
    }
    return best === null ? null : [best, bi];
  }
  return {R: R, H: H, EYE: EYE, STEP_H: STEP_H, RUN: RUN, SPRINT: SPRINT, ACCEL: ACCEL, AIR_ACCEL: AIR_ACCEL, GRAVITY: GRAVITY, JUMP_V: JUMP_V,
          LEAP_MULT: LEAP_MULT, SPEED_MULT: SPEED_MULT, WING_TOP: WING_TOP, WING_RISE: WING_RISE, WING_SINK: WING_SINK, WING_DRIFT: WING_DRIFT,
          STAMINA_MAX: STAMINA_MAX, STAMINA_DRAIN: STAMINA_DRAIN, STAMINA_REGEN: STAMINA_REGEN, SPRINT_SLOW: SPRINT_SLOW,
          DROP_HEIGHT: DROP_HEIGHT, DROP_TIME: DROP_TIME, DROP_SINK: DROP_SINK, DROP_DRIFT: DROP_DRIFT,
          FALL_MAX: FALL_MAX, BODY_R: BODY_R, BODY_H: BODY_H, HEAD_R: HEAD_R, HEAD_TOP: HEAD_TOP, WEAPONS: WEAPONS,
          VOID_Y: VOID_Y, VOID_SECS: VOID_SECS, inVoid: inVoid,
          markDamage: markDamage,
          compileMap: compileMap, overlaps: overlaps, topUnder: topUnder, move: move, dirOf: dirOf, mb32: mb32,
          spreadOf: spreadOf, rayBox: rayBox, rayMap: rayMap, hitBoxes: hitBoxes, rayPlayer: rayPlayer, targetAt: targetAt,
          buildNav: buildNav, navNext: navNext, losMap: losMap,
          LAUNCH: LAUNCH, MISSILE_V: MISSILE_V, MISSILE_G: MISSILE_G, MISSILE_TTL: MISSILE_TTL,
          BLAST_R: BLAST_R, DIRECT_R: DIRECT_R, blastDamage: blastDamage,
          GRAPPLE_W: GRAPPLE_W, LAUNCH_W: LAUNCH_W, BOT_WEAPON_MAX: BOT_WEAPON_MAX,
          DRONE_Y: DRONE_Y, DRONE_R: DRONE_R, DRONE_N: DRONE_N, DRONE_PHASE: DRONE_PHASE,
          GRAPPLE_TIME: GRAPPLE_TIME, GRAPPLE_SWING: GRAPPLE_SWING, GRAPPLE_UP: GRAPPLE_UP,
          GRAPPLE_PULL: GRAPPLE_PULL, HOOK_LOCK: HOOK_LOCK, GRAPPLE_RISE: GRAPPLE_RISE,
          grappleRoutes: grappleRoutes, droneHit: droneHit};
})();
/* STRIKE-SHARED END */

/* ---------- tuning (browser only) ---------- */
var STEP = 1/120, SEND_EVERY = 0.05, KEEPALIVE = 0.5, SWITCH = 0.25, RESPAWN = 3, PRACTICE_SECS = 60;
// offline bot brains (solo bot match) — mirrored from backend/src/strike.rs
var BOT_THINK = 0.25, BOT_TURN = 9.0, BOT_AIM = 0.04, BOT_RANGE = 45.0, BOT_REACT = 0.35;
var STORM_RANGE = 22.0;   // a sandstorm arena event halves how far a bot can see
// solo difficulty: scales the offline bots' aim error, reaction, turn speed, refire pause and
// close-range mercy (the Arena server keeps its own tuned bots — these only shape the match
// you play alone). `rate` > 1 forces a gap BETWEEN shots (beyond the weapon's own interval).
// `cqc` is a guaranteed-miss radius in metres: inside it the bot's aim is pushed PAST the
// target's angular size, so even a point-blank Easy bot whiffs instead of shredding you —
// at close range a body spans several degrees of arc, so a wide random error alone still hits.
var DIFFS = [
  {id: "easy", n: "Easy", aim: 10.0, react: 2.5, turn: 0.30, rate: 3.0, cqc: 9.0},
  {id: "normal", n: "Normal", aim: 3.2, react: 1.2, turn: 0.70, rate: 1.8, cqc: 6.0},
  {id: "hard", n: "Hard", aim: 2.0, react: 0.5, turn: 1.8, rate: 1.2, cqc: 1.5},
  {id: "sweaty", n: "Sweaty", aim: 0.10, react: 0.12, turn: 3.5, rate: 1.0, cqc: 0.0}];
function diffOf(){
  var s = null; try { s = ssave(); } catch(e){}
  var id = (s && s.diff) || "sweaty";
  for(var i = 0; i < DIFFS.length; i++) if(DIFFS[i].id === id) return DIFFS[i];
  return DIFFS[1];
}
var WAYPOINTS = [
  [-28.0, -24.0, 0.0],
  [-20.0, -24.0, 0.0],
  [-12.0, -24.0, 0.0],
  [-4.0, -24.0, 0.0],
  [4.0, -24.0, 0.0],
  [12.0, -24.0, 0.0],
  [20.0, -24.0, 0.0],
  [28.0, -24.0, 0.0],
  [-36.0, -16.0, 0.0],
  [-28.0, -16.0, 0.0],
  [-20.0, -16.0, 0.0],
  [-12.0, -16.0, 0.0],
  [-4.0, -16.0, 0.0],
  [4.0, -16.0, 0.0],
  [12.0, -16.0, 0.0],
  [20.0, -16.0, 0.0],
  [28.0, -16.0, 0.0],
  [36.0, -16.0, 0.0],
  [-36.0, -8.0, 0.0],
  [-28.0, -8.0, 0.0],
  [-20.0, -8.0, 0.0],
  [-4.0, -8.0, 0.0],
  [4.0, -8.0, 0.0],
  [20.0, -8.0, 0.0],
  [28.0, -8.0, 0.0],
  [36.0, -8.0, 0.0],
  [-28.0, 0.0, 0.0],
  [-20.0, 0.0, 0.0],
  [-12.0, 0.0, 0.0],
  [12.0, 0.0, 0.0],
  [20.0, 0.0, 0.0],
  [28.0, 0.0, 0.0],
  [-36.0, 8.0, 0.0],
  [-28.0, 8.0, 0.0],
  [-20.0, 8.0, 0.0],
  [-4.0, 8.0, 0.0],
  [4.0, 8.0, 0.0],
  [20.0, 8.0, 0.0],
  [28.0, 8.0, 0.0],
  [36.0, 8.0, 0.0],
  [-36.0, 16.0, 0.0],
  [-28.0, 16.0, 0.0],
  [-20.0, 16.0, 0.0],
  [-12.0, 16.0, 0.0],
  [-4.0, 16.0, 0.0],
  [4.0, 16.0, 0.0],
  [12.0, 16.0, 0.0],
  [20.0, 16.0, 0.0],
  [28.0, 16.0, 0.0],
  [36.0, 16.0, 0.0],
  [-28.0, 24.0, 0.0],
  [-20.0, 24.0, 0.0],
  [-12.0, 24.0, 0.0],
  [-4.0, 24.0, 0.0],
  [4.0, 24.0, 0.0],
  [12.0, 24.0, 0.0],
  [20.0, 24.0, 0.0],
  [28.0, 24.0, 0.0],
  [0.0, -20.0, 0.0],
  [0.0, 20.0, 0.0],
  [-30.0, -10.0, 0.0],
  [30.0, 10.0, 0.0],
  [-30.0, 10.0, 0.0],
  [30.0, -10.0, 0.0],
  [0.0, -8.0, 0.0],
  [0.0, 8.0, 0.0],
  [0.0, -16.0, 0.0],
  [0.0, 16.0, 0.0],
  [-36.0, -20.2, 0.0],
  [-36.0, 20.2, 0.0],
  [36.0, -20.2, 0.0],
  [36.0, 20.2, 0.0],
  [-36.0, -21.75, 0.5],
  [-36.0, 21.75, 0.5],
  [36.0, -21.75, 0.5],
  [36.0, 21.75, 0.5],
  [-36.0, -22.85, 1.0],
  [-36.0, 22.85, 1.0],
  [36.0, -22.85, 1.0],
  [36.0, 22.85, 1.0],
  [-36.0, -23.95, 1.5],
  [-36.0, 23.95, 1.5],
  [36.0, -23.95, 1.5],
  [36.0, 23.95, 1.5],
  [-36.0, -25.05, 2.0],
  [-36.0, 25.05, 2.0],
  [36.0, -25.05, 2.0],
  [36.0, 25.05, 2.0],
  [-36.0, -25.95, 2.5],
  [-36.0, 25.95, 2.5],
  [36.0, -25.95, 2.5],
  [36.0, 25.95, 2.5],
  [-24.0, -20.2, 0.0],
  [-24.0, 20.2, 0.0],
  [24.0, -20.2, 0.0],
  [24.0, 20.2, 0.0],
  [-24.0, -21.75, 0.5],
  [-24.0, 21.75, 0.5],
  [24.0, -21.75, 0.5],
  [24.0, 21.75, 0.5],
  [-24.0, -22.85, 1.0],
  [-24.0, 22.85, 1.0],
  [24.0, -22.85, 1.0],
  [24.0, 22.85, 1.0],
  [-24.0, -23.95, 1.5],
  [-24.0, 23.95, 1.5],
  [24.0, -23.95, 1.5],
  [24.0, 23.95, 1.5],
  [-24.0, -25.05, 2.0],
  [-24.0, 25.05, 2.0],
  [24.0, -25.05, 2.0],
  [24.0, 25.05, 2.0],
  [-24.0, -25.95, 2.5],
  [-24.0, 25.95, 2.5],
  [24.0, -25.95, 2.5],
  [24.0, 25.95, 2.5],
  [-14.0, -20.2, 0.0],
  [-14.0, 20.2, 0.0],
  [14.0, -20.2, 0.0],
  [14.0, 20.2, 0.0],
  [-14.0, -21.75, 0.5],
  [-14.0, 21.75, 0.5],
  [14.0, -21.75, 0.5],
  [14.0, 21.75, 0.5],
  [-14.0, -22.85, 1.0],
  [-14.0, 22.85, 1.0],
  [14.0, -22.85, 1.0],
  [14.0, 22.85, 1.0],
  [-14.0, -23.95, 1.5],
  [-14.0, 23.95, 1.5],
  [14.0, -23.95, 1.5],
  [14.0, 23.95, 1.5],
  [-14.0, -25.05, 2.0],
  [-14.0, 25.05, 2.0],
  [14.0, -25.05, 2.0],
  [14.0, 25.05, 2.0],
  [-14.0, -25.95, 2.5],
  [-14.0, 25.95, 2.5],
  [14.0, -25.95, 2.5],
  [14.0, 25.95, 2.5],
  [-2.0, -20.2, 0.0],
  [-2.0, 20.2, 0.0],
  [2.0, -20.2, 0.0],
  [2.0, 20.2, 0.0],
  [-2.0, -21.75, 0.5],
  [-2.0, 21.75, 0.5],
  [2.0, -21.75, 0.5],
  [2.0, 21.75, 0.5],
  [-2.0, -22.85, 1.0],
  [-2.0, 22.85, 1.0],
  [2.0, -22.85, 1.0],
  [2.0, 22.85, 1.0],
  [-2.0, -23.95, 1.5],
  [-2.0, 23.95, 1.5],
  [2.0, -23.95, 1.5],
  [2.0, 23.95, 1.5],
  [-2.0, -25.05, 2.0],
  [-2.0, 25.05, 2.0],
  [2.0, -25.05, 2.0],
  [2.0, 25.05, 2.0],
  [-2.0, -25.95, 2.5],
  [-2.0, 25.95, 2.5],
  [2.0, -25.95, 2.5],
  [2.0, 25.95, 2.5],
  [-30.0, -26.8, 2.5],
  [-30.0, 26.8, 2.5],
  [30.0, -26.8, 2.5],
  [30.0, 26.8, 2.5],
  [-8.0, -26.8, 2.5],
  [-8.0, 26.8, 2.5],
  [8.0, -26.8, 2.5],
  [8.0, 26.8, 2.5],
  [-19.0, -26.8, 2.5],
  [-19.0, 26.8, 2.5],
  [19.0, -26.8, 2.5],
  [19.0, 26.8, 2.5],
  [0.0, -26.8, 2.5],
  [0.0, 26.8, 2.5],
  [10.0, 16.0, 0.0],
  [10.0, -16.0, 0.0],
  [-10.0, 16.0, 0.0],
  [-10.0, -16.0, 0.0],
  [10.0, 14.5, 0.5],
  [10.0, -14.5, 0.5],
  [-10.0, 14.5, 0.5],
  [-10.0, -14.5, 0.5],
  [10.0, 13.5, 1.0],
  [10.0, -13.5, 1.0],
  [-10.0, 13.5, 1.0],
  [-10.0, -13.5, 1.0],
  [10.0, 12.5, 1.5],
  [10.0, -12.5, 1.5],
  [-10.0, 12.5, 1.5],
  [-10.0, -12.5, 1.5],
  [10.0, 11.65, 1.5],
  [10.0, -11.65, 1.5],
  [-10.0, 11.65, 1.5],
  [-10.0, -11.65, 1.5],
  [10.0, 10.0, 1.5],
  [10.0, -10.0, 1.5],
  [-10.0, 10.0, 1.5],
  [-10.0, -10.0, 1.5],
  [11.4, 0.0, 0.0],
  [-11.4, 0.0, 0.0],
  [9.94, 0.0, 0.5],
  [-9.94, 0.0, 0.5],
  [9.03, 0.0, 1.0],
  [-9.03, 0.0, 1.0],
  [8.11, 0.0, 1.5],
  [-8.11, 0.0, 1.5],
  [7.2, 0.0, 2.0],
  [-7.2, 0.0, 2.0],
  [6.29, 0.0, 2.5],
  [-6.29, 0.0, 2.5],
  [5.37, 0.0, 3.0],
  [-5.37, 0.0, 3.0],
  [4.46, 0.0, 3.5],
  [-4.46, 0.0, 3.5],
  [3.65, 0.0, 3.5],
  [-3.65, 0.0, 3.5],
  [0.0, 0.0, 3.5],
  [0.0, -2.0, 3.5],
  [0.0, 2.0, 3.5],
  [2.2, 0.0, 3.5],
  [-2.2, 0.0, 3.5],
  [40.0, 0.0, 0.0],
  [-40.0, 0.0, 0.0],
  [38.55, 0.0, 0.5],
  [-38.55, 0.0, 0.5],
  [37.65, 0.0, 1.0],
  [-37.65, 0.0, 1.0],
  [36.75, 0.0, 1.5],
  [-36.75, 0.0, 1.5],
  [35.85, 0.0, 2.0],
  [-35.85, 0.0, 2.0],
  [35.05, 0.0, 2.5],
  [-35.05, 0.0, 2.5],
  [34.2, 0.0, 2.5],
  [-34.2, 0.0, 2.5],
  [14.2, 15.5, 0.0],
  [14.2, -15.5, 0.0],
  [-14.2, 15.5, 0.0],
  [-14.2, -15.5, 0.0],
  [14.2, 14.0, 0.5],
  [14.2, -14.0, 0.5],
  [-14.2, 14.0, 0.5],
  [-14.2, -14.0, 0.5],
  [14.2, 13.0, 1.0],
  [14.2, -13.0, 1.0],
  [-14.2, 13.0, 1.0],
  [-14.2, -13.0, 1.0],
  [14.2, 12.0, 1.5],
  [14.2, -12.0, 1.5],
  [-14.2, 12.0, 1.5],
  [-14.2, -12.0, 1.5],
  [14.2, 11.0, 2.0],
  [14.2, -11.0, 2.0],
  [-14.2, 11.0, 2.0],
  [-14.2, -11.0, 2.0],
  [14.2, 10.15, 2.5],
  [14.2, -10.15, 2.5],
  [-14.2, 10.15, 2.5],
  [-14.2, -10.15, 2.5],
  [14.2, 7.5, 2.5],
  [14.2, -7.5, 2.5],
  [-14.2, 7.5, 2.5],
  [-14.2, -7.5, 2.5],
  [34.2, 15.5, 0.0],
  [34.2, -15.5, 0.0],
  [-34.2, 15.5, 0.0],
  [-34.2, -15.5, 0.0],
  [34.2, 14.0, 0.5],
  [34.2, -14.0, 0.5],
  [-34.2, 14.0, 0.5],
  [-34.2, -14.0, 0.5],
  [34.2, 13.0, 1.0],
  [34.2, -13.0, 1.0],
  [-34.2, 13.0, 1.0],
  [-34.2, -13.0, 1.0],
  [34.2, 12.0, 1.5],
  [34.2, -12.0, 1.5],
  [-34.2, 12.0, 1.5],
  [-34.2, -12.0, 1.5],
  [34.2, 11.0, 2.0],
  [34.2, -11.0, 2.0],
  [-34.2, 11.0, 2.0],
  [-34.2, -11.0, 2.0],
  [34.2, 10.15, 2.5],
  [34.2, -10.15, 2.5],
  [-34.2, 10.15, 2.5],
  [-34.2, -10.15, 2.5],
  [34.2, 7.5, 2.5],
  [34.2, -7.5, 2.5],
  [-34.2, 7.5, 2.5],
  [-34.2, -7.5, 2.5],
  [23.0, 18.5, 0.0],
  [23.0, -18.5, 0.0],
  [-23.0, 18.5, 0.0],
  [-23.0, -18.5, 0.0],
  [21.55, 18.5, 0.5],
  [21.55, -18.5, 0.5],
  [-21.55, 18.5, 0.5],
  [-21.55, -18.5, 0.5],
  [20.65, 18.5, 1.0],
  [20.65, -18.5, 1.0],
  [-20.65, 18.5, 1.0],
  [-20.65, -18.5, 1.0],
  [19.75, 18.5, 1.5],
  [19.75, -18.5, 1.5],
  [-19.75, 18.5, 1.5],
  [-19.75, -18.5, 1.5],
  [18.85, 18.5, 2.0],
  [18.85, -18.5, 2.0],
  [-18.85, 18.5, 2.0],
  [-18.85, -18.5, 2.0],
  [18.05, 18.5, 2.5],
  [18.05, -18.5, 2.5],
  [-18.05, 18.5, 2.5],
  [-18.05, -18.5, 2.5],
  [17.2, 18.5, 2.5],
  [17.2, -18.5, 2.5],
  [-17.2, 18.5, 2.5],
  [-17.2, -18.5, 2.5],
  [14.2, 0.0, 2.5],
  [-14.2, 0.0, 2.5],
  [14.2, 3.75, 2.5],
  [14.2, -3.75, 2.5],
  [-14.2, 3.75, 2.5],
  [-14.2, -3.75, 2.5],
  [34.2, 3.75, 2.5],
  [34.2, -3.75, 2.5],
  [-34.2, 3.75, 2.5],
  [-34.2, -3.75, 2.5],
];
var INTERP = 0.1, JIT_MAX = 0.25, SNAPS = 12, LOOK = 0.0022, PITCH_MAX = 89;
var CHARS = [{f: "character-female-a", n: "Ada"}, {f: "character-male-a", n: "Abe"}, {f: "character-female-c", n: "Cleo"},
             {f: "character-male-c", n: "Cal"}, {f: "character-female-e", n: "Eve"}, {f: "character-male-e", n: "Eli"}];
var CHAR_SWATCH = ["#e0574a", "#3a6fd8", "#3aa86a", "#e0b325", "#8a3fd8", "#e07b25"];
// amber (team 0) and cyan (team 1): tags, boards, the 2D map and the feed
var TEAMS = [{n: "Amber", c: "#dc8c33", rgb: 0xdc8c33}, {n: "Cyan", c: "#3fb8c9", rgb: 0x3fb8c9}];
var MINUTES = [3, 5, 10], KILLS = [10, 20, 30, 50], TEAM_SIZES = [1, 2, 3, 4, 5];
// map pickups: the permanent health/ammo packs come from the map file; totem slots are
// added per match once a bot exists so they never clutter a pure-human duel. Each slot is
// an index into MAP.pickups AND into V.kinds (same layout across server & solo client).
var TOTEMS = {mole:   {hue: "#e0b325", n: "Mole",      dur: 8,  c: 0xe0b325},
              freeze: {hue: "#a15dde", n: "Paralyser", dur: 5,  c: 0xa15dde},
              decoy:  {hue: "#bfeef7", n: "Decoy",     dur: 10, c: 0xbfeef7},
              cloak:  {hue: "#a8b4c2", n: "Cloak",     dur: 12, c: 0xa8b4c2},
              // the same light blue as SHIELD_COLOR (defined below) so the totem's beam,
              // gem and guide row read as "the drop shield, bottled"
              shield: {hue: "#7fd4ff", n: "Shield",    dur: 10, c: 0x7fd4ff},
              // the three movement totems: wings owns the sky, leap owns the Space bar,
              // speed owns the ground — each for its own window, each no defence at all
              wings:  {hue: "#b2f2bb", n: "Wings",     dur: 10, c: 0xb2f2bb},
              leap:   {hue: "#ff922b", n: "Leap",      dur: 10, c: 0xff922b},
              speed:  {hue: "#ffe066", n: "Speed",     dur: 6,  c: 0xffe066},
              // the hop is the whole effect: no window, the taker is just somewhere else
              teleport: {hue: "#ff7ab6", n: "Teleport", dur: 0, c: 0xff7ab6},
              // ---- Wave C: the unique set (Time Freeze ≈ Paralyser, Clone Army ≈ Decoy skipped) ----
              rift:      {hue: "#9d6bff", n: "Rift",         dur: 6,  c: 0x9d6bff},
              mirror:    {hue: "#bfeef7", n: "Mirror Army",  dur: 10, c: 0xbfeef7},
              gravflip:  {hue: "#74c0fc", n: "Gravity Flip", dur: 8,  c: 0x74c0fc},
              rewind:    {hue: "#a9e34b", n: "Time Rewind",  dur: 8,  c: 0xa9e34b},
              shock:     {hue: "#ff6b6b", n: "Shockwave",    dur: 0,  c: 0xff6b6b},
              magnet:    {hue: "#ffd43b", n: "Bullet Magnet",dur: 8,  c: 0xffd43b},
              chain:     {hue: "#66d9e8", n: "Chain Lightning", dur: 0, c: 0x66d9e8},
              trap:      {hue: "#fab005", n: "Trapmaster",   dur: 0,  c: 0xfab005},
              mark:      {hue: "#f03e3e", n: "Hunter's Mark",dur: 12, c: 0xf03e3e},
              blink:     {hue: "#da77f2", n: "Blink Dash",   dur: 0,  c: 0xda77f2},
              bubble:    {hue: "#63e6be", n: "Bubble Fortress", dur: 8, c: 0x63e6be},
              wallrun:   {hue: "#ffe066", n: "Wall Runner",  dur: 10, c: 0xffe066},
              secondwind:{hue: "#69db7c", n: "Second Wind",  dur: 0,  c: 0x69db7c},
              fakedeath: {hue: "#868e96", n: "Fake Death",   dur: 6,  c: 0x868e96},
              ghost:     {hue: "#c0c0ff", n: "Ghost Bullets",dur: 0,  c: 0xc0c0ff},
              cluster:   {hue: "#ff922b", n: "Cluster Shot", dur: 0,  c: 0xff922b},
              overclock: {hue: "#ff8787", n: "Overclock",    dur: 8,  c: 0xff8787},
              ricochet:  {hue: "#4dabf7", n: "Ricochet",     dur: 0,  c: 0x4dabf7},
              infchamber:{hue: "#20c997", n: "Infinite Chamber", dur: 10, c: 0x20c997},
              bodyswap:  {hue: "#e599f7", n: "Body Swap",    dur: 0,  c: 0xe599f7},
              rally:     {hue: "#ffd8a8", n: "Rally",        dur: 10, c: 0xffd8a8},
              meteor:    {hue: "#d9480f", n: "Meteor Call",  dur: 0,  c: 0xd9480f},
              chaos:     {hue: "#e64980", n: "Chaos Core",   dur: 12, c: 0xe64980},
              phoenix:   {hue: "#ff922b", n: "Phoenix",      dur: 12, c: 0xff922b},
              pocket:    {hue: "#99e9f2", n: "Pocket Universe", dur: 5, c: 0x99e9f2},
              fate:      {hue: "#f783ac", n: "Fate Splitter",dur: 8,  c: 0xf783ac},
              king:      {hue: "#ffe066", n: "Kingmaker",    dur: 15, c: 0xffe066},
              radarjam:  {hue: "#495057", n: "Radar Jammer", dur: 10, c: 0x495057},
              // ---- Wave D: Arena Disasters (both sides suffer, the taker too) ----
              sandstorm:   {hue: "#d8bc8c", n: "Sandstorm",       dur: 12, c: 0xd8bc8c},
              meteorshower:{hue: "#d9480f", n: "Meteor Shower",   dur: 10, c: 0xd9480f},
              hurricane:   {hue: "#74c0fc", n: "Hurricane",       dur: 10, c: 0x74c0fc},
              thunder:     {hue: "#ffe066", n: "Thunder Apocalypse", dur: 8, c: 0xffe066},
              earthquake:  {hue: "#8a7458", n: "Earthquake",      dur: 8,  c: 0x8a7458},
              shockring:   {hue: "#ff6b6b", n: "Shockwave Apocalypse", dur: 5, c: 0xff6b6b},
              toxicfog:    {hue: "#69db7c", n: "Toxic Fog",       dur: 12, c: 0x69db7c},
              absolutezero:{hue: "#a5d8ff", n: "Absolute Zero",   dur: 10, c: 0xa5d8ff},
              sinkhole:    {hue: "#5c4033", n: "Sinkhole",        dur: 8,  c: 0x5c4033},
              emp:         {hue: "#4dabf7", n: "EMP Apocalypse",  dur: 5,  c: 0x4dabf7}};
// the item guide card (press I) reads these — one line per totem, kept next to TOTEMS
var TOTEM_HELP = {mole:   "Charms an enemy bot for 8s: it shoots its own team, and its kills pay YOUR team. Only drops when a side has a bot.",
                  freeze: "Pins the nearest enemy bot for 5s: it can't move or fire.",
                  decoy:  "Drops a ghost copy of you 3m ahead for 10s: enemy bots shoot the ghost instead of you.",
                  cloak:  "Enemy bots can't see you for 12s. Real players still can.",
                  shield: "Nothing can hurt you for 10s — but you can still shoot back.",
                  wings:  "Fly for 10s: the totem lifts you up to a rooftop height by itself; WASD glides you, then it lands you automatically. You're easy to spot from below.",
                  leap:   "For 10s your Space-bar jumps launch you three times as high.",
                  speed:  "For 6s plain WASD runs at twice sprint pace — no Shift, no stamina spent.",
                  teleport: "Instant: you're somewhere else on the map — always on the ground, always somewhere open.",
                  rift: "Opens a linked pair of rifts ahead of you for 6s. Rockets that fly in one opening come out the other.",
                  mirror: "Spawns three ghost copies of you in a fan for 10s — enemy bots shoot the ghosts.",
                  gravflip: "For 8s your jumps are floaty low-gravity hops. Big air, easy to spot.",
                  rewind: "Instant: you rewind 3s of movement, and for 8s the next killing blow just fails.",
                  shock: "Instant: a shockwave ring blasts out of you — knocks enemies within 6m back and tags them for 35.",
                  magnet: "For 8s bullets that land near you curve into you instead of a nearer mate.",
                  chain: "Your next 2 hits arc Chain Lightning into another enemy within 8m.",
                  trap: "Drops 2 proximity mines at your feet. Your side is immune.",
                  mark: "For 12s every enemy is painted for your side — they can't hide.",
                  blink: "Your next 3 jumps are Blink Dashes: you reappear 6m ahead of where you were.",
                  bubble: "Drops a Bubble Fortress sphere for 8s. Your side inside takes no bullets.",
                  wallrun: "For 10s you hug walls and can hop the 0.55 m ledges without a stair.",
                  secondwind: "The next killing blow just fails — you stand back up at half health.",
                  fakedeath: "For 6s you play dead: bots stop seeing you, and the first shot at you misses.",
                  ghost: "Your next 3 shots pierce through and hit a body behind the first.",
                  cluster: "Your next shot splits: a miss still tags up to 2 enemies near the impact.",
                  overclock: "For 8s your gun fires much faster. The reload is unchanged.",
                  ricochet: "Your next 3 hits bounce into a second enemy within 7m of the first.",
                  infchamber: "For 10s your mag never runs dry — reload becomes a free refill.",
                  bodyswap: "Instant: you and the nearest enemy swap places. 8s cooldown.",
                  rally: "Drops a Rally beacon for 10s. Your side near it reloads faster and heals slowly.",
                  meteor: "Calls a meteor on the nearest enemy (or dead ahead). 1.6s warning, then 80 in a 5m crater.",
                  chaos: "For 12s the Chaos Core pulses a free blast around you every 1.5s.",
                  phoenix: "For 12s the first killing blow just fails — you stand back up full health.",
                  pocket: "For 5s a Pocket Universe wraps you: nothing hurts you, and you can't hurt anyone.",
                  fate: "For 8s you and the nearest other player share every wound 50/50.",
                  king: "For 15s your whole side is marked as royalty: more reserve ammo and faster reloads.",
                  radarjam: "For 10s your team vanishes from the enemy radar and plants fake blips.",
                  // ---- Wave D: Arena Disasters (one line each; everyone suffers) ----
                  sandstorm: "DISASTER: 12s dust wall. The whole map disappears into a sandstorm — sprint drains twice as fast, bots lose half their vision, shots scatter in the grit, and it chips 3 hp a second.",
                  meteorshower: "DISASTER: 10s fire from the sky. Meteors streak down across the map; a glowing circle warns 1s ahead. Get under a shed roof — overhead cover stops it. Near the crater it bites harder and the flash blinds.",
                  hurricane: "DISASTER: 10s. A giant wind column walks the whole map and shoves anyone it reaches. Loose footing (you slow), wild aim (you and bots spray), and it chips 3 hp a second.",
                  thunder: "DISASTER: 8s. Zig-zag lightning bolts slam the map from the sky — flash, then a blast. Stand under one and it hits harder and blinds you. Shed roofs stop it.",
                  earthquake: "DISASTER: 8s. The whole arena shakes and the floor erupts in cracks and dust. Near a crack it hits harder and throws your step (you slow).",
                  shockring: "DISASTER: one huge expanding ring from the centre, visible across the map. It knocks, hurts and briefly blinds everyone it crosses once. Jumping or cover softens it.",
                  toxicfog: "DISASTER: 12s. The whole arena fills with green gas — it chips everyone out in it. The thick clouds that roll through hit harder and choke you to a crawl while you stay.",
                  absolutezero: "DISASTER: 10s ice storm over the whole map — snow, frost fog, frozen light. No sprint, crawling reloads, sliding acceleration, frostbite chips 4 hp a second.",
                  sinkhole: "DISASTER: 8s. A huge pit opens in the ground and pulls everyone toward it. Near the rim you stumble (slow) and it bites 12 hp a second.",
                  emp: "DISASTER: 5s. The whole arena goes dark and blue — lights fail, HUD tracking cuts out, bots can't aim and every shot scatters. Overload chips 2 hp a second. You can still shoot and move."};
// Wave D: the 10 arena-wide disasters. Everyone suffers — both teams, bots included,
// and whoever set one off. A Shield totem holder is the one exception (see meShielded).
var DISASTERS = ["sandstorm", "meteorshower", "hurricane", "thunder", "earthquake",
                 "shockring", "toxicfog", "absolutezero", "sinkhole", "emp"];
var DIS_GAP = 45, DIS_FIRST = 30, DIS_WARN = 2.0;   // the auto-disaster clock (first at 30s, then every 45s)
var DIS_HOLD = {sandstorm: 12, meteorshower: 10, hurricane: 10, thunder: 8, earthquake: 8,
                shockring: 5, toxicfog: 12, absolutezero: 10, sinkhole: 8, emp: 5};
// what the banner says WHILE the disaster is tearing up the map (warn already says INCOMING)
var DIS_LIVE = {sandstorm: "DUST WALL — visibility crushed",
                meteorshower: "FIRE FROM THE SKY — get under a roof",
                hurricane: "WIND COLUMN — it will shove you",
                thunder: "LIGHTNING STRIKES — roofs stop it",
                earthquake: "THE FLOOR IS BREAKING",
                shockring: "SHOCKWAVE EXPANDING",
                toxicfog: "TOXIC CLOUDS SPREADING",
                absolutezero: "ICE STORM — no sprint, crawling reloads",
                sinkhole: "THE GROUND IS OPENING",
                emp: "HUD DOWN — lights failing"};
var DIS_MARK = {sandstorm: 12, meteorshower: 10, hurricane: 10, thunder: 8, earthquake: 8,
                shockring: 5, toxicfog: 12, absolutezero: 10, sinkhole: 8, emp: 5};
var DD_METEOR_R = 3.5, DD_METEOR_DMG = 45, DD_METEOR_WARN = 1.0, DD_METEOR_GAP = 0.55;
var DD_THUNDER_R = 2.8, DD_THUNDER_DMG = 55, DD_THUNDER_WARN = 0.7, DD_THUNDER_GAP = 0.45;
var DD_QUAKE_R = 2.5, DD_QUAKE_DMG = 25, DD_QUAKE_WARN = 0.8, DD_QUAKE_GAP = 0.7;
var DD_SHOCK_R = 28, DD_SHOCK_DMG = 30, DD_SHOCK_KNOCK = 12;
var DD_TOXIC_R = 5, DD_TOXIC_DMG = 8, DD_TOXIC_ZONES = 3;
var DD_TOXIC_CHIP_DMG = 3;   // the green gas fills the arena — everyone chips

var DD_SINK_R = 4.5, DD_SINK_DMG = 12, DD_SINK_PULL = 4;
var DD_WIND_R = 6, DD_WIND_PUSH = 7.5, DD_WIND_DMG = 3;
// exposure bites for the three "modifier" disasters — every disaster must have a
// visual AND an impact (sandstorm grit / frostbite / EMP overload / hurricane blast).
	// Twin: DD_*_DMG in strike.rs.
var DD_SAND_DMG = 3, DD_ZERO_DMG = 4, DD_EMP_DMG = 2;
// proximity crush (shared markDamage): peak at the centre, DD_NEAR_MIN of the peak at the rim
var DD_NEAR_R = 0.35, DD_NEAR_MIN = 0.45;
// non-HP disaster impacts (seconds). Twin: the same windows in backend/src/strike.rs.
var DD_THUNDER_BLIND = 0.45;   // a bolt under your feet whites out the view
var DD_METEOR_BLIND = 0.35;    // the crater flash
var DD_SHOCK_BLIND = 0.55;     // the ring knocks the wind out of you
var DD_QUAKE_SLOW = 1.2;       // the floor throws your step
var DD_TOXIC_SLOW = 0.75;      // choking inside a cloud (speed × this)
var DD_SINK_SLOW = 0.65;       // stumbling toward the pit
var DD_WIND_SLOW = 0.7;        // loose footing in the wind column
var DD_SAND_SCATTER = 1.2;     // grit in the sights (extra shot scatter, degrees)
var DD_WIND_SCATTER = 2.4;     // wild aim in the column
var DD_EMP_SCATTER = 1.0;      // electronic sights haywire
var DD_SLOW_MULT = 0.65;       // walk speed while a disaster slow is on (quake / toxic / sink / wind)
	// ---- The Warden (mid-match boss) — twin of backend/src/strike.rs WARDEN_* ----
	var WARDEN_TRIGGER = 0.5;
	var WARDEN_HP_PER = 2000;
	var WARDEN_MIN_HP = 4000;
	var WARDEN_MAX_HP = 24000;
	var WARDEN_SLAB_R = 3.2;
	var WARDEN_SLAB_ARM = 1.2;
	var WARDEN_SLAB_R_HIT = 4.5;
	var WARDEN_SLAB_KNOCK = 10.0;
	var WARDEN_SLAB_KNOCK_PUSH = 8.0;
	var WARDEN_SLAB_BLAST_DMG = 25;
	var WARDEN_SLAB_CD = 7.0;
	var WARDEN_LOOT_R0 = 18.0;
	var WARDEN_LOOT_RSPAN = 12.0;
	var WARDEN_LOOT_RMIN = 16.0;
	var WARDEN_LASER_WARN = 1.0;
	var WARDEN_LASER_HOLD = 4.0;
	var WARDEN_LASER_CD = 9.0;
	var WARDEN_LASER_YAW0 = 0.35;
	var WARDEN_LASER_W = 0.55;
	var WARDEN_DIS_CD = 14.0;
	var WARDEN_CKPT = 3;
	// silhouette scale: the boss (and its hit volumes) are 3× the first cut
	var WARDEN_SCALE = 3.0;
	// hit volumes: (half-width, half-depth, y0, y1) — already × WARDEN_SCALE
	var WARDEN_BOX_WAIST = [5.4, 3.6, 0.0, 4.8];
	var WARDEN_BOX_CHEST = [6.6, 3.9, 4.8, 11.4];
	var WARDEN_BOX_HEAD = [2.7, 2.7, 11.4, 15.6];
	var WARDEN_BOX_ARM = [1.8, 1.8, 5.4, 15.0];
	var WARDEN_ARM_X = 8.7;
	var WARDEN_ARM_DMG_MULT = 0.35;
	var WARDEN_ARM_HP = 2000;
	// Exposed Core: torso is plated until a slam (or checkpoint II) opens the chest
	var WARDEN_CORE_EXPOSE = 3.0;
	var WARDEN_CORE_COVER_MULT = 0.2;
	var WARDEN_CORE_HIT_MULT = 3.0;
	var WARDEN_CK2_EXPOSE = 6.0;
	// Gravity Grip: open-hand pull toward the torso (cover / sprint breaks it)
	var WARDEN_GRIP_CD = 16.0;
	var WARDEN_GRIP_WARN = 1.0;
	var WARDEN_GRIP_HOLD = 2.0;
	var WARDEN_GRIP_PULL = 5.0;
	var WARDEN_GRIP_R = 28.0;
	var WARDEN_GRIP_MIN = 2.2;
	var WARDEN_GRIP_SWEEP_DMG = 18;
	var WARDEN_CK1_PUSH = 12.0;
	var WARDEN_SLAB_WIRE = 0.9;
	var WARDEN_CHECK_NAMES = ["", "I", "II", "III"];
	// aim / LOS probe heights (arm, chest, waist) and the laser-eye origin.
	// Never prefer the head — it is no weak point and must not be the default aim.
	var WARDEN_SEE_HEAD = 13.5;
	var WARDEN_SEE_CHEST = 7.8;
	var WARDEN_SEE_WAIST = 3.6;
	var WARDEN_SEE_ARM = 10.2;
	// kill feed: keep causes readable long enough to see how you died
	var FEED_TTL = 8;
	var FEED_MAX = 6;
	// env kill causes that are not totems (twin of the Rust `dis` strings)
	var ENV_NAMES = {
	  "warden": "The Warden",
	  "warden-slam": "arm slam",
	  "warden-laser": "laser eyes",
  "warden-grip": "gravity grip",
	  "sandstorm": "Sandstorm",
	  "meteorshower": "Meteorshower",
	  "hurricane": "Hurricane",
	  "thunder": "Thunder",
	  "earthquake": "Earthquake",
	  "shockring": "Shockring",
	  "toxicfog": "Toxic Fog",
	  "absolutezero": "Absolute Zero",
	  "sinkhole": "Sinkhole",
	  "emp": "EMP"
	};
// True when a solid slab sits overhead — a shed roof, a container top, a catwalk.
// This is the cover that keeps an overhead impact (Meteor Shower, Thunder) off you.
function hasRoof(x, y, z){
    var m = MAP; if(!m || !m.boxes) return false;
    for(var i = 0; i < m.boxes.length; i++){
      var b = m.boxes[i];
      if(b[1] > y + 1.45 && b[1] <= y + 5.0
         && x + 0.25 > b[0] && x - 0.25 < b[3]
         && z + 0.25 > b[2] && z - 0.25 < b[5]) return true;
    }
    return false;
  }
// the deterministic rng used by the server + solo client so everyone sees the same drop
function hashMatch(seed, salt){ var x = (seed ^ (salt*0x9e3779b9))|0; return ((x >>> 0) / 4294967295); }
// How far a ground beam can run before it leaves the arena (never off the map).
// Twin: map_laser_run in backend/src/strike.rs.
function mapLaserRun(wx, wz, yaw){
    var b = (MAP && MAP.bounds && MAP.bounds.length === 6) ? MAP.bounds : [-42, -1, -30, 42, 12, 30];
    var dx = Math.cos(yaw||0), dz = Math.sin(yaw||0), run = 200;
    if(dx > 1e-6) run = Math.min(run, (b[3] - 0.5 - (wx||0)) / dx);
    else if(dx < -1e-6) run = Math.min(run, (b[0] + 0.5 - (wx||0)) / dx);
    if(dz > 1e-6) run = Math.min(run, (b[5] - 0.5 - (wz||0)) / dz);
    else if(dz < -1e-6) run = Math.min(run, (b[2] + 0.5 - (wz||0)) / dz);
    return Math.max(4, Math.min(run, 80));
}
// a deterministic zig-zag lightning path from (x0,y0,z0) to the ground mark (x1,y1,z1).
// Kinks come from hashMatch over the frozen disaster seed — never Math.random — so every
// observer paints the same bolt. Ends snap to the sky entry and the strike point.
function boltPts(seed, salt, x0, y0, z0, x1, y1, z1, segs, jitter){
  segs = Math.max(3, segs|0 || 9);
  jitter = jitter != null ? +jitter : 1.7;
  seed = seed|0; salt = salt|0;
  var pts = [], i, u, wob, kx, kz;
  for(i = 0; i <= segs; i++){
    u = i / segs;
    wob = Math.sin(Math.PI * u);          // kinks fade out at both ends
    kx = (hashMatch(seed, salt + i * 2 + 1) - 0.5) * 2 * jitter * wob;
    kz = (hashMatch(seed, salt + i * 2 + 2) - 0.5) * 2 * jitter * wob;
    pts.push([x0 + (x1 - x0) * u + kx, y0 + (y1 - y0) * u, z0 + (z1 - z0) * u + kz]);
  }
  pts[0] = [x0, y0, z0];
  pts[pts.length - 1] = [x1, y1, z1];
  return pts;
}
// one short fork off the main bolt (side branch), same hashed grid
function boltBranch(pts, seed, salt, at){
  if(!pts || pts.length < 3) return null;
  at = at|0; if(at < 1 || at >= pts.length - 1) at = Math.max(1, (pts.length / 2)|0);
  var a = pts[at], len = 2.5 + hashMatch(seed, salt) * 3.5;
  var dx = (hashMatch(seed, salt + 1) - 0.5) * 2, dz = (hashMatch(seed, salt + 2) - 0.5) * 2, dy = -0.55 - hashMatch(seed, salt + 3) * 0.5;
  var ln = Math.sqrt(dx*dx + dy*dy + dz*dz) || 1;
  var b = [a[0] + (dx/ln)*len, Math.max(0.2, a[1] + (dy/ln)*len), a[2] + (dz/ln)*len];
  return boltPts(seed, salt + 40, a[0], a[1], a[2], b[0], b[1], b[2], 4, 0.7);
}
// pick one of n kinds from a small counter/seed. hashMatch's /2^32 output reads the TOP
// bits, so consecutive worldK values (1,2,3,…) collapse onto one index — the auto-disaster
// clock rolled Absolute Zero forever. Math.imul is the golden-ratio mix (totemSpawn's
// pattern) plus a xor-fold so the low bits survive; deterministic, never Math.random.
// Twin: dis_kind in backend-rs/src/strike.rs.
function disKind(seed, salt, n){
  n = n > 0 ? n|0 : 1;
  var x = ((Math.imul(seed|0, 0x9e3779b9) ^ Math.imul(salt|0, 0x85ebca6b)) >>> 0);
  x = (x ^ (x >>> 15)) >>> 0;
  return (x % n) | 0;
}
// the live-drop rings, shared by all three impls: past the map's own packs sit a fixed
// pool of totem slots and pack slots. Both drop clocks REUSE them round-robin — a new
// drop (fresh kind, fresh spot, repetitions allowed) replaces the oldest one, taken or
// not — so slot indices stay stable all match while the drops themselves never stop.
var DROP_SLOTS = 3, PACK_SLOTS = 2, PACK_GAP = 8, TOTEM_GAP = 10, TOTEM_FIRST = 8, PACK_FIRST = 6, BASE_PACKS = 7;
// Wave D: Disaster totems are NOT mixed into the personal roster — they have their own
// ring and their own clock, same "somewhere random, recycled slots" rule as the others.
var DIS_SLOTS = 2, DIS_GAP_DROP = 16, DIS_FIRST_DROP = 12;
var KEYS = [["W A S D / stick", "move"], ["mouse / right stick", "look"], ["click / RT / F", "fire"], ["R / X", "reload"],
            ["Shift / stick click", "sprint"], ["Q / E", "lean to peek"], ["right-click or `~ / LT", "scope in"], ["1 2 3 4 5 / wheel / Tab", "weapon"], ["Space / A", "jump"],
            ["B / Back", "scores"], ["I", "item guide"], ["H", "hide these keys"], ["Esc", "release the mouse"]];
var BUTTONS = {w1: {keys: ["Digit1"]}, w2: {keys: ["Digit2"]}, w3: {keys: ["Digit3"]}, w4: {keys: ["Digit4"]}, w5: {keys: ["Digit5"]}, swap: {keys: [], pad: [3]}, shoot: {keys: ["KeyF"]},
               trig: {keys: [], pad: [7]}, peekL: {keys: ["KeyQ"], pad: [14]}, peekR: {keys: ["KeyE"], pad: [15]}, score: {keys: ["KeyB"], pad: [8]},
               items: {keys: ["KeyI"], pad: [2]},
               sprint: {keys: ["ShiftLeft", "ShiftRight"], pad: [10]},
               wheel: {keys: ["Tab"]},
               // scope in: hold the right mouse button, or (trackpad) the `~ key above Tab; gamepad LT works too
               aim: {keys: ["Backquote"], pad: [6], mouse: 2}};
// weapon "wheel" (hold Tab): emoji glyphs for the slots, in FS.WEAPONS order
// (cannot hotlink real art: IP rule; these are system emoji the OS renders).
var WHEEL_ICONS = ["\u{1F4A8}", "\u{1F3AF}", "\u{1F52B}", "\u{1F680}", "\u{1FA9D}"];
// short kill-feed labels, same index order as FS.WEAPONS / the wheel (0 rapid, 1 marksman,
// 2 revolver, 3 launcher, 4 grapple) — the feed used to collapse everything to rifle/smg
var WSHORT = ["smg", "marksman", "revolver", "launcher", "grapple"];
// snapshot flag: hooked by a grappling gun (trigger locked). Twin: FLAG_HOOK in strike.rs
var FLAG_HOOK = 67108864;
function wLabel(w){
  var i = w|0;
  return WSHORT[i] || WSHORT[0];
}
// lean: how far your eyes slide sideways, how much the camera rolls (radians), how fast it settles
var PEEK_SIDE = 0.55, PEEK_ROLL = 0.16, PEEK_SPEED = 9.0;
// the drop shield's light blue: one constant for the 3D bubble, the 2D-map halo and the
// first-person rim (CSS reads it back through --fps-shield-rim, which keeps games.css hex-free)
var SHIELD_COLOR = "#7fd4ff";
// slide: pure visual — a ground sprint's camera dips then settles; no hitbox or physics change
var SLIDE_DIP = 0.22, SLIDE_RISE = 5.0, SLIDE_FALL = 3.0;
// ADS per weapon: SMG = holographic red-dot sight (gun + sight housing visible);
// Marksman = true sniper scope (gun hidden, world through the lens + crosshair);
// Revolver = plain iron-sight aim (no optics — no ring, no dot, no zoom).
var ADS = [{fov: 63, cls: "reddot"}, {fov: 14, cls: "sniper"}, {fov: 75, cls: ""}, {fov: 75, cls: ""}, {fov: 75, cls: ""}];

function nameOf(p){ return String((p && (p.displayName || p.handle || p.name)) || "Bot").slice(0, 24); }
function mmss(ms){ ms = Math.max(0, ms|0); var s = Math.ceil(ms/1000), m = Math.floor(s/60); s %= 60; return m+":"+(s < 10 ? "0" : "")+s; }
function ssave(){
  var s = api.save; if(!s) return {best: 0};
  if(!s.strike || typeof s.strike !== "object" || Array.isArray(s.strike)) s.strike = {};
  return s.strike;
}

/* ---------- map + three.js, loaded on demand ---------- */
var MAP = null, MAP_P = null, MAP_ID = "dockyard";
// every playable arena; the files sit next to map.json and are served from 127.0.0.1 only
var MAP_FILES = {dockyard: "/games/strike/map.json", sandbar: "/games/strike/map-sandbar.json"};
var MAP_OPTS = [["dockyard", "Harbor Dockyard"], ["sandbar", "Dune Compound"]];
var MAP_CACHE = {};
function mapIdOf(sv){
  sv = sv || ssave();
  return MAP_FILES[sv.mapId] ? sv.mapId : "dockyard";
}
function loadMap(id){
  id = MAP_FILES[id] ? id : "dockyard";
  if(MAP && MAP.id === id) return Promise.resolve(MAP);
  if(MAP_P && MAP_ID === id) return MAP_P;
  MAP_ID = id;
  if(MAP_CACHE[id]){ MAP = MAP_CACHE[id]; MAP_P = Promise.resolve(MAP); return MAP_P; }
  MAP_P = fetch(MAP_FILES[id]).then(function(r){ if(!r.ok) throw new Error("map "+r.status); return r.json(); })
    .then(function(j){
      MAP = FS.compileMap(j);
      MAP_CACHE[id] = MAP;
      return MAP;
    }, function(e){ MAP_P = null; throw e; });
  return MAP_P;
}
// patrol graph: the map's own waypoints when it ships them, else the dockyard fallback
function mapWps(){
  return (MAP && MAP.waypoints && MAP.waypoints.length) ? MAP.waypoints : WAYPOINTS;
}
// walkable adjacency over that graph (rooms + passages). Rebuilt when the waypoint
// list changes; dockyard gets a built nav too so bots stop walking into crates.
function mapNav(){
  var wps = mapWps();
  if(!MAP) return [];
  if(!MAP.nav || MAP.nav.length !== wps.length){
    MAP.nav = FS.buildNav({boxes: MAP.boxes, waypoints: wps});
  }
  return MAP.nav;
}
function mapNavNext(x, z, tx, tz, y, ty){
  return MAP ? FS.navNext(MAP, x, z, tx, tz, mapWps(), mapNav(), y, ty) : [tx, tz];
}

/* =============================== the game view =============================== */
var CUR = null;

function makeGame(host, opts){
  var sv = ssave();
  var V = {mode: opts.mode, ctx: opts.ctx || null, alive: true, paused: false, phase: "idle", round: null, gotView: false,
    unsupported: false, map: !!sv.map, low: !!sv.low, sens: clamp(+sv.sens || 1, 0.2, 3), offline: false, note: "",
    me: {x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, g: true}, yaw: 0, pitch: 0, hp: 100, dead: false, life: 0, prot: false, team: 0,
    w: 0, mag: [30, 5, 6, 1, 5], res: [90, 15, 24, 5, 5], magX: [FS.LAUNCH.mag], resX: [FS.LAUNCH.reserve], reloadAt: 0, readyAt: 0, nextShot: 0, n: 0, kills: 0, deaths: 0,
    missiles: [], shakeAt: -10,
    players: {}, order: [], slots: {}, mySlot: -1, items: [], feed: [], results: null, minutes: 5, limit: 30, tsize: 2, scores: [0, 0],
    goAt: 0, endsAt: 0, deadAt: 0, k: null, kq: 0, off: null, sendAt: 0, sentKey: "", fixAt: 0, score: 0, shots: 0,
    drones: [], startAt: 0, kick: 0, bob: 0, flashAt: -9, hitAt: -9, headAt: -9, hurtAt: -9, hurtDir: 0, board: false, ads: false,
    slowUntil: 0, blindUntil: 0,
    tracers: [], trigWas: false, protUntil: 0, itemBack: null, dmgNums: [], peek: 0, nextLaunchAt: 0, sprinting: false, slideK: 0, slideRoll: 0,
    wheelOpen: false, wheelSel: -1, wheelLook: null, stamina: 100, drag: false, dropUntil: 0, shieldTotemUntil: 0, killCam: null,
    voidAt: 0,
    wingsUntil: 0, leapUntil: 0, speedUntil: 0,
    // grappling gun: hook lock on a foe (cannot shoot) and a drone swing window
    hookUntil: 0, swingUntil: 0, hookTo: null, hookPull: null, swingY: 0,
    mdrones: [], mdronesSnap: false,
    totemAt: null, packAt: null, disAt: null, dropRing: 0,
    // ---- Wave D: Arena Disasters ----
    disaster: "", disasterWarnAt: 0, disasterUntil: 0, disasterHitAt: 0,
    disasterRing: 0, disasterHit: {}, disasterMarks: [], disasterAt: 0,
    disasterSeed: 0, disasterZones: [], disasterPit: null, disasterMarkK: 0,
    // ---- The Warden ----
    // Summon the Warden is ON by default (only an explicit off / 0 keeps it off)
    wardenOn: (sv.wardenOn === undefined || sv.wardenOn === null) ? true : (sv.wardenOn !== false && sv.wardenOn !== 0),
    warden: null, wardenDone: false};
  if(sv.wardenOn === undefined || sv.wardenOn === null){ sv.wardenOn = true; }
  function myId(){ return V.mode === "mp" && MP ? MP.me() : "me"; }
  var LAUNCH_W = FS.LAUNCH_W|0 || 3;  // the launcher's index (rocket path); grapple is FS.GRAPPLE_W
  var GRAPPLE_W = FS.GRAPPLE_W|0 || 4;
  // the chosen tier belongs to the ENEMIES you want to beat — your own bots are always Easy,
  // so Sweaty is "carry these potatoes", never "my team demos the lobby for me" (V lives in
  // makeGame's scope, so this helper must too, not out by DIFFS/diffOf)
  function diffFor(P){ return P && P.team === V.team ? DIFFS[0] : diffOf(); }
  function W(){ return FS.WEAPONS[V.w] || FS.LAUNCH; }
  function magOf(w){ return w === LAUNCH_W ? V.magX : V.mag; }
  function resOf(w){ return w === LAUNCH_W ? V.resX : V.res; }
  // protocol v2 servers fly the launcher too; a v1 Arena serves the first three only
  function weaponCount(){
    if(V.mode !== "mp") return FS.WEAPONS.length;
    var gi = window.ARENA && window.ARENA.arena && window.ARENA.arena.games && window.ARENA.arena.games.strike;
    var v = (gi && (gi.v|0)) || 0;
    if(v < 2) return 3;
    // grapple rides the same roster but only on an Arena that knows the "dr" snap key
    return v >= 9 ? FS.WEAPONS.length : 4;
  }
  // protocol v3 servers accept the sprint flag ("sp" on pos, raised speed cap); a v1/v2
  // Arena serves walk-only, like the v1 launcher clamp above. Solo always sprints.
  function sprintOK(){
    if(V.mode !== "mp") return true;
    var gi = window.ARENA && window.ARENA.arena && window.ARENA.arena.games && window.ARENA.arena.games.strike;
    return !!(gi && (gi.v|0) >= 3);
  }
  // v5 arenas take a host "map" id on start and name it in the roster view
  function mapsOK(){
    if(V.mode !== "mp") return true;
    var gi = window.ARENA && window.ARENA.arena && window.ARENA.arena.games && window.ARENA.arena.games.strike;
    return !!(gi && (((gi.caps || []).indexOf("maps") >= 0) || (gi.v|0) >= 5));
  }
  // v4 arenas accept parachute drops; solo always does (local physics are our own)
  function dropOK(){
    if(V.mode !== "mp") return true;
    var gi = window.ARENA && window.ARENA.arena && window.ARENA.arena.games && window.ARENA.arena.games.strike;
    return !!(gi && (gi.v|0) >= 4);
  }
  // the drop shield: while a parachute glide is actually running, NOTHING can hurt the
  // glider (bullets, blasts, bot aim all bounce) — but they can shoot out freely. Landing
  // (or the DROP_TIME window closing) ends it. Solo: V.dropUntil / P.ai.dropUntil are the
  // glide clocks; MP: the snapshot's shield flag (bit 32) is the server's word.
  function meShielded(t){
    if(V.pocketUntil && t < V.pocketUntil) return true;
    if(V.shieldTotemUntil && t < V.shieldTotemUntil) return true;   // Wave D: a disaster cannot touch a shielded player
    if(V.mode === "mp") return !!(V.prot & 32);
    return !!((V.dropUntil && t < V.dropUntil && !V.me.g) || (V.shieldTotemUntil && t < V.shieldTotemUntil));
  }
  function botShielded(P, t){
    if(!P) return false;
    if(P.pocketUntil === Infinity || (P.pocketUntil && t < P.pocketUntil)) return true;
    if(P.shieldTotemUntil && t < P.shieldTotemUntil) return true;   // Wave D: a disaster cannot touch a shielded player
    if(V.mode === "mp") return !!(P.prot & 32);
    return !!(P.ai && P.ai.dropUntil && t < P.ai.dropUntil);
  }
  function mate(uid){ var P = V.players[uid]; return !!P && P.team === V.team; }

  // a disaster cannot touch this player (Shield totem / drop shield / Pocket Universe / spawn cover)
  function disImmune(P, t){
    if(!P) return false;
    if(P.dead || P.gone) return true;
    if(P.protUntil && t < P.protUntil) return true;
    return botShielded(P, t) || meShielded(t);
  }
  // start (or re-announce) an arena-wide disaster. The taker is just as exposed.
  function disStart(kind, t){
    if(!TOTEMS[kind]) return;
    var hold = DIS_HOLD[kind] || 10;
    V.disaster = kind;
    V.disasterWarnAt = t + DIS_WARN;
    V.disasterUntil = t + DIS_WARN + hold;
    V.disasterHitAt = t + DIS_WARN;
    V.disasterRing = 0;
    V.disasterHit = {};
    V.disasterMarks = [];
    V.disasterMarkK = 0;
    // Freeze the hazard geometry ONCE so the FX and the judge share it (twin of
    // start_disaster in strike.rs). Toxic clouds / the sinkhole pit / impact marks
    // all come from this seed — never re-rolled mid-hold.
    V.disasterSeed = ((Math.imul(V.worldK|0, 0x9e3779b9) + 17) >>> 0);
    V.disasterZones = kind === "toxicfog"
      ? disZonesNear(V.disasterSeed, DD_TOXIC_ZONES, liveSpots()) : [];
    V.disasterPit = kind === "sinkhole"
      ? disSpot((Math.imul(V.disasterSeed, 2654435761) + 47) >>> 0, 5) : null;
    flashCenter("⚠ "+TOTEMS[kind].n.toUpperCase()+" INCOMING");
    say(TOTEMS[kind].n + " incoming — everyone is in it");
    if(R3 && R3.disaster) R3.disaster(kind, true);
  }
  function disClear(t){
    V.disaster = ""; V.disasterWarnAt = 0; V.disasterUntil = 0;
    V.disasterHitAt = 0; V.disasterRing = 0; V.disasterHit = {}; V.disasterMarks = [];
    V.disasterSeed = 0; V.disasterZones = []; V.disasterPit = null; V.disasterMarkK = 0;
    if(R3 && R3.disaster) R3.disaster("", false);
  }
  function disLive(t){
    return !!(V.disaster && t >= (V.disasterWarnAt || 0) && t < (V.disasterUntil || 0));
  }
  // extra shot scatter (degrees of yaw) while a disaster is chewing the sights
  function disAimScatter(t){
    if(!disLive(t)) return 0;
    if(V.disaster === "hurricane") return DD_WIND_SCATTER;
    if(V.disaster === "sandstorm") return DD_SAND_SCATTER;
    if(V.disaster === "emp") return DD_EMP_SCATTER;
    return 0;
  }

  var root = api.mk("div", "vg-golf vg-fps vg-strike"), menu = api.mk("div", "vg-golf-menu"), stage = api.mk("div", "vg-golf-stage hidden");
  root.style.setProperty("--fps-shield-rim", "color-mix(in srgb, "+SHIELD_COLOR+" 35%, transparent)");
  root.style.setProperty("--fps-shield", SHIELD_COLOR);
  root.appendChild(menu); root.appendChild(stage); host.appendChild(root);
  var wrap = api.mk("div", "vg-golf-view vg-fps-view");
  var hud = api.mk("div", "vg-fps-hud"); hud.setAttribute("aria-hidden", "true");
  var cross = api.mk("div", "vg-fps-cross"), crossRing = api.mk("i"), crossDot = api.mk("b");
  cross.appendChild(crossRing); cross.appendChild(crossDot);
  var hitm = api.mk("div", "vg-fps-hitm"), hurt = api.mk("div", "vg-fps-hurt");
  var hpBox = api.mk("div", "vg-fps-hp"), hpTrack = api.mk("span", "vg-fps-hpt"), hpBar = api.mk("i"), hpNum = api.mk("b");
  hpTrack.appendChild(hpBar); hpBox.appendChild(hpTrack); hpBox.appendChild(hpNum);
  var ammoBox = api.mk("div", "vg-fps-ammo"), ammoNum = api.mk("b"), ammoName = api.mk("span"), reloadBar = api.mk("i", "vg-fps-rl");
  ammoBox.appendChild(ammoNum); ammoBox.appendChild(ammoName); ammoBox.appendChild(reloadBar);
  var topBox = api.mk("div", "vg-fps-top"), feedBox = api.mk("ol", "vg-fps-feed"), center = api.mk("div", "vg-fps-center hidden");
  var vignette = api.mk("div", "vg-fps-vig"), scope = api.mk("div", "vg-fps-scope");
  var blindOv = api.mk("div", "vg-fps-blind-ov");
  var stamBox = api.mk("div", "vg-fps-stam hidden"), stamBar = api.mk("i");
  stamBox.appendChild(stamBar);
  // your own drop shield, seen from inside: a rim glow over the view (an overlay ABOVE the
  // canvas — an inset shadow on the canvas wrapper itself paints underneath the canvas)
  // plus a small pill with a draining bar, so the moment the canopy packs is unmistakable
  var shOv = api.mk("div", "vg-fps-shield-ov"), shPill = api.mk("div", "vg-fps-shld hidden"), shBar = api.mk("b");
  shPill.appendChild(document.createTextNode("🛡 Shield "));
  var shTrack = api.mk("i"); shTrack.appendChild(shBar); shPill.appendChild(shTrack);
  // a simple top-down radar: me as a wedge, allies as friendly dots, enemies as red
  // dots (the Radar Jammer blanks the enemy team and plants a few fake blips). Decorative
  // only — the real fight is still the 3D view — so it is aria-hidden with the rest of
  // the HUD and every colour comes from the theme tokens in games.css.
  var radarWrap = api.mk("div", "vg-fps-radar");
  var radarCv = api.mk("canvas", "vg-fps-radar-cv");
  radarCv.width = 120; radarCv.height = 120;
  radarWrap.appendChild(radarCv);
  var radarCtx = radarCv.getContext ? radarCv.getContext("2d") : null;
  var radarAt = 0;
  // cloak (unseen by enemy bots) reads the same way: a grey rim over the view, colour from TOTEMS
  var clOv = api.mk("div", "vg-fps-cloak-ov");
  root.style.setProperty("--fps-cloak-rim", "color-mix(in srgb, "+TOTEMS.cloak.hue+" 30%, transparent)");
  // Wave D: the disaster overlay (fog / flash / ice tint / EMP blue) sits under the HUD
  var disOv = api.mk("div", "vg-fps-dis-ov");
  var disOvIn = api.mk("div", "vg-fps-dis-ov-in");
  disOv.appendChild(disOvIn);
  var wardenBar = api.mk("div", "vg-warden-bar hidden");
  var wardenHp = api.mk("div", "vg-warden-hp");
  var wardenLock = api.mk("div", "vg-warden-lock hidden");
  wardenBar.appendChild(wardenHp);
  [disOv, blindOv, vignette, shOv, clOv, scope, cross, hitm, hurt, hpBox, ammoBox, topBox, feedBox, center, stamBox, shPill, radarWrap, wardenBar, wardenLock].forEach(function(n){ hud.appendChild(n); });
  var board = api.mk("div", "vg-golf-card vg-fps-board hidden"); board.setAttribute("role", "dialog"); board.setAttribute("aria-label", "Scoreboard");
  // the item guide (press I): what each light column on the map hands you
  var guide = api.mk("div", "vg-golf-card vg-fps-board hidden"); guide.setAttribute("role", "dialog"); guide.setAttribute("aria-label", "Item guide");
  var cardBox = api.mk("div", "vg-golf-card vg-fps-card hidden"); cardBox.setAttribute("role", "dialog"); cardBox.setAttribute("aria-label", "Results");
  var pauseBox = api.mk("div", "vg-fps-pause hidden");
  var badge = api.mk("span", "vg-reconnecting vg-golf-badge hidden", "Reconnecting…"); badge.setAttribute("role", "status");
  var load = api.mk("div", "vg-meter vg-golf-load hidden"), loadFill = api.mk("i"); load.appendChild(loadFill); load.setAttribute("aria-hidden", "true");
  var hint = api.mk("p", "vg-golf-hint"), tools = api.mk("div", "vg-row vg-golf-tools"), keysBox = api.mk("div", "vg-golf-keys");
  stage.appendChild(wrap); stage.appendChild(hint); stage.appendChild(tools); stage.appendChild(keysBox);
  function renderKeys(){
    keysBox.textContent = "";
    if(ssave().keysHidden){ keysBox.appendChild(api.mk("span", "vg-muted", "Keys hidden — press H to show them")); return; }
    KEYS.forEach(function(r){ var it = api.mk("span", "vg-golf-key"); it.appendChild(api.mk("kbd", null, r[0])); it.appendChild(document.createTextNode(" "+r[1])); keysBox.appendChild(it); });
  }
  var canvas = null, R3 = null, R2 = null, IN = null, raf = 0, lastT = 0, acc = 0, ro = null, TOK = tokens(), tokAt = 0;

  /* ---------- players ---------- */
  function ensure(uid, info){
    var P = V.players[uid];
    if(!P){
      P = V.players[uid] = {uid: uid, slot: -1, team: 0, bot: false, name: "", ch: 0, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, hp: 100, w: 0, dead: false,
        prot: false, away: false, gone: false, kills: 0, deaths: 0, snaps: [], last: -1, jit: 0, seen: 0, mesh: null, moving: 0, slowUntil: 0, blindUntil: 0};
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
    var s = MP ? MP.st("strike") : null, id = myId(), h = false;
    ((s && s.lobby) || []).forEach(function(p){ if(p.userId === id && p.host) h = true; });
    return h;
  }
  function select(label, opts, val, fn){
    var l = api.mk("label", "vg-golf-check"), s = api.mk("select", "vg-select"); s.setAttribute("aria-label", label);
    opts.forEach(function(o){ var op = api.mk("option", null, o[1]); op.value = String(o[0]); if(o[0] === val) op.selected = true; s.appendChild(op); });
    // numeric values arrive as numbers ("3" -> 3) but ids like "easy" must stay strings —
    // a blind +value turned them into NaN, which silently fell back to the default
    s.addEventListener("change", function(){ var v = s.value; fn(v !== "" && !isNaN(+v) ? +v : v); api.persist(); });
    l.appendChild(document.createTextNode(label+" ")); l.appendChild(s); return l;
  }
  // a small clamped number field, styled like the selects (vg-select is all semantic tokens,
  // so it themes with the rest of the dock in every mode). Empty or junk falls back to dflt.
  function numField(label, lo, hi, val, fn){
    var l = api.mk("label", "vg-golf-check"), f = api.mk("input", "vg-select vg-fps-num");
    f.type = "number"; f.min = String(lo); f.max = String(hi); f.value = String(val);
    f.setAttribute("aria-label", label);
    f.addEventListener("change", function(){ var n = clamp(Math.round(+f.value || 0), lo, hi); f.value = String(n); fn(n); api.persist(); });
    l.appendChild(document.createTextNode(label+" ")); l.appendChild(f); return l;
  }
  // the pre-game card: what Strikezone is, what's in it and what to press — visible before
  // anyone reaches for the I key mid-match. Data-driven: weapons from FS.WEAPONS, totems
  // from TOTEMS/TOTEM_HELP, teams from TEAMS, keys from KEYS, so the card can't drift.
  function ico(hue){
    var b = api.mk("i", "vg-sz-ic"); b.style.background = hue || "var(--panel2)"; b.setAttribute("aria-hidden", "true");
    return b;
  }
  function wIcon(w){
    // reuse the weapon-wheel emoji glyph (system emoji, no art to license), one per
    // FS.WEAPONS slot — index lookup keeps the card in lockstep with the wheel
    var i = FS.WEAPONS.indexOf(w), g = document.createTextNode(WHEEL_ICONS[i > -1 ? i : 0]);
    var s = api.mk("span", "vg-sz-wic"); s.setAttribute("aria-hidden", "true"); s.appendChild(g);
    return s;
  }
  function welcomeCard(){
    var card = api.mk("div", "vg-sz-card");
    card.appendChild(api.mk("p", "vg-sz-kick", "Arena mode · team deathmatch"));
    card.appendChild(api.mk("h3", "vg-sz-h", "Strikezone on "+MAP.name));
    card.appendChild(api.mk("p", "vg-muted", "Two teams — "+TEAMS[0].n+" and "+TEAMS[1].n+" — fight to the kill target or the clock. You run, aim and shoot on your own screen; the referee judges every shot (team-mates can't be hit). Short sides are filled with bots that patrol and shoot."));
    // the arena
    var ar = api.mk("div", "vg-sz-sec");
    ar.appendChild(api.mk("b", null, "The rules"));
    [["🎯", "First to the kill target wins — or whichever side is ahead when the clock runs out."],
     ["🛡", "Respawns fall from the sky under a parachute shield: steer the glide with WASD, untouchable until your boots touch."],
     ["🕳", "Fall off the map and you get 10s in the void, then a parachute back in — there is no endless free-fall."],
     ["⚡", "Fresh drops keep landing mid-match — totems and loose health/ammo packs, somewhere random, on their own clocks."],
     ["🚁", "Four drones cruise the sky on fixed lanes. Real players also carry a grappling gun (key 5): hook a drone and swing across the map, or hook a foe to drag them in — while the hook is on they cannot shoot. It does no damage and holds 5 hooks (ammo crates refill it). Bots never carry it."]]
      .forEach(function(r){ var l = api.mk("div", "vg-sz-lin"); l.appendChild(ico("transparent")); l.children[0].textContent = r[0];
        var s = api.mk("span"); s.appendChild(document.createTextNode(r[1])); l.appendChild(s); ar.appendChild(l); });
    card.appendChild(ar);
    // The Warden — the mid-match boss, spelled out so nobody meets it cold
    var wsec = api.mk("div", "vg-sz-sec");
    wsec.appendChild(api.mk("b", null, "The Warden"));
    var wlead = api.mk("p", "vg-muted");
    wlead.appendChild(document.createTextNode(
      "Summon the Warden is ticked by default in the menu (next to Map view). Halfway to the kill limit a giant torso-only totem-golem (head to waist, no legs) rises at map centre and turns to face the arena. Practice never summons it. Its health bar has three checkpoints (I / II / III at 75 / 50 / 25%) — each one scatters every non-disaster totem plus a health pack far from its body so you can grab them mid-fight."
    ));
    wsec.appendChild(wlead);
    [["🗿", "While it lives nobody can hurt each other — you and every bot shoot only the Warden. The round clock and team scores freeze."],
     ["💪", "Hit volumes: head (no crit), waist, chest core, and two separate arms. Arms soak the least damage on their own pool — disable one and that arm skips its next slam. The kill feed always names how you died (arm slam, laser eyes, gravity grip) — never a mystery."],
     ["✊", "Heavy-arm slam: the torso bends down and the forearms hinge at the elbow into the floor. A red ring warns the ground first. Anything under the fist when it lands dies instantly; just outside that, the smash blows dust and knocks everyone away with damage."],
     ["👁", "Laser eyes: he looks down and a ground beam sweeps the floor across the arena (it stops at the map edge, never off into the void). Touch it and you are out — run or hide behind cover."],
     ["🔥", "Exposed Core: the chest is plated (body shots soak). A slam cracks it open for a few seconds — hit the glowing core for triple damage. Checkpoint II also opens it."],
     ["🌀", "Gravity Grip: an open hand hauls everyone toward the torso. Sprint or duck behind cover to break free; too close and the free arm sweeps you out."],
     ["💥", "Checkpoint identities: I shoves every fighter clear of the body (dust + push, not a slam kill). II opens the core. III drops the next loot burst farther out. Each checkpoint still scatters boosts + a health pack."],
     ["🌪", "Only the Warden calls disasters (including Toxic Fog’s green gas, which chips everyone out in it). The usual totem / pack / disaster drops stop until it falls."],
     ["🏁", "Kill it and the match is back to the normal rules you see above."]]
      .forEach(function(r){ var l = api.mk("div", "vg-sz-lin"); l.appendChild(ico("transparent")); l.children[0].textContent = r[0];
        var s = api.mk("span"); s.appendChild(document.createTextNode(r[1])); l.appendChild(s); wsec.appendChild(l); });
    card.appendChild(wsec);
    // the arsenal — each card says what it does and how to fire it (static copy only)
    var ARSENAL_HOW = {
      rapid: "Hold fire to spray at close range. Key 1.",
      marksman: "One hard shot — right-click to scope. Key 2.",
      revolver: "Steady single hits at mid range. Key 3.",
      launcher: "One rocket, big blast — light zoom on right-click. Key 4.",
      grapple: "Zero damage. Hook a drone to swing up and leap; hook a foe to lock their trigger. Key 5."
    };
    var al = api.mk("div", "vg-sz-sec");
    al.appendChild(api.mk("b", null, "The arsenal"));
    var wrow = api.mk("div", "vg-sz-arms");
    FS.WEAPONS.forEach(function(w){
      var t = api.mk("div", "vg-sz-pill");
      t.appendChild(wIcon(w));
      var b = api.mk("span", "vg-sz-pn");
      b.appendChild(document.createTextNode(w.name));
      b.appendChild(api.mk("small", "vg-muted", w.mag+"-round mag"+(w.auto ? " · auto" : (w.id === "grapple" ? " · 0 damage" : ""))));
      var how = ARSENAL_HOW[w.id] || "";
      if(how) b.appendChild(api.mk("small", "vg-sz-how", how));
      t.appendChild(b); wrow.appendChild(t);
    });
    al.appendChild(wrow);
    card.appendChild(al);
    // the drops — every totem in its true beacon colour
    var dr = api.mk("div", "vg-sz-sec");
    dr.appendChild(api.mk("b", null, "Drops on the map"));
    var msg = api.mk("p", "vg-muted");
    msg.appendChild(document.createTextNode("Every "+TOTEM_GAP+" s a fresh totem lands somewhere random; every "+PACK_GAP+" s a loose health or ammo pack does the same; every "+DIS_GAP_DROP+" s a Disaster totem lands on its own ring. The arena also erupts on its own every "+DIS_GAP+" s (counted down in the top bar). Repetitions allowed, watch the light columns in the sky."));
    dr.appendChild(msg);
    function pillRow(kind){
      var tm = TOTEMS[kind], t2 = api.mk("div", "vg-sz-pill");
      var gem = api.mk("i", "vg-sz-gem"); gem.style.background = tm.hue; gem.setAttribute("aria-hidden", "true");
      t2.appendChild(gem);
      var b = api.mk("span", "vg-sz-pn");
      var nm = api.mk("span"); nm.style.color = tm.hue; nm.appendChild(document.createTextNode(tm.n));
      b.appendChild(nm);
      b.appendChild(api.mk("small", "vg-muted", (tm.dur > 0 ? tm.dur+" s · " : "")+TOTEM_HELP[kind].split(/[:.]/)[0].toLowerCase()));
      t2.appendChild(b);
      return t2;
    }
    var nh = api.mk("div", "vg-muted"); nh.appendChild(document.createTextNode("Totems"));
    dr.appendChild(nh);
    var drow = api.mk("div", "vg-sz-grid");
    Object.keys(TOTEMS).filter(function(k){ return DISASTERS.indexOf(k) < 0; }).forEach(function(k){
      drow.appendChild(pillRow(k));
    });
    dr.appendChild(drow);
    var dh = api.mk("div", "vg-muted"); dh.appendChild(document.createTextNode("Disaster totems"));
    dr.appendChild(dh);
    var dmsg = api.mk("p", "vg-muted");
    dmsg.appendChild(document.createTextNode("These land on their own ring. Grab one and the disaster fires for everyone — a shield is the only way out."));
    dr.appendChild(dmsg);
    var dgrow = api.mk("div", "vg-sz-grid");
    DISASTERS.forEach(function(k){ dgrow.appendChild(pillRow(k)); });
    dr.appendChild(dgrow);
    // what each disaster actually does — the pills above only name them, players need
    // to know what to expect when the top-bar clock hits zero (textContent / createTextNode)
    var dexp = api.mk("div", "vg-sz-sec");
    dexp.appendChild(api.mk("b", null, "What each disaster does"));
    DISASTERS.forEach(function(k){
      var line = api.mk("div", "vg-sz-lin");
      var gem = api.mk("i", "vg-sz-gem"); gem.style.background = TOTEMS[k].hue; gem.setAttribute("aria-hidden", "true");
      line.appendChild(gem);
      var sp = api.mk("span");
      var nm = api.mk("b"); nm.style.color = TOTEMS[k].hue; nm.appendChild(document.createTextNode(TOTEMS[k].n));
      sp.appendChild(nm);
      sp.appendChild(document.createTextNode(" — " + String(TOTEM_HELP[k] || "").replace(/^DISASTER:\s*/, "")));
      line.appendChild(sp);
      dexp.appendChild(line);
    });
    dr.appendChild(dexp);
    card.appendChild(dr);
    // the controls, straight from the same KEYS table the in-game overlay reads
    var ks = api.mk("div", "vg-sz-sec");
    ks.appendChild(api.mk("b", null, "The controls"));
    var krow = api.mk("div", "vg-sz-keys");
    KEYS.forEach(function(r){
      var l = api.mk("div", "vg-sz-key");
      var kc = api.mk("kbd"); kc.textContent = r[0].split(" / ")[0];
      l.appendChild(kc); l.appendChild(document.createTextNode(r[1])); krow.appendChild(l);
    });
    ks.appendChild(krow);
    card.appendChild(ks);
    return card;
  }
  function renderMenu(){
    if(!V.alive) return;
    menu.textContent = "";
    if(!MAP){
      menu.appendChild(api.mk("p", "vg-muted", V.note || "Loading the arena…"));
      if(V.note) menu.appendChild(api.btn("Try again", "primary", function(){ V.note = ""; renderMenu();
        loadMap(mapIdOf()).then(function(){ if(V.alive) renderMenu(); }, function(){ if(V.alive){ V.note = "Couldn't load the arena."; renderMenu(); } }); }));
      return;
    }
    var sv = ssave(), mp = V.mode === "mp", host = mp && isHost();
    if(mp && V.unsupported) menu.appendChild(api.mk("p", "vg-msg", "This Arena server doesn't host Strikezone yet. You can still use the target range."));
    var top = api.mk("div", "vg-row");
    if(mp) top.appendChild(api.btn("Target range (solo)", "", function(){ V.mode = "practice"; renderMenu(); }));
    else if(V.ctx) top.appendChild(api.btn("Back to the lobby", "", function(){ V.mode = "mp"; resetMatch(); requestView(); renderMenu(); }));
    function check(label, val, fn){
      var l = api.mk("label", "vg-golf-check"), cb = api.mk("input"); cb.type = "checkbox"; cb.checked = val;
      cb.addEventListener("change", function(){ fn(cb.checked); api.persist(); });
      l.appendChild(cb); l.appendChild(document.createTextNode(" "+label)); top.appendChild(l);
    }
    check("Map view (2D)", V.map, function(v){ V.map = v; sv.map = v; });
    // default ON — practice still never summons (see wardenTick), but the box shows your preference
    check("Summon the Warden", V.wardenOn, function(v){
      V.wardenOn = v; sv.wardenOn = v;
    });
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
        sv.ch = i; api.persist(); if(mp && MP) MP.send("strike", "char", {c: i}); renderMenu();
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
        if(first){ V.watch = first.user.id || first.user.userId; applyView(V.round); }
      }));
    }
    if(mp){
      menu.appendChild(api.mk("h4", "vg-golf-h", host ? "Start a match" : "Match"));
      var row = api.mk("div", "vg-row");
      var mins = MINUTES.indexOf(sv.minutes|0) >= 0 ? sv.minutes|0 : 5, kl = KILLS.indexOf(sv.kills|0) >= 0 ? sv.kills|0 : 30,
          ts = TEAM_SIZES.indexOf(sv.tsize|0) >= 0 ? sv.tsize|0 : 2;
      if(host){
        // the host sizes the sides: X vs X, bots fill whichever side is short of players.
        // Length/target: the custom field (1..60 min, 1..500 kills) wins over the preset
        // selects when it holds something the server's list doesn't have.
        row.appendChild(select("Teams", TEAM_SIZES.map(function(t){ return [t, t+" vs "+t]; }), ts, function(v){ sv.tsize = v; }));
        row.appendChild(select("Length", MINUTES.map(function(m){ return [m, m+" minutes"]; }), mins, function(v){ sv.minutes = v; }));
        row.appendChild(select("First to", KILLS.map(function(k){ return [k, k+" kills"]; }), kl, function(v){ sv.kills = v; }));
        // one skill for every bot on both sides (bot-filled teams must be fair); the server
        // applies it to its fillers when the match starts
        row.appendChild(select("Bot skill", DIFFS.map(function(d){ return [d.id, d.n]; }), (diffOf() || DIFFS[1]).id,
          function(v){ sv.diff = v; }));
        if(mapsOK()) row.appendChild(select("Map", MAP_OPTS, mapIdOf(sv), function(v){
          sv.mapId = v;
          loadMap(v).then(function(){ if(V.alive) renderMenu(); }, function(){ if(V.alive){ V.note = "Couldn't load that map."; renderMenu(); } });
        }));
        row.appendChild(numField("Custom min", 1, 60, sv.minutes|0 || 5, function(v){ sv.minutes = v; }));
        row.appendChild(numField("Custom kills", 1, 500, sv.kills|0 || 30, function(v){ sv.kills = v; }));
        row.appendChild(api.btn("Start the match", "primary", function(){
          // the server takes the host's word for minutes/kills inside its clamps (any value,
          // not just MINUTES/KILLS) — the lists above are just quick presets
          var s = ssave(), m = clamp(Math.round(s.minutes|0 || 5), 1, 60), k = clamp(Math.round(s.kills|0 || 30), 1, 500);
          if(MP) MP.send("strike", "start", {minutes: m, kills: k, tsize: TEAM_SIZES.indexOf(s.tsize|0) >= 0 ? s.tsize|0 : 2,
            diff: DIFFS.some(function(d){ return d.id === s.diff; }) ? s.diff : "normal",
            map: mapIdOf(s), warden: V.wardenOn ? 1 : 0});
        }));
      } else row.appendChild(api.mk("span", "vg-muted", "Waiting for the host (★ in the lobby) to start a match — any side short of humans is filled with bots at the host's chosen skill, the same on both teams."));
      menu.appendChild(row);
      if(V.results) menu.appendChild(resultsTable(V.results, "Last match"));
      if(V.round && (V.round.phase === "warmup" || V.round.phase === "round"))
        menu.appendChild(api.btn("Join the match", "primary", function(){ requestView(); }));
      menu.appendChild(welcomeCard());
    } else {
      // solo: a full offline bot match by default; the classic drone range is the warm-up
      menu.appendChild(api.mk("h4", "vg-golf-h", "Solo"));
      var soloRow = api.mk("div", "vg-row");
      var soloTs = TEAM_SIZES.indexOf(sv.tsize|0) >= 0 ? sv.tsize|0 : 3;   // 3v3 unless you picked otherwise
      soloRow.appendChild(api.btn("Play a bot match ("+soloTs+"v"+soloTs+")", "primary", function(){ startBotMatch(); }));
      soloRow.appendChild(select("Teams", TEAM_SIZES.map(function(t){ return [t, t+" vs "+t]; }), soloTs, function(v){ sv.tsize = v; }));
      soloRow.appendChild(select("Bot skill", DIFFS.map(function(d){ return [d.id, d.n]; }), (diffOf() || DIFFS[DIFFS.length - 1]).id,
        function(v){ sv.diff = v; }));
      soloRow.appendChild(select("Map", MAP_OPTS, mapIdOf(sv), function(v){
        sv.mapId = v;
        loadMap(v).then(function(){ if(V.alive) renderMenu(); }, function(){ if(V.alive){ V.note = "Couldn't load that map."; renderMenu(); } });
      }));
      menu.appendChild(soloRow);
      // the scoreline is yours too: any length and any target, not just the server's list
      var soloCfg = api.mk("div", "vg-row");
      soloCfg.appendChild(numField("Minutes", 1, 60, sv.minutes|0 || 3, function(v){ sv.minutes = v; }));
      soloCfg.appendChild(numField("First to", 1, 500, sv.kills|0 || 10, function(v){ sv.kills = v; }));
      menu.appendChild(soloCfg);
      var cf = api.mk("details", "vg-golf-check"), sum = api.mk("summary", null, "Classic target range (60 s)");
      cf.appendChild(sum);
      var cfRow = api.mk("div", "vg-row");
      cfRow.appendChild(api.btn("Start the range", "", function(){ startPractice(); }));
      var best = sv.best|0; if(best) cfRow.appendChild(api.mk("span", "vg-muted", "Best: "+best+" drones"));
      cf.appendChild(cfRow); menu.appendChild(cf);
      menu.appendChild(welcomeCard());
    }
  }
  function renderTools(){
    tools.textContent = "";
    tools.appendChild(api.btn(V.mode === "mp" ? "Leave the match" : "Back to the menu", "", function(){
      if(V.mode === "mp" && MP && isHost() && (V.phase === "warmup" || V.phase === "round")){
        if(!window.confirm("End the match for everyone?")) return;
        MP.send("strike", "end");
      }
      if(IN) IN.unlock();
      resetMatch(); showStage(false); renderMenu();
    }));
    tools.appendChild(api.btn("Scores", "", function(){ V.board = !V.board; renderBoard(); }));
    tools.appendChild(api.btn("Items", "", function(){ V.guide = !V.guide; renderGuide(); }));
  }
  function resetMatch(){
    // drop slots appended to MAP.pickups during a match are match-local: trim them so the
    // next match (and the server's shorter slot list) sees only the map's own packs
    MAP.pickups.length = BASE_PACKS;
    totemCount = 0; packCount = 0; disCount = 0; V.totemAt = null; V.packAt = null; V.disAt = null;
    V.eventAt = 0; V.fuseAt = 0; V.crateAt = 0; V.worldK = 0;
    V.captureAt = null; V.captureProg = 0; V.captureWho = null; V.captureSince = 0;
    V.arenaEvent = ""; V.arenaEventUntil = 0; V.fateUid = null; V.fateUntil = 0;
    V.disaster = ""; V.disasterWarnAt = 0; V.disasterUntil = 0; V.disasterHitAt = 0;
    V.disasterRing = 0; V.disasterHit = {}; V.disasterMarks = []; V.disasterAt = 0;
    V.disasterSeed = 0; V.disasterZones = []; V.disasterPit = null; V.disasterMarkK = 0;
    V.warden = null; V.wardenDone = false;
    (V.missiles || []).forEach(function(m){ if(m.o && R3) R3.rocket(null, m); }); V.missiles = [];
    clearPlayers(); V.phase = "idle"; V.results = null; V.feed = []; V.drones = []; V.tracers = []; V.dmgNums = []; V.killCam = null;
    V.mdrones = []; V.mdronesSnap = false; V.hookUntil = 0; V.swingUntil = 0; V.hookTo = null; V.hookPull = null; V.swingY = 0;
    cardBox.classList.add("hidden"); board.classList.add("hidden"); guide.classList.add("hidden"); center.classList.add("hidden"); V.board = false; V.guide = false;
    if(R3) R3.clearDynamic();
    // totems die with the old match; the slot "kind" memory resets too
    V.kinds = []; V.decoys = []; V.cloakUntil = 0; V.shieldTotemUntil = 0;
    V.wingsUntil = 0; V.leapUntil = 0; V.speedUntil = 0;
    V.gravUntil = 0; V.magnetUntil = 0; V.wallrunUntil = 0; V.overclockUntil = 0;
    V.infUntil = 0; V.fakeUntil = 0; V.pocketUntil = 0; V.phoenixUntil = 0;
    V.chaosUntil = 0; V.rallyUntil = 0; V.kingUntil = 0; V.fateUntil = 0; V.jamUntil = 0;
    V.secondWind = false; V.chainLeft = 0; V.blinkLeft = 0; V.ghostLeft = 0;
    V.clusterLeft = 0; V.ricoLeft = 0; V.hist = [];
    V.rifts = []; V.mines = []; V.meteors = []; V.beacons = []; V.bubbles = []; V.cursed = {}; V.rings = [];
    others().forEach(function(P){ P.charmUntil = 0; P.freezeUntil = 0; clearMarks(P); });
  }

  /* ---------- me ---------- */
  function placeMe(x, y, z, yawDeg){
    V.slowUntil = 0; V.blindUntil = 0;
    var M = V.me; M.x = x; M.y = y; M.z = z; M.vx = 0; M.vy = 0; M.vz = 0; M.g = true;
    V.voidAt = 0;  // a place is back on the map
    if(yawDeg != null){ V.yaw = yawDeg*Math.PI/180; V.pitch = 0; }
    V.dropUntil = 0;  // a plain ground spawn isn't a drop; dropSpawns set this explicitly
  }
  function randomDropSpot(t, slot, team){
    // one deterministic random-looking spawn point per life (slot ∘ life-seeded): not
    // Math.random() — a player sees the same spot given the same seeds. Own side only:
    // the spawn list is amber's half then cyan's, and dropping into the enemy's half
    // puts you in their lap with your spawn cover already burnt mid-air.
    var n = MAP.spawns.length || 1, half = Math.floor(n/2);
    var pool = team === 1 ? MAP.spawns.slice(half) : MAP.spawns.slice(0, half);
    if(!pool.length) pool = MAP.spawns;
    var seed = ((slot || 0) * 131 + ((t * 1000) | 0)) & 0xFFFF;
    var k = Math.floor(FS.mb32(seed) * pool.length);
    return pool[Math.min(k, pool.length - 1)] || [0, 0, 0, 0];
  }
  // a parachute-drop spawn: pick a random spawn point's XZ and lift the Y. The referee's
  // 4-second spawn-t window (MAX_AIR-let-up) is what makes an 11 m fall legal in v4 arenas.
  function dropSpawn(slot){
    var sp = randomDropSpot(now(), slot, V.team);
    placeMe(sp[0], FS.DROP_HEIGHT, sp[2], sp[3]);
    V.dropUntil = now() + FS.DROP_TIME;
    V.me.g = false;
    V.voidAt = 0;
    return sp;
  }
  function fullAmmo(){ V.mag = FS.WEAPONS.map(function(wp){ return wp.mag; }); V.res = FS.WEAPONS.map(function(wp){ return wp.reserve; }); V.magX = [FS.LAUNCH.mag]; V.resX = [FS.LAUNCH.reserve]; V.reloadAt = 0; V.n = 0; if(V.w >= weaponCount()) V.w = 0; }

  /* ---------- practice: the target range ---------- */
  function startPractice(){
    if(!MAP) return;
    var wantP = mapIdOf();
    if(MAP.id !== wantP){
      loadMap(wantP).then(function(){ if(V.alive) startPractice(); }, function(){ if(V.alive){ V.note = "Couldn't load that map."; renderMenu(); } });
      return;
    }
    resetMatch(); V.mode = "practice"; V.score = 0; V.shots = 0; V.team = 0; V.kinds = [];
    var s = MAP.spawns[0]; placeMe(s[0], s[1], s[2], s[3]); fullAmmo(); V.hp = 100; V.dead = false;
    V.drones = MAP.targets.map(function(tg, i){ return {tg: tg, i: i, downUntil: 0, phase: i*1.7}; });
    // the range's packs land somewhere random this visit — the JSON pads are only a
    // fallback, never a campable spawn
    var pseed = ((((now()*1000)|0) ^ 0x5f356495) >>> 0);
    for(var pi = 0; pi < BASE_PACKS && pi < MAP.pickups.length; pi++){
      MAP.pickups[pi].at = dropSpot((pseed + (pi+1)*2654435761) >>> 0);
    }
    V.items = MAP.pickups.map(function(){ return 1; });
    V.phase = "warmup"; V.goAt = now() + 3; V.endsAt = V.goAt + PRACTICE_SECS;
    showStage(true); if(R3) R3.buildMap();
    // same as the bot match: enter the range already holding the mouse
    if(canvas) canvas.focus();
    if(IN) IN.lock();
    say("Target range: "+PRACTICE_SECS+" seconds.");
  }
  function dronePos(D, t){ var c = FS.targetAt(D.tg, t + D.phase); return c; }

  /* ---------- solo bot match: the same teams/bots as the server, judged locally ---------- */
  var BOT_NAMES = ["Bolt", "Havoc", "Rook", "Vista", "Onyx", "Slate", "Drift", "Crane"];
  function botPlace(P, sp, t){
    P.slowUntil = 0;
    P.x = sp[0]; P.y = sp[1]; P.z = sp[2]; P.yaw = (sp[3]|0)*Math.PI/180; P.pitch = 0;
    P.hp = 100; P.dead = false;
    // solo bots can draw the launcher too — local only, never leaves your machine.
    // deterministic by slot+spawn (never Math.random(): every player sees the same bot twice)
    var seed = ((t*1000)|0) + (P.slot|0)*131;
    P.w = Math.floor(FS.mb32(seed & 0xFFFF)*(FS.BOT_WEAPON_MAX|0 || 4));  // never the grapple
    P.mag = FS.WEAPONS.map(function(wp){ return wp.mag; });
    P.res = FS.WEAPONS.map(function(wp){ return wp.reserve; });
    P.reloadAt = 0; P.protUntil = t + 1.5; // PROTECT (strike.py): 1.5 s of spawn cover, gone once they fire
    P.ai.body = {x: sp[0], y: sp[1], z: sp[2], vx: 0, vy: 0, vz: 0, g: true};
    P.ai.voidAt = 0;   // a place is back on the map
    // v4: a spawn from the sky (initial join comes from a ground spawn list, respawns don't)
    P.ai.dropUntil = sp[1] > 0.5 ? t + FS.DROP_TIME : 0;
    P.ai.aim_y = sp[3]|0; P.ai.aim_p = 0; P.ai.goal = null; P.ai.target = null; P.ai.seenAt = null; P.ai.fireAt = -1e9; P.ai.thinkAt = t + BOT_THINK;
    P.ai.errAt = 0; P.ai.err_y = 0; P.ai.err_p = 0;
    P.ai.stuckAt = 0; P.ai.stuck_x = sp[0]; P.ai.stuck_z = sp[2];
    P.ai.slideUntil = 0;
    // hunt: where the last target vanished, and until when we still bother to look
    P.ai.lostPos = null; P.ai.lostUntil = 0; P.ai.lostY = 0; P.ai.targetY = 0;
    P.ai.huntHold = 10;
    // patrol starts at the waypoint nearest this spawn (same rule as the Arena bots)
    var wps = mapWps(), best = 0, bd = 1e18;
    for(var wi = 0; wi < wps.length; wi++){
      var dwx = wps[wi][0] - sp[0], dwz = wps[wi][1] - sp[2], d2 = dwx*dwx + dwz*dwz;
      if(d2 < bd){ bd = d2; best = wi; }
    }
    // a small per-bot offset so a squad does not all stack on the same first stop
    P.ai.wpi = wps.length ? (best + (P.slot|0)) % wps.length : 0;
  }
  function botSpawnFor(P){
    var half = Math.floor(MAP.spawns.length/2);
    return MAP.spawns[P.team === 0 ? (P.slot % Math.max(1, half)) : half + (P.slot % Math.max(1, MAP.spawns.length - half))];
  }
  function addBot(team, slot, t){
    var uid = "bot-"+team+"-"+slot;
    var P = ensure(uid, {slot: slot, team: team, name: BOT_NAMES[(team*4 + slot) % BOT_NAMES.length], bot: true,
      ch: clamp(slot + team*3, 0, CHARS.length - 1)});
    P.ai = {body: {x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, g: true}};
    P.n = 0;
    P.charmUntil = 0; P.freezeUntil = 0; P.decoyAt = 0; P.slowUntil = 0; P.blindUntil = 0;
    botPlace(P, botSpawnFor(P), t);
    return P;
  }
  // the floating charm/freeze marks over a player's head: one mesh per kind, removed when
  // the effect ends (the server's snapshot flags drive this in MP, the clock in solo)
  function clearMarks(P, kind){
    if(!P || !P.marks) return;
    var frz = kind === "freeze";
    for(var i = P.marks.length - 1; i >= 0; i--){
      if(!kind || P.marks[i].__freeze === frz){
        if(P.mesh && P.mesh.g) P.mesh.g.remove(P.marks[i]);
        P.marks.splice(i, 1);
      }
    }
  }
  /* ---------- The Warden (mid-match boss) ---------- */
  function wardenBoxes(W){
    var cx = (W && W.x) || 0, wz = (W && W.z) || 0;
    function vol(t, ox){
      return [cx + (ox||0) - t[0], t[2], wz - t[1], cx + (ox||0) + t[0], t[3], wz + t[1]];
    }
    // 0 waist, 1 chest, 2 head (crit), 3 left arm, 4 right arm
    return [vol(WARDEN_BOX_WAIST), vol(WARDEN_BOX_CHEST), vol(WARDEN_BOX_HEAD),
            vol(WARDEN_BOX_ARM, -WARDEN_ARM_X), vol(WARDEN_BOX_ARM, WARDEN_ARM_X)];
  }
  function wardenHitIndex(boxes, o, d, reach){
    var best = -1, end = reach == null ? 1e9 : reach;
    for(var i = 0; i < boxes.length; i++){
      if(i === 3 && !(V.warden && V.warden.armL > 0)) continue;
      if(i === 4 && !(V.warden && V.warden.armR > 0)) continue;
      var h = FS.rayBox(o, d, boxes[i]);
      if(h !== null && h < end){ end = h; best = i; }
    }
    return best;
  }
  // Torso damage while the core is plated vs exposed (arms use their own mult).
  // Twin: warden_body_mult in backend/src/strike.rs.
  function wardenBodyMult(W, vol, t){
    if(!W) return 1;
    var open = !!(W.coreUntil && t < W.coreUntil);
    if(!open) return WARDEN_CORE_COVER_MULT;
    return (vol === 1) ? WARDEN_CORE_HIT_MULT : 1;
  }
  function wardenHit(W, vol, dmg, t){
    if(!W || !dmg) return;
    // The Warden has no weak point: the head volume is not a crit. Arms are the
    // preferred (least-damage) target and soak on their own pool. The chest core
    // is plated until a slam opens it — covered torso soaks, an open core bites.
    var head = false, arm = (vol === 3) ? 0 : (vol === 4) ? 1 : -1;
    var base = dmg;
    var dealt = 0;
    if(arm >= 0){
      dealt = Math.round(base * WARDEN_ARM_DMG_MULT);
      if(arm === 0) W.armL = Math.max(0, (W.armL|0) - dealt);
      else W.armR = Math.max(0, (W.armR|0) - dealt);
    } else {
      dealt = Math.round(base * wardenBodyMult(W, vol, t));
      W.hp = Math.max(0, (W.hp|0) - dealt);
    }
    V.hitAt = t;
    V.dmgNums = V.dmgNums || [];
    V.dmgNums.push({x: W.x, y: (arm >= 0 ? 3.0 : 2.2), z: W.z, n: dealt, head: head, at: t, o: null});
    if(V.dmgNums.length > 12) V.dmgNums.shift();
    wardenAfterDamage(W, t);
  }
  function wardenBlast(W, at, t){
    if(!W || !at) return;
    // twin of Rust warden_blast: the nearest live volume takes the blast
    var boxes = wardenBoxes(W), BLAST_R = FS.BLAST_R || 5.0, DIRECT_R = FS.DIRECT_R || 1.5;
    var best = -1, bestDmg = 0;
    for(var i = 0; i < boxes.length; i++){
      if(i === 3 && !(W.armL > 0)) continue;
      if(i === 4 && !(W.armR > 0)) continue;
      var b = boxes[i];
      var px = clamp(at[0], b[0], b[3]), py = clamp(at[1], b[1], b[4]), pz = clamp(at[2], b[2], b[5]);
      var dx = at[0]-px, dy = at[1]-py, dz = at[2]-pz;
      var dist = Math.sqrt(dx*dx + dy*dy + dz*dz);
      if(dist > BLAST_R) continue;
      var dmg = FS.blastDamage(dist, dist < DIRECT_R);
      if(dmg > bestDmg){ bestDmg = dmg; best = i; }
    }
    if(best < 0 || bestDmg <= 0) return;
    if(best === 3) W.armL = Math.max(0, (W.armL|0) - bestDmg);
    else if(best === 4) W.armR = Math.max(0, (W.armR|0) - bestDmg);
    else W.hp = Math.max(0, (W.hp|0) - Math.round(bestDmg * wardenBodyMult(W, best, t)));
    wardenAfterDamage(W, t);
  }
  var WARDEN_FRACS = [0.75, 0.50, 0.25];
  function wardenAfterDamage(W, t){
    if(!W) return;
    if(!W.max) W.max = 1;
    for(var i = 0; i < WARDEN_CKPT; i++){
      if(W.ck[i]) continue;
      var thr = W.max * WARDEN_FRACS[i];
      if(W.hp <= thr){
        W.ck[i] = true;
        var name = WARDEN_CHECK_NAMES[i+1] || String(i+1);
        onEvent({ev: "warden", phase: "ckpt", ck: i+1, name: name, hp: W.hp, max: W.max, x: Math.round(W.x*100), z: Math.round(W.z*100), armL: W.armL|0, armR: W.armR|0});
        wardenLoot(i, t);
        // checkpoint identities: I shoves everyone clear, II cracks the core open
        if(i === 0) wardenShock(t);
        else if(i === 1) W.coreUntil = Math.max(W.coreUntil || 0, t + WARDEN_CK2_EXPOSE);
      }
    }
    if(W.hp <= 0) wardenDeath(t);
  }
  // Checkpoint I: a shockwave shoves every fighter clear of the body (not a slam).
  function wardenShock(t){
    var W = V.warden; if(!W) return;
    [{__me: 1}].concat(others()).forEach(function(Q){
      var qx = Q.__me ? V.me.x : Q.x, qz = Q.__me ? V.me.z : Q.z, qdead = Q.__me ? V.dead : Q.dead;
      if(qdead) return;
      if(Q.__me ? meShielded(t) : botShielded(Q, t)) return;
      var dx = qx - W.x, dz = qz - W.z, d = Math.max(0.15, Math.hypot(dx, dz));
      var kx = dx / d, kz = dz / d, push = WARDEN_CK1_PUSH;
      if(Q.__me){ V.me.x += kx * push; V.me.z += kz * push; V.shakeAt = t; }
      else { Q.x += kx * push; Q.z += kz * push; }
    });
    if(R3 && R3.wardenShock) R3.wardenShock(t);
  }
  function wardenLoot(ckpt, t){
    // one of each non-disaster totem + one health pack, scattered away from the body
    // (twin of Rust warden_loot: seed = born*0x9E3779B9 + 0x57A71001 + ckpt*64)
    ensureDropSlots();
    var ALL = ["mole","freeze","decoy","cloak","shield","wings","leap","speed","teleport",
      "rift","mirror","gravflip","rewind","shock","magnet","chain","trap","mark","blink","bubble",
      "wallrun","secondwind","fakedeath","ghost","cluster","overclock","ricochet","infchamber",
      "bodyswap","rally","meteor","chaos","phoenix","pocket","fate","king","radarjam"];
    var W = V.warden; if(!W) return;
    var born = (W.born|0) || 1;
    var seed = (((born * 0x9E3779B9) + 0x57A71001 + ((ckpt|0) * 64)) >>> 0);
    var base = MAP.pickups.length;
    var kinds = ALL.concat(["health"]);
    for(var i = 0; i < kinds.length; i++){
      var salt = 200 + (ckpt|0)*64 + i;
      // scatter clear of the body (fists land at |x|≈8.7, chest half-width 6.6) —
      // even slots bias +Z, odd −Z so the burst fans both ways
      var sideZ = ((i % 2) === 0) ? 1 : -1;
      var ang = sideZ * (Math.PI * 0.5) + (hashMatch(seed, salt) - 0.5) * Math.PI * 1.4;
      var rad = WARDEN_LOOT_R0 + hashMatch(seed, salt + 17) * WARDEN_LOOT_RSPAN;
      var x = W.x + Math.cos(ang) * rad, z = W.z + Math.sin(ang) * rad;
      for(var k = 0; k < 24 && (Math.hypot(x - W.x, z - W.z) < WARDEN_LOOT_RMIN || FS.overlaps(MAP, x, 0.1, z, 0) >= 0); k++){
        var s2 = (seed + (k+1)*2654435761 + i) >>> 0;
        ang = sideZ * (Math.PI * 0.5) + (hashMatch(s2, salt) - 0.5) * Math.PI * 1.4;
        rad = WARDEN_LOOT_R0 + hashMatch(s2, salt + 17) * WARDEN_LOOT_RSPAN;
        x = W.x + Math.cos(ang) * rad; z = W.z + Math.sin(ang) * rad;
      }
      var kind = kinds[i];
      var idx = base + i;
      MAP.pickups[idx] = {id: kind+"-w"+ckpt+"-"+i, kind: kind, at: [x, 0, z], tag: kind === "health" ? "warden-pack" : "warden"};
      V.items[idx] = 1; if(V.itemBack) delete V.itemBack[idx];
      V.kinds[idx] = kind === "health" ? "" : kind;
      if(R3){
        if(kind === "health" || kind === "ammo") R3.addPack(idx, MAP.pickups[idx]);
        else R3.addTotem(idx, MAP.pickups[idx]);
      }
    }
  }
  function wardenDeath(t){
    var W = V.warden; if(!W) return;
    var max = W.max|0 || 1;
    V.warden = null; V.wardenDone = true;
    onEvent({ev: "warden", phase: "dead", hp: 0, max: max});
    // restore the match clocks the boss had paused
    V.totemAt = t + TOTEM_GAP;
    V.packAt = t + PACK_GAP;
    V.disAt = t + DIS_GAP_DROP;
    V.disasterAt = t + DIS_FIRST;
    if(V.endsAt != null && W.pausedMs){ V.endsAt = t + W.pausedMs/1000; }
    if(R3 && R3.wardenClear) R3.wardenClear();
  }
  function wardenSummon(t){
    if(V.warden || V.wardenDone || V.mode === "practice") return;
    var fighters = 1 + others().filter(function(P){ return !P.dead && !P.gone; }).length;
    var max = clamp(WARDEN_HP_PER * fighters, WARDEN_MIN_HP, WARDEN_MAX_HP);
    var b = (MAP && MAP.bounds && MAP.bounds.length === 6) ? MAP.bounds : [-42, -1, -30, 42, 12, 30];
    var cx = (b[0] + b[3]) / 2, cz = (b[2] + b[5]) / 2;
    var nowMs = Math.max(0, Math.round(Math.max(0, (V.endsAt || 0) - t) * 1000));
    V.warden = {
      hp: max, max: max, phase: "live", x: cx, z: cz, yaw: 0,
      slabAt: t + 2.5, slabArm: 0, slabLand: 0, slamArm: 0,
      laserAt: t + WARDEN_LASER_CD, laserWarn: 0, laserOn: 0, laserYaw: 0,
      disAt: t + WARDEN_DIS_CD,
      ck: [false, false, false],
      armL: WARDEN_ARM_HP, armR: WARDEN_ARM_HP,
      born: t, pausedMs: nowMs, wdArmWarn: false,
      coreUntil: 0, gripWarn: 0, gripOn: 0, gripAt: t + 8.0
    };
    V.wdArmWarn = false;
    // suspend normal drops + auto-disaster; only the boss may call disasters / drop loot
    V.totemAt = null; V.packAt = null; V.disAt = null; V.disasterAt = null;
    onEvent({ev: "warden", phase: "rise", hp: max, max: max, x: Math.round(cx*100), z: Math.round(cz*100), armL: WARDEN_ARM_HP, armR: WARDEN_ARM_HP});
    if(R3 && R3.wardenRise) R3.wardenRise(V.warden);
  }
  function wardenTick(dt, t){
    if(V.mode === "practice") return;
    if(!V.warden){
      if(!V.wardenOn || V.wardenDone || V.phase !== "round") return;
      var lim = V.limit || 30, half = Math.ceil(lim * WARDEN_TRIGGER);
      if((V.scores[0]|0) >= half || (V.scores[1]|0) >= half) wardenSummon(t);
      return;
    }
    var W = V.warden;
    // ---- body turn: the torso faces around the arena (twin of Rust warden_tick) ----
    if(W.laserOn > 0 && t >= W.laserWarn){
      W.yaw = W.laserYaw || 0;
    } else {
      var turnN = ((t - W.born) / 6) | 0;
      var tYaw = hashMatch((W.born|0) ^ 0xB0D9, 40 + turnN) * Math.PI * 2;
      var y0 = W.yaw || 0;
      var yd = ((tYaw - y0 + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      W.yaw = y0 + yd * Math.min(1, dt / 2);
    }
    // ---- arm slam (twin: telegraph and land share WARDEN_SLAB_ARM) ----
    if(W.slabArm > 0 && t >= W.slabArm){
      W.slabArm = 0; W.slabLand = 0;
      var pts = [];
      if((W.slamArm === 0 || W.slamArm === 2) && W.armL > 0) pts.push({x: W.x - WARDEN_ARM_X, z: W.z});
      if((W.slamArm === 1 || W.slamArm === 2) && W.armR > 0) pts.push({x: W.x + WARDEN_ARM_X, z: W.z});
      for(var pi = 0; pi < pts.length; pi++){
        var p = pts[pi];
        [{__me: 1}].concat(others()).forEach(function(Q){
          var qx = Q.__me ? V.me.x : Q.x, qz = Q.__me ? V.me.z : Q.z, qdead = Q.__me ? V.dead : Q.dead;
          if(qdead) return;
          var dsl = Math.hypot(qx - p.x, qz - p.z);
          if(dsl <= WARDEN_SLAB_R_HIT){
            endBotLife(null, Q.__me ? null : Q, t, false, "warden-slam");
          } else if(dsl <= WARDEN_SLAB_KNOCK){
            // the blast blows everyone near the smash away and hurts
            var lnsl = Math.max(0.05, dsl);
            var kxs = (qx - p.x) / lnsl, kzs = (qz - p.z) / lnsl;
            if(Q.__me){
              V.me.x += kxs * WARDEN_SLAB_KNOCK_PUSH;
              V.me.z += kzs * WARDEN_SLAB_KNOCK_PUSH;
              V.hp -= WARDEN_SLAB_BLAST_DMG;
              V.shakeAt = t;
              if(V.hp <= 0 && !V.dead) endBotLife(null, null, t, false, "warden-slam");
            } else {
              Q.x += kxs * WARDEN_SLAB_KNOCK_PUSH;
              Q.z += kzs * WARDEN_SLAB_KNOCK_PUSH;
              Q.hp -= WARDEN_SLAB_BLAST_DMG;
              if(Q.hp <= 0 && !Q.dead) endBotLife(null, Q, t, false, "warden-slam");
            }
          }
        });
      }
      // the slam staggers the torso and cracks the chest core open
      W.coreUntil = t + WARDEN_CORE_EXPOSE;
      if(R3 && R3.wardenSlam) R3.wardenSlam(t);
    }
    if(!(W.slabArm > 0) && !(W.slabLand > 0) && t >= (W.slabAt || 0)){
      var slamN = ((t - W.born) / WARDEN_SLAB_CD) | 0;
      var arm = (((slamN + 1) % 3) === 0) ? 2 : (hashMatch((W.born|0) ^ 0x57A9, 90 + slamN) < 0.5 ? 0 : 1);
      if(arm === 0 && !(W.armL > 0)) arm = W.armR > 0 ? 1 : 9;
      else if(arm === 1 && !(W.armR > 0)) arm = W.armL > 0 ? 0 : 9;
      else if(arm === 2){
        if(!(W.armL > 0) && !(W.armR > 0)) arm = 9;
        else if(!(W.armL > 0)) arm = 1;
        else if(!(W.armR > 0)) arm = 0;
      }
      if(arm === 9){ W.slabAt = t + 1.0; }
      else {
        W.slamArm = arm;
        W.slabArm = t + WARDEN_SLAB_ARM;
        W.slabLand = t + WARDEN_SLAB_ARM;
        W.slabAt = t + WARDEN_SLAB_ARM + WARDEN_SLAB_CD;
        if(R3 && R3.wardenSlamArm) R3.wardenSlamArm(arm, t);
      }
    }
    // ---- laser eyes (twin of Rust warden_tick) ----
    if(W.laserOn > 0 && t >= W.laserOn){ W.laserWarn = 0; W.laserOn = 0; }
    if(W.laserOn > 0 && t >= W.laserWarn){
      W.laserYaw = (W.laserYaw + WARDEN_LASER_YAW0 * dt) % (Math.PI * 2);
    } else if(!(W.laserOn > 0) && t >= (W.laserAt || 0)){
      var flip = hashMatch((W.born|0) ^ 0x1A5E, 80 + ((t - W.born)|0));
      W.laserYaw = flip < 0.5 ? 0 : Math.PI;
      W.laserWarn = t + WARDEN_LASER_WARN;
      W.laserOn = t + WARDEN_LASER_WARN + WARDEN_LASER_HOLD;
      W.laserAt = t + WARDEN_LASER_WARN + WARDEN_LASER_HOLD + WARDEN_LASER_CD;
    }
    if(W.laserOn > t && t >= W.laserWarn){
      // ground laser: the eye looks down and the beam slants to the floor —
      // anyone in that ground band (and not behind cover) dies
      var ox = W.x, oy = WARDEN_SEE_HEAD, oz = W.z;
      var dx = Math.cos(W.laserYaw), dz = Math.sin(W.laserYaw);
      [{__me: 1}].concat(others()).forEach(function(Q){
        var qx = Q.__me ? V.me.x : Q.x, qy = Q.__me ? V.me.y : Q.y, qz = Q.__me ? V.me.z : Q.z, qdead = Q.__me ? V.dead : Q.dead;
        if(qdead) return;
        if(Q.__me && V.protUntil && t < V.protUntil) return;
        var px = qx - ox, pz = qz - oz;
        var along = px * dx + pz * dz;
        var runK = mapLaserRun(ox, oz, W.laserYaw || 0);
        if(along < 0 || along > runK) return;
        var lat = Math.abs(px * (-dz) + pz * dx);
        // ground laser: stripe along laserYaw from the body; anyone in it (with a clear
        // eye-to-fighter line) dies — cover still saves. The beam stops at the map edge.
        if(lat > WARDEN_LASER_W + 0.3) return;
        if(!los([ox, oy, oz], [qx, qy + 0.9, qz])) return;
        endBotLife(null, Q.__me ? null : Q, t, false, "warden-laser");
      });
    }
    // ---- disaster call ----
    if(t >= (W.disAt || 0)){
      W.disAt = t + WARDEN_DIS_CD;
      V.worldK = (V.worldK|0) + 1;
      if(!V.disaster) disStart(DISASTERS[disKind(((W.born|0) ^ 0xD15A) >>> 0, V.worldK|0, DISASTERS.length)], t);
    }
    // ---- Gravity Grip: open-hand pull toward the torso (cover / sprint breaks it) ----
    if(W.gripWarn > 0 && t >= W.gripWarn){
      W.gripWarn = 0;
      W.gripOn = t + WARDEN_GRIP_HOLD;
      if(R3 && R3.wardenGrip) R3.wardenGrip(t);
    }
    if(W.gripOn > 0 && t >= W.gripOn) W.gripOn = 0;
    if(W.gripOn > 0){
      [{__me: 1}].concat(others()).forEach(function(Q){
        var qx = Q.__me ? V.me.x : Q.x, qy = Q.__me ? V.me.y : Q.y, qz = Q.__me ? V.me.z : Q.z;
        var qdead = Q.__me ? V.dead : Q.dead;
        if(qdead) return;
        if(Q.__me ? meShielded(t) : botShielded(Q, t)) return;
        // sprint / dash breaks the pull; cover does too
        if(Q.__me && V.sprinting) return;
        if(!Q.__me && Q.speedUntil && t < Q.speedUntil) return;
        if(!los([W.x, WARDEN_SEE_CHEST, W.z], [qx, qy + 0.9, qz])) return;
        var dx = W.x - qx, dz = W.z - qz, d = Math.hypot(dx, dz);
        if(d > WARDEN_GRIP_R) return;
        if(d <= WARDEN_GRIP_MIN){
          // too close: the free arm sweeps you out (hurt + shove, not a slam kill)
          var sx = (qx - W.x), sz = (qz - W.z), sl = Math.max(0.15, Math.hypot(sx, sz));
          var kx = sx / sl, kz = sz / sl;
          if(Q.__me){
            V.me.x += kx * 6.0; V.me.z += kz * 6.0;
            V.hp -= WARDEN_GRIP_SWEEP_DMG; V.shakeAt = t;
            if(V.hp <= 0 && !V.dead) endBotLife(null, null, t, false, "warden-grip");
          } else {
            Q.x += kx * 6.0; Q.z += kz * 6.0;
            Q.hp -= WARDEN_GRIP_SWEEP_DMG;
            if(Q.hp <= 0 && !Q.dead) endBotLife(null, Q, t, false, "warden-grip");
          }
          return;
        }
        var step = Math.min(d, WARDEN_GRIP_PULL * dt);
        var px = dx / d * step, pz = dz / d * step;
        if(Q.__me){ V.me.x += px; V.me.z += pz; }
        else { Q.x += px; Q.z += pz; }
      });
    }
    if(!(W.gripWarn > 0) && !(W.gripOn > 0) && t >= (W.gripAt || 0)){
      W.gripWarn = t + WARDEN_GRIP_WARN;
      W.gripAt = t + WARDEN_GRIP_WARN + WARDEN_GRIP_CD;
    }
    if(R3 && R3.wardenSync) R3.wardenSync(W);
  }

  // The Warden is huge and centre cover hides its chest — bots (and LOS checks)
  // must use whichever hit height they can actually see. Prefer the arm (least
  // damage); never the head — it is no weak point.
  function wardenAim(W, slot){
    // open core: every bot focuses the exposed chest (still never the head)
    if(W && W.coreUntil && now() < W.coreUntil){
      return {x: ((W && W.x) || 0), y: WARDEN_SEE_CHEST, z: ((W && W.z) || 0), side: 0, core: 1};
    }
    var side = ((((slot|0) % 2) + 2) % 2) === 0 ? -1 : 1;
    return {x: ((W && W.x) || 0) + side * WARDEN_ARM_X, y: WARDEN_SEE_ARM, z: ((W && W.z) || 0), side: side};
  }
  function wardenSee(ox, oy, oz, wx, wz, slot){
    var side = ((((slot|0) % 2) + 2) % 2) === 0 ? -1 : 1;
    var open = !!(V.warden && V.warden.coreUntil && now() < V.warden.coreUntil);
    var pts = open ? [
      [wx, WARDEN_SEE_CHEST, wz],
      [wx + side * WARDEN_ARM_X, WARDEN_SEE_ARM, wz],
      [wx - side * WARDEN_ARM_X, WARDEN_SEE_ARM, wz],
      [wx, WARDEN_SEE_WAIST, wz]
    ] : [
      [wx + side * WARDEN_ARM_X, WARDEN_SEE_ARM, wz],
      [wx - side * WARDEN_ARM_X, WARDEN_SEE_ARM, wz],
      [wx, WARDEN_SEE_CHEST, wz],
      [wx, WARDEN_SEE_WAIST, wz]
    ], i;
    for(i = 0; i < pts.length; i++){
      if(los([ox, oy, oz], pts[i])) return pts[i][1];
    }
    return null;
  }
  function botEnemies(P){
    // while The Warden lives, every fighter targets only the boss — no player-vs-player
    if(V.warden){
      var W = V.warden, slot = (P && P.n) || 0;
      var aim = wardenAim(W, slot);
      var seeY = (P && P.ai && P.ai.body) ? wardenSee(P.ai.body.x, P.ai.body.y + FS.EYE, P.ai.body.z, W.x, W.z, slot) : wardenSee(0, FS.EYE, 0, W.x, W.z, slot);
      return [{x: aim.x, z: aim.z, y: seeY != null ? seeY : WARDEN_SEE_ARM, __warden: 1, __seeY: seeY != null ? seeY : WARDEN_SEE_ARM, vx: 0, vz: 0}];
    }
    var px = Math.cos(V.yaw)*PEEK_SIDE*(V.peek || 0), pz = Math.sin(V.yaw)*PEEK_SIDE*(V.peek || 0);
    var out = others().concat([{__me: 1}]).filter(function(q){
      if(q.__me){
        // cloak hides me from every bot in solo; MP goes through the server
        if(V.mode === "bots" && V.cloakUntil && now() < V.cloakUntil) return false;
        return V.team !== P.team && !V.dead;
      }
      // mole: the charmed bot sees its own side as the foe and its old foe as home
      var charm = P.charmUntil && P.charmUntil > now();
      var foe = charm ? q.team === P.team : q.team !== P.team;
      return q !== P && foe && !q.dead && !q.gone;
    }).map(function(q){ return q.__me ? {x: V.me.x + px, y: V.me.y, z: V.me.z + pz, vx: V.me.vx || 0, vz: V.me.vz || 0, __me: 1} : q; });
    // decoy: the shooter sees a ghost standing where I dropped it, and it looks free to hit
    V.decoys && V.decoys.forEach(function(dc){ if(dc && dc.until > now() && !P.decoyAt){ out.push({x: dc.x, y: dc.y, z: dc.z, vx: 0, vz: 0, __decoy: dc}); } });
    return out;
  }
  function los(a, b){
    var d = [b[0]-a[0], b[1]-a[1], b[2]-a[2]], ln = Math.sqrt(d[0]*d[0] + d[1]*d[1] + d[2]*d[2]);
    if(ln < 1e-6) return true;
    d = [d[0]/ln, d[1]/ln, d[2]/ln];
    return FS.rayMap(MAP, a, d, ln - 0.001) >= ln - 0.001;
  }
  function botJudge(P, t, e, d, reach){
    var foes = botEnemies(P), end = reach, vic = null, head = false;
    if(V.warden){
      // only the Warden can be hit; arms take reduced damage and can be disabled
      var W = V.warden, boxes = wardenBoxes(W), hit = wardenHitIndex(boxes, e, d, end);
      if(hit < 0){ addTracer(muzzleOf(P), [e[0] + d[0]*end, e[1] + d[1]*end, e[2] + d[2]*end], P.w, t, false); return; }
      var vol = hit, hb = boxes[vol];
      var tHit = FS.rayBox(e, d, hb);
      end = (tHit != null && tHit < end) ? tHit : end;
      addTracer(muzzleOf(P), [e[0] + d[0]*end, e[1] + d[1]*end, e[2] + d[2]*end], P.w, t, false);
      wardenHit(W, vol, FS.WEAPONS[P.w].damage, t);
      return;
    }
    foes.forEach(function(V2){
      var h = FS.rayPlayer(e, d, V2.x, V2.y, V2.z, end);
      if(h && h[0] < end){ end = h[0]; vic = V2; head = h[1]; }
    });
    addTracer(muzzleOf(P), [e[0] + d[0]*end, e[1] + d[1]*end, e[2] + d[2]*end], P.w, t, false);
    if(!vic) return;
    if(vic.__decoy){                          // a ghost swallows every tracer until its time runs out
      vic.__decoy.until = 0;                  // bots only shoot at it once it's been spotted
      return;
    }
    var dmg = head ? FS.WEAPONS[P.w].head : FS.WEAPONS[P.w].damage;
    if(vic.__me){
      if(V.protUntil && t < V.protUntil) return;
      if(meShielded(t)) return;  // the drop shield: bullets can't reach a glider
      V.hp -= dmg; V.hurtAt = t; V.hurtDir = Math.atan2(P.x - V.me.x, -(P.z - V.me.z)) - V.yaw;
      say((P.name || "A bot")+(head ? " landed a headshot" : " hit you")+" ("+Math.max(0, V.hp|0)+" hp)");
      if(V.hp <= 0){ endBotLife(P, null, t, head); }
      return;
    }
    if(vic.protUntil && t < vic.protUntil) return; // spawn cover still up
    if(botShielded(vic, t)) return;  // the drop shield: bullets can't reach a glider
    vic.hp -= dmg;
    if(vic.hp <= 0 && !vic.dead) endBotLife(P, vic, t, head);
  }
  /* ---------- launcher: a slow missile that flies to where it hits and blasts ----------
   * Solo (bots/practice): the browser flies it (missilesStep). MP: the server flies it in its
   * 20 Hz tick and the snapshot's "r" rows drive the same meshes; "b" rows are booms. */
  function spawnMissile(t, e, d, owner, fromServer){
    V.missiles.push({id: V.life*100 + (V.n|0), at: t, ttl: FS.MISSILE_TTL, px: e[0], py: e[1], pz: e[2],
                     vx: d[0]*FS.MISSILE_V, vy: d[1]*FS.MISSILE_V, vz: d[2]*FS.MISSILE_V, o: null, x: e[0], y: e[1], z: e[2],
                     owner: owner || null, srv: !!fromServer});   // owner null: the local player
    if(V.missiles.length > 2){ var old = V.missiles.shift(); if(old.o && R3) R3.rocket(null, old); }
  }
  function detonate(miss, t){
    if(miss.srv) return;  // server-flown: the "b" snapshot rows bring the boom and the damage
    var x = miss.x, y = miss.y, z = miss.z;
    if(R3) R3.boom(x, y, z, t);
    // [sound] heard where it went off: the blast kind's distance fade (curve on), its side of you, d/343 s late
    if(E.sfxAt) E.sfxAt("boom", [x, y, z], {kind: "blast", curve: true}); else E.sfx("boom");
    V.shakeAt = t;
    var shooter = miss.owner; // null: the local player; else a bot
    // while The Warden lives, blasts only bruise the boss — players and bots take nothing
    if(V.warden){
      wardenBlast(V.warden, [x, y, z], t);
      return;
    }
    // every living thing in radius takes falloff; the shooter is NOT safe (honest rockets, friendlies included)
    others().forEach(function(P){
      if(P.gone || P.dead) return;
      var dx = P.x - x, dy = (P.y + 0.9) - y, dz = P.z - z, dist = Math.sqrt(dx*dx + dy*dy + dz*dz);
      // the shooter is honest-but-fair: self blast grades by proximity (75 falloff), never the
      // 120 "direct" reserved for a rocket actually lodged in you — an eye-firing bot's own
      // throat is ~0.6 m above its torso center, which would otherwise be an instant suicide
      var dmg = FS.blastDamage(dist, P === shooter ? false : dist < FS.DIRECT_R);
      if(dmg <= 0) return;
      if(P.protUntil && t < P.protUntil) return;
      if(botShielded(P, t)) return;  // the drop shield: blasts can't reach a glider
      P.hp -= dmg;
      if(miss.srv) return;
      if(!shooter) V.hitAt = t;
      V.dmgNums.push({x: P.x, y: P.y + 1.2, z: P.z, n: dmg, head: dist < FS.DIRECT_R, at: t, o: null});
      if(V.dmgNums.length > 12) V.dmgNums.shift();
      var killer = shooter && P !== shooter ? {uid: shooter.uid, kills: shooter.kills|0, team: shooter.team, w: LAUNCH_W, name: shooter.name}
                           : shooter ? null : {uid: myId(), kills: V.kills, team: V.team, w: LAUNCH_W, name: "You"};
      if(P.hp <= 0 && !P.dead) endBotLife(killer, P, t, dist < FS.DIRECT_R);
    });
    if(V.mode === "practice") V.drones.forEach(function(D){
      if(D.downUntil > t) return;
      var c = dronePos(D, t - V.startAt), dx = c[0] - x, dy = c[1] - y, dz = c[2] - z;
      if(dx*dx + dy*dy + dz*dz < 16){ D.downUntil = t + 1.5; V.score++; V.hitAt = t; }
    });
    // your own rockets are honest: full falloff on you (not through spawn cover you dropped by firing)
    if(!shooter || shooter.team !== V.team){
      var mdx = V.me.x - x, mdy = (V.me.y + 0.9) - y, mdz = V.me.z - z, md = Math.sqrt(mdx*mdx + mdy*mdy + mdz*mdz);
      var self = FS.blastDamage(md, false);
      if(self > 0 && !V.dead && !meShielded(t)){  // the drop shield stops blasts reaching a glider too
        V.hp -= self; V.hurtAt = t; V.hurtDir = Math.atan2(x - V.me.x, -(z - V.me.z)) - V.yaw;
        if(V.hp <= 0){ V.hp = 0; V.dead = true; V.deadAt = t; V.deaths = (V.deaths|0) + 1; V.wingsUntil = 0; V.leapUntil = 0; V.speedUntil = 0;
          if(shooter && shooter.uid !== myId()) snapKillCam(shooter, LAUNCH_W, false);
          onEvent({ev: "kill", k: shooter ? shooter.uid : null, v: myId(), w: LAUNCH_W, hs: false,
                   kills: shooter ? (shooter.kills|0) : V.kills, deaths: V.deaths, scores: V.scores}); }
      }
    }
  }
  function missilesStep(t, dt){
    for(var i = V.missiles.length - 1; i >= 0; i--){
      var m = V.missiles[i], stopped = false;
      if(m.srv) continue;  // the server flies this one; the snapshot places it
      m.vy -= FS.MISSILE_G*dt;
      // Rift: a projectile entering one opening exits the other (6s pair)
      if(V.rifts && V.rifts.length && (m.at|0) < (t - 0.05)){
        for(var rq = 0; rq < V.rifts.length; rq++){
          var R = V.rifts[rq];
          if(t >= (R.until || 0)) continue;
          var dR = Math.hypot((m.px - R.x), (m.pz - R.z), (m.py - 0.9)*0.5);
          if(dR > 0.9) continue;
          m.px = m.x = R.x2; m.pz = m.z = R.z2; m.py = m.y = 0.9;
          m.at = t;   // a fresh ttl from the exit
          break;
        }
      }
      var sp = Math.sqrt(m.vx*m.vx + m.vy*m.vy + m.vz*m.vz) || 1;
      var nx = m.px + m.vx*dt, ny = m.py + m.vy*dt, nz = m.pz + m.vz*dt;
      var d3 = [nx - m.px, ny - m.py, nz - m.pz], ln = Math.sqrt(d3[0]*d3[0] + d3[1]*d3[1] + d3[2]*d3[2]) || 1e-6;
      // wall?
      var reach = FS.rayMap(MAP, [m.px, m.py, m.pz], [d3[0]/ln, d3[1]/ln, d3[2]/ln], ln);
      if(reach < ln){ stopped = true; m.x = m.px + d3[0]*reach/ln; m.y = m.py + d3[1]*reach/ln; m.z = m.pz + d3[2]*reach/ln; }
      else { m.x = nx; m.y = ny; m.z = nz; }
      // a body?
      if(!stopped && V.warden){
        var wbx = wardenBoxes(V.warden);
        for(var wb = 0; wb < wbx.length; wb++){
          var wh = FS.rayBox([m.px, m.py, m.pz], [d3[0]/ln, d3[1]/ln, d3[2]/ln], wbx[wb]);
          if(wh !== null && wh <= ln){ stopped = true; m.x = m.px + d3[0]*wh/ln; m.y = m.py + d3[1]*wh/ln; m.z = m.pz + d3[2]*wh/ln; break; }
        }
      }
      if(!stopped) others().forEach(function(P){
        if(stopped || P.gone || P.dead || P.team === V.team) return;
        if(botShielded(P, t)) return;  // the drop shield: a rocket passes a glider by
        var hb = FS.hitBoxes(P.x, P.y, P.z);
        for(var b = 0; b < 2; b++){
          var h = FS.rayBox([m.px, m.py, m.pz], [d3[0]/ln, d3[1]/ln, d3[2]/ln], hb[b]);
          if(h !== null && h <= ln){ stopped = true; m.x = m.px + d3[0]*h/ln; m.y = m.py + d3[1]*h/ln; m.z = m.pz + d3[2]*h/ln; break; }
        }
      });
      // the ground (the map's floor is implicit: no box under you, y hits 0)
      if(!stopped && m.y <= 0.05){ stopped = true; m.y = 0.05; }
      m.px = m.x; m.py = m.y; m.pz = m.z;
      if(stopped || t - m.at > m.ttl){ detonate(m, t); if(m.o && R3) R3.rocket(null, m); V.missiles.splice(i, 1); }
      else if(R3) R3.rocket(m, m);
    }
  }

  // the kill cam: a frozen snapshot of the killer (taken the instant you died) the camera
  // flies to while "Respawning in X" counts down. Not a live follow — in MP their snapshots
  // keep interpolating anyway; here we keep the reference so the tag can use their live name.
  function snapKillCam(K, w, head){
    if(!K || K.gone) return;
    V.killCam = {uid: K.uid, name: K.name || "Killer", team: K.team|0, w: w|0, hs: !!head,
                 x: K.x, y: K.y, z: K.z, yaw: K.yaw || 0, pitch: K.pitch || 0, ref: K};
  }
  function endBotLife(killer, vic, t, head, dis){
    // Second Wind / Phoenix / Fake Death: the first killing blow just fails
    if(vic){
      if(vic.fakeUntil && t < vic.fakeUntil){ vic.fakeUntil = 0; say("Fake Death: the shot missed"); return; }
      if(vic.secondWind){ vic.secondWind = false; vic.hp = 50; if(R3) R3.charm(vic, "fake"); say("Second Wind: "+vic.name+" stands back up"); return; }
      if(vic.phoenixUntil && t < vic.phoenixUntil){ vic.phoenixUntil = 0; vic.hp = 100; if(R3) R3.charm(vic, "fake"); say("Phoenix: "+vic.name+" burns back to life"); return; }
    }
    if(!vic){
      if(V.fakeUntil && t < V.fakeUntil){ V.fakeUntil = 0; say("Fake Death: the shot missed"); return; }
      if(V.secondWind){ V.secondWind = false; V.hp = 50; say("Second Wind: you stand back up at half health"); return; }
      if(V.phoenixUntil && t < V.phoenixUntil){ V.phoenixUntil = 0; V.hp = 100; say("Phoenix: you burn back to life"); return; }
    }
    // kill cam: your own death is worth one snapshot of the shooter — where they stood,
    // where they looked — replayed from their eyes while "Respawning in X" counts down
    if(!vic && killer && killer.uid !== myId()) snapKillCam(killer, killer.w|0, !!head);
    if(killer) killer.kills = (killer.kills|0) + 1;
    if(killer && killer.team != null && !V.warden){
      // a mole kill still pays the real shooter's side? no — the charm DELIBERATELY turns
      // friend\-to\-foe aim points back at the charmer's team, so the credit goes there
      var charm = killer.charmUntil && killer.charmUntil > t;
      V.scores[(charm ? 1 - killer.team : killer.team) === 0 ? 0 : 1]++;
    }
    var cause = dis ? String(dis) : "";
    if(vic){ vic.dead = true; vic.deaths = (vic.deaths|0) + 1; vic.deadAt = t; vic.hp = 0; }
    if(!vic){ // the local player died (endBotLife is also the bots-mode / env death site)
      V.deaths = (V.deaths|0) + 1;
      V.dead = true; V.deadAt = t; V.hp = 0;
      V.wingsUntil = 0; V.leapUntil = 0; V.speedUntil = 0;   // a death pops the movement totems too
      onEvent({ev: "kill", k: killer ? killer.uid : null, v: myId(), w: killer ? killer.w|0 : -1,
               hs: !!head, kills: killer ? killer.kills|0 : 0, deaths: V.deaths, scores: V.scores, dis: cause});
      return;
    }
    onEvent({ev: "kill", k: killer ? killer.uid : null, v: vic.uid, w: killer ? killer.w|0 : -1, hs: !!head,
             kills: killer ? killer.kills|0 : 0, deaths: vic.deaths|0, scores: V.scores, dis: cause});
  }
  // the four totem effects, shared shape between solo (judge local) and MP (mirror the server)
  function totemApply(kind, uid, t){
    var best = null, bd = 1e9;   // one function-scoped picker (var is not block-scoped)
    if(!TOTEMS[kind]) return null;
    var foes = others().filter(function(P){ return !P.bot || P.dead || P.gone ? false : P.team !== V.team; });
    if(!foes.length && kind === "mole") return "Mole — no enemy bots to turn";
    if(kind === "mole"){
      var tar = foes[0];  // deterministic: first in the slot order
      foes.forEach(function(P){ if(P.slot != null && P.slot < tar.slot) tar = P; });
      tar.charmUntil = t + TOTEMS.mole.dur;
      if(R3) R3.charm(tar);
      return "Mole: "+tar.name+" turned against their own team for "+TOTEMS.mole.dur+"s";
    }
    if(kind === "freeze"){
      best = null; bd = 1e9;
      foes.forEach(function(P){ var d = Math.hypot(P.x - V.me.x, P.z - V.me.z); if(d < bd){ bd = d; best = P; } });
      if(!best) return "Paralyser — no enemy bots nearby";
      best.freezeUntil = t + TOTEMS.freeze.dur;
      if(R3) R3.charm(best, "freeze");
      return "Paralyser: "+best.name+" frozen for "+TOTEMS.freeze.dur+"s";
    }
    if(kind === "decoy"){
      // drop a ghost copy of me three metres ahead of where I face
      var vx = Math.sin(V.yaw), vz = -Math.cos(V.yaw);
      var x = V.me.x + vx*3, z = V.me.z + vz*3, i;
      for(i = 0; i < 20 && FS.overlaps(MAP, x, 0.1, z, 0.2) >= 0; i++){ x = V.me.x + vx*(3 + i*0.3); z = V.me.z + vz*(3 + i*0.3); }
      V.decoys = V.decoys || [];
      var dc = {x: x, y: 0, z: z, hp: 60, until: t + TOTEMS.decoy.dur};
      V.decoys.push(dc);
      if(R3) R3.addDecoy(dc);
      return "Decoy: a ghost of me drops in "+["front","left","right","behind"][(i/6)|0]+" and draws bot fire for "+TOTEMS.decoy.dur+"s";
    }
    if(kind === "cloak"){
      V.cloakUntil = t + TOTEMS.cloak.dur;
      root.classList.add("vg-fps-cloak");
      return "Cloak: every enemy bot stops seeing me for "+TOTEMS.cloak.dur+"s";
    }
    if(kind === "shield"){
      // the drop shield, bottled: nothing hurts the taker while they keep shooting
      V.shieldTotemUntil = t + TOTEMS.shield.dur;
      return "Shield: nothing can hurt me for "+TOTEMS.shield.dur+"s";
    }
    if(kind === "wings"){
      V.wingsUntil = t + TOTEMS.wings.dur;
      return "Wings: up you go for "+TOTEMS.wings.dur+"s — WASD glides, landing is automatic. Easy to shoot from below";
    }
    if(kind === "leap"){
      V.leapUntil = t + TOTEMS.leap.dur;
      return "Leap: huge Space-bar jumps for "+TOTEMS.leap.dur+"s";
    }
    if(kind === "speed"){
      V.speedUntil = t + TOTEMS.speed.dur;
      return "Speed: plain W dashes at double sprint pace for "+TOTEMS.speed.dur+"s";
    }
    if(kind === "teleport"){
      // instant: a random open spot on the ground (the same hashed scatter drops use,
      // seeded from this take so it's never Math.random()) — pop any flight/drop state,
      // the body arrives standing. The time runs through the golden-ratio multiplier
      // first: a low-bit time XOR alone barely moves the scatter (sub-mm), the full-range
      // mix makes each take land somewhere genuinely fresh.
      var tk = ((hashStr(myId() + ":" + ((V.life|0) + "." + (V.n|0))) ^ Math.imul(Math.floor(t*1000) + 1, 2654435761)) >>> 0);
      var to = dropSpot(tk);
      V.me.x = to[0]; V.me.y = 0; V.me.z = to[2];
      V.me.vx = 0; V.me.vy = 0; V.me.vz = 0; V.me.g = true;
      V.dropUntil = 0; V.wingsUntil = 0;   // a hop cancels a glide/flight — you land standing
      return "Teleport: you're somewhere else now";
    }
    // ---- Wave C ----
    if(kind === "rift"){
      V.rifts = V.rifts || [];
      var rx = V.me.x + Math.sin(V.yaw)*2, rz = V.me.z - Math.cos(V.yaw)*2;
      var rx2 = V.me.x + Math.sin(V.yaw)*8, rz2 = V.me.z - Math.cos(V.yaw)*8;
      var rf = {x: rx, z: rz, x2: rx2, z2: rz2, until: t + TOTEMS.rift.dur};
      V.rifts.push(rf);
      if(R3 && R3.addRift) R3.addRift(rf);
      return "Rift: a linked pair opens ahead for "+TOTEMS.rift.dur+"s — rockets that fly in come out the other";
    }
    if(kind === "mirror"){
      V.decoys = V.decoys || [];
      for(var mi = 0; mi < 3; mi++){
        var a = V.yaw + (mi - 1)*0.7;
        var mx = V.me.x + Math.sin(a)*3.5, mz = V.me.z - Math.cos(a)*3.5;
        V.decoys.push({x: mx, y: 0, z: mz, hp: 60, until: t + TOTEMS.mirror.dur, mirror: 1});
        if(R3) R3.addDecoy({x: mx, y: 0, z: mz, until: t + TOTEMS.mirror.dur});
      }
      return "Mirror Army: three ghosts fan out for "+TOTEMS.mirror.dur+"s";
    }
    if(kind === "gravflip"){
      V.gravUntil = t + TOTEMS.gravflip.dur;
      return "Gravity Flip: floaty hops for "+TOTEMS.gravflip.dur+"s";
    }
    if(kind === "rewind"){
      if(V.hist && V.hist.length > 2){
        var rh = V.hist[Math.max(0, V.hist.length - 3)];
        if(rh){ V.me.x = rh[0]; V.me.y = rh[1]; V.me.z = rh[2]; V.me.vx = 0; V.me.vy = 0; V.me.vz = 0; }
      }
      V.secondWind = true;
      return "Time Rewind: you snap back, and the next killing blow fails";
    }
    if(kind === "shock"){
      V.booms = V.booms || [];
      V.booms.push({x: V.me.x, y: V.me.y + 0.5, z: V.me.z, at: t});
      // a ground shock ring so an empty detonation still reads as "a shockwave just went off"
      V.rings = V.rings || [];
      V.rings.push({x: V.me.x, y: (V.me.y || 0) + 0.08, z: V.me.z, at: t, r: 8, dur: 0.55});
      if(R3 && R3.ring) R3.ring(V.me.x, (V.me.y || 0) + 0.08, V.me.z, 8, 0.55, t);
      others().forEach(function(P){
        if(P.dead || P.gone || P.team === V.team) return;
        var d = Math.hypot(P.x - V.me.x, P.z - V.me.z);
        if(d > 6) return;
        P.hp -= 35;
        var ln = d > 0.01 ? d : 1;
        P.x += ((P.x - V.me.x)/ln)*3; P.z += ((P.z - V.me.z)/ln)*3;
        if(P.hp <= 0 && !P.dead) endBotLife({uid: myId(), kills: V.kills, team: V.team, w: V.w, name: "You"}, P, t, false);
      });
      return "Shockwave: nearby enemies take 35 and get knocked back";
    }
    if(kind === "magnet"){ V.magnetUntil = t + TOTEMS.magnet.dur; return "Bullet Magnet: fire near me lands on me for "+TOTEMS.magnet.dur+"s"; }
    if(kind === "chain"){ V.chainLeft = (V.chainLeft|0) + 2; return "Chain Lightning: your next 2 hits arc to another enemy"; }
    if(kind === "trap"){
      V.mines = V.mines || [];
      for(var ti = 0; ti < 2; ti++){
        var ta = (V.n|0)*2.399 + ti*1.7;
        V.mines.push({x: V.me.x + Math.cos(ta)*1.5, z: V.me.z + Math.sin(ta)*1.5, team: V.team, owner: myId(), at: t});
      }
      return "Trapmaster: 2 mines drop at your feet";
    }
    if(kind === "mark"){
      others().forEach(function(P){ if(P.team !== V.team && !P.dead && !P.gone) P.hunterUntil = t + TOTEMS.mark.dur; });
      return "Hunter's Mark: every enemy is painted for "+TOTEMS.mark.dur+"s";
    }
    if(kind === "blink"){ V.blinkLeft = (V.blinkLeft|0) + 3; return "Blink Dash: 3 short hops — press again to blink 6m ahead"; }
    if(kind === "bubble"){
      V.bubbles = V.bubbles || [];
      V.bubbles.push({x: V.me.x, y: V.me.y + 0.9, z: V.me.z, r: 4, team: V.team, until: t + TOTEMS.bubble.dur});
      return "Bubble Fortress: a sphere covers your side for "+TOTEMS.bubble.dur+"s";
    }
    if(kind === "wallrun"){ V.wallrunUntil = t + TOTEMS.wallrun.dur; return "Wall Runner: hop the ledges for "+TOTEMS.wallrun.dur+"s"; }
    if(kind === "secondwind"){ V.secondWind = true; return "Second Wind: the next killing blow just fails"; }
    if(kind === "fakedeath"){ V.fakeUntil = t + TOTEMS.fakedeath.dur; return "Fake Death: play dead for "+TOTEMS.fakedeath.dur+"s"; }
    if(kind === "ghost"){ V.ghostLeft = (V.ghostLeft|0) + 3; return "Ghost Bullets: your next 3 shots pierce through"; }
    if(kind === "cluster"){ V.clusterLeft = (V.clusterLeft|0) + 5; return "Cluster Shot: your next shot splits on impact"; }
    if(kind === "overclock"){ V.overclockUntil = t + TOTEMS.overclock.dur; return "Overclock: fire much faster for "+TOTEMS.overclock.dur+"s"; }
    if(kind === "ricochet"){ V.ricoLeft = (V.ricoLeft|0) + 3; return "Ricochet: your next 3 hits bounce into a second enemy"; }
    if(kind === "infchamber"){ V.infUntil = t + TOTEMS.infchamber.dur; return "Infinite Chamber: the mag never runs dry for "+TOTEMS.infchamber.dur+"s"; }
    if(kind === "bodyswap"){
      best = null; bd = 1e9;
      others().forEach(function(P){ if(P.dead || P.gone || P.team === V.team) return; var d = Math.hypot(P.x - V.me.x, P.z - V.me.z); if(d < bd){ bd = d; best = P; } });
      if(!best) return "Body Swap — no enemy to swap with";
      var tx = best.x, ty = best.y, tz = best.z;
      best.x = V.me.x; best.y = V.me.y; best.z = V.me.z;
      V.me.x = tx; V.me.y = ty; V.me.z = tz; V.me.vx = 0; V.me.vy = 0; V.me.vz = 0;
      return "Body Swap: you and "+best.name+" traded places";
    }
    if(kind === "rally"){
      V.beacons = V.beacons || [];
      V.beacons.push({x: V.me.x, z: V.me.z, kind: "rally", team: V.team, until: t + TOTEMS.rally.dur});
      return "Rally: a beacon boosts your side for "+TOTEMS.rally.dur+"s";
    }
    if(kind === "meteor"){
      var mx = V.me.x + Math.sin(V.yaw)*8, mz = V.me.z - Math.cos(V.yaw)*8, bd2 = 1e9;
      others().forEach(function(P){ if(P.dead || P.gone || P.team === V.team) return; var d = Math.hypot(P.x - V.me.x, P.z - V.me.z); if(d < bd2){ bd2 = d; mx = P.x; mz = P.z; } });
      V.meteors = V.meteors || [];
      V.meteors.push({x: mx, z: mz, team: V.team, owner: myId(), hitAt: t + 1.6});
      return "Meteor Call: impact in 1.6s";
    }
    if(kind === "chaos"){ V.chaosUntil = t + TOTEMS.chaos.dur; V.chaosNext = t + 1.5; return "Chaos Core: free blasts around you for "+TOTEMS.chaos.dur+"s"; }
    if(kind === "phoenix"){ V.phoenixUntil = t + TOTEMS.phoenix.dur; return "Phoenix: the first killing blow fails for "+TOTEMS.phoenix.dur+"s"; }
    if(kind === "pocket"){ V.pocketUntil = t + TOTEMS.pocket.dur; return "Pocket Universe: nothing hurts, nothing hurts back, for "+TOTEMS.pocket.dur+"s"; }
    if(kind === "fate"){
      best = null; bd = 1e9;
      others().forEach(function(P){ if(P.dead || P.gone) return; var d = Math.hypot(P.x - V.me.x, P.z - V.me.z); if(d < bd){ bd = d; best = P; } });
      if(!best) return "Fate Splitter — nobody nearby to link with";
      V.fateUntil = t + TOTEMS.fate.dur; best.fateUntil = t + TOTEMS.fate.dur; V.fateUid = best.uid;
      return "Fate Splitter: you and "+best.name+" share every wound for "+TOTEMS.fate.dur+"s";
    }
    if(kind === "king"){
      V.kingUntil = t + TOTEMS.king.dur;
      others().forEach(function(P){ if(P.team === V.team && !P.dead && !P.gone) P.kingUntil = t + TOTEMS.king.dur; });
      V.beacons = V.beacons || [];
      V.beacons.push({x: V.me.x, z: V.me.z, kind: "king", team: V.team, until: t + TOTEMS.king.dur});
      return "Kingmaker: your whole side is royalty for "+TOTEMS.king.dur+"s";
    }
    if(kind === "radarjam"){
      V.jamUntil = t + TOTEMS.radarjam.dur;
      others().forEach(function(P){ if(P.team === V.team) P.jamUntil = t + TOTEMS.radarjam.dur; });
      return "Radar Jammer: your team vanishes from the enemy radar for "+TOTEMS.radarjam.dur+"s";
    }
    // ---- Wave D: Arena Disasters. The totem unleashes the map-wide hazard and
    // the taker is just as exposed as everyone else. A Shield totem holder is the
    // one person a disaster cannot touch (meShielded/botShielded read the window).
    if(DISASTERS.indexOf(kind) >= 0){
      disStart(kind, t);
      return TOTEMS[kind].n + " — the whole arena is in it now";
    }
    return null;
  }
  // drop slots: past the map's own packs (BASE_PACKS) sit DROP_SLOTS totem slots then
  // PACK_SLOTS pack slots — one fixed layout, so a drop's index means the same thing to
  // the server, a mid-match joiner and the solo client. Both drop clocks reuse them
  // round-robin. (BASE_PACKS, not MAP.pickups.length: the slots append past it.)
  function dropPlan(){
    return {base: BASE_PACKS,
            totems: [BASE_PACKS, BASE_PACKS + DROP_SLOTS],
            packs: [BASE_PACKS + DROP_SLOTS, BASE_PACKS + DROP_SLOTS + PACK_SLOTS],
            dis:   [BASE_PACKS + DROP_SLOTS + PACK_SLOTS, BASE_PACKS + DROP_SLOTS + PACK_SLOTS + DIS_SLOTS]};
  }
  function ensureDropSlots(){
    // the slot entries exist (kind "" = empty) for the whole match; drops rewrite them
    var pl = dropPlan();
    while(MAP.pickups.length < pl.dis[1]){
      var j = MAP.pickups.length;
      MAP.pickups.push({id: j < pl.totems[1] ? "totem-"+j : (j < pl.packs[1] ? "pack-"+j : "dis-"+j), kind: "", at: [0, 0, 0]});
    }
  }
  // the drop rng: a fresh kind and a fresh open spot from the drop counter (not the wall
  // clock — epoch-ms seeds differ only in their low bits between drops, and hashMatch's
  // /2^32 output reads the top ones, which stacked every drop on the same spot)
  var totemCount = 0, packCount = 0;
  // Any drop (totem, loose pack, or a map pack coming back) lands on a fresh open
  // ground spot across the arena — never a fixed pad you can camp. Seeded from the
  // drop counter / clock, not Math.random, so a replay of the same seeds repeats.
  function dropSpot(tok){
    var b = (MAP && MAP.bounds && MAP.bounds.length === 6) ? MAP.bounds : [-42, -1, -30, 42, 12, 30];
    var pad = 2.0;
    var x0 = b[0] + pad, z0 = b[2] + pad;
    var w = Math.max(1, (b[3] - pad) - x0), d = Math.max(1, (b[5] - pad) - z0);
    var x = x0 + hashMatch(tok, 1)*w, z = z0 + hashMatch(tok, 2)*d;
    for(var j = 0; j < 60 && FS.overlaps(MAP, x, 0.1, z, 0) >= 0; j++){
      var s2 = (tok + (j+1)*2654435761) >>> 0;
      x = x0 + hashMatch(s2, 1)*w; z = z0 + hashMatch(s2, 2)*d;
    }
    return [x, 0, z];
  }
  // A disaster hazard spot (toxic cloud, sinkhole pit, impact mark) hashed from the
  // disaster's own frozen seed. Twin: dis_spot in backend-rs/src/strike.rs. The FX
  // paints THIS point and the judge damages THIS point — one geometry, both sides.
  function disSpot(seed, salt){
    seed = seed|0; salt = salt|0;
    var b = (MAP && MAP.bounds && MAP.bounds.length === 6) ? MAP.bounds : [-42, -1, -30, 42, 12, 30];
    var pad = 2.0;
    var x0 = b[0] + pad, z0 = b[2] + pad;
    var w = Math.max(1, (b[3] - pad) - x0), d = Math.max(1, (b[5] - pad) - z0);
    var x = x0 + hashMatch(seed, salt)*w, z = z0 + hashMatch(seed, salt + 100)*d;
    for(var j = 0; j < 60 && FS.overlaps(MAP, x, 0.1, z, 0) >= 0; j++){
      var s2 = (seed + (j+1)*2654435761) >>> 0;
      x = x0 + hashMatch(s2, salt)*w; z = z0 + hashMatch(s2, salt + 100)*d;
    }
    return [x, 0, z];
  }
  // Sticky hazard spots near live bodies so a disaster can actually connect: the first
  // few sit on players (offset by the seed, never Math.random), the rest scatter.
  // Frozen at disStart — the clouds you see are the clouds that hurt.
  function disZonesNear(seed, n, pts){
    var out = [], i, p, s;
    for(i = 0; i < n; i++){
      if(pts && pts.length && i < pts.length + 2){
        p = pts[i % pts.length];
        out.push([
          p[0] + (hashMatch(seed|0, 200 + i) - 0.5) * 5,
          p[1] + (hashMatch(seed|0, 300 + i) - 0.5) * 5
        ]);
      } else {
        s = disSpot(seed, 40 + i);
        out.push([s[0], s[2]]);
      }
    }
    return out;
  }
  // live bodies as [x,z] — me plus every bot/remote still in the round
  function liveSpots(){
    var pts = [];
    if(!V.dead) pts.push([V.me.x, V.me.z]);
    others().forEach(function(P){
      if(P.dead || P.gone) return;
      pts.push([P.x, P.z]);
    });
    return pts;
  }
  // put a live pack/totem slot somewhere new and repaint its mesh
  function placeDrop(idx, tok){
    if(!MAP || !MAP.pickups[idx]) return;
    MAP.pickups[idx].at = dropSpot(tok);
    if(!R3) return;
    var k = MAP.pickups[idx].kind;
    if(k === "health" || k === "ammo") R3.addPack(idx, MAP.pickups[idx]);
    else if(TOTEMS[k]) R3.addTotem(idx, MAP.pickups[idx]);
  }
  function totemSpawn(seed, canMole){
    if(V.warden) return -1;
    ensureDropSlots();
    var pl = dropPlan();
    var tok = ((seed ^ (totemCount = (totemCount + 1)) * 0x9e3779b9) >>> 0);
    var ALL = ["mole","freeze","decoy","cloak","shield","wings","leap","speed","teleport",
      "rift","mirror","gravflip","rewind","shock","magnet","chain","trap","mark","blink","bubble",
      "wallrun","secondwind","fakedeath","ghost","cluster","overclock","ricochet","infchamber",
      "bodyswap","rally","meteor","chaos","phoenix","pocket","fate","king","radarjam"];
    var toks = canMole ? ALL : ALL.filter(function(k){ return k !== "mole"; });
    // personal roster only — Disaster totems live in disasterSpawn() on their own ring
    var kind = toks[((tok % toks.length) + toks.length) % toks.length];
    var idx = pl.totems[0] + (totemCount - 1) % DROP_SLOTS;
    // Hot Drop / Cursed Drop: same scatter, a visible tag so the client can beam it
    var roll = ((tok >>> 16) % 100);
    var tag = roll < 12 ? "hot" : (roll < 27 ? "cursed" : "");
    MAP.pickups[idx] = {id: kind+"-"+((tok >>> 0)%99991), kind: kind, at: dropSpot(tok), tag: tag};
    V.cursed = V.cursed || {};
    V.cursed[idx] = tag === "cursed";
    return idx;
  }
  // Disaster totems: their own ring, their own clock, never mixed into the personal
  // roster. Tagged "dis" so the beacon reads as an arena-wide event, not a power-up.
  var disCount = 0;
  function disasterSpawn(seed){
    if(V.warden) return -1;
    ensureDropSlots();
    var pl = dropPlan();
    var tok = ((seed ^ (disCount = (disCount + 1)) * 0x9e3779b9) >>> 0);
    var kind = DISASTERS[disKind(seed, 4, DISASTERS.length)];
    var idx = pl.dis[0] + (disCount - 1) % DIS_SLOTS;
    MAP.pickups[idx] = {id: kind+"-"+((tok >>> 0)%99991), kind: kind, at: dropSpot(tok), tag: "dis"};
    V.cursed = V.cursed || {};
    V.cursed[idx] = false;
    return idx;
  }
  function packSpawn(seed){
    if(V.warden) return -1;
    ensureDropSlots();
    var pl = dropPlan();
    var tok = ((seed ^ (packCount = (packCount + 1)) * 0x9e3779b9 + 0x5f356495) >>> 0);
    var kind = tok % 2 ? "ammo" : "health";
    var idx = pl.packs[0] + (packCount - 1) % PACK_SLOTS;
    MAP.pickups[idx] = {id: kind+"-"+((tok >>> 0)%99991), kind: kind, at: dropSpot(tok)};
    return idx;
  }
  function botStep(P, t){
    var ai = P.ai, x = P.ai.body.x, z = P.ai.body.z, i;
    if(P.freezeUntil && t < P.freezeUntil) return;   // the Paralyser pins a bot in place
    // -- decide a goal (at most every BOT_THINK) --
    if(t >= ai.thinkAt){
      // The Warden: lock it as the only target (no PVP) and walk to a firing lane
      if(V.warden){
        var Wd = V.warden;
        ai.thinkAt = t + BOT_THINK;
        ai.decoyAt = 0;
        var seeH = wardenSee(x, P.ai.body.y + FS.EYE, z, Wd.x, Wd.z, P.n || 0);
        var aimH = wardenAim(Wd, P.n || 0);
        var stub = {x: aimH.x, z: aimH.z, y: seeH != null ? seeH : WARDEN_SEE_ARM, __warden: 1, __seeY: seeH != null ? seeH : WARDEN_SEE_ARM, vx: 0, vz: 0};
        stub.__uid = "warden";
        // keep the first sighting: restamping seenAt every think starves the
        // BOT_REACT gate and the bot never opens fire
        if(!ai.target || !ai.target.__warden) ai.seenAt = t;
        ai.target = stub;
        ai.targetPos = [Wd.x, Wd.z];
        ai.targetY = stub.y;
        ai.lostY = stub.y; ai.lostPos = null; ai.lostUntil = 0;
        var ddW = Math.hypot(Wd.x - x, Wd.z - z);
        if(ai.slideUntil && t < ai.slideUntil){
          // keep ai.goal
        } else if(seeH == null){
          // hidden by cover — close in and circle until a lane opens (head/chest/waist)
          if(ddW > 12.0){
            ai.goal = mapNavNext(x, z, Wd.x, Wd.z, P.ai.body.y, 2.5);
          } else {
            var angW = ((P.slot|0)*2.399 + t*0.7), radW = 8.0 + ((P.slot|0)%3);
            ai.goal = mapNavNext(x, z, Wd.x + Math.cos(angW)*radW, Wd.z + Math.sin(angW)*radW, P.ai.body.y, 2.5);
          }
        } else {
          var pressW = diffFor(P).id === "hard" ? 10 : diffFor(P).id === "sweaty" ? 6 : 18;
          ai.goal = ddW > pressW ? mapNavNext(x, z, Wd.x, Wd.z, P.ai.body.y, 2.5) : null;
        }
      } else {
      var foes = botEnemies(P), pick = null, pickPos = null, pickY = 0, pool = [], wts = [], wt = 0, cur = ai.target;
      // a stable handle for "me" this tick, so a bot chasing the player keeps the same object
      // to compare targets against — a fresh wrapper every call would reset its lock every frame
      for(i = 0; i < foes.length; i++){ if(foes[i].__me){ foes[i].__uid = "me"; } else foes[i].__uid = foes[i].uid; }
      for(i = 0; i < foes.length; i++){
        var V2 = foes[i];
        // a shielded glider isn't worth a bullet — bots hold fire until the canopy's packed
        if(V2.__me ? meShielded(t) : botShielded(V2, t)) continue;
        var dd = Math.hypot(V2.x - x, (V2.y - P.ai.body.y) || 0, V2.z - z);  // 3D: a ledge above is genuinely far
        // a sandstorm arena event halves how far a bot can see (the dust is up)
        var botRange = ((V.arenaEvent === "storm" && t < (V.arenaEventUntil || 0))
          || (V.disaster === "sandstorm" && disLive(t))) ? STORM_RANGE : BOT_RANGE;
        var seeAt = V2.__warden ? [V2.x, (V2.__seeY != null ? V2.__seeY : WARDEN_SEE_ARM), V2.z] : [V2.x, V2.y + FS.EYE, V2.z];
        if(dd <= botRange && los([x, P.ai.body.y + FS.EYE, z], seeAt)){
          // every visible foe is a candidate, nearer likelier; whoever we already chase gets a bonus
          var w2 = 1/(0.2 + dd) * (cur && foes[i].__uid === cur.__uid ? 2.2 : 1);
          pool.push(V2); wts.push(w2); wt += w2;
        }
      }
      if(wt > 0){
        var roll = FS.mb32((P.slot*131 + ((t*1000)|0)) & 0xFFFF)*wt;
        for(i = 0; i < pool.length; i++){ roll -= wts[i]; if(roll <= 0){ pick = pool[i]; break; } }
        if(!pick) pick = pool[pool.length - 1];
        pickPos = [pick.x, pick.z]; pickY = pick.y || 0;
      }
      ai.thinkAt = t + BOT_THINK;
      if(pick){
        var same = cur && pick.__uid === cur.__uid;
        if(!same) ai.seenAt = t; ai.target = pick;
        ai.targetPos = pickPos.slice();        // remember where I last saw them, for a chase
        ai.targetY = pickY;
        ai.lostY = pickY; ai.lostPos = null; ai.lostUntil = 0;
      } else {
        if(ai.target){
          ai.lostPos = ai.targetPos ? ai.targetPos.slice() : null;
          ai.lostY = ai.targetY != null ? ai.targetY : 0;
          ai.lostUntil = t + 10.0;             // hunt the trail longer (Wave C)
          ai.target = null; ai.seenAt = null;
        }
      }
      // a pending sidestep owns the goal — the next think tick must not yank it back
      // into the wall it is peeling off of
      if(ai.slideUntil && t < ai.slideUntil){
        // keep ai.goal
      } else if(!ai.target){
        // hunt: walk the room/passage graph to where the target vanished, then search
        if(ai.lostPos && t < ai.lostUntil){
          var near = Math.hypot(ai.lostPos[0] - x, ai.lostPos[1] - z) <= 2.0;
          if(!near){
            ai.goal = mapNavNext(x, z, ai.lostPos[0], ai.lostPos[1], P.ai.body.y, ai.lostY != null ? ai.lostY : 0);
          } else {
            // arrived: sweep a little around the last sighting (deterministic per bot)
            var ang = ((P.slot|0)*2.399 + t*0.7), rad = 2.5 + ((P.slot|0)%3);
            ai.goal = mapNavNext(x, z, ai.lostPos[0] + Math.cos(ang)*rad, ai.lostPos[1] + Math.sin(ang)*rad, P.ai.body.y, ai.lostY != null ? ai.lostY : 0);
            if(t >= ai.lostUntil - 0.25) ai.lostPos = null;
          }
        } else {
          ai.lostPos = null; ai.lostUntil = 0;
          // walk the room/passage graph — never aim straight through adobe
          var wps = mapWps();
          if(wps.length){
            var w = wps[(ai.wpi|0) % wps.length];
            var wStand = w[2] != null ? w[2] : 0;
            if(Math.hypot(x - w[0], z - w[1]) < 1.5 && Math.abs((P.ai.body.y|0) - wStand) < 0.7) ai.wpi++;
            w = wps[(ai.wpi|0) % wps.length];
            // if a squad-mate already owns this stop, take the next one so they fan out
            var guard = 0;
            while(guard++ < 4 && others().some(function(Q){
              return Q !== P && Q.ai && Q.ai.goal && Math.hypot(Q.ai.goal[0] - w[0], Q.ai.goal[1] - w[1]) < 1.2;
            })){
              ai.wpi = (ai.wpi|0) + 1;
              w = wps[(ai.wpi|0) % wps.length];
            }
            ai.goal = mapNavNext(x, z, w[0], w[1], P.ai.body.y, (w[2] != null ? w[2] : 0));
          }
        }
      } else {
        // stalkers close on a seen target — do NOT freeze at 18 m and wait under fire like a
        // shooting-gallery duck. Easy/Normal hold ground until ~18 m; Hard presses to ~10 m.
        var pressTo = diffFor(P).id === "hard" ? 10 : diffFor(P).id === "sweaty" ? 6 : 18;
        ai.goal = pickPos && Math.hypot(pickPos[0] - x, pickPos[1] - z) > pressTo ? mapNavNext(x, z, pickPos[0], pickPos[1], P.ai.body.y, pickY || 0) : null;
      }
      }
    }
    // -- turn and aim: track the target's current position, not the last think tick's --
    var aim_y = ai.aim_y, aim_p = ai.aim_p, tgt2 = ai.target, targetAlive = false, txNow = 0, tyNow = 0, tzNow = 0, tvx = 0, tvz = 0;
    if(tgt2){
      if(tgt2.__warden && !V.warden) targetAlive = false;
      else targetAlive = !!(tgt2.__me ? !V.dead : !tgt2.dead);
      var cur = tgt2.__me ? {x: V.me.x + Math.cos(V.yaw)*PEEK_SIDE*(V.peek || 0), y: V.me.y, z: V.me.z + Math.sin(V.yaw)*PEEK_SIDE*(V.peek || 0), vx: V.me.vx || 0, vz: V.me.vz || 0} : tgt2;
      txNow = cur.x; tyNow = cur.y; tzNow = cur.z; tvx = cur.vx || 0; tvz = cur.vz || 0;
    }
    if(targetAlive){
      var df = diffFor(P);
      var wp = FS.WEAPONS[P.w] || FS.LAUNCH;
      // lead and pitch must both see the true 3D range — a target on a ledge above is
      // genuinely farther than its shadow on the floor, so it earns more lead time
      var lead = Math.min(0.25, Math.hypot(txNow - x, (tyNow - P.ai.body.y) || 0, tzNow - z)/wp.range);
      var tx = txNow + tvx*lead, tz = tzNow + tvz*lead,
          ty = (tgt2 && tgt2.__warden) ? ((tgt2.__seeY != null ? tgt2.__seeY : WARDEN_SEE_ARM))
              : tyNow + ((P.n + 1) % 3 === 0 ? 1.35 : 0.9);
      var want_yaw = Math.atan2(tx - x, -(tz - z))*180/Math.PI;
      var flat = Math.max(0.1, Math.hypot(tx - x, tz - z));
      var want_pitch = Math.atan2(ty - (P.ai.body.y + FS.EYE), flat)*180/Math.PI;
      if(t - ai.errAt >= BOT_THINK){
        ai.errAt = t;
        var seed = ((t*1000)|0) & 0xFFFF;
        // EMP Apocalypse: electronic sights go haywire, so bots spray.
        // Hurricane: the wind shreds their sights too ("wild aim").
        // A bolt / flash also blinds them (×4 spray).
        var aimX = (V.disaster === "emp" && disLive(t)) ? 3
                 : (V.disaster === "hurricane" && disLive(t)) ? 2 : 1;
        if(P.blindUntil && t < P.blindUntil) aimX = Math.max(aimX, 1) * 4;
        ai.err_y = (FS.mb32(seed)*2 - 1)*BOT_AIM*df.aim*aimX*180/Math.PI;
        ai.err_p = (FS.mb32((seed + 7919) & 0xFFFF)*2 - 1)*BOT_AIM*df.aim*aimX*180/Math.PI;
        // close-range mercy, by distance: inside df.cqc metres the aim is pushed PAST the
        // target's angular size (a body spans several degrees up close), so the shot
        // physically cannot hit; fades out by cqc+12 m. Easy whiffs point-blank,
        // Sweaty (cqc 0) never does.
        if(df.cqc > 0){
          var flat2 = Math.hypot(txNow - x, tzNow - z);
          if(flat2 < df.cqc + 12){
            // the target's half-extent in degrees at this range (body ~0.6 m wide)
            var bodyHalf = flat2 > 0.1 ? Math.atan(0.3/flat2)*180/Math.PI : 90;
            var push = (bodyHalf + 1.5)*Math.max(0, Math.min(1, (df.cqc + 12 - flat2)/12));
            if(push > 0.2){
              if(Math.abs(ai.err_y) < push) ai.err_y = (ai.err_y >= 0 ? 1 : -1)*push;
              if(Math.abs(ai.err_p) < push) ai.err_p = (ai.err_p >= 0 ? 1 : -1)*push;
            }
          }
        }
      }
      want_yaw += ai.err_y; want_pitch = clamp(want_pitch, -89, 89) + ai.err_p;
      var stepDeg = BOT_TURN*df.turn*180/Math.PI*(1/60);
      var dy = ((want_yaw - aim_y + 540) % 360) - 180; aim_y += clamp(dy, -stepDeg, stepDeg);
      aim_p += clamp(want_pitch - aim_p, -stepDeg, stepDeg);
      ai.aim_y = aim_y; ai.aim_p = aim_p;
      // -- fire: only when the target is actually in the sights right now (visible this frame) --
      // Aim the body, not the eyes (EYE is your head): eye-level LOS false-negatives when a
      // target is crouched or over a slope — the bot thinks it can't fire, plainly staring at you
      var clearNow = (tgt2 && tgt2.__warden)
        ? wardenSee(x, P.ai.body.y + FS.EYE, z, txNow, tzNow) != null
        : los([x, P.ai.body.y + FS.EYE, z], [txNow, tyNow + 0.9, tzNow]);
      // launcher bots: a real missile with their aim; one in the air at a time, like the player
      if(P.hookUntil && t < P.hookUntil){
        // hooked by a grappling gun: the trigger is locked (and the body is dragged)
        if(ai.hookPull || P.hookPull){
          var hp = ai.hookPull || P.hookPull, hdx = hp[0] - x, hdz = hp[1] - z, hd = Math.sqrt(hdx*hdx + hdz*hdz) || 1;
          var hsp = Math.min(FS.GRAPPLE_PULL || 18, hd * 4);
          P.ai.body.vx = hdx/hd*hsp; P.ai.body.vz = hdz/hd*hsp;
          if(hd < 1.2){ ai.hookPull = null; P.hookPull = null; }
        }
      } else if(P.w === LAUNCH_W){
        if(clearNow && ai.seenAt != null && t - ai.seenAt >= BOT_REACT*df.react && t >= ai.fireAt + 1.2 - 0.01 &&
           (P.mag[LAUNCH_W]|0) > 0 && !P.reloadAt && !V.missiles.some(function(m){ return m.owner === P; })){
          ai.fireAt = t; P.mag[LAUNCH_W]--; P.n++; P.protUntil = 0;
          var ldir = FS.dirOf(aim_y, clamp(aim_p, -89, 89));
          spawnMissile(t, [x, P.ai.body.y + FS.EYE, z], ldir, P);
          // [sound] the launch at the bot, not at full volume wherever it is: fades with the distance, panned
          if(E.sfxAt) E.sfxAt("shot", [x, P.ai.body.y + FS.EYE, z], {w: LAUNCH_W, kind: "blast", curve: true}); else E.sfx("shot", {w: LAUNCH_W});
          if(P.mag[LAUNCH_W] <= 0 && (P.res[LAUNCH_W]|0) > 0) P.reloadAt = t + FS.LAUNCH.reload * ((V.disaster === "absolutezero" && disLive(t)) ? 1.5 : 1);
        }
      } else if(P.w !== GRAPPLE_W && clearNow && ai.seenAt != null && t - ai.seenAt >= BOT_REACT*df.react && t >= ai.fireAt + Math.max(wp.interval, wp.interval*(df.rate || 1)) - 0.01 && P.mag[P.w] > 0 && !P.reloadAt){
        ai.fireAt = t; P.mag[P.w]--; P.n++; P.protUntil = 0;
        var sp = FS.spreadOf(P.n, P.w), dir = FS.dirOf(aim_y + sp[0], clamp(aim_p + sp[1], -89, 89));
        var eyeAt = [x, P.ai.body.y + FS.EYE, z];
        var reach = FS.rayMap(MAP, eyeAt, dir, wp.range);
        botJudge(P, t, eyeAt, dir, reach);
        if(P.mag[P.w] <= 0 && P.res[P.w] > 0 && !P.reloadAt) P.reloadAt = t + wp.reload * ((V.disaster === "absolutezero" && disLive(t)) ? 1.5 : 1);
      }
      if(clearNow){ ai.targetPos = [txNow, tzNow]; ai.targetY = tyNow; }
    } else if(ai.goal){
      var want_yaw2 = Math.atan2(ai.goal[0] - x, -(ai.goal[1] - z))*180/Math.PI;
      var step2 = BOT_TURN*diffFor(P).turn*180/Math.PI*(1/60);
      var dy2 = ((want_yaw2 - aim_y + 540) % 360) - 180; aim_y += clamp(dy2, -step2, step2); ai.aim_y = aim_y;
    }
    // -- reload --
    if(P.reloadAt && t >= P.reloadAt){
      var rw = P.w, magW = (FS.WEAPONS[rw] || FS.LAUNCH).mag;
      var take = Math.min(magW - P.mag[rw], P.res[rw]);
      P.mag[rw] += take; P.res[rw] -= take; P.reloadAt = 0;
    }
    // -- move (same physics as the client, stepped in update; a descending glide is drift) --
    if(ai.dropUntil && t < ai.dropUntil){
      ai.wx = 0; ai.wz = 0;  // a gliding bot rides the wind down; movement resumes on the ground
    } else if(ai.goal){
      var dx = ai.goal[0] - x, dz = ai.goal[1] - z, ln2 = Math.hypot(dx, dz);
      ai.wx = ln2 > 0.3 ? dx/ln2 : 0; ai.wz = ln2 > 0.3 ? dz/ln2 : 0;
    } else { ai.wx = 0; ai.wz = 0; }
    // stuck against a wall/corner? aim a sidestep goal and hop the patrol
    if(!ai.dropUntil || t >= ai.dropUntil){
      var moved = Math.hypot(x - (ai.stuck_x || 0), z - (ai.stuck_z || 0));
      if(Math.abs(ai.wx || 0) + Math.abs(ai.wz || 0) > 0.1){
        if(!ai.stuckAt){ ai.stuckAt = t; ai.stuck_x = x; ai.stuck_z = z; }
        else if(moved < 0.12 && t - ai.stuckAt > 0.40){
          // a fixed side per bot: two mates peeling off the same wall go opposite ways
          var side = ((P.slot|0) % 2) ? 1 : -1;
          var ox = ai.wx || 0, oz = ai.wz || 0;
          var sx2 = x + (-oz)*side*3.5, sz2 = z + ox*side*3.5;
          ai.goal = [sx2, sz2];
          ai.slideUntil = t + 1.1;   // hold this peel through the next think ticks
          var lnS = Math.hypot(sx2 - x, sz2 - z);
          ai.wx = lnS > 0.3 ? (sx2 - x)/lnS : 0;
          ai.wz = lnS > 0.3 ? (sz2 - z)/lnS : 0;
          ai.stuckAt = t; ai.stuck_x = x; ai.stuck_z = z;
          ai.wpi = (ai.wpi|0) + 1;   // always hop the patrol graph (same as the Rust peel)
        }
      } else {
        ai.stuckAt = 0; ai.stuck_x = x; ai.stuck_z = z;
      }
    }
    P.yaw = ai.aim_y*Math.PI/180; P.pitch = ai.aim_p*Math.PI/180;
    // write-through to the snap-sampled mesh position
    P.snaps.length = 0; P.snaps.push({t: t, x: ai.body.x, y: ai.body.y, z: ai.body.z, yaw: P.yaw, pitch: P.pitch});
  }
  function botsStep(dt, t){
    others().forEach(function(P){
      if(!P.bot || P.gone || V.phase !== "round") return;
      if(P.dead) return;
      var steps = Math.max(1, Math.round(dt/(1/60)));
      for(var s = 0; s < steps; s++) botStep(P, t - dt + dt*(s + 1)/steps);
      // physics at the client's STEP — or glide it: a descending bot sinks gently with the
      // ground's own collide-and-slide absent (no FS.move during a drop, by design)
      var ai = P.ai, acc = dt;
      if(ai.dropUntil && t < ai.dropUntil){
        var floor = FS.topUnder(MAP, ai.body.x, ai.body.z, ai.body.y);
        if(floor == null) floor = -1e9;   // a gap under the canopy: keep sinking into the void clock
        ai.body.y = Math.max(floor, ai.body.y - FS.DROP_SINK*dt);
        if(ai.body.y <= floor && floor > -1e8){ ai.dropUntil = 0; P.protUntil = t + 1.5; }
      } else {
        if(ai.dropUntil) ai.dropUntil = 0;
        var bG = (P.gravUntil && t < P.gravUntil) ? 0.42 : 1;
        var bJ = (P.wallrunUntil && t < P.wallrunUntil) ? 1.2 : 1;
        var botTop = (ai.body && P.slowUntil && t < P.slowUntil) ? DD_SLOW_MULT : 1;
        while(acc >= STEP){ FS.move(MAP, ai.body, ai.wx || 0, ai.wz || 0, false, STEP, false, botTop, bJ, bG); acc -= STEP; }
        // Void rescue for bots too — same 10s clock, same canopy drop
        if(FS.inVoid(MAP, ai.body.x, ai.body.y, ai.body.z)){
          if(!ai.voidAt) ai.voidAt = t;
          else if(t - ai.voidAt >= FS.VOID_SECS){
            ai.voidAt = 0;
            var dspB = dropOK() ? randomDropSpot(t, P.slot, P.team) : botSpawnFor(P);
            var spB = dspB.slice(); spB[1] = dropOK() ? FS.DROP_HEIGHT : spB[1];
            botPlace(P, spB, t);
          }
        } else if(ai.voidAt){ ai.voidAt = 0; }
        // Hurricane: the walking wind column shoves bots too (everyone suffers — see me)
        if(V.disaster === "hurricane" && disLive(t) && !botShielded(P, t)){
          var spanHB = Math.max(0.1, (V.disasterUntil - V.disasterWarnAt));
          var uHB = clamp((t - V.disasterWarnAt) / spanHB, 0, 1);
          var bHB = MAP.bounds;
          var wxHB = (bHB[0] + hashMatch(V.disasterSeed|0, 21) * (bHB[3] - bHB[0])) * (1 - uHB) +
                     (bHB[0] + hashMatch(V.disasterSeed|0, 23) * (bHB[3] - bHB[0])) * uHB;
          var wzHB = (bHB[2] + hashMatch(V.disasterSeed|0, 22) * (bHB[5] - bHB[2])) * (1 - uHB) +
                     (bHB[2] + hashMatch(V.disasterSeed|0, 24) * (bHB[5] - bHB[2])) * uHB;
          var ddxHB = ai.body.x - wxHB, ddzHB = ai.body.z - wzHB, ddHB = Math.hypot(ddxHB, ddzHB);
          if(ddHB < DD_WIND_R){
            var lnHB = Math.max(0.05, ddHB);
            var shoveHB = DD_WIND_PUSH * (1 - ddHB / DD_WIND_R) * dt;
            ai.body.x += (ddxHB / lnHB) * shoveHB;
            ai.body.z += (ddzHB / lnHB) * shoveHB;
            P.slowUntil = Math.max(P.slowUntil|0, t + DD_WIND_SLOW);   // loose footing
          }
        }
      }
      P.x = ai.body.x; P.y = ai.body.y; P.z = ai.body.z; P.moving = 1;
    });
  }
  function botsRespawn(t){
    others().forEach(function(P){
      if(!P.bot || !P.dead || P.gone) return;
      if(t >= (P.deadAt || 0) + RESPAWN){
        // v4: a bot respawn is a parachute drop too — the same random point the player would
        // get, on the bot's own side (randomDropSpot keeps the halves apart)
        var dsp = dropOK() ? randomDropSpot(t, P.slot, P.team) : botSpawnFor(P);
        var sp = dsp.slice(); sp[1] = dropOK() ? FS.DROP_HEIGHT : sp[1];
        botPlace(P, sp, t);
        onEvent({ev: "spawn", user: P.uid, x: Math.round(P.x*100), y: Math.round(P.y*100), z: Math.round(P.z*100), r: Math.round(P.yaw*18000/Math.PI), e: 0, drop: true});
      }
    });
  }
  function botsRoundEnd(t){
    var lim = V.limit, time = V.endsAt && t >= V.endsAt;
    var a0 = [], a1 = [];
    [{__me: 1}].concat(others()).forEach(function(P){
      var team = P.__me ? V.team : P.team, dead = P.__me ? V.dead : P.dead, gone = P.__me ? false : P.gone;
      if(gone) return;
      (team === 0 ? a0 : a1).push(P);
    });
    if(V.warden){
      // only a side emptying ends the round while the boss is up — clock and score are frozen
      if(!a0.length || !a1.length) endBotMatch(t);
      return;
    }
    if(V.scores[0] >= lim || V.scores[1] >= lim || time || !a0.length || !a1.length){
      endBotMatch(t);
    }
  }
  function endBotMatch(t){
    V.phase = "done";
    var rows = [{user: {id: myId(), name: "You"}, place: 0, team: V.team, bot: 0, kills: V.kills|0, deaths: V.deaths|0}];
    others().forEach(function(P){ rows.push({user: {id: P.uid, name: P.name}, place: 0, team: P.team, bot: 1, kills: P.kills|0, deaths: P.deaths|0}); });
    rows.sort(function(a, b){ return a.team - b.team || b.kills - a.kills || a.deaths - b.deaths; });
    var teamThen = -1, place = 0;
    rows.forEach(function(r, i){ if(r.team !== teamThen){ teamThen = r.team; place = i + 1; } r.place = place; });
    rows.push({teams: [V.scores[0], V.scores[1]]});
    V.results = rows;
    showResults(rows);
    if(IN) IN.unlock();
  }
  function startBotMatch(){
    if(!MAP) return;
    // honour the menu's Map select even if the fetch is still in flight
    var want = mapIdOf();
    if(MAP.id !== want){
      loadMap(want).then(function(){ if(V.alive) startBotMatch(); }, function(){ if(V.alive){ V.note = "Couldn't load that map."; renderMenu(); } });
      return;
    }
    var svb = ssave(), ts = TEAM_SIZES.indexOf(svb.tsize|0) >= 0 ? svb.tsize|0 : 3,
        mins = clamp(Math.round(svb.minutes|0 || 3), 1, 60), lim = clamp(Math.round(svb.kills|0 || 10), 1, 500);
    resetMatch(); V.mode = "bots"; V.off = null; V.k = null; V.watch = null;
    V.warden = null; V.wardenDone = false;
    V.minutes = mins; V.limit = lim; V.tsize = ts; V.scores = [0, 0]; V.kills = 0; V.deaths = 0; V.team = 0;
    // nothing is on the map at the start: every item arrives mid-match from a drop clock
    // (totems every TOTEM_GAP, health/ammo packs every PACK_GAP — each regardless of
    // whether the previous drop was taken). Practice keeps the range's fixed packs.
    V.items = MAP.pickups.map(function(){ return 0; }); V.itemBack = null;
    // scatter the map's own pack pads too — they stay dark until a drop/refill lights one,
    // and when they come back it must not be a pad you can camp
    var bseed = ((((now()*1000)|0) ^ 0x2545F491) >>> 0);
    for(var bi = 0; bi < BASE_PACKS && bi < MAP.pickups.length; bi++){
      MAP.pickups[bi].at = dropSpot((bseed + (bi+1)*2654435761) >>> 0);
    }
    ensureDropSlots();
    while(V.items.length < MAP.pickups.length) V.items.push(0);   // the drop slots exist, empty, all match
    var s = botSpawnFor({team: 0, slot: 0});
    placeMe(s[0], s[1], s[2], s[3]); fullAmmo(); V.hp = 100; V.dead = false; V.life = 1; V.protUntil = now() + 1.5; V.mySlot = 0;
    var t = now();
    for(var b = 1; b < ts; b++) addBot(0, b, t);
    for(var e = 1; e <= ts; e++) addBot(1, e, t);
    renderBoard();
    V.phase = "warmup"; V.goAt = t + 3; V.endsAt = V.goAt + V.minutes*60;
    V.totemAt = t + 3; V.packAt = t + 3; V.disAt = t + 3; V.kinds = [];  // set at warmup; the round's start re-anchors them
    ensureMatchDrones();
    showStage(true); if(R3) R3.buildMap();
    // straight in: the Play click is the gesture pointer lock needs, so grab the mouse now
    // instead of leaving the player on the "click here to play" pause card
    if(canvas) canvas.focus();
    if(IN) IN.lock();
    say("You're on team "+TEAMS[0].n+". "+ts+"v"+ts+" on "+MAP.name+": "+(ts === 1 ? "just you" : "you and "+(ts === 2 ? "one teammate" : (ts - 1)+" teammates"))+" vs "+(ts === 1 ? "one bot" : ts+" bots")+", "+mins+" minute"+(mins === 1 ? "" : "s")+", first to "+lim+". Enemy names are red. Esc gives the mouse back.");
  }
  function endPractice(){
    V.phase = "done";
    var sv = ssave(), best = sv.best|0;
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
  function requestView(){ if(MP) MP.send("strike", "view"); }
  function inMatch(view){ return (view.players || []).some(function(p){ var id = p.user && (p.user.userId || p.user.id); return id === myId() && !p.gone; }); }
  function uidOf(p){ return p.user && (p.user.userId || p.user.id); }
  function applyView(view){
    V.round = view; V.gotView = true;
    if(V.mode !== "mp" || !view) { renderMenu(); return; }
    // snap to the roster's map before anything reads MAP geometry
    var want = (view.map && MAP_FILES[view.map]) ? view.map : "dockyard";
    if(!MAP || MAP.id !== want){
      loadMap(want).then(function(){ if(V.alive) applyView(view); }, function(){ if(V.alive){ V.note = "Couldn't load the arena."; renderMenu(); } });
      return;
    }
    V.minutes = view.minutes|0 || 5; V.limit = view.limit|0 || 30; V.tsize = view.tsize|0 || 2;
    if(Array.isArray(view.scores)) V.scores = [view.scores[0]|0, view.scores[1]|0];
    if(view.phase === "idle"){ V.watch = null; if(V.phase !== "idle"){ resetMatch(); showStage(false); } V.results = view.results || V.results; renderMenu(); return; }
    if(view.phase === "done"){ V.results = view.results; if(V.phase === "warmup" || V.phase === "round") showResults(view.results); V.watch = null; V.killCam = null; V.phase = "done"; renderMenu(); return; }
    if(inMatch(view)) V.watch = null;
    else if(!V.watch){ renderMenu(); return; }
    else if(!(view.players || []).some(function(p){ return uidOf(p) === V.watch && !p.gone; })){
      var first = (view.players || []).filter(function(p){ return p.user && !p.gone; })[0]; V.watch = first ? uidOf(first) : null;
      if(!V.watch){ renderMenu(); return; }
    }
    var fresh = V.phase === "idle" || V.phase === "done";
    if(fresh){ resetMatch(); V.off = null; V.k = null; }
    var seen = {};
    (view.players || []).forEach(function(p){
      var uid = uidOf(p); if(!uid) return; seen[uid] = 1;
      var P = ensure(uid, {name: nameOf(p.user), slot: p.slot|0, team: clamp(p.team|0, 0, 1), bot: !!p.bot, ch: clamp(p.char|0, 0, CHARS.length - 1),
        kills: p.kills|0, deaths: p.deaths|0, hp: p.hp|0, dead: !!p.dead, away: !!p.away, gone: !!p.gone, w: p.w|0,
        cos: (p.user && p.user.cos) || null});
      if(uid === myId()){
        V.mySlot = p.slot|0; V.team = clamp(p.team|0, 0, 1); V.kills = p.kills|0; V.deaths = p.deaths|0; V.hp = p.hp|0;
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
    ensureDropSlots();   // the server's slot list includes the drop rings; match its layout
    V.items = Array.isArray(view.items) ? view.items.slice() : MAP.pickups.map(function(){ return 1; });
    while(V.items.length < MAP.pickups.length) V.items.push(0);
    V.kinds = Array.isArray(view.kinds) ? view.kinds.slice() : [];
    while(V.kinds.length < MAP.pickups.length) V.kinds.push("");
    // live drop / pack spots ride along as cm/100 so a joiner paints them where they
    // actually sit (they are re-rolled every drop and every map-pack refill)
    if(Array.isArray(view.spots)){
      for(var si = 0; si < view.spots.length && si < MAP.pickups.length; si++){
        var sp = view.spots[si];
        if(Array.isArray(sp) && MAP.pickups[si]){
          MAP.pickups[si].at = [(+sp[0] || 0)/100, (+sp[1] || 0)/100, (+sp[2] || 0)/100];
          MAP.pickups[si].kind = V.kinds[si] || MAP.pickups[si].kind || "";
          if(R3 && V.items[si]){
            if(TOTEMS[MAP.pickups[si].kind]) R3.addTotem(si, MAP.pickups[si]);
            else if(MAP.pickups[si].kind === "health" || MAP.pickups[si].kind === "ammo") R3.addPack(si, MAP.pickups[si]);
          }
        }
      }
    }
    if(view.phase === "warmup"){ V.phase = "warmup"; V.goAt = now() + (view.goInMs|0)/1000; V.endsAt = V.goAt + V.minutes*60; ensureMatchDrones(); }
    else if(view.phase === "round"){ V.phase = "round"; V.startAt = now(); V.endsAt = now() + (view.msLeft|0)/1000; if(!V.mdrones || !V.mdrones.length) ensureMatchDrones(); }
    showStage(true);
    if(fresh && R3) R3.buildMap();
    renderBoard();
  }
  function slotUid(s){ return V.slots[s]; }
  function onEvent(m){
    if(m.ev === "warden"){
      if(!m || !m.phase) return;
      if(m.phase === "rise"){
        V.warden = V.warden || {};
        V.warden.hp = +m.hp || 0; V.warden.max = +m.max || 1;
        V.warden.x = (+m.x || 0)/100; V.warden.z = (+m.z || 0)/100;
        V.warden.armL = +m.armL || WARDEN_ARM_HP; V.warden.armR = +m.armR || WARDEN_ARM_HP;
        V.warden.phase = "live"; V.warden.born = now();
        say("The Warden rises at the center of the map!");
        flashCenter("THE WARDEN");
        if(R3 && R3.wardenRise) R3.wardenRise(V.warden);
        return;
      }
      if(m.phase === "ckpt"){
        var ck = clamp(m.ck|0, 1, 3);
        if(V.warden){ V.warden.hp = +m.hp || V.warden.hp; V.warden.ck = V.warden.ck || [false, false, false]; V.warden.ck[ck-1] = true; }
        say("The Warden's checkpoint "+(WARDEN_CHECK_NAMES[ck] || String(ck))+" breaks — boosts scatter!");
        flashCenter("CHECKPOINT "+(WARDEN_CHECK_NAMES[ck] || String(ck)));
        return;
      }
      if(m.phase === "dead"){
        V.warden = null; V.wardenDone = true;
        say("The Warden is down — the match is back on!");
        flashCenter("WARDEN DOWN");
        if(R3 && R3.wardenClear) R3.wardenClear();
        return;
      }
      return;
    }
    if(m.ev === "strike"){
      if(!MAP){ V.round = m.match; V.gotView = true; return; }
      applyView(m.match);
      if(m.by && m.match && m.match.phase === "warmup" && canvas) canvas.focus();
      return;
    }
    if(m.ev === "char"){ var C = V.players[m.user]; if(C){ C.ch = clamp(m.c|0, 0, CHARS.length - 1); if(R3) R3.removePlayer(C); } return; }
    if((V.mode !== "mp" && V.mode !== "bots") || V.phase === "idle") return;
    var t = now();
    // the go whistle also names your side once per match (the lobby assigns you silently,
    // so the match must announce it in the very first moment you regain control)
    if(m.ev === "go"){ V.phase = "round"; V.startAt = t; V.endsAt = t + (m.msLeft|0)/1000; V.off = null; center.classList.add("hidden");
      ensureMatchDrones();
      flashCenter("Fight! Team "+TEAMS[V.team|0].n);
      say("Fight! You're on team "+TEAMS[V.team|0].n+" — enemy names are red."); return; }
    if(m.ev === "snap"){ onSnap(m, t); return; }
    if(m.ev === "kill"){
      var K = V.players[m.k], D = V.players[m.v];
      if(K) K.kills = m.kills|0; if(D){ D.deaths = m.deaths|0; D.dead = true; D.deadAt = t; }
      if(Array.isArray(m.scores)) V.scores = [m.scores[0]|0, m.scores[1]|0];
      var kName = K ? K.name : (m.k === myId() ? "You" : (m.dis ? envKiller(m.dis) : "Someone"));
      var vName = D ? D.name : (m.v === myId() ? "You" : "Someone");
      V.feed.unshift({k: kName, kt: K ? K.team : V.team,
        v: vName, vt: D ? D.team : V.team, w: m.w|0, hs: !!m.hs, at: t,
        dis: m.dis ? String(m.dis) : "", mine: m.k === myId() || m.v === myId()});
      if(m.k === myId()) E.sfx("hit");
      if(V.feed.length > FEED_MAX) V.feed.length = FEED_MAX;
      if(m.v === myId()){ V.dead = true; V.deadAt = t; V.deaths = m.deaths|0; V.hp = 0;
        V.wingsUntil = 0; V.leapUntil = 0; V.speedUntil = 0;   // a death pops the movement totems too
        if(K && K.uid !== myId()) snapKillCam(K, m.w|0, !!m.hs);
        if(!K && m.dis) say(envKiller(m.dis)+" · "+envLabel(m.dis)+" got you. Respawning in "+RESPAWN+" seconds.");
        else say((K ? K.name : "Someone")+" got you. Respawning in "+RESPAWN+" seconds."); }
      if(m.k === myId()){ V.kills = m.kills|0; say("You got "+(D ? D.name : "someone")+(m.hs ? " with a headshot" : "")+". "+TEAMS[0].n+" "+V.scores[0]+" — "+V.scores[1]+" "+TEAMS[1].n+"."); }
      renderFeed(); renderBoard(); return;
    }
    if(m.ev === "spawn"){
      var S = V.players[m.user];
      if(m.user === myId()){
        placeMe((+m.x || 0)/100, (+m.y || 0)/100, (+m.z || 0)/100, (+m.r || 0)/100); V.life = m.e|0; V.dead = false; V.hp = 100; V.killCam = null;
        V.voidAt = 0;
        if(m.drop && dropOK()){ V.dropUntil = t + FS.DROP_TIME; V.me.g = false; }
        fullAmmo(); center.classList.add("hidden"); say("You're back in.");
      } else if(S){ S.dead = false; S.snaps.length = 0; S.last = -1; S.x = (+m.x || 0)/100; S.y = (+m.y || 0)/100; S.z = (+m.z || 0)/100; S.yaw = (+m.r || 0)*Math.PI/18000; S.hp = 100; }
      return;
    }
    if(m.ev === "fix"){
      if((m.e|0) !== V.life) return;
      placeMe((+m.x || 0)/100, (+m.y || 0)/100, (+m.z || 0)/100, null); V.fixAt = t; return;
    }
    if(m.ev === "ammo"){
      if(Array.isArray(m.mag)) V.mag = m.mag.map(function(n){ return n|0; });
      if(Array.isArray(m.res)) V.res = m.res.map(function(n){ return n|0; });
      if(!m.reloading) V.reloadAt = 0;
      return;
    }
    if(m.ev === "pick"){
      V.items[m.i|0] = 0;
      var knd = m.kind || (V.kinds && V.kinds[m.i|0]) || (MAP.pickups[m.i|0] && MAP.pickups[m.i|0].id[0] === "h" ? "health" : "ammo");
      var picker = V.players[m.user], pname = m.user === myId() ? "You" : (picker ? picker.name : "?");
      feedItem(pname, picker ? picker.team : V.team, knd, t);
      if(m.user === myId()){
        V.hp = m.hp|0; if(Array.isArray(m.res)) V.res = m.res.map(function(n){ return n|0; });
        if(V.cursed && V.cursed[m.i|0] && TOTEMS[knd]) say("Cursed Drop: -15 hp");
        if(knd === "health") say("Health pack: "+V.hp);
        else if(knd === "ammo") say("Ammo pack");
        else if(TOTEMS[knd]){
          // MP: the server judged the effect; the local apply is only the cloak/shield's
          // local clock + the say (charm/freeze marks and the decoy ride the snapshot)
          if(knd === "cloak"){ V.cloakUntil = t + TOTEMS.cloak.dur; }
          if(knd === "shield"){ V.shieldTotemUntil = t + TOTEMS.shield.dur; }
          if(knd === "wings"){ V.wingsUntil = t + TOTEMS.wings.dur; }
          if(knd === "leap"){ V.leapUntil = t + TOTEMS.leap.dur; }
          if(knd === "speed"){ V.speedUntil = t + TOTEMS.speed.dur; }
          // Wave C local clocks (the server judged the effect; this is the HUD window)
          if(knd === "gravflip") V.gravUntil = t + TOTEMS.gravflip.dur;
          if(knd === "magnet") V.magnetUntil = t + TOTEMS.magnet.dur;
          if(knd === "wallrun") V.wallrunUntil = t + TOTEMS.wallrun.dur;
          if(knd === "overclock") V.overclockUntil = t + TOTEMS.overclock.dur;
          if(knd === "infchamber") V.infUntil = t + TOTEMS.infchamber.dur;
          if(knd === "fakedeath") V.fakeUntil = t + TOTEMS.fakedeath.dur;
          if(knd === "pocket") V.pocketUntil = t + TOTEMS.pocket.dur;
          if(knd === "phoenix") V.phoenixUntil = t + TOTEMS.phoenix.dur;
          if(knd === "chaos") V.chaosUntil = t + TOTEMS.chaos.dur;
          if(knd === "rally") V.rallyUntil = t + TOTEMS.rally.dur;
          if(knd === "king") V.kingUntil = t + TOTEMS.king.dur;
          if(knd === "fate") V.fateUntil = t + TOTEMS.fate.dur;
          if(knd === "radarjam") V.jamUntil = t + TOTEMS.radarjam.dur;
          if(knd === "rewind") V.secondWind = true;
          if(knd === "secondwind") V.secondWind = true;
          if(knd === "shock"){
            // MP: the server already judged the knock; this is the visual the taker sees
            V.rings = V.rings || [];
            V.rings.push({x: V.me.x, y: (V.me.y || 0) + 0.08, z: V.me.z, at: t, r: 8, dur: 0.55});
            if(R3 && R3.ring) R3.ring(V.me.x, (V.me.y || 0) + 0.08, V.me.z, 8, 0.55, t);
          }
          if(knd === "chain") V.chainLeft = (V.chainLeft|0) + 2;
          if(knd === "blink") V.blinkLeft = (V.blinkLeft|0) + 3;
          if(knd === "ghost") V.ghostLeft = (V.ghostLeft|0) + 3;
          if(knd === "cluster") V.clusterLeft = (V.clusterLeft|0) + 5;
          if(knd === "ricochet") V.ricoLeft = (V.ricoLeft|0) + 3;
          if(knd === "teleport" && m.tx != null && m.tz != null){
            // the server moved us: snap the prediction to where it put us (ground, standing)
            placeMe((+m.tx)/100, 0, (+m.tz)/100, null);
            V.dropUntil = 0; V.wingsUntil = 0;
          }
          say(TOTEMS[knd].n+" taken.");
        }
        else say(TOTEMS[knd] ? TOTEMS[knd].n : "Pack");
      }
      return;
    }
    if(m.ev === "cheat"){
      say("Second Wind / Phoenix: a killing blow just failed");
      return;
    }
    if(m.ev === "rift"){
      // a linked pair of openings the server just planted (MP). Solo plants them in
      // totemApply; both feeds the same V.rifts list the rocket step teleports through.
      V.rifts = V.rifts || [];
      var rx = (+m.x || 0)/100, rz = (+m.z || 0)/100, rx2 = (+m.x2 || 0)/100, rz2 = (+m.z2 || 0)/100;
      var rfMP = {x: rx, z: rz, x2: rx2, z2: rz2, until: t + TOTEMS.rift.dur};
      V.rifts.push(rfMP);
      if(R3 && R3.addRift) R3.addRift(rfMP);
      say("Rift opened");
      return;
    }
    if(m.ev === "fused"){
      // two unclaimed totems merged into one stronger drop
      var fi = m.i|0, fk = String(m.kind || "chaos");
      if(!TOTEMS[fk]) return;
      ensureDropSlots();
      if(MAP.pickups[fi]){
        V.kinds = V.kinds || [];
        while(V.kinds.length < MAP.pickups.length) V.kinds.push("");
        V.kinds[fi] = fk;
        MAP.pickups[fi].kind = fk;
        MAP.pickups[fi].id = fk + "-" + fi;
        if(R3) R3.addTotem(fi, MAP.pickups[fi]);
      }
      say("Totem Fusion: a Chaos Core just formed");
      return;
    }
    if(m.ev === "disaster"){
      var dk = String(m.kind || "");
      if(dk === "clear"){ disClear(t); say("Disaster over"); return; }
      if(!TOTEMS[dk]) return;
      V.disaster = dk;
      V.disasterWarnAt = t + ((+m.warn || 2000)/1000);
      V.disasterUntil = t + ((+m.warn || 2000)/1000) + ((+m.dur || 10000)/1000);
      V.disasterHitAt = V.disasterWarnAt;
      V.disasterRing = 0; V.disasterHit = {}; V.disasterMarks = []; V.disasterMarkK = 0;
      flashCenter("⚠ "+TOTEMS[dk].n.toUpperCase()+" INCOMING");
      say(TOTEMS[dk].n + " incoming — everyone is in it");
      if(R3 && R3.disaster) R3.disaster(dk, true);
      return;
    }
    if(m.ev === "crate"){
      // a Contested Capture crate landed somewhere on the deck
      V.captureAt = [(+m.x || 0)/100, (+m.z || 0)/100];
      V.captureProg = 0;
      say("Capture crate dropped — stand on it for 3s to claim it");
      return;
    }
    if(m.ev === "captured"){
      var ci = m.i|0;
      var cu = V.slots && V.slots[ci];
      var cP = cu ? V.players[cu] : null;
      V.captureAt = null; V.captureProg = 0;
      say((cP ? cP.name : "Someone") + " claimed the capture crate");
      return;
    }
    if(m.ev === "event"){
      var ek = String(m.kind || "");
      if(ek === "clear"){
        V.arenaEvent = ""; V.arenaEventUntil = 0;
        say("Arena event over");
      } else {
        var ew = (+m.warn || 0)/1000, ed = (+m.dur || 0)/1000;
        V.arenaEvent = ek;
        V.arenaEventUntil = t + ew + ed;
        var eNames = {lowg: "Low Gravity", storm: "Sandstorm", nosprint: "No Sprint"};
        say((eNames[ek] || ek) + " in " + Math.ceil(ew) + "s — lasts " + Math.ceil(ed) + "s");
      }
      return;
    }
    if(m.ev === "totem"){
      // a fresh totem the server dropped (a recycled slot): same bookkeeping the solo
      // spawner does — rewrite the slot, kill any pending refill, show the new gem
      var ti = m.i|0, tk = String(m.kind || "");
      if(!TOTEMS[tk]) return;
      ensureDropSlots();
      var ttag = String(m.tag || "");
      MAP.pickups[ti] = {id: tk+"-"+ti, kind: tk, at: [(+m.x || 0)/100, 0, (+m.z || 0)/100], tag: ttag};
      V.cursed = V.cursed || {};
      V.cursed[ti] = ttag === "cursed";
      V.kinds = V.kinds || [];
      while(V.kinds.length < MAP.pickups.length) V.kinds.push("");
      V.kinds[ti] = tk;
      V.items = V.items || [];
      while(V.items.length < MAP.pickups.length) V.items.push(0);
      V.items[ti] = 1; if(V.itemBack) delete V.itemBack[ti];
      if(R3) R3.addTotem(ti, MAP.pickups[ti]);
      return;
    }
    if(m.ev === "pack"){
      // a fresh loose health/ammo pack the server dropped (a recycled slot of its own ring)
      var pi = m.i|0, pkd = String(m.kind || "") === "health" ? "health" : "ammo";
      ensureDropSlots();
      MAP.pickups[pi] = {id: pkd+"-"+pi, kind: pkd, at: [(+m.x || 0)/100, 0, (+m.z || 0)/100]};
      V.kinds = V.kinds || [];
      while(V.kinds.length < MAP.pickups.length) V.kinds.push("");
      V.kinds[pi] = "";
      V.items = V.items || [];
      while(V.items.length < MAP.pickups.length) V.items.push(0);
      V.items[pi] = 1; if(V.itemBack) delete V.itemBack[pi];
      if(R3) R3.addPack(pi, MAP.pickups[pi]);
      return;
    }
    if(m.ev === "item"){
      var ii = m.i|0;
      V.items[ii] = 1;
      // a map pack that came back arrives with its new spot (cm / 100)
      if(m.x != null && MAP && MAP.pickups[ii]){
        MAP.pickups[ii].at = [(+m.x || 0)/100, 0, (+m.z || 0)/100];
        if(R3 && (MAP.pickups[ii].kind === "health" || MAP.pickups[ii].kind === "ammo")) R3.addPack(ii, MAP.pickups[ii]);
      }
      return;
    }
    if(m.ev === "gone"){ var G = V.players[m.user]; if(G){ G.gone = true; renderBoard(); } return; }
    if(m.ev === "done"){ V.results = m.results; V.phase = "done"; showResults(m.results); if(IN) IN.unlock(); return; }
  }
  function onSnap(m, t){
    if(typeof m.ts === "number"){ var o = t - m.ts/1000; if(V.off === null || o < V.off) V.off = o; }
    // snap "wd": [hp, max, cm_x, cm_z, ms_slab_arm, ms_slab_land, ms_laser_warn,
    //             laser_on_ms, laser_yaw_cdeg, ms_dis, ck_bits, yaw_cdeg,
    //             ms_core, ms_grip_warn, ms_grip_on, ms_grip_at]
    if(Array.isArray(m.wd)){
      var wd = m.wd;
      if(!V.warden) V.warden = {ck: [false, false, false], phase: "live", born: now(), yaw: 0};
      V.warden.hp = +wd[0] || 0; V.warden.max = +wd[1] || 1;
      V.warden.x = (+wd[2] || 0)/100; V.warden.z = (+wd[3] || 0)/100;
      V.warden.yaw = (wd.length > 11 ? (+wd[11] || 0) : 0)/100 * Math.PI/180;
      // snap packs remaining ms-to-event (0 = idle) — convert to a clock, never |0 a float
      var tSnap = now();
      V.warden.slabArm = (+wd[4] > 0) ? tSnap + (+wd[4])/1000 : 0;
      V.warden.slabLand = (+wd[5] > 0) ? tSnap + (+wd[5])/1000 : 0;
      V.warden.laserWarn = (+wd[6] > 0) ? tSnap + (+wd[6])/1000 : 0;
      V.warden.laserOn = (+wd[7] > 0) ? tSnap + (+wd[7])/1000 : 0;
      V.warden.laserYaw = (+wd[8] || 0)/100 * Math.PI/180;
      V.warden.disAt = (+wd[9] > 0) ? tSnap + (+wd[9])/1000 : 0;
      var ckb = +wd[10] || 0;
      V.warden.ck = [!!(ckb & 1), !!(ckb & 2), !!(ckb & 4)];
      // additive core / gravity-grip clocks (absent on an older Arena)
      V.warden.coreUntil = (wd.length > 12 && +wd[12] > 0) ? tSnap + (+wd[12])/1000 : 0;
      V.warden.gripWarn = (wd.length > 13 && +wd[13] > 0) ? tSnap + (+wd[13])/1000 : 0;
      V.warden.gripOn = (wd.length > 14 && +wd[14] > 0) ? tSnap + (+wd[14])/1000 : 0;
      V.warden.gripAt = (wd.length > 15 && +wd[15] > 0) ? tSnap + (+wd[15])/1000 : 0;
      if(V.warden.slabArm > 0 && !V.wdArmWarn){
        V.wdArmWarn = true;
        if(R3 && R3.wardenSlamArm) R3.wardenSlamArm(2, tSnap);
      }
      if(!V.warden.slabArm && V.wdArmWarn){
        V.wdArmWarn = false;
        if(R3 && R3.wardenSlam) R3.wardenSlam(tSnap);
      }
      if(R3 && R3.wardenSync) R3.wardenSync(V.warden, tSnap);
    } else if(V.warden && m.wd === 0) V.warden = null;
    if(typeof m.k === "number" && (V.k === null || m.k > V.k)){ V.k = m.k; V.kq = myClock(); }
    if(typeof m.ms === "number") V.endsAt = t + m.ms/1000;
    if(Array.isArray(m.sc)) V.scores = [m.sc[0]|0, m.sc[1]|0];
    // snap "hk": live grapple pulls [victim_slot, cm_shooter_x, cm_shooter_z]
    if(Array.isArray(m.hk)){
      m.hk.forEach(function(e){
        if(!Array.isArray(e) || e.length < 3) return;
        var uid = slotUid(e[0]); if(!uid) return;
        var P = V.players[uid]; if(!P) return;
        P.hookPull = [(+e[1] || 0)/100, (+e[2] || 0)/100];
        if(uid === myId()) V.hookPull = P.hookPull;
      });
    }
    // snap "dr": match flight drones [id, cm_x, cm_y, cm_z] — grapple anchors
    if(Array.isArray(m.dr) && m.dr.length){
      V.mdrones = m.dr.map(function(e, i){
        return {i: (+e[0]|0) || i, x: (+e[1] || 0)/100, y: (+e[2] || 0)/100, z: (+e[3] || 0)/100, phase: i*(FS.DRONE_PHASE || 1.3)};
      });
      V.mdronesSnap = true;
    }
    (m.p || []).forEach(function(e){
      if(!Array.isArray(e) || e.length < 10) return;
      var uid = slotUid(e[0]); if(!uid) return;
      var P = V.players[uid]; if(!P) return;
      var f = e[8]|0;
      P.hp = e[6]|0; P.w = e[7]|0; P.prot = !!(f & 2); P.away = !!(f & 4); P.gone = !!(f & 8); P.bot = !!(f & 16);
      // bit 32: the drop shield — the server's word on who's an untouchable glider
      if(f & 32){ P.prot = (P.prot|0) | 32; } else { P.prot = (P.prot|0) & ~32; }
      // bits 64/128: the totem marks the server adjudicates in MP (mole gold, paralyser
      // violet) — Infinity while flagged, so the solo clock checks read it as "still on"
      if(f & 64){ if(!P.charmUntil && R3) R3.charm(P); P.charmUntil = Infinity; }
      else if(P.charmUntil){ clearMarks(P); P.charmUntil = 0; }
      if(f & 128){ if(!P.freezeUntil && R3) R3.charm(P, "freeze"); P.freezeUntil = Infinity; }
      else if(P.freezeUntil){ clearMarks(P, "freeze"); P.freezeUntil = 0; }
      // Wave C marks (bits 2048+). JS bitwise is 32-bit, so use a 64-bit safe test.
      var has = function(bit){ return (f & bit) !== 0; };
      P.gravUntil = has(2048) ? Infinity : 0;
      P.overclockUntil = has(4096) ? Infinity : 0;
      P.infUntil = has(8192) ? Infinity : 0;
      P.magnetUntil = has(16384) ? Infinity : 0;
      P.wallrunUntil = has(32768) ? Infinity : 0;
      P.fakeUntil = has(65536) ? Infinity : 0;
      P.pocketUntil = has(131072) ? Infinity : 0;
      P.rallyUntil = has(262144) ? Infinity : 0;
      P.kingUntil = has(524288) ? Infinity : 0;
      P.hunterUntil = has(1048576) ? Infinity : 0;
      P.fateUntil = has(2097152) ? Infinity : 0;
      P.phoenixUntil = has(4194304) ? Infinity : 0;
      P.jamUntil = has(8388608) ? Infinity : 0;
      // disaster sense (FLAG_BLIND / FLAG_SLOW): Infinity while flagged so the
      // clock checks read "still on", exactly like jam / freeze above
      P.blindUntil = has(16777216) ? Infinity : 0;
      P.slowUntil = has(33554432) ? Infinity : 0;
      // FLAG_HOOK (1<<26): bit 67108864 (see FS / backend FLAG_HOOK)
      // bit 67108864 (FLAG_HOOK): hooked by a grappling gun — the trigger is locked
      if(has(FLAG_HOOK)){ P.hookUntil = Infinity; }
      else { P.hookUntil = 0; P.hookPull = null; }
      if(uid === myId()){
        V.blindUntil = P.blindUntil;
        V.slowUntil = P.slowUntil;
        V.hookUntil = P.hookUntil;
        V.hookPull = P.hookPull;
      }
      // bits 256/512/1024: the movement totems' windows (wings/leap/speed) — Infinity while
      // flagged so the solo clock checks read "still on", exactly like charm/freeze above
      if(uid === myId()){
        if(f & 256) V.wingsUntil = Infinity; else if(V.wingsUntil === Infinity) V.wingsUntil = 1; // not 0: the glide-down after cruise still flies
        if(f & 512) V.leapUntil = Infinity; else if(V.leapUntil === Infinity) V.leapUntil = 0;
        if(f & 1024) V.speedUntil = Infinity; else if(V.speedUntil === Infinity) V.speedUntil = 0;
      }
      if(uid === myId()){ V.hp = e[6]|0; V.prot = P.prot; if(f & 1) V.dead = true; return; }
      if(f & 1){ if(!P.dead) P.deadAt = t; P.dead = true; } else if(P.dead){ P.dead = false; P.snaps.length = 0; P.last = -1; }
      pushSnap(P, e, t);
    });
    (m.s || []).forEach(function(s){
      if(!Array.isArray(s) || s.length < 7) return;
      var shooter = slotUid(s[0]), end = [s[2]/100, s[3]/100, s[4]/100];
      // a launcher shot: no tracer — the "r" rows fly the rocket; one echo per victim carries the damage
      if((s[1]|0) === LAUNCH_W){
        if(shooter === myId()){
          if(s[5] >= 0){
            var LV = V.players[slotUid(s[5])];
            if(LV && s[7] > 0){   // s[7]: the damage the server actually applied (0 through spawn cover)
              V.hitAt = t;
              V.dmgNums.push({x: LV.x, y: LV.y + 1.2, z: LV.z, n: s[7]|0, head: false, at: t, o: null});
              if(V.dmgNums.length > 12) V.dmgNums.shift();
            }
          }
          return;
        }
        if(s[5] === V.mySlot){ V.hurtAt = t; var LP = V.players[shooter]; if(LP) V.hurtDir = Math.atan2(LP.x - V.me.x, -(LP.z - V.me.z)) - V.yaw; }
        return;
      }
      if(shooter === myId()){
        if(s[5] >= 0){
          V.hitAt = t; if(s[6]) V.headAt = t;
          // the server confirmed the hit: float the damage it applied, at the victim.
          // (suppressed while the server still flags the victim spawn-protected — that hit did 0)
          var VIC = V.players[slotUid(s[5])], WP2 = FS.WEAPONS[s[1]|0];
          if(VIC && WP2 && !(VIC.prot & 2)){
            V.dmgNums.push({x: VIC.x, y: VIC.y + (s[6] ? 1.75 : 1.2), z: VIC.z, n: s[6] ? WP2.head : WP2.damage, head: !!s[6], at: t, o: null});
            if(V.dmgNums.length > 12) V.dmgNums.shift();
          }
        }
        return;
      }
      var P = V.players[shooter];
      if(P) addTracer(muzzleOf(P), end, s[1]|0, t, false);
      if(s[5] === V.mySlot && P){
        V.hurtAt = t; V.hurtDir = Math.atan2(P.x - V.me.x, -(P.z - V.me.z)) - V.yaw;
      }
    });
    // "r": the launcher rockets the server is flying — same meshes the solo match uses,
    // positioned straight from the row (no local physics: the server already judged it)
    (m.r || []).forEach(function(r){
      if(!Array.isArray(r) || r.length < 7) return;
      var key = "srv-"+(r[0]|0);
      var mis = null;
      for(var i = 0; i < V.missiles.length; i++) if(V.missiles[i].srvKey === key){ mis = V.missiles[i]; break; }
      if(!mis){
        mis = spawnMissile(t, [r[1]/100, r[2]/100, r[3]/100], [0, 0, 1], null, true);
        mis.srvKey = key; mis.id = "srv"+(r[0]|0);
      }
      mis.x = r[1]/100; mis.y = r[2]/100; mis.z = r[3]/100;
      var ln = Math.sqrt(r[4]*r[4] + r[5]*r[5] + r[6]*r[6]) || 1;   // velocity: aim the nose
      mis.vx = r[4]/ln*FS.MISSILE_V; mis.vy = r[5]/ln*FS.MISSILE_V; mis.vz = r[6]/ln*FS.MISSILE_V;
      mis.px = mis.x; mis.py = mis.y; mis.pz = mis.z;
      mis.lastSrv = t;
      if(R3) R3.rocket(mis, mis);
    });
    // gone from the snapshot: the rocket landed (the "b" rows bring the boom) or expired
    for(var ri = V.missiles.length - 1; ri >= 0; ri--){
      var rm = V.missiles[ri];
      if(rm.srv && t - (rm.lastSrv || t) > 0.3){ if(rm.o && R3) R3.rocket(null, rm); V.missiles.splice(ri, 1); }
    }
    // "b": a blast the server resolved — the boom, the shake and the hurt flash, minus the damage
    // (hp already came in the same snapshot's "p" rows / shot echoes). Disaster booms also
    // blind (thunder / meteor flash, shockring) or throw your step (quake) near the strike.
    (m.b || []).forEach(function(bm){
      if(!Array.isArray(bm) || bm.length < 3) return;
      var x = bm[0]/100, y = bm[1]/100, z = bm[2]/100;
      if(R3) R3.boom(x, y, z, t);
      if(E.sfxAt) E.sfxAt("boom", [x, y, z], {kind: "blast", curve: true}); else E.sfx("boom");   // [sound] at the blast (as detonate's)
      var near = Math.sqrt((V.me.x - x)*(V.me.x - x) + (V.me.y + 0.9 - y)*(V.me.y + 0.9 - y) + (V.me.z - z)*(V.me.z - z));
      if(!V.dead && near < FS.BLAST_R + 6){
        V.shakeAt = t;
        if(near < FS.BLAST_R){ V.hurtAt = t; V.hurtDir = Math.atan2(x - V.me.x, -(z - V.me.z)) - V.yaw; }
        if(!meShielded(t)){
          if(V.disaster === "thunder" && near < DD_THUNDER_R + 2) V.blindUntil = Math.max(V.blindUntil|0, t + DD_THUNDER_BLIND);
          else if(V.disaster === "meteorshower" && near < DD_METEOR_R + 2) V.blindUntil = Math.max(V.blindUntil|0, t + DD_METEOR_BLIND);
          else if(V.disaster === "earthquake" && near < DD_QUAKE_R + 2) V.slowUntil = Math.max(V.slowUntil|0, t + DD_QUAKE_SLOW);
        }
      }
    });
    // Wave C world extras (additive keys — an older client simply never reads them)
    V.rifts = V.rifts || []; V.mines = V.mines || []; V.meteors = V.meteors || [];
    V.beacons = V.beacons || []; V.bubbles = V.bubbles || [];
    if(Array.isArray(m.po)){
      // snapshot is the source of truth for live rift pairs — repaint so a missed
      // "rift" event still shows the openings (and a replaced pair drops its mesh)
      if(R3 && R3.clearRifts) R3.clearRifts();
      V.rifts = [];
      for(var pi2 = 0; pi2 + 1 < m.po.length; pi2 += 2){
        var rfSnap = {x: (+m.po[pi2][1] || 0)/100, z: (+m.po[pi2][2] || 0)/100,
                      x2: (+m.po[pi2+1][1] || 0)/100, z2: (+m.po[pi2+1][2] || 0)/100,
                      until: t + ((+m.po[pi2][3] || 0)/1000)};
        V.rifts.push(rfSnap);
        if(R3 && R3.addRift) R3.addRift(rfSnap);
      }
    }
    if(Array.isArray(m.mi)){
      V.mines = m.mi.map(function(r){ return {id: r[0], x: (+r[1]||0)/100, z: (+r[2]||0)/100, team: r[3]|0}; });
    }
    if(Array.isArray(m.me)){
      V.meteors = m.me.map(function(r){ return {id: r[0], x: (+r[1]||0)/100, z: (+r[2]||0)/100, hitAt: t + ((+r[3]||0)/1000)}; });
    }
    if(Array.isArray(m.bc)){
      V.beacons = m.bc.map(function(r){ return {id: r[0], x: (+r[1]||0)/100, z: (+r[2]||0)/100, kind: String(r[3]||""), team: r[4]|0, until: t + ((+r[5]||0)/1000)}; });
    }
    if(Array.isArray(m.bu)){
      V.bubbles = m.bu.map(function(r){ return {id: r[0], x: (+r[1]||0)/100, y: (+r[2]||0)/100, z: (+r[3]||0)/100, r: (+r[4]||0)/100, team: r[5]|0, until: t + ((+r[6]||0)/1000)}; });
    }
    // "fa"/"ae" durations are milliseconds left on the clock (not the clock itself)
    if(Array.isArray(m.fa)){ V.fateUntil = t + ((+m.fa[0] || 0)/1000); }
    if(Array.isArray(m.ae)){
      V.arenaEvent = String(m.ae[0] || "");
      V.arenaEventUntil = t + ((+m.ae[1] || 0)/1000);
    } else { V.arenaEvent = ""; V.arenaEventUntil = 0; }
    // "di"/"dm": the live disaster and its pending impact marks (ms left)
    // di[4] is always the ms until the NEXT automatic disaster — the top-bar clock —
    // even when no disaster is live (the row is then [null,…, ms-to-next]).
    if(Array.isArray(m.di) && m.di.length > 4){
      V.disasterAt = t + Math.max(0, ((+m.di[4] || 0)/1000));
    }
    if(Array.isArray(m.di)){
      var dk2 = String(m.di[0] || "");
      if(dk2 && TOTEMS[dk2]){
        if(V.disaster !== dk2){ V.disaster = dk2; V.disasterHit = {}; if(R3 && R3.disaster) R3.disaster(dk2, true); }
        V.disasterWarnAt = t + ((+m.di[1] || 0)/1000);
        V.disasterUntil = t + ((+m.di[1] || 0)/1000) + ((+m.di[2] || 0)/1000);
        V.disasterRing = (+m.di[3] || 0)/100;
        V.disasterHitAt = V.disasterWarnAt;
        // v9: the frozen hazard geometry the judge uses — paint these exact spots
        if(m.di.length > 5) V.disasterSeed = (+m.di[5] || 0) >>> 0;
        if(m.di.length > 6 && Array.isArray(m.di[6])){
          V.disasterZones = m.di[6].map(function(z){
            return Array.isArray(z) ? [(+z[0]||0)/100, (+z[1]||0)/100] : [0, 0];
          });
        } else { V.disasterZones = []; }
        if(m.di.length > 7 && Array.isArray(m.di[7])){
          V.disasterPit = [(+m.di[7][0]||0)/100, (+m.di[7][1]||0)/100];
        } else { V.disasterPit = null; }
      } else { disClear(t); }
    } else if(V.mode === "mp"){ disClear(t); }
    V.disasterMarks = Array.isArray(m.dm) ? m.dm.map(function(r){
      return {id: r[0]|0, x: (+r[1]||0)/100, z: (+r[2]||0)/100, hitAt: t + ((+r[3]||0)/1000),
              r: (+r[4]||0)/100, oh: !!(r[5]|0), dmg: (r[6]|0) || 0, dis: dk2 || V.disaster, quake: !!(r[7]|0)};
    }) : [];
    if(Array.isArray(m.cr)){
      V.captureAt = [(+m.cr[0]||0)/100, (+m.cr[1]||0)/100]; V.captureProg = m.cr[2]|0;
    } else { V.captureAt = null; V.captureProg = 0; }
    // "d": the decoy ghosts the server owns in MP — one row per live ghost, reconciled by
    // id; the render pass drops a ghost whose window closed (same meshes a solo drop uses)
    if(Array.isArray(m.d)){
      V.decoys = V.decoys || [];
      for(var di = V.decoys.length - 1; di >= 0; di--){ if(V.decoys[di].srv) V.decoys.splice(di, 1); }
      m.d.forEach(function(dc){
        if(!Array.isArray(dc) || dc.length < 5) return;
        var found = null;
        V.decoys.forEach(function(q){ if(q.srvId === (dc[0]|0)) found = q; });
        if(found){ found.x = dc[1]/100; found.y = dc[2]/100; found.z = dc[3]/100; found.until = t + dc[4]/1000; found.yaw = (dc[5]|0)/100; return; }
        var nd = {x: dc[1]/100, y: dc[2]/100, z: dc[3]/100, until: t + dc[4]/1000,
                  yaw: (dc[5]|0)/100, srv: true, srvId: dc[0]|0};
        V.decoys.push(nd); if(R3) R3.addDecoy(nd);
      });
    }
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
  // your eyes, slid sideways by the lean (PEEK_SIDE at full lean); shots come from here, and the
  // bots aim at the same spot — peeking shows your head, it doesn't move your feet
  function eye(){
    var px = Math.cos(V.yaw)*PEEK_SIDE*(V.peek || 0), pz = Math.sin(V.yaw)*PEEK_SIDE*(V.peek || 0);
    return [V.me.x + px, V.me.y + FS.EYE, V.me.z + pz];
  }
  function myMuzzle(){
    var f = FS.dirOf(V.yaw*180/Math.PI, V.pitch*180/Math.PI), r = [Math.cos(V.yaw), 0, Math.sin(V.yaw)], e = eye();
    return [e[0] + f[0]*0.55 + r[0]*0.22, e[1] + f[1]*0.55 - 0.2, e[2] + f[2]*0.55 + r[2]*0.22];
  }
  function matchDronePos(D, t){
    if(!D) return [0, DRONE_Y_FALLBACK(), 0];
    if(V.mdronesSnap && D.x != null) return [D.x, D.y, D.z];
    // twin of Rust drone_at(t - go_at): match-clock, no per-drone phase
    var mt = (V.phase === "round" || V.phase === "warmup") ? (t - (V.startAt || 0)) : 0;
    if(!(mt > 0)) mt = 0;
    return FS.targetAt(D.tg || {a: D.a, b: D.b, s: D.s || 7.5}, mt);
  }
  function DRONE_Y_FALLBACK(){ return FS.DRONE_Y || 7.5; }
  function ensureMatchDrones(){
    V.mdrones = FS.grappleRoutes(MAP && MAP.bounds).map(function(tg, i){
      return {tg: tg, i: i, phase: i*(FS.DRONE_PHASE || 1.3)};
    });
    V.mdronesSnap = false;
  }
  function fireGrapple(t, e, d){
    // zero damage. A match/practice drone lifts you into a swing; a foe is dragged in
    // and cannot shoot while the hook is on. The Warden is never a hook target.
    var reach = FS.rayMap(MAP, e, d, W().range), end = reach;
    var lanes = [], i;
    if(V.mdrones && V.mdrones.length){
      for(i = 0; i < V.mdrones.length; i++){
        lanes.push({tg: V.mdrones[i].tg, phase: V.mdrones[i].phase, snap: matchDronePos(V.mdrones[i], t)});
      }
    }
    if(V.mode === "practice" && V.drones && V.drones.length){
      for(i = 0; i < V.drones.length; i++){
        if(V.drones[i].downUntil > t) continue;
        var c0 = dronePos(V.drones[i], t - V.startAt);
        lanes.push({snap: c0, practice: V.drones[i]});
      }
    }
    var bestH = null, bestL = null;
    for(i = 0; i < lanes.length; i++){
      var c = lanes[i].snap || matchDronePos(V.mdrones[i] || lanes[i], t);
      var b = [c[0]-FS.DRONE_R, c[1]-FS.DRONE_R*0.7, c[2]-FS.DRONE_R, c[0]+FS.DRONE_R, c[1]+FS.DRONE_R*0.7, c[2]+FS.DRONE_R];
      var h = FS.rayBox(e, d, b);
      if(h !== null && h < end && (bestH === null || h < bestH)){ bestH = h; bestL = lanes[i]; }
    }
    if(bestH !== null && bestL){
      var cd = bestL.snap || matchDronePos(V.mdrones[bestL.i] || bestL, t);
      V.swingUntil = t + (FS.GRAPPLE_TIME || 2.5);
      V.hookTo = [cd[0], cd[1], cd[2]];
      // ease up to the drone like the wings totem (WING_RISE) — never snap the altitude
      V.swingY = +cd[1] || 0;
      V.me.g = false;
      var fd = FS.dirOf(V.yaw*180/Math.PI, 0);
      V.me.vx = fd[0]*(FS.GRAPPLE_SWING || 11);
      V.me.vz = fd[2]*(FS.GRAPPLE_SWING || 11);
      V.me.vy = 0;
      V.voidAt = 0;
      addTracer(e, [cd[0], cd[1], cd[2]], V.w, t, true);
      if(bestL.practice){ bestL.practice.downUntil = 0; }
      say("Grapple: swing");
      if(R3 && R3.kick) R3.kick();
      return;
    }
    // foe hook — skipped while The Warden lives (nobody hurts / no PvP hooks then)
    if(!V.warden){
      var aimed = null, aimedH = null;
      var scan = function(P){
        if(!P || P.dead || P.gone || P.team === V.team) return;
        if(P.prot || (P.protUntil && t < P.protUntil)) return;
        var h = FS.rayPlayer(e, d, P.x, P.y, P.z, end);
        if(h && h[0] < end && (aimedH === null || h[0] < aimedH)){ aimedH = h[0]; aimed = P; }
      };
      if(V.mode === "bots"){ others().forEach(function(P){ if(P.bot) scan(P); }); }
      else if(V.mode === "mp"){ others().forEach(scan); }
      else { others().forEach(scan); }
      if(aimed){
        aimed.hookUntil = t + (FS.HOOK_LOCK || 2);
        aimed.hookPull = [V.me.x, V.me.z];
        if(aimed.bot){
          aimed.ai = aimed.ai || {};
          aimed.ai.hookPull = [V.me.x, V.me.z];
        }
        if(V.hookUntil && t < V.hookUntil){ /* never self-hook */ }
        addTracer(e, [aimed.x, aimed.y + 1.0, aimed.z], V.w, t, true);
        say("Hooked "+nameOf(aimed)+" — they can't shoot");
        if(R3 && R3.kick) R3.kick();
        return;
      }
    }
    addTracer(e, [e[0] + d[0]*end, e[1] + d[1]*end, e[2] + d[2]*end], V.w, t, true);
    if(R3 && R3.kick) R3.kick();
  }
  function canShoot(t){
    if(V.dead || V.paused) return false;
    if(V.mode === "mp" && V.phase !== "round") return false;
    if((V.mode === "practice" || V.mode === "bots") && V.phase !== "round") return false;
    if(V.hookUntil && t < V.hookUntil) return false;  // a live hook locks the trigger
    return t >= V.readyAt && t >= V.nextShot && !V.reloadAt && magOf(V.w)[V.w === LAUNCH_W ? 0 : V.w] > 0;
  }
  function startReload(t){
    var w = V.w, wp = W(), mag = magOf(w), res = resOf(w), i = w === LAUNCH_W ? 0 : w;
    if(V.infUntil && t < V.infUntil){ mag[i] = wp.mag; return; }
    if(V.reloadAt || mag[i] >= wp.mag || res[i] <= 0 || V.dead) return;
    // Absolute Zero: fingers are numb, every reload crawls
    V.reloadAt = t + wp.reload * ((V.disaster === "absolutezero" && disLive(t)) ? 1.5 : 1);
    if(V.mode === "mp" && MP) MP.send("strike", "reload", {q: myClock(), e: V.life});
    say("Reloading");
  }
  function finishReload(t){
    if(V.reloadAt && t >= V.reloadAt){
      var w = V.w, wp = W(), mag = magOf(w), res = resOf(w), i = w === LAUNCH_W ? 0 : w;
      var take = Math.min(wp.mag - mag[i], res[i]);
      mag[i] += take; res[i] -= take; V.reloadAt = 0;
    }
  }
  function switchTo(w, t){
    w = clamp(w|0, 0, weaponCount() - 1);
    if(w === V.w || V.dead) return;
    V.w = w; V.reloadAt = 0; V.readyAt = t + SWITCH;
    if(V.mode === "mp" && MP) MP.send("strike", "weapon", {w: w, q: myClock()});  // 0-4 (old Arenas clamp)
    say(W().name);
  }
  // Fire one shot: drawn at once; in a match the server says whether it hit.
  function fire(t){
    var wp = W(), e = eye();
    E.sfx("shot", {w: V.w});
    var mag = magOf(V.w);
    if(!(V.infUntil && t < V.infUntil)) mag[V.w === LAUNCH_W ? 0 : V.w]--;
    else mag[V.w === LAUNCH_W ? 0 : V.w] = wp.mag;
    var ivl = (V.overclockUntil && t < V.overclockUntil) ? wp.interval * 0.55 : wp.interval;
    V.nextShot = t + ivl; V.n++; V.shots++;
    V.flashAt = t; V.kick = calm() ? 0.15 : 1;
    V.protUntil = V.protUntil || 0; if(V.protUntil) V.protUntil = 0; // any shot drops your own spawn cover (strike.py:772)
    if(V.w === GRAPPLE_W){
      // the hook: no damage on any path. Server judges it in mp; we also predict the
      // swing / pull so the first frames feel right.
      var gd = FS.dirOf(V.yaw*180/Math.PI, clamp(V.pitch*180/Math.PI, -PITCH_MAX, PITCH_MAX));
      if(V.mode === "mp"){
        var gmsg = {w: GRAPPLE_W, ox: Math.round(e[0]*100), oy: Math.round(e[1]*100), oz: Math.round(e[2]*100),
                    r: Math.round(((V.yaw*180/Math.PI % 360) + 360) % 360*100), p: Math.round(V.pitch*180/Math.PI),
                    q: myClock(), ip: 0, e: V.life};
        if(V.k !== null){ gmsg.k = V.k; gmsg.kq = V.kq; }
        if(MP) MP.send("strike", "fire", gmsg);
      }
      fireGrapple(t, e, gd);
      if(magOf(V.w)[GRAPPLE_W] <= 0) startReload(t);
      return;
    }
    if(V.w === LAUNCH_W){
      // lob a real missile that flies and blasts — the server flies it in mp, we do solo
      var ld = FS.dirOf(V.yaw*180/Math.PI, V.pitch*180/Math.PI);
      if(V.mode === "mp"){
        var lmsg = {w: LAUNCH_W, ox: Math.round(e[0]*100), oy: Math.round(e[1]*100), oz: Math.round(e[2]*100),
                    r: Math.round(((V.yaw*180/Math.PI % 360) + 360) % 360*100), p: Math.round(V.pitch*180/Math.PI),
                    q: myClock(), ip: 0, e: V.life};
        if(V.k !== null){ lmsg.k = V.k; lmsg.kq = V.kq; }
        if(MP) MP.send("strike", "fire", lmsg);
        if(magOf(V.w)[0] <= 0) startReload(t);
        return;   // the "r" snapshot rows draw the rocket
      }
      spawnMissile(t, e, ld);
      if(R3 && R3.kick) R3.kick();
      if(mag[0] <= 0) startReload(t);
      return;
    }
    var sp = FS.spreadOf(V.n, V.w), yawD = V.yaw*180/Math.PI, pitD = V.pitch*180/Math.PI;
    // disaster scatter: grit in the sights / wild wind / EMP electronics — shared rule
    var scatterD = disAimScatter(t);
    var d = FS.dirOf(yawD + sp[0] + scatterD, clamp(pitD + sp[1] + scatterD * 0.6, -PITCH_MAX, PITCH_MAX));
    var reach = FS.rayMap(MAP, e, d, wp.range), end = reach, aimed = null, aimedHead = false;
    if(V.mode === "practice"){
      V.drones.forEach(function(D){
        if(D.downUntil > t) return;
        var c = dronePos(D, t - V.startAt), b = [c[0]-0.45, c[1]-0.45, c[2]-0.45, c[0]+0.45, c[1]+0.45, c[2]+0.45], h = FS.rayBox(e, d, b);
        if(h !== null && h < end){ end = h; aimed = D; }
      });
      if(aimed){ aimed.downUntil = t + 1.5; V.score++; V.hitAt = t; }
    } else if(V.mode === "bots"){
      if(V.protUntil) V.protUntil = 0; // firing drops your own spawn cover (strike.py:772)
      if(V.warden){
        var Wb = V.warden, boxesW = wardenBoxes(Wb), volW = wardenHitIndex(boxesW, e, d, end);
        if(volW >= 0){
          var hW = FS.rayBox(e, d, boxesW[volW]);
          if(hW != null && hW < end) end = hW;
          wardenHit(Wb, volW, wp.damage, t);
        }
        addTracer(e, [e[0] + d[0]*end, e[1] + d[1]*end, e[2] + d[2]*end], V.w, t, false);
        if(R3 && R3.kick) R3.kick();
        return;
      }
      others().forEach(function(P){
        if(!P.bot || P.dead || P.gone || P.team === V.team) return;
        if(botShielded(P, t)) return;  // the drop shield: your bullets bounce off a glider
        var h = FS.rayPlayer(e, d, P.x, P.y, P.z, end);
        if(h && h[0] < end){ end = h[0]; aimed = P; aimedHead = h[1]; }
      });
      if(aimed){
        var victims = [aimed], vh = [aimedHead];
        // Ghost Bullets: the shot keeps going and may hit one more body behind
        if((V.ghostLeft|0) > 0){
          V.ghostLeft--;
          var second = null, secondHead = false, secondEnd = end;
          others().forEach(function(P){
            if(P === aimed || !P.bot || P.dead || P.gone || P.team === V.team) return;
            if(botShielded(P, t)) return;
            var h2 = FS.rayPlayer(e, d, P.x, P.y, P.z, secondEnd);
            if(h2 && h2[0] < secondEnd){ secondEnd = h2[0]; second = P; secondHead = h2[1]; }
          });
          if(second){ victims.push(second); vh.push(secondHead); }
        }
        // Chain Lightning: one extra enemy near the impact
        if((V.chainLeft|0) > 0){
          V.chainLeft--;
          var near = null, nd = 1e9;
          others().forEach(function(P){
            if(victims.indexOf(P) >= 0 || !P.bot || P.dead || P.gone || P.team === V.team) return;
            var d2 = Math.hypot(P.x - aimed.x, P.z - aimed.z);
            if(d2 <= 8 && d2 < nd){ nd = d2; near = P; }
          });
          if(near){ victims.push(near); vh.push(false); }
        }
        // Ricochet: a second victim near the first
        if((V.ricoLeft|0) > 0){
          V.ricoLeft--;
          var near2 = null, nd2 = 1e9;
          others().forEach(function(P){
            if(victims.indexOf(P) >= 0 || !P.bot || P.dead || P.gone || P.team === V.team) return;
            var d2 = Math.hypot(P.x - aimed.x, P.z - aimed.z);
            if(d2 <= 7 && d2 < nd2){ nd2 = d2; near2 = P; }
          });
          if(near2){ victims.push(near2); vh.push(false); }
        }
        // Cluster Shot: a miss still tags up to 2 enemies near the impact
        if((V.clusterLeft|0) > 0 && victims.length === 0){
          V.clusterLeft--;
          var ex = e[0] + d[0]*end, ey = e[1] + d[1]*end, ez = e[2] + d[2]*end, got = 0;
          others().forEach(function(P){
            if(got >= 2 || !P.bot || P.dead || P.gone || P.team === V.team) return;
            if(Math.hypot(P.x - ex, P.z - ez) < 4.5){ victims.push(P); vh.push(false); got++; }
          });
        } else if((V.clusterLeft|0) > 0) V.clusterLeft--;
        for(var vi = 0; vi < victims.length; vi++){
          var tv = victims[vi], th = vh[vi];
          var dmg = th ? wp.head : wp.damage;
          // Fate Splitter: half the wound lands on the partner
          if(tv.fateUntil && t < tv.fateUntil && V.fateUid){
            var mateP = V.players[V.fateUid];
            if(mateP && mateP !== tv && !mateP.dead){
              var half = dmg/2|0;
              dmg -= half;
              mateP.hp -= half;
              if(mateP.hp <= 0 && !mateP.dead) endBotLife({uid: myId(), kills: V.kills, team: V.team, w: V.w, name: "You"}, mateP, t, false);
            }
          }
          tv.hp -= dmg;
          V.hitAt = t; if(th) V.headAt = t;
          V.dmgNums.push({x: tv.x, y: tv.y + (th ? 1.75 : 1.2), z: tv.z, n: dmg, head: th, at: t, o: null});
          if(V.dmgNums.length > 12) V.dmgNums.shift();
          if(tv.hp <= 0 && !tv.dead) endBotLife({uid: myId(), kills: V.kills, team: V.team, w: V.w, name: "You"}, tv, t, th);
          else say((th ? "Headshot" : "Hit")+" — "+tv.name+" ("+Math.max(0, tv.hp|0)+" hp)");
        }
      }
    } else {
      others().forEach(function(P){
        if(P.dead || P.gone || P.team === V.team) return;
        var h = FS.rayPlayer(e, d, P.x, P.y, P.z, end);
        if(h){ end = h[0]; aimed = P; }
      });
      // the delay you were seeing the others with: the target's if you aimed at one
      var avg = 0, n = 0; if(V.off !== null) others().forEach(function(P){ if(P.snaps.length){ avg += t - V.off - P.seen; n++; } });
      var ip = aimed && V.off !== null ? t - V.off - aimed.seen : n ? avg/n : INTERP;
      var msg = {w: V.w, ox: Math.round(e[0]*100), oy: Math.round(e[1]*100), oz: Math.round(e[2]*100),
                 r: Math.round(((yawD % 360) + 360) % 360*100), p: Math.round(pitD*100), q: myClock(), ip: Math.round(clamp(ip, 0, 1)*1000), e: V.life};
      if(V.k !== null){ msg.k = V.k; msg.kq = V.kq; }
      if(MP) MP.send("strike", "fire", msg);
    }
    addTracer(myMuzzle(), [e[0] + d[0]*end, e[1] + d[1]*end, e[2] + d[2]*end], V.w, t, true);
    if(magOf(V.w)[V.w === LAUNCH_W ? 0 : V.w] <= 0) startReload(t);
  }
  function addTracer(a, b, w, t, mine){
    V.tracers.push({a: a, b: b, w: w, at: t, mine: mine});
    if(V.tracers.length > 40) V.tracers.shift();
    if(R3) R3.tracer(a, b, w, mine);
  }

  /* ---------- the loop ---------- */
  var sendKeyAt = 0;
  function update(dt, t){
    if(!MAP) return;
    if(IN) IN.poll();
    var locked = !!(IN && IN.locked), focused = !!(canvas && document.activeElement === canvas);
    // the weapon wheel (hold Tab): turning consumes this frame's look so your aim stays put
    var wheelNow = !!(IN && !V.paused && !V.dead && !V.watch && IN.down("wheel") && (V.phase === "round" || (V.phase === "warmup" && V.mode !== "mp")));
    if(wheelNow !== V.wheelOpen){
      V.wheelOpen = wheelNow;
      if(wheelNow){ V.wheelSel = V.w; V.wheelLook = null; }
      else if(V.wheelSel >= 0) switchTo(V.wheelSel, t);
      renderWheel(t);
    }
    var playing = V.phase === "round" || V.phase === "warmup";
    pauseBox.classList.toggle("hidden", !(playing && !locked && !focused));
    V.paused = (V.mode === "practice" || V.mode === "bots") && ((playing && !locked && !focused) || !!V.hqPaused);
    if(IN && IN.pressed("help")){ var s = ssave(); s.keysHidden = !s.keysHidden; api.persist(); renderKeys(); }
    if(IN && IN.pressed("score")){ V.board = !V.board; renderBoard(); }
    if(IN && IN.pressed("items")){ V.guide = !V.guide; renderGuide(); }
    if(V.phase === "warmup"){
      var left = Math.ceil(V.goAt - t);
      if(left > 0 && left <= 5 && center.textContent !== String(left)){ flashCenter(String(left)); say(String(left)); }
      if((V.mode === "practice" || V.mode === "bots") && t >= V.goAt){
        V.phase = "round"; V.startAt = t;
        var goTxt = (V.mode === "bots" ? "Fight! " : "Go! ") + "Team " + TEAMS[V.team|0].n;
        flashCenter(goTxt); say(goTxt + ". Enemy names are red.");
        if(!V.warden && V.mode === "bots" && V.totemAt != null) V.totemAt = t + TOTEM_FIRST;   // the round's own clock: first totem in 8 s
        if(V.mode === "bots" && V.packAt != null) V.packAt = t + PACK_FIRST;      // …and the first loose pack in 6 s
        if(V.mode === "bots") V.disAt = t + DIS_FIRST_DROP;             // …and the first Disaster totem in 12 s
        V.eventAt = t + 45; V.fuseAt = t + 30; V.crateAt = t + 22;   // the 5 drop mechanics' own clocks
        V.disasterAt = t + DIS_FIRST;                                 // Wave D: auto-disaster in 30 s (counted down in the top bar)
      }
    }
    if((V.mode === "practice" || V.mode === "bots") && V.phase === "round"){
      if(V.paused){ V.endsAt += dt; V.startAt += dt; }
      else if(V.mode === "practice" && t >= V.endsAt) endPractice();
      else if(V.mode === "bots") botsRoundEnd(t);
    }
    if(V.mode === "bots"){ if(!V.paused){ botsStep(dt, t); botsRespawn(t); } } // pause freezes the bots too (offline only)
    // scope in: pure camera zoom (spread stays server-replayed — no desync). Hold right-click or the `~ key.
    V.ads = !!(IN && IN.down("aim") && !V.dead && !V.watch);
    // look (slower while scoped: a steadier aim)
    var look = LOOK*(V.ads ? 0.55 : 1);
    var lk = IN && !V.paused ? IN.look() : null;
    if(wheelNow && lk){
      // the mouse becomes the wedge selector; moving little stays on the current one,
      // the neutral center picks "cancel" (GTA's dead zone), anything else picks a wedge
      V.wheelLook = V.wheelLook || {x: 0, y: 0};
      V.wheelLook.x += lk.dx*2.2; V.wheelLook.y += lk.dy*2.2;
      var len = Math.hypot(V.wheelLook.x, V.wheelLook.y);
      if(len > 60){
        // the wedges sit centered on up/right/down/left; atan2's 0 is up, and a wedge's
        // center is its quadrant diagonal — the +π/4 nudges the diagonals into the right wedge
        var wn = Math.max(4, weaponCount());
        var a = Math.atan2(V.wheelLook.x, -V.wheelLook.y) + Math.PI/wn, seg = Math.floor(a/(Math.PI*2/wn));
        V.wheelSel = ((seg % wn) + wn) % wn;
      }
      renderWheel(t);
    } else if(lk){
      V.yaw += lk.dx*look; V.pitch = clamp(V.pitch - lk.dy*look, -PITCH_MAX*Math.PI/180, PITCH_MAX*Math.PI/180);
    }
    // lean: Q/E slide your eyes (and your gun) sideways out of cover — the camera rolls, and your
    // head goes with it, so what you can see and what can see you are the same thing
    var wantPeek = ((V.phase === "round" || ((V.mode === "practice" || V.mode === "bots") && V.phase === "warmup")) && IN && !V.paused && !V.dead && !V.watch
      ? (IN.down("peekR") ? 1 : 0) - (IN.down("peekL") ? 1 : 0) : 0);
    V.peek = V.peek || 0;
    V.peek += clamp(wantPeek - V.peek, -PEEK_SPEED*dt, PEEK_SPEED*dt);
    var canMove = !V.watch && !V.dead && !V.paused && (V.phase === "round" || ((V.mode === "practice" || V.mode === "bots") && V.phase === "warmup"));
    var ax = canMove && IN ? IN.axis("x") : 0, ay = canMove && IN ? IN.axis("y") : 0;
    var fx = Math.sin(V.yaw), fz = -Math.cos(V.yaw), rx = Math.cos(V.yaw), rz = Math.sin(V.yaw);
    var wx = fx*ay + rx*ax, wz = fz*ay + rz*ax, wl = Math.sqrt(wx*wx + wz*wz); if(wl > 1){ wx /= wl; wz /= wl; }
    var jump = canMove && IN && IN.down("jump");
    var leaping = !!(V.leapUntil && t < V.leapUntil);
    var winged = !!(V.wingsUntil && t < V.wingsUntil);
    // speed totem: plain WASD dashes at SPEED_MULT x sprint pace — no Shift held, no stamina
    // spent (the boost is its own window; the tank keeps refilling underneath it). v1/v2
    // arenas never granted the raised cap, so the boost stays off there like the sprint is
    var boosting = !!(V.speedUntil && t < V.speedUntil && sprintOK());
    // sprint: Shift (or stick click) while a movement key is held, only if this Arena allows it.
    // Stamina drains while sprinting; an empty tank keeps Shift moving at a crawl (SPRINT_SLOW)
    // and refills while you're not sprinting. Client-side only — the server sees raw speed.
    var moving = wl > 0.01;
    var nosprint = V.arenaEvent === "nosprint" && t < (V.arenaEventUntil || 0);
    // Wave D: Absolute Zero freezes the boots (no sprint, sliding acceleration),
    // Sandstorm doubles the stamina burn
    var zeroNow = (V.disaster === "absolutezero" && disLive(t));
    var sandNow = (V.disaster === "sandstorm" && disLive(t));
    if(zeroNow) nosprint = true;
    var sprintHold = canMove && !V.watch && IN && IN.down("sprint") && sprintOK() && !nosprint;
    var sprinting = !!(sprintHold && moving && V.stamina > 0);
    if(sprinting) V.stamina = Math.max(0, V.stamina - FS.STAMINA_DRAIN * (sandNow ? 2 : 1) * dt);
    else V.stamina = Math.min(FS.STAMINA_MAX, V.stamina + FS.STAMINA_REGEN*dt);
    // the speed totem needs none of the tank: while it runs, plain movement key IS a dash
    if(boosting){ sprinting = true; V.stamina = Math.min(FS.STAMINA_MAX, V.stamina + FS.STAMINA_REGEN*dt); }
    // latch the drag: at a 0.09 m/s crawl wl must not flicker the state with stick noise
    V.drag = !!(V.drag || (sprintHold && moving && V.stamina <= 0)) && !!(sprintHold && V.stamina <= 0);
    var dragging = V.drag;
    V.sprinting = sprinting;
    // slide: a grounded sprint's camera dips then settles; pure cosmetics, decays on landing or stop
    V.slideK = clamp(V.slideK + (sprinting && V.me.g ? SLIDE_RISE*dt : -SLIDE_FALL*dt), 0, 1);
    V.slideRoll = V.slideK*0.05;
    if(V.phase !== "idle" && V.phase !== "done" && !V.dead){
      // v4: a drop owns the body's descent — glide left/right at DROP_DRIFT and sink gently,
      // no FS.move gravity/sprint/jump. Touching down (or the window closing) lands you.
      var dropping = !!(dropOK() && V.dropUntil && t < V.dropUntil && !V.me.g);
      // the wings totem flies on its own tallies up: takeoff is automatic the moment you
      // take the totem, cruising is WASD drift at WING_DRIFT with no rise/sink input, and
      // the window's end starts a gentle automatic glide to the ground (no Space needed).
      // Server-side the window covers all of it: rise + cruise + the descent to floor.
      // the body is "flying" whenever the window runs OR the window ended and you're still
      // midair working your way back down from the cruise altitude.
      var flying = !!((winged || (V.wingsUntil && t >= V.wingsUntil && !V.me.g)) && !dropping);
      if(flying){
        var floor = FS.topUnder(MAP, V.me.x, V.me.z, V.me.y); if(floor == null) floor = 0;
        // rise automatically toward WING_TOP while the window runs; glide back down to the
        // floor when it's over. drift horizontally with WASD the whole time.
        var fy = winged ? Math.min(V.me.y + FS.WING_RISE*dt, FS.WING_TOP)
                        : Math.max(floor, V.me.y - FS.WING_SINK*dt);
        var fx = V.me.x + (wx * FS.WING_DRIFT)*dt, fz = V.me.z + (wz * FS.WING_DRIFT)*dt;
        if(FS.overlaps(MAP, fx, fy, fz, 0) < 0){ V.me.x = fx; V.me.z = fz; }   // walls stop a flyer
        if(!winged && fy <= floor){ V.me.y = floor; V.me.vy = 0; V.me.g = true; V.wingsUntil = 0; } // landed — all the way down
        else V.me.y = fy;
        V.me.g = false;   // a flyer is airborne by definition, even at takeoff floor
        V.me.vy = 0;
        acc = 0;
      }
      // drone-hook swing: climb to the hook height like the wings totem (ease, not a snap),
      // keep the long leap on XZ, and let jump / sprint drop you off the line.
      var swinging = !!(V.swingUntil && t < V.swingUntil && !dropping && !V.dead);
      if(swinging && (jump || (sprintHold && moving))){ V.swingUntil = 0; swinging = false; }
      if(swinging){
        var gT = (V.swingY > 0) ? V.swingY : DRONE_Y_FALLBACK();
        var gy = V.me.y < gT ? Math.min(V.me.y + (FS.GRAPPLE_RISE || 4)*dt, gT)
                             : Math.max(gT, V.me.y - (FS.GRAPPLE_RISE || 4)*dt*0.5);
        var gnx = V.me.x + V.me.vx*dt, gnz = V.me.z + V.me.vz*dt;
        if(FS.overlaps(MAP, gnx, gy, gnz, 0) < 0){ V.me.x = gnx; V.me.z = gnz; }
        else { V.me.vx = 0; V.me.vz = 0; }
        V.me.y = gy;
        V.me.g = false;
        V.me.vy = 0;
        acc = 0;
      }
      if(dropping){
        var floor = FS.topUnder(MAP, V.me.x, V.me.z, V.me.y);
        if(floor == null) floor = -1e9;   // a gap under the canopy: keep sinking into the void clock
        V.me.y = Math.max(floor, V.me.y - FS.DROP_SINK*dt);
        if(V.me.y <= floor && floor > -1e8){ V.me.g = true; V.dropUntil = 0; V.protUntil = t + 1.5; }
        else {
          V.me.x += (wx * FS.DROP_DRIFT)*dt;
          V.me.z += (wz * FS.DROP_DRIFT)*dt;
        }
        acc = 0;
      } else if(V.dropUntil && t >= V.dropUntil){ V.dropUntil = 0; }
      if(!dropping && !flying && !swinging){
        acc += dt;
        // the drag must bite at once: scaling only the wish leaves a drained 8.1 m/s sprint
        // coasting at ~walk speed for half a second. Clamp velocity to the crawl cap directly.
        if(dragging){
          var dTop = FS.RUN*FS.SPRINT_SLOW, dSpd = Math.sqrt(V.me.vx*V.me.vx + V.me.vz*V.me.vz);
          if(dSpd > dTop){ V.me.vx *= dTop/dSpd; V.me.vz *= dTop/dSpd; }  // bite: drop to the crawl AT the drain
        }
        var mwx = dragging ? wx*FS.SPRINT_SLOW : wx, mwz = dragging ? wz*FS.SPRINT_SLOW : wz;
        // Blink Dash: the next few jumps are a 6 m hop instead of a jump
        if(jump && (V.blinkLeft|0) > 0){
          V.blinkLeft--;
          jump = false;
          var bx = V.me.x + Math.sin(V.yaw)*6, bz = V.me.z - Math.cos(V.yaw)*6;
          if(FS.overlaps(MAP, bx, V.me.y, bz, 0) < 0){ V.me.x = bx; V.me.z = bz; V.me.vx = 0; V.me.vz = 0; }
        }
        var lowg = V.arenaEvent === "lowg" && t < (V.arenaEventUntil || 0);
        var gMult = ((V.gravUntil && t < V.gravUntil) || lowg) ? 0.42 : 1;
        // Absolute Zero: the ground is ice — acceleration crawls and you keep sliding.
        // Slowness from a disaster (quake throw, toxic choke, pit stumble, wind footing)
        // stacks the same way: the slowest wins.
        var slowNow = !!(V.slowUntil && t < V.slowUntil);
        var topMult = zeroNow ? 0.55 : (slowNow ? DD_SLOW_MULT : 1);
        // Hurricane: a wind column shoves anyone it reaches (both teams, bots too)
        if(V.disaster === "hurricane" && disLive(t) && !meShielded(t)){
          var spanH = Math.max(0.1, (V.disasterUntil - V.disasterWarnAt));
          var uH = clamp((t - V.disasterWarnAt) / spanH, 0, 1);
          var bH = MAP.bounds;
          var wxH = (bH[0] + hashMatch(V.disasterSeed|0, 21) * (bH[3] - bH[0])) * (1 - uH) +
                    (bH[0] + hashMatch(V.disasterSeed|0, 23) * (bH[3] - bH[0])) * uH;
          var wzH = (bH[2] + hashMatch(V.disasterSeed|0, 22) * (bH[5] - bH[2])) * (1 - uH) +
                    (bH[2] + hashMatch(V.disasterSeed|0, 24) * (bH[5] - bH[2])) * uH;
          var ddxH = V.me.x - wxH, ddzH = V.me.z - wzH, ddH = Math.hypot(ddxH, ddzH);
          if(ddH < DD_WIND_R){
            var lnH = Math.max(0.05, ddH);
            var shoveH = DD_WIND_PUSH * (1 - ddH / DD_WIND_R) * dt;
            V.me.x += (ddxH / lnH) * shoveH;
            V.me.z += (ddzH / lnH) * shoveH;
            V.slowUntil = Math.max(V.slowUntil|0, t + DD_WIND_SLOW);   // loose footing
          }
        }
        var jMult = leaping ? FS.LEAP_MULT : ((V.wallrunUntil && t < V.wallrunUntil) ? 1.35 : 1);
        while(acc >= STEP){ FS.move(MAP, V.me, mwx, mwz, jump, STEP, sprinting, (boosting ? FS.SPEED_MULT : 1) * topMult, jMult, gMult); acc -= STEP; }
        // Void rescue: fell off the map / through a floor gap / wings flew past the
        // bounds. Nothing can kill you out here (and you can't shoot yourself), so the
        // clock is the only way home: VOID_SECS later you parachute back in. Solo the
        // client is the judge; MP the Arena runs the same clock and emits the spawn.
        if(FS.inVoid(MAP, V.me.x, V.me.y, V.me.z)){
          if(!V.voidAt){ V.voidAt = t; say("Out of bounds — back in "+FS.VOID_SECS+"s"); }
          else if(t - V.voidAt >= FS.VOID_SECS && V.mode !== "mp"){
            V.voidAt = 0;
            if(dropOK()) dropSpawn(V.mySlot != null ? V.mySlot : 0);
            else {
              var spV = botSpawnFor({team: V.team, slot: V.mySlot != null ? V.mySlot : 0});
              placeMe(spV[0], spV[1], spV[2], spV[3]);
            }
            V.dead = false; V.hp = 100; fullAmmo(); V.killCam = null;
            V.protUntil = (V.dropUntil && V.dropUntil > t) ? 0 : t + 1.5;
            say("Back in — soft landing under the canopy.");
          }
        } else if(V.voidAt){ V.voidAt = 0; }
        // a short trail for Time Rewind (and the kill cam already samples hist on bots)
        V.hist = V.hist || [];
        V.hist.push([V.me.x, V.me.y, V.me.z]);
        if(V.hist.length > 40) V.hist.shift();
      }
    } else acc = 0;
    var spd = Math.sqrt(V.me.vx*V.me.vx + V.me.vz*V.me.vz);
    V.bob += spd*dt*(sprinting ? 2.1 : 1.6);
    // weapons
    finishReload(t);
    if(IN && !V.paused && !V.dead && !V.watch && !wheelNow){
      if(IN.pressed("w1")) switchTo(0, t);
      if(IN.pressed("w2")) switchTo(1, t);
      if(IN.pressed("w3")) switchTo(2, t);
      if(IN.pressed("w4")) switchTo(3, t);  // solo-only: no-op in mp (switchTo clamps to the shared roster)
      if(IN.pressed("w5")) switchTo(4, t);  // the grappling gun (players only)
      // cycle: next, wrapping past the end (wheel is directional: down = next, up = previous)
      if(IN.pressed("swap")) switchTo((V.w + 1) % weaponCount(), t);
      var wh = IN.wheel(); if(wh){ switchTo((V.w + (wh > 0 ? 1 : weaponCount() - 1)) % weaponCount(), t); }
      if(IN.pressed("reload")) startReload(t);
      var trig = (IN.mouse[0] && locked) || IN.down("shoot") || IN.down("trig");
      var want = (W().auto ? trig : trig && !V.trigWas)
        && !(V.w === LAUNCH_W && (V.missiles.length > 0 || (V.mode === "mp" && t < V.nextLaunchAt)));  // one rocket in the air at a time
      if(V.w === LAUNCH_W && want && canShoot(t)) V.nextLaunchAt = t + 0.9;   // covers the launch gap before the snapshot carries it
      V.trigWas = trig;
      if(want && canShoot(t)) fire(t);
      else if(want && magOf(V.w)[V.w === LAUNCH_W ? 0 : V.w] <= 0 && !V.reloadAt) startReload(t);
    }
    // grappling-gun drag on you: haul toward the hooker (server "hk" row / local apply)
    if(V.hookUntil && t < V.hookUntil && V.hookPull && !V.dead){
      var hdx = V.hookPull[0] - V.me.x, hdz = V.hookPull[1] - V.me.z;
      var hd = Math.sqrt(hdx*hdx + hdz*hdz) || 1;
      var hsp = Math.min(FS.GRAPPLE_PULL || 18, hd * 4);
      V.me.vx = hdx/hd*hsp; V.me.vz = hdz/hd*hsp;
      if(hd < 1.2){ V.hookPull = null; }
    }
    V.kick = Math.max(0, V.kick - dt*8);
    missilesStep(t, dt);   // solo: flies them; mp: only renders the server's "r" rows
    // pickups (offline: refilled locally; online the server decides)
    if((V.mode === "practice" || V.mode === "bots") && V.phase === "round") MAP.pickups.forEach(function(pk, i){
      if(!V.items[i]) return;
      // horizontal only: drops land at y=0 and a ledge/crate taker is still standing over it
      // (the old 1.2 m Y window rejected every ground drop from Wave B high grounds)
      if(Math.abs(V.me.x - pk.at[0]) > 1.1 || Math.abs(V.me.z - pk.at[2]) > 1.1) return;
      if(pk.at[1] > 1.5 && Math.abs(V.me.y - pk.at[1]) > 2.2) return;
      var knd = (V.kinds && V.kinds[i]) || (pk.kind === "health" || pk.kind === "ammo" ? pk.kind : (pk.id && pk.id[0] === "h" ? "health" : "ammo"));
      if(knd === "ammo"){
        var full = FS.WEAPONS.every(function(wp, wi){ return resOf(wi)[wi === LAUNCH_W ? 0 : wi] >= wp.reserve*2; }); if(full) return;
        V.res = FS.WEAPONS.map(function(wp, wi){ return Math.min(wp.reserve*2, V.res[wi] + wp.pack); });
        V.resX = [Math.min(FS.LAUNCH.reserve*2, V.resX[0] + FS.LAUNCH.pack)]; say("Ammo pack");
      } else if(knd === "health"){
        if(V.hp >= 100) return;
        V.hp = Math.min(100, V.hp + 50); say("Health pack: "+V.hp); // HEAL = 50 (strike.py)
      } else if(TOTEMS[knd]){
        // totem effects are one-shot; the solo client applies them right here, MP comes
        // via the server's "pick" event (same shape, judged server-side)
        // Cursed Drop: the power is the same, but the taker pays 15 hp up front
        if(V.cursed && V.cursed[i]){
          V.hp = Math.max(1, V.hp - 15);
          say("Cursed Drop: -15 hp");
        }
        var msg = totemApply(knd, myId(), t);
        if(!msg) return; // nothing eligible (e.g. a mole with no enemy bots left)
        say(msg);
      } else return;
      feedItem("You", V.team, knd, t);
      // a taken drop slot doesn't come back in place (the drop clock replaces it);
      // a map pack does come back — but on a fresh random spot, never the pad you took
      V.items[i] = 0;
      if(i < BASE_PACKS){ V.itemBack = V.itemBack || {}; V.itemBack[i] = t + 15; }
    });
    // taken packs come back: practice refills them all, bot matches refill the map's own
    // packs (the drop-ring slots never respawn in place — the drop clocks replace them).
    // Every return re-rolls the spot so camping a pad pays nothing.
    if(V.itemBack) Object.keys(V.itemBack).forEach(function(i){
      if(t >= V.itemBack[i] && (V.mode === "practice" || (+i < BASE_PACKS))){
        var ii = +i;
        if(ii < BASE_PACKS) placeDrop(ii, ((((t*1000)|0) * 2654435761) + (ii+1)*0x9e3779b9 + 17) >>> 0);
        V.items[ii] = 1; delete V.itemBack[i];
      }
    });
    // the two drop clocks, independent of each other: a fresh random totem every TOTEM_GAP
    // (mole only with bots) and a fresh random health/ammo pack every PACK_GAP. Each new
    // drop replaces the oldest slot of its ring — taken or not, drops keep coming.
    if(!V.warden && V.mode === "bots" && V.phase === "round" && V.totemAt != null && t >= V.totemAt){
      V.totemAt = t + TOTEM_GAP;
      var anyBot = others().some(function(P){ return P.bot && !P.gone; });
      var seed = ((Math.floor(t*1000) ^ (V.mySlot|0)) >>> 0);
      var idx = totemSpawn(seed, anyBot);
      V.items[idx] = 1; if(V.itemBack) delete V.itemBack[idx];
      V.kinds[idx] = MAP.pickups[idx].kind;
      if(R3) R3.addTotem(idx, MAP.pickups[idx]);
    }
    if(!V.warden && V.mode === "bots" && V.phase === "round" && V.disAt != null && t >= V.disAt){
      V.disAt = t + DIS_GAP_DROP;
      var dseed = ((Math.floor(t*1000) ^ ((V.mySlot|0) + 77)) >>> 0);
      var didx = disasterSpawn(dseed);
      V.items[didx] = 1; if(V.itemBack) delete V.itemBack[didx];
      V.kinds[didx] = MAP.pickups[didx].kind;
      if(R3) R3.addTotem(didx, MAP.pickups[didx]);
      say("A Disaster totem just landed — grab it and the whole arena is in it");
    }
    if(!V.warden && V.mode === "bots" && V.phase === "round" && V.packAt != null && t >= V.packAt){
      V.packAt = t + PACK_GAP;
      var pseed = ((Math.floor(t*1000)*31 ^ (V.mySlot|0)) >>> 0);
      var pidx = packSpawn(pseed);
      V.items[pidx] = 1; if(V.itemBack) delete V.itemBack[pidx];
      V.kinds[pidx] = "";
      if(R3) R3.addPack(pidx, MAP.pickups[pidx]);
    }
    others().forEach(function(P){ sampleSnaps(P, t, dt); });
    if(!V.watch) sendPos(t);
    if(V.dead && (V.mode === "mp" || V.mode === "bots")){
      if(V.killCam && (!V.killCam.ref || V.killCam.ref.gone || V.killCam.ref.dead)) V.killCam = null;
      var rl = Math.max(0, Math.ceil(V.deadAt + RESPAWN - t)); var txt = rl > 0 ? "Respawning in "+rl : "Respawning…";
      if(V.killCam && V.killCam.name) txt = V.killCam.name+"'s view — "+txt;
      if(center.textContent !== txt){ center.textContent = txt; center.classList.remove("hidden"); center.dataset.until = ""; } }
    // a free-fall past the map is not a death — it's a 10s void clock, then a parachute back
    if(!V.dead && V.mode !== "mp" && V.voidAt && V.phase === "round"){
      var vl = Math.max(0, Math.ceil(V.voidAt + FS.VOID_SECS - t));
      var vtxt = vl > 0 ? "Out of bounds — back in "+vl+"s" : "Pulling you back…";
      if(center.textContent !== vtxt){ center.textContent = vtxt; center.classList.remove("hidden"); center.dataset.until = ""; }
    }
    if(V.dead && V.mode === "bots" && t >= (V.deadAt || 0) + RESPAWN){
      var dropping = false;
      if(dropOK()){ dropping = !!dropSpawn(V.mySlot != null ? V.mySlot : 0); }
      else { var sp = botSpawnFor({team: V.team, slot: V.mySlot != null ? V.mySlot : 0}); placeMe(sp[0], sp[1], sp[2], sp[3]); }
      V.dead = false; V.hp = 100; fullAmmo(); V.killCam = null;
      // PROTECT (strike.py): 1.5 s of ground cover — but a glide takes DROP_TIME, so the
      // clock starts only once your boots touch, or you'd land with the cover already gone
      V.protUntil = dropping ? 0 : t + 1.5;
      center.classList.add("hidden"); say(dropOK() && V.dropUntil > t ? "Glide down: WASD to steer, soft landing at the bottom." : "You're back in.");
    }
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
    // v3+: the sprint flag that earns this position the raised speed cap. Omit it
    // off so a v1/v2 Arena's referee sees exactly the shape it already knows.
    if(V.sprinting && sprintOK()) msg.sp = true;
    if(V.k !== null){ msg.k = V.k; msg.kq = V.kq; }
    MP.send("strike", "pos", msg);
  }
  function flashCenter(txt){ center.textContent = txt; center.classList.remove("hidden"); center.dataset.until = String(now() + 1.0); }

  // Wave C solo world upkeep: chaos pulses, mines, meteors, and the fate link expiry.
  // In MP the server judges all of this and the snapshot carries the result; here the
  // local client is the referee, so the same windows fire the same blasts.
  function worldTick(dt, t){
    if(V.mode === "mp") return;   // the server's tick owns these; the snapshot carries them
    wardenTick(dt, t);
    // Chaos Core: a free blast every 1.5s
    if(V.chaosUntil && t < V.chaosUntil && t >= (V.chaosNext|0)){
      V.chaosNext = t + 1.5;
      V.booms = V.booms || [];
      V.booms.push({x: V.me.x, y: V.me.y + 0.5, z: V.me.z, at: t});
      others().forEach(function(P){
        if(P.dead || P.gone || P.team === V.team) return;
        if(Math.hypot(P.x - V.me.x, P.z - V.me.z) > 3.5) return;
        P.hp -= 20;
        if(P.hp <= 0 && !P.dead) endBotLife({uid: myId(), kills: V.kills, team: V.team, w: V.w, name: "You"}, P, t, false);
      });
    }
    // Trapmaster mines
    if(V.mines && V.mines.length){
      for(var mi = V.mines.length - 1; mi >= 0; mi--){
        var Mn = V.mines[mi];
        var tripped = false;
        others().forEach(function(P){
          if(tripped || P.dead || P.gone || P.team === Mn.team) return;
          if(Math.hypot(P.x - Mn.x, P.z - Mn.z) < 1.3){ tripped = true; P.hp -= 60;
            if(P.hp <= 0 && !P.dead) endBotLife({uid: myId(), kills: V.kills, team: V.team, w: V.w, name: "You"}, P, t, false); }
        });
        if(tripped){
          V.booms = V.booms || []; V.booms.push({x: Mn.x, y: 0.1, z: Mn.z, at: t});
          V.mines.splice(mi, 1);
        }
      }
    }
    // Meteor Call: warn, then hit
    if(V.meteors && V.meteors.length){
      for(var ei = V.meteors.length - 1; ei >= 0; ei--){
        var M = V.meteors[ei];
        if(t < (M.hitAt || 0)) continue;
        V.booms = V.booms || []; V.booms.push({x: M.x, y: 0.3, z: M.z, at: t});
        others().forEach(function(P){
          if(P.dead || P.gone) return;
          if(P.uid === M.owner) return;
          if(Math.hypot(P.x - M.x, P.z - M.z) > 5) return;
          P.hp -= 80;
          if(P.hp <= 0 && !P.dead) endBotLife({uid: myId(), kills: V.kills, team: V.team, w: V.w, name: "You"}, P, t, false);
        });
        V.meteors.splice(ei, 1);
      }
    }
    // ---- the 5 drop mechanics the server owns in MP; solo runs them right here ----
    if(V.mode === "bots" && V.phase === "round"){
      // Arena Events: warn then hold (lowg / storm / nosprint), every 45s
      V.eventAt = V.eventAt || 0;
      if(t >= V.eventAt){
        V.eventAt = t + 45;
        V.worldK = (V.worldK|0) + 1;
        var ePick = ((V.worldK * 2654435761) >>> 0) % 3;
        var eKind = ["lowg", "storm", "nosprint"][ePick];
        V.arenaEvent = eKind; V.arenaEventUntil = t + 3 + 12;
        var eN2 = {lowg: "Low Gravity", storm: "Sandstorm", nosprint: "No Sprint"};
        say(eN2[eKind] + " in 3s — lasts 12s");
      }
      if(V.arenaEvent && t >= V.arenaEventUntil){ V.arenaEvent = ""; V.arenaEventUntil = 0; say("Arena event over"); }
      // Totem Fusion: two unclaimed totems within 3m merge into one Chaos Core
      V.fuseAt = V.fuseAt || 0;
      if(t >= V.fuseAt){
        V.fuseAt = t + 18;
        var plF = dropPlan();
        var fused = false;
        for(var fx = 0; fx < DROP_SLOTS && !fused; fx++){
          var fxI = plF.totems[0] + fx;
          if(!V.items[fxI] || !V.kinds || !V.kinds[fxI]) continue;
          for(var fy = fx + 1; fy < DROP_SLOTS && !fused; fy++){
            var fyI = plF.totems[0] + fy;
            if(!V.items[fyI] || !V.kinds[fyI]) continue;
            var aF = MAP.pickups[fxI] && MAP.pickups[fxI].at, bF = MAP.pickups[fyI] && MAP.pickups[fyI].at;
            if(!aF || !bF) continue;
            if(Math.hypot(aF[0] - bF[0], aF[2] - bF[2]) > 3) continue;
            V.kinds[fxI] = "chaos"; MAP.pickups[fxI].kind = "chaos"; MAP.pickups[fxI].id = "chaos-" + fxI;
            V.kinds[fyI] = ""; V.items[fyI] = 0;
            if(R3) R3.addTotem(fxI, MAP.pickups[fxI]);
            fused = true; say("Totem Fusion: a Chaos Core just formed");
          }
        }
      }
      // ---- Wave D: Arena Disasters (solo runs them; MP the server judges) ----
      // Only an ARMED clock fires: 0/null means "not scheduled yet", never "fire now".
      // (V.disasterAt is set at round start to t + DIS_FIRST, and refreshed by di[4] in MP.)
      if(!V.warden && !V.disaster && V.disasterAt != null && V.disasterAt > 0 && t >= V.disasterAt){
        V.disasterAt = t + DIS_GAP;
        V.worldK = (V.worldK|0) + 1;
        disStart(DISASTERS[disKind(V.worldK|0, 11, DISASTERS.length)], t);
      }
      if(V.disaster && t >= (V.disasterUntil || 0)) disClear(t);
      if(V.disaster && disLive(t)){
        var dis = V.disaster, dHitAt = V.disasterHitAt || 0;
        // impact system: warning marker, then a radial hit. Meteor / Thunder come from
        // the sky and a shed roof stops them; a quake is the floor.
        if(dis === "meteorshower" || dis === "thunder" || dis === "earthquake"){
          var gapD = dis === "meteorshower" ? DD_METEOR_GAP : (dis === "thunder" ? DD_THUNDER_GAP : DD_QUAKE_GAP);
          var warnD = dis === "meteorshower" ? DD_METEOR_WARN : (dis === "thunder" ? DD_THUNDER_WARN : DD_QUAKE_WARN);
          var rD = dis === "meteorshower" ? DD_METEOR_R : (dis === "thunder" ? DD_THUNDER_R : DD_QUAKE_R);
          var dmgD = dis === "meteorshower" ? DD_METEOR_DMG : (dis === "thunder" ? DD_THUNDER_DMG : DD_QUAKE_DMG);
          var ohD = (dis !== "earthquake");
          if(t >= dHitAt){
            V.disasterHitAt = t + gapD;
            V.disasterMarkK = (V.disasterMarkK|0) + 1;
            // Aim every 3rd mark at a live body (hashed offset) so a shower can connect;
            // the rest scatter from the frozen disaster seed. Twin: disaster_tick in strike.rs.
            var ptsD = liveSpots(), spotD;
            if(ptsD.length && (V.disasterMarkK % 3) === 1){
              var bpD = ptsD[V.disasterMarkK % ptsD.length];
              spotD = [
                bpD[0] + (hashMatch(V.disasterSeed|0, 500 + V.disasterMarkK) - 0.5) * 4,
                0,
                bpD[1] + (hashMatch(V.disasterSeed|0, 600 + V.disasterMarkK) - 0.5) * 4
              ];
            } else {
              spotD = disSpot((Math.imul(V.disasterSeed|0, 2654435761) + 13) >>> 0, 7 + V.disasterMarkK);
            }
            V.disasterMarks.push({id: (V.worldK|0) + V.disasterMarkK, x: spotD[0], z: spotD[2], hitAt: t + warnD, r: rD, oh: ohD, dmg: dmgD, dis: dis});
          }
          for(var dmI = V.disasterMarks.length - 1; dmI >= 0; dmI--){
            var Mk = V.disasterMarks[dmI];
            if(t < (Mk.hitAt || 0)) continue;
            V.booms = V.booms || []; V.booms.push({x: Mk.x, y: 0.3, z: Mk.z, at: t});
            V.shakeAt = t;   // the ground jumps under the blast
            // the local player — proximity crush (markDamage): more damage near the strike
            var ddMe = Math.hypot(V.me.x - Mk.x, V.me.z - Mk.z);
            if(!meShielded(t) && ddMe <= Mk.r
               && !(Mk.oh && hasRoof(V.me.x, V.me.y, V.me.z))){
              V.hp -= FS.markDamage(ddMe, Mk.r, Mk.dmg|0);
              if(V.hp <= 0 && !V.dead) endBotLife(null, null, t, false, Mk.dis);
              // the flash and the blast: a bolt under your feet whites out the view
              if(Mk.dis === "thunder"){ V.blindUntil = Math.max(V.blindUntil|0, t + DD_THUNDER_BLIND); }
              else if(Mk.dis === "meteorshower"){ V.blindUntil = Math.max(V.blindUntil|0, t + DD_METEOR_BLIND); }
              else if(Mk.dis === "earthquake"){ V.slowUntil = Math.max(V.slowUntil|0, t + DD_QUAKE_SLOW); }
            }
            // bots
            others().forEach(function(P){
              if(P.dead || P.gone || botShielded(P, t)) return;
              var ddP = Math.hypot(P.x - Mk.x, P.z - Mk.z);
              if(ddP > Mk.r) return;
              if(Mk.oh && hasRoof(P.x, P.y, P.z)) return;
              P.hp -= FS.markDamage(ddP, Mk.r, Mk.dmg|0);
              if(P.hp <= 0 && !P.dead) endBotLife(null, P, t, false, Mk.dis);
              if(Mk.dis === "thunder") P.blindUntil = Math.max(P.blindUntil|0, t + DD_THUNDER_BLIND);
              else if(Mk.dis === "meteorshower") P.blindUntil = Math.max(P.blindUntil|0, t + DD_METEOR_BLIND);
              else if(Mk.dis === "earthquake") P.slowUntil = Math.max(P.slowUntil|0, t + DD_QUAKE_SLOW);
            });
            V.disasterMarks.splice(dmI, 1);
          }
        }
        // Shockwave Apocalypse: one expanding wave from the centre, knocks and hurts once each
        if(dis === "shockring"){
          var spanS = Math.max(0.1, (V.disasterUntil - V.disasterWarnAt));
          var uS = clamp((t - V.disasterWarnAt) / spanS, 0, 1);
          V.disasterRing = DD_SHOCK_R * uS;
          var bS = MAP.bounds, oxS = (bS[0] + bS[3]) / 2, ozS = (bS[2] + bS[5]) / 2;
          var ddS = Math.hypot(V.me.x - oxS, V.me.z - ozS);
          if(!V.disasterHit["me"] && meShielded(t) === false && Math.abs(ddS - V.disasterRing) <= 1.6){
            V.disasterHit["me"] = 1;
            var lnS = Math.max(0.05, ddS);
            V.me.x += ((V.me.x - oxS) / lnS) * DD_SHOCK_KNOCK;
            V.me.z += ((V.me.z - ozS) / lnS) * DD_SHOCK_KNOCK;
            V.hp -= DD_SHOCK_DMG;
            V.shakeAt = t;
            V.blindUntil = Math.max(V.blindUntil|0, t + DD_SHOCK_BLIND);   // the blast knocks the wind out of you
            if(V.hp <= 0 && !V.dead) endBotLife(null, null, t, false, dis);
          }
          others().forEach(function(P){
            if(P.dead || P.gone || botShielded(P, t) || V.disasterHit[P.uid]) return;
            var ddP = Math.hypot(P.x - oxS, P.z - ozS);
            if(Math.abs(ddP - V.disasterRing) > 1.6) return;
            V.disasterHit[P.uid] = 1;
            var lnP = Math.max(0.05, ddP);
            P.x += ((P.x - oxS) / lnP) * DD_SHOCK_KNOCK;
            P.z += ((P.z - ozS) / lnP) * DD_SHOCK_KNOCK;
            P.hp -= DD_SHOCK_DMG;
            P.blindUntil = Math.max(P.blindUntil|0, t + DD_SHOCK_BLIND);   // the blast knocks the wind out of you
            if(P.hp <= 0 && !P.dead) endBotLife(null, P, t, false, dis);
          });
        }
        // Toxic Fog / Sinkhole: standing zones that pulse once a second
        if((dis === "toxicfog" || dis === "sinkhole") && t >= dHitAt){
          V.disasterHitAt = t + 1.0;
          if(dis === "toxicfog"){
            // the green gas fills the whole arena — everyone out in it chips
            if(!meShielded(t) && !(V.protUntil && t < V.protUntil)){
              V.hp -= DD_TOXIC_CHIP_DMG;
              if(V.hp <= 0 && !V.dead) endBotLife(null, null, t, false, dis);
            }
            others().forEach(function(Pc){
              if(Pc.dead || Pc.gone || botShielded(Pc, t) || (Pc.protUntil && t < Pc.protUntil)) return;
              Pc.hp -= DD_TOXIC_CHIP_DMG;
              if(Pc.hp <= 0 && !Pc.dead) endBotLife(null, Pc, t, false, dis);
            });
            // sticky clouds frozen at disStart — the same centres R.disaster paints
            var zonesT = V.disasterZones && V.disasterZones.length
              ? V.disasterZones
              : disZonesNear(V.disasterSeed|0, DD_TOXIC_ZONES, liveSpots());
            for(var tz = 0; tz < zonesT.length; tz++){
              var zspot = zonesT[tz];
              if(!meShielded(t) && Math.hypot(V.me.x - zspot[0], V.me.z - zspot[1]) <= DD_TOXIC_R){
                V.hp -= DD_TOXIC_DMG;
                V.slowUntil = Math.max(V.slowUntil|0, t + DD_TOXIC_SLOW);   // choking
                if(V.hp <= 0 && !V.dead) endBotLife(null, null, t, false, dis);
              }
              others().forEach(function(P){
                if(P.dead || P.gone || botShielded(P, t)) return;
                if(Math.hypot(P.x - zspot[0], P.z - zspot[1]) > DD_TOXIC_R) return;
                P.hp -= DD_TOXIC_DMG;
                P.slowUntil = Math.max(P.slowUntil|0, t + DD_TOXIC_SLOW);
                if(P.hp <= 0 && !P.dead) endBotLife(null, P, t, false, dis);
              });
            }
          } else {
            // the pit the FX painted is the pit that pulls
            var sspot = (V.disasterPit && V.disasterPit.length === 2)
              ? V.disasterPit
              : disSpot((Math.imul(V.disasterSeed|0, 2654435761) + 47) >>> 0, 5);
            var ddxS = sspot[0] - V.me.x, ddzS = sspot[1] - V.me.z, ddSS = Math.hypot(ddxS, ddzS);
            if(!meShielded(t) && ddSS < DD_SINK_R * 1.4){
              var lnSS = Math.max(0.05, ddSS);
              var pullS = DD_SINK_PULL * (1 - Math.min(1, ddSS / (DD_SINK_R * 1.4))) * dt;
              V.me.x += (ddxS / lnSS) * pullS;
              V.me.z += (ddzS / lnSS) * pullS;
              V.slowUntil = Math.max(V.slowUntil|0, t + DD_SINK_SLOW);   // stumbling toward the pit
              if(ddSS < DD_SINK_R){
                V.hp -= DD_SINK_DMG;
                if(V.hp <= 0 && !V.dead) endBotLife(null, null, t, false, dis);
              }
            }
            others().forEach(function(P){
              if(P.dead || P.gone || botShielded(P, t)) return;
              var ddxP = sspot[0] - P.x, ddzP = sspot[1] - P.z, ddPP = Math.hypot(ddxP, ddzP);
              if(ddPP > DD_SINK_R * 1.4) return;
              var lnPP = Math.max(0.05, ddPP);
              var pullP = DD_SINK_PULL * (1 - Math.min(1, ddPP / (DD_SINK_R * 1.4))) * dt;
              P.x += (ddxP / lnPP) * pullP;
              P.z += (ddzP / lnPP) * pullP;
              P.slowUntil = Math.max(P.slowUntil|0, t + DD_SINK_SLOW);   // stumbling toward the pit
              if(ddPP < DD_SINK_R){
                P.hp -= DD_SINK_DMG;
                if(P.hp <= 0 && !P.dead) endBotLife(null, P, t, false, dis);
              }
            });
          }
        }
        // Sandstorm / Absolute Zero / EMP / Hurricane: every disaster has a visual AND
        // an impact. These four used to be mod-only (vision / movement / HUD / shove).
        // Exposure now chips once a second — shield / spawn-protect still skip it.
        if((dis === "sandstorm" || dis === "absolutezero" || dis === "emp" || dis === "hurricane") && t >= dHitAt){
          V.disasterHitAt = t + 1.0;
          var chipD = dis === "sandstorm" ? DD_SAND_DMG
            : (dis === "absolutezero" ? DD_ZERO_DMG
            : (dis === "hurricane" ? DD_WIND_DMG : DD_EMP_DMG));
          if(!meShielded(t) && !(V.protUntil && t < V.protUntil)){
            V.hp -= chipD;
            if(V.hp <= 0 && !V.dead) endBotLife(null, null, t, false, dis);
          }
          others().forEach(function(P){
            if(P.dead || P.gone || botShielded(P, t) || (P.protUntil && t < P.protUntil)) return;
            P.hp -= chipD;
            if(P.hp <= 0 && !P.dead) endBotLife(null, P, t, false, dis);
          });
        }
      }
      // Contested Capture crate: every 50s, hold it 3s for +20 reserve and +25 hp
      V.crateAt = V.crateAt || 0;
      if(!V.captureAt && t >= V.crateAt){
        V.crateAt = t + 50;
        V.worldK = (V.worldK|0) + 1;
        var cSpot = dropSpot(((V.worldK * 2654435761) >>> 0) + 9);
        V.captureAt = [cSpot[0], cSpot[2]];
        V.captureProg = 0; V.captureWho = null; V.captureSince = 0;
        say("Capture crate dropped — stand on it for 3s to claim it");
      }
      if(V.captureAt){
        var dC = Math.hypot(V.me.x - V.captureAt[0], V.me.z - V.captureAt[1]);
        if(dC < 2.0){
          if(V.captureWho !== myId()){ V.captureWho = myId(); V.captureSince = t; }
          V.captureProg = Math.min(100, Math.round((t - V.captureSince) / 3 * 100));
          if(V.captureProg >= 100){
            V.res = (V.res || []).map(function(n, wi){ return Math.min(200, (n|0) + 20); });
            V.resX = [Math.min(200, (V.resX ? V.resX[0] : 0) + 20)];
            V.hp = Math.min(100, V.hp + 25);
            say("Capture claimed: +20 reserve, +25 hp");
            V.captureAt = null; V.captureProg = 0; V.captureWho = null;
          }
        } else if(V.captureWho === myId()){
          V.captureWho = null; V.captureSince = 0; V.captureProg = 0;   // leaving resets the hold
        }
      }
    }
  }

  /* ---------- HUD ---------- */
  function hudUpdate(t){
    if(WB) WB.update();
    // Wave D: the disaster overlay (fog / flash / ice tint / EMP blue), gated on the live window
    if(disOv){
      var disNow = V.disaster || "";
      var disOn = !!(disNow && t < (V.disasterUntil || 0));
      var warnOn = !!(disNow && t < (V.disasterWarnAt || 0));
      disOv.classList.toggle("hidden", !disOn && !warnOn);
      if(disOn || warnOn){
        disOv.dataset.dis = warnOn ? "warn" : disNow;
        disOvIn.textContent = warnOn ? ("⚠ " + (TOTEMS[disNow] ? TOTEMS[disNow].n : disNow).toUpperCase() + " INCOMING")
          : (DIS_LIVE[disNow] || (TOTEMS[disNow] ? TOTEMS[disNow].n.toUpperCase() : "DISASTER"));
      } else {
        disOv.dataset.dis = "";
        disOvIn.textContent = "";
      }
    }
    // the little radar: me as a wedge, allies blue-ish, enemies red (Radar Jammer blanks
    // the enemy team and plants a couple of fake blips). 4 Hz is plenty for a glance map.
    if(radarCtx && t - radarAt > 0.25){
      radarAt = t;
      try {
        var S = radarCv.width, half = S/2, mx = V.me.x, mz = V.me.z, span = 48;
        radarCtx.clearRect(0, 0, S, S);
        radarCtx.fillStyle = getComputedStyle(root).getPropertyValue("--panel") || "#333";
        radarCtx.globalAlpha = 0.72; radarCtx.fillRect(0, 0, S, S); radarCtx.globalAlpha = 1;
        radarCtx.strokeStyle = getComputedStyle(root).getPropertyValue("--line") || "#666";
        radarCtx.strokeRect(0.5, 0.5, S - 1, S - 1);
        var toXY = function(x, z){ return [half + ((x - mx)/span)*half, half + ((z - mz)/span)*half]; };
        // my facing as a wedge
        radarCtx.save();
        radarCtx.translate(half, half);
        radarCtx.rotate(V.yaw);
        radarCtx.fillStyle = getComputedStyle(root).getPropertyValue("--brand") || "#fc0";
        radarCtx.beginPath();
        radarCtx.moveTo(0, -10); radarCtx.lineTo(5, 4); radarCtx.lineTo(-5, 4);
        radarCtx.closePath(); radarCtx.fill();
        radarCtx.restore();
        // Wave D: disaster marks on the radar (impact circles + the storm eye / pit)
        if(V.disaster && t < (V.disasterUntil || 0)){
          (V.disasterMarks || []).forEach(function(Mk){
            var xy = toXY(Mk.x, Mk.z);
            radarCtx.beginPath();
            radarCtx.arc(xy[0], xy[1], Math.max(2, (Mk.r/span)*half), 0, 6.2832);
            radarCtx.strokeStyle = getComputedStyle(root).getPropertyValue("--need") || "crimson";
            radarCtx.lineWidth = 2; radarCtx.stroke(); radarCtx.lineWidth = 1;
          });
          if(V.disaster === "shockring"){
            var xy2 = toXY((MAP.bounds[0]+MAP.bounds[3])/2, (MAP.bounds[2]+MAP.bounds[5])/2);
            radarCtx.beginPath();
            radarCtx.arc(xy2[0], xy2[1], Math.max(1, (V.disasterRing/span)*half), 0, 6.2832);
            radarCtx.strokeStyle = getComputedStyle(root).getPropertyValue("--gold") || "goldenrod";
            radarCtx.lineWidth = 2; radarCtx.stroke(); radarCtx.lineWidth = 1;
          }
        }
        // the OTHER side running a jammer: their blips vanish from my radar
        var theyJam = others().some(function(P){
          return P.team !== V.team && P.jamUntil && t < P.jamUntil && !P.dead && !P.gone;
        });
        var empNow = (V.disaster === "emp" && disLive(t));
        others().forEach(function(P){
          if(P.dead || P.gone) return;
          if(empNow) return;   // EMP Apocalypse: the tracking display is dead
          var xy = toXY(P.x, P.z);
          if(xy[0] < 0 || xy[0] > S || xy[1] < 0 || xy[1] > S) return;
          var foe = P.team !== V.team;
          // enemy jammer: their team is a blank on my radar, and I plant decoy dots
          if(foe && theyJam) return;
          radarCtx.fillStyle = foe
            ? (getComputedStyle(root).getPropertyValue("--need") || "#f44")
            : (getComputedStyle(root).getPropertyValue("--good") || "#4a4");
          radarCtx.beginPath(); radarCtx.arc(xy[0], xy[1], 3, 0, 6.283); radarCtx.fill();
        });
        if(theyJam){
          // the jammer plants a couple of decoy dots so the blank isn't obvious
          for(var fi = 0; fi < 2; fi++){
            var fx = mx + Math.sin(t*0.7 + fi*3)*18, fz = mz + Math.cos(t*0.5 + fi*2)*18;
            var fxy = toXY(fx, fz);
            radarCtx.fillStyle = getComputedStyle(root).getPropertyValue("--need") || "#f44";
            radarCtx.globalAlpha = 0.5;
            radarCtx.beginPath(); radarCtx.arc(fxy[0], fxy[1], 3, 0, 6.283); radarCtx.fill();
            radarCtx.globalAlpha = 1;
          }
        }
      } catch(e){ /* a blocked canvas is fine — the rest of the HUD still works */ }
    }
    var wp = W(), hp = V.mode === "practice" ? 100 : clamp(V.hp, 0, 100); // bots mode uses V.hp too (damage taken)
    hpBar.style.width = hp+"%"; hpBox.classList.toggle("low", hp <= 30);
    var ht = String(hp); if(hpNum.textContent !== ht) hpNum.textContent = ht;
    var at = V.reloadAt ? "…" : String(magOf(V.w)[V.w === LAUNCH_W ? 0 : V.w]); at += " / "+resOf(V.w)[V.w === LAUNCH_W ? 0 : V.w];
    if(ammoNum.textContent !== at) ammoNum.textContent = at;
    if(ammoName.textContent !== wp.name) ammoName.textContent = wp.name;
    reloadBar.style.width = V.reloadAt ? Math.round(100*clamp(1 - (V.reloadAt - t)/wp.reload, 0, 1))+"%" : "0";
    var tt;
    if(V.mode === "practice") tt = (V.phase === "round" ? mmss((V.endsAt - t)*1000) : V.phase === "warmup" ? mmss(PRACTICE_SECS*1000) : "0:00")+" · "+V.score+(V.score === 1 ? " drone" : " drones");
    else {
      var mine = V.mode === "bots" ? 1 : 0, foes = 0; // bots mode: V.order holds only the bots, you are the +1
      V.order.forEach(function(u){ var P = V.players[u]; if(!P || P.gone) return; if(P.team === V.team) mine++; else foes++; });
      tt = (V.phase === "round" ? mmss((V.endsAt - t)*1000) : V.phase === "done" ? "0:00" : mmss(V.minutes*60000))
        +" · "+TEAMS[0].n+" "+V.scores[0]+" — "+V.scores[1]+" "+TEAMS[1].n+" · "+mine+"v"+foes+" · first to "+V.limit;
      // Wave D/E: the auto-disaster clock, among score and time remaining. A live one wins.
      if(V.phase === "round" && disLive(t)){
        tt += " · ⚠ "+(TOTEMS[V.disaster] ? TOTEMS[V.disaster].n : "DISASTER");
      } else if(V.phase === "round" && V.disasterAt != null){
        var dleft = Math.max(0, Math.ceil(V.disasterAt - t));
        tt += " · ⚠ disaster in "+dleft+"s";
      }
    }
    if(V.warden){
      var wNow = V.warden, wPct = Math.max(0, Math.min(1, (wNow.hp|0) / Math.max(1, wNow.max|0)));
      wardenBar.classList.remove("hidden");
      wardenLock.classList.remove("hidden");
      wardenHp.style.width = Math.round(wPct * 100) + "%";
      wardenBar.setAttribute("aria-label", "The Warden " + (wNow.hp|0) + " of " + (wNow.max|0));
      tt += " · WARDEN " + (wNow.hp|0) + "/" + (wNow.max|0);
    } else {
      wardenBar.classList.add("hidden");
      wardenLock.classList.add("hidden");
    }
    if(topBox.textContent !== tt) topBox.textContent = tt;
    hitm.classList.toggle("on", t - V.hitAt < 0.15); hitm.classList.toggle("head", t - V.headAt < 0.15);
    var hurtOn = t - V.hurtAt < 0.8;
    hurt.classList.toggle("on", hurtOn);
    if(hurtOn) hurt.style.transform = "translate(-50%,-50%) rotate("+Math.round(V.hurtDir*180/Math.PI)+"deg)";
    vignette.classList.toggle("on", !calm() && t - V.hurtAt < 0.25);
    // disaster white-out: a bolt / crater flash / shock blast washes the view (calm: a soft veil)
    root.classList.toggle("vg-fps-blind", !!(V.blindUntil && t < V.blindUntil));
    var stamOn = !V.watch && !V.dead && !V.paused && V.stamina < FS.STAMINA_MAX - 0.5;
    stamBox.classList.toggle("hidden", !stamOn);
    if(stamOn){
      stamBar.style.width = Math.round(V.stamina)+"%";
      stamBox.classList.toggle("low", V.stamina <= 0);
    }
    cross.classList.toggle("wide", V.w === 0 && !V.ads);
    var adsCls = V.ads && ADS[V.w] ? ADS[V.w].cls : "";
    cross.classList.toggle("ads", adsCls === "reddot");
    cross.classList.toggle("sniper", adsCls === "sniper");
    var empHud = (V.disaster === "emp" && t >= (V.disasterWarnAt || 0) && t < (V.disasterUntil || 0));
    scope.classList.toggle("on", adsCls !== "" && !empHud);
    scope.classList.toggle("reddot", adsCls === "reddot" && !empHud);
    scope.classList.toggle("sniper", adsCls === "sniper" && !empHud);
    cross.classList.toggle("hidden", empHud);
    root.classList.toggle("vg-fps-emp", empHud);
    root.classList.toggle("vg-fps-dead", V.dead);
    // the cloak veil: bots stop seeing me for the window; I see the same rim so it reads
    root.classList.toggle("vg-fps-cloak", !!(V.cloakUntil && t < V.cloakUntil));
    // your own shield, from the inside: rim + pill while the glide runs, the bar drains
    // over DROP_TIME so the packing moment is visible, not just inferable
    var shMe = !V.dead && meShielded(t);
    root.classList.toggle("vg-fps-shield", shMe);
    shOv.classList.toggle("on", shMe);
    shPill.classList.toggle("hidden", !shMe);
    if(shMe){
      var shLeft = V.mode === "mp"
        ? 1   // the server's window: the flag rides the snapshot, no local clock to drain
        : clamp((V.shieldTotemUntil > t ? (V.shieldTotemUntil - t)/TOTEMS.shield.dur : (V.dropUntil - t)/FS.DROP_TIME), 0, 1);
      shBar.style.width = Math.round(shLeft*100)+"%";
    }
    if(V.feed.length && t - V.feed[V.feed.length - 1].at > FEED_TTL){ V.feed = V.feed.filter(function(f){ return t - f.at <= FEED_TTL; }); renderFeed(); }
  }
  // how someone died: never "?" and never a bare "Disaster"
  function envKiller(dis){
    dis = dis ? String(dis) : "";
    if(dis === "warden-slam" || dis === "warden-laser" || dis === "warden-grip" || dis === "warden") return "The Warden";
    return "The map";
  }
  function envLabel(dis){
    dis = dis ? String(dis) : "";
    if(dis === "warden-slam") return "arm slam";
    if(dis === "warden-laser") return "laser eyes";
    if(dis === "warden-grip") return "gravity grip";
    if(dis === "warden") return "The Warden";
    if(TOTEMS[dis] && TOTEMS[dis].n) return TOTEMS[dis].n;
    if(ENV_NAMES[dis]) return ENV_NAMES[dis];
    return dis.charAt(0).toUpperCase() + dis.slice(1);
  }
  function renderFeed(){
    feedBox.textContent = "";
    V.feed.forEach(function(f){
      var li = api.mk("li", f.mine ? "me" : null);
      if(f.item){   // a pickup: "Bolt grabbed the Mole" — so the map's items read as contested
        li.appendChild(api.mk("b", null, f.k));
        li.appendChild(api.mk("span", "vg-fps-w", " grabbed "));
        var it = api.mk("b", null, f.item);
        it.style.color = f.hue; li.appendChild(it); feedBox.appendChild(li);
        li.style.borderLeft = "3px solid "+f.hue;
        return;
      }
      li.appendChild(api.mk("b", null, f.k));
      // a disaster / Warden kill names the cause instead of a weapon (w = -1)
      var wTxt = f.dis ? envLabel(f.dis) : wLabel(f.w|0);
      li.appendChild(api.mk("span", "vg-fps-w", " "+wTxt+(f.hs ? " · head" : "")+" "));
      li.appendChild(api.mk("b", null, f.v)); feedBox.appendChild(li);
      var bc = f.dis ? (TOTEMS[f.dis] && TOTEMS[f.dis].c) || (f.dis.indexOf("warden") === 0 ? "#c9a227" : "#888") : TEAMS[f.vt|0].c;
      li.style.borderLeft = "3px solid "+bc;
    });
  }
  // one pickup into the top-right feed: name (their team colour in the dot) + the item,
  // tinted with the exact hue of its sky column so the feed doubles as the beacon legend
  function feedItem(name, team, kind, t){
    var hue = kind === "health" ? "#f4f4f4" : kind === "ammo" ? "#e0b325" : (TOTEMS[kind] && TOTEMS[kind].hue) || TEAMS[team|0].c;
    var label = kind === "health" ? "a health kit" : kind === "ammo" ? "an ammo box" : (TOTEMS[kind] && TOTEMS[kind].n) || kind;
    V.feed.unshift({k: name, item: label, hue: hue, at: t, mine: name === "You"});
    if(V.feed.length > FEED_MAX) V.feed.length = FEED_MAX;
    renderFeed();
  }
  // the item guide card (press I): one row per thing that drops on the map, each tinted with
  // the exact colour of its light column so the card reads as a legend for the sky beacons
  function renderGuide(){
    guide.classList.toggle("hidden", !V.guide);
    if(!V.guide) return;
    guide.textContent = "";
    guide.appendChild(api.mk("b", null, "Items on the map"));
    guide.appendChild(api.mk("p", null, "Fresh totems drop every "+TOTEM_GAP+"s, fresh health/ammo packs every "+PACK_GAP+"s, and Disaster totems every "+DIS_GAP_DROP+"s — each somewhere random on the map. The arena also erupts every "+DIS_GAP+"s (counted down in the top bar). Repetitions allowed."));
    var tb = api.mk("table", "vg-golf-table"), hr = api.mk("tr");
    ["", "Item", "Effect"].forEach(function(h){ hr.appendChild(api.mk("th", null, h)); }); tb.appendChild(hr);
    // rows: the map's base packs first, then the totems; colours come straight from the
    // constants the 3D gems/beams use, so the legend can never drift from what you see
    var rows = [{c: "#f4f4f4", n: "Health kit", d: "Pick up to raise your health by 50."},
                {c: "#e0b325", n: "Ammo box", d: "Pick up to reload any gun that is running empty."},
                {c: "currentColor", n: "— Totems —", d: "drop every "+TOTEM_GAP+"s, anywhere"}]
      .concat(Object.keys(TOTEMS).filter(function(k){ return DISASTERS.indexOf(k) < 0; })
        .map(function(k){ return {c: TOTEMS[k].hue, n: TOTEMS[k].n, d: TOTEM_HELP[k]}; }));
    rows.push({c: "currentColor", n: "— Disaster totems —", d: "drop every "+DIS_GAP_DROP+"s · also auto every "+DIS_GAP+"s"});
    rows = rows.concat(DISASTERS.map(function(k){ return {c: TOTEMS[k].hue, n: TOTEMS[k].n, d: TOTEM_HELP[k]}; }));
    rows.forEach(function(r){
      var tr = api.mk("tr");
      var sw = api.mk("td"); sw.style.color = r.c; sw.appendChild(document.createTextNode("●"));
      tr.appendChild(sw);
      var nm = api.mk("td", null, r.n); nm.style.color = r.c; tr.appendChild(nm);
      tr.appendChild(api.mk("td", null, r.d));
      tb.appendChild(tr);
    });
    guide.appendChild(tb);
    guide.appendChild(api.btn("Close", "", function(){ V.guide = false; renderGuide(); if(canvas) canvas.focus(); }));
  }
  function renderBoard(){
    board.classList.toggle("hidden", !V.board);
    if(!V.board) return;
    board.textContent = "";
    board.appendChild(api.mk("b", null, V.mode === "practice" ? "Target range" :
      TEAMS[0].n+" "+V.scores[0]+" — "+V.scores[1]+" "+TEAMS[1].n+" · first to "+V.limit));
    var tb = api.mk("table", "vg-golf-table"), hr = api.mk("tr");
    (V.mode === "practice" ? ["", "Drones", "Shots"] : ["Player", "Team", "Kills", "Deaths"]).forEach(function(h){ hr.appendChild(api.mk("th", null, h)); }); tb.appendChild(hr);
    var rows = V.mode === "practice" ? [{name: "You", kills: V.score, deaths: V.shots, uid: "me"}] :
      (V.mode === "bots" ? [{name: "You", uid: myId(), team: V.team, kills: V.kills|0, deaths: V.deaths|0, slot: -1}] : []).concat(V.order.map(function(u){ return V.players[u]; }))
        .sort(function(a, b){ return (a.team - b.team) || (b.kills - a.kills) || (a.deaths - b.deaths) || (a.slot - b.slot); });
    rows.forEach(function(P){
      var tr = api.mk("tr");
      tr.appendChild(api.mk("td", P.uid === myId() ? "tot" : null, P.name+(P.bot ? " (bot)" : "")+(P.gone ? " (left)" : P.away ? " (away)" : "")));
      if(V.mode !== "practice"){
        var td = api.mk("td", null, TEAMS[P.team|0].n); td.style.color = TEAMS[P.team|0].c; tr.appendChild(td);
      }
      tr.appendChild(api.mk("td", null, String(P.kills|0))); tr.appendChild(api.mk("td", null, String(P.deaths|0)));
      tb.appendChild(tr);
    });
    board.appendChild(tb);
    board.appendChild(api.btn("Close", "", function(){ V.board = false; renderBoard(); if(canvas) canvas.focus(); }));
  }
  function resultsTable(rows, title){
    var box = api.mk("div", "vg-golf-score");
    box.appendChild(api.mk("b", null, title));
    var teams = (rows || []).filter(function(r){ return r && r.teams; })[0];
    if(teams){
      var tt = api.mk("p", "vg-strike-final");
      tt.appendChild(api.mk("span", null, TEAMS[0].n+" "+teams.teams[0]));
      tt.appendChild(api.mk("b", null, " — "));
      tt.appendChild(api.mk("span", null, teams.teams[1]+" "+TEAMS[1].n));
      if(teams.teams[0] !== teams.teams[1]){
        var win = teams.teams[0] > teams.teams[1] ? 0 : 1;
        tt.appendChild(api.mk("b", "vg-strike-win", "  "+TEAMS[win].n+" wins"));
        tt.lastChild.style.color = TEAMS[win].c;
      } else tt.appendChild(api.mk("b", null, "  Draw"));
      box.appendChild(tt);
    }
    var tb = api.mk("table", "vg-golf-table"), hr = api.mk("tr");
    ["#", "Player", "Team", "Kills", "Deaths"].forEach(function(h){ hr.appendChild(api.mk("th", null, h)); }); tb.appendChild(hr);
    (rows || []).forEach(function(r){
      if(!r || !r.place) return;
      var tr = api.mk("tr");
      tr.appendChild(api.mk("td", null, String(r.place|0)));
      tr.appendChild(api.mk("td", r.user && (r.user.userId || r.user.id) === myId() ? "tot" : null,
        nameOf(r.user)+(r.bot ? " (bot)" : "")+(r.left ? " (left)" : "")));
      var td = api.mk("td", null, TEAMS[clamp(r.team|0, 0, 1)].n); td.style.color = TEAMS[clamp(r.team|0, 0, 1)].c; tr.appendChild(td);
      tr.appendChild(api.mk("td", null, String(r.kills|0))); tr.appendChild(api.mk("td", null, String(r.deaths|0)));
      tb.appendChild(tr);
    });
    box.appendChild(tb); return box;
  }
  function showResults(rows){
    cardBox.textContent = "";
    cardBox.appendChild(resultsTable(rows, "Match over · "+MAP.name));
    var row = api.mk("div", "vg-row");
    if(V.mode === "bots"){
      row.appendChild(api.btn("Play again", "primary", function(){ startBotMatch(); }));
      row.appendChild(api.btn("Menu", "", function(){ resetMatch(); showStage(false); renderMenu(); }));
    } else row.appendChild(api.btn(isHost() ? "Set up the next match" : "Back to the lobby", "primary", function(){ resetMatch(); showStage(false); renderMenu(); }));
    cardBox.appendChild(row); cardBox.classList.remove("hidden");
    var teams = (rows || []).filter(function(r){ return r && r.teams; })[0];
    if(teams){
      var mine = teams.teams[V.team]|0, theirs = teams.teams[1 - V.team]|0;
      say(mine > theirs ? "Your side wins "+mine+" to "+theirs+"." : mine < theirs ? "Their side wins "+theirs+" to "+mine+". " : "A draw: "+mine+" each.");
    }
  }

  /* ---------- renderers ---------- */
  function ensureRenderer(){
    if(canvas) return;
    wrap.textContent = "";
    pauseBox.textContent = "";
    pauseBox.appendChild(api.mk("b", null, "Paused"));
    pauseBox.appendChild(api.mk("span", null, "Click here to play (the mouse aims; Esc gives it back), or Tab here to play with the keyboard."));
    [hud, board, guide, cardBox, pauseBox, badge, load].forEach(function(n){ wrap.appendChild(n); });
    canvas = api.mk("canvas", "vg-golf-canvas vg-fps-canvas"); canvas.tabIndex = 0;
    canvas.setAttribute("aria-label", "Strikezone, first person team shooter. Click to aim with the mouse, Escape releases it. W A S D move, Q and E lean to peek, F or click fires, R reloads, 1 2 3 4 pick a weapon, hold Tab for the weapon wheel, Space jumps. Hold right-click or the backquote key to scope in.");
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
        if(window.console) console.warn("strike 3d", e);
        var why = e && e.message ? ": " + e.message : "";
        V.note = "3D unavailable" + why + " — showing the map view."; api.toast(V.note); fallback2d();
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
      worldTick(dt, tn);
      if(R3) R3.render(dt, tn); else if(R2) R2.render(tn);
      if(t - hudAt > 0.05){ hudAt = t; hudUpdate(tn); }
    } catch(e){ if(window.console) console.error("strike frame", e); }
  }
  // the weapon wheel: hold Tab, steer with the mouse, release to pick (the selection
  // takes effect as the key comes up, GTA-style; Esc closes it without picking)
  var wheelBox = (function(){
    var b = api.mk("div", "vg-fps-wheel hidden"); b.setAttribute("role", "dialog"); b.setAttribute("aria-label", "Pick a weapon");
    var ring = api.mk("div", "vg-fps-wheel-ring"), lab = api.mk("div", "vg-fps-wheel-lab");
    b.appendChild(ring); b.appendChild(lab); hud.appendChild(b);
    var segs = FS.WEAPONS.map(function(wp, i){
      // the wedge positions are pure CSS clip-path pie slices (:nth-child(1..5));
      // seg 0 sits centered on up, then clockwise — matching atan2(x, -y)
      var s = api.mk("div", "vg-fps-wheel-seg");
      var c = api.mk("div", "vg-fps-wheel-cnt"); s.appendChild(c);
      var ic = api.mk("span", "vg-fps-wheel-ic", WHEEL_ICONS[i]);
      var nm = api.mk("b", null, wp.name), am = api.mk("i");
      ic.setAttribute("aria-hidden", "true");
      c.appendChild(ic); c.appendChild(nm); c.appendChild(am); ring.appendChild(s);
      return {el: s, ammo: am};
    });
    return {box: b, lab: lab, segs: segs};
  })();
  function renderWheel(t){
    if(!V.wheelOpen){ wheelBox.box.classList.add("hidden"); return; }
    wheelBox.box.classList.remove("hidden");
    var n = weaponCount();
    wheelBox.segs.forEach(function(sg, i){
      sg.el.classList.toggle("sel", i === V.wheelSel);
      sg.el.classList.toggle("off", i >= n);
      sg.el.classList.toggle("cur", i === V.w);
      sg.ammo.textContent = magOf(i)[i === LAUNCH_W ? 0 : i] + " / " + resOf(i)[i === LAUNCH_W ? 0 : i];
    });
    var txt = V.wheelSel >= 0 && V.wheelSel < n ? FS.WEAPONS[V.wheelSel].name : "Cancel";
    if(wheelBox.lab.textContent !== txt) wheelBox.lab.textContent = txt;
  }

  // 2D map view: north-up, centred on you, your view as a wedge.
  function make2d(cv){
    var R = {canvas: cv};
    R.render = function(t){
      if(!cv) return;
      var g = cv.getContext("2d"), Wd = cv.width, Ht = cv.height, T = TOK;
      g.setTransform(1, 0, 0, 1, 0, 0); g.fillStyle = T.bg2; g.fillRect(0, 0, Wd, Ht);
      if(!MAP){ g.fillStyle = T.muted; g.font = "14px sans-serif"; g.fillText("Loading…", 16, 24); return; }
      var sc = Math.min(Wd, Ht)/34, M = V.me;
      g.save(); g.translate(Wd/2, Ht/2); g.scale(sc, sc); g.translate(-M.x, -M.z);
      MAP.boxes.forEach(function(b){
        if(b[4] <= 0) { g.fillStyle = T.panel2; g.fillRect(b[0], b[2], b[3] - b[0], b[5] - b[2]); return; }
        g.globalAlpha = clamp(0.35 + b[4]/5, 0.35, 1);
        g.fillStyle = (b[6] === "wall" || b[6] === "adobe" || b[6] === "divider") ? T.ink : T.muted;
        g.fillRect(b[0], b[2], b[3] - b[0], b[5] - b[2]); g.globalAlpha = 1;
      });
      // The Warden on the 2D map: totem-golem silhouette (skirt, torso, head, two heavy arms)
      if(V.warden){
        var w2 = V.warden, wS = WARDEN_SCALE;
        g.fillStyle = T.muted;
        g.fillRect(w2.x - 3.2*wS, w2.z - 1.6*wS, 6.4*wS, 3.2*wS);          // rubble skirt
        g.fillStyle = T.need;
        g.fillRect(w2.x - 2.3*wS, w2.z - 1.3*wS, 4.6*wS, 2.6*wS);          // chest
        g.fillRect(w2.x - WARDEN_ARM_X - 0.6*wS, w2.z - 0.5*wS, 1.2*wS, 1.4*wS); // left arm
        g.fillRect(w2.x + WARDEN_ARM_X - 0.6*wS, w2.z - 0.5*wS, 1.2*wS, 1.4*wS); // right arm
        g.fillStyle = (w2.coreUntil && t < w2.coreUntil) ? T.need : T.gold;
        g.fillRect(w2.x - 0.8*wS, w2.z - 0.8*wS, 1.6*wS, 1.6*wS);          // head / totem mark (core when open)
        if(w2.slabArm || w2.slabLand){
          g.beginPath(); g.arc(w2.x - WARDEN_ARM_X, w2.z, WARDEN_SLAB_R, 0, Math.PI*2);
          g.strokeStyle = T.need; g.lineWidth = 0.14; g.stroke();
          g.beginPath(); g.arc(w2.x + WARDEN_ARM_X, w2.z, WARDEN_SLAB_R, 0, Math.PI*2);
          g.stroke(); g.lineWidth = 1;
        }
        if(w2.laserWarn && w2.laserOn){
          g.save();
          g.translate(w2.x, w2.z);
          g.rotate(w2.laserYaw || 0);
          g.fillStyle = T.need;
          g.fillRect(0, -0.3, 80, 0.6);
          g.restore();
        }
      }
      // Wave F: disasters paint on the flat map too (wash + impact rings + shock ring)
      if(V.disaster && t < (V.disasterUntil || 0)){
        var disW = V.disaster;
        g.globalAlpha = 0.22;
        g.fillStyle = (disW === "sandstorm") ? T.gold
          : (disW === "meteorshower" || disW === "shockring") ? T.need
          : (disW === "toxicfog") ? T.good
          : (disW === "thunder") ? T.gold
          : (disW === "absolutezero") ? T.brand
          : (disW === "emp") ? T.brand
          : T.panel2;
        g.fillRect(MAP.bounds[0], MAP.bounds[2], MAP.bounds[3] - MAP.bounds[0], MAP.bounds[5] - MAP.bounds[2]);
        g.globalAlpha = 1;
        (V.disasterMarks || []).forEach(function(Mk){
          g.beginPath(); g.arc(Mk.x, Mk.z, Math.max(0.3, Mk.r), 0, Math.PI*2);
          g.strokeStyle = (Mk.dis === "thunder") ? T.gold : T.need; g.lineWidth = 0.12; g.stroke(); g.lineWidth = 1;
        });
        if(disW === "shockring"){
          var oxS = (MAP.bounds[0] + MAP.bounds[3]) / 2, ozS = (MAP.bounds[2] + MAP.bounds[5]) / 2;
          g.beginPath(); g.arc(oxS, ozS, Math.max(0.4, V.disasterRing || 0), 0, Math.PI*2);
          g.strokeStyle = T.gold; g.lineWidth = 0.18; g.stroke(); g.lineWidth = 1;
        }
      }
      MAP.pickups.forEach(function(pk, i){ if(!V.items[i] || !pk.kind) return; g.fillStyle = pk.kind === "health" ? T.need : T.gold; g.beginPath(); g.arc(pk.at[0], pk.at[2], 0.4, 0, Math.PI*2); g.fill(); });
      // Rift pairs: two violet blips and the link between them (projectiles hop through)
      (V.rifts || []).forEach(function(Rf){
        if(!Rf || t >= (Rf.until || 0)) return;
        g.strokeStyle = TOTEMS.rift.hue; g.lineWidth = 0.12;
        g.beginPath(); g.moveTo(Rf.x, Rf.z); g.lineTo(Rf.x2, Rf.z2); g.stroke(); g.lineWidth = 1;
        g.fillStyle = TOTEMS.rift.hue;
        g.beginPath(); g.arc(Rf.x, Rf.z, 0.55, 0, Math.PI*2); g.fill();
        g.beginPath(); g.arc(Rf.x2, Rf.z2, 0.55, 0, Math.PI*2); g.fill();
      });
      // Shockwave totem: an expanding ground ring (reads even when nobody is in range)
      (V.rings || []).forEach(function(rg){
        if(!rg) return;
        var aR = (t - (rg.at || 0)) / (rg.dur || 0.55);
        if(aR < 0 || aR > 1) return;
        g.beginPath(); g.arc(rg.x, rg.z, Math.max(0.3, (rg.r || 8) * (0.15 + 0.85 * aR)), 0, Math.PI*2);
        g.strokeStyle = T.need; g.lineWidth = 0.18 * (1 - aR * 0.6); g.stroke(); g.lineWidth = 1;
      });
      if(V.mode === "practice") V.drones.forEach(function(D){ if(D.downUntil > t) return; var c = dronePos(D, (V.phase === "round" ? t - V.startAt : 0)); g.fillStyle = T.need; g.fillRect(c[0] - 0.45, c[2] - 0.45, 0.9, 0.9); });
      (V.mdrones || []).forEach(function(D){ var c = matchDronePos(D, t); g.fillStyle = T.need; g.fillRect(c[0] - 0.5, c[2] - 0.5, 1.0, 1.0); });
      V.tracers.forEach(function(tr){ var age = t - tr.at; if(age > 0.12) return; g.strokeStyle = tr.mine ? T.gold : T.need; g.lineWidth = 0.08; g.beginPath(); g.moveTo(tr.a[0], tr.a[2]); g.lineTo(tr.b[0], tr.b[2]); g.stroke(); });
      others().forEach(function(P){
        if(P.gone) return;
        if(!P.dead && botShielded(P, t)){  // the drop shield reads on the map too: a light-blue halo
          g.globalAlpha = 0.5; g.strokeStyle = SHIELD_COLOR; g.lineWidth = 0.18;
          g.beginPath(); g.arc(P.x, P.z, 0.8, 0, Math.PI*2); g.stroke(); g.globalAlpha = 1;
        }
        g.globalAlpha = P.dead ? 0.3 : 1; g.fillStyle = TEAMS[P.team|0].c;
        g.beginPath(); g.arc(P.x, P.z, 0.45, 0, Math.PI*2); g.fill();
        g.strokeStyle = T.ink; g.lineWidth = 0.08; g.beginPath(); g.moveTo(P.x, P.z); g.lineTo(P.x + Math.sin(P.yaw)*0.8, P.z - Math.cos(P.yaw)*0.8); g.stroke();
        g.globalAlpha = 1; g.fillStyle = T.ink; g.font = "0.6px sans-serif"; g.textAlign = "center"; g.fillText(P.name, P.x, P.z - 0.7);
      });
      // me + the view wedge
      g.fillStyle = TEAMS[V.team].c; g.globalAlpha = 0.18; g.beginPath(); g.moveTo(M.x, M.z);
      g.arc(M.x, M.z, 12, V.yaw - Math.PI/2 - (V.ads ? 0.22 : 0.5), V.yaw - Math.PI/2 + (V.ads ? 0.22 : 0.5)); g.closePath(); g.fill(); g.globalAlpha = 1;
      g.beginPath(); g.arc(M.x, M.z, 0.45, 0, Math.PI*2); g.fill();
      // kill cam on the 2D map: their wedge and name, from where they shot you
      var KC2 = V.dead && V.killCam && V.killCam.ref && !V.killCam.ref.gone ? V.killCam : null;
      if(KC2){
        var ky = KC2.ref.yaw || 0;
        g.fillStyle = TEAMS[KC2.team].c; g.globalAlpha = 0.3; g.beginPath(); g.moveTo(KC2.ref.x, KC2.ref.z);
        g.arc(KC2.ref.x, KC2.ref.z, 9, ky - Math.PI/2 - 0.5, ky - Math.PI/2 + 0.5); g.closePath(); g.fill(); g.globalAlpha = 1;
        g.beginPath(); g.arc(KC2.ref.x, KC2.ref.z, 0.45, 0, Math.PI*2); g.fill();
        g.fillStyle = T.ink; g.font = "0.6px sans-serif"; g.textAlign = "center"; g.fillText("killer", KC2.ref.x, KC2.ref.z - 0.7);
      }
      g.restore();
    };
    return R;
  }

  function make3d(cv){
    return E.lib().then(function(lib){
      var names = [["fps", "platform-large-grass"], ["fps", "platform"], ["fps", "wall-high"], ["fps", "wall-low"], ["fps", "blaster"],
                   ["fps", "blaster-repeater"], ["fps", "enemy-flying"], ["fps", "grass"]]
        .concat(CHARS.map(function(c){ return ["golf", c.f]; }));
      var done = 0, GL = {};
      function tex(n){ return new Promise(function(res){ lib.tex.load("/games/fps/"+n+".png", res, null, function(){ res(null); }); }); }
      return Promise.all(names.map(function(n){ return E.loadGlb(lib, n[0], n[1]).then(function(g){ GL[n[1]] = g; done++; loadFill.style.width = Math.round(10 + 85*done/names.length)+"%"; }); }))
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
    // Graphics quality: Low keeps the cheap path; Balanced/Ultra add tone mapping + PBR + soft shadows
    // (carried over from the Blaster Arena graphics work, tuned for the dock's dusk).
    var HQ = (function(){ try { return (localStorage.getItem("hq_strike_gfx") || "balanced"); } catch(e){ return "balanced"; } })();
    var ULTRA = !V.low && HQ !== "low", PBR = ULTRA && !!THREE.MeshStandardMaterial;
    if(ULTRA && THREE.ACESFilmicToneMapping != null){ renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05; }
    var FOV = 75, FOV_ADS = 40;                                  // FOV zoom while scoped (visual only; spread unchanged; per-weapon zooms in ADS above)
    var scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(FOV, 1.6, 0.05, 300);
    var hemi = new THREE.HemisphereLight(0xdfeffc, 0x4a5a44, ULTRA ? 1.1 : 2.1); scene.add(hemi);
    var sun = new THREE.DirectionalLight(0xfff2d8, ULTRA ? 2.4 : 1.8); sun.position.set(14, 30, 10);
    sun.castShadow = !V.low; sun.shadow.mapSize.set(ULTRA ? 2048 : 1024, ULTRA ? 2048 : 1024);
    sun.shadow.bias = -0.0005; sun.shadow.normalBias = 0.03;
    var sc = sun.shadow.camera; sc.left = -26; sc.right = 26; sc.top = 26; sc.bottom = -26; sc.near = 1; sc.far = 80;
    scene.add(sun); scene.add(sun.target);
    // cool fill from the opposite side so shadowed faces keep depth instead of going flat
    var fill = null; if(ULTRA){ fill = new THREE.DirectionalLight(0x7a9fd8, 0.5); fill.position.set(-12, 18, -14); scene.add(fill); }
    // the first-person weapon: its own scene and camera, drawn over the world
    var vScene = new THREE.Scene(), vCam = new THREE.PerspectiveCamera(50, 1.6, 0.01, 10);
    vScene.add(new THREE.HemisphereLight(0xffffff, 0x667755, 2.3));
    var vSun = new THREE.DirectionalLight(0xffffff, 1.4); vSun.position.set(2, 3, 2); vScene.add(vSun);
    var GUN_S = 0.2, guns, gunHold = new THREE.Group(); vScene.add(gunHold);
    var mySkin = window.HQ_MYCOS && hex(window.HQ_MYCOS.blaster, null);       // HQ 2.1: the blaster skin you wear
    // Simple, readable silhouettes of our own making: what you hold should tell you what you hold.
    function gmat(c, r){ return new THREE.MeshLambertMaterial({color: c}); }
    function box(w, h, d, x, y, z, c){
      var m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), gmat(c));
      m.position.set(x || 0, y || 0, z || 0); return m;
    }
    function tubeL(r, len, x, y, z, c){ // a barrel: a cylinder lying along -z
      var m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 12), gmat(c));
      m.rotation.x = Math.PI/2; m.position.set(x || 0, y || 0, z || 0); return m;
    }
    function gunMarksman(){ // long thin barrel, a scope tube on top, a stock — the sniper outline
      var g = new THREE.Group();
      g.add(box(0.10, 0.12, 0.55, 0, 0, -0.05, 0x3a3f45));        // receiver
      g.add(tubeL(0.028, 0.62, 0, 0.030, -0.62, 0x2c3036));       // the long barrel
      g.add(tubeL(0.045, 0.22, 0, 0.105, -0.18, 0x22262b));       // scope
      g.add(box(0.09, 0.16, 0.26, 0, -0.06, 0.34, 0x4a3b2a));     // wooden stock
      g.add(box(0.05, 0.12, 0.10, 0, -0.11, 0.05, 0x3a3f45));     // grip
      return g;
    }
    function gunRevolver(){ // your current blaster model — chunky pistol frame (it already reads as a hand cannon)
      return model("blaster");
    }
    function gunLauncher(){ // a fat tube with a back vent and a front ring — the rocket outline
      var g = new THREE.Group();
      g.add(tubeL(0.13, 0.95, 0, 0, -0.1, 0x3e4a3a));             // the launch tube
      g.add(tubeL(0.155, 0.16, 0, 0, 0.40, 0x2e382c));            // rear vent bell
      g.add(tubeL(0.145, 0.10, 0, 0, -0.58, 0x50604a));           // front ring
      g.add(box(0.06, 0.14, 0.12, 0, -0.14, 0.02, 0x2c3328));     // grip underneath
      g.add(box(0.04, 0.08, 0.30, 0, 0.15, -0.05, 0x2e382c));     // sight rail on top
      return g;
    }
    function gunGrapple(){ // a cable spool + hook fork — original silhouette, no third-party asset
      var g = new THREE.Group();
      g.add(tubeL(0.07, 0.28, 0, 0, 0.12, 0x3a3f45));             // spool drum
      g.add(tubeL(0.09, 0.06, 0, 0, 0.28, 0x2c3036));             // spool flange
      g.add(box(0.08, 0.12, 0.34, 0, -0.02, -0.18, 0x2c3036));    // body
      g.add(box(0.05, 0.12, 0.10, 0, -0.12, 0.02, 0x3a3f45));     // grip
      g.add(tubeL(0.03, 0.22, 0, 0.02, -0.42, 0x50604a));         // hook shaft
      g.add(box(0.10, 0.04, 0.08, 0, 0.02, -0.54, 0x6a7a5a));     // hook fork
      return g;
    }
    guns = [model("blaster-repeater"), gunMarksman(), gunRevolver(), gunLauncher(), gunGrapple()];
    // measure each gun BEFORE rotation, in its own local space (setFromObject bakes rotation in
    // and the children's matrices haven't re-synced after rotation.y flips — that misreads the span).
    // Normalise our thin rifle/launcher to the chunky SMG's on-screen length, with a width
    // compensation so they read the same visual weight.
    var refB = new THREE.Box3().setFromObject(guns[0]), refL = (refB.max.z - refB.min.z) || 1;
    var BOOST = 2.6; // thin silhouette -> reads much smaller than the chunky repeater at equal length: boost
    guns.forEach(function(g, i){
      g.traverse(function(n){ if(n.isMesh){ n.castShadow = false; n.receiveShadow = false;
        if(i === 0 && mySkin != null){ n.material = n.material.clone(); n.material.color.setHex(mySkin); } } });
      var k = 1;
      if(i === 1 || i === 3 || i === 4){
        var b = new THREE.Box3().setFromObject(g), L = (b.max.z - b.min.z) || refL;
        // rifle a bit more than the launcher; the grapple spool is the thinnest silhouette
        // and used to vanish at k=1 — same on-screen length as the other sidearms
        k = (refL/L)*(i === 1 ? 5.0 : (i === 4 ? BOOST*1.35 : BOOST));
      }
      g.scale.setScalar(GUN_S*k); g.rotation.y = Math.PI; g.visible = i === 0; gunHold.add(g);
    });
    var flash = null, muzzle = null, seatFlash = null;
    if(burstTex){
      burstTex.colorSpace = THREE.SRGBColorSpace; burstTex.repeat.set(0.5, 1);
      flash = new THREE.Sprite(new THREE.SpriteMaterial({map: burstTex, transparent: true, depthTest: false, blending: THREE.AdditiveBlending}));
      // at the muzzle: the front face of the weapon's bounds (it looks down -z here); re-seated
      // per weapon so every gun flashes at its own muzzle
      gunHold.add(flash);
      seatFlash = function(g){
        if(!flash || !g) return;
        gunHold.updateMatrixWorld(true);
        var gb = new THREE.Box3().setFromObject(g);
        flash.position.set((gb.min.x + gb.max.x)/2, gb.min.y + (gb.max.y - gb.min.y)*0.62, gb.min.z - 0.02);
        if(muzzle) muzzle.position.copy(flash.position);
      };
      if(ULTRA){ muzzle = new THREE.PointLight(0xffc36a, 0, 9); gunHold.add(muzzle); }
      seatFlash(guns[0]);
    }
    var mapGroup = null, dyn = new THREE.Group(); scene.add(dyn);
    // your own canopy, seen from inside: a sphere around your body — from eye height you
    // look down THROUGH it (a soft blue haze over your feet), which is the "I'm shielded"
    // cue the rim glow alone can't give. Hidden the moment the shield drops.
    var myShield = new THREE.Mesh(new THREE.SphereGeometry(1.05, 20, 14),
      new THREE.MeshBasicMaterial({color: hex(SHIELD_COLOR, 0x7fd4ff), transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide}));
    myShield.position.y = 0.95; myShield.visible = false; scene.add(myShield);
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
    // Dockyard kit: solid boxes drawn as the harbour pieces, tiled so they keep proportions.
    var KIND = {floor: ["platform-large-grass", 8.8], block: ["platform", 2.2], step: ["platform", 1.0], crate: ["platform", 1.2],
                low: ["wall-low", 2.2], wall: ["wall-high", 1.5], catwalk: ["wall-low", 2.2]};
    // Dune Compound kit: adobe architecture only — no dockyard containers/crates.
    // Each kind is [mode, accent?] where mode picks the mesh builder below.
    var DUNE_KIND = {sand: 1, rock: 1, adobe: 1, divider: 1, silo: 1, dome: 1,
                     pillar: 1, curb: 1, crate: 1, step: 1, ledge: 1, block: 1, shed: 1};
    function isDuneKind(k){ return DUNE_KIND[k] === 1 && k !== "container" && k !== "catwalk"; }
    // One material finish everywhere so the dock reads as one place: PBR when we have it, Lambert
    // when we don't, with an optional emissive pulse over the theme's accent. Colors come from the
    // theme and the box kind; only the surface response changes.
    var pulseMats = [];
    function mat(opts){
      opts = opts || {};
      var m;
      if(PBR) m = new THREE.MeshStandardMaterial({color: opts.color != null ? opts.color : 0xffffff, roughness: opts.rough != null ? opts.rough : 0.82, metalness: opts.metal != null ? opts.metal : 0.04});
      else m = new THREE.MeshLambertMaterial({color: opts.color != null ? opts.color : 0xffffff});
      if(opts.em){ m.emissive = new THREE.Color(opts.em); m.emissiveIntensity = 0; pulseMats.push({m: m, max: opts.emMax != null ? opts.emMax : 0.9}); }
      return m;
    }
    function kindColor(k, i){
      var th = MAP.theme || {};
      if(k === "container"){ var cs = th.container || ["#a8534a", "#4a7d8c"]; return hex(cs[i % cs.length], 0x4a7d8c); }
      if(k === "catwalk") return hex(th.catwalk || "#5d6873", 0x5d6873);
      if(k === "crate") return hex(th.crate || "#8c734a", 0x8c734a);
      if(k === "adobe"){ var as = th.adobe || ["#d2b078", "#c8a468"]; return hex(as[i % as.length], 0xd2b078); }
      if(k === "divider") return hex(th.divider || "#c4a06a", 0xc4a06a);
      if(k === "silo") return hex(th.silo || "#e8d4a8", 0xe8d4a8);
      if(k === "dome") return hex(th.dome || "#e0c898", 0xe0c898);
      if(k === "pillar") return hex(th.pillar || "#b89860", 0xb89860);
      if(k === "curb") return hex(th.curb || "#a88850", 0xa88850);
      if(k === "step") return hex(th.step || "#d8bc8c", 0xd8bc8c);
      if(k === "ledge") return hex(th.ledge || "#e8d4a8", 0xe8d4a8);
      if(k === "rock") return hex(th.rock || "#8a7458", 0x8a7458);
      if(k === "sand") return hex(th.sand || "#d8bc8c", 0xd8bc8c);
      if(k === "shed") return hex(th.shed || "#b89860", 0xb89860);
      return null;    // the rest keeps the kit's own look
    }
    // Original desert architecture meshes (procedural three.js geometry — no third-party assets).
    function duneBox(sx, sy, sz, col, rough){
      return new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), mat({color: col != null ? col : 0xd2b078, rough: rough != null ? rough : 0.92, metal: 0.0}));
    }
    function duneCyl(rt, rb, h, col, seg){
      return new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg || 16), mat({color: col != null ? col : 0xe8d4a8, rough: 0.88, metal: 0.0}));
    }
    function duneModel(k, sx, sy, sz, col, acc){
      var g = new THREE.Group();
      if(k === "silo"){
        var r = Math.max(sx, sz)*0.5;
        var body = duneCyl(r, r*1.06, sy, col, 18); body.position.y = sy/2; g.add(body);
        var cap = duneCyl(r*0.92, r, Math.min(0.35, sy*0.12), acc != null ? acc : 0xf0e0b8, 18); cap.position.y = sy + Math.min(0.18, sy*0.06); g.add(cap);
        return g;
      }
      if(k === "dome"){
        var base = duneBox(sx, sy*0.55, sz, col); base.position.y = sy*0.275; g.add(base);
        var dome = new THREE.Mesh(new THREE.SphereGeometry(Math.max(sx, sz)*0.48, 16, 10, 0, Math.PI*2, 0, Math.PI/2),
          mat({color: acc != null ? acc : 0xe0c898, rough: 0.85, metal: 0}));
        dome.position.y = sy*0.55; g.add(dome);
        return g;
      }
      if(k === "pillar"){
        var col2 = duneCyl(Math.min(sx, sz)*0.5, Math.min(sx, sz)*0.55, sy, col, 10); col2.position.y = sy/2; g.add(col2);
        var capP = duneBox(sx*1.15, Math.min(0.18, sy*0.08), sz*1.15, acc != null ? acc : 0xc8a468); capP.position.y = sy - Math.min(0.09, sy*0.04); g.add(capP);
        return g;
      }
      if(k === "crate"){
        var body = duneBox(sx, sy, sz, col, 0.8);
        var band = duneBox(sx*1.04, Math.min(0.1, sy*0.12), sz*1.04, acc != null ? acc : 0xa88850, 0.8);
        band.position.y = sy*0.55; g.add(body); g.add(band);
        return g;
      }
      if(k === "curb" || k === "step" || k === "ledge"){
        var slab = duneBox(sx, sy, sz, col, 0.9);
        if(k === "ledge"){
          var lip = duneBox(sx, Math.min(0.1, sy*0.15), sz, acc != null ? acc : 0xf0e0b8, 0.85);
          lip.position.y = sy/2 + 0.02; g.add(lip);
        }
        g.add(slab);
        return g;
      }
      if(k === "rock"){
        var rock = duneBox(sx, sy, sz, col, 0.98);
        rock.rotation.y = 0.04;
        g.add(rock);
        return g;
      }
      // adobe / divider / sand / block: a flat mass with a slightly lighter cap band
      var wall = duneBox(sx, sy, sz, col, 0.93); g.add(wall);
      if(k === "adobe" || k === "divider"){
        var band2 = duneBox(sx*1.02, Math.min(0.16, sy*0.1), sz*1.02, acc != null ? acc : 0xe8d4a8, 0.88);
        band2.position.y = sy*0.82; g.add(band2);
      }
      return g;
    }
    function boxModel(b, idx){
      var kind = String(b[6] || "block");
      var sx = b[3] - b[0], sy = b[4] - b[1], sz = b[5] - b[2], g = new THREE.Group();
      var kc = kindColor(kind, idx);
      if(isDuneKind(kind)){
        var dg = duneModel(kind, sx, sy, sz, kc, kindColor(kind === "adobe" ? "ledge" : "adobe", idx + 1));
        g.add(dg);
        g.position.set((b[0] + b[3])/2, b[1], (b[2] + b[5])/2);
        return g;
      }
      var k = KIND[kind] || KIND.block, name = k[0], bb = BB[name] || (BB[name] = bbox(name));
      var along = name.indexOf("wall") === 0 && sz > sx;           // walls: the long side runs along x in the model
      var L = along ? sz : sx, D = along ? sx : sz;
      var nL = Math.max(1, Math.round(L/k[1])), nD = name.indexOf("wall") === 0 ? 1 : Math.max(1, Math.round(D/k[1]));
      var mw = bb.max.x - bb.min.x, mh = bb.max.y - bb.min.y, md = bb.max.z - bb.min.z;
      // containers, catwalks and crates get one flat colour so the lanes read at a glance
      for(var i = 0; i < nL; i++) for(var j = 0; j < nD; j++){
        var o = model(name), tl = L/nL, td = D/nD, ov = name.indexOf("wall") === 0 ? 1.12 : 1.04;
        if(kc != null) o.traverse(function(n){ if(n.isMesh){ n.material = n.material.clone(); n.material.color.setHex(kc); } });
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
    var pickMeshes = [], droneMeshes = [], mdMeshes = [], hookLine = null;
    // a beacon so every live pickup is findable from anywhere: a tall, thin, additive light
    // column soaring above the fog (fog:false so it stays legible across the whole map),
    // brightest at the base and fading to nothing at the top
    function beacon(c){
      var b = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.30, 26, 10, 1, true),
        new THREE.MeshBasicMaterial({color: c, transparent: true, opacity: 0.5, fog: false,
                                     side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending}));
      b.position.y = 13; b.renderOrder = 4; return b;
    }
    function buildMap(){
      if(mapGroup){ scene.remove(mapGroup); }
      mapGroup = new THREE.Group(); scene.add(mapGroup);
      var th = MAP.theme || {};
      scene.background = new THREE.Color(hex(th.sky, 0x33415c));
      scene.fog = new THREE.Fog(hex(th.fog, 0x3d4d63), V.low ? 25 : (ULTRA ? 42 : 36), V.low ? 70 : (ULTRA ? 170 : 120));
      var under = new THREE.Mesh(new THREE.PlaneGeometry(420, 420).rotateX(-Math.PI/2), mat({color: hex(th.ground, 0x5b6670), rough: 0.95, metal: 0}));
      under.position.y = -1.2; mapGroup.add(under);
      // a simple sky backdrop: a big gradient shell behind the fog, tinted by the theme (no skybox texture → IP-safe)
      if(ULTRA){
        var cvs = document.createElement("canvas"); cvs.width = 4; cvs.height = 128; var gg = cvs.getContext("2d");
        var grd = gg.createLinearGradient(0, 0, 0, 128);
        grd.addColorStop(0, th.skyTop || th.sky || "#22304a"); grd.addColorStop(0.55, th.sky || "#33415c"); grd.addColorStop(1, th.skyBottom || th.ground || "#5b6670");
        gg.fillStyle = grd; gg.fillRect(0, 0, 4, 128);
        var skyt = new THREE.CanvasTexture(cvs); skyt.colorSpace = THREE.SRGBColorSpace;
        var skyd = new THREE.Mesh(new THREE.SphereGeometry(240, 24, 16), new THREE.MeshBasicMaterial({map: skyt, side: THREE.BackSide, fog: false, depthWrite: false}));
        skyd.renderOrder = -1; mapGroup.add(skyd);
      }
      MAP.boxes.forEach(function(b, i){ mapGroup.add(boxModel(b, i)); });
      // one glowing strip per long top edge (the theme's accent): dock cranes on the harbour,
      // doorway lintels along the compound walls
      var acc = hex(th.accent || "#ffb86b", 0xffb86b);
      MAP.boxes.forEach(function(b, idx){
        var kk = String(b[6] || "");
        if(kk !== "container" && kk !== "catwalk" && kk !== "adobe" && kk !== "divider") return;
        var sx = b[3] - b[0], sz = b[5] - b[2], horiz = sx >= sz;
        var strip = new THREE.Mesh(new THREE.BoxGeometry(horiz ? sx : 0.08, 0.1, horiz ? 0.08 : sz), mat({color: 0x0a0e14, em: acc, emMax: 1.05}));
        strip.position.set((b[0] + b[3])/2, b[4] + 0.06, (b[2] + b[5])/2); mapGroup.add(strip);
      });
      if(!V.low){
        // grass tufts as dock weeds between the boxes, placed by a fixed hash so everyone sees the same dock
        for(var i = 0; i < 60; i++){
          var x = -20 + hash(i, 7)*40, z = -14 + hash(i, 13)*28;
          if(FS.overlaps(MAP, x, 0.05, z, 0.2) >= 0) continue;
          var gr = model("grass"); gr.position.set(x, 0, z); gr.rotation.y = hash(i, 3)*6.28; gr.scale.setScalar(1.2); mapGroup.add(gr);
        }
      }
      pickMeshes.forEach(function(p){ scene.remove(p); }); pickMeshes = [];
      MAP.pickups.forEach(function(pk, i){
        if(!pk.kind && i >= BASE_PACKS) return;   // an empty drop slot: no crate until a drop lands
        var gp = new THREE.Group(), base = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5),
          mat({color: pk.kind === "health" ? 0xf4f4f4 : 0x3c7a3a, rough: 0.4, metal: 0.25}));
        gp.add(base);
        if(pk.kind === "health"){
          var red = mat({color: 0xe0574a, em: PBR ? 0xe0574a : null, emMax: 0.7, rough: 0.5});
          gp.add(new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.14, 0.36), red)); gp.add(new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.36, 0.52), red).rotateY(0));
          gp.add(new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.14, 0.52), red)); gp.add(new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.52, 0.36), red));
        } else {
          var gold = mat({color: 0xe0b325, em: PBR ? 0xe0b325 : null, emMax: 0.7, rough: 0.35, metal: 0.6});
          gp.add(new THREE.Mesh(new THREE.BoxGeometry(0.54, 0.12, 0.54), gold));
        }
        gp.add(beacon(pk.kind === "health" ? 0xf4f4f4 : 0xe0b325));
        gp.position.set(pk.at[0], pk.at[1] + 0.55, pk.at[2]); scene.add(gp); pickMeshes.push(gp);
      });
      droneMeshes.forEach(function(d){ scene.remove(d); }); droneMeshes = [];
      MAP.targets.forEach(function(){ var d = model("enemy-flying"); d.scale.setScalar(1.5); d.visible = false; scene.add(d); droneMeshes.push(d); });
      mdMeshes.forEach(function(d){ scene.remove(d); }); mdMeshes = [];
      for(var mdk = 0; mdk < (FS.DRONE_N|0 || 8); mdk++){
        var md = model("enemy-flying"); md.scale.setScalar(1.35); md.visible = false; scene.add(md); mdMeshes.push(md);
      }
    }
    // the name tag: the dot keeps the side's own colour, the NAME carries friend/foe —
    // enemies read red (shoot on sight), team-mates read your side's colour (hold fire)
    function tag(text, dot, nameCol, bot){
      var c = document.createElement("canvas"), g = c.getContext("2d"); c.width = 256; c.height = 64;
      g.font = "700 30px sans-serif"; g.textAlign = "center"; g.textBaseline = "middle";
      var w = Math.min(250, g.measureText(text).width + 40);
      g.fillStyle = "rgba(20,24,32,0.72)"; g.beginPath(); if(g.roundRect) g.roundRect(128 - w/2, 8, w, 48, 18); else g.rect(128 - w/2, 8, w, 48); g.fill();
      g.fillStyle = dot; g.beginPath(); g.arc(128 - w/2 + 18, 32, 7, 0, Math.PI*2); g.fill();
      g.fillStyle = nameCol; g.fillText(text + (bot ? " ▦" : ""), 136, 33);
      var tx = new THREE.CanvasTexture(c); tx.colorSpace = THREE.SRGBColorSpace;
      var sp = new THREE.Sprite(new THREE.SpriteMaterial({map: tx, depthTest: true, transparent: true})); sp.scale.set(1.6, 0.4, 1); sp.renderOrder = 10;
      return sp;
    }
    // a floating damage number: ONE entry per hit — sprite + state on the same object.
    // There is no separate descriptor list to keep in step: fire() drops
    //   {x,y,z, at, o:null} and this render block owns .o (the sprite) from creation
    //   to disposal. An entry with o === null is always "needs a sprite this frame".
    function dmgSprite(n, head){
      var c = document.createElement("canvas"), g = c.getContext("2d"); c.width = 128; c.height = 64;
      g.font = "900 " + (head ? 44 : 32) + "px sans-serif"; g.textAlign = "center"; g.textBaseline = "middle";
      g.strokeStyle = "rgba(0,0,0,0.65)"; g.lineWidth = 5; g.strokeText(String(n), 64, 32);
      g.fillStyle = head ? "#ff453a" : "#ffe9c9"; g.fillText(String(n), 64, 32);
      var tx = new THREE.CanvasTexture(c); tx.colorSpace = THREE.SRGBColorSpace;
      var sp = new THREE.Sprite(new THREE.SpriteMaterial({map: tx, depthTest: false, transparent: true})); sp.renderOrder = 20;
      sp.scale.set(head ? 1.6 : 1.1, head ? 0.8 : 0.55, 1);
      return sp;
    }
    var CH_H = null;
    // the body meshes carry no usable texture in three (their GLTF baseColorTexture rides
    // on KHR_texture_transform, which the vendored loader ignores), so they shade off
    // material.color alone. Painting the kit is therefore setting a flat team colour on a
    // per-clone copy of the body material — clothes read Amber/Cyan outright, faces and
    // hair keep their own shading, nothing has to be blitted or re-uploaded.
    var KITS = [{}, {}];
    function kitMat(ch, team){
      team = team ? 1 : 0; ch = ch|0;
      if(KITS[team][ch]) return KITS[team][ch];
      var src = null;
      GL[CHARS[ch].f] && GL[CHARS[ch].f].scene.traverse(function(n){ if(!src && n.isMesh && n.name === "body-mesh" && n.material) src = n.material; });
      if(!src) return null;
      src = src.clone();
      src.color = src.color.clone().lerp(new THREE.Color(TEAMS[team].rgb), 0.85);
      KITS[team][ch] = src; return src;
    }
    function addPlayer(P){
      var g = GL[CHARS[P.ch|0].f]; if(!g) return;
      if(CH_H === null){ var hb = new THREE.Box3().setFromObject(g.scene); CH_H = Math.max(0.3, hb.max.y - hb.min.y); }
      var o = lib.clone(g.scene), holder = new THREE.Group(); holder.add(o);
      o.scale.setScalar(1.75/CH_H);
      // the team kit swaps the whole-body tint in on the body mesh only — the head
      // (face, hair) keeps its own colours
      var teamKit = kitMat(P.ch|0, P.team|0);
      o.traverse(function(n){ if(n.isMesh){
        n.castShadow = !V.low; n.frustumCulled = false;
        if(teamKit && n.name === "body-mesh") n.material = teamKit;
      } });
      var mixer = new THREE.AnimationMixer(o), acts = {};
      ["idle", "walk", "die"].forEach(function(n){ var cl = THREE.AnimationClip.findByName(g.animations, n); if(cl) acts[n] = mixer.clipAction(cl); });
      if(acts.die){ acts.die.setLoop(THREE.LoopOnce, 1); acts.die.clampWhenFinished = true; }
      // the weapon is held out in front at the right hand (barrel along the model's +z, its facing)
      var gun = [model("blaster-repeater"), gunMarksman(), gunRevolver(), gunLauncher()];
      var skin = P.cos && hex(P.cos.blaster, null);
      gun.forEach(function(gn, i){ gn.scale.setScalar(0.34); gn.position.set(-0.36, 0.74, 0.3); gn.visible = i === 0; holder.add(gn);
        if(skin != null) gn.traverse(function(n){ if(n.isMesh){ n.material = n.material.clone(); n.material.color.setHex(skin); } }); });
      // the team ring at the feet: amber or cyan, always readable
      var ring = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.55, 24).rotateX(-Math.PI/2),
        new THREE.MeshBasicMaterial({color: TEAMS[P.team|0].rgb, transparent: true, opacity: 0.85}));
      ring.position.y = 0.03; holder.add(ring);
      // the drop shield: a light-blue bubble that wraps a glider for their descent —
      // nothing gets in, they still shoot out (hidden unless the shield is up)
      var shield = new THREE.Mesh(new THREE.SphereGeometry(1.05, 20, 14),
        new THREE.MeshBasicMaterial({color: hex(SHIELD_COLOR, 0x7fd4ff), transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide}));
      shield.position.y = 0.95; shield.visible = false; holder.add(shield);
      // friend or foe at a glance: the name reads red on enemies, your side's colour on
      // team-mates (the dot stays the side's own colour either way)
      var foe = P.team !== V.team;
      var tg = tag(P.name.slice(0, 18), TEAMS[P.team|0].c, foe ? "#ff5544" : TEAMS[V.team|0].c, P.bot); tg.position.set(0, 2.15, 0); holder.add(tg);
      P.mesh = {g: holder, mixer: mixer, acts: acts, cur: null, gun: gun, tag: tg, ring: ring, shield: shield,
                ch: P.ch, team: P.team, bot: P.bot, foe: foe}; scene.add(holder);
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
    function clearDynamic(){ if(typeof fxStop === "function") fxStop();
      tracers.concat(puffs).forEach(function(x){ dyn.remove(x.o); }); tracers = []; puffs = [];
      (riftGroups || []).forEach(function(g){ scene.remove(g); }); riftGroups = [];
      (ringMeshes || []).forEach(function(r){ dyn.remove(r.o); }); ringMeshes = [];
      (V.dmgNums || []).forEach(function(D){ if(D.o){ dyn.remove(D.o); D.o.material.map.dispose(); D.o.material.dispose(); D.o = null; } }); V.dmgNums = [];
      if(wardenGroup){ dyn.remove(wardenGroup); wardenGroup = null; wardenParts = null; }
      V.order.forEach(function(u){ removePlayer(V.players[u]); }); }
    var wardenGroup = null, wardenParts = null, wardenLaser = null, wardenRings = [], wardenDust = [];
    function wardenDustTex(){
      if(wardenDustTex._t) return wardenDustTex._t;
      var c = document.createElement("canvas"), g = c.getContext("2d");
      c.width = 32; c.height = 32;
      var gr = g.createRadialGradient(16, 16, 1, 16, 16, 15);
      gr.addColorStop(0, "rgba(220,190,140,0.9)");
      gr.addColorStop(0.5, "rgba(180,140,90,0.55)");
      gr.addColorStop(1, "rgba(140,100,60,0)");
      g.fillStyle = gr; g.fillRect(0, 0, 32, 32);
      wardenDustTex._t = new THREE.CanvasTexture(c);
      wardenDustTex._t.colorSpace = THREE.SRGBColorSpace;
      return wardenDustTex._t;
    }
    function wardenDustBurst(pts, t0){
      if(!pts || !pts.length) return;
      var tex = wardenDustTex(), pi, i;
      for(pi = 0; pi < pts.length; pi++){
        var p = pts[pi];
        for(i = 0; i < 14; i++){
          var ja = (i / 14) * Math.PI * 2 + (pi * 0.4);
          var sp = new THREE.Sprite(new THREE.SpriteMaterial({map: tex, transparent: true, depthWrite: false, opacity: 0.7, fog: false}));
          sp.position.set(p.x, 0.25, p.z);
          sp.scale.setScalar(1.2 + (i % 4) * 0.3);
          dyn.add(sp);
          wardenDust.push({o: sp, at: t0, x: p.x, z: p.z,
            vx: Math.cos(ja) * (6 + (i % 3) * 2), vz: Math.sin(ja) * (6 + (i % 3) * 2),
            s0: 1.2 + (i % 4) * 0.3});
        }
      }
    }
    function wardenDustTick(t, quiet){
      for(var di = wardenDust.length - 1; di >= 0; di--){
        var D = wardenDust[di], da = (t - D.at) / 0.7;
        if(da >= 1){ dyn.remove(D.o); wardenDust.splice(di, 1); continue; }
        if(!quiet){
          D.o.position.x = D.x + D.vx * (da * 0.7);
          D.o.position.z = D.z + D.vz * (da * 0.7);
          D.o.position.y = 0.25 + da * 1.5;
        }
        D.o.scale.setScalar(D.s0 * (1 + da * 2.2));
        if(D.o.material) D.o.material.opacity = 0.7 * (1 - da);
      }
    }
    function wardenDustClear(){
      for(var di = 0; di < wardenDust.length; di++){ dyn.remove(wardenDust[di].o); }
      wardenDust = [];
    }
    function wmat(c, e){ return new THREE.MeshLambertMaterial({color: c, emissive: e || 0x000000}); }
    function wardenBuild(W){
      if(wardenGroup){ dyn.remove(wardenGroup); wardenGroup = null; wardenParts = null; }
      if(wardenLaser){ dyn.remove(wardenLaser); wardenLaser = null; }
      wardenRings.forEach(function(r){ dyn.remove(r.o); }); wardenRings = [];
      wardenDustClear();
      if(!W) return;
      // Giant carved totem-golem: waist-to-head only (no legs), fused to a rubble skirt.
      // Silhouette follows the hit volumes (waist / chest / head / two heavy arms).
      var g = new THREE.Group();
      var stone = 0x3a4150, iron = 0x252b36, trim = 0xc9a227, glow = 0xff2a3a, dark = 0x1a1f28;
      function part(w, h, d, x, y, z, c, e){
        var m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), wmat(c, e));
        m.position.set(x || 0, y || 0, z || 0);
        return m;
      }
      var skirt = part(18.6, 2.4, 12.0, 0, 1.2, 0, iron);
      var skirt2 = part(15.0, 1.8, 9.6, 0, 3.0, 0.3, stone);
      var waist = part(12.6, 4.5, 8.4, 0, 5.1, 0, stone);
      var chest = part(15.6, 6.9, 9.0, 0, 9.0, 0, stone);
      var plate = part(10.2, 5.1, 0.9, 0, 9.0, 4.65, iron);
      var sigil = part(2.4, 2.4, 0.45, 0, 9.3, 5.25, trim, 0x332200);
      var paulL = part(5.4, 3.6, 6.0, -9.3, 11.7, 0, iron);
      var paulR = part(5.4, 3.6, 6.0, 9.3, 11.7, 0, iron);
      var head = part(6.6, 4.8, 6.0, 0, 14.1, 0.45, stone);
      var brow = part(7.2, 1.2, 1.65, 0, 16.05, 2.25, iron);
      var jawM = part(5.1, 1.5, 3.9, 0, 12.15, 1.2, dark);
      var crest = part(1.65, 1.8, 4.5, 0, 16.8, 0, trim, 0x221100);
      var eyeL = part(1.2, 0.72, 0.54, -1.5, 14.55, 3.3, glow, 0x440000);
      var eyeR = part(1.2, 0.72, 0.54, 1.5, 14.55, 3.3, glow, 0x440000);
      // heavy arms: shoulder + elbow so the slam is a hinge from elbow to fist
      function heavyArm(side){
        var piv = new THREE.Group();
        piv.position.set(side * WARDEN_ARM_X, 11.7, 0);
        var delt = part(5.4, 2.4, 5.4, 0, -0.6, 0, stone);
        var upper = part(4.2, 7.8, 4.3, 0, -3.9, 0, iron);
        var elbow = new THREE.Group();
        elbow.position.set(0, -8.1, 0);
        var hinge = part(3.6, 1.8, 3.9, 0, 0, 0, trim, 0x221100);
        var fore = part(3.6, 6.6, 3.9, 0, -3.6, 0.4, stone);
        var fist = part(4.8, 3.6, 5.1, 0, -7.5, 0.7, iron);
        var knuckle = part(3.9, 1.35, 4.2, 0, -9.1, 1.1, trim, 0x221100);
        elbow.add(hinge); elbow.add(fore); elbow.add(fist); elbow.add(knuckle);
        piv.add(delt); piv.add(upper); piv.add(elbow);
        return {piv: piv, elbow: elbow};
      }
      var armL = heavyArm(-1), armR = heavyArm(1);
      g.add(skirt); g.add(skirt2); g.add(waist); g.add(chest); g.add(plate); g.add(sigil);
      g.add(paulL); g.add(paulR); g.add(head); g.add(brow); g.add(jawM); g.add(crest);
      g.add(eyeL); g.add(eyeR); g.add(armL.piv); g.add(armR.piv);
      g.traverse(function(n){ if(n.isMesh){ n.castShadow = !V.low; n.frustumCulled = false; } });
      g.position.set(W.x, 0, W.z);
      g.scale.setScalar(1);
      dyn.add(g);
      wardenGroup = g;
      wardenParts = {armL: armL, armR: armR, eyeL: eyeL, eyeR: eyeR, head: head, chest: chest, sigil: sigil, jaw: jawM, group: g};
    }
    function wardenClear(){
      if(wardenGroup){ dyn.remove(wardenGroup); wardenGroup = null; wardenParts = null; }
      if(wardenLaser){ dyn.remove(wardenLaser); wardenLaser = null; }
      wardenRings.forEach(function(r){ dyn.remove(r.o); }); wardenRings = [];
      wardenDustClear();
    }
    function wardenSync(W, t){
      if(!W){ wardenClear(); return; }
      if(!wardenGroup) wardenBuild(W);
      if(!wardenParts) return;
      if(t == null) t = now();
      var quiet = calm();
      wardenGroup.position.x = W.x; wardenGroup.position.z = W.z;
      wardenGroup.rotation.y = W.yaw || 0;
      // rise out of the ground over 0.8s (deterministic ease)
      var born = (W.born != null) ? W.born : t;
      var u = clamp((t - born) / 0.8, 0, 1);
      var pop = u * u * (3 - 2 * u);
      wardenGroup.scale.setScalar(Math.max(0.02, pop));
      wardenGroup.position.y = quiet ? 0 : Math.sin(t * 1.3) * 0.08;
      // arms: idle sway → telegraph lift → bend-down slam; a disabled arm hangs limp
      var lift = 0, slamK = 0, slamAt = wardenParts.slamAt || 0;
      if(W.slabArm > 0 && t < W.slabArm){
        lift = clamp(1 - (W.slabArm - t) / Math.max(0.05, WARDEN_SLAB_ARM), 0, 1) * 1.35;
      } else if(slamAt > 0 && t >= slamAt && t < slamAt + 0.35){
        // downswing: arms fall from full lift to the floor over 0.35s
        slamK = 1 - (t - slamAt) / 0.35;
        lift = 1.35 * slamK * slamK;
      }
      // torso hinge: rear back on the wind-up, then bend down into the slam
      var bend = 0;
      if(W.slabArm > 0 && t < W.slabArm) bend = -0.16 * (lift / 1.35);
      else if(slamAt > 0 && t >= slamAt && t < slamAt + 0.45) bend = Math.sin(((t - slamAt) / 0.45) * Math.PI) * 0.42;
      wardenGroup.rotation.x = quiet ? (bend * 0.5) : bend;
      if(!quiet){
        wardenParts.head.rotation.y = Math.sin(t * 0.7) * 0.06;
        wardenParts.sigil.rotation.z = Math.sin(t * 2.1) * 0.1;
        wardenParts.jaw.rotation.x = 0.04 + Math.sin(t * 1.6) * 0.04;
      }
      // Exposed Core: the sigil is the chest core — it glows / sparks while open
      if(wardenParts.sigil && wardenParts.sigil.material){
        var coreOpen = !!(W.coreUntil && t < W.coreUntil);
        var sm = wardenParts.sigil.material;
        if(coreOpen){
          sm.emissive.setHex(0xff2a3a);
          sm.color.setHex(0xff6a4a);
          if(!quiet){
            var pk = 0.55 + 0.45 * Math.sin(t * 9.0);
            sm.emissiveIntensity = 0.4 + pk * 0.8;
            wardenParts.sigil.scale.setScalar(1 + pk * 0.08);
          }
        } else {
          sm.emissive.setHex(0x332200);
          sm.color.setHex(0xc9a227);
          sm.emissiveIntensity = 1;
          wardenParts.sigil.scale.setScalar(1);
        }
      }
      function poseArm(arm, alive, side){
        if(!arm || !arm.piv) return;
        var piv = arm.piv, elbow = arm.elbow;
        if(!alive){
          // limp: hang, twist outward, and droop
          piv.rotation.x = 0.55;
          piv.rotation.y = side * 0.35;
          piv.rotation.z = side * 0.85;
          piv.position.x = side * WARDEN_ARM_X;
          piv.position.y = 11.7;
          piv.position.z = 0;
          if(elbow){ elbow.rotation.x = -0.35; elbow.rotation.y = 0; elbow.rotation.z = 0; }
          return;
        }
        var use = 0;
        if(W.slamArm === 2) use = lift;
        else if(W.slamArm === 0 && side < 0) use = lift;
        else if(W.slamArm === 1 && side > 0) use = lift;
        else if(slamAt > 0 && t >= slamAt && t < slamAt + 0.35) use = lift;
        // multi-axis idle so the arms swing in all directions, not just top-down
        var idleX = quiet ? 0 : Math.sin(t * 1.1 + side) * 0.06;
        var idleY = quiet ? 0 : Math.sin(t * 0.85 + side * 1.7) * 0.18;
        var idleZ = quiet ? 0 : Math.cos(t * 0.95 + side * 0.6) * 0.05;
        var swayX = quiet ? 0 : Math.sin(t * 0.55 + side * 2.1) * 0.14;
        var swayZ = quiet ? 0 : Math.cos(t * 0.7 + side * 1.3) * 0.12;
        // hanging arm is -Y; negative x-rot raises the fist overhead
        piv.rotation.x = -use * 1.2 + (use <= 0.02 ? 0.08 : 0) + idleX;
        piv.rotation.y = idleY + (use > 0.02 ? side * use * 0.15 : 0);
        piv.rotation.z = side * (0.12 + use * 0.22) + idleZ;
        piv.position.x = side * WARDEN_ARM_X + (quiet ? 0 : swayX);
        piv.position.y = 11.7;
        piv.position.z = quiet ? 0 : swayZ;
        // elbow: cocked on the wind-up, then uncocks so the forearm-to-hand segment slams.
        // Hanging arm is -Y; NEGATIVE x-rot folds the forearm toward the face (human elbow).
        var eK = 0.12 + idleX * 0.4;
        if(use > 0.02 && !(slamAt > 0 && t >= slamAt)) eK = 1.05 * (use / 1.35);
        else if(slamAt > 0 && t >= slamAt && t < slamAt + 0.35) eK = 1.05 * slamK;
        if(elbow){
          elbow.rotation.x = -eK;
          elbow.rotation.y = idleY * 0.35;
          elbow.rotation.z = side * 0.08 + idleZ * 0.5;
        }
      }
      poseArm(wardenParts.armL, W.armL > 0, -1);
      poseArm(wardenParts.armR, W.armR > 0, 1);
      // expire ground warn / slam rings (a ring may grow outward while it fades)
      for(var ri = wardenRings.length - 1; ri >= 0; ri--){
        var ra = t - wardenRings[ri].at;
        if(ra > wardenRings[ri].dur){ dyn.remove(wardenRings[ri].o); wardenRings.splice(ri, 1); continue; }
        if(wardenRings[ri].o.material) wardenRings[ri].o.material.opacity = 0.8 * (1 - ra / Math.max(0.05, wardenRings[ri].dur));
        if(wardenRings[ri].grow){
          var gk = ra / Math.max(0.05, wardenRings[ri].dur);
          wardenRings[ri].o.scale.setScalar(1 + gk * 0.35);
        }
      }
      wardenDustTick(t, quiet);
      // laser eyes: amber warn, then a sweeping beam along laserYaw (kill band = same dir)
      var firing = (W.laserOn > 0 && W.laserWarn > 0 && t >= W.laserWarn && t < W.laserOn);
      var preWarn = (W.laserWarn > 0 && W.laserOn > 0 && t < W.laserWarn);
      var eyeC = firing ? 0xff6677 : (preWarn ? 0xffbb33 : 0xff2a3a);
      var eyeE = firing ? 0xcc0022 : (preWarn ? 0x664400 : 0x330000);
      if(wardenParts.eyeL && wardenParts.eyeL.material){
        wardenParts.eyeL.material.color.setHex(eyeC);
        if(wardenParts.eyeL.material.emissive) wardenParts.eyeL.material.emissive.setHex(eyeE);
      }
      if(wardenParts.eyeR && wardenParts.eyeR.material){
        wardenParts.eyeR.material.color.setHex(eyeC);
        if(wardenParts.eyeR.material.emissive) wardenParts.eyeR.material.emissive.setHex(eyeE);
      }
      if(firing || preWarn){
        // he looks down at the floor while the eyes run
        wardenParts.head.rotation.x = 0.55;
      } else {
        wardenParts.head.rotation.x = quiet ? 0 : Math.sin(t * 1.6) * 0.04;
      }
      if(firing){
        if(!wardenLaser){
          var geo = new THREE.CylinderGeometry(0.16, 0.32, 1, 8, 1, true);
          geo.translate(0, 0.5, 0);
          geo.rotateX(Math.PI/2); // length along +Z
          wardenLaser = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
            color: 0xff2040, transparent: true, opacity: 0.7, depthWrite: false, fog: false, side: THREE.DoubleSide
          }));
          dyn.add(wardenLaser);
        }
        var yaw = W.laserYaw || 0;
        var eyeY = WARDEN_SEE_HEAD;
        // stay on the map: the beam stops at the arena edge, never off into the void
        var runLen = mapLaserRun(W.x, W.z, yaw);
        // ground laser: slant from the eyes down to the floor along laserYaw
        var pitchDown = Math.atan2(eyeY, runLen);
        var slant = Math.sqrt(runLen * runLen + eyeY * eyeY);
        wardenLaser.visible = true;
        wardenLaser.position.set(W.x, eyeY, W.z);
        // +Z is the beam: yaw around Y, then pitch it down onto the ground
        wardenLaser.rotation.set(pitchDown, Math.PI/2 - yaw, 0);
        var beamW = WARDEN_SCALE * (1 + (quiet ? 0 : Math.sin(t * 28) * 0.15));
        wardenLaser.scale.set(beamW, beamW, slant);
      } else if(wardenLaser){
        wardenLaser.visible = false;
      }
    }
    function wardenRise(W){ wardenBuild(W); }
    function wardenSlamArm(arm, t){
      // ground telegraph rings under the arm(s) that will slam
      if(!arm && arm !== 0) return;
      var W = V.warden; if(!W) return;
      var pts = [];
      if(arm === 0 || arm === 2) pts.push(W.x - WARDEN_ARM_X);
      if(arm === 1 || arm === 2) pts.push(W.x + WARDEN_ARM_X);
      pts.forEach(function(px){
        var rg = new THREE.Mesh(new THREE.RingGeometry(WARDEN_SLAB_R - 0.25, WARDEN_SLAB_R, 36).rotateX(-Math.PI/2),
          new THREE.MeshBasicMaterial({color: 0xff3344, transparent: true, opacity: 0.7, side: THREE.DoubleSide, depthWrite: false, fog: false}));
        rg.position.set(px, 0.08, W.z);
        dyn.add(rg);
        wardenRings.push({o: rg, at: now(), dur: WARDEN_SLAB_ARM + 0.2});
      });
    }
    function wardenSlam(t){
      if(!V.warden) return;
      var W = V.warden, pts = [], t0 = t || now();
      if(wardenParts) wardenParts.slamAt = t0;
      if(W.slamArm === 0 || W.slamArm === 2) pts.push({x: W.x - WARDEN_ARM_X, z: W.z});
      if(W.slamArm === 1 || W.slamArm === 2) pts.push({x: W.x + WARDEN_ARM_X, z: W.z});
      pts.forEach(function(p){
        var rg = new THREE.Mesh(new THREE.RingGeometry(WARDEN_SLAB_R_HIT - 0.35, WARDEN_SLAB_R_HIT, 40).rotateX(-Math.PI/2),
          new THREE.MeshBasicMaterial({color: 0xff3344, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false, fog: false}));
        rg.position.set(p.x, 0.1, p.z);
        dyn.add(rg);
        wardenRings.push({o: rg, at: t0, dur: 0.4});
        // wider shock ring — the blast that blows people away
        var rg2 = new THREE.Mesh(new THREE.RingGeometry(WARDEN_SLAB_KNOCK - 0.3, WARDEN_SLAB_KNOCK, 40).rotateX(-Math.PI/2),
          new THREE.MeshBasicMaterial({color: 0xffaa66, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false, fog: false}));
        rg2.position.set(p.x, 0.08, p.z);
        dyn.add(rg2);
        wardenRings.push({o: rg2, at: t0, dur: 0.55});
      });
      wardenDustBurst(pts, t0);
    }
    var R = {};
    /* launcher visuals: the flying rocket and its blast, both correlations of the missiles list */
    var rockets = [], booms = [];
    var flameTex = (function(){
      var c = document.createElement("canvas"), g = c.getContext("2d"); c.width = 64; c.height = 64;
      var gr = g.createRadialGradient(32, 32, 2, 32, 32, 30);
      gr.addColorStop(0, "rgba(255,240,200,1)"); gr.addColorStop(0.35, "rgba(255,150,60,0.85)"); gr.addColorStop(1, "rgba(255,80,20,0)");
      g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
      var t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
    })();
    R.rocket = function(m, miss){  // (m, m) updates/spawns; (null, m) disposes
      if(!miss) return;
      if(!m){ var k = rockets.indexOf(miss.o); if(k >= 0){ dyn.remove(miss.o); rockets.splice(k, 1); } miss.o = null; return; }
      if(!m.o){
        var g = new THREE.Group();
        var body = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.42, 10), new THREE.MeshLambertMaterial({color: 0x4a5a46}));
        body.rotation.x = Math.PI/2; g.add(body);
        var nose = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.16, 10), new THREE.MeshLambertMaterial({color: 0xb03a2c}));
        nose.rotation.x = -Math.PI/2; nose.position.z = -0.28; g.add(nose);
        var flame = new THREE.Sprite(new THREE.SpriteMaterial({map: flameTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending}));
        flame.position.z = 0.30; flame.scale.setScalar(0.5); g.add(flame);
        g.userData.flame = flame; m.o = g; dyn.add(g); rockets.push(g);
      }
      m.o.position.set(m.x, m.y, m.z);
      m.o.lookAt(m.x - m.vx, m.y - m.vy, m.z - m.vz);  // nose (-z local) points along travel
      var fl = m.o.userData.flame; if(fl) fl.scale.setScalar(0.4 + FS.mb32(((now() * 977)|0) & 0xFFFF)*0.35);
    };
    var boomTex = (function(){
      var c = document.createElement("canvas"), g = c.getContext("2d"); c.width = 128; c.height = 128;
      var gr = g.createRadialGradient(64, 64, 4, 64, 64, 62);
      gr.addColorStop(0, "rgba(255,236,190,1)"); gr.addColorStop(0.3, "rgba(255,160,70,0.95)"); gr.addColorStop(0.62, "rgba(220,80,30,0.55)"); gr.addColorStop(1, "rgba(120,40,20,0)");
      g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
      var t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
    })();
    R.boom = function(x, y, z, t){
      var sp = new THREE.Sprite(new THREE.SpriteMaterial({map: boomTex, transparent: true, depthWrite: false}));
      sp.position.set(x, y, z); sp.scale.setScalar(1.2); dyn.add(sp);
      booms.push({o: sp, at: t});
      if(booms.length > 6){ var b0 = booms.shift(); dyn.remove(b0.o); }
    };
    function boomsTick(t, quiet){
      for(var i = booms.length - 1; i >= 0; i--){
        var a = t - booms[i].at;
        if(a > 0.45){ dyn.remove(booms[i].o); booms.splice(i, 1); continue; }
        booms[i].o.material.opacity = 1 - a/0.45;
        if(!quiet) booms[i].o.scale.setScalar(1.2 + a*16);
      }
    }
    R.buildMap = buildMap; R.removePlayer = removePlayer; R.tracer = tracer; R.clearDynamic = clearDynamic;
    R.wardenRise = wardenRise; R.wardenSync = wardenSync; R.wardenClear = wardenClear;
    R.wardenSlamArm = wardenSlamArm; R.wardenSlam = wardenSlam;
    R.wardenShock = function(t){
      var W = V.warden; if(!W) return;
      var t0 = t || now();
      var rg = new THREE.Mesh(new THREE.RingGeometry(2.0, 2.4, 40).rotateX(-Math.PI/2),
        new THREE.MeshBasicMaterial({color: 0xffcc66, transparent: true, opacity: 0.7, side: THREE.DoubleSide, depthWrite: false, fog: false}));
      rg.position.set(W.x, 0.1, W.z);
      dyn.add(rg);
      wardenRings.push({o: rg, at: t0, dur: 0.7, grow: WARDEN_CK1_PUSH});
    };
    R.wardenGrip = function(t){
      var W = V.warden; if(!W) return;
      var t0 = t || now();
      var rg = new THREE.Mesh(new THREE.RingGeometry(WARDEN_GRIP_R - 0.5, WARDEN_GRIP_R, 48).rotateX(-Math.PI/2),
        new THREE.MeshBasicMaterial({color: 0x9b6bff, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false, fog: false}));
      rg.position.set(W.x, 0.08, W.z);
      dyn.add(rg);
      wardenRings.push({o: rg, at: t0, dur: WARDEN_GRIP_HOLD});
    };
    // a totem slot is one small rotating gem: gold mole, violet paralyser, pale-cyan decoy,
    // grey cloak. Kept together with pickups under pickMeshes ([] never shrinks this match,
    // totems just claim the next index) so the bob/spin/mipmap loop covers them too
    R.addTotem = function(idx, pk){
      if(!TOTEMS[pk.kind]) return;
      var old = pickMeshes[idx]; if(old) scene.remove(old);
      var gp = new THREE.Group(), c = TOTEMS[pk.kind].c;
      var gem = new THREE.Mesh(new THREE.OctahedronGeometry(0.32),
        mat({color: c, em: PBR ? c : null, emMax: 0.8, rough: 0.25, metal: 0.4}));
      gem.position.y = 0.28; gp.add(gem);
      var ring = new THREE.Mesh(new THREE.RingGeometry(0.34, 0.44, 20).rotateX(-Math.PI/2),
        new THREE.MeshBasicMaterial({color: c, transparent: true, opacity: 0.55, side: THREE.DoubleSide}));
      ring.position.y = 0.03; gp.add(ring);
      // Hot Drop / Cursed Drop: the tag is its own beam so you can see the flavour
      // from across the deck (hot = taller gold, cursed = purple)
      var tag = pk.tag || "";
      var bc = tag === "hot" ? 0xffd43b : (tag === "cursed" ? 0x9d6bff : (tag === "dis" ? 0xff6b6b : c));
      var beam = beacon(bc);
      if(tag === "hot" || tag === "cursed" || tag === "dis") beam.scale.y = 1.8;
      gp.add(beam);
      gp.position.set(pk.at[0], pk.at[1] + 0.55, pk.at[2]); scene.add(gp); pickMeshes[idx] = gp;
    };
    // a loose pack (the PACK_GAP drop ring) is the same crate the map's fixed packs use,
    // rebuilt in place each time the ring replaces the slot
    R.addPack = function(idx, pk){
      var old = pickMeshes[idx]; if(old) scene.remove(old);
      var gp = new THREE.Group();
      var base = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5),
        mat({color: pk.kind === "health" ? 0xf4f4f4 : 0x3c7a3a, rough: 0.4, metal: 0.25}));
      gp.add(base);
      if(pk.kind === "health"){
        var red = mat({color: 0xe0574a, em: PBR ? 0xe0574a : null, emMax: 0.7, rough: 0.5});
        gp.add(new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.14, 0.36), red));
        gp.add(new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.36, 0.52), red).rotateY(0));
        gp.add(new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.14, 0.52), red));
        gp.add(new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.52, 0.36), red));
      } else {
        var gold = mat({color: 0xe0b325, em: PBR ? 0xe0b325 : null, emMax: 0.7, rough: 0.35, metal: 0.6});
        gp.add(new THREE.Mesh(new THREE.BoxGeometry(0.54, 0.12, 0.54), gold));
      }
      gp.add(beacon(pk.kind === "health" ? 0xf4f4f4 : 0xe0b325));
      gp.position.set(pk.at[0], pk.at[1] + 0.55, pk.at[2]); scene.add(gp); pickMeshes[idx] = gp;
    };
    R.charm = function(P, kind){
      if(!P || !P.mesh || !P.mesh.g) return;
      var frz = kind === "freeze";
      if(P.marks && P.marks.some(function(mk){ return mk.__freeze === frz; })) return;   // one per kind
      var c = frz ? TOTEMS.freeze.c : TOTEMS.mole.c;
      if(!P.marks) P.marks = [];
      var tag = new THREE.Mesh(new THREE.PlaneGeometry(0.18, 0.18),
        new THREE.MeshBasicMaterial({color: c, transparent: true, opacity: 0.85, side: THREE.DoubleSide}));
      tag.position.set(0, 2.6, 0); tag.__freeze = frz; P.mesh.g.add(tag); P.marks.push(tag);
    };
    R.addDecoy = function(dc){
      // the decoy is a copy of my character standing where I faced, its albedo tipped toward
      // pale cyan so it's clearly not the real me (and so a friendly doesn't shoot at it)
      var o = GL[CHARS[clamp(V.myCh|0, 0, CHARS.length - 1)].f]; if(!o) return;
      var cl = lib.clone(o.scene); cl.scale.setScalar(1.75/CH_H);
      cl.position.set(dc.x, dc.y, dc.z);
      cl.rotation.y = dc.yaw != null ? dc.yaw : V.yaw;
      cl.traverse(function(n){
        if(!n.isMesh) return;
        n.material = n.material.clone();
        if(n.material.color) n.material.color = n.material.color.clone().lerp(new THREE.Color(0xbfeef7), 0.5);
        n.castShadow = !V.low;
      });
      scene.add(cl); dc.mesh = cl;
    };
    // ---- Wave G: visible Rift pair + Shockwave ground ring ----
    // A rift used to plant V.rifts and hop rockets through with NO mesh and NO 2D blip,
    // so "nothing happened" was literally true on screen. Two violet openings + a link
    // beam make the 6s pair obvious from anywhere on the map. R.ring is the shockwave
    // totem's expanding ground circle (reads even when the 6m knock hits nobody).
    var riftGroups = [], ringMeshes = [];
    function riftOpening(x, z, c){
      var gp = new THREE.Group();
      var disc = new THREE.Mesh(new THREE.CircleGeometry(0.55, 22).rotateX(-Math.PI/2),
        new THREE.MeshBasicMaterial({color: c, transparent: true, opacity: 0.75, side: THREE.DoubleSide, depthWrite: false, fog: false}));
      disc.position.y = 0.05; gp.add(disc);
      var rim = new THREE.Mesh(new THREE.RingGeometry(0.5, 0.72, 24).rotateX(-Math.PI/2),
        new THREE.MeshBasicMaterial({color: c, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false, fog: false}));
      rim.position.y = 0.07; gp.add(rim);
      var arch = new THREE.Mesh(new THREE.TorusGeometry(0.62, 0.06, 8, 20, Math.PI),
        new THREE.MeshBasicMaterial({color: c, transparent: true, opacity: 0.85, depthWrite: false, fog: false}));
      arch.position.y = 0.1; arch.rotation.y = Math.PI/2; gp.add(arch);
      var beam = beacon(c); beam.scale.y = 0.55; gp.add(beam);
      gp.position.set(x, 0, z); return gp;
    }
    R.addRift = function(rf){
      if(!rf) return;
      var c = TOTEMS.rift.c;
      // two world-positioned openings under one group so dispose is one call
      var a = riftOpening(0, 0, c), b = riftOpening(0, 0, c);
      a.position.set(rf.x, 0, rf.z); b.position.set(rf.x2, 0, rf.z2);
      var midx = (rf.x + rf.x2) / 2, midz = (rf.z + rf.z2) / 2;
      var span = Math.hypot(rf.x2 - rf.x, rf.z2 - rf.z) || 1;
      var link = new THREE.Mesh(new THREE.BoxGeometry(span, 0.05, 0.08),
        new THREE.MeshBasicMaterial({color: c, transparent: true, opacity: 0.45, depthWrite: false, fog: false}));
      link.position.set(midx, 0.12, midz);
      link.rotation.y = Math.atan2(rf.x2 - rf.x, rf.z2 - rf.z) + Math.PI/2;
      var g2 = new THREE.Group(); g2.add(a); g2.add(b); g2.add(link);
      g2.userData.until = rf.until || 0; g2.userData.rift = rf;
      scene.add(g2); riftGroups.push(g2); rf.mesh = g2;
    };
    R.ring = function(x, y, z, r, dur, t){
      var rg = new THREE.Mesh(new THREE.RingGeometry(0.55, 0.85, 40).rotateX(-Math.PI/2),
        new THREE.MeshBasicMaterial({color: TOTEMS.shock.c, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false, fog: false}));
      rg.position.set(x, y != null ? y : 0.1, z); rg.scale.setScalar(0.4);
      dyn.add(rg); ringMeshes.push({o: rg, at: t != null ? t : 0, r: r || 8, dur: dur || 0.55});
      if(ringMeshes.length > 8){ var old = ringMeshes.shift(); dyn.remove(old.o); }
    };
    R.clearRifts = function(){
      (riftGroups || []).forEach(function(g){ scene.remove(g); });
      riftGroups = [];
    };

    /* ===================== Wave F: Disaster Theatre =====================
       Every arena-wide disaster paints big, map-wide, ORIGINAL three.js spectacle so
       both teams SEE that something is happening (Absolute Zero used to be invisible
       numbers). Geometry + generated canvas textures only — no third-party assets, no
       egress. Motion is gated on calm(); under Calm / reduced-motion the still frame
       keeps the colour, fog and light change and just stops moving.
       R.disaster(kind, on) is what disStart / disClear / the MP "di" snap already call. */
    var fxKind = "", fxGroup = null, fxBits = [], fxPool = [], fxRing = null, fxCol = null,
        fxPit = null, fxWarn = null, fxMarkSeen = {}, fxBoomSeen = {}, fxBase = null,
        fxSpan = 1, fxBoltAt = -9, fxBolt = null, fxBoltHalo = null, fxBoltBranch = null,
        fxSnow = null, fxDust = null, fxClouds = [];
    function fxTex(kind){
      var c = document.createElement("canvas"), g = c.getContext("2d"); c.width = 32; c.height = 32;
      var gr = g.createRadialGradient(16, 16, 1, 16, 16, 15);
      if(kind === "snow"){ gr.addColorStop(0, "rgba(240,250,255,1)"); gr.addColorStop(0.5, "rgba(200,230,255,0.85)"); gr.addColorStop(1, "rgba(160,200,255,0)"); }
      else if(kind === "dust"){ gr.addColorStop(0, "rgba(220,190,140,0.9)"); gr.addColorStop(0.5, "rgba(180,140,90,0.55)"); gr.addColorStop(1, "rgba(140,100,60,0)"); }
      else if(kind === "toxic"){ gr.addColorStop(0, "rgba(160,255,120,0.75)"); gr.addColorStop(0.45, "rgba(80,200,60,0.45)"); gr.addColorStop(1, "rgba(40,120,30,0)"); }
      else if(kind === "rock"){ gr.addColorStop(0, "rgba(90,70,50,1)"); gr.addColorStop(0.5, "rgba(60,45,30,0.8)"); gr.addColorStop(1, "rgba(30,20,10,0)"); }
      else if(kind === "fire"){ gr.addColorStop(0, "rgba(255,240,180,1)"); gr.addColorStop(0.35, "rgba(255,140,40,0.9)"); gr.addColorStop(1, "rgba(180,40,10,0)"); }
      else if(kind === "frost"){ gr.addColorStop(0, "rgba(220,245,255,1)"); gr.addColorStop(0.5, "rgba(140,200,240,0.7)"); gr.addColorStop(1, "rgba(80,140,200,0)"); }
      else { gr.addColorStop(0, "rgba(255,255,255,1)"); gr.addColorStop(1, "rgba(255,255,255,0)"); }
      g.fillStyle = gr; g.fillRect(0, 0, 32, 32);
      var t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
    }
    var TEX_SNOW = null, TEX_DUST = null, TEX_TOXIC = null, TEX_ROCK = null, TEX_FIRE = null, TEX_FROST = null;
    function fxEnsureTex(){
      if(!TEX_SNOW) TEX_SNOW = fxTex("snow");
      if(!TEX_DUST) TEX_DUST = fxTex("dust");
      if(!TEX_TOXIC) TEX_TOXIC = fxTex("toxic");
      if(!TEX_ROCK) TEX_ROCK = fxTex("rock");
      if(!TEX_FIRE) TEX_FIRE = fxTex("fire");
      if(!TEX_FROST) TEX_FROST = fxTex("frost");
    }
    function fxPart(tex, x, y, z, s, op){
      var sp = new THREE.Sprite(new THREE.SpriteMaterial({map: tex, transparent: true, depthWrite: false, opacity: op != null ? op : 0.85}));
      sp.position.set(x, y, z); sp.scale.setScalar(s || 0.5);
      fxGroup.add(sp); fxBits.push(sp); return sp;
    }
    function fxStop(){
      if(fxGroup){ dyn.remove(fxGroup); fxGroup = null; }
      fxBits = []; fxPool = []; fxRing = null; fxCol = null; fxPit = null; fxWarn = null;
      fxSnow = null; fxDust = null; fxClouds = []; fxBolt = null; fxBoltHalo = null; fxBoltBranch = null;
      fxMarkSeen = {}; fxBoomSeen = {};
      if(fxBase){
        if(scene.fog){ scene.fog.near = fxBase.fogN; scene.fog.far = fxBase.fogF; if(fxBase.fogC != null) scene.fog.color.set(fxBase.fogC); }
        if(scene.background && scene.background.set && fxBase.sky != null) scene.background.set(fxBase.sky);
        sun.intensity = fxBase.sunI; hemi.intensity = fxBase.hemiI;
        if(fill) fill.intensity = fxBase.fillI;
        fxBase = null;
      }
      fxKind = "";
    }
    function fxStart(kind){
      fxStop();
      if(!kind || !TOTEMS[kind]) return;
      fxKind = kind; fxEnsureTex();
      fxGroup = new THREE.Group(); dyn.add(fxGroup);
      var b = MAP.bounds || [-40, -1, -30, 40, 12, 30];
      var ox = (b[0] + b[3]) / 2, oz = (b[2] + b[5]) / 2;
      fxSpan = Math.max(8, Math.min(b[3] - b[0], b[5] - b[2]) * 0.5);
      fxBase = {
        fogN: scene.fog ? scene.fog.near : 36,
        fogF: scene.fog ? scene.fog.far : 120,
        fogC: scene.fog ? scene.fog.color.getHex() : null,
        sky: (scene.background && scene.background.getHex) ? scene.background.getHex() : null,
        sunI: sun.intensity, hemiI: hemi.intensity, fillI: fill ? fill.intensity : 0
      };
      var i, n, sp, x, y, z, ang;
      if(kind === "sandstorm"){
        if(scene.fog){ scene.fog.near = 1.2; scene.fog.far = 22; scene.fog.color.set(0xb08a55); }
        if(scene.background && scene.background.set) scene.background.set(0x8a6a40);
        sun.intensity = fxBase.sunI * 0.25; hemi.intensity = fxBase.hemiI * 0.4;
        // denser wall of grit: 320 sprites (was 140), fatter and more opaque, fog crushed
        for(i = 0, n = 320; i < n; i++){
          ang = FS.mb32((i * 97 + 3) & 0xFFFF) * 6.283;
          x = ox + Math.cos(ang) * (1.5 + FS.mb32((i * 31 + 11) & 0xFFFF) * (b[3] - b[0]) * 0.6);
          z = oz + Math.sin(ang) * (1.5 + FS.mb32((i * 53 + 7) & 0xFFFF) * (b[5] - b[2]) * 0.6);
          y = 0.15 + FS.mb32((i * 71 + 13) & 0xFFFF) * 8;
          sp = fxPart(TEX_DUST, x, y, z, 0.9 + FS.mb32((i * 17) & 0xFFFF) * 1.8, 0.45 + FS.mb32((i * 23) & 0xFFFF) * 0.45);
          sp.userData.vx = 5.5 + FS.mb32((i * 41) & 0xFFFF) * 4; sp.userData.vy = 0.15; sp.userData.vz = 0.9;
        }
      } else if(kind === "meteorshower"){
        if(scene.fog){ scene.fog.near = 18; scene.fog.far = 90; scene.fog.color.set(0x6a3a28); }
        if(scene.background && scene.background.set) scene.background.set(0x4a2018);
        sun.intensity = fxBase.sunI * 0.55;
        for(i = 0, n = 26; i < n; i++){
          ang = FS.mb32((i * 89 + 5) & 0xFFFF) * 6.283;
          x = ox + Math.cos(ang) * (3 + FS.mb32((i * 29 + 3) & 0xFFFF) * (b[3] - b[0]) * 0.5);
          z = oz + Math.sin(ang) * (3 + FS.mb32((i * 59 + 9) & 0xFFFF) * (b[5] - b[2]) * 0.5);
          y = 18 + FS.mb32((i * 13) & 0xFFFF) * 14;
          sp = fxPart(TEX_FIRE, x, y, z, 1.2 + FS.mb32((i * 19) & 0xFFFF) * 1.6, 0.95);
          sp.userData.vy = -(10 + FS.mb32((i * 37) & 0xFFFF) * 8);
          sp.userData.vx = (FS.mb32((i * 43) & 0xFFFF) - 0.5) * 2;
          sp.userData.vz = (FS.mb32((i * 47) & 0xFFFF) - 0.5) * 2;
          sp.userData.ttl = 1.4 + FS.mb32((i * 53) & 0xFFFF) * 1.2;
          sp.userData.age = 0;
        }
      } else if(kind === "hurricane"){
        if(scene.fog){ scene.fog.near = 10; scene.fog.far = 70; scene.fog.color.set(0x4a6a8a); }
        if(scene.background && scene.background.set) scene.background.set(0x2a4060);
        sun.intensity = fxBase.sunI * 0.5;
        var colGeo = new THREE.CylinderGeometry(DD_WIND_R * 1.1, DD_WIND_R * 0.7, 16, 18, 1, true);
        fxCol = new THREE.Mesh(colGeo, new THREE.MeshBasicMaterial({
          color: 0xb8d4f0, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false, fog: false
        }));
        fxCol.position.set(ox, 7, oz); fxGroup.add(fxCol);
        for(i = 0, n = 60; i < n; i++){
          ang = (i / 60) * 6.283;
          sp = fxPart(TEX_DUST, ox + Math.cos(ang) * DD_WIND_R, 0.5 + FS.mb32((i * 17) & 0xFFFF) * 10, oz + Math.sin(ang) * DD_WIND_R,
                      0.5 + FS.mb32((i * 29) & 0xFFFF) * 0.8, 0.55);
          sp.userData.ang = ang; sp.userData.rad = DD_WIND_R * (0.6 + FS.mb32((i * 41) & 0xFFFF) * 0.55);
          sp.userData.vy = 1.2 + FS.mb32((i * 53) & 0xFFFF) * 2.5;
        }
      } else if(kind === "thunder"){
        if(scene.fog){ scene.fog.near = 14; scene.fog.far = 80; scene.fog.color.set(0x2a3040); }
        if(scene.background && scene.background.set) scene.background.set(0x1a2030);
        sun.intensity = fxBase.sunI * 0.4;
        // zig-zag bolt + a dimmer halo path + one side branch — all hashed (boltPts)
        fxBolt = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 20, 0), new THREE.Vector3(0, 0, 0)]),
          new THREE.LineBasicMaterial({color: 0xe8f4ff, transparent: true, opacity: 0, fog: false})
        );
        fxBolt.visible = false; fxGroup.add(fxBolt);
        fxBoltHalo = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 20, 0), new THREE.Vector3(0, 0, 0)]),
          new THREE.LineBasicMaterial({color: 0x7ec8ff, transparent: true, opacity: 0, fog: false})
        );
        fxBoltHalo.visible = false; fxGroup.add(fxBoltHalo);
        fxBoltBranch = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 20, 0), new THREE.Vector3(0, 0, 0)]),
          new THREE.LineBasicMaterial({color: 0xc8e8ff, transparent: true, opacity: 0, fog: false})
        );
        fxBoltBranch.visible = false; fxGroup.add(fxBoltBranch);
      } else if(kind === "earthquake"){
        if(scene.fog){ scene.fog.near = 16; scene.fog.far = 85; scene.fog.color.set(0x5a4a3a); }
        if(scene.background && scene.background.set) scene.background.set(0x3a3028);
        sun.intensity = fxBase.sunI * 0.6;
        for(i = 0, n = 50; i < n; i++){
          ang = FS.mb32((i * 83 + 1) & 0xFFFF) * 6.283;
          x = ox + Math.cos(ang) * FS.mb32((i * 31 + 7) & 0xFFFF) * (b[3] - b[0]) * 0.5;
          z = oz + Math.sin(ang) * FS.mb32((i * 57 + 3) & 0xFFFF) * (b[5] - b[2]) * 0.5;
          sp = fxPart(TEX_DUST, x, 0.2 + FS.mb32((i * 11) & 0xFFFF) * 1.5, z, 0.6 + FS.mb32((i * 23) & 0xFFFF) * 1.1, 0.4);
          sp.userData.vy = 0.6 + FS.mb32((i * 37) & 0xFFFF) * 1.4;
          sp.userData.age = 0;
        }
      } else if(kind === "shockring"){
        if(scene.fog){ scene.fog.near = 20; scene.fog.far = 110; }
        sun.intensity = fxBase.sunI * 0.8;
        fxRing = new THREE.Mesh(
          new THREE.RingGeometry(0.9, 1.1, 64).rotateX(-Math.PI/2),
          new THREE.MeshBasicMaterial({color: 0xff6b6b, transparent: true, opacity: 0.7, side: THREE.DoubleSide, depthWrite: false, fog: false})
        );
        fxRing.position.set(ox, 0.15, oz); fxGroup.add(fxRing);
      } else if(kind === "toxicfog"){
        if(scene.fog){ scene.fog.near = 4; scene.fog.far = 40; scene.fog.color.set(0x3a6a30); }
        if(scene.background && scene.background.set) scene.background.set(0x2a4a28);
        sun.intensity = fxBase.sunI * 0.4;
        // paint the SAME sticky clouds the judge damages (frozen at disStart / shiped in di[6])
        var toxZones = (V.disasterZones && V.disasterZones.length) ? V.disasterZones : null;
        for(i = 0; i < DD_TOXIC_ZONES; i++){
          if(toxZones && toxZones[i]){
            x = toxZones[i][0]; z = toxZones[i][1];
          } else {
            ang = (i / 3) * 6.283 + 0.4;
            x = ox + Math.cos(ang) * fxSpan * 0.55; z = oz + Math.sin(ang) * fxSpan * 0.4;
          }
          sp = fxPart(TEX_TOXIC, x, 1.2, z, DD_TOXIC_R * 2.4, 0.55);
          fxClouds.push(sp);
          for(var j = 0; j < 10; j++){
            var ja = FS.mb32((i * 97 + j * 31) & 0xFFFF) * 6.283;
            fxPart(TEX_TOXIC, x + Math.cos(ja) * DD_TOXIC_R * 0.7, 0.4 + FS.mb32((j * 17) & 0xFFFF) * 2.2, z + Math.sin(ja) * DD_TOXIC_R * 0.7,
                   0.8 + FS.mb32((j * 23) & 0xFFFF) * 1.2, 0.4);
          }
        }
      } else if(kind === "absolutezero"){
        if(scene.fog){ scene.fog.near = 6; scene.fog.far = 48; scene.fog.color.set(0xa8c8e8); }
        if(scene.background && scene.background.set) scene.background.set(0x6a8ab0);
        sun.intensity = fxBase.sunI * 0.45; hemi.intensity = fxBase.hemiI * 0.7;
        if(fill) fill.intensity = 0.15;
        for(i = 0, n = 180; i < n; i++){
          x = b[0] + FS.mb32((i * 97 + 5) & 0xFFFF) * (b[3] - b[0]);
          z = b[2] + FS.mb32((i * 31 + 11) & 0xFFFF) * (b[5] - b[2]);
          y = 0.5 + FS.mb32((i * 53 + 3) & 0xFFFF) * 14;
          sp = fxPart(i % 3 === 0 ? TEX_FROST : TEX_SNOW, x, y, z,
                      0.25 + FS.mb32((i * 17) & 0xFFFF) * 0.55, 0.55 + FS.mb32((i * 23) & 0xFFFF) * 0.4);
          sp.userData.vy = -(1.1 + FS.mb32((i * 41) & 0xFFFF) * 1.6);
          sp.userData.vx = (FS.mb32((i * 47) & 0xFFFF) - 0.5) * 1.2;
          sp.userData.vz = (FS.mb32((i * 59) & 0xFFFF) - 0.5) * 1.2;
        }
        // ice shards poking out of the floor so the freeze reads from any angle
        for(i = 0, n = 24; i < n; i++){
          ang = FS.mb32((i * 71 + 9) & 0xFFFF) * 6.283;
          x = ox + Math.cos(ang) * (2 + FS.mb32((i * 29 + 1) & 0xFFFF) * (b[3] - b[0]) * 0.45);
          z = oz + Math.sin(ang) * (2 + FS.mb32((i * 43 + 7) & 0xFFFF) * (b[5] - b[2]) * 0.45);
          if(FS.overlaps(MAP, x, 0.1, z, 0.2) >= 0) continue;
          var shard = new THREE.Mesh(new THREE.ConeGeometry(0.18 + FS.mb32((i * 13) & 0xFFFF) * 0.2, 0.8 + FS.mb32((i * 19) & 0xFFFF) * 1.4, 5),
            new THREE.MeshLambertMaterial({color: 0xb8e0ff, emissive: 0x6aa0d0, transparent: true, opacity: 0.85}));
          shard.position.set(x, 0.2, z);
          shard.rotation.set((FS.mb32((i * 37) & 0xFFFF) - 0.5) * 0.6, ang, (FS.mb32((i * 41) & 0xFFFF) - 0.5) * 0.6);
          fxGroup.add(shard);   // still art — do NOT push into fxBits (that list is for drifting particles)
        }
      } else if(kind === "sinkhole"){
        if(scene.fog){ scene.fog.near = 8; scene.fog.far = 55; scene.fog.color.set(0x2a2018); }
        if(scene.background && scene.background.set) scene.background.set(0x1a1410);
        sun.intensity = fxBase.sunI * 0.4;
        fxPit = new THREE.Group();
        var disc = new THREE.Mesh(new THREE.CircleGeometry(DD_SINK_R, 28).rotateX(-Math.PI/2),
          new THREE.MeshBasicMaterial({color: 0x0a0806, transparent: true, opacity: 0.88, depthWrite: false}));
        disc.position.y = 0.06; fxPit.add(disc);
        var lip = new THREE.Mesh(new THREE.RingGeometry(DD_SINK_R * 0.85, DD_SINK_R * 1.15, 32).rotateX(-Math.PI/2),
          new THREE.MeshBasicMaterial({color: 0x5c4033, transparent: true, opacity: 0.75, side: THREE.DoubleSide, depthWrite: false}));
        lip.position.y = 0.08; fxPit.add(lip);
        var sspotFx = (V.disasterPit && V.disasterPit.length === 2)
          ? [V.disasterPit[0], 0, V.disasterPit[1]]
          : ((typeof disSpot === "function") ? disSpot(((Math.imul(V.disasterSeed|0, 2654435761) + 47) >>> 0), 5) : [ox, 0, oz]);
        fxPit.position.set(sspotFx[0], 0, sspotFx[2]); fxGroup.add(fxPit);
        for(i = 0, n = 40; i < n; i++){
          ang = FS.mb32((i * 89 + 3) & 0xFFFF) * 6.283;
          sp = fxPart(TEX_ROCK, ox + Math.cos(ang) * DD_SINK_R * 1.6, 0.3 + FS.mb32((i * 17) & 0xFFFF) * 3, oz + Math.sin(ang) * DD_SINK_R * 1.6,
                      0.3 + FS.mb32((i * 29) & 0xFFFF) * 0.5, 0.8);
          sp.userData.ang = ang; sp.userData.rad = DD_SINK_R * (1.1 + FS.mb32((i * 41) & 0xFFFF) * 0.8);
          sp.userData.vy = -0.8 - FS.mb32((i * 53) & 0xFFFF) * 1.2;
        }
      } else if(kind === "emp"){
        if(scene.fog){ scene.fog.near = 12; scene.fog.far = 60; scene.fog.color.set(0x1a2840); }
        if(scene.background && scene.background.set) scene.background.set(0x0a1428);
        sun.intensity = 0.08; hemi.intensity = fxBase.hemiI * 0.15;
        if(fill) fill.intensity = 0.05;
        // strobing warning pylons so the blackout is still readable in the world
        for(i = 0, n = 18; i < n; i++){
          ang = (i / 18) * 6.283;
          x = ox + Math.cos(ang) * fxSpan * 0.7; z = oz + Math.sin(ang) * fxSpan * 0.55;
          sp = fxPart(TEX_FROST, x, 0.4, z, 1.4, 0.35);
          sp.userData.strobe = 1;
        }
      }
      // warn ring: a bright ground circle that pulses for the 2s warn and then sits under the hold
      fxWarn = new THREE.Mesh(new THREE.RingGeometry(0.7, 1.0, 48).rotateX(-Math.PI/2),
        new THREE.MeshBasicMaterial({color: 0xffd43b, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false, fog: false}));
      fxWarn.position.set(ox, 0.12, oz); fxWarn.scale.setScalar(fxSpan * 1.2); fxGroup.add(fxWarn);
    }
    // per-frame: move particles, walk the storm column, expand the shock ring, paint marks
    function fxTick(dt, t, quiet){
      // V.booms are pushed by the judge (meteor / quake / mine / chaos) — paint each once in 3D
      if(V.booms && V.booms.length){
        for(var bi = 0; bi < V.booms.length; bi++){
          var B = V.booms[bi];
          if(R.boom) R.boom(B.x, B.y != null ? B.y : 0.3, B.z, t);
        }
        V.booms = [];
      }
      // impact marks become 3D ground warning rings (they used to be radar-only)
      if(V.disasterMarks && V.disasterMarks.length && fxGroup){
        for(var mi = 0; mi < V.disasterMarks.length; mi++){
          var Mk = V.disasterMarks[mi], mk = String(Mk.id != null ? Mk.id : mi);
          if(fxMarkSeen[mk]) continue;
          fxMarkSeen[mk] = 1;
          var rGeo = new THREE.RingGeometry(Math.max(0.2, Mk.r * 0.55), Math.max(0.3, Mk.r), 28).rotateX(-Math.PI/2);
          var rMat = new THREE.MeshBasicMaterial({
            color: (Mk.dis === "thunder" ? 0xffd43b : (Mk.dis === "earthquake" ? 0xb08060 : 0xff6b6b)),
            transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false, fog: false
          });
          var rg = new THREE.Mesh(rGeo, rMat);
          rg.position.set(Mk.x, 0.1, Mk.z);
          rg.userData.hitAt = Mk.hitAt || (t + 1);
          fxGroup.add(rg); fxPool.push(rg);
        }
      }
      if(!fxKind || !fxGroup) return;
      var warnOn = t < (V.disasterWarnAt || 0);
      var i, sp, u;
      if(fxWarn){
        var ws = warnOn ? (0.85 + 0.15 * Math.sin(t * 10)) : 1;
        fxWarn.scale.setScalar(fxSpan * 1.2 * ws);
        fxWarn.material.opacity = warnOn ? 0.65 : 0.18;
      }
      // mark rings pulse before they hit, then vanish (the boom itself is R.boom)
      for(i = fxPool.length - 1; i >= 0; i--){
        var rgp = fxPool[i], left = (rgp.userData.hitAt || 0) - t;
        if(left <= 0){ if(fxGroup) fxGroup.remove(rgp); fxPool.splice(i, 1); continue; }
        var pulse = warnOn ? 1 : (0.7 + 0.3 * Math.sin(t * 14));
        rgp.material.opacity = clamp(0.35 + left * 0.45, 0.2, 0.85) * pulse;
        if(!quiet){ rgp.rotation.y = t * 0.6; }
      }
      if(fxKind === "sandstorm" || fxKind === "earthquake" || fxKind === "meteorshower" || fxKind === "absolutezero" || fxKind === "hurricane" || fxKind === "sinkhole"){
        for(i = 0; i < fxBits.length; i++){
          sp = fxBits[i]; if(!sp || !sp.userData || sp.userData.staticFx) continue;
          u = sp.userData;
          if(fxKind === "sandstorm"){
            if(!quiet){ sp.position.x += (u.vx || 4) * dt; sp.position.z += (u.vz || 0) * dt; }
            if(sp.position.x > MAP.bounds[3] + 4) sp.position.x = MAP.bounds[0] - 4;
          } else if(fxKind === "meteorshower"){
            sp.position.y += (u.vy || -12) * dt;
            sp.position.x += (u.vx || 0) * dt; sp.position.z += (u.vz || 0) * dt;
            u.age = (u.age || 0) + dt;
            if(sp.position.y < 0.2 || u.age > (u.ttl || 2)){
              if(R.boom) R.boom(sp.position.x, 0.3, sp.position.z, t);
              sp.position.y = 16 + FS.mb32(((t * 977 + i) | 0) & 0xFFFF) * 12;
              u.age = 0;
            }
          } else if(fxKind === "hurricane"){
            u.ang = (u.ang || 0) + dt * 3.2;
            u.rad = Math.max(1, (u.rad || 6) + (quiet ? 0 : Math.sin(t * 3 + i) * 0.02));
            var cX = fxCol ? fxCol.position.x : 0, cZ = fxCol ? fxCol.position.z : 0;
            sp.position.set(cX + Math.cos(u.ang) * u.rad, sp.position.y, cZ + Math.sin(u.ang) * u.rad);
            if(!quiet) sp.position.y += (u.vy || 1.5) * dt;
            if(sp.position.y > 14) sp.position.y = 0.4;
          } else if(fxKind === "absolutezero"){
            if(!quiet){
              sp.position.y += (u.vy || -1.5) * dt;
              sp.position.x += (u.vx || 0) * dt; sp.position.z += (u.vz || 0) * dt;
            }
            if(sp.position.y < 0.1){ sp.position.y = 12 + FS.mb32(((t * 613 + i) | 0) & 0xFFFF) * 3; }
          } else if(fxKind === "earthquake"){
            if(!quiet){
              sp.position.y += (u.vy || 0.8) * dt;
              sp.position.x += Math.sin(t * 9 + i) * dt * 0.4;
            }
            if(sp.position.y > 3.5) sp.position.y = 0.15;
          } else if(fxKind === "sinkhole"){
            u.ang = (u.ang || 0) - dt * 1.8;
            u.rad = Math.max(0.4, (u.rad || 4) - dt * 0.9);
            var pX = fxPit ? fxPit.position.x : 0, pZ = fxPit ? fxPit.position.z : 0;
            sp.position.set(pX + Math.cos(u.ang) * u.rad, sp.position.y, pZ + Math.sin(u.ang) * u.rad);
            if(!quiet) sp.position.y += (u.vy || -1) * dt;
            if(sp.position.y < 0.1 || u.rad < 0.5){ sp.position.y = 2 + FS.mb32(((t * 331 + i) | 0) & 0xFFFF) * 2; u.rad = DD_SINK_R * 1.5; }
          }
        }
      }
      if(fxKind === "toxicfog"){
        for(i = 0; i < fxClouds.length; i++){
          sp = fxClouds[i]; if(!sp) continue;
          // keep the painted cloud on the judge's sticky centre (snap may correct it)
          if(V.disasterZones && V.disasterZones[i]){
            sp.position.x = V.disasterZones[i][0];
            sp.position.z = V.disasterZones[i][1];
          }
          if(!quiet){ sp.scale.setScalar(DD_TOXIC_R * (2.2 + 0.35 * Math.sin(t * 1.3 + i))); sp.position.y = 1.1 + 0.25 * Math.sin(t * 0.9 + i); }
        }
      }
      if(fxKind === "sinkhole" && fxPit && V.disasterPit && V.disasterPit.length === 2){
        fxPit.position.x = V.disasterPit[0];
        fxPit.position.z = V.disasterPit[1];
      }
      if(fxKind === "hurricane" && fxCol){
        // the column walks the same hashed diagonal the judge pushes bodies along
        // (frozen disaster seed — worldK moves every tick and desyncs the column)
        var spanH = Math.max(0.1, (V.disasterUntil || 0) - (V.disasterWarnAt || 0));
        var uH = clamp((t - (V.disasterWarnAt || 0)) / spanH, 0, 1);
        var bH = MAP.bounds;
        var wxH = (bH[0] + hashMatch(V.disasterSeed|0, 21) * (bH[3] - bH[0])) * (1 - uH) +
                  (bH[0] + hashMatch(V.disasterSeed|0, 23) * (bH[3] - bH[0])) * uH;
        var wzH = (bH[2] + hashMatch(V.disasterSeed|0, 22) * (bH[5] - bH[2])) * (1 - uH) +
                  (bH[2] + hashMatch(V.disasterSeed|0, 24) * (bH[5] - bH[2])) * uH;
        fxCol.position.set(wxH, 7, wzH);
        if(!quiet) fxCol.rotation.y = t * 4;
        fxCol.material.opacity = 0.18 + 0.08 * Math.sin(t * 5);
      }
      if(fxKind === "shockring" && fxRing){
        var rr = Math.max(0.5, V.disasterRing || 0);
        fxRing.scale.set(rr, 1, rr);
        fxRing.material.opacity = 0.35 + 0.35 * Math.sin(t * 8);
      }
      if(fxKind === "thunder"){
        // a zig-zag bolt slams a live impact mark (or a hashed spot) every DD_THUNDER_GAP-ish
        if(fxBolt && t >= fxBoltAt){
          fxBoltAt = t + 0.45;
          var mx = (MAP.bounds[0] + hashMatch((t * 10|0) + (V.disasterSeed|0), 31) * (MAP.bounds[3] - MAP.bounds[0]));
          var mz = (MAP.bounds[2] + hashMatch((t * 10|0) + (V.disasterSeed|0), 33) * (MAP.bounds[5] - MAP.bounds[2]));
          if(V.disasterMarks && V.disasterMarks.length){
            var pick = V.disasterMarks[(t * 7|0) % V.disasterMarks.length];
            if(pick){ mx = pick.x; mz = pick.z; }
          }
          var seedB = (V.disasterSeed|0) ^ ((t * 10|0) * 2654435761);
          var skyX = mx + (hashMatch(seedB, 41) - 0.5) * 3;
          var skyZ = mz + (hashMatch(seedB, 43) - 0.5) * 3;
          // hashed kinks (never Math.random) so every observer sees the same bolt
          var path = boltPts(seedB, 7, skyX, 22, skyZ, mx, 0.2, mz, 9, 1.8);
          var v3 = path.map(function(p){ return new THREE.Vector3(p[0], p[1], p[2]); });
          fxBolt.geometry.dispose();
          fxBolt.geometry = new THREE.BufferGeometry().setFromPoints(v3);
          fxBolt.visible = true; fxBolt.material.opacity = 0.98;
          if(fxBoltHalo){
            var v3h = boltPts(seedB, 7, skyX, 22, skyZ, mx, 0.2, mz, 9, 1.8).map(function(p){
              return new THREE.Vector3(p[0], p[1], p[2]);
            });
            fxBoltHalo.geometry.dispose();
            fxBoltHalo.geometry = new THREE.BufferGeometry().setFromPoints(v3h);
            fxBoltHalo.visible = true; fxBoltHalo.material.opacity = 0.35;
          }
          if(fxBoltBranch){
            var br = boltBranch(path, seedB, 90);
            if(br){
              fxBoltBranch.geometry.dispose();
              fxBoltBranch.geometry = new THREE.BufferGeometry().setFromPoints(
                br.map(function(p){ return new THREE.Vector3(p[0], p[1], p[2]); }));
              fxBoltBranch.visible = true; fxBoltBranch.material.opacity = 0.7;
            }
          }
          sun.intensity = (fxBase ? fxBase.sunI : 1.8) * 1.8;
          if(R.boom) R.boom(mx, 0.3, mz, t);
        }
        if(fxBolt && fxBolt.visible){
          fxBolt.material.opacity = Math.max(0, fxBolt.material.opacity - dt * 4);
          if(fxBoltHalo) fxBoltHalo.material.opacity = Math.max(0, fxBoltHalo.material.opacity - dt * 3);
          if(fxBoltBranch) fxBoltBranch.material.opacity = Math.max(0, fxBoltBranch.material.opacity - dt * 6);
          if(fxBolt.material.opacity <= 0.02) fxBolt.visible = false;
          if(fxBoltHalo && fxBoltHalo.material.opacity <= 0.02) fxBoltHalo.visible = false;
          if(fxBoltBranch && fxBoltBranch.material.opacity <= 0.02) fxBoltBranch.visible = false;
          if(fxBase) sun.intensity += ((fxBase.sunI * 0.4) - sun.intensity) * clamp(dt * 6, 0, 1);
        }
      }
      if(fxKind === "emp"){
        // lights stutter: mostly dark, with a hard blue kick every ~0.7s
        var strobe = (!quiet && (Math.sin(t * 9) > 0.7)) ? 1 : 0;
        sun.intensity = 0.08 + strobe * 0.6;
        hemi.intensity = (fxBase ? fxBase.hemiI : 1.1) * (0.12 + strobe * 0.35);
        for(i = 0; i < fxBits.length; i++){
          sp = fxBits[i]; if(sp && sp.material) sp.material.opacity = strobe ? 0.7 : 0.2;
        }
      }
    }
    R.disaster = function(kind, on){
      if(on){ if(fxKind && fxKind === kind && fxGroup) return; fxStart(kind || ""); }
      else fxStop();
    };
    R.boomsTick = boomsTick;
    R.size = function(w, h){ renderer.setSize(w, h, false); camera.aspect = w/h; camera.updateProjectionMatrix(); vCam.aspect = w/h; vCam.updateProjectionMatrix(); };
    R.camera = camera;
    R.render = function(dt, t){
      var quiet = calm();
      if(V.warden && R3 && R3.wardenSync) R3.wardenSync(V.warden, t);
      // others (a new look or team re-renders the whole mesh)
      others().forEach(function(P){
        // rebuild also when the friend/foe relation flips: the red-vs-ally name tag is baked
        // into the tag sprite, and in MP my own team arrives with the first view/snapshot
        if(P.mesh && (P.mesh.ch !== P.ch || P.mesh.team !== P.team || P.mesh.bot !== P.bot || P.mesh.foe !== (P.team !== V.team))) removePlayer(P);
        if(!P.mesh) addPlayer(P);
        var m = P.mesh; if(!m) return;
        m.g.visible = !P.gone && !(P.dead && t - (P.deadAt || 0) > 1.6);
        m.g.position.set(P.x, P.y, P.z); m.g.rotation.y = Math.PI - P.yaw;
        setAnim(m, P.dead ? "die" : P.moving > 0.5 ? "walk" : "idle");
        if(m.gun){ for(var gvi = 0; gvi < m.gun.length; gvi++) m.gun[gvi].visible = (P.w|0) === gvi; }
        m.mixer.update(dt);
        m.tag.visible = !P.dead;
        if(m.shield){
          m.shield.visible = !P.dead && botShielded(P, t);
          if(m.shield.visible && !quiet) m.shield.rotation.y = t*0.8;   // a slow spin so it reads as a live shield
        }
      });
      // pickups and drones
      pickMeshes.forEach(function(p, i){
        p.visible = !!V.items[i] && !!(MAP.pickups[i] && MAP.pickups[i].kind);
        if(!quiet) p.rotation.y = t*1.5;
        var at = MAP.pickups[i] ? MAP.pickups[i].at : null;
        if(at){ p.position.x = at[0]; p.position.z = at[2]; }
        p.position.y = (at ? at[1] : 0) + 0.55 + (quiet ? 0 : Math.sin(t*2 + i)*0.08);
      });
      // totem slots: the old map-drop plays out the same but the gem colours say what it is
      // and a fading decoy must clear its mesh the moment the window ends
      for(var dci = (V.decoys || []).length - 1; dci >= 0; dci--){
        var dc = V.decoys[dci];
        if(dc.until > t){ if(dc.mesh && !quiet) dc.mesh.rotation.y = t*0.4; continue; }
        if(dc.mesh){ scene.remove(dc.mesh); dc.mesh = null; }
        V.decoys.splice(dci, 1);
      }
      // Rift openings: spin the arch while they live, then drop the mesh with the pair
      for(var ri = (riftGroups || []).length - 1; ri >= 0; ri--){
        var rgp2 = riftGroups[ri];
        if(rgp2.userData.until > t){
          if(!quiet) rgp2.children.forEach(function(ch, ci){ if(ci < 2) ch.rotation.y = t * 0.6; });
          continue;
        }
        scene.remove(rgp2); riftGroups.splice(ri, 1);
        if(rgp2.userData.rift) rgp2.userData.rift.mesh = null;
      }
      // Shockwave ground rings: expand and fade over dur seconds
      for(var rgi = (ringMeshes || []).length - 1; rgi >= 0; rgi--){
        var Rg = ringMeshes[rgi], aRg = (t - Rg.at) / (Rg.dur || 0.55);
        if(aRg >= 1){ dyn.remove(Rg.o); ringMeshes.splice(rgi, 1); continue; }
        if(aRg < 0) continue;
        Rg.o.scale.setScalar(0.4 + aRg * (Rg.r || 8) * 0.35);
        Rg.o.material.opacity = 0.85 * (1 - aRg * 0.85);
      }
      droneMeshes.forEach(function(d, i){
        var D = V.drones[i]; d.visible = !!D && V.mode === "practice" && D.downUntil <= t;
        if(!D) return; var c = dronePos(D, V.phase === "round" ? t - V.startAt : 0); d.position.set(c[0], c[1] - 0.3, c[2]);
        d.rotation.y = Math.atan2(V.me.x - c[0], V.me.z - c[2]);
      });
      mdMeshes.forEach(function(d, i){
        var D = (V.mdrones || [])[i]; d.visible = !!D && V.phase === "round";
        if(!D) return; var c = matchDronePos(D, t); d.position.set(c[0], c[1] - 0.3, c[2]);
        d.rotation.y = Math.atan2(V.me.x - c[0], V.me.z - c[2]);
      });
      // the live hook cable (drone swing)
      if(hookLine){ dyn.remove(hookLine); hookLine.geometry.dispose(); hookLine = null; }
      if(V.swingUntil > t && V.hookTo && R3){
        var hA = myMuzzle(), hB = V.hookTo;
        var hg = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(hA[0], hA[1], hA[2]), new THREE.Vector3(hB[0], hB[1], hB[2])]);
        hookLine = new THREE.Line(hg, new THREE.LineBasicMaterial({color: 0x9ad0ff}));
        hookLine.frustumCulled = false; dyn.add(hookLine);
      }
      // effects fade
      for(var i = tracers.length - 1; i >= 0; i--){ var a = t - tracers[i].at; if(a > 0.09){ dyn.remove(tracers[i].o); tracers[i].o.geometry.dispose(); tracers.splice(i, 1); } else tracers[i].o.material.opacity = 1 - a/0.09; }
      for(var j = puffs.length - 1; j >= 0; j--){ var b = t - puffs[j].at; if(b > 0.25){ dyn.remove(puffs[j].o); puffs.splice(j, 1); } else { puffs[j].o.material.opacity = 1 - b/0.25; if(!quiet) puffs[j].o.scale.setScalar(0.35 + b*1.6); } }
      if(R3.boomsTick) R3.boomsTick(t, quiet);
      if(fxTick) fxTick(dt, t, quiet);
      // damage numbers: one pass, in-place removal, o===null means "spawn this frame"
      for(var dn = V.dmgNums.length - 1; dn >= 0; dn--){
        var D2 = V.dmgNums[dn], age = t - D2.at;
        if(age > 0.8){
          if(D2.o){ dyn.remove(D2.o); D2.o.material.map.dispose(); D2.o.material.dispose(); D2.o = null; }
          V.dmgNums.splice(dn, 1); continue;
        }
        if(!D2.o){ D2.o = dmgSprite(D2.n, D2.head); D2.o.position.set(D2.x, D2.y, D2.z); dyn.add(D2.o); }
        D2.o.position.y = D2.y + age*0.9;
        D2.o.material.opacity = age < 0.5 ? 1 : 1 - (age - 0.5)/0.3;
      }
      // camera: your eyes (lower when down); spectating, a chase camera behind whoever you watch
      var M = V.me, ey = V.dead ? 0.5 : FS.EYE, WP = V.watch && V.players[V.watch];
      // your own shield bubble: rides your feet, spinning gently — visible only while it holds
      var meSh = !V.dead && !WP && meShielded(t);
      myShield.visible = meSh;
      if(meSh){ myShield.position.set(V.me.x, V.me.y + 0.95, V.me.z); if(!quiet) myShield.rotation.y = t*0.8; }
      // kill cam: dead, and we know who did it — a third-person chase on them for the respawn
      // wait (same seat the spectate bar uses: behind and above their shoulder, looking where they look)
      var KC = !WP && V.dead && V.killCam && V.killCam.ref && !V.killCam.ref.gone ? V.killCam : null;
      if(KC && (KC.ref.dead || KC.ref.team == null)){ KC = null; }
      if(WP){
        var fwx = Math.sin(WP.yaw), fwz = -Math.cos(WP.yaw);
        camera.position.set(WP.x - fwx*3.6, WP.y + 2.3, WP.z - fwz*3.6);
        camera.rotation.order = "YXZ"; camera.lookAt(WP.x + fwx*2, WP.y + 1.2, WP.z + fwz*2);
        M = WP;
      } else if(KC){
        // the reference tracks the live player (MP snapshots / solo botStep keep it moving),
        // so this is where they are NOW, not where they shot from
        var kx = Math.sin(KC.ref.yaw || 0), kz = -Math.cos(KC.ref.yaw || 0);
        camera.position.set(KC.ref.x - kx*3.6, KC.ref.y + 2.3, KC.ref.z - kz*3.6);
        camera.rotation.order = "YXZ"; camera.lookAt(KC.ref.x + kx*2, KC.ref.y + 1.2, KC.ref.z + kz*2);
        M = KC.ref;
      } else {
        // lean: slide the camera sideways (the same offset your shots come from) and roll it a touch
        var pk = V.peek || 0, plx = Math.cos(V.yaw)*PEEK_SIDE*pk, plz = Math.sin(V.yaw)*PEEK_SIDE*pk;
        camera.position.set(M.x + plx, M.y + ey, M.z + plz);
        camera.rotation.order = "YXZ"; camera.rotation.set(V.pitch + (V.dead ? -0.3 : 0), -V.yaw, V.dead && !quiet ? 0.35 : PEEK_ROLL*pk);
      }
      // slide: a grounded sprint's camera dips then settles (Calm stills it; never while you watch someone)
      if(!quiet && V.slideK > 0 && !WP && !KC){
        camera.position.y -= V.slideK*SLIDE_DIP;
        camera.rotation.z += V.slideRoll;
      }
      // launcher blast: the world shudders for a moment (Calm stills it)
      if(!quiet && t - V.shakeAt < 0.35){
        var st = 1 - (t - V.shakeAt)/0.35, st2 = st*st*0.05;
        camera.position.x += (FS.mb32((t*397)|0) - 0.5)*2*st2;
        camera.position.y += (FS.mb32((t*397)|0 ^ 5917) - 0.5)*2*st2;
        camera.rotation.z += (FS.mb32((t*397)|0 ^ 1301) - 0.5)*2*st2*0.8;
      }
      sun.position.set(M.x + 14, 30, M.z + 10); sun.target.position.set(M.x, 0, M.z);
      // scoped in: ease to this weapon's ADS FOV and slow the bob so the sight picture settles (visual only)
      V.fov = V.fov || camera.fov;
      var wantFov = V.ads ? ((ADS[V.w] || {fov: FOV_ADS}).fov) : FOV;
      V.fov += (wantFov - V.fov)*clamp(dt*10, 0, 1);
      if(Math.abs(camera.fov - V.fov) > 0.01){ camera.fov = V.fov; camera.updateProjectionMatrix(); }
      // the weapon in your hands: bob, recoil, a muzzle flash
      guns.forEach(function(g, gi){ g.visible = V.w === gi; });
      if(seatFlash && guns[V.w] && V.w !== V.seatedW){ V.seatedW = V.w; seatFlash(guns[V.w]); }
      var spd = Math.sqrt((M.vx || 0)*(M.vx || 0) + (M.vz || 0)*(M.vz || 0)), bobA = quiet ? 0 : clamp(spd/FS.RUN, 0, 1)*0.012*(V.ads ? 0.3 : 1);
      var rl = V.reloadAt ? clamp((V.reloadAt - t)/W().reload, 0, 1) : 0, dip = V.reloadAt ? Math.sin(rl*Math.PI)*0.25 : 0;
      // scoped: the gun rises to your eye — centred under the dot, the scope ring blacks out the rest
      var adsIn = V.ads ? 1 : 0;
      var adsCfg = ADS[V.w] || {fov: FOV_ADS, cls: ""};  // launcher + grapple (3/4) take the generic: a light zoom, no sight art
      var reddot = V.ads && adsCfg.cls === "reddot";
      var revAds = V.ads && adsCfg.cls === "";  // revolver/launcher: no sight — gun big by the eye, sitting below the aim point
      var ax = 0.2*(1 - adsIn), ay = (-0.25 + 0.09*adsIn) - Math.abs(Math.cos(V.bob*2))*bobA - dip*0.3 - (V.dead ? 1 : 0), az = -0.42 + 0.10*adsIn;
      if(reddot){ ay = -0.41; }  // SMG sighted: dropped clear of the sight's bottom border (size stays 1 — scale grows it into view)
      if(revAds){ ay = -0.27; }  // revolver/launcher sighted: big by the eye, sitting just below the aim point
      var gsc = reddot ? 1.4 : revAds ? 1.45 : 1;  // SMG z stays put (scaling z distorts the pose); revolver/launcher come close
      gunHold.scale.set(gsc, gsc, gsc);
      gunHold.position.set(ax + Math.sin(V.bob*2)*bobA, ay, ((V.ads ? (revAds ? -0.52 : -0.8) : az)) + V.kick*(V.w ? 0.06 : 0.03));
      gunHold.rotation.set(V.kick*(V.w ? 0.12 : 0.05) - dip - (reddot ? 0 : 0.18*adsIn), 0, 0);
      var sniper = V.ads && adsCfg.cls === "sniper";
      gunHold.visible = !V.dead && !sniper;
      if(flash){ var fa = t - V.flashAt; flash.visible = fa < (quiet ? 0.03 : 0.05) && !V.dead; flash.scale.setScalar((quiet ? 0.07 : 0.13)*(V.w ? 1.3 : 1)); flash.material.opacity = quiet ? 0.5 : 0.95; flash.material.rotation = V.n*1.3; }
      if(muzzle){ muzzle.intensity = (t - V.flashAt) < 0.06 && !V.dead && !quiet ? (V.w ? 26 : 15) : 0; }
      // taking a hit: a small shake (the red vignette itself is the existing .vg-fps-vig overlay)
      var hurtA = clamp(1 - (now() - V.hurtAt)/0.5, 0, 1);
      if(!quiet && hurtA > 0){ var sh = hurtA*0.05; camera.position.x += Math.sin(t*47)*sh; camera.position.y += Math.sin(t*61)*sh; camera.rotation.z += Math.sin(t*53)*sh*0.4; }
      // the dock breathes: emissive accents pulse gently with the round (off when calm)
      for(var pi = 0; pi < pulseMats.length; pi++){ pulseMats[pi].m.emissiveIntensity = quiet ? pulseMats[pi].max*0.4 : pulseMats[pi].max*(0.55 + 0.45*Math.sin(t*1.4 + pi)); }
      renderer.clear();
      if(E.listener) E.listener(camera);                               // [sound] the ears: this camera (bots' shots, blasts)
      renderer.render(scene, camera);
      renderer.clearDepth();
      if(!V.watch && !KC) renderer.render(vScene, vCam);  // no weapon in your hands while you watch — or ride a kill cam
    };
    R.dispose = function(){
      cv.removeEventListener("webglcontextlost", lost);
      if(typeof fxStop === "function") fxStop();
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
  loadMap(mapIdOf()).then(function(){ if(!V.alive) return; renderMenu(); if(V.mode === "mp" && V.gotView) applyView(V.round); else if(V.mode === "mp") requestView(); },
    function(){ V.note = "Couldn't load the arena — refresh the page and try again."; renderMenu(); });
  if(!raf) raf = requestAnimationFrame(frame);
  V.destroy = function(){
    if(E.listener) E.listener(null);
    if(WB){ WB.destroy(); WB = null; }
    V.alive = false;
    if(raf) cancelAnimationFrame(raf); raf = 0;
    window.removeEventListener("resize", onResize); if(ro) ro.disconnect();
    // (no window key listeners here — strike's keys live in HQV.input.create, cleaned up
    // below; the removeEventListener pair fps.js needs used to be pasted in by mistake and
    // threw "onTab is not defined" on every destroy, which the hub showed as a mount error)
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
  V.startBotMatch = startBotMatch;
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
  // the lobby handler calls this on every lobby view change (host flip, someone joins)
  // so the menu no longer freezes at mount time on "waiting for the host"
  V.rerenderMenu = renderMenu;
  return V;
}

/* ---------- registration: a solo card and a "with friends" card ---------- */
HQV.register({id: "strike", name: "Strikezone", icon: "💀", desc: "Team shootout: play 1v1 to 5v5 with AI teammates and enemies offline, or match up in the Arena",
  mount: function(el){ if(CUR) CUR.destroy(); CUR = makeGame(el, {mode: "practice"}); },
  unmount: function(){ if(CUR){ CUR.destroy(); CUR = null; } },
  pause: function(){ if(CUR) CUR.hqPaused = true; },
  resume: function(){ if(CUR) CUR.hqPaused = false; }});

if(MP){
  MP.handlers.strike = {
    on: function(m){ if(CUR && CUR.ctx) CUR.onEvent(m); },
    onError: function(m){ return CUR && CUR.ctx ? CUR.onError(m) : false; },
    // a lobby event (host flip, a join, a leave) may change who's allowed to press
    // "Start the match"; repaint the menu so it stops saying "waiting for the host"
    render: function(){ if(CUR && CUR.rerenderMenu && CUR.mode === "mp") CUR.rerenderMenu(); }
  };
  MP.register("strike", "💀", "Team shootout for up to 8 (X vs X, bots fill in): the server judges every shot", function(ctx){
    if(CUR) CUR.destroy();
    var g = CUR = makeGame(ctx.box, {mode: "mp", ctx: ctx});
    ctx.onConn = function(on){ if(g.alive) g.onConn(on); };
    ctx.onRejoin = function(){ if(g.alive && MP) MP.send("strike", "view"); };
    ctx.stop = function(){ g.destroy(); if(CUR === g) CUR = null; };
  });
}
HQV.strikeShared = FS;    // for tests/test_strike_sync.py
FS.hashMatch = hashMatch;
FS.boltPts = boltPts;
FS.boltBranch = boltBranch;
HQV.strikeDebug = function(){ return CUR; };
})();
