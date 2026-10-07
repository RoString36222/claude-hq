/* ---- Arena voice (and video) ----
   WebRTC audio between lobby members: a small mesh, everyone connected to everyone (up to VCHAN_MAX).
   The lobby socket carries two kinds of messages for it:
     say    {kind:"voice", op:"join"|"leave"|"mute"|"cam"|"who"|"here", peer, muted, cam, screen}  who's in voice, to everyone
     signal {to:userId, data:{kind:"hello"|"offer"|"answer"|"ice", fromPeer, toPeer, ...}}  setup, to ONE member
   A peer id is per page, so two tabs or machines of the same person are separate peers. For each pair the
   smaller peer id makes the offer (the larger one says "hello" instead), so two people joining at once never
   both call each other. The audio flows browser to browser; the server only relays the setup.
   Video (a camera, or a shared screen) is optional inside a call and flows the same way: see voiceStartVideo. */
var VCHAN_MAX = 6;
var VCHAN_ICE = [{urls:"stun:stun.l.google.com:19302"}];
var VCHAN_PEER_RE = /^[a-f0-9]{16}$/;

function voiceNewPeerId(){
  var b = new Uint8Array(8); crypto.getRandomValues(b);
  return Array.prototype.map.call(b, function(x){ return (x < 16 ? "0" : "") + x.toString(16); }).join("");
}

function voiceSay(op, extra){
  if(!ARENA.sock || ARENA.sock.readyState !== 1) return;
  var d = {kind:"voice", op:op};
  if(VCHAN.peer) d.peer = VCHAN.peer;
  if(extra) for(var k in extra) d[k] = extra[k];
  try { ARENA.sock.send(JSON.stringify({type:"say", data:d})); } catch(e){}
}

function voiceSignal(userId, data){
  if(!ARENA.sock || ARENA.sock.readyState !== 1 || !VCHAN.peer) return;
  data.fromPeer = VCHAN.peer;
  try { ARENA.sock.send(JSON.stringify({type:"signal", to:userId, data:data})); } catch(e){}
}

// Entered (or re-entered) the lobby: ask who's in voice; if we are, announce ourselves again.
function voiceOnLobby(){
  VCHAN.roster = {};
  if(VCHAN.on){
    VCHAN.roster[VCHAN.peer] = {userId: ARENA.you && ARENA.you.userId, who:"You", you:true, muted:VCHAN.muted, cam:!!VCHAN.vidStream, screen:VCHAN.screen};
    voiceSay("join", {muted:VCHAN.muted, cam:!!VCHAN.vidStream, screen:VCHAN.screen});
  }
  voiceSay("who");
  voiceRender();
}

// Our lobby socket dropped: everyone else drops us too, so close our side and rebuild on the next welcome.
function voiceOnLobbyLost(){
  Object.keys(VCHAN.peers).forEach(voiceClosePeer);
  Object.keys(VCHAN.roster).forEach(function(id){ if(!VCHAN.roster[id].you) delete VCHAN.roster[id]; });
  voiceRender();
}

// Someone left the lobby: drop their voice peers, unless another tab or machine of theirs is still there.
function voiceOnLeave(m){
  var gone = m.member && m.member.userId;
  if(typeof gone !== "string") return;
  if((m.members || []).some(function(x){ return x && x.userId === gone; })) return;
  Object.keys(VCHAN.roster).forEach(function(id){
    if(VCHAN.roster[id].userId === gone && !VCHAN.roster[id].you){ delete VCHAN.roster[id]; voiceClosePeer(id); }
  });
  voiceRender();
}

