<div align="center">

# ⚡ Claude HQ

**Version 3.36.0** · a **local, private, gamified dashboard** for your Claude Code and Cursor sessions.

<img src="docs/screenshots/mission.png" alt="Mission Control: every live session is a crew member at a console around the holo-table" width="100%">

<sub>Mission Control. Each live session sits at a console: typing while it works, waving when it needs you, dozing when idle. Screenshots use demo sessions.</sub>

</div>

Claude HQ reads your live Claude Code sessions (`claude agents --json`) and the transcripts already on disk, and
turns them into one command center: what every tab is doing right now, what it would cost at API list prices, a
searchable archive of every past session, and a creature-collection game on top. It runs on your machine, binds to
`127.0.0.1` only, and your conversations never leave your computer. Two optional layers sit on top: the opt-in
multiplayer **Arena** (leaderboards, chat, voice, rooms and games with friends, sharing daily counts only) and the
**3D City**, an archipelago of generated cities with your HQ tower, transit, vehicles and things to do.

| Walk up to your base | Through reception | Every tab, live |
|:---:|:---:|:---:|
| <img src="docs/screenshots/base.png" alt="The base: your tower on a plaza, growing with your level"> | <img src="docs/screenshots/lobby.png" alt="The lobby with reception desk and turnstiles"> | <img src="docs/screenshots/live.png" alt="The classic Live view with session cards"> |
| **Base**: your tower grows with your HQ level | **Lobby**: walk in through reception | **Live**: Needs you → Working → Idle |

| The Valley: solo and multiplayer games | Kart Racing with friends | 3D Mini Golf |
|:---:|:---:|:---:|
| <img src="docs/screenshots/valley.png" alt="The Valley game menu"> | <img src="docs/screenshots/game-kart.png" alt="Kart Racing with speedometer and minimap"> | <img src="docs/screenshots/game-golf.png" alt="Mini Golf, Windmill Lane"> |

