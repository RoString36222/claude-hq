-- Vehicle tuning (HQ 3.13, the Tuning shop): how each owned vehicle is tuned.
-- Additive only (sqlx checksums every applied file: never edit this once pushed).
-- Depends on owned_vehicles (0017_vehicles.sql).
-- tuning: the canonical JSON backend/src/tuning.rs wrote after validating it (finish, colours as #rrggbb,
-- two-tone, rim design / colour / size step, tint level, wing, exhaust, plate text); never the client's bytes.
-- A vehicle with no row is stock. One row per vehicle; it goes with the vehicle (ON DELETE CASCADE).
CREATE TABLE IF NOT EXISTS vehicle_tuning (
  vehicle_id VARCHAR(36) NOT NULL PRIMARY KEY REFERENCES owned_vehicles(id) ON DELETE CASCADE,
  user_id VARCHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tuning TEXT NOT NULL CHECK (length(tuning) <= 512),
  updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS ix_vehicle_tuning_user ON vehicle_tuning (user_id);
