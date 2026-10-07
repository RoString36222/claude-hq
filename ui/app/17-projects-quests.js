/* ================= v7: project deep-dive ================= */
var PROJECT_OPEN=false, PROJECT_SLUG=null;
function openProject(folder){
  if(!folder) return;
  rememberOpener();
  PROJECT_SLUG=folder; PROJECT_OPEN=true;
  $("projectTitle").textContent = "📊 "+prettyFolder(folder);
  $("projectSub").textContent = "";
  $("projectBody").innerHTML = '<div class="dw-loading">'+LOADING_HTML+'</div>';
  $("projectBack").classList.add("open");
  $("projectClose").focus();
  fetch('/api/project?folder='+encodeURIComponent(folder),{cache:"no-store"})
    .then(function(r){ if(!r.ok) throw new Error(r.status); return r.json(); })
    .then(function(d){ if(PROJECT_OPEN) renderProject(d); })
    .catch(function(){ $("projectBody").innerHTML='<div class="dw-loading">Could not load this project.</div>'; });
}
function closeProject(){ $("projectBack").classList.remove("open"); PROJECT_OPEN=false; PROJECT_SLUG=null; restoreOpener(); }
// Build a compact 13-week (91-day) contribution heatmap into a container, reusing hm-* styling.
function buildProjectHeatmap(container, cells){
  container.innerHTML="";
  if(!cells || !cells.length){ container.innerHTML='<div class="proj-empty">No activity yet.</div>'; return; }
  var norm = cells.map(function(c){
    var lvl=c.level; if(lvl==null){ lvl=c.heat!=null?c.heat:0; }
    return {date:c.date||"", count:c.count||0, level:Math.max(0,Math.min(4,lvl))};
  });
  var first = norm[0]&&norm[0].date ? new Date(norm[0].date+"T00:00:00") : null;
  var pad = first ? first.getDay() : 0;
  var outer=el("div","hm-outer");
  var days=["","Mon","","Wed","","Fri",""];
  var wd=el("div","hm-weekdays");
  days.forEach(function(dn){ var s=el("span"); s.textContent=dn; wd.appendChild(s); });
  outer.appendChild(wd);
  var colsWrap=el("div","hm-cols"), months=el("div","hm-months"), grid=el("div","hm-grid");
  var totalCells=pad+norm.length, weeks=Math.ceil(totalCells/7), seenMonth=-1;
  for(var w=0;w<weeks;w++){
    var span=el("span"); var idx=w*7-pad; var cell=norm[idx];
    if(cell && cell.date){ var mo=new Date(cell.date+"T00:00:00").getMonth();
      if(mo!==seenMonth){ span.textContent=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][mo]; seenMonth=mo; } }
    months.appendChild(span);
  }
  for(var i=0;i<totalCells;i++){
    var c2=el("div","hm-cell");
    if(i<pad){ c2.className="hm-cell blank"; }
    else{ var item=norm[i-pad];
      if(item){ if(item.level>0) c2.classList.add("l"+item.level);
        c2.title=item.date+" · "+item.count+" msg"+(item.count===1?"":"s"); } }
    grid.appendChild(c2);
  }
  colsWrap.appendChild(months); colsWrap.appendChild(grid); outer.appendChild(colsWrap);
  var wrap=el("div","hm-wrap"); wrap.appendChild(outer); container.appendChild(wrap);
}
function renderProject(d){
  d=d||{};
  var body=$("projectBody"); body.innerHTML="";
  var t=d.totals||{};
  $("projectTitle").textContent = "📊 "+(d.prettyFolder||prettyFolder(d.folder||PROJECT_SLUG));
  var nSess = (d.sessions&&d.sessions.length)||t.sessions||0;
  $("projectSub").textContent = (t.sessions!=null?t.sessions:nSess)+" session"+((t.sessions||nSess)===1?"":"s");

  // totals tiles
  var tiles=el("div","tiles"); tiles.style.gridTemplateColumns="repeat(3,1fr)";
  [["Sessions",(t.sessions!=null?t.sessions:nSess).toLocaleString()],
   ["Prompts",(t.prompts||0).toLocaleString()],
   ["Tool calls",(t.tools||0).toLocaleString()],
   ["Output tokens",fmtTok(t.output||0)],
   ["Est cost",fmtCost(t.estCostUSD||0)],
   ["Active days",(t.activeDays||0).toLocaleString()]].forEach(function(p){
    var tile=el("div","tile");
    var n=el("div","n"); n.textContent=p[1]; var l=el("div","l"); l.textContent=p[0];
    tile.appendChild(n); tile.appendChild(l); tiles.appendChild(tile);
  });
  var secTot=el("div","proj-sec"); secTot.appendChild(tiles); body.appendChild(secTot);

  // heatmap
  var secH=el("div","proj-sec"); var hh=el("h4"); hh.textContent="Contribution — last 13 weeks"; secH.appendChild(hh);
  var hmBox=el("div"); buildProjectHeatmap(hmBox, d.heatmap||[]); secH.appendChild(hmBox); body.appendChild(secH);

  // top files
  var files=d.topFiles||[];
  var secF=el("div","proj-sec"); var fh=el("h4"); fh.textContent="Top files touched"; secF.appendChild(fh);
  if(!files.length){ var fe=el("div","proj-empty"); fe.textContent="No files recorded."; secF.appendChild(fe); }
  files.slice(0,15).forEach(function(f){
    var row=el("div","filerow");
    var act=fileAction(f.action);
    var bd=el("div","fbadge "+act); bd.textContent=act;
    var fp=el("div","fp"); fp.textContent=f.path||""; fp.title=f.path||"";
    row.appendChild(bd); row.appendChild(fp);
    if(f.count!=null){ var fc=el("div","fc"); fc.textContent="×"+f.count; row.appendChild(fc); }
    secF.appendChild(row);
  });
  body.appendChild(secF);

  // cost by model
  var models=d.models||[];
  if(models.length){
    var secM=el("div","proj-sec"); var mh=el("h4"); mh.textContent="Cost by model"; secM.appendChild(mh);
    var maxM=models.reduce(function(a,m){ return Math.max(a,m.estCostUSD||0); },0.0001);
    models.forEach(function(m){
      var hue=(typeof MODEL_HUE!=="undefined"&&MODEL_HUE[m.model]!=null)?MODEL_HUE[m.model]:220;
      var row=el("div","acct-row");
      row.innerHTML='<div class="acct-lbl">'+esc(m.model)+' <span class="acct-sub">'+esc(m.sessions||0)+' · '+esc(fmtTok(m.output||0))+' out</span></div>'+
        '<div class="acct-bar"><i style="width:'+Math.round((m.estCostUSD||0)/maxM*100)+'%;background:hsl('+hue+',65%,55%)"></i></div>'+
        '<div class="acct-val">'+esc(fmtCost(m.estCostUSD||0))+'</div>';
      secM.appendChild(row);
    });
    body.appendChild(secM);
  }

  // sessions
  var sessions=d.sessions||[];
  var secS=el("div","proj-sec"); var sh=el("h4"); sh.textContent="Sessions ("+sessions.length+")"; secS.appendChild(sh);
  if(!sessions.length){ var se=el("div","proj-empty"); se.textContent="No sessions."; secS.appendChild(se); }
  sessions.forEach(function(s){
    var row=el("div","proj-srow"); row.setAttribute("role","button"); row.tabIndex=0;
    var t2=el("div","ps-t"); t2.textContent=s.title||"Untitled session";
    var sm=el("small"); sm.textContent=(s.tools!=null?s.tools+" tools · ":"")+(s.lastActivity?relTime(s.lastActivity)+" ago":""); t2.appendChild(sm);
    var out=el("div","ps-out"); out.textContent=fmtTok(s.output||0);
    var co=el("div","ps-cost"); co.textContent=fmtCost(s.estCostUSD||0);
    row.appendChild(t2); row.appendChild(out); row.appendChild(co);
    var openIt=function(){ closeProject(); openSession(s.sessionId,{title:s.title,folder:d.folder}); };
    if(s.sessionId){ row.addEventListener("click",openIt);
      row.addEventListener("keydown",function(e){ if(e.key==="Enter"||e.key===" "){ e.preventDefault(); openIt(); } }); }
    secS.appendChild(row);
  });
  body.appendChild(secS);
}
$("projectClose").addEventListener("click",closeProject);
$("projectBack").addEventListener("click",function(e){ if(e.target===this) closeProject(); });

