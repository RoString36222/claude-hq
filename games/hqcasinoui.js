/* Claude HQ: the Casino's games (HQ 3.7) -- the panel you play at, and the art the casino floor shares.
 *
 * The Arena decides every outcome (backend/src/casino.rs); this page only animates what it is told and has opinions
 * about it. Walk up to a machine or a table in the casino (games/hqcasino.js) and press E: the panel opens on that
 * game. Chips come from the cage (Poke Coins in, 10 chips a coin; cash them back the same way).
 *
 *   HQV.hqCasinoUi.mount(stage, opts) -> ui {open(game), close(), isOpen(), owns(e), destroy(), root, me()}
 *       opts = {get(path) -> Promise<json>, post(path, body) -> Promise<{ok, status, j}>, calm() -> bool,
 *               audio() -> {ctx, out} | null, announce(text), onClose(), onResult(game, j)}
 *   HQV.hqCasinoUi.roast(o, k) -> {text, art}   (pure) a loss's line and its picture; o = {game, bet, payout, streak, result}
 *   HQV.hqCasinoUi.cheer(o, k) -> {text, art}   (pure) a win's
 *   HQV.hqCasinoUi.art: {symbol(g, sym, x, y, s), card(g, c, x, y, w, h, down), die(g, n, x, y, s), horse(g, x, y, s, ph, silk)}
 *   HQV.hqCasinoUi.GAMES: the games' names, icons and verbs; ROULETTE: the wheel's pocket order
 *
 * The roasts are savage about your luck, never about you. They pick by the play (a near miss, the zero, your horse
 * last, a bust at 22, a big bet, a losing streak) and rotate so you rarely see one twice. textContent only.
 * In Calm and with reduced motion every animation is short and nothing flashes or shakes.
 */
