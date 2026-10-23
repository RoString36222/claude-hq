/* Claude HQ: the HQ tower (HQV.hqTower), the HQ revamp's grander building, styled by HQ Studio (games/hqstyle.js).
 *
 * The building every HQ shows, at its Base and on every City lot (HQV.hqBuilding, games/hqbase.js, is this make()):
 * a stone plinth and steps, a double-height podium with the grand entrance (canopy, portico, arch, glass box or
 * torii; a revolving door, planters and flag poles), the tower in setback tiers that grow with the HQ level, wings
 * (level 10 and 30) and skybridges, a crown, rooftop extras and, always, a helipad on the roof. Its facade system
 * (Glass Modern, Art Deco, Brutalist, Neo-Tokyo, Classic Stone, Eco Green), colours, glass tint, sign font and
 * colour, night light, flags and landscaping come from the owner's style (look.style; HQV.hqStyle.clean()).
 *
 * Cheap by construction: every static part is batched into one mesh per material as it is built (kit()), the
 * facade is one shared tile texture per style and colour (window mullions, spandrels and sky reflections painted
 * in, lit windows on a matching emissive tile), the flags and pad lights are instanced. A far tower (setLod(1))
 * shows only its masses. The look is HQV.hqStyle's; nothing here reads the network.
 *
 * Pure parts (node-tested, tests/test_hqtower.py):
 *   massing(level, grand, stars, room) -> {podium, tiers, wings, roof, pad, top}: the building's boxes (m, its own frame,
 *     door to +z). grand 0..1 is how much bigger than the old tower a lot allows (+18% wide, +8% deep at 1);
 *     every tier is a floor-height multiple; heli (x, z, r, y): the helideck, raised HELI_UP over the top roof on
 *     legs and cantilevered past it; the pad (x, z, r, y) in its middle, clear for a helicopter's rotor: r = PAD_R, or
 *     less (to PAD_MIN) where the lot holds less room (the largest disc round the roof's middle inside it).
 *   footprint(grand, wings) -> [[cx, cz, hx, hz]]: the tower, its entrance apron, then each wing (what a lot's
 *     car-lift bay and its run out must keep clear of; hqcity3d's garagePlace and hqBoxes).
 *   crownSlots(M) -> [{x, z}]: where the roof lift, a crown's and the roof extras' pieces stand (the helideck's
 *     walkway, on its diagonals): never on the pad.
 *   roofDeck(M) -> {x, z, hw, hd, r, y}: the helideck you can walk on (a disc of radius r, inside its rail).
 */
