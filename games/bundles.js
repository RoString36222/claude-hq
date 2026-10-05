/* Valley: Bundles board (a community-center board). Hand in sets of items from the other
 * games; each finished bundle unlocks something: a pond, a garden plot boost, a title. */
(function(){
"use strict";
var HQV = window.HQV; if(!HQV) return;
var BUNDLES = [
  {id:"pond", name:"Pond Bundle", need:{minnow:2, perch:2, carp:1, trout:1}, reward:"Unlocks the Glowfin's rare bite in every pond", unlock:"glowpond"},
  {id:"spring", name:"Spring Crops", need:{radish:2, pea:2, tulip:1}, reward:"Title: Green Thumb", unlock:"title:Green Thumb"},
  {id:"summer", name:"Summer Crops", need:{tomato:2, corn:2, melon:1}, reward:"Title: Sun Farmer", unlock:"title:Sun Farmer"},
  {id:"autumn", name:"Autumn Crops", need:{pumpkin:2, grape:2}, reward:"Title: Harvest Keeper", unlock:"title:Harvest Keeper"},
  {id:"mine", name:"Miner's Bundle", need:{copper:5, iron:3, quartz:1}, reward:"Mines start one floor deeper", unlock:"mines+1"},
  {id:"gems", name:"Gem Bundle", need:{amethyst:1, emerald:1, ruby:1}, reward:"Title: Gem Hunter", unlock:"title:Gem Hunter"},
  {id:"rare", name:"Deep Waters", need:{koi:1, angler:1, sturgeon:1}, reward:"Title: Master Angler", unlock:"title:Master Angler"},
  {id:"oddities", name:"Oddities", need:{slime:5, shell:3, gold:2}, reward:"Arcade: extra life", unlock:"arcade+life"}
];
var game = {id:"bundles", name:"Bundles Board", icon:"📜", desc:"Hand in sets of items for unlocks"};
var api = null, root = null;

function given(b){ var g = api.save.bundles.given = api.save.bundles.given || {}; return g[b.id] = g[b.id] || {}; }
function isDone(b){ return !!(api.save.bundles.done||{})[b.id]; }
function complete(b){
  var s = api.save.bundles; s.done = s.done || {}; s.done[b.id] = api.day();
  api.save.unlocks[b.unlock] = 1; api.persist();
  api.toast("📜 "+b.name+" complete! "+b.reward, "ach");
}
function render(){
  if(!root) return;
  root.textContent = "";
  var done = BUNDLES.filter(isDone).length;
  root.appendChild(api.mk("p","vg-muted", done+" of "+BUNDLES.length+" bundles complete."+(done===BUNDLES.length?" The board is full — the whole valley thanks you.":"")));
  var grid = api.mk("div","vg-bundles");
  BUNDLES.forEach(function(b){
    var card = api.mk("div","vg-bundle"+(isDone(b)?" done":""));
    card.appendChild(api.mk("b",null,b.name));
    var gv = given(b), row = api.mk("div","vg-needs");
    Object.keys(b.need).forEach(function(id){
      var have = Math.min(gv[id]|0, b.need[id]), slot = api.mk("div","vg-need"+(have>=b.need[id]?" met":""));
      slot.appendChild(api.iconEl(id, 3));
      slot.appendChild(api.mk("span",null,have+"/"+b.need[id]));
      slot.title = api.items[id].name;
      if(!isDone(b) && have < b.need[id] && api.inv.count(id) > 0){
        slot.classList.add("can"); slot.tabIndex = 0; slot.setAttribute("role","button");
        slot.setAttribute("aria-label","Hand in "+api.items[id].name);
        var give = function(){ if(!api.inv.take(id,1)) return; gv[id]=(gv[id]|0)+1; api.persist();
          if(Object.keys(b.need).every(function(k){ return (gv[k]|0) >= b.need[k]; })) complete(b);
          render(); };
        slot.addEventListener("click", give);
        slot.addEventListener("keydown", function(e){ if(e.key==="Enter"||e.key===" "){ e.preventDefault(); give(); } });
      }
      row.appendChild(slot);
    });
    card.appendChild(row);
    card.appendChild(api.mk("span","vg-muted", isDone(b) ? "Done — "+b.reward : "Reward: "+b.reward));
    grid.appendChild(card);
  });
  root.appendChild(grid);
  var titles = Object.keys(api.save.unlocks).filter(function(k){ return k.indexOf("title:")===0; }).map(function(k){ return k.slice(6); });
  if(titles.length) root.appendChild(api.mk("p",null,"Titles earned: "+titles.join(", ")));
}
game.badge = function(){ if(!api || !api.save) return ""; var n=BUNDLES.filter(function(b){ return !isDone(b) && Object.keys(b.need).some(function(id){ return api.inv.count(id)>0 && (given(b)[id]|0)<b.need[id]; }); }).length; return n ? n+" can progress" : ""; };
game.mount = function(el, a){ api = a; root = el; render(); };
game.unmount = function(){ root = null; };
HQV.register(game);
if(HQV.api) api = HQV.api;
HQV.bundles = BUNDLES;
})();
