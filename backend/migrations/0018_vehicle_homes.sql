-- Vehicle homes (HQ 3.4, Basement Garage): which garage each owned vehicle lives in.
-- Additive only (sqlx checksums every applied file: never edit this once pushed).
-- Depends on owned_vehicles (0017_vehicles.sql, first numbered 0016 on feat/vehicles).
-- home: 'basement' (the owner's private B1 garage under their HQ, in bay 0..11) or
-- 'carpark' (the city's common multi-storey). A vehicle with no row lives in the carpark.
-- One vehicle per basement bay per owner (ux_vehicle_homes_bay); carpark rows have bay NULL.
CREATE TABLE IF NOT EXISTS vehicle_homes (
  vehicle_id VARCHAR(36) NOT NULL PRIMARY KEY REFERENCES owned_vehicles(id) ON DELETE CASCADE,
  user_id VARCHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  home VARCHAR(8) NOT NULL CHECK (home IN ('basement', 'carpark')),
  bay INTEGER CHECK (bay IS NULL OR (bay >= 0 AND bay < 12)),
  moved_at INTEGER NOT NULL,
  CHECK ((home = 'basement') = (bay IS NOT NULL)));
CREATE UNIQUE INDEX IF NOT EXISTS ux_vehicle_homes_bay ON vehicle_homes (user_id, bay) WHERE home = 'basement';
CREATE INDEX IF NOT EXISTS ix_vehicle_homes_user ON vehicle_homes (user_id);
