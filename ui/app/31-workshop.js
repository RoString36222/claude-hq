/* 31-workshop.js: the Workshop view (map gallery).
   Make (the Valley editors in HQV.makers), Gallery, My maps and This room, under a
   "map of the week" banner. Everything a map's maker typed is esc()'d before it reaches
   innerHTML; thumbnails are drawn from a seed of the map's content key, so a map looks
   the same every time and for everyone. */

var WS_KINDS = ["kart","plat","fps"];
var WS_KIND_LABEL = {kart:"Kart tracks", plat:"Platformer levels", fps:"Blaster maps"};
var WS_KIND_ONE = {kart:"kart track", plat:"platformer level", fps:"blaster map"};
var WS_REASONS = ["spam","offensive","broken","other"];
var WS_ID_RE = /^m-[0-9a-f]{12}$/;
var WS = {tab:"gallery", kind:"kart", sort:"new", maps:[], next:null, admin:false, byId:{},
          featured:null, loading:false, gen:0, built:false, msg:""};

// The tab ships hidden in the shell; this page turns it on.
(function(){
  var t = document.querySelector('.viewtab[data-view="workshop"]');
  if(t) t.hidden = false;
})();

function wsCss(){
  if(document.getElementById("wsCss")) return;
  var s = document.createElement("style"); s.id = "wsCss";
  s.textContent =
    "#workshopView{padding:16px;max-width:1180px;margin:0 auto}" +
    ".ws-feat{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px;padding:12px;margin-bottom:12px}" +
    ".ws-feat h2{grid-column:1/-1;margin:0;font-size:15px;color:var(--ink)}" +
    ".ws-feat-card{display:flex;gap:10px;align-items:center;border:1px solid var(--line);border-radius:var(--radius-sm);padding:8px;background:var(--panel2)}" +
    ".ws-feat-card .k{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}" +
    ".ws-bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:0 0 12px}" +
    ".ws-bar .sp{flex:1}" +
    ".ws-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:12px}" +
    ".ws-card{padding:10px;display:flex;flex-direction:column;gap:6px}" +
    ".ws-card canvas,.ws-feat-card canvas{width:100%;height:auto;border-radius:var(--radius-sm);background:var(--panel2);display:block}" +
    ".ws-feat-card canvas{width:96px;flex:none}" +
    ".ws-name{font-weight:600;color:var(--ink);overflow-wrap:anywhere}" +
    ".ws-meta{font-size:12px;color:var(--muted)}" +
    ".ws-acts{display:flex;flex-wrap:wrap;gap:4px}" +
    ".ws-b{font:inherit;font-size:12px;min-height:28px;padding:3px 9px;border-radius:7px;border:1px solid var(--line);background:var(--panel);color:var(--ink);cursor:pointer}" +
    ".ws-b:hover{border-color:var(--line2)}" +
    ".ws-b:focus-visible{outline:2px solid var(--brand);outline-offset:1px}" +
    ".ws-b.on{color:var(--brand);border-color:var(--brand-line);background:var(--brand-soft)}" +
    ".ws-b.bad{color:var(--need)}" +
    ".ws-b[disabled]{opacity:.5;cursor:default}" +
    ".ws-tag{font-size:11px;padding:1px 7px;border-radius:999px;border:1px solid var(--line);color:var(--muted)}" +
    ".ws-tag.hid{color:var(--need);border-color:var(--need)}" +
    ".ws-msg{font-size:13px;color:var(--muted);margin:6px 0}" +
    ".ws-empty{padding:24px;text-align:center;color:var(--muted)}" +
    ".ws-make{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px}" +
    ".ws-make .panel{padding:14px;display:flex;flex-direction:column;gap:8px}";
  document.head.appendChild(s);
}

function wsTok(name, fb){
  try {
    var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fb;
  } catch(e){ return fb; }
}

function wsMyId(){ return (ARENA && ARENA.you && ARENA.you.userId) || ""; }

// "This room" is for your own HQ, or a private room you are a member of. Open-HQ visits
// and quick-play rooms get no room shelf (the server says 403 to those anyway).
function wsRoomId(){
  if(typeof ARENA === "undefined" || !ARENA) return null;
  var id = ARENA.roomId || "", me = wsMyId();
  if(me && id === "hq_" + me) return id;
  if(/^r_[A-Za-z0-9_-]{22}$/.test(id) && ARENA.roomConfirmed && ARENA.roomConfirmed[id]) return id;
  return null;
}

