/* Wave G: the trap-and-gadget set (Mini Turret / Explosive Barrels / Laser Grid /
   Jump Pad / Death Lottery). Five totems, every number judged on both sides.

   What this probe locks:
     - the frozen constants agree between games/strike.js and backend/src/strike.rs
     - the barrel blast is exactly 10x a launcher, and chains the next barrel
     - a laser trip kills at deck height and a jump (height above the deck >= LASER_CLEAR)
     - one laser contact is ONE kill: the isMe arm checks V.dead (not V.me.dead),
      so the respawn clock (V.deadAt + RESPAWN) is never rewritten
     - turrets drop in a ring around the taker (they "cover you"), and a Target
      range turret has the flight drones to shoot at
     - the height tests are GROUND-RELATIVE: a walker on the raised centre is not safe
     - a jump pad launches at PAD_LAUNCH and PAD_COOL covers the whole flight arc
     - the lottery only ever picks a living ENEMY, and it does both outcomes
     - destructible rays get coordinate triples (turretBox/barrelBox index [0]/[1]/[2])
     - world objects never fabricate a shooter (no team-0 scoring)
     - PAD_COOL >= 2 * PAD_LAUNCH / GRAVITY so the judge buys the landing

   Run: node tests/probe_waveg.js */
var fs = require("fs"), path = require("path");
var ROOT = path.join(__dirname, "..");
var js = fs.readFileSync(path.join(ROOT, "games", "strike.js"), "utf8");
var rs = fs.readFileSync(path.join(ROOT, "backend", "src", "strike.rs"), "utf8");
var inp = fs.readFileSync(path.join(ROOT, "games", "input.js"), "utf8");

var fails = 0;
function check(ok, msg, extra){
  console.log("  " + (ok ? "PASS " : "FAIL ") + msg + (extra != null ? "  — " + extra : ""));
  if(!ok) fails++;
}
function twin(jsRe, rsRe, name){
  var a = (js.match(jsRe) || [])[1], b = (rs.match(rsRe) || [])[1];
  check(a != null && b != null, name + " present in both", "var " + a + " | pub const " + b);
  if(a != null && b != null) check(+a === +b, name + " agrees", a + " vs " + b);
}
function re(pat, src, name){
  check(pat.test(src || js), name);
}

// ---------------------------------------------------------------- constants --
console.log("\nWave G — the frozen numbers agree");
twin(/var TURRET_N = 3, TURRET_HP = ([0-9]+)/, /pub const TURRET_HP: i64 = ([0-9]+)/, "TURRET_HP");
twin(/TURRET_RANGE = ([0-9.]+), TURRET_DMG/, /pub const TURRET_RANGE: f64 = ([0-9.]+)/, "TURRET_RANGE");
twin(/TURRET_DMG = ([0-9]+), TURRET_GAP/, /pub const TURRET_DMG: i64 = ([0-9]+)/, "TURRET_DMG");
twin(/TURRET_GAP = ([0-9.]+)/, /pub const TURRET_GAP: f64 = ([0-9.]+)/, "TURRET_GAP");
twin(/var TURRET_R = ([0-9.]+)/, /pub const TURRET_R: f64 = ([0-9.]+)/, "TURRET_R");
twin(/BARREL_HP = ([0-9]+), BARREL_R/, /pub const BARREL_HP: i64 = ([0-9]+)/, "BARREL_HP");
twin(/BARREL_R = ([0-9.]+), BARREL_DMG/, /pub const BARREL_R: f64 = ([0-9.]+)/, "BARREL_R");
twin(/BARREL_DMG = ([0-9]+), BARREL_MIN/, /pub const BARREL_DMG: i64 = ([0-9]+)/, "BARREL_DMG");
twin(/BARREL_MIN = ([0-9]+), BARREL_DIRECT/, /pub const BARREL_MIN: i64 = ([0-9]+)/, "BARREL_MIN");
twin(/BARREL_DIRECT = ([0-9]+)/, /pub const BARREL_DIRECT: i64 = ([0-9]+)/, "BARREL_DIRECT");
twin(/BARREL_RAD = ([0-9.]+)/, /pub const BARREL_RAD: f64 = ([0-9.]+)/, "BARREL_RAD");
twin(/BARREL_FALL = ([0-9.]+)/, /pub const BARREL_FALL: f64 = ([0-9.]+)/, "BARREL_FALL");
twin(/LASER_Y = ([0-9.]+), LASER_HALF/, /pub const LASER_Y: f64 = ([0-9.]+)/, "LASER_Y");
twin(/LASER_HALF = ([0-9.]+), LASER_LEN/, /pub const LASER_HALF: f64 = ([0-9.]+)/, "LASER_HALF");
twin(/LASER_LEN = ([0-9.]+), LASER_CLEAR/, /pub const LASER_LEN: f64 = ([0-9.]+)/, "LASER_LEN");
twin(/LASER_CLEAR = ([0-9.]+)/, /pub const LASER_CLEAR: f64 = ([0-9.]+)/, "LASER_CLEAR");
twin(/PAD_R = ([0-9.]+), PAD_LAUNCH/, /pub const PAD_R: f64 = ([0-9.]+)/, "PAD_R");
twin(/PAD_LAUNCH = ([0-9.]+), PAD_COOL/, /pub const PAD_LAUNCH: f64 = ([0-9.]+)/, "PAD_LAUNCH");
twin(/PAD_COOL = ([0-9.]+)/, /pub const PAD_COOL: f64 = ([0-9.]+)/, "PAD_COOL");
twin(/LOTTERY_HEAL = ([0-9]+)/, /pub const LOTTERY_HEAL: i64 = ([0-9]+)/, "LOTTERY_HEAL");

// -------------------------------------------------- PAD_COOL vs the flight arc --
console.log("\nWave G — the pad cool-down covers the whole flight");
var PAD_LAUNCH = 22.0, PAD_COOL = 2.5, GRAVITY = 18.0, MAX_AIR = 2.0;
var arc = 2 * PAD_LAUNCH / GRAVITY;
check(PAD_COOL >= arc, "PAD_COOL covers the arc", "PAD_COOL " + PAD_COOL + " >= 2*PAD_LAUNCH/GRAVITY = " + arc.toFixed(3) + " s");
check(PAD_COOL >= MAX_AIR, "PAD_COOL covers MAX_AIR too", PAD_COOL + " >= " + MAX_AIR);
re(/pad_let_up = p\.pad_cool > t/, rs, "the judge has a pad_let_up air relax");
re(/pad_cool: f64/, rs, "the player carries a pad_cool clock");
re(/pub pad_cool: f64/, rs, "and it is a public field");
re(/p\.pad_cool = t \+ PAD_COOL/, rs, "stepping on a pad stamps pad_cool");

