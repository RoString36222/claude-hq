/* ================= HQ 2.1: one inventory, one wallet, and cosmetics ================= */
// Everything you own in one place: Poke Coins (the one currency, kept on the Arena), snacks from the
// Store, your Valley finds (sell them at the market for coins) and cosmetics (buy with coins or unlock
// by level; equip one per slot, and everyone sees them in games and at your HQ).
var INV = {cos:null, pantry:null, busy:false};
window.HQ_MYCOS = window.HQ_MYCOS || {};       // slot -> value you wear, for practice games and your HQ
function invGet(path){ return fetch(path,{cache:"no-store"}).then(function(r){ return r.json().then(function(j){ return {ok:r.ok, code:r.status, j:j}; }, function(){ return {ok:false, code:r.status, j:{}}; }); }); }
function invWorn(state){
  var out={};
  ((state && state.items) || []).forEach(function(it){ if(it.equipped) out[it.slot]=it.value; });
  return out;
}
function invSetWorn(state){
  window.HQ_MYCOS = invWorn(state);
  try { localStorage.setItem("hq_mycos", JSON.stringify(window.HQ_MYCOS)); } catch(e){}
  if(typeof HQ3D!=="undefined" && HQ3D && HQ3D.inst && !HQ3D.visit && HQ3D.inst.lookChanged) HQ3D.inst.lookChanged();
  cosFrameMine();
}
// The name frame (a colour) someone wears, drawn round their avatar and name wherever it shows.
function cosFrame(v){ return (typeof v==="string" && /^#[0-9a-f]{6}$/i.test(v)) ? v : null; }
function cosFrameApply(el, v){
  if(!el) return;
  var f=cosFrame(v);
  el.classList.toggle("framed", !!f);
  if(f) el.style.setProperty("--frame", f); else el.style.removeProperty("--frame");
}
function cosFrameMine(){ cosFrameApply($("tcAvatar"), (window.HQ_MYCOS||{}).frame); }
try { window.HQ_MYCOS = JSON.parse(localStorage.getItem("hq_mycos")||"{}") || {}; } catch(e){}
cosFrameMine();

function invOpen(){
  var back=$("invBack"); if(!back) return;
  back.classList.add("open"); back.setAttribute("aria-hidden","false");
  var c=$("invClose"); if(c) c.focus();
  invLoad();
}
function invClose(){ var back=$("invBack"); if(back){ back.classList.remove("open"); back.setAttribute("aria-hidden","true"); } }
function invLoad(){
  $("invBody").innerHTML='<p class="muted">Loading…</p>';
  Promise.all([invGet("/api/arena/cosmetics"), invGet("/api/arena/pantry")]).then(function(res){
    INV.cos = res[0].ok ? res[0].j : null; INV.pantry = res[1].ok ? res[1].j : null;
    if(INV.cos) invSetWorn(INV.cos);
    invRender(res[0]);
  });
}
function invMsg(t){ var m=$("invMsg"); if(m) m.textContent=t||""; }
function invRender(cosRes){
  var body=$("invBody"); body.textContent="";
  // the wallet
  var coins = INV.cos ? INV.cos.coins : (INV.pantry ? INV.pantry.coins : null);
  var w=document.createElement("div"); w.className="inv-wallet";
  var cb=document.createElement("b"); cb.textContent = coins==null ? "Poke Coins: pair with an Arena" : "🪙 "+coins+" Poke Coins";
  var lv=document.createElement("span"); lv.className="muted"; lv.textContent = INV.cos ? "HQ level "+INV.cos.level : "";
  w.appendChild(cb); w.appendChild(lv); body.appendChild(w);
  var msg=document.createElement("div"); msg.id="invMsg"; msg.className="inv-msg"; msg.setAttribute("aria-live","polite"); body.appendChild(msg);
  // HQ 2.5 loot: Chests and Cards (34-loot.js)
  if(typeof lootSections==="function") lootSections(body, INV);
  // snacks
  var items=(INV.pantry && INV.pantry.items) || {};
  var sn=Object.keys(items).filter(function(k){ return items[k]>0 && typeof FOOD_UI!=="undefined" && FOOD_UI[k]; });
  invSection(body, "Snacks", sn.length ? null : "None: the Store sells them for Poke Coins.", function(box){
    sn.forEach(function(k){ var c=document.createElement("span"); c.className="inv-chip"; c.textContent=FOOD_UI[k].emoji+" "+FOOD_UI[k].name+" ×"+items[k]; box.appendChild(c); });
  });
  // Valley finds
  invSection(body, "Valley finds", null, function(box){
    var p=document.createElement("p"); p.className="muted"; p.textContent="Loading your Valley bag…"; box.appendChild(p);
    invValley(box);
  });
  // cosmetics
  if(!INV.cos){
    invSection(body, "Cosmetics", cosRes && cosRes.code===404 ? "This Arena doesn't sell cosmetics yet: ask its owner to update it." : "Pair with an Arena (Arena tab) to buy and wear cosmetics.", function(){});
    return;
  }
  var bySlot={}; INV.cos.items.forEach(function(it){ (bySlot[it.slot]=bySlot[it.slot]||[]).push(it); });
  Object.keys(INV.cos.slots).forEach(function(slot){
    invSection(body, INV.cos.slots[slot], null, function(box){
      if(INV_WHERE[slot]){ var wh=document.createElement("p"); wh.className="muted inv-where"; wh.textContent=INV_WHERE[slot]; box.parentNode.insertBefore(wh, box); }
      box.classList.add("inv-cos");
      (bySlot[slot]||[]).forEach(function(it){
        var card=document.createElement("div"); card.className="inv-item"+(it.equipped?" on":"");
        var sw=document.createElement("span"); sw.className="inv-sw";
        if(/^#/.test(it.value)) sw.style.background=it.value; else sw.textContent={flags:"🚩",gnomes:"🧙",fireworks:"🎆",neon:"✨"}[it.value]||"★";
        var nm=document.createElement("b"); nm.textContent=it.name;
        var meta=document.createElement("small"); meta.className="muted";
        meta.textContent = it.equipped ? "Wearing" : it.owned ? "Owned" : it.locked ? "Unlocks at Lv "+it.level : it.price ? it.price+" coins" : "";
        var btn=document.createElement("button"); btn.type="button"; btn.className="hbtn";
        if(it.equipped){ btn.textContent="Take off"; btn.addEventListener("click", function(){ invEquip(slot, null); }); }
        else if(it.owned){ btn.textContent="Wear"; btn.addEventListener("click", function(){ invEquip(slot, it.id); }); }
        else if(it.locked){ btn.textContent="Locked"; btn.disabled=true; }
        else { btn.textContent="Buy"; btn.disabled = INV.cos.coins < it.price; btn.title = btn.disabled ? "Not enough Poke Coins" : "";
          btn.addEventListener("click", function(){ invBuy(it); }); }
        card.appendChild(sw); card.appendChild(nm); card.appendChild(meta); card.appendChild(btn); box.appendChild(card);
      });
    });
  });
}
function invSection(body, title, empty, fill){
  var s=document.createElement("section"); s.className="inv-sec";
  var h=document.createElement("h4"); h.textContent=title; s.appendChild(h);
  var box=document.createElement("div"); box.className="inv-box"; s.appendChild(box);
  if(empty){ var p=document.createElement("p"); p.className="muted"; p.textContent=empty; box.appendChild(p); } else fill(box);
  body.appendChild(s);
}
function invPost(path, body){
  return fetch(path,{method:"POST",headers:{"Content-Type":"application/json","X-HQ-Token":CSRF},body:JSON.stringify(body||{})})
    .then(function(r){ return r.json().then(function(j){ return {ok:r.ok, code:r.status, j:j}; }, function(){ return {ok:false, code:r.status, j:{}}; }); });
}
function invBuy(it){
  if(INV.busy) return; INV.busy=true; invMsg("Buying "+it.name+"…");
  invPost("/api/arena/cosmetics/buy",{item:it.id}).then(function(res){
    INV.busy=false;
    if(!res.ok){ invMsg("⚠ "+(res.j.detail||res.j.error||"That didn't go through.")); return; }
    INV.cos=res.j; invRender({ok:true}); invMsg("Bought "+it.name+". Wear it below.");
  }).catch(function(){ INV.busy=false; invMsg("⚠ The Arena didn't answer."); });
}
function invEquip(slot, id){
  if(INV.busy) return; INV.busy=true;
  invPost("/api/arena/cosmetics/equip",{slot:slot, item:id}).then(function(res){
    INV.busy=false;
    if(!res.ok){ invMsg("⚠ "+(res.j.detail||res.j.error||"That didn't go through.")); return; }
    INV.cos=res.j; invSetWorn(res.j); invRender({ok:true}); invMsg(id ? "Wearing it. Everyone sees it in your next game." : "Taken off.");
  }).catch(function(){ INV.busy=false; invMsg("⚠ The Arena didn't answer."); });
}
// Where each slot shows, so wearing something is never a mystery.
var INV_WHERE = {kart:"Your car in Kart Racing, for everyone in the race.", runner:"Your runner in Platformer Rush.",
  blaster:"Your blaster in Blaster Arena.", ball:"Your ball in Mini Golf.",
  frame:"Round your avatar and name: your trainer card, the Arena lobby, your name tag in the HQ and Arena City.",
  decor:"On your building: your Base and your lot in Arena City."};
// The Valley bag lives in this browser's Valley save: load the Valley's engine to read and change it.
var INV_SELL_CAT = {fish:"fish", crop:"crop", ore:"ore", gem:"gem", misc:"misc"};
function invValley(box){
  if(typeof valleyLoad!=="function"){ box.textContent=""; return; }
  valleyLoad().then(function(){
    var H=window.HQV, api=H && H.api; box.textContent="";
    if(!api || !api.inv || !api.save){ var p=document.createElement("p"); p.className="muted"; p.textContent="Open the Valley once to start a bag."; box.appendChild(p); return; }
    var ids=api.inv.list();
    if(!ids.length){ var e=document.createElement("p"); e.className="muted"; e.textContent="Empty: fish, farm and mine in the Valley."; box.appendChild(e); return; }
    ids.forEach(function(id){
      var it=H.items[id], n=api.inv.count(id), cat=INV_SELL_CAT[it.cat]||"misc";
      var row=document.createElement("div"); row.className="inv-find";
      var nm=document.createElement("span"); nm.textContent=it.name+" ×"+n;
      var sell=document.createElement("button"); sell.type="button"; sell.className="hbtn ghost";
      var take=Math.min(n, 10); sell.textContent="Sell "+take+" for "+(take*(cat==="gem"?2:1))+" 🪙";
      sell.addEventListener("click", function(){ invSell(id, cat, take, box); });
      row.appendChild(nm); row.appendChild(sell); box.appendChild(row);
    });
    var note=document.createElement("small"); note.className="muted"; note.textContent="The market buys up to 10 coins of finds a day."; box.appendChild(note);
  }).catch(function(){ box.textContent="The Valley couldn't load."; });
}
function invSell(id, cat, n, box){
  var api=window.HQV && window.HQV.api; if(!api || INV.busy) return;
  if(!api.inv.take(id, n)){ invMsg("You don't have that many."); return; }
  INV.busy=true; invMsg("Selling…");
  invPost("/api/arena/market/sell",{cat:cat, qty:n}).then(function(res){
    INV.busy=false;
    if(!res.ok){ api.inv.add(id, n); invMsg("⚠ "+(res.j.detail||res.j.error||"The market said no.")); return; }
    invMsg("Sold for "+res.j.earned+" 🪙. Purse: "+res.j.coins+".");
    if(INV.cos) INV.cos.coins=res.j.coins;
    invValley(box); var b=$("invBody").querySelector(".inv-wallet b"); if(b) b.textContent="🪙 "+res.j.coins+" Poke Coins";
  }).catch(function(){ INV.busy=false; api.inv.add(id, n); invMsg("⚠ The Arena didn't answer."); });
}
(function(){
  var c=$("invClose"); if(c) c.addEventListener("click", invClose);
  var back=$("invBack"); if(back) back.addEventListener("click", function(e){ if(e.target===back) invClose(); });
  document.addEventListener("keydown", function(e){ if(e.key==="Escape" && back && back.classList.contains("open")) invClose(); });
  var b=$("hqInvBtn"); if(b) b.addEventListener("click", invOpen);
  var hb=$("invHeadBtn"); if(hb) hb.addEventListener("click", invOpen);
  // keep what you wear fresh (it rides on every game you join)
  setTimeout(function(){ invGet("/api/arena/cosmetics").then(function(r){ if(r.ok) invSetWorn(r.j); }); }, 4000);
})();
