/* ================= gym / team analysis ================= */
// Canonical 18-type effectiveness chart (attacker -> {defender: multiplier}; omitted = 1x).
var TYPE_CHART={
  Normal:{Rock:.5,Ghost:0,Steel:.5},
  Fire:{Fire:.5,Water:.5,Grass:2,Ice:2,Bug:2,Rock:.5,Dragon:.5,Steel:2},
  Water:{Fire:2,Water:.5,Grass:.5,Ground:2,Rock:2,Dragon:.5},
  Electric:{Water:2,Electric:.5,Grass:.5,Ground:0,Flying:2,Dragon:.5},
  Grass:{Fire:.5,Water:2,Grass:.5,Poison:.5,Ground:2,Flying:.5,Bug:.5,Rock:2,Dragon:.5,Steel:.5},
  Ice:{Fire:.5,Water:.5,Grass:2,Ice:.5,Ground:2,Flying:2,Dragon:2,Steel:.5},
  Fighting:{Normal:2,Ice:2,Poison:.5,Flying:.5,Psychic:.5,Bug:.5,Rock:2,Ghost:0,Dark:2,Steel:2,Fairy:.5},
  Poison:{Grass:2,Poison:.5,Ground:.5,Rock:.5,Ghost:.5,Steel:0,Fairy:2},
  Ground:{Fire:2,Electric:2,Grass:.5,Poison:2,Flying:0,Bug:.5,Rock:2,Steel:2},
  Flying:{Electric:.5,Grass:2,Fighting:2,Bug:2,Rock:.5,Steel:.5},
  Psychic:{Fighting:2,Poison:2,Psychic:.5,Dark:0,Steel:.5},
  Bug:{Fire:.5,Grass:2,Fighting:.5,Poison:.5,Flying:.5,Psychic:2,Ghost:.5,Dark:2,Steel:.5,Fairy:.5},
  Rock:{Fire:2,Ice:2,Fighting:.5,Ground:.5,Flying:2,Bug:2,Steel:.5},
  Ghost:{Normal:0,Psychic:2,Ghost:2,Dark:.5},
  Dragon:{Dragon:2,Steel:.5,Fairy:0},
  Dark:{Fighting:.5,Psychic:2,Ghost:2,Dark:.5,Fairy:.5},
  Steel:{Fire:.5,Water:.5,Electric:.5,Ice:2,Rock:2,Steel:.5,Fairy:2},
  Fairy:{Fire:.5,Fighting:2,Poison:.5,Dragon:2,Dark:2,Steel:.5}
};
var ALL_TYPES=Object.keys(TYPE_CHART);   // the 18 defending/attacking types
function eff(atk,def){ var r=TYPE_CHART[atk]; if(!r) return 1; return r[def]!=null?r[def]:1; }
function typeHueOf(t){ return POKE_TYPE_HUE[t]!=null?POKE_TYPE_HUE[t]:220; }
function typeChipHTML(t,extra,cnt){
  return '<span class="tchip'+(extra?" "+extra:"")+'" style="background:hsl('+typeHueOf(t)+',60%,45%)">'+esc(t)+
    (cnt!=null?'<span class="tn">×'+cnt+'</span>':'')+'</span>';
}