// Is our call with this peer actually up? (A stale entry never gets here.)
function voiceLive(id){ var p = VCHAN.peers[id]; return !!(p && p.pc && p.pc.connectionState === "connected"); }
// Someone (re)joined as a new peer: a reload or reconnect gives their page a new peer id, and their old one can
// outlive it in our roster when the lobby saw the new socket before the old one left. Drop their other entries
// that never connected; a second tab or machine of theirs that IS connected stays.
function voiceDropStale(userId, keepPeer){
  Object.keys(VCHAN.roster).forEach(function(id){
    var r = VCHAN.roster[id];
    if(id === keepPeer || r.you || r.userId !== userId || voiceLive(id)) return;
    delete VCHAN.roster[id]; voiceClosePeer(id);
  });
}
// Every so often ask who's in voice; whoever doesn't answer within a few seconds and isn't connected to us is
// gone (closed the tab, lost the network, reloaded). Pages from before this answer "who" too.
var VCHAN_SWEEP_EVERY = 15000, VCHAN_SWEEP_WAIT = 5000;
function voiceSweep(){
  if(!ARENA.sock || ARENA.sock.readyState !== 1) return;
  var asked = Date.now();
  voiceSay("who");
  setTimeout(function(){
    var changed = false;
    Object.keys(VCHAN.roster).forEach(function(id){
      var r = VCHAN.roster[id];
      if(r.you || (r.seen || 0) >= asked) return;
      if(voiceLive(id)){ r.seen = Date.now(); return; }
      delete VCHAN.roster[id]; voiceClosePeer(id); changed = true;
    });
    if(changed) voiceRender();
  }, VCHAN_SWEEP_WAIT);
}
setInterval(voiceSweep, VCHAN_SWEEP_EVERY);

function voiceOnAnnounce(m){
  var d = m.data, from = m.from;
  if(!d || typeof d !== "object" || !from || typeof from.userId !== "string") return;
  if(d.op === "who"){ if(VCHAN.on) voiceSay("here", {muted:VCHAN.muted, cam:!!VCHAN.vidStream, screen:VCHAN.screen}); return; }
  if(typeof d.peer !== "string" || !VCHAN_PEER_RE.test(d.peer) || d.peer === VCHAN.peer) return;
  if(VCHAN.roster[d.peer]) VCHAN.roster[d.peer].seen = Date.now();
  if(d.op === "join" || d.op === "here"){
    if(!VCHAN.roster[d.peer]) voiceDropStale(from.userId, d.peer);
    VCHAN.roster[d.peer] = {userId:from.userId, who:arenaWho(from), muted:!!d.muted, cam:d.cam === true, screen:d.cam === true && d.screen === true, seen:Date.now()};
    if(d.op === "join") voicePair(d.peer, from);
  } else if(d.op === "leave"){
    delete VCHAN.roster[d.peer];
    voiceClosePeer(d.peer);
  } else if(d.op === "mute"){
    if(VCHAN.roster[d.peer]) VCHAN.roster[d.peer].muted = !!d.muted;
  } else if(d.op === "cam"){
    var r = VCHAN.roster[d.peer];
    if(r){ r.cam = d.cam === true; r.screen = r.cam && d.screen === true; }
  }
  voiceRender();
}

// May a NEW peer connection be made to this peer? Never to ourselves (this page, or your own other
// tab/machine), and never past VCHAN_MAX people in the call (you plus VCHAN_MAX-1 peers). Shared by
// the side that calls (voicePair) and the side that answers an incoming offer (voiceOnSignal).
function voiceMayAddPeer(peer, from){
  if(!peer || peer === VCHAN.peer) return false;
  if(!from || (ARENA.you && from.userId === ARENA.you.userId)) return false;
  return Object.keys(VCHAN.peers).length < VCHAN_MAX - 1;
}
// Connect to one peer: the smaller peer id offers, the larger says hello so the smaller one calls.
function voicePair(peer, from){
  if(!VCHAN.on || VCHAN.peers[peer]) return;
  if(!voiceMayAddPeer(peer, from)) return;   // yourself (another tab of yours) or the call is full
  if(VCHAN.peer < peer) voiceCall(peer, from);
  else voiceSignal(from.userId, {kind:"hello", toPeer:peer, muted:VCHAN.muted, cam:!!VCHAN.vidStream, screen:VCHAN.screen});
}

