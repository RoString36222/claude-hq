//! Cities (HQ 3.x): the sea everyone's island sits on, and the Commons' HQ lots.
//!
//!   GET /v1/archipelago                -> {commons:{world,x,z,mouth?}, islands:[{owner,name,world,x,z,tier,mouth?}]}
//!                                         mouth: [x, z, dx, dz], the river's mouth in the world's own
//!                                         frame (cm) and the way out to sea there (per mille)
//!   GET /v1/world/claude-hq@3/assign   -> [{user, lot_rank}]
//!   GET /v1/world/claude-hq@2/assign   -> the same (older clients)
//!
//! The live worlds are on generator version [`LIVE_V`] (HQ 3.15): the Commons
//! `claude-hq@3` and every island `user:<uuid>@3`. The @2 ids name the same
//! cities for older clients: input accepts them and [`canonical_world`] maps
//! them to @3 wherever a world id is stored. Slots and ranks are id-independent,
//! so the move to @3 left every island on its slot and every HQ on its rank.
//!
//! The Commons (claude-hq@3) is at the origin. Every active member's island gets
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

use crate::cities;

/// The generator version of the live worlds (the Commons and the islands).
pub const LIVE_V: u32 = 3;
/// The Commons' world id; it sits at the origin.
pub const COMMONS: &str = "claude-hq@3";
/// The Commons' id before HQ 3.15, still accepted on input and still served.
pub const COMMONS_V2: &str = "claude-hq@2";
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
        .route("/v1/world/claude-hq@3/assign", get(get_assign))
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

/// The island world of `owner` (the live version).
pub fn island_world(owner: &str) -> String {
    format!("user:{owner}@{LIVE_V}")
}

/// The owner of an island world id, `user:<uuid>@2` or `user:<uuid>@3` with a
/// lowercase uuid (cities::is_uuid); None for anything else.
pub fn island_owner(id: &str) -> Option<&str> {
    let rest = id.strip_prefix("user:")?;
    let uuid = rest.strip_suffix("@3").or_else(|| rest.strip_suffix("@2"))?;
    cities::is_uuid(uuid).then_some(uuid)
}

/// Whether `id` is an island world id, at @2 or @3.
pub fn is_island_world(id: &str) -> bool {
    island_owner(id).is_some()
}

/// Whether `id` is the Commons, at @2 or @3.
pub fn is_commons(id: &str) -> bool {
    id == COMMONS || id == COMMONS_V2
}

/// The id to store for a world: the Commons and the islands at @2 become their
/// live (@3) id; anything else (claude-hq@1, a malformed id) comes back as is.
pub fn canonical_world(id: &str) -> String {
    if is_commons(id) {
        return COMMONS.to_string();
    }
    match island_owner(id) {
        Some(owner) => island_world(owner),
        None => id.to_string(),
    }
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
        seen.push(cities::can_view(pool, owner, viewer).await);
    }
    let mut islands = Vec::new();
    for (owner, x, z) in visible(rows, &seen) {
        let (name, tier) = cities::name_and_tier(pool, &owner).await?;
        let world = island_world(&owner);
        let mut row = json!({"owner": owner, "name": name, "world": world, "x": x, "z": z, "tier": tier});
        with_mouth(&mut row, &world);
        islands.push(row);
    }
    let mut commons = json!({"world": COMMONS, "x": 0, "z": 0});
    with_mouth(&mut commons, COMMONS);
    Ok(json!({"commons": commons, "islands": islands}))
}