/* ================= v7: quests view ================= */
var QUESTS_HIST=null, QUESTS_DEX=null, questsTimer=null;

var DAILY_POOL=[
  {id:"d_prompts_10",   title:"Send 10 prompts",          ic:"💬", target:10,  metric:"todayPrompts",    coins:2},
  {id:"d_prompts_25",   title:"Send 25 prompts",          ic:"💬", target:25,  metric:"todayPrompts",    coins:3},
  {id:"d_prompts_50",   title:"Send 50 prompts",          ic:"💬", target:50,  metric:"todayPrompts",    coins:5},
  {id:"d_tools_50",     title:"Use 50 tools",             ic:"🛠️", target:50,  metric:"todayTools",  coins:2},
  {id:"d_tools_150",    title:"Use 150 tools",            ic:"🛠️", target:150, metric:"todayTools",  coins:3},
  {id:"d_tools_300",    title:"Use 300 tools",            ic:"🛠️", target:300, metric:"todayTools",  coins:5},
  {id:"d_sessions_3",   title:"Use 3 sessions",           ic:"📂", target:3,   metric:"todayActiveSessions", coins:2},
  {id:"d_sessions_5",   title:"Use 5 sessions",           ic:"📂", target:5,   metric:"todayActiveSessions", coins:3},
  {id:"d_active",       title:"Be active today",          ic:"🔥", target:1,   metric:"todayActive",     coins:1},
  {id:"d_artifacts_1",  title:"Create an artifact",       ic:"🎨", target:1,   metric:"todayArtifacts",  coins:2},
  {id:"d_artifacts_3",  title:"Create 3 artifacts",       ic:"🎨", target:3,   metric:"todayArtifacts",  coins:3},
  {id:"d_feed_creature",title:"Feed a creature",          ic:"🍎", target:1,   metric:"todayFed",        coins:1}
];
var WEEKLY_POOL=[
  {id:"w_active_5",    title:"Active 5 days this week",    ic:"📅", target:5,   metric:"weekActiveDays",  coins:5},
  {id:"w_active_7",    title:"Active every day this week", ic:"📅", target:7,   metric:"weekActiveDays",  coins:8},
  {id:"w_prompts_100", title:"100 prompts this week",      ic:"💬", target:100, metric:"weekPrompts",     coins:5},
  {id:"w_prompts_250", title:"250 prompts this week",      ic:"💬", target:250, metric:"weekPrompts",     coins:8},
  {id:"w_tools_500",   title:"500 tool calls this week",   ic:"🛠️", target:500, metric:"weekTools", coins:5},
  {id:"w_streak_5",    title:"Hit a 5-day streak",         ic:"🔥", target:5,   metric:"streak",          coins:5},
  {id:"w_streak_7",    title:"Hit a 7-day streak",         ic:"🔥", target:7,   metric:"streak",          coins:8},
  {id:"w_folders_3",   title:"Work in 3 projects",         ic:"🌐", target:3,   metric:"weekFolders",     coins:3}
];
var ACH_CATALOG=[
  {id:"a_first_prompt",name:"First Steps",   desc:"Send your first prompt",        ic:"👣",
    tiers:[{tier:"bronze",target:1,   metric:"totalPrompts",coins:2}]},
  {id:"a_prompts",     name:"Chatterbox",    desc:"Send prompts",                  ic:"💬",
    tiers:[{tier:"bronze",target:100,metric:"totalPrompts",coins:3},{tier:"silver",target:500,metric:"totalPrompts",coins:5},{tier:"gold",target:2000,metric:"totalPrompts",coins:10}]},
  {id:"a_tools",       name:"Tool Smith",    desc:"Use tools",                     ic:"🛠️",
    tiers:[{tier:"bronze",target:500,metric:"totalTools",coins:3},{tier:"silver",target:2000,metric:"totalTools",coins:5},{tier:"gold",target:10000,metric:"totalTools",coins:10}]},
  {id:"a_streak",      name:"Streak Keeper", desc:"Maintain a streak",             ic:"🔥",
    tiers:[{tier:"bronze",target:5,metric:"bestStreak",coins:3},{tier:"silver",target:14,metric:"bestStreak",coins:8},{tier:"gold",target:30,metric:"bestStreak",coins:15}]},
  {id:"a_active_days", name:"Marathoner",    desc:"Be active on many days",        ic:"🏃",
    tiers:[{tier:"bronze",target:10,metric:"activeDays",coins:3},{tier:"silver",target:30,metric:"activeDays",coins:8},{tier:"gold",target:60,metric:"activeDays",coins:15}]},
  {id:"a_catch",       name:"Collector",     desc:"Catch creatures",               ic:"📕",
    tiers:[{tier:"bronze",target:10,metric:"caughtCount",coins:3},{tier:"silver",target:25,metric:"caughtCount",coins:5},{tier:"gold",target:48,metric:"caughtCount",coins:15}]},
  {id:"a_shiny",       name:"Shiny Hunter",  desc:"Find shiny creatures",          ic:"✦",
    tiers:[{tier:"bronze",target:1,metric:"shinyCount",coins:3},{tier:"silver",target:3,metric:"shinyCount",coins:5},{tier:"gold",target:5,metric:"shinyCount",coins:10}]},
  {id:"a_evolve",      name:"Breeder",       desc:"Evolve creatures to Apex",      ic:"🧬",
    tiers:[{tier:"bronze",target:1,metric:"apexCount",coins:3},{tier:"silver",target:5,metric:"apexCount",coins:8},{tier:"gold",target:15,metric:"apexCount",coins:15}]},
  {id:"a_level",       name:"Rank Up",       desc:"Reach trainer levels",          ic:"⭐",
    tiers:[{tier:"bronze",target:5,metric:"level",coins:3},{tier:"silver",target:12,metric:"level",coins:5},{tier:"gold",target:20,metric:"level",coins:15}]},
  {id:"a_artifacts",   name:"Artificer",     desc:"Create artifacts",              ic:"🎨",
    tiers:[{tier:"bronze",target:10,metric:"totalArtifacts",coins:3},{tier:"silver",target:50,metric:"totalArtifacts",coins:5},{tier:"gold",target:200,metric:"totalArtifacts",coins:10}]},
  {id:"a_night_owl",   name:"Night Owl",     desc:"Code between midnight and 5am", ic:"🦉",
    tiers:[{tier:"bronze",target:1,metric:"nightOwl",coins:3}]},
  {id:"a_polyglot",    name:"Polyglot",      desc:"Work in many project folders",  ic:"🌐",
    tiers:[{tier:"bronze",target:5,metric:"distinctFolders",coins:3},{tier:"silver",target:10,metric:"distinctFolders",coins:5}]},
  {id:"a_gift",        name:"Generous",      desc:"Gift coins or food to friends", ic:"🎁",
    tiers:[{tier:"bronze",target:1,metric:"totalGifts",coins:2},{tier:"silver",target:10,metric:"totalGifts",coins:5},{tier:"gold",target:50,metric:"totalGifts",coins:10}]}
];

