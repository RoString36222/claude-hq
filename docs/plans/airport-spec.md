# The Commons airport: build spec (HQ 3.x)

This spec is the contract for parallel builders. It replaces the current airport, a 24 m glass box on a 40 m site, a 37 m "runway" patch painted across it, and a separate 500 m deck that the jets fly, which runs through the air base's hangars, Ring Road 5 and the carrier. The replacement is one airfield that is drawn, walked on and flown from a single layout.

Read `AGENTS.md` first. House style applies everywhere: `var`, defensive guards, `textContent` only, no `Math.random()` for anything seen twice, frame-rate independent easing (`k = 1 - Math.exp(-rate*dt)`), and no build step.

Reference files committed with this spec:
- `tools/airfield_fixture.js` is the reference generator for the Commons layout (`node tools/airfield_fixture.js . tests/fixtures/airfield_commons.json`).
- `tests/fixtures/airfield_commons.json` is its output: the exact layout `L` (section 3) for `claude-hq@2`. Every builder codes and tests against this file. `HQV.hqAirfield.layout()` must reproduce it.

**Revision 2 (review against the research and the code).** What changed from the first draft, so nobody builds against the old text:
- **6 contact stands, not 7** (v = -110 + 44(k-1)). With 7 at v ±132 the outer stand boxes ran 4 m off the apron and left no way round the stand row. The fixture is regenerated.
- **`L.serviceRoad` is now a 6 m polyline** that stays on the platform and outside every stand box. The old segment ran off the platform at both ends, over the hill and onto Ring Road 5 (terrain +3.3 m at v 245).
- **Gate level is 5.0 m, not 6.0** (`landside.skybridge.floor`). The skybridge still clears Ring Road 5 by 5.7 m, and the jet bridge slope down to the 2.6 m door sill drops from about 11° to 8°.
- **The jet bridge rotunda column moves to the façade (u = concourse face + 1.2).** At u 176 it stood in the middle of the service road.
- **The curb canopy is v ±19.5**, inside the 40 m site, as section 5 requires. It was ±22.
- **The runway in use changes only between 40-minute periods, each ending in an 8-minute quiet gap** (7.1, 7.2). A change in the middle of a timetable put two flows head-on on B and A1/A6.
- **The exit rule uses the exit curve's start, and `K.jet.decRoll` is 2.6** (7.3). With 2.3, the stopping point overshot A5's curve start by 2 m, so every jet would have rolled to the far end.
- **`dep.line` ends exactly at `E.lineup`**, which is the end of the `A?/RWY` fillet. There is no extra 15 m of centreline.
- **LOD tiers and `setDetail()`** (9). Without them, the 110 static airport draw calls never fit the spawn-view gate of baseline + 40.
- Smaller items: the apron floodlight masts move off the service road; the fuel tanker stays parked; the follow-me car's path comes from an injected `ahead()` function; `gateSpot` is defined for commuter stands; booking picks a slot by destination; draw calls are counted with the real vendored THREE; there are concurrency and occupancy tests; and an integration-owned cross-module test is added.

---

## 1. Decisions

1. **Client-only. The generator (Rust) does not change.**
   - The Commons is an island about 900 m in radius. The city takes the inner 480 m, Ring Road 5 runs at about 760 m, and the coast is at about 930 m on the airport's side.
   - No straight line on land is long enough for a jet runway, wherever the site is. A 1.6 km runway only fits offshore, so moving or growing the site in `backend/src/worldgen/civic.rs` buys nothing.
   - A generator change would also re-pin `claude-hq@2` (`python3 tools/world_fixture.py`) and the backend embed, and risk `claude-hq@1` byte-identity.
   - So the existing site `airport:0` (40 m wide x 160 m deep, at (-620, 0), front +x) keeps only the landside terminal. Everything airside is a client-drawn **reclaimed platform**, like Hong Kong or Kansai: a flat slab at one height `L.y`, with a sea wall, set off the west coast with the runway parallel to the coast.
   - This is the same principle as today's runway "over beach and water on piles", done properly.
2. **The runway is 1600 x 45 m (designators 18/36), with 60 m blast pads.** It runs along world z at x = -1015, from z = -800 to +800. It is 3.6 km of total airfield length to the eye from the city, and longer than anything else in the scene.
3. **One layout, three consumers.** `HQV.hqAirfield.layout(W, site)` returns `L`.
   - The ground, buildings and vehicles are drawn from `L`.
   - Every aircraft path (`games/hqair.js`) is built from `L`'s lines and curves.
   - Walking floors and blocking come from `L`, plus building plans that are themselves derived from `L`.
   - Nothing hard-codes airport coordinates except the generator, and through it the fixture.
4. **Tier-5 islands get no airport.** This is structural: an island's `city_r` (800) exceeds its `Place::Edge` limit, so the generator never places the site (`civic.rs:738-742`).
   - The layout function is generic: any future airport site gets a layout, or `{ok: false}`.
   - Islands keep their docks. Flights between the Commons and an island become an **amphibian ("Isle Hopper")**. It uses the Commons runway and stands, and lands or takes off on the water at the island's river mouth, reusing today's dock end.
   - Jets only fly when both ends have an airfield. Today that never happens, so the Commons' jets are the **ambient airline timetable** (section 7). Island to island stays a seaplane, as today.
5. **What is removed:**
   - `BUILD.airport`'s runway, tower, jet-bridge boxes, apron and static prop plane (`games/hqcivic.js`);
   - `hqaircraft.airport()` and the `airDress` in `hqcity3d.js` (removed at integration);
   - the phantom `nominalAirport` runway for islands (`hqcity3d.js` `setupAir`);
   - the menu's false "✈ Flight to <island>".
6. **Determinism.** Everything is a pure function of the world doc and `Date.now()`, so it is the same on every client:
   - the layout;
   - the runway in use;
   - the timetable;
   - routes, stand states and vehicle poses.

---

## 2. Frame and conventions

- World metres in the City's frame. Yaw 0 faces +z, and yaw increases turning toward +x (`hqair` convention). `leftOf(yaw) = [cos yaw, -sin yaw]`.
- Compass (minimap): N = +z, E = -x. Bearing of a direction `[dx, dz]` = `atan2(-dx, dz)`. A runway designator is `round(bearing°/10)`, with 0 written as 36.
- **Site frame (u, v)**, used throughout this spec:
  - `B = -front` (unit, outward from the city);
  - `T = [B.z, -B.x]`;
  - `world = site + u*B + v*T`.
  - On the Commons, `B = [-1, 0]` and `T = [0, 1]`, so **world x = -620 - u and world z = v**.
- Archipelago metres = City frame + the city's archipelago position `(cx, cz)`, as in `hqair`. Every `L`-to-end function takes `(cx, cz)`.

---

## 3. Layout: `L` (fixture `tests/fixtures/airfield_commons.json`)

### 3.1 Cross-section

All values are in the site frame. `RU` is the runway centreline's u, chosen by the search in 3.3, and is 395 on the Commons.

| u (Commons) | what | rule |
|---|---|---|
| -146 to -118, v = -8 | access road from the Root Close street end (-474, -8) | 8 m wide |
| -120 to -88, v = ±62 | forecourt loop, one-way. Curb leg at u = -88: drop-off v ±20, taxi rank v 24..56, bus bay v -56..-24 | 8 m |
| -80 to -66, v ±19.5 | curb canopy (height 5 m, does not block walking), inside the site | |
| -66 to +66, v ±18 | terminal hall, on the civic site | civic `BUILD.airport` |
| -60 to -4, v 30..86 | multi-storey car park, 4 decks; footbridge at u = -40, v 18..30 | |
| 66 to 154, v ±4 | skybridge over Ring Road 5 (road at u 135.5..144.5, y -1.3); floor at site.y + 5.0 | |
| (95, -100) | control tower, 66 m | on land |
| (110, 110) | approach radar (ASR), 25 m lattice mast | on land |
| 154 to 172, v ±150 | concourse (pier). Gate level floor at site.y + 5.0, roof about 12 m | `RU - 241 .. RU - 223` |
| 173.2 | jet bridge rotunda columns (r ≤ 0.7), at v_k - 12; the drum is elevated at gate level | concourse face + 1.2 |
| 174 to 180 (centre 177) | airside service road, head of stand, v -141..141 (vehicles pass under the elevated bridges) | `RU - 218` |
| 202 (origin), nose 183 | contact stands 1..6 at v = -110 + 44(k-1), nose-in, yaw toward the concourse. Boxes stay within v ±132 | `RU - 193` |
| 212 (origin), nose 204 | commuter stands 21, 22, 23 at v = -172, -198, -224 | `RU - 183` |
| v ±141, u 177..220 / 226.5 | service road lanes round the stand row: north to the depot (u 220, v 141..240), south along the commuter tails (u 226.5, v -141..-240) | `RU - 175`, `RU - 168.5` |
| 243 | taxiway **B** (inner parallel / apron taxilane), v -815..815 | `RU - 152` |
| 285 | taxiway **A** (outer parallel), v -815..815 | `RU - 110` |
| 345 | runway-holding position lines on A1, A6 and the exits | `RU - 50` |
| 326 | the hold point: aircraft origin stopped with its nose at the line | `RU - 69` |
| 395 | **runway** centreline, v -800..800; pads to ±860 | `RU` |
| 225 to 465 | main platform strip, v ±860 | `RU - 170 .. RU + 70` |

