/* ---- config + creature packs (v5) ---- */
var CONFIG_DEFAULTS = {theme:"aurora", creaturePack:"pokemon3d", refreshMs:5000, stuckMinutes:15, dailyBudgetUSD:0, trainerName:"", trainerAvatar:null, character:null, creatureFatigue:true, musicShare:true, musicCookies:""};
var CONFIG = Object.assign({}, CONFIG_DEFAULTS);
function cfg(){ return CONFIG; }
// both Pokémon packs share evolution/type/name logic; only the sprite source differs
function isPokePack(){ var p=cfg().creaturePack; return p==="pokemon"||p==="pokemon3d"; }
// backend creature name order (index-stable). See CREATURES in dashboard.py.
var POKE_NAMES = ["Pikachu","Charmander","Squirtle","Bulbasaur","Dragonite","Psyduck","Umbreon","Geodude"];
var CREATURE_PACKS = {
  pokemon:["⚡🐭","🔥🦎","💧🐢","🌱🐸","💨🐉","💦🦆","🌙🦊","🪨🐛"],
  animals:["🦊","🐼","🦁","🐨","🐧","🦉","🐢","🦖"],
  faces:["😺","🤖","👾","🐲","🦄","🐙","🦔","🐝"]
};
function creatureIndex(cr){
  if(!cr) return 0;
  var i = POKE_NAMES.indexOf(cr.name);
  if(i>=0) return i;
  if(cr.index!=null) return ((cr.index%8)+8)%8;
  if(cr.hue!=null) return cr.hue%8;
  return 0;
}
// Stable per-session emoji within the active pack; safe fallback to backend emoji.
function creatureEmoji(cr){
  cr = cr||{};
  var arr = CREATURE_PACKS[cfg().creaturePack] || CREATURE_PACKS.pokemon;
  return (arr && arr[creatureIndex(cr)]) || cr.emoji || "🐣";
}
/* ---- v6: generated pixel-monster sprites ---- */
// Deterministic PRNG (mulberry32) + a small string hash for seeding.
function mulberry32(a){ return function(){ a|=0; a=a+0x6D2B79F5|0; var t=Math.imul(a^a>>>15,1|a);
  t=t+Math.imul(t^t>>>7,61|t)^t; return ((t^t>>>14)>>>0)/4294967296; }; }
function hashStr(s){ s=String(s==null?"":s); var h=2166136261>>>0;
  for(var i=0;i<s.length;i++){ h^=s.charCodeAt(i); h=Math.imul(h,16777619); } return h>>>0; }

// Invented species + types (no copyrighted assets); index-stable via creatureIndex.
var STAGE_NAMES=["Egg","Hatchling","Juvenile","Adult","Elder"];
var MONSTER_SPECIES=["Voltmouse","Emberling","Aquapup","Sproutle","Zephyrix","Dribblet","Lunavox","Cobblite"];
var MONSTER_TYPES=["Spark","Ember","Aqua","Leaf","Gale","Tide","Umbra","Terra"];

// Real primary types for the 48 mapped Pokemon (index-aligned with POKE_DEX/POKE_REAL).
var POKE_TYPES=["Electric","Fire","Water","Grass","Normal","Ghost","Normal","Dragon","Fighting","Psychic","Fire","Water","Grass","Electric","Water","Water","Fire","Normal","Water","Dragon","Rock","Fire","Dark","Psychic","Bug","Steel","Fairy","Dark","Steel","Bug","Dragon","Grass","Flying","Psychic","Bug","Fire","Dragon","Water","Electric","Electric","Normal","Flying","Dark","Grass","Fire","Water","Dragon","Steel"];
var POKE_TYPE_HUE={Normal:52,Fire:20,Water:212,Electric:48,Grass:99,Ice:190,Fighting:5,Poison:290,Ground:35,Flying:200,Psychic:325,Bug:75,Rock:45,Ghost:270,Dragon:255,Dark:25,Steel:210,Fairy:330};
function creatureTypeHue(cr){ cr=cr||{};
  if(isPokePack()){ var h=POKE_TYPE_HUE[POKE_TYPES[pokeIdx(cr)]]; if(h!=null) return h; }
  if(cfg().creaturePack==="village"){ return TROOP_HUE[TROOP_ARCH[pokeIdx(cr)%8]]; }
  return cr.typeHue!=null?cr.typeHue:(cr.hue!=null?cr.hue:220); }
