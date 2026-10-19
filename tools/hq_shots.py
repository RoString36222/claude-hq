#!/usr/bin/env python3
"""Headless screenshots of the 3D City for review (spec gates C2-C4, C6).

    python3 tools/hq_shots.py [--out DIR] [--bin path/to/claudehq] [--only TEXT] [--settle SECS]

The same setup as tools/ui_smoke.py: a throwaway HQ root and HOME, a fake Arena
on a free port serving the world fixture, and headless Chrome (swiftshader,
DevTools pipe, never a visible window) with ONE shared profile for every shot,
so the IndexedDB world cache is reused. Each shot opens
`/?hqsmoke=1&hqperf=1&cam=<mode>&at=<x,z>[&yaw=<rad>][&night=1]...` at 1280x800, waits for
`data-hq-smoke`, lets the camera settle, saves a PNG, then waits (up to
--frame-wait s) for the shot's first `hq-frame` line:
  - every mode in map far chase near fp classic photo cine at your HQ door (the
    hqsmoke spawn), the plaza and the H1 hill, day and night;
  - map at spans 2048, 400 and 44;
  - car, moto, bike and skate (`&ride=`) in chase and fp on the H1 hill, the car
    also in fp-bonnet; records vehicle pitch/roll and asserts the pitch is not
    zero on the hill (car, moto, bike);
  - fp at your HQ door with the "E  Enter ..." prompt visible;
  - a night shot on H1 at a gantry; a chase shot with &calm=1.
Writes `index.html` (a contact sheet) next to the PNGs in docs/screenshots/3d-city/
(or --out) and prints the `hq-frame` log lines. Exit 1 when any shot failed.
"""
import argparse
import html
import importlib.util
import json
import os
import shutil
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
_spec = importlib.util.spec_from_file_location("hq_ui_smoke", os.path.join(HERE, "ui_smoke.py"))
smoke = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(smoke)

MODES = ["map", "far", "chase", "near", "fp", "classic", "photo", "cine"]
VEHICLES = ["car", "moto", "bike", "skate"]
PITCHED = ("car", "moto", "bike")   # the skateboard's pitch is recorded, not asserted


def shot_list(sp):
    """[(file stem, query dict, checks)] in contact-sheet order."""
    spots = [("door", sp["spawn"], {"yaw": sp["spawn_yaw"]}), ("plaza", sp["plaza"], {}), ("hill", sp["hill"], {"yaw": sp["hill_yaw"]})]
    out = []
    for mode in MODES:
        for spot, at, ex in spots:
            for night in (False, True):
                q = dict(ex, cam=mode, at=at)
                if night:
                    q["night"] = 1
                out.append(("%s-%s-%s" % (mode, spot, "night" if night else "day"), q, {}))
    for span in (2048, 400, 44):
        out.append(("map-span-%d" % span, {"cam": "map", "span": span}, {"labels": True}))
    for v in VEHICLES:
        for cam in ("chase", "fp") + (("fp-bonnet",) if v == "car" else ()):
            out.append(("ride-%s-%s-hill" % (v, cam), {"cam": cam, "at": sp["hill"], "yaw": sp["hill_yaw"], "ride": v},
                        {"pitch": v in PITCHED}))
    out.append(("fp-door-prompt", {"cam": "fp", "at": sp["spawn"], "yaw": sp["spawn_yaw"]}, {"prompt": True}))
    out.append(("night-gantry-h1", {"cam": "chase", "at": sp["gantry"], "yaw": sp["gantry_yaw"], "night": 1}, {}))
    out.append(("chase-calm", {"cam": "chase", "at": sp["plaza"], "calm": 1}, {}))
    return out


def url_for(base, q):
    q = dict(q)
    return smoke.smoke_url(base, q.pop("cam", None), q.pop("at", None), hqperf=1, **q)


