/* Claude HQ: interiors for HQ Studio (HQV.hqDecor), the HQ revamp's themes and placeable decor.
 *
 * A floor's theme (HQ Studio's int.themes[floor]: walls, floor, lighting mood, furniture set) and the decor placed on
 * its grid (int.items), built cheaply: the wall and floor finishes are canvas tiles drawn once per kind and shared;
 * every placed item is a few primitive parts, and each part type is ONE InstancedMesh for every item that uses it,
 * so forty plants, three aquariums and a piano cost a handful of draws.
 *   wallTex(c, kind) / floorTex(c, kind)   the shared tiles (RepeatWrapping)
 *   MOODS[mood]                           the lights: {hemi, sky, ground, lamp, lampK, bg: [day, night], accent}
 *   FURN[furn]                            a desk set's materials: {top, body, chair, strip, metal}
 *   items(c, parent, list, o)             the placed decor -> {g, n (draws), blocked(x, z), update(t, dt, k), dispose()}
 *                                         list: [{k, x, z, r}] (cells = metres, r quarter turns); o.cell (m, default 1)
 *   footprint(it)                         the cells an item covers [{x, z}] (rugs and bowls: none, you walk on them)
 *   grid(c, parent, half)                 the placement grid on the floor and its cursor -> {g, set(x, z), show(on)}
 */
