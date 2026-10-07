/* ===== Cali Tuesdays: a retro taqueria. Seat friends, drag food from the counter onto their
   plates, check out, watch the hi-score board. The page sends only who ate what; TT, the
   buy-1-get-1 price and TPP are the Arena server's (backend/app/tacos.py), and caliPaid()
   only powers the running receipt. ===== */
// Wire key, name, sprite, shelf. The four tacos are TacoCounts; everything else is an item.
var CD_FOODS = [
  {key:"mildHard", taco:true, name:"Mild Hard Taco", sprite:"cd_mh", shelf:"tacos"},
  {key:"mildSoft", taco:true, name:"Mild Soft Taco", sprite:"cd_ms", shelf:"tacos"},
  {key:"wildHard", taco:true, name:"Wild Hard Taco", sprite:"cd_wh", shelf:"tacos"},
  {key:"wildSoft", taco:true, name:"Wild Soft Taco", sprite:"cd_ws", shelf:"tacos"},
  {key:"burrito", name:"Burrito", sprite:"cd_burrito", shelf:"mains"},
  {key:"ricebowl", name:"Rice Bowl", sprite:"cd_ricebowl", shelf:"mains"},
  {key:"saladbowl", name:"Salad Bowl", sprite:"cd_saladbowl", shelf:"mains"},
  {key:"quesadilla", name:"Quesadilla", sprite:"cd_quesadilla", shelf:"mains"},
  {key:"nachos", name:"Nachos", sprite:"cd_nachos", shelf:"mains"},
  {key:"tostada", name:"Tostada", sprite:"cd_tostada", shelf:"mains"},
  {key:"chips", name:"Chips & Salsa", sprite:"cd_chips", shelf:"extras"},
  {key:"guac", name:"Guacamole", sprite:"cd_guac", shelf:"extras"},
  {key:"churros", name:"Churros", sprite:"cd_churros", shelf:"extras"},
  {key:"soda", name:"Soda", sprite:"cd_soda", shelf:"extras"},
  {key:"icedtea", name:"Iced Tea", sprite:"cd_icedtea", shelf:"extras"}
];
var CD_SHELVES = [["tacos","Tacos · buy 1 get 1"], ["mains","Mains"], ["extras","Sides, sweets & drinks"]];
// Mirrors backend/app/schemas.py (MAX_DINERS, MAX_PER_VARIANT, MAX_PER_ITEM, DINER_NAME_MAX).
var CD_MAX_PEOPLE = 20, CD_MAX_TACO = 50, CD_MAX_ITEM = 20, CD_NAME_MAX = 40;
var CD = {built:false, people:[], seq:0, picked:null, drag:null, justDragged:false, window:"season", board:null,
  menuOk:null, menuNames:{}, busy:false, rid:null, sfx:true, prevRows:null, fresh:{}, s:3, W:400, raf:0, anim:false,
  last:0, calmTimer:0, paid:false};

function cdFood(key){ for(var i=0;i<CD_FOODS.length;i++) if(CD_FOODS[i].key===key) return CD_FOODS[i]; return null; }
function cdName(f){ return (!f.taco && CD.menuNames[f.key]) || f.name; }
function cdPerson(pid){ for(var i=0;i<CD.people.length;i++) if(CD.people[i].id===pid) return CD.people[i]; return null; }
function cdCount(p, key){ var f=cdFood(key); if(!p || !f) return 0; return (f.taco ? p.tacos[key] : p.items[key])|0; }
function cdTacos(p){ return (p.tacos.mildHard|0)+(p.tacos.mildSoft|0)+(p.tacos.wildHard|0)+(p.tacos.wildSoft|0); }
function cdItems(p){ var n=0; for(var k in p.items) n+=p.items[k]|0; return n; }
// "@ana" is an Arena handle, anything else a plain name: the server keeps the account when it has one.
function cdWho(raw){
  raw=String(raw||"").replace(/\s+/g," ").trim().slice(0, CD_NAME_MAX+1);
  if(raw.charAt(0)==="@"){
    var h=raw.slice(1).trim(); if(!/^[A-Za-z0-9_-]{1,64}$/.test(h)) return null;
    var r=cdRosterFind(h); if(r) h=r.handle;   // the Arena matches handles exactly: use its spelling
    return {handle:h, key:"@"+h.toLowerCase()};
  }
  raw=raw.slice(0, CD_NAME_MAX); return raw ? {name:raw, key:"#"+raw.toLowerCase()} : null;
}
function cdLabel(p){ var w=(p && p.who) || {}; if(w.handle){ var r=cdRosterFind(w.handle); return r ? r.name : w.handle; } return w.name || "?"; }
function cdWhoLabel(w){ return cdLabel({who:w}); }
// "ok" (a known Arena account), "unknown" (the roster loaded and has no such handle), "pending",
// or "" for someone seated by name.
function cdTagState(p){ var w=(p && p.who) || {}; if(!w.handle) return ""; if(cdRosterFind(w.handle)) return "ok"; return CD_ROSTER.ok ? "unknown" : "pending"; }

/* ---- tagging people on the Arena. The roster is the Arena board (everyone who has published
   stats), anyone already on the taco board, and the paired account; the diner only reads it. The
   server matches handles exactly and fails the whole order on an unknown one, so a tag always
   takes the roster's spelling. ---- */
