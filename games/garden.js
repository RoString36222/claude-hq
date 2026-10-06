/* Valley: Creature garden. Six plots. Seeds come from the daily seed box (3 a day, this
 * season's crops). A crop needs real time AND water; water is your real activity: every
 * prompt you send waters the garden once, spread over the growing plots. Harvests go to
 * the bag (bundles, townsfolk gifts) or can be shared with a creature as a picnic (cosmetic
 * hearts only: the energy system's food stays server-side in the Store). */
(function(){
"use strict";
var HQV = window.HQV; if(!HQV) return;
var PLOTS = 6, SEEDS_PER_DAY = 3;
var game = {id:"garden", name:"Creature Garden", icon:"🌱", desc:"Your prompts water the crops"};
var api = null, root = null, timer = 0;

function g(){ var s = api.save.garden; if(!Array.isArray(s.plots)) s.plots = []; while(s.plots.length < PLOTS) s.plots.push(null); s.seeds = s.seeds || {}; return s; }
function seasonCrops(){ var se = api.season(); return Object.keys(api.items).filter(function(id){ var it=api.items[id]; return it.cat==="crop" && it.season===se; }); }

// Water: the change in your 30-day prompt total since we last looked, shared across plots.
function waterFromActivity(){
  var s = g(), now = api.activity().prompts30;
  if(typeof s.seen !== "number"){ s.seen = now; return 0; }
  var d = now - s.seen; s.seen = now;
  return d > 0 ? Math.min(d, 200) : 0;
}
function applyWater(){
  var add = waterFromActivity(); if(!add) return;
  var s = g(), growing = s.plots.filter(function(p){ return p && !ripe(p); });
  if(!growing.length){ api.persist(); return; }
  for(var i=0;i<add;i++){ var p = growing[i % growing.length]; p.water = (p.water|0) + 1; }
  api.persist(); render();
}
function ripe(p){ var it = api.items[p.crop]; return it && (Date.now() - p.planted) >= it.hours*3600e3 && (p.water|0) >= it.water; }
function progress(p){
  var it = api.items[p.crop]; if(!it) return 0;
  var t = Math.min(1, (Date.now()-p.planted)/(it.hours*3600e3)), w = Math.min(1, (p.water|0)/it.water);
  return Math.min(t, w);
}
function claimSeeds(){
  var s = g(), today = api.day();
  if(s.seedDay === today) return false;
  var crops = seasonCrops(), r = api.rng("seeds:"+today);
  for(var i=0;i<SEEDS_PER_DAY;i++){ var c = crops[Math.floor(r()*crops.length)]; s.seeds[c] = (s.seeds[c]|0)+1; }
  s.seedDay = today; api.persist(); return true;
}

var PLANT_SPR = [
  ["........","........","........","........","........","...33...","..3..3..","........"],
  ["........","........","...44...","..4..4..","...44...","...33...","...33...","........"],
  ["...44...","..4444..",".44..44.","...44...","..3443..","...33...","...33...","........"],
  ["..1221..",".122221.","..1221..","...44...","..4444..","...33...","...33...","........"]
];
function plantCanvas(p){
  if(!p) return api.mk("span","vg-soil-empty","Empty");
  var it = api.items[p.crop], pr = progress(p), stage = ripe(p) ? 3 : pr > .6 ? 2 : pr > .25 ? 1 : 0;
  return api.sprite("plant:"+p.crop+":"+stage, PLANT_SPR[stage], {"1":it.c1,"2":it.c2,"3":"#3f7d3a","4":"#6fbf5a"}, 6);
}
function render(){
  if(!root) return;
  var s = g(); root.textContent = "";
  var head = api.mk("div","vg-row");
  var seedCount = Object.keys(s.seeds).reduce(function(a,k){ return a+(s.seeds[k]|0); }, 0);
  head.appendChild(api.mk("span","vg-muted", "Season: "+api.season()+" · Seeds: "+seedCount+" · Each prompt you send waters a growing plot."));
  var box = api.btn("Open today’s seed box", "", function(){ if(claimSeeds()){ api.toast("🌱 "+SEEDS_PER_DAY+" seeds added"); } else api.toast("Seed box is empty until tomorrow"); render(); });
  if(s.seedDay === api.day()) box.disabled = true;
  head.appendChild(box);
  root.appendChild(head);
  var grid = api.mk("div","vg-garden");
  s.plots.forEach(function(p, i){
    var cell = api.mk("div","vg-plot"+(p && ripe(p) ? " ripe":""));
    var c = plantCanvas(p); cell.appendChild(c.tagName==="CANVAS" ? cloneC(c) : c);
    if(!p){
      var seeds = Object.keys(s.seeds).filter(function(k){ return s.seeds[k]>0; });
      if(seeds.length){
        var sel = api.mk("select","vg-select"); sel.setAttribute("aria-label","Seed for plot "+(i+1));
        sel.appendChild(api.mk("option",null,"Plant…"));
        seeds.forEach(function(k){ var o=api.mk("option",null,api.items[k].name+" ("+s.seeds[k]+")"); o.value=k; sel.appendChild(o); });
        sel.addEventListener("change", function(){ if(!sel.value || !s.seeds[sel.value]) return; s.seeds[sel.value]--; if(!s.seeds[sel.value]) delete s.seeds[sel.value];
          s.plots[i] = {crop:sel.value, planted:Date.now(), water:0}; api.persist(); render(); });
        cell.appendChild(sel);
      } else cell.appendChild(api.mk("span","vg-muted","No seeds"));
    } else {
      var it = api.items[p.crop];
      cell.appendChild(api.mk("b",null,it.name));
      if(ripe(p)){
        cell.appendChild(api.btn("Harvest", "primary", function(){ s.plots[i]=null; api.inv.add(p.crop, 1+(api.hash(p.crop+p.planted)%2)); api.toast("🧺 Harvested "+it.name); render(); }));
      } else {
        var hrs = Math.max(0, it.hours - (Date.now()-p.planted)/3600e3);
        cell.appendChild(api.mk("span","vg-muted", "Water "+Math.min(p.water|0,it.water)+"/"+it.water+(hrs>0?" · "+(hrs<1?Math.ceil(hrs*60)+"m":hrs.toFixed(1)+"h")+" left":"")));
        var bar = api.mk("div","vg-meter"); var fill = api.mk("i"); fill.style.width = Math.round(progress(p)*100)+"%"; bar.appendChild(fill); cell.appendChild(bar);
      }
    }
    grid.appendChild(cell);
  });
  root.appendChild(grid);
  // Picnic: share a harvested crop with one of your live creatures (cosmetic).
  var crops = api.inv.list("crop"), team = (api.activity().sessions||[]).filter(function(x){ return x.status!=="stale"; }).slice(0,6);
  if(crops.length && team.length){
    var pic = api.mk("div","vg-row");
    pic.appendChild(api.mk("span",null,"Picnic: "));
    var cs = api.mk("select","vg-select"); crops.forEach(function(k){ var o=api.mk("option",null,api.items[k].name); o.value=k; cs.appendChild(o); });
    var ts = api.mk("select","vg-select"); team.forEach(function(x){ var o=api.mk("option",null,(x.title||x.name||"session").slice(0,40)); o.value=x.sessionId||x.id; ts.appendChild(o); });
    pic.appendChild(cs); pic.appendChild(ts);
    pic.appendChild(api.btn("Share", "", function(){
      if(!api.inv.take(cs.value, 1)) return;
      var h = api.save.garden.hearts = api.save.garden.hearts || {}; h[ts.value] = Math.min(10, (h[ts.value]|0)+1); api.persist();
      api.toast("🧺 Your creature loved the "+api.items[cs.value].name+" (♥ "+h[ts.value]+")"); render();
    }));
    root.appendChild(pic);
  }
}
function cloneC(src){ var c=document.createElement("canvas"); c.width=src.width; c.height=src.height; c.getContext("2d").drawImage(src,0,0); c.className="vg-plant"; return c; }

game.badge = function(){ if(!api || !api.save) return ""; var s=g(); var n=s.plots.filter(function(p){ return p && ripe(p); }).length; return n ? n+" ready" : (s.seedDay!==api.day() ? "Seeds!" : ""); };
game.onTick = function(){ if(api && api.save) applyWater(); };
game.mount = function(el, a){ api = a; root = el; applyWater(); render(); timer = setInterval(render, 30000); };
game.unmount = function(){ clearInterval(timer); root = null; };
game.init = function(a){ api = a; };
HQV.register(game);
if(HQV.api) game.init(HQV.api);
})();
