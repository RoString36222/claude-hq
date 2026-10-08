"""Code Typing Race (g = "type", HQ 2.1): up to 8 people race to type the same real
code snippet. The server picks the snippet, runs the countdown and judges progress:
a position can only move forward, never past the snippet, and never faster than
MAX_CPS characters a second (a burst of BURST is allowed). Finishing time, words
per minute and accuracy make the result; results feed leaderboards and game XP."""
import random
from typing import Any

HZ = 5
COUNTDOWN = 3.0
MAX_SECS = 180.0
MAX_CPS = 25.0            # 300 WPM: faster than anyone types
BURST = 12
FINISH_GRACE = 20.0       # after the first finisher, the rest have this long

SNIPPETS = [
    ("python", "def fib(n):\n    a, b = 0, 1\n    for _ in range(n):\n        a, b = b, a + b\n    return a"),
    ("python", "with open(path, encoding=\"utf-8\") as f:\n    rows = [line.split(\",\") for line in f if line.strip()]"),
    ("python", "counts = {}\nfor word in text.split():\n    counts[word] = counts.get(word, 0) + 1"),
    ("javascript", "const debounce = (fn, ms) => {\n  let t;\n  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };\n};"),
    ("javascript", "fetch(\"/api/sessions\").then(r => r.json()).then(d => console.log(d.sessions.length));"),
    ("javascript", "const sum = xs => xs.reduce((a, b) => a + b, 0);\nconsole.log(sum([3, 4, 5]));"),
    ("rust", "fn main() {\n    let v: Vec<i32> = (1..=10).filter(|x| x % 2 == 0).collect();\n    println!(\"{:?}\", v);\n}"),
    ("rust", "impl Point {\n    fn dist(&self, o: &Point) -> f64 {\n        ((self.x - o.x).powi(2) + (self.y - o.y).powi(2)).sqrt()\n    }\n}"),
    ("sql", "SELECT city, count(*) AS rides\nFROM rides\nWHERE status = 'completed'\nGROUP BY city\nORDER BY rides DESC;"),
    ("sql", "UPDATE users SET last_seen = now() WHERE id = $1 RETURNING id, last_seen;"),
    ("shell", "git log --oneline -n 20 | grep -i fix | wc -l"),
    ("shell", "find . -name \"*.py\" -not -path \"./.venv/*\" | xargs wc -l | sort -n | tail -5"),
]


def _int(v: Any, lo: int, hi: int) -> int | None:
    if isinstance(v, bool) or not isinstance(v, (int, float)) or v != int(v):
        return None
    v = int(v)
    return v if lo <= v <= hi else None


class TypeRace:
    def __init__(self) -> None:
        self.phase = "idle"          # idle | countdown | run | done
        self.lang = ""
        self.text = ""
        self.go_at = 0.0
        self.first_at: float | None = None
        self.players: dict[str, dict] = {}
        self.results: list[dict] | None = None
        self.dirty = False

    def running(self) -> bool:
        return self.phase in ("countdown", "run")

    def view(self, t: float) -> dict:
        return {"phase": self.phase, "lang": self.lang, "text": self.text if self.phase != "idle" else "",
                "goInMs": max(0, int((self.go_at - t) * 1000)) if self.phase == "countdown" else 0,
                "players": [{"user": p["user"], "pos": p["pos"], "fin": p["fin"]} for p in self.players.values()],
                "results": self.results}

    def start(self, members: dict[str, dict], t: float, rng: random.Random) -> str | None:
        if self.running():
            return "a race is already on"
        if not members:
            return "join the lobby first"
        self.lang, self.text = rng.choice(SNIPPETS)
        self.phase, self.go_at, self.first_at, self.results = "countdown", t + COUNTDOWN, None, None
        self.players = {uid: {"user": pub, "pos": 0, "err": 0, "fin": None, "at": t + COUNTDOWN, "budget": float(BURST)}
                        for uid, pub in list(members.items())[:8]}
        self.dirty = True
        return None

    def prog(self, uid: str, msg: dict, t: float) -> bool:
        p = self.players.get(uid)
        if p is None or self.phase != "run" or p["fin"] is not None:
            return False
        pos, err = _int(msg.get("pos"), 0, len(self.text)), _int(msg.get("err"), 0, 100000)
        if pos is None or err is None or pos < p["pos"]:
            return False
        p["budget"] = min(float(BURST), p["budget"] + (t - p["at"]) * MAX_CPS)
        p["at"] = t
        step = pos - p["pos"]
        if step > p["budget"]:
            return False                         # faster than anyone types: ignored
        p["budget"] -= step
        p["pos"], p["err"] = pos, max(p["err"], err)
        if pos == len(self.text):
            p["fin"] = int((t - self.go_at) * 1000)
            if self.first_at is None:
                self.first_at = t
        self.dirty = True
        return True

    def drop(self, uid: str) -> bool:
        return self.players.pop(uid, None) is not None

    def end(self) -> None:
        self.phase, self.players, self.results = "idle", {}, None

    def tick(self, t: float) -> list[tuple[str, dict]]:
        evs: list[tuple[str, dict]] = []
        if self.phase == "countdown" and t >= self.go_at:
            self.phase = "run"
            evs.append(("go", {}))
        if self.phase == "run":
            everyone = self.players and all(p["fin"] is not None for p in self.players.values())
            late = self.first_at is not None and t - self.first_at >= FINISH_GRACE
            if everyone or late or t - self.go_at >= MAX_SECS or not self.players:
                self.phase = "done"
                n = len(self.text)
                order = sorted(self.players.items(), key=lambda kv: (kv[1]["fin"] is None, kv[1]["fin"] or 0, -kv[1]["pos"]))
                self.results = []
                for i, (uid, p) in enumerate(order):
                    ms = p["fin"]
                    wpm = round((n / 5) / (ms / 60000), 1) if ms else round((p["pos"] / 5) / max(1e-6, (t - self.go_at) / 60), 1)
                    self.results.append({"user": p["user"], "place": i + 1, "ms": ms, "dnf": ms is None, "pos": p["pos"],
                                         "wpm": wpm, "acc": round(100 * n / (n + p["err"]), 1) if n else 100.0})
                evs.append(("done", {"results": self.results, "lang": self.lang}))
                return evs
        if self.dirty:
            self.dirty = False
            evs.append(("prog", {"ps": [{"u": uid, "pos": p["pos"], "fin": p["fin"]} for uid, p in self.players.items()]}))
        return evs
