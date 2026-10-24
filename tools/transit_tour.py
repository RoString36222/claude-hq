#!/usr/bin/env python3
"""Transit screenshot tour (HQ 3.15, docs/plans/transport-revamp.md section 8).

    python3 tools/transit_tour.py [path/to/claudehq] [--out DIR] [--only N[,N...]|SUBSTR]

Starts the HQ server against a throwaway HQ folder and the fake Arena of tools/ui_smoke.py (serving the @3
fixtures, plus a fake peer's SMS thread), opens `/?hqsmoke=1&hqperf=1` in headless Chrome (never a visible
window, a free port, never 8765), and walks the 3.15 transport and phone features in the architect's order
through HQ3D_DEBUG.transit and the helpers in tools/transit_tour.js: each module's shot camera, boarding a tram,
a bus at rush hour, the metro above and below the street, the City Line, the Island Link, the gondola, the water,
the cabs, driver mode, the heli, and every phone app. Each shot saves NN-name.png and records the frame's draw
calls and triangles, page errors, and UI overlapping or off screen; five shots are repeated with Calm on
(NN-name-calm.png). Prints a table and writes tour.json beside the shots; exits non-zero on a page error, a shot
over budget (700 frame calls on the surface, 120 below the street, 1.5M triangles) or a phone that spills off
screen. Stdlib only.
"""
import json
import os
import shutil
import sys
import tempfile
import time
from http.server import BaseHTTPRequestHandler

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))
ARGS = [a for a in sys.argv[1:]]
OUT, ONLY, BIN = None, None, None
i = 0
while i < len(ARGS):
    a = ARGS[i]
    if a == "--out":
        OUT = ARGS[i + 1]; i += 2; continue
    if a == "--only":
        ONLY = ARGS[i + 1]; i += 2; continue
    if not a.startswith("--") and BIN is None:
        BIN = a
    i += 1
sys.argv = [sys.argv[0]] + ([BIN] if BIN else [])
import ui_smoke as U  # noqa: E402  (its server, fake Arena and Chrome driver)

MAX_FRAME = 700
MAX_UNDER = 120
MAX_TRI = 1_500_000
PEER = {"id": "tour-peer-1", "name": "Ada (tour)", "handle": "ada"}
ISLAND = "user:%s@3" % U.ISLAND_UID


def sms_arena(arena):
    """Give the fake Arena the Messages endpoints (/v1/sms/*): one waiting message from a fake peer."""
    base = arena.srv.RequestHandlerClass
    now_ms = int(time.time() * 1000)
    inbox = [{"id": "m1", "from": PEER, "text": "Meet at Central? The M1 is every 4 min.", "at": now_ms - 240000},
             {"id": "m2", "from": PEER, "text": "Tickets are free now, by the way.", "at": now_ms - 60000}]
    state = {"on": True, "sent": []}

    class H(base):
        def _sms_json(self, obj, code=200):
            return self.reply(code, json.dumps(obj).encode())

        def do_GET(self):
            path = self.path.split("?")[0]
            if path == "/v1/sms/me":
                return self._sms_json({"on": state["on"], "blocks": []})
            if path == "/v1/sms/inbox":
                return self._sms_json({"messages": inbox})
            if path == "/v1/sms/status":
                return self._sms_json({"delivered": [m for m in state["sent"]]})
            if path == "/v1/sms/directory":
                return self._sms_json({"users": [{"id": PEER["id"], "name": PEER["name"], "handle": PEER["handle"]}]})
            return base.do_GET(self)

        def do_POST(self):
            path = self.path.split("?")[0]
            n = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(n) or b"{}") if n else {}
            if path == "/v1/sms/send":
                mid = "s%d" % (len(state["sent"]) + 1)
                state["sent"].append(mid)
                return self._sms_json({"id": mid})
            if path == "/v1/sms/optin":
                state["on"] = bool(body.get("on"))
                return self._sms_json({"on": state["on"]})
            if path in ("/v1/sms/ack", "/v1/sms/block", "/v1/sms/report"):
                return self._sms_json({"ok": True})
            return self.reply(404, b'{"detail":"Not Found"}')

    arena.srv.RequestHandlerClass = H


