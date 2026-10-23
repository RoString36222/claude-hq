/* Claude HQ: HQ Studio's style document (HQV.hqStyle), the HQ revamp's customisation of a building.
 *
 * One small JSON per user: how the tower looks from the street (ext), how its floors look inside (int.themes),
 * the lobby's set pieces (int.lobby) and the decor placed on each floor's grid (int.items). The Arena stores it
 * (migration 0021_hq_custom.sql, /v1/hq/me/style, "style" in the HQ listing; capability "hqstyle") and validates it
 * with the same schema: games/hqstyle/schema.json == backend/data/hqstyle.json == SCHEMA below
 * (tests/test_hqstyle.py keeps the three identical). Without the capability it stays on this machine
 * (localStorage, ui/app/40-studio.js) and everyone else sees the default.
 *
 * Pure (no THREE, no DOM), so node tests it:
 *   defaults()            the default document (every key)
 *   clean(doc)            lenient: any input -> a valid document (bad or missing values -> defaults). What
 *                         renderers call on data from the wire, so a hand-made row can never break a building.
 *   check(doc)            strict, as the Arena: {ok: true, style} or {ok: false, err} (unknown keys, bad enums or
 *                         colours, too many items, two items on one cell, off the grid, too big)
 *   preset(name, doc?)    the document with an exterior preset's keys (the rest of doc kept)
 *   lobbyPreset(name, doc?)  the same for the lobby's set pieces and its floor theme
 *   randomise(seed, doc?) a deterministic random exterior + lobby (mulberry32(hashStr(seed)))
 *   place(doc, item) / remove(doc, f, x, z) -> a new document (or null when it does not fit the rules)
 *   petSpots(doc)         the lobby's pet furniture and water as [{x, z, kind}] (m), for HQV.hqPets.lobby
 *   key(doc)              a stable string of what a building's look depends on (rebuild when it changes)
 */
