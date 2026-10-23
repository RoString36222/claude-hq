/* Claude HQ: Pets (HQ 3.14) -- dogs, cats, dragons, dinosaurs and a sea serpent who follow you round.
 *
 * Not the creatures your sessions raise (those live at the desks and in the Pokédex): a pet is a companion you
 * adopt at the City's Pet shop, name, dress up and walk with in Mission Control, the Lobby, the Base, B1 and the
 * City. Up to MAX_OWNED pets, MAX_ACTIVE out with you at once; the rest live in your HQ lobby, where they roam,
 * nap, play and run to greet you.
 *
 *   SPECIES                 the roster, index for index backend/src/pets.rs SPECIES (presence sends the index)
 *   cleanName(s)            a name as the Arena keeps it, or null (the same charset, length and word filter)
 *   canAdopt(sp, o)         {ok, price, why}: free from its level, before it for its coins
 *   encode(pets) / decode   presence `pt` (the "pets" capability): up to 2 [species, variant, acc, stage, name]
 *   trailPush / trailAt     a breadcrumb trail of where the owner walked: pets follow it round corners
 *   step(st, cx, dt)        one pet's behaviour (follow, avoid, teleport, idle, react, fetch, tricks, fly, swim);
 *                           pure and deterministic (its own mulberry32 per pet), node-tested (tests/test_hqpets.py)
 *   lobbyStep(st, cx, dt)   a stay-home pet in the lobby: wander, nap on its spot, play, greet you
 *   spotFor(sp, spots, i)   which lobby "pet spot" ({x, z, kind}) a species uses
 *   throwBall(o, blocked)   where a thrown ball lands (short of a wall)
 *   model(THREE, o)         a pet: smooth merged parts (body, head) + instanced jointed legs, neck, tail, jaw, eyelids, ears,
 *                           membrane wings rebuilt each frame (pose: IK gaits, blinks, look-at): at most 6 draw calls
 *   create(c, opts)         the runtime games/hq3d.js drives each frame (frame, key, net, setOwned, setLobby)
 *   lobby(world, spots)     marks a world as your pets' home (the HQ revamp's lobby calls it with its pet spots)
 *   place / build           the Pet shop on a City lot (games/hqcity3d.js), its own name: Paws & Claws
 *
 * Effects (breath, puffs, sparkles, wisps, glitter, lightning, hearts) come from one pooled Points cloud, one line
 * set and six heart sprites per page, none of it in Calm (gentle idles only there). Original procedural models;
 * no third-party designs. Privacy: presence carries species/variant/acc/stage numbers and the name typed for the pet.
 */
