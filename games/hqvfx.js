/* Claude HQ: what your vehicle throws off (HQV.hqVfx; games/hq3d.js drives it): exhaust flames, nitrous, tyre smoke
 * and skid marks.
 *
 *   create(THREE, scene) -> fx
 *     fx.step(dt, s)  s = {x, y, z, yaw (the way it points), speed (m/s), back (m from its middle to the tail), w (half
 *                     width), bike, flame 0..1 (a pop, the limiter, a quickshift), nitro (bool), smoke 0..1 (wheelspin,
 *                     a burnout, a slide), skid 0..1 (marks on the road), ground(x, z) -> y, calm}
 *     fx.clear()      everything gone (another world, off the vehicle)   fx.dispose()   fx.drawCalls()
 *   Calm: no flames, no smoke, no new marks (the old ones fade as usual).
 * Draw calls: two flame sprites, one smoke Points, one skid mesh: at most 5, and only while something shows.
 * Nothing here is random: flicker and puff spread come from a hash of a running counter.
 */
(function(){
"use strict";
var HQV = (typeof window !== "undefined" ? window : globalThis).HQV = (typeof window !== "undefined" ? window : globalThis).HQV || {};

var PUFFS = 64;          // smoke particles in the pool
var MARKS = 700;         // skid mark segments kept (a ring), per wheel pair
var MARK_FADE = 90;      // s before an old mark is reused (it is simply overwritten)

function hash(n){ n = (n ^ 61) ^ (n >>> 16); n = n + (n << 3); n = n ^ (n >>> 4); n = Math.imul(n, 0x27d4eb2d); n = n ^ (n >>> 15); return (n >>> 0)/4294967296; }

function flameTexture(THREE, blue){
  var size = 64, c = typeof document !== "undefined" ? document.createElement("canvas") : null;
  if(!c) return null;
  c.width = c.height = size;
  var g = c.getContext("2d"); if(!g) return null;
  var grd = g.createRadialGradient(size/2, size/2, 0, size/2, size/2, size/2);
  if(blue){ grd.addColorStop(0, "rgba(220,240,255,1)"); grd.addColorStop(0.35, "rgba(90,150,255,0.9)"); grd.addColorStop(1, "rgba(30,60,255,0)"); }
  else { grd.addColorStop(0, "rgba(255,250,210,1)"); grd.addColorStop(0.3, "rgba(255,170,40,0.95)"); grd.addColorStop(0.65, "rgba(230,70,10,0.6)"); grd.addColorStop(1, "rgba(120,20,0,0)"); }
  g.fillStyle = grd; g.fillRect(0, 0, size, size);
  var t = new THREE.CanvasTexture(c); if(THREE.SRGBColorSpace) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
function puffTexture(THREE){
  var size = 64, c = typeof document !== "undefined" ? document.createElement("canvas") : null;
  if(!c) return null;
  c.width = c.height = size;
  var g = c.getContext("2d"); if(!g) return null;
  var grd = g.createRadialGradient(size/2, size/2, 2, size/2, size/2, size/2);
  grd.addColorStop(0, "rgba(235,235,235,0.9)"); grd.addColorStop(0.6, "rgba(210,210,210,0.45)"); grd.addColorStop(1, "rgba(200,200,200,0)");
  g.fillStyle = grd; g.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(c);
}

function create(THREE, scene){
  var group = new THREE.Group(); group.name = "hqvfx";
  if(scene) scene.add(group);
  var hot = flameTexture(THREE, false), cold = flameTexture(THREE, true);
  var fmat = new THREE.SpriteMaterial({map: hot, color: 0xffffff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false});
  var flames = [new THREE.Sprite(fmat), new THREE.Sprite(fmat)];
  flames.forEach(function(f){ f.visible = false; f.renderOrder = 3; group.add(f); });

  // smoke: one Points cloud, a pool of puffs that rise, drift and fade (colour toward the sky, the size by layer)
  var pPos = new Float32Array(PUFFS*3), pCol = new Float32Array(PUFFS*3), age = new Float32Array(PUFFS), life = new Float32Array(PUFFS), vel = new Float32Array(PUFFS*3);
  for(var i = 0; i < PUFFS; i++){ age[i] = 1e9; pPos[3*i + 1] = -1e4; }
  var pg = new THREE.BufferGeometry();
  pg.setAttribute("position", new THREE.BufferAttribute(pPos, 3)); pg.setAttribute("color", new THREE.BufferAttribute(pCol, 3));
  var pmat = new THREE.PointsMaterial({size: 2.6, map: puffTexture(THREE), vertexColors: true, transparent: true, opacity: 0.55, depthWrite: false, sizeAttenuation: true});
  var puffs = new THREE.Points(pg, pmat); puffs.frustumCulled = false; puffs.visible = false; group.add(puffs);
  var next = 0, emitAcc = 0, n = 0;

  // skid marks: a ring of quads (two wheels), dark, a hair above the road
  var mPos = new Float32Array(MARKS*2*6*3), mg = new THREE.BufferGeometry(), born = new Float32Array(MARKS);
  for(i = 0; i < mPos.length; i++) mPos[i] = 0;
  mg.setAttribute("position", new THREE.BufferAttribute(mPos, 3));
  var mmat = new THREE.MeshBasicMaterial({color: 0x101010, transparent: true, opacity: 0.55, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2});
  var marks = new THREE.Mesh(mg, mmat); marks.frustumCulled = false; marks.visible = false; marks.renderOrder = 1; group.add(marks);
  var mNext = 0, mUsed = 0, last = null, clock = 0;

  function quad(k, a0, a1, b0, b1){   // the k-th segment: from wheel points a0 -> a1 (left) and b0 -> b1 (right), 0.18 m wide
    var o = k*2*6*3;
    function strip(p0, p1, side){
      var dx = p1[0] - p0[0], dz = p1[2] - p0[2], L = Math.hypot(dx, dz) || 1, nx = -dz/L*0.09, nz = dx/L*0.09;
      var v = [p0[0] - nx, p0[1], p0[2] - nz, p0[0] + nx, p0[1], p0[2] + nz, p1[0] + nx, p1[1], p1[2] + nz,
               p0[0] - nx, p0[1], p0[2] - nz, p1[0] + nx, p1[1], p1[2] + nz, p1[0] - nx, p1[1], p1[2] - nz];
      for(var j = 0; j < 18; j++) mPos[o + side*18 + j] = v[j];
    }
    strip(a0, a1, 0); strip(b0, b1, 1);
  }

  function wheels(s){
    var fx = Math.sin(s.yaw), fz = Math.cos(s.yaw), lx = Math.cos(s.yaw), lz = -Math.sin(s.yaw), b = s.back*0.8, w = s.bike ? 0 : s.w*0.85;
    var gy = function(x, z){ return (s.ground ? s.ground(x, z) : s.y) + 0.03; };
    var ax = s.x - fx*b + lx*w, az = s.z - fz*b + lz*w, bx = s.x - fx*b - lx*w, bz = s.z - fz*b - lz*w;
    return [[ax, gy(ax, az), az], [bx, gy(bx, bz), bz]];
  }

  return {
    group: group,
    step: function(dt, s){
      dt = Math.max(0, Math.min(0.1, +dt || 0)); clock += dt; n++;
      s = s || {};
      var calm = !!s.calm, fx = Math.sin(s.yaw || 0), fz = Math.cos(s.yaw || 0), lx = Math.cos(s.yaw || 0), lz = -Math.sin(s.yaw || 0);
      // flames at the tailpipes: a car's two (either side of the middle), a bike's one on the right
      var fl = calm ? 0 : Math.max(+s.flame || 0, s.nitro ? 0.85 : 0);
      if(fl > 0.02 && s.back != null){
        fmat.map = s.nitro ? cold : hot;
        for(var k = 0; k < 2; k++){
          var f = flames[k], side = s.bike ? (k ? null : 0.22) : (k ? -1 : 1)*(s.w || 0.8)*0.35;
          if(side == null){ f.visible = false; continue; }
          var flick = 0.65 + 0.35*hash(n*7 + k*131), len = (s.nitro ? 1.25 : 0.75)*fl*flick;
          f.visible = true;
          f.position.set(s.x - fx*(s.back + len*0.35) + lx*side, (s.y || 0) + (s.bike ? 0.5 : 0.32), s.z - fz*(s.back + len*0.35) + lz*side);
          f.scale.set(0.28 + 0.4*len, 0.28 + 0.4*len, 1);
        }
      } else { flames[0].visible = false; flames[1].visible = false; }
      // smoke from the driven wheels while they spin or slide
      var sm = calm ? 0 : Math.max(0, Math.min(1, +s.smoke || 0));
      if(sm > 0.05 && s.back != null){
        emitAcc += dt*60*sm;
        var W = wheels(s);
        while(emitAcc >= 1){
          emitAcc -= 1;
          var i = next; next = (next + 1) % PUFFS; var src = W[(n + i) & 1], h1 = hash(n*31 + i), h2 = hash(n*17 + i*7);
          pPos[3*i] = src[0] + (h1 - 0.5)*0.5; pPos[3*i + 1] = src[1] + 0.25; pPos[3*i + 2] = src[2] + (h2 - 0.5)*0.5;
          vel[3*i] = -fx*(s.speed || 0)*0.15 + (h2 - 0.5)*1.2; vel[3*i + 1] = 0.7 + h1*0.6; vel[3*i + 2] = -fz*(s.speed || 0)*0.15 + (h1 - 0.5)*1.2;
          age[i] = 0; life[i] = 1.6 + h1*1.2;
        }
      }
      var any = false;
      for(i = 0; i < PUFFS; i++){
        if(age[i] >= life[i]){ if(pPos[3*i + 1] > -1e3){ pPos[3*i + 1] = -1e4; } continue; }
        any = true; age[i] += dt;
        var t = age[i]/life[i];
        pPos[3*i] += vel[3*i]*dt; pPos[3*i + 1] += vel[3*i + 1]*dt; pPos[3*i + 2] += vel[3*i + 2]*dt;
        vel[3*i] *= 0.97; vel[3*i + 2] *= 0.97;
        var c = 0.92 - 0.15*t; pCol[3*i] = pCol[3*i + 1] = pCol[3*i + 2] = c*(1 - t*0.7);
      }
      puffs.visible = any; if(any){ pg.attributes.position.needsUpdate = true; pg.attributes.color.needsUpdate = true; }
      // skid marks behind the rear wheels while they slip
      var sk = calm ? 0 : Math.max(0, Math.min(1, +s.skid || 0));
      if(sk > 0.25 && s.back != null){
        var Wn = wheels(s);
        if(last && Math.hypot(Wn[0][0] - last[0][0], Wn[0][2] - last[0][2]) > 0.35 && Math.hypot(Wn[0][0] - last[0][0], Wn[0][2] - last[0][2]) < 4){
          quad(mNext, last[0], Wn[0], last[1], Wn[1]); born[mNext] = clock; mNext = (mNext + 1) % MARKS; mUsed = Math.min(MARKS, mUsed + 1);
          mg.attributes.position.needsUpdate = true; marks.visible = true; last = Wn;
        } else if(!last || Math.hypot(Wn[0][0] - last[0][0], Wn[0][2] - last[0][2]) >= 4) last = Wn;
      } else last = null;
      if(mUsed && clock - born[(mNext + MARKS - 1) % MARKS] > MARK_FADE) { marks.visible = false; mUsed = 0; }
    },
    clear: function(){
      for(var i = 0; i < PUFFS; i++){ age[i] = 1e9; pPos[3*i + 1] = -1e4; }
      pg.attributes.position.needsUpdate = true; puffs.visible = false;
      flames[0].visible = flames[1].visible = false; marks.visible = false; mUsed = 0; last = null;
      for(i = 0; i < mPos.length; i++) mPos[i] = 0; mg.attributes.position.needsUpdate = true;
    },
    drawCalls: function(){ return (flames[0].visible ? 1 : 0) + (flames[1].visible ? 1 : 0) + (puffs.visible ? 1 : 0) + (marks.visible ? 1 : 0); },
    dispose: function(){
      if(group.parent) group.parent.remove(group);
      pg.dispose(); mg.dispose(); pmat.dispose(); mmat.dispose(); fmat.dispose();
      [hot, cold, pmat.map].forEach(function(t){ if(t) t.dispose(); });
    }
  };
}

HQV.hqVfx = {create: create, PUFFS: PUFFS, MARKS: MARKS};
})();
