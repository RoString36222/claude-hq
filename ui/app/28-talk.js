/* ================= HQ 2.1: talk in the HQ ================= */
// One chat and one voice call everywhere: the HQ's chat panel is your Arena room's chat (the Lobby,
// or the private room you are in), the same one the Arena tab shows, and its voice button joins the
// same call that floats over every view (20-arena-voice.js). Walking around the HQ or the city, or
// going to the Valley or the Arena, never changes who you are talking to.
var TALK = {open:true, sig:""};
try { TALK.open = localStorage.getItem("hq_talk_open") !== "0"; } catch(e){}

// The Arena room the panel talks in while you are in the HQ view (null elsewhere, or unpaired).
function hqTalkRoom(){
  if(typeof VIEW==="undefined" || VIEW!=="hq" || typeof ARENA==="undefined" || !ARENA.paired) return null;
  return ARENA.roomId || "lobby";
}
function hqTalkPlace(){ return ARENA.roomId==="lobby" ? "Lobby" : (ARENA.roomName || "your room"); }
function hqTalkShowing(){ return typeof VIEW!=="undefined" && VIEW==="hq" && TALK.open && !!hqTalkRoom(); }
// An earlier version moved the room to the HQ place you stood in; never stay stuck in one of those.
function hqTalkFollow(){
  if(typeof ARENA==="undefined" || typeof arenaIsHqRoom!=="function") return;
  if(arenaIsHqRoom(ARENA.roomId) && !VCHAN.on) arenaGoRoom("lobby");
}
function hqTalkRefused(){ arenaGoRoom("lobby"); }

function hqTalkLineEl(line){
  var row=document.createElement("div"); row.className="talk-line"+(line.sys?" sys":"")+(line.you?" you":"");
  if(line.sys){ row.textContent=line.text; return row; }
  if(line.avatar){ var img=document.createElement("img"); img.src=line.avatar; img.alt=""; img.loading="lazy"; row.appendChild(img); }
  var body=document.createElement("div"); body.className="talk-body-line";
  var who=document.createElement("b"); who.textContent=line.who; if(line.handle) who.title="@"+line.handle;
  var at=document.createElement("small"); at.className="talk-at"; at.textContent=new Date(line.at).toLocaleTimeString([], {hour:"2-digit", minute:"2-digit"});
  var txt=document.createElement("div"); txt.className="talk-txt";
  if(typeof arenaRenderMessageText==="function") arenaRenderMessageText(txt, line.text); else txt.textContent=line.text;
  body.appendChild(who); body.appendChild(at); body.appendChild(txt); row.appendChild(body);
  return row;
}
function hqTalkLine(line){
  var log=$("hqTalkLog"); if(!log || !hqTalkShowing()) return;
  var stick=log.scrollHeight-log.scrollTop-log.clientHeight<40;
  var e=log.querySelector(".talk-empty"); if(e) e.remove();
  log.appendChild(hqTalkLineEl(line));
  while(log.children.length>40) log.removeChild(log.firstChild);
  if(stick || line.you) log.scrollTop=log.scrollHeight;
}
function hqTalkHead(){
  var h=$("hqTalkHead"); if(!h) return;
  var n=(ARENA.lobby||[]).length, live=!!(ARENA.sock && ARENA.sock.readyState===1);
  h.textContent=(VCHAN.on ? "🎙 " : "💬 ")+hqTalkPlace()+(live ? " · "+n+" online" : " · connecting…");
}
function hqTalkRender(){
  var box=$("hqTalk"); if(!box) return;
  var room=hqTalkRoom();
  box.hidden=!room;
  if(!room) return;
  box.classList.toggle("closed", !TALK.open);
  var tg=$("hqTalkToggle"); if(tg){ tg.textContent=TALK.open ? "–" : "+"; tg.setAttribute("aria-expanded", TALK.open ? "true" : "false"); tg.title=TALK.open ? "Hide chat" : "Show chat"; }
  hqTalkHead();
  var log=$("hqTalkLog"), here=true;
  if(log){
    log.textContent="";
    var lines=here ? ARENA.chat.slice(-40) : [];
    if(!lines.length){ var e=document.createElement("p"); e.className="talk-empty muted";
      e.textContent = "No messages yet. Say hi 👋"; log.appendChild(e); }
    lines.forEach(function(l){ log.appendChild(hqTalkLineEl(l)); });
    log.scrollTop=log.scrollHeight;
  }
  var inp=$("hqTalkInput"), send=$("hqTalkSend"), ok=!!(ARENA.sock && ARENA.sock.readyState===1);
  if(inp){ inp.disabled=!ok; inp.placeholder= ok ? "Message "+hqTalkPlace()+"…" : "Connecting…"; }
  if(send) send.disabled=!ok;
  var vb=$("hqTalkVoice");
  if(vb){
    vb.textContent= VCHAN.on ? "Leave voice" : "🎙 Join voice";
    vb.title= VCHAN.on ? "Leave the voice call (it follows you to every view)" : "Join "+hqTalkPlace()+"'s voice call: the same call as the Arena's, wherever you go";
    vb.disabled = !ok;
    vb.classList.toggle("on", VCHAN.on);
  }
}
function hqTalkSend(){
  var i=$("hqTalkInput"); if(!i) return;
  var text=(i.value||"").trim().slice(0, ARENA_CHAT_MAX); if(!text) return;
  var ws=ARENA.sock; if(!ws || ws.readyState!==1) return;
  var now=Date.now(); if(now-ARENA_CHAT_LAST<700) return; ARENA_CHAT_LAST=now;
  try { ws.send(JSON.stringify({type:"say", data:{kind:"chat", text:text}})); } catch(e){ return; }
  i.value="";
}
function hqTalkVoice(){
  if(VCHAN.on) voiceLeave(); else voiceJoin();
  setTimeout(hqTalkRender, 300);
}
(function(){
  var t=$("hqTalkToggle"); if(t) t.addEventListener("click", function(){ TALK.open=!TALK.open; try { localStorage.setItem("hq_talk_open", TALK.open ? "1" : "0"); } catch(e){} hqTalkRender(); });
  var s=$("hqTalkSend"); if(s) s.addEventListener("click", hqTalkSend);
  var i=$("hqTalkInput");
  if(i){
    if(typeof arenaMentionBind==="function") arenaMentionBind(i);          // @mentions, as in the Arena's chat
    // Enter sends, unless the mention list is open (then Enter picks a name)
    // (the mention handler runs first and marks the event handled when it picks a name)
    i.addEventListener("keydown", function(e){ if(e.key==="Enter" && !e.defaultPrevented){ e.preventDefault(); hqTalkSend(); } });
  }
  var v=$("hqTalkVoice"); if(v) v.addEventListener("click", hqTalkVoice);
  setInterval(function(){
    hqTalkFollow();
    var sig=[hqTalkRoom(), ARENA.roomId, !!(ARENA.sock && ARENA.sock.readyState===1), VCHAN.on, TALK.open].join("|");
    if(sig!==TALK.sig){ TALK.sig=sig; hqTalkRender(); } else hqTalkHead();
  }, 1000);
})();