(function(){
"use strict";
var G = typeof window !== "undefined" ? window : globalThis;
var HQV = G.HQV = G.HQV || {};
HQV.hqWorlds = HQV.hqWorlds || {};
var PI = Math.PI, TAU = PI*2;

/* ---------- the roster (pure) ---------- */
var MAX_OWNED = 6, MAX_ACTIVE = 2, NAME_MAX = 12, VARIANTS = 4, ACC_MAX = 31, AFF_MAX = 1000, STAGE_AT = [150, 400];
var ACC = {collar: 1, bandana: 2, hat: 4, saddle: 8, bow: 16};
var ACC_NAMES = [["collar", "Collar"], ["bandana", "Bandana"], ["hat", "Hat"], ["saddle", "Saddle"], ["bow", "Bow"]];
var KIND_LABEL = {dog: "Dog", cat: "Cat", dragon: "Dragon", dino: "Dinosaur", serpent: "Sea serpent"};
var BAD_WORDS = ["fuck", "shit", "cunt", "bitch", "dick", "cock", "pussy", "nigg", "fag", "slut", "whore", "rape", "nazi",
                 "twat", "wank", "porn", "penis", "vagin", "asshole", "bastard", "hitler", "retard"];
// form: the body plan (quad / biped / serpent); L, H, W body length, depth, width; leg height; head radius; snout;
// ears / tail kinds; size: the whole pet's scale; pal: four variants [main, second, belly, eyes]; pat: a pattern;
// fin: the material (matte, ice, crystal, shadow, gold); fx: its element effect; fly: has wings; swim: swims
function S(id, name, kind, minLevel, price, saddle, grows, o){
  var s = {id: id, name: name, kind: kind, minLevel: minLevel, price: price, saddle: saddle, grows: grows};
  for(var k in o) s[k] = o[k];
  return s;
}
var DOG = {form: "quad", W: 0.24, ears: "point", tail: "curl", fin: "matte"};
function X(a, b){ var o = {}, k; for(k in a) o[k] = a[k]; for(k in b) o[k] = b[k]; return o; }
var SPECIES = [
  S("shiba", "Shiba", "dog", 1, 0, false, false, X(DOG, {L: 0.55, H: 0.26, legH: 0.2, head: 0.13, snout: 0.09, size: 1,
    pal: [[0xd9824a, 0xf6ead8, 0xf6ead8, 0x1a1210], [0xb8763f, 0x4a3426, 0xf2e2c8, 0x1a1210], [0x2b2522, 0xc88a4e, 0xf3e6d0, 0x1a1210], [0xf0dfc0, 0xfff6e8, 0xfff6e8, 0x1a1210]]})),
  S("retriever", "Golden Retriever", "dog", 1, 0, false, false, X(DOG, {L: 0.72, H: 0.32, W: 0.28, legH: 0.3, head: 0.15, snout: 0.13, ears: "flop", tail: "plume", size: 1,
    pal: [[0xd9a24e, 0xe8bd72, 0xf0d29a, 0x1a1210], [0xead7a8, 0xf3e6c4, 0xfaf2de, 0x1a1210], [0xb8642e, 0xcf8048, 0xdf9a62, 0x1a1210], [0x8a5a2b, 0xa06c38, 0xb88550, 0x1a1210]]})),
  S("corgi", "Corgi", "dog", 1, 0, false, false, X(DOG, {L: 0.58, H: 0.26, W: 0.26, legH: 0.1, head: 0.14, snout: 0.1, ears: "big", tail: "stub", size: 1,
    pal: [[0xe08a3c, 0xfff6ea, 0xfff6ea, 0x1a1210], [0x2b2522, 0xd08a4a, 0xfff6ea, 0x1a1210], [0xa8642e, 0x3a2a20, 0xfff2e0, 0x1a1210], [0xe8c48c, 0xfff6ea, 0xfff6ea, 0x1a1210]]})),
  S("husky", "Husky", "dog", 1, 0, false, false, X(DOG, {L: 0.7, H: 0.32, W: 0.27, legH: 0.28, head: 0.15, snout: 0.12, tail: "plume", pat: "mask", size: 1,
    pal: [[0x7f8790, 0xf4f6f8, 0xf4f6f8, 0x5aa9e6], [0x26282c, 0xf4f6f8, 0xf4f6f8, 0x5aa9e6], [0xb0643a, 0xf8f0ea, 0xf8f0ea, 0x6b4a2a], [0xf2f4f6, 0xffffff, 0xffffff, 0x5aa9e6]]})),
  S("dachshund", "Dachshund", "dog", 1, 0, false, false, X(DOG, {L: 0.72, H: 0.2, W: 0.2, legH: 0.09, head: 0.12, snout: 0.13, ears: "flop", tail: "thin", size: 1,
    pal: [[0xa8502a, 0xb8603a, 0xc87850, 0x1a1210], [0x221c1a, 0xb87040, 0xb87040, 0x1a1210], [0x5a3420, 0x6e4430, 0x7e5440, 0x1a1210], [0x8a7a70, 0x5a4a40, 0xb0a090, 0x3a6ab0]], pat: "spots"})),
  S("tabby", "Tabby cat", "cat", 1, 0, false, false, {form: "quad", L: 0.46, H: 0.2, W: 0.18, legH: 0.18, head: 0.11, snout: 0.04, ears: "point", tail: "long", pat: "stripes", fin: "matte", size: 1,
    pal: [[0xe0903c, 0xa85a20, 0xf6e2c4, 0x7ab84a], [0x9a9ea4, 0x55595e, 0xe8eaec, 0xd8b04a], [0x8a6a4a, 0x4a3420, 0xe2d2bc, 0x7ab84a], [0xc8ccd0, 0x6a7078, 0xf4f4f4, 0x4a9ad8]]}),
  S("siamese", "Siamese cat", "cat", 1, 0, false, false, {form: "quad", L: 0.46, H: 0.19, W: 0.17, legH: 0.19, head: 0.105, snout: 0.045, ears: "big", tail: "long", pat: "points", fin: "matte", size: 1,
    pal: [[0xf2e6d2, 0x4a3426, 0xfaf2e6, 0x4aa8f0], [0xeceef0, 0x5a6878, 0xf8f8fa, 0x4aa8f0], [0xf4e8d8, 0x7a5236, 0xfaf4ea, 0x4aa8f0], [0xf6f0ec, 0xa8949a, 0xfcf8f6, 0x6ab8f4]]}),
  S("mainecoon", "Maine Coon", "cat", 1, 0, false, false, {form: "quad", L: 0.6, H: 0.26, W: 0.24, legH: 0.21, head: 0.14, snout: 0.05, ears: "tuft", tail: "plume", pat: "stripes", fin: "matte", size: 1,
    pal: [[0x7a5a3a, 0x3e2a1a, 0xe6d6c0, 0xc8a83a], [0xc8783a, 0x8a4a1a, 0xf4e0c8, 0xc8a83a], [0x34363a, 0x18191c, 0xc8cacc, 0xd8b84a], [0xe8d4b4, 0xc8a878, 0xfaf0e0, 0x7ab84a]]}),
  S("blackcat", "Black cat", "cat", 1, 0, false, false, {form: "quad", L: 0.45, H: 0.19, W: 0.17, legH: 0.19, head: 0.105, snout: 0.04, ears: "point", tail: "long", fin: "matte", size: 1,
    pal: [[0x1c1b20, 0x26252c, 0x2a2930, 0xf0d040], [0x1c1b20, 0x26252c, 0x2a2930, 0x6ad86a], [0x1c1b20, 0x26252c, 0x2a2930, 0x5ab4f4], [0x1c1b20, 0x26252c, 0xf4f4f4, 0xf0a040]]}),
  S("wyvern", "Wyvern", "dragon", 6, 400, false, true, {form: "biped", L: 0.5, H: 0.24, W: 0.2, legH: 0.22, head: 0.12, snout: 0.12, ears: "horn", tail: "dragon", fly: true, fin: "matte", size: 1,
    pal: [[0x4caf6a, 0x2e7a44, 0xd8e8a0, 0xf0c030], [0x8a5ac8, 0x5a3a8a, 0xe0c8f0, 0xf0c030], [0x2ab0a8, 0x1a7a74, 0xc0f0e0, 0xf08030], [0xb8603a, 0x7a3a20, 0xf0d0a0, 0xf0e040]]}),
  S("firedragon", "Fire dragon", "dragon", 10, 800, true, true, {form: "quad", L: 0.62, H: 0.28, W: 0.26, legH: 0.2, head: 0.14, snout: 0.14, ears: "horn", tail: "dragon", fly: true, spikes: 1, fin: "matte", fx: "fire", size: 1,
    pal: [[0xd8342a, 0x8a1a14, 0xf8b040, 0xffd040], [0xe86a1a, 0xa83a10, 0xf8d060, 0xffe060], [0x6a1a1a, 0x3a0c0c, 0xf86a2a, 0xff8a2a], [0xf0a020, 0xb05a10, 0xfff0a0, 0xd02a10]]}),
  S("icedragon", "Ice dragon", "dragon", 10, 800, true, true, {form: "quad", L: 0.62, H: 0.28, W: 0.26, legH: 0.2, head: 0.14, snout: 0.14, ears: "horn", tail: "dragon", fly: true, spikes: 2, frost: 1, fin: "ice", fx: "ice", size: 1,
    pal: [[0xbfe6ff, 0xffffff, 0xeaf8ff, 0x2a7ad8], [0x9fd4f4, 0xe8f6ff, 0xffffff, 0x1a5ab8], [0xd8f0ff, 0x8ac8f0, 0xffffff, 0x4a9af8], [0xe8f4fa, 0xb8dcf0, 0xffffff, 0x3a6ac8]]}),
  S("stormdragon", "Storm dragon", "dragon", 15, 1500, true, true, {form: "quad", L: 0.64, H: 0.28, W: 0.26, legH: 0.2, head: 0.14, snout: 0.14, ears: "horn", tail: "dragon", fly: true, spikes: 1, glowEyes: 0xffe860, fin: "matte", fx: "storm", size: 1,
    pal: [[0x2a3a5a, 0x16203a, 0xf0d040, 0xffe860], [0x4a4e5a, 0x262a34, 0x8ad0ff, 0x8ad0ff], [0x3a2a5a, 0x1e1636, 0xc8a0ff, 0xe0c8ff], [0x5a6a7a, 0x34404c, 0xfff0a0, 0xfff0a0]]}),
  S("trex", "T-Rex pup", "dino", 5, 300, true, false, {form: "biped", L: 0.6, H: 0.3, W: 0.26, legH: 0.3, head: 0.17, snout: 0.16, ears: "none", tail: "thick", arms: 1, fin: "matte", size: 1.15,
    pal: [[0x5a8a3a, 0x3a5a24, 0xd8d8a0, 0xf0c030], [0x8a6a3a, 0x5a4024, 0xe8d8b0, 0xf0c030], [0x4a6a7a, 0x2a4450, 0xd0e0e0, 0xf0a030], [0xd08a3a, 0x8a4a1a, 0xf8e0b0, 0x2a2a2a]], pat: "stripes"}),
  S("triceratops", "Triceratops", "dino", 5, 300, true, false, {form: "quad", L: 0.7, H: 0.36, W: 0.34, legH: 0.18, head: 0.17, snout: 0.12, ears: "frill", tail: "thick", fin: "matte", size: 1.2,
    pal: [[0x6a8a9a, 0x3e5a68, 0xd0d8c0, 0x2a2a2a], [0x9a7a4a, 0x6a4a2a, 0xe0d0a8, 0x2a2a2a], [0x7a9a5a, 0x4a6a34, 0xe0e8b0, 0x2a2a2a], [0xa85a4a, 0x6a3428, 0xf0d0b0, 0x2a2a2a]], pat: "spots"}),
  S("raptor", "Raptor", "dino", 5, 300, false, false, {form: "biped", L: 0.56, H: 0.2, W: 0.18, legH: 0.3, head: 0.11, snout: 0.15, ears: "none", tail: "thin", arms: 1, crest: 1, fin: "matte", size: 1.1,
    pal: [[0x8a7a4a, 0x4a3a20, 0xe0d8b0, 0xe08a20], [0x4a7a5a, 0x2a4a34, 0xd0e8c0, 0xe0c020], [0x5a5a6a, 0x2a2a3a, 0xd8d8e0, 0xe03a20], [0xc87a3a, 0x7a3a1a, 0xf8e0b0, 0x3a8ae0]], pat: "stripes"}),
  S("brachio", "Brachiosaurus baby", "dino", 10, 800, true, false, {form: "quad", L: 0.75, H: 0.38, W: 0.34, legH: 0.34, head: 0.11, snout: 0.08, ears: "none", tail: "long", neck: 0.85, fin: "matte", size: 1.3,
    pal: [[0x7aa0a8, 0x4a7078, 0xd8e8e0, 0x2a2a2a], [0x9aa86a, 0x6a7a3a, 0xe8f0c0, 0x2a2a2a], [0xa89070, 0x7a6040, 0xf0e0c8, 0x2a2a2a], [0x8a8ab8, 0x5a5a8a, 0xe0e0f8, 0x2a2a2a]], pat: "spots"}),
  S("stego", "Stegosaurus", "dino", 5, 300, true, false, {form: "quad", L: 0.72, H: 0.34, W: 0.3, legH: 0.2, head: 0.09, snout: 0.08, ears: "none", tail: "spiked", plates: 1, fin: "matte", size: 1.15,
    pal: [[0x7a9a4a, 0x4a6a2a, 0xe0e8b0, 0x2a2a2a], [0x6a8aa0, 0x3a5a70, 0xd8e8f0, 0x2a2a2a], [0xa07a4a, 0x6a4a24, 0xf0e0b8, 0x2a2a2a], [0x8a6aa0, 0x5a3a70, 0xe8d8f0, 0x2a2a2a]]}),
  S("crystaldragon", "Crystal dragon", "dragon", 25, 3000, true, true, {form: "quad", L: 0.62, H: 0.28, W: 0.26, legH: 0.2, head: 0.14, snout: 0.14, ears: "horn", tail: "dragon", fly: true, spikes: 2, gems: 1, fin: "crystal", fx: "sparkle", size: 1,
    pal: [[0xc8a0ff, 0x8ae0ff, 0xf0e0ff, 0xffffff], [0x8af0d8, 0xc0a0ff, 0xe0fff8, 0xffffff], [0xff9ad8, 0x9ad8ff, 0xffe0f4, 0xffffff], [0xe0f4ff, 0xb8a0ff, 0xffffff, 0xffffff]]}),
  S("shadowdragon", "Shadow dragon", "dragon", 20, 2500, true, true, {form: "quad", L: 0.64, H: 0.28, W: 0.26, legH: 0.2, head: 0.14, snout: 0.14, ears: "horn", tail: "dragon", fly: true, spikes: 1, glowEyes: 0xb46aff, fin: "shadow", fx: "wisp", size: 1,
    pal: [[0x1a1622, 0x0c0a12, 0x3a2a4a, 0xb46aff], [0x16181e, 0x0a0b0e, 0x2a2e3a, 0x8a6aff], [0x221622, 0x100a10, 0x4a2a3a, 0xff6ad8], [0x101418, 0x06080a, 0x203038, 0x6ad8ff]]}),
  S("golddragon", "Golden dragon", "dragon", 30, 5000, true, true, {form: "quad", L: 0.66, H: 0.29, W: 0.27, legH: 0.21, head: 0.15, snout: 0.14, ears: "horn", tail: "dragon", fly: true, spikes: 1, crest: 2, fin: "gold", fx: "glitter", size: 1,
    pal: [[0xffc93a, 0xd89a1a, 0xfff0a0, 0x8a1a1a], [0xf0b030, 0xb8781a, 0xffe08a, 0x1a4ab8], [0xffd870, 0xe0a840, 0xfff6c8, 0x1a8a4a], [0xe8a040, 0xa8601a, 0xffd08a, 0x6a1a8a]]}),
  S("seaserpent", "Sea serpent", "serpent", 18, 2000, false, true, {form: "serpent", L: 1.6, H: 0.24, W: 0.24, legH: 0, head: 0.17, snout: 0.14, ears: "fin", tail: "fin", swim: true, fin: "matte", fx: "bubbles", size: 1.3,
    pal: [[0x2aa8a8, 0x1a6a7a, 0xc8f0e0, 0xffe040], [0x2a5ab8, 0x1a3478, 0xc0d8f8, 0xffe040], [0xf07a6a, 0xb04a4a, 0xffe0d0, 0x2a2a2a], [0x3ab86a, 0x1a7a44, 0xd0f8d8, 0xffa020]]})
];
var BY_ID = {}; SPECIES.forEach(function(s, i){ s.index = i; BY_ID[s.id] = s; });
function speciesOf(id){ return typeof id === "number" ? SPECIES[id] || null : BY_ID[id] || null; }
function stageOf(sp, aff){ if(!sp || !sp.grows) return 0; aff = +aff || 0; return aff >= STAGE_AT[1] ? 2 : aff >= STAGE_AT[0] ? 1 : 0; }
// tricks a pet knows at this affection (the first always): sit, spin, beg, roll over, and a big one by kind
var TRICKS = [["sit", 0, "Sit"], ["spin", 20, "Spin"], ["beg", 60, "Beg"], ["roll", 120, "Roll over"], ["big", 250, null]];
var BIG = {dog: "Backflip", cat: "Backflip", dragon: "Loop the loop", dino: "Mighty roar", serpent: "Corkscrew"};
function tricksFor(sp, aff){
  aff = +aff || 0;
  return TRICKS.filter(function(t){ return aff >= t[1]; }).map(function(t){ return {id: t[0], label: t[2] || BIG[(sp && sp.kind) || "dog"]}; });
}
function nextTrick(sp, aff){ var T = TRICKS.filter(function(t){ return (+aff || 0) < t[1]; })[0]; return T ? {at: T[1], label: T[2] || BIG[(sp && sp.kind) || "dog"]} : null; }

function letters(s){
  var map = {"0": "o", "1": "i", "!": "i", "3": "e", "4": "a", "@": "a", "5": "s", "$": "s", "7": "t"}, out = "";
  s = String(s || "").toLowerCase();
  for(var i = 0; i < s.length; i++){ var c = map[s[i]] || s[i]; if(c >= "a" && c <= "z") out += c; }
  return out;
}
// The name the Arena keeps (backend/src/pets.rs clean_name): trimmed, single spaces, 1..12 of A-Z a-z 0-9 space - ',
// a letter or digit in it, none of BAD_WORDS. null for anything else.
function cleanName(raw){
  if(typeof raw !== "string") return null;
  var s = raw.split(" ").filter(function(w){ return w; }).join(" ");
  if(!s.length || s.length > NAME_MAX || !/^[A-Za-z0-9 '\-]+$/.test(s) || !/[A-Za-z0-9]/.test(s)) return null;
  var l = letters(s);
  for(var i = 0; i < BAD_WORDS.length; i++) if(l.indexOf(BAD_WORDS[i]) >= 0) return null;
  return s;
}
function accOk(sp, acc){ acc = +acc; return acc === (acc | 0) && acc >= 0 && acc <= ACC_MAX && (!!(sp && sp.saddle) || !(acc & ACC.saddle)); }
// Adoption (the Arena checks it again): free from its level; before that, its price in Poke Coins; never past 6 pets.
function canAdopt(sp, o){
  o = o || {}; if(!sp) return {ok: false, price: 0, why: "No such pet."};
  var level = Math.max(1, +o.level || 1), coins = Math.max(0, +o.coins || 0), owned = Math.max(0, o.owned | 0);
  if(owned >= MAX_OWNED) return {ok: false, price: 0, why: "You have " + MAX_OWNED + " pets: rehome one first."};
  if(level >= sp.minLevel) return {ok: true, price: 0, why: null};
  if(o.local) return {ok: false, price: 0, why: "Free at level " + sp.minLevel + "."};
  if(coins >= sp.price) return {ok: true, price: sp.price, why: null};
  return {ok: false, price: sp.price, why: "Free at level " + sp.minLevel + ", or " + sp.price + " Poke Coins now."};
}

/* ---------- presence (pure) ---------- */
// pets -> `pt`: [[species index, variant, acc, stage, name], ...] at most MAX_ACTIVE, only well-formed ones
function encode(pets){
  var out = [];
  (pets || []).forEach(function(p){
    if(out.length >= MAX_ACTIVE || !p) return;
    var sp = speciesOf(p.species), n = cleanName(p.name);
    if(!sp || !n) return;
    var v = Math.max(0, Math.min(VARIANTS - 1, p.variant | 0)), a = accOk(sp, p.acc) ? p.acc | 0 : (p.acc | 0) & ACC_MAX & ~(sp.saddle ? 0 : ACC.saddle);
    out.push([sp.index, v, a, stageOf(sp, p.affection), n]);
  });
  return out;
}
// `pt` from someone else -> [{sp, variant, acc, stage, name}] (anything malformed dropped, as the Arena would)
function decode(pt){
  if(!Array.isArray(pt)) return [];
  var out = [];
  for(var i = 0; i < pt.length && out.length < MAX_ACTIVE; i++){
    var t = pt[i]; if(!Array.isArray(t) || t.length !== 5) continue;
    var sp = SPECIES[t[0]], n = cleanName(t[4]);
    if(!sp || t[0] !== (t[0] | 0) || !n || !(t[1] >= 0 && t[1] < VARIANTS) || !accOk(sp, t[2]) || !(t[3] >= 0 && t[3] <= 2)) continue;
    out.push({sp: sp, variant: t[1] | 0, acc: t[2] | 0, stage: t[3] | 0, name: n});
  }
  return out;
}

/* ---------- behaviour (pure) ---------- */
function hashStr(s){ var h = 2166136261 >>> 0; s = String(s); for(var i = 0; i < s.length; i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h >>> 0; }
function mulberry32(a){ a = a >>> 0 || 1; return function(){ a = (a + 0x6D2B79F5) >>> 0; var t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0)/4294967296; }; }
// a pet's next random number: its seed and how many it has drawn, so the same pet does the same thing (replays, tests)
function draw(st){ st.n = (st.n | 0) + 1; return mulberry32((st.seed >>> 0) ^ Math.imul(st.n, 2654435761))(); }
function wrapPi(a){ a = +a || 0; return Math.atan2(Math.sin(a), Math.cos(a)); }
var SPEED = {dog: 7, cat: 6.5, dragon: 7.5, dino: 6.5, serpent: 6};
var GAP = {dog: 1.5, cat: 1.4, dragon: 1.8, dino: 2.1, serpent: 2.4};
var TELEPORT_D = 26, STUCK_S = 1.6;
// idles by kind [anim, min s, max s, gentle (Calm keeps it)]
var IDLES = {
  dog: [["sit", 3, 6, 1], ["sniff", 2, 3.5, 1], ["wag", 2, 4, 1], ["shake", 1.2, 1.6, 0], ["yawn", 1.6, 2.2, 1]],
  cat: [["sit", 3, 6, 1], ["groom", 3, 5, 1], ["wag", 2, 3, 1], ["yawn", 1.6, 2.2, 1], ["stretch", 1.6, 2.4, 0]],
  dragon: [["sit", 3, 6, 1], ["wings", 2, 3, 0], ["puff", 1.4, 2, 0], ["breath", 1.6, 2.2, 0], ["yawn", 1.6, 2.2, 1]],
  dino: [["sit", 3, 6, 1], ["sniff", 2, 3.5, 1], ["stomp", 1.4, 2, 0], ["roar", 1.6, 2.2, 0], ["wag", 2, 3, 1]],
  serpent: [["coil", 3, 6, 1], ["sniff", 2, 3, 1], ["puff", 1.4, 2, 0], ["yawn", 1.6, 2.2, 1]]
};
function pickIdle(st, kind, calm){
  var L = (IDLES[kind] || IDLES.dog).filter(function(i){ return !calm || i[3]; });
  var r = draw(st), I = L[Math.min(L.length - 1, Math.floor(r*L.length))], r2 = draw(st);
  return {k: I[0], dur: I[1] + (I[2] - I[1])*r2, t: 0};
}
function newState(seed, x, z, yaw){
  return {x: +x || 0, z: +z || 0, y: 0, yaw: +yaw || 0, speed: 0, mode: "follow", t: 0, idle: null, n: 0, seed: seed >>> 0,
          ph: 0, anim: "stand", stuck: 0, still: 0, hidden: false, trick: null, fx: null, react: 0, ownerSp: 0};
}
// The owner's trail: a point every 0.5 m (at most 64), newest last. A jump (teleport, another world) starts it again.
function trailPush(tr, x, z){
  tr = tr || [];
  var L = tr[tr.length - 1];
  if(L && Math.hypot(x - L.x, z - L.z) > 12) tr.length = 0;
  if(!L || tr.length === 0 || Math.hypot(x - tr[tr.length - 1].x, z - tr[tr.length - 1].z) >= 0.5) tr.push({x: x, z: z});
  if(tr.length > 64) tr.splice(0, tr.length - 64);
  return tr;
}
// the point `d` metres back along the trail from the owner (x, z), with the trail's heading there; null when too short
function trailAt(tr, x, z, d){
  if(!tr || !tr.length) return null;
  var px = x, pz = z, left = d;
  for(var i = tr.length - 1; i >= 0; i--){
    var q = tr[i], seg = Math.hypot(px - q.x, pz - q.z);
    if(seg >= left && seg > 1e-6){ var k = left/seg; return {x: px + (q.x - px)*k, z: pz + (q.z - pz)*k, dir: Math.atan2(px - q.x, pz - q.z)}; }
    left -= seg; px = q.x; pz = q.z;
  }
  return null;
}
// Where a pet in `slot` (0 right, 1 left) wants to be: back along your trail, a little to the side
function followTarget(owner, slot, kind, trail){
  var gap = (GAP[kind] || 1.5) + (slot ? 0.9 : 0), side = slot ? -0.6 : 0.6;
  var p = trailAt(trail, owner.x, owner.z, gap), dir = p ? p.dir : owner.yaw;
  if(!p) p = {x: owner.x - Math.sin(owner.yaw)*gap, z: owner.z - Math.cos(owner.yaw)*gap};
  // right of the heading is (-cos, sin) for yaw measured from +z toward +x
  return {x: p.x - Math.cos(dir)*side, z: p.z + Math.sin(dir)*side, dir: dir};
}
// Step toward (tx, tz) at most `dist`, turning round anything blocked; true when it moved
function moveToward(st, tx, tz, dist, blocked, dt){
  var want = Math.atan2(tx - st.x, tz - st.z), turn = wrapPi(want - st.yaw), rate = 9*dt;
  st.yaw = wrapPi(st.yaw + Math.max(-rate, Math.min(rate, turn)));
  if(dist <= 0) return false;
  var tries = [0, 0.6, -0.6, 1.2, -1.2, 1.8, -1.8];
  for(var i = 0; i < tries.length; i++){
    var a = (Math.abs(turn) > 1.2 ? want : st.yaw) + tries[i], nx = st.x + Math.sin(a)*dist, nz = st.z + Math.cos(a)*dist;
    if(!blocked || !blocked(nx, nz) || blocked(st.x, st.z)){
      st.x = nx; st.z = nz; if(i) st.yaw = wrapPi(st.yaw + (a - st.yaw)*Math.min(1, dt*6)); st.stuck = 0; return true;
    }
  }
  st.stuck += dt; return false;
}
// a clear spot beside the owner (a teleport back, out of a car)
function besideOwner(owner, slot, blocked){
  var s = slot ? -1 : 1, c = [[0.9*s, -1.2], [1.4*s, 0], [-0.9*s, -1.2], [0, -1.6], [1.6*s, -1.8], [-1.6*s, 0], [0, 1.4]];
  var cs = Math.cos(owner.yaw), sn = Math.sin(owner.yaw);
  for(var i = 0; i < c.length; i++){
    var x = owner.x + c[i][1]*sn - c[i][0]*cs, z = owner.z + c[i][1]*cs + c[i][0]*sn;
    if(!blocked || !blocked(x, z)) return {x: x, z: z};
  }
  return {x: owner.x, z: owner.z};
}
// Where a ball thrown from (x, z) along yaw lands: up to `far` m, short of the first blocked point
function throwBall(o, blocked, far){
  far = far || 11; var land = {x: o.x, z: o.z}, sn = Math.sin(o.yaw), cs = Math.cos(o.yaw);
  for(var d = 1; d <= far; d += 0.5){
    var x = o.x + sn*d, z = o.z + cs*d;
    if(blocked && blocked(x, z)) break;
    land = {x: x, z: z};
  }
  land.d = Math.hypot(land.x - o.x, land.z - o.z);
  return land;
}
// One pet's step. cx: {owner {x, z, yaw, speed, run, ride: null | {kind, air, boat, water, h, speed}}, slot, sp, trail,
// blocked(x, z), water(x, z) (sea serpents), calm, ball: null | {x, z, landed}, fetcher}. Returns events [{type}].
function step(st, cx, dt){
  var ev = [], o = cx.owner, sp = cx.sp || SPECIES[0], kind = sp.kind, calm = !!cx.calm, blocked = cx.blocked;
  dt = Math.max(0, Math.min(0.1, +dt || 0));
  st.t += dt;
  var ride = o.ride || null, flyer = !!sp.fly, swimmer = !!sp.swim;
  // a sea serpent goes where the water is too (blocked to walkers)
  if(swimmer && cx.water && blocked){ var b0 = blocked; blocked = function(x, z){ return b0(x, z) && !cx.water(x, z); }; }
  var d0 = Math.hypot(o.x - st.x, o.z - st.z);
  // reactions: you stopped (they look up at you), you broke into a run (an excited hop; not in Calm)
  var osp = Math.abs(+o.speed || 0);
  if(!calm && !o.ride && osp > 4 && st.ownerSp <= 4 && (st.mode === "idle" || st.mode === "follow") && d0 < 6){ st.react = 0.5; ev.push({type: "excited"}); }
  st.ownerSp = osp;
  st.still = osp < 0.2 && !ride ? st.still + dt : 0;
  if(st.react > 0) st.react = Math.max(0, st.react - dt);
  // ---- in a vehicle ----
  if(ride){
    var air = !!ride.air, boat = !!ride.boat || !!ride.water;
    if(flyer || (swimmer && boat)){
      // alongside, at a safe offset: wide of a plane or a helicopter, close beside a car, a bike or a boat
      var side = (air ? 16 : swimmer ? 5 : 3.2)*(cx.slot ? -1 : 1), back = air ? 7 : 2.5, up = swimmer ? 0 : air ? 2 : 3;
      var cs = Math.cos(o.yaw), sn = Math.sin(o.yaw);
      var tx = o.x - sn*back - cs*side, tz = o.z - cs*back + sn*side, ty = Math.max(0, (+ride.h || 0) + up);
      if(Math.hypot(tx - st.x, tz - st.z) > (air ? 120 : 40)){ st.x = tx; st.z = tz; st.y = ty; ev.push({type: "teleport"}); }
      var k = 1 - Math.exp(-dt*(air ? 3 : 5));
      st.x += (tx - st.x)*k; st.z += (tz - st.z)*k; st.y += (ty - st.y)*k;
      st.yaw = wrapPi(st.yaw + wrapPi(o.yaw - st.yaw)*Math.min(1, dt*4));
      st.speed = Math.abs(+ride.speed || 0); st.mode = swimmer ? "swim" : "fly"; st.anim = st.mode; st.hidden = false;
      st.ph += dt*(st.mode === "fly" ? 3.2 : 2.2);
      return ev;
    }
    if(osp > 7 || ride.air){
      // too fast to trot after: hop in and ride along (out of sight) until you stop or get out
      if(!st.hidden){ st.hidden = true; ev.push({type: "board"}); }
      st.x = o.x; st.z = o.z; st.y = 0; st.mode = "aboard"; st.anim = "sit"; st.speed = 0; return ev;
    }
  }
  if(st.hidden){ var b = besideOwner(o, cx.slot, blocked); st.x = b.x; st.z = b.z; st.y = 0; st.yaw = o.yaw; st.hidden = false; st.mode = "follow"; ev.push({type: "hopout"}); d0 = Math.hypot(o.x - st.x, o.z - st.z); }
  // ---- tricks, petting (stand still and do it) ----
  if(st.trick){
    st.trick.t += dt; st.anim = st.trick.k; st.speed = 0; st.mode = "trick";
    st.yaw = wrapPi(st.yaw + wrapPi(Math.atan2(o.x - st.x, o.z - st.z) - st.yaw)*Math.min(1, dt*5));
    if(st.trick.t >= st.trick.dur){ ev.push({type: "trickdone", k: st.trick.k}); st.trick = null; st.mode = "idle"; st.idle = null; }
    st.y += (0 - st.y)*Math.min(1, dt*6);
    return ev;
  }
  // ---- fetch ----
  if(cx.fetcher && cx.ball && (st.mode === "fetch" || st.mode === "carry" || cx.ball.fresh)){
    var B = cx.ball;
    if(st.mode !== "carry"){
      st.mode = "fetch";
      var db = Math.hypot(B.x - st.x, B.z - st.z);
      if(B.landed && db < 0.5){ st.mode = "carry"; ev.push({type: "pickup"}); }
      else { st.speed += ((SPEED[kind] || 7) - st.speed)*Math.min(1, dt*6); moveToward(st, B.x, B.z, Math.min(db, st.speed*dt), blocked, dt); }
      st.anim = "run"; st.ph += st.speed*dt*2.2;
      if(st.stuck > STUCK_S){ st.mode = "carry"; ev.push({type: "pickup"}); }
      return ev;
    }
    if(d0 < 1.1){ st.mode = "idle"; st.idle = {k: "wag", dur: 2, t: 0}; st.speed = 0; ev.push({type: "drop"}); return ev; }
    st.speed += ((SPEED[kind] || 7)*0.8 - st.speed)*Math.min(1, dt*6);
    moveToward(st, o.x, o.z, Math.min(d0 - 0.9, st.speed*dt), blocked, dt);
    st.anim = "carry"; st.ph += st.speed*dt*2.2;
    if(st.stuck > STUCK_S || d0 > TELEPORT_D){ var bb = besideOwner(o, cx.slot, blocked); st.x = bb.x; st.z = bb.z; st.stuck = 0; ev.push({type: "teleport"}); }
    return ev;
  }
  // ---- following ----
  var T = followTarget(o, cx.slot | 0, kind, cx.trail), dT = Math.hypot(T.x - st.x, T.z - st.z);
  // no headway for a while (boxed in, sliding along a wall): count it as stuck
  if(!st.prog || dT < st.prog.d - 0.3 || dT < 4){ st.prog = {d: dT, t: 0}; } else st.prog.t += dt;
  if(d0 > TELEPORT_D || st.stuck > STUCK_S || st.prog.t > 2.5){
    st.prog = null;
    var p = besideOwner(o, cx.slot, blocked); st.x = p.x; st.z = p.z; st.yaw = o.yaw; st.stuck = 0; st.speed = 0; ev.push({type: "teleport"});
    dT = Math.hypot(T.x - st.x, T.z - st.z);
  }
  var wasIdle = st.mode === "idle";
  if(st.mode === "idle" && dT < 1.6 && osp < 1.2){
    // idle: one thing after another (deterministic per pet), looking up at you; a long wait ends in a nap
    if(!st.idle || st.idle.t >= st.idle.dur) st.idle = st.still > 30 ? {k: "sleep", dur: 1e9, t: 0} : pickIdle(st, kind, calm);
    st.idle.t += dt; st.anim = st.idle.k; st.speed = 0;
    if(st.idle.t < dt*1.5 && st.idle.k !== "sleep") ev.push({type: "idle", k: st.idle.k});
    var face = Math.atan2(o.x - st.x, o.z - st.z);
    if(st.idle.k !== "sleep" && st.idle.k !== "groom") st.yaw = wrapPi(st.yaw + wrapPi(face - st.yaw)*Math.min(1, dt*3));
  } else {
    if(wasIdle){ st.mode = "follow"; st.idle = null; }
    var maxSp = (SPEED[kind] || 7)*(sp.size > 1.2 ? 0.9 : 1);
    var want = dT < 0.35 ? 0 : Math.min(maxSp, Math.max(osp, (dT - 0.25)*2.4));
    if(dT > 4) want = maxSp;
    st.speed += (want - st.speed)*Math.min(1, dt*6);
    moveToward(st, T.x, T.z, Math.min(dT, st.speed*dt), blocked, dt);
    if(st.speed < 0.15 && dT < 0.6){ st.yaw = wrapPi(st.yaw + wrapPi(T.dir - st.yaw)*Math.min(1, dt*3)); if(osp < 0.2){ st.mode = "idle"; st.idle = {k: calm ? "sit" : "look", dur: 1.2, t: 0}; } }
    st.anim = st.speed > 3.2 ? "run" : st.speed > 0.15 ? "walk" : "stand";
    st.ph += st.speed*dt*(kind === "cat" ? 2.6 : 2.2);
  }
  // dragons lift off to keep up with you at a run (low); a sea serpent swims where there is water, else slithers
  var lift = flyer && !calm && st.speed > 4.5 ? 1.4 : flyer && st.speed > 4.5 ? 0.6 : 0;
  if(flyer && lift){ st.anim = "fly"; }
  if(swimmer){ var wet = cx.water ? !!cx.water(st.x, st.z) : false; st.anim = wet ? (st.speed > 0.15 ? "swim" : "float") : (st.speed > 0.15 ? "slither" : st.anim === "stand" ? "coil" : st.anim); st.wet = wet; lift = 0; }
  st.y += (lift - st.y)*Math.min(1, dt*3);
  return ev;
}

/* ---------- the lobby: stay-home pets (pure) ---------- */
var SPOT_PREF = {dragon: ["perch"], cat: ["tree", "bed"], dog: ["bed", "bowl"], dino: ["pen"], serpent: ["water"]};
// the spot (one of `spots`, {x, z, kind}) a pet of this species naps / waits at; i spreads several of a kind; null: none
function spotFor(sp, spots, i){
  var pref = SPOT_PREF[(sp && sp.kind) || "dog"] || [], list = (spots || []).filter(function(s){ return s && isFinite(s.x) && isFinite(s.z); });
  for(var k = 0; k < pref.length; k++){
    var of = list.filter(function(s){ return s.kind === pref[k]; });
    if(of.length) return of[(Math.max(0, i | 0)) % of.length];
  }
  return null;
}
function inBounds(b, x, z){ return !b || (x >= b[0] && x <= b[1] && z >= b[2] && z <= b[3]); }
// cx: {sp, i, owner (or null), bounds [x0, x1, z0, z1], blocked, spots, calm, mates: [{x, z, id}], greet}
function lobbyStep(st, cx, dt){
  var ev = [], sp = cx.sp || SPECIES[0], kind = sp.kind, calm = !!cx.calm, b = cx.bounds || [-10, 10, -10, 10];
  dt = Math.max(0, Math.min(0.1, +dt || 0)); st.t += dt;
  var o = cx.owner;
  if(cx.greet && o && st.mode !== "greet" && !st.greeted){ st.mode = "greet"; st.greeted = true; st.goal = null; st.t0 = st.t; }
  if(st.mode === "greet" && o){
    // run to you (spread round you), wag, then back to whatever they were doing
    var a = (cx.i | 0)*1.1 + 0.5, gx = o.x + Math.sin(o.yaw + a)*1.3, gz = o.z + Math.cos(o.yaw + a)*1.3, d = Math.hypot(gx - st.x, gz - st.z);
    if(d > 0.4 && st.t - st.t0 < 6){ st.speed += ((SPEED[kind] || 7)*0.85 - st.speed)*Math.min(1, dt*6); moveToward(st, gx, gz, Math.min(d, st.speed*dt), cx.blocked, dt); st.anim = "run"; st.ph += st.speed*dt*2.2; return ev; }
    if(!st.wag){ st.wag = st.t; ev.push({type: "greet"}); }
    st.anim = "wag"; st.speed = 0; st.yaw = wrapPi(st.yaw + wrapPi(Math.atan2(o.x - st.x, o.z - st.z) - st.yaw)*Math.min(1, dt*4));
    if(st.t - st.wag > 2.5){ st.mode = "wander"; st.wag = 0; st.goal = null; }
    return ev;
  }
  if(!st.goal || st.mode === "idle" && st.t >= st.until){
    var r = draw(st), spot = spotFor(sp, cx.spots, cx.i);
    var mates = (cx.mates || []).filter(function(m){ return m && m.id !== st.id && m.kind !== "serpent" && m.kind !== "dragon"; });
    if(r < 0.3 && spot){ st.mode = "nap"; st.goal = {x: spot.x, z: spot.z, kind: spot.kind}; }
    else if(r < 0.45 && !calm && mates.length && kind !== "serpent"){ var m = mates[Math.floor(draw(st)*mates.length) % mates.length]; st.mode = "play"; st.goal = {mate: m.id}; st.until = st.t + 5; }
    else {
      for(var k = 0; k < 8; k++){
        var x = b[0] + 1 + (b[1] - b[0] - 2)*draw(st), z = b[2] + 1 + (b[3] - b[2] - 2)*draw(st);
        if(!cx.blocked || !cx.blocked(x, z)){ st.goal = {x: x, z: z}; break; }
      }
      st.mode = "wander";
      if(!st.goal) st.goal = {x: st.x, z: st.z};
    }
  }
  if(st.mode === "play"){
    var M = (cx.mates || []).filter(function(m){ return m.id === st.goal.mate; })[0];
    if(!M || st.t >= st.until){ st.mode = "idle"; st.until = st.t + 1 + draw(st)*2; st.anim = "wag"; st.goal = {x: st.x, z: st.z}; return ev; }
    var dm = Math.hypot(M.x - st.x, M.z - st.z);
    st.speed += ((dm > 1 ? SPEED[kind]*0.75 : 0) - st.speed)*Math.min(1, dt*5);
    moveToward(st, M.x, M.z, Math.min(Math.max(0, dm - 0.8), st.speed*dt), cx.blocked, dt);
    st.anim = st.speed > 3 ? "run" : st.speed > 0.2 ? "walk" : "wag"; st.ph += st.speed*dt*2.2; return ev;
  }
  if(st.mode === "idle"){ st.speed = 0; return ev; }
  var dg = Math.hypot(st.goal.x - st.x, st.goal.z - st.z);
  if(dg < 0.35 || st.stuck > STUCK_S || !inBounds(b, st.x, st.z) && st.stuck > 0.5){
    st.stuck = 0; st.speed = 0;
    if(st.mode === "nap"){ st.mode = "idle"; st.anim = kind === "dragon" ? "sit" : kind === "serpent" ? "coil" : "sleep"; st.until = st.t + 10 + draw(st)*10; ev.push({type: "nap", spot: st.goal.kind}); }
    else { var I = pickIdle(st, kind, calm); st.mode = "idle"; st.anim = I.k; st.until = st.t + I.dur + 1; ev.push({type: "idle", k: I.k}); }
    return ev;
  }
  st.speed += ((SPEED[kind] || 7)*0.3 - st.speed)*Math.min(1, dt*4);
  moveToward(st, st.goal.x, st.goal.z, Math.min(dg, st.speed*dt), cx.blocked, dt);
  st.anim = kind === "serpent" ? "slither" : "walk"; st.ph += st.speed*dt*2.4;
  return ev;
}

/* ---------- models (three) ---------- */
// A pet is a few merged, smooth-shaded parts (body, head; glowing eyes their own, unlit) plus two InstancedMeshes
// posed every frame from a small skeleton kept in JS: "limbs" (one tapered capsule: jointed legs with paws, the
// neck, the tail's segments, the lower jaw, the tongue, eyelids, floppy ears) and "bits" (one cone: pointed ears,
// the tail's spade, spines and spikes). A dragon's wings are one double-sided mesh rebuilt each frame from an
// arm (shoulder, elbow, wrist) and four finger spars with a sagging membrane between them. At most 6 draw calls.
var FIN = {};   // shared materials by finish (+ "|2" double-sided for wings, "|i" for instanced parts), one set per page
var GEO = {};   // shared unit geometries (never disposed with a pet)
var ENV = null;
function envTex(T){
  if(ENV || typeof document === "undefined") return ENV;
  try {
    var cv = document.createElement("canvas"); cv.width = 64; cv.height = 32; var g = cv.getContext("2d");
    var gr = g.createLinearGradient(0, 0, 0, 32); gr.addColorStop(0, "#fff7e0"); gr.addColorStop(0.45, "#9fc4e8"); gr.addColorStop(0.55, "#5a4a3a"); gr.addColorStop(1, "#201a14");
    g.fillStyle = gr; g.fillRect(0, 0, 64, 32); g.fillStyle = "#ffffff"; g.fillRect(14, 4, 8, 3); g.fillRect(40, 6, 5, 2);
    ENV = new T.CanvasTexture(cv); ENV.mapping = T.EquirectangularReflectionMapping; ENV.colorSpace = T.SRGBColorSpace;
  } catch(e){ ENV = null; }
  return ENV;
}
function finMat(T, fin, ds, inst){
  var key = fin + (ds ? "|2" : "") + (inst ? "|i" : ""); if(FIN[key]) return FIN[key];
  var o = {vertexColors: !inst, flatShading: false, roughness: 0.82, metalness: 0.02};
  if(fin === "ice"){ o.roughness = 0.3; o.metalness = 0.1; o.emissive = new T.Color(0x9fdcff); o.emissiveIntensity = 0.06; }
  if(fin === "crystal"){ o.roughness = 0.08; o.metalness = 0.25; o.transparent = true; o.opacity = 0.8; o.emissive = new T.Color(0x8a6aff); o.emissiveIntensity = 0.25; o.envMap = envTex(T); o.envMapIntensity = 1.4; }
  if(fin === "shadow"){ o.roughness = 0.9; o.transparent = true; o.opacity = 0.96; }
  if(fin === "gold"){ o.roughness = 0.22; o.metalness = 0.9; o.envMap = envTex(T); o.envMapIntensity = 1.6; o.emissive = new T.Color(0x3a2400); o.emissiveIntensity = 0.35; }
  if(ds) o.side = T.DoubleSide;
  var m = new T.MeshStandardMaterial(o); m.userData.fin = fin; FIN[key] = m;
  return m;
}
var GLOW = null;
function glowMat(T){ if(!GLOW) GLOW = new T.MeshBasicMaterial({vertexColors: true, toneMapped: false}); return GLOW; }
// the unit limb: a capsule from y 0 to 1, radius 0.5, tapering a little toward its end
function limbGeo(T){
  if(GEO.limb) return GEO.limb;
  var g = new T.CapsuleGeometry(0.5, 1, 2, 7); g.translate(0, 1, 0); g.scale(1, 0.5, 1);
  var p = g.attributes.position;
  for(var i = 0; i < p.count; i++){ var k = 1 - 0.2*Math.max(0, Math.min(1, p.getY(i))); p.setX(i, p.getX(i)*k); p.setZ(i, p.getZ(i)*k); }
  g.computeVertexNormals(); g.userData.shared = true; GEO.limb = g; return g;
}
function bitGeo(T){ if(GEO.bit) return GEO.bit; var g = new T.ConeGeometry(0.5, 1, 6); g.translate(0, 0.5, 0); g.userData.shared = true; GEO.bit = g; return g; }
// a part under construction: triangles (non-indexed) with colours and smooth normals, merged into one BufferGeometry
function Part(T){ this.T = T; this.pos = []; this.col = []; this.nor = []; }
Part.prototype.add = function(geo, m4, hex){
  var T = this.T, g = geo.index ? geo.toNonIndexed() : geo; g.applyMatrix4(m4);
  var p = g.attributes.position.array, n = g.attributes.normal ? g.attributes.normal.array : null, c = new T.Color(hex), cc = g.attributes.color ? g.attributes.color.array : null;
  for(var i = 0; i < p.length; i += 3){
    this.pos.push(p[i], p[i + 1], p[i + 2]);
    if(n) this.nor.push(n[i], n[i + 1], n[i + 2]); else this.nor.push(0, 1, 0);
    if(cc) this.col.push(cc[i], cc[i + 1], cc[i + 2]); else this.col.push(c.r, c.g, c.b);
  }
  if(g !== geo) g.dispose(); geo.dispose();
};
Part.prototype.geometry = function(){
  var T = this.T, g = new T.BufferGeometry();
  g.setAttribute("position", new T.Float32BufferAttribute(this.pos, 3)); g.setAttribute("color", new T.Float32BufferAttribute(this.col, 3));
  g.setAttribute("normal", new T.Float32BufferAttribute(this.nor, 3));
  return g;
};
Part.prototype.tris = function(){ return this.pos.length/9; };
function M4(T, x, y, z, rx, ry, rz, sx, sy, sz){
  var m = new T.Matrix4(), q = new T.Quaternion().setFromEuler(new T.Euler(rx || 0, ry || 0, rz || 0, "YXZ"));
  return m.compose(new T.Vector3(x || 0, y || 0, z || 0), q, new T.Vector3(sx == null ? 1 : sx, sy == null ? (sx == null ? 1 : sx) : sy, sz == null ? (sx == null ? 1 : sx) : sz));
}
// primitives: an ellipsoid (r = [rx, ry, rz]), a box, a cone along +y, a cylinder along +y
function ell(P, x, y, z, r, hex, rx, ry, seg, rz){ seg = seg || (Math.max(r[0], r[1], r[2]) < 0.05 ? 7 : 11); P.add(new P.T.SphereGeometry(1, seg, Math.max(4, (seg*0.7) | 0)), M4(P.T, x, y, z, rx, ry, rz || 0, r[0], r[1], r[2]), hex); }
function bx(P, x, y, z, w, h, d, hex, rx, ry, rz){ P.add(new P.T.BoxGeometry(w, h, d), M4(P.T, x, y, z, rx, ry, rz), hex); }
function cone(P, x, y, z, r, h, hex, rx, ry, rz, seg){ P.add(new P.T.ConeGeometry(r, h, seg || 6), M4(P.T, x, y, z, rx, ry, rz), hex); }
function cyl(P, x, y, z, r0, r1, h, hex, rx, ry, rz, seg){ P.add(new P.T.CylinderGeometry(r1, r0, h, seg || 8), M4(P.T, x, y, z, rx, ry, rz), hex); }
function lerpHex(a, b, k){ var ar = a >> 16 & 255, ag = a >> 8 & 255, ab = a & 255, br = b >> 16 & 255, bg = b >> 8 & 255, bb = b & 255;
  return (Math.round(ar + (br - ar)*k) << 16) | (Math.round(ag + (bg - ag)*k) << 8) | Math.round(ab + (bb - ab)*k); }

// tails by kind: segments, length (x L), radius at the root and the tip (x W), pitch at the root and its curve per segment
var TAILS = {curl: [4, 0.42, 0.17, 0.12, 1.25, 0.6], plume: [4, 0.6, 0.12, 0.17, 0.45, -0.1], stub: [1, 0.1, 0.18, 0.16, 0.5, 0],
             thin: [5, 0.6, 0.11, 0.05, 0.25, -0.03], long: [6, 0.95, 0.14, 0.1, -0.35, 0.2], thick: [5, 0.85, 0.36, 0.08, -0.05, -0.02],
             spiked: [5, 0.8, 0.32, 0.08, 0.02, -0.02], dragon: [7, 1.1, 0.3, 0.05, -0.12, 0.05], fin: [0, 0, 0, 0, 0, 0]};
// The model: o = {species, variant, acc, stage, name}. Returns {g, P (trick pose), body, head, limbs, bits, wingMesh, glow,
// segs, legs, eyes, meshes (draw calls), tris, sp, dims, parts}. g is placed by the caller; its y rotation is the pet's yaw.
function model(T, o){
  o = o || {}; var sp = speciesOf(o.species) || SPECIES[0], pal = sp.pal[Math.max(0, Math.min(VARIANTS - 1, o.variant | 0))];
  var A = pal[0], B2 = pal[1], C = pal[2], EYE = pal[3], acc = accOk(sp, o.acc) ? o.acc | 0 : 0;
  var L = sp.L, H = sp.H, W = sp.W || 0.24, lh = sp.legH, hr = sp.head, sn = sp.snout || 0.08, kind = sp.kind;
  var g = new T.Group(), Pg = new T.Group(); g.add(Pg);
  var parts = {}, meshes = 0, tris = 0, mat = finMat(T, sp.fin || "matte");
  function mesh(name, P, parent, m){ if(!P.pos.length) return null; var me = new T.Mesh(P.geometry(), m || mat); me.name = "pet-" + name; parent.add(me); meshes++; tris += P.tris(); parts[name] = me; me.castShadow = name === "body"; return me; }
  function pivot(parent, x, y, z){ var p = new T.Group(); p.position.set(x, y, z); parent.add(p); return p; }
  var biped = sp.form === "biped", serp = sp.form === "serpent", dog = kind === "dog", cat = kind === "cat", scaly = kind === "dragon" || kind === "dino" || serp;
  var cy = lh + H/2;                                                      // the body's centre height
  var hipZ = biped ? -L*0.12 : -L*0.32, shZ = L*0.3;
  var dark = 0x1a1414, pink = 0xe8a0a0, ivory = 0xf4ecd8;
  var LI = [], BI = [];                                                   // instance colours: limbs, bits
  function li(hex){ LI.push(hex); return LI.length - 1; }
  function bi(hex){ BI.push(hex); return BI.length - 1; }
  // ---- body (pivot at the hip, so sitting tilts the front up); body space: the body's centre is (0, 0, oz) ----
  var body = pivot(Pg, 0, cy, hipZ), Pb = new Part(T), oz = -hipZ;
  var bp = biped ? 0.3 : 0;                                              // a biped leans forward
  if(serp){
    ell(Pb, 0, 0, oz + 0.05, [W*0.5, H*0.5, 0.2], A); ell(Pb, 0, -H*0.2, oz + 0.07, [W*0.4, H*0.3, 0.17], C);
  } else {
    // a deep chest, a waist and the hips, the belly underneath: one rounded torso
    ell(Pb, 0, H*0.04, oz + L*0.2, [W*0.52, H*0.56, L*0.33], A, -bp);
    ell(Pb, 0, 0, oz - L*0.02, [W*0.47, H*0.5, L*0.36], A, -bp);
    ell(Pb, 0, H*0.02, oz - L*0.24, [W*0.5, H*0.5, L*0.28], A, -bp);
    ell(Pb, 0, -H*0.17, oz + L*0.04, [W*0.4, H*0.36, L*0.4], C, -bp);
    if(dog && C !== A) ell(Pb, 0, -H*0.02, oz + L*0.37, [W*0.36, H*0.42, L*0.14], C, -bp);   // the chest blaze
    if(cat && sp.ears === "tuft") ell(Pb, 0, H*0.08, oz + L*0.4, [W*0.5, H*0.55, L*0.16], C, -bp);   // a Maine Coon's ruff
    if(sp.pat === "stripes") for(var si = -2; si <= 2; si++) ell(Pb, 0, H*0.14, oz + si*L*0.15, [W*0.49, H*0.42, L*0.035], B2, -bp, 0, 9);
    if(sp.pat === "spots") [[0.6, 0.2], [-0.5, -0.1], [0.2, -0.3], [-0.3, 0.3], [0.5, -0.25]].forEach(function(p){ ell(Pb, p[0]*W*0.38, H*0.33, oz + p[1]*L, [W*0.14, H*0.14, W*0.16], B2, 0, 0, 7); });
    if(sp.pat === "mask") ell(Pb, 0, H*0.15, oz - L*0.02, [W*0.47, H*0.42, L*0.46], B2 === 0xf4f6f8 || B2 === 0xffffff || B2 === 0xf8f0ea ? A : B2);
    if(sp.plates) for(var pi = 0; pi < 7; pi++){ var ph0 = 1 - Math.abs(pi - 3)/4; cone(Pb, (pi % 2 ? 0.03 : -0.03), H*0.5 + 0.02, oz + (pi - 3)*L*0.12, 0.09*ph0 + 0.03, 0.12 + 0.16*ph0, B2, 0, PI/4, pi % 2 ? -0.1 : 0.1, 4); }
    if(sp.spikes) for(var ki = 0; ki < 6; ki++) cone(Pb, 0, H*0.48 - Math.abs(ki - 2)*0.008, oz + (2.6 - ki)*L*0.14, 0.03, (0.07 + 0.02*(ki < 3 ? ki : 5 - ki))*sp.spikes, sp.frost ? 0xffffff : B2, -0.45, 0, 0, 4);
    if(sp.gems) for(var gi = 0; gi < 6; gi++) cone(Pb, (gi % 2 ? 1 : -1)*W*0.3, H*0.25, oz + (gi - 2.5)*L*0.13, 0.04, 0.1, gi % 2 ? B2 : C, 0, 0, (gi % 2 ? -1 : 1)*0.7, 3);
  }
  // ---- head (pivot at the top of the neck) ----
  var nk = sp.neck || (biped ? 0.12 : kind === "dragon" ? 0.2 : 0.08);
  var hy, hz, nb;
  if(serp){ hy = 0.05; hz = oz + 0.24; nb = null; }
  else { hy = H*0.35 + nk*0.85; hz = oz + L*0.48 + nk*0.45; nb = new T.Vector3(0, H*0.28, oz + L*0.36); }
  var head = pivot(body, 0, hy, hz), Ph = new Part(T), Pgl = sp.glowEyes ? new Part(T) : null;
  var cr = cat ? [hr*1.02, hr*0.88, hr*0.92] : dog ? [hr*0.9, hr*0.85, hr*0.95] : [hr*0.78, hr*0.7, hr*0.98];
  var hc = [0, hr*0.3, hr*0.05];
  ell(Ph, hc[0], hc[1], hc[2], cr, A);
  var snoutCol = cat || dog && sp.id !== "dachshund" ? C : A;
  if(sp.pat === "points"){ snoutCol = B2; ell(Ph, 0, hr*0.2, hr*0.45, [hr*0.6, hr*0.55, hr*0.55], B2); }
  var mz = hr*0.62 + sn*0.5;                                              // the muzzle's centre
  ell(Ph, 0, hr*0.1, mz, [hr*(cat ? 0.48 : scaly ? 0.5 : 0.52), hr*(scaly ? 0.36 : 0.4), sn*0.75 + 0.025], snoutCol);
  if(cat) [-1, 1].forEach(function(s){ ell(Ph, s*hr*0.2, hr*0.02, mz + sn*0.3, [hr*0.24, hr*0.2, hr*0.2], C); });   // whisker pads
  var noseZ = mz + sn*0.75 + 0.02;
  if(dog) ell(Ph, 0, hr*0.2, noseZ, [hr*0.2, hr*0.14, hr*0.13], dark);
  if(cat) ell(Ph, 0, hr*0.2, noseZ - 0.005, [hr*0.12, hr*0.08, hr*0.07], 0xd88a8a, 0.3);
  if(scaly){ [-1, 1].forEach(function(s){ ell(Ph, s*hr*0.17, hr*0.3, noseZ - 0.02, [hr*0.06, hr*0.045, hr*0.05], dark, 0, 0, 6); });
    ell(Ph, 0, -hr*0.01, mz + sn*0.1, [hr*0.4, hr*0.08, sn*0.7], 0x8a2a2a);                        // the mouth, seen when it opens
    if(kind !== "dino" || sp.id === "trex" || sp.id === "raptor") [-1, 1].forEach(function(s){ for(var ti = 0; ti < 3; ti++) cone(Ph, s*hr*0.32, 0, mz + sn*(0.5 - ti*0.35), 0.012, 0.04, 0xfaf6ea, PI, 0, 0, 4); }); }
  if(sp.pat === "mask") ell(Ph, 0, hr*0.05, hr*0.5, [hr*0.75, hr*0.55, hr*0.6], B2 === 0xf4f6f8 || B2 === 0xffffff || B2 === 0xf8f0ea ? B2 : C);
  // eyes: a white, an iris, a pupil (a slit for cats and the scaly ones), a highlight; glowing irises drawn unlit
  var eyes = [], er = hr*(cat ? 0.22 : dog ? 0.17 : 0.16), eyaw = cat ? 0.42 : dog ? 0.44 : 0.72, epit = scaly ? 0.28 : 0.2;
  [-1, 1].forEach(function(s){
    var ex = hc[0] + s*cr[0]*Math.sin(eyaw)*Math.cos(epit)*0.9, ey = hc[1] + cr[1]*Math.sin(epit)*0.9, ez = hc[2] + cr[2]*Math.cos(eyaw)*Math.cos(epit)*0.9;
    var nx = Math.sin(s*eyaw)*Math.cos(epit), ny = Math.sin(epit), nz = Math.cos(eyaw)*Math.cos(epit);
    function at(d){ return [ex + nx*er*d, ey + ny*er*d, ez + nz*er*d]; }
    var q;
    ell(Ph, ex, ey, ez, [er, er, er*0.6], dog ? 0x3a2a20 : 0xf6f2ea, -epit, s*eyaw, 9);
    q = at(0.38); ell(Pgl || Ph, q[0], q[1], q[2], [er*(dog ? 0.9 : 0.8), er*(dog ? 0.9 : 0.8), er*0.28], EYE, -epit, s*eyaw, 9);
    q = at(0.5); ell(Ph, q[0], q[1], q[2], cat || scaly ? [er*0.17, er*0.62, er*0.14] : [er*0.45, er*0.45, er*0.15], 0x080808, -epit, s*eyaw, 7);
    q = at(0.6); ell(Ph, q[0] - s*er*0.12, q[1] + er*0.3, q[2], [er*0.17, er*0.17, er*0.1], 0xffffff, -epit, s*eyaw, 5);
    if(scaly) ell(Ph, ex - s*er*0.1, ey + er*0.75, ez - er*0.1, [er*1.1, er*0.4, er*0.9], B2, -0.2, s*eyaw*0.8, 7);   // a brow ridge
    eyes.push({c: [ex, ey, ez], n: [nx, ny, nz], r: er, lid: li(scaly ? B2 : A)});
  });
  // ears, horns, frills, fins (pointed ears are "bits", floppy ears "limbs": both move)
  var ears = sp.ears, earsB = [], flop = [];
  if(ears === "point" || ears === "big" || ears === "tuft") [-1, 1].forEach(function(s){
    var big = ears === "big" ? 1.35 : ears === "tuft" ? 1.15 : 1;
    earsB.push({s: s, b: [s*hr*0.5, hr*0.85, -hr*0.02], len: hr*0.72*big, w: hr*0.62*big, i: bi(sp.pat === "points" ? B2 : A), j: bi(sp.pat === "points" ? lerpHex(B2, pink, 0.4) : pink)});
  });
  if(ears === "flop") [-1, 1].forEach(function(s){ flop.push({s: s, b: [s*hr*0.72, hr*0.68, -hr*0.02], len: hr*1.05, i: li(B2)}); });
  if(ears === "horn") [-1, 1].forEach(function(s){ var hcol = sp.frost ? 0xffffff : sp.fin === "gold" ? 0xfff0b0 : ivory;
    cone(Ph, s*hr*0.36, hr*0.78, -hr*0.42, hr*0.12, hr*0.55, hcol, -1.1, 0, -s*0.3, 6); cone(Ph, s*hr*0.44, hr*0.98, -hr*0.82, hr*0.07, hr*0.45, hcol, -1.75, 0, -s*0.3, 5); });
  if(ears === "frill"){ cyl(Ph, 0, hr*0.6, -hr*0.4, hr*1.45, hr*1.05, 0.04, B2, -1.15, 0, 0, 14);
    cone(Ph, 0, hr*0.42, mz + sn*0.4, hr*0.11, hr*0.42, ivory, 1.2, 0, 0, 6);
    [-1, 1].forEach(function(s){ cone(Ph, s*hr*0.4, hr*0.95, hr*0.4, hr*0.11, hr*0.85, ivory, 1.0, 0, -s*0.15, 6); }); }
  if(ears === "fin") [-1, 1].forEach(function(s){ cone(Ph, s*hr*0.75, hr*0.45, -hr*0.15, hr*0.3, hr*0.8, B2, -0.9, 0, -s*0.9, 4); });
  if(sp.crest === 1) for(var ci = 0; ci < 3; ci++) cone(Ph, 0, hr*0.9, hr*(0.35 - ci*0.32), 0.02, 0.08 - ci*0.015, EYE, -0.5, 0, 0, 4);
  if(sp.crest === 2){ cyl(Ph, 0, hr*0.98, -hr*0.15, hr*0.5, hr*0.55, hr*0.22, 0xfff0a0, 0, 0, 0, 10); [-2, -1, 0, 1, 2].forEach(function(k){ cone(Ph, k*hr*0.2, hr*1.25, -hr*0.15, 0.025, 0.11 - Math.abs(k)*0.015, EYE, 0, 0, -k*0.12, 4); }); }
  // accessories on the head: hat, bow
  if(acc & ACC.hat){ cone(Ph, hr*0.1, hr*1.55, -hr*0.05, hr*0.42, hr*0.9, 0x6a3ad8, 0, 0, -0.2, 10); cyl(Ph, hr*0.04, hr*1.12, -hr*0.05, hr*0.55, hr*0.55, 0.012, 0x6a3ad8, 0, 0, -0.2, 12); ell(Ph, hr*0.27, hr*2.0, -hr*0.05, [0.03, 0.03, 0.03], 0xfff0a0); }
  if(acc & ACC.bow) [-1, 1].forEach(function(s){ cone(Ph, s*hr*0.2 - hr*0.38, hr*0.98, hr*0.05, hr*0.16, hr*0.32, 0xf05aa0, 0, 0, s*PI/2, 5); });
  mesh("head", Ph, head); if(Pgl) mesh("glow", Pgl, head, glowMat(T));
  // lower jaw, a dog's tongue
  var jaw = {h: [0, hr*0.02, hr*0.2], tip: [0, -hr*0.12, mz + sn*0.6], w: hr*(cat ? 0.32 : 0.36), th: hr*0.14, i: li(scaly ? C : snoutCol)};
  var tongue = dog ? li(0xe8707a) : -1;
  // accessories on the body: collar, bandana, saddle; the neck runs from nb to the head's pivot
  var nr = serp ? 0 : Math.max(W*0.26, hr*0.55);
  if(!serp){
    var ndy = hy - nb.y, ndz = hz - nb.z, nl = Math.hypot(ndy, ndz), na = -Math.atan2(ndy, ndz);
    var cx = nb.y + ndy*0.18, cz = nb.z + ndz*0.18;
    if(acc & ACC.collar){ Pb.add(new T.TorusGeometry(nr*0.97, 0.016, 5, 14), M4(T, 0, cx, cz, na, 0, 0), 0xd8342a); ell(Pb, 0, cx - nr*1.02*Math.cos(na) - 0.015, cz - nr*Math.sin(na)*0.3 + 0.01, [0.022, 0.026, 0.012], 0xf0c030); }
    if(acc & ACC.bandana) cone(Pb, 0, cx - nr*0.75, cz + nr*0.55, nr*1.0, nr*1.5, 0x3a6ad8, PI*0.88, 0, 0, 3);
    if(acc & ACC.saddle){ ell(Pb, 0, H*0.5, oz - L*0.03, [W*0.56, 0.035, L*0.2], 0x7a3a1a); ell(Pb, 0, H*0.55, oz - L*0.17, [W*0.36, 0.05, 0.04], 0x5a2a10); bx(Pb, 0, 0, oz - L*0.03, W*1.08, H*0.9, 0.035, 0x5a2a10); }
  }
  // ---- legs: a jointed upper and lower leg and a paw each, posed by a two-bone IK every frame ----
  var legs = [];
  if(!serp){
    var lr = Math.max(0.022, W*(biped ? 0.15 : 0.12))*(sp.size > 1.1 ? 1.2 : 1), lx = W*(biped ? 0.3 : 0.32);
    var sock = sp.pat === "points" ? B2 : sp.id === "shiba" || sp.id === "corgi" || sp.id === "husky" ? C : A;
    function leg(x, z, front){
      var ay = -H*(biped ? 0.18 : 0.22), tot = (cy + ay) - lr*0.75;           // hip to ankle, standing
      legs.push({att: new T.Vector3(x, ay, z), front: front, l1: tot*0.54, l2: tot*0.54, r: lr*(front ? 0.95 : 1.05), tot: tot, side: x > 0 ? 1 : -1,
                 i: li(A), j: li(lerpHex(A, sock, 0.5)), k: li(sock)});
    }
    if(biped){ leg(lx, 0, false); leg(-lx, 0, false); }
    else { leg(lx, shZ - hipZ, true); leg(-lx, shZ - hipZ, true); leg(lx, 0, false); leg(-lx, 0, false); }
  }
  var arms = biped && sp.arms ? [li(A), li(A), li(A), li(A)] : null;
  // ---- the tail: a chain of segments (a sea serpent's fin rides its coils' end) ----
  var TD = TAILS[sp.tail] || TAILS.thin, tail = null;
  if(!serp){
    var tlen = L*TD[1]*(sp.id === "raptor" ? 1.4 : kind === "cat" ? 1.05 : sp.id === "brachio" ? 1.2 : 1);
    tail = {n: TD[0], len: tlen, r0: W*TD[2], r1: W*TD[3], p0: TD[4], dp: TD[5], b: new T.Vector3(0, H*0.14, oz - L*0.44), i: []};
    if(sp.id === "dachshund") tail.p0 = 0.6;
    if(kind === "cat"){ tail.r0 = Math.max(0.028, W*0.15); tail.r1 = tail.r0*0.8; }
    for(var ti2 = 0; ti2 < tail.n; ti2++){ var tk = ti2/Math.max(1, tail.n - 1);
      tail.i.push(li(sp.pat === "points" ? B2 : sp.id === "husky" && ti2 === tail.n - 1 ? C : sp.pat === "stripes" && ti2 % 2 ? B2 : tk > 0.7 && sp.tail === "plume" ? lerpHex(A, C, 0.5) : A)); }
    tail.tip = sp.tail === "dragon" ? bi(sp.frost ? 0xffffff : B2) : -1;
    tail.spikes = sp.tail === "spiked" ? [bi(ivory), bi(ivory), bi(ivory), bi(ivory)] : null;
    tail.spines = sp.tail === "dragon" && sp.spikes ? [bi(sp.frost ? 0xffffff : B2), bi(sp.frost ? 0xffffff : B2), bi(sp.frost ? 0xffffff : B2)] : null;
  }
  var neck = null;
  if(!serp){
    var nn = sp.neck ? 5 : kind === "dragon" ? 4 : 2;
    neck = {n: nn, r0: nr, r1: Math.max(hr*0.5, nr*(sp.neck ? 0.45 : 0.8)), i: []};
    for(var ni = 0; ni < nn; ni++) neck.i.push(li(A));
  }
  var fin = serp ? bi(B2) : -1;
  // the instanced parts: one mesh each, coloured per instance
  function inst(name, geo, cols){
    if(!cols.length) return null;
    var im = new T.InstancedMesh(geo, finMat(T, sp.fin || "matte", false, true), cols.length), c3 = new T.Color(), m0 = new T.Matrix4().makeScale(0, 0, 0);
    for(var i = 0; i < cols.length; i++){ im.setColorAt(i, c3.setHex(cols[i])); im.setMatrixAt(i, m0); }
    im.name = "pet-" + name; im.frustumCulled = false; im.castShadow = name === "limbs"; Pg.add(im); meshes++; tris += cols.length*(geo.index ? geo.index.count : geo.attributes.position.count)/3; parts[name] = im;
    return im;
  }
  var limbs = inst("limbs", limbGeo(T), LI), bits = inst("bits", bitGeo(T), BI);
  // ---- wings: one double-sided mesh, rebuilt each frame from the arm and four finger spars ----
  var wingMesh = null, wing = null;
  if(sp.fly){
    var span = L*1.2, wc = sp.fin === "shadow" ? 0x2a1a3a : B2;
    var tipC = sp.frost ? 0xffffff : sp.fin === "gold" ? 0xfff2b8 : sp.fin === "crystal" ? 0xffffff : lerpHex(wc, C, 0.3);
    var bone = lerpHex(A, 0x000000, 0.2);
    wing = wingSetup(T, span, wc, tipC, bone, {S: [W*0.36, H*0.36, oz + L*0.18], R: [W*0.3, H*0.12, oz - L*0.34]});
    wingMesh = new T.Mesh(wing.geo, finMat(T, sp.fin || "matte", true)); wingMesh.name = "pet-wings"; wingMesh.frustumCulled = false; body.add(wingMesh);
    meshes++; tris += wing.tris; parts.wings = wingMesh;
    wingPose(wing, 0, 0.3, 0, 0);
  }
  mesh("body", Pb, body);
  // ---- a sea serpent's coils: one InstancedMesh of segments, posed each frame along a wave ----
  var segs = null;
  if(serp){
    var Ps = new Part(T); ell(Ps, 0, 0, 0, [W*0.5, H*0.5, 0.12], A, 0, 0, 9); cone(Ps, 0, H*0.42, 0, 0.04, 0.09, B2, -0.3, 0, 0, 4); ell(Ps, 0, -H*0.2, 0.01, [W*0.4, H*0.28, 0.1], C, 0, 0, 7);
    segs = new T.InstancedMesh(Ps.geometry(), mat, 10); segs.name = "pet-segs"; segs.frustumCulled = false; Pg.add(segs); meshes++; tris += Ps.tris()*10; parts.segs = segs;
  }
  var stage = sp.grows ? Math.max(0, Math.min(2, o.stage | 0)) : 0, scale = (sp.size || 1)*(sp.grows ? [0.7, 1, 1.35][stage] : 1);
  Pg.scale.setScalar(scale);
  var seedF = (hashStr(sp.id + ":" + (o.variant | 0) + ":" + (o.name || "")) % 1000)/1000*TAU;
  var tv = []; for(var vi = 0; vi < 12; vi++) tv.push(new T.Vector3());
  return {g: g, P: Pg, body: body, head: head, limbs: limbs, bits: bits, wingMesh: wingMesh, wing: wing, glow: parts.glow || null, segs: segs,
          legs: legs, arms: arms, tail: tail, neck: neck, nb: nb, eyes: eyes, earsB: earsB, flop: flop, jaw: jaw, tongue: tongue, fin: fin, hp0: head.position.clone(),
          meshes: meshes, tris: Math.round(tris), sp: sp, scale: scale, biped: biped, seedF: seedF, tv: tv, Mh: new T.Matrix4(), q: new T.Quaternion(), mm: new T.Matrix4(),
          sm: {look: 0, jaw: 0, turn: 0, lastT: null, lastYaw: null},
          dims: {L: L, H: H, W: W, lh: lh, cy: cy, oz: oz, hipZ: hipZ, hr: hr}, parts: parts};
}

/* ---------- wings ---------- */
// Points: S shoulder, E elbow, X wrist, F0..F3 finger tips, M0..M3 the membrane's trailing edge between them (sagging),
// R where the membrane meets the flank. Angles are in the wing's plane, from "outward" toward "forward".
var WING_OPEN = [0.35, -0.12, -0.3, -0.8, -1.3, -1.8], WING_FOLD = [-1.2, 1.45, -1.42, -1.5, -1.58, -1.66];
var WING_LEN = [0.28, 0.36, 0.62, 0.66, 0.55, 0.42];
var WING_TRI = [["S", "E", "X"], ["X", "F0", "M0"], ["X", "M0", "F1"], ["X", "F1", "M1"], ["X", "M1", "F2"], ["X", "F2", "M2"], ["X", "M2", "F3"],
                ["X", "F3", "M3"], ["X", "M3", "R"], ["S", "X", "R"]];
var WING_BONE = [["S", "E", 1], ["E", "X", 0.9], ["X", "F0", 0.55], ["X", "F1", 0.5], ["X", "F2", 0.45], ["X", "F3", 0.4]];
var WING_TINT = {S: 0, E: 0.2, X: 0.35, F0: 1, F1: 1, F2: 1, F3: 1, M0: 0.75, M1: 0.75, M2: 0.7, M3: 0.55, R: 0.05};
function wingSetup(T, span, wc, tipC, bone, at){
  var nTri = (WING_TRI.length + WING_BONE.length*2 + 1)*2, pos = new Float32Array(nTri*9), col = new Float32Array(nTri*9);
  var cA = new T.Color(wc), cT = new T.Color(tipC), cB = new T.Color(bone), cC = new T.Color(0xf4ecd8), c = new T.Color(), o = 0;
  [-1, 1].forEach(function(){
    WING_TRI.forEach(function(t){ t.forEach(function(p){ c.copy(cA).lerp(cT, Math.pow(WING_TINT[p], 1.4)); col[o++] = c.r; col[o++] = c.g; col[o++] = c.b; }); });
    for(var b = 0; b < WING_BONE.length*2 + 1; b++) for(var v = 0; v < 3; v++){ c.copy(b === WING_BONE.length*2 ? cC : cB); col[o++] = c.r; col[o++] = c.g; col[o++] = c.b; }
  });
  var geo = new T.BufferGeometry();
  geo.setAttribute("position", new T.BufferAttribute(pos, 3)); geo.setAttribute("color", new T.BufferAttribute(col, 3)); geo.setAttribute("normal", new T.BufferAttribute(new Float32Array(nTri*9), 3));
  return {geo: geo, span: span, S: at.S, R: at.R, tris: nTri, P: {}, open: 0};
}
// spread k (0 folded .. 1 open), flap: the arm's lift (+ up), sag: the membrane's billow, curl: the upstroke's folding fingers
function wingPose(w, k, flap, sag, curl){
  var pos = w.geo.attributes.position.array, span = w.span, o = 0, P = w.P;
  k = Math.max(0, Math.min(1, k)); w.open = k;
  [-1, 1].forEach(function(s){
    var roll = 1.3*(1 - k) + flap, cu = Math.cos(roll), su = Math.sin(roll);
    var S = w.S, Ux = s*cu, Uy = su, Nx = -s*su, Ny = cu;
    function pt(u, v, n){ return [s*S[0] + Ux*u + Nx*(n || 0), S[1] + Uy*u + Ny*(n || 0), S[2] + v]; }
    function ang(i){ var a = WING_FOLD[i] + (WING_OPEN[i] - WING_FOLD[i])*k; if(i >= 2) a -= curl*(0.25 + (i - 2)*0.12); return a; }
    var a0 = ang(0), a1 = ang(1), l = WING_LEN, ex = Math.cos(a0)*l[0]*span, ev = Math.sin(a0)*l[0]*span;
    var xx = ex + Math.cos(a1)*l[1]*span, xv = ev + Math.sin(a1)*l[1]*span;
    P.S = pt(0, 0); P.E = pt(ex, ev); P.X = pt(xx, xv);
    var F = [];
    for(var i = 0; i < 4; i++){ var a = ang(i + 2); F.push([xx + Math.cos(a)*l[i + 2]*span, xv + Math.sin(a)*l[i + 2]*span]); P["F" + i] = pt(F[i][0], F[i][1]); }
    var Rl = [(Math.abs(w.R[0]) - S[0])*0.2, w.R[2] - S[2]];
    P.R = [s*w.R[0], w.R[1], w.R[2]];
    for(var m = 0; m < 4; m++){
      var a2 = F[m], b2 = m < 3 ? F[m + 1] : Rl, mu = (a2[0] + b2[0])/2, mv = (a2[1] + b2[1])/2, pull = 0.12 + 0.14*k;
      P["M" + m] = pt(mu + (xx - mu)*pull, mv + (xv - mv)*pull, sag*span*(m < 3 ? 1 : 0.6));
    }
    WING_TRI.forEach(function(t){ t.forEach(function(p){ var q = P[p]; pos[o++] = q[0]; pos[o++] = q[1]; pos[o++] = q[2]; }); });
    // the spars: thin strips just proud of the membrane on both sides
    WING_BONE.forEach(function(b){
      var p = P[b[0]], q = P[b[1]], dx = q[0] - p[0], dy = q[1] - p[1], dz = q[2] - p[2];
      var cx = dy*0 - dz*Ny, cy2 = dz*Nx - dx*0, cz = dx*Ny - dy*Nx, cl = Math.hypot(cx, cy2, cz) || 1, wd = span*0.016*b[2];
      cx *= wd/cl; cy2 *= wd/cl; cz *= wd/cl;
      [1, -1].forEach(function(f){
        var ox = Nx*0.006*f, oy = Ny*0.006*f;
        var v = [p[0] - cx + ox, p[1] - cy2 + oy, p[2] - cz, q[0] - cx*0.3 + ox, q[1] - cy2*0.3 + oy, q[2] - cz*0.3, p[0] + cx + ox, p[1] + cy2 + oy, p[2] + cz];
        if(f < 0) v = [v[0], v[1], v[2], v[6], v[7], v[8], v[3], v[4], v[5]];
        for(var j = 0; j < 9; j++) pos[o++] = v[j];
      });
    });
    // the wrist's claw
    var X = P.X, cl2 = span*0.06;
    var cv = [X[0], X[1], X[2], X[0] + s*cl2*0.2, X[1] + cl2*0.3, X[2] + cl2, X[0] - s*cl2*0.2, X[1] + cl2*0.1, X[2] + cl2*0.6];
    for(var j2 = 0; j2 < 9; j2++) pos[o++] = cv[j2];
  });
  w.geo.attributes.position.needsUpdate = true; w.geo.computeVertexNormals();
}
// the flap cycle: a quick downstroke (40% of the beat), a slower upstroke with the fingers folding in; returns {flap, sag, curl}
function flapAt(f){
  f = f - Math.floor(f);
  var up = 0.95, dn = -0.6;
  if(f < 0.4){ var k = (1 - Math.cos(f/0.4*PI))/2; return {flap: up + (dn - up)*k, sag: 0.05, curl: 0, down: 1}; }
  var k2 = (1 - Math.cos((f - 0.4)/0.6*PI))/2; return {flap: dn + (up - dn)*k2, sag: -0.04, curl: Math.sin(k2*PI)*0.9, down: 0};
}

/* ---------- posing ---------- */
// a capsule (or cone) instance from A to B (Vector3s in the pet's space), radius rx (rz: its depth, for flat ones)
var UP = null, TQ = null, TM = null, TS = null, TE = null;
function segAt(IM, i, A, B, rx, rz, ext){
  if(!IM || i < 0) return;
  var dx = B.x - A.x, dy = B.y - A.y, dz = B.z - A.z, len = Math.sqrt(dx*dx + dy*dy + dz*dz);
  if(len < 1e-5 || !(rx > 0)){ TM.makeScale(0, 0, 0); IM.setMatrixAt(i, TM); return; }
  dx /= len; dy /= len; dz /= len; ext = ext || 0;
  TE.set(dx, dy, dz); TQ.setFromUnitVectors(UP, TE); TS.set(rx*2, len + ext*2, (rz != null ? rz : rx)*2);
  TE.set(A.x - dx*ext, A.y - dy*ext, A.z - dz*ext); TM.compose(TE, TQ, TS); IM.setMatrixAt(i, TM);
}
function hideAt(IM, i){ if(!IM || i < 0) return; TM.makeScale(0, 0, 0); IM.setMatrixAt(i, TM); }
// two-bone IK: the knee K for a hip H and a foot F (moved within reach), bending toward `bend`
function ik(H, F, l1, l2, bx2, by, bz, K){
  var dx = F.x - H.x, dy = F.y - H.y, dz = F.z - H.z, d = Math.sqrt(dx*dx + dy*dy + dz*dz) || 1e-4, ux = dx/d, uy = dy/d, uz = dz/d;
  var dm = Math.max(Math.abs(l1 - l2) + 1e-3, Math.min(d, (l1 + l2)*0.999));
  if(dm !== d){ F.set(H.x + ux*dm, H.y + uy*dm, H.z + uz*dm); d = dm; }
  var a = (l1*l1 - l2*l2 + d*d)/(2*d), h = Math.sqrt(Math.max(0, l1*l1 - a*a));
  var bd = bx2*ux + by*uy + bz*uz, px = bx2 - ux*bd, py = by - uy*bd, pz = bz - uz*bd, pl = Math.sqrt(px*px + py*py + pz*pz);
  if(pl < 1e-4){ px = 0; py = -uz; pz = uy; pl = Math.sqrt(py*py + pz*pz) || 1; }
  K.set(H.x + ux*a + px/pl*h, H.y + uy*a + py/pl*h, H.z + uz*a + pz/pl*h);
}
function footCycle(c, duty, stride, lift, out){
  c = c - Math.floor(c);
  if(c < duty){ out.dz = stride*(0.5 - c/duty); out.dy = 0; return out; }
  var s = (c - duty)/(1 - duty); out.dz = stride*(-0.5 + (1 - Math.cos(s*PI))/2); out.dy = Math.sin(s*PI)*lift; return out;
}
// leg phases (front L, front R, hind L, hind R; bipeds L, R) and duty factors by gait
var GAITS = {walk: [[0.25, 0.75, 0, 0.5], 0.64], trot: [[0, 0.5, 0.5, 0], 0.5], gallop: [[0, 0.12, 0.55, 0.65], 0.38], bi: [[0, 0.5], 0.55]};
var FC = {dz: 0, dy: 0};
// Pose a model from its state (anim, ph) at time t; calm: no bounces, no flips, gentle only. look: a point it turns its
// head toward (you, or the ball), {x, z} in the world, or null.
function pose(Mo, st, t, calm, look){
  if(!Mo) return;
  var T3 = Mo.g, a = st.anim || "stand", ph = st.ph || 0, d = Mo.dims, sp = Mo.sp, kind = sp.kind, k = calm ? 0.35 : 1, S = Mo.sm, v = Mo.tv;
  if(!UP){ UP = new v[0].constructor(0, 1, 0); TE = new v[0].constructor(); TS = new v[0].constructor(); TQ = Mo.q.clone(); TM = Mo.mm.clone(); }
  var dt = S.lastT == null ? 0 : Math.max(0, Math.min(0.1, t - S.lastT)); S.lastT = t;
  var body = Mo.body, head = Mo.head, P = Mo.P, hr = d.hr, IM = Mo.limbs, BM = Mo.bits;
  body.rotation.set(0, 0, 0); body.position.set(0, d.cy, d.hipZ); head.rotation.set(0, 0, 0); head.position.copy(Mo.hp0); head.scale.set(1, 1, 1);
  P.position.set(0, 0, 0); P.rotation.set(0, 0, 0);
  // turning (the tail swings out behind a turn)
  if(S.lastYaw != null && dt > 0){ var tr = wrapPi(st.yaw - S.lastYaw)/dt; S.turn += (Math.max(-4, Math.min(4, tr)) - S.turn)*Math.min(1, dt*4); }
  S.lastYaw = st.yaw;
  var walk = a === "walk" || a === "run" || a === "carry" || a === "slither", fly = a === "fly";
  var gait = walk ? (Mo.biped ? "bi" : a === "run" || st.speed > 4 ? "gallop" : st.speed > 2.2 ? "trot" : "walk") : null;
  var c = ph*0.5, legT = Mo.legs.length ? Mo.legs[0].tot : d.H, sitting = a === "sit" || a === "look" || a === "beg" || (a === "coil" && kind !== "serpent");
  // breathing: slow and deep asleep, quick after a run
  var brF = a === "sleep" ? 1.3 : a === "run" ? 7 : 2.4, br = Math.sin(t*brF + Mo.seedF)*(a === "sleep" ? 0.035 : 0.016);
  body.scale.set(1 + br*0.7, 1 + br, 1);
  if(walk && !fly){
    var bob = Math.cos(c*TAU*2);
    body.position.y += bob*legT*(gait === "gallop" ? 0.09 : 0.035)*k;
    if(gait === "gallop") body.rotation.x = Math.sin(c*TAU)*0.1*k; else body.rotation.z = Math.sin(c*TAU)*0.035*k;
    head.rotation.x = -bob*0.04*k;
  }
  if(sitting){ body.rotation.x = -(a === "beg" ? 0.95 : 0.5); body.position.y = d.cy - legT*(a === "beg" ? 0.28 : 0.32); head.rotation.x = a === "look" ? 0.05 : 0.4; if(a === "beg") P.position.y = Math.abs(Math.sin(t*5))*0.02*k; }
  if(a === "sleep"){ body.position.y = d.H*0.47; head.rotation.x = 0.55; head.rotation.y = 0.7; }
  if(a === "sniff"){ head.rotation.x = 0.6 + Math.sin(t*11)*0.05*k; head.rotation.y = Math.sin(t*1.7)*0.35; body.rotation.x = 0.1; }
  if(a === "groom"){ head.rotation.y = 1.1; head.rotation.x = 0.5 + Math.sin(t*9)*0.08*k; body.rotation.x = -0.35; body.position.y = d.cy - legT*0.3; }
  if(a === "yawn"){ head.rotation.x = -0.4; }
  if(a === "shake"){ body.rotation.z = Math.sin(t*28)*0.22*k; head.rotation.z = -Math.sin(t*28)*0.25*k; }
  if(a === "stretch"){ body.rotation.x = 0.32; body.position.y = d.cy - legT*0.25; head.rotation.x = -0.45; }
  if(a === "stomp"){ var sb = Math.abs(Math.sin(t*7)); P.position.y = sb*0.05*k; body.rotation.z = Math.sin(t*7)*0.1*k; }
  if(a === "roar" || a === "breath" || a === "puff" || a === "crackle"){ head.rotation.x = -0.35 + Math.sin(t*20)*0.03*k; body.rotation.x = -0.1; }
  if(a === "wag" && kind !== "cat") body.rotation.y = Math.sin(t*14)*0.05*k;
  if(a === "spin") P.rotation.y = (st.trick ? st.trick.t/st.trick.dur : 0)*TAU*(calm ? 0 : 1);
  if(a === "roll"){ var rt = st.trick ? st.trick.t/st.trick.dur : 0; body.rotation.z = calm ? 0 : rt*TAU; body.position.y = d.cy - legT*0.6; }
  if(a === "big"){ var bt = st.trick ? st.trick.t/st.trick.dur : 0;
    if(kind === "dino"){ head.rotation.x = -0.7; body.rotation.x = -0.3; P.position.y = calm ? 0 : Math.max(0, Math.sin(bt*PI*3))*0.05; }
    else if(!calm){ P.position.y = Math.sin(bt*PI)*(kind === "dragon" ? 1.6 : 0.6); P.rotation.x = -bt*TAU; } }
  // flight: level, the head and the neck stretched out, the body lifted on each downstroke
  var FL = null;
  if(Mo.wing){
    if(fly){
      var glide = !calm && Math.sin(t*0.45 + Mo.seedF) > 0.6;
      FL = calm || glide ? {flap: 0.12 + Math.sin(t*1.3)*0.03, sag: 0.03, curl: 0, down: 0} : flapAt(t*(Mo.scale < 0.8 ? 2.1 : 1.6) + Mo.seedF);
      body.rotation.x = 0.06 - FL.flap*0.05; body.position.y += -FL.flap*0.035*k; head.position.y -= 0.03; head.position.z += 0.04; head.rotation.x = 0.15;
      wingPose(Mo.wing, 1, FL.flap, FL.sag, FL.curl);
    } else if(a === "wings"){ var wk = 0.55 + 0.45*Math.sin(t*2.2); wingPose(Mo.wing, wk*k + (1 - k)*0.4, 0.3 + Math.sin(t*4)*0.25*k, -0.02, 0); }
    else if(a === "big" && !calm){ FL = flapAt(t*2); wingPose(Mo.wing, 1, FL.flap, FL.sag, FL.curl); }
    else wingPose(Mo.wing, 0.02 + br*0.4, 0.05, 0, 0);
  }
  // the head turns toward you (or the ball) when it isn't busy
  var lookW = 0;
  if(look && !walk && !fly && a !== "sleep" && a !== "sniff" && a !== "groom" && a !== "roll" && a !== "spin" && a !== "big" && a !== "shake"){
    var lx = look.x - T3.position.x, lz = look.z - T3.position.z;
    if(lx*lx + lz*lz < 144) lookW = Math.max(-1, Math.min(1, wrapPi(Math.atan2(lx, lz) - st.yaw)));
  }
  S.look += (lookW - S.look)*Math.min(1, dt*4); head.rotation.y += S.look*0.85;
  body.updateMatrix(); head.updateMatrix(); var Mh = Mo.Mh.multiplyMatrices(body.matrix, head.matrix), Bm = body.matrix;
  // ---- legs ----
  var G = gait ? GAITS[gait] : null, bodyRel = a === "roll" || a === "big" || a === "shake";
  Mo.legs.forEach(function(Lg, li2){
    var Hp = v[0].copy(Lg.att).applyMatrix4(Bm), F = v[1], K = v[2], pawH = Lg.r*0.75, rx = Lg.att.x*1.04, rz = Lg.att.z + d.hipZ;
    if(fly) F.set(Hp.x, Hp.y - Lg.tot*0.35, Hp.z - Lg.tot*0.8);
    else if(bodyRel) F.set(0, -Lg.tot*0.95, 0).applyMatrix4(Bm).sub(v[3].set(0, 0, 0).applyMatrix4(Bm)).add(Hp);
    else if(G){ footCycle(c + G[0][li2], G[1], legT*(gait === "gallop" ? 1.0 : gait === "trot" ? 0.7 : 0.55)*(calm ? 0.8 : 1), legT*(gait === "gallop" ? 0.28 : 0.18), FC);
      F.set(rx, pawH + FC.dy, rz + FC.dz); }
    else if(sitting){ if(Lg.front && a === "beg") F.set(Hp.x, Hp.y - Lg.tot*0.35, Hp.z + Lg.tot*0.3); else if(Lg.front) F.set(rx, pawH, Hp.z + Lg.tot*0.08); else F.set(rx*1.1, pawH, rz + Lg.tot*0.5); }
    else if(a === "sleep"){ if(Lg.front) F.set(rx*0.8, pawH*0.9, Hp.z + Lg.tot*0.75); else F.set(rx*1.6, pawH*0.9, rz + Lg.tot*0.45); }
    else if(a === "stretch" && Lg.front) F.set(rx, pawH, Hp.z + Lg.tot*0.65);
    else if(a === "groom" && Lg.front && Lg.side > 0) F.set(Hp.x - 0.02, Hp.y - Lg.tot*0.25, Hp.z + Lg.tot*0.45);
    else F.set(rx, pawH, rz);
    var bz = Lg.front ? 1 : -1;
    ik(Hp, F, Lg.l1, Lg.l2, 0, 0.15, bz, K);
    segAt(IM, Lg.i, Hp, K, Lg.r, null, Lg.r*0.4); segAt(IM, Lg.j, K, F, Lg.r*0.8, null, Lg.r*0.3);
    v[4].set(F.x, F.y - pawH*0.25, F.z - Lg.r*0.6); v[5].set(F.x, F.y - pawH*0.25, F.z + Lg.r*(Mo.biped ? 2.4 : 1.6));
    segAt(IM, Lg.k, v[4], v[5], Lg.r*(Mo.biped ? 1.3 : 1.15), Lg.r*0.7);
  });
  if(Mo.arms){ var ar = Mo.arms;
    [-1, 1].forEach(function(s, ai){ var sw = walk ? Math.sin(c*TAU + ai*PI)*0.25*k : Math.sin(t*1.5 + ai)*0.05;
      var A0 = v[0].set(s*d.W*0.3, -d.H*0.05, d.oz + d.L*0.36).applyMatrix4(Bm), E0 = v[1].set(s*d.W*0.36, -d.H*0.3, d.oz + d.L*0.42 + sw*0.05).applyMatrix4(Bm), H0 = v[2].set(s*d.W*0.33, -d.H*0.32, d.oz + d.L*0.55 + sw*0.04).applyMatrix4(Bm);
      segAt(IM, ar[ai*2], A0, E0, 0.024, null, 0.01); segAt(IM, ar[ai*2 + 1], E0, H0, 0.018, null, 0.008); }); }
  // ---- neck: a curve from the chest to the head (an S for dragons, an arch for the long-necked) ----
  if(Mo.neck){
    var N = Mo.neck, nb = Mo.nb, hp = head.position, dn = Math.hypot(hp.y - nb.y, hp.z - nb.z), dr = kind === "dragon";
    var c1y = nb.y + dn*(dr ? 0.55 : 0.45), c1z = nb.z + dn*(dr ? -0.05 : 0.2), c2y = hp.y - dn*(dr ? 0.05 : 0.15), c2z = hp.z - dn*(dr ? 0.45 : 0.25);
    var prev = v[0].set(0, nb.y, nb.z).applyMatrix4(Bm);
    for(var ni = 1; ni <= N.n; ni++){
      var u = ni/N.n, iu = 1 - u, by = iu*iu*iu*nb.y + 3*iu*iu*u*c1y + 3*iu*u*u*c2y + u*u*u*hp.y, bz2 = iu*iu*iu*nb.z + 3*iu*iu*u*c1z + 3*iu*u*u*c2z + u*u*u*hp.z;
      var hx = hp.x*u, cur = v[1].set(hx, by, bz2).applyMatrix4(Bm), r = N.r0 + (N.r1 - N.r0)*u;
      segAt(IM, N.i[ni - 1], prev, cur, r, null, r*0.5); prev.copy(cur);
    }
  }
  // ---- tail: its segments one after another, wagging (the tip most), swinging out behind a turn ----
  if(Mo.tail){
    var Tl = Mo.tail, n = Tl.n, sl = Tl.len/Math.max(1, n), p0 = Tl.p0, dp = Tl.dp, wagA, wagF;
    wagA = a === "wag" || a === "greet" ? 0.55 : walk ? 0.18 : 0.08; wagF = a === "wag" ? 15 : 4;
    if(kind === "cat"){ wagA *= 0.5; wagF *= 0.4; if(walk){ p0 = 1.0; dp = 0.12; } }
    if(kind === "dog" && (a === "wag" || walk)) p0 += 0.3;
    var curl = 0;
    if(sitting && kind === "cat"){ p0 = -1.2; dp = 0.2; curl = 0.42; }
    if(a === "sleep"){ p0 = Math.min(p0, -0.3); dp = 0.05; curl = 0.5; wagA = 0.02; }
    if(fly){ p0 = -0.08; dp = 0; }
    var pt = v[0].copy(Tl.b).applyMatrix4(Bm), pitch = p0, yaw = 0, dir = v[1], nx2 = v[2];
    for(var i = 0; i < n; i++){
      var f = i/Math.max(1, n - 1);
      yaw += curl + Math.sin(t*wagF - i*0.6)*wagA*(0.35 + 0.65*f)*k/Math.max(1, n*0.5) - S.turn*0.05*(0.3 + f) + (fly ? Math.sin(t*3 - i*0.7)*0.06*k : 0);
      if(i) pitch += dp;
      dir.set(Math.sin(yaw)*Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw)*Math.cos(pitch)).transformDirection(Bm);
      nx2.copy(pt).addScaledVector(dir, sl);
      var r2 = Tl.r0 + (Tl.r1 - Tl.r0)*f;
      segAt(IM, Tl.i[i], pt, nx2, r2, null, r2*0.6);
      if(Tl.spines && i < 3){ v[3].copy(pt).addScaledVector(dir, sl*0.5); v[3].y += r2*0.7; v[4].copy(v[3]).addScaledVector(dir, sl*0.35); v[4].y += 0.06 - i*0.012; segAt(BM, Tl.spines[i], v[3], v[4], 0.022, 0.012); }
      if(Tl.spikes && i >= n - 2){ [-1, 1].forEach(function(s, si2){ var j = Tl.spikes[(i - (n - 2))*2 + si2]; v[3].copy(pt).addScaledVector(dir, sl*0.5); v[5].set(s*0.8, 0.55, 0).transformDirection(Bm); v[4].copy(v[3]).addScaledVector(v[5], 0.17); segAt(BM, j, v[3], v[4], 0.022); }); }
      pt.copy(nx2);
    }
    if(Tl.tip >= 0){ v[3].copy(pt).addScaledVector(dir, -0.02); v[4].copy(pt).addScaledVector(dir, 0.13); segAt(BM, Tl.tip, v[3], v[4], 0.075, 0.012); }
  }
  // ---- head parts: the jaw (open to roar, breathe, yawn, pant), a dog's tongue, ears, eyelids ----
  var jw = a === "yawn" ? 0.7 : a === "roar" || (a === "big" && kind === "dino") ? 0.65 : a === "breath" ? 0.55 : a === "puff" ? 0.25 :
           kind === "dog" && (a === "run" || a === "wag" || a === "greet") ? 0.3 : a === "carry" ? 0.2 : 0.03;
  S.jaw += (jw*(calm && jw > 0.3 ? 0.6 : 1) - S.jaw)*Math.min(1, dt*8);
  var J = Mo.jaw, hz0 = J.h, ja = S.jaw, tz = J.tip[2] - hz0[2], ty = J.tip[1] - hz0[1];
  var jx = v[0].set(hz0[0], hz0[1], hz0[2]).applyMatrix4(Mh), jt = v[1].set(0, hz0[1] + ty*Math.cos(ja) - tz*Math.sin(ja), hz0[2] + tz*Math.cos(ja) + ty*Math.sin(ja)).applyMatrix4(Mh);
  segAt(IM, J.i, jx, jt, J.w, J.th, J.th*0.5);
  Mo.mouthP = Mo.mouthP || jt.clone(); Mo.mouthP.copy(jt);
  if(Mo.tongue >= 0){
    if(ja > 0.15){ var tg0 = v[2].copy(jx).lerp(jt, 0.55), tg1 = v[3].set(0, hz0[1] + ty*Math.cos(ja*1.3) - (tz + hr*0.3)*Math.sin(ja*1.3) - hr*0.1, hz0[2] + (tz + hr*0.15)*Math.cos(ja*1.3)).applyMatrix4(Mh);
      tg1.y -= Math.abs(Math.sin(t*9))*0.01*k; segAt(IM, Mo.tongue, tg0, tg1, hr*0.13, hr*0.05); }
    else hideAt(IM, Mo.tongue);
  }
  // pointed ears: up and forward, flattened when asleep, laid back at a run, a flick now and then
  Mo.earsB.forEach(function(E){
    var flick = ((t*0.8 + Mo.seedF + E.s*0.9) % 4.7) < 0.22 ? Math.sin(((t*0.8 + Mo.seedF + E.s*0.9) % 4.7)/0.22*PI) : 0;
    var back = a === "sleep" ? 0.7 : a === "run" ? 0.45 : 0, ex = E.s*(0.3 + flick*0.35*k + (a === "sleep" ? 0.35 : 0)), ey = 1, ez = -0.12 - back - flick*0.4*k;
    var B0 = v[0].set(E.b[0], E.b[1], E.b[2]).applyMatrix4(Mh), dl = Math.hypot(ex, ey, ez), D = v[1].set(ex/dl, ey/dl, ez/dl).transformDirection(Mh);
    var B1 = v[2].copy(B0).addScaledVector(D, E.len); segAt(BM, E.i, B0, B1, E.w*0.5, E.w*0.13);
    var F0 = v[3].set(0, 0, 1).transformDirection(Mh); v[4].copy(B0).addScaledVector(F0, E.w*0.1).addScaledVector(D, E.len*0.06); v[5].copy(v[4]).addScaledVector(D, E.len*0.72);
    segAt(BM, E.j, v[4], v[5], E.w*0.3, E.w*0.06);
  });
  Mo.flop.forEach(function(E){
    var sw = (walk ? Math.sin(c*TAU*2 + E.s)*0.35 : Math.sin(t*1.3 + E.s)*0.05) + (a === "shake" ? Math.sin(t*28)*0.6 : 0);
    var ex = E.s*(0.35 + (a === "run" ? 0.3 : 0)), ez = -0.08 + sw*k - (a === "run" ? 0.6 : 0), dl = Math.hypot(ex, 1, ez);
    var B0 = v[0].set(E.b[0], E.b[1], E.b[2]).applyMatrix4(Mh), D = v[1].set(ex/dl, -1/dl, ez/dl).transformDirection(Mh);
    segAt(IM, E.i, B0, v[2].copy(B0).addScaledVector(D, E.len), hr*0.09, hr*0.27, hr*0.05);
  });
  // eyelids: a blink every few seconds (each pet its own rhythm), half shut in a yawn, shut asleep
  var bt2 = (t + Mo.seedF*0.7) % 3.9, blink = a === "sleep" ? 1 : a === "yawn" ? 0.55 : bt2 < 0.16 ? Math.sin(bt2/0.16*PI) : 0;
  Mo.blink = blink;
  Mo.eyes.forEach(function(e){
    if(blink < 0.04){ hideAt(IM, e.lid); return; }
    var c0 = e.c, n0 = e.n, r = e.r, top = v[0].set(c0[0] + n0[0]*r*0.12, c0[1] + r*1.02 + n0[1]*r*0.12, c0[2] + n0[2]*r*0.12).applyMatrix4(Mh);
    var bot = v[1].set(c0[0] + n0[0]*r*0.12, c0[1] + r*(1.02 - 2.1*blink) + n0[1]*r*0.12, c0[2] + n0[2]*r*0.12).applyMatrix4(Mh);
    segAt(IM, e.lid, top, bot, r*1.1, r*0.75, r*0.2);
  });
  // a sea serpent: its coils along a travelling wave (swimming, slithering), in a ring at rest; its tail fin at the end
  if(Mo.segs){
    if(!Q) Q = {m: TM.clone(), s: TS.clone(), q: TQ.clone(), p: TE.clone(), e: new Mo.g.rotation.constructor()};
    var T4 = Mo.segs, cnt = T4.count, swim = a === "swim" || a === "float", moving = a === "swim" || a === "slither", coil = a === "coil" || a === "sleep";
    var m = Q.m, amp = moving ? 0.16 : 0.06, sg = 0.13, hover = swim ? -0.06 : 0.12 + (calm ? 0 : Math.sin(t*2)*0.03);
    body.position.y = hover + 0.04; body.rotation.x = 0;
    var lx2 = 0, ly2 = 0, lz2 = 0, lyaw = 0;
    for(var si3 = 0; si3 < cnt; si3++){
      var x, y, z, yaw2;
      if(coil){ var ang = si3*0.62 + 0.3, rr = 0.22 + si3*0.012; x = Math.sin(ang)*rr; z = -0.1 + Math.cos(ang)*rr - 0.2; y = hover + si3*0.006; yaw2 = ang + PI/2; }
      else { var wv = ph*PI*1.4*(calm ? 0.5 : 1) - si3*0.7; x = Math.sin(wv)*amp*Math.min(1, si3/3 + 0.3); z = -0.12 - si3*sg; y = hover + (swim ? Math.sin(wv*0.5)*0.03 : 0); yaw2 = Math.cos(wv)*amp*2; }
      var sc = 1 - si3*0.06;
      Q.e.set(0, yaw2, 0); Q.q.setFromEuler(Q.e); Q.p.set(x, y, z); Q.s.set(sc, sc, sc); m.compose(Q.p, Q.q, Q.s); T4.setMatrixAt(si3, m);
      lx2 = x; ly2 = y; lz2 = z; lyaw = yaw2;
    }
    T4.instanceMatrix.needsUpdate = true;
    var fy = lyaw + Math.sin(t*3)*0.4*k + PI;
    v[3].set(lx2, ly2, lz2); v[4].set(lx2 + Math.sin(fy)*0.22, ly2 + 0.02, lz2 + Math.cos(fy)*0.22); segAt(BM, Mo.fin, v[3], v[4], 0.13, 0.02);
  }
  if(IM) IM.instanceMatrix.needsUpdate = true;
  if(BM) BM.instanceMatrix.needsUpdate = true;
}
var Q = null;

/* ---------- effects: pooled particles, lines, hearts (one set per page) ---------- */
var FXC = {fire: [0xffb030, 0xff5a1a], ember: [0xffa030, 0xff3a10], ice: [0xd8f4ff, 0x8ad0ff], snow: [0xffffff, 0xe8f4ff], sparkle: [0xffffff, 0xb8e0ff],
           prism: [0xff8ad8, 0x8ad8ff], wisp: [0xb46aff, 0x4a2a8a], glitter: [0xfff0a0, 0xffc030], smoke: [0x8a8a90, 0x4a4a50], bubbles: [0xc8f8ff, 0x6ad8f0], dust: [0xd8c8a8, 0x8a7a5a]};
function Fx(T, scene){
  var N = 192, pos = new Float32Array(N*3), col = new Float32Array(N*3), g = new T.BufferGeometry();
  g.setAttribute("position", new T.BufferAttribute(pos, 3)); g.setAttribute("color", new T.BufferAttribute(col, 3));
  var tex = null;
  try { var cv = document.createElement("canvas"); cv.width = cv.height = 32; var x = cv.getContext("2d"), gr = x.createRadialGradient(16, 16, 0, 16, 16, 16);
    gr.addColorStop(0, "rgba(255,255,255,1)"); gr.addColorStop(0.4, "rgba(255,255,255,0.6)"); gr.addColorStop(1, "rgba(255,255,255,0)"); x.fillStyle = gr; x.fillRect(0, 0, 32, 32); tex = new T.CanvasTexture(cv); } catch(e){ tex = null; }
  var pm = new T.PointsMaterial({size: 0.13, vertexColors: true, transparent: true, depthWrite: false, blending: T.AdditiveBlending, map: tex, sizeAttenuation: true});
  var pts = new T.Points(g, pm); pts.frustumCulled = false; pts.name = "pet-fx"; pts.renderOrder = 3;
  var P = []; for(var i = 0; i < N; i++){ P.push({life: 0, max: 1, vx: 0, vy: 0, vz: 0, c0: null, c1: null}); pos[i*3 + 1] = -999; }
  // lightning: 12 segments, briefly
  var lp = new Float32Array(24*3), lg = new T.BufferGeometry(); lg.setAttribute("position", new T.BufferAttribute(lp, 3));
  var lines = new T.LineSegments(lg, new T.LineBasicMaterial({color: 0xfff6a0, transparent: true, blending: T.AdditiveBlending, depthWrite: false, toneMapped: false}));
  lines.frustumCulled = false; lines.visible = false; lines.name = "pet-bolt";
  // hearts: six sprites
  var heartT = null;
  try { var hc = document.createElement("canvas"); hc.width = hc.height = 64; var h = hc.getContext("2d"); h.fillStyle = "#ff4d7a"; h.strokeStyle = "#ffffff"; h.lineWidth = 5;
    h.beginPath(); h.moveTo(32, 54); h.bezierCurveTo(4, 34, 8, 8, 32, 20); h.bezierCurveTo(56, 8, 60, 34, 32, 54); h.closePath(); h.stroke(); h.fill(); heartT = new T.CanvasTexture(hc); heartT.colorSpace = T.SRGBColorSpace; } catch(e){ heartT = null; }
  var hearts = []; for(var j = 0; j < 6; j++){ var s = new T.Sprite(new T.SpriteMaterial({map: heartT, transparent: true, depthWrite: false})); s.visible = false; s.scale.set(0.3, 0.3, 1); s.userData = {life: 0}; s.name = "pet-heart"; hearts.push(s); }
  var F = {pts: pts, lines: lines, hearts: hearts, next: 0, bolt: 0, scene: null, used: 0};
  F.attach = function(sc){ if(F.scene === sc) return; [pts, lines].concat(hearts).forEach(function(o){ if(o.parent) o.parent.remove(o); if(sc) sc.add(o); }); F.scene = sc; };
  F.attach(scene);
  var c0 = new T.Color(), c1 = new T.Color();
  // n particles of `kind` from (x, y, z), thrown along (dx, dz) at `sp` m/s, spread `spr`, living `life` s
  F.emit = function(kind, x, y, z, n, dx, dz, sp, spr, life, up){
    var C = FXC[kind] || FXC.smoke;
    for(var k = 0; k < n; k++){
      var i = F.next; F.next = (F.next + 1) % N; var p = P[i], r1 = Math.sin(i*12.9898 + k*78.233)*43758.5453, r2 = Math.sin(i*4.1414 + k*7.77)*15731.743, r3 = Math.sin(i*9.31 + k*1.3)*24634.6345;
      r1 -= Math.floor(r1); r2 -= Math.floor(r2); r3 -= Math.floor(r3);
      p.life = p.max = (life || 0.8)*(0.7 + r1*0.6); p.c0 = C[0]; p.c1 = C[1];
      p.vx = (dx || 0)*(sp || 0) + (r1 - 0.5)*spr; p.vz = (dz || 0)*(sp || 0) + (r2 - 0.5)*spr; p.vy = (up != null ? up : 0.4) + (r3 - 0.5)*spr*0.6; p.kind = kind;
      pos[i*3] = x; pos[i*3 + 1] = y; pos[i*3 + 2] = z;
    }
  };
  F.zap = function(x, y, z){
    var px = x, py = y + 0.9, pz = z;
    for(var i = 0; i < 12; i++){ var nx = px + Math.sin(i*2.7 + x)*0.12, ny = py - 0.075, nz = pz + Math.cos(i*3.1 + z)*0.12;
      lp[i*6] = px; lp[i*6 + 1] = py; lp[i*6 + 2] = pz; lp[i*6 + 3] = nx; lp[i*6 + 4] = ny; lp[i*6 + 5] = nz; px = nx; py = ny; pz = nz; }
    lg.attributes.position.needsUpdate = true; F.bolt = 0.16; lines.visible = true;
  };
  F.heart = function(x, y, z, n){
    for(var k = 0; k < (n || 3); k++){ var s = hearts.filter(function(h){ return !h.visible; })[0]; if(!s) return;
      s.visible = true; s.userData.life = 1.3 + k*0.15; s.userData.dx = (k - 1)*0.18; s.position.set(x + (k - 1)*0.15, y, z); s.material.opacity = 1; }
  };
  F.step = function(dt){
    var live = 0;
    for(var i = 0; i < N; i++){
      var p = P[i]; if(p.life <= 0) continue;
      p.life -= dt; if(p.life <= 0){ pos[i*3 + 1] = -999; col[i*3] = col[i*3 + 1] = col[i*3 + 2] = 0; continue; }
      live++;
      var f = p.life/p.max;
      if(p.kind === "snow" || p.kind === "glitter"){ p.vy -= dt*0.5; p.vx *= 0.98; p.vz *= 0.98; }
      else if(p.kind === "ember" || p.kind === "fire" || p.kind === "smoke" || p.kind === "wisp" || p.kind === "bubbles"){ p.vy += dt*0.4; p.vx *= 0.96; p.vz *= 0.96; }
      pos[i*3] += p.vx*dt; pos[i*3 + 1] += p.vy*dt; pos[i*3 + 2] += p.vz*dt;
      c0.setHex(p.c0); c1.setHex(p.c1); c0.lerp(c1, 1 - f); var a = Math.min(1, f*1.5);
      col[i*3] = c0.r*a; col[i*3 + 1] = c0.g*a; col[i*3 + 2] = c0.b*a;
    }
    g.attributes.position.needsUpdate = true; g.attributes.color.needsUpdate = true; F.used = live;
    pts.visible = live > 0;
    if(F.bolt > 0){ F.bolt -= dt; lines.material.opacity = Math.max(0, F.bolt/0.16); if(F.bolt <= 0) lines.visible = false; }
    hearts.forEach(function(s){ if(!s.visible) return; var u = s.userData; u.life -= dt; if(u.life <= 0){ s.visible = false; return; }
      s.position.y += dt*0.55; s.position.x += (u.dx || 0)*dt*0.3; s.material.opacity = Math.min(1, u.life); });
  };
  F.dispose = function(){ F.attach(null); g.dispose(); pm.dispose(); lg.dispose(); lines.material.dispose(); hearts.forEach(function(s){ s.material.dispose(); }); if(tex) tex.dispose(); if(heartT) heartT.dispose(); };
  return F;
}
// each species' element: what its idle puffs and breathes, what trails it while it moves (all skipped in Calm)
function elementFx(F, sp, st, M, a, t, dt){
  if(!F || !M) return;
  var fx = sp.fx, g = M.g, s = M.scale || 1, yaw = st.yaw, fx0 = Math.sin(yaw), fz0 = Math.cos(yaw);
  var hx = g.position.x + fx0*(M.dims.oz + M.dims.L*0.6)*s, hz = g.position.z + fz0*(M.dims.oz + M.dims.L*0.6)*s, hy = g.position.y + (M.dims.cy + M.dims.H*0.6 + 0.12)*s;
  if(M.mouthP){ M.g.updateMatrixWorld(true); var mw = M.mw || (M.mw = M.mouthP.clone()); M.P.localToWorld(mw.copy(M.mouthP)); hx = mw.x; hy = mw.y; hz = mw.z; }   // the open jaw
  st.fxT = (st.fxT || 0) + dt;
  var tick = st.fxT > 0.06; if(tick) st.fxT = 0;
  if(!tick) return;
  if(a === "breath"){ if(fx === "fire") F.emit("fire", hx, hy, hz, 3, fx0, fz0, 2.6, 0.5, 0.5, 0.15); else if(fx === "ice") F.emit("ice", hx, hy, hz, 3, fx0, fz0, 2.2, 0.5, 0.6, 0.05); else if(fx === "storm") F.zap(hx, hy - 0.3, hz); else F.emit(FXC[fx] ? fx : "smoke", hx, hy, hz, 2, fx0, fz0, 1.2, 0.4, 0.6); }
  if(a === "puff" || a === "crackle"){
    var kind = fx === "fire" ? "ember" : fx === "ice" ? "snow" : fx === "bubbles" ? "bubbles" : fx === "sparkle" ? "prism" : fx === "wisp" ? "wisp" : fx === "glitter" ? "glitter" : "smoke";
    if(fx === "storm"){ if(Math.sin(t*13) > 0.6) F.zap(g.position.x, g.position.y + 0.2*s, g.position.z); }
    else F.emit(kind, hx, hy, hz, 2, 0, 0, 0, 0.6, 0.9, 0.5);
  }
  if(a === "wings" && fx === "ice") F.emit("snow", g.position.x, g.position.y + M.dims.cy*s + 0.2, g.position.z, 2, 0, 0, 0, 1.2, 1.2, 0.2);
  // while moving: the golden dragon's glitter, the shadow dragon's wisps off its wings, the crystal's sparkle, the serpent's bubbles in water
  var mv = st.speed > 0.4;
  if(mv && fx === "glitter") F.emit("glitter", g.position.x - fx0*0.3*s, g.position.y + M.dims.cy*s, g.position.z - fz0*0.3*s, 1, 0, 0, 0, 0.3, 0.9, 0.1);
  if(mv && fx === "wisp") F.emit("wisp", g.position.x - fx0*0.2*s, g.position.y + (M.dims.cy + 0.1)*s, g.position.z - fz0*0.2*s, 2, -fx0, -fz0, 0.6, 0.5, 0.8, 0.2);
  if(fx === "sparkle" && (mv || a === "shimmer" || a === "wings") && Math.sin(t*7 + st.seed) > 0.3) F.emit("sparkle", g.position.x, g.position.y + M.dims.cy*s, g.position.z, 1, 0, 0, 0, 0.8, 0.5, 0.2);
  if(fx === "bubbles" && st.wet && mv) F.emit("bubbles", g.position.x, g.position.y + 0.05, g.position.z, 1, 0, 0, 0, 0.3, 0.8, 0.5);
}

/* ---------- a name tag (canvas text: never HTML) ---------- */
function tagSprite(T, name){
  var cv; try { cv = document.createElement("canvas"); } catch(e){ return null; }
  cv.width = 256; cv.height = 64; var g = cv.getContext("2d"); if(!g) return null;
  g.font = "700 30px system-ui, sans-serif"; g.textAlign = "center"; g.textBaseline = "middle";
  var tw = Math.min(240, g.measureText(name).width + 26);
  g.fillStyle = "rgba(20,16,30,0.72)"; if(g.roundRect){ g.beginPath(); g.roundRect(128 - tw/2, 10, tw, 44, 22); g.fill(); } else g.fillRect(128 - tw/2, 10, tw, 44);
  g.fillStyle = "#fff4d8"; g.fillText("🐾 " + name, 128, 33);
  var t = new T.CanvasTexture(cv); t.colorSpace = T.SRGBColorSpace;
  var s = new T.Sprite(new T.SpriteMaterial({map: t, transparent: true, depthWrite: false})); s.scale.set(0.9, 0.225, 1); s.name = "pet-tag"; s.renderOrder = 4;
  return s;
}

/* ---------- the runtime (games/hq3d.js drives it) ---------- */
// c: hq3d's ctx (THREE). opts: {calm(), night(), say(text), onCare(id, kind), onToggle(id, out), toast(text)}
function create(c, opts){
  opts = opts || {};
  var T = c.THREE, F = null, scene = null, mine = [], remote = {}, lobbyPets = [], owned = [], lobbyList = null, trail = [], ball = null, ballMesh = null;
  var prompt = null, promptFor = null, lastCare = {}, worldKey = null, greet = false, statsN = {pets: 0, meshes: 0};
  function calm(){ return !!(opts.calm && opts.calm()); }
  function build(p, seedKey){
    var M = model(T, {species: p.species || (p.sp && p.sp.id), variant: p.variant, acc: p.acc, stage: p.stage != null ? p.stage : stageOf(speciesOf(p.species), p.affection)});
    var tag = tagSprite(T, p.name || M.sp.name); if(tag){ tag.position.y = (M.dims.cy + M.dims.H + (M.sp.neck || 0) + 0.45)*M.scale; M.g.add(tag); M.tag = tag; }
    M.seed = hashStr(seedKey || p.id || p.name || "pet");
    return M;
  }
  function drop(M){ if(!M) return; if(M.g.parent) M.g.parent.remove(M.g); M.g.traverse(function(o){ if((o.isMesh || o.isInstancedMesh) && !o.geometry.userData.shared){ o.geometry.dispose(); } if(o.isSprite && o.name === "pet-tag"){ o.material.map.dispose(); o.material.dispose(); } }); }
  function sig(p){ return [p.id, p.species, p.variant | 0, p.acc | 0, stageOf(speciesOf(p.species), p.affection), p.name].join("|"); }
  // your pets out with you (MAX_ACTIVE): rebuilt only when what they look like changes
  function syncMine(){
    var out = owned.filter(function(p){ return p.active && speciesOf(p.species); }).slice(0, MAX_ACTIVE);
    var keep = [];
    out.forEach(function(p, i){
      var have = mine.filter(function(m){ return m.p.id === p.id; })[0];
      if(have && have.sig === sig(p)){ have.p = p; have.slot = i; keep.push(have); return; }
      var M = build(p, "me:" + p.id), st = have ? have.st : null;
      if(have) drop(have.M);
      keep.push({p: p, M: M, st: st, slot: i, sig: sig(p)});
    });
    mine.forEach(function(m){ if(keep.indexOf(m) < 0) drop(m.M); });
    mine = keep;
    lobbyPets.forEach(function(l){ drop(l.M); }); lobbyPets = []; worldKey = null;   // the lobby re-spawns its stay-home set
  }
  function placeIn(M, sc){ if(M.g.parent !== sc){ if(M.g.parent) M.g.parent.remove(M.g); if(sc) sc.add(M.g); } }
  function setPose(M, st, ground, t, cm, look){
    M.g.visible = !st.hidden;
    M.g.position.set(st.x, ground + (st.y || 0), st.z); M.g.rotation.y = st.yaw;
    pose(M, st, t, cm, look);
  }
  var K = {};
  K.setOwned = function(list){ owned = (list || []).filter(function(p){ return p && speciesOf(p.species); }).slice(0, MAX_OWNED); syncMine(); };
  // whose lobby pets to show: null = yours (owned, home and not out); a list (a visit) = the host's
  K.setLobby = function(list){ lobbyList = Array.isArray(list) ? list.slice(0, MAX_OWNED) : null; lobbyPets.forEach(function(l){ drop(l.M); }); lobbyPets = []; worldKey = null; };
  K.net = function(){ return encode(owned.filter(function(p){ return p.active; })); };
  K.out = function(){ return mine.map(function(m){ return {id: m.p.id, name: m.p.name, x: m.st ? m.st.x : null, z: m.st ? m.st.z : null, anim: m.st ? m.st.anim : null, mode: m.st ? m.st.mode : null}; }); };
  K.stats = function(){ return {mine: mine.length, remote: Object.keys(remote).reduce(function(n, u){ return n + remote[u].length; }, 0), lobby: lobbyPets.length,
    drawn: statsN.pets, meshes: statsN.meshes, fx: F ? F.used : 0}; };
  function homeWorld(w, name){ return !!(w && (w.petHome || name === "lobby")); }
  function lobbySet(){
    if(lobbyList) return lobbyList.map(function(p, i){ return {id: "visit:" + i, species: p.species, variant: p.variant, acc: p.acc, stage: p.stage, name: p.name}; });
    return owned.filter(function(p){ return p.home && !p.active; });
  }
  function careOf(id, kind){
    var now = Date.now(); if(lastCare[id + kind] && now - lastCare[id + kind] < 2500) return;
    lastCare[id + kind] = now; if(opts.onCare) opts.onCare(id, kind);
  }
  function showPrompt(text){
    if(!c.el || typeof document === "undefined") return;
    if(!prompt){ prompt = document.createElement("div"); prompt.className = "hqpets-prompt"; prompt.setAttribute("aria-live", "polite"); c.el.appendChild(prompt); }
    if(promptFor !== text){ promptFor = text; prompt.textContent = text || ""; prompt.hidden = !text; }
  }
  // info: {t, dt, scene, world, worldName, owner {x, z, yaw, speed, run, ride}, blocked, ground, water, peers, night}
  K.frame = function(info){
    var t = info.t || 0, dt = info.dt || 0, cm = calm(), sc = info.scene;
    if(!F) F = Fx(T, sc);
    if(sc !== scene){
      // another floor: everyone comes along beside you, the trail starts again, strangers' pets are left behind
      scene = sc; trail = []; F.attach(sc); ball = null; if(ballMesh && ballMesh.parent) ballMesh.parent.remove(ballMesh);
      mine.forEach(function(m){ placeIn(m.M, sc); if(m.st){ var b = besideOwner(info.owner, m.slot, info.blocked); m.st.x = b.x; m.st.z = b.z; m.st.y = 0; m.st.hidden = false; m.st.mode = "follow"; } });
      Object.keys(remote).forEach(function(u){ remote[u].forEach(function(r){ drop(r.M); }); }); remote = {};
      lobbyPets.forEach(function(l){ drop(l.M); }); lobbyPets = []; worldKey = null;
    }
    var o = info.owner || {x: 0, z: 0, yaw: 0, speed: 0};
    if(!o.ride) trailPush(trail, o.x, o.z);
    // fin finishes: the ice dragon glows at night, the shadow dragon goes see-through, the crystal shimmers
    var night = !!(info.night);
    if(FIN.ice) FIN.ice.emissiveIntensity = night ? 0.65 : 0.06;
    if(FIN.shadow) FIN.shadow.opacity = night ? 0.62 : 0.94;
    if(FIN.crystal && !cm) FIN.crystal.emissive.setHSL((t*0.08) % 1, 0.7, 0.55);
    if(FIN["ice|2"]) FIN["ice|2"].emissiveIntensity = FIN.ice ? FIN.ice.emissiveIntensity : 0.06;
    if(FIN["shadow|2"]) FIN["shadow|2"].opacity = night ? 0.5 : 0.9;
    if(FIN["ice|i"]) FIN["ice|i"].emissiveIntensity = FIN.ice ? FIN.ice.emissiveIntensity : 0.06;
    if(FIN["shadow|i"]) FIN["shadow|i"].opacity = night ? 0.62 : 0.94;
    if(FIN["crystal|i"] && FIN.crystal) FIN["crystal|i"].emissive.copy(FIN.crystal.emissive);
    var drawn = 0, meshes = 0;
    // ---- yours ----
    mine.forEach(function(m, i){
      placeIn(m.M, sc);
      if(!m.st){ var b = besideOwner(o, m.slot, info.blocked); m.st = newState(m.M.seed, b.x, b.z, o.yaw); m.st.id = m.p.id; }
      var ev = step(m.st, {owner: o, slot: m.slot, sp: m.M.sp, trail: trail, blocked: info.blocked, water: info.water, calm: cm,
                           ball: ball, fetcher: ball && ball.who === i}, dt);
      ev.forEach(function(e){
        if(e.type === "pickup" && ball){ ball.carried = true; }
        if(e.type === "drop" && ball){ ball = null; if(ballMesh) ballMesh.visible = false; F.heart(m.st.x, (m.M.dims.cy + 0.6)*m.M.scale, m.st.z, 3); careOf(m.p.id, "fetch");
          if(opts.say) opts.say(m.p.name + " brought the ball back!"); }
        if(e.type === "trickdone"){ F.heart(m.st.x, (m.M.dims.cy + 0.6)*m.M.scale, m.st.z, 2); careOf(m.p.id, "trick"); }
        if(e.type === "excited" && !cm) F.emit("dust", m.st.x, 0.05, m.st.z, 4, 0, 0, 0, 1.2, 0.5, 0.4);
      });
      var gy = info.ground ? info.ground(m.st.x, m.st.z) : 0;
      setPose(m.M, m.st, gy, t, cm, ball && ball.who === i && !ball.carried ? ball : o);
      if(!cm) elementFx(F, m.M.sp, m.st, m.M, m.st.anim, t, dt);
      if(!m.st.hidden){ drawn++; meshes += m.M.meshes + (m.M.tag ? 1 : 0); }
    });
    // ---- the ball ----
    if(ball){
      if(!ballMesh){ ballMesh = new T.Mesh(new T.SphereGeometry(0.07, 10, 8), new T.MeshStandardMaterial({color: 0xd8f040, roughness: 0.6})); ballMesh.name = "pet-ball"; }
      if(ballMesh.parent !== sc) sc.add(ballMesh);
      ballMesh.visible = !ball.carried;
      ball.t += dt; var k = Math.min(1, ball.t/ball.dur);
      ball.x = ball.x0 + (ball.lx - ball.x0)*k; ball.z = ball.z0 + (ball.lz - ball.z0)*k; ball.landed = k >= 1; ball.fresh = false;
      var by = (info.ground ? info.ground(ball.x, ball.z) : 0) + 0.07 + (cm ? 0 : Math.sin(k*PI)*Math.min(3, ball.d*0.35)) + (k < 1 ? 1.2*(1 - k) : 0);
      ballMesh.position.set(ball.x, by, ball.z);
      if(ball.carried){ var fm = mine[ball.who]; if(fm){ var s = fm.M.scale; ballMesh.visible = true; ballMesh.position.set(fm.st.x + Math.sin(fm.st.yaw)*(fm.M.dims.oz + fm.M.dims.L*0.7)*s, (info.ground ? info.ground(fm.st.x, fm.st.z) : 0) + (fm.M.dims.cy + fm.M.dims.H*0.3)*s, fm.st.z + Math.cos(fm.st.yaw)*(fm.M.dims.oz + fm.M.dims.L*0.7)*s); } }
      if(ball.t > 25){ ball = null; ballMesh.visible = false; }
    }
    // ---- others' pets: simulated here from their pose (never streamed); drawn within 80 m ----
    var seen = {};
    (info.peers || []).forEach(function(pr){
      if(!pr || typeof pr.u !== "string") return;
      var list = decode(pr.pt); seen[pr.u] = 1;
      var R = remote[pr.u] || (remote[pr.u] = []), key = JSON.stringify(pr.pt || []);
      if(R.key !== key){ R.forEach(function(r){ drop(r.M); }); R.length = 0; R.key = key;
        list.forEach(function(p, i){ var M = build({species: p.sp.id, variant: p.variant, acc: p.acc, stage: p.stage, name: p.name}, pr.u + ":" + i); R.push({M: M, st: null, slot: i, tr: []}); }); }
      var far = Math.hypot(pr.x - o.x, pr.z - o.z) > 80;
      R.forEach(function(r){
        placeIn(r.M, sc);
        var po = {x: pr.x, z: pr.z, yaw: pr.yaw, speed: pr.speed || 0, run: (pr.speed || 0) > 4, ride: pr.ride || null};
        if(!r.st){ var b = besideOwner(po, r.slot, info.blocked); r.st = newState(r.M.seed, b.x, b.z, pr.yaw); }
        if(far){ r.M.g.visible = false; r.st.x = pr.x; r.st.z = pr.z; r.st.hidden = false; return; }
        if(!po.ride) trailPush(r.tr, pr.x, pr.z);
        step(r.st, {owner: po, slot: r.slot, sp: r.M.sp, trail: r.tr, blocked: info.blocked, water: info.water, calm: cm}, dt);
        setPose(r.M, r.st, (info.ground ? info.ground(r.st.x, r.st.z) : 0), t, cm, po);
        if(!cm) elementFx(F, r.M.sp, r.st, r.M, r.st.anim, t, dt);
        if(!r.st.hidden){ drawn++; meshes += r.M.meshes + 1; }
      });
    });
    Object.keys(remote).forEach(function(u){ if(!seen[u]){ remote[u].forEach(function(r){ drop(r.M); }); delete remote[u]; } });
    // ---- the lobby: your stay-home pets (or your host's) ----
    var home = homeWorld(info.world, info.worldName), wk = home ? (info.worldName || "home") + "|" + lobbySet().map(sig).join(",") : null;
    if(wk !== worldKey){
      lobbyPets.forEach(function(l){ drop(l.M); }); lobbyPets = []; worldKey = wk;
      if(home){
        var hb = info.world.petHome || {}, set = lobbySet(), bounds = hb.bounds || info.world.bounds || [o.x - 8, o.x + 8, o.z - 8, o.z + 8];
        set.forEach(function(p, i){
          var M = build(p, "lobby:" + (p.id || i)), sp0 = spotFor(M.sp, hb.spots, i), x = sp0 ? sp0.x : bounds[0] + (bounds[1] - bounds[0])*(0.25 + 0.5*((i*0.37) % 1)), z = sp0 ? sp0.z : bounds[2] + (bounds[3] - bounds[2])*(0.3 + 0.4*((i*0.61) % 1));
          var st = newState(M.seed, x, z, i); st.id = p.id || ("l" + i); st.mode = "idle"; st.until = 0.5 + i*0.3; st.anim = "sit";
          lobbyPets.push({p: p, M: M, st: st, i: i, bounds: bounds, spots: hb.spots || null});
        });
        greet = !lobbyList;   // your own pets run to greet you; a host's just carry on
      }
    }
    var near = null, nearD = 2.2;
    lobbyPets.forEach(function(l){
      placeIn(l.M, sc);
      var mates = lobbyPets.map(function(x){ return {id: x.st.id, x: x.st.x, z: x.st.z, kind: x.M.sp.kind}; });
      var ev = lobbyStep(l.st, {sp: l.M.sp, i: l.i, owner: o, bounds: l.bounds, blocked: info.blocked, spots: l.spots, calm: cm, mates: mates, greet: greet}, dt);
      ev.forEach(function(e){ if(e.type === "greet" && !cm) F.heart(l.st.x, (l.M.dims.cy + 0.6)*l.M.scale, l.st.z, 2); });
      var far = Math.hypot(l.st.x - o.x, l.st.z - o.z);
      if(far > 80){ l.M.g.visible = false; return; }
      setPose(l.M, l.st, (info.ground ? info.ground(l.st.x, l.st.z) : 0), t, cm, o);
      if(!cm) elementFx(F, l.M.sp, l.st, l.M, l.st.anim, t, dt);
      drawn++; meshes += l.M.meshes + 1;
      if(!lobbyList && far < nearD){ nearD = far; near = {kind: "lobby", p: l.p}; }
    });
    greet = false;
    // in your own lobby, E takes a stay-home pet out, or leaves one of yours here
    var shop = !o.ride && info.world && info.world.petShop && info.world.petShop.near(o.x, o.z);
    if(shop) showPrompt("E  Paws & Claws: adopt a pet");
    else if(home && !lobbyList && !o.ride){
      mine.forEach(function(m){ var d = Math.hypot(m.st.x - o.x, m.st.z - o.z); if(d < nearD){ nearD = d; near = {kind: "mine", p: m.p}; } });
      showPrompt(near ? (near.kind === "lobby" ? "E  Take " + near.p.name + " out" : "E  Leave " + near.p.name + " here") : null);
    } else showPrompt(null);
    K.near = near;
    F.step(dt);
    statsN.pets = drawn; statsN.meshes = meshes;
  };
  function nearestMine(o, maxD){ var best = null, bd = maxD; mine.forEach(function(m){ if(!m.st || m.st.hidden) return; var d = Math.hypot(m.st.x - o.x, m.st.z - o.z); if(d < bd){ bd = d; best = m; } }); return best; }
  // keys: B throws a ball, U pets the nearest, O asks for the next trick it knows, E in your lobby takes a pet out / leaves it
  K.key = function(code, o, blocked){
    o = o || {x: 0, z: 0, yaw: 0};
    if(code === "KeyE" && K.near && opts.onToggle){ var p = K.near.p; opts.onToggle(p.id, K.near.kind === "lobby"); return true; }
    if(!mine.length) return false;
    if(code === "KeyB"){
      if(o.ride) return false;
      var L = throwBall(o, blocked, 11), who = 0;
      mine.forEach(function(m, i){ if((m.p.affection | 0) > (mine[who].p.affection | 0)) who = i; });
      ball = {x0: o.x + Math.sin(o.yaw)*0.4, z0: o.z + Math.cos(o.yaw)*0.4, lx: L.x, lz: L.z, d: L.d, t: 0, dur: Math.max(0.35, L.d/9), who: who, fresh: true, landed: false, carried: false, x: o.x, z: o.z};
      mine.forEach(function(m){ if(m.st){ m.st.trick = null; if(m.st.mode === "fetch" || m.st.mode === "carry") m.st.mode = "follow"; } });
      if(opts.say) opts.say("Fetch, " + mine[who].p.name + "!");
      return true;
    }
    var m = nearestMine(o, code === "KeyU" ? 2.6 : 8);
    if(!m){ if(opts.say && (code === "KeyU" || code === "KeyO")) opts.say(code === "KeyU" ? "Walk up to your pet to pet it." : "Your pet is too far away."); return code === "KeyU" || code === "KeyO"; }
    if(code === "KeyU"){
      m.st.trick = {k: m.M.sp.kind === "cat" ? "wag" : "sit", t: 0, dur: 1.6}; m.st.mode = "trick";
      if(F && !calm()) F.heart(m.st.x, (m.M.dims.cy + 0.55)*m.M.scale + (m.M.g.position.y - m.st.y*0), m.st.z, 3);
      else if(F) F.heart(m.st.x, (m.M.dims.cy + 0.55)*m.M.scale, m.st.z, 1);
      careOf(m.p.id, "pet");
      if(opts.say) opts.say("You pet " + m.p.name + ". ♥");
      return true;
    }
    if(code === "KeyO"){
      var known = tricksFor(m.M.sp, m.p.affection), i = ((m.trickI | 0) + 1) % known.length; m.trickI = i;
      var tr = known[i], calmBig = calm() && (tr.id === "spin" || tr.id === "roll" || tr.id === "big");
      m.st.trick = {k: calmBig ? "sit" : tr.id, t: 0, dur: tr.id === "big" ? 2.2 : tr.id === "sit" ? 1.4 : 1.6}; m.st.mode = "trick";
      if(tr.id === "big" && !calm() && F){ var fx = m.M.sp.fx; if(fx === "fire") F.emit("fire", m.st.x, 1, m.st.z, 12, 0, 0, 0, 2, 0.8, 1); if(fx === "ice") F.emit("snow", m.st.x, 1.2, m.st.z, 14, 0, 0, 0, 2, 1.2, 0.6); if(fx === "storm") F.zap(m.st.x, 0.6, m.st.z); }
      var nx = nextTrick(m.M.sp, m.p.affection);
      if(opts.say) opts.say(m.p.name + ": " + tr.label + "!" + (nx && i === known.length - 1 ? " (" + nx.label + " at " + nx.at + " affection)" : ""));
      return true;
    }
    return false;
  };
  K.dispose = function(){
    mine.forEach(function(m){ drop(m.M); }); mine = [];
    Object.keys(remote).forEach(function(u){ remote[u].forEach(function(r){ drop(r.M); }); }); remote = {};
    lobbyPets.forEach(function(l){ drop(l.M); }); lobbyPets = [];
    if(F){ F.dispose(); F = null; } if(ballMesh){ if(ballMesh.parent) ballMesh.parent.remove(ballMesh); ballMesh.geometry.dispose(); ballMesh.material.dispose(); ballMesh = null; }
    if(prompt && prompt.parentNode) prompt.parentNode.removeChild(prompt); prompt = null;
  };
  return K;
}

/* ---------- the lobby hook (the HQ revamp's lobby calls it) ---------- */
// lobby(world, spots): this world is where your stay-home pets live; spots [{x, z, kind: bed|perch|tree|pen|bowl|water}]
// (optional) are where they nap and wait. Without spots they wander the floor, kept off what world.blocked says.
var SPOT_KINDS = {bed: 1, perch: 1, tree: 1, pen: 1, bowl: 1, water: 1};
function lobby(world, spots){
  if(!world || typeof world !== "object") return null;
  var S = (Array.isArray(spots) ? spots : []).filter(function(s){ return s && isFinite(s.x) && isFinite(s.z) && SPOT_KINDS[s.kind]; })
    .slice(0, 32).map(function(s){ return {x: +s.x, z: +s.z, kind: s.kind}; });
  world.petHome = {spots: S, bounds: Array.isArray(world.bounds) && world.bounds.length === 4 ? world.bounds.slice() : null};
  return world.petHome;
}

/* ---------- the Pet shop on a City lot ---------- */
var SHOP_ID = "petshop:0", SHOP_NAME = "Paws & Claws", SHOP_MIN_W = 12, SHOP_MIN_D = 12, SHOP_FROM_PLAZA = 110;
var SHOP_PREF = {commercial: 4, mixed: 3, residential: 2, oldtown: 2, downtown: 1};
function frameOf(o){ return HQV.hqDealer && HQV.hqDealer.frame ? HQV.hqDealer.frame(o) : null; }
function siteOf(W, id){ var S = W.sites || []; for(var i = 0; i < S.length; i++) if(S[i] && S[i].id === id) return S[i]; return null; }
function shopPick(W){
  if(!W || !W.lots) return null;
  var legend = (W.districts && W.districts.legend) || [], pl = siteOf(W, "fountain:0") || siteOf(W, "spawn:0"), px = pl ? pl.x/100 : 0, pz = pl ? pl.z/100 : 0, best = null;
  W.lots.forEach(function(l){
    if(!l || l.kind !== "building" || (l.min_tier != null && (l.min_tier | 0) > 1)) return;
    var F = frameOf(l); if(!F || F.w < SHOP_MIN_W || F.d < SHOP_MIN_D || F.w > 40 || F.d > 40) return;
    var from = Math.hypot(F.cx - px, F.cz - pz);
    var rank = (SHOP_PREF[legend[l.district | 0]] || 0)*20 - Math.abs(from - SHOP_FROM_PLAZA)*0.3 - Math.abs(F.w - 18)*0.5;
    if(!best || rank > best.rank || (rank === best.rank && (l.id | 0) < (best.lot.id | 0))) best = {lot: l, F: F, rank: rank};
  });
  return best;
}
// place(W): a "petshop:0" site on a building lot, in every city from tier 1 (pure; idempotent)
function place(W){
  if(!W || !W.sites || !W.lots) return null;
  var have = (W.sites || []).filter(function(s){ return s && s.kind === "petshop"; })[0]; if(have) return have;
  var c = shopPick(W); if(!c) return null;
  var l = c.lot, F = c.F, y = l.door && l.door.length >= 3 ? l.door[1] | 0 : (l.y | 0);
  l.was = l.kind; l.kind = "petshop";
  var s = {id: SHOP_ID, kind: "petshop", tier: 1, lot: l.id, block: l.block, district: l.district,
           x: Math.round(F.cx*100), y: y, z: Math.round(F.cz*100), w: Math.round(F.w*100), d: Math.round(F.d*100),
           front: [Math.round(F.f[0]*65536), Math.round(F.f[1]*65536)], facing: l.facing || "north", name: "Pet shop (" + SHOP_NAME + ")", claimed: 1};
  W.sites.push(s); W.index = null;
  return s;
}
// build(c, site, opts): the shop, a civic building as games/hqcity3d.js keeps them
function build(c, site, opts){
  opts = opts || {};
  var T = c.THREE, F = frameOf(site), y0 = (+site.y || 0)/100;
  var g = new T.Group(); g.name = "petshop"; g.position.set(F.cx, y0, F.cz); g.rotation.y = F.rot;
  var stat = new T.Group(); g.add(stat);
  var Wd = Math.min(F.w - 2, 18), Dd = Math.min(F.d - 2, 14), H = 6, PL = 0.3, hz1 = Dd/2 - 3, hz0 = -Dd/2;
  var cr = Math.cos(F.rot), sr = Math.sin(F.rot);
  function world(x, z){ return {x: F.cx + x*cr + z*sr, z: F.cz - x*sr + z*cr}; }
  function box(w, h, d, m, x, y, z, p){ return c.box(w, h, d, m, x, y, z, p || stat); }
  var B = {g: g, doors: [], hits: [], glows: [], boxes: [], lod: [], decks: [], top: function(){ return H + 3; }, tint: 0xf2c6a0, kind: "petshop", x: F.cx, y: y0, z: F.cz, site: site, frame: F};
  B.top = H + 3;
  var wall = c.mat(0xf6e2c8, {roughness: 0.8}), trim = c.mat(0x3a8a6a, {roughness: 0.6}), roofM = c.mat(0xd86a4a, {roughness: 0.7});
  box(Wd + 1, 0.6, Dd + 1, c.mat(0xe0d8c8, {roughness: 0.7}), 0, PL - 0.3, 0);
  box(Wd, H, hz1 - hz0, wall, 0, PL + H/2, (hz0 + hz1)/2);
  box(Wd + 0.6, 0.5, hz1 - hz0 + 0.6, trim, 0, PL + H + 0.25, (hz0 + hz1)/2);
  // a pitched roof, a big shop window, a striped awning, a paw-print sign and a dog-house kiosk out front
  var roof = new T.Mesh(new T.CylinderGeometry(0.01, (hz1 - hz0)*0.62, Wd + 0.4, 3), roofM); roof.rotation.z = PI/2; roof.rotation.y = PI/2; roof.rotation.order = "ZYX";
  roof.position.set(0, PL + H + 1.6, (hz0 + hz1)/2); roof.scale.set(1, 1, 0.5); roof.castShadow = true; stat.add(roof);
  var glass = new T.MeshStandardMaterial({color: 0x9fd8f0, roughness: 0.1, metalness: 0.3, emissive: 0x6ab0d8, emissiveIntensity: 0});
  box(Wd*0.62, H*0.5, 0.12, glass, -Wd*0.12, PL + H*0.42, hz1 + 0.04);
  var door = c.mat(0x3a8a6a, {roughness: 0.5}); box(2, 3, 0.15, door, Wd*0.32, PL + 1.5, hz1 + 0.06);
  for(var i = 0; i < 7; i++) box(Wd/7, 0.12, 1.6, c.mat(i % 2 ? 0xffffff : 0x3a8a6a, {roughness: 0.8}), -Wd/2 + Wd/14 + i*Wd/7, PL + H*0.82, hz1 + 0.8);
  var signT = c.canvasTex(512, 128, function(gx){
    gx.fillStyle = "#3a8a6a"; gx.fillRect(0, 0, 512, 128); gx.fillStyle = "#fff4d8"; gx.font = "900 64px system-ui, sans-serif"; gx.textAlign = "center"; gx.textBaseline = "middle";
    gx.fillText("🐾 Paws & Claws", 256, 66);
  }).t;
  signT.colorSpace = T.SRGBColorSpace;
  var signM = new T.MeshStandardMaterial({map: signT, emissiveMap: signT, emissive: 0xffffff, emissiveIntensity: 0.15, roughness: 0.6});
  var sign = new T.Mesh(new T.PlaneGeometry(Wd*0.7, Wd*0.7/4), signM); sign.position.set(0, PL + H + 0.9, hz1 + 0.32); g.add(sign);
  // a few pets in the window and out front (static: the shop's own, not anyone's)
  var showcase = [["corgi", 0], ["tabby", 1], ["firedragon", 0], ["triceratops", 2], ["icedragon", 0]], pets = [];
  showcase.forEach(function(sc, k){
    var M = model(T, {species: sc[0], variant: sc[1], acc: 1, stage: 1}); var st = newState(hashStr(sc[0]), 0, 0, 0); st.anim = k % 2 ? "sit" : "wag";
    pose(M, st, 0, true);
    M.g.position.set(-Wd*0.35 + k*Wd*0.16, PL, hz1 + 2.2 + (k % 2)*0.4); M.g.rotation.y = (k - 2)*0.2; g.add(M.g); pets.push({M: M, st: st});
  });
  var dx0 = Wd*0.32, dz0 = hz1 + 0.6, dw = world(dx0, dz0 + 1.2);
  B.door = {x: dw.x, z: dw.z, yaw: F.rot}; g.userData.door = B.door;
  B.doorWorld = dw;
  function note(cx0, cz, w, d, ya, yb){
    var o = world(cx0, cz), a = world(cx0 - w/2, cz - d/2), b2 = world(cx0 + w/2, cz - d/2), e = world(cx0 - w/2, cz + d/2), f2 = world(cx0 + w/2, cz + d/2);
    B.lod.push({x: o.x, z: o.z, w: w, d: d, rot: F.rot, y0: y0 + ya, y1: y0 + yb});
    B.boxes.push({min: {x: Math.min(a.x, b2.x, e.x, f2.x), y: y0 + ya, z: Math.min(a.z, b2.z, e.z, f2.z)}, max: {x: Math.max(a.x, b2.x, e.x, f2.x), y: y0 + yb, z: Math.max(a.z, b2.z, e.z, f2.z)},
                  o: {x: o.x, z: o.z, hw: w/2, hd: d/2, rot: F.rot, y0: ya}});
  }
  note(0, (hz0 + hz1)/2, Wd, hz1 - hz0, 0, PL + H + 2.6);
  B.inside = function(x, z){ var dx = x - F.cx, dz = z - F.cz, lx = dx*cr - dz*sr, lz = dx*sr + dz*cr; return Math.abs(lx) <= Wd/2 && lz >= hz0 && lz <= hz1; };
  // near the door (or the window), E opens the adoption panel
  B.near = function(x, z){ return Math.hypot(x - dw.x, z - dw.z) < 4.5 || (function(){ var dx = x - F.cx, dz = z - F.cz, lx = dx*cr - dz*sr, lz = dx*sr + dz*cr; return Math.abs(lx) <= Wd/2 + 1 && lz >= hz1 - 0.5 && lz <= hz1 + 4; })(); };
  B.setNight = function(n){ glass.emissiveIntensity = n ? 0.8 : 0; signM.emissiveIntensity = n ? 1.1 : 0.15; };
  B.setNight(opts.night !== false && !!opts.night);
  B.animate = function(t, dt, k){ pets.forEach(function(p, i){ p.st.anim = (Math.floor(t/4 + i) % 3) === 0 ? "wag" : "sit"; pose(p.M, p.st, t, !k); }); };
  if(HQV.hqMerge && HQV.hqMerge.mergeStatic){ try { HQV.hqMerge.mergeStatic(T, stat); } catch(e){} }
  stat.traverse(function(o){ if(o.isMesh) o.receiveShadow = true; });
  B.dispose = function(){ B.dead = true; };
  return B;
}

HQV.hqPets = {
  SPECIES: SPECIES, KIND_LABEL: KIND_LABEL, ACC: ACC, ACC_NAMES: ACC_NAMES, BAD_WORDS: BAD_WORDS, TRICKS: TRICKS, IDLES: IDLES,
  MAX_OWNED: MAX_OWNED, MAX_ACTIVE: MAX_ACTIVE, NAME_MAX: NAME_MAX, VARIANTS: VARIANTS, ACC_MAX: ACC_MAX, AFF_MAX: AFF_MAX, STAGE_AT: STAGE_AT,
  speciesOf: speciesOf, stageOf: stageOf, tricksFor: tricksFor, nextTrick: nextTrick, cleanName: cleanName, accOk: accOk, canAdopt: canAdopt,
  encode: encode, decode: decode, newState: newState, step: step, lobbyStep: lobbyStep, spotFor: spotFor, followTarget: followTarget,
  trailPush: trailPush, trailAt: trailAt, throwBall: throwBall, besideOwner: besideOwner, hashStr: hashStr,
  model: model, pose: pose, create: create, lobby: lobby, place: place, build: build, pick: shopPick, SHOP_ID: SHOP_ID, SHOP_NAME: SHOP_NAME
};
})();
