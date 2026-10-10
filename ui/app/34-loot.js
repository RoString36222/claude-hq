/* ================= HQ 2.5: loot from real work ================= */
// A merged PR, a green test run or a long focus session drops a chest on the Arena. Your HQ notices the
// work on this machine (ext_loot.py) and sends only the event TYPE, a small count and the UTC day; a
// chest opens once into Poke Coins, a cosmetic only chests (or prestige) give, or a Pokémon card.
// Everything here is DOM built with textContent, except the card art, which is pokeImgFor()/monsterSVG()
// output (both esc() what they take); every data-derived value placed in innerHTML goes through esc().
var LOOT = {data:null, at:0, code:0, busy:false, status:null, pollT:null};
var LOOT_SRC = {pr_merged:{icon:"🔀", name:"Merged PR"}, tests_green:{icon:"✅", name:"Green test run"},
  focus_long:{icon:"🎯", name:"Long focus session"}};
var LOOT_RARITY = {common:"Common", rare:"Rare", epic:"Epic"};
var LOOT_COS_NAMES = {"k-prism":"Prism paint", "r-shadow":"Shadow runner", "g-plasma":"Plasma blaster",
  "b-pokeball":"Poké Ball", "f-holo":"Holo frame"};
// The base dex of each evolution line, in pokedata order: a card's spec (global contract §10) is
// {sp: the line's index, st:0, br:0, mg:0, sh: holo}. Kept here so the binder works outside the Valley.
var LOOT_LINES = [172,4,7,1,133,92,446,147,447,280,155,158,152,403,129,318,37,174,54,443,246,58,633,150,123,95,
  175,359,304,13,333,459,16,63,214,322,610,79,309,179,115,142,228,252,255,258,371,374];

function lootCalm(){
  if(typeof hqCalm==="function") return hqCalm();
  return document.documentElement.classList.contains("hq-calm") ||
    !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
}
function lootFetch(path, opts){
  return fetch(path, opts||{cache:"no-store"}).then(function(r){
    return r.json().then(function(j){ return {ok:r.ok, code:r.status, j:j||{}}; }, function(){ return {ok:false, code:r.status, j:{}}; });
  });
}
function lootPaired(){ return typeof ARENA!=="undefined" && ARENA && !!ARENA.paired; }
// One GET at a time, cached for a few seconds so an inventory re-render doesn't re-ask the Arena.
function lootLoad(force){
  if(!lootPaired()) return Promise.resolve({ok:false, code:400, j:{error:"not paired"}});
  if(!force && LOOT.data && Date.now()-LOOT.at < 15000) return Promise.resolve({ok:true, code:200, j:LOOT.data});
  return lootFetch("/api/arena/loot").then(function(res){
    LOOT.code=res.code;
    if(res.ok){ LOOT.data=res.j; LOOT.at=Date.now(); lootSeen(res.j); }
    return res;
  }, function(){ return {ok:false, code:0, j:{}}; });
}
function lootStatus(){
  return lootFetch("/api/loot/status").then(function(r){ if(r.ok) LOOT.status=r.j; return LOOT.status; }, function(){ return null; });
}
// A card id ("p025" / "h633") -> {dex, holo, line, name}.
function lootCard(id){
  var m=/^([ph])(\d{3})$/.exec(String(id||"")); if(!m) return null;
  var dex=parseInt(m[2],10), line=LOOT_LINES.indexOf(dex);
  var name=(typeof DEX_NAMES!=="undefined" && DEX_NAMES[dex]) || ("#"+dex);
  return {dex:dex, holo:m[1]==="h", line:line<0?0:line, name:name,
    spec:{sp:line<0?0:line, st:0, br:0, mg:0, sh:m[1]==="h"?1:0}};
}
window.lootCardSpec = function(id){ var c=lootCard(id); return c ? c.spec : null; };
// Card art: the hotlinked sprite with its onerror chain down to the generated monster, or the generated
// monster outright when the pack isn't a Pokémon one (or offline: pokeErr lands there too).
function lootArt(c, px){
  var cr={species:c.line, stage:0, shiny:c.holo?1:0, _noFloor:true};
  if(typeof isPokePack==="function" && isPokePack() && typeof pokeImgFor==="function") return pokeImgFor(c.dex, cr, px, c.name);
  if(typeof monsterSVG==="function") return monsterSVG(hashStr("card:"+c.dex), (c.dex*47)%360, 0, c.holo?1:0, px);
  return "";
}
function lootRewardText(rw){
  rw=rw||{};
  if(rw.kind==="coins") return "🪙 "+(rw.qty|0)+" Poke Coins";
  if(rw.kind==="cosmetic") return "✨ "+(LOOT_COS_NAMES[rw.id]||String(rw.id||"a cosmetic"))+" (wear it from your Inventory)";
  if(rw.kind==="card"){
    var c=lootCard(rw.id);
    return c ? "🃏 "+c.name+" card"+(c.holo?" (holo)":"") : "🃏 Your binder is full: no room for another card";
  }
  return "Something shiny";
}