// Cross-session high-water evolution stage for a species (New Game+): once a species has
// reached a stage in ANY past/live session, new sessions START at that grown form instead
// of resetting to Egg. Keyed by pokeIdx(cr) to match dexHighWater()'s species key. DEX_MAX
// is the same persisted map the Pokedex uses; it is also seeded on startup from /api/pokedex
// (see primeHighWater) so the floor applies even if the Pokedex view was never opened.
function speciesHighWater(cr){ var hw=DEX_MAX[String(pokeIdx(cr))]; return hw!=null?Math.max(0,Math.min(4,hw|0)):0; }
function creatureStage(cr){ cr=cr||{}; var s=cr.stage!=null?cr.stage|0:3; s=Math.max(0,Math.min(4,s));
  if(cr._noFloor) return s;   // explicit-stage renders (preview nodes, evolving animation) skip the floor
  var hw=speciesHighWater(cr); return hw>s?hw:s; }
function creatureSeed(cr){ cr=cr||{}; return hashStr((cr.species||cr.name||"")+"|"+creatureIndex(cr)); }
function creatureSpecies(cr){ cr=cr||{};
  if(isPokePack()) return pokeCurrentName(cr);  // current evolved form
  if(cfg().creaturePack==="village") return troopLabel(cr);
  if(cfg().creaturePack==="aniimo") return animoLabel(cr);
  if(cr.speciesName) return cr.speciesName;
  if(cfg().creaturePack==="monsters") return MONSTER_SPECIES[creatureIndex(cr)]||cr.name||"Monster";
  return cr.name||MONSTER_SPECIES[creatureIndex(cr)]||"Monster"; }
function creatureType(cr){ cr=cr||{};
  if(isPokePack()) return POKE_TYPES[pokeIdx(cr)]||"Normal";
  if(cfg().creaturePack==="village") return TROOP_ROLE[TROOP_ARCH[pokeIdx(cr)%8]]||"Troop";
  return cr.type || MONSTER_TYPES[creatureIndex(cr)] || "Neutral"; }
function creatureStageName(cr){ cr=cr||{};
  if(cfg().creaturePack==="village") return "Lv "+troopLevelForCreature(cr)+"/"+troopMaxLvl(cr);
  return cr.stageName || STAGE_NAMES[creatureStage(cr)] || ("Stage "+creatureStage(cr)); }
function creatureNextStageName(cr){ cr=cr||{};
  if(isPokePack()){ var n=pokeNextName(cr); return n; }  // next evolution form
  if(cr.nextStageName) return cr.nextStageName;
  var st=creatureStage(cr);
  if(cfg().creaturePack==="village"){ var l=troopLevelForCreature(cr); return l>=troopMaxLvl(cr)?null:("Lv "+(l+1)); }
  return st>=4?null:STAGE_NAMES[st+1]; }
function creatureStagePct(cr){ cr=cr||{}; var p=cr.stagePct!=null?cr.stagePct:0; if(p<=1) p=p*100; /* backend sends 0..1 */ return Math.max(0,Math.min(100,Math.round(p))); }

/* ---- creature energy (fatigue) + the Poke Coins pantry: shared state + helpers ----
   s.creature.fatigue is computed locally by dashboard.py from transcript activity. It is
   cosmetic: never XP, never the Arena board. Coins and snacks live on the Arena server and
   reach the page only through the local /api/arena/pantry proxy. The two FZ_ lines mirror
   dashboard.py FATIGUE_CERTAIN_SECS / FATIGUE_TIRED_SECS (a test greps them). */
