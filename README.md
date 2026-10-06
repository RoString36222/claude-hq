# ⚡ Claude HQ

**Version 1.9.0** · a **local, private, gamified dashboard** for everything happening across your Claude Code sessions.

Claude HQ reads your live sessions (`claude agents --json`) and your session transcripts
(`~/.claude/projects/**/*.jsonl`) and turns them into a single command center: what every tab is
working on right now, what it would cost at API list prices, a searchable archive of every past session, and a whole
Pokémon-style collection layer on top for fun.

It runs entirely on your machine and binds to `127.0.0.1` only. **Your conversations never leave your
computer.** (The one exception is that some creature packs load sprite images from a public CDN —
the "pokemon"/"aniimo" packs by creature id, and the "Clash of Clans" pack by troop name + level
number — never any of your data. Switch to the "monsters" pack for 100% offline. The optional [Arena](#-arena-multiplayer--optional) layer, off unless you turn it on,
shares daily activity *counts* with friends — never conversation content.)

---

## ✨ Features

**Fleet overview**
- Live cards for every session, grouped **Needs you → Working → Idle → Stale**, updated in real time
  over Server-Sent Events (with a polling fallback).
- **Archived history**: every past transcript shows up as a Stale card — your full history, searchable
  and re-openable.
- Per-card: current in-flight tool, first/latest prompt, last reply, tokens & cost, a 24h sparkline,
  tags, notes, and quick actions.
- **Actions**: ▶ Resume (opens a new terminal into `claude --resume <id>`), 📂 Reveal in Finder,
  ⤢ Focus mode, ✕ Close (stops the process), ✏️ Rename, 📌 Pin.

**Search & detail**
- Full-history **search** across every transcript (TF-IDF ranked).
- Detail **drawer** with a live-tailing timeline, files touched, token/cost, session history
  (started / active days / span), notes & tags, and a **full transcript reader** with in-transcript
  search + Markdown export.

**Analytics**
- 13-week **contribution heatmap** (click any day → that day's digest), token/cost trends,
  busiest-hours & day-of-week charts, **Hall of Fame**, and an **Account & Usage** panel
  (cost by model, cost by project).
- **Project deep-dive**: click any project for its own dashboard.
- **Daily Digest**: a generated "what I did across all sessions today" report (Markdown export).

**Gamification**
- Every session maps (stably) to one of **48 creatures** that **evolve** through real evolution lines
  as the session grows, with elemental **types** and rare **shiny** variants.
- A **Pokédex** collection view, a **⚔️ Gym** team-type-matchup analyzer (real 18-type chart),
  a **🏅 Quests** view, a **Trainer Card**, XP/levels, streaks, achievements, and confetti.
- **⚡ Creature energy**: creatures tire after long unbroken runs (about 2h makes one 💦 Fatigued;
  past 3h it may 💫 faint) and recover while you take a break. With the Arena connected you also
  get **🪙 Poke Coins** (5 a day) to spend in the **🏪 Store** and gift coins or snacks to friends.
  Purely cosmetic: it never touches XP or the leaderboard, rest alone always works, and you can
  turn it off in Settings.
- **🏪 The General Store** (key `8`): a cozy pixel-art shop in the spirit of farm-sim games, all
  original art. 21 foods (fruit, snacks, meals, drinks, sweets and two revives), seasonal stock
  that rotates with the real calendar, a daily special, a shopkeeper who chats (and dozes after
  11pm), a shop cat to pet, and a bag you feed your creatures from.
- **🌮 Cali Tuesdays** (key `9`): a retro pixel-art taqueria for logging Taco Tuesday at
  California Burrito. Seat your friends (type `@` to pick them from the Arena), drag food from the
  counter onto their plates (or click a food, then a plate), watch the receipt work out the pooled buy-1-get-1, then check out to the
  arcade-style hi-score board. Seasons are calendar months; last season's champion gets a crown.

- **🌾 The Valley** (key `0`): ten minigames for the moments a tab is working. A "play while
  you wait" pill appears while tabs work, and the game pauses the moment a tab needs you.
  A pixel-art fishing pond (each project is its own pond; fish modelled on 16 real species with
  real sizes, a hook-and-reel meter and treasure), a garden your prompts water, a bundles
  board, the Mines (deeper on weeks you're active more days), **Pokémon-style Creature Battles** with real species, base stats,
  level-up moves and the 18-type chart, a daily code puzzle, three townsfolk, a monthly
  fishing-derby festival, the Bug Blaster arcade, and **3D Mini Golf** (five themed courses, 25
  holes: windmills, hills, sliding gates, bumpers, sand, ice and water). Battles use a team you
  pick from the Pokémon you've unlocked, or your live sessions. With the Arena connected
  you can also play with friends in your room: a shared fishing dock with a room goal and boss
  fish, a live puzzle race, the live **Creature Duel**, co-op Mines, a shared farm, Mini Golf,
  Kart Racing, **Platformer Rush** (race or co-op across floating islands) and **Blaster Arena** (a
  cartoon first-person free-for-all with lag-compensated shots, plus a solo target range) for up to 8. The server referees every multiplayer game; your own moves show instantly, other
  players are interpolated, and a dropped connection rejoins by itself in about a second. Art is
  drawn in code except the 3D games' CC0 Kenney models and the optional Pokémon sprite pack;
  progress is a local `games-save.json`; in an Arena room only game moves are shared.

- **🔥 Flexible streaks:** a streak survives a quiet day or two. It only breaks when you're inactive on 3 days within any 7 (at least 5 active days in every 7), and today never counts as a miss while it's still going. The Arena leaderboard uses the same rule.

**Quality-of-life**
- Command palette (⌘/Ctrl-K), keyboard shortcuts (`?` for help, `1`–`8` for views, `/` search, `r`
  refresh), desktop notifications + optional chime + voice alerts when a tab needs you, a
  **War Room** rotating big-screen view, a **Focus Pomodoro** timer, and a **"welcome back" recap**.
- Settings: **themes** (Aurora / Midnight / Forest / Mono + High-contrast), **creature packs**,
  **accent color**, **large-text** and **calm** (reduced-motion) modes, refresh cadence, stuck-tab
  threshold, and a daily cost budget.
- Accessibility: skip link, ARIA roles/live regions, roving-tabindex grid navigation, focus trapping.

---

## 📦 Requirements

- **macOS** (uses `launchctl` for auto-start, `open`/AppleScript/`kitty` for actions).
- **Python 3** (standard library only — no `pip install` needed).
- **Claude Code** installed and on your `PATH` (`claude`).
- Optional: [`kitty`](https://sw.kovidgoyal.net/kitty/) terminal (Resume opens a kitty window; falls
  back to Terminal.app).

No third-party Python or JS dependencies. Two files do everything: `dashboard.py` + `index.html`
(plus `arena.py`, also stdlib-only, if you turn on Arena).

---

## 🚀 Installation

```bash
git clone <your-repo-url> claude-hq
cd claude-hq
python3 dashboard.py
```

That starts the server on <http://127.0.0.1:8765> and opens it in your browser.

### Flags
```
python3 dashboard.py [--port 8765] [--no-open]
```

### Run it always-on (auto-start at login)
```bash
python3 dashboard.py --install     # registers a launchd LaunchAgent (starts at login, self-heals)
python3 dashboard.py --uninstall   # removes it
python3 dashboard.py --print-plist # preview the LaunchAgent, no side effects
```
Once installed you never start it by hand again — just open <http://127.0.0.1:8765>.

> **Note:** the LaunchAgent runs the code as it is on disk. Frontend (`index.html`) changes are picked
> up on refresh; after editing `dashboard.py`, reload the backend with:
> ```bash
> launchctl kickstart -k gui/$(id -u)/com.claudehq.dashboard
> ```

### Optional shell alias
```bash
echo 'alias claude-hq="python3 ~/Documents/Claude/claude-dashboard/dashboard.py"' >> ~/.zshrc
```

---

## 🔒 Privacy & security

- Binds to **`127.0.0.1` only**; any request with a non-localhost `Host` header is rejected with `403`.
- All state-changing actions (rename / pin / close / resume / settings) require a per-process **CSRF
  token** (injected into the page, sent as `X-HQ-Token`) plus an Origin / `Sec-Fetch-Site` check.
- File lookups are validated (UUID / known-folder allowlists) — no path traversal.
- **Close** only signals a pid that `claude agents` lists as a live interactive session (and whose
  command is still `claude`) — never the dashboard itself or an arbitrary process. If the session
  list cannot be read (e.g. the `claude` CLI is missing), Close is refused with `503`.
- POST bodies are capped at 1 MiB (8 MiB for soundboard uploads); larger requests get `413` (sent
  without reading the body, so a client mid-upload may see a connection reset instead).
- Local state files (`config.json`, `sessions-meta.json`, `arena-link.json`, `.dex-seed`) are written
  atomically with `0600` permissions. A file that no longer parses is set aside as
  `<name>.corrupt-<timestamp>` (git-ignored) and defaults are used, so nothing is silently overwritten.
  A symlinked state file is written through (the link is kept, the target replaced).
- Your transcripts and settings stay on disk. `config.json` and `sessions-meta.json` are git-ignored.
- **Arena is off by default.** When enabled it publishes daily *counts* only — never conversation
  content, file paths or project names — and its device token lives in `arena-link.json`, outside
  `config.json`, so it is never served to the page. See [Arena](#-arena-multiplayer--optional).

---

## 🗂️ Files

| File | What |
|---|---|
| `dashboard.py` | Stdlib-only HTTP server: reads live agents + transcripts, serves the JSON API and the page. |
| `index.html` | The entire self-contained frontend (inline CSS + JS). |
| `arena.py` | Optional Arena client: builds + publishes the shared-stats payload. |
| `backend/` | Optional Arena server (FastAPI). Only needed by whoever hosts it. |
| `arena-link.json` | Your Arena device token. *(git-ignored)* |
| `config.json` | Your settings (theme, pack, budget, …). Created on first save. *(git-ignored)* |
| `sessions-meta.json` | Per-session pins / tags / notes / rename aliases. *(git-ignored)* |
| `meals.json` | Which session ate which snack (local only). *(git-ignored)* |

### HTTP API (all `127.0.0.1` only)
`GET /` · `GET /api/sessions` · `GET /api/stream` (SSE) · `GET /api/session/<id>` ·
`GET /api/session/<id>/export.md` · `GET /api/transcript/<id>?offset&limit&q` · `GET /api/search?q=` ·
`GET /api/history` · `GET /api/project?folder=` · `GET /api/pokedex` · `GET /api/digest?date&download` ·
`GET /api/config` · `GET /api/meta` · `GET /api/export.{json,csv}` · `GET /api/arena/pantry` ·
`GET /api/arena/cali/board?window={season,30d,7d,all,lastseason}` · `GET /api/arena/cali/orders` ·
`POST /api/action` · `POST /api/config` · `POST /api/meta` ·
`POST /api/arena/pantry/{claim,buy,eat,give}` · `POST /api/arena/cali/order`
(all POSTs CSRF-guarded).

---

## 🏆 Arena (multiplayer) — optional

Claude HQ is local-first and stays that way. **Arena** is an opt-in layer that
adds a shared leaderboard across you and your friends, a lobby chat and a voice
and video channel with everyone who has Arena open, plus websocket rooms to build
minigames on. It is off until you connect it.

### What is shared

Your dashboard keeps reading transcripts locally and publishes **daily counts
only** — prompts, tool calls, artifacts, tokens. It never sends prompt text,
replies, file paths, project or folder names, session ids, or titles.

- **Tool names are allowlisted.** MCP tools are named `mcp__<server>__<tool>`
  and routinely carry an employer's or client's name, so anything that isn't a
  built-in Claude Code tool is bucketed as `Other` before it reaches the wire.
- **Cost sharing is off by default.** Spend is salary- and employer-adjacent.
- **Chat is only what you type.** Messages in the lobby chat go to everyone in
  the lobby, relayed by the server. It keeps the last 50 in memory (never on
  disk) so people who join can catch up; they're gone when the lobby empties or
  the server restarts. The server also cleans and caps messages (500
  characters) and rate-limits them (8 per 10 seconds per connection).
- **Voice and video are peer-to-peer.** Audio and video go straight between
  browsers (WebRTC), never through the server. The server relays only the
  connection setup, which includes IP addresses, and only to the people you're
  in voice with; a public STUN server (Google's) tells your browser its public
  address. Your microphone is used only after you click **Join voice** and your
  camera only after you click **Camera**; both stop when you leave.
- **Live status is off by default.** Turn on **Share my live status** and your
  lobby entry shows how many of your sessions are working and how many are
  waiting on you: just those two numbers, never titles, folders or text.
- **You're in the lobby while HQ is open.** So friends see you online and chat
  and calls reach you on any view. Turn off **Stay in the lobby on every view**
  to show up only while the Arena tab is open.
- **Poke Coins and snacks live on the server**: it sees what you buy, eat or
  give (kind, amount, recipient, an optional note), never which session ate it.
  That stays on this machine, in `meals.json`. Creature energy itself is
  computed locally and is never shared.
- **Valley games send only moves.** In a multiplayer Valley game your browser sends casts,
  reels, puzzle guesses, battle picks, your team as species numbers and species names, golf
  shots and your golfer's position on the course. The server keeps game state in memory (the
  shared farm is stored) and never sees session titles, prompts or project names.
- The wire format rejects unknown fields outright, so a future client change
  can't silently start leaking one.

Scores are computed on the server from raw counts, not submitted by the client,
so the formula can change without a client release.

### Connecting

One person hosts the backend once. Either on their own Mac:

```bash
./selfhost-wizard.sh    # this Mac + SQLite + a Cloudflare Tunnel
```

or in the cloud, if you'd rather it stay up when that Mac sleeps:

```bash
./deploy-wizard.sh      # Fly.io + Neon Postgres
```

Both set up the GitHub OAuth app and print exactly what to send your friends.

Everyone else just points their own Claude HQ at it: **🏆 Arena → server URL →
Sign in with GitHub → paste the pairing code**. Your device token is stored in
`arena-link.json` (git-ignored) and is never exposed to the page.

Backend source, API and design notes: [`backend/README.md`](backend/README.md).

---

## 🎨 Customization

Open **⚙️ Settings** in the app for themes, creature packs, accent color, text size, calm mode,
refresh rate, stuck threshold, and daily budget. Press **?** in the app for the full keyboard-shortcut
and feature guide.

---

## Changelog

- **1.9.0** — **Kart Racing: the Valley's first real-time multiplayer game.**
  - **Kart Racing** (🏎️ in the Valley): arcade cars on three tile-built tracks (Meadow Loop,
    Canyon Notch, Twin Peaks; 1–5 laps), made from Kenney's CC0 Starter Kit Racing models. Drive
    with W/A/S/D or the arrows, Shift to drift (tyre smoke), R to hop back onto the road, C for
    the camera; a gamepad works too. The HUD has an analog **speedometer and RPM gauge**, lap,
    place, race and lap times, a minimap and a "Wrong way!" warning. Solo it's a time trial with
    your best lap saved per track; with friends it's a race of up to 8 with a countdown grid,
    live standings and a results card. Low-detail mode for older laptops, and a 2D map view
    without WebGL2.
    Tracks are drawn 1.5× the kit's size (a 13.5 m road, so eight cars have room) with a 108 km/h
    top speed; the chase camera holds a fixed distance and only smooths its heading, so the car
    stays big on screen at full speed; steered wheels no longer wobble while they spin.
  - **Mini Golf: the camera follows your drag.** Dragging to aim in 3D now works like a slingshot on
    the screen (pull back to putt away from you, sideways to aim), so the camera swings round behind
    the aim while you drag instead of holding still.
  - **Valley lobbies: invite or nudge with suggestions.** One search box in every multiplayer game's
    lobby suggests people as you type (avatar, name, @handle): friends online in your room get a game
    invite, anyone else on the Arena gets a nudge, and an exact @handle can still be nudged.
  - **Kart Racing: nine tracks, longer laps, a random pick.** Six new tracks (Pine Speedway, Lakeside
    Sprint, Harvest Hairpins, Autumn Run, Frostbite Ring, Sunset Switchbacks) and longer layouts for the
    first three (390–570 m a lap), each with its own sky and scenery tint (snow-dusted on Frostbite,
    autumn leaves, dry grass). A 🎲 Random track button picks one, solo or as the room's host. An Arena
    from 1.9.0 still gets the three original tracks at their first size until it's updated.
  - **Call overlay.** While you're in an Arena voice call on any view but the Arena, a small panel floats in the
    corner (drag it anywhere, collapse it): who's in the call and who's talking, mute, camera, screen share and
    leave, and everyone's video. The videos move back to the Arena's voice panel when you open it.
  - **Mini Golf ghosts.** Once you've finished a hole you're a ghost: see-through, no shadow, a faint name tag, and
    you can roam the hole while the others play. Other finished players are fainter still, so nobody blocks the view.
  - **Real-time multiplayer foundation** (shared by Platformer Rush and Blaster Arena): a
    fixed-rate server tick per room (`backend/app/realtime.py`, 15 Hz for racing) that batches one
    snapshot per tick, a process-wide cap on running game loops, a per-room bandwidth budget that
    thins snapshots under pressure, and token buckets for inbound frames; one shared input layer in
    the browser (`games/input.js`: keyboard, pointer-lock mouse look, gamepad).
  - **Fair racing under lag:** each player drives locally and streams positions; the Arena checks
    every frame (on the road, no faster than a car, laps in order, the sender's own clock bounded
    against the server's so frames bunched or reordered by jitter are never punished) and times
    the finish. An 8-car race at 120 ms ± 60 ms simulated lag runs in the backend tests on both
    the Python and the Rust Arena.
  - **Both Arena backends:** the Rust port (`backend-rs/`) gains the same tick, budgets and kart
    referee, with per-connection message queues so game events reach exactly the right sockets.
  - **Third-party assets:** the IP rule now allows vendored assets whose license permits it (with
    the license alongside, never hotlinked); this release adds Kenney's Starter Kit Racing models
    (CC0) in `games/kart/`. The local server's listen backlog is raised so a 3D game loading a
    dozen models at once no longer sees a reset connection.
  - **Mini Golf: Play random — 5, 10 or 15 holes from every course.** The Mini Golf menu (solo
    practice and the Arena host's course picker) gets a "Play random" row. A round draws that many
    holes, no repeats, from all 25 holes of every course, and each hole keeps its own course's sky,
    fog, light, tint and scenery, switching look as you move between holes (the HUD names the
    course each hole came from). In a room the Arena server draws the holes with its own RNG (a
    start of `course: "random"` with `holes` 5, 10 or 15; anything else is refused) and sends the
    chosen `mix` of `[course, hole]` pairs in the round view, so every client builds the same holes
    and the referee rolls each putt on the right one. Random rounds don't record a "best" score.
    No new network traffic beyond the existing opt-in Arena game messages; the putting physics is
    unchanged.
  - **Platformer Rush** (🏝️ in the Valley): run, jump and **double-jump** across floating islands
    to the flag, coins on the way, built from Kenney's CC0 Starter Kit 3D Platformer models. Three
    levels (Meadow Hop, Sky Steps, Cloud Fortress) with checkpoints, coin trails that hint the
    route, a few double-jump gaps and a shortcut or two. A third-person character controller
    (camera-relative WASD/arrows/stick, coyote time, jump buffering, idle/run/jump animations, a
    spin on the double jump, squash on landing) and an orbit camera (mouse look under pointer lock,
    right-drag, right stick or Q/E; it drifts behind you as you run and never sits inside a
    platform). Fall below the clouds and you're back on your last checkpoint. Solo it's a time
    trial with your best time saved per level; with friends, up to 8 play a **Race** (first to the
    flag, every checkpoint in order first, live standings) or **Co-op** (the whole lobby shares one
    coin goal against the clock, with a team progress bar). Six runner colours, name tags,
    countdown, results card, low-detail mode, and a top-down map view without WebGL2.
  - **Platformer referee:** the Arena checks every frame on the 15 Hz real-time tick: inside the
    level, no faster than a run, rising and falling no faster than a jump and gravity, never inside
    a platform, and never higher above the last platform stood on than a jump plus a double jump
    can reach in the time since (a closed-form envelope, so hovering across a gap is caught). The
    server owns the checkpoints (in order, within reach), the coins (each once per player in a race;
    once for the whole room in co-op, first to reach it) and the flag (only after every
    checkpoint); a refused frame puts you back where you last stood, and respawns go to the last
    checkpoint the server confirmed. Clients send their *simulation* clock, so a stalling tab that
    runs in slow motion is never mistaken for a cheat. Tested with 8 bots at 120 ms ± 60 ms lag and
    reordering on every level, race and co-op, on both the Python and the Rust Arena (zero false
    rejections, true finish order, each co-op coin counted once, snapshots inside the room's
    bandwidth budget). The level files are shared byte-for-byte by the browser and both backends.
  - **Third-party assets:** Kenney's Starter Kit 3D Platformer models, texture and blob-shadow
    sprite (CC0) in `games/platformer/` with the license alongside; the kit's Godot code (MIT) is
    not used.
  - **Blaster Arena** (🎯 in the Valley): a cartoon first-person shooter on **Sky Courtyard**, an
    enclosed arena laid out from Kenney's CC0 Starter Kit FPS blocks (a raised keep with stairs and a
    parapet, two corner towers, L-walls, waist-high cover, crates, health and ammo packs). Two
    blasters: the automatic **Rapid blaster** and the slow, hard-hitting **Heavy blaster** (1/2,
    the mouse wheel or Y to switch; R to reload; headshots count extra). Click the view to aim with
    the mouse (pointer lock; Esc gives it back and the game says so), WASD and Space, a sensitivity
    slider, a gamepad (sticks, RT, A, X, Y, Back), or the keyboard alone (Q/E turn, F fires). Solo
    it's a 60-second **target range** of flying drones with your best score saved; with friends it's
    a **free-for-all for up to 8**: 3, 5 or 10 minutes, first to 10, 20 or 30 kills, a countdown,
    respawns after 3 s at the spawn farthest from everyone (with a moment of spawn protection),
    drop-in mid-match, a quick rejoin keeps your score. HUD: crosshair, hit marker (from the
    server), directional damage indicator, health, ammo with a reload bar, round clock, kill feed,
    scoreboard (Tab or the Scores button) and a results card. Other players are Mini Characters
    holding their blaster, with name tags and walk animations. Calm mode / reduced motion drop the
    weapon bob, screen tilt and hit flashes and shrink the muzzle flash. Low-detail mode, and a
    playable top-down map view without WebGL2.
  - **Arena referee with lag compensation:** a 20 Hz tick checks every move (no faster than a run
    on the sender's own clock, bounded against the server's; inside the arena; never inside a wall;
    never off the ground longer than a jump) and judges every shot: fire rate, ammo, reload and
    weapon switch on the shooter's clock, the shot's origin near where the server has the shooter,
    then it **rewinds every target** to what the shooter saw (the shooter's clock mapped onto the
    server's, minus the round trip the server measures from snapshot acknowledgements, minus the
    interpolation delay the client reports, capped at 350 ms; at most 1.2 s of history) and casts
    the ray against head and body boxes and the arena's walls (no hits through cover). Spread is
    deterministic per shot, so your tracer and the server's verdict agree. One batched snapshot per
    tick carries the players who changed and the shots judged. Tested on both backends with 8 bots
    at 120 ms ± 60 ms lag each way and reordering: no honest frame refused, ≥ 90% of shots aimed at
    the drawn target register, shots at where someone was 0.8 s earlier don't, kills and deaths add
    up, and the room stays inside its bandwidth budget. The arena file is shared byte-for-byte by the
    browser and both backends.
  - **Third-party assets:** Kenney's Starter Kit FPS blasters, blocks, drone, cloud and grass
    models, texture and muzzle/impact sprites (CC0) in `games/fps/` with the license alongside;
    the kit's Godot code (MIT) is not used. The players reuse the Mini Characters in `games/golf/`.

- **1.8.1** — **Mini Golf grows to five themed courses, and you pick your battle team.**
  - **Five Mini Golf courses, 25 holes.** Meadow Greens (4), Windmill Lane (5) and Castle Keep (6)
    are joined by **Desert Canyon** and **Snowy Peak** (5 holes each). Every course has its own
    scenery and mood: a sky gradient with fog, an island dressed with Kenney's CC0 Nature Kit props
    (trees, flowers, cacti, rocks, fences, crops, a stone column; snow-dusted on the peak), per-theme
    sunlight with real shadows and a tint on the felt. The course cards list holes, par, the mood
    and what's in the course.
  - **Varied holes.** The windmill's blades now block the doorway while one sweeps past, hills
    roll a weak putt back, sliding gates cross the lane, bumpers kick the ball off harder than a
    wall, sand drags, ice glides, and water is a hazard (+1 stroke, back to your last lie). Blades
    and gates follow a shared shot clock: a putt carries the phase it left at, so it replays
    identically on every client and on the Arena server. The fixed-step integer physics stays
    line-for-line identical in `games/golf.js` and `backend/app/golf.py`, and the golden/parity
    vectors now cover every surface and obstacle at random clock phases.
  - **Battle team picker.** Creature Battles and the Creature Duel get a team builder: every
    Pokémon you've unlocked in the Pokédex, at the highest stage you've reached, with its real
    sprite, types and four moves. Pick up to 6, put your lead first and save (locally, in the
    Valley save); with nothing saved, battles use your working and idle sessions as before. Duels
    still send only species and stage numbers per member; the server derives everything else and
    now clamps the stage.
  - **Arena backend needs a deploy** for the new courses and obstacles (no database migrations).
  - **Third-party assets:** 29 more CC0 models from Kenney's Nature Kit 2.1 and three more
    Minigolf Kit pieces in `games/golf/`, with the Nature Kit license added to
    `games/golf/LICENSE-kenney.txt`. Still served only from `127.0.0.1`, only when Mini Golf opens.
  - **Privacy:** a golf shot now also carries the shot clock's phase (an integer); the saved team
    is species numbers in your local save.

- **1.8.0** — **Valley v2: real Pokémon battles, a new fishing pond and 3D Mini Golf, with
  butter-smooth multiplayer.**
  - **Pokémon-style battles.** Creature Battles (solo) and the live Creature Duel now use real
    Pokémon data: species, types, base stats, level-up movesets and the type chart, generated from
    Pokémon Showdown (MIT) by `tools/build_pokedata.mjs` into `games/pokedata.js` and
    `backend/app/data/pokemon.json`. A battle screen with HP bars, move menus, switching,
    animated attacks and a battle log. In a duel the Arena runs the same damage engine
    (`backend/app/pokebattle.py`, parity-tested against the browser) and both players pick at
    once: your pick shows at once, the other player's "is ready" appears as soon as they choose,
    late picks get a 2 s grace instead of a strike, animations don't eat the turn timer, a
    player who drops gets 20 s to come back (their seat is kept, with a countdown for the
    opponent), and an ending missed while offline is replayed when they return.
  - **Fishing redesign.** A pixel-art pond whose fish are modelled on 16 real species (sizes from FishBase), a charge-and-cast
    aim, a hook window and a reel meter, treasure chests and a catch card. The shared dock shows
    everyone's line live: casts, bites and hooks appear one round trip later, slots glide when
    people join, the room goal and boss fish HP ease instead of jumping, the server rolls fish,
    points and chests (a "perfect" reel is cosmetic), and a player who leaves takes their line
    with them.
  - **3D Mini Golf (solo or with friends).** Three courses
    (Meadow Greens, Windmill Lane, Castle Keep; 15 holes) built from Kenney's CC0 Minigolf Kit, with
    a golfer per player (Kenney Mini Characters) who walks to the ball, aims and putts. In an Arena
    room everyone plays the same hole at once and the server rolls every putt with integer physics
    that each browser replays bit-for-bit, so all players see the same roll. **Smooth multiplayer:**
    your own putt starts the instant you release (the server only confirms it), other golfers are
    drawn from a jitter-buffered timeline of their positions (no stutter or teleporting), position
    updates are small, sequenced and rate-limited by a per-player token bucket, the server fans
    out to a game's lobby concurrently with a per-socket timeout, and a dropped room socket shows
    "Reconnecting…", rejoins the game lobby automatically and gets your scorecard back. Falls back
    to a 2D map view when WebGL isn't available. **Third-party assets (new, flagged for review):**
    three.js r186 (MIT) is vendored unminified in `games/vendor/` (only import paths rewritten;
    `tools/vendor_three.py` reproduces it) and the CC0 Kenney models live in `games/golf/` with
    their license text; both load only from `127.0.0.1` and only when Mini Golf opens. The
    `/games/` route now also serves `vendor/<name>.js` and `golf/<name>.glb|json|png` (strict
    allowlist, one folder level, ETag-revalidated). **Privacy:** golf messages carry only shot
    integers, positions on the course, a character id and an animation id.
  - **Smoother multiplayer everywhere.** One reconnect shell for every Valley game: after a
    socket drop it shows "Reconnecting…", rejoins the game's lobby on the new socket and resyncs
    from the server's snapshot, and holds a game's moves until that rejoin so none are refused.
    The Arena room socket now retries 250-750 ms after a blip (it used to wait 5 s), backs off from
    1 s to 30 s with jitter after that, retries when a ticket request fails, and retries at once
    when the browser comes back online. A quick rejoin no longer fires a "joined" toast for the
    whole room, and a duel pick made right after a reconnect is kept.
  - **Arena backend needs a deploy** for the duel engine, the new pond and Mini Golf (no
    database migrations). Until then, solo games are unaffected, the shared dock falls back
    quietly where the old server differs, Mini Golf says the server doesn't support it yet, and
    live duels need the new server.
  - **Third-party data and assets, all vendored** (no new runtime requests): three.js r186 (MIT),
    Kenney Minigolf Kit and Mini Characters (CC0), Pokémon Showdown data (MIT), FishBase numbers
    (cited). The optional "pokemon" creature pack still hotlinks its sprites as before. Licenses
    are in `games/vendor/`, `games/golf/` and `LICENSES/`.
  - **Privacy:** multiplayer messages carry only game moves (casts, picks, shot integers, course
    positions, a team of species/stage numbers and species names); nothing from transcripts.
- **1.7.0** — **One-click update.** A new **Update** button in the top bar shows when new
  commits are waiting ("Update · 3 new", with the commit list on hover) and, on click, pulls them
  and restarts Claude HQ, then reloads the page. It only ever fast-forwards: it refuses if you have
  local edits in the Claude HQ folder or your branch has diverged, so it never merges or discards
  anything. Under the launchd agent it restarts through `launchctl kickstart`; otherwise it
  re-executes itself. **Also in this release (merged since 1.6.1):**
  - **Cost is now right.** Usage was counted once per transcript line instead of once per API
    message (about 2× too high) and Opus 5.5 was priced at the old $15/$75 instead of $4/$20; 1-hour
    cache writes now cost 2× input. Historical cost figures drop accordingly (#52).
  - **Scanner fixes:** image prompts count again, "billing"/"rate limit" in a reply no longer flags a
    tab for 6h, Esc interrupts aren't prompts, session ids on GET routes are validated (#52).
  - **Needs you, for real:** an unanswered question or plan approval marks a tab "Question" /
    "Plan approval"; a long-open permission-gated tool shows a "permission?" hint (#56).
  - **Safer local state:** atomic 0600 writes with corrupt-file quarantine, Close only targets live
    Claude tabs, POST bodies are size-capped (#51).
  - **Live cards stay fresh** without rebuilding every 1.5s; quest and voice fixes (#55).
  - **Arena hardening:** refuses the default secret key, device list/revoke and idle expiry, ingest
    caps, server-derived quest rewards, `/health` returns 503 when the database is down (#53).
    _Needs a backend deploy with `ARENA_SECRET_KEY` set._
  **Privacy:** the update check runs `git fetch` against your own remote; nothing else is sent.

- **1.6.1** — **Tag friends from the Arena.** In Cali Tuesdays, type `@` in the seat box to
  **autocomplete people from the Arena** (avatar, name and exact handle); the list narrows as you
  type, and a plain name also offers matching Arena people. Before, any `@text` was accepted and
  shown as tagged, but the server matches handles exactly and refuses the whole order on an unknown
  one: now a tag that isn't on the Arena is flagged on its plate and stops checkout with a clear
  message. Click a name at the table to tag, re-tag or untag that person (picking someone already
  seated merges the two plates). Count badges on a crowded plate no longer hide behind other food.
  **Privacy:** no new egress. The diner reads the Arena board through the local proxy (the same
  read the Arena tab makes) and shows the avatars it lists; nothing new is sent.
- **1.6.0** — **Cali Tuesdays gets its own diner.** The taco log moves out of the Arena into a
  **Cali Tuesdays** tab (key `9`): a retro taqueria with **100% original pixel art** drawn at
  runtime (no photos, no new network calls). A food-court stall (a 3D-lettered sign, tiled walls,
  menu boards, a steel counter of food pans) holds the menu as food you can pick up (the four mild/wild × hard/soft tacos, burrito, rice and salad bowls, quesadilla,
  nachos, tostada, chips & salsa, guacamole, churros, soda, iced tea); **drag it onto a friend's
  plate** (mouse, pen or touch), or click a food and then a plate, and click food on a plate to
  take one back. A thermal-paper receipt keeps the running TT, the pooled buy-1-get-1 and TPP;
  **Checkout** logs the dinner (one request id per dinner, safe to retry), stamps it PAID and
  refreshes the **arcade hi-score board**, which flags who moved, shows each person's favorite
  dish, counts down to the next monthly season and crowns last season's champion. The table
  survives a reload. Backend: diners can now record **other dishes** besides tacos (stored and
  reported, never priced or scored: the board still ranks Tuesdays, then tacos), a `lastseason`
  board window, and per-person favorites. _Needs a backend deploy with a migration (an added
  column); until then the diner logs tacos only and says so on the receipt._
- **1.5.0** — **The General Store.** The store moves out of the Arena into its own
  **Store** tab (key `8`): a Stardew-inspired pixel-art shop with **100% original art**
  drawn at runtime (no assets, no network): a window that follows your local time of day,
  the season and the day's weather, a wall calendar and clock, shelves stocked with what's
  for sale, and **Katie** behind the counter, who greets you, chats, reacts to what you
  buy and dozes after 11pm (ring the bell). Pet **Biscuit** the shop cat, build friendship
  hearts, and hear WebAudio blips, chimes and a purr (with a store-only mute). The menu is a
  wood-and-parchment shop list with category tabs, item tooltips, a rolling coin counter,
  the daily claim, and a **bag** you feed creatures from. **21 foods** (up from 4): 9 sold
  year-round plus 3 seasonal ones per season (UTC calendar), including a **Hot Pot** (4 🪙,
  +3h) and a **Honey Elixir** revive that wakes a fainted creature nearly rested. One
  in-stock food a day is the **special**, a coin off. Stock, prices and the special are
  enforced by the Arena server; an Arena that hasn't updated yet keeps selling the original
  four and shows the rest as sold out. Shift-click buys up to five; a lost purchase retries
  with the same quantity. The creature drawer now lists only snacks you own (plus the best
  one to buy). _Needs a backend deploy: no migration, catalog only._
- **1.4.0** — **Customizable Trainer avatar.** Build your own trainer — a
  Pokémon-style character creator from **100% original, generated SVG parts**
  (skin, hair style + color, outfit + color, headwear, accessory, background,
  expression; ~5.5M combinations) in **Settings → Trainer look** or the ✎ on the
  Trainer Card. It becomes your identity/logo across HQ, starting with the
  Trainer Card (its first-ever avatar). Deterministic and dependency-free
  (`trainerSVG` sits beside `monsterSVG`); the spec is a tiny 9-int array stored
  in `config.json` (mirrored to localStorage for instant boot); non-builders get
  a distinct auto-derived trainer from a stable, non-transcript key. No
  copyrighted assets — invented parts only. _Arena leaderboard integration
  (showing friends' trainers) ships next and needs a backend deploy._
- **1.3.1** — **Per-install shiny.** Which species are shiny is now seeded by a
  per-install salt (`.dex-seed`, git-ignored), so friends sharing an Arena no
  longer all see the identical set of shiny species. Shiny stays a stable,
  deterministic per-species trait (live cards still always match the Pokédex) —
  it just differs from one machine to the next. No data crosses the wire; shiny
  is computed locally and was never shared.
- **1.2.4** — Polish & efficiency pass. **Battery/CPU**: all recurring data-fetch loops (the
  5s fleet poll + the analytics/pokedex/quests/trainer/arena timers) now fully idle when the
  browser tab is hidden and refresh instantly when you return, so a backgrounded dashboard stops
  hammering the network. **Clash pack**: the next troop level is preloaded so evolution level-ups
  swap with no flash, and all creature `<img>`s now decode off the main thread (`decoding=async`)
  to cut scroll jank. **Error visibility**: uncaught errors and rejected promises are now logged to
  the console (and shown as a toast when `localStorage.hq_debug="1"`), instead of vanishing silently.
- **1.2.3** — **Clash of Clans creature pack** (Settings → Creature pack). Sessions render as
  real Clash troops, and each one **evolves through that troop's own in-game levels** (1 → its
  real max, e.g. Barbarian 1→12, Golem 1→13) instead of the 5 generic stages — every level shows
  the troop's actual level artwork, hotlinked at runtime from a community dataset
  (`chiefpansancolt/clash-of-clans-data`) via jsDelivr. Nothing copyrighted is bundled in the
  repo; only a troop slug + level number is ever requested (same model as the PokéAPI-sprite
  packs), a missing level steps down to the nearest one, then to a drawn SVG. Troops animate with
  a CSS **march / attack** loop — note that real in-game frame animations aren't available as
  hotlinkable per-level assets (those are Supercell's proprietary sprite/Spine files), so the
  motion is CSS, not game frames. Replaces the short-lived standalone Troops tab. Sits on top of
  the freshly merged **Arena private rooms + quests/achievements** (PR #32).
  <br>_Animation note:_ an exhaustive multi-source search (Giphy/Tenor direct GIFs, GitHub
  Spine/sprite-sheet repos, Clash Royale frame dumps, Fandom animated-webp, Lottie) confirmed
  there is **no source that is animated *and* hotlinkable *and* uniform-per-troop *and* covers all
  ~32 troops *and* supports per-level *and* is official/consistent art**. Real-motion options
  (curated Giphy GIFs, Clash-Royale sprite frames) all sacrifice per-level + full coverage +
  official art, so the official per-level PNGs + CSS motion remain the best fit. A curated Giphy
  overlay (real GIF where hand-picked, static per-level fallback elsewhere) is a documented opt-in
  if real motion is ever required.
- **1.2.2** — Creature/evolution pass. **New Game+**: a new session of a species you've
  already evolved now starts at that grown form (incl. mega at Apex) instead of resetting to
  Egg. Fixed the **3D-sprite flicker** (lead with the Gen-6 X/Y animated sprite, which covers
  every species used, so the SwSh-404→swap flash is gone). New **🧬 Evolution line** preview
  in the session drawer (full base→final line + mega node). Evolution moment is now a ~10s
  cinematic with a game-style **evolving animation** (silhouette flicker → white flash →
  reveal) and broadcasts notable evolutions (final form / mega) to the Arena leaderboard.
  The evolve progress bar tracks real growth, independent of the New Game+ display floor.
  Added `CONTRIBUTING.md` + `AGENTS.md` engineering standards.
- **1.2.1** — UI polish pass (PR #30) and an Arena "persistent nudger" siren (#24), plus
  self-hosting/ops tooling for the Arena server: docker-compose + Caddy, a VPS bootstrap, an
  ACL-gated containerized **deploy panel**, pull-based auto-deploy, and an alternative **Rust**
  Arena backend (`backend-rs/`). Local dashboard is unchanged in behavior. Thanks @shreyash73, @hetnxik.
- **1.2.0** — Big Arena expansion (all opt-in): lobby **voice & video** (WebRTC), **chat** with
  server-side history + rate-limiting, @-mention autocomplete/highlight + `@channel`/`@here`,
  **nudges** (subtle side-toast; offline nudges to reach friends with the tab closed), **screen
  sharing**, live status + unread badge + call shortcuts, and the **`6`** key mapped to the Arena
  view. Plus a **test suite** (`tests/`, `backend/tests/`) and a **CI workflow**. Thanks
  @shreyash73 and contributors.
- **1.1.1** — Arena fixes: SSL error on python.org Python, a blank-dashboard startup crash
  (ARENA declared before first `setView`), and stopped hijacking browser shortcuts (thanks @hetnxik).
- **1.1.0** — Editable Trainer name (thanks @SwastikTripathi, #1), smart Insights engine,
  weekly digest, event log, project deep-dive, installable PWA, and a perf/dead-code hardening pass.
- **1.0.0** — Initial release: live fleet view, full-history search + transcript reader, analytics,
  daily digests, and the Pokémon-style collection / Gym / quests layer.

## Contributors

Thanks to everyone who has contributed to Claude HQ:

- [@RoString36222](https://github.com/RoString36222) — creator & maintainer (fleet view, search,
  analytics, digests, the creature / evolution / Mega system, and the Village mini-game)
- [@SwastikTripathi](https://github.com/SwastikTripathi) — editable Trainer name setting (#1) and
  Arena contributions
- [@hetnxik](https://github.com/hetnxik) (Het Naik) — Arena fixes: SSL/startup crash fixes and
  stopping browser-shortcut hijacking (#1.1.1)
- [@shreyash73](https://github.com/shreyash73) (Shreyash Shanbhag) — Arena self-hosting & ops
  tooling (docker-compose + Caddy, VPS bootstrap, containerized deploy panel, auto-deploy) and the
  alternative Rust Arena backend (#1.2.1)

Made with [Claude Code](https://claude.com/claude-code).

## License

MIT — see [LICENSE](LICENSE).

Mini Golf, Kart Racing, Platformer Rush and Blaster Arena use [three.js](https://threejs.org/) (MIT, `games/vendor/LICENSE-three.txt`)
and models from [Kenney](https://kenney.nl/) — Minigolf Kit, Mini Characters, Nature Kit, Starter Kit Racing, Starter
Kit 3D Platformer and Starter Kit FPS — which are public domain (CC0, `games/golf/LICENSE-kenney.txt`,
`games/kart/LICENSE-kenney.txt`, `games/platformer/LICENSE-kenney.txt`, `games/fps/LICENSE-kenney.txt`). Thank you, Kenney!

Pokémon names and sprites are the property of Nintendo / Game Freak / The Pokémon Company; the
"pokemon" creature pack hotlinks sprites from the public [PokéAPI](https://pokeapi.co/) sprite library
for personal use only. Use the built-in original "monsters" pack to avoid third-party assets entirely.

Valley battle data (species, types, base stats, level-up moves and the type chart in
`games/pokedata.js` and `backend/app/data/pokemon.json`) is generated by `tools/build_pokedata.mjs`
from [Pokémon Showdown](https://github.com/smogon/pokemon-showdown) (MIT,
© 2011-2026 Guangcong Luo and other contributors; see `LICENSES/pokemon-showdown-MIT.txt`).
Battle sprites use the same PokéAPI sprite library (repository CC0; image content © The Pokémon
Company) and the PkParaiso host the 3D pack already uses. This is a non-commercial fan feature.

Fish sizes and length-weight coefficients in `games/fishart.js`: [FishBase](https://www.fishbase.se/)
(Froese & Pauly, eds.). Only numeric facts are used, cited per species in the source; no FishBase
text or images are bundled.