/* ---- deterministic thumbnails ------------------------------------------------------- */
function wsThumb(canvas, card){
  var ctx = canvas.getContext && canvas.getContext("2d"); if(!ctx) return;
  var w = canvas.width, h = canvas.height;
  var rnd = mulberry32(hashStr((card.ckey || card.id || "") + "|" + card.kind));
  var bg = wsTok("--panel2", "Canvas"), line = wsTok("--line2", "GrayText"),
      ink = wsTok("--ink", "CanvasText"), brand = wsTok("--brand", "Highlight"),
      good = wsTok("--good", "Highlight"), gold = wsTok("--gold", "Highlight");
  ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);
  var data = card.data;
  if(card.kind === "kart"){
    var tiles = (data && typeof data.tiles === "string") ? data.tiles : null;
    var pts = [], x = 0, y = 0, dir = 0, i, n;
    if(tiles){
      // F straight, L/R a turn, S a straight with a sprint pad: walk the loop.
      for(i = 0; i < tiles.length; i++){
        var c = tiles.charAt(i);
        if(c === "L") dir = (dir + 3) % 4; else if(c === "R") dir = (dir + 1) % 4;
        x += [0,1,0,-1][dir]; y += [-1,0,1,0][dir]; pts.push([x, y]);
      }
    } else {
      n = 10 + Math.floor(rnd() * 8);
      for(i = 0; i < n; i++){
        var a = i / n * Math.PI * 2, r = 0.55 + rnd() * 0.4;
        pts.push([Math.cos(a) * r, Math.sin(a) * r]);
      }
    }
    var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    pts.forEach(function(p){ minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]); minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]); });
    var sc = Math.min((w - 24) / Math.max(1e-6, maxX - minX), (h - 24) / Math.max(1e-6, maxY - minY));
    var ox = (w - (maxX - minX) * sc) / 2, oy = (h - (maxY - minY) * sc) / 2;
    ctx.lineJoin = "round"; ctx.lineCap = "round";
    [[line, 12], [ink, 7]].forEach(function(st){
      ctx.strokeStyle = st[0]; ctx.lineWidth = st[1]; ctx.beginPath();
      pts.forEach(function(p, k){
        var px = ox + (p[0] - minX) * sc, py = oy + (p[1] - minY) * sc;
        if(k) ctx.lineTo(px, py); else ctx.moveTo(px, py);
      });
      ctx.closePath(); ctx.stroke();
    });
    var s0 = pts[pts.length - 1];
    ctx.fillStyle = brand; ctx.fillRect(ox + (s0[0] - minX) * sc - 5, oy + (s0[1] - minY) * sc - 5, 10, 10);
  } else if(card.kind === "plat"){
    var plats = 5 + Math.floor(rnd() * 5);
    ctx.fillStyle = good;
    for(i = 0; i < plats; i++){
      var pw = 20 + rnd() * 40, px2 = 6 + (w - 12 - pw) * (i / Math.max(1, plats - 1));
      var py2 = h - 14 - rnd() * (h - 40);
      ctx.fillRect(px2, py2, pw, 6);
      if(rnd() < 0.6){ ctx.fillStyle = gold; ctx.beginPath(); ctx.arc(px2 + pw / 2, py2 - 8, 3, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = good; }
    }
    ctx.fillStyle = brand; ctx.fillRect(w - 18, 10, 3, 20); ctx.fillRect(w - 15, 10, 9, 6);
  } else {
    var boxes = 8 + Math.floor(rnd() * 10);
    ctx.strokeStyle = line; ctx.lineWidth = 2; ctx.strokeRect(6, 6, w - 12, h - 12);
    for(i = 0; i < boxes; i++){
      var bw = 8 + rnd() * 30, bh = 8 + rnd() * 24;
      ctx.fillStyle = rnd() < 0.3 ? gold : ink;
      ctx.globalAlpha = 0.75;
      ctx.fillRect(10 + rnd() * (w - 20 - bw), 10 + rnd() * (h - 20 - bh), bw, bh);
    }
    ctx.globalAlpha = 1; ctx.fillStyle = brand;
    for(i = 0; i < 2; i++){ ctx.beginPath(); ctx.arc(16 + rnd() * (w - 32), 16 + rnd() * (h - 32), 4, 0, Math.PI * 2); ctx.fill(); }
  }
}