(function(){
"use strict";
var HQV = window.HQV = window.HQV || {};
var PI = Math.PI;

var FH = 2.9;              // a floor (m)
var PODIUM_H = 5;          // the double-height lobby
var PLINTH = 0.3;
var CORNICE = 0.4;
var TILE_W = 4.8, TILE_H = 4*FH;   // the facade tile: 4 bays of 1.2 m by 4 floors
var POD_W = 4.8, POD_H = PODIUM_H; // the podium's tile: 2 bays of 2.4 m, the full height
var LOD_FAR = 1;
var PAD_R = 9;              // the helipad's radius (m): a helicopter's rotor (5.4 m, the attack's 6) with room round it
var PAD_MIN = 7.5;         // on a small lot no less (the walkway may then reach out over the pavement)
var WALK = 1.6;            // the helideck's walkway round the pad
var HELI_UP = 3.0;         // the helideck over the top roof

/* ---------- the shape (pure) ---------- */
function clamp(v, a, b){ return v < a ? a : v > b ? b : v; }
function massing(level, grand, stars, room){
  level = Math.max(1, level | 0); grand = clamp(+grand || 0, 0, 1); stars = clamp(stars | 0, 0, 5);
  var W0 = 9*(1 + 0.18*grand), D0 = 7*(1 + 0.08*grand);
  var pod = {x: 0, z: 0, w: W0, d: D0, y0: PLINTH, h: PODIUM_H};
  var y = PLINTH + PODIUM_H + CORNICE, tiers = [];
  var floorsLow = Math.min(8, 1 + Math.floor(level/5)), floorsHigh = level >= 25 ? Math.min(8, 1 + Math.floor((level - 25)/4)) : 0;
  var t1 = {x: 0, z: 0, w: W0 - 0.8, d: D0 - 0.6, y0: y, floors: floorsLow, h: floorsLow*FH}; tiers.push(t1); y += t1.h;
  if(floorsHigh){ var t2 = {x: 0, z: -0.35, w: t1.w*0.72, d: t1.d*0.74, y0: y + 0.5, floors: floorsHigh, h: floorsHigh*FH}; tiers.push(t2); y = t2.y0 + t2.h; }
  if(level >= 45 && floorsHigh){ var t2b = tiers[tiers.length - 1], t3 = {x: 0, z: t2b.z, w: t2b.w*0.88, d: t2b.d*0.92, y0: y + 0.5, floors: 1, h: FH}; tiers.push(t3); y = t3.y0 + t3.h; }
  var last = tiers[tiers.length - 1], prest = null;
  if(stars){ prest = {x: last.x, z: last.z, w: last.w - 0.2, d: last.d - 0.2, y0: y + 0.3, floors: stars, h: stars*2.4}; y = prest.y0 + prest.h + 0.3; }
  var R = prest || last, roof = {x: R.x, z: R.z, w: R.w, d: R.d, y: y};
  // 3.13.4: the helideck, a steel deck raised HELI_UP over the top roof on legs and cantilevered past it (no top roof
  // is near big enough for a helicopter's rotor), the pad (PAD_R) in its middle, a walkway (WALK) round it
  // room: the biggest disc round the roof's middle the lot holds (hqcity3d roomOf; null: any): the pad keeps inside it
  var pr = room != null && isFinite(+room) ? clamp(+room - 0.6, PAD_MIN, PAD_R) : PAD_R;
  var hy = y + HELI_UP, pad = {x: R.x, z: R.z, r: pr, y: hy + 0.02};
  var heli = {x: R.x, z: R.z, r: pr + WALK, y: hy, base: y};
  var wings = [], floorsW = Math.max(1, floorsLow - 2);
  [[-1, 10], [1, 30]].forEach(function(s){
    if(level < s[1]) return;
    wings.push({x: s[0]*(10.5 + 1.6*grand), z: 0.5, w: 5.5 + 0.8*grand, d: 5 + 0.4*grand, y0: PLINTH, h: PODIUM_H + CORNICE + floorsW*FH, floors: floorsW, side: s[0]});
  });
  return {level: level, grand: grand, podium: pod, tiers: tiers, prestige: prest, roof: roof, pad: pad, heli: heli, wings: wings, top: y, lowTop: t1.y0 + t1.h};
}
function footprint(grand, wings){
  grand = clamp(+grand || 0, 0, 1);
  var hx = 4.5*(1 + 0.18*grand) + 0.3, hz = 3.5*(1 + 0.08*grand) + 0.3;
  var out = [[0, 0, hx, hz], [0, hz + 1.25, Math.min(hx, 4.4), 1.25]];
  if(wings >= 1) out.push([-(10.5 + 1.6*grand), 0.5, 3 + 0.4*grand, 2.8 + 0.2*grand]);
  if(wings >= 2) out.push([10.5 + 1.6*grand, 0.5, 3 + 0.4*grand, 2.8 + 0.2*grand]);
  return out;
}
// the helideck's four diagonals (qx, qz: the old corners' signs), on its walkway's outer edge, past the pad's circle
// (+0.75 m): the roof lift's head house, the crown and the roof extras stand here, never on the pad or under the rotor
function crownSlots(M){
  var H = M.heli, rs = H.r - 0.75, k = Math.SQRT1_2, out = [];
  [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(function(q){ out.push({x: H.x + q[0]*rs*k, z: H.z + q[1]*rs*k, qx: q[0], qz: q[1]}); });
  return out;
}
// the deck you walk: the helideck's disc inside its rail (r; hw/hd: its bounding square)
function roofDeck(M){ var H = M.heli, r = H.r - 0.3; return {x: H.x, z: H.z, hw: r, hd: r, r: r, y: H.y}; }

/* ---------- colours ---------- */
var TINT = {clear: ["#9fb8c8", "#dfeef5"], blue: ["#244e74", "#8fc3e6"], green: ["#2a5c50", "#9fdcc4"], bronze: ["#5a3f25", "#d9b48a"],
  grey: ["#33393f", "#a9b4bd"], gold: ["#6e5420", "#f0d58a"], rose: ["#5e2c48", "#f0a8c8"]};
var MATERIAL = {glass: {rough: 0.25, metal: 0.4}, steel: {rough: 0.35, metal: 0.7}, concrete: {rough: 0.9, metal: 0.02}, limestone: {rough: 0.8, metal: 0.02},
  brick: {rough: 0.85, metal: 0.02}, timber: {rough: 0.75, metal: 0.02}, marble: {rough: 0.3, metal: 0.05}, ceramic: {rough: 0.4, metal: 0.1}};
var FONT = {sans: "700 {s}px system-ui, -apple-system, sans-serif", serif: "700 {s}px Georgia, 'Times New Roman', serif", mono: "700 {s}px ui-monospace, Menlo, monospace",
  deco: "600 {s}px Futura, 'Avenir Next', 'Trebuchet MS', sans-serif", script: "italic 700 {s}px 'Snell Roundhand', 'Brush Script MT', cursive"};
function hexN(h){ return parseInt(String(h).slice(1), 16) | 0; }
function shade(hex, k){ var n = hexN(hex); return "rgb(" + [n >> 16 & 255, n >> 8 & 255, n & 255].map(function(v){ return Math.round(clamp(v*k, 0, 255)); }).join(",") + ")"; }

/* ---------- the facade tiles: one per (style, kind), shared by every building that wears it ---------- */
var TEX = {};
function material(g, X, x, y, w, h, R){
  var m = X.material, body = X.body;
  g.fillStyle = body; g.fillRect(x, y, w, h);
  var i, n;
  if(m === "brick"){ g.fillStyle = "rgba(0,0,0,.22)"; for(var by = y; by < y + h; by += 6){ g.fillRect(x, by, w, 1); for(var bx = x + ((by/6) & 1 ? 0 : 6); bx < x + w; bx += 12) g.fillRect(bx, by, 1, 6); } }
  else if(m === "concrete"){ for(i = 0, n = w*h/30; i < n; i++){ g.fillStyle = R() < 0.5 ? "rgba(0,0,0,.08)" : "rgba(255,255,255,.07)"; g.fillRect(x + R()*w, y + R()*h, 2, 2); } }
  else if(m === "limestone" || m === "marble"){ g.fillStyle = "rgba(0,0,0,.12)"; for(var ly = y; ly < y + h; ly += 16) g.fillRect(x, ly, w, 1);
    if(m === "marble"){ g.strokeStyle = "rgba(255,255,255,.25)"; g.lineWidth = 1; for(i = 0; i < 3; i++){ g.beginPath(); g.moveTo(x + R()*w, y); g.lineTo(x + R()*w, y + h); g.stroke(); } } }
  else if(m === "timber"){ for(var tx = x; tx < x + w; tx += 5){ g.fillStyle = (tx/5) & 1 ? "rgba(70,40,15,.18)" : "rgba(255,220,170,.08)"; g.fillRect(tx, y, 3, h); } }
  else if(m === "steel"){ for(var sy = y; sy < y + h; sy += 3){ g.fillStyle = "rgba(255,255,255," + (0.03 + R()*0.05) + ")"; g.fillRect(x, sy, w, 1); } }
  else if(m === "ceramic"){ g.fillStyle = "rgba(255,255,255,.12)"; for(var cy = y; cy < y + h; cy += 8) g.fillRect(x, cy, w, 1); for(var cx = x; cx < x + w; cx += 8) g.fillRect(cx, y, 1, h); }
}
function glassPane(g, X, x, y, w, h){
  var T = TINT[X.tint] || TINT.blue, gr = g.createLinearGradient(x, y, x + w*0.6, y + h);
  gr.addColorStop(0, T[1]); gr.addColorStop(0.35, T[0]); gr.addColorStop(1, shade(T[0].length === 7 ? T[0] : "#244e74", 0.55));
  g.fillStyle = gr; g.fillRect(x, y, w, h);
  g.fillStyle = "rgba(255,255,255,.16)"; g.beginPath(); g.moveTo(x, y + h*0.55); g.lineTo(x + w*0.55, y); g.lineTo(x + w*0.8, y); g.lineTo(x, y + h*0.85); g.fill();   // the sky's reflection
}
// the window rectangles (px) of a tile, by facade system: [{x, y, w, h, arch}]
function windows(F, kind, W, H){
  var out = [], c, f;
  if(kind === "podium"){
    for(c = 0; c < 2; c++){ var px = c*128;
      if(F === "stone" || F === "deco") out.push({x: px + 22, y: 26, w: 84, h: 196, arch: F === "stone"});
      else if(F === "brutal") out.push({x: px + 26, y: 60, w: 76, h: 150});
      else out.push({x: px + 6, y: 10, w: 116, h: 226});
    }
    return out;
  }
  for(f = 0; f < 4; f++) for(c = 0; c < 4; c++){
    var x0 = c*64, y0 = f*128;
    if(F === "glass") out.push({x: x0 + 2, y: y0 + 18, w: 60, h: 108});
    else if(F === "deco") out.push({x: x0 + 16, y: y0 + 22, w: 32, h: 92});
    else if(F === "brutal") out.push({x: x0 + 14, y: y0 + 40, w: 36, h: 56});
    else if(F === "tokyo") out.push({x: x0 + 3, y: y0 + 14, w: 58, h: 96});
    else if(F === "stone") out.push({x: x0 + 14, y: y0 + 30, w: 36, h: 80, arch: true});
    else out.push({x: x0 + 8, y: y0 + 20, w: 48, h: 84});
  }
  return out;
}
function winPath(g, wn){ g.beginPath(); if(wn.arch){ var r = wn.w/2; g.moveTo(wn.x, wn.y + wn.h); g.lineTo(wn.x, wn.y + r); g.arc(wn.x + r, wn.y + r, r, PI, 0); g.lineTo(wn.x + wn.w, wn.y + wn.h); g.closePath(); } else g.rect(wn.x, wn.y, wn.w, wn.h); }
function drawTile(c, X, kind){
  var W = 256, H = kind === "podium" ? 256 : 512, F = X.facade, R = c.rng(c.hashStr("fac:" + F + kind + X.material));
  return c.canvasTex(W, H, function(g){
    material(g, X, 0, 0, W, H, R);
    var wins = windows(F, kind, W, H);
    wins.forEach(function(wn){
      if(F === "brutal"){ g.fillStyle = "rgba(0,0,0,.45)"; g.fillRect(wn.x - 6, wn.y - 6, wn.w + 12, wn.h + 12); }   // the deep reveal
      g.save(); winPath(g, wn); g.clip(); glassPane(g, X, wn.x, wn.y, wn.w, wn.h); g.restore();
      g.fillStyle = shade(X.trim, 0.8);                                                                       // mullions and transoms
      if(F === "glass" || F === "tokyo" || kind === "podium"){ g.fillRect(wn.x + wn.w/2 - 1, wn.y, 2, wn.h); g.fillRect(wn.x, wn.y + wn.h*0.7, wn.w, 2); }
      else g.fillRect(wn.x + wn.w/2 - 1, wn.y, 2, wn.h);
      if(wn.arch){ g.fillStyle = X.trim; g.fillRect(wn.x + wn.w/2 - 4, wn.y - 6, 8, 10); }                    // the keystone
    });
    var fl = kind === "podium" ? 1 : 4, fhpx = H/fl;
    for(var f = 0; f < fl; f++){
      var sy = f*fhpx;
      if(F === "glass"){ g.fillStyle = shade(X.body, 0.85); g.fillRect(0, sy, W, 14); g.fillStyle = "rgba(255,255,255,.12)"; g.fillRect(0, sy, W, 2); }      // the spandrel band
      else if(F === "deco"){ g.fillStyle = X.trim; for(var cc = 0; cc < 4; cc++){ var cx = cc*64 + 32; g.beginPath(); g.moveTo(cx - 14, sy + 16); g.lineTo(cx, sy + 6); g.lineTo(cx + 14, sy + 16); g.lineTo(cx + 10, sy + 16); g.lineTo(cx, sy + 10); g.lineTo(cx - 10, sy + 16); g.fill(); } }
      else if(F === "brutal"){ g.fillStyle = "rgba(0,0,0,.18)"; g.fillRect(0, sy + fhpx - 14, W, 14); }
      else if(F === "tokyo"){ g.fillStyle = X.trim; g.fillRect(0, sy + fhpx - 8, W, 3); }
      else if(F === "stone"){ g.fillStyle = shade(X.body, 1.15); g.fillRect(0, sy + fhpx - 10, W, 6); g.fillStyle = "rgba(0,0,0,.2)"; g.fillRect(0, sy + fhpx - 4, W, 2); }
      else if(F === "eco"){ for(var pl = 0; pl < W; pl += 6){ g.fillStyle = R() < 0.5 ? "#3f8f4a" : "#2f6b3a"; g.fillRect(pl, sy + fhpx - 16 + R()*6, 5, 10 + R()*8); } }
    }
    if(F === "deco" || F === "stone"){ g.fillStyle = "rgba(0,0,0,.14)"; for(var p = 0; p < W; p += kind === "podium" ? 128 : 64) g.fillRect(p, 0, 3, H); }   // piers
  });
}
// the night tile: the body dim, windows lit (share in tenths) in the night colour, Neo-Tokyo's neon always on
function drawNight(c, X, kind, share){
  var W = 256, H = kind === "podium" ? 256 : 512, R = c.rng(c.hashStr("lit:" + X.facade + kind)), F = X.facade;
  return c.canvasTex(W, H, function(g){
    g.fillStyle = shade(X.body, 0.12); g.fillRect(0, 0, W, H);
    windows(F, kind, W, H).forEach(function(wn){
      var on = kind === "podium" || R() < share/10;
      if(on){ var lg = g.createLinearGradient(0, wn.y, 0, wn.y + wn.h); lg.addColorStop(0, "#ffffff"); lg.addColorStop(0.12, X.night); lg.addColorStop(1, shade(X.night, 0.45)); g.fillStyle = lg; }
      else g.fillStyle = R() < 0.25 ? shade(X.night, 0.12) : "#020406";                    // a dim room now and then
      winPath(g, wn); g.fill();
      g.fillStyle = "rgba(0,0,0,.55)"; g.fillRect(wn.x + wn.w/2 - 1, wn.y, 2, wn.h);                // the mullion, dark against the light
      if(on && kind !== "podium" && R() < 0.5){ g.fillStyle = "rgba(0,0,0,.5)"; var px = wn.x + 4 + R()*(wn.w - 14); g.beginPath(); g.arc(px + 4, wn.y + wn.h - 22, 4, 0, 7); g.fill(); g.fillRect(px, wn.y + wn.h - 17, 8, 17); }
    });
    if(F === "tokyo"){ g.fillStyle = X.trim; for(var f = 0; f < 4; f++) g.fillRect(0, f*128 + 120, W, 3); }
  });
}
// the cache keeps the newest TEX_MAX tiles (HQ Studio's colour pickers make a new one per colour): an older one is
// dropped and its GPU copy freed (a building still wearing it uploads it again; its canvas is kept). Shared: never
// disposed with a building (userData.shared, the Studio preview's rebuilds)
var TEX_N = [], TEX_MAX = 64;
function keepTex(k, t){
  t.userData.shared = true; TEX[k] = t; TEX_N.push(k);
  while(TEX_N.length > TEX_MAX){ var o = TEX_N.shift(); if(TEX[o]){ try { TEX[o].dispose(); } catch(e){} delete TEX[o]; } }
  return t;
}
function tile(c, X, kind){ var k = ["map", kind, X.facade, X.material, X.body, X.trim, X.tint].join("|"); return TEX[k] || keepTex(k, drawTile(c, X, kind).t); }
function nightTile(c, X, kind, share){ var k = ["emi", kind, X.facade, X.body, X.trim, X.night, share].join("|"); return TEX[k] || keepTex(k, drawNight(c, X, kind, share).t); }

/* ---------- batching: one mesh per material ---------- */
function kit(THREE){
  var B = {}, order = [], m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), s = new THREE.Vector3(1, 1, 1), p = new THREE.Vector3();
  function put(key, geo, x, y, z, rx, ry, rz, sx, sy, sz){
    if(!B[key]){ B[key] = []; order.push(key); }
    e.set(rx || 0, ry || 0, rz || 0); q.setFromEuler(e); p.set(x || 0, y || 0, z || 0); s.set(sx || 1, sy || 1, sz || 1);
    m4.compose(p, q, s); geo.applyMatrix4(m4); B[key].push(geo);
  }
  function merged(list){
    var nv = 0, ni = 0;
    list.forEach(function(gg){ nv += gg.attributes.position.count; ni += gg.index ? gg.index.count : gg.attributes.position.count; });
    var pos = new Float32Array(nv*3), nor = new Float32Array(nv*3), uv = new Float32Array(nv*2), idx = new (nv > 65535 ? Uint32Array : Uint16Array)(ni), v0 = 0, i0 = 0;
    list.forEach(function(gg){
      var P = gg.attributes.position, N = gg.attributes.normal, U = gg.attributes.uv, n = P.count;
      pos.set(P.array, v0*3); if(N) nor.set(N.array, v0*3); if(U) uv.set(U.array, v0*2);
      if(gg.index){ var I = gg.index.array; for(var k = 0; k < I.length; k++) idx[i0 + k] = I[k] + v0; i0 += I.length; }
      else { for(var k2 = 0; k2 < n; k2++) idx[i0 + k2] = v0 + k2; i0 += n; }
      v0 += n; gg.dispose();
    });
    var out = new THREE.BufferGeometry();
    out.setAttribute("position", new THREE.BufferAttribute(pos, 3)); out.setAttribute("normal", new THREE.BufferAttribute(nor, 3)); out.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    out.setIndex(new THREE.BufferAttribute(idx, 1)); out.computeBoundingSphere(); out.computeBoundingBox();
    return out;
  }
  return {
    box: function(key, w, h, d, x, y, z, ry){ put(key, new THREE.BoxGeometry(w, h, d), x, y, z, 0, ry); },
    geo: function(key, geo, x, y, z, rx, ry, rz, sx, sy, sz){ put(key, geo, x, y, z, rx, ry, rz, sx, sy, sz); },
    cyl: function(key, rt, rb, h, x, y, z, seg, rx, rz){ put(key, new THREE.CylinderGeometry(rt, rb, h, seg || 12), x, y, z, rx, 0, rz); },
    sph: function(key, r, x, y, z, sx, sy, sz){ put(key, new THREE.SphereGeometry(r, 10, 7), x, y, z, 0, 0, 0, sx, sy, sz); },
    cone: function(key, r, h, x, y, z, seg, ry){ put(key, new THREE.ConeGeometry(r, h, seg || 8), x, y, z, 0, ry || 0, 0); },
    // a straight bar from a to b ([x, y, z]), its cross-section w x w
    bar: function(key, a, b, w){
      var dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2], L = Math.hypot(dx, dy, dz) || 0.01, gg = new THREE.BoxGeometry(w, L, w);
      var dir = new THREE.Vector3(dx/L, dy/L, dz/L), qq = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
      m4.compose(new THREE.Vector3((a[0] + b[0])/2, (a[1] + b[1])/2, (a[2] + b[2])/2), qq, new THREE.Vector3(1, 1, 1)); gg.applyMatrix4(m4);
      if(!B[key]){ B[key] = []; order.push(key); } B[key].push(gg);
    },
    has: function(key){ return !!B[key]; },
    flush: function(parent, mats, opts){
      var out = {};
      order.forEach(function(key){
        var mt = mats[key]; if(!mt || !B[key].length) return;
        var mesh = new THREE.Mesh(merged(B[key]), mt); mesh.name = "hqt:" + key;
        var sh = !(opts && opts.noShadow && opts.noShadow[key]); mesh.castShadow = sh; mesh.receiveShadow = true;
        parent.add(mesh); out[key] = mesh;
      });
      B = {}; order = [];
      return out;
    }
  };
}
// the four walls of a box with UVs in tiles (u along the wall over tw m, v up over th m from v0): a facade that tiles
function sideGeo(THREE, w, h, d, tw, th, v0){
  var pos = [], nor = [], uv = [], idx = [], hw = w/2, hd = d/2, vb = (v0 || 0)/th, vt = vb + h/th;
  function quad(ax, az, bx, bz, nx, nz, len){
    var n = pos.length/3;
    pos.push(ax, -h/2, az, bx, -h/2, bz, bx, h/2, bz, ax, h/2, az);
    for(var i = 0; i < 4; i++) nor.push(nx, 0, nz);
    var u1 = len/tw; uv.push(0, vb, u1, vb, u1, vt, 0, vt);
    idx.push(n, n + 1, n + 2, n, n + 2, n + 3);
  }
  quad(-hw, hd, hw, hd, 0, 1, w); quad(hw, -hd, -hw, -hd, 0, -1, w); quad(hw, hd, hw, -hd, 1, 0, d); quad(-hw, -hd, -hw, hd, -1, 0, d);
  var G = new THREE.BufferGeometry();
  G.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); G.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  G.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2)); G.setIndex(idx);
  return G;
}

