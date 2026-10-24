/* ---- HQ 3.15 the phone's social side: SMS, nearby chat and calls (window.hqPhoneSocial, plan 5.11) ----
   The page half the phone apps (games/hqphonecomms.js) talk to; it works with or without the 3D City open.
     SMS     to any player, online or offline, through the paired Arena (/api/arena/sms/* -> /v1/sms/*). Sending
             needs your one-time opt-in, held by the Arena (POST optin); receiving is on by default. Threads live in
             this browser only (localStorage, at most HQPS_THREAD_MAX messages a thread and HQPS_THREADS_MAX
             threads). Mute is local; block is the Arena's (silent to the sender). The inbox is read every 30 s
             while the page is visible and at once when the Arena pushes {type:"sms"} on any open room socket.
     Nearby  text to opted-in players within 40 m in the same City room ({type:"say", data:{kind:"near"}} on the
             hq presence socket), shown as a feed and as bubbles over heads for 6 s. Opt-in (`phoneNear`).
     Calls   ring a player in the same room ({type:"ring"} / {type:"ring_ans"}), then 1:1 WebRTC audio set up over
             {type:"signal", data:{kind:"call"}}; the audio flows browser to browser. Opt-in (`phoneCalls`).
   Privacy: only what the player types into Messages / Nearby, user ids, and call setup to ONE target. Nothing from a
   transcript, a session, a path or a project. Notifications never show a message's text unless Messages is open.
   DOM: none of its own (toasts and announce() only); textContent everywhere. */
