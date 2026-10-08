/* ---- self-update: pull the latest commits and restart the server ---- */
var UPDATE = {st:null, busy:false};
function updatePaint(){
  var b=$("updateBtn"), l=$("updateLbl"); if(!b||!l) return;
  var st=UPDATE.st, n=(st && st.ok && st.behind)|0, stale=!!(st && st.stale) && !n;
  b.classList.toggle("has-update", n>0 || stale); b.classList.toggle("busy", UPDATE.busy);
  l.textContent = UPDATE.busy ? "Updating…" : n>0 ? "Update · "+n+" new" : stale ? "Restart · new code" : "Update";
  b.title = !st ? "Pull the latest Claude HQ and restart"
    : stale ? "The Claude HQ code on disk is newer than the running server. Click to restart it."
    : !st.ok ? "Update unavailable: "+(st.error||"unknown")
    : n>0 ? n+" new commit"+(n>1?"s":"")+" on "+st.upstream+":\n"+(st.commits||[]).join("\n")
    : "Up to date ("+st.head+" on "+st.branch+"). Click to check again.";
}
function updateCheck(force){
  return fetch("/api/update"+(force?"?force=1":""),{cache:"no-store"}).then(function(r){ return r.json(); })
    .then(function(j){ UPDATE.st=j; updatePaint(); return j; }).catch(function(){ return null; });
}
function updateWaitForRestart(){
  var tries=0;
  (function poll(){
    tries++;
    fetch("/api/update",{cache:"no-store"}).then(function(r){ if(!r.ok) throw 0; location.reload(); })
      .catch(function(){ if(tries<90) setTimeout(poll, 1000); else { UPDATE.busy=false; updatePaint(); toast("⚠ Claude HQ didn’t come back. Start it again from a terminal.","ach"); } });
  })();
}
function updateRun(){
  if(UPDATE.busy) return;
  updateCheck(true).then(function(st){
    if(!st){ toast("⚠ Couldn’t check for updates","ach"); return; }
    if(st.stale && !st.behind){
      if(!confirm("The Claude HQ code on disk is newer than the running server. Restart Claude HQ now?")) return;
      UPDATE.busy=true; updatePaint();
      fetch("/api/update",{method:"POST",headers:{"Content-Type":"application/json","X-HQ-Token":CSRF},body:"{}"})
        .then(function(r){ return r.json(); })
        .then(function(j){ if(!j.restarting){ UPDATE.busy=false; updatePaint(); toast("⚠ "+(j.error||"Restart failed"),"ach"); return; }
          toast("↻ Restarting Claude HQ…","level"); setTimeout(updateWaitForRestart, 2500); })
        .catch(function(){ UPDATE.busy=false; updatePaint(); toast("⚠ Restart request failed","ach"); });
      return;
    }
    if(!st.ok){ toast("⚠ "+(st.error||"Update unavailable"),"ach"); return; }
    if(!st.behind){ toast("✓ Claude HQ is up to date ("+st.head+")","level"); return; }
    if(st.dirty){ toast("⚠ Local changes in the Claude HQ folder: commit or stash them first","ach"); return; }
    var list=(st.commits||[]).slice(0,8).join("\n");
    if(!confirm("Pull "+st.behind+" new commit"+(st.behind>1?"s":"")+" from "+st.upstream+" and restart Claude HQ?\n\n"+list)) return;
    UPDATE.busy=true; updatePaint();
    fetch("/api/update",{method:"POST",headers:{"Content-Type":"application/json","X-HQ-Token":CSRF},body:"{}"})
      .then(function(r){ return r.json().then(function(j){ return {ok:r.ok,j:j}; }); })
      .then(function(res){
        if(!res.ok || !res.j.updated){ UPDATE.busy=false; updatePaint(); toast("⚠ "+(res.j.error||"Nothing to update"),"ach"); return; }
        toast("⬇ Updated "+res.j.from+" → "+res.j.to+". Restarting…","level");
        setTimeout(updateWaitForRestart, 2500);
      })
      .catch(function(){ UPDATE.busy=false; updatePaint(); toast("⚠ Update request failed","ach"); });
  });
}
(function(){ var b=$("updateBtn"); if(b) b.addEventListener("click", updateRun);
  setTimeout(function(){ updateCheck(false); }, 4000);
  setInterval(function(){ if(!document.hidden) updateCheck(false); }, 60*1000); })();

