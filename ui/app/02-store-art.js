/* ===== Store pixel art: original sprites, drawn at runtime (no assets, no network) ===== */
// A sprite is rows of palette letters; "." is empty. `k` is an outline drawn around the
// silhouette (4-neighbour), skipping letters listed in `n` (steam, sparkles: no outline).
var PX_ART = {
  berry:{k:"#1b2152", p:{b:"#4f63c9",d:"#33449a",h:"#b4c4ff",c:"#26306e",l:"#8fd45f",g:"#3f9b45"}, r:[
    "................",
    "........lg......",
    "......bbbb......",
    ".....bhbbbb.....",
    ".....bbccbb.....",
    ".....bbbbbd.....",
    ".....bbbbdd.....",
    "......bddd......",
    "................",
    "..bbbb...bbbb...",
    ".bhbbbb.bhbbbb..",
    ".bbccbb.bbccbb..",
    ".bbbbbd.bbbbbd..",
    ".bbbbdd.bbbbdd..",
    "..bddd...bddd...",
    "................"]},
  bread:{k:"#5a3417", p:{c:"#c98a45",C:"#e8b86a",s:"#f6dfb0",d:"#9c6230"}, r:[
    "................",
    "................",
    "................",
    "................",
    "......cccc......",
    "....cCCCCCCc....",
    "...cCCsCCCsCc...",
    "..cCCsCCCsCCcc..",
    ".ccCsCCCsCCCccc.",
    ".cccccccccccccd.",
    ".dcccccccccccdd.",
    ".ddcccccccccddd.",
    "..dddddddddddd..",
    "................",
    "................",
    "................"]},
  riceball:{k:"#5e574b", p:{w:"#fdfcf7",r:"#e2dccf",s:"#c9c0ae",n:"#203a2c",N:"#3f6a52"}, r:[
    "................",
    "................",
    ".......ww.......",
    "......wwww......",
    ".....wwwwwr.....",
    ".....wwwwwr.....",
    "....wwwwwwwr....",
    "...wwwwwwwwrr...",
    "...wwwwwwwwwr...",
    "..wwwnnnnnnwrr..",
    "..wwwnNnnnnwwr..",
    ".wwwwnnnnnnwwrr.",
    ".rwwwnnnnnnwrrs.",
    "..rrrnnnnnnrss..",
    "................",
    "................"]},
  coffee:{k:"#4a3a2a", n:"v", p:{m:"#ece5d3",M:"#ffffff",s:"#c4b9a0",c:"#4a2f1b",C:"#7d5536",r:"#c8553d",v:"#cfc8bb"}, r:[
    "................",
    "....v....v......",
    ".....v....v.....",
    "....v....v......",
    "................",
    "..mmmmmmmmmm....",
    "..mcCCcccccm....",
    "..Mmmmmmmmms....",
    "..Mmmmmmmmssmm..",
    "..Mmmmmmmmss.m..",
    "..Mrrrrrrrss.m..",
    "..Mmmmmmmmssmm..",
    "..Mmmmmmmmss....",
    "..mmmmmmmmss....",
    "...ssssssss.....",
    "................"]},
  bento:{k:"#3c1712", p:{r:"#d9574a",R:"#b33a2e",d:"#7a241d",w:"#fbfaf5",s:"#3a3a3a",p:"#e0526b",o:"#f08a4b",O:"#ffb27a",y:"#f5cf4a",Y:"#fff0a0",g:"#5aa83c",G:"#8fd45f"}, r:[
    "................",
    "................",
    "................",
    ".rrrrrrrrrrrrrr.",
    ".RwwwwwwRooOooR.",
    ".RwswwwwROOooOR.",
    ".RwwwwwwRooooOR.",
    ".RwwppwwRoooooR.",
    ".RwwppwwRRRRRRR.",
    ".RwwwwwwRyYyyyR.",
    ".RwwwwswRyyyyyR.",
    ".RwswwwwRgGgGgR.",
    ".RwwwwwwRgggggR.",
    ".dddddddddddddd.",
    "................",
    "................"]},
  noodles:{k:"#24324a", n:"c", p:{c:"#a8743f",w:"#f4f1e8",n:"#f2d48f",N:"#e0b866",e:"#ffffff",y:"#ffb43c",g:"#6cc04a",h:"#c8803d",B:"#7aa7e0",b:"#4e7fbf",d:"#2f5590"}, r:[
    "................",
    "............c.c.",
    "...........c.c..",
    "..........c.c...",
    ".........c.c....",
    "...wwwwwcwcww...",
    ".wneyynNnngnhhw.",
    ".wheeennNnngnhw.",
    ".wwwwwwwwwwwwww.",
    ".BBbbbbbbbbbbbd.",
    "..Bbbbwbbbwbbd..",
    "..Bbbbbbbbbbdd..",
    "...bbbbbbbbdd...",
    ".....dddddd.....",
    "................",
    "................"]},
  hotpot:{k:"#2a1a12", n:"v", p:{p:"#6b4a3a",P:"#8d6650",d:"#4a3226",s:"#d9502e",S:"#f08a4b",c:"#f5e6c8",g:"#5aa83c",v:"#e6e0d4"}, r:[
    "................",
    ".....v....v.....",
    "......v....v....",
    ".....v....v.....",
    "................",
    "..pPPPPPPPPPPp..",
    "..psSsccSgsSsp..",
    ".pPPPPPPPPPPPPp.",
    ".dPppppppppppdd.",
    "..Pppppppppppd..",
    "..PpPpPpPpPppd..",
    "..ppppppppppdd..",
    "...ppppppppdd...",
    "....dddddddd....",
    "................",
    "................"]},
  tonic:{k:"#24453f", n:"x", p:{w:"#dff3ff",W:"#ffffff",g:"#3fd0a0",G:"#8ff0cf",d:"#1f9a74",c:"#b07a48",C:"#d9a066",x:"#fff6a8"}, r:[
    "................",
    ".......Cc.......",
    ".......cc....x..",
    "......wWww..xxx.",
    "......wWww...x..",
    ".....wwwwww.....",
    "....wwwwwwww....",
    "...wGGGGGGGGw...",
    "...wWggggggdw...",
    "...wWggggxgdw...",
    "...wWggggggdw...",
    "...wggggggddw...",
    "....wggggddw....",
    ".....wddddw.....",
    "................",
    "................"]},
  elixir:{k:"#5a3a0a", n:"x", p:{p:"#e8577f",r:"#c43a5c",R:"#ff7aa0",w:"#fff4dc",W:"#ffffff",y:"#f5b52e",Y:"#ffd866",o:"#d98a12",x:"#fff4a0"}, r:[
    "................",
    "..x...p..p......",
    ".xxx..pppp......",
    "..x....pp.......",
    "......rRrr......",
    ".....wwwwww.....",
    "....wYYYYYYw....",
    "...wWyyyyyyow...",
    "...wWyyxyyyow...",
    "...wWyyyyyyow...",
    "...wyyyyyyoow...",
    "....wyyyyoow....",
    ".....woooow.....",
    "..........x.....",
    ".........xxx....",
    "..........x....."]},
  strawberry:{k:"#5a1018", p:{r:"#e23b4a",R:"#ff7880",d:"#a8202f",s:"#ffe08a",g:"#3f9b45",G:"#7fd05a"}, r:[
    "................",
    ".......G........",
    ".....gGgGgg.....",
    "...rgggGgggrr...",
    "..rRRgrrgrrrrd..",
    "..rRsrrrsrrsrd..",
    "..rRrrsrrrsrrd..",
    "...rsrrrsrrrd...",
    "...rrrsrrrsrd...",
    "....rsrrrsrd....",
    "....rrrsrrdd....",
    ".....rsrrdd.....",
    "......rrdd......",
    ".......dd.......",
    "................",
    "................"]},
  dango:{k:"#5a4030", p:{P:"#ffd0e0",p:"#f6a5c0",q:"#d77fa0",W:"#ffffff",w:"#f5f1e6",e:"#d8d0c0",G:"#c4e8a8",g:"#8cc66d",h:"#5f9a48",s:"#c9a46b"}, r:[
    "................",
    ".....PPpppp.....",
    "....PPppppqq....",
    "....Ppppppqq....",
    ".....qqqqqq.....",
    ".....WWwwww.....",
    "....WWwwwwee....",
    "....Wwwwwwee....",
    ".....eeeeee.....",
    ".....GGgggg.....",
    "....GGgggghh....",
    "....Gggggghh....",
    ".....hhhhhh.....",
    ".......ss.......",
    ".......ss.......",
    "................"]},
  omelette:{k:"#5a4a2a", p:{Y:"#ffe88a",y:"#ffd34d",o:"#e3a52c",r:"#d8433a",w:"#f6f6f2",e:"#d2d2cc",g:"#5aa83c"}, r:[
    "................",
    "................",
    "................",
    "................",
    ".....YYYyyy.....",
    "....YYyyyyyo....",
    "...Yyyryryryo...",
    "...yyyyryryyo...",
    "..yyoyyyyyyyyo..",
    ".wyyyyyyyyyyoow.",
    ".woooooooooooow.",
    ".wwggwwwwwwwrrw.",
    "..ewwwwwwwwwwe..",
    "....eeeeeeee....",
    "................",
    "................"]},
  watermelon:{k:"#1f4a25", p:{R:"#ff7b85",r:"#ef4b5c",s:"#2a1d1a",w:"#f5f0d0",g:"#3f9b45",G:"#2a7535"}, r:[
    "................",
    "................",
    "................",
    "................",
    "................",
    ".gwRRRRRRRRRRwg.",
    ".gwrrsrrrrsrrwg.",
    ".ggwrrrsrrrrwgg.",
    "..gwrsrrrrsrwg..",
    "..ggwrrrrrrwgg..",
    "...ggwrrsrwgg...",
    "....ggwwwwgg....",
    "......GGGG......",
    "................",
    "................",
    "................"]},
  shavedice:{k:"#34495e", p:{w:"#f4fbff",W:"#ffffff",b:"#cfe6f5",r:"#ff6b8a",R:"#ffa0b8",l:"#5cb8f0",c:"#d7413f",g:"#3f9b45",U:"#d4f0f8",u:"#9ed3e6",d:"#6fa8c0"}, r:[
    "................",
    "........g.......",
    ".......cc.......",
    "......wccw......",
    ".....wWwwrw.....",
    "....wWwrrRww....",
    "...wWwrrRrwlw...",
    "..wWwwrrrwwllb..",
    "..bwwwwrwwlllb..",
    ".UUUUUUUUUUUUUU.",
    "..uUuuuuuuuudd..",
    "...uUuuuuuudd...",
    "....uuuuuudd....",
    "......uudd......",
    ".....dddddd.....",
    "................"]},
  curry:{k:"#4a3a2a", p:{i:"#fffdf5",I:"#e8e2d2",c:"#d98a2b",C:"#f0b04a",d:"#a8611a",o:"#f07a3a",m:"#8a5a3a",p:"#6cb04a",w:"#f4f4f0",e:"#d0d0c8"}, r:[
    "................",
    "................",
    "................",
    "...iiii.........",
    "..iiiiII........",
    "..iiiiII..CCc...",
    "..iiiiII.CcmcC..",
    "..iiiiIICcocpc..",
    ".wwiiiIIccmcccw.",
    ".wwwiIIcccocccw.",
    ".wwcccccmccccww.",
    "..wwdccpcccdww..",
    "...eewwwwwwee...",
    ".....eeeeee.....",
    "................",
    "................"]},
  apple:{k:"#4a1010", p:{r:"#d93a3a",R:"#ff6b6b",W:"#ffd8d0",d:"#9e2222",s:"#6b4423",g:"#3f9b45",G:"#7fd05a"}, r:[
    "................",
    "........gG......",
    ".......sgGG.....",
    "....rrrsrrrr....",
    "...rRRrrrrrrd...",
    "..rRWRrrrrrrrd..",
    "..rRRrrrrrrrrd..",
    "..rRrrrrrrrrrd..",
    "..rrrrrrrrrrdd..",
    "..rrrrrrrrrrdd..",
    "...rrrrrrrrdd...",
    "...rrrrrrrddd...",
    "....rrd..ddd....",
    "................",
    "................",
    "................"]},
  sweetpotato:{k:"#3d1424", n:"v", p:{p:"#9c3b5a",P:"#c4567a",q:"#6e2540",y:"#f5b041",Y:"#ffd27a",v:"#e6e0d4"}, r:[
    "................",
    "......v...v.....",
    ".......v...v....",
    "......v...v.....",
    "................",
    "....pppppppp....",
    "..pPPyYYYyyPpp..",
    ".pPyYYYYyyyyPpq.",
    ".pPyyyYyyyyypqq.",
    ".ppPyyyyyyyPpqq.",
    "..ppppPPpppqqq..",
    "....qqqqqqqq....",
    "................",
    "................",
    "................",
    "................"]},
  pumpkinstew:{k:"#4a2408", n:"v", p:{o:"#f08c2a",O:"#ffb35c",d:"#b85d14",y:"#ffd27a",s:"#c0632a",S:"#e0894a",m:"#8a4a2a",v:"#e6e0d4"}, r:[
    "................",
    "......v....v....",
    ".......v....v...",
    "......v....v....",
    "................",
    "....yyyyyyyy....",
    "...ysSsmsSssy...",
    "..oyyyyyyyyyyo..",
    ".oOOodOOoodOood.",
    ".oOOodOOoodOood.",
    ".oOoodOooodOodd.",
    "..ooodoooododd..",
    "...dddddddddd...",
    "................",
    "................",
    "................"]},
  chestnuts:{k:"#3a2010", p:{b:"#7a4422",B:"#a8643a",d:"#4a2410",L:"#e6c49a",P:"#f2e2c4",p:"#d9b98a",q:"#b08d5e",r:"#c8453a"}, r:[
    "................",
    "................",
    "........LL......",
    "....LL.bBbb.....",
    "...bBbbbbbdLL...",
    "...bbbdLLbbBbb..",
    "..bbbBbbbbbbbd..",
    "..PPPPPPPPPPPP..",
    "...pppppppppp...",
    "...rrrrrrrrrr...",
    "....pppppppp....",
    ".....ppppqq.....",
    ".....ppppqq.....",
    "......ppqq......",
    ".......qq.......",
    "................"]},
  cocoa:{k:"#4a1a14", n:"v", p:{m:"#c8453a",M:"#e8705f",s:"#962f27",c:"#5e3420",C:"#8f5a3a",W:"#fffaf0",w:"#ffffff",v:"#e6e0d4"}, r:[
    "................",
    "....v....v......",
    ".....v....v.....",
    "....v....v......",
    "................",
    "..mmmmmmmmmm....",
    "..mcWWcCWWcm....",
    "..Mmmmmmmmms....",
    "..Mmmmmmmmssmm..",
    "..Mmmwmwmmss.m..",
    "..Mmmmwmmmss.m..",
    "..Mmmwmwmmssmm..",
    "..Mmmmmmmmss....",
    "..mmmmmmmmss....",
    "...ssssssss.....",
    "................"]},
  oden:{k:"#3a2a1a", p:{s:"#c9a46b",g:"#7d7d78",G:"#a3a39c",d:"#55554f",W:"#fff6dc",w:"#f0dcae",e:"#c9ae7a",Y:"#ffd27a",y:"#e5a23e",o:"#a8661c"}, r:[
    "................",
    ".......ss.......",
    ".......gg.......",
    "......gGgg......",
    ".....gGggGd.....",
    "....gggGgggd....",
    "......WWww......",
    ".....WWwwwe.....",
    ".....Wwwwee.....",
    "......eeee......",
    ".....YYyyyy.....",
    ".....Yyyyyo.....",
    ".....Yyyyyo.....",
    ".....oooooo.....",
    ".......ss.......",
    "................"]},

  /* ---- UI icons ---- */
  coin:{k:"#6b3d06", p:{y:"#f5c542",Y:"#ffe58a",o:"#c98a1a",s:"#fff6c8"}, r:[
    "..........",
    "...yyyy...",
    "..yYYyyo..",
    ".yYyysyoo.",
    ".yYysssyo.",
    ".yyyysyoo.",
    ".yyyyyyoo.",
    "..yyyooo..",
    "...oooo...",
    ".........."]},
  heart:{k:"#5a1018", p:{r:"#e8455a",R:"#ff8a96",d:"#b02a3c"}, r:[
    ".........",
    ".rr..rr..",
    "rRRrrrrd.",
    "rRrrrrrd.",
    ".rrrrrd..",
    "..rrrd...",
    "...rd....",
    "........."]},
  heart0:{k:"#7a5a40", p:{e:"#e8d2b0"}, r:[
    ".........",
    ".ee..ee..",
    "eeeeeeee.",
    "eeeeeeee.",
    ".eeeeee..",
    "..eeee...",
    "...ee....",
    "........."]},
  bolt:{k:"#7a4a00", p:{y:"#ffd93d",Y:"#fff3a8"}, r:[
    "........",
    "....yy..",
    "...yY...",
    "..yY....",
    ".yyyyy..",
    "...yY...",
    "..yY....",
    ".yY.....",
    "........"]},
  star:{k:"#7a4a00", p:{y:"#ffd93d",Y:"#fff3a8",o:"#e8a020"}, r:[
    "...........",
    ".....y.....",
    "....yYy....",
    ".yyyyYyyyy.",
    "..yyYYYyo..",
    "...yyyyo...",
    "..yyo.yyo..",
    ".yo.....yo.",
    "..........."]},
  bell:{k:"#5a3a06", p:{y:"#f5c542",Y:"#ffe58a",o:"#c98a1a",d:"#8a5a10"}, r:[
    "............",
    ".....yy.....",
    "....yYYy....",
    "...yYyyyo...",
    "...yYyyyo...",
    "...yYyyyo...",
    "..yYyyyyoo..",
    ".yyyyyyyyoo.",
    ".dddddddddd.",
    "............"]},
  blossom:{k:"#7a2a4a", p:{p:"#ffa5c8",P:"#ffd6e6",y:"#ffd93d"}, r:[
    "..........",
    "....pp....",
    "..p.PP.p..",
    ".pPppppPp.",
    "..ppyypp..",
    "..ppyypp..",
    ".pPppppPp.",
    "..p.pp.p..",
    "....pp....",
    ".........."]},
  sun:{k:"#8a5a00", p:{y:"#ffd93d",Y:"#fff3a8",o:"#f5a020"}, r:[
    "..........",
    "....y.....",
    ".y..y...y.",
    "...yYy....",
    "..yYYyy...",
    "yy.yyyy.yy",
    "...yyyo...",
    "....y.....",
    ".y..y...y.",
    ".........."]},
  leaf:{k:"#5a2408", p:{o:"#f08c2a",O:"#ffb35c",r:"#d9542a",s:"#8a4a1a"}, r:[
    "..........",
    "....o.....",
    "..o.Oo.o..",
    "..OoOoOo..",
    ".oOooooro.",
    "..ooOorr..",
    "...oorr...",
    "....s.....",
    "....s.....",
    ".........."]},
  snow:{k:"#2a4a7a", n:"", p:{w:"#ffffff",b:"#bfe0ff"}, r:[
    "..........",
    "....w.....",
    ".w..w..w..",
    "..w.b.w...",
    "...wbw....",
    "wwbbwbbww.",
    "...wbw....",
    "..w.b.w...",
    ".w..w..w..",
    "....w....."]},
  bag:{k:"#3a2010", p:{b:"#b5763a",B:"#d99a5a",d:"#8a5226",t:"#e8c08a",r:"#c8453a"}, r:[
    "............",
    "....tttt....",
    ".....rr.....",
    "....bBBb....",
    "...bBbbbd...",
    "..bBbbbbbd..",
    "..bBbbbbbd..",
    "..bbbbbbdd..",
    "...dddddd...",
    "............"]},
  zzz:{p:{z:"#ffffff"}, r:[
    "zzz.",
    "..z.",
    ".z..",
    "zzz."]}
};

