/* ================= HQ 2.0: the 3D HQ view, and the switch to and from the classic dashboard ================= */
// The scene itself lives in games/hq3d.js (loaded with games/engine.js the first time HQ opens, so the
// page stays light for anyone who never opens it). This file feeds it the live payload, lists the crew
// beside it (also the keyboard and screen-reader way in), and remembers which mode you use:
// localStorage hq_mode = "3d" | "classic". With Calm mode or reduced motion, the classic dashboard
// is where HQ opens unless you switch.
var HQ3D = {inst:null, load:null, filter:null, lastClassic:"live", failed:false};
function hqModePref(){ try { return localStorage.getItem("hq_mode"); } catch(e){ return null; } }
function hqModeSave(m){ try { localStorage.setItem("hq_mode", m); } catch(e){} }
function hqCalm(){ return document.documentElement.classList.contains("hq-calm") ||
  !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches); }
function hqWebGL(){ try { return !!document.createElement("canvas").getContext("webgl2"); } catch(e){ return false; } }

function hqLoadScripts(){
  if(HQ3D.load) return HQ3D.load;
  var files = (window.HQV && window.HQV.engine) ? ["hq3d"] : ["engine","hq3d"];
  HQ3D.load = files.reduce(function(p, name){
    return p.then(function(){ return new Promise(function(res, rej){
      var sc=document.createElement("script"); sc.src="/games/"+name+".js"; sc.async=false;
      sc.onload=res; sc.onerror=function(){ rej(new Error(name+".js failed to load")); };
      document.head.appendChild(sc);
    }); });
  }, Promise.resolve()).catch(function(e){ HQ3D.load=null; throw e; });
  return HQ3D.load;
}
function hqApi(){
  return {
    name: ((typeof cfg==="function" && cfg().trainerName) || "You"),
    openSession: hqOpen,
    go: function(v){ hqModeSave("classic"); setView(v); },
    onFilter: function(p){ HQ3D.filter = p || null; hqRenderCrew(); }
  };
}
// A crew member's card: the same session drawer the classic views open.
function hqOpen(id){
  var s=((STATE && STATE.sessions) || []).filter(function(x){ return x.sessionId===id; })[0];
  if(s && typeof openDrawer==="function") openDrawer(s);
  else if(typeof openSession==="function") openSession(id);
}
function hqEnter(){
  var stage=$("hqStage"); if(!stage) return;
  if(!hqWebGL()){
    HQ3D.failed=true; stage.textContent="";
    var p=document.createElement("p"); p.className="hq3d-msg"; p.textContent="This browser can't draw the 3D HQ (no WebGL 2). The crew list on the right and the classic dashboard work as usual.";
    var b=document.createElement("button"); b.className="hbtn"; b.type="button"; b.textContent="Classic dashboard"; b.addEventListener("click", hqToggle);
    stage.appendChild(p); stage.appendChild(b); hqRenderCrew(); return;
  }
  hqLoadScripts().then(function(){
    if(VIEW!=="hq") return;
    if(!HQ3D.inst){ HQ3D.inst = window.HQV.hq3d.mount(stage, hqApi()); }
    HQ3D.inst.update((STATE && STATE.sessions) || []);
    HQ3D.inst.setFilter(HQ3D.filter);
    HQ3D.inst.resume();
  }).catch(function(e){ stage.textContent="The 3D HQ couldn't load: "+e.message; });
  hqRenderCrew();
}
function hqLeave(){ if(HQ3D.inst) HQ3D.inst.pause(); }
function hqViewChanged(v){
  if(!HQ3D) return;     // the first setView() runs before this file has set up (it calls this again at the end)
  if(v!=="hq") HQ3D.lastClassic = v;
  var b=$("hqModeBtn"), l=$("hqModeLbl");
  if(b){ b.setAttribute("aria-pressed", v==="hq" ? "true" : "false"); }
  if(l) l.textContent = v==="hq" ? "Classic" : "3D HQ";
  if(v==="hq") hqEnter(); else hqLeave();
}
// One key (H) and the header switch flip between the 3D HQ and the classic view you came from.
function hqToggle(){
  if(VIEW==="hq"){ hqModeSave("classic"); setView(HQ3D.lastClassic && HQ3D.lastClassic!=="hq" ? HQ3D.lastClassic : "live"); }
  else { hqModeSave("3d"); setView("hq"); }
}
function hqOnState(d){
  if(!HQ3D || VIEW!=="hq") return;
  if(HQ3D.inst) HQ3D.inst.update((d && d.sessions) || []);
  hqRenderCrew();
}
var HQ_STATE_TXT = {working:"Working", needs:"Needs you", idle:"Idle", stale:"Away"};
function hqCrewState(s){ var st=s&&s.status; return st==="working"||st==="needs"||st==="idle" ? st : "stale"; }
function hqProject(s){ return window.HQV && HQV.hq3d ? HQV.hq3d.projectOf(s) : String((s && (s.cwd||"").split("/").pop()) || "other").slice(0,40); }
// The crew beside the scene: everyone live, needs-you first; the same click opens their card.
function hqRenderCrew(){
  var ul=$("hqCrew"); if(!ul) return;
  var order={needs:0, working:1, idle:2, stale:3};
  var all=((STATE && STATE.sessions) || []).filter(function(s){ return hqCrewState(s)!=="stale"; });
  var list=all.filter(function(s){ return !HQ3D.filter || hqProject(s)===HQ3D.filter; })
    .sort(function(a,b){ return (order[hqCrewState(a)]-order[hqCrewState(b)]) || ((a.ageSecs||0)-(b.ageSecs||0)); });
  $("hqCrewCount").textContent = all.length ? String(all.length)+" live" : "";
  var fb=$("hqFilter");
  if(HQ3D.filter){
    fb.hidden=false; fb.textContent="";
    var t=document.createElement("span"); t.textContent="Showing "+HQ3D.filter; fb.appendChild(t);
    var x=document.createElement("button"); x.type="button"; x.className="hbtn ghost"; x.textContent="Show everyone";
    x.addEventListener("click", function(){ HQ3D.filter=null; if(HQ3D.inst) HQ3D.inst.setFilter(null); hqRenderCrew(); });
    fb.appendChild(x);
  } else fb.hidden=true;
  ul.textContent="";
  if(!list.length){ var li=document.createElement("li"); li.className="muted"; li.textContent="No live sessions right now: the desks are empty."; ul.appendChild(li); return; }
  list.forEach(function(s){
    var st=hqCrewState(s), li=document.createElement("li"), b=document.createElement("button");
    b.type="button"; b.className="hq3d-mate"; b.dataset.state=st;
    var dot=document.createElement("span"); dot.className="hq3d-dot"; dot.setAttribute("aria-hidden","true");
    var name=document.createElement("b"); name.textContent=(window.HQV && HQV.hq3d) ? HQV.hq3d.titleOf(s) : (s.title||s.name||"Session");
    var meta=document.createElement("small"); meta.textContent=HQ_STATE_TXT[st]+" · "+hqProject(s);
    b.appendChild(dot); b.appendChild(name); b.appendChild(meta);
    b.addEventListener("click", function(){ hqOpen(s.sessionId); });
    li.appendChild(b); ul.appendChild(li);
  });
}
(function(){
  var b=$("hqModeBtn"); if(b) b.addEventListener("click", hqToggle);
  // Open where you left off: the 3D HQ if you chose it (and the page can draw it), else the classic view.
  if(hqModePref()==="3d" && !hqCalm() && hqWebGL()) setView("hq"); else hqViewChanged(VIEW);
})();