**Contents:** [Quick start](#-quick-start) · [Features](#-features) · [The 3D City and City Gen v4](#️-the-3d-city-and-city-gen-v4) ·
[Privacy & security](#-privacy--security) · [Arena](#-arena-multiplayer--optional) ·
[Configuration](#-configuration-and-customization) · [Files and the HTTP API](#️-files-and-the-http-api) ·
[Development](#️-development) · [Changelog](#-changelog)

---

## 🚀 Quick start

### Requirements

- **macOS** (uses `launchctl` for auto-start, `open`/AppleScript/`kitty` for actions).
- **Rust** (`cargo`, via [rustup](https://rustup.rs)) to build the HQ server once.
- **Claude Code** installed and on your `PATH` (`claude`).
- Optional: [`kitty`](https://sw.kovidgoyal.net/kitty/) terminal (Resume opens a kitty window; falls back to
  Terminal.app). Optional: `yt-dlp` and `ffmpeg` for Music room songs played from your own HQ.

Two parts do everything: the HQ server in `dashboard-rs/` (`claudehq`, Rust) and the frontend (`index.html` with
its `ui/` files, no JS dependencies or build step).

### Install and run

```bash
git clone <your-repo-url> claude-hq
cd claude-hq
cargo build --release --locked --manifest-path dashboard-rs/Cargo.toml   # about a minute the first time
dashboard-rs/target/release/claudehq
```

That starts the server on <http://127.0.0.1:8765> and opens it in your browser.

> **macOS tip:** clone it **outside** `~/Documents`, `~/Desktop` and `~/Downloads` (for example `~/claude-hq`).
> macOS asks before a new program reads those folders, and every rebuild of `claudehq` counts as a new program,
> so a clone there makes the login item wait on a permission prompt after each update.

**Flags:**
```
dashboard-rs/target/release/claudehq [--port 8765] [--no-open] [--root DIR]
```

### Run it always-on (auto-start at login)

```bash
dashboard-rs/target/release/claudehq --install     # registers a launchd LaunchAgent (starts at login, self-heals)
dashboard-rs/target/release/claudehq --uninstall   # removes it
dashboard-rs/target/release/claudehq --print-plist # preview the LaunchAgent, no side effects
```

Once installed you never start it by hand again: just open <http://127.0.0.1:8765>.

Optional shell alias:
```bash
echo 'alias claude-hq="$HOME/claude-hq/dashboard-rs/target/release/claudehq"' >> ~/.zshrc   # your clone's path
```

### Update

- **In the app:** the **Update** button in the top bar shows when new commits are waiting ("Update · 3 new").
  It only fast-forwards (it refuses if you have local edits or your branch has diverged), rebuilds `claudehq` when
  `dashboard-rs/` changed, restarts the server and reloads every open tab. A failed build keeps the old server
  running and tells you what to run.
- **By hand:** the LaunchAgent runs the code as it is on disk. Frontend changes (`index.html`, `ui/`, `games/`)
  are picked up on refresh; after changing `dashboard-rs/`, rebuild and reload it:
  ```bash
  git pull --ff-only
  cargo build --release --locked --manifest-path dashboard-rs/Cargo.toml
  launchctl kickstart -k gui/$(id -u)/com.claudehq.dashboard
  ```

### Optional: HQ Notch (macOS)

Your party in the Mac's notch: each live session as its HQ Pokémon, a live tool ticker, and
**Allow / Always / Deny** for permission prompts plus answers to `AskUserQuestion`, right from the notch.
```bash
python3 notch/tools/install.py      # builds with the Command Line Tools, adds Claude Code hooks (backed up)
```
HQ also offers to install it once on a Mac without it (**Settings › HQ Notch** or Cmd-K reopens the dialog).
See [`notch/README.md`](notch/README.md). `--uninstall` removes it all again.

---

## ✨ Features

Press **?** in the app for the full keyboard-shortcut and feature guide. View keys: **H** HQ, **1** Live,
**2** Analytics, **3** Pokédex, **4** Gym, **5** Quests, **6** Arena, **7** Village, **8** Store, **9** Cali Tuesdays,
**0** Valley, **W** Workshop, **C** Compete, **J** Music.

### Mission Control and the 3D HQ

- **The 3D HQ** (**H**): Mission Control as a room you walk around. Every live session is a crew member at a console
  (typing when working, waving when it needs you, dozing when idle); recently away sessions are empty desks.
- Click a crew member for their card, a project on the holo-table to show only its crew, or a door to the Lab,
  Gym, Quest Board, Shop, Trophy Hall, Valley or Arena. A crew list beside it does the same from the keyboard.
- **Base and lobby:** your HQ is a tower on a plaza that grows with your HQ level; walk in through reception.
  A **B1 basement garage** holds your vehicles on lit turntable plinths, reached by a lobby lift or the car lift.
- **HQ Studio** (Settings, Cmd-K or the lobby kiosk): style your tower (facade, colours, crown, entrance, sign,
  night lights, grounds), a double-height lobby and each floor, and place decor on a grid with a live 3D preview.
- **Rooftop helideck** on every tower with your helicopter parked on it; land on any HQ and take the roof lift down.
- **One switch** (header button or **H**) flips between the 3D HQ and the classic dashboard; Calm mode or reduced
  motion opens the classic view.
- **Your 3D character** (Settings › Character): body, colours, hair, headwear, accessories and a cyberpunk set, with a
  live preview. It becomes your portrait on the Trainer card and, with the Arena on, everywhere friends see you.

### Live

- Live cards for every session, grouped **Needs you → Working → Idle → Stale**, updated in real time over
  Server-Sent Events (with a polling fallback).
- **Cursor sessions** next to Claude Code: agent chats Cursor saved under `~/.cursor/projects` get a Cursor badge
  and the chat's own title. Cursor writes no token totals, so their cost shows as zero.
- **Needs you, for real:** an unanswered question or plan approval marks a tab; a long-open permission-gated tool
  shows a "permission?" hint.
- Per card: current tool, first and latest prompt, last reply, tokens and cost, a 24 h sparkline, tags and notes.
- **Actions:** Resume (a new terminal into `claude --resume <id>`), Reveal in Finder, Focus mode, Close (stops the
  process), Rename, Pin.
- **Archived history:** every past transcript shows as a Stale card, searchable and re-openable.

### Search and session detail

- Full-history **search** across every transcript (TF-IDF ranked).
- A detail **drawer** with a live-tailing timeline, files touched, tokens and cost, session history, notes and tags,
  the creature's evolution line, and a **full transcript reader** with in-transcript search and Markdown export.

### Analytics

- A 13-week **contribution heatmap** (click a day for its digest), token and cost trends, busiest hours and
  day-of-week charts, tool breakdown, folder leaderboard and a **Hall of Fame**.
- **Account & Usage:** cost by model and by project, and a daily cost budget alert.
- **Insights** (auto-generated, last 30 days), a **project deep-dive** per project, and the **Daily Digest**
  ("what I did across all sessions today", Markdown export), plus a weekly digest and an event log.
- Exports: `/api/export.json` and `/api/export.csv`.

### Creatures: Pokédex, Gym, Quests and Trainer

- Every session maps stably to one of **48 creatures** that **evolve** through real evolution lines as it grows,
  with elemental **types**, rare **shiny** variants (seeded per install) and branch and Mega picks.
- **New Game+:** a new session of a species you already evolved starts at that form.
- **Pokédex** collection view, **⚔️ Gym** team type-matchup analyzer (the real 18-type chart), **🏅 Quests**,
  a **Trainer Card**, XP and levels, achievements and confetti.
- **🔥 Flexible streaks:** a streak survives a quiet day or two and breaks only when you're inactive on 3 days within
  any 7. The Arena leaderboard uses the same rule.
- **⚡ Creature energy:** creatures tire after long unbroken runs and recover on a break. Cosmetic only; it can be
  turned off.
- **Creature packs:** pokemon, pokemon3d, aniimo, Clash of Clans (troops level up through their real levels),
  village, and the 100% offline generated **monsters** pack. Every hotlinked sprite falls back to a drawn one.
- **Progress from real work** (opt-in): loot chests from merged PRs, green test runs and long focus sessions, a
  seven-branch **skill tree**, **prestige** stars at level 50 and a six-chapter **story campaign**.

### Village

- A base driven by your real stats (key **7**): a Town Hall, resources, the **Army Camp** listing every session's
  troop, the Builder Base of your projects, a War Log and **Muster & Raid**.
- **Overflow Vial:** an Apex creature banks surplus XP into a local ledger (each drop expires after 24 h) that you
  spend to lift another species a stage.

### Store and Cali Tuesdays

- **🏪 The General Store** (key **8**): an original pixel-art shop with 21 foods, seasonal stock, a daily special,
  a shopkeeper who chats (and dozes after 11 pm), a shop cat, and a bag you feed creatures from.
- **🪙 Poke Coins** (with the Arena): 5 a day, spent in the Store, gifted to friends, or used for chips at the casino.
- **🌮 Cali Tuesdays** (key **9**): a retro pixel-art taqueria for logging Taco Tuesday. Seat friends (`@` picks them
  from the Arena), drag food onto plates, check out with the pooled buy-1-get-1, and climb the monthly hi-score board.

### The Valley (games)

Key **0**. A "play while you wait" pill appears while tabs work, and a game pauses the moment a tab needs you.

- **Solo:** a pixel-art fishing pond (16 real species), a garden your prompts water, a bundles board, the Mines,
  **Pokémon-style Creature Battles** (real species, stats, moves and type chart), a daily code puzzle, townsfolk,
  a monthly fishing derby and the Bug Blaster arcade.
- **3D games:** **Mini Golf** (five courses, 25 holes, Play random), **Kart Racing** (nine tracks), **Platformer
  Rush**, **Blaster Arena**, **Strikezone** (a team shooter with bots, two maps, totems, disasters and The Warden),
  **Valley Rally** (off-road stages with a detailed car model), **Tower Defense**, **Bowling** and **Grand Prix**
  (time trials on every 2026 F1 circuit and 17 classics).
- **With friends in an Arena room** (up to 8): a shared fishing dock, a puzzle race, the live Creature Duel, co-op
  Mines, a shared farm, Mini Golf, Kart, Platformer race or co-op, Blaster, Strikezone, Rally, Tower Defense,
  Bowling, a **Code Typing Race** and **Party Mode**. **Quick Play** matches you into a room, crewmates first.
- The server referees every multiplayer game; your own moves show instantly, others are interpolated, and a dropped
  connection rejoins by itself.

### Workshop and Compete

- **Workshop** (key **W**): editors for **kart tracks**, **Platformer levels** and **Blaster arenas** that check them
  live; test, save, and race or play them in a room.
- **Map gallery:** publish to your room or to everyone; browse newest, most liked and hot this week; like, report,
  remix, "Race in room". Each map has its own leaderboard and a **map of the week** per game.
- **Compete** (key **C**): a **weekly cup** per game from normal multiplayer races, a monthly season podium, cup
  trophies, and a weekly **world boss** everyone wears down with merged PRs and wins, then fights with a Pokémon team.

### Music

- **Music** view (key **J**): **Now Playing** from Spotify, Apple Music or a YouTube Music tab, shared with friends
  while paired (on by default; off in Music or Settings).
- **Listening rooms:** a shared YouTube queue per Arena room, kept in sync; with `yt-dlp`, each listener's HQ plays
  the room's song from `127.0.0.1`.
- **Go live:** stream a tab's or your Mac's audio browser to browser (WebRTC) to up to 12 listeners.
- A DJ visualiser (bars, ring or wave), and in the City a **boombox** on your shoulder that people nearby hear.

### Arena social

With the [Arena](#-arena-multiplayer--optional) connected: a shared leaderboard with seasons and **Standings**
(players or accounts), crews with invite codes and banners, a lobby chat with @-mentions, nudges, lobby **voice and
video** with screen sharing (a floating call overlay on every view), private rooms, live HQ presence (visit friends'
open HQs), cosmetics and a market, and an opt-in **account board** for people on the same Claude account.

### The 3D City

Open it from the HQ (**Jump to City**) or Cmd-K. Every world is generated by the Arena; see
[The 3D City and City Gen v4](#️-the-3d-city-and-city-gen-v4) for how.

**Your HQ and vehicles**
- Your HQ tower stands on its own lot, a grand podium, setback tiers, wings at levels 10 and 30, night lights and
  a helideck, styled in HQ Studio. Visitors see your style, pets in the lobby and your garage.
- **Dealership** in every city: real cars and bikes (BMW, Bugatti, KTM, Lamborghini, Royal Enfield,
  Harley-Davidson, Kawasaki, Suzuki, Ducati, Yamaha, Triumph and the 2026 Formula 1 grid), all free, driving to
  their real specs. A 3-minute test drive, then **Get it**.
- **Garages:** a multi-storey garage per city and your private B1 basement; a garage manager moves vehicles between
  them. **C** calls a vehicle, which drives itself to you. You can **move your garage's car-lift bay** on your lot.
- **Redline Tuning:** paint and finishes, rims, tint, wings, exhausts that change the engine note, and your own plate.
- **Driving:** a real gearbox (manual or automatic, rev-matched downshifts, clutch, launch control, quickshifters),
  drive modes, nitrous, burnouts, wheelies, a 0–100 timer, headlights at night and grip that drops in rain and snow.
  Opt-in damage (Settings › Vehicle damage). **I** is an autopilot for anything you drive, sail or fly.
- **Engine sound** built like the real engine: firing frequency, cylinder layout, exhaust character and the real rpm.
- **Convoys** (**Y**), **carpooling** and pillion seats (**E** beside a driver), a **tank for four** (**K**) and a
  **grenade launcher** (**X**). Other players and traffic are solid.

**Getting around** (all free)
- **Buses and trams** you board and ride in a seat, with live departure boards; street trams run on their own
  tram roads with stations.
- A **metro** in real tunnels (M1 and M2 crossing at Central) with underground stations, stairs, escalators and lifts.
- The elevated **City Line** over its own boulevard, the **Island Link** train from every island to the Commons, and
  rail lines between islands.
- A **gondola**, **water buses**, a lake launch, **water taxis**, **boat hire** (pedalo, rowboat, kayak), **ferries**
  between cities (the next city loads on the way), and the cruise ship *Claude Serenade* and container ships.
- **Claude Cabs** (ride, or drive fares for a score) and a helicopter you call.
- **Flying:** helicopters from your roof, hospitals and the air base; a seaplane and a prop plane; a narrow-body
  airliner and a regional jet you fly yourself; booked jets between airports; the Isle Hopper amphibian.
- **Finding your way:** a minimap, the big map (**M**), **Go to** (**N**) with turn-by-turn directions, air
  navigation with glideslopes, and seat cameras (**V**).
- **Mouse steering** (camera settings), and **F** to interact, **E** to get on and off.

**City life**
- Every building has a use and a ground floor: shopfronts, cafes, lobbies, loading bays; windows light by use and hour.
- Residents commute, work, lunch, queue, jog, crowd the stadium on Saturdays and parade on Sundays; a street market on
  Wednesdays and Saturdays and weekday roadworks close their streets, the same for everyone.
- Traffic follows the hour and drives on the left, stops at traffic lights and give-way lines, and goes round
  roundabouts. The **NPC traffic** slider sets how much.
- **Live weather and time** from Koramangala, Bengaluru: IST for everyone, real sunrise and sunset, and rain,
  storms, haze, wind and bad-air days from the hourly reading. Without it, a made-up forecast (with snow and fog).
- Landmark towers, an airport with a timetable everyone shares, an air base with a carrier, opening bridges.

**Things to do**
- **Jobs** (taxi fares, parcels, van runs) for City rep, **Races** with ghosts, **Finds** (tokens, graffiti tags, rare
  stalls, weekly photo challenges), and wanted stars with police chases.
- **Arena play** (invite only): a shared job, Cops & robber, or racing a friend's ghost.
- **Skyline Park:** a coaster ridden first person, a Ferris wheel, a drop tower, a carousel, a wave swinger and the
  Storm Galleon; fireworks after dark and a dancing fountain.
- **Stunts** in every city: Sky Cannons, Big Air, a Mega Loop, River Leaps and a Sea Launch.
- **The Lucky Byte casino** (eleven games for Poke Coins, drawn on the Arena) with a player-vs-player Duel Table.
- A **Grand Prix Circuit** into the Valley's Grand Prix, a skatepark with a weekly Skate board, and a bike park.

**Phone, messages and calls**
- **The phone** (Backquote, or **I** on foot in the City): Tickets, Departures, the Transit map, Claude Cabs, Vehicles, the
  Dealership, Messages, Nearby, Phone, Camera, Gallery, Achievements, Patch notes and Settings.
- Opt-in **text messages**, **nearby chat** and **calls** to other players; photos stay on this machine.

**Pets**
- Adopt dogs, cats, dinosaurs, dragons and a sea serpent at **Paws & Claws** or the Pets panel; up to 6, two out
  with you. Fetch, petting, tricks, and dragon breath by element; the rest live in your lobby.
- **🐉 Ride your pets:** a dragon flies (**W/S** speed, **A/D** bank, **Space** climb, **Shift** dive, **F**
  breath), a big dinosaur walks and runs, the sea serpent swims. **E** gets on and off.

### The archipelago and islands

- **The Commons** is a shared organic city on its own island with an offshore airport, an air base, Skyline Park and
  every open HQ.
- **Your own island:** a personal city with your HQ by the town hall. Visitors walk, ride, shop and trade; you choose
  who may visit (everyone in your Arena, your crew, or nobody). Every city runs at its highest tier.
- **Town Hall:** the city's tier, growth, population, treasury, tax, specialty good and its market, with prices
  that move every hour.
- Travel between cities by ferry, ship, rail, plane, seaplane or fast travel; **My island** / **The Commons**
  switches directly.

### HQ Notch

- Your live sessions as HQ Pokémon in the Mac's notch, animated by state, with titles, the current tool and a ticker.
- **Allow / Always / Deny / Terminal** for permission prompts, answers to `AskUserQuestion`, plan cards and a diff
  view; click a card to focus its terminal window. Opt-in phone alerts via ntfy with fixed, content-free text.

### Quality of life and accessibility

- Command palette (⌘/Ctrl-K), keyboard shortcuts (`?` help, `/` search, `r` refresh), desktop notifications, an
  optional chime and voice alerts when a tab needs you.
- A **War Room** big-screen view, a **Focus Pomodoro** timer, a "welcome back" recap, a soundboard, and an
  installable PWA.
- Accessibility: skip link, ARIA roles and live regions, roving-tabindex grid navigation, focus trapping, large
  text, and **Calm** mode (reduced motion) honoured everywhere, including the 3D City.

---

## 🏙️ The 3D City and City Gen v4

The Arena generates every world from a seed (`backend/src/worldgen/`): the Commons (`claude-hq@3`) and each player's
island (`user:<id>@3`). Every page builds the same world from the same document, so everyone sees the same streets,
lots, lights and timetables. City Gen v4 rebuilt the generator a phase at a time (3.24.0 to 3.35.0) so roads,
transit and lots are planned like a real city. The detail is in [docs/plans/city-gen-v4.md](docs/plans/city-gen-v4.md).

- **Land first:** the airport claims its land (terminal, airside, runway safety zones) before any road is laid.
- **Road classes:** expressways (29 m, three lanes each way, hard shoulders, a crash barrier), the 36.5 m boulevard,
  avenues (22 m with a raised median), collectors (12 m), local streets (10.5 m), lanes (9 m) and shared streets
  (9.5 m, pavers, no lines). A street changes class one step at a time.
- **Junctions by road pair:** give-way lines where side streets meet, mini roundabouts for collectors and five-arm
  junctions, full roundabouts only where a 32 m circle fits, and traffic lights where main roads cross.
- **Curves:** the Ring Road and highways sweep in smooth curves; bends in town streets are arcs within the kerb.
- **Capacity:** each road has a comfortable level (at most 22 cars a km of lane at 100%) and a hard limit of one car
  per 7.5 m of lane. The NPC traffic slider (85% usual) changes the open City at once.
- **Interchanges:** trumpet interchanges where a highway meets the Ring Road, with flyovers, loop ramps and slip roads
  you can drive (ramp grades of 6% or less, 7 m clearance under every deck).
- **The tunnel:** the Ring Road drops into a cutting and runs through a 300 m cut-and-cover tunnel under the airport.
- **The City Line boulevard:** a 36.5 m boulevard under the elevated line, with the viaduct's piers in its planted
  median and T junctions at least 50 m apart.
- **Tram roads and stations:** trams run on a raised, kerbed bed down avenues and collectors and share the inner lane
  on narrower roads. Stations have 40 m platforms with a shelter, ticket machine and departure board. From 3.35.0
  routes follow the main desire lines between districts, with stations about 600 m apart.
- **Movable garages:** you can move your HQ's car-lift bay anywhere on your lot that keeps 8 m clear in front of its
  door and a way out to the street.
- **HQ spacing (3.35.0):** HQs are spread by a minimum gap, front local streets or collectors only and sit near a stop;
  each lot holds the tower, garage, apron and driveway. HQs move to new lots with this update.
- **Graphics budgets:** at most 1,200 draw calls a frame above ground and 240 below, sized for an M3 Pro and up, with
  road markings, planted medians, deck detail and tunnel lighting inside them. `tools/graphics_tour.py` checks them
  at eleven places in CI and in the release check.
- **Sound:** every world sound plays where it is (inverse-distance falloff, silent past each kind's maximum, panned
  left or right, only the nearest few of each kind), under the **Ambient sounds** slider.
- **The validator** (`cargo run --release --bin worldgen -- claude-hq@3 --validate`) checks every generated world
  in CI.

---

## 🔒 Privacy & security

Your transcripts never leave your machine: prompts, replies, tool input and output, file paths, project and folder
names, session ids and titles stay local. [AGENTS.md](AGENTS.md) (invariant 2) is the authority on what may be sent.

**The local server**
- Binds to **`127.0.0.1` only**; any request with a non-localhost `Host` header is rejected with `403`.
- All state-changing actions (rename / pin / close / resume / settings) require a per-process **CSRF token**
  (injected into the page, sent as `X-HQ-Token`) plus an Origin / `Sec-Fetch-Site` check.
- File lookups are validated (UUID / known-folder allowlists): no path traversal.
- **Close** only signals a pid that `claude agents` lists as a live interactive session (and whose command is still
  `claude`), never the dashboard itself or an arbitrary process. If the session list cannot be read (e.g. the
  `claude` CLI is missing), Close is refused with `503`.
- POST bodies are capped at 1 MiB (8 MiB for soundboard uploads); larger requests get `413` (sent without reading
  the body, so a client mid-upload may see a connection reset instead).
- Local state files (`config.json`, `sessions-meta.json`, `evo-choices.json`, `arena-link.json`, `.dex-seed`) are
  written atomically with `0600` permissions. A file that no longer parses is set aside as
  `<name>.corrupt-<timestamp>` (git-ignored) and defaults are used, so nothing is silently overwritten. A symlinked
  state file is written through (the link is kept, the target replaced).
- Your transcripts and settings stay on disk. `config.json` and `sessions-meta.json` are git-ignored.
- Every other `fetch` / `EventSource` in the page targets local `/api/...`.

**What can leave the machine.** Everything below is listed in full; nothing else is sent.
- **Sprites.** Some creature packs load images from public sprite libraries: the "pokemon"/"aniimo" packs by creature
  id, the "Clash of Clans" pack by troop name and level number. The URL carries only a non-reversible
  `hash(sessionId)%48` slug, never your data. Since 3.13.3 the local server fetches them (`/api/sprite`, a strict
  allowlist of four sprite hosts, images only) and caches them in `.sprite-cache/`. Use the "monsters" pack for
  100% offline.
- **The Update check** runs `git fetch` against your own remote.
- **HQ Notch (optional)** talks to Claude Code only through a local Unix socket (`0700` dir, `0600` socket, peer uid
  checked). Its only network requests are HQ's existing sprite hotlinks (a National Dex number in the URL) and HQ
  itself on `127.0.0.1`. If the notch is closed or never answers, every hook prints nothing and Claude Code asks in
  the terminal as usual. Its opt-in phone alerts (ntfy) send fixed, content-free text only.
- **Arena is off by default.** When enabled it publishes daily *counts* only (never conversation content, file paths
  or project names), and its device token lives in `arena-link.json`, outside `config.json`, so it is never served
  to the page. The full list of what it shares is under [Arena › What is shared](#what-is-shared). On top of the
  counts, these channels go only to the paired Arena (or where named), and only while you use the feature:
  - **Music (2.2):** the Now Playing track (`music.TRACK_KEYS` only: title, artist, album, app, Spotify/YouTube id,
    length, position) over the paired Arena link, **on by default while paired** (turn it off in Music or Settings); YouTube search / oEmbed from this machine; the YouTube embed or a
    `yt-dlp` fetch of the room's song when someone uses a listening room (opt-in: yt-dlp may read one browser's
    YouTube cookies, `musicCookies`, sent only to youtube.com, never stored by HQ); WebRTC audio between browsers
    when someone goes live. The boombox (3.11) puts your room song's YouTube id, start time and title in your City
    presence. None of it reads transcripts.
  - **3D character (2.4):** the character spec (ten small numbers, `look` in HQ presence) and its portrait PNG
    (`/v1/me/portrait`), both made from your own Settings choices.
  - **Work signals (2.5, off by default):** seven skill-category counts per UTC day (`/v1/skills/report`) and loot
    events `{requestId, type, n, day}` with type `tests_green` / `focus_long` / `pr_merged` (`/v1/loot/events`), only
    when `workSignals` is on (PRs also need `workSignalsPRs`; `gh` runs locally and only salted URL hashes are kept,
    locally). Classification returns integers per category only.
  - **Maps and boss fights (2.5):** a map you publish or start a room on (geometry and the name you typed,
    `{kind, name, data, scope, roomId?}`, max 12 KB); a boss-fight team as species/stage numbers.
  - **Account board (2.6.3, off by default):** `sha256("claude-hq:account:v1:" + accountUuid)` from `.claude.json`,
    nothing else from that file, sent to `/v1/me/account` and stored by the Arena only as an HMAC.
  - **City presence and proxies (3.0 onward):** your position, pose and what you ride or drive (vehicle catalogue
    id, paint index, tuning `vt`), pets out with you (species, colours, accessories, growth numbers and the name you
    typed), convoy and carpool user ids (`ci`/`cv`/`cg`, `pb`/`ps`), grenade and tank shots, a pet ride, and
    validated ids and amounts for the city, market, rail, vehicles, casino (game, bet, pick, duel id) and park
    routes. Presence `a = 15` (riding transit) carries only a mode code `tk` and a vehicle id `tv`.
  - **Messages, nearby chat and calls (3.18, opt-in to send):** **SMS** (`/v1/sms/*` via `/api/arena/sms/*`: at most
    160 characters you typed plus the recipient's user id; sending needs a one-time opt-in held by the Arena; the
    Arena erases the text on delivery, keeps undelivered messages 7 days, and a block is silent to the sender),
    **nearby chat** (at most 200 typed characters, only with Nearby on, relayed only to opted-in players within 40 m
    on the same floor, never stored) and **calls** (the ring and WebRTC setup to the one person you call, with Calls
    on; audio peer to peer). Notifications never show message text unless Messages is open, and screen-reader
    announcements give counts only.
  - **Arena play (3.22, the `cityplay` capability, invite-based):** presence `pk` (the game 1–3), `pi` / `pj` (a user
    id you invite / whose game you joined) and `pq` (at most 12 whole numbers: a shared job's kind, step and footpath
    points, the robber's stars and clock, a race route's hash and best time), and one directed `ghost` frame (a route
    id, your own run's positions in at most 12,000 characters of `[0-9a-z,-]`, its time) relayed to that one player
    only, 6 a minute, never stored.
  - **HQ Studio (3.15):** only your style document (enum keys, `#rrggbb` colours, grid cells; `/v1/hq/me/style` via
    `/api/arena/hq/style`).
  - **Movable garages (3.33):** four small integers about your own HQ lot, `{lot, x, z, r}` (the lot's rank, the
    bay's position inside it in decimetres, its quarter turns), to `/v1/hq/me/garage` via
    `POST /api/arena/hq/garage` (`/reset` clears it; the body is rebuilt from that allowlist), shown to visitors as
    `garage` in the HQ listing.
- **Live weather (3.23):** the **Arena server**, not your machine, fetches one fixed place's reading (Koramangala,
  Bengaluru, by latitude and longitude) from Zomato's Weather Union at the start of every hour with the server's own
  key (`WEATHERUNION_API_KEY` in the host's `backend/.env`, never logged or sent to a player). The page reads it only
  through local `/api/arena/weather`, which forwards just the device token. No player data goes into the request.
- **Stays on this machine:** phone photos (IndexedDB), speech synthesis (only voices with `localService === true`),
  creature energy, `meals.json`, the Overflow Vial, jobs, rep, races and finds, and your Valley save.

Nothing from your transcripts goes into any of the above.

---

## 🏆 Arena (multiplayer) — optional

Claude HQ is local-first and stays that way. **Arena** is an opt-in layer that adds a shared leaderboard across you
and your friends, a lobby chat and a voice and video channel with everyone who has Arena open, websocket rooms for
the Valley games, and the shared 3D City. It is off until you connect it.

### What is shared

Your dashboard keeps reading transcripts locally and publishes **daily counts only**: prompts, tool calls,
artifacts, tokens. It never sends prompt text, replies, file paths, project or folder names, session ids, or titles.

- **Tool names are allowlisted.** MCP tools are named `mcp__<server>__<tool>` and routinely carry an employer's or
  client's name, so anything that isn't a built-in Claude Code tool is bucketed as `Other` before it reaches the wire.
- **Cost sharing is off by default.** Spend is salary- and employer-adjacent.
- **The skate board is two numbers.** When a combo in Arena City's skatepark beats your best for the week, the page
  sends its total and how many tricks it chained (checked by the HQ server, then by the Arena). Nothing about where,
  when or from which session.
- **Chat is only what you type.** Messages in the lobby chat go to everyone in the lobby, relayed by the server. It
  keeps the last 50 in memory (never on disk) so people who join can catch up; they're gone when the lobby empties
  or the server restarts. The server also cleans and caps messages (500 characters) and rate-limits them (8 per 10
  seconds per connection).
- **Voice and video are peer-to-peer.** Audio and video go straight between browsers (WebRTC), never through the
  server. The server relays only the connection setup, which includes IP addresses, and only to the people you're in
  voice with; a public STUN server (Google's) tells your browser its public address. Your microphone is used only
  after you click **Join voice** and your camera only after you click **Camera**; both stop when you leave.
- **Live status is off by default.** Turn on **Share my live status** and your lobby entry shows how many of your
  sessions are working and how many are waiting on you: just those two numbers, never titles, folders or text.
- **You're in the lobby while HQ is open.** So friends see you online and chat and calls reach you on any view. Turn
  off **Stay in the lobby on every view** to show up only while the Arena tab is open.
- **Poke Coins and snacks live on the server**: it sees what you buy, eat or give (kind, amount, recipient, an
  optional note), never which session ate it. That stays on this machine, in `meals.json`. Creature energy itself is
  computed locally and is never shared.
- **Valley games send only moves.** In a multiplayer Valley game your browser sends casts, reels, puzzle guesses,
  battle picks, your team as species numbers and species names, golf shots and your golfer's position on the course,
  race and game positions. The server keeps game state in memory (the shared farm is stored) and never sees session
  titles, prompts or project names.
- **Pets are what you chose for them.** With an Arena that has pets, your pets live there: species, colours,
  accessories, affection and the names you typed for them (checked and word-filtered by the server). The pets out
  with you ride in your presence (species, colour, accessory and growth numbers and the name, at most two), and
  visitors to your open HQ see the ones in your lobby. Without one, pets live only in this browser. Nothing about
  your sessions goes into them.
- **Messages, nearby chat and calls are only what you type, and only when you opt in (3.18).** Text messages carry
  at most 160 characters you typed and the recipient's id; you send only after a one-time opt-in, anyone can block or
  mute you, and the Arena erases a message's text once it is delivered (undelivered ones go after 7 days). Nearby
  chat (at most 200 characters, with Nearby on) reaches only players within 40 m in the same city who turned it on,
  and is never stored. Calls (with Calls on) send the ring and the WebRTC setup to the one person you call; the
  audio goes browser to browser.
- **HQ Studio and movable garages.** HQ Studio sends only your style document (enum keys, colours, grid cells).
  Moving your HQ's garage bay sends four small integers about your own HQ lot, `{lot, x, z, r}`; others see it on
  your lot. See [Privacy & security](#-privacy--security) for the full list of opt-in channels.
- The wire format rejects unknown fields outright, so a future client change can't silently start leaking one.

Scores are computed on the server from raw counts, not submitted by the client, so the formula can change without a
client release. Casino outcomes and market trades are decided on the server too.

### Connecting

Everyone points their own Claude HQ at a hosted Arena: **🏆 Arena → server URL → Sign in with GitHub → paste the
pairing code**. Your device token is stored in `arena-link.json` (git-ignored) and is never exposed to the page.

### Self-hosting

One person hosts the backend once, on any VPS with Docker and a domain pointed at it:

```bash
sudo ARENA_DOMAIN=arena.example.com bash deploy-vps.sh   # Docker + Caddy (automatic TLS)
```

It asks for your GitHub OAuth app's client id and secret and writes `backend/.env`. Later releases go through
`ops/release.sh deploy` (waits for CI, builds the image, health-checks, rolls back on failure; `ops/release.sh
rollback` and `status` too), the deploy panel (`ops/install-panel.sh`) or pull-based auto-deploy
(`ops/install-autodeploy.sh`). Live weather needs `WEATHERUNION_API_KEY` in `backend/.env`.

- `backend/`: the Arena server (Rust, axum + sqlx). It owns the schema through `backend/migrations/`, applied at
  startup, the game referees in `backend/src/valley/` and the world generator in `backend/src/worldgen/`. Source,
  API and design notes: [`backend/README.md`](backend/README.md).
- `ops/`: release, rollback, deploy panel, auto-deploy and monitoring scripts.
- `tools/local_arena.sh`: a local dev Arena for testing against your own HQ.

---

## 🎨 Configuration and customization

Open **⚙️ Settings** in the app. Settings are saved to `config.json` (some 3D City settings only in this browser).

- **Look:** themes (Aurora / Midnight / Forest / Mono + High-contrast), accent colour, creature pack, Trainer name,
  your 3D character, and HQ Studio for your tower, lobby and floors.
- **Accessibility:** large text and Calm mode (reduced motion and effects).
- **Fleet:** refresh cadence, stuck-tab threshold and a daily cost budget.
- **Sound:** Game sounds (master volume), **Ambient sounds** 0–100% (thunder, rain, fireworks, aircraft, water,
  fountains, roadworks, bells and the city's hum; 0% is off) and the soundboard.
- **3D City:** **NPC traffic** 0–100% (85% usual), Vehicle damage (off by default), and mouse steering in the camera
  settings.
- **Creatures and pets:** creature energy on or off, and your pets.
- **Music:** share what I play; which browser's YouTube login yt-dlp may use for room songs (off by default).
- **Arena:** work signals (and PRs) and the account board in Settings; live status and staying in the lobby on every
  view in the Arena tab; messages, nearby chat and calls in the phone.
- **HQ Notch:** install or check it.

---

## 🗂️ Files and the HTTP API

| File | What |
|---|---|
| `dashboard-rs/` | The HQ server (`claudehq`, Rust): reads live agents + transcripts, serves the JSON API and the page, and is the Arena client. |
| `index.html` + `ui/` | The frontend: the page template and its CSS and script, split by area in `ui/` and stitched into one page by the server (no build step). |
| `games/` | The Valley games and the 3D HQ and City (three.js vendored in `games/vendor/`, assets with their licences). |
| `notch/` | Optional macOS notch companion (SwiftUI app + stdlib hook relay + installer). |
| `backend/` | Optional Arena server (Rust). Only needed by whoever hosts it. |
| `ops/`, `deploy-vps.sh` | Arena hosting: release, rollback, deploy panel, auto-deploy. |
| `tools/` | Smoke tests, tours, the local Arena and data builders. |
| `docs/plans/` | Design plans, including [City Gen v4](docs/plans/city-gen-v4.md). |
| `arena-link.json` | Your Arena device token. *(git-ignored)* |
| `config.json` | Your settings (theme, pack, budget, …). Created on first save. *(git-ignored)* |
| `sessions-meta.json` | Per-session pins / tags / notes / rename aliases. *(git-ignored)* |
| `meals.json` | Which session ate which snack (local only). *(git-ignored)* |
| `evo-choices.json` | The branch / Mega form you picked per session (local only; `POST /api/evo-choice`). *(git-ignored)* |
| `vial.json`, `games-save.json` | The Overflow Vial ledger and your Valley progress (local only). *(git-ignored)* |
| `.sprite-cache/`, `.music-cache/` | Cached sprites and room songs. *(git-ignored)* |

### HTTP API (all `127.0.0.1` only)

`GET /` · `GET /api/sessions` · `GET /api/stream` (SSE) · `GET /api/session/<id>` ·
`GET /api/session/<id>/export.md` · `GET /api/transcript/<id>?offset&limit&q` · `GET /api/search?q=` ·
`GET /api/history` · `GET /api/project?folder=` · `GET /api/pokedex` · `GET /api/digest?date&download` ·
`GET /api/config` · `GET /api/meta` · `GET /api/export.{json,csv}` · `GET /api/arena/pantry` ·
`GET /api/arena/cali/board?window={season,30d,7d,all,lastseason}` · `GET /api/arena/cali/orders` ·
`POST /api/action` · `POST /api/config` · `POST /api/meta` · `POST /api/evo-choice` ·
`POST /api/arena/pantry/{claim,buy,eat,give}` · `POST /api/arena/cali/order` ·
`GET /api/arena/hq/garage` · `POST /api/arena/hq/garage` · `POST /api/arena/hq/garage/reset`
(all POSTs CSRF-guarded).

Also served locally: `/api/sprite` (the sprite cache), `/api/notch/{status,install}`, `/api/insights`,
`/api/music/*`, `/api/arena/weather`, and the `/api/arena/...` proxies to the paired Arena (city, world, market,
rail, vehicles, casino, SMS, pets, HQ style and more). Each proxy validates its ids against an allowlist and
rebuilds request bodies from allowlisted keys.

---

## 🛠️ Development

Read [AGENTS.md](AGENTS.md) (the non-negotiable invariants) and [CONTRIBUTING.md](CONTRIBUTING.md) before your first
change.

- **No build step for the page.** Plain `.html` / `.css` / `.js` served as-is; no npm, bundler, transpiler or external
  JS/CSS libraries (vendored three.js in `games/vendor/` is the one documented exception). The servers are Rust.
- **Before a PR:** `ops/release.sh check` runs the repo tests, then `cargo test` and clippy in `backend/` and
  `dashboard-rs/`. CI runs the same plus the deploy image build.
- **Tests:** `python3 -m unittest discover -s tests -q` (repo tests, stdlib only); `cargo test` in `backend/` and
  `dashboard-rs/`.
- **UI smoke:** `python3 tools/ui_smoke.py` starts `claudehq` against a throwaway folder and a fake Arena, loads the
  page in headless Chrome, and walks the 3D City. Use it for any UI change.
- **Graphics tour:** `python3 tools/graphics_tour.py` checks the frame budgets (1,200 draw calls above ground, 240
  below) at eleven places in the City and saves a screenshot of each. `tools/transit_tour.py` does the same for
  transit.
- **World generator:** `cargo run --release --bin worldgen -- claude-hq@3 --validate` in `backend/` prints the
  validator's report.
- **Local Arena:** `tools/local_arena.sh` runs a dev Arena on loopback.
- **Releases:** bump `APP_VERSION` in `dashboard-rs/src/app.rs`, `version` in `dashboard-rs/Cargo.toml` and the
  `**Version X**` line at the top of this README together (a test checks they agree), and add an entry to
  [CHANGELOG.md](CHANGELOG.md). Call out anything that touches privacy, egress, security or third-party assets.

---

## 📜 Changelog

The full history is in [CHANGELOG.md](CHANGELOG.md). Recent releases:

- **3.36.0** — The city rebuilt: walk-in Metro with stairs and lifts, towers and a skyline, an amusement park in every v4 city.
- **3.35.0** — City Gen v4 final: the ambient slider and positional sound, HQ spacing, desire-line tram routes.
- **3.34.0** — The graphics pass: road markings, planted medians, deck and tunnel detail, 1,200 / 240 draw-call budgets.
- **3.33.0** — Move your garage's car-lift bay on your lot; others see it there.
- **3.32.0** — Trams on their own raised tram roads, with 40 m station platforms.
- **3.31.0** — The City Line over its own 36.5 m boulevard, piers in the median.

---

## Contributors

Thanks to everyone who has contributed to Claude HQ:

- [@RoString36222](https://github.com/RoString36222) — creator & maintainer (fleet view, search,
  analytics, digests, the creature / evolution / Mega system, the Village, the Valley games, the
  3D HQ and Arena City, HQ Notch, and the HQ 2.x releases)
- [@hetnxik](https://github.com/hetnxik) (Het Naik) — the Arena (#2): multiplayer leaderboard,
  seasons and game rooms; self-hosting and ops (docker-compose + Caddy, VPS bootstrap, the
  containerized deploy panel, pull-based auto-deploy and the deploy console, #23–#38, #94–#111);
  Cali Tuesdays (#36); the Rust Arena (#90–#93) and the Rust HQ server `dashboard-rs` (#109);
  Arena City on a grid (#110); the Rust-only backend restructure (#117, #119); and HQ 3: the 3D Arena
  City, Cities with your own island, navigation and rivers, and the transport network (#125, #126)
- [@SwastikTripathi](https://github.com/SwastikTripathi) — editable Trainer name (#1); Arena
  fixes for the blank-dashboard crash, SSL on python.org Python and browser-shortcut hijacking
  (#3, #4); nudges, chat @-mentions and the publish-health dot (#7–#24); unit tests + CI (#5);
  the daily budget alert (#6); creature fatigue and Poke Coins (#31); Arena rooms, quests &
  achievements (#32); the General Store (#41); and the Cali diner tab (#58, #60)
- [@shreyash73](https://github.com/shreyash73) (Shreyash Shanbhag) — Arena lobby chat with history
  (#10, #14), the voice channel with video, screen sharing and call shortcuts (#12, #20, #22), the
  sidebar-shell redesign with the sessions-first Live view and thinking orbs (#30), and the
  "haan yeaaah" button (#39)
- [@MustafaAsad198](https://github.com/MustafaAsad198) — Cursor sessions (#95), the space-jump
  avatar in the HQ (#101), Strikezone (#105, #113), its disasters (#124) and the strike zone warden (#127)
- [@J-Karthikeyan](https://github.com/J-Karthikeyan) — the soundboard with browser uploads (#40),
  the account board (#116) and account standings (#122)

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
`games/pokedata.js` and `backend/data/pokemon.json`) is generated by `tools/build_pokedata.mjs`
from [Pokémon Showdown](https://github.com/smogon/pokemon-showdown) (MIT,
© 2011-2026 Guangcong Luo and other contributors; see `LICENSES/pokemon-showdown-MIT.txt`).
Battle sprites use the same PokéAPI sprite library (repository CC0; image content © The Pokémon
Company) and the PkParaiso host the 3D pack already uses. This is a non-commercial fan feature.

Fish sizes and length-weight coefficients in `games/fishart.js`: [FishBase](https://www.fishbase.se/)
(Froese & Pauly, eds.). Only numeric facts are used, cited per species in the source; no FishBase
text or images are bundled.
