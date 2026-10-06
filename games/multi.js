/* Valley: multiplayer games, refereed by the Arena server (backend/app/valley.py).
 *
 * Every game here has a lobby (who's in, who hosts) with invites; the server decides
 * bites, words, damage, loot and the shared farm, and this file only draws what it says.
 * Messages: {type:"game", g, op, ...} out, {type:"game", g, ev, ...} in (via HQV.onGame).
 * Only game moves travel; nothing transcript-derived is ever sent.
 */
(function(){
"use strict";
var HQV = window.HQV; if(!HQV) return;
var api = HQV.api;
var NAMES = {pond:"Fishing Pond", race:"Puzzle Race", duel:"Creature Duel", mines:"Co-op Mines", farm:"Shared Farm"};
var LIVE = {};          // g -> {lobby:[...], ...game state from the server}

function A(){ return window.ARENA || {}; }
function me(){ var y = A().you; return y && y.userId; }
function sockOpen(){ var s = A().sock; return !!(s && s.readyState === 1); }
function send(g, op, data){
  if(!sockOpen()) return false;
  var msg = {type:"game", g:g, op:op}; for(var k in (data||{})) msg[k] = data[k];
  try { A().sock.send(JSON.stringify(msg)); return true; } catch(e){ return false; }
}
function nameOf(p){ return (p && (p.displayName || p.handle)) || "someone"; }
function st(g){ return LIVE[g] = LIVE[g] || {lobby:[]}; }

/* ---------- shared shell: connect, lobby panel, invites ---------- */
function shell(g, el, body){
  var root = api.mk("div","vg-mp"), lobbyBox = api.mk("div","vg-lobby"), gameBox = api.mk("div","vg-mp-game");
  root.appendChild(lobbyBox); root.appendChild(gameBox); el.appendChild(root);
  var tries = 0, joined = false, ctx = {g:g, lobbyBox:lobbyBox, box:gameBox, alive:true};
  (function connect(){
    if(!ctx.alive) return;
    if(!sockOpen()){
      lobbyBox.textContent = "";
      lobbyBox.appendChild(api.mk("p","vg-muted", tries ? "Connecting to the Arena…" : "Play with friends in your current Arena room."));
      if(!A().sock && tries > 4){
        lobbyBox.textContent = "";
        lobbyBox.appendChild(api.mk("p",null,"Multiplayer games run in an Arena room. Pair with an Arena server and open the Arena once to connect."));
        lobbyBox.appendChild(api.btn("Open the Arena","primary",function(){ if(window.setView) window.setView("arena"); }));
        return;
      }
      tries++; setTimeout(connect, 600); return;
    }
    if(!joined){ joined = true; send(g, "join"); }
  })();
  ctx.renderLobby = function(){ renderLobby(ctx); };
  ctx.cleanup = function(){ ctx.alive = false; if(joined) send(g, "leave"); };
  body(ctx);
  return ctx;
}
function renderLobby(ctx){
  var s = st(ctx.g), box = ctx.lobbyBox; box.textContent = "";
  var head = api.mk("div","vg-row");
  head.appendChild(api.mk("b",null,"Lobby · "+s.lobby.length+" player"+(s.lobby.length===1?"":"s")+" · room: "+(A().roomName || A().roomId || "?")));
  box.appendChild(head);
  var list = api.mk("div","vg-players");
  s.lobby.forEach(function(p){
    var chip = api.mk("span","vg-player"+(p.userId===me()?" me":""), nameOf(p)+(p.host?" ★":""));
    chip.title = p.host ? "Host" : "";
    list.appendChild(chip);
  });
  box.appendChild(list);
  // Invite: people in this Arena room who aren't in the game yet; or nudge anyone by handle.
  var inLobby = {}; s.lobby.forEach(function(p){ inLobby[p.userId] = 1; });
  var others = (A().lobby || []).filter(function(p){ return p && p.userId && !inLobby[p.userId] && p.userId !== me(); });
  var row = api.mk("div","vg-row");
  if(others.length){
    var sel = api.mk("select","vg-select"); sel.setAttribute("aria-label","Invite someone");
    others.forEach(function(p){ var o = api.mk("option",null,nameOf(p)); o.value = p.userId; o.dataset.handle = p.handle||""; sel.appendChild(o); });
    row.appendChild(sel);
    row.appendChild(api.btn("Invite","",function(){
      var o = sel.options[sel.selectedIndex]; if(!o) return;
      ctx.pendingInvite = {handle:o.dataset.handle, name:o.textContent};
      send(ctx.g, "invite", {to:o.value});
    }));
  } else row.appendChild(api.mk("span","vg-muted","Everyone online in this room is here."));
  var h = api.mk("input","vg-input"); h.placeholder = "@handle (offline friend)"; h.setAttribute("aria-label","Nudge a friend by handle"); h.maxLength = 40;
  row.appendChild(h);
  row.appendChild(api.btn("Nudge","",function(){
    var handle = h.value.replace(/^@/,"").trim(); if(!/^[A-Za-z0-9_-]{1,39}$/.test(handle)){ api.toast("Type a GitHub handle"); return; }
    nudge(handle, ctx.g); h.value = "";
  }));
  box.appendChild(row);
}
function nudge(handle, g){
  if(typeof window.arenaPost !== "function") return;
  window.arenaPost("/api/arena/nudge", {toHandle:handle, note:"Come play "+NAMES[g]+" in the Valley"}).then(function(r){
    api.toast(r && r.ok ? "👋 Nudged @"+handle : "Couldn’t nudge @"+handle);
  });
}

/* ---------- incoming: route by game ---------- */
var CTX = {};   // g -> mounted ctx
HQV.onGame = function(m){
  var g = m.g, s = st(g);
  if(m.ev === "lobby"){ s.lobby = Array.isArray(m.members) ? m.members : []; }
  if(m.ev === "error"){ if(CTX[g]) api.toast("⚠ "+String(m.error||"error").slice(0,120)); return; }
  if(m.ev === "invited"){
    var c = CTX[g];
    if(m.delivered) api.toast("Invite sent");
    else if(c && c.pendingInvite && c.pendingInvite.handle) nudge(c.pendingInvite.handle, g);   // not online: fall back to a nudge
    return;
  }
  var h = HANDLERS[g]; if(h && h.on) h.on(m, s);
  var ctx = CTX[g]; if(ctx && ctx.alive){ if(m.ev === "lobby") ctx.renderLobby(); if(h && h.render) h.render(ctx, s); }
};

function register(g, icon, desc, mount){
  HQV.register({id:"mp-"+g, mp:true, name:NAMES[g], icon:icon, desc:desc,
    mount:function(el){ CTX[g] = shell(g, el, function(ctx){ mount(ctx); }); },
    unmount:function(){ var c = CTX[g]; if(c){ c.cleanup(); if(c.stop) c.stop(); } delete CTX[g]; },
    pause:function(){ var c = CTX[g]; if(c) c.paused = true; },
    resume:function(){ var c = CTX[g]; if(c) c.paused = false; },
    badge:function(){ var s = LIVE[g]; return s && s.lobby.length ? s.lobby.length+" playing" : ""; }});
}
var HANDLERS = {};

/* =============================== POND =============================== */
HANDLERS.pond = {
  on: function(m, s){
    s.feed = s.feed || []; s.casting = s.casting || {};
    if(m.ev === "pond"){ var p = m.pond||{}; s.scores = p.scores||{}; s.goal = p.goal|0; s.goalTarget = p.goalTarget||20; s.boss = p.boss; (p.casting||[]).forEach(function(u){ s.casting[u]=1; }); }
    if(m.ev === "cast"){ s.mine = {token:m.token, fish:m.fish, rarity:m.rarity, biteAt:performance.now()+m.biteIn, phase:"wait", progress:0.3, barY:60, barV:0, fishY:75, fishV:0, target:75}; }
    if(m.ev === "casting" && m.user){ s.casting[m.user.userId] = 1; }
    if(m.ev === "caught" || m.ev === "lost"){
      if(m.user){ delete s.casting[m.user.userId]; }
      var it = api.items[m.fish], who = nameOf(m.user);
      s.feed.unshift(m.ev === "caught" ? who+" caught "+(it?it.name:m.fish)+" (+"+m.points+")" : who+" lost "+(it?it.name:"a fish"));
      s.feed = s.feed.slice(0,6);
      if(m.ev === "caught"){ s.scores = m.scores||s.scores; s.goal = m.goal|0; s.goalTarget = m.goalTarget||s.goalTarget;
        if(m.user && m.user.userId === me()){ api.inv.add(m.fish, 1); s.mine = null; } }
      else if(m.user && m.user.userId === me()) s.mine = null;
    }
    if(m.ev === "goal"){ s.feed.unshift("🎉 Room goal reached! Everyone gets a Gold Ore"); if(CTX.pond) api.inv.add("gold", 1); }
    if(m.ev === "boss" || m.ev === "bosshp"){ s.boss = m.boss; if(m.ev==="boss") { s.feed.unshift("🐉 A Merge Leviathan surfaced! Everyone hold to reel!"); api.toast("🐉 Boss fish! Everyone hold to reel it in"); } s.pulling = m.pulling|0; }
    if(m.ev === "bossdown"){ s.boss = null; s.scores = m.scores||s.scores; s.feed.unshift("🐉 The room landed the Merge Leviathan!");
      if((m.helpers||[]).indexOf(me()) >= 0) api.inv.add("leviathan", 1); }
    if(m.ev === "bossgone"){ s.boss = null; s.feed.unshift("The Leviathan slipped away…"); }
  },
  render: function(ctx, s){ if(ctx.side) drawPondSide(ctx, s); }
};
function drawPondSide(ctx, s){
  var side = ctx.side; side.textContent = "";
  var goal = api.mk("div","vg-goal"); goal.appendChild(api.mk("span",null,"Room goal: "+(s.goal|0)+"/"+(s.goalTarget||20)+" fish"));
  var gm = api.mk("div","vg-meter"), gf = api.mk("i"); gf.style.width = Math.min(100, Math.round((s.goal|0)/(s.goalTarget||20)*100))+"%"; gm.appendChild(gf); goal.appendChild(gm);
  side.appendChild(goal);
  if(s.boss){
    var b = api.mk("div","vg-boss"); b.appendChild(api.mk("b",null,"BOSS: Merge Leviathan · "+s.boss.left+"s"));
    var bm = api.mk("div","vg-meter low"), bf = api.mk("i"); bf.style.width = Math.round(s.boss.hp/s.boss.max*100)+"%"; bm.appendChild(bf); b.appendChild(bm);
    b.appendChild(api.mk("span","vg-muted","Hold Space / mouse to reel together · "+(s.pulling||0)+" pulling now"));
    side.appendChild(b);
  }
  var names = {}; (s.lobby||[]).forEach(function(p){ names[p.userId] = nameOf(p); });
  var sc = Object.keys(s.scores||{}).sort(function(a,b){ return s.scores[b]-s.scores[a]; });
  side.appendChild(api.mk("div",null,"Scores: "+(sc.length ? sc.map(function(u){ return (u===me()?"You":(names[u]||"?"))+" "+s.scores[u]; }).join(" · ") : "none yet")));
  var feed = api.mk("div","vg-feed"); feed.setAttribute("aria-live","polite");
  (s.feed||[]).forEach(function(l){ feed.appendChild(api.mk("div",null,l)); });
  if(!(s.feed||[]).length) feed.appendChild(api.mk("div","vg-muted","Catches, misses and boss fights show up here."));
  side.appendChild(feed);
}
register("pond", "🎣", "Shared dock, room goal and a boss fish", function(ctx){
  var s = st("pond"), W = 320, H = 150;
  var cv = api.canvas(W, H); cv.setAttribute("aria-label","Shared pond. Cast, then hold Space or the mouse to reel; during a boss, hold to pull together.");
  var row = api.mk("div","vg-row"); row.appendChild(api.btn("Cast","primary",function(){ if(!s.mine) send("pond","cast"); cv.focus(); }));
  var msg = api.mk("span","vg-msg"); row.appendChild(msg);
  ctx.box.appendChild(row); ctx.box.appendChild(cv);
  ctx.side = api.mk("div","vg-mp-side"); ctx.box.appendChild(ctx.side);
  var g = cv.getContext("2d"), hold = false, raf = 0, last = 0, lastPull = 0;
  function down(e){ if(e.type==="keydown" && e.key!==" ") return; e.preventDefault(); hold = true; }
  function up(e){ if(e.type==="keyup" && e.key!==" ") return; hold = false; }
  cv.addEventListener("mousedown",down); cv.addEventListener("keydown",down); cv.addEventListener("keyup",up);
  window.addEventListener("mouseup",up);
  function step(dt, t){
    var m = s.mine;
    if(s.boss && hold && t - lastPull > 160){ lastPull = t; send("pond","pull"); }
    if(!m) return;
    if(m.phase==="wait" && t >= m.biteAt){ m.phase = "reel"; }
    if(m.phase!=="reel") return;
    var sp = 0.6 + m.rarity*0.45;
    if(Math.random() < 0.02*sp) m.target = 8 + Math.random()*(H-16);
    m.fishV += (m.target - m.fishY)*0.002*sp*dt; m.fishV *= 0.92; m.fishY = Math.max(4, Math.min(H-4, m.fishY + m.fishV*dt));
    m.barV += (hold && !s.boss ? -0.012 : 0.010)*dt; m.barV = Math.max(-0.35, Math.min(0.35, m.barV)); m.barY += m.barV*dt;
    if(m.barY < 0){ m.barY = 0; m.barV = 0; } if(m.barY > H-34){ m.barY = H-34; m.barV *= -0.3; }
    var inside = m.fishY >= m.barY && m.fishY <= m.barY+34;
    m.progress += (inside ? 0.00045 : -0.0004)*dt;
    if(m.progress >= 1){ m.phase = "sent"; send("pond","land",{token:m.token}); }
    else if(m.progress <= 0){ m.phase = "sent"; send("pond","lose",{token:m.token}); }
  }
  function draw(t){
    g.imageSmoothingEnabled = false;
    g.fillStyle = "#2b5f7a"; g.fillRect(0,0,W,H-40);
    g.fillStyle = "#357590"; for(var i=0;i<7;i++) g.fillRect(((i*53+(api.calm()?0:Math.floor(t/90)))%W),12+i*14,16,1);
    g.fillStyle = "#7a5a3a"; g.fillRect(0,H-40,W,12); g.fillStyle = "#5e4329"; for(var x=0;x<W;x+=16) g.fillRect(x,H-40,1,12);
    g.fillStyle = "#3f7d3a"; g.fillRect(0,H-28,W,28);
    if(s.boss){ var bx = 120 + Math.sin(t/400)*30; g.fillStyle = "#7a3fb0"; g.fillRect(bx, 40, 60, 14); g.fillStyle = "#e2c4ff"; g.fillRect(bx+44, 44, 6, 4); }
    var players = s.lobby || [], n = Math.max(1, players.length);
    players.forEach(function(p, i){
      var x = Math.round((i+0.5)*(W-60)/n), mine = p.userId === me();
      g.fillStyle = mine ? "#3a6fd8" : "#c9a14a"; g.fillRect(x, H-52, 8, 12); g.fillStyle = "#f2c99a"; g.fillRect(x+1, H-58, 6, 6);
      g.fillStyle = "#ffffff"; g.font = "7px monospace"; g.fillText((mine?"You":nameOf(p)).slice(0,8), x-6, H-4);
      if(s.casting[p.userId] || (mine && s.mine)){ g.strokeStyle = "rgba(255,255,255,.6)"; g.beginPath(); g.moveTo(x+8,H-56); g.lineTo(x+20, H-80); g.stroke();
        g.fillStyle = "#f5f5f5"; g.fillRect(x+18, H-80, 4, 4); g.fillStyle = "#e0452f"; g.fillRect(x+18, H-83, 4, 3); }
    });
    var m = s.mine;
    if(m && m.phase==="reel"){
      g.fillStyle = "#1d3140"; g.fillRect(W-40,0,18,H-40); g.fillRect(W-18,0,6,H-40);
      var sc = (H-40)/H;
      g.fillStyle = "#6fd36a"; g.fillRect(W-38, m.barY*sc, 14, 34*sc);
      g.drawImage(api.icon(api.items[m.fish],1), W-36, m.fishY*sc-4);
      g.fillStyle = m.progress>0.66?"#6fd36a":m.progress>0.33?"#f2d14b":"#e0452f"; var ph = Math.max(0,Math.min(1,m.progress))*(H-40); g.fillRect(W-17,(H-40)-ph,4,ph);
    }
    msg.textContent = ctx.paused ? "Paused" : s.boss ? "Hold to reel the boss together!" : !m ? "Cast to fish with the room." : m.phase==="wait" ? "Waiting for a bite…" : m.phase==="reel" ? "Bite! Hold to keep the fish in the bar." : "Landing…";
  }
  function loop(t){ var dt = last ? Math.min(50, t-last) : 16; last = t; if(!ctx.paused) step(dt, t); draw(t); raf = requestAnimationFrame(loop); }
  raf = requestAnimationFrame(loop);
  var sideTimer = setInterval(function(){ drawPondSide(ctx, s); }, 1000);
  ctx.stop = function(){ cancelAnimationFrame(raf); clearInterval(sideTimer); window.removeEventListener("mouseup",up); s.mine = null; };
  drawPondSide(ctx, s);
});

/* =============================== RACE =============================== */
HANDLERS.race = {
  on: function(m, s){
    if(m.ev === "start"){ s.round = m.round; s.rows = []; s.cur = ""; s.others = {}; s.winner = null; s.word = null; s.until = Date.now() + (m.secs|0)*1000; if(m.by) api.toast("🧩 "+nameOf(m.by)+" started a puzzle race!"); }
    if(m.ev === "mark" && m.round === s.round){ s.rows.push({word:m.word, marks:m.marks}); }
    if(m.ev === "progress" && m.user && m.user.userId !== me()){ s.others[nameOf(m.user)] = {n:m.n, hits:m.hits}; }
    if(m.ev === "win"){ s.winner = m.user; s.word = m.word; s.round = null; if(m.user && m.user.userId === me()) api.inv.add("quartz", 1); }
    if(m.ev === "timeout"){ s.word = m.word; s.round = null; }
  },
  render: function(ctx, s){ renderRace(ctx, s); }
};
function renderRace(ctx, s){
  var box = ctx.box; box.textContent = "";
  if(!s.round){
    if(s.winner) box.appendChild(api.mk("p",null,"🏆 "+(s.winner.userId===me()?"You":nameOf(s.winner))+" won — the word was "+String(s.word||"").toUpperCase()));
    else if(s.word) box.appendChild(api.mk("p",null,"Time's up — the word was "+String(s.word).toUpperCase()));
    box.appendChild(api.btn("Start a race","primary",function(){ send("race","start"); }));
    box.appendChild(api.mk("p","vg-muted","Everyone in the lobby races for the same word. The server marks guesses; others only see how many letters you've got right."));
    return;
  }
  var left = Math.max(0, Math.round((s.until - Date.now())/1000));
  box.appendChild(api.mk("b",null,"Round "+s.round+" · "+left+"s left"));
  var board = api.mk("div","vg-wordle"); board.tabIndex = 0; board.setAttribute("aria-label","Race board. Type and press Enter.");
  for(var r=0;r<6;r++){
    var row = api.mk("div","vg-wrow"), g = s.rows[r], live = !g && r === s.rows.length;
    for(var c=0;c<5;c++){ var ch = g ? g.word[c] : live ? (s.cur[c]||"") : ""; row.appendChild(api.mk("span","vg-tile"+(g?" "+g.marks[c]:""), ch.toUpperCase())); }
    board.appendChild(row);
  }
  board.addEventListener("keydown", function(e){
    if(e.metaKey||e.ctrlKey||e.altKey) return;
    if(e.key==="Enter"){ e.preventDefault(); if(s.cur.length===5){ send("race","guess",{round:s.round, word:s.cur}); s.cur=""; } }
    else if(e.key==="Backspace"){ e.preventDefault(); s.cur = s.cur.slice(0,-1); renderRace(ctx, s); }
    else if(/^[a-zA-Z]$/.test(e.key) && s.cur.length<5){ e.preventDefault(); s.cur += e.key.toLowerCase(); renderRace(ctx, s); }
  });
  box.appendChild(board);
  var others = Object.keys(s.others||{});
  box.appendChild(api.mk("p","vg-muted", others.length ? others.map(function(n){ return n+": "+s.others[n].n+" guesses, "+s.others[n].hits+"/5 right"; }).join(" · ") : "Waiting for others' guesses…"));
  setTimeout(function(){ if(ctx.alive && document.activeElement && document.activeElement.tagName!=="SELECT" && document.activeElement.tagName!=="INPUT") board.focus(); }, 0);
}
register("race", "🏁", "Live puzzle race against the room", function(ctx){
  var s = st("race"); renderRace(ctx, s);
  var t = setInterval(function(){ if(s.round) renderRace(ctx, s); }, 1000); ctx.stop = function(){ clearInterval(t); };
});

/* =============================== DUEL =============================== */
// Real-Pokemon duel (games/pokebattle.js draws it). We send only {species, stage, branch,
// mega, shiny, name} per creature and a move/switch choice per turn; the server derives
// every stat and move, resolves both choices at once and sends back the ordered events.
function myDuelTeam(){
  var team = typeof window.gymTeam === "function" ? window.gymTeam() : [];
  return team.slice(0,6).map(function(m){
    var cr = m.cr || {}, br = null, mg = null;
    try { br = window.branchFinalDex(cr); } catch(e){}
    try { mg = window.pokeMega(cr); } catch(e){}
    return {sp: typeof window.pokeIdx === "function" ? window.pokeIdx(cr) : 0,
            st: typeof window.creatureStage === "function" ? Math.max(0, Math.min(4, window.creatureStage(cr)|0)) : 2,
            br: br, mg: mg, sh: !!cr.shiny, name: String(m.name||"").slice(0,24)};
  });
}
HANDLERS.duel = {
  on: function(m, s){
    s.queue = s.queue || [];
    if(m.ev === "challenge"){ s.incoming = m.from; api.toast("⚔️ "+nameOf(m.from)+" challenged you to a duel!"); }
    if(m.ev === "challenged"){ s.sent = m.to; }
    if(m.ev === "duel"){ s.duel = m.duel; if(m.duel){ s.incoming = null; s.sent = null; s.ended = null; s.queue = []; s.live = copyDuel(m.duel); } }
    if(m.ev === "waiting" && s.duel && m.mid === s.duel.mid){ s.duel.waiting = m.waiting || []; }
    if(m.ev === "turn" && m.duel){ s.queue.push({events: Array.isArray(m.events) ? m.events : [], duel: m.duel}); s.duel = m.duel; }
    if(m.ev === "duelend"){
      s.queue.push({end:m});
      if(m.winner && m.winner.userId === me()){ var b = api.save.battle; b.wins = (b.wins|0)+1; api.persist(); }
      else if(m.winner && m.duel && (m.duel.ids||[]).indexOf(me()) >= 0){ var b2 = api.save.battle; b2.losses = (b2.losses|0)+1; api.persist(); }
    }
  },
  render: function(ctx, s){ renderDuel(ctx, s); }
};
function copyDuel(d){ return JSON.parse(JSON.stringify(d)); }
// The server's {sides:{uid:...}} -> the scene's {me, foe}, from my seat (spectators sit with a).
function duelSeat(d){ var i = (d.ids||[]).indexOf(me()); return i < 0 ? 0 : i; }
function duelView(d){
  var seat = duelSeat(d), ids = d.ids || [];
  return {me: copyDuel(d.sides[ids[seat]]), foe: copyDuel(d.sides[ids[1-seat]])};
}
function duelWho(d){
  var seat = duelSeat(d), foe = seat === 0 ? d.b : d.a;
  var playing = (d.ids||[]).indexOf(me()) >= 0;
  return function(side, name, sendOut){
    if(side === seat) return sendOut ? (playing ? "Go! "+name : nameOf(seat === 0 ? d.a : d.b)+" sent out "+name) : name;
    return sendOut ? nameOf(foe)+" sent out "+name : "The foe's "+name;
  };
}
function duelChallengeRow(box, s){
  var others = (s.lobby||[]).filter(function(p){ return p.userId !== me(); });
  if(!others.length) box.appendChild(api.mk("p","vg-muted","Invite someone into this lobby to duel."));
  others.forEach(function(p){ var r = api.mk("div","vg-row"); r.appendChild(api.mk("span",null,nameOf(p)));
    r.appendChild(api.btn("Challenge","",function(){ var t = myDuelTeam(); if(!t.length){ api.toast("You need a working or idle session creature"); return; }
      send("duel","challenge",{to:p.userId, team:t}); api.toast("Challenge sent"); }));
    box.appendChild(r); });
  box.appendChild(api.mk("p","vg-muted","Your team is your working and idle session creatures, battling as the Pokémon they are now, with real moves, stats and types. Both of you choose each turn; the Arena server resolves it."));
}
function renderDuel(ctx, s){
  var box = ctx.box, d = s.duel;
  // A battle in progress (or still animating its last turn) owns the box.
  if(ctx.scene && !ctx.scene.dead && (s.queue && s.queue.length || ctx.playing || (d && d.mid === ctx.mid))){ pumpDuel(ctx, s); return; }
  if(ctx.scene && !ctx.scene.dead && ctx.endShown) return;
  box.textContent = ""; ctx.scene = null;
  if(s.incoming && !d){
    var inc = api.mk("div","vg-row"); inc.appendChild(api.mk("b",null,nameOf(s.incoming)+" challenged you!"));
    inc.appendChild(api.btn("Accept","primary",function(){ var t = myDuelTeam(); if(!t.length){ api.toast("You need a working or idle session creature"); return; } send("duel","accept",{team:t}); }));
    box.appendChild(inc);
  }
  if(!d){
    if(s.ended && s.ended.winner !== undefined) box.appendChild(api.mk("p",null, s.ended.winner ? "🏆 "+(s.ended.winner.userId===me()?"You won":nameOf(s.ended.winner)+" won")+(s.ended.forfeit?" (forfeit)":"")+"." : "It's a draw."));
    duelChallengeRow(box, s);
    return;
  }
  startDuelScene(ctx, s, d);
}
function startDuelScene(ctx, s, d){
  var P = HQV.pk, box = ctx.box;
  if(!P || !P.data()){ box.appendChild(api.mk("p","vg-muted","Loading battle data…")); return; }
  box.textContent = "";
  var playing = (d.ids||[]).indexOf(me()) >= 0;
  var head = api.mk("div","vg-row"); head.appendChild(api.mk("b",null, nameOf(d.a)+" vs "+nameOf(d.b)+(playing ? "" : " · watching")));
  box.appendChild(head);
  ctx.mid = d.mid; ctx.endShown = false; ctx.playing = false;
  s.live = copyDuel(d);
  var sc = ctx.scene = new P.Scene(box, {
    runLabel: playing ? "FORFEIT" : "LEAVE",
    onMove: function(i){ duelAct(ctx, s, {k:"move", i:i}); },
    onSwitch: function(i){ duelAct(ctx, s, {k:"switch", to:i}); },
    onRun: function(){
      if(!playing) return;
      sc.setMode("over", [{label:"Yes, forfeit", fn:function(){ send("duel","forfeit"); sc.setMode("wait", "Forfeiting…"); }},
                          {label:"Keep battling", primary:true, fn:function(){ sc.setMode("main"); }}]);
      sc.text.textContent = "Forfeit this duel?";
    }
  });
  if(ctx.paused) sc.pause();
  sc.setView(duelView(d));
  var w = duelWho(d), seat = duelSeat(d), ids = d.ids;
  var foeMon = d.sides[ids[1-seat]].team[d.sides[ids[1-seat]].active], myMon = d.sides[ids[seat]].team[d.sides[ids[seat]].active];
  ctx.playing = true;
  sc.intro([w(1-seat, foeMon.name, true)+"!", w(seat, myMon.name, true)+"!"]).then(function(){ ctx.playing = false; pumpDuel(ctx, s); });
  clearInterval(ctx.duelTimer);
  ctx.duelTimer = setInterval(function(){ duelPrompt(ctx, s); }, 1000);
  var oldStop = ctx.stop;
  ctx.stop = function(){ clearInterval(ctx.duelTimer); if(ctx.scene) ctx.scene.destroy(); if(oldStop) oldStop(); };
}
function duelAct(ctx, s, a){
  var d = s.live; if(!d || ctx.playing || !ctx.scene || ctx.scene.busy) return;
  if(send("duel","act",{turn:d.turn, a:a})){ ctx.acted = d.turn+":"+d.phase; duelPrompt(ctx, s); }
}
// One queued server turn at a time, animated in order; then the prompt for the next choice.
function pumpDuel(ctx, s){
  if(ctx.playing || !ctx.scene || ctx.scene.dead) return;
  var item = (s.queue||[]).shift();
  if(!item){ duelPrompt(ctx, s); return; }
  var sc = ctx.scene;
  if(item.end){
    var m = item.end; s.ended = m; s.duel = null; ctx.endShown = true;
    ctx.playing = true;
    var line = !m.winner ? "It's a draw!" : m.winner.userId === me() ? (m.forfeit ? "Your opponent forfeited. You win!" : "You won the duel!") :
      (m.duel && (m.duel.ids||[]).indexOf(me()) >= 0 ? (m.forfeit ? "You forfeited." : "You lost the duel.") : nameOf(m.winner)+" won the duel!");
    sc.setMode("busy");
    sc.say(line, 600).then(function(){
      ctx.playing = false;
      sc.setMode("over", [{label:"Back to the lobby", primary:true, fn:function(){ clearInterval(ctx.duelTimer); sc.destroy(); ctx.scene = null; ctx.endShown = false; renderDuel(ctx, s); }}]);
    });
    return;
  }
  ctx.playing = true;
  var d = item.duel, seat = duelSeat(d);
  sc.play(item.events, seat, duelWho(d)).then(function(){
    ctx.playing = false;
    s.live = copyDuel(d); ctx.acted = null;
    if(!sc.dead){ sc.setView(duelView(d)); pumpDuel(ctx, s); }
  });
}
function duelPrompt(ctx, s){
  var sc = ctx.scene, d = s.live;
  if(!sc || sc.dead || ctx.playing || ctx.endShown || !d || (s.queue && s.queue.length) || sc.mode === "over") return;
  var cur = s.duel && s.duel.mid === d.mid ? s.duel : d;
  var playing = (d.ids||[]).indexOf(me()) >= 0, waiting = cur.waiting || [];
  if(!ctx.deadlineFor || ctx.deadlineFor !== d.turn+":"+d.phase){ ctx.deadlineFor = d.turn+":"+d.phase; ctx.deadline = Date.now() + (d.deadline_in|0)*1000; ctx.poked = false; }
  var left = Math.max(0, Math.round((ctx.deadline - Date.now())/1000));
  if(left <= 0 && !ctx.poked){ ctx.poked = true; send("duel","poke"); }
  var mine = playing && waiting.indexOf(me()) >= 0 && ctx.acted !== d.turn+":"+d.phase;
  if(mine){
    var want = d.phase === "replace" ? "replace" : (sc.mode === "fight" || sc.mode === "team" ? sc.mode : "main");
    if(sc.mode !== want) sc.setMode(want);
    sc.cmd.setAttribute("data-left", left+"s");
    return;
  }
  var who = waiting.filter(function(u){ return u !== me(); }).map(function(u){ return u === d.a.userId ? nameOf(d.a) : nameOf(d.b); });
  var txt = playing ? "Waiting for "+(who.join(" and ") || "the server")+"… "+left+"s" : "Watching · "+(who.length ? who.join(" and ")+" choosing… "+left+"s" : "");
  if(sc.mode !== "wait" || sc.modeInfo !== txt) sc.setMode("wait", txt);
}
register("duel", "⚔️", "Live Pokémon battles with friends", function(ctx){ renderDuel(ctx, st("duel")); });

/* =============================== MINES =============================== */
HANDLERS.mines = {
  on: function(m, s){
    if(m.ev === "mines"){ s.run = m.run; if(m.note) s.note = m.note; if(m.by && m.run) api.toast("⛏️ "+nameOf(m.by)+" started a co-op mine run"); }
    if(m.ev === "loot"){ var got = []; Object.keys(m.items||{}).forEach(function(id){ var n = m.items[id]|0; if(n>0 && api.items[id]){ api.inv.add(id, n); got.push(n+" "+api.items[id].name); } });
      api.toast(m.fainted ? "You fainted and kept half: "+(got.join(", ")||"nothing") : "Climbed out with "+(got.join(", ")||"nothing")); }
    if(m.ev === "minesend"){ s.run = null; s.note = "Run over — deepest floor "+m.depth+"."; }
  },
  render: function(ctx, s){ renderMines(ctx, s); }
};
var MCOL = ["#3a6fd8","#d8433a","#3aa86a","#c9a14a","#8a3fd8","#d83aa0","#3ac9c9","#e07b25"];
function renderMines(ctx, s){
  var box = ctx.box; box.textContent = "";
  var r = s.run;
  if(!r){
    if(s.note) box.appendChild(api.mk("p",null,s.note));
    box.appendChild(api.btn("Start a co-op run","primary",function(){ send("mines","start"); }));
    box.appendChild(api.mk("p","vg-muted","Everyone in the lobby goes down together. Loot belongs to whoever breaks the rock; slimes chase the nearest miner."));
    return;
  }
  var T = 16, cv = api.canvas(12*T, 8*T), g = cv.getContext("2d"); g.imageSmoothingEnabled = false;
  for(var y=0;y<r.grid.length;y++) for(var x=0;x<r.grid[y].length;x++){
    var c = r.grid[y][x]; g.fillStyle = "#6e5a48"; g.fillRect(x*T,y*T,T,T);
    if(c==="rock"){ g.fillStyle = "#8a8a96"; g.fillRect(x*T+2,y*T+2,T-4,T-4); g.fillStyle="#4a4a52"; g.fillRect(x*T+4,y*T+5,3,3); }
    if(c==="ladder"){ g.fillStyle = "#c9a14a"; g.fillRect(x*T+3,y*T,2,T); g.fillRect(x*T+11,y*T,2,T); for(var k=2;k<T;k+=5) g.fillRect(x*T+3,y*T+k,10,2); }
  }
  (r.slimes||[]).forEach(function(sl){ g.fillStyle = "#5ac85a"; g.fillRect(sl[0]*T+3, sl[1]*T+6, 10, 8); });
  var keys = Object.keys(r.players||{});
  keys.forEach(function(uid, i){ var p = r.players[uid]; if(p.out) return; g.fillStyle = MCOL[i%MCOL.length]; g.fillRect(p.x*T+4, p.y*T+3, 8, 11); if(uid===me()){ g.strokeStyle="#ffffff"; g.strokeRect(p.x*T+3.5, p.y*T+2.5, 9, 12); } });
  var info = api.mk("div","vg-row"); info.appendChild(api.mk("b",null,"Floor "+r.depth));
  keys.forEach(function(uid, i){ var p = r.players[uid], loot = (r.loot||{})[uid]||{}, n = Object.keys(loot).reduce(function(a,k){ return a+loot[k]; },0);
    var chip = api.mk("span","vg-player", (uid===me()?"You":p.name)+" "+"♥".repeat(Math.max(0,p.hp))+(p.out?" (out)":"")+" · "+n+" loot"); chip.style.borderColor = MCOL[i%MCOL.length]; info.appendChild(chip); });
  box.appendChild(info);
  cv.setAttribute("aria-label","Co-op mine floor "+r.depth+". Arrow keys or WASD move.");
  cv.addEventListener("keydown", function(e){
    var d = {ArrowUp:[0,-1],ArrowDown:[0,1],ArrowLeft:[-1,0],ArrowRight:[1,0],w:[0,-1],s:[0,1],a:[-1,0],d:[1,0]}[e.key];
    if(d && !ctx.paused){ e.preventDefault(); send("mines","move",{dx:d[0], dy:d[1]}); }
  });
  box.appendChild(cv);
  if(s.note) box.appendChild(api.mk("p","vg-msg",s.note));
  var mine = r.players[me()];
  if(mine && !mine.out) box.appendChild(api.btn("Climb out with your loot","",function(){ send("mines","exit"); }));
  setTimeout(function(){ if(ctx.alive && (!document.activeElement || document.activeElement===document.body || document.activeElement.tagName==="CANVAS")) cv.focus(); }, 0);
}
register("mines", "⛏️", "Dig the same floor together", function(ctx){ renderMines(ctx, st("mines")); });

/* =============================== FARM =============================== */
HANDLERS.farm = {
  on: function(m, s){
    if(m.ev === "farm"){ s.farm = m.farm; }
    if(m.ev === "note"){ s.notes = [String(m.text||"").slice(0,80)].concat(s.notes||[]).slice(0,5); }
    if(m.ev === "harvest" && api.items[m.crop]){ api.inv.add(m.crop, m.n|0); api.toast("🧺 You harvested "+api.items[m.crop].name+" ×"+(m.n|0)); }
  },
  render: function(ctx, s){ renderFarm(ctx, s); }
};
function renderFarm(ctx, s){
  var box = ctx.box; box.textContent = "";
  var f = s.farm; if(!f){ box.appendChild(api.mk("p","vg-muted","Loading the room's farm…")); return; }
  var head = api.mk("div","vg-row");
  head.appendChild(api.mk("span","vg-muted", f.gardeners+" gardener"+(f.gardeners===1?"":"s")+" · "+f.season+" · Water is the gardeners' published prompts since planting."));
  var sb = api.btn("Open the room's seed box","",function(){ send("farm","seeds"); }); sb.disabled = !f.seedBoxOpen; head.appendChild(sb);
  box.appendChild(head);
  var grid = api.mk("div","vg-garden");
  (f.plots||[]).forEach(function(p, i){
    var cell = api.mk("div","vg-plot"+(p && p.ripe ? " ripe" : ""));
    if(!p){
      var seeds = Object.keys(f.seeds||{}).filter(function(k){ return f.seeds[k]>0 && api.items[k]; });
      cell.appendChild(api.mk("span","vg-soil-empty","Empty"));
      if(seeds.length){ var sel = api.mk("select","vg-select"); sel.setAttribute("aria-label","Plant in plot "+(i+1)); sel.appendChild(api.mk("option",null,"Plant…"));
        seeds.forEach(function(k){ var o = api.mk("option",null,api.items[k].name+" ("+f.seeds[k]+")"); o.value = k; sel.appendChild(o); });
        sel.addEventListener("change", function(){ if(sel.value) send("farm","plant",{plot:i, crop:sel.value}); }); cell.appendChild(sel); }
    } else {
      var it = api.items[p.crop]; cell.appendChild(api.iconEl(p.crop, 4));
      cell.appendChild(api.mk("b",null,(it?it.name:p.crop)));
      cell.appendChild(api.mk("span","vg-muted","by "+p.by));
      if(p.ripe) cell.appendChild(api.btn("Harvest","primary",function(){ send("farm","harvest",{plot:i}); }));
      else { cell.appendChild(api.mk("span","vg-muted","Water "+p.water+"/"+p.need+(p.hoursLeft>0?" · "+p.hoursLeft+"h":"")));
        var w = api.mk("div","vg-meter"), fi = api.mk("i"); fi.style.width = Math.round(Math.min(p.water/p.need, 1)*100)+"%"; w.appendChild(fi); cell.appendChild(w); }
    }
    grid.appendChild(cell);
  });
  box.appendChild(grid);
  (s.notes||[]).forEach(function(n){ box.appendChild(api.mk("div","vg-muted",n)); });
}
register("farm", "🌾", "One garden the whole room grows", function(ctx){ renderFarm(ctx, st("farm")); });
})();
