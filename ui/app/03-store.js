/* ===== Store view: the General Store. A Stardew-inspired shop with original pixel art
   (PX_ART, svDrawRoom); the Arena pantry stays the authority for coins, stock and prices.
   Everything the shop says or shows about your creatures stays on this page. ===== */
var SV_CATS = [
  {id:"all", label:"All", icon:"bag"}, {id:"fruit", label:"Fruit", icon:"berry"},
  {id:"snack", label:"Snacks", icon:"riceball"}, {id:"meal", label:"Meals", icon:"bento"},
  {id:"drink", label:"Drinks", icon:"coffee"}, {id:"sweet", label:"Sweets", icon:"dango"},
  {id:"tonic", label:"Tonics", icon:"tonic"}
];
var SV_CAT_ORDER = ["fruit","snack","meal","drink","sweet","tonic"];
var SV_CAT_NAME = {fruit:"Fruit", snack:"Snack", meal:"Meal", drink:"Drink", sweet:"Sweet", tonic:"Tonic"};
var SV_SEASONS = ["spring","summer","fall","winter"];
var SV_SEASON_NAME = {spring:"Spring", summer:"Summer", fall:"Fall", winter:"Winter", all:"Year-round"};
var SV_SEASON_ICON = {spring:"blossom", summer:"sun", fall:"leaf", winter:"snow"};
var SV_KEEPER = "Katie", SV_PET = "Biscuit";
var SV = {built:false, s:3, W:400, L:null, env:null, room:null, roomKey:"", raf:0, anim:false, last:0, calmTimer:0,
  tab:"all", busy:{}, tipKind:null, feedKind:null, feedFrom:null, coins:null, odoRaf:0, claimAsked:false,
  talk:{text:"", shown:0, timer:0, expr:"smile"}, face:"", sceneFace:"", catUntil:0, catFrame:"", wakeUntil:0,
  blinkUntil:0, nextBlink:0, n:{}, sfx:true, friend:null, listSig:"", bagSig:"", hotSig:"", claimSig:"", headSig:"", openedAt:0};

var SV_LINES = {
  greet:{
    dawn:["You're up early! The bread's still warm.", "Morning! I just finished stocking the shelves."],
    day:["Welcome in! Take your time.", "Hi there! Anything catch your eye?", "Welcome back! Your creatures doing alright?"],
    dusk:["Evening! Just in time, I was about to light the lamps.", "Welcome back! Long day?"],
    night:["Burning the midnight oil? I'll keep the lamps on for you.", "Late shift, huh? Me too."]
  },
  season:{
    spring:["The cherry trees are blooming! Have you tried the dango?", "Strawberries are finally in. Sweetest of the year!", "Spring rain makes everything grow. Even my to-do list."],
    summer:["It's a scorcher! Shaved ice is flying off the shelves.", "Watermelon's best eaten on the porch, if you ask me.", "Summer curry: spicy enough to make you sweat, in a good way."],
    fall:["Smell that? Pumpkin stew's on the stove.", "The apples are crisp this time of year.", "Baked sweet potatoes, fresh from the coals. Careful, they're hot!"],
    winter:["Brr! Hot cocoa will warm those little paws.", "Chestnuts roasting by the door. Want a bag?", "The oden's been simmering since sunrise."]
  },
  weather:{
    rain:["Rain's good for the crops... and for naps.", "Shake off that umbrella, hon."],
    storm:["Did you hear that thunder? Biscuit hid under the counter."],
    snow:["Snow day! Stay as long as you like."],
    breeze:["Windy one today. Hold onto your hat!"],
    clear:["Lovely weather, isn't it?"], cloudy:["Gray skies, but the shop's cozy."]
  },
  chatter:["Biscuit's been napping on the counter since noon.", "Did you know berries taste sweeter after a frost?",
    "The bell sticks sometimes. Ring it twice!", "I'm thinking of painting the sign. Green, maybe?",
    "Every creature has a favorite food. Watch their faces when they eat!", "Coffee for you, rice ball for them. That's the deal.",
    "Things on the counter are today's picks. The chalkboard has the special."],
  friend:[
    [2, "I grew up on a farm past the hills. I still miss the goats."],
    [2, "Biscuit wandered in during a storm and never left. Best decision she ever made."],
    [4, "I keep a little notebook of everyone's favorite snack. Yours is safe with me."],
    [4, "Between you and me, the honey comes from my grandma's bees."],
    [7, "You're my favorite customer. Don't tell the others!"],
    [7, "When I was little I dreamed of running a shop like this. Dreams come true, huh?"]
  ],
  thanks:["Thanks, hon!", "Good choice!", "Enjoy every bite!", "That one's my favorite.", "Pleasure doing business!", "Come again soon!"],
  heartUp:["I feel like we're becoming real friends.", "You always brighten up the shop.", "Stop by anytime, even just to chat!"]
};

function svToday(){ var d=new Date(); return d.getFullYear()+"-"+("0"+(d.getMonth()+1)).slice(-2)+"-"+("0"+d.getDate()).slice(-2); }
// The next line of a list for today: a fixed per-day order, so a line doesn't repeat until the list runs out.
function svPick(arr, key){
  arr=arr||[]; if(!arr.length) return "";
  var n=SV.n[key]=((SV.n[key]|0)+1), start=hashStr("hq:sv:"+key+":"+svToday())%arr.length;
  return arr[(start+n-1)%arr.length];
}
function svPl(n, one, many){ return n+" "+(n===1?one:many); }

/* ---- catalog, as the shop sees it ---- */
function svCatalog(){ var out=[]; FOOD_ORDER.forEach(function(k){ var it=foodInfo(k); if(it) out.push(it); }); return out; }
function svOpen(){ return PANTRY.store==="ok" && !!PANTRY.j; }
function svBuyable(it){ return svOpen() && !!it && it.stocked && it.inStock; }
function svSpecialKind(){
  if(!svOpen()) return null;
  var c=svCatalog(); for(var i=0;i<c.length;i++){ if(c[i].special && c[i].stocked && c[i].inStock) return c[i].kind; }
  return null;
}
// What the shelves show: what you can buy today first, then the rest of this season's range
// (an Arena that hasn't stocked the newer foods yet still gets a full-looking shop).
function svDisplayStock(){
  var season=(SV.env && SV.env.season) || svSeasonOfMonth(new Date().getMonth());
  var c=svCatalog(), buy=c.filter(svBuyable).map(function(it){ return it.kind; });
  c.forEach(function(it){ if(buy.indexOf(it.kind)<0 && (it.season==="all" || it.season===season)) buy.push(it.kind); });
  return buy;
}
// The counter: today's special, then what's in season and buyable, then anything buyable.
function svFeatured(n){
  var c=svCatalog(), sp=svSpecialKind(), season=(SV.env && SV.env.season) || "", out=[];
  if(sp) out.push(sp);
  function add(ok){ c.forEach(function(it){ if(out.length<n && out.indexOf(it.kind)<0 && ok(it)) out.push(it.kind); }); }
  add(function(it){ return svBuyable(it) && it.season===season; });
  add(svBuyable);
  svDisplayStock().forEach(function(k){ if(out.length<n && out.indexOf(k)<0) out.push(k); });
  return out.slice(0,n);
}
function svEffect(it){
  if(it.revives) return "Wakes a fainted creature · then "+Math.round(100*(1-fzMins(it.wakeToMins)/FZ_SCALE_MINS))+"% energy";
  return "+"+fzMins(it.restoreMins)+" min energy";
}
function svRowOrder(a, b){
  function rank(it){
    var cur=(SV.env && SV.env.season) || "fall";
    if(it.stocked && it.inStock) return it.special ? 0 : 1;
    if(!it.stocked) return 9;
    return 2+((SV_SEASONS.indexOf(it.season)-SV_SEASONS.indexOf(cur)+4)%4);
  }
  var ra=rank(a), rb=rank(b); if(ra!==rb) return ra-rb;
  var ca=SV_CAT_ORDER.indexOf(a.cat), cb=SV_CAT_ORDER.indexOf(b.cat); if(ca!==cb) return ca-cb;
  return (a.basePrice-b.basePrice) || (FOOD_ORDER.indexOf(a.kind)-FOOD_ORDER.indexOf(b.kind));
}