(function(){
"use strict";
var G = typeof window !== "undefined" ? window : globalThis;
var HQV = G.HQV = G.HQV || {};
var PI = Math.PI, TAU = PI*2;

var GAMES = {
  slots: {name: "Slots", icon: "\ud83c\udfb0", verb: "Spin"},
  roulette: {name: "Roulette", icon: "\ud83c\udfaf", verb: "Spin"},
  horses: {name: "The Race Book", icon: "\ud83c\udfc7", verb: "Start the race"},
  plinko: {name: "Plinko", icon: "\ud83d\udd3b", verb: "Drop"},
  wheel: {name: "The Lucky Wheel", icon: "\ud83c\udfa1", verb: "Spin"},
  rocket: {name: "Rocket", icon: "\ud83d\ude80", verb: "Launch"},
  dice: {name: "The Dice Pit", icon: "\ud83c\udfb2", verb: "Roll"},
  scratch: {name: "Scratch-O-Matic", icon: "\ud83c\udf9f\ufe0f", verb: "Buy a card"},
  coin: {name: "Coin Toss", icon: "\ud83e\ude99", verb: "Flip"},
  blackjack: {name: "Blackjack", icon: "\ud83c\udccf", verb: "Deal"},
  duel: {name: "The Duel Table \u00b7 player vs player", icon: "\u2694\ufe0f", verb: "Post a challenge"},
  cage: {name: "The Cage", icon: "\ud83c\udfe6", verb: ""}
};
var ROULETTE = [0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26];
var REDS = {1: 1, 3: 1, 5: 1, 7: 1, 9: 1, 12: 1, 14: 1, 16: 1, 18: 1, 19: 1, 21: 1, 23: 1, 25: 1, 27: 1, 30: 1, 32: 1, 34: 1, 36: 1};
var SLOT_SYMS = ["cherry", "lemon", "bell", "bar", "star", "gem", "seven"];
var HORSE_SILK = ["#e63946", "#3a86ff", "#ffbe0b", "#2a9d8f", "#8338ec", "#fb5607"];
var BETS = [1, 5, 10, 25, 100, 250, 500];
var DUEL_GAMES = [["highcard", "High card"], ["dice", "Dice duel"], ["coin", "Coin duel"], ["rps", "Rock paper scissors"]];
var DUEL_NAME = {highcard: "High card", dice: "Dice duel", coin: "Coin duel", rps: "Rock paper scissors"};
var RPS_ICON = {rock: "\u270a", paper: "\u270b", scissors: "\u270c\ufe0f"};

/* ---------- what the house says (pure) ---------- */
var ROAST = {
  any: ["The house always wins. Today it didn't even have to try.",
        "That wasn't a bet, it was a donation. The house thanks you for your generosity.",
        "Your chips have been relocated to a better home.",
        "Somewhere, a statistician just sighed.",
        "Financial advisor's notes: \"no.\"",
        "Bold strategy. Let's see if it pays off. (It didn't.)",
        "Those chips are in a better place now. Our vault.",
        "Plot twist: you lost.",
        "If losing were a game, you'd finally be winning.",
        "The odds were never in your favour. They weren't even in the building."],
  streak3: ["{streak} in a row. Consistency is a virtue, I suppose.", "That's {streak} straight. You're really committed to the bit."],
  streak5: ["{streak} losses in a row. We're putting your portrait in the lobby.", "{streak} straight. The machines have started a fan club. For themselves."],
  streak8: ["{streak} in a row. At this point it's not a losing streak, it's a lifestyle.", "{streak} straight losses. The security cameras are rewatching this for fun."],
  big: ["{bet} chips. Gone. We're naming a chandelier after you.", "{bet} chips on one go. Brave. The accountants are popping champagne."],
  slots: ["The reels have spoken, and they said \"lol\".", "Three reels, zero matches, one sad human.", "The machine blinked at you. That's machine for laughing."],
  slotsNear: ["Two {sym}s. The third one saw you coming and said no.", "So close the third {sym} could feel your disappointment."],
  roulette: ["The ball had 37 choices and avoided yours on purpose.", "Round and round it goes, and your chips go with it."],
  rouletteZero: ["Zero. The one pocket that belongs to the house, and it still found you.", "The ball landed on 0. Fitting."],
  rouletteNumber: ["One number out of 37. Brave. Wrong, but brave.", "You picked {pick}. The ball picked {pocket}. The ball has better taste."],
  horses: ["Your horse finished {place}. It says it was pacing itself for next season.", "{horse} came {place}. It stopped to read the documentation."],
  horsesLast: ["{horse} came dead last. Glue factory has entered the chat.", "Last place. {horse} is still running, emotionally."],
  plinko: ["Gravity has never been this disappointed in anyone.", "Twelve rows of pegs and every one of them chose violence."],
  wheel: ["The wheel spun three full turns just to land on nothing for you.", "Nothing. The wheel would like you to know it's not personal."],
  rocket: ["The rocket made it to {crash}x. You wanted {target}x. Houston, you have a problem.", "It blew up at {crash}x. Your {target}x was a beautiful dream."],
  rocketPad: ["It exploded on the launch pad. Like your hopes.", "1.00x. The rocket took one look at your bet and gave up."],
  dice: ["The dice rolled. So did your chips. Away.", "{a} and {b}. The dice are giggling."],
  diceSnake: ["Snake eyes. They're looking at you. And they're judging."],
  scratch: ["You scratched so hard. For a skull.", "Nine squares of absolutely nothing. Beautifully printed, though."],
  scratchNear: ["Two {sym}s! The third one is in another castle."],
  coin: ["50/50 and you still found the wrong 50.", "Heads, tails: the coin chose violence."],
  bust: ["{p}. Just over. Like your confidence.", "Bust. The dealer didn't even have to get out of the chair."],
  dealerBJ: ["Dealer blackjack. It wasn't personal. It was a little personal."],
  bjLose: ["The dealer had {d}, you had {p}. Math is cruel.", "Dealer {d}, you {p}. The dealer would like to thank the academy."],
  duel: ["You lost to {vs}. Not to the house. To a person. Who will remember this.", "{vs} took your chips and didn't even say thanks.",
         "{vs} beat you fair and square. Mostly square.", "Somewhere, {vs} is doing a little victory dance. At your expense."],
  duelRps: ["{vs} read you like a book. A short book. With pictures.", "{them} beats {you}. {vs} saw it coming. Everyone did."]
};
var ARTS = ["stamp", "stonks", "violin", "yacht", "flatline", "tumbleweed"];
var CHEER = {
  push: ["Your chips came back. They missed you. Briefly."],
  small: ["A win! The house is filing a complaint.", "Winner. Don't let it go to your head (it will).", "The house blinked. You won."],
  big: ["Big win! Security is watching you with newfound respect.", "That's a lot of chips. The pit boss just loosened his tie."],
  jackpot: ["JACKPOT! Somebody call the bank. And a lawyer. And your mom."]
};

function fill(t, o){ return String(t).replace(/\{(\w+)\}/g, function(_, k){ return o[k] != null ? String(o[k]) : ""; }); }
function ord(n){ var s = ["th", "st", "nd", "rd"], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }
function at(list, k){ return list[((k | 0) % list.length + list.length) % list.length]; }
// a loss's line and picture: the most specific thing that happened first, then the game, then the house in general;
// a streak or a big bet takes over now and then
function roast(o, k){
  o = o || {}; k = k | 0;
  var r = o.result || {}, g = o.game, v = {bet: o.bet, streak: o.streak}, list = null;
  if(g === "slots"){
    var reels = r.reels || [], cnt = {};
    reels.forEach(function(s){ cnt[s] = (cnt[s] | 0) + 1; });
    var near = ["seven", "gem", "star", "bar"].filter(function(s){ return cnt[s] === 2; })[0];
    if(near){ list = ROAST.slotsNear; v.sym = near; } else list = ROAST.slots;
  } else if(g === "roulette"){
    v.pocket = r.pocket; v.pick = String(r.pick || "").replace(/^n:/, "");
    list = r.pocket === 0 ? ROAST.rouletteZero : /^n:/.test(r.pick || "") ? ROAST.rouletteNumber : ROAST.roulette;
  } else if(g === "horses"){
    var order = r.order || [], place = order.indexOf(r.pick) + 1;
    v.horse = o.horseName || "Your horse"; v.place = ord(place || 6);
    list = place === order.length ? ROAST.horsesLast : ROAST.horses;
  } else if(g === "plinko") list = ROAST.plinko;
  else if(g === "wheel") list = ROAST.wheel;
  else if(g === "rocket"){ v.crash = ((r.crash | 0)/100).toFixed(2); v.target = ((r.target | 0)/100).toFixed(2); list = (r.crash | 0) <= 100 ? ROAST.rocketPad : ROAST.rocket; }
  else if(g === "dice"){ var d = r.dice || [0, 0]; v.a = d[0]; v.b = d[1]; list = d[0] === 1 && d[1] === 1 ? ROAST.diceSnake : ROAST.dice; }
  else if(g === "scratch"){
    var c2 = {}; (r.grid || []).forEach(function(s){ c2[s] = (c2[s] | 0) + 1; });
    var nr = ["crown", "diamond", "horseshoe"].filter(function(s){ return c2[s] === 2; })[0];
    if(nr){ list = ROAST.scratchNear; v.sym = nr; } else list = ROAST.scratch;
  } else if(g === "coin") list = ROAST.coin;
  else if(g === "duel"){ v.vs = o.vs || "your rival"; v.you = r.you; v.them = r.them; list = r.you ? ROAST.duelRps : ROAST.duel; }
  else if(g === "blackjack"){
    var h = r.hand || {}; v.p = h.ptotal; v.d = h.dtotal;
    list = r.outcome === "bust" ? ROAST.bust : r.outcome === "dealer_blackjack" ? ROAST.dealerBJ : ROAST.bjLose;
  }
  var s = o.streak | 0;
  if(s >= 8 && k % 2 === 0) list = ROAST.streak8;
  else if(s >= 5 && k % 3 === 0) list = ROAST.streak5;
  else if(s >= 3 && k % 4 === 0) list = ROAST.streak3;
  else if((o.bet | 0) >= 200 && k % 2 === 1) list = ROAST.big;
  if(!list || k % 5 === 4) list = list && k % 10 === 9 ? ROAST.any : list || ROAST.any;
  var tx = fill(at(list, k), v);
  return {text: tx.charAt(0).toUpperCase() + tx.slice(1), art: at(ARTS, k)};
}
function cheer(o, k){
  o = o || {}; var m = (o.payout | 0)/Math.max(1, o.bet | 0);
  var list = m === 1 ? CHEER.push : m >= 50 ? CHEER.jackpot : m >= 8 ? CHEER.big : CHEER.small;
  return {text: at(list, k), art: m >= 50 ? "jackpot" : m >= 8 ? "big" : m > 1 ? "coins" : "none"};
}

/* ---------- art (canvas 2D) ---------- */
function rr(g, x, y, w, h, r){ g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }
function star(g, x, y, r1, r2, n){ g.beginPath(); for(var i = 0; i < 2*n; i++){ var a = i/(2*n)*TAU - PI/2, r = i % 2 ? r2 : r1; g.lineTo(x + Math.cos(a)*r, y + Math.sin(a)*r); } g.closePath(); }
function symbol(g, sym, x, y, s){
  g.save(); g.translate(x, y); g.lineJoin = "round";
  switch(sym){
    case "cherry":
      g.strokeStyle = "#3a7d2c"; g.lineWidth = s*0.06; g.beginPath(); g.moveTo(-s*0.18, s*0.05); g.quadraticCurveTo(-s*0.05, -s*0.3, s*0.12, -s*0.36); g.moveTo(s*0.2, s*0.08); g.quadraticCurveTo(s*0.14, -s*0.2, s*0.12, -s*0.36); g.stroke();
      [[-s*0.2, s*0.17], [s*0.18, s*0.2]].forEach(function(p){ var gr = g.createRadialGradient(p[0] - s*0.05, p[1] - s*0.06, s*0.02, p[0], p[1], s*0.17); gr.addColorStop(0, "#ff8a8a"); gr.addColorStop(1, "#b5121b"); g.fillStyle = gr; g.beginPath(); g.arc(p[0], p[1], s*0.16, 0, TAU); g.fill(); });
      g.fillStyle = "#4caf50"; g.beginPath(); g.ellipse(s*0.2, -s*0.36, s*0.13, s*0.06, -0.4, 0, TAU); g.fill(); break;
    case "lemon":
      var lg = g.createRadialGradient(-s*0.1, -s*0.1, s*0.03, 0, 0, s*0.36); lg.addColorStop(0, "#fff6a0"); lg.addColorStop(1, "#e3b505");
      g.fillStyle = lg; g.beginPath(); g.ellipse(0, 0, s*0.36, s*0.27, -0.25, 0, TAU); g.fill(); g.strokeStyle = "#a37f00"; g.lineWidth = s*0.025; g.stroke(); break;
    case "bell":
      var bg = g.createLinearGradient(-s*0.3, 0, s*0.3, 0); bg.addColorStop(0, "#b8860b"); bg.addColorStop(0.45, "#ffe27a"); bg.addColorStop(1, "#a9740a");
      g.fillStyle = bg; g.beginPath(); g.moveTo(-s*0.32, s*0.22); g.quadraticCurveTo(-s*0.28, -s*0.36, 0, -s*0.36); g.quadraticCurveTo(s*0.28, -s*0.36, s*0.32, s*0.22); g.closePath(); g.fill();
      g.fillStyle = "#8a5a00"; g.beginPath(); g.arc(0, s*0.28, s*0.07, 0, TAU); g.fill(); g.fillRect(-s*0.36, s*0.18, s*0.72, s*0.06); break;
    case "bar":
      g.fillStyle = "#14141a"; rr(g, -s*0.4, -s*0.2, s*0.8, s*0.4, s*0.06); g.fill(); g.strokeStyle = "#ffd700"; g.lineWidth = s*0.04; g.stroke();
      g.fillStyle = "#fff"; g.font = "900 " + Math.round(s*0.28) + "px Impact, 'Arial Black', sans-serif"; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText("BAR", 0, s*0.01); break;
    case "star":
      var sg = g.createRadialGradient(0, 0, s*0.05, 0, 0, s*0.4); sg.addColorStop(0, "#fff9c4"); sg.addColorStop(1, "#ffb300");
      g.fillStyle = sg; star(g, 0, 0, s*0.4, s*0.17, 5); g.fill(); g.strokeStyle = "#c77c00"; g.lineWidth = s*0.025; g.stroke(); break;
    case "gem": case "diamond":
      g.fillStyle = "#38d6ff"; g.beginPath(); g.moveTo(-s*0.34, -s*0.1); g.lineTo(-s*0.18, -s*0.3); g.lineTo(s*0.18, -s*0.3); g.lineTo(s*0.34, -s*0.1); g.lineTo(0, s*0.36); g.closePath(); g.fill();
      g.fillStyle = "rgba(255,255,255,.55)"; g.beginPath(); g.moveTo(-s*0.18, -s*0.3); g.lineTo(0, -s*0.1); g.lineTo(s*0.18, -s*0.3); g.closePath(); g.fill();
      g.strokeStyle = "#0b6e99"; g.lineWidth = s*0.025; g.beginPath(); g.moveTo(-s*0.34, -s*0.1); g.lineTo(s*0.34, -s*0.1); g.moveTo(0, -s*0.1); g.lineTo(0, s*0.36); g.stroke(); break;
    case "seven":
      g.font = "900 " + Math.round(s*0.85) + "px Impact, 'Arial Black', sans-serif"; g.textAlign = "center"; g.textBaseline = "middle";
      g.lineWidth = s*0.08; g.strokeStyle = "#5a0000"; g.strokeText("7", 0, s*0.04); var sv = g.createLinearGradient(0, -s*0.4, 0, s*0.4); sv.addColorStop(0, "#ff5a5a"); sv.addColorStop(1, "#b30000");
      g.fillStyle = sv; g.fillText("7", 0, s*0.04); break;
    case "coin":
      var cg = g.createRadialGradient(-s*0.1, -s*0.1, s*0.05, 0, 0, s*0.36); cg.addColorStop(0, "#fff3b0"); cg.addColorStop(1, "#d4a017");
      g.fillStyle = cg; g.beginPath(); g.arc(0, 0, s*0.34, 0, TAU); g.fill(); g.strokeStyle = "#9c7409"; g.lineWidth = s*0.04; g.stroke();
      g.fillStyle = "#9c7409"; g.font = "800 " + Math.round(s*0.36) + "px sans-serif"; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText("\u2733", 0, s*0.02); break;
    case "clover":
      g.fillStyle = "#2e9e44"; [0, 1, 2, 3].forEach(function(i){ var a = i*PI/2 + PI/4; g.beginPath(); g.arc(Math.cos(a)*s*0.15, Math.sin(a)*s*0.15 - s*0.04, s*0.15, 0, TAU); g.fill(); });
      g.strokeStyle = "#2e7d32"; g.lineWidth = s*0.05; g.beginPath(); g.moveTo(0, s*0.05); g.quadraticCurveTo(s*0.05, s*0.25, s*0.15, s*0.36); g.stroke(); break;
    case "horseshoe":
      g.strokeStyle = "#9aa3ad"; g.lineWidth = s*0.13; g.lineCap = "round"; g.beginPath(); g.arc(0, -s*0.02, s*0.25, PI*0.85, PI*0.15, false); g.stroke();
      g.fillStyle = "#5f6871"; [-1, 1].forEach(function(sd){ for(var i = 0; i < 3; i++){ var a = PI*(sd < 0 ? 0.95 - i*0.22 : 0.05 + i*0.22); g.beginPath(); g.arc(Math.cos(a)*s*0.25, -s*0.02 - Math.sin(a)*s*0.25, s*0.025, 0, TAU); g.fill(); } }); break;
    case "crown":
      var kg = g.createLinearGradient(0, -s*0.3, 0, s*0.25); kg.addColorStop(0, "#fff176"); kg.addColorStop(1, "#f9a825");
      g.fillStyle = kg; g.beginPath(); g.moveTo(-s*0.36, s*0.22); g.lineTo(-s*0.36, -s*0.18); g.lineTo(-s*0.18, 0); g.lineTo(0, -s*0.3); g.lineTo(s*0.18, 0); g.lineTo(s*0.36, -s*0.18); g.lineTo(s*0.36, s*0.22); g.closePath(); g.fill();
      g.fillStyle = "#e53935"; g.beginPath(); g.arc(0, s*0.08, s*0.06, 0, TAU); g.fill(); break;
    case "skull":
      g.fillStyle = "#eceff1"; g.beginPath(); g.arc(0, -s*0.05, s*0.28, 0, TAU); g.fill(); g.fillRect(-s*0.16, s*0.12, s*0.32, s*0.16);
      g.fillStyle = "#263238"; g.beginPath(); g.arc(-s*0.1, -s*0.05, s*0.07, 0, TAU); g.arc(s*0.1, -s*0.05, s*0.07, 0, TAU); g.fill();
      g.fillRect(-s*0.09, s*0.17, s*0.03, s*0.1); g.fillRect(-s*0.015, s*0.17, s*0.03, s*0.1); g.fillRect(s*0.06, s*0.17, s*0.03, s*0.1); break;
    default:
      g.fillStyle = "#888"; g.beginPath(); g.arc(0, 0, s*0.3, 0, TAU); g.fill();
  }
  g.restore();
}
var SUITS = ["\u2660", "\u2665", "\u2666", "\u2663"], RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
function card(g, c, x, y, w, h, down){
  g.save();
  g.shadowColor = "rgba(0,0,0,.35)"; g.shadowBlur = 8; g.shadowOffsetY = 3;
  rr(g, x, y, w, h, w*0.09); g.fillStyle = down ? "#7b1e2b" : "#fdfdf8"; g.fill(); g.shadowColor = "transparent";
  if(down){
    g.strokeStyle = "#e9c46a"; g.lineWidth = 2; rr(g, x + w*0.08, y + h*0.06, w*0.84, h*0.88, w*0.06); g.stroke();
    g.fillStyle = "rgba(233,196,106,.35)"; for(var i = 0; i < 6; i++) for(var j = 0; j < 9; j++) if((i + j) % 2 === 0) g.fillRect(x + w*0.14 + i*w*0.12, y + h*0.1 + j*h*0.09, w*0.06, h*0.045);
  } else {
    var red = c >= 0 && (Math.floor(c/13) === 1 || Math.floor(c/13) === 2), rk = RANKS[((c % 13) + 13) % 13], st = SUITS[Math.floor(c/13) % 4];
    g.fillStyle = red ? "#c62828" : "#1a1a1a"; g.textAlign = "left"; g.textBaseline = "top";
    g.font = "800 " + Math.round(w*0.26) + "px Georgia, serif"; g.fillText(rk, x + w*0.08, y + h*0.05);
    g.font = Math.round(w*0.22) + "px Georgia, serif"; g.fillText(st, x + w*0.09, y + h*0.05 + w*0.27);
    g.textAlign = "center"; g.textBaseline = "middle"; g.font = Math.round(w*0.55) + "px Georgia, serif"; g.fillText(st, x + w/2, y + h*0.56);
  }
  g.restore();
}
var PIPS = {1: [[0, 0]], 2: [[-1, -1], [1, 1]], 3: [[-1, -1], [0, 0], [1, 1]], 4: [[-1, -1], [1, -1], [-1, 1], [1, 1]], 5: [[-1, -1], [1, -1], [0, 0], [-1, 1], [1, 1]], 6: [[-1, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [1, 1]]};
function die(g, n, x, y, s, rot){
  g.save(); g.translate(x, y); g.rotate(rot || 0);
  g.shadowColor = "rgba(0,0,0,.4)"; g.shadowBlur = 10; g.shadowOffsetY = 4;
  rr(g, -s/2, -s/2, s, s, s*0.18); var dg = g.createLinearGradient(-s/2, -s/2, s/2, s/2); dg.addColorStop(0, "#fff"); dg.addColorStop(1, "#dcdcdc"); g.fillStyle = dg; g.fill();
  g.shadowColor = "transparent"; g.fillStyle = n === 1 ? "#c62828" : "#1a1a1a";
  (PIPS[n] || PIPS[1]).forEach(function(p){ g.beginPath(); g.arc(p[0]*s*0.26, p[1]*s*0.26, s*0.085, 0, TAU); g.fill(); });
  g.restore();
}
// a racehorse running right, its legs on phase ph, its jockey in silk
function horse(g, x, y, s, ph, silk){
  g.save(); g.translate(x, y); g.scale(s, s);
  var body = "#6d4c41", dark = "#3e2723";
  g.strokeStyle = dark; g.lineWidth = 0.09; g.lineCap = "round";
  [[0.28, 0], [0.38, PI], [-0.32, PI*0.5], [-0.22, PI*1.5]].forEach(function(L){
    var a = Math.sin(ph + L[1])*0.55; g.beginPath(); g.moveTo(L[0], 0.12); g.lineTo(L[0] + Math.sin(a)*0.36, 0.12 + Math.cos(a)*0.36); g.stroke(); });
  g.fillStyle = body; g.beginPath(); g.ellipse(0, 0, 0.5, 0.2, 0, 0, TAU); g.fill();
  g.beginPath(); g.moveTo(0.36, -0.06); g.lineTo(0.62, -0.42); g.lineTo(0.78, -0.36); g.lineTo(0.5, 0.06); g.closePath(); g.fill();
  g.beginPath(); g.ellipse(0.74, -0.38, 0.17, 0.08, 0.5, 0, TAU); g.fill();
  g.strokeStyle = dark; g.lineWidth = 0.06; g.beginPath(); g.moveTo(-0.48, -0.06); g.quadraticCurveTo(-0.72, 0.0 + Math.sin(ph*2)*0.06, -0.78, 0.2); g.stroke();
  g.fillStyle = silk; g.beginPath(); g.ellipse(0.08, -0.33, 0.13, 0.15, 0.3, 0, TAU); g.fill();
  g.fillStyle = "#f1c27d"; g.beginPath(); g.arc(0.16, -0.52, 0.08, 0, TAU); g.fill();
  g.fillStyle = silk; g.beginPath(); g.arc(0.16, -0.55, 0.085, PI, TAU); g.fill();
  g.restore();
}

/* ---------- sound (synthesised; quiet when the page is muted) ---------- */
function sound(audio){
  function tone(f, t0, dur, type, vol, f2){
    var A = audio && audio(); if(!A) return;
    try {
      var ac = A.ctx, o = ac.createOscillator(), gn = ac.createGain(), t = ac.currentTime + (t0 || 0);
      o.type = type || "sine"; o.frequency.setValueAtTime(f, t); if(f2) o.frequency.exponentialRampToValueAtTime(f2, t + dur);
      gn.gain.setValueAtTime(0.0001, t); gn.gain.exponentialRampToValueAtTime(vol || 0.15, t + 0.012); gn.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(gn); gn.connect(A.out); o.start(t); o.stop(t + dur + 0.02);
    } catch(e){}
  }
  return {
    tick: function(){ tone(1800, 0, 0.03, "square", 0.04); },
    win: function(big){ (big ? [523, 659, 784, 1047, 1319, 1568] : [659, 784, 1047]).forEach(function(f, i){ tone(f, i*0.09, 0.22, "triangle", 0.16); }); },
    // the sad trombone: four notes, sliding down, the last one long and wobbling
    lose: function(){ [[392, 0, 0.32], [370, 0.36, 0.32], [349, 0.72, 0.32], [330, 1.08, 0.9]].forEach(function(n, i){ tone(n[0], n[1], n[2], "sawtooth", 0.07, i === 3 ? 290 : n[0]*0.985); }); },
    chip: function(){ tone(2400, 0, 0.05, "triangle", 0.06); tone(3200, 0.03, 0.05, "triangle", 0.04); },
    boom: function(){ tone(90, 0, 0.6, "sawtooth", 0.18, 40); },
    quack: function(){ tone(560, 0, 0.12, "square", 0.08, 380); tone(520, 0.14, 0.16, "square", 0.08, 340); }
  };
}

/* ---------- the panel ---------- */
var OWN = ".hqcasino";
function owns(e){ return !!(e && e.target && e.target.closest && e.target.closest(OWN)); }
function ease(t){ t = Math.max(0, Math.min(1, t)); return 1 - Math.pow(1 - t, 3); }
function fmt(n){ n = n | 0; return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ","); }

function mount(stage, opts){
  opts = opts || {};
  var doc = typeof document !== "undefined" ? document : null; if(!doc || !stage) return null;
  var calm = typeof opts.calm === "function" ? opts.calm : function(){ return false; };
  var snd = sound(opts.audio);
  var listeners = [], open = false, game = "slots", busy = false, me = null, chips = null, bet = 10, k = 0, raf = 0, dead = false;
  var pick = {roulette: "red", horses: 0, rocket: 200, dice: "over", coin: "heads"}, bj = null, scratchState = null;
  var duelPick = {game: "highcard", move: "rock"}, D = null, seen = null, lastPoll = -99, duelShow = null;
  function mk(tag, cls, parent, text){ var n = doc.createElement(tag); if(cls) n.className = cls; if(text != null) n.textContent = text; if(parent) parent.appendChild(n); return n; }
  function on(n, ev, fn){ n.addEventListener(ev, fn); listeners.push([n, ev, fn]); }

  var root = mk("div", "hqcasino", stage); root.hidden = true; root.setAttribute("role", "dialog"); root.setAttribute("aria-label", "Casino game");
  var head = mk("div", "hqcasino-head", root);
  var title = mk("div", "hqcasino-title", head);
  var wallet = mk("div", "hqcasino-wallet", head); wallet.setAttribute("aria-live", "polite");
  var closeBtn = mk("button", "hqcasino-close", head, "\u2715"); closeBtn.type = "button"; closeBtn.setAttribute("aria-label", "Leave the table");
  var stageBox = mk("div", "hqcasino-stage", root);
  var cv = mk("canvas", "hqcasino-canvas", stageBox); cv.setAttribute("aria-hidden", "true");
  var g = cv.getContext("2d");
  var banner = mk("div", "hqcasino-banner", stageBox); banner.setAttribute("role", "status"); banner.setAttribute("aria-live", "polite");
  var controls = mk("div", "hqcasino-controls", root);
  var betRow = mk("div", "hqcasino-bets", controls);
  var picks = mk("div", "hqcasino-picks", controls);
  var actions = mk("div", "hqcasino-actions", controls);
  var foot = mk("div", "hqcasino-foot", root);
  var W = 760, H = 400;

  /* the canvas: device pixels, drawn every frame while open */
  function fit(){ var r = Math.min(2, G.devicePixelRatio || 1); cv.width = W*r; cv.height = H*r; g.setTransform(r, 0, 0, r, 0, 0); }
  fit();

  /* the wallet */
  function showWallet(){ wallet.textContent = chips == null ? "\u2026" : "\ud83e\ude99 " + fmt(chips) + " chips" + (me ? "  \u00b7  " + fmt(me.coins) + " Poke Coins" : ""); }
  function refresh(){
    if(!opts.get) return Promise.resolve(null);
    return opts.get("/api/arena/casino/me").then(function(j){ if(j && typeof j === "object" && j.chips != null){ me = j; chips = j.chips | 0; showWallet(); } return j; }, function(){ return null; });
  }
  function say(t, kind){ banner.textContent = t || ""; banner.className = "hqcasino-banner" + (kind ? " " + kind : ""); if(t && opts.announce) opts.announce(t); }

  /* the bet chips */
  function betUi(){
    betRow.textContent = "";
    if(game === "cage"){ betRow.hidden = true; return; } betRow.hidden = false;
    mk("span", "hqcasino-lbl", betRow, "Bet");
    BETS.forEach(function(b){
      var bt = mk("button", "hqcasino-chip" + (b === bet ? " on" : ""), betRow, String(b)); bt.type = "button"; bt.setAttribute("aria-pressed", String(b === bet));
      on(bt, "click", function(){ if(busy) return; bet = b; snd.chip(); betUi(); });
    });
  }
  function btn(parent, text, fn, cls){ var b = mk("button", "hqcasino-btn" + (cls ? " " + cls : ""), parent, text); b.type = "button"; on(b, "click", fn); return b; }
  function seg(parent, items, cur, set){
    var row = mk("div", "hqcasino-seg", parent);
    items.forEach(function(it){ var b = mk("button", "hqcasino-opt" + (it[0] === cur ? " on" : ""), row, it[1]); b.type = "button"; b.setAttribute("aria-pressed", String(it[0] === cur));
      on(b, "click", function(){ if(busy) return; set(it[0]); snd.chip(); render(); }); });
    return row;
  }

  /* each game's controls */
  function render(){
    var I = GAMES[game] || GAMES.slots;
    title.textContent = I.icon + "  " + I.name;
    betUi(); picks.textContent = ""; actions.textContent = ""; foot.textContent = "";
    var T = me && me.tables;
    if(game === "roulette"){
      seg(picks, [["red", "Red"], ["black", "Black"], ["odd", "Odd"], ["even", "Even"], ["low", "1-18"], ["high", "19-36"]], pick.roulette, function(v){ pick.roulette = v; });
      seg(picks, [["dozen1", "1st 12"], ["dozen2", "2nd 12"], ["dozen3", "3rd 12"], ["col1", "Col 1"], ["col2", "Col 2"], ["col3", "Col 3"]], pick.roulette, function(v){ pick.roulette = v; });
      var nr = mk("label", "hqcasino-num", picks, "Straight up ");
      var ni = mk("input", null, nr); ni.type = "number"; ni.min = "0"; ni.max = "36"; ni.value = /^n:/.test(pick.roulette) ? pick.roulette.slice(2) : ""; ni.placeholder = "0-36";
      on(ni, "change", function(){ var n = Math.max(0, Math.min(36, ni.value | 0)); ni.value = String(n); pick.roulette = "n:" + n; render(); });
      foot.textContent = "Even money on colours and halves, 2:1 on dozens and columns, 35:1 straight up. Single zero.";
    } else if(game === "horses"){
      var hs = (T && T.horses) || [];
      seg(picks, hs.map(function(h, i){ return [i, (i + 1) + ". " + h.name + "  " + (h.tenths/10).toFixed(1) + "x"]; }), pick.horses, function(v){ pick.horses = v; }).classList.add("hqcasino-horses");
      foot.textContent = "Pick a winner. The favourite pays least.";
    } else if(game === "rocket"){
      var rl = mk("label", "hqcasino-num", picks, "Cash out at ");
      var ri = mk("input", null, rl); ri.type = "number"; ri.min = "1.01"; ri.max = "100"; ri.step = "0.01"; ri.value = (pick.rocket/100).toFixed(2);
      on(ri, "change", function(){ var v = Math.round(Math.max(1.01, Math.min(100, +ri.value || 2))*100); pick.rocket = v; ri.value = (v/100).toFixed(2); });
      mk("span", null, rl, "x");
      seg(picks, [[150, "1.5x"], [200, "2x"], [500, "5x"], [1000, "10x"], [5000, "50x"]], pick.rocket, function(v){ pick.rocket = v; });
      foot.textContent = "The rocket climbs until it crashes. Reach your cash-out first and you're paid that much.";
    } else if(game === "dice"){
      seg(picks, [["over", "Over 7 \u00b7 2.3x"], ["under", "Under 7 \u00b7 2.3x"], ["seven", "Seven \u00b7 5.7x"], ["doubles", "Doubles \u00b7 5.7x"]], pick.dice, function(v){ pick.dice = v; });
    } else if(game === "coin"){
      seg(picks, [["heads", "Heads \u2733"], ["tails", "Tails \ud83c\udfb2"]], pick.coin, function(v){ pick.coin = v; });
      foot.textContent = "Pays 1.94x. The coin has no memory. Unlike us.";
    } else if(game === "slots"){
      foot.textContent = "Three of a kind: cherries 8x, lemons 10x, bells 15x, BARs 25x, stars 60x, gems 150x, sevens 500x. Two cherries 3x.";
    } else if(game === "plinko"){
      foot.textContent = "Twelve rows of pegs. The edges pay big, the middle\u2026 doesn't.";
    } else if(game === "wheel"){
      foot.textContent = "Fifty segments: 1.5x, 2x, 3x, 5x, 6x and a lot of nothing.";
    } else if(game === "scratch"){
      foot.textContent = "Match three: coins 1x, clovers 2x, horseshoes 5x, diamonds 20x, crowns 100x. Drag to scratch.";
    }
    if(game === "blackjack"){
      var live = bj && !bj.done;
      if(!live) btn(actions, "Deal", function(){ bjMove("deal"); }, "go");
      else {
        btn(actions, "Hit", function(){ bjMove("hit"); }, "go");
        btn(actions, "Stand", function(){ bjMove("stand"); });
        if(bj.hand && bj.hand.can_double) btn(actions, "Double", function(){ bjMove("double"); });
      }
      foot.textContent = "Blackjack pays 3:2. The dealer stands on all 17s. Double on your first two cards.";
    } else if(game === "cage") cageUi();
    else if(game === "duel") duelUi();
    if(game !== "blackjack" && game !== "cage" && game !== "duel"){
      var go = btn(actions, (GAMES[game].verb || "Play") + "  \u00b7  " + bet, play, "go"); go.disabled = busy;
      if(game === "scratch" && scratchState && !scratchState.done) btn(actions, "Reveal all", function(){ revealAll(); });
    }
    if(T && T.rtp && T.rtp[game] != null) foot.textContent += "  Returns " + T.rtp[game] + "% on average.";
    showWallet();
  }

  /* the duel table: post a challenge, take someone's, see how yours went */
  function duelUi(){
    var make = mk("div", "hqcasino-cage", picks);
    mk("div", "hqcasino-lbl", make, "Post a challenge at your bet; anyone in any casino can take it. The winner takes the pot less 5%.");
    seg(make, DUEL_GAMES, duelPick.game, function(v){ duelPick.game = v; });
    if(duelPick.game === "rps") seg(make, [["rock", "✊ Rock"], ["paper", "✋ Paper"], ["scissors", "✌️ Scissors"]], duelPick.move, function(v){ duelPick.move = v; });
    btn(make, "Post a challenge · " + bet, function(){ duel({action: "open", game: duelPick.game, bet: bet, move: duelPick.game === "rps" ? duelPick.move : null}); }, "go");
    var open = mk("div", "hqcasino-cage", picks);
    var list = (D && D.open) || [];
    mk("div", "hqcasino-lbl", open, list.length ? "Open challenges" : "No open challenges. Post one and wait for a brave soul.");
    list.slice(0, 8).forEach(function(c){
      var row = mk("div", "hqcasino-duel", open);
      mk("span", null, row, (c.mine ? "You" : c.by) + "  ·  " + (DUEL_NAME[c.game] || c.game) + "  ·  " + fmt(c.bet) + " chips");
      if(c.mine) btn(row, "Cancel", function(){ duel({action: "cancel", id: c.id}); });
      else btn(row, c.game === "rps" ? "Take it with " + RPS_ICON[duelPick.move] : "Take it", function(){
        if(c.game === "rps" && duelPick.game !== "rps"){ duelPick.game = "rps"; render(); say("Pick your move above, then take it.", ""); return; }
        duel({action: "join", id: c.id, move: c.game === "rps" ? duelPick.move : null}, c); }, "go");
    });
    var mine = (D && D.mine) || [];
    if(mine.length){
      var hist = mk("div", "hqcasino-cage", picks); mk("div", "hqcasino-lbl", hist, "Your duels");
      mine.slice(0, 5).forEach(function(m){ mk("div", "hqcasino-duel " + (m.won ? "won" : m.draw || m.state !== "settled" ? "" : "lost"), hist,
        (DUEL_NAME[m.game] || m.game) + " · " + fmt(m.bet) + " · " + (m.state === "settled" ? (m.draw ? "draw with " : m.won ? "beat " : "lost to ") + m.vs : m.state)); });
    }
    foot.textContent = "Chance duels are drawn by the Arena; in rock paper scissors both moves stay hidden until it's settled. A draw hands both stakes back.";
  }
  function duel(body, c){
    if(busy || !opts.post) return; busy = true; say("");
    if(body.move == null) delete body.move;
    opts.post("/api/arena/casino/duel", body).then(function(r){
      busy = false;
      var j = r && r.j || {};
      if(!r || !r.ok){ say(r && r.status === 402 ? "Not enough chips. The cage takes Poke Coins." : (j.detail || j.error || "The duel table is busy."), "bad"); pollDuels(true); return; }
      chips = j.chips | 0; showWallet();
      if(body.action === "open"){ snd.chip(); say("Challenge posted. Now we wait for someone brave (or foolish).", ""); }
      else if(body.action === "cancel"){ say("Challenge withdrawn. Your chips are back. Coward. (Kidding.)", ""); }
      else { seen = seen || {}; seen[j.id] = 1; showDuel({game: j.game, bet: j.bet, result: j.result, won: j.won, draw: j.draw, vs: j.by, mine: false, prize: j.prize}); }
      pollDuels(true);
    }, function(){ busy = false; say("The duel table is busy.", "bad"); });
  }
  // a settled duel on the table: the draw animated, then the verdict
  function showDuel(m){
    duelShow = {m: m, t0: now(), done: false};
    if(game !== "duel" && open) return;
  }
  function verdict(m){
    k++;
    var you = m.result && (m.mine ? m.result.owner : m.result.taker), them = m.result && (m.mine ? m.result.taker : m.result.owner);
    if(m.draw){ say("A draw with " + m.vs + ". Both stakes back. Nobody's happy.", ""); return; }
    if(m.won){ say("You beat " + m.vs + "! +" + fmt((m.prize || m.bet*2) - m.bet) + " chips. Be gracious. Or don't.", "good"); A.fx = "coins"; A.fxT = now(); snd.win(false); }
    else { var rs = roast({game: "duel", bet: m.bet, streak: 0, vs: m.vs, result: m.game === "rps" ? {you: you, them: them} : {}}, k); say(rs.text, "bad"); A.fx = rs.art; A.fxT = now(); snd.lose(); }
  }
  // the duels: polled while you are in the casino, so you hear when someone takes your challenge
  function pollDuels(now2){
    if(!opts.get) return;
    lastPoll = now();
    opts.get("/api/arena/casino/duels").then(function(j){
      if(!j || !j.open) return;
      var first = !seen; seen = seen || {}; D = j;
      (j.mine || []).forEach(function(m){
        if(seen[m.id]) return; seen[m.id] = 1;
        if(first || m.state !== "settled" || !m.mine) return;
        var msg = m.draw ? m.vs + " took your " + (DUEL_NAME[m.game] || "duel") + ": a draw, stakes back." : m.won ? m.vs + " took your " + (DUEL_NAME[m.game] || "duel") + " challenge, and lost! +" + fmt(Math.round(m.bet*0.9)) + " chips." : m.vs + " took your " + (DUEL_NAME[m.game] || "duel") + " challenge and won. Ouch.";
        if(opts.notify) opts.notify(msg);
        if(open && game === "duel") showDuel({game: m.game, bet: m.bet, result: m.result, won: m.won, draw: m.draw, vs: m.vs, mine: true});
        refresh();
      });
      if(open && game === "duel" && !busy) render();
    }, function(){});
  }

  /* the cage */
  function cageUi(){
    var coins = me ? me.coins | 0 : 0, cap = me ? me.coin_cap | 0 : 30, rate = me ? me.rate | 0 : 10;
    var buy = mk("div", "hqcasino-cage", picks);
    mk("div", "hqcasino-lbl", buy, "Buy chips: " + rate + " chips a Poke Coin");
    [1, 5, 10].concat(coins > 10 ? [coins] : []).forEach(function(n){ if(n > coins) return;
      btn(buy, n === coins && n > 10 ? "All " + n + " coins" : n + (n === 1 ? " coin" : " coins"), function(){ cage("buy", n); }); });
    var cash = mk("div", "hqcasino-cage", picks);
    var room = Math.max(0, cap - coins), most = Math.min(Math.floor((chips | 0)/rate), room)*rate;
    mk("div", "hqcasino-lbl", cash, "Cash out: your wallet holds " + cap + " coins, so up to " + fmt(most) + " chips now");
    [10, 50, 100].concat(most > 100 ? [most] : []).forEach(function(n){ if(n > most) return;
      btn(cash, n === most && n > 100 ? "All that fits (" + fmt(n) + ")" : fmt(n) + " chips", function(){ cage("cash", n); }); });
    foot.textContent = "Chips are yours until you cash them. A win too big for your wallet stays on the rack, never lost.";
  }
  function cage(dir, n){
    if(busy || !opts.post) return; busy = true; say("The cashier counts\u2026");
    opts.post("/api/arena/casino/cage", {dir: dir, n: n}).then(function(r){
      busy = false;
      var j = r && r.j || {};
      if(!r || !r.ok){ say(j.detail || j.error || "The cage is closed right now.", "bad"); return; }
      chips = j.chips | 0; if(me) me.coins = j.coins | 0;
      snd.chip(); say(dir === "buy" ? "Here are your chips. Play nice." : "Cashed out. Smart. Suspiciously smart.", "good");
      refresh().then(render); render();
    }, function(){ busy = false; say("The cage is closed right now.", "bad"); });
  }

  /* a play: the Arena draws it, we animate it, then we have opinions */
  var A = {t0: 0, game: null, j: null, done: true, fx: null, fxT: 0};
  function play(){
    if(busy || !opts.post) return;
    if(game === "scratch" && scratchState && !scratchState.done){ revealAll(); return; }
    busy = true; say(""); A.fx = null; render();
    var body = {game: game, bet: bet};
    if(pick[game] != null) body.pick = pick[game];
    opts.post("/api/arena/casino/play", body).then(function(r){
      var j = r && r.j || {};
      if(!r || !r.ok){ busy = false; say(r && r.status === 402 ? "Not enough chips. The cage takes Poke Coins." : (j.detail || j.error || "The table's busy. Try again."), "bad"); render(); return; }
      chips = (j.chips | 0) - (j.payout | 0);      // shown at the stake until it lands
      showWallet(); start(j);
    }, function(){ busy = false; say("The table's busy. Try again.", "bad"); render(); });
  }
  function start(j){
    A.t0 = now(); A.game = game; A.j = j; A.done = false;
    A.dur = calm() ? 0.4 : {slots: 2.6, roulette: 5.2, horses: 10.5, plinko: 3.2, wheel: 5, rocket: 0, dice: 1.6, scratch: 0, coin: 2.2}[game] || 2;
    if(game === "rocket"){ var c = Math.max(100, A.j.result.crash | 0)/100; A.dur = calm() ? 0.4 : Math.min(9, 1.2 + Math.log(c)/0.32); }
    if(game === "slots") A.slots = (A.j.result.reels || []).map(function(s, i){ var from = A.slotsAt ? A.slotsAt[i] : 0, to = SLOT_SYMS.indexOf(s); return {from: from, dist: (6 + i*2)*7 + ((to - (from % 7) + 7) % 7)}; });
    if(game === "scratch"){ scratchState = {grid: A.j.result.grid || [], done: false, cover: null}; A.dur = 0; render(); busy = false; return; }
    if(game === "horses") A.race = racePlan(A.j.result);
  }
  function finish(){
    A.done = true; busy = false;
    var j = A.j, o = {game: A.game, bet: j.bet, payout: j.payout, streak: j.streak, result: j.result || j};
    if(A.game === "horses"){ var hs = me && me.tables && me.tables.horses; o.horseName = hs && hs[j.result.pick] ? hs[j.result.pick].name : null; }
    chips = j.chips | 0; showWallet(); k++;
    if((j.payout | 0) > (j.bet | 0) || ((j.payout | 0) === (j.bet | 0) && j.payout > 0)){
      var c = cheer(o, k); say(c.text + "  +" + fmt(j.payout - j.bet) + " chips", "good"); A.fx = c.art; A.fxT = now();
      if(c.art !== "none") snd.win(c.art !== "coins");
    } else {
      var rs = roast(o, k); say(rs.text, "bad"); A.fx = rs.art; A.fxT = now(); snd.lose();
    }
    if(opts.onResult) opts.onResult(A.game, j);
    if(me && me.stats){ me.stats.plays++; me.stats.streak = j.streak | 0; }
    render();
  }

  /* blackjack: one hand at a time, kept on the Arena */
  function bjMove(action){
    if(busy || !opts.post) return; busy = true; say("");
    opts.post("/api/arena/casino/blackjack", action === "deal" ? {action: "deal", bet: bet} : {action: action}).then(function(r){
      busy = false;
      var j = r && r.j || {};
      if(!r || !r.ok){ say(r && r.status === 402 ? "Not enough chips. The cage takes Poke Coins." : (j.detail || j.error || "The dealer is shuffling. Try again."), "bad"); render(); return; }
      var prev = bj; bj = j; bj.at = now(); bj.prevN = prev && !prev.done && prev.hand ? prev.hand.player.length + prev.hand.dealer.length : 0;
      chips = j.chips | 0; showWallet();
      if(j.done){
        k++;
        var o = {game: "blackjack", bet: j.hand.bet, payout: j.payout, streak: j.streak, result: j};
        if((j.payout | 0) > (j.hand.bet | 0)){ var c = cheer(o, k); say((j.outcome === "blackjack" ? "Blackjack! " : "") + c.text + "  +" + fmt(j.payout - j.hand.bet) + " chips", "good"); A.fx = j.outcome === "blackjack" ? "big" : "coins"; A.fxT = now(); snd.win(j.outcome === "blackjack"); }
        else if((j.payout | 0) === (j.hand.bet | 0)){ say("Push. Nobody wins, nobody cries.", ""); }
        else { var rs = roast(o, k); say(rs.text, "bad"); A.fx = rs.art; A.fxT = now(); snd.lose(); }
        if(opts.onResult) opts.onResult("blackjack", j);
      } else snd.chip();
      render();
    }, function(){ busy = false; say("The dealer is shuffling. Try again.", "bad"); render(); });
  }

  /* the scratch card: drag to scratch, cells reveal as they are mostly clear */
  function revealAll(){ if(!scratchState || scratchState.done) return; scratchState.reveal = now(); }
  var scratching = false;
  function scratchAt(e){
    if(!scratchState || scratchState.done || !scratchState.cover) return;
    var r = cv.getBoundingClientRect(), x = (e.clientX - r.left)/r.width*W, y = (e.clientY - r.top)/r.height*H, cg = scratchState.cover.getContext("2d");
    cg.globalCompositeOperation = "destination-out"; cg.beginPath(); cg.arc(x - SC.x, y - SC.y, 18, 0, TAU); cg.fill();
    scratchState.dirty = true; if(k % 3 === 0) snd.tick();
  }
  on(cv, "pointerdown", function(e){ if(game !== "scratch") return; scratching = true; cv.setPointerCapture(e.pointerId); scratchAt(e); });
  on(cv, "pointermove", function(e){ if(scratching) scratchAt(e); });
  on(cv, "pointerup", function(){ scratching = false; });

  /* drawing */
  function now(){ return (typeof performance !== "undefined" ? performance.now() : Date.now())/1000; }
  function felt(c1, c2){ var gr = g.createRadialGradient(W/2, H*0.45, 40, W/2, H/2, W*0.7); gr.addColorStop(0, c1); gr.addColorStop(1, c2); g.fillStyle = gr; g.fillRect(0, 0, W, H); }
  function text(t, x, y, size, col, align, weight){ g.font = (weight || 700) + " " + size + "px system-ui, -apple-system, 'Segoe UI', sans-serif"; g.fillStyle = col; g.textAlign = align || "center"; g.textBaseline = "middle"; g.fillText(t, x, y); }
  function u(){ return A.done ? 1 : Math.min(1, (now() - A.t0)/Math.max(0.001, A.dur)); }

  function drawSlots(t){
    felt("#4a0d1a", "#1a0208");
    rr(g, 120, 50, 520, 280, 26); var fr = g.createLinearGradient(0, 50, 0, 330); fr.addColorStop(0, "#ffe082"); fr.addColorStop(0.5, "#b8860b"); fr.addColorStop(1, "#ffd54f"); g.fillStyle = fr; g.fill();
    rr(g, 140, 70, 480, 240, 18); g.fillStyle = "#120006"; g.fill();
    var p = A.game === "slots" && A.slots ? A.slots : null, uu = u();
    for(var i = 0; i < 3; i++){
      var x = 150 + i*156, pos;
      if(p){ var di = Math.min(1, (now() - A.t0)/Math.max(0.001, A.dur*(0.55 + 0.22*i))); pos = p[i].from + p[i].dist*(A.done ? 1 : ease(di)); }
      else pos = A.slotsAt ? A.slotsAt[i] : i*2;
      if(A.done && p){ A.slotsAt = A.slotsAt || [0, 0, 0]; A.slotsAt[i] = Math.round(pos) % 7; }
      g.save(); rr(g, x, 80, 148, 220, 12); g.clip();
      var rg = g.createLinearGradient(0, 80, 0, 300); rg.addColorStop(0, "#bdbdbd"); rg.addColorStop(0.18, "#fff"); rg.addColorStop(0.82, "#fff"); rg.addColorStop(1, "#bdbdbd"); g.fillStyle = rg; g.fillRect(x, 80, 148, 220);
      var base = Math.floor(pos), frac = pos - base;
      for(var r = -2; r <= 2; r++){ var sym = SLOT_SYMS[(((base + r) % 7) + 7) % 7]; symbol(g, sym, x + 74, 190 + (r - frac)*84, 74); }
      g.restore();
      // a tick each time a symbol passes the window
      if(!A.done && p){ A.slotTick = A.slotTick || []; if(A.slotTick[i] !== base){ A.slotTick[i] = base; snd.tick(); } }
    }
    g.strokeStyle = "rgba(255,40,80,.85)"; g.lineWidth = 3; g.beginPath(); g.moveTo(140, 190); g.lineTo(620, 190); g.stroke();
    var lit = Math.floor(t*6) % 2;
    for(var b = 0; b < 26; b++){ var bx = 130 + b*20; g.fillStyle = (b + lit) % 2 ? "#fff59d" : "#ff7043"; g.beginPath(); g.arc(bx, 60, 4, 0, TAU); g.arc(bx, 320, 4, 0, TAU); g.fill(); }
    text("THE LUCKY BYTE", W/2, 360, 22, "#ffd54f", "center", 900);
    if(uu >= 1 && !A.done && A.game === "slots") finish();
  }
  function drawRoulette(t){
    felt("#0d5c3a", "#06301e");
    var cx = 230, cy = 200, R = 160, uu = u(), res = A.game === "roulette" && A.j ? A.j.result : null;
    var p = res ? ROULETTE.indexOf(res.pocket) : 0, seg2 = TAU/37;
    var wa = (A.wheel0 || 0) + (res ? (A.done ? 1 : ease(uu))*TAU*3 : t*0.15);
    if(A.done && res) A.wheel0 = wa % TAU;
    // the wheel: rim, pockets, numbers, the turret
    g.save(); g.translate(cx, cy);
    g.fillStyle = "#4e2a14"; g.beginPath(); g.arc(0, 0, R + 18, 0, TAU); g.fill();
    g.fillStyle = "#c9a227"; g.beginPath(); g.arc(0, 0, R + 4, 0, TAU); g.fill();
    for(var i = 0; i < 37; i++){
      var a0 = wa + i*seg2 - PI/2, n = ROULETTE[i];
      g.fillStyle = n === 0 ? "#1b8a3e" : REDS[n] ? "#c62828" : "#141414";
      g.beginPath(); g.moveTo(0, 0); g.arc(0, 0, R, a0, a0 + seg2); g.closePath(); g.fill();
      g.save(); g.rotate(a0 + seg2/2); g.fillStyle = "#fff"; g.font = "700 12px system-ui"; g.textAlign = "center"; g.textBaseline = "middle"; g.translate(R - 16, 0); g.rotate(PI/2); g.fillText(String(n), 0, 0); g.restore();
    }
    g.fillStyle = "#3e2412"; g.beginPath(); g.arc(0, 0, R*0.55, 0, TAU); g.fill();
    var tg = g.createRadialGradient(-10, -10, 4, 0, 0, R*0.3); tg.addColorStop(0, "#fff3c4"); tg.addColorStop(1, "#b8860b"); g.fillStyle = tg; g.beginPath(); g.arc(0, 0, R*0.22, 0, TAU); g.fill();
    for(var s2 = 0; s2 < 4; s2++){ g.save(); g.rotate(wa + s2*PI/2); g.fillStyle = "#d4af37"; g.fillRect(-4, -R*0.5, 8, R*0.3); g.restore(); }
    // the ball: round the rim the other way, spiralling into its pocket
    if(res){
      var ba = A.done ? wa + p*seg2 + seg2/2 - PI/2 : -(1 - ease(uu))*TAU*5 + (wa + p*seg2 + seg2/2 - PI/2), br = A.done || uu > 0.7 ? R - 30 : R + 2 - (uu > 0.55 ? (uu - 0.55)/0.15*32 : 0);
      g.fillStyle = "#fafafa"; g.beginPath(); g.arc(Math.cos(ba)*br, Math.sin(ba)*br, 7, 0, TAU); g.fill();
    }
    g.restore();
    // the board
    text("YOUR BET", 560, 70, 15, "#e8f5e9", "center", 800);
    var pk = pick.roulette, lab = {red: "Red", black: "Black", odd: "Odd", even: "Even", low: "1-18", high: "19-36", dozen1: "1st 12", dozen2: "2nd 12", dozen3: "3rd 12", col1: "Column 1", col2: "Column 2", col3: "Column 3"}[pk] || ("Number " + pk.replace("n:", ""));
    rr(g, 470, 90, 180, 60, 12); g.fillStyle = "rgba(0,0,0,.3)"; g.fill(); text(lab, 560, 120, 24, "#ffd54f", "center", 900);
    if(res && A.done){ rr(g, 480, 190, 160, 110, 14); g.fillStyle = res.color === "red" ? "#c62828" : res.color === "green" ? "#1b8a3e" : "#141414"; g.fill(); text(String(res.pocket), 560, 245, 56, "#fff", "center", 900); }
    if(uu >= 1 && !A.done && A.game === "roulette") finish();
  }
  // a race the Arena's order decides: each runner's finish time by its place, a pace with a personality on top
  function racePlan(res){
    var order = res.order || [0, 1, 2, 3, 4, 5], seed = res.seed >>> 0 || 1, rnd = function(){ seed = (seed*1664525 + 1013904223) >>> 0; return seed/4294967296; };
    var plan = [];
    order.forEach(function(hz, place){ plan[hz] = {T: 8.2 + place*0.32 + rnd()*0.12, a: (rnd() - 0.5)*0.22, b: 1 + rnd()*2.5, ph: rnd()*TAU, place: place}; });
    return plan;
  }
  function raceX(P, t){ if(t >= P.T) return 1 + (t - P.T)*0.02; var x = t/P.T; return Math.max(0, x + P.a*Math.sin(PI*x)*Math.sin(P.b*PI*x)); }
  function drawHorses(t){
    var gr = g.createLinearGradient(0, 0, 0, H); gr.addColorStop(0, "#8fd3ff"); gr.addColorStop(0.22, "#d7f0ff"); gr.addColorStop(0.24, "#3c8d2f"); gr.addColorStop(1, "#2a6a20"); g.fillStyle = gr; g.fillRect(0, 0, W, H);
    for(var c = 0; c < 8; c++){ g.fillStyle = "rgba(255,255,255,.7)"; g.beginPath(); g.ellipse(((c*137 - t*14) % (W + 200) + W + 200) % (W + 200) - 100, 30 + (c % 3)*14, 40, 10, 0, 0, TAU); g.fill(); }
    var lanes = 6, top = 110, lh = 46, x0 = 60, x1 = W - 70, hs = (me && me.tables && me.tables.horses) || [];
    g.fillStyle = "#b5895a"; g.fillRect(0, top - 14, W, lanes*lh + 18);
    for(var l = 0; l <= lanes; l++){ g.fillStyle = "#fff"; g.fillRect(0, top - 12 + l*lh, W, 2); }
    for(var q = 0; q < 12; q++) for(var r = 0; r < 2; r++){ g.fillStyle = (q + r) % 2 ? "#111" : "#fff"; g.fillRect(x1 + 30 + r*8, top - 12 + q*(lanes*lh)/12, 8, (lanes*lh)/12); }
    var racing = A.game === "horses" && A.race, rt = racing ? (A.done ? 99 : (now() - A.t0)*(calm() ? 20 : 1)) : 0, lead = -1, best = -1;
    for(var i = 0; i < lanes; i++){
      var P = racing ? A.race[i] : null, xx = P ? raceX(P, rt) : 0, px = x0 + Math.min(1.04, xx)*(x1 - x0), py = top + i*lh + 12;
      if(P && xx > best && rt < 99){ best = xx; lead = i; }
      horse(g, px, py, 40, racing && (!P || rt < P.T + 1) ? t*14 + i : 0, HORSE_SILK[i]);
      g.fillStyle = HORSE_SILK[i]; rr(g, 6, py - 12, 44, 22, 6); g.fill(); text(String(i + 1), 28, py - 1, 14, "#fff", "center", 900);
      if(pick.horses === i){ g.strokeStyle = "#ffd54f"; g.lineWidth = 3; rr(g, 4, py - 14, 48, 26, 7); g.stroke(); }
      if(racing && A.done) text(ord(P.place + 1), px - 38, py - 16, 12, "#fff", "center", 900);
    }
    var call = racing ? (A.done ? (hs[A.j.result.order[0]] ? hs[A.j.result.order[0]].name + " wins it!" : "") : lead >= 0 && hs[lead] ? hs[lead].name + (rt < 3 ? " breaks well!" : rt < 6 ? " leads the field!" : " in front at the line\u2026") : "") : "Pick a runner and start the race";
    rr(g, 140, 60, 480, 34, 10); g.fillStyle = "rgba(0,0,0,.55)"; g.fill(); text(call, W/2, 77, 17, "#fff", "center", 800);
    if(racing && !A.done && rt >= A.race.reduce(function(m, P){ return Math.max(m, P.T); }, 0) + 0.5) finish();
  }
  function drawPlinko(t){
    felt("#1b1035", "#08040f");
    var rows = 12, top = 40, dy = 24, dx = 30, cx = W/2, mult = (me && me.tables && me.tables.plinko) || [];
    for(var r = 0; r < rows; r++) for(var i = 0; i <= r + 2; i++){ var x = cx + (i - (r + 2)/2)*dx; g.fillStyle = "#e0d7ff"; g.beginPath(); g.arc(x, top + r*dy + 20, 3.4, 0, TAU); g.fill(); }
    var by = top + rows*dy + 34, res = A.game === "plinko" && A.j ? A.j.result : null;
    for(var b = 0; b < 13; b++){
      var x2 = cx + (b - 6)*dx, m = (mult[b] || 0)/1000, col = m >= 3 ? "#ff3d71" : m >= 1.3 ? "#ff9f1c" : m >= 1 ? "#ffd166" : "#4cc9f0";
      rr(g, x2 - 14, by - 12, 28, 26, 6); g.fillStyle = res && A.done && res.bin === b ? "#fff" : col; g.fill();
      text(m >= 10 ? m.toFixed(0) : m.toFixed(m % 1 ? 2 : 0).replace(/0$/, ""), x2, by + 1, 10, "#1b1035", "center", 900);
    }
    if(res){
      var path = res.path || [], steps = rows + 1, uu = u(), f = A.done ? steps : uu*steps, s = Math.floor(f), w = f - s, col2 = 0;
      for(var k2 = 0; k2 < Math.min(s, rows); k2++) col2 += path[k2] ? 1 : 0;
      var xa = cx + (col2 - Math.min(s, rows)/2)*dx, ya = top + Math.min(s, rows)*dy, nx = s < rows ? cx + (col2 + (path[s] ? 1 : 0) - (s + 1)/2)*dx : xa, ny = s < rows ? top + (s + 1)*dy : by - 20;
      var bx = A.done ? cx + (res.bin - 6)*dx : xa + (nx - xa)*w, byy = A.done ? by - 20 : ya + (ny - ya)*w - Math.sin(w*PI)*10;
      g.fillStyle = "#ffeb3b"; g.shadowColor = "#ffeb3b"; g.shadowBlur = 12; g.beginPath(); g.arc(bx, byy + 8, 7, 0, TAU); g.fill(); g.shadowBlur = 0;
      if(!A.done && Math.floor(f) !== A.lastPeg){ A.lastPeg = Math.floor(f); snd.tick(); }
      if(uu >= 1 && !A.done) finish();
    }
  }
  function drawWheel(t){
    felt("#311b4f", "#0f0619");
    var segs = (me && me.tables && me.tables.wheel) || [], n = segs.length || 50, sg = TAU/n, cx = W/2, cy = 215, R = 170, res = A.game === "wheel" && A.j ? A.j.result : null, uu = u();
    var fin = res ? -(res.segment*sg + sg/2) : 0, a = res ? (A.done ? fin : (A.w0 || 0) + ((fin - (A.w0 || 0)) - TAU*6)*ease(uu) + 0) : (A.w0 || 0) + t*0.1;
    if(res && A.done) A.w0 = fin;
    var COL = {0: "#2d2d3a", 15: "#00b4d8", 20: "#4361ee", 30: "#9d4edd", 50: "#ff9f1c", 60: "#ffd60a"};
    g.save(); g.translate(cx, cy); g.rotate(a);
    for(var i = 0; i < n; i++){ g.fillStyle = COL[segs[i]] || "#555"; g.beginPath(); g.moveTo(0, 0); g.arc(0, 0, R, i*sg - PI/2, (i + 1)*sg - PI/2); g.closePath(); g.fill();
      g.strokeStyle = "rgba(255,255,255,.25)"; g.lineWidth = 1; g.stroke();
      if(segs[i]){ g.save(); g.rotate(i*sg + sg/2); g.fillStyle = "#fff"; g.font = "800 11px system-ui"; g.textAlign = "center"; g.fillText((segs[i]/10) + "x", 0, -R + 18); g.restore(); } }
    g.restore();
    g.strokeStyle = "#ffd54f"; g.lineWidth = 8; g.beginPath(); g.arc(cx, cy, R + 4, 0, TAU); g.stroke();
    for(var b = 0; b < 24; b++){ var ba = b/24*TAU; g.fillStyle = (b + Math.floor(t*5)) % 2 ? "#fff59d" : "#ff6b6b"; g.beginPath(); g.arc(cx + Math.cos(ba)*(R + 14), cy + Math.sin(ba)*(R + 14), 4, 0, TAU); g.fill(); }
    g.fillStyle = "#ffd54f"; g.beginPath(); g.moveTo(cx - 14, cy - R - 26); g.lineTo(cx + 14, cy - R - 26); g.lineTo(cx, cy - R + 4); g.closePath(); g.fill();
    var hub = g.createRadialGradient(cx - 6, cy - 6, 2, cx, cy, 30); hub.addColorStop(0, "#fff"); hub.addColorStop(1, "#b8860b"); g.fillStyle = hub; g.beginPath(); g.arc(cx, cy, 26, 0, TAU); g.fill();
    if(res && !A.done && Math.floor(uu*60*(1 - uu)) !== A.lastTick){ A.lastTick = Math.floor(uu*60*(1 - uu)); snd.tick(); }
    if(res && uu >= 1 && !A.done) finish();
  }
  function drawRocket(t){
    var gr = g.createLinearGradient(0, 0, 0, H); gr.addColorStop(0, "#050816"); gr.addColorStop(1, "#1b2a4e"); g.fillStyle = gr; g.fillRect(0, 0, W, H);
    for(var s = 0; s < 60; s++){ g.fillStyle = "rgba(255,255,255," + (0.3 + (s % 5)/8) + ")"; g.fillRect((s*97) % W, (s*53 + t*(s % 3 + 1)*6) % H, 2, 2); }
    var res = A.game === "rocket" && A.j ? A.j.result : null, crash = res ? Math.max(100, res.crash | 0)/100 : 1, target = (res ? res.target : pick.rocket)/100;
    var dur = A.dur || 1, el = res ? (A.done ? dur : Math.min(dur, now() - A.t0)) : 0, mNow = res ? Math.min(crash, Math.exp(Math.log(crash)*el/dur)) : 1;
    var x0 = 60, y0 = H - 50, ymax = Math.max(2, Math.min(crash, 100), target*1.2), sx = function(m){ return x0 + (Math.log(m)/Math.log(ymax))*(W - 140); }, sy = function(m){ return y0 - (Math.log(m)/Math.log(ymax))*(H - 110); };
    g.strokeStyle = "rgba(255,255,255,.15)"; g.lineWidth = 1; [1.5, 2, 5, 10, 20, 50, 100].forEach(function(m){ if(m > ymax) return; g.beginPath(); g.moveTo(x0, sy(m)); g.lineTo(W - 40, sy(m)); g.stroke(); text(m + "x", x0 - 8, sy(m), 11, "rgba(255,255,255,.5)", "right"); });
    g.setLineDash([8, 6]); g.strokeStyle = "#ffd54f"; g.lineWidth = 2; g.beginPath(); g.moveTo(x0, sy(target)); g.lineTo(W - 40, sy(target)); g.stroke(); g.setLineDash([]);
    text("cash out " + target.toFixed(2) + "x", W - 44, sy(target) - 12, 12, "#ffd54f", "right");
    if(res){
      g.strokeStyle = "#ff4d6d"; g.lineWidth = 3; g.beginPath();
      for(var i = 0; i <= 60; i++){ var m = Math.exp(Math.log(mNow)*i/60); if(i) g.lineTo(sx(m), sy(m)); else g.moveTo(sx(m), sy(m)); } g.stroke();
      var rx = sx(mNow), ry = sy(mNow), crashed = A.done || el >= dur;
      if(!crashed){ g.save(); g.translate(rx, ry); g.rotate(-0.6); g.font = "34px serif"; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText("\ud83d\ude80", 0, 0); g.restore(); }
      else { for(var p = 0; p < 14; p++){ var pa = p/14*TAU, pr = calm() ? 18 : 18 + ((now() - A.t0 - dur)*90 % 40); g.fillStyle = p % 2 ? "#ff9f1c" : "#ff4d6d"; g.beginPath(); g.arc(rx + Math.cos(pa)*pr, ry + Math.sin(pa)*pr, 5, 0, TAU); g.fill(); } }
      text(mNow.toFixed(2) + "x", W/2, 60, 48, crashed ? "#ff4d6d" : "#fff", "center", 900);
      if(mNow >= target && crash >= target) text("CASHED OUT AT " + target.toFixed(2) + "x", W/2, 104, 18, "#7CFFB2", "center", 900);
      if(crashed) text("CRASHED", W/2, 140, 16, "#ff4d6d", "center", 900);
      if(el >= dur && !A.done) finish();
    } else text("Ready for launch", W/2, 60, 30, "#fff", "center", 900);
  }
  function drawDice(t){
    felt("#14532d", "#052e16");
    g.strokeStyle = "rgba(255,255,255,.25)"; g.lineWidth = 3; rr(g, 40, 30, W - 80, H - 60, 24); g.stroke();
    text("OVER \u00b7 UNDER \u00b7 SEVEN \u00b7 DOUBLES", W/2, 56, 16, "rgba(255,255,255,.55)", "center", 800);
    var res = A.game === "dice" && A.j ? A.j.result : null, uu = u(), d = res ? res.dice : [3, 4];
    for(var i = 0; i < 2; i++){
      var tum = res && !A.done ? 1 - uu : 0, x = W/2 - 70 + i*140 + Math.sin(uu*PI*3 + i)*40*tum, y = 200 - Math.abs(Math.sin(uu*PI*4 + i))*90*tum;
      var face = res && !A.done ? 1 + Math.floor((t*13 + i*3) % 6) : d[i];
      die(g, face, x, y, 92, res && !A.done ? uu*TAU*3*(i ? -1 : 1) : (i ? 0.08 : -0.06));
    }
    if(res && A.done) text("= " + (d[0] + d[1]), W/2, 320, 34, "#fff", "center", 900);
    if(res && uu >= 1 && !A.done) finish();
  }
  var SC = {x: 190, y: 26, s: 92};
  function drawScratch(t){
    felt("#3a2b00", "#120c00");
    rr(g, SC.x - 20, SC.y - 20, SC.s*3 + 40 + 10, SC.s*3 + 40 + 10, 18); var cg2 = g.createLinearGradient(0, SC.y, 0, SC.y + 360); cg2.addColorStop(0, "#ffe082"); cg2.addColorStop(1, "#ff8f00"); g.fillStyle = cg2; g.fill();
    text("SCRATCH-O-MATIC", 640, 60, 18, "#ffd54f", "center", 900);
    text("match three", 640, 86, 13, "rgba(255,255,255,.6)");
    var S = scratchState;
    for(var i = 0; i < 9; i++){
      var x = SC.x + (i % 3)*(SC.s + 5), y = SC.y + Math.floor(i/3)*(SC.s + 5);
      rr(g, x, y, SC.s, SC.s, 10); g.fillStyle = "#fffdf5"; g.fill();
      if(S && S.grid[i]) symbol(g, S.grid[i], x + SC.s/2, y + SC.s/2, SC.s*0.8);
    }
    if(S && !S.done){
      if(!S.cover){
        S.cover = doc.createElement("canvas"); S.cover.width = SC.s*3 + 10; S.cover.height = SC.s*3 + 10;
        var c3 = S.cover.getContext("2d"), sg = c3.createLinearGradient(0, 0, S.cover.width, S.cover.height); sg.addColorStop(0, "#cfd8dc"); sg.addColorStop(0.5, "#eceff1"); sg.addColorStop(1, "#90a4ae");
        c3.fillStyle = sg; c3.fillRect(0, 0, S.cover.width, S.cover.height);
        c3.fillStyle = "rgba(96,125,139,.6)"; c3.font = "800 15px system-ui"; c3.textAlign = "center";
        for(var j = 0; j < 9; j++){ var cx4 = (j % 3)*(SC.s + 5) + SC.s/2, cy4 = Math.floor(j/3)*(SC.s + 5) + SC.s/2; c3.fillText("\u2733", cx4, cy4 - 4); c3.fillText("SCRATCH", cx4, cy4 + 16); }
      }
      if(S.reveal){ var f = Math.min(1, (now() - S.reveal)/0.6); g.globalAlpha = 1 - f; if(f >= 1) endScratch(); }
      g.drawImage(S.cover, SC.x, SC.y); g.globalAlpha = 1;
      if(S.dirty && !S.reveal){ S.dirty = false; if(cleared(S.cover) > 0.72) S.reveal = now(); }
    } else if(!S) text("Buy a card to play", SC.x + SC.s*1.5, SC.y + SC.s*1.5, 22, "#5d4037", "center", 900);
  }
  function cleared(cn){
    try { var d = cn.getContext("2d").getImageData(0, 0, cn.width, cn.height).data, z = 0, n = 0; for(var i = 3; i < d.length; i += 64){ n++; if(d[i] < 20) z++; } return z/n; } catch(e){ return 1; }
  }
  function endScratch(){ if(!scratchState || scratchState.done) return; scratchState.done = true; A.game = "scratch"; A.done = false; A.dur = 0; finish(); }
  function drawCoin(t){
    felt("#0b3c5d", "#03121c");
    var res = A.game === "coin" && A.j ? A.j.result : null, uu = u(), flips = 9;
    var ang = res ? (A.done ? (res.side === "heads" ? 0 : PI) : ease(uu)*(flips*TAU + (res.side === "heads" ? 0 : PI))) : Math.sin(t)*0.3;
    var y = 210 - (res && !A.done ? Math.sin(uu*PI)*140 : 0), sy = Math.cos(ang), heads = sy >= 0;
    g.save(); g.translate(W/2, y); g.scale(1, Math.max(0.04, Math.abs(sy)));
    var cg3 = g.createRadialGradient(-20, -20, 10, 0, 0, 100); cg3.addColorStop(0, "#fff8c4"); cg3.addColorStop(1, "#c99700"); g.fillStyle = cg3; g.beginPath(); g.arc(0, 0, 92, 0, TAU); g.fill();
    g.strokeStyle = "#8c6a00"; g.lineWidth = 8; g.stroke(); g.lineWidth = 2; g.beginPath(); g.arc(0, 0, 78, 0, TAU); g.stroke();
    g.fillStyle = "#8c6a00"; g.font = "900 70px system-ui"; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(heads ? "\u2733" : "\u2684", 0, 4);
    g.restore();
    g.fillStyle = "rgba(0,0,0,.35)"; g.beginPath(); g.ellipse(W/2, 330, 80*(res && !A.done ? 1 - Math.sin(uu*PI)*0.5 : 1), 12, 0, 0, TAU); g.fill();
    if(res && A.done) text(res.side.toUpperCase(), W/2 + 170, 210, 30, "#fff", "center", 900);
    if(res && uu >= 1 && !A.done) finish();
  }
  function drawBlackjack(t){
    felt("#0f6b3a", "#063620");
    g.strokeStyle = "rgba(255,230,150,.6)"; g.lineWidth = 3; g.beginPath(); g.arc(W/2, -120, 420, 0.25*PI, 0.75*PI); g.stroke();
    text("BLACKJACK PAYS 3 TO 2", W/2, 214, 15, "rgba(255,230,150,.75)", "center", 800);
    text("DEALER STANDS ON ALL 17s", W/2, 236, 11, "rgba(255,230,150,.6)", "center", 700);
    var h = bj && bj.hand; if(!h){ text("Place your bet and deal", W/2, 320, 22, "#fff", "center", 800); return; }
    var el = calm() ? 99 : now() - (bj.at || 0), shown = 0;
    function row(cards, y, label, tot){
      cards.forEach(function(c, i){ var idx = shown++, delay = Math.max(0, idx - (bj.prevN || 0))*0.22, f = ease((el - delay)/0.3);
        var x = W/2 - (cards.length*70)/2 + i*70, sx2 = W - 80 + (x - (W - 80))*f, sy2 = 20 + (y - 20)*f; if(f > 0) card(g, c, sx2, sy2, 62, 88, c < 0); });
      text(label + (tot != null ? "  " + tot : ""), W/2, y - 16, 15, "#fff", "center", 800);
    }
    row(h.dealer, 40, "DEALER", bj.done ? h.dtotal : null);
    row(h.player, 270, "YOU", h.ptotal);
    // the stake in chips
    for(var c2 = 0; c2 < Math.min(8, 1 + Math.floor(Math.log2(Math.max(1, h.bet)))); c2++){ g.fillStyle = c2 % 2 ? "#e63946" : "#f1faee"; g.beginPath(); g.ellipse(120, 330 - c2*6, 26, 9, 0, 0, TAU); g.fill(); g.strokeStyle = "#222"; g.lineWidth = 1; g.stroke(); }
    text(fmt(h.bet), 120, 360, 14, "#fff", "center", 800);
  }
  function drawDuel(t){
    felt("#2a0f3d", "#0b0414");
    for(var r = 0; r < 2; r++){ g.strokeStyle = r ? "rgba(255,63,180,.5)" : "rgba(58,134,255,.5)"; g.lineWidth = 3; rr(g, 30 + r*(W/2), 30, W/2 - 60, H - 60, 20); g.stroke(); }
    text("⚔️", W/2, H/2, 54, "#fff");
    var S2 = duelShow;
    if(!S2){ text("THE DUEL TABLE", W/2, 60, 28, "#ffd54f", "center", 900); text("player vs player", W/2, 92, 15, "rgba(255,255,255,.6)"); text("Post a challenge or take one below", W/2, H - 50, 16, "#fff", "center", 700); return; }
    var m = S2.m, el = now() - S2.t0, cl = calm(), dur = cl ? 0.3 : 2.4, u2 = Math.min(1, el/dur), res = m.result || {};
    var mineSide = m.mine ? "owner" : "taker", otherSide = m.mine ? "taker" : "owner";
    text("YOU", W/4, 60, 22, "#7fb2ff", "center", 900); text(String(m.vs || "RIVAL").toUpperCase(), 3*W/4, 60, 22, "#ff8ad8", "center", 900);
    [[mineSide, W/4], [otherSide, 3*W/4]].forEach(function(s, i){
      var v = res[s[0]];
      if(m.game === "highcard"){ var flip = Math.min(1, Math.max(0, (u2 - 0.3 - i*0.2)/0.3)); card(g, v && v[0] != null ? v[0] : 0, s[1] - 50, H/2 - 70, 100, 140, flip < 0.5); }
      else if(m.game === "dice"){ var dv = v || [1, 1]; for(var q = 0; q < 2; q++) die(g, u2 < 1 ? 1 + Math.floor((t*12 + q + i*2) % 6) : dv[q], s[1] - 45 + q*90, H/2, 70, u2 < 1 ? t*6 : 0); }
      else if(m.game === "rps"){ g.save(); g.translate(s[1], H/2 + (u2 < 1 ? Math.abs(Math.sin(u2*PI*3))*-30 : 0)); g.font = "110px serif"; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(u2 < 1 ? "✊" : RPS_ICON[v] || "✊", 0, 0); g.restore(); }
    });
    if(m.game === "coin"){ var side = res.side || "heads", ang = u2*PI*12 + (side === "heads" ? 0 : PI), sy = Math.cos(ang); g.save(); g.translate(W/2, H/2 - Math.sin(u2*PI)*90); g.scale(1, Math.max(0.05, Math.abs(sy))); symbol(g, "coin", 0, 0, 160); g.restore();
      text((m.mine ? "you called heads" : "you called tails"), W/2, H - 40, 14, "rgba(255,255,255,.7)"); }
    if(u2 >= 1){ text(m.draw ? "DRAW" : m.won ? "YOU WIN" : "YOU LOSE", W/2, H - 70, 30, m.draw ? "#fff" : m.won ? "#7CFFB2" : "#ff5c7a", "center", 900); if(!S2.done){ S2.done = true; verdict(m); } }
  }
  function drawCage(t){
    felt("#2b2b2b", "#0e0e0e");
    for(var b = 0; b < 15; b++){ g.fillStyle = "#b8860b"; g.fillRect(40 + b*48, 40, 6, 200); }
    g.fillStyle = "#3e2723"; g.fillRect(20, 240, W - 40, 30);
    for(var s = 0; s < 6; s++){ var x = 140 + s*90; for(var c = 0; c < 6; c++){ g.fillStyle = ["#e63946", "#3a86ff", "#2a9d8f", "#111", "#ffbe0b", "#8338ec"][s]; g.beginPath(); g.ellipse(x, 230 - c*7, 26, 9, 0, 0, TAU); g.fill(); g.strokeStyle = "#fff"; g.lineWidth = 2; g.stroke(); } }
    text("THE CAGE", W/2, 310, 30, "#ffd54f", "center", 900);
    text("Poke Coins \u21c4 chips \u00b7 10 chips a coin", W/2, 348, 15, "rgba(255,255,255,.7)");
  }
  // the house's picture to go with its opinion (or a celebration)
  function drawFx(t){
    if(!A.fx) return;
    var e = now() - A.fxT, cl = calm(); if(e > 4.2){ A.fx = null; return; }
    var a = Math.min(1, e/0.25)*Math.min(1, (4.2 - e)/0.5); g.save(); g.globalAlpha = a;
    if(A.fx === "stamp"){
      var sc = cl ? 1 : 1 + Math.max(0, 0.3 - e)*3; g.translate(W - 130, 110); g.rotate(-0.25); g.scale(sc, sc);
      g.strokeStyle = "#e53935"; g.lineWidth = 8; g.beginPath(); g.arc(0, 0, 66, 0, TAU); g.stroke(); g.lineWidth = 3; g.beginPath(); g.arc(0, 0, 56, 0, TAU); g.stroke();
      text("L", 0, 4, 84, "#e53935", "center", 900);
      for(var i = 0; i < 7; i++){ var pa = i*0.9; g.fillStyle = "#e53935"; g.beginPath(); g.arc(Math.cos(pa)*86, Math.sin(pa)*86, 4 + (i % 3)*3, 0, TAU); g.fill(); }
    } else if(A.fx === "stonks"){
      rr(g, W - 250, 30, 220, 140, 12); g.fillStyle = "rgba(10,10,20,.85)"; g.fill();
      g.strokeStyle = "#ff5252"; g.lineWidth = 4; g.beginPath(); var pts = [[0, 20], [30, 40], [55, 25], [85, 60], [110, 50], [140, 95], [170, 100], [200, 128]], m = cl ? 1 : Math.min(1, e/1.2);
      pts.forEach(function(p, i){ var px = W - 240 + p[0]*Math.min(1, m*1.05), py = 30 + p[1]; if(i) g.lineTo(px, py); else g.moveTo(px, py); }); g.stroke();
      text("\ud83d\udcc9 your chips", W - 140, 48, 14, "#ff8a80", "center", 800);
    } else if(A.fx === "violin"){
      g.font = "64px serif"; g.textAlign = "center"; g.fillText("\ud83c\udfbb", W - 120, 110);
      for(var n = 0; n < 5; n++){ var ny = 80 - ((e*40 + n*22) % 90); g.font = "22px serif"; g.fillText(n % 2 ? "\u266a" : "\u266b", W - 160 + n*20, ny + 60); }
      text("the world's smallest violin", W - 120, 160, 13, "#fff", "center", 700);
    } else if(A.fx === "yacht"){
      var yx = cl ? W/2 : -80 + ((e/4)*(W + 160)); g.font = "54px serif"; g.textAlign = "center"; g.fillText("\ud83d\udee5\ufe0f", yx, H - 60);
      text("the house's yacht fund thanks you", yx, H - 22, 13, "#fff", "center", 800);
    } else if(A.fx === "flatline"){
      rr(g, W - 270, 30, 240, 110, 12); g.fillStyle = "rgba(0,20,10,.9)"; g.fill(); g.strokeStyle = "#00e676"; g.lineWidth = 3; g.beginPath();
      for(var x = 0; x <= 220; x += 4){ var beat = x < 90 && x % 44 > 30 ? -30*Math.sin((x % 44 - 30)/14*PI) : 0; if(x) g.lineTo(W - 260 + x, 90 + beat); else g.moveTo(W - 260 + x, 90 + beat); } g.stroke();
      text("wallet.exe has stopped", W - 150, 50, 13, "#00e676", "center", 800);
    } else if(A.fx === "tumbleweed"){
      var tx = cl ? W/2 : -60 + (e/4)*(W + 120); g.save(); g.translate(tx, H - 70); g.rotate(cl ? 0 : e*5); g.strokeStyle = "#a1887f"; g.lineWidth = 2;
      for(var q = 0; q < 9; q++){ g.beginPath(); g.arc(0, 0, 14 + q*1.5, q, q + 4); g.stroke(); } g.restore();
      text("where your chips used to be", W/2, H - 24, 13, "#fff", "center", 700);
    } else if(A.fx === "coins" || A.fx === "big" || A.fx === "jackpot"){
      var nC = A.fx === "coins" ? 18 : 60;
      for(var c = 0; c < nC; c++){ var cx = (c*61) % W, cy = cl ? (c*37) % H : ((e*(180 + (c % 5)*40) + c*29) % (H + 40)) - 20; symbol(g, "coin", cx, cy, 26); }
      if(A.fx !== "coins"){ var pul = cl ? 1 : 1 + Math.sin(e*8)*0.06; g.save(); g.translate(W/2, H/2); g.scale(pul, pul);
        g.lineWidth = 10; g.strokeStyle = "#5a3d00"; g.font = "900 " + (A.fx === "jackpot" ? 86 : 64) + "px Impact, 'Arial Black', sans-serif"; g.textAlign = "center"; g.textBaseline = "middle";
        var lbl = A.fx === "jackpot" ? "JACKPOT!" : "BIG WIN!"; g.strokeText(lbl, 0, 0); g.fillStyle = "#ffd54f"; g.fillText(lbl, 0, 0); g.restore(); }
    }
    g.restore();
  }
  var DRAW = {slots: drawSlots, roulette: drawRoulette, horses: drawHorses, plinko: drawPlinko, wheel: drawWheel, rocket: drawRocket, dice: drawDice,
              scratch: drawScratch, coin: drawCoin, blackjack: drawBlackjack, cage: drawCage, duel: drawDuel};
  function frame(){
    raf = 0; if(dead || !open) return;
    var t = now();
    try { (DRAW[game] || drawSlots)(t); drawFx(t); } catch(e){}
    raf = (G.requestAnimationFrame || setTimeout)(frame);
  }

  /* keys: Space or Enter plays, Escape leaves; nothing reaches the page's own shortcuts */
  on(root, "keydown", function(e){
    e.stopPropagation();
    if(e.key === "Escape"){ e.preventDefault(); ui.close(); return; }
    if((e.key === " " || e.key === "Enter") && e.target === root){ e.preventDefault(); if(game === "blackjack") bjMove(bj && !bj.done ? "stand" : "deal"); else if(game !== "cage") play(); }
  });
  on(root, "keyup", function(e){ e.stopPropagation(); });
  on(closeBtn, "click", function(){ ui.close(); });
  root.tabIndex = -1;

  var ui = {
    root: root,
    open: function(which){
      if(!GAMES[which]) which = "slots";
      if(busy && which !== game) return;
      game = which; open = true; root.hidden = false; say(""); A.fx = null;
      if(which !== "scratch") scratchState = scratchState && scratchState.done ? null : scratchState;
      render(); refresh().then(function(){ if(!dead) render(); });
      if(which === "duel"){ duelShow = null; pollDuels(true); }
      if(which === "blackjack" && me && me.hand && (!bj || bj.done)){ bj = {done: false, hand: me.hand, at: 0}; render(); }
      try { root.focus({preventScroll: true}); } catch(e){}
      if(!raf) frame();
    },
    close: function(){ if(!open) return; open = false; root.hidden = true; if(raf){ (G.cancelAnimationFrame || clearTimeout)(raf); raf = 0; } if(opts.onClose) opts.onClose(); },
    isOpen: function(){ return open; },
    owns: owns,
    me: function(){ return me; },
    // called every frame while you are in the casino: duels polled (faster while the duel table is open)
    idle: function(){ var gap = open && game === "duel" ? 3 : 10; if(now() - lastPoll > gap) pollDuels(); },
    refresh: refresh,
    destroy: function(){ dead = true; ui.close(); listeners.forEach(function(L){ L[0].removeEventListener(L[1], L[2]); }); if(root.parentNode) root.parentNode.removeChild(root); }
  };
  return ui;
}

HQV.hqCasinoUi = {mount: mount, roast: roast, cheer: cheer, owns: owns, GAMES: GAMES, ROULETTE: ROULETTE, ROAST: ROAST, CHEER: CHEER, ARTS: ARTS,
                  art: {symbol: symbol, card: card, die: die, horse: horse, rr: rr}, sound: sound};
})();
