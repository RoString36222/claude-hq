/* ===== Trainer avatar — original, deterministic, dependency-free SVG =========
 * A customizable "you" identity built from a tiny 9-int spec. 100% original
 * inline geometry (no <img>, no CDN/url()); reuses mulberry32/hashStr/calmMode.
 * spec = [skin,hair,hairColor,outfit,outfitColor,hat,accessory,bg,face]. */
var TR = {SKIN:0,HAIR:1,HAIRC:2,OUTFIT:3,OUTC:4,HAT:5,ACC:6,BG:7,FACE:8};
var TR_MAX = [6,8,8,8,8,7,5,8,4];   // keep byte-identical to TRAINER_MAX in dashboard.py
var TR_SKIN  = ['#f4d6bb','#e7b892','#cd9269','#a06a45','#6f4a32','#402a20','#b9c6d4'];
var TR_HAIRC = ['#241f22','#4a3324','#7a4a26','#c98f3f','#dcd6c8','#a9b0bc','#c14259','#456fa6','#2ff3ff'];
var TR_OUTC  = ['#4f6d7a','#bd5638','#3f8a5b','#6a4f9c','#d3a33f','#333a43','#c46f9a','#dadbe2','#ff2fb3'];
var TR_BG    = ['','#3b4a6b','#276b68','#6b3b5a','#4a6b3b','#6b5a3b','#39414d','#5a4a6b','#140d2b'];
// The two neon accents the cyberpunk choices are lit with. Fixed rather than
// derived from the chosen colours: half the point of neon is that it does not
// match the clothes. Glow is an inline drop-shadow, like the shiny sprites at
// the bottom of this file -- never an SVG <filter>, because a filter needs an
// id and several avatars render on one page.
var TR_NEON = '#2ff3ff', TR_NEON2 = '#ff2fb3';
function _trGlow(c,r){ return ' style="filter:drop-shadow(0 0 '+(r||2)+'px '+c+')"'; }
// human labels for the builder controls
var TR_LABELS = {
  skin:['Fair','Light','Tan','Brown','Deep','Rich','Chrome'],
  hair:['Bald','Short','Side part','Spiky','Pulled back','Long','Curly','Top knot','Neon crest'],
  hairColor:['Black','Dark brown','Brown','Blond','Platinum','Grey','Red','Blue','Neon cyan'],
  outfit:['Collar','Crew','Hoodie','Collar 2','Crew 2','Hoodie 2','Collar 3','Crew 3','Techwear'],
  outfitColor:['Teal','Rust','Green','Purple','Gold','Charcoal','Pink','White','Hot magenta'],
  hat:['None','Beanie','Wide brim','Headband','Visor','Hood','Bandana','Neural halo'],
  accessory:['None','Glasses','Round glasses','Earrings','Face mask','AR visor'],
  bg:['Theme','Glow','Chevrons','Dots','Rings','Split','Stripes','Halo','Neon grid'],
  face:['Neutral','Smile','Wink','Stoic','Lit eyes']
};
function _trHx(h){h=String(h||'').replace('#','');if(h.length===3)h=h[0]+h[0]+h[1]+h[1]+h[2]+h[2];return [parseInt(h.slice(0,2),16)||0,parseInt(h.slice(2,4),16)||0,parseInt(h.slice(4,6),16)||0];}
function _trTo(r,g,b){function c(x){x=Math.max(0,Math.min(255,Math.round(x)));var s=x.toString(16);return s.length<2?'0'+s:s;}return '#'+c(r)+c(g)+c(b);}
function trShade(hex,f){var a=_trHx(hex),t=f<0?0:255,k=Math.min(1,Math.abs(f));return _trTo(a[0]+(t-a[0])*k,a[1]+(t-a[1])*k,a[2]+(t-a[2])*k);}
function trv(spec,i){var m=TR_MAX[i],v=(spec&&spec[i]!=null)?(spec[i]|0):0;return ((v%(m+1))+(m+1))%(m+1);}
function _trBg(bi){
  if(bi===0) return '<rect width="100" height="100" fill="currentColor" opacity="0.06"/>';
  var base=TR_BG[bi]||'#3b4a6b',lite=trShade(base,0.16),dark=trShade(base,-0.16);
  var s='<rect width="100" height="100" fill="'+base+'"/>';
  if(bi===1) s+='<ellipse cx="50" cy="18" rx="62" ry="40" fill="'+lite+'" opacity="0.55"/>';
  else if(bi===2) s+='<g fill="'+lite+'" opacity="0.5"><polygon points="0,66 50,40 50,54 0,80"/><polygon points="50,40 100,66 100,80 50,54"/><polygon points="0,86 50,60 50,74 0,100"/><polygon points="50,60 100,86 100,100 50,74"/></g>';
  else if(bi===3){s+='<g fill="'+lite+'" opacity="0.55">';for(var y=12;y<=88;y+=19)for(var x=12;x<=88;x+=19)s+='<circle cx="'+x+'" cy="'+y+'" r="2.6"/>';s+='</g>';}
  else if(bi===4) s+='<g fill="none" stroke="'+lite+'" stroke-width="3" opacity="0.5"><circle cx="50" cy="50" r="20"/><circle cx="50" cy="50" r="33"/><circle cx="50" cy="50" r="46"/></g>';
  else if(bi===5) s+='<polygon points="0,0 100,0 0,100" fill="'+lite+'" opacity="0.4"/><polygon points="100,0 100,100 0,100" fill="'+dark+'" opacity="0.35"/>';
  else if(bi===6) s+='<g fill="'+lite+'" opacity="0.4"><rect x="8" y="0" width="10" height="100"/><rect x="34" y="0" width="10" height="100"/><rect x="60" y="0" width="10" height="100"/><rect x="86" y="0" width="10" height="100"/></g>';
  else if(bi===7) s+='<circle cx="50" cy="46" r="30" fill="'+lite+'" opacity="0.6"/>';
  else {
    // Neon grid: a horizon, rails converging on it, and rungs that widen as
    // they come forward -- the perspective is in the spacing, so there is no
    // transform to get wrong at any render size.
    s+='<rect x="0" y="0" width="100" height="56" fill="'+trShade(base,-0.35)+'"/>';
    s+='<ellipse cx="50" cy="56" rx="46" ry="12" fill="'+TR_NEON2+'" opacity="0.30"/>';
    s+='<g stroke="'+TR_NEON+'" stroke-width="0.7" opacity="0.65">';
    for(var gx=-4;gx<=4;gx++) s+='<line x1="'+(50+gx*5)+'" y1="56" x2="'+(50+gx*26)+'" y2="100"/>';
    var gy=56; for(var gi2=0;gi2<7;gi2++){ gy+=2.2+gi2*1.6; if(gy<100) s+='<line x1="0" y1="'+gy+'" x2="100" y2="'+gy+'"/>'; }
    s+='</g>';
    s+='<line x1="0" y1="56" x2="100" y2="56" stroke="'+TR_NEON+'" stroke-width="1.4" opacity="0.9"/>';
  }
  return s;
}
function _trFace(fi,skin){
  var brow=trShade(skin,-0.4),eye='#2b2b31',s='';
  if(fi===4){
    // Lit eyes: an implant ring round a bright core, and a scanline down one
    // cheek. Drawn under the hair and any accessory, so an AR visor covers it.
    s+='<g'+_trGlow(TR_NEON,2.5)+'>';
    s+='<ellipse cx="41" cy="44" rx="3.4" ry="3.6" fill="'+trShade(TR_NEON,-0.55)+'"/><ellipse cx="59" cy="44" rx="3.4" ry="3.6" fill="'+trShade(TR_NEON,-0.55)+'"/>';
    s+='<ellipse cx="41" cy="44" rx="1.7" ry="2.2" fill="'+TR_NEON+'"/><ellipse cx="59" cy="44" rx="1.7" ry="2.2" fill="'+TR_NEON+'"/>';
    s+='</g>';
    s+='<g stroke="'+TR_NEON+'" stroke-width="0.8" opacity="0.55"><line x1="63" y1="50" x2="66" y2="56"/><line x1="61" y1="52" x2="64" y2="58"/></g>';
  }
  else if(fi===2){s+='<path d="M37,44 q4,4 8,0" fill="none" stroke="'+eye+'" stroke-width="2.2" stroke-linecap="round"/>';s+='<ellipse cx="59" cy="44" rx="2.4" ry="3" fill="'+eye+'"/>';}
  else {s+='<ellipse cx="41" cy="44" rx="2.4" ry="3" fill="'+eye+'"/><ellipse cx="59" cy="44" rx="2.4" ry="3" fill="'+eye+'"/>';}
  if(fi===3) s+='<g stroke="'+brow+'" stroke-width="2" stroke-linecap="round"><line x1="36" y1="38" x2="46" y2="38"/><line x1="54" y1="38" x2="64" y2="38"/></g>';
  else s+='<g stroke="'+brow+'" stroke-width="2" stroke-linecap="round"><line x1="36" y1="37" x2="46" y2="35.5"/><line x1="54" y1="35.5" x2="64" y2="37"/></g>';
  s+='<path d="M50,46 q-2,6 -3,7" fill="none" stroke="'+trShade(skin,-0.22)+'" stroke-width="1.6" stroke-linecap="round"/>';
  if(fi===1) s+='<path d="M43,55 q7,7 14,0" fill="none" stroke="#7a4a44" stroke-width="2.2" stroke-linecap="round"/>';
  else if(fi===2) s+='<path d="M44,55 q6,4 12,0" fill="none" stroke="#7a4a44" stroke-width="2.2" stroke-linecap="round"/>';
  else s+='<line x1="45" y1="56" x2="55" y2="56" stroke="#7a4a44" stroke-width="2.2" stroke-linecap="round"/>';
  return s;
}
function _trHairBack(hi,col){
  if(hi===5) return '<path d="M28,40 C24,64 30,86 34,92 L66,92 C70,86 76,64 72,40 Z" fill="'+col+'"/>';
  if(hi===4) return '<path d="M64,40 C78,46 80,70 72,86 L64,84 C70,70 68,52 60,46 Z" fill="'+col+'"/>';
  if(hi===6) return '<circle cx="50" cy="40" r="26" fill="'+col+'"/>';
  // The crest is shaved at the sides, so the only mass behind the head is a
  // short nape.
  if(hi===8) return '<path d="M40,56 C40,66 44,72 50,72 C56,72 60,66 60,56 Z" fill="'+trShade(col,-0.4)+'"/>';
  return '';
}
function _trHairFront(hi,col){
  var hl=trShade(col,0.16),sh=trShade(col,-0.2);
  if(hi===0) return '';
  if(hi===1) return '<path d="M32,42 C31,27 40,21 50,21 C60,21 69,27 68,42 C64,33 58,30 50,30 C42,30 36,33 32,42 Z" fill="'+col+'"/><path d="M34,40 C36,31 43,28 50,28 C50,28 44,31 42,40 Z" fill="'+hl+'" opacity="0.5"/>';
  if(hi===2) return '<path d="M31,42 C31,26 41,21 51,21 C61,21 68,27 69,40 C60,31 52,32 46,34 C40,36 35,39 31,44 Z" fill="'+col+'"/>';
  if(hi===3) return '<path d="M32,42 L36,24 L42,36 L48,20 L54,36 L60,24 L64,30 L68,42 C60,32 40,32 32,42 Z" fill="'+col+'"/>';
  if(hi===4) return '<path d="M32,42 C32,28 41,22 50,22 C59,22 68,28 68,42 C60,34 40,34 32,42 Z" fill="'+col+'"/>';
  if(hi===5) return '<path d="M31,44 C30,27 40,21 50,21 C60,21 70,27 69,44 C66,34 58,30 50,30 C42,30 34,34 31,44 Z" fill="'+col+'"/><path d="M31,44 C29,58 30,72 31,80 L36,80 C34,66 34,54 35,46 Z" fill="'+sh+'"/>';
  if(hi===6) return '<g fill="'+hl+'" opacity="0.45"><circle cx="38" cy="28" r="7"/><circle cx="52" cy="24" r="8"/><circle cx="63" cy="30" r="6"/></g>';
  if(hi===7) return '<path d="M33,42 C33,28 42,22 50,22 C58,22 67,28 67,42 C60,34 40,34 33,42 Z" fill="'+col+'"/><circle cx="50" cy="16" r="7" fill="'+col+'"/><circle cx="50" cy="16" r="3.5" fill="'+hl+'" opacity="0.5"/>';
  // Neon crest: shaved sides with a stubble shadow, a swept fin, and lit tips.
  // The glow rides the chosen hair colour, not the fixed neon, so the colour
  // swatches still do something here.
  var tip = trShade(col,0.45);
  return '<path d="M34,43 C34,33 40,27 44,25 C42,32 41,38 41,43 Z" fill="'+trShade(col,-0.5)+'" opacity="0.55"/>'
       + '<path d="M66,43 C66,33 60,27 56,25 C58,32 59,38 59,43 Z" fill="'+trShade(col,-0.5)+'" opacity="0.55"/>'
       + '<g'+_trGlow(col,2)+'><path d="M43,40 C43,22 47,12 52,9 C55,13 56,21 56,27 C56,33 55,37 55,40 Z" fill="'+col+'"/>'
       + '<path d="M46,30 C46,20 49,14 52,11 C53,16 53,23 52,30 Z" fill="'+tip+'" opacity="0.75"/></g>';
}
function _trHat(hi2,oc){
  var band=trShade(oc,-0.25);
  if(hi2===0) return '';
  if(hi2===1) return '<path d="M30,34 C30,20 40,15 50,15 C60,15 70,20 70,34 C58,29 42,29 30,34 Z" fill="'+oc+'"/><rect x="30" y="32" width="40" height="6" rx="3" fill="'+band+'"/>';
  if(hi2===2) return '<ellipse cx="50" cy="34" rx="34" ry="8" fill="'+band+'"/><path d="M34,34 C34,18 44,13 50,13 C56,13 66,18 66,34 Z" fill="'+oc+'"/><rect x="34" y="30" width="32" height="5" rx="2.5" fill="'+trShade(oc,0.12)+'"/>';
  if(hi2===3) return '<path d="M30,33 C40,29 60,29 70,33 L70,39 C60,35 40,35 30,39 Z" fill="'+oc+'"/>';
  if(hi2===4) return '<path d="M28,33 C40,27 60,27 72,33 L72,37 C60,32 40,32 28,37 Z" fill="'+oc+'"/><path d="M26,37 C40,34 60,34 74,37 L78,42 C60,37 40,37 22,42 Z" fill="'+band+'"/>';
  if(hi2===5) return '<path d="M24,46 C22,24 38,12 50,12 C62,12 78,24 76,46 C66,34 34,34 24,46 Z" fill="'+oc+'"/><path d="M30,44 C32,28 42,20 50,20 C58,20 68,28 70,44 C60,36 40,36 30,44 Z" fill="'+trShade(oc,-0.14)+'"/>';
  if(hi2===6) return '<path d="M30,32 C40,27 60,27 70,32 L70,40 C60,35 40,35 30,40 Z" fill="'+oc+'"/><polygon points="66,34 78,40 68,44" fill="'+band+'"/>';
  // Neural halo: a band with an implant node at each temple and a thin lit ring
  // floating above. The ring is drawn in the chosen outfit colour so the
  // headwear still answers to its swatch; only the nodes are neon.
  return '<path d="M29,36 C40,31 60,31 71,36 L71,41 C60,36 40,36 29,41 Z" fill="'+trShade(oc,-0.3)+'"/>'
       + '<g'+_trGlow(TR_NEON,2)+'><circle cx="31" cy="39" r="2.6" fill="'+TR_NEON+'"/><circle cx="69" cy="39" r="2.6" fill="'+TR_NEON+'"/></g>'
       + '<g'+_trGlow(oc,2)+'><ellipse cx="50" cy="15" rx="21" ry="5" fill="none" stroke="'+trShade(oc,0.3)+'" stroke-width="1.6" opacity="0.95"/></g>'
       + '<line x1="31" y1="37" x2="34" y2="20" stroke="'+trShade(oc,-0.1)+'" stroke-width="1.2" opacity="0.8"/>';
}
function _trAcc(ai){
  if(ai===0) return '';
  if(ai===1) return '<g fill="none" stroke="#2b2b31" stroke-width="2"><rect x="34" y="40" width="12" height="8" rx="2"/><rect x="54" y="40" width="12" height="8" rx="2"/><line x1="46" y1="44" x2="54" y2="44"/></g>';
  if(ai===2) return '<g fill="none" stroke="#2b2b31" stroke-width="2"><circle cx="40" cy="44" r="5.5"/><circle cx="60" cy="44" r="5.5"/><line x1="45.5" y1="44" x2="54.5" y2="44"/></g>';
  if(ai===3) return '<g fill="#d3a33f"><circle cx="32" cy="52" r="2.4"/><circle cx="68" cy="52" r="2.4"/></g>';
  if(ai===4) return '<path d="M36,48 C40,62 60,62 64,48 C60,52 40,52 36,48 Z" fill="#dfe4ea"/><path d="M36,48 L30,45 M64,48 L70,45" stroke="#c2c8d0" stroke-width="1.6"/>';
  // AR visor: one translucent bar over both eyes, a temple arm to each ear, and
  // a readout tick at the right edge. Semi-transparent on purpose -- a solid
  // bar hides the face it is supposed to sit on, including lit eyes.
  return '<g'+_trGlow(TR_NEON,2.5)+'>'
       + '<path d="M30,39 L70,39 C71,46 66,50 50,50 C34,50 29,46 30,39 Z" fill="'+TR_NEON+'" opacity="0.26"/>'
       + '<path d="M30,39 L70,39 C71,46 66,50 50,50 C34,50 29,46 30,39 Z" fill="none" stroke="'+TR_NEON+'" stroke-width="1.5"/>'
       + '</g>'
       + '<g stroke="'+trShade(TR_NEON,-0.45)+'" stroke-width="2" stroke-linecap="round"><line x1="30" y1="41" x2="26" y2="44"/><line x1="70" y1="41" x2="74" y2="44"/></g>'
       + '<g fill="'+TR_NEON2+'"'+_trGlow(TR_NEON2,1.5)+'><rect x="62" y="42" width="5" height="1.4" rx="0.7"/><rect x="62" y="45" width="3" height="1.4" rx="0.7"/></g>';
}
// trainerSVG(spec, px, opts) -> self-contained <svg> string. Idle bob only when
// not in calm mode (opts.animate overrides). Numbers only via trv() -> XSS-safe.
function trainerSVG(spec, px, opts){
  px=px||64; opts=opts||{};
  var si=trv(spec,TR.SKIN),hi=trv(spec,TR.HAIR),hc=trv(spec,TR.HAIRC),of=trv(spec,TR.OUTFIT),
      oc=trv(spec,TR.OUTC),ht=trv(spec,TR.HAT),ac=trv(spec,TR.ACC),bg=trv(spec,TR.BG),fa=trv(spec,TR.FACE);
  var skin=TR_SKIN[si],skinSh=trShade(skin,-0.16),hair=TR_HAIRC[hc],
      outfit=TR_OUTC[of],outfitSh=trShade(outfit,-0.2),outfitHl=trShade(outfit,0.16),hatCol=TR_OUTC[oc];
  var b=_trBg(bg);
  b+='<path d="M10,100 C10,80 26,71 50,71 C74,71 90,80 90,100 Z" fill="'+outfit+'"/>';
  // Techwear is its own branch rather than another `of%3` pattern: the asymmetric
  // zip and the lit trim are the whole look, and modulo would have given it the
  // plain chevron (8 % 3 === 2).
  if(of===8){
    b+='<path d="M44,71 L54,72 L52,100 L46,100 Z" fill="'+outfitSh+'"/>';
    b+='<g'+_trGlow(TR_NEON,1.5)+' stroke="'+TR_NEON+'" stroke-width="1.1" fill="none" opacity="0.9">';
    b+='<path d="M32,86 L40,86 L44,80"/><path d="M68,86 L60,86 L56,80"/><path d="M26,96 L34,96"/><path d="M74,96 L66,96"/>';
    b+='</g>';
    b+='<g fill="'+TR_NEON2+'"'+_trGlow(TR_NEON2,1.5)+'><circle cx="40" cy="86" r="1.5"/><circle cx="60" cy="86" r="1.5"/></g>';
    b+='<path d="M50,71 C60,71 66,74 68,78 L62,80 C60,76 56,74 50,74 Z" fill="'+outfitHl+'" opacity="0.5"/>';
  }
  else if(of%3===0) b+='<path d="M40,72 L50,84 L60,72 L56,71 L50,79 L44,71 Z" fill="'+outfitSh+'"/>';
  else if(of%3===1) b+='<rect x="38" y="72" width="24" height="6" rx="3" fill="'+outfitHl+'" opacity="0.7"/>';
  else b+='<path d="M42,72 L50,80 L58,72" fill="none" stroke="'+outfitSh+'" stroke-width="2.5"/>';
  b+='<path d="M50,71 C74,71 90,80 90,100 L70,100 C70,84 62,76 50,74 Z" fill="'+outfitSh+'" opacity="0.35"/>';
  b+=_trHairBack(hi,hair);
  b+='<rect x="43" y="60" width="14" height="15" rx="5" fill="'+skin+'"/><rect x="43" y="60" width="14" height="5" rx="2.5" fill="'+skinSh+'" opacity="0.6"/>';
  if(ht!==5) b+='<ellipse cx="32.5" cy="46" rx="3.4" ry="5" fill="'+skin+'"/><ellipse cx="67.5" cy="46" rx="3.4" ry="5" fill="'+skin+'"/>';
  b+='<ellipse cx="50" cy="44" rx="18" ry="20" fill="'+skin+'"/>';
  b+='<path d="M50,24 C61,24 68,33 68,44 C68,55 61,64 50,64 C58,58 60,52 60,44 C60,36 58,30 50,24 Z" fill="'+skinSh+'" opacity="0.22"/>';
  b+=_trFace(fa,skin); b+=_trHairFront(hi,hair); b+=_trAcc(ac); b+=_trHat(ht,hatCol);
  var animate = (opts.animate!=null)?opts.animate:!calmMode();
  var g = animate ? ('<g>'+b+'<animateTransform attributeName="transform" type="translate" values="0 0;0 -1.4;0 0" dur="3.6s" repeatCount="indefinite"/></g>') : b;
  var title = opts.title ? ('<title>'+esc(opts.title)+'</title>') : '';
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="'+(px|0)+'" height="'+(px|0)+'" role="img" class="trainer-svg" aria-hidden="'+(opts.title?'false':'true')+'">'+title+g+'</svg>';
}
// Stable, NON-TRANSCRIPT identity for the default avatar: Arena handle -> a saved
// label -> "guest". NEVER a session id/title/path/prompt.
function stableTrainerKey(){
  try{ if(ARENA && ARENA.you && (ARENA.you.handle||ARENA.you.userId)) return String(ARENA.you.handle||ARENA.you.userId); }catch(e){}
  try{ var d=localStorage.getItem("hq_trainer_key"); if(d) return d; }catch(e){}
  return "guest";
}
function defaultTrainerSpec(key){
  var r=mulberry32(hashStr("trainer:"+(key||stableTrainerKey())));
  var s=[]; for(var i=0;i<TR_MAX.length;i++) s.push(Math.floor(r()*(TR_MAX[i]+1))); return s;
}
function _validTrainerSpec(a){ if(!a||a.length!==9) return false; for(var i=0;i<9;i++){ if(typeof a[i]!=="number"||a[i]!==(a[i]|0)) return false; } return true; }
// The spec to render for THIS user: saved config -> validated localStorage mirror
// (instant boot) -> auto-derived default. Callers pass this into trainerSVG().
function resolveTrainerSpec(){
  if(CONFIG && _validTrainerSpec(CONFIG.trainerAvatar)) return CONFIG.trainerAvatar;
  try{ var m=JSON.parse(localStorage.getItem("hq_trainer")||"null"); if(_validTrainerSpec(m)) return m; }catch(e){}
  return defaultTrainerSpec(stableTrainerKey());
}