/* ---- environment: season, time of day and today's weather ---- */
function svEnvNow(){
  var d=new Date(), j=PANTRY.j||{}, mo=d.getMonth(), day=svToday();
  var season=SV_SEASONS.indexOf(j.season)>=0 && svOpen() ? j.season : svSeasonOfMonth(mo);
  var sp=svSpecialKind(), si=sp ? foodInfo(sp) : null;
  return {season:season, tod:svTod(d.getHours()), hour:d.getHours(), min:d.getMinutes(), day:day, dayN:d.getDate()+mo*31,
          month:mo, date:d.getDate(), weather:svWeather(day, season), special:sp, specialPrice:si ? si.price : 0};
}
function svKeeperAsleep(){ var h=new Date().getHours(); return (h>=23 || h<5) && Date.now()>SV.wakeUntil; }

/* ---- sound: tiny WebAudio blips, all generated (no assets). Store-only toggle. ---- */
function svAudio(){
  try{
    if(!audioCtx){ var AC=window.AudioContext||window.webkitAudioContext; if(!AC) return null; audioCtx=new AC(); }
    if(audioCtx.state==="suspended") audioCtx.resume();
    return audioCtx;
  }catch(e){ return null; }
}
function svTone(a, type, f0, f1, t0, dur, vol){
  var o=a.createOscillator(), g=a.createGain();
  o.type=type; o.frequency.setValueAtTime(f0, t0);
  if(f1 && f1!==f0) o.frequency.exponentialRampToValueAtTime(f1, t0+dur);
  g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(vol, t0+0.008); g.gain.exponentialRampToValueAtTime(0.0001, t0+dur);
  o.connect(g); g.connect(a.destination); o.start(t0); o.stop(t0+dur+0.03);
}
function svNoise(a, t0, dur, vol, freq, q, purr){
  var n=Math.max(1, Math.floor(a.sampleRate*dur)), buf=a.createBuffer(1, n, a.sampleRate), d=buf.getChannelData(0), r=mulberry32(n+(freq|0));
  for(var i=0;i<n;i++){ var env=1-i/n; if(purr) env*=0.55+0.45*Math.sin(2*Math.PI*24*i/a.sampleRate); d[i]=(r()*2-1)*env; }
  var s=a.createBufferSource(), f=a.createBiquadFilter(), g=a.createGain();
  s.buffer=buf; f.type=purr ? "lowpass" : "bandpass"; f.frequency.value=freq; f.Q.value=q;
  g.gain.value=vol; s.connect(f); f.connect(g); g.connect(a.destination); s.start(t0);
}
function svSfx(name){
  if(!SV.sfx || document.hidden) return;
  // no audio before the first click or key on the page (browsers block it and log a warning)
  if(!audioCtx && !(navigator.userActivation && navigator.userActivation.hasBeenActive)) return;
  var a=svAudio(); if(!a) return;
  try{
    var t=a.currentTime+0.01;
    if(name==="buy"){ svTone(a,"square",1319,0,t,0.06,0.045); svTone(a,"square",1976,0,t+0.06,0.1,0.045); svNoise(a,t+0.06,0.22,0.16,6500,2.5); svTone(a,"triangle",2637,0,t+0.07,0.32,0.035); }
    else if(name==="coin"){ svTone(a,"square",1047,0,t,0.07,0.045); svTone(a,"square",1568,0,t+0.07,0.2,0.045); }
    else if(name==="blip"){ svTone(a,"square",620+((SV.talk.shown*53)%140),0,t,0.028,0.016); }
    else if(name==="bell"){ svTone(a,"sine",1760,0,t,1.0,0.11); svTone(a,"sine",2637,0,t,0.6,0.045); svTone(a,"sine",3520,0,t,0.35,0.025); }
    else if(name==="purr"){ svNoise(a,t,1.1,0.5,320,0.7,true); }
    else if(name==="bonk"){ svTone(a,"triangle",190,95,t,0.16,0.12); }
    else if(name==="tab"){ svNoise(a,t,0.035,0.07,2600,1.2); }
    else if(name==="pop"){ svTone(a,"sine",440,920,t,0.08,0.07); }
    else if(name==="munch"){ for(var i=0;i<3;i++) svNoise(a,t+i*0.12,0.07,0.22,1300,0.9); }
    else if(name==="heart"){ svTone(a,"triangle",784,0,t,0.1,0.05); svTone(a,"triangle",1175,0,t+0.1,0.1,0.05); svTone(a,"triangle",1568,0,t+0.2,0.25,0.05); }
  }catch(e){}
}
function svMuteSync(){
  var b=$("svMute"); if(!b) return;
  b.setAttribute("aria-pressed", SV.sfx ? "true" : "false");
  b.title = SV.sfx ? "Shop sounds on" : "Shop sounds off";
  b.setAttribute("aria-label", "Shop sounds");
  b.textContent = SV.sfx ? "🔊" : "🔇";
}
function svMuteToggle(){ SV.sfx=!SV.sfx; lsSet("hq_store_sfx", SV.sfx ? "1" : "0"); svMuteSync(); announce(SV.sfx ? "Shop sounds on" : "Shop sounds off"); }

/* ---- friendship with the shopkeeper: local only, a per-browser nicety ---- */
function svFriendLoad(){
  var f=null; try{ f=JSON.parse(localStorage.getItem("hq_store_friend")||"null"); }catch(e){ f=null; }
  f=(f && typeof f==="object") ? f : {};
  return {pts:Math.max(0, Math.min(120, f.pts|0)), day:typeof f.day==="string" ? f.day : "", buys:Math.max(0, f.buys|0),
          chat:f.chat===true, pet:f.pet===true, visit:f.visit===true};
}
function svHearts(){ return Math.min(10, Math.floor(((SV.friend||{}).pts|0)/12)); }
function svFriendAdd(kind){
  var f=SV.friend=SV.friend||svFriendLoad(), d=svToday();
  if(f.day!==d){ f.day=d; f.buys=0; f.chat=false; f.pet=false; f.visit=false; }
  var add=0;
  if(kind==="buy" && f.buys<3){ f.buys++; add=2; }
  else if(kind==="chat" && !f.chat){ f.chat=true; add=1; }
  else if(kind==="pet" && !f.pet){ f.pet=true; add=1; }
  else if(kind==="visit" && !f.visit){ f.visit=true; add=1; }
  if(!add) return false;
  var before=svHearts(); f.pts=Math.min(120, f.pts+add);
  try{ localStorage.setItem("hq_store_friend", JSON.stringify(f)); }catch(e){}
  svRenderHearts();
  return svHearts()>before;
}
function svRenderHearts(){
  var box=$("svHearts"); if(!box) return;
  var h=svHearts(), sig=String(h); if(box.getAttribute("data-h")===sig) return;
  box.setAttribute("data-h", sig); box.innerHTML="";
  for(var i=0;i<10;i++){ var im=el("img"); im.alt=""; im.width=18; im.height=16; im.src=pxURL(i<h ? "heart" : "heart0"); box.appendChild(im); }
  box.setAttribute("aria-label", "Friendship with "+SV_KEEPER+": "+h+" of 10 hearts");
  var fl=$("svFriendL"); if(fl) fl.textContent = h>=10 ? "Best friends!" : h>=6 ? "Good friends" : h>=3 ? "Friendly" : h>=1 ? "Acquaintance" : "New customer";
}

