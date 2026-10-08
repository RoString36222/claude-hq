/* Code Typing Race (HQ 2.1): race up to 8 people to type the same real code snippet.
 *
 * The Arena picks the snippet, counts down and judges progress (forward only, no faster
 * than anyone can type); this file draws the snippet (typed part, the next character,
 * mistakes), a lane per racer, and your live WPM and accuracy. Uses the shared lobby
 * shell in games/multi.js (HQV.mp). Only your position in the snippet is sent.
 */
(function(){
"use strict";
var HQV = window.HQV; if(!HQV || !HQV.api || !HQV.mp || !HQV.engine) return;
var api = HQV.api, MP = HQV.mp, E = HQV.engine;

function race(s){ return s.race || {phase: "idle", players: []}; }
function nm(u){ return MP.nameOf(u); }

MP.handlers.type = {
  on: function(m, s){
    if(m.ev === "type"){ var prev = race(s).phase; s.race = m.race;
      if(m.race.phase === "countdown" && prev !== "countdown"){ s.typed = ""; s.err = 0; s.startAt = 0; s.sentPos = -1; if(m.by) api.toast("⌨️ "+nm(m.by)+" started a typing race!"); }
      if(m.race.phase === "countdown") s.goAt = Date.now() + (m.race.goInMs|0); }
    if(m.ev === "go"){ var r = race(s); r.phase = "run"; s.startAt = Date.now(); E.sfx("go"); }
    if(m.ev === "prog"){ var R = race(s); (m.ps || []).forEach(function(p){ R.players.forEach(function(q){ if(q.user.userId === p.u){ q.pos = p.pos; q.fin = p.fin; } }); }); }
    if(m.ev === "done"){ var D = race(s); D.phase = "done"; D.results = m.results; E.sfx("finish"); }
  },
  render: function(ctx, s){ draw(ctx, s); }
};

function draw(ctx, s){
  var box = ctx.box, R = race(s), me = MP.me();
  box.textContent = "";
  var mine = (R.players || []).some(function(p){ return p.user.userId === me; });
  if(R.phase === "idle" || R.phase === "done"){
    if(R.results){
      var t = api.mk("table", "gb-table"), head = api.mk("tr");
      ["#", "Typist", "Time", "WPM", "Accuracy"].forEach(function(c){ head.appendChild(api.mk("th", null, c)); }); t.appendChild(head);
      R.results.forEach(function(r){ var tr = api.mk("tr", r.user.userId === me ? "you" : null);
        [r.place, nm(r.user), r.dnf ? "–" : E.fmtTime(r.ms), r.wpm, r.acc + "%"].forEach(function(v){ tr.appendChild(api.mk("td", null, String(v))); }); t.appendChild(tr); });
      box.appendChild(api.mk("h4", "vg-golf-h", "Last race"));
      box.appendChild(t);
    }
    box.appendChild(api.btn("Start a typing race", "primary", function(){ MP.send("type", "start"); }));
    box.appendChild(api.mk("p", "vg-muted", "Everyone in the lobby types the same real code snippet (Python, JavaScript, Rust, SQL or shell). The host starts it; the Arena keeps time."));
    return;
  }
  var text = R.text || "", typed = s.typed || "";
  box.appendChild(api.mk("p", "vg-muted", (R.lang ? R.lang + " · " : "") + (R.phase === "countdown" ? "Get ready…" : mine ? "Type it. Mistakes show red; backspace fixes them." : "Watching: you joined after it started.")));
  if(R.phase === "countdown"){ var left = Math.max(0, Math.ceil(((s.goAt || 0) - Date.now())/1000)); box.appendChild(api.mk("div", "tr-count", left ? String(left) : "GO!")); }
  // the snippet: typed (right / wrong), the next character, the rest
  var pre = api.mk("pre", "tr-text"); pre.tabIndex = 0; pre.setAttribute("aria-label", "Code to type. Focus here and type.");
  var good = 0; while(good < typed.length && typed[good] === text[good]) good++;
  if(good) pre.appendChild(api.mk("span", "tr-ok", text.slice(0, good)));
  if(typed.length > good) pre.appendChild(api.mk("span", "tr-bad", text.slice(good, typed.length)));
  var cur = typed.length < text.length ? text[typed.length] : "";
  if(cur) pre.appendChild(api.mk("span", "tr-cur", cur === "\n" ? "↵\n" : cur));
  pre.appendChild(document.createTextNode(text.slice(typed.length + 1)));
  box.appendChild(pre);
  // lanes
  var lanes = api.mk("div", "tr-lanes");
  (R.players || []).forEach(function(p){
    var lane = api.mk("div", "tr-lane" + (p.user.userId === me ? " you" : ""));
    lane.appendChild(api.mk("span", "tr-name", nm(p.user) + (p.fin != null ? " 🏁" : "")));
    var bar = api.mk("span", "tr-bar"), fill = api.mk("i"); fill.style.width = Math.round(100*(p.pos||0)/Math.max(1, text.length)) + "%";
    bar.appendChild(fill); lane.appendChild(bar); lanes.appendChild(lane);
  });
  box.appendChild(lanes);
  if(mine && s.startAt){
    var mins = Math.max(1/60, (Date.now() - s.startAt)/60000);
    box.appendChild(api.mk("p", "tr-stats", Math.round((good/5)/mins) + " WPM · " + Math.round(100*good/Math.max(1, good + (s.err|0))) + "% accuracy"));
  }
  if(mine && R.phase === "run"){
    pre.addEventListener("keydown", function(e){
      if(e.metaKey || e.ctrlKey || e.altKey) return;
      var ch = e.key === "Enter" ? "\n" : e.key === "Tab" ? "    " : e.key.length === 1 ? e.key : null;
      if(e.key === "Backspace"){ e.preventDefault(); s.typed = (s.typed || "").slice(0, -1); draw(ctx, s); return; }
      if(ch === null) return;
      e.preventDefault();
      if((s.typed || "").length >= text.length) return;
      var t2 = (s.typed || "") + ch;
      for(var i = (s.typed || "").length; i < t2.length; i++){ if(t2[i] !== text[i]) s.err = (s.err|0) + 1; }
      s.typed = t2.slice(0, text.length);
      draw(ctx, s);
    });
    setTimeout(function(){ if(ctx.alive && document.activeElement && document.activeElement.tagName !== "INPUT") pre.focus(); }, 0);
  }
}
// send how far you are (the correct prefix) a few times a second while you type
function sendProg(ctx, s){
  var R = race(s); if(R.phase !== "run") return;
  var text = R.text || "", typed = s.typed || "", good = 0; while(good < typed.length && typed[good] === text[good]) good++;
  if(good === s.sentPos) return;
  s.sentPos = good; MP.send("type", "prog", {pos: good, err: s.err|0});
}
MP.register("type", "⌨️", "Race to type real code, up to 8", function(ctx){
  var s = MP.st("type"); draw(ctx, s);
  var t1 = setInterval(function(){ sendProg(ctx, s); }, 200);
  var t2 = setInterval(function(){ var R = race(s); if(R.phase === "countdown" || R.phase === "run") draw(ctx, s); }, 500);
  ctx.stop = function(){ clearInterval(t1); clearInterval(t2); };
});
})();