function questClaimsLoad(){
  try{ var raw=localStorage.getItem("hq_quest_claims"); return raw?JSON.parse(raw):{}; }catch(e){ return {}; }
}
function questClaimsSave(obj){
  try{ localStorage.setItem("hq_quest_claims",JSON.stringify(obj)); }catch(e){}
}
function questClaimsPrune(obj){
  var now=new Date(), cutD=new Date(now-7*864e5).toISOString().slice(0,10), cutW=new Date(now-28*864e5).toISOString().slice(0,10);
  if(obj.daily){ Object.keys(obj.daily).forEach(function(k){ if(k<cutD) delete obj.daily[k]; }); }
  if(obj.weekly){ Object.keys(obj.weekly).forEach(function(k){ if(k<cutW) delete obj.weekly[k]; }); }
  return obj;
}

function todayStr(){ return new Date().toISOString().slice(0,10); }
// Species that reached Apex (stage index 4, STAGE_NAMES in dashboard.py), from the backend
// Pokédex shape {species:[{caught, maxStage}]}.
function dexApexCount(dex){
  var list=(dex && Array.isArray(dex.species)) ? dex.species : [], n=0;
  list.forEach(function(sp){ if(sp && sp.caught && sp.maxStage!=null && (sp.maxStage|0)>=4) n++; });
  return n;
}
// Snacks that went through today (the "Feed a creature" quest): {date, n, rids} in localStorage
// "hq_meals_today", keyed by the same UTC day as the daily quests. Counted once per requestId, so a
// replayed retry of the same snack doesn't count twice.
function mealsTodayLoad(){
  var o=null; try{ o=JSON.parse(localStorage.getItem("hq_meals_today")||"null"); }catch(e){ o=null; }
  if(!o || typeof o!=="object" || o.date!==todayStr()) return {date:todayStr(), n:0, rids:[]};
  return {date:o.date, n:Math.max(0, o.n|0), rids:Array.isArray(o.rids)?o.rids.filter(function(r){ return typeof r==="string"; }).slice(-20):[]};
}
function mealsTodayCount(){ return mealsTodayLoad().n; }
function mealsTodayBump(rid){
  var o=mealsTodayLoad();
  if(rid){ if(o.rids.indexOf(rid)>=0) return o.n; o.rids.push(rid); o.rids=o.rids.slice(-20); }
  o.n++;
  try{ localStorage.setItem("hq_meals_today", JSON.stringify(o)); }catch(e){}
  return o.n;
}
function isoWeekStr(){
  var d=new Date(), day=d.getUTCDay()||7;
  d.setUTCDate(d.getUTCDate()+4-day);
  var yr=d.getUTCFullYear();
  var jan1=new Date(Date.UTC(yr,0,1));
  var wk=Math.ceil(((d-jan1)/864e5+1)/7);
  return yr+"-W"+(wk<10?"0":"")+wk;
}

