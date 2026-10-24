-- HQ 3.15 transport revamp: the live worlds move to generator version 3 (backend/src/archipelago.rs LIVE_V).
-- Additive only (sqlx checksums every applied file: never edit this once pushed). Idempotent: every statement
-- touches only rows still at @2, so running it again changes nothing.
-- The Commons claude-hq@2 becomes claude-hq@3 and every island user:<uuid>@2 becomes user:<uuid>@3. Arena City
-- (claude-hq@1) is a different world and is left alone. Specialties stay as stored.

-- city.seed: the world a city is drawn in.
UPDATE city SET seed = substr(seed, 1, length(seed) - 2) || '@3' WHERE seed LIKE '%@2';

-- rail_line: both ends to @3, keeping a < b (CHECK (a < b)): insert each rewritten line as its ordered pair,
-- then drop the @2 rows. OR IGNORE: a line already present at @3 keeps its row.
INSERT OR IGNORE INTO rail_line (a, b, built_by, built_at, cost)
  SELECT CASE WHEN na < nb THEN na ELSE nb END, CASE WHEN na < nb THEN nb ELSE na END, built_by, built_at, cost
  FROM (SELECT CASE WHEN a LIKE '%@2' THEN substr(a, 1, length(a) - 2) || '@3' ELSE a END AS na,
               CASE WHEN b LIKE '%@2' THEN substr(b, 1, length(b) - 2) || '@3' ELSE b END AS nb,
               built_by, built_at, cost
          FROM rail_line WHERE a LIKE '%@2' OR b LIKE '%@2')
  WHERE na <> nb;
DELETE FROM rail_line WHERE a LIKE '%@2' OR b LIKE '%@2';

-- owned_vehicles: a vehicle left out in a world that moved goes home (its basement or carpark bay). The world is
-- rewritten and the position cleared; a vehicle with no position is at home (backend/src/vehicles.rs row_json).
UPDATE owned_vehicles
   SET parked_world = substr(parked_world, 1, length(parked_world) - 2) || '@3',
       parked_x = NULL, parked_z = NULL, parked_yaw = NULL
 WHERE parked_world LIKE '%@2';
