-- The Casino (HQ 3.7): chips are a poke_balances item ("chips"), bought and cashed at the cage for Poke Coins.
-- casino_play: every settled play (one-shot games and finished blackjack hands), for the player's own stats, the
-- losing streak the page jokes about, and the rate limit. result is the game's small JSON outcome (reels, pocket,
-- finishing order...): numbers and fixed names only.
CREATE TABLE IF NOT EXISTS casino_play (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id VARCHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE, at INTEGER NOT NULL, game VARCHAR(16) NOT NULL, bet INTEGER NOT NULL CHECK (bet > 0), payout INTEGER NOT NULL CHECK (payout >= 0), result TEXT NOT NULL DEFAULT '{}');
CREATE INDEX IF NOT EXISTS ix_casino_play_user_at ON casino_play (user_id, at);
-- casino_hand: a blackjack hand in progress (one per player): the stake is already taken; cards are 0..51.
CREATE TABLE IF NOT EXISTS casino_hand (user_id VARCHAR(36) NOT NULL PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, bet INTEGER NOT NULL CHECK (bet > 0), doubled INTEGER NOT NULL DEFAULT 0, player TEXT NOT NULL, dealer TEXT NOT NULL, at INTEGER NOT NULL);
-- casino_duel: a player-vs-player bet. The challenger's stake is held from `open`; a taker's when they join, and the
-- Arena settles it there and then (the winner takes the pot less DUEL_RAKE_PM). move: rock-paper-scissors' hidden
-- moves, never shown before it is settled. state: open | settled | cancelled | expired.
CREATE TABLE IF NOT EXISTS casino_duel (id VARCHAR(36) NOT NULL PRIMARY KEY, owner VARCHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE, game VARCHAR(16) NOT NULL, bet INTEGER NOT NULL CHECK (bet > 0), owner_move VARCHAR(16), taker VARCHAR(36), taker_move VARCHAR(16), state VARCHAR(12) NOT NULL DEFAULT 'open', winner VARCHAR(36), result TEXT NOT NULL DEFAULT '{}', created INTEGER NOT NULL, settled INTEGER);
CREATE INDEX IF NOT EXISTS ix_casino_duel_state ON casino_duel (state, created);
CREATE INDEX IF NOT EXISTS ix_casino_duel_owner ON casino_duel (owner, created);
CREATE INDEX IF NOT EXISTS ix_casino_duel_taker ON casino_duel (taker, created);
