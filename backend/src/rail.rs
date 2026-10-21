//! Cities (HQ 3.x): the rail lines between the islands' stations and the Commons.
//!
//!   GET  /v1/rail          -> {cost, min_tier, lines: [{a, b, built_by, built_at, cost}]}
//!   POST /v1/rail/build {to?} -> {ok, line, lines, treasury}
//!
//! A line joins two worlds, `a < b` (world ids: the Commons `claude-hq@2` or an
//! island `user:<uuid>@2`), stored once whichever end built it. The caller builds
//! from their own island to `to` (default: the Commons), paying [`COST`] coins
//! from their island's city treasury (a `rail` ledger row, ref = the other
//! world) in the same transaction as the line. Both ends need a station: a city
//! of tier [`MIN_TIER`]+ (the Commons always has one).
//!
//! Errors: 422 a bad body (not an object, an unknown field, `to` not a world id,
//! `to` your own island); 404 `to` an island the caller may not see (or no such
//! user); 409 no station at either end, or the line is already built; 402 the
//! treasury is short.
//!
//! Seeding: no line is created automatically. Every line is built by a player
//! from their own treasury; the Commons has no treasury spend path, and
//! auto-lines for tier-4 islands were rejected to keep the economy one-way (coins
//! only ever leave a treasury by its owner's choice) and the map uncluttered.
//!
//! The GET lists only lines whose both ends the caller may see (the Commons
//! always; an island by cities::can_view). PRIVACY: world ids, a user id, times
//! and costs only.