function postAction(body){
  return fetch("/api/action",{
    method:"POST",
    headers:{"Content-Type":"application/json","X-HQ-Token":CSRF},
    body:JSON.stringify(body)
  }).then(function(r){ return r.json().then(function(j){ return {ok:r.ok,j:j}; }); });
}
function sessResume(sid){
  toast("▶ Resuming…","level");
  postAction({action:"resume",sessionId:sid}).then(function(r){
    toast(r.ok?"▶ Terminal opened":"⚠ "+(r.j.error||"resume failed"), r.ok?"level":"ach");
  }).catch(function(){ toast("⚠ resume failed","ach"); });
}
function sessReveal(sid){
  postAction({action:"reveal",sessionId:sid}).then(function(r){
    toast(r.ok?"📂 Revealed in Finder":"⚠ "+(r.j.error||"reveal failed"), r.ok?"level":"ach");
  }).catch(function(){ toast("⚠ reveal failed","ach"); });
}
function sessRename(sess){
  var cur=sess.alias||"";
  var v=window.prompt('Rename this session in Claude HQ\n(leave blank to reset to the auto title):', cur);
  if(v===null) return;
  postMeta({sessionId:sess.sessionId, name:v.trim()}).then(function(r){
    if(r.ok){ toast(v.trim()?("✏️ Renamed to "+v.trim()):"↩ Reset to auto title","level"); forceRefresh(); }
    else toast("⚠ "+((r.j&&r.j.error)||"rename failed"),"ach");
  }).catch(function(){ toast("⚠ rename failed","ach"); });
}
function sessClose(sess){
  if(!sess.pid){ toast("⚠ no pid to close","ach"); return; }
  if(!window.confirm('Close "'+(sess.title||"this tab")+'"?\nThis stops the Claude process (pid '+sess.pid+').')) return;
  postAction({action:"close",pid:sess.pid}).then(function(r){
    toast(r.ok?"✕ Closed tab":"⚠ "+(r.j.error||"close failed"), r.ok?"level":"ach");
    if(r.ok) setTimeout(forceRefresh, 600);
  }).catch(function(){ toast("⚠ close failed","ach"); });
}
var PREV = {};                 // sessionId -> {status, alert}
var NOTIF_ON = localStorage.getItem("hq_notif") === "1";
var CHIME_ON = localStorage.getItem("hq_chime") !== "0"; // default on
var audioCtx = null;

function fmtTok(n){
  n = n||0;
  if(n>=1e9) return (n/1e9).toFixed(n>=1e10?0:1)+"B";
  if(n>=1e6) return (n/1e6).toFixed(n>=1e7?0:1)+"M";
  if(n>=1e3) return Math.round(n/1e3)+"k";
  return String(n);
}
// Turn a project-dir slug ("-Users-adapalokesh-Desktop-mahila-control-center")
// into a readable label. Slugs are lossy (real "/" and "-" both became "-"),
// so we only strip the "-Users-<user>" prefix and keep the rest verbatim.
function prettyFolder(slug){
  if(!slug) return "~";
  var m = String(slug).replace(/^-Users-[^-]+-?/, "");
  return m ? m : "~ (home)";
}
// A project-dir slug looks like "-Users-<user>-…"; live session folders are bare
// basenames (no leading "-"). /api/project only accepts real slugs, so gate on this.
function looksLikeSlug(f){ return typeof f==="string" && /^-/.test(f); }
function fmtCost(n){
  n = n||0;
  if(n>=100) return "$"+Math.round(n).toLocaleString();
  if(n>=1) return "$"+n.toFixed(2);
  return "$"+n.toFixed(2);
}
function fileAction(a){
  a = (a||"").toLowerCase();
  if(a.indexOf("write")>=0) return "write";
  if(a.indexOf("edit")>=0||a.indexOf("update")>=0||a.indexOf("notebook")>=0) return "edit";
  if(a.indexOf("read")>=0) return "read";
  return "other";
}

