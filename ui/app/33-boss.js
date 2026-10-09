/* ================= HQ 2.5: World boss ================= */
// One Arena-wide boss a week. Everyone's merged PRs and multiplayer wins drain it to 15%, then
// it's a fight: up to 3 attempts a day with a team of up to 6, replayed here from the server's
// battle log, and whoever takes the last HP lands the final blow. The only thing this page sends
// is the team, as battle specs {sp, st, br, mg, sh}; the PR counts are the ones loot already sent.
// Lives in the Compete view (panel order 20) and in a standalone modal, bossOpen().
var BOSS = {data:null, code:0, err:"", at:0, loading:null, hosts:[], timer:null, rid:null, busy:false, scene:null, modal:null, lastFocus:null};
var BOSS_WEEK_RE = /^\d{4}-W\d{2}$/;

function bossFetch(path, opts){
  return fetch(path, opts||{cache:"no-store"}).then(function(r){
    return r.json().then(function(j){ return {ok:r.ok, code:r.status, j:j||{}}; }, function(){ return {ok:false, code:r.status, j:{}}; });
  });
}
function bossLoad(force){
  if(BOSS.loading) return BOSS.loading;
  if(!force && BOSS.data && Date.now()-BOSS.at < 30000) return Promise.resolve(BOSS.data);
  BOSS.loading = bossFetch("/api/arena/boss").then(function(res){
    BOSS.loading = null; BOSS.at = Date.now(); BOSS.code = res.code;
    if(res.ok && res.j && res.j.boss){ BOSS.data = res.j; BOSS.err = ""; }
    else { BOSS.err = res.j.error || res.j.detail || ""; if(res.code === 404 || res.code === 400) BOSS.data = null; }
    return BOSS.data;
  }, function(){ BOSS.loading = null; BOSS.code = 0; BOSS.err = "The Arena didn't answer."; return BOSS.data; });
  return BOSS.loading;
}
function bossNum(n){ n = Math.max(0, n|0); return n.toLocaleString ? n.toLocaleString("en-US") : String(n); }
function bossPct(hp, max){ return max > 0 ? Math.max(0, Math.min(100, Math.round(1000*hp/max)/10)) : 0; }
function bossCalm(){ return typeof hqCalm === "function" ? hqCalm() : document.documentElement.classList.contains("hq-calm"); }
function bossSay(msg){ if(typeof announce === "function") announce(msg); }
function bossEndsIn(endsAt){
  var t = Date.parse(String(endsAt||"").replace(" ", "T").slice(0, 23)+"Z");
  if(!isFinite(t)) return "";
  var s = Math.max(0, Math.round((t - Date.now())/1000)), d = Math.floor(s/86400), h = Math.floor(s%86400/3600), m = Math.floor(s%3600/60);
  return d > 0 ? d+"d "+h+"h" : h > 0 ? h+"h "+m+"m" : m+"m";
}
// Boss art: the page's existing sprite chain (pokeImgFor, which ends at the generated monster), or the
// generated monster alone for the non-Pokémon packs.
function bossArt(b, px){
  var wrap = document.createElement("div"); wrap.className = "boss-art"; wrap.setAttribute("aria-hidden", "true");
  var cr = {species: (typeof hashStr === "function" ? hashStr("boss:"+b.dex) : (b.dex|0)) % 48, stage:3, shiny:false, _noFloor:true};
  var poke = true;
  try { poke = typeof isPokePack === "function" ? isPokePack() : true; } catch(e){}
  if(poke && typeof pokeImgFor === "function") wrap.innerHTML = pokeImgFor(b.dex|0, cr, px, b.name);   // pokeImgFor esc()s its alt
  else if(typeof paintCreature === "function"){ try { paintCreature(wrap, cr, px, false); } catch(e){} }
  return wrap;
}
function bossEl(tag, cls, text){ var n = document.createElement(tag); if(cls) n.className = cls; if(text != null) n.textContent = String(text); return n; }
function bossBtn(label, cls, fn){ var b = bossEl("button", cls||"hbtn", label); b.type = "button"; b.addEventListener("click", fn); return b; }
function bossWho(u){ return u ? (u.displayName || u.handle || "a trainer") : "a trainer"; }

