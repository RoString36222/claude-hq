/* ---------- insights ---------- */
function renderInsights(s){
  if(!s) return;
  var tk = s.tokens||{};
  $("insCost").textContent = fmtCost(tk.estCostUSD);
  $("insTokens").textContent = fmtTok(tk.output)+" generated · "+fmtTok(tk.total)+" processed";

  // tool breakdown
  var tb = s.toolBreakdown||[];
  var tbmax = tb.reduce(function(m,t){ return Math.max(m,t.count||0); },1);
  var tw = $("insTools"); tw.innerHTML="";
  if(!tb.length){ tw.innerHTML='<div class="cost-sub">No tool activity yet.</div>'; }
  tb.slice(0,8).forEach(function(t){
    var row = el("div","hbar");
    var lbl = el("div","lbl"); lbl.textContent = t.name||t.tool||"tool";
    var track = el("div","track"); var fill = el("span");
    fill.style.width = Math.max(2, Math.round((t.count||0)/tbmax*100))+"%";
    track.appendChild(fill);
    var val = el("div","val"); val.textContent = (t.count||0).toLocaleString();
    row.title = (t.name||"tool")+": "+(t.count||0).toLocaleString()+" calls";
    row.appendChild(lbl); row.appendChild(track); row.appendChild(val);
    tw.appendChild(row);
  });

  // folder leaderboard
  var fl = s.folderLeaderboard||[];
  var fw = $("insFolders"); fw.innerHTML="";
  if(!fl.length){ fw.innerHTML='<div class="cost-sub">No folders yet.</div>'; }
  fl.slice(0,6).forEach(function(f){
    var row = el("div","leadrow");
    var left = el("div"); left.style.minWidth="0";
    var lf = el("div","lf"); lf.textContent = prettyFolder(f.folder||f.name); left.appendChild(lf);
    var st = el("div","lstat");
    st.textContent = (f.prompts!=null?f.prompts+" prompts":"")+
      (f.tools!=null?" · "+f.tools+" tools":"");
    left.appendChild(st);
    var sc = el("div","lscore"); sc.textContent = (f.score!=null?Math.round(f.score).toLocaleString():"");
    row.title = (f.folder||"folder")+" — score "+(f.score!=null?Math.round(f.score):"?")+" · click to open";
    row.appendChild(left); row.appendChild(sc);
    if(f.folder){ row.classList.add("proj-openbtn"); row.setAttribute("role","button"); row.tabIndex=0;
      row.addEventListener("click",function(){ openProject(f.folder); });
      row.addEventListener("keydown",function(e){ if(e.key==="Enter"||e.key===" "){ e.preventDefault(); openProject(f.folder); } }); }
    fw.appendChild(row);
  });

  // busiest hours
  var hrs = s.hourly||[];
  var hmax = hrs.reduce(function(m,v){ return Math.max(m,v||0); },1);
  var peak = -1, peakv = -1;
  hrs.forEach(function(v,i){ if((v||0)>peakv){ peakv=v||0; peak=i; } });
  var hw = $("insHours"); hw.innerHTML="";
  var ax = $("insHoursAxis"); ax.innerHTML="";
  hrs.forEach(function(v,i){
    var col = el("div","hcol"+(i===peak&&peakv>0?" peak":""));
    var bar = el("i"); bar.style.height = Math.max(1, Math.round((v||0)/hmax*72))+"px";
    col.appendChild(bar);
    col.title = String(i).padStart(2,"0")+":00 — "+(v||0).toLocaleString()+" msgs";
    hw.appendChild(col);
    if(i%6===0){ var sp=el("span"); sp.textContent=String(i).padStart(2,"0"); ax.appendChild(sp); }
    else { var sp2=el("span"); sp2.textContent=""; ax.appendChild(sp2); }
  });
  $("insPeakLbl").textContent = peak>=0&&peakv>0 ? ("peak "+String(peak).padStart(2,"0")+":00") : "";
}

/* ---------- alert banner ---------- */
var ALERT_DISMISSED = null; // signature of dismissed alert set
function alertSignature(list){ return list.map(function(s){return s.id+":"+(s.alert||"");}).join("|"); }
function renderAlertBanner(sessions){
  var alerted = (sessions||[]).filter(function(s){ return s.alert; });
  var bn = $("alertBanner");
  if(!alerted.length){ bn.classList.add("hidden"); return; }
  var sig = alertSignature(alerted);
  if(sig===ALERT_DISMISSED){ bn.classList.add("hidden"); return; }
  var first = alerted[0];
  $("abTitle").textContent = alerted.length+" tab"+(alerted.length===1?"":"s")+" need"+(alerted.length===1?"s":"")+" attention";
  $("abSub").textContent = (first.title? first.title+" — " : "")+(first.alert||"waiting for you");
  bn.classList.remove("hidden");
  bn._target = first.id;
  bn._sig = sig;
}

