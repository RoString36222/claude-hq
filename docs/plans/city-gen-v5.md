# City Gen v5: the generator from scratch, planned first, on levels

v4 (docs/plans/city-gen-v4.md) grew the @3 generator a phase at a time: streets and lots first, then the airport's
claim, interchanges, tunnels, the railways and the metro fitted round what was already there. Every collision in
3.36 (the Island Link over the airfield, the metro camera, piers on the airport) came from that order. v5 starts
again: **the city is planned first, the streets come last, and everything above or below the street is a level.**

## Rules

- **Plan first.** Space is given out in this order, and nothing later may take what was given earlier:
  1. the land and water (terrain, coast, river, lakes; reused from @3);
  2. the reservations: the airport with its approach surfaces, the port, Central, the stadium, the amusement park,
     parks, the university and hospital campuses, each with its clearances;
  3. the corridors: the railways (City Line, Island Link), the metro lines and their stations, the expressway and
     ring, the arterials and boulevards between district centres;
  4. grade separation where corridors cross (flyover, underpass, tunnel), decided once;
  5. local streets per district, then blocks, lots, sites and HQs.
- **Levels.** Every surface a person or vehicle can be on is a **deck** with a level and a height: the street (0),
  concourses and road tunnels (-1), platforms (-2), viaducts, flyovers and elevated stations (+1, +2). Decks are
  joined by **links**: stairs, lifts, escalators, ramps. Every deck can be reached from the street by links (no
  teleports), and every deck with a ceiling carries it. `layers.levels` holds them; the camera, navigation, vehicle
  calling and what is drawn read it.
- **Railways are laid out like railways**: straights and circular curves of a design-speed radius, grades a train can
  climb, viaduct piers only where they may stand, nothing above the ground under an airport's approach surface.
- **Everything v4 promised stays**: road classes and widths, junction kinds, curves by design speed, capacity and the
  traffic slider, interchanges and tunnels (with footways), trams on any road class, the City Line in its boulevard's
  median, HQ spacing and garages, the draw-call budgets.
- **Side by side.** v5 is generator version 4 (`claude-hq@4`, `user:<uuid>@4`). @3 keeps serving until @4 passes the
  validator, the client's tests and the graphics tour; then `LIVE_V` moves to 4. @1 to @3 stay pinned. The doc's layers
  keep their @3 shapes, so the client draws @4 from day one; `layers.levels` is new.
- **The validator is the spec.** Each phase adds its hard rules to `validate.rs` and they run in CI on 50 seeds.

## Phases

| # | Phase | Ships |
|---|---|---|
| 1 | `layers.levels` (decks, links, ceilings) and the client reading it: the camera, walking between levels | camera fix |
| 2 | v5 skeleton: generator version 4, terrain and water reused, the program (what a city of this tier needs) | @4 exists |
| 3 | The master plan: reservations with clearances, districts round them | |
| 4 | Corridors: railways and metro first, then expressway, ring, arterials, boulevards | |
| 5 | Grade separation: flyovers, underpasses, tunnels, interchanges, as decks and links | |
| 6 | Local streets, blocks, lots, civic sites into their reserved parcels, HQs | |
| 7 | Transit: metro stations on levels (concourse, platforms, entrances with stairs and lifts), trams, the City Line | |
| 8 | Navigation and vehicle calling on levels; levels drawn by what you can see | |
| 9 | Validator on 50 seeds, graphics tour, switch `LIVE_V` to 4 | live |

## Phase 1: levels

`layers.levels` (@3 and @4; built from what the doc already has on @3, so it ships before the rebuild):

- `decks: [{id, kind, level, poly: [[x, z]] cm, y cm (the floor), ceil cm | null, walk, drive}]`
  - kinds: `street` (the ground; implicit, not listed), `concourse`, `platform`, `passage` (metro, -1 / -2),
    `tunnel` (a road tunnel's carriageway and footways, -1), `viaduct` and `station` (the City Line, +1), `deck`
    (a flyover, +1 / +2)
- `links: [{id, kind, from, to, at: [x, z] cm (the foot), top: [x, z] cm, w cm}]`
  - kinds: `stairs`, `lift`, `ramp` (a tunnel's portal, a flyover's approach); `from` / `to` deck ids, `"street"`
    for the ground
- validator: every deck reachable from `street`; every deck with a roof has `ceil`; no two decks at one point closer
  than 2.4 m apart in height unless one is a ramp.

Client: `world.js levelsOf(W)`; the camera's ray is stopped by the ceiling of the deck you stand on and by the edge of
the decks at your level (no terrain or buildings below the street); `HQV.levels.at(x, z, y)` answers which deck you
are on for navigation and vehicle calling.