function monsterSVG(seed, hue, stage, shiny, px){
  stage=Math.max(0,Math.min(4,stage|0)); px=px||46;
  var body="hsl("+hue+",68%,52%)", dark="hsl("+hue+",60%,32%)", belly="hsl("+hue+",70%,68%)";
  var parts=[];
  function rect(x,y,w,h,fill,extra){ parts.push('<rect x="'+x+'" y="'+y+'" width="'+w+'" height="'+h+'" fill="'+fill+'"'+(extra||"")+'/>'); }
  if(stage===0){
    // EGG: oval shell + a few speckles, no body cells
    var e=mulberry32(seed);
    parts.push('<ellipse cx="5" cy="5.4" rx="2.9" ry="3.4" fill="'+body+'" stroke="'+dark+'" stroke-width="0.5"/>');
    parts.push('<ellipse cx="5" cy="6.6" rx="2.55" ry="2.1" fill="'+belly+'" opacity="0.55"/>');
    for(var i=0;i<5;i++){
      var sx=(3.1+e()*3.8).toFixed(2), sy=(3.2+e()*3.9).toFixed(2), sr=(0.26+e()*0.22).toFixed(2);
      parts.push('<circle cx="'+sx+'" cy="'+sy+'" r="'+sr+'" fill="'+dark+'" opacity="0.5"/>');
    }
  } else {
    var rng=mulberry32(seed);
    var rTop = stage>=2?1:2;            // bigger silhouette at higher stages
    var rBot = stage===1?7:8;
    var dens = stage===1?0.82:(stage===2?0.96:1.08);
    var grid=[]; for(var r=0;r<10;r++){ grid.push([false,false,false,false,false,false,false,false,false,false]); }
    for(var r=rTop;r<=rBot;r++){
      for(var c=1;c<=4;c++){
        var p = c>=3?0.62:(c===2?0.46:0.30);       // higher near vertical center, lower at edges
        p*=dens; if(r>=3&&r<=6) p+=0.10;
        var on = rng()<p;
        if(c===4 && r>=3 && r<=6) on=true;         // solid central body core
        grid[r][c]=on; grid[r][9-c]=on;            // mirror cols 1..4 -> 8..5
      }
    }
    // guarantee cells under the face so eyes/mouth read as a creature
    grid[3][3]=grid[3][6]=true; grid[5][4]=grid[5][5]=true;
    // dark outline underlay, then body fill
    for(var r=0;r<10;r++) for(var c=0;c<10;c++) if(grid[r][c]) rect(c-0.08,r-0.08,1.16,1.16,dark);
    for(var r=0;r<10;r++) for(var c=0;c<10;c++) if(grid[r][c]) rect(c,r,1,1,body);
    // lighter belly on the lower-center cells
    for(var r=6;r<=7;r++) for(var c=4;c<=5;c++) if(grid[r][c]) rect(c+0.12,r+0.06,0.76,0.88,belly);
    // stage 4: little crown/horns on top
    if(stage>=4){
      [4,5].forEach(function(c){ rect(c,0,1,1,dark); rect(c+0.12,0.12,0.76,0.86,"#f0c74a"); });
      rect(3.15,0.35,0.7,0.65,"#f0c74a"); rect(6.15,0.35,0.7,0.65,"#f0c74a");
    }
    // FACE — two eyes (row 3, cols 3 & 6) + a mouth cell (center, row 5)
    function eye(c){ rect(c+0.08,3.05,0.84,0.9,"#ffffff"); rect(c+0.34,3.36,0.36,0.44,"#1a1c28"); }
    eye(3); eye(6);
    rect(4.2,5.15,1.6,0.55,dark,' rx="0.18"');
  }
  var glow = (shiny||stage>=4) ? '<ellipse cx="5" cy="5" rx="5" ry="5" fill="hsl(48,90%,60%)" opacity="'+(shiny?0.15:0.10)+'"/>' : '';
  var sparkle = shiny ? '<text x="8.3" y="2.3" font-size="2.6" fill="#f0c74a" text-anchor="middle" font-family="serif">✦</text>' : '';
  return '<svg class="mon-svg" width="'+px+'" height="'+px+'" viewBox="0 0 10 10" '+
    'style="shape-rendering:crispEdges" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">'+
    glow+parts.join("")+sparkle+'</svg>';
}
// Type badge markup coloured by typeHue.
function typeBadgeHTML(cr){
  // A Mega form shows its own (often dual) typing, e.g. Mega Charizard X = Fire / Dragon.
  var mf=isPokePack()&&pokeMegaForm(cr), ts=mf&&mf.types;
  if(ts&&ts.length){ var hs=ts.map(function(t){ var h=POKE_TYPE_HUE[t]; return h!=null?h:creatureTypeHue(cr); });
    var bg=hs.length>1 ? 'linear-gradient(90deg,hsl('+hs[0]+',60%,45%),hsl('+hs[1]+',60%,45%))' : 'hsl('+hs[0]+',60%,45%)';
    return '<span class="typebadge" style="background:'+bg+'">'+esc(ts.join(" / "))+'</span>'; }
  return '<span class="typebadge" style="background:hsl('+creatureTypeHue(cr)+',60%,45%)">'+esc(creatureType(cr))+'</span>'; }
