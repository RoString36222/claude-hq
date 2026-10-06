# ⚡ Claude HQ

**Version 1.7.0** · a **local, private, gamified dashboard** for everything happening across your Claude Code sessions.

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

- **🌾 The Valley** (key `0`): nine minigames for the moments a tab is working. A "play while
  you wait" pill appears while tabs work, and the game pauses the moment a tab needs you.
  Fishing pond (each project is its own pond), a garden your prompts water, a bundles board,
  the Mines (deeper on weeks you're active more days), creature battles on the Gym's type
  chart, a daily code puzzle, three townsfolk, a monthly fishing-derby festival, and the Bug
  Blaster arcade. All art is drawn in code; progress is a local `games-save.json`; in an Arena
  room only scores and counts are shared.

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

Pokémon names and sprites are the property of Nintendo / Game Freak / The Pokémon Company; the
"pokemon" creature pack hotlinks sprites from the public [PokéAPI](https://pokeapi.co/) sprite library
for personal use only. Use the built-in original "monsters" pack to avoid third-party assets entirely.

Fish sizes and length-weight coefficients in `games/fishart.js`: [FishBase](https://www.fishbase.se/)
(Froese & Pauly, eds.). Only numeric facts are used, cited per species in the source; no FishBase
text or images are bundled.
