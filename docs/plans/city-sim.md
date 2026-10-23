# Living City: curved roads and a city that actually runs

Two upgrades to the 3D City, built together:

1. **Roads with real curvature.** Smooth bends instead of 24 m straight pieces, rounded corners at junctions.
2. **An NPC city simulation.** The police station, fire stations, hospital, clinics, school, stadium, market, post
   office and amusement park stop being scenery. Fires break out and get put out, ambulances carry patients to the
   hospital, police patrol and chase getaway cars, buses fill up at rush hour, fans pour into match days, kids walk
   to school, vans deliver, crowds gather at incidents and at the fireworks. The city reports it all on a news ticker.

Everything is client-side, deterministic from the world doc + the UTC clock (every player sees the same fire at the
same moment, as the trains and the fireworks already are), node-tested, Calm-aware, inside the frame budgets.

---

## What exists (from the code survey)

- **Roads.** @2 cities: 98.5% of edges are straight resamples between graph nodes 24 m apart (organic/streets.rs
  `ART_STEP_CM`); 222 degree-2 nodes per city with kinks up to 60°+; junctions are triangle fans with straight-chord
  corners (worldgeom.js `junction()`). Highways and the ring are already curved (A* over terrain). The server pins
  `claude-hq@2` by hash and lots are bound to users (`commons_lot`), so the generator must not change.
- **Residents** (npcsim.js): up to 2,000, homes, jobs at every civic kind (police shifts, fire crews, nurses, school,
  stadium stewards), walk / bus / car, lunch, errands, parks; A* on their own road graphs; drawn by npcdraw.js
  (30 skinned near, 120 instanced far). Drivers are invisible; bus riders invisible. `sim.at` is O(N) per call.
- **Traffic** (traffic.js): collision-free ring schedules; buses and trams on a timetable; **fire, ambulance and
  police runs already exist** (`rawIncident`, a seeded 240 s window, one run at a time, cars pull over, sirens
  flash) but `incidents()` is unused: no scene, no fire, no patient, no toast.
- **Civic buildings** (hqcivic.js): drawn per kind with parked engines/ambulances; only the police lamp blinks.
- **Fireworks** (hqspectacle.js `showAt`, UTC, every 8 min at night), weather (hqweather.js, UTC 15-min slots).
- **Hooks**: `say()` (toast + announce), minimap `frame()` (no dynamic markers), `engine.sfx` (no siren).

## Part 1: Roads (games/roadsmooth.js + world.js / worldgeom.js)

**Approach: smooth on the client, once, in `world.js pack()`** (`PACK_V` 4 → 5), so every consumer — physics
(`roadUnder`, `groundAt`, `nearestRoad`), rendering (worldgeom), traffic and npcsim (`docOf` points), navigation
(hqnav), the minimap, labels — reads the same curved geometry. Node ids and node positions never move, so transit
lines, nav and saved routes stay valid. The server generator, its hashes and every lot stay exactly as they are.

`HQV.roadSmooth` (pure):
- `smooth(W, opts) -> W` (in place; keeps `e.pts0`): for each non-bridge edge:
  - **Chains through degree-2 nodes** of the same class are smoothed together, so a 6-edge arterial becomes one
    continuous curve split back at the original nodes (each edge keeps its own nodes as endpoints).
  - **Centripetal Catmull-Rom** through the chain's vertices, then **arc-length resample at 3 m**.
  - **Deviation cap**: no point moves more than `0.45 × half-width` (arterial 2.7 m, local 1.8 m) from the original
    polyline — lots were inset by half the width + 25 cm, so curves never reach a lot. Over the cap, the curve is
    pulled back toward the polyline (blend) at that span.
  - **Kink fillets**: where a degree-2 node turns more than 25°, the corner becomes a circular arc whose radius is the
    largest that keeps the deviation cap and fits in 45% of either arm.
  - Heights: y is interpolated along the original segment's arc (the server's graded y), so grades stay smooth and
    bridge ramps are untouched. Bridges (`e.bridge`) and their two adjoining 30 m are left straight.
- `junctionCorners(W, node, arms) -> [{a, b, r, pts}]`: fillet arcs between neighbouring arms at 3+ way junctions
  (radius by class: arterial 9 m, local 6 m, ring/highway 14 m), for rendering only.

