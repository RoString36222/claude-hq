# Transport revamp (HQ 3.15): the build plan

Status: **approved for build.** The owner reviewed the first draft and decided D1-D7 (section 0). Everything below
follows those decisions; where the first draft said otherwise, this version wins.

Not in this plan: anything space (rockets, launch pads, the space program), held back for a later big update; and
the quickshifter for PR 163 (a separate change on that PR). This work is its own PR (`feat/transport-revamp`),
separate from the city-sim branch.

---

## 0. Decisions (final)

| # | Question | Decision |
|---|---|---|
| D1 | "Every city max level" | **(a)** Every feature, line and building unlocked: the Arena reports **tier 5, grow 1000** for every city. Population and tax still follow the owner's real XP (the real tier), so the economy does not jump. One constant, `ALL_CITIES_MAX` in `backend/src/cities.rs`, turns it off. |
| D2 | Where the new water comes from | **(b) A new world generator version, @3.** The server generator lays lakes, canals and a marina into every world (the river and the sea as before) and designs the water transport around them. Every island and the Commons regenerate on @3; lots move. HQ placement stays by rank (`commons_lot`, island ownership), so each HQ is re-placed on the new layout and nothing is lost. `@1` and `@2` keep generating byte-for-byte as before. **No client-side water claims.** Water comes from the doc. |
| D3 | Metro | **(b) Real tunnels, laid by the @3 generator**: two lines crossing at Central, underground under the streets, underground stations with street entrances (stairs, escalators, lifts), and cut-and-cover portals where a line surfaces. The doc carries a metro layer. The client leaves holes in the terrain at portals and entrances, renders an **underground view** (lit tunnels, track, stations as interiors) when you are below ground or riding, and runs trains on a pure timetable. |
| D4 | Fares | **(b) Everything free.** No fares, no day pass, no fare kinds, no Wallet of coins. The Tickets app still plans and "books" journeys (free tickets and boarding passes). Claude Cabs, water taxis and helicopters are free. The bus and tram fares (2 coins today) become free too. No fares server work. |
| D5 | Claude Cabs driver mode | **(b) Score only, no coins.** Driver earnings are a score, a rating and achievements, kept locally. No server payout route. |
| D6 | SMS reach | **All players**: message any player, online or offline (offline delivery kept 7 days). Sending needs your own one-time opt-in; receiving is on by default, with block and mute. Rate limits and length caps as below. |
| D7 | Inter-island rail | **(b) Pre-built links to the Commons.** Every island gets an **Island Link**: the @3 generator lays the track from Central to an island-edge portal and a sea viaduct abutment; a train runs island <-> Commons on a timetable through the existing world-travel mechanism, bookable on the phone. This is in addition to the in-city City Line. Player-built island-to-island lines (`hqrail`, `/v1/rail/build`) stay as they are. |

Unchanged from the draft defaults: nearby (proximity) chat is text bubbles plus voice calls in the Phone app;
anyone can hail a Claude Cabs helicopter and owners can also call their own.

---

## 1. Goals

1. **The street tram becomes real**: grooved rails in the road, overhead wire on poles, crossovers at the ends,
   boarding islands. Nothing is drawn today ("tram tracks are not there").
2. **Every city is max level** (D1), so every line, stop, airport and building is open everywhere.
3. **Every way to travel** (no space): bus, tram, **metro in real tunnels** (M1, M2), the **City Line** railway
   (Central - Port - Airport), the **Island Link** train to the Commons, a **gondola**, the **water bus** on the
   river, canals and marina, a **lake launch**, **water taxis**, **boat hire**, **Claude Cabs** (bike, go, cab, XL,
   lux, heli), **your own vehicles called to you** (car / bike / heli filters), a **helicopter you can call**, and
   the existing plane, ferry, cruise, player-built island rail and boats.
4. **More water**: every world @3 has lakes, canals and a marina, generated server-side, with water transport
   designed around them.
5. **You ride inside, sitting down.** Doors open, you walk on, sit in a real seat (or stand at a pole at rush
   hour), with a seat camera and the city (or the tunnel) going past the windows. NPC commuters fill vehicles by
   time of day, seated and standing, the same for everyone.
6. **A phone** that does it all: Tickets (journey planner, free tickets, boarding passes, airport check-in),
   Departures, Transit map with live vehicles, Claude Cabs (ride and drive), Vehicles (filtered), Dealership call,
   Messages (SMS), Nearby chat, Phone calls, Camera, Gallery, Achievements, Patch notes, Settings.
7. Full detail on looks, sound, interiors, accessibility, Calm mode and the draw-call budget.
8. A **screenshot tour** of every feature from the real UI (section 8).

## 2. House rules every part follows (AGENTS.md)

- No build step. Vanilla `var`-style JS in an IIFE that registers `HQV.<name>`. A pure top half (no THREE, no
  DOM, tested under node) and a drawing or DOM bottom half. Defensive guards (`|0`, `Math.max/min`,
  `!=null ? : fallback`, `o = o || {}`).
- **Never `Math.random`** for anything visible. Seed with the world id (`hash32(W.id + ...)` / `mulberry32`).
  Everything visible is a pure function of `(world doc, tier, UTC ms, seed)`, so two clients agree with no traffic.
- **DOM**: `textContent` / `createElement` / `createElementNS` only. Never `innerHTML` with data. Every panel has
  a role, an aria-label or aria-labelledby, keyboard reach (roving tabindex in grids, Esc to go back or close),
  and `announce()` for live status. Colour is never the only signal (line badges carry text: T1, M2, W1, CL, IL, G1).
- **Calm** (`html.hq-calm`, `host.calm()`) **and** `prefers-reduced-motion` gate every flash, blink, sway, shake,
  particle, slide, siren and lurch. Calm keeps every piece of information (boards, text, announcements) and drops
  motion. Seat cameras are level and still under Calm.
- **Privacy**: nothing transcript-derived leaves the machine. New egress, each opt-in where it sends: SMS text
  (user-typed, at most 160 characters; sending needs the one-time opt-in), nearby chat (user-typed, at most 200;
  opt-in), call ringing and WebRTC signalling (to one target only; opt-in). Photos never leave the machine
  (IndexedDB only). Speech synthesis uses **only voices with `localService === true`**.
- CSS: semantic tokens only (`--panel`, `--ink`, `--brand`, `--line`, `--muted`, ...), every theme, light and
  dark, animations gated under `html.hq-calm` and `@media (prefers-reduced-motion: reduce)`.
- Tests: Python `unittest` in `tests/` shelling out to `node` with a `globalThis.window = {HQV: {}}` harness (see
  `tests/test_hqcall.py`, `tests/test_traffic.py`); skip when node is missing. Rust: in `backend/` or
  `dashboard-rs/`, `PATH=$HOME/.cargo/bin:$PATH cargo test --locked <filter>`. Use your own
  `CARGO_TARGET_DIR=<scratchpad>/target-<part>` so parallel builders do not fight over the build lock.
- **Parallel build etiquette**: parts share one worktree. Edit only the files you own (create new ones freely).
  If another part's half-finished file breaks the crate or a shared test, do not touch it: wait and retry
  (poll with a loop, never `sleep` in the foreground), and say so in your report. Never git
  checkout/stash/reset/clean/commit. Never port 8765. Headless browsers only. Never kubectl.

## 3. The experience, feature by feature

### 3.1 Tram tracks and street furniture (`games/hqtramway.js`, part `streets`)

- **Rails**: two rails per direction, standard gauge 1.435 m, centred on the tram lane (`traffic.lanes(W)`
  gives `tramOff`, 1.475 m each side of the centre line). Grooved-rail strip: a 0.07 m polished steel head (light
  metallic, brighter at night under street lights) beside a 0.04 m dark groove, flush 0.01 m above the road
  surface (`world.roadY`). Through junctions the rails follow the tram's own turn curves (the same curve
  `traffic.js` drives); where two lines cross, a diamond crossing.
- **Track bed**: on reserved stretches over 60 m the bed between the rails is a slightly different asphalt with
  white edge lines, `TRAM` stencils every 120 m. Within 25 m of a stop the bed is setts. Beside a park site, a
  grass track (green bed).
- **Crossovers** at each terminus: switch blades, a point-motor box and a check rail, matching the crossover
  `traffic.js` drives.