// Evolve progress bar + next-stage label.
// Progress toward the next VISIBLE evolution for the pokemon packs. The 5 internal growth
// stages (0..4) don't map 1:1 to a line's 2-3 forms — some forms span two stages (e.g.
// Gabite occupies two stages of Gible→Gabite→Garchomp). Measuring progress per-internal-
// stage makes the bar reset to 0% when the form DOESN'T change, which reads as lost
// progress. Instead, aggregate the stages that map to the current form so the bar climbs
// monotonically until the creature actually evolves. Uses EFFECTIVE growth (this session's raw
// growth floored by the species' persisted high-water) so progress carries across sessions of
// the same species instead of resetting to 0%, and always tracks the floored sprite form.
function pokeFormProgress(cr){
  var effG=effectiveGrowthOf(cr);
  var rawStage=Math.max(0,Math.min(4,Math.floor(effG)));            // effective (floored) stage
  var effPct=(rawStage>=4)?1:(effG-rawStage);                        // within-stage fraction 0..1
  var raw=Object.assign({},cr,{_noFloor:true, stage:rawStage});
  var line=pokeEvoLine(raw), curPos=pokeEvoPos(raw,line);
  if(curPos>=line.length-1){                                         // at the final line form
    // If it still Mega-evolves at Apex (stage 4), keep the meter climbing toward that.
    if(cfg().creaturePack==="pokemon3d" && pokeCanMega(raw) && rawStage<4){
      var fStart=null; for(var s2=0;s2<=4;s2++){ if(Math.round((s2/4)*(line.length-1))===curPos){ fStart=s2; break; } }
      if(fStart===null) fStart=rawStage;
      var mspan=Math.max(1, 4-fStart), mdone=(rawStage-fStart)+effPct;
      var mf=pokeMegaForm(Object.assign({},raw,{stage:4}));
      return {pct:Math.max(0,Math.min(100,Math.round(mdone/mspan*100))), next:(mf&&mf.name)||"Mega form", mega:true};
    }
    return {pct:100, next:null};
  }
  var formStart=null, nextFormStage=null;
  for(var st=0; st<=4; st++){ var p=Math.round((st/4)*(line.length-1));
    if(p===curPos && formStart===null) formStart=st;
    if(p===curPos+1){ nextFormStage=st; break; } }
  if(formStart===null) formStart=rawStage;
  if(nextFormStage===null) return {pct:100, next:null};
  var span=Math.max(1, nextFormStage-formStart);
  var done=(rawStage-formStart)+effPct;                              // stages cleared + within-stage
  var nextName = (curPos+1===line.length-1) ? branchFinalName(cr) : (DEX_NAMES[line[curPos+1]]||null); // honor chosen branch on last hop
  return {pct:Math.max(0,Math.min(100,Math.round(done/span*100))), next:nextName};
}
function evobarHTML(cr){
  cr=cr||{};
  var pct, next, mega=false;
  if(isPokePack()){ var fp=pokeFormProgress(cr); pct=fp.pct; next=fp.next; mega=!!fp.mega; }
  else {
    // non-poke packs: each stage IS a visible change, so per-stage progress is correct.
    // Use EFFECTIVE growth so progress persists across sessions of the same species.
    var effG=effectiveGrowthOf(cr), effStage=Math.max(0,Math.min(4,Math.floor(effG)));
    var raw=Object.assign({},cr,{_noFloor:true, stage:effStage});
    next=creatureNextStageName(raw); pct=(effStage>=4)?100:Math.round((effG-effStage)*100);
  }
  return '<div class="evobar'+(mega?' mega':'')+'"><span style="width:'+pct+'%"></span></div>'+
    (next ? '<div class="evonext">'+pct+'% '+(mega?'⚡':'→')+' '+esc(next)+'</div>' : '<div class="evonext">Fully evolved</div>');
}
// The one place that decides sprite vs emoji. Used everywhere a creature is shown.
// pack "monsters" (default) -> generated SVG; "pokemon"/"animals"/"faces" -> emoji.
// bg=true tints the box for emoji packs (matches the pre-v6 look); sprites are transparent.
/* ---- pokemon pack: real ANIMATED sprites from the public PokeAPI sprite repo ----
   Privacy-safe: the only thing leaving the machine is a Pokedex number (no transcript
   data). Needs internet; falls back to a static sprite, then to the generated monster
   sprite when offline. 48 species, all <=649 so the Gen-5 animated sprites exist. */