(function(){
"use strict";
var HQV = window.HQV = window.HQV || {};
var PI = Math.PI;

var MOODS = {
  warm:    {hemi: 0xffe6c4, ground: 0x2a2018, lamp: 0xffd9a0, lampK: 1.0, bg: [0x8fb4cf, 0x0c1520], accent: 0xffb347},
  cool:    {hemi: 0xd4e6ff, ground: 0x18222c, lamp: 0xcfe6ff, lampK: 0.9, bg: [0x9fc6e4, 0x08121c], accent: 0x5fd3e6},
  sunset:  {hemi: 0xffc9a8, ground: 0x2a1812, lamp: 0xffa86b, lampK: 1.0, bg: [0xe8a27a, 0x1a0f18], accent: 0xff7b54},
  neon:    {hemi: 0xc8b6ff, ground: 0x140c24, lamp: 0xff6ad5, lampK: 0.8, bg: [0x6a5aa8, 0x0a0614], accent: 0x39f3ff},
  gallery: {hemi: 0xffffff, ground: 0x2c2c2c, lamp: 0xfff6ea, lampK: 1.15, bg: [0xcfd8de, 0x14181c], accent: 0xe9eff3},
  night:   {hemi: 0x9fb0d8, ground: 0x0a0e18, lamp: 0xffcf7a, lampK: 0.6, bg: [0x324a66, 0x05080e], accent: 0x9b8cf0}
};
var FURN = {
  standard:   {top: 0x2b3947, body: 0x1c2834, chair: [0x2f4459, 0x46303a, 0x2f4a3a, 0x3e3a52], strip: null, metal: 0x1d2730},
  executive:  {top: 0x5a3a24, body: 0x3a2618, chair: [0x2a1a12, 0x3a2016, 0x1e1410, 0x2c1c14], strip: 0xd8b34a, metal: 0x8a7a5a},
  industrial: {top: 0x6b6b6b, body: 0x2a2a2a, chair: [0x4a3a2a, 0x5a4a3a, 0x3a3a3a, 0x4a4a4a], strip: 0xff7b2f, metal: 0x3a3a3a},
  scandi:     {top: 0xd9c4a0, body: 0xeeeae2, chair: [0xb8c4c8, 0xd8d0c0, 0x9fb8a8, 0xe0c8b0], strip: 0x6fd38a, metal: 0xc8c8c8},
  gamer:      {top: 0x15151c, body: 0x0e0e14, chair: [0xd1243a, 0x2a6bd1, 0x1fbf5a, 0xd16b1f], strip: 0xff3d8b, metal: 0x111111},
  retro:      {top: 0xc87a3a, body: 0x5a7a6a, chair: [0xe0a84a, 0x6a9a8a, 0xd06a4a, 0x8a6aa0], strip: 0xffcf7a, metal: 0xa0a0a0}
};
var TEX = {};
function shared(c, key, w, h, draw){ var T = TEX[key]; if(!T){ T = TEX[key] = c.canvasTex(w, h, draw).t; } return T; }
// the wall finishes: paint, wallpaper, panelling, masonry; drawn on a 256 x 256 tile that repeats every 2.5 m
function wallTex(c, kind){
  return shared(c, "wall:" + kind, 256, 256, function(g, W){
    var R = c.rng(c.hashStr("wall" + kind));
    var paint = {slate: "#2e3c49", white: "#e9e6df", sage: "#9fb39a", navy: "#22314a", terracotta: "#b8684a", concrete: "#8a8c8a"}[kind];
    if(paint){ g.fillStyle = paint; g.fillRect(0, 0, W, W); for(var i = 0; i < 400; i++){ g.fillStyle = "rgba(" + (R() < 0.5 ? "0,0,0" : "255,255,255") + "," + (kind === "concrete" ? 0.08 : 0.025) + ")"; g.fillRect(R()*W, R()*W, 3, 3); }
      if(kind === "concrete"){ g.strokeStyle = "rgba(0,0,0,.18)"; g.lineWidth = 2; g.strokeRect(0, 0, W, W); g.fillStyle = "rgba(0,0,0,.2)"; [[40, 40], [216, 40], [40, 216], [216, 216]].forEach(function(p){ g.beginPath(); g.arc(p[0], p[1], 5, 0, 7); g.fill(); }); }
      g.fillStyle = "rgba(0,0,0,.18)"; g.fillRect(0, W - 14, W, 14); return; }                                     // a skirting board
    if(kind === "damask"){ g.fillStyle = "#4a1f2a"; g.fillRect(0, 0, W, W); g.fillStyle = "rgba(216,179,74,.35)";
      for(var y = 0; y < 2; y++) for(var x = 0; x < 2; x++){ var cx = 64 + x*128, cy = 64 + y*128; g.beginPath(); g.ellipse(cx, cy, 26, 46, 0, 0, 7); g.fill(); g.beginPath(); g.ellipse(cx, cy, 46, 18, 0, 0, 7); g.fill(); } return; }
    if(kind === "geo"){ g.fillStyle = "#1f2b3a"; g.fillRect(0, 0, W, W); g.strokeStyle = "#ffb347"; g.lineWidth = 3;
      for(var gy = 0; gy <= W; gy += 64) for(var gx = 0; gx <= W; gx += 64){ g.beginPath(); g.moveTo(gx, gy + 32); g.lineTo(gx + 32, gy); g.lineTo(gx + 64, gy + 32); g.lineTo(gx + 32, gy + 64); g.closePath(); g.stroke(); } return; }
    if(kind === "leaf"){ g.fillStyle = "#e8efe0"; g.fillRect(0, 0, W, W);
      for(var l = 0; l < 26; l++){ var lx = R()*W, ly = R()*W, a = R()*PI*2; g.fillStyle = R() < 0.5 ? "#4f8a5a" : "#6fae6a"; g.save(); g.translate(lx, ly); g.rotate(a); g.beginPath(); g.ellipse(0, 0, 18, 7, 0, 0, 7); g.fill(); g.restore(); } return; }
    if(kind === "oak"){ for(var s = 0; s < W; s += 32){ g.fillStyle = (s/32) & 1 ? "#8a5a35" : "#7a4e2c"; g.fillRect(s, 0, 30, W); g.fillStyle = "rgba(0,0,0,.35)"; g.fillRect(s + 30, 0, 2, W); } return; }
    if(kind === "brick"){ g.fillStyle = "#d8cfc4"; g.fillRect(0, 0, W, W); for(var by = 0; by < W; by += 16) for(var bx = (by/16) & 1 ? -16 : 0; bx < W; bx += 32){ g.fillStyle = ["#9a4a32", "#a8553a", "#8e4430"][Math.floor(R()*3)]; g.fillRect(bx + 1, by + 1, 30, 14); } return; }
    if(kind === "marble"){ g.fillStyle = "#e6e2da"; g.fillRect(0, 0, W, W); g.strokeStyle = "rgba(120,110,100,.35)"; g.lineWidth = 1.5;
      for(var m = 0; m < 8; m++){ g.beginPath(); g.moveTo(R()*W, 0); g.bezierCurveTo(R()*W, W*0.3, R()*W, W*0.6, R()*W, W); g.stroke(); } g.fillStyle = "rgba(0,0,0,.08)"; g.fillRect(0, 127, W, 2); return; }
    g.fillStyle = "#2e3c49"; g.fillRect(0, 0, W, W);
  });
}
// the floor finishes on a 512 tile that repeats every 6 m
function floorTex(c, kind){
  return shared(c, "floor:" + kind, 512, 512, function(g, W){
    var R = c.rng(c.hashStr("floor" + kind)), i, j;
    if(kind === "marble" || kind === "stone"){ var base = kind === "marble" ? 86 : 32;
      for(i = 0; i < 4; i++) for(j = 0; j < 4; j++){ g.fillStyle = "hsl(" + (kind === "marble" ? 40 : 205) + "," + (kind === "marble" ? 10 : 12) + "%," + (base + R()*5) + "%)"; g.fillRect(i*128 + 2, j*128 + 2, 124, 124);
        g.strokeStyle = kind === "marble" ? "rgba(120,110,100,.25)" : "rgba(255,255,255,.05)"; for(var v = 0; v < 3; v++){ g.beginPath(); g.moveTo(i*128 + R()*128, j*128); g.bezierCurveTo(i*128 + R()*128, j*128 + 40, i*128 + R()*128, j*128 + 80, i*128 + R()*128, j*128 + 128); g.stroke(); } } return; }
    if(kind === "oak" || kind === "walnut"){ var cols = kind === "oak" ? ["#a87a4a", "#9a6e40", "#b5865a"] : ["#5a3a24", "#4e321e", "#66432a"];
      for(j = 0; j < W; j += 32){ var off = R()*256; for(i = -1; i < 3; i++){ g.fillStyle = cols[Math.floor(R()*3)]; g.fillRect(off + i*256, j, 254, 30); } g.fillStyle = "rgba(0,0,0,.3)"; g.fillRect(0, j + 30, W, 2); } return; }
    if(kind === "terrazzo"){ g.fillStyle = "#d8d2c8"; g.fillRect(0, 0, W, W); for(i = 0; i < 1400; i++){ g.fillStyle = ["#7a6a5a", "#b5473a", "#3d6fd1", "#2a2a2a", "#c9a227"][Math.floor(R()*5)]; g.fillRect(R()*W, R()*W, 2 + R()*5, 2 + R()*4); } return; }
    if(kind === "carpet"){ g.fillStyle = "#3a4a6a"; g.fillRect(0, 0, W, W); for(i = 0; i < 3000; i++){ g.fillStyle = R() < 0.5 ? "rgba(255,255,255,.04)" : "rgba(0,0,0,.06)"; g.fillRect(R()*W, R()*W, 2, 2); }
      g.strokeStyle = "rgba(255,179,71,.25)"; g.lineWidth = 3; for(i = 0; i < W; i += 64){ g.beginPath(); g.moveTo(i, 0); g.lineTo(i, W); g.stroke(); } return; }
    if(kind === "concrete"){ g.fillStyle = "#7a7c7a"; g.fillRect(0, 0, W, W); for(i = 0; i < 2000; i++){ g.fillStyle = R() < 0.5 ? "rgba(0,0,0,.06)" : "rgba(255,255,255,.05)"; g.fillRect(R()*W, R()*W, 3, 3); }
      g.fillStyle = "rgba(0,0,0,.25)"; g.fillRect(0, 255, W, 2); g.fillRect(255, 0, 2, W); return; }
    if(kind === "checker"){ for(i = 0; i < 8; i++) for(j = 0; j < 8; j++){ g.fillStyle = (i + j) & 1 ? "#1a1a22" : "#e8e6e0"; g.fillRect(i*64, j*64, 64, 64); } return; }
    for(i = 0; i < 8; i++) for(j = 0; j < 8; j++){ g.fillStyle = "hsl(195,25%," + (40 + R()*8) + "%)"; g.fillRect(i*64 + 1, j*64 + 1, 62, 62); }            // tile
  });
}
/* ---------- the decor: each kind is parts; each part type one InstancedMesh ---------- */
// part: [geometry key, material key, x, y, z, sx, sy, sz, ry]  (the item faces +z at r 0; one cell = 1 m)
var GEO = {
  box: function(T){ return new T.BoxGeometry(1, 1, 1); }, cyl: function(T){ return new T.CylinderGeometry(0.5, 0.5, 1, 14); },
  cone: function(T){ return new T.ConeGeometry(0.5, 1, 10); }, sph: function(T){ return new T.SphereGeometry(0.5, 12, 8); },
  tor: function(T){ return new T.TorusGeometry(0.4, 0.08, 6, 18); }, plane: function(T){ return new T.PlaneGeometry(1, 1); }
};
var MAT = {
  pot: [0xd9d2c3, 0.9, 0], leaf: [0x3c9a5a, 0.85, 0], leaf2: [0x2f7d4a, 0.85, 0], trunk: [0x6b4a32, 0.9, 0], wood: [0x8a5a35, 0.6, 0], dark: [0x1d2128, 0.5, 0.5],
  gold: [0xd8b34a, 0.25, 0.9], steel: [0xb9c3cc, 0.3, 0.8], stone: [0xd6d0c4, 0.6, 0], fab: [0x2a5a64, 0.95, 0], fab2: [0x7a3a4a, 0.95, 0], red: [0xc8324a, 0.5, 0.1],
  water: [0x2a7fa8, 0.05, 0.1, 0x1a5f8a], glass: [0xbfe3f5, 0.05, 0.2], screen: [0x0b1622, 0.3, 0.2, 0x5fd3e6], neon: [0xff3d8b, 0.4, 0, 0xff3d8b], paper: [0xf2ece0, 0.9, 0],
  rug: [0x7a2f3a, 0.95, 0], rug2: [0x2f4a7a, 0.95, 0], white: [0xf2f5f7, 0.4, 0.1], fish: [0xffa040, 0.4, 0.1, 0x803000], hay: [0xd8c070, 0.95, 0], lamp: [0xfff1d6, 0.3, 0, 0xffd9a0]
};
var KINDS = {
  plant:    [["cyl", "pot", 0, 0.3, 0, 0.6, 0.6, 0.6], ["sph", "leaf", 0, 0.95, 0, 0.8, 1.0, 0.8], ["sph", "leaf2", 0.15, 1.3, 0.05, 0.5, 0.7, 0.5]],
  palm:     [["cyl", "pot", 0, 0.3, 0, 0.7, 0.6, 0.7], ["cyl", "trunk", 0, 1.4, 0, 0.14, 2.2, 0.14], ["cone", "leaf", 0, 2.55, 0, 1.6, 0.35, 1.6], ["cone", "leaf2", 0, 2.4, 0, 1.2, 0.5, 1.2]],
  bonsai:   [["box", "wood", 0, 0.35, 0, 0.6, 0.7, 0.6], ["box", "dark", 0, 0.75, 0, 0.55, 0.12, 0.4], ["cyl", "trunk", 0, 0.95, 0, 0.06, 0.35, 0.06], ["sph", "leaf2", 0, 1.15, 0, 0.6, 0.28, 0.45]],
  art:      [["box", "wood", 0, 0.7, -0.1, 0.06, 1.4, 0.06], ["box", "paper", 0, 1.35, 0.02, 0.9, 0.7, 0.04], ["box", "red", 0.1, 1.38, 0.05, 0.4, 0.3, 0.01]],
  sculpture:[["box", "stone", 0, 0.45, 0, 0.6, 0.9, 0.6], ["tor", "gold", 0, 1.3, 0, 1.0, 1.0, 1.0], ["sph", "steel", 0, 1.3, 0, 0.35, 0.35, 0.35]],
  trophy:   [["box", "wood", 0, 0.5, 0, 0.7, 1.0, 0.7], ["cyl", "gold", 0, 1.15, 0, 0.18, 0.3, 0.18], ["sph", "gold", 0, 1.38, 0, 0.36, 0.3, 0.36]],
  aquarium: [["box", "dark", 0, 0.4, 0, 1.9, 0.8, 0.8], ["box", "water", 0, 1.15, 0, 1.8, 0.7, 0.7], ["box", "fish", -0.3, 1.15, 0, 0.18, 0.08, 0.04], ["box", "fish", 0.4, 1.3, 0.1, 0.14, 0.07, 0.04], ["sph", "leaf", 0.6, 0.95, -0.1, 0.25, 0.4, 0.2]],
  arcade:   [["box", "dark", 0, 0.9, 0, 0.8, 1.8, 0.7], ["box", "screen", 0, 1.35, 0.33, 0.62, 0.5, 0.04], ["box", "neon", 0, 1.78, 0.33, 0.7, 0.14, 0.04], ["box", "red", 0, 0.95, 0.4, 0.6, 0.06, 0.25]],
  bookshelf:[["box", "wood", 0, 1.0, 0, 1.9, 2.0, 0.4], ["box", "red", -0.45, 0.62, 0.05, 0.8, 0.3, 0.3], ["box", "rug2", 0.45, 1.12, 0.05, 0.8, 0.3, 0.3], ["box", "paper", -0.3, 1.62, 0.05, 1.0, 0.3, 0.3]],
  rug:      [["box", "rug", 0, 0.01, 0, 2.8, 0.02, 1.9], ["box", "gold", 0, 0.015, 0, 2.2, 0.02, 1.3]],
  sofa:     [["box", "fab", 0, 0.25, 0, 1.9, 0.5, 0.85], ["box", "fab", 0, 0.65, -0.35, 1.9, 0.6, 0.18], ["box", "fab2", -0.45, 0.55, 0.05, 0.7, 0.14, 0.6], ["box", "fab2", 0.45, 0.55, 0.05, 0.7, 0.14, 0.6]],
  lamp:     [["cyl", "dark", 0, 0.03, 0, 0.4, 0.06, 0.4], ["cyl", "steel", 0, 0.9, 0, 0.04, 1.8, 0.04], ["cone", "lamp", 0, 1.85, 0, 0.5, 0.4, 0.5]],
  piano:    [["box", "dark", 0, 0.75, -0.1, 1.5, 0.5, 1.5], ["box", "white", 0, 0.82, 0.68, 1.3, 0.06, 0.2], ["cyl", "dark", -0.6, 0.35, -0.6, 0.1, 0.7, 0.1], ["cyl", "dark", 0.6, 0.35, -0.6, 0.1, 0.7, 0.1], ["cyl", "dark", 0, 0.35, 0.5, 0.1, 0.7, 0.1]],
  globe:    [["cyl", "wood", 0, 0.45, 0, 0.3, 0.9, 0.3], ["sph", "rug2", 0, 1.15, 0, 0.6, 0.6, 0.6], ["tor", "gold", 0, 1.15, 0, 0.85, 0.85, 0.85]],
  vending:  [["box", "red", 0, 1.0, 0, 0.9, 2.0, 0.8], ["box", "glass", -0.12, 1.15, 0.41, 0.55, 1.3, 0.02], ["box", "screen", 0.32, 1.3, 0.41, 0.16, 0.3, 0.02]],
  statue:   [["box", "stone", 0, 0.5, 0, 0.8, 1.0, 0.8], ["cyl", "stone", 0, 1.45, 0, 0.3, 0.9, 0.3], ["sph", "stone", 0, 2.05, 0, 0.36, 0.36, 0.36]],
  petbed:   [["cyl", "fab2", 0, 0.1, 0, 0.9, 0.2, 0.9], ["tor", "fab2", 0, 0.2, 0, 1.0, 1.0, 1.3], ["cyl", "paper", 0, 0.16, 0, 0.7, 0.05, 0.7]],
  cattree:  [["box", "fab", 0, 0.05, 0, 0.8, 0.1, 0.8], ["cyl", "hay", 0, 0.75, 0, 0.14, 1.5, 0.14], ["box", "fab", 0, 0.9, 0, 0.55, 0.08, 0.55], ["box", "fab", 0.1, 1.55, 0, 0.6, 0.08, 0.5], ["sph", "fab2", -0.15, 1.15, 0.1, 0.3, 0.3, 0.3]],
  perch:    [["cyl", "trunk", 0, 0.7, 0, 0.12, 1.4, 0.12], ["cyl", "trunk", 0, 1.4, 0, 0.06, 0.9, 0.06], ["box", "stone", 0, 0.05, 0, 0.6, 0.1, 0.6]],
  perchbig: [["box", "stone", 0, 0.4, 0, 1.8, 0.8, 1.8], ["cyl", "trunk", -0.5, 1.4, 0, 0.18, 1.6, 0.18], ["cyl", "trunk", 0.5, 1.4, 0, 0.18, 1.6, 0.18], ["cyl", "trunk", 0, 2.2, 0, 0.12, 1.6, 0.12], ["cone", "gold", 0, 0.85, 0, 0.6, 0.1, 0.6]],
  dinopen:  [["box", "hay", 0, 0.03, 0, 2.8, 0.06, 2.8], ["box", "wood", 0, 0.45, 1.4, 2.9, 0.12, 0.1], ["box", "wood", 0, 0.45, -1.4, 2.9, 0.12, 0.1], ["box", "wood", 1.4, 0.45, 0, 0.1, 0.12, 2.9], ["box", "wood", -1.4, 0.45, 0, 0.1, 0.12, 2.9],
             ["cyl", "trunk", 1.4, 0.35, 1.4, 0.12, 0.7, 0.12], ["cyl", "trunk", -1.4, 0.35, 1.4, 0.12, 0.7, 0.12], ["cyl", "trunk", 1.4, 0.35, -1.4, 0.12, 0.7, 0.12], ["cyl", "trunk", -1.4, 0.35, -1.4, 0.12, 0.7, 0.12]],
  bowl:     [["cyl", "steel", -0.18, 0.05, 0, 0.28, 0.1, 0.28], ["cyl", "steel", 0.18, 0.05, 0, 0.28, 0.1, 0.28], ["cyl", "water", 0.18, 0.09, 0, 0.22, 0.02, 0.22]],
  pond:     [["cyl", "stone", 0, 0.12, 0, 1.9, 0.24, 1.9], ["cyl", "water", 0, 0.2, 0, 1.6, 0.06, 1.6], ["sph", "leaf", 0.5, 0.25, 0.3, 0.3, 0.06, 0.3], ["box", "fish", -0.3, 0.2, 0.1, 0.18, 0.06, 0.06]]
};
var WALK = {rug: 1, bowl: 1, dinopen: 1, petbed: 1};    // you walk over these (a pen's fence is low; pets stand in it)
function footprint(it){
  if(!it || WALK[it.k]) return [];
  var S = HQV.hqStyle && HQV.hqStyle.SIZE && HQV.hqStyle.SIZE[it.k] || [1, 1], w = S[0], d = S[1];
  if((it.r | 0) % 2){ var t = w; w = d; d = t; }
  var out = [];
  for(var i = 0; i < w; i++) for(var j = 0; j < d; j++) out.push({x: it.x + i - Math.floor((w - 1)/2), z: it.z + j - Math.floor((d - 1)/2)});
  return out;
}
function items(c, parent, list, o){
  var THREE = c.THREE; o = o || {};
  var cell = o.cell || 1, g = new THREE.Group(); g.name = "hq-decor"; parent.add(g);
  var groups = {}, cells = {}, m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), p = new THREE.Vector3(), s = new THREE.Vector3();
  (list || []).forEach(function(it){
    var K = KINDS[it.k]; if(!K) return;
    footprint(it).forEach(function(f){ cells[f.x + ":" + f.z] = 1; });
    var ry = -((it.r | 0) % 4)*PI/2, cr = Math.cos(ry), sr = Math.sin(ry);
    K.forEach(function(P, n){
      var key = P[0] + "|" + P[1], G = groups[key] || (groups[key] = {geo: P[0], mat: P[1], list: []});
      var lx = P[2], lz = P[4];
      G.list.push({x: it.x*cell + lx*cr + lz*sr, y: P[3], z: it.z*cell - lx*sr + lz*cr, sx: P[5], sy: P[6], sz: P[7], ry: ry + (P[8] || 0) + (P[0] === "tor" && it.k !== "petbed" ? PI/2 : 0), rx: P[0] === "tor" && it.k === "petbed" ? PI/2 : 0});
    });
  });
  var n = 0, anim = [];
  Object.keys(groups).forEach(function(key){
    var G = groups[key], M = MAT[G.mat], mt = new THREE.MeshStandardMaterial({color: M[0], roughness: M[1], metalness: M[2]});
    if(M[3] != null){ mt.emissive = new THREE.Color(M[3]); mt.emissiveIntensity = G.mat === "screen" || G.mat === "neon" || G.mat === "lamp" ? 1.2 : 0.35; }
    if(G.mat === "water" || G.mat === "glass"){ mt.transparent = true; mt.opacity = G.mat === "water" ? 0.75 : 0.35; }
    var im = new THREE.InstancedMesh(GEO[G.geo](THREE), mt, G.list.length);
    G.list.forEach(function(I, i){ e.set(I.rx, I.ry, 0); q.setFromEuler(e); p.set(I.x, I.y, I.z); s.set(I.sx, I.sy, I.sz); m4.compose(p, q, s); im.setMatrixAt(i, m4); });
    im.castShadow = G.mat !== "rug" && G.mat !== "water"; im.receiveShadow = true; im.name = "decor:" + key; g.add(im); n++;
    if(G.mat === "fish") anim.push({im: im, list: G.list});
  });
  return {g: g, n: n,
    blocked: function(x, z){ return !!cells[Math.round(x/cell) + ":" + Math.round(z/cell)]; },
    update: function(t, dt, k){
      anim.forEach(function(A){ A.list.forEach(function(I, i){ e.set(0, I.ry + Math.sin(t*0.8 + i)*0.6*k, 0); q.setFromEuler(e); p.set(I.x + Math.sin(t*0.7 + i*1.3)*0.25*k, I.y + Math.sin(t*1.1 + i)*0.05*k, I.z); s.set(I.sx, I.sy, I.sz); m4.compose(p, q, s); A.im.setMatrixAt(i, m4); }); A.im.instanceMatrix.needsUpdate = true; });
    },
    dispose: function(){ if(g.parent) g.parent.remove(g); g.traverse(function(x){ if(x.isMesh){ x.geometry.dispose(); x.material.dispose(); } }); }};
}
// the placement grid on the floor (HQ Studio's Layout tab): lines every metre, the cursor's cells (the item's whole
// footprint) and a translucent ghost of the item to place; set(x, z, {k, r, ok}): green where it fits, red where it does not
var GHOST_OK = 0x6fd38a, GHOST_BAD = 0xff6b5b;
function grid(c, parent, half){
  var THREE = c.THREE, g = new THREE.Group(); g.name = "hq-studio-grid"; g.visible = false; parent.add(g);
  var gh = new THREE.GridHelper(2*half + 1, 2*half + 1, 0xffb347, 0x5fd3e6); gh.position.y = 0.03; gh.material.transparent = true; gh.material.opacity = 0.45; g.add(gh);
  var curM = new THREE.MeshBasicMaterial({color: 0xffb347, transparent: true, opacity: 0.55, toneMapped: false, depthWrite: false});
  var cur = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), curM);
  cur.rotation.x = -PI/2; cur.position.y = 0.04; g.add(cur);
  var gw = new THREE.Group(); gw.name = "hq-studio-ghost"; g.add(gw);
  var ghost = null, ghostKey = null, ghostOk = null;
  function tint(ok){
    if(ghostOk === ok) return; ghostOk = ok; var col = ok === false ? GHOST_BAD : GHOST_OK;
    curM.color.setHex(ok == null ? 0xffb347 : col);
    if(ghost) ghost.g.traverse(function(x){ if(x.isMesh){ x.material.emissive.setHex(col); } });
  }
  function setGhost(k, r){
    var key = k ? k + ":" + (r | 0) : null; if(key === ghostKey) return; ghostKey = key;
    if(ghost){ ghost.dispose(); ghost = null; }
    if(!k || !KINDS[k]) return;
    ghost = items(c, gw, [{k: k, f: "ghost", x: 0, z: 0, r: r | 0}]);
    ghost.g.traverse(function(x){ if(x.isMesh){ var m = x.material; m.transparent = true; m.opacity = 0.55; m.depthWrite = false; m.emissive = new THREE.Color(GHOST_OK); m.emissiveIntensity = 0.45; x.castShadow = false; x.renderOrder = 2; } });
    ghostOk = null;
  }
  return {g: g, show: function(on){ g.visible = !!on; },
    set: function(x, z, o){
      o = o || {};
      var S = HQV.hqStyle && HQV.hqStyle.SIZE && HQV.hqStyle.SIZE[o.k] || [1, 1], w = S[0], d = S[1];
      if((o.r | 0) % 2){ var t = w; w = d; d = t; }
      cur.scale.set(w, d, 1);
      cur.position.x = x - Math.floor((w - 1)/2) + (w - 1)/2; cur.position.z = z - Math.floor((d - 1)/2) + (d - 1)/2;
      setGhost(o.k, o.r); gw.position.set(x, 0, z); tint(o.k ? o.ok !== false : null);
    },
    ghost: function(){ return ghost ? {k: ghostKey, ok: ghostOk, n: ghost.n} : null; },
    dispose: function(){ if(ghost){ ghost.dispose(); ghost = null; } }};
}
// Would item it ({k, f, x, z, r}) go here? Pure (the Layout tab's ghost and click): every cell of its footprint on the floor's
// grid, not on another piece (rugs, bowls, pens and beds are walked over: they overlap anything), the floor and the whole
// HQ under their caps. The same cell as a placed item replaces it (HQV.hqStyle.place does). -> {ok, why, replace}
function cellsOf(it){
  var S = HQV.hqStyle && HQV.hqStyle.SIZE && HQV.hqStyle.SIZE[it.k] || [1, 1], w = S[0], d = S[1];
  if((it.r | 0) % 2){ var t = w; w = d; d = t; }
  var out = [];
  for(var i = 0; i < w; i++) for(var j = 0; j < d; j++) out.push({x: it.x + i - Math.floor((w - 1)/2), z: it.z + j - Math.floor((d - 1)/2)});
  return out;
}
function fit(list, it, lim){
  lim = lim || {}; var half = lim.grid || 13, perMax = lim.maxPerFloor || 32, allMax = lim.max || 48;
  if(!it || !KINDS[it.k]) return {ok: false, why: "Pick an item first."};
  var all = cellsOf(it);
  for(var i = 0; i < all.length; i++) if(Math.abs(all[i].x) > half || Math.abs(all[i].z) > half) return {ok: false, why: "That runs off the floor."};
  var here = (list || []).filter(function(o){ return o.f === it.f; });
  var same = here.filter(function(o){ return o.x === it.x && o.z === it.z; })[0] || null;
  if(!same && here.length >= perMax) return {ok: false, why: "That floor is full (" + perMax + " items)."};
  if(!same && (list || []).length >= allMax) return {ok: false, why: "Your HQ is full (" + allMax + " items)."};
  if(!WALK[it.k]){
    var mine = {}; all.forEach(function(f){ mine[f.x + ":" + f.z] = 1; });
    for(var n = 0; n < here.length; n++){
      var o = here[n]; if(o === same || WALK[o.k]) continue;
      var fp = cellsOf(o);
      for(var m = 0; m < fp.length; m++) if(mine[fp[m].x + ":" + fp[m].z]) return {ok: false, why: "That overlaps the " + ((HQV.hqStyle && HQV.hqStyle.LABELS[o.k]) || o.k).toLowerCase() + ".", on: o};
    }
  }
  return {ok: true, why: same ? "Replaces the " + ((HQV.hqStyle && HQV.hqStyle.LABELS[same.k]) || same.k).toLowerCase() + "." : "", replace: !!same};
}
// small pictures of every kind for the Layout tab's picker: rendered once on a throwaway renderer (its context is lost
// straight after), cached as data URLs. mk(canvas) makes the renderer (a test's fake); null when WebGL is not there.
var THUMBS = null;
function thumbs(c, size, mk){
  if(THUMBS) return THUMBS;
  var THREE = c.THREE, R = null, cv = null; size = size || 72;
  try {
    cv = document.createElement("canvas"); cv.width = cv.height = size;
    R = mk ? mk(cv) : new THREE.WebGLRenderer({canvas: cv, antialias: true, alpha: true, preserveDrawingBuffer: true});
  } catch(e){ return null; }
  var sc = new THREE.Scene(), cam = new THREE.PerspectiveCamera(30, 1, 0.1, 50);
  sc.add(new THREE.HemisphereLight(0xffffff, 0x445566, 2.2)); var dl = new THREE.DirectionalLight(0xffffff, 1.6); dl.position.set(3, 6, 4); sc.add(dl);
  if(R.setClearColor) R.setClearColor(0x000000, 0);
  var out = {};
  Object.keys(KINDS).forEach(function(k){
    var D = items(c, sc, [{k: k, f: "thumb", x: 0, z: 0, r: 0}]);
    var box = new THREE.Box3().setFromObject(D.g), ctr = box.getCenter(new THREE.Vector3()), sz = box.getSize(new THREE.Vector3()), r = Math.max(sz.x, sz.y, sz.z, 0.4);
    cam.position.set(ctr.x + r*1.5, ctr.y + r*1.25, ctr.z + r*1.9); cam.lookAt(ctr); cam.updateProjectionMatrix();
    try { R.render(sc, cam); out[k] = cv.toDataURL("image/png"); } catch(e){ out[k] = null; }
    D.dispose();
  });
  try { R.dispose(); if(R.forceContextLoss) R.forceContextLoss(); } catch(e){}
  THUMBS = out; return out;
}
// Mission Control's theme (hq3d.js's own room): refs = {floor (its mesh), wallM, lamps, room (half size)}. apply(style)
// swaps the finishes and the light, places the floor's decor, and says whether the desks' furniture set changed (they
// are rebuilt then); furn() is the desks' set; grid(o) the Layout tab's grid; blocked(x, z) the decor's cells.
function mission(c, scene, refs){
  var THREE = c.THREE, S = HQV.hqStyle, key = null, furn = "standard", deco = null, gridO = grid(c, scene, 13);
  var floorM = refs.floor && refs.floor.material, map0 = floorM ? floorM.map : null, wall0 = refs.wallM ? refs.wallM.map : null, wcol0 = refs.wallM ? refs.wallM.color.getHex() : 0;
  return {
    apply: function(style){
      if(!S) return false;
      var st = style ? S.clean(style) : null, T = st ? st.int.themes.mission : null;
      var k = JSON.stringify(st ? [T, st.int.items.filter(function(it){ return it.f === "mission"; })] : null);
      if(k === key) return false; key = k;
      var was = furn; furn = T ? T.furn : "standard";
      if(deco){ deco.dispose(); deco = null; }
      if(!T){ if(floorM){ floorM.map = map0; floorM.needsUpdate = true; } if(refs.wallM){ refs.wallM.map = wall0; refs.wallM.color.setHex(wcol0); refs.wallM.needsUpdate = true; } return was !== furn; }
      if(floorM){ var ft = floorTex(c, T.floor); ft.wrapS = ft.wrapT = THREE.RepeatWrapping; ft.repeat.set(5, 5); floorM.map = ft; floorM.needsUpdate = true; }
      if(refs.wallM){ var wt = wallTex(c, T.wall); wt.wrapS = wt.wrapT = THREE.RepeatWrapping; wt.repeat.set(12, 3); refs.wallM.map = wt; refs.wallM.color.setHex(0xffffff); refs.wallM.needsUpdate = true; }
      var Mo = MOODS[T.mood] || MOODS.warm; (refs.lamps || []).forEach(function(l){ l.color.setHex(Mo.lamp); });
      deco = items(c, scene, st.int.items.filter(function(it){ return it.f === "mission"; }));
      return was !== furn;
    },
    furn: function(){ return FURN[furn] || FURN.standard; },
    grid: function(o){ gridO.show(!!o && o.f === "mission"); if(o) gridO.set(o.x, o.z, o); },
    blocked: function(x, z){ return !!deco && deco.blocked(x, z); },
    update: function(t, dt, k){ if(deco) deco.update(t, dt, k); }
  };
}
HQV.hqDecor = {MOODS: MOODS, mission: mission, FURN: FURN, KINDS: KINDS, wallTex: wallTex, floorTex: floorTex, items: items, footprint: footprint, grid: grid, fit: fit, cellsOf: cellsOf, thumbs: thumbs};
})();
