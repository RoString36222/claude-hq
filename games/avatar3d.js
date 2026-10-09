/* Claude HQ: your 3D character (HQ 2.4).
 *
 * The person you walk around as in the 3D HQ and Arena City, built to your choices, and the
 * same character as a small portrait (the Trainer card, and everyone's lists via the Arena).
 *
 * A character is ten small numbers, append-only like the trainer spec (never renumber):
 *   [base, skin, hairColor, outfitColor, hairStyle, headwear, accessory, eyes, background, outfitStyle]
 *   base         one of the six Kenney Mini Characters (CC0, games/golf/LICENSE-kenney.txt)
 *   skin/hair/outfit colour: 0 keeps the model's own, then a palette; the last entries are the
 *                cyberpunk ones (Chrome skin, Neon cyan hair, Hot magenta outfit)
 *   hairStyle    own hair / shaved / Neon crest      headwear  none / beanie / cap / headband / party hat / Neural halo
 *   accessory    none / round glasses / shades / AR visor     eyes  normal / Lit eyes
 *   background   (portrait only) theme / sunset / mint / night / Neon grid     outfitStyle  plain / Techwear
 * MAX below is mirrored by CHARACTER_MAX in dashboard.py and pinned by tests/test_character.py.
 *
 * Colours: the six models share one palette atlas (colormap.png) with their shading baked into
 * neighbouring swatches. Each vertex's atlas colour is looked up once per model, sorted into a
 * class (skin, hair, top) by the exact colours in CLS below, and the chosen colour is applied
 * with the original shade kept (its luminance relative to the class's brightest swatch). The
 * eyes and mouth are found by place (dark, on the face plate) rather than colour, because some
 * hair shares their greys. Add-ons are built here and ride the head and torso bones, so they
 * follow every animation.
 *
 *   HQV.avatar3d.build(spec) -> Promise<{o, mixer, acts, cur, update(t), spec}>   (o: unscaled, ~0.8 tall)
 *   HQV.avatar3d.portrait(spec, px) -> Promise<"data:image/png;base64,...">
 *   HQV.avatar3d.preview(canvas, spec) -> {set(spec), destroy()}   (drag to turn)
 */