- **Overhead line**: poles every 30 m (closer on curves so the chord never strays 0.4 m off the track) on the
  kerb side, or centre poles with twin arms on avenues with a tram each way. Contact wire 5.6 m up with the ±0.2 m
  stagger between poles, a messenger wire above, droppers, pull-offs on curves; one merged line mesh per cell;
  insulators instanced.
- **Tram stops**: a 0.3 m boarding island with a yellow ribbed tactile edge, the existing `hqcivic` shelter, a
  totem in the line colour with the line badge, and a **live departure board** (3.6).
- **Road markings** (part `worldclient`, `worldgeom.js`): on a tram street the double yellow centre line becomes
  the two tram-lane edge lines, so the tram never drives over yellow paint.
- LOD: rails and wire within 480 m, poles within 300 m. Budget: at most 10 draw calls for the whole tramway.

### 3.2 Buses and trams you ride (`games/traffic.js` + `games/hqcoach.js`, part `streets`)

- **Far vehicles** stay instanced, plus: a lit destination display (line + terminus, shared canvas atlas, 1
  draw), route colour bands, windows glowing warm at night, and seated silhouettes in the windows (one
  InstancedMesh for all far passengers, counts from `hqCommute`).
- **Near detail model** for the vehicle you board or ride, plus up to 2 others within 40 m:
  - **Bus**: 12 m low-floor, 3 double doors that slide and plug open over 1.2 s with door-edge lights (Calm: no
    blink), kneels 6 cm at stops (Calm: pose only), 31 seats (2+2, rear row of 5), yellow grab poles, hanging
    straps, a wheelchair bay with a fold-down seat, STOP buttons, an LED strip ceiling, a dot-matrix "next stop"
    display, grey speckle floor, a driver figure.
  - **Tram**: 27 m, two sections with an articulation (turntable floor, bellows), double-ended with both cabs
    drawn, 4 double doors a side, 48 seats in 2+1 facing bays, low floor, tall windows with thin pillars, ceiling
    grab rails, a passenger information screen per section, a driver in the leading cab.
  - Seats come from one table `SEATS[kind] = [{x, y, z, yaw, window, priority}]` in vehicle-local metres, shared
    by the pure trip and the 3D model.
- **Boarding**: watch it pull in, doors open, a 1.2 s scripted walk from the island to the door to your seat,
  a validator beep (the ticket is free; the beep is the "touch in"), sit (`sit` pose) and the camera moves to
  the seat. Seat choice: first free window seat on the pavement side, else any free seat, else **standing** at a
  pole (hand up on the rail).
