/* Valley: Festivals. One festival a month, open the last Friday through Sunday (local time):
 * a three-minute fishing derby. Every fish you land in the Fishing Pond during the derby
 * scores by rarity. In an Arena room, scores are shared live (just a name and a number) and
 * the room's board fills in as friends play. */
(function(){
"use strict";
var HQV = window.HQV; if(!HQV) return;
var NAMES = ["Frost Derby","Ice Hole Derby","Thaw Derby","Blossom Derby","Rain Derby","Midsummer Derby","Sunfish Derby","Harvest Derby","Moon Derby","Lantern Derby","Fog Derby","Starlight Derby"];
var DERBY_MS = 3*60*1000, POINTS = [0,1,3,8,20];
var game = {id:"festival", name:"Festival", icon:"🎏", desc:"Monthly derby, scored live with friends"};
var api = null, root = null, run = null, board = {}, tick = 0;

function window_(d){
  d = d || new Date();
  var last = new Date(d.getFullYear(), d.getMonth()+1, 0), fri = new Date(last);
  fri.setDate(last.getDate() - ((last.getDay()+2)%7));          // last Friday of the month
  var start = new Date(fri.getFullYear(), fri.getMonth(), fri.getDate()), end = new Date(start); end.setDate(start.getDate()+3);
  return {start:start, end:end, name:NAMES[d.getMonth()], key:d.getFullYear()+"-"+(d.getMonth()+1)};
}
function isOpen(){ var w = window_(), n = new Date(); return n >= w.start && n < w.end; }
function onCatch(id){
  if(!run || run.done) return;
  var it = api.items[id]; run.score += POINTS[it.rarity]|0; run.count++;
  if(api.inArenaRoom()) api.say({g:"festival", key:window_().key, score:run.score});
  if(root) render();
}
function start(){
  run = {start:Date.now(), score:0, count:0, done:false};
  if(HQV.fishingCatch) HQV.fishingCatch(onCatch);
  api.toast("🎏 Derby started! Go fish — 3 minutes on the clock.");
  clearInterval(tick); tick = setInterval(function(){ if(run && !run.done && Date.now()-run.start >= DERBY_MS) finish(); if(root) render(); }, 1000);
  api.open("fishing");
}
function finish(){
  if(!run || run.done) return;
  run.done = true; clearInterval(tick);
  var f = api.save.festival, k = window_().key; f[k] = Math.max(f[k]|0, run.score); api.persist();
  if(api.inArenaRoom()) api.say({g:"festival", key:k, score:run.score, final:true});
  api.toast("🎏 Derby over: "+run.score+" points from "+run.count+" fish", "ach");
  if(run.score >= 20) api.inv.add("gold", 1);
}
function render(){
  if(!root) return;
  var w = window_(), open = isOpen(); root.textContent = "";
  root.appendChild(api.mk("h4",null,w.name+" — "+w.start.toDateString()+" to "+new Date(w.end-1).toDateString()));
  if(!open){
    root.appendChild(api.mk("p","vg-muted","The festival opens on the last Friday of the month and runs through Sunday. Come back then!"));
  } else if(!run || run.done){
    root.appendChild(api.mk("p",null,"Three minutes. Every fish you land in the Fishing Pond scores: common 1, uncommon 3, rare 8, legendary 20. 20+ points earns a Gold Ore."));
    root.appendChild(api.btn(run && run.done ? "Fish another derby" : "Start the derby", "primary", start));
  } else {
    var left = Math.max(0, DERBY_MS - (Date.now()-run.start));
    root.appendChild(api.mk("b",null,"Derby running: "+Math.ceil(left/1000)+"s left · "+run.score+" points"));
    root.appendChild(api.btn("Back to the pond", "primary", function(){ api.open("fishing"); }));
  }
  var best = api.save.festival[w.key]|0;
  if(best) root.appendChild(api.mk("p",null,"Your best this festival: "+best+" points"));
  var names = Object.keys(board).filter(function(n){ return board[n].key===w.key; }).sort(function(a,b){ return board[b].score-board[a].score; });
  if(names.length){
    var t = api.mk("ol","vg-board"); names.slice(0,10).forEach(function(n){ t.appendChild(api.mk("li",null,n+" — "+board[n].score)); });
    root.appendChild(api.mk("h4",null,"This room")); root.appendChild(t);
  } else root.appendChild(api.mk("p","vg-muted", api.inArenaRoom() ? "Friends' derby scores in this room appear here." : "Join an Arena room to see friends' derby scores live."));
}
game.onSay = function(d, who){
  if(d.g!=="festival" || typeof d.key!=="string" || d.key.length>8) return;
  var sc = Math.max(0, Math.min(9999, d.score|0)), b = board[who];
  if(!b || b.key!==d.key || sc > b.score) board[who] = {key:d.key, score:sc};
  if(root) render();
};
game.badge = function(){ return isOpen() ? "Festival on now!" : ""; };
game.mount = function(el, a){ api = a; root = el; render(); };
game.unmount = function(){ root = null; };
HQV.register(game);
if(HQV.api) api = HQV.api;
})();
