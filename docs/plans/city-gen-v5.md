# City Gen v5: the city planned in a volume

The owner's brief (29 Oct 2026), in order of what the generator decides. v5 is a new pipeline
(`backend/src/worldgen/v5/`), generator version 4 (`claude-hq@4`, `user:<uuid>@4`), built alongside the live @3 until
it passes the validator, the client's tests and the graphics tour; then `LIVE_V` moves to 4. It reuses only the
low-level pieces: terrain, coast, river and water, the road classes, and the block/lot geometry helpers.

## The volume

The island is one 3D space. Every thing the generator places **carves a box** out of it (a footprint polygon and a
height range); **no two boxes intersect**, ever. `v5/space.rs` holds them and answers "is this box free?".

| Level | Height (m, over the ground) | What lives there |
|---|---|---|
| Deep | -30 to -14 | metro platforms and running tunnels, rail tunnels |
| Shallow | -14 to -2 | concourses, passages, road tunnels and underpasses |
| Ground | -2 to 7 | streets, plazas, building feet, parks, at-grade rail |
| Above | 7 to 60 | viaducts, flyovers, elevated stations, buildings' upper floors |
| Sky | 60 and up | towers' tops, the airport's approach surfaces |

- A **building** is its box: its footprint by its height (and a basement's depth when it has one).
- The **airport** takes its whole footprint from the ground up into the sky (runway, apron, terminal, approach
  surfaces as sloped boxes); the ground under it stays free for tunnels.
- **Water** (the river, lakes, canals, the marina) takes its own level, carved first: from 3 m under its bed up to 6 m
  over its surface, the boats' level. Nothing else is laid through it: a tunnel passes under the bed, a bridge's deck
  over the boats.
- The boxes are the generator's alone (its "is this free?"), never drawn: the airport's locked footprint is
  `runway.area` on the airport site, read by the claims; the site itself is the terminal, as before.
- A **road** or **rail** line carves a swept box along its centre line: its width, its clearance height, on the level
  it runs at; a level change carves the ramp between levels.

## The order of decisions (each one only sees the volume still free)

1. **Land and water**: terrain, coast, river, lakes. The buildable area. The Commons is a **3.5 km island**: its
   coast an exact circle 1,750 m out (`V5_COMMONS_COAST_CM` in `worldgen/mod.rs` is its reach, 1,775 m, as for every
   coast), the city to 1,625 m (`V5_SHORE_CM` inside the reach: the shore road, the beach, the piers between it and
   the coast), in a 3,840 m square (`V5_COMMONS_SIZE_CM`) with the sea about 170 m wide round it; the terrain keeps
   its 8 m grid (481 x 481). A personal island keeps its size. The nearest archipelago slot (`archipelago.rs`, 3.1 km
   out) still clears it: its island's coast is over 300 m off the Commons'.
2. **Airport**: at the city's edge or inside it, whichever scores better (flat, a clear run over the sea or open land
   for its approaches, away from homes). **Its runway is as long as the fastest HQ vehicle needs to run from a
   standstill to its top speed with nitro and brake to a stop** (the Koenigsegg Jesko Absolut, 2,842 m with the game's
   physics: a 2.9 km runway, `RUNWAY_CM` in `v5/airport.rs`; `tests/test_runway_length.py` runs every catalogue
   vehicle against it; the runway is that distance rounded up to the next 100 m). The apron side (apron, terminal,
   landside) always stands on the island, and the footprint keeps a quarter of the city's radius from its middle.
   **The strip goes on land if a site scores**: wholly inside the coast, its rise at most 15 m (the footprint is then
   graded to the apron's level), and cutting off at most 5 % of the island from the city's middle (no road passes
   under a runway, nor under an approach's first 400 m, so a strip across the island strands the land past it).
   Else the pier rule: the strip may run out over the sea on a pier deck (piles, a deck edge, a sea wall where it
   meets the land). Either way never across a river, lake, canal or the marina, and neither approach passes over the
   city's middle. On the 3.5 km Commons a 2.9 km strip fits inside the coast only as a chord within about 0.88 km of
   the middle, which strands about a fifth of the island past it, so the Commons' runway is on the pier rule until
   roads can pass under the airport. Its box is locked before anything else.
3. **Port** where the water is deepest and clear of the approaches.
4. **The centre**: the plaza and Central (the metro and rail hub) near the middle, on high dry ground.
5. **Land use from travel**: offices round the hub; homes in rings within a commute of the offices and a short walk of
   a metro station; industry out by the port and the airport, **with a green gap (at least 150 m) between industry and
   any home**; shops and services where the homes and jobs meet. Each district's buildings are placed and spaced in
   the volume (cubes by size), decently apart.
6. **Metro** for the most connectivity: lines through the busiest pairs of districts, stations where they serve the
   most homes and jobs, underground by default, rising to the ground or onto a viaduct only where that is free and
   saves something. At most three lines meet under Central (`HUB_LINES` in `v5/metro.rs`: crossing lines are 7.5 m
   apart, so a fourth would put its platform more than `DROP_CM`, 23 m, of stairs under the hall); a destination
   left over gets a branch, a line to the nearest station of a line already laid, a level under it there.
7. **Roads**: a network that connects every building end to end and every landmark; arterials between district
   centres and landmarks, collectors through districts, local access to every door. **Curves, not corners**: radii by
   design speed, a sharp turn only where nothing else fits. A road changes level (tunnel, underpass, flyover) only
   where that cuts travel time or there is no other way, with a real ramp.
8. **Rail**: **no corners at all, only curves** (straights, circular arcs, transitions). A line plans its gradient
   ahead: where the airport (or anything) is in the way and no bridge can pass, it starts its descent early enough to
   pass under at its grade, or goes round. It checks the volume along its whole length.
9. **Levels**: every station, concourse, platform, stair, lift and viaduct as real geometry (decks and links), so
   moving between levels is continuous; the camera follows it (after the generator is good).
10. **Growth**: when a new island joins, the road and rail networks plan how to reach it (the Island Link and the
    roads to its ferry and bridge points) from what is already built.

## Rules the validator holds (hard, on 50 seeds)

- no two boxes intersect (the water's level among them); every building reachable by road from every other; every station by road and on foot;
- industry at least 150 m from any home; every home within a walk of a station or a stop;
- no road curve under its class's design radius, no corner on a road over 35 degrees where nothing else joins;
- **no corner on a rail line, ever**; rail gradients within the line's limit;
- the airport's runway long enough for every HQ vehicle to reach its top speed (nitro) and stop on it, its apron
  side on the island, its approaches clear of the city's middle, its box clear of everything else above ground.

## Phases

| # | Phase |
|---|---|
| 1 | `v5/space.rs`, the volume; the Commons' land and water; the airport placed and locked |
| 2 | Land use from travel: districts, buildings as boxes, spacing, the industry gap |
| 3 | Metro and rail alignments: curves only, planned gradients, in the volume |
| 4 | Roads: connectivity, curves, level changes; blocks and lots from them |
| 5 | Output as the doc's layers (the client draws @4); the airport at its new scale in the client |
| 6 | Levels as geometry; the camera and moving between levels |
| 7 | Islands joining: the networks grow to them |
| 8 | Validator on 50 seeds, graphics tour, `LIVE_V` to 4 |