// Served via jsDelivr's CDN mirror of the PokeAPI sprites repo — same assets, but a
// real CDN that ad/content blockers (e.g. Opera GX) don't block like raw.githubusercontent.com.
var POKE_ANIM="https://cdn.jsdelivr.net/gh/PokeAPI/sprites@master/sprites/pokemon/versions/generation-v/black-white/animated/";
var POKE_STATIC="https://cdn.jsdelivr.net/gh/PokeAPI/sprites@master/sprites/pokemon/";
var PKPARAISO_SWSH="https://www.pkparaiso.com/imagenes/espada_escudo/sprites/animados/"; // Gen 8 animated 3D (shiny: <name>-s.gif)
// Gen 6 X/Y animated 3D — near-full National Dex coverage, used as the animated fallback
// for 'mon that SwSh (Galar dex) dropped, so nearly everything stays ANIMATED.
var PKPARAISO_XY="https://www.pkparaiso.com/imagenes/xy/sprites/animados/";
var PKPARAISO_XY_SHINY="https://www.pkparaiso.com/imagenes/xy/sprites/animados-shiny/";
// ORAS (Omega Ruby/Alpha Sapphire) animated gallery — where the 6 ORAS-era Mega
// Evolutions (Pidgeot/Slowbro/Sceptile/Swampert/Salamence/Metagross) live; they are
// NOT in the X/Y dir. Shiny lives in the sibling animados-shiny/ dir.
var PKPARAISO_ORAS="https://www.pkparaiso.com/imagenes/rubi-omega-zafiro-alfa/sprites/animados/";
var PKPARAISO_ORAS_SHINY="https://www.pkparaiso.com/imagenes/rubi-omega-zafiro-alfa/sprites/animados-shiny/";
var POKE_DEX=[25,4,7,1,133,94,143,149,448,282,155,158,152,403,130,319,37,39,54,445,248,59,633,150,212,208,468,359,306,15,334,460,18,65,214,323,610,80,310,181,115,142,229,254,257,260,373,376];
var POKE_REAL=["Pikachu","Charmander","Squirtle","Bulbasaur","Eevee","Gengar","Snorlax","Dragonite","Lucario","Gardevoir","Cyndaquil","Totodile","Chikorita","Shinx","Gyarados","Sharpedo","Vulpix","Jigglypuff","Psyduck","Garchomp","Tyranitar","Arcanine","Deino","Mewtwo","Scizor","Steelix","Togekiss","Absol","Aggron","Beedrill","Altaria","Abomasnow","Pidgeot","Alakazam","Heracross","Camerupt","Axew","Slowbro","Manectric","Ampharos","Kangaskhan","Aerodactyl","Houndoom","Sceptile","Blaziken","Swampert","Salamence","Metagross"];
// Real evolution LINES (base -> final), index-aligned with the 48 species. The sprite
// shown evolves along the line as the session grows (by evolution stage).
var POKE_EVO=[[172,25,26],[4,5,6],[7,8,9],[1,2,3],[133,134],[92,93,94],[446,143],[147,148,149],[447,448],[280,281,282],[155,156,157],[158,159,160],[152,153,154],[403,404,405],[129,130],[318,319],[37,38],[174,39,40],[54,55],[443,444,445],[246,247,248],[58,59],[633,634,635],[150],[123,212],[95,208],[175,176,468],[359],[304,305,306],[13,14,15],[333,334],[459,460],[16,17,18],[63,64,65],[214],[322,323],[610,611,612],[79,80],[309,310],[179,180,181],[115],[142],[228,229],[252,253,254],[255,256,257],[258,259,260],[371,372,373],[374,375,376]];
var DEX_NAMES={172:"Pichu",25:"Pikachu",26:"Raichu",4:"Charmander",5:"Charmeleon",6:"Charizard",7:"Squirtle",8:"Wartortle",9:"Blastoise",1:"Bulbasaur",2:"Ivysaur",3:"Venusaur",133:"Eevee",134:"Vaporeon",92:"Gastly",93:"Haunter",94:"Gengar",446:"Munchlax",143:"Snorlax",147:"Dratini",148:"Dragonair",149:"Dragonite",447:"Riolu",448:"Lucario",280:"Ralts",281:"Kirlia",282:"Gardevoir",197:"Umbreon",129:"Magikarp",130:"Gyarados",131:"Lapras",37:"Vulpix",38:"Ninetales",174:"Igglybuff",39:"Jigglypuff",40:"Wigglytuff",54:"Psyduck",55:"Golduck",443:"Gible",444:"Gabite",445:"Garchomp",246:"Larvitar",247:"Pupitar",248:"Tyranitar",58:"Growlithe",59:"Arcanine",123:"Scyther",212:"Scizor",27:"Sandshrew",28:"Sandslash",175:"Togepi",176:"Togetic",468:"Togekiss",215:"Sneasel",461:"Weavile",304:"Aron",305:"Lairon",306:"Aggron",41:"Zubat",42:"Golbat",169:"Crobat",328:"Trapinch",329:"Vibrava",330:"Flygon",220:"Swinub",221:"Piloswine",473:"Mamoswine",16:"Pidgey",17:"Pidgeotto",18:"Pidgeot",63:"Abra",64:"Kadabra",65:"Alakazam",66:"Machop",67:"Machoke",68:"Machamp",74:"Geodude",75:"Graveler",76:"Golem",79:"Slowpoke",80:"Slowbro",239:"Elekid",125:"Electabuzz",466:"Electivire",128:"Tauros",142:"Aerodactyl",196:"Espeon",252:"Treecko",253:"Grovyle",254:"Sceptile",255:"Torchic",256:"Combusken",257:"Blaziken",258:"Mudkip",259:"Marshtomp",260:"Swampert",371:"Bagon",372:"Shelgon",373:"Salamence",374:"Beldum",375:"Metang",376:"Metagross",151:"Mew",
155:"Cyndaquil",156:"Quilava",157:"Typhlosion",158:"Totodile",159:"Croconaw",160:"Feraligatr",
152:"Chikorita",153:"Bayleef",154:"Meganium",403:"Shinx",404:"Luxio",405:"Luxray",
633:"Deino",634:"Zweilous",635:"Hydreigon",610:"Axew",611:"Fraxure",612:"Haxorus",
81:"Magnemite",82:"Magneton",462:"Magnezone",636:"Larvesta",637:"Volcarona",
135:"Jolteon",136:"Flareon",470:"Leafeon",471:"Glaceon",700:"Sylveon",475:"Gallade",199:"Slowking",150:"Mewtwo",318:"Carvanha",319:"Sharpedo",115:"Kangaskhan",95:"Onix",208:"Steelix",359:"Absol",13:"Weedle",14:"Kakuna",15:"Beedrill",333:"Swablu",334:"Altaria",459:"Snover",460:"Abomasnow",214:"Heracross",322:"Numel",323:"Camerupt",309:"Electrike",310:"Manectric",179:"Mareep",180:"Flaaffy",181:"Ampharos",228:"Houndour",229:"Houndoom"};
// ---- Choosable branching evolutions + Mega forms ----
// POKE_BRANCH: species index -> selectable FINAL forms. Element [0] MUST equal the current
// POKE_EVO final (canonical/back-compat). A per-session choice (EVO_CHOICE) or a deterministic
// sessionId-hash default picks which one a creature becomes at Apex. Only the FINAL position of
// the line is affected; mid-line forms (Eevee, Kirlia, Slowpoke) are unchanged.
var POKE_BRANCH={
  4:[{name:"Vaporeon",dex:134},{name:"Jolteon",dex:135},{name:"Flareon",dex:136},{name:"Espeon",dex:196},{name:"Umbreon",dex:197},{name:"Leafeon",dex:470},{name:"Glaceon",dex:471},{name:"Sylveon",dex:700}], // Eevee
  9:[{name:"Gardevoir",dex:282},{name:"Gallade",dex:475}],   // Ralts/Kirlia line
  37:[{name:"Slowbro",dex:80},{name:"Slowking",dex:199}]      // Slowpoke line
};
// MEGA_FORMS: keyed by FINAL-FORM DEX (not species index) so mega availability follows the
// chosen branch automatically (Gallade 475 / Slowking 199 have no entry -> no mega). Each form
// carries its source dir because ORAS-era megas live in a different PkParaiso gallery.
var MEGA_FORMS={
  6:[{name:"Mega Charizard X",slug:"charizard-megax",dir:"xy",types:["Fire", "Dragon"]},{name:"Mega Charizard Y",slug:"charizard-megay",dir:"xy",types:["Fire", "Flying"]}],
  9:[{name:"Mega Blastoise",slug:"blastoise-mega",dir:"xy",types:["Water"]}], 3:[{name:"Mega Venusaur",slug:"venusaur-mega",dir:"xy",types:["Grass", "Poison"]}],
  94:[{name:"Mega Gengar",slug:"gengar-mega",dir:"xy",types:["Ghost", "Poison"]}], 448:[{name:"Mega Lucario",slug:"lucario-mega",dir:"xy",types:["Fighting", "Steel"]}],
  282:[{name:"Mega Gardevoir",slug:"gardevoir-mega",dir:"xy",types:["Psychic", "Fairy"]}], 475:[{name:"Mega Gallade",slug:"gallade-mega",dir:"oras",types:["Psychic", "Fighting"]}],
  130:[{name:"Mega Gyarados",slug:"gyarados-mega",dir:"xy",types:["Water", "Dark"]}],
  445:[{name:"Mega Garchomp",slug:"garchomp-mega",dir:"xy",types:["Dragon", "Ground"]}], 248:[{name:"Mega Tyranitar",slug:"tyranitar-mega",dir:"xy",types:["Rock", "Dark"]}],
  212:[{name:"Mega Scizor",slug:"scizor-mega",dir:"xy",types:["Bug", "Steel"]}], 306:[{name:"Mega Aggron",slug:"aggron-mega",dir:"xy",types:["Steel"]}],
  65:[{name:"Mega Alakazam",slug:"alakazam-mega",dir:"xy",types:["Psychic"]}], 142:[{name:"Mega Aerodactyl",slug:"aerodactyl-mega",dir:"xy",types:["Rock", "Flying"]}],
  257:[{name:"Mega Blaziken",slug:"blaziken-mega",dir:"xy",types:["Fire", "Fighting"]}],
  18:[{name:"Mega Pidgeot",slug:"pidgeot-mega",dir:"oras",types:["Normal", "Flying"]}], 80:[{name:"Mega Slowbro",slug:"slowbro-mega",dir:"oras",types:["Water", "Psychic"]}],
  254:[{name:"Mega Sceptile",slug:"sceptile-mega",dir:"oras",types:["Grass", "Dragon"]}], 260:[{name:"Mega Swampert",slug:"swampert-mega",dir:"oras",types:["Water", "Ground"]}],
  373:[{name:"Mega Salamence",slug:"salamence-mega",dir:"oras",types:["Dragon", "Flying"]}], 376:[{name:"Mega Metagross",slug:"metagross-mega",dir:"oras",types:["Steel", "Psychic"]}],
  150:[{name:"Mega Mewtwo X",slug:"mewtwo-megax",dir:"xy",types:["Psychic", "Fighting"]},{name:"Mega Mewtwo Y",slug:"mewtwo-megay",dir:"xy",types:["Psychic"]}],
  319:[{name:"Mega Sharpedo",slug:"sharpedo-mega",dir:"oras",types:["Water", "Dark"]}],
  115:[{name:"Mega Kangaskhan",slug:"kangaskhan-mega",dir:"xy",types:["Normal"]}],
  208:[{name:"Mega Steelix",slug:"steelix-mega",dir:"oras",types:["Steel", "Ground"]}],
  359:[{name:"Mega Absol",slug:"absol-mega",dir:"xy",types:["Dark"]}],
  15:[{name:"Mega Beedrill",slug:"beedrill-mega",dir:"oras",types:["Bug", "Poison"]}],
  334:[{name:"Mega Altaria",slug:"altaria-mega",dir:"oras",types:["Dragon", "Fairy"]}],
  460:[{name:"Mega Abomasnow",slug:"abomasnow-mega",dir:"xy",types:["Grass", "Ice"]}],
  214:[{name:"Mega Heracross",slug:"heracross-mega",dir:"xy",types:["Bug", "Fighting"]}],
  323:[{name:"Mega Camerupt",slug:"camerupt-mega",dir:"oras",types:["Fire", "Ground"]}],
  310:[{name:"Mega Manectric",slug:"manectric-mega",dir:"xy",types:["Electric"]}],
  181:[{name:"Mega Ampharos",slug:"ampharos-mega",dir:"xy",types:["Electric", "Dragon"]}],
  229:[{name:"Mega Houndoom",slug:"houndoom-mega",dir:"xy",types:["Dark", "Fire"]}]
};
// Per-session evolution choice, keyed by sessionId: { branchDex, megaSlug }. Separate localStorage
// key from hq_dex_max (New Game+ floor) — the two are orthogonal and both persist.
var EVO_CHOICE=(function(){ try{ return JSON.parse(localStorage.getItem("hq_evo_choice")||"{}"); }catch(e){ return {}; } })();
function pokeIdx(cr){ cr=cr||{}; var i=(cr.species!=null)?(cr.species|0):creatureIndex(cr); return ((i%48)+48)%48; }
function evoChoice(cr){ var sid=cr&&cr._sid; return (sid&&EVO_CHOICE[sid])||null; }
function branchDefault(cr,opts){ return opts[ hashStr(cr&&cr._sid||"")%opts.length ]; } // deterministic by sessionId
// The chosen (or default) FINAL dex for this creature's line.
function branchFinalDex(cr){
  var opts=POKE_BRANCH[pokeIdx(cr)];
  if(!opts){ var ln=pokeEvoLine(cr); return ln[ln.length-1]; }
  var ch=evoChoice(cr), d=(ch&&ch.branchDex!=null)?ch.branchDex:branchDefault(cr,opts).dex;
  return opts.some(function(o){return o.dex===d;}) ? d : opts[0].dex;
}
function branchFinalName(cr){ return DEX_NAMES[branchFinalDex(cr)]||POKE_REAL[pokeIdx(cr)]; }
// The active Mega FORM object (or null): 3D pack only, Apex only, follows chosen branch + X/Y toggle.
function pokeMegaForm(cr){
  if(cfg().creaturePack!=="pokemon3d" || creatureStage(cr)<4) return null;
  var fs=MEGA_FORMS[branchFinalDex(cr)]; if(!fs||!fs.length) return null;
  if(fs.length>1){ var ch=evoChoice(cr);
    var f=ch&&ch.megaSlug&&fs.filter(function(x){return x.slug===ch.megaSlug;})[0];
    return f||fs[ hashStr(cr&&cr._sid||"")%fs.length ]; }
  return fs[0];
}
function pokeMega(cr){ return (pokeMegaForm(cr)||{}).slug||null; }
function pokeCanMega(cr){ var fs=MEGA_FORMS[branchFinalDex(cr)]; return !!(fs&&fs.length); }
// True when this species offers a user choice (a branch, or >1 mega on its chosen final).
function pokeHasChoice(cr){ if(POKE_BRANCH[pokeIdx(cr)]) return true;
  var fs=MEGA_FORMS[branchFinalDex(cr)]; return !!(fs&&fs.length>1); }
