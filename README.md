# ⚡ Claude HQ

**Version 1.1.0** · a **local, private, gamified dashboard** for everything happening across your Claude Code sessions.

Claude HQ reads your live sessions (`claude agents --json`) and your session transcripts
(`~/.claude/projects/**/*.jsonl`) and turns them into a single command center: what every tab is
working on right now, what it's cost you, a searchable archive of every past session, and a whole
Pokémon-style collection layer on top for fun.

It runs entirely on your machine and binds to `127.0.0.1` only. **Your conversations never leave your
computer.** (The one exception is that the "pokemon" creature pack loads sprite images from a public
CDN — only a Pokédex *number* is ever sent, never any of your data. Switch to the "monsters" pack for
100% offline.)

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

**Quality-of-life**
- Command palette (⌘/Ctrl-K), keyboard shortcuts (`?` for help, `1`–`5` for views, `/` search, `r`
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

No third-party Python or JS dependencies. Two files do everything: `dashboard.py` + `index.html`.

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
- Your transcripts and settings stay on disk. `config.json` and `sessions-meta.json` are git-ignored.

---

## 🗂️ Files

| File | What |
|---|---|
| `dashboard.py` | Stdlib-only HTTP server: reads live agents + transcripts, serves the JSON API and the page. |
| `index.html` | The entire self-contained frontend (inline CSS + JS). |
| `config.json` | Your settings (theme, pack, budget, …). Created on first save. *(git-ignored)* |
| `sessions-meta.json` | Per-session pins / tags / notes / rename aliases. *(git-ignored)* |

### HTTP API (all `127.0.0.1` only)
`GET /` · `GET /api/sessions` · `GET /api/stream` (SSE) · `GET /api/session/<id>` ·
`GET /api/session/<id>/export.md` · `GET /api/transcript/<id>?offset&limit&q` · `GET /api/search?q=` ·
`GET /api/history` · `GET /api/project?folder=` · `GET /api/pokedex` · `GET /api/digest?date&download` ·
`GET /api/config` · `GET /api/meta` · `GET /api/export.{json,csv}` ·
`POST /api/action` · `POST /api/config` · `POST /api/meta` (all CSRF-guarded).

---

## 🎨 Customization

Open **⚙️ Settings** in the app for themes, creature packs, accent color, text size, calm mode,
refresh rate, stuck threshold, and daily budget. Press **?** in the app for the full keyboard-shortcut
and feature guide.

---

## Changelog

- **1.1.0** — Editable Trainer name (thanks @SwastikTripathi, #1), smart Insights engine,
  weekly digest, event log, project deep-dive, installable PWA, and a perf/dead-code hardening pass.
- **1.0.0** — Initial release: live fleet view, full-history search + transcript reader, analytics,
  daily digests, and the Pokémon-style collection / Gym / quests layer.

## Contributors

- [@SwastikTripathi](https://github.com/SwastikTripathi) — editable Trainer name setting (#1)

## License

MIT — see [LICENSE](LICENSE).

Pokémon names and sprites are the property of Nintendo / Game Freak / The Pokémon Company; the
"pokemon" creature pack hotlinks sprites from the public [PokéAPI](https://pokeapi.co/) sprite library
for personal use only. Use the built-in original "monsters" pack to avoid third-party assets entirely.