function pickQuests(pool, seed, count){
  var rng=mulberry32(seed), picked=[], prefixes={};
  var order=pool.map(function(_,i){return i;});
  for(var i=order.length-1;i>0;i--){ var j=Math.floor(rng()*(i+1)); var t=order[i]; order[i]=order[j]; order[j]=t; }
  for(var k=0;k<order.length&&picked.length<count;k++){
    var q=pool[order[k]], pfx=q.id.replace(/_[^_]*$/,"");
    if(!prefixes[pfx]){ prefixes[pfx]=1; picked.push(q); }
  }
  return picked;
}

function questMetric(m, hist, dex, season){
  var tt=season.totals||{}, fl=season.folderLeaderboard||[];
  var todayP=0, todayT=0, todayA=0;
  if(hist && hist.daily && hist.daily.length){
    var last=hist.daily[hist.daily.length-1]||{};
    todayP=last.prompts||0; todayT=last.tools||0; todayA=last.artifacts||0;
  }
  if(m==="todayPrompts") return todayP;
  if(m==="todayTools") return todayT;
  if(m==="todayArtifacts") return todayA;
  if(m==="todayActive") return todayP>0?1:0;
  if(m==="todayActiveSessions"){
    var ss=(STATE&&STATE.sessions)||[], c=0, dayStart=new Date(todayStr()+"T00:00:00Z").getTime();
    ss.forEach(function(s){ if(s.lastActivity && new Date(s.lastActivity).getTime()>=dayStart) c++; });
    return c;
  }
  if(m==="todayFed") return mealsTodayCount();
  if(m==="weekActiveDays"){
    if(hist && hist.heatmap && hist.heatmap.length){
      var n=0; hist.heatmap.slice(-7).forEach(function(c){ if((c.count||0)>0||(c.level||0)>0) n++; }); return n;
    }
    return 0;
  }
  if(m==="weekPrompts"){
    if(hist && hist.daily) return hist.daily.slice(-7).reduce(function(s,d){return s+(d.prompts||0);},0);
    return 0;
  }
  if(m==="weekTools"){
    if(hist && hist.daily) return hist.daily.slice(-7).reduce(function(s,d){return s+(d.tools||0);},0);
    return 0;
  }
  if(m==="weekFolders") return fl.length;
  if(m==="streak") return season.streak||0;
  if(m==="bestStreak") return season.bestStreak||0;
  if(m==="totalPrompts") return tt.prompts||0;
  if(m==="totalTools") return tt.tools||0;
  if(m==="totalArtifacts") return tt.artifacts||0;
  if(m==="activeDays") return tt.activeDays||0;
  if(m==="level") return season.level||0;
  if(m==="caughtCount") return (dex&&(dex.caughtCount!=null?dex.caughtCount:dex.caught))||0;
  if(m==="shinyCount") return (dex&&dex.shinyCount)||0;
  if(m==="apexCount") return dexApexCount(dex);
  if(m==="nightOwl"){
    var hr=new Date().getHours(); return (hr>=0&&hr<5&&todayP>0)?1:0;
  }
  if(m==="distinctFolders") return fl.length;
  if(m==="totalGifts"){
    var j=PANTRY&&PANTRY.j; if(!j) return 0;
    try{ var ledger=j.recentGifts||[]; return ledger.length; }catch(e){ return 0; }
  }
  return 0;
}

