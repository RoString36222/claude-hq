-- One of each vehicle per player: the dealership no longer sells a second copy (backend/src/vehicles.rs buy_in).
-- Additive only (sqlx checksums every applied file: never edit this once pushed).
-- Depends on owned_vehicles (0017), vehicle_homes (0018), vehicle_tuning (0020).
-- Each player's duplicate copies of a model go; the one kept is the one with a tune, else the one in a basement bay,
-- else the first bought. Their home and tuning rows go with them (deleted first: no reliance on foreign-key cascades).
CREATE TEMP TABLE dup_vehicles AS
  SELECT id FROM (
    SELECT o.id, ROW_NUMBER() OVER (
      PARTITION BY o.user_id, o.vehicle_id
      ORDER BY (t.vehicle_id IS NOT NULL) DESC, (h.home = 'basement') DESC, o.bought_at ASC, o.id ASC) AS rn
    FROM owned_vehicles o
    LEFT JOIN vehicle_tuning t ON t.vehicle_id = o.id
    LEFT JOIN vehicle_homes h ON h.vehicle_id = o.id)
  WHERE rn > 1;
DELETE FROM vehicle_tuning WHERE vehicle_id IN (SELECT id FROM dup_vehicles);
DELETE FROM vehicle_homes WHERE vehicle_id IN (SELECT id FROM dup_vehicles);
DELETE FROM owned_vehicles WHERE id IN (SELECT id FROM dup_vehicles);
DROP TABLE dup_vehicles;
CREATE UNIQUE INDEX IF NOT EXISTS ux_owned_vehicles_model ON owned_vehicles (user_id, vehicle_id);
