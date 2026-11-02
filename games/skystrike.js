/* SkyStrike — original city slinger (Valley 3.x).
 *
 * A smooth, human silhouette (never boxy, never a robot): charcoal high-mobility
 * suit, thin neon-blue piping, hood up, dark full mask with two glowing angular
 * eyes, sharp chest mark. Opening this Valley game drops you into The Commons
 * as that body.
 *
 * Original design — invent your own. Not a copy of any licensed character,
 * suit, emblem or name.
 *
 *   HQV.skystrike.build()      -> Promise<{o, mixer, acts, cur, base, hip, update}>
 *   HQV.skystrike.wanted(key)  true while this game is open, for "you:*" only
 *   HQV.skystrike.arm(on)      Valley game arms / disarms the hero body
 *   HQV.skystrike.COMMONS()    the live world this game opens (claude-hq@3)
 *   HQV.skystrike.myTop(rs)    where to spawn: the top of YOUR HQ (pure; else tallest)
 *   HQV.skystrike.tallTop(rs)  where to spawn: the top of the tallest tower (pure)
 *   HQV.skystrike.onDeckSpot(R, x, z)  is (x, z) walkable on that roof's deck? (pure)
 *
 * Opening the game drops the hero on top of YOUR HQ (myTop -> inst.teleport with the
 * deck's y, so the city's groundY holds him there). The teleport waits for the city
 * to actually place him (api.onWorld("city")) — goCity returns as soon as enterWorld
 * starts, and its own street spawn runs later. While Valley is open the page never
 * polls the Arena's open-HQ list (22-hq.js only does that in the HQ view), so this
 * mount pumps it itself and rebuilds the street when it lands; the teleport retries
 * until a roof exists, then stops. ONE teleport per placement: nothing watches him
 * afterwards. A watching loop that re-teleports while he stands near the spawn point
 * yanks him back every step he takes on the deck.
 *
 * Rig: arm / leg bones rest along ±X / −Y so city seating can aimBone them.
 * Elbows and knees are nested bones. Locomotion hangs the arms (not T) and
 * swings them like a human; the knee folds backward (heel to seat).
 *
 * Arm axis notes (why the hang / elbow math looks like this):
 *   Geometry runs along ±X (T) so aimBone(..., "x") can seat the arms.
 *   Hanging is a Z rotation of ∓π/2, which maps local ±X to world −Y.
 *   After that hang, local Y is world X (the sagittal flex axis), so the
 *   elbow must rotate around local Y — local X would only twist the forearm.
 *   Hands therefore also run along ±X so they hang down with the limb.
 */