function voiceOnSignal(m){
  var d = m.data, from = m.from;
  if(!VCHAN.on || !d || typeof d !== "object" || !from || typeof from.userId !== "string") return;
  if(d.toPeer !== VCHAN.peer || typeof d.fromPeer !== "string" || !VCHAN_PEER_RE.test(d.fromPeer)) return;
  var peer = d.fromPeer;
  if(!VCHAN.roster[peer]){ voiceDropStale(from.userId, peer);
    VCHAN.roster[peer] = {userId:from.userId, who:arenaWho(from), muted:!!d.muted, cam:d.cam === true, screen:d.cam === true && d.screen === true}; }
  VCHAN.roster[peer].seen = Date.now();
  if(d.kind === "hello"){
    voicePair(peer, from);
  } else if(d.kind === "offer" && typeof d.sdp === "string" && d.sdp.length < 20000){
    if(!VCHAN.peers[peer] && !voiceMayAddPeer(peer, from)){ voiceRender(); return; }
    var p = VCHAN.peers[peer] || voiceMakePeer(peer, from, false);
    p.pc.setRemoteDescription({type:"offer", sdp:d.sdp})
      .then(function(){ voiceAnswerVideo(p); voiceFlushIce(p); return p.pc.createAnswer(); })
      .then(function(a){ return p.pc.setLocalDescription(a); })
      .then(function(){ voiceSignal(from.userId, {kind:"answer", toPeer:peer, sdp:p.pc.localDescription.sdp}); })
      .catch(function(){ voiceClosePeer(peer); });
  } else if(d.kind === "answer" && typeof d.sdp === "string" && d.sdp.length < 20000){
    var q = VCHAN.peers[peer];
    if(q) q.pc.setRemoteDescription({type:"answer", sdp:d.sdp})
      .then(function(){ voiceFlushIce(q); }).catch(function(){ voiceClosePeer(peer); });
  } else if(d.kind === "ice" && d.candidate && typeof d.candidate === "object"){
    var r = VCHAN.peers[peer];
    if(r){ if(r.pc.remoteDescription) r.pc.addIceCandidate(d.candidate).catch(function(){}); else r.ice.push(d.candidate); }
  }
  voiceRender();
}

function voiceCall(peer, from){
  var p = voiceMakePeer(peer, from, true);
  p.pc.createOffer()
    .then(function(o){ return p.pc.setLocalDescription(o); })
    .then(function(){ voiceSignal(from.userId, {kind:"offer", toPeer:peer, sdp:p.pc.localDescription.sdp, muted:VCHAN.muted, cam:!!VCHAN.vidStream, screen:VCHAN.screen}); })
    .catch(function(){ voiceClosePeer(peer); });
}

function voiceMakePeer(peer, from, offerer){
  var pc = new RTCPeerConnection({iceServers:VCHAN_ICE});
  var p = {pc:pc, userId:from.userId, ice:[], audio:null, analyser:null, vt:null, tile:null, video:null};
  VCHAN.peers[peer] = p;
  VCHAN.stream.getTracks().forEach(function(t){ pc.addTrack(t, VCHAN.stream); });
  // The caller adds one video line up front, so a camera can come and go later without renegotiating (the other
  // side answers on it in voiceAnswerVideo). It has no stream id: pages from before video ignore such a track.
  if(offerer) p.vt = pc.addTransceiver(voiceVideoTrack() || "video", {direction:"sendrecv"});
  pc.onicecandidate = function(e){
    if(e.candidate) voiceSignal(p.userId, {kind:"ice", toPeer:peer, candidate:e.candidate.toJSON()});
  };
  pc.ontrack = function(e){
    if(e.track.kind === "video"){ voiceShowVideo(p, e.track); return; }
    var stream = e.streams && e.streams[0];
    if(!stream) return;
    if(!p.audio){
      p.audio = document.createElement("audio"); p.audio.autoplay = true; p.audio.setAttribute("playsinline", "");
      $("voiceAudio").appendChild(p.audio);
    }
    p.audio.srcObject = stream;
    var pl = p.audio.play(); if(pl && pl.catch) pl.catch(function(){});
    p.analyser = voiceAnalyser(stream);
  };
  pc.onconnectionstatechange = function(){
    if(pc.connectionState === "failed" || pc.connectionState === "closed") voiceClosePeer(peer);
    voiceRender();
  };
  return p;
}

function voiceFlushIce(p){
  p.ice.splice(0).forEach(function(c){ p.pc.addIceCandidate(c).catch(function(){}); });
}

function voiceClosePeer(peer){
  var p = VCHAN.peers[peer];
  if(!p) return;
  delete VCHAN.peers[peer];
  try { p.pc.onconnectionstatechange = null; p.pc.close(); } catch(e){}
  if(p.audio){ p.audio.srcObject = null; if(p.audio.parentNode) p.audio.parentNode.removeChild(p.audio); }
  if(p.tile){ p.video.srcObject = null; if(p.tile.parentNode) p.tile.parentNode.removeChild(p.tile); }
  if(p.analyser) try { p.analyser.src.disconnect(); } catch(e){}
  voiceRender();
}