// The "team" = creatures of currently ACTIVE sessions (working or idle). One type each.
function gymTeam(){
  var ss=(STATE&&STATE.sessions)||[];
  var team=[];
  ss.forEach(function(s){
    if(s.status!=="working" && s.status!=="idle") return;
    var cr=s.creature||{};
    team.push({ sess:s, cr:cr, type:creatureType(cr), name:creatureSpecies(cr),
      title:s.title||s.name||"Session", status:s.status });
  });
  return team;
}
// Full analysis object from a team.
function analyzeTeam(team){
  var types=team.map(function(m){ return m.type; });
  // type distribution
  var dist={}; types.forEach(function(t){ dist[t]=(dist[t]||0)+1; });
  // offensive coverage: for each defending type, is ANY member's attacking type >=2x?
  var covered={}, notCovered=[];
  ALL_TYPES.forEach(function(def){
    var hit=types.some(function(atk){ return eff(atk,def)>=2; });
    if(hit) covered[def]=1; else notCovered.push(def);
  });
  var coveredCount=Object.keys(covered).length;
  // defensive weaknesses: for each attacking type, how many members does it hit >=2x?
  var threat={};
  ALL_TYPES.forEach(function(atk){
    var n=0; types.forEach(function(dt){ if(eff(atk,dt)>=2) n++; });
    if(n>0) threat[atk]=n;
  });
  // "nothing resists": attacking types where no member takes <1x (i.e. everyone takes >=1x)
  var noResist=[];
  ALL_TYPES.forEach(function(atk){
    if(!types.length) return;
    var anyResist=types.some(function(dt){ return eff(atk,dt)<1; });
    if(!anyResist) noResist.push(atk);
  });
  var shared=Object.keys(threat).map(function(atk){ return {type:atk, n:threat[atk]}; })
    .sort(function(a,b){ return b.n-a.n; });
  var worst=shared.length?shared[0].n:0;
  // grade: offensive coverage % and shared-weakness severity
  var covPct=team.length? Math.round(coveredCount/18*100) : 0;
  var severity=team.length? worst/team.length : 0;   // fraction of team hit by worst threat
  var grade="D", gradeLbl="";
  if(!team.length){ grade="—"; gradeLbl="No active team"; }
  else{
    var score=covPct - severity*45;               // penalise big shared weaknesses
    if(score>=82) grade="S";
    else if(score>=68) grade="A";
    else if(score>=52) grade="B";
    else if(score>=36) grade="C";
    else grade="D";
    gradeLbl = covPct+"% coverage · worst shared weakness hits "+worst+"/"+team.length;
  }
  return { team:team, types:types, dist:dist, covered:covered, notCovered:notCovered,
    coveredCount:coveredCount, covPct:covPct, threat:threat, shared:shared, worst:worst,
    noResist:noResist, grade:grade, gradeLbl:gradeLbl };
}
// One suggested member type that covers a defending type not yet covered.
function coveringTypesFor(def){
  return ALL_TYPES.filter(function(atk){ return eff(atk,def)>=2; });
}
// Types that RESIST an attacking type (take <1x) — to patch a shared weakness.
function resistingTypesFor(atk){
  return ALL_TYPES.filter(function(dt){ return eff(atk,dt)<1; });
}
function buildSuggestions(a){
  var out=[];
  if(!a.team.length) return out;
  // 1) biggest shared weakness
  if(a.shared.length && a.shared[0].n>=2){
    var w=a.shared[0];
    var fix=resistingTypesFor(w.type).slice(0,3);
    out.push({ic:"🛡️", ok:false,
      text:"Weak to <b>"+esc(w.type)+"</b> ("+w.n+" member"+(w.n===1?"":"s")+" hit) — add a "+
        (fix.length?fix.join("/"):"resistant")+" session to shore it up."});
  }
  // 2) a missing offensive coverage gap
  if(a.notCovered.length){
    var def=a.notCovered[0];
    var cov=coveringTypesFor(def).slice(0,3);
    out.push({ic:"🗡️", ok:false,
      text:"No coverage vs <b>"+esc(def)+"</b> — add a "+(cov.length?cov.join("/"):"suitable")+" session."});
  }
  // 3) "nothing resists" callout
  if(out.length<2 && a.noResist.length){
    var nr=a.noResist[0]; var rz=resistingTypesFor(nr).slice(0,3);
    out.push({ic:"⚠️", ok:false,
      text:"Nothing on the team resists <b>"+esc(nr)+"</b> — a "+(rz.length?rz.join("/"):"resistant")+" session would help."});
  }
  if(!out.length){
    out.push({ic:"✅", ok:true,
      text:"Balanced team — strong coverage and no dangerous shared weakness. Nice roster!"});
  }
  return out.slice(0,2);
}
function paintMon(node, cr, px){ paintCreature(node, cr, px, true); }