use axum::{
    extract::{Request, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde_json::{json, Value};
use sqlx::SqlitePool;

use crate::archipelago::{island_world, COMMONS};
use crate::cities::{self, Refuse};

/// What a line costs its builder's treasury, coins.
pub const COST: i64 = 500;
/// The city tier that has a station (the transit site).
pub const MIN_TIER: i64 = 2;

pub fn routes() -> Router<crate::AppState> {
    Router::new().route("/v1/rail", get(get_rail)).route("/v1/rail/build", post(post_build))
}

/// The island owner in a world id, None for the Commons; Err for anything else.
fn owner_of(world: &str) -> Result<Option<&str>, ()> {
    if world == COMMONS {
        return Ok(None);
    }
    match world.strip_prefix("user:").and_then(|r| r.strip_suffix("@2")) {
        Some(u) if cities::is_uuid(u) => Ok(Some(u)),
        _ => Err(()),
    }
}

/// The two ends of a line, ordered.
fn ordered<'a>(x: &'a str, y: &'a str) -> (&'a str, &'a str) {
    if x < y {
        (x, y)
    } else {
        (y, x)
    }
}

/// `to` from a POST body: missing, empty or {} is the Commons.
fn parse_to(bytes: &[u8]) -> Result<String, String> {
    if bytes.iter().all(|b| b.is_ascii_whitespace()) {
        return Ok(COMMONS.to_string());
    }
    let Ok(Value::Object(o)) = serde_json::from_slice::<Value>(bytes) else {
        return Err("body must be a JSON object".into());
    };
    if let Some(k) = o.keys().find(|k| k.as_str() != "to") {
        return Err(format!("unknown field {k:?}"));
    }
    match o.get("to") {
        None => Ok(COMMONS.to_string()),
        Some(Value::String(s)) if owner_of(s).is_ok() => Ok(s.clone()),
        _ => Err("to must be a world id (claude-hq@2 or user:<id>@2)".into()),
    }
}

async fn visible(pool: &SqlitePool, world: &str, viewer: &str) -> bool {
    match owner_of(world) {
        Ok(None) => true,
        Ok(Some(o)) => cities::can_view(pool, o, viewer).await,
        Err(()) => false,
    }
}

type LineRow = (String, String, String, i64, i64);

fn line_json(r: &LineRow) -> Value {
    json!({"a": r.0, "b": r.1, "built_by": r.2, "built_at": r.3, "cost": r.4})
}

/// Every line the viewer may see both ends of.
pub(crate) async fn lines(pool: &SqlitePool, viewer: &str) -> Result<Vec<Value>, sqlx::Error> {
    let rows: Vec<LineRow> =
        sqlx::query_as("SELECT a, b, built_by, built_at, cost FROM rail_line ORDER BY built_at, a, b").fetch_all(pool).await?;
    let mut out = Vec::new();
    for r in &rows {
        if visible(pool, &r.0, viewer).await && visible(pool, &r.1, viewer).await {
            out.push(line_json(r));
        }
    }
    Ok(out)
}

async fn get_rail(State(st): State<crate::AppState>, req: Request) -> Response {
    let c = cities::caller(&req);
    match lines(&st.pool, &c.user_id).await {
        Ok(l) => Json(json!({"cost": COST, "min_tier": MIN_TIER, "lines": l})).into_response(),
        Err(e) => Refuse::Db(e).response(),
    }
}

/// `who` builds a line from their island to `to`. Returns (the line, the treasury after).
pub(crate) async fn build(pool: &SqlitePool, who: &str, to: &str, now: i64) -> Result<(Value, i64), Refuse> {
    let from = island_world(who);
    if to == from {
        return Err(Refuse::say(StatusCode::UNPROCESSABLE_ENTITY, "a line needs another city at the far end"));
    }
    let target = owner_of(to).map_err(|_| Refuse::say(StatusCode::UNPROCESSABLE_ENTITY, "to must be a world id"))?;
    if !visible(pool, to, who).await {
        return Err(Refuse::say(StatusCode::NOT_FOUND, "no such city"));
    }
    let snap = cities::snapshot(pool, who, now).await?.ok_or_else(|| Refuse::say(StatusCode::NOT_FOUND, "no such city"))?;
    if snap.tier < MIN_TIER {
        return Err(Refuse::say(StatusCode::CONFLICT, "your island needs a station first (tier 2)"));
    }
    if let Some(o) = target {
        let (name, tier) = cities::name_and_tier(pool, o).await?;
        if (tier as i64) < MIN_TIER {
            let name = if name.is_empty() { "that island".to_string() } else { name };
            return Err(Refuse::say(StatusCode::CONFLICT, format!("{name} has no station yet")));
        }
    }
    cities::accrue(pool, &snap, now).await?;
    let (a, b) = ordered(&from, to);
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let ins = sqlx::query("INSERT OR IGNORE INTO rail_line (a, b, built_by, built_at, cost) VALUES (?1, ?2, ?3, ?4, ?5)")
        .bind(a)
        .bind(b)
        .bind(who)
        .bind(now)
        .bind(COST)
        .execute(&mut *tx)
        .await?;
    if ins.rows_affected() == 0 {
        return Err(Refuse::say(StatusCode::CONFLICT, "that line is already built"));
    }
    let bal = match cities::post_entry(&mut tx, who, "rail", -COST, to, now).await {
        Ok(b) => b,
        Err(Refuse::Say(StatusCode::CONFLICT, _)) => {
            return Err(Refuse::say(StatusCode::PAYMENT_REQUIRED, format!("not enough in your treasury (a line costs {COST} coins)")))
        }
        Err(e) => return Err(e),
    };
    tx.commit().await?;
    Ok((line_json(&(a.to_string(), b.to_string(), who.to_string(), now, COST)), bal))
}

async fn post_build(State(st): State<crate::AppState>, req: Request) -> Response {
    let c = cities::caller(&req);
    let bytes = match cities::read_body(req).await {
        Ok(b) => b,
        Err(r) => return r.response(),
    };
    let to = match parse_to(&bytes) {
        Ok(t) => t,
        Err(m) => return crate::err(StatusCode::UNPROCESSABLE_ENTITY, &m),
    };
    let (line, treasury) = match build(&st.pool, &c.user_id, &to, cities::now_secs()).await {
        Ok(v) => v,
        Err(r) => return r.response(),
    };
    match lines(&st.pool, &c.user_id).await {
        Ok(l) => Json(json!({"ok": true, "line": line, "lines": l, "treasury": treasury})).into_response(),
        Err(e) => Refuse::Db(e).response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    const A: &str = "aaaaaaaa-0000-4000-8000-000000000001";
    const B: &str = "bbbbbbbb-0000-4000-8000-000000000002";
    const C: &str = "cccccccc-0000-4000-8000-000000000003";
    const GONE: &str = "dddddddd-0000-4000-8000-000000000004";
    const NOW: i64 = 1_792_411_200;

    async fn pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new().max_connections(1).connect("sqlite::memory:").await.unwrap();
        crate::db::migrate(&pool).await.unwrap();
        for (i, (id, active)) in [(A, 1), (B, 1), (C, 1), (GONE, 0)].iter().enumerate() {
            sqlx::query(
                "INSERT INTO users (id, github_id, handle, display_name, avatar_url, trainer_name, is_active, created_at)
                 VALUES (?1, ?2, ?3, '', '', '', ?4, datetime('now'))",
            )
            .bind(id)
            .bind(i as i64 + 1)
            .bind(format!("h{i}"))
            .bind(active)
            .execute(&pool)
            .await
            .unwrap();
        }
        pool
    }

    /// n prompts of XP (200 = 2,000 XP = tier 2).
    async fn prompts(p: &SqlitePool, uid: &str, n: i64) {
        sqlx::query(
            "INSERT INTO daily_stats (id, user_id, stat_date, prompts, tools, artifacts, replies,
             tokens_input, tokens_output, tokens_cache_read, tokens_cache_creation)
             VALUES (?1, ?2, '2026-10-01', ?3, 0, 0, 0, 0, 0, 0, 0)",
        )
        .bind(uuid::Uuid::new_v4().to_string())
        .bind(uid)
        .bind(n)
        .execute(p)
        .await
        .unwrap();
    }

    async fn fund(p: &SqlitePool, uid: &str, coins: i64) {
        let mut conn = p.acquire().await.unwrap();
        cities::ensure_city(&mut conn, uid, NOW).await.unwrap();
        cities::post_entry(&mut conn, uid, "transfer_in", coins, "", NOW).await.unwrap();
    }

    async fn treasury(p: &SqlitePool, uid: &str) -> i64 {
        sqlx::query_scalar("SELECT treasury FROM city WHERE owner = ?1").bind(uid).fetch_one(p).await.unwrap()
    }

    async fn line_count(p: &SqlitePool) -> i64 {
        sqlx::query_scalar("SELECT COUNT(*) FROM rail_line").fetch_one(p).await.unwrap()
    }

    fn code(r: Result<(Value, i64), Refuse>) -> StatusCode {
        match r {
            Err(Refuse::Say(c, _)) => c,
            Err(Refuse::Db(e)) => panic!("db error {e}"),
            Ok(_) => StatusCode::OK,
        }
    }

    #[tokio::test]
    async fn building_a_line_debits_the_treasury_with_a_ledger_row() {
        let p = pool().await;
        prompts(&p, A, 200).await;
        fund(&p, A, 800).await;
        let (line, bal) = build(&p, A, COMMONS, NOW).await.map_err(|_| ()).unwrap();
        assert_eq!(bal, 300);
        assert_eq!(treasury(&p, A).await, 300);
        // ordered: "claude-hq@2" < "user:..."
        assert_eq!(line, json!({"a": COMMONS, "b": island_world(A), "built_by": A, "built_at": NOW, "cost": COST}));
        let led: (String, i64, String) =
            sqlx::query_as("SELECT kind, amount, ref FROM city_ledger WHERE owner = ?1 AND kind = 'rail'").bind(A).fetch_one(&p).await.unwrap();
        assert_eq!(led, ("rail".to_string(), -COST, COMMONS.to_string()));
        assert_eq!(lines(&p, A).await.unwrap(), vec![line]);
    }

    #[tokio::test]
    async fn a_line_is_built_once_whichever_end_builds_it() {
        let p = pool().await;
        for u in [A, B] {
            prompts(&p, u, 200).await;
            fund(&p, u, 1000).await;
        }
        build(&p, A, &island_world(B), NOW).await.map_err(|_| ()).unwrap();
        assert_eq!(code(build(&p, A, &island_world(B), NOW).await), StatusCode::CONFLICT);
        assert_eq!(code(build(&p, B, &island_world(A), NOW).await), StatusCode::CONFLICT);
        assert_eq!(treasury(&p, B).await, 1000, "a refused build costs nothing");
        let l = lines(&p, C).await.unwrap();
        assert_eq!(l.len(), 1);
        assert!(l[0]["a"].as_str().unwrap() < l[0]["b"].as_str().unwrap());
    }

    #[tokio::test]
    async fn a_short_treasury_is_402_and_writes_nothing() {
        let p = pool().await;
        prompts(&p, A, 200).await;
        fund(&p, A, 499).await;
        assert_eq!(code(build(&p, A, COMMONS, NOW).await), StatusCode::PAYMENT_REQUIRED);
        assert_eq!(line_count(&p).await, 0);
        assert_eq!(treasury(&p, A).await, 499);
    }

    #[tokio::test]
    async fn both_ends_need_a_station() {
        let p = pool().await;
        fund(&p, A, 1000).await;
        assert_eq!(code(build(&p, A, COMMONS, NOW).await), StatusCode::CONFLICT, "a tier-1 caller");
        prompts(&p, A, 200).await;
        assert_eq!(code(build(&p, A, &island_world(B), NOW).await), StatusCode::CONFLICT, "a tier-1 target");
        assert_eq!(line_count(&p).await, 0);
        prompts(&p, B, 200).await;
        assert_eq!(code(build(&p, A, &island_world(B), NOW).await), StatusCode::OK);
    }

    #[tokio::test]
    async fn hidden_unknown_or_own_targets_are_refused() {
        let p = pool().await;
        prompts(&p, A, 200).await;
        fund(&p, A, 1000).await;
        assert_eq!(code(build(&p, A, &island_world(GONE), NOW).await), StatusCode::NOT_FOUND);
        assert_eq!(code(build(&p, A, "user:eeeeeeee-0000-4000-8000-000000000005@2", NOW).await), StatusCode::NOT_FOUND);
        assert_eq!(code(build(&p, A, &island_world(A), NOW).await), StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(code(build(&p, A, "claude-hq@1", NOW).await), StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(line_count(&p).await, 0);
    }

    #[test]
    fn the_body_defaults_to_the_commons_and_takes_only_a_world_id() {
        assert_eq!(parse_to(b"").unwrap(), COMMONS);
        assert_eq!(parse_to(b"{}").unwrap(), COMMONS);
        assert_eq!(parse_to(format!("{{\"to\":\"{}\"}}", island_world(B)).as_bytes()).unwrap(), island_world(B));
        assert!(parse_to(b"[]").is_err());
        assert!(parse_to(b"{\"to\":\"user:../x@2\"}").is_err());
        assert!(parse_to(b"{\"to\":5}").is_err());
        assert!(parse_to(b"{\"to\":\"claude-hq@2\",\"cost\":1}").is_err());
    }

    #[tokio::test]
    async fn the_list_shows_only_lines_the_viewer_can_see_both_ends_of() {
        let p = pool().await;
        for u in [A, B] {
            prompts(&p, u, 200).await;
            fund(&p, u, 2000).await;
        }
        build(&p, A, COMMONS, NOW).await.map_err(|_| ()).unwrap();
        build(&p, B, &island_world(A), NOW + 1).await.map_err(|_| ()).unwrap();
        assert_eq!(lines(&p, C).await.unwrap().len(), 2);
        // B goes closed: only B sees the A-B line now
        sqlx::query("UPDATE city SET privacy = 'closed' WHERE owner = ?1").bind(B).execute(&p).await.unwrap();
        let c = lines(&p, C).await.unwrap();
        assert_eq!(c.len(), 1);
        assert_eq!(c[0]["a"], COMMONS);
        assert_eq!(lines(&p, B).await.unwrap().len(), 2);
        assert!(lines(&p, "stranger").await.unwrap().is_empty());
    }

    #[test]
    fn the_rail_routes_sit_beside_the_others() {
        let _ = Router::<crate::AppState>::new().merge(crate::archipelago::routes()).merge(routes());
    }
}
