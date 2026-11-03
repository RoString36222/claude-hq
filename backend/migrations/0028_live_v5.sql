-- HQ 3.40 production moves to City Gen v5: the @3 ids are drawn by the v5 generator (ARENA_WORLDGEN in
-- backend/docker-compose.yml). The ids stay, so nothing is renamed, but the streets and lots under them all move.
-- Additive only (sqlx checksums every applied file: never edit this once pushed). Idempotent.

-- A vehicle left out in a live world goes home (a vehicle with no position is at home: backend/src/vehicles.rs
-- row_json). Its old spot could now be inside a building or under the sea.
UPDATE owned_vehicles
   SET parked_x = NULL, parked_z = NULL, parked_yaw = NULL
 WHERE parked_world LIKE '%@3';

-- A moved garage is a position inside the old lot: back to the default spot (the owner can move it again).
DELETE FROM hq_garage;