// ---- compact summary card (live view) ----
var GYMCARD_SIG=null;
function renderGymCard(){
  var card=$("gymCard"); if(!card) return;
  var team=gymTeam();
  var sig=paintEnvSig()+"||"+JSON.stringify(team.map(function(m){ return [m.name, m.type, m.title, creatureSigKey(m.cr)]; }));
  if(sig===GYMCARD_SIG) return;   // same roster: don't repaint (it would restart every sprite)
  GYMCARD_SIG=sig;
  if(!team.length){ card.classList.add("hidden"); return; }
  card.classList.remove("hidden");
  var a=analyzeTeam(team);
  var gr=$("gymCardGrade");
  gr.textContent=a.grade;
  gr.className="gymcard-grade g-"+a.grade.toLowerCase();
  $("gymCardSub").textContent = a.coveredCount+"/18 covered · "+
    (a.shared.length&&a.shared[0].n>=2 ? ("weak to "+a.shared[0].type+" ("+a.shared[0].n+")") : "no big shared weakness");
  var ro=$("gymCardRoster"); ro.innerHTML="";
  team.slice(0,10).forEach(function(m){
    var av=el("div","gymcard-mon"); paintMon(av,m.cr,34);
    av.title=m.name+" · "+m.type+" · "+m.title; ro.appendChild(av);
  });
  if(team.length>10){ var more=el("div","gymcard-mon"); more.textContent="+"+(team.length-10);
    more.style.fontWeight="800"; more.style.fontSize="11px"; ro.appendChild(more); }
  // type-distribution chips
  var bars=$("gymCardBars"); bars.innerHTML="";
  Object.keys(a.dist).sort(function(x,y){ return a.dist[y]-a.dist[x]; }).forEach(function(t){
    var span=el("span"); span.innerHTML=typeChipHTML(t,null,a.dist[t]); bars.appendChild(span.firstChild);
  });
}
(function(){
  var c=$("gymCard"); if(!c) return;
  c.addEventListener("click",function(){ setView("gym"); });
  c.addEventListener("keydown",function(e){ if(e.key==="Enter"||e.key===" "){ e.preventDefault(); setView("gym"); } });
})();

