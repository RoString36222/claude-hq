/* Claude HQ: the route in 3D (HQV.hqroutefx, spec nav-river "Client: the route in 3D").
 *
 *   create(c, scene) -> fx          c: the hq3d ctx (THREE, ...); everything is added to `scene`
 *     fx.setRoute(pts|null, groundY(x, z))   pts: Float64Array [x0, z0, x1, z1, ...] (m), as
 *                                   HQV.hqnav.route gives it; groundY: the road surface height (m)
 *     fx.setWaypoint({x, y, z}|null)         a light pillar standing at the destination
 *     fx.update(dt, player {x, z}, cam)      chevrons from you to 250 m ahead, flowing forward; the
 *                                   pillar widens with distance from cam (a camera, or {x, y, z}) so
 *                                   it still reads from across the city
 *     fx.state() -> {count, phase, along, pillar}   for tests and the debug probe
 *     fx.dispose()                  removes both meshes and frees their geometry and materials
 * Chevrons: one InstancedMesh, one every SPACING m along the route, lifted LIFT m over the road and
 * tilted with it, depth-tested, the brand colour, unlit and additive (an instance's colour is its
 * glow, so black is invisible: that is how they fade in far ahead and out as you reach them).
 * The pillar: one open cylinder, additive, its vertex colours fading to nothing at the top. Two
 * draw calls in all. The flow is a phase that is a function of the time added up (FLOW m/s, mod
 * SPACING) and the pillar's pulse a function of that same clock, so 30 Hz and 144 Hz agree.
 * Where you are on the route is tracked, not searched afresh: after the first frame only the stretch
 * from BACK m behind to SEEK m ahead of the last fix is searched, so on a route that doubles back on a
 * nearby street a little sideways drift cannot snap the window onto the later leg (and, as nav's
 * progress(), it never jumps back more than BACK m). Only when you are over LOST m from that stretch
 * (a teleport, a long frame) is the whole route searched again.
 * Frames as the 3D city's: metres, y up, yaw 0 faces +z.
 */
