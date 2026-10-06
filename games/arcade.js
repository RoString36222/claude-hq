/* Valley: Arcade cabinet — "Bug Blaster", an original tiny shooter. Move with WASD, shoot
 * with the arrow keys (or click to shoot toward the pointer). Bugs crawl in from the edges in
 * waves; survive and squash as many as you can. Best score is local; in an Arena room your
 * score (a number) is shared with friends. */
(function(){
"use strict";
var HQV = window.HQV; if(!HQV) return;
var W = 240, H = 160;
var game = {id:"arcade", name:"Bug Blaster", icon:"👾", desc:"Saloon arcade: squash the bugs"};
var api = null, root = null, st = null, raf = 0, scores = {};
var SPR = {
  me:["..1111..",".122221.",".121121.",".122221.","..3333..",".333333.","..3..3..",".33..33."],
  bug:["1......1",".1.11.1.","..2222..",".222222.","22322322",".222222.","..1..1..",".1....1."]
};
function newRun(){
  var lives = api.save.unlocks["arcade+life"] ? 4 : 3;
  st = {x:W/2, y:H/2, keys:{}, shots:[], bugs:[], score:0, lives:lives, wave:1, spawn:0, cool:0, inv:0, over:false, paused:false, last:0};
}
function spawnBug(){
  var side = Math.floor(Math.random()*4), x = side===0?-6:side===1?W+6:Math.random()*W, y = side===2?-6:side===3?H+6:Math.random()*H;
  st.bugs.push({x:x, y:y, sp:0.03 + st.wave*0.006 + Math.random()*0.02});
}
function step(dt){
  var k = st.keys, sp = 0.09*dt;
  if(k.w) st.y -= sp; if(k.s) st.y += sp; if(k.a) st.x -= sp; if(k.d) st.x += sp;
  st.x = Math.max(6, Math.min(W-6, st.x)); st.y = Math.max(6, Math.min(H-6, st.y));
  st.cool -= dt; st.inv -= dt;
  var fx = (k.ArrowRight?1:0)-(k.ArrowLeft?1:0), fy = (k.ArrowDown?1:0)-(k.ArrowUp?1:0);
  if((fx||fy) && st.cool<=0) fire(fx, fy);
  st.shots.forEach(function(s){ s.x += s.vx*dt; s.y += s.vy*dt; });
  st.shots = st.shots.filter(function(s){ return s.x>-4 && s.x<W+4 && s.y>-4 && s.y<H+4 && !s.hit; });
  st.spawn -= dt;
  if(st.spawn <= 0){ spawnBug(); st.spawn = Math.max(180, 900 - st.wave*70); }
  st.bugs.forEach(function(b){
    var dx = st.x-b.x, dy = st.y-b.y, d = Math.hypot(dx,dy)||1; b.x += dx/d*b.sp*dt; b.y += dy/d*b.sp*dt;
    st.shots.forEach(function(s){ if(!s.hit && Math.abs(s.x-b.x)<6 && Math.abs(s.y-b.y)<6){ s.hit = true; b.dead = true; st.score += 10*st.wave; } });
    if(!b.dead && st.inv<=0 && Math.abs(b.x-st.x)<7 && Math.abs(b.y-st.y)<7){ b.dead = true; st.lives--; st.inv = 1200; }
  });
  st.bugs = st.bugs.filter(function(b){ return !b.dead; });
  if(st.score >= st.wave*st.wave*150) st.wave++;
  if(st.lives <= 0) over();
}
function fire(fx, fy){ var d = Math.hypot(fx,fy)||1; st.shots.push({x:st.x, y:st.y, vx:fx/d*0.3, vy:fy/d*0.3}); st.cool = 160; }
function over(){
  st.over = true;
  var a = api.save.arcade, best = a.best|0;
  if(st.score > best){ a.best = st.score; api.toast("👾 New best: "+st.score, "ach"); }
  a.plays = (a.plays|0)+1; api.persist();
  if(st.score >= 1500) api.inv.add("shell", 1);
  if(api.inArenaRoom()) api.say({g:"arcade", score:st.score});
}
function draw(g){
  g.imageSmoothingEnabled = false;
  g.fillStyle = "#1b1530"; g.fillRect(0,0,W,H);
  g.fillStyle = "#2a2245"; for(var i=0;i<W;i+=16) for(var j=(i/16)%2*8;j<H;j+=16) g.fillRect(i,j,8,8);
  var me = api.sprite("arc:me", SPR.me, {"1":"#f2c99a","2":"#2b2b2b","3":"#3ea89a"}, 1);
  if(!(st.inv>0 && Math.floor(st.inv/120)%2 && !api.calm())) g.drawImage(me, st.x-4, st.y-4);
  var bug = api.sprite("arc:bug", SPR.bug, {"1":"#2b2b2b","2":"#7ae07a","3":"#e0452f"}, 1);
  st.bugs.forEach(function(b){ g.drawImage(bug, b.x-4, b.y-4); });
  g.fillStyle = "#f2d14b"; st.shots.forEach(function(s){ g.fillRect(s.x-1, s.y-1, 2, 2); });
  g.fillStyle = "#fff"; g.font = "8px monospace";
  g.fillText("SCORE "+st.score+"  WAVE "+st.wave+"  "+"♥".repeat(Math.max(0,st.lives)), 4, 10);
  if(st.over){ g.fillStyle = "rgba(0,0,0,.6)"; g.fillRect(0,H/2-16,W,32); g.fillStyle="#fff"; g.fillText("GAME OVER — press R or click Play", 34, H/2+3); }
  else if(st.paused){ g.fillStyle="#fff"; g.fillText("PAUSED", W/2-16, H/2); }
}
function loop(t){
  var dt = st.last ? Math.min(50, t-st.last) : 16; st.last = t;
  if(!st.paused && !st.over) step(dt);
  draw(st.ctx); raf = requestAnimationFrame(loop);
}
function render(){
  if(!root) return;
  root.textContent = "";
  var a = api.save.arcade;
  root.appendChild(api.mk("p","vg-muted","Best "+(a.best|0)+" · WASD to move, arrow keys to shoot, or click to shoot toward the pointer."));
  var row = api.mk("div","vg-row");
  row.appendChild(api.btn("Play", "primary", function(){ newRun(); st.ctx = cv.getContext("2d"); cv.focus(); }));
  root.appendChild(row);
  var cv = api.canvas(W, H); cv.setAttribute("aria-label","Bug Blaster. WASD moves, arrow keys shoot.");
  root.appendChild(cv);
  var names = Object.keys(scores).sort(function(x,y){ return scores[y]-scores[x]; });
  if(names.length) root.appendChild(api.mk("p",null,"This room: "+names.slice(0,8).map(function(n){ return n+" "+scores[n]; }).join(" · ")));
  newRun(); st.over = true; st.ctx = cv.getContext("2d");
  function kd(e){ if(!st) return; var k = e.key.length===1 ? e.key.toLowerCase() : e.key;
    if(k==="r" && st.over){ newRun(); st.ctx = cv.getContext("2d"); return; }
    if(/^(w|a|s|d|ArrowUp|ArrowDown|ArrowLeft|ArrowRight)$/.test(k)){ e.preventDefault(); st.keys[k] = true; } }
  function ku(e){ if(!st) return; var k = e.key.length===1 ? e.key.toLowerCase() : e.key; st.keys[k] = false; }
  cv.addEventListener("keydown", kd); cv.addEventListener("keyup", ku);
  cv.addEventListener("blur", function(){ if(st) st.keys = {}; });
  cv.addEventListener("click", function(e){ if(!st || st.over || st.paused) return; var r = cv.getBoundingClientRect();
    fire((e.clientX-r.left)/r.width*W - st.x, (e.clientY-r.top)/r.height*H - st.y); });
  cancelAnimationFrame(raf); raf = requestAnimationFrame(loop);
}
game.onSay = function(d, who){ var s = Math.max(0, Math.min(999999, d.score|0)); if(!scores[who] || s > scores[who]) scores[who] = s; };
game.mount = function(el, a){ api = a; root = el; render(); };
game.unmount = function(){ cancelAnimationFrame(raf); root = null; st = null; };
game.pause = function(){ if(st){ st.paused = true; st.keys = {}; } };
game.resume = function(){ if(st){ st.paused = false; st.last = 0; } };
HQV.register(game);
if(HQV.api) api = HQV.api;
})();
