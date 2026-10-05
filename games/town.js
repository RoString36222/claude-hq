/* Valley: Townsfolk. Three neighbours who comment on your real week and build friendship
 * hearts: talk once a day (+1), give a gift they like once a day (+2, or +1 for anything
 * else). Their lines read your activity counts; nothing here leaves the machine. */
(function(){
"use strict";
var HQV = window.HQV; if(!HQV) return;
var NPCS = [
  {id:"wren", name:"Wren", role:"Fisher", likes:["koi","trout","glowfin","sturgeon"], pal:{"1":"#6b4a2b","2":"#f2c99a","3":"#2f6f8a","4":"#2b2b2b"},
   lines:function(a){ return a.working.length ? "Your tabs are busy — perfect fishing weather. "+a.working.length+" lines in the water, eh?"
     : a.today > 40 ? "Big day! "+a.today+" bites on the line today. Even fish need a break, friend."
     : "Quiet pond today. The quiet ones always bite at dusk."; }},
  {id:"bram", name:"Bram", role:"Blacksmith", likes:["iron","gold","ruby","amethyst"], pal:{"1":"#2b2b2b","2":"#d9a07a","3":"#7a3f2b","4":"#3a3a3a"},
   lines:function(a){ return a.weekActiveDays >= 5 ? a.weekActiveDays+" days at the forge this week. Rest one, the steel will wait."
     : a.weekActiveDays >= 2 ? "Steady work, "+a.weekActiveDays+" days this week. The mines open deeper the more days you show up."
     : "Haven't seen you at the forge much. The mines are deeper when you're around more days a week."; }},
  {id:"juno", name:"Juno", role:"Innkeeper", likes:["melon","pumpkin","grape","tomato"], pal:{"1":"#c9a14a","2":"#f2c99a","3":"#8a3f6a","4":"#2b2b2b"},
   lines:function(a){ return a.needs.length ? "Someone's waiting on you upstairs — "+a.needs.length+" tab"+(a.needs.length>1?"s":"")+" calling."
     : a.streak >= 3 ? a.streak+" days in a row at my inn! The usual?"
     : "Pull up a chair. The fire's warm and nobody's asking you anything."; }}
];
var FACE = ["..1111..",".111111.",".122221.",".124241.",".122221.","..2222..",".333333.","33333333"];
var game = {id:"town", name:"Townsfolk", icon:"🏡", desc:"Neighbours who notice your week"};
var api = null, root = null;

function t(){ var s = api.save.town; s.hearts = s.hearts||{}; s.talked = s.talked||{}; s.gifted = s.gifted||{}; return s; }
function addHearts(id, n){ var s = t(); s.hearts[id] = Math.min(10, (s.hearts[id]|0)+n); api.persist(); }
function render(){
  if(!root) return;
  var s = t(), a = api.activity(), today = api.day(); root.textContent = "";
  var grid = api.mk("div","vg-town");
  NPCS.forEach(function(n){
    var card = api.mk("div","vg-npc");
    var face = api.sprite("npc:"+n.id, FACE, n.pal, 6), c = document.createElement("canvas"); c.width=face.width; c.height=face.height; c.getContext("2d").drawImage(face,0,0); c.className="vg-face";
    card.appendChild(c);
    var info = api.mk("div","vg-npc-info");
    info.appendChild(api.mk("b",null,n.name+" · "+n.role));
    var h = s.hearts[n.id]|0; info.appendChild(api.mk("span","vg-hearts","♥".repeat(h)+"♡".repeat(10-h)));
    var said = api.mk("p","vg-say"); said.setAttribute("aria-live","polite");
    if(s.talked[n.id]===today) said.textContent = "“"+n.lines(a)+"”";
    info.appendChild(said);
    var row = api.mk("div","vg-row");
    var talk = api.btn(s.talked[n.id]===today ? "Talked today" : "Talk", "", function(){
      if(s.talked[n.id]!==today){ s.talked[n.id]=today; addHearts(n.id, 1); } render(); });
    if(s.talked[n.id]===today) talk.disabled = true;
    row.appendChild(talk);
    var mine = api.inv.list();
    if(mine.length && s.gifted[n.id]!==today){
      var sel = api.mk("select","vg-select"); sel.setAttribute("aria-label","Gift for "+n.name);
      sel.appendChild(api.mk("option",null,"Give a gift…"));
      mine.forEach(function(id){ var o=api.mk("option",null,api.items[id].name+(n.likes.indexOf(id)>=0?" ♥":"")); o.value=id; sel.appendChild(o); });
      sel.addEventListener("change", function(){
        var id = sel.value; if(!api.items[id] || !api.inv.take(id,1)) return;
        var loved = n.likes.indexOf(id) >= 0; s.gifted[n.id] = today; addHearts(n.id, loved?2:1);
        api.toast(n.name+": "+(loved ? "Oh! I love "+api.items[id].name+"!" : "Thanks, that's kind of you."));
        render();
      });
      row.appendChild(sel);
    } else if(s.gifted[n.id]===today) row.appendChild(api.mk("span","vg-muted","Gift given today"));
    info.appendChild(row);
    card.appendChild(info);
    grid.appendChild(card);
  });
  root.appendChild(grid);
}
game.badge = function(){ if(!api || !api.save) return ""; var s=t(), d=api.day(); var n=NPCS.filter(function(x){ return s.talked[x.id]!==d; }).length; return n ? n+" to greet" : ""; };
game.mount = function(el, a){ api = a; root = el; render(); };
game.unmount = function(){ root = null; };
HQV.register(game);
if(HQV.api) api = HQV.api;
})();