(function(){
"use strict";
var HQV = window.HQV = window.HQV || {};
var E = HQV.engine;
if(!E){ return; }

var FILES = ["character-female-a", "character-male-a", "character-female-c", "character-male-c", "character-female-e", "character-male-e"];
var MAX = [5, 7, 9, 9, 2, 5, 3, 1, 4, 1];
var SKIN = [null, "#f6d7bd", "#eab892", "#d49a6a", "#a46a43", "#6e4429", "#452a1b", "#c9d1db"];
var HAIR = [null, "#26262c", "#5a3a24", "#8a4a2a", "#d9b25f", "#e6e3da", "#9aa0a8", "#b5363b", "#3e63b3", "#5ff3ff"];
var OUTFIT = [null, "#4d5d6c", "#b35a3c", "#3f8a5a", "#6b4fb0", "#d2a23a", "#2e3238", "#c1607e", "#e6e8ee", "#ff3fb4"];
var CHROME = 7, NEON = "#5ff3ff", MAGENTA = "#ff3fb4";
var LABELS = {
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
var AXES = ["base", "skin", "hairColor", "outfitColor", "hairStyle", "headwear", "accessory", "eyes", "background", "outfitStyle"];
var PALETTES = {skin: SKIN, hairColor: HAIR, outfitColor: OUTFIT};

// The colours of each class, per model and mesh (see the header). H = head-mesh, B = body-mesh.
var BROWN = ["#875541", "#8b5641", "#8f5741", "#a25c41", "#a55d41", "#a95e41", "#ad5f41", "#b06041"];
var LIGHT = ["#cc875f", "#d28f68", "#d5946d", "#e6ae87", "#e9b28c", "#ecb690", "#efba94"];
var BLUE = ["#585abf", "#595dc0", "#5a61c2", "#5b66c4", "#5f74cb", "#6078cd", "#6282d1", "#6386d3", "#648ad5", "#658dd6"];
var GREYS = ["#353539", "#38383d", "#3b3b41", "#3f3f46", "#41414a", "#43434c", "#464650"];
var CLS = [
  /* Ava (female-a) */ {Hskin: BROWN, Hhair: GREYS, Bskin: BROWN.slice(0, 7),
    Btop: ["#613ebb", "#6b46c2", "#7e56ce", "#855bd2", "#9367db", "#a172e4"]},
  /* Max (male-a) */   {Hskin: BROWN, Hhair: GREYS, Bskin: BROWN.slice(0, 7),
    Btop: ["#20896b", "#28916f", "#3aa378", "#43ad7d", "#4cb681", "#51bb83", "#5ac487"]},
  /* Cleo (female-c) */ {Hskin: ["#b36343", "#bc6a49", "#c06e4c", "#df8760", "#e38b62", "#e78f65", "#eb9268"],
    Hhair: ["#5a6078", "#61677e", "#6d738a", "#71778e", "#797e96", "#7c8199", "#7f849c", "#82879e"],
    Bskin: ["#b36343", "#c06e4c", "#cf7a55", "#d5946d", "#da845d", "#df8760", "#e38b62", "#e6ae87", "#eb9268"],
    Btop: BLUE},
  /* Leo (male-c): his police cap is part of the model; the ginger under it (hair, beard) is his hair */
                     {Hskin: LIGHT,
    Hhair: ["#b36343", "#bc6a49", "#c6724f", "#cb7752", "#cf7a55", "#d27d58", "#d6805a", "#df8760", "#eb9268"],
    Bskin: ["#cc875f", "#e6ae87", "#efba94"], Btop: BLUE},
  /* Iris (female-e): blue gloves, a white coat */
                     {Hskin: LIGHT, Hhair: GREYS, Bskin: [],
    Btop: ["#c1c1d8", "#c9c9dd", "#dadae7", "#dedeea", "#efeff5", "#f8f8fb"]},
  /* Theo (male-e): dark gloves, orange overalls */
                     {Hskin: LIGHT, Hhair: ["#875541", "#8b5641", "#8f5741", "#935841", "#985941", "#9b5a41", "#9e5b41", "#a25c41", "#a55d41", "#ad5f41"],
    Bskin: [], Btop: ["#ff952f", "#ffa63d", "#ffb046", "#ffb54a", "#ffc053", "#ffd061"]}
];
var SKIN_C = 1, HAIR_C = 2, TOP_C = 3, EYE_C = 4;

function clampSpec(spec){
  var out = [];
  for(var i = 0; i < MAX.length; i++){
    var v = spec && spec[i] != null ? Math.floor(+spec[i]) : 0;
    if(!isFinite(v)) v = 0;
    out.push(((v % (MAX[i] + 1)) + (MAX[i] + 1)) % (MAX[i] + 1));
  }
  return out;
}
function valid(spec){ return Array.isArray(spec) && spec.length >= MAX.length && spec.every(function(v, i){ return i >= MAX.length || (v === (v|0) && v >= 0 && v <= MAX[i]); }); }
function sig(spec){ return clampSpec(spec).join("."); }
// A look from a seed (a name, a user id): what someone without a character gets.
function fromSeed(seed){
  var h = 2166136261 >>> 0; seed = String(seed || "");
  for(var i = 0; i < seed.length; i++){ h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return [h % 6, 0, 0, 0, 0, 0, 0, 0, 0, 0];
}

/* ---------- colour helpers ---------- */
function hexRgb(h){ var n = parseInt(h.slice(1), 16); return [(n >> 16 & 255)/255, (n >> 8 & 255)/255, (n & 255)/255]; }
function lum(c){ return 0.2126*c[0] + 0.7152*c[1] + 0.0722*c[2]; }
function rgbHex(r, g, b){ return "#" + [r, g, b].map(function(v){ return ("0" + v.toString(16)).slice(-2); }).join(""); }

var ATLAS = null;
function atlas(){
  return ATLAS || (ATLAS = new Promise(function(res, rej){
    var img = new Image();
    img.onload = function(){
      var c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
      var g = c.getContext("2d"); g.drawImage(img, 0, 0);
      res({w: c.width, h: c.height, d: g.getImageData(0, 0, c.width, c.height).data});
    };
    img.onerror = function(){ ATLAS = null; rej(new Error("colormap")); };
    img.src = "/games/golf/colormap.png";
  }));
}

// Per model: for each mesh, every vertex's atlas colour (sRGB 0..1), its class, and each class's
// brightest swatch (the reference its shades are measured against). Computed once per model.
var PREP = {};
function prep(base, gltf, A){
  if(PREP[base]) return PREP[base];
  var tbl = CLS[base], out = {};
  gltf.scene.traverse(function(n){
    if(!n.isMesh || !n.geometry || !n.geometry.attributes.uv) return;
    var head = /head/.test(n.name), uv = n.geometry.attributes.uv, pos = n.geometry.attributes.position, cnt = uv.count;
    var sets = {}; (head ? [[SKIN_C, tbl.Hskin], [HAIR_C, tbl.Hhair]] : [[SKIN_C, tbl.Bskin], [TOP_C, tbl.Btop]])
      .forEach(function(p){ p[1].forEach(function(hx){ sets[hx] = p[0]; }); });
    var rgb = new Float32Array(cnt*3), cls = new Uint8Array(cnt), ref = {}, box = {};
    for(var i = 0; i < cnt; i++){
      var u = uv.getX(i), v = uv.getY(i);
      var x = Math.min(A.w - 1, Math.max(0, Math.floor(u*A.w))), y = Math.min(A.h - 1, Math.max(0, Math.floor(v*A.h)));
      var k = (y*A.w + x)*4, r = A.d[k], g = A.d[k + 1], b = A.d[k + 2];
      rgb[i*3] = r/255; rgb[i*3 + 1] = g/255; rgb[i*3 + 2] = b/255;
      var c = sets[rgbHex(r, g, b)] || 0;
      var py = pos.getY(i), pz = pos.getZ(i);
      // the eyes and the mouth: dark, small, on the face plate
      if(head && pz > 0.15 && py > 0.39 && py < 0.52 && Math.max(r, g, b) < 90 && Math.abs(r - b) < 25) c = EYE_C;
      cls[i] = c;
      var l = lum([r/255, g/255, b/255]);
      if(c && (ref[c] == null || l > ref[c])) ref[c] = l;
      if(c){ var bx = box[c] || (box[c] = {x0: 1e9, x1: -1e9, y0: 1e9, y1: -1e9, z0: 1e9, z1: -1e9});
        var px = pos.getX(i); bx.x0 = Math.min(bx.x0, px); bx.x1 = Math.max(bx.x1, px); bx.y0 = Math.min(bx.y0, py);
        bx.y1 = Math.max(bx.y1, py); bx.z0 = Math.min(bx.z0, pz); bx.z1 = Math.max(bx.z1, pz); }
    }
    out[n.name] = {rgb: rgb, cls: cls, ref: ref, box: box, head: head};
  });
  return (PREP[base] = out);
}

/* ---------- building a character ---------- */
function shadeTo(target, orig, refL){
  var f = refL > 0 ? lum(orig)/refL : 1;
  return [Math.min(1, target[0]*f), Math.min(1, target[1]*f), Math.min(1, target[2]*f)];
}
// The colour a class takes for this spec, or null to keep the model's own.
function classTarget(spec, c, meshInfo, P){
  var hairShaved = spec[4] >= 1;
  if(c === SKIN_C) return spec[1] ? hexRgb(SKIN[spec[1]]) : null;
  if(c === HAIR_C){
    if(hairShaved){
      var hs = P["head-mesh"];
      var sk = spec[1] ? hexRgb(SKIN[spec[1]]) : (hs && hs.ref[SKIN_C] != null ? skinRefColor(hs) : null);
      // stubble: the skin with a hint of the chosen hair colour, so the colour still shows
      if(sk && spec[2]){ var hc = hexRgb(HAIR[spec[2]]); return [sk[0]*0.6 + hc[0]*0.4, sk[1]*0.6 + hc[1]*0.4, sk[2]*0.6 + hc[2]*0.4]; }
      return sk;
    }
    return spec[2] ? hexRgb(HAIR[spec[2]]) : null;
  }
  if(c === TOP_C){
    var t = spec[3] ? hexRgb(OUTFIT[spec[3]]) : null;
    if(spec[9] === 1) t = t ? t.map(function(v){ return v*0.45; }) : [0.11, 0.12, 0.14];   // techwear: dark cloth
    return t;
  }
  return null;
}
function skinRefColor(info){
  // the brightest skin swatch of this model, as the colour a shaved head takes
  var best = -1, at = null;
  for(var i = 0; i < info.cls.length; i++) if(info.cls[i] === SKIN_C){ var c = [info.rgb[i*3], info.rgb[i*3 + 1], info.rgb[i*3 + 2]], l = lum(c); if(l > best){ best = l; at = c; } }
  return at;
}

function recolor(L, mesh, info, spec, P, mats){
  var THREE = L.THREE, src = mesh.geometry, g = src.clone(), n = info.cls.length;
  var col = new Float32Array(n*3), tmp = new THREE.Color(), group = new Uint8Array(n);
  var lit = spec[7] === 1, chrome = spec[1] === CHROME;
  for(var i = 0; i < n; i++){
    var c = info.cls[i], o = [info.rgb[i*3], info.rgb[i*3 + 1], info.rgb[i*3 + 2]], t = c ? classTarget(spec, c, info, P) : null;
    var refL = c === HAIR_C && spec[4] >= 1 ? info.ref[HAIR_C] : info.ref[c];
    var out = t ? shadeTo(t, o, refL) : o;
    if(c === EYE_C && lit){ out = hexRgb(NEON); group[i] = 2; }
    else if(chrome && (c === SKIN_C || (c === HAIR_C && spec[4] >= 1))) group[i] = 1;
    tmp.setRGB(out[0], out[1], out[2], THREE.SRGBColorSpace);
    col[i*3] = tmp.r; col[i*3 + 1] = tmp.g; col[i*3 + 2] = tmp.b;
  }
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  // One material per kind of surface: cloth/skin, chrome skin, glowing eyes. Triangles are
  // regrouped by the kind of their first corner.
  var idx = g.index ? g.index.array : null;
  if(idx){
    var tris = [[], [], []];
    for(var t = 0; t < idx.length; t += 3) tris[group[idx[t]]].push(idx[t], idx[t + 1], idx[t + 2]);
    var all = tris[0].concat(tris[1], tris[2]);
    g.setIndex(all); g.clearGroups();
    var at = 0; tris.forEach(function(list, k){ if(list.length) g.addGroup(at, list.length, k); at += list.length; });
  }
  mesh.geometry = g;
  mesh.material = [mats.cloth, mats.chrome, mats.glow];
}

function materials(L, spec){
  var THREE = L.THREE;
  return {
    cloth: new THREE.MeshStandardMaterial({vertexColors: true, roughness: 0.85, metalness: 0}),
    chrome: new THREE.MeshStandardMaterial({vertexColors: true, roughness: 0.22, metalness: 0.65, emissive: 0x1c2430}),
    glow: new THREE.MeshBasicMaterial({vertexColors: true, toneMapped: false})
  };
}

/* ---------- add-ons on the head and the torso ---------- */
function glowMat(L, hex, op){ return new L.THREE.MeshBasicMaterial({color: hex, toneMapped: false, transparent: op != null, opacity: op == null ? 1 : op}); }
function solid(L, hex, rough, metal){ return new L.THREE.MeshStandardMaterial({color: hex, roughness: rough == null ? 0.7 : rough, metalness: metal || 0}); }
function bx(L, w, h, d, m, x, y, z, parent){ var b = new L.THREE.Mesh(new L.THREE.BoxGeometry(w, h, d), m); b.position.set(x, y, z); b.castShadow = true; parent.add(b); return b; }

function addOns(L, o, spec, P){
  var THREE = L.THREE, anim = [];
  o.updateMatrixWorld(true);
  var head = o.getObjectByName("head"), torso = o.getObjectByName("torso");
  var H = P["head-mesh"], B = P["body-mesh"];
  if(!head || !H) return anim;
  var sk = H.box[SKIN_C] || {x0: -0.17, x1: 0.17, y0: 0.34, y1: 0.66, z0: -0.16, z1: 0.17};
  var hair = H.box[HAIR_C], eye = H.box[EYE_C] || {y0: 0.46, y1: 0.51, z1: 0.165};
  // the top of the head: the hair, but not a bun or a ponytail sticking up above it
  var hw = 0.175, top = Math.max(sk.y1, hair && spec[4] === 0 ? Math.min(hair.y1, sk.y1 + 0.07) : sk.y1);
  if(spec[4] >= 1) top = Math.min(top, 0.69);
  var faceZ = Math.max(sk.z1, eye.z1 || 0.165), backZ = Math.max(-0.2, sk.z0), midZ = (faceZ + backZ)/2, depth = faceZ - backZ;
  var eyeY = (eye.y0 + eye.y1)/2 + 0.012;
  // a group in model space, carried by the head bone
  function onBone(bone){
    var g = new THREE.Group(); g.applyMatrix4(bone.matrixWorld.clone().invert()); bone.add(g); return g;
  }
  var hg = onBone(head);
  var hairHex = spec[2] ? HAIR[spec[2]] : NEON, accent = spec[3] ? OUTFIT[spec[3]] : "#e0533f";

  // Neon crest: a glowing ridge front to back (the hair under it is shaved)
  if(spec[4] === 2){
    var cm = glowMat(L, hairHex);
    for(var i = 0; i < 6; i++){
      var z = faceZ - 0.03 - i*(depth - 0.06)/5, h = 0.05 + 0.05*Math.sin(i/5*Math.PI);
      bx(L, 0.035, h, 0.05, cm, 0, top + h/2 - 0.005, z, hg);
    }
  }
  var hw2 = hw*2 + 0.02, hatY = top;
  if(spec[5] === 1){            // beanie
    var bm = solid(L, accent, 0.9);
    bx(L, hw2, 0.12, depth + 0.03, bm, 0, hatY + 0.03, midZ, hg);
    bx(L, hw2 + 0.02, 0.04, depth + 0.05, solid(L, accent, 0.8), 0, hatY - 0.03, midZ, hg);
    var pom = new THREE.Mesh(new THREE.SphereGeometry(0.035, 10, 8), solid(L, "#f2f2f2", 0.9)); pom.position.set(0, hatY + 0.11, midZ); hg.add(pom);
  } else if(spec[5] === 2){     // cap
    var capm = solid(L, accent, 0.8);
    bx(L, hw2, 0.07, depth + 0.02, capm, 0, hatY + 0.015, midZ, hg);
    bx(L, hw2 - 0.02, 0.018, 0.12, capm, 0, hatY - 0.012, faceZ + 0.06, hg);
  } else if(spec[5] === 3){     // headband
    var hbm = solid(L, accent, 0.7), y = eyeY + 0.1;
    bx(L, hw2, 0.035, 0.012, hbm, 0, y, faceZ + 0.006, hg); bx(L, hw2, 0.035, 0.012, hbm, 0, y, backZ - 0.006, hg);
    bx(L, 0.012, 0.035, depth + 0.012, hbm, -hw - 0.006, y, midZ, hg); bx(L, 0.012, 0.035, depth + 0.012, hbm, hw + 0.006, y, midZ, hg);
  } else if(spec[5] === 4){     // party hat
    var cone = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.2, 14), solid(L, accent, 0.6)); cone.position.set(0, hatY + 0.1, midZ); cone.castShadow = true; hg.add(cone);
  } else if(spec[5] === 5){     // Neural halo: a floating lit ring and temple implants
    var ring = new THREE.Mesh(new THREE.TorusGeometry(hw*1.15, 0.012, 8, 40), glowMat(L, NEON));
    ring.rotation.x = Math.PI/2; ring.position.set(0, top + 0.1, midZ); hg.add(ring);
    [-1, 1].forEach(function(s){ bx(L, 0.012, 0.045, 0.045, glowMat(L, NEON), s*(hw + 0.008), eyeY + 0.01, midZ + depth*0.15, hg); });
    anim.push(function(t){ ring.position.y = top + 0.1 + Math.sin(t*1.6)*0.012; ring.rotation.z = t*0.6; });
  }
  // accessories, on the face plate
  var ez = faceZ + 0.008;
  if(spec[6] === 1 || spec[6] === 2){
    var frame = solid(L, spec[6] === 2 ? "#111318" : "#2b2b33", 0.4, 0.3), lens = spec[6] === 2 ? solid(L, "#0b0c10", 0.15, 0.4) : null;
    [-1, 1].forEach(function(s){
      var cx = s*0.065;
      if(lens) bx(L, 0.075, 0.05, 0.008, lens, cx, eyeY, ez, hg);
      bx(L, 0.085, 0.01, 0.01, frame, cx, eyeY + 0.03, ez + 0.002, hg); bx(L, 0.085, 0.01, 0.01, frame, cx, eyeY - 0.03, ez + 0.002, hg);
      bx(L, 0.01, 0.06, 0.01, frame, cx - 0.042, eyeY, ez + 0.002, hg); bx(L, 0.01, 0.06, 0.01, frame, cx + 0.042, eyeY, ez + 0.002, hg);
      bx(L, 0.01, 0.01, depth*0.55, frame, s*(hw + 0.004), eyeY + 0.025, faceZ - depth*0.28, hg);
    });
    bx(L, 0.05, 0.01, 0.01, frame, 0, eyeY + 0.02, ez + 0.002, hg);
  } else if(spec[6] === 3){     // AR visor: a see-through lit bar with a readout line
    bx(L, hw2 - 0.01, 0.06, 0.012, glowMat(L, NEON, 0.45), 0, eyeY, ez + 0.006, hg);
    bx(L, hw2 - 0.01, 0.006, 0.014, glowMat(L, NEON), 0, eyeY + 0.03, ez + 0.007, hg);
    bx(L, 0.05, 0.006, 0.014, glowMat(L, MAGENTA), 0.08, eyeY - 0.012, ez + 0.008, hg);
    [-1, 1].forEach(function(s){ bx(L, 0.012, 0.03, depth*0.4, solid(L, "#22262e", 0.4, 0.5), s*(hw + 0.006), eyeY, faceZ - depth*0.18, hg); });
  }
  // Techwear: lit circuit trim and nodes on the jacket, carried by the torso bone
  if(spec[9] === 1 && torso && B && B.box[TOP_C]){
    var tb = B.box[TOP_C], tg = onBone(torso), lc = spec[3] === 9 ? NEON : MAGENTA, lm = glowMat(L, lc);
    var fz = tb.z1 + 0.004, ty0 = Math.max(tb.y0, 0.19), ty1 = Math.min(tb.y1, 0.33);
    bx(L, 0.008, ty1 - ty0, 0.006, lm, 0.03, (ty0 + ty1)/2, fz, tg);                         // the zip, off-centre
    bx(L, 0.07, 0.006, 0.006, lm, -0.03, ty1 - 0.03, fz, tg); bx(L, 0.006, 0.05, 0.006, lm, -0.065, ty1 - 0.055, fz, tg);
    [[-0.065, ty1 - 0.08], [0.075, ty0 + 0.04], [-0.03, ty0 + 0.025]].forEach(function(p){
      var d = new THREE.Mesh(new THREE.SphereGeometry(0.011, 8, 6), glowMat(L, lc)); d.position.set(p[0], p[1], fz + 0.004); tg.add(d);
    });
  }
  return anim;
}

/* ---------- public ---------- */
var ANIMS = ["idle", "walk", "sit", "emote-yes", "sprint"];
function build(spec){
  spec = clampSpec(spec);
  return E.lib().then(function(L){
    return Promise.all([E.loadGlb(L, "golf", FILES[spec[0]]), atlas()]).then(function(r){
      var gltf = r[0], P = prep(spec[0], gltf, r[1]);
      var o = L.clone(gltf.scene), mats = materials(L, spec);
      o.traverse(function(n){
        if(n.isMesh){ n.castShadow = true; n.frustumCulled = false; if(P[n.name]) recolor(L, n, P[n.name], spec, P, mats); }
      });
      var anim = addOns(L, o, spec, P);
      var mixer = new L.THREE.AnimationMixer(o), acts = {};
      ANIMS.forEach(function(n){ var cl = L.THREE.AnimationClip.findByName(gltf.animations, n); if(cl) acts[n] = mixer.clipAction(cl); });
      return {o: o, mixer: mixer, acts: acts, cur: null, spec: spec, L: L,
              update: function(t){ if(!E.calm()) anim.forEach(function(f){ f(t); }); }};
    });
  });
}

// Portraits: one offscreen renderer, reused; the background is painted in 2D behind it.
var PR = null;
function bgPaint(g, px, kind){
  var css = getComputedStyle(document.documentElement), brand = (css.getPropertyValue("--brand") || "#7c6cf0").trim() || "#7c6cf0";
  var stops = {0: [brand, "#141826"], 1: ["#ffb26b", "#c4466b"], 2: ["#bff2dc", "#3f8f7a"], 3: ["#273a6b", "#0b1020"], 4: ["#1a0b2e", "#06040d"]}[kind] || [brand, "#141826"];
  var gr = g.createLinearGradient(0, 0, 0, px); gr.addColorStop(0, stops[0]); gr.addColorStop(1, stops[1]);
  g.fillStyle = gr; g.fillRect(0, 0, px, px);
  if(kind === 4){                      // Neon grid: a horizon and rails running to it
    var hy = px*0.62; g.strokeStyle = MAGENTA; g.lineWidth = Math.max(1, px/96); g.globalAlpha = 0.85;
    g.beginPath(); g.moveTo(0, hy); g.lineTo(px, hy); g.stroke();
    g.strokeStyle = NEON; g.globalAlpha = 0.5;
    for(var i = -6; i <= 6; i++){ g.beginPath(); g.moveTo(px/2 + i*px*0.02, hy); g.lineTo(px/2 + i*px*0.2, px); g.stroke(); }
    for(var k = 1; k <= 5; k++){ var y = hy + (px - hy)*Math.pow(k/5, 1.8); g.beginPath(); g.moveTo(0, y); g.lineTo(px, y); g.stroke(); }
    g.globalAlpha = 1;
  }
}
function stage(L){
  var THREE = L.THREE, S = new THREE.Scene();
  S.add(new THREE.HemisphereLight(0xffffff, 0x6b7a8f, 1.6));
  var d = new THREE.DirectionalLight(0xffffff, 2.1); d.position.set(1.2, 2, 2.4); S.add(d);
  var rim = new THREE.DirectionalLight(0x9fd8ff, 0.8); rim.position.set(-2, 1.5, -1.5); S.add(rim);
  return S;
}
function portrait(spec, px){
  spec = clampSpec(spec); px = Math.max(32, Math.min(256, px|0 || 128));
  return build(spec).then(function(ch){
    var L = ch.L, THREE = L.THREE;
    if(!PR){
      var r = new THREE.WebGLRenderer({antialias: true, alpha: true, preserveDrawingBuffer: true});
      r.outputColorSpace = THREE.SRGBColorSpace;
      PR = {r: r, cam: new THREE.PerspectiveCamera(24, 1, 0.05, 20), S: stage(L)};
    }
    PR.r.setPixelRatio(1); PR.r.setSize(px, px, false);
    if(ch.acts.idle){ ch.acts.idle.play(); ch.mixer.update(0.4); }
    ch.update(0.4);
    PR.S.add(ch.o); ch.o.updateMatrixWorld(true);
    // head and shoulders, a little from the side
    PR.cam.position.set(0.32, 0.6, 1.25); PR.cam.lookAt(0, 0.43, 0); PR.cam.updateProjectionMatrix();
    PR.r.setClearColor(0x000000, 0); PR.r.render(PR.S, PR.cam);
    var c = document.createElement("canvas"); c.width = c.height = px;
    var g = c.getContext("2d"); bgPaint(g, px, spec[8]); g.drawImage(PR.r.domElement, 0, 0, px, px);
    PR.S.remove(ch.o);
    ch.o.traverse(function(n){ if(n.isMesh){ n.geometry.dispose(); } });
    return c.toDataURL("image/png");
  });
}

// A live preview in a canvas: idle animation, drag to turn.
function preview(canvas, spec){
  var alive = true, ch = null, want = sig(spec), yaw = 0.35, drag = null, raf = 0, last = performance.now(), seq = 0;
  var api = {set: function(s){ if(sig(s) === want && ch) return; want = sig(s); load(clampSpec(s)); },
             destroy: function(){ alive = false; cancelAnimationFrame(raf); if(R) R.r.dispose(); }};
  var R = null;
  function paintBg(s){
    try {
      var c = document.createElement("canvas"); c.width = c.height = 192;
      bgPaint(c.getContext("2d"), 192, s[8]);
      canvas.style.backgroundImage = "url(" + c.toDataURL("image/png") + ")";
      canvas.style.backgroundSize = "cover";
    } catch(e){}
  }
  function load(s){
    var my = ++seq;
    paintBg(s);
    build(s).then(function(c){
      if(!alive || my !== seq) return;
      if(!R){
        var L = c.L, THREE = L.THREE, r = new THREE.WebGLRenderer({canvas: canvas, antialias: true, alpha: true});
        r.outputColorSpace = THREE.SRGBColorSpace; r.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
        R = {r: r, S: stage(L), cam: new THREE.PerspectiveCamera(28, 1, 0.05, 20)};
        R.cam.position.set(0, 0.5, 2.05); R.cam.lookAt(0, 0.38, 0);
      }
      if(ch) R.S.remove(ch.o);
      ch = c; R.S.add(ch.o); if(ch.acts.idle) ch.acts.idle.play();
      if(!raf) loop();
    });
  }
  function loop(){
    raf = requestAnimationFrame(loop);
    if(!alive || !ch || !R) return;
    var now = performance.now(), dt = Math.min(0.1, (now - last)/1000); last = now;
    var w = canvas.clientWidth || 160, h = canvas.clientHeight || 160;
    if(canvas.width !== Math.round(w*R.r.getPixelRatio()) || canvas.height !== Math.round(h*R.r.getPixelRatio())){ R.r.setSize(w, h, false); R.cam.aspect = w/h; R.cam.updateProjectionMatrix(); }
    if(!E.calm()) ch.mixer.update(dt);
    ch.update(now/1000);
    ch.o.rotation.y = yaw;
    R.r.render(R.S, R.cam);
  }
  canvas.addEventListener("pointerdown", function(e){ drag = e.clientX; try { canvas.setPointerCapture(e.pointerId); } catch(x){} });
  canvas.addEventListener("pointermove", function(e){ if(drag != null){ yaw += (e.clientX - drag)*0.012; drag = e.clientX; } });
  canvas.addEventListener("pointerup", function(){ drag = null; });
  canvas.addEventListener("keydown", function(e){ if(e.key === "ArrowLeft"){ yaw -= 0.3; e.preventDefault(); } else if(e.key === "ArrowRight"){ yaw += 0.3; e.preventDefault(); } });
  load(clampSpec(spec));
  return api;
}

HQV.avatar3d = {MAX: MAX, AXES: AXES, LABELS: LABELS, PALETTES: PALETTES, FILES: FILES, clamp: clampSpec, valid: valid, sig: sig,
                fromSeed: fromSeed, build: build, portrait: portrait, preview: preview, CLS: CLS};
})();
