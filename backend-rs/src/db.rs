//! Database access. Shares the schema (and the file) with the Python backend,
//! so Alembic remains the single owner of migrations -- this never creates or
//! alters tables, it only reads and writes rows.

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

pub async fn connect(url: &str) -> Result<SqlitePool, sqlx::Error> {
    let opts = SqliteConnectOptions::from_str(&normalise_url(url))?
        // Same pragmas as app/db.py: WAL so readers do not block a publish,
        // and a busy timeout so concurrent writes wait instead of erroring.
        .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
        .busy_timeout(std::time::Duration::from_secs(5))
        .foreign_keys(true)
        .create_if_missing(false);
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
