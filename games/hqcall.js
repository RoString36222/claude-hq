/* Claude HQ: calling your vehicle (HQV.hqCall, docs/plans/dealership-spec.md "Calling your vehicle").
 *
 * C in the 3D City lists your vehicles; the one you pick comes to you. Your vehicles live in the city's multi-storey
 * carpark (HQV.hqCarpark, when the city has one): called, it leaves its bay down the ramps (exitPath), then drives the
 * road route (games/hqnav.js, drive mode) from the carpark's entrance to you, on the right of the road, slowing for
 * turns, junctions, traffic and you. With no carpark it starts where it stands (within CALL_R m in this world), and
 * when there is no way from there either it appears on a road out of sight (over MIN_HIDE m away and outside the
 * camera) and drives the last stretch. A call is beside you within BUDGET s however far it comes: everything before its
 * last FINAL m is hurried along the same route, and that last stretch is driven at street speed. It parks at the kerb
 * beside you, facing the way it came. When you get out,
 * RETURN_S s later it drives itself back: to the carpark's entrance and up entryPath into its bay (or, with no
 * carpark, back to its place by your HQ's garage).
 *
 * Pure (node-tested, tests/test_hqcall.py): metres, yaw 0 faces +z, increasing yaw turns LEFT, the right of travel
 * is (-cos yaw, sin yaw) = (-dz, dx) for a direction (dx, dz) (as games/traffic.js; everyone drives on the right).
 *   kerb(road, dir)              road = {x, z, ux, uz, half} (a point on a road's centre line, its direction, half its
 *                                carriageway); dir = [dx, dz] the way the vehicle arrives (null: along u)
 *                                -> {x, z, yaw}: the kerb on the right of travel
 *   arrival(pts)                 -> [dx, dz]: the direction of a route's last 3+ m
 *   pathFor(pts, spot, lane)     -> Float64Array [x0, z0, ...]: the route kept LANE m right of the centre line (eased in
 *                                over the first metres), ending at the kerb spot
 *   poly(pl)                     a carpark polyline ([{x, y?, z}], [[x, z]], [[x, y, z]], flat [x, z, ...], {pts, ys})
 *                                -> {xz, y} (y null, or NaN where it is the ground)
 *   join(a, b)                   a then b as one {xz, y} (b's points on the ground)
 *   run(path, v0, ys, budget)    -> R {P, C, len, s, v, x, y, z, yaw, done, t}; ys: heights per point (NaN: the
 *                                ground); where a height is given (the carpark) it keeps to RAMP_V m/s. budget (s,
 *                                a call: BUDGET): everything before its last FINAL m is hurried (R.hurry) so that it
 *                                is there in budget s however far it comes; the last FINAL m are driven as usual
 *   step(R, dt, ahead)           advance R by dt s; ahead = metres to the nearest obstacle in its lane (Infinity: none;
 *                                ignored while it hurries)
 *   aheadOf(x, z, yaw, obs, half, range) -> metres to the nearest obstacle {x, z, r} in a lane of half width half
 *   spawnPick(cands, me, inView, minD) -> the nearest candidate {x, z} at least minD m from me and not in view, or null
 *   eta(len)                     -> s, for the panel and the pill (a call: at most BUDGET)
 *   etaOf(R)                     -> s left on a run
 * UI (textContent only; keys inside never reach the dashboard or the avatar):
 *   mount(stage, {items() -> [{key, title, sub, busy}], onPick(key), onClose}) -> ui
 *     ui.open() / close() / toggle() / isOpen() / render() / status(text | null) / destroy()
 *   owns(e)                      a key event inside the panel (hq3d's capture-phase handler skips it)
 */
