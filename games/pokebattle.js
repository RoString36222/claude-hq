/* Valley: Pokemon-style battle engine + battle screen, shared by Creature Battles (solo,
 * games/battle.js) and the live Creature Duel (games/multi.js).
 *
 * Data: window.HQV_POKEDATA from games/pokedata.js (Pokemon Showdown, MIT): real types,
 * base stats and level-up moves for every Pokemon a creature can become. A creature maps to
 * a Pokemon by (species index, evolution stage) exactly like the sprite packs do; its stage
 * also sets the battle level (8/18/30/42/55).
 *
 * The engine (HQV.pk.resolveTurn and friends) is pure and mirrors backend/app/pokebattle.py
 * line for line: both draw randomness only through rng() in the same order, so a duel the
 * server referees plays out exactly like a solo battle would. Keep the two in step;
 * tests/test_pokebattle_parity.py runs both on the same random stream.
 *
 * The screen (HQV.pk.Scene) is a DS-style battle view: foe front sprite top-right, yours
 * from the back bottom-left, HP plates, a typewriter text box, FIGHT/TEAM/RUN menus and a
 * 2x2 move grid with PP. Animations (lunges, hit flashes, HP drains, type-coloured effects
 * on one canvas) are skipped under Calm or reduced motion; every animation also writes a
 * text line, so nothing is animation-only.
 */