function renderSeason(s){
  if(!s) return;
  // your level: the Arena's HQ level when paired (the same number your building, trainer card and
  // friends see), else the 30-day season; the season's own level is named beside it
  var me = (typeof myLevel==="function") ? myLevel() : {level:s.level, rank:s.rank, pct:s.pct, xpIntoLevel:s.xpIntoLevel, xpForLevel:s.xpForLevel};
  $("lvlNum").textContent = me.level!=null? me.level : "—";
  var pct = Math.max(0,Math.min(100, me.pct||0));
  $("ring").style.setProperty("--pct", pct);
  $("rank").firstChild.textContent = me.rank || "Adventurer";
  $("ranksub").textContent = me.hq ? "HQ level · 30-day season Lv "+(s.level!=null?s.level:"—") : "Season progress";
  $("xpText").textContent = (me.xpIntoLevel||0).toLocaleString()+" / "+(me.xpForLevel||0).toLocaleString()+" XP";
  $("xpFill").style.width = pct+"%";

  var tt = s.totals||{};
  setTile("t_prompts", tt.prompts); setTile("t_tools", tt.tools);
  setTile("t_artifacts", tt.artifacts); setTile("t_days", tt.activeDays);

  // calendar
  var grid = $("calGrid"); grid.innerHTML="";
  var cal = s.calendar||[];
  cal.forEach(function(c){
    var cell = el("div","cell h"+(c.heat||0));
    if(c.today) cell.classList.add("today");
    cell.title = c.date+" · "+(c.count||0)+" msgs";
    grid.appendChild(cell);
  });
  $("streak").textContent = s.streak!=null? s.streak : "—";
  $("bestStreak").textContent = s.bestStreak!=null? s.bestStreak : "—";
  $("calSub").textContent = cal.length? "" : "";

  // achievements
  var strip = $("achStrip"); strip.innerHTML="";
  var ach = s.achievements||[];
  var un = 0;
  ach.forEach(function(a){
    if(a.unlocked) un++;
    var b = el("div","badge "+(a.unlocked?"on":"off"));
    var ic = el("div","ic"); ic.textContent = a.icon||"⭐"; b.appendChild(ic);
    var body = el("div"); body.style.minWidth="0"; body.style.flex="1";
    var nm = el("div","nm"); nm.textContent = a.name||"";
    if(a.unlocked){ var ck=el("span","check"); ck.textContent="✓"; nm.appendChild(ck); }
    body.appendChild(nm);
    var ds = el("div","ds"); ds.textContent = a.desc||""; body.appendChild(ds);
    if(!a.unlocked){
      var pb=el("div","pbar"); var sp=el("span");
      sp.style.width = Math.round(Math.max(0,Math.min(1,a.progress||0))*100)+"%";
      pb.appendChild(sp); body.appendChild(pb);
    }
    b.appendChild(body);
    strip.appendChild(b);
  });
  $("achSub").textContent = ach.length? (un+"/"+ach.length+" unlocked") : "";
}
function setTile(id,v){ var e=$(id); e.classList.remove("skel"); e.textContent = (v==null?0:v).toLocaleString(); }

var GROUPS = [
  {key:"needs", label:"Needs you", dot:"needs"},
  {key:"working", label:"Working", dot:"working"},
  {key:"idle", label:"Idle", dot:"idle"},
  {key:"stale", label:"Stale", dot:"stale"}
];

function matches(sess){
  if(!QUERY) return true;
  var q = QUERY.toLowerCase();
  var hay = [sess.title,sess.firstPrompt,sess.lastPrompt,sess.lastReply,sess.folder,sess.name]
    .concat(sess.tags||[]).concat([sess.note])
    .filter(Boolean).join(" ").toLowerCase();
  return hay.indexOf(q)>=0;
}

/* Roving-tabindex + arrow-key navigation for a grid of focusable items.
   Only one item is in the Tab order at a time; Arrow/Home/End move focus;
   Enter/Space activation is left to each item's own handler. Column count is
   inferred from the rendered layout (items sharing the first row's offsetTop). */
function setupRoving(container, selector){
  if(!container) return;
  var items=Array.prototype.slice.call(container.querySelectorAll(selector));
  if(!items.length) return;
  items.forEach(function(it,i){ it.tabIndex = i===0?0:-1; });
  if(container._rovingBound) return;   // bind the key handler once per container element
  container._rovingBound=true;
  container.addEventListener("keydown",function(e){
    if(["ArrowRight","ArrowLeft","ArrowUp","ArrowDown","Home","End"].indexOf(e.key)<0) return;
    if(e.metaKey||e.ctrlKey||e.altKey) return;   // Cmd-Left/Right = browser back/forward
    var its=Array.prototype.slice.call(container.querySelectorAll(selector));
    if(!its.length) return;
    var idx=its.indexOf(document.activeElement);
    if(idx<0) return;                  // focus is inside a child control, not on an item
    var cols=1, top=its[0].offsetTop;
    for(var i=1;i<its.length;i++){ if(its[i].offsetTop===top) cols++; else break; }
    var next=idx;
    if(e.key==="ArrowRight") next=idx+1;
    else if(e.key==="ArrowLeft") next=idx-1;
    else if(e.key==="ArrowDown") next=Math.min(its.length-1, idx+cols);
    else if(e.key==="ArrowUp") next=Math.max(0, idx-cols);
    else if(e.key==="Home") next=0;
    else if(e.key==="End") next=its.length-1;
    if(next<0||next>=its.length||next===idx) { if(next===idx){ e.preventDefault(); } return; }
    e.preventDefault();
    its.forEach(function(it){ it.tabIndex=-1; });
    its[next].tabIndex=0; its[next].focus();
  });
}