(function(){
"use strict";
var HQV = window.HQV = window.HQV || {};

var SPACING = 4, LIFT = 0.06, AHEAD = 250, FLOW = 3;          // m, m, m, m/s
var NEAR_FADE = 8, FAR_FADE = 60;                               // m over which a chevron fades in/out
var BACK = 15, SEEK = 60, LOST = 25;                            // m: the tracked search stretch, and when to give up on it
var MAX = Math.ceil(AHEAD/SPACING) + 1;                         // instances ever shown at once
var PILLAR_H = 160, PILLAR_R = 1.4, PILLAR_SEEN = 220;          // m; past PILLAR_SEEN it widens with distance
var BRAND = "#7c6cf0";                                          // the --brand fallback (avatar3d.js)

function smooth(e0, e1, x){ var t = Math.max(0, Math.min(1, (x - e0)/(e1 - e0))); return t*t*(3 - 2*t); }

// The brand colour: the ctx's, else the page's --brand, else the default.
function brandColor(THREE, c){
  var col = new THREE.Color(BRAND);
  if(c && c.brand != null){ col.set(c.brand); return col; }
  try {
    var v = (getComputedStyle(document.documentElement).getPropertyValue("--brand") || "").trim();
    if(v) col.setStyle(v);
  } catch(e){ /* no DOM (node) */ }
  return col;
}

// A flat chevron in the xz plane pointing +z: two arms meeting at the tip, 1.6 m wide, 0.8 m deep.
function chevronGeometry(THREE){
  var W = 0.8, T = 0.45, B = -0.35, K = 0.38;                  // half width, tip z, arm-end z, stroke
  var p = [ -W, B, 0, T, 0, T - K, -W, B - K,                   // left arm: outer end, tip, inner tip, inner end
             W, B, 0, T, 0, T - K,  W, B - K ];                 // right arm
  var pos = new Float32Array(8*3), nor = new Float32Array(8*3);
  for(var i = 0; i < 8; i++){ pos[i*3] = p[i*2]; pos[i*3 + 2] = p[i*2 + 1]; nor[i*3 + 1] = 1; }
  var g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
  g.setIndex([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7]);
  return g;
}

// The pillar: an open cylinder standing on y = 0, bright at the foot and gone at the top.
function pillarGeometry(THREE, col){
  var g = new THREE.CylinderGeometry(PILLAR_R, PILLAR_R, PILLAR_H, 18, 6, true);
  g.translate(0, PILLAR_H/2, 0);
  var pos = g.getAttribute("position"), n = pos.count, cols = new Float32Array(n*3);
  for(var i = 0; i < n; i++){
    var f = Math.pow(1 - pos.getY(i)/PILLAR_H, 1.6);
    cols[i*3] = col.r*f; cols[i*3 + 1] = col.g*f; cols[i*3 + 2] = col.b*f;
  }
  g.setAttribute("color", new THREE.BufferAttribute(cols, 3));
  return g;
}

function create(c, scene){
  var THREE = c.THREE, brand = brandColor(THREE, c);
  var chevMat = new THREE.MeshBasicMaterial({color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending,
    depthTest: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false});
  var chev = new THREE.InstancedMesh(chevronGeometry(THREE), chevMat, MAX);
  chev.name = "routefx:chevrons"; chev.count = 0; chev.frustumCulled = false; chev.renderOrder = 2;
  chev.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  chev.setColorAt(0, brand);                                    // creates instanceColor
  chev.visible = false;
  var pillMat = new THREE.MeshBasicMaterial({color: 0xffffff, vertexColors: true, transparent: true, opacity: 0.85,
    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false, toneMapped: false});
  var pillar = new THREE.Mesh(pillarGeometry(THREE, brand), pillMat);
  pillar.name = "routefx:pillar"; pillar.visible = false; pillar.renderOrder = 2;
  scene.add(chev); scene.add(pillar);

  var pts = null, cum = null, len = 0, ground = function(){ return 0; };
  var clock = 0, along = 0, tracked = false, dead = false;
  var m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(0, 0, 0, "YXZ"),
      v = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1), tint = new THREE.Color();

  // The point s m along the route, with the segment it lies on.
  var at = {x: 0, z: 0, i: 0};
  function pointAt(s){
    var n = cum.length, lo = 0, hi = n - 1;
    while(hi - lo > 1){ var mid = (lo + hi) >> 1; if(cum[mid] <= s) lo = mid; else hi = mid; }
    var seg = cum[hi] - cum[lo], t = seg > 0 ? (s - cum[lo])/seg : 0;
    at.x = pts[lo*2] + (pts[hi*2] - pts[lo*2])*t; at.z = pts[lo*2 + 1] + (pts[hi*2 + 1] - pts[lo*2 + 1])*t; at.i = lo;
    return at;
  }
  // m along the route nearest (x, z), looking only between lo and hi m along; near.d is how far off (m).
  var near = {s: 0, d: Infinity};
  function nearest(x, z, lo, hi){
    near.s = 0; near.d = Infinity;
    for(var i = 0; i + 1 < cum.length; i++){
      if(cum[i + 1] < lo || cum[i] > hi) continue;
      var ax = pts[i*2], az = pts[i*2 + 1], dx = pts[i*2 + 2] - ax, dz = pts[i*2 + 3] - az, l = cum[i + 1] - cum[i];
      var t0 = Math.max(0, (lo - cum[i])/l), t1 = Math.min(1, (hi - cum[i])/l);   // segments are never 0 m (setRoute)
      var t = Math.max(t0, Math.min(t1, ((x - ax)*dx + (z - az)*dz)/(l*l)));
      var px = ax + dx*t - x, pz = az + dz*t - z, d = Math.hypot(px, pz);
      if(d < near.d){ near.d = d; near.s = cum[i] + l*t; }
    }
    return near;
  }
  // Where you are along the route: tracked from the last fix, the whole route on the first frame or once lost.
  function track(x, z){
    if(tracked && nearest(x, z, along - BACK, along + SEEK).d <= LOST) return near.s;
    tracked = true;
    return nearest(x, z, 0, len).s;
  }

  function setRoute(p, groundY){
    ground = typeof groundY === "function" ? groundY : function(){ return 0; };
    pts = null; cum = null; len = 0; along = 0; tracked = false;
    var n = p ? (p.length >> 1) : 0;
    if(n >= 2){
      // Repeated points are dropped (a 0 m end leg, say): a 0 m segment has no direction to point along.
      var keep = [p[0], p[1]];
      for(var j = 1; j < n; j++){
        var lx = keep[keep.length - 2], lz = keep[keep.length - 1];
        if(Math.hypot(p[j*2] - lx, p[j*2 + 1] - lz) > 1e-6) keep.push(p[j*2], p[j*2 + 1]);
      }
      n = keep.length >> 1;
      pts = Float64Array.from(keep); cum = new Float64Array(n);
      for(var i = 1; i < n; i++) cum[i] = cum[i - 1] + Math.hypot(pts[i*2] - pts[i*2 - 2], pts[i*2 + 1] - pts[i*2 - 1]);
      len = cum[n - 1];
    }
    if(!pts || len <= 0){ pts = null; cum = null; len = 0; }
    chev.count = 0; chev.visible = false;
  }

  function setWaypoint(w){
    if(!w){ pillar.visible = false; return; }
    pillar.position.set(+w.x || 0, +w.y || 0, +w.z || 0);
    pillar.visible = true;
  }

  function update(dt, player, cam){
    if(dead) return;
    clock += Math.max(0, +dt || 0);
    var phase = (clock*FLOW) % SPACING;
    if(pts && player){
      along = track(+player.x || 0, +player.z || 0);
      var end = Math.min(len, along + AHEAD), k = Math.ceil((along - phase)/SPACING), n = 0;
      for(var s = k*SPACING + phase; s <= end && n < MAX; s += SPACING){
        var a = pointAt(s), x = a.x, z = a.z, i = a.i;
        var dx = pts[i*2 + 2] - pts[i*2], dz = pts[i*2 + 3] - pts[i*2 + 1], dl = Math.hypot(dx, dz) || 1;
        var y = ground(x, z), ux = dx/dl, uz = dz/dl;
        var rise = ground(x + ux, z + uz) - ground(x - ux, z - uz);   // over 2 m: the road's slope
        e.set(-Math.atan2(rise, 2), Math.atan2(dx, dz), 0);
        q.setFromEuler(e);
        v.set(x, y + LIFT, z);
        m4.compose(v, q, one);
        chev.setMatrixAt(n, m4);
        var d = s - along, f = smooth(0, NEAR_FADE, d)*(1 - smooth(AHEAD - FAR_FADE, AHEAD, d));
        chev.setColorAt(n, tint.copy(brand).multiplyScalar(f));
        n++;
      }
      chev.count = n; chev.visible = n > 0;
      chev.instanceMatrix.needsUpdate = true;
      if(chev.instanceColor) chev.instanceColor.needsUpdate = true;
    } else { chev.count = 0; chev.visible = false; }
    if(pillar.visible){
      var cp = cam && (cam.position || cam), w = 1;
      if(cp) w = Math.max(1, Math.hypot((+cp.x || 0) - pillar.position.x, (+cp.z || 0) - pillar.position.z)/PILLAR_SEEN);
      pillar.scale.set(w, 1, w);
      pillMat.opacity = 0.75 + 0.15*Math.sin(clock*2.4);
    }
  }

  function state(){ return {count: chev.count, phase: (clock*FLOW) % SPACING, along: along, pillar: pillar.visible}; }

  function dispose(){
    if(dead) return;
    dead = true;
    if(chev.parent) chev.parent.remove(chev);
    if(pillar.parent) pillar.parent.remove(pillar);
    chev.geometry.dispose(); chevMat.dispose(); chev.dispose();
    pillar.geometry.dispose(); pillMat.dispose();
    pts = null; cum = null;
  }

  return {setRoute: setRoute, setWaypoint: setWaypoint, update: update, state: state, dispose: dispose,
          chevrons: chev, pillar: pillar};
}

HQV.hqroutefx = {create: create, SPACING: SPACING, LIFT: LIFT, AHEAD: AHEAD, FLOW: FLOW, MAX: MAX};
})();
