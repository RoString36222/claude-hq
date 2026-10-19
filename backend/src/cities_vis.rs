//! Stand-in for the parts of `cities.rs` (srv-economy, built in parallel) that
//! the archipelago reads: who may see a personal city, and its name and tier.
//!
//! Until the two branches meet this applies the default privacy, "arena": the
//! owner always sees their own city, and so does every other active member of
//! this Arena. The integrator points the callers at `crate::cities` and deletes
//! this file; the signatures here are the ones the archipelago codes against.

use sqlx::SqlitePool;

/// Whether `viewer` may see `owner`'s city. Both are user ids.
pub async fn can_view(pool: &SqlitePool, owner: &str, viewer: &str) -> Result<bool, sqlx::Error> {
    if owner == viewer {
        return Ok(true);
    }
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users WHERE id IN (?1, ?2) AND is_active = 1")
        .bind(owner)
        .bind(viewer)
        .fetch_one(pool)
        .await?;
    Ok(n == 2)
}

/// A city's display name and its tier (1..5). Until the city table exists every
/// city is a tier-1 hamlet named after its owner.
pub async fn name_and_tier(pool: &SqlitePool, owner: &str) -> Result<(String, u8), sqlx::Error> {
    let row: Option<(String, String, String)> =
        sqlx::query_as("SELECT handle, display_name, trainer_name FROM users WHERE id = ?1")
            .bind(owner)
            .fetch_optional(pool)
            .await?;
    let who = row
        .map(|(h, d, t)| [t, d, h].into_iter().find(|s| !s.trim().is_empty()).unwrap_or_default())
        .unwrap_or_default();
    Ok((format!("{}'s city", who.trim()), 1))
}
