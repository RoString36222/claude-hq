#!/usr/bin/env python3
"""Regenerate backend/tests/golf_golden.json: ~200 shots over every hole, rolled by the
reference simulation in backend/app/golf.py. tests/test_golf_sync.py replays them with
the JS copy in games/golf.js and requires identical results; backend tests replay them
with Python. Regenerate only when the physics or a course changes on purpose."""
import json
import os
import random
import sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(HERE, "backend"))
from app import golf  # noqa: E402

OUT = os.path.join(HERE, "backend", "tests", "golf_golden.json")


def main():
    rng = random.Random(20261006)
    vecs = []
    for cid, course in golf.COURSES.items():
        for hi, h in enumerate(golf.course_holes(cid)):
            ball = list(h["tee"])
            for k in range(14):
                if k % 5 == 0:
                    ball = list(h["tee"])
                ax, az = rng.randint(-4096, 4096), rng.randint(-4096, 4096)
                if k % 3 == 0:          # roughly toward the cup: more wall play and holes
                    ax, az = (h["cup"][0] - ball[0]) // 8 + rng.randint(-600, 600), (h["cup"][1] - ball[1]) // 8 + rng.randint(-600, 600)
                    ax, az = max(-4096, min(4096, ax)), max(-4096, min(4096, az))
                if ax == 0 and az == 0:
                    ax = 1
                power = rng.randint(1, 100)
                clk = rng.randint(0, golf.CLOCK - 1)       # moving obstacles: any phase of the shot clock
                r = golf.simulate(h, ball[0], ball[1], ax, az, power, clk)
                vecs.append({"course": cid, "hole": hi, "from": ball, "ax": ax, "az": az, "power": power, "clk": clk,
                             "end": r["end"], "holed": r["holed"], "oob": r["oob"], "water": r["water"],
                             "ticks": r["ticks"]})
                if not r["holed"]:
                    ball = list(r["end"])
    with open(OUT, "w", encoding="utf-8") as f:
        f.write("[\n" + ",\n".join(json.dumps(v, separators=(",", ":")) for v in vecs) + "\n]\n")
    print(len(vecs), "vectors;", sum(v["holed"] for v in vecs), "holed;", sum(v["oob"] for v in vecs), "oob;",
          sum(v["water"] for v in vecs), "water")


if __name__ == "__main__":
    main()