/* ---- the shopkeeper's dialogue: typed out with blips, instant in Calm mode ---- */
function svFace(expr){
  if(SV.face===expr) return; SV.face=expr;
  var im=$("svPortraitImg"); if(im) im.src=pxURL("keeper:"+expr);
  svSceneFace();
}
// The keeper behind the counter mirrors the portrait, except while she's dozing.
function svSceneFace(){
  var kb=$("svKeeperHot"); if(!kb) return;
  var want = svKeeperAsleep() ? "sleep" : (Date.now()<SV.blinkUntil ? "blink" : (SV.face||"smile"));
  if(SV.sceneFace===want) return; SV.sceneFace=want;
  var im=kb.querySelector("img"); if(im) im.src=pxURL("keeper:"+want);
  var z=$("svZzz"); if(z) z.classList.toggle("hidden", want!=="sleep");
}
function svMore(on){ var m=$("svDialog"); if(m) m.classList.toggle("done", !!on); }
function svSay(text, expr){
  var t=SV.talk; if(t.timer){ clearInterval(t.timer); t.timer=0; }
  t.text=String(text||""); t.shown=0; t.expr=expr||"smile";
  var sr=$("svSaySr"); if(sr) sr.textContent=SV_KEEPER+": "+t.text;
  var say=$("svSay"); if(!say) return;
  if(calmMode() || VIEW!=="store"){ say.textContent=t.text; t.shown=t.text.length; svFace(t.expr); svMore(true); return; }
  say.textContent=""; svMore(false);
  t.start=Date.now();
  t.timer=setInterval(svTalkTick, 24);
}
// Paced by the clock, not the tick count: a throttled background tab still finishes the line.
function svTalkTick(){
  var t=SV.talk, say=$("svSay");
  if(!say){ clearInterval(t.timer); t.timer=0; return; }
  var was=t.shown;
  t.shown=Math.min(t.text.length, Math.max(was+1, Math.floor((Date.now()-t.start)/24)));
  say.textContent=t.text.slice(0, t.shown);
  if(Math.floor(t.shown/2)!==Math.floor(was/2) && /[A-Za-z0-9]/.test(t.text.charAt(t.shown-1))){
    svSfx("blip");
    if(t.expr==="smile"||t.expr==="happy") svFace(Math.floor(t.shown/2)%2===0 ? "talk" : t.expr);
  }
  if(t.shown>=t.text.length){ clearInterval(t.timer); t.timer=0; svFace(t.expr); svMore(true); }
}
function svSkip(){
  var t=SV.talk; if(!t.timer) return false;
  clearInterval(t.timer); t.timer=0; t.shown=t.text.length;
  var say=$("svSay"); if(say) say.textContent=t.text;
  svFace(t.expr); svMore(true); return true;
}
// What she says when you click her: today's news first, then small talk.
function svChatter(){
  var env=SV.env||svEnvNow(), pool=[];
  var sp=svSpecialKind(), si=sp ? foodInfo(sp) : null;
  if(si) pool.push(["Today's special is "+foodA(si)+": "+svPl(si.price, "coin", "coins")+" instead of "+si.basePrice+".", "happy"]);
  var cr=svCreatureMood(); if(cr) pool.push([cr, "smile"]);
  var j=PANTRY.j;
  if(svOpen()){
    var coins=j.coins|0, cap=(j.coinCap|0)||30;
    if(j.claim && j.claim.claimable) pool.push(["Don't forget today's coins! The wallet's on the right.", "wow"]);
    else if(coins===0) pool.push(["Coins come in every day, and I hear quests pay well.", "smile"]);
    else if(coins>=cap-4) pool.push(["Your purse is bursting! Treat yourself.", "happy"]);
  }
  pool.push([svPick(SV_LINES.season[env.season], "season"), "smile"]);
  pool.push([svPick(SV_LINES.weather[env.weather], "weather"), "smile"]);
  var h=svHearts(), fr=SV_LINES.friend.filter(function(x){ return h>=x[0]; }).map(function(x){ return x[1]; });
  if(fr.length) pool.push([svPick(fr, "friend"), "happy"]);
  pool.push([svPick(SV_LINES.chatter, "chatter"), "smile"]);
  var n=SV.n.chat=((SV.n.chat|0)+1), pick=pool[(n-1)%pool.length];
  svSay(pick[0], pick[1]);
}
// One line about your team's energy, from the live payload (local only).
function svCreatureMood(){
  var ss=(STATE&&STATE.sessions)||[], ko=0, fat=0, tir=0;
  ss.forEach(function(s){ var f=fzOf(s.creature); if(!f) return; if(f.state==="unconscious") ko++; else if(f.state==="fatigued") fat++; else if(f.state==="tired") tir++; });
  if(ko) return ko===1 ? "One of your creatures fainted? A Revive Tonic will have it up in no time." : ko+" of your creatures fainted! Revive Tonics are by the register.";
  if(fat) return "Your team looks worn out. Something hearty, maybe? The hot pot never fails.";
  if(tir) return "A little snack would perk your creatures right up.";
  return ss.some(function(s){ return !!fzOf(s.creature); }) ? "Your creatures look full of beans today!" : "";
}
function svGreet(){
  var env=SV.env=svEnvNow();
  if(svKeeperAsleep()){ SV.talk.expr="sleep"; svSay("(She's dozing behind the counter. Maybe ring the bell?)", "sleep"); return; }
  var g=svPick(SV_LINES.greet[env.tod], "greet"), name=trainerPref();
  if(name && hashStr(svToday()+name)%2===0) g=g.replace(/^(\w+)([!,.])/, "$1, "+name+"$2");
  var sp=svSpecialKind(), si=sp ? foodInfo(sp) : null;
  var more = si ? " Today's special is "+foodA(si)+"!" : (svCreatureMood() || "");
  svSay(g+(more ? " "+more : ""), "happy");
}
function svWake(){
  if(!svKeeperAsleep()) return false;
  SV.wakeUntil=Date.now()+15*60000; SV.sceneFace="";
  svSay("Oh! Sorry, I must've dozed off. What can I get you?", "wow");
  return true;
}
function svKeeperPoke(){
  if(svWake()) return;
  if(svSkip()) return;
  if(svFriendAdd("chat")){ svSfx("heart"); svSay(svPick(SV_LINES.heartUp, "heartUp"), "happy"); return; }
  svChatter();
}
function svRingBell(){
  svSfx("bell");
  var b=document.querySelector(".sv-hot-bell");
  if(b && !calmMode()){ b.classList.remove("ring"); void b.offsetWidth; b.classList.add("ring"); }
  if(svWake()) return;
  svSay(svPick(["Coming, coming!", "Yes? Oh, you just like the bell. Me too.", "Ding ding! What'll it be?"], "bell"), "happy");
}
function svPetCat(){
  svSfx("purr"); SV.catUntil=Date.now()+3500;
  svHeartsFloat();
  var up=svFriendAdd("pet");
  if(up){ svSfx("heart"); svSay("Aww, "+SV_PET+" really likes you. "+svPick(SV_LINES.heartUp, "heartUp"), "happy"); }
  else svSay(svPick([SV_PET+" purrs and kneads the counter.", "She likes you! "+SV_PET+" doesn't let just anyone do that.", SV_PET+" blinks at you slowly. That's cat for “I love you.”"], "cat"), "happy");
}
function svHeartsFloat(){
  if(calmMode() || !SV.L) return;
  var hots=$("svHots"); if(!hots) return;
  for(var i=0;i<3;i++){
    var im=el("img","sv-float"); im.alt=""; im.setAttribute("aria-hidden","true"); im.src=pxURL("heart");
    im.style.left=((SV.L.cat.x+2+i*5)*SV.s)+"px"; im.style.top=((SV.L.cat.y-6)*SV.s)+"px";
    im.style.width=(9*SV.s/1.5)+"px"; im.style.animationDelay=(i*0.18)+"s";
    hots.appendChild(im);
    (function(n){ setTimeout(function(){ if(n.parentNode) n.parentNode.removeChild(n); }, 1600); })(im);
  }
}

