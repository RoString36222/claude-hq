"""Strikezone: the browser and the Arena must agree on the dock and the rules.

games/strike/map.json and map-sandbar.json are mirrored byte-for-byte under
backend/data/ (the Arena embeds those with include_str!; the Python Arena is
gone). Shared geometry in games/strike.js (STRIKE-SHARED block) is locked against
backend/src/strike.rs constants. The JS half runs under node when it is installed
(the script goes over stdin: one argv string is capped at 128 KB on Linux).
Stdlib only."""
import json
import math
import os
import re
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STRIKE_JS = os.path.join(ROOT, "games", "strike.js")
STRIKE_RS = os.path.join(ROOT, "backend", "src", "strike.rs")
MAP = os.path.join(ROOT, "games", "strike", "map.json")
SERVER_MAP = os.path.join(ROOT, "backend", "data", "strike_map.json")
MAP_SAND = os.path.join(ROOT, "games", "strike", "map-sandbar.json")
SERVER_MAP_SAND = os.path.join(ROOT, "backend", "data", "strike_map_sandbar.json")
NODE = shutil.which("node")


def load_server():
    """The Arena judge is Rust-only now. Twin locks that still want numbers read
    them out of backend/src/strike.rs; behaviour locks live in backend/src/strike/tests.rs."""
    raise unittest.SkipTest("Python strike.py is gone — see backend/src/strike/tests.rs")


def read(p):
    with open(p, encoding="utf-8") as f:
        return f.read()


def block():
    return re.search(r"/\* STRIKE-SHARED BEGIN \*/(.*?)/\* STRIKE-SHARED END \*/", read(STRIKE_JS), re.S).group(1)