Links (each 18 m wide, plus 3.5 m shoulders), with centrelines in `L.lines`:
- **A1** at v = -815 and **A6** at v = +815: from B (u 243) to the runway centreline.
- **Rapid exits** at 30°, from the runway centreline to A:
  - A4 and A5 for landings on 36, leaving at 1000 m and 1250 m past the 36 threshold (v = 200 and 450);
  - A3 and A2 for landings on 18 (v = -200 and -450).

Service zones on the platform (`L.service`, polygons):
- `fuel`: u 180..225, v -480..-360;
- `fire`: u 180..225, v -340..-270;
- `hangars`: u 180..225, v 320..470;
- `depot` (ground-vehicle base): u 215..225, v 150..245.

Apron polygons (`L.apron`):
- u 154..266, v ±150;
- u 200..266, v -245..-150 (south notch: avoids the hill and the ring road);
- u 215..266, v 150..245.

`L.platform` is apron + main + service. Its top is **`L.y`**:
- `L.y` = highest terrain under any platform polygon + 0.3, rounded up to 0.1, and at least sea + 1.5.
- On the Commons it is **0.1**, against sea -4 and site 0.
- Where the platform meets land (by the ring road) it stands up to about 2 m above the beach terrain behind a retaining wall. That is intended.

Plan sketch (Commons, not to scale; x grows to the left of the page; north = +z = up):

```
 z=+1220 . . approach lights 18 (pier) . .
 z=+860  ====pad====
 z=+815  A6 ======================================= (link B<->RWY, hold at u345)
         |RWY 45m|  strip  |A|    |B|   hangars(320..470)
 z=+640          \A5                |      |  depot (150..245)
 z=+450           \                 |      |
 z=+390   A4  \    \               |B2..   |
 z=+200        \                    |  [6]  concourse  | skybridge ==== TERMINAL (site) == curb == access road
 z=0      RWY   |       A           B  [3]  (154..172) | over ring road (u140)    car park
 z=-200        /A3                  |  [1]             |   tower (95,-100)
 z=-390   A2  /  /                  | [21][22][23] commuter
 z=-640       /                     |  fire (-340..-270)  fuel (-480..-360)
 z=-815  A1 =======================================
 z=-860  ====pad====
 z=-1220 . . approach lights 36 (pier) . .
       x=-1015    -905   -863  -822   -774..-792     -686..-554      -500..-474
```

### 3.2 `L` schema (exact; see the fixture)

```
L = {v: 1, ok: true, world, site, frame: {o: [x, z], B: [x, z], T: [x, z], RU}, y, ySite, sea,
  runway: {c, dir (unit: the direction of a landing on 36, +z here), len: 1600, w: 45, shoulder: 7.5, pad: 60,
    ends: [E36, E18]},          // index 0 = "36" (landing toward +v), 1 = "18"
  lines: {RWY, A, B, A1, A6, A2, A3, A4, A5: [[x, z], [x, z]]},   // straight design centrelines
  widths: {RWY: 45, A: 18, B: 18, A1..A6: 18, shoulder: 3.5},
  curves: {"<id>": [[x, z], ...]},   // every turn an aircraft makes, sampled at <= 2 m (see 3.4)
  stands: [{id, kind: "contact"|"commuter", x, z, yaw, span, len, nose: [x, z], stop: [[x, z], [x, z]],
            box: [4 corners], lead: {"36": curveId, "18": curveId}}],
  apron, platform: [polygon], service: {fuel, fire, hangars, depot}, concourse: polygon,
  serviceRoad: [[x, z] x 6] (polyline, see 3.1), serviceRoadW: 6,
  landside: {terminal, canopy, skybridge: {a, b, w, floor: 5.0}, forecourt (closed polyline), access, roadW,
             curb: {dropoff, taxi, bus}, carpark, carparkBridge, tower: {x, z, h}, asr: {x, z, h}},
  keepOut: {capsule: {a, b, r: 180}, corridors: [{a, b, r: 250} x2]}   // for ships, the carrier, the air base
}
End E = {id: "36"|"18", thr: [x, z], dir: [x, z] (landing/takeoff direction), left: [x, z], yaw, len,
  lineup: [x, z] (roll start, 40 m in), hold: [x, z] (hold point), holdLine: [[x, z], [x, z]],
  touchdown: 330, aim: 310, exits: [{id, along}] (ascending; the last is the far-end link at len + 15),
  papi: [4 x [x, z]] (inner first), glideslope, localizer, windsock, approach: [14 x [x, z]] (30..420 m out),
  crossbar: 300, pad: [[x, z] threshold, [x, z] pad end]}
```

### 3.3 Rules `layout()` must implement (from `tools/airfield_fixture.js`)

- `RU` is the first of 355, 365, ..., 455 for which both of these hold:
  - the airside rectangles, each grown by 6 m, touch no road, sidewalk, lot, `blockedAt` or other site, sampled every 2 m and skipping samples within 2 m of the world edge;
  - the platform height is no more than site.y + 0.5.
  - The Commons gives 395.
  - If none fits, return `{ok: false, why}`. Every consumer then degrades to "no airport": flights from the dock, no dressing.
- All offsets are relative to `RU` exactly as in the generator.
- Stand ids, line ids, curve ids and end order are as in the fixture.
- The RU search checks only the airside rectangles. The landside footprints (terminal, canopy, forecourt, car park, footbridge, tower, ASR) were checked by hand for the Commons and touch no road, lot, block or other site. The only contacts are the access road's joint with the street and the skybridge's crossing of Ring Road 5, and both are intended. `layout()` does not need to re-check them. A test still pins this (section 11).
- **Do not use `WD.siteAt` / `WD.surfaceAt` / the terrain pad to reason about the airport site.** `world.js` treats a site's `w`/`d` as world x/z and ignores its polygon and front, so for this site it reports a 90°-rotated patch (x -640..-600, z ±80). Use `L`'s polygons and the site polygon. Fixing `world.js` is out of scope, because it would move every rotated site's terrain pad.

### 3.4 Curves (turns)

Each fillet is the circular arc tangent to both lines, sampled at ≤ 2 m.

| curve id | turn | radius |
|---|---|---|
| `A1/B`, `A6/B` | B onto the link toward the runway (also the reverse turn, link onto B) | 40 |
| `A1/A`, `A6/A` | A onto the link toward B (arrivals) | 40 |
| `A1/RWY`, `A6/RWY` | link onto the runway, lining up away from that end | 40 |
| `A4/RWY` etc. | runway onto the rapid exit | 300 |
| `A4/A` etc. | exit onto A, heading in the landing direction | 150 |
| `S<k>/36`, `S<k>/18` | stand lead-in from B (36 flow comes southbound, 18 northbound). This is a 30 m arc from B to the stand line, then straight to the stand origin. The **same arc is the pushback path** for departures in the same flow | 30 |

The **painted taxi lines are exactly `L.lines` plus `L.curves`**, and **every aircraft ground path is a concatenation of pieces of them**. This is the "drawn = flown" invariant.

### 3.5 Flows (one-way, per runway in use)

**Runway 36** (land and take off toward +z):
- Departure: push from stand k along `S<k>/36` (ending on B facing south); B south; `A1/B`; A1 east, across A; stop at the hold; `A1/RWY`; line up; roll.
- Arrival: touch down at 330 m; roll out; leave by the first exit whose `along` ≥ touchdown + stopping distance (A4 or A5; A6 if neither); `<exit>/RWY`, then the exit, then `<exit>/A`; A north to v 815; `A6/A`; A6 west; `A6/B`; B south; `S<k>/36` into the stand.
- **Runway 18** mirrors this with A6/A1, A3/A2 and `S<k>/18`, B running north.
- B carries both flows in the same direction, and A only carries arrivals. Conflicts are only catch-ups, which section 7.3 handles.

---

## 4. Ground, markings and lights (owner: Task 3, `games/hqairport3d.js`)

Real dimensions are used. The runway is 45 m wide, so real paint proportions fit.

**Surfaces** (merged by material):
- platform top: grass `#6f8f4f` with a baked noise canvas;
- runway asphalt `#2b2d30`, with darker rubber (`#1f2023`) in the first 300..900 m of each end and lighter concrete for the first 6 m (`#8a8a85`). Rubber comes from a 128x2048 canvas mapped along the runway;
- runway shoulders `#4a4d52`;
- taxiway asphalt `#3a3d42`;
- taxiway shoulders `#55585c`;
- apron concrete `#a8a69e`, with a 5 m joint-grid canvas (world UVs);
- blast pads: lighter asphalt;
- landside roads `#3a3d42` with white lane lines, and a 0.15 m curb;
- sea wall: a sloped rock revetment `#7d776c` from `L.y` down to sea - 1.5, 6 m out, on edges over water. Elsewhere a vertical retaining wall goes down to ground - 0.5.

