-- Pets (HQ 3.14, backend/src/pets.rs): the dogs, cats, dragons, dinosaurs and sea serpents players adopt
-- at the City's Pet shop. Additive only (sqlx checksums every applied file: never edit this once pushed).
-- owned_pets: one row per pet. species is an id from pets::SPECIES (checked by the server, not here, so the
-- roster can grow without a migration); variant a colour/pattern index; name what the owner typed (1..12
-- characters, checked and filtered by the server); acc the accessory bits (collar 1, bandana 2, hat 4,
-- saddle 8, bow 16); affection 0..1000 (petting, fetch and tricks; care_day / care_n cap it per UTC day);
-- active: out with its owner (at most 2); home: lives in its owner's HQ lobby while not out; price the
-- Poke Coins paid (0 for a free or level-unlocked adoption).
CREATE TABLE IF NOT EXISTS owned_pets (
  id VARCHAR(36) NOT NULL PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  species VARCHAR(24) NOT NULL,
  variant INTEGER NOT NULL DEFAULT 0 CHECK (variant >= 0 AND variant < 16),
  name VARCHAR(12) NOT NULL,
  acc INTEGER NOT NULL DEFAULT 0 CHECK (acc >= 0 AND acc < 256),
  affection INTEGER NOT NULL DEFAULT 0 CHECK (affection >= 0 AND affection <= 1000),
  active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1)),
  home INTEGER NOT NULL DEFAULT 1 CHECK (home IN (0, 1)),
  care_day INTEGER NOT NULL DEFAULT 0,
  care_n INTEGER NOT NULL DEFAULT 0 CHECK (care_n >= 0),
  price INTEGER NOT NULL DEFAULT 0 CHECK (price >= 0),
  adopted_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS ix_owned_pets_user ON owned_pets (user_id, adopted_at);