var STALE_OPEN = false;  // persisted across re-renders so live updates don't snap the Stale section shut
function renderThinking(sessions){
  var b=$("thinkingNow"); if(!b) return;
  var n=(sessions||[]).filter(function(x){ return x.status==="working"; }).length;
  b.classList.toggle("hidden", n===0);
  var lo=$("logoOrb"); if(lo){ lo.dataset.speed = n>0 ? "1" : "0.45"; }
  $("thinkingTxt").textContent = n+" thinking";
  b.setAttribute("aria-label", n+" session"+(n===1?"":"s")+" thinking — show them");
}
$("thinkingNow").addEventListener("click",function(){
  setView("live"); FILTER="working";
  Array.prototype.forEach.call($("filterChips").children,function(c){ c.classList.toggle("active", c.getAttribute("data-filter")==="working"); });
  if(STATE) renderParty(STATE.sessions);
});
var PARTY_SIG=null;
function partySig(sessions){
  // Only fields that affect the rendered cards — NOT volatile ones (now/ageSecs/tokens)
  // so the party isn't rebuilt (which restarts every animated sprite) each SSE tick.
  // Energy: only the coarse state is here (it changes the sprite look and the Snack button);
  // the meter's numbers are patched in place by patchEnergyRows. The store being up matters only
  // to a card that shows the Snack/Revive button (a creature that isn't rested), so it's keyed per
  // card: a store flip while every creature is rested rebuilds nothing.
  var store=PANTRY.store==="ok";
  var parts=(sessions||[]).map(function(s){ var c=s.creature||{}, f=fzOf(c);
    return [s.id,s.status+(s.alertKind||"")+(s.likelyAwaiting?"~":""),s.title,s.alias||"",s.pinned?1:0,(s.tags||[]).join(","),s.note||"",s.folder||"",
            c.species,creatureStage(c),c.shiny?1:0,(EVO_CHOICE[s.sessionId||s.id]||{}).branchDex||"",(EVO_CHOICE[s.sessionId||s.id]||{}).megaSlug||"",f?(f.state+(f.mayFaint?"!":"")+(store && f.state!=="rested"?"$":"")):""].join(""); });
  // Text that changes every tick (age, prompt count, tokens, the in-flight line...) is patched in
  // place by patchCards; only when a volatile value REORDERS the cards (the Recent/Tokens sorts)
  // does the order itself go into the signature.
  var order="";
  if(SORT==="recent" || SORT==="tokens"){
    order=(sessions||[]).slice().sort(SORT==="recent"
      ? function(a,b){ return (a.ageSecs==null?1e12:a.ageSecs)-(b.ageSecs==null?1e12:b.ageSecs); }
      : function(a,b){ return ((b.tokens&&b.tokens.output)||0)-((a.tokens&&a.tokens.output)||0); })
      .map(function(s){ return s.id; }).join(",");
  }
  return [QUERY,SORT,FILTER,FILTERTAG,FILTERFOLDER,STALE_OPEN?1:0,cfg().creaturePack,PANTRY.store==="ok"?1:0].join("|")+"||"+parts.join("")+"||"+order;
}
// Keep each card's energy meter current without rebuilding the party (a rebuild restarts
// every animated sprite).
function patchEnergyRows(sessions){
  var party=$("party"); if(!party) return;
  var rows=party.querySelectorAll(".enrow"); if(!rows.length) return;
  var by={}; (sessions||[]).forEach(function(s){ if(s.sessionId) by[s.sessionId]=s; });
  Array.prototype.forEach.call(rows,function(row){
    var card=row.closest(".card"); if(!card) return;
    var s=by[card.getAttribute("data-sid")]; if(!s) return;
    var f=fzOf(s.creature); if(!f || f.state==="rested") return;   // a state change rebuilds via partySig
    var h=energyRowHTML(f); if(card._enh===h) return;
    row.outerHTML=h; card._enh=h;
    card.setAttribute("aria-label", cardAriaLabel(s));
  });
}
function renderParty(sessions){
  renderThinking(sessions);
  var sig=partySig(sessions);
  if(sig===PARTY_SIG){ patchEnergyRows(sessions); patchCards(sessions); return; }   // nothing card-relevant changed -> don't rebuild (avoids sprite flicker)
  PARTY_SIG=sig;
  var party = $("party"); party.innerHTML="";
  sessions = sessions||[];
  var buckets = {needs:[],working:[],idle:[],stale:[]};
  sessions.forEach(function(s){ var k=s.status; if(!buckets[k]) buckets[k]=[]; if(buckets[k]) buckets[k].push(s); });

  var shownTotal = 0;
  GROUPS.forEach(function(g){
    if(FILTER!=="all" && FILTER!==g.key) return;
    var all = buckets[g.key]||[];
    var vis = all.filter(matches).filter(matchesTag).filter(matchesFolder);
    if(SORT==="recent"){
      vis = vis.slice().sort(function(a,b){ return (a.ageSecs==null?1e12:a.ageSecs)-(b.ageSecs==null?1e12:b.ageSecs); });
    } else if(SORT==="tokens"){
      vis = vis.slice().sort(function(a,b){ return ((b.tokens&&b.tokens.output)||0)-((a.tokens&&a.tokens.output)||0); });
    }
    // pinned cards float to the top of their group (stable over prior sort)
    vis = vis.slice().sort(function(a,b){ return (b.pinned?1:0)-(a.pinned?1:0); });
    if(all.length===0) return;
    shownTotal += vis.length;

    var grp = el("div","grp");
    if(g.key==="stale"){
      var det = el("details","stalewrap");
      det.open = STALE_OPEN;
      var sum = el("summary");
      sum.innerHTML = '<span class="dot '+g.dot+'"></span>'+esc(g.label)+
        ' <span class="count-pill">'+vis.length+'</span> <span class="hint" style="font-weight:500;color:var(--faint)">incl. past sessions</span>';
      det.appendChild(sum);
      var cards = el("div","cards");
      // Perf: with archived history the stale list can be large, so only build its
      // cards while the section is open; when collapsed just show the count.
      function fillStale(){ cards.innerHTML=""; vis.forEach(function(s){ cards.appendChild(buildCard(s)); }); setupRoving(cards, ".card"); }
      if(STALE_OPEN) fillStale();
      det.addEventListener("toggle",function(){
        STALE_OPEN = det.open;
        if(det.open && !cards.firstChild) fillStale();
      });
      det.appendChild(cards);
      grp.appendChild(det);
    } else {
      var head = el("div","ghead");
      head.innerHTML = (g.dot==="working" ? orb("sm") : '<span class="dot '+g.dot+'"></span>')+esc(g.label)+
        ' <span class="count-pill">'+vis.length+'</span>';
      grp.appendChild(head);
      var cards = el("div","cards");
      vis.forEach(function(s){ cards.appendChild(buildCard(s)); });
      setupRoving(cards, ".card");
      grp.appendChild(cards);
      if(vis.length===0) grp.classList.add("hidden");
    }
    party.appendChild(grp);
  });

  $("totalCount").textContent = sessions.length+" session"+(sessions.length===1?"":"s");
  $("emptyState").classList.toggle("hidden", !(sessions.length===0 || shownTotal===0));
}