Every untextured surface (grass, shoulders, taxiways, pads, landside roads, rock, walls) goes into **one vertex-coloured mesh**. Only the runway (rubber canvas) and the apron (joint-grid canvas) get their own materials. The ground then costs 3 draw calls, not 10. The service road (`L.serviceRoad`, `L.serviceRoadW`) is drawn on the apron in the taxiway asphalt colour.

Paint sits on the surfaces at +0.02 m with `polygonOffset` and is merged per colour: white, yellow, red, black.

**Runway markings** (each end, along = metres past the threshold):
- **Piano keys:** 12 stripes, 1.75 x 45 m, starting at along 6, with lateral centres ±(2.625 + 3.5 i) for i = 0..5.
- **Designator:** "36" / "18", bar-segment digits 18 m tall x 6 m wide with a 1.5 m stroke and a 3 m gap. They start at along 63 and read upright to the landing pilot.
- **Centreline:** dashes 36 m long x 0.9 m wide, 24 m gaps, from along 90 to len - 90.
- **Aiming point:** two 45 x 9 m bars at along 310..355, inner edges at ±11.
- **Touchdown zone:** bar groups 22.5 x 1.8 m at along 150 (3 bars), 450 (2), 600 (2), 750 (1) and 900 (1), from lateral ±11 outward, 1.5 m apart.
- **Edge stripes:** 0.9 m at lateral ±22.05, full length.
- **Blast pads:** yellow chevrons, 0.9 m wide, every 15 m, pointing at the runway, only beyond along -25 (clear of A1/A6).

**Taxi markings:**
- Yellow centreline 0.3 m on every `L.lines` taxiway and every `L.curves` entry. On exit curves inside the runway strip it alternates green and yellow at night (lights).
- Double yellow edge lines (0.25 m lines, 0.25 m gap) on the straight sides of A and B.
- **Holding position** on A1, A6 and every exit, where the line crosses u = RU - 50: four 0.3 m yellow lines 0.3 m apart across the full width + 2 m. The two solid lines face the taxiway side; the two dashed lines (1 m dashes, 1 m gaps) face the runway.

**Apron markings:**
- lead-in lines (the `S` curves), 0.3 m yellow;
- stop bar, 0.6 x 6 m yellow, at `stand.stop`;
- stand number in yellow with a 0.3 m black outline, digits 4 m tall at the box's taxilane end, readable from B;
- red 0.2 m stand box (`stand.box`, the equipment restraint line);
- service road with white 0.2 m edges and a dashed centre.

**Lights:** one InstancedMesh of a small lamp (`MeshBasicMaterial`, white, `toneMapped: false`, per-instance colour with `setColorAt`) for **all** of these, plus one `Points` glow cloud (vertex colours, `sizeAttenuation: false`, no fog) shown at night. By day the lamp material's colour is multiplied down to about 0.35 grey.

| group | placement | colour |
|---|---|---|
| runway edge | every 50 m, lateral ±23.5 | white; yellow over the last 600 m of the in-use direction |
| runway centreline | every 15 m, lateral +0.6 | white; red/white alternating over the last 900 m, red over the last 300 m (in-use direction) |
| threshold / end bar | 16 lamps every 3 m across each end at along -1 | green at the in-use landing threshold, red at its far end |
| TDZ barrettes | in-use end only, rows every 30 m along 30..900, 3 lamps each side at ±11.5, ±13, ±14.5 | white |
| approach | `E.approach` points: a 5-lamp bar (1 m spacing) at each; crossbar of 15 lamps at 2 m spacing at 300 m; red side barrettes (3 lamps at ±6..8) for 30..180 m | white / red. The in-use end is lit and the other end's lamps are off at night |
| rabbit | one bright `Points` vertex running 420 m to 30 m along the in-use approach, twice per second | white flash |
| PAPI | 4 boxes per end at `E.papi`, separate small InstancedMesh | per box i (0 = inner): white if the camera's elevation angle from the box is > [3.5°, 3.17°, 2.83°, 2.5°][i], else red. Updated each frame |
| taxi edge | every 30 m on both straight edges of A, B, A1 and A6 | blue |
| taxi centreline | every 15 m on exits and curves | green; green/yellow alternating inside u > RU - 50 |
| stop bars | 12 lamps across each holding line | red; a bar goes dark while its departure is in `lineup` (`setHold`) |
| apron floodlights | 7 masts, 25 m, at the head of stand u = 173.3 (between the façade and the service road), v = 0, ±44, ±88, ±132 (between stands, 10 m from any rotunda), plus 2 at the head of the commuter stands (u 200.5, v -160 and -240). 4 heads each | sodium `#ffb060`, plus additive light-pool discs (r 28 m) on the apron (1 InstancedMesh) |
| obstruction | top of every mast, the localizers and the approach pier ends | red, blinking 1 Hz |

**Fixtures** (merged per material):
- approach-light pier: a 3 m catwalk on piles every 30 m from the pad end to 420 m, with light bars on posts;
- localizer: 16 posts 2 m tall across 30 m, plus a 4 x 3 m shed, on a 34 x 10 m pier head at `E.localizer`;
- glideslope: 12 m mast with 3 antenna boxes and a shed;
- windsocks: 6 m pole and a 3.6 m orange/white 5-band sock that points along the wind (section 7.1) and droops at low speed. They are lit at night;
- signs at every hold: red mandatory "18-36" on both sides, 3 m off the edge;
- location signs ("A", "B", "A1"...) at junctions, black and yellow. Each sign is a 2.5 x 1.2 m box on legs. Faces come from one 512x256 canvas atlas drawn with `fillText` (static strings only);
- chain-link fence, 2.4 m, on every platform polygon edge that is over land and not shared with another platform polygon, plus the landside airside boundary; a 1 m parapet on edges over water.

---

## 5. Buildings (owner: Task 4, `games/hqcivic.js` `BUILD.airport` + new `games/hqairbldg.js`)

**Terminal (civic, on the site; `KINDS.airport.size` becomes [40, 160], matching the backend):**
- The hall is 36 (v) x 132 (u), on the site's polygon. Inside the site's local frame, local +z is the front.
- **Side masses:** v ±6..±18, 2 floors, 12 m to the eaves, blocking.
- **Nave:** v ±6, a **walk-through hall** with no blocking box below 2.4 m.
  - It has a glass curtain wall front and back, with the automatic door opening at the front.
  - Check-in islands are low blocking props at u -50..-20, leaving 2 m aisles.
  - A departures board is a canvas, updated by `setBoard(lines)` from integration.
  - A ramp rises from site.y at u 0 to site.y + 5.0 at u 56 (9%), then a mezzanine runs u 56..66 to the skybridge.
- **Roof:** a wave/barrel over the whole 36 x 132 at 14..16 m. `note()` must record the real (scaled) height.
- Curb canopy (`L.landside.canopy`, v ±19.5), lamps, the "AIRPORT" sign over the canopy, and the **main door** (`kind: "airport"`) at the front.
- A skirt (vertical wall in the base colour) from the plinth down to ground - 0.5 under the whole hall. The ground under the site's back falls to -0.6 m (see 3.3), and today the plinth floats there.
- Everything stays inside the site polygon. The existing civic tests apply: doors face the front, masses stand on the site, < 40 draw calls (target ≤ 30), LOD, deterministic.

**Airside and landside structures, drawn by `hqairbldg.js` from `L`:**
- **Skybridge:** an 8 m glazed tube from `L.landside.skybridge.a` to `.b`, floor at site.y + 5.0, roof at +9.5. Piers at u 125 and 152, clear of the ring road. Strip lights at night.
- **Concourse:**
  - ground floor 4.5 m, with ops/baggage roller doors on the apron side;
  - **gate level floor at site.y + 5.0**, with a walkable public gallery u 156..170, v ±148 behind an all-glass apron façade with mullions;
  - sawtooth or curved roof to about 12 m;
  - gate number signs, and a VDGS board facing each stand at the nose, showing the stand id from a canvas atlas;
  - warm emissive glazing at night.
- **Jet bridges, one per contact stand (6):**
  - a rotunda drum at gate level (floor 5.0) on one column at (u 173.2, v_k - 12), column r ≤ 0.7. The column stays clear of the service road (u 174..180), and vehicles pass under the elevated tunnel;
  - two telescoping tunnel sections, about 3 x 3.5 m;
  - a wheeled bogie leg under the outer section;
  - a cab.
  - **Extended:** the cab's door face sits within 0.6 m (xz) and 0.3 m (y) of the parked airliner's L1 door, at `stand + 14.6*fwd + 1.95*left(yaw)`, sill y = `L.y + 2.5` (from `hqaircraft`: forward door at model x ±1.95, z 14.6, centre 3.35).
  - **Retracted:** the cab rests parallel to the façade, with its bounding box ≥ 2 m clear of the stand's aircraft box and of the lead-in swept path.
  - The extended tunnel runs about 17 m and drops 2.4 m (about 8°) from the drum to the door. The bogie leg stands inside the stand box, never on the service road.
  - Drawn as instanced parts (≤ 5 draw calls for all 6), eased by `setBridge(id, k)`.