/* ---- rendering: one renderer for the panel and the modal ---- */
function bossRenderAll(){ BOSS.hosts = BOSS.hosts.filter(function(h){ return h.isConnected; }); BOSS.hosts.forEach(function(h){ bossRender(h); }); }
function bossRender(host){
  if(!host || BOSS.busy) return;
  // A re-render must not drop keyboard focus to <body>: put it back on the same button.
  var ae = document.activeElement, refocus = ae && host.contains(ae) ? (ae.textContent || "") : null;
  bossBuild(host);
  if(refocus != null){
    var bs = host.querySelectorAll("button:not([disabled]),summary"), f = null;
    for(var i = 0; i < bs.length && !f; i++) if(bs[i].textContent === refocus) f = bs[i];
    f = f || bs[0]; if(f) f.focus();
  }
}
function bossBuild(host){
  host.textContent = "";
  var d = BOSS.data;
  if(!d){
    var p = bossEl("p", "muted",
      BOSS.loading ? "Loading the world boss…" :
      BOSS.code === 404 ? "This Arena doesn't run the world boss yet: ask its owner to update it." :
      BOSS.code === 400 ? "Pair with an Arena (Arena view) to join the weekly world boss." :
      (BOSS.err || "The Arena didn't answer."));
    host.appendChild(p);
    if(!BOSS.loading) host.appendChild(bossBtn("Try again", "hbtn ghost", function(){ bossLoad(true).then(bossRenderAll); bossRender(host); }));
    return;
  }
  var b = d.boss || {}, you = d.you || {}, rules = d.rules || {}, pct = bossPct(b.hp, b.maxHp);
  var card = bossEl("section", "boss-card boss-"+(b.phase||"drain")); card.setAttribute("aria-label", "World boss");
  var head = bossEl("div", "boss-head");
  head.appendChild(bossArt(b, 96));
  var who = bossEl("div", "boss-id");
  who.appendChild(bossEl("div", "boss-week", "Week "+String(d.week||"").replace(/^.*-W/, "")+(d.endsAt ? " · ends in "+bossEndsIn(d.endsAt) : "")));
  who.appendChild(bossEl("h3", "boss-name", b.name || "???"));
  var types = bossEl("div", "boss-types");
  (b.types||[]).forEach(function(t){ var c = bossEl("span", "boss-type", t); if(window.POKE_TYPE_HUE && POKE_TYPE_HUE[t] != null) c.style.setProperty("--boss-hue", String(POKE_TYPE_HUE[t]|0)); types.appendChild(c); });
  who.appendChild(types);
  head.appendChild(who);
  card.appendChild(head);

  // HP bar, with the 15% line where the fight starts.
  var bar = bossEl("div", "boss-hp"); bar.setAttribute("role", "meter");
  bar.setAttribute("aria-valuemin", "0"); bar.setAttribute("aria-valuemax", String(b.maxHp|0)); bar.setAttribute("aria-valuenow", String(b.hp|0));
  bar.setAttribute("aria-label", "Boss HP "+bossNum(b.hp)+" of "+bossNum(b.maxHp)+" ("+pct+"%)");
  var fill = bossEl("i", "boss-hp-fill"); fill.style.width = pct+"%"; bar.appendChild(fill);
  var mark = bossEl("span", "boss-hp-mark"); mark.style.left = (rules.fightAt||15)+"%"; mark.setAttribute("aria-hidden", "true"); bar.appendChild(mark);
  card.appendChild(bar);
  card.appendChild(bossEl("div", "boss-hp-num", bossNum(b.hp)+" / "+bossNum(b.maxHp)+" HP · "+pct+"%"));

  var phase = bossEl("p", "boss-phase");
  if(b.phase === "down"){
    phase.textContent = "Defeated! "+(d.finalBlow ? bossWho(d.finalBlow)+" landed the final blow." : "")+" A new boss arrives on Monday (UTC).";
  } else if(b.phase === "fight"){
    phase.textContent = "It's weak enough to fight! Send a team of up to "+(rules.teamMax||6)+": each fight can take up to "+(rules.fightCap||5)+"% of its HP, and whoever takes the last HP lands the final blow.";
  } else {
    phase.textContent = "Everyone's merged PRs and multiplayer wins are wearing it down. At "+(rules.fightAt||15)+"% it can be fought.";
  }
  card.appendChild(phase);

  // You
  var src = you.sources || {}, stats = bossEl("div", "tcard-stats");
  function stat(label, val){ var x = bossEl("div"); x.appendChild(bossEl("small", null, label)); x.appendChild(bossEl("strong", null, val)); stats.appendChild(x); }
  stat("Your damage", bossNum(you.dmg)); stat("Rank", you.rank ? "#"+you.rank : "–");
  stat("From PRs", bossNum(src.pr)); stat("From wins", bossNum(src.win)); stat("From fights", bossNum(src.fight));
  if(b.phase === "fight") stat("Attempts today", (you.attemptsLeft|0)+" / "+(rules.fightsPerDay||3));
  card.appendChild(stats);

  if(b.phase === "fight"){
    var row = bossEl("div", "boss-actions");
    var go = bossBtn("Fight the boss", "hbtn primary boss-go", function(){ bossFightPick(host); });
    go.disabled = (you.attemptsLeft|0) <= 0;
    row.appendChild(go);
    if(go.disabled) row.appendChild(bossEl("span", "muted", "No attempts left today: back tomorrow (UTC)."));
    card.appendChild(row);
  }

  // Top contributors
  card.appendChild(bossEl("div", "tcard-sec", "Top damage this week"));
  if(!(d.top||[]).length) card.appendChild(bossEl("p", "muted", "Nobody has dented it yet: merge a PR or win a multiplayer game."));
  else {
    var ol = bossEl("ol", "boss-top");
    d.top.forEach(function(t){
      var li = bossEl("li"), nm = bossBtn(bossWho(t), "gb-who", function(){ if(typeof tcardOpen === "function") tcardOpen(t.userId); });
      nm.setAttribute("aria-label", bossWho(t)+": open trainer card");
      li.appendChild(nm); li.appendChild(bossEl("span", "boss-dmg", bossNum(t.dmg)));
      ol.appendChild(li);
    });
    card.appendChild(ol);
  }

  if(d.lastWeek){
    var lw = d.lastWeek;
    card.appendChild(bossEl("p", "muted boss-last", "Last week: "+(lw.name||"the boss")+(lw.defeated ? " was defeated"+(lw.finalBlow ? ", final blow by "+bossWho(lw.finalBlow) : "")+"." : " got away.")));
  }

  var how = bossEl("details", "boss-how");
  how.appendChild(bossEl("summary", null, "How it works"));
  [
    "Each merged PR deals "+(rules.prUnit||150)+" damage (up to "+(rules.prDay||5)+" a day per player). PRs are counted only if you turned on work signals and PR counting in Settings, and only the count is sent.",
    "Each multiplayer win (1st place with 2+ players) deals "+(rules.winUnit||50)+" (up to "+(rules.winDay||10)+" a day per player).",
    "PRs and wins can only take it down to "+(rules.fightAt||15)+"%. The rest is a fight: "+(rules.fightsPerDay||3)+" attempts a day, your team against a level-70 boss, up to "+(rules.fightCap||5)+"% of its HP each.",
    "A fight sends only your team's species, stages and forms. The boss's max HP grows with how many trainers were active last week."
  ].forEach(function(t){ how.appendChild(bossEl("p", null, t)); });
  card.appendChild(how);
  host.appendChild(card);
}