// The energy meter's words: what state it's in and how long a break it needs.
function energyLabel(f){
  var pct=fzPct(f), rm=fzMins(f.restMins);
  if(f.state==="unconscious") return f.phase==="resting" ? "Fainted \u00B7 resting \u00B7 wakes in ~"+rm+"m"
                                                          : "Fainted \u00B7 wakes after a ~"+rm+"m break";
  if(f.phase==="resting" && f.state!=="rested") return "Energy "+pct+"% \u00B7 resting \u00B7 rested in ~"+rm+"m";
  if(f.mayFaint) return "Energy "+pct+"% \u00B7 exhausted, may faint";
  if(f.state==="fatigued") return "Energy "+pct+"% \u00B7 fatigued \u00B7 ~"+rm+"m break";
  if(f.state==="tired") return "Energy "+pct+"% \u00B7 tired";
  return "Energy "+pct+"%";
}
// A role=meter bar (text always goes with the colour). state is one of FZ_STATES, numbers are coerced.
function energyMeterHTML(f, label){
  var pct=fzPct(f);
  return '<div class="enrow '+f.state+((f.mayFaint||f.state==="unconscious")?' risk':'')+'">'+
    '<div class="enbar" role="meter" aria-label="Energy" aria-valuemin="0" aria-valuemax="100" aria-valuenow="'+pct+'" aria-valuetext="'+pct+'% energy, '+esc(fzLabel(f.state).toLowerCase())+'">'+
    '<span style="width:'+pct+'%"></span></div><span class="enlbl">'+esc(label)+'</span></div>';
}
function energyRowHTML(f){ return energyMeterHTML(f, energyLabel(f)); }
function cardAriaLabel(s){
  var cr=s.creature||{}, f=fzOf(cr);
  var st=(s.status||""), stCap=st ? st.charAt(0).toUpperCase()+st.slice(1) : "Session";
  var fz = (!f || f.state==="rested") ? "" : f.state==="unconscious" ? ", fainted"
         : f.state==="fatigued" ? ", fatigued, energy "+fzPct(f)+"%" : ", tired";
  return stCap+": "+(s.title||"Untitled session")+", "+
    creatureSpecies(cr)+", "+creatureType(cr)+", "+creatureStageName(cr)+
    (cr.shiny?", shiny":"")+fz+(s.alert?" \u2014 "+s.alert:"")+". Activate to open details.";
}
function buildCard(s){
  var card = el("div","card "+s.status);
  var cr = s.creature||{};
  var hue = (cr.hue!=null?cr.hue:220);
  var fz = fzOf(cr);
  if(s.sessionId) card.setAttribute("data-sid", s.sessionId);
  if(s.pinned) card.classList.add("pinned");
  if(s.stuck) card.classList.add("stuckcard");
  if(s.likelyAwaiting){ var lw=el("div","stuckmark"); lw.innerHTML=ico("alert","sm")+"permission?"; lw.title=s.likelyAwaiting; card.appendChild(lw); }

  if(s.status==="stale"){ var z=el("div","snooze"); z.textContent="💤"; card.appendChild(z); }
  if(s.stuck){ var sm=el("div","stuckmark"); sm.innerHTML=ico("alert","sm")+"stuck?"; sm.title=s.stuckReason||"May be stuck"; card.appendChild(sm); }

  var chead = el("div","chead");
  var av = el("div","avatar");
  paintCreature(av, cr, 46);
  chead.appendChild(av);

  var meta = el("div","meta");
  var title = el("div","ctitle"); title.textContent = s.title || "Untitled session"; meta.appendChild(title);
  var sub = el("div","csub");
  var count = (s.promptCount!=null?s.promptCount:0);
  var folderHTML = looksLikeSlug(s.folder)
    ? '<span class="proj-openbtn" data-projfolder="'+esc(s.folder)+'" role="button" tabindex="0" title="Open project deep-dive">'+esc(prettyFolder(s.folder))+'</span>'
    : esc(s.folder||"~");
  sub.innerHTML = folderHTML+' · <span class="handle">'+esc(s.name||s.id||"?")+'</span> · '+
    '<span data-role="pc">'+esc(cardPromptsText(s))+'</span> · <span data-role="age">'+esc(cardAgeText(s))+'</span>';
  (function(){ var fb=sub.querySelector("[data-projfolder]"); if(fb){
    var slug=fb.getAttribute("data-projfolder");
    fb.addEventListener("click",function(e){ e.stopPropagation(); openProject(slug); });
    fb.addEventListener("keydown",function(e){ if(e.key==="Enter"||e.key===" "){ e.preventDefault(); e.stopPropagation(); openProject(slug); } });
  } })();
  meta.appendChild(sub);
  chead.appendChild(meta);

  if(s.status==="needs"){ var nb=el("div","needbadge"); nb.textContent=s.alertKind==="question"?"Question":s.alertKind==="plan"?"Plan approval":"Needs you"; nb.title=s.alert||"Needs your input"; chead.appendChild(nb); }
  card.appendChild(chead);

  // evolution: species + type badge + stage + evolve progress bar
  var evo = el("div","evowrap");
  evo.innerHTML =
    '<div class="crline"><span class="species">'+esc(creatureSpecies(cr))+'</span>'+typeBadgeHTML(cr)+
    '<span class="stagepill">'+esc(creatureStageName(cr))+(cr.shiny?' <span class="shinystar" title="Shiny">✦</span>':'')+'</span></div>'+
    evobarHTML(cr);
  if(fz && fz.state!=="rested"){ card._enh=energyRowHTML(fz); evo.insertAdjacentHTML("beforeend", card._enh); }
  card.appendChild(evo);

  if(s.status==="working"){
    var inf = el("div","inflight"+(s.now?"":" thinking"));
    inf.setAttribute("data-role","now");
    inf.innerHTML = orb("sm", orbStateFor(s.now));
    var t = el("span"); t.setAttribute("data-role","nowtxt"); t.textContent = s.now || "Thinking…"; inf.appendChild(t);
    card.appendChild(inf);
  }

  // The parts below change while a session runs (new prompts/replies, links, tokens, the 24h spark)
  // but are not in partySig, so patchCards refreshes each in place, keyed so it only touches a part
  // whose inputs changed.
  var lines = el("div","lines"); lines.setAttribute("data-role","lines");
  fillCardLines(lines, s); card._linesKey = cardLinesKey(s);
  card.appendChild(lines);

  var pills = el("div","pills"); pills.setAttribute("data-role","links");
  fillCardLinks(pills, s); card._linksKey = cardLinksKey(s);
  card.appendChild(pills);

  var foot = el("div","cfoot"); foot.setAttribute("data-role","foot");
  fillCardFoot(foot, s); card._footKey = cardFootKey(s);

  var tags = s.tags||[];
  if(tags.length || (s.note&&s.note.trim())){
    var tr = el("div","tagrow");
    tags.forEach(function(tg){
      var c = el("span","tagchip"); c.textContent = "#"+tg; c.title = "Filter by "+tg;
      c.addEventListener("click",function(e){ e.stopPropagation(); setTagFilter(tg); });
      tr.appendChild(c);
    });
    if(s.note && s.note.trim()){
      var nb = el("span","tagchip"); nb.textContent = "📝 note"; nb.title = s.note;
      nb.addEventListener("click",function(e){ e.stopPropagation(); openDrawer(s); });
      tr.appendChild(nb);
    }
    card.appendChild(tr);
  }
  card.appendChild(foot);

  var acts = el("div","cardactions");
  function mkAct(label,cls,fn){
    var b = el("button","actbtn"+(cls?" "+cls:"")); b.type="button"; setActLabel(b,label);
    b.addEventListener("click",function(e){ e.stopPropagation(); fn(); });
    acts.appendChild(b);
    return b;
  }
  (function(){
    var b = el("button","actbtn"+(s.pinned?" on":"")); b.type="button";
    setActLabel(b, s.pinned?"📌 Pinned":"📌 Pin");
    b.setAttribute("aria-pressed", s.pinned?"true":"false");
    b.addEventListener("click",function(e){ e.stopPropagation(); togglePin(s); });
    acts.appendChild(b);
  })();
  // Snack / Revive open the drawer's care section: cards rebuild, so there's no in-card picker.
  if(fz && fz.state!=="rested" && PANTRY.store==="ok"){
    var ko=fz.state==="unconscious";
    var cb=mkAct(ko?"\uD83E\uDDC3 Revive":"\uD83C\uDF59 Snack",null,function(){ openDrawer(card._s||s,{care:true}); });
    cb.title = ko ? "Wake "+creatureSpecies(cr)+" with a revive item" : "Give "+creatureSpecies(cr)+" a snack";
    cb.setAttribute("aria-label", cb.title);
    cb.setAttribute("data-act","care");   // closeDrawer finds it again on the rebuilt card
  }
  mkAct("✏️ Rename",null,function(){ sessRename(s); });
  mkAct("▶ Resume",null,function(){ sessResume(s.sessionId); });   // works for archived too
  if(s.kind!=="archived"){ mkAct("📂 Reveal",null,function(){ sessReveal(s.sessionId); }); }
  if(s.status==="working"){ mkAct("⤢ Focus",null,function(){ openFocus(s.sessionId); }); }
  if(s.kind==="interactive" && s.pid){ mkAct("✕ Close","danger",function(){ sessClose(s); }); }
  card.appendChild(acts);

  card.tabIndex = 0;
  card.setAttribute("role","button");
  card.setAttribute("aria-label", cardAriaLabel(s));
  card._s = s;   // patchCards swaps in each tick's session so the drawer opens on fresh data
  function open(){ openDrawer(card._s||s); }
  card.addEventListener("click",function(e){
    if(e.target.closest("a")||e.target.closest("button")) return;
    open();
  });
  // Only keys on the card itself: Enter/Space on a button inside it (Snack, Rename, More, ...) or a
  // link must do that control's own thing, not open the plain drawer and cancel its click.
  card.addEventListener("keydown",function(e){
    if(e.target!==card) return;
    if(e.key==="Enter"||e.key===" "){ e.preventDefault(); open(); }
  });
  return card;
}