var QUEST_CLAIMING={};
function questClaim(questId, kind, tier, coins, requestId, btn){
  if(QUEST_CLAIMING[requestId]) return;
  QUEST_CLAIMING[requestId]=true;
  btn.disabled=true; btn.textContent="Claiming…";
  arenaPost("/api/arena/pantry/reward",{
    requestId:requestId, kind:kind, questId:questId, tier:tier, coins:coins
  }).then(function(res){
    delete QUEST_CLAIMING[requestId];
    if(res.ok){
      var claims=questClaimsLoad();
      if(kind==="quest"){
        var isWeekly=questId.charAt(0)==="w";
        var bucket=isWeekly?"weekly":"daily";
        var key=isWeekly?isoWeekStr():todayStr();
        if(!claims[bucket]) claims[bucket]={};
        if(!claims[bucket][key]) claims[bucket][key]={};
        claims[bucket][key][questId]={done:true,claimed:true,claimedAt:new Date().toISOString()};
      } else {
        if(!claims.achievements) claims.achievements={};
        claims.achievements[questId]={tier:tier,claimed:true,claimedAt:new Date().toISOString()};
      }
      questClaimsSave(claims);
      if(PANTRY&&PANTRY.j&&res.j&&res.j.coins!=null) PANTRY.j.coins=res.j.coins;
      toast("🪙 +"+(res.j&&res.j.reward||coins)+" Poke Coins!", "good");
      renderQuests();
    } else {
      var msg=(res.j&&res.j.detail)||"Claim failed";
      if(res.status===429) msg="Too many rewards today";
      toast(msg, "warn");
      btn.disabled=false; btn.textContent="Claim 🪙 "+coins;
    }
  }).catch(function(){
    delete QUEST_CLAIMING[requestId];
    btn.disabled=false; btn.textContent="Claim 🪙 "+coins;
    toast("Network error", "warn");
  });
}