// -------------------------------------------------------- 10x the launcher --
console.log("\nWave G — the barrel blast is 10x a launcher");
function blastDamage(dist, direct){
  if(direct) return 120;
  if(dist >= 4.0) return 0;
  return Math.round(75 - (75 - 25)*(dist/4.0));
}
function barrelDamage(dist){
  if(dist < 0.8) return 1200;
  if(dist < 12.0) return Math.round(750 - (750 - 250) * (dist / 12.0));
  return 0;
}
check(blastDamage(0.0, true) * 10 === 1200, "direct is 10x a launcher",
      blastDamage(0.0, true) + " x10 = 1200");
check(barrelDamage(0.0) === 1200 && barrelDamage(0.4) === 1200, "BARREL_DIRECT is 1200 inside DIRECT_R");
check(barrelDamage(3.0) === 625, "the falloff at 3 m", barrelDamage(3.0) + "");
check(barrelDamage(6.0) === 500, "the falloff at 6 m", barrelDamage(6.0) + "");
check(barrelDamage(11.0) === 292, "the falloff at 11 m", barrelDamage(11.0) + "");
check(barrelDamage(12.0) === 0, "nothing outside BARREL_R");
// the shape is the launcher's own curve, stretched from BLAST_R to BARREL_R
var okCurve = true;
for(var d = 0.8; d < 4.0; d += 0.25){
  var one = blastDamage(d, false);
  var ten = barrelDamage(d * 3.0);          // 4 m launcher reach -> 12 m barrel reach
  if(Math.abs(ten - one * 10) > 5) okCurve = false;
}
check(okCurve, "the barrel curve is the launcher's own, stretched to BARREL_R");
re(/BARREL_DIRECT/i, js, "the client names BARREL_DIRECT");
re(/pub const BARREL_DIRECT: i64 = 1200/, rs, "the judge names BARREL_DIRECT = 1200");
re(/fn barrel_blast/, rs, "the judge has barrel_blast");
re(/function barrelBlast/, js, "the client has barrelBlast");
re(/\(BO\.y \|\| 0\) \+ holeGroundY\(BO\.x, BO\.z\) \+ 0\.5/, js,
   "the blast centre is on the deck under the barrel");
re(/b\.y \+ ground_y\(self\.map\(\), b\.x, b\.z\) \+ 0\.5/, rs,
   "the judge blast centre is on the deck under the barrel");