- **Riding**: seat camera (3.5), the next-stop display updating, an announcement before each stop. `S` (or the
  phone's "Stop here") requests the next stop: the STOP sign lights and the bell dings. `E` gets off at the next
  stop: doors open and you walk out to the kerb.
- **No fares**: the old 2-coin bus and tram fares are gone; the integrator removes the `payFare` call.

### 3.3 Metro in real tunnels (`games/hqmetro.js`, `games/hqunderground.js`, part `metro`)

- **Layout (from the doc, `layers.metro`, laid by the @3 generator)**: **M1** (roughly east-west, red) and **M2**
  (north-south, blue) cross at **Central** (the transit hub). Tunnels run under the streets (the alignment follows
  the street centre lines, smoothed), rail level 12-16 m below the street. 4-8 stations a line, 450-800 m apart.
  Each line **surfaces at one end** through a **cut-and-cover portal** in open land into an open-air **depot**
  (stabling sidings and a shed); the other end is a tunnel terminus with a headshunt.
- **Street level**: each station has 2-4 **entrances** on the pavement or a corner plaza: a glazed canopy over
  the stair well, a red-and-blue "M" totem with the line badges, a lit sign with the station name, stairs plus an
  escalator (`kind: "escalator"`), and at least one **lift** kiosk per station. The terrain has a real hole there
  (the doc lists every hole polygon; `worldgeom` cuts it), so you look down the stairs into the lit ticket hall.
  **Portals**: a concrete U-trench ramp with retaining walls, a parapet and a portal headwall with the line name;
  the terrain hole is cut, the trench is drawn in the hole.
- **Going underground**: walk into an entrance (E or just walk down the stairs): a 0.6 s fade (Calm: a cut) and
  you are in the **underground view**: the surface (terrain, buildings, sky) is hidden, the city's underground is
  shown in the same coordinates below the street. The view draws:
  - **Stations as interiors**: a ticket hall under the entrances (tiled walls, a gate line whose gates open with a
    beep as you walk through: free, it is a touch-in, ticket machines, a line map, a departure board), escalator
    and stair shafts down to the platforms, two side platforms (or one island platform at Central's interchange)
    90 m long with **platform screen doors**, benches, a station-name frieze repeated along the wall, platform
    departure boards, cool white light strips (static, no flicker), a "way out" sign at each exit. Central is a
    bigger interchange: M1 above M2 at right angles, passages between them, and the Island Link platforms (3.4).
  - **Tunnels**: twin-track box (cut-and-cover) or twin round bores (bored), concrete segments with ring joints,
    a lit cable tray, walkway with handrail, track (sleepers in concrete, third rail on insulators), signals with
    aspects, and lights every 25 m. Only the tunnel within 400 m of the camera is built (LOD by segment).
  - **Trains**: 4-car driverless EMUs, 19 m cars, 3 doors a side per car, white with the line-colour band and
    a black window band. Interior: longitudinal seats (8 per side per car), centre poles, ceiling rails, open
    gangways (you see down the whole train), a route-map strip above the windows with the next station lit, LED
    screens. A train every **120 s** each way, 25 s dwell, 22 m/s top speed, 1.1 m/s² accel/brake. Pure
    timetable.
- **Riding**: on a platform, the board counts down; the train arrives (headlight glow in the tunnel, rising
  whine), screen doors and train doors open together (double beep), you walk on and sit (or stand at rush hour).
  Through the tunnel you see the lights and ring joints stream past the windows; at the portal the train climbs
  into daylight and the surface comes back (the view switches as the train passes the portal mouth). At your
  stop, walk out, follow "Way out" (or press E on the platform: you are taken up the nearest exit), and you come
  out at the entrance's street side (fade; Calm: cut).
- Sound: traction whine pitched by speed, three-tone door chime then a hiss, the screen-door double beep,
  tunnel rumble and rail joints, and the station announcer.

### 3.4 City Line, Island Link and gondola (`games/hqcityrail.js`, `games/hqrail.js`, `games/hqgondola.js`, part `rail`)

- **City Line (CL)**, from the doc (`layers.rail`, kind `city`): **Central - (0-2 neighbourhood stops) - Port -
  Airport** (Central - Airport where there is no port), **elevated** 9 m over the streets on its own viaduct
  style (steel box girders on round piers, catenary masts every 50 m), stations as elevated boxes over the street
  with stairs and a lift down to the pavement. 4-car regional EMUs (17 m cars: `hqrail`'s car model in a cream
  and green livery), 2+2 transverse seats, luggage racks, a luggage stack in car 1. A train every **240 s**.
- **Island Link (IL)**, from the doc (`layers.rail`, kind `island`): from Central's underground IL platforms
  through a tunnel to a **coastal portal**, then onto a **sea viaduct abutment** at the island edge. The sea
  crossing between that abutment and the Commons' **sea junction** is drawn by `hqrail` from the archipelago
  positions (the same way player-built lines cross the sea today: 13 m over the water). At the Commons the IL
  arrives at **Commons Central**, a terminal with up to 6 platforms (one per island in view, then shared). A
  train every **300 s** each way per island, departures a pure function of `(island world id, ms)`. Riding it is
  a **world trip** through `hqTravel` (mode `link`): you board on the island's IL platform, ride through the
  tunnel, out over the sea (the camera in your seat, the sea and the archipelago going by), the destination world
  loads during the sea crossing (`hqTravel`'s hold), and you arrive at the other end's platform. Bookable on the
  phone. Free.
- **Player-built lines** (existing `hqrail` with `/v1/rail/build`) keep working.
- **Gondola (G1)**, from the doc (`layers.gondola`): a valley station beside a tram or metro stop up to a summit
  station with a viewing deck where the island has a hill; else an aerial crossing over the river, a lake or the
  marina. Lattice towers (positions in the doc), sheave trains on the arms, the cable as a catenary (2% sag).
  8-seat cabins every **18 s** at 5 m/s, slowing to 0.3 m/s round the bull wheels. Cabins sway gently in wind
  (`hqweather`; Calm: no sway). Interior: two facing benches of 4, glass all round, a map placard. Sound:
  bull-wheel rumble, a clunk passing each tower, wind.

### 3.5 Riding core (`games/hqride.js`, `games/hqcommute.js`, part `ride`)

- **Ride session**: one state machine for every mode: `walk` to the stop, `wait`, `board` (scripted walk on),
  `seated` or `standing`, `alight` (scripted walk off), `done` or `cancelled`. It owns the carry pose, the seat
  camera, announcements, the ticket record and the achievement events. No payment step (D4).
- **Seat camera**: eye 1.15 m above the seat (sitting) or 1.62 m (standing), forward along the vehicle; drag or
  arrows look round within ±150° yaw and ±50° pitch; FOV 70; a tiny speed-based sway and a braking lurch (Calm or
  reduced motion: none). `V` cycles **seat -> window -> outside chase -> seat**.
- **Commuters**: load per vehicle = `base(mode) × curve(local hour) × line weight × seeded jitter`. Peaks at
  08:00-09:30 and 17:00-19:00 (to 1.15: standing passengers), midday 0.45, night 0.08. Seated figures fill seats;
  above capacity they stand at poles. Seeded by vehicle and trip, so everyone sees the same people. Stops and
  platforms show waiting crowds by the same curve (instanced, 1 draw). `npcsim` residents who take transit pick
  a mode (bus, tram, metro) and count into their line's load.
- **Announcements**: before each stop, a chime (G5-E5-C5) and a voice through `speechSynthesis` **only with a
  local voice** ("Next stop: Harbour Street. Change here for M2 and the City Line."). The same text goes to
  `announce()` and the in-vehicle display. Calm keeps voice and text, drops the chime. A phone setting turns the
  voice off.
- **Departure boards**: one canvas renderer, amber dot-matrix rows (`badge · destination · due`), updated every
  5 s, shared by every board within 150 m.
- **Station names**: `hqRide.stationName(W, x, z, kind)`: the nearest named road (`world.roadLabels`), else the
  nearest site kind ("Harbour", "Airport", "Central", "Stadium"), made unique per world with a seeded suffix
  ("Street", "Square", "Gate", "Park"). Every module names stops through it.
- **Tickets (free)**: `hqRide.tickets`: a local list (localStorage, try/catch) of booked journeys and boarding
  passes `{id, mode, line, from, to, depart, seat?, gate?, made}`; the newest 30 kept.
- **Achievements** (local only): *Line collector* (every line in a city), *All aboard* (every mode), *Rush hour*
  (stand on a full tram), *Night owl* (ride after 01:00 city time), *Up the hill* (gondola summit), *Mole* (ride
  the metro end to end), *Island hopper* (the Island Link both ways), *Cabbie* (10 driver fares), *Five stars*
  (a 5-star driver rating), *High flyer* (call a helicopter). A toast once plus `announce()`.
- **Sound**: `hqRide.sfx` synthesises door chime and hiss, validator beep, stop bell, tram bell, bus air-brake,
  motor whine, rail joints, tunnel rumble, gondola clunk, ferry horn, indicator tick, rotor beat, phone ring and
  dial tone. All WebAudio, no files, respecting the master volume and mute.

### 3.6 Live departure boards

- Every service has a pure `departures(stopId, ms, n)`. A board shows the next 4: badge, destination, platform,
  "due" / "2 min" / HH:MM (city clock). "boarding" while doors are open. Always on time (exact timetables), except
  a tram row is "delayed +N min" while a `traffic` incident blocks its line.
- On: tram stops, bus stops (a one-line LED), metro ticket halls and platforms, City Line platforms, the IL
  platforms, gondola stations, piers, and the phone's Departures app (as real text).

### 3.7 Water (server @3 generator, `layers.water`; drawn by part `worldclient`)

- **Generated, not claimed**: the @3 generator (part `worldgen`) lays, in every world:
  - **Lakes** (1-2): a park lake of 1-3 ha in the town (an organic outline, sometimes an island), and on bigger
    worlds an upland lake. Banks 1:3; a bed 2-3 m deep; reeds on shallow edges (client, seeded).
  - **Canals** (1-3 arms): 20-24 m wide, vertical stone quay walls, from the river or the marina into the town
    along a street, ending in a turning basin. Arterials **bridge** them (like the river); local streets stop at
    quays.
  - **A marina** on the coast nearest the hub: a dredged basin with a breakwater arm, pontoons with finger berths,
    a fuel jetty, a harbour office and a lighthouse on the breakwater head.
  - **Piers** for the water bus on the river, canals and marina, a launch jetty on the park lake, hire jetties.
  - A **water network** (`net`): the navigable centre lines joining the piers, for water taxis and the water bus.
  The terrain heightfield is carved server-side (the client gets the carved heights in the doc, bit-exact). The
  sites and lots are generated around the water: nothing is built on it.
- **Look** (`worldclient`): the river's water shader with a calm lake variant (smaller waves, reflection tint),
  quay-wall meshes (stone, a coping stone, mooring rings), lily pads (a few, instanced), shore foam lines. +1
  world-wide draw for all bodies (one merged mesh), banks in the terrain tiles.
- **Land tests**: `world.js` walk tests and `ocean.seaOf` treat every body as water (boats float, people cannot
  walk on it) and every pier, pontoon and breakwater as land.

### 3.8 Water transport (`games/hqferries.js`, `games/hqboat.js`, `games/hqvoyage.js`, part `water`)

- **Water bus W1** (and **W2** where the network is long enough): along the doc's water routes (river, canals,
  marina) calling at its piers. 24 m catamaran: enclosed cabin (36 seats 2+2+2, panoramic windows), an open stern
  deck with benches, wheelhouse with a skipper, life rings, a gangway swinging out at each pier (Calm: appears in
  place), bow wave and wake. Every **150 s** each way, 6 m/s on the river and canals, 9 m/s in the marina.
- **Lake launch L1**: a small electric launch looping the park lake every 300 s (12 seats).
- **Water taxis**: on demand from the phone (Claude Cabs, class "Water taxi"): a 9 m varnished speedboat comes to
  the nearest pier, takes you to any pier on connected water along `net`; 14 m/s open water, 6 m/s river and
  canals. Rear bench seat. Seeded skipper name. Free.
- **Boat hire** at hire jetties and the marina: **pedalo**, **rowboat**, **kayak** (new `hqboat` kinds beside the
  rowboat and jet ski), and a jet ski at the marina. Boats stay in their body of water. Return at any jetty with
  E. Free.
- Piers: timber decks on piles, a kiosk, a departure board, lamps, bollards.

### 3.9 Claude Cabs (`games/hqcabs.js`, part `cabs`)

- **Riding**: in the phone's Claude Cabs app pick a destination (named places, stations, or a pin on the transit
  map). **Filter chips** for the class: **Bike · Go (hatch) · Cab (sedan) · XL (SUV) · Lux (EV) · Heli · Water
  taxi**, each with ETA and the vehicle (no price: free). Request; a driver is matched (seeded name from an
  original name list, rating 4.6-5.0, a plate, a model from `hqVehicleModels`), and the car drives to the kerb
  beside you on the `hqCall` engine (route on the minimap, ETA countdown in the app). Livery: catalogue body in a
  seeded paint with a terracotta band, a lit "CLAUDE CABS" roof sign (canvas), door decals.
- **Ride**: E to get in (rear right seat; pillion on a bike). Inside camera; the NPC driver steering (`ridePose`
  with grips). Drives the `hqnav` route at street speed. The phone shows distance, ETA and a "Skip ahead" for
  trips over 1.5 km (4x; Calm: a fade). At the end: an optional rating (local) and a trip in Tickets.
- **Driver mode** (D5: score only): "Drive for Claude Cabs". You need to be in a car (yours, or a Claude Cabs
  loaner called to you). Requests arrive deterministically (`hash(world, minute, slot)`): an NPC at a kerb with a
  destination 0.4-3 km away, offered for 20 s with pickup distance and trip length. Accept: a pickup beacon (soft
  light column; Calm: a static ring) and the route banner. Stop beside the NPC (within 6 m, under 1 m/s); they
  walk round and get in the back (a seated passenger in your car). Drive to the drop-off. **Score** = distance
  points + on-time bonus + smoothness, a **star rating** from driving (harsh braking, over 60 km/h on streets,
  kerb hits) shown at the end, a running **driver score**, **rating average** and **fares count** stored locally.
  Achievements *Cabbie* and *Five stars*. No coins.

### 3.10 Helicopter calling (`games/hqhelicall.js`, part `cabs`)

- From the phone (Claude Cabs -> Heli, or Vehicles -> Helicopters), pick a **landing spot**: the nearest helipad
  (airport apron, hospital site, an HQ roof with a pad, the marina breakwater) or the nearest **open area** of at
  least 26 × 26 m clear of buildings, roads, water and trees, within 400 m.
- The helicopter (a Claude Cabs heli in livery, or your own) flies a scripted pure path: cruise 90 m, descend on a
  12° glideslope, flare, hover-taxi, land. Rotor-wash dust (Calm: none), a Doppler rotor beat. Board on foot
  (rear left seat).
  - **Cab heli** (anyone): flies you to the chosen helipad, airport or HQ roof; camera in the cabin looking out
    (`V` cycles to chase).
  - **Your own heli** (owners): lands and you get in as the pilot (existing `mountOn`).

### 3.11 Vehicle calling with filters (`games/hqcall.js`, part `cabs`)

- The C list and the phone's Vehicles app get **filter chips**: All · Cars · Bikes · Helicopters (· Boats at a
  jetty). A `role="radiogroup"` with arrow keys, remembered (localStorage), a count on each chip, and an empty
  chip says why ("No helicopters yet: the dealership has them"). Free-text search still combines with the chip.