// A level meter per stream (not connected to the speakers: the <audio> element plays the sound).
function voiceAnalyser(stream){
  try {
    if(!VCHAN.ctx){ var AC = window.AudioContext || window.webkitAudioContext; if(!AC) return null; VCHAN.ctx = new AC(); }
    if(VCHAN.ctx.state === "suspended") VCHAN.ctx.resume();
    var src = VCHAN.ctx.createMediaStreamSource(stream), an = VCHAN.ctx.createAnalyser();
    an.fftSize = 512; src.connect(an);
    return {src:src, an:an, buf:new Uint8Array(an.fftSize)};
  } catch(e){ return null; }
}

function voiceLevel(a){
  if(!a) return 0;
  a.an.getByteTimeDomainData(a.buf);
  var s = 0;
  for(var i = 0; i < a.buf.length; i++){ var v = (a.buf[i] - 128) / 128; s += v * v; }
  return Math.sqrt(s / a.buf.length);
}

function voiceStartMeter(){
  if(VCHAN.meter) return;
  VCHAN.meter = setInterval(function(){
    Array.prototype.forEach.call(document.querySelectorAll("#voiceRoster .voice-peer, #voiceDock .voice-peer"), function(c){
      var id = c.getAttribute("data-peer"), r = VCHAN.roster[id];
      var a = (r && r.you) ? (VCHAN.muted ? null : VCHAN.me) : (VCHAN.peers[id] && VCHAN.peers[id].analyser);
      c.classList.toggle("speaking", voiceLevel(a) > 0.04);
    });
  }, 200);
}

function voiceStopMeter(){ if(VCHAN.meter){ clearInterval(VCHAN.meter); VCHAN.meter = null; } }

function voiceRender(){
  var join = $("voiceJoin"), mute = $("voiceMute"), cam = $("voiceCam"), scr = $("voiceScreen"), leave = $("voiceLeave"), ros = $("voiceRoster");
  var pill = $("voicePill"), sub = $("voiceSub");
  if(!join) return;
  var ids = Object.keys(VCHAN.roster);
  join.classList.toggle("hidden", VCHAN.on);
  mute.classList.toggle("hidden", !VCHAN.on);
  cam.classList.toggle("hidden", !VCHAN.on);
  scr.classList.toggle("hidden", !VCHAN.on || !navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia);
  leave.classList.toggle("hidden", !VCHAN.on);
  join.disabled = !ARENA.sock || ARENA.sock.readyState !== 1 || ids.length >= VCHAN_MAX;
  mute.textContent = VCHAN.muted ? "Unmute" : "Mute";
  mute.setAttribute("aria-pressed", VCHAN.muted ? "true" : "false");
  mute.title = (VCHAN.muted ? "Unmute" : "Mute") + " (M)";
  cam.textContent = VCHAN.cam ? "📷 Camera off" : "📷 Camera";
  cam.setAttribute("aria-pressed", VCHAN.cam ? "true" : "false");
  cam.title = (VCHAN.cam ? "Turn your camera off" : "Turn your camera on") + " (V)";
  scr.textContent = VCHAN.screen ? "🖥 Stop sharing" : "🖥 Share screen";
  scr.setAttribute("aria-pressed", VCHAN.screen ? "true" : "false");
  scr.title = (VCHAN.screen ? "Stop sharing your screen" : "Share your screen") + " (S)";
  sub.textContent = ids.length ? (ids.length + " in voice · up to " + VCHAN_MAX) : ("nobody in voice yet · up to " + VCHAN_MAX);
  ros.innerHTML = "";
  ids.forEach(function(id){
    var r = VCHAN.roster[id], p = VCHAN.peers[id];
    var chip = document.createElement("span"); chip.className = "voice-peer"; chip.setAttribute("data-peer", id);
    if(VCHAN.on && !r.you && !(p && p.pc.connectionState === "connected")) chip.classList.add("connecting");
    var t = document.createElement("span"); t.textContent = r.you ? "You" : r.who; chip.appendChild(t);
    if(r.muted){ var mm = document.createElement("span"); mm.className = "vm"; mm.textContent = "🔇"; mm.title = "muted"; chip.appendChild(mm); }
    if(r.cam){ var mc = document.createElement("span"); mc.className = "vm"; mc.textContent = r.screen ? "🖥" : "📹"; mc.title = r.screen ? "sharing their screen" : "camera on"; chip.appendChild(mc); }
    ros.appendChild(chip);
  });
  voiceRenderVideos();
  if(pill){
    pill.classList.toggle("hidden", !VCHAN.on);
    // A live camera or a shared screen always shows here, from every view, even while you're muted.
    pill.classList.toggle("muted", VCHAN.muted && !VCHAN.vidStream);
    pill.textContent = (VCHAN.screen ? "🖥 In voice · sharing screen" : VCHAN.cam ? "📹 In voice · camera on" : "🎙 In voice") +
      (VCHAN.muted ? " · muted" : "");
  }
  voiceDockRender();
}

