-- City Gen v4 phase 10 (HQ 3.33): where a user's car-lift garage bay sits inside their own HQ lot. Four small integers
-- (hqgarage.rs): lot is the Commons lot rank, x / z decimetres in the lot's own frame (|x| <= 400, |z| <= 300), r quarter
-- turns 0..3. No row is the default spot. The client decides whether a spot fits the lot; this only stores it.
CREATE TABLE IF NOT EXISTS hq_garage (user_id VARCHAR(36) NOT NULL PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, lot INTEGER NOT NULL, x INTEGER NOT NULL, z INTEGER NOT NULL, r INTEGER NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')));
