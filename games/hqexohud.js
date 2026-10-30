/* Claude HQ: the exosuit's visor HUD (HQV.hqExoHud, HQ Exosuit) -- one 2D canvas over the 3D view.
 *
 *   create(container) -> {draw(state, cam, targets, frameId, tint), show(on), boot(), destroy()}
 * The canvas fills the container (DPR capped at 2, refitted when the container's size changes) and redraws at most
 * 30 times a second. state is an HQV.hqExoRide state; cam a THREE camera (targets are projected with Vector3.project
 * when window.THREE exists); targets [{x, y, z, label}]; tint a CSS colour. It draws the visor vignette, the pitch ladder
 * rolled with the horizon, the roll arc, heading, speed and altitude tapes, vertical speed, the thrust and boost rings,
 * the frame's name, the suit status outline, the radar, brackets on the targets with their distance and a lock on the
 * nearest centred one (display only: nothing fires), PULL UP when low and sinking, and, after boot(), the diagnostics.
 */
(function(){
"use strict";
var G = typeof window !== "undefined" ? window : globalThis;
var HQV = G.HQV = G.HQV || {};
var PI = Math.PI, DEG = 180/PI;
var LOG = ["PWR CORE .......... 98%", "THRUSTERS L/R ..... OK", "GYRO / IMU ........ OK", "SENSOR ARRAY ...... OK",
           "VISOR LINK ........ HQ-NET", "FLIGHT ENVELOPE ... NOMINAL"];
var FONT = "11px 'IBM Plex Mono', monospace";

function now(){ return G.performance && G.performance.now ? G.performance.now() : Date.now(); }
function n0(v){ v = +v; return isFinite(v) ? v : 0; }

function create(container){
  var doc = G.document, cv = doc.createElement("canvas"), cx = cv.getContext("2d");
  cv.className = "hq-exo-hud";
  cv.style.cssText = "position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;z-index:5";
  if(container && container.appendChild) container.appendChild(cv);
  var W = 0, Hh = 0, dpr = 1, on = true, last = -1e9, bootT = -1e9, lock = 0, lockT = null, lastT = 0, V3 = null;

  function fit(){
    var r = container && container.getBoundingClientRect ? container.getBoundingClientRect() : {width: 0, height: 0};
    var w = Math.max(1, Math.round(n0(r.width) || n0(container && container.clientWidth) || 1)),
        hh = Math.max(1, Math.round(n0(r.height) || n0(container && container.clientHeight) || 1)),
        d = Math.min(2, n0(G.devicePixelRatio) || 1);
    if(w === W && hh === Hh && d === dpr) return;
    W = w; Hh = hh; dpr = d; cv.width = Math.round(w*d); cv.height = Math.round(hh*d);
  }

  function draw(S, cam, targets, frameId, tint){
    var tn = now();
    if(!on || !S || tn - last < 1000/30 - 0.5) return;
    var dt = Math.min(0.2, Math.max(0, (tn - last)/1000)); last = tn;
    fit();
    var c = tint || "#7fd3ea", t = tn/1000, cxm = W/2, cym = Hh/2;
    var roll = n0(S.roll), pitch = n0(S.pitch), yaw = n0(S.yaw), spd = n0(S.speed), y = n0(S.y), vs = n0(S.vs),
        boost = Math.max(0, Math.min(1, n0(S.boost))), boosting = !!S.boosting,
        agl = S.agl === undefined ? y : n0(S.agl);
    var R = HQV.hqExoRide, F = R && R.STATS && R.STATS[frameId], top = F ? F.top : 100,
        name = F ? F.n : String(frameId || "suit");
    cx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cx.clearRect(0, 0, W, Hh);
    var bk = Math.min(1, (tn - bootT)/1400);            // fades in after boot()
    // the visor: dark curved edges, a faint tint
    var vg = cx.createRadialGradient(cxm, cym, Math.min(W, Hh)*.42, cxm, cym, Math.max(W, Hh)*.72);
    vg.addColorStop(0, "rgba(0,0,0,0)"); vg.addColorStop(1, "rgba(2,6,10,.9)");
    cx.globalAlpha = 1; cx.fillStyle = vg; cx.fillRect(0, 0, W, Hh); cx.fillStyle = c; cx.globalAlpha = .04; cx.fillRect(0, 0, W, Hh);
    cx.strokeStyle = c; cx.fillStyle = c; cx.lineWidth = 1.3; cx.font = FONT; cx.globalAlpha = .9*bk;
    cx.shadowColor = "rgba(0,8,14,.75)"; cx.shadowBlur = 3;
    var sh = boosting ? (Math.random() - .5)*2 : 0; cx.save(); cx.translate(sh, sh);
    // pitch ladder, rolled with the horizon
    var ppd = Hh/72;
    cx.save(); cx.beginPath(); cx.rect(cxm - W*.22, cym - Hh*.3, W*.44, Hh*.6); cx.clip(); cx.translate(cxm, cym); cx.rotate(-roll);
    for(var pd = -30; pd <= 30; pd += 5){
      var ly = (pitch*DEG - pd)*ppd, wd = pd ? 46 : W*.2; cx.globalAlpha = (pd ? .55 : .9)*bk;
      if(pd < 0) cx.setLineDash([6, 5]);
      cx.beginPath(); cx.moveTo(-wd, ly); cx.lineTo(-14, ly); cx.moveTo(14, ly); cx.lineTo(wd, ly); cx.stroke(); cx.setLineDash([]);
      if(pd){ cx.textAlign = "left"; cx.fillText(String(pd), wd + 5, ly + 4); }
    }
    cx.restore(); cx.globalAlpha = .95*bk;
    cx.beginPath(); cx.arc(cxm, cym, 7, 0, 7); cx.moveTo(cxm - 20, cym); cx.lineTo(cxm - 7, cym); cx.moveTo(cxm + 7, cym); cx.lineTo(cxm + 20, cym);
    cx.moveTo(cxm, cym - 7); cx.lineTo(cxm, cym - 13); cx.stroke();
    // roll arc
    cx.beginPath(); cx.arc(cxm, cym, Hh*.36, -PI*.72, -PI*.28); cx.globalAlpha = .4*bk; cx.stroke(); cx.globalAlpha = .95*bk;
    var ra = -PI/2 - roll; cx.beginPath(); cx.moveTo(cxm + Math.cos(ra)*Hh*.36, cym + Math.sin(ra)*Hh*.36);
    cx.lineTo(cxm + Math.cos(ra)*Hh*.33, cym + Math.sin(ra)*Hh*.33); cx.lineWidth = 3; cx.stroke(); cx.lineWidth = 1.3;
    // heading tape
    var hdg = ((-yaw*DEG) % 360 + 360) % 360; cx.textAlign = "center";
    for(var hd = -50; hd <= 50; hd += 5){
      var v = Math.round(hdg/5)*5 + hd, x = cxm + (v - hdg)*4.2; if(Math.abs(x - cxm) > W*.2) continue;
      cx.fillRect(x, 26, 1, v % 15 ? 5 : 9);
      if(!(v % 15)){ var vv = (v + 360) % 360; cx.fillText(String({0: "N", 90: "E", 180: "S", 270: "W"}[vv] || vv), x, 50); }
    }
    cx.strokeRect(cxm - 22, 54, 44, 17); cx.fillText(("00" + Math.round(hdg) % 360).slice(-3), cxm, 67);
    // speed (left) and altitude (right) tapes
    function tape(x, val, stp, unit, left){
      var hh = Hh*.42, tp = cym - hh/2; cx.globalAlpha = .35*bk; cx.beginPath(); cx.moveTo(x, tp); cx.lineTo(x, tp + hh); cx.stroke(); cx.globalAlpha = .85*bk;
      cx.textAlign = left ? "right" : "left";
      for(var k = -6; k <= 6; k++){
        var tv = Math.round(val/stp)*stp + k*stp, ty = cym - (tv - val)/stp*hh/12; if(ty < tp || ty > tp + hh) continue;
        cx.fillRect(left ? x - 8 : x, ty, 8, 1); cx.fillText(String(tv), left ? x - 12 : x + 12, ty + 4);
      }
      cx.globalAlpha = bk; cx.fillStyle = "rgba(2,8,12,.75)"; cx.fillRect(left ? x - 74 : x + 4, cym - 11, 70, 22); cx.fillStyle = c;
      cx.strokeRect(left ? x - 74 : x + 4, cym - 11, 70, 22);
      cx.textAlign = "center"; cx.fillText(Math.round(val) + " " + unit, left ? x - 39 : x + 39, cym + 4);
    }
    tape(cxm - W*.3, spd*3.6, 20, "KM/H", 1); tape(cxm + W*.3, y, 20, "M", 0);
    cx.textAlign = "center"; cx.fillText("VS " + (vs >= 0 ? "+" : "") + Math.round(vs) + " M/S", cxm + W*.3 + 39, cym + 30);
    // targets: brackets on each one in view, a lock on the nearest centred one (display only)
    var T = G.THREE, best = 1e9, tgt = null, shown = [];
    (Array.isArray(targets) ? targets : []).forEach(function(o){
      if(!o) return;
      var ox = n0(o.x), oy = n0(o.y), oz = n0(o.z), dist = Math.hypot(ox - n0(S.x), oy - y, oz - n0(S.z)), D = {o: o, dist: dist, on: false};
      if(T && cam && T.Vector3){
        V3 = V3 || new T.Vector3(); var p = V3.set(ox, oy, oz).project(cam);
        D.sx = p.x; D.sy = p.y; D.on = p.z < 1 && Math.abs(p.x) < 1 && Math.abs(p.y) < 1 && isFinite(p.x) && isFinite(p.y);
        if(D.on && Math.hypot(p.x, p.y) < .35 && dist < best){ best = dist; tgt = D; }
      }
      shown.push(D);
    });
    lock = tgt && lockT === tgt.o ? Math.min(1, lock + dt*1.5) : 0; lockT = tgt ? tgt.o : null;
    shown.forEach(function(D){
      if(!D.on) return;
      var x = cxm + D.sx*W/2, yy = cym - D.sy*Hh/2, s = Math.max(9, Math.min(60, 900/Math.max(1, D.dist)));
      cx.globalAlpha = .7*bk; cx.strokeRect(x - s, yy - s, s*2, s*2); cx.textAlign = "left";
      cx.fillText(Math.round(D.dist) + "M" + (D.o.label ? " " + String(D.o.label).toUpperCase() : ""), x + s + 4, yy - s + 9);
      if(D === tgt){
        cx.globalAlpha = bk; var L = s + 14 - lock*8; cx.beginPath();
        for(var k = 0; k < 4; k++){ var ax = k % 2 ? 1 : -1, ay = k > 1 ? 1 : -1;
          cx.moveTo(x + ax*L, yy + ay*(L - 8)); cx.lineTo(x + ax*L, yy + ay*L); cx.lineTo(x + ax*(L - 8), yy + ay*L); }
        cx.lineWidth = 2; cx.stroke(); cx.lineWidth = 1.3;
        cx.fillText(lock >= 1 ? "LOCKED · " + String(D.o.label || "TARGET").toUpperCase() : "LOCKING…", x + s + 4, yy + s);
      }
    });
    cx.globalAlpha = .95*bk;
    // bottom left: thrust and boost rings, the frame
    var bx = 70, by = Hh - 66; cx.globalAlpha = .3*bk; cx.beginPath(); cx.arc(bx, by, 30, 0, 7); cx.stroke(); cx.globalAlpha = .95*bk; cx.lineWidth = 4;
    cx.beginPath(); cx.arc(bx, by, 30, -PI/2, -PI/2 + 6.283*Math.max(0, Math.min(1, Math.abs(spd)/(top*1.8)))); cx.stroke();
    cx.lineWidth = 3; cx.globalAlpha = .6*bk; cx.beginPath(); cx.arc(bx, by, 22, -PI/2, -PI/2 + 6.283*boost); cx.stroke(); cx.lineWidth = 1.3; cx.globalAlpha = .95*bk;
    cx.textAlign = "center"; cx.fillText("THR", bx, by + 4); cx.textAlign = "left";
    cx.fillText(name.toUpperCase() + (S.mode ? " · " + String(S.mode).toUpperCase() : ""), bx + 42, by - 8);
    cx.fillText(boosting ? "BOOST" : "BOOST " + Math.round(boost*100) + "%", bx + 42, by + 8);
    cx.fillText("PWR " + (92 - Math.round(t % 40)/4).toFixed(0) + "%", bx + 42, by + 24);
    // suit status: a small outline, one plate scuffed
    var sx = bx + 140, sy = Hh - 104, parts = [[0, 0, 10, 10], [-2, 12, 14, 22], [-10, 12, 6, 20], [16, 12, 6, 20], [-1, 35, 6, 24], [7, 35, 6, 24]];
    parts.forEach(function(p, i){ cx.globalAlpha = .9*bk; cx.strokeStyle = i === 2 ? "#ffb547" : c; cx.strokeRect(sx + p[0], sy + p[1], p[2], p[3]); });
    cx.strokeStyle = c; cx.fillText("L ARM 72%", sx + 30, sy + 26);
    // bottom right: radar, the targets relative to your heading
    var rx = W - 74, ry = Hh - 70, rr = 46; cx.globalAlpha = .35*bk; cx.beginPath(); cx.arc(rx, ry, rr, 0, 7); cx.arc(rx, ry, rr/2, 0, 7); cx.stroke();
    cx.globalAlpha = .25*bk; cx.beginPath(); cx.moveTo(rx, ry); cx.arc(rx, ry, rr, t*2 % 6.283 - .5, t*2 % 6.283); cx.closePath(); cx.fill(); cx.globalAlpha = .95*bk;
    var cs = Math.cos(yaw), sn = Math.sin(yaw), kr = rr/450;
    shown.forEach(function(D){
      var dx = n0(D.o.x) - n0(S.x), dz = n0(D.o.z) - n0(S.z), lx = dx*cs - dz*sn, lz = dx*sn + dz*cs;
      if(Math.hypot(lx, lz)*kr > rr) return; cx.fillStyle = "#ff5a5a"; cx.fillRect(rx + lx*kr - 2, ry + lz*kr - 2, 4, 4);
    });
    cx.fillStyle = c; cx.beginPath(); cx.moveTo(rx, ry - 6); cx.lineTo(rx - 4, ry + 4); cx.lineTo(rx + 4, ry + 4); cx.fill();
    // warnings
    cx.textAlign = "center";
    if(S.mode === "cruise" && agl < 40 && vs < -1 && Math.floor(t*3) % 2){
      cx.fillStyle = "#ff5a5a"; cx.font = "700 16px 'Oxanium', sans-serif"; cx.fillText("PULL UP", cxm, cym - 60); cx.font = FONT; cx.fillStyle = c;
    }
    cx.restore();
    // boot diagnostics, bottom right above the radar
    var bt = tn - bootT;
    if(bt >= 0 && bt < 4200){
      var m = 14, nl = Math.min(LOG.length, Math.floor(bt/170)); cx.textAlign = "right"; cx.fillStyle = c;
      for(var i = 0; i < nl; i++){ cx.globalAlpha = Math.max(0, Math.min(1, 1 - (bt - 2600)/1600)); cx.fillText(LOG[i], W - m - 8, Hh - 140 - (nl - 1 - i)*14); }
      if(bt < 1400){ cx.globalAlpha = 1 - bk; cx.textAlign = "center"; cx.fillText(name.toUpperCase() + " ONLINE", cxm, cym + 60); }
    }
    cx.globalAlpha = 1; cx.shadowBlur = 0;
  }

  return {
    canvas: cv,
    draw: draw,
    show: function(v){ on = !!v; cv.style.display = on ? "" : "none"; if(!on){ cx.setTransform(1, 0, 0, 1, 0, 0); cx.clearRect(0, 0, cv.width, cv.height); } else last = -1e9; },
    boot: function(){ bootT = now(); last = -1e9; },
    destroy: function(){ on = false; if(cv.parentNode) cv.parentNode.removeChild(cv); }
  };
}

HQV.hqExoHud = {create: create, LOG: LOG};
})();