function pokeEvoLine(cr){ return POKE_EVO[pokeIdx(cr)] || [POKE_DEX[pokeIdx(cr)]]; }
// map evolution stage (0..4) to a position along the line
function pokeEvoPos(cr, line){ line=line||pokeEvoLine(cr);
  return Math.max(0, Math.min(line.length-1, Math.round((creatureStage(cr)/4)*(line.length-1)))); }
function pokeDexFor(cr){ var line=pokeEvoLine(cr), pos=pokeEvoPos(cr,line);
  return pos===line.length-1 ? branchFinalDex(cr) : line[pos]; }   // final position honors the chosen branch
function pokeCurrentName(cr){ var n=DEX_NAMES[pokeDexFor(cr)] || POKE_REAL[pokeIdx(cr)], mf=pokeMegaForm(cr); return mf ? (mf.name||("Mega "+n)) : n; }  // keeps X/Y suffix
// name of the NEXT form in the line, or null if already final (branch-aware for the last hop)
function pokeNextName(cr){ var line=pokeEvoLine(cr); var p=pokeEvoPos(cr,line);
  if(p>=line.length-1) return null;
  return (p+1===line.length-1) ? branchFinalName(cr) : (DEX_NAMES[line[p+1]] || null); }
// Build an <img> for a specific dex number (dex + shiny explicit). Live cards pass the
// evolved form; the Pokédex passes the canonical species dex so its catalog is stable.
function pokeImgFor(dex, cr, px, altName){
  cr=cr||{}; var seed=creatureSeed(cr), hue=creatureTypeHue(cr),
      stage=creatureStage(cr), shiny=cr.shiny?1:0;
  var sub = shiny ? "shiny/" : "";
  var fb=encodeURIComponent(JSON.stringify([seed,hue,stage,shiny,px]));
  // 3D pack: ANIMATED 3D models. Prefer Gen 8 (Sword/Shield), fall back to Gen 6 (X/Y)
  // for 'mon not in the Galar dex, then Gen-5 static, then the generated monster sprite.
  if(cfg().creaturePack==="pokemon3d"){
    var mf = (stage>=4) ? pokeMegaForm(cr) : null;   // branch-aware mega form (or null)
    var mega = mf ? mf.slug : null;
    var slug = mega || String(altName||"").toLowerCase().replace(/[^a-z0-9]/g,"");
    // Lead with the Gen-6 X/Y animated 3D sprite. Every base species here is <=649, so X/Y
    // has ALL of them — the first request succeeds, so we never paint the SwSh 404 flicker.
    // ORAS-era megas (mf.dir==="oras") live in a separate gallery; X/Y shiny + ORAS shiny each
    // have their own animados-shiny dir. Fallback: gif -> HOME still png -> monster svg.
    var base = mega
      ? (mf.dir==="oras" ? (shiny?PKPARAISO_ORAS_SHINY:PKPARAISO_ORAS) : (shiny?PKPARAISO_XY_SHINY:PKPARAISO_XY))
      : (shiny ? PKPARAISO_XY_SHINY : PKPARAISO_XY);
    var src0 = base + slug + ".gif";
    return '<img class="pokeimg pokeimg-3d'+(mega?" pokeimg-mega":"")+'" src="'+src0+'" width="'+px+'" height="'+px+'"'+
      ' alt="'+esc(altName||"")+(shiny?" (shiny)":"")+'" data-dex="'+dex+'" data-shiny="'+shiny+'"'+
      ' data-3d="1" data-mega="'+(mega?1:0)+'" data-slug="'+slug+'" data-try="0" data-fb="'+fb+'" decoding="async" onerror="pokeErr(this)" loading="lazy">';
  }
  return '<img class="pokeimg" src="'+POKE_ANIM+sub+dex+'.gif" width="'+px+'" height="'+px+'"'+
    ' alt="'+esc(altName||"")+(shiny?" (shiny)":"")+'" data-dex="'+dex+'" data-shiny="'+shiny+'"'+
    ' data-try="0" data-fb="'+fb+'" decoding="async" onerror="pokeErr(this)" loading="lazy">';
}
function pokeImgHTML(cr, px){ return pokeImgFor(pokeDexFor(cr), cr, px, pokeCurrentName(cr)); }
// onerror chains. 3D pack: SwSh gif -> X/Y gif -> gen5 static png -> monster svg.
// gen5 pack: animated gif -> static png -> monster svg.
function pokeErr(img){
  var t=+(img.getAttribute("data-try")||0);
  var shiny = img.getAttribute("data-shiny")==="1";
  var sub = shiny ? "shiny/" : "";
  var dex = img.getAttribute("data-dex");
  if(img.getAttribute("data-3d")==="1"){
    // primary is now the X/Y(Gen6) animated gif, so on failure go straight to the HOME
    // still png, then the generated monster svg. (SwSh added no coverage for species<=649.)
    if(t===0){ img.setAttribute("data-try","1"); img.src=POKE_STATIC+"other/home/"+(shiny?"shiny/":"")+dex+".png"; return; }
  } else if(t===0){
    img.setAttribute("data-try","1"); img.src=POKE_STATIC+sub+dex+".png"; return;
  }
  try{ var a=JSON.parse(decodeURIComponent(img.getAttribute("data-fb")));
       img.outerHTML=monsterSVG(a[0],a[1],a[2],!!a[3],a[4]); }
  catch(e){ img.style.display="none"; }
}