// ---- full gym view ----
function renderGym(){
  var body=$("gymBody"); if(!body) return;
  var team=gymTeam();
  var grade=$("gymGrade"), gradeLbl=$("gymGradeLbl"), sub=$("gymSub");
  if(!team.length){
    grade.textContent="—"; grade.className="gym-grade";
    gradeLbl.textContent="No active sessions";
    sub.textContent="Your team is made from the creatures of sessions that are Working or Idle. None are active right now — start or resume a session to field a team.";
    body.innerHTML='<div class="gym-empty"><div class="big">🛌</div><div>No active team. Working or idle sessions become your gym roster.</div></div>';
    return;
  }
  var a=analyzeTeam(team);
  grade.textContent=a.grade; grade.className="gym-grade g-"+a.grade.toLowerCase();
  gradeLbl.textContent=a.gradeLbl;
  sub.textContent = team.length+" active member"+(team.length===1?"":"s")+" (working or idle) · "+
    Object.keys(a.dist).length+" distinct type"+(Object.keys(a.dist).length===1?"":"s")+".";

  // rebuild body (it may hold the empty-state markup)
  body.innerHTML=
    '<section class="panel a-panel"><h3 class="section-h">'+ico("users")+'Team roster <span class="muted" id="gymRosterSub"></span></h3>'+
      '<div class="gym-roster" id="gymRoster"></div></section>'+
    '<div class="midrow">'+
      '<section class="panel a-panel"><h3 class="section-h">'+ico("pie")+'Type distribution</h3><div class="gym-dist" id="gymDist"></div></section>'+
      '<section class="panel a-panel"><h3 class="section-h">'+ico("swords")+'Offensive coverage <span class="muted" id="gymCovSub"></span></h3><div class="gym-cov" id="gymCov"></div></section>'+
    '</div>'+
    '<section class="panel a-panel"><h3 class="section-h">'+ico("shield")+'Defensive weaknesses <span class="muted">shared threats to the team</span></h3><div class="gym-weak" id="gymWeak"></div></section>'+
    '<section class="panel a-panel"><h3 class="section-h">'+ico("check")+'Grade &amp; suggestions</h3><div class="gym-suggest" id="gymSuggest"></div></section>';

  // roster
  var ro=$("gymRoster"); $("gymRosterSub").textContent=team.length+" member"+(team.length===1?"":"s");
  team.forEach(function(m){
    var row=el("div","gym-member");
    var av=el("div","gym-member-av"); paintMon(av,m.cr,42); row.appendChild(av);
    var meta=el("div","gym-member-meta");
    var nm=el("div","gym-member-name"); nm.textContent=m.name; meta.appendChild(nm);
    var badge=el("div"); badge.innerHTML=typeChipHTML(m.type); if(badge.firstChild) meta.appendChild(badge.firstChild);
    var tt=el("div","gym-member-title"); tt.textContent=m.title; meta.appendChild(tt);
    row.appendChild(meta);
    var sid=m.sess.sessionId||m.sess.id;
    if(sid){ row.style.cursor="pointer";
      row.addEventListener("click",function(){ openSession(sid,{title:m.title,folder:m.sess.folder,status:m.status,creature:m.cr}); }); }
    ro.appendChild(row);
  });

  // type distribution bars
  var dist=$("gymDist"); dist.innerHTML="";
  var distKeys=Object.keys(a.dist).sort(function(x,y){ return a.dist[y]-a.dist[x]||x.localeCompare(y); });
  var distMax=distKeys.reduce(function(mx,t){ return Math.max(mx,a.dist[t]); },1);
  distKeys.forEach(function(t){
    var row=el("div","gym-distrow");
    var lbl=el("div"); lbl.innerHTML=typeChipHTML(t);
    var track=el("div","track"); var fill=el("span");
    fill.style.width=Math.max(6,Math.round(a.dist[t]/distMax*100))+"%";
    fill.style.background="hsl("+typeHueOf(t)+",60%,45%)"; track.appendChild(fill);
    var cnt=el("div","cnt"); cnt.textContent=a.dist[t];
    row.appendChild(lbl); row.appendChild(track); row.appendChild(cnt);
    dist.appendChild(row);
  });

  // offensive coverage
  var cov=$("gymCov"); cov.innerHTML="";
  $("gymCovSub").textContent="≥2× on defenders";
  var meter=el("div","gym-cov-meter");
  meter.innerHTML='Covered <b>'+a.coveredCount+'</b> / 18 defending types'+
    '<div class="gym-cov-bar"><span style="width:'+Math.round(a.coveredCount/18*100)+'%"></span></div>';
  cov.appendChild(meter);
  if(a.notCovered.length){
    var gapWrap=el("div");
    var gl=el("div","gym-cov-lbl"); gl.textContent="Not covered ("+a.notCovered.length+")"; gapWrap.appendChild(gl);
    var grid=el("div","gym-cov-grid");
    a.notCovered.forEach(function(t){ var s=el("span"); s.innerHTML=typeChipHTML(t,"gym-chip-dim"); grid.appendChild(s.firstChild); });
    gapWrap.appendChild(grid); cov.appendChild(gapWrap);
  } else {
    var ok=el("div","gym-weak-note good"); ok.textContent="Full offensive coverage — every type is hit for ≥2× by someone. ✓";
    cov.appendChild(ok);
  }

  // defensive weaknesses (shared threats)
  var weak=$("gymWeak"); weak.innerHTML="";
  if(!a.shared.length){
    var noneW=el("div","gym-weak-note good"); noneW.textContent="No attacking type hits any member for ≥2×. Remarkably sturdy team. ✓";
    weak.appendChild(noneW);
  } else {
    var wm=a.shared[0].n;
    a.shared.slice(0,8).forEach(function(w){
      var row=el("div","gym-weakrow");
      var lbl=el("div"); lbl.innerHTML=typeChipHTML(w.type);
      var track=el("div","track"); var fill=el("span"); fill.style.width=Math.round(w.n/wm*100)+"%"; track.appendChild(fill);
      var cnt=el("div","cnt"); cnt.textContent=w.n+"/"+team.length+" hit";
      row.appendChild(lbl.firstChild?lbl:lbl); row.appendChild(track); row.appendChild(cnt);
      weak.appendChild(row);
    });
  }
  if(a.noResist.length){
    var nr=el("div","gym-weak-note bad");
    nr.textContent="Nothing resists: "+a.noResist.join(", ")+" (no member takes reduced damage).";
    weak.appendChild(nr);
  } else if(team.length){
    var someR=el("div","gym-weak-note good"); someR.textContent="Every attacking type is resisted by at least one member. ✓";
    weak.appendChild(someR);
  }

  // grade + suggestions
  var sug=$("gymSuggest"); sug.innerHTML="";
  var head=el("div","gym-weak-note"); head.innerHTML="Grade <b>"+esc(a.grade)+"</b> — "+esc(a.gradeLbl); sug.appendChild(head);
  buildSuggestions(a).forEach(function(s){
    var it=el("div","gym-suggest-item"+(s.ok?" ok":""));
    var ic=el("div","si-ic"); ic.textContent=s.ic; it.appendChild(ic);
    var tx=el("div"); tx.innerHTML=s.text; it.appendChild(tx);
    sug.appendChild(it);
  });
}

