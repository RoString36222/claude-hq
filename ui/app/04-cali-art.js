/* ===== Cali Tuesdays diner: original pixel food (16x16) for the counter and the plates ===== */
// Taco shells share one shape; the filling (mild/wild) and the shell (hard/soft) swap palettes.
var CD_TACO_ROWS_MILD = [
  "................",
  "................",
  "................",
  "....gG.Gg.gG....",
  "..gGgyGgwgGyGg..",
  ".gGyrGgyGgrGygg.",
  ".hhhhhhhhhhhhhs.",
  ".hSSSSSSSSSSSSs.",
  ".SSSdSSSSSdSSSs.",
  "..SSSSSSSdSSSs..",
  "..sSSdSSSSSSss..",
  "...sSSSSSdSss...",
  "....ssSSSSss....",
  "......dddd......",
  "................",
  "................"];
var CD_TACO_ROWS_WILD = [
  "...........F....",
  "..........FfF...",
  "..........fef...",
  "....mR.Rm..f....",
  "..RmRoRmRgRoR...",
  ".RmoRmRgRmRomRR.",
  ".hhhhhhhhhhhhhs.",
  ".hSSSSSSSSSSSSs.",
  ".SSSdSSSSSdSSSs.",
  "..SSSSSSSdSSSs..",
  "..sSSdSSSSSSss..",
  "...sSSSSSdSss...",
  "....ssSSSSss....",
  "......dddd......",
  "................",
  "................"];
var CD_HARD = {S:"#f3c34e", s:"#d99a2b", h:"#ffe28a", d:"#b8761a"};
var CD_SOFT = {S:"#f6e3b4", s:"#dcbc85", h:"#fff3d6", d:"#b9874e"};
var CD_MILD = {g:"#5aa83c", G:"#8fd45f", y:"#ffd34d", w:"#fff6e0", r:"#e5533d"};
var CD_WILD = {R:"#d9381e", m:"#7a3a1e", o:"#f08a2a", g:"#5aa83c", F:"#ffd23f", f:"#ff7a1c", e:"#e8301a"};
function cdMix(a, b){ var o={}, k; for(k in a) o[k]=a[k]; for(k in b) o[k]=b[k]; return o; }
PX_ART.cd_mh={k:"#5a3a10", p:cdMix(CD_HARD, CD_MILD), r:CD_TACO_ROWS_MILD};
PX_ART.cd_ms={k:"#5a3a10", p:cdMix(CD_SOFT, CD_MILD), r:CD_TACO_ROWS_MILD};
PX_ART.cd_wh={k:"#5a2408", n:"Ffe", p:cdMix(CD_HARD, CD_WILD), r:CD_TACO_ROWS_WILD};
PX_ART.cd_ws={k:"#5a2408", n:"Ffe", p:cdMix(CD_SOFT, CD_WILD), r:CD_TACO_ROWS_WILD};