/* ---- "aniimo" pack: creatures from the game Aniimo (static art via AniimoTools,
   a fan DB). No animated assets exist for Aniimo, so we give them motion with a CSS
   "breathe" animation. Hotlinked (not bundled); falls back to the monster sprite. */
var ANIMO_BASE="https://aniimotools.dev/assets/creatures/thumb/";
var ANIMO_NAMES=["emberpup","flameruff","scorchhowl","inferlupa","celestis","stellarys","chirpi","tromber","cornet","tubster","iris","irisal","skippy","pranky","glacy","leafy","nimbi","turbo","dreaple","hummin","witchin","tuckin","budclaw","shrubclaw","geoclaw","sparki","flamerion","flutternym","gracewing","somniwing","eko","eklue","budsquire","thornblade","melloblum","pomegg","pomawk","dewy","fragrancier","wisptis","ignitis","bonesky","fenrier","glynsera","bolty","blazen","squarrel","squashel"];
function animoName(cr){ return ANIMO_NAMES[pokeIdx(cr)] || "emberpup"; }
function animoLabel(cr){ var n=animoName(cr); return n.charAt(0).toUpperCase()+n.slice(1); }
function animoImgHTML(cr, px){
  var seed=creatureSeed(cr), hue=creatureTypeHue(cr), stage=creatureStage(cr), shiny=cr&&cr.shiny?1:0;
  var fb=encodeURIComponent(JSON.stringify([seed,hue,stage,shiny,px]));
  return '<img class="pokeimg animo-img" src="'+ANIMO_BASE+animoName(cr)+'.webp" width="'+px+'" height="'+px+'"'+
    ' alt="'+esc(animoLabel(cr))+'" data-fb="'+fb+'" decoding="async" onerror="svgErr(this)" loading="lazy">';
}
function svgErr(img){
  try{ var a=JSON.parse(decodeURIComponent(img.getAttribute("data-fb")));
       img.outerHTML=monsterSVG(a[0],a[1],a[2],!!a[3],a[4]); }
  catch(e){ img.style.display="none"; }
}

/* ---- Village pack: ORIGINAL animated troop creatures ----
   Base-building / army genre (Clash-style mechanics) but 100% ORIGINAL art & names —
   no third-party characters or assets. A troop "evolves" every level-up (stage 0..4). */
var TROOP_ARCH=["brute","slinger","caster","wyrm","golem","sapper","mender","rider"];
var TROOP_ROLE={brute:"Brawler",slinger:"Ranger",caster:"Caster",wyrm:"Wyrm",golem:"Guardian",sapper:"Sapper",mender:"Mender",rider:"Skyrider"};
var TROOP_HUE={brute:12,slinger:112,caster:282,wyrm:205,golem:30,sapper:45,mender:330,rider:188};
var TROOP_LEVELS=["Recruit","Fighter","Veteran","Champion","Warlord"];   // level = stage+1
var TROOP_NAMES=[
 "Thwack","Pipp","Zephry","Drakel","Cobble","Fizzle","Dewdrop","Gustle",
 "Bonker","Twangle","Runelet","Wyrmi","Boulderk","Boomkin","Balmy","Skywisp",
 "Maulkin","Dartkin","Sparkwick","Scaldon","Granyt","Kegsy","Sootha","Talonn",
 "Grumble","Slingo","Glimmr","Emberynn","Stomprock","Sputt","Menda","Aeron",
 "Smashling","Quillby","Hexle","Frostwyrm","Moltenite","Crackle","Lifewick","Cirro",
 "Wreckoz","Zipnock","Embercant","Gloamdrake","Bastion","Demoll","Vesper","Windle"];
function troopIdx(cr){ return pokeIdx(cr); }               // stable 0..47
function troopArch(cr){ return TROOP_ARCH[troopIdx(cr)%8]; }
function troopName(cr){ return TROOP_NAMES[troopIdx(cr)]||"Troop"; }
function isVillagePack(){ return cfg().creaturePack==="village"; }

/* ---- REAL Clash of Clans troop art (per level) ----
   Hotlinked at runtime from a public jsDelivr gh-mirror (nothing bundled in this repo),
   exactly like the Pokémon pack loads PokéAPI sprites. Only a troop slug + level number is
   ever requested — never any of your data. Source: chiefpansancolt/clash-of-clans-data
   (community dataset). The images are static per level, so we animate them with CSS
   (.troop-img). Each troop upgrades through real in-game levels as your session grows;
   if a specific level image is missing it falls back to level 1, then to the drawn SVG. */
var TROOP_CDN="https://cdn.jsdelivr.net/gh/chiefpansancolt/clash-of-clans-data@main/images/home/troops/";
var TROOP_SLUGS=["barbarian","archer","giant","goblin","wall-breaker","balloon","wizard","healer",
 "dragon","pekka","minion","hog-rider","valkyrie","golem","witch","lava-hound",
 "bowler","baby-dragon","miner","electro-dragon","yeti","dragon-rider","headhunter","apprentice-warden",
 "root-rider","druid","thrower","ice-golem","electro-titan","ruin-witch","furnace","meteor-golem"];
var TROOP_LABELS=["Barbarian","Archer","Giant","Goblin","Wall Breaker","Balloon","Wizard","Healer",
 "Dragon","P.E.K.K.A","Minion","Hog Rider","Valkyrie","Golem","Witch","Lava Hound",
 "Bowler","Baby Dragon","Miner","Electro Dragon","Yeti","Dragon Rider","Headhunter","Apprentice Warden",
 "Root Rider","Druid","Thrower","Ice Golem","Electro Titan","Ruin Witch","Furnace","Meteor Golem"];