(function(){
"use strict";
var HQV = window.HQV = window.HQV || {};
var E = HQV.engine;

var ARMED = 0;

/* The live Commons (HQ 3.15, D2: claude-hq@3) — the whole map: the HQ towers
   and Skyline Park. Resolved at OPEN time, never at load time. This script is
   in VALLEY_FILES and runs before world.js / hqcity3d.js, so a module-level id
   would freeze at an old fallback and the hero would land on claude-hq@2 —
   the pre-3.15 world, no towers, no park. loadChain will not rescue that
   either: it tries the id you ask for first, and an Arena still serves @2. */
/* Where the hero starts: the top of the tallest tower in the world.
   roofs: the City's HQ roofs (games/hqroof.js), each {pad, deck, lift, house, name}.
   Prefers the tallest deck.y; on a tie the wider deck (more room to stand).
   Returns {x, z, y, yaw, name} or null — the caller then leaves the street spawn. */
/* (x, z) on this roof's deck? Same rule as hqroof.js onDeck (minus the head house):
   the helideck's disc when deck.r is set, else the rotated rectangle. Must stay true
   of the spawn — off the deck the city's groundY is the street and the hero drops. */
function onDeckSpot(R, x, z){
  if(!R || !R.deck) return false;
  var D = R.deck, x1 = +x || 0, z1 = +z || 0;
  if(D.r > 0){ if(Math.hypot(x1 - (+D.x || 0), z1 - (+D.z || 0)) > (+D.r || 0)) return false; }
  else {
    var dx = x1 - (+D.x || 0), dz = z1 - (+D.z || 0), rot = +D.rot || 0;
    var c = Math.cos(-rot), s = Math.sin(-rot);
    var lx = dx*c + dz*s, lz = -dx*s + dz*c;
    if(Math.abs(lx) > (+D.hw || 0) || Math.abs(lz) > (+D.hd || 0)) return false;
  }
  // the lift's head house is not walkable (hqroof.js onDeck)
  if(R.house && Math.hypot(x1 - (+R.house.x || 0), z1 - (+R.house.z || 0)) < (+R.house.r || 0)) return false;
  return true;
}

function tallTop(roofs){
  if(!roofs || !roofs.length) return null;
  var best = null, bestY = -Infinity, bestArea = -1;
  for(var i = 0; i < roofs.length; i++){
    var R = roofs[i]; if(!R || !R.deck) continue;
    var y = +R.deck.y || 0;
    var area = (R.deck.hw || 0)*(R.deck.hd || 0);
    if(R.deck.r > 0) area = Math.PI*(+R.deck.r)*(+R.deck.r);       // helideck: a disc
    if(y > bestY || (y === bestY && area > bestArea)){
      bestY = y; bestArea = area; best = R;
    }
  }
  if(!best) return null;
  var D = best.deck, L = best.lift || D;
  // the lift door (hqroof's spotBeside): the one spot a roof always leaves walkable
  var x = +L.x || +D.x || 0, z = +L.z || +D.z || 0;
  if(!onDeckSpot(best, x, z)){
    // step from the lift toward the deck centre until we are on it
    var dx = (+D.x || 0) - x, dz = (+D.z || 0) - z, d = Math.hypot(dx, dz) || 1;
    x += dx/d*Math.min(d, 1.2); z += dz/d*Math.min(d, 1.2);
    if(!onDeckSpot(best, x, z)){ x = +D.x || 0; z = +D.z || 0; }
  }
  // facing out from the deck centre, over the pad
  var ox = (+D.x || 0) - x, oz = (+D.z || 0) - z;
  return {x: x, z: z, y: +D.y || 0, yaw: Math.atan2(ox, oz), name: best.name || "a tower"};
}

/* Top of YOUR HQ. "your HQ" is the request — the tallest tower is only the
   fallback (no own roof yet, or a private city with no one on the street).
   Same on-deck spot rule as tallTop. */
function myTop(roofs){
  if(!roofs || !roofs.length) return null;
  var mine = null;
  for(var i = 0; i < roofs.length; i++){ var R = roofs[i]; if(R && R.deck && R.own){ mine = R; break; } }
  if(mine){
    var D = mine.deck, L = mine.lift || D;
    var x = +L.x || +D.x || 0, z = +L.z || +D.z || 0;
    if(!onDeckSpot(mine, x, z)){
      var dx = (+D.x || 0) - x, dz = (+D.z || 0) - z, d = Math.hypot(dx, dz) || 1;
      x += dx/d*Math.min(d, 1.2); z += dz/d*Math.min(d, 1.2);
      if(!onDeckSpot(mine, x, z)){ x = +D.x || 0; z = +D.z || 0; }
    }
    var ox = (+D.x || 0) - x, oz = (+D.z || 0) - z;
    return {x: x, z: z, y: +D.y || 0, yaw: Math.atan2(ox, oz), name: "your HQ"};
  }
  return tallTop(roofs);
}

/* ---------- air: double jump, dive, web-swing (pure) ----------
   A city slinger leaves the roof, dives head-first, and swings off a neon
   line to whatever the city will hold: a tower ledge, a streetlight, a bridge
   span, a park ride. The swing is a spherical pendulum with a WASD pump; the
   pose is human (one arm up the line, the body hanging and stretching), never
   a rigid T hanging from a string. */

/* jump: Space edge. First jump from the ground, a second one in the air
   (which also kicks a slow axial spin). Returns the vertical impulse.
   The double jump is the TALLER of the two — it is what carries you off the
   HQ deck — and a jump always leaves the spot you stood on. */
function jumpImpulse(s, grounded, spaceEdge, calm){
  if(!s || calm || !spaceEdge) return 0;
  if(grounded){ s.jumps = 1; s.spinV = 0; s.launch = 1; return 7.2; }
  if(s.jumps < 2){
    s.jumps = 2;
    s.spinV = 2.2;                 // the second jump kicks a spin
    s.launch = 1;
    return 9.0;                    // the double jump is the taller one
  }
  return 0;
}

/* A jump is a launch, not a hop on the spot: keep the pace you walked in with
   (the walk's own speed is seeded into the air state every frame on the feet),
   and a standing jump still leaves the mark along the facing. */
function jumpKick(st, yaw, minSpeed){
  if(!st) return;
  var run = Math.sqrt((+st.vx || 0)*(+st.vx || 0) + (+st.vz || 0)*(+st.vz || 0));
  var want = minSpeed == null ? 5.2 : Math.max(0, +minSpeed || 0);
  if(run >= want) return;
  var hx = Math.sin(+yaw || 0), hz = Math.cos(+yaw || 0);
  st.vx = (+st.vx || 0) + hx*(want - run);
  st.vz = (+st.vz || 0) + hz*(want - run);
}

/* The launch curl: a short tuck right after a jump that UNWINDS IN THE AIR.
   1 at the press, 0 about a third of a second later — so a jump bends, then
   restores itself before he lands (never a bend held all the way down). */
function launchBlend(s, dt){
  if(!s) return 0;
  var d = dt > 0 ? Math.min(0.1, +dt) : 0;
  s.launch = Math.max(0, (+s.launch || 0) - 3.2*d);
  if(s.launch < 0.001) s.launch = 0;
  return s.launch;
}

/* Dive: falling from height with W held. A continuous 0..1 so the body
   tips over into the dive instead of snapping into it. */
function diveBlend(s, want, dt){
  if(!s) return 0;
  var w = want ? 1 : 0, d = dt > 0 ? Math.min(0.1, +dt) : 0;
  var k = 1 - Math.exp(-(w ? 10 : 6)*d);
  s.dive = (s.dive || 0) + (w - (s.dive || 0))*k;
  if(s.dive < 0.001) s.dive = 0;
  return s.dive;
}

/* W + falling from height. `hop` is how far above the ground he is, `vy` the
   vertical rate: a drop off the HQ deck (vy already negative) dives at once. */
function wantDive(wDown, hop, vy){
  if(!wDown) return false;
  var h = +hop || 0, v = +vy || 0;
  return (h > 1.0 || v < -3) && v < 1.5;
}

/* Spherical pendulum: gravity, a WASD pump in the swing plane, and an
   inextensible rope. Releasing the web keeps the velocity (a projectile).
   sw = {x, y, z, ax, ay, az, len, vx, vy, vz, yaw, t}. */
function swingStep(sw, dt, input){
  if(!sw || !(dt > 0)) return sw;
  dt = Math.min(0.05, +dt || 0);
  var g = 18;
  sw.vx = +sw.vx || 0; sw.vy = +sw.vy || 0; sw.vz = +sw.vz || 0;
  sw.vy -= g*dt;
  var dx = sw.x - sw.ax, dy = sw.y - sw.ay, dz = sw.z - sw.az;
  var dist = Math.sqrt(dx*dx + dy*dy + dz*dz) || 1e-6;
  // tangent basis: "forward" along the swing's horizontal motion
  var fx = sw.vx, fz = sw.vz, fl = Math.sqrt(fx*fx + fz*fz);
  if(fl < 0.05){ fx = Math.sin(sw.yaw || 0); fz = Math.cos(sw.yaw || 0); fl = 1; }
  fx /= fl; fz /= fl;
  var rx = fz, rz = -fx;
  var inp = input || {};
  var pump = +inp.fwd || 0, lean = +inp.side || 0;
  var ax = fx*pump*14 + rx*lean*10, az = fz*pump*14 + rz*lean*10, ay = 0;
  // a pump at the bottom of the arc lifts (how a person pumps a swing). The
  // gate is a RAMP, not a switch — `dy < -0.3` used to snap the lift on and off
  // and that on/off is what made the swing read as jerky.
  if(pump > 0){
    var bot = 1 - Math.max(0, Math.min(1, (dy + 0.9)/1.6));
    ay += 6*pump*bot;
  }
  sw.vx += ax*dt; sw.vy += ay*dt; sw.vz += az*dt;
  sw.x += sw.vx*dt; sw.y += sw.vy*dt; sw.z += sw.vz*dt;
  // the rope: pull back onto the sphere and kill the outward radial rate.
  // Never SNAP the body through a wall to honour the length — the pull is
  // SWEPT, so a clamp whose path crosses a tower stops at the last free point
  // and slackens the rope there. Testing only the endpoint let the body be
  // teleported clean through a building in one frame.
  dx = sw.x - sw.ax; dy = sw.y - sw.ay; dz = sw.z - sw.az;
  dist = Math.sqrt(dx*dx + dy*dy + dz*dz) || 1e-6;
  if(dist > sw.len){
    var k = sw.len/dist;
    var snap = {x: sw.ax + dx*k, y: sw.ay + dy*k, z: sw.az + dz*k};
    var clampFree = true;
    var csx = sw.x, csy = sw.y, csz = sw.z;
    if(typeof sw._blocked === "function"){
      var pull = Math.sqrt((snap.x-csx)*(snap.x-csx) + (snap.y-csy)*(snap.y-csy) + (snap.z-csz)*(snap.z-csz));
      var stepN = Math.max(1, Math.ceil(pull/0.4));
      for(var cs = 1; cs <= stepN; cs++){
        var cu = cs/stepN;
        var cx = sw.x + (snap.x - sw.x)*cu, cy = sw.y + (snap.y - sw.y)*cu, cz = sw.z + (snap.z - sw.z)*cu;
        if(sw._blocked(cx, cy, cz)){
          // the pull ran into geometry: stop at the last free point on the path
          var cu0 = (cs - 1)/stepN;
          snap.x = sw.x + (snap.x - sw.x)*cu0;
          snap.y = sw.y + (snap.y - sw.y)*cu0;
          snap.z = sw.z + (snap.z - sw.z)*cu0;
          clampFree = false;
          break;
        }
      }
    }
    sw.x = snap.x; sw.y = snap.y; sw.z = snap.z;
    if(!clampFree){
      // the pull ran into geometry. Slacken the rope to the contact distance so
      // the next frame cannot yank him back through the wall toward the anchor.
      // SHRINK ONLY — a rope that can stretch lets the swing cut clean through a
      // building. If the clamp can barely travel at all the line is fouled: a
      // frozen clamp is exactly "stuck mid-swing", so RELEASE the line and let
      // him fall / grab again rather than park him on the geometry.
      dx = sw.x - sw.ax; dy = sw.y - sw.ay; dz = sw.z - sw.az;
      var dC = Math.sqrt(dx*dx + dy*dy + dz*dz) || 1e-6;
      if(dC > 0.5 && dC < sw.len) sw.len = dC;
      var travel = Math.sqrt((snap.x - csx)*(snap.x - csx) + (snap.y - csy)*(snap.y - csy) + (snap.z - csz)*(snap.z - csz));
      if(travel < 0.12){
        sw.foul = (+sw.foul || 0) + dt;
        if(sw.foul > 0.12){ sw.dead = 1; return sw; }
      } else sw.foul = 0;
    } else {
      // a clean clamp clears any foul: only a PROLONGED jam releases the line
      sw.foul = 0;
    }
    dist = Math.sqrt(dx*dx + dy*dy + dz*dz) || 1e-6;
    var nx = dx/dist, ny = dy/dist, nz = dz/dist;
    var vr = sw.vx*nx + sw.vy*ny + sw.vz*nz;
    if(vr > 0){ sw.vx -= nx*vr; sw.vy -= ny*vr; sw.vz -= nz*vr; }
  }
  var sp = Math.sqrt(sw.vx*sw.vx + sw.vz*sw.vz);
  if(sp > 0.4) sw.yaw = Math.atan2(sw.vx, sw.vz);
  sw.t = (sw.t || 0) + dt;
  return sw;
}

/* The neon line: a shallow catenary (parabolic sag) from the hand to the
   anchor. n segments; includes both ends. */
function webPoints(from, to, sag, n){
  var N = Math.max(2, n | 0 || 8), out = [];
  var s = sag == null ? 0.12 : Math.max(0, +sag || 0);
  for(var i = 0; i <= N; i++){
    var u = i/N, v = 1 - u;
    out.push({
      x: (+from.x || 0)*v + (+to.x || 0)*u,
      y: (+from.y || 0)*v + (+to.y || 0)*u - s*4*u*v,
      z: (+from.z || 0)*v + (+to.z || 0)*u
    });
  }
  return out;
}

function commonsId(){
  var W = HQV.world, C = HQV.hqCity3d;
  if(W && typeof W.COMMONS === "string" && W.COMMONS) return W.COMMONS;
  if(C && typeof C.COMMONS === "string" && C.COMMONS) return C.COMMONS;
  return "claude-hq@3";
}

/* Where to shoot the line. Returns a unit direction list, nearest-first from the
   body's own facing. Up-and-forward first (a ledge above), then the sides and a
   little down — a drop down a tower FACE has nothing above it, only the wall it
   is falling past. A fan that only looks up can never stick. */
function webAims(yaw){
  var y = +yaw || 0, out = [], i, a, k;
  // up-forward, up, up-wide L/R, behind, then SIDE (a wall beside) and
  // slightly-down-forward (the face under your hand as you drop past it)
  var offs = [0, -0.45, 0.45, -0.95, 0.95, 1.9, -1.9, 1.35, -1.35, 0.75, -0.75, 2.4, -2.4];
  var ups  = [0.85, 1.05, 1.05, 0.8, 0.8, 0.7, 0.7, 0.18, 0.18, -0.12, -0.12, 0.12, 0.12];
  for(i = 0; i < offs.length; i++){
    a = y + offs[i];
    k = ups[i];
    // forward = (sin y, 0, cos y); up = (0, 1, 0)
    var fx = Math.sin(a), fz = Math.cos(a);
    var dx = fx*(1 - Math.abs(k)*0.25), dy = k, dz = fz*(1 - Math.abs(k)*0.25);
    var l = Math.sqrt(dx*dx + dy*dy + dz*dz) || 1;
    out.push({x: dx/l, y: dy/l, z: dz/l});
  }
  return out;
}

/* Where a WEB ZIP shoots: straight ahead, a fan on the facing, and a touch
   above / below — whatever is IN FRONT of you. Not the swing's 13-way sky fan:
   a zip is a point-launch at the wall or ledge you are flying toward, so the
   set is forward-weighted — but it must still REACH a wall at hand height,
   beside you, or a little below, or Space finds nothing and the zip is
   invisible. */
function zipAims(yaw){
  var y = +yaw || 0, out = [], i, a, k;
  var offs = [0, -0.18, 0.18, -0.42, 0.42, -0.72, 0.72, -1.1, 1.1, -1.55, 1.55];
  var ups  = [0.18, 0.32, 0.32, 0.12, 0.12, 0.05, 0.05, -0.05, -0.05, -0.18, -0.18];
  for(i = 0; i < offs.length; i++){
    a = y + offs[i];
    k = ups[i];
    var fx = Math.sin(a), fz = Math.cos(a);
    var dx = fx*(1 - Math.abs(k)*0.25), dy = k, dz = fz*(1 - Math.abs(k)*0.25);
    var l = Math.sqrt(dx*dx + dy*dy + dz*dz) || 1;
    out.push({x: dx/l, y: dy/l, z: dz/l});
  }
  return out;
}

/* Where the web hand is: the wrist of the RAISED arm (sign +1 = left). The
   character stands at (st.x, st.y, st.z) facing st.yaw, so the hand sits out to
   the side of the chosen shoulder, forward and UP — the shot comes from a held-up
   palm, never a point floating beside the chest. */
function handOf(st, sign){
  if(!st) return {x: 0, y: 0, z: 0};
  var s = sign != null ? (sign < 0 ? -1 : 1) : (st.webSide < 0 ? -1 : 1);
  var y = +st.yaw || 0;
  var fx = Math.sin(y), fz = Math.cos(y);     // forward
  var rx = fz, rz = -fx;                       // right of facing
  // shoulder is ±0.24 out, hand is further out and up (arm held high)
  return {
    x: (+st.x || 0) + rx*s*0.52 + fx*0.16,
    y: (+st.y || 0) + 2.02,
    z: (+st.z || 0) + rz*s*0.52 + fz*0.16
  };
}

/* First solid AABB along a ray. boxes: [{min:{x,y,z}, max:{x,y,z}}].
   Returns {x, y, z, t} (t in [0, 1] of maxDist) or null. Pure — node-tested.
   This is the geometry a web can actually stick to: building lots, placed HQs,
   tree crowns, bridge bars. A mesh raycast against door drums finds nothing. */
function segAABB(from, to, b){
  if(!b || !b.min || !b.max) return 1;
  var t0 = 0, t1 = 1, ax = ["x", "y", "z"];
  for(var i = 0; i < 3; i++){
    var a = ax[i], d = to[a] - from[a];
    if(Math.abs(d) < 1e-9){ if(from[a] < b.min[a] || from[a] > b.max[a]) return 1; continue; }
    var u = (b.min[a] - from[a])/d, v = (b.max[a] - from[a])/d;
    if(u > v){ var tt = u; u = v; v = tt; }
    if(u > t0) t0 = u; if(v < t1) t1 = v;
    if(t0 > t1) return 1;
  }
  return t0;
}
function rayBoxes(from, dir, maxDist, boxes){
  if(!from || !dir || !boxes || !boxes.length) return null;
  var dx = +dir.x || 0, dy = +dir.y || 0, dz = +dir.z || 0;
  var l = Math.sqrt(dx*dx + dy*dy + dz*dz);
  if(l < 1e-8) return null;
  dx /= l; dy /= l; dz /= l;
  var far = Math.max(2, Math.min(80, +maxDist || 42));
  var o = {x: +from.x || 0, y: +from.y || 0, z: +from.z || 0};
  var to = {x: o.x + dx*far, y: o.y + dy*far, z: o.z + dz*far};
  var best = 1, hit = null;
  for(var i = 0; i < boxes.length; i++){
    var t = segAABB(o, to, boxes[i]);
    if(t < best){ best = t; hit = boxes[i]; }
  }
  if(best >= 1 || !hit) return null;
  return {x: o.x + dx*far*best, y: o.y + dy*far*best, z: o.z + dz*far*best, t: best};
}

/* First thing in front of a web ZIP: a point-launch target, not the swing's
   13-way sky fan. Nothing in front (open sky) returns null — then the air press
   falls back to the double jump, so the HQ-top escape still works.
   A target CLOSER than 2.4 m is not a zip: that is the wall you are standing on
   or pressed against, and yanking to it is what made "Space to jump away from
   the building" pull him INTO it instead. */
function zipHit(st, env){
  if(!st || !env || typeof env.anchor !== "function") return null;
  var from = handOf(st);
  var aims = zipAims(st.yaw || 0);
  for(var i = 0; i < aims.length; i++){
    var got = env.anchor(from, aims[i], 42);
    if(!got || !isFinite(got.x) || !isFinite(got.y) || !isFinite(got.z)) continue;
    var dx = +got.x - (+from.x || 0), dy = +got.y - (+from.y || 0), dz = +got.z - (+from.z || 0);
    if(Math.sqrt(dx*dx + dy*dy + dz*dz) < 2.4) continue;   // too close: the wall you are on
    return got;
  }
  return null;
}

/* Space in free fall near a building: JUMP AWAY from it (back into free fall),
   do not zip into its face. The outward normal `n` points away from the wall;
   the press must put him in the air, then W dives or Shift swings. */
function jumpAwayFrom(st, n, dt){
  if(!st || !n) return false;
  var knx = +n.nx || 0, knz = +n.nz || 0;
  st.wall = null;
  st.gripT = 0.32;                     // no instant re-grab of the face just left
  st.vy = Math.max((+st.vy || 0) + 7.4, 8.2);
  st.vx = knx*7.0 + Math.sin(st.yaw || 0)*1.6;
  st.vz = knz*7.0 + Math.cos(st.yaw || 0)*1.6;
  st.x += st.vx*(dt || 0); st.y += st.vy*(dt || 0); st.z += st.vz*(dt || 0);
  st.jumps = 1; st.coastT = 0;
  st.webFrom = null; st.webTo = null;
  st.zip = null;
  return true;
}

/* Start a web zip: the line is on the hand and the body is about to be yanked
   to the point. The momentum at the end is kept, so a zip chains into a swing. */
function startZip(st, hit){
  if(!st || !hit) return null;
  var from = handOf(st);
  st.zip = {
    ax: +hit.x || 0, ay: +hit.y || 0, az: +hit.z || 0,
    t: 0, dur: 0.38
  };
  st.webFrom = {x: from.x, y: from.y, z: from.z};
  st.webTo = {x: st.zip.ax, y: st.zip.ay, z: st.zip.az};
  st.webArm = st.webSide;
  st.coastT = 0;                       // a zip is a deliberate redirect
  st.jumps = Math.max(1, st.jumps | 0);
  return st.zip;
}

/* One step of the yank. Hard pull along the line toward the point (that is the
   "throw a web at what is in front and pull me to it"), a touch of lift so a zip
   up a wall reads as a climb, and a stop short of the surface so he never
   embeds in it. Returns the zip while it is running, null when it is done. */
function zipStep(st, dt, solids){
  if(!st || !st.zip) return null;
  var z = st.zip;
  z.t = (+z.t || 0) + (dt > 0 ? dt : 0);
  var dx = z.ax - st.x, dy = z.ay - st.y, dz = z.az - st.z;
  var d = Math.sqrt(dx*dx + dy*dy + dz*dz) || 1e-6;
  if(d < 1.25 || z.t > (z.dur || 0.38)){
    st.zip = null;                     // arrived: the speed is yours now
    return null;
  }
  var want = Math.min(34, 10 + d*3.4); // further target, harder the yank
  st.vx = dx/d*want;
  st.vy = dy/d*want*0.9 + 2.4;
  st.vz = dz/d*want;
  var prev = {x: st.x, y: st.y, z: st.z};
  st.x += st.vx*dt; st.y += st.vy*dt; st.z += st.vz*dt;
  // all construction is opaque — a zip never flies through a wall. SWEEP the
  // whole move: looking only at the destination let a fast yank sail clean
  // through a tower in one frame.
  if(typeof solids === "function"){
    var nx = bodyBlock(prev, {x: st.x, y: st.y, z: st.z, vx: st.vx, vy: st.vy, vz: st.vz}, sweepBoxes(prev, st, solids));
    st.x = nx.x; st.y = nx.y; st.z = nx.z;
    st.vx = nx.vx; st.vy = nx.vy; st.vz = nx.vz;
  }
  var sp = Math.sqrt(st.vx*st.vx + st.vz*st.vz);
  if(sp > 0.4) st.yaw = Math.atan2(st.vx, st.vz);
  st.webArm = st.webSide;
  return z;
}

/* Gather every solid AABB the segment prev->next can touch. The city's solids
   are looked up at a point (a 40 m box around it), so a body that LEAPS past a
   building in one frame — a fast swing, a long rope clamp — would find no box
   at the destination and sail clean through it. Sample along the whole path so
   every box the move crosses is in the list. Pure. */
function sweepBoxes(prev, next, lookup){
  if(typeof lookup !== "function") return [];
  var seen = {}, out = [], i, b, k;
  var p0x = +((prev && prev.x) || 0), p0y = +((prev && prev.y) || 0), p0z = +((prev && prev.z) || 0);
  var p1x = +((next && next.x) || 0), p1y = +((next && next.y) || 0), p1z = +((next && next.z) || 0);
  var d = Math.sqrt((p1x-p0x)*(p1x-p0x) + (p1y-p0y)*(p1y-p0y) + (p1z-p0z)*(p1z-p0z));
  // 0.7 m steps: fine enough that no face is skipped (a swing, zip or steep dive moves
  // metres a frame; a 1.2 m stride can land its sole sample on the far side of a thin
  // solid — a wing, a fence, a hangar wall — and sail through), cheap enough per frame
  var n = Math.max(1, Math.min(40, Math.ceil(d/0.7)));
  for(i = 0; i <= n; i++){
    var u = i/n, list = null;
    try { list = lookup(p0x + (p1x-p0x)*u, p0y + (p1y-p0y)*u, p0z + (p1z-p0z)*u); } catch(e){ list = null; }
    if(!list) continue;
    for(var j = 0; j < list.length; j++){
      b = list[j];
      if(!b || !b.min || !b.max) continue;
      k = (b.id != null ? String(b.id) : "") + ":" + b.min.x + "," + b.min.y + "," + b.min.z;
      if(seen[k]) continue;
      seen[k] = 1;
      out.push(b);
    }
  }
  return out;
}

/* All construction is opaque. A body flying through the city — swinging on a
   line, zipping to a point, or free-falling — must stop at a wall, never pass
   through it, and never FREEZE inside one ("stuck in between swinging").
   `boxes` is the city's solid AABB list (hqcity3d solidItems).
   Pure: depenetrates a start already inside a box (the sweep would report t=0
   and freeze him), sweeps prev -> next, and on contact walks back to the last
   free point and kills the velocity that drove him in. Returns the contact
   normal: `wall` is 1 on a horizontal face (a wall, not the floor or a ceiling)
   so wall-running can use it. */
function bodyBlock(prev, next, boxes, r){
  if(!prev || !next) return next;
  var rad = r == null ? 0.42 : Math.max(0.12, +r || 0.42);
  var i, j;
  var out = {
    x: +next.x || 0, y: +next.y || 0, z: +next.z || 0,
    vx: +next.vx || 0, vy: +next.vy || 0, vz: +next.vz || 0,
    nx: 0, ny: 0, nz: 0, wall: 0
  };
  if(!boxes || !boxes.length) return out;
  // Inflate XZ by the body radius (the shoulders) and Y by a hair only. The
  // radius is HORIZONTAL: inflating a floor slab by 0.42 in Y makes it 1.4 m
  // thick and swallows the feet that stand on its top face — the HQ deck's
  // walk height IS its top, and the nearest exit from inside was the UNDERSIDE,
  // so a resting hero was pushed down through the roof and the jump's upward
  // velocity was killed by the sweep's bottom-face pick.
  // Skip paper-thin facade panes when a real wall mass is in the list: they
  // park a climb at ~4 m (their bottom edge) while the tower behind them is
  // what should stop the body. If ONLY panes are present (a sparse tile that
  // dropped the storey), keep them so the body cannot sail clean through.
  var grown = [], anyMass = false;
  for(i = 0; i < boxes.length; i++){
    if(isWallMass(boxes[i])){ anyMass = true; break; }
  }
  for(i = 0; i < boxes.length; i++){
    var b = boxes[i];
    if(!b || !b.min || !b.max) continue;
    if(isPaperPane(b) && anyMass) continue;
    var gEntry = {
      min: {x: +b.min.x - rad, y: +b.min.y - 0.02, z: +b.min.z - rad},
      max: {x: +b.max.x + rad, y: +b.max.y + 0.02, z: +b.max.z + rad},
      _pane: isPaperPane(b) ? 1 : 0
    };
    // Oriented footprint (city v2 lots): the AABB is only the broadphase. The
    // real solid is the rotated box — without it a dive into a corner of the
    // AABB that is outside the facade still "hits", and worse, a facade corner
    // that stuck PAST the old axis-aligned lot rect had NO solid at all.
    if(b.obb && isFinite(+b.obb.ox) && isFinite(+b.obb.oz) &&
       isFinite(+b.obb.fx) && isFinite(+b.obb.fz) &&
       (+b.obb.hu || 0) > 0.2 && (+b.obb.hv || 0) > 0.2){
      gEntry.obb = {
        ox: +b.obb.ox, oz: +b.obb.oz,
        fx: +b.obb.fx, fz: +b.obb.fz,
        hu: (+b.obb.hu || 0) + rad, hv: (+b.obb.hv || 0) + rad
      };
    }
    grown.push(gEntry);
  }
  function inGrown(G, px, py, pz){
    if(py < G.min.y || py > G.max.y) return false;
    if(G.obb){
      var dx = px - G.obb.ox, dz = pz - G.obb.oz;
      return Math.abs(dx*G.obb.fz - dz*G.obb.fx) <= G.obb.hu &&
             Math.abs(dx*G.obb.fx + dz*G.obb.fz) <= G.obb.hv;
    }
    return px >= G.min.x && px <= G.max.x && pz >= G.min.z && pz <= G.max.z;
  }
  // Push a point out of every box that contains it. Without one — a body resting
  // inside a floor — the mass is ABOVE the feet, so the floor pushes UP, never
  // down through the ground.
  function pushOut(px, py, pz){
    for(var dep = 0; dep < 8; dep++){
      var inside = null;
      for(var i2 = 0; i2 < grown.length; i2++){
        var G = grown[i2];
        if(inGrown(G, px, py, pz)){ inside = G; break; }
      }
      if(!inside) break;
      var bnx = 0, bny = 1, bnz = 0, bd0 = 1e9, picked = false;
      // Oriented box: push out along its own face normals (not the fat AABB)
      if(inside.obb){
        var odx = px - inside.obb.ox, odz = pz - inside.obb.oz;
        var ou = odx*inside.obb.fz - odz*inside.obb.fx;
        var ov = odx*inside.obb.fx + odz*inside.obb.fz;
        var oGaps = [
          [ inside.obb.fz, -inside.obb.fx, inside.obb.hu - ou],
          [-inside.obb.fz,  inside.obb.fx, ou + inside.obb.hu],
          [ inside.obb.fx,  inside.obb.fz, inside.obb.hv - ov],
          [-inside.obb.fx, -inside.obb.fz, ov + inside.obb.hv],
          [0, 0, inside.max.y - py, 1],
          [0, 0, py - inside.min.y, -1]
        ];
        // prefer a side exit; only take top/bottom when clearly nearer
        for(var oj = 0; oj < 4; oj++){
          if(oGaps[oj][2] < bd0){ bd0 = oGaps[oj][2]; bnx = oGaps[oj][0]; bny = 0; bnz = oGaps[oj][1]; picked = true; }
        }
        var upG = inside.max.y - py, dnG = py - inside.min.y;
        if((inside.max.y - inside.min.y) < 2.0 && (py + 1.0) > (inside.min.y + inside.max.y)*0.5){
          if(upG <= dnG + 0.6 && upG < bd0){ bnx = 0; bny = 1; bnz = 0; bd0 = upG; }
        } else if(py - inside.min.y >= 1.2){
          if(upG < bd0){ bnx = 0; bny = 1; bnz = 0; bd0 = upG; }
          if(dnG < bd0){ bnx = 0; bny = -1; bnz = 0; bd0 = dnG; }
        }
        px += bnx*(bd0 + 0.02); py += bny*(bd0 + 0.02); pz += bnz*(bd0 + 0.02);
        continue;
      }
      var gaps = [
        [1, 0, 0, inside.max.x - px], [-1, 0, 0, px - inside.min.x],
        [0, 1, 0, inside.max.y - py], [0, -1, 0, py - inside.min.y],
        [0, 0, 1, inside.max.z - pz], [0, 0, -1, pz - inside.min.z]
      ];
      // Standing on a thin floor (a deck slab, a floor plate): the feet sit at
      // its top face and the body mass is above. The nearest exit from inside a
      // thin slab is often the UNDERSIDE — that is what dumped a resting hero
      // down through the HQ roof and then killed the jump's upward velocity
      // against that bogus downward normal. Never take the bottom face out of a
      // thin box the body is sitting on: go out the TOP.
      if((inside.max.y - inside.min.y) < 2.0 &&
         (py + 1.0) > (inside.min.y + inside.max.y)*0.5){
        var upGap = inside.max.y - py, downGap = py - inside.min.y;
        if(upGap <= downGap + 0.6){ bnx = 0; bny = 1; bnz = 0; bd0 = upGap; picked = true; }
      }
      // Standing at the BASE of a tall box (a tower, a wall): the XZ radius puts
      // the centre inside the box, and the nearest exit is then the UNDERSIDE —
      // which pushed a wall-crawling hero down through the street every frame.
      // Never take the bottom face out of a tall box the feet are standing on:
      // go out the nearest SIDE instead.
      if(!picked && (inside.max.y - inside.min.y) >= 2.0 &&
         (py - inside.min.y) < 1.2){
        for(var j3 = 0; j3 < gaps.length; j3++){
          if(gaps[j3][1] < 0) continue;                 // never the underside
          if(gaps[j3][3] < bd0){ bd0 = gaps[j3][3]; bnx = gaps[j3][0]; bny = gaps[j3][1]; bnz = gaps[j3][2]; }
        }
        picked = true;
      }
      // else: nearest face
      if(!picked){
        for(var j2 = 0; j2 < gaps.length; j2++){
          if(gaps[j2][3] < bd0){ bd0 = gaps[j2][3]; bnx = gaps[j2][0]; bny = gaps[j2][1]; bnz = gaps[j2][2]; }
        }
      }
      px += bnx*(bd0 + 0.02); py += bny*(bd0 + 0.02); pz += bnz*(bd0 + 0.02);
    }
    return {x: px, y: py, z: pz};
  }
  // ---- DEPENETRATE the START only, and do NOT let that push write the contact
  // normal. The END stays where it is so the sweep can see the collision (pushing
  // the end out the entry face made the sweep a no-op and left the inward speed
  // intact). ----
  var p0 = pushOut(+prev.x || 0, +prev.y || 0, +prev.z || 0);
  // ---- SWEEP from the (now free) start to next ----
  // Oriented boxes: the AABB is only a broadphase. Find the earliest t where the
  // segment ENTERS the OBB (binary search), then stop on that face. Using the
  // AABB contact + an OBB normal walked the body into the mass on diagonal hits.
  var best = 1, hit = null;
  for(i = 0; i < grown.length; i++){
    var G = grown[i];
    if(G.obb){
      // does the segment end (or any mid point) enter this OBB?
      if(!inGrown(G, out.x, out.y, out.z) && !inGrown(G, (p0.x+out.x)*0.5, (p0.y+out.y)*0.5, (p0.z+out.z)*0.5)){
        // also accept if AABB says we cross and the end is past the slab
        var tA = segAABB(p0, out, G);
        if(tA >= 1) continue;
        var midX = p0.x + (out.x - p0.x)*Math.min(1, tA + 0.05);
        var midY = p0.y + (out.y - p0.y)*Math.min(1, tA + 0.05);
        var midZ = p0.z + (out.z - p0.z)*Math.min(1, tA + 0.05);
        if(!inGrown(G, midX, midY, midZ) && !inGrown(G, out.x, out.y, out.z)) continue;
      }
      var lo = 0, hi = 1, midT, found = false;
      if(inGrown(G, p0.x, p0.y, p0.z)){ lo = 0; hi = 0; found = true; }
      else {
        for(var bit = 0; bit < 14; bit++){
          midT = (lo + hi)*0.5;
          if(inGrown(G,
            p0.x + (out.x - p0.x)*midT,
            p0.y + (out.y - p0.y)*midT,
            p0.z + (out.z - p0.z)*midT)){ hi = midT; found = true; }
          else lo = midT;
        }
      }
      if(!found) continue;
      if(hi < best){ best = hi; hit = G; }
      continue;
    }
    var t = segAABB(p0, out, G);
    if(t < best){ best = t; hit = G; }
  }
  if(best < 1 && hit){
    // Stop just short of the face, but keep the SLIDE along it. Walking the whole
    // sweep vector back by `best` threw away the tangential travel too, so a body
    // pressed against a wall lost a slice of every step and the run read as a
    // stutter. Clip only the component into the face.
    var dxS = out.x - p0.x, dyS = out.y - p0.y, dzS = out.z - p0.z;
    var contact = {
      x: p0.x + dxS*best, y: p0.y + dyS*best, z: p0.z + dzS*best
    };
    // WHICH face did we enter? The nearest face to the contact point is wrong at
    // an edge: grazing a tower's side near its cornice picks the TOP, reports
    // `wall = 0`, and the wall grip never starts ("I can't stick to the building").
    // Pick the face whose outward normal most opposes the sweep — the face the
    // body actually ran into. A fall onto a roof then reads the top face, a swing
    // into a wall reads the side.
    var nx = 0, ny = 0, nz = 0, bd = 1e9, bestOpp = -1e9;
    var faces = [
      [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]
    ];
    // paper panes: never take top/bottom — that parked climbs at ~4 m
    var paneHit = !!(hit && hit._pane);
    if(hit.obb){
      // face normals of the oriented footprint (horizontal) + AABB top/bottom
      faces = [
        [ hit.obb.fz, 0, -hit.obb.fx], [-hit.obb.fz, 0,  hit.obb.fx],
        [ hit.obb.fx, 0,  hit.obb.fz], [-hit.obb.fx, 0, -hit.obb.fz],
        [0, 1, 0], [0, -1, 0]
      ];
      // Prefer the OBB face the contact is ALREADY on (smallest penetration),
      // among those the sweep opposes — ties on diagonal AABB hits used to pick
      // a skew normal and walk the body into the mass.
      var cdx0 = contact.x - hit.obb.ox, cdz0 = contact.z - hit.obb.oz;
      var cu0 = cdx0*hit.obb.fz - cdz0*hit.obb.fx, cv0 = cdx0*hit.obb.fx + cdz0*hit.obb.fz;
      var facePen = [
        Math.abs(hit.obb.hu - Math.abs(cu0)),
        Math.abs(hit.obb.hv - Math.abs(cv0))
      ];
      // u-faces vs v-faces: pick the axis we are closest to leaving
      var useU = facePen[0] <= facePen[1];
      if(useU){
        nx = (cu0 >= 0 ? 1 : -1) * hit.obb.fz;
        nz = (cu0 >= 0 ? -1 : 1) * hit.obb.fx;
        ny = 0; bestOpp = 1;
      } else {
        nx = (cv0 >= 0 ? 1 : -1) * hit.obb.fx;
        nz = (cv0 >= 0 ? 1 : -1) * hit.obb.fz;
        ny = 0; bestOpp = 1;
      }
      // vertical override: if we mostly moved in Y into top/bottom
      if(Math.abs(dyS) > Math.abs(dxS) + Math.abs(dzS) && Math.abs(dyS) > 1e-6){
        if(dyS < 0){ nx = 0; ny = 1; nz = 0; }
        else { nx = 0; ny = -1; nz = 0; }
      }
    }
    if(bestOpp < -1e8){
      for(i = 0; i < faces.length; i++){
        var fnx = faces[i][0], fny = faces[i][1], fnz = faces[i][2];
        if(paneHit && fny !== 0) continue;
        var opp = -(dxS*fnx + dyS*fny + dzS*fnz);       // positive = we ran into it
        if(opp < -1e-9) continue;                        // moving away from that face
        // Among the faces we ran INTO, the one we ran into HARDEST is the face we
        // hit. Grazing a tower's side also "reaches" the top and the ends at opp=0;
        // picking the nearest of those reported the ROOF for a side-on swing and the
        // wall grip never started. So: most opposing first, nearest only as a tie.
        var fd = Math.abs(contact.x - (fnx > 0 ? hit.max.x : fnx < 0 ? hit.min.x : contact.x))
               + Math.abs(contact.y - (fny > 0 ? hit.max.y : fny < 0 ? hit.min.y : contact.y))
               + Math.abs(contact.z - (fnz > 0 ? hit.max.z : fnz < 0 ? hit.min.z : contact.z));
        if(opp > bestOpp + 1e-6){ bestOpp = opp; bd = fd; nx = fnx; ny = fny; nz = fnz; }
        else if(opp > bestOpp - 1e-6 && fd < bd){ bd = fd; nx = fnx; ny = fny; nz = fnz; }
      }
    }
    if(bestOpp < -1e8){
      // no face opposed the sweep (a depenetration push): fall back to the nearest
      var faces2 = [
        [1, 0, 0, Math.abs(contact.x - hit.max.x)], [-1, 0, 0, Math.abs(contact.x - hit.min.x)],
        [0, 1, 0, Math.abs(contact.y - hit.max.y)], [0, -1, 0, Math.abs(contact.y - hit.min.y)],
        [0, 0, 1, Math.abs(contact.z - hit.max.z)], [0, 0, -1, Math.abs(contact.z - hit.min.z)]
      ];
      bd = 1e9;
      for(i = 0; i < faces2.length; i++){
        if(paneHit && faces2[i][1] !== 0) continue;
        if(faces2[i][3] < bd){ bd = faces2[i][3]; nx = faces2[i][0]; ny = faces2[i][1]; nz = faces2[i][2]; }
      }
    }
    if(hit.obb && ny === 0){
      // Plant exactly on the OBB face (plus a hair), keep tangential travel.
      // The AABB-fraction stop walked past rotated corners into the mass.
      var pushed = pushOut(contact.x, contact.y, contact.z);
      // if contact was already on the surface, pushOut is a no-op — nudge out
      if(!inGrown(hit, contact.x, contact.y, contact.z)){
        out.x = contact.x; out.y = contact.y; out.z = contact.z;
      } else {
        out.x = pushed.x; out.y = pushed.y; out.z = pushed.z;
      }
      // slide: keep motion along the face
      var vnO = out.vx*nx + out.vy*ny + out.vz*nz;
      if(vnO < 0){ out.vx -= nx*vnO; out.vy -= ny*vnO; out.vz -= nz*vnO; }
      out.nx = nx; out.ny = ny; out.nz = nz;
      out.wall = 1;
    } else {
      var dn = dxS*nx + dyS*ny + dzS*nz;
      var tx = dxS - nx*dn, ty = dyS - ny*dn, tz = dzS - nz*dn;   // tangential: full
      var nn = dn < 0 ? dn*best + 0.02 : dn;                      // normal: stop short
      out.x = p0.x + tx + nx*nn;
      out.y = p0.y + ty + ny*nn;
      out.z = p0.z + tz + nz*nn;
      out.nx = nx; out.ny = ny; out.nz = nz;
      out.wall = (ny === 0) ? 1 : 0;
      // slide: drop only the velocity that points into the wall
      var vn = out.vx*nx + out.vy*ny + out.vz*nz;
      if(vn < 0){ out.vx -= nx*vn; out.vy -= ny*vn; out.vz -= nz*vn; }
    }
  }
  // Belt-and-braces: if the result is STILL inside a grown box (a multi-box
  // stack, a deep tunnel), keep pushing out. Without this a swing that started
  // already inside a tower stayed planted halfway through the facade.
  var endFree = pushOut(out.x, out.y, out.z);
  if(endFree.x !== out.x || endFree.y !== out.y || endFree.z !== out.z){
    out.x = endFree.x; out.y = endFree.y; out.z = endFree.z;
    if(!out.wall && !out.nx && !out.nz){
      // came from inside with no sweep hit: treat the push as a wall contact
      // so free-fall / swing can start a grip instead of re-entering next frame
      var pdx = endFree.x - (+next.x || 0), pdz = endFree.z - (+next.z || 0);
      if(Math.abs(pdx) >= Math.abs(pdz) && Math.abs(pdx) > 1e-4){
        out.nx = pdx > 0 ? 1 : -1; out.ny = 0; out.nz = 0; out.wall = 1;
      } else if(Math.abs(pdz) > 1e-4){
        out.nx = 0; out.ny = 0; out.nz = pdz > 0 ? 1 : -1; out.wall = 1;
      }
      out.vx = 0; out.vz = 0;
    }
  }
  return out;
}

/* Wall stick: hit a face while swinging or falling and STAY on it.
   - no direction key: CLING and slowly SLIDE DOWN (never freeze mid-air —
     vy=0 forever was "stuck in air beside a building" and killed swinging)
   - a direction key: CRAWL on the wall — W goes UP it, S goes down, A / D
     go sideways (wall-local, not camera-local: the camera may be anywhere)
   - Shift + a direction key: RUN on the wall (the same map, faster)
   - Shift alone (fresh press): soft push off + fire a web (swing off the face)
   - Space: jump AWAY from the building and go back to free fall (then dive
     with W, or press Shift to swing again)
   `nx, nz` is the wall's OUTWARD normal (horizontal). `run` is the Shift flag.
   Pure. */
function wallStep(st, dt, env, nx, nz, run){
  if(!st || !(dt > 0)) return st;
  dt = Math.min(0.05, +dt || 0);
  nx = +nx || 0; nz = +nz || 0;
  var nl = Math.sqrt(nx*nx + nz*nz);
  if(nl < 1e-4){ nx = 0; nz = -1; nl = 1; }
  nx /= nl; nz /= nl;
  var fwd = +((env && env.fwd) || 0), side = +((env && env.side) || 0);
  var hd = env && env.heading != null && isFinite(env.heading) ? +env.heading : (st.yaw || 0);
  var c = Math.cos(hd), s = Math.sin(hd);
  var runMode = !!run;
  // crawl is the default feel; Shift doubles it into a run
  var climb = runMode ? 22 : 13, accel = runMode ? 24 : 13, maxSp = runMode ? 15 : 7;
  // The slam into the wall is spent on contact — carrying it would slide him
  // metres down the face before the grip could win (that is what made a stick
  // look like a fall).
  if(!st.wall && st.vy < -2.2) st.vy = -2.2;
  // WALL-LOCAL WASD. On a face the keys mean the wall, not the camera: W climbs
  // UP the face, S climbs down, A / D crawl along it. The old "into the face
  // becomes up" mapping needed the camera to be pointing AT the wall — a chase
  // cam that had drifted sideways turned W into a sideways crawl and the body
  // just hovered there ("I am just floating near them"). W must always climb.
  var anyKey = Math.abs(fwd) > 0.05 || Math.abs(side) > 0.05;
  if(!anyKey){
    // Cling horizontally, but keep sliding down. A zeroed vy parked the body
    // forever beside a tower (dive silhouette clipped into the facade) and the
    // next Shift never left the wall branch — swinging felt completely broken.
    st.vy -= 2.8*dt;
    if(st.vy < -2.2) st.vy = -2.2;
    if(st.vy > 0) st.vy *= Math.exp(-10*dt);
    st.vx *= Math.exp(-8*dt);
    st.vz *= Math.exp(-8*dt);
  } else if(Math.abs(fwd) > 0.05){
    // W / S: the climb. Gravity bleeds ONLY against an actual climb — a pure
    // sideways crawl used to take the bleed too and slid the body down the face.
    st.vy += fwd*climb*dt;
    st.vy -= (runMode ? 2.6 : 4.2)*dt;
  } else {
    st.vy = 0;                        // A / D alone: hold the height
  }
  // A / D: the camera's left, projected onto the face (so it is always a
  // sideways crawl, never a push into or off the wall)
  var sdx = -c, sdz = s;
  var aN = sdx*nx + sdz*nz;
  sdx -= nx*aN; sdz -= nz*aN;
  var al = Math.sqrt(sdx*sdx + sdz*sdz);
  if(al > 1e-4 && Math.abs(side) > 0.05){
    sdx /= al; sdz /= al;
    st.vx += sdx*side*accel*dt; st.vz += sdz*side*accel*dt;
  }
  // Hold the face WITHOUT fighting the collision. The old suction pushed INTO
  // the face every frame and bodyBlock pushed straight back out — that ~1 cm
  // ping-pong is the "stiff and shaking" bug (the probe saw 26 of 30 frames
  // reverse in x). Instead: never let the body sink into the face (bodyBlock
  // does that), and bleed any speed that is carrying him OFF it. No into-face
  // velocity is ever added, so nothing can oscillate.
  var away = st.vx*nx + st.vz*nz;                 // > 0 = leaving the wall
  if(away < 0){ st.vx -= nx*away; st.vz -= nz*away; }   // never sink in
  else if(away > 0){
    var bleed = Math.min(away, 12.0*dt);          // hold the feet on the face
    st.vx -= nx*bleed; st.vz -= nz*bleed;
  }
  if(st.vy > (runMode ? 13 : 7)) st.vy = runMode ? 13 : 7;
  if(st.vy < -6) st.vy = -6;
  var sp = Math.sqrt(st.vx*st.vx + st.vz*st.vz);
  if(sp > maxSp){ st.vx *= maxSp/sp; st.vz *= maxSp/sp; }
  if(sp > 0.5) st.yaw = Math.atan2(st.vx, st.vz);
  // integrate — the wall grip OWNS the body while it lasts
  st.x += st.vx*dt; st.y += st.vy*dt; st.z += st.vz*dt;
  // DRAW TO THE FACE. A grip that starts from a stand-off (the zip stops 1.25 m
  // short of its anchor; a free fall drifts past at arm's length) used to climb
  // in free space beside the wall — "I am just floating near them". Pull the
  // body onto the surface at a steady rate so the crawl is ON the face.
  // `n` is OUTWARD, so the face lies along -n from the body: pull that way.
  //
  // WHICH face. The grip's normal names a direction, not a box, and the lookup
  // returns every solid that shares a tile — a stepped HQ stacks the wide
  // podium 2 m in front of the storey you actually see, and the park's rides,
  // trees and hangars crowd the same query. Picking the NEAREST face glued the
  // body to the podium 2.4 m out from the storey, parked it under the cornice
  // (bodyBlock stopped the climb at the podium roof), and left `st.wall` set
  // while the body hovered in the falling silhouette beside the glass. The face
  // to hold against is the one this grip can keep climbing: among solids WALL
  // enough to hold a crawl, preference a face that still rises above the body,
  // then the nearest. A flat ride box or a low deck the head is already over is
  // not the wall — the tower rising beside it is.
  if(env && typeof env.solids === "function"){
    var fx = +st.x || 0, fy = (+st.y || 0) + 1.0, fz = +st.z || 0;
    // Chest-to-face: a crawl is plastered on (hands plant), not hovering at the
    // upright walk radius — 0.42 m read as "flying beside the wall".
    var RAD = 0.20;
    // Gap is ALONG the grip's outward normal (holdGap) — never `min(d1..d4)`,
    // which on a wide podium wraps round to the FAR face and pulls the body
    // across the building. Prefer a face that still rises above the head; if
    // only a low mass is in the query (the podium the body is already over) and
    // a rising face is named further away, hold that one out to 3.5 m so the
    // pull carries the body to the face it can actually climb.
    var gap = 1e9, got = false, gapTall = 1e9, tallFace = false;
    var lead = (st.wall && st.wall._lead) || null;
    try {
      var fl = env.solids(fx, fy, fz);
      if(fl && fl.length){
        for(var fi = 0; fi < fl.length; fi++){
          var fb = fl[fi];
          if(!fb || !fb.min || !fb.max) continue;
          if(fy < +fb.min.y - 0.2 || fy > +fb.max.y + 0.2) continue;
          // a real wall mass — not a ride deck, a bench, or a paper-thin pane
          if(!isWallMass(fb)) continue;
          var df = holdGap(fx, fz, fb, {nx: nx, nz: nz});
          if(df < -0.05) continue;                       // behind the face this grip is on
          if(+fb.max.y > fy + 0.6 && df < gapTall){ gapTall = df; tallFace = true; }
          if(df < gap){ gap = df; got = true; }
        }
      }
    } catch(e){ got = false; }
    // Prefer the face that still rises: if the nearest solid tops out at the
    // body (the podium's cornice) and a taller mass stands right behind it, the
    // crawl is on the TALL one — otherwise bodyBlock parks the climb at the low
    // roof and the body floats beside the tower for good.
    if(tallFace) gap = gapTall;
    else if(lead && lead.coord != null){
      var ldf = (nx < -0.5) ? lead.coord - fx : (nx > 0.5) ? fx - lead.coord : (nz < -0.5) ? lead.coord - fz : fz - lead.coord;
      if(ldf > gap){ gap = ldf; got = true; }             // the rising face is further
    }
    // gap is centre-to-face; the body touches at gap = RAD. Close the rest.
    if(got){
      if(gap > RAD + 0.02 && gap < 2.2){
        var pull = Math.min(gap - RAD - 0.02, 10.0*dt);
        st.x -= nx*pull; st.z -= nz*pull;      // -n = toward the face
      }
    }
  }
  if(env && typeof env.solids === "function"){
    var wrPrev2 = {x: st.x - st.vx*dt, y: st.y - st.vy*dt, z: st.z - st.vz*dt};
    // crawl radius matches the plaster pull (0.20) — the default 0.42 walk
    // radius fought the pull every frame and left the body floating off the face
    var wrHit2 = bodyBlock(wrPrev2, {x: st.x, y: st.y, z: st.z, vx: st.vx, vy: st.vy, vz: st.vz},
      sweepBoxes(wrPrev2, st, env.solids), 0.20);
    st.x = wrHit2.x; st.y = wrHit2.y; st.z = wrHit2.z;
    st.vx = wrHit2.vx; st.vy = wrHit2.vy; st.vz = wrHit2.vz;
  }
  // A ledge is a ledge, not a wall to climb into. At a cornice the climb carries
  // the chest past a low roof (a podium, a wing top) while the feet are still under
  // it — this frame the keep-probe still sees a face, the next it does not, and the
  // fall re-grips the band it just left (vy flip-flops, the body parks at the
  // cornice). Mount the ledge instead: chest already over the low roof with the feet
  // within knee-height below it — the moment a real climber steps onto a cornice —
  // and settle the grip on the taller face that now stands in front. One mount per
  // roofline (`_ledgeY`), so a podium seam and the crest above it can both fire.
  if(st.wall && fwd > 0.05){
    var chestL2 = st.y + 1.0;
    var wl2 = null;
    try { wl2 = env.solids(st.x, chestL2, st.z); } catch(e){ wl2 = null; }
    if(wl2 && wl2.length){
      var roofBox2 = null;
      for(var rl2 = 0; rl2 < wl2.length; rl2++){
        var rb2 = wl2[rl2];
        if(!rb2 || !rb2.min || !rb2.max) continue;
        var rt2 = +rb2.max.y || 0, rb2b = +rb2.min.y || 0;
        // Already mounted this roofline? Then it is behind us (the next seam is
        // a different height). The knee window runs from just below the feet —
        // collision can snap the body to the roof top a frame before the climb
        // would have carried the chest over it, and the old `> st.y + 0.10`
        // missed that frame and left the crest flickering.
        if(st._ledgeY != null && Math.abs((+st._ledgeY || 0) - rt2) < 0.5) continue;
        if(rt2 > st.y - 0.05 && rt2 <= chestL2 + 0.25 && (rt2 - rb2b) < 80 &&
           st.x >= +rb2.min.x - 0.6 && st.x <= +rb2.max.x + 0.6 &&
           st.z >= +rb2.min.z - 0.6 && st.z <= +rb2.max.z + 0.6){ roofBox2 = rb2; break; }
      }
      if(roofBox2){
        var rtTop2 = +roofBox2.max.y || 0;
        st.y = rtTop2 + 0.02;
        st.vy = 0;
        st._ledge = true;
        st._ledgeY = rtTop2;            // one mount per roofline
        // Step IN across the ledge: the taller face stands right behind the
        // cornice, and the 1.6 m reach cannot see it from the podium's face
        // (measured: 2.44 m off — out of reach). Carry the body the short step
        // to the rising face the same frame, or the bundle release-fall-regrab
        // starts again one floor up. The step lands OUTSIDE that face, at
        // contact distance along the outward normal — never at the clamped
        // XZ (which is inside the box and is how the body was planted in a
        // tower and then exited the far side).
        var steppedTo = false;
        for(var rl3 = 0; rl3 < wl2.length; rl3++){
          var rb3 = wl2[rl3];
          if(rb3 === roofBox2 || !rb3 || !rb3.min || !rb3.max) continue;
          // a face that still rises, geometry-adjacent, and toward the grip's normal
          if((+rb3.max.y || 0) > st.y + 0.8){
            var pl = facePlaneOf(rb3, {nx: nx, nz: nz});
            if(!pl) continue;
            // the rising box must overlap the body's span on the other axis
            if(pl.axis === 0){
              if(st.z < +rb3.min.z - 0.6 || st.z > +rb3.max.z + 0.6) continue;
            } else {
              if(st.x < +rb3.min.x - 0.6 || st.x > +rb3.max.x + 0.6) continue;
            }
            // contact lies OUTSIDE the face the grip names: face + n*RAD
            // (west face n=-1 -> min.x - 0.20). Match the crawl plaster distance.
            if(pl.axis === 0) st.x = pl.coord + nx*0.20;
            else st.z = pl.coord + nz*0.20;
            steppedTo = true;
            break;
          }
        }
        if(!steppedTo){
          // Topped out: there is no taller face in front. Step ONTO the roof
          // (inward, against the outward normal) and let the walk own the body —
          // that is the crest of a climb, not a wall to keep clinging to. Without
          // this the leave-probe at chest height looks above the roof, drops the
          // grip, and the key held into the face re-grabs it every cooldown
          // (measured: 176 mode flips in 240 frames).
          st.x -= nx*0.55; st.z -= nz*0.55;
          st.vx = 0; st.vz = 0; st.vy = 0;
          st.wall = null;
          st.gripT = 0.45;
          st.coastT = 0;
          st.webFrom = null; st.webTo = null;
          return st;
        }
        st.gripT = Math.max(+st.gripT || 0, 0.06);
      }
    }
  }
  if(!st.wall){
    st.wall = {nx: nx, nz: nz, t: 0, run: runMode ? 1 : 0};
    st._ledge = false;                  // each new grip may mount ledges
    st._ledgeY = null;
  }
  // Face the WALL: yaw straight into its inward normal so "W climbs up" reads
  // on the body too (this also snaps a drifting chase camera behind you). The
  // old code kept the walk's heading, so a body facing along the face never
  // turned and W stayed a sideways crawl — the grip "never started".
  st.yaw = Math.atan2(-nx, -nz);
  // keep the grip's normal on the face the BODY is actually on (a slide round a
  // corner meets a new face; a stale normal sends the "leave the wall" probe the
  // wrong way and the grip drops mid-run)
  if(env && typeof env.solids === "function"){
    var gn = faceNormalAt(st, env, nx, nz);
    if(gn){ st.wall.nx = gn.nx; st.wall.nz = gn.nz; if(gn._lead) st.wall._lead = gn._lead; }
    else { st.wall.nx = nx; st.wall.nz = nz; }
  } else {
    st.wall.nx = nx; st.wall.nz = nz;
  }
  st.wall.t = (st.wall.t || 0) + dt;
  st.wall.run = runMode ? 1 : 0;
  st.wall.move = anyKey ? 1 : 0;
  return st;
}

/* Gap from the body centre to the face of `b` this grip is on, measured along
   the OUTWARD normal `n`. Negative means the centre is already inside the face
   (or behind a stepped mass). The face is whichever side `n` names — never
   `min(d1..d4)`, which on a wide podium wraps round to the FAR face and pulls
   the body across the building ("through the building"). Pure — node-tested. */
/* A paper-thin facade pane: tall, and only centimetres deep. Window decorations
   in the solid list pass a height check, steal the grip / leave-probe, and —
   worse — park a climb at their bottom edge (~4 m up a tower) so the body never
   reaches the cornice. Real buildings and floor slabs are NOT this. */
function isPaperPane(b){
  if(!b || !b.min || !b.max) return false;
  var dx = (+b.max.x || 0) - (+b.min.x || 0);
  var dy = (+b.max.y || 0) - (+b.min.y || 0);
  var dz = (+b.max.z || 0) - (+b.min.z || 0);
  return dy >= 1.0 && Math.min(dx, dz) < 0.35;
}
/* A crawlable WALL mass, not a paper-thin facade pane and not a flat deck.
   Window decorations used to steal the grip / leave-probe, which is how a dive
   into a tower flickered wall↔fall and never stuck. Require real thickness. */
function isWallMass(b){
  if(!b || !b.min || !b.max) return false;
  var dx = (+b.max.x || 0) - (+b.min.x || 0);
  var dy = (+b.max.y || 0) - (+b.min.y || 0);
  var dz = (+b.max.z || 0) - (+b.min.z || 0);
  if(dy < 1.3) return false;                       // a deck / bench / car roof
  if(Math.min(dx, dz) < 0.35) return false;        // a facade pane
  return true;
}
/* Is the body resting on a solid top the city's groundY does not know about —
   a tower roof, a podium cornice, a hangar crown? `bodyBlock` already keeps the
   feet on it; without this check airFrame still calls the body "flying", so the
   pose stays the dive silhouette and the hero hovers on the roof in the fall
   shape ("still floating in air, when climbing building"). Pure. */
function roofRest(st, env){
  if(!st || !env || typeof env.solids !== "function") return false;
  if((+st.vy || 0) > 0.35) return false;          // still rising
  var px = +st.x || 0, pz = +st.z || 0, py = +st.y || 0;
  try {
    var lb = env.solids(px, py + 0.35, pz);
    if(!lb || !lb.length) return false;
    for(var i = 0; i < lb.length; i++){
      var b = lb[i];
      if(!b || !b.min || !b.max) continue;
      if(px < +b.min.x - 0.35 || px > +b.max.x + 0.35) continue;
      if(pz < +b.min.z - 0.35 || pz > +b.max.z + 0.35) continue;
      var top = +b.max.y || 0;
      if(py >= top - 0.12 && py <= top + 0.30) return true;
    }
  } catch(e){}
  return false;
}

function holdGap(px, pz, b, n){
  if(!b || !b.min || !b.max) return 1e9;
  var nx = +n.nx || 0, nz = +n.nz || 0;
  if(nx < -0.5) return (+b.min.x) - px;
  if(nx > 0.5) return px - (+b.max.x);
  if(nz < -0.5) return (+b.min.z) - pz;
  if(nz > 0.5) return pz - (+b.max.z);
  return Math.min((+b.min.x) - px, px - (+b.max.x), (+b.min.z) - pz, pz - (+b.max.z));
}

/* The face of `b` the OUTWARD normal `n` names: {nx,nz,coord} — coord is the
   plane of that face (min.x / max.x / min.z / max.z). Pure. */
function facePlaneOf(b, n){
  if(!b || !b.min || !b.max) return null;
  var nx = +n.nx || 0, nz = +n.nz || 0;
  if(nx < -0.5) return {nx: -1, nz: 0, coord: +b.min.x, axis: 0};
  if(nx > 0.5) return {nx: 1, nz: 0, coord: +b.max.x, axis: 0};
  if(nz < -0.5) return {nx: 0, nz: -1, coord: +b.min.z, axis: 1};
  if(nz > 0.5) return {nx: 0, nz: 1, coord: +b.max.z, axis: 1};
  return null;
}

/* Which face of the nearby solids is the body pressed against?
   Returns the OUTWARD unit normal {nx, nz} of that face (pointing away from the
   wall), or null when nothing is in reach. Pure — node-tested. Used to start a
   grip from the ground (the walk stopped at `blocked`) and to keep the grip's
   normal honest while sliding. `hintX/hintZ` prefer the face we are already on.
   Also returns `_lead`: the widest rising face in the query (the tower face the
   crawl must climb), so the hold / pull never settles on a low near panel. */
function faceNormalAt(st, env, hintX, hintZ, reach){
  if(!st || !env || typeof env.solids !== "function") return null;
  reach = (reach == null ? 0.85 : Math.max(0.2, +reach || 0.85));
  var px = +st.x || 0, py = (+st.y || 0) + 1.0, pz = +st.z || 0;
  var list = null;
  try { list = env.solids(px, py, pz); } catch(e){ list = null; }
  if(!list || !list.length) return null;
  var best = null, bestD = 1e9;
  var bestTall = null, bestTallD = 1e9;
  // the lead face: among faces this grip names, prefer the one still rising
  // (widest, highest) even if it is too far to reach from here. wallStep uses
  // it so the hold settles on the TOWER face, not a near low panel.
  var lead = null, leadScore = -1e9;
  for(var i = 0; i < list.length; i++){
    var b = list[i];
    if(!b || !b.min || !b.max) continue;
    if(!isWallMass(b)) continue;                                         // no panes / decks
    if((+st.y || 0) + 1.8 < +b.min.y || (+st.y || 0) > +b.max.y) continue;   // no vertical overlap
    // a crawl wants a face that still rises above the head; a face it will top
    // out on next step (a podium, a wing roof) is a step, not the wall. Track
    // both: the tall face wins the grab when it is in reach, the nearest is the
    // fallback for the step the body is genuinely hugging.
    var rises = (+b.max.y || 0) > (+st.y || 0) + 1.0;
    var faces = [
      {nx: -1, nz: 0, d: Math.abs(px - +b.min.x), inside: pz > +b.min.z - 0.5 && pz < +b.max.z + 0.5 && px <= +b.min.x},
      {nx: 1, nz: 0, d: Math.abs(px - +b.max.x), inside: pz > +b.min.z - 0.5 && pz < +b.max.z + 0.5 && px >= +b.max.x},
      {nx: 0, nz: -1, d: Math.abs(pz - +b.min.z), inside: px > +b.min.x - 0.5 && px < +b.max.x + 0.5 && pz <= +b.min.z},
      {nx: 0, nz: 1, d: Math.abs(pz - +b.max.z), inside: px > +b.min.x - 0.5 && px < +b.max.x + 0.5 && pz >= +b.max.z}
    ];
    for(var j = 0; j < faces.length; j++){
      var f = faces[j];
      if(!f.inside) continue;
      // lead face: the widest rising face WITHIN REACH. Returning a lead that
      // is 6 m away made nearFaceGrip latch mid-air, the leave-probe drop it
      // the next frame, and the dive flicker wall↔fall forever ("can't crawl /
      // glitchy / going through buildings").
      if(rises && f.d <= reach + 0.05){
        var wide = Math.abs((+b.max.x) - (+b.min.x)) + Math.abs((+b.max.z) - (+b.min.z)) - f.d*0.01;
        if(wide > leadScore){ leadScore = wide; lead = {nx: f.nx, nz: f.nz, coord: f.nx < 0 ? +b.min.x : (f.nx > 0 ? +b.max.x : (f.nz < 0 ? +b.min.z : +b.max.z))}; }
      }
      if(f.d > reach) continue;
      // prefer the face we already know we are on
      var score = f.d;
      if(hintX != null && hintZ != null && (Math.abs(f.nx - hintX) < 0.1 && Math.abs(f.nz - hintZ) < 0.1)) score -= 0.5;
      if(score < bestD){ bestD = score; best = {nx: f.nx, nz: f.nz}; }
      if(rises && score < bestTallD){ bestTallD = score; bestTall = {nx: f.nx, nz: f.nz}; }
    }
  }
  // a rising face within the grip's own reach immediately beats a low nearer one
  var outN = (bestTall && (!best || bestTallD <= bestD + 1.6)) ? bestTall : best;
  // NEVER return a lead alone when no face is in reach — that is the mid-air
  // latch. Attach it only as a hint on a real in-reach grip.
  if(outN && lead) outN._lead = lead;
  return outN;
}

/* Force a wall grip ONLY when the body is ALREADY intersecting a tower mass,
   or flying hard INTO a face. Merely being near / at contact distance must NOT
   latch — that was "when i come near any building i start floating": every
   hop or fall beside a facade clung and slid forever. Keys-into-face is
   nearFaceGrip's job; a collision hit with intent is fallHit's. Pure. */
function contactFaceGrip(st, env, reach){
  if(!st || !env || typeof env.solids !== "function") return null;
  if((+st.gripT || 0) > 0) return null;
  // `reach` kept for callers; this path is inside-the-mass only now
  var px = +st.x || 0, py = (+st.y || 0) + 1.0, pz = +st.z || 0;
  var list = null;
  try { list = env.solids(px, py, pz); } catch(e){ list = null; }
  if(!list || !list.length) return null;
  var bestInside = null, bestInsideD = 1e9;
  var i, b, faces, fi, fd;
  for(i = 0; i < list.length; i++){
    b = list[i];
    if(!isWallMass(b)) continue;
    if(py < +b.min.y - 0.2 || py > +b.max.y + 0.2) continue;
    // centre INSIDE the mass: pick the nearest side face and push out that way
    if(px >= +b.min.x && px <= +b.max.x && pz >= +b.min.z && pz <= +b.max.z &&
       py >= +b.min.y && py <= +b.max.y){
      faces = [
        [-1, 0, px - (+b.min.x)], [1, 0, (+b.max.x) - px],
        [0, -1, pz - (+b.min.z)], [0, 1, (+b.max.z) - pz]
      ];
      for(fi = 0; fi < faces.length; fi++){
        fd = faces[fi][2];
        if(fd < bestInsideD){
          bestInsideD = fd;
          bestInside = {nx: faces[fi][0], nz: faces[fi][1], _inside: 1};
        }
      }
    }
  }
  if(!bestInside) return null;           // outside: never auto-grab (nearFaceGrip / fallHit own that)
  // plant just outside the mass along the outward normal
  var RAD = 0.44;
  for(i = 0; i < list.length; i++){
    b = list[i];
    if(!isWallMass(b)) continue;
    if(!(px >= +b.min.x && px <= +b.max.x && pz >= +b.min.z && pz <= +b.max.z &&
         py >= +b.min.y && py <= +b.max.y)) continue;
    if(bestInside.nx < 0) st.x = Math.min(+st.x || px, (+b.min.x) - RAD);
    else if(bestInside.nx > 0) st.x = Math.max(+st.x || px, (+b.max.x) + RAD);
    else if(bestInside.nz < 0) st.z = Math.min(+st.z || pz, (+b.min.z) - RAD);
    else if(bestInside.nz > 0) st.z = Math.max(+st.z || pz, (+b.max.z) + RAD);
  }
  st.vx = 0; st.vz = 0;
  return bestInside;
}

/* Is the body NEAR a face, with a direction key held? Then grab it — this is
   the free-fall handoff ("I am just floating near them"). Unlike wallFromInput
   this does NOT need the keys to push INTO the face: beside a wall, any key
   crawls it (W up, A / D along), which is what the player is trying to do.
   Keys that clearly leave the face are ignored so a fall past a tower does not
   snap onto it. `reach` must cover a web zip's 1.25 m stand-off. */
function nearFaceGrip(st, env, reach){
  if(!st || !env) return null;
  if((+st.gripT || 0) > 0) return null;          // just jumped away: do not re-grab
  var fwd = +env.fwd || 0, side = +env.side || 0;
  if(Math.abs(fwd) < 0.05 && Math.abs(side) < 0.05) return null;
  var R = reach == null ? 1.6 : reach;
  var n = faceNormalAt(st, env, null, null, R);
  if(!n) return null;
  var hd = env.heading != null && isFinite(env.heading) ? +env.heading : (+st.yaw || 0);
  var c = Math.cos(hd), s = Math.sin(hd);
  var dirX = s*fwd - c*side, dirZ = c*fwd + s*side;
  var dl = Math.sqrt(dirX*dirX + dirZ*dirZ) || 1;
  dirX /= dl; dirZ /= dl;
  // the keys must push INTO the face — walking past a wall must not snap onto it
  var into = -(dirX*n.nx + dirZ*n.nz);
  if(into < 0.12) return null;
  // belt-and-braces: the face must actually be within reach along its normal
  if(typeof env.solids === "function"){
    try {
      var lb = env.solids(+st.x || 0, (+st.y || 0) + 1.0, +st.z || 0);
      var nearest = 1e9, found = false;
      if(lb && lb.length){
        for(var i = 0; i < lb.length; i++){
          var b = lb[i];
          if(!isWallMass(b)) continue;
          var g = holdGap(+st.x || 0, +st.z || 0, b, n);
          if(g < -0.05) continue;
          if(g < nearest){ nearest = g; found = true; }
        }
      }
      if(!found || nearest > R + 0.05) return null;
    } catch(e){ return null; }
  }
  return n;
}

/* Is the body running INTO a solid face right now? If so, the outward normal of
   that face — this is how the walk's "a wall stops you" hands off to the grip.
   `reach` widens the face probe: a web zip stops 1.25 m short of its anchor, so
   the default 0.85 m cannot see the wall it just came to rest beside ("floating
   near them"). The ahead probe uses `env.solids` as well as `env.blocked`, because
   hq3d's air `blocked` is false above the surface — in the sky the only thing
   that knows a wall is there is the solid list. */
function wallFromInput(st, env, reach){
  if(!st || !env) return null;
  var fwd = +env.fwd || 0, side = +env.side || 0;
  if(Math.abs(fwd) < 0.05 && Math.abs(side) < 0.05) return null;
  var hd = env.heading != null && isFinite(env.heading) ? +env.heading : (+st.yaw || 0);
  var c = Math.cos(hd), s = Math.sin(hd);
  var dirX = s*fwd - c*side, dirZ = c*fwd + s*side;
  var dl = Math.sqrt(dirX*dirX + dirZ*dirZ);
  if(dl < 1e-4) return null;
  dirX /= dl; dirZ /= dl;
  // is there a solid just ahead of the feet? (blocked first, then the solid list
  // — in the sky `blocked` is off, so the list is the only witness)
  var aheadX = (+st.x || 0) + dirX*0.7, aheadZ = (+st.z || 0) + dirZ*0.7;
  var pressed = false;
  if(typeof env.blocked === "function"){
    try { pressed = !!env.blocked(aheadX, aheadZ); } catch(e){ pressed = false; }
  }
  if(!pressed && typeof env.solids === "function"){
    try {
      var ah = env.solids(aheadX, (+st.y || 0) + 1.0, aheadZ);
      if(ah && ah.length){
        for(var ai = 0; ai < ah.length; ai++){
          var ab = ah[ai];
          if(!ab || !ab.min || !ab.max) continue;
          if(aheadX >= +ab.min.x && aheadX <= +ab.max.x &&
             (+st.y || 0) + 1.0 >= +ab.min.y && (+st.y || 0) + 1.0 <= +ab.max.y &&
             aheadZ >= +ab.min.z && aheadZ <= +ab.max.z){ pressed = true; break; }
        }
      }
    } catch(e){ pressed = false; }
  }
  var n = faceNormalAt(st, env, null, null, reach);
  if(!n) return null;
  // the face must be one we are pushing INTO (its outward normal opposes our move)
  var into = -(dirX*n.nx + dirZ*n.nz);
  if(into < 0.15 && !pressed) return null;
  if(into < 0.05) return null;
  return n;
}

/* The air state machine: web zip, double jump, dive, swing, free fall, coast.
   `st` is the hero's air state (kept by the caller); `env` is the world.
   Returns {mode, fire, release} and writes st + the web endpoints.
   mode: "ground" | "fall" | "swing" | "zip"

   RELEASE COAST: letting go of the web keeps the velocity and flies STRAIGHT
   along it. Steering and the camera-heading snap are locked out for a few
   seconds so the fall cannot bend back toward the building the line was on —
   turning is something you do by starting ANOTHER swing with Shift. */
function airFrame(st, env, dt){
  if(!st || !env) return {mode: "ground", fire: false, release: false};
  dt = dt > 0 ? Math.min(0.05, +dt) : 0;
  var calm = !!env.calm;
  var g = 18;
  st.t = (st.t || 0) + dt;
  if((+st.gripT || 0) > 0) st.gripT = Math.max(0, (+st.gripT || 0) - dt);
  st.x = +st.x || 0; st.y = +st.y || 0; st.z = +st.z || 0;
  st.vx = +st.vx || 0; st.vy = +st.vy || 0; st.vz = +st.vz || 0;
  st.jumps = st.jumps | 0;
  st.webSide = st.webSide < 0 ? -1 : 1;
  // fall clock: how long he has been actually DESCENDING. A jump's rise and a
  // brief hang keep it at 0 (the body stays a jump); a real fall ramps it to 1
  // and only then does airPose tip into the glide. launch / stretch must never
  // drive that shape — that is what made every ordinary hop look like a dive.
  st.fallT = Math.max(0, Math.min(1, (+st.fallT || 0) + ((+st.vy || 0) < -1.2 ? dt : -2.4*dt)));
  var fire = false, release = false;
  var spaceEdge = !!env.space && !st.spaceWas;
  st.spaceWas = !!env.space;
  var shiftEdge = !!env.shift && !st.shiftWas;
  st.shiftWas = !!env.shift;
  var gy = typeof env.groundY === "function" ? (+env.groundY(st.x, st.z) || 0) : 0;
  st.launch = launchBlend(st, dt);

  // ---- a zip already in flight owns the body ----
  if(st.zip){
    var solids = (env && typeof env.solids === "function") ? env.solids : null;
    var running = zipStep(st, dt, solids);
    if(running){
      st.dive = diveBlend(st, false, dt);
      return {mode: "zip", fire: false, release: false};
    }
    // arrived: fall through into free fall so the next frame can chain a swing
  }

  // ---- a wall grip already in progress owns the body ----
  if(st.wall && st.wall.t > 0){
    if(spaceEdge && !calm){
      // Space jumps AWAY from the building and goes back to free fall — from
      // there you dive with W or swing again with Shift. (No zip: the press
      // must put him back in the air, not pull him back onto the wall.)
      jumpAwayFrom(st, st.wall, dt);
      st.dive = 0;
      return {mode: "fall", fire: false, release: false};
    }
    // Shift EDGE on a wall: soft push off and fire a web. Holding Shift alone
    // must NOT re-aim (that auto-connected to the nearest neighbour). A FRESH
    // press is deliberate — without it a stuck cling could never swing again
    // because the wall branch ate every Shift and never reached the fire path.
    if(shiftEdge && !calm && env.anchor){
      var wnxS = +st.wall.nx || 0, wnzS = +st.wall.nz || 0;
      st.wall = null;
      st.gripT = 0.10;
      st.x += wnxS*0.55; st.z += wnzS*0.55;
      st.vx = wnxS*5.2 + Math.sin(st.yaw || 0)*1.2;
      st.vz = wnzS*5.2 + Math.cos(st.yaw || 0)*1.2;
      st.vy = Math.max(+st.vy || 0, 3.2);
      st.dive = 0;
      st.webFrom = null; st.webTo = null;
      var fromS = handOf(st), aimsS = webAims(st.yaw || 0), gotS = null;
      for(var aiS = 0; aiS < aimsS.length && !gotS; aiS++){
        try { gotS = env.anchor(fromS, aimsS[aiS], 42); } catch(eS){ gotS = null; }
      }
      if(gotS){
        var Lsw = Math.sqrt((gotS.x - fromS.x)*(gotS.x - fromS.x) +
          (gotS.y - fromS.y)*(gotS.y - fromS.y) + (gotS.z - fromS.z)*(gotS.z - fromS.z));
        Lsw = Lsw > 2 ? Lsw : 3.5;
        st.sw = {
          ax: +gotS.x || 0, ay: +gotS.y || 0, az: +gotS.z || 0, len: Lsw,
          x: st.x, y: st.y, z: st.z,
          vx: st.vx, vy: st.vy, vz: st.vz,
          yaw: st.yaw || 0, t: 0
        };
        st.webFrom = {x: fromS.x, y: fromS.y, z: fromS.z};
        st.webTo = {x: st.sw.ax, y: st.sw.ay, z: st.sw.az};
        st.webArm = st.webSide;
        st.coastT = 0;
        st.jumps = Math.max(1, st.jumps | 0);
        return {mode: "swing", fire: true, release: false};
      }
      return {mode: "fall", fire: false, release: false};
    }
    // Hold the grip: direction = CRAWL, Shift + direction = RUN, no keys = slide
    var anyDirW = Math.abs(+env.fwd || 0) > 0.05 || Math.abs(+env.side || 0) > 0.05;
    var wnx0 = +st.wall.nx || 0, wnz0 = +st.wall.nz || 0;
    wallStep(st, dt, env, wnx0, wnz0, !!env.shift && anyDirW);
    // topped out onto a roof: wallStep already walked him onto the deck and
    // dropped the grip. The walk owns the body again — do not re-enter the
    // leave-probe (st.wall is gone) or the crest flickers. A body standing on
    // that roof is GROUND, not a fall: return "ground" so hq3d clears the dive
    // pose this frame instead of the next.
    if(!st.wall){
      st.dive = diveBlend(st, false, dt);
      var topped = false;
      if(typeof env.solids === "function"){
        try {
          var tb = env.solids(st.x, st.y + 0.35, st.z);
          if(tb && tb.length){
            for(var ti = 0; ti < tb.length; ti++){
              var tbb = tb[ti];
              if(!tbb || !tbb.min || !tbb.max) continue;
              if(st.x < +tbb.min.x - 0.35 || st.x > +tbb.max.x + 0.35) continue;
              if(st.z < +tbb.min.z - 0.35 || st.z > +tbb.max.z + 0.35) continue;
              var tt = +tbb.max.y || 0;
              if(st.y >= tt - 0.12 && st.y <= tt + 0.30 && st.vy <= 0.35){ topped = true; break; }
            }
          }
        } catch(e){}
      }
      return {mode: topped ? "ground" : "fall", fire: false, release: false};
    }
    // did he leave the face? The old probe walked only 0.12/0.28/0.44 m into
    // the wall, so a grip that started at the zip's 1.25 m stand-off — or one
    // still pulling onto the face — never found the surface and dropped the
    // same frame it started ("still floating in air"). Measure the gap along
    // the grip's outward normal instead: on the face (gap <= RAD+hold), still
    // reaching it (gap <= 3.5), or inside it (gap < 0) keeps the grip; only a
    // body genuinely OFF the side lets go.
    var left = true, probed = false;
    if(typeof env.solids === "function"){
      var lnx = +st.wall.nx || 0, lnz = +st.wall.nz || 0;
      var lgap = 1e9, lgot = false;
      try {
        var lb = env.solids(st.x, st.y + 1.0, st.z);
        if(lb && lb.length){
          probed = true;
          for(var li = 0; li < lb.length; li++){
            var lb0 = lb[li];
            if(!lb0 || !lb0.min || !lb0.max) continue;
            if(st.y + 1.0 < +lb0.min.y - 0.2 || st.y + 1.0 > +lb0.max.y + 0.2) continue;
            if(!isWallMass(lb0)) continue;
            var ldf = holdGap(st.x, st.z, lb0, {nx: lnx, nz: lnz});
            if(ldf < -0.05) continue;
            if(ldf < lgap){ lgap = ldf; lgot = true; }
          }
        }
      } catch(e){ lgot = false; }
      // no probe could run: KEEP the grip. Dropping it on a lookup failure is how
      // a grip flickers off and the body falls out of a run it never left.
      // 2.2 m: covers the zip's 1.25 m stand-off and the pull-in, short of the
      // 2.44 m yank that must let go ("flying along the wall").
      if(!probed) left = false;
      else if(lgot && lgap < 2.2) left = false;
    }
    if(left){
      // leaving the face for real: drop the grip AND arm the jump-away cooldown,
      // or the free-fall proximity grab (below) re-attaches the very same frame
      // and the wall never lets go — the "comes back through the building" loop.
      st.wall = null;
      st.gripT = Math.max(+st.gripT || 0, 0.32);
      st.fallT = Math.max(0, Math.min(1, (+st.fallT || 0) + dt));
    } else {
      st.dive = 0;                       // wall pose owns the body — no residual dive clip
      st.tuck = 0.25;
      st.webFrom = null; st.webTo = null;
      return {mode: "wall", fire: false, release: false};
    }
  }

  // ---- swing: an existing line takes priority ----
  if(st.sw){
    if(!env.shift){
      // LET GO. Keep the velocity and COAST — a straight line along the release,
      // not a drift back toward the old anchor. Turning comes from a new swing.
      st.sw = null; release = true;
      st.webFrom = null; st.webTo = null;
      st.coastT = 3.0;
      var spRel = Math.sqrt(st.vx*st.vx + st.vz*st.vz);
      if(spRel > 0.4) st.yaw = Math.atan2(st.vx, st.vz);
    } else {
      var fwd = +env.fwd || 0, side = +env.side || 0;
      var solidsS = (env && typeof env.solids === "function") ? env.solids : null;
      // the rope clamp must never snap the body THROUGH a tower: tell swingStep
      // what is solid so it slackens the rope instead of yanking him through
      if(st.sw && solidsS){
        st.sw._blocked = function(bx, by, bz){
          try {
            var bb = solidsS(bx, by, bz);
            if(!bb || !bb.length) return false;
            for(var bi = 0; bi < bb.length; bi++){
              var b0 = bb[bi];
              if(!b0 || !b0.min || !b0.max) continue;
              // paper panes must not foul the rope (they are decoration); real
              // wall mass and decks still stop a yank through a tower
              if(isPaperPane(b0)) continue;
              if(bx >= +b0.min.x && bx <= +b0.max.x && by >= +b0.min.y && by <= +b0.max.y && bz >= +b0.min.z && bz <= +b0.max.z) return true;
            }
          } catch(e){}
          return false;
        };
      }
      var swPrev = {x: st.sw.x, y: st.sw.y, z: st.sw.z};
      swingStep(st.sw, dt, {fwd: fwd, side: side});
      // a rope fouled against geometry is released: fall, do not hang frozen
      if(st.sw && st.sw.dead){
        st.sw = null; release = true;
        st.webFrom = null; st.webTo = null;
        st.coastT = 0.6;
        st.fallT = Math.max(0, Math.min(1, (+st.fallT || 0) + dt));
        st.dive = diveBlend(st, wantDive(!!env.w, st.y - gy, st.vy), dt);
        return {mode: "fall", fire: false, release: release};
      }
      // all construction is opaque — a swing never passes through a tower
      var swHit = null;
      if(solidsS){
        swHit = bodyBlock(swPrev, {x: st.sw.x, y: st.sw.y, z: st.sw.z,
          vx: st.sw.vx, vy: st.sw.vy, vz: st.sw.vz}, sweepBoxes(swPrev, st.sw, solidsS));
        st.sw.x = swHit.x; st.sw.y = swHit.y; st.sw.z = swHit.z;
        st.sw.vx = swHit.vx; st.sw.vy = swHit.vy; st.sw.vz = swHit.vz;
        // the collision stopped him: slacken the rope so the next frame cannot
        // yank him back through the wall toward the anchor
        if(swHit && (swHit.nx || swHit.ny || swHit.nz)){
          var dnow = Math.sqrt((st.sw.x - st.sw.ax)*(st.sw.x - st.sw.ax) +
            (st.sw.y - st.sw.ay)*(st.sw.y - st.sw.ay) + (st.sw.z - st.sw.az)*(st.sw.z - st.sw.az));
          if(dnow > 0.5 && dnow < st.sw.len) st.sw.len = dnow;
        }
      }
      st.x = st.sw.x; st.y = st.sw.y; st.z = st.sw.z;
      st.vx = st.sw.vx; st.vy = st.sw.vy; st.vz = st.sw.vz;
      // STALLED? The BODY (AFTER collision) has covered no ground: the swing
      // step can move the rope-end into a wall and bodyBlock push it straight
      // back, so measuring travel BEFORE the collision sees motion the player
      // never gets. "Stuck in air while swinging" is the body not going
      // anywhere — release the line rather than hang there. A slow pendulum
      // drifts well past this window and is never dropped.
      if(st.sw){
        var bx = +st.x || 0, by = +st.y || 0, bz = +st.z || 0;
        if(st.sw._sx == null){ st.sw._sx = bx; st.sw._sy = by; st.sw._sz = bz; st.sw._stall = 0; }
        var stuckD = Math.sqrt((bx - st.sw._sx)*(bx - st.sw._sx) +
                               (by - st.sw._sy)*(by - st.sw._sy) +
                               (bz - st.sw._sz)*(bz - st.sw._sz));
        if(stuckD < 0.12){
          st.sw._stall = (+st.sw._stall || 0) + dt;
          if(st.sw._stall > 0.45){
            st.sw = null; release = true;
            st.webFrom = null; st.webTo = null;
            st.coastT = 0;
            st.fallT = Math.max(0, Math.min(1, (+st.fallT || 0) + dt));
            // stall against a face: DROP into free fall. Do NOT start a crawl —
            // crawling is ground-only (walk into a building). Mid-swing contact
            // used to cling and break the swing ("you cant even fix it").
            st.dive = diveBlend(st, wantDive(!!env.w, st.y - gy, st.vy), dt);
            return {mode: "fall", fire: false, release: release};
          }
        } else {
          st.sw._stall = 0;
          st.sw._sx = bx; st.sw._sy = by; st.sw._sz = bz;
        }
      }
      var sp0 = Math.sqrt(st.vx*st.vx + st.vz*st.vz);
      if(sp0 > 0.5) st.yaw = Math.atan2(st.vx, st.vz) + (side || 0)*0.25;
      st.tuck = Math.max(0, Math.min(1, (sp0 - 2)/10));
      st.webSide = side < -0.15 ? -1 : (side > 0.15 ? 1 : st.webSide);
      st.webArm = st.webSide;
      st.webFrom = handOf(st);          // the RAISED hand, not a point beside the chest
      st.webTo = {x: st.sw.ax, y: st.sw.ay, z: st.sw.az};
      // Hit a face while swinging: bodyBlock already stopped the inward move and
      // slackened the rope. Do NOT start a wall crawl — keep swinging. Crawl is
      // only from the ground (walk into a building).
      // Space mid-swing: a WEB ZIP off the arc if something is in front (the
      // chain), otherwise the old let-go-and-kick.
      if(spaceEdge && !calm){
        var zhS = zipHit(st, env);
        if(zhS){
          st.sw = null; release = true;
          st.webFrom = null; st.webTo = null;
          startZip(st, zhS);
          return {mode: "zip", fire: true, release: release};
        }
        st.sw = null; release = true;
        st.vy += 5.4;
        st.vx += Math.sin(st.yaw || 0)*3.2;
        st.vz += Math.cos(st.yaw || 0)*3.2;
        st.webFrom = null; st.webTo = null;
        st.jumps = 1;
        st.dive = diveBlend(st, wantDive(!!env.w, st.y - gy, st.vy), dt);
        return {mode: "fall", fire: false, release: release};
      }
      st.dive = diveBlend(st, false, dt);
      return {mode: "swing", fire: false, release: release};
    }
  }

  // ---- on the ground: a single jump, or stand ----
  // A tower roof is ground too. `gy` is the city's street/deck level — a body
  // standing on a cornice at y=34 is never `st.y <= gy`, so the old check left
  // it "flying" in the dive silhouette on the crest ("still floating in air,
  // when climbing building"). `roofRest` finds the solid top the city's
  // groundY does not know about; when it is true, stand on THAT top and never
  // snap the feet down to the street.
  var restTop = null;
  if(st.y > gy + 0.06 && (typeof env.solids === "function")){
    try {
      var rlb = env.solids(st.x, st.y + 0.35, st.z);
      if(rlb && rlb.length){
        for(var ri = 0; ri < rlb.length; ri++){
          var rb = rlb[ri];
          if(!rb || !rb.min || !rb.max) continue;
          if(st.x < +rb.min.x - 0.35 || st.x > +rb.max.x + 0.35) continue;
          if(st.z < +rb.min.z - 0.35 || st.z > +rb.max.z + 0.35) continue;
          var rtop = +rb.max.y || 0;
          if(st.y >= rtop - 0.12 && st.y <= rtop + 0.30 && st.vy <= 0.35){ restTop = rtop; break; }
        }
      }
    } catch(e){ restTop = null; }
  }
  var onGround = (st.y <= gy + 0.06 || restTop != null) && st.vy <= 0.01;
  if(onGround){
    // Street: snap to it. Roof: stay on the roof's top — never pull a body
    // down to the street the city's groundY reports under a tower.
    if(restTop == null || st.y <= gy + 0.06) st.y = gy;
    else st.y = restTop + 0.02;
    st.vy = 0;
    st.vx *= Math.exp(-6*dt); st.vz *= Math.exp(-6*dt);
    st.jumps = 0; st.spinV = 0; st.spin = 0;
    st.coastT = 0;                     // the ground ends the coast
    st.zip = null;
    st.fallT = 0;                      // the ground is not a fall
    st.dive = diveBlend(st, false, dt);
    st.webFrom = null; st.webTo = null;
    var j0 = jumpImpulse(st, true, spaceEdge, calm);
    if(j0 > 0){
      st.vy = j0; st.y += 0.02; onGround = false;
      jumpKick(st, st.yaw, 3.6);       // a launch, not a hop on the roof
      spaceEdge = false;               // the ground jump ate this press
    }
  }
  // RUN INTO A BUILDING ON THE GROUND AND YOU GRAB IT. The walk's `blocked()`
  // stops the feet at a wall — that is not a grip. When the keys push INTO a
  // face and the hero is still on the ground, start the wall grip here: a
  // direction key crawls, Shift + direction runs. AFTER the jump check: Space
  // must always leave the ground, never start a grip ("sometime jump doesn't
  // even work, to jump away from building").
  if(onGround && !calm){
    // The WALK's keys are BODY-relative (chase: W walks along your facing), but
    // env.heading is the CAMERA's. A camera that has drifted sideways makes W
    // mean "along the wall" instead of "into it", and the grip never starts —
    // the hero just stands there stiff beside the building. On the ground the
    // grip must use the body's own facing, which is the direction you walked in.
    var gEnv = {
      fwd: env.fwd, side: env.side,
      heading: (st.yaw != null && isFinite(st.yaw)) ? st.yaw : env.heading,
      blocked: env.blocked, solids: env.solids
    };
    var gwn = wallFromInput(st, gEnv);
    if(gwn){
      wallStep(st, dt, gEnv, gwn.nx, gwn.nz, !!env.shift);
      // wallStep OWNS the body now: it climbs off the ground, so do not fall
      // through to the ground block below (that clamp fights the crawl and
      // jitters him into the street every other frame). If it topped out onto
      // a roof the grip is already gone and the walk owns the body again.
      st.dive = diveBlend(st, false, dt);
      st.tuck = 0.25;
      st.webFrom = null; st.webTo = null;
      return {mode: st.wall ? "wall" : "ground", fire: false, release: false};
    }
  }
  if(onGround){
    return {mode: "ground", fire: false, release: release};
  }
  // ---- free fall ----
  // Crawl is GROUND-ONLY (walk into a building). Free fall / dive / swing contact
  // must never start a wall grip — that clung mid-swing and felt broken.
  if(!onGround){
    // If somehow planted INSIDE a mass, push out without starting a crawl.
    if(!calm && !st.wall){
      contactFaceGrip(st, env, 0.95);   // depenetrates when inside; ignores outside
    }
    // ---- free fall ----
    // Space in the air is a WEB ZIP: throw a web at whatever is in front and get
    // pulled to it. With nothing to grab (open sky) the double jump still stands.
    // It is NEVER a silent no-op: the press must either zip, or jump, or kick —
    // "pressing space in air is doing nothing" is a bug, not a design.
    // NEAR A WALL, Space JUMPS AWAY — it must never yank you into the face you
    // are escaping ("sometime jump doesn't even work, to jump away from building").
    if(spaceEdge && !calm){
      var esc = faceNormalAt(st, env, null, null, 2.6);
      if(esc){
        jumpAwayFrom(st, esc, dt);
        st.dive = diveBlend(st, false, dt);
        return {mode: "fall", fire: false, release: release};
      }
      var zh = zipHit(st, env);
      if(zh){
        startZip(st, zh);
        return {mode: "zip", fire: true, release: release};
      }
      var jj = jumpImpulse(st, false, spaceEdge, calm);
      if(jj > 0){ st.vy = jj; jumpKick(st, st.yaw, 3.2); }
      else {
        // out of jumps and nothing to zip: still kick up-and-forward, so the
        // press is always visible in the air
        st.vy += 2.6;
        jumpKick(st, st.yaw, 3.2);
      }
    }
    st.vy -= g*dt;
    // gentle air control: WASD steers the fall along the camera / facing.
    // COAST locks that out — after a release you fly STRAIGHT along the line
    // you let go on, and a turn means starting another swing with Shift.
    var coast = (+st.coastT || 0) > 0;
    if(!coast){
      var ax = +env.fwd || 0, as = +env.side || 0;
      var hd = env.heading != null && isFinite(env.heading) ? +env.heading : (st.yaw || 0);
      var c = Math.cos(hd), s = Math.sin(hd);
      var dirX = s*ax - c*as, dirZ = c*ax + s*as;
      var steer = calm ? 6 : 14;
      st.vx += dirX*steer*dt; st.vz += dirZ*steer*dt;
    }
    // a coasting release keeps its speed (that is the "to increase speed" part)
    var drag = Math.exp(-(coast ? 0.10 : (calm ? 1.2 : 0.55))*dt);
    st.vx *= drag; st.vz *= drag;
    var fallPrev = {x: st.x, y: st.y, z: st.z};
    st.x += st.vx*dt; st.y += st.vy*dt; st.z += st.vz*dt;
    // all construction is opaque — free fall stops at a wall too
    var fallHit = null;
    if(typeof env.solids === "function"){
      fallHit = bodyBlock(fallPrev, {x: st.x, y: st.y, z: st.z,
        vx: st.vx, vy: st.vy, vz: st.vz}, sweepBoxes(fallPrev, st, env.solids));
      st.x = fallHit.x; st.y = fallHit.y; st.z = fallHit.z;
      st.vx = fallHit.vx; st.vy = fallHit.vy; st.vz = fallHit.vz;
    }
    // Fall hit a face: bodyBlock already stopped the inward move. Do NOT start
    // a wall crawl from the air — crawl is ground-only.
    if(env.blocked && env.blocked(st.x, st.z) && !env.blocked(st.x - st.vx*dt, st.z - st.vz*dt)){
      st.x -= st.vx*dt; st.z -= st.vz*dt; st.vx = 0; st.vz = 0;
    }
    var sp2 = Math.sqrt(st.vx*st.vx + st.vz*st.vz);
    if(coast){
      // face where you are GOING, never back toward the building you left
      if(sp2 > 0.4) st.yaw = Math.atan2(st.vx, st.vz);
      st.coastT = Math.max(0, (+st.coastT || 0) - dt);
    } else if(sp2 > 1.2){
      st.yaw = Math.atan2(st.vx, st.vz);
    }
    st.dive = diveBlend(st, wantDive(!!env.w, st.y - gy, st.vy), dt);
    if(st.spinV) st.spin = (st.spin || 0) + st.spinV*dt;
    else if(st.spin) st.spin = st.spin*(1 - Math.min(1, 2.2*dt));
    st.tuck = Math.max(0, Math.min(1, (st.dive*0.35) + Math.max(0, 2.2 - sp2)*0.12));
  }

  // ---- fire the web: a FRESH Shift press in the air, no line out yet ----
  // Holding Shift must not re-aim. The line stays on the building you attached
  // to until you release Shift; a new swing is a NEW press (that is how you turn
  // mid-air: let go, then press Shift again).
  // Shift also RAISES the web arm while aiming, so the line leaves the hand the
  // moment it fires (not a point floating beside the chest).
  if(env.shift && !calm) st.webArm = st.webSide;
  else if(!st.sw && !st.zip) st.webArm = 0;
  if(shiftEdge && env.shift && !st.sw && env.anchor && !calm){
    var aims = webAims(st.yaw || 0), got = null;
    var from = handOf(st);
    for(var i = 0; i < aims.length && !got; i++){
      got = env.anchor(from, aims[i], 42);
    }
    if(got){
      var hxo = from.x, hyo = from.y, hzo = from.z;
      var L = Math.sqrt((got.x - hxo)*(got.x - hxo) + (got.y - hyo)*(got.y - hyo) + (got.z - hzo)*(got.z - hzo));
      L = L > 2 ? L : 3.5;                 // the rope is the real distance
      st.sw = {
        ax: +got.x || 0, ay: +got.y || 0, az: +got.z || 0, len: L,
        x: st.x, y: st.y, z: st.z,
        vx: st.vx, vy: st.vy, vz: st.vz,
        yaw: st.yaw || 0, t: 0
      };
      st.webFrom = {x: hxo, y: hyo, z: hzo};
      st.webTo = {x: st.sw.ax, y: st.sw.ay, z: st.sw.az};
      st.coastT = 0;                   // a new swing is what turns you
      fire = true;
      st.jumps = Math.max(1, st.jumps | 0);
      return {mode: "swing", fire: fire, release: release};
    }
  }
  if(!env.shift && !st.sw && !st.zip){ st.webFrom = null; st.webTo = null; }
  return {mode: onGround ? "ground" : "fall", fire: fire, release: release};
}

/* A neon web line: a fat additive tube along the catenary, plus a thin bright
   core. Owned by the caller (the 3D scene); set(from, to) rebuilds the line,
   clear() hides it. Deterministic — no random sparkle. Same tube recipe the
   city already uses for its light trails (hq3d.js TubeGeometry + Additive). */
function makeWeb(THREE, parent, color){
  if(!THREE || !parent || !THREE.TubeGeometry) return null;
  var col = color == null ? NEON : color;
  var g = new THREE.Group();
  g.name = "skystrike-web";
  g.visible = false;
  var mOuter = new THREE.MeshBasicMaterial({
    color: col, transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending,
    depthWrite: false, toneMapped: false
  });
  var mCore = new THREE.MeshBasicMaterial({
    color: col, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending,
    depthWrite: false, toneMapped: false
  });
  var outer = new THREE.Mesh(new THREE.BufferGeometry(), mOuter);
  var core = new THREE.Mesh(new THREE.BufferGeometry(), mCore);
  outer.frustumCulled = false; core.frustumCulled = false;
  outer.renderOrder = 20; core.renderOrder = 21;
  g.add(outer); g.add(core);
  parent.add(g);
  function rebuild(from, to){
    disposeGeo(outer.geometry); disposeGeo(core.geometry);
    var d = Math.hypot((to.x||0) - (from.x||0), (to.z||0) - (from.z||0));
    var pts = webPoints(from, to, 0.05 + Math.min(0.45, d*0.012), 12);
    var v = [];
    for(var i = 0; i < pts.length; i++) v.push(new THREE.Vector3(pts[i].x, pts[i].y, pts[i].z));
    var curve = new THREE.CatmullRomCurve3(v);
    // a web strand, not a pipe: a thin bright core in a barely-there glow
    outer.geometry = new THREE.TubeGeometry(curve, 28, 0.012, 5, false);
    core.geometry = new THREE.TubeGeometry(curve, 28, 0.0035, 4, false);
  }
  return {
    g: g,
    set: function(from, to){
      if(!from || !to){ this.clear(); return; }
      rebuild(from, to);
      g.visible = true;
    },
    clear: function(){ g.visible = false; },
    dispose: function(){
      try { disposeGeo(outer.geometry); disposeGeo(core.geometry); } catch(e){}
      try { parent.remove(g); } catch(e){}
    }
  };
}
function disposeGeo(geo){
  if(geo && geo.dispose) try { geo.dispose(); } catch(e){}
}

/* palette: matte black / charcoal + neon blue (the concept sheet) */
var SUIT   = 0x0c1016;
var SUIT_2 = 0x141a22;
var SUIT_3 = 0x1c2430;
var NEON   = 0x2ec6ff;
var NEON_2 = 0x7ad9ff;
var BOOT   = 0x06080c;
var HIP_Y  = 0.88;
var ARM_T  = Math.PI/2;                 // T rest: arms along ±X (for aimBone)

function arm(on){ ARMED = on ? 1 : 0; if(on) tightenCam(); else untightenCam(); }
function wanted(key){
  if(!ARMED || !key) return false;
  return String(key).indexOf("you:") === 0;
}

/* ---------- chase camera (only while this game is open) ----------
   The city's camrig MODES are shared with HQ City, so save / restore them.
   TWO stand-offs, switched by whether the air kit owns the feet:
   - on the ground the close city chase the player knows (near 2.5 / chase 3.35)
   - in the air a whole-body stand-off so a swinging slinger is framed head to
     boots, not as an over-the-shoulder close-up.
   camAir(on) is the switch — hq3d's airStep calls it every frame with its
   `flying` flag; it is a no-op when the mode is already right. camrig may not
   be on the page yet (it loads with the HQ scripts), so tightenCam() is called
   again after loadHq(); the save guard makes that idempotent. */
var CAM_GROUND = {
  near:  {back: 2.5,  up: 1.8, fov: 70, side: 0.35, lag: 7, collide: 0.3,  near: 0.25, chase: true},
  chase: {back: 3.35, up: 2.2, fov: 65, side: 0.2,  lag: 6, collide: 0.35, near: 0.28, chase: true},
  far:   {back: 5.5,  up: 3.4, fov: 60, side: 0.05, lag: 5, collide: 0.4,  near: 0.3,  chase: true}
};
var CAM_AIR = {
  near:  {back: 5.0,  up: 2.7,  fov: 70, side: 0.35, lag: 7, collide: 0.3,  near: 0.25, chase: true},
  chase: {back: 7.0,  up: 3.8,  fov: 65, side: 0.2,  lag: 6, collide: 0.35, near: 0.28, chase: true},
  far:   {back: 10.0, up: 5.2,  fov: 60, side: 0.05, lag: 5, collide: 0.4,  near: 0.3,  chase: true}
};
var camAirWant = 0;                    // 0 = close ground stand-off, 1 = whole-body air
function camAir(on){
  var w = on ? 1 : 0;
  if(w === camAirWant) return;         // already there — never rewrite MODES per frame
  camAirWant = w;
  var C = window.HQV && window.HQV.camrig;
  if(!C || !C.MODES || !C.__skySaved) return;
  var M = C.MODES, S = w ? CAM_AIR : CAM_GROUND;
  M.near = S.near; M.chase = S.chase; M.far = S.far;
}
function tightenCam(){
  var C = window.HQV && window.HQV.camrig;
  if(!C || !C.MODES || C.__skySaved) return;
  var M = C.MODES;
  C.__skySaved = {
    chase: Object.assign({}, M.chase),
    near: Object.assign({}, M.near),
    far: Object.assign({}, M.far),
    create: C.create
  };
  camAirWant = 1;                      // force a write on the next camAir()
  camAir(0);                           // open CLOSE on the pad — the ground chase
  // open on the whole-body shot (the city's startMode is "chase"); leave
  // `preferred` alone so the HUD does not write a SkyStrike mode into hq_cam.
  C.create = function(o){
    o = Object.assign({}, o || {});
    o.mode = "chase";
    return C.__skySaved.create.call(C, o);
  };
}
function untightenCam(){
  var C = window.HQV && window.HQV.camrig;
  if(!C || !C.__skySaved) return;
  var S = C.__skySaved;
  C.MODES.chase = S.chase;
  C.MODES.near = S.near;
  C.MODES.far = S.far;
  C.create = S.create;
  delete C.__skySaved;
  camAirWant = 0;
}

/* ---------- procedural clips (same surface the Kenney mixer exposes) ---------- */
function act(name, dur){
  return {
    name: name, weight: 0, timeScale: 1, time: 0, enabled: true, _d: dur || 1,
    reset: function(){ this.time = 0; return this; },
    play: function(){ this.enabled = true; return this; },
    stop: function(){ return this; },
    fadeIn: function(){ return this; },
    fadeOut: function(){ return this; },
    setEffectiveWeight: function(w){ this.weight = +w || 0; return this; },
    setLoop: function(){ return this; },
    getClip: function(){ return {duration: this._d || 1, name: this.name}; }
  };
}

function mat(THREE, color, o){
  return new THREE.MeshStandardMaterial(Object.assign({color: color, roughness: 0.5, metalness: 0.15}, o || {}));
}
function glow(THREE, color, k){
  return new THREE.MeshStandardMaterial({
    color: color, emissive: color, emissiveIntensity: k == null ? 1.2 : k,
    roughness: 0.35, metalness: 0.05, toneMapped: false
  });
}
function mesh(THREE, geo, material, parent, x, y, z){
  var m = new THREE.Mesh(geo, material);
  m.castShadow = true; m.frustumCulled = false;
  if(x != null) m.position.set(x, y || 0, z || 0);
  if(parent) parent.add(m);
  return m;
}
/* capsule along +Y */
function capY(THREE, r, h, seg){
  if(THREE.CapsuleGeometry) return new THREE.CapsuleGeometry(r, h, 5, seg || 12);
  return new THREE.CylinderGeometry(r, r, h + 2*r, seg || 12, 1, false);
}
function sph(THREE, r, seg){
  return new THREE.SphereGeometry(r, seg || 16, seg ? Math.max(8, seg - 4) : 12);
}
/* soft form: sphere scaled into a mass, never a hard ball joint */
function lump(THREE, parent, material, x, y, z, sx, sy, sz, r){
  var m = mesh(THREE, sph(THREE, r || 0.1, 16), material, parent, x, y, z);
  m.scale.set(sx, sy, sz);
  return m;
}
/* raised angular armour panel (chest / thigh / shin / gauntlet plates) */
function panelGeo(THREE, pts, depth){
  var sh = new THREE.Shape();
  sh.moveTo(pts[0][0], pts[0][1]);
  for(var i = 1; i < pts.length; i++) sh.lineTo(pts[i][0], pts[i][1]);
  sh.closePath();
  return new THREE.ExtrudeGeometry(sh, {
    depth: depth || 0.01, bevelEnabled: true,
    bevelThickness: 0.002, bevelSize: 0.002, bevelSegments: 2
  });
}
/* thin neon piping along a limb */
function pipe(THREE, parent, material, x, y, z, len, sign, tilt){
  var p = mesh(THREE, capY(THREE, 0.0035, len, 6), material, parent, x, y, z);
  if(sign) p.rotation.z = sign * Math.PI / 2;
  if(tilt) p.rotation.x = tilt;
  return p;
}

/* Big flat angular mask lens — LEFT eye (character's left, +X side of face).
   Outward (+X) = temple tip, HIGH. Inward (−X) = nose tip, LOW.
   Large enough to read as the whole face character on the concept sheet
   (hooded cowl + two glowing lenses). Right eye = scale.x = −1. */
function eyeGeo(THREE){
  var s = new THREE.Shape();
  s.moveTo(0.055, 0.022);    // temple tip — HIGH, OUTWARD (+X)
  s.lineTo(0.018, 0.038);    // top edge
  s.lineTo(-0.028, 0.016);   // inner top
  s.lineTo(-0.048, -0.012);  // nose tip — LOW, INWARD (−X)
  s.lineTo(-0.018, -0.032);  // bottom inner
  s.lineTo(0.028, -0.018);   // bottom outer
  s.closePath();
  return new THREE.ExtrudeGeometry(s, {depth: 0.004, bevelEnabled: false});
}
/* Sharp angular chest mark — original bird-of-prey / strike emblem from the
   concept sheet. Not a licensed character mark. */
function crestGeo(THREE){
  var s = new THREE.Shape();
  s.moveTo(0, 0.095);          // top tip
  s.lineTo(0.018, 0.032);
  s.lineTo(0.058, 0.055);      // upper wing
  s.lineTo(0.028, 0.004);
  s.lineTo(0.052, -0.042);     // lower wing
  s.lineTo(0.014, -0.022);
  s.lineTo(0, -0.095);         // bottom tip
  s.lineTo(-0.014, -0.022);
  s.lineTo(-0.052, -0.042);
  s.lineTo(-0.028, 0.004);
  s.lineTo(-0.058, 0.055);
  s.lineTo(-0.018, 0.032);
  s.closePath();
  return new THREE.ExtrudeGeometry(s, {depth: 0.01, bevelEnabled: true, bevelThickness: 0.002, bevelSize: 0.002, bevelSegments: 1});
}

/* ---------- arm helpers ----------
   Arms rest along ±X (T) so city seating can aimBone(..., "x").
   Locomotion hangs them at the sides and swings them in the sagittal plane.
   After the hang, local Y is world X (the sagittal flex axis). */
var AX_X = {x: 1, y: 0, z: 0};
var AX_Y = {x: 0, y: 1, z: 0};
var AX_Z = {x: 0, y: 0, z: 1};
function qAxis(THREE, ax, ang, out){
  // setFromAxisAngle only reads .x/.y/.z — do not require THREE.Vector3
  var Q = (out && out.constructor) || (THREE && THREE.Quaternion) || null;
  if(!Q) return out || null;
  out = out || new Q();
  out.setFromAxisAngle({x: ax.x, y: ax.y, z: ax.z}, ang);
  return out;
}
/* hang (T → sides) then sagittal swing around world X. sign +1 = left, −1 = right.
   flare (optional) opens the arms a touch so the forearms clear the hips. */
function armQ(THREE, sign, swing, out, flare){
  out = out || new (out && out.constructor || THREE.Quaternion)();
  var hang = qAxis(THREE, AX_Z, -sign*(ARM_T - (flare || 0)));
  var sw = qAxis(THREE, AX_X, swing);
  return out.copy(sw).multiply(hang);
}
/* forearm folds forward. After the hang, local Y is world X (sagittal). */
function elbQ(THREE, sign, flex, out){
  return qAxis(THREE, AX_Y, -sign*flex, out);
}

/* ---------- human gait (walk / run) ----------
   A biped cycle, not a bot shuffle. Conventions (character faces +Z):
   - hip.rotation.x < 0 swings the leg forward; knee.rotation.x > 0 folds the
     shin backward (heel toward the seat) — a human knee, not a bird knee.
   - ankle.rotation.x < 0 points the toes down (plantarflexion).
   - arms hang at the sides (not T) and swing sagittally; elbow folds forward.
   - left arm swings with the right leg and the other way round.
   Phase p: 0 = this foot's contact; one cycle = two steps (a stride).

   Walk (runK 0) is the old sprint: a long fast stride at the pace Shift used
   to give you. Run (runK 1) is a human run (Novachecki / Mann / Cavanagh gait
   data): deep heel kick (knee folds hard in swing), a flexed stance knee that
   dips on landing, a flight bounce (lowest at mid-stance, apex in the air),
   a forward bend ABOVE THE WAIST (the torso bone — the root stays upright so
   the legs stay under the body and the feet never sink through the ground),
   shoulders wound against the pelvis, and a braced arm drive in lockstep with
   the opposite leg. */

/* cosine-eased keyframe track. keys = [[p, v], ...] on [0,1); wraps. Slope is
   zero at every key, so the heel kick and the push-off hang instead of cornering. */
function keyAt(p, keys){
  if(!keys || !keys.length) return 0;
  var x = ((p || 0) % 1 + 1) % 1, n = keys.length;
  for(var i = 0; i < n; i++){
    var a = keys[i], b = keys[(i + 1) % n];
    var pa = a[0], pb = b[0], t = x;
    if(pb <= pa) pb += 1;
    if(t < pa) t += 1;
    if(t >= pa && t <= pb){
      var u = (pb - pa) > 1e-6 ? (t - pa)/(pb - pa) : 0;
      u = 0.5 - 0.5*Math.cos(Math.PI*u);
      return a[1] + (b[1] - a[1])*u;
    }
  }
  return keys[0][1];
}

/* Run (sprint). Sagittal angles. hip = flexion (+ = thigh forward, applied as
   -flexion); knee = flexion (+ = shin folds back); ankle = dorsiflexion
   (+ = toes up). Keys: contact (0), loading (~0.08), toe-off (~0.32),
   mid-swing / heel kick (~0.62), thigh-through (~0.80), terminal (~0.96).
   A sprint is not a fast walk: the thigh LIFTS hard at contact (1.10 rad ≈ 63°)
   and again through terminal swing (1.18), the hip drives back to −0.70 at
   toe-off, and the knee folds to 2.50 rad (~143°) for the heel kick. That
   thigh-up + heel-to-seat pair is the silhouette the walk never makes — the
   walk's thigh only swings ±0.75. */
var RUN_HIP    = [[0, 1.10], [0.08, 0.42], [0.32, -0.70], [0.62, 0.20], [0.80, 1.00], [0.96, 1.18]];
var RUN_KNEE   = [[0, 0.55], [0.08, 0.88], [0.32, 0.78], [0.62, 2.50], [0.72, 2.45], [0.96, 0.52]];
var RUN_ANKLE  = [[0, 0.12], [0.08, 0.32], [0.32, -0.68], [0.62, 0.18], [0.96, 0.22]];

function gaitPose(ch, ph, runK, bendK){
  var B = ch && ch._bones;
  if(!B) return;
  var THREE = (B.r && B.r.__t) || (window.THREE) || null;
  if(!THREE && B.la && B.la.quaternion) THREE = {Quaternion: B.la.quaternion.constructor};
  var two = Math.PI*2;
  var k = Math.max(0, Math.min(1, +runK || 0));   // 0 = walk (the old sprint), 1 = sprint
  // bend ABOVE THE WAIST (torso pitch) and ONLY while running: walking is
  // upright. The root stays upright too — tipping it drove the whole body into
  // the ground. bendK is the run shape (from the raw sprint intent, eased only
  // while a change of pace settles and snapped to 0 on a full stop) — not the
  // eased locomotion weight, which takes ~0.3 s to fall and lingered after a stop.
  var bk = bendK != null ? Math.max(0, Math.min(1, +bendK || 0)) : k;
  var bend = 0.42*bk;
  var roll = 0.08;

  /* knee: nearly straight in stance, a deep backward fold through swing (0.52→1) */
  function kneeOf(p){
    // walk: the old sprint's heel kick. run: the human swing fold (heel to seat).
    var sw = 0;
    if(p > 0.52 && p < 1) sw = Math.sin(Math.PI*(p - 0.52)/0.48);
    var wKnee = 0.18 + 1.5*sw;
    var rKnee = keyAt(p, RUN_KNEE);
    return wKnee*(1 - k) + rKnee*k;
  }

  function leg(p, hip, knee, ankle){
    var wHip = Math.cos(two*p)*0.75;               // the old sprint: long swing
    var rHip = keyAt(p, RUN_HIP);
    hip.rotation.x = -(wHip*(1 - k) + rHip*k);     // − = forward
    knee.rotation.x = kneeOf(p);                   // + = shin folds back
    if(ankle){
      var wAnk = -0.18*Math.cos(two*p) + 0.12;
      ankle.rotation.x = wAnk*(1 - k) + keyAt(p, RUN_ANKLE)*k;
    }
  }
  function armSwing(p, sh, el, wr, sign){
    // Contralateral: the right arm drives FORWARD at left contact (p = 0).
    // armQ swing is negative = arm forward (the sit pose's -0.55 puts both hands
    // toward the wheel). The old gait had this sign backwards — arms moved with
    // the same-side leg, which is the robot tell.
    var c = Math.cos(two*p);
    var wSw = -c*0.82;                               // walk: the old sprint's amplitude
    // run: a much longer, forward-biased arc (the walk's swing is wider than the
    // old run's was — that is exactly why the two looked the same)
    var rSw = -(0.18 + 1.02*c);
    var sw = wSw*(1 - k) + rSw*k;
    if(sh.quaternion) armQ(THREE, sign, sw, sh.quaternion, 0.06 + 0.08*k);
    else sh.rotation.set(0, 0, -sign*ARM_T);
    // braced elbow; punches higher at the front of the swing
    var wFlex = 0.385 + Math.max(0, c)*0.825;
    var rFlex = 1.58 + 0.22*Math.max(0, c);
    var flex = wFlex*(1 - k) + rFlex*k;
    if(el.quaternion) elbQ(THREE, sign, flex, el.quaternion);
    if(wr && wr.quaternion) elbQ(THREE, sign, 0.08, wr.quaternion);
  }

  leg(ph,        B.ll, B.lk, B.lf);
  leg(ph + 0.5,  B.rl, B.rk, B.rf);
  // left arm with the right leg, right arm with the left leg
  armSwing(ph + 0.5,  B.la, B.le, B.lw,  1);
  armSwing(ph,        B.ra, B.re, B.rw, -1);

  // Bend ABOVE THE WAIST (the torso bone), never at the ankles and never on the
  // root. The root stays upright so the legs stay under the body and the feet
  // never sink through the floor; the run hinges at the hips and the head
  // cancels most of it so the gaze leads forward-down like a sprinter's.
  var yS = 0.06 + 0.24*k;                          // shoulder yaw (more wring in the run)
  var yP = 0.06 + 0.05*k;                          // pelvis yaw — the other way
  var c = Math.cos(two*ph);
  if(B.r && B.r.rotation){
    B.r.rotation.x = 0;                            // upright — the bend is at the waist
    B.r.rotation.y = yP*c*k;
    B.r.rotation.z = 0;
  }
  B.t.rotation.set(bend + 0.015*Math.sin(two*ph), -yS*c, roll*Math.sin(two*ph)*0.35);
  // head cancels ~72% of the waist bend (run only; walking has no bend to cancel)
  B.h.rotation.set(-bend*0.72 + 0.01*Math.sin(two*ph)*k, Math.sin(two*ph)*(0.08 + 0.02*k), 0);

  // bounce: the old sprint squats on each step; the human run springs (low at
  // mid-stance, apex in flight). Flat crossover at k = 0.5 so the blend never pops.
  // run troughs at ph = 0.12 / 0.62 (mid-stance), apexes at 0.37 / 0.87 (flight).
  var wBob = -Math.abs(Math.sin(two*ph))*0.035;
  var rBob = -0.055*(0.5 + 0.5*Math.cos(2*two*(ph - 0.12)));
  if(B.r && B.r.position) B.r.position.y = wBob*(1 - k) + rBob*k;
  B.t.position.y = HIP_Y + 0.012 + 0.002*k;
}

/* ---------- air poses (dive / swing / free) ----------
   A human in the air, not a ragdoll and not a robot:
   - dive: spine long and head down, arms swept back along the sides, legs
     together and pointed (the classic head-first swoop).
   - swing: one arm up along the line, the other trailing, body hanging and
     stretching with the rope's angle, legs trailing and a little bent, torso
     rolled toward the free side.
   - free: a slow axial spin, limbs stretched mid-tuck, the shape of a body
     that just pushed off and is still travelling. */
function airPose(ch, o){
  var B = ch && ch._bones;
  if(!B) return;
  o = o || {};
  var dive = Math.max(0, Math.min(1, +o.dive || 0));
  var swing = Math.max(0, Math.min(1, +o.swing || 0));
  var stretch = Math.max(0, Math.min(1, +o.stretch || 0));
  var wall = Math.max(0, Math.min(1, +o.wall || 0));
  var t = +o.t || 0;
  var calm = !!(E && E.calm && E.calm());
  var THREE = (B.la && B.la.quaternion) ? {Quaternion: B.la.quaternion.constructor} : null;

  // ---- free-fall: a JUMP, then a GLIDE only when he is really falling ----
  // A plain jump is a plain jump: the launch curl unwinds and the body stays a
  // body in the air — slight lift, legs under him. The glide (head down, legs up
  // behind) belongs to an actual descent, so it is driven by FALL TIME and the
  // dive, never by launch / stretch. Those two used to force the dive shape on
  // every ordinary hop ("even on jumping normally i am getting diving position").
  var flut = calm ? 0 : Math.sin(t*2.1)*0.05;
  var launch = Math.max(0, Math.min(1, +o.launch || 0));
  var fallT = Math.max(0, Math.min(1, +o.fallT || 0));
  var d = dive;
  // clear any wall-cling root offset before other air poses write the body
  if(B.r.position){ B.r.position.x = 0; B.r.position.z = 0; }
  // glide weight: 0 = a jump / early rise, 1 = a real fall or a head-first dive
  var base = 0.55*Math.max(0, Math.min(1, fallT + d*0.45));
  // the ROOT tips the whole body over (nose down) — the spine only continues it
  B.r.rotation.set(base*0.85 + d*0.55 + launch*0.10, flut*0.35, 0);
  B.t.rotation.x = 0.06 + base*0.55 + d*1.05 + launch*0.34;
  B.t.rotation.y = flut*0.9;
  B.t.rotation.z = 0;
  B.t.position.y = HIP_Y + 0.012;
  B.h.rotation.x = -0.08 - base*0.35 - d*0.60 + flut*0.25;   // chin down the line
  B.h.rotation.y = flut*0.5;
  B.h.position.y = 0.635;

  // legs: under him on a jump, UP behind once the glide takes over
  var lgx = 0.12 + base*0.55 + d*0.45, kn = 0.22 + launch*0.45 + d*0.12, ank = -0.22 - d*0.16 - stretch*0.08;
  B.ll.rotation.set(lgx + flut*0.12, 0, 0.08);
  B.rl.rotation.set(lgx*0.92 - flut*0.12, 0, -0.10);
  B.lk.rotation.x = kn; B.rk.rotation.x = kn*1.04;
  if(B.lf) B.lf.rotation.x = ank;
  if(B.rf) B.rf.rotation.x = ank;

  // arms: wide and a little high (balance in the air), elbows soft. The launch
  // curls them in, then they open again. A held web arm goes COMPLETELY up —
  // armQ's hang leaves the arm hanging at -Y, so a sagittal swing of -PI is the
  // one angle that points it straight up along the web line (a -1.55 only
  // reaches forward-level, which is why the shot never looked like a raise).
  var up = o.webArm < 0 ? -1 : (o.webArm > 0 ? 1 : 0);
  if(THREE && B.la.quaternion){
    var aSw = -0.88 - launch*0.22 - stretch*0.10, aFl = 0.42 + launch*0.10 + stretch*0.18;
    var upSw = -Math.PI, upFl = 0.02, freeSw = 0.62, freeFl = 0.52;
    if(up > 0){
      armQ(THREE, 1, upSw, B.la.quaternion, upFl);
      armQ(THREE, -1, freeSw, B.ra.quaternion, freeFl);
      elbQ(THREE, 1, 0.05, B.le.quaternion);          // elbow nearly straight: a real reach
      elbQ(THREE, -1, 0.62, B.re.quaternion);
    } else if(up < 0){
      armQ(THREE, -1, upSw, B.ra.quaternion, upFl);
      armQ(THREE, 1, freeSw, B.la.quaternion, freeFl);
      elbQ(THREE, -1, 0.05, B.re.quaternion);
      elbQ(THREE, 1, 0.62, B.le.quaternion);
    } else {
      armQ(THREE, 1, aSw, B.la.quaternion, aFl);
      armQ(THREE, -1, aSw, B.ra.quaternion, aFl);
      elbQ(THREE, 1, 0.55 + launch*0.30, B.le.quaternion);
      elbQ(THREE, -1, 0.55 + launch*0.30, B.re.quaternion);
    }
    if(B.lw) elbQ(THREE, 1, 0.12, B.lw.quaternion);
    if(B.rw) elbQ(THREE, -1, 0.12, B.rw.quaternion);
  } else {
    B.la.rotation.set(0, 0, -ARM_T - 0.4);
    B.ra.rotation.set(0, 0, ARM_T + 0.4);
    B.le.rotation.y = 0.55; B.re.rotation.y = -0.55;
  }
  B.r.position.y = 0;

  if(dive > 0.02){
    // W held: deepen the glide into a head-first swoop. Arms sweep back along
    // the sides, legs together and pointed up behind.
    B.t.rotation.x = 0.06 + base*0.55 + d*1.05 + launch*0.34;
    B.h.rotation.x = -0.08 - base*0.35 - d*0.60;
    if(THREE && B.la.quaternion && !up){
      armQ(THREE, 1, 0.72*d, B.la.quaternion, 0.04 + (1 - d)*0.18);
      armQ(THREE, -1, 0.72*d, B.ra.quaternion, 0.04 + (1 - d)*0.18);
      elbQ(THREE, 1, 0.12*d, B.le.quaternion);
      elbQ(THREE, -1, 0.12*d, B.re.quaternion);
    } else if(THREE && B.la.quaternion && up){
      // the web arm stays up; the free arm sweeps back along the ribs
      var fS = 0.72*d;
      if(up > 0){
        elbQ(THREE, -1, 0.12*d, B.re.quaternion);
        armQ(THREE, -1, fS, B.ra.quaternion, 0.04 + (1 - d)*0.18);
      } else {
        elbQ(THREE, 1, 0.12*d, B.le.quaternion);
        armQ(THREE, 1, fS, B.la.quaternion, 0.04 + (1 - d)*0.18);
      }
    } else if(!THREE || !B.la.quaternion){
      B.la.rotation.set(0, 0, -ARM_T + d*0.88);
      B.ra.rotation.set(0, 0, ARM_T - d*0.88);
    }
    // legs together and pointed up behind
    var lg2 = 0.30 + base*0.55 + d*0.62;
    B.ll.rotation.set(lg2, 0, 0.04);
    B.rl.rotation.set(lg2, 0, -0.04);
    B.lk.rotation.x = 0.16*(1 - d) + 0.05;
    B.rk.rotation.x = 0.16*(1 - d) + 0.05;
    if(B.lf) B.lf.rotation.x = -0.30 - d*0.18;
    if(B.rf) B.rf.rotation.x = -0.30 - d*0.18;
  }

  if(swing > 0.02){
    // hanging from the line: the web arm is UP (the shoulder aims up along the
    // rope), the free arm trails, the body stretches and rolls a touch toward
    // the free side, the legs trail with a soft knee. `side` (+1 left web) picks
    // which arm holds the line.
    var s = swing, side = o.side < 0 ? -1 : 1;
    var tuck = Math.max(0, Math.min(1, +o.tuck || 0));   // 0 = long hang, 1 = knees up
    // torso: hangs long, rolled toward the free side, a little curl
    B.t.rotation.set(0.18 + s*0.22 + tuck*0.35, side*0.14*s, -side*0.22*s);
    B.t.position.y = HIP_Y + 0.012;
    B.h.rotation.set(-0.22 - s*0.18 + tuck*0.25, side*0.20*s, side*0.10*s);
    // the web arm reaches COMPLETELY up along the rope (elbow nearly straight) —
    // the shoulder aims straight at the anchor, not forward-level
    var upSwing = -Math.PI + tuck*0.12, upFlex = 0.06 + tuck*0.18;
    // the free arm trails back and out (a human hang, not a T)
    var freeSwing = 0.55 + tuck*0.15, freeFlex = 0.55 + tuck*0.25;
    if(THREE && B.la.quaternion){
      if(side > 0){
        armQ(THREE, 1, upSwing, B.la.quaternion, 0.10);
        armQ(THREE, -1, freeSwing, B.ra.quaternion, 0.28);
        elbQ(THREE, 1, upFlex, B.le.quaternion);
        elbQ(THREE, -1, freeFlex, B.re.quaternion);
      } else {
        armQ(THREE, -1, upSwing, B.ra.quaternion, 0.10);
        armQ(THREE, 1, freeSwing, B.la.quaternion, 0.28);
        elbQ(THREE, -1, upFlex, B.re.quaternion);
        elbQ(THREE, 1, freeFlex, B.le.quaternion);
      }
    } else {
      B.la.rotation.set(0, 0, -ARM_T + (side > 0 ? upSwing : freeSwing));
      B.ra.rotation.set(0, 0, ARM_T - (side > 0 ? freeSwing : upSwing));
    }
    // legs trail: long when the swing is open, knees up when it tucks
    var hipL = 0.35 + tuck*0.85, kneeL = 0.30 + tuck*0.95;
    B.ll.rotation.set(hipL, 0, 0.08);
    B.rl.rotation.set(hipL*0.92, 0, -0.10);
    B.lk.rotation.x = kneeL; B.rk.rotation.x = kneeL*1.06;
    if(B.lf) B.lf.rotation.x = -0.22 - tuck*0.12;
    if(B.rf) B.rf.rotation.x = -0.22 - tuck*0.12;
    B.r.rotation.set(0, side*0.08*s, 0);
    B.r.position.y = -0.02*s;
  }

  if(wall > 0.02){
    // WALL CRAWL (city-slinger, Spidey-style vertical cling — NOT a dive).
    // The hero stays UPRIGHT on the face: crouched, chest into the wall, head
    // up the climb. The old root tip (~0.72 rad nose-down) laid the body
    // horizontal and read as flying / swimming above the surface. Limbs use a
    // contralateral crawl (L arm + R leg, then R arm + L leg). Idle is a
    // planted spider crouch; Shift runs with bigger, faster reaches.
    var wl = Math.max(0, Math.min(1, +o.wall || 0));
    var wside = o.side < 0 ? -1 : 1;
    var wRun = Math.max(0, Math.min(1, +o.wallRun || 0));
    var wMove = Math.max(wRun, Math.max(0, Math.min(1, +o.wallMove || 0)));
    var cPh = t*(wRun > 0.5 ? 9.2 : (wMove > 0.05 ? 5.2 : 0));
    var r1 = wMove > 0.05 ? Math.sin(cPh) : 0;
    var r2 = wMove > 0.05 ? Math.sin(cPh + Math.PI) : 0;   // opposite diagonal
    var aAmp = wl*(wRun > 0.5 ? 0.55 : 0.38);
    var lAmp = wl*(wRun > 0.5 ? 0.42 : 0.28);
    // UPRIGHT lean INTO the face (small pitch) — never a belly-down tip.
    // Root sink closes the last centimetres so the chest sits on the surface.
    B.r.rotation.set(wl*0.18, wside*wl*0.04*(0.4 + 0.6*wMove), wside*wl*0.06*r1*wMove);
    B.r.position.y = -0.22*wl;                 // crouch: hips drop
    B.r.position.z = 0.10*wl;                  // chest toward +Z (into the wall)
    B.t.rotation.set(0.28*wl + 0.06*r1*wMove, wside*wl*0.10, -wside*wl*0.05);
    B.t.position.y = HIP_Y + 0.012 - 0.04*wl;
    B.h.rotation.set(-(0.10 + wl*0.18), wside*wl*0.08, 0);   // chin up the climb
    // Legs: frog/spider crouch — thighs up toward the wall, knees wide and bent,
    // feet plant. Contralateral step when moving.
    // hip.x < 0 = forward (toward wall / +Z); hip.x > 0 = back. On a wall we
    // fold the thighs UP (negative) so the feet plant on the face below the hips.
    B.ll.rotation.set(-0.55*wl - r2*lAmp, 0, 0.22*wl + Math.max(0, r1)*0.10);
    B.rl.rotation.set(-0.55*wl - r1*lAmp, 0, -0.22*wl - Math.max(0, r2)*0.10);
    B.lk.rotation.x = 1.15*wl + Math.max(0, -r2)*0.35;
    B.rk.rotation.x = 1.15*wl + Math.max(0, -r1)*0.35;
    if(B.lf) B.lf.rotation.x = -0.55*wl;
    if(B.rf) B.rf.rotation.x = -0.55*wl;
    // Arms: reach UP the face and out (planted hands), alternating with the
    // opposite leg. swing ≈ -2.2 is raised forward-up along the wall, not the
    // -π web hang that pointed them at the sky and read as swimming.
    var upL = -2.05 - Math.max(0, r1)*aAmp;
    var upR = -2.05 - Math.max(0, r2)*aAmp;
    var flL = 0.55*wl + Math.max(0, -r1)*0.22;
    var flR = 0.55*wl + Math.max(0, -r2)*0.22;
    if(THREE && B.la.quaternion){
      armQ(THREE, 1, upL, B.la.quaternion, flL);
      armQ(THREE, -1, upR, B.ra.quaternion, flR);
      elbQ(THREE, 1, 0.55*wl + Math.max(0, -r1)*0.35, B.le.quaternion);
      elbQ(THREE, -1, 0.55*wl + Math.max(0, -r2)*0.35, B.re.quaternion);
    } else {
      B.la.rotation.set(-0.9*wl + r1*aAmp, 0, -ARM_T - 0.55*wl);
      B.ra.rotation.set(-0.9*wl + r2*aAmp, 0, ARM_T + 0.55*wl);
    }
  }
}

/* rest (T, city seating) → idle → walk / run / sit */
function poseHero(ch, t){
  if(!ch || !ch._bones) return;
  var B = ch._bones, a = ch.acts || {};
  var calm = !!(E && E.calm && E.calm());
  function w(n){ var x = a[n]; return x ? (x.weight || 0) : 0; }
  var wi = w("idle"), ww = w("walk"), ws = w("sprint"), wsi = 0;
  if(ch.cur === "idle" && !ch.loco) wi = 1;
  if(ch.cur === "walk" && !ch.loco) ww = 1;
  if(ch.cur === "sprint" && !ch.loco) ws = 1;
  if(ch.cur === "sit") wsi = 1;
  var move = ww + ws, still = Math.max(wi, 1 - move - wsi);
  if(move > 1){ ww /= move; ws /= move; move = 1; }

  var t0 = ch._t;
  ch._t = t || 0;
  var dt = (t0 == null) ? 0 : Math.max(0, Math.min(0.1, (t || 0) - t0));
  if(calm) dt = 0;
  // walk ~1.35 Hz (the old sprint's stride), run ~1.80 Hz (~216 steps/min —
  // sprint turnover). A cycle is two steps, so these are stride frequencies.
  var cadence = 1.35*ww + 1.80*ws;
  ch._ph = ((ch._ph || 0) + dt*cadence) % 1;
  var ph = ch._ph;
  var breath = calm ? 0 : Math.sin((t || 0)*1.5)*0.008*still;
  var THREE = (B.la && B.la.quaternion) ? {Quaternion: B.la.quaternion.constructor} : null;

  // Air: the game tags the hero's air state on the character. While any of it
  // is live the air pose owns the body (dive / swing / stretch), so the gait
  // never fights it. blendOut is a short settle so landing never pops.
  var air = ch._air;
  if(air && (air.swing > 0.01 || air.dive > 0.01 || air.stretch > 0.01 || air.launch > 0.01 || air.wall > 0.01 || air.fallT > 0.01)){
    airPose(ch, air);
    return;
  }

  if(wsi > 0.05){
    /* seated — hands toward a wheel / rail, knees up */
    B.t.rotation.set(0.12*wsi, 0, 0);
    B.t.position.y = HIP_Y - 0.16*wsi;
    B.h.rotation.set(0.05*wsi, 0, 0);
    B.h.position.y = 0.635;
    if(THREE && B.la.quaternion){
      armQ(THREE, 1, -0.55*wsi, B.la.quaternion, 0.1);
      armQ(THREE, -1, -0.55*wsi, B.ra.quaternion, 0.1);
      elbQ(THREE, 1, 0.7*wsi, B.le.quaternion);
      elbQ(THREE, -1, 0.7*wsi, B.re.quaternion);
    }
    B.ll.rotation.x = -1.35*wsi;
    B.rl.rotation.x = -1.35*wsi;
    B.lk.rotation.x = 1.25*wsi;
    B.rk.rotation.x = 1.25*wsi;
    if(B.lf) B.lf.rotation.x = -0.2*wsi;
    if(B.rf) B.rf.rotation.x = -0.2*wsi;
    B.r.position.y = 0;
    return;
  }

  // Run styling (bend, thigh lift, arm drive) is keyed off the RAW sprint
  // intent — the key, not the eased locomotion weight. The crossfade (ws)
  // takes ~0.3 s to fall, which is the latency the player feels when they stop.
  var want = ch._runWant != null ? Math.max(0, Math.min(1, +ch._runWant || 0)) : ws;
  var go = ch._goWant != null ? +ch._goWant : 1;

  if(!go){
    // ONE restore: the keys are up, so go straight to idle. Stepping through a
    // walk pose first (sprint -> walk -> idle) read as the body restoring twice.
    move = 0; ww = 0; ws = 0;
    ch._bendK = 0;
  } else {
    // A change of pace SETTLES (Shift up / down while you are still moving);
    // it is not a restore. Snapping the run shape off the Shift key popped
    // run -> walk (restore #1) and then the stop popped walk -> idle
    // (restore #2). Only a full stop snaps (the !go branch above). Starting a
    // sprint is at once — vigor should not ease in. Omega 7: the straightening
    // takes ~0.45 s, so it reads as the runner easing up into a walk, never as
    // the body snapping back to its rest shape.
    var b0 = ch._bendK != null ? +ch._bendK : want;
    if(calm || want > b0) ch._bendK = want;
    else ch._bendK = b0 + (want - b0)*(1 - Math.exp(-7*dt));
  }

  if(move > 0.02){
    // The gait SHAPE (thighs, arms, lean) is the settled run shape; the
    // cadence still uses the eased ws/ww so the stride rate changes smoothly.
    // While the keys are down there is no restore — a change of pace settles
    // and only a full stop snaps.
    gaitPose(ch, ph, ch._bendK, ch._bendK);
    return;
  }

  /* hero idle — a relaxed action-game stance, not a robot T-pose hang.
     Feet apart, weight on one leg, hips cocked, chest open, arms held a
     little away from the ribs with elbows bent (the ref-sheet 2 stance). */
  var sway = calm ? 0 : Math.sin((t || 0)*0.7)*0.018;
  var breath2 = calm ? 0 : Math.sin((t || 0)*1.5)*0.006*still;
  // torso: slight twist + a touch of forward lean (never a ramrod column)
  B.t.rotation.set(0.06 + breath2, 0.12 + sway*0.35, -0.03);
  B.t.position.y = HIP_Y + breath2*0.3;
  // head: turned a hair into the pose, chin level (not a bobble)
  B.h.rotation.set(-0.02 + (calm ? 0 : Math.sin((t || 0)*0.55)*0.025), -0.08 + sway*0.5, 0.02);
  B.h.position.y = 0.635 + breath2*0.2;

  // arms: held off the ribs, elbows bent, hands relaxed (hero, not soldier)
  if(THREE && B.la.quaternion){
    armQ(THREE, 1, 0.12 + sway*0.12, B.la.quaternion, 0.32);
    armQ(THREE, -1, -0.06 - sway*0.12, B.ra.quaternion, 0.38);
    elbQ(THREE, 1, 0.55, B.le.quaternion);
    elbQ(THREE, -1, 0.72, B.re.quaternion);
    if(B.lw) elbQ(THREE, 1, 0.12, B.lw.quaternion);
    if(B.rw) elbQ(THREE, -1, 0.18, B.rw.quaternion);
  } else {
    B.la.rotation.set(0, 0, -ARM_T + 0.12);
    B.ra.rotation.set(0, 0,  ARM_T - 0.06);
    B.le.rotation.y = 0.55;
    B.re.rotation.y = -0.72;
  }

  // legs: feet apart (abduct on X), left leg straight (weight), right knee soft
  B.ll.rotation.set(0.02, 0, 0.10);
  B.rl.rotation.set(-0.05, 0, -0.16);
  B.lk.rotation.x = 0.04;
  B.rk.rotation.x = 0.20;
  if(B.lf) B.lf.rotation.set(0, 0.06, 0);
  if(B.rf) B.rf.rotation.set(0.08, -0.14, 0);
  // hip cock: root yaws a touch so the stance is not dead-square
  B.r.rotation.y = 0.08 + sway*0.25;
  B.r.position.y = 0;
  B.r.position.x = 0.012;
}

function build(){
  var eng = E || HQV.engine;
  if(!eng || !eng.lib) return Promise.reject(new Error("engine"));
  return eng.lib().then(function(L){
    var THREE = L.THREE;
    var o = new THREE.Group();
    o.name = "skystrike";

    var mSuit  = mat(THREE, SUIT,   {roughness: 0.55, metalness: 0.08});
    var mSuit2 = mat(THREE, SUIT_2, {roughness: 0.6,  metalness: 0.06});
    var mSuit3 = mat(THREE, SUIT_3, {roughness: 0.5,  metalness: 0.12});
    var mBoot  = mat(THREE, BOOT,   {roughness: 0.7,  metalness: 0.05});
    var mNeon  = glow(THREE, NEON, 1.15);
    var mNeon2 = glow(THREE, NEON_2, 1.45);

    var root  = new THREE.Group(); root.name = "root";  o.add(root);
    var torso = new THREE.Group(); torso.name = "torso"; torso.position.set(0, HIP_Y, 0); root.add(torso);
    var head  = new THREE.Group(); head.name = "head";  head.position.set(0, 0.635, 0); torso.add(head);
    // shoulders sit wide (hero V-taper) so the arms hang clear of the ribs
    var la    = new THREE.Group(); la.name = "arm-left";  la.position.set( 0.235, 0.38, 0); torso.add(la);
    var ra    = new THREE.Group(); ra.name = "arm-right"; ra.position.set(-0.235, 0.38, 0); torso.add(ra);
    var ll    = new THREE.Group(); ll.name = "leg-left";  ll.position.set( 0.095, HIP_Y, 0); root.add(ll);
    var rl    = new THREE.Group(); rl.name = "leg-right"; rl.position.set(-0.095, HIP_Y, 0); root.add(rl);
    var le = new THREE.Group(); le.name = "elbow-left";  le.position.set( 0.30, 0, 0); la.add(le);
    var re = new THREE.Group(); re.name = "elbow-right"; re.position.set(-0.30, 0, 0); ra.add(re);
    var lw = new THREE.Group(); lw.name = "wrist-left";  lw.position.set( 0.25, 0, 0); le.add(lw);
    var rw = new THREE.Group(); rw.name = "wrist-right"; rw.position.set(-0.25, 0, 0); re.add(rw);
    var lk = new THREE.Group(); lk.name = "knee-left";  lk.position.set(0, -0.42, 0); ll.add(lk);
    var rk = new THREE.Group(); rk.name = "knee-right"; rk.position.set(0, -0.42, 0); rl.add(rk);
    var lf = new THREE.Group(); lf.name = "ankle-left";  lf.position.set(0, -0.42, 0); lk.add(lf);
    var rf = new THREE.Group(); rf.name = "ankle-right"; rf.position.set(0, -0.42, 0); rk.add(rf);

    /* ================= torso: smooth heroic taper =================
       Chest → ribs → waist → hips as one graded column. No cliff from a wide
       chest into a sudden thin waist (that read as a wasp / robot). */
    lump(THREE, torso, mSuit2, 0, 0.0, 0, 1.05, 0.85, 0.95, 0.13);         // pelvis
    lump(THREE, torso, mSuit2, 0, 0.07, 0.004, 0.98, 0.9, 0.9, 0.12);     // low waist
    lump(THREE, torso, mSuit,  0, 0.13, 0.008, 1.0, 0.95, 0.88, 0.115);   // waist (narrow, soft)
    lump(THREE, torso, mSuit,  0, 0.21, 0.012, 1.1, 1.05, 0.9, 0.125);    // ribs / upper waist
    lump(THREE, torso, mSuit,  0, 0.28, 0.012, 1.18, 1.05, 0.92, 0.135);  // lower chest
    lump(THREE, torso, mSuit,  0, 0.355, 0.01, 1.26, 0.95, 0.92, 0.135);  // upper chest (broad, not a slab)
    // pecs — soft slabs sitting on the chest, not shelves
    lump(THREE, torso, mSuit,  0.07, 0.355, 0.065, 1.15, 0.9, 0.65, 0.072);
    lump(THREE, torso, mSuit, -0.07, 0.355, 0.065, 1.15, 0.9, 0.65, 0.072);
    lump(THREE, torso, mSuit,  0.068, 0.315, 0.055, 1.05, 0.65, 0.55, 0.06);
    lump(THREE, torso, mSuit, -0.068, 0.315, 0.055, 1.05, 0.65, 0.55, 0.06);
    // lats — a gentle flare under the pec that blends into the waist
    lump(THREE, torso, mSuit2,  0.115, 0.24, -0.015, 0.65, 1.3, 0.7, 0.07);
    lump(THREE, torso, mSuit2, -0.115, 0.24, -0.015, 0.65, 1.3, 0.7, 0.07);
    // shoulders: a long slope from the neck out to the delt — never a bar
    lump(THREE, torso, mSuit,  0, 0.47, -0.01, 0.95, 0.4, 0.72, 0.055);
    [-1, 1].forEach(function(s){
      var sl = mesh(THREE, capY(THREE, 0.055, 0.13, 10), mSuit, torso, s*0.12, 0.425, -0.005);
      sl.rotation.z = s * 1.15;   // down and out
    });
    // neck: short visible human column between the chin and the collar.
    // A long capsule read as a giraffe; a stub read as no neck. This is the
    // middle: just enough for a jaw gap, then the shoulder slope takes over.
    var neck = mesh(THREE, capY(THREE, 0.04, 0.065, 14), mSuit2, torso, 0, 0.555, 0.008);
    neck.scale.set(0.95, 1, 0.9);
    // trapezius: rises to meet the neck base so the column is short
    lump(THREE, torso, mSuit,  0, 0.49, -0.012, 1.2, 0.5, 0.85, 0.038);
    lump(THREE, torso, mSuit,  0.065, 0.475, -0.01, 1.05, 0.55, 0.78, 0.034);
    lump(THREE, torso, mSuit, -0.065, 0.475, -0.01, 1.05, 0.55, 0.78, 0.034);

    /* hard pec plates + sternum + segmented abs (CHEST DESIGN) — pushed proud of
       the muscle mass and edged in neon so the design actually reads. */
    var pecGeoL = panelGeo(THREE, [[0, 0.04], [0.07, 0.048], [0.095, 0.018], [0.075, -0.018], [0.025, -0.032], [0, -0.004]], 0.012);
    var pecL = mesh(THREE, pecGeoL, mSuit3, torso, 0.012, 0.385, 0.13);
    var pecR = mesh(THREE, pecGeoL, mSuit3, torso, -0.012, 0.385, 0.13);
    pecR.scale.x = -1;
    // neon edge on each pec plate
    [-1, 1].forEach(function(s){
      var pe = mesh(THREE, capY(THREE, 0.004, 0.075, 6), mNeon, torso, s*0.055, 0.415, 0.145);
      pe.rotation.z = s * -0.85;
      var pe2 = mesh(THREE, capY(THREE, 0.004, 0.06, 6), mNeon, torso, s*0.075, 0.375, 0.145);
      pe2.rotation.z = s * 1.25;
    });
    // sternum plate
    mesh(THREE, panelGeo(THREE, [[0, 0.1], [0.016, 0.055], [0.008, 0.01], [0, -0.015], [-0.008, 0.01], [-0.016, 0.055]], 0.01),
         mSuit2, torso, 0, 0.32, 0.14);
    // segmented abs
    mesh(THREE, panelGeo(THREE, [[-0.05, 0.025], [0.05, 0.025], [0.04, -0.012], [0, -0.022], [-0.04, -0.012]], 0.01),
         mSuit2, torso, 0, 0.22, 0.115);
    mesh(THREE, panelGeo(THREE, [[-0.044, 0.012], [0.044, 0.012], [0.034, -0.02], [0, -0.028], [-0.034, -0.02]], 0.01),
         mSuit3, torso, 0, 0.16, 0.115);
    mesh(THREE, panelGeo(THREE, [[-0.036, 0.01], [0.036, 0.01], [0.028, -0.018], [0, -0.025], [-0.028, -0.018]], 0.01),
         mSuit2, torso, 0, 0.105, 0.115);
    // neon abs center line
    var absLine = mesh(THREE, capY(THREE, 0.003, 0.18, 6), mNeon, torso, 0, 0.16, 0.13);

    /* chest design: the sheet's sharp strike emblem + neon circuitry.
       Every line stays inside the pec mass — nothing may poke past the shoulder. */
    var crest = mesh(THREE, crestGeo(THREE), mNeon, torso, 0, 0.36, 0.142);
    crest.scale.set(1.35, 1.28, 1);
    // outer neon rim around the crest so it reads at chase distance
    var crestGlow = mesh(THREE, crestGeo(THREE), mNeon2, torso, 0, 0.36, 0.138);
    crestGlow.scale.set(1.48, 1.4, 0.6);
    // clavicle / rib circuitry — short ticks that stop before the deltoid
    [-1, 1].forEach(function(s){
      var cl = mesh(THREE, capY(THREE, 0.0055, 0.08, 6), mNeon, torso, s*0.055, 0.435, 0.132);
      cl.rotation.z = s * -0.7;
      var rib = mesh(THREE, capY(THREE, 0.0055, 0.17, 6), mNeon, torso, s*0.074, 0.255, 0.112);
      rib.rotation.x = 0.08;
      rib.rotation.z = -s*0.1;
      var low = mesh(THREE, capY(THREE, 0.005, 0.075, 6), mNeon, torso, s*0.05, 0.155, 0.108);
      low.rotation.z = s * 0.35;
      // forearm-style circuit branch across the ribs
      var br = mesh(THREE, capY(THREE, 0.004, 0.055, 6), mNeon, torso, s*0.095, 0.3, 0.1);
      br.rotation.z = s * 1.1;
    });
    var belt = mesh(THREE, new THREE.TorusGeometry(0.1, 0.004, 6, 20), mNeon, torso, 0, 0.045, 0);
    belt.rotation.x = Math.PI/2;
    belt.scale.set(1.05, 0.85, 1);
    // cloth at the neck base (not a hard torus "necklace" under the chin)
    lump(THREE, torso, mSuit3, 0, 0.53, 0.008, 1.05, 0.3, 0.95, 0.032);

    /* ================= head: smooth cowl mask + two big angular eyes =================
       The reference face is NOT a face with cheekbones and a nose — it is a
       smooth dark cowl with two large angular glowing lenses as the whole
       character. Adding "structure" lumps just melts into an alien blob.
       Keep it simple: one smooth head egg, a chin taper, two big lenses. */
    // skull + face as ONE smooth mass (cowl). Wider than tall, no dome.
    var cranium = lump(THREE, head, mSuit, 0, 0.012, -0.008, 1.05, 1.0, 1.05, 0.1);
    // jaw/chin taper — a single soft step down, not stacked lumps
    lump(THREE, head, mSuit,  0, -0.072, 0.028, 0.85, 0.72, 0.85, 0.072);
    lump(THREE, head, mSuit,  0, -0.118, 0.045, 0.62, 0.5, 0.62, 0.048);

    /* two BIG flat angular lenses — the face's entire character (ref sheet).
       Slant is in the geometry (temple tip high, nose tip low). Flat, no
       bevel, sharp corners. Sits proud of the cowl so they read at chase distance. */
    var eg = eyeGeo(THREE);
    var eL = mesh(THREE, eg, mNeon2, head, 0.042, 0.01, 0.092);
    eL.rotation.y = 0.16;
    eL.scale.set(1.15, 1.25, 1);
    var eR = mesh(THREE, eg, mNeon2, head, -0.042, 0.01, 0.092);
    eR.rotation.y = -0.16;
    eR.scale.set(-1.15, 1.25, 1);
    // soft glow rim under each lens (reads as lit glass on the sheet)
    lump(THREE, head, mNeon,  0.04, 0.008, 0.078, 1.4, 0.9, 0.45, 0.018);
    lump(THREE, head, mNeon, -0.04, 0.008, 0.078, 1.4, 0.9, 0.45, 0.018);

    // hood: cloth over the top and back of the cowl, open at the face — the
    // sheet's signature silhouette. A second shell gives the draped rim.
    var hood = mesh(THREE, new THREE.SphereGeometry(0.112, 24, 16, Math.PI*0.18, Math.PI*1.64, 0, Math.PI*0.62), mSuit2, head, 0, 0.02, -0.018);
    hood.scale.set(1.08, 0.95, 1.1);
    var hoodRim = mesh(THREE, new THREE.TorusGeometry(0.078, 0.012, 8, 18, Math.PI*1.15), mSuit3, head, 0, 0.02, 0.04);
    hoodRim.rotation.x = 0.55;
    hoodRim.rotation.z = Math.PI;
    hoodRim.scale.set(1.05, 0.85, 1);

    /* ================= hand (grip + flex, GLOVES crop) =================
       Fingers run along the arm axis (±X) so they hang down with the limb. */
    function buildHand(g, sign){
      var x = function(u){ return sign*u; };
      var palm = lump(THREE, g, mSuit2, x(0.028), 0, 0.005, 1.35, 0.8, 1.0, 0.03);
      [[0.02, 0.034], [0.008, 0.036], [-0.006, 0.032], [-0.018, 0.026]].forEach(function(f){
        var z = f[0], len = f[1];
        lump(THREE, g, mSuit2, x(0.058), 0.005, z, 1.0, 0.9, 0.9, 0.011);
        var tip = mesh(THREE, capY(THREE, 0.009, len*0.5, 8), mSuit2, g, x(0.058 + len*0.42), 0.01, z);
        tip.rotation.z = -sign*Math.PI/2;
        tip.rotation.y = sign*0.55;
      });
      var th = mesh(THREE, capY(THREE, 0.01, 0.022, 8), mSuit2, g, x(0.032), 0.01, sign*0.024);
      th.rotation.z = -sign*Math.PI/2;
      th.rotation.y = sign*0.8;
      th.rotation.x = 0.3;
      pipe(THREE, g, mNeon, x(0.052), 0.01, 0, 0.034, 0, Math.PI/2);
    }

    /* ================= arms (T along ±X; hang is a pose) =================
       Hero arms: big rounded delt, thick bicep + tricep, tapering forearm.
       Never a stick, never glued to the ribs. */
    function buildArm(g, e, w, sign){
      var x = function(u){ return sign*u; };
      // delt — a big rounded cap on the shoulder
      lump(THREE, g, mSuit,  x(0.02), 0, 0, 1.05, 1.15, 1.1, 0.075);
      lump(THREE, g, mSuit,  x(0.01), 0.01, 0, 0.85, 0.95, 0.95, 0.062);
      // upper arm core
      var up = mesh(THREE, capY(THREE, 0.052, 0.16, 14), mSuit, g, x(0.155), 0, 0);
      up.rotation.z = sign*Math.PI/2;
      // bicep — the front bulge (the "not muscular enough" fix)
      lump(THREE, g, mSuit,  x(0.14), 0.012, 0.018, 1.55, 1.05, 1.15, 0.055);
      lump(THREE, g, mSuit,  x(0.175), 0.01, 0.015, 1.25, 0.95, 1.05, 0.048);
      // tricep — the back mass
      lump(THREE, g, mSuit2, x(0.135), 0, -0.028, 1.45, 1.0, 1.05, 0.05);
      lump(THREE, g, mSuit2, x(0.18), 0, -0.02, 1.15, 0.9, 0.95, 0.04);
      // elbow
      lump(THREE, g, mSuit,  x(0.305), 0, 0, 1.05, 1.05, 1.05, 0.034);
      // forearm on the elbow bone — thick near the elbow, tapering to the wrist
      var fo = mesh(THREE, capY(THREE, 0.042, 0.16, 14), mSuit, e, x(0.11), 0, 0);
      fo.rotation.z = sign*Math.PI/2;
      lump(THREE, e, mSuit,  x(0.075), 0.008, 0.005, 1.35, 1.1, 1.1, 0.042);   // brachioradialis
      lump(THREE, e, mSuit,  x(0.13), 0, 0, 1.0, 0.95, 0.95, 0.034);          // mid forearm
      lump(THREE, e, mSuit2, x(0.22), 0, 0, 0.9, 0.85, 0.85, 0.028);          // wrist taper
      // gauntlet plate + piping
      mesh(THREE, panelGeo(THREE, [[-0.034, 0.02], [0.028, 0.024], [0.045, -0.012], [0, -0.034], [-0.038, -0.01]], 0.007),
           mSuit3, e, x(0.1), 0, 0.036);
      pipe(THREE, e, mNeon, x(0.11), 0, 0.034, 0.13, sign*Math.PI/2);
      pipe(THREE, g, mNeon, x(0.155), 0, 0.038, 0.14, sign*Math.PI/2);
      // delt seam
      pipe(THREE, g, mNeon, x(0.025), 0.045, 0.015, 0.05, 0, Math.PI/2);
      buildHand(w, sign);
    }
    buildArm(la, le, lw, 1);
    buildArm(ra, re, rw, -1);

    /* ================= legs + boots (BOOTS crop) =================
       Hero legs: thick thigh → knee → calf, one continuous mass. No gaps at
       the joints (each bone carries mass past its own end so the next bone
       overlaps it), no stick-thin pipes. */
    function buildBoot(f){
      mesh(THREE, capY(THREE, 0.05, 0.036, 12), mBoot, f, 0, 0.004, 0);
      lump(THREE, f, mBoot, 0, -0.034, -0.022, 1.15, 0.95, 1.15, 0.042);  // heel
      lump(THREE, f, mBoot, 0, -0.042, 0.02, 1.15, 0.75, 1.45, 0.046);   // midsole
      lump(THREE, f, mBoot, 0, -0.038, 0.085, 1.05, 0.75, 1.35, 0.04);   // toe
      // ankle bone mass — closes the shin/foot gap
      lump(THREE, f, mBoot, 0, 0.03, 0, 1.05, 1.15, 1.05, 0.042);
      var sole = mesh(THREE, capY(THREE, 0.007, 0.115, 8), mNeon, f, 0, -0.06, 0.035);
      sole.rotation.x = Math.PI/2;
      sole.scale.set(1.25, 1, 1);
      pipe(THREE, f, mNeon, 0, 0, 0.036, 0.06, 0, 0);
    }
    function buildLeg(g, k, f){
      // ---- thigh: one thick mass from hip to knee (hero legs, not pipes) ----
      lump(THREE, g, mSuit2, 0, -0.02, 0, 1.25, 1.05, 1.15, 0.098);        // hip/glute tie-in
      var th = mesh(THREE, capY(THREE, 0.088, 0.26, 16), mSuit, g, 0, -0.2, 0);
      th.scale.set(1.12, 1, 1.02);
      lump(THREE, g, mSuit,  0, -0.16, 0.03, 1.35, 1.55, 1.05, 0.078);    // quad (front)
      lump(THREE, g, mSuit,  0, -0.08, 0.024, 1.25, 1.15, 1.0, 0.072);   // upper quad
      lump(THREE, g, mSuit2, 0, -0.18, -0.032, 1.25, 1.45, 0.95, 0.07); // hamstring (back)
      lump(THREE, g, mSuit,  0.045, -0.14, 0.01, 1.05, 1.3, 1.0, 0.058); // vastus lateralis
      lump(THREE, g, mSuit,  0, -0.3, 0.012, 1.2, 1.15, 1.15, 0.062);   // lower quad sweep
      lump(THREE, g, mSuit,  0, -0.38, 0.008, 1.15, 1.0, 1.1, 0.055);   // vastus (above knee)
      // knee cap mass — must reach past the knee bone so the shin overlaps it
      lump(THREE, g, mSuit,  0, -0.425, 0.012, 1.15, 1.05, 1.15, 0.052);
      lump(THREE, g, mSuit2, 0, -0.425, -0.018, 1.1, 1.0, 1.05, 0.046);  // back of knee
      // thigh plate + neon stripe
      mesh(THREE, panelGeo(THREE, [[-0.052, 0.08], [0.052, 0.08], [0.058, 0.012], [0.022, -0.075], [-0.022, -0.075], [-0.058, 0.012]], 0.01),
           mSuit3, g, 0, -0.15, 0.058);
      pipe(THREE, g, mNeon, 0.028, -0.17, 0.062, 0.18, 0, -0.12);

      // ---- shin on the knee bone: calf mass starts above the knee (overlap) ----
      var sh = mesh(THREE, capY(THREE, 0.062, 0.24, 16), mSuit, k, 0, -0.16, 0);
      sh.scale.set(1.05, 1, 1.0);
      lump(THREE, k, mSuit,  0, 0.02, 0.008, 1.15, 1.15, 1.1, 0.058);    // knee overlap mass
      lump(THREE, k, mSuit,  0, -0.08, -0.028, 1.2, 1.55, 0.95, 0.062); // calf (back bulge)
      lump(THREE, k, mSuit,  0, -0.16, -0.012, 1.1, 1.3, 1.0, 0.055);   // mid calf
      lump(THREE, k, mSuit2, 0, -0.22, 0.012, 1.0, 1.15, 1.0, 0.048);   // shin (front)
      lump(THREE, k, mSuit,  0, -0.32, 0.005, 0.95, 1.0, 1.0, 0.045);   // lower calf taper
      lump(THREE, k, mSuit2, 0, -0.385, 0.005, 1.05, 1.15, 1.05, 0.042); // ankle mass (overlaps boot)
      mesh(THREE, panelGeo(THREE, [[-0.042, 0.095], [0.042, 0.095], [0.032, 0.012], [0, -0.09], [-0.032, 0.012]], 0.01),
           mSuit3, k, 0, -0.18, 0.042);
      pipe(THREE, k, mNeon, 0.018, -0.17, 0.055, 0.14, 0, 0);
      pipe(THREE, g, mNeon, 0, -0.19, 0.052, 0.18, 0, 0);
      buildBoot(f);
    }
    buildLeg(ll, lk, lf);
    buildLeg(rl, rk, rf);

    o.traverse(function(n){ if(n.isMesh){ n.castShadow = true; n.frustumCulled = false; } });

    var acts = {idle: act("idle", 4), walk: act("walk", 1), sprint: act("sprint", 0.7), sit: act("sit", 1)};
    var ch = {
      o: o,
      mixer: {
        update: function(dt){
          dt = dt || 0;
          ["idle", "walk", "sprint", "sit"].forEach(function(n){
            var a = acts[n]; if(a) a.time += dt*(a.timeScale || 1);
          });
        }
      },
      acts: acts,
      cur: null,
      // slightly larger than the Kenney crew so the hero reads as the player
      base: 1.12,
      hip: [0, HIP_Y, 0],
      legRest: [0, -0.55, 0.03],
      _ph: 0,
      _t: null,
      // this body owns its full pose (gait + idle + sit); city skate offsets would fight it
      _pb: false,
      // and it owns its own forward bend (at the waist). leanStep's model pitch
      // would tip the WHOLE body at the feet and sink it into the ground; only
      // the bank into turns is still the city's to give.
      ownLean: true,
      _bones: {r: root, t: torso, h: head, la: la, ra: ra, ll: ll, rl: rl,
               le: le, re: re, lw: lw, rw: rw, lk: lk, rk: rk, lf: lf, rf: rf},
      // rest pose is T (arms along ±X) so city seating can still aim the bones
      // (aimBone(..., "x")); poseHero hangs the arms for idle / gait.
      _tRest: (function(){
        la.rotation.set(0, 0, 0);
        ra.rotation.set(0, 0, 0);
        return true;
      })(),
      // city seating aims the limb bones; rest reaches are ours (T along ±X / down)
      _rig: {
        root: root, t: torso, h: head, la: la, ra: ra, ll: ll, rl: rl,
        lav: new THREE.Vector3(0.55, 0, 0),
        rav: new THREE.Vector3(-0.55, 0, 0),
        legv: new THREE.Vector3(0, -0.55, 0.03)
      },
      update: function(t){ poseHero(ch, t); }
    };
    poseHero(ch, 0);
    return ch;
  });
}

HQV.skystrike = {
  COMMONS: commonsId,
  NEON: NEON,
  SUIT: SUIT,
  arm: arm,
  wanted: wanted,
  build: build,
  tightenCam: tightenCam,
  untightenCam: untightenCam,
  camAir: camAir,
  tallTop: tallTop,
  myTop: myTop,
  onDeckSpot: onDeckSpot,
  airPose: airPose,
  airFrame: airFrame,
  jumpImpulse: jumpImpulse,
  jumpKick: jumpKick,
  launchBlend: launchBlend,
  diveBlend: diveBlend,
  wantDive: wantDive,
  swingStep: swingStep,
  webPoints: webPoints,
  makeWeb: makeWeb,
  webAims: webAims,
  zipAims: zipAims,
  zipHit: zipHit,
  startZip: startZip,
  zipStep: zipStep,
  handOf: handOf,
  segAABB: segAABB,
  rayBoxes: rayBoxes,
  sweepBoxes: sweepBoxes,
  bodyBlock: bodyBlock,
  wallStep: wallStep,
  faceNormalAt: faceNormalAt,
  holdGap: holdGap,
  facePlaneOf: facePlaneOf,
  isWallMass: isWallMass,
  isPaperPane: isPaperPane,
  roofRest: roofRest,
  wallFromInput: wallFromInput,
  nearFaceGrip: nearFaceGrip,
  contactFaceGrip: contactFaceGrip,
  // pure gait surface (tests run these; a substring check cannot catch a ReferenceError)
  pure: {
    keyAt: keyAt, gaitPose: gaitPose, poseHero: poseHero, armQ: armQ, elbQ: elbQ,
    tallTop: tallTop,
    myTop: myTop,
    onDeckSpot: onDeckSpot,
    airPose: airPose,
    airFrame: airFrame,
    jumpImpulse: jumpImpulse,
    jumpKick: jumpKick,
    launchBlend: launchBlend,
    diveBlend: diveBlend,
    wantDive: wantDive,
    swingStep: swingStep,
    webPoints: webPoints,
    makeWeb: makeWeb,
    webAims: webAims,
    zipAims: zipAims,
    zipHit: zipHit,
    startZip: startZip,
    zipStep: zipStep,
    handOf: handOf,
    segAABB: segAABB,
    rayBoxes: rayBoxes,
    sweepBoxes: sweepBoxes,
    bodyBlock: bodyBlock,
    wallStep: wallStep,
    faceNormalAt: faceNormalAt,
    holdGap: holdGap,
    facePlaneOf: facePlaneOf,
    isWallMass: isWallMass,
    isPaperPane: isPaperPane,
    roofRest: roofRest,
    wallFromInput: wallFromInput,
    contactFaceGrip: contactFaceGrip,
    nearFaceGrip: nearFaceGrip,
    camAir: camAir,
    RUN_HIP: RUN_HIP, RUN_KNEE: RUN_KNEE, RUN_ANKLE: RUN_ANKLE, HIP_Y: HIP_Y
  }
};
})();

