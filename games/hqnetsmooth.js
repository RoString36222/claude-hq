/* Claude HQ: other players drawn smoothly (HQV.hqNetSmooth; games/hq3d.js setPeers / placePeers use it).
 *
 * Presence arrives about 8 times a second, but not evenly: the page sends on a timer and the Arena forwards on its own
 * tick, so one player's frames land 0, 125 or 250 ms apart, and a frame can repeat the last one. Guessing a speed from
 * when frames arrive turns that into lurches. Here each player keeps a short buffer of their frames, each stamped with
 * the time it was TAKEN (the sender's own clock, `t`, the "motion" capability; an older Arena: when it arrived, a
 * repeat skipped), and is drawn DELAY s in the past, on a curve through those frames: a cubic Hermite whose tangents
 * are the velocity and yaw rate they send (else the neighbouring frames'). Past the newest frame it carries on along
 * that velocity for up to MAX_EXTRAP s, then holds. When a new frame moves the curve, the jump is not shown: it
 * becomes an offset that fades out over FADE s. A teleport (too far, too fast) starts afresh, flagged once as a jump.
 *
 * Pure (tests/test_hqnetsmooth.py): no THREE, no DOM; times are seconds on the receiver's clock (performance.now()/1000).
 *   track() -> T                      a player's buffer
 *   push(T, f, now)                   f = {t (sender ms) | null, x, z, y | null, yaw (rad), pitch, vx, vz (m/s) | null,
 *                                     yr (rad/s) | null, rpm | null}; a stale or repeated frame is ignored
 *   sample(T, now) -> pose | null     {x, z, y, yaw, pitch, vx, vz, speed, yr, rpm, jump}
 */