(function(){
"use strict";
var HQV = (typeof window !== "undefined" ? window : globalThis).HQV = (typeof window !== "undefined" ? window : globalThis).HQV || {};

var CRUISE = 12;        // m/s (43 km/h): a city street
var TURN_V = 4.5;       // m/s through a right-angle turn
var ACC = 2.6, DEC = 4.2;   // m/s2
var LANE = 1.8;         // m right of the centre line
var KERB_IN = 1.3;      // m in from the carriageway's edge (to the vehicle's middle)
var STOP_GAP = 6;       // m kept to an obstacle ahead
var LOOK = 30;          // m of road looked ahead for turns
var CALL_R = 1500;      // m: farther (or another world) and it arrives from out of sight
var MIN_HIDE = 40;      // m: out of sight means at least this far
var EASE_IN = 8;        // m over which the lane offset eases in at the start
var BUDGET = 6;         // s: a called vehicle is beside you within this, from anywhere
var FINAL = 25;         // m: its last stretch, driven at street speed (everything before is hurried)
var FINAL_T = 3.5;       // s kept for that last stretch

function hyp(a, b){ return Math.sqrt(a*a + b*b); }
function wrap(a){ while(a > Math.PI) a -= 2*Math.PI; while(a < -Math.PI) a += 2*Math.PI; return a; }
function clamp(v, a, b){ return v < a ? a : v > b ? b : v; }

function kerb(road, dir){
  var dx = dir ? dir[0] : road.ux, dz = dir ? dir[1] : road.uz, n = hyp(dx, dz) || 1; dx /= n; dz /= n;
  var off = clamp((+road.half || 3.5) - KERB_IN, 1.6, 7);
  return {x: road.x - dz*off, z: road.z + dx*off, yaw: Math.atan2(dx, dz)};
}
function arrival(pts){
  var n = pts.length/2, lx = pts[2*n - 2], lz = pts[2*n - 1];
  for(var i = n - 2; i >= 0; i--){
    var dx = lx - pts[2*i], dz = lz - pts[2*i + 1], d = hyp(dx, dz);
    if(d >= 3) return [dx/d, dz/d];
  }
  var fx = lx - pts[0], fz = lz - pts[1], fd = hyp(fx, fz);
  return fd > 1e-6 ? [fx/fd, fz/fd] : [0, 1];
}
// the route held LANE m to the right of the centre line (each corner offset along its bisector), the offset easing
// in over the first EASE_IN m from where the vehicle stands; its last metres replaced by the run to the kerb spot
function pathFor(pts, spot, lane){
  lane = lane == null ? LANE : lane;
  var n = pts.length/2, q = [], i;
  for(i = 0; i < n; i++){
    var x = pts[2*i], z = pts[2*i + 1];
    if(q.length && hyp(x - q[q.length - 2], z - q[q.length - 1]) < 0.3) continue;
    q.push(x, z);
  }
  n = q.length/2;
  var out = [], along = 0;
  for(i = 0; i < n; i++){
    if(i) along += hyp(q[2*i] - q[2*i - 2], q[2*i + 1] - q[2*i - 1]);
    var ax = 0, az = 0;
    if(i > 0){ var d1 = hyp(q[2*i] - q[2*i - 2], q[2*i + 1] - q[2*i - 1]) || 1; ax += (q[2*i] - q[2*i - 2])/d1; az += (q[2*i + 1] - q[2*i - 1])/d1; }
    if(i < n - 1){ var d2 = hyp(q[2*i + 2] - q[2*i], q[2*i + 3] - q[2*i + 1]) || 1; ax += (q[2*i + 2] - q[2*i])/d2; az += (q[2*i + 3] - q[2*i + 1])/d2; }
    var an = hyp(ax, az) || 1; ax /= an; az /= an;
    // the bisector's offset grows at a corner so both legs stay LANE m off (capped for hairpins)
    var k = 1;
    if(i > 0 && i < n - 1){ var d3 = hyp(q[2*i] - q[2*i - 2], q[2*i + 1] - q[2*i - 1]) || 1, cs = ((q[2*i] - q[2*i - 2])/d3)*ax + ((q[2*i + 1] - q[2*i - 1])/d3)*az; k = 1/Math.max(0.5, cs); }
    var o = lane*k*clamp(along/EASE_IN, 0, 1);
    out.push(q[2*i] - az*o, q[2*i + 1] + ax*o);
  }
  // the end: drop the points in the last 7 m, then a lead-in point 6 m before the spot along its heading, and the spot
  var sx = Math.sin(spot.yaw), sz = Math.cos(spot.yaw);
  while(out.length > 2 && hyp(out[out.length - 2] - spot.x, out[out.length - 1] - spot.z) < 7) out.length -= 2;
  var lx = spot.x - sx*6, lz = spot.z - sz*6;
  if(out.length < 2 || hyp(out[out.length - 2] - lx, out[out.length - 1] - lz) > 0.5) out.push(lx, lz);
  out.push(spot.x, spot.z);
  return new Float64Array(out);
}

// a polyline as the carpark gives it (HQV.hqCarpark exitPath / entryPath: [{x, y?, z}], [[x, z]], [[x, y, z]], or a
// flat [x, z, ...] / {pts, ys}) -> {xz: Float64Array, y: Float64Array | null} (y NaN where it is the ground)
function poly(pl){
  if(!pl) return null;
  if(pl.pts) return {xz: Float64Array.from(pl.pts), y: pl.ys ? Float64Array.from(pl.ys) : null};
  var xz = [], y = [], hasY = false;
  if(typeof pl[0] === "number"){ for(var i = 0; i + 1 < pl.length; i += 2){ xz.push(+pl[i], +pl[i + 1]); y.push(NaN); } }
  else for(var j = 0; j < pl.length; j++){
    var p = pl[j]; if(!p) continue;
    if(Array.isArray(p)){ if(p.length >= 3){ xz.push(+p[0], +p[2]); y.push(+p[1]); hasY = true; } else { xz.push(+p[0], +p[1]); y.push(NaN); } }
    else { xz.push(+p.x, +p.z); var py = p.y != null ? +p.y : NaN; y.push(py); if(py === py) hasY = true; }
  }
  return xz.length >= 4 ? {xz: Float64Array.from(xz), y: hasY ? Float64Array.from(y) : null} : null;
}
// a then b (one path; a point of b within 0.3 m of a's end dropped), with a's heights and NaN (the ground) for b's
function join(a, b){
  var xz = Array.from(a.xz), y = a.y ? Array.from(a.y) : Array(a.xz.length/2).fill(NaN);
  var bx = b.xz || b, by = b.y || null;
  for(var i = 0; i + 1 < bx.length; i += 2){
    if(xz.length && hyp(bx[i] - xz[xz.length - 2], bx[i + 1] - xz[xz.length - 1]) < 0.3) continue;
    xz.push(bx[i], bx[i + 1]); y.push(by ? by[i/2] : NaN);
  }
  return {xz: Float64Array.from(xz), y: Float64Array.from(y)};
}
function cumOf(P){
  var n = P.length/2, C = new Float64Array(Math.max(1, n));
  for(var i = 1; i < n; i++) C[i] = C[i - 1] + hyp(P[2*i] - P[2*i - 2], P[2*i + 1] - P[2*i - 1]);
  return C;
}
function seg(R, s){
  var C = R.C, n = C.length, lo = 0, hi = n - 1;
  if(n < 2) return 0;
  s = clamp(s, 0, R.len);
  while(hi - lo > 1){ var m = (lo + hi) >> 1; if(C[m] <= s) lo = m; else hi = m; }
  return lo;
}
function pointAt(R, s){
  var i = seg(R, s), P = R.P;
  if(R.C.length < 2) return {x: P[0], z: P[1], y: R.Y ? R.Y[0] : NaN, i: 0};
  var L = R.C[i + 1] - R.C[i], t = L > 0 ? (clamp(s, 0, R.len) - R.C[i])/L : 0, y = NaN;
  if(R.Y){ var y0 = R.Y[i], y1 = R.Y[i + 1]; y = y0 === y0 && y1 === y1 ? y0 + (y1 - y0)*t : (t < 0.5 ? y0 : y1); }
  return {x: P[2*i] + (P[2*i + 2] - P[2*i])*t, z: P[2*i + 1] + (P[2*i + 3] - P[2*i + 1])*t, y: y, i: i};
}
var RAMP_V = 7;          // m/s inside the carpark (a path with heights: its ramps and aisles)
function headingAt(R, s){
  var i = seg(R, s), P = R.P;
  if(R.C.length < 2) return R.yaw || 0;
  return Math.atan2(P[2*i + 2] - P[2*i], P[2*i + 3] - P[2*i + 1]);
}
// the speed the road allows at s: full on a straight, TURN_V through a right angle (the heading change over 10 m)
function capAt(R, s){
  var a = Math.abs(wrap(headingAt(R, Math.min(R.len, s + 5)) - headingAt(R, Math.max(0, s - 5))));
  var v = TURN_V + (CRUISE - TURN_V)*clamp(1 - a/1.2, 0, 1);
  if(R.Y){ var y = pointAt(R, s).y; if(y === y) v = Math.min(v, RAMP_V); }
  return v;
}
// ys (optional, one per point): heights along the path (NaN: the ground), the carpark's ramps
function run(path, v0, ys, budget){
  var R = {P: path, C: cumOf(path), s: 0, v: Math.max(0, +v0 || 0), done: false, Y: ys && ys.length === path.length/2 ? ys : null,
           t: 0, budget: budget > 0 ? +budget : 0, hurry: false};
  R.len = R.C[R.C.length - 1];
  R.x = path[0]; R.z = path[1]; R.y = R.Y ? R.Y[0] : NaN; R.yaw = headingAt(R, 0.5);
  R.endYaw = path.length >= 4 ? Math.atan2(path[path.length - 2] - path[path.length - 4], path[path.length - 1] - path[path.length - 3]) : R.yaw;
  return R;
}
function step(R, dt, ahead){
  if(R.done || !(dt > 0)) return R;
  R.t += dt;
  // a call: the metres before its last FINAL that it must cover each second to keep its budget, over what it drives
  var far = R.budget ? R.len - FINAL - R.s : 0, need = far > 0 ? far/Math.max(0.25, R.budget - FINAL_T - R.t) : 0;
  R.hurry = need > R.v + 1;
  if(R.hurry) ahead = Infinity;
  var tv = CRUISE;
  for(var k = 0; k <= LOOK; k += 3){ var s2 = R.s + k; if(s2 > R.len) break; tv = Math.min(tv, Math.sqrt(Math.pow(capAt(R, s2), 2) + 2*DEC*k)); }
  tv = Math.min(tv, Math.sqrt(2*DEC*Math.max(0, R.len - R.s)) + 0.4);                        // stopping at the spot
  if(ahead != null && isFinite(ahead)) tv = Math.min(tv, Math.sqrt(2*DEC*Math.max(0, ahead - STOP_GAP)));
  R.v = R.v < tv ? Math.min(tv, R.v + ACC*dt) : Math.max(tv, R.v - DEC*1.6*dt);
  R.s = Math.min(R.len, R.s + R.v*dt);
  if(R.hurry) R.s = Math.min(R.s + Math.max(0, need - R.v)*dt, R.len - FINAL);
  var p = pointAt(R, R.s); R.x = p.x; R.z = p.z; R.y = p.y;
  var ty = headingAt(R, Math.min(R.len, R.s + 2.5));
  R.yaw = R.hurry ? ty : wrap(R.yaw + wrap(ty - R.yaw)*(1 - Math.exp(-dt*7)));
  if(R.s >= R.len - 0.05){ R.done = true; R.v = 0; R.x = R.P[R.P.length - 2]; R.z = R.P[R.P.length - 1]; R.yaw = R.endYaw; R.y = R.Y ? R.Y[R.Y.length - 1] : NaN; }
  return R;
}
function aheadOf(x, z, yaw, obs, half, range){
  half = half == null ? 1.6 : half; range = range == null ? 35 : range;
  var fx = Math.sin(yaw), fz = Math.cos(yaw), best = Infinity;
  (obs || []).forEach(function(o){
    if(!o) return;
    var dx = o.x - x, dz = o.z - z, a = dx*fx + dz*fz;
    if(a <= 0 || a > range) return;
    var lat = Math.abs(dx*fz - dz*fx);
    if(lat < half + (+o.r || 1)) best = Math.min(best, a - (+o.r || 1));
  });
  return best;
}
function spawnPick(cands, me, inView, minD){
  minD = minD == null ? MIN_HIDE : minD;
  var L = (cands || []).filter(function(c){ return c && hyp(c.x - me.x, c.z - me.z) >= minD; });
  L.sort(function(a, b){ return hyp(a.x - me.x, a.z - me.z) - hyp(b.x - me.x, b.z - me.z); });
  for(var i = 0; i < L.length; i++) if(!inView || !inView(L[i].x, L[i].z)) return L[i];
  return null;
}
function eta(len){ return Math.max(2, Math.min(BUDGET, Math.round(len/(CRUISE*0.62) + 2))); }
function etaOf(R){
  var e = Math.max(1, Math.round((R.len - R.s)/(CRUISE*0.62) + 1));
  return R.budget ? Math.max(1, Math.min(e, Math.ceil(R.budget - R.t))) : e;
}

/* ---------- the panel and the pill ---------- */
var OWN = ".hqcall";
function inside(t){ return !!(t && t.closest && t.closest(OWN)); }
function owns(e){ return !!(e && (e.hqCallHandled || inside(e.target))); }

function mount(stage, opts){
  opts = opts || {};
  var doc = typeof document !== "undefined" ? document : null;
  var items = typeof opts.items === "function" ? opts.items : function(){ return []; };
  var onPick = typeof opts.onPick === "function" ? opts.onPick : function(){};
  var listeners = [], open = false;
  function mk(tag, cls, parent, text){ var n = doc.createElement(tag); if(cls) n.className = cls; if(text != null) n.textContent = text; if(parent) parent.appendChild(n); return n; }
  function on(n, ev, fn){ n.addEventListener(ev, fn); listeners.push([n, ev, fn]); }
  var root = mk("div", "hqcall", stage); root.hidden = true;
  root.setAttribute("role", "dialog"); root.setAttribute("aria-label", "Call a vehicle");
  var head = mk("div", "hqcall-head", root);
  mk("div", "hqcall-title", head, "📞 Call a vehicle");
  var closeBtn = mk("button", "hqcall-close", head, "✕"); closeBtn.type = "button"; closeBtn.setAttribute("aria-label", "Close");
  var list = mk("div", "hqcall-list", root);
  var pill = mk("div", "hqcall-pill", stage); pill.hidden = true; pill.setAttribute("role", "status"); pill.setAttribute("aria-live", "polite");

  function render(){
    while(list.firstChild) list.removeChild(list.firstChild);
    var L = items() || [];
    if(!L.length){ mk("div", "hqcall-empty", list, "No vehicles yet. Pick one in the Showroom (G)."); return; }
    L.forEach(function(it, i){
      var b = mk("button", "hqcall-item" + (it.busy ? " busy" : ""), list); b.type = "button";
      if(it.col){ var sw = mk("span", "hqcall-swatch", b); sw.style.background = it.col; }
      var tx = mk("span", "hqcall-text", b);
      mk("span", "hqcall-name", tx, it.title || it.key);
      mk("span", "hqcall-sub", tx, it.sub || "");
      on(b, "click", function(){ close(); onPick(it.key); });
      if(i === 0 && open && b.focus) b.focus();
    });
  }
  function contain(e){
    e.hqCallHandled = true;
    if(e.stopPropagation) e.stopPropagation();
    if(e.type === "keydown" && (e.key === "Escape" || e.code === "KeyC")){ if(e.preventDefault) e.preventDefault(); close(); }
    else if(e.type === "keydown" && (e.key === "ArrowDown" || e.key === "ArrowUp")){
      var bs = [].slice.call(list.querySelectorAll("button")), i = bs.indexOf(doc.activeElement);
      if(bs.length){ if(e.preventDefault) e.preventDefault(); bs[(i + (e.key === "ArrowDown" ? 1 : -1) + bs.length) % bs.length].focus(); }
    }
  }
  on(root, "keydown", contain); on(root, "keyup", contain);
  on(closeBtn, "click", function(){ close(); });
  function openP(){ if(open) return; open = true; root.hidden = false; render(); var f = list.querySelector("button") || closeBtn; if(f && f.focus) f.focus(); }
  function close(){ if(!open) return; open = false; root.hidden = true; if(opts.onClose) opts.onClose(); }
  return {
    open: openP, close: close, toggle: function(){ if(open) close(); else openP(); }, isOpen: function(){ return open; },
    render: render, root: root, pill: pill,
    status: function(t){ if(t == null || t === ""){ pill.hidden = true; return; } if(pill.textContent !== t) pill.textContent = t; pill.hidden = false; },
    destroy: function(){ listeners.forEach(function(l){ l[0].removeEventListener(l[1], l[2]); }); listeners = [];
                         [root, pill].forEach(function(n){ if(n.parentNode) n.parentNode.removeChild(n); }); }
  };
}

HQV.hqCall = {kerb: kerb, arrival: arrival, pathFor: pathFor, run: run, step: step, aheadOf: aheadOf, spawnPick: spawnPick,
              eta: eta, etaOf: etaOf, BUDGET: BUDGET, capAt: capAt, pointAt: pointAt, poly: poly, join: join, mount: mount, owns: owns, RETURN_S: 5, RAMP_V: RAMP_V,
              CRUISE: CRUISE, TURN_V: TURN_V, LANE: LANE, CALL_R: CALL_R, MIN_HIDE: MIN_HIDE, STOP_GAP: STOP_GAP};
})();
