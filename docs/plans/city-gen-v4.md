# City Gen v4: phases

The plan (City Gen v4 Plan, 24 Oct 2026) rebuilds the 3D City's world generator so roads,
transit and lots are planned like a real city. It ships **a phase at a time**. Each phase
merges on its own and leaves the City playable:

- **The live world upgrades in place.** `@3` keeps its id. The id is in about 45 files, so
  v4 is not a new version.
- **The world doc only gains fields.** An older dashboard still renders the new world, and
  a newer dashboard falls back to today's look on an older Arena.
- **The validator is in CI** (`backend/src/worldgen/validate.rs`). Each phase makes its own
  rules hard.
- **Layout phases regenerate the cities.** Lots, and so HQs, stay where they are wherever
  possible.

| # | Phase | Status |
|---|---|---|
| 1 | Airport claims its land; highways and the ring go round it; validator; road classes as data | **3.24.0** |
| 2 | Real road classes: widths, lanes, markings, one-step changes | **3.25.0** |
| 3 | Junctions by road pair: give-way, roundabouts, signals as generator data | **3.26.0** |
| 4 | Curved roads: arcs, minimum radii by design speed | **3.27.0** |
| 5 | Capacity per segment and the 0–100 % NPC traffic slider | **3.28.0** |
| 6 | Flyovers, underpasses and interchanges; road tunnels | **3.29.0** (interchanges), **3.30.0** (the ring's tunnel under the airport) |
| 7 | Metro and rail corridors: piers only in boulevard medians | **3.31.0** (the City Line's boulevard, as phase 8 here) |
| 8 | Trams on any road class, with stations | **3.32.0** (today's tram streets as tram roads, as phase 9 here) |
| 9 | HQ spacing and movable garages | **3.33.0** (movable garages, as phase 10 here; HQ spacing left: HQs stay on their lots) |
| 10 | Graphics pass within 1,200 / 240 draw calls | **3.34.0** (the graphics pass, as phase 11 here) |
| S | Ambient volume slider and proximity sound (any time) | **3.35.0** |

## Phase 1 (3.24.0)

- **`claims.rs`:** the airport's claim, rebuilt from the airport site alone. It covers:
  - the landside the client draws, each piece with 4 m round it:
    - the forecourt
    - the terminal with its canopy and skybridge
    - the car park
    - the control tower
  - the airside for every runway offset the client tries (355–455 m)
  - the object-free areas
  - the runway protection zones: 61 m past each end, 518 m long, widening from 152 m to
    308 m (FAA AC 150/5300-13B)

  Roads keep off the whole claim. Only the terminal, the airside and the runway zones
  must be dry: on the live Commons, the client's car park already stands in a lake, and
  the validator lists that (`airport-water`) for a later phase.
- **The ring corridor:** the strip between the terminal's back and the airside.
  - The ring road alone may run there, under the terminal's skybridge, as the airport was
    designed (`airport-spec.md`). It is the user's call for phase 1 (27 Oct).
  - On the Commons the town's own street meets the airport's forecourt, so the ring has
    no room landside. Leaving it open cut the City's traffic from 197 to 118 cars.
  - Phase 6 takes the ring under the airport.
  - The airside claim starts where the client puts the airside with the ring there: the
    runway at 395 m, as on the Commons.
- **`civic::airport_first`:** places the airport before the graded roads. It uses the
  same search as before, plus these checks:
  - The claim stays clear of every block and site.
  - Its dry part stays clear of the river, its pools and the water bodies.
  - The client's platform rule must hold at one of its runway offsets: the airside ground
    no higher than the terminal's.
- **Roads (`roads.rs`):**
  - Highway and ring steps never enter the claim.
  - A gate inside the claim, or cut off from the city by it, slides along the world's
    edge until it is clear.
  - Highways keep out of the ring corridor too, so they meet the ring away from the
    airport.
  - A ring section whose only way past the airport is the long way round the city
    (beyond the far side of the city from its two ends) is left out, and the ring stops at
    the highway junctions either side. This happens on 1 of the 49 seeds; the Commons
    keeps all six sections.
- **Other layers keep off the claim:**
  - the dock, port and stadium (`civic::outside`)
  - the line planners' stations, depots and trenches (`lines::Land.taken`)
  - the Island Link's above-ground track (`railway.rs`)
  - trees: the claim's districts are wild, not forest or park
- **Validator:**
  - Hard rule: nothing but the airport stands in its claim.
  - What counts for track: underground (3 m of ground over the rails) is fine anywhere.
    A viaduct is fine over the landside, as the City Line's airport station is at the
    kerb. Nothing above ground may stand over the airside or the runway zones.
  - Listed only, for later phases: site overlaps, lot/site overlaps, roads through
    sites, roads over water, the landside over water.
- **`classes.rs`:** the 11 road classes with tram versions, capacity (one car per 7.5 m of
  lane; level of service D, 22 a km a lane), minimum radii, tapers, the one-step ladder,
  junction by road pair, and spacings.

### Before and after (`worldgen --validate`, release build)

The worlds are the Commons (`claude-hq@3`) and 49 Commons-profile seeds (`v4seed1@3` to
`v4seed50@3`). `v4seed7@3` fails to generate on main too, because it has too few HQ lots.

| | main | 3.24.0 |
|---|---|---|
| The Commons: roads in the airport's land | 5: Await Way, Stack Way, Ring Road 4–6 | 0 |
| Worlds breaking the airport rule | 50 of 50 | 0 of 50 |
| Client runway fits (`hqairfield.layout`) | 17 of 50 | 50 of 50 |
| HQ lots unchanged | — | 50 of 50 |
| Ring left open beside the airport | — | 1 of 50 (not the Commons) |
| The Commons: NPC cars, Monday 09:00 | 197 | 196 |

On the Commons, these are unchanged:
- the airport and its runway
- the ring behind the terminal
- the metro: 2 lines, 8 stations
- the rail stations
- the City's traffic
- every HQ lot

The changes there:
- The two west highways (Stack Way and Await Way) now meet the ring north and south of
  the airport, instead of boxing in the terminal.
- The airport's grounds have no trees.

### Tests that depended on the old world

Four browser tests asserted luck of the old fixture: which streets, spot or platoon the
hashes happened to pick. They now check the rule they meant, and pass on both the old
fixture and the new one:

- **`test_play_races`:** checkpoint 2 is missed on whichever side keeps the drive clear
  of it.
- **`test_play_street`:** the median of the ten busiest spots, not one spot.
- **`test_citylife_traffic`:**
  - The mix picks lorries, and only a platoon's first car drives one.
  - The view draws a lorry body.

## Phase 2 (3.25.0)

The user's calls (27 Oct): real widths; boulevards only where they fit, with no lot or HQ
moving.

### Generator

- **Each street's starting class** (`organic::v4_roles`):
  - main road: boulevard where every block along it is at least 50 m, else avenue
  - old-town or plaza street: shared street
  - dead end, or under 60 m: lane
  - 150 m or more and joining main roads at two places: collector
  - anything else: local street
- **Paving** (`widen.rs`): a street steps down its class ladder, as the 3.20.1 tiers did,
  where a lot can't give way, or where its carved ground would reach water.
  - A main road may step down below its layout width only to keep a bend one class at a
    time. Its lanes are then the class's, and the footpaths take the rest.
  - Where a road runs on through a bend, its two sides are at most one class apart.
- **New road fields** (only on `@3`; `@1` and `@2` stay byte-identical):
  - `v4`: the class
  - `lanes`: lanes each way
  - `median`: the median width (cm). Not set on a street a tram runs down until phase 8.

  `class` keeps today's kind, so older dashboards still work.
- **Validator, hard rules:**
  - `class-width`: carriageway, lanes and median are the class's, and footpaths at least
    the class's.
  - `class-step`: a town road at a bend is at most one class from its other side.
  - A step involving a highway or the ring is listed for phases 3 and 6.

### Browser

- **`world.js`:** carries `v4` and `median`. A median is raised paving, not carriageway.
- **`worldgeom.js`:**
  - kerbed medians: concrete, or planted on a boulevard
  - pavers on shared streets
  - lines by class: none on a shared street or lane; a dashed centre on a local street or
    collector; edge lines along a median and dashed lane lines
  - no zebras across a shared street or lane
- **`traffic.js`, `npcsim.js`:**
  - cars drive in the class's kerb-side lane between median and kerb
  - an emergency run never takes the middle of a road with a median
  - where the lanes in and out of a sharp bend cross, they are cut back, as at a hairpin
- **`citylife.js`:** a light's approach that leaves under 8 m to wait in, with a junction of
  three roads behind it, makes the two one box (as a short link already did).

### Results

The worlds are the Commons and 49 seeds, against phase 1:

| | phase 1 | 3.25.0 |
|---|---|---|
| Hard rules broken | 0 | 0 |
| Airports, runway fit, HQ lots unchanged | — | 50 / 50 each |
| Commons NPC cars, Monday 09:00 | 185 | 196 |
| Commons lorries (industrial test) | 0 | 4 |

The Commons' edges by class: 121 avenue (89 with a median), 102 collector, 253 local, 127
lane, 49 shared.

No boulevard fits yet. In today's organic layouts no main road has 50 m blocks all along,
and a 36.5 m road's junctions need them. In a first try that paved boulevards wherever the
lots allowed, their junctions overlapped and traffic jammed at the lights.

The ring and highways stay at today's widths. As 29 m expressways at at-grade junctions,
they cut the Commons' traffic from about 200 cars to 133. They become expressways with
their interchanges in phase 6.

## Phase 3 (3.26.0)

### Generator (`Roads::junctions`, `junction_kinds`)

Each junction of town roads gets `junction` (`priority`, `mini`, `roundabout` or
`signals`) and, for a roundabout, `island` (its radius, cm). The decision is by the two
highest *roads* that meet, not arms: a street running straight on through a junction is
one road, so a T stays a T.

- **Give-way** (`priority`): local streets, lanes and shared streets with each other or a
  collector, and a side street joining a main road at a T. The plan's table has no row for
  a side street onto a main road; a T gives way.
- **Mini roundabout:** a five-arm give-way junction, and collectors meeting each other or
  an avenue where a full roundabout has no room.
- **Full roundabout** (32 m, a 10 m planted island): collectors meeting each other or an
  avenue, only where every arm is at least 40 m long and the circle (plus 1 m) is clear of
  every lot and site. The line planners keep off its circle.
- **Signals:**
  - avenues and boulevards crossing
  - a main road crossing a side street (a four-way, as in 3.22.1): "main" means an arterial
    by function, even one paved narrow, and the light stays at least 60 m from any other
- **A tram line through a junction** never gets a roundabout: lights where a main road
  meets, else give-way.
- **Junctions with a highway or the ring** have no control yet. They are phase 6's
  interchanges.

Validator, hard rule `junction`: every junction carries the control its roads call for,
and a full roundabout has room on every arm.

### Browser

- **`citylife.signals`:** where the world carries junction data, lights stand exactly at
  its signals. The arms, stops, timings and links logic is unchanged. A world without the
  data is lit as before.
- **`worldgeom.js`:**
  - a mini roundabout's white dome
  - a full roundabout's paved circle, with a kerbed, planted island and no corner footpaths
    cutting into it
  - give-way lines across the way in on every arm of a roundabout, and on the lesser roads
    of a give-way junction
- **`world.js`:** a full roundabout's island reads as raised ground.
- **`traffic.js`:** turns at a roundabout go round its island (2 m out from a mini one's
  dome, 3 m into a full one's 6 m carriageway), circling with the island away from the kerb.
  A full roundabout's box is its circle.
- **`npcsim.js`:** residents' car routes take the same arc round a full roundabout
  (`roundRoute`).

### Results

- **The Commons:** 26 signals (24 lit, two pairs a short link apart are one junction), 11
  mini roundabouts and 225 give-ways.
- **50 worlds:** 411 mini roundabouts, 1,185 signals, 9,328 give-ways and no full roundabout. A
  32 m circle with three separate roads meeting rarely has room in today's organic
  layouts, so `test_junctions_v4.py` makes one at a busy Commons junction to test it.
- **Traffic:** cars on screen by day 16.7 against phase 2's 15.9; 173 cars in all against
  196, with fewer side streets lit than 3.22.1's 43.
- **No layout change:** airports, runway fit, HQ lots and the metro are the same as phase 2
  on all 50 worlds.

## Phase 4 (3.27.0): curved roads

- **Town streets** (`roads::fillet_bends`): every bend where a street runs on (a node of
  exactly two town edges, not a bridge) becomes a circular arc instead of a corner.
  - It's the widest arc whose middle sits no more than 25 cm inside the corner. That's the
    kerb's width, so the paved road still keeps off every lot and no lot or HQ moves.
  - Its tangents reach no further than 0.4 of either edge, and it's sampled every 2.5 m
    with at least one step per 15° of turn.
  - The node moves onto the arc's middle.
  - The maths is integer only: Q16 unit vectors, half angles from the cosine, and points
    round the centre by normalised interpolation.
- **Ring and highways** (`roads::smooth_path`): the A* path's 45° steps are eased by a
  three-pass moving average (4 points each side, ends fixed), then sampled every 4 m.
  Where a smoothed step meets a block, claimed land, the river or the coast's reach and
  the path's own step there didn't, the path's points come back over 5 steps either side.
- **Validator, listed for later phases** (organic layouts can't meet the plan's radii yet):
  - `bend`: a town street still turning over 20° at a bend, a sharp corner the kerb's
    25 cm can't round
  - `curve`: a curve tighter than its class's design-speed minimum

### Results

The worlds are the Commons and 49 seeds.

| | phase 3 | 3.27.0 |
|---|---|---|
| Commons town bends turning under 5° at the node | 78 of 199 | 133 of 199 |
| Ring and highway kinks over 17°, the Commons | 139 | 18 |
| Ring and highway kinks over 17°, all 50 worlds | 7,182 | 1,109 |
| Airports, runway fit, HQ lots unchanged | — | 50 / 50 |
| Commons cars on screen by day | 16.7 | 16.5 |

The metro shifted slightly on 8 synthetic seeds, because it follows the roads. The
Commons' metro is unchanged.

### Also in 3.27.0 (the user's requests for the street)

- **Wanted stars** (`playheat.js`):
  - Each offence adds about half as much: ramming +0.5, a red light +0.5, props +0.1.
  - Repeat cooldowns are longer.
  - Only an offence worth a whole star forces one. A lone fraction wears off while no
    police car is near.
  - A star goes every 6 + 3×stars s unseen (was 12 + 6×stars).
- **Garage cars in traffic** (`traffic.js` `streetCars` / `carLook`):
  - Six everyday catalogue cars (hatch, sedan, SUV, coupe in turn).
  - Model and paint from a hash of the vehicle id, the same on every client.
  - Each is baked into one instanced mesh, scaled to the sim's car footprint, for the 40
    cars nearest the camera. The box car is the fallback.
- **Carjack** (new city play feature `playcarjack.js`):
  - E by a traffic car going under 4 m/s and within 3.5 m.
  - `hq3d` builds the same model where it stood and seats you. The traffic car is hidden on
    this client while you hold it.
  - Getting out parks it; 150 m away it goes back.
  - +0.5 heat when a police car sees it.

## Phase 5 (3.28.0): capacity and the traffic slider

- **`traffic.js`:** a traffic level from 0 to 1 (`o.traffic`, `sim.setLevel`).
  - The sim fills every slot's candidate cars for the fullest level. The level keeps those
    whose fixed hash is under its share of the slots.
  - At 0.85 (`LEVEL0`) the share is today's, the tier's `DENS`. At 1 it's every slot the
    timetable has; at 0, none.
  - Each ring keeps at most `LOS_D` = 22 cars a km of its lane at the level (the plan's
    comfortable level of service D at 100%) and never more than one per `CAR_M` = 7.5 m
    (the hard cap). The cars kept are the ones with the lowest hash.
  - Changing the level rebuilds each ring's cars, its platoon leaders, room and groups, so
    it's exactly a sim made at that level.
  - Buses and trams keep their timetables.
- **Settings** (`index.html` `setTraffic`, `ui/app/16-settings.js`): an **NPC traffic**
  slider, saved in localStorage `hq_traffic` (unset means 85%). It sets the open City's
  level live through `HQV.cityTrafficLevel` (`games/hqcity3d.js`).

### What limits traffic today

On the Commons the light and junction timetables hold about 9 cars a km of loop even with
every slot filled (196 cars). That's well under the plan's comfortable 22 a km and far under
the hard cap of 133 a km. So the slider's top end is the timetable's room, and the 22 a km
cap trims only one short, dense loop by the lights.

| Level | Cars on the Commons | Out at 08:00 |
|---|---|---|
| 0 % | 0 | 0 |
| 25 % | 41 | 40 |
| 50 % | 98 | 90 |
| 85 % (default) | 167 | — |
| 100 % | 191 | 179 |

Before this phase the Commons had 172 cars. The new cap trims one loop by 5.

## Phase 6 (3.29.0): expressways and trumpet interchanges

- **Expressways:** the ring and the highways are `v4: "expressway"`: 29 m, three lanes each way, a 3 m barrier median
  and 2.5 m shoulders. They are routed with that width (profile `ring_cm`/`highway_cm`) and never into a lake's or the
  marina's bank (the carving of a 29 m road would reach the water).
- **Trumpets (`backend/src/worldgen/interchange.rs`):** where a highway meets the ring and one fits, a trumpet
  replaces the junction, laid on the base terrain in the ring's frame. Points sit along the ring's eased line and out
  along its normal at the junction, so the stretches beside the ring follow its curve and the loop keeps its shape.
  - **The flyover:** the highway's last stretch (`v4: "flyover"`, a lane each way) climbs at up to 5.5 % to a deck
    7 m (5.5 m clear + 1.5 m deck) over the ring.
  - **Four one-way ramps** (`v4: "ramp"`, `oneway: true`):
    - two slip roads on the city side;
    - a 30 m loop off the deck to the ring's outer kerb, passing under the flyover;
    - a ramp round the loop, climbing to the flyover's top end T.
  - **Lane balance:** every ramp junction (`junction: "ramps"`) has as many of the sim's lanes in as out. An
    expressway's sim lanes are its lanes less the one by the median. The ring has a lane fewer each way between a
    trumpet's two ramp junctions.
  - **Heights:** come in `seat`, a second pass raising a flyover's foot on an embankment where the graded ring is higher
    than the land. Land under a deck is not carved.
  - **No trumpet** where the coast, a lake or the river, a block, the airport's claim, another road, a bridge or another
    junction is in the way; where the ring is too curved; or where the highway is too short or meets at an angle.
- **Validator:** `ramps`, `deck-grade` (6 %) and `clearance` (7 m under every deck) are hard rules; `road-overlap` lists
  roads crossing at grade with no junction. Expressway junctions still at grade have no control (no lights on an
  expressway).
- **Client:**
  - `world.js`: stacked surfaces. `groundAt`, `roadY`, `surfaceAt`, `nearestRoad` and `blockedAt` take the height of
    whatever stands there; `decksOf` and `piersOf`. `hqcity3d.js` passes the avatar's height for points near it.
  - `worldgeom.js`: decks, parapets, piers, retaining walls, expressway lane lines and barrier.
  - `traffic.js`: several lanes a way, one-way ramps, lanes paired by where they end.
  - `npcsim.js` and `hqnav.js`: route one way on the ramps.

| | Commons | 50 seeds + the Commons |
|---|---|---|
| Trumpets | 3 of 6 junctions | 70 of 296 |
| Cars at the usual setting | 292 (167 before) | — |

Most junctions left at grade have a highway that is too short or meets the ring at an angle (91), or another junction
or a bridge too close on the ring (63). A later layout phase (or tunnels) can take more of them.

## Phase 7 (3.30.0): the ring under the airport

- **Generator (`backend/src/worldgen/tunnels.rs`):** where the ring runs in the corridor behind the terminal, its edge
  is split into the ring, a cutting, the tunnel, a cutting and the ring again. The pieces below the land carry
  `under: "tunnel" | "cutting"`.
  - **The tunnel:** covers the corridor and 20 m beyond. Its road is level, 7 m (5.5 m clear + 1.5 m roof) under the
    lowest land over it.
  - **Each cutting:** at least 175 m long and long enough to come down at 4.5 % from the land at its outer end, kept
    60 m clear of the edge's junctions.
  - **Land:** nothing over the tunnel or the cuttings is carved; the client opens the cuttings as terrain holes.
  - **Metro and Island Link:** the metro dives 11 m under a road tunnel or cutting it passes, at 3 %; a depot's ramp
    keeps clear of one, and no station stands on one's nodes (so the metro lays out as it did before the tunnel). The
    Island Link skips a route that would come within 8 m of one. Splitting the ring keeps every other road's id.
- **Validator:** `tunnel` (hard): 6.5 m or more of land over the tunnel's road, cuttings no steeper than 6 %, no metro
  or rail track within 8 m of the road's level beside it. `clearance` now counts a road crossing a cutting.
- **Client:**
  - `world.js` and `worldgeom.js`: the cuttings are holes with retaining walls. The tunnel is a lit box under the land
    with portals.
  - Driving it uses the stacked surfaces of phase 6.

| | Commons | 50 seeds + the Commons |
|---|---|---|
| A tunnel under the airport | yes, 303 m with two cuttings of 375 m and 368 m | 13 of 50 seeds (the rest pass the airport elsewhere) |

## Phase 8 (3.31.0): the City Line's boulevard

The plan's phase 7: an elevated line only along a boulevard, its piers in the median, placed by the generator.

- **Generator (`backend/src/worldgen/corridor.rs`):**
  - **When it runs:** after the interchanges and the tunnel.
  - **Alignment:** `railway::alignment` plans the City Line on the streets as they are. Where the boulevard under it
    would take an HQ's lot, the streets beside that lot cost 20 times as much and it plans again, up to 8 times.
  - **The cut:** a 36.5 m boulevard (`v4: "boulevard"`, the 7.5 m `median`) along each stretch of land the line
    crosses.
    - **Where it starts and stops:** it starts where its reach clears Central's station building, and stops short of
      the airport's land and 15 m back from water. There the line stands on the station's frame, the landside or a
      bridge.
    - **What it takes:** every street within its reach goes. Each cut street meets the boulevard at a T, at least 50 m
      apart and never under a station. A main road always gets its junction (a collector meets it as an avenue), so
      the cars' network stays whole. Stubs a few metres apart merge. Side streets that can't join end short.
    - **Lots and stops:** lots in its way are retired as the lines' claims retire them, and kerb stops in it go.
    - **When there's no corridor:** an HQ's lot, a civic site or a graded road in the way means no corridor, and the
      line stays as it was.
  - **Piers (`railway::piers`):** about every 27.5 m (25 to 30 m), else the next place one may stand, up to a 60 m
    span. Each stands in the median (its 2 m column 0.25 m inside it, 3 m past any other road), or on clear ground
    near a station, in the water, or on Central's building. `rail.lines[].piers: [{x, y, z, h}]` (the doc only gains
    the field).
  - **Transit:** trams keep off boulevards. Where the cut splits a tram's street, it runs as one line each side.
- **Validator:** `rail-pier` (hard) fails a pier on a carriageway, footpath, lot or site, one off the boulevard away
  from a station or the water, and any span over 60 m. `rail-corridor` lists a City Line with no boulevard.
- **Client:**
  - `world.js` / `hqrail.js` pass `piers` through. `hqcityrail.js` draws them, in the same mesh, else spaces its own
    as before.
  - `blockedAt` makes them solid, and props, trees and furniture keep 1.5 m off them.
  - `hqride.js`: waiting at the stop's own place counts.
  - `npcsim.js`: a jogger turns back before a wider road's carriageway.

| | Commons | 50 seeds + the Commons |
|---|---|---|
| A boulevard under the City Line | yes: 7 pieces, 16 piers, no span over 60 m | 6 of 51 (the rest: an HQ's lot, a civic site or a graded road in the way) |
| Cars in the traffic sim | 250 (292 before: the sim's rings re-split round the new junctions, none overfull) | |

## Phase 9 (3.32.0): tram roads and stations

The plan's phase 8, for the streets trams run on today (the two main streets with the most frontage; routes on
desire lines are left for later).

- **Generator:**
  - **Tram roads (`organic/widen.rs`, `roads.rs`):** a tram street (two tram stops or more on it) is paved as its
    class's tram version: the plan's added width, the lots giving up frontage as for any wider road, HQs on their
    lots. Each class first tries its tram version, then the class as it is with the tram in its lanes, and only then
    steps down a class.
    - New edge fields: `tram` (`"centre-bed"`, `"shared-double"`, `"shared-single"`, ...).
    - On a centre bed, `bed` (cm) is the class's median and the tram's width together, and `median` is absent, so an
      older dashboard draws its trams down a flush middle, as before.
    - A tram road no line runs on is paved back to its class.
  - **Stations (`civic.rs`, `transit.rs`):** about 300 m apart along each tram street, half the plan's 600 m because
    the Commons' tram streets are a kilometre or so.
    - **Platforms:** each line's stations take the best set of 40 m by 3 m platforms on its track: straight to 1 m
      over 40 m, clear of every junction's box (the widest crossing road and 3 m), 100 m apart at least, never on a
      bridge. On an avenue's bed the platform is an island between the tracks. On a shared road it's a platform at
      the kerb. There's none beside a collector's bed, too narrow for an island, where the tram would stop a car
      lane away from the kerb.
    - **No room:** a station with no room (side streets every 24 to 48 m) stays a kerb stop.
  - **Track ends:** a line's track runs on past its end stations to the next junction (along its street, else the
    main road or the side street it runs into, the tram in its lanes), so it never ends mid-block. There are no
    there-and-back spurs.
  - **The boulevard:** trams keep off the City Line's boulevard, crossing included. Where it cuts a tram street, each
    side runs as its own line.
- **Validator:**
  - `class-width` knows the tram versions.
  - `tram` (hard) fails: a tram line on a road that is no tram version, a station platform on a bend or in a
    junction's box, and a track ending mid-block.
  - `tram-station` lists the stops left at the kerb.
- **Client:**
  - `world.js` packs `tram`/`bed`. The bed is raised paving, never carriageway.
  - `traffic.js`:
    - Cars keep outside a centre bed. Trams run in it (track centres 3.025 m apart from the middle on an avenue's
      9.2 m bed, room for the island; 2.025 m on a collector's) or in the inner lane on a shared road.
    - A light's phase for a movement is that of the arm it comes in by.
  - `worldgeom.js` draws the bed: raised setts, kerbs, marks.
  - `hqtramway.js` makes a 40 m platform an island between the tracks or at the kerb, by where it stands. The poles
    stand on the bed.
  - `hqcivic.js` gives a station a shelter, a ticket machine and a departure board.

| | Commons | 50 seeds + the Commons |
|---|---|---|
| Tram lines | 3, on 69 tram roads (35 centre bed, 34 in the lanes) | 95 |
| Stations on a 40 m platform | 5 of 9 (the rest kerb stops: side streets every 24 to 48 m, collector beds too narrow for an island) | 151 of 278 |
| Cars in the traffic sim | 292 (as before the corridor) | |

## Phase 10 (3.33.0): movable garages

The plan's phase 9, its movable garages. HQ spacing would move members' HQs to other lots, so it waits.

- **Arena (`backend/src/hqgarage.rs`, migration 0026):**
  - `GET/PUT/DELETE /v1/hq/me/garage` stores `{lot, x, z, r}`: the HQ lot's rank, whole decimetres in the lot's frame
    (|x| ≤ 400, |z| ≤ 300), and quarter turns.
  - Validation is strict (422), rate-limited like HQ Studio.
  - `garage` comes last in the HQ listing, absent when unset. The capability is `"garage"`.
  - The server checks shape only. Whether a spot fits is the client's call, because the footprints live there.
- **Local server (`dashboard-rs`):** `/api/arena/hq/garage` (GET, POST, POST reset) with an allowlisted body, CSRF
  and same-site checks. Egress: those four integers about your own lot.
- **Client:**
  - `hqcity3d.js` `garageFits`: the 7 × 6.2 m bay inside the lot, clear of the tower at its largest (both wings) and
    its walk, the 8 m apron in the lot or over its street edge, and a 3.5 m way to the street. A stored spot that
    fails, or one for another lot, falls back to the default, so every client draws the same.
  - Bays turn in quarters. Their walls, the car lift's door, apron and exit path, and the drawing all follow the
    turn.
  - Placement mode in `hq3d.js` and `ui/app/40-studio.js`. On an older Arena the spot is kept in localStorage
    (your HQ only).

| | Commons (64 HQ lots) |
|---|---|
| Default bay passes `garageFits` | 46 (the other 18 face back, their 8 m apron off the lot's back: they still stand where they always have) |
| Legal spots per lot (0.5 m grid, 4 turns) | 165 on average, median 27; 11 lots have none (too tight beside their tower) |

## Phase 11 (3.34.0): the graphics pass

The plan's phase 10. It adds detail to what phases 6 to 9 built, inside new frame budgets.

### Budgets

The plan sizes them for an M3 Pro and up. There is no GPU-tier detection: the only quality control stays the
governor in `worldbuild.js` (pixel ratio and shadows).

| | Before (3.15 to 3.33) | Phase 11 |
|---|---|---|
| Draw calls a frame, surface (the renderer's count, the shadow pass included) | < 700 | **≤ 1,200** |
| Draw calls a frame, below the street | < 120 | **≤ 240** |
| The world's tiles alone (`worldDrawCalls`) | < 400 | < 400 (unchanged) |
| Triangles a frame | < 1.5 M | < 1.5 M (unchanged) |

- **Where they are pinned:** `tools/ui_smoke.py` (`MAX_FRAME_CALLS`, `MAX_UNDER_CALLS`); `tools/transit_tour.py`
  and `tools/graphics_tour.py` read them from there; the page states them in `HQ3D_DEBUG.stats().budget`
  (`hq3d.js` `SMOKE_BUDGET`); `tests/test_graphics_budget.py` checks that all of them agree. The metro view's own
  underground budget in `tests/test_hqmetro.py` is 240 calls as well (400k triangles, unchanged).
- **Why the tiles' 400 and the triangles stay:** the plan only raises the frame's calls. The extra calls are for the
  new pieces, which are their own groups (markings, planting, deck detail, lights), not more tile meshes. The world's
  tiles batch to about 8 calls each and drew at most 106 at the tour's spots, so 400 still catches a tile-merging
  regression. Triangles are not what limits an M3 Pro, and the busiest spot drew 0.64 M before this phase, so 1.5 M
  leaves the new detail room while keeping the CI and software-rendering runs quick.
- **The per-module budgets don't change** (tramway ≤ 10, City Line ≤ 5, traffic ≤ 16, the metro surface ≤ 8, ...):
  they guard each module against regressions. The new room is for the new detail.

### The gate: `tools/graphics_tour.py`

`python3 tools/graphics_tour.py [claudehq] [OUT_DIR | --out OUT_DIR]` runs the HQ server, the fake Arena and headless
Chrome from `tools/ui_smoke.py`. It loads the page once and goes through eleven spots on the @3 Commons, all derived
from the fixture:

| Spot | From |
|---|---|
| trumpet | a road node with `junction: "ramps"`, from above |
| flyover | the middle of a `v4: "flyover"` edge, from the side |
| boulevard | a `v4: "boulevard"` edge (the City Line over its median) |
| tram-bed | an edge with `bed > 0` |
| tram-platform | a `tramstop` site with `w == 4000` |
| tunnel | the ring's tunnel, at its road's height (`HQV.world.tunnelsOf`, in the page) |
| cutting | the ring's cutting (`tunnelsOf`) |
| signals | the `junction: "signals"` node nearest the plaza |
| plaza | in front of the fountain |
| metro | the first metro station, below the street |
| hq-lot | your HQ lot (rank 0, the fake Arena's assignment) |

- **At each spot:** the avatar goes there so its tiles are built, a camera is held on the spot, and the tour waits
  until the draw calls stop changing.
- **It fails on:** more than 1,200 calls (240 below the street), 1.5 M triangles or more, or any page error.
- **It writes:** `NN-spot.png` and `graphics_tour.json` (each spot's calls, triangles, world calls and camera).
- **It runs in:** CI, after the UI smoke test (the shots are kept as the `graphics-tour` artifact), and in
  `ops/release.sh check`, after the UI smoke test (`ARENA_SKIP_UI=1` skips both on a machine without Chrome).
- **It takes:** about 2 minutes under SwiftShader on a Mac, 40 s of it the first page load.

At the base of this phase (before its detail), under SwiftShader:

| Spot | Calls | Triangles | Tile calls |
|---|---|---|---|
| trumpet | 381 | 573k | 106 |
| flyover | 106 | 355k | 33 |
| boulevard | 211 | 524k | 50 |
| tram-bed | 176 | 460k | 59 |
| tram-platform | 326 | 506k | 97 |
| tunnel | 193 | 366k | 54 |
| cutting | 248 | 408k | 53 |
| signals | 520 | 599k | 90 |
| plaza | 642 | 640k | 91 |
| metro (below the street) | 48 | 154k | 20 |
| hq-lot | 308 | 545k | 72 |

The calls move by a few percent from run to run (traffic, people and the clock).

### The detail

### The detail

Everything goes into meshes the tiles already had (`marks`, `kerb`, `bridge`, `tunnel`) or the per-tile instanced
trees, so the phase adds no draw calls. A @1 or @2 doc builds byte-identically.

- **Road paint (`worldgeom.js`):**
  - thin white edge lines inside the kerbs of avenues, collectors and boulevards;
  - a solid stop line where a minor road meets one two classes above it at a priority junction (the give-way dashes
    elsewhere; the lights' stop lines stay traffic.js's);
  - lane arrows 15 to 25 m before the line on approaches of two lanes or more (`arrowPlan`; traffic keeps left);
  - a yellow box at the lights where an avenue or boulevard meets;
  - chevrons in a ramp's gore.
- **Planted medians:**
  - a boulevard's median gets trees every 12 m (under the City Line, kept 1.2 m under its girder) and clipped hedges;
  - an avenue's gets low shrubs;
  - all of it clear of junction noses, piers, holes and decks (`medianPlan`).
- **Structures:**
  - parapets with a coping, and a drip lip under the fascias;
  - steel expansion joints at every pier line and each end of a span;
  - every pier's cap on two bearings;
  - lamp columns every 30 m a side on the decks;
  - downlights under a deck where it crosses a road, and low abutment walls along that road (the underpass);
  - the City Line's girder gets the same joints, bearings and lights.
- **The tunnel:** its ceiling lights are luminaires, and its walls are panelled over a drain. The cuttings get a
  plinth, panels, a kerb and drain at the foot, and wall lights that come on at night.

### Results

With the detail in, under SwiftShader:

| Spot | Calls | Triangles | Tile calls |
|---|---|---|---|
| trumpet | 388 | 538k | 106 |
| flyover | 113 | 302k | 33 |
| boulevard | 204 | 525k | 52 |
| tram-bed | 178 | 455k | 59 |
| tram-platform | 325 | 565k | 97 |
| tunnel | 201 | 381k | 55 |
| cutting | 246 | 392k | 54 |
| signals | 521 | 585k | 91 |
| plaza | 647 | 636k | 91 |
| metro (below) | 48 | 158k | 21 |
| hq-lot | 306 | 515k | 72 |

The busiest frame uses 54 % of the surface budget and the metro 20 % of the one below the street: the room is
for what comes next.


## Sound and settings (3.35.0)

Most of this was already in place from Sound PR B (3.11.1 onward): the Settings slider, the spatial layer in
`games/engine.js` and the City's voice pools in `games/hqcity3d.js` `citySound()`. This phase checks it against the
plan, fills the gaps and pins it down with `tests/test_sound_settings_v4.py`.

**Settings.** *Ambient sounds* is a 0–100 % slider (`#setAmbient`, step 5, `aria-valuetext` as a percentage, announced
on change) in the place of the old on/off switch. It is saved in localStorage `hq_ambient` as 0..1. The old switch
saved `"1"` for on and `"0"` for off, so it migrates without a step: on reads as 100 %, off as 0 %, and an unset or
unreadable value as 100 %. The value is the gain of the ambient bus, which feeds the master (Game sounds) bus. A
change glides the bus there at once, so it applies live. Thunder, rain, fireworks, jets, planes, water, fountains,
roadworks, the civic bells and the city's hum go through it, and at 0 % none of them makes a voice at all. *NPC
traffic* (3.28, `hq_traffic`, `HQV.cityTrafficLevel`) is unchanged.

**Distance.** Each kind fades by the Web Audio "inverse" model, `ref / (ref + roll·(d − ref))`, with full volume
inside `ref`. A taper `1 − ((d − ref)/(max − ref))²` takes it to exactly 0 at `max`, which "inverse" alone never
reaches, and past `max` the source is not played. The engine computes this curve itself and feeds a gain and a
`StereoPannerNode` rather than a `PannerNode`. A PannerNode never reaches 0, its listener orientation differs
between browsers, and HRTF is costly per voice.

**Panning.** The pan comes from the source's direction along the listener's right vector, scaled by `min(1, d/ref)`
and by 0.85, so a sound is never in one ear only. The listener is set every frame from the camera's world matrix
(or `{x, z, yaw}`).

**Voice limits.** Only the nearest N of each kind play. A pool keeps the N nearest sources in fixed slots, with no
sort and nothing made per source, and gives a playing voice a 15 % hold so voices don't flicker between two sources
at similar distances. All pools of the same kind share its N. A one-shot over the cap steals the farthest voice, or
is dropped if every playing voice is nearer. The caps add up to 67 voices across every kind, so a busy place costs
the same as a quiet one. Nothing runs without a listener: the City sets none when it isn't open or is hidden.

| Kind | Sources | ref (m) | max (m) | Voices | Bus |
|---|---|---|---|---|---|
| vehicle | NPC cars, vans, scooters, emergency runs, the cab coming to you | 5 | 120 | 6 | engine |
| bus | NPC buses, the coach | 6 | 180 | 3 | engine |
| tram | tram traction motors | 6 | 200 | 3 | engine |
| train | City Line, Island Link | 12 | 400 | 2 | master |
| metro | metro trains and stations | 10 | 250 | 2 | master |
| boat | water buses, ferries, cruise and cargo ships | 12 | 400 | 3 | master |
| heli | rooftop and called helicopters | 15 | 1500 | 2 | engine |
| plane | airliners, hoppers, seaplanes, the airport stands | 40 | 2500 | 2 | ambient |
| jet | the air base's jets | 60 | 1500 | 2 | ambient |
| door | doors, gangways, validators, lifts; bus and tram doors at stops | 2 | 40 | 4 | master |
| bell | tram bells, bridge warning bells, bike and lift bells | 5 | 250 | 3 | master |
| gondola | gondola stations, bridge machinery | 6 | 120 | 2 | master |
| construction | roadworks (new) | 10 | 200 | 2 | ambient |
| fountain | the plaza and Base fountains | 4 | 70 | 2 | ambient |
| water | lapping at piers, surf | 4 | 60 | 2 | ambient |
| hum | the city's hum | 40 | 800 | 2 | ambient |
| thunder / firework | storms, the spectacle | 100 / 40 | 1000 | 3 / 6 | ambient |

**New in 3.35.0:**

- **Roadworks** sound where they are. `cityevents3d.js` `sounds()` lists the roadworks that are on and built near
  you, and the `works` loop (a compressor's thrum and a breaker's hammering) plays through a construction pool.
- **Buses and trams at their stops.** A bus or tram that rests at a stop for 0.8 s opens its doors (`door-hiss`).
  As it pulls away, a tram rings its bell (`tram-bell`) and a bus closes its doors. Stops are looked up once a
  second within 160 m, and a vehicle held at a light, away from a stop, stays shut.
- **Fountains** go through the fountain kind's pool, so its 2-voice cap holds in the City as well.
- Construction moved to the ambient bus, since roadworks are background sound like fountains.

Calm and reduced motion add nothing to this. The one exception was there before: Game sounds starts at 0 under them
until you set a volume yourself. Master volume 0 (mute) silences everything, Ambient 0 % silences the ambient kinds,
and UI sounds stay on the master bus.

## Trams on desire lines

The rest of the plan's phase 8: routes on the main desire lines, stations about 600 m apart, curves of 25 m at least.

- **Routes (`organic/trams.rs`):** planned on the street graph before the civic sites and the paving, so the roads
  they follow are paved as their classes' tram versions and the stations stand along them.
  - **Places:** each district (a zoning seed's patch of six lots or more) at the middle of its doors, weighed by its
    floors, and the core (the plaza) at twice the mean district.
  - **Pairs:** every two places 300 m apart or more, strongest first by gravity (the weights' product over the
    distance). A pair whose two places a route already passes within 250 m of is skipped.
  - **A route:** the cheapest path from a junction within 200 m of one place to a junction within 200 m of the other.
    A side street costs 1.3 times a main road, a road no lot fronts 3 times, a road another route has 4 times, and
    every turn costs by its angle. Any class may carry it (the narrow ones share the lane). It never visits a node
    twice, goes at most 1.5 times the straight line, then runs on up to 250 m past each end to the last junction
    (through the district, not to its middle). It is kept if 300 m or longer.
  - **Only turns a tram can take** (`transit::tram_turn_ok`): at a bend, a 26 m arc whose tangents fit in 0.4 of
    either arm and whose middle moves at most 2 m into the corner (`fillet_bends` then curves it so); at a junction
    or a bridge's end the arms stay straight (the cars' turns and a bed's trims are drawn from them), so the corner
    must already be gentle (the circle through the node and the arms' points 8 m out at least 26 m wide).
  - **How many:** up to 3 on the Commons, 1 on a personal island.
- **Stations (`civic.rs`):** `TRAM_STATIONS_CM` is 60 000. A route has one 30 m in from each end and the rest evenly
  between, round(length / 600 m) gaps. Each takes the nearest free lot whose door is on the route (or at its kerb on a
  corner) within 60 m, up to 150 m along, a lot the HQ pool could draw last.
- **Lines (`transit.rs`):** each edge carries its routes' bits (`Edge::lines`, not in the doc). A route's roads run
  as one line, or one each side where the City Line's boulevard cut them (trams keep off it, as before). A line also
  splits where its finished track turns tighter than 25 m after all. Its ends are at a junction or a street's end:
  where the cut left one mid-block it runs on to the next junction if the tram can make the turn, else back to the
  last junction. A side with too few stations gets the rest as platforms on its track (`route_stations`).
- **Room for platforms (`close_mouths`):** where a station has no platform and a straight 40 m within its reach is
  blocked only by the boxes of one or two lanes or local streets meeting the line at a T, those side streets end 1 m
  past the tram road's edge (a cul-de-sac), and the lines are drawn again. Never a collector or a main road, one a
  tram runs on, the only way to the streets behind it, one a door opens onto in the closed piece, or where the tram
  road would bend two classes apart. Platforms (3.32's placement) now also keep off every lot: a kerb platform beside a
  2 m footpath would stand on the lots.
- **Fixes on the way:** a lane or local street paved as it is with the tram in its lanes, then left without a tram,
  kept its width (`untram_unused`); a trammed lane at its layout width passes `class-width` as an untrammed one does.
- **Validator:** `tram-curve` (hard) fails a line whose track turns tighter than 25 m: the circle through each point
  and the points 8 m or more back and ahead along it. `tram-station` lists the kerb stops, as before.

| | Commons | 50 seeds + the Commons (seed 7 has no world: its HQ pool) |
|---|---|---|
| Tram lines | 2 (3 before) | 124 (95 before) |
| Route length | 1.62 km (1.68) | 62.5 km (48.0) |
| Stations | 5 (9) | 255 (278) |
| On a 40 m platform | 5 of 5 (5 of 9) | 170 of 255, 67 % (151 of 278, 54 %); 136 before side streets closed |
| Side streets closed | 0 | 39, for 34 platforms |

On the Commons the strongest desire lines (the two heaviest districts, either side of the core) cross arterials that
kink 40 to 55 degrees on 12 to 18 m arms, where no 25 m curve fits, so its two lines run on the arterials round the
outer districts. A third route is planned, but no side of it keeps two stations once the City Line's corridor cuts it.