var TROOP_N=TROOP_SLUGS.length;                 // 32 real troops
// Each troop's real max in-game level. A session's evolution progress (stage 0..4 plus
// its within-stage %) maps across 1..max, so the sprite climbs THIS troop's own levels
// as the session grows — the in-game levels ARE the evolution line.
var TROOP_MAXLVL={barbarian:12,archer:12,giant:12,goblin:9,"wall-breaker":11,balloon:11,wizard:12,healer:8,
 dragon:11,pekka:11,minion:11,"hog-rider":12,valkyrie:11,golem:13,witch:6,"lava-hound":7,
 bowler:7,"baby-dragon":11,miner:10,"electro-dragon":8,yeti:6,"dragon-rider":5,headhunter:4,"apprentice-warden":5,
 "root-rider":4,druid:3,thrower:3,"ice-golem":7,"electro-titan":5,"ruin-witch":3,furnace:3,"meteor-golem":3};
function troopSlot(cr){ return troopIdx(cr)%TROOP_N; }        // 0..31 (stable)
function troopSlug(cr){ return TROOP_SLUGS[troopSlot(cr)]; }
function troopLabel(cr){ return TROOP_LABELS[troopSlot(cr)]; }
function troopMaxLvl(cr){ return TROOP_MAXLVL[troopSlug(cr)]||10; }
// Evolution progress (0..1) from stage(0..4) + within-stage% -> this troop's level 1..max.
function troopLevelForCreature(cr){
  var mx=troopMaxLvl(cr), prog=(creatureStage(cr) + (creatureStagePct(cr)||0)/100)/4;
  prog=Math.max(0,Math.min(1,prog));
  return Math.max(1, Math.min(mx, 1+Math.round(prog*(mx-1))));
}
function troopImgURL(slug,lvl){ return TROOP_CDN+slug+"/normal/level-"+lvl+".png"; }
// Warm the browser cache for a level's art once, so evolution level-ups swap instantly.
var TROOP_PRELOADED = (typeof Set!=="undefined") ? new Set() : null;
function troopPreload(slug,lvl){
  if(!TROOP_PRELOADED || lvl<1) return;
  var u=troopImgURL(slug,lvl); if(TROOP_PRELOADED.has(u)) return; TROOP_PRELOADED.add(u);
  try{ var im=new Image(); im.decoding="async"; im.src=u; }catch(e){ hqErr(e,"troopPreload"); }
}
// Real troop image at the creature's evolved LEVEL, animated, with a graceful fallback chain.
function troopImgHTML(cr, px, lvlOverride){
  px=px||46;
  var slug=troopSlug(cr), mx=troopMaxLvl(cr);
  var lvl=Math.max(1, Math.min(mx, (lvlOverride!=null?lvlOverride:troopLevelForCreature(cr))|0));
  var st=Math.max(0,Math.min(4,creatureStage(cr)));
  var fb=encodeURIComponent(JSON.stringify([creatureSeed(cr),TROOP_HUE[troopArch(cr)],troopArch(cr),st,!!cr.shiny,px]));
  if(lvl<mx) troopPreload(slug, lvl+1);   // next level ready before it's needed
  return '<img class="pokeimg troop-img" src="'+troopImgURL(slug,lvl)+'" width="'+px+'" height="'+px+'"'+
    ' alt="'+esc(troopLabel(cr))+' — level '+lvl+'" data-slug="'+slug+'" data-lvl="'+lvl+'" data-fb="'+fb+'"'+
    ' decoding="async" onerror="troopErr(this)" loading="lazy">';
}
// missing level image -> step DOWN to the nearest lower level -> drawn troop SVG.
function troopErr(img){
  var lvl=+(img.getAttribute("data-lvl")||1);
  if(lvl>1){ lvl--; img.setAttribute("data-lvl",lvl); img.src=troopImgURL(img.getAttribute("data-slug"),lvl); return; }
  try{ var a=JSON.parse(decodeURIComponent(img.getAttribute("data-fb")));
       img.outerHTML=troopSVG(a[0],a[1],a[2],a[3],!!a[4],a[5]); }
  catch(e){ img.style.display="none"; }
}
// troopSVG(seed,hue,arch,stage,shiny,px) — drawn troop, animated (SMIL bob + gear). Offline fallback.
function troopSVG(seed, hue, arch, stage, shiny, px){
  px=px||46; stage=Math.max(0,Math.min(4,stage|0));
  var body="hsl("+hue+",60%,52%)", dark="hsl("+hue+",52%,34%)", light="hsl("+hue+",72%,70%)",
      skin="hsl("+((hue+28)%360)+",42%,80%)", gold="#ffd76a", wood="#8a5a33", steel="#c9d2dc";
  var scale=(0.72+stage*0.055).toFixed(3);   // grows each level-up
  var g=[];
  g.push('<ellipse cx="50" cy="93" rx="'+(18+stage*2)+'" ry="4.5" fill="rgba(0,0,0,.18)"/>');
  g.push('<rect x="40" y="70" width="7" height="16" rx="3" fill="'+dark+'"/><rect x="53" y="70" width="7" height="16" rx="3" fill="'+dark+'"/>');
  // gear that sits BEHIND the body (wings)
  if(arch==="wyrm"||arch==="rider"){
    g.push('<path d="M34 46 Q10 34 16 58 Q28 54 40 60 Z" fill="'+light+'" opacity=".9"/>');
    g.push('<path d="M66 46 Q90 34 84 58 Q72 54 60 60 Z" fill="'+light+'" opacity=".9"/>');
  }
  g.push('<rect x="34" y="44" width="32" height="32" rx="12" fill="'+body+'"/>');
  g.push('<rect x="41" y="53" width="18" height="19" rx="9" fill="'+light+'" opacity=".55"/>');
  if(arch==="golem"){ g.push('<path d="M36 50 l8 -4 l6 5 l8 -3 v10 l-7 4 l-8 -3 l-7 3 z" fill="'+dark+'" opacity=".55"/>'); }
  g.push('<rect x="26" y="48" width="10" height="20" rx="5" fill="'+body+'"/><rect x="64" y="48" width="10" height="20" rx="5" fill="'+body+'"/>');
  if(stage>=3){ g.push('<rect x="32" y="44" width="12" height="8" rx="4" fill="'+steel+'"/><rect x="56" y="44" width="12" height="8" rx="4" fill="'+steel+'"/>'); } // pauldrons
  g.push('<circle cx="50" cy="34" r="16" fill="'+skin+'"/>');
  g.push('<circle cx="44" cy="34" r="2.6" fill="#20242c"/><circle cx="56" cy="34" r="2.6" fill="#20242c"/>');
  g.push('<path d="M45 41 Q50 45 55 41" stroke="#20242c" stroke-width="1.6" fill="none" stroke-linecap="round"/>');
  if(arch==="wyrm"){ g.push('<path d="M40 22 l-4 -9 l9 5 z" fill="'+dark+'"/><path d="M60 22 l4 -9 l-9 5 z" fill="'+dark+'"/>'); } // horns
  // held gear (in front), with a subtle SMIL swing
  var swing='<animateTransform attributeName="transform" type="rotate" values="-6 72 50;6 72 50;-6 72 50" dur="2.8s" repeatCount="indefinite"/>';
  if(arch==="brute"){ g.push('<g transform="rotate(0 72 50)">'+swing+'<rect x="70" y="18" width="6" height="30" rx="3" fill="'+wood+'"/><circle cx="73" cy="16" r="9" fill="#6b4423"/><circle cx="70" cy="14" r="1.5" fill="'+steel+'"/><circle cx="77" cy="17" r="1.5" fill="'+steel+'"/></g>'); }
  else if(arch==="slinger"){ g.push('<path d="M74 22 Q90 42 74 62" stroke="'+wood+'" stroke-width="3.2" fill="none"/><line x1="74" y1="22" x2="74" y2="62" stroke="#eee" stroke-width="1"/><line x1="60" y1="42" x2="82" y2="42" stroke="'+dark+'" stroke-width="1.6"/>'); }
  else if(arch==="caster"){ g.push('<rect x="72" y="22" width="4" height="42" rx="2" fill="'+wood+'"/><circle cx="74" cy="20" r="7" fill="'+light+'"><animate attributeName="r" values="6;8;6" dur="1.8s" repeatCount="indefinite"/><animate attributeName="opacity" values=".7;1;.7" dur="1.8s" repeatCount="indefinite"/></circle>'); }
  else if(arch==="sapper"){ g.push('<circle cx="72" cy="42" r="9" fill="#2b2f36"/><rect x="71" y="30" width="2" height="5" fill="'+wood+'"/><circle cx="72" cy="29" r="2.4" fill="'+gold+'"><animate attributeName="opacity" values="1;.2;1" dur="0.7s" repeatCount="indefinite"/></circle>'); }
  else if(arch==="mender"){ g.push('<rect x="72" y="24" width="4" height="40" rx="2" fill="'+steel+'"/><g transform="translate(74 22)"><rect x="-2" y="-6" width="4" height="12" rx="1" fill="#3ddc84"/><rect x="-6" y="-2" width="12" height="4" rx="1" fill="#3ddc84"/></g>'); }
  else if(arch==="wyrm"){ g.push('<path d="M34 72 q-14 6 -20 -2 q10 2 16 -6 z" fill="'+dark+'"/>'); } // tail
  // rank pips (level) on the chest ribbon
  var pips=''; for(var i=0;i<=stage;i++){ pips+='<circle cx="'+(43+i*3.5)+'" cy="66" r="1.5" fill="'+gold+'"/>'; }
  g.push(pips);
  if(stage>=4){ g.push('<path d="M40 20 l3 -8 l6 6 l4 -9 l4 9 l6 -6 l3 8 z" fill="'+gold+'" stroke="#c99a2e" stroke-width="0.8"/>'); } // crown at max level
  if(shiny){ g.push('<g fill="'+gold+'"><path d="M22 24 l1.5 3 3 1.5 -3 1.5 -1.5 3 -1.5 -3 -3 -1.5 3 -1.5 z"/><path d="M80 70 l1 2 2 1 -2 1 -1 2 -1 -2 -2 -1 2 -1 z"/></g>'); }
  var stroke=shiny?' style="filter:drop-shadow(0 0 3px '+gold+')"':'';
  return '<svg class="troop-svg" viewBox="0 0 100 100" width="'+px+'" height="'+px+'" xmlns="http://www.w3.org/2000/svg"'+stroke+'>'+
    '<g transform="translate(50 52) scale('+scale+') translate(-50 -52)">'+
    '<g><animateTransform attributeName="transform" type="translate" values="0 0;0 -2.4;0 0" dur="2.6s" repeatCount="indefinite" keyTimes="0;0.5;1" calcMode="spline" keySplines="0.4 0 0.6 1;0.4 0 0.6 1"/>'+
    g.join('')+'</g></g></svg>';
}
function troopVisual(cr, px){ return troopImgHTML(cr, px); }  // real per-level art, SVG fallback
// Energy look on top of whatever the pack painted: a class on the wrapper (the sprite keeps
// its own shiny filter) and, at avatar size and up, a small 💦 / 💫 corner badge.
// (Never 💤, 😴 or 🛌: those already mean stale, ended or empty.)
function applyFatigueFx(node, cr, px){
  var f=fzOf(cr); if(!f || f.state==="rested") return;
  node.classList.add(f.state==="unconscious" ? "fz-ko" : (f.state==="fatigued" ? "fz-fatigued" : "fz-tired"));
  if(px>=40 && (f.state==="fatigued" || f.state==="unconscious")){
    var b=el("span","fz-badge"); b.setAttribute("aria-hidden","true");
    b.textContent = f.state==="unconscious" ? "\uD83D\uDCAB" : "\uD83D\uDCA6";
    node.appendChild(b);
  }
}
function paintCreature(node, cr, px, bg){
  cr=cr||{}; if(bg===undefined) bg=true; px=px||46;
  node.classList.remove("shiny","cre-svg","fz-tired","fz-fatigued","fz-ko");
  if(isVillagePack()){
    node.classList.add("cre-svg");
    if(bg){ var isDv=window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches;
            node.style.background="hsl("+TROOP_HUE[troopArch(cr)]+",45%,"+(isDv?"18%":"90%")+")"; }
    node.innerHTML=troopVisual(cr, px);
    if(cr.shiny) node.classList.add("shiny");
    applyFatigueFx(node, cr, px);
    return;
  }
  if(isPokePack()){
    if(bg){ var isD=window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches;
            node.style.background="hsl("+creatureTypeHue(cr)+",55%,"+(isD?"20%":"90%")+")"; }
    node.innerHTML=pokeImgHTML(cr, px);
    if(cr.shiny) node.classList.add("shiny");
    applyFatigueFx(node, cr, px);
    return;
  }
  if(cfg().creaturePack==="aniimo"){
    if(bg){ var isDn=window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches;
            node.style.background="hsl("+creatureTypeHue(cr)+",55%,"+(isDn?"20%":"90%")+")"; }
    node.innerHTML=animoImgHTML(cr, px);
    if(cr.shiny) node.classList.add("shiny");
    applyFatigueFx(node, cr, px);
    return;
  }
  if(cfg().creaturePack==="monsters"){
    node.classList.add("cre-svg");
    if(bg) node.style.background="transparent";
    node.innerHTML=monsterSVG(creatureSeed(cr),creatureTypeHue(cr),creatureStage(cr),!!cr.shiny,px);
    if(cr.shiny) node.classList.add("shiny");
  } else {
    if(bg){
      var isDark=window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
      node.style.background="hsl("+(cr.hue!=null?cr.hue:220)+",70%,"+(isDark?"24%":"88%")+")";
    }
    node.textContent=creatureEmoji(cr);
    if(cr.shiny) node.classList.add("shiny");
  }
  applyFatigueFx(node, cr, px);
}
// String form for callers that build markup (feed/cmdk): svg or an emoji.
function creatureVisual(x, px){
  var cr=(x && x.creature)?x.creature:(x||{}); px=px||46;
  if(cfg().creaturePack==="village") return troopVisual(cr, px);
  if(cfg().creaturePack==="aniimo") return animoImgHTML(cr, px);
  if(isPokePack()) return pokeImgHTML(cr, px);
  if(cfg().creaturePack==="monsters")
    return monsterSVG(creatureSeed(cr),creatureTypeHue(cr),creatureStage(cr),!!cr.shiny,px);
  return esc(creatureEmoji(cr));
}