/* ---------- notifications + chime ---------- */
function playChime(){
  if(!CHIME_ON) return;
  try{
    if(!audioCtx){ var AC = window.AudioContext||window.webkitAudioContext; if(!AC) return; audioCtx = new AC(); }
    if(audioCtx.state==="suspended") audioCtx.resume();
    var now = audioCtx.currentTime;
    [[880,0],[1174,0.14]].forEach(function(p){
      var o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type="sine"; o.frequency.value=p[0];
      var t0 = now+p[1];
      g.gain.setValueAtTime(0,t0);
      g.gain.linearRampToValueAtTime(0.16,t0+0.02);
      g.gain.exponentialRampToValueAtTime(0.0001,t0+0.22);
      o.connect(g); g.connect(audioCtx.destination);
      o.start(t0); o.stop(t0+0.24);
    });
  }catch(e){}
}
// Fire a desktop alert the first time today's est. cost crosses the budget.
// Guarded per-date in localStorage so it fires once a day, not every refresh.
function checkBudgetAlert(cost, budget, over){
  if(!over || !budget) return;
  var today = new Date().toISOString().slice(0,10), last=null;
  try{ last = localStorage.getItem("hq_budget_alert_date"); }catch(e){}
  if(last===today) return;
  try{ localStorage.setItem("hq_budget_alert_date", today); }catch(e){}
  var msg = "Daily budget passed \u2014 "+fmtCost(cost)+" / "+fmtCost(budget);
  if(NOTIF_ON && ("Notification" in window) && Notification.permission==="granted"){
    try{ new Notification("\uD83D\uDCB8 Over budget", {body:msg, tag:"hq-budget", silent:true}); }catch(e){}
  }
  playChime();
  if(typeof toast==="function") toast("\uD83D\uDCB8 "+msg, "ach");
  if(typeof announce==="function") announce(msg);
  if(typeof logEvent==="function") logEvent("\uD83D\uDCB8", msg);
}
function fireNotification(sess){
  var body = sess.alert || "waiting for you";
  if(NOTIF_ON && ("Notification" in window) && Notification.permission==="granted"){
    try{ new Notification(sess.title||"Claude session", {body:body, tag:"hq-"+sess.id, silent:true}); }catch(e){}
  }
  playChime();
}
function checkTransitions(sessions){
  if(!BASELINE){
    (sessions||[]).forEach(function(s){ PREV[s.id]={status:s.status, alert:s.alert||null}; });
    BASELINE = true;
    return;
  }
  (sessions||[]).forEach(function(s){
    var prev = PREV[s.id];
    var enteredNeeds = s.status==="needs" && (!prev || prev.status!=="needs");
    var newAlert = s.alert && (!prev || prev.alert!==s.alert);
    if(enteredNeeds || newAlert){ fireNotification(s); speakNeeds(s);
      announce((s.title||s.name||"A session")+" now needs you"+(s.alert?": "+s.alert:""));
      logEvent("❗", (s.title||s.name||"A session")+" needs you"+(s.alert?" — "+s.alert:"")); }
    PREV[s.id] = {status:s.status, alert:s.alert||null};
  });
  // prune gone sessions
  var live = {}; (sessions||[]).forEach(function(s){ live[s.id]=1; });
  Object.keys(PREV).forEach(function(k){ if(!live[k]) delete PREV[k]; });
}
function updateBellUI(){
  var b = $("bellBtn");
  var granted = ("Notification" in window) && Notification.permission==="granted";
  b.classList.toggle("on", NOTIF_ON && granted);
  b.classList.toggle("muted-btn", !CHIME_ON && !(NOTIF_ON&&granted));
  b.innerHTML = ico(((NOTIF_ON && granted) || CHIME_ON) ? "bell" : "bell-off");
  b.title = "Notifications: "+((NOTIF_ON&&granted)?"on":"off")+" · Chime: "+(CHIME_ON?"on":"off")+" (click to toggle)";
  b.setAttribute("aria-pressed", ((NOTIF_ON&&granted)||CHIME_ON) ? "true":"false");
  var mn=$("menuNotif"); if(mn) mn.setAttribute("aria-pressed",(NOTIF_ON&&granted)?"true":"false");
}