(function(){
"use strict";
var root = typeof window !== "undefined" ? window : globalThis;
var HQV = root.HQV = root.HQV || {};

var DELAY = 0.2;            // s drawn in the past with the sender's clock (above one 125 ms tick plus jitter)
var DELAY_RX = 0.3;         // s without it (frames stamped on arrival: more slack)
var MAX_EXTRAP = 0.35;      // s carried on past the newest frame
var FADE = 0.18;            // s for a correction to fade out
var KEEP = 10;              // frames kept
var TELE_M = 60, TELE_V = 160;   // a jump this far, or this fast (m/s): a teleport
var OFF_WIN = 4;            // s of frames the clock offset is taken from
var RETIME = 0.12;          // s a frame stamped on arrival may be re-timed by
var SLEW = 0.02;            // s/s the offset in use may move (a 2% time warp: not seen)

function wrap(a){ return Math.atan2(Math.sin(a), Math.cos(a)); }
function num(v){ return typeof v === "number" && isFinite(v) ? v : null; }

function track(){ return {buf: [], off: null, offAt: 0, lat: null, lastT: null, ox: 0, oz: 0, oy: 0, oyaw: 0, oAt: 0, jump: false, rx: false}; }

// the sender's clock (ms) -> this page's seconds: their clock plus an offset, the smallest (now - their time) of the
// last OFF_WIN s (the frame that came quickest). The offset in use slews toward that at SLEW s/s at most, so a
// quicker frame never jerks the timeline; the first frame sets it outright, and their clock restarting resets it
function localTime(T, t, now){
  var ts = t/1000, o = now - ts;
  if(T.lastT != null && (ts < T.lastT - 3600 || ts > T.lastT + 3600)) T.off = null;
  T.lat = (T.lat || []).filter(function(q){ return now - q[0] < OFF_WIN; }); T.lat.push([now, o]);
  var want = Math.min.apply(null, T.lat.map(function(q){ return q[1]; }));
  if(T.off == null){ T.off = want; T.offAt = now; }
  else { var step = SLEW*Math.max(0, now - T.offAt); T.off += Math.max(-step, Math.min(step, want - T.off)); T.offAt = now; }
  return ts + T.off;
}

function push(T, f, now){
  if(!T || !f) return;
  var x = num(f.x), z = num(f.z), yaw = num(f.yaw); if(x == null || z == null || yaw == null) return;
  var t = num(f.t), last = T.buf.length ? T.buf[T.buf.length - 1] : null, lt;
  if(t != null){
    if(T.lastT != null && t/1000 <= T.lastT && t/1000 > T.lastT - 3600) return;     // stale, or the same frame again
    lt = localTime(T, t, now); T.lastT = t/1000; T.rx = false;
  } else {
    // no sender clock: a frame that repeats the last spot says nothing new (its arrival time would only mislead)
    if(last && Math.abs(last.x - x) < 0.005 && Math.abs(last.z - z) < 0.005 && Math.abs(wrap(last.yaw - yaw)) < 0.01 &&
       (f.y == null || last.y == null || Math.abs(last.y - f.y) < 0.005) && now - last.lt < 1.5) return;
    // stamped on arrival, which is the Arena's tick, not when it was taken: re-timed by the distance from the last
    // frame at their recent average speed (steady driving plays back steadily), never more than RETIME s off arrival
    lt = now; T.rx = true;
    T.arr = (T.arr || []).filter(function(q){ return now - q[0] < 1.2; }); T.arr.push([now, x, z]);
    if(last && T.arr.length >= 3){
      var A0 = T.arr[0], span = now - A0[0], dist = 0;
      for(var j = 1; j < T.arr.length; j++) dist += Math.hypot(T.arr[j][1] - T.arr[j - 1][1], T.arr[j][2] - T.arr[j - 1][2]);
      var vAvg = span > 0.2 ? dist/span : 0;
      if(vAvg > 0.5) lt = Math.max(now - RETIME, Math.min(now, last.lt + Math.hypot(x - last.x, z - last.z)/vAvg));
    }
  }
  if(last && lt <= last.lt) lt = last.lt + 0.001;
  var pre = T.buf.length ? sampleRaw(T, now) : null;
  // a teleport (another world, a respawn): start afresh, shown as a jump
  if(last){
    var d = Math.hypot(x - last.x, z - last.z), dt = lt - last.lt;
    if(d > TELE_M || (dt > 0 && d/dt > TELE_V && d > 4)){ T.buf = []; T.jump = true; pre = null; T.ox = T.oz = T.oy = T.oyaw = 0; }
  }
  // yaw kept continuous through +-pi so the curve never spins the long way round
  var prev = T.buf.length ? T.buf[T.buf.length - 1] : null;
  var fy = num(f.y), fr = {lt: lt, x: x, z: z, y: fy, yaw: prev ? prev.yaw + wrap(yaw - prev.yaw) : yaw, pitch: num(f.pitch) || 0,
           vx: num(f.vx), vz: num(f.vz), yr: num(f.yr), rpm: num(f.rpm)};
  T.buf.push(fr);
  if(T.buf.length > KEEP) T.buf.shift();
  // the change in where it is drawn right now becomes an offset that fades (no visible snap)
  if(pre){
    var post = sampleRaw(T, now), k = decay(T, now);
    T.ox = T.ox*k + (pre.x - post.x); T.oz = T.oz*k + (pre.z - post.z);
    T.oy = T.oy*k + ((pre.y != null && post.y != null) ? pre.y - post.y : 0); T.oyaw = T.oyaw*k + wrap(pre.yaw - post.yaw);
    T.oAt = now;
    if(Math.hypot(T.ox, T.oz) > 8){ T.ox = T.oz = T.oy = T.oyaw = 0; }   // too far to glide: just be there
  }
}
function decay(T, now){ return Math.exp(-Math.max(0, now - T.oAt)/FADE); }

// the velocity at frame i: what it sent, else the slope through its neighbours
function vel(B, i){
  var f = B[i];
  if(f.vx != null && f.vz != null) return [f.vx, f.vz];
  var a = B[Math.max(0, i - 1)], b = B[Math.min(B.length - 1, i + 1)], dt = b.lt - a.lt;
  return dt > 1e-6 ? [(b.x - a.x)/dt, (b.z - a.z)/dt] : [0, 0];
}
function yawRate(B, i){
  var f = B[i];
  if(f.yr != null) return f.yr;
  var a = B[Math.max(0, i - 1)], b = B[Math.min(B.length - 1, i + 1)], dt = b.lt - a.lt;
  return dt > 1e-6 ? (b.yaw - a.yaw)/dt : 0;
}
function herm(p0, m0, p1, m1, u, h){
  var u2 = u*u, u3 = u2*u;
  return (2*u3 - 3*u2 + 1)*p0 + (u3 - 2*u2 + u)*h*m0 + (-2*u3 + 3*u2)*p1 + (u3 - u2)*h*m1;
}
function dherm(p0, m0, p1, m1, u, h){
  var u2 = u*u;
  return ((6*u2 - 6*u)*p0 + (3*u2 - 4*u + 1)*h*m0 + (-6*u2 + 6*u)*p1 + (3*u2 - 2*u)*h*m1)/h;
}
function sampleRaw(T, now){
  var B = T.buf; if(!B.length) return null;
  var rt = now - (T.rx ? DELAY_RX : DELAY), n = B.length;
  if(n === 1 || rt <= B[0].lt){
    var f0 = B[0], v0 = n > 1 ? vel(B, 0) : [f0.vx || 0, f0.vz || 0];
    return {x: f0.x, z: f0.z, y: f0.y, yaw: f0.yaw, pitch: f0.pitch, vx: n > 1 ? v0[0] : 0, vz: n > 1 ? v0[1] : 0, yr: 0, rpm: f0.rpm, ex: 0};
  }
  var L = B[n - 1];
  if(rt >= L.lt){                                                      // past the newest: carry on, then hold
    var e = Math.min(rt - L.lt, MAX_EXTRAP), v = vel(B, n - 1), w = yawRate(B, n - 1), moving = e < MAX_EXTRAP;
    return {x: L.x + v[0]*e, z: L.z + v[1]*e, y: L.y, yaw: L.yaw + w*e, pitch: L.pitch,
            vx: moving ? v[0] : 0, vz: moving ? v[1] : 0, yr: moving ? w : 0, rpm: L.rpm, ex: rt - L.lt};
  }
  var i = n - 2; while(i > 0 && B[i].lt > rt) i--;
  var a = B[i], b = B[i + 1], h = b.lt - a.lt, u = h > 1e-6 ? (rt - a.lt)/h : 1;
  var va = vel(B, i), vb = vel(B, i + 1), wa = yawRate(B, i), wb = yawRate(B, i + 1);
  var y = a.y != null && b.y != null ? a.y + (b.y - a.y)*u : (b.y != null ? b.y : a.y);
  return {x: herm(a.x, va[0], b.x, vb[0], u, h), z: herm(a.z, va[1], b.z, vb[1], u, h), y: y,
          yaw: herm(a.yaw, wa, b.yaw, wb, u, h), pitch: a.pitch + (b.pitch - a.pitch)*u,
          vx: dherm(a.x, va[0], b.x, vb[0], u, h), vz: dherm(a.z, va[1], b.z, vb[1], u, h), yr: dherm(a.yaw, wa, b.yaw, wb, u, h),
          rpm: a.rpm != null && b.rpm != null ? a.rpm + (b.rpm - a.rpm)*u : b.rpm, ex: 0};
}
function sample(T, now){
  var S = sampleRaw(T, now); if(!S) return null;
  var k = decay(T, now);
  S.x += T.ox*k; S.z += T.oz*k; if(S.y != null) S.y += T.oy*k; S.yaw = wrap(S.yaw + T.oyaw*k);
  S.speed = Math.hypot(S.vx, S.vz); S.jump = T.jump; T.jump = false;
  return S;
}

HQV.hqNetSmooth = {track: track, push: push, sample: sample, DELAY: DELAY, DELAY_RX: DELAY_RX, MAX_EXTRAP: MAX_EXTRAP, FADE: FADE};
})();