/* The call overlay (see .vdock): built once, shown while you're in a call and not on the Arena view, where the full
   voice panel already is. Everyone's video moves into it (the tiles keep playing) and back when you open the Arena. */
var VDOCK = null;
function voiceDockBuild(){
  if(VDOCK) return VDOCK;
  var d = document.createElement("section"); d.id = "voiceDock"; d.className = "vdock hidden"; d.setAttribute("aria-label", "Voice call");
  var head = document.createElement("div"); head.className = "vdock-head";
  var title = document.createElement("span"); title.className = "vdock-title";
  function b(txt, label, fn, cls){ var x = document.createElement("button"); x.type = "button"; x.className = "vdock-btn" + (cls ? " " + cls : ""); x.textContent = txt; x.title = label; x.setAttribute("aria-label", label);
    x.addEventListener("click", function(e){ e.stopPropagation(); fn(); }); x.addEventListener("pointerdown", function(e){ e.stopPropagation(); }); return x; }
  var mute = b("🎙", "Mute", voiceToggleMute), cam = b("📷", "Camera", voiceToggleCam), scr = b("🖥", "Share screen", voiceToggleScreen);
  var fold = b("▾", "Collapse", function(){ d.classList.toggle("collapsed"); fold.textContent = d.classList.contains("collapsed") ? "▸" : "▾";
    try { localStorage.setItem("hq_vdock_fold", d.classList.contains("collapsed") ? "1" : "0"); } catch(e){} });
  var leave = b("✕", "Leave the call", voiceLeave, "leave");
  head.appendChild(title); head.appendChild(mute); head.appendChild(cam); head.appendChild(scr); head.appendChild(fold); head.appendChild(leave);
  var body = document.createElement("div"); body.className = "vdock-body";
  var peers = document.createElement("div"); peers.className = "vdock-peers";
  var open = document.createElement("button"); open.type = "button"; open.className = "hbtn ghost"; open.textContent = "Open the Arena";
  open.addEventListener("click", function(){ setView("arena"); });
  body.appendChild(peers); body.appendChild(open);
  d.appendChild(head); d.appendChild(body); document.body.appendChild(d);
  try { if(localStorage.getItem("hq_vdock_fold") === "1"){ d.classList.add("collapsed"); fold.textContent = "▸"; } } catch(e){}
  // drag by the header; the spot is remembered (this browser only) and kept on screen
  var drag = null;
  function place(x, y){
    var w = d.offsetWidth, h = d.offsetHeight;
    x = Math.max(8, Math.min(window.innerWidth - w - 8, x)); y = Math.max(8, Math.min(window.innerHeight - h - 8, y));
    d.style.left = x + "px"; d.style.top = y + "px"; d.style.right = "auto"; d.style.bottom = "auto";
    return [x, y];
  }
  head.addEventListener("pointerdown", function(e){ var r = d.getBoundingClientRect(); drag = {dx: e.clientX - r.left, dy: e.clientY - r.top}; try { head.setPointerCapture(e.pointerId); } catch(x){} });
  head.addEventListener("pointermove", function(e){ if(drag) place(e.clientX - drag.dx, e.clientY - drag.dy); });
  head.addEventListener("pointerup", function(){ if(!drag) return; drag = null;
    try { localStorage.setItem("hq_vdock_pos", JSON.stringify([parseInt(d.style.left, 10), parseInt(d.style.top, 10)])); } catch(e){} });
  window.addEventListener("resize", function(){ if(d.style.left) place(parseInt(d.style.left, 10), parseInt(d.style.top, 10)); });
  var grid = $("voiceVideos");
  VDOCK = {el: d, title: title, mute: mute, cam: cam, scr: scr, peers: peers, body: body, open: open, place: place,
           home: grid ? grid.parentNode : null, homeNext: grid ? grid.nextSibling : null, placed: false};
  return VDOCK;
}
function voiceDockRender(){
  var show = VCHAN.on && VIEW !== "arena";
  if(!show && !VDOCK) return;
  var D = voiceDockBuild(), grid = $("voiceVideos");
  D.el.classList.toggle("hidden", !show);
  // everyone's video lives in the overlay while it shows, back in the Arena's voice panel otherwise
  if(grid){
    var want = show ? D.body : D.home;
    if(want && grid.parentNode !== want){
      if(show) D.body.insertBefore(grid, D.open); else D.home.insertBefore(grid, D.homeNext);
      Array.prototype.forEach.call(grid.querySelectorAll("video"), function(v){ if(!v.closest(".hidden")) voicePlay(v); });
    }
  }
  if(!show) return;
  if(!D.placed){ D.placed = true; try { var p = JSON.parse(localStorage.getItem("hq_vdock_pos") || "null"); if(p && p.length === 2) D.place(p[0], p[1]); } catch(e){} }
  var ids = Object.keys(VCHAN.roster);
  D.title.textContent = (VCHAN.screen ? "🖥 " : VCHAN.cam ? "📹 " : "🎙 ") + "Voice · " + ids.length + (VCHAN.muted ? " · muted" : "");
  D.mute.textContent = VCHAN.muted ? "🔇" : "🎙"; D.mute.setAttribute("aria-pressed", VCHAN.muted ? "true" : "false");
  D.mute.title = VCHAN.muted ? "Unmute (M)" : "Mute (M)"; D.mute.setAttribute("aria-label", D.mute.title);
  D.cam.setAttribute("aria-pressed", VCHAN.cam ? "true" : "false"); D.cam.title = VCHAN.cam ? "Turn your camera off" : "Turn your camera on";
  D.scr.setAttribute("aria-pressed", VCHAN.screen ? "true" : "false"); D.scr.title = VCHAN.screen ? "Stop sharing your screen" : "Share your screen";
  D.scr.hidden = !navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia;
  D.peers.textContent = "";
  ids.forEach(function(id){
    var r = VCHAN.roster[id], p = VCHAN.peers[id];
    var row = document.createElement("div"); row.className = "voice-peer"; row.setAttribute("data-peer", id);
    if(!r.you && !(p && p.pc.connectionState === "connected")) row.classList.add("connecting");
    var name = r.you ? "You" : String(r.who || "Someone");
    var av = document.createElement("span"); av.className = "vd-av"; av.setAttribute("aria-hidden", "true"); av.textContent = name.charAt(0).toUpperCase();
    var n = document.createElement("span"); n.className = "vd-n"; n.textContent = name;
    row.appendChild(av); row.appendChild(n);
    if(r.cam){ var c = document.createElement("span"); c.textContent = r.screen ? "🖥" : "📹"; c.title = r.screen ? "sharing their screen" : "camera on"; row.appendChild(c); }
    if(r.muted){ var m = document.createElement("span"); m.textContent = "🔇"; m.title = "muted"; row.appendChild(m); }
    D.peers.appendChild(row);
  });
}