function wsDrawThumbs(root){
  Array.prototype.forEach.call(root.querySelectorAll("canvas[data-thumb]"), function(c){
    var card = WS.byId[c.getAttribute("data-thumb")];
    if(card) wsThumb(c, card);
  });
}

/* ---- data -------------------------------------------------------------------------- */
function wsGet(url){
  return fetch(url, {cache:"no-store"}).then(function(r){
    return r.json().then(function(j){ return {ok:r.ok, status:r.status, j:j||{}}; },
                         function(){ return {ok:r.ok, status:r.status, j:{}}; });
  });
}

function wsErr(res, fb){
  var e = res && res.j && res.j.error;
  if(res && res.status === 429) return "That's today's publishing limit; try again tomorrow.";
  if(res && res.status === 409) return "You have 50 maps live; delete one to make room.";
  if(res && res.status === 403) return "That isn't allowed here.";
  return (typeof e === "string" && e) ? e.slice(0, 160) : (fb || "Something went wrong.");
}

function wsRemember(maps){
  (maps || []).forEach(function(m){ if(m && WS_ID_RE.test(m.id || "")) WS.byId[m.id] = m; });
}

function wsListUrl(cursor){
  var q = [];
  if(WS.tab === "mine") q.push("mine=1");
  else if(WS.tab === "room"){ var rid = wsRoomId(); if(rid) q.push("room=" + encodeURIComponent(rid)); }
  if(WS.tab === "gallery"){ q.push("kind=" + WS.kind); q.push("sort=" + WS.sort); }
  if(cursor) q.push("cursor=" + encodeURIComponent(cursor));
  q.push("limit=24");
  return "/api/arena/maps?" + q.join("&");
}

function wsLoad(more){
  var gen = ++WS.gen;
  WS.loading = true;
  if(!more){ WS.maps = []; WS.next = null; }
  wsRender();
  wsGet(wsListUrl(more ? WS.next : null)).then(function(res){
    if(gen !== WS.gen) return;
    WS.loading = false;
    if(!res.ok){ WS.msg = wsErr(res, "The gallery couldn't load."); wsRender(); return; }
    var maps = Array.isArray(res.j.maps) ? res.j.maps : [];
    wsRemember(maps);
    WS.maps = WS.maps.concat(maps.filter(function(m){ return WS_ID_RE.test(m.id || ""); }));
    WS.next = typeof res.j.next === "string" ? res.j.next : null;
    WS.admin = res.j.admin === true;
    WS.msg = "";
    wsRender();
  }).catch(function(){ if(gen === WS.gen){ WS.loading = false; WS.msg = "The gallery couldn't load."; wsRender(); } });
}

function wsLoadFeatured(){
  wsGet("/api/arena/maps/featured").then(function(res){
    if(!res.ok) return;
    WS.featured = res.j || null;
    var tw = (WS.featured && WS.featured.thisWeek) || {};
    WS_KINDS.forEach(function(k){ if(tw[k]) wsRemember([tw[k]]); });
    wsRenderFeatured();
  }).catch(function(){});
}

function wsFetchDoc(id){
  return wsGet("/api/arena/maps/one?id=" + encodeURIComponent(id)).then(function(res){
    if(!res.ok || !res.j.map) throw new Error(wsErr(res, "That map couldn't load."));
    var m = res.j.map; wsRemember([m]);
    return {kind:m.kind, v:1, name:m.name, data:m.data, id:m.id, ckey:m.ckey};
  });
}

/* ---- rendering --------------------------------------------------------------------- */
function wsShell(root){
  root.innerHTML =
    '<section class="panel ws-feat" id="wsFeat" aria-label="Map of the week"></section>' +
    '<div class="ws-bar" role="tablist" aria-label="Workshop sections" id="wsTabs"></div>' +
    '<div class="ws-bar" id="wsFilters"></div>' +
    '<div class="ws-msg" id="wsMsg" role="status" aria-live="polite"></div>' +
    '<div id="wsBody"></div>';
  root.addEventListener("click", wsClick);
  WS.built = true;
}