(function(){
"use strict";
var HQV = window.HQV = window.HQV || {};

var SCHEMA = {"v": 1, "maxBytes": 8192, "colorRe": "^#[0-9a-fA-F]{6}$", "ext": {"preset": {"enum": ["glass", "deco", "brutal", "tokyo", "stone", "eco"], "def": "glass"}, "facade": {"enum": ["glass", "deco", "brutal", "tokyo", "stone", "eco"], "def": "glass"}, "material": {"enum": ["glass", "steel", "concrete", "limestone", "brick", "timber", "marble", "ceramic"], "def": "glass"}, "body": {"color": true, "def": "#2a3c50"}, "trim": {"color": true, "def": "#ffb347"}, "tint": {"enum": ["clear", "blue", "green", "bronze", "grey", "gold", "rose"], "def": "blue"}, "crown": {"enum": ["flat", "spire", "garden", "deco", "pagoda", "dome", "antenna"], "def": "spire"}, "entrance": {"enum": ["canopy", "portico", "arch", "glassbox", "torii"], "def": "canopy"}, "font": {"enum": ["sans", "serif", "mono", "deco", "script"], "def": "sans"}, "signColor": {"color": true, "def": "#ffb347"}, "night": {"color": true, "def": "#ffcf7a"}, "flags": {"enum": ["none", "flags", "banners", "both"], "def": "flags"}, "flagColor": {"color": true, "def": "#5fd3e6"}, "roof": {"set": ["antennas", "tank", "garden", "solar", "beacon"], "max": 5, "def": ["antennas", "beacon"]}, "land": {"enum": ["plaza", "lawn", "zen", "tropical", "formal", "desert"], "def": "plaza"}, "balcony": {"bool": true, "def": true}}, "int": {"floors": ["lobby", "mission"], "theme": {"wall": {"enum": ["slate", "white", "sage", "navy", "terracotta", "damask", "geo", "leaf", "oak", "brick", "marble", "concrete"], "def": "slate"}, "floor": {"enum": ["stone", "marble", "oak", "walnut", "terrazzo", "carpet", "concrete", "checker", "tile"], "def": "stone"}, "mood": {"enum": ["warm", "cool", "sunset", "neon", "gallery", "night"], "def": "warm"}, "furn": {"enum": ["standard", "executive", "industrial", "scandi", "gamer", "retro"], "def": "standard"}}, "items": {"kinds": ["plant", "palm", "bonsai", "art", "sculpture", "trophy", "aquarium", "arcade", "bookshelf", "rug", "sofa", "lamp", "piano", "globe", "vending", "statue", "petbed", "cattree", "perch", "perchbig", "dinopen", "bowl", "pond"], "max": 48, "maxPerFloor": 32, "grid": 13, "rot": 3}, "lobby": {"preset": {"enum": ["atrium", "gallery", "zen", "neon", "library", "jungle"], "def": "atrium"}, "ceiling": {"enum": ["coffer", "glass", "beams", "plain", "dome"], "def": "coffer"}, "reception": {"enum": ["curve", "block", "wood", "marble", "neon"], "def": "curve"}, "centre": {"enum": ["fountain", "statue", "aquarium", "screen", "tree"], "def": "fountain"}, "seating": {"enum": ["lounge", "chesterfield", "modular", "beanbag", "benches"], "def": "lounge"}, "art": {"enum": ["abstract", "posters", "portraits", "neon", "none"], "def": "abstract"}, "rug": {"enum": ["none", "persian", "round", "stripe", "geo"], "def": "round"}, "signage": {"enum": ["wall", "hanging", "floor", "neon"], "def": "wall"}, "ambience": {"enum": ["none", "jazz", "nature", "lofi", "fountain", "city"], "def": "fountain"}}}};

var COLOR = /^#[0-9a-fA-F]{6}$/;
// the exterior presets: a facade system with its own colours, crown, entrance, sign and grounds
var PRESETS = {
  glass:  {label: "Glass Modern", facade: "glass", material: "glass", body: "#2a3c50", trim: "#c8d4de", tint: "blue", crown: "spire", entrance: "canopy", font: "sans", signColor: "#ffffff", night: "#ffcf7a", flags: "flags", flagColor: "#5fd3e6", roof: ["antennas", "beacon"], land: "plaza", balcony: true},
  deco:   {label: "Art Deco", facade: "deco", material: "limestone", body: "#d9c9a8", trim: "#c99a3b", tint: "bronze", crown: "deco", entrance: "portico", font: "deco", signColor: "#f2c14e", night: "#ffd28a", flags: "banners", flagColor: "#7a1f2b", roof: ["beacon"], land: "formal", balcony: false},
  brutal: {label: "Brutalist", facade: "brutal", material: "concrete", body: "#8d8a84", trim: "#3d3b38", tint: "grey", crown: "flat", entrance: "glassbox", font: "mono", signColor: "#ff6b5b", night: "#f4f0e6", flags: "none", flagColor: "#3d3b38", roof: ["tank", "antennas"], land: "desert", balcony: false},
  tokyo:  {label: "Neo-Tokyo", facade: "tokyo", material: "steel", body: "#1b1f2e", trim: "#ff3d8b", tint: "rose", crown: "antenna", entrance: "torii", font: "mono", signColor: "#39f3ff", night: "#ff6ad5", flags: "banners", flagColor: "#ff3d8b", roof: ["antennas", "solar", "beacon"], land: "zen", balcony: true},
  stone:  {label: "Classic Stone", facade: "stone", material: "limestone", body: "#cbbf9f", trim: "#6b5a3e", tint: "clear", crown: "dome", entrance: "arch", font: "serif", signColor: "#2b2418", night: "#ffe0a3", flags: "flags", flagColor: "#2f4f8f", roof: ["tank"], land: "formal", balcony: true},
  eco:    {label: "Eco Green", facade: "eco", material: "timber", body: "#6f8a5a", trim: "#b5894b", tint: "green", crown: "garden", entrance: "canopy", font: "sans", signColor: "#e8f5d0", night: "#d6ffb0", flags: "banners", flagColor: "#3f8f5a", roof: ["garden", "solar"], land: "tropical", balcony: true}
};
var LOBBY_PRESETS = {
  atrium:  {label: "Grand Atrium", ceiling: "coffer", reception: "curve", centre: "fountain", seating: "lounge", art: "abstract", rug: "round", signage: "wall", ambience: "fountain", theme: {wall: "slate", floor: "marble", mood: "warm"}},
  gallery: {label: "Gallery", ceiling: "glass", reception: "block", centre: "statue", seating: "benches", art: "portraits", rug: "none", signage: "floor", ambience: "jazz", theme: {wall: "white", floor: "terrazzo", mood: "gallery"}},
  zen:     {label: "Zen Garden", ceiling: "beams", reception: "wood", centre: "tree", seating: "modular", art: "none", rug: "stripe", signage: "hanging", ambience: "nature", theme: {wall: "oak", floor: "oak", mood: "warm"}},
  neon:    {label: "Neon Arcade", ceiling: "plain", reception: "neon", centre: "screen", seating: "beanbag", art: "neon", rug: "geo", signage: "neon", ambience: "lofi", theme: {wall: "navy", floor: "checker", mood: "neon"}},
  library: {label: "Library", ceiling: "coffer", reception: "wood", centre: "statue", seating: "chesterfield", art: "portraits", rug: "persian", signage: "hanging", ambience: "jazz", theme: {wall: "damask", floor: "walnut", mood: "sunset"}},
  jungle:  {label: "Jungle", ceiling: "glass", reception: "marble", centre: "aquarium", seating: "lounge", art: "posters", rug: "round", signage: "wall", ambience: "nature", theme: {wall: "leaf", floor: "stone", mood: "cool"}}
};
// the pet furniture (and the lobby's water) the pets' world hook stands pets on
var PET_SPOT = {petbed: "bed", cattree: "tree", perch: "perch", perchbig: "perch", dinopen: "pen", bowl: "bowl", pond: "water"};
// how many grid cells (m) an item takes, in its own frame [w, d] (rot 1 and 3 swap them): it is checked on the cell it stands on;
// bigger pieces are only informative (the lobby blocks their footprint)
var SIZE = {plant: [1, 1], palm: [1, 1], bonsai: [1, 1], art: [1, 1], sculpture: [1, 1], trophy: [1, 1], aquarium: [2, 1], arcade: [1, 1], bookshelf: [2, 1],
  rug: [3, 2], sofa: [2, 1], lamp: [1, 1], piano: [2, 2], globe: [1, 1], vending: [1, 1], statue: [1, 1], petbed: [1, 1], cattree: [1, 1], perch: [1, 1], perchbig: [2, 2],
  dinopen: [3, 3], bowl: [1, 1], pond: [2, 2]};
var LABELS = {plant: "Potted plant", palm: "Palm", bonsai: "Bonsai", art: "Art on an easel", sculpture: "Sculpture", trophy: "Trophy stand", aquarium: "Aquarium",
  arcade: "Arcade cabinet", bookshelf: "Bookshelf", rug: "Rug", sofa: "Sofa", lamp: "Floor lamp", piano: "Grand piano", globe: "Globe", vending: "Vending machine",
  statue: "Statue", petbed: "Pet bed", cattree: "Cat tree", perch: "Dragon perch", perchbig: "Big dragon perch", dinopen: "Dino pen", bowl: "Food bowls", pond: "Pond"};

function own(o, k){ return o != null && Object.prototype.hasOwnProperty.call(o, k); }
function isObj(o){ return !!o && typeof o === "object" && !Array.isArray(o); }
function copy(o){ return JSON.parse(JSON.stringify(o)); }
function hashStr(s){ var h = 2166136261 >>> 0; s = String(s); for(var i = 0; i < s.length; i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h >>> 0; }
function mulberry32(a){ a = a >>> 0 || 1; return function(){ a = (a + 0x6D2B79F5) >>> 0; var t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0)/4294967296; }; }

// one value against its schema entry: the value (colours lower-cased) or undefined
function value(S, v){
  if(S.enum) return typeof v === "string" && S.enum.indexOf(v) >= 0 ? v : undefined;
  if(S.color) return typeof v === "string" && COLOR.test(v) ? v.toLowerCase() : undefined;
  if(S.bool) return typeof v === "boolean" ? v : undefined;
  if(S.set){
    if(!Array.isArray(v) || v.length > S.max) return undefined;
    var out = [];
    for(var i = 0; i < v.length; i++){ if(typeof v[i] !== "string" || S.set.indexOf(v[i]) < 0 || out.indexOf(v[i]) >= 0) return undefined; out.push(v[i]); }
    return out;
  }
  return undefined;
}
function group(S, src){ var o = {}; Object.keys(S).forEach(function(k){ var v = isObj(src) ? value(S[k], src[k]) : undefined; o[k] = v !== undefined ? v : copy(S[k].def); }); return o; }
function defaults(){
  var themes = {}; SCHEMA.int.floors.forEach(function(f){ themes[f] = group(SCHEMA.int.theme, null); });
  return {v: 1, ext: group(SCHEMA.ext, null), int: {themes: themes, items: [], lobby: group(SCHEMA.int.lobby, null)}};
}
function itemOk(it){
  var I = SCHEMA.int.items;
  return isObj(it) && Object.keys(it).every(function(k){ return ["k", "f", "x", "z", "r"].indexOf(k) >= 0; }) &&
    I.kinds.indexOf(it.k) >= 0 && SCHEMA.int.floors.indexOf(it.f) >= 0 &&
    [it.x, it.z, it.r].every(function(n){ return typeof n === "number" && isFinite(n) && Math.floor(n) === n; }) &&
    Math.abs(it.x) <= I.grid && Math.abs(it.z) <= I.grid && it.r >= 0 && it.r <= I.rot;
}
// lenient: anything -> a valid document
function clean(doc){
  var d = defaults(); if(!isObj(doc)) return d;
  d.ext = group(SCHEMA.ext, doc.ext);
  var I = isObj(doc.int) ? doc.int : {};
  SCHEMA.int.floors.forEach(function(f){ d.int.themes[f] = group(SCHEMA.int.theme, isObj(I.themes) ? I.themes[f] : null); });
  d.int.lobby = group(SCHEMA.int.lobby, I.lobby);
  var per = {}, cells = {};
  (Array.isArray(I.items) ? I.items : []).forEach(function(it){
    if(d.int.items.length >= SCHEMA.int.items.max || !itemOk(it)) return;
    var ck = it.f + ":" + it.x + ":" + it.z; if(cells[ck] || (per[it.f] | 0) >= SCHEMA.int.items.maxPerFloor) return;
    cells[ck] = 1; per[it.f] = (per[it.f] | 0) + 1; d.int.items.push({k: it.k, f: it.f, x: it.x, z: it.z, r: it.r});
  });
  return d;
}
// strict, as the Arena checks it
function check(doc){
  function bad(e){ return {ok: false, err: e}; }
  if(!isObj(doc)) return bad("style must be an object");
  var size; try { size = JSON.stringify(doc).length; } catch(e){ return bad("style is not JSON"); }
  if(size > SCHEMA.maxBytes) return bad("style is too big");
  var k, i;
  for(k in doc) if(own(doc, k) && ["v", "ext", "int"].indexOf(k) < 0) return bad("unknown key " + k);
  if(doc.v !== 1) return bad("v must be 1");
  function grp(S, src, where){
    if(src == null) return null;
    if(!isObj(src)) return where + " must be an object";
    for(var kk in src) if(own(src, kk)){
      if(!own(S, kk)) return "unknown key " + where + "." + kk;
      if(value(S[kk], src[kk]) === undefined) return "bad value for " + where + "." + kk;
    }
    return null;
  }
  var e = grp(SCHEMA.ext, doc.ext, "ext"); if(e) return bad(e);
  if(doc.int != null){
    if(!isObj(doc.int)) return bad("int must be an object");
    for(k in doc.int) if(own(doc.int, k) && ["themes", "items", "lobby"].indexOf(k) < 0) return bad("unknown key int." + k);
    if(doc.int.themes != null){
      if(!isObj(doc.int.themes)) return bad("int.themes must be an object");
      for(k in doc.int.themes) if(own(doc.int.themes, k)){
        if(SCHEMA.int.floors.indexOf(k) < 0) return bad("unknown floor " + k);
        e = grp(SCHEMA.int.theme, doc.int.themes[k], "int.themes." + k); if(e) return bad(e);
      }
    }
    e = grp(SCHEMA.int.lobby, doc.int.lobby, "int.lobby"); if(e) return bad(e);
    if(doc.int.items != null){
      var its = doc.int.items, I = SCHEMA.int.items, per = {}, cells = {};
      if(!Array.isArray(its)) return bad("int.items must be a list");
      if(its.length > I.max) return bad("too many items");
      for(i = 0; i < its.length; i++){
        if(!itemOk(its[i])) return bad("bad item " + i);
        var ck = its[i].f + ":" + its[i].x + ":" + its[i].z; if(cells[ck]) return bad("two items on one cell"); cells[ck] = 1;
        per[its[i].f] = (per[its[i].f] | 0) + 1; if(per[its[i].f] > I.maxPerFloor) return bad("too many items on " + its[i].f);
      }
    }
  }
  return {ok: true, style: clean(doc)};
}
function preset(name, doc){
  var P = PRESETS[name]; var d = clean(doc); if(!P) return d;
  Object.keys(SCHEMA.ext).forEach(function(k){ if(k === "preset") d.ext.preset = name; else if(own(P, k)) d.ext[k] = copy(P[k]); });
  return d;
}
function lobbyPreset(name, doc){
  var P = LOBBY_PRESETS[name]; var d = clean(doc); if(!P) return d;
  Object.keys(SCHEMA.int.lobby).forEach(function(k){ if(k === "preset") d.int.lobby.preset = name; else if(own(P, k)) d.int.lobby[k] = P[k]; });
  Object.keys(P.theme).forEach(function(k){ d.int.themes.lobby[k] = P.theme[k]; });
  return d;
}
function randomise(seed, doc){
  var R = mulberry32(hashStr("hqstyle:" + seed)), d = clean(doc);
  function pick(a){ return a[Math.floor(R()*a.length) % a.length]; }
  function col(){ var h = R()*360, s = 0.25 + R()*0.55, l = 0.25 + R()*0.5, a = s*Math.min(l, 1 - l);
    function f(n){ var k = (n + h/30) % 12, c = l - a*Math.max(-1, Math.min(k - 3, 9 - k, 1)); return ("0" + Math.round(c*255).toString(16)).slice(-2); }
    return "#" + f(0) + f(8) + f(4); }
  d = preset(pick(SCHEMA.ext.preset.enum), d);
  var X = SCHEMA.ext;
  ["material", "tint", "crown", "entrance", "font", "flags", "land"].forEach(function(k){ if(R() < 0.6) d.ext[k] = pick(X[k].enum); });
  ["body", "trim", "signColor", "night", "flagColor"].forEach(function(k){ if(R() < 0.7) d.ext[k] = col(); });
  d.ext.roof = X.roof.set.filter(function(){ return R() < 0.5; });
  d.ext.balcony = R() < 0.6;
  d = lobbyPreset(pick(SCHEMA.int.lobby.preset.enum), d);
  Object.keys(SCHEMA.int.lobby).forEach(function(k){ if(k !== "preset" && R() < 0.4) d.int.lobby[k] = pick(SCHEMA.int.lobby[k].enum); });
  SCHEMA.int.floors.forEach(function(f){ Object.keys(SCHEMA.int.theme).forEach(function(k){ if(R() < 0.5) d.int.themes[f][k] = pick(SCHEMA.int.theme[k].enum); }); });
  return d;
}
// a new document with item placed (replacing whatever stood on that cell), or null past the limits
function place(doc, it){
  var d = clean(doc); if(!itemOk(it)) return null;
  d.int.items = d.int.items.filter(function(o){ return !(o.f === it.f && o.x === it.x && o.z === it.z); });
  if(d.int.items.length >= SCHEMA.int.items.max) return null;
  if(d.int.items.filter(function(o){ return o.f === it.f; }).length >= SCHEMA.int.items.maxPerFloor) return null;
  d.int.items.push({k: it.k, f: it.f, x: it.x, z: it.z, r: it.r});
  return d;
}
function remove(doc, f, x, z){ var d = clean(doc); d.int.items = d.int.items.filter(function(o){ return !(o.f === f && o.x === x && o.z === z); }); return d; }
// the lobby's pet spots: its pet furniture, its ponds and the centrepiece's water (a fountain or the aquarium wall)
var CENTRE_WATER = {fountain: {x: -1.5, z: 3.4}, aquarium: {x: -1.5, z: 3.4}};
function petSpots(doc){
  var d = clean(doc), out = [];
  d.int.items.forEach(function(it){ if(it.f === "lobby" && PET_SPOT[it.k]) out.push({x: it.x, z: it.z, kind: PET_SPOT[it.k], item: it.k}); });
  var cw = CENTRE_WATER[d.int.lobby.centre]; if(cw) out.push({x: cw.x, z: cw.z, kind: "water", item: d.int.lobby.centre});
  return out;
}
function key(doc){ return JSON.stringify(clean(doc)); }

HQV.hqStyle = {SCHEMA: SCHEMA, PRESETS: PRESETS, LOBBY_PRESETS: LOBBY_PRESETS, PET_SPOT: PET_SPOT, SIZE: SIZE, LABELS: LABELS,
  defaults: defaults, clean: clean, check: check, preset: preset, lobbyPreset: lobbyPreset, randomise: randomise,
  place: place, remove: remove, petSpots: petSpots, key: key, hashStr: hashStr, mulberry32: mulberry32};
})();