var FZ_SCALE_MINS = 240;
var FZ_TIRED_MINS = 60;
var FZ_STATES = ["rested","tired","fatigued","unconscious"];
// The creature's fatigue, or null (key absent, malformed, or energy turned off in Settings).
function fzOf(cr){
  var f = cr && cr.fatigue;
  if(!f || typeof f!=="object" || FZ_STATES.indexOf(f.state)<0 || CONFIG.creatureFatigue===false) return null;
  return f;
}
// energy is 0..1 on the wire (never creatureStagePct: that one guesses units).
function fzPct(f){ return Math.max(0, Math.min(100, Math.round((Number(f.energy)||0)*100))); }
function fzMins(v){ return Math.max(0, Math.round(Number(v)||0)); }
function fmtMins(m){ m=fzMins(m); if(m<60) return m+"m"; var h=Math.floor(m/60), r=m%60; return h+"h"+(r?" "+r+"m":""); }
function fzLabel(state){ return state==="tired"?"Tired":state==="fatigued"?"Fatigued":state==="unconscious"?"Fainted":"Rested"; }
// One id per user intent (a snack, a buy, a gift), reused for every retry of it: the
// server replays a repeated id instead of spending twice.
function newRequestId(){
  try{ if(window.crypto && crypto.randomUUID) return crypto.randomUUID(); }catch(e){}
  var b=new Uint8Array(16), s="";
  try{ crypto.getRandomValues(b); }catch(e){ for(var i=0;i<16;i++) b[i]=Math.floor(Math.random()*256); }
  for(var k=0;k<16;k++) s+=(b[k]<16?"0":"")+b[k].toString(16);
  return s;
}
// Fallback food labels + effects until the Arena catalog arrives. The server catalog (backend
// app/pantry.py) is the authority for names, prices and stock; the local proxy overlays the effects.
// season/cat/desc are the store's own: when it's stocked, its shelf category, its tooltip line.
var FOOD_ORDER = ["berry","bread","riceball","coffee","bento","noodles","hotpot","tonic","elixir",
  "strawberry","dango","omelette","watermelon","shavedice","curry","apple","sweetpotato","pumpkinstew","chestnuts","cocoa","oden"];