function wsAuthor(m){
  var o = m.owner || {};
  return o.displayName || (o.handle ? "@" + o.handle : "someone");
}

function wsRenderFeatured(){
  var el = $("wsFeat"); if(!el) return;
  var f = WS.featured, tw = (f && f.thisWeek) || {}, any = false, h = '<h2>Map of the week</h2>';
  WS_KINDS.forEach(function(k){
    var m = tw[k]; if(!m || !WS_ID_RE.test(m.id || "")) return;
    any = true;
    h += '<div class="ws-feat-card"><canvas width="96" height="64" data-thumb="' + esc(m.id) + '" aria-hidden="true"></canvas>' +
         '<div><div class="k">' + esc(WS_KIND_ONE[k]) + '</div><div class="ws-name">' + esc(m.name) + '</div>' +
         '<div class="ws-meta">by ' + esc(wsAuthor(m)) + ' · ' + esc(m.likes) + ' likes</div>' +
         '<div class="ws-acts"><button type="button" class="ws-b" data-act="play" data-id="' + esc(m.id) + '">Play</button>' +
         '<button type="button" class="ws-b" data-act="room" data-id="' + esc(m.id) + '">Race in room</button></div></div></div>';
  });
  if(!any) h += '<div class="ws-meta">No pick yet this week. Publish a map, and likes plus races this week choose it.</div>';
  el.innerHTML = h;
  wsDrawThumbs(el);
}

function wsRenderTabs(){
  var el = $("wsTabs"); if(!el) return;
  var tabs = [["make","Make"],["gallery","Gallery"],["mine","My maps"]];
  if(wsRoomId()) tabs.push(["room","This room"]);
  else if(WS.tab === "room") WS.tab = "gallery";
  el.innerHTML = tabs.map(function(t){
    var on = WS.tab === t[0];
    return '<button type="button" role="tab" class="ws-b' + (on ? ' on' : '') + '" aria-selected="' + (on ? 'true' : 'false') +
           '" data-act="tab" data-v="' + esc(t[0]) + '">' + esc(t[1]) + '</button>';
  }).join("");
  var fl = $("wsFilters"); if(!fl) return;
  if(WS.tab !== "gallery"){ fl.innerHTML = ""; return; }
  var h = WS_KINDS.map(function(k){
    return '<button type="button" class="ws-b' + (WS.kind === k ? ' on' : '') + '" aria-pressed="' + (WS.kind === k) +
           '" data-act="kind" data-v="' + k + '">' + esc(WS_KIND_LABEL[k]) + '</button>';
  }).join("") + '<span class="sp"></span>';
  h += [["new","Newest"],["top","Most liked"],["week","Hot this week"]].map(function(s){
    return '<button type="button" class="ws-b' + (WS.sort === s[0] ? ' on' : '') + '" aria-pressed="' + (WS.sort === s[0]) +
           '" data-act="sort" data-v="' + s[0] + '">' + esc(s[1]) + '</button>';
  }).join("");
  fl.innerHTML = h;
}