// ---- the Chests and Cards sections (the Inventory, and lootOpen()) ----
function lootSec(body, title, cls){
  var s=document.createElement("section"); s.className="inv-sec loot-sec"+(cls?" "+cls:"");
  var h=document.createElement("h4"); h.textContent=title; s.appendChild(h);
  var box=document.createElement("div"); box.className="inv-box"; s.appendChild(box);
  body.appendChild(s); return box;
}
function lootNote(box, text){ box.textContent=""; var p=document.createElement("p"); p.className="muted"; p.textContent=text; box.appendChild(p); }
function lootSections(body, inv){
  if(!body) return;
  var chests=lootSec(body, "Chests", "loot-chests"), cards=lootSec(body, "Cards", "loot-cards");
  if(!lootPaired()){
    lootNote(chests, "Pair with an Arena (Arena tab) to earn chests from your real work.");
    lootNote(cards, "Cards come out of chests.");
    return;
  }
  lootNote(chests, "Loading your chests…"); lootNote(cards, "");
  lootLoad(false).then(function(res){
    if(!res.ok){
      lootNote(chests, res.code===404 ? "This Arena doesn't drop loot yet: ask its owner to update it." : "The Arena didn't answer. Try again in a bit.");
      lootNote(cards, "");
      return;
    }
    lootFillChests(chests, res.j);
    lootFillCards(cards, res.j.cards||{});
  });
}
function lootFillChests(box, d){
  box.textContent=""; box.classList.add("loot-grid");
  var how=document.createElement("p"); how.className="muted loot-how"; box.appendChild(how);
  how.textContent="Chests drop from real work: a merged PR, a green test run, a long focus session.";
  lootStatus().then(function(st){
    if(!st) return;
    if(!st.enabled) how.textContent="Chests drop from real work: a merged PR, a green test run, a long focus session. Turn on Work signals in Settings: only the kind of event and a count per day are sent.";
    else {
      var n=0; Object.keys(st.pending||{}).forEach(function(k){ n+=(st.pending[k]|0); });
      how.textContent="Watching for real work"+(st.prs?", merged PRs included":"")+"."+(n ? " "+n+" waiting to report (every 30 min)." : "");
    }
  });
  var list=(d && d.chests) || [];
  if(!list.length){
    var e=document.createElement("p"); e.className="muted"; e.textContent="No chests waiting."; box.appendChild(e);
  }
  list.slice(0, 60).forEach(function(ch){
    var src=LOOT_SRC[ch.source]||{icon:"🎁", name:"Work"}, rar=LOOT_RARITY[ch.rarity] ? ch.rarity : "common";
    var b=document.createElement("button"); b.type="button"; b.className="loot-chest r-"+rar;
    var ic=document.createElement("span"); ic.className="loot-box"; ic.setAttribute("aria-hidden","true");
    var t=document.createElement("b"); t.textContent=LOOT_RARITY[rar]+" chest";
    var s=document.createElement("small"); s.className="muted"; s.textContent=src.icon+" "+src.name;
    b.appendChild(ic); b.appendChild(t); b.appendChild(s);
    b.setAttribute("aria-label", "Open the "+LOOT_RARITY[rar]+" chest from a "+src.name);
    b.addEventListener("click", function(){ lootOpenChest(ch, b); });
    box.appendChild(b);
  });
  var opened=(d && d.opened) || [];
  if(opened.length){
    var rec=document.createElement("details"); rec.className="loot-recent";
    var sm=document.createElement("summary"); sm.textContent="Recently opened"; rec.appendChild(sm);
    opened.slice(0, 8).forEach(function(o){
      var r=document.createElement("div"); r.className="loot-recent-row";
      r.textContent=(LOOT_RARITY[o.rarity]||"")+" · "+lootRewardText(o.reward);
      rec.appendChild(r);
    });
    box.appendChild(rec);
  }
}
function lootFillCards(box, cards){
  box.textContent="";
  var ids=Object.keys(cards||{}).filter(function(k){ return lootCard(k) && (cards[k]|0)>0; });
  if(!ids.length){ lootNote(box, "No cards yet: chests hold them."); return; }
  ids.sort(function(a,b){ var A=lootCard(a), B=lootCard(b); return (A.line-B.line) || (A.holo?1:0)-(B.holo?1:0); });
  box.classList.add("loot-binder");
  ids.forEach(function(id){
    var c=lootCard(id), q=cards[id]|0;
    var row=document.createElement("div"); row.className="loot-card"+(c.holo?" holo":"");
    var art=document.createElement("span"); art.className="loot-art"; art.setAttribute("aria-hidden","true");
    art.innerHTML=lootArt(c, 56);          // pokeImgFor/monsterSVG: sprite markup with esc()'d alt text
    var nm=document.createElement("b"); nm.textContent=c.name;
    var meta=document.createElement("small"); meta.className="muted"; meta.textContent=(c.holo?"Holo · ":"")+"×"+q;
    row.appendChild(art); row.appendChild(nm); row.appendChild(meta);
    if(typeof tradesOpen==="function"){
      var tb=document.createElement("button"); tb.type="button"; tb.className="hbtn ghost loot-trade"; tb.textContent="Trade…";
      tb.setAttribute("aria-label","Trade your "+c.name+" card");
      tb.addEventListener("click", function(){ try{ tradesOpen(); }catch(e){} });
      row.appendChild(tb);
    }
    box.appendChild(row);
  });
}