/* ---- the scene ---- */
function svResize(force){
  var wrap=$("svWrap"), stage=$("svStage"), cv=$("svCanvas"); if(!wrap || !stage || !cv) return;
  var cw=wrap.clientWidth|0; if(cw<=0) return;
  var s=cw>=980 ? 3 : 2, W=Math.max(160, Math.ceil(cw/s));
  if(!force && s===SV.s && W===SV.W && SV.L) return;
  SV.s=s; SV.W=W; SV.L=svLayout(W); SV.roomKey=""; SV.hotSig="";
  cv.width=SV.L.W; cv.height=SV.L.H;
  stage.style.width=(SV.L.W*s)+"px"; stage.style.height=(SV.L.H*s)+"px";
  svHots(); svDraw(0);
}
function svDraw(t){
  var cv=$("svCanvas"); if(!cv || !SV.L) return;
  var c=cv.getContext("2d"); if(!c) return;
  var env=SV.env=svEnvNow();
  var key=[SV.L.W, env.season, env.tod, env.weather, env.day, env.hour, env.min, env.special||"", env.specialPrice].join("|");
  if(key!==SV.roomKey || !SV.room){
    SV.roomKey=key;
    if(!SV.room) SV.room=document.createElement("canvas");
    SV.room.width=SV.L.W; SV.room.height=SV.L.H;
    var rc=SV.room.getContext("2d"); if(!rc) return;
    rc.clearRect(0,0,SV.L.W,SV.L.H); svDrawRoom(rc, SV.L, env);
    var st=$("svStage"); if(st) st.classList.toggle("sv-night", env.tod==="night");
  }
  c.clearRect(0,0,cv.width,cv.height); c.drawImage(SV.room,0,0);
  svDrawLive(c, SV.L, env, calmMode() ? 0 : t);
  svHotTick(t);
}
// Blinks, the cat's tail, the dozing keeper. Cheap: an <img> src changes only when its frame does.
function svHotTick(t){
  var now=Date.now(), calm=calmMode();
  if(!calm && !SV.talk.timer && now>SV.nextBlink){ SV.blinkUntil=now+140; SV.nextBlink=now+3200+(hashStr("b"+now)%2600); }
  svSceneFace();
  var cb=$("svCatHot"); if(!cb) return;
  var fr = now<SV.catUntil ? "cat2" : (!calm && Math.floor(t/1700)%3===0 && (t%1700)<380 ? "cat1" : "cat0");
  if(fr!==SV.catFrame){ SV.catFrame=fr; var im=cb.querySelector("img"); if(im) im.src=pxURL(fr); }
}
function svAnimStop(){
  SV.anim=false; if(SV.raf) cancelAnimationFrame(SV.raf); SV.raf=0;
  if(SV.calmTimer){ clearInterval(SV.calmTimer); SV.calmTimer=0; }
}
function svAnimStart(){
  svAnimStop();
  if(VIEW!=="store" || document.hidden) return;
  svDraw(0);
  if(calmMode()){ SV.calmTimer=setInterval(function(){ if(VIEW==="store" && !document.hidden) svDraw(0); }, 20000); return; }
  SV.anim=true;
  var loop=function(ts){
    if(!SV.anim) return;
    if(calmMode()){ svAnimStart(); return; }
    if(ts-SV.last>=80){ SV.last=ts; svDraw(ts); }
    SV.raf=requestAnimationFrame(loop);
  };
  SV.raf=requestAnimationFrame(loop);
}
// The buttons laid over the canvas: the keeper, the bell, the cat, plus the counter and shelf
// items (a mouse shortcut to the same rows the list has, so those stay out of the tab order).
function svHots(){
  var L=SV.L, hots=$("svHots"); if(!L || !hots) return;
  var feat=svFeatured(L.feature.length), shelf=svDisplayStock().slice(0, L.slots.length), spots=svShelfSpots(L, shelf.length);
  var sig=[SV.W, SV.s, feat.join(","), shelf.join(",")].join("|");
  if(sig===SV.hotSig && hots.firstChild) return;
  SV.hotSig=sig;
  var fa=document.activeElement, keepId=(fa && hots.contains(fa)) ? fa.id : "";
  hots.innerHTML=""; SV.sceneFace=""; SV.catFrame="";
  var s=SV.s;
  function place(n, r){ n.style.left=(r.x*s)+"px"; n.style.top=(r.y*s)+"px"; n.style.width=(r.w*s)+"px"; n.style.height=(r.h*s)+"px"; }
  function img(key, r){ var im=el("img"); im.alt=""; im.src=pxURL(key); im.width=r.w*s; im.height=r.h*s; im.draggable=false; return im; }
  function btn(id, cls, r, key, label, fn){
    var b=el("button","sv-hot "+cls); b.type="button"; b.id=id; place(b, r);
    b.setAttribute("aria-label", label); b.appendChild(img(key, r)); b.addEventListener("click", fn);
    hots.appendChild(b); return b;
  }
  function item(k, r, where){
    var it=foodInfo(k); if(!it) return;
    var sp=el("span","sv-hot sv-hot-item"); sp.setAttribute("aria-hidden","true"); sp.setAttribute("data-kind", k); place(sp, r);
    sp.title=it.name+" ("+where+")"; sp.appendChild(img(k, r));
    sp.addEventListener("click", function(){ svShowItem(k); });
    sp.addEventListener("mousemove", function(e){ svTipShow(k, sp, e); });
    sp.addEventListener("mouseleave", svTipHide);
    hots.appendChild(sp);
  }
  shelf.forEach(function(k,i){ item(k, spots[i], "on the shelf"); });
  btn("svKeeperHot", "sv-hot-keeper", L.keeper, "keeper:smile", "Talk to "+SV_KEEPER+", the shopkeeper", function(){ svKeeperPoke(); });
  var z=el("img","sv-zzz hidden"); z.id="svZzz"; z.alt=""; z.setAttribute("aria-hidden","true"); z.src=pxURL("zzz");
  z.style.left=((L.keeper.x+26)*s)+"px"; z.style.top=((L.keeper.y-4)*s)+"px"; z.style.width=(4*s)+"px"; z.style.height=(4*s)+"px";
  hots.appendChild(z);
  btn("svBellHot", "sv-hot-bell", L.bell, "bell", "Ring the counter bell", svRingBell);
  feat.forEach(function(k,i){ item(k, L.feature[i], i===0 && k===svSpecialKind() ? "today’s special" : "on the counter"); });
  btn("svCatHot", "sv-hot-cat", L.cat, "cat0", "Pet "+SV_PET+", the shop cat", svPetCat);
  if(keepId && $(keepId)) $(keepId).focus();
}
// n shelf items split evenly over the shelves (top gets the odd one), centred on each.
function svShelfSpots(L, n){
  var rows=L.shelves.map(function(sh){ return L.slots.filter(function(sl){ return sl.y===sh.y-16; }); });
  var out=[], left=n;
  rows.forEach(function(r, i){
    var take=Math.min(r.length, i===rows.length-1 ? left : Math.ceil(left/(rows.length-i)));
    var from=Math.floor((r.length-take)/2);
    for(var j=0;j<take;j++) out.push(r[from+j]);
    left-=take;
  });
  return out;
}
// From the scene (or the special badge) to the item's row in the list.
function svShowItem(k){
  var it=foodInfo(k); if(!it) return;
  if(SV.tab!=="all" && SV.tab!==it.cat) svSetTab("all", false);
  svRenderList();
  var row=document.querySelector('#svList .sv-row[data-kind="'+k+'"]');
  if(row){
    Array.prototype.forEach.call(document.querySelectorAll("#svList .sv-row"), function(r){ r.tabIndex=(r===row)?0:-1; });
    try{ row.scrollIntoView({block:"nearest", behavior:calmMode()?"auto":"smooth"}); }catch(e){}
    focusQuiet(row); row.classList.remove("flash"); void row.offsetWidth; row.classList.add("flash");
  }
  var line = it.desc+" "+(svBuyable(it) ? (it.special ? "Today it's just "+svPl(it.price,"coin","coins")+"!" : svPl(it.price,"coin","coins")+".")
            : (it.stocked && !it.inStock ? "Back in "+SV_SEASON_NAME[it.season]+"." : ""));
  svSay(it.name+"! "+line, "smile");
}