function wsCardHtml(m){
  var id = esc(m.id), mine = m.mine === true;
  var h = '<article class="panel ws-card" aria-label="' + esc(m.name) + '">' +
    '<canvas width="220" height="130" data-thumb="' + id + '" aria-hidden="true"></canvas>' +
    '<div class="ws-name">' + esc(m.name) + '</div>' +
    '<div class="ws-meta">' + esc(WS_KIND_ONE[m.kind] || m.kind) + ' by ' + esc(wsAuthor(m)) + ' · ' +
      esc(m.likes) + (m.likes === 1 ? ' like' : ' likes') + ' · ' + esc(m.races || 0) + ' raced</div>' +
    '<div class="ws-acts">';
  if(m.scope !== "public") h += '<span class="ws-tag">' + esc(m.scope) + '</span>';
  if(m.hidden) h += '<span class="ws-tag hid">hidden</span>';
  h += '</div><div class="ws-acts">' +
    '<button type="button" class="ws-b" data-act="play" data-id="' + id + '">Play</button>' +
    '<button type="button" class="ws-b" data-act="room" data-id="' + id + '">Race in room</button>' +
    '<button type="button" class="ws-b" data-act="remix" data-id="' + id + '">Remix</button>';
  if(!mine) h += '<button type="button" class="ws-b' + (m.liked ? ' on' : '') + '" aria-pressed="' + (m.liked === true) +
    '" data-act="like" data-id="' + id + '">' + (m.liked ? 'Liked' : 'Like') + '</button>' +
    '<button type="button" class="ws-b" data-act="report" data-id="' + id + '">Report</button>';
  if(mine){
    h += '<button type="button" class="ws-b" data-act="edit" data-id="' + id + '">Edit</button>';
    if(m.scope !== "public") h += '<button type="button" class="ws-b" data-act="pub" data-id="' + id + '">Publish</button>';
    if(wsRoomId() && m.scope !== "room") h += '<button type="button" class="ws-b" data-act="share" data-id="' + id + '">Share to room</button>';
  }
  if(mine || WS.admin) h += '<button type="button" class="ws-b bad" data-act="del" data-id="' + id + '">Delete</button>';
  if(WS.admin) h += '<button type="button" class="ws-b" data-act="hide" data-id="' + id + '">' + (m.hidden ? 'Unhide' : 'Hide') + '</button>';
  h += '<a class="ws-b" target="_blank" rel="noopener" href="/api/arena/leaderboards?game=' + encodeURIComponent(m.kind) +
       '&key=' + encodeURIComponent(m.ckey || "") + '">Leaderboard</a></div></article>';
  return h;
}

function wsRenderMake(body){
  body.innerHTML = '<div class="ws-empty">Loading the editors…</div>';
  valleyLoad().then(function(){
    if(WS.tab !== "make" || !$("wsBody")) return;
    var mk = (window.HQV && window.HQV.makers) || {}, h = "", any = false;
    WS_KINDS.forEach(function(k){
      var m = mk[k]; if(!m || typeof m.edit !== "function") return;
      any = true;
      var drafts = [];
      try { drafts = typeof m.drafts === "function" ? (m.drafts() || []) : []; } catch(e){ drafts = []; }
      h += '<div class="panel"><div class="ws-name">' + esc(m.name || WS_KIND_LABEL[k]) + '</div>' +
           '<div class="ws-meta">' + esc(drafts.length) + ' saved draft' + (drafts.length === 1 ? '' : 's') + '</div>' +
           '<div class="ws-acts"><button type="button" class="ws-b on" data-act="new" data-v="' + k + '">New ' + esc(WS_KIND_ONE[k]) + '</button></div>';
      drafts.slice(0, 24).forEach(function(d, i){
        if(!d || typeof d.name !== "string") return;
        h += '<div class="ws-acts"><span class="ws-meta">' + esc(d.name) + '</span>' +
             '<button type="button" class="ws-b" data-act="draft" data-v="' + k + '" data-i="' + i + '">Open</button></div>';
      });
      h += '</div>';
    });
    $("wsBody").innerHTML = any ? '<div class="ws-make">' + h + '</div>'
      : '<div class="ws-empty">No editors are installed yet. Browse the gallery for now.</div>';
  }).catch(function(e){
    var b = $("wsBody"); if(b) b.textContent = "The editors couldn’t load: " + (e && e.message || "error");
  });
}

function wsRender(){
  var root = $("workshopView"); if(!root) return;
  if(!WS.built) wsShell(root);
  wsRenderTabs();
  var msg = $("wsMsg"); if(msg) msg.textContent = WS.msg || "";
  var body = $("wsBody"); if(!body) return;
  if(WS.tab === "make"){ wsRenderMake(body); return; }
  if(WS.loading && !WS.maps.length){ body.innerHTML = '<div class="ws-empty">Loading…</div>'; return; }
  if(!WS.maps.length){
    body.innerHTML = '<div class="ws-empty">' + esc(WS.tab === "mine" ? "You haven't saved a map yet. Make one in the Make tab."
      : WS.tab === "room" ? "Nobody has shared a map to this room yet." : "No maps here yet. Be the first to publish one.") + '</div>';
    return;
  }
  body.innerHTML = '<div class="ws-grid">' + WS.maps.map(wsCardHtml).join("") + '</div>' +
    (WS.next ? '<div class="ws-bar"><button type="button" class="ws-b" data-act="more"' + (WS.loading ? ' disabled' : '') + '>Load more</button></div>' : '');
  wsDrawThumbs(body);
}