function voiceJoin(){
  if(VCHAN.on) return;
  if(!ARENA.sock || ARENA.sock.readyState !== 1){ toast("Connect to the Arena lobby first", "ach"); return; }
  if(Object.keys(VCHAN.roster).length >= VCHAN_MAX){ toast("Voice is full (" + VCHAN_MAX + " people)", "ach"); return; }
  if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.RTCPeerConnection){
    toast("This browser can't do voice here", "ach"); return;
  }
  $("voiceJoin").disabled = true;
  navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true, noiseSuppression:true, autoGainControl:true}, video:false})
    .then(function(stream){
      VCHAN.stream = stream; VCHAN.on = true; VCHAN.muted = false; VCHAN.peer = voiceNewPeerId();
    VCHAN.roomId = ARENA.roomId;
      VCHAN.me = voiceAnalyser(stream);
      VCHAN.roster[VCHAN.peer] = {userId: ARENA.you && ARENA.you.userId, who:"You", you:true, muted:false};
      voiceSay("join", {muted:false});
      voiceStartMeter();
      voiceRender();
    })
    .catch(function(){ toast("Microphone blocked — allow it for this page to join voice", "ach"); voiceRender(); });
}

function voiceLeave(){
  if(!VCHAN.on) return;
  voiceSay("leave");
  voiceVideoOff();
  Object.keys(VCHAN.peers).forEach(voiceClosePeer);
  if(VCHAN.stream) VCHAN.stream.getTracks().forEach(function(t){ t.stop(); });
  if(VCHAN.me) try { VCHAN.me.src.disconnect(); } catch(e){}
  delete VCHAN.roster[VCHAN.peer];
  VCHAN.on = false; VCHAN.stream = null; VCHAN.peer = null; VCHAN.me = null; VCHAN.muted = false; VCHAN.roomId = null;
  voiceStopMeter();
  voiceRender();
  if(VIEW !== "arena" && !ARENA_STAY) arenaCloseSocket();   // the socket only stayed open for voice
}

