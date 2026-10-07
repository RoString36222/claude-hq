"use strict";
var $ = function(id){return document.getElementById(id);};
function esc(s){ if(s==null) return ""; return String(s)
  .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
function el(tag,cls){ var e=document.createElement(tag); if(cls) e.className=cls; return e; }
// Inline icon from the SVG sprite at the top of <body>.
// The "thinking orb" (see .orb in the stylesheet); decorative, so hidden from screen readers.
function orb(cls,state){ return '<span class="orb'+(cls?' '+cls:'')+'" data-orb="'+(state||"working")+'" aria-hidden="true"></span>'; }
// Pick the orb animation from what a session is doing ("Bash: npm test", "Grep: …", or nothing yet).
function orbStateFor(now){
  var tool = String(now||"").split(":")[0].trim();
  if(!tool) return "composing";
  if(/^(Read|Grep|Glob|LS|WebSearch|WebFetch|ToolSearch|mcp__.*(search|find|read|get|list|query).*)$/i.test(tool)) return "searching";
  if(/^(Edit|MultiEdit|Write|NotebookEdit)$/.test(tool)) return "shaping";
  if(/^(Agent|Task|Workflow|TodoWrite|Plan)/.test(tool)) return "solving";
  if(/^(AskUserQuestion)$/.test(tool)) return "listening";
  return "working";
}
var LOADING_HTML='<span class="loading-row">'+orb("","searching")+'Loading…</span>';
function ico(name,cls){ return '<svg class="i'+(cls?' '+cls:'')+'" aria-hidden="true"><use href="#i-'+name+'"/></svg>'; }
// Leading emoji on action labels -> sprite icon (keeps the text label).
var ACT_ICONS={"▶":"play","📂":"folder","📜":"scroll","📊":"chart","✏️":"pencil","⤢":"expand","✕":"x","📌":"pin"};
function setActLabel(b,label){
  var sp=label.indexOf(" "), lead=sp>0?label.slice(0,sp):"", name=ACT_ICONS[lead];
  if(name){ b.innerHTML=ico(name)+'<span>'+esc(label.slice(sp+1))+'</span>'; b.title=label.slice(sp+1); b.setAttribute("aria-label",label.slice(sp+1)); } else { b.textContent=label; }
}
// Announce a transient status message to screen readers via the polite live region.
function announce(msg){
  var n=document.getElementById("a11yStatus"); if(!n) return;
  n.textContent="";                       // reset so identical consecutive messages re-fire
  setTimeout(function(){ n.textContent=String(msg||""); }, 30);
}

function relTime(iso){
  if(!iso) return "—";
  var t = Date.parse(iso); if(isNaN(t)) return "—";
  var s = Math.max(0,(Date.now()-t)/1000);
  if(s<45) return "just now";
  if(s<90) return "1m";
  if(s<3600) return Math.round(s/60)+"m";
  if(s<86400) return Math.round(s/3600)+"h";
  return Math.round(s/86400)+"d";
}
function fmtAge(secs){
  if(secs==null) return "—";
  if(secs<60) return secs+"s";
  if(secs<3600) return Math.round(secs/60)+"m";
  if(secs<86400) return Math.round(secs/3600)+"h";
  return Math.round(secs/86400)+"d";
}

var STATE = null;
// One /api/pokedex request shared by every reader (startup high-water seeding, the trainer card,
// the Pokédex view, quests): a full-history scan on the server, so callers within DEX_FETCH_TTL
// reuse the same promise. A failed request is never cached. Readers must not mutate the result.
var DEX_FETCH={p:null, at:0}, DEX_FETCH_TTL=30000;   // declared up here: primeHighWater runs during startup
function fetchPokedex(){
  var now=Date.now();
  if(DEX_FETCH.p && now-DEX_FETCH.at<DEX_FETCH_TTL) return DEX_FETCH.p;
  var p=fetch('/api/pokedex',{cache:"no-store"})
    .then(function(r){ if(!r.ok) throw new Error(r.status); return r.json(); });
  DEX_FETCH={p:p, at:now};
  p.catch(function(){ if(DEX_FETCH.p===p) DEX_FETCH={p:null, at:0}; });
  return p;
}
var QUERY = "";
var SORT = localStorage.getItem("hq_sort") || "recent";
var FILTER = "all";
var BASELINE = false;          // becomes true after first successful load
var CSRF = (document.querySelector('meta[name=hq-csrf]')||{}).getAttribute
  ? document.querySelector('meta[name=hq-csrf]').getAttribute("content") : "";
// The server mints a new CSRF token every time it starts. If Claude HQ restarted while this
// page stayed open, every save/action would fail with 403 until a reload. Instead: on a
// "bad or missing CSRF token" answer, fetch a fresh token from "/" once and retry the request.
(function(){
  var orig = window.fetch.bind(window), refreshing = null;
  function freshToken(){
    return refreshing || (refreshing = orig("/", {cache:"no-store", credentials:"same-origin"})
      .then(function(r){ return r.text(); })
      .then(function(html){
        var m = /<meta name="hq-csrf" content="([^"]+)"/.exec(html);
        if(!m || m[1] === "__HQ_CSRF__") throw new Error("no token");
        CSRF = m[1];
        var meta = document.querySelector('meta[name=hq-csrf]'); if(meta) meta.setAttribute("content", m[1]);
        return m[1];
      })
      .then(function(t){ refreshing = null; return t; }, function(e){ refreshing = null; throw e; }));
  }
  window.fetch = function(input, init){
    var hdrs = init && init.headers, sent = hdrs && !(hdrs instanceof Headers) && hdrs["X-HQ-Token"];
    var p = orig(input, init);
    if(!sent || typeof input !== "string" || input.charAt(0) !== "/") return p;
    return p.then(function(r){
      if(r.status !== 403) return r;
      return r.clone().json().catch(function(){ return {}; }).then(function(j){
        if(!j || j.error !== "bad or missing CSRF token") return r;
        return freshToken().then(function(tok){
          var h = {}; for(var k in hdrs) h[k] = hdrs[k]; h["X-HQ-Token"] = tok;
          var again = {}; for(var k2 in init) again[k2] = init[k2]; again.headers = h;
          return orig(input, again);
        }, function(){ return r; });
      });
    });
  };
})();
var VOICE = localStorage.getItem("hq_voice")==="1";
var FOCUS_ID = null;           // sessionId currently in focus mode, or null
var FILTERTAG = "";            // active tag filter, "" = all
var STATE_AT = 0;              // Date.now() of last payload (for live timers)