/* ---- the shop cat (Biscuit): sleeping loaf, tail flick, awake ---- */
PX_ART.cat0={k:"#4a2410", p:{o:"#e8964a",O:"#f8bf86",d:"#b8682c",w:"#fff0dc",p:"#f4a0a0",e:"#4a2410"}, r:[
  "..................",
  "..o..o............",
  ".oOooOo...........",
  ".oOOOOo.dooodoo...",
  "oeeOeeoOooOoooOo..",
  "oOOpOOoOoodooooodo",
  ".wwwwwoOoooooooodo",
  ".wwoooooooooooodo.",
  "..ddddddddddddoo..",
  ".................."]};
PX_ART.cat1={k:"#4a2410", p:PX_ART.cat0.p, r:[
  "..................",
  "..o..o............",
  ".oOooOo...........",
  ".oOOOOo.dooodoo...",
  "oeeOeeoOooOoooOo..",
  "oOOpOOoOoodooooo..",
  ".wwwwwoOoooooooo.o",
  ".wwooooooooooooodo",
  "..ddddddddddddddo.",
  ".................."]};
PX_ART.cat2={k:"#4a2410", p:{o:"#e8964a",O:"#f8bf86",d:"#b8682c",w:"#fff0dc",p:"#f4a0a0",e:"#2a1408",g:"#7fd05a"}, r:[
  "..o..o............",
  ".oOooOo...........",
  ".oOOOOo...........",
  "oegOegoOooodoo....",
  "oeeOeeoOooOoooOo..",
  "oOOpOOoOoodooooodo",
  ".wwwwwoOoooooooodo",
  ".wwoooooooooooodo.",
  "..ddddddddddddoo..",
  ".................."]};

