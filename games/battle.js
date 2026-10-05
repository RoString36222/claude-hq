/* Valley: Creature battles. Your team is your live session creatures (the same ones the Gym
 * scores). Each turn you pick which creature attacks; damage uses the Gym's real 18-type
 * chart (window.eff). Fight the day's wild team, or a friend's team: in an Arena room, "Share
 * my team" sends only species numbers and types (evolution announcements already share
 * species), and friends' shared teams appear as challengers. */
(function(){
"use strict";
var HQV = window.HQV; if(!HQV) return;
var game = {id:"battle", name:"Creature Battles", icon:"⚔️", desc:"Type matchups with your session creatures"};
var api = null, root = null, fight = null, challengers = {};
var TYPES = ["Normal","Fire","Water","Grass","Electric","Ice","Fighting","Poison","Ground","Flying","Psychic","Bug","Rock","Ghost","Dragon","Dark","Steel","Fairy"];

function effOf(a, d){ return typeof window.eff==="function" ? window.eff(a, d) : 1; }
function myTeam(){
  var team = typeof window.gymTeam==="function" ? window.gymTeam() : [];
  if(!team.length){
    // No live team: borrow your three most recent creatures.
    team = (api.activity().sessions||[]).slice(0,3).map(function(s){ var cr=s.creature||{};
      return {cr:cr, type: typeof window.creatureType==="function" ? window.creatureType(cr) : "Normal",
              name: typeof window.creatureSpecies==="function" ? window.creatureSpecies(cr) : "Creature"}; });
  }
  return team.slice(0,6).map(function(m){
    var stage = typeof window.creatureStage==="function" ? (window.creatureStage(m.cr)|0) : 1;
    return {name:m.name, type:m.type||"Normal", species:m.cr.species|0, hp:30+stage*12, max:30+stage*12, atk:8+stage*3};
  });
}
function wildTeam(){
  var r = api.rng("wild:"+api.day()), n = 3, lvl = 1 + Math.floor(api.activity().weekActiveDays/2), t = [];
  for(var i=0;i<n;i++){ var ty = TYPES[Math.floor(r()*TYPES.length)];
    t.push({name:"Wild "+ty+" sprite", type:ty, species:-1, hp:34+lvl*10, max:34+lvl*10, atk:9+lvl*2}); }
  return t;
}
function begin(foe, label){
  var mine = myTeam();
  if(!mine.length){ api.toast("You need at least one creature (a session) to battle"); return; }
  fight = {mine:mine, foe:foe, label:label, log:["A battle against "+label+" begins!"], over:false, foeIdx:0};
  render();
}
function alive(t){ return t.filter(function(m){ return m.hp>0; }); }
function hit(att, def){
  var m = effOf(att.type, def.type), dmg = Math.max(1, Math.round(att.atk * m * (0.85 + Math.random()*0.3)));
  def.hp = Math.max(0, def.hp - dmg);
  var tag = m >= 2 ? " It's super effective!" : m === 0 ? " It had no effect." : m < 1 ? " Not very effective." : "";
  return att.name+" hits "+def.name+" for "+dmg+"."+tag;
}
function turn(i){
  if(!fight || fight.over || fight.paused) return;
  var me = fight.mine[i], foes = alive(fight.foe); if(!me || me.hp<=0 || !foes.length) return;
  var target = foes[0];
  fight.log.push(hit(me, target));
  if(!alive(fight.foe).length) return end(true);
  // foe strikes the creature it is best against
  var att = alive(fight.foe)[0], mine = alive(fight.mine);
  mine.sort(function(a,b){ return effOf(att.type,b.type)-effOf(att.type,a.type); });
  fight.log.push(hit(att, mine[0]));
  if(!alive(fight.mine).length) return end(false);
  render();
}
function end(won){
  fight.over = true;
  var b = api.save.battle; b.wins=(b.wins|0)+(won?1:0); b.losses=(b.losses|0)+(won?0:1);
  if(won && fight.label==="the wild team" && b.wildDay !== api.day()){ b.wildDay = api.day(); api.inv.add("shell", 1); fight.log.push("Daily win! You found a Bug Shell."); }
  api.persist();
  fight.log.push(won ? "You won!" : "Your team fainted. They'll be fine after a rest.");
  if(won && api.inArenaRoom() && fight.label!=="the wild team") api.say({g:"battle", op:"result", won:true, vs:fight.label.slice(0,40)});
  render();
}
function hpBar(m){ var w = api.mk("div","vg-meter"+(m.hp/m.max<.3?" low":"")); var f=api.mk("i"); f.style.width=Math.round(m.hp/m.max*100)+"%"; w.appendChild(f); return w; }
function render(){
  if(!root) return;
  root.textContent = "";
  var b = api.save.battle;
  root.appendChild(api.mk("p","vg-muted","Record: "+(b.wins|0)+" wins, "+(b.losses|0)+" losses. Damage uses the Gym's type chart."));
  if(!fight || fight.over){
    var row = api.mk("div","vg-row");
    row.appendChild(api.btn("Battle today’s wild team", "primary", function(){ begin(wildTeam(), "the wild team"); }));
    if(api.inArenaRoom()) row.appendChild(api.btn("Share my team in this room", "", function(){
      var t = myTeam().map(function(m){ return {s:m.species, t:m.type, n:m.name.slice(0,24), h:m.max, a:m.atk}; });
      if(api.say({g:"battle", op:"team", team:t})) api.toast("Team shared with the room"); }));
    root.appendChild(row);
    var names = Object.keys(challengers);
    if(names.length){
      var cl = api.mk("div","vg-row"); cl.appendChild(api.mk("span",null,"Challengers: "));
      names.forEach(function(n){ cl.appendChild(api.btn(n, "", function(){
        begin(challengers[n].map(function(m){ return {name:m.n, type:m.t, species:m.s, hp:m.h, max:m.h, atk:m.a}; }), n+"’s team"); })); });
      root.appendChild(cl);
    } else if(api.inArenaRoom()) root.appendChild(api.mk("p","vg-muted","When friends in this room share their teams, they show up here as challengers."));
    else root.appendChild(api.mk("p","vg-muted","Join an Arena room to battle friends' teams."));
  }
  if(fight){
    var arena = api.mk("div","vg-battle");
    [["Your team", fight.mine, true], [fight.label, fight.foe, false]].forEach(function(side){
      var col = api.mk("div","vg-side"); col.appendChild(api.mk("h4",null,side[0]));
      side[1].forEach(function(m, i){
        var r = api.mk("div","vg-mon"+(m.hp<=0?" ko":""));
        r.appendChild(api.mk("b",null,m.name)); r.appendChild(api.mk("span","vg-type",m.type)); r.appendChild(hpBar(m));
        if(side[2] && !fight.over && m.hp>0){ r.appendChild(api.btn("Attack", "", function(){ turn(i); })); }
        col.appendChild(r);
      });
      arena.appendChild(col);
    });
    root.appendChild(arena);
    var log = api.mk("div","vg-battlelog"); log.setAttribute("aria-live","polite");
    fight.log.slice(-6).forEach(function(l){ log.appendChild(api.mk("div",null,l)); });
    root.appendChild(log);
  }
}
game.onSay = function(d, who){
  if(d.op==="team" && Array.isArray(d.team)){
    var clean = d.team.slice(0,6).filter(function(m){ return m && typeof m==="object"; }).map(function(m){
      return {s:(m.s|0), t: TYPES.indexOf(m.t)>=0 ? m.t : "Normal", n: typeof m.n==="string" ? m.n.slice(0,24) : "Creature",
              h: Math.max(10, Math.min(120, m.h|0)), a: Math.max(3, Math.min(40, m.a|0))};
    });
    if(clean.length){ challengers[who] = clean; if(root && (!fight || fight.over)) render(); }
  } else if(d.op==="result" && d.won){ api && api.toast("⚔️ "+who+" won a battle against "+(typeof d.vs==="string"?d.vs.slice(0,40):"a team")); }
};
game.badge = function(){ var n = Object.keys(challengers).length; return n ? n+" challenger"+(n>1?"s":"") : ""; };
game.mount = function(el, a){ api = a; root = el; render(); };
game.unmount = function(){ root = null; fight = null; };
game.pause = function(){ if(fight) fight.paused = true; };
game.resume = function(){ if(fight) fight.paused = false; };
HQV.register(game);
if(HQV.api) api = HQV.api;
})();