(function(){
  var W = window;
  var HQPS_THREAD_MAX = 200, HQPS_THREADS_MAX = 50, HQPS_FEED_MAX = 50, HQPS_RECENT_MAX = 30;
  var HQPS_POLL_MS = 30000, HQPS_BUBBLE_MS = 6000, HQPS_RING_MS = 30000, HQPS_SMS_MAX = 160, HQPS_NEAR_MAX = 200;
  var LS_THREADS = "hq_phone_sms", LS_MUTE = "hq_phone_mute", LS_RECENT = "hq_phone_calls";
  var ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

  function lsGet(k, d){ try { var v = W.localStorage && W.localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch(e){ return d; } }
  function lsSet(k, v){ try { if(W.localStorage) W.localStorage.setItem(k, JSON.stringify(v)); } catch(e){} }
  function now(){ return Date.now(); }
  function str(v, n){ return typeof v === "string" ? v.slice(0, n || 200) : ""; }
  function cfg(){ return (typeof CONFIG !== "undefined" && CONFIG) ? CONFIG : (W.CONFIG || {}); }
  function myId(){
    if(typeof HQNET !== "undefined" && HQNET && HQNET.me) return HQNET.me;
    var A = W.ARENA; return (A && A.you && A.you.userId) || PS.meId || null;
  }
  function say(msg){ try { if(typeof announce === "function") announce(msg); } catch(e){} }
  function pop(msg, cls){ try { if(typeof toast === "function") toast(msg, cls); } catch(e){} }
  function log(icon, text){ try { if(typeof logEvent === "function") logEvent(icon, text); } catch(e){} }

  var PS = {
    on: false, meKnown: false, meId: null, blocks: [], muted: lsGet(LS_MUTE, []),
    threads: lsGet(LS_THREADS, {}), viewing: null, polling: false,
    near: [], bubbles: [], nearSock: null, sockets: [],
    calls: {}, recent: lsGet(LS_RECENT, []), incomingFns: [],
    fns: {sms: [], near: [], calls: []}
  };
  if(!PS.threads || typeof PS.threads !== "object" || Array.isArray(PS.threads)) PS.threads = {};
  if(!Array.isArray(PS.muted)) PS.muted = [];
  if(!Array.isArray(PS.recent)) PS.recent = [];

  function emit(kind){ (PS.fns[kind] || []).slice().forEach(function(fn){ try { fn(); } catch(e){} }); }
  function sub(kind, fn){
    if(typeof fn !== "function") return function(){};
    PS.fns[kind].push(fn);
    return function(){ var i = PS.fns[kind].indexOf(fn); if(i >= 0) PS.fns[kind].splice(i, 1); };
  }

  /* ---- the Arena, through the local proxy ---- */
  function get(path){
    if(typeof fetch !== "function") return Promise.resolve({ok:false, status:0, j:{}});
    return fetch("/api/arena/sms/" + path, {cache:"no-store"}).then(function(r){
      return r.json().then(function(j){ return {ok:r.ok, status:r.status, j:j || {}}; }, function(){ return {ok:r.ok, status:r.status, j:{}}; });
    }, function(){ return {ok:false, status:0, j:{}}; });
  }
  function post(path, body){
    if(typeof arenaPost === "function") return arenaPost("/api/arena/sms/" + path, body).catch(function(){ return {ok:false, status:0, j:{}}; });
    if(typeof fetch !== "function") return Promise.resolve({ok:false, status:0, j:{}});
    return fetch("/api/arena/sms/" + path, {method:"POST", headers:{"Content-Type":"application/json", "X-HQ-Token": (typeof CSRF === "string" ? CSRF : "")},
      body: JSON.stringify(body || {})}).then(function(r){
      return r.json().then(function(j){ return {ok:r.ok, status:r.status, j:j || {}}; }, function(){ return {ok:r.ok, status:r.status, j:{}}; });
    }, function(){ return {ok:false, status:0, j:{}}; });
  }
  function paired(){ var A = W.ARENA; return !!(A && A.paired); }

  /* ---- SMS threads (this browser only) ---- */
  function saveThreads(){
    var ids = Object.keys(PS.threads);
    if(ids.length > HQPS_THREADS_MAX){
      ids.sort(function(a, b){ return (PS.threads[b].last || 0) - (PS.threads[a].last || 0); });
      ids.slice(HQPS_THREADS_MAX).forEach(function(id){ delete PS.threads[id]; });
    }
    lsSet(LS_THREADS, PS.threads);
  }
  function thread(uid, who){
    var t = PS.threads[uid];
    if(!t){ t = PS.threads[uid] = {id: uid, name: "", handle: "", msgs: [], unread: 0, last: 0}; }
    if(!Array.isArray(t.msgs)) t.msgs = [];
    if(who){ if(who.name) t.name = str(who.name, 64); if(who.handle) t.handle = str(who.handle, 64); }
    return t;
  }
  function addMsg(t, m){
    for(var i = 0; i < t.msgs.length; i++) if(m.id && t.msgs[i].id === m.id) return false;
    t.msgs.push(m);
    t.msgs.sort(function(a, b){ return (a.at || 0) - (b.at || 0); });
    if(t.msgs.length > HQPS_THREAD_MAX) t.msgs.splice(0, t.msgs.length - HQPS_THREAD_MAX);
    t.last = Math.max(t.last || 0, m.at || 0);
    return true;
  }
  function isMuted(uid){ return PS.muted.indexOf(uid) >= 0; }
  function isBlocked(uid){ return PS.blocks.indexOf(uid) >= 0; }
  // One incoming message from the inbox or the live push: kept (deduped), counted, notified. True when new.
  function ingest(m){
    if(!m || typeof m !== "object" || typeof m.id !== "string" || !m.from || typeof m.from.id !== "string") return false;
    if(!ID_RE.test(m.from.id) || isBlocked(m.from.id)) return false;
    var t = thread(m.from.id, m.from);
    var at = typeof m.at === "number" ? m.at : (Date.parse(m.at) || now());
    if(!addMsg(t, {id: str(m.id, 64), me: false, text: str(m.text, HQPS_SMS_MAX), at: at, state: "delivered"})) return false;
    if(PS.viewing !== m.from.id) t.unread = (t.unread | 0) + 1;
    return true;
  }
  function notify(newBy){
    var ids = Object.keys(newBy); if(!ids.length) return;
    var n = 0, loud = [];
    ids.forEach(function(uid){ if(isMuted(uid) || PS.viewing === uid) return; n += newBy[uid].n; loud.push(uid); });
    if(!n) return;
    var open = PS.viewing !== null;   // Messages is open: the text may show
    loud.forEach(function(uid){
      var t = PS.threads[uid], who = (t && (t.name || t.handle)) || "Someone";
      pop(open && newBy[uid].text ? who + ": " + newBy[uid].text : who + ": New message", "level");
      log("💬", "New message from " + who);
    });
    say(n === 1 ? "1 new message" : n + " new messages");
  }
  // Read the inbox, keep what is new, acknowledge it (delivered ticks; the Arena then drops the text).
  function poll(){
    if(PS.polling || !paired()) return Promise.resolve(false);
    PS.polling = true;
    return get("inbox").then(function(r){
      var ms = (r.ok && r.j && Array.isArray(r.j.messages)) ? r.j.messages : [], newBy = {}, lastId = null;
      ms.forEach(function(m){
        if(m && typeof m.id === "string") lastId = m.id;
        if(ingest(m)){ var u = m.from.id; newBy[u] = newBy[u] || {n: 0, text: ""}; newBy[u].n++; newBy[u].text = str(m.text, HQPS_SMS_MAX); }
      });
      if(ms.length){ saveThreads(); notify(newBy); emit("sms"); }
      var p = lastId ? post("ack", {upto: lastId}) : Promise.resolve(null);
      return p.then(ticks).then(function(){ PS.polling = false; return ms.length > 0; });
    }).catch(function(){ PS.polling = false; return false; });
  }
  // The sender's ticks: which of my recent sent messages have arrived.
  function ticks(){
    var ids = [], cut = now() - 7 * 86400000;
    Object.keys(PS.threads).forEach(function(uid){
      PS.threads[uid].msgs.forEach(function(m){ if(m.me && m.state === "sent" && m.id && (m.at || 0) > cut && ids.length < 50) ids.push(m.id); });
    });
    if(!ids.length) return Promise.resolve();
    return get("status?ids=" + encodeURIComponent(ids.join(","))).then(function(r){
      var d = (r.ok && r.j && Array.isArray(r.j.delivered)) ? r.j.delivered : [];
      if(!d.length) return;
      Object.keys(PS.threads).forEach(function(uid){ PS.threads[uid].msgs.forEach(function(m){ if(m.me && d.indexOf(m.id) >= 0) m.state = "delivered"; }); });
      saveThreads(); emit("sms");
    });
  }
  function loadMe(){
    if(!paired()) return Promise.resolve(null);
    return get("me").then(function(r){
      if(!r.ok || !r.j) return null;
      PS.on = r.j.on === true; PS.meKnown = true;
      PS.blocks = Array.isArray(r.j.blocks) ? r.j.blocks.filter(function(b){ return typeof b === "string"; }) : [];
      emit("sms");
      return r.j;
    });
  }

  var sms = {
    threads: function(){
      return Object.keys(PS.threads).map(function(uid){
        var t = PS.threads[uid], l = t.msgs[t.msgs.length - 1] || null;
        return {id: uid, name: t.name || t.handle || "Player", handle: t.handle || "", unread: t.unread | 0, at: t.last || 0,
                last: l ? {text: l.text, at: l.at, me: !!l.me} : null, muted: isMuted(uid), blocked: isBlocked(uid)};
      }).sort(function(a, b){ return b.at - a.at || (a.id < b.id ? -1 : 1); });
    },
    thread: function(uid){
      var t = PS.threads[uid]; if(!t) return [];
      return t.msgs.map(function(m){ return {id: m.id, me: !!m.me, text: m.text, at: m.at, state: m.me ? (m.state || "sent") : "delivered"}; });
    },
    // Messages is showing this thread (or null when it closes): its unread clears and new texts may show in a toast.
    viewing: function(uid){
      PS.viewing = (typeof uid === "string" || uid === true) ? uid : null;
      var t = typeof uid === "string" ? PS.threads[uid] : null;
      if(t && t.unread){ t.unread = 0; saveThreads(); emit("sms"); }
    },
    // Remember who a thread is with before the first message (a contact picked from the directory).
    touch: function(uid, who){ if(typeof uid === "string" && ID_RE.test(uid)){ var t = thread(uid, who); if(!t.last) t.last = now(); saveThreads(); emit("sms"); } },
    send: function(uid, text, who){
      var body = typeof text === "string" ? text.trim() : "";
      if(typeof uid !== "string" || !ID_RE.test(uid)) return Promise.resolve({ok: false, error: "Pick someone to message"});
      if(!body) return Promise.resolve({ok: false, error: "Type a message first"});
      if(Array.from(body).length > HQPS_SMS_MAX) return Promise.resolve({ok: false, error: "At most 160 characters"});
      if(!paired()) return Promise.resolve({ok: false, error: "Pair with the Arena to send messages"});
      return post("send", {to: uid, text: body}).then(function(r){
        if(r.status === 409){ PS.on = false; emit("sms"); return {ok: false, optIn: true, error: "Turn on sending first"}; }
        if(!r.ok || !r.j || typeof r.j.id !== "string") return {ok: false, status: r.status, error: (r.j && typeof r.j.detail === "string") ? r.j.detail : "Not sent"};
        var t = thread(uid, who);
        addMsg(t, {id: r.j.id, me: true, text: body, at: now(), state: "sent"});
        saveThreads(); emit("sms");
        return {ok: true, id: r.j.id};
      });
    },
    block: function(uid, on){
      if(typeof uid !== "string" || !ID_RE.test(uid)) return Promise.resolve(PS.blocks.slice());
      return post("block", {user: uid, on: !!on}).then(function(r){
        if(r.ok && r.j && Array.isArray(r.j.blocks)) PS.blocks = r.j.blocks.filter(function(b){ return typeof b === "string"; });
        emit("sms"); return PS.blocks.slice();
      });
    },
    blocked: function(){ return PS.blocks.slice(); },
    mute: function(uid, on){
      if(typeof uid !== "string") return;
      var i = PS.muted.indexOf(uid);
      if(on && i < 0) PS.muted.push(uid); else if(!on && i >= 0) PS.muted.splice(i, 1);
      lsSet(LS_MUTE, PS.muted); emit("sms");
    },
    muted: function(){ return PS.muted.slice(); },
    report: function(uid, msgId){
      if(typeof uid !== "string" || !ID_RE.test(uid)) return Promise.resolve({ok: false});
      return post("report", {user: uid, id: (typeof msgId === "string" && ID_RE.test(msgId)) ? msgId : ""}).then(function(r){ return {ok: !!r.ok}; });
    },
    directory: function(q){
      q = typeof q === "string" ? q.trim().replace(/^@/, "") : "";
      // a handle prefix as the local proxy forwards it: 2 to 24 of A-Z a-z 0-9 _ . -
      if(!/^[A-Za-z0-9_.-]{2,24}$/.test(q) || !paired()) return Promise.resolve([]);
      return get("directory?q=" + encodeURIComponent(q)).then(function(r){
        var u = (r.ok && r.j && Array.isArray(r.j.users)) ? r.j.users : [];
        return u.filter(function(x){ return x && typeof x.id === "string" && ID_RE.test(x.id); })
                .map(function(x){ return {id: x.id, name: str(x.name, 64) || str(x.handle, 64), handle: str(x.handle, 64)}; });
      });
    },
    onChange: function(fn){ return sub("sms", fn); },
    unread: function(){
      var n = 0; Object.keys(PS.threads).forEach(function(uid){ if(!isMuted(uid) && !isBlocked(uid)) n += PS.threads[uid].unread | 0; }); return n;
    },
    refresh: function(){ return loadMe().then(poll); },
    MAX: HQPS_SMS_MAX
  };

  /* ---- the room sockets: the hq presence socket (22-hq.js HQNET.ws, which may be the shared ARENA.sock) ---- */
  function hqSock(){
    var s = (typeof HQNET !== "undefined" && HQNET) ? HQNET.ws : null;
    return (s && s.readyState === 1) ? s : null;
  }
  function sendOn(s, msg){ if(!s) return false; try { s.send(JSON.stringify(msg)); return true; } catch(e){ return false; } }
  function canPhone(){ return typeof hqNetCan === "function" ? hqNetCan("phone") : true; }
  // Listen on every room socket the page opens (no hook needed in 19-arena-rooms.js / 22-hq.js): the Arena pushes
  // "sms" on any of them, and the nearby / ring / call frames arrive on the hq presence socket.
  function watch(s){
    if(!s || PS.sockets.indexOf(s) >= 0 || typeof s.addEventListener !== "function") return;
    PS.sockets.push(s);
    s.addEventListener("message", function(ev){ var m; try { m = JSON.parse(ev.data); } catch(e){ return; } onSocket(m, s); });
    s.addEventListener("close", function(){ var i = PS.sockets.indexOf(s); if(i >= 0) PS.sockets.splice(i, 1); if(PS.nearSock === s) PS.nearSock = null; });
  }
  function sweep(){
    if(typeof HQNET !== "undefined" && HQNET && HQNET.ws) watch(HQNET.ws);
    if(W.ARENA && W.ARENA.sock) watch(W.ARENA.sock);
    // nearby is per socket: say so again whenever the presence socket changes
    var s = hqSock(), want = cfg().phoneNear === true;
    if(s && want && PS.nearSock !== s && canPhone()){ if(sendOn(s, {type: "near_on", on: true})) PS.nearSock = s; }
    if(s && !want && PS.nearSock === s){ sendOn(s, {type: "near_on", on: false}); PS.nearSock = null; }
  }
  function onSocket(m, s){
    if(!m || typeof m !== "object") return;
    if(m.type === "sms"){ ingestLive(m); return; }
    if(m.type === "say" && m.data && m.data.kind === "near"){ nearIn(m); return; }
    if(m.type === "ring"){ ringIn(m, s); return; }
    if(m.type === "ring_ans"){ ringAns(m); return; }
    if(m.type === "ring_ack"){ var c = PS.calls[m.id]; if(c && c.dir === "out" && !(m.delivered > 0)) callEnd(c, "unreachable"); return; }
    if(m.type === "signal" && m.data && m.data.kind === "call"){ callSignal(m); return; }
    if(m.type === "near_ack" && m.n === 0){ var f = PS.near[PS.near.length - 1]; if(f && f.mine && f.id == null){ f.id = m.id; f.alone = true; emit("near"); } }
  }
  function ingestLive(m){
    // show it at once, then read the inbox (which acknowledges it and anything older still waiting)
    var fresh = ingest(m);
    if(fresh){ var nb = {}; nb[m.from.id] = {n: 1, text: str(m.text, HQPS_SMS_MAX)}; saveThreads(); notify(nb); emit("sms"); }
    poll();
  }

  /* ---- nearby ---- */
  function nearIn(m){
    var f = m.from || {}, d = m.data || {};
    if(typeof f.userId !== "string" || typeof d.text !== "string" || cfg().phoneNear !== true) return;
    if(isBlocked(f.userId)) return;
    var at = now(), name = str(f.displayName || f.handle, 24) || "Player";
    PS.near.push({from: f.userId, name: name, text: str(d.text, HQPS_NEAR_MAX), at: at, dist: Math.max(0, d.d | 0)});
    if(PS.near.length > HQPS_FEED_MAX) PS.near.splice(0, PS.near.length - HQPS_FEED_MAX);
    PS.bubbles = PS.bubbles.filter(function(b){ return b.userId !== f.userId && b.until > at; });
    PS.bubbles.push({userId: f.userId, name: name, text: str(d.text, HQPS_NEAR_MAX), until: at + HQPS_BUBBLE_MS});
    emit("near");
  }
  var near = {
    post: function(text){
      var t = typeof text === "string" ? text.trim().slice(0, HQPS_NEAR_MAX) : "";
      if(!t || cfg().phoneNear !== true) return false;
      sweep();
      var s = hqSock(); if(!s || !canPhone()) return false;
      if(!sendOn(s, {type: "say", data: {kind: "near", text: t}})) return false;
      var at = now(), me = myId() || "me";
      PS.near.push({from: me, name: "You", text: t, at: at, dist: 0, mine: true});
      if(PS.near.length > HQPS_FEED_MAX) PS.near.splice(0, PS.near.length - HQPS_FEED_MAX);
      PS.bubbles = PS.bubbles.filter(function(b){ return b.userId !== me && b.until > at; });
      PS.bubbles.push({userId: me, name: "You", text: t, until: at + HQPS_BUBBLE_MS});
      emit("near");
      return true;
    },
    feed: function(){ return PS.near.map(function(e){ return {from: e.from, name: e.name, text: e.text, at: e.at, dist: e.dist, mine: !!e.mine, alone: !!e.alone}; }); },
    onChange: function(fn){ return sub("near", fn); },
    bubbles: function(){ var t = now(); PS.bubbles = PS.bubbles.filter(function(b){ return b.until > t; }); return PS.bubbles.map(function(b){ return {userId: b.userId, name: b.name, text: b.text, until: b.until}; }); },
    // Who stands within 40 m on your floor right now (from the presence snapshot), nearest first.
    people: function(){
      if(typeof HQNET === "undefined" || !HQNET || !Array.isArray(HQNET.peers) || !W.HQ3D || !W.HQ3D.inst || !W.HQ3D.inst.where) return [];
      var w = W.HQ3D.inst.where(); if(!w) return [];
      return HQNET.peers.map(function(p){ return {id: p.u, name: str(p.n, 24) || "Player", dist: Math.round(Math.hypot((p.x || 0) / 100 - w.x, (p.z || 0) / 100 - w.z)), w: p.w}; })
        .filter(function(p){ return p.w === w.world && p.dist <= 40; }).sort(function(a, b){ return a.dist - b.dist; });
    },
    MAX: HQPS_NEAR_MAX
  };

  /* ---- calls: ring, answer, then 1:1 WebRTC audio ---- */
  function callId(){
    var b = new Uint8Array(8);
    try { W.crypto.getRandomValues(b); } catch(e){ for(var i = 0; i < 8; i++) b[i] = (now() >> (i * 3)) & 255; }
    return "c" + Array.prototype.map.call(b, function(x){ return (x < 16 ? "0" : "") + x.toString(16); }).join("");
  }
  function recentAdd(c){
    PS.recent.unshift({id: c.id, userId: c.peer, name: c.name, dir: c.dir, at: c.started, secs: c.liveAt ? Math.round((now() - c.liveAt) / 1000) : 0,
                       missed: c.dir === "in" && !c.liveAt});
    if(PS.recent.length > HQPS_RECENT_MAX) PS.recent.length = HQPS_RECENT_MAX;
    lsSet(LS_RECENT, PS.recent);
  }
  function callSet(c, st){ c.st = st; c.fns.slice().forEach(function(fn){ try { fn(st); } catch(e){} }); emit("calls"); }
  function callEnd(c, why){
    if(!c || c.done) return;
    c.done = true; clearTimeout(c.timer);
    try { if(c.pc) c.pc.close(); } catch(e){}
    try { if(c.mic) c.mic.getTracks().forEach(function(t){ t.stop(); }); } catch(e){}
    try { if(c.audio){ c.audio.srcObject = null; if(c.audio.parentNode) c.audio.parentNode.removeChild(c.audio); } } catch(e){}
    delete PS.calls[c.id];
    recentAdd(c);
    callSet(c, why || "ended");
    if(why === "missed" && c.dir === "in"){ log("📵", "Missed call from " + c.name); say("Missed call"); }
  }
  function sig(c, data){ data.kind = "call"; data.call = c.id; sendOn(c.sock || hqSock(), {type: "signal", to: c.peer, data: data}); }
  function iceList(){ return (typeof VCHAN_ICE !== "undefined") ? VCHAN_ICE : [{urls: "stun:stun.l.google.com:19302"}]; }
  function makePc(c){
    if(typeof RTCPeerConnection !== "function") return null;
    var pc = new RTCPeerConnection({iceServers: iceList()});
    pc.onicecandidate = function(e){ if(e.candidate) sig(c, {op: "ice", cand: e.candidate.toJSON ? e.candidate.toJSON() : e.candidate}); };
    pc.ontrack = function(e){
      if(!c.audio && typeof document !== "undefined"){ c.audio = document.createElement("audio"); c.audio.autoplay = true; c.audio.hidden = true; document.body.appendChild(c.audio); }
      if(c.audio) c.audio.srcObject = e.streams[0];
    };
    pc.onconnectionstatechange = function(){
      if(pc.connectionState === "connected" && c.st !== "live"){ c.liveAt = now(); callSet(c, "live"); say("Call connected"); }
      if(pc.connectionState === "failed" || pc.connectionState === "closed") callEnd(c, c.liveAt ? "ended" : "failed");
    };
    c.pc = pc; return pc;
  }
  function mic(c){
    if(!W.navigator || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return Promise.reject(new Error("no microphone"));
    return navigator.mediaDevices.getUserMedia({audio: true, video: false}).then(function(s){
      c.mic = s; if(c.muted) s.getAudioTracks().forEach(function(t){ t.enabled = false; });
      if(c.pc) s.getTracks().forEach(function(t){ c.pc.addTrack(t, s); });
      return s;
    });
  }
  function handle(c){
    return {
      id: c.id, peer: c.peer, name: c.name, dir: c.dir,
      state: function(){ return c.st; },
      seconds: function(){ return c.liveAt ? Math.max(0, Math.floor((now() - c.liveAt) / 1000)) : 0; },
      onState: function(fn){ if(typeof fn === "function") c.fns.push(fn); },
      mute: function(on){ c.muted = !!on; try { if(c.mic) c.mic.getAudioTracks().forEach(function(t){ t.enabled = !c.muted; }); } catch(e){} emit("calls"); },
      muted: function(){ return !!c.muted; },
      accept: function(){
        if(c.dir !== "in" || c.st !== "ringing") return;
        callSet(c, "connecting"); clearTimeout(c.timer);
        sendOn(c.sock, {type: "ring_ans", to: c.peer, id: c.id, ok: true});
        makePc(c);
        c.micReady = mic(c).catch(function(){ callEnd(c, "failed"); });
      },
      decline: function(){
        if(c.dir !== "in" || c.st !== "ringing") return;
        sendOn(c.sock, {type: "ring_ans", to: c.peer, id: c.id, ok: false}); callEnd(c, "declined");
      },
      hangup: function(){
        if(c.done) return;
        sig(c, {op: "bye"});   // the other side stops ringing (or hangs up too)
        callEnd(c, "ended");
      }
    };
  }
  function newCall(dir, peer, name, id, sock){
    var c = {id: id, dir: dir, peer: peer, name: str(name, 24) || "Player", st: "ringing", started: now(), fns: [], sock: sock, muted: false};
    PS.calls[id] = c;
    c.timer = setTimeout(function(){ if(c.st === "ringing") callEnd(c, dir === "in" ? "missed" : "no answer"); }, HQPS_RING_MS);
    c.h = handle(c);
    return c;
  }
  function ringIn(m, s){
    var f = m.from || {};
    if(typeof f.userId !== "string" || typeof m.id !== "string" || !ID_RE.test(m.id)) return;
    // Calls off, or blocked: the ring is ignored (the caller hears no answer, exactly as when you are away).
    if(cfg().phoneCalls !== true || isBlocked(f.userId) || PS.calls[m.id]) return;
    if(Object.keys(PS.calls).length){ sendOn(s, {type: "ring_ans", to: f.userId, id: m.id, ok: false}); return; }   // busy
    var c = newCall("in", f.userId, f.displayName || f.handle, m.id, s);
    say("Incoming call from " + c.name);
    PS.incomingFns.slice().forEach(function(fn){ try { fn(c.h); } catch(e){} });
    emit("calls");
  }
  function ringAns(m){
    var c = PS.calls[m.id], f = m.from || {};
    if(!c || c.dir !== "out" || f.userId !== c.peer || c.st !== "ringing") return;
    clearTimeout(c.timer);
    if(m.ok !== true){ callEnd(c, "declined"); return; }
    callSet(c, "connecting");
    var pc = makePc(c); if(!pc){ callEnd(c, "failed"); return; }
    mic(c).then(function(){ return pc.createOffer(); }).then(function(o){ return pc.setLocalDescription(o).then(function(){ sig(c, {op: "offer", sdp: o.sdp}); }); })
      .catch(function(){ callEnd(c, "failed"); });
  }
  function callSignal(m){
    var d = m.data, c = PS.calls[d.call], f = m.from || {};
    if(!c || f.userId !== c.peer) return;
    if(d.op === "bye"){ callEnd(c, c.liveAt ? "ended" : (c.dir === "in" && c.st === "ringing" ? "missed" : "ended")); return; }
    var pc = c.pc; if(!pc) return;
    if(d.op === "offer" && typeof d.sdp === "string" && c.dir === "in"){
      (c.micReady || Promise.resolve()).then(function(){ return pc.setRemoteDescription({type: "offer", sdp: d.sdp}); })
        .then(function(){ return pc.createAnswer(); })
        .then(function(a){ return pc.setLocalDescription(a).then(function(){ sig(c, {op: "answer", sdp: a.sdp}); }); })
        .catch(function(){ callEnd(c, "failed"); });
    } else if(d.op === "answer" && typeof d.sdp === "string" && c.dir === "out"){
      pc.setRemoteDescription({type: "answer", sdp: d.sdp}).catch(function(){ callEnd(c, "failed"); });
    } else if(d.op === "ice" && d.cand && typeof d.cand === "object"){
      try { pc.addIceCandidate(d.cand).catch(function(){}); } catch(e){}
    }
  }
  var calls = {
    contacts: function(){
      var me = myId(), seen = {}, out = [];
      var peers = (typeof HQNET !== "undefined" && HQNET && Array.isArray(HQNET.peers)) ? HQNET.peers : [];
      peers.forEach(function(p){
        if(!p || typeof p.u !== "string" || p.u === me || seen[p.u] || isBlocked(p.u)) return;
        seen[p.u] = 1; out.push({id: p.u, name: str(p.n, 24) || "Player", online: true});
      });
      return out.sort(function(a, b){ return a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : 0; });
    },
    ring: function(uid, name){
      if(cfg().phoneCalls !== true || typeof uid !== "string" || !ID_RE.test(uid)) return null;
      sweep();
      var s = hqSock(); if(!s || !canPhone() || Object.keys(PS.calls).length) return null;
      var c = newCall("out", uid, name, callId(), s);
      if(!sendOn(s, {type: "ring", to: uid, id: c.id})){ callEnd(c, "failed"); }
      emit("calls");
      return c.h;
    },
    onIncoming: function(fn){ if(typeof fn !== "function") return function(){}; PS.incomingFns.push(fn); return function(){ var i = PS.incomingFns.indexOf(fn); if(i >= 0) PS.incomingFns.splice(i, 1); }; },
    active: function(){ var ids = Object.keys(PS.calls); return ids.length ? PS.calls[ids[0]].h : null; },
    recent: function(){ return PS.recent.slice(); },
    onChange: function(fn){ return sub("calls", fn); }
  };

  /* ---- opt-ins ---- */
  function enabled(){ var c = cfg(); return {smsSend: PS.on === true, near: c.phoneNear === true, calls: c.phoneCalls === true}; }
  function setEnabled(key, on){
    on = !!on;
    if(key === "smsSend"){
      if(!paired()) return Promise.resolve({ok: false, error: "Pair with the Arena first"});
      return post("optin", {on: on}).then(function(r){ if(r.ok && r.j) PS.on = r.j.on === true; emit("sms"); return {ok: !!r.ok, on: PS.on}; });
    }
    var k = key === "near" ? "phoneNear" : key === "calls" ? "phoneCalls" : null;
    if(!k) return Promise.resolve({ok: false});
    var body = {}; body[k] = on;
    var c = cfg(); c[k] = on;
    if(k === "phoneNear"){ sweep(); if(!on){ PS.near = []; PS.bubbles = []; emit("near"); } }
    if(k === "phoneCalls" && !on) Object.keys(PS.calls).forEach(function(id){ PS.calls[id].h.hangup(); });
    emit(key === "near" ? "near" : "calls");
    if(typeof postConfig !== "function") return Promise.resolve({ok: true, on: on});
    return postConfig(body).then(function(r){ return {ok: !!r.ok, on: on}; }, function(){ return {ok: false, on: on}; });
  }

  W.hqPhoneSocial = {
    enabled: enabled, setEnabled: setEnabled, sms: sms, near: near, calls: calls,
    // for the integrator: hand a room-socket frame in by hand (the listeners above already see every socket)
    onSocket: function(m){ onSocket(m, hqSock()); },
    LIMITS: {sms: HQPS_SMS_MAX, near: HQPS_NEAR_MAX, thread: HQPS_THREAD_MAX, threads: HQPS_THREADS_MAX, bubbleMs: HQPS_BUBBLE_MS}
  };

  // every second: notice new sockets (cheap); every 30 s while visible: the inbox
  if(typeof setInterval === "function"){
    setInterval(sweep, 1000);
    setInterval(function(){
      if(typeof document !== "undefined" && document.hidden) return;
      if(!PS.meKnown) loadMe(); poll();
    }, HQPS_POLL_MS);
    setTimeout(function(){ loadMe().then(poll); }, 4000);
  }
  if(typeof document !== "undefined" && document.addEventListener){
    document.addEventListener("visibilitychange", function(){ if(!document.hidden) poll(); });
  }
})();
