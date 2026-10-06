"""
Valley multiplayer: server-refereed minigames on top of the room websockets.

Clients send {"type": "game", "g": <game>, "op": <op>, ...}; this module owns the
rules and answers with {"type": "game", "g": <game>, "ev": <event>, ...}. Every game
has a lobby (who is in it, who hosts) with join notices and invites. The games:

  pond   shared fishing dock: the server picks each bite, times the reel and scores
         the catch; a room goal; a boss fish the whole lobby reels in together.
  race   live code-puzzle race: the server holds the word and marks each guess.
  duel   1v1 creature battle on the Gym's type chart; the server computes damage.
  mines  co-op mine floor: one shared grid, server-side loot and slimes.
  farm   one shared garden per room, stored in the database and watered by the
         members' real published activity (daily_stats prompts).
  golf   3D mini golf: the server rolls every putt with integer physics (app/golf.py)
         that the clients replay identically; walking positions are relayed to the
         lobby only, at most ~10 per second per player.

Only game state lives here; nothing transcript-derived ever reaches this server.
State is in process memory except the farm (same single-instance trade as rooms.py).
"""
import random
import re
import secrets
import time
from datetime import UTC, date, datetime, timedelta
from typing import Any

from sqlalchemy import func, select

from . import golf as golfmod
from .db import SessionLocal
from .models import DailyStat, RoomFarm
from .rooms import Member, Room, manager

GAMES = ("pond", "race", "duel", "mines", "farm", "golf")
GAME_NAMES = {"pond": "Fishing Pond", "race": "Puzzle Race", "duel": "Creature Duel",
              "mines": "Co-op Mines", "farm": "Shared Farm", "golf": "Mini Golf"}
MAX_LOBBY = 8
now = time.monotonic          # patched in tests
wall = time.time              # patched in tests

# ----------------------------------------------------------------- catalogs --
# Mirrors games/core.js (fish rarity) and the crop table; keep in sync.
FISH = {
    "minnow": 1, "perch": 1, "carp": 1, "mudcat": 1, "bream": 2, "trout": 2, "pike": 2,
    "eel": 2, "sunfish": 2, "koi": 3, "sturgeon": 3, "angler": 3, "glowfin": 3,
    "lumen": 4, "leviathan": 4, "ghostfish": 4,
}
FISH_WEIGHT = {1: 10, 2: 5, 3: 2, 4: 0.6}
FISH_POINTS = {1: 1, 2: 3, 3: 8, 4: 20}
MIN_REEL_MS = {1: 1500, 2: 2200, 3: 3000, 4: 4000}   # faster than this is not a real reel
MAX_REEL_MS = 90_000
POND_GOAL = 20
BOSS_EVERY = 8                 # a boss surfaces every 8th room catch
BOSS_SECS = 60
BOSS_HP_PER_PLAYER = 40
PULL_RATE = 8                  # pulls per second per player, at most
CROPS = {   # id: (hours, water per gardener, season)
    "radish": (4, 6, "spring"), "pea": (6, 8, "spring"), "tulip": (8, 10, "spring"),
    "tomato": (6, 10, "summer"), "melon": (12, 16, "summer"), "corn": (10, 12, "summer"),
    "pumpkin": (12, 16, "autumn"), "grape": (8, 12, "autumn"), "kale": (6, 8, "winter"),
}
FARM_PLOTS = 9
FARM_SEEDS_PER_DAY = 6
DUEL_TYPES = ("Normal", "Fire", "Water", "Electric", "Grass", "Ice", "Fighting", "Poison", "Ground",
              "Flying", "Psychic", "Bug", "Rock", "Ghost", "Dragon", "Dark", "Steel", "Fairy")
