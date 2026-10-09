/* ---- Arena rooms ---- */
function arenaWantSocket(){ return VIEW==="arena" || VCHAN.on || (ARENA_STAY && ARENA.paired) || (typeof hqTalkRoom==="function" && !!hqTalkRoom()) || (typeof muWantsSocket==="function" && muWantsSocket()); }
// A socket that was working comes back almost at once (a blip should not freeze a game for
// seconds); after that the wait doubles from 1 s up to 30 s, with jitter so a restarted
// server is not hit by every page in the same instant.
function arenaRetryLater(){
  if(arenaWantSocket() && !ARENA.retry){
    var n = ARENA.fails++;
    var wait = n === 0 ? 250 + Math.random()*500 : Math.min(30000, 1000 * Math.pow(2, n - 1)) * (0.8 + Math.random()*0.4);
    ARENA.retry = setTimeout(function(){ ARENA.retry=null; arenaOpenSocket(); }, wait);
  }
}
// The network came back (wifi, laptop wake): don't sit out the rest of a long backoff.
window.addEventListener("online", function(){
  if(!ARENA.retry || ARENA.sock || ARENA.opening) return;
  clearTimeout(ARENA.retry); ARENA.retry = null; arenaOpenSocket();
});
// A Quick Play match room (HQ 2.1): made by the Arena's matchmaker, only for the people it matched.
function arenaIsQp(id){ return typeof id==="string" && /^qp_[0-9a-f]{12}$/.test(id); }
// A place in the 3D HQ (HQ 2.1 talk): Arena City ("hq_city") or someone's HQ ("hq_<user id>"). The
// Arena room follows you there while you are in the HQ view, so chat and voice reach whoever stands near you.
function arenaIsHqRoom(id){ return typeof id==="string" && /^hq_(city|[0-9a-f-]{36})$/.test(id); }
function arenaRoomRemember(id){
  if(arenaIsQp(id) || arenaIsHqRoom(id)) return;
  try { if(id==="lobby") localStorage.removeItem("hq_arena_room"); else localStorage.setItem("hq_arena_room", id); } catch(e){}
}
function arenaRoomClean(r){
  if(!r || typeof r !== "object") return null;
  if(typeof r.id !== "string" || !ARENA_ROOM_RE.test(r.id)) return null;
  if(typeof r.name !== "string" || !r.name) return null;
  var online = (typeof r.online === "number" && r.online >= 0 && r.online <= 9999) ? r.online : 0;
  var mc = (typeof r.memberCount === "number" && r.memberCount >= 0 && r.memberCount <= 9999) ? r.memberCount : 0;
  var role = (r.role === "owner" || r.role === "member" || r.role === "banned") ? r.role : null;
  return {id:r.id, name:r.name.slice(0,40), ownerUserId:(typeof r.ownerUserId==="string"?r.ownerUserId:""),
    ownerHandle:(typeof r.ownerHandle==="string"?r.ownerHandle.slice(0,40):""),
    ownerName:(typeof r.ownerName==="string"?r.ownerName.slice(0,40):""),
    online:online, memberCount:mc, role:role};
}
function arenaRoomReason(res){
  return String(res.j.error || res.j.detail || ("HTTP " + res.status)).slice(0, 200);
}
function arenaRoomGone(res){
  var reason = arenaRoomReason(res);
  if(res.status===404 && /^not found$/i.test(reason)){ arenaRoomsUnsupported(); return true; }
  return false;
}
function arenaRoomInsecure(){
  if(!ARENA.status || !ARENA.status.url) return false;
  var u = ARENA.status.url;
  if(!/^http:\/\//.test(u)) return false;
  var host = u.replace(/^http:\/\//, "").split(/[:/]/)[0].toLowerCase();
  return host !== "127.0.0.1" && host !== "localhost" && host !== "[::1]";
}
function arenaRoomNote(text, retry){
  var el=$("arenaRoomNote"), t=$("arenaRoomNoteText"), rb=$("arenaRoomRetry");
  if(!el||!t) return;
  t.textContent = text;
  el.classList.remove("hidden");
  if(rb) rb.classList.toggle("hidden", !retry);
}
function arenaRoomNoteHide(){
  var el=$("arenaRoomNote"); if(el) el.classList.add("hidden");
}
function arenaRoomsLoad(){
  if(ARENA.roomsLoading) return ARENA.roomsLoading;
  var p = fetch("/api/arena/rooms",{cache:"no-store"}).then(function(r){
    var ok = r.ok, status = r.status;
    return r.json().catch(function(){ return {}; }).then(function(j){
      ARENA.roomsLoading = null;
      var reason = String(j.error || j.detail || ("HTTP " + status)).slice(0,200);
      if(status === 404 && /^not found$/i.test(reason)){ arenaRoomsUnsupported(); return "unsupported"; }
      if(!ok || !Array.isArray(j.rooms)){ arenaRoomNote("Couldn’t load rooms — " + reason, true); return "error"; }
      ARENA.roomsOk = true;
      ARENA.rooms = j.rooms.map(arenaRoomClean).filter(Boolean);
      ARENA.lobbyOnline = (typeof j.lobbyOnline === "number") ? j.lobbyOnline : null;
      ARENA.limits = j.limits || {nameMax:40, passwordMin:6, passwordMax:128};
      var conf = {};
      ARENA.rooms.forEach(function(r){ if(r.role==="owner"||r.role==="member") conf[r.id]=true; });
      ARENA.roomConfirmed = conf;
      arenaRoomNoteHide();
      if(ARENA.roomId !== "lobby" && !arenaIsQp(ARENA.roomId) && !arenaIsHqRoom(ARENA.roomId) && !conf[ARENA.roomId]){
        var e = null;
        ARENA.rooms.forEach(function(r){ if(r.id===ARENA.roomId) e=r; });
        arenaRoomFallback(ARENA.roomId, e ? 4406 : 4404, e && e.role==="banned" ? "removed from this room" : (e ? "not a member of this room" : "no such room"));
      } else if(ARENA.roomId !== "lobby"){
        var entry = null;
        ARENA.rooms.forEach(function(r){ if(r.id===ARENA.roomId) entry=r; });
        if(entry){ ARENA.roomName = entry.name; ARENA.roomRole = entry.role; }
      }
      arenaRenderRoomBar(); arenaRenderRooms();
      return "ok";
    });
  }).catch(function(){ ARENA.roomsLoading=null; arenaRoomNote("Couldn’t reach Claude HQ", true); return "error"; });
  ARENA.roomsLoading = p;
  return p;
}
function arenaRoomsUnsupported(){
  ARENA.roomsOk = false; ARENA.rooms = null; ARENA.roomConfirmed = {};
  if(ARENA.roomId !== "lobby") arenaGoRoom("lobby");
  arenaRoomNote("This Arena server has one shared lobby — rooms need a newer server.", false);
  arenaRenderRoomBar();
}
function arenaRoomTarget(){
  if(ARENA.roomId === "lobby" || ARENA.roomsOk === false) return "lobby";
  if(arenaIsQp(ARENA.roomId) || arenaIsHqRoom(ARENA.roomId)) return ARENA.roomId;
  if(ARENA.roomConfirmed[ARENA.roomId]) return ARENA.roomId;
  return null;
}
function arenaRenderRoomBar(){
  var n = $("arenaRoomName"), meta = $("arenaRoomMeta"), bar = $("arenaRoomBar");
  var back = $("arenaRoomBack"), settings = $("arenaRoomSettingsBtn"), scope = $("arenaChatScope");
  if(n) n.textContent = ARENA.roomName || "your room";
  var mText = ARENA.roomId === "lobby" ? "everyone · who’s online" : arenaIsQp(ARENA.roomId) ? "Quick Play match · who’s here" : arenaIsHqRoom(ARENA.roomId) ? "in the 3D HQ · who’s here" : "private room · who’s online";
  if(ARENA.roomClose === 4429) mText += " · room is full, retrying";
  if(!ARENA.sock && arenaWantSocket()) mText += " · reconnecting…";
  if(meta) meta.textContent = mText;
  if(bar) bar.classList.toggle("hidden", ARENA.roomsOk !== true);
  if(back) back.classList.toggle("hidden", ARENA.roomId === "lobby");
  if(settings) settings.classList.toggle("hidden", ARENA.roomId === "lobby");
  var ownerPanel = $("arenaRoomOwner"), delBtn = $("arenaRoomDelete"), bannedW = $("arenaRoomBannedWrap");
  if(ownerPanel) ownerPanel.classList.toggle("hidden", ARENA.roomRole !== "owner");
  if(delBtn) delBtn.classList.toggle("hidden", ARENA.roomRole !== "owner");
  if(bannedW) bannedW.classList.toggle("hidden", ARENA.roomRole !== "owner");
  if(scope) scope.textContent = "everyone in " + (ARENA.roomName || "the room");
  // http warning toggle
  var insecure = arenaRoomInsecure();
  Array.prototype.forEach.call(document.querySelectorAll(".arena-room-http"), function(el){ el.classList.toggle("hidden", !insecure); });
}
function arenaRenderRooms(){
  var ul = $("arenaRoomRows"), filter = $("arenaRoomFilter");
  if(!ul) return;
  if(ARENA.roomJoinOpen) return;
  ul.innerHTML = "";
  var rooms = ARENA.rooms || [];
  if(filter) filter.classList.toggle("hidden", rooms.length <= 8);
  var q = (filter && !filter.classList.contains("hidden")) ? (filter.value||"").toLowerCase() : "";
  // Lobby row
  if(!q || "lobby".indexOf(q) >= 0){
    var lobbyLi = document.createElement("li");
    lobbyLi.className = "arena-room-row" + (ARENA.roomId === "lobby" ? " here" : "");
    if(ARENA.roomId === "lobby") lobbyLi.setAttribute("aria-current", "true");
    var lobbyInfo = document.createElement("div"); lobbyInfo.className = "arena-room-info";
    var lobbyN = document.createElement("strong"); lobbyN.textContent = "Lobby";
    var lobbyM = document.createElement("small");
    lobbyM.textContent = "everyone" + (ARENA.lobbyOnline != null ? (" · " + ARENA.lobbyOnline + " online") : "");
    lobbyInfo.appendChild(lobbyN); lobbyInfo.appendChild(lobbyM);
    lobbyLi.appendChild(lobbyInfo);
    if(ARENA.roomId === "lobby"){
      var lb = document.createElement("button"); lb.className = "hbtn"; lb.disabled = true; lb.textContent = "You’re here"; lobbyLi.appendChild(lb);
    } else {
      var lb = document.createElement("button"); lb.className = "hbtn"; lb.textContent = "Enter";
      lb.setAttribute("aria-label", "Enter Lobby");
      lb.addEventListener("click", function(){ arenaGoRoom("lobby"); });
      lobbyLi.appendChild(lb);
    }
    ul.appendChild(lobbyLi);
  }
  // Room rows
  var shown = 0;
  rooms.forEach(function(r){
    if(q && r.name.toLowerCase().indexOf(q) < 0 && r.ownerHandle.toLowerCase().indexOf(q) < 0) return;
    shown++;
    var li = document.createElement("li");
    li.className = "arena-room-row" + (ARENA.roomId === r.id ? " here" : "");
    if(ARENA.roomId === r.id) li.setAttribute("aria-current", "true");
    var info = document.createElement("div"); info.className = "arena-room-info";
    var nm = document.createElement("bdi"); nm.dir = "auto";
    var lockIcon = document.createElementNS("http://www.w3.org/2000/svg","svg");
    lockIcon.setAttribute("class","i"); lockIcon.setAttribute("aria-hidden","true");
    lockIcon.style.width="14px"; lockIcon.style.height="14px"; lockIcon.style.verticalAlign="middle"; lockIcon.style.marginRight="4px";
    var use = document.createElementNS("http://www.w3.org/2000/svg","use");
    use.setAttributeNS("http://www.w3.org/1999/xlink","href","#i-lock");
    lockIcon.appendChild(use);
    nm.appendChild(lockIcon);
    nm.appendChild(document.createTextNode(r.name));
    var meta = document.createElement("small");
    meta.textContent = "by @" + r.ownerHandle + " · " + r.online + " online · " + r.memberCount + " member" + (r.memberCount===1?"":"s");
    info.appendChild(nm); info.appendChild(meta);
    li.appendChild(info);
    if(ARENA.roomId === r.id){
      var b = document.createElement("button"); b.className="hbtn"; b.disabled=true; b.textContent="You’re here"; li.appendChild(b);
    } else if(r.role==="owner" || r.role==="member"){
      var b = document.createElement("button"); b.className="hbtn"; b.textContent="Enter";
      b.setAttribute("aria-label","Enter room "+r.name);
      (function(rid,entry){ b.addEventListener("click",function(){ arenaGoRoom(rid,entry); }); })(r.id,r);
      li.appendChild(b);
    } else if(r.role==="banned"){
      var b = document.createElement("button"); b.className="hbtn"; b.disabled=true; b.textContent="Removed"; li.appendChild(b);
    } else {
      var b = document.createElement("button"); b.className="hbtn"; b.textContent="Join…";
      b.setAttribute("aria-expanded","false"); b.setAttribute("aria-label","Join room "+r.name);
      (function(entry,row,btn){ btn.addEventListener("click",function(){ arenaRoomOpenJoin(entry,row,btn); }); })(r,li,b);
      li.appendChild(b);
    }
    ul.appendChild(li);
  });
  if(!rooms.length && !q){
    var emptyLi = document.createElement("li"); emptyLi.className = "muted";
    emptyLi.textContent = "No rooms yet — make one for your crew.";
    ul.appendChild(emptyLi);
    var nb = $("arenaRoomNew"); if(nb) nb.classList.add("on");
  }
}
function arenaRoomOpenJoin(entry, li, toggleBtn){
  // Close any other open join form
  var prev = document.querySelector(".arena-room-join");
  if(prev) prev.parentNode.removeChild(prev);
  ARENA.roomJoinOpen = entry.id;
  var form = document.createElement("form");
  form.className = "arena-room-join"; form.autocomplete = "off";
  var lbl = document.createElement("label"); lbl.className = "sr-only"; lbl.textContent = "Password for " + entry.name;
  var inp = document.createElement("input"); inp.type = "password"; inp.autocomplete = "off"; inp.maxLength = 128; inp.required = true;
  lbl.htmlFor = "arenaRoomJoinPw_" + entry.id; inp.id = lbl.htmlFor;
  var joinBtn = document.createElement("button"); joinBtn.className = "hbtn on"; joinBtn.type = "submit"; joinBtn.textContent = "Join";
  var cancelBtn = document.createElement("button"); cancelBtn.className = "hbtn"; cancelBtn.type = "button"; cancelBtn.textContent = "Cancel";
  var errEl = document.createElement("div"); errEl.className = "arena-msg err hidden"; errEl.setAttribute("role","alert");
  form.appendChild(lbl); form.appendChild(inp); form.appendChild(joinBtn); form.appendChild(cancelBtn);
  if(arenaRoomInsecure()){
    var warn = document.createElement("p"); warn.className = "arena-msg err arena-room-http"; warn.textContent = "This Arena server doesn’t use https, so the password crosses the network unencrypted.";
    form.appendChild(warn);
  }
  form.appendChild(errEl);
  li.appendChild(form);
  inp.focus();
  form.addEventListener("submit", function(e){ e.preventDefault(); arenaRoomJoin(entry, form, inp, errEl); });
  cancelBtn.addEventListener("click", function(){ arenaRoomCloseJoin(form, toggleBtn); });
  inp.addEventListener("keydown", function(e){ if(e.key==="Escape"){ e.preventDefault(); arenaRoomCloseJoin(form, toggleBtn); } });
}
function arenaRoomCloseJoin(form, toggleBtn){
  if(form && form.parentNode) form.parentNode.removeChild(form);
  ARENA.roomJoinOpen = null;
  if(toggleBtn){ toggleBtn.setAttribute("aria-expanded","false"); toggleBtn.focus(); }
  arenaRenderRooms();
}
function arenaGoRoom(id, info){
  if(id !== "lobby" && !ARENA_ROOM_RE.test(id) && !arenaIsQp(id) && !arenaIsHqRoom(id)) return;
  if(id === ARENA.roomId && (ARENA.sock || ARENA.opening)) return;
  if(VCHAN.on){ voiceLeave(); if(!ARENA._fallback) toast("Left voice — voice is per room","ach"); }
  arenaCloseSocket();
  ARENA.chatBy[ARENA.roomId] = {chat:ARENA.chat, seen:ARENA.chatSeen};
  var c = ARENA.chatBy[id] || {chat:[], seen:{}};
  ARENA.chat = c.chat; ARENA.chatSeen = c.seen; arenaRenderChat();
  ARENA.roomId = id;
  ARENA.roomName = (id === "lobby") ? "Lobby" : ((info && info.name) || "");
  ARENA.roomRole = (info && info.role) || null;
  arenaRoomRemember(id);
  ARENA.peerStatus = {}; ARENA.fails = 0; ARENA.roomClose = 0; ARENA.roomAnnounce = true;
  arenaUnreadClear(); arenaMentionClose(); arenaRoomPanelsClose();
  arenaRenderRoomBar(); arenaRenderRooms();
  if(arenaWantSocket()) arenaOpenSocket();
}
function arenaRoomFallback(id, code, reason){
  ARENA._fallback = true;
  if(VCHAN.on) voiceLeave();
  delete ARENA.roomConfirmed[id]; delete ARENA.chatBy[id];
  var name = ARENA.roomName || "that room";
  var msg;
  if(code === 4404) msg = "“" + name + "” was deleted — you’re back in the Lobby";
  else if(reason === "removed from this room") msg = "You were removed from “" + name + "” — you’re back in the Lobby";
  else if(reason === "room password changed") msg = "The password for “" + name + "” changed — enter the new one to rejoin";
  else if(reason === "you left this room") msg = "You left “" + name + "” on another device";
  else msg = "You’re no longer a member of “" + name + "” — you’re back in the Lobby";
  toast(msg, "ach"); announce(msg);
  arenaGoRoom("lobby");
  ARENA._fallback = false;
  arenaRoomsLoad().then(function(r){
    if(reason === "room password changed" && r === "ok"){
      var sw = $("arenaRoomSwitch"); if(sw) sw.click();
      var entry = null;
      (ARENA.rooms||[]).forEach(function(rm){ if(rm.id===id) entry=rm; });
      if(entry){
        setTimeout(function(){
          var rows = document.querySelectorAll("#arenaRoomRows li");
          for(var i=0;i<rows.length;i++){
            var joinBtn = rows[i].querySelector("button[aria-expanded]");
            if(joinBtn && joinBtn.getAttribute("aria-label")==="Join room "+entry.name){
              joinBtn.click(); break;
            }
          }
        }, 100);
      }
    }
  });
}
function arenaRoomCreate(e){
  e.preventDefault();
  var nameIn = $("arenaRoomNameIn"), pwIn = $("arenaRoomPwIn"), errEl = $("arenaRoomCreateErr"), goBtn = $("arenaRoomCreateGo");
  if(!nameIn||!pwIn||!errEl||!goBtn) return;
  var limits = ARENA.limits || {nameMax:40, passwordMin:6, passwordMax:128};
  var name = nameIn.value.replace(/\s+/g," ").trim();
  if(!name || name.length > limits.nameMax){ errEl.textContent="Room names are 1–"+limits.nameMax+" characters."; errEl.classList.remove("hidden"); return; }
  var pw = pwIn.value; pwIn.value = "";
  if(pw.length < limits.passwordMin || pw.length > limits.passwordMax){ errEl.textContent="Passwords are "+limits.passwordMin+"–"+limits.passwordMax+" characters."; errEl.classList.remove("hidden"); return; }
  goBtn.disabled = true; errEl.classList.add("hidden");
  arenaPost("/api/arena/rooms/create",{name:name,password:pw}).then(function(res){
    goBtn.disabled = false;
    if(arenaRoomGone(res)) return;
    if(!res.ok){ errEl.textContent=arenaRoomReason(res); errEl.classList.remove("hidden"); return; }
    var room = arenaRoomClean(res.j.room);
    if(!room){ errEl.textContent="Unexpected server response."; errEl.classList.remove("hidden"); return; }
    nameIn.value = ""; arenaRoomPanelsClose();
    ARENA.roomConfirmed[room.id] = true;
    toast("Created “"+room.name+"” — share the name and password with your friends","level");
    arenaGoRoom(room.id, room);
    arenaRoomsLoad();
    var rn=$("arenaRoomName"); if(rn) rn.focus();
  }).catch(function(){ goBtn.disabled=false; errEl.textContent="Request failed."; errEl.classList.remove("hidden"); });
}
function arenaRoomJoin(entry, form, inp, errEl){
  var pw = inp.value; inp.value = "";
  if(!pw){ errEl.textContent="Enter the room’s password."; errEl.classList.remove("hidden"); inp.focus(); return; }
  var joinBtn = form.querySelector("button[type=submit]");
  if(joinBtn) joinBtn.disabled = true;
  errEl.classList.add("hidden");
  arenaPost("/api/arena/rooms/join",{roomId:entry.id,password:pw}).then(function(res){
    if(joinBtn) joinBtn.disabled = false;
    if(arenaRoomGone(res)) return;
    if(!res.ok){
      errEl.textContent = arenaRoomReason(res); errEl.classList.remove("hidden"); inp.focus(); return;
    }
    ARENA.roomConfirmed[entry.id] = true;
    arenaRoomPanelsClose();
    toast("Joined “"+entry.name+"”","level");
    arenaGoRoom(entry.id, entry);
    arenaRoomsLoad();
    var rn=$("arenaRoomName"); if(rn) rn.focus();
  }).catch(function(){ if(joinBtn) joinBtn.disabled=false; errEl.textContent="Request failed."; errEl.classList.remove("hidden"); });
}
function arenaRoomLeaveAction(){
  var id = ARENA.roomId, name = ARENA.roomName || "this room";
  if(id === "lobby") return;
  var msg = ARENA.roomRole === "owner"
    ? "Leave “"+name+"”? Ownership passes to the member who joined earliest; if nobody else is in it, the room is deleted."
    : "Leave “"+name+"”? You’ll need the password to get back in.";
  if(!confirm(msg)) return;
  arenaGoRoom("lobby");
  arenaPost("/api/arena/rooms/leave",{roomId:id}).then(function(res){
    if(arenaRoomGone(res)) return;
    if(!res.ok){ toast("⚠ "+arenaRoomReason(res),"ach"); arenaRoomsLoad(); return; }
    delete ARENA.roomConfirmed[id]; delete ARENA.chatBy[id];
    var extra = "";
    if(res.j.deleted) extra = " — it was deleted because nobody else was in it";
    else if(res.j.newOwnerHandle) extra = " — @"+res.j.newOwnerHandle+" is the owner now";
    toast("You left “"+name+"”"+extra,"level");
    arenaRoomsLoad();
  }).catch(function(){ toast("⚠ Leave request failed","ach"); });
}
function arenaRoomDeleteAction(){
  var id = ARENA.roomId, name = ARENA.roomName || "this room";
  if(!confirm("Delete “"+name+"” for everyone? Everyone in it goes back to the Lobby.")) return;
  arenaGoRoom("lobby");
  arenaPost("/api/arena/rooms/delete",{roomId:id}).then(function(res){
    if(arenaRoomGone(res)) return;
    if(!res.ok){ toast("⚠ "+arenaRoomReason(res),"ach"); arenaRoomsLoad(); return; }
    toast("Deleted “"+name+"”","level");
    arenaRoomsLoad();
  }).catch(function(){ toast("⚠ Delete request failed","ach"); });
}
function arenaRoomRenameAction(e){
  e.preventDefault();
  var inp = $("arenaRoomRenameIn"), msg = $("arenaRoomMsg");
  if(!inp) return;
  var name = inp.value.replace(/\s+/g," ").trim();
  var limits = ARENA.limits || {nameMax:40};
  if(!name || name.length > limits.nameMax){ if(msg){ msg.textContent="Name must be 1–"+limits.nameMax+" characters."; msg.classList.remove("hidden"); } return; }
  arenaPost("/api/arena/rooms/rename",{roomId:ARENA.roomId,name:name}).then(function(res){
    if(arenaRoomGone(res)) return;
    if(!res.ok){ if(msg){ msg.textContent=arenaRoomReason(res); msg.classList.remove("hidden"); } return; }
    var room = arenaRoomClean(res.j.room);
    if(room) ARENA.roomName = room.name;
    arenaRenderRoomBar();
    if(msg){ msg.textContent="Renamed"; msg.classList.remove("hidden"); setTimeout(function(){ msg.classList.add("hidden"); },3000); }
  });
}
function arenaRoomSetPasswordAction(e){
  e.preventDefault();
  var inp = $("arenaRoomNewPw"), chk = $("arenaRoomSignOut"), msg = $("arenaRoomSettingsErr");
  if(!inp) return;
  var pw = inp.value; inp.value = "";
  var limits = ARENA.limits || {passwordMin:6, passwordMax:128};
  if(pw.length < limits.passwordMin || pw.length > limits.passwordMax){
    if(msg){ msg.textContent="Passwords are "+limits.passwordMin+"–"+limits.passwordMax+" characters."; msg.classList.remove("hidden"); }
    return;
  }
  var signOut = chk ? chk.checked : false;
  arenaPost("/api/arena/rooms/password",{roomId:ARENA.roomId,password:pw,signOutOthers:signOut}).then(function(res){
    if(arenaRoomGone(res)) return;
    if(!res.ok){ if(msg){ msg.textContent=arenaRoomReason(res); msg.classList.remove("hidden"); } return; }
    var extra = (res.j.signedOut > 0) ? " · signed out " + res.j.signedOut + " people" : "";
    var rmsg = $("arenaRoomMsg");
    if(rmsg){ rmsg.textContent = "Password changed" + extra; rmsg.classList.remove("hidden"); setTimeout(function(){ rmsg.classList.add("hidden"); },4000); }
    if(chk) chk.checked = false;
  });
}
function arenaRoomMembersLoad(){
  if(ARENA.roomId === "lobby") return;
  fetch("/api/arena/rooms/members?roomId=" + encodeURIComponent(ARENA.roomId),{cache:"no-store"})
    .then(function(r){ return r.json(); })
    .then(function(j){
      var memEl = $("arenaRoomMembers"), banEl = $("arenaRoomBanned"), banWrap = $("arenaRoomBannedWrap");
      if(!memEl) return;
      memEl.innerHTML = ""; if(banEl) banEl.innerHTML = "";
      var members = Array.isArray(j.members) ? j.members : [];
      var banned = Array.isArray(j.banned) ? j.banned : [];
      members.forEach(function(m){
        var li = document.createElement("li"); li.style.display="flex"; li.style.alignItems="center"; li.style.gap="8px";
        if(m.avatarUrl && /^https:\/\//.test(m.avatarUrl)){
          var img = document.createElement("img"); img.src=m.avatarUrl; img.alt=""; img.style.width="20px"; img.style.height="20px"; img.style.borderRadius="50%"; li.appendChild(img);
        }
        var info = document.createElement("span");
        info.textContent = (m.displayName||m.handle||"?") + " @" + (m.handle||"?");
        if(m.role==="owner"){ var tag = document.createElement("small"); tag.style.color="var(--faint)"; tag.textContent=" owner"; info.appendChild(tag); }
        li.appendChild(info);
        if(m.online){ var dot = document.createElement("span"); dot.className="arena-dot"; li.appendChild(dot); }
        if(ARENA.roomRole==="owner" && m.role!=="owner"){
          var kb = document.createElement("button"); kb.className="hbtn"; kb.textContent="Remove";
          kb.setAttribute("aria-label","Remove "+(m.displayName||m.handle)+" from "+ARENA.roomName);
          (function(member){ kb.addEventListener("click",function(){ arenaRoomKick(member, kb); }); })(m);
          li.appendChild(kb);
        }
        memEl.appendChild(li);
      });
      if(banEl && banned.length){
        banned.forEach(function(m){
          var li = document.createElement("li"); li.style.display="flex"; li.style.alignItems="center"; li.style.gap="8px";
          var info = document.createElement("span");
          info.textContent = (m.displayName||m.handle||"?") + " @" + (m.handle||"?");
          li.appendChild(info);
          var ub = document.createElement("button"); ub.className="hbtn"; ub.textContent="Unban";
          (function(member){ ub.addEventListener("click",function(){ arenaRoomUnban(member, ub); }); })(m);
          li.appendChild(ub);
        });
        if(banWrap) banWrap.classList.remove("hidden");
      } else { if(banWrap) banWrap.classList.add("hidden"); }
    }).catch(function(){});
}
function arenaRoomKick(m, btn){
  if(!confirm("Remove "+(m.displayName||m.handle)+" from “"+(ARENA.roomName||"this room")+"”? They won’t be able to rejoin unless you unban them.")) return;
  btn.disabled = true;
  arenaPost("/api/arena/rooms/kick",{roomId:ARENA.roomId,userId:m.userId}).then(function(res){
    btn.disabled = false;
    if(arenaRoomGone(res)) return;
    if(!res.ok){ toast("⚠ "+arenaRoomReason(res),"ach"); return; }
    toast("Removed "+(m.displayName||m.handle),"level");
    arenaRoomMembersLoad();
  }).catch(function(){ btn.disabled=false; });
}
function arenaRoomUnban(m, btn){
  btn.disabled = true;
  arenaPost("/api/arena/rooms/unban",{roomId:ARENA.roomId,userId:m.userId}).then(function(res){
    btn.disabled = false;
    if(arenaRoomGone(res)) return;
    if(!res.ok){ toast("⚠ "+arenaRoomReason(res),"ach"); return; }
    toast("Unbanned "+(m.displayName||m.handle),"level");
    arenaRoomMembersLoad();
  }).catch(function(){ btn.disabled=false; });
}
function arenaRoomOnMsg(m, rid){
  if(!m.room || m.room.id !== rid) return;
  if(typeof m.room.name === "string" && m.room.name) ARENA.roomName = m.room.name.slice(0, 40);
  if(typeof m.room.ownerUserId === "string" && ARENA.you){
    ARENA.roomRole = (m.room.ownerUserId === ARENA.you.userId) ? "owner" : "member";
  }
  arenaRenderRoomBar(); arenaRoomsLoad();
  var sp = $("arenaRoomSettings"); if(sp && !sp.classList.contains("hidden")) arenaRoomMembersLoad();
}
function arenaRoomPanelsClose(){
  var ids = ["arenaRoomList","arenaRoomCreate","arenaRoomSettings"];
  ids.forEach(function(id){ var el=$(id); if(el) el.classList.add("hidden"); });
  var btns = ["arenaRoomSwitch","arenaRoomNew","arenaRoomSettingsBtn"];
  btns.forEach(function(id){ var el=$(id); if(el) el.setAttribute("aria-expanded","false"); });
  if(ARENA.roomsTimer){ clearInterval(ARENA.roomsTimer); ARENA.roomsTimer=null; }
  arenaRoomFormsClear();
}
function arenaRoomFormsClear(){
  var pw=$("arenaRoomPwIn"); if(pw) pw.value="";
  var npw=$("arenaRoomNewPw"); if(npw) npw.value="";
  var joins = document.querySelectorAll(".arena-room-join");
  Array.prototype.forEach.call(joins, function(f){ if(f.parentNode) f.parentNode.removeChild(f); });
  ARENA.roomJoinOpen = null;
  var show = $("arenaRoomPwShow");
  if(show){ show.setAttribute("aria-pressed","false"); var pi=$("arenaRoomPwIn"); if(pi) pi.type="password"; }
}
// Wire-up
(function(){
  var sw=$("arenaRoomSwitch"), nw=$("arenaRoomNew"), back=$("arenaRoomBack"), stBtn=$("arenaRoomSettingsBtn");
  var list=$("arenaRoomList"), create=$("arenaRoomCreate"), settings=$("arenaRoomSettings");
  var retry=$("arenaRoomRetry"), show=$("arenaRoomPwShow"), filter=$("arenaRoomFilter");
  var renameForm=$("arenaRoomRenameForm"), pwForm=$("arenaRoomPwForm");
  var leaveBtn=$("arenaRoomLeave"), delBtn=$("arenaRoomDelete");
  function togglePanel(panel, btn, others){
    var open = panel.classList.contains("hidden");
    others.forEach(function(o){ if(o.el) o.el.classList.add("hidden"); if(o.btn) o.btn.setAttribute("aria-expanded","false"); });
    panel.classList.toggle("hidden", !open);
    btn.setAttribute("aria-expanded", open?"true":"false");
    return open;
  }
  if(sw) sw.addEventListener("click", function(){
    var opened = togglePanel(list, sw, [{el:create,btn:nw},{el:settings,btn:stBtn}]);
    if(opened){
      arenaRoomsLoad();
      ARENA.roomsTimer = setInterval(function(){ if(VIEW==="arena" && !document.hidden) arenaRoomsLoad(); }, 30000);
    } else { if(ARENA.roomsTimer){ clearInterval(ARENA.roomsTimer); ARENA.roomsTimer=null; } }
  });
  if(nw) nw.addEventListener("click", function(){
    var opened = togglePanel(create, nw, [{el:list,btn:sw},{el:settings,btn:stBtn}]);
    if(opened){ var ni=$("arenaRoomNameIn"); if(ni) ni.focus(); }
  });
  if(back) back.addEventListener("click", function(){ arenaGoRoom("lobby"); });
  if(stBtn) stBtn.addEventListener("click", function(){
    var opened = togglePanel(settings, stBtn, [{el:list,btn:sw},{el:create,btn:nw}]);
    if(opened){
      var ri=$("arenaRoomRenameIn"); if(ri) ri.value = ARENA.roomName||"";
      arenaRoomMembersLoad();
    }
  });
  if(show) show.addEventListener("click", function(){
    var pi=$("arenaRoomPwIn"); if(!pi) return;
    var hidden = pi.type==="password";
    pi.type = hidden ? "text" : "password";
    show.setAttribute("aria-pressed", hidden?"true":"false");
    show.textContent = hidden ? "Hide" : "Show";
  });
  if(retry) retry.addEventListener("click", function(){ arenaRoomNoteHide(); arenaRoomsLoad(); });
  if(filter) filter.addEventListener("input", function(){ arenaRenderRooms(); });
  if(create) create.addEventListener("submit", arenaRoomCreate);
  var cancelBtn=$("arenaRoomCreateCancel");
  if(cancelBtn) cancelBtn.addEventListener("click", function(){
    create.classList.add("hidden"); nw.setAttribute("aria-expanded","false"); nw.focus();
  });
  if(renameForm) renameForm.addEventListener("submit", arenaRoomRenameAction);
  if(pwForm) pwForm.addEventListener("submit", arenaRoomSetPasswordAction);
  if(leaveBtn) leaveBtn.addEventListener("click", arenaRoomLeaveAction);
  if(delBtn) delBtn.addEventListener("click", arenaRoomDeleteAction);
  // Escape closes open panels
  [list, create, settings].forEach(function(panel){
    if(!panel) return;
    panel.addEventListener("keydown", function(e){
      if(e.key !== "Escape") return;
      e.preventDefault(); arenaRoomPanelsClose();
      if(panel===list && sw) sw.focus();
      else if(panel===create && nw) nw.focus();
      else if(panel===settings && stBtn) stBtn.focus();
    });
  });
})();


/* Websocket lobby. The page never sees the device token: dashboard.py mints a
   short-lived ticket and we connect with that. */
function arenaOpenSocket(){
  if(ARENA.sock || ARENA.opening) return;
  var rid = arenaRoomTarget();
  if(rid === null){ var _g = ARENA.gen; arenaRoomsLoad().then(function(r){ if(_g !== ARENA.gen || ARENA.sock || ARENA.opening || !arenaWantSocket()) return; if(arenaRoomTarget() !== null) arenaOpenSocket(); else if(r === "error") arenaRetryLater(); }); return; }
  ARENA.opening = true;
  var gen = ARENA.gen;   // arenaCloseSocket() while the ticket is on its way cancels this
  arenaPost("/api/arena/ticket").then(function(res){
    if(gen !== ARENA.gen) return;
    ARENA.opening = false;
    if(ARENA.sock) return;
    if(!res.ok || !res.j.ticket || !res.j.wsUrl){
      if(!res.status || res.status >= 500) arenaRetryLater();   // the Arena is down or restarting
      return;
    }
    var url = res.j.wsUrl + "/v1/rooms/" + encodeURIComponent(rid) + "/ws?ticket=" + encodeURIComponent(res.j.ticket);
    var ws;
    try { ws = new WebSocket(url); } catch(e){ return; }
    ARENA.sock = ws;
    ws.onmessage = function(ev){
      var m; try { m = JSON.parse(ev.data); } catch(e){ return; }
      if(!m || typeof m !== "object") return;
      if(m.type==="welcome"){
        ARENA.welcomedIn = rid;
        // Who we are: the nudge buttons skip us, and our own chat lines are marked.
      var info = (m.roomInfo && typeof m.roomInfo === "object") ? m.roomInfo : null;
      if(rid !== "lobby" && !arenaIsHqRoom(rid) && !(info && (info.kind === "private" || (info.kind === "quickplay" && arenaIsQp(rid))) && info.id === rid)){ arenaRoomsUnsupported(); return; }
      if(rid === "lobby") ARENA.roomName = "Lobby"; else if(info && typeof info.name === "string" && info.name) ARENA.roomName = info.name.slice(0, 40);
      ARENA.roomRole = (info && (info.role === "owner" || info.role === "member")) ? info.role : null;
      ARENA.roomClose = 0; arenaRenderRoomBar();
        ARENA.you = (m.you && typeof m.you === "object") ? m.you : null;
        // Which games this Arena runs, at what protocol version (null from an Arena older than 2.0).
        ARENA.arena = (m.arena && typeof m.arena === "object" && m.arena.games && typeof m.arena.games === "object") ? m.arena : null;
        ARENA.fails = 0;
        arenaRenderLobby(m.members||[]);
        var n = Array.isArray(m.members) ? m.members.length : 1;
        // Recent messages the server kept for people joining (none from a server without chat history).
        if(Array.isArray(m.chat)) m.chat.forEach(function(c){ if(c && typeof c === "object") arenaChatReceive(c, true); });
        arenaChatSys("You joined " + ARENA.roomName + " \u00b7 " + n + " online");
        arenaChatReady(true);
        if(VCHAN.on && VCHAN.roomId !== rid) voiceLeave();
        voiceOnLobby();
        arenaStatusOnLobby();
        if(ARENA.roomAnnounce){ ARENA.roomAnnounce = false; announce("Now in " + ARENA.roomName); }
        pantryLoad();   // "coming online": also where today's coins get auto-collected
        if(typeof partySync==="function") partySync();
        if(typeof musicOnWelcome==="function") musicOnWelcome();
      }
      else if(m.type==="join" || m.type==="leave"){
        arenaRenderLobby(m.members||[]);
        // your own other tabs / sockets coming and going is not news
        if(m.member && !(ARENA.you && m.member.userId === ARENA.you.userId)) arenaChatSys(arenaWho(m.member) + (m.type==="join" ? " joined" : " left"));
        if(m.type==="leave") voiceOnLeave(m);
      }
      else if(m.type==="say"){
        var kind = m.data && m.data.kind;
        if(kind==="voice") voiceOnAnnounce(m); else if(kind==="mudj"){ if(typeof musicOnSay==="function") musicOnSay(m); } else if(kind==="status") arenaOnStatus(m); else if(kind==="evo") arenaOnEvo(m);
        else if(kind==="game"){ if(window.HQV && window.HQV.onSay){ try{ window.HQV.onSay(m); }catch(e){} } }
        else arenaChatReceive(m);
      }
      else if(m.type==="signal"){ if(m.data && m.data.kind==="mudj"){ if(typeof musicOnSignal==="function") musicOnSignal(m); } else voiceOnSignal(m); }
      else if(m.type==="nudge"){ arenaOnNudge(m); }
      else if(m.type==="gift"){ arenaOnGift(m); }
      else if(m.type==="room"){ arenaRoomOnMsg(m, rid); }
      else if(m.type==="game"){ valleyOnGame(m); }
      else if(m.type==="music"){ if(typeof musicOnMsg==="function") musicOnMsg(m); }
      else if(m.type==="nudge_ack"){ toast(m.delivered ? "\uD83D\uDC4B Nudge sent" : "They\u2019re not in this room right now", m.delivered?"level":"ach"); }
      else if(m.type==="error" && typeof m.error==="string" && m.error.indexOf("chat: ")===0){
        arenaChatSys(m.error.slice(6, 120));   // e.g. the server's flood guard: "slow down \u2014 \u2026"
      }
    };
    ws.onclose = function(ev){
      if(ARENA.sock !== ws) return;
      ARENA.sock = null;
      arenaLobbyGone();
      var code = ev ? ev.code : 0;
      // an HQ place we could not enter (closed meanwhile, or an older Arena): back to where you were
      if(arenaIsHqRoom(rid) && ARENA.welcomedIn !== rid){ if(typeof hqTalkRefused==="function") hqTalkRefused(rid); return; }
      if(arenaIsQp(rid) && code === 4403){ toast("That Quick Play match has ended — you’re back in the Lobby","ach"); arenaGoRoom("lobby"); return; }
      if(rid !== "lobby" && (code === 4404 || code === 4406)){ arenaRoomFallback(rid, code, (ev && ev.reason) || ""); return; }
      ARENA.roomClose = code;
      arenaRenderRoomBar();
      arenaRetryLater();
    };
    ws.onerror = function(){ try { ws.close(); } catch(e){} };
  }, function(){ if(gen === ARENA.gen){ ARENA.opening = false; arenaRetryLater(); } });
}

function arenaCloseSocket(){
  ARENA.gen++; ARENA.opening = false;
  if(ARENA.retry){ clearTimeout(ARENA.retry); ARENA.retry=null; }
  var s = ARENA.sock;
  if(s){ ARENA.sock = null; try { s.close(); } catch(e){} arenaLobbyGone(); }
}

// Our lobby socket is gone: show it, and drop what only lived on it.
function arenaLobbyGone(){
  arenaRenderLobby(null);
  arenaChatReady(false);
  arenaRenderRoomBar();
  voiceOnLobbyLost();
  ARENA.peerStatus = {};
  if(typeof musicOnLost==="function") musicOnLost();
}

function arenaRenderLobby(members){
  // Remembered so a leaderboard nudge can fall back to the lobby socket.
  ARENA.lobby = members || [];
  var el=$("arenaLobby"); if(!el) return;
  el.innerHTML = "";
  if(!members){ el.innerHTML = '<span class="muted">Offline</span>'; return; }
  if(!members.length){ el.innerHTML = '<span class="muted">Just you.</span>'; return; }
  // Forget the status of anyone who's left.
  var here = {}; members.forEach(function(m){ if(m && typeof m.userId === "string") here[m.userId] = 1; });
  Object.keys(ARENA.peerStatus).forEach(function(u){ if(!here[u]) delete ARENA.peerStatus[u]; });
  members.forEach(function(m){
    var chip = document.createElement("span"); chip.className = "arena-peer";
    var dot = document.createElement("span"); dot.className = "arena-dot";
    if(m.avatarUrl){
      var img=document.createElement("img"); img.src=m.avatarUrl; img.alt=""; chip.appendChild(img);
    } else { chip.appendChild(dot); }
    var t=document.createElement("span"); t.textContent = m.displayName || m.handle;
    chip.appendChild(t);
    if(typeof cosFrameApply==="function") cosFrameApply(chip, m.cos && m.cos.frame);
    var mine = !!(ARENA.you && m.userId===ARENA.you.userId);
    var st = mine ? (ARENA_SHARE_STATUS ? arenaMyCounts() : null) : ARENA.peerStatus[m.userId];
    if(st) chip.appendChild(arenaStatusEl(st, mine ? "you" : (m.displayName || m.handle)));
    var mc = typeof muChipFor==="function" ? muChipFor(m.userId) : null; if(mc) chip.appendChild(mc);
    if(!ARENA.you || m.userId!==ARENA.you.userId){
      var nb=document.createElement("button"); nb.className="arena-nudge"; nb.type="button";
      nb.textContent="\uD83D\uDC4B nudge"; nb.title="Nudge "+(m.displayName||m.handle)+" to check the Arena";
      nb.addEventListener("click", function(){ arenaSendNudge(m); });
      chip.appendChild(nb);
      if(typeof m.handle==="string" && m.handle) chip.appendChild(arenaGiftButton(m.handle, m.displayName || m.handle, "\uD83C\uDF81 gift"));
    }
    el.appendChild(chip);
  });
}

/* ---- Arena lobby: presence and live status ----
   "Stay in the lobby on every view" (on unless you turn it off) keeps the lobby socket open wherever you are in HQ
   while this machine is paired: friends see you online, and chat, nudges and calls reach you. "Share my live
   status" (off unless you turn it on) adds two numbers to your lobby entry: how many of your sessions are working
   and how many are waiting on you. Nothing else about them leaves this machine: no titles, folders or text.
     say {kind:"status", op:"set", working, needs}   your counts, when they change (at most every 2 s)
     say {kind:"status", op:"clear"}                 you stopped sharing
     say {kind:"status", op:"ask"}                   you joined: whoever shares sends theirs again */
var ARENA_STATUS = {sent:null, at:0, timer:null};

// The minutely Arena status poll: keep the lobby socket open while paired, unless you've turned that off.
function arenaStayOnline(st){
  ARENA.paired = !!(st && st.paired);
  if(ARENA.paired && ARENA_STAY) arenaOpenSocket();
}

function arenaMyCounts(){
  var w = 0, n = 0;
  ((STATE && STATE.sessions) || []).forEach(function(s){ if(s.status==="working") w++; else if(s.status==="needs") n++; });
  return {working:Math.min(w, 99), needs:Math.min(n, 99)};
}

function arenaSayStatus(d){
  if(!ARENA.sock || ARENA.sock.readyState !== 1) return false;
  d.kind = "status";
  try { ARENA.sock.send(JSON.stringify({type:"say", data:d})); return true; } catch(e){ return false; }
}

// On every HQ update: send your counts when they change, at most every 2 seconds.
function arenaStatusTick(){
  if(!ARENA_SHARE_STATUS || ARENA_STATUS.timer || !ARENA.sock || ARENA.sock.readyState !== 1) return;
  var wait = ARENA_STATUS.at + 2000 - Date.now();
  if(wait > 0){ ARENA_STATUS.timer = setTimeout(function(){ ARENA_STATUS.timer = null; arenaStatusTick(); }, wait); return; }
  var c = arenaMyCounts(), key = c.working + "," + c.needs;
  if(key === ARENA_STATUS.sent) return;
  if(!arenaSayStatus({op:"set", working:c.working, needs:c.needs})) return;
  ARENA_STATUS.sent = key; ARENA_STATUS.at = Date.now();
  arenaRerenderLobby();   // your own entry shows what the others see
}

// Just joined: hear everyone's status again, and send yours.
function arenaStatusOnLobby(){
  ARENA.peerStatus = {};
  ARENA_STATUS.sent = null;
  arenaSayStatus({op:"ask"});
  arenaStatusTick();
}

function arenaIsCount(x){ return typeof x === "number" && x % 1 === 0 && x >= 0 && x <= 99; }

function arenaOnStatus(m){
  var d = m.data, from = m.from;
  if(!from || typeof from.userId !== "string") return;
  // Our own echo, or our other machine: this page shows its own counts for you.
  if(ARENA.you && from.userId === ARENA.you.userId) return;
  if(d.op === "ask"){ ARENA_STATUS.sent = null; arenaStatusTick(); return; }
  if(d.op === "clear") delete ARENA.peerStatus[from.userId];
  else if(d.op === "set" && arenaIsCount(d.working) && arenaIsCount(d.needs)) ARENA.peerStatus[from.userId] = {working:d.working, needs:d.needs};
  else return;
  arenaRerenderLobby();
}

function arenaRerenderLobby(){ if(ARENA.sock && ARENA.sock.readyState === 1) arenaRenderLobby(ARENA.lobby || []); }

// "2 working · 1 waiting": two dots in the HQ's own colours, and the words for a tooltip and screen readers.
function arenaStatusEl(st, whom){
  var el = document.createElement("span"); el.className = "arena-st";
  var words;
  if(!st.working && !st.needs){ el.textContent = "idle"; words = "nothing working or waiting on " + whom; }
  else {
    if(st.working){ var w = document.createElement("span"); w.className = "w"; w.innerHTML = orb("xs"); w.appendChild(document.createTextNode(st.working)); el.appendChild(w); }
    if(st.needs){ var n = document.createElement("span"); n.className = "n"; n.textContent = st.needs; el.appendChild(n); }
    words = st.working + (st.working === 1 ? " session" : " sessions") + " working, " + st.needs + " waiting on " + whom;
  }
  el.title = words; el.setAttribute("aria-label", words);
  return el;
}

(function(){
  var stay = $("arenaStay"), share = $("arenaShareStatus");
  if(stay){
    stay.checked = ARENA_STAY;
    stay.addEventListener("change", function(){
      ARENA_STAY = stay.checked;
      try { localStorage.setItem("hq_arena_stay", ARENA_STAY ? "1" : "0"); } catch(e){}
      if(ARENA_STAY){ if(ARENA.paired) arenaOpenSocket(); }
      else if(VIEW !== "arena" && !VCHAN.on) arenaCloseSocket();
    });
  }
  if(share){
    share.checked = ARENA_SHARE_STATUS;
    share.addEventListener("change", function(){
      ARENA_SHARE_STATUS = share.checked;
      try { localStorage.setItem("hq_arena_status", ARENA_SHARE_STATUS ? "1" : "0"); } catch(e){}
      if(ARENA_STATUS.timer){ clearTimeout(ARENA_STATUS.timer); ARENA_STATUS.timer = null; }
      ARENA_STATUS.sent = null; ARENA_STATUS.at = 0;
      if(ARENA_SHARE_STATUS) arenaStatusTick(); else arenaSayStatus({op:"clear"});
      arenaRerenderLobby();
    });
  }
})();

// Send a directed nudge over the lobby socket. No URL/command -- just a ping.
function arenaSendNudge(peer){
  if(!ARENA.sock || ARENA.sock.readyState!==1){ toast("Not connected to the lobby", "ach"); return; }
  try{ ARENA.sock.send(JSON.stringify({type:"nudge", to:peer.userId})); }catch(e){}
}
// A nudge arrived. Show a toast + chime; the user decides whether to act on it.
function arenaOnNudge(m){
  var who = (m.from && (m.from.displayName || m.from.handle)) || "Someone";
  var msg = who + " nudged you" + (m.note ? ": " + m.note : "") + " \u2014 check the Arena";
  // Subtle only: a side toast + a quiet (silent) desktop notification. No full-screen
  // overlay, no repeating chime, and we never steal focus or switch the recipient's view.
  if(NOTIF_ON && ("Notification" in window) && Notification.permission==="granted"){
    try{ new Notification("\uD83D\uDC4B "+who+" nudged you", {body:(m.note||"Check the Arena"), tag:"hq-nudge", silent:true}); }catch(e){}
  }
  // Count consecutive nudges from this sender while the Arena tab stays unopened.
  // The 26th from the same person (after 25 ignored) escalates to a siren.
  var sid = (m.from && m.from.userId) || "?";
  var count = (ARENA.nudgeCount[sid] = (ARENA.nudgeCount[sid] || 0) + 1);
  var siren = count >= 26;
  if(siren){
    playSiren();
    if(typeof toast==="function") toast("\uD83D\uDEA8 "+who+" has nudged you "+count+" times \u2014 check the Arena!", "ach");
  } else {
    if(typeof toast==="function") toast("\uD83D\uDC4B "+msg, "level");
  }
  if(typeof announce==="function") announce(msg);
  if(typeof logEvent==="function") logEvent(siren ? "\uD83D\uDEA8" : "\uD83D\uDC4B", msg);
}

/* A short two-tone siren via WebAudio (no asset). Respects the chime toggle, so
   muting HQ still silences it. Used when a nudger crosses the spam threshold. */
function playSiren(){
  if(!CHIME_ON) return;
  try{
    if(!audioCtx){ var AC = window.AudioContext||window.webkitAudioContext; if(!AC) return; audioCtx = new AC(); }
    if(audioCtx.state==="suspended") audioCtx.resume();
    var now = audioCtx.currentTime;
    var o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = "sawtooth";
    // Wail between two pitches a handful of times (~2.4s total).
    var t = now;
    for(var i=0;i<6;i++){ o.frequency.setValueAtTime(660, t); o.frequency.linearRampToValueAtTime(880, t+0.2); o.frequency.linearRampToValueAtTime(660, t+0.4); t += 0.4; }
    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(0.22, now+0.05);
    g.gain.setValueAtTime(0.22, t-0.1);
    g.gain.exponentialRampToValueAtTime(0.0001, t);
    o.connect(g); g.connect(audioCtx.destination);
    o.start(now); o.stop(t+0.05);
  }catch(e){}
}

/* ---- Arena chat ----
   Talk to everyone in the lobby. Rides the rooms' existing "say" relay: the server
   broadcasts it to every member, the sender included (that echo is what shows your
   own message). Nothing is stored server-side, and everything received is untrusted:
   only {kind:"chat", text:string} is shown, as plain text, clipped. */
var ARENA_CHAT_MAX = 500;    // characters per message (the input's maxlength too)
var ARENA_CHAT_KEEP = 200;   // lines kept for this page session
var ARENA_CHAT_LAST = 0;     // when we last sent, for a light flood guard

function arenaWho(p){
  var n = p && (p.displayName || p.handle);
  return typeof n === "string" && n ? n.slice(0, 40) : "someone";
}

function arenaChatPush(line){
  ARENA.chat.push(line);
  if(ARENA.chat.length > ARENA_CHAT_KEEP) ARENA.chat.splice(0, ARENA.chat.length - ARENA_CHAT_KEEP);
  arenaRenderChatLine(line);
  if(typeof hqTalkLine==="function") hqTalkLine(line);
}

function arenaChatSys(text){ arenaChatPush({sys:true, text:text, at:Date.now()}); }

function arenaChatReceive(m, historic){
  var d = m.data;
  // Other room traffic (a future minigame, say) may use "say" too: only chat lines are shown.
  if(!d || typeof d !== "object" || d.kind !== "chat" || typeof d.text !== "string") return;
  // A server with chat history stamps an id: the same message can come again in a later welcome.
  if(typeof m.id === "string"){ if(ARENA.chatSeen[m.id]) return; ARENA.chatSeen[m.id] = 1; }
  var text = d.text.slice(0, ARENA_CHAT_MAX).trim();
  if(!text) return;
  var from = (m.from && typeof m.from === "object") ? m.from : {};
  var you = !!(ARENA.you && from.userId && from.userId === ARENA.you.userId);
  var at = typeof m.at === "string" ? Date.parse(m.at) : NaN;   // the server's time when it has one
  arenaChatPush({
    who: arenaWho(from),
    handle: typeof from.handle === "string" ? from.handle.slice(0, 40) : "",
    avatar: (typeof from.avatarUrl === "string" && /^https:\/\//.test(from.avatarUrl)) ? from.avatarUrl : "",
    you: you,
    text: text, at: isNaN(at) ? Date.now() : at
  });
  // Subtle side toast if this message tags you -- never for your own messages,
  // and never for the history replayed on join (that would be a burst of stale pings).
  if(!you && !historic){
    var tg = arenaMessageTags(text);
    if(tg.me || tg.all) arenaTagToast(arenaWho(from), (tg.me ? "you" : "all"));
    if(VIEW !== "arena" && !(typeof hqTalkShowing==="function" && hqTalkShowing())) arenaUnreadAdd(tg.me || tg.all);
  }
}

// Chat that arrived while you were on another view: a count on the Arena tab, marked "@" when a message tagged you
// (or @here / @channel). Opening the Arena clears it.
function arenaUnreadAdd(tagged){
  ARENA.unread++;
  if(tagged) ARENA.unreadTagged = true;
  arenaRenderUnread();
}
function arenaUnreadClear(){
  if(!ARENA.unread && !ARENA.unreadTagged) return;
  ARENA.unread = 0; ARENA.unreadTagged = false;
  arenaRenderUnread();
}
function arenaRenderUnread(){
  var b = $("arenaUnread"), tab = b && b.parentNode;
  if(!b) return;
  var n = ARENA.unread;
  b.classList.toggle("hidden", !n);
  b.classList.toggle("mention", ARENA.unreadTagged);
  b.textContent = (ARENA.unreadTagged ? "@" : "") + (n > 99 ? "99+" : n);
  if(n) tab.setAttribute("aria-label", "Arena, " + n + " unread message" + (n === 1 ? "" : "s") + " in " + (ARENA.roomName || "your room") + (ARENA.unreadTagged ? ", you were mentioned" : ""));
  else tab.removeAttribute("aria-label");
}

// Does this message tag the current user? @<my handle> tags me; @channel / @here
// tag everyone. Used to raise a quiet notification, not the loud overlay.
function arenaMessageTags(text){
  var me = false, all = false, my = (ARENA.you && ARENA.you.handle || "").toLowerCase();
  var re = /(^|[^\w@])@([\w-]{1,40})/g, m;
  while((m = re.exec(text))){
    var h = m[2].toLowerCase();
    if(h === "channel" || h === "here") all = true;
    else if(my && h === my) me = true;
  }
  return {me: me, all: all};
}
function arenaTagToast(who, kind){
  var msg = kind === "all" ? ("\uD83D\uDCE3 " + who + " notified everyone in " + (ARENA.roomName || "the room"))
                           : ("\uD83D\uDCAC " + who + " tagged you in chat");
  if(typeof toast === "function") toast(msg, "level");
  if(typeof announce === "function") announce(msg);
}

function arenaRenderChatLine(line){
  var log = $("arenaChatLog"); if(!log) return;
  var empty = $("arenaChatEmpty"); if(empty) empty.parentNode.removeChild(empty);
  var stick = log.scrollHeight - log.scrollTop - log.clientHeight < 40;   // reading older lines? don't yank
  var row = document.createElement("div");
  row.className = "arena-line" + (line.sys ? " sys" : "") + (line.you ? " you" : "");
  if(line.sys){
    row.textContent = line.text;
  } else {
    if(line.avatar){
      var img = document.createElement("img"); img.src = line.avatar; img.alt = ""; img.loading = "lazy";
      row.appendChild(img);
    }
    var body = document.createElement("div");
    var who = document.createElement("span"); who.className = "who"; who.textContent = line.who;
    if(line.handle) who.title = "@" + line.handle;
    var at = document.createElement("span"); at.className = "at";
    at.textContent = new Date(line.at).toLocaleTimeString([], {hour:"2-digit", minute:"2-digit"});
    var txt = document.createElement("div"); txt.className = "txt";
    arenaRenderMessageText(txt, line.text);
    body.appendChild(who); body.appendChild(at); body.appendChild(txt);
    row.appendChild(body);
  }
  log.appendChild(row);
  if(stick || line.you) log.scrollTop = log.scrollHeight;
}

function arenaRenderChat(){
  if(typeof hqTalkRender==="function") hqTalkRender();
  var log = $("arenaChatLog"); if(!log) return;
  log.innerHTML = "";
  if(!ARENA.chat.length){
    var e = document.createElement("span"); e.id = "arenaChatEmpty"; e.className = "muted";
    e.textContent = "No messages yet. Say hi 👋";
    log.appendChild(e);
    return;
  }
  ARENA.chat.forEach(arenaRenderChatLine);
}

function arenaChatReady(on){
  var i = $("arenaChatInput"), b = $("arenaChatSend"); if(!i || !b) return;
  i.disabled = !on; b.disabled = !on;
  i.placeholder = on ? ("Message " + (ARENA.roomName || "the room") + "\u2026") : "Offline \u2014 reconnecting\u2026";
}

function arenaChatSend(){
  var i = $("arenaChatInput"); if(!i) return;
  var text = (i.value || "").trim().slice(0, ARENA_CHAT_MAX);
  if(!text) return;
  var ws = ARENA.sock;
  if(!ws || ws.readyState !== 1){ arenaChatReady(false); return; }
  var now = Date.now();
  if(now - ARENA_CHAT_LAST < 700) return;
  ARENA_CHAT_LAST = now;
  try { ws.send(JSON.stringify({type:"say", data:{kind:"chat", text:text}})); } catch(e){ return; }
  i.value = "";
}

// Build a chat message, wrapping @handle tokens for known lobby members in a
// highlight span. Each piece is set via textContent, so nothing is ever HTML.
function arenaRenderMessageText(container, text){
  var known = {channel: 1, here: 1};
  (ARENA.lobby || []).forEach(function(p){ if(p.handle) known[p.handle.toLowerCase()] = 1; });
  if(ARENA.you && ARENA.you.handle) known[ARENA.you.handle.toLowerCase()] = 1;
  var myHandle = (ARENA.you && ARENA.you.handle || "").toLowerCase();
  var re = /(^|[^\w@])@([\w-]{1,40})/g, last = 0, m;
  while((m = re.exec(text))){
    var handle = m[2], lower = handle.toLowerCase();
    if(!known[lower]) continue;                       // only tag real members
    container.appendChild(document.createTextNode(text.slice(last, m.index) + m[1]));
    var span = document.createElement("span");
    // @channel/@here concern everyone, and your own handle concerns you: make those stand out.
    span.className = "mention" + ((lower === myHandle || lower === "channel" || lower === "here") ? " me" : "");
    span.textContent = "@" + handle;
    container.appendChild(span);
    last = m.index + m[0].length;
  }
  container.appendChild(document.createTextNode(text.slice(last)));
}

/* ---- @mention autocomplete: type "@" to tag someone in the room ---- */
// Shared by every chat box (the Arena's, and the HQ's talk panel: ui/app/28-talk.js). Each input
// names its suggestion list in data-mentions; MENTION.input is the one being typed in.
var MENTION = {open:false, items:[], sel:0, start:-1, input:null};
function arenaMentionList(){ var i = MENTION.input || $("arenaChatInput"); return i && $(i.getAttribute("data-mentions") || "arenaMentions"); }
function arenaMentionClose(){
  MENTION.open = false;
  ["arenaMentions", "hqTalkMentions"].forEach(function(id){ var el = $(id); if(el){ el.classList.add("hidden"); el.innerHTML = ""; } });
}
function arenaMentionScan(ev){
  var i = (ev && ev.target) || MENTION.input || $("arenaChatInput"); if(!i) return;
  MENTION.input = i;
  var pos = i.selectionStart || 0, before = i.value.slice(0, pos);
  var m = before.match(/(?:^|\s)@([\w-]*)$/);        // an @token the caret is inside
  if(!m){ arenaMentionClose(); return; }
  var q = m[1].toLowerCase();
  var mine = ARENA.you && ARENA.you.userId;
  var specials = [
    {handle:"here", displayName:"here", desc:"Notify everyone in this room", special:true},
    {handle:"channel", displayName:"channel", desc:"Notify everyone", special:true}
  ].filter(function(p){ return p.handle.indexOf(q) === 0; });
  var people = (ARENA.lobby || []).filter(function(p){
    if(mine && p.userId === mine) return false;       // don't offer yourself
    return (p.handle||"").toLowerCase().indexOf(q) === 0 ||
           (p.displayName||"").toLowerCase().indexOf(q) >= 0;
  });
  var matches = specials.concat(people).slice(0, 8);
  if(!matches.length){ arenaMentionClose(); return; }
  MENTION = {open:true, items:matches, sel:0, start:pos - m[1].length - 1, input:i};
  arenaMentionRender();
}
function arenaMentionRender(){
  var el = arenaMentionList(); if(!el) return;
  el.innerHTML = "";
  MENTION.items.forEach(function(p, idx){
    var row = document.createElement("div");
    row.className = "arena-mention" + (idx === MENTION.sel ? " sel" : "");
    row.setAttribute("role", "option");
    if(p.avatarUrl && /^https:\/\//.test(p.avatarUrl)){
      var img = document.createElement("img"); img.src = p.avatarUrl; img.alt = ""; row.appendChild(img);
    }
    var nm = document.createElement("span");
    nm.textContent = p.special ? ("@" + p.handle) : (p.displayName || p.handle);
    var h = document.createElement("small");
    h.textContent = p.special ? ("  " + p.desc) : (" @" + (p.handle||""));
    nm.appendChild(h); row.appendChild(nm);
    // mousedown (not click) so it fires before the input blurs.
    row.addEventListener("mousedown", function(e){ e.preventDefault(); arenaMentionAccept(idx); });
    el.appendChild(row);
  });
  el.classList.remove("hidden");
}
function arenaMentionAccept(idx){
  var i = MENTION.input || $("arenaChatInput"); var p = MENTION.items[idx]; if(!i || !p){ arenaMentionClose(); return; }
  var pos = i.selectionStart || 0;
  var insert = "@" + (p.handle||"") + " ";
  i.value = i.value.slice(0, MENTION.start) + insert + i.value.slice(pos);
  var caret = MENTION.start + insert.length;
  i.setSelectionRange(caret, caret);
  arenaMentionClose(); i.focus();
}

// Wire a chat input for @mentions (arrow keys, Enter/Tab to pick, Escape to close).
function arenaMentionBind(i){
  if(!i) return;
    i.addEventListener("input", arenaMentionScan);
    i.addEventListener("keydown", function(e){
      if(!MENTION.open) return;
      if(e.key === "ArrowDown"){ e.preventDefault(); MENTION.sel = (MENTION.sel+1) % MENTION.items.length; arenaMentionRender(); }
      else if(e.key === "ArrowUp"){ e.preventDefault(); MENTION.sel = (MENTION.sel-1+MENTION.items.length) % MENTION.items.length; arenaMentionRender(); }
      else if(e.key === "Enter" || e.key === "Tab"){ e.preventDefault(); arenaMentionAccept(MENTION.sel); }
      else if(e.key === "Escape"){ e.preventDefault(); arenaMentionClose(); }
    });
    i.addEventListener("blur", function(){ setTimeout(arenaMentionClose, 120); });
}
(function(){
  var f = $("arenaChatForm"), i = $("arenaChatInput");
  if(f) f.addEventListener("submit", function(e){ e.preventDefault(); arenaChatSend(); });
  arenaMentionBind(i);
})();