(function(){
"use strict";
var G = typeof window !== "undefined" ? window : globalThis;
var HQV = G.HQV = G.HQV || {};
var pk = HQV.pk = {};
function D(){ return G.HQV_POKEDATA || null; }
pk.data = D;

/* =============================== ENGINE =============================== */
var STATS = ["atk","def","spa","spd","spe"], BOOSTS = ["atk","def","spa","spd","spe","accuracy","evasion"];
var CRIT_CHANCE = {1:1/24, 2:1/8, 3:1/2};
var STATUS_IMMUNE = {par:["Electric"], brn:["Fire"], psn:["Poison","Steel"], tox:["Poison","Steel"], slp:[]};
function isInt(v){ return typeof v === "number" && isFinite(v) && Math.floor(v) === v; }
function halfUp(x){ return Math.floor(x + 0.5); }
function evoPos(stage, len){ return Math.max(0, Math.min(len-1, halfUp(stage/4*(len-1)))); }
function effOne(atk, def){ var r = D().chart[atk]; return r && r[def] != null ? r[def] : 1; }
function typeMult(mt, types){ var m = 1; for(var i=0;i<types.length;i++) m *= effOne(mt, types[i]); return m; }
function calcStat(base, lvl, hp){ var core = Math.floor((2*base+31)*lvl/100); return hp ? core+lvl+10 : core+5; }
function zeroBoosts(){ var b = {}; BOOSTS.forEach(function(k){ b[k] = 0; }); return b; }
pk.evoPos = evoPos; pk.typeMult = typeMult; pk.calcStat = calcStat;

// One creature as a client may describe it: {sp, st, br, mg, sh, name}. Anything else is dropped.
pk.cleanSpec = function(raw){
  if(!raw || typeof raw !== "object") return null;
  var sp = raw.sp, st = raw.st;
  if(!isInt(sp) || sp < 0 || sp >= D().lines.length || !isInt(st)) return null;
  st = Math.max(0, Math.min(4, st));     // a stage outside 0..4 is clamped, never trusted
  var name = typeof raw.name === "string" ? raw.name : (typeof raw.n === "string" ? raw.n : "");
  name = name.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 24);
  return {sp:sp, st:st, br: isInt(raw.br) ? raw.br : null, mg: typeof raw.mg === "string" ? raw.mg : null,
          sh: raw.sh === true || raw.sh === 1, name:name};
};
// Everything about a battler, derived from (species, stage) and the vendored data only.
pk.buildMon = function(spec){
  var d = D(), line = d.lines[spec.sp], pos = evoPos(spec.st, line.length), dex = line[pos], mega = null;
  if(pos === line.length-1){
    var opts = d.branches[String(spec.sp)];
    if(opts) dex = opts.indexOf(spec.br) >= 0 ? spec.br : opts[0];
    if(spec.st === 4 && (d.megaFor[String(dex)]||[]).indexOf(spec.mg) >= 0) mega = spec.mg;
  }
  var pid = mega ? d.megas[mega] : d.byDex[String(dex)], e = d.pokemon[pid], lvl = d.levels[spec.st];
  var stats = {hp: calcStat(e.bs.hp, lvl, true)};
  STATS.forEach(function(s){ stats[s] = calcStat(e.bs[s], lvl, false); });
  return {name:e.name, id:pid, dex:dex, sprite: e.sprite != null ? e.sprite : null, mega:mega, shiny: !!spec.sh,
    sp:spec.sp, st:spec.st, lvl:lvl, types:e.types.slice(), stats:stats, hp:stats.hp, max:stats.hp,
    status:null, slp:0, tox:0, flinch:false, boosts:zeroBoosts(),
    moves: e.moves[String(lvl)].map(function(m){ return {id:m, pp:d.moves[m].pp, max:d.moves[m].pp}; })};
};
pk.newBattle = function(a, b){ return {sides:[{team:a, active:0},{team:b, active:0}], turn:1, over:false, winner:null}; };
function active(s, side){ var x = s.sides[side]; return x.team[x.active]; }
function alive(s, side){ var out = []; s.sides[side].team.forEach(function(m, i){ if(m.hp > 0) out.push(i); }); return out; }
pk.active = active; pk.alive = alive;
pk.needsReplace = function(s){
  if(s.over) return [];
  return [0,1].filter(function(i){ return active(s, i).hp <= 0 && alive(s, i).length; });
};
pk.legal = function(s, side, act){
  if(s.over || !act || typeof act !== "object") return null;
  var sd = s.sides[side], mon = sd.team[sd.active];
  if(act.k === "switch"){
    var to = act.to;
    return isInt(to) && to >= 0 && to < sd.team.length && to !== sd.active && sd.team[to].hp > 0 ? {k:"switch", to:to} : null;
  }
  if(mon.hp <= 0) return null;
  if(mon.moves.every(function(m){ return m.pp <= 0; })) return (act.k === "move" || act.k === "struggle") ? {k:"struggle"} : null;
  var i = act.i;
  return act.k === "move" && isInt(i) && i >= 0 && i < mon.moves.length && mon.moves[i].pp > 0 ? {k:"move", i:i} : null;
};
pk.autoAct = function(s, side){
  var mon = active(s, side);
  for(var i=0;i<mon.moves.length;i++) if(mon.moves[i].pp > 0) return {k:"move", i:i};
  return {k:"struggle"};
};
function stageStat(stat, s){ return Math.floor(stat*Math.max(2, 2+s)/Math.max(2, 2-s)); }
function speed(mon){ var v = stageStat(mon.stats.spe, mon.boosts.spe); return mon.status === "par" ? Math.floor(v/2) : v; }
pk.speed = speed;
// [damage, type multiplier] with the main-series formula; roll is 85..100.
pk.damage = function(att, def, move, crit, roll){
  var mult = move.type === "???" ? 1 : typeMult(move.type, def.types);
  if(mult === 0) return [0, 0];
  if(move.fixed === "level") return [att.lvl, mult];
  var phys = move.cat === "physical", ak = phys ? "atk" : "spa", dk = phys ? "def" : "spd";
  var ab = att.boosts[ak], db = def.boosts[dk];
  if(crit){ ab = Math.max(0, ab); db = Math.min(0, db); }
  var a = stageStat(att.stats[ak], ab), d = stageStat(def.stats[dk], db);
  var base = Math.floor(Math.floor((Math.floor(2*att.lvl/5)+2)*move.bp*a/d)/50) + 2;
  if(crit) base = Math.floor(base*1.5);
  base = Math.floor(base*roll/100);
  if(att.types.indexOf(move.type) >= 0) base = Math.floor(base*1.5);
  base = Math.floor(base*mult);
  if(phys && att.status === "brn") base = Math.floor(base*0.5);
  return [Math.max(1, base), mult];
};

function Turn(s, rng){ this.s = s; this.rng = rng; this.ev = []; this.moved = [false, false]; }
Turn.prototype.mon = function(side){ return active(this.s, side); };
Turn.prototype.doSwitch = function(side, to){
  var old = this.mon(side);
  old.boosts = zeroBoosts(); old.flinch = false; if(old.status === "tox") old.tox = 0;
  this.s.sides[side].active = to;
  this.ev.push({t:"switch", side:side, slot:to, name:this.mon(side).name});
};
Turn.prototype.boosts = function(side, boosts){
  var mon = this.mon(side), self = this;
  BOOSTS.forEach(function(stat){
    if(boosts[stat] == null) return;
    var want = boosts[stat], cur = mon.boosts[stat], nw = Math.max(-6, Math.min(6, cur+want));
    mon.boosts[stat] = nw;
    self.ev.push({t:"boost", side:side, name:mon.name, stat:stat, n:nw-cur, want:want});
  });
};
Turn.prototype.setStatus = function(side, status, primary){
  var mon = this.mon(side);
  if(mon.status || STATUS_IMMUNE[status].some(function(t){ return mon.types.indexOf(t) >= 0; })){
    if(primary) this.ev.push({t:"fail", side:side, name:mon.name, why: mon.status ? "already" : "immune", s:mon.status});
    return;
  }
  mon.status = status;
  if(status === "slp") mon.slp = 1 + Math.floor(this.rng()*3);
  if(status === "tox") mon.tox = 0;
  this.ev.push({t:"status", side:side, name:mon.name, s:status});
};
Turn.prototype.heal = function(side, amount, why){
  var mon = this.mon(side); mon.hp = Math.min(mon.max, mon.hp+amount);
  this.ev.push({t:"heal", side:side, name:mon.name, hp:mon.hp, max:mon.max, why:why});
};
Turn.prototype.hurt = function(side, amount, why){
  var mon = this.mon(side); mon.hp = Math.max(0, mon.hp-amount);
  this.ev.push({t:"residual", side:side, name:mon.name, hp:mon.hp, max:mon.max, why:why});
  if(mon.hp <= 0) this.ev.push({t:"faint", side:side, name:mon.name});
};
Turn.prototype.useMove = function(side, act){
  var user = this.mon(side), foe = 1-side, M = D().moves;
  if(user.hp <= 0) return;
  if(user.status === "slp"){
    if(user.slp > 0){ user.slp -= 1; this.ev.push({t:"cant", side:side, name:user.name, why:"slp"}); return; }
    user.status = null; this.ev.push({t:"cure", side:side, name:user.name, s:"slp"});
  }
  if(user.flinch){ this.ev.push({t:"cant", side:side, name:user.name, why:"flinch"}); return; }
  if(user.status === "par" && this.rng() < 0.25){ this.ev.push({t:"cant", side:side, name:user.name, why:"par"}); return; }
  var mid;
  if(act.k === "struggle") mid = "struggle";
  else { var slot = user.moves[act.i]; slot.pp -= 1; mid = slot.id; }
  var mv = M[mid];
  this.ev.push({t:"move", side:side, name:user.name, move:mid});
  var targetSelf = mv.self === 1, tgt = this.mon(foe);
  if(!targetSelf && tgt.hp <= 0){ this.ev.push({t:"fail", side:side, name:user.name, why:"notarget"}); return; }
  if(!targetSelf && mv.acc > 0){
    var st = Math.max(-6, Math.min(6, user.boosts.accuracy - tgt.boosts.evasion));
    var num = st >= 0 ? 3+st : 3, den = st >= 0 ? 3 : 3-st;
    if(!(this.rng()*100 < mv.acc*num/den)){ this.ev.push({t:"miss", side:foe, name:user.name}); return; }
  }
  if(mv.cat === "status"){
    if(mv.heal){
      if(user.hp >= user.max) this.ev.push({t:"fail", side:side, name:user.name, why:"fullhp"});
      else this.heal(side, halfUp(user.max*mv.heal[0]/mv.heal[1]), "move");
    } else if(mv.boosts) this.boosts(targetSelf ? side : foe, mv.boosts);
    else if(mv.status) this.setStatus(foe, mv.status, true);
    return;
  }
  var cs = mv.crit || 1, fixed = mv.fixed === "level";
  var crit = !fixed && (cs >= 4 || this.rng() < CRIT_CHANCE[cs]);
  var roll = !fixed ? 85 + Math.floor(this.rng()*16) : 100;
  var r = pk.damage(user, tgt, mv, crit, roll), dmg = r[0], mult = r[1];
  if(mult === 0){ this.ev.push({t:"immune", side:foe, name:tgt.name}); return; }
  var dealt = Math.min(dmg, tgt.hp);
  tgt.hp -= dealt;
  this.ev.push({t:"dmg", side:foe, name:tgt.name, hp:tgt.hp, max:tgt.max, eff:mult, crit:crit, move:mid});
  if(tgt.hp <= 0) this.ev.push({t:"faint", side:foe, name:tgt.name});
  if(mv.drain && user.hp < user.max) this.heal(side, Math.max(1, halfUp(dealt*mv.drain[0]/mv.drain[1])), "drain");
  var sec = mv.sec;
  if(sec && this.rng()*100 < sec.chance){
    if(tgt.hp > 0){
      if(sec.status) this.setStatus(foe, sec.status, false);
      if(sec.boosts) this.boosts(foe, sec.boosts);
      if(sec.volatileStatus === "flinch" && !this.moved[foe]) tgt.flinch = true;
    }
    if(sec.self) this.boosts(side, sec.self.boosts);
  }
  if(mv.struggle) this.hurt(side, Math.max(1, halfUp(user.max/4)), "recoil");
  else if(mv.recoil) this.hurt(side, Math.max(1, halfUp(dealt*mv.recoil[0]/mv.recoil[1])), "recoil");
};
Turn.prototype.order = function(acts){
  var self = this, M = D().moves;
  function key(side){
    var a = acts[side];
    if(a.k === "switch") return [1, 0, speed(self.mon(side))];
    var mid = a.k === "struggle" ? "struggle" : self.mon(side).moves[a.i].id;
    return [0, M[mid].pri, speed(self.mon(side))];
  }
  var k0 = key(0), k1 = key(1);
  for(var i=0;i<3;i++) if(k0[i] !== k1[i]) return k0[i] > k1[i] ? [0,1] : [1,0];
  return this.rng() < 0.5 ? [0,1] : [1,0];
};
Turn.prototype.endOfTurn = function(){
  for(var side=0; side<2; side++){
    var mon = this.mon(side);
    if(mon.hp <= 0) continue;
    if(mon.status === "brn") this.hurt(side, Math.max(1, Math.floor(mon.max/16)), "brn");
    else if(mon.status === "psn") this.hurt(side, Math.max(1, Math.floor(mon.max/8)), "psn");
    else if(mon.status === "tox"){ mon.tox = Math.min(15, mon.tox+1); this.hurt(side, Math.max(1, Math.floor(mon.max*mon.tox/16)), "tox"); }
  }
  this.mon(0).flinch = false; this.mon(1).flinch = false;
};
function finish(s, ev){
  var a = alive(s, 0).length > 0, b = alive(s, 1).length > 0;
  if(!(a && b)){ s.over = true; s.winner = a ? 0 : b ? 1 : null; ev.push({t:"end", winner:s.winner}); }
}
// Both sides' (already legal) actions -> ordered events; mutates the state.
pk.resolveTurn = function(s, actA, actB, rng){
  var t = new Turn(s, rng), acts = [actA, actB];
  t.order(acts).forEach(function(side){
    var a = acts[side];
    if(a.k === "switch") t.doSwitch(side, a.to); else t.useMove(side, a);
    t.moved[side] = true;
  });
  t.endOfTurn();
  s.turn += 1;
  finish(s, t.ev);
  return t.ev;
};
pk.replace = function(s, side, slot){ var t = new Turn(s, function(){ return 0; }); t.doSwitch(side, slot); return t.ev; };
// Foe AI for solo battles: the move with the best expected damage, sometimes a random one.
pk.aiAct = function(s, side, rand){
  rand = rand || Math.random;
  var me = active(s, side), foe = active(s, 1-side), M = D().moves, best = -1, bi = -1, usable = [];
  me.moves.forEach(function(m, i){
    if(m.pp <= 0) return; usable.push(i);
    var mv = M[m.id], v = mv.cat === "status" ? 8 : (mv.fixed ? me.lvl : mv.bp) * (me.types.indexOf(mv.type) >= 0 ? 1.5 : 1) *
      typeMult(mv.type, foe.types) * (mv.acc ? mv.acc/100 : 1);
    if(v > best){ best = v; bi = i; }
  });
  if(!usable.length) return {k:"struggle"};
  if(rand() < 0.2) bi = usable[Math.floor(rand()*usable.length)];
  return {k:"move", i:bi};
};

/* ---------- text for events (shared by solo + duel) ---------- */
var STAT_NAME = {atk:"Attack", def:"Defense", spa:"Sp. Atk", spd:"Sp. Def", spe:"Speed", accuracy:"accuracy", evasion:"evasiveness"};
var STATUS_TXT = {par:"was paralyzed! It may be unable to move!", brn:"was burned!", psn:"was poisoned!", tox:"was badly poisoned!", slp:"fell asleep!"};
var STATUS_SHORT = {par:"PAR", brn:"BRN", psn:"PSN", tox:"TOX", slp:"SLP"};
pk.STATUS_SHORT = STATUS_SHORT;
// who(side, name) lets the caller say "The wild Pikachu" / "The foe's Pikachu" / "Pikachu".
pk.text = function(ev, who){
  who = who || function(side, n){ return n; };
  var n = ev.name, M = D().moves;
  switch(ev.t){
    case "switch": return null;
    case "move": return who(ev.side, n)+" used "+M[ev.move].name+"!";
    case "cant": return ev.why === "slp" ? who(ev.side, n)+" is fast asleep." : ev.why === "par" ? who(ev.side, n)+" is paralyzed! It can't move!" : who(ev.side, n)+" flinched and couldn't move!";
    case "cure": return who(ev.side, n)+" woke up!";
    case "miss": return who(1-ev.side, n)+"'s attack missed!";
    case "fail": return ev.why === "notarget" ? "But there was no target..." : ev.why === "fullhp" ? who(ev.side, n)+"'s HP is full!" :
      ev.why === "already" ? who(ev.side, n)+" is already "+({par:"paralyzed",brn:"burned",psn:"poisoned",tox:"poisoned",slp:"asleep"}[ev.s]||"affected")+"!" : "It doesn't affect "+who(ev.side, n)+"...";
    case "immune": return "It doesn't affect "+who(ev.side, n)+"...";
    case "dmg": return [ev.crit ? "A critical hit!" : null, ev.eff > 1 ? "It's super effective!" : ev.eff < 1 ? "It's not very effective..." : null].filter(Boolean).join(" ") || null;
    case "heal": return ev.why === "drain" ? who(ev.side, n)+" had its energy drained!" : who(ev.side, n)+" regained health!";
    case "status": return who(ev.side, n)+" "+STATUS_TXT[ev.s];
    case "boost":
      var st = STAT_NAME[ev.stat]||ev.stat;
      if(ev.n === 0) return who(ev.side, n)+"'s "+st+" won't go any "+(ev.want > 0 ? "higher" : "lower")+"!";
      var a = Math.abs(ev.n);
      return who(ev.side, n)+"'s "+st+(ev.n > 0 ? (a >= 3 ? " rose drastically!" : a === 2 ? " rose sharply!" : " rose!") : (a >= 3 ? " severely fell!" : a === 2 ? " harshly fell!" : " fell!"));
    case "residual": return ev.why === "recoil" ? who(ev.side, n)+" was damaged by the recoil!" : who(ev.side, n)+" was hurt by its "+(ev.why === "brn" ? "burn" : "poison")+"!";
    case "faint": return who(ev.side, n)+" fainted!";
    default: return null;
  }
};

if(typeof document === "undefined") return;   // node (tests): engine only

/* =============================== SCREEN =============================== */
function mk(tag, cls, text){ var n = document.createElement(tag); if(cls) n.className = cls; if(text != null) n.textContent = String(text); return n; }
function calm(){
  var de = document.documentElement;
  return de.classList.contains("hq-calm") || !!(G.matchMedia && G.matchMedia("(prefers-reduced-motion: reduce)").matches);
}
function hueOf(t){ var H = G.POKE_TYPE_HUE || {}; return H[t] != null ? H[t] : 220; }
function chip(t){ var c = mk("span", "pkb-type", t); c.style.background = "hsl("+hueOf(t)+",60%,42%)"; return c; }
function packIsPoke(){ try { return typeof G.isPokePack === "function" ? G.isPokePack() : true; } catch(e){ return true; } }
function pack(){ try { return (G.cfg && G.cfg().creaturePack) || "pokemon"; } catch(e){ return "pokemon"; } }
function sleep(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }

// Sprite candidates, best first. Only the page's existing sprite hosts are used.
function spriteUrls(mon, back){
  var A = G.POKE_ANIM, S = G.POKE_STATIC, out = [], sh = mon.shiny;
  if(!A || !S) return out;
  var slug = (mon.mega || String(mon.name||"").toLowerCase().replace(/[^a-z0-9]/g, ""));
  var oras = false;
  if(mon.mega && G.MEGA_FORMS){ (G.MEGA_FORMS[mon.dex]||[]).forEach(function(f){ if(f.slug === mon.mega && f.dir === "oras") oras = true; }); }
  if(pack() === "pokemon3d" && G.PKPARAISO_XY){
    var base = oras ? (sh ? G.PKPARAISO_ORAS_SHINY : G.PKPARAISO_ORAS) : (sh ? G.PKPARAISO_XY_SHINY : G.PKPARAISO_XY);
    if(base){ out.push({u: back ? base.replace("/animados", "/animados-espalda") : base, f: slug+".gif", d3:true}); }
  }
  if(mon.sprite){
    var sd = S+"other/showdown/";
    out.push({u: sd+(back?"back/":"")+(sh?"shiny/":""), f: mon.sprite+".gif"});
    if(back) out.push({u: sd+(sh?"shiny/":""), f: mon.sprite+".gif", flip:true});
  }
  out.push({u: A+(back?"back/":"")+(sh?"shiny/":""), f: mon.dex+".gif"});
  out.push({u: S+(back?"back/":"")+(sh?"shiny/":""), f: mon.dex+".png"});
  if(back) out.push({u: A+(sh?"shiny/":""), f: mon.dex+".gif", flip:true});
  return out;
}
// Warm the image cache so a send-out never pops in late (first candidate of each side).
pk.preload = function(mons){
  if(!packIsPoke() || typeof Image === "undefined") return;
  (mons || []).forEach(function(m){
    [false, true].forEach(function(back){ var u = spriteUrls(m, back)[0]; if(u){ var im = new Image(); im.decoding = "async"; im.src = u.u + u.f; } });
  });
};
function creatureBox(mon, px){
  var box = mk("div", "pkb-cre");
  if(typeof G.paintCreature === "function"){
    try { G.paintCreature(box, {species:mon.sp, stage:mon.st, shiny:mon.shiny, _noFloor:true}, px, false); } catch(e){}
  }
  return box;
}
function spriteEl(mon, back, scene){
  var wrap = mk("div", "pkb-spr"+(back ? " back" : " front"));
  wrap.setAttribute("aria-hidden", "true");
  var urls = packIsPoke() ? spriteUrls(mon, back) : [];
  if(!urls.length){
    var cb = creatureBox(mon, back ? 120 : 96); if(back) cb.classList.add("flip");
    wrap.appendChild(cb); return wrap;
  }
  var img = mk("img"), k = 0;
  img.alt = ""; img.decoding = "async"; img.draggable = false;
  function tryNext(){
    if(k >= urls.length){ img.remove(); var cb = creatureBox(mon, back ? 120 : 96); if(back) cb.classList.add("flip"); wrap.appendChild(cb); return; }
    var c = urls[k++];
    img.classList.toggle("flip", !!c.flip); img.classList.toggle("d3", !!c.d3);
    img.src = c.u + c.f;
  }
  img.addEventListener("error", tryNext);
  img.addEventListener("load", function(){
    // Pixel sprites scale up crisply; the 3D ones are already large.
    var w = (scene && scene.scene.clientWidth) || 600, base = img.classList.contains("d3") ? 0.95 : (back ? 2.6 : 2.1);
    var s = base * Math.max(0.55, Math.min(1.25, w/640));
    img.style.width = Math.round(img.naturalWidth*s)+"px";
  });
  tryNext();
  wrap.appendChild(img);
  return wrap;
}

/* ---------- canvas effects ---------- */
function Fx(canvas){ this.c = canvas; this.g = canvas.getContext("2d"); this.raf = 0; }
Fx.prototype.size = function(){
  var r = this.c.getBoundingClientRect(), dpr = G.devicePixelRatio || 1;
  var w = Math.max(1, Math.round(r.width*dpr)), h = Math.max(1, Math.round(r.height*dpr));
  if(this.c.width !== w || this.c.height !== h){ this.c.width = w; this.c.height = h; }
  this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return {w:r.width, h:r.height};
};
// Runs draw(g, t 0..1, size) for ms, then clears. Resolves when done.
Fx.prototype.run = function(ms, draw){
  var self = this;
  // A hidden tab gets no animation frames: skip the effect rather than stall the turn queue.
  if(typeof document !== "undefined" && document.hidden) return Promise.resolve();
  return new Promise(function(res){
    var t0 = 0, sz = self.size();
    function frame(now){
      if(!t0) t0 = now;
      var t = Math.min(1, (now - t0)/ms);
      self.g.clearRect(0, 0, sz.w, sz.h);
      draw(self.g, t, sz);
      if(t < 1) self.raf = requestAnimationFrame(frame);
      else { self.g.clearRect(0, 0, sz.w, sz.h); res(); }
    }
    self.raf = requestAnimationFrame(frame);
  });
};
function col(h, s, l, a){ return "hsla("+h+","+s+"%,"+l+"%,"+(a == null ? 1 : a)+")"; }
function seeded(i){ var x = Math.sin(i*12.9898)*43758.5453; return x - Math.floor(x); }
function star(g, x, y, r, n){ g.beginPath(); for(var i=0;i<n*2;i++){ var a = i*Math.PI/n, rr = i%2 ? r*0.45 : r; g.lineTo(x+Math.cos(a)*rr, y+Math.sin(a)*rr); } g.closePath(); g.fill(); }
// One burst per type, drawn at (x, y) for progress t. Original shapes, coloured by type hue.
function burst(g, type, x, y, t, R){
  var h = hueOf(type), e = 1 - Math.pow(1-t, 2), fade = 1 - t, i, a, d;
  g.save();
  switch(type){
    case "Fire":
      for(i=0;i<16;i++){ a = seeded(i)*Math.PI*2; d = R*0.3 + seeded(i+9)*R*0.5;
        g.fillStyle = col(20+seeded(i+3)*25, 95, 55, fade); var ex = x+Math.cos(a)*d*e*0.6, ey = y - e*R*(0.4+seeded(i+5)*0.8) + Math.sin(a)*d*0.3;
        g.beginPath(); g.arc(ex, ey, 3+seeded(i+7)*4*(1-t*0.6), 0, Math.PI*2); g.fill(); }
      g.fillStyle = col(30, 100, 60, 0.35*fade); g.beginPath(); g.arc(x, y, R*0.5*(0.6+0.4*Math.sin(t*30)), 0, Math.PI*2); g.fill(); break;
    case "Water":
      g.strokeStyle = col(h, 80, 65, fade); g.lineWidth = 3;
      for(i=0;i<3;i++){ g.beginPath(); g.ellipse(x, y+R*0.3, R*(0.2+e*0.8)*(1-i*0.25), R*(0.08+e*0.25)*(1-i*0.25), 0, 0, Math.PI*2); g.stroke(); }
      for(i=0;i<10;i++){ a = -Math.PI*(0.15+seeded(i)*0.7); d = e*R*(0.5+seeded(i+2)*0.6);
        g.fillStyle = col(h, 85, 70, fade); g.beginPath(); g.arc(x+Math.cos(a)*d, y+Math.sin(a)*d + t*t*R*0.6, 3.5, 0, Math.PI*2); g.fill(); } break;
    case "Electric":
      g.strokeStyle = col(h, 100, 60, fade); g.lineWidth = 3; g.shadowColor = col(h, 100, 70, 1); g.shadowBlur = 8;
      for(i=0;i<3;i++){ a = (i/3)*Math.PI*2 + t*2; g.beginPath(); g.moveTo(x, y);
        for(var s=1;s<=5;s++){ var rr = s/5*R*(0.4+e*0.7); g.lineTo(x+Math.cos(a)*rr + (s%2?8:-8)*Math.sin(a), y+Math.sin(a)*rr + (s%2?-8:8)*Math.cos(a)); } g.stroke(); }
      if(t < 0.25){ g.fillStyle = col(h, 100, 85, 0.5); g.fillRect(x-R, y-R, R*2, R*2); } break;
    case "Grass":
      for(i=0;i<12;i++){ a = i/12*Math.PI*2 + t*4; d = R*(0.2+e*0.8);
        g.fillStyle = col(h+seeded(i)*20, 65, 45, fade); g.save(); g.translate(x+Math.cos(a)*d, y+Math.sin(a)*d*0.7); g.rotate(a+t*6);
        g.beginPath(); g.ellipse(0, 0, 7, 3, 0, 0, Math.PI*2); g.fill(); g.restore(); } break;
    case "Ice":
      g.strokeStyle = col(h, 80, 85, fade); g.lineWidth = 2; g.beginPath(); g.arc(x, y, R*e, 0, Math.PI*2); g.stroke();
      for(i=0;i<10;i++){ a = i/10*Math.PI*2; d = R*e*0.8; g.fillStyle = col(h, 75, 80, fade);
        g.beginPath(); g.moveTo(x+Math.cos(a)*d, y+Math.sin(a)*d); g.lineTo(x+Math.cos(a+0.12)*(d-10), y+Math.sin(a+0.12)*(d-10)); g.lineTo(x+Math.cos(a-0.12)*(d-10), y+Math.sin(a-0.12)*(d-10)); g.fill(); } break;
    case "Fighting":
      g.strokeStyle = col(h, 85, 55, fade); g.lineWidth = 3;
      for(i=0;i<12;i++){ a = i/12*Math.PI*2; g.beginPath(); g.moveTo(x+Math.cos(a)*R*e*0.4, y+Math.sin(a)*R*e*0.4); g.lineTo(x+Math.cos(a)*R*e, y+Math.sin(a)*R*e); g.stroke(); }
      g.fillStyle = col(40, 100, 70, 0.5*fade); star(g, x, y, R*0.35*(1-t*0.5), 6); break;
    case "Poison":
      for(i=0;i<12;i++){ var bt = Math.min(1, t*1.6 - seeded(i)*0.6); if(bt <= 0) continue;
        var bx = x + (seeded(i+1)-0.5)*R*1.4, by = y + R*0.4 - bt*R*0.9;
        g.strokeStyle = col(h, 60, 60, 1-bt); g.lineWidth = 2; g.beginPath(); g.arc(bx, by, 3+bt*7, 0, Math.PI*2); g.stroke(); } break;
    case "Ground":
      for(i=0;i<8;i++){ g.fillStyle = col(h, 45, 45+seeded(i)*15, 0.6*fade); g.beginPath();
        g.arc(x+(i-3.5)*R*0.22, y+R*0.5 - e*R*(0.3+seeded(i)*0.5), R*0.18*(0.5+e), 0, Math.PI*2); g.fill(); }
      for(i=0;i<8;i++){ g.fillStyle = col(h, 35, 35, fade); g.fillRect(x+(seeded(i+4)-0.5)*R*1.6, y+R*0.5 - Math.sin(t*Math.PI)*R*(0.4+seeded(i)*0.6), 5, 5); } break;
    case "Flying":
      g.strokeStyle = col(h, 60, 85, fade); g.lineWidth = 2.5;
      for(i=0;i<5;i++){ var oy = (i-2)*R*0.25; g.beginPath(); g.moveTo(x-R*1.2 + e*R*0.8, y+oy); g.quadraticCurveTo(x, y+oy-R*0.3, x+R*0.2 + e*R*1.1, y+oy); g.stroke(); } break;
    case "Psychic":
      for(i=0;i<4;i++){ var pt = (t*1.5 + i*0.25) % 1; g.strokeStyle = col(h, 80, 70, (1-pt)*fade); g.lineWidth = 3;
        g.beginPath(); g.ellipse(x, y, R*pt, R*pt*0.7, 0, 0, Math.PI*2); g.stroke(); } break;
    case "Bug":
      for(i=0;i<18;i++){ a = seeded(i)*Math.PI*2 + t*(4+seeded(i+1)*4); d = R*(0.2+seeded(i+2)*0.7)*(0.5+0.5*Math.sin(t*Math.PI));
        g.fillStyle = col(h, 70, 40, fade); g.fillRect(x+Math.cos(a)*d, y+Math.sin(a)*d*0.8, 3, 3); } break;
    case "Rock":
      for(i=0;i<7;i++){ var rt = Math.min(1, Math.max(0, t*1.4 - seeded(i)*0.4)); g.fillStyle = col(h, 30, 40+seeded(i)*15, rt < 1 ? 1 : 0);
        var rx = x + (seeded(i+3)-0.5)*R*1.3, ry = y - R*1.2 + rt*R*1.3; g.beginPath(); g.moveTo(rx-7, ry); g.lineTo(rx-2, ry-8); g.lineTo(rx+7, ry-4); g.lineTo(rx+5, ry+6); g.lineTo(rx-5, ry+6); g.fill(); } break;
    case "Ghost":
      g.strokeStyle = col(h, 55, 65, fade); g.lineWidth = 4;
      for(i=0;i<4;i++){ g.beginPath(); for(var k=0;k<=20;k++){ var px2 = x - R + k/20*R*2, py = y + (i-1.5)*R*0.3 + Math.sin(k*0.6 + t*10 + i)*8*e;
        if(k === 0) g.moveTo(px2, py); else g.lineTo(px2, py); } g.stroke(); } break;
    case "Dragon":
      for(i=0;i<24;i++){ a = i*0.5 + t*8; d = (i/24)*R*e;
        g.fillStyle = i%2 ? col(h, 70, 60, fade) : col(h+40, 80, 55, fade); g.beginPath(); g.arc(x+Math.cos(a)*d, y+Math.sin(a)*d*0.8, 4, 0, Math.PI*2); g.fill(); } break;
    case "Dark":
      g.strokeStyle = col(h, 25, 25, fade); g.lineWidth = 6;
      g.beginPath(); g.arc(x - R*0.6 + e*R*0.4, y, R*0.8, -0.9, 0.9); g.stroke();
      g.strokeStyle = col(280, 30, 55, fade); g.lineWidth = 2; g.beginPath(); g.arc(x - R*0.6 + e*R*0.4, y, R*0.8, -0.9, 0.9); g.stroke(); break;
    case "Steel":
      g.strokeStyle = col(h, 20, 92, fade); g.lineWidth = 3; var L = R*Math.sin(t*Math.PI);
      g.beginPath(); g.moveTo(x-L, y); g.lineTo(x+L, y); g.moveTo(x, y-L); g.lineTo(x, y+L); g.stroke();
      g.lineWidth = 1.5; g.beginPath(); g.moveTo(x-L*0.6, y-L*0.6); g.lineTo(x+L*0.6, y+L*0.6); g.moveTo(x+L*0.6, y-L*0.6); g.lineTo(x-L*0.6, y+L*0.6); g.stroke(); break;
    case "Fairy":
      for(i=0;i<12;i++){ a = seeded(i)*Math.PI*2; d = R*(0.2+seeded(i+1)*0.8)*e;
        g.fillStyle = col(h, 80, 80, fade*(0.5+0.5*Math.sin(t*20+i))); star(g, x+Math.cos(a)*d, y+Math.sin(a)*d - t*10, 5, 4); } break;
    default:   // Normal, Struggle
      g.fillStyle = col(50, 30, 96, fade); star(g, x, y, R*0.55*(0.4+e), 5);
      g.strokeStyle = col(50, 30, 90, fade); g.lineWidth = 2;
      for(i=0;i<8;i++){ a = i/8*Math.PI*2; g.beginPath(); g.moveTo(x+Math.cos(a)*R*0.5*e, y+Math.sin(a)*R*0.5*e); g.lineTo(x+Math.cos(a)*R*e, y+Math.sin(a)*R*e); g.stroke(); }
  }
  g.restore();
}

/* ---------- the scene ---------- */
// opts: {onMove(i), onSwitch(slot), onRun(), runLabel, foeLabel(side,name)->text}
function Scene(host, opts){
  this.opts = opts || {};
  this.root = mk("div", "pkb"); this.root.tabIndex = -1;
  this.scene = mk("div", "pkb-scene");
  this.scene.appendChild(mk("div", "pkb-sky"));
  this.pads = {foe: mk("div", "pkb-pad foe"), me: mk("div", "pkb-pad me")};
  this.slots = {foe: mk("div", "pkb-slot foe"), me: mk("div", "pkb-slot me")};
  this.scene.appendChild(this.pads.foe); this.scene.appendChild(this.pads.me);
  this.scene.appendChild(this.slots.foe); this.scene.appendChild(this.slots.me);
  this.plates = {foe: this.plate("foe"), me: this.plate("me")};
  this.scene.appendChild(this.plates.foe.el); this.scene.appendChild(this.plates.me.el);
  this.canvas = mk("canvas", "pkb-fx"); this.canvas.setAttribute("aria-hidden", "true");
  this.scene.appendChild(this.canvas);
  this.fx = new Fx(this.canvas);
  this.root.appendChild(this.scene);
  var ui = mk("div", "pkb-ui");
  this.text = mk("div", "pkb-text"); this.text.setAttribute("aria-live", "polite"); this.text.setAttribute("role", "status");
  this.cmd = mk("div", "pkb-cmd");
  ui.appendChild(this.text); ui.appendChild(this.cmd);
  this.root.appendChild(ui);
  // Always-visible keyboard help (the keys work while the battle has focus).
  this.keysEl = mk("div", "pkb-keys"); this.root.appendChild(this.keysEl);
  this.logBox = mk("details", "pkb-log"); this.logBox.appendChild(mk("summary", null, "Battle log"));
  this.logList = mk("ol"); this.logBox.appendChild(this.logList);
  this.root.appendChild(this.logBox);
  host.appendChild(this.root);
  this.view = null; this.shown = {foe:null, me:null}; this.mode = "idle"; this.paused = false; this.skip = null; this.dead = false;
  var self = this;
  this.onKey = function(e){ self.key(e); };
  this.root.addEventListener("keydown", this.onKey);
  this.root.addEventListener("click", function(e){ if(e.target === self.text && self.skip) self.skip(); });
}
pk.Scene = Scene;
pk.spriteEl = spriteEl; pk.spriteUrls = spriteUrls;
Scene.prototype.plate = function(which){
  var el = mk("div", "pkb-plate "+which), top = mk("div", "pkb-pl-top");
  var name = mk("b", "pkb-name"), lv = mk("span", "pkb-lv");
  top.appendChild(name); top.appendChild(lv); el.appendChild(top);
  var mid = mk("div", "pkb-pl-mid"), types = mk("span", "pkb-types"), st = mk("span", "pkb-status hidden");
  mid.appendChild(types); mid.appendChild(st); el.appendChild(mid);
  var hp = mk("div", "pkb-hp"), lab = mk("span", "pkb-hp-l", "HP"), bar = mk("div", "pkb-hpbar"), fill = mk("i");
  bar.appendChild(fill); hp.appendChild(lab); hp.appendChild(bar); el.appendChild(hp);
  bar.setAttribute("role", "meter"); bar.setAttribute("aria-valuemin", "0");
  var num = mk("div", "pkb-hpnum"); if(which === "me") el.appendChild(num);
  var exp = null;
  if(which === "me"){ var er = mk("div", "pkb-exp"); er.appendChild(mk("span", "pkb-hp-l", "EVO")); var eb = mk("div", "pkb-expbar"); exp = mk("i"); eb.appendChild(exp); er.appendChild(eb); el.appendChild(er); }
  var balls = mk("div", "pkb-balls"); balls.setAttribute("aria-hidden", "true"); el.appendChild(balls);
  return {el:el, name:name, lv:lv, types:types, st:st, bar:bar, fill:fill, num:num, exp:exp, balls:balls, hp:0, max:1};
};
Scene.prototype.calm = calm;
Scene.prototype.who = function(w){ return w; };
// view: {me:{active, team:[mon]}, foe:{active, team:[mon]}, evo: 0..100 (optional)}
Scene.prototype.setView = function(view){
  this.view = view;
  var self = this;
  ["foe","me"].forEach(function(w){
    var side = view[w]; if(!side) return;
    var mon = side.team[side.active];
    self.paintPlate(w, mon, side.team);
    var key = mon ? (mon.id+"|"+mon.shiny+"|"+side.active+"|"+(mon.hp > 0)) : "";
    if(self.shown[w] !== key){ self.shown[w] = key; self.slots[w].textContent = ""; if(mon && mon.hp > 0) self.slots[w].appendChild(spriteEl(mon, w === "me", self)); }
  });
  if(view.evo != null && this.plates.me.exp) this.plates.me.exp.style.width = Math.max(0, Math.min(100, view.evo))+"%";
};
Scene.prototype.paintPlate = function(w, mon, team){
  var p = this.plates[w]; if(!mon) return;
  p.name.textContent = mon.name; p.lv.textContent = "Lv"+mon.lvl;
  p.types.textContent = ""; mon.types.forEach(function(t){ p.types.appendChild(chip(t)); });
  this.setStatus(w, mon.status);
  this.setHp(w, mon.hp, mon.max, true);
  p.balls.textContent = "";
  for(var i=0;i<6;i++){ var b = mk("i", "pkb-ball"+(i >= team.length ? " pkb-b-none" : team[i].hp <= 0 ? " pkb-b-out" : team[i].status ? " pkb-b-st" : "")); p.balls.appendChild(b); }
};
Scene.prototype.setStatus = function(w, s){
  var el = this.plates[w].st;
  el.className = "pkb-status"+(s ? " s-"+s : " hidden"); el.textContent = s ? STATUS_SHORT[s] : "";
};
Scene.prototype.setHp = function(w, hp, max, instant){
  var p = this.plates[w], pct = max ? Math.max(0, Math.min(100, hp/max*100)) : 0;
  p.bar.classList.toggle("mid", pct <= 50 && pct > 20); p.bar.classList.toggle("low", pct <= 20);
  p.bar.setAttribute("aria-valuemax", String(max)); p.bar.setAttribute("aria-valuenow", String(hp));
  p.bar.setAttribute("aria-label", "HP "+hp+" of "+max);
  if(instant || calm()){ p.fill.style.transition = "none"; p.fill.style.width = pct+"%"; p.num.textContent = hp+" / "+max; p.hp = hp; p.max = max; return Promise.resolve(); }
  p.fill.style.transition = ""; p.fill.style.width = pct+"%";
  var from = p.hp, t0 = 0;
  p.hp = hp; p.max = max;
  return new Promise(function(res){
    function step(now){ if(!t0) t0 = now; var t = Math.min(1, (now-t0)/600);
      p.num.textContent = Math.round(from + (hp-from)*t)+" / "+max; if(t < 1) requestAnimationFrame(step); else res(); }
    requestAnimationFrame(step);
  });
};
Scene.prototype.log = function(line){
  var li = mk("li", null, line); this.logList.appendChild(li);
  while(this.logList.children.length > 60) this.logList.removeChild(this.logList.firstChild);
};
// Typewriter line; resolves after the reading pause (Enter/Space/click skips ahead).
Scene.prototype.say = function(line, hold){
  var self = this;
  if(!line) return Promise.resolve();
  this.log(line);
  return this.gate().then(function(){
    if(calm()){ self.text.textContent = line; return self.wait(hold != null ? Math.min(hold, 450) : 350); }
    self.text.textContent = "";
    var i = 0, fast = false;
    return new Promise(function(res){
      self.skip = function(){ fast = true; };
      (function tick(){
        if(self.dead) return res();
        i = fast ? line.length : i + 2;
        self.text.textContent = line.slice(0, i);
        if(i < line.length) setTimeout(tick, 16); else res();
      })();
    }).then(function(){ return self.wait(hold != null ? hold : 750); });
  });
};
Scene.prototype.wait = function(ms){
  var self = this;
  return new Promise(function(res){ var tm = setTimeout(done, ms); function done(){ clearTimeout(tm); self.skip = null; res(); } self.skip = done; })
    .then(function(){ return self.gate(); });
};
Scene.prototype.gate = function(){
  var self = this;
  if(!this.paused) return Promise.resolve();
  return new Promise(function(res){ (function chk(){ if(!self.paused || self.dead) res(); else setTimeout(chk, 200); })(); });
};
Scene.prototype.anim = function(el, frames, ms){
  if(calm() || !el || !el.animate) return Promise.resolve();
  try { var a = el.animate(frames, {duration:ms, easing:"ease-out"}); return a.finished.catch(function(){}); } catch(e){ return Promise.resolve(); }
};
Scene.prototype.center = function(w){
  var s = this.scene.getBoundingClientRect(), el = this.slots[w].firstChild || this.slots[w];
  var r = el.getBoundingClientRect();
  if(!r.width) r = this.slots[w].getBoundingClientRect();
  return {x: r.left - s.left + r.width/2, y: r.top - s.top + r.height*0.55, r: Math.max(28, Math.min(r.width, r.height)*0.45)};
};
Scene.prototype.attackFx = function(w, moveId){
  var M = D().moves, mv = M[moveId] || M.struggle, type = mv.type, self = this;
  var me = this.slots[w].firstChild, other = w === "me" ? "foe" : "me";
  if(calm()) return Promise.resolve();
  var dir = w === "me" ? 1 : -1;
  if(mv.cat === "status"){
    var on = mv.self ? w : other, c = this.center(on), h = hueOf(type);
    return this.fx.run(520, function(g, t){
      for(var i=0;i<3;i++){ var pt = (t*1.4 + i*0.33) % 1; g.strokeStyle = col(h, 75, 65, (1-pt)*(1-t*0.5)); g.lineWidth = 3;
        g.beginPath(); g.ellipse(c.x, c.y, c.r*(0.3+pt), c.r*(0.3+pt)*0.5, 0, 0, Math.PI*2); g.stroke(); }
    });
  }
  var from = this.center(w), to = this.center(other);
  if(mv.cat === "physical"){
    return this.anim(me, [{transform:"translate(0,0)"},{transform:"translate("+(18*dir)+"px,"+(-10*dir)+"px)"},{transform:"translate(0,0)"}], 260)
      .then(function(){ return self.fx.run(480, function(g, t){ burst(g, type, to.x, to.y, t, to.r); }); });
  }
  var hue = hueOf(type);
  return this.fx.run(320, function(g, t){
    var x = from.x + (to.x-from.x)*t, y = from.y + (to.y-from.y)*t - Math.sin(t*Math.PI)*20;
    if(type === "Electric"){ g.strokeStyle = col(hue, 100, 60, 1); g.lineWidth = 3; g.beginPath(); g.moveTo(from.x, from.y);
      for(var k=1;k<=8;k++){ var f = k/8*t; g.lineTo(from.x+(to.x-from.x)*f + (k%2?10:-10), from.y+(to.y-from.y)*f + (k%2?-6:6)); } g.stroke(); return; }
    for(var i=0;i<6;i++){ var tt = Math.max(0, t - i*0.04), xx = from.x + (to.x-from.x)*tt, yy = from.y + (to.y-from.y)*tt - Math.sin(tt*Math.PI)*20;
      g.fillStyle = col(hue, 80, 60, 0.9 - i*0.14); g.beginPath(); g.arc(xx, yy, 8 - i, 0, Math.PI*2); g.fill(); }
    g.fillStyle = col(hue, 90, 85, 1); g.beginPath(); g.arc(x, y, 4, 0, Math.PI*2); g.fill();
  }).then(function(){ return self.fx.run(500, function(g, t){ burst(g, type, to.x, to.y, t, to.r); }); });
};
Scene.prototype.hitFx = function(w, crit){
  var el = this.slots[w].firstChild, self = this;
  if(calm()) return Promise.resolve();
  var p = [this.anim(el, [{opacity:1},{opacity:0.15},{opacity:1},{opacity:0.15},{opacity:1},{opacity:0.15},{opacity:1}], 420),
           this.anim(el, [{transform:"translateX(0)"},{transform:"translateX(-5px)"},{transform:"translateX(5px)"},{transform:"translateX(-3px)"},{transform:"translateX(0)"}], 300)];
  if(crit) p.push(this.fx.run(110, function(g, t, sz){ g.fillStyle = "rgba(255,255,255,"+(0.4*(1-t))+")"; g.fillRect(0, 0, sz.w, sz.h); }));
  return Promise.all(p);
};
Scene.prototype.boostFx = function(w, up){
  if(calm()) return Promise.resolve();
  var c = this.center(w), h = up ? 0 : 215;
  return this.fx.run(480, function(g, t){
    for(var i=0;i<7;i++){ var ox = c.x + (i-3)*c.r*0.28, base = (t + seeded(i)*0.5) % 1, oy = up ? c.y + c.r - base*c.r*2 : c.y - c.r + base*c.r*2;
      g.fillStyle = col(h, 80, 60, 0.85*(1-t*0.4)); g.beginPath();
      if(up){ g.moveTo(ox, oy-8); g.lineTo(ox+6, oy); g.lineTo(ox-6, oy); } else { g.moveTo(ox, oy+8); g.lineTo(ox+6, oy); g.lineTo(ox-6, oy); }
      g.fill(); }
  });
};
Scene.prototype.healFx = function(w){
  if(calm()) return Promise.resolve();
  var c = this.center(w);
  return this.fx.run(520, function(g, t){
    for(var i=0;i<10;i++){ var y = c.y + c.r - ((t + seeded(i)*0.6) % 1)*c.r*2; g.fillStyle = col(130, 70, 60, 1-t*0.6); star(g, c.x + (seeded(i+2)-0.5)*c.r*1.6, y, 4, 4); }
  });
};
Scene.prototype.missFx = function(w){
  if(calm()) return Promise.resolve();
  var c = this.center(w);
  return this.fx.run(300, function(g, t){ g.strokeStyle = "rgba(255,255,255,"+(0.8*(1-t))+")"; g.lineWidth = 2;
    for(var i=0;i<3;i++){ g.beginPath(); g.moveTo(c.x - c.r*1.4 + t*c.r*2.8, c.y - 12 + i*12); g.lineTo(c.x - c.r*1.9 + t*c.r*2.8, c.y - 12 + i*12); g.stroke(); } });
};
Scene.prototype.sendOutFx = function(w){
  var el = this.slots[w].firstChild, self = this;
  if(calm()){ if(el) el.style.opacity = ""; return Promise.resolve(); }
  // The Pok\u00e9mon stays hidden while the ball flies; it appears only when the ball opens.
  if(el) el.style.opacity = "0";
  var to = this.center(w), from = w === "me" ? {x:-10, y:to.y+40} : {x:this.scene.clientWidth+10, y:to.y-30};
  return this.fx.run(300, function(g, t){
    var x = from.x + (to.x-from.x)*t, y = from.y + (to.y-from.y)*t - Math.sin(t*Math.PI)*60;
    g.fillStyle = "hsl(0,75%,52%)"; g.beginPath(); g.arc(x, y, 7, Math.PI, 0); g.fill();
    g.fillStyle = "hsl(0,0%,96%)"; g.beginPath(); g.arc(x, y, 7, 0, Math.PI); g.fill();
    g.strokeStyle = "hsl(0,0%,15%)"; g.lineWidth = 1.5; g.beginPath(); g.arc(x, y, 7, 0, Math.PI*2); g.moveTo(x-7, y); g.lineTo(x+7, y); g.stroke();
  }).then(function(){
    return Promise.all([self.fx.run(220, function(g, t){ g.fillStyle = "rgba(255,255,255,"+(0.8*(1-t))+")"; g.beginPath(); g.arc(to.x, to.y, to.r*(0.3+t), 0, Math.PI*2); g.fill(); }),
      self.anim(el, [{transform:"scale(0)", opacity:0},{transform:"scale(1)", opacity:1}], 260)]);
  }).then(function(){ if(el) el.style.opacity = ""; });
};
Scene.prototype.recallFx = function(w){
  var el = this.slots[w].firstChild;
  return this.anim(el, [{transform:"scale(1)", filter:"brightness(1)"},{transform:"scale(0.05)", filter:"brightness(3) sepia(1) hue-rotate(-40deg)"}], 300);
};
Scene.prototype.faintFx = function(w){
  var el = this.slots[w].firstChild, self = this;
  return this.anim(el, [{transform:"translateY(0)", opacity:1},{transform:"translateY(60px)", opacity:0}], 420).then(function(){
    self.slots[w].textContent = ""; self.shown[w] = null; });
};
Scene.prototype.intro = function(lines){
  var self = this;
  if(!calm()){
    var mine = this.slots.me.firstChild; if(mine) mine.style.opacity = "0";   // appears when its ball opens
    this.anim(this.plates.foe.el, [{transform:"translateX(-120%)"},{transform:"translateX(0)"}], 380);
    this.anim(this.plates.me.el, [{transform:"translateX(120%)"},{transform:"translateX(0)"}], 380);
    this.anim(this.slots.foe.firstChild, [{opacity:0},{opacity:1}], 500);
  }
  return lines.reduce(function(p, l){ return p.then(function(){ return self.say(l); }); }, Promise.resolve())
    .then(function(){ return self.sendOutFx("me"); });
};
function wkey(ev, mySide){ return ev.side === mySide ? "me" : "foe"; }
// Plays a turn's events. mySide: which engine side is drawn at the bottom. who(side,name)->label
Scene.prototype.play = function(events, mySide, who){
  var self = this, v = this.view, p = Promise.resolve();
  this.busy = true; this.setMode("busy");
  events.forEach(function(ev){
    p = p.then(function(){
      if(self.dead) return;
      var w = ev.side != null ? wkey(ev, mySide) : null, line = pk.text(ev, who), side = w ? v[w] : null;
      switch(ev.t){
        case "switch":
          return (side && side.team[side.active] && side.team[side.active].hp > 0 ? self.recallFx(w) : Promise.resolve()).then(function(){
            side.active = ev.slot; self.setView(v);
            // keep the incoming Pok\u00e9mon out of sight until its ball is thrown and opens
            var inc = self.slots[w].firstChild; if(inc && !calm()) inc.style.opacity = "0";
            return self.say(w === "me" ? "Go! "+ev.name+"!" : who(ev.side, ev.name, true)+"!", 500);
          }).then(function(){ return self.sendOutFx(w); });
        case "move":
          return self.say(line, 380).then(function(){ return self.attackFx(w, ev.move); });
        case "dmg":
          var tgt = side.team[side.active]; tgt.hp = ev.hp;
          return self.hitFx(w, ev.crit).then(function(){ return self.setHp(w, ev.hp, ev.max); }).then(function(){ return self.say(line); });
        case "heal": case "residual":
          var m2 = side.team[side.active]; m2.hp = ev.hp;
          return self.say(line, 420).then(function(){ return ev.t === "heal" ? self.healFx(w) : self.hitFx(w, false); })
            .then(function(){ return self.setHp(w, ev.hp, ev.max); });
        case "status":
          side.team[side.active].status = ev.s; self.setStatus(w, ev.s);
          self.anim(self.plates[w].st, [{transform:"scale(1.6)"},{transform:"scale(1)"}], 350);
          return self.say(line);
        case "cure":
          side.team[side.active].status = null; self.setStatus(w, null); return self.say(line);
        case "boost":
          return (ev.n ? self.boostFx(w, ev.n > 0) : Promise.resolve()).then(function(){ return self.say(line); });
        case "miss":
          return self.missFx(w).then(function(){ return self.say(line); });
        case "faint":
          side.team[side.active].hp = 0;
          return self.faintFx(w).then(function(){ self.paintPlate(w, side.team[side.active], side.team); return self.say(line); });
        default:
          return self.say(line);
      }
    });
  });
  return p.then(function(){ self.busy = false; });
};
/* ---------- commands ---------- */
Scene.prototype.setMode = function(mode, info, extra){
  // Waiting text (a countdown) updates in place: no DOM rebuild every second.
  if(mode === "wait" && this.mode === "wait" && this.waitEl && !!extra === !!this.waitExtra){
    if(this.modeInfo !== info){ this.modeInfo = info; this.waitEl.textContent = info || "Waiting…"; }
    return;
  }
  this.mode = mode; this.modeInfo = info || null; this.waitEl = null; this.waitExtra = extra || null;
  this.keysEl.textContent = mode === "main" ? "Keys: F fight \u00b7 1\u20134 use a move \u00b7 T team" + (this.opts.onRun ? " \u00b7 R run" : "")
    : mode === "fight" ? "Keys: 1\u20134 use a move \u00b7 Esc back"
    : mode === "team" ? "Keys: Esc back"
    : (mode === "busy" ? "Keys: Enter or Space skips the text" : "");
  var c = this.cmd, self = this, v = this.view, o = this.opts;
  c.textContent = ""; c.className = "pkb-cmd m-"+mode;
  if(mode === "busy" || mode === "idle") return;
  if(mode === "wait"){
    var wt = mk("div", "pkb-wait", info || "Waiting…"); c.appendChild(wt); this.waitEl = wt;
    if(extra){ var xb = mk("button", "pkb-btn ghost", extra.label); xb.type = "button"; xb.addEventListener("click", extra.fn); c.appendChild(xb); }
    return;
  }
  if(mode === "over"){ (info || []).forEach(function(b){ var x = mk("button", "hbtn"+(b.primary ? " primary" : ""), b.label); x.type = "button"; x.addEventListener("click", b.fn); c.appendChild(x); }); this.focusFirst(); return; }
  var me = v.me.team[v.me.active];
  if(mode === "main"){
    this.text.textContent = "What will "+me.name+" do?";
    [["FIGHT", "f", function(){ self.setMode("fight"); }, true], ["TEAM", "t", function(){ self.setMode("team"); }],
     [o.runLabel || "RUN", "r", function(){ if(o.onRun) o.onRun(); }]].forEach(function(b){
      var x = mk("button", "pkb-btn"+(b[3] ? " primary" : ""), b[0]); x.type = "button"; x.setAttribute("aria-keyshortcuts", b[1].toUpperCase());
      x.addEventListener("click", b[2]); c.appendChild(x); });
    this.focusFirst(); return;
  }
  if(mode === "fight"){
    var M = D().moves, grid = mk("div", "pkb-moves"), out = me.moves.every(function(m){ return m.pp <= 0; });
    me.moves.forEach(function(m, i){
      var mv = M[m.id], b = mk("button", "pkb-move"); b.type = "button";
      b.style.background = "hsl("+hueOf(mv.type)+",58%,40%)";
      b.appendChild(mk("b", null, mv.name));
      var meta = mk("span", "pkb-mmeta");
      meta.appendChild(mk("span", null, mv.type+" "+(mv.cat === "physical" ? "✦" : mv.cat === "special" ? "◎" : "◇")));
      meta.appendChild(mk("span", null, "PP "+m.pp+"/"+m.max));
      b.appendChild(meta);
      b.title = mv.name+": "+mv.type+", "+mv.cat+(mv.bp ? ", "+mv.bp+" power" : "")+(mv.acc ? ", "+mv.acc+"% accuracy" : "");
      b.setAttribute("aria-label", mv.name+", "+mv.type+", "+mv.cat+(mv.bp ? ", "+mv.bp+" power" : "")+", PP "+m.pp+" of "+m.max);
      b.disabled = m.pp <= 0 && !out;
      b.addEventListener("click", function(){ if(o.onMove) o.onMove(i); });
      grid.appendChild(b);
    });
    c.appendChild(grid);
    if(out){ var st = mk("button", "pkb-btn", "Struggle"); st.type = "button"; st.addEventListener("click", function(){ if(o.onMove) o.onMove(0); }); c.appendChild(st); }
    var back = mk("button", "pkb-btn ghost", "Back"); back.type = "button"; back.addEventListener("click", function(){ self.setMode("main"); });
    c.appendChild(back);
    this.focusFirst(); return;
  }
  if(mode === "team" || mode === "replace"){
    if(mode === "replace") this.text.textContent = "Choose who to send out next.";
    var list = mk("div", "pkb-team");
    v.me.team.forEach(function(m, i){
      var b = mk("button", "pkb-tm"); b.type = "button";
      var mini = mk("span", "pkb-mini"); mini.appendChild(spriteEl(m, false, null)); b.appendChild(mini);
      var info = mk("span", "pkb-tminfo"); info.appendChild(mk("b", null, m.name+" Lv"+m.lvl));
      var bar = mk("span", "pkb-hpbar sm"+(m.hp/m.max <= 0.2 ? " low" : m.hp/m.max <= 0.5 ? " mid" : "")), f = mk("i"); f.style.width = Math.round(m.hp/m.max*100)+"%"; bar.appendChild(f);
      info.appendChild(bar); info.appendChild(mk("span", "pkb-tmhp", m.hp+"/"+m.max+(m.status ? " · "+STATUS_SHORT[m.status] : "")+(i === v.me.active ? " · in battle" : "")));
      b.appendChild(info);
      b.disabled = m.hp <= 0 || i === v.me.active;
      b.setAttribute("aria-label", m.name+", level "+m.lvl+", HP "+m.hp+" of "+m.max+(m.hp <= 0 ? ", fainted" : "")+(i === v.me.active ? ", in battle" : ""));
      b.addEventListener("click", function(){ if(o.onSwitch) o.onSwitch(i); });
      list.appendChild(b);
    });
    c.appendChild(list);
    if(mode === "team"){ var bk = mk("button", "pkb-btn ghost", "Back"); bk.type = "button"; bk.addEventListener("click", function(){ self.setMode("main"); }); c.appendChild(bk); }
    this.focusFirst();
  }
};
Scene.prototype.focusFirst = function(){
  var b = this.cmd.querySelector("button:not([disabled])"), ae = document.activeElement;
  if(b && (!ae || ae === document.body || this.root.contains(ae))) b.focus();
};
Scene.prototype.key = function(e){
  if(e.metaKey || e.ctrlKey || e.altKey) return;
  var k = e.key, tag = e.target && e.target.tagName;
  if(tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
  if((k === "Enter" || k === " ") && this.skip && this.busy){ e.preventDefault(); this.skip(); return; }
  if(this.mode === "main"){
    if(k === "f" || k === "F"){ e.preventDefault(); this.setMode("fight"); }
    else if(k === "t" || k === "T"){ e.preventDefault(); this.setMode("team"); }
    else if((k === "r" || k === "R") && this.opts.onRun){ e.preventDefault(); this.opts.onRun(); }
    else if(/^[1-4]$/.test(k)){ e.preventDefault(); this.setMode("fight"); this.pressMove(+k-1); }
  } else if(this.mode === "fight"){
    if(/^[1-4]$/.test(k)){ e.preventDefault(); this.pressMove(+k-1); }
    else if(k === "Escape"){ e.preventDefault(); this.setMode("main"); }
  } else if(this.mode === "team" && k === "Escape"){ e.preventDefault(); this.setMode("main"); }
};
Scene.prototype.pressMove = function(i){
  var b = this.cmd.querySelectorAll(".pkb-move")[i];
  if(b && !b.disabled) b.click();
};
Scene.prototype.pause = function(){ this.paused = true; };
Scene.prototype.resume = function(){ this.paused = false; };
Scene.prototype.destroy = function(){ this.dead = true; cancelAnimationFrame(this.fx.raf); this.root.removeEventListener("keydown", this.onKey); if(this.root.parentNode) this.root.parentNode.removeChild(this.root); };
/* =============================== TEAM BUILDER =============================== */
// A saved battle team picked from the Pokemon you have UNLOCKED (caught in the Pokedex, at the
// highest stage any of your sessions reached). Creature Battles and the Creature Duel both use
// it; with nothing saved they fall back to the live working/idle session creatures.
// The save keeps only species numbers in order (save.battle.team); every stage, form, type and
// move is derived from the Pokedex and games/pokedata.js each time it is used.
var TEAM_MAX = 6, DEX = null, DEX_P = null;
function tapi(){ return HQV.api || null; }
function unlockedFrom(dex){
  var out = [];
  ((dex && dex.species) || []).forEach(function(d){
    if(!d || !d.caught || !isInt(d.species) || d.species < 0 || d.species >= D().lines.length) return;
    // the same creature -> Pokemon mapping the battle code uses for a live session creature
    var cr = {species: d.species, stage: Math.max(0, Math.min(4, d.maxStage|0)), shiny: !!d.shiny,
              _sid: typeof d.exampleSessionId === "string" ? d.exampleSessionId : ""};
    var st = cr.stage, br = null, mg = null;
    try { if(typeof G.creatureStage === "function") st = Math.max(0, Math.min(4, G.creatureStage(cr)|0)); } catch(e){}
    cr.stage = st;
    try { if(typeof G.branchFinalDex === "function") br = G.branchFinalDex(cr); } catch(e){}
    try { if(typeof G.pokeMega === "function") mg = G.pokeMega(cr); } catch(e){}
    out.push({sp: d.species, st: st, br: isInt(br) ? br : null, mg: typeof mg === "string" ? mg : null, sh: !!d.shiny, name: ""});
  });
  return out;
}
// Fetch the unlocked list (shared /api/pokedex request); resolves to [] when unavailable.
pk.loadUnlocked = function(){
  if(DEX) return Promise.resolve(DEX);
  if(DEX_P) return DEX_P;
  var f = typeof G.fetchPokedex === "function" ? G.fetchPokedex()
        : fetch("/api/pokedex", {cache: "no-store"}).then(function(r){ if(!r.ok) throw new Error(r.status); return r.json(); });
  DEX_P = f.then(function(j){ DEX = D() ? unlockedFrom(j) : []; DEX_P = null; return DEX; }, function(){ DEX_P = null; return []; });
  return DEX_P;
};
pk.unlocked = function(){ return DEX; };
function savedIds(){
  var a = tapi(), b = a && a.save && a.save.battle, t = b && Array.isArray(b.team) ? b.team : [];
  var seen = {}, out = [];
  t.forEach(function(v){ if(isInt(v) && v >= 0 && v < 48 && !seen[v] && out.length < TEAM_MAX){ seen[v] = 1; out.push(v); } });
  return out;
}
// The saved team as battle specs (lead first), or null when none is saved / the Pokedex isn't loaded.
pk.savedTeam = function(){
  if(!DEX || !D()) return null;
  var by = {}; DEX.forEach(function(u){ by[u.sp] = u; });
  var out = savedIds().filter(function(i){ return by[i]; }).map(function(i){ var u = by[i]; return {sp:u.sp, st:u.st, br:u.br, mg:u.mg, sh:u.sh, name:""}; });
  return out.length ? out : null;
};
pk.hasSavedTeam = function(){ return savedIds().length > 0; };
function saveIds(ids){
  var a = tapi(); if(!a || !a.save) return;
  if(!a.save.battle || typeof a.save.battle !== "object") a.save.battle = {};
  if(ids.length) a.save.battle.team = ids.slice(0, TEAM_MAX); else delete a.save.battle.team;
  a.persist();
}
// The builder: host gets a panel; opts.onDone() runs after Save or Cancel.
pk.teamBuilder = function(host, opts){
  opts = opts || {};
  var box = mk("div", "pkb-builder"), picked = savedIds(), list = null, dirty = false;
  box.setAttribute("role", "region"); box.setAttribute("aria-label", "Team builder");
  host.appendChild(box);
  box.appendChild(mk("p", "vg-muted", "Loading your Pokédex…"));
  function say(t){ if(typeof G.announce === "function"){ try { G.announce(t); } catch(e){} } }
  function monOf(u){ return pk.buildMon({sp:u.sp, st:u.st, br:u.br, mg:u.mg, sh:u.sh}); }
  function byId(){ var o = {}; (list || []).forEach(function(u){ o[u.sp] = u; }); return o; }
  function card(u, cls){
    var m = monOf(u), c = mk("span", "pkb-bcard-in"+(cls ? " "+cls : ""));
    var spr = mk("span", "pkb-bspr"); spr.appendChild(spriteEl(m, false, null)); c.appendChild(spr);
    var info = mk("span", "pkb-binfo");
    info.appendChild(mk("b", null, m.name+(m.shiny ? " ★" : "")));
    info.appendChild(mk("span", "pkb-blv", "Lv"+m.lvl));
    var types = mk("span", "pkb-types"); m.types.forEach(function(t){ types.appendChild(chip(t)); }); info.appendChild(types);
    var mv = mk("span", "pkb-bmoves");
    m.moves.forEach(function(x){ var d = D().moves[x.id]; mv.appendChild(mk("span", "pkb-bmove", d ? d.name : x.id)); });
    info.appendChild(mv);
    c.appendChild(info);
    return {el: c, mon: m};
  }
  function render(focusSel){
    box.textContent = "";
    var by = byId();
    picked = picked.filter(function(i){ return by[i]; });
    var head = mk("div", "pkb-bhead");
    head.appendChild(mk("b", null, "Your team ("+picked.length+"/"+TEAM_MAX+")"));
    head.appendChild(mk("span", "vg-muted", picked.length ? "The first one leads. Saved on this computer only." : "Nothing picked: battles use your working and idle sessions."));
    box.appendChild(head);
    var team = mk("ol", "pkb-bteam"); team.setAttribute("aria-label", "Picked team, lead first");
    picked.forEach(function(i, k){
      var u = by[i], li = mk("li", "pkb-bslot"), c = card(u, "sm");
      li.appendChild(c.el);
      var ctl = mk("span", "pkb-bctl");
      function b(label, aria, fn, dis, key){ var x = mk("button", "pkb-btn ghost pkb-bmini", label); x.type = "button"; x.setAttribute("aria-label", aria);
        x.disabled = !!dis; x.dataset.k = key; x.addEventListener("click", fn); ctl.appendChild(x); return x; }
      b("↑", "Move "+c.mon.name+" earlier", function(){ move(k, -1); }, k === 0, "up"+i);
      b("↓", "Move "+c.mon.name+" later", function(){ move(k, 1); }, k === picked.length - 1, "dn"+i);
      b("✕", "Remove "+c.mon.name, function(){ toggle(i); }, false, "rm"+i);
      li.appendChild(ctl);
      team.appendChild(li);
    });
    if(picked.length) box.appendChild(team);
    var row = mk("div", "pkb-brow");
    var save = mk("button", "pkb-btn primary", "Save team"); save.type = "button";
    save.addEventListener("click", function(){ saveIds(picked); dirty = false; say(picked.length ? "Team saved" : "Using your session creatures");
      if(tapi()) tapi().toast(picked.length ? "Team saved" : "Team cleared: battles use your sessions"); if(opts.onDone) opts.onDone(true); });
    row.appendChild(save);
    var clear = mk("button", "pkb-btn ghost", "Use my sessions"); clear.type = "button"; clear.disabled = !picked.length;
    clear.addEventListener("click", function(){ picked = []; dirty = true; render(); });
    row.appendChild(clear);
    var cancel = mk("button", "pkb-btn ghost", "Cancel"); cancel.type = "button";
    cancel.addEventListener("click", function(){ if(opts.onDone) opts.onDone(false); });
    row.appendChild(cancel);
    box.appendChild(row);
    box.appendChild(mk("h4", "pkb-bh", "Unlocked Pokémon ("+list.length+")"));
    if(!list.length){ box.appendChild(mk("p", "vg-muted", "Nothing unlocked yet: every session you run catches its species in the Pokédex.")); return; }
    var grid = mk("div", "pkb-bgrid"); grid.setAttribute("role", "group"); grid.setAttribute("aria-label", "Unlocked Pokémon: press to add or remove");
    list.forEach(function(u){
      var on = picked.indexOf(u.sp) >= 0, full = !on && picked.length >= TEAM_MAX, c = card(u);
      var btn = mk("button", "pkb-bcard"+(on ? " on" : "")); btn.type = "button"; btn.dataset.k = "sp"+u.sp;
      btn.setAttribute("aria-pressed", on ? "true" : "false");
      btn.setAttribute("aria-label", c.mon.name+", level "+c.mon.lvl+", "+c.mon.types.join(" and ")+". Moves: "+
        c.mon.moves.map(function(x){ var d = D().moves[x.id]; return d ? d.name : x.id; }).join(", ")+(on ? ". On your team" : full ? ". Team is full" : ""));
      btn.disabled = full;
      btn.appendChild(c.el);
      if(on){ var n = mk("span", "pkb-bnum", String(picked.indexOf(u.sp)+1)); n.setAttribute("aria-hidden", "true"); btn.appendChild(n); }
      btn.addEventListener("click", function(){ toggle(u.sp); });
      grid.appendChild(btn);
    });
    box.appendChild(grid);
    if(focusSel){ var f = box.querySelector('[data-k="'+focusSel+'"]'); if(f && !f.disabled) f.focus(); else { f = box.querySelector(".pkb-bcard:not([disabled])"); if(f) f.focus(); } }
  }
  function toggle(i){
    var k = picked.indexOf(i);
    if(k >= 0) picked.splice(k, 1); else if(picked.length < TEAM_MAX) picked.push(i); else return;
    dirty = true; render("sp"+i);
  }
  function move(k, d){
    var j = k + d; if(j < 0 || j >= picked.length) return;
    var t = picked[k]; picked[k] = picked[j]; picked[j] = t; dirty = true;
    render((d < 0 ? "up" : "dn")+t);
  }
  pk.loadUnlocked().then(function(l){
    if(!box.isConnected && !box.parentNode) return;
    list = (l || []).slice().sort(function(a, b){ return b.st - a.st || a.sp - b.sp; });
    render(null);
    var f = box.querySelector(".pkb-bcard:not([disabled]), .pkb-btn"); if(f) f.focus();
  });
  return {el: box, dirty: function(){ return dirty; }};
};
})();