MINE_COLS, MINE_ROWS, MINE_MAX_DEPTH = 12, 8, 12
RACE_GUESSES, RACE_SECS = 6, 180
TYPE_CHART: dict[str, dict[str, float]] = {
    'Normal': {'Rock': 0.5, 'Ghost': 0, 'Steel': 0.5},
    'Fire': {'Fire': 0.5, 'Water': 0.5, 'Grass': 2, 'Ice': 2, 'Bug': 2, 'Rock': 0.5, 'Dragon': 0.5, 'Steel': 2},
    'Water': {'Fire': 2, 'Water': 0.5, 'Grass': 0.5, 'Ground': 2, 'Rock': 2, 'Dragon': 0.5},
    'Electric': {'Water': 2, 'Electric': 0.5, 'Grass': 0.5, 'Ground': 0, 'Flying': 2, 'Dragon': 0.5},
    'Grass': {'Fire': 0.5, 'Water': 2, 'Grass': 0.5, 'Poison': 0.5, 'Ground': 2, 'Flying': 0.5, 'Bug': 0.5, 'Rock': 2, 'Dragon': 0.5, 'Steel': 0.5},
    'Ice': {'Fire': 0.5, 'Water': 0.5, 'Grass': 2, 'Ice': 0.5, 'Ground': 2, 'Flying': 2, 'Dragon': 2, 'Steel': 0.5},
    'Fighting': {'Normal': 2, 'Ice': 2, 'Poison': 0.5, 'Flying': 0.5, 'Psychic': 0.5, 'Bug': 0.5, 'Rock': 2, 'Ghost': 0, 'Dark': 2, 'Steel': 2, 'Fairy': 0.5},
    'Poison': {'Grass': 2, 'Poison': 0.5, 'Ground': 0.5, 'Rock': 0.5, 'Ghost': 0.5, 'Steel': 0, 'Fairy': 2},
    'Ground': {'Fire': 2, 'Electric': 2, 'Grass': 0.5, 'Poison': 2, 'Flying': 0, 'Bug': 0.5, 'Rock': 2, 'Steel': 2},
    'Flying': {'Electric': 0.5, 'Grass': 2, 'Fighting': 2, 'Bug': 2, 'Rock': 0.5, 'Steel': 0.5},
    'Psychic': {'Fighting': 2, 'Poison': 2, 'Psychic': 0.5, 'Dark': 0, 'Steel': 0.5},
    'Bug': {'Fire': 0.5, 'Grass': 2, 'Fighting': 0.5, 'Poison': 0.5, 'Flying': 0.5, 'Psychic': 2, 'Ghost': 0.5, 'Dark': 2, 'Steel': 0.5, 'Fairy': 0.5},
    'Rock': {'Fire': 2, 'Ice': 2, 'Fighting': 0.5, 'Ground': 0.5, 'Flying': 2, 'Bug': 2, 'Steel': 0.5},
    'Ghost': {'Normal': 0, 'Psychic': 2, 'Ghost': 2, 'Dark': 0.5},
    'Dragon': {'Dragon': 2, 'Steel': 0.5, 'Fairy': 0},
    'Dark': {'Fighting': 0.5, 'Psychic': 2, 'Ghost': 2, 'Dark': 0.5, 'Fairy': 0.5},
    'Steel': {'Fire': 0.5, 'Water': 0.5, 'Electric': 0.5, 'Ice': 2, 'Rock': 2, 'Steel': 0.5, 'Fairy': 2},
    'Fairy': {'Fire': 0.5, 'Fighting': 2, 'Poison': 0.5, 'Dragon': 2, 'Dark': 2, 'Steel': 0.5},
}

RACE_WORDS = (
    'admin',
    'agent',
    'alias',
    'array',
    'async',
    'audit',
    'await',
    'batch',
    'bench',
    'blobs',
    'brand',
    'build',
    'bytes',
    'cache',
    'catch',
    'chain',
    'chmod',
    'class',
    'clone',
    'close',
    'cloud',
    'codec',
    'const',
    'count',
    'crash',
    'crate',
    'cycle',
    'dates',
    'debit',
    'debug',
    'defer',
    'delta',
    'draft',
    'drive',
    'embed',
    'entry',
    'epoch',
    'error',
    'event',
    'fetch',
    'field',
    'flags',
    'float',
    'flush',
    'frame',
    'graph',
    'group',
    'guard',
    'heaps',
    'hooks',
    'index',
    'infer',
    'input',
    'istio',
    'items',
    'joins',
    'kafka',
    'label',
    'latch',
    'layer',
    'limit',
    'lines',
    'linux',
    'local',
    'logic',
    'loops',
    'macro',
    'merge',
    'model',
    'mount',
    'mutex',
    'nginx',
    'nodes',
    'order',
    'owner',
    'paged',
    'parse',
    'patch',
    'pivot',
    'pixel',
    'popup',
    'ports',
    'print',
    'proxy',
    'qubit',
    'query',
    'queue',
    'ratio',
    'react',
    'redis',
    'regex',
    'rerun',
    'reset',
    'route',
    'rules',
    'scope',
    'serde',
    'shape',
    'shard',
    'shell',
    'sigma',
    'sleep',
    'slice',
    'spawn',
    'split',
    'stack',
    'state',
    'stdin',
    'store',
    'style',
    'swift',
    'table',
    'tasks',
    'tests',
    'timer',
    'token',
    'tools',
    'trace',
    'trees',
    'tuple',
    'types',
    'union',
    'unzip',
    'utils',
    'value',
    'vault',
    'views',
    'watch',
    'where',
    'while',
    'write',
    'xpath',
    'yield',
    'zones',
)


def season_of(d: date) -> str:
    m = d.month
    return "winter" if m in (12, 1, 2) else "spring" if m <= 5 else "summer" if m <= 8 else "autumn"


def eff(atk: str, dfn: str) -> float:
    return TYPE_CHART.get(atk, {}).get(dfn, 1)


def _clip(v: Any, n: int) -> str:
    return "".join(ch for ch in v if ch.isprintable()).strip()[:n] if isinstance(v, str) else ""


