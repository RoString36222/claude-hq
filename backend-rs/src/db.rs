//! Database access, and schema ownership.
//!
//! Until now Alembic owned the schema and this only read and wrote rows. For
//! Python to be deleted, that has to move: `migrations/` here is the owner now,
//! applied by sqlx at boot.
//!
//! The handover is designed to be reversible. `0001_baseline.sql` is the schema
//! as Alembic built it at revision `3d4e5f6a7b8c`, written entirely with
//! IF NOT EXISTS, so running this against the live production file changes
//! nothing -- it simply records that the baseline is present. Only migrations
//! numbered above it are new ground.

use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::SqlitePool;
use std::str::FromStr;

/// SQLAlchemy writes `sqlite+aiosqlite:////abs/path`; sqlx wants
/// `sqlite:/abs/path`. Accepting both means one env var drives both backends.
pub fn normalise_url(raw: &str) -> String {
    let s = raw
        .trim()
        .replace("sqlite+aiosqlite://", "sqlite://")
        .replace("sqlite+pysqlite://", "sqlite://");
    // sqlite://// -> four slashes means absolute in SQLAlchemy
    if let Some(rest) = s.strip_prefix("sqlite:////") {
        return format!("sqlite:/{rest}");
    }
    if let Some(rest) = s.strip_prefix("sqlite:///") {
        return format!("sqlite:{rest}");
    }
    s
}

/// The Alembic revision `0001_baseline.sql` was generated from. A database
/// stamped *past* this knows tables we have never seen, which is the failure
/// that took the Arena down twice when a rollback left code behind its schema.
pub const BASELINE_ALEMBIC_REV: &str = "3d4e5f6a7b8c";

/// Refuse to serve a database migrated beyond what this binary understands.
///
/// Only meaningful while both backends exist: once Python is gone the table
/// stops being written and this becomes a no-op. Absent table => a database
/// Rust created itself, which is fine.
pub async fn check_alembic_compat(pool: &SqlitePool) -> Result<(), String> {
    let exists: Option<(String,)> = sqlx::query_as(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='alembic_version'",
    )
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;
    if exists.is_none() {
        return Ok(());
    }
    let rev: Option<(String,)> = sqlx::query_as("SELECT version_num FROM alembic_version")
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?;
    match rev {
        Some(r) if r.0 == BASELINE_ALEMBIC_REV => Ok(()),
        Some(r) => Err(format!(
            "database is at Alembic revision {} but this binary was built against {}. \
             Roll the database back, or rebuild after porting that migration.",
            r.0, BASELINE_ALEMBIC_REV
        )),
        None => Ok(()),
    }
}

/// Apply every migration in `migrations/`, then verify Alembic compatibility.
pub async fn migrate(pool: &SqlitePool) -> Result<(), String> {
    // A rollback leaves the database with migrations this (older) binary has never
    // seen. They only ever add tables and columns, so carry on rather than refuse
    // to boot: without this, rolling back past any new migration takes the Arena down.
    let mut m = sqlx::migrate!("./migrations");
    m.set_ignore_missing(true);
    m.run(pool)
        .await
        .map_err(|e| format!("migration failed: {e}"))?;
    check_alembic_compat(pool).await
}

pub async fn connect(url: &str) -> Result<SqlitePool, sqlx::Error> {
    let opts = SqliteConnectOptions::from_str(&normalise_url(url))?
        // Same pragmas as app/db.py: WAL so readers do not block a publish,
        // and a busy timeout so concurrent writes wait instead of erroring.
        .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
        .busy_timeout(std::time::Duration::from_secs(5))
        .foreign_keys(true)
        .create_if_missing(true);
    SqlitePoolOptions::new().max_connections(5).connect_with(opts).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_the_sqlalchemy_url_forms() {
        assert_eq!(normalise_url("sqlite+aiosqlite:////data/arena.db"), "sqlite:/data/arena.db");
        assert_eq!(normalise_url("sqlite+aiosqlite:///./arena.db"), "sqlite:./arena.db");
        assert_eq!(normalise_url("sqlite:/data/arena.db"), "sqlite:/data/arena.db");
    }
}