// ---- opening: POST, then the reveal (instant under Calm / reduced motion) ----
function lootRid(){
  var a=new Uint8Array(12); try{ crypto.getRandomValues(a); }catch(e){}
  var s=""; for(var i=0;i<a.length;i++) s+=("0"+a[i].toString(16)).slice(-2);
  return "open-"+s;   // an idempotency key, never shown: a retry of the same click replays its reward
}
function lootOpenChest(ch, btn){
  if(LOOT.busy || !ch || !/^ch-[0-9a-f]{32}$/.test(String(ch.id||""))) return;
  LOOT.busy=true; if(btn) btn.disabled=true;
  var rid=ch._rid || (ch._rid=lootRid());
  lootFetch("/api/arena/loot/open", {method:"POST", headers:{"Content-Type":"application/json","X-HQ-Token":CSRF},
    body:JSON.stringify({chestId:ch.id, requestId:rid})}).then(function(res){
    LOOT.busy=false;
    if(!res.ok){
      if(btn) btn.disabled=false;
      var why=res.j.error||res.j.detail||"That chest didn't open.";
      if(typeof invMsg==="function") invMsg("⚠ "+why);
      if(typeof toast==="function") toast("⚠ "+why);
      if(res.code===409){ LOOT.at=0; lootRefresh(); }
      return;
    }
    LOOT.at=0;
    lootReveal(ch, (res.j||{}).reward||{});
  }, function(){ LOOT.busy=false; if(btn) btn.disabled=false; if(typeof toast==="function") toast("⚠ The Arena didn't answer."); });
}
function lootRevealEl(){
  var w=$("lootReveal"); if(w) return w;
  w=document.createElement("div"); w.id="lootReveal"; w.className="tcard-back loot-reveal-back"; w.setAttribute("aria-hidden","true");
  var m=document.createElement("div"); m.className="tcard-modal loot-reveal"; m.setAttribute("role","dialog");
  m.setAttribute("aria-modal","true"); m.setAttribute("aria-labelledby","lootRevealTitle");
  var t=document.createElement("b"); t.id="lootRevealTitle"; t.className="loot-reveal-title";
  var stage=document.createElement("div"); stage.className="loot-stage"; stage.id="lootStage";
  var txt=document.createElement("p"); txt.className="loot-reveal-text"; txt.id="lootRevealText";
  var ok=document.createElement("button"); ok.type="button"; ok.className="hbtn"; ok.id="lootRevealOk"; ok.textContent="Nice!";
  ok.addEventListener("click", lootRevealClose);
  m.appendChild(t); m.appendChild(stage); m.appendChild(txt); m.appendChild(ok); w.appendChild(m);
  w.addEventListener("click", function(e){ if(e.target===w) lootRevealClose(); });
  w.addEventListener("keydown", function(e){
    if(e.key==="Escape"){ e.preventDefault(); e.stopPropagation(); lootRevealClose(); }
    else if(e.key==="Tab"){ e.preventDefault(); ok.focus(); }   // one control: keep focus in the dialog
  });
  document.body.appendChild(w); return w;
}
function lootReveal(ch, rw){
  var w=lootRevealEl(), rar=LOOT_RARITY[ch.rarity] ? ch.rarity : "common";
  var stage=$("lootStage"), txt=$("lootRevealText"), ttl=$("lootRevealTitle");
  ttl.textContent=LOOT_RARITY[rar]+" chest · "+((LOOT_SRC[ch.source]||{}).name||"Work");
  stage.className="loot-stage r-"+rar; stage.textContent=""; txt.textContent="";
  var box=document.createElement("span"); box.className="loot-box big"; box.setAttribute("aria-hidden","true"); stage.appendChild(box);
  w.classList.add("open"); w.setAttribute("aria-hidden","false");
  var ok=$("lootRevealOk"); ok.focus();
  var line=lootRewardText(rw);
  var show=function(){
    stage.textContent="";
    var prize=document.createElement("span"); prize.className="loot-prize"; prize.setAttribute("aria-hidden","true");
    if(rw.kind==="card" && lootCard(rw.id)){
      var c=lootCard(rw.id); prize.classList.add("card"); if(c.holo) prize.classList.add("holo");
      prize.innerHTML=lootArt(c, 96);     // sprite markup from pokeImgFor/monsterSVG (esc()'d inside)
    } else if(rw.kind==="cosmetic"){ prize.textContent="✨"; }
    else { prize.textContent="🪙"; }
    stage.appendChild(prize); txt.textContent=line;
    announce("Opened a "+LOOT_RARITY[rar].toLowerCase()+" chest: "+line);
  };
  if(lootCalm()) show();
  else { box.classList.add("shake"); setTimeout(function(){ if(w.classList.contains("open")) show(); }, 900); }
}
function lootRevealClose(){
  var w=$("lootReveal"); if(!w) return;
  w.classList.remove("open"); w.setAttribute("aria-hidden","true");
  lootRefresh();
}
// After an opening: the inventory (wallet, cosmetics, binder) and the standalone modal re-read.
function lootRefresh(){
  var inv=$("invBack");
  if(inv && inv.classList.contains("open") && typeof invLoad==="function"){ LOOT.at=0; invLoad(); }
  var lb=$("lootBack");
  if(lb && lb.classList.contains("open")) lootRenderModal();
}