### 3.12 The phone (`games/hqphone.js` + `games/hqphone.css` + apps)

- **Open**: Backquote (or `I` in the 3D view), a phone button next to the call button, or "Phone" in Cmd-K.
  **Close**: Esc on the home screen, the same key again, or the backdrop. While open WASD does not walk (the phone
  joins hq3d's `owns(e)` chain). Outside the 3D view the phone still opens (Messages, Phone, Patch notes,
  Settings, Gallery work; transit apps say "Open the City to use this").
- **Device**: 360 × 740 in the bottom-right corner, 22 px radius, thin bezel, a status bar (city clock, signal
  bars, battery 87%: decorative, `aria-hidden`). Slides up 240 ms (Calm or reduced motion: none). Under 600 px
  wide: a full-screen sheet. Themed with the page tokens; every theme; Large text.
- **Home**: a 4-column grid of app icons (original inline SVG glyphs on token-coloured squircles), a dock (Phone,
  Messages, Tickets, Claude Cabs), badges (unread SMS, active ride, missed call). Roving tabindex, arrows move,
  Enter opens, Esc goes back. A notification banner slides from the top for incoming SMS / calls / cab arrivals
  (Calm: appears in place).
- **Apps** (each a panel with a header, Back, its own heading id):
  1. **Tickets** (part `phone`): journey planner (from: here or a place; to: a place or station; leave now or at a
     time) with up to 3 options of walk + up to 2 legs (any mode, including the Island Link to the Commons), each
     with times and changes. **Book** saves a free ticket; **Go** starts the ride session (walks you to the stop
     with the route banner). **Airport check-in**: pick a flight (`hqAir` timetable), check in, get a seat (seeded,
     window or aisle preference) and gate, and a boarding pass card with a seeded decorative pattern. **My tickets**
     lists booked tickets and passes.
  2. **Departures** (part `phone`): nearest stops and stations by distance, each expandable to its live board as a
     table; mode chips (All · Bus · Tram · Metro · Rail · Ferry · Gondola); favourites (localStorage).
  3. **Transit map** (part `phone`): a schematic SVG (`createElementNS`) of every line in its colour, stations as
     ticks and interchange rings, water in blue, metro lines dashed where underground, and **live vehicles as
     moving dots** (each second; Calm: every 5 s without tweening). Tap a station: its board. Tap a vehicle:
     "Track" (camera follows it if you are not riding). Mode chips. Pinch or +/- zoom; arrows pan.
  4. **Claude Cabs** (part `cabs`, `games/hqphonecabs.js`): 3.9 rider and driver tabs, Heli and Water taxi.
  5. **Vehicles** (part `cabs`): your vehicles with chips (3.11); Call; "Call a helicopter".
  6. **Dealership** (part `cabs`): "Call the dealership": a 2 s ring with a dial tone (Calm: no animation), "Claude
     Motors, how can we help?", then the dealer catalogue (`hqDealer.mountPanel` in the phone, test drive off).
     Buying delivers to your carpark ("Your new X is parked at level 2, bay 14. Call it?").
  7. **Messages (SMS)** (part `social`): threads with any player (D6): contacts from people met (Here now,
     Nearby), recent senders, island owners in the archipelago, and a **directory search** by handle. At most 160
     characters with a counter, sent / delivered ticks, block, mute (per thread), report. Sending asks for the
     one-time opt-in the first time.
  8. **Nearby** (part `social`): proximity chat with players within 40 m in the same city: a bubble feed, at most
     200 characters, names and the text as **bubbles over avatars' heads** for 6 s (Calm: no fade). Opt-in.
  9. **Phone** (part `social`): contacts (players in the same room, online), call (ring, accept or decline,
     WebRTC audio peer-to-peer), mute, hang up, recent calls (local); opt-in. Service numbers "Claude Cabs",
     "Dealership", "Heli dispatch", "Water taxi" open their apps.
  10. **Camera** (part `phone`): a viewfinder (the live 3D canvas in the phone frame), shutter (Space or Enter),
      front / back (selfie: a camrig mode facing your avatar at arm's length), 3 s timer, grid lines; shutter
      sound and white flash (Calm: no flash).
  11. **Gallery** (part `phone`): photos in IndexedDB (never uploaded): grid, viewer, delete, save to disk.
  12. **Achievements** (part `phone`): the `hqRide.achievements` list with progress, plus the Claude Cabs driver
      score, rating and fares.
  13. **Patch notes** (part `phone`): newest first from `games/patchnotes.json` (version, title, body), the
      newest expanded.
  14. **Settings** (parts `phone` + `social`): SMS sending opt-in, Nearby, Calls (each with a one-line "what is
      shared"), transit voice on/off, announcements text-only, default cab class, 12h/24h clock.

### 3.13 Accessibility summary

- Every transit action works by keyboard: E board or alight, S request stop, V camera, the phone fully by keyboard.
- `announce()` for: arrival ("Tram T1 to Harbour arriving, doors open"), boarding, every next-stop announcement,
  going underground and back up, a cab matched and its ETA (every 30 s and at 1 min), calls, new messages (count
  only, never the text unless the Messages app is open), achievements.
- In-world boards are canvas textures; the same rows are real text in the phone's Departures app (a table).
- Line badges carry text; colour is never the only signal.

### 3.14 Performance budget (`tools/ui_smoke.py` limits stay: 400 world / 700 frame calls / 1.5 M triangles)

Surface (any camera):

| part | draw calls max | triangles |
|---|---|---|
| tramway (rails, bed, poles, wire, stops) | 10 | 60k |
| bus / tram far additions (signs, passengers) | 3 | 30k |
| near vehicle interiors (at most 3) | 12 | 120k |
| commuters (seated, standing, crowds) | 3 | 60k |
| metro surface (entrances, portals, depot, trains in the open) | 8 | 60k |
| City Line + Island Link viaducts, stations, trains + gondola | 14 | 120k |
| water bodies, quays, reeds (worldclient) | 4 | 40k |
| water transport (water buses, launch, taxis, hire boats, piers) | 12 | 90k |
| cabs (instanced cabs, roof signs) + heli | 6 | 60k |
| boards (shared atlas) | 2 | 1k |
| **total** | **74** | **~640k** |

Underground view: the surface groups are hidden, so the underground view has its own budget of **120 calls /
400k triangles** (tunnel within 400 m, at most 3 station interiors, trains, commuters).

Every module reports `drawCalls()`; the integrator adds them to `smokeStats`.

## 4. Data and geometry approach

### 4.1 World generator version 3 (server; parts `worldgen` and `worldlines`)

- `VERSION = [1, 2, 3]`. `@1` and `@2` generate **byte-identical** documents to today (pinned hashes for
  `claude-hq@1`, `claude-hq@2` and the fixture island `user:0b8e4c1a-3f2d-4e5b-9a6c-7d8e9f0a1b2c@2` are recorded
  **before** any change and asserted after).
- `@3` = the @2 pipeline (organic city, island, river, civic, zones, transit) **plus**: water (lakes, canals,
  marina, piers, net) carved and laid before the streets grow (like the river), so streets, blocks, lots and sites
  form round the water; then, after roads and sites: the metro (tunnels, stations, entrances, portals, depot),
  the rail (City Line, Island Link with its coastal portal and sea abutment; on the Commons the Commons Central
  terminal and the sea junction), and the gondola. Lots those structures need become sites (never an `hq` lot).
- The Commons @3 keeps **exactly 64 ranked HQ lots** (ranks 0..63); every island keeps its HQ lot(s) as @2
  does; the Commons' **airport site** (the runway platform at sea) stays where it is in @2 (asserted), so the
  airfield's keep-out capsule and timetable keep working.
- New layers, each hashed (`hashes.water`, `metro`, `rail`, `gondola`, all `Option`) and folded into
  `hashes.world`, so the fingerprint changes and clients re-fetch. All positions in **cm**, integers, as the rest
  of the doc. Schemas in 5.1.
- `tools/world_fixture.py` also writes `tests/fixtures/claude-hq@3.json.gz` and `tests/fixtures/island@3.json.gz`;
  the existing `@1`/`@2` fixtures stay as they are (still valid: their generator is unchanged).

### 4.2 The live worlds move to @3 (parts `arena`, `social`, `worldclient` and each client owner)

- Live ids: the Commons **`claude-hq@3`**, an island **`user:<uuid>@3`**. `@2` (and `@1`) stay **served** for
  older clients. Island slots (`island_slot`) and Commons ranks (`commons_lot`) are id-independent, so every
  island stays where it is on the sea and every HQ keeps its rank, now on the @3 lot of that rank.
- `GET /v1/world/claude-hq@3/assign` is added beside the `@2` path (same ranks).
- Migration `0024_live_v3.sql` (part `arena`): `city.seed` `@2` -> `@3`; `rail_line.a/b` `@2` -> `@3`
  (respecting `a < b`); `owned_vehicles.parked_world` `@2` -> `@3` with `parked_x/z/yaw` set to NULL (the layout
  moved, so the vehicle goes home to its basement or carpark bay). Specialties stay as stored.
- The server accepts `@2` ids on input everywhere it accepted them and **canonicalises to `@3`** where it stores
  (rail build, parking).
- Client fallback chain (integrator, `hqcity3d`): want -> `claude-hq@3` -> `claude-hq@2` -> `claude-hq@1`; for an
  island `user:x@3` -> `user:x@2` (an Arena without @3). Every module reads the live ids from `HQV.world`
  (`COMMONS`, `islandId(uid)`, `isLive(id)`, `LIVE_V`), never a literal.

### 4.3 Max level (part `arena`)

`cities.rs`: `const ALL_CITIES_MAX: bool = true;`. `snapshot` keeps the real tier for population and tax and
reports `tier = 5`, `grow = 1000`; `name_and_tier` returns 5. Rail build tier checks and the old bus/tram tier
gates pass. Bus and tram fares become 0 (`FREE_TRANSIT`), so older clients ride free too; fast travel and the
park pass are unchanged.

### 4.4 Everything else is client-side and pure

Timetables, vehicles, commuters, cabs, helis, boards, interiors and the underground view are pure functions of
the doc, tier, UTC ms and the world seed. The only new server work: @3 worldgen, the live-id cutover, the max
level clamp, and the social routes (SMS, nearby relay, call ringing, presence caps).

## 5. Contracts

Coordinates on the client: city metres, +y up, yaw 0 faces +z, increasing yaw turns left, the right of travel is
(-cos yaw, sin yaw), as `traffic.js`. Times are UTC ms unless noted `s`. Doc layers are cm (integers).

### 5.1 Doc layers @3 (Rust `Serialize`, JSON; parts `worldgen` and `worldlines`)

```
layers.water = {                                   // worldgen: backend/src/worldgen/water.rs
  bodies: [{ id: "lake:0"|"canal:0"|"marina:0", kind: "lake"|"canal"|"marina",
             poly: [[x, z], ...] (ccw, cm), level: cm (water surface y), bed: cm (depth below level),
             edge: "bank"|"quay", islands: [[[x, z], ...]], joins: "river"|"sea"|"marina:0"|null, tier: 1..5 }],
  piers:  [{ id: "pier:0", body: "river"|"lake:0"|"canal:1"|"marina:0", kind: "waterbus"|"launch"|"hire"|"fuel"|"taxi",
             x, z, y (deck cm), front: [fx, fz] (Q16 unit vector out over the water), len, w, tier }],
  berths: [{ body, x, z, front: [fx, fz] }],                 // marina finger berths and hire moorings
  breakwater: [[x, z], ...] | null, lighthouse: [x, z] | null, office: site id | null,
  net:    { nodes: [[x, z], ...], edges: [[a, b], ...] },    // navigable centre lines (river, canals, marina, lake)
  routes: [{ id: "W1"|"W2"|"L1", kind: "waterbus"|"launch", piers: [pier ids], path: [node indices], loop: bool, tier }]
}
layers.metro = {                                   // worldlines: backend/src/worldgen/metro.rs
  lines:    [{ id: "M1"|"M2", stations: [station ids], path: [[x, y, z], ...] (track centre, cm; y = rail level),
               kinds: ["bored"|"cutcover"|"portal"|"open", ...] (one per path segment), depot: depot id | null, tier }],
  stations: [{ id: "metro:0", x, y (platform level), z, along: [fx, fz] (Q16, track direction), len (cm, 9000),
               platform: "side"|"island", lines: ["M1", ...], hall_y (cm, ticket-hall floor), entrances: [ids] }],
  entrances:[{ id: "ent:0", station, x, z, y (street level), front: [fx, fz] (the way down), w, d,
               kind: "stairs"|"escalator"|"lift", hole: [[x, z], ...] }],
  portals:  [{ id: "portal:0", line, x, z, y, front: [fx, fz] (towards the tunnel), w, len, hole: [[x, z], ...] }],
  depots:   [{ id: "depot:0", line, poly: [[x, z], ...], tracks: [[[x, y, z], ...]] }],
  holes:    [[[x, z], ...]]                        // every terrain hole (entrances, portals, IL portal): cut by worldgeom
}
layers.rail = {                                    // worldlines: backend/src/worldgen/railway.rs
  lines:    [{ id: "CL"|"IL", kind: "city"|"island", stations: [ids], path: [[x, y, z], ...],
               kinds: ["viaduct"|"bridge"|"tunnel"|"portal"|"grade", ...] (per segment), tier }],
  stations: [{ id: "rail:0", kind: "elevated"|"underground"|"terminal", x, y (platform), z, along: [fx, fz], len,
               platforms: n, lines: [...], stairs: [[x, z], ...] (street foot of stairs/lift) }],
  sea:      { x, z, y, front: [fx, fz] } | null,   // island: the IL abutment at the coast; Commons: the sea junction
  holes:    [[[x, z], ...]]                        // (as built) the Island Link's portal trench: worldgeom cuts these too
}
layers.gondola = { lines: [{ id: "G1", kind: "summit"|"crossing", stations: [{ id, x, y, z, front: [fx, fz] }],
                   towers: [{ x, y (foot), z, h (cm) }], tier }] }       // worldlines: backend/src/worldgen/gondola.rs
```
Rust signatures (`worldlines` provides; `worldgen` calls them from `mod.rs` for version 3 only):
```rust
pub struct Ctx<'a> { pub seed: u64, pub profile: &'a Profile, pub terrain: &'a Terrain, pub roads: &'a Roads,
                     pub lots: &'a [Lot], pub sites: &'a [Site], pub river: Option<&'a River>,
                     pub water: &'a [Vec<[i64; 2]>],          // every water polygon (bodies, river), cm
                     pub coast: Option<&'a [[i64; 2]]> }      // the island coast polygon, cm (None on @1)
pub struct Claim { pub kind: &'static str, pub id: String, pub x: i64, pub z: i64, pub poly: Vec<[i64; 2]>,
                   pub front: [i64; 2], pub tier: u8, pub lot: Option<u32> }   // lot: a non-hq lot to retype
metro::plan(&Ctx) -> Result<(metro::Metro, Vec<Claim>), String>
railway::plan(&Ctx, metro: &metro::Metro) -> Result<(railway::Rail, Vec<Claim>), String>
gondola::plan(&Ctx, taken: &[Claim]) -> Result<(gondola::Gondola, Vec<Claim>), String>
```
As built (integration notes from `worldlines`): metro and rail station `y` is the rail level (clients put the platform
1.1 m above it); Central is two metro station records at the same x, z (one per line, each its own `y` and `along`, at
right angles, both `platform: "island"`, both listing the same entrances); where an island's streets cannot fit four
stations 450-800 m apart, one line has 3 (the Commons always has at least 4 on both); gondola station `y` is the deck
(cable) level and a tower's `y` its foot; `HQV.world.holesOf` merges `metro.holes`, the entrance and portal holes and
`rail.holes`.

`worldgen` applies the claims (sites of kind `metro`, `metro-entrance`, `rail`, `gondola`, `depot`; a claimed lot
is removed from the lot list as civic does), in this order: water (its own, before streets) -> metro -> railway ->
gondola. A claim never takes an `hq` lot (the planner checks; `worldgen` asserts).

### 5.2 `HQV.world` additions (part `worldclient`, `games/world.js`)

```
HQV.world.LIVE_V = 3;  HQV.world.COMMONS = "claude-hq@3";  HQV.world.COMMONS_V2 = "claude-hq@2";
HQV.world.islandId(uid, v?) -> "user:<uid>@3" | null       HQV.world.isLive(id) -> bool (@1, @2, @3 forms)
HQV.world.ownerOf(id) -> uid | "commons"                    HQV.world.versionOf(id) -> 1|2|3|0
// metre views of the new layers, memoised on W (null when the doc has none):
HQV.world.waterOf(W) -> {bodies: [{id, kind, poly: [x, z, ...] (m), level, bed, edge, islands, joins, tier,
                          box: {x0, z0, x1, z1}}], piers: [{id, body, kind, x, y, z, yaw, len, w, tier}],
                          berths, breakwater, lighthouse, net: {nodes: [[x, z]], edges}, routes}
HQV.world.metroOf(W)  -> same shape as layers.metro in metres, yaw from `front`/`along`
HQV.world.railOf(W)   -> layers.rail in metres
HQV.world.gondolaOf(W)-> layers.gondola in metres
HQV.world.waterAt(W, x, z) -> body | null      // on a water body (not a pier, pontoon, island or breakwater)
HQV.world.holeAt(W, x, z) -> bool              // inside a terrain hole
```
`world.pack/unpack` carry the four layers through the worker build. `blockedAt` and the walk test treat water as
blocked and piers as walkable; `HQV.ocean.seaOf(doc)` treats bodies as water and piers, pontoons and the
breakwater as land.

### 5.3 The Service contract (every scheduled mode)

```
HQV.<mod>.create(W, {tier, seed}) -> sim                     // pure, memoisable; W = the packed world
sim.mode                       // "bus"|"tram"|"metro"|"rail"|"link"|"ferry"|"gondola"
sim.lines() -> [{id, mode, name, short ("T1","M2","CL","IL","W1","G1"), color ("#rrggbb", canvas only),
                 stops: [stopId...], headway (s), loop: bool}]
sim.stops() -> [{id, name, x, y, z, mode, lines: [lineId...], kind: "stop"|"station"|"pier", under: bool}]
sim.stopsNear(x, z, r) -> [{id, name, dist, mode, lines}] sorted by dist then id
sim.departures(stopId, ms, n) -> [{line, short, to (stop name), at (ms), plat ("1"|"2"|null), boarding, delay (s)}]
sim.trip(lineId, fromStop, toStop, ms) -> Trip | null
sim.vehicles(ms) -> [{id, line, mode, x, y, z, yaw, speed, doors (0..1), load (0..1.15), under: bool}]
Trip = {mode, line, short, vehicle, from, to, fromName, toName,
        arrive (ms at the from stop), depart (ms), reach (ms), stops: [{id, name, at}],
        seats: N, standing: N,
        pose(ms) -> {x, y, z, yaw, pitch, speed, doors (0..1), under: bool, done},   // floor centre
        seat(i, ms) -> {x, y, z, yaw},                // seat i (or standing spot N + j) in world space
        door(ms) -> {x, z},                           // the door you use
        world?: string}                               // link trips only: the destination world id
```
`traffic.js` keeps `stopsNear / nextArrival / rideTo` and adds `traffic.service(sim, "bus"|"tram")` and the pure
`traffic.lanes(W)` (tram and bus lane offsets per edge, the same numbers the sim drives on).

### 5.4 View contract (every mode that draws)

```
HQV.<mod>.view(c, sim, opts) -> V   // c = hq3d's ctx (THREE, scene, ...); opts = {calm(), night(), sfx, under()}
V.update(ms, dt, cam{x, y, z})      // per frame; LOD by camera distance
V.focus(vehicleId | null)           // swap that vehicle to its detailed interior (seats, doors)
V.drawCalls() -> n
V.tools = {shotCam(name) -> {pos, look, fov} | null}   // fixed cameras for the screenshot tour
V.dispose()
```

### 5.5 hqRide (part `ride`)

```
HQV.hqRide.register(service) / unregister(mode) / services() -> [service]
HQV.hqRide.stopsNear(x, z, r) -> merged across services
HQV.hqRide.plan(from{x, z}|{stop}, to{x, z}|{stop}|{world}, ms, opts{modes?}) -> [{legs: [{mode: "walk", from,
        to, secs} | {mode, line, short, from, to, depart, reach, world?}], depart, reach, changes}]
        (at most 3, fastest first; walking 1.4 m/s; a change takes at least 60 s; underground stops add 45 s)
HQV.hqRide.session(opts) -> S
  opts = {trip, view (V), announce(text), toast(text), sfx(name), calm(), me() -> {x, z}, userId, onEnd(reason),
          under(on) (the integrator's underground switch), travel(trip) (link trips: hand over to hqTravel)}
  S.phase "walk"|"wait"|"board"|"seated"|"standing"|"alight"|"done"|"cancelled"
  S.step(ms, me);  S.carry(ms) -> {x, y, z, yaw, anim: "sit"|"stand"|"walk"|"idle", hands?: "rail"} | null
  S.camPose(ms, look{yaw, pitch}, mode: "seat"|"window"|"chase") -> {camera: true, pos, look, up, fov} | null
  S.requestStop() / S.alightNext() / S.cancel();  S.info() -> {mode, line, short, nextStop: {name, at}, to, reach, seat, standing, under}
HQV.hqRide.seatCam(seatPose, vehiclePose, look, mode, calm) -> camPose      // pure; used by cabs, heli, gondola
HQV.hqRide.stationName(W, x, z, kind) -> string                            // pure, unique per world
HQV.hqRide.boardTexture(THREE, rows, opts) -> {texture, draw(rows)}
HQV.hqRide.sfx(audioCtx, name, opts)
HQV.hqRide.announcer(opts{announce, voiceOn()}) -> {say(text, {chime})}     // local voices only
HQV.hqRide.tickets -> {add(t) -> t, list() -> [...], remove(id)}           // free tickets, localStorage
HQV.hqRide.achievements -> {record(event), list() -> [{id, name, desc, done, progress}], onUnlock(fn)}
```

### 5.6 hqCommute (part `ride`)

```
HQV.hqCommute.curve(hourLocal) -> 0.08..1.15
HQV.hqCommute.load(mode, lineId, vehicleId, ms, seed) -> 0..1.15
HQV.hqCommute.occupied(mode, vehicleId, tripKey, seats, standing, ms, seed) -> {seats: [i...], standing: [j...]}
HQV.hqCommute.crowd(stopId, mode, ms, seed) -> 0..24
HQV.hqCommute.figures(THREE) -> {seated, standing: BufferGeometry, material}
HQV.hqCommute.paint(seedKey) -> {shirt: [r, g, b], hair, skin}
```

### 5.7 Underground (part `metro`)

```
HQV.hqMetro.create(W, {tier, seed}) -> sim (Service, mode "metro")
HQV.hqMetro.view(c, sim, opts) -> V (5.4) plus:
  V.surface()               // entrances, portals, depot, trains in the open (always on)
  V.underground(on)         // build/show the tunnel and station interiors around the camera
  V.isUnder(x, y, z) -> bool          // inside a station or tunnel volume
  V.entranceAt(x, z, r) -> {id, station, kind} | null; V.exitTo(stationId) -> {x, z, yaw}  // street side
  V.walkable(x, y, z) -> {y} | null   // floor under (x, z) inside the underground (platforms, halls, stairs)
HQV.hqUnderground = {under(): bool, set(on, reason)}   // integrator implements: hide/show the surface groups
```

### 5.8 Phone (part `phone`)

```
HQV.hqPhone.mount(stageEl, host) -> {open(appId?), close(), isOpen(), owns(e), toggle(), badge(appId, n), notify({app, title, text}), dispose()}
Apps register in a queue (load order does not matter):
  (HQV.hqPhoneQueue = HQV.hqPhoneQueue || []).push({id, name, order, glyph (SVG path d), dock: bool, needsCity: bool,
     render(el, host, nav) -> {dispose?, onKey?(e) -> bool, tick?(ms)}, badge?(host) -> n})
  nav = {back(), open(appId, arg), title(text), setBadge(n)}
host (built by the integrator) = {
  announce, toast, now(), clock() -> {h, m}, calm(), reducedMotion(), inCity() -> bool,
  me() -> {x, z, world, owner, tier, userId},
  ride: HQV.hqRide, session() -> S | null, startRide(planOrTrip) -> S, places() -> [{id, name, x, z, kind}],
  cabs (5.9 controller), heli (5.10 controller), water: {taxi(fromPier, toPier) -> handle, hire(jettyId, kind)},
  vehicles: {list() -> items with tags, call(id), state()}, dealer: {mount(el, onDone)},
  air: {flights(ms) -> [...], checkIn(flight) -> {seat, gate, boardsAt}},
  travel: {link(toWorld) -> handle}, photo() -> Promise<Blob>, selfie(on), track(vehicleId),
  social: window.hqPhoneSocial (5.11), sfx(name), netCan(cap)
}
```

### 5.9 hqCabs (part `cabs`)

```
pure: classes() -> [{id: "bike"|"go"|"cab"|"xl"|"lux"|"heli"|"water", name, seats, vehicleCat}]
      quote(W, from, to, cls, ms) -> {cls, metres, secs, eta (s)}
      driverFor(seed, rideKey) -> {name, rating, plate, modelId, paint}
      requests(W, ms, seed) -> [{id, pickup{x, z, yaw}, drop{x, z, name}, metres, expires}]   // driver mode
      rateDrive(log) -> 1..5;  scoreTrip(log) -> {points, stars}
      driverStats() -> {score, fares, rating}   // localStorage
controller: HQV.hqCabs.mount(c, w, deps) -> {request(dest, cls) -> handle, cancel(), state(),
      driver: {on(bool), offers(), accept(id), state()}, carry(ms), camPose(ms, look), update(ms, dt), drawCalls(),
      tools: {shotCam(name)}}
handle.state(): "matching"|"coming"|"here"|"riding"|"done"|"cancelled" with {eta, metres}
deps = {call: HQV.hqCall, route, announce, sfx, calm, models: HQV.hqVehicleModels, catalogue, heli: HQV.hqHeliCall,
        water: host.water}
```

### 5.10 hqHeliCall (part `cabs`)

```
pure: spots(W, x, z, r, extra{roofs}) -> [{id, x, y, z, kind: "pad"|"open", name, dist}]
      path(from{x, y, z}, to{x, y, z}, opts) -> {len, T, pose(t) -> {x, y, z, yaw, pitch, roll, rotor}}
controller: mount(c, w, deps) -> {call(spot, {own: vehicleId | null}) -> handle, fly(dest), carry(ms),
            camPose(ms, look), update(ms, dt), drawCalls()}
```

### 5.11 Social (part `social`)

```
window.hqPhoneSocial = {
  enabled() -> {smsSend, near, calls},  setEnabled(key, on) -> Promise
  sms: {threads(), thread(userId) -> [{me, text, at, state: "sent"|"delivered"}], send(userId, text) -> Promise,
        block(userId, on), blocked(), mute(userId, on), muted(), report(userId, msgId), directory(q) -> Promise<[{id, name, handle}]>,
        onChange(fn), unread() -> n}
  near: {post(text), feed() -> [{from, name, text, at, dist}], onChange(fn), bubbles() -> [{userId, text, until}]}
  calls: {contacts() -> [{id, name, online}], ring(userId) -> callHandle, onIncoming(fn), recent()}
}
Arena routes (device token; proxied by dashboard-rs as /api/arena/sms/*):
  POST /v1/sms/optin {on}               -> {on}                (sending opt-in; receiving needs none)
  GET  /v1/sms/me                       -> {on, blocks: [userId], unread}
  POST /v1/sms/send {to, text}          -> {ok: true, id}      (≤160 printable chars; 10 a minute, 100 a day; always
                                                                 ok when the recipient blocked you: no block oracle;
                                                                 409 when you have not opted in)
  GET  /v1/sms/inbox?since=<id>         -> {messages: [{id, from: {id, name, handle}, text, at}]}   (kept 7 days)
  POST /v1/sms/ack {upto: id}           -> {ok}                (delivered ticks; deletes acked messages)
  GET  /v1/sms/status?ids=a,b           -> {delivered: [ids]}  (sender's ticks)
  POST /v1/sms/block {user, on}         -> {blocks}
  POST /v1/sms/report {user, id}        -> {ok}
  GET  /v1/sms/directory?q=<handle prefix, ≥2 chars> -> {users: [{id, name, handle}]}  (≤10, active users)
WS (main.rs, hq rooms):
  {type: "near_on", on}                       opt in to nearby chat on this socket
  {type: "say", data: {kind: "near", text}}   relayed only to opted-in members of the same room within 40 m (the
                                              valley's last position for each), ≤200 chars, the chat rate limit
  {type: "ring", to, id} / {type: "ring_ans", to, id, ok}  to the target's sockets in the room only; 6 a minute
  then the existing {type: "signal"} for SDP/ICE
Presence caps (protocol.rs): "transit": a = 14 (a seated passenger) with tk (mode code 1..9) and tv (vehicle id,
  ≤24 chars); "phone": the near / ring messages.
```

## 6. Parts (built in parallel; no two parts own the same file)

| key | title | owns |
|---|---|---|
| worldgen | @3 generator core and water | `backend/src/worldgen/{mod,profile,terrain,river,island,civic,transit,city,zones,districts,roads}.rs`, `backend/src/worldgen/organic/*`, `backend/src/worldgen/{tests,civic_tests,island_tests,river_tests}.rs`, new `backend/src/worldgen/water.rs`, new `backend/src/worldgen/water_tests.rs`, new `backend/src/worldgen/v3_tests.rs`, `backend/src/bin/worldgen.rs`, `tools/world_fixture.py`, `tools/worldgen_view.html`, `tests/fixtures/claude-hq@3.json.gz`, `tests/fixtures/island@3.json.gz` |
| worldlines | @3 metro tunnels, City Line, Island Link, gondola | new `backend/src/worldgen/metro.rs`, `railway.rs`, `gondola.rs`, `lines.rs` (the shared `Ctx` / `Claim`), `lines_tests.rs` |
| arena | Live worlds @3, max level, free transit | `backend/src/world.rs`, `archipelago.rs`, `cities.rs`, `cities/tests.rs`, `rail.rs`, `vehicles.rs`, `garages.rs`, `market.rs`, `backend/migrations/0024_live_v3.sql`, all of `dashboard-rs/src/*` |
| social | SMS, nearby, calls end to end | new `backend/src/sms.rs`, `backend/migrations/0025_phone.sql`, `backend/src/main.rs`, `backend/src/protocol.rs`, `backend/src/rooms.rs`, `backend/src/valley/hq.rs`, `ui/app/41-phone.js`, `ui/app/16-settings.js`, new `games/hqphonecomms.js`, `tests/test_protocol.py`, new `tests/test_hqphonecomms.py` |
| worldclient | World client: new layers, water, holes, live ids, minimap | `games/world.js`, `games/worldgeom.js`, `games/worldbuild.js`, `games/worldbuild-worker.js`, `games/ocean.js`, `games/hqminimap.js`, `games/hqminimap.css`, tests `test_world.py`, `test_worldgeom.py`, `test_worldgeom_poly.py`, `test_ocean.py`, `test_hqminimap.py`, new `test_world_v3.py` |
| streets | Tram tracks, buses and trams you ride | `games/traffic.js`, new `games/hqtramway.js`, new `games/hqcoach.js`, `tests/test_traffic.py`, `tests/test_traffic_solid.py`, new `test_hqtramway.py`, `test_hqcoach.py` |
| ride | Ride core, commuters, NPC riders, cameras | new `games/hqride.js`, `games/hqcommute.js`, `games/npcsim.js`, `games/npcdraw.js`, `games/camrig.js`, `tests/test_npcsim.py`, `test_npcdraw.py`, `test_camrig.py`, new `test_hqride.py`, `test_hqcommute.py` |
| metro | Metro and the underground view | new `games/hqmetro.js`, `games/hqunderground.js`, `tests/test_hqmetro.py`, `tests/test_hqunderground.py` |
| rail | City Line, Island Link, gondola, world travel | `games/hqrail.js`, `games/hqtravel.js`, new `games/hqcityrail.js`, `games/hqgondola.js`, `tests/test_hqrail.py`, `test_hqtravel.py`, new `test_hqcityrail.py`, `test_hqgondola.py` |
| water | Water bus, launch, water taxis, boat hire | new `games/hqferries.js`, `games/hqboat.js`, `games/hqvoyage.js`, `tests/test_hqboat.py`, `test_hqvoyage.py`, new `test_hqferries.py` |
| cabs | Claude Cabs, heli calling, call filters, dealership | new `games/hqcabs.js`, `games/hqhelicall.js`, `games/hqphonecabs.js`, `games/hqcall.js`, `games/hqdealer.js`, `games/hqnav.js`, `tests/test_hqcall.py`, `test_hqdealer.py`, `test_hqnav.py`, new `test_hqcabs.py`, `test_hqhelicall.py` |
| phone | Phone shell, transit apps, camera, gallery, patch notes | new `games/hqphone.js`, `games/hqphone.css`, `games/hqphoneapps.js`, `games/hqgallery.js`, `games/patchnotes.json`, new `tests/test_hqphone.py`, `test_hqgallery.py` |

**Owned by nobody in Build (the integrator's)**: `games/hqcity3d.js`, `games/hq3d.js`, `games/avatar3d.js`,
`games/hqcivic.js`, `ui/app/22-hq.js`, `ui/app/09-drawer.js`, `index.html`, `ui/hq.css`, every other test
(`tests/test_hq3d_integration.py`, `tests/test_hqcity3d.py`, `tests/test_cities.py`, fixtures under
`tests/fixtures` except the two new @3 fixtures), `tools/ui_smoke.py`, `tools/airport_smoke.py`,
`tools/airfield_fixture.js`, new `tools/transit_tour.py`, `README.md`, `AGENTS.md`, `CONTRIBUTING.md`,
`APP_VERSION` (`dashboard-rs/src/app.rs` after `arena` hands it over), `backend/src/lib.rs`.

A part that needs something from a file it does not own writes it under **Integration notes** in its final
report (exact code, where it goes) and does not edit the file. `worldgen` adds `pub mod lines; pub mod metro;
pub mod railway; pub mod gondola;` and `#[cfg(test)] mod lines_tests;` to `mod.rs` **only after** `worldlines`
has created those files (`worldlines` creates compiling stubs with the final signatures as its first action).
`social` adds `mod sms;` and its routes in `main.rs` (it owns `main.rs`).

## 7. Integration (after Build)

1. `tools/world_fixture.py` -> the @3 fixtures with all four layers; rerun every suite.
2. Hub wiring in `hqcity3d.js` / `hq3d.js` / `22-hq.js` / `09-drawer.js` / `index.html` (`HQ_SCRIPTS` and
   `HQ_SCRIPTS_3D` gain, before `hqcity3d`: `hqride, hqcommute, hqtramway, hqcoach, hqmetro, hqunderground,
   hqcityrail, hqgondola, hqferries, hqcabs, hqhelicall, hqphone, hqphoneapps, hqphonecabs, hqphonecomms,
   hqgallery`; `hqphone.css` linked).
   - Live ids from `HQV.world`; the @3 -> @2 -> @1 fallback chain; `/assign` on the live Commons.
   - Register every Service with `hqRide`; views in `setupLife`; the `w.carry` / `w.camPose` / `w.use` chain gets
     one link per mode (`hqRide` session first, then cabs, heli, water taxi, then the existing chain); `S` key;
     `V` cycles seat cameras; remove `payFare` (D4).
   - `HQV.hqUnderground.set(on)`: hide terrain tiles, buildings, sky, sea and weather; set a dark fog and the
     underground lights; show `V.underground(true)`; the avatar's ground comes from `V.walkable`. Entrances are E
     targets and walk-in triggers; exits teleport to the street side.
   - Seated pose for passengers (`anim: "sit"`, `hands: "rail"`) in `moveAvatar` / `avatar3d`; peers with
     `a = 14` drawn seated at their `tv` vehicle.
   - The phone: mounted beside `callUi`, in the `onKey` owns-chain, Backquote / `I`, the button, Cmd-K entry,
     `#phoneBack` in `currentModal()`; the `host` object (5.8) built from the hub's state.
   - `HQ3D_DEBUG.transit` (8) and `smokeStats` sums of every `drawCalls()`.
3. README changelog 3.15.0 (privacy call-out: SMS, nearby chat and calls are new egress, opt-in to send), AGENTS.md
   invariant 2 updated, `APP_VERSION` 3.15.0, `games/patchnotes.json` entry.
4. Full suite: `python3 -m unittest discover -s tests`, `cargo test` + clippy in `backend` and `dashboard-rs`,
   `tools/ui_smoke.py`, then the tour.

## 8. Screenshot tour (integrator, `tools/transit_tour.py`)

Headless Chrome via `tools/ui_smoke.py` (`Chrome`, `Page`, `start_server`, `FakeArena` serving the @3 fixtures),
on a free port (never 8765), `/?hqsmoke=1&hqperf=1`. The integrator adds `HQ3D_DEBUG.transit`:
```
transit.go(placeOrStopId) | board(mode, lineId, fromStop, toStop, ms) | phase() | seatCam(mode) | freeze(ms)
transit.under(on) | shot(module, name) (uses that view's tools.shotCam)
transit.phone(appId, arg) | phoneClose() | cab(cls, dest) | cabDriver(on) | heli(spotId) | water(kind) | link(world)
```
Every shot records draw calls, errors and overlapping or offscreen UI (like `scratchpad/sc_nav.py`, its copy
pointed at the worktree). The shot list with captions is in the build workflow's `tour` field.

## 9. Order of work and risks

1. Build: all 12 parts in parallel; each runs its own tests green against synthetic fixtures (and against the @3
   fixtures when they exist, skipping when they do not) and reports integration notes.
2. Integrate (section 7), then the tour, then the budget check against `smokeStats`.
- **Risk: @3 moves every lot.** Mitigated by rank-based HQ placement, the migration resetting parked spots, and
  the @2 fallback for older Arenas and clients.
- **Risk: the underground view.** Hiding the surface is a hub change; `hqUnderground` keeps it to one switch.
  Terrain holes are polygon cuts in tile triangles, not heightfield edits.
- **Risk: parallel Rust builds in one crate.** Separate target dirs; wait-and-retry on another part's
  half-written file; `worldlines` stubs first.
