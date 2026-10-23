-- HQ Studio (3.15): one customised building + interiors per user. style is the normalized document
-- hqstyle.rs validates against data/hqstyle.json (enum keys, #rrggbb colours, grid furniture; no free text).
CREATE TABLE IF NOT EXISTS hq_custom (user_id VARCHAR(36) NOT NULL PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, style TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')));