# the City's overlays and the phone: on screen, and the phone over nothing it should not cover
UI_JS = r"""(function(){
  var vw = window.innerWidth, vh = window.innerHeight, out = {off: [], overlap: []};
  function r(el){ var b = el.getBoundingClientRect(); return {x: b.left, y: b.top, w: b.width, h: b.height, name: String(el.className || el.id)}; }
  var phone = document.querySelector(".hqphone-root .hqphone");
  var els = Array.prototype.slice.call(document.querySelectorAll(".hq3d-home, .hq3d-stats, .hqmm, .hqcity-menu, .hqphone-root .hqphone"))
    .filter(function(e){ return e.offsetParent !== null && !e.hidden; });
  els.forEach(function(e){ var b = r(e); if(b.w > 0 && (b.x < -1 || b.y < -1 || b.x + b.w > vw + 1 || b.y + b.h > vh + 1)) out.off.push(b); });
  if(phone){ var P = r(phone); out.phone = P;
    els.forEach(function(e){ if(e === phone || phone.contains(e) || e.contains(phone)) return; var b = r(e);
      if(b.w > 0 && b.x < P.x + P.w && b.x + b.w > P.x && b.y < P.y + P.h && b.y + b.h > P.y && /hq3d-home/.test(b.name)) out.overlap.push(b.name); }); }
  return JSON.stringify(out);
})()"""

S = "__tour."   # tools/transit_tour.js


def sh(mod, name):
    return S + "shot(%s, %s)" % (json.dumps(mod), json.dumps(name))


def ph(app, arg=None):
    return S + "phone(%s%s)" % (json.dumps(app), (", " + json.dumps(arg)) if arg is not None else "")


def click(rx):
    return S + "click(%s)" % json.dumps(rx)


