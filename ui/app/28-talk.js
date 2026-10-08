/* ================= HQ 2.1: talk where you stand ================= */
// In the 3D HQ your Arena room follows you: Arena City ("hq_city"), the HQ you are visiting
// ("hq_<their id>") or your own open HQ ("hq_<your id>"). Chat and voice in the room you are in
// reach the people standing around you; a small chat panel sits over the scene, and the call
// overlay (20-arena-voice.js) floats as usual once you join voice. It never pulls you out of a
// call: in voice somewhere else, it offers to move instead. Leaving the HQ view takes you back to
// the room you were in before.
var TALK = {open:true, prev:null, refused:null, offer:null, sig:""};
try { TALK.open = localStorage.getItem("hq_talk_open") !== "0"; } catch(e){}

// The Arena room for where you stand in the HQ view, or null (not in the HQ view, or private and home).
function hqTalkRoom(){
  if(typeof VIEW==="undefined" || VIEW!=="hq" || typeof HQ3D==="undefined" || !HQ3D || !HQ3D.inst) return null;
  if(HQ3D.visit && HQ3D.visit.userId) return "hq_"+HQ3D.visit.userId;
  if(typeof hqCityOn!=="function" || !hqCityOn()) return null;
  return HQ3D.world==="city" ? "hq_city" : "hq_"+HQ_REMOTE.me;
}
function hqTalkPlace(room){
  if(room==="hq_city") return "Arena City";
  if(HQ3D.visit && room==="hq_"+HQ3D.visit.userId){ var v=HQ3D.visit; return (v.trainerName||v.displayName||v.handle||"Their")+"'s HQ"; }
  return "Your HQ";
}
function hqTalkShowing(){ return typeof VIEW!=="undefined" && VIEW==="hq" && TALK.open && !!hqTalkRoom(); }

// Follow: once a second, put the Arena room where you are (or back where you were).
function hqTalkFollow(){
  if(typeof ARENA==="undefined" || typeof arenaGoRoom!=="function") return;
  var want=hqTalkRoom(), here=ARENA.roomId;
  TALK.offer=null;
  if(want){
    if(here===want || TALK.refused===want) return;
    if(VCHAN.on){ TALK.offer=want; return; }                 // never drop a call: offer instead
    if(!arenaIsHqRoom(here)) TALK.prev=here;
    arenaGoRoom(want, {name: hqTalkPlace(want)});
    return;
  }
  TALK.refused=null;
  if(arenaIsHqRoom(here) && !VCHAN.on) arenaGoRoom(TALK.prev && !arenaIsHqRoom(TALK.prev) ? TALK.prev : "lobby");
}
// The Arena would not let us into that place (closed, or an Arena without HQ rooms): stay where we were.
function hqTalkRefused(rid){
  TALK.refused=rid;
  arenaGoRoom(TALK.prev && !arenaIsHqRoom(TALK.prev) ? TALK.prev : "lobby");
  hqTalkRender();
}