/* ---------- the building ---------- */
// opts: as HQV.hqBuilding (games/hqbase.js): level(), look() (paint, accent, sign, decor, crew, style), live(),
// campus, door, doorFront(), prestige(); plus grand (0..1, default 1: how big the lot lets it be).
function make(c, opts){
  var THREE = c.THREE, COL = c.COL, HEX = c.HEX;
  var S = HQV.hqStyle;
  var hits = [], doors = [], night = true, liveSeen = -1, share = 5, lod = 0;
  var B = {hits: hits, doors: doors, wings: 0, level: 1, grand: 1};
  var baseG = new THREE.Group(), dyn = null, built = {level: null, look: "", grand: null};
  function grandOf(){ var g = typeof opts.grand === "function" ? opts.grand() : opts.grand; return g == null ? 1 : clamp(+g || 0, 0, 1); }
  // the style: the owner's (look.style), else one from the old paint and accent so an HQ that never opened the Studio looks itself
  function styleOf(look){
    var st = S ? S.clean(look.style) : null;
    if(!st) return null;
    if(!look.style){
      if(/^#[0-9a-f]{6}$/i.test(look.paint || "")) st.ext.body = look.paint.toLowerCase();
      if(/^#[0-9a-f]{6}$/i.test(look.accent || "")){ st.ext.trim = look.accent.toLowerCase(); st.ext.signColor = look.accent.toLowerCase(); }
    }
    return st;
  }
  function M_(o){ return new THREE.MeshStandardMaterial(o); }
  function mats(X){
    var MT = MATERIAL[X.material] || MATERIAL.glass, T = TINT[X.tint] || TINT.blue;
    var facT = tile(c, X, "tower"), podT = tile(c, X, "podium");
    var fac = M_({map: facT, emissiveMap: nightTile(c, X, "tower", share), emissive: new THREE.Color(0xffffff), emissiveIntensity: 1, roughness: MT.rough, metalness: MT.metal});
    var pod = M_({map: podT, emissiveMap: nightTile(c, X, "podium", 10), emissive: new THREE.Color(0xffffff), emissiveIntensity: 1, roughness: MT.rough, metalness: MT.metal});
    [facT, podT].forEach(function(t){ t.wrapS = t.wrapT = THREE.RepeatWrapping; });
    var night = new THREE.Color(X.night);
    return {
      fac: fac, pod: pod,
      roof: M_({color: 0x2b3440, roughness: 0.85, metalness: 0.1}),
      stone: M_({color: X.facade === "brutal" ? 0x8d8a84 : X.facade === "tokyo" ? 0x2a2e3a : 0xcfc8ba, roughness: 0.75}),
      body: M_({color: hexN(X.body), roughness: MT.rough, metalness: MT.metal}),
      trim: M_({color: hexN(X.trim), roughness: 0.35, metalness: 0.6}),
      dark: M_({color: 0x1e252d, roughness: 0.5, metalness: 0.6}),
      glass: M_({color: hexN(T[0]), roughness: 0.05, metalness: 0.5, transparent: true, opacity: 0.45, emissive: new THREE.Color(X.night), emissiveIntensity: 0.15}),
      green: M_({color: 0x3c8a4f, roughness: 0.9}),
      green2: M_({color: 0x2f6b3e, roughness: 0.9}),
      wood: M_({color: 0x7a5432, roughness: 0.8}),
      soil: M_({color: X.land === "desert" ? 0xd8c39a : X.land === "zen" ? 0xe6e1d3 : 0x4a3a2a, roughness: 1}),
      gold: M_({color: 0xf5d76e, metalness: 0.85, roughness: 0.2, emissive: new THREE.Color(0xd8a43a), emissiveIntensity: 0.2}),
      lit: new THREE.MeshBasicMaterial({color: night, toneMapped: false}),          // night lights: uplights, LED strips (dimmed by day)
      neon: new THREE.MeshBasicMaterial({color: hexN(X.trim), toneMapped: false})
    };
  }
  function build(){
    var level = Math.max(1, opts.level() | 0), look = opts.look() || {}, grand = grandOf();
    var stars = opts.prestige ? clamp(opts.prestige() | 0, 0, 5) : 0;
    var st = styleOf(look), X = st.ext;
    while(baseG.children.length) baseG.remove(baseG.children[0]);
    hits.length = 0; doors.length = 0;
    var M = massing(level, grand, stars, typeof opts.room === "function" ? opts.room() : opts.room);
    var MT = mats(X);
    dyn = {M: M, X: X, mats: MT, glows: [], flags: null, flagN: 0, revolve: null, sock: null, beacons: [], beaconGlows: [], heli: null, prestige: null, fireworks: [], decorFlags: [], banners: [], jets: [], karts: [], core: null, detail: null};
    var core = new THREE.Group(), detail = new THREE.Group(); core.name = "hqt-core"; detail.name = "hqt-detail";
    baseG.add(core); baseG.add(detail); dyn.core = core; dyn.detail = detail;
    var K = kit(THREE), Kd = kit(THREE), F = X.facade;
    var P = M.podium, front = P.d/2;
    /* --- the masses: plinth, podium, tiers, wings (core) --- */
    K.box("stone", P.w + 1.0, PLINTH, P.d + 1.0, 0, PLINTH/2, 0);
    K.geo("pod", sideGeo(THREE, P.w, P.h, P.d, POD_W, POD_H, 0), 0, P.y0 + P.h/2, 0);
    K.box("body", P.w + 0.5, CORNICE, P.d + 0.5, 0, P.y0 + P.h + CORNICE/2, 0);
    M.tiers.forEach(function(T, n){
      K.geo("fac", sideGeo(THREE, T.w, T.h, T.d, TILE_W, TILE_H, 0), T.x, T.y0 + T.h/2, T.z);
      K.box("roof", T.w + 0.1, 0.2, T.d + 0.1, T.x, T.y0 + T.h + 0.1, T.z);
      if(n > 0) K.box("body", M.tiers[n - 1].w*0.98, 0.5, M.tiers[n - 1].d*0.98, M.tiers[n - 1].x, T.y0 - 0.25, M.tiers[n - 1].z);   // the setback's terrace slab
    });
    M.wings.forEach(function(Wg){
      K.box("stone", Wg.w + 0.6, PLINTH, Wg.d + 0.6, Wg.x, PLINTH/2, Wg.z);
      K.geo("pod", sideGeo(THREE, Wg.w, PODIUM_H, Wg.d, POD_W, POD_H, 0), Wg.x, PLINTH + PODIUM_H/2, Wg.z);
      K.box("body", Wg.w + 0.3, CORNICE, Wg.d + 0.3, Wg.x, PLINTH + PODIUM_H + CORNICE/2, Wg.z);
      var wy = PLINTH + PODIUM_H + CORNICE, wh = Wg.floors*FH;
      K.geo("fac", sideGeo(THREE, Wg.w - 0.4, wh, Wg.d - 0.4, TILE_W, TILE_H, 0), Wg.x, wy + wh/2, Wg.z);
      K.box("roof", Wg.w - 0.3, 0.2, Wg.d - 0.3, Wg.x, wy + wh + 0.1, Wg.z);
      Wg.top = wy + wh + 0.2;
    });
    if(M.prestige){
      var Pp = M.prestige;
      for(var ps = 0; ps < Pp.floors; ps++){ Kd.box("gold", Pp.w + 0.3, 0.3, Pp.d + 0.3, Pp.x, Pp.y0 + ps*2.4 + 2.15, Pp.z); }
      var pg = new THREE.Mesh(new THREE.BoxGeometry(Pp.w, Pp.h, Pp.d), M_({color: 0xbfe3f5, transparent: true, opacity: 0.55, roughness: 0.05, metalness: 0.3, emissive: new THREE.Color(0xffd36e), emissiveIntensity: 0.35}));
      pg.position.set(Pp.x, Pp.y0 + Pp.h/2, Pp.z); pg.name = "prestige-floor"; core.add(pg); dyn.prestigeMat = pg.material;
      var bm = new THREE.MeshBasicMaterial({color: 0xffe08a, transparent: true, opacity: 0.35, toneMapped: false, depthWrite: false});
      var beam = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.9, 16, 16, 1, true), bm); beam.name = "prestige-beacon";
      beam.position.set(M.heli.x, M.heli.y + 8.5, M.heli.z - M.heli.r + 0.6);   // the helideck's back rim, clear of the pad detail.add(beam);
      dyn.prestige = {beam: beam, mat: bm, stars: Pp.floors};
    }
    /* --- facade systems: fins, piers, bands, louvres (detail, merged) --- */
    M.tiers.forEach(function(T, n){
      var y0 = T.y0, y1 = T.y0 + T.h, hw = T.w/2, hd = T.d/2;
      function finsOn(face, step, w, d, key){
        var len = face === "x" ? T.w : T.d, nn = Math.max(1, Math.round(len/step));
        for(var i = 0; i <= nn; i++){
          var a = -len/2 + i*len/nn;
          if(face === "x"){ Kd.box(key, w, T.h, d, T.x + a, (y0 + y1)/2, T.z + hd + d/2); Kd.box(key, w, T.h, d, T.x + a, (y0 + y1)/2, T.z - hd - d/2); }
          else { Kd.box(key, d, T.h, w, T.x + hw + d/2, (y0 + y1)/2, T.z + a); Kd.box(key, d, T.h, w, T.x - hw - d/2, (y0 + y1)/2, T.z + a); }
        }
      }
      if(F === "glass"){ finsOn("x", 1.2, 0.05, 0.16, "trim"); finsOn("z", 1.2, 0.05, 0.16, "trim"); }
      else if(F === "deco"){ finsOn("x", 2.4, 0.3, 0.3, "body"); finsOn("z", 2.4, 0.3, 0.3, "body");
        for(var dy = y0 + FH; dy < y1 - 0.1; dy += FH*2) Kd.box("trim", T.w + 0.7, 0.12, T.d + 0.7, T.x, dy, T.z); }
      else if(F === "brutal"){ for(var by = y0; by < y1 - 0.1; by += FH) Kd.box("body", T.w + 0.7, 0.5, T.d + 0.7, T.x, by + 0.25, T.z); }
      else if(F === "tokyo"){ for(var ty = y0 + FH; ty < y1; ty += FH) Kd.box("neon", T.w + 0.12, 0.06, T.d + 0.12, T.x, ty - 0.1, T.z);
        Kd.box("neon", 0.08, T.h, 0.08, T.x + hw + 0.04, (y0 + y1)/2, T.z + hd + 0.04); Kd.box("neon", 0.08, T.h, 0.08, T.x - hw - 0.04, (y0 + y1)/2, T.z + hd + 0.04); }
      else if(F === "stone"){ for(var sy = y0 + FH; sy < y1 - 0.1; sy += FH) Kd.box("stone", T.w + 0.3, 0.16, T.d + 0.3, T.x, sy, T.z);
        Kd.box("stone", T.w + 0.6, 0.45, T.d + 0.6, T.x, y1 - 0.2, T.z);
        [[-1, 1], [1, 1], [-1, -1], [1, -1]].forEach(function(q){ Kd.box("stone", 0.45, T.h, 0.45, T.x + q[0]*hw, (y0 + y1)/2, T.z + q[1]*hd); }); }
      else if(F === "eco"){ finsOn("x", 0.6, 0.06, 0.22, "wood"); finsOn("z", 0.9, 0.06, 0.22, "wood");
        for(var ey = y0 + FH; ey < y1; ey += FH){ Kd.box("green", T.w + 0.4, 0.3, 0.35, T.x, ey - 0.05, T.z + hd + 0.2); } }
      // corners: a lit strip in the night colour on each front corner (night facade lighting)
      if(F !== "tokyo"){ Kd.box("lit", 0.07, T.h, 0.07, T.x + hw + 0.05, (y0 + y1)/2, T.z + hd + 0.05); Kd.box("lit", 0.07, T.h, 0.07, T.x - hw - 0.05, (y0 + y1)/2, T.z + hd + 0.05); }
      Kd.box("lit", T.w + 0.2, 0.06, 0.06, T.x, y1 + 0.02, T.z + hd + 0.08);
      // balconies on the first tier's front: every other floor, a slab and a glass rail
      if(X.balcony && n === 0 && T.floors >= 2){
        for(var f = 1; f < T.floors; f += 2){
          var yb = y0 + f*FH, bw = Math.min(T.w - 1.2, 6.4);
          Kd.box("stone", bw, 0.14, 1.0, T.x, yb, T.z + hd + 0.5);
          Kd.box("glass", bw, 0.9, 0.04, T.x, yb + 0.52, T.z + hd + 0.98);
          Kd.box("trim", bw, 0.05, 0.08, T.x, yb + 0.98, T.z + hd + 0.98);
          if(F === "eco") for(var pb = -bw/2 + 0.5; pb < bw/2; pb += 1.4) Kd.sph("green", 0.3, T.x + pb, yb + 0.32, T.z + hd + 0.75, 1.2, 0.8, 1);
        }
      }
    });
    // the podium's cornice by style, and the uplights along its base
    if(F === "deco" || F === "stone") Kd.box("trim", P.w + 0.7, 0.18, P.d + 0.7, 0, P.y0 + P.h + CORNICE + 0.09, 0);
    for(var ux = -P.w/2 + 0.6; ux <= P.w/2 - 0.5; ux += 1.2){ if(Math.abs(ux) < 1.8) continue; Kd.box("lit", 0.18, 0.08, 0.18, ux, PLINTH + 0.04, front + 0.3); }
    /* --- the entrance (z from the podium's front out to about front + 2.5) --- */
    var E = X.entrance, ez = front;
    for(var s = 0; s < 3; s++) Kd.box("stone", 4.2 - s*0.3, 0.1, 0.5, 0, PLINTH - 0.05 - s*0.1, ez + 0.5 + s*0.5);   // the steps down to the street
    if(E === "canopy"){
      Kd.box("glass", 6.0, 0.08, 2.6, 0, 4.3, ez + 1.3); Kd.box("trim", 6.2, 0.14, 0.12, 0, 4.3, ez + 2.6);
      Kd.bar("trim", [-2.6, 4.3, ez + 2.4], [-2.9, PLINTH + 4.8, ez + 0.05], 0.1); Kd.bar("trim", [2.6, 4.3, ez + 2.4], [2.9, PLINTH + 4.8, ez + 0.05], 0.1);
    } else if(E === "portico"){
      [-2.6, -1.9, 1.9, 2.6].forEach(function(x){ Kd.cyl("stone", 0.22, 0.26, 4.0, x, PLINTH + 2.0, ez + 1.9, 16); Kd.box("stone", 0.6, 0.2, 0.6, x, PLINTH + 0.1, ez + 1.9); Kd.box("stone", 0.6, 0.18, 0.6, x, PLINTH + 4.05, ez + 1.9); });
      Kd.box("stone", 6.4, 0.5, 2.4, 0, PLINTH + 4.4, ez + 1.2);
      var ped = new THREE.Shape(); ped.moveTo(-3.3, 0); ped.lineTo(3.3, 0); ped.lineTo(0, 1.1); ped.closePath();
      var pg2 = new THREE.ExtrudeGeometry(ped, {depth: 0.3, bevelEnabled: false}); Kd.geo("stone", pg2, 0, PLINTH + 4.65, ez + 2.1);
    } else if(E === "arch"){
      [-2.3, 2.3].forEach(function(x){ Kd.box("stone", 0.7, 3.6, 0.9, x, PLINTH + 1.8, ez + 0.45); });
      Kd.geo("stone", new THREE.TorusGeometry(2.3, 0.35, 8, 18, PI), 0, PLINTH + 3.6, ez + 0.45);
      Kd.box("trim", 0.5, 0.7, 0.95, 0, PLINTH + 5.95, ez + 0.45);
    } else if(E === "glassbox"){
      Kd.box("glass", 4.6, 3.6, 2.2, 0, PLINTH + 1.8, ez + 1.1);
      [[-2.3, 0], [2.3, 0]].forEach(function(q){ Kd.box("dark", 0.1, 3.7, 0.1, q[0], PLINTH + 1.85, ez + 2.2); });
      Kd.box("dark", 4.8, 0.14, 2.4, 0, PLINTH + 3.67, ez + 1.1);
    } else if(E === "torii"){
      var red = "neon";
      [-2.3, 2.3].forEach(function(x){ Kd.cyl(red, 0.2, 0.24, 4.6, x, PLINTH + 2.3, ez + 2.1, 12); Kd.box("dark", 0.55, 0.3, 0.55, x, PLINTH + 0.15, ez + 2.1); });
      Kd.box(red, 6.2, 0.3, 0.42, 0, PLINTH + 4.4, ez + 2.1); Kd.box("dark", 7.0, 0.22, 0.6, 0, PLINTH + 4.75, ez + 2.1); Kd.box(red, 5.2, 0.2, 0.3, 0, PLINTH + 3.7, ez + 2.1);
      [-3.3, 3.3].forEach(function(x){ Kd.box("stone", 0.4, 1.0, 0.4, x, PLINTH + 0.5, ez + 1.6); Kd.box("lit", 0.3, 0.3, 0.3, x, PLINTH + 1.15, ez + 1.6); });
    }
    // the revolving door: a glass drum with four leaves that turn (its own mesh: it moves)
    var rev = new THREE.Group(); rev.position.set(0, PLINTH, ez); detail.add(rev);
    var drum = new THREE.Mesh(new THREE.CylinderGeometry(1.0, 1.0, 2.8, 20, 1, true), MT.glass); drum.position.y = 1.4; rev.add(drum);
    var leaves = new THREE.Group(); leaves.position.y = 1.4; rev.add(leaves);
    [0, PI/2].forEach(function(a){ var lf = new THREE.Mesh(new THREE.BoxGeometry(1.9, 2.6, 0.05), MT.glass); lf.rotation.y = a; leaves.add(lf); });
    var cap = new THREE.Mesh(new THREE.CylinderGeometry(1.08, 1.08, 0.18, 20), MT.trim); cap.position.y = 2.9; rev.add(cap);
    dyn.revolve = leaves; leaves.userData.anim = true;
    // planters either side of the steps, by landscaping
    var land = X.land;
    [-1, 1].forEach(function(sx){
      var px = sx*3.5, pz = ez + 1.4;
      Kd.box("stone", 1.3, 0.6, 1.3, px, PLINTH + 0.3, pz); Kd.box("soil", 1.15, 0.05, 1.15, px, PLINTH + 0.62, pz);
      if(land === "tropical"){ Kd.cyl("wood", 0.08, 0.12, 2.6, px, PLINTH + 1.9, pz, 6); for(var fr = 0; fr < 6; fr++){ var fa = fr/6*PI*2; Kd.sph("green", 0.5, px + Math.cos(fa)*0.6, PLINTH + 3.2, pz + Math.sin(fa)*0.6, 1.6, 0.25, 0.6); } }
      else if(land === "formal"){ Kd.cone("green2", 0.5, 1.8, px, PLINTH + 1.55, pz, 10); }
      else if(land === "zen"){ Kd.sph("stone", 0.32, px - 0.2, PLINTH + 0.75, pz, 1.2, 0.7, 1); Kd.cyl("wood", 0.05, 0.08, 0.6, px + 0.25, PLINTH + 0.95, pz, 5); Kd.sph("green2", 0.35, px + 0.25, PLINTH + 1.35, pz, 1.4, 0.6, 1.4); }
      else if(land === "desert"){ Kd.cyl("green2", 0.16, 0.18, 1.4, px, PLINTH + 1.3, pz, 8); Kd.cyl("green2", 0.1, 0.1, 0.5, px + 0.25, PLINTH + 1.4, pz, 6, 0, -0.9); }
      else if(land === "lawn"){ Kd.sph("green", 0.6, px, PLINTH + 0.9, pz, 1, 0.6, 1); }
      else { Kd.sph("green", 0.45, px, PLINTH + 1.0, pz); Kd.sph("green2", 0.35, px + 0.3, PLINTH + 0.9, pz + 0.2); }
    });
    // the ground in front either side of the walk: paving, lawn, gravel, sand
    var gk = land === "lawn" || land === "formal" || land === "tropical" ? "green" : land === "zen" || land === "desert" ? "soil" : "stone";
    [-1, 1].forEach(function(sx){ Kd.box(gk, 2.2, 0.04, 2.2, sx*3.3, 0.02, ez + 1.6); });
    if(land === "formal") [-1, 1].forEach(function(sx){ Kd.box("green2", 0.35, 0.5, 2.2, sx*4.25, 0.25, ez + 1.6); });
    // flag poles (instanced flags that wave) and banners on the podium
    var wantFlags = X.flags === "flags" || X.flags === "both", wantBanners = X.flags === "banners" || X.flags === "both";
    if(wantFlags){
      var fps = [[-4.2, ez + 2.3], [4.2, ez + 2.3], [-4.2, ez + 1.4], [4.2, ez + 1.4]].slice(0, 3);
      fps.forEach(function(q){ Kd.cyl("trim", 0.05, 0.06, 6.0, q[0], 3.0, q[1], 6); Kd.sph("gold", 0.09, q[0], 6.05, q[1]); });
      var flagGeo = new THREE.PlaneGeometry(1.4, 0.9); flagGeo.translate(0.7, 0, 0);
      var fl = new THREE.InstancedMesh(flagGeo, new THREE.MeshStandardMaterial({color: hexN(X.flagColor), side: THREE.DoubleSide, roughness: 0.8}), fps.length);
      fl.userData.anim = true; detail.add(fl); dyn.flags = {mesh: fl, at: fps.map(function(q){ return [q[0], 5.4, q[1]]; })};
    }
    var nameRaw = c.short((look.sign || "CLAUDE HQ"), 18);
    if(wantBanners){
      var bt = c.canvasTex(128, 512, function(g){ g.fillStyle = X.flagColor; g.fillRect(0, 0, 128, 512); g.fillStyle = X.signColor; g.fillRect(0, 0, 128, 12); g.fillRect(0, 500, 128, 12);
        g.save(); g.translate(64, 256); g.rotate(-PI/2); g.textAlign = "center"; g.fillStyle = X.signColor; g.font = FONT[X.font].replace("{s}", nameRaw.length > 11 ? 40 : 52); g.fillText(nameRaw.toUpperCase(), 0, 16); g.restore(); });
      var bmM = new THREE.MeshBasicMaterial({map: bt.t, side: THREE.DoubleSide, toneMapped: false});
      [-1, 1].forEach(function(sx){ var bn = new THREE.Mesh(new THREE.PlaneGeometry(1.0, 3.6), bmM); bn.position.set(sx*(P.w/2 - 0.9), PLINTH + P.h - 1.9, front + 0.12); detail.add(bn); });
    }
    /* --- the sign: your HQ's name over the entrance, lit, in your font and colour --- */
    var sg = c.canvasTex(1024, 160, function(g){
      g.clearRect(0, 0, 1024, 160); g.textAlign = "center"; g.textBaseline = "middle";
      var t = X.font === "deco" ? nameRaw.toUpperCase().split("").join(" ") : X.font === "script" ? nameRaw : nameRaw.toUpperCase();
      g.font = FONT[X.font].replace("{s}", t.length > 16 ? 72 : 96);
      g.fillStyle = "rgba(0,0,0,.35)"; g.fillText(t, 516, 86); g.fillStyle = X.signColor; g.fillText(t, 512, 80);
    });
    var sign = new THREE.Mesh(new THREE.PlaneGeometry(Math.min(P.w - 0.8, 8.4), 1.3), new THREE.MeshBasicMaterial({map: sg.t, transparent: true, toneMapped: false}));
    sign.position.set(0, PLINTH + P.h - 0.75, front + 0.06); detail.add(sign); dyn.sign = sign;
    if(E === "portico" || E === "torii"){ sign.scale.setScalar(0.62); sign.position.set(0, PLINTH + (E === "portico" ? 4.4 : 4.05), front + (E === "portico" ? 2.42 : 2.3)); }   // on the portico's entablature, the torii's plaque
    Kd.box("dark", Math.min(P.w - 0.6, 8.6), 1.45, 0.08, 0, PLINTH + P.h - 0.75, front + 0.01);
    if(F === "tokyo"){   // a vertical blade sign on the corner
      var vt = c.canvasTex(128, 640, function(g){ g.fillStyle = "#0b0d16"; g.fillRect(0, 0, 128, 640); g.strokeStyle = X.trim; g.lineWidth = 6; g.strokeRect(6, 6, 116, 628);
        g.fillStyle = X.signColor; g.font = FONT.mono.replace("{s}", 64); g.textAlign = "center"; nameRaw.toUpperCase().replace(/\s+/g, "").slice(0, 8).split("").forEach(function(ch, i){ g.fillText(ch, 64, 80 + i*72); }); });
      var T1 = M.tiers[0], blade = new THREE.Mesh(new THREE.BoxGeometry(0.3, Math.min(8, T1.h), 1.3), [MT.dark, MT.dark, MT.dark, MT.dark, new THREE.MeshBasicMaterial({map: vt.t, toneMapped: false}), new THREE.MeshBasicMaterial({map: vt.t, toneMapped: false})]);
      blade.rotation.y = PI/2; blade.position.set(T1.w/2 + 0.75, T1.y0 + Math.min(8, T1.h)/2 + 0.3, T1.d/2 - 0.7); detail.add(blade);
    }
    var eg = c.glow(hexN(X.signColor), 4, 0.35); eg.position.set(0, PLINTH + P.h - 0.6, front + 1.0); detail.add(eg); dyn.glows.push(eg);
    /* --- the front door: walk up to it to go in --- */
    var door = Object.assign({view: "@lobby", label: "Front door", tip: "Front door: into the Lobby"}, opts.door || {},
                             {front: opts.doorFront ? opts.doorFront() : new THREE.Vector3(0, 0, 4.8)});
    [drum, sign].forEach(function(o){ o.userData.door = door; hits.push(o); }); doors.push(door);
    var lt = c.label("Front door", HEX.green, 0.5); lt.position.set(0, PLINTH + P.h + 1.0, front + 1.2); detail.add(lt);
    /* --- the roof: the helideck over it (always: the pad, its walkway and glass rail), the roof lift, the crown and
       the roof extras on the walkway's diagonals, never on the pad or under a parked helicopter's rotor --- */
    var Rf = M.roof, Pd = M.pad, top = M.top, Hd = M.heli, hy = Hd.y;
    Kd.box(F === "tokyo" ? "neon" : "lit", Rf.w + 0.16, 0.08, Rf.d + 0.16, Rf.x, top - 0.35, Rf.z);       // the crown's lit band
    Kd.box(F === "stone" || F === "deco" ? "stone" : "trim", Rf.w + 0.3, 0.22, Rf.d + 0.3, Rf.x, top - 0.12, Rf.z);
    Kd.box("roof", Rf.w, 0.12, Rf.d, Rf.x, top + 0.06, Rf.z);
    helideck(M, detail, MT);
    padModel(Pd, detail, Kd);
    var slots = crownSlots(M), cr = X.crown;
    function slot(qx, qz){ for(var i = 0; i < slots.length; i++) if(slots[i].qx === qx && slots[i].qz === qz) return slots[i]; return null; }
    var lift = slot(-1, -1);                                                         // back-left: the roof lift's head house, its door along the walkway
    if(lift){ var ld = Math.hypot(lift.x - Hd.x, lift.z - Hd.z) || 1, ltx = (lift.z - Hd.z)/ld, ltz = -(lift.x - Hd.x)/ld, lry = Math.atan2(ltx, ltz);
      Kd.box("body", 1.0, 2.4, 1.0, lift.x, hy + 1.2, lift.z, lry); Kd.box("roof", 1.2, 0.12, 1.2, lift.x, hy + 2.46, lift.z, lry); Kd.box("lit", 0.6, 0.06, 0.04, lift.x + ltx*0.52, hy + 2.1, lift.z + ltz*0.52, lry);
      dyn.liftAt = {x: lift.x, z: lift.z, tx: ltx, tz: ltz}; }
    else dyn.liftAt = null;
    var spot = slot(1, -1), fl2 = slot(-1, 1), fr2 = slot(1, 1);
    if(cr === "spire" && spot){ Kd.cyl("trim", 0.06, 0.32, 9, spot.x, hy + 4.5, spot.z, 8); beacon(spot.x, hy + 9.2, spot.z); }
    else if(cr === "antenna" && spot){ Kd.bar("dark", [spot.x - 0.3, hy, spot.z - 0.3], [spot.x, hy + 7, spot.z], 0.08); Kd.bar("dark", [spot.x + 0.3, hy, spot.z - 0.3], [spot.x, hy + 7, spot.z], 0.08); Kd.bar("dark", [spot.x, hy, spot.z + 0.3], [spot.x, hy + 7, spot.z], 0.08);
      Kd.cyl("trim", 0.02, 0.02, 3, spot.x, hy + 8.5, spot.z, 4); beacon(spot.x, hy + 10.1, spot.z); }
    else if(cr === "dome"){ [spot, fl2, fr2].forEach(function(q){ if(!q) return; Kd.cyl("stone", 0.42, 0.42, 1.0, q.x, hy + 0.5, q.z, 12); Kd.geo("trim", new THREE.SphereGeometry(0.46, 14, 7, 0, PI*2, 0, PI/2), q.x, hy + 1.0, q.z); Kd.cyl("gold", 0.02, 0.05, 0.5, q.x, hy + 1.7, q.z, 5); }); }
    else if(cr === "deco"){                                                          // a low parapet round the tower's roof, under the helideck; fins down its face
      [[0, 1], [0, -1], [1, 0], [-1, 0]].forEach(function(q){ Kd.box("body", q[0] ? 0.3 : Rf.w + 0.3, 0.9, q[1] ? 0.3 : Rf.d + 0.3, Rf.x + q[0]*(Rf.w/2 + 0.15), top + 0.45, Rf.z + q[1]*(Rf.d/2 + 0.15)); });
      for(var fi = -2; fi <= 2; fi++){ var fh = 2.6 - Math.abs(fi)*0.5; Kd.box("trim", 0.22, fh, 0.12, Rf.x + fi*Rf.w/6, top - 0.3 - fh/2, Rf.z + Rf.d/2 + 0.32); }
      [spot, fl2, fr2].forEach(function(q){ if(q) Kd.cone("trim", 0.25, 2.2, q.x, hy + 1.1, q.z, 4); });
    }
    else if(cr === "pagoda"){
      var eav = new THREE.CylinderGeometry(0.1, 1, 1, 4, 1, true); // a flared hip skirt round the top tier, below the roof
      Kd.geo("dark", eav, Rf.x, top - 0.45, Rf.z, 0, PI/4, 0, (Rf.w + 1.6)*0.72, 0.9, (Rf.d + 1.6)*0.72);
      [spot, fl2, fr2].forEach(function(q){ if(q){ Kd.cyl("neon", 0.05, 0.05, 1.4, q.x, hy + 0.7, q.z, 6); Kd.sph("gold", 0.16, q.x, hy + 1.5, q.z); } });
    }
    else if(cr === "garden"){ slots.forEach(function(q){ if(q === lift) return; Kd.box("wood", 0.9, 0.5, 0.9, q.x, hy + 0.25, q.z); Kd.sph("green", 0.55, q.x, hy + 1.0, q.z, 1, 1.1, 1); }); }
    var extras = X.roof || [];
    if(extras.indexOf("beacon") >= 0 && cr !== "spire" && cr !== "antenna" && spot) beacon(spot.x, hy + 3.2, spot.z), Kd.cyl("trim", 0.05, 0.05, 3, spot.x, hy + 1.5, spot.z, 6);
    // the lower roofs (the setback terraces and the wings) take the roof extras: tank, antennas, solar, garden
    var lows = [];
    if(M.tiers.length > 1){ var T0 = M.tiers[0], T1b = M.tiers[1]; lows.push({x: T0.x - T0.w/2 + 0.9, z: T0.z + T0.d/2 - 0.8, y: T1b.y0}); lows.push({x: T0.x + T0.w/2 - 0.9, z: T0.z + T0.d/2 - 0.8, y: T1b.y0}); }
    M.wings.forEach(function(Wg){ lows.push({x: Wg.x - Wg.side*0.6, z: Wg.z - 0.9, y: Wg.top}); });
    if(!lows.length) [fl2, fr2].forEach(function(q){ if(q) lows.push({x: q.x, z: q.z, y: hy}); });
    var li = 0;
    function nextLow(){ return lows.length ? lows[li++ % lows.length] : null; }
    if(extras.indexOf("tank") >= 0){ var lt2 = nextLow(); if(lt2){ Kd.cyl("wood", 0.55, 0.55, 1.2, lt2.x, lt2.y + 1.5, lt2.z, 12); Kd.cone("dark", 0.65, 0.5, lt2.x, lt2.y + 2.35, lt2.z, 12); [[-0.4, -0.4], [0.4, -0.4], [-0.4, 0.4], [0.4, 0.4]].forEach(function(q){ Kd.box("dark", 0.06, 0.9, 0.06, lt2.x + q[0], lt2.y + 0.45, lt2.z + q[1]); }); } }
    if(extras.indexOf("antennas") >= 0){ var la = nextLow(); if(la){ Kd.cyl("dark", 0.03, 0.04, 3.2, la.x, la.y + 1.6, la.z, 5); Kd.cyl("dark", 0.03, 0.04, 2.2, la.x + 0.4, la.y + 1.1, la.z + 0.2, 5); Kd.geo("trim", new THREE.SphereGeometry(0.35, 10, 6, 0, PI*2, 0, PI/2), la.x - 0.3, la.y + 0.6, la.z, -0.9, 0.5, 0); } }
    if(extras.indexOf("solar") >= 0){ var ls = nextLow(); if(ls){ for(var sp2 = -1; sp2 <= 1; sp2++) Kd.geo("dark", new THREE.BoxGeometry(0.9, 0.05, 0.6), ls.x + sp2*0.25, ls.y + 0.4, ls.z + sp2*0.0, -0.5, 0, 0); } }
    if(extras.indexOf("garden") >= 0 || level >= 25){                                // the sky terrace garden (level 25), or a roof garden
      var T0g = M.tiers[0];
      if(M.tiers.length > 1){ [-1, 1].forEach(function(sx){ Kd.box("green2", 0.9, 0.3, T0g.d - 1.2, T0g.x + sx*(T0g.w/2 - 0.5), M.tiers[1].y0 - 0.35, T0g.z); for(var gi = 0; gi < 3; gi++) Kd.sph("green", 0.4, T0g.x + sx*(T0g.w/2 - 0.5), M.tiers[1].y0 + 0.1, T0g.z - 1.4 + gi*1.4); }); }
      else { var lg = nextLow(); if(lg) Kd.sph("green", 0.5, lg.x, lg.y + 0.5, lg.z); }
    }
    /* --- level features: skybridges (30), the observatory (40), the crew billboard (45) --- */
    M.wings.forEach(function(Wg){
      if(level >= 30){ var T0s = M.tiers[0], by = Math.max(PLINTH + PODIUM_H + 1.2, Wg.top - 1.6), x0 = Wg.side*T0s.w/2, x1 = Wg.x - Wg.side*(Wg.w/2 - 0.2);
        var sb = new THREE.Mesh(new THREE.BoxGeometry(Math.abs(x1 - x0), 1.6, 2), MT.glass); sb.position.set((x0 + x1)/2, by, 0.5); detail.add(sb); }
    });
    if(level >= 40){ var ob = M.tiers.length > 1 ? {x: M.tiers[0].x + M.tiers[0].w/2 - 1.4, z: M.tiers[0].z - M.tiers[0].d/2 + 1.3, y: M.tiers[1].y0} : null;
      if(ob){ var dm = new THREE.Mesh(new THREE.SphereGeometry(1.1, 18, 9, 0, PI*2, 0, PI/2), MT.glass); dm.position.set(ob.x, ob.y, ob.z); detail.add(dm); Kd.cyl("stone", 1.15, 1.15, 0.3, ob.x, ob.y + 0.05, ob.z, 18); } }
    if(level >= 45 && M.tiers.length > 1){
      var live = opts.live ? opts.live() : 0, T2 = M.tiers[1];
      var bbT = c.canvasTex(512, 300, function(g){ g.fillStyle = "#06111a"; g.fillRect(0, 0, 512, 300); g.strokeStyle = HEX.cyan; g.lineWidth = 6; g.strokeRect(6, 6, 500, 288); g.fillStyle = HEX.amber; g.font = "700 64px system-ui, sans-serif"; g.fillText(live + " CREW LIVE", 30, 110); g.fillStyle = HEX.cyan; g.font = "600 36px ui-monospace, monospace"; g.fillText("HQ level " + level, 30, 200); });
      var bb = c.screen(Math.min(4.2, T2.d - 0.6), 2.5, bbT.t); bb.position.set(T2.x + T2.w/2 + 0.06, T2.y0 + T2.h - 2.2, T2.z); bb.rotation.y = PI/2; detail.add(bb);
    }
    // level 15: the streak banners (the name, the level) down the first tier's front corners
    if(level >= 15){
      var bt2 = c.canvasTex(128, 512, function(g){ g.fillStyle = "#1a1408"; g.fillRect(0, 0, 128, 512); g.fillStyle = X.trim; g.fillRect(0, 0, 128, 14); g.fillRect(0, 498, 128, 14); g.save(); g.translate(64, 256); g.rotate(-PI/2); g.textAlign = "center"; g.fillStyle = X.signColor;
        g.font = "700 " + (nameRaw.length > 11 ? 40 : 54) + "px system-ui, sans-serif"; g.fillText(nameRaw.toUpperCase(), 0, 6); g.fillStyle = HEX.ink; g.font = "600 28px ui-monospace, monospace"; g.fillText("LEVEL " + level, 0, 46); g.restore(); });
      var T0b = M.tiers[0], sbm = new THREE.MeshBasicMaterial({map: bt2.t, side: THREE.DoubleSide, toneMapped: false});
      [-1, 1].forEach(function(sx){ var piv = new THREE.Group(); piv.position.set(sx*(T0b.w/2 - 0.75), T0b.y0 + Math.min(T0b.h, 6.0) - 0.2, T0b.z + T0b.d/2 + 0.35); detail.add(piv);
        var bn = new THREE.Mesh(new THREE.PlaneGeometry(1.1, Math.min(T0b.h, 6.0) - 0.6), sbm); bn.position.y = -(Math.min(T0b.h, 6.0) - 0.6)/2; piv.add(bn); piv.userData.anim = true; dyn.banners.push(piv); });
    }
    // level 20: a helicopter on the west wing's roof pad (it hops now and then)
    if(level >= 20 && M.wings.length){
      var Wh = M.wings[0], hpad = new THREE.Mesh(new THREE.CircleGeometry(Math.min(Wh.w, Wh.d)/2 - 0.3, 24), MT.dark); hpad.rotation.x = -PI/2; hpad.position.set(Wh.x, Wh.top + 0.02, Wh.z); detail.add(hpad);
      var heli = new THREE.Group(), red = M_({color: 0xd14a5c, metalness: 0.5, roughness: 0.35});
      var hb = new THREE.Mesh(new THREE.SphereGeometry(0.8, 12, 8), red); hb.scale.set(1.5, 0.9, 0.9); hb.position.y = 0.95; heli.add(hb);
      var tb = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 2.4), red); tb.position.set(0, 1.1, -1.9); heli.add(tb);
      var rotor = new THREE.Group(); rotor.position.y = 1.92; heli.add(rotor);
      var bl = new THREE.Mesh(new THREE.BoxGeometry(4.2, 0.03, 0.18), MT.dark); rotor.add(bl); var bl2 = bl.clone(); bl2.rotation.y = PI/2; rotor.add(bl2);
      heli.position.set(Wh.x, Wh.top, Wh.z); heli.rotation.y = PI/2; heli.userData.anim = true; detail.add(heli); dyn.heli = {g: heli, rotor: rotor, y: Wh.top, x: Wh.x};
    }
    /* --- the HQ 2.1 decor cosmetics and the crew banner (the roof's front corners, clear of the pad) --- */
    decor(look, M, detail, Kd);
    if(look.crew && /^#[0-9a-f]{6}$/i.test(look.crew.color || "") && fl2){
      Kd.cyl("trim", 0.06, 0.06, 3.4, fl2.x, hy + 1.7, fl2.z, 6);
      var ct = c.canvasTex(256, 128, function(g){ g.fillStyle = look.crew.color; g.fillRect(0, 0, 256, 128); g.fillStyle = "#0e1923"; g.font = "700 64px system-ui, sans-serif"; g.textAlign = "center"; g.fillText(String(look.crew.tag || "").slice(0, 4), 128, 86); });
      var cf = c.screen(1.6, 0.8, ct.t); cf.material.side = THREE.DoubleSide; cf.position.set(fl2.x - 0.55, hy + 3.0, fl2.z + 0.55); cf.rotation.y = -PI/4; cf.userData.wave = 9; detail.add(cf); dyn.decorFlags.push(cf);
    }
    /* --- the Base's campus (games/hqbase.js): the plaza's fountain (5), the kart track (35), the statue (50), the Arena annex (55) --- */
    if(opts.campus && level >= 5){
      var fg = new THREE.Group(); fg.position.set(0, 0, 10.4); detail.add(fg);
      c.cyl(2.5, 2.6, 0.55, c.mat(0x9aa7b5, {roughness: 0.6}), 0, 0.27, 0, fg, 32);
      c.cyl(2.3, 2.3, 0.05, new THREE.MeshStandardMaterial({color: 0x2a7fa8, emissive: new THREE.Color(COL.cyan), emissiveIntensity: 0.35, transparent: true, opacity: 0.85, roughness: 0.05}), 0, 0.5, 0, fg, 32);
      c.cyl(0.9, 1.0, 0.5, c.mat(0x9aa7b5), 0, 0.75, 0, fg, 20); c.cyl(0.25, 0.3, 1.0, c.mat(0x9aa7b5), 0, 1.4, 0, fg, 12);
      for(var j = 0; j < 10; j++){ var jg = c.glow(0x9fe3f0, 0.35, 0.9); fg.add(jg); dyn.jets.push({g: jg, a: j/10*PI*2, o: (j % 5)/5}); }
    }
    if(opts.campus && level >= 50){
      var stat = new THREE.Group(); stat.position.set(7.4, 0, 9.6); detail.add(stat);
      c.box(1.8, 1.0, 1.8, c.mat(0x4d5866, {roughness: 0.6}), 0, 0.5, 0, stat);
      var gold = c.mat(0xd8b34a, {metalness: 0.9, roughness: 0.25});
      c.sph(0.9, gold, 0, 1.85, 0, stat).scale.y = 0.9; [-0.4, 0.4].forEach(function(x){ c.add(new THREE.Mesh(new THREE.ConeGeometry(0.25, 0.7, 6), gold), x, 2.75, 0, stat).rotation.z = -x; });
    }
    if(opts.campus && level >= 35){
      var ktT = c.canvasTex(512, 768, function(g){ g.fillStyle = "#1f3d2c"; g.fillRect(0, 0, 512, 768); g.lineWidth = 92; g.strokeStyle = "#2a2f36"; g.beginPath(); g.ellipse(256, 384, 176, 300, 0, 0, 7); g.stroke(); g.lineWidth = 10; g.setLineDash([22, 22]); g.strokeStyle = "#d14a5c"; g.beginPath(); g.ellipse(256, 384, 222, 346, 0, 0, 7); g.stroke(); g.setLineDash([]); });
      var kt = new THREE.Mesh(new THREE.PlaneGeometry(14, 21), new THREE.MeshStandardMaterial({map: ktT.t, roughness: 0.9})); kt.rotation.x = -PI/2; kt.position.set(-31, 0.03, 0); kt.receiveShadow = true; detail.add(kt);
      [0xd14a5c, 0x4a7bd1, 0x6fd38a].forEach(function(col, n){ var kg = new THREE.Group(); c.box(1.1, 0.3, 0.65, c.mat(col, {metalness: 0.5}), 0, 0.3, 0, kg); detail.add(kg); dyn.karts.push({g: kg, o: n*0.33}); });
      var kl = c.label("Kart Racing", HEX.coral, 0.9); kl.position.set(-31, 4.5, 0); detail.add(kl);
    }
    if(opts.campus && level >= 55){
      var ar = new THREE.Group(); ar.position.set(0, 0, -34); detail.add(ar);
      c.add(new THREE.Mesh(new THREE.CylinderGeometry(9.5, 8, 4, 40, 1, true), c.mat(0x3a5068, {side: THREE.DoubleSide, roughness: 0.7})), 0, 2, 0, ar);
      var field = new THREE.Mesh(new THREE.CircleGeometry(7.6, 40), new THREE.MeshStandardMaterial({color: 0x1d4a3a, emissive: new THREE.Color(COL.cyan), emissiveIntensity: 0.15})); field.rotation.x = -PI/2; field.position.y = 0.05; ar.add(field);
      var al = c.label("Arena", HEX.cyan, 1.1); al.position.set(0, 7, 0); ar.add(al);
    }
    var sb2 = c.label(c.short((look.sign || "Claude HQ"), 16) + " · Lv " + level, HEX.amber, 1.1); sb2.position.set(0, hy + 7, 0); detail.add(sb2);
    // the detail's own copies of the materials the masses use too: the City's merger (hqmerge) must never fold a detail mesh into a mass
    var MTd = Object.assign({}, MT); ["stone", "body", "roof"].forEach(function(k){ MTd[k] = MT[k].clone(); });
    dyn.matsD = MTd;
    K.flush(core, MT); Kd.flush(detail, MTd, {noShadow: {lit: 1, neon: 1, glass: 1}});
    built.level = level; built.look = JSON.stringify(look); built.top = hy; built.grand = grand; built.stars = stars;
    B.wings = M.wings.length; B.level = level; B.grand = grand; B.M = M;
    applyLod(); applyTime();
  }
  // the helideck (games/hqroof.js lands on it, you walk it): a steel disc on four legs from the roof's corners and
  // eight struts out from the facade, a low glass rail; its own meshes, in a group of its own ("hq-helideck")
  function helideck(M, parent, mats){
    var Hd = M.heli, Rf = M.roof, top = M.top, D = Hd.r, x = Hd.x, z = Hd.z, hy = Hd.y, up = hy - top, Kh = kit(THREE), g = new THREE.Group();
    g.name = "hq-helideck"; parent.add(g);
    Kh.cyl("dark", D, D - 0.3, 0.35, x, hy - 0.175, z, 48);
    Kh.cyl("trim", D + 0.05, D + 0.05, 0.14, x, hy - 0.16, z, 48);
    [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(function(q){ Kh.box("trim", 0.34, up, 0.34, Rf.x + q[0]*(Rf.w/2 - 0.45), top + up/2, Rf.z + q[1]*(Rf.d/2 - 0.45)); });
    for(var i = 0; i < 8; i++){
      var a = (i + 0.5)/8*PI*2, dx = Math.cos(a), dz = Math.sin(a), t = Math.min((Rf.w/2)/Math.max(1e-3, Math.abs(dx)), (Rf.d/2)/Math.max(1e-3, Math.abs(dz)));
      Kh.bar("trim", [Rf.x + dx*t, top - 2.4, Rf.z + dz*t], [x + dx*(D - 0.5), hy - 0.32, z + dz*(D - 0.5)], 0.2);
    }
    Kh.geo("glass", new THREE.CylinderGeometry(D - 0.05, D - 0.05, 0.9, 48, 1, true), x, hy + 0.45, z);
    Kh.geo("trim", new THREE.TorusGeometry(D - 0.05, 0.05, 4, 48), x, hy + 0.92, z, -PI/2);
    Kh.flush(g, mats, {noShadow: {glass: 1}});
  }
  function padModel(Pd, parent, Kd){
    var THREE_ = THREE, y = Pd.y;
    var key = "pad:" + Math.round(Pd.r*10);
    var tex = TEX[key] || keepTex(key, c.canvasTex(256, 256, function(g){
      g.fillStyle = "#2f3740"; g.fillRect(0, 0, 256, 256);
      g.strokeStyle = "#f2b234"; g.lineWidth = 8; g.beginPath(); g.arc(128, 128, 84, 0, PI*2); g.stroke();         // the touchdown circle
      g.strokeStyle = "#f4f6f8"; g.lineWidth = 4; g.beginPath(); g.arc(128, 128, 122, 0, PI*2); g.stroke();
      g.fillStyle = "#f4f6f8"; g.fillRect(96, 84, 16, 88); g.fillRect(144, 84, 16, 88); g.fillRect(96, 120, 64, 16);  // H
    }).t);
    var deck = new THREE_.Mesh(new THREE_.CircleGeometry(Pd.r, 48), new THREE_.MeshStandardMaterial({map: tex, roughness: 0.7}));
    deck.rotation.x = -PI/2; deck.position.set(Pd.x, y, Pd.z); deck.receiveShadow = true; deck.name = "hq-helipad"; parent.add(deck);
    var n = 16, lm = new THREE_.MeshBasicMaterial({color: 0x6fd38a, toneMapped: false}), L = new THREE_.InstancedMesh(new THREE_.SphereGeometry(0.09, 6, 4), lm, n), m4 = new THREE_.Matrix4();
    for(var i = 0; i < n; i++){ m4.makeTranslation(Pd.x + Math.cos(i/n*PI*2)*(Pd.r + 0.1), y + 0.06, Pd.z + Math.sin(i/n*PI*2)*(Pd.r + 0.1)); L.setMatrixAt(i, m4); }
    L.name = "hq-padlights"; parent.add(L); dyn.padLights = lm;
    // the windsock on its mast, on the walkway (the deck's right side)
    var sx = Pd.x + Pd.r + 1.1, sz = Pd.z;
    Kd.cyl("trim", 0.03, 0.04, 1.8, sx, y + 0.9, sz, 6);
    var sock = new THREE_.Group(); sock.position.set(sx, y + 1.75, sz); parent.add(sock);
    var sg = new THREE_.ConeGeometry(0.16, 0.9, 10, 1, true); sg.rotateZ(PI/2); sg.translate(-0.45, 0, 0);
    var sm = new THREE_.Mesh(sg, new THREE_.MeshStandardMaterial({color: 0xff7a2f, side: THREE_.DoubleSide, roughness: 0.8})); sock.add(sm);
    sock.userData.anim = true; dyn.sock = sock;
  }
  function beacon(x, y, z){
    var b = new THREE.Mesh(new THREE.SphereGeometry(0.2, 10, 7), new THREE.MeshStandardMaterial({color: COL.coral, emissive: new THREE.Color(COL.coral), emissiveIntensity: 3}));
    b.position.set(x, y, z); dyn.detail.add(b); dyn.beacons.push(b);
    var g = c.glow(COL.coral, 1.4, 0.9); g.position.set(x, y, z); dyn.detail.add(g); dyn.beaconGlows.push(g);
  }
  // HQ 2.1 decor (a cosmetic the owner wears), kept from the old building and fitted round the new one
  function decor(look, M, parent, Kd){
    var top = M.top, Rf = M.roof;
    if(look.decor === "flags"){
      for(var fi = 0; fi < 8; fi++){ var fa = fi/8*PI*2 + 0.2, fx = Math.cos(fa)*(M.podium.w/2 + 1.2), fz = Math.sin(fa)*(M.podium.d/2 + 1.2);
        if(fz > M.podium.d/2 && Math.abs(fx) < 4.6) continue;                       // not on the steps
        Kd.cyl("trim", 0.05, 0.05, 4.2, fx, 2.1, fz, 6);
        var fl = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.7, 0.03), new THREE.MeshStandardMaterial({color: [0xff6b5b, 0x5fd3e6, 0xffb347, 0x6fd38a][fi % 4]})); fl.position.set(fx + 0.55, 3.75, fz); fl.userData.wave = fi; parent.add(fl); dyn.decorFlags.push(fl); }
    } else if(look.decor === "gnomes"){
      for(var gi = 0; gi < 6; gi++){ var gx = (gi < 3 ? -1 : 1)*(2.6 + (gi % 3)*0.45), gz = M.podium.d/2 + 2.1 + (gi % 3)*0.2;
        Kd.cyl("dark", 0.15, 0.19, 0.3, gx, 0.15, gz, 8); Kd.sph("stone", 0.12, gx, 0.4, gz); Kd.cone("neon", 0.13, 0.3, gx, 0.6, gz, 8); }
    } else if(look.decor === "fireworks"){
      for(var fw = 0; fw < 3; fw++){ var g = new THREE.Group(); parent.add(g); var parts = [];
        for(var q = 0; q < 14; q++){ var sp = c.glow([COL.amber, COL.cyan, COL.coral][fw], 0.6, 1); g.add(sp); parts.push({s: sp, a: q/14*PI*2, b: (q % 3 - 1)*0.6}); }
        g.userData.anim = true; dyn.fireworks.push({g: g, parts: parts, o: fw/3, x: (fw - 1)*6, y: M.heli.y + 8 + fw*2}); }
    } else if(look.decor === "crown"){
      var crown = new THREE.Group(); crown.name = "decor-crown"; crown.position.set(M.heli.x, M.heli.y, M.heli.z); parent.add(crown);   // a ring on the helideck's rail: the pad stays clear
      var gm = new THREE.MeshStandardMaterial({color: 0xf5d76e, metalness: 0.85, roughness: 0.2, emissive: new THREE.Color(0xd8a43a), emissiveIntensity: 0.25, side: THREE.DoubleSide});
      var cr = M.heli.r + 0.1;
      var band = new THREE.Mesh(new THREE.CylinderGeometry(cr, cr - 0.1, 0.8, 32, 1, true), gm); band.position.y = 0.6; crown.add(band);
      for(var ci = 0; ci < 8; ci++){ var ca = ci/8*PI*2, pt = new THREE.Mesh(new THREE.ConeGeometry(0.35, 1.2, 4), gm); pt.position.set(Math.cos(ca)*cr, 1.6, Math.sin(ca)*cr); crown.add(pt); }
    } else if(look.decor === "neon"){
      var T = M.tiers[0], hw = T.w/2 + 0.1, hd = T.d/2 + 0.1, y0 = PLINTH, y1 = top;
      [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(function(q){ Kd.box("neon", 0.16, y1 - y0, 0.16, q[0]*hw, (y0 + y1)/2, T.z + q[1]*hd); });
      for(var nf = T.y0; nf < T.y0 + T.h; nf += FH*2){ Kd.box("neon", T.w + 0.3, 0.08, 0.08, 0, nf, T.z + hd); Kd.box("neon", T.w + 0.3, 0.08, 0.08, 0, nf, T.z - hd); }
      var ng = c.glow(dyn.mats.neon.color.getHex(), 9, 0.35); ng.position.set(0, M.heli.y + 1, 0); parent.add(ng); dyn.glows.push(ng);
    }
  }
  function applyTime(){
    if(!dyn) return; var MT = dyn.mats;
    MT.fac.emissiveIntensity = night ? 1 : 0.04; MT.pod.emissiveIntensity = night ? 0.9 : 0.06;
    MT.glass.emissiveIntensity = night ? 0.5 : 0.08;
    MT.lit.color.set(dyn.X.night); if(!night) MT.lit.color.multiplyScalar(0.35);
    if(dyn.padLights) dyn.padLights.color.set(night ? 0x6fd38a : 0x2e5a3a);
    dyn.glows.forEach(function(g){ g.visible = night && lod === 0; });
  }
  function applyLod(){ if(dyn){ dyn.detail.visible = lod === 0; dyn.glows.forEach(function(g){ g.visible = night && lod === 0; }); } }
  B.g = baseG;
  B.top = function(){ return built.top || 10; };
  B.build = build;
  B.stale = function(){ return Math.max(1, opts.level() | 0) !== built.level || JSON.stringify(opts.look() || {}) !== built.look || grandOf() !== built.grand ||
    (opts.prestige ? clamp(opts.prestige() | 0, 0, 5) : 0) !== (built.stars | 0); };
  B.setNight = function(n){ night = n; applyTime(); };
  // more crew at work, more windows lit: the night tile for that share (tenths), shared
  B.setLive = function(live){
    var sh = Math.round(Math.min(0.9, 0.3 + live*0.08)*10);
    if(sh === share && live === liveSeen) return; liveSeen = live;
    if(sh !== share){ share = sh; if(dyn){ dyn.mats.fac.emissiveMap = nightTile(c, dyn.X, "tower", share); dyn.mats.fac.needsUpdate = true; } }
  };
  // a far tower: its masses only (hqcity3d past HQ_LOD)
  B.setLod = function(l){ l = l ? LOD_FAR : 0; if(l === lod) return; lod = l; applyLod(); };
  B.lod = function(){ return lod; };
  // the pad, the roof deck and the roof lift's door, in the building's frame (null before it is built)
  B.pad = function(){ return dyn ? dyn.M.pad : null; };
  B.roofDeck = function(){ return dyn ? roofDeck(dyn.M) : null; };
  B.roofLift = function(){ var L = dyn && dyn.liftAt; return L ? {x: L.x + L.tx*0.9, z: L.z + L.tz*0.9, y: dyn.M.heli.y, hx: L.x, hz: L.z} : null; };
  // what you cannot walk through, in the building's own frame
  B.blockedLocal = function(x, z){
    var fp = footprint(B.grand, B.wings), T = fp[0];
    if(Math.abs(x - T[0]) < T[2] && Math.abs(z - T[1]) < T[3]) return true;                       // the tower
    for(var i = 2; i < fp.length; i++){ var Wb = fp[i]; if(Math.abs(x - Wb[0]) < Wb[2] && Math.abs(z - Wb[1]) < Wb[3]) return true; }
    var fz = T[3] - 0.3 + 1.4;                                                                     // the planters either side of the steps
    if(Math.abs(Math.abs(x) - 3.5) < 0.95 && Math.abs(z - fz) < 0.95) return true;
    if(dyn && (dyn.X.flags === "flags" || dyn.X.flags === "both") && Math.abs(Math.abs(x) - 4.2) < 0.3 && (Math.abs(z - (T[3] - 0.3 + 2.3)) < 0.3)) return true;
    if(!opts.campus) return false;
    if(B.level >= 5 && Math.hypot(x, z - 10.4) < 2.8) return true;                               // the Base's fountain
    if(B.level >= 50 && Math.abs(x - 7.4) < 1.1 && Math.abs(z - 9.6) < 1.1) return true;
    if(B.level >= 55 && Math.hypot(x, z + 34) < 9.8) return true;
    return false;
  };
  var flagM4 = new THREE.Matrix4(), flagQ = new THREE.Quaternion(), flagE = new THREE.Euler(), flagS = new THREE.Vector3(1, 1, 1), flagP = new THREE.Vector3();
  B.animate = function(t, dt, k){
    if(!dyn) return;
    if(dyn.revolve) dyn.revolve.rotation.y = t*0.6*k;
    if(dyn.sock) dyn.sock.rotation.y = 0.6 + Math.sin(t*0.4)*0.5*k;
    if(dyn.flags){ var F = dyn.flags; F.at.forEach(function(a, i){ flagE.set(0, Math.sin(t*2.2 + i)*0.3*k, 0); flagQ.setFromEuler(flagE); flagP.set(a[0], a[1], a[2]); flagM4.compose(flagP, flagQ, flagS); F.mesh.setMatrixAt(i, flagM4); }); F.mesh.instanceMatrix.needsUpdate = true; }
    if(dyn.heli){ dyn.heli.rotor.rotation.y = t*14*k; var hv = (t % 24)/24, lift = hv < 0.4 ? 0 : hv < 0.5 ? (hv - 0.4)*10 : hv < 0.9 ? 1 : (1 - hv)*10;
      dyn.heli.g.position.y = dyn.heli.y + lift*6*k; dyn.heli.g.position.x = dyn.heli.x + lift*Math.sin(t*0.4)*3*k; }
    dyn.beacons.forEach(function(b, n){ var on = ((t + n*0.3) % 1.4) < 0.25; b.material.emissiveIntensity = on ? 3 : 0.4; dyn.beaconGlows[n].material.opacity = on ? 1 : 0.1; });
    if(dyn.prestige){ var pb = dyn.prestige; if(k >= 1){ pb.beam.rotation.y = t*0.8; pb.mat.opacity = 0.25 + 0.15*Math.sin(t*2.2); } else { pb.beam.rotation.y = 0; pb.mat.opacity = 0.35; } }
    dyn.banners.forEach(function(b, n){ b.rotation.x = Math.sin(t*1.6 + n)*0.06*k; });
    dyn.decorFlags.forEach(function(f){ f.rotation.y = Math.sin(t*2.4 + f.userData.wave)*0.35*k; });
    dyn.jets.forEach(function(j){ var u = (t*0.9*k + j.o) % 1, r = 0.6 + u*1.4; j.g.position.set(Math.cos(j.a)*r, 2.0 + Math.sin(u*PI)*1.3 - u*0.9, Math.sin(j.a)*r); j.g.material.opacity = 0.9*(1 - u*0.6); });
    dyn.karts.forEach(function(kk){ var a = t*0.7*k + kk.o*PI*2; kk.g.position.set(-31 + Math.cos(a)*4.4, 0.05, Math.sin(a)*8); kk.g.rotation.y = Math.atan2(-Math.cos(a)*8, -Math.sin(a)*4.4); });
    dyn.fireworks.forEach(function(fw){ var u = (t*0.35*k + fw.o) % 1; fw.g.visible = night && u > 0.15;
      fw.parts.forEach(function(p){ var r = (u - 0.15)*9; p.s.position.set(fw.x + Math.cos(p.a)*r, fw.y + Math.sin(p.a)*r*0.8 - u*u*4 + p.b, Math.sin(p.a)*r*0.4); p.s.material.opacity = Math.max(0, 1 - u); }); });
  };
  build();
  return B;
}