# The tour, in the architect's order: (shot file, caption, [actions], options). An action is JS (a string) or a
# number (seconds to wait). Options: under (below the street), calm (repeat with Calm on), wait (before the shot).
TOUR = [
    ("01-max-level", "Every city is max level: all lines and buildings open",
     ["HQ3D_DEBUG.teleport(0, 10.5)", S + "clear()"], {}),
    ("02-tram-junction", "Grooved rails, diamond crossing and overhead wire at a junction (was: no track)", [sh("tramway", "tram-junction")], {}),
    ("03-tram-stop", "Boarding island with tactile edge, line totem and live departure board", [sh("tramway", "tram-stop")], {}),
    ("04-tram-seated", "Seated inside a 27 m tram: 2+1 bays, info screen, commuters",
     [S + "clear()", S + "ride('tram', 'tram:1', 0, 4, 0.35)", 3, S + "rideOn(0.35)", 1, "HQ3D_DEBUG.transit.seatCam('seat')"], {"calm": True}),
    ("05-bus-rush-hour", "Standing at a pole on a full bus; STOP lit after S",
     [S + "endRide()", S + "at(8, 30)", S + "ride('bus', HQ3D_DEBUG.transit.lines('bus')[0].id, 0, 5, 0.3, null)", 3, S + "rideOn(0.3)", 1,
      "HQ3D_DEBUG.transit.seatCam('seat')", S + "key('KeyS')"], {}),
    ("06-metro-entrance", "Street entrance with canopy, M totem and a real hole down the stairs", [S + "endRide()", sh("metro", "entrance")], {}),
    ("07a-metro-portal", "Cut-and-cover portal where M1 surfaces", [sh("metro", "portal")], {}),
    ("07b-metro-depot", "M1's open-air depot", [sh("metro", "depot")], {}),
    ("08-metro-hall", "Ticket hall: gate line, machines, map and departure board", [sh("metro", "hall")], {"under": True, "calm": True}),
    ("09-metro-platform", "Platform with screen doors as an M1 train arrives", [sh("metro", "platform")], {"under": True}),
    ("10a-metro-train-interior", "Riding M1: inside the car below the street",
     [S + "clear()", S + "ride('metro', HQ3D_DEBUG.transit.lines('metro')[0].id, 1, 2, 0.5)", 3, S + "rideOn(0.5)", 1, sh("metro", "train-interior")],
     {"under": True}),
    ("10b-metro-tunnel", "M1's lit tunnel between stations", [sh("metro", "tunnel-ride")], {"under": True}),
    ("10c-metro-portal-daylight", "Climbing into daylight at the portal", [S + "endRide()", sh("metro", "portal-daylight")], {}),
    ("11-central-interchange", "Central: M1 over M2 and the Island Link platforms", [S + "endRide()", sh("metro", "central-interchange")], {"under": True}),
    ("12a-cityline-viaduct", "Elevated City Line on its viaduct", [S + "clear()", sh("cityrail", "cityline-viaduct")], {}),
    ("12b-cityline-ride", "Riding the elevated City Line between its stations (this fixture's line has no airport stop)",
     [S + "clear()", S + "ride('rail', HQ3D_DEBUG.transit.lines('rail')[0].id, 0, 99, 0.75)", 3, S + "rideOn(0.75)", 1, "HQ3D_DEBUG.transit.seatCam('seat')"], {}),
    ("13a-island-link-portal", "Island Link: the coastal portal", [S + "endRide()", sh("link", "link-portal")], {}),
    ("13b-island-link-viaduct", "Island Link: the sea viaduct", [sh("link", "link-viaduct")], {}),
    ("13c-island-link-ride", "Island Link: the train mid-crossing on the sea viaduct, the Commons to Fixture Island",
     [S + "clear()", S + "linkRide(%s)" % json.dumps(ISLAND), 6, S + "linkCam()"], {}),
    ("14a-gondola-line", "Gondola line with towers up to the summit", ["RELOAD", sh("gondola", "gondola-line")], {}),
    ("14b-gondola-cabin", "Gondola cabin up to the summit viewing deck",
     [S + "clear()", sh("gondola", "gondola-cabin")], {"calm": True}),
    ("14c-gondola-summit", "The summit station and its viewing deck", [sh("gondola", "gondola-summit")], {}),
    ("15a-water-lake", "@3 water: park lake with its island", [S + "endRide()", S + "water('lake')"], {}),
    ("15b-water-canal", "@3 water: canal quays", [S + "water('canal')"], {}),
    ("15c-water-marina", "@3 water: marina with breakwater and lighthouse", [sh("ferries", "marina")], {}),
    ("16a-waterbus-pier", "Water bus W1 at its pier", [sh("ferries", "waterbus-pier")], {}),
    ("16b-waterbus-cabin", "Inside the water bus's panoramic cabin",
     [S + "clear()", S + "ride('ferry', HQ3D_DEBUG.transit.lines('ferry')[0].id, 0, 1, 0.5)", 3, S + "rideOn(0.5)", 1, "HQ3D_DEBUG.transit.seatCam('window')"], {}),
    ("17a-water-taxi", "Water taxi arriving", [S + "endRide()", S + "waterTaxi()", 3, S + "taxiCam()"], {}),
    ("17b-boat-hire", "Hire a pedalo on the lake", [S + "clear()", S + "hire('pedalo')", 3], {}),
    ("18-phone-home", "The phone: home grid, dock and badges", [S + "clear()", "HQ3D_DEBUG.teleport(0, 10.5)", ph(None)], {"calm": True}),
    ("19a-tickets-planner", "Journey planner: 3 options, free tickets",
     [ph("tickets"), 1, S + "select('^To$', 'Airport')", click("^Plan journey$"), 2], {}),
    ("19b-tickets-checkin", "Airport check-in and boarding pass", [ph("tickets", {"tab": "air"}), 1, S + "checkin()", 2], {}),
    ("20-departures-metro", "Live departures as text, filtered to Metro", [ph("departures"), 1, click("^Metro$"), 1, S + "openFirstStop()", 1], {}),
    ("21-transit-map", "Transit map with every line and live vehicle dots", [ph("map"), 2], {}),
    ("22a-cabs-classes", "Claude Cabs: Bike, Go, Cab, XL, Lux, Heli, Water taxi",
     [ph("claude-cabs"), 1, S + "type('#pc-cabs-q', 'Stadium')", 1, S + "clickIn('.pc-results', 'button')", click("^Cab"), 1], {}),
    ("22b-cab-arriving", "Your cab arriving at the kerb", [click("^Request$"), 2, S + "cabSkip('here')", 1, "HQ3D_DEBUG.transit.phoneClose()", S + "cabCam()"], {}),
    ("22c-cab-riding", "Riding in the back of a Claude Cab", [S + "cabBoard()", 5], {"calm": True}),
    ("23a-driver-mode", "Driver mode: an accepted NPC fare, routed to its pickup beacon (the light column)", [S + "cabEnd()", S + "driver()", 5], {}),
    ("23b-driver-score", "Score, stars and totals (no coins)", [ph("claude-cabs"), 1, click("^Drive$"), 1], {}),
    ("24a-vehicles-cars", "Call your vehicles with filters: Cars (this test profile owns none yet)", [S + "driverOff()", ph("vehicles"), 1, click("^Cars")], {}),
    ("24b-vehicles-helis", "Call your vehicles with filters: Helicopters", [click("^Helicopters"), 1], {}),
    ("25a-heli-landing", "Claude Cabs heli landing in an open area", ["HQ3D_DEBUG.transit.phoneClose()", S + "heli()", 4], {}),
    ("25b-heli-cabin", "In the heli cabin, flying to the farthest helipad", [S + "heliBoard()", 5], {}),
    ("26-dealership", "Calling the dealership; buy remotely, delivered to your carpark", ["RELOAD", ph("dealership"), 3], {}),
    ("27-messages", "SMS any player: thread, 160 counter, ticks, block/mute",
     [ph("messages"), 1, S + "openThread()", 1, S + "type('textarea, input[type=text]', 'On my way, taking the M1')"], {}),
    ("28-nearby", "Nearby chat: a line from a player 6 m away (bubbles show over avatars within 40 m)", [S + "nearby()", ph("nearby"), 2], {}),
    ("29-incoming-call", "Incoming call: accept / decline", [S + "ring()", ph("phone"), 1], {}),
    ("30a-camera-selfie", "Camera selfie mode", [S + "hangup()", ph("camera"), 1, click("^Selfie$"), 2], {}),
    ("30b-gallery", "The local-only gallery", [S + "shutter()", 2, ph("gallery"), 2], {}),
    ("31a-achievements", "Achievements", [ph("achievements"), 1], {}),
    ("31b-patch-notes", "The 3.18.0 patch notes", [ph("notes"), 1], {}),
    ("32-settings", "Opt-ins: SMS sending, Nearby, Calls; transit voice; clock; cab class", [ph("settings"), 1], {}),
    ("33a-budget-surface", "Draw calls within budget at the busiest surface camera (<= 700 a frame)",
     ["RELOAD", S + "busiest()", 3], {}),
    ("33b-budget-underground", "Draw calls within budget below the street (<= 120 a frame)", [sh("metro", "platform")], {"under": True}),
]