function voiceToggleMute(){
  if(!VCHAN.on) return;
  VCHAN.muted = !VCHAN.muted;
  VCHAN.stream.getAudioTracks().forEach(function(t){ t.enabled = !VCHAN.muted; });
  if(VCHAN.roster[VCHAN.peer]) VCHAN.roster[VCHAN.peer].muted = VCHAN.muted;
  voiceSay("mute", {muted:VCHAN.muted});
  voiceRender();
}

/* Video: a camera or a shared screen, optional inside a voice call. Every connection negotiates one video line
   when it's made (voiceMakePeer on the caller's side, voiceAnswerVideo on the other), so switching the camera or a
   screen on or off only swaps the track that line sends: no renegotiation. One line means one video each: the camera
   and a shared screen take turns. Each person's video gets a tile, made once and shown only while it's on. */
function voiceVideoTrack(){
  return (VCHAN.vidStream && VCHAN.vidStream.getVideoTracks()[0]) || null;
}

// Answering a call: send back on the caller's video line. A caller from before video has none: no video with them.
function voiceAnswerVideo(p){
  if(p.vt) return;
  var t = p.pc.getTransceivers().filter(function(x){ return x.receiver.track.kind === "video"; })[0];
  if(!t) return;
  t.direction = "sendrecv";
  p.vt = t;
  var track = voiceVideoTrack();
  if(track) t.sender.replaceTrack(track).catch(function(){});
}

function voiceMakeTile(you){
  var tile = document.createElement("div"); tile.className = "voice-tile hidden" + (you ? " you" : "");
  var v = document.createElement("video"); v.autoplay = true; v.muted = true; v.setAttribute("playsinline", "");
  var name = document.createElement("span"); name.className = "vt-name";
  tile.appendChild(v); tile.appendChild(name);
  var grid = $("voiceVideos");
  if(you) grid.insertBefore(tile, grid.firstChild); else grid.appendChild(tile);
  return tile;
}

// Their video line is up (video on or not yet): keep a tile ready for it.
function voiceShowVideo(p, track){
  if(!p.tile){ p.tile = voiceMakeTile(false); p.video = p.tile.firstChild; }
  p.video.srcObject = new MediaStream([track]);   // sound comes through their <audio>, so the video stays muted
  voiceRender();
}

function voicePlay(v){
  if(v.paused){ var pl = v.play(); if(pl && pl.catch) pl.catch(function(){}); }
}

// Your video first, then everyone whose video is on. Tiles are only shown or hidden, so their video keeps playing.
// A shared screen gets a whole row, uncropped.
function voiceRenderVideos(){
  var grid = $("voiceVideos"), shown = 0;
  if(!grid) return;
  if(VCHAN.vidTile){
    VCHAN.vidTile.lastChild.textContent = (VCHAN.screen ? "Your screen" : "You") + (VCHAN.muted ? " 🔇" : "");
    VCHAN.vidTile.classList.toggle("screen", VCHAN.screen);
    VCHAN.vidTile.classList.remove("hidden"); voicePlay(VCHAN.vidTile.firstChild); shown++;
  }
  Object.keys(VCHAN.peers).forEach(function(id){
    var p = VCHAN.peers[id], r = VCHAN.roster[id], on = !!(r && r.cam);
    if(!p.tile) return;
    p.tile.lastChild.textContent = r ? r.who + (r.screen ? " · screen" : "") + (r.muted ? " 🔇" : "") : "";
    p.tile.classList.toggle("screen", !!(r && r.screen));
    p.tile.classList.toggle("hidden", !on);
    if(on){ voicePlay(p.video); shown++; }
  });
  grid.classList.toggle("hidden", !shown);
}

// Tell everyone whether your video is on, and whether it's a screen.
function voiceSayVideo(){
  var me = VCHAN.roster[VCHAN.peer];
  if(me){ me.cam = !!VCHAN.vidStream; me.screen = VCHAN.screen; }
  voiceSay("cam", {cam:!!VCHAN.vidStream, screen:VCHAN.screen});
}