/* ---- actions ----------------------------------------------------------------------- */
function wsSay(t){ WS.msg = t || ""; var m = $("wsMsg"); if(m) m.textContent = WS.msg; if(t) announce(t); }

function wsUpdateCard(id, patch){
  var m = WS.byId[id]; if(!m) return;
  for(var k in patch) if(Object.prototype.hasOwnProperty.call(patch, k)) m[k] = patch[k];
  WS.maps = WS.maps.map(function(x){ return x.id === id ? m : x; });
}

function wsMakerFor(kind){
  var mk = window.HQV && window.HQV.makers;
  return (mk && mk[kind]) || null;
}

function wsPlay(id, room){
  wsFetchDoc(id).then(function(doc){
    return valleyLoad().then(function(){
      var m = wsMakerFor(doc.kind);
      if(!m || typeof m.play !== "function"){ wsSay("This kind of map can't be played on this version yet."); return; }
      setView("valley");
      m.play(doc, room ? {room:true} : {});
    });
  }).catch(function(e){ wsSay(e && e.message || "That map couldn't load."); });
}

window.workshopOpenMaker = function(kind, doc){
  if(WS_KINDS.indexOf(kind) < 0) return Promise.resolve(false);
  return valleyLoad().then(function(){
    var m = wsMakerFor(kind);
    if(!m || typeof m.edit !== "function"){ wsSay("That editor isn't installed yet."); return false; }
    setView("valley");
    m.edit(doc || null);
    return true;
  }).catch(function(){ wsSay("The editors couldn't load."); return false; });
};

function wsChatShare(name){
  try {
    var ws = ARENA && ARENA.sock;
    if(!ws || ws.readyState !== 1) return;
    ws.send(JSON.stringify({type:"say", data:{kind:"chat", text:("shared a map: " + String(name || "")).slice(0, 80)}}));
  } catch(e){}
}

// Publish (or re-save) a MapDoc. Only the six save keys ever travel.
window.workshopPublish = function(doc, scope){
  if(!doc || WS_KINDS.indexOf(doc.kind) < 0 || !doc.data || typeof doc.data !== "object")
    return Promise.resolve({error:"That isn't a map."});
  if(["private","room","public"].indexOf(scope) < 0) scope = "public";
  var name = typeof doc.name === "string" ? doc.name.trim().slice(0, 32) : "";
  var body = {kind:doc.kind, name:name, data:doc.data, scope:scope};
  if(typeof doc.id === "string" && WS_ID_RE.test(doc.id)) body.id = doc.id;
  if(scope === "room"){
    var rid = wsRoomId();
    if(!rid) return Promise.resolve({error:"Join your HQ or a private room to share there."});
    body.roomId = rid;
  }
  return arenaPost("/api/arena/maps/save", body).then(function(res){
    if(!res.ok || !res.j || !res.j.map) return {error:wsErr(res, "The map couldn't be saved.")};
    var m = res.j.map; wsRemember([m]);
    if(scope === "room") wsChatShare(m.name);
    try { if(window.HQV && window.HQV.story && typeof window.HQV.story.note === "function") window.HQV.story.note("make-publish"); } catch(e){}
    announce(scope === "public" ? "Published " + m.name : "Saved " + m.name);
    if(VIEW === "workshop") wsLoad(false);
    return {map:m};
  }).catch(function(){ return {error:"The map couldn't be saved."}; });
};

function wsRescope(id, scope){
  wsFetchDoc(id).then(function(doc){ return window.workshopPublish(doc, scope); })
    .then(function(r){ wsSay(r && r.error ? r.error : (scope === "public" ? "Published to the gallery." : "Shared to this room.")); })
    .catch(function(e){ wsSay(e && e.message || "That map couldn't load."); });
}

