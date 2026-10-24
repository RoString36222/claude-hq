-- The phone's Messages (HQ 3.15, backend/src/sms.rs): text messages between any two players, online or offline.
-- Additive only (sqlx checksums every applied file: never edit this once pushed). Times are epoch ms (UTC).
-- sms_optin: a row means that user turned on SENDING (Settings); receiving needs no row.
CREATE TABLE IF NOT EXISTS sms_optin (
  user_id VARCHAR(36) NOT NULL PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  on_at INTEGER NOT NULL);
-- sms_message: one row per send, kept at most 7 days (pruned on every send and inbox read). text is what the
-- sender typed (1..160 printable characters); it is blanked when the recipient acknowledges it (delivered_at set)
-- so a delivered message's words no longer sit on the server; the row stays for the sender's ticks and the rate
-- limits until the prune. dropped = 1: sent to someone who blocked the sender, never delivered (text blank).
CREATE TABLE IF NOT EXISTS sms_message (
  id VARCHAR(36) NOT NULL PRIMARY KEY,
  sender VARCHAR(36) NOT NULL,
  recipient VARCHAR(36) NOT NULL,
  text VARCHAR(160) NOT NULL,
  at INTEGER NOT NULL,
  delivered_at INTEGER,
  dropped INTEGER NOT NULL DEFAULT 0 CHECK (dropped IN (0, 1)));
CREATE INDEX IF NOT EXISTS ix_sms_message_recipient ON sms_message (recipient, at);
CREATE INDEX IF NOT EXISTS ix_sms_message_sender ON sms_message (sender, at);
-- sms_block: user_id blocks blocked (both directions of silence are the server's: the blocked sender is never told).
CREATE TABLE IF NOT EXISTS sms_block (
  user_id VARCHAR(36) NOT NULL,
  blocked VARCHAR(36) NOT NULL,
  at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, blocked));
CREATE INDEX IF NOT EXISTS ix_sms_block_blocked ON sms_block (blocked);
-- sms_report: someone reported a sender (and optionally one message id) for the operator to look at.
CREATE TABLE IF NOT EXISTS sms_report (
  id VARCHAR(36) NOT NULL PRIMARY KEY,
  reporter VARCHAR(36) NOT NULL,
  sender VARCHAR(36) NOT NULL,
  msg_id VARCHAR(64) NOT NULL DEFAULT '',
  at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS ix_sms_report_sender ON sms_report (sender, at);