/* ---- fighting ---- */
function bossTeamSpecs(team){
  return (team||[]).slice(0, 6).map(function(u){
    u = u || {};
    return {sp:u.sp|0, st:Math.max(0, Math.min(4, u.st|0)), br:(typeof u.br === "number" && isFinite(u.br)) ? (u.br|0) : null,
            mg:(typeof u.mg === "string" && /^[a-z0-9-]{1,32}$/.test(u.mg)) ? u.mg : null, sh:!!u.sh};
  });
}
// The battle engine, the saved team and the Pokédex live with the Valley scripts.
function bossValley(){
  if(typeof valleyLoad !== "function") return Promise.reject(new Error("no valley"));
  return valleyLoad().then(function(){
    var H = window.HQV;
    if(!H || !H.pk) throw new Error("no battle engine");
    if(H.api && !H.api.save && typeof H.ready === "function") return H.ready().then(function(){ return H; });
    return H;
  });
}
function bossFightPick(host){
  if(BOSS.busy) return;
  BOSS.busy = true;
  host.textContent = "";
  host.appendChild(bossEl("p", "muted", "Getting your team ready…"));
  bossValley().then(function(H){ return H.pk.loadUnlocked().then(function(list){ return {H:H, list:list||[]}; }); }).then(function(r){
    var H = r.H, pk = H.pk;
    host.textContent = "";
    var box = bossEl("div", "boss-pick"); box.setAttribute("role", "region"); box.setAttribute("aria-label", "Pick your boss team");
    host.appendChild(box);
    function cancel(){ BOSS.busy = false; bossRender(host); var f = host.querySelector("button"); if(f) f.focus(); }
    if(!r.list.length){
      box.appendChild(bossEl("p", "muted", "You haven't unlocked any Pokémon yet: every session you run catches its species in the Pokédex."));
      box.appendChild(bossBtn("Back", "hbtn", cancel)); box.querySelector("button").focus(); return;
    }
    function confirm(){
      box.textContent = "";
      var team = pk.savedTeam();
      if(!team){ builder(); return; }
      box.appendChild(bossEl("div", "tcard-sec", "Your team"));
      var row = bossEl("ol", "boss-team");
      team.forEach(function(s){
        var m = pk.buildMon(s), li = bossEl("li", "boss-mon");
        li.appendChild(pk.spriteEl ? pk.spriteEl(m, false, null) : bossEl("span"));
        li.appendChild(bossEl("b", null, m.name)); li.appendChild(bossEl("small", "muted", "Lv"+m.lvl+" · "+m.types.join("/")));
        row.appendChild(li);
      });
      box.appendChild(row);
      var acts = bossEl("div", "boss-actions");
      var go = bossBtn("Fight with this team", "hbtn primary boss-go", function(){ bossFight(host, team); });
      acts.appendChild(go);
      acts.appendChild(bossBtn("Change team", "hbtn ghost", builder));
      acts.appendChild(bossBtn("Cancel", "hbtn ghost", cancel));
      box.appendChild(acts);
      go.focus();
    }
    function builder(){
      box.textContent = "";
      pk.teamBuilder(box, {onDone: function(saved){ if(saved || pk.savedTeam()) confirm(); else cancel(); }});
    }
    confirm();
  }).catch(function(){
    BOSS.busy = false; host.textContent = "";
    host.appendChild(bossEl("p", "muted", "The battle engine couldn't load. Try again from the Valley."));
    host.appendChild(bossBtn("Back", "hbtn", function(){ bossRender(host); }));
  });
}
function bossFight(host, team){
  var specs = bossTeamSpecs(team);
  if(!specs.length) return;
  // One request id per attempt: a retry after a dropped answer replays the same fight, never a 2nd one.
  if(!BOSS.rid) BOSS.rid = "boss-"+String(typeof newRequestId === "function" ? newRequestId() : Date.now()).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
  host.textContent = "";
  host.appendChild(bossEl("p", "muted", "Your team charges in…"));
  bossSay("Fight started");
  bossFetch("/api/arena/boss/fight", {method:"POST", headers:{"Content-Type":"application/json", "X-HQ-Token":CSRF},
                                      body: JSON.stringify({requestId:BOSS.rid, team:specs})}).then(function(res){
    if(res.code && res.code < 500) BOSS.rid = null;      // a definite answer: the next fight is a new one
    if(!res.ok){
      BOSS.busy = false;
      var msg = res.j.error || res.j.detail || "The Arena didn't answer.";
      if(typeof toast === "function") toast(msg); bossSay(msg);
      bossLoad(true).then(bossRenderAll); bossRender(host);
      return;
    }
    bossReplay(host, res.j);
  }, function(){
    BOSS.busy = false;
    if(typeof toast === "function") toast("The Arena didn't answer: try again (the same fight is replayed, never counted twice).");
    bossRender(host);
  });
}
function bossResult(host, r){
  var box = bossEl("div", "boss-result"); box.setAttribute("role", "status");
  var pct = bossPct(r.dmg, r.maxHp), line = "Your team dealt "+bossNum(r.dmg)+" damage ("+pct+"% of its HP).";
  box.appendChild(bossEl("h3", null, r.finalBlow ? "🏆 Final blow! You defeated the world boss!" : "Fight over"));
  box.appendChild(bossEl("p", null, line));
  box.appendChild(bossEl("p", "muted", "Boss HP now "+bossNum(r.hp)+" / "+bossNum(r.maxHp)+" · "+(r.attemptsLeft|0)+" attempt"+((r.attemptsLeft|0) === 1 ? "" : "s")+" left today."));
  box.appendChild(bossBtn("Back to the boss", "hbtn primary boss-go", function(){ BOSS.busy = false; bossLoad(true).then(bossRenderAll); bossRender(host); var f = host.querySelector("button"); if(f) f.focus(); }));
  host.appendChild(box);
  box.querySelector("button").focus();
  bossSay((r.finalBlow ? "Final blow! You defeated the world boss. " : "")+line);
  if(r.finalBlow && typeof confettiBurst === "function" && !bossCalm()) confettiBurst();
}
function bossReplay(host, r){
  var pk = window.HQV && HQV.pk;
  host.textContent = "";
  function done(){
    if(BOSS.scene){ try { BOSS.scene.destroy(); } catch(e){} BOSS.scene = null; }
    if(!host.isConnected){ BOSS.busy = false; return; }
    host.textContent = ""; bossResult(host, r);
  }
  if(!pk || !pk.Scene || !(r.team||[]).length || !r.boss){ done(); return; }
  var top = bossEl("div", "boss-actions");
  var skip = bossBtn("Skip to the result", "hbtn ghost", function(){ if(BOSS.scene) BOSS.scene.dead = true; done(); });
  top.appendChild(skip); host.appendChild(top);
  var sc = BOSS.scene = new pk.Scene(host, {});
  var view = {me:{active:0, team:r.team}, foe:{active:0, team:[r.boss]}};
  function who(side, name, intro){ return side === 1 ? (intro ? "The world boss " : "The boss ")+name : name; }
  try {
    if(pk.preload) pk.preload(r.team.concat([r.boss]));
    sc.setView(view);
    sc.intro([who(1, r.boss.name, true)+" appeared!", "Go! "+r.team[0].name+"!"])
      .then(function(){ return sc.dead ? null : sc.play(r.log||[], 0, who); })
      .then(function(){ if(BOSS.scene === sc && !sc.dead) done(); });
    if(sc.root && sc.root.focus) sc.root.focus();
  } catch(e){ done(); }
}