function loadQuests(){
  renderQuests();
  fetch('/api/history',{cache:"no-store"}).then(function(r){ return r.ok?r.json():null; })
    .then(function(d){ if(d){ QUESTS_HIST=d; renderQuests(); } }).catch(function(){});
  fetchPokedex()
    .then(function(d){ if(d){ QUESTS_DEX=d; renderQuests(); } }).catch(function(){});
}

function questCard(q){
  var cur=q.cur||0, target=q.target||1;
  var pct=q.pct!=null?q.pct:Math.max(0,Math.min(100,Math.round(cur/target*100)));
  var done=q.done!=null?q.done:(cur>=target);
  var claimed=!!q.claimed;
  var card=el("div","quest-card"+(done?" done":""));
  var top=el("div","quest-top");
  var ic=el("span"); ic.textContent=q.ic||"⭐"; top.appendChild(ic);
  var ti=el("div","quest-title2"); ti.textContent=q.title||""; top.appendChild(ti);
  if(q.coins && !claimed){
    var cb=el("span","quest-coin"); cb.textContent="🪙 "+q.coins; top.appendChild(cb);
  }
  if(claimed){ var ck=el("span","quest-claimed"); ck.textContent="🪙 +"+q.coins+" ✓"; top.appendChild(ck); }
  else if(done && !q.coins){ var ck2=el("span","quest-check"); ck2.textContent="✓"; top.appendChild(ck2); }
  card.appendChild(top);
  var bar=el("div","quest-bar"); var sp=el("span"); sp.style.width=Math.max(0,Math.min(100,pct))+"%"; bar.appendChild(sp); card.appendChild(bar);
  var nums=el("div","quest-nums");
  var left=el("span"); left.textContent=q.curLabel!=null?q.curLabel:(cur.toLocaleString()+" / "+target.toLocaleString());
  if(done && !claimed && q.coins && q.requestId && PANTRY&&PANTRY.store==="ok"){
    var btn=el("button","quest-claim"); btn.type="button";
    btn.textContent="Claim 🪙 "+q.coins;
    btn.addEventListener("click",function(ev){
      ev.stopPropagation();
      questClaim(q.questId||q.id, q.kind||"quest", q.tier||null, q.coins, q.requestId, btn);
    });
    nums.appendChild(left); nums.appendChild(btn);
  } else {
    var right=el("span"); right.textContent=(q.sub!=null?q.sub:(pct+"%"));
    nums.appendChild(left); nums.appendChild(right);
  }
  card.appendChild(nums);
  return card;
}

