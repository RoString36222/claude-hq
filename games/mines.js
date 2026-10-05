/* Valley: The Mines. Short grid floors: move with the arrow keys / WASD (or tap a
 * neighbouring tile), walk into rocks to break them (ore, gems, sometimes the ladder down),
 * and avoid slimes. How deep you may go this week depends on how many days you were
 * active this week. Loot goes to the bag when you climb out (or half of it if you faint). */
(function(){
"use strict";
var HQV = window.HQV; if(!HQV) return;
var COLS = 12, ROWS = 8, T = 16;
var game = {id:"mines", name:"The Mines", icon:"⛏️", desc:"Break rocks, dodge slimes, go deeper"};
var api = null, root = null, st = null;

var SPR = {
  hero:["..1111..","..1221..","..1111..",".333333.","3.3333.3","..3333..","..4..4..",".44..44."],
  rock:["..1111..",".122211.","12222211","12221211","12222221","11222211",".111111.","........"],
  slime:["........","..1111..",".122221.","12122121","12222221","12222221",".111111.","........"],
  ladder:["1......1","11111111","1......1","1......1","11111111","1......1","1......1","11111111"],
  floor:["22222222","22122222","22222212","22222222","21222222","22222122","22222222","22212222"]
};
function spr(k, pal){ return api.sprite("mine:"+k+":"+Object.values(pal).join(""), SPR[k], pal, 2); }

function maxDepth(){
  var a = api.activity(), bonus = api.save.unlocks["mines+1"] ? 1 : 0;
  return 3 + a.weekActiveDays*2 + bonus;   // 3..17 floors depending on this week's active days
}
function newFloor(depth){
  var r = api.rng("mine:"+api.day()+":"+depth+":"+(api.save.mines.runs|0)), grid = [], i;
  for(var y=0;y<ROWS;y++){ grid.push([]); for(var x=0;x<COLS;x++) grid[y].push(r() < 0.42 ? "rock" : "floor"); }
  grid[0][0] = "floor"; grid[0][1] = "floor"; grid[1][0] = "floor";
  var slimes = [], ns = Math.min(1 + Math.floor(depth/2), 6);
  for(i=0;i<ns;i++){ var sx=2+Math.floor(r()*(COLS-2)), sy=Math.floor(r()*ROWS); grid[sy][sx]="floor"; slimes.push({x:sx,y:sy}); }
  // the ladder hides under one rock
  var rocks = []; for(y=0;y<ROWS;y++) for(x=0;x<COLS;x++) if(grid[y][x]==="rock") rocks.push([x,y]);
  var lad = rocks.length ? rocks[Math.floor(r()*rocks.length)] : [COLS-1, ROWS-1];
  return {grid:grid, slimes:slimes, ladder:lad, r:r, depth:depth};
}
function loot(depth, r){
  var x = r();
  if(x < 0.45) return null;
  if(depth >= 8 && x > 0.985) return "ruby";
  if(depth >= 6 && x > 0.97) return "emerald";
  if(depth >= 4 && x > 0.95) return "amethyst";
  if(x > 0.9) return "quartz";
  if(depth >= 5 && x > 0.8) return "gold";
  if(depth >= 2 && x > 0.65) return "iron";
  return "copper";
}
function start(){
  var s = api.save.mines; s.week = api.week();
  st = {depth:1, hp:5, x:0, y:0, bag:{}, floor:newFloor(1), over:false, msg:"Break rocks to find the ladder down."};
  render();
}
function move(dx, dy){
  if(!st || st.over || st.paused) return;
  var nx = st.x+dx, ny = st.y+dy, f = st.floor;
  if(nx<0||ny<0||nx>=COLS||ny>=ROWS) return;
  if(f.grid[ny][nx]==="rock"){
    f.grid[ny][nx] = "floor";
    if(nx===f.ladder[0] && ny===f.ladder[1]){ f.grid[ny][nx] = "ladder"; st.msg = "Found the ladder!"; }
    else { var it = loot(st.depth, f.r); if(it){ st.bag[it]=(st.bag[it]|0)+1; st.msg = "Found "+api.items[it].name+"."; } }
  } else if(f.grid[ny][nx]==="ladder"){
    if(st.depth >= maxDepth()){ st.msg = "The way down is blocked for now. Be active on more days this week to go deeper."; }
    else { st.depth++; st.floor = newFloor(st.depth); st.x=0; st.y=0; st.msg = "Floor "+st.depth+"."; render(); return; }
  } else { st.x = nx; st.y = ny; }
  // slimes shuffle toward you
  f.slimes.forEach(function(sl){
    if(f.r() < 0.5){
      var ddx = Math.sign(st.x-sl.x), ddy = Math.sign(st.y-sl.y), tx = sl.x+(f.r()<.5?ddx:0), ty = sl.y+(tx===sl.x?ddy:0);
      if(tx>=0&&ty>=0&&tx<COLS&&ty<ROWS && f.grid[ty][tx]==="floor") { sl.x=tx; sl.y=ty; }
    }
    if(sl.x===st.x && sl.y===st.y){ st.hp--; st.msg = "A slime hit you! ("+st.hp+" ♥ left)"; if(f.r()<0.4){ st.bag.slime=(st.bag.slime|0)+1; } sl.x = Math.min(COLS-1, sl.x+1); }
  });
  if(st.hp <= 0) finish(true);
  render();
}
function finish(fainted){
  if(!st || st.over) return;
  st.over = true;
  var s = api.save.mines, got = [];
  Object.keys(st.bag).forEach(function(id){ var n = fainted ? Math.floor(st.bag[id]/2) : st.bag[id]; if(n>0){ api.inv.add(id, n); got.push(n+" "+api.items[id].name); } });
  s.runs = (s.runs|0)+1; s.best = Math.max(s.best|0, st.depth); api.persist();
  st.msg = (fainted ? "You fainted on floor "+st.depth+" and dropped half your loot. " : "You climbed out from floor "+st.depth+". ")+(got.length ? "Kept: "+got.join(", ")+"." : "No loot this time.");
  render();
}
function draw(cv){
  var g = cv.getContext("2d"), f = st.floor; g.imageSmoothingEnabled = false;
  var shade = Math.max(0, 60 - st.depth*4);
  for(var y=0;y<ROWS;y++) for(var x=0;x<COLS;x++){
    g.drawImage(spr("floor", {"1":"#3a2f2a","2":"rgb("+(70+shade)+","+(56+shade)+","+(48+shade)+")"}), x*T, y*T);
    if(f.grid[y][x]==="rock") g.drawImage(spr("rock", {"1":"#4a4a52","2":"#8a8a96"}), x*T, y*T);
    if(f.grid[y][x]==="ladder") g.drawImage(spr("ladder", {"1":"#c9a14a"}), x*T, y*T);
  }
  f.slimes.forEach(function(sl){ g.drawImage(spr("slime", {"1":"#2f8a2f","2":"#7ae07a"}), sl.x*T, sl.y*T); });
  g.drawImage(spr("hero", {"1":"#6b4a2b","2":"#f2c99a","3":"#3a6fd8","4":"#2b2b2b"}), st.x*T, st.y*T);
}
function render(){
  if(!root) return;
  root.textContent = "";
  var s = api.save.mines, head = api.mk("div","vg-row");
  head.appendChild(api.mk("span",null,"Deepest: floor "+(s.best|0)+" · This week you can reach floor "+maxDepth()+" ("+api.activity().weekActiveDays+" active days)"));
  root.appendChild(head);
  if(!st){ root.appendChild(api.btn("Enter the Mines", "primary", start)); return; }
  var info = api.mk("div","vg-row");
  info.appendChild(api.mk("b",null,"Floor "+st.depth+" · "+"♥".repeat(Math.max(0,st.hp))));
  var bag = Object.keys(st.bag).map(function(id){ return st.bag[id]+" "+api.items[id].name; }).join(", ");
  info.appendChild(api.mk("span","vg-muted", bag ? "Carrying: "+bag : "Carrying nothing yet"));
  root.appendChild(info);
  var cv = api.canvas(COLS*T, ROWS*T); cv.setAttribute("aria-label","Mine floor "+st.depth+". Use arrow keys or WASD to move.");
  draw(cv);
  cv.addEventListener("keydown", function(e){
    var k = e.key, d = {ArrowUp:[0,-1],ArrowDown:[0,1],ArrowLeft:[-1,0],ArrowRight:[1,0],w:[0,-1],s:[0,1],a:[-1,0],d:[1,0]}[k];
    if(d){ e.preventDefault(); move(d[0], d[1]); var n = root && root.querySelector("canvas"); if(n) n.focus(); }
  });
  cv.addEventListener("click", function(e){
    var r = cv.getBoundingClientRect(), x = Math.floor((e.clientX-r.left)/r.width*COLS), y = Math.floor((e.clientY-r.top)/r.height*ROWS);
    var dx = x-st.x, dy = y-st.y; if(Math.abs(dx)+Math.abs(dy)===1) move(dx, dy);
  });
  root.appendChild(cv);
  var msg = api.mk("p","vg-msg", st.msg); msg.setAttribute("aria-live","polite"); root.appendChild(msg);
  var row = api.mk("div","vg-row");
  if(!st.over) row.appendChild(api.btn("Climb out with your loot", "", function(){ finish(false); }));
  else row.appendChild(api.btn("Go back down", "primary", start));
  root.appendChild(row);
  if(!st.over) setTimeout(function(){ var n = root && root.querySelector("canvas"); if(n && document.activeElement !== n && !(document.activeElement && document.activeElement.tagName==="BUTTON")) n.focus(); }, 0);
}
game.badge = function(){ return ""; };
game.mount = function(el, a){ api = a; root = el; st = null; render(); };
game.unmount = function(){ if(st && !st.over) finish(false); root = null; st = null; };
game.pause = function(){ if(st) st.paused = true; };
game.resume = function(){ if(st) st.paused = false; };
HQV.register(game);
})();
