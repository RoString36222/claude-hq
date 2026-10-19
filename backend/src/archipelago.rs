//! Cities (HQ 3.x): the sea everyone's island sits on, and the Commons' HQ lots.
//!
//!   GET /v1/archipelago                -> {commons:{world,x,z}, islands:[{owner,name,world,x,z,tier}]}
//!   GET /v1/world/claude-hq@2/assign   -> [{user, lot_rank}]
//!
//! The Commons (claude-hq@2) is at the origin. Every active member's island gets
//! a slot on a golden-angle spiral around it, handed out in join order the first
//! time anyone asks; a slot never moves, so neither does anyone's island. The
//! archipelago only lists the islands the caller may see (cities::can_view).
//!
//! Every open HQ also has a tower in the Commons. Which lot is decided here, not
//! by the client, so it holds still as people come and go: the first time an HQ
//! appears it takes the lowest free rank of the 64, and keeps it. Only when all
//! 64 are held is a rank taken back, and then only from someone who is no longer
//! on the list, so no one on it ever moves. Positions are cm, as in the WorldDoc.

use std::collections::{BTreeMap, HashSet};

use axum::{
    extract::{Request, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde_json::json;
use sqlx::SqlitePool;

use crate::cities_vis as cities;

/// The Commons' world id; it sits at the origin.
pub const COMMONS: &str = "claude-hq@2";
/// The spiral's scale: slot n is SPIRAL_CM * sqrt(n + 3) from the Commons. With
/// the +3 the first island clears the Commons by 3.1 km and neighbours sit about
/// 3 km apart (never under 2.9 km).
const SPIRAL_CM: f64 = 180_000.0;
/// pi * (3 - sqrt 5): consecutive slots turn by this much, so none line up.
const GOLDEN_ANGLE: f64 = 2.399_963_229_728_653;
/// The Commons' HQ lots (the generator ranks this many by distance to its core).
pub const LOTS: i64 = 64;
/// Retries when another request took the slot or rank this one picked.
const TRIES: usize = 8;

pub fn routes() -> Router<crate::AppState> {
    Router::new()
        .route("/v1/archipelago", get(get_archipelago))
        .route("/v1/world/claude-hq@2/assign", get(get_assign))
}

fn err(code: StatusCode, msg: &str) -> Response {
    (code, Json(json!({ "detail": msg }))).into_response()
}

fn db500(r: Result<Response, sqlx::Error>) -> Response {
    r.unwrap_or_else(|e| err(StatusCode::INTERNAL_SERVER_ERROR, &format!("db error: {e}")))
}

fn caller(req: &Request) -> crate::Caller {
    req.extensions().get::<crate::Caller>().expect("caller set by middleware").clone()
}

async fn get_archipelago(State(st): State<crate::AppState>, req: Request) -> Response {
    db500(archipelago(&st.pool, &caller(&req).user_id).await.map(|v| Json(v).into_response()))
}

async fn get_assign(State(st): State<crate::AppState>) -> Response {
    db500(assign(&st.pool).await.map(|v| Json(v).into_response()))
}

// --- islands --------------------------------------------------------------

/// Slot `n`'s island centre, cm. Floats are fine here: the result is stored
/// with the slot and read back, never recomputed by a client.
pub fn slot_pos(n: i64) -> (i64, i64) {
    let k = n as f64;
    let r = SPIRAL_CM * (k + 3.0).sqrt();
    let a = (k + 1.0) * GOLDEN_ANGLE;
    ((r * a.cos()).round() as i64, (r * a.sin()).round() as i64)
}

/// The island world of `owner`.
pub fn island_world(owner: &str) -> String {
    format!("user:{owner}@2")
}

/// Give every active member without a slot the next one, oldest account first.
async fn ensure_slots(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    let new: Vec<(String,)> = sqlx::query_as(
        "SELECT u.id FROM users u WHERE u.is_active = 1
         AND NOT EXISTS (SELECT 1 FROM island_slot s WHERE s.owner = u.id)
         ORDER BY u.created_at, u.id",
    )
    .fetch_all(pool)
    .await?;
    for (owner,) in new {
        for _ in 0..TRIES {
            let next: i64 = sqlx::query_scalar("SELECT COALESCE(MAX(slot) + 1, 0) FROM island_slot")
                .fetch_one(pool)
                .await?;
            let (x, z) = slot_pos(next);
            // OR IGNORE: a concurrent request that took this slot (UNIQUE) or
            // already slotted this owner (PRIMARY KEY) leaves the row alone.
            sqlx::query("INSERT OR IGNORE INTO island_slot (owner, slot, x, z) VALUES (?1, ?2, ?3, ?4)")
                .bind(&owner)
                .bind(next)
                .bind(x)
                .bind(z)
                .execute(pool)
                .await?;
            let has: Option<i64> = sqlx::query_scalar("SELECT slot FROM island_slot WHERE owner = ?1")
                .bind(&owner)
                .fetch_optional(pool)
                .await?;
            if has.is_some() {
                break;
            }
        }
    }
    Ok(())
}

/// The rows `viewer` may see, in slot order. `seen[i]` says whether row i is visible.
fn visible<T>(rows: Vec<T>, seen: &[bool]) -> Vec<T> {
    rows.into_iter().zip(seen).filter(|(_, &ok)| ok).map(|(r, _)| r).collect()
}

async fn archipelago(pool: &SqlitePool, viewer: &str) -> Result<serde_json::Value, sqlx::Error> {
    ensure_slots(pool).await?;
    // Inactive accounts keep their slot (it never moves) but are not shown.
    let rows: Vec<(String, i64, i64)> = sqlx::query_as(
        "SELECT s.owner, s.x, s.z FROM island_slot s JOIN users u ON u.id = s.owner
         WHERE u.is_active = 1 ORDER BY s.slot",
    )
    .fetch_all(pool)
    .await?;
    let mut seen = Vec::with_capacity(rows.len());
    for (owner, _, _) in &rows {
        seen.push(cities::can_view(pool, owner, viewer).await?);
    }
    let mut islands = Vec::new();
    for (owner, x, z) in visible(rows, &seen) {
        let (name, tier) = cities::name_and_tier(pool, &owner).await?;
        islands.push(json!({"owner": owner, "name": name, "world": island_world(&owner), "x": x, "z": z, "tier": tier}));
    }
    Ok(json!({"commons": {"world": COMMONS, "x": 0, "z": 0}, "islands": islands}))
}

// --- Commons HQ lots ------------------------------------------------------

/// The rank a newcomer takes, given who holds which rank and who is on the list
/// now: the lowest free rank, or when all are held the lowest rank held by
/// someone no longer on the list (returned as the second value, to evict).
/// None when every rank belongs to someone on the list.
fn pick_rank(held: &BTreeMap<i64, String>, members: &HashSet<&str>) -> Option<(i64, Option<String>)> {
    if let Some(r) = (0..LOTS).find(|r| !held.contains_key(r)) {
        return Some((r, None));
    }
    held.iter().find(|(_, u)| !members.contains(u.as_str())).map(|(r, u)| (*r, Some(u.clone())))
}

/// The HQs on the Commons' list: the open HQs of active users (the same rows as
/// GET /v1/hq/open, the dashboard's city list), oldest account first.
async fn members(pool: &SqlitePool) -> Result<Vec<String>, sqlx::Error> {
    let rows: Vec<(String,)> = sqlx::query_as(
        "SELECT u.id FROM users u JOIN hq_profiles p ON p.user_id = u.id
         WHERE p.open = 1 AND u.is_active = 1 ORDER BY u.created_at, u.id",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(|(id,)| id).collect())
}

async fn held(pool: &SqlitePool) -> Result<BTreeMap<i64, String>, sqlx::Error> {
    let rows: Vec<(i64, String)> = sqlx::query_as("SELECT lot_rank, user_id FROM commons_lot").fetch_all(pool).await?;
    Ok(rows.into_iter().collect())
}

async fn assign(pool: &SqlitePool) -> Result<serde_json::Value, sqlx::Error> {
    let list = members(pool).await?;
    let on: HashSet<&str> = list.iter().map(String::as_str).collect();
    let mut ranks = held(pool).await?;
    for user in &list {
        if ranks.values().any(|u| u == user) {
            continue;
        }
        for _ in 0..TRIES {
            let Some((rank, evict)) = pick_rank(&ranks, &on) else { break };
            if let Some(gone) = evict {
                sqlx::query("DELETE FROM commons_lot WHERE user_id = ?1 AND lot_rank = ?2")
                    .bind(gone)
                    .bind(rank)
                    .execute(pool)
                    .await?;
            }
            sqlx::query("INSERT OR IGNORE INTO commons_lot (user_id, lot_rank) VALUES (?1, ?2)")
                .bind(user)
                .bind(rank)
                .execute(pool)
                .await?;
            ranks = held(pool).await?;
            if ranks.values().any(|u| u == user) {
                break;
            }
        }
    }
    let out: Vec<_> = ranks
        .iter()
        .filter(|(_, u)| on.contains(u.as_str()))
        .map(|(r, u)| json!({"user": u, "lot_rank": r}))
        .collect();
    Ok(json!(out))
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn pool() -> SqlitePool {
        // one connection: each sqlite::memory: connection is its own database
        let pool = SqlitePoolOptions::new().max_connections(1).connect("sqlite::memory:").await.unwrap();
        crate::db::migrate(&pool).await.unwrap();
        pool
    }

    /// A user who joined `n` minutes after the first.
    async fn user(pool: &SqlitePool, id: &str, n: i64) {
        sqlx::query(
            "INSERT INTO users (id, github_id, handle, display_name, avatar_url, trainer_name, is_active, created_at)
             VALUES (?1, ?2, ?1, '', '', '', 1, datetime('2026-10-01', ?3))",
        )
        .bind(id)
        .bind(n)
        .bind(format!("+{n} minutes"))
        .execute(pool)
        .await
        .unwrap();
    }

    async fn set_open(pool: &SqlitePool, id: &str, open: bool) {
        sqlx::query("INSERT INTO hq_profiles (user_id, open, look, crew) VALUES (?1, ?2, '{}', '{}')
                     ON CONFLICT(user_id) DO UPDATE SET open = excluded.open")
            .bind(id)
            .bind(open)
            .execute(pool)
            .await
            .unwrap();
    }

    async fn deactivate(pool: &SqlitePool, id: &str) {
        sqlx::query("UPDATE users SET is_active = 0 WHERE id = ?1").bind(id).execute(pool).await.unwrap();
    }

    fn dist(a: (i64, i64), b: (i64, i64)) -> f64 {
        (((a.0 - b.0) as f64).powi(2) + ((a.1 - b.1) as f64).powi(2)).sqrt()
    }

    #[test]
    fn spiral_islands_are_at_least_two_and_a_half_km_apart() {
        let mut pts = vec![(0, 0)]; // the Commons
        pts.extend((0..400).map(slot_pos));
        let mut nearest = Vec::new();
        for (i, a) in pts.iter().enumerate() {
            let d = pts.iter().enumerate().filter(|(j, _)| *j != i).map(|(_, b)| dist(*a, *b)).fold(f64::MAX, f64::min);
            assert!(d >= 250_000.0, "point {i} at {a:?} is {d} cm from its nearest neighbour");
            nearest.push(d);
        }
        // and about 3 km is typical, not a sea of empty kilometres
        nearest.sort_by(f64::total_cmp);
        let median = nearest[nearest.len() / 2];
        assert!((280_000.0..=340_000.0).contains(&median), "median spacing {median} cm");
    }

    #[test]
    fn slot_positions_are_a_pure_function_of_the_slot() {
        assert_eq!(slot_pos(0), slot_pos(0));
        assert_eq!(slot_pos(17), slot_pos(17));
        assert_ne!(slot_pos(0), slot_pos(1));
    }

    #[tokio::test]
    async fn slots_go_in_join_order_and_never_move() {
        let p = pool().await;
        user(&p, "b", 2).await;
        user(&p, "a", 1).await;
        let v = archipelago(&p, "a").await.unwrap();
        let owners: Vec<&str> = v["islands"].as_array().unwrap().iter().map(|i| i["owner"].as_str().unwrap()).collect();
        assert_eq!(owners, ["a", "b"], "joined first, first slot");
        let first = v["islands"].clone();
        assert_eq!((first[0]["x"].as_i64().unwrap(), first[0]["z"].as_i64().unwrap()), slot_pos(0));
        assert_eq!(first[0]["world"], "user:a@2");
        assert_eq!(v["commons"], json!({"world": "claude-hq@2", "x": 0, "z": 0}));

        // a newcomer, and someone leaving: nobody else's island moves
        user(&p, "0-early-id-late-join", 3).await;
        deactivate(&p, "b").await;
        let v2 = archipelago(&p, "a").await.unwrap();
        let isl = v2["islands"].as_array().unwrap();
        assert_eq!(isl.len(), 2);
        assert_eq!(isl[0], first[0]);
        assert_eq!(isl[1]["owner"], "0-early-id-late-join");
        assert_eq!((isl[1]["x"].as_i64().unwrap(), isl[1]["z"].as_i64().unwrap()), slot_pos(2), "b's slot stays b's");

        // b comes back to the same place
        sqlx::query("UPDATE users SET is_active = 1 WHERE id = 'b'").execute(&p).await.unwrap();
        let v3 = archipelago(&p, "a").await.unwrap();
        assert_eq!(v3["islands"][1], first[1]);
    }

    #[test]
    fn visibility_filter_keeps_only_seen_rows_in_order() {
        assert_eq!(visible(vec!["a", "b", "c", "d"], &[true, false, true, false]), ["a", "c"]);
        assert!(visible(vec!["a"], &[false]).is_empty());
    }

    #[tokio::test]
    async fn islands_hidden_from_the_caller_are_left_out() {
        let p = pool().await;
        user(&p, "a", 1).await;
        user(&p, "b", 2).await;
        deactivate(&p, "b").await;
        let v = archipelago(&p, "a").await.unwrap();
        let owners: Vec<&str> = v["islands"].as_array().unwrap().iter().map(|i| i["owner"].as_str().unwrap()).collect();
        assert_eq!(owners, ["a"]);
        // the gate itself: the owner always, an active member of the same Arena, nobody else
        assert!(cities::can_view(&p, "a", "a").await.unwrap());
        assert!(cities::can_view(&p, "b", "b").await.unwrap());
        assert!(!cities::can_view(&p, "b", "a").await.unwrap());
        assert!(!cities::can_view(&p, "a", "stranger").await.unwrap());
        user(&p, "c", 3).await;
        assert!(cities::can_view(&p, "a", "c").await.unwrap());
    }

    #[tokio::test]
    async fn archipelago_lists_only_what_can_view_allows() {
        let p = pool().await;
        user(&p, "a", 1).await;
        user(&p, "b", 2).await;
        user(&p, "c", 3).await;
        let owners = |v: serde_json::Value| -> Vec<String> {
            v["islands"].as_array().unwrap().iter().map(|i| i["owner"].as_str().unwrap().to_string()).collect()
        };
        assert_eq!(owners(archipelago(&p, "a").await.unwrap()), ["a", "b", "c"]);
        // every owner is active, so only can_view keeps these out
        let v = archipelago(&p, "stranger").await.unwrap();
        assert!(owners(v.clone()).is_empty(), "someone from outside this Arena sees no island");
        assert_eq!(v["commons"]["world"], COMMONS, "but still the Commons");
        deactivate(&p, "c").await;
        assert!(owners(archipelago(&p, "c").await.unwrap()).is_empty(), "nor does a disabled member");
        assert_eq!(owners(archipelago(&p, "b").await.unwrap()), ["a", "b"]);
    }

    #[test]
    fn the_assign_route_sits_beside_the_world_routes() {
        // axum panics on an overlapping route when the router is built, i.e. at boot
        let _ = Router::<crate::AppState>::new().merge(crate::world::public_routes()).merge(routes());
        // and beside the preview route a dev Arena (ARENA_WORLD_PREVIEW=1) adds
        let _ = Router::<crate::AppState>::new()
            .route("/v1/world/:id", get(|| async { "" }))
            .route("/v1/world/:id/preview", axum::routing::post(|| async { "" }))
            .merge(routes());
    }

    #[test]
    fn a_newcomer_takes_the_lowest_free_rank() {
        let held: BTreeMap<i64, String> = [(0, "a".into()), (2, "b".into())].into();
        let on: HashSet<&str> = ["a", "b", "c"].into();
        assert_eq!(pick_rank(&held, &on), Some((1, None)));
    }

    #[test]
    fn a_full_pool_reclaims_only_from_someone_who_left() {
        let mut held: BTreeMap<i64, String> = (0..LOTS).map(|r| (r, format!("u{r}"))).collect();
        let names: Vec<String> = (0..LOTS).map(|r| format!("u{r}")).collect();
        let mut on: HashSet<&str> = names.iter().map(String::as_str).collect();
        assert_eq!(pick_rank(&held, &on), None, "64 members on the list: nobody is moved");
        on.remove("u9");
        on.remove("u5");
        assert_eq!(pick_rank(&held, &on), Some((5, Some("u5".into()))));
        held.remove(&63);
        assert_eq!(pick_rank(&held, &on), Some((63, None)), "a free rank comes before a reclaimed one");
    }

    #[tokio::test]
    async fn assignment_is_stable_and_never_moves_anyone() {
        let p = pool().await;
        for (i, id) in ["c", "a", "b"].iter().enumerate() {
            user(&p, id, i as i64).await;
            set_open(&p, id, true).await;
        }
        let r1 = assign(&p).await.unwrap();
        assert_eq!(r1, json!([{"user": "c", "lot_rank": 0}, {"user": "a", "lot_rank": 1}, {"user": "b", "lot_rank": 2}]));
        assert_eq!(assign(&p).await.unwrap(), r1, "a second read changes nothing");

        // a leaves: off the list, but the rank stays held; a newcomer takes the next free one
        set_open(&p, "a", false).await;
        user(&p, "d", 9).await;
        set_open(&p, "d", true).await;
        assert_eq!(
            assign(&p).await.unwrap(),
            json!([{"user": "c", "lot_rank": 0}, {"user": "b", "lot_rank": 2}, {"user": "d", "lot_rank": 3}])
        );
        // a comes back to the same lot
        set_open(&p, "a", true).await;
        assert_eq!(
            assign(&p).await.unwrap(),
            json!([{"user": "c", "lot_rank": 0}, {"user": "a", "lot_rank": 1}, {"user": "b", "lot_rank": 2}, {"user": "d", "lot_rank": 3}])
        );
        // an inactive account drops off the list like a closed HQ
        deactivate(&p, "c").await;
        let r = assign(&p).await.unwrap();
        assert_eq!(r.as_array().unwrap().len(), 3);
        assert_eq!(r[0], json!({"user": "a", "lot_rank": 1}));
    }

    #[tokio::test]
    async fn a_full_commons_reclaims_a_lot_from_someone_who_left() {
        let p = pool().await;
        for i in 0..LOTS {
            let id = format!("u{i:02}");
            user(&p, &id, i).await;
            set_open(&p, &id, true).await;
        }
        let before = assign(&p).await.unwrap();
        assert_eq!(before.as_array().unwrap().len(), LOTS as usize);
        user(&p, "late", 100).await;
        set_open(&p, "late", true).await;
        let full = assign(&p).await.unwrap();
        assert_eq!(full, before, "65th open HQ waits: nobody on the list loses their lot");
        set_open(&p, "u07", false).await;
        let after = assign(&p).await.unwrap();
        let arr = after.as_array().unwrap();
        assert!(arr.contains(&json!({"user": "late", "lot_rank": 7})));
        for e in before.as_array().unwrap().iter().filter(|e| e["user"] != "u07") {
            assert!(arr.contains(e), "{e} moved");
        }
    }
}