/// The world's river mouth on its row (`mouth`, see worldgen::river_mouth), when it has a river.
fn with_mouth(row: &mut serde_json::Value, world: &str) {
    if let Some(m) = crate::worldgen::river_mouth(world) {
        row["mouth"] = json!(m);
    }
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
        assert_eq!(first[0]["world"], "user:a@3");
        assert_eq!((&v["commons"]["world"], &v["commons"]["x"], &v["commons"]["z"]), (&json!("claude-hq@3"), &json!(0), &json!(0)));
        // the river mouths come from the generator of the live version (part worldgen adds @3)
        if crate::worldgen::VERSION.contains(&LIVE_V) {
            let m = v["commons"]["mouth"].as_array().expect("the Commons' river mouth");
            let (dx, dz) = (m[2].as_i64().unwrap(), m[3].as_i64().unwrap());
            assert!((990..=1010).contains(&(((dx * dx + dz * dz) as f64).sqrt() as i64)), "the way out is a unit vector");
            assert!(first[0]["mouth"].as_array().is_some_and(|m| m.len() == 4), "an island's river mouth");
        }

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
        // the gate itself: the owner, an active member of the same Arena, nobody
        // else; a disabled owner has no city to see, not even for themselves
        assert!(cities::can_view(&p, "a", "a").await);
        assert!(!cities::can_view(&p, "b", "b").await);
        assert!(!cities::can_view(&p, "b", "a").await);
        assert!(!cities::can_view(&p, "a", "stranger").await);
        user(&p, "c", 3).await;
        assert!(cities::can_view(&p, "a", "c").await);
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

    const U: &str = "0b8e4c1a-3f2d-4e5b-9a6c-7d8e9f0a1b2c";
    const V: &str = "aaaaaaaa-0000-4000-8000-000000000001";

    #[test]
    fn the_live_worlds_are_at_version_3_and_2_is_still_understood() {
        assert_eq!(LIVE_V, 3);
        assert_eq!(COMMONS, "claude-hq@3");
        assert_eq!(island_world(U), format!("user:{U}@3"));
        for v in ["@2", "@3"] {
            assert!(is_island_world(&format!("user:{U}{v}")), "{v}");
            assert_eq!(island_owner(&format!("user:{U}{v}")), Some(U));
            assert_eq!(canonical_world(&format!("user:{U}{v}")), format!("user:{U}@3"));
            assert!(is_commons(&format!("claude-hq{v}")));
            assert_eq!(canonical_world(&format!("claude-hq{v}")), COMMONS);
        }
        // @1 is a different world (Arena City), never rewritten; an island is never @1 or @4
        assert_eq!(canonical_world("claude-hq@1"), "claude-hq@1");
        assert!(!is_commons("claude-hq@1") && !is_commons("claude-hq@4"));
        for bad in [
            format!("user:{U}@1"),
            format!("user:{U}@4"),
            format!("user:{U}@23"),
            format!("user:{}@3", U.to_uppercase()),
            "user:../../x@3".into(),
            "user:@3".into(),
            format!("user:{U}@3@2"),
            format!("USER:{U}@3"),
        ] {
            assert!(!is_island_world(&bad), "{bad}");
            assert_eq!(canonical_world(&bad), bad, "left as is");
        }
    }

    #[test]
    fn both_assign_paths_are_routed() {
        // a second registration of either path would panic: so each is there exactly once
        let r = std::panic::catch_unwind(|| {
            let _ = routes().route("/v1/world/claude-hq@3/assign", get(|| async { "" }));
        });
        assert!(r.is_err(), "the @3 path is registered");
        let r = std::panic::catch_unwind(|| {
            let _ = routes().route("/v1/world/claude-hq@2/assign", get(|| async { "" }));
        });
        assert!(r.is_err(), "the @2 path is still registered");
    }

    /// Migration 0024 (live worlds to @3) on a database that holds @2 rows.
    #[tokio::test]
    async fn migration_0024_moves_the_stored_worlds_to_version_3() {
        let p = SqlitePoolOptions::new().max_connections(1).connect("sqlite::memory:").await.unwrap();
        let mut old = sqlx::migrate!("./migrations");
        old.migrations = old.migrations.iter().filter(|m| m.version < 24).cloned().collect::<Vec<_>>().into();
        old.run(&p).await.unwrap();
        for (i, id) in [U, V].iter().enumerate() {
            sqlx::query(
                "INSERT INTO users (id, github_id, handle, display_name, avatar_url, trainer_name, is_active)
                 VALUES (?1, ?2, ?1, '', '', '', 1)",
            )
            .bind(id)
            .bind(i as i64 + 1)
            .execute(&p)
            .await
            .unwrap();
        }
        let (iu, iv) = (format!("user:{U}@2"), format!("user:{V}@2"));
        for (owner, seed, spec) in [("commons", "claude-hq@2", "fish"), (U, iu.as_str(), "tech"), (V, iv.as_str(), "film")] {
            sqlx::query(
                "INSERT INTO city (owner, seed, treasury, tax_pm, specialty, privacy, created, last_accrual)
                 VALUES (?1, ?2, 7, 50, ?3, 'arena', 0, 0)",
            )
            .bind(owner)
            .bind(seed)
            .bind(spec)
            .execute(&p)
            .await
            .unwrap();
        }
        // lines: the Commons-island one stays ordered; island-island where the @3 rewrite flips nothing;
        // and one already at @3 (an Arena that ran a newer binary first) untouched
        for (a, b, by) in [("claude-hq@2", iu.as_str(), U), (iu.as_str(), iv.as_str(), V), ("claude-hq@1", "claude-hq@3", U)] {
            sqlx::query("INSERT INTO rail_line (a, b, built_by, built_at, cost) VALUES (?1, ?2, ?3, 5, 500)")
                .bind(a)
                .bind(b)
                .bind(by)
                .execute(&p)
                .await
                .unwrap();
        }
        for (id, world) in [("v1", Some(iu.as_str())), ("v2", Some("claude-hq@2")), ("v3", Some("claude-hq@1")), ("v4", None)] {
            sqlx::query(
                "INSERT INTO owned_vehicles (id, user_id, vehicle_id, paint, price, bought_at, parked_world, parked_x, parked_z, parked_yaw)
                 VALUES (?1, ?2, ?1, 0, 0, 0, ?3, CASE WHEN ?3 IS NULL THEN NULL ELSE 1.5 END,
                         CASE WHEN ?3 IS NULL THEN NULL ELSE -2.0 END, CASE WHEN ?3 IS NULL THEN NULL ELSE 0.5 END)",
            )
            .bind(id)
            .bind(U)
            .bind(world)
            .execute(&p)
            .await
            .unwrap();
        }

        crate::db::migrate(&p).await.unwrap();

        let cities: Vec<(String, String, String, i64)> =
            sqlx::query_as("SELECT owner, seed, specialty, treasury FROM city ORDER BY owner").fetch_all(&p).await.unwrap();
        let mut want = vec![
            ("commons".to_string(), "claude-hq@3".to_string(), "fish".to_string(), 7),
            (U.to_string(), format!("user:{U}@3"), "tech".to_string(), 7),
            (V.to_string(), format!("user:{V}@3"), "film".to_string(), 7),
        ];
        want.sort();
        assert_eq!(cities, want, "seeds move to @3; specialties and treasuries stay");

        let lines: Vec<(String, String, String, i64, i64)> =
            sqlx::query_as("SELECT a, b, built_by, built_at, cost FROM rail_line ORDER BY a, b").fetch_all(&p).await.unwrap();
        let mut want = vec![
            ("claude-hq@1".to_string(), "claude-hq@3".to_string(), U.to_string(), 5, 500),
            ("claude-hq@3".to_string(), format!("user:{U}@3"), U.to_string(), 5, 500),
            (format!("user:{U}@3"), format!("user:{V}@3"), V.to_string(), 5, 500),
        ];
        want.sort();
        assert_eq!(lines, want);
        assert!(lines.iter().all(|l| l.0 < l.1), "a < b holds");

        let cars: Vec<(String, Option<String>, Option<f64>, Option<f64>, Option<f64>)> = sqlx::query_as(
            "SELECT id, parked_world, parked_x, parked_z, parked_yaw FROM owned_vehicles ORDER BY id",
        )
        .fetch_all(&p)
        .await
        .unwrap();
        assert_eq!(
            cars,
            vec![
                ("v1".to_string(), Some(format!("user:{U}@3")), None, None, None),
                ("v2".to_string(), Some("claude-hq@3".to_string()), None, None, None),
                ("v3".to_string(), Some("claude-hq@1".to_string()), Some(1.5), Some(-2.0), Some(0.5)),
                ("v4".to_string(), None, None, None, None),
            ],
            "a car out in a moved world goes home; Arena City (@1) did not move"
        );
        // and the vehicles list reads a car with no position as at home
        let mine = crate::vehicles::mine(&p, U).await.unwrap();
        let parked: Vec<&serde_json::Value> = mine.iter().map(|v| &v["parked"]).collect();
        assert_eq!(parked.iter().filter(|v| v.is_null()).count(), 3);
        assert_eq!(*parked[2], json!({"world": "claude-hq@1", "x": 1.5, "z": -2.0, "yaw": 0.5}));
        // booting again changes nothing
        crate::db::migrate(&p).await.unwrap();
        let again: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM rail_line").fetch_one(&p).await.unwrap();
        assert_eq!(again, 3);
    }
}