- **Control tower** at `L.landside.tower`:
  - a 66 m tapered concrete shaft;
  - an octagonal cab at 56..62 m with glass sloping out about 15°, lit dim green-blue at night;
  - roof, antenna to 70 m and a red obstruction light;
  - a **rotating airport beacon** that alternates white and green (one flash each about 1.1 s).
- **ASR:** a 25 m lattice mast and a parabolic dish turning at 1.26 rad/s.
- **Fire station** (`L.service.fire`): 5 bays with 6 m red doors facing +u (toward B), a lookout cab and a 30 m hose-drying tower.
- **Two hangars** (`L.service.hangars`):
  - each 60 (v) x 45 (u), with a 22 m barrel roof and doors facing B;
  - the north hangar's doors stand open with an airliner inside. Its pose is exported as `plan.hangarStand`;
  - roof obstruction lights.
- **Fuel farm** (`L.service.fuel`): 4 white tanks (r 9, h 12) in a 2x2 grid inside 1.5 m bund walls, a pipe rack toward the apron, and an office.
- **Ground-support depot** (`L.service.depot`): a low shed and marked parking bays. The vehicles' home.
- **Multi-storey car park** (`L.landside.carpark`):
  - 4 decks at 3.2 m, open sides with parapets, a ramp, and roof lamp posts;
  - parked cars as one instanced box mesh (deterministic colours). The same mesh puts 4 yellow taxis at the curb's taxi rank (`L.landside.curb.taxi`) and 6 cars at the drop-off;
  - the footbridge at level 2.

Night: glazing glows warm, the car park decks are lit, and obstruction lights blink. All of `hqairbldg`'s night lights share one `Points` cloud (its own; T3 and T5 have theirs).

**`hqairbldg` walk contract** (pure, from `plan(L)`):
- `floorAt(x, z, yRef)` returns the walkable height of the terminal nave ramp/mezzanine, the skybridge or the concourse gallery when (x, z) is inside one **and** `yRef >= floor - 1.5`. Otherwise it returns null, and the caller uses the ground.
  - So walking along Ring Road 5 under the bridge stays on the road.
  - The ramp has no such condition, because it starts at ground level.
- `blockedAt(x, z, y)` covers walls, glass façades and props at that level.
- `gateSpot(standId)` returns a spot in the gallery facing the stand: `{x, y, z, yaw}`. For commuter stands (21..23, bus boarding) it is the gallery's south end (v -146) facing the commuter apron.
- The nave ramp and mezzanine numbers above are constants that `hqcivic` and `hqairbldg` share (T4 owns both). `test_hqairbldg.py` checks that the civic build's nave matches `plan(L).floors`.

---

## 6. Aircraft and ground life (owner: Task 5, `games/hqaircraft.js` + new `games/hqairground.js`)

**`hqaircraft.js` additions** (existing API unchanged; **do not delete `airport()`**, integration removes it):
- `DOOR_L1 = [1.95, 2.5, 14.6]` (left = +x model, sill), `NOSE = 19.05`, `SPAN = 36`.
- `airliner(c, {brand, body})` keeps its behaviour. Add `P.setLivery(brandHex, tailHex?)`, which gives the pooled plane its own brand material and disposes it on `dispose`.
- `amphibian(c, opts)`: the seaplane with retractable wheels in the floats. Wheels show when `gear > 0.5` and the plane is on a runway (`P.update(..., {surface: "land"|"water"})`).
- `parked(c, kind, n)` returns a fleet of parked planes as **InstancedMesh per material** (≤ 7 draw calls per kind, whatever n), with `instanceColor` for the brand material:
  - `set(i, {x, y, z, yaw}, brandHex)`;
  - `count(k)`;
  - `setNight(n)`, which lights the cabin windows;
  - `dispose()`.
- `P.update(dt, t, night, gear, speed, phase)`: the optional `phase` turns the red beacon on from `pushback` to `parked`, the nose taxi light on in `taxi|hold|lineup|exit|pushback`, and the wing landing lights on in `lineup|takeoff|climb (<300 m)|approach|flare|rollout`. Red/green wingtip navigation lights are on in every phase but `parked`, and white wingtip strobes (double flash, 1 Hz) from `lineup` to `rollout`. All of these are instances in the plane's existing light points, with no new draw call.
- Optional, if it fits the plane's budget: a short additive tyre-smoke puff at touchdown, driven by `phase` changing to `rollout`.

**`hqairground.js`** (new): vehicles as one InstancedMesh per type (merged vertex-coloured geometry, one material each), plus one amber beacon `Points` cloud.

| type | size (m) | look | behaviour (times relative to stand state, section 7.3) |
|---|---|---|---|
| pushback tug | 6 x 3 x 1.5 | yellow `#f2c230`, black bumpers | at the nose from tOut - 120 s; during pushback its pose is the aircraft nose + 4 m along the heading; at the push end it disconnects, drives back along the stand's lead-in to the box (≤ 30 s), then takes the service road to the depot |
| baggage tractor + 3 carts | 3 m + 3 x 3 m | white/orange tractor, blue canvas carts | at the aft right side tIn+40 .. tOut-240 |
| belt loader | 8 x 2.2, belt up to 2.5 m | white | at the aft hold door tIn+20 .. tOut-200 |
| fuel dispenser | 7 x 2.5 x 2.5 | white/red | right wing root tIn+60 .. tIn+360 |
| fuel tanker | 12 x 2.6 x 3.2 | white/red | parked at the fuel farm (static: the fuel, fire and hangar zones have no road to the apron) |
| catering truck | 9 x 2.5, box lifts 0..3 m | white | right rear door tIn+90 .. tOut-300; box raised while docked (eased) |
| follow-me car | 4.5 x 1.8 x 1.5 | yellow, black/yellow chequer roof sign, lit "FOLLOW ME" at night | leads each arriving jet 70 m ahead along its remaining route, from the end of its exit to the start of its stand lead-in, using the injected `ahead(movingEntry, 70)`; then it turns off onto the service road at the nearest lane end and returns to the depot |
| apron bus | 14 x 3 x 3.2 | white/blue | to commuter stands: from the concourse's south end to the stand's left side tIn+15..tIn+90, and tOut-200..tOut-120 |
| ARFF truck x2 | 11 x 3 x 3.5 | yellow-green `#c8e000`, roof turret | parked at the fire station |

- Vehicles drive the service road (`L.serviceRoad`, 6 m: one lane each way, keep right) and the depot, plus straight approaches into stand boxes with 6 m corner radii. Speed is 8 m/s on the road and 3 m/s inside boxes. A vehicle bound for a stand enters only that stand's box.
- Every vehicle stays on the platform and on the apron surface (`L.apron` or the depot), except the follow-me car on taxiways and the ARFF trucks and the tanker, which are parked in their zones.
- Every pose is a **pure function** of (L, stand states, moving aircraft, `nowMs`). Nothing is integrated over frames.
- Apart from the tug while pushing plus its 30 s return, and the follow-me car, no vehicle pose may lie on runway or taxiway pavement, including shoulders.
- Vehicles are hidden when the camera is > 900 m from the apron centre, and updates run at ≤ 30 Hz.

**Parked and moving aircraft:**
- Parked aircraft use the instanced fleet: every stand in state `onblock|turnaround`, plus the hangar plane.
- Moving aircraft use the existing pool (`AIR_MAX` per kind), with `setLivery` per assignment.

Airlines (invented, no real brands):
- **Archipelago Air**: the brand colour (`hqaircraft.brandHex()`);
- **Tokenline**: `#1f9e9a`;
- **Context Airways**: `#23408e`;
- **Gradient Air**: `#7a4cc2`;
- commuters are **Isle Hopper**: `#e07a2e` on white.

---

## 7. Operations (owners: Task 1 timetable/ends, Task 2 routes/traffic)

### 7.1 Periods, runway in use and wind (Task 1, pure, no `L` needed)

- `hash` = FNV-1a 32, as in `hqair`.
- Time is cut into **periods** of `PERIOD = 2400 s`: 8 slots of `SLOT = 240 s` (1920 s), then a **change-over gap** of `GAP = 480 s` with no runway movement.
  - `T0 = hash(world + "|slots") % 2400000` ms. Period p starts at `T0 + p*PERIOD`.
  - Slot m is in period `p = floor(m/8)` and its base is `T0 + p*PERIOD + (m mod 8)*SLOT`. This stays closed-form for negative m too (use `Math.floor`).