def sheet(out_dir, rows):
    cells = []
    for r in rows:
        img = ('<img src="%s.png" alt="%s" loading="lazy">' % (html.escape(r["name"]), html.escape(r["name"]))
               if r["ok"] or os.path.exists(os.path.join(out_dir, r["name"] + ".png")) else "<div class=miss>no image</div>")
        cells.append('<figure class="%s">%s<figcaption><b>%s</b><br><code>%s</code><br>%s</figcaption></figure>' % (
            "ok" if r["ok"] else "bad", img, html.escape(r["name"]), html.escape(r["url"].split("?", 1)[1]),
            html.escape(r["note"])))
    page = """<!doctype html><meta charset="utf-8"><title>3D City shots</title>
<style>
:root{color-scheme:light dark;--bg:#111318;--fg:#e8eaf0;--mut:#9aa1ad;--bad:#e5534b;--line:#2a2e37}
@media (prefers-color-scheme: light){:root{--bg:#f6f7f9;--fg:#15171c;--mut:#5b6270;--line:#d9dce2}}
body{margin:0;padding:16px;background:var(--bg);color:var(--fg);font:13px/1.4 ui-sans-serif,system-ui,sans-serif}
main{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:12px}
figure{margin:0;border:1px solid var(--line);border-radius:8px;overflow:hidden}
figure.bad{border-color:var(--bad)}img{display:block;width:100%%;height:auto}
figcaption{padding:6px 8px;color:var(--mut)}figcaption b{color:var(--fg)}.miss{padding:40px;text-align:center}
</style>
<h1>3D City shots</h1><p>%d shots, %d failed. Generated %s by tools/hq_shots.py.</p>
<main>%s</main>
""" % (len(rows), sum(1 for r in rows if not r["ok"]), time.strftime("%Y-%m-%d %H:%M"), "\n".join(cells))
    with open(os.path.join(out_dir, "index.html"), "w") as f:
        f.write(page)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--out", default=os.path.join(ROOT, "docs", "screenshots", "3d-city"))
    ap.add_argument("--bin", default=os.path.join(ROOT, "dashboard-rs", "target", "release", "claudehq"))
    ap.add_argument("--only", default="", help="only shots whose name contains this")
    ap.add_argument("--settle", type=float, default=2.0, help="seconds to let the camera settle after ready")
    ap.add_argument("--frame-wait", type=float, default=10.0, help="seconds to wait for the first hq-frame log line")
    a = ap.parse_args()
    smoke.BIN = a.bin
    if not os.access(a.bin, os.X_OK):
        smoke.fail(f"no claudehq binary at {a.bin}")
    if not os.path.exists(smoke.FIXTURE):
        smoke.fail(f"{smoke.FIXTURE} missing")
    chrome = smoke.find_chrome()
    if not chrome:
        smoke.fail("no Chrome/Chromium found")
    os.makedirs(a.out, exist_ok=True)
    world = smoke.load_world()
    sp = smoke.spots(world)
    print("spots (m):", json.dumps(sp))
    tmp = tempfile.mkdtemp(prefix="hq-shots-")
    arena = smoke.FakeArena(world)
    root, home = smoke.make_root(tmp, arena.url)
    server, base, _ = smoke.start_server(tmp, root, home)
    rows, frames = [], []
    try:
        br = smoke.Chrome(chrome, os.path.join(tmp, "chrome"), size=(1280, 800))
        try:
            for name, q, checks in shot_list(sp):
                if a.only and a.only not in name:
                    continue
                url = url_for(base, q)
                row = {"name": name, "url": url, "ok": False, "note": ""}
                rows.append(row)
                pg = br.open(url)
                try:
                    v = pg.wait_smoke()
                    try:
                        s = smoke.parse_smoke(v)
                    except RuntimeError as e:
                        row["note"] = str(e)
                        continue
                    time.sleep(a.settle)
                    pg.screenshot(os.path.join(a.out, name + ".png"))
                    errs = pg.errors()
                    problems = ["JS error: " + errs[0]] if errs else []
                    veh = s.get("vehicle")
                    if checks.get("pitch") and not (veh and abs(veh.get("pitch") or 0) > 1e-4):
                        problems.append("vehicle pitch is zero on the hill (%r)" % (veh,))
                    if checks.get("labels"):
                        lb = s.get("labels") or {}
                        if not any((lb.get(k) or 0) > 0 for k in ("roads", "shields", "hqs", "peers")):
                            problems.append("no map labels (%r)" % (lb,))
                    if checks.get("prompt"):
                        p = pg.eval("(document.querySelector('.hqhud-prompt')||{}).textContent || ''") or ""
                        if not p.startswith("E"):
                            problems.append("no 'E  Enter ...' prompt (%r)" % p)
                    # hq3d logs hq-frame once per 5 s of frame time: wait for the first line
                    end = time.time() + a.frame_wait
                    while not pg.console("hq-frame") and time.time() < end:
                        time.sleep(0.25)
                    got = pg.console("hq-frame")
                    for ln in got:
                        frames.append(name + "  " + ln)
                    row["ok"] = not problems
                    row["note"] = "; ".join(problems) or "mode %s, %s draw calls, %s tris%s" % (
                        s.get("mode"), s.get("drawCalls"), s.get("triangles"),
                        ", pitch %.3f roll %.3f" % (veh.get("pitch") or 0, veh.get("roll") or 0) if veh else "")
                    if not got:
                        row["note"] += "; no hq-frame line"
                finally:
                    pg.close()
                    print(("ok  " if row["ok"] else "BAD ") + name + "  " + row["note"])
        finally:
            br.close()
    finally:
        smoke.stop_server(server)
        arena.close()
        shutil.rmtree(tmp, ignore_errors=True)
    sheet(a.out, rows)
    for ln in frames:
        print(ln)
    bad = [r for r in rows if not r["ok"]]
    print("%d shots, %d failed; contact sheet: %s" % (len(rows), len(bad), os.path.join(a.out, "index.html")))
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