function hqTalkLineEl(line){
  var row=document.createElement("div"); row.className="talk-line"+(line.sys?" sys":"")+(line.you?" you":"");
  if(line.sys){ row.textContent=line.text; return row; }
  var who=document.createElement("b"); who.textContent=line.who; row.appendChild(who);
  var txt=document.createElement("span"); txt.className="talk-txt";
  if(typeof arenaRenderMessageText==="function") arenaRenderMessageText(txt, line.text); else txt.textContent=line.text;
  row.appendChild(txt);
  return row;
}
function hqTalkLine(line){
  var log=$("hqTalkLog"); if(!log || !hqTalkShowing() || ARENA.roomId!==hqTalkRoom()) return;
  var stick=log.scrollHeight-log.scrollTop-log.clientHeight<40;
  var e=log.querySelector(".talk-empty"); if(e) e.remove();
  log.appendChild(hqTalkLineEl(line));
  while(log.children.length>40) log.removeChild(log.firstChild);
  if(stick || line.you) log.scrollTop=log.scrollHeight;
}
function hqTalkHead(){
  var h=$("hqTalkHead"); if(!h) return;
  var room=hqTalkRoom(), n=(ARENA.lobby||[]).length, live=room && ARENA.roomId===room && ARENA.sock && ARENA.sock.readyState===1;
  h.textContent=(VCHAN.on && VCHAN.roomId===room ? "🎙 " : "💬 ")+hqTalkPlace(room)+(live ? " · "+n+" here" : " · connecting…");
}
function hqTalkRender(){
  var box=$("hqTalk"); if(!box) return;
  var room=hqTalkRoom();
  box.hidden=!room;
  if(!room) return;
  box.classList.toggle("closed", !TALK.open);
  var tg=$("hqTalkToggle"); if(tg){ tg.textContent=TALK.open ? "–" : "+"; tg.setAttribute("aria-expanded", TALK.open ? "true" : "false"); tg.title=TALK.open ? "Hide chat" : "Show chat"; }
  hqTalkHead();
  var log=$("hqTalkLog"), here=ARENA.roomId===room;
  if(log){
    log.textContent="";
    var lines=here ? ARENA.chat.slice(-40) : [];
    if(!lines.length){ var e=document.createElement("p"); e.className="talk-empty muted";
      e.textContent = TALK.refused===room ? "This Arena can't host talk here yet." : here ? "Say hi to whoever's around 👋" : "Connecting…"; log.appendChild(e); }
    lines.forEach(function(l){ log.appendChild(hqTalkLineEl(l)); });
    log.scrollTop=log.scrollHeight;
  }
  var inp=$("hqTalkInput"), send=$("hqTalkSend"), ok=here && ARENA.sock && ARENA.sock.readyState===1;
  if(inp){ inp.disabled=!ok; inp.placeholder= ok ? "Message "+hqTalkPlace(room)+"…" : "Connecting…"; }
  if(send) send.disabled=!ok;
  var vb=$("hqTalkVoice");
  if(vb){
    if(TALK.offer){ vb.textContent="Talk here"; vb.title="You're in voice in "+(ARENA.roomName||"another room")+": leave it and move here"; }
    else { vb.textContent= VCHAN.on ? "Leave voice" : "🎙 Join voice"; vb.title= VCHAN.on ? "Leave the voice call" : "Talk with everyone here (microphone)"; }
    vb.disabled = !TALK.offer && !ok;
    vb.classList.toggle("on", VCHAN.on && !TALK.offer);
  }
}
function hqTalkSend(){
  var i=$("hqTalkInput"); if(!i) return;
  var text=(i.value||"").trim().slice(0, ARENA_CHAT_MAX); if(!text) return;
  var ws=ARENA.sock; if(!ws || ws.readyState!==1 || ARENA.roomId!==hqTalkRoom()) return;
  var now=Date.now(); if(now-ARENA_CHAT_LAST<700) return; ARENA_CHAT_LAST=now;
  try { ws.send(JSON.stringify({type:"say", data:{kind:"chat", text:text}})); } catch(e){ return; }
  i.value="";
}
function hqTalkVoice(){
  if(TALK.offer){ var to=TALK.offer; voiceLeave(); TALK.offer=null; if(!arenaIsHqRoom(ARENA.roomId)) TALK.prev=ARENA.roomId; arenaGoRoom(to, {name: hqTalkPlace(to)}); return; }
  if(VCHAN.on) voiceLeave(); else voiceJoin();
  setTimeout(hqTalkRender, 300);
}
(function(){
  var t=$("hqTalkToggle"); if(t) t.addEventListener("click", function(){ TALK.open=!TALK.open; try { localStorage.setItem("hq_talk_open", TALK.open ? "1" : "0"); } catch(e){} hqTalkRender(); });
  var s=$("hqTalkSend"); if(s) s.addEventListener("click", hqTalkSend);
  var i=$("hqTalkInput"); if(i) i.addEventListener("keydown", function(e){ if(e.key==="Enter"){ e.preventDefault(); hqTalkSend(); } });
  var v=$("hqTalkVoice"); if(v) v.addEventListener("click", hqTalkVoice);
  setInterval(function(){
    hqTalkFollow();
    var sig=[hqTalkRoom(), ARENA.roomId, !!(ARENA.sock && ARENA.sock.readyState===1), VCHAN.on, TALK.offer, TALK.open, TALK.refused].join("|");
    if(sig!==TALK.sig){ TALK.sig=sig; hqTalkRender(); } else hqTalkHead();
  }, 1000);
})();
