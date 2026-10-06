/* Valley: shared fishing art, physics and sound (used by fishing.js and multi.js's pond).
 *
 * One module so the solo pond and the shared dock look, sound and reel the same:
 *   scene     320x180 pixel scene: time-of-day sky, seeded hills, water, dock, night tint
 *   rig       one angler's line: charge -> cast arc -> nibbles -> bite -> reel -> result
 *   reelSim   the catch-bar minigame (momentum bar, five fish motion types, treasure, perfect)
 *   shadows   fish shadows that wander and come to the bobber (size = rarity)
 *   fx        ripples, splash droplets, sparkles, rising popups
 *   drawFish / fishCanvas / drawAngler / drawBobber / drawLine / text (3x5 pixel font)
 *   sizeFor   real length/weight: each pond fish is modelled on a real species and uses its
 *             FishBase length-weight relationship W = a*L^b (grams, cm) and common/max length
 *   sfx       tiny WebAudio synth (no audio files, no network); off in calm mode by default
 * Everything is drawn from pixel maps in code; nothing is fetched at runtime.
 */
(function(){
"use strict";
var HQV = window.HQV; if(!HQV || !HQV.api) return;
var api = HQV.api;
var W = 320, H = 180, HZ = 78;           // logical size and horizon row

/* ---------- colour helpers (canvas pixels only) ---------- */
function rgb(hex){ var n = parseInt(hex.slice(1), 16); return [n>>16&255, n>>8&255, n&255]; }
function css(c, a){ return a==null ? "rgb("+(c[0]|0)+","+(c[1]|0)+","+(c[2]|0)+")" : "rgba("+(c[0]|0)+","+(c[1]|0)+","+(c[2]|0)+","+a+")"; }
function mixc(a, b, t){ return [a[0]+(b[0]-a[0])*t, a[1]+(b[1]-a[1])*t, a[2]+(b[2]-a[2])*t]; }
function mixHex(h, toward, t){ return css(mixc(rgb(h), toward, t)); }
var BLACK = [0,0,0], WHITE = [255,255,255];
function clamp(v, a, b){ return v < a ? a : v > b ? b : v; }
function newCanvas(w, h){ var c = document.createElement("canvas"); c.width = w; c.height = h; return c; }

/* ---------- 3x5 pixel font (rows top->bottom, 3 bits each) ---------- */
var FONT = {
  "0":"111101101101111","1":"010110010010111","2":"111001111100111","3":"111001011001111","4":"101101111001001",
  "5":"111100111001111","6":"111100111101111","7":"111001010010010","8":"111101111101111","9":"111101111001111",
  A:"010101111101101",B:"110101110101110",C:"011100100100011",D:"110101101101110",E:"111100110100111",
  F:"111100110100100",G:"011100101101011",H:"101101111101101",I:"111010010010111",J:"001001001101010",
  K:"101101110101101",L:"100100100100111",M:"101111111101101",N:"110101101101101",O:"010101101101010",
  P:"110101110100100",Q:"010101101110011",R:"110101110101101",S:"011100010001110",T:"111010010010010",
  U:"101101101101111",V:"101101101101010",W:"101101111111101",X:"101101010101101",Y:"101101010010010",
  Z:"111001010100111","!":"010010010000010","+":"000010111010000","-":"000000111000000","/":"001001010100100",
  ":":"000010000010000",".":"000000000000010","?":"110001010000010","*":"000101010101000","'":"010010000000000",
  " ":"000000000000000","#":"101111101111101","%":"101001010100101"
};
function textWidth(s, sc){ return Math.max(0, String(s).length*4-1)*(sc||1); }
function text(g, s, x, y, col, sc){
  sc = sc||1; s = String(s).toUpperCase(); g.fillStyle = col;
  for(var i=0;i<s.length;i++){
    var m = FONT[s[i]] || FONT["?"];
    for(var r=0;r<5;r++) for(var c=0;c<3;c++) if(m[r*3+c]==="1") g.fillRect(x+(i*4+c)*sc, y+r*sc, sc, sc);
  }
}
// Text with a dark 1px backing box, for name tags and banners.
function label(g, s, cx, y, col, sc){
  sc = sc||1; var w = textWidth(s, sc), x = Math.round(cx - w/2);
  g.fillStyle = "rgba(10,14,24,0.72)"; g.fillRect(x-2, y-2, w+4, 5*sc+4);
  text(g, s, x, y, col, sc);
}

/* ---------- species: art template, reel behaviour, real-world size data ---------- */
// Size data per real species: [scientific name, a, b, common length cm, max length cm].
// a and b are FishBase's Bayesian length-weight estimates (W grams = a * L cm ^ b);
// lengths are FishBase's common / maximum lengths (common = 0.6*max where FishBase lists none).
// Source: FishBase (Froese & Pauly, eds.), species summary pages, fetched 2026-10-06.
var SPECIES = {
  minnow:   {tpl:"slim",  beh:"smooth",  diff:15,  real:["Phoxinus phoxinus",0.00708,3.14,7,14]},
  perch:    {tpl:"slim",  beh:"mixed",   diff:25,  real:["Perca fluviatilis",0.00912,3.11,25,60]},
  carp:     {tpl:"round", beh:"smooth",  diff:15,  real:["Cyprinus carpio",0.01778,2.95,31,129]},
  mudcat:   {tpl:"eel",   beh:"sinker",  diff:25,  real:["Pylodictis olivaris",0.00589,3.11,93,155], whiskers:true},
  bream:    {tpl:"round", beh:"mixed",   diff:35,  real:["Abramis brama",0.00759,3.14,25,82]},
  trout:    {tpl:"slim",  beh:"dart",    diff:45,  real:["Salmo trutta",0.00871,3.03,72,140]},
  pike:     {tpl:"slim",  beh:"dart",    diff:55,  real:["Esox lucius",0.00447,3.08,40,137]},
  eel:      {tpl:"eel",   beh:"smooth",  diff:60,  real:["Anguilla anguilla",0.00095,3.17,35,122]},
  sunfish:  {tpl:"round", beh:"floater", diff:40,  real:["Lepomis gibbosus",0.01148,3.11,9.9,40]},
  koi:      {tpl:"round", beh:"mixed",   diff:60,  real:["Cyprinus rubrofuscus",0.01122,3.02,16.8,28]},
  sturgeon: {tpl:"big",   beh:"sinker",  diff:70,  real:["Acipenser fulvescens",0.00269,3.19,97.5,274]},
  angler:   {tpl:"angler",beh:"sinker",  diff:70,  real:["Lophius piscatorius",0.01585,2.92,100,200]},
  glowfin:  {tpl:"angler",beh:"floater", diff:75,  real:["Myctophum punctatum",0.00708,3.15,6.6,11]},
  lumen:    {tpl:"ray",   beh:"dart",    diff:85,  real:["Potamotrygon motoro",0.01,3.04,30,50]},
  ghostfish:{tpl:"big",   beh:"mixed",   diff:90,  real:["Apteronotus albifrons",0.00331,3.05,30,50]},
  leviathan:{tpl:"big",   beh:"dart",    diff:100, real:["Huso huso",0.00417,3.12,215,800]}
};
var TPL = {
  slim:  ["................","......3333......",".3..33111113....",".33311111145133.",".3311122221113..",".33.3222222113..",".3....33333.....","................"],
  round: [".......33.......",".....331113.....",".3..31111145....",".33311111111133.",".33312222222213.",".3...3222223....",".......333......","................"],
  eel:   ["................","................",".33..3333333333.","3113311111111453",".3322222222221..","..33333333333...","................","................"],
  ray:   ["......3333......","....33111133....","..331114511133..","3311112222111133","..331122221133..","....33111133....","......3..3......","........3......."],
  angler:["..........2.....","...........3....","....33333333....",".3.3111111453...",".33111111111113.",".3.3122222223...","....3.3.3.3.....","................"],
  big:   ["................","....3333333.....","3.331111111333..","3311111111114513","3311122222222113","3.3322222222333.","....33333333....","................"]
};
function tplFor(id){
  var sp = SPECIES[id], rows = TPL[(sp && sp.tpl) || "slim"];
  if(sp && sp.whiskers){ rows = rows.slice(); rows[4] = rows[4].slice(0,14)+"55"; rows[5] = rows[5].slice(0,13)+"5.."; }
  return rows;
}
// Length (cm) and weight (kg) from the species' real data. u in [0,1) picks where in the
// size range this one falls (u >= 0.8 is a "big one").
function sizeFor(id, u, perfect){
  var sp = SPECIES[id], r = sp ? sp.real : ["",0.01,3,20,40];
  var len = r[3]*(0.6 + 0.9*Math.pow(u, 1.6))*(perfect ? 1.1 : 1);
  len = Math.min(r[4], len);
  var g = r[1]*Math.pow(len, r[2]);
  return {len: Math.round(len*10)/10, kg: Math.round(g/10)/100, big: u >= 0.8, latin: r[0]};
}
function fmtKg(kg){ return kg >= 1000 ? (kg/1000).toFixed(2)+" t" : kg >= 1 ? kg.toFixed(2)+" kg" : Math.max(1, Math.round(kg*1000))+" g"; }

function fishPal(id, sil){
  if(sil) return {"1":"#1d2a33","2":"#1d2a33","3":"#1d2a33","4":"#1d2a33","5":"#1d2a33"};
  var it = api.items[id] || {c1:"#9fb4c7", c2:"#dfe8f0"};
  return {"1":it.c1, "2":it.c2, "3":mixHex(it.c1, BLACK, 0.35), "4":"#ffffff", "5":"#1a1a1a"};
}
var FC = {};
// Cached fish canvas, facing right (flip=true faces left). sil = black silhouette.
function fishCanvas(id, scale, flip, sil){
  scale = scale||1;
  var k = id+"@"+scale+(flip?"f":"")+(sil?"s":""); if(FC[k]) return FC[k];
  var base = api.sprite("fa:"+id+(sil?":sil":""), tplFor(id), fishPal(id, sil), scale);
  if(!flip){ FC[k] = base; return base; }
  var c = newCanvas(base.width, base.height), g = c.getContext("2d");
  g.translate(base.width, 0); g.scale(-1, 1); g.drawImage(base, 0, 0);
  FC[k] = c; return c;
}
// 1px glow ring in the fish's highlight colour (legendary fish).
function glowCanvas(id, scale, flip){
  var k = "glow:"+id+"@"+scale+(flip?"f":""); if(FC[k]) return FC[k];
  var rows = tplFor(id), h = rows.length, w = rows[0].length, c = newCanvas((w+2)*scale, (h+2)*scale), g = c.getContext("2d");
  g.fillStyle = (api.items[id]||{c2:"#ffffff"}).c2;
  function filled(x, y){ return y>=0 && y<h && x>=0 && x<w && rows[y][x] !== "."; }
  for(var y=-1;y<=h;y++) for(var x=-1;x<=w;x++){
    if(filled(x,y)) continue;
    if(filled(x-1,y)||filled(x+1,y)||filled(x,y-1)||filled(x,y+1)){
      var dx = flip ? (w-1-x) : x;
      g.fillRect((dx+1)*scale, (y+1)*scale, scale, scale);
    }
  }
  FC[k] = c; return c;
}
// Draw a fish centred at (x, y). t drives the legendary sparkle / ghost flicker.
function drawFish(g, id, x, y, scale, flip, t){
  scale = scale||1;
  var c = fishCanvas(id, scale, flip), it = api.items[id] || {}, calm = api.calm();
  var x0 = Math.round(x - c.width/2), y0 = Math.round(y - c.height/2);
  if(it.rarity === 4){
    g.globalAlpha = 0.5; g.drawImage(glowCanvas(id, scale, flip), x0-scale, y0-scale); g.globalAlpha = 1;
  }
  if(id === "ghostfish") g.globalAlpha = calm ? 0.75 : (Math.floor((t||0)/180)%2 ? 0.75 : 0.6);
  g.drawImage(c, x0, y0);
  g.globalAlpha = 1;
  if(it.rarity === 4){
    var ph = calm ? 0 : Math.floor((t||0)/220)%4, pts = [[2,-2],[c.width/scale-2,1],[4,c.height/scale],[c.width/scale-5,-1]];
    g.fillStyle = "#fff7c2";
    for(var i=0;i<2;i++){ var p = pts[(ph+i*2)%4]; g.fillRect(x0+p[0]*scale, y0+p[1]*scale, scale, scale); }
  }
  if(SPECIES[id] && SPECIES[id].tpl === "angler" && !calm && Math.floor((t||0)/400)%2){
    g.fillStyle = "#fff7c2"; g.fillRect(x0+(flip?5:10)*scale, y0, scale, scale);   // the lure blinks
  }
}

/* ---------- angler (12x18) ---------- */
var ANGLER = {
  idle:["....KKKK....","...KHHHHK...","..KHHHHHHK..",".KKKKKKKKKK.","...KSSSSK...","...KSKSSK...","...KSSSSK...","....KKKK....",
        "...KCCCCK...","..KCCCCCCK..","..KCKCCKCK..","..KSKCCKSK..","...KCCCCK...","...KPPPPK...","...KPKKPK...","...KPK.KPK..","..KBBK.KBBK.","..KKK...KKK."]
};
ANGLER.reel = ANGLER.idle.slice(); ANGLER.reel[10] = "..KCCCCCCK.."; ANGLER.reel[11] = "...KSCCSK...";
ANGLER.cheer = ANGLER.idle.slice();
ANGLER.cheer[3] = ".KKKKKKKKKK."; ANGLER.cheer[4] = ".S.KSSSSK.S."; ANGLER.cheer[5] = ".K.KSKSSK.K."; ANGLER.cheer[6] = ".K.KSSSSK.K.";
ANGLER.cheer[7] = ".KK.KKKK.KK."; ANGLER.cheer[8] = "..KKCCCCKK.."; ANGLER.cheer[9] = "...KCCCCK..."; ANGLER.cheer[10] = "...KCCCCK..."; ANGLER.cheer[11] = "...KCCCCK...";
var HATS = ["#d8435a","#3a6fd8","#e8c13a","#4c9a3a","#7a3fb0","#e07b25","#2fa3a0","#c9a14a","#e05aa0","#5b6b8a"];
var COATS = ["#4f7ec9","#c95b4f","#5fae4a","#b07a3f","#8a5fc9","#3f8a8a","#c9a94f","#6a6f7a","#c94f8a","#4fa86f"];
function looks(seed){ var h = api.hash(seed||"me"); return {hat:HATS[h%10], coat:COATS[(h>>>4)%10]}; }
function anglerCanvas(frame, lk){
  var rows = ANGLER[frame] || ANGLER.idle;
  return api.sprite("ang:"+frame+lk.hat+lk.coat, rows, {K:"#2a2230", S:"#f2c99a", H:lk.hat, C:lk.coat, P:"#3b3f5c", B:"#4a3426"}, 1);
}
// o: {frame, look, flip, me, slump, bob}. (x, y) is the top-left; returns the rod hand.
function drawAngler(g, x, y, o){
  o = o||{}; var lk = o.look || looks("me"), frame = o.frame || "idle";
  var c = anglerCanvas(frame === "slump" ? "idle" : frame, lk), b = o.bob|0;
  if(o.me){ g.fillStyle = "#ffd75a"; for(var i=-6;i<=6;i++){ var dy = Math.round(Math.sqrt(Math.max(0, 1-(i*i)/36))*2); g.fillRect(x+6+i, y+18+dy-1, 1, 1); g.fillRect(x+6+i, y+18-dy, 1, 1); } }
  g.save();
  if(o.flip){ g.translate(x*2+12, 0); g.scale(-1, 1); }
  if(frame === "slump"){ g.drawImage(c, 0, 8, 12, 10, x, y+8, 12, 10); g.drawImage(c, 0, 0, 12, 8, x, y+1, 12, 8); }
  else g.drawImage(c, x, y+b);
  g.restore();
  return {x: x + (o.flip ? 3 : 8), y: y + 11 + b};
}
// The rod: a 2px stepped line from the hand at `deg` from vertical, toward `dir` (+1 right).
function drawRod(g, hand, deg, dir){
  var a = deg*Math.PI/180, dx = Math.sin(a)*dir, dy = -Math.cos(a), tip = null;
  for(var i=0;i<=16;i++){
    var px = Math.round(hand.x + dx*i), py = Math.round(hand.y + dy*i);
    g.fillStyle = i >= 15 ? "#e8d2a8" : "#7a5a3a"; g.fillRect(px, py, 1, 1);
    if(i < 12){ g.fillStyle = "#5a3f26"; g.fillRect(px + (dir>0?-1:1), py, 1, 1); }
    tip = {x:px, y:py};
  }
  return tip;
}

/* ---------- line + bobber ---------- */
function drawLine(g, x0, y0, x1, y1, sag, night){
  var cx = (x0+x1)/2, cy = (y0+y1)/2 + sag;
  g.fillStyle = night ? "rgba(220,230,255,0.6)" : "rgba(255,255,255,0.7)";
  var lx = null, ly = null;
  for(var i=0;i<=40;i++){
    var u = i/40, a = (1-u)*(1-u), b = 2*(1-u)*u, c = u*u;
    var px = Math.round(a*x0 + b*cx + c*x1), py = Math.round(a*y0 + b*cy + c*y1);
    if(px !== lx || py !== ly) g.fillRect(px, py, 1, 1);
    lx = px; ly = py;
  }
}
var BOBBER = ["..K..",".KRK.","KRRRK","KWWWK",".KWK.","..K..","..K.."];
// (x, y) = where the bobber meets the water; sink = 0..5 px pulled under.
function drawBobber(g, x, y, sink, air){
  var c = api.sprite("fa:bobber", BOBBER, {K:"#2a2230", R:"#e0452f", W:"#f5f5f5"}, 1);
  if(air){ g.drawImage(c, Math.round(x-2), Math.round(y-4)); return; }
  sink = clamp(Math.round(sink||0), 0, 4);
  var vis = 5 - sink;
  g.drawImage(c, 0, 0, 5, vis, Math.round(x-2), Math.round(y-vis), 5, vis);
  g.fillStyle = "rgba(255,255,255,0.45)"; g.fillRect(Math.round(x-3), Math.round(y), 7, 1);
}

/* ---------- fx: ripples, droplets, sparkles, popups ---------- */
function Fx(){ this.list = []; }
Fx.prototype.ripple = function(x, y, delay, big){ this.list.push({k:"rip", x:x, y:y, t:-(delay||0), d:900, big:big?2:1}); };
Fx.prototype.splash = function(x, y, n){
  this.ripple(x, y);
  if(api.calm()) return;
  for(var i=0;i<(n||8);i++) this.list.push({k:"drop", x:x, y:y, vx:(Math.random()*2-1)*30, vy:-(30+Math.random()*30), t:0, d:500, s:Math.random()<0.4?2:1});
};
Fx.prototype.sparkle = function(x, y){ if(!api.calm()) this.list.push({k:"spk", x:x, y:y, t:0, d:420}); };
Fx.prototype.popup = function(x, y, fish, txt, col){ this.list.push({k:"pop", x:x, y:y, fish:fish, txt:txt, col:col, t:0, d:1200}); };
Fx.prototype.confetti = function(){
  if(api.calm()) return;
  var cols = ["#f2d14b","#e0452f","#6fd36a","#6fb0ff","#e05aa0"];
  for(var i=0;i<16;i++) this.list.push({k:"conf", x:Math.random()*W, y:-4-Math.random()*20, vx:(Math.random()*2-1)*15, vy:30+Math.random()*30, t:0, d:2600, c:cols[i%5]});
};
Fx.prototype.update = function(dt){
  this.list = this.list.filter(function(p){
    p.t += dt;
    if(p.k === "drop"){ p.vy += 220*dt/1000; p.x += p.vx*dt/1000; p.y += p.vy*dt/1000; }
    if(p.k === "conf"){ p.x += p.vx*dt/1000; p.y += p.vy*dt/1000; }
    return p.t < p.d;
  });
};
Fx.prototype.draw = function(g, t){
  var calm = api.calm();
  this.list.forEach(function(p){
    if(p.t < 0) return;
    var u = p.t/p.d;
    if(p.k === "rip"){
      var rx = calm ? 6*p.big : (2 + 18*u)*p.big, ry = rx*0.35;
      g.fillStyle = "rgba(255,255,255,"+(calm ? 0.45 : 0.6*(1-u)).toFixed(3)+")";
      var last = "";
      for(var i=0;i<32;i++){ var a = i/32*Math.PI*2, px = Math.round(p.x + Math.cos(a)*rx), py = Math.round(p.y + Math.sin(a)*ry), k = px+","+py; if(k!==last) g.fillRect(px, py, 1, 1); last = k; }
    } else if(p.k === "drop"){ g.fillStyle = "rgba(255,255,255,0.8)"; g.fillRect(Math.round(p.x), Math.round(p.y), p.s, p.s); }
    else if(p.k === "spk"){
      var r = u < 0.5 ? 1 : 2; g.fillStyle = "#fff7c2";
      g.fillRect(p.x, p.y-r-1, 1, r); g.fillRect(p.x, p.y+2, 1, r); g.fillRect(p.x-r-1, p.y, r, 1); g.fillRect(p.x+2, p.y, r, 1); g.fillRect(p.x, p.y, 1, 1);
    } else if(p.k === "pop"){
      var yy = Math.round(p.y - (calm ? 0 : 20*u)), w = textWidth(p.txt) + 12;
      g.globalAlpha = u > 0.8 ? (1-u)/0.2 : 1;
      g.fillStyle = "rgba(10,14,24,0.72)"; g.fillRect(Math.round(p.x - w/2)-1, yy-1, w+2, 9);
      if(p.fish) g.drawImage(fishCanvas(p.fish, 1), 0, 0, 16, 8, Math.round(p.x - w/2), yy, 8, 4);
      text(g, p.txt, Math.round(p.x - w/2) + 10, yy+1, p.col || "#ffffff");
      g.globalAlpha = 1;
    } else if(p.k === "conf"){ g.fillStyle = p.c; g.fillRect(Math.round(p.x), Math.round(p.y), 2, 2); }
  });
};

/* ---------- time of day ---------- */
var TOD = [[0,"#0b1026","#1b2347","#0d1a33",0.35],[5,"#1b2347","#e58a6b","#2a3f63",0.55],[7,"#6fb6e8","#fbe3b0","#2f6f93",0.9],
  [12,"#4aa3e8","#bfe6ff","#2b6e94",1.0],[17,"#6a8fd1","#ffcf8a","#335f86",0.9],[19,"#3b3a78","#f2876b","#2a3d66",0.65],
  [21,"#141a3a","#2b2f5c","#121f3d",0.4],[24,"#0b1026","#1b2347","#0d1a33",0.35]];
function tod(d){
  d = d || new Date();
  var h = d.getHours() + d.getMinutes()/60, i = 0;
  while(i < TOD.length-2 && TOD[i+1][0] <= h) i++;
  var a = TOD[i], b = TOD[i+1], u = (h - a[0])/(b[0] - a[0]);
  return {hour:h, top:mixc(rgb(a[1]), rgb(b[1]), u), bottom:mixc(rgb(a[2]), rgb(b[2]), u), water:mixc(rgb(a[3]), rgb(b[3]), u), light:a[4]+(b[4]-a[4])*u};
}

/* ---------- the scene ---------- */
// mode "solo": a pier on the right, grass bank bottom-left. mode "dock": a long dock along the bottom.
function Scene(seed, mode){
  var r = api.rng("pond:"+(seed||"home"));
  this.mode = mode || "solo"; this.rng = r; this.key = ""; this.renders = 0;
  this.bg = newCanvas(W, H);
  this.hill = []; var y0 = 66 + r()*6, y1 = 70 + r()*4, f1 = 0.02 + r()*0.03, f2 = 0.07 + r()*0.05, p1 = r()*6, p2 = r()*6;
  for(var x=0;x<W;x++) this.hill.push({far: Math.round(y0 + Math.sin(x*f1+p1)*6 + Math.sin(x*f2+p2)*2), near: Math.round(y1 + Math.sin(x*f1*1.7+p2)*3 + (x%7===0 ? -2 : 0))});
  this.trees = []; for(var i=0;i<14;i++) this.trees.push({x: Math.floor(r()*W), h: 4+Math.floor(r()*5)});
  this.stars = []; for(i=0;i<40;i++) this.stars.push({x: Math.floor(r()*W), y: Math.floor(r()*60), s: r()*6});
  this.clouds = []; for(i=0;i<3;i++) this.clouds.push({x: r()*W, y: 8 + Math.floor(r()*30), s: r()});
  this.glints = []; for(i=0;i<24;i++){ var gy = HZ+3+Math.floor(r()*(H-HZ-5)); this.glints.push({x: r()*W, y: gy, len: 2+Math.floor(r()*5), sp: 10 - 6*(gy-HZ)/(H-HZ), s: r()*6}); }
  this.lilies = []; for(i=0;i<2+Math.floor(r()*3);i++) this.lilies.push({x: 30 + Math.floor(r()*170), y: HZ + 12 + Math.floor(r()*60)});
  this.reeds = []; for(i=0;i<3+Math.floor(r()*3);i++) this.reeds.push({x: Math.floor(r()*(this.mode==="solo" ? 200 : 300)), y: HZ + 5 + Math.floor(r()*6), s: r()*6});
  if(this.mode === "solo"){ this.reeds.push({x: 44 + Math.floor(r()*14), y: 160, s: r()*6}); this.reeds.push({x: 8 + Math.floor(r()*10), y: 152, s: r()*6}); }
  this.rocks = []; for(i=0;i<2+Math.floor(r()*2);i++) this.rocks.push({x: 4 + Math.floor(r()*40), y: 160 + Math.floor(r()*14)});
  if(this.mode === "solo"){ this.lilies = this.lilies.filter(function(l){ return l.x < 200; }); }
  else { this.lilies.forEach(function(l){ l.y = HZ + 8 + (l.y % 40); }); }
  this.posts = this.mode === "solo" ? [232, 258, 284, 310] : [12, 52, 92, 132, 172, 212, 252, 292];
  this.water = this.mode === "solo" ? {x0:24, x1:218, y0:HZ+10, y1:172} : {x0:10, x1:310, y0:HZ+8, y1:132};
  this.boss = 0;     // 0..1 darkens the sky and speeds the waves (dock boss fight)
}
Scene.prototype.deckY = function(){ return this.mode === "solo" ? 112 : 136; };
Scene.prototype.T = function(){ var n = new Date(); var k = n.getHours()*12 + Math.floor(n.getMinutes()/5); if(k !== this._tk){ this._tk = k; this._tod = tod(n); } return this._tod; };
Scene.prototype.night = function(){ return this.T().light < 0.6; };
Scene.prototype.sunMoon = function(){
  var T = this.T(), h = T.hour, day = h >= 6 && h < 18, f = day ? (h-6)/12 : ((h+6)%24)/12;
  return {day: day, x: Math.round(20 + 280*f), y: Math.round(70 - 50*Math.sin(Math.PI*f))};
};
Scene.prototype.build = function(){
  var T = this.T(), key = this._tk + ":" + this.boss;
  if(key === this.key) return;
  this.key = key; this.renders++;
  var g = this.bg.getContext("2d"), x, y, i;
  for(y=0;y<HZ;y++){ g.fillStyle = css(mixc(T.top, T.bottom, y/HZ)); g.fillRect(0, y, W, 1); }
  if(T.light < 0.6){ g.fillStyle = "rgba(255,255,255,0.75)"; this.stars.forEach(function(s){ g.fillRect(s.x, s.y, 1, 1); }); }
  var sm = this.sunMoon();
  if(sm.day){ g.fillStyle = "#fff1a8"; g.fillRect(sm.x-3, sm.y-4, 6, 8); g.fillRect(sm.x-4, sm.y-3, 8, 6); g.fillStyle = "#ffd75a"; g.fillRect(sm.x-1, sm.y-3, 4, 6); g.fillRect(sm.x-3, sm.y, 6, 3); }
  else { g.fillStyle = "#e8ecf7"; g.fillRect(sm.x-2, sm.y-3, 4, 6); g.fillRect(sm.x-3, sm.y-2, 6, 4); g.fillStyle = css(mixc(T.top, T.bottom, sm.y/HZ)); g.fillRect(sm.x, sm.y-3, 3, 4); }
  var far = css(mixc([58,96,92], T.bottom, 0.45 - T.light*0.2)), near = css(mixc([44,78,58], BLACK, 0.55*(1-T.light)));
  for(x=0;x<W;x++){ var hl = this.hill[x]; g.fillStyle = far; g.fillRect(x, hl.far, 1, HZ-hl.far); }
  g.fillStyle = near;
  for(x=0;x<W;x++){ g.fillRect(x, this.hill[x].near, 1, HZ-this.hill[x].near); }
  this.trees.forEach(function(t){ var by = this.hill[t.x].near; g.fillRect(t.x-1, by-t.h, 3, t.h); g.fillRect(t.x-2, by-t.h+2, 5, t.h-3); g.fillRect(t.x, by-t.h-2, 1, 2); }, this);
  var wb = this.boss ? mixc(T.water, BLACK, 0.15*this.boss) : T.water;
  for(i=0;i<3;i++){ var y0 = HZ + Math.round(i*(H-HZ)/3), y1 = HZ + Math.round((i+1)*(H-HZ)/3); g.fillStyle = css(mixc(wb, BLACK, 0.08*(i+1))); g.fillRect(0, y0, W, y1-y0); }
  this.wtint = wb; this.glint = css(mixc(wb, WHITE, 0.35));
  var self = this;
  this.lilies.forEach(function(l){ g.fillStyle = "#4f9a48"; g.fillRect(l.x, l.y, 7, 3); g.fillRect(l.x+1, l.y-1, 5, 1); g.fillStyle = css(mixc(wb, BLACK, 0.12)); g.fillRect(l.x+3, l.y, 1, 2); g.fillStyle = "#6fbf5a"; g.fillRect(l.x+1, l.y, 2, 1); });
  if(this.mode === "solo"){
    // grass bank, bottom-left
    for(x=0;x<64;x++){ var top = 148 + Math.round(x*x/130); if(top >= H) break; g.fillStyle = "#3f7d3a"; g.fillRect(x, top, 1, H-top); g.fillStyle = "#4f9a48"; g.fillRect(x, top, 1, 2); if(x%6===2){ g.fillRect(x, top-2, 1, 2); } }
    this.rocks.forEach(function(r){ g.fillStyle = "#6a6f78"; g.fillRect(r.x, r.y, 6, 3); g.fillRect(r.x+1, r.y-1, 4, 1); g.fillStyle = "#9aa0aa"; g.fillRect(r.x+1, r.y-1, 2, 1); });
    this.pier(g, 228, W, 112, 128);
  } else this.pier(g, 0, W, 136, 150);
};
// Plank deck from x0..x1, top surface yTop..yFace, a darker front face, posts into the water.
Scene.prototype.pier = function(g, x0, x1, yTop, yFace){
  var x;
  for(x=x0;x<x1;x++){
    var board = Math.floor((x-x0)/16), seam = (x-x0)%16 === 0;
    g.fillStyle = seam ? "#4f3a26" : board%2 ? "#8a6a44" : "#7d5f3c"; g.fillRect(x, yTop, 1, yFace-yTop);
  }
  g.fillStyle = "#a07c50"; g.fillRect(x0, yTop, x1-x0, 1);
  for(x=x0+3;x<x1;x+=16){ g.fillStyle = "#3b2a1a"; g.fillRect(x+2, yTop+2, 1, 1); g.fillRect(x+10, yFace-3, 1, 1); }
  g.fillStyle = "#5e4329"; g.fillRect(x0, yFace, x1-x0, 4); g.fillStyle = "#4f3a26"; g.fillRect(x0, yFace+3, x1-x0, 1);
  this.posts.forEach(function(px){ g.fillStyle = "#5e4329"; g.fillRect(px, yFace+4, 4, 14); g.fillStyle = "#7a5a3a"; g.fillRect(px, yFace+4, 1, 14); });
  this.postBase = yFace + 18;
};
// Background (cached) + animated water. t = ms clock; calm freezes motion.
Scene.prototype.drawBack = function(g, t){
  this.build();
  var calm = api.calm(), tt = calm ? 0 : t, T = this.T(), i, self = this;
  g.drawImage(this.bg, 0, 0);
  if(T.light < 0.6 && !calm){ g.fillStyle = "#ffffff"; this.stars.forEach(function(s){ if(Math.sin(tt/700 + s.s*7) > 0.85) g.fillRect(s.x, s.y, 1, 1); }); }
  g.fillStyle = css(mixc(WHITE, T.bottom, 0.25), 0.85);
  this.clouds.forEach(function(c){ var x = Math.round((c.x + tt*0.002) % (W+30)) - 15, y = c.y; g.fillRect(x+2, y, 6, 1); g.fillRect(x, y+1, 11, 2); g.fillRect(x+1, y+3, 9, 1); });
  // reflection of the hills / sun into the top 14px of water
  g.globalAlpha = 0.35;
  for(i=0;i<14;i++){ var sh = calm ? 0 : Math.round(Math.sin(i*0.7 + tt/300)); g.drawImage(this.bg, 0, HZ-1-i, W, 1, sh, HZ+i, W, 1); }
  g.globalAlpha = 1;
  var sm = this.sunMoon();
  if(!sm.day){ g.fillStyle = "rgba(232,236,247,0.5)"; for(i=0;i<6;i++){ var off = calm ? 0 : Math.round(Math.sin(tt/350+i)); g.fillRect(sm.x-1+off, HZ+4+i*5, 3 - (i%2), 1); } }
  // glints
  g.fillStyle = this.glint;
  var spd = this.boss ? 2 : 1;
  this.glints.forEach(function(gl){
    var x = Math.round((gl.x + tt*gl.sp*spd/1000) % W);
    g.globalAlpha = calm ? 0.6 : 0.35 + 0.35*Math.sin(tt/600 + gl.s);
    g.fillRect(x, gl.y, gl.len, 1);
  });
  g.globalAlpha = 1;
  // shoreline foam
  g.fillStyle = "rgba(255,255,255,0.35)";
  for(var x=0;x<W;x+=2){ g.fillRect(x, HZ + (calm ? 0 : Math.round(Math.sin(x*0.3 + tt/400)*0.6+0.4)), 1, 1); }
  // reeds sway
  this.reeds.forEach(function(r){
    var sw = calm ? 0 : Math.round(Math.sin(tt/900 + r.s));
    for(var k=0;k<3;k++){ g.fillStyle = k===1 ? "#4f9a48" : "#3f7d3a"; var hh = 7 + k*2; for(var j=0;j<hh;j++) g.fillRect(r.x + k*2 + (j < 3 ? sw : 0), r.y - j, 1, 1); }
    g.fillStyle = "#7a5a3a"; g.fillRect(r.x + 2 + sw, r.y - 11, 1, 2);
  });
  // ripple ticks at the posts
  g.fillStyle = "rgba(255,255,255,0.4)";
  this.posts.forEach(function(px){ var w = calm ? 6 : 5 + Math.round(Math.sin(tt/500 + px)); g.fillRect(px - Math.floor((w-4)/2), self.postBase, w, 1); });
};
// Night tint over water + actors, then lanterns. Call after the actors, before UI.
Scene.prototype.drawFront = function(g, t){
  var T = this.T(), a = (1 - T.light)*0.7 + (this.boss ? 0.15*this.boss : 0);
  if(a > 0.01){ g.fillStyle = css(T.bottom, a.toFixed(3)); g.fillRect(0, HZ, W, H-HZ); }
  if(T.light < 0.6){
    var y = this.deckY() - 6, calm = api.calm(), self = this;
    [this.posts[0], this.posts[this.posts.length-1]].concat(this.mode==="dock" ? [this.posts[3], this.posts[5]] : []).forEach(function(px){
      g.fillStyle = "#3b2a1a"; g.fillRect(px+1, y, 1, 6);
      g.fillStyle = "rgba(255,200,90,"+(calm ? 0.35 : (0.3 + 0.08*Math.sin(t/300 + px)).toFixed(3))+")"; g.fillRect(px-1, y-2, 4, 5);
      g.fillStyle = "#ffd27a"; g.fillRect(px, y-1, 2, 3);
    });
  }
};

/* ---------- fish shadows ---------- */
var SHADOW = {1:[6,3], 2:[8,4], 3:[10,5], 4:[14,6], 5:[48,14]};
function Shadows(scene, n){
  var r = api.rng("shadows:"+(scene.rng()));
  this.area = scene.water; this.list = [];
  for(var i=0;i<(n||4);i++) this.list.push(this.spawn(r() < 0.5 ? 1 : 2, r));
}
Shadows.prototype.spawn = function(size, r){
  r = r || Math.random; var a = this.area;
  return {x: a.x0 + r()*(a.x1-a.x0), y: a.y0 + r()*(a.y1-a.y0), wx: 0, wy: 0, vx: 0, vy: 0, dir: 1, size: size, mode: "wander", sp: 6 + r()*8, alpha: 1};
};
// Pick the shadow nearest (x, y) to come to the bobber; it shows the hooked fish's size.
Shadows.prototype.call = function(x, y, rarity){
  var best = null, bd = 1e9;
  this.list.forEach(function(s){ if(s.mode !== "wander") return; var d = (s.x-x)*(s.x-x) + (s.y-y)*(s.y-y); if(d < bd){ bd = d; best = s; } });
  if(!best){ best = this.spawn(rarity); this.list.push(best); }
  best.size = rarity; best.mode = "approach"; best.tx = x; best.ty = y + 4; best.alpha = 1;
  return best;
};
Shadows.prototype.release = function(s, flee){
  if(!s) return;
  if(flee){ s.mode = "flee"; s.vx = (s.x < W/2 ? -1 : 1)*60; s.vy = 10; s.until = 700; }
  else { s.mode = "gone"; s.until = 2500; }
};
Shadows.prototype.update = function(dt){
  var a = this.area, calm = api.calm(), self = this;
  this.list.forEach(function(s){
    if(s.mode === "wander"){
      if(calm) return;
      if(!s.wx || Math.abs(s.wx-s.x) + Math.abs(s.wy-s.y) < 4){ s.wx = a.x0 + Math.random()*(a.x1-a.x0); s.wy = a.y0 + Math.random()*(a.y1-a.y0); }
      var dx = s.wx - s.x, dy = s.wy - s.y, d = Math.sqrt(dx*dx+dy*dy) || 1;
      s.vx += (dx/d*s.sp - s.vx)*Math.min(1, dt/600); s.vy += (dy/d*s.sp*0.6 - s.vy)*Math.min(1, dt/600);
    } else if(s.mode === "approach"){
      var ex = s.tx - s.x, ey = s.ty - s.y, dd = Math.sqrt(ex*ex+ey*ey);
      if(dd < 3){ s.vx = 0; s.vy = 0; s.mode = "hold"; }
      else { var sp = Math.min(22, dd*1.5); s.vx = ex/dd*sp; s.vy = ey/dd*sp; }
    } else if(s.mode === "hold"){ s.vx = 0; s.vy = 0; }
    else if(s.mode === "flee" || s.mode === "gone"){
      s.until -= dt; if(s.mode === "gone") s.alpha = 0;
      if(s.until <= 0){ var n = self.spawn(Math.random() < 0.5 ? 1 : 2); for(var k in n) s[k] = n[k]; s.x = Math.random() < 0.5 ? a.x0 : a.x1; }
    }
    if(Math.abs(s.vx) > 0.5) s.dir = s.vx > 0 ? 1 : -1;
    s.x += s.vx*dt/1000; s.y += s.vy*dt/1000;
    if(s.mode === "wander"){ s.x = clamp(s.x, a.x0, a.x1); s.y = clamp(s.y, a.y0, a.y1); }
  });
};
Shadows.prototype.draw = function(g, t){
  g.fillStyle = "rgba(0,0,0,0.28)";
  this.list.forEach(function(s){
    if(s.mode === "gone" || s.x < -20 || s.x > W+20) return;
    var sz = SHADOW[s.size] || SHADOW[1], w = sz[0], h = sz[1];
    for(var y=0;y<h;y++){ var f = 1 - Math.pow((y - (h-1)/2)/(h/2), 2), rw = Math.max(1, Math.round(w*Math.sqrt(Math.max(0, f)))); g.fillRect(Math.round(s.x - rw/2), Math.round(s.y - h/2 + y), rw, 1); }
    var tx = Math.round(s.x - s.dir*(w/2 + 1)); g.fillRect(tx - (s.dir > 0 ? 1 : 0), Math.round(s.y - 1), 2, 3);   // tail
  });
};

/* ---------- reel minigame ---------- */
var TRACK = 140;
// Bar momentum (px/ms^2, px/ms). Stardew's numbers scaled down to this 140px track.
var BAR = {up:0.00026, down:0.00022, vmax:0.11};
var FILL = {1:0.00026, 2:0.00022, 3:0.00018, 4:0.00015};
// o: {fish, rarity, zone, treasure(bool) | chest(bool, decided by the server), seed | rng}
// The sim only ever advances in fixed 1/60 s steps (reelAdvance) with a seeded rng, so the
// same seed and the same inputs play out identically at 30, 60 or 144 frames a second.
var STEP = 1000/60;
function reelSim(o){
  var sp = SPECIES[o.fish] || {beh:"mixed", diff:50}, r = o.rng || api.rng(o.seed != null ? String(o.seed) : "reel:"+Date.now()+":"+Math.random()), zone = o.zone || 36;
  var s = {fish:o.fish, rarity:o.rarity||1, zone:zone, beh:sp.beh, diff:sp.diff, mode:sp.beh === "mixed" ? "smooth" : sp.beh, switchAt:1500+r()*1500,
    barY:TRACK-zone, barV:0, fishY:TRACK*0.55, fishV:0, target:TRACK*0.55, progress:0.3, t:0, inside:false, perfect:true, rng:r, chest:null, done:0};
  var chest = o.chest != null ? !!o.chest : (o.treasure && r() < 0.15);
  if(chest) s.chest = {at:1000 + r()*2000, y:0, p:0, shown:false, open:false, gone:false, was:false};
  s.acc = 0;
  return s;
}
// Advance by a frame's real dt in fixed steps (at most 8 per frame, so a stalled tab
// doesn't fast-forward the fish). Returns 1 won, -1 lost, 0 still reeling.
function reelAdvance(s, dt, hold){
  if(s.done) return s.done;
  s.acc += Math.min(250, Math.max(0, dt));
  var n = 0;
  while(s.acc >= STEP && !s.done){ reelStep(s, STEP, hold); s.acc -= STEP; if(++n >= 8){ s.acc = 0; break; } }
  return s.done;
}
function reelStep(s, dt, hold){
  if(s.done) return s.done;
  dt = Math.min(50, dt); s.t += dt;
  var r = s.rng, f16 = dt/16, i;
  if(s.beh === "mixed" && s.t >= s.switchAt){ s.mode = s.mode === "smooth" ? "dart" : "smooth"; s.switchAt = s.t + 1500 + r()*1500; }
  var p = s.diff/4000*f16, reached = Math.abs(s.target - s.fishY) < 4;
  if(s.mode === "smooth") p = reached ? p*5 : 0;
  if(r() < p){
    var tg = s.fishY + (r()*2-1)*(s.diff/100)*TRACK*0.8;
    if(s.mode === "sinker") tg += (TRACK - tg)*0.25;
    if(s.mode === "floater") tg -= tg*0.25;
    s.target = clamp(tg, 4, TRACK-4);
    if(s.mode === "dart") s.fishV += (s.target - s.fishY)*0.012;
  }
  s.fishV += (s.target - s.fishY)*0.00004*s.diff*f16;
  s.fishV *= Math.pow(0.9, f16);
  s.fishY = clamp(s.fishY + s.fishV*f16, 4, TRACK-4);
  s.barV += (hold ? -BAR.up : BAR.down)*dt;
  s.barV = clamp(s.barV, -BAR.vmax, BAR.vmax);
  s.barY += s.barV*dt;
  if(s.barY > TRACK - s.zone){ s.barY = TRACK - s.zone; s.barV *= -0.35; }
  if(s.barY < 0){ s.barY = 0; s.barV = 0; }
  s.inside = s.fishY >= s.barY && s.fishY <= s.barY + s.zone;
  if(!s.inside && s.t > 250) s.perfect = false;
  var fill = FILL[s.rarity] || FILL[2];
  s.progress += s.inside ? fill*dt : -1.25*fill*dt;
  var c = s.chest;
  if(c && !c.gone && !c.open){
    if(!c.shown && s.t >= c.at){ c.shown = true; c.y = s.fishY > TRACK/2 ? 10 + r()*(s.fishY-40) : s.fishY + 30 + r()*(TRACK-s.fishY-40); c.y = clamp(c.y, 6, TRACK-6); }
    if(c.shown){
      var cov = c.y >= s.barY && c.y <= s.barY + s.zone;
      c.p += cov ? 0.0006*dt : -0.0003*dt;
      if(c.p > 0) c.was = true;
      if(c.p >= 1){ c.open = true; c.p = 1; c.openAt = s.t; }
      else if(c.p <= 0){ c.p = 0; if(c.was) c.gone = true; }
    }
  }
  if(s.progress >= 1){ s.progress = 1; s.done = 1; }
  else if(s.progress <= 0){ s.progress = 0; s.done = -1; }
  return s.done;
}
var CHEST = ["..KKKK..",".KGGGGK.","KBBGGBBK","KKKYYKKK","KBBYYBBK","KBBBBBBK","KKKKKKKK"];
var CHEST_OPEN = [".KGGGGK.","K......K","KKKKKKKK","KBBYYBBK","KBBYYBBK","KBBBBBBK","KKKKKKKK"];
// Draw the reel panel with its left edge at px (top fixed at 14).
function drawReel(g, s, px, t){
  var top = 14, iy = top + 6, calm = api.calm(), i;
  g.fillStyle = "#4f3a26"; g.fillRect(px, top, 44, 152);
  g.fillStyle = "#8a6a44"; g.fillRect(px+1, top+1, 42, 150);
  g.fillStyle = "#6e5236"; for(i=top+4;i<top+150;i+=8) g.fillRect(px+1, i, 1, 3);
  // track
  for(i=0;i<TRACK;i++){ g.fillStyle = css(mixc(rgb("#1d3140"), rgb("#24465c"), i/TRACK)); g.fillRect(px+5, iy+i, 18, 1); }
  g.fillStyle = "#3f7d3a"; g.fillRect(px+6, iy+TRACK-4, 1, 4); g.fillRect(px+9, iy+TRACK-6, 1, 6); g.fillRect(px+20, iy+TRACK-5, 1, 5);
  // zone
  var zy = Math.round(iy + s.barY), shimmer = s.inside && !calm ? (Math.floor(t/90)%2) : 0;
  g.fillStyle = "rgba(111,211,106,"+(s.inside ? 0.75 : 0.55)+")"; g.fillRect(px+6, zy, 16, s.zone);
  g.fillStyle = shimmer ? "#ffffff" : "#b8f5b0"; g.fillRect(px+6, zy, 16, 1); g.fillRect(px+6, zy+s.zone-1, 16, 1);
  // chest
  var c = s.chest;
  if(c && c.shown && !c.gone){
    var spr = api.sprite(c.open ? "fa:chest2" : "fa:chest", c.open ? CHEST_OPEN : CHEST, {K:"#3b2a1a", G:"#f2d14b", B:"#7a5a3a", Y:"#f2d14b"}, 1);
    var cy = Math.round(iy + c.y - 3); g.drawImage(spr, px+10, cy);
    g.fillStyle = "#f2d14b"; var n = Math.round(c.p*12);
    for(i=0;i<n;i++){ var a = i/12*Math.PI*2 - Math.PI/2; g.fillRect(Math.round(px+14 + Math.cos(a)*7), Math.round(cy+3 + Math.sin(a)*6), 1, 1); }
  }
  // fish
  var bob = calm ? 0 : Math.round(Math.sin(t/140));
  drawFish(g, s.fish, px+14, iy + s.fishY + bob, 1, s.fishV < 0 ? false : true, t);
  // progress meter
  g.fillStyle = "#1d3140"; g.fillRect(px+27, iy, 8, TRACK);
  var ph = Math.round(clamp(s.progress, 0, 1)*(TRACK-2));
  g.fillStyle = s.progress > 0.66 ? "#6fd36a" : s.progress > 0.33 ? "#f2d14b" : "#e0452f"; g.fillRect(px+28, iy+TRACK-1-ph, 6, ph);
  g.fillStyle = "rgba(255,255,255,0.45)"; g.fillRect(px+28, iy+TRACK-1-ph, 1, ph);
  if(s.perfect && s.t > 600){ text(g, "*", px+37, iy, "#f2d14b"); }
}

/* ---------- sound: a tiny synth; nothing is downloaded ---------- */
var AC = null, MASTER = null;
function soundOn(){
  try { var v = localStorage.getItem("hq-fish-sound"); if(v === "1") return true; if(v === "0") return false; } catch(e){}
  return !api.calm();
}
function ctx(){
  if(!soundOn()) return null;
  if(!AC){
    var C = window.AudioContext || window.webkitAudioContext; if(!C) return null;
    try { AC = new C(); MASTER = AC.createGain(); MASTER.gain.value = 0.25; MASTER.connect(AC.destination); } catch(e){ AC = null; return null; }
  }
  if(AC.state === "suspended"){ try { AC.resume(); } catch(e){} }
  return AC;
}
function tone(type, f0, f1, at, dur, vol){
  var a = AC, o = a.createOscillator(), gn = a.createGain(), t0 = a.currentTime + at;
  o.type = type; o.frequency.setValueAtTime(f0, t0); if(f1 && f1 !== f0) o.frequency.linearRampToValueAtTime(f1, t0+dur);
  gn.gain.setValueAtTime(0.0001, t0); gn.gain.exponentialRampToValueAtTime(vol||0.5, t0+0.008); gn.gain.exponentialRampToValueAtTime(0.0001, t0+dur);
  o.connect(gn); gn.connect(MASTER); o.start(t0); o.stop(t0+dur+0.02);
}
function noise(dur, cutoff, vol){
  var a = AC, n = Math.floor(a.sampleRate*dur), b = a.createBuffer(1, n, a.sampleRate), d = b.getChannelData(0);
  for(var i=0;i<n;i++) d[i] = (Math.random()*2-1)*Math.pow(1-i/n, 3);
  var s = a.createBufferSource(), f = a.createBiquadFilter(), gn = a.createGain();
  f.type = "lowpass"; f.frequency.value = cutoff; gn.gain.value = vol;
  s.buffer = b; s.connect(f); f.connect(gn); gn.connect(MASTER); s.start();
}
var sfx = {
  on: soundOn,
  // Create / resume the AudioContext inside a user gesture (only when sound is on).
  unlock: function(){ ctx(); },
  created: function(){ return !!AC; },
  set: function(v){ try { localStorage.setItem("hq-fish-sound", v ? "1" : "0"); } catch(e){} },
  play: function(name, arg){
    var a = ctx(); if(!a) return;
    try {
      if(name === "splash") noise(0.12, 1200, 0.3 + 0.5*(arg||0.5));
      else if(name === "tick") tone("sine", 900, 900, 0, 0.04, 0.3);
      else if(name === "bite"){ tone("square", 1320, 1320, 0, 0.06, 0.25); tone("square", 1760, 1760, 0.1, 0.06, 0.25); }
      else if(name === "reel") tone("sine", 220 + 220*(arg||0), 220 + 220*(arg||0), 0, 0.025, 0.2);
      else if(name === "thud") tone("sine", 110, 70, 0, 0.09, 0.4);
      else if(name === "catch") [523.25, 659.25, 783.99, 1046.5].forEach(function(f, i){ tone("triangle", f, f, i*0.07, 0.07, 0.4); });
      else if(name === "lose"){ tone("triangle", 392, 392, 0, 0.12, 0.4); tone("triangle", 293.66, 293.66, 0.12, 0.12, 0.4); }
      else if(name === "chest") [2093, 2637, 3136].forEach(function(f, i){ tone("sine", f, f, i*0.06, 0.09, 0.2); });
      else if(name === "boss") tone("sawtooth", 55, 55, 0, 0.6, 0.35);
    } catch(e){}
  }
};

/* ---------- the rig: one angler's line, start to finish ---------- */
// o: {scene, fx, shadows, look, me, flip, dir (+1/-1), x, y (angler top-left),
//     cast(power) -> called on release; the owner then calls rig.arm({fish, rarity, biteAt})
//     hookWindow(rarity) -> ms, zone, treasure, canLand() -> bool, onResult(kind, info),
//     target(power) -> {x, y}}
// kinds passed to onResult: "spooked", "missed", "reeled" (gave up), "won", "lost".
var BITE_MS = {1:700, 2:600, 3:500, 4:450};
function easyMode(){ try { return !!localStorage.getItem("hq-fish-easy"); } catch(e){ return false; } }
function Rig(o){ this.o = o; this.phase = "idle"; this.t = 0; this.power = 0; this.frame = "idle"; this.rod = 25; this.reel = null; this.nibbles = []; this.cheerUntil = 0; this.slumpUntil = 0; this.msg = ""; }
Rig.prototype.hookWindow = function(r){ return (BITE_MS[r] || 600)*((api.calm() || easyMode()) ? 2 : 1); };
Rig.prototype.down = function(now){
  var p = this.phase;
  if(p === "idle"){ this.phase = "charging"; this.chargeAt = now; this.power = 0; return "charge"; }
  if(p === "waiting"){
    if(this.nibbling(now)){ this.end("spooked", now); return "spook"; }
    this.end("reeled", now); return "reelin";
  }
  if(p === "bite"){ this.startReel(now); return "hook"; }
  if(p === "reeling"){ this.hold = true; return "hold"; }
  return "";
};
Rig.prototype.up = function(now){
  if(this.phase === "charging") this.release(now);
  this.hold = false;
};
Rig.prototype.release = function(now, forcePower){
  var pw = forcePower != null ? forcePower : this.power;
  this.power = pw; this.perfectCast = pw >= 0.9;
  var tip = this.tip || {x:this.o.x, y:this.o.y}, tg = this.o.target(pw);
  this.fly = {x0:tip.x, y0:tip.y, x1:tg.x, y1:tg.y, at:now, d:450};
  this.phase = "flying"; this.fish = null; this.biteAt = 0; this.landAt = now + 450; this.castAt = now;
  if(this.perfectCast){ this.banner = {txt:"PERFECT CAST!", until:now+600}; }
  this.o.cast(pw, now);
};
// The fish for this cast is known (solo: rolled now; dock: the server answered).
Rig.prototype.arm = function(a, now){
  if(this.phase !== "flying" && this.phase !== "waiting") return false;
  this.fish = a.fish; this.rarity = a.rarity; this.biteAt = Math.max(a.biteAt, this.landAt + 300);
  this.token = a.token; this.chest = a.chest != null ? !!a.chest : null;
  if(this.phase === "waiting") this.schedule(now);
  return true;
};
Rig.prototype.schedule = function(now){
  var start = Math.max(now, this.landAt) + 200, end = this.biteAt - 300, n = Math.floor(Math.random()*4), list = [];
  for(var i=0;i<n;i++){ var tt = start + Math.random()*(end-start); if(end - start < 350) break; if(list.every(function(x){ return Math.abs(x - tt) >= 350; })) list.push(tt); }
  list.sort(function(a,b){ return a-b; });
  this.nibbles = list.map(function(x){ return {at:x, done:false}; });
  if(this.o.shadows) this.shadow = this.o.shadows.call(this.bob.x, this.bob.y, this.rarity || 2);
};
Rig.prototype.nibbling = function(now){ return this.nibbles.some(function(n){ return now >= n.at && now < n.at + 120; }); };
Rig.prototype.startReel = function(now){
  this.phase = "reeling"; this.hold = true; this.casts = (this.casts|0) + 1;
  this.reel = reelSim({fish:this.fish, rarity:this.rarity, zone:this.o.zone || 36, treasure:!!this.o.treasure, chest:this.chest,
    seed: this.token ? "reel:"+this.token : "solo:"+this.casts+":"+Date.now()});
  if(this.shadow && this.o.shadows){ this.o.shadows.release(this.shadow, false); this.shadow = null; }
  this.o.onResult("hooked", {});
};
Rig.prototype.end = function(kind, now, info){
  if(this.shadow && this.o.shadows){ this.o.shadows.release(this.shadow, kind === "spooked"); this.shadow = null; }
  var prevFish = this.fish;
  if(kind === "won" && this.optimistic){ this.optimistic = false; }   // the arc already played on land
  else if(kind === "won"){ this.cheerUntil = now + 900; this.arc = {fish:prevFish, x0:this.bob ? this.bob.x : this.o.x, y0:this.bob ? this.bob.y : this.o.y, at:now, d:400}; sfx.play("catch"); }
  else if(this.optimistic){ this.optimistic = false; this.arc = null; this.cheerUntil = 0; this.slumpUntil = now + 800; sfx.play("lose"); }
  else if(kind !== "reeled"){ this.slumpUntil = now + 800; sfx.play("lose"); }
  if(kind === "spooked" && this.bob && this.o.fx) this.o.fx.ripple(this.bob.x, this.bob.y);
  this.phase = "idle"; this.reel = null; this.hold = false; this.nibbles = []; this.bob = null; this.fly = null;
  this.o.onResult(kind, info || {fish:prevFish});
  this.fish = null;
};
// The owner decided the outcome (dock: the server said caught / lost).
Rig.prototype.finish = function(won, now){ if(this.phase === "sent" || this.phase === "landing" || this.phase === "reeling"){ this.end(won ? "won" : "lost", now, {fish:this.fish, server:true}); } };
Rig.prototype.update = function(now, dt){
  var p = this.phase, fx = this.o.fx;
  if(p === "charging"){ var u = ((now - this.chargeAt) % 1200)/1200; this.power = u < 0.5 ? u*2 : 2 - u*2; }
  if(p === "flying" && now >= this.landAt){
    this.phase = "waiting"; this.bob = {x:this.fly.x1, y:this.fly.y1};
    if(fx) fx.splash(this.bob.x, this.bob.y); sfx.play("splash", this.power);
    if(this.fish) this.schedule(now);
  }
  if(this.phase === "waiting"){
    var self = this;
    this.nibbles.forEach(function(n){ if(!n.done && now >= n.at){ n.done = true; if(fx) fx.ripple(self.bob.x, self.bob.y); sfx.play("tick"); } });
    if(this.fish && now >= this.biteAt){
      this.phase = "bite"; this.biteEnd = now + this.hookWindow(this.rarity); this.biteStart = now;
      if(fx){ fx.ripple(this.bob.x, this.bob.y, 0); fx.ripple(this.bob.x, this.bob.y, 150); fx.ripple(this.bob.x, this.bob.y, 300); }
      sfx.play("bite"); this.o.onResult("bite", {});
    }
  }
  if(this.phase === "bite" && now >= this.biteEnd){ this.end("missed", now); }
  if(this.phase === "reeling"){
    var r = this.reel, wasIn = r.inside, chestOpen = r.chest && r.chest.open;
    var done = this.frozen ? r.done : reelAdvance(r, dt, this.hold);
    if(r.chest && r.chest.open && !chestOpen) sfx.play("chest");
    if(wasIn && !r.inside && r.t > 300) sfx.play("thud");
    if(this.hold && r.inside){ this._tick = (this._tick||0) + dt; if(this._tick >= 125){ this._tick = 0; sfx.play("reel", r.progress); } }
    if(r.t > 80000) done = -1;
    if(done === 1){ this.result = {perfect:r.perfect, chest:!!(r.chest && r.chest.open)}; this.phase = "landing"; }
    else if(done === -1){ this.end("lost", now, {fish:this.fish}); return; }
  }
  if(this.phase === "landing" && (!this.o.canLand || this.o.canLand(now))){
    if(this.o.serverLands){
      // Local echo: the fish leaps to the angler now; the server's answer only adds the score.
      this.phase = "sent"; this.sentAt = now; this.optimistic = true; this.cheerUntil = now + 900;
      this.arc = {fish:this.fish, x0:this.bob ? this.bob.x : this.o.x, y0:this.bob ? this.bob.y : this.o.y, at:now, d:400}; sfx.play("catch");
      this.o.onResult("land", {fish:this.fish, result:this.result});
    }
    else this.end("won", now, {fish:this.fish, perfect:this.result.perfect, chest:this.result.chest, perfectCast:this.perfectCast});
  }
  // animation state
  this.frame = now < this.cheerUntil ? "cheer" : now < this.slumpUntil ? "slump" : (this.phase === "reeling" || this.phase === "landing" || this.phase === "sent") ? (Math.floor(now/120)%2 ? "reel" : "idle") : "idle";
  var want = this.phase === "charging" ? -60*this.power : this.phase === "flying" ? 35 : this.phase === "idle" ? 25 : this.phase === "reeling" ? 30 + Math.sin(now/200)*8 : this.phase === "bite" ? 12 : 35;
  this.rod += (want - this.rod)*Math.min(1, dt/(this.phase === "flying" ? 60 : 120));
};
Rig.prototype.draw = function(g, now, scene){
  var o = this.o, calm = api.calm(), night = scene && scene.night();
  var bob = (calm || this.phase !== "idle") ? 0 : (Math.floor(now/1200)%2 ? -1 : 0);
  var hand = drawAngler(g, o.x, o.y, {frame:this.frame, look:o.look, flip:o.dir < 0, me:o.me, bob:bob});
  this.tip = drawRod(g, hand, this.rod, o.dir);
  var tip = this.tip;
  if(this.phase === "flying"){
    var f = this.fly, u = clamp((now - f.at)/f.d, 0, 1), x = f.x0 + (f.x1 - f.x0)*u, y = f.y0 + (f.y1 - f.y0)*u - 40*Math.sin(Math.PI*u);
    drawLine(g, tip.x, tip.y, x, y, 4, night); drawBobber(g, x, y, 0, true);
  } else if(this.bob && !this.optimistic){
    var b = this.bob, sink = 0, jx = 0;
    if(this.phase === "waiting"){ sink = this.nibbling(now) ? 2 : (calm ? 0 : (Math.sin(now/500) > 0 ? 1 : 0)); }
    if(this.phase === "bite") sink = 3;
    if(this.reel){ jx = clamp(Math.round(this.reel.fishV*2), -2, 2); sink = 2; }
    var taut = this.phase === "reeling" || this.phase === "bite" || this.phase === "landing" || this.phase === "sent";
    drawLine(g, tip.x, tip.y, b.x + jx, b.y - 3, taut ? 2 : 18, night);
    drawBobber(g, b.x + jx, b.y, sink);
  }
  if(this.arc){
    var a = this.arc, v = (now - a.at)/a.d;
    if(v >= 1){ if(o.fx) o.fx.sparkle(hand.x, hand.y - 4); this.arc = null; }
    else drawFish(g, a.fish, a.x0 + (hand.x - a.x0)*v, a.y0 + (hand.y - 6 - a.y0)*v - 30*Math.sin(Math.PI*v), 1, o.dir < 0, now);
  }
};
// On-canvas UI for the local player: power meter, "!" bubble, perfect banner, reel panel.
var BUBBLE = [".KKKKK.","KWWWWWK","KWWRWWK","KWWRWWK","KWWRWWK","KWWWWWK","KWWRWWK",".KKKKKK","..K...."];
Rig.prototype.drawUI = function(g, now, reelX){
  var o = this.o, calm = api.calm();
  if(this.phase === "charging"){
    var mx = o.dir < 0 ? o.x + 15 : o.x - 9, my = o.y - 24;
    g.fillStyle = "#1d3140"; g.fillRect(mx, my, 6, 40);
    var ph = Math.round(this.power*38);
    for(var i=0;i<ph;i++){ var u = i/38; g.fillStyle = u < 0.45 ? "#e0452f" : u < 0.8 ? "#f2d14b" : "#6fd36a"; g.fillRect(mx+1, my+39-i, 4, 1); }
    g.fillStyle = "#ffffff"; g.fillRect(mx, my+1, 6, 1); g.fillRect(mx, my+4, 6, 1);
  }
  if(this.phase === "bite"){
    var spr = api.sprite("fa:bubble", BUBBLE, {K:"#2a2230", W:"#ffffff", R:"#e0452f"}, 1), pop = calm ? 1 : Math.min(1, 0.6 + (now - this.biteStart)/80);
    var w = Math.round(14*pop), h = Math.round(18*pop);
    g.drawImage(spr, Math.round(o.x + 6 - w/2 + (o.dir < 0 ? -6 : 6)), o.y - 2 - h, w, h);
  }
  if(this.banner && now < this.banner.until){ label(g, this.banner.txt, o.x + 6, o.y - 30, "#f2d14b"); }
  if(this.reel){
    drawReel(g, this.reel, reelX, now);
    if(this.frozen){ g.fillStyle = "rgba(10,14,24,0.6)"; g.fillRect(reelX, 14, 44, 152); text(g, "BOSS", reelX + 15, 80, "#f2d14b"); text(g, "HOLD", reelX + 15, 88, "#ffffff"); }
    if(this.reel.perfect && this.reel.done === 1){ label(g, "PERFECT!", reelX + 22, 8, "#f2d14b"); }
  }
};
// The fish-in-hand rarity colours used for popups and the dock's last catch.
var RARITY_COL = {1:"#c9d3dc", 2:"#7fd36a", 3:"#6fb0ff", 4:"#f2d14b"};

/* ---------- catch card (DOM overlay inside `wrap`; text only via textContent) ---------- */
// c: {id, size:{len,kg}, stars, perfect, isNew, record, loot, n, perfectN, title}
// o: {viewOnly, onClose(), onLog()}. Returns {el, draw(t), close(silent)}.
var RARITY_NAME = ["","Common","Uncommon","Rare","Legendary"];
function card(wrap, c, o){
  o = o || {};
  var it = api.items[c.id], el = api.mk("div","vg-fish-card"), view = !!o.viewOnly;
  el.setAttribute("role","dialog"); el.setAttribute("aria-label", (c.title || "Caught")+" "+it.name);
  var cv = newCanvas(120, 64); cv.className = "vg-fish-art"; el.appendChild(cv);
  if(c.title) el.appendChild(api.mk("span","vg-fish-new", c.title));
  el.appendChild(api.mk("h3", null, it.name));
  var sp = SPECIES[c.id]; if(sp) el.appendChild(api.mk("span","vg-fish-latin","Modelled on "+sp.real[0]));
  el.appendChild(api.mk("span","vg-rar vg-rar-"+it.rarity, RARITY_NAME[it.rarity]));
  if(!view && c.isNew) el.appendChild(api.mk("span","vg-fish-new","NEW!"));
  else if(!view && c.record) el.appendChild(api.mk("span","vg-fish-new","New record!"));
  var dl = api.mk("dl","vg-fish-stats");
  function row(k, v){ dl.appendChild(api.mk("dt", null, k)); dl.appendChild(api.mk("dd", null, v)); }
  row(view ? "Best length" : "Length", c.size.len.toFixed(1)+" cm");
  row(view ? "Best weight" : "Weight", fmtKg(c.size.kg));
  var st = c.stars|0; row("Stars", "★★★".slice(0, st)+"☆☆☆".slice(0, 3-st));
  if(view) row("Caught", "×"+(c.n|0)+(c.perfectN ? " · "+c.perfectN+" perfect" : ""));
  else if(c.perfect) row("Reel", "Perfect!");
  if(c.points) row("Points", "+"+c.points);
  el.appendChild(dl);
  if(c.loot){ var lt = api.mk("p","vg-fish-loot"); lt.appendChild(api.iconEl(c.loot, 2)); lt.appendChild(api.mk("span", null, "Treasure: "+api.items[c.loot].name)); el.appendChild(lt); }
  var btns = api.mk("div","vg-row");
  var h = {el:el, closed:false};
  h.close = function(silent){ if(h.closed) return; h.closed = true; el.remove(); if(!silent && o.onClose) o.onClose(); };
  var keep = api.btn(view ? "Close" : "Keep fishing", "primary", function(){ h.close(); });
  btns.appendChild(keep);
  if(!view && o.onLog) btns.appendChild(api.btn("Log", "", function(){ h.close(true); o.onLog(); }));
  el.appendChild(btns);
  el.addEventListener("keydown", function(e){ if(e.key === "Escape"){ e.preventDefault(); h.close(); } });
  h.draw = function(t){
    var g = cv.getContext("2d"), calm = api.calm();
    g.imageSmoothingEnabled = false; g.clearRect(0, 0, 120, 64);
    var grad = g.createRadialGradient(60, 32, 4, 60, 32, 56);
    grad.addColorStop(0, "rgba(255,240,180,0.55)"); grad.addColorStop(1, "rgba(255,240,180,0)");
    g.fillStyle = grad; g.fillRect(0, 0, 120, 64);
    var sc = c.id === "leviathan" && c.title ? 7 : 6;
    drawFish(g, c.id, 60, 32, sc, false, calm ? 0 : t);
    g.fillStyle = it.rarity >= 3 ? "#fff7c2" : "rgba(255,255,255,0.8)";
    for(var i=0;i<4;i++){ var a = (calm ? 0 : t/700) + i*Math.PI/2, x = Math.round(60 + Math.cos(a)*54), y = Math.round(32 + Math.sin(a)*26); g.fillRect(x, y-1, 1, 3); g.fillRect(x-1, y, 3, 1); }
  };
  wrap.appendChild(el); h.draw(0); keep.focus();
  return h;
}

/* ---------- crisp view: logical buffer -> big backing canvas ---------- */
function view(cv){
  var k = Math.max(2, Math.round((window.devicePixelRatio||1)*2));
  cv.width = W*k; cv.height = H*k;
  var buf = newCanvas(W, H), g = buf.getContext("2d"), out = cv.getContext("2d");
  g.imageSmoothingEnabled = false;
  return {g:g, k:k, blit:function(shake){
    out.imageSmoothingEnabled = false;
    if(shake) out.clearRect(0, 0, W*k, H*k);
    out.drawImage(buf, 0, 0, W, H, Math.round((shake ? shake.x : 0)*k), Math.round((shake ? shake.y : 0)*k), W*k, H*k);
  }};
}

HQV.fishArt = {
  W:W, H:H, HZ:HZ, TRACK:TRACK, FILL:FILL, BAR:BAR, SPECIES:SPECIES, TPL:TPL, RARITY_COL:RARITY_COL,
  Scene:Scene, Shadows:Shadows, Fx:Fx, Rig:Rig, reelSim:reelSim, reelStep:reelStep, reelAdvance:reelAdvance, STEP:STEP, drawReel:drawReel,
  drawFish:drawFish, fishCanvas:fishCanvas, drawAngler:drawAngler, drawRod:drawRod, drawBobber:drawBobber, drawLine:drawLine,
  card:card, RARITY_NAME:RARITY_NAME, text:text, label:label, textWidth:textWidth, looks:looks, sizeFor:sizeFor, fmtKg:fmtKg, tod:tod, sfx:sfx, view:view
};
})();