function renderQuests(){
  var season=(STATE&&STATE.season)||{};
  var hist=QUESTS_HIST;
  var dex=QUESTS_DEX||TRAINER_DEX;
  var claims=questClaimsPrune(questClaimsLoad());
  questClaimsSave(claims);
  var today=todayStr(), week=isoWeekStr();
  var arenaOk=PANTRY&&PANTRY.store==="ok";
  var dailyClaims=(claims.daily&&claims.daily[today])||{};
  var weeklyClaims=(claims.weekly&&claims.weekly[week])||{};
  var achClaims=claims.achievements||{};

  // ---- header hint ----
  var sub=$("questsSub");
  if(sub) sub.textContent=arenaOk?"Daily & weekly goals — earn Poke Coins":"Connect to Arena to earn Poke Coins";

  // ---- daily quests (3 from pool, seeded by date) ----
  var dailySeed=hashStr("quest:daily:"+today);
  var dailyQuests=pickQuests(DAILY_POOL, dailySeed, 3);
  var dw=$("questsDaily"); if(dw){ dw.innerHTML="";
    dailyQuests.forEach(function(q){
      var cur=questMetric(q.metric, hist, dex, season);
      var cl=dailyClaims[q.id];
      dw.appendChild(questCard({
        id:q.id, questId:q.id, ic:q.ic, title:q.title, cur:cur, target:q.target,
        coins:q.coins, kind:"quest", claimed:cl&&cl.claimed,
        requestId:"quest:"+q.id+":"+today
      }));
    });
  }

  // ---- weekly quests (2 from pool, seeded by ISO week) ----
  var weeklySeed=hashStr("quest:weekly:"+week);
  var weeklyQuests=pickQuests(WEEKLY_POOL, weeklySeed, 2);
  var ww=$("questsWeekly"); if(ww){ ww.innerHTML="";
    weeklyQuests.forEach(function(q){
      var cur=questMetric(q.metric, hist, dex, season);
      var cl=weeklyClaims[q.id];
      ww.appendChild(questCard({
        id:q.id, questId:q.id, ic:q.ic, title:q.title, cur:cur, target:q.target,
        coins:q.coins, kind:"quest", claimed:cl&&cl.claimed,
        requestId:"quest:"+q.id+":"+week
      }));
    });
  }

  // ---- collection (no coins — progression trackers) ----
  var caught=(dex&&(dex.caughtCount!=null?dex.caughtCount:dex.caught))||0;
  var total=(dex&&dex.total)||48;
  var shiny=(dex&&dex.shinyCount)||0;
  var lvl=season.level!=null?season.level:0;
  var lvlPct=season.pct!=null?Math.max(0,Math.min(100,Math.round(season.pct))):0;
  var cw=$("questsCollection"); if(cw){ cw.innerHTML="";
    [ {ic:"📕", title:"Pokédex", cur:caught, target:total},
      {ic:"✦", title:"Shiny hunter", cur:shiny, target:5},
      {ic:"⭐", title:"Reach Lv "+(lvl+1), cur:lvlPct, target:100,
        curLabel:"Lv "+lvl+" → "+(lvl+1), sub:lvlPct+"% to next", done:false}
    ].forEach(function(q){ cw.appendChild(questCard(q)); });
  }

  // ---- achievements (tiered cards with claim buttons) ----
  var ag=$("questsAch"); if(ag){ ag.innerHTML="";
    var totalEarned=0;
    ACH_CATALOG.forEach(function(a){
      var card=el("div","ach-card");
      var top=el("div","ach-top");
      var aic=el("span","ach-icon"); aic.textContent=a.ic; top.appendChild(aic);
      var nm=el("span","ach-name"); nm.textContent=a.name; top.appendChild(nm);
      card.appendChild(top);
      var desc=el("div","ach-desc"); desc.textContent=a.desc; card.appendChild(desc);
      var tierRow=el("div","ach-tiers");
      var claimedTier=achClaims[a.id];
      var TIER_IC={bronze:"🥉",silver:"🥈",gold:"🥇"};
      var highestEarned=null;
      a.tiers.forEach(function(t){
        var val=questMetric(t.metric, hist, dex, season);
        var reached=val>=t.target;
        var isClaimed=claimedTier&&(claimedTier.tier===t.tier||
          (t.tier==="bronze"&&(claimedTier.tier==="silver"||claimedTier.tier==="gold"))||
          (t.tier==="silver"&&claimedTier.tier==="gold"));
        if(isClaimed){ totalEarned+=t.coins; highestEarned=t.tier; }
        var pill=el(reached&&!isClaimed&&arenaOk?"button":"span",
          "ach-tier"+(isClaimed?" earned":"")+(reached&&!isClaimed&&arenaOk?" claimable":""));
        if(reached&&!isClaimed&&arenaOk) pill.type="button";
        pill.textContent=(isClaimed?TIER_IC[t.tier]+" ":"")+(reached&&!isClaimed?"Claim 🪙 "+t.coins:t.tier+" "+t.target);
        if(reached&&!isClaimed&&arenaOk){
          (function(achId,tier,coins){
            pill.addEventListener("click",function(){
              questClaim(achId,"achievement",tier,coins,"ach:"+achId+":"+tier,pill);
            });
          })(a.id,t.tier,t.coins);
        }
        tierRow.appendChild(pill);
      });
      card.appendChild(tierRow);
      var nextTier=null;
      a.tiers.forEach(function(t){
        if(!nextTier){
          var isClaimed=claimedTier&&(claimedTier.tier===t.tier||
            (t.tier==="bronze"&&(claimedTier.tier==="silver"||claimedTier.tier==="gold"))||
            (t.tier==="silver"&&claimedTier.tier==="gold"));
          var val=questMetric(t.metric, hist, dex, season);
          if(!isClaimed&&val<t.target) nextTier={metric:t.metric,target:t.target,cur:val};
        }
      });
      if(nextTier){
        var prog=el("div","ach-prog"); var ps=el("span");
        ps.style.width=Math.max(0,Math.min(100,Math.round(nextTier.cur/nextTier.target*100)))+"%";
        prog.appendChild(ps); card.appendChild(prog);
      }
      ag.appendChild(card);
    });
    $("questsAchSub").textContent=totalEarned>0?("🪙 "+totalEarned+" earned"):"";
  }
}
questsTimer=setInterval(function(){ if(VIEW==="quests" && !document.hidden) loadQuests(); }, 30000);