/* ================= next-up recommender ================= */
function renderNextUp(){
  var wrap=$("nextUpList"); var panel=$("nextUp"); if(!wrap||!panel) return;
  var ss=(STATE&&STATE.sessions)||[];
  if(!ss.length){ panel.classList.add("hidden"); return; }
  panel.classList.remove("hidden");
  var items=[];
  // 1) needs-you sessions
  var needs=ss.filter(function(s){ return s.status==="needs"; })
    .sort(function(a,b){ return (a.ageSecs==null?1e12:a.ageSecs)-(b.ageSecs==null?1e12:b.ageSecs); });
  needs.forEach(function(s){
    items.push({cls:"needs", ic:"▶", t:(s.title||s.name||"A session")+" is waiting on you",
      s:(s.alert||"needs your input")+" · "+fmtAge(s.ageSecs)+" ago",
      btn:"Open", fn:function(){ openSession(s.sessionId||s.id,{title:s.title,folder:s.folder,status:s.status,creature:s.creature}); }});
  });
  // 1b) at most one worn-out creature: fainted first, else the most fatigued
  if(items.length<4){
    var worn=ss.filter(function(s){ var f=fzOf(s.creature); return s.kind!=="archived" && f && (f.state==="unconscious"||f.state==="fatigued"); })
      .sort(function(a,b){ var fa=fzOf(a.creature), fb=fzOf(b.creature);
        return ((fb.state==="unconscious")-(fa.state==="unconscious")) || (fzMins(fb.loadMins)-fzMins(fa.loadMins)); })[0];
    if(worn){
      var wf=fzOf(worn.creature), wko=wf.state==="unconscious", wnm=creatureSpecies(worn.creature);
      var wsub=(worn.title||worn.name||"session")+" \u00B7 "+(wf.phase==="resting"
        ? "resting \u00B7 "+(wko?"wakes":"rested")+" in ~"+fzMins(wf.restMins)+"m"
        : fmtMins(Math.max(fzMins(wf.streakMins), fzMins(wf.loadMins)))+" without a real break \u00B7 rest ~"+fzMins(wf.restMins)+"m"+(PANTRY.store==="ok"?" or give it a snack":""));
      items.push({cls:wko?"needs":"", ic:wko?"\uD83D\uDCAB":"\uD83D\uDCA6", t:wnm+(wko?" fainted":" is fatigued"), s:wsub,
        btn:"Care", fn:function(){ openDrawer(worn,{care:true}); }});
    }
  }
  // 2) idle sessions active in the last few hours -> resume
  if(items.length<4){
    var idleRecent=ss.filter(function(s){ return s.status==="idle" && s.ageSecs!=null && s.ageSecs<6*3600; })
      .sort(function(a,b){ return a.ageSecs-b.ageSecs; });
    idleRecent.forEach(function(s){
      if(items.length>=4) return;
      items.push({cls:"", ic:"↻", t:"Pick up where you left off: "+(s.title||s.name||"session"),
        s:"idle "+fmtAge(s.ageSecs)+" · "+prettyFolder(s.folder||""),
        btn:"Resume", fn:function(){ sessResume(s.sessionId||s.id); }});
    });
  }
  // 3) stale sessions (>24h)
  if(items.length<4){
    var stale=ss.filter(function(s){ return s.status==="stale" || (s.ageSecs!=null && s.ageSecs>24*3600); });
    if(stale.length){
      items.push({cls:"", ic:"🧹", t:"Close "+stale.length+" stale tab"+(stale.length===1?"":"s")+" to tidy up",
        s:"idle over a day — filter and review them",
        btn:"Review", fn:function(){ setView("live"); FILTER="stale";
          Array.prototype.forEach.call($("filterChips").children,function(c){ c.classList.toggle("active", c.getAttribute("data-filter")==="stale"); });
          if(STATE) renderParty(STATE.sessions);
          var g=document.querySelector(".stalewrap"); if(g){ g.open=true; STALE_OPEN=true; g.scrollIntoView({behavior:"smooth",block:"start"}); }
        }});
    }
  }
  items=items.slice(0,4);
  wrap._items=items;   // the buttons call the CURRENT tick's actions, even when the DOM is kept
  // Same rows: only the subtitles (which carry ages) are refreshed in place.
  var sig=JSON.stringify(items.map(function(it){ return [it.cls, it.ic, it.t, it.btn||""]; }));
  if(sig===wrap._sig && wrap.firstChild){
    var subs=wrap.querySelectorAll(".nextup-s");
    if(items.length) items.forEach(function(it, i){ setText(subs[i], it.s); });
    return;
  }
  wrap._sig=sig;
  wrap.innerHTML="";
  if(!items.length){
    var clr=el("div","nextup-item clear");
    var ic=el("div","nextup-ic"); ic.textContent="🌿"; clr.appendChild(ic);
    var bd=el("div","nextup-body");
    var t=el("div","nextup-t"); t.textContent="All clear — your fleet is calm."; bd.appendChild(t);
    var s=el("div","nextup-s"); s.textContent="Nothing waiting, nothing stale. Nice work."; bd.appendChild(s);
    clr.appendChild(bd); wrap.appendChild(clr);
    $("nextUpSub").textContent="";
    return;
  }
  $("nextUpSub").textContent = items.length+" suggestion"+(items.length===1?"":"s");
  items.forEach(function(it, idx){
    var row=el("div","nextup-item"+(it.cls?" "+it.cls:""));
    var ic=el("div","nextup-ic"); ic.textContent=it.ic; row.appendChild(ic);
    var bd=el("div","nextup-body");
    var t=el("div","nextup-t"); t.textContent=it.t; bd.appendChild(t);
    var s=el("div","nextup-s"); s.textContent=it.s; bd.appendChild(s);
    row.appendChild(bd);
    if(it.btn){ var b=el("button","nextup-btn"); b.type="button"; b.textContent=it.btn;
      b.addEventListener("click",function(e){ e.stopPropagation(); var cur=(wrap._items||[])[idx]||it; cur.fn(); }); row.appendChild(b); }
    wrap.appendChild(row);
  });
}

