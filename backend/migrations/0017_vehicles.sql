-- Vehicles (HQ 3.2, docs/plans/dealership-spec.md): the cars and bikes players buy at the dealership.
-- Additive only (sqlx checksums every applied file: never edit this once pushed).
-- owned_vehicles: one row per vehicle a player owns. vehicle_id is a catalogue id (backend/data/vehicles.json),
-- paint an index into that vehicle's paints, price the coins paid (the purchase record: poke_ledger's op CHECK
-- has no vehicle op). parked_*: where its owner left it (NULL: in the garage).
CREATE TABLE IF NOT EXISTS owned_vehicles (id VARCHAR(36) NOT NULL PRIMARY KEY, user_id VARCHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE, vehicle_id VARCHAR(48) NOT NULL, paint INTEGER NOT NULL DEFAULT 0 CHECK (paint >= 0), price INTEGER NOT NULL CHECK (price >= 0), bought_at INTEGER NOT NULL, parked_world VARCHAR(64), parked_x REAL, parked_z REAL, parked_yaw REAL);
CREATE INDEX IF NOT EXISTS ix_owned_vehicles_user ON owned_vehicles (user_id, bought_at);