/* ---------- Valley: open The Commons as SkyStrike ---------- */
(function(){
"use strict";
var HQV = window.HQV = window.HQV || {};
if(!HQV.register) return;

var CUR = null;

function skyApi(){
  var base = {};
  try { if(typeof window.hqApi === "function") base = window.hqApi() || {}; } catch(e){ base = {}; }
  var api = {};
  Object.keys(base).forEach(function(k){ api[k] = base[k]; });
  api.name = "SkyStrike";
  api.character = function(){ return null; };
  api.startWorld = "city";
  api.outside = function(){ return "city"; };
  api.remember = false;
  api.skateCombo = function(){};
  api.onWorld = api.onWorld || function(){};
  api.openSession = api.openSession || function(){};
  api.go = api.go || function(){};
  api.onFilter = api.onFilter || function(){};
  api.level = api.level || function(){ return 1; };
  api.look = api.look || function(){ return {}; };
  api.city = api.city || function(){ return []; };
  api.me = api.me || function(){ return null; };
  api.announce = api.announce || function(){};
  api.netCan = api.netCan || function(){ return false; };
  // air: double jump, dive, web-swing. hq3d hands us the state + the world each
  // frame while the body is off the ground (or on a line) and writes it back.
  api.air = function(st, env, dt){
    var f = HQV.skystrike && HQV.skystrike.airFrame;
    return typeof f === "function" ? f(st, env, dt) : null;
  };
  return api;
}

function loadHq(){
  if(window.HQ3D && HQ3D.load) return HQ3D.load;
  if(typeof window.hqLoadScripts === "function") return window.hqLoadScripts();
  return Promise.reject(new Error("the 3D city scripts are not on this page"));
}

/* The live Commons, from the other IIFE's commonsId(). Resolved per open: the
   HQ scripts only now exist, so the id is the live one (claude-hq@3) and not
   the fallback that a Valley-load-time read would have frozen. */
function skyCommons(){
  try {
    if(HQV.skystrike && typeof HQV.skystrike.COMMONS === "function") return HQV.skystrike.COMMONS();
    if(HQV.skystrike && typeof HQV.skystrike.COMMONS === "string" && HQV.skystrike.COMMONS) return HQV.skystrike.COMMONS;
  } catch(e){}
  return "claude-hq@3";
}

function chrome(off){
  var d = document.documentElement;
  if(!d) return;
  if(off) d.classList.add("vg-sky-plain");
  else d.classList.remove("vg-sky-plain");
}

function mount(el, api){
  if(CUR) { try { CUR.destroy(); } catch(e){} CUR = null; }
  if(HQV.skystrike) HQV.skystrike.arm(true);
  if(window.HQ3D && HQ3D.inst){ try { HQ3D.inst.pause(); } catch(e){} }
  chrome(true);

  var stage = api.mk("div", "vg-sky-stage");
  stage.setAttribute("role", "region");
  stage.setAttribute("aria-label", "SkyStrike in the Commons");
  el.appendChild(stage);
  var note = api.mk("p", "vg-sky-note", "The Commons as SkyStrike. Traversal and acrobatics land next.");
  el.appendChild(note);

  var dead = false, inst = null, prev = (window.HQ3D && HQ3D.inst) || null, wantTop = true, spawning = false;
  function destroy(){
    if(dead) return;
    dead = true;
    wantTop = false; spawning = false;
    chrome(false);
    if(HQV.skystrike) HQV.skystrike.arm(false);
    if(inst){ try { inst.destroy(); } catch(e){} inst = null; }
    if(prev){ try { prev.resume(); } catch(e){} }
    CUR = null;
  }
  CUR = {
    destroy: destroy,
    pause: function(){ if(inst){ try { inst.pause(); } catch(e){} } },
    resume: function(){ if(inst){ try { inst.resume(); } catch(e){} } }
  };

  /* Put the hero on top of YOUR HQ. Called from hq.onWorld("city") — after enterWorld
     has placed him on the street — so the teleport is never overwritten by the city's
     own spawn.

     Two things have to land before the roof exists:
       1. the Arena's open-HQ list. 22-hq.js only polls it in the HQ view, so this
          mount pumps it itself (hqCityLoad) and rebuilds OUR street when it changes
          (inst.cityChanged — the page's call goes to HQ3D.inst, the HQ view's, not
          this Valley one).
       2. a stable list. An empty list builds no roofs; teleporting on that and then
          letting the real list rebuild the street yanks the hero off the roof again.
     So: wait for the list to hold still for a couple of ticks with a roof on it,
     then go up EXACTLY ONCE. He is never touched again — no watching, no re-teleport
     while he stands near the spot. That loop is what kept yanking him back to the
     spawn every time he took a step on the deck. */
  var listSig = null, listHold = 0;
  function citySig(){
    var list = [], sig = null;
    try { list = (hq.city && hq.city()) || []; } catch(e){ list = []; }
    try { sig = JSON.stringify(list.map(function(h){ return [h && h.userId, !!(h && h.isYou)]; })); } catch(e){ sig = null; }
    return sig;
  }
  function pumpCity(){
    if(dead) return;
    try { if(typeof hqCityLoad === "function") hqCityLoad(true); } catch(e){}
  }
  function spawnOnTop(){
    if(dead || !inst || !inst.teleport || spawning || !wantTop) return;
    spawning = true;
    var tries = 0;
    (function go(){
      if(dead || !inst){ spawning = false; return; }
      // the open-HQ list: pull it, and rebuild our street when it changes
      var sig = citySig();
      if(sig !== listSig){
        listSig = sig; listHold = 0;
        try { if(inst.cityChanged) inst.cityChanged(); } catch(e){}
      } else if(listHold < 4){ listHold++; }

      var roofs = null;
      try { roofs = inst.roofs ? inst.roofs() : null; } catch(e){ roofs = null; }
      // your own HQ first (myTop), else the tallest tower
      var pick = (HQV.skystrike && (HQV.skystrike.myTop || HQV.skystrike.tallTop)) || null;
      var top = pick ? pick(roofs) : null;

      // only after the list has held still for two ticks — a rebuild under us yanks us off
      if(top && isFinite(top.y) && listHold >= 2){
        try { inst.teleport(top.x, top.z, top.yaw || 0, top.y); } catch(e){}
        wantTop = false; spawning = false;
        return;                                   // once. he is yours now.
      }
      if(tries === 0 || tries % 8 === 0) pumpCity();
      if(++tries < 240) setTimeout(go, 250);      // up to a minute, then leave the street spawn
      else spawning = false;
    })();
  }

  // the HQ 3D api (not the Valley api parameter: that one is the game host's)
  var hq = skyApi();
  // The city has just placed the hero (enterWorld's go() runs this after its street
  // spawn): put him on the tower. Re-armed each time — a later re-entry into the City
  // places him on the street again and he goes back up — but only ever one teleport
  // per placement. Nothing watches him afterwards; that is what yanked him back.
  var prevOnWorld = hq.onWorld;
  hq.onWorld = function(name){
    try { prevOnWorld(name); } catch(e){}
    if(String(name) === "city"){ wantTop = true; spawnOnTop(); }
  };

  loadHq().then(function(){
    if(dead) return;
    if(HQV.skystrike && HQV.skystrike.tightenCam) HQV.skystrike.tightenCam();   // camrig only exists once the HQ scripts have loaded
    // the live Commons (claude-hq@3: the HQ towers and Skyline Park), resolved
    // now that the HQ scripts are loaded — never at Valley-load time
    if(HQV.hqCity3d && HQV.hqCity3d.go) HQV.hqCity3d.go(skyCommons(), null);
    if(!HQV.hq3d || !HQV.hq3d.mount) throw new Error("the 3D city could not start");
    inst = HQV.hq3d.mount(stage, hq);
    // hqEnter() does this after mount; without it the frame loop never starts on the
    // first open (a black canvas until something else calls resume — e.g. re-entering Valley).
    // If three.js is still loading, resume() parks inst.wantRun and the init path starts it.
    if(inst && inst.resume){ try { inst.resume(); } catch(e){} }
    // The city is already on its way: mount's startWorld ("city") entered it, with the
    // world id just set above. Do NOT call goCity again — it tears that city down and
    // builds another, and the street spawn of the second one lands on top of any roof
    // teleport the first one's onWorld just made.
    pumpCity();
  }).catch(function(e){
    if(dead) return;
    note.textContent = "SkyStrike could not open the Commons: " + ((e && e.message) || e);
  });
}

HQV.register({
  id: "skystrike",
  name: "SkyStrike",
  icon: "⚡",
  desc: "Open the Commons as SkyStrike — agile, sharp, unstoppable",
  mount: mount,
  unmount: function(){ if(CUR){ try { CUR.destroy(); } catch(e){} CUR = null; } },
  pause: function(){ if(CUR && CUR.pause) CUR.pause(); },
  resume: function(){ if(CUR && CUR.resume) CUR.resume(); }
});
})();