/* ---- the menu ---- */
function svBuild(){
  if(SV.built) return;
  SV.built=true;
  SV.sfx=lsGet("hq_store_sfx")!=="0";
  SV.friend=svFriendLoad();
  var tabs=$("svTabs");
  SV_CATS.forEach(function(c){
    var b=el("button","sv-tab"); b.type="button"; b.id="svTab-"+c.id;
    b.setAttribute("role","tab"); b.setAttribute("aria-controls","svList"); b.setAttribute("data-cat", c.id);
    var im=el("img"); im.alt=""; im.width=16; im.height=16; im.src=pxURL(c.icon); b.appendChild(im);
    var sp=el("span"); sp.textContent=c.label; b.appendChild(sp);
    b.addEventListener("click", function(){ svSetTab(c.id, true); });
    tabs.appendChild(b);
  });
  tabs.addEventListener("keydown", function(e){
    var all=[].slice.call(tabs.querySelectorAll(".sv-tab")), i=all.indexOf(document.activeElement); if(i<0) return;
    var n = e.key==="ArrowRight" ? (i+1)%all.length : e.key==="ArrowLeft" ? (i-1+all.length)%all.length : e.key==="Home" ? 0 : e.key==="End" ? all.length-1 : -1;
    if(n<0) return; e.preventDefault(); svSetTab(all[n].getAttribute("data-cat"), true); all[n].focus();
  });
  var list=$("svList");
  list.addEventListener("keydown", svListKey);
  list.addEventListener("mouseleave", svTipHide);
  list.addEventListener("scroll", svTipHide, {passive:true});
  $("svDialog").addEventListener("click", function(){ if(!svSkip()) svKeeperPoke(); });
  $("svPortrait").addEventListener("click", function(){ svKeeperPoke(); });
  $("svMute").addEventListener("click", svMuteToggle);
  $("svSpecial").addEventListener("click", function(){ var k=svSpecialKind(); if(k) svShowItem(k); });
  $("svBag").addEventListener("keydown", svBagKey);
  $("svFeed").addEventListener("keydown", function(e){ if(e.key==="Escape"){ e.preventDefault(); e.stopPropagation(); svFeedClose(true); } });
  document.addEventListener("mousedown", function(e){
    var f=$("svFeed"); if(!SV.feedKind || !f) return;
    if(!f.contains(e.target) && !(SV.feedFrom && SV.feedFrom.contains(e.target))) svFeedClose(false);
  }, true);
  if(window.ResizeObserver){ SV.ro=new ResizeObserver(function(){ if(VIEW==="store") svResize(false); }); SV.ro.observe($("svWrap")); }
  else window.addEventListener("resize", function(){ if(VIEW==="store") svResize(false); });
  document.addEventListener("visibilitychange", function(){ if(VIEW!=="store") return; if(document.hidden) svAnimStop(); else svAnimStart(); });
  var saved=lsGet("hq_store_tab");
  svSetTab(SV_CATS.some(function(c){ return c.id===saved; }) ? saved : "all", false);
  svMuteSync(); svRenderHearts();
  var im=$("svPortraitImg"); if(im) im.src=pxURL("keeper:smile");
  var ci=$("svCoinImg"); if(ci) ci.src=pxURL("coin");
  var bi=$("svBagImg"); if(bi) bi.src=pxURL("bag");
}
function svSetTab(id, user){
  SV.tab=id; lsSet("hq_store_tab", id);
  Array.prototype.forEach.call(document.querySelectorAll("#svTabs .sv-tab"), function(b){
    var on=b.getAttribute("data-cat")===id;
    b.setAttribute("aria-selected", on ? "true" : "false"); b.tabIndex=on ? 0 : -1;
  });
  var l=$("svList"); if(l) l.setAttribute("aria-labelledby", "svTab-"+id);
  SV.listSig=""; svRenderList();
  if(user) svSfx("tab");
}
// Called by everything that changes coins or snacks (pantryChanged). Cheap off the Store view.
function renderStore(){ if(SV.built && VIEW==="store") svRender(); }
function svTick(){ if(SV.built && VIEW==="store"){ svRenderWallet(); svRenderHead(); } }
function svRender(){
  SV.env=svEnvNow();
  svRenderHead(); svRenderList(); svRenderClosed(); svRenderWallet(); svRenderBag(); svRenderHearts();
  svHots();
  svDraw(SV.last||0);   // the chalkboard and stock follow the pantry without waiting for a frame
  if(SV.feedKind) svFeedRender();
}
function svRenderHead(){
  var env=SV.env||svEnvNow(), sp=svSpecialKind(), si=sp ? foodInfo(sp) : null;
  var sig=[env.season, env.weather, env.date, sp||"", si ? si.price+"/"+si.basePrice : ""].join("|");
  if(sig===SV.headSig) return; SV.headSig=sig;
  var se=$("svSeason");
  if(se){
    se.innerHTML="";
    var im=el("img"); im.alt=""; im.width=20; im.height=20; im.src=pxURL(SV_SEASON_ICON[env.season]||"leaf"); se.appendChild(im);
    var tx=el("span"); tx.textContent=SV_SEASON_NAME[env.season]+" stock · "+SV_MONTHS[env.month].charAt(0)+SV_MONTHS[env.month].slice(1).toLowerCase()+" "+env.date; se.appendChild(tx);
  }
  var b=$("svSpecial");
  if(b){
    b.classList.toggle("hidden", !si); b.innerHTML="";
    if(si){
      var lab=el("span","sv-special-l"); lab.textContent="Today’s special"; b.appendChild(lab);
      var ii=el("img"); ii.alt=""; ii.width=20; ii.height=20; ii.src=pxURL(si.kind); b.appendChild(ii);
      var nm=el("b"); nm.textContent=si.name; b.appendChild(nm);
      var was=el("s"); was.textContent=String(si.basePrice); b.appendChild(was);
      var ci=el("img"); ci.alt=""; ci.width=16; ci.height=16; ci.src=pxURL("coin"); b.appendChild(ci);
      var pr=el("b"); pr.textContent=String(si.price); b.appendChild(pr);
      b.setAttribute("aria-label", "Today’s special: "+si.name+", "+coinsN(si.price)+" instead of "+si.basePrice+". Show it in the list");
    }
  }
}
// Not open for business: a sign and one action, above a menu you can still browse.
function svRenderClosed(){
  var box=$("svClosed"); if(!box) return;
  var st=PANTRY.store, open=svOpen(), sig=st+"|"+(PANTRY.retrying?1:0)+"|"+(PANTRY.loading?1:0);
  if(box.getAttribute("data-sig")===sig) return;
  var ae=document.activeElement, had=!!ae && box.contains(ae);
  box.setAttribute("data-sig", sig);
  box.classList.toggle("hidden", open); box.innerHTML="";
  if(open){ if(had) focusQuiet(document.querySelector('#svList .sv-row[tabindex="0"]') || $("svDialog")); return; }
  var sign=el("span","sv-sign"); sign.setAttribute("aria-hidden","true");
  sign.textContent = (st==="unknown" || (PANTRY.loading && !PANTRY.j)) ? "OPENING" : "CLOSED"; box.appendChild(sign);
  var msg=el("span","sv-closed-t"), act=null;
  if(st==="unpaired"){ msg.textContent="Connect the Arena to start earning Poke Coins: 5 a day, plus quest rewards."; act=["Connect Arena", function(){ openArenaSection("arenaSetup", true); }]; }
  else if(st==="unsupported") msg.textContent="This Arena server doesn’t have the store yet. Ask whoever hosts it to update it. Your creatures still recover by resting.";
  else if(st==="restart") msg.textContent="Restart Claude HQ, then reload this page, to finish updating it.";
  else if(st==="reload"){ msg.textContent=PANTRY_RELOAD_MSG+" Nothing unfinished is lost."; act=["Reload page", pageReload]; }
  else if(st==="error"){ msg.textContent="Can’t reach the Arena server right now."; act=[PANTRY.retrying ? "Retrying…" : "Retry", pantryRetry]; }
  else msg.textContent="Opening up…";
  box.appendChild(msg);
  if(act){
    var b=el("button","sv-btn"); b.type="button"; b.textContent=act[0];
    if(PANTRY.retrying && act[1]===pantryRetry) b.setAttribute("aria-disabled","true");
    b.addEventListener("click", act[1]); box.appendChild(b);
    if(had) b.focus();
  }
}
function svRenderList(){
  var list=$("svList"); if(!list) return;
  var open=svOpen(), j=PANTRY.j||{}, items=j.items||{}, coins=j.coins|0, cap=(j.itemCap|0)||10;
  var rows=svCatalog().filter(function(it){ return SV.tab==="all" || it.cat===SV.tab; }).sort(svRowOrder);
  var sig=[open?1:0, coins, cap, SV.tab, rows.map(function(it){
    return [it.kind, it.name, it.price, it.basePrice, it.stocked?1:0, it.inStock?1:0, it.special?1:0, it.season,
            items[it.kind]|0, SV.busy[it.kind]?1:0, storeRetryRid(it.kind)?1:0].join(",");
  }).join(";")].join("|");
  if(sig===SV.listSig && list.firstChild) return;
  SV.listSig=sig;
  var fa=document.activeElement, fk=(fa && list.contains(fa)) ? fa.getAttribute("data-kind") : null;
  var cur=list.querySelector('.sv-row[tabindex="0"]'), ck=cur ? cur.getAttribute("data-kind") : null;
  list.innerHTML="";
  var any=null;
  rows.forEach(function(it){
    var own=items[it.kind]|0, busy=!!SV.busy[it.kind], lost=!!storeRetryRid(it.kind), avail=svBuyable(it);
    var b=el("button","sv-row"); b.type="button"; b.setAttribute("data-kind", it.kind);
    if(!avail) b.classList.add("off");
    if(avail && it.special) b.classList.add("special");
    var ic=el("img","sv-ico"); ic.alt=""; ic.width=32; ic.height=32; ic.src=pxURL(it.kind); b.appendChild(ic);
    var mid=el("span","sv-mid"), nm=el("span","sv-nm"); nm.textContent=it.name; mid.appendChild(nm);
    var ef=el("span","sv-ef"), bo=el("img"); bo.alt=""; bo.width=8; bo.height=9; bo.src=pxURL("bolt"); ef.appendChild(bo);
    var et=el("span"); et.textContent=it.revives ? "Revives · "+Math.round(100*(1-fzMins(it.wakeToMins)/FZ_SCALE_MINS))+"%" : "+"+fzMins(it.restoreMins)+" min"; ef.appendChild(et);
    mid.appendChild(ef); b.appendChild(mid);
    var tags=el("span","sv-tags");
    function tag(cls, text){ var t=el("span","sv-tag"+(cls?" "+cls:"")); t.textContent=text; tags.appendChild(t); }
    if(avail && it.special) tag("spec","Special");
    if(open && !it.stocked) tag("","Sold out");
    else if(it.stocked && !it.inStock) tag("season", SV_SEASON_NAME[it.season]);
    if(own>0) tag("own", "×"+own+" in bag");
    if(lost) tag("warn","Unconfirmed");
    b.appendChild(tags);
    var pr=el("span","sv-pr");
    if(busy) pr.insertAdjacentHTML("beforeend", orb("xs"));
    if(it.special && avail && it.basePrice!==it.price){ var s=el("s"); s.textContent=String(it.basePrice); pr.appendChild(s); }
    var co=el("img"); co.alt=""; co.width=20; co.height=20; co.src=pxURL("coin"); pr.appendChild(co);
    var pn=el("span"); pn.textContent=String(it.price); pr.appendChild(pn);
    b.appendChild(pr);
    var why = !open ? "the store is closed" : !it.stocked ? "sold out at this Arena" : !it.inStock ? "in season in "+SV_SEASON_NAME[it.season]
            : own>=cap ? "your bag is full of them" : coins<it.price ? "need "+svPl(it.price-coins,"more coin","more coins") : "";
    var label = it.name+", "+coinsN(it.price)+(it.special&&avail ? " (today’s special, usually "+it.basePrice+")" : "")+". "+svEffect(it)+". "+
                (SV_CAT_NAME[it.cat]||"Food")+(own>0 ? ". In your bag: "+own : "")+". "+
                (busy ? "Buying…" : lost ? "Last purchase unconfirmed: press to retry, it won’t be bought twice." : why ? "Can’t buy: "+why+"." : "Press to buy one, Shift+Enter for up to five.");
    b.setAttribute("aria-label", label);
    if(why && !lost) b.setAttribute("aria-disabled","true");
    if(busy) b.setAttribute("aria-busy","true");
    b.tabIndex=-1;
    b.addEventListener("click", function(e){ svBuy(it.kind, !!e.shiftKey); });
    b.addEventListener("mousemove", function(e){ svTipShow(it.kind, b, e); });
    b.addEventListener("focus", function(){ svTipShow(it.kind, b, null); });
    b.addEventListener("blur", svTipHide);
    list.appendChild(b);
    if(!any) any=b;
  });
  var keep=(fk && list.querySelector('.sv-row[data-kind="'+fk+'"]')) || (ck && list.querySelector('.sv-row[data-kind="'+ck+'"]')) || any;
  if(keep) keep.tabIndex=0;
  if(fk && keep) focusQuiet(keep);
}
function svListKey(e){
  var rows=[].slice.call($("svList").querySelectorAll(".sv-row")), i=rows.indexOf(document.activeElement); if(i<0) return;
  if(e.key==="Enter" && e.shiftKey){ e.preventDefault(); svBuy(rows[i].getAttribute("data-kind"), true); return; }
  var n = e.key==="ArrowDown" ? Math.min(rows.length-1, i+1) : e.key==="ArrowUp" ? Math.max(0, i-1) : e.key==="Home" ? 0 : e.key==="End" ? rows.length-1 : -1;
  if(n<0) return;
  e.preventDefault(); rows[i].tabIndex=-1; rows[n].tabIndex=0; rows[n].focus();
}

