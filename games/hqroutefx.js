/* Claude HQ: the route in 3D (HQV.hqroutefx, spec nav-river "Client: the route in 3D").
 *
 *   create(c, scene) -> fx          c: the hq3d ctx (THREE, ...); everything is added to `scene`
 *     fx.setRoute(pts|null, groundY(x, z))   pts: Float64Array [x0, z0, x1, z1, ...] (m), as
 *                                   HQV.hqnav.route gives it; groundY: the road surface height (m)
 *     fx.setWaypoint({x, y, z}|null)         a light pillar standing at the destination
 *     fx.update(dt, player {x, z}, cam)      chevrons from you to 250 m ahead, flowing forward; the
 *                                   pillar widens with distance from cam (a camera, or {x, y, z}) so
 *                                   it still reads from across the city; on the map (cam.mode "map")
 *                                   the whole route is a line instead, as wide as the view needs
 *     fx.state() -> {count, phase, along, pillar, line}   for tests and the debug probe
 *     fx.dispose()                  removes the meshes and frees their geometry and materials
 * Chevrons: one InstancedMesh, one every SPACING m along the route, CHEV_W m wide, lifted LIFT m over
 * the road (over its lane marks, polygon offset on top) and tilted with it, depth-tested, opaque-ish
 * in the brand colour, unlit. They fade in far ahead and out as you reach them by scale (a chevron
 * grows from nothing), so they read on dark asphalt and on a light plaza alike.
 * The pillar: one open cylinder, additive, its vertex colours fading to nothing at the top, with a
 * disc at its foot so it is a pin from straight above. The route line (map only): one ribbon mesh over
 * the whole route, drawn over everything. Three draw calls at most. The flow is a phase that is a
 * function of the time added up (FLOW m/s, mod SPACING) and the pillar's pulse a function of that same
 * clock, so 30 Hz and 144 Hz agree.
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

var SPACING = 4, LIFT = 0.12, AHEAD = 250, FLOW = 3;          // m, m, m, m/s
var CHEV_W = 3;                                                 // m: a chevron's width (a lane's)
var NEAR_FADE = 8, FAR_FADE = 60;                               // m over which a chevron fades in/out
var BACK = 15, SEEK = 60, LOST = 25;                            // m: the tracked search stretch, and when to give up on it
var MAX = Math.ceil(AHEAD/SPACING) + 1;                         // instances ever shown at once
var PILLAR_H = 160, PILLAR_R = 1.4, PILLAR_SEEN = 220;          // m; past PILLAR_SEEN it widens with distance
var DISC_R = 2.6;                                               // m: the pin disc at the pillar's foot
var LINE_FRAC = 0.012, LINE_LIFT = 0.5, LINE_STEP = 1.25;       // map line: width as a share of the view's
                                                                // height, m over the ground, rebuild ratio
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

// A flat chevron in the xz plane pointing +z: two arms meeting at the tip, CHEV_W wide, half that deep.
function chevronGeometry(THREE){
  var W = CHEV_W/2, T = 0.85, B = -0.65, K = 0.7;              // half width, tip z, arm-end z, stroke
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

// The pillar: an open cylinder standing on y = 0, bright at the foot and gone at the top, and a disc on
// the ground round its foot (full colour) so that from straight above it is a pin, not a thin ring.
function pillarGeometry(THREE, col){
  var cyl = new THREE.CylinderGeometry(PILLAR_R, PILLAR_R, PILLAR_H, 18, 6, true);
  cyl.translate(0, PILLAR_H/2, 0);
  var cp = cyl.getAttribute("position"), ci = cyl.getIndex(), nc = cp.count, SEG = 24;
  var pos = new Float32Array((nc + SEG + 1)*3), cols = new Float32Array((nc + SEG + 1)*3), idx = [];
  for(var i = 0; i < nc; i++){
    var f = Math.pow(1 - cp.getY(i)/PILLAR_H, 1.6);
    pos[i*3] = cp.getX(i); pos[i*3 + 1] = cp.getY(i); pos[i*3 + 2] = cp.getZ(i);
    cols[i*3] = col.r*f; cols[i*3 + 1] = col.g*f; cols[i*3 + 2] = col.b*f;
  }
  for(i = 0; i < ci.count; i++) idx.push(ci.getX(i));
  for(i = 0; i <= SEG; i++){                                    // the disc: a fan, centre last
    var k = nc + i, a = i/SEG*Math.PI*2, r = i < SEG ? DISC_R : 0;
    pos[k*3] = i < SEG ? Math.sin(a)*r : 0; pos[k*3 + 1] = 0.08; pos[k*3 + 2] = i < SEG ? Math.cos(a)*r : 0;
    cols[k*3] = col.r; cols[k*3 + 1] = col.g; cols[k*3 + 2] = col.b;
  }
  for(i = 0; i < SEG; i++) idx.push(nc + SEG, nc + i, nc + (i + 1) % SEG);
  cyl.dispose();
  var g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.BufferAttribute(cols, 3));
  g.setIndex(idx);
  return g;
}

// The route line for the map: a flat ribbon w m wide along pts (m), y from ground + LINE_LIFT, mitred at
// the corners (the mitre capped at 2 widths so a hairpin does not spike).
function lineGeometry(THREE, pts, ground, w){
  var n = pts.length >> 1, pos = new Float32Array(n*2*3), idx = [], h = w/2;
  for(var i = 0; i < n; i++){
    var x = pts[i*2], z = pts[i*2 + 1], a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
    var ux = pts[i*2] - pts[a*2], uz = pts[i*2 + 1] - pts[a*2 + 1], vx = pts[b*2] - pts[i*2], vz = pts[b*2 + 1] - pts[i*2 + 1];
    var ul = Math.hypot(ux, uz) || 1, vl = Math.hypot(vx, vz) || 1;
    if(i === 0){ ux = vx; uz = vz; ul = vl; }
    if(i === n - 1){ vx = ux; vz = uz; vl = ul; }
    var nx = uz/ul + vz/vl, nz = -ux/ul - vx/vl, nl = Math.hypot(nx, nz);
    if(nl < 1e-9){ nx = uz/ul; nz = -ux/ul; nl = 1; }
    nx /= nl; nz /= nl;
    var m = Math.min(2, 1/Math.max(0.5, nx*uz/ul - nz*ux/ul)), y = ground(x, z) + LINE_LIFT;
    pos[i*6] = x + nx*h*m; pos[i*6 + 1] = y; pos[i*6 + 2] = z + nz*h*m;
    pos[i*6 + 3] = x - nx*h*m; pos[i*6 + 4] = y; pos[i*6 + 5] = z - nz*h*m;
    if(i) idx.push(i*2 - 2, i*2 - 1, i*2, i*2, i*2 - 1, i*2 + 1);
  }
  var g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}

function create(c, scene){
  var THREE = c.THREE, brand = brandColor(THREE, c);
  var chevMat = new THREE.MeshBasicMaterial({color: 0xffffff, transparent: true, opacity: 0.92,
    depthTest: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4});
  var chev = new THREE.InstancedMesh(chevronGeometry(THREE), chevMat, MAX);
  chev.name = "routefx:chevrons"; chev.count = 0; chev.frustumCulled = false; chev.renderOrder = 2;
  chev.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  chev.setColorAt(0, brand);                                    // creates instanceColor
  chev.visible = false;
  var pillMat = new THREE.MeshBasicMaterial({color: 0xffffff, vertexColors: true, transparent: true, opacity: 0.85,
    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false, toneMapped: false});
  var pillar = new THREE.Mesh(pillarGeometry(THREE, brand), pillMat);
  pillar.name = "routefx:pillar"; pillar.visible = false; pillar.renderOrder = 2;
  var lineMat = new THREE.MeshBasicMaterial({color: brand.clone(), transparent: true, opacity: 0.95, depthTest: false,
    depthWrite: false, side: THREE.DoubleSide, fog: false, toneMapped: false});
  var line = new THREE.Mesh(new THREE.BufferGeometry(), lineMat);
  line.name = "routefx:line"; line.visible = false; line.renderOrder = 3; line.frustumCulled = false;
  scene.add(chev); scene.add(pillar); scene.add(line);

  var pts = null, cum = null, len = 0, ground = function(){ return 0; };
  var clock = 0, along = 0, tracked = false, dead = false, lineW = 0;
  var m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(0, 0, 0, "YXZ"),
      v = new THREE.Vector3(), sc = new THREE.Vector3(1, 1, 1);

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
    lineW = 0; line.visible = false;                            // rebuilt by the next map frame
  }
  // the map's route line, rebuilt only when the width it needs moves by over LINE_STEP
  function mapLine(cam){
    var alt = Math.max(1, (+cam.y || 0) - ground(+cam.x || 0, +cam.z || 0));
    var fov = (+cam.fov || 0) > 0 ? +cam.fov : 10;
    var w = Math.max(2, 2*alt*Math.tan(fov*Math.PI/360)*LINE_FRAC);
    if(!(lineW > 0 && w < lineW*LINE_STEP && w > lineW/LINE_STEP)){
      lineW = w;
      line.geometry.dispose();
      line.geometry = lineGeometry(THREE, pts, ground, w);
    }
    line.visible = true;
  }

  function setWaypoint(w){
    if(!w){ pillar.visible = false; return; }
    pillar.position.set(+w.x || 0, +w.y || 0, +w.z || 0);
    pillar.visible = true;
  }

  function update(dt, player, cam){
    if(dead) return;
    clock += Math.max(0, +dt || 0);
    var phase = (clock*FLOW) % SPACING, map = !!(cam && cam.mode === "map");
    if(pts && map) mapLine(cam); else line.visible = false;
    if(pts && player && !map){
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
        var d = s - along, f = smooth(0, NEAR_FADE, d)*(1 - smooth(AHEAD - FAR_FADE, AHEAD, d));
        m4.compose(v, q, sc.set(Math.max(f, 1e-3), 1, Math.max(f, 1e-3)));   // never 0: it keeps its turn
        chev.setMatrixAt(n, m4);
        chev.setColorAt(n, brand);
        n++;
      }
      chev.count = n; chev.visible = n > 0;
      chev.instanceMatrix.needsUpdate = true;
      if(chev.instanceColor) chev.instanceColor.needsUpdate = true;
    } else { chev.count = 0; chev.visible = false; }
    if(pillar.visible){
      // by the full distance, so the pin also grows on the map, straight above it
      var cp = cam && (cam.position || cam), w = 1;
      if(cp) w = Math.max(1, Math.hypot((+cp.x || 0) - pillar.position.x, cp.y != null ? (+cp.y || 0) - pillar.position.y : 0,
                                        (+cp.z || 0) - pillar.position.z)/PILLAR_SEEN);
      pillar.scale.set(w, 1, w);
      pillMat.opacity = 0.75 + 0.15*Math.sin(clock*2.4);
    }
  }

  function state(){ return {count: chev.count, phase: (clock*FLOW) % SPACING, along: along, pillar: pillar.visible,
                             line: line.visible ? lineW : 0}; }

  function dispose(){
    if(dead) return;
    dead = true;
    if(chev.parent) chev.parent.remove(chev);
    if(pillar.parent) pillar.parent.remove(pillar);
    if(line.parent) line.parent.remove(line);
    chev.geometry.dispose(); chevMat.dispose(); chev.dispose();
    pillar.geometry.dispose(); pillMat.dispose();
    line.geometry.dispose(); lineMat.dispose();
    pts = null; cum = null;
  }

  return {setRoute: setRoute, setWaypoint: setWaypoint, update: update, state: state, dispose: dispose,
          chevrons: chev, pillar: pillar, line: line};
}

HQV.hqroutefx = {create: create, SPACING: SPACING, LIFT: LIFT, AHEAD: AHEAD, FLOW: FLOW, MAX: MAX, CHEV_W: CHEV_W, DISC_R: DISC_R};
})();