// ---- the volatile parts of a party card (built by buildCard, refreshed in place by patchCards) ----
function cardPromptsText(s){ var n=(s&&s.promptCount!=null)?(s.promptCount|0):0; return n+" prompt"+(n===1?"":"s"); }
function cardAgeText(s){ return fmtAge((s||{}).ageSecs)+" ago"; }
function cardLinesKey(s){ s=s||{}; return [s.firstPrompt||"", s.lastPrompt||"", s.lastReply||""].join("\u0001"); }
function fillCardLines(box, s){
  box.innerHTML="";
  if(s.firstPrompt) box.appendChild(mkLine("You",s.firstPrompt,true,false));
  if(s.lastPrompt && s.lastPrompt!==s.firstPrompt) box.appendChild(mkLine("Latest",s.lastPrompt,false,false));
  if(s.lastReply) box.appendChild(mkLine("Claude",s.lastReply,true,true));
}
function cardLinksKey(s){ return JSON.stringify(((s||{}).links||[]).map(function(l){ l=l||{}; return [l.type||"", l.url||"", l.label||""]; })); }
function fillCardLinks(box, s){
  var links=(s&&s.links)||[];
  box.innerHTML="";
  links.forEach(function(l){
    l=l||{};
    var a = el("a","pill "+(l.type==="pr"?"pr":"artifact"));
    a.href = l.url||"#"; a.target="_blank"; a.rel="noopener";
    a.innerHTML = ico(l.type==="pr"?"trend":"sparkles","sm")+'<span>'+esc(l.label||l.type||"link")+'</span>';
    box.appendChild(a);
  });
  box.classList.toggle("hidden", !links.length);
}
function cardFootKey(s){ s=s||{}; var tk=s.tokens||{};
  return JSON.stringify([s.spark||[], tk.output||0, tk.estCostUSD||0, tk.total||0, tk.model||""]); }