- **Why the gap:** the flows are one-way (3.5), and a 36 flow and an 18 flow use B, A1 and A6 in opposite directions. If the runway changed between two slots, the last old-flow arrivals (taxiing in until about 5 min after landing) would meet the first new-flow departures (taxiing out from about 4 min before their roll) head-on. The gap lets the old flow drain before the new one starts. It is applied every period, whether or not the runway changes, so slot times stay closed-form. The airport has an 8-minute lull every 40 minutes, and ambient traffic continues.
- `runwayEnd(world, ms)`, an index into `L.runway.ends`, constant over a period:
  - `p = floor((ms - T0) / PERIOD)` (the gap belongs to the period it ends);
  - `pre = hash(world + "|wind") % 2`;
  - result = `hash(world + "|" + p) % 10 < 7 ? pre : 1 - pre`.
  - A movement's `end` is `runwayEnd` at its slot's base, so all four movements of a slot use the same end.
- `windAt(world, ms, L?)` returns `{end, yaw, speed}`:
  - `yaw` is where the sock points (downwind, because aircraft land into the wind): the in-use end's landing yaw + π + jitter, where jitter is ±0.35 rad from the hash of the 5-minute block;
  - `speed` is 3..12 m/s from the same hash;
  - landing yaws come from `L.runway.ends[i].yaw` when `L` is given; otherwise they are the Commons constants [0, π] taken from the fixture.

### 7.2 Timetable (Task 1, pure, no `L` needed)

- Within each slot the **runway times** are:

| offset | movement | stand | airframe |
|---|---|---|---|
| +0 s | jet arrival (touchdown) | contact `(m mod 6) + 1` | `J<m>` |
| +60 s | commuter departure (roll start) | `21 + (m mod 3)` | the one that arrived at slot m-3 |
| +120 s | jet departure (roll start) | contact `((m-4) mod 6) + 1` | `J<m-4>` |
| +180 s | commuter arrival (touchdown) | `21 + (m mod 3)` | `C<m>`, departs at slot m+3 |

  Use a non-negative mod for negative m. A contact stand is reused 6 slots later (at least 2 slots after its previous jet pushed); a commuter stand is reused 3 slots later.
- **Runway occupancy windows** must never overlap. A departure occupies the runway from crossing the hold line to passing the far runway end (airborne). An arrival occupies it from crossing the threshold to leaving the strip (`tVacate`). By estimate a jet departure is about 60 s, an arrival about 40 s and a commuter about 45 s, so the 60 s offsets fit, but only just. `test_hqair.py` checks the real windows.
- `timetable(world, dests, fromMs, toMs)` returns movements `{id, type: "arr"|"dep", cls: "jet"|"commuter", stand, end, tRunway (ms), slot, period, airframe, airline, reg, far}`:
  - jets: `far` = a bearing (rad), hash-chosen from 5 fixed outbound airways;
  - commuters: `far` = a destination world from `dests`, the sorted island world ids. Departure slot m goes to `dests[m mod N]` and arrival slot m comes from `dests[(m+1) mod N]`. With N = 0 there are no commuter movements;
  - `airline` comes from the hash of the airframe: jets cycle the four airlines; commuters are Isle Hopper;
  - `reg` is "HQ-" plus 3 hash letters.
- Exports `SLOT`, `PERIOD`, `GAP`, `slotBase(world, m)` and `slotAt(world, ms)`.

### 7.3 Routes, ends, phases and traffic (Task 2, `games/hqair.js`)

**End format v2** (archipelago metres), built by `HQV.hqAirfield.end(L, standId, endIdx, cx, cz, {stopDist})` (Task 1). `hqair.normEnd()` adapts today's `airportEnd`, `dockEnd` and `nominalAirport` outputs.

```
end = {v: 2, kind: "jet"|"sea", y, site, stand: {x, z, yaw},
  dep: {push: [[x, z]...] (from the stand; [] = none), taxi: [[x, z]...] (to the hold point),
        line: [[x, z]...] (hold point -> roll start), dir: [ux, uz], len (roll available)},
  arr: {thr: [x, z], dir: [ux, uz] (landing direction), td (m past thr), exitAt (m past thr where the
        exit curve begins), exit: [[x, z]...] (exit curve + exit line + join curve), taxi: [[x, z]...] (to the stand)}}
```

- **Dock end:** `dep.push = []`; `dep.taxi` = the river to the old threshold; `dep.line = []`.
  - `arr.thr` = the far end (old thr + dir*len); `arr.dir` = -dir; `arr.td` = `tdIn`; `arr.exitAt` = len (the roll ends at the old threshold).
  - `arr.exit = []`; `arr.taxi` = the river reversed.
  - This is exactly today's seaplane.
- **Airfield end:**
  - `dep.push` = the stand's `S` curve for that flow, reversed. The aircraft moves tail-first and ends on B facing along the flow.
  - `dep.taxi` = B, then `A1/B` or `A6/B`, then the link to the hold point.
  - `dep.line` = the link from the hold to the curve start, then `A?/RWY`. That fillet ends on the centreline exactly at `E.lineup`, 25 m past the threshold. The last point is `E.lineup` (0.05 m tolerance), and `dep.len` = `E.len - 25`.
  - `stopDist = (K.touch² - 15²) / (2*K.decRoll)`, the distance to slow from touchdown to the 15 m/s exit speed. `arr.exitAt` is the `along` of the start of the first `<exit>/RWY` curve (in `E.exits` order) with `curveStart ≥ td + stopDist`. On the Commons the curve starts are A4/A3 919.6 and A5/A2 1169.6 (fillet tangent 300·tan 15° = 80.4 m). That gives jets 330 + 744 = 1074 → A5/A2, and amphibians 330 + 277 = 607 → A4/A3. With no fitting exit the plane rolls to the far-end link (A6/A1).
  - `arr.taxi` is the flow in 3.5 through the stand's `S` curve.

**`route(kind, A, B, {a, b})`**, with kind `jet | sea | amphib`. New constants: `K.jet.lift = 1050` (lift-off speed √(2·2.7·1050) = 75 m/s), `accRoll = 2.7`, `decRoll = 2.6`. `K.jet.touch` stays 64.

`K.amphib`:

| constant | value |
|---|---|
| taxi | 7 |
| climb | 45 |
| cruise | 75 |
| approach | 42 |
| touch | 38 |
| accRoll | 2.4 |
| decRoll | 2.2 |
| cruiseY | 320 |
| lift | 420 |
| turnR | 650 |

The other amphib constants are as `sea`.

Ground speed caps:

| kind of ground | cap (m/s) |
|---|---|
| push | 1.0 (reverse) |
| taxi (straight) | 9 |
| any ground curve | `sqrt(1.0 * R)` |
| stand lead-in last 40 m | 2.5 |
| exit (decelerating to the taxi speed by the end of the exit) | ≤ 15 |
| line | 4 |

Holds:
- at the hold point, a 4 s minimum hold (`hold` phase);
- at the line-up point, 2 s;
- the roll starts at `dep.line`'s end.

Landing:
- touchdown at `arr.td` past `arr.thr`, on the extended centreline, 3° glideslope, flare as today;
- rollout along the centreline to `exitAt`;
- then `exit` and `taxi`, ending at the stand with v = 0.