var CD_ROSTER = {list:[], at:0, loading:false, ok:false, err:false};
function cdMe(){
  var A=(typeof ARENA!=="undefined" && ARENA) || {}, st=(A.status && A.status.handle) ? A.status : (CD.me || {});
  if(typeof st.handle!=="string" || !/^[A-Za-z0-9_-]{1,64}$/.test(st.handle)) return null;
  return {handle:st.handle, name:(typeof st.displayName==="string" && st.displayName.trim()) ? st.displayName.trim().slice(0, CD_NAME_MAX) : st.handle,
          av:(typeof st.avatarUrl==="string" && /^https:\/\//.test(st.avatarUrl)) ? st.avatarUrl : ""};
}
function cdRosterFind(h){
  h=String(h||"").replace(/^@/,"").toLowerCase(); if(!h) return null;
  for(var i=0;i<CD_ROSTER.list.length;i++) if(CD_ROSTER.list[i].handle.toLowerCase()===h) return CD_ROSTER.list[i];
  var me=cdMe(); return (me && me.handle.toLowerCase()===h) ? me : null;
}
function cdRosterAdd(m, handle, name, av){
  if(typeof handle!=="string" || !/^[A-Za-z0-9_-]{1,64}$/.test(handle)) return;
  var k=handle.toLowerCase(); if(m[k]) return;
  name=(typeof name==="string") ? name.replace(/\s+/g," ").trim().slice(0, CD_NAME_MAX) : "";
  m[k]={handle:handle, name:name || handle, av:(typeof av==="string" && /^https:\/\//.test(av)) ? av : ""};
}
function cdRosterLoad(force){
  var age=Date.now()-CD_ROSTER.at;
  if(CD_ROSTER.loading || (!force && ((CD_ROSTER.ok && age<600000) || (CD_ROSTER.err && age<15000)))) return;
  CD_ROSTER.loading=true; CD_ROSTER.at=Date.now();
  var settle=function(changed){
    CD_ROSTER.loading=false;
    if(VIEW!=="cali") return;
    if(changed){ cdRenderTable(); cdRenderReceipt(); }
    if(CD.tagFill) CD.tagFill();
    if(CD.sugg) cdSuggest();
  };
  fetch("/api/arena/board?window=all", {cache:"no-store"})
    .then(function(r){ return r.ok ? r.json() : null; })
    .then(function(b){
      if(!b || !Array.isArray(b.entries)){ CD_ROSTER.err=true; settle(false); return; }
      var m={};
      b.entries.forEach(function(e){ if(e) cdRosterAdd(m, e.handle, e.displayName || e.trainerName, e.avatarUrl); });
      ((CD.board||{}).entries||[]).forEach(function(e){ if(e && e.handle) cdRosterAdd(m, e.handle, e.name, e.avatarUrl); });
      var me=cdMe(); if(me) cdRosterAdd(m, me.handle, me.name, me.av);
      CD_ROSTER.list=Object.keys(m).map(function(k){ return m[k]; }).sort(function(a, b){ return a.name.localeCompare(b.name); });
      CD_ROSTER.ok=true; CD_ROSTER.err=false; CD_ROSTER.at=Date.now();
      // a tag typed with other capitalisation takes the Arena's spelling
      var fixed=false;
      CD.people.forEach(function(p){ var r=p.who.handle ? cdRosterFind(p.who.handle) : null; if(r && r.handle!==p.who.handle){ p.who.handle=r.handle; fixed=true; } });
      if(fixed) cdSave();
      settle(true);
    }, function(){ CD_ROSTER.err=true; settle(false); });
}
// Everyone matching "het", "@het" or "shah": handle or name prefix first, then a later word, then anywhere.
function cdRosterMatch(q){
  q=String(q||"").trim().replace(/^@/,"").toLowerCase(); if(!q) return [];
  var out=[];
  CD_ROSTER.list.forEach(function(r){
    var h=r.handle.toLowerCase(), n=r.name.toLowerCase();
    var sc = (h.indexOf(q)===0 || n.indexOf(q)===0) ? 0
           : n.split(" ").some(function(w){ return w.indexOf(q)===0; }) ? 1
           : (h.indexOf(q)>=0 || n.indexOf(q)>=0) ? 2 : -1;
    if(sc>=0) out.push({r:r, s:sc});
  });
  out.sort(function(a, b){ return (a.s-b.s) || a.r.name.localeCompare(b.r.name); });
  return out.map(function(x){ return x.r; });
}
function cdSeatedAs(handle){ var k="@"+handle.toLowerCase(); return CD.people.filter(function(p){ return p.who.key===k; })[0] || null; }
function cdOptRow(o, r, aside){
  if(r.av){ var im=el("img"); im.alt=""; im.loading="lazy"; im.src=r.av; o.appendChild(im); }
  var a=el("span","cd-tagopt-n"); a.textContent=r.name; o.appendChild(a);
  var b=el("span","cd-tagopt-h"); b.textContent=aside || "@"+r.handle; o.appendChild(b);
}
// The seat box autocompletes from the Arena: "@" lists everyone and narrows as you type, with the
// top match ready for Enter. A plain name also offers matching Arena people, but Enter keeps the name.
function cdSuggest(){
  var inp=$("cdSeatName"), box=$("cdSugg"); if(!inp || !box) return;
  var q=inp.value.trim(), at=q.charAt(0)==="@", note="";
  if(at) cdRosterLoad();
  var ms=(at && q.length===1) ? CD_ROSTER.list.slice() : cdRosterMatch(q);
  ms=ms.filter(function(r){ return !cdSeatedAs(r.handle); }).slice(0, at ? 8 : 4);
  if(at && !ms.length){
    note = CD_ROSTER.ok ? (q.length>1 ? "Nobody on the Arena matches “"+q+"”." : "Everyone on the Arena already has a seat.")
         : CD_ROSTER.err ? "Couldn’t load the Arena. Type their exact @handle, or seat them by name."
         : "Loading the Arena…";
  }
  CD.sugg={list:ms, active:(at && ms.length) ? 0 : -1};
  box.innerHTML="";
  ms.forEach(function(r, i){
    var o=el("div","cd-sugg-o"); o.id="cdSugg-"+i; o.setAttribute("role","option");
    cdOptRow(o, r);
    o.addEventListener("mousedown", function(e){ e.preventDefault(); cdSuggPick(i); });
    box.appendChild(o);
  });
  if(note){ var n=el("p","cd-tagnote"); n.textContent=note; box.appendChild(n); }
  box.classList.toggle("hidden", !(ms.length || note));
  inp.setAttribute("aria-expanded", ms.length ? "true" : "false");
  cdSuggPaint();
}
function cdSuggPaint(){
  var sg=CD.sugg, box=$("cdSugg"), inp=$("cdSeatName"); if(!sg || !box || !inp) return;
  Array.prototype.forEach.call(box.querySelectorAll(".cd-sugg-o"), function(o, i){ var on=i===sg.active; o.classList.toggle("on", on); o.setAttribute("aria-selected", on ? "true" : "false"); });
  if(sg.active>=0) inp.setAttribute("aria-activedescendant", "cdSugg-"+sg.active); else inp.removeAttribute("aria-activedescendant");
}
function cdSuggMove(d){
  var sg=CD.sugg, n=sg ? sg.list.length : 0; if(!n) return;
  sg.active = sg.active<0 ? (d>0 ? 0 : n-1) : (sg.active+d+n)%n;
  cdSuggPaint();
}
function cdSuggPick(i){
  var r=CD.sugg && CD.sugg.list[i], inp=$("cdSeatName"); if(!r || !inp) return;
  if(cdSeat("@"+r.handle)) inp.value="";
  cdSuggClose(); inp.focus();
}
function cdSuggClose(){
  var box=$("cdSugg"), inp=$("cdSeatName"); CD.sugg=null;
  if(box){ box.classList.add("hidden"); box.innerHTML=""; }
  if(inp){ inp.setAttribute("aria-expanded","false"); inp.removeAttribute("aria-activedescendant"); }
}
// "Who is this on the Arena?": tag (or re-tag) someone already at the table.
function cdTagOpen(pid, anchor){
  var p=cdPerson(pid); if(!p) return;
  if(CD.tagFor && CD.tagFor.pid===pid){ cdTagClose(true); return; }
  cdTagClose(false); cdRosterLoad();
  var box=el("div","cd-tagpop"); box.id="cdTagPop"; box.setAttribute("role","dialog"); box.setAttribute("aria-label","Tag "+cdLabel(p)+" on the Arena");
  var h=el("div","cd-tagpop-h"); h.textContent="Who is "+cdLabel(p)+" on the Arena?"; box.appendChild(h);
  var q=el("input","cd-tagq"); q.type="text"; q.placeholder="Search names or @handles"; q.autocomplete="off"; q.spellcheck=false;
  q.setAttribute("aria-label","Search the Arena"); q.value=p.who.handle ? "" : (p.who.name||""); box.appendChild(q);
  var list=el("div","cd-taglist"); list.setAttribute("role","listbox"); list.setAttribute("aria-label","Arena people"); box.appendChild(list);
  var acts=el("div","cd-tagacts");
  if(p.who.handle){ var un=el("button","cd-btn small ghost"); un.type="button"; un.textContent="Untag"; un.title="Keep them at the table by name only"; un.addEventListener("click", function(){ cdUntag(pid); }); acts.appendChild(un); }
  var cx=el("button","cd-btn small ghost"); cx.type="button"; cx.textContent="Cancel"; cx.addEventListener("click", function(){ cdTagClose(true); }); acts.appendChild(cx);
  box.appendChild(acts);
  var fill=function(){
    list.innerHTML="";
    var ms=(q.value.trim().replace(/^@/,"") ? cdRosterMatch(q.value) : CD_ROSTER.list).slice(0, 8);
    if(!CD_ROSTER.list.length){
      var n=el("p","cd-tagnote"); n.textContent=CD_ROSTER.err ? "Couldn\u2019t load the Arena. Seat them with their exact @handle instead." : "Loading the Arena\u2026"; list.appendChild(n); return;
    }
    if(!ms.length){ var n2=el("p","cd-tagnote"); n2.textContent="Nobody on the Arena matches that."; list.appendChild(n2); return; }
    ms.forEach(function(r){
      var o=el("button","cd-tagopt"); o.type="button"; o.setAttribute("role","option");
      o.setAttribute("aria-selected", (p.who.handle && r.handle===p.who.handle) ? "true" : "false");
      var at=cdSeatedAs(r.handle);
      cdOptRow(o, r, (at && at!==p) ? "SEATED \u00B7 MERGE" : "");
      o.addEventListener("click", function(){ cdRetag(pid, r.handle); });
      list.appendChild(o);
    });
  };
  q.addEventListener("input", fill);
  q.addEventListener("keydown", function(e){
    if(e.key==="ArrowDown"){ var f=list.querySelector(".cd-tagopt"); if(f){ e.preventDefault(); f.focus(); } }
    else if(e.key==="Enter"){ var g=list.querySelector(".cd-tagopt"); if(g){ e.preventDefault(); g.click(); } }
  });
  list.addEventListener("keydown", function(e){
    var all=[].slice.call(list.querySelectorAll(".cd-tagopt")), i=all.indexOf(document.activeElement); if(i<0) return;
    if(e.key==="ArrowDown"){ e.preventDefault(); (all[i+1]||all[i]).focus(); }
    else if(e.key==="ArrowUp"){ e.preventDefault(); if(i>0) all[i-1].focus(); else q.focus(); }
  });
  box.addEventListener("keydown", function(e){ if(e.key==="Escape"){ e.preventDefault(); e.stopPropagation(); cdTagClose(true); } });
  document.body.appendChild(box);
  CD.tagFor={pid:pid, anchor:anchor}; CD.tagFill=fill;
  fill();
  var rc=anchor.getBoundingClientRect(), bw=box.offsetWidth, bh=box.offsetHeight;
  var x=Math.min(window.innerWidth-bw-10, Math.max(10, rc.left)), y=rc.bottom+6;
  if(y+bh>window.innerHeight-10) y=Math.max(10, rc.top-bh-6);
  box.style.left=x+"px"; box.style.top=y+"px";
  q.focus(); q.select();
}
function cdTagClose(refocus){
  var b=$("cdTagPop"); if(!b) return;
  var a=CD.tagFor && CD.tagFor.anchor;
  b.parentNode.removeChild(b); CD.tagFor=null; CD.tagFill=null;
  if(refocus && a && document.body.contains(a)) focusQuiet(a);
}
function cdMergeInto(dst, src){
  CD_FOODS.forEach(function(f){
    var n=Math.min(f.taco ? CD_MAX_TACO : CD_MAX_ITEM, cdCount(dst, f.key)+cdCount(src, f.key));
    if(f.taco) dst.tacos[f.key]=n; else if(n) dst.items[f.key]=n; else delete dst.items[f.key];
  });
  CD.people=CD.people.filter(function(x){ return x!==src; });
}
// Give a seated person an identity; if someone already sits under it, the two plates merge.
function cdReseat(pid, who, said){
  var p=cdPerson(pid); if(!p || !who) return;
  var other=null; CD.people.forEach(function(x){ if(x!==p && x.who.key===who.key) other=x; });
  if(other){ cdMergeInto(other, p); toast(cdLabel(other)+" already had a seat, so the two plates were merged."); announce(cdLabel(other)+" already had a seat, so the two plates were merged."); }
  else { p.who=who; announce(said(p)); }
  CD.paid=false; cdTagClose(false);
  cdSave(); cdRenderTable(); cdRenderReceipt(); cdSfx("seat");
  var keep=other||p, btn=document.querySelector('.cd-plate[data-pid="'+keep.id+'"] .cd-name'); if(btn) focusQuiet(btn);
}
function cdRetag(pid, handle){ cdReseat(pid, cdWho("@"+handle), function(p){ return cdLabel(p)+" is tagged as @"+p.who.handle+" on the Arena."; }); }
function cdUntag(pid){ var p=cdPerson(pid); if(p) cdReseat(pid, cdWho(cdLabel(p)), function(q){ return cdLabel(q)+" is seated by name now."; }); }
function cdNewPerson(who){ CD.seq++; return {id:"p"+CD.seq, who:who, tacos:{mildHard:0, mildSoft:0, wildHard:0, wildSoft:0}, items:{}}; }

/* ---- the table survives a reload (a per-browser convenience) ---- */
function cdSave(){
  try{ localStorage.setItem("hq_cali_table", JSON.stringify({v:1, people:CD.people.map(function(p){ return {w:p.who.handle ? "@"+p.who.handle : p.who.name, t:p.tacos, i:p.items}; })})); }catch(e){}
}
function cdLoadSaved(){
  var raw=null; try{ raw=JSON.parse(localStorage.getItem("hq_cali_table")||"null"); }catch(e){ raw=null; }
  if(!raw || !Array.isArray(raw.people)) return;
  raw.people.slice(0, CD_MAX_PEOPLE).forEach(function(s){
    var who=cdWho(s && s.w); if(!who || CD.people.some(function(p){ return p.who.key===who.key; })) return;
    var p=cdNewPerson(who);
    CD_FOODS.forEach(function(f){
      var src=f.taco ? (s.t||{}) : (s.i||{}), v=src[f.key];
      v=(typeof v==="number" && v>0) ? Math.min(f.taco ? CD_MAX_TACO : CD_MAX_ITEM, Math.floor(v)) : 0;
      if(f.taco) p.tacos[f.key]=v; else if(v) p.items[f.key]=v;
    });
    CD.people.push(p);
  });
}

/* ---- sound: 8-bit blips (WebAudio, generated), with their own mute ---- */
function cdSfx(name){
  if(!CD.sfx || document.hidden) return;
  if(!audioCtx && !(navigator.userActivation && navigator.userActivation.hasBeenActive)) return;
  var a=svAudio(); if(!a) return;
  try{
    var t=a.currentTime+0.01;
    if(name==="pick") svTone(a,"square",660,990,t,0.07,0.04);
    else if(name==="drop"){ svTone(a,"square",523,0,t,0.05,0.045); svTone(a,"square",784,0,t+0.05,0.08,0.045); }
    else if(name==="remove") svTone(a,"square",520,260,t,0.1,0.04);
    else if(name==="seat"){ svTone(a,"sine",1568,0,t,0.5,0.08); svTone(a,"sine",2349,0,t,0.3,0.03); }
    else if(name==="bonk") svTone(a,"triangle",190,95,t,0.16,0.1);
    else if(name==="kaching"){ svTone(a,"square",1319,0,t,0.06,0.045); svTone(a,"square",1976,0,t+0.06,0.1,0.045); svNoise(a,t+0.06,0.25,0.16,6500,2.5); svTone(a,"triangle",2637,0,t+0.08,0.35,0.035); }
    else if(name==="fanfare"){ [523,659,784,1047].forEach(function(f,i){ svTone(a,"square",f,0,t+0.4+i*0.09,0.12,0.04); }); svTone(a,"square",1319,0,t+0.4+0.36,0.4,0.045); }
  }catch(e){}
}
function cdMuteSync(){
  var b=$("cdMute"); if(!b) return;
  b.setAttribute("aria-pressed", CD.sfx ? "true" : "false");
  b.textContent = CD.sfx ? "🔊" : "🔇";
  b.title = CD.sfx ? "Diner sounds on" : "Diner sounds off";
}

/* ---- the storefront: a food-court taqueria stall in pixel art (canvas, 1 logical px = s CSS px) ----
   Laid out like a mall food-court counter: a slate sign board with 3D lettering, a red tile band
   over cream subway tiles, menu boards, brick pillars with lanterns, a steel counter of food pans
   and a red-tiled front with an LED glow. All of it original: our own sign, our own food sprites
   on the boards, our own mascot. The food you drag sits in the pans (buttons laid over the art). */
var CD_GROUPS = [["tacos",4], ["mains",6], ["extras",5]];
// Food stands 1.5x its 16px sprite: crisp on a 2x screen at s=3 (9 device px per art px).
var CD_FOOD_PX = 24;
function cdStoreLayout(W){
  W=Math.max(150, W|0);
  var L={W:W, pil:W>=280 ? 14 : 6};
  L.x0=L.pil; L.x1=W-L.pil;
  var inner=L.x1-L.x0-12, gap=3, ggap=10, fp=CD_FOOD_PX;
  function rowW(gs, f){ var w=0; gs.forEach(function(g, i){ var n=CD_GROUPS[g][1]; w+=n*(f+2)+(n-1)*gap+(i ? ggap : 0); }); return w; }
  if(inner<rowW([1], fp)) fp=16;   // a very narrow screen: the art at its own size
  var rows = inner>=rowW([0,1,2], fp) ? [[0,1,2]] : inner>=rowW([0,1], fp) ? [[0,1],[2]] : [[0],[1],[2]];
  L.fp=fp; L.cTop=120; L.slots={};
  rows.forEach(function(gs, ri){
    var x=Math.round((L.x0+L.x1-rowW(gs, fp))/2), y=L.cTop-fp+ri*(fp+6);
    gs.forEach(function(g, gi){
      if(gi) x+=ggap;
      CD_FOODS.filter(function(f){ return f.shelf===CD_GROUPS[g][0]; }).forEach(function(f){ L.slots[f.key]={x:x+1, y:y, w:fp, h:fp}; x+=fp+2+gap; });
    });
  });
  L.rows=rows.length;
  L.front=L.cTop+8+(L.rows-1)*(fp+6);
  L.H=L.front+26;
  return L;
}
// Text with a two-step mint extrusion under it, like a lit-letter sign.
function cd3d(c, s, x, y, sc){
  pxText(c, s, x+2, y+2, "#22a37f", null, sc); pxText(c, s, x+1, y+1, "#3fe0b5", null, sc);
  pxText(c, s, x, y, "#ff5c8a", null, sc);
}
function cdStar(c, x, y, col){ svFill(c,col,x+2,y,1,1); svFill(c,col,x+1,y+1,3,1); svFill(c,col,x,y+2,5,1); svFill(c,col,x+1,y+3,3,1); svFill(c,col,x,y+4,2,1); svFill(c,col,x+3,y+4,2,1); }
function cdDrawSign(c, L){
  var sc=2, w2=pxTextW("TUESDAYS", sc), x=Math.round((L.W-w2-10)/2);
  cdStar(c, x, 28, "#3fe0b5"); cdStar(c, x+1, 27, "#ff5c8a");
  cd3d(c, "CALI", x+24, 9, sc); cd3d(c, "TUESDAYS", x+10, 24, sc);
}
function cdDrawBoards(c, L){
  var span=L.x1-L.x0, n=span>=330 ? 5 : span>=230 ? 3 : 2, bw=26, gap=2, tw=n*bw+(n-1)*gap, x=Math.round((L.x0+L.x1-tw)/2), y=56, h=28;
  var all=[
    {bg:"#fbf7ee", ink:"#6b5a48", sp:"cd_burrito"},
    {bg:"#1f3a2c", ink:"#e8f4ea", sp:"cd_mh"},
    {bg:"#e8432f", ink:"#ffffff", sp:"cd_ws", tag:"NEW"},
    {bg:"#c46fd0", ink:"#ffffff", sp:"cd_quesadilla"},
    {bg:"#ffd23f", ink:"#6b4a10", sp:"cd_nachos"}];
  var pick = n===5 ? [0,1,2,3,4] : n===3 ? [0,2,4] : [0,2];
  svFill(c,"#6e7178",x-3,y-3,tw+6,1);
  pick.forEach(function(k){
    var p=all[k];
    svFill(c,"#2a2a2a",x-1,y-1,bw+2,h+2); svFill(c,p.bg,x,y,bw,h);
    svFill(c,"#6e7178",x+5,y-3,1,2); svFill(c,"#6e7178",x+bw-6,y-3,1,2);
    if(p.tag) pxText(c, p.tag, x+4, y+2, "#ffd23f", null);
    else { svFill(c,p.ink,x+2,y+2,bw-8,1); svFill(c,p.ink,x+2,y+4,bw-12,1); svFill(c,p.ink,x+2,y+6,bw-10,1); }
    var sp=pxCanvas(p.sp); if(sp) c.drawImage(sp, x+5, y+11);
    x+=bw+gap;
  });
}
function cdDrawWallBits(c, L, t){
  var span=L.x1-L.x0, x, y, lx=L.x0+5, shelfFrom=L.x0;
  if(span>=210){
    // ORDER, stacked, with an arrow pointing at the counter
    var oy=56;
    svFill(c,"#2e2622",lx,oy,9,44); svFill(c,"#4a3e38",lx,oy,9,1);
    var word="ORDER"; for(var i=0;i<word.length;i++) pxText(c, word.charAt(i), lx+2, oy+2+i*8, "#f2e8d2", null);
    svFill(c,"#f2e8d2",lx+4,oy+43,1,4); svFill(c,"#f2e8d2",lx+2,oy+45,5,1); svFill(c,"#f2e8d2",lx+3,oy+46,3,1);
    lx+=16;
  }
  if(span>=260){
    // the kitchen door: brushed steel with a round window
    var dy=60; svFill(c,"#8e959e",lx-1,dy-1,22,L.cTop-dy+1); svFill(c,"#c3c9d0",lx,dy,20,L.cTop-dy);
    for(y=dy+2;y<L.cTop;y+=3) svFill(c,"#b4bac2",lx+1,y,18,1);
    svDisc(c,"#6a7a88",lx+10,dy+11,4); svDisc(c,"#9ab0c0",lx+9,dy+10,1);
    svFill(c,"#8e959e",lx+16,dy+28,2,6);
    shelfFrom=lx+21; lx+=28;
  }
  if(span>=210){
    // a round green badge with an avocado
    var bx=lx+10, by=76; svDisc(c,"#e8f0e0",bx,by,10); svDisc(c,"#2f6b3a",bx,by,9);
    for(var a=0;a<12;a++){ var ang=a/12*Math.PI*2; svFill(c,"#cfe6c4",bx+Math.round(Math.cos(ang)*7),by+Math.round(Math.sin(ang)*7),1,1); }
    svDisc(c,"#8fc85a",bx,by+1,4); svDisc(c,"#c8e8a0",bx,by+1,2); svDisc(c,"#8a5a2a",bx,by+2,1);
    lx+=26;
  }
  // the back counter: oven, juice dispenser, cups, the till
  y=L.cTop-28;
  svFill(c,"#9aa1aa",shelfFrom,y+12,L.x1-shelfFrom,2);
  if(span>=200){
    var jx=Math.round(L.x0+span*0.44); svFill(c,"#e8f4f8",jx,y-6,5,10); svFill(c,"#e8f4f8",jx+6,y-6,5,10);
    svFill(c,"#e8433a",jx+1,y-3,3,6); svFill(c,"#ff7aa0",jx+7,y-3,3,6); svFill(c,"#6e7178",jx-1,y+4,13,8);
    for(x=Math.round(L.x0+span*0.57);x<L.x0+span*0.57+9;x+=3){ svFill(c,"#ffffff",x,y+2,2,8); svFill(c,"#e8433a",x,y+4,2,1); }
    // the till at the far right, the oven beside it when it clears the food
    var tx=L.x1-24, foodEnd=0, k;
    for(k in L.slots) foodEnd=Math.max(foodEnd, L.slots[k].x+L.slots[k].w+2);
    svFill(c,"#1a1a1e",tx,y-2,10,7); svFill(c,"#3a8ab8",tx+1,y-1,8,5); svFill(c,"#1a1a1e",tx+4,y+5,2,7);
    var ox=tx-24;
    if(ox>=foodEnd+4){ svFill(c,"#26282c",ox,y-2,18,14); svFill(c,"#3a3d42",ox+2,y,10,9); svFill(c,"#7ad0f0",ox+13,y+1,3,2); }
  }
}
function cdDrawPillars(c, L, t){
  var calm=calmMode();
  [0, L.x1].forEach(function(px, side){
    for(var y=40;y<L.H;y+=4){
      var off=((y/4)|0)%2 ? 4 : 0;
      svFill(c,"#5a3a26",px,y,L.pil,4); svFill(c,"#3e2818",px,y+3,L.pil,1);
      for(var x=px+off;x<px+L.pil;x+=8) svFill(c,"#3e2818",x,y,1,3);
    }
    if(L.pil<12) return;
    var lx=px+Math.round(L.pil/2)-3, ly=64, lit=calm ? 1 : 0.85+0.15*Math.sin(t/180+side*2);
    c.fillStyle="rgba(255,206,120,"+(0.16*lit).toFixed(3)+")"; svDiscA(c, lx+3, ly+3, 9);
    svFill(c,"#141416",lx-1,ly-4,8,2); svFill(c,"#141416",lx,ly-2,6,10);
    svFill(c,"rgb(255,"+Math.round(200*lit+20)+",120)",lx+1,ly-1,4,8); svFill(c,"#141416",lx+2,ly-1,1,8);
    svFill(c,"#141416",lx-1,ly+8,8,1); svFill(c,"#141416",lx+2,ly+9,2,2);
  });
}
function cdDrawCounter(c, L){
  var x0=L.x0, x1=L.x1, fp=L.fp;
  svFill(c,"rgba(200,236,248,.5)",x0+6,L.cTop-fp-8,x1-x0-12,1);
  for(var gx=x0+20;gx<x1-10;gx+=60) svFill(c,"rgba(200,236,248,.35)",gx,L.cTop-fp-8,1,6);
  svFill(c,"#c9ced5",x0,L.cTop-2,x1-x0,L.front-(L.cTop-2)); svFill(c,"#f2f4f6",x0,L.cTop-2,x1-x0,1);
  for(var y=L.cTop+1;y<L.front-1;y+=3) svFill(c,"#bcc2ca",x0,y,x1-x0,1);
  svFill(c,"#9aa1aa",x0,L.front-2,x1-x0,2);
  CD_FOODS.forEach(function(f){
    var s=L.slots[f.key]; if(!s) return;
    var top=s.y+Math.round(fp*0.55), ph=fp-Math.round(fp*0.55)+2;
    svFill(c,"#7d848d",s.x-2,top,fp+4,ph); svFill(c,"#b2b8c0",s.x-1,top+1,fp+2,ph-2); svFill(c,"#5c636b",s.x,top+2,fp,ph-4);
  });
}
function cdDrawFront(c, L, t){
  var y0=L.front, x0=L.x0, x1=L.x1;
  svFill(c,"#7a7f87",x0,y0,x1-x0,2);
  for(var y=y0+3;y<L.H;y+=5) for(var x=x0;x<x1;x+=5){ svFill(c,"#b3281f",x,y,5,5); svFill(c,"#7c1813",x+4,y,1,5); svFill(c,"#7c1813",x,y+4,5,1); }
  var pulse=calmMode() ? 1 : 0.85+0.15*Math.sin(t/600);
  svFill(c,"#ffe2b0",x0+2,y0+2,x1-x0-4,1);
  for(var k=0;k<7;k++){ c.fillStyle="rgba(255,190,120,"+((0.24-k*0.032)*pulse).toFixed(3)+")"; c.fillRect(x0, y0+3+k*2, x1-x0, 2); }
}
function cdDrawStore(t){
  var cv=$("cdCanvas"), L=CD.L; if(!cv || !L) return;
  var c=cv.getContext("2d"); if(!c) return;
  var W=L.W, H=L.H, x;
  c.imageSmoothingEnabled=false;
  c.clearRect(0,0,W,H);
  svFill(c,"#141416",0,0,W,6);
  for(x=18;x<W;x+=46){ svFill(c,"#fff4d6",x,3,3,1); svFill(c,"rgba(255,244,214,.35)",x-1,4,5,1); }
  svFill(c,"#4b4e55",0,6,W,34); svFill(c,"#5b5e66",0,6,W,2); svFill(c,"#3a3c42",0,38,W,2);
  cdDrawSign(c, L);
  svFill(c,"#efe8da",L.x0,40,L.x1-L.x0,4);
  for(x=L.x0+10;x<L.x1-6;x+=26) svFill(c,"#ffffff",x,41,4,1);
  for(var y=44;y<52;y+=4) for(x=L.x0;x<L.x1;x+=4){ svFill(c,"#c8342a",x,y,4,4); svFill(c,"#8e1f18",x+3,y,1,4); svFill(c,"#8e1f18",x,y+3,4,1); }
  svFill(c,"#f2e8d2",L.x0,52,L.x1-L.x0,L.cTop-52);
  for(y=52;y<L.cTop;y+=6) svFill(c,"#dacdb2",L.x0,y,L.x1-L.x0,1);
  for(x=L.x0;x<L.x1;x+=6) svFill(c,"#dacdb2",x,52,1,L.cTop-52);
  cdDrawBoards(c, L); cdDrawWallBits(c, L, t);
  cdDrawPillars(c, L, t);
  cdDrawCounter(c, L);
  cdDrawFront(c, L, t);
}
// Size the stage to whole-pixel steps, lay the food buttons over their pans.
function cdResize(){
  var wrap=$("cdStageWrap"), stage=$("cdStage"), cv=$("cdCanvas"); if(!wrap || !stage || !cv) return;
  var cw=wrap.clientWidth|0; if(cw<=0) return;
  var s=cw>=1080 ? 3 : 2, W=Math.max(150, Math.ceil(cw/s));
  if(s===CD.s && W===CD.W && CD.L) return;
  CD.s=s; CD.W=W; CD.L=cdStoreLayout(W);
  cv.width=CD.L.W; cv.height=CD.L.H;
  stage.style.width=(CD.L.W*s)+"px"; stage.style.height=(CD.L.H*s)+"px";
  Array.prototype.forEach.call(document.querySelectorAll("#cdHots .cd-food"), function(b){
    var sl=CD.L.slots[b.getAttribute("data-food")]; if(!sl) return;
    b.style.left=(sl.x*s)+"px"; b.style.top=(sl.y*s)+"px"; b.style.width=(sl.w*s)+"px"; b.style.height=(sl.h*s)+"px";
  });
  cdDrawStore(0);
}
function cdAnimStop(){ CD.anim=false; if(CD.raf) cancelAnimationFrame(CD.raf); CD.raf=0; }
function cdAnimStart(){
  cdAnimStop();
  if(VIEW!=="cali" || document.hidden) return;
  cdDrawStore(0);
  if(calmMode()) return;
  CD.anim=true;
  var loop=function(ts){
    if(!CD.anim) return;
    if(calmMode()){ cdAnimStop(); cdDrawStore(0); return; }
    if(ts-CD.last>=90){ CD.last=ts; cdDrawStore(ts); }
    CD.raf=requestAnimationFrame(loop);
  };
  CD.raf=requestAnimationFrame(loop);
}

/* ---- the food in the pans ---- */
function cdBuildCounter(){
  var box=$("cdHots"); if(!box) return;
  box.innerHTML="";
  CD_FOODS.forEach(function(f){
    var b=el("button","cd-food"); b.type="button"; b.setAttribute("data-food", f.key);
    var im=el("img"); im.alt=""; im.draggable=false; im.src=pxURL(f.sprite); b.appendChild(im);
    cdFoodLabel(b, f);
    b.addEventListener("pointerdown", function(e){ cdPointerDown(e, f.key, null, b); });
    b.addEventListener("click", function(){ if(CD.justDragged) return; cdPick(CD.picked===f.key ? null : f.key); });
    b.addEventListener("mouseenter", function(){ cdTag(b, f); });
    b.addEventListener("focus", function(){ cdTag(b, f); });
    b.addEventListener("mouseleave", function(){ cdTag(null); });
    b.addEventListener("blur", function(){ cdTag(null); });
    box.appendChild(b);
  });
}
// The name card that pops up over a pan you point at.
function cdTag(b, f){
  var t=$("cdLabel"); if(!t) return;
  if(!b || CD.drag && CD.drag.on){ t.classList.add("hidden"); return; }
  t.textContent=cdName(f).toUpperCase()+(f.taco ? (f.key.indexOf("wild")===0 ? " · SPICY" : " · MILD") : "");
  t.classList.remove("hidden");
  var left=b.offsetLeft+b.offsetWidth/2, top=b.offsetTop;
  t.style.left=left+"px"; t.style.top=top+"px";
}
function cdFoodLabel(b, f){
  b.setAttribute("aria-pressed", CD.picked===f.key ? "true" : "false");
  b.setAttribute("aria-label", cdName(f)+(f.taco ? (f.key.indexOf("wild")===0 ? ", spicy taco" : ", mild taco") : "")+". Drag onto a plate, or press to pick it up and then choose a plate.");
  b.title=cdName(f);
}
function cdPick(key){
  CD.picked=key;
  document.body.classList.toggle("cd-picking", !!key);
  Array.prototype.forEach.call(document.querySelectorAll("#cdHots .cd-food"), function(b){
    var on=b.getAttribute("data-food")===key; b.classList.toggle("picked", on); cdFoodLabel(b, cdFood(b.getAttribute("data-food")));
  });
  if(key){ cdSfx("pick"); announce(cdName(cdFood(key))+" picked up. Choose a plate to put it on; Escape to put it back."); }
  cdHintSync();
  cdRenderTable();   // food on the plates now serves (or takes back): their labels follow
}
function cdHintSync(){
  var h=$("cdHint"); if(!h) return;
  var f=CD.picked ? cdFood(CD.picked) : null;
  h.textContent = f ? "Holding "+cdName(f)+": click a plate to serve it (Esc to put it back)"
                    : (CD.people.length ? "Drag food from the counter onto a plate · or click a food, then a plate · click food on a plate to take one back"
                                        : "Seat someone first, then plate up their order");
}

/* ---- dragging (pointer events, so mouse, pen and touch all work) ---- */
function cdPointerDown(e, key, fromPid, srcEl){
  if(e.pointerType==="mouse" && e.button!==0) return;
  CD.drag={key:key, from:fromPid, el:srcEl, x0:e.clientX, y0:e.clientY, id:e.pointerId, on:false, over:null};
  try{ srcEl.setPointerCapture(e.pointerId); }catch(_){}
  srcEl.addEventListener("pointermove", cdPointerMove);
  srcEl.addEventListener("pointerup", cdPointerUp);
  srcEl.addEventListener("pointercancel", cdPointerUp);
}
function cdPointerMove(e){
  var d=CD.drag; if(!d || e.pointerId!==d.id) return;
  if(!d.on){
    if(Math.abs(e.clientX-d.x0)+Math.abs(e.clientY-d.y0)<6) return;
    d.on=true;
    var g=$("cdGhost"), f=cdFood(d.key);
    if(g && f){ g.src=pxURL(f.sprite); g.classList.remove("hidden"); }
    document.body.classList.add("cd-dragging");
    cdTag(null); cdSfx("pick");
  }
  e.preventDefault();
  var gh=$("cdGhost"); if(gh){ gh.style.left=(e.clientX-32)+"px"; gh.style.top=(e.clientY-40)+"px"; }
  var n=document.elementFromPoint(e.clientX, e.clientY), plate=(n && n.closest) ? n.closest(".cd-plate") : null;
  var over=plate ? plate.getAttribute("data-pid") : null;
  if(over!==d.over){ cdHover(d.over, false); d.over=over; cdHover(over, true); }
}
function cdPointerUp(e){
  var d=CD.drag; if(!d || e.pointerId!==d.id) return;
  CD.drag=null;
  d.el.removeEventListener("pointermove", cdPointerMove);
  d.el.removeEventListener("pointerup", cdPointerUp);
  d.el.removeEventListener("pointercancel", cdPointerUp);
  if(!d.on) return;   // a plain click: the click handler takes it
  CD.justDragged=true; setTimeout(function(){ CD.justDragged=false; }, 0);
  cdHover(d.over, false);
  var g=$("cdGhost"); if(g) g.classList.add("hidden");
  document.body.classList.remove("cd-dragging");
  if(e.type==="pointercancel") return;
  if(d.over && d.over!==d.from){
    if(cdAdd(d.over, d.key) && d.from) cdTake(d.from, d.key, true);
  } else if(!d.over && d.from) cdTake(d.from, d.key);
}
function cdHover(pid, on){
  if(!pid) return;
  var p=document.querySelector('.cd-plate[data-pid="'+pid+'"]'); if(p) p.classList.toggle("over", on);
}

/* ---- plates ---- */
function cdAdd(pid, key){
  var p=cdPerson(pid), f=cdFood(key); if(!p || !f) return false;
  var cap=f.taco ? CD_MAX_TACO : CD_MAX_ITEM, n=cdCount(p, key);
  if(n>=cap){ cdSfx("bonk"); announce(cdLabel(p)+" can’t fit more than "+cap+" "+cdName(f)+"."); return false; }
  if(f.taco) p.tacos[key]=n+1; else p.items[key]=n+1;
  CD.paid=false;
  cdSave(); cdRenderTable(pid, key); cdRenderReceipt();
  cdSfx("drop");
  announce(cdName(f)+" for "+cdLabel(p)+". "+cdPlateSummary(p)+".");
  return true;
}
function cdTake(pid, key, moving){
  var p=cdPerson(pid), f=cdFood(key); if(!p || !f) return;
  var n=cdCount(p, key); if(n<=0) return;
  if(f.taco) p.tacos[key]=n-1; else if(n-1>0) p.items[key]=n-1; else delete p.items[key];
  cdSave(); cdRenderTable(); cdRenderReceipt();
  if(!moving){ cdSfx("remove"); announce("Took one "+cdName(f)+" back from "+cdLabel(p)+". "+cdPlateSummary(p)+"."); }
}
function cdPlateSummary(p){
  var parts=[];
  CD_FOODS.forEach(function(f){ var n=cdCount(p, f.key); if(n) parts.push(n+" "+cdName(f)); });
  return parts.length ? parts.join(", ") : "an empty plate";
}
function cdSeat(raw){
  var who=cdWho(raw), msg=$("cdSeatMsg");
  var say=function(t){ if(msg){ msg.textContent=t; msg.classList.toggle("hidden", !t); } if(t){ cdSfx("bonk"); announce(t); } };
  if(!who){ say("Type a name, or @ and pick someone on the Arena."); return false; }
  if(who.handle && CD_ROSTER.ok && !cdRosterFind(who.handle)){ say("No Arena account called @"+who.handle+". Pick someone from the list, or seat them by name."); return false; }
  if(CD.people.length>=CD_MAX_PEOPLE){ say("The table seats "+CD_MAX_PEOPLE+"."); return false; }
  if(CD.people.some(function(p){ return p.who.key===who.key; })){ say(cdWhoLabel(who)+" already has a seat."); return false; }
  say("");
  var p=cdNewPerson(who); CD.people.push(p); CD.paid=false;
  cdSave(); cdRenderTable(p.id); cdRenderReceipt(); cdHintSync();
  cdSfx("seat"); announce(cdWhoLabel(who)+" sat down. Their plate is ready.");
  return true;
}
function cdUnseat(pid){
  var p=cdPerson(pid); if(!p) return;
  CD.people=CD.people.filter(function(x){ return x.id!==pid; });
  cdSave(); cdRenderTable(); cdRenderReceipt(); cdHintSync();
  cdSfx("remove"); announce(cdLabel(p)+" left the table.");
  var inp=$("cdSeatName"); if(inp) focusQuiet(inp);
}
function cdRenderTable(popPid, popKey){
  var box=$("cdTable"); if(!box) return;
  var fa=document.activeElement, keep=null;
  if(fa && box.contains(fa)) keep={pid:(fa.closest(".cd-plate")||{getAttribute:function(){ return null; }}).getAttribute("data-pid"), food:fa.getAttribute("data-food"), cls:fa.className};
  box.innerHTML="";
  if(!CD.people.length){
    var e=el("p","cd-empty"); e.textContent="The table’s empty. Seat yourself and your friends below."; box.appendChild(e);
  }
  var champ=CD.people.reduce(function(best, p){ var n=cdTacos(p)+cdItems(p); return n>best.n ? {id:p.id, n:n} : best; }, {id:null, n:0});
  CD.people.forEach(function(p, idx){
    var plate=el("div","cd-plate"); plate.setAttribute("data-pid", p.id);
    plate.setAttribute("role","group"); plate.setAttribute("aria-label", cdLabel(p)+"’s plate");
    var card=el("div","cd-card"), ts=cdTagState(p), rr=p.who.handle ? cdRosterFind(p.who.handle) : null;
    if(rr && rr.av){ var pav=el("img","cd-pav"); pav.alt=""; pav.loading="lazy"; pav.src=rr.av; card.appendChild(pav); }
    var nm=el("button","cd-name"); nm.type="button"; nm.textContent=cdLabel(p);
    nm.setAttribute("aria-label", cdLabel(p)+(ts==="ok" ? ", tagged as @"+p.who.handle : ts==="unknown" ? ", tagged as @"+p.who.handle+" but there’s no such Arena account" : "")+". Press to tag them on the Arena.");
    nm.addEventListener("click", function(){ cdTagOpen(p.id, nm); });
    card.appendChild(nm);
    if(champ.id===p.id && champ.n>0 && CD.people.length>1){ var cr=el("img","cd-crown"); cr.alt=""; cr.title="Hungriest at the table"; cr.src=pxURL("cd_crown"); card.appendChild(cr); }
    var x=el("button","cd-unseat"); x.type="button"; x.textContent="×"; x.setAttribute("aria-label","Unseat "+cdLabel(p));
    x.addEventListener("click", function(){ cdUnseat(p.id); }); card.appendChild(x);
    plate.appendChild(card);
    var tl=el("div","cd-tagline");
    if(p.who.handle){
      var hs=el("span","cd-handle"+(ts==="unknown" ? " bad" : "")); hs.textContent="@"+p.who.handle+(ts==="unknown" ? " · NOT ON ARENA" : "");
      hs.title = ts==="unknown" ? "No Arena account called @"+p.who.handle+": click the name to pick the right one" : "Tied to @"+p.who.handle+"’s Arena account";
      tl.appendChild(hs);
    } else {
      var tg=el("button","cd-tagadd"); tg.type="button"; tg.textContent="+ TAG ON ARENA"; tg.setAttribute("aria-label","Tag "+cdLabel(p)+" on the Arena");
      tg.addEventListener("click", function(){ cdTagOpen(p.id, tg); }); tl.appendChild(tg);
    }
    plate.appendChild(tl);
    var dish=el("div","cd-dish");
    var surf=el("button","cd-surface"); surf.type="button";
    surf.setAttribute("aria-label", cdLabel(p)+"’s plate: "+cdPlateSummary(p)+". Press to serve the food you’re holding.");
    var pim=el("img","cd-plate-img"); pim.alt=""; pim.draggable=false; pim.src=pxURL("cd_plate"); surf.appendChild(pim);
    surf.addEventListener("click", function(){
      if(CD.justDragged) return;
      if(!CD.picked){ cdSfx("bonk"); announce("Pick a food from the counter first."); plate.classList.remove("nudge"); void plate.offsetWidth; plate.classList.add("nudge"); return; }
      cdAdd(p.id, CD.picked);
    });
    dish.appendChild(surf);
    var on=el("div","cd-on");
    CD_FOODS.forEach(function(f){
      var n=cdCount(p, f.key); if(!n) return;
      var chip=el("button","cd-chip"); chip.type="button"; chip.setAttribute("data-food", f.key);
      var ci=el("img"); ci.alt=""; ci.draggable=false; ci.width=40; ci.height=40; ci.src=pxURL(f.sprite); chip.appendChild(ci);
      if(n>1){ var b=el("span","cd-n"); b.setAttribute("aria-hidden","true"); b.textContent="×"+n; chip.appendChild(b); }
      chip.setAttribute("aria-label", n+" "+cdName(f)+" on "+cdLabel(p)+"’s plate. "+(CD.picked ? "Press to serve the food you’re holding." : "Press to take one back."));
      chip.addEventListener("pointerdown", function(e){ cdPointerDown(e, f.key, p.id, chip); });
      // While you're holding food, the whole plate serves it, the food already on it included.
      chip.addEventListener("click", function(){ if(CD.justDragged) return; if(CD.picked) cdAdd(p.id, CD.picked); else cdTake(p.id, f.key); });
      if(popPid===p.id && popKey===f.key && !calmMode()) chip.classList.add("pop");
      on.appendChild(chip);
    });
    dish.appendChild(on);
    plate.appendChild(dish);
    var sum=el("div","cd-sum"), t=cdTacos(p), it=cdItems(p);
    sum.textContent = t+" taco"+(t===1?"":"s")+(it ? " · "+it+" other" : "");
    plate.appendChild(sum);
    if(popPid===p.id && !popKey && !calmMode()) plate.classList.add("arrive");
    box.appendChild(plate);
  });
  if(keep && keep.pid){
    var pl=box.querySelector('.cd-plate[data-pid="'+keep.pid+'"]'), t2=null;
    if(pl) t2=(keep.food && pl.querySelector('.cd-chip[data-food="'+keep.food+'"]')) || pl.querySelector(".cd-surface");
    if(t2) focusQuiet(t2);
  }
}

/* ---- the receipt ---- */
function cdRenderReceipt(){
  var box=$("cdReceipt"); if(!box) return;
  var lines=[], people=CD.people, tt=0, items=0;
  function line(l, r, cls){ lines.push([l, r==null ? "" : String(r), cls||""]); }
  var d=$("cdDate") && $("cdDate").value ? new Date($("cdDate").value+"T12:00:00") : new Date();
  line("CALI TUESDAYS", null, "c big"); line(d.toDateString().toUpperCase(), null, "c");
  line("-", null, "rule");
  people.forEach(function(p){
    line(cdLabel(p).toUpperCase(), null, "who");
    var any=false;
    CD_FOODS.forEach(function(f){ var n=cdCount(p, f.key); if(!n) return; any=true; line("  "+n+" × "+cdName(f).toUpperCase(), null, f.taco ? "taco" : ""); });
    if(!any) line("  (JUST VIBES)", null, "dim");
    tt+=cdTacos(p); items+=cdItems(p);
  });
  if(!people.length) line("NOBODY SEATED YET", null, "dim c");
  line("-", null, "rule");
  var paid=caliPaid(tt), n=people.length;
  line("TACOS (TT)", tt); line("PAY FOR", paid); line("FREE (B1G1)", tt-paid, tt-paid ? "free" : "");
  line("PEOPLE", n); line("TPP", n ? (Math.round(tt/n*100)/100).toFixed(2) : "0.00");
  if(items) line("OTHER DISHES", items);
  line("-", null, "rule");
  if(CD.menuOk===false && items) line("THIS ARENA SAVES TACOS ONLY FOR NOW", null, "dim c");
  line(CD.paid ? "*** PAID · ¡GRACIAS! ***" : "THANK YOU · ¡GRACIAS!", null, "c"+(CD.paid ? " paidl" : ""));
  box.innerHTML="";
  lines.forEach(function(l){
    var row=el("div","cd-rl"+(l[2] ? " "+l[2] : ""));
    if(l[2].indexOf("rule")>=0){ row.setAttribute("aria-hidden","true"); box.appendChild(row); return; }
    var a=el("span"); a.textContent=l[0]; row.appendChild(a);
    if(l[1]!==""){ var b=el("span","cd-rv"); b.textContent=l[1]; row.appendChild(b); }
    box.appendChild(row);
  });
  box.classList.toggle("paid", CD.paid);
  var co=$("cdCheckout"); if(co){ co.disabled=CD.busy || !people.length; co.textContent=CD.busy ? "RINGING UP…" : "CHECKOUT"; }
}

/* ---- checkout: log the dinner on the Arena ---- */
function cdSay(text, kind){
  var m=$("cdMsg"); if(!m) return;
  m.textContent=text||""; m.classList.toggle("hidden", !text); m.classList.toggle("err", kind==="err");
  if(text) announce(text);
}
function cdCheckout(){
  if(CD.busy) return;
  if(!CD.people.length){ cdSay("Seat at least one person first.", "err"); cdSfx("bonk"); return; }
  if(!ARENA.paired){ cdSay("Connect the Arena to log dinners on the board.", "err"); cdSfx("bonk"); return; }
  var bad=CD.people.filter(function(p){ return cdTagState(p)==="unknown"; });
  if(bad.length){ cdSay("@"+bad[0].who.handle+" isn’t on the Arena. Click "+cdLabel(bad[0])+"’s name to pick the right account, or untag them.", "err"); cdSfx("bonk"); return; }
  var sendItems=CD.menuOk===true, dropped=0;
  var diners=CD.people.map(function(p){
    var d={tacos:{mildHard:p.tacos.mildHard|0, mildSoft:p.tacos.mildSoft|0, wildHard:p.tacos.wildHard|0, wildSoft:p.tacos.wildSoft|0}};
    if(p.who.handle) d.handle=p.who.handle; else d.name=p.who.name;
    var it={}, any=false; for(var k in p.items){ if((p.items[k]|0)>0){ it[k]=p.items[k]|0; any=true; } }
    if(any){ if(sendItems) d.items=it; else dropped+=cdItems(p); }
    return d;
  });
  var body={diners:diners, note:(($("cdNote")||{}).value||"").trim().slice(0,80)};
  var when=(($("cdDate")||{}).value||"").trim(); if(when) body.date=when;
  // One id per dinner, reused for every retry: the server replays it instead of logging Tuesday twice.
  if(!CD.rid) CD.rid=newRequestId();
  body.requestId=CD.rid;
  CD.busy=true; cdRenderReceipt(); cdSay("");
  var before=CD.board;
  arenaPost("/api/arena/cali/order", body).then(function(res){
    CD.busy=false;
    if(!res.ok){
      if(pantryLocalReject(res)) cdSay(CALI_RELOAD_MSG, "err");
      else if(pantryMissState(res)==="restart") cdSay(CALI_RESTART_MSG, "err");
      else if(pantryMissState(res)==="unsupported") cdSay(CALI_UNSUPPORTED_MSG, "err");
      else cdSay((res.j && (res.j.error || res.j.detail) && String(res.j.error || res.j.detail).slice(0,200)) || "Couldn’t log that dinner.", "err");
      cdSfx("bonk"); cdRenderReceipt(); return;
    }
    var o=(res.j && res.j.order) || {};
    CD.rid=null; CD.paid=true;
    cdSfx("kaching"); confettiBurst();
    var msg=res.j.replayed ? "Already logged: "+(o.totalTacos|0)+" tacos." :
      "🌮 Logged! "+(o.totalTacos|0)+" tacos, paid for "+(o.paidTacos|0)+", "+(o.freeTacos|0)+" free."+(dropped ? " (Other dishes aren’t saved by this Arena yet.)" : "");
    toast(msg, "level"); cdSay(msg);
    // clear the plates, keep everyone seated for next Tuesday
    CD.people.forEach(function(p){ p.tacos={mildHard:0, mildSoft:0, wildHard:0, wildSoft:0}; p.items={}; });
    cdSave(); cdRenderTable(); cdRenderReceipt();
    CD.prevRows=before ? before.entries || [] : null;
    cdLoadBoard(true);
  }, function(){
    CD.busy=false; cdRenderReceipt();
    cdSay("Couldn’t reach the Arena. Try again: it won’t be logged twice.", "err"); cdSfx("bonk");
  });
}

/* ---- the hi-score board ---- */
var CD_ORD = ["1ST","2ND","3RD"];
function cdOrd(n){ return n<=3 ? CD_ORD[n-1] : n+"TH"; }
function cdSeasonLine(b){
  var now=new Date(), next=Date.UTC(now.getUTCFullYear(), now.getUTCMonth()+1, 1), days=Math.max(1, Math.ceil((next-now.getTime())/86400000));
  var mon=SV_MONTHS[now.getUTCMonth()]+" "+now.getUTCFullYear();
  if(CD.window==="season") return "SEASON "+mon+" · NEW SEASON IN "+days+" DAY"+(days===1?"":"S");
  if(b && b.startsOn) return String(b.startsOn)+" → "+String(b.endsOn);
  return "";
}
function cdLoadBoard(afterCheckout){
  var rows=$("cdRows"); if(!rows) return;
  var win=CD.window;
  fetch("/api/arena/cali/board?window="+encodeURIComponent(win), {cache:"no-store"})
    .then(function(r){ return r.json().then(function(j){ return {ok:r.ok, status:r.status, j:j}; }, function(){ return {ok:r.ok, status:r.status, j:{}}; }); })
    .then(function(res){
      if(win!==CD.window) return;
      var b=res.j||{};
      var miss=pantryMissState(res);
      if(miss==="restart") return cdBoardNote(CALI_RESTART_MSG);
      if(miss==="unsupported") return cdBoardNote(CALI_UNSUPPORTED_MSG);
      if(res.status===400 && /not paired/i.test(String(b.error||""))) return cdBoardNote("Connect the Arena to see the hi-scores.");
      if(!res.ok || b.error || b.detail) return cdBoardNote(String(b.error || b.detail || "Couldn’t load the board.").slice(0,200));
      CD.board=b;
      if(Array.isArray(b.menu)){
        CD.menuOk=true; CD.menuNames={};
        b.menu.forEach(function(m){ if(m && typeof m.kind==="string" && typeof m.name==="string" && cdFood(m.kind)) CD.menuNames[m.kind]=m.name.slice(0,40); });
      } else CD.menuOk=false;
      cdRenderBoard(b, afterCheckout);
      cdRenderReceipt();
    }, function(){ cdBoardNote("Couldn’t reach the Arena."); });
  if(win==="season") cdLoadChamp();
}
function cdBoardNote(text){
  var rows=$("cdRows"); if(!rows) return;
  rows.innerHTML='<tr><td colspan="11" class="cd-note"></td></tr>';
  rows.querySelector("td").textContent=text;
  var s=$("cdSeason"); if(s) s.textContent=cdSeasonLine(null);
}
function cdRenderBoard(b, afterCheckout){
  var rows=$("cdRows"), s=$("cdSeason"); if(!rows) return;
  if(s) s.textContent=cdSeasonLine(b);
  var tbl=$("cdTbl"); if(tbl) tbl.classList.toggle("noitems", CD.menuOk!==true);
  var st=$("cdStats");
  if(st) st.textContent = (b.orders|0) ? ((b.orders|0)+" dinner"+((b.orders|0)===1?"":"s")+" · "+(b.totalTacos|0)+" tacos · "+(b.freeTacos|0)+" free"+(b.totalItems ? " · "+(b.totalItems|0)+" other dishes" : "")) : "";
  var list=Array.isArray(b.entries) ? b.entries : [];
  if(!list.length) return cdBoardNote(CD.window==="season" ? "No tacos this season yet. Be the first on the board!" : "No taco Tuesdays logged in this range yet.");
  var prev={}; (CD.prevRows||[]).forEach(function(e){ prev[(e.handle ? "@"+e.handle : "#"+e.name)]=e; });
  rows.innerHTML="";
  var newOnes=0;
  list.forEach(function(e){
    var tr=el("tr"); if(e.isYou) tr.className="you";
    var key=e.handle ? "@"+e.handle : "#"+e.name, was=prev[key];
    var fresh=afterCheckout && CD.prevRows && (!was || (was.tuesdays|0)!==(e.tuesdays|0) || (was.totalTacos|0)!==(e.totalTacos|0) || (was.items|0)!==(e.items|0));
    var rk=el("td","cd-rk r"+Math.min(4, e.rank|0)); rk.textContent=cdOrd(e.rank|0); tr.appendChild(rk);
    var who=el("td","cd-who"), wrap=el("div","cd-whowrap");
    if(e.avatarUrl && /^https:\/\//.test(e.avatarUrl)){ var av=el("img","cd-av"); av.alt=""; av.loading="lazy"; av.src=e.avatarUrl; wrap.appendChild(av); }
    var nm=el("span","cd-pname"); nm.textContent=String(e.name||e.handle||"?").toUpperCase(); wrap.appendChild(nm);
    if(e.handle){ var h=el("small"); h.textContent="@"+e.handle; wrap.appendChild(h); }
    if(fresh){ var nw=el("span","cd-new"); nw.textContent="NEW!"; wrap.appendChild(nw); newOnes++; }
    who.appendChild(wrap); tr.appendChild(who);
    [e.tuesdays|0, e.totalTacos|0, Number(e.tacosPerPerson||0).toFixed(2), e.mild|0, e.wild|0, e.hard|0, e.soft|0].forEach(function(v, i){
      var td=el("td", i<3 ? "cd-num" : "cd-num cd-mini"); td.textContent=String(v); tr.appendChild(td);
    });
    var itd=el("td","cd-num cd-it"); itd.textContent=String(e.items|0); tr.appendChild(itd);
    var fav=el("td","cd-fav"), ff=cdFood(e.favorite);
    if(ff){ var fi=el("img"); fi.alt=cdName(ff); fi.title="Favorite: "+cdName(ff); fi.width=32; fi.height=32; fi.src=pxURL(ff.sprite); fav.appendChild(fi); }
    tr.appendChild(fav);
    rows.appendChild(tr);
  });
  if(afterCheckout && newOnes){ cdSfx("fanfare"); announce("The hi-score board updated."); }
  CD.prevRows=null;
}
// Last season's winner, from the server's "lastseason" window (an older Arena 400s: no banner).
function cdLoadChamp(){
  var box=$("cdChamp"); if(!box) return;
  fetch("/api/arena/cali/board?window=lastseason", {cache:"no-store"})
    .then(function(r){ return r.ok ? r.json() : null; })
    .then(function(b){
      var top=b && Array.isArray(b.entries) ? b.entries[0] : null;
      box.classList.toggle("hidden", !top);
      if(!top) return;
      box.innerHTML="";
      var cr=el("img"); cr.alt=""; cr.width=36; cr.height=21; cr.src=pxURL("cd_crown"); box.appendChild(cr);
      var t=el("span"); t.textContent="LAST SEASON’S CHAMP: "+String(top.name||top.handle||"?").toUpperCase()+" · "+(top.tuesdays|0)+" TUESDAY"+((top.tuesdays|0)===1?"":"S")+" · "+(top.totalTacos|0)+" TACOS";
      box.appendChild(t);
    }, function(){ box.classList.add("hidden"); });
}

/* ---- building, opening and leaving the view ---- */
function cdBuild(){
  if(CD.built) return;
  CD.built=true;
  CD.sfx=lsGet("hq_cali_sfx")!=="0";
  cdLoadSaved();
  cdBuildCounter();
  var f=$("cdSeatForm");
  if(f) f.addEventListener("submit", function(e){ e.preventDefault(); var i=$("cdSeatName"); if(cdSeat(i.value)){ i.value=""; } cdSuggClose(); i.focus(); });
  var co=$("cdCheckout"); if(co) co.addEventListener("click", cdCheckout);
  var si=$("cdSeatName");
  if(si){
    si.addEventListener("input", function(){ var sm=$("cdSeatMsg"); if(sm && !sm.classList.contains("hidden")){ sm.textContent=""; sm.classList.add("hidden"); } cdSuggest(); });
    si.addEventListener("focus", function(){ cdRosterLoad(); if(si.value.trim()) cdSuggest(); });
    si.addEventListener("keydown", function(e){
      var sg=CD.sugg; if(!sg) return;
      if(e.key==="ArrowDown" && sg.list.length){ e.preventDefault(); cdSuggMove(1); }
      else if(e.key==="ArrowUp" && sg.list.length){ e.preventDefault(); cdSuggMove(-1); }
      else if(e.key==="Enter" && sg.active>=0){ e.preventDefault(); cdSuggPick(sg.active); }
      else if(e.key==="Escape"){ e.preventDefault(); e.stopPropagation(); cdSuggClose(); }
    });
    si.addEventListener("blur", function(){ setTimeout(cdSuggClose, 150); });
  }
  document.addEventListener("mousedown", function(e){
    var tp=$("cdTagPop"); if(!tp || tp.contains(e.target)) return;
    if(CD.tagFor && CD.tagFor.anchor && CD.tagFor.anchor.contains(e.target)) return;
    cdTagClose(false);
  }, true);
  window.addEventListener("scroll", function(e){ var tp=$("cdTagPop"); if(tp && !(e.target && e.target.nodeType===1 && tp.contains(e.target))) cdTagClose(false); }, true);
  window.addEventListener("resize", function(){ cdTagClose(false); });
  var dt=$("cdDate"); if(dt) dt.addEventListener("change", cdRenderReceipt);
  var m=$("cdMute"); if(m) m.addEventListener("click", function(){ CD.sfx=!CD.sfx; lsSet("hq_cali_sfx", CD.sfx ? "1" : "0"); cdMuteSync(); announce(CD.sfx ? "Diner sounds on" : "Diner sounds off"); });
  Array.prototype.forEach.call(document.querySelectorAll("#cdWins .cd-win"), function(b){
    b.addEventListener("click", function(){
      CD.window=b.getAttribute("data-window");
      Array.prototype.forEach.call(document.querySelectorAll("#cdWins .cd-win"), function(o){ var on=o===b; o.classList.toggle("on", on); o.setAttribute("aria-pressed", on ? "true" : "false"); });
      var ch=$("cdChamp"); if(ch && CD.window!=="season") ch.classList.add("hidden");
      cdLoadBoard(false);
    });
  });
  document.addEventListener("keydown", function(e){
    if(VIEW!=="cali" || e.key!=="Escape" || !CD.picked) return;
    e.preventDefault(); e.stopPropagation(); cdPick(null); announce("Put it back on the counter.");
  }, true);
  if(window.ResizeObserver){ CD.ro=new ResizeObserver(function(){ if(VIEW==="cali") cdResize(); }); CD.ro.observe($("cdStageWrap")); }
  else window.addEventListener("resize", function(){ if(VIEW==="cali") cdResize(); });
  document.addEventListener("visibilitychange", function(){ if(VIEW!=="cali") return; if(document.hidden) cdAnimStop(); else cdAnimStart(); });
  cdMuteSync();
}
function cdEnter(){
  cdBuild();
  cdRosterLoad();
  // Whoever is logging the dinner is almost always at the table: seat them on an empty one.
  // ARENA.status is only loaded by the Arena view, so ask the local dashboard when it's missing.
  if(!CD.people.length){
    if(ARENA.status && ARENA.status.handle) cdSeat("@"+ARENA.status.handle);
    else fetch("/api/arena/status", {cache:"no-store"}).then(function(r){ return r.json(); }).then(function(st){
      if(st && typeof st.handle==="string" && st.handle){ CD.me=st; if(!CD.people.length && VIEW==="cali") cdSeat("@"+st.handle); }
    }, function(){});
  }
  cdResize(); cdRenderTable(); cdRenderReceipt(); cdHintSync();
  cdLoadBoard(false);
  cdAnimStart();
}
function cdLeave(){
  if(!CD.built) return;
  cdTagClose(false); cdSuggClose();
  cdAnimStop(); if(CD.picked) cdPick(null);
}



// monsterSVG(seed,typeHue,stage,shiny,px) -> a left-right symmetric pixel-monster
// on a 10x10 grid: decide cols 1..4 then mirror to 5..8, blobby toward center,
// always a face; stage morphs egg->hatchling->…->elder(+crown/glow).
