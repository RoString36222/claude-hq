/* ================= HQ Studio (the HQ revamp): customise your tower, your lobby and your floors ================= */
// One style document (games/hqstyle.js, HQV.hqStyle): the exterior (facade system, colours, glass, crown, entrance,
// sign, night light, flags, roof, grounds), each floor's theme, the lobby's set pieces and the decor on each floor's
// grid. Kept here (localStorage hq_style) and, when the paired Arena has the "hqstyle" capability, on the Arena
// (POST /api/arena/hq/style -> PUT /v1/hq/me/style): everyone then sees it on your tower in the City and inside when
// they visit. An older Arena: it stays on this machine, and everyone else sees the default.
// The panel: Settings / Cmd-K "HQ Studio", or the Studio kiosk in your lobby. Every change previews live (your tower,
// your lobby, Mission Control); Save keeps it, Close without saving puts the saved look back.
var HQ_STUDIO = {doc:null, draft:null, remote:null, note:"", tab:"ext", sel:"plant", rot:0, cur:{f:"lobby", x:0, z:0}, synced:false, back:null};
var HQ_STUDIO_SMOKE = (function(){ var m=/[?&]hqstyle=([a-z]+)/.exec(location.search); return m ? m[1] : null; })();
function hqStudioLocal(){ try { var j=JSON.parse(localStorage.getItem("hq_style")||"null"); return j && typeof j==="object" ? j : null; } catch(e){ return null; } }
function hqStudioKeep(d){ try { if(d) localStorage.setItem("hq_style", JSON.stringify(d)); else localStorage.removeItem("hq_style"); } catch(e){} }
function hqStudioS(){ return window.HQV && window.HQV.hqStyle; }
// your style now: the draft while the Studio is open, else the saved one (the Arena's copy wins once loaded)
function hqStyleDoc(){
  if(HQ_STUDIO.draft) return HQ_STUDIO.draft;
  if(HQ_STUDIO.doc) return HQ_STUDIO.doc;
  var l=hqStudioLocal(); if(l) return l;
  var S=hqStudioS();
  if(HQ_STUDIO_SMOKE && S) return S.preset(HQ_STUDIO_SMOKE, S.lobbyPreset(HQ_STUDIO_SMOKE === "glass" ? "atrium" : "gallery"));   // ?hqsmoke=1&hqstyle=deco (tools)
  return null;
}
function hqStudioCan(){ return !!(window.ARENA && ARENA.paired) && typeof hqNetCan==="function" && hqNetCan("hqstyle"); }
// The Arena's copy, once (and again after pairing): it wins over this browser's.
function hqStudioSync(force){
  if((HQ_STUDIO.synced && !force) || !hqStudioCan() || typeof hqArena!=="function") return;
  HQ_STUDIO.synced=true;
  hqArena("GET","/api/arena/hq/style").then(function(res){
    if(!res.ok){ if(res.code===404) HQ_STUDIO.remote=false; return; }
    HQ_STUDIO.remote=true;
    var S=hqStudioS(), st=res.j && res.j.style;
    if(st && S){ HQ_STUDIO.doc=S.clean(st); hqStudioKeep(HQ_STUDIO.doc); hqStudioApply(); }
  }).catch(function(){});
}
// the City's list with your own entry wearing your style (the draft while you preview; an Arena without "hqstyle"
// never sends one, so this is also how you see your own local-only style)
function hqStudioCity(list){
  var d=hqStyleDoc(), S=hqStudioS();
  return (list||[]).map(function(h){
    if(h && h.isYou && d) return Object.assign({}, h, {style:d});
    if(h && h.stylePreset && !h.style && S) return Object.assign({}, h, {style:S.preset(h.stylePreset)});   // ?hqsmoke=1&hqstyles=1 (tools)
    return h;
  });
}
function hqStudioApply(){
  if(typeof HQ3D==="undefined" || !HQ3D || !HQ3D.inst || HQ3D.visit) return;
  if(HQ3D.inst.lookChanged) HQ3D.inst.lookChanged();
  if(HQ3D.inst.cityChanged) HQ3D.inst.cityChanged();
}
function hqStudioSave(){
  var S=hqStudioS(); if(!S) return;
  var d=S.clean(HQ_STUDIO.draft||hqStyleDoc()||S.defaults()), chk=S.check(d);
  if(!chk.ok){ hqStudioNote("Not saved: "+chk.err); return; }
  HQ_STUDIO.doc=chk.style; hqStudioKeep(HQ_STUDIO.doc);
  if(!hqStudioCan()){ hqStudioNote(window.ARENA && ARENA.paired ? "Saved on this machine. This Arena doesn't keep HQ styles yet, so others see the default." : "Saved on this machine. Pair with an Arena so others see it."); hqStudioApply(); return; }
  hqStudioNote("Saving…");
  hqArena("POST","/api/arena/hq/style",{style:HQ_STUDIO.doc}).then(function(res){
    if(res.ok){ HQ_STUDIO.remote=true; hqStudioNote("Saved. Everyone sees it on your tower and in your lobby."); }
    else if(res.code===404){ HQ_STUDIO.remote=false; hqStudioNote("Saved on this machine. This Arena doesn't keep HQ styles yet."); }
    else hqStudioNote("Saved here. "+((res.j && (res.j.error||res.j.detail))||"The Arena didn't answer."));
  }).catch(function(){ hqStudioNote("Saved here. The Arena didn't answer."); });
  hqStudioApply();
}
function hqStudioNote(t){ HQ_STUDIO.note=t; var n=$("hqsNote"); if(n) n.textContent=t; if(typeof announce==="function") announce(t); }