`R` gains these fields (seconds from R's t = 0):

| field | meaning |
|---|---|
| `tPush1` | push end |
| `tHold0`, `tHold1` | the hold |
| `tLine` | line-up begins |
| `tRoll` | |
| `tLift` | |
| `tTD` | |
| `tExit` | leaves the centreline |
| `tVacate` | clear of the runway strip |
| `T` | on the stand |
| `sExit` | |
| `standA`, `standB` | |
| `endA`, `endB` | |

`poseAt` gains `rev` (true while pushing: yaw is the path heading + π). Phases in order are `pushback, taxi, hold, lineup, takeoff, climb, cruise, descent, approach, flare, rollout, exit, taxi, parked`. `pushback` is absent when `push` is empty.

Routes from a v1 end (no `push`) behave as today, so today's tests still pass after updating phase names where needed.

**`traffic(AF, ctx, nowMs, o)`** (pure; `AF` is the `hqAirfield` API, passed in so tests can stub it; `ctx = {L, world, dests, cx, cz, farEnd(entry), islandEnd(world)}`):
- **Jet arrival:** its route is `route("jet", far, here)` with `dep = tRunway - R.tTD`. **Jet departure:** `route("jet", here, far)` with `dep = tRunway - R.tRoll`. Commuters do the same with `amphib`, using `islandEnd`.
- Routes are cached by `(cls, type, stand, end, far)`, holding at most 96 entries.
- To know which stands are occupied, `traffic()` asks the timetable for `[nowMs - 45 min, nowMs + 15 min]`. That covers a jet's whole stay (6 slots plus a gap).
- **Concurrency:** at no time may `moving` hold more than `AIR_MAX` (4) aircraft of one class. An arrival becomes visible at most 150 s before touchdown, and a departure is dropped from `moving` at its handover. The test asserts this.
- It returns:
  - `moving`: `[{id, cls, kind, airline, reg, pose, R, t}]`, for aircraft between push start / first visible and on-block;
  - `stands`: `{id: {state, airline, reg, kind, tIn, tOut, pushT}}`, where `state` is `empty|arriving|onblock|turnaround|pushback`, `tIn` is the on-block ms, `tOut` is push start ms, and `pushT` is s since push start;
  - `parked`: the stands to draw as parked instances.
- **Separation invariant**, tested over 6 simulated hours at 1 s steps on the Commons fixture:
  - any two ground aircraft (`moving` with pose on the platform) are ≥ 45 m apart (origin to origin);
  - no ground aircraft comes within 25 m of a parked one, except its own stand neighbour during pushback, where the wing-box clearance must be ≥ 3 m;
  - the occupancy windows of 7.2 never overlap;
  - the test runs 6 hours with the real `runwayEnd`, and again with a stub that alternates the end every period, so every change-over is exercised;
  - **T2 owns the tuning.** If the invariant fails, adjust `K.holdExtra[flow][cls]`, an extra wait at the runway holding point (the aircraft pushes that much earlier, which moves it off B sooner). Never change the slot offsets, `SLOT`, `PERIOD` or `GAP`. If no hold value works, report the conflict (with times and positions) instead of changing the layout.
  - **As built (round 2):** a fixed `holdExtra` cannot do it (a jet arrival at slot m+1 +0 s caught the Isle Hopper of slot m +180 s on B, and arrivals on B passed jets pushing back). `traffic()` now sequences the **jets** on the ground; the Isle Hoppers fly the timetable exactly (one may be the player's). A jet departure keeps `K.holdExtra.jet` = 40 s of slack and may push up to that much later or up to 150 s earlier, the difference spent at its hold. A jet arrival stops where its exit joins A (`route(..., {stopIn: true})`, `R.tStopIn`, clear of the strip) and is held there up to 150 s. The least wait that clears everything else is found once per movement from the timetable alone (`o.holds`), so every client holds the same jet for the same time. Jets taxi at 7 m/s, as the Isle Hopper does, so nothing catches up on B. The pair rule is 45 m origin to origin on one track (48 m planned); while one of the two pushes back, while two departures queue at their holding point, or when they pass on separate lanes (≥ 35 m abeam: A and B are 42 m apart), the planforms keep ≥ 3 m (6 m planned) instead. `moving` entries carry `t` (R's time), `t0` (R's t = 0 without the hold) and `hold` (s). `test_hqair.py` checks this over 6 h on the real `hqAirfield` ends and timetable.

**The player's flight:**
- Booking at the terminal (E at the door or in the gallery) to island X gives the next commuter departure slot **to X** (`dests[m mod N] === X`) whose push time is ≥ now + 30 s. With N islands the wait is up to N slots (plus a gap). The menu shows the wait. That slot's scheduled movement is replaced by yours: it is the same aircraft at the same stand, so others see the same plane.
- From island X's dock: the next commuter arrival slot **from X** (`dests[(m+1) mod N] === X`) whose landing time ≥ now + 30 s + `R.tTD`.
- The window seat, the chase camera, the handover and the fast-forward are as today.
- On arrival at the Commons you step out at `gateSpot(stand)`. Commuter stands are bus stands, so this is the gallery's south end (5).

---

## 8. Neighbours (owner: Task 6, `games/hqairbase.js`, `games/hqvoyage.js`, `games/hqtravel.js`, `games/hqminimap.js`)

- **Carrier** (`buildCarrier`): its 48 x 280 box, buffered by 40 m, must not intersect `L.keepOut.capsule` or either corridor. Integration passes `o.airfield = L`. Search the next bearings as today. The current spot (-1160, 0) is rejected.
- **Air base** (`buildBase`): this already avoids `o.blocked`. Integration's `blocked` will include the landside footprints, the tower and the ASR.
  - Add an explicit check that the base rectangle buffered by 20 m misses every `L.platform` polygon and every `L.landside` footprint. The skybridge counts as a capsule of radius `w/2` from `a` to `b`, and the tower and ASR as 15 m circles.
  - The base must also stay out of both approach corridors (`L.keepOut.corridors`), because its hangars would stand under the final approach.
  - Remove the base's assumption that the airport faces its runway: `rot` still comes from the site front, and the base stays on land.
- **Ships and ferries** (`hqvoyage.js`): every client builds the fleet without W.
  - Add the constant `COMMONS_AIRFIELD = {a: [-1015, -1220], b: [-1015, 1220], r: 180}` (Commons frame, equal to `L.keepOut.capsule`; a test pins it to the fixture).
  - Treat it as an obstacle round the Commons in the big-ship detour planning and the ferry sea lanes.
  - No loop, ferry or seaplane path may come within 40 m of the capsule.
- **Travel** (`hqtravel.js`): `hasTerminal(c, "plane")` presumes an airport only for the Commons. An island needs its doc to show one, and it never does today. The air-booking menu lines are integration's job (`hqcity3d.js`).
  - `arrivePose("plane", spawn, t)` (the travel menu's cinematic arrival, from 600 m out and 120 m up onto the spawn) must clear every new structure by at least 20 m: the concourse roof (12 m), the skybridge, the tower (66 m) and the ASR. Its line runs 600 m out from the spawn (site front + 2 m) along the spawn's reverse heading, so check which side it comes from. If it crosses the airfield, keep the line and raise the start height. Add a test that pins the clearance, using the fixture's footprints as literals. Nothing else changes in `hqtravel`.
- **Minimap** (`hqminimap.js`): `setAirfield(L)` draws the platform (grass), runway, taxiways, apron, service road and terminal into the world bitmap in their real colours, so the runway reads on the minimap and the big map.
  - The bitmap covers `W.half + MARGIN` (1084 m). The runway (x ≥ -1037.5) and the pads (|z| ≤ 860) fit; the platform's last metre and the approach piers (to |z| 1220) are clipped. That is accepted, so do not change `MARGIN`, because it rescales every map.
  - `setAirfield(null)` clears it. Calling it twice must not leak canvases.

---

## 9. Budgets

| part | draw calls | triangles |
|---|---|---|
| ground (3, see 4), paint (4), lights (≤ 5), fixtures, fence, signs (T3) | ≤ 24 | ≤ 120k |
| terminal (civic, T4) | ≤ 30 | ≤ 60k |
| airside and landside buildings (T4) | ≤ 28 (jet bridges ≤ 5 of these) | ≤ 140k |
| vehicles (T5) | ≤ 12 | ≤ 40k |
| parked fleet (T5), all parked jets + commuters | ≤ 14 | ≤ 12k per plane |
| **airport static total** | **≤ 110** | **≤ 450k** |
| moving aircraft | existing pool, ≤ 7 per plane | |

**Level of detail.** Merged airport meshes span about 1.7 km, so frustum culling almost never drops them. Without LOD the 110 static calls would land on the spawn view. Each of `hqairport3d`, `hqairbldg` and `hqairground` (and the civic terminal through its existing `CIVIC_NEAR` box LOD) gets `setDetail(level)`. Integration sets the level from the camera's distance `d` to the nearest point of any `L.platform` polygon (airside only; the landside sits closer to the city), with 50 m of hysteresis:

| level | when | what is drawn | draw calls (all airport modules) |
|---|---|---|---|
| 2 near | d < 600 m | everything | ≤ 110 static |
| 1 mid | 600 ≤ d < 1800 m (the Commons spawn, about 770 m away, is here) | ground (3), white + yellow paint (2), the lamp mesh + glow (2, night only), buildings as one merged far mesh per material (≤ 6), parked fleet (≤ 14), tower beacon. No vehicles, no fixtures, no fence, no signs | ≤ 30 |
| 0 far | d ≥ 1800 m, or `map` mode | ground (3) and white paint (1); at night the lamp glow only | ≤ 6 |

`setDetail` only toggles `visible`. It never rebuilds, and moving from one level to another allocates nothing. Vehicles stop updating below level 2.

Whole-view gates, measured headless with `HQ3D_DEBUG.stats()`:
- Commons spawn view ≤ baseline + 30 (level 1);
- apron view from the gallery ≤ 300;
- every view ≤ `MAX_DRAW_CALLS` 400.

CPU:
- airport per-frame work (traffic, poses, vehicles, lights) ≤ 1.0 ms average at the apron, measured by `HQV.hqCity3d.air.perf()`, which integration adds;
- no `route()` call in a frame where the cache hits.

Memory: canvas textures ≤ 4 MB in total. Everything is disposed on `swapCity` and `airDestroy`.

`HQ3D_DEBUG.stats().drawCalls` was seen reading 0 during flights in the baseline. A gate that reads 0 is a failed measurement, not a pass. The smoke driver forces a render and reads `renderer.info.render.calls` if the stat is 0.

---

## 10. Module APIs (contracts)

```
HQV.hqAirfield (games/hqairfield.js, Task 1, pure: no THREE, no DOM)
  layout(W, site) -> L | {ok: false, why}
  toFrame(L, x, z) -> [u, v]; toWorld(L, u, v) -> [x, z]
  floorAt(L, x, z) -> L.y inside a platform polygon or the approach/localizer piers (3 m wide), else null
  onPavement(L, x, z) -> "runway"|"taxiway"|"apron"|"road"|null
  end(L, standId, endIdx, cx, cz, {stopDist}) -> v2 end (7.3)
  runwayEnd(world, ms) -> 0|1; windAt(world, ms, L?) -> {end, yaw, speed}
  timetable(world, dests, fromMs, toMs) -> [movement]; SLOT, PERIOD, GAP, slotBase(world, m), slotAt(world, ms)
  hash(s)
HQV.hqAir (games/hqair.js, Task 2, pure) adds: normEnd(e), K.amphib, route(kind, A, B, {a, b}) for v2,
  poseAt (+rev, phases), traffic(AF, ctx, nowMs, o), aheadOf(R, along, d) -> {x, z, yaw}
HQV.hqAirport3d (games/hqairport3d.js, Task 3)
  plan(L, {ground}) -> {paint: {white, yellow, red, black: [quads]}, lights: [{x, y, z, group, end?}],
                        fixtures, fence: [[a, b]], signs} (pure)
  create(c, L, o) -> {g, setNight(n), setRunway(endIdx), setHold(endIdx, clear), setWind(w), setDetail(level),
                      update(dt, t, camera), stats(), dispose()}
HQV.hqAirbldg (games/hqairbldg.js, Task 4)
  plan(L) -> {floors, blocks, gates: {standId: spot}, bridges: [{stand, rot, ext, ret}], hangarStand} (pure)
  floorAt(P, x, z, yRef), blockedAt(P, x, z, y), gateSpot(P, standId)
  create(c, L, o) -> {g, plan, setBridge(id, k), setBoard(lines), setNight(n), setDetail(level), update(dt, t), dispose()}
HQV.hqCivic BUILD.airport (Task 4): landside terminal only (5)
HQV.hqAircraft (Task 5) adds DOOR_L1, NOSE, SPAN, P.setLivery, amphibian, parked
HQV.hqAirground (games/hqairground.js, Task 5)
  poses(L, stands, moving, nowMs, ahead) -> [{type, x, y, z, yaw, lift?, beacon}] (pure; ahead(movingEntry, d) -> {x, z, yaw} | null
        is injected: integration passes hqAir.aheadOf, tests pass a stub over a literal polyline)
  create(c, L) -> {g, set(poses), setNight(n), setVisible(b), setDetail(level), dispose()}
```

---

## 11. Tests (node, `tests/test_<module>.py`, run via `python3 -m unittest discover -s tests -q`; check the exit code)

**Draw-call counts:** every test that counts draw calls (T3, T4, T5) loads the vendored three.js in node and counts with `HQV.hqMerge.drawCount`, exactly as `tests/test_hqcivic.py` does: `import(games/vendor/three-module.js)`, a stub `window`, the stub hq3d ctx, and canvases as a no-op 2D proxy. Do not write a fake THREE. Count with night on and off, and at each `setDetail` level.

**`test_hqairfield.py`** (T1):
- `layout(claude-hq@2)` deep-equals the fixture within 0.01 m;
- `layout(claude-hq@1)` and `layout(island@2)` (no airport site) return `{ok: false}` without throwing;
- every `L.curves` endpoint touches its two lines within 0.05 m, tangent within 1°;
- every `end()` polyline is continuous, with ≤ 5 m steps and no gap > 0.5 m;
- every ground path point is on pavement (`onPavement`) or inside its own stand box;
- `dep.line` ends at `E.lineup` within 0.05 m, heading along `E.dir` within 1°;
- `L.serviceRoad` at its full width is on the platform, outside every stand box and off taxiway pavement and shoulders;
- every stand box is inside the platform;
- the landside footprints touch no road, lot, block or other site, except the access road's joint and the skybridge's span over Ring Road 5 (sampled at 2 m with `WD.surfaceAt`/`blockedAt` on `claude-hq@2`);
- `runwayEnd` and `timetable` are deterministic, with about 70% prevailing over 1000 periods; `runwayEnd` is constant within a period and changes only at period boundaries;
- slot movements are 60 s apart; there are no movements inside a gap; `slotBase`/`slotAt` round-trip for negative m;
- the stand reuse rules in 7.2 never put two airframes on one stand (6 contact, 3 commuter);
- `floorAt` is `L.y` on the platform and on the piers, and null on the open sea and inland.

**`test_hqair.py`** (T2, updated):
- v1 ends still pass the existing invariants (phase names updated);
- with v2 ends hand-built in the test from the fixture's lines and curves (the test's own small builder, per 7.3), run takeoff and landing:
  - lift-off speed 70..80 m/s, lift-off ≤ 1200 m from line-up;
  - glideslope 3° ± 0.15;
  - touchdown 330 ± 15 m past `thr`, within 1 m of the centreline;
  - `exitAt` = the curve start of the expected exit (jets A5 or A2; amphib A4 or A3), using the 7.3 formula;
  - pushback moves backwards and the yaw is reversed;
  - speed is never above the caps in 7.3;
- the flown ground track's lateral offset from the nearest painted line or curve is ≤ 0.5 m at every sample (the drawn = flown invariant);
- `traffic()` with a stub `AF` built from the fixture plus the real timetable rules:
  - the separation invariant over 6 h, run twice: once with the real `runwayEnd` and once with the end alternating every period;
  - runway occupancy windows never overlap;
  - concurrency is ≤ 4 per class in `moving` at every step;
- the cache is bounded (≤ 96), and a cache hit does not call `route()`.

**`test_hqairport3d.py`** (T3):
- `plan(fixture)`: all paint quads lie on pavement;
- lights: 33 edge lights per side ±1, centreline 107 ±1, and the colour rules per in-use end;
- PAPI angles; the approach bars are on `E.approach`;
- no fence segment crosses pavement or the service road;
- the floodlight masts are off the service road and outside every stand box;
- draw calls (real THREE, see above): ≤ 24 at level 2, and within the 9 table at levels 1 and 0.

**`test_hqcivic.py`** (T4):
- the airport at [40, 160] keeps every existing invariant, plus everything inside the site polygon (canopy included);
- the nave has no blocking box below 2.4 m between the door and u = 0;
- `note()` heights equal the real tops.

**`test_hqairbldg.py`** (T4):
- extended cab-door distance ≤ 0.6 m (xz) and ≤ 0.3 m (y) for all 6 stands;
- retracted clearance ≥ 2 m from the stand box and the lead-in swept path;
- no rotunda column, bogie leg or mast footprint on the service road;
- floors are continuous from the door, through the ramp, the skybridge and the gallery, with no step > 0.5 m;
- the civic nave matches `plan(L).floors`;
- the skybridge `floorAt` returns null for `yRef` at road level;
- `gateSpot` exists for all 9 stands and lies on a gallery floor;
- everything is inside its `L` footprint; tower height 66 ± 1;
- draw calls (real THREE) ≤ 28 at level 2 (bridges ≤ 5), and within the 9 table at levels 1 and 0.

**`test_hqaircraft.py`** (T5, new):
- `parked()` stays ≤ 7 draw calls for n = 1 and n = 12;
- `setLivery` disposes its material on `dispose`;
- the `DOOR_L1` / `NOSE` / `SPAN` constants match the model's geometry bounds within 0.1 m.

**`test_hqairground.py`** (T5):
- deterministic poses;
- no vehicle on runway or taxiway pavement, shoulders included, except the tug while pushing plus its 30 s return, and the follow-me car;
- vehicles stay on the platform; a stand-bound vehicle enters only its own stand box;
- the tug stays within 1 m of nose + 4 m during push;
- the follow-me car stays 70 ± 5 m ahead (with a stub `ahead`);
- draw calls (real THREE) ≤ 12.

**`test_hqvoyage.py` / `test_hqairbase_spot.py` / `test_hqtravel.py` / `test_hqminimap.py`** (T6):
- the capsule constant equals the fixture's;
- the fleet loops and ferries for the test archipelagos stay ≥ 40 m from the capsule;
- `hqairbase` exports two pure helpers so placement can be tested without THREE: `clearOfAirfield(L, rect, buffer)` and `carrierSpot(sea.land, airportSite, L)`. The carrier spot clears `keepOut`. A base rectangle overlapping the platform, the skybridge capsule or an approach corridor is rejected;
- `hasTerminal` presumes no airport for islands;
- the travel arrival clears the airfield structures;
- `setAirfield` paints runway pixels at the fixture's runway position and is idempotent.

**`test_airport_integration.py`** (integration, new): T1's `end()` feeds T2's `route()`, and the result runs over T3's `plan()` paint:
- the drawn = flown check over the real modules, not hand-built ends;
- the T1 `floorAt` + T4 `floorAt` walk from the civic door to the gallery of stand 3.

**`test_hq3d_integration.py`:** the script list gains the new modules (integration).

Backend: unchanged. Still run `cd backend && cargo test -q && cargo clippy -q --all-targets -- -D warnings` before merge (`PATH=$HOME/.cargo/bin:$PATH`).

---

## 12. Headless acceptance (integration; headless Chrome only, `HQ_GL=metal`, own profile directory)

**Driver.** `tools/airport_smoke.py <base url> <out dir>` (new, integration), built on `tools/ui_smoke.py`'s Chrome class and the patterns in the earlier `sc_nav.py`. It opens the Commons and uses `HQ3D_DEBUG.teleport/mode/stats` and `HQV.hqCity3d.air`. **Look at every PNG yourself and judge it honestly.**

| # | shot | expected |
|---|---|---|
| 1 | map view centred on (-850, 0), day | runway, A and B, exits, apron with numbered stands and parked jets, terminal, skybridge over the ring road; nothing overlapping the runway; the air base on land, away from the platform |
| 2 | threshold 36, eye 2 m, looking +z | piano keys, "36", aiming point, centreline to the horizon, edge stripes |
| 3 | gallery spot of stand 4, looking at the apron | a jet nose-in with the bridge attached, vehicles at work, lead-in lines, stop bar, stand number |
| 4 | curb | canopy, glass hall, forecourt with taxi and bus bays, car park, access road joined to the street |
| 5 | walk: curb, door, nave, ramp, skybridge, gallery (scripted keys) | avatar y follows the floors; never inside a wall; never pops up from the ring road |
| 6 | night, far view from the city | runway edge and centreline lights, approach lights with the rabbit, apron floodlights, tower beacon, obstruction lights |
| 7 | night, short final 36 (an ambient arrival's pose, chase cam) | approach lights ahead and aligned; PAPI 2 white and 2 red |
| 8 | booked Isle Hopper: stand, pushback, taxi on B, hold, lineup, takeoff roll, climb | the phase in `air.state()` matches; the plane on the painted lines; the tug at the nose during push |
| 9 | arrival from an island (`air.ride`): flare, touchdown, exit, taxi, stand, step out at the gate | touchdown at the aiming point; follow-me car (jets); arrival in the gallery |
| 10 | 10 minutes of simulated time (`skip`) at the apron | stands cycle (bridges extend and retract), runway occupancy windows don't overlap, no two aircraft overlapping (check the poses numerically too) |
| 11 | the spawn view, then a walk toward the airport | LOD level 1 at spawn (≤ baseline + 30 calls), level 2 within 600 m, no visible pop of the runway or the lights at the switch |

**Numeric checks in the page:**
- the projected flown path vs the painted centreline: sample `pose` during a roll, and assert the lateral offset from `L.lines.RWY` is < 0.5 m;
- the draw-call and triangle budgets in section 9;
- no console errors;
- `air.perf()` ≤ 1 ms;
- `HQ3D_DEBUG.probe()` sane.

Also run `python3 tools/ui_smoke.py` (`MAX_DRAW_CALLS` 400).

---

## 13. Integration (not a parallel task; done after the six merge)

- **`games/hqcity3d.js` AIR block:**
  - build `L = HQV.hqAirfield.layout(W, airportHere())` once per city;
  - create `hqairport3d`, `hqairbldg` and `hqairground` into `airG`;
  - drop `airDress` and `CRAFT.airport`;
  - feed `setNight`, `setRunway(runwayEnd)`, `setWind(windAt)`, `setHold`, `setBridge` (from `traffic().stands`), `setBoard` (next departures, text only) and vehicle poses;
  - draw the parked fleet from `traffic().parked` plus `plan.hangarStand`;
  - draw moving aircraft from `traffic().moving` (pool + `setLivery`);
  - replace the per-route `flights()` drawing for Commons-airport routes with the timetable (island-to-island seaplanes unchanged);
  - `airKind`: jet only if both ends have an `L`; Commons to island is `amphib`; island to island is `sea`;
  - the booking and menu text: "🛩 Isle Hopper to X";
  - add pushback, hold, lineup and exit to the HUD's `PHASE_TXT`;
  - make `airCam` aware of `floorAt` beyond `W.half`. Every `W.half` guard in `hqcity3d.js` that falls back to `sea.y` (today about `:1407` in `airBoard` and `:1784` in the air-ground hook) must ask `hqAirfield.floorAt` first, because half of the runway is past `W.half`;
  - drive `setDetail` (9) from the camera every frame (cheap: one distance to the platform's bounding rectangles);
  - the map mode's pan and zoom bounds must include the platform's bounding box plus the approach piers, because the baseline map could not pan past x -1024;
  - add `w.air.layout()`, `w.air.traffic()` and `w.air.perf()` for tools.
- **City hooks:**
  - `groundY`: platform `floorAt` (Task 1), and for the avatar `hqairbldg.floorAt(x, z, avatarY)`;
  - `blocked`: building blocks and the platform edge over water (the sea check already blocks off the platform; make `floorAt` win over `sea.land`);
  - `heliFloor`;
  - camera ground.
- Pass `o.airfield = L` to `hqAirbase.create`. Call `minimap.setAirfield(L)`.
- The island side: load the Commons doc (`WD.load`) to build the Commons `L` for drawing arriving and departing hoppers. Without it, fall back to `nominalAirport` drawing only.
- `ui/app/22-hq.js` `HQ_SCRIPTS` and `tests/test_hq3d_integration.py`: add `"hqairfield"` before `"hqair"`, and `"hqairport3d", "hqairbldg", "hqairground"` after `"hqaircraft"`.
- Delete `hqaircraft.airport()`.
- `AIR_MAX` stays 4 per class; T2's concurrency test guarantees `traffic()` fits it.
- Add `tests/test_airport_integration.py` (11).
- Run section 12.
- Bump `APP_VERSION` and add a README changelog line.

---

## 14. Parallel tasks (disjoint files)

| task | files (only these) | depends on, at test time |
|---|---|---|
| T1 airfield layout and timetable | `games/hqairfield.js` (new), `tests/test_hqairfield.py` (new), `tools/airfield_fixture.js` (refactors only: regenerating must give a byte-identical fixture) | fixture |
| T2 flights | `games/hqair.js`, `tests/test_hqair.py` | fixture (hand-built ends, stub `AF`) |
| T3 ground, markings, lights | `games/hqairport3d.js` (new), `tests/test_hqairport3d.py` (new) | fixture |
| T4 buildings | `games/hqcivic.js`, `games/hqairbldg.js` (new), `tests/test_hqcivic.py`, `tests/test_hqairbldg.py` (new) | fixture |
| T5 aircraft and ground vehicles | `games/hqaircraft.js`, `games/hqairground.js` (new), `tests/test_hqairground.py` (new), `tests/test_hqaircraft.py` (new) | fixture, stand-state literals, stub `ahead` |
| T6 neighbours | `games/hqairbase.js`, `games/hqvoyage.js`, `games/hqtravel.js`, `games/hqminimap.js`, `tests/test_hqvoyage.py`, `tests/test_hqtravel.py`, `tests/test_hqairbase_spot.py` (new), `tests/test_hqminimap.py` | fixture |

`games/hqcity3d.js`, `ui/app/22-hq.js`, `tests/test_hq3d_integration.py`, `tests/test_airport_integration.py`, `tools/airport_smoke.py`, `README.md` and `dashboard-rs/src/app.rs` (version) belong to integration only. The fixture file is read-only for every task. If a task finds the fixture wrong, it reports this instead of editing it.

Other shared files no task may touch: `games/world.js` (see 3.3), `games/hqmerge.js`, `games/hq3d.js`, `games/npcsim.js`, `games/hqnav.js`, `games/hqheli.js`, `backend/`. The NPC "ground crew" (`npcsim.js:74`) keeps working at the civic site, which is now the terminal. Nav and minimap POIs keep pointing at the site door. Both are acceptable as they are.

**Self-check for the visual tasks (T3, T4, T5) before integration:**
1. Make a preview root under the scratchpad (not inside any git checkout), with symlinks `games`, `ui` and `index.html` pointing to your worktree, a `config.json` of `{}`, and a `harness.html` of your own.
2. The harness loads the vendored three.js the way `games/hq3d.js` does, your module, and the fixture inlined as JSON. It builds a minimal `c` (`THREE`, `mat(hex, o)` like `hq3d.js:220`), and renders your part over a flat grey plane and a blue sea plane at y -4, with an orbit camera set from the URL hash.
3. Serve it with `tools/local_arena.sh dashboard-tmp <root> <port>`. Shoot it with `tools/ui_smoke.py`'s Chrome class (`HQ_GL=metal`, your own `--user-data-dir`). Read the PNGs.
4. Stop it with `tools/local_arena.sh stop-tmp <port>`.

Never touch port 8765, `config.json` or `arena-link.json` in the repo root. Never run kubectl, cabal or nix. Don't push.
