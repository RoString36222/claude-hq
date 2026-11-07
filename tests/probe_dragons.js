/* Dragons: numbers, not claims.

   When The Warden rises it summons six elemental drift-wyrms — Fire, Crystal,
   Storm, Ice, Shadow, Golden — one of each, on the bounds ring. Players mount
   one with G; while mounted the only attack is the breath (30 dps, 4 s of spray,
   4 s of inhale). Guns are stowed. The Warden never hurts a dragon — the laser
   sweeps, the fist slams and the open hand all go right past a summon. Disasters
   deal a dragon the SAME damage they deal a fighter (1x, no 2x). Gunfire always
   hurts a dragon, even while the Warden lives. There is no out-of-bounds: a
   dragon flies anywhere. A dragon hurts nobody while the boss lives (patrol only). After he
   falls, untaken dragons roam and bite anyone; a bot claims an idle mount then.
   A ridden dragon stays under its rider, who breathes with left click. The kill
   feed names what fell the mount ("dragon:<cause>" — gunfire, a disaster, out of
   bounds …). The roster stays after the boss; only a match teardown clears it.
   A Commons-style pill ("G  Ride fire") appears in reach.

   Both judges carry the roster; the snapshot key is "drg". Art is the Commons
   pet drake build (games/hqpets.js wyvernModel, HQV.hqPets — original, no
   third-party characters), and nothing here touches the network.

   Run: node tests/probe_dragons.js */
var fs = require("fs");
var path = require("path");
var root = path.resolve(__dirname, "..");
var js = fs.readFileSync(root + "/games/strike.js", "utf8");
var rs = fs.readFileSync(root + "/backend/src/strike.rs", "utf8");

var fail = 0;
function check(name, ok, detail){
  console.log((ok ? "  PASS " : "  FAIL ") + name + (detail ? "  — " + detail : ""));
  if(!ok) fail++;
}
function twin(name, jsRe, rsRe){
  check(name, jsRe.test(js) && rsRe.test(rs),
        "js=" + jsRe.test(js) + " rs=" + rsRe.test(rs));
}

console.log("Dragons — the Warden's elemental roster");

// ---- 1. the six tiers, fire → golden, and the shared numbers ----
check("JS names six tiers fire→golden",
      /WARDEN_DRAGON_TIERS = \["fire", "crystal", "storm", "ice", "shadow", "golden"\]/.test(js),
      (js.match(/WARDEN_DRAGON_TIERS[^\n]*/) || [""])[0]);
check("Rust names the same six tiers",
      /WARDEN_DRAGON_TIERS: \[&str; 6\] = \["fire",\s*"crystal",\s*"storm",\s*"ice",\s*"shadow",\s*"golden"\]/.test(rs));
twin("WARDEN_DRAGON_N = 6 on both judges", /WARDEN_DRAGON_N = 6/, /WARDEN_DRAGON_N: usize = 6/);

// the twin numbers the user asked for, spelled once on each side
var NUMS = [
  ["DRAGON_HP", /DRAGON_HP = 300/, /DRAGON_HP: i64 = 300/],
  ["DRAGON_BREATH_DPS = 30", /DRAGON_BREATH_DPS = 30/, /DRAGON_BREATH_DPS: i64 = 30/],
  ["DRAGON_BREATH_SECS = 4.0", /DRAGON_BREATH_SECS = 4\.0/, /DRAGON_BREATH_SECS: f64 = 4\.0/],
  ["DRAGON_INHALE_SECS = 4.0", /DRAGON_INHALE_SECS = 4\.0/, /DRAGON_INHALE_SECS: f64 = 4\.0/],
  ["DRAGON_BREATH_LEN = 15.0", /DRAGON_BREATH_LEN = 15\.0/, /DRAGON_BREATH_LEN: f64 = 15\.0/],
  ["DRAGON_BREATH_W = 2.2", /DRAGON_BREATH_W = 2\.2/, /DRAGON_BREATH_W: f64 = 2\.2/],
  ["DRAGON_SPEED = 8.0", /DRAGON_SPEED = 8\.0/, /DRAGON_SPEED: f64 = 8\.0/],
  ["DRAGON_ROAM_SPEED = 3.0", /DRAGON_ROAM_SPEED = 3\.0/, /DRAGON_ROAM_SPEED: f64 = 3\.0/],
  ["DRAGON_BITE_R = 2.4", /DRAGON_BITE_R = 2\.4/, /DRAGON_BITE_R: f64 = 2\.4/],
  ["DRAGON_BITE_DMG = 14", /DRAGON_BITE_DMG = 14/, /DRAGON_BITE_DMG: i64 = 14/],
  ["DRAGON_BITE_CD = 1.4", /DRAGON_BITE_CD = 1\.4/, /DRAGON_BITE_CD: f64 = 1\.4/],
  ["DRAGON_CAT = 2.0", /DRAGON_CAT = 2\.0/, /DRAGON_CAT: f64 = 2\.0/],
  ["DRAGON_MOUNT_R = 6.0", /DRAGON_MOUNT_R = 6\.0/, /DRAGON_MOUNT_R: f64 = 6\.0/],
  ["DRAGON_SEAT = 0.42", /DRAGON_SEAT = 0\.42/, /DRAGON_SEAT: f64 = 0\.42/],
  ["DRAGON_BOT_MOUNT = 12.0", /DRAGON_BOT_MOUNT = 12\.0/, /DRAGON_BOT_MOUNT: f64 = 12\.0/],
];
NUMS.forEach(function(row){ twin(row[0], row[1], row[2]); });

