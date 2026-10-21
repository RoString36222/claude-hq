-- Cities (HQ 3.x, docs/plans/cities-build-spec.md): one personal city per user
-- plus the Commons (owner 'commons'), each with a treasury kept apart from the
-- owner's Poke Coins. Times are unix seconds (UTC). Additive only.
--
-- city.treasury is a cache of SUM(city_ledger.amount) for that owner: every
-- change is one ledger row written in the same transaction (cities::post).
-- accrual_carry holds the millionths of a coin of tax not yet paid out.
CREATE TABLE IF NOT EXISTS city (owner VARCHAR(36) PRIMARY KEY, seed VARCHAR(64) NOT NULL, treasury INTEGER NOT NULL DEFAULT 0 CHECK (treasury >= 0), tax_pm INTEGER NOT NULL, specialty VARCHAR(16) NOT NULL, privacy VARCHAR(8) NOT NULL DEFAULT 'arena' CHECK (privacy IN ('arena', 'friends', 'closed')), created INTEGER NOT NULL, last_accrual INTEGER NOT NULL, accrual_carry INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS city_upgrade (owner VARCHAR(36) NOT NULL, upgrade VARCHAR(16) NOT NULL, level INTEGER NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY (owner, upgrade));
CREATE TABLE IF NOT EXISTS city_ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, owner VARCHAR(36) NOT NULL, at INTEGER NOT NULL, kind VARCHAR(16) NOT NULL, amount INTEGER NOT NULL, balance_after INTEGER NOT NULL, ref VARCHAR(64) NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS ix_city_ledger_owner ON city_ledger (owner, id);
CREATE TRIGGER IF NOT EXISTS city_ledger_no_update BEFORE UPDATE ON city_ledger BEGIN SELECT RAISE(ABORT, 'city_ledger is append-only'); END;
CREATE TRIGGER IF NOT EXISTS city_ledger_no_delete BEFORE DELETE ON city_ledger BEGIN SELECT RAISE(ABORT, 'city_ledger is append-only'); END;
-- XP thresholds and the population a city has on reaching each tier. Meant to
-- be retuned against the real XP distribution (target: the median user reaches
-- Town in about a month), so the server reads them on every request.
CREATE TABLE IF NOT EXISTS city_tiers (tier INTEGER PRIMARY KEY, xp INTEGER NOT NULL, population INTEGER NOT NULL);
INSERT OR IGNORE INTO city_tiers (tier, xp, population) VALUES (1, 0, 50), (2, 2000, 200), (3, 10000, 600), (4, 40000, 1200), (5, 120000, 2000);
-- price is in thousandths of a coin; updated is the last market tick applied.
CREATE TABLE IF NOT EXISTS market_price (owner VARCHAR(36) NOT NULL, good VARCHAR(16) NOT NULL, price INTEGER NOT NULL, stock INTEGER NOT NULL CHECK (stock >= 0), updated INTEGER NOT NULL, PRIMARY KEY (owner, good));
