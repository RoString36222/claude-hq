/* Claude HQ 3.15: the phone's comms apps, Messages, Nearby and Phone (HQV.hqPhoneComms; docs/plans/transport-revamp.md
 * 3.12 apps 7-9 and 5.8 / 5.11). They register in the phone shell's queue (games/hqphone.js, part `phone`) and talk to
 * window.hqPhoneSocial (ui/app/41-phone.js), which owns the network, the threads and the calls.
 *
 * Pure (node-tested, tests/test_hqphonecomms.py):
 *   counter(text, max)            -> {n, left, over, label}: characters (code points, as the Arena counts them)
 *   fmtTime(at, h24, nowMs)       -> "14:05" | "2:05 pm" (today), else "Mon 14:05" within a week, else "3 Oct"
 *   fmtDur(secs)                  -> "0:07" | "12:30" | "1:02:03"
 *   tickLabel(state)              -> "Sent" | "Delivered" (the words beside the ticks; colour is never the signal)
 *   mergeContacts(lists, me, blocked, max) lists = [[{id, name, handle?}], ...] in priority order (Here now, Nearby,
 *                                 recent senders, archipelago owners) -> [{id, name, handle, src: [list index...]}],
 *                                 one per id, the first list's name kept, never me or anyone blocked, at most max
 *   liveBubbles(bubbles, nowMs, calm) -> [{userId, name, text, alpha}] still showing (a 1 s fade at the end; calm:
 *                                 alpha 1 until gone)
 *   needsOptIn(enabled, key)      -> true when `key` ("smsSend" | "near" | "calls") is off
 *   callLabel(state, dir, secs)   -> the call screen's status line
 *   SERVICES                      -> the service numbers: [{id, name, app, arg}]
 *   bubbles()                     -> liveBubbles of hqPhoneSocial.near.bubbles() now (for the integrator to draw
 *                                 over avatars' heads; calm from the page)
 *   attach(phoneUi)               -> wire incoming calls (open the Phone app, a banner) and the unread badge to a
 *                                 mounted phone (HQV.hqPhone.mount's result); returns a detach function
 * DOM (textContent / createElement only): three apps pushed onto HQV.hqPhoneQueue: "messages", "nearby", "phone".
 */