# ------------------------------------------------------------------ outbox --
class Out:
    """Messages to send after a rule ran: to the whole room, one socket, or one user."""

    def __init__(self, g: str):
        self.g = g
        self.items: list[tuple[str, Any, dict]] = []

    def all(self, ev: str, **data: Any) -> None:
        self.items.append(("all", None, {"type": "game", "g": self.g, "ev": ev, **data}))

    def to(self, ws: Any, ev: str, **data: Any) -> None:
        self.items.append(("ws", ws, {"type": "game", "g": self.g, "ev": ev, **data}))

    def user(self, user_id: str, ev: str, **data: Any) -> None:
        self.items.append(("user", user_id, {"type": "game", "g": self.g, "ev": ev, **data}))

    def lobby(self, member_ids: Any, ev: str, skip_user: str | None = None, **data: Any) -> None:
        """Only to the sockets of these lobby members (optionally not back to one user)."""
        self.items.append(("lobby", (frozenset(member_ids), skip_user),
                           {"type": "game", "g": self.g, "ev": ev, **data}))

    def err(self, ws: Any, msg: str) -> None:
        self.to(ws, "error", error=msg)


# ------------------------------------------------------------------- lobby --
class Lobby:
    def __init__(self) -> None:
        self.members: dict[str, dict] = {}     # user_id -> public profile, in join order
        self.host: str | None = None

    def roster(self) -> list[dict]:
        return [dict(p, host=(uid == self.host)) for uid, p in self.members.items()]


class RoomValley:
    def __init__(self, room_id: str):
        self.room_id = room_id
        self.lobbies = {g: Lobby() for g in GAMES}
        self.pond = Pond()
        self.race = Race()
        self.duel = Duel()
        self.mines = Mines()
        self.golf = golfmod.Golf()


_rooms: dict[str, RoomValley] = {}


def valley_for(room_id: str) -> RoomValley:
    v = _rooms.get(room_id)
    if v is None:
        v = _rooms[room_id] = RoomValley(room_id)
    return v


# -------------------------------------------------------------------- pond --
class Pond:
    def __init__(self) -> None:
        self.casts: dict[str, dict] = {}       # user_id -> {token, fish, bite_ms, at}
        self.scores: dict[str, int] = {}
        self.goal = 0
        self.catches = 0
        self.boss: dict | None = None
        self.pulls: dict[str, list[float]] = {}
        self.last_boss_push = 0.0
        self.boss_at = 0               # catch count that last spawned a boss

    def snapshot(self) -> dict:
        return {"casting": list(self.casts), "scores": self.scores, "goal": self.goal,
                "goalTarget": POND_GOAL, "boss": self._boss_view()}

    def _boss_view(self) -> dict | None:
        b = self.boss
        if not b:
            return None
        return {"fish": b["fish"], "hp": max(0, round(b["hp"])), "max": b["max"],
                "left": max(0, round(b["until"] - now()))}

    def _expire_boss(self, out: Out) -> None:
        if self.boss and now() > self.boss["until"]:
            out.all("bossgone", fish=self.boss["fish"])
            self.boss = None
            self.pulls = {}

    def cast(self, m: Member, out: Out, rng: random.Random) -> None:
        self._expire_boss(out)
        if m.user_id in self.casts:
            out.err(m.ws, "you already have a line in the water")
            return
        ids = list(FISH)
        fish = rng.choices(ids, weights=[FISH_WEIGHT[FISH[f]] for f in ids])[0]
        c = {"token": secrets.token_urlsafe(8), "fish": fish,
             "bite_ms": rng.randint(800, 3000), "at": now()}
        self.casts[m.user_id] = c
        out.to(m.ws, "cast", token=c["token"], fish=fish, rarity=FISH[fish], biteIn=c["bite_ms"])
        out.all("casting", user=m.public())

    def land(self, m: Member, msg: dict, out: Out) -> None:
        self._expire_boss(out)
        c = self.casts.get(m.user_id)
        if not c or msg.get("token") != c["token"]:
            out.err(m.ws, "no such cast")
            return
        r = FISH[c["fish"]]
        elapsed = (now() - c["at"]) * 1000
        if elapsed < c["bite_ms"] + MIN_REEL_MS[r]:
            out.err(m.ws, "too fast — that wasn't a real reel")
            return
        del self.casts[m.user_id]
        if elapsed > c["bite_ms"] + MAX_REEL_MS:
            out.all("lost", user=m.public(), fish=c["fish"])
            return
        pts = FISH_POINTS[r]
        self.scores[m.user_id] = self.scores.get(m.user_id, 0) + pts
        self.goal += 1
        self.catches += 1
        out.all("caught", user=m.public(), fish=c["fish"], points=pts, scores=self.scores,
                goal=self.goal, goalTarget=POND_GOAL)
        if self.goal >= POND_GOAL:
            out.all("goal", reward="gold")
            self.goal = 0

    def lose(self, m: Member, msg: dict, out: Out) -> None:
        c = self.casts.get(m.user_id)
        if c and msg.get("token") == c["token"]:
            del self.casts[m.user_id]
            out.all("lost", user=m.public(), fish=c["fish"])

    def maybe_boss(self, lobby: Lobby, out: Out) -> None:
        if self.boss or not self.catches or self.catches % BOSS_EVERY or self.catches == self.boss_at:
            return
        self.boss_at = self.catches
        players = max(1, len(lobby.members))
        hp = BOSS_HP_PER_PLAYER * players
        self.boss = {"fish": "leviathan", "hp": float(hp), "max": hp, "until": now() + BOSS_SECS}
        self.pulls = {}
        out.all("boss", boss=self._boss_view())

    def pull(self, m: Member, out: Out) -> None:
        self._expire_boss(out)
        b = self.boss
        if not b:
            return
        t = now()
        mine = [x for x in self.pulls.get(m.user_id, []) if t - x < 1.0]
        if len(mine) >= PULL_RATE:
            return
        mine.append(t)
        self.pulls[m.user_id] = mine
        together = sum(1 for xs in self.pulls.values() if any(t - x < 1.0 for x in xs))
        b["hp"] -= 1 + 0.5 * (together - 1)          # more people pulling at once = stronger
        if b["hp"] <= 0:
            helpers = [uid for uid, xs in self.pulls.items() if xs]
            for uid in helpers:
                self.scores[uid] = self.scores.get(uid, 0) + 10
            out.all("bossdown", fish=b["fish"], helpers=helpers, scores=self.scores, reward="leviathan")
            self.boss = None
            self.pulls = {}
        elif t - self.last_boss_push > 0.15:
            self.last_boss_push = t
            out.all("bosshp", boss=self._boss_view(), pulling=together)

    def drop(self, user_id: str) -> None:
        self.casts.pop(user_id, None)
        self.pulls.pop(user_id, None)


