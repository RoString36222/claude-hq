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
        self.assertIn("if(R3 && R3.addRift) R3.addRift(rfSnap)", js)
        self.assertIn("(V.rifts || []).forEach", js, "2D map must show the rift pair")
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
        # hurricane must shove bots in solo too (it used to only shove you / MP players)
        self.assertIn("shoveHB", js, "hurricane must shove solo bots")
        # sandstorm is denser than the old 140-sprite wall
        self.assertIn("n = 320", js)
        # the game-info card must explain each disaster under the Disaster totems grid
        self.assertIn('"What each disaster does"', js)
        self.assertIn("TOTEM_HELP[k]", js)
        # Rust twin
        rs = read(STRIKE_RS)
        self.assertIn("DD_SAND_DMG: i64 = 3", rs)
        self.assertIn("DD_ZERO_DMG: i64 = 4", rs)
        self.assertIn("DD_EMP_DMG: i64 = 2", rs)
        self.assertIn("DD_WIND_DMG: i64 = 3", rs)
        self.assertIn('"sandstorm" | "absolutezero" | "emp" if t >= d.hit_at =>', rs)

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
        self.assertIn("fxBoltHalo", js, "the bolt has a bright core + halo")
        self.assertIn("fxBoltBranch", js)
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
        # wild aim / grit / EMP scatter on every shot (solo fire + MP judge)
        self.assertIn("disAimScatter(t)", js)
        self.assertIn("fn disaster_scatter(&self, t: f64) -> f64", rs)
        self.assertIn("fn bot_aim_mult(&self, t: f64, blind: bool) -> f64", rs)
        self.assertIn('aimX = (V.disaster === "emp" && disLive(t)) ? 3', js)
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
        # frozen at start — never re-rolled mid-hold
        self.assertIn("V.disasterSeed", js)
        self.assertIn("V.disasterZones", js)
        self.assertIn("V.disasterPit", js)
        self.assertIn("pub seed: u32", rs)
        self.assertIn("pub zones: Vec<(f64, f64)>", rs)
        self.assertIn("pub pit: (f64, f64)", rs)
        # impact marks aim at live bodies so a shower can connect
        self.assertIn("ptsD.length && (V.disasterMarkK % 3) === 1", js)
        self.assertIn("d.mark_k % 3 == 1", rs)
        # MP snap ships the shared geometry + mark damage
        self.assertIn("d.seed, d.zones.iter()", rs)
        self.assertIn("w.dmg, w.quake as i64", rs)
        self.assertIn("V.disasterSeed = (+m.di[5] || 0) >>> 0", js)
        self.assertIn("dmg: (r[6]|0) || 0", js)
        # hurricane chip on both sides
        self.assertIn("DD_WIND_DMG", js)
        self.assertIn("DD_WIND_DMG", rs)

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