/* ---- trainer card (Pokémon-theme capstone: level + badges + pokedex + shiny) ---- */
var TRAINER_DEX=null;
function loadTrainerDex(){
  fetchPokedex()
    .then(function(d){ TRAINER_DEX=d; renderTrainerCard(); maybeRecap(); }).catch(function(){});
}
function trainerPref(){ return ((CONFIG&&CONFIG.trainerName)||"").trim(); }
function trainerName(){
  var custom=trainerPref(); if(custom) return custom;
  var ss=(STATE&&STATE.sessions)||[];
  for(var i=0;i<ss.length;i++){ var n=(ss[i].name||"").trim(); if(n){ var m=n.split("-")[0]; if(m) return m; } }
  return "You";
}
function renderTrainerCard(){
  var card=$("trainerCard"); if(!card) return;
  var s=(STATE&&STATE.season)||{};
  var me=(typeof myLevel==="function") ? myLevel() : s;
  var av=$("tcAvatar"), lv="Lv."+(me.level!=null?me.level:"—");
  if(av && typeof trainerSVG==="function"){
    av.innerHTML = trainerSVG(resolveTrainerSpec(), 46) + '<span class="tc-lvpip" id="tcLvl">'+esc(lv)+'</span>';
  } else if($("tcLvl")){ $("tcLvl").textContent = lv; }
  $("tcName").textContent = "Trainer "+trainerName();
  $("tcRank").textContent = (me.rank||"")+(me.pct!=null?(" · "+Math.round(me.pct)+"% to next"):"");
  var ach=(s.achievements||[]); var unlocked=ach.filter(function(a){return a.unlocked;}).length;
  var chips=[];
  chips.push('<span class="tc-chip">🏅 <b>'+unlocked+'</b>/'+ach.length+' badges</span>');
  if(TRAINER_DEX){
    chips.push('<span class="tc-chip">📕 <b>'+TRAINER_DEX.caughtCount+'</b>/'+(TRAINER_DEX.total||48)+' caught</span>');
    if(TRAINER_DEX.shinyCount>0) chips.push('<span class="tc-chip shiny">✦ <b>'+TRAINER_DEX.shinyCount+'</b> shiny</span>');
  }
  var party=((STATE&&STATE.sessions)||[]).filter(function(x){return x.status==="working"||x.status==="idle";}).length;
  chips.push('<span class="tc-chip">🎮 <b>'+party+'</b> active</span>');
  if(PANTRY.store==="ok" && PANTRY.j){
    var ready=!!(PANTRY.j.claim && PANTRY.j.claim.claimable), bump=PANTRY.bump && !calmMode();
    PANTRY.bump=false;   // one bump per gain (this card rebuilds every tick)
    chips.push('<span class="tc-chip coins'+(bump?' bump':'')+'" title="Poke Coins'+(ready?' \u00B7 today\u2019s coins are ready in the Store':'')+'">\uD83E\uDE99 <b>'+(PANTRY.j.coins|0)+'</b>'+
      (ready?'<span class="tc-dot" aria-hidden="true"></span>':'')+'</span>');
  }
  $("tcStats").innerHTML = chips.join("");
}
(function(){
  var c=$("trainerCard"); if(!c) return;
  c.addEventListener("click",function(){ setView("pokedex"); });
  c.addEventListener("keydown",function(e){ if(e.key==="Enter"||e.key===" "){ e.preventDefault(); setView("pokedex"); } });
  var ed=$("tcEdit");
  if(ed) ed.addEventListener("click",function(e){ e.stopPropagation(); openSettings(); var r=$("trainerBuilderRow"); if(r&&r.scrollIntoView) r.scrollIntoView({block:"center"}); });
})();
loadTrainerDex();
setInterval(function(){ if(!document.hidden) loadTrainerDex(); }, 60000);