// A capsule from (x0,y0) to (x1,y1) of radius r; colorAt(t along, side across, x, y) -> a letter.
function cdCapsule(rows, x0, y0, x1, y1, r, colorAt){
  var dx=x1-x0, dy=y1-y0, L2=dx*dx+dy*dy, L=Math.sqrt(L2);
  for(var y=0;y<rows.length;y++){
    var row=rows[y].split("");
    for(var x=0;x<row.length;x++){
      var px=x+0.5, py=y+0.5, t=Math.max(0, Math.min(1, ((px-x0)*dx+(py-y0)*dy)/L2));
      var cx=x0+t*dx, cy=y0+t*dy, ex=px-cx, ey=py-cy;
      if(ex*ex+ey*ey>r*r) continue;
      var side=(ex*(-dy)+ey*dx)/L;
      var ch=colorAt(t, side, x, y); if(ch) row[x]=ch;
    }
    rows[y]=row.join("");
  }
  return rows;
}
function cdBlank(w, h){ var a=[]; for(var i=0;i<h;i++) a.push(new Array(w+1).join(".")); return a; }
PX_ART.cd_burrito={k:"#4a2e12", p:{t:"#f2d7a2", T:"#fff0cf", d:"#cfa66a", c:"#b98a4e", f:"#c9ced8", F:"#f2f4f8", e:"#8f96a3",
    w:"#fbfaf2", b:"#5a3420", r:"#d9452e", g:"#5aa83c", o:"#d8b27a"},
  r:cdCapsule(cdBlank(16,16), 3.2, 12.8, 12.6, 3.4, 3.4, function(t, side, x, y){
    if(t>0.86){ var q=(x*3+y*5)%4; return Math.abs(side)>2.5 ? "o" : ["w","b","r","g"][q]; }
    if(t<0.48){ if((x+2*y)%5===0) return "e"; return side<-1.1 ? "F" : side>1.6 ? "e" : "f"; }
    if((x*7+y*3)%11===0) return "c";
    return side<-1.2 ? "T" : side>1.7 ? "d" : "t";
  })};
PX_ART.cd_churros={k:"#4a2408", n:"x", p:{a:"#d9902e", A:"#f4b45a", d:"#a8611a", x:"#fffaf0", c:"#5a2e14", C:"#7d4220", m:"#e8dcc8", M:"#ffffff"},
  r:(function(){
    var rows=cdBlank(16,16);
    function stick(x0,y0,x1,y1){ cdCapsule(rows, x0,y0,x1,y1, 1.6, function(t, side, x, y){
      if((Math.round(t*14))%2===0) return side>0.4 ? "d" : "a";
      return side<-0.3 ? "A" : "a"; }); }
    stick(3.2,12.5,8.2,2.2); stick(6.8,12.5,12.6,3.0);
    // a cup of chocolate to dip in
    for(var y=10;y<15;y++){ var w=y<14 ? 5 : 3, x0=y<14 ? 9 : 10; var r=rows[y].split(""); for(var x=x0;x<x0+w;x++) r[x]= y===10 ? (x%2 ? "C" : "c") : (y===11 ? "M" : "m"); rows[y]=r.join(""); }
    var s=rows[4].split(""); s[3]="x"; rows[4]=s.join(""); s=rows[7].split(""); s[12]="x"; rows[7]=s.join(""); s=rows[2].split(""); s[13]="x"; rows[2]=s.join("");
    return rows; })()};

PX_ART.cd_ricebowl={k:"#4a2410", p:{w:"#fbfaf2", W:"#ffffff", b:"#3a2418", B:"#5a3a26", c:"#ffd34d", r:"#e5533d", g:"#7bc25a", G:"#5aa83c",
    H:"#f2f2ee", P:"#e2e2dc", p:"#c8c8c0", q:"#a8a8a0", t:"#3f8fa6"}, r:[
  "................",
  "................",
  "................",
  "....wwwbbbcc....",
  "..rrwWwwbBbccc..",
  ".rrRrwwWwbbcccg.",
  ".rrrwwwwbbbccgG.",
  ".HHHHHHHHHHHHHH.",
  ".PtPPtPPtPPtPPq.",
  "..PPPPPPPPPPPq..",
  "..pPPPPPPPPPqq..",
  "...pPPPPPPPqq...",
  "....ppppppqq....",
  ".....qqqqqq.....",
  "................",
  "................"]};
