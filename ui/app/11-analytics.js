/* ---- analytics view (history) ---- */
var HISTORY=null, historyTimer=null, historyLoading=false;
function loadHistory(){
  if(historyLoading) return;
  historyLoading=true;
  fetch('/api/history',{cache:"no-store"})
    .then(function(r){ if(!r.ok) throw new Error(r.status); return r.json(); })
    .then(function(d){ HISTORY=d; renderAnalytics(d); })
    .catch(function(){ /* leave placeholders */ })
    .then(function(){ historyLoading=false; });
}
/* ---- 💡 insights (analytics view) ---- */
var insightsLoading=false;
function loadInsights(){
  if(insightsLoading) return;
  insightsLoading=true;
  fetch('/api/insights',{cache:"no-store"})
    .then(function(r){ if(!r.ok) throw new Error(r.status); return r.json(); })
    .then(function(d){ renderSmartInsights(d); })
    .catch(function(){ /* keep prior content on failure */ })
    .then(function(){ insightsLoading=false; });
}
// renamed from renderInsights to avoid clobbering the HUD's renderInsights(season)
function renderSmartInsights(d){
  var box=$("insightsList"); if(!box) return;
  var list = Array.isArray(d) ? d : (d && Array.isArray(d.insights) ? d.insights : []);
  if(!list.length){
    box.innerHTML='<div class="insight-empty">No insights right now — keep shipping and check back later.</div>';
    return;
  }
  box.innerHTML="";
  list.forEach(function(it){
    it=it||{};
    var kind=String(it.kind||it.level||it.severity||"info").toLowerCase();
    var cls="insight-item", def="💡";
    if(kind==="good"||kind==="success"){ cls+=" good"; def="✅"; }
    else if(kind==="warn"||kind==="warning"){ cls+=" warn"; def="⚠️"; }
    else if(kind==="bad"||kind==="error"||kind==="danger"||kind==="alert"){ cls+=" bad"; def="🚨"; }
    var icon=it.icon||it.emoji||def;
    var title=it.title||it.label||it.name||"";
    var detail=it.detail||it.text||it.desc||it.description||it.body||"";
    var row=el("div",cls);
    row.innerHTML='<span class="ii-ic">'+esc(icon)+'</span><div class="ii-body">'+
      '<div class="ii-t">'+esc(title)+'</div>'+
      (detail?('<div class="ii-d">'+esc(detail)+'</div>'):'')+'</div>';
    box.appendChild(row);
  });
}
function renderAnalytics(h){
  if(!h) return;
  var tot = h.totals||{};
  $("aT_trans").textContent = (tot.transcripts!=null?tot.transcripts:0).toLocaleString();
  $("aT_days").textContent  = (tot.activeDays!=null?tot.activeDays:0).toLocaleString();
  $("aT_out").textContent   = fmtTok(tot.output||tot.outputTokens||0);
  $("aT_cost").textContent  = fmtCost(tot.estCostUSD!=null?tot.estCostUSD:(tot.cost||0));
  renderHeatmap(h.heatmap||[]);
  renderTrend(h.daily||[]);
  renderByHour(h.byHour||[]);
  renderByDow(h.byDow||[]);
  renderHall(h.hallOfFame||[]);
  renderAccount(h);
}
var MODEL_HUE={Opus:262,Sonnet:212,Haiku:150,Fable:325,unknown:220};
function renderAccount(h){
  var models=h.modelBreakdown||[], folders=h.costByFolder||[], tot=h.totals||{};
  var lifeCost=0, lifeOut=0, lifeSess=0;
  models.forEach(function(m){ lifeCost+=m.estCostUSD||0; lifeOut+=m.output||0; lifeSess+=m.sessions||0; });
  var tiles=$("acctTiles");
  tiles.innerHTML=
    '<div class="tile"><div class="n">'+esc((tot.transcripts||lifeSess||0).toLocaleString())+'</div><div class="l">Sessions</div><div class="sfx">all-time</div></div>'+
    '<div class="tile"><div class="n">'+esc(fmtTok(lifeOut))+'</div><div class="l">Output tokens</div><div class="sfx">all-time</div></div>'+
    '<div class="tile"><div class="n">'+esc(fmtCost(lifeCost))+'</div><div class="l">List-price est.</div><div class="sfx">all-time</div></div>'+
    '<div class="tile"><div class="n">'+esc((tot.activeDays||0).toLocaleString())+'</div><div class="l">Active days</div><div class="sfx">91d</div></div>';
  var maxM=models.reduce(function(a,m){return Math.max(a,m.estCostUSD||0);},1);
  var mw=$("acctModels"); mw.innerHTML = models.length? "" : '<div class="cost-sub">No model data.</div>';
  models.forEach(function(m){
    var hue=MODEL_HUE[m.model]!=null?MODEL_HUE[m.model]:220;
    var row=el("div","acct-row");
    row.innerHTML='<div class="acct-lbl">'+esc(m.model)+' <span class="acct-sub">'+esc(m.sessions)+' · '+esc(fmtTok(m.output))+' out</span></div>'+
      '<div class="acct-bar"><i style="width:'+Math.round((m.estCostUSD||0)/maxM*100)+'%;background:hsl('+hue+',65%,55%)"></i></div>'+
      '<div class="acct-val">'+esc(fmtCost(m.estCostUSD||0))+'</div>';
    mw.appendChild(row);
  });
  var maxF=folders.reduce(function(a,f){return Math.max(a,f.estCostUSD||0);},1);
  var fw=$("acctFolders"); fw.innerHTML = folders.length? "" : '<div class="cost-sub">No project data.</div>';
  folders.forEach(function(f){
    var row=el("div","acct-row");
    row.innerHTML='<div class="acct-lbl">'+esc(prettyFolder(f.folder))+'</div>'+
      '<div class="acct-bar"><i style="width:'+Math.round((f.estCostUSD||0)/maxF*100)+'%;background:hsl(212,60%,55%)"></i></div>'+
      '<div class="acct-val">'+esc(fmtCost(f.estCostUSD||0))+'</div>';
    if(f.folder){ row.classList.add("proj-openbtn"); row.setAttribute("role","button"); row.tabIndex=0;
      row.title=(f.folder||"")+" · click to open";
      row.addEventListener("click",function(){ openProject(f.folder); });
      row.addEventListener("keydown",function(e){ if(e.key==="Enter"||e.key===" "){ e.preventDefault(); openProject(f.folder); } }); }
    fw.appendChild(row);
  });
}
function renderHeatmap(cells){
  var outer=$("aHeatmap");
  if(!cells.length){ outer.innerHTML='<div class="feed-empty">No history yet.</div>'; $("aHmLegend").innerHTML=""; return; }
  // cells: flat array oldest->newest, each {date,count,level}. Pad front so col0 starts on Sunday.
  var norm = cells.map(function(c){
    var lvl = c.level; if(lvl==null){ lvl = c.heat!=null?c.heat:0; }
    return {date:c.date||"", count:c.count||0, level:Math.max(0,Math.min(4,lvl))};
  });
  var first = norm[0] && norm[0].date ? new Date(norm[0].date+"T00:00:00") : null;
  var pad = first ? first.getDay() : 0;   // 0=Sun
  outer.innerHTML="";
  var days=["","Mon","","Wed","","Fri",""];
  var wd=el("div","hm-weekdays");
  days.forEach(function(d){ var s=el("span"); s.textContent=d; wd.appendChild(s); });
  outer.appendChild(wd);
  var colsWrap=el("div","hm-cols");
  var months=el("div","hm-months");
  var grid=el("div","hm-grid");
  var totalCells = pad + norm.length;
  var weeks = Math.ceil(totalCells/7);
  // month labels: one span per week, label when the week's first day starts a new month
  var seenMonth=-1;
  for(var w=0; w<weeks; w++){
    var span=el("span");
    var idx = w*7 - pad;
    var cell = norm[idx];
    if(cell && cell.date){
      var mo = new Date(cell.date+"T00:00:00").getMonth();
      if(mo!==seenMonth){ span.textContent = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][mo]; seenMonth=mo; }
    }
    months.appendChild(span);
  }
  for(var i=0;i<totalCells;i++){
    var c2=el("div","hm-cell");
    if(i<pad){ c2.className="hm-cell blank"; }
    else{
      var item=norm[i-pad];
      if(item){ if(item.level>0) c2.classList.add("l"+item.level);
        c2.title = item.date+" · "+item.count+" msg"+(item.count===1?"":"s")+" — click for that day's digest";
        c2.style.cursor="pointer"; c2.setAttribute("role","button"); c2.tabIndex=0;
        (function(dt){
          c2.addEventListener("click",function(){ openDigest(dt); });
          c2.addEventListener("keydown",function(e){ if(e.key==="Enter"||e.key===" "){ e.preventDefault(); openDigest(dt); } });
        })(item.date);
      }
    }
    grid.appendChild(c2);
  }
  colsWrap.appendChild(months); colsWrap.appendChild(grid); outer.appendChild(colsWrap);
  var lg=$("aHmLegend"); lg.innerHTML="";
  var less=el("span"); less.textContent="Less"; less.style.marginRight="2px"; lg.appendChild(less);
  [0,1,2,3,4].forEach(function(l){ var i2=el("i"); i2.style.background="var(--heat"+l+")"; lg.appendChild(i2); });
  var more=el("span"); more.textContent="More"; more.style.marginLeft="2px"; lg.appendChild(more);
}
function renderTrend(daily){
  var wrap=$("aTrend"); var lg=$("aTrendLegend");
  if(!daily.length){ wrap.innerHTML='<div class="feed-empty">No daily data.</div>'; lg.innerHTML=""; return; }
  // The plot stretches to the panel width (preserveAspectRatio="none"); axis labels are
  // HTML laid over it so they stay a fixed size instead of scaling with the SVG.
  var W=1000,H=180,PT=8;
  var outs = daily.map(function(d){ return d.output!=null?d.output:(d.outputTokens||0); });
  var costs = daily.map(function(d){ return d.cost!=null?d.cost:(d.usd!=null?d.usd:(d.estCostUSD||0)); });
  var maxO=Math.max.apply(null,outs.concat([1]));
  var maxC=Math.max.apply(null,costs.concat([0.0001]));
  var n=daily.length;
  function xx(i){ return n<=1?W/2:i*W/(n-1); }
  function yO(v){ return PT + (1-(v/maxO))*(H-PT); }
  function yC(v){ return PT + (1-(v/maxC))*(H-PT); }
  function pct(i){ return (xx(i)/W*100).toFixed(3)+"%"; }
  var area = "M0,"+H+" L"+outs.map(function(v,i){ return xx(i)+","+yO(v); }).join(" L")+" L"+xx(n-1)+","+H+" Z";
  var lineO = "M"+outs.map(function(v,i){ return xx(i)+","+yO(v); }).join(" L");
  var lineC = "M"+costs.map(function(v,i){ return xx(i)+","+yC(v); }).join(" L");
  var mid=Math.floor((n-1)/2);
  function dl(i){ var d=daily[i].date||""; return d.slice(5); }
  var ns='vector-effect="non-scaling-stroke"';
  var svg='<svg viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="none" role="img" aria-label="Output tokens and cost over '+n+' days. Peak '+fmtTok(maxO)+' output tokens, '+fmtCost(maxC)+' est cost.">';
  svg+='<line x1="0" y1="'+(PT+(H-PT)/2)+'" x2="'+W+'" y2="'+(PT+(H-PT)/2)+'" stroke="var(--line)" stroke-width="1" stroke-dasharray="3 4" '+ns+'/>';
  svg+='<line x1="0" y1="'+PT+'" x2="'+W+'" y2="'+PT+'" stroke="var(--line)" stroke-width="1" stroke-dasharray="3 4" '+ns+'/>';
  svg+='<line x1="0" y1="'+H+'" x2="'+W+'" y2="'+H+'" stroke="var(--line2)" stroke-width="1" '+ns+'/>';
  svg+='<path d="'+area+'" fill="var(--brand)" opacity="0.12"/>';
  svg+='<path d="'+lineO+'" fill="none" stroke="var(--brand)" stroke-width="2" stroke-linejoin="round" '+ns+'/>';
  svg+='<path d="'+lineC+'" fill="none" stroke="var(--gold)" stroke-width="2" stroke-linejoin="round" stroke-dasharray="4 3" '+ns+'/>';
  svg+='</svg>';
  var yl='<span class="ty ty-l" style="top:0">'+fmtTok(maxO)+'</span>'+
         '<span class="ty ty-l" style="top:50%">'+fmtTok(maxO/2)+'</span>'+
         '<span class="ty ty-l" style="top:100%">0</span>'+
         '<span class="ty ty-r" style="top:0">'+fmtCost(maxC)+'</span>'+
         '<span class="ty ty-r" style="top:50%">'+fmtCost(maxC/2)+'</span>';
  var xl='<span style="left:0;transform:none">'+esc(dl(0))+'</span>'+
         (n>2?'<span style="left:'+pct(mid)+'">'+esc(dl(mid))+'</span>':'')+
         (n>1?'<span style="left:100%;transform:translateX(-100%)">'+esc(dl(n-1))+'</span>':'');
  wrap.innerHTML='<div class="trend-plot">'+svg+yl+'</div><div class="trend-x">'+xl+'</div>';
  lg.innerHTML='<span><i style="background:var(--brand)"></i>Output tokens</span><span><i style="background:var(--gold)"></i>Est cost (USD)</span>';
}
function renderByHour(arr){
  var hw=$("aByHour"), ax=$("aByHourAxis"); hw.innerHTML=""; ax.innerHTML="";
  if(!arr.length){ hw.innerHTML='<div class="feed-empty">No data.</div>'; $("aHourPeak").textContent=""; return; }
  var mx=arr.reduce(function(m,v){ return Math.max(m,v||0); },1);
  var peak=-1,pv=-1; arr.forEach(function(v,i){ if((v||0)>pv){pv=v||0;peak=i;} });
  arr.forEach(function(v,i){
    var col=el("div","hcol"+(i===peak&&pv>0?" peak":""));
    var bar=el("i"); bar.style.height=Math.max(1,Math.round((v||0)/mx*72))+"px"; col.appendChild(bar);
    col.title=String(i).padStart(2,"0")+":00 — "+(v||0).toLocaleString();
    hw.appendChild(col);
    var sp=el("span"); sp.textContent = (i%6===0)?String(i).padStart(2,"0"):""; ax.appendChild(sp);
  });
  $("aHourPeak").textContent = peak>=0&&pv>0 ? ("peak "+String(peak).padStart(2,"0")+":00") : "";
}
function renderByDow(arr){
  var w=$("aByDow"); w.innerHTML="";
  var names=["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  if(!arr.length){ w.innerHTML='<div class="feed-empty">No data.</div>'; return; }
  var mx=arr.reduce(function(m,v){ return Math.max(m,v||0); },1);
  var peak=-1,pv=-1; arr.forEach(function(v,i){ if((v||0)>pv){pv=v||0;peak=i;} });
  arr.forEach(function(v,i){
    var col=el("div","dcol"+(i===peak&&pv>0?" peak":""));
    var bar=el("i"); bar.style.height=Math.max(2,Math.round((v||0)/mx*88))+"px"; col.appendChild(bar);
    var lb=el("div","dlbl"); lb.textContent=names[i]||("D"+i); col.appendChild(lb);
    col.title=(names[i]||"")+" — "+(v||0).toLocaleString();
    w.appendChild(col);
  });
}
function renderHall(list){
  var w=$("aHall"); w.innerHTML="";
  if(!list.length){ w.innerHTML='<div class="feed-empty">No sessions yet.</div>'; return; }
  list.slice(0,15).forEach(function(h,i){
    var row=el("div","hallrow");
    var rk=el("div","hrank"); rk.textContent = h.rank!=null?h.rank:(i+1); row.appendChild(rk);
    var nm=el("div","hname");
    var tt=el("div","htitle"); tt.textContent = h.title||"Untitled"; nm.appendChild(tt);
    var fo=el("div","hfolder"); fo.textContent = prettyFolder(h.folder||""); nm.appendChild(fo);
    row.appendChild(nm);
    var out=el("div","hout"); out.textContent = fmtTok(h.output!=null?h.output:(h.outputTokens||0)); row.appendChild(out);
    var co=el("div","hcost"); co.textContent = fmtCost(h.estCostUSD!=null?h.estCostUSD:(h.cost||0)); row.appendChild(co);
    var sid=h.sessionId||h.id;
    row.addEventListener("click",function(){ if(sid) openSession(sid,{title:h.title,folder:h.folder}); });
    w.appendChild(row);
  });
}
// refresh analytics while the view is open
historyTimer=setInterval(function(){ if(VIEW==="analytics" && !document.hidden) loadHistory(); }, 30000);
var insightsTimer=setInterval(function(){ if(VIEW==="analytics" && !document.hidden) loadInsights(); }, 60000);

