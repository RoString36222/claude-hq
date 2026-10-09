/* ================= HQ 2.4: your 3D character ================= */
// The person you are in the 3D HQ and Arena City, built in Settings → Character, replaces the 2D
// trainer drawing wherever there is WebGL2: the Trainer card shows a portrait of it, the 3D HQ and the
// city walk it around, and (paired) the Arena gets the portrait so friends' lists show it in place of
// your GitHub picture. The 2D trainer stays as the fallback where WebGL2 isn't available.
//   config.character  ten small numbers, see games/avatar3d.js (CHAR_MAX here mirrors its MAX and
//                     dashboard.py's CHARACTER_MAX; tests/test_character.py keeps the three equal)
//   localStorage hq_char_portrait {sig, url}  the rendered portrait for the current character
//   localStorage hq_char_up       sig of the portrait the Arena has
var CHAR_MAX = [5, 7, 9, 9, 2, 5, 3, 1, 4, 1];
var CHAR_AXES = ["base", "skin", "hairColor", "outfitColor", "hairStyle", "headwear", "accessory", "eyes", "background", "outfitStyle"];
var CHAR_TITLE = {base:"Body", skin:"Skin", hairColor:"Hair color", outfitColor:"Outfit color", hairStyle:"Hair",
                  headwear:"Headwear", accessory:"Accessory", eyes:"Eyes", background:"Portrait background", outfitStyle:"Outfit"};
var CHAR_LABELS = {
  base: ["Ava", "Max", "Cleo", "Leo", "Iris", "Theo"],
  skin: ["Model's own", "Fair", "Light", "Tan", "Brown", "Deep", "Rich", "Chrome"],
  hairColor: ["Model's own", "Black", "Brown", "Auburn", "Blonde", "Platinum", "Grey", "Red", "Blue", "Neon cyan"],
  outfitColor: ["Model's own", "Slate", "Rust", "Green", "Violet", "Gold", "Charcoal", "Rose", "White", "Hot magenta"],
  hairStyle: ["Own hair", "Shaved", "Neon crest"],
  headwear: ["None", "Beanie", "Cap", "Headband", "Party hat", "Neural halo"],
  accessory: ["None", "Round glasses", "Shades", "AR visor"],
  eyes: ["Normal", "Lit eyes"],
  background: ["Theme", "Sunset", "Mint", "Night", "Neon grid"],
  outfitStyle: ["Plain", "Techwear"]
};
var CHAR_PAL = {
  skin: [null, "#f6d7bd", "#eab892", "#d49a6a", "#a46a43", "#6e4429", "#452a1b", "#c9d1db"],
  hairColor: [null, "#26262c", "#5a3a24", "#8a4a2a", "#d9b25f", "#e6e3da", "#9aa0a8", "#b5363b", "#3e63b3", "#5ff3ff"],
  outfitColor: [null, "#4d5d6c", "#b35a3c", "#3f8a5a", "#6b4fb0", "#d2a23a", "#2e3238", "#c1607e", "#e6e8ee", "#ff3fb4"]
};
var CHAR_ORDER = ["base", "skin", "hairStyle", "hairColor", "outfitStyle", "outfitColor", "headwear", "accessory", "eyes", "background"];
var CHAR = {load:null, spec:null, prev:null, busy:false};