// ---- lootOpen(): the standalone modal ----
function lootModalEl(){
  var w=$("lootBack"); if(w) return w;
  w=document.createElement("div"); w.id="lootBack"; w.className="tcard-back"; w.setAttribute("aria-hidden","true");
  var m=document.createElement("div"); m.className="tcard-modal inv-modal"; m.setAttribute("role","dialog");
  m.setAttribute("aria-modal","true"); m.setAttribute("aria-labelledby","lootTitle");
  var top=document.createElement("div"); top.className="tcard-top";
  var t=document.createElement("b"); t.id="lootTitle"; t.textContent="Loot";
  var x=document.createElement("button"); x.type="button"; x.className="hbtn icon ghost"; x.id="lootClose";
  x.setAttribute("aria-label","Close"); x.textContent="✕"; x.addEventListener("click", lootClose);
  top.appendChild(t); top.appendChild(x);
  var body=document.createElement("div"); body.id="lootBody";
  m.appendChild(top); m.appendChild(body); w.appendChild(m);
  w.addEventListener("click", function(e){ if(e.target===w) lootClose(); });
  w.addEventListener("keydown", function(e){
    var rv=$("lootReveal"); if(rv && rv.classList.contains("open")) return;
    if(e.key==="Escape"){ e.preventDefault(); lootClose(); }
  });
  document.body.appendChild(w); return w;
}
function lootRenderModal(){ var b=$("lootBody"); if(!b) return; b.textContent=""; lootSections(b, null); }
function lootOpen(){
  var w=lootModalEl(); w.classList.add("open"); w.setAttribute("aria-hidden","false");
  LOOT.at=0; lootRenderModal();
  var c=$("lootClose"); if(c) c.focus();
}
function lootClose(){ var w=$("lootBack"); if(w){ w.classList.remove("open"); w.setAttribute("aria-hidden","true"); } }
window.lootOpen = lootOpen;

// ---- new-chest toast: remember which chests you've been told about (this browser only) ----
function lootSeen(d){
  var ids=((d && d.chests) || []).map(function(c){ return String(c.id||""); });
  var seen=null;
  try{ seen=JSON.parse(localStorage.getItem("hq_loot_seen")||"null"); }catch(e){}
  try{ localStorage.setItem("hq_loot_seen", JSON.stringify(ids.slice(-200))); }catch(e){}
  if(!Array.isArray(seen)) return;          // first look on this browser: nothing is "new"
  var fresh=((d && d.chests) || []).filter(function(c){ return seen.indexOf(String(c.id||""))<0; });
  if(!fresh.length || typeof toast!=="function") return;
  var best=fresh.reduce(function(a,c){ return ({epic:3,rare:2}[c.rarity]||1) > ({epic:3,rare:2}[a.rarity]||1) ? c : a; }, fresh[0]);
  var src=(LOOT_SRC[best.source]||{name:"Your work"}).name;
  var msg = fresh.length===1 ? "🎁 New "+(LOOT_RARITY[best.rarity]||"").toLowerCase()+" chest from a "+src.toLowerCase()+". Open it from your Inventory."
    : "🎁 "+fresh.length+" new chests from your work. Open them from your Inventory.";
  toast(msg); announce(msg);
}
function lootPoll(){
  if(document.hidden || !lootPaired()) return;
  lootLoad(true);
}
(function(){
  setTimeout(lootPoll, 9000);
  LOOT.pollT=setInterval(lootPoll, 10*60*1000);
})();