/* ---- the panel ---- */
var HQS_TABS=[["ext","Exterior"],["lobby","Lobby"],["floors","Floors"],["layout","Layout"]];
var HQS_NAMES={facade:"Facade", material:"Material", tint:"Glass tint", crown:"Crown", entrance:"Entrance", font:"Sign font", flags:"Flags",
  land:"Grounds", body:"Facade colour", trim:"Trim", signColor:"Sign colour", night:"Night light", flagColor:"Flag colour", roof:"Roof extras", balcony:"Balconies",
  ceiling:"Ceiling", reception:"Reception", centre:"Centrepiece", seating:"Seating", art:"Art", rug:"Rug", signage:"Signage", ambience:"Ambience",
  wall:"Walls", floor:"Floor", mood:"Lighting", furn:"Furniture"};
function hqsWord(v){ v=String(v); return v.charAt(0).toUpperCase()+v.slice(1); }
function hqStudioOpen(tab){
  var S=hqStudioS();
  if(!S){ if(typeof hqLoadScripts==="function") hqLoadScripts().then(function(){ hqStudioOpen(tab); }).catch(function(){ toast("HQ Studio needs the 3D HQ's files","ach"); }); return; }
  HQ_STUDIO.draft=S.clean(hqStyleDoc()); if(tab) HQ_STUDIO.tab=tab;
  HQ_STUDIO.back=document.activeElement;
  var bk=$("hqStudio"); if(!bk){ bk=hqStudioBuild(); document.body.appendChild(bk); }
  bk.classList.add("open"); hqStudioRender();
  var f=bk.querySelector(".hqs-tab[aria-selected=true]"); if(f) f.focus();
  hqStudioGrid(true);
}
function hqStudioClose(save){
  var bk=$("hqStudio"); if(!bk) return;
  if(save) hqStudioSave();
  HQ_STUDIO.draft=null; bk.classList.remove("open"); hqStudioGrid(false); hqStudioApply();
  if(HQ_STUDIO.back && HQ_STUDIO.back.focus) HQ_STUDIO.back.focus();
}
function hqStudioBuild(){
  var bk=document.createElement("div"); bk.className="modalback hqs-back"; bk.id="hqStudio";
  var m=document.createElement("div"); m.className="modal hqs"; m.setAttribute("role","dialog"); m.setAttribute("aria-modal","true"); m.setAttribute("aria-labelledby","hqsTitle");
  var h=document.createElement("div"); h.className="modal-h";
  var t=document.createElement("h3"); t.id="hqsTitle"; t.textContent="HQ Studio"; h.appendChild(t);
  var tabs=document.createElement("div"); tabs.className="hqs-tabs"; tabs.setAttribute("role","tablist"); tabs.setAttribute("aria-label","HQ Studio sections");
  HQS_TABS.forEach(function(tb){
    var b=document.createElement("button"); b.type="button"; b.className="hqs-tab"; b.id="hqsTab-"+tb[0]; b.setAttribute("role","tab"); b.textContent=tb[1];
    b.addEventListener("click", function(){ HQ_STUDIO.tab=tb[0]; hqStudioRender(); b.focus(); });
    b.addEventListener("keydown", function(e){
      if(e.key!=="ArrowRight" && e.key!=="ArrowLeft") return; e.preventDefault();
      var i=HQS_TABS.findIndex(function(x){ return x[0]===HQ_STUDIO.tab; }), n=(i+(e.key==="ArrowRight"?1:HQS_TABS.length-1))%HQS_TABS.length;
      HQ_STUDIO.tab=HQS_TABS[n][0]; hqStudioRender(); var nb=$("hqsTab-"+HQ_STUDIO.tab); if(nb) nb.focus();
    });
    tabs.appendChild(b);
  });
  h.appendChild(tabs);
  var x=document.createElement("button"); x.type="button"; x.className="hbtn icon ghost"; x.setAttribute("aria-label","Close HQ Studio without saving"); x.textContent="✕";
  x.addEventListener("click", function(){ hqStudioClose(false); }); h.appendChild(x);
  m.appendChild(h);
  var body=document.createElement("div"); body.className="modal-b hqs-body"; body.id="hqsBody"; body.setAttribute("role","tabpanel"); m.appendChild(body);
  var foot=document.createElement("div"); foot.className="hqs-foot";
  [["Randomise", function(){ var S=hqStudioS(); HQ_STUDIO.draft=S.randomise(Date.now() + ":" + Math.floor(performance.now()), HQ_STUDIO.draft); hqStudioChanged(); }],
   ["Reset", function(){ var S=hqStudioS(), d=S.defaults(); d.int.items=HQ_STUDIO.draft.int.items; HQ_STUDIO.draft=d; hqStudioChanged(); }],
   ["Save", function(){ hqStudioSave(); }],
   ["Done", function(){ hqStudioClose(true); }]].forEach(function(a){
    var b=document.createElement("button"); b.type="button"; b.className="hbtn"+(a[0]==="Done"?"":" ghost"); b.textContent=a[0]; b.addEventListener("click", a[1]); foot.appendChild(b);
  });
  var note=document.createElement("span"); note.className="muted hqs-note"; note.id="hqsNote"; note.setAttribute("aria-live","polite"); foot.appendChild(note);
  m.appendChild(foot); bk.appendChild(m);
  bk.addEventListener("keydown", function(e){ if(e.key==="Escape"){ e.preventDefault(); e.stopPropagation(); hqStudioClose(false); } });
  bk.addEventListener("click", function(e){ if(e.target===bk) hqStudioClose(false); });
  return bk;
}
function hqStudioChanged(){ hqStudioRender(); hqStudioApply(); }
// a row of choices (role radiogroup; arrows move, the pressed one is the value)
function hqsChoices(parent, label, opts, cur, set){
  var row=document.createElement("div"); row.className="hqs-row";
  var l=document.createElement("span"); l.className="hqs-l"; l.textContent=label; row.appendChild(l);
  var g=document.createElement("div"); g.className="hqs-chips"; g.setAttribute("role","radiogroup"); g.setAttribute("aria-label",label);
  opts.forEach(function(o, i){
    var v=Array.isArray(o)?o[0]:o, txt=Array.isArray(o)?o[1]:hqsWord(o);
    var b=document.createElement("button"); b.type="button"; b.className="hqs-chip"; b.textContent=txt; b.setAttribute("role","radio");
    var on=v===cur; b.setAttribute("aria-checked", on?"true":"false"); b.tabIndex=on || (cur==null && i===0) ? 0 : -1;
    b.addEventListener("click", function(){ set(v); hqStudioChanged(); var nb=$("hqsBody").querySelector('[aria-label="'+label+'"] [aria-checked=true]'); if(nb) nb.focus(); });
    b.addEventListener("keydown", function(e){
      var k=e.key==="ArrowRight"||e.key==="ArrowDown" ? 1 : e.key==="ArrowLeft"||e.key==="ArrowUp" ? -1 : 0; if(!k) return; e.preventDefault();
      var j=(i+k+opts.length)%opts.length, nv=Array.isArray(opts[j])?opts[j][0]:opts[j]; set(nv); hqStudioChanged();
      var nb=$("hqsBody").querySelector('[aria-label="'+label+'"] [aria-checked=true]'); if(nb) nb.focus();
    });
    g.appendChild(b);
  });
  row.appendChild(g); parent.appendChild(row);
}
function hqsColor(parent, label, cur, set){
  var row=document.createElement("label"); row.className="hqs-row";
  var l=document.createElement("span"); l.className="hqs-l"; l.textContent=label; row.appendChild(l);
  var i=document.createElement("input"); i.type="color"; i.value=cur; i.className="hqs-color"; i.setAttribute("aria-label",label);
  i.addEventListener("input", function(){ if(/^#[0-9a-f]{6}$/i.test(i.value)){ set(i.value.toLowerCase()); hqStudioApply(); hqStudioSketch(); } });
  row.appendChild(i); parent.appendChild(row);
}
function hqsSection(parent, title){ var s=document.createElement("fieldset"); s.className="hqs-sec"; var lg=document.createElement("legend"); lg.textContent=title; s.appendChild(lg); parent.appendChild(s); return s; }
function hqStudioRender(){
  var S=hqStudioS(), d=HQ_STUDIO.draft, body=$("hqsBody"); if(!S || !d || !body) return;
  HQS_TABS.forEach(function(tb){ var b=$("hqsTab-"+tb[0]); if(b){ var on=tb[0]===HQ_STUDIO.tab; b.setAttribute("aria-selected", on?"true":"false"); b.tabIndex=on?0:-1; } });
  body.setAttribute("aria-labelledby","hqsTab-"+HQ_STUDIO.tab);
  body.textContent="";
  var X=S.SCHEMA.ext, tab=HQ_STUDIO.tab;
  if(tab==="ext"){
    var top=document.createElement("div"); top.className="hqs-top";
    var cv=document.createElement("canvas"); cv.width=220; cv.height=260; cv.className="hqs-sketch"; cv.id="hqsSketch"; cv.setAttribute("role","img"); cv.setAttribute("aria-label","A sketch of your tower's front");
    top.appendChild(cv);
    var pr=hqsSection(top, "Style presets");
    hqsChoices(pr, "Preset", Object.keys(S.PRESETS).map(function(k){ return [k, S.PRESETS[k].label]; }), d.ext.preset, function(v){ HQ_STUDIO.draft=S.preset(v, HQ_STUDIO.draft); });
    body.appendChild(top);
    var fa=hqsSection(body, "Facade");
    ["facade","material","tint","balcony"].forEach(function(k){
      if(k==="balcony") hqsChoices(fa, HQS_NAMES[k], [[true,"Yes"],[false,"No"]], d.ext.balcony, function(v){ d.ext.balcony=v; });
      else hqsChoices(fa, HQS_NAMES[k], k==="facade" ? X.facade.enum.map(function(v){ return [v, S.PRESETS[v].label]; }) : X[k].enum, d.ext[k], function(v){ d.ext[k]=v; });
    });
    hqsColor(fa, HQS_NAMES.body, d.ext.body, function(v){ d.ext.body=v; }); hqsColor(fa, HQS_NAMES.trim, d.ext.trim, function(v){ d.ext.trim=v; });
    var en=hqsSection(body, "Entrance, crown and roof");
    ["entrance","crown"].forEach(function(k){ hqsChoices(en, HQS_NAMES[k], X[k].enum, d.ext[k], function(v){ d.ext[k]=v; }); });
    var rr=document.createElement("div"); rr.className="hqs-row"; var rl=document.createElement("span"); rl.className="hqs-l"; rl.textContent=HQS_NAMES.roof; rr.appendChild(rl);
    var rg=document.createElement("div"); rg.className="hqs-chips"; rg.setAttribute("role","group"); rg.setAttribute("aria-label",HQS_NAMES.roof);
    X.roof.set.forEach(function(v){ var b=document.createElement("button"); b.type="button"; b.className="hqs-chip"; b.textContent=hqsWord(v); var on=d.ext.roof.indexOf(v)>=0; b.setAttribute("aria-pressed", on?"true":"false");
      b.addEventListener("click", function(){ var i=d.ext.roof.indexOf(v); if(i>=0) d.ext.roof.splice(i,1); else d.ext.roof.push(v); hqStudioChanged(); var nb=$("hqsBody").querySelector('[aria-label="'+HQS_NAMES.roof+'"]'); if(nb && nb.children[X.roof.set.indexOf(v)]) nb.children[X.roof.set.indexOf(v)].focus(); }); rg.appendChild(b); });
    rr.appendChild(rg); en.appendChild(rr);
    var sg=hqsSection(body, "Sign, lights and grounds");
    ["font","flags","land"].forEach(function(k){ hqsChoices(sg, HQS_NAMES[k], X[k].enum, d.ext[k], function(v){ d.ext[k]=v; }); });
    ["signColor","night","flagColor"].forEach(function(k){ hqsColor(sg, HQS_NAMES[k], d.ext[k], function(v){ d.ext[k]=v; }); });
    hqStudioSketch();
  } else if(tab==="lobby"){
    var L=S.SCHEMA.int.lobby, lp=hqsSection(body, "Lobby presets");
    hqsChoices(lp, "Preset", Object.keys(S.LOBBY_PRESETS).map(function(k){ return [k, S.LOBBY_PRESETS[k].label]; }), d.int.lobby.preset, function(v){ HQ_STUDIO.draft=S.lobbyPreset(v, HQ_STUDIO.draft); });
    var rm=hqsSection(body, "The room");
    ["wall","floor","mood"].forEach(function(k){ hqsChoices(rm, HQS_NAMES[k], S.SCHEMA.int.theme[k].enum, d.int.themes.lobby[k], function(v){ d.int.themes.lobby[k]=v; }); });
    hqsChoices(rm, HQS_NAMES.ceiling, L.ceiling.enum, d.int.lobby.ceiling, function(v){ d.int.lobby.ceiling=v; });
    var pc=hqsSection(body, "Set pieces");
    ["reception","centre","seating","art","rug","signage","ambience"].forEach(function(k){ hqsChoices(pc, HQS_NAMES[k], L[k].enum, d.int.lobby[k], function(v){ d.int.lobby[k]=v; }); });
    var amb=document.createElement("p"); amb.className="muted hqs-hint"; amb.textContent="Ambience plays only while Ambient sounds is on in Settings."; pc.appendChild(amb);
    var lk=document.createElement("button"); lk.type="button"; lk.className="hbtn ghost"; lk.textContent="Place decor and pet furniture in the lobby…"; lk.addEventListener("click", function(){ HQ_STUDIO.tab="layout"; HQ_STUDIO.cur.f="lobby"; hqStudioRender(); }); body.appendChild(lk);
  } else if(tab==="floors"){
    S.SCHEMA.int.floors.forEach(function(f){
      if(f==="lobby") return;
      var fs=hqsSection(body, f==="mission" ? "Mission Control" : hqsWord(f));
      ["wall","floor","mood","furn"].forEach(function(k){ hqsChoices(fs, HQS_NAMES[k], S.SCHEMA.int.theme[k].enum, d.int.themes[f][k], function(v){ d.int.themes[f][k]=v; }); });
    });
  } else {
    hqStudioLayout(body, S, d);
  }
  var n=$("hqsNote"); if(n) n.textContent=HQ_STUDIO.note;
}
// a front elevation of the tower in the draft's colours (a sketch: the 3D view behind is the real preview)
function hqStudioSketch(){
  var cv=$("hqsSketch"), d=HQ_STUDIO.draft; if(!cv || !d) return;
  var g=cv.getContext("2d"), X=d.ext, W=cv.width, H=cv.height;
  var css=getComputedStyle(document.documentElement), bg=css.getPropertyValue("--panel2").trim()||"transparent";
  g.clearRect(0,0,W,H); g.fillStyle=bg; g.fillRect(0,0,W,H);
  var T=(window.HQV && HQV.hqTower && HQV.hqTower.TINT[X.tint]) || ["#244e74","#8fc3e6"];
  function tier(x, y, w, h){ g.fillStyle=X.body; g.fillRect(x,y,w,h); for(var yy=y+6; yy<y+h-8; yy+=14) for(var xx=x+5; xx<x+w-8; xx+=11){ g.fillStyle=T[0]; g.fillRect(xx,yy,7,9); g.fillStyle=T[1]; g.fillRect(xx,yy,2,9); } }
  tier(40, 190, 140, 50); tier(52, 110, 116, 80); tier(72, 60, 76, 50);
  g.fillStyle=X.trim; g.fillRect(36, 186, 148, 5); g.fillRect(48, 106, 124, 4); g.fillRect(70, 56, 80, 4);
  g.fillStyle=X.signColor; g.fillRect(80, 196, 60, 8);
  if(X.crown==="spire"||X.crown==="antenna"){ g.fillStyle=X.trim; g.fillRect(140, 14, 3, 42); }
  if(X.crown==="dome"){ g.fillStyle=X.trim; g.beginPath(); g.arc(80, 56, 7, Math.PI, 0); g.fill(); g.beginPath(); g.arc(140, 56, 7, Math.PI, 0); g.fill(); }
  if(X.crown==="garden"){ g.fillStyle="#3c8a4f"; g.beginPath(); g.arc(78, 52, 7, 0, 7); g.fill(); g.beginPath(); g.arc(142, 52, 7, 0, 7); g.fill(); }
  g.strokeStyle=X.night; g.lineWidth=2; g.beginPath(); g.moveTo(98, 52); g.lineTo(122, 52); g.stroke();   // the pad, always
  g.fillStyle=X.flagColor; if(X.flags!=="none"){ g.fillRect(28, 196, 2, 44); g.fillRect(30, 198, 12, 8); g.fillRect(190, 196, 2, 44); g.fillRect(192, 198, 12, 8); }
}

/* ---- Layout: the placement grid (a floor's -13..13 m cells; arrows move, Enter places, Delete removes, R turns) ---- */
function hqStudioLayout(body, S, d){
  var I=S.SCHEMA.int.items, f=HQ_STUDIO.cur.f;
  var top=hqsSection(body, "Placement");
  hqsChoices(top, "Floor", S.SCHEMA.int.floors.map(function(x){ return [x, x==="mission" ? "Mission Control" : "Lobby"]; }), f, function(v){ HQ_STUDIO.cur.f=v; hqStudioGrid(true); });
  hqsChoices(top, "Item", I.kinds.map(function(k){ return [k, S.LABELS[k]]; }), HQ_STUDIO.sel, function(v){ HQ_STUDIO.sel=v; });
  hqsChoices(top, "Facing", [[0,"North"],[1,"East"],[2,"South"],[3,"West"]], HQ_STUDIO.rot, function(v){ HQ_STUDIO.rot=v; });
  var wrap=document.createElement("div"); wrap.className="hqs-gridwrap";
  var cv=document.createElement("canvas"); cv.width=27*14; cv.height=27*14; cv.className="hqs-grid"; cv.id="hqsGrid"; cv.tabIndex=0;
  cv.setAttribute("role","application"); cv.setAttribute("aria-roledescription","placement grid");
  cv.setAttribute("aria-label","Placement grid for the "+(f==="mission"?"Mission Control":"lobby")+" floor. Arrow keys move, Enter places the item, Delete removes, R turns it.");
  wrap.appendChild(cv);
  var info=document.createElement("p"); info.className="muted hqs-hint"; info.id="hqsGridInfo"; info.setAttribute("aria-live","polite"); wrap.appendChild(info);
  body.appendChild(wrap);
  function cellAt(e){ var r=cv.getBoundingClientRect(), k=cv.width/r.width; return {x:Math.floor((e.clientX-r.left)*k/14)-13, z:Math.floor((e.clientY-r.top)*k/14)-13}; }
  cv.addEventListener("click", function(e){ var c=cellAt(e); HQ_STUDIO.cur.x=c.x; HQ_STUDIO.cur.z=c.z; hqStudioPlace(); });
  cv.addEventListener("contextmenu", function(e){ e.preventDefault(); var c=cellAt(e); HQ_STUDIO.cur.x=c.x; HQ_STUDIO.cur.z=c.z; hqStudioRemove(); });
  cv.addEventListener("keydown", function(e){
    var C=HQ_STUDIO.cur, mv={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}[e.key];
    if(mv){ e.preventDefault(); C.x=Math.max(-I.grid,Math.min(I.grid,C.x+mv[0])); C.z=Math.max(-I.grid,Math.min(I.grid,C.z+mv[1])); hqStudioDrawGrid(); return; }
    if(e.key==="Enter"||e.key===" "){ e.preventDefault(); hqStudioPlace(); return; }
    if(e.key==="Delete"||e.key==="Backspace"){ e.preventDefault(); hqStudioRemove(); return; }
    if(e.key==="r"||e.key==="R"){ e.preventDefault(); HQ_STUDIO.rot=(HQ_STUDIO.rot+1)%4; hqStudioDrawGrid(); }
  });
  hqStudioDrawGrid();
}
function hqStudioPlace(){
  var S=hqStudioS(), C=HQ_STUDIO.cur, nd=S.place(HQ_STUDIO.draft, {k:HQ_STUDIO.sel, f:C.f, x:C.x, z:C.z, r:HQ_STUDIO.rot});
  if(!nd){ hqStudioNote("That floor is full ("+S.SCHEMA.int.items.maxPerFloor+" items, "+S.SCHEMA.int.items.max+" in all)."); return; }
  HQ_STUDIO.draft=nd; hqStudioNote(S.LABELS[HQ_STUDIO.sel]+" placed at "+C.x+", "+C.z+"."); hqStudioDrawGrid(); hqStudioApply();
}
function hqStudioRemove(){
  var S=hqStudioS(), C=HQ_STUDIO.cur, before=HQ_STUDIO.draft.int.items.length;
  HQ_STUDIO.draft=S.remove(HQ_STUDIO.draft, C.f, C.x, C.z);
  if(HQ_STUDIO.draft.int.items.length<before){ hqStudioNote("Removed."); hqStudioDrawGrid(); hqStudioApply(); }
}
function hqStudioDrawGrid(){
  var cv=$("hqsGrid"), d=HQ_STUDIO.draft, S=hqStudioS(); if(!cv || !d || !S) return;
  var g=cv.getContext("2d"), css=getComputedStyle(document.documentElement), C=HQ_STUDIO.cur;
  var col=function(n, fb){ return css.getPropertyValue(n).trim() || fb; };
  g.fillStyle=col("--panel2","#1b2b39"); g.fillRect(0,0,cv.width,cv.height);
  g.strokeStyle=col("--line","#2c3e50"); g.lineWidth=1;
  for(var i=0;i<=27;i++){ g.beginPath(); g.moveTo(i*14+0.5,0); g.lineTo(i*14+0.5,cv.height); g.stroke(); g.beginPath(); g.moveTo(0,i*14+0.5); g.lineTo(cv.width,i*14+0.5); g.stroke(); }
  var here=d.int.items.filter(function(it){ return it.f===C.f; });
  g.font="10px "+(col("--mono","monospace")); g.textAlign="center"; g.textBaseline="middle";
  here.forEach(function(it){ g.fillStyle=S.PET_SPOT[it.k] ? col("--good","#6fd38a") : col("--brand","#ffb347"); g.fillRect((it.x+13)*14+2,(it.z+13)*14+2,10,10);
    g.fillStyle=col("--panel","#0e1923"); g.fillText(S.LABELS[it.k].charAt(0), (it.x+13)*14+7, (it.z+13)*14+7.5); });
  g.strokeStyle=col("--ink","#e9eff3"); g.lineWidth=2; g.strokeRect((C.x+13)*14+1,(C.z+13)*14+1,12,12);
  var on=here.filter(function(it){ return it.x===C.x && it.z===C.z; })[0], info=$("hqsGridInfo");
  if(info) info.textContent=(on ? S.LABELS[on.k]+" here. " : "Empty. ")+"Cell "+C.x+", "+C.z+" · "+here.length+"/"+S.SCHEMA.int.items.maxPerFloor+" on this floor · Enter places a "+S.LABELS[HQ_STUDIO.sel].toLowerCase()+", Delete removes, R turns ("+["north","east","south","west"][HQ_STUDIO.rot]+").";
  hqStudioGrid(true);
}
// the grid on the floor in 3D while the Layout tab is open (the lobby and Mission Control show it)
function hqStudioGrid(on){
  if(typeof HQ3D==="undefined" || !HQ3D || !HQ3D.inst || !HQ3D.inst.studioGrid) return;
  var b=$("hqStudio"), open=on && b && b.classList.contains("open") && HQ_STUDIO.tab==="layout";
  HQ3D.inst.studioGrid(open ? {f:HQ_STUDIO.cur.f, x:HQ_STUDIO.cur.x, z:HQ_STUDIO.cur.z} : null);
}

(function(){
  var b=$("setStudio"); if(b) b.addEventListener("click", function(){ var c=$("settingsClose"); if(c) c.click(); hqStudioOpen(); });
  var h=$("hqStudioBtn"); if(h) h.addEventListener("click", function(){ hqStudioOpen(); });
})();