# -------------------------------------------------------------------- race --
def mark(guess: str, word: str) -> list[str]:
    res = ["miss"] * 5
    left: list[str | None] = list(word)
    for i in range(5):
        if guess[i] == word[i]:
            res[i] = "hit"
            left[i] = None
    for i in range(5):
        if res[i] != "hit" and guess[i] in left:
            res[i] = "near"
            left[left.index(guess[i])] = None
    return res


class Race:
    def __init__(self) -> None:
        self.round = 0
        self.word: str | None = None
        self.guesses: dict[str, int] = {}
        self.until = 0.0
        self.wins: dict[str, int] = {}

    def running(self) -> bool:
        return self.word is not None and now() < self.until

    def start(self, m: Member, out: Out, rng: random.Random) -> None:
        if self.running():
            out.err(m.ws, "a race is already running")
            return
        self.round += 1
        self.word = rng.choice(RACE_WORDS)
        self.guesses = {}
        self.until = now() + RACE_SECS
        out.all("start", round=self.round, by=m.public(), secs=RACE_SECS)

    def guess(self, m: Member, msg: dict, out: Out) -> None:
        if not self.running() or msg.get("round") != self.round:
            if self.word and not self.running():
                out.all("timeout", round=self.round, word=self.word)
                self.word = None
            out.err(m.ws, "no race running")
            return
        g = msg.get("word")
        if not isinstance(g, str) or not re.fullmatch(r"[a-z]{5}", g):
            out.err(m.ws, "five letters, a-z")
            return
        n = self.guesses.get(m.user_id, 0)
        if n >= RACE_GUESSES:
            out.err(m.ws, "out of guesses")
            return
        self.guesses[m.user_id] = n + 1
        marks = mark(g, self.word)
        out.to(m.ws, "mark", round=self.round, word=g, marks=marks, n=n + 1)
        out.all("progress", round=self.round, user=m.public(), n=n + 1,
                hits=marks.count("hit"))     # how close, never which letters
        if g == self.word:
            self.wins[m.user_id] = self.wins.get(m.user_id, 0) + 1
            out.all("win", round=self.round, user=m.public(), word=self.word, n=n + 1, wins=self.wins)
            self.word = None


# -------------------------------------------------------------------- duel --
def _team(raw: Any) -> list[dict] | None:
    if not isinstance(raw, list) or not 1 <= len(raw) <= 6:
        return None
    team = []
    for c in raw:
        if not isinstance(c, dict):
            return None
        stage = max(0, min(4, int(c.get("stage", 0)) if isinstance(c.get("stage"), int) else 0))
        typ = c.get("type") if c.get("type") in DUEL_TYPES else "Normal"
        hp = 30 + stage * 12          # stats are derived here, never taken from the client
        team.append({"name": _clip(c.get("name"), 24) or "Creature", "type": typ,
                     "hp": hp, "max": hp, "atk": 8 + stage * 3})
    return team