function applyTheme(t){ document.documentElement.dataset.theme = t || "aurora"; }
// --- display preferences (theme + large-text + calm) are LOCALSTORAGE-authoritative ---
// The backend only knows aurora/midnight/forest/mono and silently drops unknown themes
// (e.g. "contrast"), so we never let the server round-trip clobber the local choice.
function storedTheme(){ try{ return localStorage.getItem("hq_theme")||null; }catch(e){ return null; } }
function effectiveTheme(){ return storedTheme() || (CONFIG&&CONFIG.theme) || "aurora"; }
function prefContrast(){ return window.matchMedia && window.matchMedia("(prefers-contrast: more)").matches; }
// Read the calm pref; when unset, default to the OS reduced-motion setting.
function calmPref(){ var v=null; try{ v=localStorage.getItem("hq_calm"); }catch(e){}
  if(v==null) return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  return v==="1"; }
function largePref(){ try{ return localStorage.getItem("hq_large")==="1"; }catch(e){ return false; } }
// Accent override: a hue number (0..360) or "" for the theme default.
function accentPref(){ try{ var v=localStorage.getItem("hq_accent"); return v==null?"":v; }catch(e){ return ""; } }
// Override --brand / --brand2 inline on <html> (inline style beats every theme selector).
function applyAccent(){
  var root=document.documentElement, h=accentPref();
  if(h===""||h==null){ root.style.removeProperty("--brand"); root.style.removeProperty("--brand2"); root.style.removeProperty("--on-brand"); return; }
  var hue=Math.max(0,Math.min(360,parseInt(h,10)||0));
  root.style.setProperty("--brand","hsl("+hue+" 85% 60%)");
  root.style.setProperty("--brand2","hsl("+hue+" 85% 72%)");
  root.style.setProperty("--on-brand","#111");
}
// Apply theme + large-text + calm classes from local prefs (idempotent, safe to call often).
function applyDisplayPrefs(){
  applyTheme(effectiveTheme());
  var root=document.documentElement;
  root.classList.toggle("hq-large-text", largePref());
  root.classList.toggle("hq-calm", calmPref());
  applyAccent();
}
// True when motion/effects should be suppressed (OS reduced-motion OR manual calm mode).
function calmMode(){ return calmPref() || (document.documentElement.classList.contains("hq-calm")); }
// Light sync used inside render() — updates CONFIG + theme without re-rendering.
function syncConfig(c){
  if(!c) return;
  CONFIG = Object.assign({}, CONFIG_DEFAULTS, CONFIG, c);
  if(!storedTheme() && c.theme){ try{ localStorage.setItem("hq_theme", c.theme); }catch(e){} } // adopt server theme once
  applyDisplayPrefs();
}
// Heavy apply — used on explicit save / startup; re-renders creature surfaces.
function applyConfig(c){
  CONFIG = Object.assign({}, CONFIG_DEFAULTS, CONFIG, c||{});
  // Only adopt the server theme if the user has never chosen one locally.
  if(c && c.theme && !storedTheme()){ try{ localStorage.setItem("hq_theme", c.theme); }catch(e){} }
  applyDisplayPrefs();
  try{ localStorage.setItem("hq_pack",CONFIG.creaturePack); }catch(e){}
  if(typeof syncPackLabels==="function") syncPackLabels();
  if(typeof STATE!=="undefined" && STATE){
    if(typeof renderParty==="function") renderParty(STATE.sessions);
    if(typeof renderFeed==="function") renderFeed(STATE.feed);
    if(FOCUS_ID && typeof renderFocus==="function") renderFocus();
    if(typeof WARROOM_ON!=="undefined" && WARROOM_ON) renderWarroom();
    if(typeof renderGymCard==="function") renderGymCard();
    if(typeof VIEW!=="undefined" && VIEW==="gym" && typeof renderGym==="function") renderGym();
  }
  if(typeof VIEW!=="undefined" && VIEW==="pokedex" && typeof POKEDEX!=="undefined" && POKEDEX && typeof renderPokedex==="function") renderPokedex(POKEDEX);
}
// POST guarded meta (pin/tags/note) — reuses CSRF plumbing like postAction.
function postMeta(body){
  return fetch("/api/meta",{
    method:"POST",
    headers:{"Content-Type":"application/json","X-HQ-Token":CSRF},
    body:JSON.stringify(body)
  }).then(function(r){ return r.json().then(function(j){return {ok:r.ok,j:j};},function(){return {ok:r.ok,j:{}};}); });
}
// POST guarded config.
function postConfig(body){
  return fetch("/api/config",{
    method:"POST",
    headers:{"Content-Type":"application/json","X-HQ-Token":CSRF},
    body:JSON.stringify(body)
  }).then(function(r){ return r.json().then(function(j){return {ok:r.ok,j:j};},function(){return {ok:r.ok,j:{}};}); });
}
// Patch STATE.sessions in place so re-renders keep meta until next payload.
function applyMetaLocal(sid,patch){
  if(typeof STATE==="undefined" || !STATE || !STATE.sessions) return;
  STATE.sessions.forEach(function(s){
    if((s.sessionId||s.id)===sid){ for(var k in patch){ s[k]=patch[k]; } }
  });
}
function togglePin(s){
  var sid = s.sessionId||s.id; if(!sid) return;
  var np = !s.pinned;
  postMeta({sessionId:sid, pinned:np}).then(function(r){
    if(r.ok){ s.pinned=np; applyMetaLocal(sid,{pinned:np}); toast(np?"📌 Pinned":"Unpinned","level"); if(STATE) renderParty(STATE.sessions); }
    else toast("⚠ "+(r.j.error||"pin failed"),"ach");
  }).catch(function(){ toast("⚠ pin failed","ach"); });
}
function matchesTag(s){ if(!FILTERTAG) return true; return (s.tags||[]).indexOf(FILTERTAG)>=0; }
function setTagFilter(t){ FILTERTAG=t; var sel=$("tagFilter"); if(sel) sel.value=t; if(STATE) renderParty(STATE.sessions); }
var FILTERFOLDER="";
function matchesFolder(s){ if(!FILTERFOLDER) return true; return (s.folder||"")===FILTERFOLDER; }

// POST a guarded action to the backend; toasts the result.