var FOOD_UI = {
  berry:      {name:"Berry", plural:"Berries", emoji:"🫐", price:1, restoreMins:20, revives:false, season:"all", cat:"fruit", desc:"A handful of wild berries. Tart, sweet, gone in a second."},
  bread:      {name:"Bread Loaf", plural:"Bread Loaves", emoji:"🍞", price:1, restoreMins:20, revives:false, season:"all", cat:"snack", desc:"Crusty outside, pillowy inside. Still warm from the oven."},
  riceball:   {name:"Rice Ball", plural:"Rice Balls", emoji:"🍙", price:2, restoreMins:45, revives:false, season:"all", cat:"snack", desc:"Hand-pressed rice wrapped in crisp seaweed. Fits in any pocket."},
  coffee:     {name:"Coffee", plural:"Coffees", emoji:"☕", price:2, restoreMins:45, revives:false, season:"all", cat:"drink", desc:"Dark roast with a splash of cream, for trainers who work late."},
  bento:      {name:"Bento", plural:"Bentos", emoji:"🍱", price:3, restoreMins:120, revives:false, season:"all", cat:"meal", desc:"A boxed lunch: rice, salmon, rolled omelette and greens."},
  noodles:    {name:"Noodle Bowl", plural:"Noodle Bowls", emoji:"🍜", price:3, restoreMins:120, revives:false, season:"all", cat:"meal", desc:"Slurpable noodles in savory broth with a soft-boiled egg."},
  hotpot:     {name:"Hot Pot", plural:"Hot Pots", emoji:"🍲", price:4, restoreMins:180, revives:false, season:"all", cat:"meal", desc:"A bubbling clay pot of stew. Feeds a whole team."},
  tonic:      {name:"Revive Tonic", plural:"Revive Tonics", emoji:"🧃", price:5, restoreMins:0, revives:true, wakeToMins:105, season:"all", cat:"tonic", desc:"Fizzy and herbal. Wakes a creature that has fainted."},
  elixir:     {name:"Honey Elixir", plural:"Honey Elixirs", emoji:"🍯", price:7, restoreMins:60, revives:true, wakeToMins:45, season:"all", cat:"tonic", desc:"Golden honey and mountain herbs. Wakes a fainted creature almost fully rested."},
  strawberry: {name:"Strawberry", plural:"Strawberries", emoji:"🍓", price:1, restoreMins:25, revives:false, season:"spring", cat:"fruit", desc:"Picked at dawn. The sweetest bite of spring."},
  dango:      {name:"Hanami Dango", plural:"Hanami Dango", emoji:"🍡", price:2, restoreMins:55, revives:false, season:"spring", cat:"sweet", desc:"Three chewy rice dumplings for cherry-blossom picnics."},
  omelette:   {name:"Garden Omelette", plural:"Garden Omelettes", emoji:"🍳", price:3, restoreMins:135, revives:false, season:"spring", cat:"meal", desc:"Fluffy eggs with garden herbs and a ribbon of tomato."},
  watermelon: {name:"Watermelon Slice", plural:"Watermelon Slices", emoji:"🍉", price:1, restoreMins:25, revives:false, season:"summer", cat:"fruit", desc:"Cold, crisp and dripping. Summer in a slice."},
  shavedice:  {name:"Shaved Ice", plural:"Shaved Ices", emoji:"🍧", price:2, restoreMins:55, revives:false, season:"summer", cat:"sweet", desc:"A snowy mound drizzled with strawberry and blue syrup."},
  curry:      {name:"Summer Curry", plural:"Summer Curries", emoji:"🍛", price:3, restoreMins:135, revives:false, season:"summer", cat:"meal", desc:"Golden curry with summer veggies over rice. A little kick."},
  apple:      {name:"Apple", plural:"Apples", emoji:"🍎", price:1, restoreMins:25, revives:false, season:"fall", cat:"fruit", desc:"Crisp and juicy, straight from the orchard."},
  sweetpotato:{name:"Baked Sweet Potato", plural:"Baked Sweet Potatoes", emoji:"🍠", price:2, restoreMins:55, revives:false, season:"fall", cat:"snack", desc:"Roasted in its skin until the inside turns to honey."},
  pumpkinstew:{name:"Pumpkin Stew", plural:"Pumpkin Stews", emoji:"🎃", price:3, restoreMins:135, revives:false, season:"fall", cat:"meal", desc:"Hearty stew served in a hollowed-out pumpkin."},
  chestnuts:  {name:"Bag of Chestnuts", plural:"Bags of Chestnuts", emoji:"🌰", price:1, restoreMins:25, revives:false, season:"winter", cat:"snack", desc:"Roasted by the door until the shells split. Warm hands guaranteed."},
  cocoa:      {name:"Hot Cocoa", plural:"Hot Cocoas", emoji:"🍫", price:2, restoreMins:55, revives:false, season:"winter", cat:"drink", desc:"Rich hot chocolate with marshmallows on top."},
  oden:       {name:"Oden Skewer", plural:"Oden Skewers", emoji:"🍢", price:3, restoreMins:135, revives:false, season:"winter", cat:"meal", desc:"Daikon, konjac and fried tofu, simmered all day in broth."}
};
function isFood(k){ return typeof k==="string" && Object.prototype.hasOwnProperty.call(FOOD_UI, k); }
// store: "unknown" | "ok" | "unsupported" (an older Arena server) | "unpaired" | "error"
//      | "restart" (the running dashboard.py predates the store: this page is newer than it)
//      | "reload" (this page predates dashboard.py's last start: see pantryLocalReject)
// stale: set for good once dashboard.py has refused this page's token; only a page load cures it.
var PANTRY = {store:"unknown", j:null, at:0, rev:0, claiming:false, offAt:0, loading:false, bump:false, stale:false, retrying:false};
// Two different 404s. An Arena server without the store answers a bare "Not Found" (FastAPI's
// {"detail":"Not Found"}, or the HTTP reason phrase for an empty body; a missing person is "no such
// person"). dashboard.py's own route miss is a lowercase {"error":"not found"}: after an update,
// index.html is re-read on refresh but the dashboard.py process keeps running the old code until
// it restarts, and that old process has no pantry routes. The case tells them apart.
function pantryIsBare404(res){ return res.status===404 && /^Not Found$/.test(String((res.j&&(res.j.error||res.j.detail))||"")); }
function pantryIsLocalMiss(res){ return res.status===404 && !!res.j && res.j.error==="not found"; }
// The store state a 404 means, or null when it's an ordinary error ("no such person", ...).
function pantryMissState(res){ return pantryIsBare404(res) ? "unsupported" : (pantryIsLocalMiss(res) ? "restart" : null); }
// dashboard.py turned the POST away itself, so it never reached the Arena: that's no answer.
// Usually the CSRF token: dashboard.py mints a new one each time it starts, and this page only
// picks it up when it loads. Whatever the request was retrying (a lost gift, buy or snack) stays
// saved with its requestId, and the page asks for a reload. Its own 403s say "error" (an Arena
// refusal relayed by dashboard.py also carries "detail"), optionally tagged code "csrf".
function pantryLocalReject(res){
  var j=res && res.j;
  return !!j && res.status===403 && typeof j.error==="string" && !("detail" in j) &&
    (j.code==="csrf" || /^(bad or missing CSRF token|cross-site request rejected|local access only)$/.test(j.error));
}
function pageReload(){ try{ location.reload(); }catch(e){} }
// A food kind's catalog entry: the server's strings, prices and stock over the local fallback.
// stocked: this Arena's catalog lists it (an older server lacks the newer foods); inStock: sold today.
function foodInfo(kind){
  if(!isFood(kind)) return null;
  var b=FOOD_UI[kind];
  var out={kind:kind, name:b.name, plural:b.plural, emoji:b.emoji, price:b.price, basePrice:b.price, restoreMins:b.restoreMins,
           revives:b.revives, wakeToMins:b.wakeToMins!=null ? b.wakeToMins : 105, season:b.season||"all", cat:b.cat||"snack",
           desc:b.desc||"", stocked:false, inStock:false, special:false};
  var cat=(PANTRY.j && Array.isArray(PANTRY.j.catalog)) ? PANTRY.j.catalog : [];
  for(var i=0;i<cat.length;i++){
    var c=cat[i]; if(!c || c.kind!==kind) continue;
    if(typeof c.name==="string" && c.name) out.name=c.name.slice(0,40);
    if(typeof c.plural==="string" && c.plural) out.plural=c.plural.slice(0,40);
    if(typeof c.emoji==="string" && c.emoji) out.emoji=c.emoji.slice(0,8);
    if(typeof c.price==="number" && c.price>=0 && c.price%1===0) out.price=out.basePrice=c.price;
    if(typeof c.basePrice==="number" && c.basePrice>=0 && c.basePrice%1===0) out.basePrice=c.basePrice;
    if(typeof c.restoreMins==="number" && c.restoreMins>=0) out.restoreMins=c.restoreMins;
    if(typeof c.revives==="boolean") out.revives=c.revives;
    if(typeof c.wakeToMins==="number" && c.wakeToMins>=0) out.wakeToMins=c.wakeToMins;
    if(c.season==="all"||c.season==="spring"||c.season==="summer"||c.season==="fall"||c.season==="winter") out.season=c.season;
    out.stocked=true;
    out.inStock=typeof c.inStock==="boolean" ? c.inStock : true;
    out.special=c.special===true && out.inStock;
    break;
  }
  return out;
}
// The catalog in the server's order (known kinds only), else the fallback order.
function pantryCatalog(){
  var cat=(PANTRY.j && Array.isArray(PANTRY.j.catalog)) ? PANTRY.j.catalog : [], out=[], seen={};
  cat.forEach(function(c){ if(c && isFood(c.kind) && !seen[c.kind]){ seen[c.kind]=1; out.push(foodInfo(c.kind)); } });
  if(!out.length) FOOD_ORDER.forEach(function(k){ out.push(foodInfo(k)); });
  return out;
}
function foodA(info){ return (/^[aeiou]/i.test(info.name)?"an ":"a ")+info.name; }
function foodN(info, n){ return n+" "+(n===1?info.name:info.plural); }
function coinsN(n){ return n+" Poke Coin"+(n===1?"":"s"); }