function charValid(s){
  return Array.isArray(s) && s.length >= CHAR_MAX.length && CHAR_MAX.every(function(m, i){ var v = s[i]; return v === (v|0) && v >= 0 && v <= m; });
}
function char3dOk(){ return typeof hqWebGL === "function" ? hqWebGL() : false; }
function charHex(h){ var n = parseInt(String(h).slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; }
function charNearest(hex, pal){
  if(!hex) return 0;
  var c = charHex(hex), best = 0, bd = 1e9;
  for(var i = 1; i < pal.length; i++){ var p = charHex(pal[i]), d = 0; for(var k = 0; k < 3; k++) d += (c[k] - p[k])*(c[k] - p[k]); if(d < bd){ bd = d; best = i; } }
  return best;
}
// Your 2D trainer look, carried over once to the nearest 3D choices (06-trainer-packs.js order:
// [skin, hair, hairColor, outfit, outfitColor, hat, accessory, bg, face]).
function charFromTrainer(t){
  t = (typeof _validTrainerSpec === "function" && _validTrainerSpec(t)) ? t : (typeof resolveTrainerSpec === "function" ? resolveTrainerSpec() : [0,0,0,0,0,0,0,0,0]);
  var long = t[1] === 5 || t[1] === 6 || t[1] === 7;
  var base = (long ? [0, 2, 4] : [1, 3, 5])[(t[3] | 0) % 3];
  var hairC = t[2] === (TR_MAX[2]) ? 9 : charNearest(typeof TR_HAIRC !== "undefined" ? TR_HAIRC[t[2]] : null, CHAR_PAL.hairColor);
  var outC = t[4] === (TR_MAX[4]) ? 9 : charNearest(typeof TR_OUTC !== "undefined" ? TR_OUTC[t[4]] : null, CHAR_PAL.outfitColor);
  var skin = t[0] === TR_MAX[0] ? 7 : Math.min(6, (t[0] | 0) + 1);
  var hairStyle = t[1] === TR_MAX[1] ? 2 : t[1] === 0 ? 1 : 0;
  var hat = [0, 1, 2, 3, 2, 1, 3, 5][t[5]] || 0;
  var acc = [0, 1, 1, 0, 0, 3][t[6]] || 0;
  var bg = t[7] === TR_MAX[7] ? 4 : t[7] === 0 ? 0 : ((t[7] - 1) % 3) + 1;
  return [base, skin, hairC, outC, hairStyle, hat, acc, t[8] === TR_MAX[8] ? 1 : 0, bg, t[3] === TR_MAX[3] ? 1 : 0];
}
function charSpec(){
  var c = (typeof CONFIG !== "undefined" && CONFIG) ? CONFIG.character : null;
  if(charValid(c)) return c.slice(0, CHAR_MAX.length);
  try { var l = JSON.parse(localStorage.getItem("hq_char") || "null"); if(charValid(l)) return l.slice(0, CHAR_MAX.length); } catch(e){}
  return charFromTrainer(null);
}
function charSig(s){ return (s || charSpec()).join("."); }

// The 3D engine and the character module, loaded the first time anything needs them.
function charLoad(){
  if(window.HQV && window.HQV.avatar3d) return Promise.resolve(window.HQV.avatar3d);
  if(CHAR.load) return CHAR.load;
  var files = ((window.HQV && window.HQV.engine) ? [] : ["engine"]).concat(["avatar3d"]);
  CHAR.load = files.reduce(function(p, name){
    return p.then(function(){ return new Promise(function(res, rej){
      var sc = document.createElement("script"); sc.src = "/games/" + name + ".js"; sc.async = false;
      sc.onload = res; sc.onerror = function(){ rej(new Error(name + ".js failed to load")); };
      document.head.appendChild(sc);
    }); });
  }, Promise.resolve()).then(function(){ if(!window.HQV || !window.HQV.avatar3d) throw new Error("no avatar3d"); return window.HQV.avatar3d; })
    .catch(function(e){ CHAR.load = null; throw e; });
  return CHAR.load;
}

/* ---------- the portrait ---------- */
function charCached(){
  try { var p = JSON.parse(localStorage.getItem("hq_char_portrait") || "null"); return p && typeof p.url === "string" && p.url.indexOf("data:image/png;base64,") === 0 ? p : null; } catch(e){ return null; }
}
function charPortraitUrl(){ var p = charCached(); return p && p.sig === charSig() ? p.url : null; }
function charEnsurePortrait(){
  if(!char3dOk() || CHAR.busy) return Promise.resolve(null);
  var spec = charSpec(), sig = charSig(spec);
  var have = charCached();
  if(have && have.sig === sig){ charUpload(); return Promise.resolve(have.url); }
  CHAR.busy = true;
  return charLoad().then(function(A){ return A.portrait(spec, 128); }).then(function(url){
    CHAR.busy = false;
    if(charSig() !== sig) return charEnsurePortrait();     // changed again while drawing
    try { localStorage.setItem("hq_char_portrait", JSON.stringify({sig: sig, url: url})); } catch(e){}
    if(typeof renderTrainerCard === "function") renderTrainerCard();
    charUpload();
    return url;
  }, function(){ CHAR.busy = false; return null; });
}
// The Arena gets the portrait when it changes (paired only). It then shows it wherever it showed your
// GitHub picture: leaderboard, room members, chips, chat, music.
function charUpload(){
  var p = charCached();
  if(!p || p.sig !== charSig() || typeof ARENA === "undefined" || !ARENA.paired) return;
  var up = null; try { up = localStorage.getItem("hq_char_up"); } catch(e){}
  if(up === p.sig || CHAR.uploading) return;
  CHAR.uploading = true;
  arenaPost("/api/arena/portrait", {png: p.url}).then(function(r){
    CHAR.uploading = false;
    if(r.ok){ try { localStorage.setItem("hq_char_up", p.sig); } catch(e){} }
  }, function(){ CHAR.uploading = false; });
}

/* ---------- Settings: the Character builder ---------- */
function charPreview(){
  var cv = $("chPreview"); if(!cv) return;
  if(CHAR.prev){ CHAR.prev.set(CHAR.spec); return; }
  charLoad().then(function(A){
    if(!$("settingsBack") || !$("settingsBack").classList.contains("open")) return;
    CHAR.prev = A.preview(cv, CHAR.spec);
  }).catch(function(){ var n = $("chNote"); if(n) n.textContent = "The 3D preview couldn't load."; });
}
function buildCharBuilder(spec){
  var row = $("charBuilderRow"), tbRow = $("trainerBuilderRow"), host = $("chControls");
  var ok = char3dOk();
  if(row) row.hidden = !ok;
  if(tbRow) tbRow.hidden = ok;          // the 2D trainer is the fallback without WebGL2
  if(!ok || !host) return;
  CHAR.spec = (charValid(spec) ? spec : charSpec()).slice(0, CHAR_MAX.length);
  host.innerHTML = "";
  CHAR_ORDER.forEach(function(key){
    var i = CHAR_AXES.indexOf(key), max = CHAR_MAX[i], labels = CHAR_LABELS[key];
    var f = el("div", "tb-field"), lb = el("label"); lb.textContent = CHAR_TITLE[key]; f.appendChild(lb);
    var pal = CHAR_PAL[key];
    if(pal){
      var sw = el("div", "tb-sw"); sw.setAttribute("role", "group"); sw.setAttribute("aria-label", CHAR_TITLE[key]);
      for(var v = 0; v <= max; v++){(function(v){
        var b = el("button"); b.type = "button";
        if(pal[v]) b.style.background = pal[v]; else b.className = "ch-own";
        b.title = labels[v]; b.setAttribute("aria-label", labels[v]);
        b.setAttribute("aria-pressed", CHAR.spec[i] === v ? "true" : "false");
        b.addEventListener("click", function(){
          CHAR.spec[i] = v;
          Array.prototype.forEach.call(sw.children, function(c, ci){ c.setAttribute("aria-pressed", ci === v ? "true" : "false"); });
          charPreview();
        });
        sw.appendChild(b);
      })(v);}
      f.appendChild(sw);
    } else {
      var sel = el("select"); sel.setAttribute("aria-label", CHAR_TITLE[key]);
      for(var v2 = 0; v2 <= max; v2++){ var o = el("option"); o.value = String(v2); o.textContent = labels[v2]; if(CHAR.spec[i] === v2) o.selected = true; sel.appendChild(o); }
      sel.addEventListener("change", function(){ CHAR.spec[i] = parseInt(sel.value, 10) || 0; charPreview(); });
      f.appendChild(sel);
    }
    host.appendChild(f);
  });
  charPreview();
}
function readCharBuilder(){ return charValid(CHAR.spec) ? CHAR.spec.slice(0, CHAR_MAX.length) : charSpec(); }
function charClosePreview(){ if(CHAR.prev){ CHAR.prev.destroy(); CHAR.prev = null; } }
// Settings saved: remember, redraw the portrait, and swap the walking character.
function charSaved(spec){
  if(!charValid(spec)) return;
  try { localStorage.setItem("hq_char", JSON.stringify(spec)); } catch(e){}
  if(typeof HQ3D !== "undefined" && HQ3D.inst && HQ3D.inst.setCharacter) HQ3D.inst.setCharacter(spec);
  charEnsurePortrait();
}
(function(){
  var r = $("chRandom");
  if(r) r.addEventListener("click", function(){
    var s = CHAR_MAX.map(function(m){ return Math.floor(Math.random()*(m + 1)); });
    buildCharBuilder(s);
  });
  var rs = $("chReset"); if(rs) rs.addEventListener("click", function(){ buildCharBuilder(charFromTrainer(null)); });
  // Draw (and share) the portrait a little after load when it is missing or out of date, then keep
  // the Arena's copy current when you pair later.
  setTimeout(charEnsurePortrait, 4000);
  setInterval(charUpload, 60000);
})();