/* ---- the Compete panel and the standalone modal ---- */
function bossMount(el){
  if(!el) return;
  if(BOSS.hosts.indexOf(el) < 0) BOSS.hosts.push(el);
  var p = bossLoad(false);
  bossRender(el);
  p.then(bossRenderAll);
  if(!BOSS.timer) BOSS.timer = setInterval(function(){
    BOSS.hosts = BOSS.hosts.filter(function(h){ return h.isConnected; });
    if(!BOSS.hosts.length){ clearInterval(BOSS.timer); BOSS.timer = null; return; }
    if(!BOSS.busy && !document.hidden) bossLoad(true).then(bossRenderAll);
  }, 60000);
}
function bossUnmount(el){
  BOSS.hosts = BOSS.hosts.filter(function(h){ return h !== el && h.isConnected; });
  if(BOSS.scene && (!el || el.contains(BOSS.scene.root))){ try { BOSS.scene.destroy(); } catch(e){} BOSS.scene = null; BOSS.busy = false; }
}
(window.COMPETE_PANELS = window.COMPETE_PANELS || []).push({id:"boss", name:"World boss", icon:"🐞", order:20,
  mount:function(el){ bossMount(el); }, unmount:function(el){ bossUnmount(el); }});

function bossOpen(){
  if(BOSS.modal && BOSS.modal.isConnected){ BOSS.modal.classList.add("open"); return; }
  BOSS.lastFocus = document.activeElement;
  var back = bossEl("div", "tcard-back open boss-back"); back.setAttribute("aria-hidden", "false");
  var modal = bossEl("div", "tcard-modal boss-modal"); modal.setAttribute("role", "dialog"); modal.setAttribute("aria-modal", "true"); modal.setAttribute("aria-labelledby", "bossTitle");
  var top = bossEl("div", "tcard-top"), t = bossEl("b", null, "World boss"); t.id = "bossTitle";
  var close = bossBtn("✕", "hbtn icon ghost", bossClose); close.setAttribute("aria-label", "Close");
  top.appendChild(t); top.appendChild(close); modal.appendChild(top);
  var body = bossEl("div", "boss-body"); modal.appendChild(body);
  back.appendChild(modal);
  back.addEventListener("click", function(e){ if(e.target === back) bossClose(); });
  back.addEventListener("keydown", function(e){
    if(e.key === "Tab"){   // keep focus inside the dialog
      var f = modal.querySelectorAll('button:not([disabled]),summary,[tabindex="0"]');
      if(!f.length) return;
      if(e.shiftKey && document.activeElement === f[0]){ e.preventDefault(); f[f.length-1].focus(); }
      else if(!e.shiftKey && document.activeElement === f[f.length-1]){ e.preventDefault(); f[0].focus(); }
    }
    // keys typed in the dialog never switch views behind it
    if(/^[0-9a-zA-Z?\/]$/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) e.stopPropagation();
  });
  document.body.appendChild(back);
  BOSS.modal = back;
  bossMount(body);
  close.focus();
}
// Escape closes the dialog wherever focus is, unless a trainer card or the inventory sits on top of it
// (they stack above it and close first). Capture phase, so it runs before the page's own shortcuts.
function bossOverlayOpen(){
  return ["tcardBack", "invBack"].some(function(id){ var x = document.getElementById(id); return !!(x && x.classList.contains("open")); });
}
document.addEventListener("keydown", function(e){
  if(!BOSS.modal || !BOSS.modal.isConnected || bossOverlayOpen()) return;
  if(e.key === "Escape"){ e.preventDefault(); e.stopPropagation(); bossClose(); return; }
  // With focus lost to <body>, a view shortcut must not switch views under the open dialog.
  if(!BOSS.modal.contains(e.target) && !e.metaKey && !e.ctrlKey && !e.altKey && /^[0-9a-zA-Z?\/]$/.test(e.key)) e.stopPropagation();
}, true);
function bossClose(){
  var back = BOSS.modal; if(!back) return;
  var body = back.querySelector(".boss-body");
  bossUnmount(body);
  if(back.parentNode) back.parentNode.removeChild(back);
  BOSS.modal = null;
  if(BOSS.lastFocus && BOSS.lastFocus.focus){ try { BOSS.lastFocus.focus(); } catch(e){} }
}
window.bossOpen = bossOpen;

