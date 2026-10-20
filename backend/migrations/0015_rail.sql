-- Cities (HQ 3.x): the rail lines players build between the islands' stations and the Commons.
-- Additive only (sqlx checksums every applied file: never edit this once pushed).
-- rail_line: one row per built line; a and b are world ids ("claude-hq@2" or "user:<uuid>@2"), a < b, so a
-- line is the same row whichever end built it. built_by paid cost coins from their island's treasury.
CREATE TABLE IF NOT EXISTS rail_line (a VARCHAR(64) NOT NULL, b VARCHAR(64) NOT NULL, built_by VARCHAR(36) NOT NULL, built_at INTEGER NOT NULL, cost INTEGER NOT NULL, PRIMARY KEY (a, b), CHECK (a < b));