/* ---------- voice alerts ---------- */
function speakNeeds(sess){
  if(!VOICE || !("speechSynthesis" in window)) return;
  try{
    var u = new SpeechSynthesisUtterance((sess.title||"A session")+" needs you.");
    u.rate = 1.0; u.volume = 0.9;
    window.speechSynthesis.speak(u);
  }catch(e){}
}
function toggleVoice(){
  VOICE = !VOICE;
  localStorage.setItem("hq_voice", VOICE?"1":"0");
  if(VOICE && ("speechSynthesis" in window)){
    try{ window.speechSynthesis.speak(new SpeechSynthesisUtterance("Voice alerts on")); }catch(e){}
  }
  var mv = $("menuVoice"); if(mv){ mv.innerHTML = ico("volume")+"Voice alerts: "+(VOICE?"on":"off"); mv.setAttribute("aria-pressed",VOICE?"true":"false"); }
  toast(VOICE?"🗣️ Voice alerts on":"🗣️ Voice alerts off","level");
}

/* ---------- daily digest ---------- */
function todayLocalISO(){
  var d=new Date(), p=function(n){return String(n).padStart(2,"0");};
  return d.getFullYear()+"-"+p(d.getMonth()+1)+"-"+p(d.getDate());
}
// tiny, SAFE markdown -> HTML (escape first, then a few block/inline rules)
function mdToHtml(md){
  var lines = String(md||"").split("\n"), out=[], inList=false;
  function inline(t){
    t = esc(t);
    t = t.replace(/\*\*([^*]+)\*\*/g,"<strong>$1</strong>");
    t = t.replace(/\bhttps?:\/\/[^\s)]+/g,function(u){ return '<a href="'+u+'" target="_blank" rel="noopener">'+u+'</a>'; });
    return t;
  }
  lines.forEach(function(ln){
    if(/^#\s+/.test(ln)){ if(inList){out.push("</ul>");inList=false;} out.push("<h1>"+inline(ln.replace(/^#\s+/,""))+"</h1>"); }
    else if(/^##\s+/.test(ln)){ if(inList){out.push("</ul>");inList=false;} out.push("<h2>"+inline(ln.replace(/^##\s+/,""))+"</h2>"); }
    else if(/^-\s+/.test(ln)){ if(!inList){out.push("<ul>");inList=true;} out.push("<li>"+inline(ln.replace(/^-\s+/,""))+"</li>"); }
    else if(ln.trim()===""){ if(inList){out.push("</ul>");inList=false;} }
    else { if(inList){out.push("</ul>");inList=false;} out.push("<p>"+inline(ln)+"</p>"); }
  });
  if(inList) out.push("</ul>");
  return out.join("");
}
/* ---- digest Day/Week mode (persisted) ---- */
var DIGEST_MODE = (localStorage.getItem("hq_digest_mode")==="week") ? "week" : "day";
function digestDays(){ return DIGEST_MODE==="week" ? 7 : 1; }
// Shift an ISO (YYYY-MM-DD) date by delta days, staying in local calendar terms.
function isoAddDays(iso, delta){
  var p=String(iso||"").split("-"); var d=new Date(+p[0], (+p[1]||1)-1, +p[2]||1);
  d.setDate(d.getDate()+(delta|0));
  var pad=function(n){return String(n).padStart(2,"0");};
  return d.getFullYear()+"-"+pad(d.getMonth()+1)+"-"+pad(d.getDate());
}
function refreshDigestModeUI(){
  var dm=$("digestModeDay"), wk=$("digestModeWeek");
  if(dm){ var onD=DIGEST_MODE==="day"; dm.classList.toggle("on",onD); dm.setAttribute("aria-pressed",onD?"true":"false"); }
  if(wk){ var onW=DIGEST_MODE==="week"; wk.classList.toggle("on",onW); wk.setAttribute("aria-pressed",onW?"true":"false"); }
}
function updateDigestTitle(date, days){
  var t=$("digestTitle"); if(!t) return;
  if(days>1) t.textContent = "📝 Weekly Digest — "+isoAddDays(date,-(days-1))+" → "+date;
  else t.textContent = "📝 Daily Digest";
}
function setDigestMode(m){
  DIGEST_MODE = (m==="week") ? "week" : "day";
  localStorage.setItem("hq_digest_mode", DIGEST_MODE);
  refreshDigestModeUI();
  loadDigest();
}
function openDigest(date){
  rememberOpener();
  var dt = $("digestDate");
  if(typeof date==="string" && /^\d{4}-\d{2}-\d{2}$/.test(date)) dt.value=date;
  else if(!dt.value) dt.value = todayLocalISO();
  refreshDigestModeUI();
  $("digestBack").classList.add("open");
  loadDigest();
  dt.focus();
}
function loadDigest(){
  var date = $("digestDate").value || todayLocalISO();
  var days = digestDays();
  updateDigestTitle(date, days);
  $("digestBody").innerHTML = LOADING_HTML;
  fetch("/api/digest?days="+days+"&date="+encodeURIComponent(date),{cache:"no-store"})
    .then(function(r){ return r.json(); })
    .then(function(d){ $("digestBody").innerHTML = mdToHtml(d.markdown||"_empty_"); })
    .catch(function(){ $("digestBody").textContent = "Could not load digest."; });
}
function closeDigest(){ $("digestBack").classList.remove("open"); restoreOpener(); }

/* ---------- focus / now-playing ---------- */
function openFocus(sid){ rememberOpener(); FOCUS_ID = sid; $("focus").classList.add("on"); renderFocus(); $("focusClose").focus(); }
function closeFocus(){ FOCUS_ID = null; $("focus").classList.remove("on"); restoreOpener(); }

/* ---- Focus timer (Pomodoro) — keeps running even if the overlay is closed ---- */
var FT_TOTAL=0, FT_END=0, FT_TICK=null;
function ftFmt(sec){ sec=Math.max(0,sec|0); var m=(sec/60)|0, s=sec%60; return (m<10?"0":"")+m+":"+(s<10?"0":"")+s; }
function ftStart(mins){
  FT_TOTAL=mins*60; FT_END=Date.now()+FT_TOTAL*1000;
  $("ft25").hidden=true; $("ft50").hidden=true; $("ftStop").hidden=false;
  $("ftRing").classList.remove("done"); $("ftLbl").textContent=mins+"-minute focus — you've got this";
  if(FT_TICK) clearInterval(FT_TICK); FT_TICK=setInterval(ftUpdate,250); ftUpdate();
}
function ftReset(){
  if(FT_TICK){ clearInterval(FT_TICK); FT_TICK=null; } FT_END=0;
  $("ft25").hidden=false; $("ft50").hidden=false; $("ftStop").hidden=true;
  var r=$("ftRing"); r.classList.remove("done"); r.style.setProperty("--p",0);
  $("ftClock").textContent="25:00"; $("ftLbl").textContent="Focus timer";
}
function ftUpdate(){
  var left=Math.round((FT_END-Date.now())/1000);
  if(left<=0){ $("ftClock").textContent="00:00"; $("ftRing").style.setProperty("--p",100); ftComplete(); return; }
  $("ftClock").textContent=ftFmt(left);
  $("ftRing").style.setProperty("--p", Math.round(100*(1-left/FT_TOTAL)));
}
function ftComplete(){
  if(FT_TICK){ clearInterval(FT_TICK); FT_TICK=null; } FT_END=0;
  $("ft25").hidden=false; $("ft50").hidden=false; $("ftStop").hidden=true;
  $("ftRing").classList.add("done"); $("ftLbl").textContent="✅ Focus complete — nice work!";
  toast("✅ Focus session complete!","level");
  if(!calmMode()) confettiBurst();
  try{ playChime(); }catch(e){}   // only sounds if you enabled the chime toggle
}
$("ft25").addEventListener("click",function(){ ftStart(25); });
$("ft50").addEventListener("click",function(){ ftStart(50); });
$("ftStop").addEventListener("click",ftReset);
function renderFocus(){
  if(!FOCUS_ID) return;
  var s = (STATE && STATE.sessions || []).filter(function(x){return x.sessionId===FOCUS_ID;})[0];
  var f = $("focus");
  if(!s){ f.classList.remove("working"); $("focusTitle").textContent="Session ended";
          $("focusNow").style.display="none"; $("focusCreature").classList.remove("cre-svg","shiny","fz-tired","fz-fatigued","fz-ko");
          $("focusCreature").textContent="💤"; $("focusMeta").innerHTML=""; return; }
  f.classList.toggle("working", s.status==="working");
  paintCreature($("focusCreature"), s.creature, 120, false);
  $("focusTitle").textContent = s.title||"Untitled session";
  var now=$("focusNow");
  if(s.status==="working"){ now.style.display=""; now.innerHTML=orb("sm",orbStateFor(s.now))+esc(s.now||"Thinking…"); }
  else { now.style.display="none"; }
  $("focusAsk").textContent = s.lastPrompt ? ("“"+s.lastPrompt+"”") : "";
  var tk = s.tokens||{}, ff = fzOf(s.creature);
  $("focusMeta").innerHTML =
    '<div><b>'+esc(creatureSpecies(s.creature))+'</b>'+esc(creatureStageName(s.creature))+'</div>'+
    (ff ? '<div><b>'+fzPct(ff)+'%</b>energy'+(ff.state==="rested"?'':' \u00B7 '+esc(fzLabel(ff.state).toLowerCase()))+'</div>' : '')+
    '<div><b>'+esc(fmtAge(s.ageSecs))+'</b>since activity</div>'+
    '<div><b>'+esc(s.status)+'</b>status</div>'+
    '<div><b>'+esc(fmtTok(tk.output||0))+'</b>output tok</div>'+
    '<div><b>≈'+esc(fmtCost(tk.estCostUSD||0))+'</b>list-price</div>'+
    '<div><b>'+(s.promptCount||0)+'</b>prompts</div>';
}