/* ---- the shopkeeper (Katie): a 32x32 bust built from shapes, then details ---- */
var PX_KEEPER_PAL = {
  h:"#e8c46a", H:"#f7de8f", j:"#b98f3f", b:"#5f8f3a", f:"#ff9f1c", F:"#ffc857", c:"#8a4b0f",
  r:"#b5562d", R:"#d9773f", q:"#7d3519",
  s:"#f8cfae", S:"#ffe3cc", t:"#e3a98a", p:"#f28b82",
  e:"#2b1d16", w:"#ffffff", m:"#a83a44", M:"#e97a7a",
  n:"#f5ead6", N:"#d9c8a8", a:"#4f8a4b", A:"#6fae62", g:"#356637", y:"#ffd23f"
};
function pxGrid(w,h){ var g=[]; for(var y=0;y<h;y++){ var row=[]; for(var x=0;x<w;x++) row.push("."); g.push(row); } return g; }
function pxEll(g,cx,cy,rx,ry,ch){
  for(var y=0;y<g.length;y++) for(var x=0;x<g[0].length;x++){
    var dx=(x+0.5-cx)/rx, dy=(y+0.5-cy)/ry; if(dx*dx+dy*dy<=1) g[y][x]=ch;
  }
}
function pxRect(g,x0,y0,x1,y1,ch){ for(var y=y0;y<=y1;y++) for(var x=x0;x<=x1;x++) if(g[y] && x>=0 && x<g[0].length) g[y][x]=ch; }
function pxDot(g,pts,ch){ for(var i=0;i<pts.length;i+=2){ var x=pts[i], y=pts[i+1]; if(g[y] && x>=0 && x<g[0].length) g[y][x]=ch; } }
// Re-letter only cells that currently hold `from` (for shading inside a shape).
function pxTint(g,test,from,to){ for(var y=0;y<g.length;y++) for(var x=0;x<g[0].length;x++) if(g[y][x]===from && test(x,y)) g[y][x]=to; }
function pxKeeperGrid(expr){
  var g=pxGrid(32,32);
  // hair behind the head + braid over her left shoulder (our right)
  pxEll(g,15.5,16,9.2,9.6,"r");
  pxTint(g,function(x,y){ return x>=21 || y>=21; },"r","q");
  // shoulders: blouse, then apron bib + straps
  pxEll(g,15.5,34.5,13.5,9,"n");
  pxTint(g,function(x,y){ return x>=23; },"n","N");
  pxRect(g,11,27,20,31,"a"); pxRect(g,11,27,12,31,"A"); pxRect(g,19,27,20,31,"g");
  pxDot(g,[10,26,9,25,8,26, 21,26,22,25,23,26],"a");
  pxRect(g,13,29,18,30,"g"); pxDot(g,[15,29,16,29],"y");
  // neck + collar
  pxRect(g,14,22,17,26,"t"); pxRect(g,15,22,16,24,"s");
  pxDot(g,[12,26,13,26,14,27,17,27,18,26,19,26],"N");
  // face
  pxEll(g,15.5,16.6,6.4,6.9,"s");
  pxTint(g,function(x,y){ return x>=20 || y>=22; },"s","t");
  pxDot(g,[10,14,10,15],"S");
  // bangs swept to her right, a parting at x 16-17
  pxRect(g,10,10,21,11,"r");
  pxDot(g,[10,12,11,12,12,12,13,12,14,12,15,12, 19,12,20,12,21,12, 10,13,11,13,21,13, 10,14,21,14],"r");
  pxDot(g,[12,11,13,11,18,11,19,11],"R");
  // braid
  pxEll(g,23.6,20.6,2.2,2.2,"r"); pxEll(g,24.4,23.6,2.1,2.1,"r"); pxEll(g,24.8,26.4,1.9,1.9,"r");
  pxDot(g,[23,19,24,22,24,25],"R"); pxDot(g,[22,22,23,25,24,28],"q");
  pxDot(g,[24,28,25,28,24,29,25,29],"b"); pxDot(g,[24,30,25,30,25,31],"r");
  // straw sun hat: brim, crown, band, a flower
  pxEll(g,15.5,9.4,14.2,2.7,"h");
  pxTint(g,function(x,y){ return y>=11; },"h","j");
  pxTint(g,function(x,y){ return y<=7 && x<=12; },"h","H");
  pxRect(g,10,2,21,7,"h"); pxRect(g,11,1,20,1,"h");
  pxRect(g,10,2,12,6,"H"); pxRect(g,20,2,21,6,"j");
  pxRect(g,10,6,21,7,"b");
  pxDot(g,[22,3, 21,4,22,4,23,4, 20,5,21,5,23,5,24,5, 21,6,22,6,23,6, 22,7],"f");
  pxDot(g,[21,4,23,4,22,3],"F"); pxDot(g,[22,5],"c");
  // face shadow under the brim
  pxDot(g,[13,13,14,13,15,13,16,13,17,13,18,13],"t");
  pxKeeperFace(g, expr||"smile");
  return g;
}
// Eyes, brows, blush and mouth for one expression (smile, happy, talk, wink, wow, sad, sleep, blink).
function pxKeeperFace(g, ex){
  var E="e", L=[12,13], R=[18,19];
  // brows
  if(ex==="wow") pxDot(g,[11,12,12,12,13,12, 18,12,19,12,20,12],"q");
  else if(ex==="sad") pxDot(g,[11,14,12,13,13,13, 18,13,19,13,20,14],"q");
  else pxDot(g,[11,13,12,13,13,13, 18,13,19,13,20,13],"q");
  // eyes
  if(ex==="happy"){ pxDot(g,[11,16,12,15,13,15,14,16, 17,16,18,15,19,15,20,16],E); }
  else if(ex==="sleep"||ex==="blink"){ pxDot(g,[11,16,12,16,13,16, 18,16,19,16,20,16],E); }
  else {
    pxDot(g,[L[0],15,L[1],15,L[0],16,L[1],16,L[0],17,L[1],17],E); pxDot(g,[L[0],15],"w");
    if(ex==="wink") pxDot(g,[17,16,18,15,19,15,20,16],E);
    else { pxDot(g,[R[0],15,R[1],15,R[0],16,R[1],16,R[0],17,R[1],17],E); pxDot(g,[R[0],15],"w"); }
    if(ex==="wow") pxDot(g,[L[0],14,L[1],14,R[0],14,R[1],14],E);
  }
  // blush, freckles, nose
  pxDot(g,[11,19,12,19,19,19,20,19],"p");
  pxDot(g,[12,18,19,18],"t");
  pxDot(g,[15,18],"t");
  // mouth
  if(ex==="happy"||ex==="talk") pxDot(g,[14,20,15,20,16,20,17,20, 15,21,16,21],"m"), pxDot(g,[15,21,16,21],"M");
  else if(ex==="wow") pxDot(g,[15,20,16,20,15,21,16,21],"m");
  else if(ex==="sad") pxDot(g,[14,21,15,20,16,20,17,21],"m");
  else if(ex==="sleep") pxDot(g,[15,21,16,21],"m");
  else pxDot(g,[14,20,15,21,16,21,17,20],"m");
}