// ---- 2. the roster lands with the boss, on the bounds ring ----
twin("summon plants the roster on the bounds ring",
     /function dragonSpawn\(t\)/, /fn dragon_tick/);
check("JS wardenSummon calls dragonSpawn",
      /function wardenSummon[\s\S]{0,2200}dragonSpawn\(t\)/.test(js));
check("Rust warden_summon pushes the roster",
      /fn warden_summon[\s\S]{0,2400}self\.dragons\.clear\(\);[\s\S]{0,1200}self\.dragons\.push\(Dragon/.test(rs));
check("six bodies, one per tier",
      /for\(var i = 0; i < n; i\+\+\)/.test(js) && /for i in 0\.\.WARDEN_DRAGON_N/.test(rs));
check("JS plants on the deck via holeGroundY",
      /var gy = holeGroundY\(p\[0\], p\[1\]\)/.test(js));
check("Rust plants on the deck via ground_y",
      /let y = ground_y\(self\.map\(\), x, z\);/.test(rs));

// ---- 3. mount / dismount on G only (E stays lean-to-peek), guns stowed while riding ----
check("JS: G is the mount key (E stays lean-to-peek)",
      /keys: \["KeyG"\]/.test(js) && /\["G", "mount \/ dismount dragon"\]/.test(js)
      && !/dragonNearOrMine/.test(js));
twin("mount / dismount ops exist",
     /MP\.send\("strike", "mount", \{d: \(best\.id\|0\), on: 1\}\)/,
     /"mount" => \{\n                sm\.mount\(uid, msg, t\);/);
check("JS holds the spray through a breathe op",
      /MP\.send\("strike", "breathe", \{d: \(D\.id\|0\)\}\)/.test(js));
check("Rust dispatches the breathe op",
      /"breathe" => \{\n                sm\.breathe\(uid, msg, t\);/.test(rs));
twin("the guns are stowed while riding",
     /function canShoot[\s\S]{0,400}dragonRiding\(t\)\) return false/,
     /fn fire_inner[\s\S]{0,900}\|\| p\.dragon_rider/);
check("bot guns are stowed too",
      /if self\.players\[i\]\.1\.dragon_rider/.test(rs) || /p\.dragon_rider/.test(rs));
check("Rust refuses fire while riding",
      /dragon_rider/.test(rs) && /fn fire_inner/.test(rs));

// ---- 4. the breath: 30 dps for 4 s, then a 4 s inhale (SMG hold, then reload) ----
check("JS breath opens on the trigger while riding",
      /dragonBreathe\(dt, t\)/.test(js) || /dragonBreathe\(dt,\s*t\)/.test(js));
check("JS spray window is short and self-renewing",
      /D\.sprayUntil = t \+ 0\.2/.test(js));
check("Rust spray window is short and self-renewing",
      /d\.spray_until = t \+ 0\.3/.test(rs));
check("JS starts the inhale when the tank runs dry",
      /D\.rechargeAt = t \+ DRAGON_INHALE_SECS/.test(js));
check("Rust starts the inhale when the tank runs dry",
      /d\.recharge_at = t \+ DRAGON_INHALE_SECS/.test(rs));
check("JS refills the tank after the inhale",
      /D\.breathLeft = DRAGON_BREATH_SECS/.test(js));
check("Rust refills the tank after the inhale",
      /self\.dragons\[i\]\.breath_left = DRAGON_BREATH_SECS/.test(rs));
// a fresh mount with an empty tank made the first click start the inhale instead of
// breathing ("click does nothing"). Both judges hand you a FULL tank.
check("JS hands you a mount with a FULL breath tank",
      /breathLeft: DRAGON_BREATH_SECS, rechargeAt: 0/.test(js)
      && /twin: strike\.rs spawn `breath_left: DRAGON_BREATH_SECS`/.test(js));
check("Rust hands you a mount with a FULL breath tank",
      /breath_left: DRAGON_BREATH_SECS,\s*\n\s*recharge_at: 0\.0/.test(rs));
// the inhale has to READ on the screen: a dead click is "reloading", not "broken"
check("JS says the mount is inhaling, with a bar that fills toward ready",
      /inhaling…/.test(js)
      && /hqpets-prompt-rl/.test(js)
      && /mountMeter\.style\.width/.test(js)
      && /clamp\(1 - \(ride\.rechargeAt - t\) \/ DRAGON_INHALE_SECS/.test(js));
check("the inhale seconds never re-announce the live region every tick",
      /mountSecs\.setAttribute\("aria-hidden", "true"\)/.test(js)
      && /mountTrack\.setAttribute\("aria-hidden", "true"\)/.test(js)
      && /dragonPrompt\(text, frac, secs\)/.test(js));
check("JS cone: along + widening half-width",
      /DRAGON_BREATH_LEN/.test(js) && /DRAGON_BREATH_W \* \(0\.35 \+ 0\.65 \* \(along \/ DRAGON_BREATH_LEN\)\)/.test(js));
check("Rust cone: along + widening half-width",
      /DRAGON_BREATH_W \* \(0\.35 \+ 0\.65 \* \(along \/ DRAGON_BREATH_LEN\)\)/.test(rs));
check("the cone never burns the saddle",
      /never burn your own saddle/.test(rs) || /D\.rider && \(isMe \? D\.riderIsMe/.test(js));

// ---- 5. disasters deal 1x; the Warden never hurts a dragon ----
check("JS: disasters deal a dragon the SAME damage as a fighter (no 2x)",
      !/dealt \*= 2/.test(js) && !/dealt \*=2/.test(js)
      && /Disasters deal a dragon the SAME damage they deal a fighter/.test(js));
check("Rust: disasters deal a dragon the SAME damage as a fighter (no 2x)",
      !/dealt \*= 2/.test(rs)
      && /No disaster multiplier — a disaster deals a dragon the SAME/.test(rs));
twin("the Warden never hurts a dragon (laser / slam / grip go right past)",
     /The Warden cannot hurt a dragon/,
     /The Warden cannot hurt a dragon/);
check("the laser path no longer bites a summon (no laserBit / laser_bit)",
      !/D\.laserBit/.test(js) && !/dr\.laser_bit/.test(rs));
check("no leftover half-life laser code",
      !/D\.hp\|0\) \/ 2/.test(js) && !/d\.hp as f64\) \/ 2\.0/.test(rs));
twin("a saddle is not a ground target for the floor laser",
     /the dragon eats the beam, not the rider/, /a fighter up in a saddle is not a ground target/);
twin("a saddle is not a ground target for the arm slam",
     /the fist hits the DECK/, /the fist hits the DECK/);
twin("a saddle is not a ground target for the gravity grip",
     /the open hand pulls ground fighters/, /the open hand pulls ground fighters/);

// ---- 6. no out-of-bounds: a dragon flies anywhere ----
check("JS: no dragonOOB helper remains",
      !/function dragonOOB/.test(js));
check("Rust: no out-of-bounds kill remains",
      !/dragon_kill\(i, "dragon-oob"/.test(rs)
      && !/d\.y > b\[4\] \+ DRAGON_CAT/.test(rs));
check("JS: no ceiling clamp on the mount",
      !/var top = b\[4\] \+ DRAGON_CAT/.test(js)
      && /No ceiling and no map edge/.test(js));
check("JS: the void rescue never yanks a dragon rider",
      /inVoid\(MAP, V\.me\.x, V\.me\.y, V\.me\.z\) && !dragonRiding\(t\)/.test(js));
check("Rust: pos_inner lets a dragon rider fly outside the map box",
      /A dragon rider flies anywhere/.test(rs)
      && /if p\.dragon_rider \{\n            dt >= 0\.0\n        \} else/.test(rs));
check("Rust: the void rescue skips a dragon rider",
      /&& !self\.players\[i\]\.1\.dragon_rider/.test(rs));
twin("the kill feed still carries the cause envelope for non-OOB deaths",
     /var how = "dragon:" \+ cc;/, /format!\("dragon:\{cause\}"\)/);

// ---- 7. untaken dragons roam and bite; bots claim an idle mount after the boss ----
check("JS roam bites anything on the ground",
      /function dragonRoam\(dt, t\)/.test(js) && /DRAGON_BITE_DMG/.test(js));
check("JS roam skips flyers",
      /qy\|0\) > \(\(D\.y\|0\) \+ 2\.2\)/.test(js));
check("Rust roam skips flyers",
      /q\.y > self\.dragons\[i\]\.y \+ 2\.2/.test(rs));
check("JS idle wander is deterministic (hashMatch, never Math.random)",
      /hashMatch\(\(D\.id\|0\) \* 71 \+ 13/.test(js) && !/Math\.random\(\)/.test(js.match(/function dragonRoam[\s\S]{0,1800}/)[0]));
check("Rust idle wander is deterministic (hash_match)",
      /hash_match\(\(self\.dragons\[i\]\.id as u32\)/.test(rs));
// While the Warden lives the summons are a calm pet: patrol, never chase or bite.
check("JS: no chase/bite while the Warden lives",
      /While the Warden lives a summons is a calm pet/.test(js) && /if\(V\.warden\) return;/.test(js));
check("Rust: no chase/bite while the Warden lives",
      /While the Warden lives a summons is a calm pet/.test(rs) && /if self\.warden\.is_none\(\)/.test(rs));
check("JS: no breath damage while the Warden lives",
      /No spray can hit anyone while the boss is up/.test(js) && /if\(V\.warden\) return;/.test(js));
check("Rust: no breath damage while the Warden lives",
      /No spray can hit anyone/.test(rs) && /if self\.warden\.is_none\(\)/.test(rs));
twin("a bot claims an idle mount after DRAGON_BOT_MOUNT (only after the boss)",
     /if\(cand && !V\.warden\) dragonMount/, /if self\.warden\.is_some\(\) \{\n            self\.mark_world\(\);\n            return;\n        \}/);
check("Rust bot-claim sets the rider flag",
      /dragon_rider/.test(rs) && /DRAGON_BOT_MOUNT/.test(rs));
check("JS: gunfire ALWAYS hurts a dragon once the boss is down",
      /Gunfire always hurts a dragon/.test(js) && /var dh = dragonScanHit\(e, d, end\)/.test(js));
check("Rust: gunfire ALWAYS hurts a dragon once the boss is down",
      /Gunfire always hurts a dragon/.test(rs)
      && /if let Some\(\(di, th\)\) = self\.dragon_scan_hit\(o, d, reach\)/.test(rs));
check("JS: a bot spends no shot on a summon while the Warden lives",
      /While The Warden lives a bot's bullet is for the boss alone/.test(js)
      && /if\(V\.warden\)\{[\s\S]{0,200}bot's bullet is for the boss alone/.test(js));
check("Rust: a bot spends no shot on a summon while the Warden lives",
      /While The Warden lives a bot's bullet is for the boss alone/.test(rs)
      && /if self\.warden\.is_some\(\) \{\n            let w_end/.test(rs));
check("JS: a player's shot takes the nearer body (dragon vs Warden)",
      /The nearer body takes the bullet/.test(js)
      && /dhB\.t < tW/.test(js));
check("Rust: a player's shot takes the nearer body (dragon vs Warden)",
      /The nearer body takes the bullet/.test(rs)
      && /th < wth/.test(rs));
check("the kill feed names what fell the mount (dragon:<cause>)",
      /var how = "dragon:" \+ cc;/.test(js) && /format!\("dragon:\{cause\}"\)/.test(rs));
check("the feed reads a dragon death as a sentence, not three bare words",
      /fell to " \+ envLabel\(f\.dis\)/.test(js)
      && /dragonDown\) kName = /.test(js)
      && /Your dragon fell to/.test(js));
check("a disaster cause reaches the feed, not a bare 'dragon'",
      /Mk\.dis \|\| dis \|\| "dragon-disaster"/.test(js)
      && /d\.kind, t\)/.test(rs));

// ---- 8. the snapshot: "drg" rows, mount_slot, degrade on old Arenas ----
twin("the snapshot carries a drg key",
     /"drg"/, /"drg"/);
check("JS row shape documented: id, tier, x, y, z, yaw, hp, max, mount_slot, breath_ms, recharge_ms, spray_ms",
      /mount_slot, breath_ms,/.test(js)
      && /recharge_ms, spray_ms/.test(js)
      && /recharge_ms, spray_ms/.test(rs));
check("Rust mounts the rider's slot, or -1",
      /mount_slot/.test(rs) && /-1/.test(rs));
check("JS degrades when an old Arena omits the key",
      /Array\.isArray\(m\.drg\)/.test(js));
check("JS clears the roster when the key is empty",
      /R3 && R3\.clearDragons\) R3\.clearDragons\(\)/.test(js));

// ---- 9. the roster STAYS after the boss; only a match teardown clears it ----
twin("dragonDismiss / dragon_dismiss exist for match teardown",
     /function dragonDismiss\(t, silent\)/, /fn dragon_dismiss\(&mut self\)/);
check("JS wardenDeath does NOT dismiss the roster",
      /function wardenDeath[\s\S]{0,900}the summons STAY/.test(js)
      && !/function wardenDeath[\s\S]{0,400}dragonDismiss\(/.test(js));
check("Rust warden_death does NOT dismiss the roster",
      /fn warden_death[\s\S]{0,900}the summons STAY/.test(rs)
      && !/fn warden_death[\s\S]{0,400}self\.dragon_dismiss\(\)/.test(rs));
check("MP clients do NOT dismiss on the warden-dead event",
      /m\.phase === "dead"[\s\S]{0,400}the summons stay/.test(js)
      && !/m\.phase === "dead"[\s\S]{0,200}dragonDismiss\(/.test(js));
check("a dismissed rider is set down, never killed",
      /you land on your feet/.test(js) && /p\.dragon_rider = false/.test(rs));
check("JS match teardown still clears the roster",
      /resetMatch[\s\S]{0,2500}dragonDismiss\(/.test(js));
check("Rust match teardown still clears the roster",
      /pub fn end[\s\S]{0,600}self\.dragon_dismiss\(\)/.test(rs));
check("after the boss an untaken dragon roams and bites anyone",
      /if\(V\.warden\) return;/.test(js) && /DRAGON_BITE_DMG/.test(js));
check("after the boss a ridden dragon stays under its rider (left-click breath only)",
      /canShoot[\s\S]{0,400}dragonRiding\(t\)\) return false/.test(js)
      && /click to breathe/.test(js));

// ---- 10. the Commons pet drake build (HQV.hqPets), original art only ----
check("JS maps each tier to the Commons pet species",
      /var DRAGON_PET = \{/.test(js)
      && /fire: "firedragon"/.test(js)
      && /golden: "golddragon"/.test(js));
check("JS builds each dragon from the pet model (hqPets.model / wyvernModel)",
      /HQV\.hqPets\.model\(/.test(js) || /P\.model\(THREE, \{species:/.test(js));
check("JS lazy-loads /games/hqpets.js the way the Pets panel does",
      /sc\.src = "\/games\/hqpets\.js"/.test(js)
      && /function dragonPetsWant\(/.test(js));
check("JS animates through hqPets.pose (breath jaw + wing modes)",
      /P\.pose\(Mo, st, at, quiet, null\)/.test(js)
      && /st\.anim = "breath"/.test(js)
      && /st\.anim = "fly"/.test(js));
check("JS has addDragon / moveDragons / clearDragons",
      /R\.addDragon = function\(D\)/.test(js)
      && /R\.moveDragons = function\(list\)/.test(js)
      && /R\.clearDragons = function\(\)/.test(js));
check("the box build is only a fallback when the pet module is missing",
      /dragonPetBuild\(D\) \|\| buildDragon\(D\)/.test(js)
      && /function buildDragon\(D\)/.test(js)
      && /var DRAGON_PAL = \{/.test(js));
check("Calm holds a still pose (hqPets calm flag)",
      /var quiet = \(typeof calm === "function"\) \? calm\(\) : false;/.test(js)
      && /P\.pose\(Mo, st, at, quiet, null\)/.test(js));
check("no third-party characters in the dragon art path",
      !/supercell|clash|dragonite|charizard|smaug|drogon/i.test(js));

// ---- 11. the dragon's own health bar + the shared facing convention ----
check("JS draws a per-dragon health bar from D.hp / D.max",
      /function dragonHpPlate\(/.test(js)
      && /function dragonHpBarSet\(/.test(js)
      && /dragonHpBarSet\(dp\.userData\.hpBar, D\.hp/.test(js));
check("JS paints the bar with the same canvas-plate idiom as tag() / dmgSprite()",
      /c\.width = 256; c\.height = 48/.test(js) || /c\.width = 256; c\.height = 64/.test(js));
check("JS uses pet-space forward (sin yaw, cos yaw) — the Commons +z convention",
      /var f = Math\.sin\(D\.yaw \|\| 0\), g = Math\.cos\(D\.yaw \|\| 0\)/.test(js)
      && /newYaw = Math\.PI - V\.yaw/.test(js));
check("Rust breath uses the same (sin, cos) forward",
      /self\.dragons\[i\]\.yaw\.sin\(\) \* 3\.2/.test(rs)
      && /self\.dragons\[i\]\.yaw\.cos\(\) \* 3\.2/.test(rs)
      && /let \(fx, gz\) = \(hyaw\.sin\(\), hyaw\.cos\(\)\)/.test(rs));
check("Rust makes the ridden mount follow its rider (no rubber-band onto a frozen body)",
      /self\.dragons\[i\]\.x = p\.x;/.test(rs)
      && /self\.dragons\[i\]\.y = p\.y - DRAGON_SEAT;/.test(rs)
      && /self\.dragons\[i\]\.yaw = std::f64::consts::PI -/.test(rs));
check("Rust still seats a bot (no client pos) on the mount",
      /p\.y = self\.dragons\[i\]\.y \+ DRAGON_SEAT;/.test(rs));
check("Rust lets a dragon rider stay in the air (no MAX_AIR rubber-band)",
      /let ride_let_up = p\.dragon_rider;/.test(rs)
      && /!ride_let_up/.test(rs));
check("JS keeps its own flight prediction on the mount it rides",
      /meRide \? mine\.x/.test(js) && /meRide \? mine\.yaw/.test(js));

// ---- 12. the Commons-style mount prompt (the option you see in the Commons) ----
check("JS shows a Commons-style mount pill",
      /hqpets-prompt/.test(js) && /function dragonPrompt\(/.test(js)
      && /G  Ride /.test(js) && /G  dismount · click to breathe/.test(js));
check("JS prompt is aria-live and hides when empty",
      /mountPrompt\.setAttribute\("aria-live", "polite"\)/.test(js)
      && /mountPrompt\.hidden = !text/.test(js));
check("JS prompt rides the positioned view wrapper (not the page root)",
      /wrap\.appendChild\(mountPrompt\)/.test(js));
check("JS prompt only offers an idle dragon in reach",
      /DRAGON_MOUNT_R/.test(js) && /if\(!D \|\| D\.dead \|\| D\.rider\) return;/.test(js));
// the HUD pill alone is easy to miss while walking up — the plate rides the beast
check("JS puts a world-space G Ride plate on every idle dragon",
      /function dragonMountPlate\(/.test(js)
      && /function dragonMountPlateSet\(dp, show, tier\)/.test(js)
      && /DRAGON_MOUNT_PLATE_Y/.test(js)
      && /dragonMountPlateSet\(dp, !D\.rider && !D\.dead,/.test(js)
      && /dragonMountPlateSet\(dp, !\(D\.rider \|\| D\.dead\), D\.tier \|\| "fire"\)/.test(js));
check("JS lights the HUD pill from further out than the bind itself",
      /var DRAGON_PROMPT_R = 16\.0/.test(js)
      && /bestD = DRAGON_PROMPT_R/.test(js)
      && /bestD = DRAGON_MOUNT_R/.test(js));

// ---- 13. the ride camera: 3rd person in the saddle, 1st person back on dismount ----
check("JS pulls the camera back and up while riding (Commons chase framing, tight enough to read the beast)",
      /DRAGON_CAM_BACK = 7\.5, DRAGON_CAM_UP = 3\.0/.test(js)
      && /camera\.position\.set\(M\.x - rfx\*DRAGON_CAM_BACK, M\.y \+ DRAGON_CAM_UP/.test(js));
check("JS still aims with your look yaw/pitch (the breath aims down it)",
      /camera\.rotation\.set\(V\.pitch \+ \(V\.dead \? -0\.3 : 0\), -V\.yaw/.test(js));
check("JS only rides the chase cam while a live dragon holds you",
      /var RIDING = !WP && !KC && dragonRiding\(t\)/.test(js)
      && /dragonRiding\(t\)[\s\S]{0,200}!V\.dead/.test(js));
check("JS restores first-person the moment you step off (the eye path is the else)",
      /else if\(RIDING\)\{[\s\S]{0,600}else \{\n[\s\S]{0,400}camera\.position\.set\(M\.x \+ plx, M\.y \+ ey/.test(js)
      && /function dragonDismount\(D, t, silent\)/.test(js));
check("the stowed gun never paints over the beast",
      /gunHold\.visible = !V\.dead && !sniper && !RIDING/.test(js)
      && /if\(!V\.watch && !KC && !RIDING\) renderer\.render\(vScene, vCam\)/.test(js));
check("no ADS zoom (a sniper's 14°) while you sit the saddle",
      /var wantFov = \(V\.ads && !RIDING\) \?/.test(js));
check("a dead pilot drops the saddle in the same tick",
      /if\(D && V\.dead\)\{ dragonDismount\(D, t, true\); D = null; \}/.test(js));
// the chase camera is third-person: R.render only draws others(), so a self-body
// must appear in the saddle (and stay out of the first-person lens).
check("JS draws YOUR body in the saddle (the chase cam is 3rd person)",
      /function ensureMeBody\(/.test(js)
      && /meBody = \{ch: ch, team: team/.test(js)
      && /if\(RIDING\)\{[\s\S]{0,400}ensureMeBody\(\)/.test(js)
      && /mm\.g\.position\.set\(M\.x, M\.y, M\.z\)/.test(js)
      && /mm\.g\.rotation\.y = Math\.PI - V\.yaw/.test(js));
check("JS keeps the self-body out of first-person / spectate / kill cam",
      /else if\(meBody && meBody\.mesh\)\{[\s\S]{0,80}meBody\.mesh\.g\.visible = false/.test(js)
      && /var RIDING = !WP && !KC && dragonRiding\(t\)/.test(js));
check("JS tears the self-body down with the rest of the dynamic art",
      /function dropMeBody\(\)/.test(js)
      && /dropMeBody\(\);/.test(js));

// ---- 13b. Commons flight feel: held speed, climb / dive / glide / hover, bank + pitch ----
check("JS carries a Commons flight table (game feel only, never a judge twin)",
      /var DRAGON_FLY = \{/.test(js)
      && /top: 10\.0, cruise: 8\.0, hover: 3\.0/.test(js)
      && /climb: 5\.5, sink: 4\.0, dive: 12\.0, diveGain: 2\.4, glide: 1\.1/.test(js)
      && /yawR: 1\.0, yawHover: 1\.8, bank: 0\.6/.test(js));
check("JS eases flight with springTo / wrapPi (the Commons helpers)",
      /function springTo\(x, goal, k, h\)/.test(js)
      && /function wrapPi\(a\)/.test(js));
check("JS holds a speed (W/S), climbs (Space), dives (Shift) and glides when neither",
      /if\(fwd > 0\) D\.tgt = Math\.min\(F\.top/.test(js)
      && /diving = lift < 0 && !hover, climbing = lift > 0/.test(js)
      && /hover \? 0 : -F\.glide/.test(js)
      && /F\.diveGain/.test(js));
check("JS noses the body up climbing and down diving, and banks into the turn",
      /D\.pitch = springTo\(D\.pitch \|\| 0, pGoal/.test(js)
      && /D\.roll = springTo\(D\.roll \|\| 0, clamp\(-yawRate/.test(js)
      && /dp\.rotation\.x = quiet \? 0 : -dpPitch/.test(js)
      && /dp\.rotation\.z = quiet \? 0 : dpRoll/.test(js));
check("JS picks the real wing mode: climb flaps big, dive folds, glide spreads",
      /D\.wing = climbing \? "climb" : diving \? "dive" : hover \? "hover" : "glide"/.test(js)
      && /st\.wing = D\.wing \|\|/.test(js)
      && /st\.ph = \(st\.ph \|\| 0\) \+ dts \* 3\.2/.test(js));
check("JS never exceeds the referee's rider cap (DRAGON_SPEED * 1.35)",
      /goalF = Math\.min\(goalF, DRAGON_SPEED \* 1\.35 - 0\.3\)/.test(js));
check("JS still strafes on A/D (player-right) and normalizes the diagonal like the walk model",
      /var lat = \(ax \|\| 0\) \* DRAGON_SPEED/.test(js)
      && /rgtX = Math\.cos\(V\.yaw\), rgtZ = Math\.sin\(V\.yaw\)/.test(js)
      && /if\(hl > hcap && hl > 0\)/.test(js));

// ---- 13c. the breath pours from the mouth: real particles, not just a jaw ----
check("JS pools Commons breath particles (hqPets.Fx) on the Strike scene",
      /function dragonFxPool\(\)/.test(js)
      && /P\.Fx\(THREE, scene\)/.test(js)
      && /function dragonBreathFx\(D, at, dts, quiet\)/.test(js));
check("JS emits from the posed mouth (M.mouthP) or the head cube",
      /Mo\.mouthP/.test(js) && /Mo\.P\.localToWorld/.test(js)
      && /function dragonHead\(D\)/.test(js));
check("JS breathes each tier's element (fire / ice / storm+zap / sparkle / wisp / glitter)",
      /var DRAGON_BREATH_FX = \{/.test(js)
      && /fire: "fire", crystal: "sparkle", storm: "storm"/.test(js)
      && /ice: "ice", shadow: "wisp", golden: "glitter"/.test(js)
      && /F\.emit\("fire"/.test(js) && /F\.zap\(/.test(js));
check("JS steps the flame pool every frame and tears it down with the scene",
      /dragonFx\.step\(dt\)/.test(js)
      && /dragonFx\.dispose\(\)/.test(js));
check("JS pours nothing under Calm (the jaw still opens)",
      /function dragonBreathFx\(D, at, dts, quiet\)\{[\s\S]{0,200}if\(!F \|\| quiet\) return/.test(js));
check("JS pours a full-fledged jet: many particles, fat additive sprites along the cone",
      /F\.emit\("fire", hx \+ f0 \* 0\.5, hy, hz \+ f1 \* 0\.5, 12,/.test(js)
      && /function dragonFlamePool\(\)/.test(js)
      && /function dragonFlameTick\(/.test(js)
      && /function dragonFlamesStep\(/.test(js)
      && /blending: THREE\.AdditiveBlending/.test(js)
      && /dragonFlamesStep\(dt, quiet\)/.test(js)
      && /dragonFlamesDispose\(\)/.test(js));
check("JS spray damage pays out on a fractional accumulator (never Math.round a fast frame to 0)",
      /breathAcc = \(V\.breathAcc \|\| 0\) \+ DRAGON_BREATH_DPS \* dt/.test(js)
      && /var dmg = Math\.floor\(V\.breathAcc\)/.test(js)
      && /Math\.floor\(P\.breathAcc\)/.test(js)
      && !/Math\.round\(DRAGON_BREATH_DPS/.test(js));
check("JS shows who the jet is hitting and how hard (hit marker + floating numbers)",
      /P\.hitWin = \(P\.hitWin \|\| 0\) \+ dmg/.test(js)
      && /V\.hitAt = t/.test(js)
      && /pushDmgNum\(P\.x, \(P\.y \|\| 0\) \+ 1\.2, P\.z, P\.hitWin\|0, false, t\)/.test(js)
      && /if\(P\.hitAcc >= 0\.25 && P\.hitWin > 0\)/.test(js));
check("the spray's damage numbers are only for YOUR jet — never every dragon's fight",
      /if\(D\.riderIsMe && !V\.watch\)/.test(js)
      && /else \{\n[\s\S]{0,80}P\.hitAcc = 0; P\.hitWin = 0;/.test(js));
check("the drg snapshot carries a real spray flag (tank left alone is NOT a spray)",
      /spray_ms/.test(rs) && /dr\.spray_until > t/.test(rs)
      && /r\.length > 11 \? \(\+r\[11\]\|\|0\) : 0/.test(js)
      && /sprayMs > 0 \? t \+ \(sprayMs\/1000\) : 0/.test(js)
      && !/:\s*\(\(\+r\[9\]\|\|0\) > 0 \? t \+ 0\.45 : 0\)/.test(js));
check("floating damage numbers are never orphaned in the scene (drop must dispose the sprite)",
      /function killDmgNums\(\)/.test(js)
      && /function pushDmgNum\(x, y, z, n, head, t\)/.test(js)
      && /while\(V\.dmgNums\.length > 12\)/.test(js)
      && /if\(old && old\.o\)/.test(js)
      && /killDmgNums\(\);/.test(js)
      && !/clearPlayers\(\);[\s\S]{0,120}V\.dmgNums = \[\]/.test(js));
check("Rust twin carries the same fractional breath payout (30 dps exactly)",
      /pub breath_acc: f64/.test(rs)
      && /p\.breath_acc \+= \(DRAGON_BREATH_DPS as f64\) \* dt/.test(rs)
      && /let dmg = p\.breath_acc\.floor\(\) as i64/.test(rs)
      && !/DRAGON_BREATH_DPS as f64\) \* dt\)\.round\(\)/.test(rs));

// ---- 14. privacy / egress: this feature is pure local ----
check("no new outbound fetch in the dragon module",
      !/https?:\/\//.test(js.match(/function dragonSpawn[\s\S]{0,2600}/)[0] || ""));
check("the dragon module never touches Math.random",
      !/Math\.random/.test(js.match(/function dragonRing[\s\S]{0,16000}/)[0] || ""));
check("the roster rides the existing local snapshot path",
      /"drg"/.test(js) && /onSnap|function snap|\.drg/.test(js));

console.log(fail === 0
  ? "Dragons — all checks green."
  : "Dragons — " + fail + " check" + (fail === 1 ? "" : "s") + " failed.");
process.exit(fail === 0 ? 0 : 1);
