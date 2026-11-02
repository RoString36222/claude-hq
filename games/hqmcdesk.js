/* HQ Mission Control desk panel: approve/deny a session's pending permission request (via
 * /api/mcdesk, the HQ Notch relay protocol) and, when supported, send it a message.
 * window.HQV.hqMcDesk = {panel(container, session, api) -> {update(session), destroy()}, describe(req)}
 * api = {get(url) -> Promise<json>, post(url, body) -> Promise<json>}; the caller adds x-hq-token.
 * Untrusted text is only ever set with textContent. Never auto-approves. */
(function(){
"use strict";
var G = typeof window !== "undefined" ? window : globalThis;
var HQV = G.HQV = G.HQV || {};
var BOX = "background:rgba(8,14,20,.94);color:#e8eef3;border:1px solid #2b3b4a;border-radius:10px;padding:12px 14px;font:13px system-ui,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.5)";
var BTN = "cursor:pointer;border-radius:7px;padding:6px 12px;font-weight:700;border:0;";

/* Exactly what approving lets run: tool name plus the full command / path / input. Pure. */
function describe(req){
  req = req || {}; var ti = req.input && typeof req.input === "object" ? req.input : {};
  var tool = String(req.tool || "?"), detail;
  if(typeof ti.command === "string") detail = ti.command;
  else if(typeof ti.file_path === "string") detail = ti.file_path;
  else if(typeof ti.url === "string") detail = ti.url;
  else { try { detail = JSON.stringify(ti, null, 2); } catch(e){ detail = String(req.target || ""); } }
  return {tool: tool, detail: String(detail || req.target || ""), cwd: String(req.cwd || "")};
}
function sid(s){ return s && (s.sessionId || s.id) || ""; }
function el(doc, tag, css, text){ var e = doc.createElement(tag); if(css) e.style.cssText = css; if(text != null) e.textContent = text; return e; }

function panel(container, session, api){
  var doc = G.document, cur = session, state = null, dead = false, timer = null;
  var root = el(doc, "div", BOX); root.className = "hqs hqmcdesk-panel";
  container.appendChild(root);
  function q(){ return "/api/mcdesk/pending?sessionId=" + encodeURIComponent(sid(cur)); }
  function refresh(){ if(dead) return; api.get(q()).then(function(s){ state = s; draw(); }, function(){ state = {error: "desk unavailable"}; draw(); }); }
  function decide(req, d){ api.post("/api/mcdesk/decide", {id: req.id, sessionId: req.sessionId, decision: d}).then(refresh, refresh); }
  function draw(){
    if(dead) return; root.textContent = "";
    root.appendChild(el(doc, "b", "font-size:15px;display:block;margin-bottom:6px", "Desk · approvals"));
    var s = state || {};
    if(s.error && !s.requests){ root.appendChild(el(doc, "div", "color:#ff9f9f", String(s.error))); }
    if(state && !s.deskHook){
      var box = el(doc, "div", "color:#9fb3c4;font-size:12px");
      ((s.install && s.install.steps) || ["Install HQ Notch, then the desk hook."]).forEach(function(t){ box.appendChild(el(doc, "div", "", t)); });
      if(s.install && s.install.entry) box.appendChild(el(doc, "pre", "white-space:pre-wrap;word-break:break-all;background:#101a22;padding:6px;border-radius:6px;font-size:11px", JSON.stringify(s.install.entry, null, 2)));
      root.appendChild(box);
    }
    var reqs = s.requests || [];
    if(!reqs.length) root.appendChild(el(doc, "div", "color:#7f93a4;margin:6px 0", state ? "Nothing waiting." : "Loading…"));
    reqs.forEach(function(r){
      var d = describe(r), card = el(doc, "div", "margin:8px 0;border:1px solid #2b3b4a;border-radius:8px;padding:8px;background:#101a22");
      card.appendChild(el(doc, "div", "font-weight:600;color:#4fd8ff", "Approve " + d.tool + "?"));
      card.appendChild(el(doc, "pre", "white-space:pre-wrap;word-break:break-all;max-height:160px;overflow:auto;margin:6px 0;font-size:12px", d.detail));
      if(d.cwd) card.appendChild(el(doc, "div", "font-size:11px;color:#7f93a4", "in " + d.cwd));
      var row = el(doc, "div", "display:flex;gap:6px;margin-top:6px");
      var ok = el(doc, "button", BTN + "background:#4fd8ff;color:#05121a", "Approve"), no = el(doc, "button", BTN + "background:#3a2026;color:#ffb3b3", "Deny");
      ok.type = no.type = "button";
      ok.onclick = function(){ ok.disabled = no.disabled = true; decide(r, "allow"); };
      no.onclick = function(){ ok.disabled = no.disabled = true; decide(r, "deny"); };
      row.appendChild(ok); row.appendChild(no); card.appendChild(row); root.appendChild(card);
    });
    var m = s.message || {}, ta = el(doc, "textarea", "width:100%;box-sizing:border-box;margin-top:8px;background:#101a22;color:#e8eef3;border:1px solid #2b3b4a;border-radius:6px;min-height:48px");
    ta.placeholder = "Message to this session"; ta.disabled = !m.supported;
    var send = el(doc, "button", BTN + "margin-top:6px;width:100%;background:" + (m.supported ? "#4fd8ff;color:#05121a" : "#1a2630;color:#7f93a4"), "Send");
    send.type = "button"; send.disabled = !m.supported;
    send.onclick = function(){ var t = ta.value.trim(); if(!t) return; send.disabled = true;
      api.post("/api/mcdesk/message", {sessionId: sid(cur), text: t}).then(function(){ ta.value = ""; refresh(); }, refresh); };
    root.appendChild(ta); root.appendChild(send);
    if(!m.supported && m.reason) root.appendChild(el(doc, "div", "margin-top:4px;font-size:11px;color:#7f93a4", m.reason));
  }
  draw(); refresh(); timer = setInterval(refresh, 3000);
  return {
    update: function(s){ var changed = sid(s) !== sid(cur); cur = s; if(changed) refresh(); },
    destroy: function(){ dead = true; clearInterval(timer); if(root.parentNode) root.parentNode.removeChild(root); }
  };
}

HQV.hqMcDesk = {panel: panel, describe: describe};
})();