(function(){
  "use strict";
  var W = (typeof window !== "undefined") ? window : globalThis;
  var HQV = W.HQV = W.HQV || {};

  /* ---------------------------------------------------------------- pure ---- */
  var DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var SERVICES = [
    {id: "cabs", name: "Claude Cabs", app: "cabs", arg: null},
    {id: "dealer", name: "Dealership", app: "dealer", arg: null},
    {id: "heli", name: "Heli dispatch", app: "cabs", arg: {cls: "heli"}},
    {id: "water", name: "Water taxi", app: "cabs", arg: {cls: "water"}}
  ];

  function chars(s){ return typeof s === "string" ? Array.from(s) : []; }
  function counter(text, max){
    max = Math.max(1, max | 0);
    var n = chars(typeof text === "string" ? text.trim() : "").length;
    return {n: n, left: max - n, over: n > max, label: n + "/" + max};
  }
  function pad2(n){ return (n < 10 ? "0" : "") + n; }
  function hm(d, h24){
    var h = d.getHours(), m = d.getMinutes();
    if(h24) return pad2(h) + ":" + pad2(m);
    return ((h % 12) || 12) + ":" + pad2(m) + (h < 12 ? " am" : " pm");
  }
  function fmtTime(at, h24, nowMs){
    at = +at || 0; nowMs = nowMs != null ? +nowMs : Date.now();
    var d = new Date(at), n = new Date(nowMs);
    if(d.toDateString() === n.toDateString()) return hm(d, h24);
    if(nowMs - at < 6 * 86400000 && nowMs >= at) return DAYS[d.getDay()] + " " + hm(d, h24);
    return d.getDate() + " " + MONTHS[d.getMonth()];
  }
  function fmtDur(secs){
    secs = Math.max(0, Math.floor(+secs || 0));
    var h = Math.floor(secs / 3600), m = Math.floor(secs % 3600 / 60), s = secs % 60;
    return h ? h + ":" + pad2(m) + ":" + pad2(s) : m + ":" + pad2(s);
  }
  function tickLabel(state){ return state === "delivered" ? "Delivered" : "Sent"; }
  function mergeContacts(lists, me, blocked, max){
    max = max != null ? Math.max(0, max | 0) : 60;
    var seen = {}, out = [], bl = Array.isArray(blocked) ? blocked : [];
    (Array.isArray(lists) ? lists : []).forEach(function(list, li){
      (Array.isArray(list) ? list : []).forEach(function(c){
        if(!c || typeof c.id !== "string" || !c.id || c.id === me || bl.indexOf(c.id) >= 0) return;
        var e = seen[c.id];
        if(e){ if(e.src.indexOf(li) < 0) e.src.push(li); if(!e.handle && c.handle) e.handle = String(c.handle); return; }
        if(out.length >= max) return;
        e = seen[c.id] = {id: c.id, name: String(c.name || c.handle || "Player").slice(0, 32), handle: c.handle ? String(c.handle) : "", src: [li]};
        out.push(e);
      });
    });
    return out;
  }
  function liveBubbles(bubbles, nowMs, calm){
    var out = [];
    (Array.isArray(bubbles) ? bubbles : []).forEach(function(b){
      if(!b || !(b.until > nowMs)) return;
      var left = b.until - nowMs;
      out.push({userId: b.userId, name: b.name || "", text: b.text || "", alpha: calm ? 1 : Math.max(0, Math.min(1, left / 1000))});
    });
    return out;
  }
  function needsOptIn(enabled, key){ return !(enabled && enabled[key] === true); }
  function callLabel(state, dir, secs){
    switch(state){
      case "ringing": return dir === "in" ? "Incoming call" : "Calling…";
      case "connecting": return "Connecting…";
      case "live": return fmtDur(secs);
      case "declined": return dir === "in" ? "Declined" : "They declined";
      case "no answer": return "No answer";
      case "missed": return "Missed call";
      case "unreachable": return "They are not here right now";
      case "failed": return "The call could not connect";
      default: return "Call ended";
    }
  }

  function social(host){ return (host && host.social) || W.hqPhoneSocial || null; }
  function calmNow(host){
    try { if(host && host.calm && host.calm()) return true; } catch(e){}
    var d = W.document;
    if(d && d.documentElement && d.documentElement.classList && d.documentElement.classList.contains("hq-calm")) return true;
    try { return !!(W.matchMedia && W.matchMedia("(prefers-reduced-motion: reduce)").matches); } catch(e){ return false; }
  }
  function h24(){ var c = W.CONFIG; return !!(c && c.phoneClock24 === true); }

  var API = HQV.hqPhoneComms = {
    counter: counter, fmtTime: fmtTime, fmtDur: fmtDur, tickLabel: tickLabel, mergeContacts: mergeContacts,
    liveBubbles: liveBubbles, needsOptIn: needsOptIn, callLabel: callLabel, SERVICES: SERVICES,
    bubbles: function(){ var S = social(null); return S && S.near ? liveBubbles(S.near.bubbles(), Date.now(), calmNow(null)) : []; }
  };

  /* ----------------------------------------------------------------- DOM ---- */
  var doc = W.document;
  if(!doc || !doc.createElement) return;   // node: the pure half only

  var CSS = [
    ".pc-app{display:flex;flex-direction:column;gap:8px;min-height:0;height:100%;color:var(--ink)}",
    ".pc-bar{display:flex;gap:6px;align-items:center;flex-wrap:wrap}",
    ".pc-btn{font:inherit;padding:6px 10px;border-radius:10px;border:1px solid var(--line);background:var(--panel);color:var(--ink);cursor:pointer}",
    ".pc-btn:focus-visible,.pc-item:focus-visible,.pc-tab:focus-visible{outline:2px solid var(--brand);outline-offset:2px}",
    ".pc-btn.pc-primary{background:var(--brand);color:var(--panel);border-color:var(--brand)}",
    ".pc-btn.pc-danger{border-color:var(--bad, var(--brand))}",
    ".pc-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px;overflow:auto;min-height:0}",
    ".pc-item{display:flex;gap:8px;align-items:center;width:100%;text-align:left;font:inherit;padding:8px;border-radius:10px;border:1px solid transparent;background:transparent;color:var(--ink);cursor:pointer}",
    ".pc-item:hover{border-color:var(--line)}",
    ".pc-grow{flex:1;min-width:0}",
    ".pc-name{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
    ".pc-sub,.pc-muted,.pc-hint{color:var(--muted);font-size:.85em;overflow:hidden;text-overflow:ellipsis}",
    ".pc-dot{min-width:1.4em;height:1.4em;padding:0 .3em;border-radius:.7em;background:var(--brand);color:var(--panel);font-size:.75em;display:inline-flex;align-items:center;justify-content:center}",
    ".pc-log{flex:1;overflow:auto;display:flex;flex-direction:column;gap:6px;min-height:0;padding:2px}",
    ".pc-msg{max-width:80%;padding:6px 10px;border-radius:14px;background:var(--panel);border:1px solid var(--line);align-self:flex-start;overflow-wrap:anywhere}",
    ".pc-msg.pc-me{align-self:flex-end;background:var(--brand);color:var(--panel);border-color:var(--brand)}",
    ".pc-meta{font-size:.75em;opacity:.8;margin-top:2px}",
    ".pc-compose{display:flex;gap:6px;align-items:center}",
    ".pc-compose input{flex:1;min-width:0;font:inherit;padding:8px;border-radius:10px;border:1px solid var(--line);background:var(--panel);color:var(--ink)}",
    ".pc-count{font-size:.8em;color:var(--muted);min-width:4.5em;text-align:right}",
    ".pc-count.pc-over{color:var(--ink);font-weight:700;text-decoration:underline}",
    ".pc-card{border:1px solid var(--line);border-radius:12px;padding:10px;background:var(--panel);display:flex;flex-direction:column;gap:8px}",
    ".pc-menu{display:flex;flex-direction:column;gap:4px;border:1px solid var(--line);border-radius:10px;padding:6px;background:var(--panel)}",
    ".pc-tabs{display:flex;gap:4px}",
    ".pc-tab{flex:1;font:inherit;padding:6px;border-radius:10px;border:1px solid var(--line);background:transparent;color:var(--ink);cursor:pointer}",
    ".pc-tab[aria-selected=true]{background:var(--brand);color:var(--panel);border-color:var(--brand)}",
    ".pc-call{display:flex;flex-direction:column;align-items:center;gap:14px;padding:24px 8px;text-align:center}",
    ".pc-avatar{width:84px;height:84px;border-radius:50%;background:var(--brand);color:var(--panel);display:flex;align-items:center;justify-content:center;font-size:2em;font-weight:700}",
    ".pc-vibrate{animation:pcbuzz .5s ease-in-out infinite}",
    "@keyframes pcbuzz{0%,100%{transform:rotate(0)}25%{transform:rotate(-4deg)}75%{transform:rotate(4deg)}}",
    "html.hq-calm .pc-vibrate{animation:none}",
    "@media (prefers-reduced-motion: reduce){.pc-vibrate{animation:none}}"
  ].join("\n");
  function css(){
    if(doc.getElementById("hqPhoneCommsCss") || !doc.head) return;
    var s = doc.createElement("style"); s.id = "hqPhoneCommsCss"; s.textContent = CSS; doc.head.appendChild(s);
  }
  var uidSeq = 0;
  function uid(p){ uidSeq++; return "pc-" + p + "-" + uidSeq; }
  function mk(tag, cls, parent, text){
    var n = doc.createElement(tag); if(cls) n.className = cls; if(text != null) n.textContent = text; if(parent) parent.appendChild(n); return n;
  }
  function btn(parent, text, cls, onClick, label){
    var b = mk("button", "pc-btn" + (cls ? " " + cls : ""), parent, text); b.type = "button";
    if(label) b.setAttribute("aria-label", label);
    if(onClick) b.addEventListener("click", onClick);
    return b;
  }
  function clear(n){ while(n && n.firstChild) n.removeChild(n.firstChild); }
  function say(host, msg){ try { if(host && host.announce) host.announce(msg); else if(typeof W.announce === "function") W.announce(msg); } catch(e){} }
  // Roving tabindex over the focusable items in a list: arrows, Home and End move; one item is in the tab order.
  function rove(list, sel){
    var items = Array.prototype.slice.call(list.querySelectorAll(sel));
    items.forEach(function(it, i){ it.tabIndex = i === 0 ? 0 : -1; });
    list.onkeydown = function(e){
      var its = Array.prototype.slice.call(list.querySelectorAll(sel)), i = its.indexOf(doc.activeElement);
      if(i < 0) return;
      var j = e.key === "ArrowDown" || e.key === "ArrowRight" ? Math.min(its.length - 1, i + 1)
            : e.key === "ArrowUp" || e.key === "ArrowLeft" ? Math.max(0, i - 1)
            : e.key === "Home" ? 0 : e.key === "End" ? its.length - 1 : -1;
      if(j < 0) return;
      e.preventDefault();
      its.forEach(function(it, k){ it.tabIndex = k === j ? 0 : -1; });
      its[j].focus();
    };
  }
  function initials(name){ var p = String(name || "?").trim().split(/\s+/); return ((p[0] || "?").charAt(0) + (p[1] ? p[1].charAt(0) : "")).toUpperCase(); }
  function optInCard(parent, title, text, label, onYes, onNo){
    var c = mk("div", "pc-card", parent); c.setAttribute("role", "group");
    var hid = uid("opt"); var hh = mk("strong", "", c, title); hh.id = hid; c.setAttribute("aria-labelledby", hid);
    mk("p", "pc-hint", c, text);
    var bar = mk("div", "pc-bar", c);
    var y = btn(bar, label, "pc-primary", onYes);
    if(onNo) btn(bar, "Not now", "", onNo);
    return y;
  }
  function compose(parent, max, placeholder, labelText, onSend){
    var row = mk("div", "pc-compose", parent);
    var inp = mk("input", "", row); inp.type = "text"; inp.setAttribute("aria-label", labelText); inp.placeholder = placeholder;
    inp.autocomplete = "off"; inp.setAttribute("maxlength", String(max * 2));
    var cnt = mk("span", "pc-count", row, "0/" + max); var cid = uid("cnt"); cnt.id = cid; inp.setAttribute("aria-describedby", cid);
    var send = btn(row, "Send", "pc-primary", function(){ go(); });
    function upd(){
      var c = counter(inp.value, max);
      cnt.textContent = c.over ? c.label + " too long" : c.label;
      cnt.className = "pc-count" + (c.over ? " pc-over" : "");
      send.disabled = c.n === 0 || c.over;
      return c;
    }
    function go(){ var c = upd(); if(c.n === 0 || c.over) return; onSend(inp.value.trim(), function(ok){ if(ok){ inp.value = ""; upd(); } }); }
    inp.addEventListener("input", upd);
    inp.addEventListener("keydown", function(e){ if(e.key === "Enter"){ e.preventDefault(); go(); } });
    upd();
    return {input: inp, update: upd};
  }

  /* ---------------------------------------------------------- Messages (7) ---- */
  var GLYPH_MSG = "M4 5h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9l-5 4v-4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z";
  var GLYPH_NEAR = "M12 3a4 4 0 1 1 0 8a4 4 0 0 1 0-8zM4 20c0-4 4-6 8-6s8 2 8 6zM2 9a10 10 0 0 1 3-6M22 9a10 10 0 0 0-3-6";
  var GLYPH_PHONE = "M6 3h3l2 5-2 1a11 11 0 0 0 6 6l1-2 5 2v3a2 2 0 0 1-2 2A17 17 0 0 1 4 5a2 2 0 0 1 2-2z";

  function renderMessages(el, host, nav){
    css();
    var S = social(host);
    var st = {view: "list", peer: null, who: null, menu: false, optin: false, pending: null, draft: "", q: "", dirTimer: 0, dir: []};
    var root = mk("div", "pc-app", el);
    var offs = [];
    if(!S){ mk("p", "pc-hint", root, "Messages need the HQ page."); return {}; }
    var arg = nav && nav.arg;
    if(arg && typeof arg === "object" && typeof arg.userId === "string"){ st.view = "thread"; st.peer = arg.userId; st.who = {name: arg.name, handle: arg.handle}; }
    function contacts(){
      var me = (host && host.me && host.me() && host.me().userId) || null;
      var here = S.calls.contacts();
      var near = S.near.people ? S.near.people() : [];
      var recent = S.sms.threads().map(function(t){ return {id: t.id, name: t.name, handle: t.handle}; });
      var owners = (host && typeof host.owners === "function") ? (host.owners() || []) : [];
      return mergeContacts([here, near, recent, owners], me, S.sms.blocked(), 60);
    }
    function draw(){
      var keepFocus = doc.activeElement && root.contains(doc.activeElement) ? doc.activeElement.getAttribute("data-k") : null;
      var draftEl = root.querySelector("[data-k=compose]");
      if(draftEl && st.view === "thread") st.draft = draftEl.value;   // an incoming message must not wipe what you are typing
      clear(root);
      if(st.view === "thread") drawThread(); else if(st.view === "new") drawNew(); else drawList();
      if(keepFocus){ var f = root.querySelector("[data-k=\"" + keepFocus.replace(/"/g, "") + "\"]"); if(f) f.focus(); }
    }
    function drawList(){
      S.sms.viewing(true);
      if(nav && nav.title) nav.title("Messages");
      var bar = mk("div", "pc-bar", root);
      var nb = btn(bar, "New message", "pc-primary", function(){ st.view = "new"; st.q = ""; st.dir = []; draw(); var i = root.querySelector("input"); if(i) i.focus(); });
      nb.setAttribute("data-k", "new");
      var ts = S.sms.threads().filter(function(t){ return !t.blocked; });
      if(!ts.length){ mk("p", "pc-hint", root, "No messages yet. Text anyone who plays: people here now, nearby, island owners, or search by handle."); return; }
      var ul = mk("ul", "pc-list", root); ul.setAttribute("aria-label", "Conversations");
      ts.forEach(function(t){
        var li = mk("li", "", ul);
        var b = mk("button", "pc-item", li); b.type = "button"; b.setAttribute("data-k", "t:" + t.id);
        var g = mk("span", "pc-grow", b);
        mk("div", "pc-name", g, t.name + (t.muted ? " (muted)" : ""));
        mk("div", "pc-sub", g, t.last ? (t.last.me ? "You: " : "") + t.last.text : "No messages yet");
        mk("span", "pc-muted", b, t.at ? fmtTime(t.at, h24()) : "");
        if(t.unread){ var d = mk("span", "pc-dot", b, String(t.unread)); d.setAttribute("aria-hidden", "true"); }
        b.setAttribute("aria-label", t.name + (t.unread ? ", " + t.unread + " unread" : "") + (t.muted ? ", muted" : "") + (t.last ? ", last message " + fmtTime(t.at, h24()) : ""));
        b.addEventListener("click", function(){ open(t.id, {name: t.name, handle: t.handle}); });
      });
      rove(ul, ".pc-item");
    }
    function open(id, who){ st.draft = ""; st.view = "thread"; st.peer = id; st.who = who || null; st.menu = false; st.optin = false; draw(); var i = root.querySelector("input"); if(i) i.focus(); }
    function drawNew(){
      S.sms.viewing(true);
      if(nav && nav.title) nav.title("New message");
      var bar = mk("div", "pc-bar", root);
      btn(bar, "Back", "", function(){ st.view = "list"; draw(); }, "Back to conversations").setAttribute("data-k", "back");
      var lab = mk("label", "pc-hint", root, "Search players by handle");
      var inp = mk("input", "", root); inp.type = "search"; inp.id = uid("q"); lab.setAttribute("for", inp.id);
      inp.value = st.q; inp.setAttribute("data-k", "q"); inp.autocomplete = "off"; inp.style.font = "inherit";
      var res = mk("div", "", root); res.setAttribute("aria-live", "polite");
      function list(people, label){
        clear(res);
        if(!people.length){ mk("p", "pc-hint", res, st.q.length >= 2 ? "Nobody with a handle starting “" + st.q + "”." : "Nobody to suggest yet: type at least 2 letters of a handle."); return; }
        var ul = mk("ul", "pc-list", res); ul.setAttribute("aria-label", label);
        people.forEach(function(p){
          var li = mk("li", "", ul), b = mk("button", "pc-item", li); b.type = "button"; b.setAttribute("data-k", "c:" + p.id);
          var g = mk("span", "pc-grow", b); mk("div", "pc-name", g, p.name); if(p.handle) mk("div", "pc-sub", g, "@" + p.handle);
          b.addEventListener("click", function(){ S.sms.touch(p.id, {name: p.name, handle: p.handle}); open(p.id, p); });
        });
        rove(ul, ".pc-item");
      }
      function search(){
        st.q = inp.value.trim();
        if(st.q.length < 2){ list(contacts(), "Suggested people"); return; }
        clearTimeout(st.dirTimer);
        st.dirTimer = setTimeout(function(){
          var q = st.q;
          S.sms.directory(q).then(function(u){ if(q === st.q && st.view === "new") list(u, "Players matching " + q); });
        }, 300);
      }
      inp.addEventListener("input", search);
      inp.addEventListener("keydown", function(e){ if(e.key === "ArrowDown"){ var f = res.querySelector(".pc-item"); if(f){ e.preventDefault(); f.focus(); } } });
      search();
    }
    function drawThread(){
      var id = st.peer, t = null;
      S.sms.viewing(id);
      S.sms.threads().forEach(function(x){ if(x.id === id) t = x; });
      var name = (t && t.name) || (st.who && (st.who.name || st.who.handle)) || "Player";
      if(nav && nav.title) nav.title(name);
      var bar = mk("div", "pc-bar", root);
      btn(bar, "Back", "", function(){ st.view = "list"; draw(); }, "Back to conversations").setAttribute("data-k", "back");
      mk("strong", "pc-grow pc-name", bar, name);
      var mb = btn(bar, "Options", "", function(){ st.menu = !st.menu; draw(); var f = root.querySelector(".pc-menu button"); if(f && st.menu) f.focus(); });
      mb.setAttribute("aria-expanded", st.menu ? "true" : "false"); mb.setAttribute("aria-haspopup", "true"); mb.setAttribute("data-k", "menu");
      var blocked = S.sms.blocked().indexOf(id) >= 0, muted = S.sms.muted().indexOf(id) >= 0;
      if(st.menu){
        var m = mk("div", "pc-menu", root); m.setAttribute("role", "group"); m.setAttribute("aria-label", "Conversation options");
        btn(m, muted ? "Unmute" : "Mute", "", function(){ S.sms.mute(id, !muted); say(host, muted ? "Unmuted" : "Muted: no alerts from " + name); st.menu = false; draw(); });
        btn(m, blocked ? "Unblock" : "Block", "pc-danger", function(){
          S.sms.block(id, !blocked).then(function(){ say(host, blocked ? name + " unblocked" : name + " blocked: they will not know"); st.menu = false; draw(); });
        });
        btn(m, "Report", "pc-danger", function(){
          var last = null; S.sms.thread(id).forEach(function(x){ if(!x.me) last = x.id; });
          S.sms.report(id, last).then(function(r){ say(host, r && r.ok ? "Reported. Thank you." : "Could not send the report"); st.menu = false; draw(); });
        });
      }
      if(blocked) mk("p", "pc-hint", root, "You blocked " + name + ". Their messages do not reach you.");
      var log = mk("div", "pc-log", root); log.setAttribute("role", "log"); log.setAttribute("aria-label", "Messages with " + name);
      var msgs = S.sms.thread(id);
      if(!msgs.length) mk("p", "pc-hint", log, "Say hello. Messages are at most 160 characters.");
      msgs.forEach(function(x){
        var b = mk("div", "pc-msg" + (x.me ? " pc-me" : ""), log);
        mk("div", "", b, x.text);
        var meta = mk("div", "pc-meta", b, fmtTime(x.at, h24()) + (x.me ? " · " + (x.state === "delivered" ? "✓✓ " : "✓ ") + tickLabel(x.state) : ""));
        meta.setAttribute("aria-label", (x.me ? "You, " : name + ", ") + fmtTime(x.at, h24()) + (x.me ? ", " + tickLabel(x.state) : ""));
      });
      log.scrollTop = log.scrollHeight;
      var status = mk("p", "pc-hint", root); status.setAttribute("aria-live", "polite");
      if(st.optin){
        var y = optInCard(root, "Turn on sending text messages?",
          "Only what you type (at most 160 characters) and who it is for go through the Arena, kept there until it is delivered and at most 7 days. You can turn it off in Settings.",
          "Turn on and send",
          function(){
            S.setEnabled("smsSend", true).then(function(r){
              st.optin = false;
              if(r && r.ok && r.on){ var p = st.pending; st.pending = null; draw(); if(p) doSend(p); }
              else { draw(); var s2 = root.querySelector("[aria-live=polite]"); if(s2) s2.textContent = (r && r.error) || "Could not turn it on"; }
            });
          },
          function(){ st.optin = false; draw(); });
        y.focus();
        return;
      }
      if(blocked) return;
      var cmp = compose(root, S.sms.MAX || 160, "Text message", "Message to " + name, function(text, done){ doSend(text, done); });
      cmp.input.setAttribute("data-k", "compose");
      if(st.pending || st.draft){ cmp.input.value = st.pending || st.draft; st.draft = ""; cmp.update(); }
      function doSend(text, done){
        status.textContent = "Sending…";
        S.sms.send(id, text, st.who || {name: name}).then(function(r){
          if(r && r.ok){ status.textContent = ""; st.pending = null; if(done) done(true); say(host, "Sent"); return; }
          if(r && r.optIn){ st.pending = text; st.optin = true; draw(); return; }
          var s3 = root.querySelector("[aria-live=polite]"); if(s3) s3.textContent = (r && r.error) || "Not sent";
          if(done) done(false);
        });
      }
    }
    offs.push(S.sms.onChange(function(){ if(st.view !== "new") draw(); }));
    draw();
    return {
      onKey: function(e){
        if(e.key !== "Escape") return false;
        if(st.menu){ st.menu = false; draw(); return true; }
        if(st.optin){ st.optin = false; draw(); return true; }
        if(st.view !== "list"){ st.view = "list"; draw(); return true; }
        return false;
      },
      dispose: function(){ offs.forEach(function(f){ try { f(); } catch(e){} }); clearTimeout(st.dirTimer); S.sms.viewing(null); }
    };
  }

  /* ------------------------------------------------------------ Nearby (8) ---- */
  function renderNearby(el, host, nav){
    css();
    var S = social(host);
    var root = mk("div", "pc-app", el), offs = [], lastPeople = "";
    if(!S){ mk("p", "pc-hint", root, "Nearby needs the HQ page."); return {}; }
    if(nav && nav.title) nav.title("Nearby");
    var peopleBox, logBox, status;
    function draw(){
      clear(root);
      if(needsOptIn(S.enabled(), "near")){
        optInCard(root, "Chat with people near you?",
          "Lines you type (at most 200 characters) go to players within 40 m of you in the same City and show over your head for 6 seconds. Nothing is kept. Only people who turned Nearby on see them.",
          "Turn on Nearby", function(){ S.setEnabled("near", true).then(function(){ draw(); say(host, "Nearby is on"); var i = root.querySelector("input"); if(i) i.focus(); }); }, null).focus();
        return;
      }
      if(host && host.inCity && !host.inCity()) mk("p", "pc-hint", root, "Open the City to chat with people near you.");
      var ph = mk("strong", "", root, "Within 40 m"); ph.id = uid("ppl");
      peopleBox = mk("ul", "pc-list", root); peopleBox.setAttribute("aria-labelledby", ph.id);
      drawPeople(true);
      logBox = mk("div", "pc-log", root); logBox.setAttribute("role", "log"); logBox.setAttribute("aria-label", "Nearby chat");
      drawFeed();
      status = mk("p", "pc-hint", root); status.setAttribute("aria-live", "polite");
      compose(root, S.near.MAX || 200, "Say something nearby", "Say something to people nearby", function(text, done){
        var ok = S.near.post(text);
        status.textContent = ok ? "" : "Not connected to the City yet.";
        done(ok);
      });
    }
    function drawPeople(force){
      if(!peopleBox) return;
      var ps = S.near.people ? S.near.people() : [];
      var sig = ps.map(function(p){ return p.id + ":" + p.dist; }).join(",");
      if(!force && sig === lastPeople) return;
      lastPeople = sig; clear(peopleBox);
      if(!ps.length){ mk("li", "pc-hint", peopleBox, "Nobody within 40 m right now."); return; }
      ps.slice(0, 12).forEach(function(p){ mk("li", "pc-sub", peopleBox, p.name + " · " + p.dist + " m"); });
    }
    function drawFeed(){
      if(!logBox) return;
      clear(logBox);
      var f = S.near.feed();
      if(!f.length){ mk("p", "pc-hint", logBox, "Nothing said nearby yet."); return; }
      f.forEach(function(x){
        var b = mk("div", "pc-msg" + (x.mine ? " pc-me" : ""), logBox);
        mk("div", "pc-meta", b, (x.mine ? "You" : x.name + " · " + x.dist + " m") + " · " + fmtTime(x.at, h24()));
        mk("div", "", b, x.text);
        if(x.mine && x.alone) mk("div", "pc-meta", b, "Nobody nearby heard that");
      });
      logBox.scrollTop = logBox.scrollHeight;
    }
    offs.push(S.near.onChange(function(){ if(needsOptIn(S.enabled(), "near")) draw(); else drawFeed(); }));
    draw();
    var lastTick = 0;
    return {
      tick: function(ms){ if(ms - lastTick > 2000){ lastTick = ms; drawPeople(false); } },
      dispose: function(){ offs.forEach(function(f){ try { f(); } catch(e){} }); }
    };
  }

  /* ------------------------------------------------------------- Phone (9) ---- */
  var LS_SEEN = "hq_phone_calls_seen";
  function seenAt(){ try { return +(W.localStorage && W.localStorage.getItem(LS_SEEN)) || 0; } catch(e){ return 0; } }
  function markSeen(){ try { if(W.localStorage) W.localStorage.setItem(LS_SEEN, String(Date.now())); } catch(e){} }
  function missedCount(S){
    if(!S || !S.calls) return 0;
    var t = seenAt(); return S.calls.recent().filter(function(r){ return r.missed && r.at > t; }).length;
  }
  function renderPhone(el, host, nav){
    css();
    var S = social(host);
    var root = mk("div", "pc-app", el), offs = [], st = {tab: "contacts", call: null, ringT: 0};
    if(!S){ mk("p", "pc-hint", root, "Calls need the HQ page."); return {}; }
    markSeen();
    if(nav && nav.setBadge) nav.setBadge(0);
    var arg = nav && nav.arg;
    st.call = S.calls.active ? S.calls.active() : null;
    function watchCall(h){
      st.call = h;
      if(h && h.onState) h.onState(function(s){
        if(s === "live") say(host, "Call connected");
        else if(s !== "ringing" && s !== "connecting") say(host, callLabel(s, h.dir, 0));
        draw();
      });
    }
    if(st.call) watchCall(st.call);
    function ringSound(){
      var c = st.call; if(!c || c.state() !== "ringing") return;
      try { if(host && host.sfx) host.sfx(c.dir === "in" ? "ring" : "dial"); } catch(e){}
    }
    function draw(){
      clear(root);
      var c = st.call;
      if(c && !(c.state() === "ringing" || c.state() === "connecting" || c.state() === "live")){
        // the call just ended: show it a moment, then go back to the lists
        drawCall(c);
        setTimeout(function(){ if(st.call === c){ st.call = null; draw(); } }, 2500);
        return;
      }
      if(c){ drawCall(c); return; }
      drawHome();
    }
    function drawCall(c){
      if(nav && nav.title) nav.title(c.state() === "ringing" && c.dir === "in" ? "Incoming call" : "Call");
      var box = mk("div", "pc-call", root); box.setAttribute("role", "group"); box.setAttribute("aria-label", "Call with " + c.name);
      var av = mk("div", "pc-avatar" + (c.state() === "ringing" && c.dir === "in" && !calmNow(host) ? " pc-vibrate" : ""), box, initials(c.name));
      av.setAttribute("aria-hidden", "true");
      mk("strong", "pc-name", box, c.name);
      var lab = mk("div", "pc-sub", box, callLabel(c.state(), c.dir, c.seconds())); lab.setAttribute("data-timer", "1");
      var bar = mk("div", "pc-bar", box), first = null;
      if(c.state() === "ringing" && c.dir === "in"){
        first = btn(bar, "Accept", "pc-primary", function(){ c.accept(); draw(); }, "Accept the call from " + c.name);
        btn(bar, "Decline", "pc-danger", function(){ c.decline(); draw(); }, "Decline the call");
      } else if(c.state() === "ringing" || c.state() === "connecting" || c.state() === "live"){
        if(c.state() !== "ringing"){
          var mu = btn(bar, c.muted() ? "Unmute" : "Mute", "", function(){ c.mute(!c.muted()); say(host, c.muted() ? "Microphone muted" : "Microphone on"); draw(); });
          mu.setAttribute("aria-pressed", c.muted() ? "true" : "false");
        }
        first = btn(bar, "Hang up", "pc-danger", function(){ c.hangup(); draw(); }, "Hang up");
      }
      if(first) first.focus();
    }
    function drawHome(){
      if(nav && nav.title) nav.title("Phone");
      var tabs = mk("div", "pc-tabs", root); tabs.setAttribute("role", "tablist"); tabs.setAttribute("aria-label", "Phone");
      var panelId = uid("panel");
      [["contacts", "Contacts"], ["recent", "Recent"], ["services", "Services"]].forEach(function(t){
        var b = mk("button", "pc-tab", tabs, t[1]); b.type = "button"; b.setAttribute("role", "tab"); b.id = uid("tab");
        b.setAttribute("aria-selected", st.tab === t[0] ? "true" : "false"); b.setAttribute("aria-controls", panelId);
        b.tabIndex = st.tab === t[0] ? 0 : -1;
        b.addEventListener("click", function(){ st.tab = t[0]; draw(); var f = root.querySelector("[role=tab][aria-selected=true]"); if(f) f.focus(); });
      });
      tabs.onkeydown = function(e){
        var order = ["contacts", "recent", "services"], i = order.indexOf(st.tab);
        var j = e.key === "ArrowRight" ? (i + 1) % 3 : e.key === "ArrowLeft" ? (i + 2) % 3 : e.key === "Home" ? 0 : e.key === "End" ? 2 : -1;
        if(j < 0) return; e.preventDefault(); st.tab = order[j]; draw(); var f = root.querySelector("[role=tab][aria-selected=true]"); if(f) f.focus();
      };
      var panel = mk("div", "", root); panel.id = panelId; panel.setAttribute("role", "tabpanel");
      var sel = tabs.querySelector("[aria-selected=true]"); if(sel) panel.setAttribute("aria-labelledby", sel.id);
      if(st.tab === "services") drawServices(panel); else if(st.tab === "recent") drawRecent(panel); else drawContacts(panel);
    }
    function drawContacts(panel){
      if(needsOptIn(S.enabled(), "calls")){
        optInCard(panel, "Turn on calls?",
          "Players in the same room can ring you and you can ring them. The call is audio straight between your two browsers; its setup, which carries your network address, goes to that one person only.",
          "Turn on calls", function(){ S.setEnabled("calls", true).then(function(){ say(host, "Calls are on"); draw(); }); }, null);
        return;
      }
      var cs = S.calls.contacts();
      if(!cs.length){ mk("p", "pc-hint", panel, "Nobody else is in this room right now. Calls reach players in the same HQ or City room."); return; }
      var ul = mk("ul", "pc-list", panel); ul.setAttribute("aria-label", "Players here");
      cs.forEach(function(p){
        var li = mk("li", "", ul), b = mk("button", "pc-item", li); b.type = "button";
        var g = mk("span", "pc-grow", b); mk("div", "pc-name", g, p.name); mk("div", "pc-sub", g, p.online ? "Here now" : "Away");
        mk("span", "pc-muted", b, "Call");
        b.setAttribute("aria-label", "Call " + p.name);
        b.addEventListener("click", function(){
          var h = S.calls.ring(p.id, p.name);
          if(!h){ say(host, "Cannot call right now: not connected to the room"); return; }
          watchCall(h); say(host, "Calling " + p.name); draw();
        });
      });
      rove(ul, ".pc-item");
    }
    function drawRecent(panel){
      var rs = S.calls.recent();
      if(!rs.length){ mk("p", "pc-hint", panel, "No calls yet."); return; }
      var ul = mk("ul", "pc-list", panel); ul.setAttribute("aria-label", "Recent calls");
      rs.forEach(function(r){
        var li = mk("li", "pc-item", ul); li.tabIndex = -1;
        var g = mk("span", "pc-grow", li); mk("div", "pc-name", g, r.name || "Player");
        var what = r.missed ? "Missed" : (r.dir === "in" ? "Incoming" : "Outgoing") + (r.secs ? " · " + fmtDur(r.secs) : "");
        mk("div", "pc-sub", g, what);
        mk("span", "pc-muted", li, fmtTime(r.at, h24()));
      });
      rove(ul, ".pc-item");
    }
    function drawServices(panel){
      var ul = mk("ul", "pc-list", panel); ul.setAttribute("aria-label", "Service numbers");
      SERVICES.forEach(function(s){
        var li = mk("li", "", ul), b = mk("button", "pc-item", li); b.type = "button";
        var g = mk("span", "pc-grow", b); mk("div", "pc-name", g, s.name);
        b.setAttribute("aria-label", "Call " + s.name);
        b.addEventListener("click", function(){ try { if(host && host.sfx) host.sfx("dial"); } catch(e){} if(nav && nav.open) nav.open(s.app, s.arg); });
      });
      rove(ul, ".pc-item");
    }
    offs.push(S.calls.onIncoming(function(h){ watchCall(h); draw(); }));
    offs.push(S.calls.onChange(function(){ if(!st.call) draw(); }));
    if(arg && typeof arg === "object" && typeof arg.call === "string" && !st.call){ var h0 = S.calls.ring(arg.call, arg.name); if(h0) watchCall(h0); }
    draw();
    var lastRing = 0;
    return {
      tick: function(ms){
        var c = st.call; if(!c) return;
        if(c.state() === "ringing" && ms - lastRing > 2000){ lastRing = ms; ringSound(); }
        if(c.state() === "live"){ var t = root.querySelector("[data-timer]"); if(t) t.textContent = callLabel("live", c.dir, c.seconds()); }
      },
      onKey: function(e){
        if(e.key === "Escape" && st.call && st.call.state() === "ringing" && st.call.dir === "in"){ st.call.decline(); draw(); return true; }
        return false;
      },
      dispose: function(){ offs.forEach(function(f){ try { f(); } catch(e){} }); }
    };
  }

  /* --------------------------------------------------- wiring to the shell ---- */
  API.attach = function(phoneUi){
    var S = social(null); if(!S || !phoneUi) return function(){};
    var offs = [];
    offs.push(S.calls.onIncoming(function(h){
      try { if(phoneUi.notify) phoneUi.notify({app: "phone", title: "Incoming call", text: h.name}); } catch(e){}
      try { if(phoneUi.open && !(phoneUi.isOpen && phoneUi.isOpen())) phoneUi.open("phone"); } catch(e){}
    }));
    function badges(){
      try { if(phoneUi.badge){ phoneUi.badge("messages", S.sms.unread()); phoneUi.badge("phone", missedCount(S)); } } catch(e){}
    }
    offs.push(S.sms.onChange(badges));
    offs.push(S.calls.onChange(badges));
    badges();
    return function(){ offs.forEach(function(f){ try { f(); } catch(e){} }); };
  };

  var Q = HQV.hqPhoneQueue = HQV.hqPhoneQueue || [];
  Q.push({id: "messages", name: "Messages", order: 20, glyph: GLYPH_MSG, dock: true, needsCity: false, render: renderMessages,
          badge: function(host){ var S = social(host); return S ? S.sms.unread() : 0; }});
  Q.push({id: "nearby", name: "Nearby", order: 21, glyph: GLYPH_NEAR, dock: false, needsCity: false, render: renderNearby,
          badge: function(){ return 0; }});
  Q.push({id: "phone", name: "Phone", order: 10, glyph: GLYPH_PHONE, dock: true, needsCity: false, render: renderPhone,
          badge: function(host){ return missedCount(social(host)); }});
})();
