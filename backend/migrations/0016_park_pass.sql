-- Cities (HQ 3.2): a day pass to a city's amusement park, sold as the "park" fare (cities.rs `fare`).
-- Additive only (sqlx checksums every applied file: never edit this once pushed).
-- park_pass: one row per rider, city and UTC day (unix seconds / 86400). The row is written in the same
-- transaction as the fare's debit and its city_ledger entry, so a pass always means the coins were paid,
-- and a second purchase the same day finds the row and charges nothing.
CREATE TABLE IF NOT EXISTS park_pass (user_id VARCHAR(36) NOT NULL, owner VARCHAR(36) NOT NULL, day INTEGER NOT NULL, paid INTEGER NOT NULL, PRIMARY KEY (user_id, owner, day));