// Put a new camera or screen stream on everyone's video line, in place of whatever was there, and show your tile.
function voiceStartVideo(stream, screen){
  voiceVideoOff();
  var track = stream.getVideoTracks()[0];
  if(screen) try { track.contentHint = "detail"; } catch(e){}   // keep text sharp rather than motion smooth
  VCHAN.vidStream = stream; VCHAN.cam = !screen; VCHAN.screen = !!screen;
  // Camera unplugged or its permission taken back, or the browser's own "Stop sharing": same as switching it off.
  track.onended = function(){ if(VCHAN.vidStream === stream){ voiceVideoOff(); voiceSayVideo(); voiceRender(); } };
  Object.keys(VCHAN.peers).forEach(function(id){ var vt = VCHAN.peers[id].vt; if(vt) vt.sender.replaceTrack(track).catch(function(){}); });
  VCHAN.vidTile = voiceMakeTile(true);
  VCHAN.vidTile.firstChild.srcObject = stream;
  voiceSayVideo();
  voiceRender();
}

function voiceToggleCam(){
  if(!VCHAN.on) return;
  if(VCHAN.cam){ voiceVideoOff(); voiceSayVideo(); voiceRender(); return; }
  if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){ toast("This browser can't do video here", "ach"); return; }
  var btn = $("voiceCam"); btn.disabled = true;
  navigator.mediaDevices.getUserMedia({video:{width:{ideal:640}, height:{ideal:360}, frameRate:{ideal:24, max:30}}, audio:false})
    .then(function(stream){
      btn.disabled = false;
      // You left the call while the camera prompt was open.
      if(!VCHAN.on || VCHAN.cam){ stream.getTracks().forEach(function(t){ t.stop(); }); return; }
      voiceStartVideo(stream, false);
    })
    .catch(function(e){
      btn.disabled = false;
      toast(e && e.name === "NotFoundError" ? "No camera found" : "Camera blocked — allow it for this page to turn on video", "ach");
    });
}

function voiceToggleScreen(){
  if(!VCHAN.on) return;
  if(VCHAN.screen){ voiceVideoOff(); voiceSayVideo(); voiceRender(); return; }
  if(!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia){ toast("This browser can't share a screen here", "ach"); return; }
  var btn = $("voiceScreen"); btn.disabled = true;
  navigator.mediaDevices.getDisplayMedia({video:{frameRate:{ideal:15, max:30}, width:{max:1920}, height:{max:1080}}, audio:false})
    .then(function(stream){
      btn.disabled = false;
      if(!VCHAN.on || VCHAN.screen){ stream.getTracks().forEach(function(t){ t.stop(); }); return; }
      voiceStartVideo(stream, true);
    })
    .catch(function(e){
      btn.disabled = false;
      if(e && e.name === "NotAllowedError") return;   // you closed the picker: nothing to say
      toast("Couldn't share your screen", "ach");
    });
}

// Your video off: stop the camera or the shared screen (the camera light goes out, the browser's sharing bar goes
// away), stop sending it to everyone, drop your own tile.
function voiceVideoOff(){
  var s = VCHAN.vidStream;
  if(!s) return;
  VCHAN.vidStream = null; VCHAN.cam = false; VCHAN.screen = false;
  s.getTracks().forEach(function(t){ t.onended = null; t.stop(); });
  Object.keys(VCHAN.peers).forEach(function(id){ var vt = VCHAN.peers[id].vt; if(vt) vt.sender.replaceTrack(null).catch(function(){}); });
  if(VCHAN.vidTile){
    VCHAN.vidTile.firstChild.srcObject = null;
    if(VCHAN.vidTile.parentNode) VCHAN.vidTile.parentNode.removeChild(VCHAN.vidTile);
    VCHAN.vidTile = null;
  }
  var me = VCHAN.roster[VCHAN.peer];
  if(me){ me.cam = false; me.screen = false; }
}

(function(){
  var j = $("voiceJoin"), mu = $("voiceMute"), cm = $("voiceCam"), sc = $("voiceScreen"), lv = $("voiceLeave"), pill = $("voicePill");
  if(j) j.addEventListener("click", voiceJoin);
  if(mu) mu.addEventListener("click", voiceToggleMute);
  if(cm) cm.addEventListener("click", voiceToggleCam);
  if(sc) sc.addEventListener("click", voiceToggleScreen);
  if(lv) lv.addEventListener("click", voiceLeave);
  if(pill) pill.addEventListener("click", function(){ setView("arena"); });
})();