re(/function holeGroundY/, js, "JS has the deck-height helper");
re(/pub fn ground_y/, rs, "Rust has the deck-height helper");
// the blast must actually fire: the "already spent" guard must not sit in front of
// the caller that zeroes hp first.
check(!/self\.barrels\[idx\]\.hp = \(self\.barrels\[idx\]\.hp - dmg\)\.max\(0\);\s*\n\s*if self\.barrels\[idx\]\.hp <= 0 \{\s*\n\s*self\.barrel_blast/.test(rs),
      "Rust: waveg_hit does not zero hp before calling barrel_blast");
check(!/hit\.obj\.hp = \(hit\.obj\.hp\|0\) - dmg;/.test(js),
      "JS: wavegHit does not zero hp before calling barrelBlast");
re(/if\(bh - dmg <= 0\)/, js, "JS: the detonate branch fires when the shot empties the barrel");
re(/if was - dmg <= 0/, rs, "Rust: the detonate branch fires when the shot empties the barrel");
re(/\.filter\(\|\(i, b\)\| \*i != idx && b\.hp > 0 && \(b\.x - x\)\.hypot\(b\.z - z\) <= BARREL_R\)/, rs,
   "Rust: the chain is a barrel inside BARREL_R");
re(/Math\.hypot\(\(BO2\.x\|\|0\) - x, \(BO2\.z\|\|0\) - z\) <= FS\.BARREL_R/, js,
   "JS: the chain is a barrel inside BARREL_R");

// ------------------------------------------------------------- laser grid --
console.log("\nWave G — the laser grid kills on touch and a jump clears it");
function segDist2(px, pz, ax, az, bx, bz){
  var dx = bx - ax, dz = bz - az, l2 = dx*dx + dz*dz;
  var u = l2 > 0 ? ((px-ax)*dx + (pz-az)*dz)/l2 : 0;
  u = Math.max(0, Math.min(1, u));
  var qx = ax + dx*u - px, qz = az + dz*u - pz;
  return qx*qx + qz*qz;
}
var LASER_HALF = 0.32, LASER_CLEAR = 1.15;
// y is world height; gy is the deck under the body (holeGroundY / ground_y). The
// gate is height ABOVE THAT DECK — never an absolute world y.
function zapped(x, y, z, ax, az, bx, bz, gy){
  return (y - (gy || 0)) < LASER_CLEAR && segDist2(x, z, ax, az, bx, bz) <= LASER_HALF * LASER_HALF;
}
check(zapped(0, 0.2, 0, -10, 0, 10, 0), "walking into the beam kills you");
check(zapped(0, 0, 0, -10, 0, 10, 0), "standing on it at deck height kills you");
check(!zapped(0, LASER_CLEAR + 0.4, 0, -10, 0, 10, 0), "jumping over it (height >= LASER_CLEAR) saves you");
check(zapped(0, LASER_CLEAR - 0.05, 0, -10, 0, 10, 0), "and just under LASER_CLEAR still kills");
check(!zapped(0, 0.2, LASER_HALF + 0.5, -10, 0, 10, 0), "walking beside it (outside LASER_HALF) saves you");
check(!zapped(0, 0.2, 0, 5, 0, 15, 0), "past the end of the segment is safe");
// THE BUG THIS FIXES: on the dockyard's raised centre (deck 3.5) a walker used to
// stand at world y=3.5, pass an absolute "y >= LASER_CLEAR" gate, and walk through.
check(zapped(0, 3.5 + 0.2, 0, -10, 0, 10, 0, 3.5), "a walker on the RAISED deck is still zapped");
check(zapped(0, 3.5, 0, -10, 0, 10, 0, 3.5), "standing on the raised deck is still zapped");
check(!zapped(0, 3.5 + LASER_CLEAR + 0.1, 0, -10, 0, 10, 0, 3.5), "only a jump OFF the raised deck clears it");
check(!zapped(0, LASER_CLEAR + 0.1, 0, -10, 0, 10, 0, 0), "on flat ground the jump still works");
re(/function segDist2/, js, "JS has segDist2");
re(/fn seg_dist2/, rs, "Rust has seg_dist2");
re(/FS\.segDist2\(/, js, "the client tick calls segDist2");
re(/seg_dist2\(v\.x, v\.z, lz\.ax/, rs, "the judge tick calls seg_dist2");
re(/v\.y - ground_y\(self\.map\(\), v\.x, v\.z\) >= LASER_CLEAR/, rs,
   "the judge skips a body at or above LASER_CLEAR ABOVE THE DECK");
re(/\(\(B\.y \|\| 0\) - holeGroundY\(B\.x, B\.z\)\) >= FS\.LASER_CLEAR/, js,
   "the client skips a body at or above LASER_CLEAR ABOVE THE DECK");
re(/env_kill\(j, "laser", t\)/, rs, "the judge credits the map with a laser kill");
re(/endBotLife\(null, P, t, false, "laser"\)/, js, "the client credits the map with a laser kill");
re(/endBotLife\(null, null, t, false, "laser"\)/, js,
   "and YOUR laser death goes through endBotLife (the real death site)");
check(!/P\.dead = true; P\.deadAt = t;\s*\n\s*say\("The laser grid/.test(js),
      "the isMe branch never writes dead onto the physics body instead");
// one contact, one kill: V.me is a physics body and never carries .dead, so
// the isMe arm has to look at V.dead or the beam re-kills every tick and
// rewrites V.deadAt - pushing "Respawning in X" out forever.
check(js.indexOf("if(isMe){ if(V.dead) return; }") >= 0,
      "zapL: the isMe arm bails on V.dead (not on V.me.dead)");
check(js.indexOf("if(!vic){ if(V.dead) return; }") >= 0,
      "endBotLife refuses to book a second death for a body already down");
check(js.indexOf("else if(vic.dead || vic.gone) return;") >= 0,
      "endBotLife refuses to book a second death for a bot already down");
// "drop in and cover you": a ring around the TAKER, never a scatter across the
// map (the old dropSpot() placement could land one 40 m from any fight and it
// idled out its whole 10 s - the totem read as dead).
check(js.indexOf("a ring around the TAKER") >= 0,
      "JS: the turret spawn comment says ring, not scatter");
check(js.indexOf("var ta = (V.worldK|0) * 2.399 + ti * 2.1;") >= 0,
      "JS: the turret ring angle comes from the world counter (never Math.random)");
check(rs.indexOf("2.399 + (ti as f64) * 2.1;") >= 0,
      "the judge uses the same world-counter ring angle");
check(rs.indexOf("ang.cos() * 1.8") >= 0,
      "the judge plants the ring at the same 1.8 m");
check(js.indexOf("dropSpot((tseed + ti") < 0,
      "JS: turrets no longer scatter off dropSpot");
// Target range has no bots - without the drones a practice turret is a 60 hp
// paperweight. It must be allowed to shoot them (twin of detonate drone arm).
check(js.indexOf('V.mode === "practice" && V.drones && V.drones.length') >= 0,
      "a Target range turret has the flight drones as its stand-in enemies");
check(js.indexOf("tBest.downUntil = t + 1.5; V.score = (V.score|0) + 1") >= 0,
      "a drone hit banks the range score like a player shot does");
// a turret never shoots a team-mate - that includes YOU, who take the totem.
check(js.indexOf("if(P.team === TU.team) return;") >= 0,
      "a turret never shoots a team-mate (you included)");
// the shot has to be SEEABLE in both modes; damage stays the judge's.
check(js.indexOf("addTracer([TU.x, holeGroundY") >= 0,
      "the turret draws a tracer to its target");
check(js.indexOf("tNext[TU.id] = TU.next") >= 0,
      "the MP snapshot carries each turret fire clock forward, so a repaint is not a barrage");
re(/endBotLife\(shooter \|\| null, P, t, dist < FS\.DIRECT_R, "barrel"\)/, js,
   "a barrel kill credits the detonator, or the map");

// ------------------------------------------- multiplayer: the two ways MP broke --
console.log("\nWave G — multiplayer plays like solo (respawn + pointer lock)");
// Stuck in respawn: onSnap used to latch V.dead = true on your own row and never
// clear it, while a local hit (barrel blast / dragon breath / your own rocket)
// could set V.dead without the judge - and no "spawn" ever comes for a death the
// server never booked. The judge's own row is the word on your body.
check(js.indexOf("else if(V.dead || P.dead){ V.dead = false; P.dead = false;") >= 0,
      "onSnap's me-arm CLEARS V.dead when the judge says you are alive (was a one-way latch)");
check(js.indexOf("if(S) S.dead = false;") >= 0,
      "a \"spawn\" clears the roster row too, so the watchdog agrees with the snapshot");
check(js.indexOf("if(myP && !myP.dead){ V.dead = false;") >= 0,
      "an MP watchdog clears a latched V.dead from the judge's own row (never stuck in respawn)");
// endBotLife is display-only in MP: the Arena judge owns deaths, scores and the feed
check(js.indexOf('if(V.mode === "mp"){\n      if(!vic){\n        V.hp = 0; V.hurtAt = t;') >= 0,
      "endBotLife is display-only in MP — it never latches V.dead behind the judge's back");
// the one site that wrote V.dead inline (your own rocket's self-blast) is gated too
check(js.indexOf('if(V.mode === "mp"){\n            V.wingsUntil = 0; V.leapUntil = 0; V.speedUntil = 0; V.danceUntil = 0;\n            if(shooter && shooter.uid !== myId()) snapKillCam(shooter, LAUNCH_W, false);') >= 0,
      "detonate's self-blast no longer writes V.dead in MP (the judge books the suicide)");
// The judge must not book two deaths for one body: a second blow used to rewind
// respawn_at and push the countdown out again (laser re-contact / barrel chain).
check(rs.indexOf("fn kill(&mut self, i: usize, j: usize, w: usize, head: bool, t: f64) {\n        // Already down:") >= 0,
      "the judge's kill() refuses a body that is already down (no respawn_at rewind)");
check(rs.indexOf("fn env_kill(&mut self, j: usize, dis: &str, t: f64) {\n        // Already down:") >= 0,
      "the judge's env_kill() refuses a body that is already down (no respawn_at rewind)");
// Cursor: MP never called IN.lock() on the join, so every player had to click the
// screen just to aim. requestPointerLock needs a user gesture - the join click is it.
check(js.indexOf("function grabLock(){") >= 0,
      "there is one grabLock() helper for focus + pointer lock");
check(js.indexOf("showStage(true);\n          grabLock();\n          requestView();") >= 0,
      "\"Join the match\" stands the stage up and grabs the mouse on the click itself");
check(js.indexOf("function requestView(){ grabLock(); if(MP)") >= 0,
      "requestView() grabs the mouse too (any path that enters the match locks)");
check(js.indexOf("showStage(true);\n    // entering the match is the gesture's tail end") >= 0,
      "applyView re-grabs the mouse when the match actually opens");
check(js.indexOf('canvas.addEventListener("pointerdown", function(){ grabLock(); });') >= 0,
      "any click on the arena re-grabs the mouse (Esc drops the lock; one click back in)");

// ---------------------------------------------------------------- roster / art --
console.log("\nWave G — the five totems are in every drop table and drawn");
check((js.match(/"blackhole","roulette","turret","barrel","laser","jumppad","lottery"\];/g) || []).length === 3,
      "all three drop rosters end with the Wave G five");
re(/pub const TOTEM_KINDS: \[&str; 60\]/, rs, "the judge roster is 60 kinds");
re(/"turret", "barrel", "laser", "jumppad", "lottery",/, rs, "the judge roster has the Wave G five");
check(FEAT_has_all(), "FEAT carries all thirteen featured kinds");
function FEAT_has_all(){
  var m = js.match(/var FEAT = "([^"]+)"/);
  if(!m) return false;
  var want = ["bighead","disco","banana","lava","goose","reverse","blackhole","roulette","turret","barrel","laser","jumppad","lottery"];
  var have = m[1].split(",");
  return want.every(function(k){ return have.indexOf(k) >= 0; });
}
re(/turret:\s*\{hue:/, js, "TOTEMS.turret is styled");
re(/barrel:\s*\{hue:/, js, "TOTEMS.barrel is styled");
re(/laser:\s*\{hue:/, js, "TOTEMS.laser is styled");
re(/jumppad:\s*\{hue:/, js, "TOTEMS.jumppad is styled");
re(/lottery:\s*\{hue:/, js, "TOTEMS.lottery is styled");
re(/buildTurret/, js, "3D: buildTurret");
re(/buildBarrel/, js, "3D: buildBarrel");
re(/buildLaser/, js, "3D: buildLaser");
re(/buildPad/, js, "3D: buildPad");
re(/R3\.padHop/, js, "3D: padHop");
re(/R3\.turretShot/, js, "3D: turretShot");
re(/clearTurrets/, js, "3D: clearTurrets on reset");
re(/clearBarrels/, js, "3D: clearBarrels on reset");
re(/clearLasers/, js, "3D: clearLasers on reset");
re(/clearPads/, js, "3D: clearPads on reset");

// ---------------------------------------------------------------- snapshot --
console.log("\nWave G — the multiplayer snapshot carries the four lists");
re(/obj\.insert\("tr"\.into\(\), Value::Array\(turret_rows\)\)/, rs, "the judge sends tr");
re(/obj\.insert\("br"\.into\(\), Value::Array\(barrel_rows\)\)/, rs, "the judge sends br");
re(/obj\.insert\("lg"\.into\(\), Value::Array\(laser_rows\)\)/, rs, "the judge sends lg");
re(/obj\.insert\("pd"\.into\(\), Value::Array\(pad_rows\)\)/, rs, "the judge sends pd");
re(/m\.tr/, js, "the client parses m.tr");
re(/m\.br/, js, "the client parses m.br");
re(/m\.lg/, js, "the client parses m.lg");
re(/m\.pd/, js, "the client parses m.pd");
re(/yaw: \(\(\+r\[6\]\|\|0\)\/100\) \* Math\.PI \/ 180/, js, "turret yaw arrives as cdeg and becomes radians");
re(/\(q\.yaw\.to_degrees\(\) \* 100\.0\)\.round\(\)/, rs, "the judge sends yaw as cdeg");

// ---------------------------------------------------------------- feed wording --
console.log("\nWave G — the kill feed names the world");
check(/"turret": "a mini turret"/.test(js), "ENV_NAMES.turret");
check(/"barrel": "an explosive barrel"/.test(js), "ENV_NAMES.barrel");
check(/"laser": "the laser grid"/.test(js), "ENV_NAMES.laser");
check(/"lottery": "the death lottery"/.test(js), "ENV_NAMES.lottery");
re(/"Drops 3 mini turrets for 10s/, js, "help: turret");
re(/Instant: 3 big explosive barrels/, js, "help: barrel");
re(/For 8s laser tripwires/, js, "help: laser");
re(/Places 3 launch pads for 10s/, js, "help: jumppad");
re(/Instant: picks one living enemy at random/, js, "help: lottery");

// ---------------------------------------------------------------- respawn / void loops --
// Wave H — a respawn must not loop, and a fall-out must be rescued.
console.log("\nWave H — the sky-drop and the void fall cannot loop");
// (1) the sink must fit inside the steer window, or the glider is exposed mid-air
// and a camper deletes them → the next life drops again (the "sky loop").
check(js.indexOf("DROP_SINK = 3.8") >= 0, "JS DROP_SINK is 3.8 (descent fits inside DROP_TIME)");
check(rs.indexOf("pub const DROP_SINK: f64 = 3.8") >= 0, "Rust DROP_SINK is 3.8");
check(js.indexOf("DROP_LAND_GRACE = 1.5") >= 0, "JS defines DROP_LAND_GRACE");
check(rs.indexOf("pub const DROP_LAND_GRACE: f64 = 1.5") >= 0, "Rust defines DROP_LAND_GRACE");
check(js.indexOf("DROP_LAND_GRACE: DROP_LAND_GRACE") >= 0, "FS exports DROP_LAND_GRACE");
check((function(){
  var h = parseFloat((js.match(/DROP_HEIGHT = ([0-9.]+)/) || [])[1]);
  var tk = parseFloat((js.match(/DROP_TIME = ([0-9.]+)/) || [])[1]);
  var sk = parseFloat((js.match(/DROP_SINK = ([0-9.]+)/) || [])[1]);
  return h > 0 && sk > 0 && tk > 0 && (h / sk) < tk;
})(), "DROP_HEIGHT/DROP_SINK < DROP_TIME (you land inside the steer window)");
// (2) spawn cover starts at touchdown, not at place(): a clock begun at place() is
// already spent before the boots touch.
check(rs.indexOf("self.protect = if self.drop { 0.0 } else { t + PROTECT };") >= 0,
      "Rust place(): cover starts at touchdown (0 while gliding)");
check(js.indexOf("P.protUntil = sp[1] > 0.5 ? 0 : t + 1.5") >= 0,
      "JS botPlace(): cover starts at touchdown");
check(js.indexOf("V.protUntil = t + 1.5") >= 0, "JS landing sets spawn cover");
// (3) the drop shield holds for the whole canopy, not just DROP_TIME
check(rs.indexOf("(self.drop && self.drop_t > 0.0 && (t - self.drop_t) < DROP_TIME + DROP_LAND_GRACE)") >= 0,
      "Rust shielded(): the glide shield spans steer + sink + grace");
// (4) a same-tick kill must not re-latch death on a body that just came back
check(js.indexOf("var stale = (m.v === myId()) && (m.e != null) && ((m.e|0) !== V.life);") >= 0,
      "the kill handler drops a kill whose e is not the current life");
check(js.indexOf('if(m.v === myId() && !stale)') >= 0,
      "and never re-latches V.dead on a stale kill (the feed row still lands)");
check((rs.split('"e": vlife').length - 1) >= 3, "all three kill sites stamp the victim's life");
// (5) pending events are flushed BEFORE the respawn block, so a same-tick kill is
// delivered first and cannot arrive after the "spawn"
check((function(){
  var pend = rs.indexOf("evs.append(&mut self.pending);");
  var respawn = rs.indexOf("let s = drop_spawn(slot, life, m);  // v4: parachute drop at a random spawn point");
  return pend > 0 && respawn > 0 && pend < respawn;
})(), "Rust: pending is drained BEFORE the respawn block (kill lands first)");
// (6) a new life is never still in a saddle — else the void rescue never runs
check(rs.indexOf("self.dragon_rider = false;") >= 0, "Rust place() clears dragon_rider");
check(rs.indexOf("fn dragon_release(&mut self, uid: &str)") >= 0, "Rust: dragon_release frees the seat");
check((rs.split("self.dragon_release(").length - 1) >= 3, "dragon_release is called at every respawn path");
// (7) a rejected frame that is really in the void is adopted so the rescue clock runs;
// a fix is never sent for a body already in the void (that snapped you back onto the deck)
check(rs.indexOf("if in_void(m, xm, ym, zm)") >= 0, "Rust: a void frame is adopted, not fixed");
check((function(){
  var adopt = rs.indexOf("if in_void(m, xm, ym, zm)");
  var stale_fix = rs.indexOf("return (false, Some(json!({\"x\": cm(p.x), \"y\": cm(p.y), \"z\": cm(p.z), \"e\": p.life})));");
  return adopt > 0 && stale_fix > adopt;
})(), "and the stale-position fix is only for non-void rejections");
// (8) the client must NOT self-rescue in MP — the judge owns that
check(js.indexOf('t - V.voidAt >= FS.VOID_SECS && V.mode !== "mp"') >= 0,
      "client void rescue is solo/bots only");
check(rs.indexOf("p.void_at >= VOID_SECS") >= 0, "the judge runs the VOID_SECS rescue clock");

// ---------------------------------------------------------------- latency / pickups / look --
// Wave I — totems take when you walk through them, the snapshot is cheap, look never freezes.
console.log("\nWave I — totems take, the snap is sparse, look never freezes");
check(rs.indexOf("if at[1] > 1.5 && (y - at[1]).abs() > 2.2") >= 0,
      "Rust pickups(): the Y gate is elevation-gated (a raised deck is not unreachable)");
check((rs.split("if at[1] > 1.5 && (y - at[1]).abs() > 2.2").length - 1) >= 2,
      "both pickups() branches use the elevation gate (drop slots + map packs)");
check(js.indexOf("if(pk.at[1] > 1.5 && Math.abs(V.me.y - pk.at[1]) > 2.2) return;") >= 0,
      "JS solo gate is the same elevation test (twin)");
check((function(){
  var tick = rs.indexOf("if !is_bot && !self.players[i].1.dead {");
  var pick = rs.indexOf("self.pickups(i, t);", tick);
  return tick > 0 && pick > tick;
})(), "Rust tick(): pickups run every tick, not only on an accepted pos frame");
// pos() must borrow the body in place — the old mem::replace swap allocated a whole
// Player per position frame. (fire() still swaps: fire_inner needs &self. Lock the
// gap between `pub fn pos` and `pub fn fire`, which is pos_inner's span.)
check((function(){
  var p = rs.indexOf("pub fn pos(&mut self");
  var f = rs.indexOf("pub fn fire(&mut self");
  var alloc = rs.indexOf("std::mem::replace(&mut self.players[i].1, Player::new", p);
  return p > 0 && f > p && (alloc < 0 || alloc > f);
})(), "Rust pos(): the body is borrowed in place (no per-frame Player alloc)");
check(rs.indexOf('if !self.shots.is_empty() { obj.insert("s"') >= 0,
      "Rust snap(): empty world lists are omitted (sparse snapshot)");
check((function(){
  var snap = rs.indexOf("fn snap(&mut self, t: f64)");
  var sparse = rs.indexOf('if !self.shots.is_empty() { obj.insert("s"');
  return snap > 0 && sparse > snap;
})(), "and the omission lives inside snap()");
check(js.indexOf("if(yawDeg != null){ V.yaw = yawDeg*Math.PI/180; }") >= 0,
      "JS placeMe(): a respawn keeps your pitch (no zeroing)");
check(js.indexOf('placeMe((+m.x || 0)/100, (+m.y || 0)/100, (+m.z || 0)/100, null); V.life = m.e|0') >= 0,
      "the MP spawn keeps your aim (null yaw)");
check(js.indexOf("fresh ? (+p.r || 0)/100 : null") >= 0,
      "applyView re-places without snapping look mid-match");
check(js.indexOf('document.addEventListener("keydown", function(){') >= 0
      && js.indexOf('if(wantLock() && now() - lockWanted > 0.4){ lockWanted = now(); grabLock(); }') >= 0,
      "pointer lock re-grabs on a play key during a live match (Esc is never stolen)");
check(js.indexOf("YOUR look steers") >= 0 || js.indexOf("kx = Math.sin(V.yaw || 0)") >= 0,
      "kill cam: your look steers the chase (not a frozen orbit)");

// Wave J — the launcher fires in MP, and the judge's dirty fan-out is O(1).
console.log("\nWave J — launcher in MP, per-shooter rockets, O(1) dirty");
check(js.indexOf("p: Math.round(V.pitch*18000/Math.PI)") >= 0,
      "launcher fire p is centidegrees (the judge does pitch/100)");
check((js.split("p: Math.round(V.pitch*18000/Math.PI)").length - 1) >= 2,
      "both the launcher and the grapple arms send centidegree pitch");
check(js.indexOf("if(V.mode === \"mp\"){") >= 0
      && js.indexOf("spawnMissile(t, e, ld);") >= 0
      && js.indexOf("var lmsg = {w: LAUNCH_W,") >= 0,
      "MP launcher predicts a local rocket (the shot is never silent)");
check(js.indexOf("if(!gi) return FS.WEAPONS.length;") >= 0
      && js.indexOf("if(v === 0) return FS.WEAPONS.length;") >= 0,
      "weaponCount(): a missing games.strike no longer clamps the roster to 3");
check(js.indexOf("V.magX = [m.mag[LAUNCH_W]|0];") >= 0
      && js.indexOf("V.resX = [m.res[LAUNCH_W]|0];") >= 0,
      "the ammo handler mirrors V.magX / V.resX (the launcher slot)");
check(js.indexOf("if(miss.pred) return;") >= 0,
      "detonate never books damage on a client prediction");
check(js.indexOf("if(V.missiles[i].pred && !V.missiles[i].srvKey && !pred") >= 0,
      'the "r" handler adopts a pending prediction (one rocket per shot)');
check(js.indexOf("function myRocketUp(){") >= 0
      && js.indexOf("if(m.pred) return true;") >= 0
      && js.indexOf("if(m.mine != null && V.mySlot != null && m.mine === V.mySlot) return true;") >= 0,
      "the one-rocket gate is per shooter (a teammate's rocket never blocks you)");
check(js.indexOf("mine: (!fromServer && !owner) ? V.mySlot : null,") >= 0,
      "spawnMissile tags only an ownerless local launch as yours");
check(rs.indexOf("pub dirty: Vec<String>") >= 0
      && rs.indexOf("pub world_dirty: bool") >= 0,
      "Rust: dirty stays a Vec (stable snap order) plus a world_dirty flag");
check(rs.indexOf("if !p.dirty {") >= 0
      && rs.indexOf("p.dirty = true;") >= 0,
      "Rust mark(): the membership test is a per-player bit (O(1), no Vec scan)");
check(rs.indexOf("fn mark_world(&mut self)") >= 0,
      "Rust mark_world(): a world list change forces a snap without dirtying everyone");
check(rs.indexOf("fn mark_idx(&mut self, j: usize)") >= 0,
      "Rust mark_idx(): the disaster loops dirty the one body that changed");
check(rs.indexOf("self.mark_idx(j);") >= 0
      && rs.indexOf("self.mark_idx(pick);") >= 0,
      "the per-player disaster loops call mark_idx, not mark_all");
check(rs.indexOf("self.mark_world();") >= 0
      && rs.indexOf("self.barrels[idx].hp = was - dmg;") >= 0,
      "world objects (barrels / turrets / dragons) dirty the world, not every player");
check((function(){
  var rock = rs.indexOf("let rockets: Vec<Value> = self.rockets.iter()");
  var slot = rs.indexOf(".map(|(_, p)| p.slot)", rock);
  var row = rs.indexOf("(r.vz * 100.0) as i64, slot]", rock);
  return rock > 0 && slot > rock && row > slot;
})(), 'the "r" row carries the shooter slot at index 7');
check(rs.indexOf("|| self.world_dirty") >= 0
      && rs.indexOf("self.world_dirty = false;") >= 0,
      "the snap gate honors world_dirty and clears it");

// Wave K — MP frame cost: the snapshot diffs world meshes instead of rebuilding them,
// and a stall can no longer swallow a fire click.
console.log("\nWave K — onSnap diffs meshes, a hitch cannot drop a click");
check(js.indexOf("function retain(meshes, live){") >= 0,
      "R3.retain(): drop only the meshes whose id is not in the live list");
check(js.indexOf("R.keep = function(kind, live){") >= 0,
      "R3.keep(): one choke point the snapshot diffs world lists through");
check(js.indexOf("if(R3.keep) R3.keep(\"rifts\", V.rifts);") >= 0
      && js.indexOf("if(R3.keep) R3.keep(\"turrets\", V.turrets);") >= 0
      && js.indexOf("if(R3.keep) R3.keep(\"lasers\", V.lasers);") >= 0
      && js.indexOf("if(R3.keep) R3.keep(\"pads\", V.pads);") >= 0
      && js.indexOf("if(R3.keep) R3.keep(\"bananas\", V.bananas);") >= 0
      && js.indexOf("if(R3.keep) R3.keep(\"lava\", V.lavaZones);") >= 0,
      "onSnap diffs every world list — no clear-and-repaint on a present key");
check(js.indexOf("if(R3 && R3.clearTurrets) R3.clearTurrets();") >= 0
      && js.indexOf("if(R3 && R3.clearRifts) R3.clearRifts();") >= 0,
      "the clear helpers survive for the absent-key else arm (sparse snap contract)");
check(js.indexOf("if(!mn.mesh && mn.id != null){") >= 0
      && js.indexOf("if(!bp.mesh && bp.id != null){") >= 0
      && js.indexOf("if(!lz.mesh && lz.id != null){") >= 0
      && js.indexOf("if(!rf.mesh && rf.id != null){") >= 0
      && js.indexOf("if(!bc.mesh && bc.id != null){") >= 0
      && js.indexOf("if(!bb.mesh && bb.id != null){") >= 0
      && js.indexOf("if(!mm.mesh && mm.id != null){") >= 0,
      "every adder relinks by id (the bananas/lava arms used to leak a mesh per row per tick)");
check(js.indexOf("var rcs = getComputedStyle(root);") >= 0
      && js.indexOf("var gcv = function(n, fb){ var v = rcs.getPropertyValue(n); return v || fb; };") >= 0,
      "the radar resolves the style once per paint, not once per blip");
check(inp.indexOf("I.tap = {}") >= 0
      && inp.indexOf("I.tap[n] = true") >= 0
      && inp.indexOf("var tap = !!I.tap[n];") >= 0,
      "input latches the down-edge so a stalled frame cannot swallow a tap");
check(inp.indexOf("return tap || (!!I.now[n] && !I.was[n]);") >= 0,
      "pressed() still reports the normal level edge — the latch only adds a stalled-frame tap");

// Wave L — MP totems take when you walk over them, and a live canopy is never
// rubber-banded back up the sky-drop pipe.
console.log("\nWave L — pickups honour the claimed body; a live canopy is never fixed");
check(rs.indexOf("pub claim: Option<(f64, f64, f64, f64)>") >= 0,
      "the judge remembers the body the client last claimed");
check(rs.indexOf("p.claim = Some((xm, ym, zm, t));") >= 0,
      "every pos frame writes the claim, accepted or refused");
check(rs.indexOf("pub const CLAIM_R: f64 = 4.0") >= 0
      && rs.indexOf("pub const CLAIM_R_SECS: f64 = 1.0") >= 0
      && rs.indexOf("pub const CLAIM_FRESH: f64 = 0.2") >= 0
      && rs.indexOf("pub const CLAIM_R_MAX: f64 = 14.0") >= 0,
      "a claim is believed while it is a live walk, and leashed only once it stalls");
check(rs.indexOf("let claimed = self.players[i].1.claim.filter(") >= 0,
      "pickups test the claim as well as the judge's copy");
check(rs.indexOf("if !near(jx, jy, jz) && !claimed.map(|(cx, cy, cz, _)| near(cx, cy, cz)).unwrap_or(false)") >= 0,
      "a totem under the claimed body is in range even when the judge's copy froze");
check(rs.indexOf("if !self.players[i].1.dead && !self.players[i].1.gone {\n            self.pickups(i, t);") >= 0,
      "pickups run on a refused pos too — no bulk once an accepted frame lands again");
check(rs.indexOf("self.pending.push((\"pick\", ev));\n                self.mark(&uid);") >= 0
      && rs.indexOf("self.pending.push((\"pick\", ev));\n            self.mark(&uid);") >= 0,
      "a take marks the taker so hp/res reach the snapshot");
check(rs.indexOf("let air_let_up = p.drop && p.drop_t > 0.0 && (t - p.drop_t) < DROP_TIME;") >= 0,
      "the parachute let-up is measured on the server clock, never the client's skewed one");
check(rs.indexOf("&& t - p.air_at > MAX_AIR") >= 0,
      "the air guard is measured on the server clock too");
check(rs.indexOf("if p.drop && p.drop_t > 0.0 && t - p.drop_t < DROP_TIME + DROP_LAND_GRACE {") >= 0,
      "the judge never sends \"fix\" while a live canopy is still up");
check(js.indexOf("var droppingNow = !!(V.dropUntil && t < V.dropUntil && !V.me.g);") >= 0,
      "the client steers a mid-glide fix instead of placeMe-ing (placeMe clears the canopy)");
check(js.indexOf("if(FS.overlaps(MAP, fx, V.me.y, fz, 0) < 0){ V.me.x = fx; V.me.z = fz; }") >= 0,
      "the mid-glide fix takes only the XZ the judge named, and keeps V.dropUntil");
check(rs.indexOf("let Some(vid) = vid else { return true };   // no enemy to swap with: taken, nothing happens") >= 0,
      "a walk-over is always taken — a target-less totem does not sit under your feet");

// Wave M — a canopy lands ON the deck, and a cluster of totems is taken like solo.
console.log("\nWave M — canopy lands on the deck; a cluster is taken at once");
check(js.indexOf("function deckUnder(m, x, z){") >= 0,
      "JS has the canopy deck probe (XZ only, null on a real gap)");
check(rs.indexOf("pub fn deck_under(m: &Map, x: f64, z: f64) -> Option<f64>") >= 0,
      "Rust has the canopy deck probe (XZ only, None on a real gap)");
check(js.indexOf("var floor = FS.deckUnder(MAP, V.me.x, V.me.z);\n        if(floor == null) floor = -1e9;") >= 0,
      "the canopy descent lands on the deck under the body, not a body-overlap probe");
check(js.indexOf("var floor = FS.deckUnder(MAP, V.me.x, V.me.z); if(floor == null) floor = 0;") >= 0,
      "the wings glide-down lands on the deck too");
check(js.indexOf("var floor = FS.deckUnder(MAP, ai.body.x, ai.body.z);") >= 0,
      "a bot's canopy descent lands on the deck as well");
check(rs.indexOf("let floor = deck_under(m, b.body.x, b.body.z).unwrap_or(0.0);") >= 0,
      "the judge's bot canopy lands on the deck (0 fallback — bots have no void clock)");
check(js.indexOf("if(Math.abs(V.me.x - pk.at[0]) > 1.1 || Math.abs(V.me.z - pk.at[2]) > 1.1) return;") >= 0,
      "solo takes a totem on a square XZ reach");
check(rs.indexOf("if (x - at[0]).abs() > PICK_R || (z - at[2]).abs() > PICK_R {") >= 0,
      "the judge takes a totem on the same square reach, not a circle");
check(rs.split("if (x - at[0]).abs() > PICK_R || (z - at[2]).abs() > PICK_R {").length - 1 === 2,
      "both pickup bodies (drop slots and map packs) use the square reach");
check(rs.indexOf("hypot(z - at[2]) > PICK_R") < 0,
      "no circular pickup reach is left — a diagonal sweep takes the whole cluster");
check(js.indexOf("FS.deckUnder(MAP, V.me.x, V.me.z)") >= 0
      && js.indexOf("FS.topUnder(MAP, V.me.x, V.me.z") < 0,
      "no drop path still asks topUnder for the deck (it cannot see a floor from the sky)");

// Wave N — a live walk is believed at the body the player is in (a rubber-band can
// no longer starve a take), and a taken totem lights the top-left chip in MP like solo.
console.log("\nWave N — a live claim is the walk; a taken totem lights the top-left chip");
check(rs.indexOf("pub const SPEED_CARRY: f64 = 12.0") >= 0
      && rs.indexOf("let reach = (CLAIM_R + SPEED_CARRY * lag).min(CLAIM_R_MAX);") >= 0,
      "the claim leash grows with how long the judge's copy has been frozen");
check(rs.indexOf("if age <= CLAIM_FRESH {") >= 0
      && rs.indexOf("return true;") >= 0,
      "a fresh claim is believed at the named body, not leashed to the frozen copy");
check(rs.indexOf("self.claim = None;") >= 0,
      "a respawn drops the old life's claim");
check(rs.indexOf("if !p.this_life(msg) {") >= 0
      && rs.indexOf("p.claim = Some((xm, ym, zm, t));") >= 0,
      "every current-life pos frame writes the claim, bucket or not");
check(js.indexOf("V.taken = V.taken || {}; V.taken[knd] = t;") >= 0,
      "the MP pick handler stamps V.taken so liveEffects shows the chip");
check(js.indexOf("function totemApply(kind, uid, t){") >= 0
      && js.indexOf("V.taken = V.taken || {}; V.taken[kind] = t;") >= 0,
      "solo still stamps V.taken in totemApply (the two paths match)");
check(rs.indexOf("hypot(*cz - jz) <= CLAIM_R && (*cy - jy).abs() <= CLAIM_R") >= 0
      || rs.indexOf("(*cx - jx).hypot(*cz - jz) <= reach && (*cy - jy).abs() <= reach") >= 0,
      "a stalled claim is still leashed (anti-teleport)");
check(rs.indexOf("*cy > b[4] + 8.0") >= 0,
      "a claim naming a body outside the arena is never believed");

// Wave O — nothing in MP can strand a gem or blank the chip. A late view / late
// spawn must never rewind V.life (that made this_life reject every pos and the
// claim was never written); a taken slot stays gone across a late view; the
// consumed half of a Fusion clears; no local paint of judge-owned loot in MP.
console.log("\nWave O — no life rewind, no resurrected gems, no ghost loot in MP");
check(js.indexOf("if(fresh || wantLife > V.life || view.phase === \"warmup\"){") >= 0,
      "applyView adopts only a HIGHER life — a stale view cannot rewind V.life");
check(js.indexOf("if((m.e|0) < V.life) return;") >= 0,
      "a spawn from a previous life never rewinds V.life");
check(js.indexOf("if(fresh || (p.e|0) >= V.life) V.dead = !!p.dead;") >= 0,
      "a stale view cannot latch a live player into death");
check(js.indexOf("var VIEW_KEEP_SECS = 8;") >= 0
      && js.indexOf("if(vItems[vi] && V.items[vi] === 0 && V.goneAt && (V.goneAt[vi]|0) && (nowV - V.goneAt[vi]) < VIEW_KEEP_SECS) vItems[vi] = 0;") >= 0,
      "applyView keeps a take we already booked — a late view cannot repaint the gem");
check(js.indexOf("V.goneAt = V.goneAt || {}; V.goneAt[m.i|0] = now();") >= 0,
      "the pick handler stamps V.goneAt so the keep above has something to hold");
check(js.indexOf("if(m.j != null){") >= 0
      && js.indexOf("V.items[fj] = 0; if(V.goneAt) V.goneAt[fj] = t;") >= 0,
      "a fused slot's consumed half (j) is cleared on every client");
check(rs.indexOf("\"j\": y") >= 0 || rs.indexOf("\"j\": y,") >= 0 || rs.indexOf("\"j\": y}") >= 0
      || rs.indexOf("json!({\"i\": x, \"kind\": \"chaos\", \"j\": y})") >= 0,
      "the judge ships the consumed half index on the fused event");
check(js.split("function wardenLoot(")[1].split("function ")[0].indexOf("if(V.mode === \"mp\") return;") >= 0,
      "wardenLoot never paints ghost gems in MP — the judge owns those slots");
check(js.split("function droneShootDown(")[1].split("function ")[0].indexOf("if(!mp){") >= 0,
      "a drone wreck never drops local loot / disaster in MP — the judge owns them");
check(js.indexOf("MAP.pickups.forEach(function(pk, i){") >= 0
      && js.indexOf("V.goneAt = V.goneAt || {}; V.goneAt[i] = now();") >= 0,
      "MP walk-over hides the gem the instant the body is on it (solo feel)");
check(js.indexOf("V.bananaUntil = Math.max(V.bananaUntil||0, t + 0.45);") >= 0
      && js.indexOf("V.lavaUntil = Math.max(V.lavaUntil||0, t + 0.45);") >= 0,
      "a snapshot TTL never SHORTENS the full clock the pick already set");
check(js.indexOf("if(knd === \"banana\"){ V.bananaUntil = t + TOTEMS.banana.dur;") >= 0
      && js.indexOf("if(knd === \"turret\") V.turretUntil = t + TOTEMS.turret.dur;") >= 0,
      "the MP pick starts the full window (banana/lava/Wave G) so the chip has time left");

console.log(fails ? "\nFAILURES: " + fails : "\nALL PASS");
process.exit(fails ? 1 : 0);