/* ================= v7: accent color picker ================= */
var ACCENT_PRESETS=[262,212,150,20,325,99,0,190];  // brand-ish hues
function initAccentSwatches(){
  var box=$("accentSwatches"); if(!box) return; box.innerHTML="";
  var def=el("button","accent-sw default-sw"); def.type="button"; def.title="Theme default";
  def.textContent="↺"; def.setAttribute("data-accent","");
  def.addEventListener("click",function(){ setAccent(""); });
  box.appendChild(def);
  ACCENT_PRESETS.forEach(function(h){
    var b=el("button","accent-sw"); b.type="button"; b.setAttribute("data-accent",String(h));
    b.style.background="hsl("+h+" 85% 60%)"; b.title="Hue "+h;
    b.addEventListener("click",function(){ setAccent(String(h)); });
    box.appendChild(b);
  });
  markAccentSwatch();
}
function markAccentSwatch(){
  var box=$("accentSwatches"); if(!box) return;
  var cur=accentPref();
  Array.prototype.forEach.call(box.querySelectorAll(".accent-sw"),function(b){
    b.classList.toggle("active", (b.getAttribute("data-accent")||"")===cur);
  });
}
function setAccent(hue){
  try{ if(hue==="") localStorage.removeItem("hq_accent"); else localStorage.setItem("hq_accent",String(hue)); }catch(e){}
  applyAccent();
  var sl=$("setAccent"); if(sl && hue!=="") sl.value=hue;
  markAccentSwatch();
}
(function wireAccent(){
  var sl=$("setAccent");
  if(sl){ sl.addEventListener("input",function(){ setAccent(sl.value); }); }
  var db=$("accentDefault"); if(db){ db.addEventListener("click",function(){ setAccent(""); }); }
  initAccentSwatches();
})();
// Sync the accent controls each time Settings opens (openSettings fires this hook).
function syncAccentControls(){
  var cur=accentPref(); var sl=$("setAccent"); if(sl) sl.value=(cur===""?262:cur);
  markAccentSwatch();
}

/* ================= v7: command palette — open a project ================= */
(function(){
  var orig=buildCmdkItems;
  buildCmdkItems=function(q){
    var items=orig(q);
    var fl=(STATE&&STATE.season&&STATE.season.folderLeaderboard)||[];
    var proj=[];
    fl.forEach(function(f){ if(f && f.folder){
      proj.push({group:"Projects", ic:"📊", label:"Open project: "+prettyFolder(f.folder),
        sub:(f.prompts!=null?f.prompts+" prompts":""), run:(function(slug){ return function(){ openProject(slug); }; })(f.folder)});
    }});
    if(q){ var ql=q.toLowerCase(); proj=proj.filter(function(it){ return (it.label+" "+(it.sub||"")+" "+it.group).toLowerCase().indexOf(ql)>=0; }); }
    return items.concat(proj);
  };
})();

/* ---- config bootstrap: theme early, then server config ---- */
(function initConfig(){
  try{
    var t=localStorage.getItem("hq_theme"); if(t) CONFIG.theme=t;
    var p=localStorage.getItem("hq_pack"); if(p) CONFIG.creaturePack=p;
    // Default to high contrast when the OS asks for it and the user has no stored choice.
    if(!t && prefContrast()){ try{ localStorage.setItem("hq_theme","contrast"); }catch(e){} }
  }catch(e){}
  applyDisplayPrefs();   // theme + large-text + calm, all localStorage-authoritative
  fetch('/api/config',{cache:"no-store"})
    .then(function(r){ return r.json(); })
    .then(function(c){ if(c) applyConfig(c); })
    .catch(function(){});
})();

load();
startStream();
// PWA: register the service worker so Claude HQ is installable as a standalone app.
// (127.0.0.1 is a secure context, so SW is allowed. Network-first, so never stale.)