PX_ART.cd_ricebowl.p.R="#ff7a5c";
PX_ART.cd_saladbowl={k:"#3a2410", p:{g:"#5aa83c", G:"#8fd45f", L:"#c4ec8a", r:"#e5533d", c:"#ffd34d", y:"#ffe88a", w:"#fff6e0",
    H:"#d9a066", P:"#b07a46", p:"#8a5a30", q:"#6a4222", l:"#c98a4e"}, r:[
  "................",
  "................",
  "....G.gL.G......",
  "...gGLgrGgLg....",
  "..gLgGcgLrgGgL..",
  ".gGrgLgGyGgcLGg.",
  ".gLgGgwLgGrgGgg.",
  ".HHHHHHHHHHHHHH.",
  ".PPlPPPPlPPPPlq.",
  "..PPPPPPPPPPPq..",
  "..pPPPlPPPPPqq..",
  "...pPPPPPPPqq...",
  "....ppppppqq....",
  ".....qqqqqq.....",
  "................",
  "................"]};
PX_ART.cd_quesadilla={k:"#4a2a08", p:{T:"#f6d48a", t:"#e8b866", d:"#b8762a", y:"#ffd23f", Y:"#ffe88a", o:"#f0a020"}, r:[
  "................",
  "................",
  "........TT......",
  ".......TtTT.....",
  "......TtdtTT....",
  ".....TtttdtTT...",
  "....TdttttdtTT..",
  "...TttdtttttdTo.",
  "..TTttttdtttttd.",
  ".TtdtttttdtttTd.",
  ".yyYyyyYyyyyYyo.",
  ".TtttdtttttdtTd.",
  "..TTttttdtttTd..",
  "....TTTttttdd...",
  "........ddd.....",
  "................"]};
PX_ART.cd_nachos={k:"#4a2a08", p:{c:"#f3c34e", C:"#ffe28a", d:"#d0962a", y:"#ffb020", Y:"#ffd25a", j:"#4f9a3a", J:"#9ad06a", r:"#e5533d", P:"#4a4a52", p:"#2f2f36"}, r:[
  "................",
  "................",
  ".......C........",
  "......CcC..C....",
  "....C.ccdCCcC...",
  "...CcYyccdcccC..",
  "..CcyJjYcyrccdC.",
  ".CcccYycJjcyYcd.",
  ".cdcCccyycrccdd.",
  ".PPPPPPPPPPPPPP.",
  "..pPPPPPPPPPPp..",
  "...pppppppppp...",
  "................",
  "................",
  "................",
  "................"]};
PX_ART.cd_tostada={k:"#4a2a08", p:{T:"#f3c34e", t:"#d99a2b", h:"#ffe28a", b:"#7a4a2a", g:"#5aa83c", G:"#8fd45f", r:"#e5533d", y:"#ffd34d", w:"#fff6e0"}, r:[
  "................",
  "................",
  "................",
  "................",
  "....hhhhhhhh....",
  "..hTbbgGrgbbTh..",
  ".hTbgGywwGrbbTt.",
  ".TbrgGyGwgGybbt.",
  ".TtbbgGrgGybbtt.",
  "..ttTbbbbbbbtt..",
  "....tttttttt....",
  "................",
  "................",
  "................",
  "................",
  "................"]};
PX_ART.cd_chips={k:"#3a1a0a", p:{c:"#f3c34e", C:"#ffe28a", d:"#d0962a", R:"#d9381e", W:"#fff6f0", s:"#e5533d", S:"#ff8a6a", z:"#b8b8c0", Z:"#e8e8ee"}, r:[
  "................",
  "................",
  "................",
  "....C..C........",
  "...CcCcCcC......",
  "..CccdCcdcC.....",
  "..cdcCcccdc.....",
  ".RWRWRWRWRWR....",
  ".WRWRWRWRWRW.ZZZ",
  "..RWRWRWRWR.zSsz",
  "..WRWRWRWRW.zssz",
  "...RWRWRWR..zzzz",
  "................",
  "................",
  "................",
  "................"]};
