/* ================= The boombox: your Music room song, out loud in the 3D City (HQ 3.11) ================= */
// While you are tuned in to your Music room and its song plays, your character carries a boombox on the
// shoulder (games/hq3d.js boomStep). Presence carries the song (`bb`, its YouTube id), when it started on the
// Arena's clock (`bt`) and its title (`bn`), to an Arena that lists "boombox". Anyone near you in the City hears
// it: this page plays the nearest boombox in range in a hidden YouTube embed, in step with yours, louder the
// closer you are. Nothing is played through the Arena or this machine's server.
// (3.12.1) Live in the Music tab ("Go live") carries it too: anyone near a DJ in the City listens to the live set
// (ui/app/29-music.js muListen, browser to browser), louder the closer they are, and stops when they walk away.
var BOOM = {frame:null, v:null, u:null, t:0, at:0, state:-1, vol:-1, ready:false, heard:{}, mine:"", live:null};
var BOOM_RANGE = 28, BOOM_FULL = 4, BOOM_ID = /^[A-Za-z0-9_-]{11}$/;

// Your boombox's song: the room's current one while it plays and you are tuned in; null otherwise.
function boomMine(){
  if(typeof MU === "undefined" || !MU || !MU.tuned) return null;
  var s = MU.st;
  if(!s || !s.cur || !s.playing || typeof s.startAt !== "number" || !BOOM_ID.test(s.cur.v || "")) return null;
  return {v: s.cur.v, t: Math.round(s.startAt), n: String(s.cur.title || "").slice(0, 80)};
}
// What presence carries for it ({bb, bt, bn}), for ui/app/22-hq.js hqNetSend.
function boomNet(){ var m = boomMine(); return m ? {bb: m.v, bt: m.t, bn: m.n} : null; }
// How loud a boombox d metres away plays, 0..1: full within BOOM_FULL, silent at BOOM_RANGE.
function boomGain(d){
  var f = Math.max(0, Math.min(1, (BOOM_RANGE - d)/(BOOM_RANGE - BOOM_FULL)));
  return f*f;
}
// Who is live in your Arena room: {their Arena user id: their page's peer id} (29-music.js MU.lives).
function boomLives(){
  var out = {};
  if(typeof MU === "undefined" || !MU || !MU.lives) return out;
  Object.keys(MU.lives).forEach(function(peer){ var L = MU.lives[peer]; if(L && typeof L.userId === "string") out[L.userId] = peer; });
  return out;
}
function boomLiveMe(){ return !!(typeof MU !== "undefined" && MU && MU.dj); }
// Stop a live set this page started listening to because its DJ was near (never one you chose in the Music tab).
function boomLiveStop(){
  if(BOOM.live && typeof MU !== "undefined" && MU && MU.listen && MU.listen.peer === BOOM.live && typeof muListenStop === "function") muListenStop();
  BOOM.live = null;
}
function boomArenaNow(){ return Date.now() + (typeof MU !== "undefined" && MU ? MU.offset || 0 : 0); }

/* ---------- the hidden player ---------- */
function boomPost(func, args){
  if(!BOOM.frame || !BOOM.frame.contentWindow) return;
  try { BOOM.frame.contentWindow.postMessage(JSON.stringify({event:"command", func:func, args:args || [], id:"hqboom", channel:"widget"}), "*"); } catch(e){}
}
function boomDrop(){
  if(BOOM.frame && BOOM.frame.parentNode) BOOM.frame.parentNode.removeChild(BOOM.frame);
  clearInterval(BOOM.hello);
  BOOM.frame = null; BOOM.v = null; BOOM.u = null; BOOM.ready = false; BOOM.vol = -1; BOOM.at = 0; BOOM.state = -1;
}
function boomPlay(p, gain, host2){
  var startS = Math.max(0, (boomArenaNow() - p.bt)/1000);
  var f = document.createElement("iframe");
  f.className = "hq-boom-frame"; f.title = "Boombox"; f.setAttribute("aria-hidden", "true"); f.tabIndex = -1;
  f.allow = "autoplay; encrypted-media";
  f.referrerPolicy = "strict-origin-when-cross-origin";
  f.src = "https://" + (host2 ? "www.youtube.com" : "www.youtube-nocookie.com") + "/embed/" + encodeURIComponent(p.bb) + "?enablejsapi=1&autoplay=1&playsinline=1&controls=0&rel=0&start=" + Math.floor(startS) + "&origin=" + encodeURIComponent(location.origin);
  f.addEventListener("load", function(){
    var tries = 0;
    clearInterval(BOOM.hello);
    BOOM.hello = setInterval(function(){
      if(BOOM.frame !== f || BOOM.at || ++tries > 40){ clearInterval(BOOM.hello); return; }
      try { f.contentWindow.postMessage(JSON.stringify({event:"listening", id:"hqboom", channel:"widget"}), "*"); } catch(e){}
    }, 250);
    BOOM.ready = true; BOOM.vol = -1;
    boomPost("addEventListener", ["onStateChange"]);
    boomPost("addEventListener", ["onError"]);
    boomVolume(gain);
    boomPost("playVideo");
  });
  document.body.appendChild(f);
  BOOM.frame = f; BOOM.v = p.bb; BOOM.u = p.u; BOOM.bt = p.bt; BOOM.ready = false; BOOM.at = 0; BOOM.state = -1; BOOM.p = p; BOOM.host2 = !!host2;
}
function boomVolume(gain){
  var base = typeof MU !== "undefined" && MU ? MU.volume : 80;
  var v = Math.round(base*gain);
  if(!BOOM.ready || Math.abs(v - BOOM.vol) < 2 && !(v === 0 && BOOM.vol !== 0)) return;
  BOOM.vol = v; boomPost("setVolume", [v]);
}
window.addEventListener("message", function(e){
  if(!BOOM.frame || e.source !== BOOM.frame.contentWindow) return;
  if(!/^https:\/\/(www\.)?youtube(-nocookie)?\.com$/.test(e.origin)) return;
  var d; try { d = typeof e.data === "string" ? JSON.parse(e.data) : e.data; } catch(err){ return; }
  if(!d || typeof d !== "object") return;
  if(d.event === "infoDelivery" && d.info && typeof d.info === "object"){
    if(typeof d.info.currentTime === "number"){ BOOM.t = d.info.currentTime; BOOM.at = Date.now(); }
    if(typeof d.info.playerState === "number") BOOM.state = d.info.playerState;
  } else if(d.event === "onStateChange" && typeof d.info === "number") BOOM.state = d.info;
  // a video that won't play in the privacy-enhanced player: YouTube's main one, once
  else if(d.event === "onError" && !BOOM.host2 && BOOM.p){ var p = BOOM.p, vol = BOOM.vol; boomDrop(); boomPlay(p, Math.max(0, vol)/100, true); }
});
// Keep it in step with the owner's song (within 2.5 s).
function boomSync(){
  if(!BOOM.ready || !BOOM.at) return;
  var want = (boomArenaNow() - BOOM.bt)/1000;
  var have = BOOM.t + (BOOM.state === 1 ? (Date.now() - BOOM.at)/1000 : 0);
  if(BOOM.state !== 1 && BOOM.state !== 3) boomPost("playVideo");
  if(Math.abs(have - want) > 2.5) boomPost("seekTo", [Math.max(0, want), true]);
}