class Duel:
    def __init__(self) -> None:
        self.pending: dict[str, dict] = {}     # challenged user_id -> {from, team}
        self.match: dict | None = None

    def view(self) -> dict | None:
        mt = self.match
        if not mt:
            return None
        return {"a": mt["a"], "b": mt["b"], "teams": mt["teams"], "turn": mt["turn"], "log": mt["log"][-6:]}

    def challenge(self, m: Member, msg: dict, out: Out, lobby: Lobby) -> None:
        if self.match:
            out.err(m.ws, "a duel is already on")
            return
        to = msg.get("to")
        team = _team(msg.get("team"))
        if to not in lobby.members or to == m.user_id:
            out.err(m.ws, "they need to be in the duel lobby")
            return
        if team is None:
            out.err(m.ws, "bring a team of 1 to 6 creatures")
            return
        self.pending[to] = {"from": m.user_id, "team": team}
        out.user(to, "challenge", **{"from": m.public()})
        out.to(m.ws, "challenged", to=lobby.members[to])

    def accept(self, m: Member, msg: dict, out: Out, lobby: Lobby, rng: random.Random) -> None:
        p = self.pending.pop(m.user_id, None)
        team = _team(msg.get("team"))
        if not p or p["from"] not in lobby.members:
            out.err(m.ws, "that challenge is gone")
            return
        if team is None:
            out.err(m.ws, "bring a team of 1 to 6 creatures")
            return
        a, b = p["from"], m.user_id
        self.match = {"a": lobby.members[a], "b": lobby.members[b], "ids": [a, b],
                      "teams": {a: p["team"], b: team}, "turn": a if rng.random() < 0.5 else b,
                      "log": ["The duel begins!"]}
        out.all("duel", duel=self.view())

    def move(self, m: Member, msg: dict, out: Out, rng: random.Random) -> None:
        mt = self.match
        if not mt or m.user_id not in mt["ids"]:
            out.err(m.ws, "you are not in this duel")
            return
        if mt["turn"] != m.user_id:
            out.err(m.ws, "not your turn")
            return
        foe = mt["ids"][1] if m.user_id == mt["ids"][0] else mt["ids"][0]
        mine, theirs = mt["teams"][m.user_id], mt["teams"][foe]
        i = msg.get("idx")
        if not isinstance(i, int) or not 0 <= i < len(mine) or mine[i]["hp"] <= 0:
            out.err(m.ws, "pick a creature that can still fight")
            return
        target = next(c for c in theirs if c["hp"] > 0)
        att = mine[i]
        mult = eff(att["type"], target["type"])
        dmg = max(1, round(att["atk"] * mult * rng.uniform(0.85, 1.15))) if mult else 0
        target["hp"] = max(0, target["hp"] - dmg)
        tag = " Super effective!" if mult >= 2 else " No effect." if mult == 0 else " Not very effective." if mult < 1 else ""
        mt["log"].append(f"{att['name']} hits {target['name']} for {dmg}.{tag}")
        if all(c["hp"] <= 0 for c in theirs):
            winner = mt["a"] if m.user_id == mt["ids"][0] else mt["b"]
            out.all("duelend", duel=self.view(), winner=winner)
            self.match = None
            return
        mt["turn"] = foe
        out.all("duel", duel=self.view())

    def drop(self, user_id: str, out: Out) -> None:
        self.pending.pop(user_id, None)
        mt = self.match
        if mt and user_id in mt["ids"]:
            other = mt["b"] if user_id == mt["ids"][0] else mt["a"]
            out.all("duelend", duel=self.view(), winner=other, forfeit=True)
            self.match = None