/* ---- tooltip (decorative: every row's label already says all of it) ---- */
function svTipShow(kind, anchor, ev){
  var tip=$("svTip"), it=foodInfo(kind); if(!tip || !it) return;
  var j=PANTRY.j||{}, own=(j.items||{})[kind]|0;
  var sig=kind+"|"+own+"|"+it.price+"|"+(it.inStock?1:0)+"|"+(it.stocked?1:0);
  if(tip.getAttribute("data-sig")!==sig){
    tip.setAttribute("data-sig", sig);
    var season = it.season==="all" ? "Sold year-round" : (it.stocked && !it.inStock ? "Back in "+SV_SEASON_NAME[it.season] : SV_SEASON_NAME[it.season]+" only");
    tip.innerHTML='<div class="sv-tip-nm">'+esc(it.name)+'</div>'+
      '<div class="sv-tip-cat sv-c-'+esc(it.cat)+'">'+esc(SV_CAT_NAME[it.cat]||"Food")+'</div><hr>'+
      '<p class="sv-tip-d">'+esc(it.desc)+'</p>'+
      '<div class="sv-tip-ef"><img alt="" width="12" height="14" src="'+pxURL("bolt")+'"><span>'+esc(svEffect(it))+'</span></div>'+
      '<div class="sv-tip-m">'+esc(season)+(own>0 ? ' · '+own+' in your bag' : '')+'</div>';
  }
  tip.classList.remove("hidden");
  var tw=tip.offsetWidth, th=tip.offsetHeight, vw=window.innerWidth, vh=window.innerHeight, x, y;
  if(ev){ x=ev.clientX+18; y=ev.clientY+14; if(x+tw>vw-8) x=ev.clientX-tw-14; }
  else { var r=anchor.getBoundingClientRect(); x=r.right+10; y=r.top; if(x+tw>vw-8) x=Math.max(8, r.left-tw-10); }
  if(y+th>vh-8) y=Math.max(8, vh-th-8);
  tip.style.left=Math.max(8, x)+"px"; tip.style.top=Math.max(8, y)+"px";
  SV.tipKind=kind;
}
function svTipHide(){ var tip=$("svTip"); if(tip) tip.classList.add("hidden"); SV.tipKind=null; }