class StrikeSync(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # The Python judge is gone (Rust Arena only). Twin locks that still want
        # numbers read them out of backend/src/strike.rs; behaviour locks live in
        # backend/src/strike/tests.rs. Do not require strike.py to exist here.
        cls.strike = None

    def _need_py(self):
        """Behaviour locks that drive the judge need the Python module; it is gone."""
        if self.strike is None:
            self.skipTest("Python strike.py is gone — see backend/src/strike/tests.rs")

    def test_the_warden_is_a_mid_match_boss_with_no_pvp(self):
        """Pure file-text locks for The Warden (JS twin + Rust judge). No Python judge."""
        js = read(STRIKE_JS)
        rs = read(STRIKE_RS)
        # menu option sits next to Map view (2D)
        self.assertIn('check("Summon the Warden"', js)
        self.assertIn('check("Map view (2D)"', js)
        # host sends the option; practice never summons
        self.assertIn("warden: V.wardenOn ? 1 : 0", js)
        self.assertIn("warden.as_i64().map(|v| v != 0)", rs)
        # twin constants
        for name in (
            "WARDEN_TRIGGER", "WARDEN_HP_PER", "WARDEN_MIN_HP", "WARDEN_MAX_HP",
            "WARDEN_SLAB_R", "WARDEN_SLAB_ARM", "WARDEN_SLAB_R_HIT", "WARDEN_SLAB_CD",
            "WARDEN_LASER_WARN", "WARDEN_LASER_HOLD", "WARDEN_LASER_CD",
            "WARDEN_LASER_YAW0", "WARDEN_LASER_W", "WARDEN_DIS_CD", "WARDEN_CKPT",
            "WARDEN_BOX_WAIST", "WARDEN_BOX_CHEST", "WARDEN_BOX_HEAD", "WARDEN_BOX_ARM",
            "WARDEN_ARM_X", "WARDEN_ARM_DMG_MULT", "WARDEN_ARM_HP", "WARDEN_SLAB_WIRE",
            "WARDEN_CHECK_NAMES", "WARDEN_SCALE",
            "WARDEN_SEE_HEAD", "WARDEN_SEE_CHEST", "WARDEN_SEE_WAIST", "WARDEN_SEE_ARM",
            "WARDEN_SLAB_KNOCK", "WARDEN_SLAB_KNOCK_PUSH", "WARDEN_SLAB_BLAST_DMG",
            "WARDEN_LOOT_R0", "WARDEN_LOOT_RSPAN", "WARDEN_LOOT_RMIN",
            "DD_TOXIC_CHIP_DMG",
            "WARDEN_CORE_EXPOSE", "WARDEN_CORE_COVER_MULT", "WARDEN_CORE_HIT_MULT",
            "WARDEN_CK2_EXPOSE", "WARDEN_CK1_PUSH",
            "WARDEN_GRIP_CD", "WARDEN_GRIP_WARN", "WARDEN_GRIP_HOLD", "WARDEN_GRIP_PULL",
            "WARDEN_GRIP_R", "WARDEN_GRIP_MIN", "WARDEN_GRIP_SWEEP_DMG",
        ):
            self.assertIn(name, js, "JS missing " + name)
            self.assertIn(name, rs, "Rust missing " + name)
        # The Warden has no weak point: never the weapon head-crit; bots prefer the arm
        self.assertIn("var head = false, arm =", js)
        self.assertIn("let head = false;", rs)
        self.assertIn("WARDEN_SEE_ARM", js)
        self.assertIn("fn warden_aim", rs)
        self.assertIn("function wardenAim(", js)
        self.assertNotIn("WEAPONS[w].head", rs[rs.find("fn warden_hit"):rs.find("fn warden_hit") + 800])
        # multi-axis arm motion (not just top-down)
        self.assertIn("idleY", js)
        self.assertIn("piv.rotation.y", js)
        self.assertIn("elbow.rotation.x", js)
        self.assertIn("wardenGroup.rotation.y", js)
        self.assertIn("WARDEN_LOOT_R0 + hashMatch(seed, salt + 17) * WARDEN_LOOT_RSPAN", js)
        self.assertIn("WARDEN_LOOT_R0 + hash_match(seed, salt.wrapping_add(17)) * WARDEN_LOOT_RSPAN", rs)
        self.assertIn('"warden-slam"', js)
        self.assertIn('"warden-laser"', js)
        self.assertIn('"warden-slam"', rs)
        self.assertIn('"warden-laser"', rs)
        self.assertIn("envKiller", js)
        self.assertIn("FEED_TTL", js)
        # hit helpers and the mid-match tick
        for name in ("wardenBoxes", "wardenHit", "wardenBlast", "wardenAfterDamage",
                     "wardenLoot", "wardenDeath", "wardenSummon", "wardenTick"):
            self.assertIn("function " + name, js, "JS missing " + name)
        for name in ("warden_hit", "warden_blast", "warden_after_damage", "warden_loot",
                     "warden_death", "warden_summon", "warden_tick"):
            self.assertIn("fn " + name, rs, "Rust missing " + name)
        # snap key + event kind (never "ev")
        self.assertIn('"wd"', js)
        self.assertIn('"wd"', rs)
        self.assertIn('m.ev === "warden"', js)
        self.assertIn('"warden"', rs)
        self.assertIn("wd[11]", js)
        self.assertIn("yaw-cdeg", rs)
        # loot is a ring of non-disaster totems + one health pack
        self.assertIn("WARDEN_FRACS", js)
        self.assertIn("FRACS", rs)
        self.assertIn("hashMatch(seed, salt)", js)
        self.assertNotIn("Math.random(", re.sub(r"/\*.*?\*/", "", re.sub(r"//.*?$", "", js, flags=re.M), flags=re.S))
        # checkpoints exclude disasters
        self.assertIn('"warden-pack"', js)
        self.assertIn('"warden"', rs)
        # bots must find a visible hit height (head/chest/waist) — never LOS only the
        # chest into the centre blocks and stand there refusing to fire
        self.assertIn("function wardenSee", js)
        self.assertIn("fn warden_see", rs)
        self.assertIn("wardenSee(", js)
        self.assertIn("warden_see(", rs)
        self.assertIn("heavyArm", js)  # the arms hinge at the elbow before a slam
        self.assertIn("elbow.rotation.x = -eK", js)  # folds toward the body, not backwards
        self.assertIn("wardenLaser", js)  # the laser eyes are drawn
        self.assertIn("mapLaserRun", js)  # the ground beam stops at the map edge
        self.assertIn("map_laser_run", rs)
        self.assertIn("wardenDustBurst", js)  # the slam blows dust
        self.assertIn("WARDEN_SLAB_KNOCK_PUSH", js)  # and blows people away
        # Exposed Core: plated torso, slam opens the chest (Rust-authoritative mults)
        self.assertIn("function wardenBodyMult", js)
        self.assertIn("fn warden_body_mult", rs)
        self.assertIn("coreUntil", js)
        self.assertIn("core_until", rs)
        self.assertIn("WARDEN_CORE_HIT_MULT", js)
        self.assertIn("WARDEN_CORE_HIT_MULT", rs)
        self.assertIn('"warden-grip"', js)
        self.assertIn('"warden-grip"', rs)
        self.assertIn("ms_core", js)
        self.assertIn("ms-core", rs)
        # the Strikezone welcome card spells the boss out under its own heading
        self.assertIn('"The Warden"', js)
        self.assertIn("Summon the Warden", js)
        # The Warden stands ON the deck, not buried at y=0: every hit volume and
        # LOS probe is measured from the ground under it (the dockyard centre is
        # a raised platform). Both sides carry the same ground helper + offset.
        self.assertIn("function holeGroundY", js)
        self.assertIn("pub fn ground_y", rs)
        # A canopy lands ON the deck: topUnder needs the body to already overlap a
        # box, so a probe from DROP_HEIGHT never sees the floor and the whole
        # descent sinks below the map. deckUnder/deck_under scan by XZ alone and
        # return null on a real gap (never a phantom y=0 floor over water).
        self.assertIn("function deckUnder(m, x, z){", js)
        self.assertIn("pub fn deck_under(m: &Map, x: f64, z: f64) -> Option<f64>", rs)
        self.assertIn("var floor = FS.deckUnder(MAP, V.me.x, V.me.z);", js)
        self.assertIn("deck_under(m, b.body.x, b.body.z).unwrap_or(0.0)", rs)
        self.assertIn("function wardenGY", js)
        self.assertIn("gy: f64", rs)
        self.assertIn("wardenGY(W)", js)
        self.assertIn("wd.gy +", rs)
        self.assertIn("gy + y0", rs)  # hit volumes lift with the deck
        # The skirt is 18.6 m wide and the raised centre is only 8 m — plant the
        # base at the FLOOR under the skirt rim, not the platform top ("floating").
        self.assertIn("function wardenGroundY", js)
        self.assertIn("pub fn warden_ground_y", rs)
        self.assertIn("wardenGroundY(cx, cz)", js)
        self.assertIn("warden_ground_y(self.map(), cx, cz)", rs)
        # Disco: The Warden dances too when it is up — same window, attacks held.
        self.assertIn("function wardenDanceOn", js)
        self.assertIn("dance_until: f64", rs)
        self.assertIn("V.warden.danceUntil = t + d", js)
        self.assertIn("wd.dance_until = t + DISCO", rs)
        self.assertIn("ms_dance", js)
        self.assertIn("ms-dance", rs)
        # ---- Dragons: six elemental mounts the Warden summons (fire → golden) ----
        for name in (
            "WARDEN_DRAGON_N", "WARDEN_DRAGON_TIERS", "DRAGON_HP",
            "DRAGON_BREATH_DPS", "DRAGON_BREATH_SECS", "DRAGON_INHALE_SECS",
            "DRAGON_BREATH_LEN", "DRAGON_BREATH_W", "DRAGON_SPEED", "DRAGON_ROAM_SPEED",
            "DRAGON_BITE_R", "DRAGON_BITE_DMG", "DRAGON_BITE_CD", "DRAGON_CAT",
            "DRAGON_MOUNT_R", "DRAGON_BOT_MOUNT", "DRAGON_SEAT",
        ):
            self.assertIn(name, js, "JS missing " + name)
            self.assertIn(name, rs, "Rust missing " + name)
        # a fresh mount hands you a FULL breath tank on BOTH judges — an empty one made
        # the first click start the inhale instead of breathing ("click does nothing")
        self.assertIn("breathLeft: DRAGON_BREATH_SECS", js)
        self.assertIn("breath_left: DRAGON_BREATH_SECS", rs)
        # the inhale reads on screen (the mount pill): words + a bar that fills toward ready
        self.assertIn("inhaling…", js)
        self.assertIn("hqpets-prompt-rl", js)
        # spawn / tick / hit / mount helpers on both sides
        for name in ("dragonSpawn", "dragonTick", "dragonHurt", "dragonKill",
                     "dragonTryMount", "dragonScanHit", "dragonBoxes",
                     "dragonBreathStep", "dragonRoam", "dragonDisaster"):
            self.assertIn("function " + name, js, "JS missing " + name)
        for name in ("dragon_tick", "dragon_hurt", "dragon_kill", "mount",
                     "dragon_scan_hit", "dragon_boxes", "breathe"):
            self.assertIn("fn " + name, rs, "Rust missing " + name)
        # snapshot key + mount slot (old Arenas omit "drg" — client degrades)
        self.assertIn('"drg"', js)
        self.assertIn('"drg"', rs)
        self.assertIn("mount_slot", js)
        self.assertIn("mount_slot", rs)
        self.assertIn('"mount"', js)
        self.assertIn('"mount"', rs)
        self.assertIn('"breathe"', js)
        self.assertIn('"breathe"', rs)
        # breath is the only attack while mounted; disasters deal a dragon the
        # SAME damage they deal a fighter (1x — no 2x multiplier on either judge)
        self.assertIn("dragonRiding(t)) return false", js)
        self.assertIn("|| p.dragon_rider", rs)
        self.assertNotIn('source === "dis") dealt *= 2', js)
        self.assertNotIn("dealt *= 2", js)
        self.assertNotIn("dealt *= 2;", rs)
        self.assertNotIn("if dis {\n                dealt *= 2;", rs)
        # the Warden never hurts a dragon: laser / slam / grip skip the roster
        self.assertIn("The Warden cannot hurt a dragon", js)
        self.assertIn("The Warden cannot hurt a dragon", rs)
        # gunfire always hurts a dragon — but a bot spends no shot on a summon
        # while The Warden lives (the boss is the target), and a player's shot
        # takes the nearer body: a dragon in front of the boss eats the bullet,
        # one behind the boss does not.
        self.assertIn("Gunfire always hurts a dragon", js)
        self.assertIn("Gunfire always hurts a dragon", rs)
        self.assertIn("var dh = dragonScanHit(e, d, end);", js)
        self.assertIn("if let Some((di, th)) = self.dragon_scan_hit(o, d, reach)", rs)
        self.assertIn("While The Warden lives a bot's bullet is for the boss alone", js)
        self.assertIn("While The Warden lives a bot's bullet is for the boss alone", rs)
        self.assertIn("The nearer body takes the bullet", js)
        self.assertIn("The nearer body takes the bullet", rs)
        self.assertIn("dhB.t < tW", js)
        self.assertIn("th < wth", rs)
        # a dragon death names what fell it: "dragon:<cause>" on both judges,
        # and the feed says it as a sentence ("Your dragon fell to gunfire · You")
        self.assertIn('var how = "dragon:" + cc;', js)
        self.assertIn('format!("dragon:{cause}")', rs)
        self.assertIn('fell to " + envLabel(f.dis)', js)
        self.assertIn("dragonDown) kName = ", js)
        self.assertIn("Your dragon fell to", js)
        # ride the saddle: G / "interact" (never a taken bit — 1<<31 breaks JS).
        # E is the Commons mount key; G is the Strike extra. Both land on "interact".
        self.assertIn('keys: ["KeyG"]', js)
        self.assertIn('["G", "mount / dismount dragon"]', js)
        self.assertNotIn('dragonNearOrMine', js)
        self.assertIn("DRAGON_SEAT", js)
        self.assertIn("DRAGON_SEAT: f64", rs)
        # the summons STAY after the boss: untaken ones roam and bite anyone,
        # ridden ones stay under their rider. Only match teardown clears the roster.
        self.assertIn("function dragonDismiss", js)
        self.assertIn("fn dragon_dismiss", rs)
        self.assertIn("the summons STAY", js)
        self.assertIn("the summons STAY", rs)
        self.assertIn("self.dragon_dismiss()", rs)  # called from Strike::end
        # while the Warden lives a dragon hurts nobody (patrol only) and the
        # Warden never hurts a dragon — but gunfire always can
        self.assertIn("Gunfire always hurts a dragon", js)
        self.assertIn("No spray can hit anyone while the boss is up", js)
        self.assertIn("While the Warden lives a summons is a calm pet", js)
        self.assertIn("While the Warden lives a summons is a calm pet", rs)
        # bots claim a mount only after the boss
        self.assertIn("if(cand && !V.warden) dragonMount", js)
        # the Commons-style mount prompt
        self.assertIn("hqpets-prompt", js)
        self.assertIn("function dragonPrompt", js)
        self.assertIn("G  Ride ", js)
        # art: the SAME drake build as the Commons pet (games/hqpets.js wyvernModel),
        # lazy-loaded the way ui/app/40-pets.js does; boxes only if that module is missing
        self.assertIn("var DRAGON_PET", js)
        self.assertIn('fire: "firedragon"', js)
        self.assertIn('golden: "golddragon"', js)
        self.assertIn('sc.src = "/games/hqpets.js"', js)
        self.assertIn("function dragonPetsWant", js)
        self.assertIn("dragonPetBuild(D) || buildDragon(D)", js)
        self.assertIn("P.pose(Mo, st, at, quiet, null)", js)
        # every beast carries its own health bar (canvas plate, like the player tag)
        self.assertIn("function dragonHpPlate", js)
        self.assertIn("function dragonHpBarSet", js)
        self.assertIn("dragonHpBarSet(dp.userData.hpBar", js)
        # the Commons +z facing: pet yaw is PI - the player's look yaw on both judges
        self.assertIn("Math.PI - V.yaw", js)
        self.assertIn("std::f64::consts::PI -", rs)

    def test_drones_and_the_grappling_gun(self):
        """Match flight drones + player-only zero-damage grapple (file-text twins)."""
        js = read(STRIKE_JS)
        rs = read(STRIKE_RS)
        src = block()
        # roster: grapple is a NEW index; the launcher keeps LAUNCH_W / the rocket path
        self.assertIn('{id: "grapple"', src)
        self.assertIn('damage: 0', src)
        self.assertIn("GRAPPLE_W = 4", src)
        self.assertIn("LAUNCH_W = 3", src)
        self.assertIn("BOT_WEAPON_MAX", src)
        self.assertIn("pub const NW: usize = 5", rs)
        self.assertIn("pub const GRAPPLE_W: usize = 4", rs)
        self.assertIn("pub const LAUNCH_W: usize = 3", rs)
        self.assertIn("pub const BOT_WEAPON_MAX: usize = 4", rs)
        self.assertIn('id: "grapple"', rs)
        self.assertIn("damage: 0, head: 0, mag: 5", rs)
        # every rocket path names the launcher, not NW-1 (which would become the grapple)
        self.assertNotIn("if w == NW - 1", rs)
        self.assertIn("if w == LAUNCH_W", rs)
        self.assertIn("if(V.w === LAUNCH_W)", js)
        self.assertIn("if(V.w === GRAPPLE_W)", js)
        # bots never roll the grapple
        self.assertIn("BOT_WEAPON_MAX", js)
        self.assertIn("* BOT_WEAPON_MAX as f64", rs)
        self.assertIn("P.w !== GRAPPLE_W", js)
        # match drones: deterministic lanes from map bounds (no Math.random)
        self.assertIn("function grappleRoutes", js)
        self.assertIn("fn grapple_routes", rs)
        self.assertIn("function droneHit", js)
        self.assertIn("fn drone_hit", rs)
        self.assertIn("DRONE_Y = 7.5", src)
        self.assertIn("DRONE_N = 8", src)
        self.assertIn("pub const DRONE_N: usize = 8", rs)
        self.assertIn("pub const DRONE_Y: f64 = 7.5", rs)
        # wings-style climb: never snap the shooter to drone altitude
        self.assertIn("GRAPPLE_RISE", src)
        self.assertIn("pub const GRAPPLE_RISE: f64 = 4.0", rs)
        self.assertNotIn("V.me.y = cd[1]", js)
        self.assertNotIn("p.y = c[1]", rs)
        # foe hook: victim cannot shoot; FLAG_HOOK on the snap row
        self.assertIn("HOOK_LOCK", src)
        self.assertIn("pub const FLAG_HOOK: i64 = 67_108_864", rs)
        self.assertIn("FLAG_HOOK", js)
        self.assertIn("67108864", js)
        self.assertIn("V.hookUntil && t < V.hookUntil) return false", js)
        self.assertIn("p.hook_until > t", rs)
        self.assertIn("hook_until", rs)
        self.assertIn("swing_until", rs)
        self.assertIn("swing_let_up", rs)  # air-guard let-up like the wings totem
        self.assertIn('"dr"', js)
        self.assertIn('"dr"', rs)
        # zero damage on the grapple row; 5 hooks, crates refill via pack
        self.assertEqual(
            re.search(r'id: "grapple"[^}]+damage: 0[^}]+mag: 5', src) is not None
            or re.search(r'id: "grapple".{0,120}damage: 0', src, re.S) is not None,
            True)
        self.assertIn("pack: 5", src)
        self.assertIn("pack: 5", rs)
        # welcome card names drones + the grapple
        self.assertIn("grappling gun", js)
        self.assertIn("Grappling gun", js)

    def test_drones_can_be_shot_down_loot_and_detaches_the_swing(self):
        """3.37.2 user ask: a shot-down drone drops 3 non-disaster totems at the wreck,
        detaches anyone swinging on that hull (they fall as if the drone never existed),
        and fires a random disaster. Both judges must do it."""
        js = read(STRIKE_JS)
        rs = read(STRIKE_RS)
        # the shoot-down helpers on the client
        self.assertIn("DRONE_DOWN_SECS = 6", js)
        self.assertIn("DRONE_TOTEMS = 3", js)
        self.assertIn("function nonDisTotems(", js)
        self.assertIn("function droneTotemDrop(", js)
        self.assertIn("function droneDetach(", js)
        self.assertIn("function droneShootDown(", js)
        # the shooter records which hull it is on, so a down can detach it
        self.assertIn("V.hookDrone", js)
        self.assertIn("hook_drone", rs)
        self.assertIn("pub hook_drone: Option<usize>", rs)
        # on shoot-down: detach + 3 non-disaster totems + a random disaster
        self.assertIn("droneDetach(D, t);", js)
        self.assertIn("droneTotemDrop(x, z, s, t);", js)
        self.assertIn("disStart(dkind, t);", js)
        # MP: the judge owns the wreck loot and the disaster — a local drop would
        # append ghost gems past the rings that no "pick" can ever clear
        shoot = js.split("function droneShootDown(")[1].split("function ")[0]
        self.assertIn("var mp = V.mode === \"mp\";", shoot)
        self.assertIn("if(!mp){", shoot)
        self.assertNotIn("droneTotemDrop", shoot.split("if(!mp){")[0], "loot must be inside the !mp gate")
        self.assertIn("pub fn drone_down(&mut self, di: usize", rs)
        self.assertIn("fn drone_totem_drop(", rs)
        self.assertIn("fn drone_detach(", rs)
        self.assertIn("self.start_disaster(dkind, t);", rs)
        self.assertIn("DRONE_TOTEMS: usize = 3", rs)
        self.assertIn("DRONE_DOWN_SECS: f64 = 6.0", rs)
        # the drop never rolls a disaster kind (those have their own ring)
        self.assertIn("!DISASTERS.contains(k)", rs)
        self.assertIn("nonDisTotems", js)
        # the bullet path ray-tests the match drones in every mode that has them
        self.assertIn("droneShootDown(aimedDrone, aimedDPos, t);", js)
        self.assertIn("if let Some((end, di, c)) = best {", rs)
        self.assertIn("self.drone_down(di, c, t);", rs)
        # the grapple skips a wreck and the snap ships a down flag (index 4)
        self.assertIn("downed", rs)
        self.assertIn("downUntil", js)
        self.assertIn("down_ms", rs)

    def test_a_second_drone_never_overwrites_the_first_wrecks_loot(self):
        """User bug: "when i destroy any drone, it drops totems, then when i destroy
        another drone, old totems (dropped by previous drone) are removed". Drone loot
        must land in one-shot slots appended past the drop rings (the Warden loot rule),
        never the recycled totem ring — so a later drone appends more, it never
        overwrites an unclaimed wreck's totems. They stay until someone takes them."""
        js = read(STRIKE_JS)
        rs = read(STRIKE_RS)
        # the client's drone drop appends past MAP.pickups, never the recycled ring
        self.assertIn("var idx = MAP.pickups.length;", js)
        self.assertNotIn("pl.totems[0] + (totemCount - 1) % DROP_SLOTS",
                         js.split("function droneTotemDrop")[1].split("function droneDetach")[0])
        # and it no longer bumps the shared totem counter (that one drives the ring)
        self.assertNotIn("totemCount", js.split("function droneTotemDrop")[1].split("function droneDetach")[0])
        # the judge appends too: kinds.push / items.push / spots.push, no DROP_SLOTS wrap
        drop_fn = rs.split("fn drone_totem_drop")[1].split("fn drone_detach")[0]
        self.assertIn("self.kinds.push(kind);", drop_fn)
        self.assertIn("self.items.push(None);", drop_fn)
        self.assertIn("self.spots.push([tx, 0.0, tz]);", drop_fn)
        self.assertNotIn("% DROP_SLOTS", drop_fn)
        self.assertNotIn("self.totem_k", drop_fn)
        # the slot is taken (not respawned in place) exactly like the Warden's loot ring
        self.assertIn("self.items[j] = Some(t + 1e9);", rs)

    def test_disasters_run_concurrently_and_the_log_shows_them(self):
        """3.37.2 user ask: "there is no thing that only 1 disaster can happen at a
        time, multiple can happen too at same time, just their logs should be shown
        there so players can know what all is happening"."""
        js = read(STRIKE_JS)
        rs = read(STRIKE_RS)
        # the client keeps a LIST of live disasters (never one slot)
        self.assertIn("V.disasters", js)
        self.assertIn("V.disasters.push(D)", js)
        self.assertIn("V.disasters.length > 6", js, "cap at DIS_MAX")
        self.assertIn("V.disasterLog", js, "the HUD log of what is happening")
        self.assertIn("function disLog(", js)
        self.assertIn("vg-fps-dis-log", js)
        self.assertIn("function disStart(", js)
        self.assertIn("function disClear(t, kind)", js, "clear one kind, not all")
        self.assertIn("function disKindLive(", js)
        # the auto-clock does NOT refuse while one is live
        self.assertIn("pub disasters: Vec<Disaster>", rs)
        self.assertIn("DIS_MAX: usize = 6", rs)
        self.assertIn("pub fn start_disaster(&mut self, kind: &'static str, t: f64) -> bool", rs)
        self.assertIn("fn disaster_live(&self, kind: &str, t: f64) -> bool", rs)
        self.assertIn("self.disasters.push(", rs)
        self.assertIn("self.disasters.retain", rs, "expire finished ones one by one")
        # the snap "di" is a list of rows — one per live disaster
        self.assertIn('json!([[Value::Null, 0, 0, 0, dis_next]])', rs)
        self.assertIn("let rows: Vec<Value> = self", rs)
        # and each row carries its kind so the client can start/stop per-kind FX
        self.assertIn("fxList", js)
        self.assertIn("fxStart(kind, D)", js)
        self.assertIn("fxStop(kind)", js)
        self.assertIn("fxTick(dt, t, quiet)", js)
        self.assertIn("R.disaster = function", js)

    def test_map_file_is_mirrored(self):
        for a, b in ((MAP, SERVER_MAP), (MAP_SAND, SERVER_MAP_SAND)):
            with open(a, "rb") as fa, open(b, "rb") as fb:
                self.assertEqual(fa.read(), fb.read(), "copy %s to %s" % (a, b))

    def test_totem_clock_drops_and_the_mole_needs_a_bot(self):
        self._need_py()
        f = self.strike
        s = f.Strike()
        self.assertIsNone(s.start({"u0": {"id": "u0"}, "u1": {"id": "u1"}}, 5, 30, 0.0, 2))
        t = f.COUNTDOWN
        s.tick(t, True)
        self.assertEqual(s.phase, "round")
        totems = 0
        t += f.TOTEM_FIRST + 0.05
        for ev, _ in s.tick(t, True):
            if ev == "totem":
                totems += 1
        self.assertEqual(totems, 1, "exactly one totem lands TOTEM_FIRST into the round")
        n_map = len(s.m["pickups"])
        self.assertEqual(len(s.items), n_map + f.DROP_SLOTS + f.PACK_SLOTS,
                         "the drop rings exist past the map's packs, all match long")
        self.assertIn(s.kinds[n_map], f.TOTEM_KINDS, "the kind is one of the five")
        self.assertIsNone(s.items[n_map], "the fresh totem slot starts live")

    def test_drops_repeat_from_recycled_slots(self):
        self._need_py()
        # totems and loose packs are two independent clocks; each drop replaces the OLDEST
        # slot of its ring (taken or not), so drops keep coming and the map never fills up
        f = self.strike
        s = f.Strike()
        self.assertIsNone(s.start({"u0": {"id": "u0"}, "u1": {"id": "u1"}}, 5, 30, 0.0, 2))
        t = f.COUNTDOWN
        s.tick(t, True)
        n_map = len(s.m["pickups"])
        totem_slots = set()
        pack_slots = set()
        # run 4 totem gaps + 5 pack gaps, ticking at HZ like the real loop: 4 totems over
        # 3 slots, 5 packs over 2 slots
        end = t + f.TOTEM_FIRST + f.TOTEM_GAP * 4 + f.PACK_GAP * 5 + 0.5
        while t < end:
            t += 1.0 / f.HZ
            for ev, d in s.tick(t, True):
                if ev == "totem":
                    totem_slots.add(d["i"])
                elif ev == "pack":
                    pack_slots.add(d["i"])
        self.assertEqual(len(s.items), n_map + f.DROP_SLOTS + f.PACK_SLOTS,
                         "the slot list never grows past the rings")
        self.assertTrue(all(n_map <= i < n_map + f.DROP_SLOTS for i in totem_slots),
                        "totems land only in the totem ring")
        self.assertTrue(all(n_map + f.DROP_SLOTS <= i < n_map + f.DROP_SLOTS + f.PACK_SLOTS for i in pack_slots),
                        "loose packs land only in the pack ring")
        self.assertEqual(len(totem_slots | pack_slots), f.DROP_SLOTS + f.PACK_SLOTS,
                         "every ring slot is used")

    def test_a_loose_pack_refills_the_taker(self):
        self._need_py()
        # a loose health/ammo drop behaves like the map's own packs when walked over
        f = self.strike
        s = f.Strike()
        self.assertIsNone(s.start({"u0": {"id": "u0"}, "u1": {"id": "u1"}}, 5, 30, 0.0, 2))
        t = f.COUNTDOWN
        s.tick(t, True)
        t += f.PACK_FIRST + 0.05
        evs = s.tick(t, True)
        pev = [d for ev, d in evs if ev == "pack"]
        self.assertEqual(len(pev), 1, "the first loose pack lands PACK_FIRST into the round")
        n_map = len(s.m["pickups"])
        self.assertIn(pev[0]["kind"], ("health", "ammo"))
        self.assertTrue(n_map + f.DROP_SLOTS <= pev[0]["i"] < n_map + f.DROP_SLOTS + f.PACK_SLOTS)
        # stand on it, hurt first so a health pack has room to heal
        p = s.players["u0"]
        p.update(x=pev[0]["x"] / 100.0, y=0.0, z=pev[0]["z"] / 100.0, r=0, pt=0, protect=0.0,
                 spawn_t=t - 5.0, q=0, q0=0, t0=t, qmax=0)
        p["hist"].clear()
        p["hp"] = 40
        s.pos("u0", {"x": pev[0]["x"], "y": 0, "z": pev[0]["z"], "r": 0, "p": 0, "q": 0, "e": p["life"]},
              t + 0.1)
        if pev[0]["kind"] == "health":
            self.assertEqual(p["hp"], 90, "the loose health pack healed its taker")

    def test_charmed_kills_pay_the_charmer(self):
        self._need_py()
        f = self.strike
        s = f.Strike()
        self.assertIsNone(s.start({"u0": {"id": "u0"}, "u1": {"id": "u1"}}, 5, 30, 0.0, 2))
        t = f.COUNTDOWN
        s.tick(t, True)
        s.players["u0"]["charm_until"] = t + f.CHARM
        before = list(s.scores)
        s._kill("u0", "u1", 0, False, t)
        self.assertEqual(s.scores[1], before[1] + 1, "the mole's kill pays the charmer's (cyan) team")
        self.assertEqual(s.scores[0], before[0], "amber does not keep the point its charmed shooter scored")

    def test_a_frozen_bot_holds_still(self):
        self._need_py()
        f = self.strike
        s = f.Strike()
        self.assertIsNone(s.start({"u0": {"id": "u0"}, "u1": {"id": "u1"}}, 5, 30, 0.0, 2))
        t = f.COUNTDOWN
        s.tick(t, True)
        bot = next(u for u, p in s.players.items() if p["bot"])
        x, z = s.players[bot]["x"], s.players[bot]["z"]
        s.players[bot]["freeze_until"] = t + f.FREEZE
        for _ in range(50):
            t += 1.0 / f.HZ
            s.tick(t, True)
        self.assertEqual((s.players[bot]["x"], s.players[bot]["z"]), (x, z),
                         "the paralysed bot does not move while frozen")

    def test_the_shield_totem_blocks_damage_but_not_their_own_shots(self):
        self._need_py()
        f = self.strike
        s = f.Strike()
        self.assertIsNone(s.start({"u0": {"id": "u0"}, "u1": {"id": "u1"}}, 5, 30, 0.0, 2))
        t = f.COUNTDOWN
        s.tick(t, True)
        # u0 and u1 face each other 6 m apart; u1 takes the shield totem
        for uid, x, z, r in (("u0", -6.0, -9.0, 18000), ("u1", -6.0, -3.0, 0)):
            p = s.players[uid]
            p.update(x=x, y=0.0, z=z, r=r, pt=0, protect=0.0, spawn_t=t - 5.0,
                     q=0, q0=0, t0=t, qmax=0)
            p["hist"].clear()
        s.players["u1"]["shield_totem_until"] = t + f.SHIELD_TOTEM
        hp0, hp0u0 = s.players["u1"]["hp"], s.players["u0"]["hp"]
        o = [s.players["u0"]["x"], s.players["u0"]["y"] + f.EYE, s.players["u0"]["z"]]
        # u0 fires down the lane at u1: the bubble eats every point of it
        s.fire("u0", {"w": 0, "ox": round(o[0] * 100), "oy": round(o[1] * 100), "oz": round(o[2] * 100),
                      "r": 18000, "p": 0, "q": 10, "ip": 0, "life": s.players["u0"]["life"]}, t + 0.1)
        self.assertEqual(s.players["u1"]["hp"], hp0, "nothing hurts the shield totem's taker")
        # but the shielded player shoots back at full damage
        o2 = [s.players["u1"]["x"], s.players["u1"]["y"] + f.EYE, s.players["u1"]["z"]]
        s.fire("u1", {"w": 0, "ox": round(o2[0] * 100), "oy": round(o2[1] * 100), "oz": round(o2[2] * 100),
                      "r": 0, "p": 0, "q": 20, "ip": 0, "life": s.players["u1"]["life"]}, t + 0.2)
        self.assertLess(s.players["u0"]["hp"], hp0u0, "the shielded player still damages others")
        # and the window lapses: shots land again once the bubble pops
        s.players["u1"]["shield_totem_until"] = t
        s.fire("u0", {"w": 0, "ox": round(o[0] * 100), "oy": round(o[1] * 100), "oz": round(o[2] * 100),
                      "r": 18000, "p": 0, "q": 30, "ip": 0, "life": s.players["u0"]["life"]}, t + 0.3)
        self.assertLess(s.players["u1"]["hp"], hp0, "the bubble pops when the window ends")

    def test_the_movement_totems_open_windows_and_relax_the_referee(self):
        self._need_py()
        # wings/leap/speed are the taker's own buffs: the take sets the window, and while
        # it runs the referee relaxes exactly what the browser's physics will send
        f = self.strike
        s = f.Strike()
        self.assertIsNone(s.start({"u0": {"id": "u0"}, "u1": {"id": "u1"}}, 5, 30, 0.0, 2))
        t = f.COUNTDOWN
        s.tick(t, True)
        p = s.players["u0"]
        p.update(x=0.0, y=0.0, z=-8.0, r=0, pt=0, protect=0.0, spawn_t=t - 5.0,
                 q=0, q0=0, t0=t, qmax=0)
        p["hist"].clear()
        p["air_at"] = t
        # the take itself: each window opens on the server clock. wings is special: the
        # cruise boundary is the shown WINGS seconds, but the judged window runs past it —
        # rise + cruise + the automatic glide down is one judged flight (the client flies
        # all three without input), so the referee must not "teleport" the landing.
        for kind, attr, dur in (("leap", "leap_until", f.LEAP), ("speed", "speed_until", f.SPEED)):
            self.assertTrue(s._take_totem("u0", p, kind, t + 1.0), kind + " applies to its taker")
            self.assertGreater(p[attr], t + 1.0, kind + " opens a window")
            self.assertLessEqual(p[attr], t + 1.0 + dur, kind + " for exactly its duration")
            p[attr] = 0.0
        self.assertTrue(s._take_totem("u0", p, "wings", t + 1.0), "wings applies to its taker")
        self.assertEqual(p["wings_fly"], t + 1.0 + f.WINGS, "cruise = the shown window")
        self.assertEqual(p["wings_until"], t + 1.0 + f.WINGS + f.WINGS_LAND, "judged = cruise + the glide down")
        p["wings_until"] = p["wings_fly"] = 0.0
        # a legal walk-speed move as the baseline
        ok, fix = s.pos("u0", {"x": 0, "y": 0, "z": -800, "r": 0, "p": 0, "q": 30, "e": p["life"]}, t + 0.3)
        self.assertTrue(ok and fix is None)
        # speed: 6.5 m in 0.3 s is past even the sprint cap — refused bare, allowed dashing
        ok, _ = s.pos("u0", {"x": 650, "y": 0, "z": -800, "r": 0, "p": 0, "q": 60, "e": p["life"]}, t + 0.6)
        self.assertFalse(ok, "a dash-speed burst without the speed totem is refused")
        p["x"], p["z"] = 0.0, -8.0
        p["speed_until"] = t + 10.0
        ok, fix = s.pos("u0", {"x": 650, "y": 0, "z": -800, "r": 0, "p": 0, "q": 90, "e": p["life"]}, t + 0.9)
        self.assertTrue(ok and fix is None, "the speed totem's window buys the dash cap")
        # leap: 4.5 m up in 0.3 s is past the plain gate — refused bare, allowed leaping
        p.update(x=0.0, y=0.0, z=-8.0)
        p["hist"].clear()
        p["leap_until"] = t + 10.0
        ok, fix = s.pos("u0", {"x": 0, "y": 450, "z": -800, "r": 0, "p": 0, "q": 120, "e": p["life"]}, t + 1.2)
        self.assertTrue(ok and fix is None, "the leap totem's window buys the tall jump")
        p["leap_until"] = 0.0
        p.update(x=0.0, y=0.0, z=-8.0)
        p["hist"].clear()
        ok, _ = s.pos("u0", {"x": 0, "y": 450, "z": -800, "r": 0, "p": 0, "q": 150, "e": p["life"]}, t + 1.5)
        self.assertFalse(ok, "a plain life cannot rise like a leaper")
        # wings: a hover past MAX_AIR (2 s) is refused bare, allowed while winged
        p.update(x=0.0, y=4.0, z=-8.0)
        p["hist"].clear()
        p["air_at"] = t + 2.0
        p["wings_until"] = 0.0
        ok, _ = s.pos("u0", {"x": 0, "y": 400, "z": -800, "r": 0, "p": 0, "q": 450, "e": p["life"]}, t + 4.5)
        self.assertFalse(ok, "a hover past MAX_AIR is refused without the wings totem")
        p["wings_until"] = t + 30.0
        ok, fix = s.pos("u0", {"x": 0, "y": 400, "z": -800, "r": 0, "p": 0, "q": 460, "e": p["life"]}, t + 4.6)
        self.assertTrue(ok and fix is None, "the wings totem parks the air clock")
        # the descent past the cruise boundary is still judged (the glide-down after the
        # shown window): a mid-air hover at cruise + 3 s of descent time is legal while
        # wings_until still runs, refused the moment it lapses
        p.update(x=0.0, y=7.0, z=-8.0)
        p["hist"].clear()
        p["air_at"] = t + 11.0   # airborne since just after cruise began
        s2 = f.Strike()
        s2.start({"u0": {"id": "u0"}, "u1": {"id": "u1"}}, 5, 30, 0.0, 2)
        s2.tick(t, True)
        p2 = s2.players["u0"]
        p2.update(x=0.0, y=9.0, z=-8.0, r=0, pt=0, protect=0.0, spawn_t=t - 5.0,
                  q=0, q0=0, t0=t, qmax=0)
        p2["hist"].clear()
        p2["air_at"] = t + 11.0
        s2._take_totem("u0", p2, "wings", t + 1.0)   # judged until t+16, cruise until t+11
        # gliding down at cruise + 3 s (14 s of air): legal while wings_until runs
        ok, fix = s2.pos("u0", {"x": 0, "y": 800, "z": -800, "r": 0, "p": 0, "q": 1410, "e": p2["life"]}, t + 14.1)
        self.assertTrue(ok and fix is None, "the automatic glide down is still wings flight")
        # once the judged window closes, the same mid-air stay is refused
        ok, _ = s2.pos("u0", {"x": 0, "y": 700, "z": -800, "r": 0, "p": 0, "q": 1620, "e": p2["life"]}, t + 16.2)
        self.assertFalse(ok, "past wings + WINGS_LAND there is no more flight")
        # and a respawn starts with every movement window closed
        p["wings_until"] = p["wings_fly"] = p["leap_until"] = p["speed_until"] = t + 30.0
        s._place(p, 0, t + 5.0)
        self.assertEqual((p["wings_until"], p["wings_fly"], p["leap_until"], p["speed_until"]), (0.0, 0.0, 0.0, 0.0))

    def test_the_teleport_totem_plants_the_taker_on_open_ground(self):
        self._need_py()
        # the teleport is instant: no window, the referee itself moves the body so the
        # next pos frame starts from the destination (no "teleport" correction), and the
        # pick event carries the destination so the taker's client can snap
        f = self.strike
        s = f.Strike()
        self.assertIsNone(s.start({"u0": {"id": "u0"}, "u1": {"id": "u1"}}, 5, 30, 0.0, 2))
        t = f.COUNTDOWN
        s.tick(t, True)
        p = s.players["u0"]
        x0, z0 = p["x"], p["z"]
        self.assertTrue(s._take_totem("u0", p, "teleport", t + 1.0))
        self.assertTrue((p["x"], p["z"]) != (x0, z0), "the taker moved somewhere else")
        self.assertEqual(p["y"], 0.0, "always on the ground, never in the air")
        self.assertGreaterEqual(p["x"], -17.5, "inside the drop scatter's x range")
        self.assertLessEqual(p["x"], 17.5)
        self.assertGreaterEqual(p["z"], -10.5, "inside the drop scatter's z range")
        self.assertLessEqual(p["z"], 10.5)
        self.assertLess(f.overlaps(s.m, p["x"], 0.1, p["z"], 0.3), 0, "never inside a box")
        self.assertEqual(p["air_at"], t + 1.0, "the air clock restarts at the destination")
        self.assertEqual(p["hist"][-1], (t + 1.0, p["x"], 0.0, p["z"]), "history points at the destination")
        # two hops in a row land somewhere fresh (the seed advances with the take counter)
        px, pz = p["x"], p["z"]
        self.assertTrue(s._take_totem("u0", p, "teleport", t + 2.0))
        self.assertTrue((p["x"], p["z"]) != (px, pz), "the second hop lands somewhere fresh")
        # and a walk-speed pos frame from the destination is accepted (no correction)
        ok, fix = s.pos("u0", {"x": round(p["x"] * 100), "y": 0, "z": round(p["z"] * 100),
                               "r": 0, "p": 0, "q": 100, "e": p["life"]}, t + 2.1)
        self.assertTrue(ok and fix is None, "the next frame starts from the destination: {fix}".format(fix=fix))

    def test_the_host_picks_one_bot_skill_for_both_sides(self):
        self._need_py()
        # MP lobbies fill short sides with bots on BOTH teams, so one skill level applies
        # to the whole match — never a sharper filler's side against a duller's
        f = self.strike
        s = f.Strike()
        self.assertIsNone(s.start({"u0": {"id": "u0"}, "u1": {"id": "u1"}}, 5, 30, 0.0, 3, "hard"))
        self.assertEqual(s.bot_diff, "hard")
        self.assertEqual((s.bot_aim, s.bot_react, s.bot_turn, s.bot_rate),
                         (f.BOT_DIFFS["hard"]["aim"], f.BOT_DIFFS["hard"]["react"],
                          f.BOT_DIFFS["hard"]["turn"], f.BOT_DIFFS["hard"]["rate"]))
        # an unknown id — including a crafted wire one — quietly falls back to normal
        s2 = f.Strike()
        s2.start({"u0": {"id": "u0"}, "u1": {"id": "u1"}}, 5, 30, 0.0, 3, "nightmare")
        self.assertEqual(s2.bot_diff, "normal")
        self.assertEqual(s2.bot_aim, 1.0)
        # and a match started without a diff is normal (the host didn't pick one)
        s3 = f.Strike()
        s3.start({"u0": {"id": "u0"}, "u1": {"id": "u1"}}, 5, 30, 0.0, 3)
        self.assertEqual(s3.bot_diff, "normal")

    def test_constants_match(self):
        self._need_py()
        if self.strike is None:
            self.skipTest("Python strike.py is gone — twin locks live in backend/src/strike/tests.rs")
        src = block()
        for name in ("R", "H", "EYE", "STEP_H", "RUN", "ACCEL", "AIR_ACCEL", "GRAVITY", "JUMP_V", "FALL_MAX",
                     "BODY_R", "BODY_H", "HEAD_R", "HEAD_TOP"):
            m = re.search(r"\b%s\s*=\s*([0-9.]+)" % name, src)
            self.assertIsNotNone(m, name)
            self.assertEqual(float(m.group(1)), float(getattr(self.strike, name)), name)
        js = read(STRIKE_JS)
        self.assertLessEqual(float(re.search(r"\bRUN\s*=\s*([0-9.]+)", src).group(1)), self.strike.MAX_SPEED)
        self.assertLessEqual(float(re.search(r"\bINTERP\s*=\s*([0-9.]+)", js).group(1)) +
                             float(re.search(r"\bJIT_MAX\s*=\s*([0-9.]+)", js).group(1)), self.strike.IP_CAP)
        self.assertEqual(float(re.search(r"\bSWITCH\s*=\s*([0-9.]+)", js).group(1)), self.strike.SWITCH)
        self.assertEqual(float(re.search(r"\bRESPAWN\s*=\s*([0-9.]+)", js).group(1)), self.strike.RESPAWN)
        # the host's choices (Teams / First to) must be exactly what the server accepts
        self.assertEqual(json.loads(re.search(r"var MINUTES = (\[[^\]]*\]), KILLS = (\[[^\]]*\]), TEAM_SIZES = (\[[^\]]*\]);", js).group(1)),
                         list(self.strike.MINUTES))
        self.assertEqual(json.loads(re.search(r"var MINUTES = (\[[^\]]*\]), KILLS = (\[[^\]]*\]), TEAM_SIZES = (\[[^\]]*\]);", js).group(2)),
                         list(self.strike.KILLS))
        self.assertEqual(json.loads(re.search(r"var MINUTES = (\[[^\]]*\]), KILLS = (\[[^\]]*\]), TEAM_SIZES = (\[[^\]]*\]);", js).group(3)),
                         list(self.strike.TEAM_SIZES))

    def test_makegame_helpers_stay_inside_makegame(self):
        """V, meShielded, botShielded, flashCenter and R3 live in makeGame's scope.

        A helper defined at module scope that references any of them compiles fine
        (`node --check` is syntax only) but throws a ReferenceError on its first call
        from inside makeGame — which silently freezes whatever frame was painting
        (the top bar stuck on the warmup string is the symptom). Keep every function
        that touches them below `function makeGame`.
        """
        js = read(STRIKE_JS)
        lines = js.splitlines()
        start = next(i for i, ln in enumerate(lines) if ln.startswith("function makeGame"))
        # brace-match makeGame exactly
        depth = 0
        end = None
        for i in range(start, len(lines)):
            depth += lines[i].count("{") - lines[i].count("}")
            if i > start and depth <= 0:
                end = i
                break
        self.assertIsNotNone(end, "makeGame never closes")
        forbidden = ("V.", "V[", "meShielded", "botShielded", "flashCenter", "R3", "topBox",
                     "disLive", "disStart", "disClear", "disImmune", "hudUpdate", "worldTick")

        def fns(lo, hi):
            i = lo
            while i < hi:
                s = lines[i].lstrip()
                if s.startswith("function ") and not s.startswith("function ("):
                    name = s[8:s.find("(")].strip()
                    d = 0
                    j = i
                    while j < hi:
                        d += lines[j].count("{") - lines[j].count("}")
                        if j > i and d <= 0:
                            yield name, i, j
                            i = j
                            break
                        j += 1
                    else:
                        yield name, i, hi - 1
                i += 1

        # every function defined outside makeGame must be free of makeGame-only symbols
        for name, a, b in list(fns(0, start)) + list(fns(end + 1, len(lines))):
            body = "\n".join(lines[a:b + 1])
            hits = sorted({f for f in forbidden
                           if re.search(r"\b" + re.escape(f.rstrip(".[")) + r"\b", body)
                           and f.rstrip(".[") != name})
            self.assertEqual(hits, [],
                             f"makeGame-only symbol(s) {hits} in module-scope function "
                             f"'{name}' (lines {a+1}-{b+1}) — move it inside makeGame")

        # the disaster helpers specifically must sit inside makeGame
        for fn in ("disLive", "disStart", "disClear", "disImmune"):
            m = re.search(r"^\s*function %s\b" % fn, js, re.M)
            self.assertIsNotNone(m, fn + " is missing")
            pos = js[:m.start()].count("\n")
            self.assertGreater(pos, start,
                               fn + " must be defined inside makeGame (V lives there); "
                               f"found it at line {pos+1}, makeGame starts at line {start+1}")

    def test_disaster_kinds_roll_and_disaster_totems_are_pickable(self):
        """Bug lock: the auto-disaster kind must actually vary, and a Disaster totem
        must apply.

        Two independent defects, both silent:
        1. `hashMatch(smallCounter, salt) * 10` reads the TOP bits of `seed ^ constant`,
           so consecutive worldK values (1,2,3,…) collapse onto ONE index — a whole match
           of Absolute Zero. `disKind` (Math.imul golden-ratio mix + xor-fold) is the fix;
           its Rust twin is `dis_kind`.
        2. `DISASTERS` is an ARRAY. `if(DISASTERS[kind])` indexes it with a string, so the
           Disaster-totem branch was dead: `totemApply` returned null, the pickup handler
           bailed before `V.items[i] = 0`, and the gem stayed lit on the ground for the
           whole match. Must be `DISASTERS.indexOf(kind)`.
        """
        js = read(STRIKE_JS)
        rs = read(STRIKE_RS)
        self.assertIn("function disKind(seed, salt, n)", js,
                      "disKind must exist (hashMatch's top-bit read collapses small counters)")
        self.assertIn("Math.imul(seed|0, 0x9e3779b9)", js,
                      "disKind must mix the seed with the golden ratio (totemSpawn's pattern)")
        # the two kind picks must go through disKind, not the collapsing hashMatch
        self.assertIn("DISASTERS[disKind(seed, 4, DISASTERS.length)]", js)
        self.assertIn("DISASTERS[disKind(V.worldK|0, 11, DISASTERS.length)]", js)
        self.assertNotIn("hashMatch(seed, 4) * DISASTERS", js)
        self.assertNotIn("hashMatch(V.worldK|0, 11) * DISASTERS", js)
        # Disaster totems: DISASTERS is an array — never index it with a string kind
        self.assertIn("if(DISASTERS.indexOf(kind) >= 0){", js)
        self.assertNotIn("if(DISASTERS[kind]){", js)
        # ground drops must be reachable from Wave B high grounds (drops sit at y=0)
        self.assertNotIn("Math.abs(V.me.y - pk.at[1]) > 1.2) return;",
                         js[js.find("MAP.pickups.forEach"):js.find("MAP.pickups.forEach") + 500],
                         "the 1.2 m Y window rejects every ground drop from a crate/ledge")
        # a cluster of totems is taken like solo: square XZ reach, not a circle.
        # hypot(1.1) is strictly smaller than the |dx|<=1.1 && |dz|<=1.1 box, so a
        # diagonal sweep left corner totems standing and they flushed later in bulk.
        self.assertIn("if(Math.abs(V.me.x - pk.at[0]) > 1.1 || Math.abs(V.me.z - pk.at[2]) > 1.1) return;",
                      js[js.find("MAP.pickups.forEach"):js.find("MAP.pickups.forEach") + 500],
                      "solo takes a totem on a square XZ reach")
        self.assertIn("if (x - at[0]).abs() > PICK_R || (z - at[2]).abs() > PICK_R {", rs,
                      "the judge takes a totem on the same square reach")
        self.assertNotIn("hypot(z - at[2]) > PICK_R", rs,
                         "no circular pickup reach — a walk-through takes the whole cluster")
        # A live walk is believed at the body the player named: the judge's copy freezes
        # on a speed-cap / canopy / token-bucket refusal, and the old 4 m leash to that
        # frozen copy threw the claim away mid-walk ("I went through it and it was left
        # behind"). The leash only binds a STALLED claim.
        self.assertIn("pub const CLAIM_FRESH: f64 = 0.2", rs)
        self.assertIn("pub const SPEED_CARRY: f64 = 12.0", rs)
        self.assertIn("pub const CLAIM_R_MAX: f64 = 14.0", rs)
        self.assertIn("let reach = (CLAIM_R + SPEED_CARRY * lag).min(CLAIM_R_MAX);", rs)
        self.assertIn("if age <= CLAIM_FRESH {", rs)
        # a respawn drops the old life's claim; every current-life frame rewrites it
        self.assertIn("self.claim = None;", rs)
        self.assertIn("p.claim = Some((xm, ym, zm, t));", rs)
        # a claim naming a body outside the arena is never believed
        self.assertIn("*cy > b[4] + 8.0", rs)
        # MP lights the top-left chip like solo: liveEffects() builds it from V.taken,
        # and only totemApply (solo) used to write it, so a taken totem showed nothing.
        self.assertIn("V.taken = V.taken || {}; V.taken[knd] = t;", js)
        self.assertIn("V.taken = V.taken || {}; V.taken[kind] = t;", js)
        # node: the spread over the real auto-disaster sequence must cover the roster
        if NODE:
            script = r"""
var out = [];
function disKind(seed, salt, n){
  n = n > 0 ? n|0 : 1;
  var x = ((Math.imul(seed|0, 0x9e3779b9) ^ Math.imul(salt|0, 0x85ebca6b)) >>> 0);
  x = (x ^ (x >>> 15)) >>> 0;
  return (x % n) | 0;
}
for (var k = 1; k <= 12; k++) out.push(disKind(k, 11, 10));
for (var k = 0; k < 12; k++){
  var t = 12 + k * 16;
  out.push(disKind(((Math.floor(t * 1000) ^ 77) >>> 0), 4, 10));
}
process.stdout.write(JSON.stringify(out));
"""
            raw = subprocess.check_output(["node", "-e", script], text=True).strip()
            picks = json.loads(raw)
            self.assertGreater(len(set(picks)), 4,
                               "consecutive auto-disaster rolls must not stick on one kind: %r" % (picks,))
            for i in picks:
                self.assertTrue(0 <= i < 10, "kind index in range: %r" % (i,))

    def test_rift_and_shockwave_are_visible_and_every_disaster_has_an_impact(self):
        """Wave G: the standing rule is visual AND impact for every disaster.

        Three silent gaps, all user-reported:
        1. Rift planted V.rifts and hopped rockets through with NO mesh and NO 2D blip
           ("no rift was creating around me"). R.addRift + make2d blips are the fix.
        2. Shockwave totem was one small boom — an empty detonation read as nothing.
           R.ring / V.rings is the fix.
        3. Sandstorm / Absolute Zero / EMP were mod-only (vision / movement / HUD). They
           now chip DD_SAND_DMG / DD_ZERO_DMG / DD_EMP_DMG once a second, JS + Rust twins.
        """
        js = read(STRIKE_JS)
        # 1. Rift is painted in 3D and 2D, and both the solo apply and the MP "rift"
        #    event (and the po snapshot) go through the painter
        self.assertIn("R.addRift = function", js, "Rift openings must be painted")
        self.assertIn("if(R3 && R3.addRift) R3.addRift(rf)", js)
        self.assertIn("if(R3 && R3.addRift) R3.addRift(rfMP)", js)
        self.assertIn("if(R3.addRift) R3.addRift(rfSnap)", js, "the po snapshot paints through the painter (diffed, not repainted)")
        self.assertIn("(V.rifts || []).forEach", js, "2D map must show the rift pair")
        # 1b. The Rift is a STANDING portal pair the PLAYER walks through (user-reported:
        #     "1 purple circle in ground and nothing happens in that"). One ring in front
        #     of the taker, its twin at a hashed open spot; walking into either exits the
        #     other. Rockets hop the same pair. The far ring's facing is derived from the
        #     pair's own geometry so a snapshot repaint still walks through.
        self.assertIn("RIFT_R = 1.15", js, "the portal aperture is a shared constant")
        self.assertIn("RIFT_FRONT = 2.4", js, "the near ring stands in front of the taker")
        self.assertIn("RIFT_COOL = 0.45", js, "a hop has a post-hop lockout")
        self.assertIn("function riftPair(", js)
        self.assertIn("function riftAt(", js)
        self.assertIn("function riftHop(", js)
        self.assertIn("function riftProjectileHop(", js)
        self.assertIn("FS.riftHop(", js, "the local move step walks the body through")
        self.assertIn("FS.riftPair(", js, "every plant path goes through the shared pair")
        # the rings stand upright (a CircleGeometry facing yaw), never a flat ground disc
        self.assertIn("TorusGeometry(FS.RIFT_R * 0.72", js, "the opening is an upright ring")
        # 2. Shockwave has a real ring, not just one small boom
        self.assertIn("R.ring = function", js, "Shockwave totem must paint a ground ring")
        self.assertIn("V.rings = V.rings || []", js)
        self.assertIn("if(R3 && R3.ring) R3.ring(", js)
        # 3. the modifier disasters chip — and the numbers are named
        self.assertIn("DD_SAND_DMG = 3", js)
        self.assertIn("DD_ZERO_DMG = 4", js)
        self.assertIn("DD_EMP_DMG = 2", js)
        self.assertIn("DD_WIND_DMG = 3", js, "hurricane must chip HP, not only shove")
        self.assertIn('if((dis === "sandstorm" || dis === "absolutezero" || dis === "emp" || dis === "hurricane") && t >= dHitAt){', js)
        self.assertIn('var chipD = dis === "sandstorm" ? DD_SAND_DMG', js)
        self.assertIn('(dis === "hurricane" ? DD_WIND_DMG', js, "hurricane chip")
        # hurricane is a vortex: caught bodies orbit, lift and lose control
        self.assertIn("inWindCatch(", js, "hurricane must spin caught bodies")
        self.assertIn("DD_WIND_CATCH_R", js)
        self.assertIn("DD_WIND_TOP", js)
        self.assertIn("DD_WIND_SPIN", js)
        self.assertIn("DD_WIND_LIFT", js)
        self.assertIn("DD_WIND_CATCH", js)
        # the grip is applied to you AND bots (it used to only shove you / MP players)
        self.assertIn("ai.body.vortex", js, "hurricane must spin solo bots")
        # sandstorm is denser than the old 140-sprite wall (3.38.3 raised it to 420)
        self.assertIn("n = 420", js)
        # 3.38.3: every disaster paints a real scene, not a tint
        self.assertIn("F.throat", js, "the sinkhole must have a throat cone")
        self.assertIn("F.coreGlow", js, "the sinkhole must glow at its core")
        self.assertIn("F.plates", js, "the earthquake must heave floor plates")
        self.assertIn("F.sheath", js, "the hurricane must have a dark outer sheath")
        self.assertIn("F.boltBranch2", js, "thunder must fork")
        self.assertIn("F.flash", js, "thunder must flash the ground at the strike")
        self.assertIn("F.ring2", js, "the shockwave must trail rings")
        self.assertIn("F.ring3", js, "the shockwave must trail rings")
        self.assertIn("F.wall", js, "the sandstorm must have a windward wall")
        self.assertIn("F.sheet", js, "the freeze must have a glassy ice sheet")
        self.assertIn("F.wash", js, "the EMP must black out the floor")
        self.assertIn("dl-warn", js, "the disaster log chips must flag a warn")
        # the two HUD columns must not overlap: kill feed top-right, disaster log bottom-right
        css = read("games/games.css")
        self.assertIn(".vg-fps-feed{position:absolute;right:8px;top:8px", css)
        self.assertIn(".vg-fps-dis-log{position:absolute;bottom:64px;right:12px", css,
                      "disaster log must sit bottom-right, clear of the top-right kill feed")
        # the game-info card must explain each disaster under the Disaster totems grid
        self.assertIn('"What each disaster does"', js)
        self.assertIn("TOTEM_HELP[k]", js)
        # Rust twin
        rs = read(STRIKE_RS)
        self.assertIn("RIFT_R: f64 = 1.15", rs, "the Rust twin keeps the same aperture")
        self.assertIn("RIFT_FRONT: f64 = 2.4", rs)
        self.assertIn("RIFT_COOL: f64 = 0.45", rs)
        self.assertIn("rift_hop", rs, "pos() must accept the walk-in hop")
        self.assertIn("DD_SAND_DMG: i64 = 3", rs)
        self.assertIn("DD_ZERO_DMG: i64 = 4", rs)
        self.assertIn("DD_EMP_DMG: i64 = 2", rs)
        self.assertIn("DD_WIND_DMG: i64 = 3", rs)
        self.assertIn('"sandstorm" | "absolutezero" | "emp" if t >= d.hit_at =>', rs)

    def test_the_nothing_happens_totems_are_wired_on_both_sides(self):
        """User report: "nothing happens in gravity flip and time rewind, not sure if
        bullet magnet, hunter mark, bubble fortress, rally, kingmaker ... do anything
        in game". Each named totem needed a live READER (movement / combat / radar /
        reload), not just a flag write — and the beacon / bubble / mine / meteor
        world objects needed meshes, or taking the totem still looked like nothing.

        Three classes of bug, all confirmed at runtime (tests/probe_totems.js):
        1. Time Rewind took hist[len-3] = 3 FRAMES (~0.05 s), not 3 s. histPush /
           histAt (timestamped) are the fix; the probe drives the real helpers and
           measures 17.9 m of travel back over 3.0 s (was 0.2 m / 0.033 s).
        2. Rally's 6 hp/s truncated to 0 every tick in BOTH twins (6*dt is 0.3 at
           20 Hz, and `|0` / `as i64` throws it away) — hp never moved. hp_acc /
           V.hpAcc accumulate the fraction and pay out whole points.
        3. Bubble Fortress / Kingmaker / Rally / Trapmaster / Meteor Call pushed
           V.bubbles / V.beacons / V.mines / V.meteors and exported snapshot rows,
           but nothing drew them. R.addBeacon / addBubble / addMine / addMeteorMark
           are the meshes; the probe's `allDrawn` gate is true.

        Plus the JS twins of Rust behaviour that was already live: a magnet
        hit-steal on the victim's side, a bubble damage gate on BOTH shooters,
        hunter mark stripping cloak, king reserve top-up, and a beacon-keyed
        rally reload/heal (the taker's personal clock never reached a mate).
        """
        js = read(STRIKE_JS)
        rs = read(STRIKE_RS)
        # 1. Time Rewind is a TIMESTAMPED 3 s trail on both sides
        self.assertIn("REWIND_S = 3.0", js, "the help promises 3 s")
        self.assertIn("HIST_S = 3.0", js, "the buffer must cover the rewind window")
        self.assertIn("function histPush(", js)
        self.assertIn("function histAt(", js)
        self.assertIn("FS.histPush(V.hist", js, "the move step must feed the trail")
        self.assertIn("FS.histAt(V.hist, t - FS.REWIND_S)", js, "the totem must rewind 3 s")
        self.assertIn("REWIND_S: f64 = 3.0", rs, "the Rust twin keeps the same window")
        self.assertIn("HIST_S: f64 = 3.0", rs)
        self.assertIn("where_at(t - REWIND_S)", rs)
        # 2. Rally heal accumulates its fraction (it used to truncate to 0)
        self.assertIn("V.hpAcc", js, "rally's 6 hp/s must not truncate away")
        self.assertIn("hp_acc", rs, "the Rust twin accumulates the same fraction")
        self.assertIn("p.hp_acc += 6.0 * dt", rs)
        # 3. every world object the totems plant is DRAWN (take hooks + snap repaint)
        for fn in ("R.addBeacon = function", "R.addBubble = function",
                   "R.addMine = function", "R.addMeteorMark = function"):
            self.assertIn(fn, js, fn.split("=")[0].strip() + " must paint its world object")
        for hook in ("if(R3 && R3.addBeacon) R3.addBeacon(", "if(R3 && R3.addBubble) R3.addBubble(",
                     "if(R3 && R3.addMine) R3.addMine(", "if(R3 && R3.addMeteorMark) R3.addMeteorMark("):
            self.assertIn(hook, js, hook + " — take path must paint")
        for snap_hook in ("R3.clearBeacons()", "R3.clearBubbles()",
                          "R3.clearMines()", "R3.clearMeteorMarks()"):
            self.assertIn(snap_hook, js, "snapshot repaint must clear before painting")
        # 4. the JS twins of the behaviour the Rust judge always had
        self.assertIn("function inBubble(", js, "the bubble damage gate")
        self.assertIn("if(inBubble(tv.x, tv.y + 0.9, tv.z, tv.team, t)", js,
                      "the player's own fire() must gate on the bubble too")
        self.assertIn("function reloadMult(", js, "king/rally shorten a reload")
        self.assertIn("B.kind !== \"rally\"", js, "the rally reload is keyed off the BEACON")
        self.assertIn("RB.kind !== \"rally\"", js, "so is the rally heal — a mate gets it")
        self.assertIn("function hunterMarked(", js)
        self.assertIn("hunterMarked(P, t)", js, "the radar must paint the gold ring")
        self.assertIn("v.cloak_until = 0.0", rs, "mark strips cloak")
        self.assertIn("fn in_bubble(", rs, "the Rust twin of the bubble gate")
        self.assertIn("fn reload_mult(", rs, "the Rust twin of king/rally reload")
        # magnet steal is on the VICTIM's side, never the shooter's own team
        self.assertIn("kv.team == team || kv.magnet_until <= t", rs,
                      "the magnet holder must share the victim's side")
        self.assertIn("Q.team === (P && P.team)", js, "the JS twin skips the shooter's team too")
        # king tops up reserve on take
        self.assertIn("WEAPONS[wi].reserve", rs, "king tops up the reserve")
        self.assertIn("rally_until = t + RALLY", rs, "rally sets the taker's FLAG_RALLY clock")

    def test_the_big_head_totem_doubles_every_skull(self):
        """User ask: a funny "big head" totem — after taking it everyone's head is
        double size for a while, so headshots get easier. The hitbox must grow WITH
        the head (outward and upward only: the bottom stays on the shoulders, so a
        chest shot can never become a headshot). Arena-wide clock, personal drop
        roster, FLAG_BIGHEAD on every living row. Geometric numbers live in
        backend/src/strike/tests.rs; this locks the twins agree."""
        js = read(STRIKE_JS)
        rs = read(STRIKE_RS)
        src = block()
        # 1. the scale constant is shared and is exactly 2
        self.assertIn("var BIG_HEAD_S = 2;", src)
        self.assertIn("BIG_HEAD_S: BIG_HEAD_S", js, "FS must export the shared scale")
        self.assertIn("pub const BIG_HEAD_S: f64 = 2.0;", rs)
        # 2. the window is 10 s on both sides
        self.assertIn('bighead:   {hue: "#ff8fab", n: "Big Head",    dur: 10, c: 0xff8fab},', js)
        self.assertIn("pub const BIG_HEAD: f64 = 10.0;", rs)
        self.assertIn("big_head_until = t + BIG_HEAD", rs, "the Rust take sets the arena clock")
        # 3. the head AABB grows OUTWARD and UPWARD only — the body box never moves
        self.assertIn("function hitBoxes(x, y, z, hs){", src)
        self.assertIn("var s = (hs != null && hs > 0) ? +hs : 1;", src)
        self.assertIn("var hr = HEAD_R * s, ht = BODY_H + (HEAD_TOP - BODY_H) * s;", src,
                      "head half-width and top scale; the bottom stays at BODY_H")
        self.assertIn("y + BODY_H, z - hr, x + hr, y + ht, z + hr", src)
        self.assertIn("pub fn hit_boxes(x: f64, y: f64, z: f64, hs: f64)", rs)
        self.assertIn("pub fn ray_player(o: [f64; 3], d: [f64; 3], x: f64, y: f64, z: f64, maxd: f64, hs: f64)", rs)
        self.assertIn("function rayPlayer(o, d, x, y, z, maxd, hs){", src)
        # 4. every hit test threads the live scale (no call site may forget hs)
        for call in ("FS.rayPlayer(e, d, V2.x, V2.y, V2.z, end, headScaleAt(t))",
                     "FS.hitBoxes(P.x, P.y, P.z, headScaleAt(t))",
                     "FS.rayPlayer(e, d, P.x, P.y, P.z, end, headScaleAt(t))"):
            self.assertIn(call, js, call + " must pass the live head scale")
        self.assertGreaterEqual(js.count("headScaleAt(t)"), 5, "every hit site threads the scale")
        self.assertIn("fn head_scale(&self, t: f64) -> f64", rs)
        self.assertIn("let hs = self.head_scale(t);", rs, "fire / bot_fire / rockets all bind hs")
        self.assertGreaterEqual(rs.count("ray_player(o, d,"), 4, "every Rust hit site threads hs")
        self.assertIn("hit_boxes(v.x, v.y, v.z, hs)", rs, "the rocket splash does too")
        # 5. the clock is arena-wide and does not pop on death
        self.assertIn("V.bigHeadUntil = t + TOTEMS.bighead.dur;", js)
        self.assertIn("headScaleAt(t)", js)
        self.assertIn("return (V.bigHeadUntil && t < V.bigHeadUntil) ? FS.BIG_HEAD_S : 1;", js)
        self.assertIn("big_head_until: 0.0,", rs, "Strike::new seeds the clock")
        self.assertNotIn("big_head_until = 0.0;", rs.replace("big_head_until: 0.0,", ""),
                         "nothing may clear the window mid-match (no pop on death)")
        # 6. FLAG_BIGHEAD rides EVERY living row so every client agrees
        self.assertIn("FLAG_BIGHEAD", js)
        self.assertIn("FLAG_BIGHEAD = 134217728;", js)
        self.assertIn("pub const FLAG_BIGHEAD: i64 = 134_217_728;", rs)
        self.assertIn("if(has(FLAG_BIGHEAD)) V.bigHeadUntil = Math.max(V.bigHeadUntil||0, t + 0.45);", js,
                      "the client renews a short TTL off the snapshot, never Infinity")
        self.assertIn("if self.big_head_until > t { FLAG_BIGHEAD } else { 0 }", rs)
        # 7. it is on the PERSONAL roster in both languages (a joke power-up, not a disaster)
        self.assertEqual(js.count('"king","radarjam","bighead","disco","banana","lava","goose","reverse","blackhole","roulette","turret","barrel","laser","jumppad","lottery"];'), 3,
                         "all three JS drop rosters (totemSpawn / wardenLoot / nonDisTotems) name it")
        self.assertEqual(js.count('"bighead","disco","banana","lava","goose","reverse","blackhole","roulette","turret","barrel","laser","jumppad","lottery"];'), 3,
                         "exactly the three personal rosters")
        self.assertIn("\"bighead\",", rs)
        self.assertIn("totemSpawn", js)
        self.assertIn("function wardenLoot", js)
        self.assertIn("function nonDisTotems", js)
        # 8. help text + status string present (and esc()'d at paint time, like every other totem)
        self.assertIn('bighead: "For 10s EVERY head in the arena doubles', js)
        self.assertIn('return "Big Head: EVERY head doubles for "', js)
        # 9. the 3D skull really scales: the head bone, the tag lift, and decoys
        self.assertIn("headBone", js, "addPlayer must capture the head bone")
        self.assertIn('n.name === "head"', js)
        self.assertIn("m.headBone.scale.setScalar(m.headS)", js)
        self.assertIn("var tagY = 2.15;", js, "the name tag starts at the ordinary height")
        self.assertIn("tagY += (m.headS - 1) * 0.95;", js, "the name tag lifts with the skull")
        self.assertIn("__headBone", js, "decoys grow too")

    def test_the_disco_totem_makes_everyone_else_dance(self):
        """User ask: one more disco totem — getting it, everyone (except the player
        who took it) starts disco dancing for some time, and those players/bots only
        dance, they can't shoot anyone for that time. The taker keeps their gun.
        Per-player clocks (the taker is the one who stays armed), FLAG_DISCO on every
        dancer's row, the trigger locked on both sides, and a real dance pose on the
        3D bones. Numbers live in backend/src/strike/tests.rs; this locks the twins."""
        js = read(STRIKE_JS)
        rs = read(STRIKE_RS)
        # 1. the window is 8 s on both sides
        self.assertIn('disco:     {hue: "#ff2d95", n: "Disco",      dur: 8,  c: 0xff2d95},', js)
        self.assertIn("pub const DISCO: f64 = 8.0;", rs)
        # 2. the taker never dances — everyone else does, both teams, bots included
        self.assertIn("others().forEach(function(P){ if(P && !P.gone){ P.danceUntil = t + d;", js,
                      "solo apply stamps every OTHER player, never the taker")
        self.assertIn("if u.as_str() != me && !v.dead && !v.gone", rs, "the Rust take skips the taker")
        self.assertIn("v.dance_until = t + DISCO;", rs)
        # 3. a dancer cannot shoot — the trigger is locked on BOTH sides
        self.assertIn("function danceOn(t){", js)
        self.assertIn("if(danceOn(t)) return false;", js, "canShoot must refuse a dancer")
        self.assertIn("p.dance_until > t", rs, "fire_inner must refuse a dancer")
        self.assertIn("if self.players[i].1.dance_until > t {", rs, "bot_fire must refuse a dancer")
        # 4. a dancer also holds still (like the Paralyser) — bots stop stepping
        self.assertIn("if(P.danceUntil && t < P.danceUntil) return;", js)
        self.assertIn("if self.players[i].1.dance_until > t {", rs)
        self.assertIn("var canMove = !V.watch && !V.dead && !V.paused && !danceOn(t)", js,
                      "the local player cannot walk while dancing either")
        # 5. FLAG_DISCO is a per-player bit, never on the taker's row
        self.assertIn("FLAG_DISCO = 268435456;", js)
        self.assertIn("pub const FLAG_DISCO: i64 = 268_435_456;", rs)
        self.assertIn("if(has(FLAG_DISCO)){ if(!P.danceUntil && R3) R3.charm(P, \"disco\"); P.danceUntil = Infinity; }", js)
        self.assertIn("else if(P.danceUntil){ clearMarks(P, \"disco\"); P.danceUntil = 0; }", js)
        self.assertIn("if p.dance_until > t { FLAG_DISCO } else { 0 }", rs)
        # 6. the window is per-player and pops on the DANCER's death (not the taker's)
        self.assertIn("dance_until: 0.0,", rs, "Player::new seeds the clock")
        self.assertIn("self.dance_until = 0.0;", rs, "place() clears it on respawn")
        self.assertIn("vic.danceUntil = 0; clearMarks(vic, \"disco\");", js)
        self.assertIn("V.danceUntil = 0;", js)
        # 7. personal drop roster in both languages, never a disaster kind
        self.assertEqual(js.count('"bighead","disco","banana","lava","goose","reverse","blackhole","roulette","turret","barrel","laser","jumppad","lottery"];'), 3,
                         "all three personal rosters end with Wave G")
        self.assertIn("\"disco\",", rs)
        self.assertIn("\"bighead\", \"disco\",", rs, "TOTEM_KINDS carries it next to Big Head")
        self.assertIn("pub const TOTEM_KINDS: [&str; 60]", rs, "the roster grew with Wave G")
        kinds_blk = rs.split("TOTEM_KINDS")[1].split("];")[0]
        self.assertIn('"disco"', kinds_blk, "disco is one of TOTEM_KINDS")
        # 8. help text + status string present
        self.assertIn('disco: "For 8s everyone but you breaks into a disco dance', js)
        self.assertIn('return "Disco: everyone but you dances for "', js)
        # 9. a real dance pose on the 3D bones, and it survives idle/walk
        self.assertIn("var bones = {armL: null, armR: null, legL: null, legR: null, torso: null, root: null};", js)
        self.assertIn('n.name === "arm-left"', js)
        self.assertIn('n.name === "arm-right"', js)
        self.assertIn('n.name === "leg-left"', js)
        self.assertIn('n.name === "leg-right"', js)
        self.assertIn("bones: bones,", js)
        # arms pump up and down alternately (overhead raise driven by opposite phases)
        self.assertIn("m.bones.armL.rotation.x = -0.35 - Math.max(0, sw) * 2.35;", js)
        self.assertIn("m.bones.armR.rotation.x = -0.35 - Math.max(0, sw2) * 2.35;", js)
        self.assertIn("m.headBone.rotation.z = quiet ? 0.10 : Math.sin(dancePh * 1.35) * 0.28;", js,
                      "the head wobbles too")
        self.assertIn("if(m.gun) m.gun.forEach(function(gn){ if(gn) gn.visible = false; });", js,
                      "the gun hand is busy dancing")
        # the pose is written ONLY while dancing — the mixer keeps idle/walk otherwise
        self.assertIn("} else if(m.headBone && m.danceHead){", js,
                      "on exit only the head wobble is cleared, never every bone")
        self.assertNotIn("m.bones.armL.rotation.z = 0; m.bones.armR.rotation.z = 0;", js,
                         "zeroing every bone each frame was what made everyone look like they dance")
        # the disco ball hangs over a dancer's head
        self.assertIn("m.discoBall", js, "addPlayer must build a disco ball")
        self.assertIn("m.discoBall.visible = dancing && !P.dead;", js)
        # 10. the disco mark is its own kind (a charm drop must not clear it)
        self.assertIn('clearMarks(P, "disco")', js)
        self.assertIn('clearMarks(P, "charm")', js, "charm and disco marks clear independently")
        self.assertIn("tag.__kind = mk;", js)

    def test_the_six_joke_world_totems_are_wired_on_both_sides(self):
        """User ask: six more funny totems — Banana Panic (10s, peels you slip on),
        Floor Is Lava (8s, patches that launch you), Goose Attack (10s, one angry
        goose), Reverse Controls (8s, WASD backwards), Black Hole (6s, sucks the
        arena in) and Random Weapon Roulette (10s, your gun re-rolls every 2s).
        Geometry constants are STRIKE-SHARED twins; windows live in TOTEMS and
        strike.rs; the personal roster ends with all six; flags ride every living
        row for the arena-wide ones. Numbers live in backend/src/strike/tests.rs;
        this locks the twins."""
        js = read(STRIKE_JS)
        src = block()
        rs = read(STRIKE_RS)
        # 1. the geometry is one frozen set of numbers on both sides (JS packs the
        # names onto a few var lines, so lock the `NAME = value` pair, not `var NAME`)
        for name, val in (
            ("BANANA_N", "10"), ("BANANA_R", "14.0"), ("BANANA_SLIP", "1.1"),
            ("BANANA_SLIDE", "9.0"), ("BANANA_SPIN", "2.2"),
            ("LAVA_ZONES", "5"), ("LAVA_R", "3.2"), ("LAVA_HOLD", "1.4"),
            ("LAVA_DMG", "12"), ("LAVA_LAUNCH", "8.0"),
            ("GOOSE_SPEED", "11.0"), ("GOOSE_HIT_R", "1.3"),
            ("GOOSE_DMG", "18"), ("GOOSE_KNOCK", "6.0"),
            ("HOLE_R", "2.2"), ("HOLE_PULL", "14.0"), ("HOLE_REACH", "56.0"),
            ("ROULETTE_GAP", "2.0"),
        ):
            self.assertIn("%s = %s" % (name, val), src, name)
            self.assertIn("pub const %s: %s = %s;" % (
                name,
                "usize" if name in ("BANANA_N", "LAVA_ZONES") else
                "i64" if name in ("LAVA_DMG", "GOOSE_DMG") else "f64",
                val), rs, name)
        # 2. the windows
        for kind, dur in (("banana", 10), ("lava", 8), ("goose", 10),
                          ("reverse", 8), ("blackhole", 6), ("roulette", 10)):
            self.assertIn("dur: %d," % dur, js, "TOTEMS.%s.dur" % kind)
        for name, val in (("BANANA", "10.0"), ("LAVA", "8.0"), ("GOOSE", "10.0"),
                          ("REVERSE", "8.0"), ("BLACKHOLE", "6.0"), ("ROULETTE", "10.0")):
            self.assertIn("pub const %s: f64 = %s;" % (name, val), rs, name)
        # 3. TOTEM_KINDS grew by six, in roster order, and the JS rosters match
        self.assertIn("pub const TOTEM_KINDS: [&str; 60]", rs)
        self.assertIn("\"banana\", \"lava\", \"goose\", \"reverse\", \"blackhole\", \"roulette\",", rs)
        self.assertEqual(js.count('"bighead","disco","banana","lava","goose","reverse","blackhole","roulette","turret","barrel","laser","jumppad","lottery"];'), 3,
                         "all three JS drop rosters (totemSpawn / wardenLoot / nonDisTotems) end with Wave G")
        # 4. every one of the six has a help line and a totemApply arm
        for kind, word in (("banana", "Banana peels scatter"), ("lava", "random patches of the floor turn to lava"),
                           ("goose", "An angry goose spawns"), ("reverse", "everyone's WASD is reversed"),
                           ("blackhole", "A tiny black hole opens"), ("roulette", "every player's weapon randomly switches")):
            self.assertIn(word, js, "TOTEM_HELP." + kind)
            self.assertIn('kind === "%s"' % kind, js, "totemApply arm for " + kind)
        # 5. the two arena-wide windows ride FLAG_REVERSE / FLAG_ROULETTE on every row
        self.assertIn("FLAG_REVERSE = 536870912;", js)
        self.assertIn("pub const FLAG_REVERSE: i64 = 536_870_912;", rs)
        self.assertIn("FLAG_ROULETTE = 1073741824;", js)
        self.assertIn("pub const FLAG_ROULETTE: i64 = 1_073_741_824;", rs)
        self.assertIn("if(has(FLAG_REVERSE)) V.reverseUntil = Math.max(V.reverseUntil||0, t + 0.45);", js)
        self.assertIn("if self.reverse_until > t { FLAG_REVERSE } else { 0 }", rs)
        self.assertIn("if self.roulette_until > t { FLAG_ROULETTE } else { 0 };", rs)
        # 6. Reverse Controls flips the wish on both sides — player AND bot
        self.assertIn("if(V.reverseUntil && t < V.reverseUntil){ ax = -ax; ay = -ay; }", js)
        self.assertIn("if(V.reverseUntil && t < V.reverseUntil){ ai.wx = -ai.wx; ai.wz = -ai.wz; }", js)
        rs_flat = re.sub(r"\s+", " ", rs)
        self.assertIn("if self.reverse_until > t { wx = -wx; wz = -wz; }", rs_flat)
        # 7. the four world objects ride snapshot keys and get meshes
        for key, fn in (("bn", "addBanana"), ("lz", "addLavaZone"), ("gs", "addGoose"), ("bh", "addBlackHole")):
            self.assertIn('m.%s' % key, js, "snapshot key %s" % key)
            self.assertIn("R.%s" % fn, js, "mesh builder %s" % fn)
        self.assertIn('self.bananas', rs)
        self.assertIn('self.lava_zones', rs)
        # goose / black hole are LISTS now — a second take stacks, it never replaces
        self.assertIn('pub geese: Vec<Goose>', rs)
        self.assertIn('pub blackholes: Vec<BlackHole>', rs)
        self.assertIn('self.geese.push(', rs)
        self.assertIn('self.blackholes.push(', rs)
        self.assertIn('R.moveGeese', js)
        self.assertIn('R.moveBlackHoles', js)
        # 8. the slip holds and spins — it is not a one-tick impulse the wish eats
        self.assertIn("B.slipVx = (svx/sln) * FS.BANANA_SLIDE;", js)
        self.assertIn("if(slipMe){ V.me.vx = V.me.slipVx; V.me.vz = V.me.slipVz; }   // the slide holds", js)
        self.assertIn("if(slipMe) V.yaw += FS.BANANA_SPIN * dt;   // …and you spin", js)
        self.assertIn("p.slip_vx = sx;", rs)
        self.assertIn("b.body.vx = svx;", rs)
        self.assertIn("aim_y = (aim_y + BANANA_SPIN.to_degrees() * dt).rem_euclid(360.0);", rs)
        # 9. a bot's physics body owns its motion — knock/pull write the body too
        self.assertIn("if let Some(b) = p.bot.as_mut() {", rs)
        self.assertIn("b.body.vx = dx / ln * GOOSE_KNOCK;", rs)
        self.assertIn("b.body.x += px;", rs)
        # 10. env kills, not a shooter's kill: lava and the goose name the disaster
        self.assertIn('self.env_kill(j, "lava", t);', rs)
        self.assertIn('self.env_kill(j, "goose", t);', rs)
        # 11. the hole's pull covers the ARENA (HOLE_REACH), never a bubble of
        # HOLE_R * k — the first cut was `HOLE_R * 8` = 17.6 m on an 84 x 60 m map,
        # which is why "black hole doesn't seem to be working"
        self.assertIn("if(hlen > FS.HOLE_REACH) return;", js)
        self.assertIn("if ln > HOLE_REACH {", rs)
        self.assertNotIn("HOLE_R * 8", js)
        self.assertNotIn("HOLE_R * 8.0", rs)
        self.assertIn("pub const HOLE_REACH: f64 = 56.0;", rs)

    def test_the_wave_g_trap_and_gadget_set_is_wired_on_both_sides(self):
        """User ask: five more totems — Mini Turret (10s, drops turrets that auto-shoot
        enemies in range), Explosive Barrels (instant, three big barrels fall from the
        sky, 10x launcher blast, shoot one to detonate), Laser Grid (8s, tripwires that
        kill on touch — jump over or go beside), Jump Pad (10s, three pads that launch
        you sky-high) and Death Lottery (instant, one living enemy heals to full or
        dies). Geometry constants are STRIKE-SHARED twins; the personal roster ends
        with all five; the five ride TOTEM_KINDS and the drop tables. Numbers live in
        backend/src/strike/tests.rs; this locks the twins."""
        js = read(STRIKE_JS)
        src = block()
        rs = read(STRIKE_RS)
        # 1. the geometry is one frozen set of numbers on both sides
        for name, val, typ in (
            ("TURRET_N", "3", "usize"), ("TURRET_HP", "60", "i64"),
            ("TURRET_RANGE", "14.0", "f64"), ("TURRET_DMG", "8", "i64"),
            ("TURRET_GAP", "0.7", "f64"), ("TURRET_R", "0.55", "f64"),
            ("BARREL_N", "3", "usize"), ("BARREL_HP", "40", "i64"),
            ("BARREL_R", "12.0", "f64"), ("BARREL_DMG", "750", "i64"),
            ("BARREL_MIN", "250", "i64"), ("BARREL_DIRECT", "1200", "i64"),
            ("BARREL_RAD", "0.7", "f64"), ("BARREL_FALL", "18.0", "f64"),
            ("LASER_N", "8", "usize"), ("LASER_Y", "0.85", "f64"),
            ("LASER_HALF", "0.32", "f64"), ("LASER_LEN", "12.0", "f64"),
            ("LASER_CLEAR", "1.15", "f64"),
            ("PAD_N", "3", "usize"), ("PAD_R", "1.6", "f64"),
            ("PAD_LAUNCH", "22.0", "f64"), ("PAD_COOL", "2.5", "f64"),
            ("LOTTERY_HEAL", "100", "i64"),
        ):
            self.assertIn("%s = %s" % (name, val), src, name)
            self.assertIn("pub const %s: %s = %s;" % (name, typ, val), rs, name)
        # 2. the windows
        for kind, dur in (("turret", 10), ("laser", 8), ("jumppad", 10)):
            self.assertIn("dur: %d," % dur, js, "TOTEMS.%s.dur" % kind)
        for name, val in (("TURRET", "10.0"), ("LASER", "8.0"), ("JUMPPAD", "10.0"),
                          ("BARREL", "0.0"), ("LOTTERY", "0.0")):
            self.assertIn("pub const %s: f64 = %s;" % (name, val), rs, name)
        # 3. TOTEM_KINDS carries all five in roster order
        self.assertIn("pub const TOTEM_KINDS: [&str; 60]", rs)
        self.assertIn('"turret", "barrel", "laser", "jumppad", "lottery",', rs)
        kinds_blk = rs.split("TOTEM_KINDS")[1].split("];")[0]
        for kind in ("turret", "barrel", "laser", "jumppad", "lottery"):
            self.assertIn('"%s"' % kind, kinds_blk, kind + " is one of TOTEM_KINDS")
        # 4. every one of the five has a help line and a totemApply arm
        for kind, word in (("turret", "Drops 3 mini turrets"),
                           ("barrel", "3 big explosive barrels crash down"),
                           ("laser", "laser tripwires criss-cross"),
                           ("jumppad", "Places 3 launch pads"),
                           ("lottery", "Instant: picks one living enemy at random")):
            self.assertIn(word, js, "TOTEM_HELP." + kind)
            self.assertIn('kind === "%s"' % kind, js, "totemApply arm for " + kind)
        # 5. the four world objects ride snapshot keys and get meshes
        for key, fn in (("tr", "addTurret"), ("br", "addBarrel"),
                        ("lg", "addLaser"), ("pd", "addPad")):
            self.assertIn("m.%s" % key, js, "snapshot key %s" % key)
            self.assertIn("R.%s" % fn, js, "mesh builder %s" % fn)
            self.assertIn('"%s"' % key, rs, "the judge emits snapshot key %s" % key)
        self.assertIn("pub turrets: Vec<Turret>", rs)
        self.assertIn("pub barrels: Vec<Barrel>", rs)
        self.assertIn("pub lasers: Vec<Laser>", rs)
        self.assertIn("pub pads: Vec<JumpPad>", rs)
        self.assertIn("self.turrets.push(", rs)
        self.assertIn("self.barrels.push(", rs)
        self.assertIn("self.lasers.push(", rs)
        self.assertIn("self.pads.push(", rs)
        self.assertIn("R.moveTurret", js)
        self.assertIn("R.moveBarrel", js)
        self.assertIn("R.moveLasers", js)
        self.assertIn("R.movePads", js)
        # 6. the shared geometry helpers are in the STRIKE-SHARED block (frozen)
        for name in ("segDist2", "barrelBox", "turretBox"):
            self.assertIn("function %s" % name, src, name)
        for name in ("seg_dist2", "barrel_box", "turret_box"):
            self.assertIn("fn %s" % name, rs, name)
        self.assertIn("segDist2: segDist2", js, "FS must export the shared helpers")
        self.assertIn("barrelBox: barrelBox", js)
        self.assertIn("turretBox: turretBox", js)
        # 7. barrel blast is 10x a launcher: DIRECT 1200, falloff 750->250 to BARREL_R
        self.assertIn("if(dist < FS.DIRECT_R) dmg = FS.BARREL_DIRECT;", js)
        self.assertIn("Math.round(FS.BARREL_DMG - (FS.BARREL_DMG - FS.BARREL_MIN) * (dist / FS.BARREL_R))", js)
        self.assertIn("if dist < DIRECT_R {", rs)
        self.assertIn("BARREL_DIRECT", rs)
        self.assertIn(".round() as i64", rs, "the falloff rounds like Math.round")
        # 8. laser trip: only when the body is BELOW LASER_CLEAR ABOVE THE DECK
        #    (jumping over saves you). The beams are planted on the deck under the
        #    body, so the gate is height-above-ground — never an absolute world y
        #    (a walker on the dockyard's raised centre stands at y=3.5).
        self.assertIn("if(((B.y || 0) - holeGroundY(B.x, B.z)) >= FS.LASER_CLEAR) return;", js)
        self.assertIn("if v.y - ground_y(self.map(), v.x, v.z) >= LASER_CLEAR {", rs)
        self.assertIn("segDist2(B.x, B.z, LG.ax, LG.az, LG.bx, LG.bz)", js)
        self.assertIn("seg_dist2(v.x, v.z, lz.ax, lz.az, lz.bx, lz.bz)", rs)
        self.assertIn('self.env_kill(j, "laser", t);', rs)
        self.assertIn('endBotLife(null, P, t, false, "laser");', js)
        self.assertIn('endBotLife(null, null, t, false, "laser");', js,
                      "YOUR laser death goes through endBotLife, the real death site")
        # 9. jump pad: PAD_LAUNCH on the body, PAD_COOL cool-down, air let-up so the
        #    judge buys the flight (PAD_COOL must cover the 2*PAD_LAUNCH/GRAVITY arc)
        self.assertIn("B.vy = FS.PAD_LAUNCH;", js)
        self.assertIn("B.padCool = t + FS.PAD_COOL;", js)
        self.assertIn("p.pad_cool = t + PAD_COOL;", rs)
        self.assertIn("b.body.vy = PAD_LAUNCH;", rs)
        self.assertIn("let pad_let_up = p.pad_cool > t;", rs,
                      "the judge buys the pad flight like a wing")
        self.assertIn("if(((B.y || 0) - holeGroundY(B.x, B.z)) > 0.35) return;", js,
                      "the pad gate is height above the deck, not an absolute y")
        self.assertIn("p.y - ground_y(m, p.x, p.z) > 0.35", rs,
                      "the judge's pad gate is height above the deck (map hoisted out of the mut loop)")
        self.assertGreaterEqual(2.5, 2.0 * 22.0 / 18.0,
                                "PAD_COOL covers the PAD_LAUNCH arc (2*22/18 = 2.44s)")
        # 10. turret fire: nearest ENEMY in TURRET_RANGE, TURRET_DMG, every TURRET_GAP
        self.assertIn("if(P.team === TU.team) return;", js, "a turret never shoots a team-mate")
        self.assertIn("if v.dead || v.gone || v.team == tteam {", rs, "nor a dead body")
        self.assertIn("FS.TURRET_DMG", js)
        self.assertIn("TURRET_DMG", rs)
        self.assertIn("t < (TU.next || 0)", js)
        self.assertIn("TURRET_GAP", rs)
        # 11. destructible hits: turret or barrel eats the bullet in fire() / bot_fire()
        self.assertIn("function wavegRay(", js)
        self.assertIn("function wavegHit(", js)
        self.assertIn("function barrelBlast(", js)
        self.assertIn("fn waveg_ray(", rs)
        self.assertIn("fn waveg_hit(", rs)
        self.assertIn("fn barrel_blast(", rs)
        self.assertIn("self.waveg_ray(o, d, reach)", rs)
        self.assertIn("wavegRay(e, d, end)", js)
        # 12. death lottery: one living ENEMY, heal to full or die — never Math.random
        self.assertIn("P.team !== V.team", js, "the lottery only picks enemies")
        self.assertIn("team != taker_team", rs, "nor team-mates")
        self.assertIn("FS.LOTTERY_HEAL", js)
        self.assertIn("LOTTERY_HEAL", rs)
        self.assertIn('self.env_kill(pick, "lottery", t);', rs)
        self.assertIn('endBotLife({uid: myId()', js)
        self.assertIn("hash_match(seed, 3) < 0.5", rs, "the flip is deterministic")
        self.assertIn("hashMatch(lseed2, 3) < 0.5", js)
        self.assertNotIn("Math.random(", re.sub(r"/\*.*?\*/", "", re.sub(r"//.*?$", "", js, flags=re.M), flags=re.S))
        # 13. ENV_NAMES covers all four kill causes (the fifth — jumppad — never kills)
        for cause, label in (("turret", "a mini turret"), ("barrel", "an explosive barrel"),
                             ("laser", "the laser grid"), ("lottery", "the death lottery")):
            self.assertIn('"%s": "%s"' % (cause, label), js, "ENV_NAMES." + cause)
        # 14. barrels fall out of the sky and land
        self.assertIn("BO.vy = (BO.vy || 0) - 28 * dt;", js)
        self.assertIn("bo.vy -= 28.0 * dt;", rs)
        self.assertIn("BARREL_FALL", js)
        self.assertIn("BARREL_FALL", rs)
        self.assertIn("pub vy: f64,", rs, "Barrel carries a fall velocity")

    def test_lightning_is_zigzag_and_near_strikes_hit_harder(self):
        """User ask: lightning must zig-zag (not a straight line), and the blast must
        bite harder near the bolt. Every disaster also needs a fitting non-HP impact
        (blinding / slowness / wild aim) on players and bots."""
        js = read(STRIKE_JS)
        rs = read(STRIKE_RS)
        # 1. a hashed zig-zag bolt — never a 2-point straight line, never Math.random
        self.assertIn("function boltPts(", js, "the bolt path must be a hashed zig-zag")
        self.assertIn("function boltBranch(", js, "the bolt needs a side fork")
        self.assertIn("boltPts(seedB, 7, skyX, 22, skyZ, mx, 0.2, mz, 9, 1.8)", js)
        self.assertIn("F.boltHalo", js, "the bolt has a bright core + halo")
        self.assertIn("F.boltBranch", js)
        # comments may name Math.random() as the thing to avoid; only flag real calls
        js_code = re.sub(r"/\*[\s\S]*?\*/", "", js)
        js_code = re.sub(r"//.*?$", "", js_code, flags=re.M)
        self.assertNotIn("Math.random(", js_code, "deterministic sprites/bolts only")
        # 2. proximity crush (more damage near the strike) in both judges
        self.assertIn("function markDamage(dist, r, dmg)", js)
        self.assertIn("FS.markDamage(ddMe, Mk.r, Mk.dmg|0)", js)
        self.assertIn("FS.markDamage(ddP, Mk.r, Mk.dmg|0)", js)
        self.assertIn("DD_NEAR_R = 0.35, DD_NEAR_MIN = 0.45", js)
        self.assertIn("pub fn mark_damage(dist: f64, r: f64, dmg: i64) -> i64", rs)
        self.assertIn("let hit = mark_damage(dd, w.r, w.dmg);", rs)
        self.assertIn("DD_NEAR_R: f64 = 0.35", rs)
        self.assertIn("DD_NEAR_MIN: f64 = 0.45", rs)
        # 3. non-HP impacts: blind + slow, twin windows
        for name, val in (
            ("DD_THUNDER_BLIND", "0.45"),
            ("DD_METEOR_BLIND", "0.35"),
            ("DD_SHOCK_BLIND", "0.55"),
            ("DD_QUAKE_SLOW", "1.2"),
            ("DD_TOXIC_SLOW", "0.75"),
            ("DD_SINK_SLOW", "0.65"),
            ("DD_WIND_SLOW", "0.7"),
            ("DD_WIND_CATCH_R", "3.6"),
            ("DD_WIND_TOP", "4.2"),
            ("DD_WIND_LIFT", "3.2"),
            ("DD_WIND_SPIN", "2.6"),
            ("DD_WIND_CATCH", "1.6"),
            ("DD_SLOW_MULT", "0.65"),
            ("DD_SAND_SCATTER", "1.2"),
            ("DD_WIND_SCATTER", "2.4"),
            ("DD_EMP_SCATTER", "1.0"),
        ):
            self.assertIn("%s = %s" % (name, val), js, name)
            self.assertIn("%s: f64 = %s" % (name, val), rs, name)
        self.assertIn("V.blindUntil = Math.max(V.blindUntil|0, t + DD_THUNDER_BLIND)", js)
        self.assertIn("V.slowUntil = Math.max(V.slowUntil|0, t + DD_QUAKE_SLOW)", js)
        self.assertIn("p.blind_until = t + DD_THUNDER_BLIND", rs)
        self.assertIn("p.slow_until = t + DD_QUAKE_SLOW", rs)
        # hurricane vortex: the Rust twin flies the same orbit
        self.assertIn("fn wind_catch(", rs)
        self.assertIn("vortex_until", rs)
        self.assertIn("Self::wind_catch(", rs)
        self.assertIn("DD_WIND_CATCH_R", rs)
        self.assertIn("DD_WIND_TOP", rs)
        self.assertIn("DD_WIND_SPIN", rs)
        self.assertIn("DD_WIND_LIFT", rs)
        self.assertIn("DD_WIND_CATCH", rs)
        # wild aim / grit / EMP scatter on every shot (solo fire + MP judge)
        self.assertIn("disAimScatter(t)", js)
        self.assertIn("fn disaster_scatter(&self, t: f64) -> f64", rs)
        self.assertIn("fn bot_aim_mult(&self, t: f64, blind: bool) -> f64", rs)
        self.assertIn('aimX = disKindLive(t, "emp") ? 3', js)
        self.assertIn('"hurricane" => 2.0,', rs)
        # the white-out veil is mounted and toggled
        self.assertIn("vg-fps-blind", js)
        self.assertIn("blindOv", js)

    def test_disaster_visual_and_impact_share_one_geometry(self):
        """User bug lock: disasters must have impact on all players and bots, and the
        hazard you SEE must be the hazard that HURTS.

        Before: toxicfog painted 3 clouds at fixed angles while damage re-rolled
        dropSpot/open_spot every second; sinkhole pit mesh and pull used different
        hash formulas; hurricane only shoved. Every disaster is now visual AND impact
        on one frozen geometry shared by solo worldTick and the server judge.
        """
        js = read(STRIKE_JS)
        rs = read(STRIKE_RS)
        # sticky geometry helpers (client + server twins)
        self.assertIn("function disSpot(", js)
        self.assertIn("function disZonesNear(", js)
        self.assertIn("fn dis_spot(", rs)
        self.assertIn("fn dis_zones_near(", rs)
        # frozen at start — never re-rolled mid-hold (each entry of V.disasters)
        self.assertIn("D.seed", js)
        self.assertIn("D.zones", js)
        self.assertIn("D.pit", js)
        self.assertIn("pub seed: u32", rs)
        self.assertIn("pub zones: Vec<(f64, f64)>", rs)
        self.assertIn("pub pit: (f64, f64)", rs)
        # impact marks aim at live bodies so a shower can connect
        self.assertIn("ptsD.length && (D.markK % 3) === 1", js)
        self.assertIn("d.mark_k % 3 == 1", rs)
        # MP snap ships the shared geometry + mark damage
        self.assertIn("d.zones.iter().map(|z| json!([cm(z.0), cm(z.1)])", rs)
        self.assertIn("w.quake as i64,", rs)
        self.assertIn("w.dis", rs)
        self.assertIn("D.seed", js)
        self.assertIn("dmg: (r[6]|0) || 0", js)
        # hurricane chip on both sides
        self.assertIn("DD_WIND_DMG", js)
        self.assertIn("DD_WIND_DMG", rs)
        # D.pit is ALWAYS [x, z] — the judge and the FX both index it that way.
        # (disSpot returns [x, 0, z]; disStart drops the 0. A 3-tuple made the sinkhole
        # damage zone sit at (x, 0) while the mesh sat at (x, z) — the user saw a pit
        # and took no damage from it.)
        self.assertIn("D.pit = [pitS[0], pitS[2]]", js)
        self.assertIn("return [spS[0], spS[2]];", js)
        self.assertIn("pub pit: (f64, f64)", rs)
        # sinkhole damage reads that same point
        self.assertIn("let (zx, zz) = d.pit;", rs)
        self.assertIn("DD_SINK_DMG", js)
        self.assertIn("DD_SINK_DMG", rs)
        # earthquake damage reads the mark, and the mark's slow is applied
        self.assertIn("DD_QUAKE_DMG", js)
        self.assertIn("DD_QUAKE_DMG", rs)
        self.assertIn("DD_QUAKE_SLOW", js)
        self.assertIn("DD_QUAKE_SLOW", rs)

    def test_r3_disaster_is_defined_not_just_called(self):
        """Wave F: `if(R3 && R3.disaster) R3.disaster(...)` is called from four sites.

        Before Wave F the method was never defined, so the guard silently skipped and
        every disaster was invisible (Absolute Zero was only movement numbers). This
        test locks the definition existing inside build3d, and that the per-kind
        theatre switch covers all 10 disasters.
        """
        js = read(STRIKE_JS)
        self.assertIn("R.disaster = function", js,
                      "R.disaster must be defined (the call sites already guard on it)")
        # the definition must live inside build3d (it closes over scene/sun/hemi/fx state)
        b0 = js.find("function build3d(")
        self.assertGreater(b0, 0, "build3d missing")
        d0 = js.find("R.disaster = function", b0)
        self.assertGreater(d0, 0, "R.disaster must be defined inside build3d")
        # every disaster kind must have a live banner line (DIS_LIVE) so the hold is named
        for kind in ("sandstorm", "meteorshower", "hurricane", "thunder", "earthquake",
                     "shockring", "toxicfog", "absolutezero", "sinkhole", "emp"):
            self.assertIn(kind + ":", js[js.find("var DIS_LIVE"):js.find("var DIS_LIVE") + 2000],
                          "DIS_LIVE must name every disaster kind")

    def test_void_fall_is_rescued_after_ten_seconds(self):
        """User bug lock: thrown out of the map = endless free-fall, no way to die.

        Before: a body past the deck kept falling forever (damage is the only death
        and you can't shoot yourself). Now both judges track a void clock and put
        every living body — player or bot — back under a canopy after 10s.
        """
        js = read(STRIKE_JS)
        rs = read(STRIKE_RS)
        # shared detector: off the map box / under the deck with no slab / past VOID_Y
        self.assertIn("function inVoid(", js)
        self.assertIn("pub fn in_void(", rs)
        self.assertIn("VOID_Y = -2.0", js)
        self.assertIn("VOID_Y: f64 = -2.0", rs)
        self.assertIn("VOID_SECS = 10.0", js)
        self.assertIn("VOID_SECS: f64 = 10.0", rs)
        # the clock lives on the body (not a module scratch that leaks across players)
        self.assertIn("V.voidAt", js)
        self.assertIn("P.ai.voidAt", js)
        self.assertIn("pub void_at: f64", rs)
        # rescue path: parachute drop for both solo and MP
        self.assertIn("dropSpawn(V.mySlot != null ? V.mySlot : 0)", js)
        self.assertIn("p.void_at >= VOID_SECS", rs)
        self.assertIn('"drop": true', rs)
        # MP: the client must NOT self-rescue (the referee emits the spawn)
        self.assertIn('t - V.voidAt >= FS.VOID_SECS && V.mode !== "mp"', js)
        # HUD says how long is left instead of leaving you blind in the sky
        self.assertIn("Out of bounds — back in", js)
        # no endless free-fall: the canopy over a floor gap keeps sinking (void clock)
        self.assertIn("floor == null) floor = -1e9", js)
        self.assertIn("floor == null) floor = -1e9", js)

    def test_weapons_match(self):
        # FS.WEAPONS under node is the honest parse (regex over JS object literals is not)
        self.skipTest("covered by test_shared_functions_match_under_node (FS.WEAPONS)")

    def test_shared_functions_match_under_node(self):
        self.skipTest("Python strike.py is gone — add FS parity under backend/src/strike/tests.rs if needed")
        f = self.strike
        m = f.MAP
        data = json.loads(read(MAP))
        # rays: from a grid of eyes in many directions, against the map and a player
        rays = []
        for i in range(160):
            o = (-20 + (i * 7.3) % 40, 0.3 + (i * 1.7) % 4, -14 + (i * 3.1) % 28)
            yaw, pitch = (i * 37.7) % 360 - 180, (i * 11.3) % 120 - 60
            rays.append([o, yaw, pitch, ((i * 5.1) % 30 - 15, (i % 3) * 0.7, (i * 2.3) % 30 - 15)])
        # movement: a few runners steering through the dock, jumping now and then
        runs = []
        for k in range(6):
            sx, sy, sz, _ = m["spawns"][k]
            steps = []
            for j in range(900):
                a = (k * 1.3 + j * 0.011) % (2 * math.pi)
                steps.append([math.sin(a), -math.cos(a), j % 97 == 0])
            runs.append([[sx, sy, sz], steps])
        script = block() + """
var input = %s, m = FS.compileMap(input.data), out = {rays: [], runs: [], spread: [], mb: [], over: [], weapons: []};
FS.WEAPONS.forEach(function(w){ out.weapons.push(w); });
input.rays.forEach(function(r){
  var d = FS.dirOf(r[1], r[2]);
  out.rays.push([d, FS.rayMap(m, r[0], d, 80), FS.rayPlayer(r[0], d, r[3][0], r[3][1], r[3][2], 80)]);
});
input.runs.forEach(function(rn){
  var s = {x: rn[0][0], y: rn[0][1], z: rn[0][2], vx: 0, vy: 0, vz: 0, g: true}, trace = [];
  rn[1].forEach(function(st, j){ FS.move(m, s, st[0], st[1], st[2], 1/120); if(j %% 30 === 0) trace.push([s.x, s.y, s.z, s.g]); });
  out.runs.push(trace);
});
for(var n = 0; n < 200; n++){ out.spread.push([FS.spreadOf(n, 0), FS.spreadOf(n, 1)]); out.mb.push(FS.mb32(n * 7919)); }
for(var x = -21; x <= 21; x += 1.5) for(var z = -15; z <= 15; z += 1.5) out.over.push(FS.overlaps(m, x, 0.2, z, 0.05));
console.log(JSON.stringify(out));
""" % json.dumps({"data": data, "rays": rays, "runs": runs})
        res = subprocess.run([NODE, "-"], input=script, capture_output=True, text=True, timeout=120)
        self.assertEqual(res.returncode, 0, res.stderr)
        got = json.loads(res.stdout)
        for i, w in enumerate(got["weapons"]):
            self.assertEqual(w["id"], self.strike.WEAPONS[i]["id"])
            self.assertEqual(w["name"], self.strike.WEAPONS[i]["name"])
            for k in ("interval", "damage", "head", "mag", "reserve", "reload", "spread", "range", "pack"):
                self.assertEqual(float(w[k]), float(self.strike.WEAPONS[i][k]), (w["id"], k))
        for (o, yaw, pitch, tp), (d, tm, tpl) in zip(rays, got["rays"]):
            want = f.dir_of(yaw, pitch)
            for a, b in zip(d, want):
                self.assertAlmostEqual(a, b, places=9)
            self.assertAlmostEqual(tm, f.ray_map(m, o, want, 80), places=6)
            wp = f.ray_player(o, want, tp[0], tp[1], tp[2], 80)
            if wp is None:
                self.assertIsNone(tpl)
            else:
                self.assertAlmostEqual(tpl[0], wp[0], places=6)
                self.assertEqual(tpl[1], wp[1])
        hits = sum(1 for _, _, tpl in got["rays"] if tpl is not None)
        self.assertGreater(len(rays), hits)
        for (start, steps), trace in zip(runs, got["runs"]):
            s = {"x": start[0], "y": start[1], "z": start[2], "vx": 0.0, "vy": 0.0, "vz": 0.0, "g": True}
            want = []
            for j, st in enumerate(steps):
                f.move(m, s, st[0], st[1], st[2], 1 / 120)
                if j % 30 == 0:
                    want.append([s["x"], s["y"], s["z"], s["g"]])
            for a, b in zip(trace, want):
                for u, v in zip(a[:3], b[:3]):
                    self.assertAlmostEqual(u, v, places=6)
                self.assertEqual(a[3], b[3])
        for n, (a, b) in enumerate(got["spread"]):
            self.assertEqual(tuple(a), f.spread_of(n, 0))
            self.assertEqual(tuple(b), f.spread_of(n, 1))
            self.assertEqual(got["mb"][n], f.mb32(n * 7919))
        k = 0
        x = -21.0
        while x <= 21:
            z = -15.0
            while z <= 15:
                self.assertEqual(got["over"][k], f.overlaps(m, x, 0.2, z, 0.05), (x, z))
                k += 1
                z += 1.5
            x += 1.5


if __name__ == "__main__":
    unittest.main()
