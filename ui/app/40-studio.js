/* ================= HQ Studio (the HQ revamp): customise your tower, your lobby and your floors ================= */
// One style document (games/hqstyle.js, HQV.hqStyle): the exterior (facade system, colours, glass, crown, entrance,
// sign, night light, flags, roof, grounds), each floor's theme, the lobby's set pieces and the decor on each floor's
// grid. Kept here (localStorage hq_style) and, when the paired Arena has the "hqstyle" capability, on the Arena
// (POST /api/arena/hq/style -> PUT /v1/hq/me/style): everyone then sees it on your tower in the City and inside when
// they visit. An older Arena: it stays on this machine, and everyone else sees the default.
// The panel: Settings / Cmd-K "HQ Studio", or the Studio kiosk in your lobby, docked right. Every change previews live:
// your tower in 3D in the panel (Exterior), the lobby or Mission Control behind it, framed left of the panel (Lobby, Floors),
// placing decor right on the floor (Layout). Save keeps it, Close without saving puts the saved look (and your view) back.
var HQ_STUDIO = {doc:null, draft:null, remote:null, note:"", tab:"ext", sel:"plant", rot:0, cur:{f:"lobby", x:0, z:0}, synced:false, back:null,
  pv:null, pvEl:null, pvNight:false, pvShut:false, pvRaf:0, thumbs:null, applyT:0};
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
  return hqGarageCity((list||[]).map(function(h){
    if(h && h.isYou && d) return Object.assign({}, h, {style:d});
    if(h && h.stylePreset && !h.style && S) return Object.assign({}, h, {style:S.preset(h.stylePreset)});   // ?hqsmoke=1&hqstyles=1 (tools)
    return h;
  }));                                                                 // [3.33] and your garage where you moved it
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
  hqStudioScene();
}
function hqStudioClose(save){
  var bk=$("hqStudio"); if(!bk) return;
  if(save) hqStudioSave();
  HQ_STUDIO.draft=null; bk.classList.remove("open"); hqStudioGrid(false); hqsPreviewStop();
  if(HQ_STUDIO.applyT){ clearTimeout(HQ_STUDIO.applyT); HQ_STUDIO.applyT=0; }
  var I=hqs3d(); if(I && I.studioView) I.studioView(null);       // your own view (and floor) back
  hqStudioApply();                                                  // the saved look (the draft is gone)
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
    b.addEventListener("click", function(){ HQ_STUDIO.tab=tb[0]; hqStudioRender(); hqStudioScene(); b.focus(); });
    b.addEventListener("keydown", function(e){
      if(e.key!=="ArrowRight" && e.key!=="ArrowLeft") return; e.preventDefault();
      var i=HQS_TABS.findIndex(function(x){ return x[0]===HQ_STUDIO.tab; }), n=(i+(e.key==="ArrowRight"?1:HQS_TABS.length-1))%HQS_TABS.length;
      HQ_STUDIO.tab=HQS_TABS[n][0]; hqStudioRender(); hqStudioScene(); var nb=$("hqsTab-"+HQ_STUDIO.tab); if(nb) nb.focus();
    });
    tabs.appendChild(b);
  });
  var x=document.createElement("button"); x.type="button"; x.className="hbtn icon ghost"; x.setAttribute("aria-label","Close HQ Studio without saving"); x.textContent="✕";
  x.addEventListener("click", function(){ hqStudioClose(false); }); h.appendChild(x);
  m.appendChild(h); m.appendChild(tabs);                            // one compact row of tabs under the title
  var body=document.createElement("div"); body.className="modal-b hqs-body"; body.id="hqsBody"; body.setAttribute("role","tabpanel"); m.appendChild(body);
  var foot=document.createElement("div"); foot.className="hqs-foot";
  [["Randomise", function(){ var S=hqStudioS(); HQ_STUDIO.draft=S.randomise(Date.now() + ":" + Math.floor(performance.now()), HQ_STUDIO.draft); hqStudioChanged("preset"); }],
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
// a change: the panel redraws, the 3D scene behind it wears the draft now, the tower preview rebuilds (k: what changed)
function hqStudioChanged(k){ hqStudioRender(); hqStudioApply(); hqsPreviewSet(k); }
// a row of choices (role radiogroup; arrows move, the pressed one is the value)
function hqsChoices(parent, label, opts, cur, set, key){
  var row=document.createElement("div"); row.className="hqs-row";
  var l=document.createElement("span"); l.className="hqs-l"; l.textContent=label; row.appendChild(l);
  var g=document.createElement("div"); g.className="hqs-chips"; g.setAttribute("role","radiogroup"); g.setAttribute("aria-label",label);
  opts.forEach(function(o, i){
    var v=Array.isArray(o)?o[0]:o, txt=Array.isArray(o)?o[1]:hqsWord(o);
    var b=document.createElement("button"); b.type="button"; b.className="hqs-chip"; b.setAttribute("role","radio");
    var ic=Array.isArray(o) && o.length>2 ? o[2] : null;
    if(ic!==null && ic!==undefined){ b.classList.add("hqs-tile"); var im=document.createElement(ic ? "img" : "span"); im.className="hqs-ic"; if(ic){ im.src=ic; im.alt=""; } im.setAttribute("aria-hidden","true"); b.appendChild(im);
      var tx=document.createElement("span"); tx.textContent=txt; b.appendChild(tx); g.classList.add("hqs-tiles"); row.classList.add("hqs-row-tiles"); } else b.textContent=txt;
    var on=v===cur; b.setAttribute("aria-checked", on?"true":"false"); b.tabIndex=on || (cur==null && i===0) ? 0 : -1;
    b.addEventListener("click", function(){ set(v); hqStudioChanged(key); var nb=$("hqsBody").querySelector('[aria-label="'+label+'"] [aria-checked=true]'); if(nb) nb.focus(); });
    b.addEventListener("keydown", function(e){
      var k=e.key==="ArrowRight"||e.key==="ArrowDown" ? 1 : e.key==="ArrowLeft"||e.key==="ArrowUp" ? -1 : 0; if(!k) return; e.preventDefault();
      var j=(i+k+opts.length)%opts.length, nv=Array.isArray(opts[j])?opts[j][0]:opts[j]; set(nv); hqStudioChanged(key);
      var nb=$("hqsBody").querySelector('[aria-label="'+label+'"] [aria-checked=true]'); if(nb) nb.focus();
    });
    g.appendChild(b);
  });
  row.appendChild(g); parent.appendChild(row);
}
function hqsColor(parent, label, cur, set, key){
  var row=document.createElement("label"); row.className="hqs-row";
  var l=document.createElement("span"); l.className="hqs-l"; l.textContent=label; row.appendChild(l);
  var i=document.createElement("input"); i.type="color"; i.value=cur; i.className="hqs-color"; i.setAttribute("aria-label",label);
  // a colour drags through many values: the 3D scene catches up after a short pause, the preview rebuilds debounced
  i.addEventListener("input", function(){ if(/^#[0-9a-f]{6}$/i.test(i.value)){ set(i.value.toLowerCase()); hqsApplySoon(); hqsPreviewSet(key); } });
  row.appendChild(i); parent.appendChild(row);
}
function hqsSection(parent, title){ var s=document.createElement("fieldset"); s.className="hqs-sec"; var lg=document.createElement("legend"); lg.textContent=title; s.appendChild(lg); parent.appendChild(s); return s; }
function hqStudioRender(){
  var S=hqStudioS(), d=HQ_STUDIO.draft, body=$("hqsBody"); if(!S || !d || !body) return;
  HQS_TABS.forEach(function(tb){ var b=$("hqsTab-"+tb[0]); if(b){ var on=tb[0]===HQ_STUDIO.tab; b.setAttribute("aria-selected", on?"true":"false"); b.tabIndex=on?0:-1; } });
  body.setAttribute("aria-labelledby","hqsTab-"+HQ_STUDIO.tab);
  var keep=body.scrollTop;                                           // a click redraws the panel: it stays where you scrolled
  body.textContent="";
  var X=S.SCHEMA.ext, tab=HQ_STUDIO.tab;
  if(tab==="ext"){
    body.appendChild(hqsPreviewEl());                                // sticky: your tower stays in view down every section
    var pr=hqsSection(body, "Style presets");
    hqsChoices(pr, "Preset", Object.keys(S.PRESETS).map(function(k){ return [k, S.PRESETS[k].label]; }), d.ext.preset, function(v){ HQ_STUDIO.draft=S.preset(v, HQ_STUDIO.draft); }, "preset");
    var fa=hqsSection(body, "Facade");
    ["facade","material","tint","balcony"].forEach(function(k){
      if(k==="balcony") hqsChoices(fa, HQS_NAMES[k], [[true,"Yes"],[false,"No"]], d.ext.balcony, function(v){ d.ext.balcony=v; }, k);
      else hqsChoices(fa, HQS_NAMES[k], k==="facade" ? X.facade.enum.map(function(v){ return [v, S.PRESETS[v].label]; }) : X[k].enum, d.ext[k], function(v){ d.ext[k]=v; }, k);
    });
    hqsColor(fa, HQS_NAMES.body, d.ext.body, function(v){ d.ext.body=v; }, "body"); hqsColor(fa, HQS_NAMES.trim, d.ext.trim, function(v){ d.ext.trim=v; }, "trim");
    var en=hqsSection(body, "Entrance, crown and roof");
    ["entrance","crown"].forEach(function(k){ hqsChoices(en, HQS_NAMES[k], X[k].enum, d.ext[k], function(v){ d.ext[k]=v; }, k); });
    var rr=document.createElement("div"); rr.className="hqs-row"; var rl=document.createElement("span"); rl.className="hqs-l"; rl.textContent=HQS_NAMES.roof; rr.appendChild(rl);
    var rg=document.createElement("div"); rg.className="hqs-chips"; rg.setAttribute("role","group"); rg.setAttribute("aria-label",HQS_NAMES.roof);
    X.roof.set.forEach(function(v){ var b=document.createElement("button"); b.type="button"; b.className="hqs-chip"; b.textContent=hqsWord(v); var on=d.ext.roof.indexOf(v)>=0; b.setAttribute("aria-pressed", on?"true":"false");
      b.addEventListener("click", function(){ var i=d.ext.roof.indexOf(v); if(i>=0) d.ext.roof.splice(i,1); else d.ext.roof.push(v); hqStudioChanged("roof"); var nb=$("hqsBody").querySelector('[aria-label="'+HQS_NAMES.roof+'"]'); if(nb && nb.children[X.roof.set.indexOf(v)]) nb.children[X.roof.set.indexOf(v)].focus(); }); rg.appendChild(b); });
    rr.appendChild(rg); en.appendChild(rr);
    var sg=hqsSection(body, "Sign, lights and grounds");
    ["font","flags","land"].forEach(function(k){ hqsChoices(sg, HQS_NAMES[k], X[k].enum, d.ext[k], function(v){ d.ext[k]=v; }, k); });
    ["signColor","night","flagColor"].forEach(function(k){ hqsColor(sg, HQS_NAMES[k], d.ext[k], function(v){ d.ext[k]=v; }, k); });
    var gm=document.createElement("button"); gm.type="button"; gm.className="hbtn ghost"; gm.id="hqsGarageBtn"; gm.textContent="Move your garage…";   // [3.33]
    gm.addEventListener("click", function(){ hqGarageOpen(); }); sg.appendChild(gm);
  } else if(tab==="lobby"){
    var L=S.SCHEMA.int.lobby;
    body.appendChild(hqsLiveHint("The Lobby behind this panel shows every change as you click."));
    var lp=hqsSection(body, "Lobby presets");
    hqsChoices(lp, "Preset", Object.keys(S.LOBBY_PRESETS).map(function(k){ return [k, S.LOBBY_PRESETS[k].label]; }), d.int.lobby.preset, function(v){ HQ_STUDIO.draft=S.lobbyPreset(v, HQ_STUDIO.draft); });
    var rm=hqsSection(body, "The room");
    ["wall","floor","mood"].forEach(function(k){ hqsChoices(rm, HQS_NAMES[k], S.SCHEMA.int.theme[k].enum, d.int.themes.lobby[k], function(v){ d.int.themes.lobby[k]=v; }); });
    hqsChoices(rm, HQS_NAMES.ceiling, L.ceiling.enum, d.int.lobby.ceiling, function(v){ d.int.lobby.ceiling=v; });
    var pc=hqsSection(body, "Set pieces");
    ["reception","centre","seating","art","rug","signage","ambience"].forEach(function(k){ hqsChoices(pc, HQS_NAMES[k], L[k].enum, d.int.lobby[k], function(v){ d.int.lobby[k]=v; }); });
    var amb=document.createElement("p"); amb.className="muted hqs-hint"; amb.textContent="Ambience plays at the Ambient sounds volume in Settings (0% turns it off)."; pc.appendChild(amb);
    var lk=document.createElement("button"); lk.type="button"; lk.className="hbtn ghost"; lk.textContent="Place decor and pet furniture in the lobby…"; lk.addEventListener("click", function(){ HQ_STUDIO.tab="layout"; HQ_STUDIO.cur.f="lobby"; hqStudioRender(); hqStudioScene(); }); body.appendChild(lk);
  } else if(tab==="floors"){
    body.appendChild(hqsLiveHint("Mission Control behind this panel shows every change as you click."));
    S.SCHEMA.int.floors.forEach(function(f){
      if(f==="lobby") return;
      var fs=hqsSection(body, f==="mission" ? "Mission Control" : hqsWord(f));
      ["wall","floor","mood","furn"].forEach(function(k){ hqsChoices(fs, HQS_NAMES[k], S.SCHEMA.int.theme[k].enum, d.int.themes[f][k], function(v){ d.int.themes[f][k]=v; }); });
    });
  } else {
    hqStudioLayout(body, S, d);
  }
  body.scrollTop=keep;
  var n=$("hqsNote"); if(n) n.textContent=HQ_STUDIO.note;
}
function hqsLiveHint(t){ var p=document.createElement("p"); p.className="muted hqs-hint hqs-live"; p.textContent=t; return p; }
function hqs3d(){ return (typeof HQ3D!=="undefined" && HQ3D && HQ3D.inst && !HQ3D.visit) ? HQ3D.inst : null; }
// how much of the 3D view the docked panel covers (0..1, from the right): the main camera frames what you edit left of it
function hqsShift(){
  var m=document.querySelector("#hqStudio .hqs"), cv=document.querySelector("canvas.hq3d-canvas"); if(!m || !cv) return 0;
  var a=m.getBoundingClientRect(), b=cv.getBoundingClientRect(); if(!b.width || a.left>=b.right) return 0;
  return Math.max(0, Math.min(0.6, (b.right-Math.max(a.left,b.left))/b.width));
}
// the main 3D view for this tab: the Lobby tab frames the lobby, Floors Mission Control, Layout the floor you place on
// from above (a ghost follows the pointer); Exterior keeps whichever floor is framed (the tower is in the panel)
function hqStudioScene(){
  var I=hqs3d(), b=$("hqStudio"); if(!b || !b.classList.contains("open")) return;
  var tab=HQ_STUDIO.tab;
  if(tab==="ext") hqsPreviewStart(); else hqsPreviewStop();
  hqStudioGrid(true);
  if(!I || !I.studioView) return;
  var sh=hqsShift();
  if(tab==="lobby") I.studioView({f:"lobby", shift:sh});
  else if(tab==="floors") I.studioView({f:"mission", shift:sh});
  else if(tab==="layout") I.studioView({f:HQ_STUDIO.cur.f, place:true, shift:sh, cb:HQS_PLACE});
  else { var st=I.studioState && I.studioState(); if(st) I.studioView({f:st.f, shift:sh}); }
}
// the 3D view's pointer and keys on the Layout tab (games/hq3d.js inst.studioView)
var HQS_PLACE={
  hover:function(x, z){ var C=HQ_STUDIO.cur; if(C.x===x && C.z===z) return; C.x=x; C.z=z; hqStudioCursor(); },
  place:function(x, z){ HQ_STUDIO.cur.x=x; HQ_STUDIO.cur.z=z; hqStudioPlace(); },
  remove:function(x, z){ HQ_STUDIO.cur.x=x; HQ_STUDIO.cur.z=z; hqStudioRemove(); },
  key:function(k){ if(k==="rotate"){ HQ_STUDIO.rot=(HQ_STUDIO.rot+1)%4; hqStudioRender(); hqStudioCursor(); } else hqStudioRemove(); }
};
function hqsApplySoon(){ if(HQ_STUDIO.applyT) clearTimeout(HQ_STUDIO.applyT); HQ_STUDIO.applyT=setTimeout(function(){ HQ_STUDIO.applyT=0; hqStudioApply(); }, 100); }

/* ---- Exterior: your tower, live, in 3D (games/hqtower.js preview: the City's own tower code, in the panel) ---- */
// what an option shows best: the roof (crown, roof extras), the street (entrance, sign, flags, grounds) or the whole tower
var HQS_PART={crown:"roof", roof:"roof", entrance:"street", font:"street", signColor:"street", flags:"street", flagColor:"street", land:"street",
  facade:"full", material:"full", tint:"full", balcony:"full", body:"full", trim:"full", preset:"full", night:"full"};
function hqsPreviewEl(){
  if(HQ_STUDIO.pvEl) return HQ_STUDIO.pvEl;
  var w=document.createElement("div"); w.className="hqs-pv"; w.id="hqsPv";
  var bar=document.createElement("div"); bar.className="hqs-pvbar";
  var t=document.createElement("span"); t.className="hqs-pvt"; t.textContent="Live preview"; bar.appendChild(t);
  var dn=document.createElement("button"); dn.type="button"; dn.className="hqs-chip"; dn.id="hqsPvNight"; dn.setAttribute("aria-pressed","false"); dn.textContent="Night";
  dn.addEventListener("click", function(){ hqsPreviewNight(!HQ_STUDIO.pvNight); }); bar.appendChild(dn);
  var cl=document.createElement("button"); cl.type="button"; cl.className="hqs-chip"; cl.id="hqsPvShut"; cl.setAttribute("aria-expanded","true"); cl.setAttribute("aria-controls","hqsPvBox"); cl.textContent="Hide";
  cl.addEventListener("click", function(){ HQ_STUDIO.pvShut=!HQ_STUDIO.pvShut; hqsPreviewShut(); }); bar.appendChild(cl);
  w.appendChild(bar);
  var box=document.createElement("div"); box.className="hqs-pvbox"; box.id="hqsPvBox";
  // the pointer and keys on the box (the canvas inside is replaced after its context is given up)
  var drag=null;
  box.addEventListener("pointerdown", function(e){ drag={x:e.clientX, y:e.clientY}; try { box.setPointerCapture(e.pointerId); } catch(x){} });
  box.addEventListener("pointermove", function(e){ if(!drag || !HQ_STUDIO.pv) return; HQ_STUDIO.pv.drag(e.clientX-drag.x, e.clientY-drag.y); drag.x=e.clientX; drag.y=e.clientY; });
  box.addEventListener("pointerup", function(){ drag=null; }); box.addEventListener("pointercancel", function(){ drag=null; });
  box.addEventListener("wheel", function(e){ if(!HQ_STUDIO.pv) return; e.preventDefault(); HQ_STUDIO.pv.zoom(e.deltaY); }, {passive:false});
  box.addEventListener("keydown", function(e){
    var P=HQ_STUDIO.pv; if(!P) return;
    var m={ArrowLeft:[-30,0], ArrowRight:[30,0], ArrowUp:[0,-20], ArrowDown:[0,20]}[e.key];
    if(m){ e.preventDefault(); P.drag(m[0], m[1]); } else if(e.key==="+"||e.key==="="){ e.preventDefault(); P.zoom(-200); } else if(e.key==="-"){ e.preventDefault(); P.zoom(200); }
  });
  var cv=hqsPvCanvas();
  box.appendChild(cv); w.appendChild(box);
  HQ_STUDIO.pvEl=w; hqsPreviewShut(); return w;
}
function hqsPvCanvas(){
  var cv=document.createElement("canvas"); cv.className="hqs-pvcv"; cv.id="hqsPvCanvas"; cv.tabIndex=0; cv.width=360; cv.height=250;
  cv.setAttribute("role","img"); cv.setAttribute("aria-label","Your tower in 3D, as the City shows it. Drag or arrow keys to turn it, the wheel or + and - to zoom.");
  return cv;
}
function hqsPreviewShut(){
  var w=HQ_STUDIO.pvEl; if(!w) return; var sh=HQ_STUDIO.pvShut, b=$("hqsPvShut");
  w.classList.toggle("shut", sh); if(b){ b.textContent=sh ? "Show" : "Hide"; b.setAttribute("aria-expanded", sh ? "false" : "true"); }
  if(sh) hqsPreviewStop(); else if(HQ_STUDIO.tab==="ext") hqsPreviewStart();
}
function hqsPreviewNight(on){
  HQ_STUDIO.pvNight=!!on; var b=$("hqsPvNight"); if(b) b.setAttribute("aria-pressed", on ? "true" : "false");
  if(HQ_STUDIO.pv) HQ_STUDIO.pv.night(!!on); else hqStudioSketch();
}
function hqsPreviewStart(){
  var cv=$("hqsPvCanvas"), I=hqs3d(); if(!cv || HQ_STUDIO.pvShut) return;
  if(!HQ_STUDIO.pv && cv.dataset.used){ var nc=hqsPvCanvas(); cv.parentNode.replaceChild(nc, cv); cv=nc; }   // a given-up context is not reused
  if(!HQ_STUDIO.pv && I && I.studioPreview && !cv.dataset.flat){
    cv.dataset.used="1";
    try { HQ_STUDIO.pv=I.studioPreview(cv); } catch(e){ HQ_STUDIO.pv=null; if(window.console) console.warn("HQ Studio preview:", e); }
    if(HQ_STUDIO.pv) HQ_STUDIO.pv.night(HQ_STUDIO.pvNight);
  }
  if(!HQ_STUDIO.pv){ cv.dataset.flat="1"; hqStudioSketch(); return; }   // no 3D HQ here (the classic page): a flat sketch
  HQ_STUDIO.pv.resize();
  if(HQ_STUDIO.pvRaf) return;
  var lastT=0;
  (function loop(ts){
    HQ_STUDIO.pvRaf=requestAnimationFrame(loop);
    if(document.hidden || ts-lastT<32 || !HQ_STUDIO.pv) return;      // ~30 fps is plenty for a slow turn
    lastT=ts; HQ_STUDIO.pv.tick(ts/1000);
  })(0);
}
// off the Exterior tab, collapsed or closed: the loop stops and the preview's renderer, geometry and textures go
function hqsPreviewStop(){
  if(HQ_STUDIO.pvRaf){ cancelAnimationFrame(HQ_STUDIO.pvRaf); HQ_STUDIO.pvRaf=0; }
  if(HQ_STUDIO.pv){ try { HQ_STUDIO.pv.dispose(); } catch(e){} HQ_STUDIO.pv=null; }
}
// an option changed: the tower rebuilds (debounced in the preview) and the camera glides to what it changed
function hqsPreviewSet(k){
  if(HQ_STUDIO.tab!=="ext") return;
  var P=HQ_STUDIO.pv; if(!P){ hqStudioSketch(); return; }
  P.set();
  if(k==="night" && !HQ_STUDIO.pvNight) hqsPreviewNight(true);
  if(k) P.focus(HQS_PART[k] || "full");
}
// no 3D HQ (the classic page): a front elevation of the tower in the draft's colours
function hqStudioSketch(){
  var cv=$("hqsPvCanvas"), d=HQ_STUDIO.draft; if(!cv || !d || !cv.dataset.flat) return;
  var g=cv.getContext("2d"); if(!g) return;
  var X=d.ext, W=cv.width, H=cv.height, ox=(W-220)/2, oy=(H-260)/2;
  var css=getComputedStyle(document.documentElement), bg=css.getPropertyValue("--panel2").trim()||"transparent";
  g.setTransform(1,0,0,1,0,0); g.clearRect(0,0,W,H); g.fillStyle=bg; g.fillRect(0,0,W,H); g.setTransform(1,0,0,1,ox,oy);
  var T=(window.HQV && HQV.hqTower && HQV.hqTower.TINT[X.tint]) || ["#244e74","#8fc3e6"];
  function tier(x, y, w, h){ g.fillStyle=X.body; g.fillRect(x,y,w,h); for(var yy=y+6; yy<y+h-8; yy+=14) for(var xx=x+5; xx<x+w-8; xx+=11){ g.fillStyle=HQ_STUDIO.pvNight?X.night:T[0]; g.fillRect(xx,yy,7,9); g.fillStyle=T[1]; g.fillRect(xx,yy,2,9); } }
  tier(40, 190, 140, 50); tier(52, 110, 116, 80); tier(72, 60, 76, 50);
  g.fillStyle=X.trim; g.fillRect(36, 186, 148, 5); g.fillRect(48, 106, 124, 4); g.fillRect(70, 56, 80, 4);
  g.fillStyle=X.signColor; g.fillRect(80, 196, 60, 8);
  if(X.crown==="spire"||X.crown==="antenna"){ g.fillStyle=X.trim; g.fillRect(140, 14, 3, 42); }
  g.fillStyle=X.flagColor; if(X.flags!=="none"){ g.fillRect(28, 196, 2, 44); g.fillRect(30, 198, 12, 8); g.fillRect(190, 196, 2, 44); g.fillRect(192, 198, 12, 8); }
  g.setTransform(1,0,0,1,0,0);
}

/* ---- Layout: in the 3D view. The Layout tab frames the floor from above; a ghost of the item follows the pointer on the
   floor's grid (green: it fits, red: it does not, HQV.hqDecor.fit); click places, right click or Delete removes, R turns,
   a drag pans, the wheel zooms. The keyboard path: the cursor pad here (arrows move the ghost, Enter places). ---- */
function hqStudioLayout(body, S, d){
  var I=S.SCHEMA.int.items, f=HQ_STUDIO.cur.f, live=!!(hqs3d() && hqs3d().studioView);
  var top=hqsSection(body, "Placement");
  hqsChoices(top, "Floor", S.SCHEMA.int.floors.map(function(x){ return [x, x==="mission" ? "Mission Control" : "Lobby"]; }), f, function(v){ HQ_STUDIO.cur.f=v; setTimeout(hqStudioScene, 0); });
  hqsChoices(top, "Facing", [[0,"North"],[1,"East"],[2,"South"],[3,"West"]], HQ_STUDIO.rot, function(v){ HQ_STUDIO.rot=v; setTimeout(hqStudioCursor, 0); });
  var pad=document.createElement("div"); pad.className="hqs-pad"; pad.id="hqsGrid"; pad.tabIndex=0;
  pad.setAttribute("role","application"); pad.setAttribute("aria-roledescription","placement cursor");
  pad.setAttribute("aria-label","Placement cursor on the "+(f==="mission"?"Mission Control":"lobby")+" floor. Arrow keys move the ghost, Enter places the item, Delete removes, R turns it.");
  var info=document.createElement("p"); info.className="hqs-padinfo"; info.id="hqsGridInfo"; info.setAttribute("aria-live","polite"); pad.appendChild(info);
  top.appendChild(pad);
  var how=document.createElement("p"); how.className="muted hqs-hint";
  how.textContent=live ? "Point at the floor in the 3D view: click places, right-click removes, R turns, drag pans, scroll zooms." : "Open the 3D HQ to place by pointing; here the arrow keys move the cursor.";
  top.appendChild(how);
  var th=HQ_STUDIO.thumbs;
  if(!th && hqs3d() && hqs3d().studioThumbs && !HQ_STUDIO.thumbsTried){
    HQ_STUDIO.thumbsTried=true;                                      // once, after this paint: 23 small renders, cached
    setTimeout(function(){ try { HQ_STUDIO.thumbs=hqs3d() && hqs3d().studioThumbs(); } catch(e){ HQ_STUDIO.thumbs=null; } if(HQ_STUDIO.thumbs && HQ_STUDIO.tab==="layout") hqStudioRender(); }, 30);
  }
  var it=hqsSection(body, "Item");
  hqsChoices(it, "Item", I.kinds.map(function(k){ return [k, S.LABELS[k], th ? (th[k] || "") : ""]; }), HQ_STUDIO.sel, function(v){ HQ_STUDIO.sel=v; setTimeout(hqStudioCursor, 0); });
  pad.addEventListener("keydown", function(e){
    var C=HQ_STUDIO.cur, mv={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}[e.key];
    if(mv){ e.preventDefault(); C.x=Math.max(-I.grid,Math.min(I.grid,C.x+mv[0])); C.z=Math.max(-I.grid,Math.min(I.grid,C.z+mv[1])); hqStudioCursor(); return; }
    if(e.key==="Enter"||e.key===" "){ e.preventDefault(); hqStudioPlace(); return; }
    if(e.key==="Delete"||e.key==="Backspace"){ e.preventDefault(); hqStudioRemove(); return; }
    if(e.key==="r"||e.key==="R"){ e.preventDefault(); HQ_STUDIO.rot=(HQ_STUDIO.rot+1)%4; hqStudioRender(); var p=$("hqsGrid"); if(p) p.focus(); hqStudioCursor(); }
  });
  hqStudioCursor();
}
// would the selected item go on the cursor's cell? (HQV.hqDecor.fit: the floor's grid, other pieces, the caps)
function hqStudioFit(){
  var S=hqStudioS(), C=HQ_STUDIO.cur, D=window.HQV && HQV.hqDecor, it={k:HQ_STUDIO.sel, f:C.f, x:C.x, z:C.z, r:HQ_STUDIO.rot};
  return D && D.fit ? D.fit(HQ_STUDIO.draft.int.items, it, S.SCHEMA.int.items) : {ok:true, why:""};
}
function hqStudioPlace(){
  var S=hqStudioS(), C=HQ_STUDIO.cur, fit=hqStudioFit();
  if(!fit.ok){ hqStudioNote("Can't place it there: "+fit.why); return; }
  var nd=S.place(HQ_STUDIO.draft, {k:HQ_STUDIO.sel, f:C.f, x:C.x, z:C.z, r:HQ_STUDIO.rot});
  if(!nd){ hqStudioNote("That floor is full ("+S.SCHEMA.int.items.maxPerFloor+" items, "+S.SCHEMA.int.items.max+" in all)."); return; }
  HQ_STUDIO.draft=nd; hqStudioNote(S.LABELS[HQ_STUDIO.sel]+" placed at "+C.x+", "+C.z+"."); hqStudioCursor(); hqStudioApply();
}
function hqStudioRemove(){
  var S=hqStudioS(), C=HQ_STUDIO.cur, before=HQ_STUDIO.draft.int.items.length;
  HQ_STUDIO.draft=S.remove(HQ_STUDIO.draft, C.f, C.x, C.z);
  if(HQ_STUDIO.draft.int.items.length<before){ hqStudioNote("Removed."); hqStudioCursor(); hqStudioApply(); }
}
// the cursor moved (pointer or keys): the ghost in 3D, the pad's words
function hqStudioCursor(){
  var d=HQ_STUDIO.draft, S=hqStudioS(); if(!d || !S) return;
  var C=HQ_STUDIO.cur, here=d.int.items.filter(function(it){ return it.f===C.f; }), fit=hqStudioFit();
  var on=here.filter(function(it){ return it.x===C.x && it.z===C.z; })[0], info=$("hqsGridInfo");
  if(info) info.textContent=(on ? S.LABELS[on.k]+" here. " : "")+"Cell "+C.x+", "+C.z+" · "+here.length+"/"+S.SCHEMA.int.items.maxPerFloor+" on this floor · "+
    (fit.ok ? S.LABELS[HQ_STUDIO.sel]+" fits, facing "+["north","east","south","west"][HQ_STUDIO.rot]+(fit.why ? " ("+fit.why.toLowerCase().replace(/\.$/,"")+")" : "")+"." : fit.why);
  var p=$("hqsGrid"); if(p) p.classList.toggle("bad", !fit.ok);
  hqStudioGrid(true, fit.ok);
}
// the grid, the ghost and its colour on the floor in 3D while the Layout tab is open (the lobby and Mission Control show it)
function hqStudioGrid(on, ok){
  var I=hqs3d(); if(!I || !I.studioGrid) return;
  var b=$("hqStudio"), open=on && b && b.classList.contains("open") && HQ_STUDIO.tab==="layout";
  if(open && ok===undefined) ok=hqStudioFit().ok;
  I.studioGrid(open ? {f:HQ_STUDIO.cur.f, x:HQ_STUDIO.cur.x, z:HQ_STUDIO.cur.z, k:HQ_STUDIO.sel, r:HQ_STUDIO.rot, ok:ok!==false} : null);
}

/* ================= [3.33] Move garage: your car-lift bay anywhere on your own lot, turned in quarter turns =================
   Over the 3D City (games/hq3d.js garageView): your lot from above, a ghost bay with its apron and driveway on the lot's 0.5 m
   grid, green where it fits (HQV.hqCity3d.garageFits: inside the lot, clear of the building and the walk to its door, its apron
   and a way to the street clear), red with the reason where not. Click places it (the draft: your HQ shows it at once), R or a
   right click turns it, Enter or Save keeps it, Esc or Cancel puts it back, Reset to default clears it. The keyboard path: the
   placement cursor pad in the panel (the arrows move the ghost 0.5 m). Opened from the MOVE plate by your car lift, or from
   HQ Studio's Exterior tab. Saved on the Arena (POST /api/arena/hq/garage {lot, x, z, r}, x and z in decimetres in the lot's
   frame, lot its rank) where it has the "garage" capability, so everyone sees it; else (an older Arena, or none) in
   localStorage hq_garage, shown on your own HQ only. Nothing in it comes from a transcript: four small numbers you placed. */
var HQ_GARAGE={saved:undefined, draft:null, cur:{x:0, z:0, r:0}, start:null, lot:null, remote:null, note:"", why:null, synced:false, back:null};
var HQG_FACING=[[0,"Street"],[1,"Right"],[2,"Back"],[3,"Left"]];
var HQG_WHY={"outside the lot":"it would stand outside your lot", "on the building":"it would stand on your building or the walk to its door",
  "apron blocked":"the 8 m in front of its door is blocked", "no way to the street":"there's no way from its door out to the street"};
// a stored spot {lot, x, z, r} (lot: the HQ lot's rank; x, z: whole decimetres in the lot's frame; r: 0..3), else null
function hqGarageClean(g){
  if(!g || typeof g!=="object") return null;
  function int(v, lo, hi){ return typeof v==="number" && isFinite(v) && v===Math.round(v) && v>=lo && v<=hi; }
  if(!int(g.lot,0,100000) || !int(g.x,-400,400) || !int(g.z,-300,300) || !int(g.r,0,3)) return null;
  return {lot:g.lot, x:g.x, z:g.z, r:g.r};
}
function hqGarageLocal(){ try { return hqGarageClean(JSON.parse(localStorage.getItem("hq_garage")||"null")); } catch(e){ return null; } }
function hqGarageKeep(g){ try { if(g) localStorage.setItem("hq_garage", JSON.stringify(g)); else localStorage.removeItem("hq_garage"); } catch(e){} }
function hqGarageCan(){ return !!(window.ARENA && ARENA.paired) && typeof hqNetCan==="function" && hqNetCan("garage"); }
// pure helpers: the 0.5 m grid, a quarter turn, a key on the cursor, the spot in decimetres (and back)
function hqGarageSnap(v){ v=Math.round(Math.max(-40, Math.min(40, +v||0))*2)/2; return v===0 ? 0 : v; }
function hqGarageTurn(r, d){ return ((((r|0)+(d==null ? 1 : d|0))%4)+4)%4; }
function hqGarageStep(c, k){
  c=c||{}; var n={x:hqGarageSnap(c.x), z:hqGarageSnap(c.z), r:hqGarageTurn(c.r, 0)};
  if(k==="left") n.x=hqGarageSnap(n.x-0.5); else if(k==="right") n.x=hqGarageSnap(n.x+0.5);
  else if(k==="up") n.z=hqGarageSnap(n.z-0.5); else if(k==="down") n.z=hqGarageSnap(n.z+0.5);   // up: away from the street
  else if(k==="rotate") n.r=hqGarageTurn(n.r, 1);
  return n;
}
function hqGarageKeyOf(e){
  var k=e && e.key;
  return {ArrowLeft:"left", ArrowRight:"right", ArrowUp:"up", ArrowDown:"down", r:"rotate", R:"rotate", Enter:"save", " ":"place", Escape:"cancel"}[k] || null;
}
function hqGarageDm(sp, lot){ return {lot:lot|0, x:Math.round(hqGarageSnap(sp.x)*10), z:Math.round(hqGarageSnap(sp.z)*10), r:hqGarageTurn(sp.r, 0)}; }
function hqGarageM(g){ return {x:hqGarageSnap(g.x/10), z:hqGarageSnap(g.z/10), r:hqGarageTurn(g.r, 0)}; }
// the City's list with your own entry's garage: the draft while you place it, else what you saved or reset here, else (no
// Arena that keeps it) this machine's copy; anyone else's is the Arena's (h.garage), as it sent it
function hqGarageCity(list){
  var g;
  if(HQ_GARAGE.draft) g=HQ_GARAGE.draft;
  else if(HQ_GARAGE.saved!==undefined) g=HQ_GARAGE.saved;                        // null: reset here (the default)
  else if(!hqGarageCan() || HQ_GARAGE.remote===false){ g=hqGarageLocal(); if(!g) return list; }
  else return list;
  return (list||[]).map(function(h){ return h && h.isYou ? Object.assign({}, h, {garage:g}) : h; });
}
// the Arena's copy, once
function hqGarageSync(){
  if(HQ_GARAGE.synced || !hqGarageCan() || typeof hqArena!=="function") return;
  HQ_GARAGE.synced=true;
  hqArena("GET","/api/arena/hq/garage").then(function(res){
    if(!res.ok){ if(res.code===404) HQ_GARAGE.remote=false; return; }
    HQ_GARAGE.remote=true;
    if(HQ_GARAGE.saved===undefined && !HQ_GARAGE.draft){ HQ_GARAGE.saved=hqGarageClean(res.j && res.j.garage); hqStudioApply(); }
  }).catch(function(){});
}
function hqGarageOpen(){
  var I=hqs3d(), L=I && I.garageLot ? I.garageLot() : null;
  if(!L){ var t="Go out to your HQ in the City to move your garage."; if(typeof announce==="function") announce(t); if(typeof toast==="function") toast(t, "level"); return; }
  var sb=$("hqStudio"); if(sb && sb.classList.contains("open")) hqStudioClose(false);
  HQ_GARAGE.lot=L; HQ_GARAGE.draft=null; HQ_GARAGE.note=""; HQ_GARAGE.why=null;
  var g=L.garage || L.def || {x:13, z:6.5, r:0};
  HQ_GARAGE.cur={x:hqGarageSnap(g.x), z:hqGarageSnap(g.z), r:hqGarageTurn(g.r!=null ? g.r : (g.f===-1 ? 2 : 0), 0)};
  HQ_GARAGE.start={x:HQ_GARAGE.cur.x, z:HQ_GARAGE.cur.z, r:HQ_GARAGE.cur.r};
  HQ_GARAGE.back=document.activeElement;
  var bk=$("hqGarage"); if(!bk){ bk=hqGarageBuild(); document.body.appendChild(bk); }
  bk.classList.add("open");
  var m=bk.querySelector(".hqs"), cv=document.querySelector("canvas.hq3d-canvas"), sh=0;   // the share of the 3D view the panel covers
  if(m && cv && m.getBoundingClientRect){ var a=m.getBoundingClientRect(), b=cv.getBoundingClientRect(); if(b.width && a.left<b.right) sh=Math.max(0, Math.min(0.6, (b.right-Math.max(a.left,b.left))/b.width)); }
  I.garageView({cb:HQG_PLACE, shift:sh});
  hqGarageSync();
  hqGarageRender(true);
  var p=$("hqgPad"); if(p) p.focus();
}
function hqGarageClose(){
  var bk=$("hqGarage"), I=hqs3d();
  HQ_GARAGE.draft=null;
  if(I && I.garageView) I.garageView(null);
  if(bk) bk.classList.remove("open");
  hqStudioApply();                                                   // your HQ with its saved garage again
  if(HQ_GARAGE.back && HQ_GARAGE.back.focus && HQ_GARAGE.back!==document.body) HQ_GARAGE.back.focus();
}
function hqGarageNote(t){ HQ_GARAGE.note=t; var n=$("hqgNote"); if(n) n.textContent=t; if(typeof announce==="function") announce(t); }
function hqGarageBuild(){
  var bk=document.createElement("div"); bk.className="modalback hqs-back hqg-back"; bk.id="hqGarage";
  var m=document.createElement("div"); m.className="modal hqs hqg"; m.setAttribute("role","dialog"); m.setAttribute("aria-modal","false"); m.setAttribute("aria-labelledby","hqgTitle");
  var h=document.createElement("div"); h.className="modal-h";
  var t=document.createElement("h3"); t.id="hqgTitle"; t.textContent="Move garage"; h.appendChild(t);
  var x=document.createElement("button"); x.type="button"; x.className="hbtn icon ghost"; x.setAttribute("aria-label","Cancel: put the garage back"); x.textContent="✕";
  x.addEventListener("click", function(){ hqGarageClose(); }); h.appendChild(x);
  m.appendChild(h);
  var body=document.createElement("div"); body.className="modal-b hqs-body"; body.id="hqgBody";
  var how=document.createElement("p"); how.className="muted hqs-hint";
  how.textContent="Point at your lot: the ghost shows where your car lift would go, green where it fits. Click places it, R or a right click turns it, drag pans, scroll zooms.";
  body.appendChild(how);
  var pad=document.createElement("div"); pad.className="hqs-pad"; pad.id="hqgPad"; pad.tabIndex=0;
  pad.setAttribute("role","application"); pad.setAttribute("aria-roledescription","placement cursor");
  pad.setAttribute("aria-label","Garage placement cursor on your lot. Arrow keys move the garage half a metre, R turns it, Space places it, Enter saves, Escape puts it back.");
  var info=document.createElement("p"); info.className="hqs-padinfo"; info.id="hqgInfo"; info.setAttribute("aria-live","polite"); pad.appendChild(info);
  pad.addEventListener("keydown", function(e){
    var k=hqGarageKeyOf(e); if(!k || e.metaKey || e.ctrlKey || e.altKey) return;
    e.preventDefault(); e.stopPropagation(); hqGarageKey(k);
  });
  body.appendChild(pad);
  var face=document.createElement("div"); face.className="hqs-row";
  var fl=document.createElement("span"); fl.className="hqs-l"; fl.textContent="Door faces"; face.appendChild(fl);
  var fg=document.createElement("div"); fg.className="hqs-chips"; fg.id="hqgFacing"; fg.setAttribute("role","radiogroup"); fg.setAttribute("aria-label","Door faces");
  HQG_FACING.forEach(function(o){
    var b=document.createElement("button"); b.type="button"; b.className="hqs-chip"; b.setAttribute("role","radio"); b.textContent=o[1];
    b.addEventListener("click", function(){ HQ_GARAGE.cur.r=o[0]; hqGarageRender(true); var nb=fg.children[o[0]]; if(nb) nb.focus(); });
    b.addEventListener("keydown", function(e){
      var d=e.key==="ArrowRight"||e.key==="ArrowDown" ? 1 : e.key==="ArrowLeft"||e.key==="ArrowUp" ? -1 : 0; if(!d) return; e.preventDefault(); e.stopPropagation();
      HQ_GARAGE.cur.r=hqGarageTurn(HQ_GARAGE.cur.r, d); hqGarageRender(true); var nb=fg.children[HQ_GARAGE.cur.r]; if(nb) nb.focus();
    });
    fg.appendChild(b);
  });
  face.appendChild(fg); body.appendChild(face);
  m.appendChild(body);
  var foot=document.createElement("div"); foot.className="hqs-foot";
  [["Turn (R)", function(){ hqGarageKey("rotate"); }, "ghost"], ["Reset to default", function(){ hqGarageReset(); }, "ghost"],
   ["Cancel", function(){ hqGarageClose(); }, "ghost"], ["Save", function(){ hqGarageSave(); }, ""]].forEach(function(a){
    var b=document.createElement("button"); b.type="button"; b.className="hbtn"+(a[2] ? " "+a[2] : ""); b.textContent=a[0]; b.addEventListener("click", a[1]); foot.appendChild(b);
  });
  var note=document.createElement("span"); note.className="muted hqs-note"; note.id="hqgNote"; note.setAttribute("aria-live","polite"); foot.appendChild(note);
  m.appendChild(foot); bk.appendChild(m);
  bk.addEventListener("keydown", function(e){ if(e.key==="Escape"){ e.preventDefault(); e.stopPropagation(); hqGarageClose(); } });
  return bk;
}
// the 3D view's pointer and keys (games/hq3d.js garageView)
var HQG_PLACE={
  hover:function(x, z){ var C=HQ_GARAGE.cur; x=hqGarageSnap(x); z=hqGarageSnap(z); if(C.x===x && C.z===z) return; C.x=x; C.z=z; hqGarageCursor(false); },
  place:function(x, z){ HQ_GARAGE.cur.x=hqGarageSnap(x); HQ_GARAGE.cur.z=hqGarageSnap(z); hqGarageKey("place"); },
  key:function(k){ hqGarageKey(k); }
};
function hqGarageKey(k){
  if(k==="save"){ hqGarageSave(); return; }
  if(k==="cancel"){ hqGarageClose(); return; }
  if(k==="place"){ hqGaragePlace(); return; }
  HQ_GARAGE.cur=hqGarageStep(HQ_GARAGE.cur, k);
  hqGarageRender(false);
}
function hqGarageFit(sp){ var L=HQ_GARAGE.lot; return L && L.fits ? L.fits(sp || HQ_GARAGE.cur) : {ok:false, why:"outside the lot"}; }
function hqGaragePlace(){
  var L=HQ_GARAGE.lot, f=hqGarageFit(); if(!L) return;
  if(!f.ok){ hqGarageNote("Can't put it there: "+(HQG_WHY[f.why] || f.why)+"."); return; }
  HQ_GARAGE.draft=hqGarageDm(HQ_GARAGE.cur, L.rank);
  hqStudioApply();                                                   // your HQ shows it there now
  hqGarageNote("Placed. Save keeps it; Cancel puts it back.");
  hqGarageCursor(true);
}
function hqGarageSave(){
  var L=HQ_GARAGE.lot; if(!L) return;
  var sp=HQ_GARAGE.draft ? hqGarageM(HQ_GARAGE.draft) : HQ_GARAGE.cur, f=hqGarageFit(sp);
  if(!f.ok){ hqGarageNote("Not saved: "+(HQG_WHY[f.why] || f.why)+"."); return; }
  var g=hqGarageDm(sp, L.rank);
  HQ_GARAGE.saved=g; hqGarageKeep(g);
  if(!hqGarageCan()) hqGarageNote(window.ARENA && ARENA.paired ? "Saved on this machine. This Arena doesn't keep garage spots yet, so others see it in its usual place." : "Saved on this machine. Pair with an Arena so others see it.");
  else {
    hqGarageNote("Saving…");
    hqArena("POST","/api/arena/hq/garage",g).then(function(res){
      if(res.ok){ HQ_GARAGE.remote=true; hqGarageNote("Saved. Everyone sees your garage there."); }
      else if(res.code===404){ HQ_GARAGE.remote=false; hqGarageNote("Saved on this machine. This Arena doesn't keep garage spots yet."); }
      else hqGarageNote("Saved here. "+((res.j && (res.j.error||res.j.detail))||"The Arena didn't answer."));
    }).catch(function(){ hqGarageNote("Saved here. The Arena didn't answer."); });
  }
  hqGarageClose();
}
function hqGarageReset(){
  var L=HQ_GARAGE.lot;
  HQ_GARAGE.saved=null; HQ_GARAGE.draft=null; hqGarageKeep(null);
  if(hqGarageCan()) hqArena("POST","/api/arena/hq/garage/reset",{}).then(function(res){
    if(!res.ok && res.code!==404) hqGarageNote("Reset here. "+((res.j && (res.j.error||res.j.detail))||"The Arena didn't answer."));
  }).catch(function(){});
  if(L && L.def) HQ_GARAGE.cur={x:hqGarageSnap(L.def.x), z:hqGarageSnap(L.def.z), r:hqGarageTurn(L.def.r!=null ? L.def.r : (L.def.f===-1 ? 2 : 0), 0)};
  hqStudioApply();
  hqGarageNote("Your garage is back in its usual place.");
  hqGarageRender(true);
}
// the panel's facing chips and note, then the ghost
function hqGarageRender(quiet){
  var fg=$("hqgFacing");
  if(fg) Array.prototype.forEach.call(fg.children, function(b, i){ var on=i===HQ_GARAGE.cur.r; b.setAttribute("aria-checked", on?"true":"false"); b.tabIndex=on?0:-1; });
  var n=$("hqgNote"); if(n) n.textContent=HQ_GARAGE.note;
  hqGarageCursor(quiet);
}
// the cursor moved or turned: the ghost in 3D (green / red), the pad's words; a new reason it can't go there is announced
// (quiet: not now, something else is being said)
function hqGarageCursor(quiet){
  var C=HQ_GARAGE.cur, f=hqGarageFit(), I=hqs3d(), info=$("hqgInfo");
  var txt="Garage at "+C.x+", "+C.z+" m, door facing "+HQG_FACING[C.r][1].toLowerCase()+(f.ok ? ": it fits." : ": it can't go here, "+(HQG_WHY[f.why] || f.why)+".");
  if(info) info.textContent=txt;
  var p=$("hqgPad"); if(p){ p.classList.toggle("bad", !f.ok); p.classList.toggle("good", !!f.ok); }
  if(I && I.garageGhost) I.garageGhost({x:C.x, z:C.z, r:C.r, ok:!!f.ok, way:f.way || []});
  var why=f.ok ? "" : f.why;
  if(why!==HQ_GARAGE.why && !quiet && why && typeof announce==="function") announce("Can't go here: "+(HQG_WHY[why] || why)+".");
  HQ_GARAGE.why=why;
}

(function(){
  var b=$("setStudio"); if(b) b.addEventListener("click", function(){ var c=$("settingsClose"); if(c) c.click(); hqStudioOpen(); });
  var h=$("hqStudioBtn"); if(h) h.addEventListener("click", function(){ hqStudioOpen(); });
})();
