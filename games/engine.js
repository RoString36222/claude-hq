/* Claude HQ: the shared 3D game engine (HQ 2.0, Wave 0).
 *
 * Kart Racing, Platformer Rush and Blaster Arena each carried their own copy of
 * these parts; the 3D HQ uses them too. Loaded once, after core.js and before
 * the games (VALLEY_FILES in ui/app/10-views.js), as HQV.engine.
 *
 *   util    now, clamp, hex, angLerp, calm, say, tokens, myClock, fmtTime, dist3
 *   three   lib()           three.js + GLTFLoader + SkeletonUtils, loaded once
 *           loadGlb(lib, kit, name)   a Kenney model from /games/<kit>/, cached
 *           hasWebGL2()
 *   net     senderTime(P, q, t, jitMax)   a remote frame's time on our clock
 *           jitter(P, late)               the running jitter estimate
 *           pushSnap(sn, s, cap)          append to a snapshot buffer, bounded
 *           bracket(sn, rt)               the two snapshots around render time
 *
 * Same house rules as core.js: no build step, nothing leaves the machine.
 */
(function(){
"use strict";
var HQV = window.HQV = window.HQV || {};

/* ---------- util ---------- */
function now(){ return performance.now()/1000; }
function clamp(v, a, b){ return v < a ? a : v > b ? b : v; }
function hex(s, fb){ return typeof s === "string" && /^#[0-9a-f]{6}$/i.test(s) ? parseInt(s.slice(1), 16) : fb; }
function angLerp(a, b, u){ return a + Math.atan2(Math.sin(b - a), Math.cos(b - a))*u; }
function calm(){ return document.documentElement.classList.contains("hq-calm") ||
  (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches); }
function say(t){ if(typeof window.announce === "function"){ try { window.announce(t); } catch(e){} } }
// Theme colours for 2D canvases (gauges, minimaps, map views) from the page's tokens.
function tokens(){
  var cs = getComputedStyle(document.documentElement);
  function g(n, fb){ var v = (cs.getPropertyValue(n) || "").trim(); return v || fb; }
  return {ink: g("--ink", "currentColor"), muted: g("--muted", "gray"), line: g("--line", "gray"), panel: g("--panel", "canvas"),
          panel2: g("--panel2", "canvas"), brand: g("--brand", "royalblue"), need: g("--need", "crimson"), good: g("--good", "seagreen"),
          gold: g("--gold", "goldenrod"), bg2: g("--bg2", "canvas"), mono: g("--mono", "monospace")};
}
// My clock for the server, centiseconds (never goes backwards; a reload starts over).
function myClock(){ return Math.floor(performance.now()/10) % 1073741824; }
// m:ss.cc for race and run times.
function fmtTime(ms){
  if(ms == null || !isFinite(ms)) return "–";
  ms = Math.max(0, Math.round(ms)); var m = Math.floor(ms/60000), s = (ms % 60000)/1000;
  return m+":"+(s < 10 ? "0" : "")+s.toFixed(2);
}
function dist3(a, b){ var dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2]; return Math.sqrt(dx*dx + dy*dy + dz*dz); }

/* ---------- three.js and models ---------- */
var KITS = ["golf", "kart", "platformer", "fps", "hq"];
var LIB = null, GLB = {};
// three.js, its GLTF loader and SkeletonUtils, imported once for every game.
// Each Kenney kit's GLBs point at their own "Textures/colormap.png"; one copy sits
// next to them in /games/<kit>/.
function lib(){
  return LIB || (LIB = Promise.all([import("/games/vendor/three-module.js"), import("/games/vendor/three-gltf-loader.js"),
                                    import("/games/vendor/three-skeleton-utils.js")])
    .then(function(m){
      var THREE = m[0], manager = new THREE.LoadingManager();
      manager.setURLModifier(function(u){
        var k = /\/games\/([a-z]+)\/Textures\/colormap\.png$/.exec(u);
        return k && KITS.indexOf(k[1]) >= 0 ? "/games/"+k[1]+"/colormap.png" : u;
      });
      return {THREE: THREE, loader: new m[1].GLTFLoader(manager), clone: m[2].clone, tex: new THREE.TextureLoader()};
    }, function(e){ LIB = null; throw e; }));
}
// A model from /games/<kit>/<name>.glb, loaded once and shared (clone it with lib.clone).
function loadGlb(L, kit, name){
  if(!/^[a-z][a-z0-9-]{0,40}$/.test(name) || KITS.indexOf(kit) < 0) return Promise.reject(new Error("bad model name"));
  var key = kit+"/"+name;
  return GLB[key] || (GLB[key] = new Promise(function(res, rej){
    L.loader.load("/games/"+key+".glb", res, null, function(e){ delete GLB[key]; rej(e); });
  }));
}
function hasWebGL2(){ try { return !!document.createElement("canvas").getContext("webgl2"); } catch(e){ return false; } }

/* ---------- snapshot interpolation ---------- */
// A remote player's frame carries its sender's clock q (centiseconds). Map it onto
// our clock: keep the smallest offset seen (the least-delayed frame), drift slowly
// toward newer ones, and track how late frames run (jitter) so the render delay can
// cover it. Returns the frame's time on our clock, or null for a stale frame.
// P holds lastQ (-1 at first), off (null at first) and jit (0 at first).
function senderTime(P, q, t, jitMax){
  q = q|0;
  if(P.lastQ >= 0 && q <= P.lastQ && P.lastQ - q < 6000) return null;   // older than what we have
  if(P.lastQ >= 0 && q <= P.lastQ) P.off = null;                          // the sender reloaded: start over
  P.lastQ = q;
  var off = t - q/100;
  if(P.off === null || off < P.off) P.off = off; else P.off += (off - P.off)*0.01;
  var st = q/100 + P.off;
  jitter(P, clamp(t - st, 0, jitMax));
  return st;
}
// Rise fast, fall slowly: one late frame widens the buffer, a calm spell narrows it.
function jitter(P, late){ P.jit += (late - P.jit)*(late > P.jit ? 0.3 : 0.02); }
// Append s (with s.t) keeping times strictly increasing and at most cap entries.
function pushSnap(sn, s, cap){
  var last = sn[sn.length - 1];
  if(last && s.t <= last.t) s.t = last.t + 0.001;
  sn.push(s);
  if(sn.length > cap) sn.shift();
  return s;
}
// The snapshots around render time rt: {A, B, u} between two, {A: first} before
// the buffer, {A: last, after: rt - last.t} past it, or null when it is empty.
function bracket(sn, rt){
  var n = sn.length; if(!n) return null;
  if(rt <= sn[0].t) return {A: sn[0], B: null, u: 0};
  if(rt >= sn[n-1].t) return {A: sn[n-1], B: null, u: 0, after: rt - sn[n-1].t};
  for(var i = n - 1; i > 0 && sn[i-1].t > rt; i--){}
  var A = sn[i-1], B = sn[i];
  return {A: A, B: B, u: (rt - A.t)/((B.t - A.t) || 1)};
}

HQV.engine = {now: now, clamp: clamp, hex: hex, angLerp: angLerp, calm: calm, say: say, tokens: tokens, myClock: myClock,
              fmtTime: fmtTime, dist3: dist3, lib: lib, loadGlb: loadGlb, hasWebGL2: hasWebGL2,
              senderTime: senderTime, jitter: jitter, pushSnap: pushSnap, bracket: bracket};
})();