/* ---- painting ---- */
function pxPaintGrid(grid, pal, outline, soft){
  var h=grid.length, w=grid[0].length, cv=document.createElement("canvas");
  cv.width=w; cv.height=h;
  var c=cv.getContext("2d"); if(!c) return cv;
  soft=soft||"";
  if(outline){
    var solid=function(x,y){ if(x<0||y<0||x>=w||y>=h) return false; var ch=grid[y][x]; return ch!=="." && ch!=="k" && soft.indexOf(ch)<0; };
    var add=[];
    for(var y=0;y<h;y++) for(var x=0;x<w;x++){
      if(grid[y][x]==="." && (solid(x-1,y)||solid(x+1,y)||solid(x,y-1)||solid(x,y+1))) add.push(x,y);
    }
    for(var i=0;i<add.length;i+=2) grid[add[i+1]][add[i]]="k";
  }
  for(var yy=0;yy<h;yy++) for(var xx=0;xx<w;xx++){
    var ch=grid[yy][xx]; if(ch===".") continue;
    var col = ch==="k" ? (outline||pal.k) : pal[ch]; if(!col) continue;
    c.fillStyle=col; c.fillRect(xx,yy,1,1);
  }
  return cv;
}
var PX_CANVAS={}, PX_URL={};
function pxCanvas(key){
  if(PX_CANVAS[key]) return PX_CANVAS[key];
  var cv=null;
  if(key.indexOf("keeper:")===0){
    cv=pxPaintGrid(pxKeeperGrid(key.slice(7)), PX_KEEPER_PAL, "#3b2418", "");
  } else {
    var s=PX_ART[key]; if(!s) return null;
    cv=pxPaintGrid(s.r.map(function(r){ return r.split(""); }), s.p||{}, s.k||null, s.n||"");
  }
  PX_CANVAS[key]=cv; return cv;
}
function pxURL(key){
  if(PX_URL[key]!=null) return PX_URL[key];
  var cv=pxCanvas(key), u="";
  try{ u=cv ? cv.toDataURL("image/png") : ""; }catch(e){ u=""; }
  PX_URL[key]=u; return u;
}