/* ---- buying ---- */
function svRefuse(kind, line, mood){
  svSfx("bonk"); svSay(line, mood||"sad"); announce(line);
  var row=document.querySelector('#svList .sv-row[data-kind="'+kind+'"]');
  if(row && !calmMode()){ row.classList.remove("shake"); void row.offsetWidth; row.classList.add("shake"); }
}
function svBuy(kind, many){
  var it=foodInfo(kind), j=PANTRY.j; if(!it) return;
  if(SV.busy[kind]) return;
  svTipHide();
  if(!svOpen()){ svRefuse(kind, PANTRY.store==="unpaired" ? "We're not open for business until you connect the Arena, hon." : "The register's offline right now. Try again in a bit?"); return; }
  var coins=j.coins|0, own=(j.items||{})[kind]|0, cap=(j.itemCap|0)||10, max=((j.limits||{}).buyMaxQty|0)||5;
  var lost=storeRetryGet(kind), qty=1;
  if(!lost){
    if(!it.stocked) return svRefuse(kind, "Haven't got "+it.plural.toLowerCase()+" in yet. The supplier's running late.", "sad");
    if(!it.inStock) return svRefuse(kind, it.plural+" won't be ready until "+SV_SEASON_NAME[it.season]+". Patience!", "wow");
    if(own>=cap) return svRefuse(kind, "Your bag can't fit any more "+it.plural.toLowerCase()+"!", "wow");
    if(coins<it.price){ var need=it.price-coins; return svRefuse(kind, "Hmm, you're "+svPl(need,"coin","coins")+" short, sweetie.", "sad"); }
    if(many) qty=Math.max(1, Math.min(max, cap-own, it.price>0 ? Math.floor(coins/it.price) : max));
  }
  svWake();
  SV.busy[kind]=1; svRenderList();
  pantryBuy(kind, lost ? lost.rid : null, qty, true).then(function(r){
    delete SV.busy[kind];
    if(r.ok){
      var n=r.qty||qty, left=coinsN(PANTRY.j ? PANTRY.j.coins|0 : 0)+" left.";
      svSfx("buy"); svFly(kind);
      var up=svFriendAdd("buy");
      if(r.replayed){ svSay("Looks like your earlier "+it.name+" went through after all. No extra charge!", "happy"); announce("Your earlier "+it.name+" purchase had gone through. "+left); }
      else {
        var line = up ? svPick(SV_LINES.heartUp, "heartUp") : it.special ? "Ooh, today's special! Smart shopper." : it.revives ? "Keep that handy. You never know." : svPick(SV_LINES.thanks, "thanks");
        if(up) svSfx("heart");
        svSay(line, "happy");
        announce("Bought "+(n>1 ? foodN(it, n) : foodA(it))+". "+left);
      }
    } else if(r.lost){ svSay("Hmm, the register hiccuped. Try again, I won't charge you twice.", "wow"); svSfx("bonk"); announce("Couldn’t confirm the "+it.name+". Retry is safe: it won’t be bought twice."); }
    else if(r.stale){ svSay("The shop needs a fresh start! Reload the page, hon.", "sad"); announce(PANTRY_RELOAD_MSG); }
    else if(r.msg){ svRefuse(kind, r.msg.charAt(0).toUpperCase()+r.msg.slice(1)+".", "sad"); }
    svRender();
  });
}
// The bought snack hops from its row into the bag.
function svFly(kind){
  svRenderBag();
  var to=document.querySelector('#svBag .sv-slot[data-kind="'+kind+'"]');
  var pop=function(){ if(!to) return; to.classList.remove("pop"); void to.offsetWidth; to.classList.add("pop"); svSfx("pop"); };
  if(calmMode()){ return; }
  var from=document.querySelector('#svList .sv-row[data-kind="'+kind+'"] .sv-ico');
  if(!from || !to || !document.body.animate){ setTimeout(pop, 120); return; }
  var a=from.getBoundingClientRect(), b=to.getBoundingClientRect();
  var im=el("img","sv-fly"); im.alt=""; im.setAttribute("aria-hidden","true"); im.src=pxURL(kind);
  im.style.left=a.left+"px"; im.style.top=a.top+"px"; im.style.width=a.width+"px"; im.style.height=a.height+"px";
  document.body.appendChild(im);
  var dx=(b.left+b.width/2)-(a.left+a.width/2), dy=(b.top+b.height/2)-(a.top+a.height/2);
  var an=im.animate([{transform:"translate(0,0) scale(1)"},
    {transform:"translate("+(dx*0.5)+"px,"+(dy*0.5-70)+"px) scale(1.35)", offset:0.5},
    {transform:"translate("+dx+"px,"+dy+"px) scale(.9)"}], {duration:560, easing:"ease-in-out"});
  an.onfinish=function(){ if(im.parentNode) im.parentNode.removeChild(im); pop(); };
}

/* ---- wallet: the coin counter rolls like a money box ---- */
function svOdoDraw(from, to, p){
  var cv=$("svOdo"); if(!cv) return;
  var c=cv.getContext("2d"); if(!c) return;
  var D=3, cw=9, ch=13; cv.width=D*cw+1; cv.height=ch+2;
  c.fillStyle="#2e1608"; c.fillRect(0,0,cv.width,cv.height);
  function pad(n){ return n==null ? "  -" : ("   "+Math.max(0, n|0)).slice(-D); }
  var fs=pad(from), ts=pad(to), up=(to|0)>=(from|0);
  for(var i=0;i<D;i++){
    var x=1+i*cw;
    c.fillStyle="#5b3317"; c.fillRect(x,1,cw-1,ch); c.fillStyle="#6b3f22"; c.fillRect(x,1,cw-1,2);
    c.save(); c.beginPath(); c.rect(x,1,cw-1,ch); c.clip();
    var a=fs.charAt(i), b=ts.charAt(i);
    if(a===b || p>=1) pxText(c, b, x+2, 4, "#ffe08a", "#2a1408");
    else {
      var off=Math.round(p*ch)*(up ? -1 : 1);
      pxText(c, a, x+2, 4+off, "#ffe08a", "#2a1408");
      pxText(c, b, x+2, 4+off+(up ? ch : -ch), "#ffe08a", "#2a1408");
    }
    c.restore();
  }
}
function svOdoTo(n){
  var from=SV.coins, tok=SV.odoTok=(SV.odoTok|0)+1; SV.coins=n;
  if(SV.odoRaf){ cancelAnimationFrame(SV.odoRaf); SV.odoRaf=0; }
  if(from==null || n==null || from===n || calmMode() || document.hidden){ svOdoDraw(n, n, 1); return; }
  var t0=Date.now();
  var step=function(){
    if(tok!==SV.odoTok) return;
    var p=Math.min(1, (Date.now()-t0)/380); svOdoDraw(from, n, p);
    SV.odoRaf = p<1 ? requestAnimationFrame(step) : 0;
  };
  SV.odoRaf=requestAnimationFrame(step);
  // frames can be paused (a hidden or covered window): the final number still lands
  setTimeout(function(){ if(tok!==SV.odoTok) return; if(SV.odoRaf){ cancelAnimationFrame(SV.odoRaf); SV.odoRaf=0; } svOdoDraw(n, n, 1); }, 600);
}
function svRenderWallet(){
  var j=PANTRY.j, open=svOpen(), coins=open ? j.coins|0 : null, cap=open ? ((j.coinCap|0)||30) : 30;
  var prev=SV.coins;
  if(coins!==SV.coins || !SV.odoInit){ SV.odoInit=true; svOdoTo(coins); }
  if(open && prev!=null && coins>prev){
    svSfx("coin");
    if(SV.claimAsked){ SV.claimAsked=false; svSay("There's today's allowance. Spend it wisely! Or don't, I won't tell.", "happy"); }
  }
  $("svCap").textContent = open ? "/ "+cap : "";
  $("svCoinsSr").textContent = open ? "Wallet: "+coinsN(coins)+" (holds "+cap+")" : "Wallet unavailable";
  var cl=$("svClaim"); if(!cl) return;
  var c=open ? (j.claim||{}) : {}, next=Date.parse(c.nextClaimAt), amt=(c.amount|0)||5, when="";
  if(open && !c.claimable && c.claimedToday && !isNaN(next)) when="Next coins in "+fmtMins(Math.max(1, Math.ceil((next-Date.now())/60000)));
  var sig=[open?1:0, c.claimable?1:0, PANTRY.claiming?1:0, c.claimedToday?1:0, amt, when, open && coins>=cap ? 1 : 0].join("|");
  if(sig===SV.claimSig) return; SV.claimSig=sig;
  var had=!!document.activeElement && cl.contains(document.activeElement);
  cl.innerHTML="";
  if(!open){ var u=el("span"); u.textContent=PANTRY.store==="unpaired" ? "Connect the Arena to get 5 coins a day." : "—"; cl.appendChild(u); return; }
  if(c.claimable){
    var b=el("button","sv-btn"); b.type="button"; b.id="svClaimBtn";
    var ci=el("img"); ci.alt=""; ci.width=18; ci.height=18; ci.src=pxURL("coin");
    if(PANTRY.claiming){ b.textContent="Collecting…"; b.setAttribute("aria-disabled","true"); }
    else { b.appendChild(document.createTextNode("Collect "+amt+" ")); b.appendChild(ci); b.setAttribute("aria-label", "Collect today’s "+coinsN(amt)); }
    b.addEventListener("click", function(){ if(PANTRY.claiming) return; SV.claimAsked=true; pantryClaim(true); });
    cl.appendChild(b); if(had) b.focus();
  } else if(c.claimedToday){
    var d=el("span","sv-ok"); d.textContent="✓ Today’s coins collected"; cl.appendChild(d);
    if(when){ var w=el("span","sv-soft"); w.textContent=when; cl.appendChild(w); }
  }
  if(coins>=cap){ var f=el("span","sv-warn"); f.textContent="Purse full: spend or gift some to collect more"; cl.appendChild(f); }
}