/* ---------- HQ Studio's live preview: your tower (this make(), as in the City) in a small canvas of its own ---------- */
// preview(c, canvas, o) -> {set(), night(on), focus(part), resize(), drag(dx, dy), zoom(dy), tick(t), dispose(), info()}
//   c: hq3d's world context (canvasTex, glow, label...); o: {look(), level(), prestige(), calm(), renderer(canvas)?}
//   set() rebuilds the tower from o.look() after a short pause (the last change in DEBOUNCE ms wins); the old one's
//   geometry, materials and own textures are disposed (shared facade tiles stay: userData.shared). focus("roof" |
//   "street" | "full") glides the camera to the part an option changes (snaps in Calm). It orbits slowly by itself,
//   still in Calm; a drag orbits, the wheel zooms. Renders only while the canvas is on the page (and every frame
//   only while it moves).
var DEBOUNCE = 90;
function disposeTree(g){
  var seen = [];
  g.traverse(function(x){
    if(x.geometry) x.geometry.dispose();
    var ms = x.material ? (Array.isArray(x.material) ? x.material : [x.material]) : [];
    ms.forEach(function(m){
      ["map", "emissiveMap", "alphaMap", "normalMap", "roughnessMap"].forEach(function(k){ var t = m[k]; if(t && !(t.userData && t.userData.shared) && seen.indexOf(t) < 0){ seen.push(t); t.dispose(); } });
      m.dispose();
    });
  });
  return seen.length;
}
function preview(c, canvas, o){
  var THREE = c.THREE; o = o || {};
  var R = o.renderer ? o.renderer(canvas) : new THREE.WebGLRenderer({canvas: canvas, antialias: true, powerPreference: "low-power"});
  if(R.setPixelRatio) R.setPixelRatio(Math.min((window.devicePixelRatio || 1), 1.5));
  if(THREE.SRGBColorSpace && "outputColorSpace" in R) R.outputColorSpace = THREE.SRGBColorSpace;
  var scene = new THREE.Scene(), cam = new THREE.PerspectiveCamera(32, 1, 0.5, 900);
  var hemi = new THREE.HemisphereLight(0xdfefff, 0x3a3226, 2.0), sun = new THREE.DirectionalLight(0xfff2dc, 2.2);
  sun.position.set(30, 60, 40); scene.add(hemi); scene.add(sun);
  var ground = new THREE.Mesh(new THREE.CircleGeometry(60, 48), new THREE.MeshStandardMaterial({color: 0x56604f, roughness: 1}));
  ground.rotation.x = -PI/2; ground.position.y = -0.02; scene.add(ground);
  var B = null, timer = 0, night = false, dead = false, builds = 0, freed = 0, last = 0, dirty = true;
  var orb = {yaw: 0.55, pitch: 0.22, dist: 60, ty: 12, tz: 0}, goal = {pitch: 0.22, dist: 60, ty: 12, tz: 0}, part = "full";
  function bounds(){
    var M = B && B.M, top = B ? B.top() : 20;
    if(!M) return {full: {pitch: 0.22, dist: 60, ty: 10, tz: 0}};
    var span = Math.max(M.podium.w, M.podium.d), Rf = M.roof;
    return {full: {pitch: 0.2, dist: Math.max(top*1.55, span*3.2) + 8, ty: top*0.45, tz: 0},
            roof: {pitch: 0.62, dist: Math.max(Rf.w, Rf.d)*2.4 + 16, ty: top + 1.5, tz: Rf.z || 0},
            street: {pitch: 0.12, dist: span*1.9 + 10, ty: M.podium.h*0.55 + 0.6, tz: M.podium.d/2}};
  }
  function aim(snap){ var b = bounds(), g = b[part] || b.full; goal.pitch = g.pitch; goal.dist = g.dist; goal.ty = g.ty; goal.tz = g.tz; if(snap){ orb.pitch = g.pitch; orb.dist = g.dist; orb.ty = g.ty; orb.tz = g.tz; } dirty = true; }
  function lights(){
    hemi.intensity = night ? 0.5 : 2.0; sun.intensity = night ? 0.25 : 2.2;
    if(R.setClearColor) R.setClearColor(night ? 0x0b1422 : 0x9fc7e8, 1);
    ground.material.color.setHex(night ? 0x1d2420 : 0x56604f);
    if(B) B.setNight(night); dirty = true;
  }
  function build(){
    timer = 0; if(dead) return;
    if(B){ scene.remove(B.g); freed += disposeTree(B.g); B = null; }
    B = make(c, {level: o.level || function(){ return 1; }, look: o.look || function(){ return {}; }, prestige: o.prestige, grand: 1});
    scene.add(B.g); builds++; lights(); aim(builds === 1);
  }
  function resize(){
    var w = canvas.clientWidth || canvas.width || 300, h = canvas.clientHeight || canvas.height || 200;
    if(R.setSize) R.setSize(w, h, false); cam.aspect = w/h; cam.updateProjectionMatrix(); dirty = true;
  }
  function draw(t){
    if(dead || !B) return;
    var calm = o.calm && o.calm(), dt = last ? Math.min(0.1, t - last) : 0; last = t;
    var moving = !calm || Math.abs(orb.dist - goal.dist) > 0.05 || Math.abs(orb.ty - goal.ty) > 0.02 || Math.abs(orb.pitch - goal.pitch) > 0.002;
    if(!moving && !dirty) return;
    orb.yaw += dt*(calm ? 0.035 : 0.12);                                     // a slow turn; slower still in Calm
    var e = calm ? 1 : 1 - Math.exp(-dt*3.5);
    orb.pitch += (goal.pitch - orb.pitch)*e; orb.dist += (goal.dist - orb.dist)*e; orb.ty += (goal.ty - orb.ty)*e; orb.tz += (goal.tz - orb.tz)*e;
    var cp = Math.cos(orb.pitch);
    cam.position.set(Math.sin(orb.yaw)*cp*orb.dist, orb.ty + Math.sin(orb.pitch)*orb.dist, orb.tz + Math.cos(orb.yaw)*cp*orb.dist);
    cam.lookAt(0, orb.ty, orb.tz);
    if(B.animate && !calm) B.animate(t, dt, 1);
    R.render(scene, cam); dirty = false;
  }
  resize(); build();
  return {
    set: function(now){ if(dead) return; if(timer) clearTimeout(timer); if(now) build(); else timer = setTimeout(build, DEBOUNCE); },
    night: function(on){ if(on == null) return night; night = !!on; lights(); return night; },
    focus: function(p){ part = p === "roof" || p === "street" ? p : "full"; aim(o.calm && o.calm()); },
    resize: resize,
    drag: function(dx, dy){ orb.yaw -= dx*0.008; goal.pitch = orb.pitch = clamp(orb.pitch + dy*0.005, 0.02, 1.35); dirty = true; },
    zoom: function(dy){ goal.dist = orb.dist = clamp(orb.dist*Math.exp(dy*0.0012), 12, 260); dirty = true; },
    tick: draw, scene: scene,
    info: function(){ return {builds: builds, freed: freed, part: part, night: night, pending: !!timer, children: B ? B.g.children.length : 0, dist: goal.dist}; },
    dispose: function(){
      if(dead) return; dead = true; if(timer) clearTimeout(timer);
      if(B){ scene.remove(B.g); freed += disposeTree(B.g); B = null; }
      disposeTree(scene);
      try { R.dispose(); if(R.forceContextLoss) R.forceContextLoss(); } catch(e){}
    }
  };
}

HQV.hqTower = {make: make, preview: preview, massing: massing, footprint: footprint, crownSlots: crownSlots, roofDeck: roofDeck, PAD_R: PAD_R, PAD_MIN: PAD_MIN, WALK: WALK, HELI_UP: HELI_UP, FH: FH, PODIUM_H: PODIUM_H, TINT: TINT, FONT: FONT};
})();