/* ---- a 5x7 pixel font (bits, left = 16) for signs, the calendar and the coin counter ---- */
var PX_FONT = {
  A:[14,17,17,31,17,17,17], B:[30,17,17,30,17,17,30], C:[14,17,16,16,16,17,14], D:[30,17,17,17,17,17,30],
  E:[31,16,16,30,16,16,31], F:[31,16,16,30,16,16,16], G:[14,17,16,23,17,17,15], H:[17,17,17,31,17,17,17],
  I:[14,4,4,4,4,4,14], J:[7,2,2,2,2,18,12], K:[17,18,20,24,20,18,17], L:[16,16,16,16,16,16,31],
  M:[17,27,21,21,17,17,17], N:[17,17,25,21,19,17,17], O:[14,17,17,17,17,17,14], P:[30,17,17,30,16,16,16],
  Q:[14,17,17,17,21,18,13], R:[30,17,17,30,20,18,17], S:[15,16,16,14,1,1,30], T:[31,4,4,4,4,4,4],
  U:[17,17,17,17,17,17,14], V:[17,17,17,17,17,10,4], W:[17,17,17,21,21,21,10], X:[17,17,10,4,10,17,17],
  Y:[17,17,10,4,4,4,4], Z:[31,1,2,4,8,16,31],
  "0":[14,17,19,21,25,17,14], "1":[4,12,4,4,4,4,14], "2":[14,17,1,2,4,8,31], "3":[31,2,4,2,1,17,14],
  "4":[2,6,10,18,31,2,2], "5":[31,16,30,1,1,17,14], "6":[6,8,16,30,17,17,14], "7":[31,1,2,4,8,8,8],
  "8":[14,17,17,14,17,17,14], "9":[14,17,17,15,1,2,12],
  "&":[12,18,20,8,21,18,13], "'":[4,4,0,0,0,0,0], "!":[4,4,4,4,4,0,4], ":":[0,0,4,0,0,4,0],
  "-":[0,0,0,14,0,0,0], ".":[0,0,0,0,0,0,4], "/":[1,1,2,4,8,16,16], " ":[0,0,0,0,0,0,0]
};
function pxTextW(str, sc){ sc=sc||1; return Math.max(0, (String(str).length*6-1)*sc); }
function pxText(c, str, x, y, col, shadow, sc){
  str=String(str).toUpperCase(); sc=sc||1;
  if(shadow) pxText(c, str, x+sc, y+sc, shadow, null, sc);
  c.fillStyle=col;
  for(var i=0;i<str.length;i++){
    var gl=PX_FONT[str.charAt(i)] || PX_FONT[" "];
    for(var r=0;r<7;r++){ var bits=gl[r]; for(var b=0;b<5;b++) if(bits & (16>>b)) c.fillRect(x+(i*6+b)*sc, y+r*sc, sc, sc); }
  }
}

