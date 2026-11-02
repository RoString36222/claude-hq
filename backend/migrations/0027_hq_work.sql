-- HQ growth (HQ 3.37): each user's Claude worker-hours per UTC day, the whole-number count their own HQ app computes
-- (hqwork.rs): how many (session, hour) pairs had activity that day, at most 24 a day. A day's row only ever goes up. The
-- sum is the HQ's build points: it unlocks the township's neighbouring lots and moves them through their build stages.
CREATE TABLE IF NOT EXISTS hq_work (user_id VARCHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE, day TEXT NOT NULL, hours INTEGER NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (user_id, day));
