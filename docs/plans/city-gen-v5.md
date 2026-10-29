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
- A **road** or **rail** line carves a swept box along its centre line: its width, its clearance height, on the level
  it runs at; a level change carves the ramp between levels.

## The order of decisions (each one only sees the volume still free)

1. **Land and water**: terrain, coast, river, lakes. The buildable area.
2. **Airport**: at the city's edge or inside it, whichever scores better (flat, a clear run over the sea or open land
   for its approaches, away from homes). **Its runway is a quarter of the city's diameter** (about 430 m on the
   Commons; it was 1.6 km, the city's whole width). Its box is locked before anything else.
3. **Port** where the water is deepest and clear of the approaches.
4. **The centre**: the plaza and Central (the metro and rail hub) near the middle, on high dry ground.
5. **Land use from travel**: offices round the hub; homes in rings within a commute of the offices and a short walk of
   a metro station; industry out by the port and the airport, **with a green gap (at least 150 m) between industry and
   any home**; shops and services where the homes and jobs meet. Each district's buildings are placed and spaced in
   the volume (cubes by size), decently apart.
6. **Metro** for the most connectivity: lines through the busiest pairs of districts, stations where they serve the
   most homes and jobs, underground by default, rising to the ground or onto a viaduct only where that is free and
   saves something.
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

- no two boxes intersect; every building reachable by road from every other; every station by road and on foot;
- industry at least 150 m from any home; every home within a walk of a station or a stop;
- no road curve under its class's design radius, no corner on a road over 35 degrees where nothing else joins;
- **no corner on a rail line, ever**; rail gradients within the line's limit;
- the airport's runway a quarter (to a fifth) of the city's diameter, its box clear of everything else above ground.

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
