/* Claude HQ — Valley minigames: shared engine.
 *
 * Loaded lazily by index.html the first time the Valley view opens (and the Waiting
 * Room pill is shown by index.html itself). Every game registers with HQV.register()
 * and gets an `api` with the save, the inventory, activity signals and helpers.
 *
 * House rules (CONTRIBUTING.md): no build step, no external assets — every sprite is
 * drawn here from pixel maps; text goes in with textContent; calm / reduced motion is
 * honoured through api.calm(); progress lives in a local file (/api/games/state) and
 * the only things that ever leave the machine are scores and counts sent to an Arena
 * room you are already in.
 */
(function(){
"use strict";

var HQV = window.HQV = window.HQV || {};
var GAMES = [], ACTIVE = null, ROOT = null, LAST_STATE = null, PREV_STATUS = {};
var SAVE = null, SAVE_TIMER = null, LOADED = false, PAUSED_FOR = null;

/* ---------- tiny DOM helpers (textContent only) ---------- */
function mk(tag, cls, text){ var n=document.createElement(tag); if(cls) n.className=cls; if(text!=null) n.textContent=String(text); return n; }
function btn(label, cls, fn){ var b=mk("button", "hbtn"+(cls?" "+cls:""), label); b.type="button"; b.addEventListener("click", fn); return b; }
function calm(){
  var de=document.documentElement;
  return de.classList.contains("hq-calm") || !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
}
function note(msg, cls){ if(typeof window.toast==="function") window.toast(msg, cls); }

/* ---------- deterministic randomness (mulberry32) ---------- */
function hashStr(s){ var h=2166136261>>>0; s=String(s); for(var i=0;i<s.length;i++){ h^=s.charCodeAt(i); h=Math.imul(h,16777619)>>>0; } return h>>>0; }
function rng(seed){ var a=(typeof seed==="number"?seed:hashStr(seed))>>>0; return function(){ a=(a+0x6D2B79F5)>>>0; var t=a; t=Math.imul(t^(t>>>15),t|1); t^=t+Math.imul(t^(t>>>7),t|61); return ((t^(t>>>14))>>>0)/4294967296; }; }
function localDay(d){ d=d||new Date(); return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0"); }
function weekKey(d){ d=new Date((d||new Date()).getTime()); d.setHours(0,0,0,0); d.setDate(d.getDate()-((d.getDay()+6)%7)); return localDay(d); }

/* ---------- pixel sprites: rows of palette chars -> cached canvas ---------- */
var SPR_CACHE = {};
function sprite(key, rows, pal, scale){
  scale = scale||1;
  var ck = key+"@"+scale; if(SPR_CACHE[ck]) return SPR_CACHE[ck];
  var h=rows.length, w=rows[0].length, cv=document.createElement("canvas");
  cv.width=w*scale; cv.height=h*scale;
  var g=cv.getContext("2d");
  for(var y=0;y<h;y++) for(var x=0;x<w;x++){
    var c=rows[y][x], col=pal[c]; if(!col || c===".") continue;
    g.fillStyle=col; g.fillRect(x*scale,y*scale,scale,scale);
  }
  SPR_CACHE[ck]=cv; return cv;
}
// Item icons: one 8x8 template per category, tinted with the item's colours.
var ICON_TPL = {
  fish:["........","....11..",".1.1221.","11122221","11122221",".1.1221.","....11..","........"],
  crop:["...33...","..3443..","...44...","..1111..",".111211.",".112111.","..1111..","........"],
  ore: ["........","..1111..",".112211.","1122211.","1112111.",".111111.","..1111..","........"],
  gem: ["........","...11...","..1221..",".122221.",".112211.","..1111..","...11...","........"],
  misc:["........","..1111..",".122221.",".122221.",".122221.",".122221.","..1111..","........"]
};
function iconFor(item, scale){
  var t=ICON_TPL[item.cat]||ICON_TPL.misc;
  return sprite("ic:"+item.id, t, {"1":item.c1,"2":item.c2,"3":"#3f7d3a","4":"#6fbf5a"}, scale||3);
}

/* ---------- item catalog (all original) ---------- */
var ITEMS = {};
function defItem(id, name, cat, c1, c2, extra){ var it={id:id,name:name,cat:cat,c1:c1,c2:c2}; for(var k in (extra||{})) it[k]=extra[k]; ITEMS[id]=it; return it; }
// Fish: rarity 1 common .. 4 legendary; `pond` is the pond family it prefers.
[["minnow","Byte Minnow",1,"#9fb4c7","#dfe8f0"],["perch","Pipe Perch",1,"#c9a14a","#f1d98a"],
 ["carp","Cache Carp",1,"#a2753f","#d9b27a"],["bream","Branch Bream",2,"#6f9e6a","#b7dbb0"],
 ["trout","Token Trout",2,"#d9827a","#f6c3bd"],["pike","Pointer Pike",2,"#5b7a52","#a7c79e"],
 ["eel","Event Eel",2,"#4d4a7a","#9a96d0"],["koi","Commit Koi",3,"#e36d3a","#ffd2b8"],
 ["sturgeon","Stack Sturgeon",3,"#6b6f78","#b9bec8"],["angler","Async Angler",3,"#2f3b63","#7cc0ff"],
 ["glowfin","Glowfin",3,"#3ea89a","#b8fff2"],["lumen","Lumen Ray",4,"#f2d14b","#fff7c2"],
 ["leviathan","Merge Leviathan",4,"#7a3fb0","#e2c4ff"],["sunfish","Deploy Sunfish",2,"#f0a63a","#ffe0a0"],
 ["ghostfish","Null Ghostfish",4,"#cfd8e3","#ffffff"],["mudcat","Legacy Mudcat",1,"#6e5a44","#a8916f"]
].forEach(function(f){ defItem(f[0], f[1], "fish", f[3], f[4], {rarity:f[2]}); });
// Crops: grow time in hours and water needed (water comes from your prompts).
[["radish","Radish",4,6,"spring","#d8435a","#f5a3b0"],["pea","Snap Pea",6,8,"spring","#5fae4a","#b4e39f"],
 ["tulip","Tulip",8,10,"spring","#e05aa0","#ffc1e1"],["tomato","Tomato",6,10,"summer","#e0452f","#ff9d84"],
 ["melon","Melon",12,16,"summer","#4c9a3a","#d7f2a0"],["corn","Corn",10,12,"summer","#e8c13a","#fff0a6"],
 ["pumpkin","Pumpkin",12,16,"autumn","#e07b25","#ffc27a"],["grape","Grape",8,12,"autumn","#6a3fa0","#c7a6f0"],
 ["kale","Frost Kale",6,8,"winter","#3f7d6a","#a6e0cc"]
].forEach(function(c){ defItem(c[0], c[1], "crop", c[5], c[6], {hours:c[2], water:c[3], season:c[4]}); });
[["copper","Copper Ore","ore","#b8673a","#f0a97a"],["iron","Iron Ore","ore","#7a7f88","#c9ced6"],
 ["gold","Gold Ore","ore","#d9a72a","#fff0a0"],["quartz","Quartz","gem","#d9e6f2","#ffffff"],
 ["amethyst","Amethyst","gem","#7a3fb0","#d9b8ff"],["emerald","Emerald","gem","#2f9a5a","#a8ffcf"],
 ["ruby","Ruby","gem","#b02a3a","#ff9fae"],["slime","Slime Gel","misc","#5ac85a","#c4ffc4"],
 ["shell","Bug Shell","misc","#8a6a3a","#e0c48a"]
].forEach(function(o){ defItem(o[0], o[1], o[2], o[3], o[4]); });

/* ---------- save: one local JSON file via /api/games/state ---------- */
function blank(){ return {v:1, inv:{}, log:{}, garden:{}, bundles:{}, mines:{}, battle:{}, puzzle:{}, town:{}, festival:{}, arcade:{}, unlocks:{}}; }
function csrf(){ var m=document.querySelector("meta[name=hq-csrf]"); return m ? (m.getAttribute("content")||"") : ""; }
function load(){
  return fetch("/api/games/state", {cache:"no-store"}).then(function(r){ return r.ok ? r.json() : {}; })
    .catch(function(){ return {}; })
    .then(function(j){
      var st = (j && j.state && typeof j.state==="object") ? j.state : {};
      SAVE = blank(); for(var k in st) if(Object.prototype.hasOwnProperty.call(st,k)) SAVE[k]=st[k];
      ["inv","log","garden","bundles","mines","battle","puzzle","town","festival","arcade","unlocks"].forEach(function(k){
        if(!SAVE[k] || typeof SAVE[k]!=="object" || Array.isArray(SAVE[k])) SAVE[k]={};
      });
      LOADED = true;
    });
}
function persist(now){
  if(!LOADED) return;
  clearTimeout(SAVE_TIMER);
  SAVE_TIMER = setTimeout(function(){
    fetch("/api/games/state", {method:"POST", headers:{"Content-Type":"application/json","X-HQ-Token":csrf()},
      body: JSON.stringify({state:SAVE})}).then(function(r){
        if(!r.ok) note("Valley: couldn’t save progress ("+r.status+")", "ach");
      }).catch(function(){ note("Valley: couldn’t save progress", "ach"); });
  }, now ? 0 : 700);
}

/* ---------- inventory ---------- */
var inv = {
  count: function(id){ return (SAVE && SAVE.inv[id])|0; },
  add: function(id, n){ if(!ITEMS[id]) return; n=n==null?1:n|0; SAVE.inv[id]=Math.max(0, inv.count(id)+n); if(!SAVE.inv[id]) delete SAVE.inv[id]; persist(); renderInv(); },
  take: function(id, n){ n=n==null?1:n|0; if(inv.count(id)<n) return false; inv.add(id, -n); return true; },
  list: function(cat){ return Object.keys((SAVE&&SAVE.inv)||{}).filter(function(id){ return ITEMS[id] && (!cat || ITEMS[id].cat===cat) && SAVE.inv[id]>0; }); }
};

/* ---------- activity signals from the dashboard's own STATE ---------- */
function activity(){
  var st = LAST_STATE || window.STATE || {};
  var ss = st.sessions || [], season = st.season || {}, cal = season.calendar || [];
  var working=[], needs=[];
  ss.forEach(function(s){ if(s.status==="working") working.push(s); else if(s.status==="needs") needs.push(s); });
  var last7 = cal.slice(-7);
  var folders = {};
  ss.forEach(function(s){ if(s.folder) folders[s.folder]=1; });
  return {
    sessions: ss, working: working, needs: needs,
    folders: Object.keys(folders).sort(),
    prompts30: ((season.totals||{}).prompts)|0,
    today: (cal.length ? (cal[cal.length-1].count|0) : 0),
    weekActiveDays: last7.filter(function(c){ return (c.count|0)>0; }).length,
    weekCount: last7.reduce(function(a,c){ return a+(c.count|0); }, 0),
    streak: season.streak|0, level: season.level|0
  };
}

/* ---------- Arena room traffic: {kind:"game", g:<game id>, ...} ---------- */
function sendSay(data){
  var A = window.ARENA;
  if(!A || !A.sock || A.sock.readyState!==1) return false;
  var d = {kind:"game"}; for(var k in data) d[k]=data[k];
  try { A.sock.send(JSON.stringify({type:"say", data:d})); return true; } catch(e){ return false; }
}
HQV.onSay = function(m){
  var d = m && m.data; if(!d || typeof d.g!=="string") return;
  var from = (m.from && typeof m.from==="object") ? m.from : {};
  var who = typeof from.displayName==="string" && from.displayName ? from.displayName.slice(0,40)
          : (typeof from.handle==="string" ? from.handle.slice(0,40) : "someone");
  GAMES.forEach(function(g){ if(g.onSay && (g.id===d.g || g.listen===d.g)) { try{ g.onSay(d, who, from); }catch(e){} } });
};

/* ---------- the shared api handed to every game ---------- */
var api = {
  get save(){ return SAVE; }, persist: persist, inv: inv, items: ITEMS, icon: iconFor, sprite: sprite,
  rng: rng, hash: hashStr, day: localDay, week: weekKey, calm: calm, toast: note, mk: mk, btn: btn,
  activity: activity, say: sendSay,
  inArenaRoom: function(){ var A=window.ARENA; return !!(A && A.sock && A.sock.readyState===1); },
  season: function(d){ var m=(d||new Date()).getMonth(); return m<2||m===11 ? "winter" : m<5 ? "spring" : m<8 ? "summer" : "autumn"; },
  open: function(id){ openGame(id); },
  // A fixed-size pixel canvas that scales crisply to its box.
  canvas: function(w, h){ var c=mk("canvas","vg-canvas"); c.width=w; c.height=h; c.tabIndex=0; return c; }
};

/* ---------- registry + shell ---------- */
HQV.register = function(game){ GAMES.push(game); if(ROOT) renderHome(); };
HQV.api = api; HQV.items = ITEMS;

function renderInv(){
  var bar = ROOT && ROOT.querySelector(".vg-inv"); if(!bar) return;
  bar.textContent = "";
  var ids = inv.list();
  if(!ids.length){ bar.appendChild(mk("span","vg-muted","Your bag is empty. Fish, farm and mine to fill it.")); return; }
  ids.sort(function(a,b){ return (ITEMS[a].cat+ITEMS[a].name).localeCompare(ITEMS[b].cat+ITEMS[b].name); });
  ids.forEach(function(id){
    var it=ITEMS[id], s=mk("span","vg-slot"); s.title=it.name;
    s.appendChild(cloneCanvas(iconFor(it,3)));
    s.appendChild(mk("b",null,String(SAVE.inv[id])));
    bar.appendChild(s);
  });
}
function cloneCanvas(src){ var c=document.createElement("canvas"); c.width=src.width; c.height=src.height; c.getContext("2d").drawImage(src,0,0); return c; }
api.iconEl = function(id, scale){ var it=ITEMS[id]; return it ? cloneCanvas(iconFor(it, scale||3)) : mk("span"); };

function waitText(a){
  if(a.needs.length) return {cls:"needs", text:a.needs.length+" tab"+(a.needs.length>1?"s need":" needs")+" you"};
  if(a.working.length) return {cls:"working", text:a.working.length+" tab"+(a.working.length>1?"s":"")+" working — play while you wait"};
  return {cls:"", text:"No tabs working. The Valley is still open."};
}
function renderBanner(){
  var b = ROOT && ROOT.querySelector(".vg-wait"); if(!b) return;
  var w = waitText(activity());
  b.className = "vg-wait "+w.cls; b.textContent = "";
  b.appendChild(mk("span", null, w.text));
  var a = activity();
  if(a.needs.length && typeof window.openSession==="function"){
    var s=a.needs[0];
    b.appendChild(btn("Go to tab", "primary", function(){ goToTab(s); }));
  }
}
function goToTab(s){
  if(ACTIVE && ACTIVE.pause) ACTIVE.pause();
  if(typeof window.setView==="function") window.setView("live");
  if(typeof window.openSession==="function") window.openSession(s.sessionId||s.id, {title:s.title, creature:s.creature});
}

function renderHome(){
  if(!ROOT) return;
  var home = ROOT.querySelector(".vg-home"); if(!home) return;
  home.textContent = "";
  GAMES.forEach(function(g){
    var card = mk("button","vg-card"); card.type="button";
    card.appendChild(mk("span","vg-card-ic", g.icon||"✨"));
    var t = mk("span","vg-card-t"); t.appendChild(mk("b",null,g.name)); t.appendChild(mk("span",null,g.desc||"")); card.appendChild(t);
    if(g.badge){ var bd=g.badge(); if(bd) card.appendChild(mk("span","vg-badge",bd)); }
    card.addEventListener("click", function(){ openGame(g.id); });
    home.appendChild(card);
  });
}
function openGame(id){
  var g=null; GAMES.forEach(function(x){ if(x.id===id) g=x; }); if(!g || !ROOT) return;
  closeGame();
  ACTIVE = g; PAUSED_FOR = null;
  var stage = ROOT.querySelector(".vg-stage"), home = ROOT.querySelector(".vg-home");
  home.classList.add("hidden"); stage.classList.remove("hidden"); stage.textContent="";
  var head = mk("div","vg-stage-head");
  head.appendChild(btn("← Valley", "ghost", function(){ closeGame(); renderHome(); }));
  head.appendChild(mk("h3",null,(g.icon?g.icon+" ":"")+g.name));
  stage.appendChild(head);
  var body = mk("div","vg-body"); stage.appendChild(body);
  try { g.mount(body, api); } catch(e){ body.appendChild(mk("p","vg-muted","This game failed to start: "+e.message)); }
}
function closeGame(){
  if(ACTIVE){ try{ if(ACTIVE.unmount) ACTIVE.unmount(); }catch(e){} }
  ACTIVE = null; PAUSED_FOR = null;
  if(!ROOT) return;
  var stage = ROOT.querySelector(".vg-stage"), home = ROOT.querySelector(".vg-home");
  stage.classList.add("hidden"); stage.textContent=""; home.classList.remove("hidden");
  hidePause();
}

/* ---------- pause the game the moment a tab needs you ---------- */
function showPause(s){
  var o = ROOT && ROOT.querySelector(".vg-pause"); if(!o) return;
  o.textContent = ""; o.classList.remove("hidden");
  var box = mk("div","vg-pause-box");
  box.appendChild(mk("b",null,"Paused: a tab needs you"));
  box.appendChild(mk("p",null,(s.title||s.name||"A session")+(s.alert?" — "+s.alert:"")));
  var row = mk("div","vg-row");
  row.appendChild(btn("Go to tab", "primary", function(){ hidePause(); goToTab(s); }));
  row.appendChild(btn("Keep playing", "ghost", function(){ hidePause(); if(ACTIVE && ACTIVE.resume) ACTIVE.resume(); }));
  box.appendChild(row); o.appendChild(box);
  var b = box.querySelector("button"); if(b) b.focus();
}
function hidePause(){ var o = ROOT && ROOT.querySelector(".vg-pause"); if(o){ o.classList.add("hidden"); o.textContent=""; } }

HQV.onState = function(st){
  LAST_STATE = st;
  var fresh = null, finished = [];
  ((st && st.sessions)||[]).forEach(function(s){
    var id = s.sessionId||s.id, prev = PREV_STATUS[id];
    if(s.status==="needs" && prev && prev!=="needs" && !fresh) fresh = s;
    if(prev==="working" && (s.status==="idle" || s.status==="needs")) finished.push(s);
    PREV_STATUS[id] = s.status;
  });
  if(fresh && ACTIVE && !PAUSED_FOR && window.VIEW==="valley"){
    PAUSED_FOR = fresh.sessionId||fresh.id;
    if(ACTIVE.pause) ACTIVE.pause();
    showPause(fresh);
  }
  if(finished.length) GAMES.forEach(function(g){ if(g.onFinished){ try{ g.onFinished(finished); }catch(e){} } });
  renderBanner();
  GAMES.forEach(function(g){ if(g.onTick){ try{ g.onTick(); }catch(e){} } });
};

HQV.enter = function(root){
  ROOT = root;
  if(!root.querySelector(".vg-shell")){
    root.textContent = "";
    var shell = mk("div","vg-shell");
    shell.appendChild(mk("div","vg-wait"));
    shell.appendChild(mk("div","vg-home"));
    var stage = mk("div","vg-stage hidden"); shell.appendChild(stage);
    var invWrap = mk("div","vg-invwrap"); invWrap.appendChild(mk("h4",null,"Bag")); invWrap.appendChild(mk("div","vg-inv")); shell.appendChild(invWrap);
    var pause = mk("div","vg-pause hidden"); pause.setAttribute("role","dialog"); pause.setAttribute("aria-label","Paused"); shell.appendChild(pause);
    root.appendChild(shell);
  }
  var go = function(){ renderBanner(); if(!ACTIVE) renderHome(); renderInv(); if(ACTIVE && ACTIVE.resume && !PAUSED_FOR) ACTIVE.resume(); };
  if(LOADED) go(); else load().then(go);
};
HQV.leave = function(){ if(ACTIVE && ACTIVE.pause) ACTIVE.pause(); };
HQV.ready = load;
})();