world.js: `pack()` calls `roadSmooth.smooth(W)` when present (feature-detected; without it, today's roads).
worldgeom.js: `junction()` draws the asphalt fan and the corner kerbs/sidewalks along `junctionCorners` arcs instead
of straight chords; `prep` no longer trims arms at degree-2 nodes the smoothing removed (no visible kink patch).
traffic.js needs no change (it reads `docOf` points; its Bezier turns remain at 3+ junctions); its degree-2 "boxes"
become needless and are skipped when the turn there is under 10°.

Tests (tests/test_roadsmooth.py on both fixtures): deviation ≤ cap everywhere; no smoothed point inside a lot or
site rect; endpoints = original nodes; max heading change between 3 m samples ≤ 12° on locals, 8° on arterials (no
kinks left); bridges byte-identical; deterministic. Existing test_world / test_worldgeom / test_traffic / test_hqnav
suites updated where they assumed straight edges.

## Part 2: The city simulation

### 2.1 The event director: games/citysim.js (pure)

`HQV.citySim.create(doc, {seed, tier, coverage}) -> D` — all events are pure functions of (world, UTC ms):

- `D.events(fromMs, toMs) -> [Ev]`, `D.active(ms) -> [Ev]`, `D.phase(ev, ms) -> phase`, `D.at(ms) -> state`
- `Ev = {id, kind, start, end, x, z, node, site, lot, street, severity 1..3, label,
         units: [{kind, station (site id), dispatch, arrive, leave, back}], dest? (hospital site id), route? }`
- Phases: `reported → responding → onscene → clearing → done` (per unit timing from road distance / speed).

Event kinds (rates scale with tier and with service coverage — poor fire cover means more and longer fires):

| kind | where | units | what you see |
|---|---|---|---|
| `fire` | a building lot (not an HQ) | 1-3 fire engines from the nearest fire stations, + police at severity 3 | smoke column then flames from the roof, engines parked with ladders up and hoses, a cordon, a crowd |
| `medical` | a resident on a street / at a workplace | ambulance from the nearest hospital/clinic, then to the hospital | resident down, paramedics, stretcher, ambulance to the hospital's bay |
| `crime` | the bank, the market, the mall or a shop lot | 2-3 police; a getaway car | alarm, getaway car flees along a seeded route at speed, police chase with sirens, roadblock, arrest at the end |
| `crash` | a junction | police + tow truck (+ ambulance at severity 2+) | two cars stopped askew, hazard lights, a tow |
| `patrol` | loops through the city | police cars, continuous | patrol cars cruising their beat (traffic) |
| `match` | the stadium | buses (extra), police | 3 per week, 2 h; fans walk in 45 min before, roar, floodlights, everyone leaves after |
| `market` | the market | vans | market days (Sat/Wed mornings): stalls busy, shoppers |
| `school` | schools | school buses | school days 08:00 / 15:00: kids walking in, buses |
| `delivery` | post office, market, mall | vans | vans run their rounds (traffic) |
| `festival` | the amusement park, town hall plaza | — | weekend evenings; ties into the fireworks schedule (crowds before each show) |
| `rush` | everywhere | buses | 07-09 / 17-19: more cars and full buses |

Shared clock: UTC windows seeded from `hash(world id, kind, window)` (as traffic's `rawIncident`), so every client
agrees. Local "day" events (school, market, match, rush) use the **city's own time zone** — a fixed offset derived
from the world (default UTC; the Commons uses the server's), so all players share the same schedule.

### 2.2 Traffic: games/traffic.js

- Emergency runs take their station, scene and timing **from citysim** (`incident` reads `D.active`), replacing the
  random 240 s window: fire engines to the fire (several), ambulance scene → hospital, police to crimes/crashes.
- **Chases**: a getaway car on a seeded fast route (`route(evLanes)`) with 2-3 police following 3-6 s behind on the
  same path; everything yields; ends at a roadblock node.
- **Patrols**: 2-4 police cars on looping beats (per tier) through arterials.
- **Service vehicles**: tow truck, post vans, school buses, delivery vans: new `SPEC` kinds, instanced like the others
  (within `CAP` and the draw budget).
- Rush hour density: ring speed profiles weighted by `D.at(ms).rush`.

### 2.3 Residents: games/npcsim.js

- Reactive states from citysim (pure): `gawk` (residents within 120 m walk to the cordon and watch), `patient`
  (the medical event's resident lies down, then rides the ambulance), `fan` (match days: residents with tickets walk
  to the stadium, inside during the match, walk home after), `pupil` (children: school days), `shopper` (market
  days), `festival` (crowds to the park before shows).
- Workers respond: firefighters and police on shift are drawn at their station's bay when a run starts.
- `speak()` lines from the events: "Did you see the fire on Elm Street?", "Big match tonight!", "They caught the
  robbers on the ring road!".
- Perf: `sim.at` gets a spatial/time bucket index (O(visible), not O(N)), so crowds don't cost frame time.

### 2.4 What you see and hear: games/citysimfx.js

- Fire: an instanced smoke column (billboards, rising, wind from the weather) and flames on the roof edge, embers at
  night; dies down as the engines work (phase `clearing`), a blackened roof for an hour after.
- Scene dressing: cordon tape + cones (one instanced mesh), parked emergency vehicles with beacons (from traffic's
  models), a stretcher, the crash cars askew with hazards, a roadblock with stingers.
- Lights: emergency beacons light the street at night (additive sprites, no real lights).
- Sound (engine.js): `siren(kind)` — wail/yelp for police, hi-lo for ambulances, an air horn for engines — with
  distance falloff (as fireworks) and a Doppler bend from relative speed; crowd roar at the stadium; a fire's crackle.
  All gated by the sound settings; **Calm: no flashing beacons, no sirens' wail (a soft tone), no flicker**.
- Budget: ≤ 12 draw calls for all scene effects; nothing beyond 600 m from the camera.

### 2.5 The civic buildings: games/hqcivic.js

- Fire station: bay doors roll up and the parked engine leaves while its engine is out (and returns).
- Hospital: the ambulance bay empties; a helipad beacon; "emergency" sign lit at night.
- Police: lamps blink faster when units are out; parked cars leave.
- Stadium: floodlights and crowd noise on match nights; scoreboard text (canvas, textContent rules).
- School: a bell at 08:00 / 15:00, kids in the yard.

### 2.6 The news: games/citynews.js + minimap

- A ticker (top of the City HUD): "🚒 Fire at 12 Elm Street — 3 engines responding", "🚓 Bank robbery: chase on the
  ring road", "🏟️ Match tonight 19:00", updated from citysim (textContent only; announce for screen readers,
  rate-limited).
- Minimap: alert markers at active events (fire/medical/crime/crash icons, pulsing unless Calm); Go to → "Incidents".
- Toast when an event starts within 400 m of you.

### 2.7 City stats

`cityStats` coverage drives event rates and response times (better coverage: fewer fires, faster arrivals); a
resolved incident nudges happiness; the town hall shows the week's incidents and response times.

## Contracts (so the parts are built in parallel)

```
HQV.roadSmooth = {smooth(W, opts) -> W, junctionCorners(W, nodeId) -> [{pts: [[x, z], ...], r}], CAP: 0.45}
HQV.citySim   = {create(doc, {seed, tier, coverage, tzMin}) -> D, KINDS}
  D.events(fromMs, toMs) -> [Ev]; D.active(ms) -> [Ev]; D.phase(ev, ms) -> "reported"|"responding"|"onscene"|"clearing"|"done"
  D.at(ms) -> {rush: 0..1, match: Ev|null, market: Ev|null, school: Ev|null, festival: Ev|null}
  D.unitsAt(ms) -> [{ev, unit, phase, from: {x, z}, to: {x, z}}]   (for traffic + civic)
  Ev as in 2.1; units[].kind in "fire" | "ambulance" | "police" | "tow" | "van" | "schoolbus" | "getaway"
HQV.citySimFx = {create(c, W, D, o: {scene, ground(x, z), say, calm()}) -> {update(ms, dt, cam), setNight(n), drawCalls(), destroy()}}
HQV.cityNews  = {create(stage, D, o: {say, me() -> {x, z}}) -> {update(ms), alerts(ms) -> [{x, z, kind}], destroy()}}
engine.sfx: "siren" with opt {kind: "police"|"ambulance"|"fire", dist, approach (m/s)}; engine.siren(kind) -> {set(dist, approach), stop()}
traffic.create(doc, {..., city: D}) uses D.unitsAt for emergency vehicles; new SPEC kinds tow, van, schoolbus, getaway
npcsim.create(doc, {..., city: D}) reacts to D.active / D.at; sim.at(t, c, r) stays the output contract
hqcivic build(...).animate(t, dt, k, units) gets D.unitsAt(ms) filtered to its own site
hqminimap frame({..., alerts: [{x, z, kind}]})
```

## Build plan (a workflow)

1. **Build, in parallel** (each part its own files + its own tests; no two parts edit the same file):
   roadsmooth.js · citysim.js · traffic.js · npcsim.js · citysimfx.js + engine.js siren · hqcivic.js · citynews.js +
   hqminimap.js alerts.
2. **Integrate**: roads into world.js / worldgeom.js (+ their tests); the sim into hqcity3d.js, hq3d.js and the
   script list (ui/app/22-hq.js + test_hq3d_integration).
3. **Verify**: the full test suite, tools/ui_smoke.py (frame budgets), and a headless Chrome tour (an incident from
   start to finish, a chase, a match day, the curved roads from above) with screenshots; fix until green.
4. **Review**: independent reviewers (correctness/determinism, perf/budgets, house rules/accessibility/Calm), then
   fixes.

## Out of scope (for later)

Server-generated curved roads and roundabouts (a new world version, `@3`); residents synchronized across time zones
(npcsim still runs on each player's local clock; events run on the city's clock); player roles (being a
firefighter or police officer).
