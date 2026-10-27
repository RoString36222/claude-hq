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
| 2 | Real road classes: widths, lanes, markings, one-step changes over tapers | |
| 3 | Junctions by road pair: give-way, roundabouts, signals as generator data | |
| 4 | Curved roads: arcs, minimum radii by design speed | |
| 5 | Capacity per segment and the 0–100 % NPC traffic slider | |
| 6 | Flyovers, underpasses and interchanges; road tunnels | |
| 7 | Metro and rail corridors: piers only in boulevard medians | |
| 8 | Trams on any road class, with stations | |
| 9 | HQ spacing and movable garages | |
| 10 | Graphics pass within 1,200 / 240 draw calls | |
| S | Ambient volume slider and proximity sound (any time) | |

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
