/* Valley: Fishing pond. Hold Space / mouse / touch to lift the green catch bar and keep the
 * fish inside it until the progress meter fills. Each project folder you work in is its own
 * pond with its own fish mix; for 10 minutes after a long-running tab finishes, rare fish bite
 * more often. Catches go to the bag and the fishing log. */
(function(){
"use strict";
var HQV = window.HQV; if(!HQV) return;
var POND_FISH = ["minnow","perch","carp","bream","trout","pike","eel","koi","sturgeon","angler","glowfin","lumen","leviathan","sunfish","ghostfish","mudcat"];
var W=240, H=150, BAR_H=150, ZONE=34;
var game = {id:"fishing", name:"Fishing Pond", icon:"🎣", desc:"Hold to keep the fish in the bar"};
var st = null, raf = 0, api = null, root = null, rareUntil = 0;

function pondFor(folder){
  // Each folder gets a stable mix: 8 of the 16 fish, weighted by rarity.
  var r = api.rng("pond:"+(folder||"home")), pool = POND_FISH.slice();
  for(var i=pool.length-1;i>0;i--){ var j=Math.floor(r()*(i+1)); var t=pool[i]; pool[i]=pool[j]; pool[j]=t; }
  return pool.slice(0, 8);
}
function pickFish(folder){
  var items = api.items, pool = pondFor(folder), rareBoost = Date.now() < rareUntil;
  var weights = pool.map(function(id){ var r=items[id].rarity; return rareBoost ? [0,4,3,3,2][r] : [0,10,5,2,0.6][r]; });
  var tot = weights.reduce(function(a,b){ return a+b; }, 0), x = Math.random()*tot;
  for(var i=0;i<pool.length;i++){ x-=weights[i]; if(x<=0) return pool[i]; }
  return pool[0];
}

game.onFinished = function(list){
  // A tab that worked for a while and just finished: the pond stirs.
  var long = list.some(function(s){ return (s.promptCount|0) >= 3; });
  if(long){ rareUntil = Date.now() + 10*60*1000; }
};
game.badge = function(){ return Date.now() < rareUntil ? "Rare fish biting!" : ""; };

function newCast(){
  var fish = pickFish(st.folder), r = api.items[fish].rarity;
  st.fish = fish; st.phase = "wait"; st.waitUntil = performance.now() + 800 + Math.random()*2200;
  st.fishY = BAR_H/2; st.fishV = 0; st.target = BAR_H/2; st.barY = BAR_H/2 - ZONE/2; st.barV = 0;
  st.progress = 0.3; st.speed = 0.6 + r*0.45; st.msg = "Waiting for a bite…";
}
function step(dt){
  if(st.phase==="wait"){
    if(performance.now() >= st.waitUntil){ st.phase="reel"; st.msg="Bite! Hold to reel in."; }
    return;
  }
  if(st.phase!=="reel") return;
  // fish darts toward a moving target
  if(Math.random() < 0.02*st.speed) st.target = 8 + Math.random()*(BAR_H-16);
  st.fishV += (st.target - st.fishY) * 0.002 * st.speed * dt;
  st.fishV *= 0.92; st.fishY = Math.max(4, Math.min(BAR_H-4, st.fishY + st.fishV*dt));
  // catch bar: holding lifts it, gravity pulls it down
  st.barV += (st.hold ? -0.012 : 0.010) * dt;
  st.barV = Math.max(-0.35, Math.min(0.35, st.barV));
  st.barY += st.barV*dt;
  if(st.barY < 0){ st.barY=0; st.barV=0; } if(st.barY > BAR_H-ZONE){ st.barY=BAR_H-ZONE; st.barV*=-0.3; }
  var inside = st.fishY >= st.barY && st.fishY <= st.barY+ZONE;
  st.progress += (inside ? 0.00045 : -0.0004) * dt;
  if(st.progress >= 1) land();
  else if(st.progress <= 0){ st.phase="lost"; st.msg = "It got away. Click Cast to try again."; }
}
function land(){
  var id = st.fish, it = api.items[id], s = api.save;
  st.phase = "caught"; st.msg = "Caught a "+it.name+"!";
  api.inv.add(id, 1);
  s.log.fish = s.log.fish || {};
  var e = s.log.fish[id] = s.log.fish[id] || {n:0, first:api.day()};
  e.n++; api.persist();
  if(e.n===1) api.toast("🎣 New fish: "+it.name, "ach");
  renderLog();
  if(game.onCatch) game.onCatch(id);
}
function draw(){
  var g = st.ctx; g.imageSmoothingEnabled=false;
  // water + reeds
  g.fillStyle="#2b5f7a"; g.fillRect(0,0,W,H);
  g.fillStyle="#357590"; for(var i=0;i<6;i++) g.fillRect(((i*47+(api.calm()?0:Math.floor(performance.now()/90)))%W),20+i*20,18,1);
  g.fillStyle="#3f7d3a"; for(var k=0;k<W;k+=9) g.fillRect(k, H-6-(k%4), 2, 6+(k%4));
  // the meter
  var bx=W-46; g.fillStyle="#1d3140"; g.fillRect(bx,0,22,BAR_H);
  g.fillStyle="#6fd36a"; g.fillRect(bx+2, st.barY, 18, ZONE);
  if(st.phase==="reel"||st.phase==="caught"){
    var ic = api.icon(api.items[st.fish], 2); g.drawImage(ic, bx+3, st.fishY-8);
  }
  g.fillStyle="#1d3140"; g.fillRect(bx+26,0,8,BAR_H);
  g.fillStyle = st.progress>0.66 ? "#6fd36a" : st.progress>0.33 ? "#f2d14b" : "#e0452f";
  var ph = Math.max(0, Math.min(1, st.progress))*BAR_H; g.fillRect(bx+27, BAR_H-ph, 6, ph);
  // bobber
  g.fillStyle="#f5f5f5"; g.fillRect(70,70,6,6); g.fillStyle="#e0452f"; g.fillRect(70,66,6,4);
  if(st.phase==="wait" && !api.calm()){ var r=(performance.now()/200)%12; g.strokeStyle="rgba(255,255,255,.35)"; g.strokeRect(73-r,73-r/2,r*2,r); }
}
function loop(t){
  var dt = st.last ? Math.min(50, t-st.last) : 16; st.last = t;
  if(!st.paused){ step(dt); }
  draw(); st.msgEl.textContent = st.paused ? "Paused" : st.msg;
  raf = requestAnimationFrame(loop);
}
function renderLog(){
  if(!st || !st.logEl) return;
  var log = (api.save.log.fish)||{}, box = st.logEl; box.textContent = "";
  var got = POND_FISH.filter(function(id){ return log[id]; }).length;
  box.appendChild(api.mk("h4", null, "Fishing log · "+got+"/"+POND_FISH.length));
  var grid = api.mk("div","vg-log");
  POND_FISH.forEach(function(id){
    var it = api.items[id], cell = api.mk("div","vg-logcell"+(log[id]?"":" unknown"));
    cell.appendChild(api.iconEl(id, 3));
    cell.appendChild(api.mk("span", null, log[id] ? it.name+" ×"+log[id].n : "???"));
    cell.title = log[id] ? it.name+" — "+["","common","uncommon","rare","legendary"][it.rarity] : "Not caught yet";
    grid.appendChild(cell);
  });
  box.appendChild(grid);
}

game.mount = function(el, a){
  api = a; root = el;
  var acts = api.activity(), folders = acts.folders.length ? acts.folders : ["home"];
  st = {folder: folders[0], hold:false, paused:false, last:0};
  var top = api.mk("div","vg-row");
  var sel = api.mk("select","vg-select"); sel.setAttribute("aria-label","Pond");
  folders.forEach(function(f){ var o=api.mk("option",null,"Pond: "+(f.replace(/^-Users-[^-]+-?/,"")||"home")); o.value=f; sel.appendChild(o); });
  sel.addEventListener("change", function(){ st.folder = sel.value; newCast(); });
  top.appendChild(sel);
  top.appendChild(api.btn("Cast", "primary", function(){ newCast(); cv.focus(); }));
  el.appendChild(top);
  var cv = api.canvas(W, H); cv.setAttribute("aria-label","Fishing pond. Hold Space or the mouse button to lift the catch bar.");
  el.appendChild(cv);
  st.ctx = cv.getContext("2d");
  st.msgEl = api.mk("p","vg-msg"); st.msgEl.setAttribute("aria-live","polite"); el.appendChild(st.msgEl);
  st.logEl = api.mk("div"); el.appendChild(st.logEl);
  function down(e){ if(e.type==="keydown" && e.key!==" ") return; e.preventDefault(); st.hold = true; if(st.phase==="caught"||st.phase==="lost") newCast(); }
  function up(e){ if(e.type==="keyup" && e.key!==" ") return; st.hold = false; }
  cv.addEventListener("mousedown", down); cv.addEventListener("touchstart", down, {passive:false});
  window.addEventListener("mouseup", up); window.addEventListener("touchend", up);
  cv.addEventListener("keydown", down); cv.addEventListener("keyup", up);
  st.cleanup = function(){ window.removeEventListener("mouseup", up); window.removeEventListener("touchend", up); };
  newCast(); renderLog();
  raf = requestAnimationFrame(loop);
};
game.unmount = function(){ cancelAnimationFrame(raf); if(st && st.cleanup) st.cleanup(); st = null; };
game.pause = function(){ if(st){ st.paused = true; st.hold = false; } };
game.resume = function(){ if(st){ st.paused = false; st.last = 0; } };
// The festival derby scores catches through this hook.
HQV.fishingCatch = function(fn){ game.onCatch = fn; };
HQV.register(game);
})();