# ------------------------------------------------------------------- mines --
class Mines:
    def __init__(self) -> None:
        self.run: dict | None = None

    def _floor(self, depth: int, rng: random.Random) -> dict:
        grid = [["rock" if rng.random() < 0.42 else "floor" for _ in range(MINE_COLS)] for _ in range(MINE_ROWS)]
        for x, y in ((0, 0), (1, 0), (0, 1), (MINE_COLS - 1, 0), (MINE_COLS - 2, 0)):
            grid[y][x] = "floor"
        rocks = [(x, y) for y in range(MINE_ROWS) for x in range(MINE_COLS) if grid[y][x] == "rock"]
        ladder = rng.choice(rocks) if rocks else (MINE_COLS - 1, MINE_ROWS - 1)
        slimes = []
        for _ in range(min(1 + depth // 2, 6)):
            sx, sy = rng.randrange(2, MINE_COLS - 2), rng.randrange(2, MINE_ROWS)
            grid[sy][sx] = "floor"
            slimes.append([sx, sy])
        return {"grid": grid, "ladder": list(ladder), "slimes": slimes}

    def view(self) -> dict | None:
        r = self.run
        if not r:
            return None
        grid = [row[:] for row in r["floor"]["grid"]]   # the ladder stays hidden until uncovered
        return {"depth": r["depth"], "grid": grid, "slimes": r["floor"]["slimes"],
                "players": {uid: {k: p[k] for k in ("x", "y", "hp", "name", "out")} for uid, p in r["players"].items()},
                "loot": {uid: p["loot"] for uid, p in r["players"].items()}}

    def start(self, m: Member, out: Out, lobby: Lobby, rng: random.Random) -> None:
        if self.run:
            out.err(m.ws, "a run is already underway")
            return
        spawns = [(0, 0), (MINE_COLS - 1, 0), (1, 0), (MINE_COLS - 2, 0), (0, 1), (1, 1), (MINE_COLS - 1, 1), (MINE_COLS - 2, 1)]
        players = {}
        for i, (uid, p) in enumerate(lobby.members.items()):
            x, y = spawns[i % len(spawns)]
            players[uid] = {"x": x, "y": y, "hp": 5, "loot": {}, "out": False, "name": p.get("displayName") or p.get("handle")}
        self.run = {"depth": 1, "floor": self._floor(1, rng), "players": players, "moves": 0}
        out.all("mines", run=self.view(), by=m.public())

    def _loot(self, depth: int, rng: random.Random) -> str | None:
        x = rng.random()
        if x < 0.45:
            return None
        for need, cut, item in ((8, .985, "ruby"), (6, .97, "emerald"), (4, .95, "amethyst"), (0, .9, "quartz"),
                                (5, .8, "gold"), (2, .65, "iron")):
            if depth >= need and x > cut:
                return item
        return "copper"

    def move(self, m: Member, msg: dict, out: Out, rng: random.Random) -> None:
        r = self.run
        p = r and r["players"].get(m.user_id)
        if not p or p["out"] or p["hp"] <= 0:
            out.err(m.ws, "you are not in this run")
            return
        dx, dy = msg.get("dx"), msg.get("dy")
        if (dx, dy) not in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            out.err(m.ws, "move one tile")
            return
        f = r["floor"]
        nx, ny = p["x"] + dx, p["y"] + dy
        if not (0 <= nx < MINE_COLS and 0 <= ny < MINE_ROWS):
            return
        cell = f["grid"][ny][nx]
        if cell == "rock":
            f["grid"][ny][nx] = "floor"
            if [nx, ny] == f["ladder"]:
                f["grid"][ny][nx] = "ladder"
            else:
                item = self._loot(r["depth"], rng)
                if item:
                    p["loot"][item] = p["loot"].get(item, 0) + 1
        elif cell == "ladder" and r["depth"] < MINE_MAX_DEPTH:
            r["depth"] += 1
            r["floor"] = self._floor(r["depth"], rng)
            for q in r["players"].values():
                if not q["out"] and q["hp"] > 0:
                    q["x"], q["y"] = 0, 0
            out.all("mines", run=self.view(), note=f"{p['name']} found the way down: floor {r['depth']}")
            return
        else:
            p["x"], p["y"] = nx, ny
        r["moves"] += 1
        active = [q for q in r["players"].values() if not q["out"] and q["hp"] > 0]
        for s in f["slimes"]:
            if rng.random() < 0.5 and active:
                tgt = min(active, key=lambda q: abs(q["x"] - s[0]) + abs(q["y"] - s[1]))
                sx = s[0] + (1 if tgt["x"] > s[0] else -1 if tgt["x"] < s[0] else 0)
                sy = s[1] if sx != s[0] else s[1] + (1 if tgt["y"] > s[1] else -1 if tgt["y"] < s[1] else 0)
                if 0 <= sx < MINE_COLS and 0 <= sy < MINE_ROWS and f["grid"][sy][sx] == "floor":
                    s[0], s[1] = sx, sy
            for q in active:
                if [q["x"], q["y"]] == s:
                    q["hp"] -= 1
                    s[0] = min(MINE_COLS - 1, s[0] + 1)
        out.all("mines", run=self.view())
        for uid, q in r["players"].items():
            if q["hp"] <= 0 and not q["out"]:
                q["out"] = True
                half = {k: v // 2 for k, v in q["loot"].items() if v // 2}
                out.user(uid, "loot", items=half, fainted=True)
        self._maybe_end(out)

    def leave(self, m: Member, out: Out) -> None:
        r = self.run
        p = r and r["players"].get(m.user_id)
        if not p or p["out"]:
            return
        p["out"] = True
        out.to(m.ws, "loot", items=p["loot"], fainted=False)
        out.all("mines", run=self.view(), note=f"{p['name']} climbed out")
        self._maybe_end(out)

    def _maybe_end(self, out: Out) -> None:
        if self.run and all(q["out"] for q in self.run["players"].values()):
            out.all("minesend", depth=self.run["depth"])
            self.run = None

    def drop(self, user_id: str, out: Out) -> None:
        r = self.run
        if r and user_id in r["players"]:
            r["players"][user_id]["out"] = True
            self._maybe_end(out)


# -------------------------------------------------------------------- farm --
def _today() -> date:
    return datetime.fromtimestamp(wall(), UTC).date()


async def _farm_load(db, room_id: str) -> RoomFarm:
    row = await db.get(RoomFarm, room_id)
    if row is None:
        row = RoomFarm(room_id=room_id, data={"plots": [None] * FARM_PLOTS, "seeds": {}, "seedDay": "", "gardeners": []})
        db.add(row)
    data = dict(row.data or {})
    plots = list(data.get("plots") or [])[:FARM_PLOTS]
    data["plots"] = plots + [None] * (FARM_PLOTS - len(plots))
    data.setdefault("seeds", {})
    data.setdefault("seedDay", "")
    data.setdefault("gardeners", [])
    row.data = data
    return row


async def _water(db, gardeners: list[str], since: date) -> int:
    """Prompts the room's gardeners published since the plot was planted."""
    if not gardeners:
        return 0
    q = select(func.coalesce(func.sum(DailyStat.prompts), 0)).where(
        DailyStat.user_id.in_(gardeners), DailyStat.stat_date >= since)
    return int((await db.execute(q)).scalar() or 0)


async def _farm_view(db, data: dict) -> dict:
    plots = []
    gardeners = data.get("gardeners", [])
    for p in data["plots"]:
        if not p:
            plots.append(None)
            continue
        hours, need, _ = CROPS[p["crop"]]
        need *= max(1, len(gardeners))
        water = await _water(db, gardeners, date.fromisoformat(p["day"]))
        grown = (wall() - p["at"]) / 3600 >= hours
        plots.append({"crop": p["crop"], "by": p.get("by", ""), "water": min(water, need), "need": need,
                      "hoursLeft": max(0.0, round(hours - (wall() - p["at"]) / 3600, 1)),
                      "ripe": grown and water >= need})
    return {"plots": plots, "seeds": data["seeds"], "seedBoxOpen": data["seedDay"] != _today().isoformat(),
            "gardeners": len(gardeners), "season": season_of(_today())}


async def farm_op(room_id: str, m: Member, msg: dict, out: Out, rng: random.Random) -> None:
    op = msg.get("op")
    async with SessionLocal() as db:
        row = await _farm_load(db, room_id)
        data = dict(row.data)
        if m.user_id not in data["gardeners"]:
            data["gardeners"] = data["gardeners"] + [m.user_id]
        if op == "seeds":
            today = _today().isoformat()
            if data["seedDay"] == today:
                out.err(m.ws, "the seed box is empty until tomorrow")
            else:
                crops = [c for c, v in CROPS.items() if v[2] == season_of(_today())]
                seeds = dict(data["seeds"])
                for _ in range(FARM_SEEDS_PER_DAY):
                    c = rng.choice(crops)
                    seeds[c] = seeds.get(c, 0) + 1
                data["seeds"], data["seedDay"] = seeds, today
                out.all("note", text=f"{m.display_name} opened the seed box")
        elif op == "plant":
            i, crop = msg.get("plot"), msg.get("crop")
            if not isinstance(i, int) or not 0 <= i < FARM_PLOTS or data["plots"][i] or crop not in CROPS:
                out.err(m.ws, "can't plant there")
            elif data["seeds"].get(crop, 0) < 1:
                out.err(m.ws, "no seeds of that kind")
            else:
                seeds = dict(data["seeds"])
                seeds[crop] -= 1
                if not seeds[crop]:
                    del seeds[crop]
                plots = list(data["plots"])
                plots[i] = {"crop": crop, "at": wall(), "day": _today().isoformat(), "by": m.display_name}
                data["seeds"], data["plots"] = seeds, plots
        elif op == "harvest":
            i = msg.get("plot")
            view = await _farm_view(db, data)
            if not isinstance(i, int) or not 0 <= i < FARM_PLOTS or not view["plots"][i] or not view["plots"][i]["ripe"]:
                out.err(m.ws, "not ripe yet")
            else:
                crop = data["plots"][i]["crop"]
                plots = list(data["plots"])
                plots[i] = None
                data["plots"] = plots
                out.to(m.ws, "harvest", crop=crop, n=2)
                out.all("note", text=f"{m.display_name} harvested the {crop}")
        row.data = data
        await db.commit()
        out.all("farm", farm=await _farm_view(db, data))


# --------------------------------------------------------------- dispatch --
async def handle(room: Room, member: Member, msg: dict) -> None:
    g, op = msg.get("g"), msg.get("op")
    out = Out(g if isinstance(g, str) else "?")
    if g not in GAMES or not isinstance(op, str):
        out.err(member.ws, "unknown game")
        await _flush(room, out)
        return
    v = valley_for(room.room_id)
    lobby = v.lobbies[g]
    rng = random.Random(secrets.randbits(64))

    if op == "join":
        if member.user_id not in lobby.members and len(lobby.members) >= MAX_LOBBY:
            out.err(member.ws, "this game's lobby is full")
        else:
            fresh = member.user_id not in lobby.members
            lobby.members[member.user_id] = member.public()
            if lobby.host is None or lobby.host not in lobby.members:
                lobby.host = member.user_id
            out.all("lobby", members=lobby.roster(), joined=member.public() if fresh else None, name=GAME_NAMES[g])
            if g == "pond":
                out.to(member.ws, "pond", pond=v.pond.snapshot())
            elif g == "race" and v.race.running():
                out.to(member.ws, "start", round=v.race.round, secs=max(0, round(v.race.until - now())))
            elif g == "duel":
                out.to(member.ws, "duel", duel=v.duel.view())
            elif g == "mines":
                out.to(member.ws, "mines", run=v.mines.view())
            elif g == "farm":
                await farm_op(room.room_id, member, {"op": "view"}, out, rng)
            elif g == "golf":
                out.to(member.ws, "golf", round=v.golf.view(now()))
    elif op == "leave":
        _leave_lobby(v, g, member.user_id, out)
    elif op == "invite":
        to = msg.get("to")
        if member.user_id not in lobby.members:
            out.err(member.ws, "join the lobby first")
        elif not isinstance(to, str) or not to or to == member.user_id:
            out.err(member.ws, "invite someone else")
        else:
            delivered = await manager.deliver_to_user(to, {"type": "game", "g": g, "ev": "invite",
                                                         "from": member.public(), "room": room.room_id,
                                                         "name": GAME_NAMES[g]})
            out.to(member.ws, "invited", to=to, delivered=delivered)
    elif member.user_id not in lobby.members:
        out.err(member.ws, "join the lobby first")
    elif g == "pond":
        if op == "cast":
            v.pond.cast(member, out, rng)
        elif op == "land":
            v.pond.land(member, msg, out)
            v.pond.maybe_boss(lobby, out)
        elif op == "lose":
            v.pond.lose(member, msg, out)
        elif op == "pull":
            v.pond.pull(member, out)
    elif g == "race":
        if op == "start":
            v.race.start(member, out, rng)
        elif op == "guess":
            v.race.guess(member, msg, out)
    elif g == "duel":
        if op == "challenge":
            v.duel.challenge(member, msg, out, lobby)
        elif op == "accept":
            v.duel.accept(member, msg, out, lobby, rng)
        elif op == "move":
            v.duel.move(member, msg, out, rng)
        elif op == "forfeit":
            v.duel.drop(member.user_id, out)
    elif g == "mines":
        if op == "start":
            v.mines.start(member, out, lobby, rng)
        elif op == "move":
            v.mines.move(member, msg, out, rng)
        elif op == "exit":
            v.mines.leave(member, out)
    elif g == "farm":
        await farm_op(room.room_id, member, msg, out, rng)
    elif g == "golf":
        golf_op(v.golf, lobby, member, op, msg, out)
    await _flush(room, out)


# -------------------------------------------------------------------- golf --
def golf_op(gm: "golfmod.Golf", lobby: Lobby, member: Member, op: str, msg: dict, out: Out) -> None:
    """Mini Golf: every event goes to this game's lobby only."""
    t = now()
    uid = member.user_id
    ids = list(lobby.members)
    if op == "view":
        out.to(member.ws, "golf", round=gm.view(t))
    elif op == "pos":
        rel = gm.pos(uid, msg, t)
        if rel is not None:
            out.lobby(ids, "pos", skip_user=uid, **rel)
    elif op == "char":
        c = gm.char(uid, msg)
        if c is None:
            out.err(member.ws, "pick a character")
        else:
            out.lobby(ids, "char", user=uid, c=c)
    elif op == "shot":
        ev, err = gm.shot(uid, msg, t)
        if err:
            out.err(member.ws, err)
            return
        out.lobby(ids, "shot", **ev)
        _golf_advance(gm, ids, out, t, ev["ticks"])
    elif op == "concede":
        if not gm.pick_up([uid]):
            out.err(member.ws, "nothing to pick up")
            return
        out.lobby(ids, "golf", round=gm.view(t))
        _golf_advance(gm, ids, out, t)
    elif op in ("start", "skip", "end"):
        if lobby.host != uid:
            out.err(member.ws, "only the host can do that")
        elif op == "start":
            err = gm.start(lobby.members, msg.get("course"), t)
            if err:
                out.err(member.ws, err)
            else:
                out.lobby(ids, "golf", round=gm.view(t), by=member.public())
        elif op == "skip":
            gm.pick_up(list(gm.players))
            out.lobby(ids, "golf", round=gm.view(t))
            _golf_advance(gm, ids, out, t)
        else:
            gm.end()
            out.lobby(ids, "golf", round=gm.view(t))


def _golf_advance(gm: "golfmod.Golf", ids: list[str], out: Out, t: float, ticks: int = 0) -> None:
    step = gm.advance(t, ticks)
    if step is not None:
        out.lobby(ids, step[0], **step[1])
        out.lobby(ids, "golf", round=gm.view(t))


def _leave_lobby(v: RoomValley, g: str, user_id: str, out: Out) -> None:
    lobby = v.lobbies[g]
    who = lobby.members.pop(user_id, None)
    if who is None:
        return
    if lobby.host == user_id:
        lobby.host = next(iter(lobby.members), None)
    if g == "pond":
        v.pond.drop(user_id)
    elif g == "duel":
        v.duel.drop(user_id, out)
    elif g == "mines":
        v.mines.drop(user_id, out)
    elif g == "golf" and v.golf.drop(user_id):
        ids = list(lobby.members)
        out.lobby(ids, "golf", round=v.golf.view(now()), left=user_id)
        _golf_advance(v.golf, ids, out, now())
    out.all("lobby", members=lobby.roster(), left=who, name=GAME_NAMES[g])


async def on_disconnect(room_id: str, member: Member) -> None:
    """A socket went away: if that was the user's last socket in the room, leave every lobby."""
    v = _rooms.get(room_id)
    room = manager.get(room_id)
    if v is None:
        return
    if room is not None and any(m.user_id == member.user_id and ws is not member.ws
                                for ws, m in room.members.items()):
        return                       # the same person is still here on another socket
    for g in GAMES:
        out = Out(g)
        _leave_lobby(v, g, member.user_id, out)
        if room is not None:
            await _flush(room, out)
    if room is None or all(ws is member.ws for ws in room.members):
        _rooms.pop(room_id, None)


async def _flush(room: Room, out: Out) -> None:
    for kind, target, payload in out.items:
        if kind == "all":
            await room.broadcast(payload)
        elif kind == "ws":
            try:
                await target.send_json(payload)
            except Exception:
                pass
        elif kind == "lobby":
            ids, skip = target
            for ws, mem in list(room.members.items()):
                if mem.user_id in ids and mem.user_id != skip:
                    try:
                        await ws.send_json(payload)
                    except Exception:
                        pass
        else:
            for ws, mem in list(room.members.items()):
                if mem.user_id == target:
                    try:
                        await ws.send_json(payload)
                    except Exception:
                        pass