/* ---- trainer card: slayer badges ---- */
(window.TCARD_EXTRAS = window.TCARD_EXTRAS || []).push(function(box, prof){
  prof = prof || {};
  var u = prof.isYou ? "me" : String(prof.userId||"");
  if(!u) return;
  var sec = bossEl("div", "boss-badges"); box.appendChild(sec);
  bossFetch("/api/arena/boss/badges?u="+encodeURIComponent(u)).then(function(res){
    if(!res.ok || !res.j) { sec.remove(); return; }
    var slayer = (res.j.slayer||[]).filter(function(w){ return BOSS_WEEK_RE.test(String(w)); }), n = res.j.participated|0;
    if(!slayer.length && !n){ sec.remove(); return; }
    sec.appendChild(bossEl("div", "tcard-sec", "World boss"));
    var chips = bossEl("div", "chips");
    slayer.slice(-6).forEach(function(w){ var c = bossEl("span", "tcard-trophy boss-slayer", "🗡 Slayer · "+w); c.setAttribute("aria-label", "Boss slayer, week "+w); chips.appendChild(c); });
    if(slayer.length > 6) chips.appendChild(bossEl("span", "tcard-trophy", "+"+(slayer.length-6)+" more"));
    if(n) chips.appendChild(bossEl("span", "tcard-trophy", "Fought in "+n+" week"+(n === 1 ? "" : "s")));
    sec.appendChild(chips);
    if(prof.isYou) sec.appendChild(bossBtn("Open the world boss", "hbtn ghost boss-open", function(){ if(typeof tcardClose === "function") tcardClose(); bossOpen(); }));
  }, function(){ sec.remove(); });
});