/* ===== The shop interior: drawn at 1 logical pixel per canvas pixel, scaled up by CSS ===== */
var SV_H = 120;
var SV_SKY = {
  dawn:["#f49a7c","#ffc49a","#ffe4bd"], day:["#78bdf2","#a3d4fa","#d2ebff"],
  dusk:["#5f4b97","#d9735a","#ffae78"], night:["#121838","#1c2756","#2a376c"]
};
var SV_SEASON_ART = {
  spring:{g:"#7ccf5a", g2:"#5aae46", f:"#ffb3d1", f2:"#f285b4", hill:"#9ad86e"},
  summer:{g:"#5cbd47", g2:"#3f9a37", f:"#3f9b45", f2:"#2e7a35", hill:"#79c95a"},
  fall:  {g:"#c2a64a", g2:"#9c8436", f:"#f0912e", f2:"#c9542a", hill:"#d0b25a"},
  winter:{g:"#eef4fa", g2:"#d3e1ee", f:"#ffffff", f2:"#dbe6f1", hill:"#f6f9fc"}
};
var SV_MONTHS=["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
var SV_SEASON_HEAD={spring:"#e8679a", summer:"#e2a52b", fall:"#d7642a", winter:"#5d9bd6"};

// Where everything sits for a scene `W` logical pixels wide. Shared by the canvas and the
// buttons laid over it, so a click target always lines up with what's drawn.
function svLayout(W){
  W=Math.max(160, W|0);
  var L={W:W, H:SV_H, cx:Math.round(W/2)};
  var cw=Math.max(150, Math.min(250, Math.round(W*0.56)));
  L.counter={x0:L.cx-Math.round(cw/2), x1:L.cx+Math.round(cw/2), top:80};
  L.keeper={x:L.counter.x0+16, y:48, w:32, h:32};
  L.bell={x:L.keeper.x+36, y:70, w:12, h:10};
  var room=L.counter.x1-24-(L.bell.x+L.bell.w+4), n=Math.max(1, Math.min(3, Math.floor((room+4)/20)));
  L.feature=[]; for(var i=0;i<n;i++) L.feature.push({x:L.bell.x+L.bell.w+4+i*20, y:64, w:16, h:16});
  L.cat={x:L.counter.x1-20, y:70, w:18, h:10};
  var sw=W>=300 ? pxTextW("GENERAL STORE")+14 : pxTextW("STORE")+14;
  L.sign={x:L.cx-Math.round(sw/2), y:20, w:sw, h:15, text:W>=300 ? "GENERAL STORE" : "STORE"};
  var ww=Math.max(32, Math.min(52, Math.round(W*0.13)));
  L.win={x:10, y:13, w:ww, h:34};
  L.cal={x:L.win.x+ww+9, y:17, w:19, h:23};
  L.clock={x:L.cal.x+L.cal.w+7, y:18, r:7};
  if(L.clock.x+16 > L.sign.x) L.clock=null;
  if(L.cal.x+L.cal.w+4 > L.sign.x) L.cal=null;
  var sx0=Math.max(L.sign.x+L.sign.w+10, Math.round(W*0.6)), sx1=W-8;
  L.shelves=[];
  if(sx1-sx0>=44){ L.shelves.push({x0:sx0, x1:sx1, y:31}); L.shelves.push({x0:sx0, x1:sx1, y:53}); }
  L.slots=[];
  L.shelves.forEach(function(s){
    var k=Math.floor((s.x1-s.x0-4)/20), pad=Math.floor((s.x1-s.x0-k*20+4)/2);
    for(var j=0;j<k;j++) L.slots.push({x:s.x0+pad+j*20, y:s.y-16, w:16, h:16});
  });
  // lamps hang in the wall gaps wide enough for one: never over the window, calendar, clock,
  // sign or the shelves (their items stand up to the beam)
  var busy=[[L.win.x-2, L.win.x+L.win.w+2], [L.sign.x-3, L.sign.x+L.sign.w+3]];
  if(L.cal) busy.push([L.cal.x-2, L.cal.x+L.cal.w+2]);
  if(L.clock) busy.push([L.clock.x-L.clock.r-2, L.clock.x+L.clock.r+2]);
  if(L.shelves.length) busy.push([L.shelves[0].x0-2, W]);
  busy.sort(function(a,b){ return a[0]-b[0]; });
  L.lamps=[]; var at=0;
  busy.forEach(function(b){ if(b[0]-at>=18) L.lamps.push(Math.round((at+b[0])/2)); at=Math.max(at,b[1]); });
  if(W-at>=18) L.lamps.push(Math.round((at+W)/2));
  L.crate = L.counter.x0>=40 ? {x:6, y:90, w:30, h:22} : null;
  L.board = W-L.counter.x1>=46 ? {x:W-42, y:82, w:34, h:30} : null;
  return L;
}

// Season, time of day and the day's weather. Weather is a pure function of the local date.
function svSeasonOfMonth(m){ return m===11||m<=1 ? "winter" : m<=4 ? "spring" : m<=7 ? "summer" : "fall"; }
function svWeather(day, season){
  var r=hashStr("hq:weather:"+day)%100;
  if(season==="winter") return r<45 ? "clear" : r<62 ? "cloudy" : "snow";
  if(season==="spring") return r<45 ? "clear" : r<60 ? "breeze" : r<75 ? "cloudy" : "rain";
  if(season==="summer") return r<60 ? "clear" : r<75 ? "cloudy" : r<92 ? "rain" : "storm";
  return r<35 ? "clear" : r<60 ? "breeze" : r<78 ? "cloudy" : "rain";
}
function svTod(h){ return h<5 ? "night" : h<7 ? "dawn" : h<17 ? "day" : h<20 ? "dusk" : "night"; }

function svFill(c, col, x, y, w, h){ c.fillStyle=col; c.fillRect(x, y, w, h); }
function svLine(c, col, x0, y0, x1, y1){
  // Bresenham, one pixel wide
  c.fillStyle=col; var dx=Math.abs(x1-x0), dy=-Math.abs(y1-y0), sx=x0<x1?1:-1, sy=y0<y1?1:-1, e=dx+dy;
  for(var n=0;n<200;n++){ c.fillRect(x0, y0, 1, 1); if(x0===x1 && y0===y1) break; var e2=2*e; if(e2>=dy){ e+=dy; x0+=sx; } if(e2<=dx){ e+=dx; y0+=sy; } }
}
function svDisc(c, col, cx, cy, r){
  c.fillStyle=col;
  for(var y=-r;y<=r;y++){ var hw=Math.floor(Math.sqrt(r*r-y*y)+0.35); c.fillRect(cx-hw, cy+y, hw*2+1, 1); }
}

// The static part (everything but weather particles and flickers), cached per key.
function svDrawRoom(c, L, env){
  var W=L.W, H=L.H, sa=SV_SEASON_ART[env.season]||SV_SEASON_ART.fall;
  // wall
  svFill(c,"#efd29b",0,0,W,58);
  for(var x=3;x<W;x+=8){ svFill(c,"#e6c487",x,6,2,52); }
  for(var y=12;y<56;y+=12) for(x=7;x<W;x+=16){ svFill(c,"#dcb878",x,y+((x>>4)&1?6:0),1,1); }
  svFill(c,"#d8b36f",0,6,W,2);
  // wainscot + baseboard
  svFill(c,"#c47f43",0,58,W,2); svFill(c,"#9c5c2c",0,60,W,16);
  for(x=0;x<W;x+=18){ svFill(c,"#874d23",x,60,1,16); svFill(c,"#b06c35",x+3,63,12,1); svFill(c,"#874d23",x+3,72,12,1); }
  svFill(c,"#5b3317",0,76,W,2);
  // floor planks
  for(y=78;y<H;y+=7){
    var row=(y/7)|0, fr=mulberry32(hashStr("hq:plank:"+row));
    svFill(c,row%2 ? "#b37645" : "#a96d3c",0,y,W,7); svFill(c,"#c4884f",0,y,W,1); svFill(c,"#7a4a26",0,y+6,W,1);
    for(x=Math.floor(fr()*40);x<W;x+=48+Math.floor(fr()*40)){ svFill(c,"#7a4a26",x,y+1,1,5); svFill(c,"#c4884f",x+1,y+1,1,5); }
    for(x=Math.floor(fr()*60);x<W;x+=70+Math.floor(fr()*50)) svFill(c,"#93592f",x,y+3,3,1);
  }
  // ceiling beam with a seasonal garland
  svFill(c,"#5b3317",0,0,W,6); svFill(c,"#7a4a26",0,0,W,1); svFill(c,"#3e2210",0,5,W,1);
  for(x=2;x<W;x+=6){
    var gy=6+(((x/6)|0)%2);
    if(env.season==="winter") svFill(c,["#ff5a5a","#ffd23f","#5ad1ff","#7fe07a"][((x/6)|0)%4],x,gy,1,1);
    else { svFill(c,sa.f2,x,6,2,1); svFill(c,sa.f,x+1,gy,1,1); }
  }
  if(env.season==="winter"){ for(x=0;x<W;x+=6) svFill(c,"#2e5a2e",x,6,4,1); }
  svDrawWindow(c, L, env, sa);
  if(L.cal) svDrawCalendar(c, L.cal, env);
  if(L.clock) svDrawClock(c, L.clock, env);
  svDrawSign(c, L);
  L.lamps.forEach(function(lx){ svDrawLamp(c, lx, env); });
  L.shelves.forEach(function(s){ svDrawShelf(c, s); });
  if(L.crate) svDrawCrate(c, L.crate, env);
  if(L.board) svDrawBoard(c, L.board, env);
  svDrawCounter(c, L);
  // rug in front of the counter
  var rx=L.cx-48; svFill(c,"#8a2f2f",rx,114,96,6); svFill(c,"#c9a24a",rx+2,115,92,1);
  for(x=rx+4;x<rx+92;x+=6) svFill(c,"#d8b860",x,117,2,1);
  // light: a sunbeam on clear days, dusk/dawn tint, night with the lamps lit
  if(env.tod==="day" && (env.weather==="clear"||env.weather==="breeze")){
    c.fillStyle="rgba(255,244,200,.16)"; c.beginPath();
    c.moveTo(L.win.x+4, L.win.y+L.win.h); c.lineTo(L.win.x+L.win.w-4, L.win.y+L.win.h);
    c.lineTo(L.win.x+L.win.w+44, H); c.lineTo(L.win.x+24, H); c.closePath(); c.fill();
  }
  if(env.tod==="dawn") svFill(c,"rgba(255,170,120,.08)",0,0,W,H);
  if(env.tod==="dusk") svFill(c,"rgba(255,130,70,.12)",0,0,W,H);
  if(env.tod==="night") svFill(c,"rgba(16,20,52,.36)",0,0,W,H);
}

function svDrawWindow(c, L, env, sa){
  var w=L.win, sky=SV_SKY[env.tod]||SV_SKY.day, gray=env.weather==="cloudy"||env.weather==="rain"||env.weather==="storm"||env.weather==="snow";
  var x0=w.x+2, y0=w.y+2, iw=w.w-4, ih=w.h-4, band=Math.ceil(ih*0.55/3);
  for(var i=0;i<3;i++){
    var col=sky[i]; if(gray && env.tod!=="night") col=["#8e9bab","#a9b4c1","#c4ccd6"][i];
    svFill(c,col,x0,y0+i*band,iw,band+1);
    if(i<2) for(var x=x0+(i%2);x<x0+iw;x+=2) svFill(c,col,x,y0+(i+1)*band,1,1);
  }
  var hz=y0+Math.round(ih*0.58);
  // sun or moon, and stars
  if(env.tod==="night"){
    var rng=mulberry32(hashStr("hq:stars:"+env.day));
    for(i=0;i<9;i++) svFill(c,"#fff6c8",x0+Math.floor(rng()*iw),y0+Math.floor(rng()*(hz-y0-4)),1,1);
    svDisc(c,"#f5efc8",x0+iw-9,y0+6,3); svDisc(c,sky[0],x0+iw-8,y0+5,2);
  } else if(!gray){
    var sy=env.tod==="day" ? y0+6 : hz-5;
    svDisc(c,env.tod==="day" ? "#ffe066" : "#ffb04a",x0+iw-9,sy,env.tod==="day"?3:4);
  }
  // hills, ground, a fence and the tree
  for(x=x0;x<x0+iw;x++){
    var hh=Math.round(3+2*Math.sin((x+env.dayN)*0.35)+1.5*Math.sin(x*0.13));
    svFill(c,sa.hill,x,hz-hh,1,hh);
  }
  svFill(c,sa.g,x0,hz,iw,y0+ih-hz); svFill(c,sa.g2,x0,hz,iw,1);
  for(x=x0+2;x<x0+iw;x+=5){ svFill(c,"#a8754a",x,hz+2,1,4); }
  svFill(c,"#a8754a",x0,hz+3,iw,1);
  var tx=x0+Math.round(iw*0.32), ty=hz;
  svFill(c,"#6b4423",tx,ty-11,2,12);
  if(env.season==="winter"){
    svLine(c,"#6b4423",tx,ty-8,tx-4,ty-12); svLine(c,"#6b4423",tx+1,ty-9,tx+5,ty-13);
    svFill(c,"#ffffff",tx-5,ty-13,2,1); svFill(c,"#ffffff",tx+4,ty-14,2,1);
  } else {
    svDisc(c,sa.f2,tx+1,ty-14,6); svDisc(c,sa.f,tx,ty-15,5);
    var rf=mulberry32(hashStr("hq:fruit:"+env.season));
    var dot=env.season==="spring" ? "#ffffff" : env.season==="summer" ? "#ff5a5a" : "#ffd23f";
    for(i=0;i<5;i++) svFill(c,dot,tx-4+Math.floor(rf()*9),ty-19+Math.floor(rf()*8),1,1);
  }
  if(gray){ // clouds
    svDisc(c,"#d9dee6",x0+8,y0+5,4); svDisc(c,"#e7ebf0",x0+13,y0+4,4); svDisc(c,"#d9dee6",x0+iw-10,y0+8,3);
  } else if(env.tod==="day"){
    svDisc(c,"#ffffff",x0+7,y0+9,2); svDisc(c,"#ffffff",x0+10,y0+8,3);
  }
  if(env.season==="winter" && env.weather!=="rain"){ svFill(c,"#ffffff",x0,y0+ih-2,iw,2); }
  // frame, mullions, sill and a flower box
  svFill(c,"#5b3317",w.x,w.y,w.w,2); svFill(c,"#5b3317",w.x,w.y+w.h-2,w.w,2);
  svFill(c,"#5b3317",w.x,w.y,2,w.h); svFill(c,"#5b3317",w.x+w.w-2,w.y,2,w.h);
  svFill(c,"#7a4a26",w.x+Math.floor(w.w/2)-1,w.y,2,w.h); svFill(c,"#7a4a26",w.x,w.y+Math.floor(w.h/2)-1,w.w,2);
  svFill(c,"rgba(255,255,255,.22)",x0+1,y0+1,1,6); svFill(c,"rgba(255,255,255,.22)",x0+2,y0+1,1,3);
  svFill(c,"#c47f43",w.x-2,w.y+w.h,w.w+4,2); svFill(c,"#8a4f24",w.x-2,w.y+w.h+2,w.w+4,1);
  var bx=w.x+2, by=w.y+w.h+3, bw=w.w-4;
  svFill(c,"#9c5c2c",bx,by+2,bw,5); svFill(c,"#7a4a26",bx,by+6,bw,1);
  for(x=bx+2;x<bx+bw-1;x+=4){
    var fc = env.season==="spring" ? (x%8<4 ? "#ff7fb0" : "#ffe14a") : env.season==="summer" ? "#ffd23f"
           : env.season==="fall" ? (x%8<4 ? "#ef7d2a" : "#d9542a") : "#d8303a";
    svFill(c,env.season==="winter" ? "#2e7a35" : "#4f9a44",x,by,1,2); svFill(c,fc,x-1+(x%3===0?1:0),by-1,2,2);
    if(env.season==="winter") svFill(c,"#ffffff",x-1,by-2,2,1);
  }
}
function svDrawCalendar(c, k, env){
  svFill(c,"#7a4a26",k.x+k.w/2-1|0,k.y-3,2,3);
  svFill(c,"#fffaf0",k.x,k.y,k.w,k.h); svFill(c,"#d8c8a8",k.x,k.y+k.h-1,k.w,1); svFill(c,"#d8c8a8",k.x+k.w-1,k.y,1,k.h);
  svFill(c,SV_SEASON_HEAD[env.season]||"#d7642a",k.x,k.y,k.w,9);
  pxText(c,SV_MONTHS[env.month],k.x+1,k.y+1,"#ffffff",null);
  var d=String(env.date);
  pxText(c,d,k.x+Math.round((k.w-pxTextW(d))/2),k.y+12,"#3d2210",null);
}
function svDrawClock(c, k, env){
  svDisc(c,"#6b3f22",k.x,k.y+k.r,k.r); svDisc(c,"#fff4dc",k.x,k.y+k.r,k.r-2);
  var cy=k.y+k.r, h=env.hour%12, m=env.min;
  var ah=(h+m/60)/12*Math.PI*2, am=m/60*Math.PI*2;
  svLine(c,"#3d2210",k.x,cy,k.x+Math.round(Math.sin(ah)*3),cy-Math.round(Math.cos(ah)*3));
  svLine(c,"#8a2f2f",k.x,cy,k.x+Math.round(Math.sin(am)*4),cy-Math.round(Math.cos(am)*4));
  svFill(c,"#3d2210",k.x,k.y+2,1,1);
}
function svDrawSign(c, L){
  var s=L.sign;
  svFill(c,"#3e2210",s.x+6,6,1,s.y-6); svFill(c,"#3e2210",s.x+s.w-7,6,1,s.y-6);
  svFill(c,"#3e2210",s.x,s.y,s.w,s.h); svFill(c,"#a8612c",s.x+1,s.y+1,s.w-2,s.h-2);
  svFill(c,"#c97d3f",s.x+1,s.y+1,s.w-2,1); svFill(c,"#7a4520",s.x+1,s.y+s.h-2,s.w-2,1);
  pxText(c,s.text,s.x+7,s.y+4,"#fff0c8","#4a240c");
}
function svDrawLamp(c, x, env){
  svFill(c,"#3e2210",x,6,1,5);
  svFill(c,"#8a6a2a",x-3,11,7,1); svFill(c,env.tod==="night"||env.tod==="dusk" ? "#ffe9a0" : "#f3e2b0",x-2,12,5,4);
  svFill(c,"#8a6a2a",x-3,16,7,1);
}
function svDrawShelf(c, s){
  svFill(c,"#c98a4e",s.x0,s.y,s.x1-s.x0,1); svFill(c,"#9a5a2c",s.x0,s.y+1,s.x1-s.x0,2); svFill(c,"rgba(60,30,10,.25)",s.x0,s.y+3,s.x1-s.x0,2);
  [s.x0+3, s.x1-5].forEach(function(bx){ svFill(c,"#6b3f22",bx,s.y+3,2,2); svFill(c,"#6b3f22",bx+1,s.y+5,1,2); });
}
function svDrawCounter(c, L){
  var k=L.counter, w=k.x1-k.x0;
  svFill(c,"#e8b87a",k.x0-3,80,w+6,1); svFill(c,"#d39a5b",k.x0-3,81,w+6,2); svFill(c,"#8a4f24",k.x0-3,83,w+6,1);
  svFill(c,"#a5622f",k.x0,84,w,26);
  for(var x=k.x0;x<k.x1;x+=9){ svFill(c,"#8f5228",x,84,1,26); svFill(c,"#b26c36",x+1,86,1,22); }
  svFill(c,"#c8854a",k.x0,88,w,1); svFill(c,"#c8854a",k.x0,105,w,1); svFill(c,"#6e3a17",k.x0,109,w,1);
  svFill(c,"rgba(40,20,5,.35)",k.x0-2,110,w+4,2);
}
function svDrawCrate(c, k, env){
  var fruit={spring:"strawberry", summer:"watermelon", fall:"apple", winter:"chestnuts"}[env.season]||"apple";
  var sp=pxCanvas(fruit);
  if(sp){ c.drawImage(sp,k.x-1,k.y-9); c.drawImage(sp,k.x+7,k.y-11); c.drawImage(sp,k.x+15,k.y-8); }
  svFill(c,"#9c6a3a",k.x,k.y,k.w,k.h); svFill(c,"#5b3317",k.x,k.y,k.w,1); svFill(c,"#5b3317",k.x,k.y+k.h-1,k.w,1);
  svFill(c,"#5b3317",k.x,k.y,1,k.h); svFill(c,"#5b3317",k.x+k.w-1,k.y,1,k.h);
  for(var y=k.y+5;y<k.y+k.h-1;y+=5) svFill(c,"#7a4a26",k.x+1,y,k.w-2,1);
  svFill(c,"#c49060",k.x+1,k.y+1,k.w-2,1);
}
function svDrawBoard(c, k, env){
  // an A-frame chalkboard with today's special
  svFill(c,"#5b3317",k.x+3,k.y+k.h-3,2,3); svFill(c,"#5b3317",k.x+k.w-5,k.y+k.h-3,2,3);
  svFill(c,"#6b3f22",k.x,k.y,k.w,k.h-2); svFill(c,"#2e4436",k.x+2,k.y+2,k.w-4,k.h-6);
  pxText(c,"TODAY",k.x+3,k.y+3,"#f4f1e4",null);
  var sp=env.special ? pxCanvas(env.special) : null;
  if(sp){ c.drawImage(sp,k.x+3,k.y+11); pxText(c,String(env.specialPrice),k.x+22,k.y+15,"#ffe066",null); svFill(c,"#ffe066",k.x+20,k.y+23,9,1); }
  else pxText(c,"FRESH",k.x+3,k.y+14,"#9fd8a8",null);
}

// Weather and flickers, drawn every frame over the cached room.
function svDrawLive(c, L, env, t){
  var w=L.win, x0=w.x+2, y0=w.y+2, iw=w.w-4, ih=w.h-4, i, rng=mulberry32(hashStr("hq:wx:"+env.day));
  var mid=w.x+Math.floor(w.w/2)-1, midy=w.y+Math.floor(w.h/2)-1;
  function pane(x,y){ return x>=x0 && x<x0+iw && y>=y0 && y<y0+ih && !(x>=mid && x<mid+2) && !(y>=midy && y<midy+2); }
  if(env.weather==="rain"||env.weather==="storm"){
    for(i=0;i<(env.weather==="storm"?28:18);i++){
      var rx=rng()*iw, ry=rng()*ih, sp=0.09+rng()*0.05;
      var px=x0+Math.floor((rx+t*0.025)%iw), py=y0+Math.floor((ry+t*sp)%ih);
      for(var d=0;d<3;d++) if(pane(px,py+d)) svFill(c,"rgba(170,205,255,.85)",px,py+d,1,1);
    }
    if(env.weather==="storm" && Math.floor(t/1000)%11===0 && (t%1000)<90) svFill(c,"rgba(255,255,255,.55)",x0,y0,iw,ih);
  } else if(env.weather==="snow"){
    for(i=0;i<16;i++){
      var sx=rng()*iw, sy=rng()*ih, ph=rng()*6;
      var fx=x0+Math.floor((sx+Math.sin(t*0.0015+ph)*2+iw)%iw), fy=y0+Math.floor((sy+t*0.012)%ih);
      if(pane(fx,fy)) svFill(c,"#ffffff",fx,fy,1,1);
    }
  } else if(env.weather==="breeze" && (env.season==="fall"||env.season==="spring")){
    var col=env.season==="fall" ? ["#f0912e","#c9542a","#ffd23f"] : ["#ffb3d1","#ffffff","#f285b4"];
    for(i=0;i<7;i++){
      var lx=rng()*iw, ly=rng()*ih, ph2=rng()*6;
      var qx=x0+Math.floor((lx+t*0.02)%iw), qy=y0+Math.floor((ly+t*0.01+Math.sin(t*0.003+ph2)*2+ih)%ih);
      if(pane(qx,qy)) svFill(c,col[i%3],qx,qy,env.season==="fall"?2:1,1);
    }
  }
  if(env.tod==="night"||env.tod==="dusk"){
    L.lamps.forEach(function(lx,j){
      var a=0.10+0.03*Math.sin(t*0.004+j*2);
      for(var r=14;r>=4;r-=5) { c.fillStyle="rgba(255,214,140,"+(a*(1-(r-4)/14)).toFixed(3)+")"; svDiscA(c,lx,14,r); }
    });
  }
  if(env.season==="winter" && env.tod==="night"){
    for(var x=2;x<L.W;x+=6) if(((x/6|0)+Math.floor(t/600))%3===0) svFill(c,"#ffffff",x,6+(((x/6)|0)%2),1,1);
  }
}
function svDiscA(c, cx, cy, r){ for(var y=-r;y<=r;y++){ var hw=Math.floor(Math.sqrt(r*r-y*y)); c.fillRect(cx-hw, cy+y, hw*2+1, 1); } }