/* ---- the bag: what you own; pick one to feed a creature ---- */
function svRenderBag(){
  var box=$("svBag"); if(!box) return;
  var j=PANTRY.j, open=svOpen(), items=(j&&j.items)||{};
  var owned=open ? FOOD_ORDER.filter(function(k){ return (items[k]|0)>0; }) : [];
  var sig=[open?1:0, owned.map(function(k){ return k+":"+(items[k]|0); }).join(",")].join("|");
  var hint=$("svBagHint");
  if(hint) hint.textContent = !open ? "Your snacks show up here once the store is open." : owned.length ? "Pick a snack to feed a creature. Gift them from the Arena." : "Empty! Buy something tasty from the shelf.";
  if(sig===SV.bagSig && box.firstChild) return; SV.bagSig=sig;
  var fa=document.activeElement, fk=(fa && box.contains(fa)) ? fa.getAttribute("data-kind") : null;
  box.innerHTML="";
  var slots=Math.max(12, Math.ceil(owned.length/6)*6), first=null;
  for(var i=0;i<slots;i++){
    var k=owned[i];
    if(!k){ var e=el("span","sv-slot empty"); e.setAttribute("aria-hidden","true"); box.appendChild(e); continue; }
    (function(k){
      var it=foodInfo(k), n=items[k]|0, b=el("button","sv-slot"); b.type="button"; b.setAttribute("data-kind", k);
      var im=el("img"); im.alt=""; im.width=32; im.height=32; im.src=pxURL(k); b.appendChild(im);
      var q=el("span","sv-qty"); q.setAttribute("aria-hidden","true"); q.textContent=String(n); b.appendChild(q);
      b.setAttribute("aria-label", foodN(it, n)+". Feed a creature");
      b.tabIndex=-1;
      b.addEventListener("click", function(){ svFeedOpen(k, b); });
      b.addEventListener("mousemove", function(ev){ svTipShow(k, b, ev); });
      b.addEventListener("mouseleave", svTipHide);
      box.appendChild(b);
      if(!first) first=b;
    })(k);
  }
  var keep=(fk && box.querySelector('.sv-slot[data-kind="'+fk+'"]')) || first;
  if(keep){ keep.tabIndex=0; if(fk) focusQuiet(keep); }
  else if(fk) focusQuiet(box);
}
function svBagKey(e){
  var all=[].slice.call($("svBag").querySelectorAll("button.sv-slot")), i=all.indexOf(document.activeElement); if(i<0) return;
  var cols=Math.max(1, (getComputedStyle($("svBag")).gridTemplateColumns||"").split(" ").filter(Boolean).length);
  var n = e.key==="ArrowRight" ? i+1 : e.key==="ArrowLeft" ? i-1 : e.key==="ArrowDown" ? i+cols : e.key==="ArrowUp" ? i-cols : e.key==="Home" ? 0 : e.key==="End" ? all.length-1 : null;
  if(n==null) return;
  e.preventDefault(); n=Math.max(0, Math.min(all.length-1, n));
  all[i].tabIndex=-1; all[n].tabIndex=0; all[n].focus();
}
function svFeedOpen(kind, from){
  svTipHide();
  SV.feedKind=kind; SV.feedFrom=from;
  var box=$("svFeed"); if(!box) return;
  box.classList.remove("hidden");
  svFeedRender();
  var r=from.getBoundingClientRect(), bw=box.offsetWidth, bh=box.offsetHeight;
  var x=Math.min(window.innerWidth-bw-10, Math.max(10, r.left+r.width/2-bw/2));
  var y=r.top-bh-10; if(y<10) y=Math.min(window.innerHeight-bh-10, r.bottom+10);
  box.style.left=x+"px"; box.style.top=y+"px";
  var first=box.querySelector(".sv-feed-row:not([disabled])") || box.querySelector("button");
  if(first) first.focus();
}
function svFeedClose(refocus){
  var box=$("svFeed"); if(!box || !SV.feedKind) return;
  box.classList.add("hidden"); box.innerHTML="";
  var from=SV.feedFrom; SV.feedKind=null; SV.feedFrom=null;
  if(refocus && from && document.body.contains(from)) focusQuiet(from);
}
function svFeedRender(){
  var box=$("svFeed"), it=foodInfo(SV.feedKind); if(!box || !it) return;
  var j=PANTRY.j||{}, own=(j.items||{})[it.kind]|0;
  if(own<=0){ svFeedClose(true); return; }
  box.innerHTML="";
  var h=el("div","sv-feed-h"); h.id="svFeedH";
  var hi=el("img"); hi.alt=""; hi.width=24; hi.height=24; hi.src=pxURL(it.kind); h.appendChild(hi);
  var ht=el("span"); ht.textContent="Who gets "+(it.revives ? "the "+it.name : foodA(it))+"?"; h.appendChild(ht);
  box.appendChild(h);
  var ss=(STATE&&STATE.sessions)||[], rows=0;
  ss.forEach(function(s){
    var cr=s.creature, f=fzOf(cr); if(!f || !s.sessionId) return;
    var ko=f.state==="unconscious";
    if(it.revives ? !ko : (ko || f.state==="rested")) return;
    rows++;
    var load=fzMins(f.loadMins), after=it.revives ? Math.max(0, Math.min(load, fzMins(it.wakeToMins))) : Math.max(0, load-fzMins(it.restoreMins));
    var to=Math.max(0, Math.min(100, Math.round(100*(1-after/FZ_SCALE_MINS)))), nm=creatureSpecies(cr);
    var b=el("button","sv-feed-row"); b.type="button";
    var av=el("span","sv-feed-av"); av.setAttribute("aria-hidden","true"); paintCreature(av, cr, 40); b.appendChild(av);
    var t1=el("span","sv-feed-nm"); t1.textContent=nm; b.appendChild(t1);
    var t2=el("span","sv-feed-sub"); t2.textContent=fzLabel(f.state)+" · "+fzPct(f)+"% → "+to+"%"+(s.title ? " · "+String(s.title).slice(0,40) : ""); b.appendChild(t2);
    b.setAttribute("aria-label", "Give "+nm+" "+foodA(it)+": "+fzLabel(f.state)+", energy "+fzPct(f)+"% to "+to+"%");
    if(CARE_BUSY || pendingEatFor(s.sessionId)) b.disabled=true;
    b.addEventListener("click", function(){ svFeed(s.sessionId, it.kind, nm); });
    box.appendChild(b);
  });
  if(!rows){
    var p=el("p","sv-feed-none");
    p.textContent = it.revives ? "No one has fainted. Keep it for a rainy day!" : "Everyone's full of energy right now. Save it for later!";
    box.appendChild(p);
  }
  var x=el("button","sv-btn sv-feed-x"); x.type="button"; x.textContent="Not now";
  x.addEventListener("click", function(){ svFeedClose(true); }); box.appendChild(x);
}
function svFeed(sid, kind, nm){
  var it=foodInfo(kind);
  svFeedClose(false); svSfx("munch");
  svSay(it && it.revives ? "Up you get, "+nm+"!" : "Bon appétit, "+nm+"!", "happy");
  pantryEat(sid, kind, null);
  var bag=$("svBag"); if(bag) focusQuiet(bag.querySelector('.sv-slot[data-kind="'+kind+'"]') || bag.querySelector("button.sv-slot") || $("svList"));
}

/* ---- opening and leaving the view ---- */
function svEnter(){
  svBuild();
  SV.openedAt=Date.now();
  SV.env=svEnvNow();
  svResize(true);
  if(ARENA.paired) pantryLoad(); else pollArenaStat();
  svRender();
  if(svFriendAdd("visit")){ svSfx("heart"); svSay(svPick(SV_LINES.heartUp, "heartUp"), "happy"); }
  else svGreet();
  svAnimStart();
}
function svLeave(){
  if(!SV.built) return;
  svAnimStop(); svTipHide(); svFeedClose(false);
  if(SV.talk.timer){ svSkip(); }
}

