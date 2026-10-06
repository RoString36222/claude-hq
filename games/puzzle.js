/* Valley: Daily code puzzle. Guess the day's five-letter tech word in six tries; green =
 * right letter, right spot; amber = in the word, wrong spot. Everyone gets the same word on
 * the same (local) day. In an Arena room you can share just your guess count. */
(function(){
"use strict";
var HQV = window.HQV; if(!HQV) return;
var WORDS = ("array,async,await,build,bytes,cache,catch,chain,class,clone,close,codec,const,crash,debug,defer,delta,embed,entry,error,event,fetch,field,flags,float,flush,frame,graph,guard,hooks,index,infer,input,items,label,layer,limit,lines,linux,local,logic,loops,macro,merge,model,mutex,nodes,parse,patch,pixel,popup,ports,print,proxy,query,queue,react,regex,reset,route,rules,scope,shard,shell,slice,sleep,stack,state,store,style,swift,table,tests,token,trace,tuple,types,union,value,views,watch,while,yield,zones,agent,tools,shape,pivot,joins,count,where,order,group,alias,dates,lint,debit,sigma,epoch,bench,brand,admin,audit,batch,blobs,chmod,cloud,crate,cycle,draft,drive,fork,gzip,heaps,istio,kafka,latch,mount,nginx,owner,paged,qubit,ratio,redis,rerun,serde,spawn,split,stdin,sudo,tasks,timer,trees,unzip,utils,vault,vector,write,xpath").split(",").filter(function(w){ return /^[a-z]{5}$/.test(w); });
WORDS = WORDS.filter(function(w, i){ return WORDS.indexOf(w)===i; });
var game = {id:"puzzle", name:"Daily Code Puzzle", icon:"🧩", desc:"One five-letter tech word a day"};
var api = null, root = null, cur = "", shared = {};

function todays(){ var r = api.rng("puzzle:"+api.day()); return WORDS[Math.floor(r()*WORDS.length)]; }
function p(){ var s = api.save.puzzle; if(s.day !== api.day()){ s.day = api.day(); s.guesses = []; s.done = false; s.won = false; } return s; }
function score(guess, ans){
  var res = ["miss","miss","miss","miss","miss"], left = ans.split("");
  for(var i=0;i<5;i++) if(guess[i]===ans[i]){ res[i]="hit"; left[i]=null; }
  for(i=0;i<5;i++) if(res[i]!=="hit"){ var j = left.indexOf(guess[i]); if(j>=0){ res[i]="near"; left[j]=null; } }
  return res;
}
function submit(){
  var s = p(); if(s.done || cur.length!==5) return;
  if(!/^[a-z]{5}$/.test(cur)){ api.toast("Letters only"); return; }
  s.guesses.push(cur);
  var ans = todays();
  if(cur === ans){ s.done = true; s.won = true; s.streak = (s.lastWin === prevDay() ? (s.streak|0) : 0) + 1; s.lastWin = api.day(); s.best = Math.max(s.best|0, s.streak);
    api.inv.add("quartz", 1); api.toast("🧩 Solved in "+s.guesses.length+"! +1 Quartz", "ach"); }
  else if(s.guesses.length >= 6){ s.done = true; s.won = false; s.streak = 0; api.toast("The word was "+ans.toUpperCase()); }
  cur = ""; api.persist(); render();
}
function prevDay(){ var d = new Date(); d.setDate(d.getDate()-1); return api.day(d); }
function key(k){
  var s = p(); if(s.done) return;
  if(k==="Enter") return submit();
  if(k==="Backspace"){ cur = cur.slice(0,-1); return render(); }
  if(/^[a-zA-Z]$/.test(k) && cur.length<5){ cur += k.toLowerCase(); render(); }
}
function render(){
  if(!root) return;
  var s = p(), ans = todays(); root.textContent = "";
  root.appendChild(api.mk("p","vg-muted","Streak "+(s.streak|0)+" · best "+(s.best|0)+". Type a word and press Enter. Solving gives a Quartz."));
  var board = api.mk("div","vg-wordle"); board.tabIndex = 0; board.setAttribute("aria-label","Puzzle board. Type letters, Enter to guess.");
  for(var r=0;r<6;r++){
    var row = api.mk("div","vg-wrow"), g = s.guesses[r], marks = g ? score(g, ans) : null, live = !g && r===s.guesses.length && !s.done;
    for(var c=0;c<5;c++){
      var ch = g ? g[c] : live ? (cur[c]||"") : "";
      var t = api.mk("span","vg-tile"+(marks?" "+marks[c]:""), ch.toUpperCase());
      row.appendChild(t);
    }
    if(marks) row.setAttribute("aria-label", g.toUpperCase()+": "+marks.join(", "));
    board.appendChild(row);
  }
  board.addEventListener("keydown", function(e){ if(e.metaKey||e.ctrlKey||e.altKey) return; if(e.key.length===1||e.key==="Enter"||e.key==="Backspace"){ e.preventDefault(); key(e.key); } });
  root.appendChild(board);
  if(s.done){
    var row2 = api.mk("div","vg-row");
    row2.appendChild(api.mk("b",null, s.won ? "Solved in "+s.guesses.length+"/6" : "Missed today — it was "+ans.toUpperCase()));
    if(api.inArenaRoom()) row2.appendChild(api.btn("Share my result", "", function(){ if(api.say({g:"puzzle", day:api.day(), n:s.won ? s.guesses.length : 0})) api.toast("Shared"); }));
    root.appendChild(row2);
  }
  var names = Object.keys(shared).filter(function(n){ return shared[n].day===api.day(); });
  if(names.length){
    var lb = api.mk("div","vg-muted"); lb.textContent = "Today in this room: "+names.map(function(n){ return n+" "+(shared[n].n ? shared[n].n+"/6" : "X/6"); }).join(" · ");
    root.appendChild(lb);
  }
  setTimeout(function(){ if(root && !s.done){ var b = root.querySelector(".vg-wordle"); if(b && document.activeElement && document.activeElement.tagName!=="SELECT") b.focus(); } }, 0);
}
game.onSay = function(d, who){ if(typeof d.day==="string" && d.day.length<=10){ shared[who] = {day:d.day, n: Math.max(0, Math.min(6, d.n|0))}; if(root) render(); } };
game.badge = function(){ return api && api.save && !p().done ? "New puzzle" : ""; };
game.mount = function(el, a){ api = a; root = el; cur = ""; render(); };
game.unmount = function(){ root = null; };
HQV.register(game);
if(HQV.api) api = HQV.api;
})();
