/* Valley: Fishing pond. Hold Space / mouse / touch to charge a cast and release in the
 * sweet spot; watch the shadow come to your bobber (its size hints at the rarity), ignore
 * the nibbles and hook on the real bite, then hold to keep the fish in the green bar until
 * the meter fills. Treasure chests, perfect catches, real sizes (each fish is modelled on a
 * real species, see fishart.js) and a fishing log. Each project folder you work in is its
 * own pond; for 10 minutes after a long-running tab finishes, rare fish bite more often.
 * Art, reel physics and sound are shared with the multiplayer dock via games/fishart.js. */
(function(){
"use strict";
var HQV = window.HQV; if(!HQV || !HQV.fishArt) return;
var FA = HQV.fishArt;
var POND_FISH = ["minnow","perch","carp","bream","trout","pike","eel","koi","sturgeon","angler","glowfin","lumen","leviathan","sunfish","ghostfish","mudcat"];
var RARITY = FA.RARITY_NAME;
var game = {id:"fishing", name:"Fishing Pond", icon:"🎣", desc:"Cast, hook the bite, reel it in"};
var st = null, raf = 0, api = null, rareUntil = 0;
var ANGLER_X = 246, ANGLER_Y = 100, REEL_X = 8;

function pondFor(folder){
  // Each folder gets a stable mix: 8 of the 16 fish, weighted by rarity.
  var r = api.rng("pond:"+(folder||"home")), pool = POND_FISH.slice();
  for(var i=pool.length-1;i>0;i--){ var j=Math.floor(r()*(i+1)); var t=pool[i]; pool[i]=pool[j]; pool[j]=t; }
  return pool.slice(0, 8);
}
function pondName(f){ return (String(f||"home").replace(/^-Users-[^-]+-?/,"")||"home"); }
// Long casts (power >= 0.8) reach deeper water: rare and legendary fish weigh x1.25.
function pickFish(folder, power){
  var items = api.items, pool = pondFor(folder), rareBoost = Date.now() < rareUntil;
  var weights = pool.map(function(id){ var r=items[id].rarity, w = rareBoost ? [0,4,3,3,2][r] : [0,10,5,2,0.6][r]; return (power >= 0.8 && r >= 3) ? w*1.25 : w; });
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

function fishLog(){ var s = api.save; s.log.fish = s.log.fish || {}; return s.log.fish; }
function totals(){
  var log = fishLog(), n = 0, p = 0, got = 0;
  POND_FISH.forEach(function(id){ var e = log[id]; if(e){ got++; n += e.n|0; p += e.perfect|0; } });
  return {caught:n, perfect:p, species:got};
}
function rodLevel(){ return Math.min(4, Math.floor(totals().caught/25)); }
// Treasure: ore and gems, the common ones more often; now and then a misc find.
function rollLoot(){
  if(Math.random() < 0.1) return Math.random() < 0.5 ? "shell" : "slime";
  var table = [["copper",10],["iron",7],["quartz",5],["gold",3],["amethyst",2],["emerald",1.2],["ruby",1]];
  var tot = 0; table.forEach(function(t){ tot += t[1]; });
  var x = Math.random()*tot;
  for(var i=0;i<table.length;i++){ x -= table[i][1]; if(x <= 0) return table[i][0]; }
  return "copper";
}

/* ---------- the pond ---------- */
function newRig(){
  var rig = new FA.Rig({
    scene: st.scene, fx: st.fx, shadows: st.shadows, look: FA.looks("me"), me: false, dir: -1, x: ANGLER_X, y: ANGLER_Y,
    zone: 36 + 4*rodLevel(), treasure: true,
    target: function(pw){
      var tip = rig.tip || {x:240, y:98};
      return {x: Math.max(32, Math.round(tip.x - (30 + pw*130))), y: Math.max(90, Math.min(160, Math.round(116 - pw*24 + (Math.random()*8-4))))};
    },
    cast: function(pw, now){
      var fish = pickFish(st.folder, pw);
      rig.arm({fish: fish, rarity: api.items[fish].rarity, biteAt: now + 450 + 800 + Math.random()*2200}, now);
      say(pw >= 0.9 ? "Perfect cast! Wait for the bite…" : "Waiting for a bite… ignore the nibbles.");
    },
    onResult: onResult
  });
  return rig;
}
function onResult(kind, info){
  if(kind === "bite"){ say("Bite! Press Space now."); if(!api.calm()) st.shakeUntil = st.clock + 150; }
  else if(kind === "hooked") say("Hooked! Hold to keep the fish in the green bar.");
  else if(kind === "spooked") say("Too early, it got spooked.");
  else if(kind === "missed" || kind === "lost") say("It got away…");
  else if(kind === "reeled") say("Reeled in. Hold Space or click to cast again.");
  else if(kind === "won") land(info);
}
function land(info){
  var id = info.fish, it = api.items[id];
  var u = Math.random(), size = FA.sizeFor(id, u, info.perfect);
  var stars = (info.perfect ? 1 : 0) + (size.big ? 1 : 0) + (info.perfectCast ? 1 : 0);
  api.inv.add(id, 1);
  var e = fishLog()[id] = fishLog()[id] || {n:0, first:api.day()};
  e.n = (e.n|0) + 1;
  var isNew = e.n === 1, record = !isNew && (!e.best || size.len > e.best.len);
  if(!e.best || size.len > e.best.len) e.best = {len:size.len, kg:size.kg};
  if(info.perfect) e.perfect = (e.perfect|0) + 1;
  e.stars = Math.max(e.stars|0, stars);
  var loot = info.chest ? rollLoot() : null;
  if(loot) api.inv.add(loot, 1);
  api.persist();
  if(isNew) api.toast("🎣 New fish: "+it.name, "ach");
  say("Caught "+(/^[AEIOU]/.test(it.name) ? "an " : "a ")+it.name+"! "+size.len+" cm, "+FA.fmtKg(size.kg)+".");
  st.rig.zone = 36 + 4*rodLevel(); st.rig.o.zone = st.rig.zone;
  if(game.onCatch) game.onCatch(id, {weight:size.kg, length:size.len, perfect:!!info.perfect, stars:stars});
  var cardInfo = {id:id, size:size, stars:stars, perfect:!!info.perfect, isNew:isNew, record:record, loot:loot};
  st.pendingCard = {at: st.clock + 450, info: cardInfo};
  if(st.tab === "log") renderLog();
}
function say(t){ st.msg = t; }

/* ---------- catch card (shared with the dock: FA.card) ---------- */
function showCard(c, viewOnly){
  closeCard(true);
  st.card = FA.card(st.wrap, c, {viewOnly:viewOnly, onClose:function(){ st.card = null; if(st.cv) st.cv.focus(); },
    onLog:function(){ st.card = null; setTab("log"); }});
}
function closeCard(silent){ if(st && st.card){ st.card.close(silent); st.card = null; } }

/* ---------- log ---------- */
function setTab(t){
  st.tab = t; try { localStorage.setItem("hq-fish-tab", t); } catch(e){}
  st.tabs.forEach(function(b){ var on = b.dataset.tab === t; b.setAttribute("aria-selected", on ? "true" : "false"); b.classList.toggle("on", on); b.tabIndex = on ? 0 : -1; });
  st.pondEl.classList.toggle("hidden", t !== "pond");
  st.logEl.classList.toggle("hidden", t !== "log");
  if(t === "log"){ renderLog(); game.pause(); }
  else { game.resume(); if(st.cv) st.cv.focus(); }
}
function renderLog(){
  if(!st || !st.logEl) return;
  var log = fishLog(), box = st.logEl, tot = totals(); box.textContent = "";
  box.appendChild(api.mk("h4", null, "Fishing log · "+tot.species+"/"+POND_FISH.length+" · "+tot.caught+" caught · "+tot.perfect+" perfect"));
  var m = api.mk("div","vg-meter"), mi = api.mk("i"); mi.style.width = Math.round(tot.species/POND_FISH.length*100)+"%"; m.appendChild(mi); box.appendChild(m);
  box.appendChild(api.mk("p","vg-muted","Rod level "+rodLevel()+" (bigger catch bar every 25 fish). Sizes use each species' real length–weight data from FishBase."));
  var grid = api.mk("div","vg-fish-log"), folders = (api.activity().folders.length ? api.activity().folders : ["home"]);
  POND_FISH.slice().sort(function(a,b){ var ra = api.items[a].rarity, rb = api.items[b].rarity; return ra - rb || api.items[a].name.localeCompare(api.items[b].name); }).forEach(function(id){
    var it = api.items[id], e = log[id], cell = api.mk("button","vg-fish-cell"+(e ? "" : " unknown")); cell.type = "button";
    var cv = document.createElement("canvas"), src = FA.fishCanvas(id, 3, false, !e); cv.width = src.width; cv.height = src.height; cv.getContext("2d").drawImage(src, 0, 0);
    cell.appendChild(cv);
    if(e){
      cell.appendChild(api.mk("b", null, it.name));
      cell.appendChild(api.mk("span","vg-rar vg-rar-"+it.rarity, RARITY[it.rarity]));
      cell.appendChild(api.mk("span", null, "×"+(e.n|0)+(e.best ? " · best "+e.best.len+" cm" : "")));
      var s = e.stars|0; cell.appendChild(api.mk("span","vg-fish-stars", "★★★".slice(0, s)+"☆☆☆".slice(0, 3-s)+(e.perfect ? " · "+e.perfect+" perfect" : "")));
      cell.setAttribute("aria-label", it.name+", caught "+(e.n|0)+" times");
      cell.addEventListener("click", function(){
        setTab("pond");
        showCard({id:id, size:{len:(e.best||{}).len||0, kg:(e.best||{}).kg||0}, stars:e.stars|0, n:e.n|0, perfectN:e.perfect|0}, true);
      });
    } else {
      cell.appendChild(api.mk("b", null, "???"));
      var where = folders.filter(function(f){ return pondFor(f).indexOf(id) >= 0; }).map(pondName);
      var hint = it.rarity === 4 ? "Bites more after long tabs finish" : where.length ? "Found in: "+where.slice(0,2).join(", ") : "Not in your current ponds";
      cell.appendChild(api.mk("span","vg-muted", hint));
      cell.setAttribute("aria-label", "Unknown fish. "+hint);
    }
    grid.appendChild(cell);
  });
  box.appendChild(grid);
}

/* ---------- loop ---------- */
function step(dt){
  st.clock += dt;
  var now = st.clock;
  st.rig.update(now, dt);
  st.shadows.update(dt);
  st.fx.update(dt);
  if(st.pendingCard && now >= st.pendingCard.at){ var c = st.pendingCard.info; st.pendingCard = null; showCard(c, false); }
}
function draw(){
  var g = st.view.g, now = st.clock;
  st.scene.drawBack(g, now);
  st.shadows.draw(g, now);
  st.rig.draw(g, now, st.scene);
  st.fx.draw(g, now);
  st.scene.drawFront(g, now);
  st.rig.drawUI(g, now, REEL_X);
  if(st.rig.phase === "idle" && !st.card && !st.pendingCard && now > st.rig.cheerUntil) FA.label(g, "HOLD SPACE / CLICK TO CAST", 160, 4, "#ffffff");
  if(st.paused && st.tab === "pond") FA.label(g, "PAUSED", 160, 86, "#f2d14b", 2);
  var sh = now < st.shakeUntil ? {x: (Math.floor(now/30)%2 ? 2 : -2)/1, y: 0} : null;
  st.view.blit(sh);
  if(st.card && !api.calm()) st.card.draw(now);
}
function loop(t){
  if(!st) return;
  var dt = st.last ? Math.min(50, t - st.last) : 16; st.last = t;
  if(!st.paused) step(dt);
  draw();
  var txt = st.paused ? "Paused" : st.msg;
  if(st.msgEl.textContent !== txt) st.msgEl.textContent = txt;
  var ph = st.rig.phase, lab = "Fishing pond. "+(ph === "idle" ? "Hold Space or the mouse to charge a cast, release to cast." : ph === "reeling" ? "Reeling: hold Space to raise the green bar over the fish." : ph === "bite" ? "Bite! Press Space." : "Waiting for a bite.");
  if(st.cvLabel !== lab){ st.cvLabel = lab; st.cv.setAttribute("aria-label", lab); }
  debug();
  raf = requestAnimationFrame(loop);
}
// Read-only state for the browser smoke test, only when localStorage "hq-debug" is set.
function debug(){
  if(!st.debug) return;
  var r = st.rig, re = r.reel;
  window.__hqFish = {phase: r.phase, power: r.power, progress: re ? re.progress : 0, fishY: re ? re.fishY : 0, barY: re ? re.barY : 0, barV: re ? re.barV : 0,
    zone: re ? re.zone : 0, nibbling: r.phase === "waiting" && r.nibbling(st.clock), fish: r.fish, bob: r.bob ? {x:r.bob.x, y:r.bob.y} : null,
    card: !!st.card, renders: st.scene.renders, chest: !!(re && re.chest && re.chest.shown)};
}

function press(){
  if(!st || st.paused || st.card || st.pendingCard || st.tab !== "pond") return;
  FA.sfx.unlock();
  st.rig.down(st.clock);
}
function release(){ if(st && !st.paused) st.rig.up(st.clock); else if(st) st.rig.hold = false; }

game.mount = function(el, a){
  api = a;
  var acts = api.activity(), folders = acts.folders.length ? acts.folders : ["home"];
  var dbg = false; try { dbg = !!localStorage.getItem("hq-debug"); } catch(e){}
  st = {folder: folders[0], paused:false, last:0, clock:0, msg:"", shakeUntil:0, tab:"pond", debug:dbg};
  var tabs = api.mk("div","vg-row vg-tabs"); tabs.setAttribute("role","tablist");
  st.tabs = ["pond","log"].map(function(t){
    var b = api.btn(t === "pond" ? "Pond" : "Log", "ghost", function(){ setTab(t); });
    b.setAttribute("role","tab"); b.dataset.tab = t; tabs.appendChild(b); return b;
  });
  tabs.addEventListener("keydown", function(e){ if(e.key === "ArrowRight" || e.key === "ArrowLeft"){ e.preventDefault(); setTab(st.tab === "pond" ? "log" : "pond"); (st.tab === "pond" ? st.tabs[0] : st.tabs[1]).focus(); } });
  el.appendChild(tabs);
  st.pondEl = api.mk("div","vg-body"); st.logEl = api.mk("div","vg-body hidden"); st.logEl.setAttribute("role","tabpanel");
  st.pondEl.setAttribute("role","tabpanel");
  el.appendChild(st.pondEl); el.appendChild(st.logEl);

  var top = api.mk("div","vg-row");
  var sel = api.mk("select","vg-select"); sel.setAttribute("aria-label","Pond");
  folders.forEach(function(f){ var o=api.mk("option",null,"Pond: "+pondName(f)); o.value=f; sel.appendChild(o); });
  sel.addEventListener("change", function(){ st.folder = sel.value; buildPond(); });
  top.appendChild(sel);
  top.appendChild(api.btn("Cast", "primary", function(){
    if(st.card || st.pendingCard) return;
    if(st.rig.phase === "idle"){ FA.sfx.unlock(); st.rig.release(st.clock, 0.7); }
    st.cv.focus();
  }));
  var snd = api.btn("", "ghost", function(){ FA.sfx.set(!FA.sfx.on()); syncSound(); if(FA.sfx.on()) FA.sfx.unlock(); });
  function syncSound(){ var on = FA.sfx.on(); snd.textContent = on ? "🔊 Sound" : "🔇 Sound"; snd.setAttribute("aria-pressed", on ? "true" : "false"); }
  syncSound(); top.appendChild(snd);
  st.pondEl.appendChild(top);
  st.wrap = api.mk("div","vg-fish-wrap");
  var cv = st.cv = api.canvas(FA.W, FA.H);
  st.view = FA.view(cv);
  st.wrap.appendChild(cv);
  st.pondEl.appendChild(st.wrap);
  st.msgEl = api.mk("p","vg-msg"); st.msgEl.setAttribute("aria-live","polite"); st.pondEl.appendChild(st.msgEl);
  function kd(e){ if(e.key !== " " && e.key !== "Spacebar") return; e.preventDefault(); if(!e.repeat) press(); }
  function ku(e){ if(e.key !== " " && e.key !== "Spacebar") return; e.preventDefault(); release(); }
  function pd(e){ if(e.button != null && e.button !== 0) return; e.preventDefault(); cv.focus(); press(); }
  function pu(){ release(); }
  function esc(e){ if(e.key === "Escape" && st && st.tab === "log"){ setTab("pond"); } }
  cv.addEventListener("keydown", kd); cv.addEventListener("keyup", ku);
  cv.addEventListener("pointerdown", pd);
  window.addEventListener("pointerup", pu); window.addEventListener("pointercancel", pu);
  el.addEventListener("keydown", esc);
  st.cleanup = function(){ window.removeEventListener("pointerup", pu); window.removeEventListener("pointercancel", pu); };
  function buildPond(){
    st.scene = new FA.Scene(st.folder, "solo"); st.fx = new FA.Fx(); st.shadows = new FA.Shadows(st.scene, 4 + Math.floor(Math.random()*2));
    st.rig = newRig(); st.pendingCard = null; closeCard(true);
    say("Hold Space or the mouse to charge, release to cast. Long casts reach rarer fish.");
  }
  buildPond();
  var saved = "pond"; try { saved = localStorage.getItem("hq-fish-tab") === "log" ? "log" : "pond"; } catch(e){}
  setTab(saved);
  raf = requestAnimationFrame(loop);
};
game.unmount = function(){ cancelAnimationFrame(raf); if(st && st.cleanup) st.cleanup(); if(st) closeCard(true); st = null; try { delete window.__hqFish; } catch(e){} };
game.pause = function(){ if(st){ st.paused = true; if(st.rig) st.rig.hold = false; } };
game.resume = function(){ if(st && st.tab === "pond"){ st.paused = false; st.last = 0; } };
// The festival derby scores catches through this hook: fn(id, {weight, length, perfect, stars}).
HQV.fishingCatch = function(fn){ game.onCatch = fn; };
HQV.register(game);
})();
