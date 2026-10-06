/* Valley: Creature Battles (solo). A Pokemon-style battle with REAL Pokemon data: your team
 * is your live session creatures (the same ones the Gym scores), each battling as the
 * Pokemon its sprite shows, with that Pokemon's real types, base stats and level-up moves
 * (games/pokedata.js). Or pick a team yourself from every Pokemon you've unlocked in the
 * Pokedex (the team builder in games/pokebattle.js; saved locally). Engine + battle screen: games/pokebattle.js (HQV.pk).
 * Fight the day's wild team, or a friend's team: in an Arena room, "Share my team" sends
 * only species numbers and evolution stages (evolution announcements already share those),
 * and the receiver rebuilds every stat and move from the data, never from the message. */
(function(){
"use strict";
var HQV = window.HQV; if(!HQV) return;
var game = {id:"battle", name:"Creature Battles", icon:"⚔️", desc:"Pokémon battles with real moves, stats and types"};
var api = null, root = null, fight = null, challengers = {};

function pk(){ return HQV.pk && HQV.pk.data() ? HQV.pk : null; }
// A creature -> the battle spec both engines understand (no transcript data in it).
function specOf(cr, name){
  cr = cr || {};
  var sp = typeof window.pokeIdx === "function" ? window.pokeIdx(cr) : (((cr.species|0)%48)+48)%48;
  var st = typeof window.creatureStage === "function" ? (window.creatureStage(cr)|0) : 2;
  var br = null, mg = null;
  try { if(typeof window.branchFinalDex === "function") br = window.branchFinalDex(cr); } catch(e){}
  try { if(typeof window.pokeMega === "function") mg = window.pokeMega(cr); } catch(e){}
  return {sp:sp, st:Math.max(0, Math.min(4, st)), br:br, mg:mg, sh:!!cr.shiny, name:String(name||"").slice(0,24)};
}
function myCreatures(){
  var team = typeof window.gymTeam === "function" ? window.gymTeam() : [];
  if(!team.length){
    // No live team: borrow your three most recent creatures.
    team = (api.activity().sessions||[]).slice(0,3).map(function(s){ var cr = s.creature||{};
      return {cr:cr, name: typeof window.creatureSpecies === "function" ? window.creatureSpecies(cr) : "Creature"}; });
  }
  return team.slice(0,6);
}
// The team you battle with: the one saved in the team builder (from your unlocked Pokemon),
// else your live session creatures. crs: the session creatures behind it (for the EXP bar).
function myTeam(){
  var P = pk(), saved = P && P.savedTeam ? P.savedTeam() : null;
  if(saved) return {specs: saved, crs: saved.map(function(){ return null; }), saved: true};
  var mine = myCreatures();
  return {specs: mine.map(function(m){ return specOf(m.cr, m.name); }), crs: mine.map(function(m){ return m.cr; }), saved: false};
}
function mySpecs(){ return myTeam().specs; }
function wildSpecs(mine){
  var r = api.rng("wild:"+api.day()), avg = 0;
  mine.forEach(function(s){ avg += s.st; }); avg = mine.length ? avg/mine.length : 1;
  var out = [];
  for(var i=0;i<3;i++){
    var st = Math.max(0, Math.min(4, Math.round(avg) - (r() < 0.4 ? 1 : 0)));
    out.push({sp: Math.floor(r()*48), st: st, br: null, mg: null, sh: r() < 1/64, name: ""});
  }
  // Branching lines pick a branch at random too.
  var d = pk().data();
  out.forEach(function(s){ var b = d.branches[String(s.sp)]; if(b) s.br = b[Math.floor(r()*b.length)]; });
  return out;
}
function seen(mon){
  var b = api.save.battle; if(!Array.isArray(b.seen)) b.seen = [];
  if(b.seen.indexOf(mon.dex) < 0){ b.seen.push(mon.dex); if(b.seen.length > 200) b.seen = b.seen.slice(-200); api.persist(); }
}
function copy(o){ return JSON.parse(JSON.stringify(o)); }
function view(){
  var s = fight.state, evo = 0;
  var cr = fight.crs[s.sides[0].active];
  if(cr && typeof window.creatureStagePct === "function") evo = window.creatureStagePct(cr);
  return {me: copy(s.sides[0]), foe: copy(s.sides[1]), evo: evo};
}
function who(side, name, sendOut){
  if(side === 0) return sendOut ? "Go! "+name : name;
  if(fight.wild) return sendOut ? "A wild "+name+" appeared" : "The wild "+name;
  return sendOut ? fight.label+" sent out "+name : "The foe's "+name;
}

function begin(foeSpecs, label, wild){
  var P = pk();
  if(!P){ api.toast("Battle data is still loading"); return; }
  var mine = myTeam();
  if(!mine.specs.length){ api.toast("You need at least one creature (a session) or a saved team to battle"); return; }
  var a = mine.specs.map(P.buildMon), b = foeSpecs.map(P.buildMon);
  // One seeded stream per battle (reproducible from fight.seed), as the duel server does with its own RNG.
  var seed = api.day()+":"+Date.now();
  fight = {state: P.newBattle(a, b), crs: mine.crs, label: label, wild: !!wild, over:false,
           seed: seed, rand: api.rng("battle:"+seed), ai: api.rng("ai:"+seed)};
  P.preload(a.concat(b));
  b.forEach(seen);
  root.textContent = "";
  var head = api.mk("div", "vg-row");
  head.appendChild(api.mk("span", "vg-muted", wild ? "Today's wild team · 3 Pokémon" : "vs "+label));
  root.appendChild(head);
  var sc = fight.scene = new P.Scene(root, {
    runLabel: "RUN",
    onMove: function(i){ choose({k:"move", i:i}); },
    onSwitch: function(i){ if(sc.mode === "replace") replaceMine(i); else choose({k:"switch", to:i}); },
    onRun: function(){ run(); }
  });
  if(fight.paused) sc.pause();
  sc.setView(view());
  var foe = b[0];
  sc.intro([who(1, foe.name, true)+"!", "Go! "+a[0].name+"!"]).then(function(){ prompt(); });
}
function prompt(){
  if(!fight || fight.over) return;
  var P = pk(), s = fight.state;
  if(P.needsReplace(s).indexOf(0) >= 0) fight.scene.setMode("replace");
  else fight.scene.setMode("main");
}
function choose(act){
  if(!fight || fight.over || fight.scene.busy) return;
  var P = pk(), s = fight.state, sc = fight.scene;
  var mine = P.legal(s, 0, act); if(!mine) return;
  var foe = P.aiAct(s, 1, fight.ai);
  var events = P.resolveTurn(s, mine, foe, fight.rand);
  sc.play(events, 0, who).then(afterTurn);
}
function afterTurn(){
  if(!fight || fight.scene.dead) return;
  var P = pk(), s = fight.state, sc = fight.scene;
  if(s.over) return end(s.winner === 0);
  // The foe sends in its next Pokemon by itself; you pick yours.
  if(P.needsReplace(s).indexOf(1) >= 0){
    var next = P.alive(s, 1)[0], ev = P.replace(s, 1, next);
    seen(s.sides[1].team[next]);
    return sc.play(ev, 0, who).then(function(){ sc.setView(view()); prompt(); });
  }
  sc.setView(view());
  prompt();
}
function replaceMine(i){
  var P = pk(), s = fight.state, sc = fight.scene;
  if(!P.legal(s, 0, {k:"switch", to:i})) return;
  var ev = P.replace(s, 0, i);
  sc.play(ev, 0, who).then(afterTurn);
}
function run(){
  if(!fight || fight.over || fight.scene.busy) return;
  var sc = fight.scene;
  fight.over = true;
  sc.setMode("busy");
  sc.say(fight.wild ? "Got away safely!" : "You left the battle.").then(function(){ finishScreen(null); });
}
function end(won){
  fight.over = true;
  var b = api.save.battle; b.wins = (b.wins|0)+(won ? 1 : 0); b.losses = (b.losses|0)+(won ? 0 : 1);
  var lines = [won ? "You won the battle!" : "Your team fainted. They'll be fine after a rest."];
  if(won && fight.wild && b.wildDay !== api.day()){ b.wildDay = api.day(); api.inv.add("shell", 1); lines.push("Daily win! You found a Bug Shell."); }
  api.persist();
  if(won && api.inArenaRoom() && !fight.wild) api.say({g:"battle", op:"result", won:true, vs:fight.label.slice(0,40)});
  var sc = fight.scene;
  lines.reduce(function(p, l){ return p.then(function(){ return sc.say(l, 900); }); }, Promise.resolve())
    .then(function(){ finishScreen(won); });
}
function finishScreen(won){
  if(!fight || !fight.scene || fight.scene.dead) return;
  var label = fight.label, wild = fight.wild, foes = fight.foeSpecs;
  fight.scene.setMode("over", [
    {label:"Back to battles", primary:true, fn:function(){ fight.scene.destroy(); fight = null; render(); }},
    {label:"Rematch", fn:function(){ fight.scene.destroy(); var f = foes; fight = null; begin(f, label, wild); }}
  ]);
}
function startWild(){ var mine = mySpecs(); if(!pk()){ api.toast("Battle data is still loading"); return; } var f = wildSpecs(mine); begin(f, "the wild team", true); if(fight) fight.foeSpecs = f; }
function startFriend(name){ var f = challengers[name]; begin(f, name, false); if(fight) fight.foeSpecs = f; }

function render(){
  if(!root || fight || building) return;
  root.textContent = "";
  var b = api.save.battle, P = pk();
  var rec = api.mk("p", "vg-muted", "Record: "+(b.wins|0)+" wins, "+(b.losses|0)+" losses · Seen "+((b.seen||[]).length)+" Pokémon. " +
    "Real moves, stats and types; your creatures battle as the Pokémon they are right now.");
  root.appendChild(rec);
  var row = api.mk("div", "vg-row");
  row.appendChild(api.btn("Battle today’s wild team", "primary", startWild));
  if(api.inArenaRoom()) row.appendChild(api.btn("Share my team in this room", "", function(){
    var t = mySpecs().map(function(s){ return {sp:s.sp, st:s.st, br:s.br, mg:s.mg, sh:s.sh ? 1 : 0, n:s.name}; });
    if(api.say({g:"battle", op:"team", team:t})) api.toast("Team shared with the room"); }));
  root.appendChild(row);
  if(P){
    var mt = myTeam(), team = mt.specs.map(P.buildMon), list = api.mk("div", "pkb-roster");
    var th = api.mk("div", "vg-row pkb-teamhead");
    th.appendChild(api.mk("b", null, mt.saved ? "Your saved team" : "Your team: your working and idle sessions"));
    th.appendChild(api.btn(mt.saved ? "Edit team" : "Pick a team", "", openBuilder));
    root.appendChild(th);
    team.forEach(function(m){
      var c = api.mk("div", "pkb-rcard");
      c.appendChild(api.mk("b", null, m.name+" · Lv"+m.lvl));
      var types = api.mk("span", "pkb-types"); m.types.forEach(function(t){ var x = api.mk("span", "pkb-type", t); x.style.background = "hsl("+((window.POKE_TYPE_HUE||{})[t]||220)+",60%,42%)"; types.appendChild(x); });
      c.appendChild(types);
      c.appendChild(api.mk("span", "vg-muted", m.moves.map(function(x){ return P.data().moves[x.id].name; }).join(" · ")));
      list.appendChild(c);
    });
    if(team.length) root.appendChild(list);
  }
  var names = Object.keys(challengers);
  if(names.length){
    var cl = api.mk("div", "vg-row"); cl.appendChild(api.mk("span", null, "Challengers: "));
    names.forEach(function(n){ cl.appendChild(api.btn(n, "", function(){ startFriend(n); })); });
    root.appendChild(cl);
  } else if(api.inArenaRoom()) root.appendChild(api.mk("p", "vg-muted", "When friends in this room share their teams, they show up here as challengers."));
  else root.appendChild(api.mk("p", "vg-muted", "Join an Arena room to battle friends' teams, or play a live Creature Duel."));
}
game.onSay = function(d, who){
  if(d.op === "team" && Array.isArray(d.team)){
    var P = pk(); if(!P) return;
    var clean = d.team.slice(0,6).map(function(m){ return P.cleanSpec(m); }).filter(Boolean);
    if(clean.length){ challengers[String(who).slice(0,40)] = clean; if(root && !fight) render(); }
  } else if(d.op === "result" && d.won){ api && api.toast("⚔️ "+who+" won a battle against "+(typeof d.vs === "string" ? d.vs.slice(0,40) : "a team")); }
};
game.badge = function(){ var n = Object.keys(challengers).length; return n ? n+" challenger"+(n>1?"s":"") : ""; };
function openBuilder(){
  var P = pk(); if(!P || !root || fight) return;
  root.textContent = "";
  root.appendChild(api.mk("p", "vg-muted", "Pick up to 6 of the Pokémon you've unlocked in the Pokédex. They battle at the highest stage you've reached, with their real moves."));
  building = true;
  P.teamBuilder(root, {onDone: function(){ building = false; render(); }});
}
var building = false;
game.mount = function(el, a){ api = a; root = el; fight = null; building = false; render();
  var P = pk(); if(P && P.loadUnlocked) P.loadUnlocked().then(function(){ if(root === el && !fight && !building) render(); }); };
game.unmount = function(){ if(fight && fight.scene) fight.scene.destroy(); root = null; fight = null; building = false; };
game.pause = function(){ if(fight){ fight.paused = true; if(fight.scene) fight.scene.pause(); } };
game.resume = function(){ if(fight){ fight.paused = false; if(fight.scene) fight.scene.resume(); } };
HQV.register(game);
if(HQV.api) api = HQV.api;
})();