function wsClick(e){
  var b = e.target && e.target.closest ? e.target.closest("[data-act]") : null;
  if(!b || b.disabled) return;
  var act = b.getAttribute("data-act"), v = b.getAttribute("data-v") || "", id = b.getAttribute("data-id") || "";
  if(id && !WS_ID_RE.test(id)) return;
  if(act === "tab"){ if(["make","gallery","mine","room"].indexOf(v) >= 0){ WS.tab = v; WS.msg = ""; if(v === "make") wsRender(); else wsLoad(false); } return; }
  if(act === "kind"){ if(WS_KINDS.indexOf(v) >= 0){ WS.kind = v; wsLoad(false); } return; }
  if(act === "sort"){ if(["new","top","week"].indexOf(v) >= 0){ WS.sort = v; wsLoad(false); } return; }
  if(act === "more"){ wsLoad(true); return; }
  if(act === "new"){ window.workshopOpenMaker(v, null); return; }
  if(act === "draft"){
    var mk = wsMakerFor(v), i = parseInt(b.getAttribute("data-i"), 10), ds = [];
    try { ds = (mk && typeof mk.drafts === "function" && mk.drafts()) || []; } catch(err){ ds = []; }
    if(ds[i]) window.workshopOpenMaker(v, ds[i]);
    return;
  }
  if(act === "play" || act === "room"){ wsPlay(id, act === "room"); return; }
  if(act === "edit"){ wsFetchDoc(id).then(function(doc){ window.workshopOpenMaker(doc.kind, doc); }).catch(function(err){ wsSay(err.message); }); return; }
  if(act === "remix"){
    wsFetchDoc(id).then(function(doc){
      window.workshopOpenMaker(doc.kind, {kind:doc.kind, v:1, name:("Remix of " + doc.name).slice(0, 32), data:doc.data});
    }).catch(function(err){ wsSay(err.message); });
    return;
  }
  if(act === "pub"){ wsRescope(id, "public"); return; }
  if(act === "share"){ wsRescope(id, "room"); return; }
  var m = WS.byId[id]; if(!m) return;
  if(act === "like"){
    var on = !m.liked; b.disabled = true;
    arenaPost("/api/arena/maps/like", {id:id, on:on}).then(function(res){
      if(!res.ok){ wsSay(wsErr(res)); b.disabled = false; return; }
      wsUpdateCard(id, {likes:+res.j.likes || 0, liked:res.j.liked === true});
      wsRender(); announce((res.j.liked ? "Liked " : "Unliked ") + m.name);
    });
    return;
  }
  if(act === "report"){
    var reason = (window.prompt("Report “" + m.name + "” as: spam, offensive, broken or other?", "broken") || "").trim().toLowerCase();
    if(!reason) return;
    if(WS_REASONS.indexOf(reason) < 0){ wsSay("Pick one of: spam, offensive, broken, other."); return; }
    if(!window.confirm("Report this map as " + reason + "? Three reports hide it from the gallery.")) return;
    arenaPost("/api/arena/maps/report", {id:id, reason:reason}).then(function(res){
      wsSay(res.ok ? "Thanks, the map was reported." : wsErr(res));
    });
    return;
  }
  if(act === "del"){
    if(!window.confirm("Delete “" + m.name + "” for good? Its likes go with it.")) return;
    arenaPost("/api/arena/maps/delete", {id:id}).then(function(res){
      if(!res.ok){ wsSay(wsErr(res)); return; }
      delete WS.byId[id];
      WS.maps = WS.maps.filter(function(x){ return x.id !== id; });
      wsRender(); wsSay("Deleted."); wsLoadFeatured();
    });
    return;
  }
  if(act === "hide" && WS.admin){
    arenaPost("/api/arena/maps/hide", {id:id, hidden:!m.hidden}).then(function(res){
      if(!res.ok){ wsSay(wsErr(res)); return; }
      wsUpdateCard(id, {hidden:!m.hidden}); wsRender(); wsLoadFeatured();
    });
  }
}

function workshopEnter(){
  var root = $("workshopView"); if(!root) return;
  // setView() can run before this file has loaded (a restored view): come back once it has.
  if(typeof WS === "undefined" || !WS){ setTimeout(function(){ if(VIEW === "workshop") workshopEnter(); }, 0); return; }
  wsCss();
  if(!WS.built) wsShell(root);
  wsLoadFeatured();
  if(WS.tab === "make") wsRender(); else wsLoad(false);
}

function workshopLeave(){ if(typeof WS === "undefined" || !WS) return; WS.gen++; WS.loading = false; }
