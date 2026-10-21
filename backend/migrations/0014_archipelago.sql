-- Cities (HQ 3.x): where everyone's island sits on the sea, and which Commons lot
-- holds each HQ tower. Both are handed out first come, first served and never move.
-- Additive only (sqlx checksums every applied file: never edit this once pushed).
-- island_slot: slot is the place on the golden-angle spiral; x, z are its centre in cm.
CREATE TABLE IF NOT EXISTS island_slot (owner VARCHAR(36) PRIMARY KEY, slot INTEGER NOT NULL UNIQUE, x INTEGER NOT NULL, z INTEGER NOT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP);
-- commons_lot: an HQ tower's lot in the Commons (claude-hq@2), a rank 0..63 into its lot order.
CREATE TABLE IF NOT EXISTS commons_lot (user_id VARCHAR(36) PRIMARY KEY, lot_rank INTEGER NOT NULL UNIQUE, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP);