PX_ART.cd_guac={k:"#1f2a14", p:{g:"#6cb04a", G:"#9ad06a", d:"#4f8a36", y:"#f3c34e", Y:"#ffe28a", r:"#e5533d", s:"#6e6e74", S:"#8e8e96", q:"#4e4e54"}, r:[
  "................",
  "................",
  ".........Y......",
  "........YyY.....",
  "........yYy.....",
  "....GGgGyGgg....",
  "..gGgrgGgdgGgg..",
  ".gGgdgGgrgGgdgg.",
  ".SSSSSSSSSSSSSS.",
  ".SsSsSSsSSsSSsq.",
  "..sSSSSSSSSSSq..",
  "..qsSSSsSSSsqq..",
  "...qssssssssq...",
  ".....qqqqqq.....",
  "................",
  "................"]};
PX_ART.cd_soda={k:"#3a0a0a", p:{R:"#e23b3b", r:"#b52626", W:"#ffffff", w:"#e8e8ee", L:"#f4f4f8", l:"#cfcfd8", s:"#ffffff", S:"#e23b3b"}, r:[
  "..........S.....",
  ".........sS.....",
  "........Ss......",
  "........sS......",
  "...LLLLLSLLLL...",
  "...lllllllll....",
  "....RRRRRRRr....",
  "....RWWWWWRr....",
  "....RRRRRRRr....",
  ".....RWWWRr.....",
  ".....RRRRRr.....",
  ".....RRRRRr.....",
  "......RRRr......",
  "......rrrr......",
  "................",
  "................"]};
PX_ART.cd_icedtea={k:"#3a2408", n:"", p:{g:"#cfeaf2", G:"#ffffff", t:"#c8782a", T:"#e8a04a", i:"#f2f8fb", y:"#ffe14a", Y:"#fff3a0", s:"#2f9a6a"}, r:[
  "..........s.....",
  ".........s......",
  "...yYy..s.......",
  "..yYyyg.s.......",
  "...yYgGGsGGGg...",
  "....gGtTsTttg...",
  "....gtiitTitg...",
  "....gTiitiiTg...",
  "....gtTtTtttg...",
  "....gTttiitTg...",
  "....gtTtiiTtg...",
  ".....gtTtttg....",
  ".....gGGGGGg....",
  "......gggg......",
  "................",
  "................"]};
// The plate each friend eats from (32x12), and a crown for the season's champion.
PX_ART.cd_plate={k:"#6a6a78", p:{w:"#ffffff", W:"#f4f4f8", e:"#dcdce6", E:"#c4c4d2", b:"#e9426b"}, r:[
  "........eeeeeeeeeeeeeeee........",
  ".....eeeWWWWWWWWWWWWWWWWeee.....",
  "...eeWWWwwwwwwwwwwwwwwwwWWWee...",
  "..eWWwwwwwwwwwwwwwwwwwwwwwwWWe..",
  ".eWwwwwwwwwwwwwwwwwwwwwwwwwwwWe.",
  ".eWwwwwwwwwwwwwwwwwwwwwwwwwwwWE.",
  ".eWWwwwwwwwwwwwwwwwwwwwwwwwwWWE.",
  "..eWWWwwwwwwwwwwwwwwwwwwwwWWWE..",
  "...eeWWWWwwwwwwwwwwwwwwWWWWEE...",
  ".....bbbWWWWWWWWWWWWWWWWbbb.....",
  "........EEEEEEEEEEEEEEEE........",
  "................................"]};
PX_ART.cd_crown={k:"#6b3d06", p:{y:"#ffd23f", Y:"#fff3a8", o:"#e8a020", r:"#e23b6b", b:"#3fa8e0"}, r:[
  "............",
  ".y...y...y..",
  ".yY.yYy.yY..",
  ".yyyyyyyyy..",
  ".yryybyyry..",
  ".ooooooooo..",
  "............"]};
PX_ART.cd_chili={k:"#4a0a0a", p:{r:"#e02a1a", R:"#ff6a4a", g:"#4f9a3a"}, r:[
  "..........",
  "......gg..",
  ".....gg...",
  "....rRr...",
  "...rRrr...",
  "..rRrr....",
  ".rrr......",
  ".r........",
  ".........."]};

