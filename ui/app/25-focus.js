/* ================= HQ 2.1: combo + focus ================= */
// Unbroken focus time builds a multiplier: ×1 at the start, +0.25 every 30 minutes, up to ×2.
// "Focus" = at least one session working; a gap of more than 10 minutes with nothing working ends
// the run. Shown as a chip in the header and in the HQ's lights (the holo-table glows brighter and
// warms to amber as the combo grows). Local only: worked out from the sessions this page sees.
var FOCUS = {start:0, last:0, mult:1};
var FOCUS_GAP = 10*60*1000, FOCUS_STEP = 30*60*1000, FOCUS_MAX = 2;
try { var _f=JSON.parse(localStorage.getItem("hq_focus")||"{}"); if(_f && _f.start) { FOCUS.start=_f.start; FOCUS.last=_f.last||_f.start; } } catch(e){}
function focusMult(ms){ return Math.min(FOCUS_MAX, 1 + 0.25*Math.floor(Math.max(0, ms)/FOCUS_STEP)); }
function focusOnState(d){
  if(typeof FOCUS==="undefined") return;
  var now=Date.now(), working=((d && d.sessions) || []).some(function(s){ return s.status==="working"; });
  if(working){
    if(!FOCUS.start || now - FOCUS.last > FOCUS_GAP) FOCUS.start=now;     // a new run
    FOCUS.last=now;
  } else if(FOCUS.start && now - FOCUS.last > FOCUS_GAP){ FOCUS.start=0; }
  var prev=FOCUS.mult;
  FOCUS.mult = FOCUS.start ? focusMult(FOCUS.last - FOCUS.start) : 1;
  try { localStorage.setItem("hq_focus", JSON.stringify({start:FOCUS.start, last:FOCUS.last})); } catch(e){}
  focusRender();
  if(FOCUS.mult > prev && FOCUS.mult > 1){ toast("🔥 Focus combo ×"+FOCUS.mult.toFixed(2).replace(/0$/,"")+"!","level"); }
  if(typeof HQ3D!=="undefined" && HQ3D && HQ3D.inst && HQ3D.inst.setCombo) HQ3D.inst.setCombo(FOCUS.mult);
}
function focusRender(){
  var c=$("focusChip"); if(!c) return;
  var on=!!FOCUS.start, mins=on ? Math.round((FOCUS.last-FOCUS.start)/60000) : 0;
  c.hidden=!on;
  if(!on) return;
  c.textContent="🔥 ×"+FOCUS.mult.toFixed(2).replace(/0$/,"")+" · "+(mins>=60 ? Math.floor(mins/60)+"h "+(mins%60)+"m" : mins+"m");
  var next = FOCUS.mult < FOCUS_MAX ? Math.ceil((FOCUS_STEP - (FOCUS.last-FOCUS.start)%FOCUS_STEP)/60000) : 0;
  c.title="Focus combo: "+mins+" minutes of unbroken work"+(next ? ". Next step in "+next+" min." : " (max).")+" A 10-minute gap with nothing working ends it.";
  c.classList.toggle("max", FOCUS.mult>=FOCUS_MAX);
}