def main():
    out_dir = OUT or tempfile.mkdtemp(prefix="hq-transit-tour-")
    os.makedirs(out_dir, exist_ok=True)
    world = U.load_world()
    arena = U.FakeArena(world, worlds=U.load_worlds())
    sms_arena(arena)
    tmp = tempfile.mkdtemp(prefix="hq-tour-")
    root, home = U.make_root(tmp, arena.url)
    # paired with the fake Arena (a throwaway token in the throwaway HQ folder): the archipelago, so the Island Link runs
    with open(os.path.join(root, "arena-link.json"), "w") as f:
        json.dump({"token": "transit-tour", "url": arena.url}, f)
    server, base, _log = U.start_server(tmp, root, home)
    rows, bad = [], []
    helpers = open(os.path.join(ROOT, "tools", "transit_tour.js"), encoding="utf-8").read()
    only = None
    if ONLY:
        only = [x.strip() for x in ONLY.split(",") if x.strip()]
    try:
        chrome = U.find_chrome()
        if not chrome:
            U.fail("no Chrome/Chromium found")
        br = U.Chrome(chrome, os.path.join(tmp, "chrome"), size=(1600, 1000))
        P = {}

        def ev(e):
            return P["pg"].eval(e)

        def open_page():
            # a fresh page: the Island Link hands you to the sea crossing, which only a new page undoes
            if P.get("pg"):
                P["pg"].close()
            P["pg"] = br.open(U.smoke_url(base, "chase", (0.0, 10.5), hqperf=1))
            v = P["pg"].wait_smoke()
            if not v or not v.startswith("ok"):
                U.fail("the City did not come up: " + str(v)[:300])
            time.sleep(1.5)
            # the page's own first-run prompts (a paired page asks about work signals): "Not now", so they hide nothing
            ev("Array.prototype.slice.call(document.querySelectorAll('button')).filter(function(b){ return /^Not now$/.test(b.textContent.trim()) && b.offsetParent; }).forEach(function(b){ b.click(); }), 1")
            ev(helpers + ";1")
            ev(S + "hideLobby()")
            print("clear skies:", ev(S + "clearSkies()"))
            time.sleep(3)

        open_page()
        print(f"world {ev('HQ3D_DEBUG.world()')}; services {ev('JSON.stringify(HQ3D_DEBUG.transit.services())')}")

        def record(name, caption, under=False):
            pg = P["pg"]
            st = json.loads(ev("JSON.stringify(HQ3D_DEBUG.stats())") or "{}")
            ui = json.loads(ev(UI_JS) or "{}")
            png = os.path.join(out_dir, name + ".png")
            pg.screenshot(png)
            errs = pg.errors()
            dc, tri = st.get("drawCalls"), st.get("triangles")
            cap = MAX_UNDER if (under or st.get("underground")) else MAX_FRAME
            row = {"shot": name, "caption": caption, "drawCalls": dc, "triangles": tri, "under": bool(st.get("underground")),
                   "transit": st.get("transit"), "errors": errs[:5], "offscreen": ui.get("off"), "overlap": ui.get("overlap"), "png": png}
            problems = []
            if errs:
                problems.append("page errors: " + "; ".join(str(e)[:120] for e in errs[:3]))
            if isinstance(dc, (int, float)) and dc >= cap:
                problems.append(f"{dc} draw calls (< {cap})")
            if isinstance(tri, (int, float)) and tri >= MAX_TRI:
                problems.append(f"{tri} triangles")
            if ui.get("off"):
                problems.append("UI off screen: " + ", ".join(str(b.get("name")) for b in ui["off"])[:120])
            if ui.get("overlap"):
                problems.append("the phone covers: " + ", ".join(ui["overlap"]))
            row["problems"] = problems
            rows.append(row)
            if problems:
                bad.append(f"{name}: " + "; ".join(problems))
            print(f"{'ok ' if not problems else 'BAD'} {name:28s} {str(dc):>5} calls {str(tri):>8} tris {'under' if row['under'] else '     '}  {caption}"
                  + ("  <- " + "; ".join(problems) if problems else ""), flush=True)

        for name, caption, acts, opt in TOUR:
            num = name.split("-")[0]
            if only and not any(o == num or o == num.rstrip("abc") or (not o.isdigit() and o in name) for o in only):
                continue
            notes = []
            for a in acts:
                if isinstance(a, (int, float)):
                    time.sleep(a)
                    continue
                if a == "RELOAD":
                    open_page()
                    continue
                r = ev(a)
                if r and isinstance(r, str) and ("err" in r[:12] or r == "null"):
                    notes.append(f"{a[:60]} -> {r[:120]}")
            time.sleep(opt.get("wait", 2.5))
            ev(S + "hideLobby()")
            record(name, caption, under=opt.get("under", False))
            for n in notes:
                print("     note:", n)
            if opt.get("calm"):
                ev(S + "calm(true)")
                time.sleep(1.5)
                record(name + "-calm", caption + " (Calm on)", under=opt.get("under", False))
                ev(S + "calm(false)")
        ev("HQ3D_DEBUG.transit.phoneClose()")
        P["pg"].close()
        br.close()
    finally:
        U.stop_server(server)
        arena.close()
        shutil.rmtree(tmp, ignore_errors=True)
    with open(os.path.join(out_dir, "tour.json"), "w") as f:
        json.dump(rows, f, indent=1)
    print(f"\n{len(rows)} shots in {out_dir}")
    if bad:
        print("problems:\n  " + "\n  ".join(bad))
        sys.exit(1)
    print("transit tour passed")


if __name__ == "__main__":
    main()