/* ---------- each quarter second ---------- */
function boomTick(){
  var I = window.HQ3D && HQ3D.inst;
  var mine = boomMine(), liveMe = boomLiveMe(), lives = boomLives(), drawn = {};
  Object.keys(lives).forEach(function(u){ drawn[u] = 1; });
  if(I && I.setBoombox) I.setBoombox(!!mine || liveMe);
  if(I && I.setBoomLive) I.setBoomLive(drawn);
  var on = liveMe ? "live" : mine ? "song:" + mine.v : "";
  if(on !== BOOM.mine){
    BOOM.mine = on;
    if(on && VIEW === "hq") toast("📻 Boombox on: anyone near you in the City hears " + (liveMe ? "your live set" : "“" + (mine.n || "your song") + "”"), "level");
  }
  // someone else's, nearest first, on your floor and in range (a little further before it stops: no flicker at the edge)
  var w = VIEW === "hq" && I && I.where ? I.where() : null, best = null, bestD = 1e9;
  if(w && w.world && typeof HQNET !== "undefined"){
    (HQNET.peers || []).forEach(function(p){
      if(!p || p.w !== w.world) return;
      var song = typeof p.bb === "string" && BOOM_ID.test(p.bb) && typeof p.bt === "number";
      if(!song && !lives[p.u]) return;
      var d = Math.hypot(p.x/100 - w.x, p.z/100 - w.z) - (p.u === BOOM.u ? 4 : 0);   // the one playing keeps the lead
      if(d < bestD){ bestD = d; best = p; }
    });
  }
  var livePeer = best ? lives[best.u] : null;
  // the song you already hear from the Music tab is not played twice
  if(best && !livePeer && mine && mine.v === best.bb) best = null;
  if(best && bestD > BOOM_RANGE + (best.u === BOOM.u ? 0 : -4)) best = null;
  if(!best || !livePeer) boomLiveStop();
  if(!best){ if(BOOM.frame || BOOM.u) boomDrop(); return; }
  var dist = best.u === BOOM.u ? bestD + 4 : bestD, gain = boomGain(dist);
  if(livePeer){
    if(BOOM.frame) boomDrop();
    BOOM.u = best.u;
    // a live set: not over your own Music room song, your own set, or one you chose to listen to
    var L = MU.listen;
    if(mine || liveMe || (L && L.peer !== BOOM.live) || typeof muListen !== "function") return;
    if(!L || L.peer !== livePeer){
      if(Date.now() - (BOOM.liveAt || 0) < 5000) return;          // a set that dropped: try again every 5 s, not every tick
      boomLiveStop(); muListen(livePeer); BOOM.live = livePeer; BOOM.liveAt = Date.now();
      var lk = best.u + ":live";
      if(!BOOM.heard[lk]){ BOOM.heard[lk] = 1; toast("📻 " + (best.n || "Someone") + "'s boombox: their live set", "level"); }
      return;
    }
    if(L.audio) L.audio.volume = Math.max(0, Math.min(1, (MU.volume/100)*gain));
    return;
  }
  if(BOOM.u === best.u && BOOM.v === best.bb && BOOM.bt !== best.bt)BOOM.bt = best.bt;   // resumed or sought: boomSync catches up
  if(BOOM.u !== best.u || BOOM.v !== best.bb){
    boomDrop(); boomPlay(best, gain);
    var key = best.u + ":" + best.bb;
    if(!BOOM.heard[key]){ BOOM.heard[key] = 1; toast("📻 " + (best.n || "Someone") + "'s boombox: " + (best.bn || "a song"), "level"); }
    return;
  }
  boomVolume(gain);
  boomSync();
}
setInterval(boomTick, 250);