function fillCardFoot(foot, s){
  var sp12=(s&&s.spark)||[], tk=(s&&s.tokens)||{};
  foot.innerHTML="";
  if(sp12.length){
    var mx = Math.max.apply(null, sp12.concat([1]));
    var sw = el("div","spark"); sw.title = "24h activity";
    sw.setAttribute("aria-hidden","true");
    sp12.forEach(function(v){
      var b = el("i"); b.style.height = Math.max(1, Math.round(((v||0)/mx)*18))+"px"; sw.appendChild(b);
    });
    foot.appendChild(sw);
  }
  if((tk.output||0)>0 || (tk.estCostUSD||0)>0){
    var chip = el("div","tokchip");
    chip.textContent = fmtTok(tk.output)+" out · ≈"+fmtCost(tk.estCostUSD);
    chip.title = (tk.output||0).toLocaleString()+" output tokens · "+fmtTok(tk.total)+
      " processed (incl. cache) · list-price est."+(tk.model?" · "+tk.model:"");
    foot.appendChild(chip);
  }
  foot.classList.toggle("hidden", !foot.firstChild);
}
function setText(node, txt){ if(node && node.textContent!==txt) node.textContent=txt; }
// Refresh every card's volatile text in place (what partySig leaves out so animated sprites aren't
// restarted each tick): prompt count, age, the in-flight tool line, the prompt/reply lines, links,
// tokens and the spark. Each part is only touched when its own inputs changed.
function patchCards(sessions){
  var party=$("party"); if(!party) return;
  var cards=party.querySelectorAll(".card[data-sid]"); if(!cards.length) return;
  var by={}; (sessions||[]).forEach(function(s){ if(s && s.sessionId) by[s.sessionId]=s; });
  Array.prototype.forEach.call(cards,function(card){
    var s=by[card.getAttribute("data-sid")]; if(!s) return;
    card._s=s;
    setText(card.querySelector('[data-role="pc"]'), cardPromptsText(s));
    setText(card.querySelector('[data-role="age"]'), cardAgeText(s));
    var inf=card.querySelector('[data-role="now"]');
    if(inf){
      inf.classList.toggle("thinking", !s.now);
      var o=inf.querySelector(".orb"), st=orbStateFor(s.now);
      if(o && o.getAttribute("data-orb")!==st) o.setAttribute("data-orb", st);
      setText(inf.querySelector('[data-role="nowtxt"]'), s.now || "Thinking…");
    }
    var k=cardLinesKey(s), box;
    if(card._linesKey!==k && (box=card.querySelector('[data-role="lines"]'))){ fillCardLines(box, s); card._linesKey=k; }
    k=cardLinksKey(s);
    if(card._linksKey!==k && (box=card.querySelector('[data-role="links"]'))){ fillCardLinks(box, s); card._linksKey=k; }
    k=cardFootKey(s);
    if(card._footKey!==k && (box=card.querySelector('[data-role="foot"]'))){ fillCardFoot(box, s); card._footKey=k; }
    var al=cardAriaLabel(s); if(card.getAttribute("aria-label")!==al) card.setAttribute("aria-label", al);
  });
}

function mkLine(tag,text,clamp,toggle){
  var ln = el("div","ln");
  var t = el("span","tag"); t.textContent = tag+":"; ln.appendChild(t);
  var span = el("span", clamp?"clamp2":"clamp-none");
  span.textContent = text;
  ln.appendChild(span);
  if(toggle){
    var btn = el("button","more"); btn.type="button"; btn.textContent="More";
    btn.addEventListener("click",function(){
      var on = span.classList.toggle("clamp-none");
      span.classList.toggle("clamp2",!on);
      btn.textContent = on?"Less":"More";
    });
    // only show toggle if text likely overflows
    ln.appendChild(document.createElement("br"));
    ln.appendChild(btn);
  }
  return ln;
}

