//! Vehicles (HQ 3.2, docs/plans/dealership-spec.md): the real cars and bikes players buy at
//! the dealership, and where they left them.
//!
//!   GET  /v1/vehicles/mine                 -> {vehicles: [{id, vehicle_id, paint, bought_at, parked}]}
//!   POST /v1/vehicles/buy {vehicle_id, paint} -> {ok, vehicle, coins}
//!   POST /v1/vehicles/:id/park {world, x, z, yaw} | {garage: true} -> {ok}
//!
//! Owned vehicles live in their city's multi-storey garage and drive themselves back
//! there when their owner leaves them: `parked` is null in the garage (the normal
//! state) and set only for a vehicle out on a trip; `{garage: true}` puts it back.
//!
//! The catalogue is backend/data/vehicles.json, a byte copy of the browser's
//! games/vehicles/catalogue.json (tests/test_game_data_sync.py), embedded at build
//! time: the server sets the price and the level a class needs, never the client.
//!
//! FREE FOR ALL FOR NOW: every vehicle's price and every class's minLevel is 0 in the
//! catalogue, so buying is claiming. Prices and level gates are data: set them in the
//! catalogue and these checks apply unchanged (the tests run them on fixtures).
//!
//! Buying: only a listed vehicle (slot 1 to 4) of a class that is on sale (1 to 4
//! listed vehicles, HQ 3.9); `paint` is an index into its paints. The class's `minLevel` is checked
//! against the caller's HQ level (cosmetics::hq_level, the level the Trainer card
//! shows). Paid in Poke Coins from poke_balances in the same transaction as the
//! owned_vehicles row, which records the price (poke_ledger's op CHECK has no
//! vehicle op). Several of the same vehicle may be owned (another paint), up to
//! [`MAX_OWNED`].
//!
//! Errors: 422 a bad body; 404 an unknown vehicle (or not yours, for park); 409 not
//! on sale (a starter, a reserve, a class listing more than 4) or the garage is
//! full; 403 the class needs a higher level; 402 not enough Poke Coins.
//!
//! PRIVACY: catalogue ids, paint indexes, prices, times and world coordinates only.

use axum::{
    extract::{Path, Request, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde_json::{json, Map, Value};
use sqlx::{Row, SqlitePool};
use std::collections::HashMap;
use std::sync::LazyLock;

use crate::cities::{self, Refuse};

/// Most vehicles one player may own.
pub const MAX_OWNED: i64 = 20;
/// The most vehicles a class lists (slots 1 to 4, HQ 3.9); a class is on sale with 1 to 4.
const MAX_SLOTS: usize = 4;
/// |x|, |z| a parked vehicle may stand at (m): every world fits well inside.
const MAX_COORD: f64 = 20_000.0;

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Model {
    pub class: String,
    pub on_sale: bool,
    pub price: i64,
    pub min_level: i64,
    pub paints: usize,
}

/// id -> what the server needs to sell it.
pub(crate) fn parse_catalogue(src: &str) -> HashMap<String, Model> {
    let v: Value = serde_json::from_str(src).expect("backend/data/vehicles.json is valid JSON");
    let min_level: HashMap<&str, i64> = v["classes"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|c| Some((c["id"].as_str()?, c["minLevel"].as_i64().unwrap_or(0))))
        .collect();
    let in_slot = |s: &Value| s.as_i64().is_some_and(|n| (1..=MAX_SLOTS as i64).contains(&n));
    let mut slots: HashMap<&str, usize> = HashMap::new();
    for m in v["vehicles"].as_array().into_iter().flatten() {
        if in_slot(&m["slot"]) {
            *slots.entry(m["class"].as_str().unwrap_or("")).or_default() += 1;
        }
    }
    v["vehicles"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|m| {
            let class = m["class"].as_str()?.to_string();
            Some((
                m["id"].as_str()?.to_string(),
                Model {
                    on_sale: in_slot(&m["slot"])
                        && slots.get(class.as_str()).is_some_and(|n| (1..=MAX_SLOTS).contains(n)),
                    price: m["price"].as_i64().unwrap_or(0),
                    min_level: *min_level.get(class.as_str()).unwrap_or(&0),
                    paints: m["paints"].as_array().map_or(0, Vec::len),
                    class,
                },
            ))
        })
        .collect()
}

static CATALOGUE: LazyLock<HashMap<String, Model>> =
    LazyLock::new(|| parse_catalogue(include_str!("../data/vehicles.json")));

/// A catalogue id (any slot, starters included): what presence may name.
pub(crate) fn is_vehicle(id: &str) -> bool {
    CATALOGUE.contains_key(id)
}

pub fn routes() -> Router<crate::AppState> {
    Router::new()
        .route("/v1/vehicles/mine", get(get_mine))
        .route("/v1/vehicles/buy", post(post_buy))
        .route("/v1/vehicles/:id/park", post(post_park))
}

fn id_ok(s: &str) -> bool {
    (1..=48).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// A world a vehicle can be parked in: the Commons (@1 or @2) or an island.
fn world_ok(w: &str) -> bool {
    matches!(w, "claude-hq@1" | "claude-hq@2")
        || w.strip_prefix("user:").and_then(|r| r.strip_suffix("@2")).is_some_and(cities::is_uuid)
}

fn object(bytes: &[u8], keys: &[&str]) -> Result<Map<String, Value>, String> {
    let Ok(Value::Object(o)) = serde_json::from_slice::<Value>(bytes) else {
        return Err("body must be a JSON object".into());
    };
    if let Some(k) = o.keys().find(|k| !keys.contains(&k.as_str())) {
        return Err(format!("unknown field {k:?}"));
    }
    Ok(o)
}

/// {vehicle_id, paint} from a buy body.
pub(crate) fn parse_buy(bytes: &[u8]) -> Result<(String, i64), String> {
    let o = object(bytes, &["vehicle_id", "paint"])?;
    let id = o.get("vehicle_id").and_then(Value::as_str).filter(|s| id_ok(s)).ok_or("vehicle_id must be a catalogue id")?;
    let paint = match o.get("paint") {
        None => 0,
        Some(p) => p.as_i64().filter(|n| (0..64).contains(n)).ok_or("paint must be an index into the vehicle's paints")?,
    };
    Ok((id.to_string(), paint))
}

/// Where a park body puts a vehicle: out at (world, x, z, yaw), or back in its garage.
#[derive(Debug, PartialEq)]
pub(crate) enum Spot {
    Out(String, f64, f64, f64),
    Garage,
}

/// {world, x, z, yaw} or {garage: true} from a park body.
pub(crate) fn parse_park(bytes: &[u8]) -> Result<Spot, String> {
    let o = object(bytes, &["world", "x", "z", "yaw", "garage"])?;
    if let Some(g) = o.get("garage") {
        return if g == &Value::Bool(true) && o.len() == 1 {
            Ok(Spot::Garage)
        } else {
            Err("garage must be true, alone".into())
        };
    }
    let world = o.get("world").and_then(Value::as_str).filter(|w| world_ok(w)).ok_or("world must be a world id")?;
    let num = |k: &str| o.get(k).and_then(Value::as_f64).filter(|v| v.is_finite());
    let (Some(x), Some(z), Some(yaw)) = (num("x"), num("z"), num("yaw")) else {
        return Err("x, z and yaw must be numbers".into());
    };
    if x.abs() > MAX_COORD || z.abs() > MAX_COORD {
        return Err("x and z are out of range".into());
    }
    Ok(Spot::Out(world.to_string(), x, z, yaw.rem_euclid(std::f64::consts::TAU)))
}

fn row_json(r: &sqlx::sqlite::SqliteRow) -> Value {
    let world: Option<String> = r.get("parked_world");
    let parked = match world {
        Some(w) => json!({"world": w, "x": r.get::<f64, _>("parked_x"), "z": r.get::<f64, _>("parked_z"),
                          "yaw": r.get::<f64, _>("parked_yaw")}),
        None => Value::Null,
    };
    json!({"id": r.get::<String, _>("id"), "vehicle_id": r.get::<String, _>("vehicle_id"),
           "paint": r.get::<i64, _>("paint"), "bought_at": r.get::<i64, _>("bought_at"), "parked": parked})
}

pub(crate) async fn mine(pool: &SqlitePool, uid: &str) -> Result<Vec<Value>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT id, vehicle_id, paint, bought_at, parked_world, parked_x, parked_z, parked_yaw
         FROM owned_vehicles WHERE user_id = ?1 ORDER BY bought_at, id",
    )
    .bind(uid)
    .fetch_all(pool)
    .await?;
    Ok(rows.iter().map(row_json).collect())
}

/// `uid` buys `vehicle_id` in `paint` from the embedded catalogue. Returns (the vehicle, coins left).
pub(crate) async fn buy(pool: &SqlitePool, uid: &str, vehicle_id: &str, paint: i64, now: i64) -> Result<(Value, i64), Refuse> {
    buy_in(&CATALOGUE, pool, uid, vehicle_id, paint, now).await
}

async fn coins_of(conn: &mut sqlx::SqliteConnection, uid: &str) -> Result<i64, sqlx::Error> {
    Ok(sqlx::query_scalar("SELECT qty FROM poke_balances WHERE user_id = ?1 AND item = 'coins'")
        .bind(uid)
        .fetch_optional(conn)
        .await?
        .unwrap_or(0))
}

/// [`buy`] against any catalogue (tests use fixtures with real prices and level gates).
pub(crate) async fn buy_in(
    cat: &HashMap<String, Model>,
    pool: &SqlitePool,
    uid: &str,
    vehicle_id: &str,
    paint: i64,
    now: i64,
) -> Result<(Value, i64), Refuse> {
    let m = cat.get(vehicle_id).ok_or_else(|| Refuse::say(StatusCode::NOT_FOUND, "no such vehicle"))?;
    if !m.on_sale {
        return Err(Refuse::say(StatusCode::CONFLICT, "that vehicle isn't on sale"));
    }
    if paint as usize >= m.paints {
        return Err(Refuse::say(StatusCode::UNPROCESSABLE_ENTITY, "no such paint for that vehicle"));
    }
    // No gate (minLevel 0, as every class is for now) costs no level walk.
    let level = if m.min_level > 0 { crate::cosmetics::hq_level(pool, uid).await? } else { 0 };
    if level < m.min_level {
        return Err(Refuse::say(StatusCode::FORBIDDEN, format!("this class needs level {} (you're level {level})", m.min_level)));
    }
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let owned: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM owned_vehicles WHERE user_id = ?1")
        .bind(uid)
        .fetch_one(&mut *tx)
        .await?;
    if owned >= MAX_OWNED {
        return Err(Refuse::say(StatusCode::CONFLICT, format!("your garage is full ({MAX_OWNED} vehicles)")));
    }
    // A free vehicle (price 0, every vehicle for now) touches no balance: a player
    // with no coins row at all can still claim one.
    let paid = if m.price > 0 {
        sqlx::query(
            "UPDATE poke_balances SET qty = qty - ?1, updated_at = CURRENT_TIMESTAMP
             WHERE user_id = ?2 AND item = 'coins' AND qty >= ?1",
        )
        .bind(m.price)
        .bind(uid)
        .execute(&mut *tx)
        .await?
        .rows_affected()
            == 1
    } else {
        true
    };
    if !paid {
        let have = coins_of(&mut tx, uid).await?;
        return Err(Refuse::say(
            StatusCode::PAYMENT_REQUIRED,
            format!("not enough Poke Coins (need {}, you have {have})", m.price),
        ));
    }
    let id = uuid::Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO owned_vehicles (id, user_id, vehicle_id, paint, price, bought_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    )
    .bind(&id)
    .bind(uid)
    .bind(vehicle_id)
    .bind(paint)
    .bind(m.price)
    .bind(now)
    .execute(&mut *tx)
    .await?;
    let coins = coins_of(&mut tx, uid).await?;
    tx.commit().await?;
    Ok((json!({"id": id, "vehicle_id": vehicle_id, "paint": paint, "bought_at": now, "parked": Value::Null}), coins))
}

pub(crate) async fn park(pool: &SqlitePool, uid: &str, id: &str, spot: &Spot) -> Result<(), Refuse> {
    let (world, x, z, yaw) = match spot {
        Spot::Out(w, x, z, yaw) => (Some(w.as_str()), Some(*x), Some(*z), Some(*yaw)),
        Spot::Garage => (None, None, None, None),
    };
    let r = sqlx::query(
        "UPDATE owned_vehicles SET parked_world = ?1, parked_x = ?2, parked_z = ?3, parked_yaw = ?4
         WHERE id = ?5 AND user_id = ?6",
    )
    .bind(world)
    .bind(x)
    .bind(z)
    .bind(yaw)
    .bind(id)
    .bind(uid)
    .execute(pool)
    .await?;
    if r.rows_affected() == 0 {
        return Err(Refuse::say(StatusCode::NOT_FOUND, "no such vehicle"));
    }
    Ok(())
}

async fn get_mine(State(st): State<crate::AppState>, req: Request) -> Response {
    let c = cities::caller(&req);
    match mine(&st.pool, &c.user_id).await {
        Ok(v) => Json(json!({"vehicles": v, "max": MAX_OWNED})).into_response(),
        Err(e) => Refuse::Db(e).response(),
    }
}

async fn post_buy(State(st): State<crate::AppState>, req: Request) -> Response {
    let c = cities::caller(&req);
    let bytes = match cities::read_body(req).await {
        Ok(b) => b,
        Err(r) => return r.response(),
    };
    let (vid, paint) = match parse_buy(&bytes) {
        Ok(v) => v,
        Err(m) => return crate::err(StatusCode::UNPROCESSABLE_ENTITY, &m),
    };
    match buy(&st.pool, &c.user_id, &vid, paint, cities::now_secs()).await {
        Ok((v, coins)) => Json(json!({"ok": true, "vehicle": v, "coins": coins})).into_response(),
        Err(r) => r.response(),
    }
}

async fn post_park(State(st): State<crate::AppState>, Path(id): Path<String>, req: Request) -> Response {
    let c = cities::caller(&req);
    if !cities::is_uuid(&id) {
        return crate::err(StatusCode::NOT_FOUND, "no such vehicle");
    }
    let bytes = match cities::read_body(req).await {
        Ok(b) => b,
        Err(r) => return r.response(),
    };
    let spot = match parse_park(&bytes) {
        Ok(v) => v,
        Err(m) => return crate::err(StatusCode::UNPROCESSABLE_ENTITY, &m),
    };
    match park(&st.pool, &c.user_id, &id, &spot).await {
        Ok(()) => Json(json!({"ok": true})).into_response(),
        Err(r) => r.response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    const A: &str = "aaaaaaaa-0000-4000-8000-000000000001";
    const B: &str = "bbbbbbbb-0000-4000-8000-000000000002";
    const NOW: i64 = 1_792_411_200;

    async fn pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new().max_connections(1).connect("sqlite::memory:").await.unwrap();
        crate::db::migrate(&pool).await.unwrap();
        for (i, id) in [A, B].iter().enumerate() {
            sqlx::query(
                "INSERT INTO users (id, github_id, handle, display_name, avatar_url, trainer_name, is_active, created_at)
                 VALUES (?1, ?2, ?3, '', '', '', 1, datetime('now'))",
            )
            .bind(id)
            .bind(i as i64 + 1)
            .bind(format!("h{i}"))
            .execute(&pool)
            .await
            .unwrap();
        }
        pool
    }

    /// n prompts of XP (10 XP each).
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

    async fn coins(p: &SqlitePool, uid: &str, n: i64) {
        sqlx::query("INSERT OR REPLACE INTO poke_balances (id, user_id, item, qty) VALUES (?1, ?2, 'coins', ?3)")
            .bind(uuid::Uuid::new_v4().to_string())
            .bind(uid)
            .bind(n)
            .execute(p)
            .await
            .unwrap();
    }

    async fn balance(p: &SqlitePool, uid: &str) -> i64 {
        sqlx::query_scalar("SELECT qty FROM poke_balances WHERE user_id = ?1 AND item = 'coins'")
            .bind(uid)
            .fetch_optional(p)
            .await
            .unwrap()
            .unwrap_or(0)
    }

    fn code<T>(r: Result<T, Refuse>) -> StatusCode {
        match r {
            Err(Refuse::Say(c, _)) => c,
            Err(Refuse::Db(e)) => panic!("db error {e}"),
            Ok(_) => StatusCode::OK,
        }
    }

    /// Two classes: one sold at 1000 coins from level 1, one at 5000 from level 10.
    const FIXTURE: &str = r#"{"classes": [
        {"id": "bike.naked.400", "minLevel": 1}, {"id": "bike.naked.950", "minLevel": 10}, {"id": "car.sedan.5000", "minLevel": 1}],
      "vehicles": [
        {"id": "small-a", "class": "bike.naked.400", "slot": 1, "price": 1000, "paints": [{}, {}, {}, {}]},
        {"id": "small-b", "class": "bike.naked.400", "slot": 2, "price": 900, "paints": [{}]},
        {"id": "mid-a", "class": "bike.naked.950", "slot": 1, "price": 5000, "paints": [{}]},
        {"id": "mid-b", "class": "bike.naked.950", "slot": 2, "price": 4000, "paints": [{}]},
        {"id": "lonely", "class": "car.sedan.5000", "slot": 1, "price": 100, "paints": [{}]},
        {"id": "p1", "class": "car.suv.5000", "slot": 1, "price": 0, "paints": [{}]},
        {"id": "p2", "class": "car.suv.5000", "slot": 2, "price": 0, "paints": [{}]},
        {"id": "p3", "class": "car.suv.5000", "slot": 3, "price": 0, "paints": [{}]},
        {"id": "p4", "class": "car.suv.5000", "slot": 4, "price": 0, "paints": [{}]},
        {"id": "p5", "class": "car.suv.5000", "slot": 5, "price": 0, "paints": [{}]},
        {"id": "spare", "class": "bike.naked.400", "slot": "reserve", "price": 100, "paints": [{}]},
        {"id": "starter-x", "class": "starter", "slot": "starter", "price": 0, "paints": [{}]}]}"#;

    #[test]
    fn the_catalogue_sells_classes_of_one_to_four() {
        let c = parse_catalogue(FIXTURE);
        assert!(c["small-a"].on_sale);
        assert_eq!((c["small-a"].price, c["small-a"].min_level, c["small-a"].class.as_str()), (1000, 1, "bike.naked.400"));
        assert!(!c["starter-x"].on_sale, "starters are in every garage, not sold");
        assert!(!c["spare"].on_sale, "a reserve waits for a slot");
        assert!(c["lonely"].on_sale, "a class listing one vehicle is on sale (3.9)");
        assert!(["p1", "p2", "p3", "p4"].iter().all(|k| c[*k].on_sale), "slots 1 to 4 are listed");
        assert!(!c["p5"].on_sale, "there is no slot 5");
        assert_eq!(c["mid-a"].min_level, 10);
    }

    #[test]
    fn everything_is_free_and_unlocked_for_now() {
        let c = &*CATALOGUE;
        assert!(c.values().filter(|m| m.on_sale).count() >= 20);
        for (id, m) in c.iter().filter(|(_, m)| m.on_sale) {
            assert_eq!((m.price, m.min_level), (0, 0), "{id}: free for all for now");
            assert!(m.paints > 0, "{id}");
        }
        assert!(!c["bugatti-veyron"].on_sale && !c["starter-car"].on_sale);
    }

    #[test]
    fn bodies_are_strict() {
        assert_eq!(parse_buy(br#"{"vehicle_id":"ktm-390-duke","paint":2}"#), Ok(("ktm-390-duke".into(), 2)));
        assert_eq!(parse_buy(br#"{"vehicle_id":"ktm-390-duke"}"#), Ok(("ktm-390-duke".into(), 0)));
        assert!(parse_buy(br#"{"vehicle_id":"KTM 390"}"#).is_err());
        assert!(parse_buy(br#"{"vehicle_id":"ktm-390-duke","price":0}"#).is_err(), "the client never sets a price");
        assert!(parse_buy(br#"{"vehicle_id":"ktm-390-duke","paint":-1}"#).is_err());
        assert!(parse_park(br#"{"world":"claude-hq@2","x":1.5,"z":-3,"yaw":7}"#).is_ok());
        assert!(parse_park(br#"{"world":"../etc","x":1,"z":1,"yaw":0}"#).is_err());
        assert!(parse_park(br#"{"world":"claude-hq@2","x":1e9,"z":1,"yaw":0}"#).is_err());
        assert!(parse_park(br#"{"world":"claude-hq@2","x":1,"z":1}"#).is_err());
        assert_eq!(parse_park(br#"{"garage":true}"#), Ok(Spot::Garage));
        assert!(parse_park(br#"{"garage":false}"#).is_err());
        assert!(parse_park(br#"{"garage":true,"x":1}"#).is_err());
    }

    #[tokio::test]
    async fn claiming_a_free_vehicle_needs_no_coins() {
        let p = pool().await;
        let (v, left) = buy(&p, A, "bugatti-chiron-super-sport", 1, NOW).await.unwrap_or_else(|_| panic!("claims"));
        assert_eq!((v["vehicle_id"].as_str(), v["paint"].as_i64(), left), (Some("bugatti-chiron-super-sport"), Some(1), 0));
        assert_eq!(code(buy(&p, A, "bugatti-veyron", 0, NOW).await), StatusCode::CONFLICT);
        assert_eq!(code(buy(&p, A, "starter-car", 0, NOW).await), StatusCode::CONFLICT);
        assert_eq!(code(buy(&p, A, "nope", 0, NOW).await), StatusCode::NOT_FOUND);
        assert_eq!(code(buy(&p, A, "bmw-m2", 99, NOW).await), StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(mine(&p, A).await.unwrap().len(), 1);
        assert!(mine(&p, B).await.unwrap().is_empty(), "nobody else's garage changed");
    }

    #[tokio::test]
    async fn priced_and_gated_classes_check_level_and_coins_then_pay() {
        let c = parse_catalogue(FIXTURE);
        let p = pool().await;
        // no coins: 402, nothing owned, nothing charged
        assert_eq!(code(buy_in(&c, &p, A, "small-a", 0, NOW).await), StatusCode::PAYMENT_REQUIRED);
        coins(&p, A, 1500).await;
        assert_eq!(code(buy_in(&c, &p, A, "small-a", 9, NOW).await), StatusCode::UNPROCESSABLE_ENTITY);
        let (v, left) = buy_in(&c, &p, A, "small-a", 1, NOW).await.unwrap_or_else(|_| panic!("buys"));
        assert_eq!((v["vehicle_id"].as_str(), v["paint"].as_i64(), left), (Some("small-a"), Some(1), 500));
        assert_eq!(balance(&p, A).await, 500);
        // a level-10 class at level 1: 403, and the coins stay
        coins(&p, A, 100_000).await;
        assert_eq!(code(buy_in(&c, &p, A, "mid-a", 0, NOW).await), StatusCode::FORBIDDEN);
        assert_eq!(balance(&p, A).await, 100_000);
        prompts(&p, A, 900).await; // 9,000 XP: level 10
        assert_eq!(code(buy_in(&c, &p, A, "mid-a", 0, NOW).await), StatusCode::OK);
        assert_eq!(balance(&p, A).await, 95_000);
        assert_eq!(mine(&p, A).await.unwrap().len(), 2);
    }

    #[tokio::test]
    async fn the_same_vehicle_twice_and_the_garage_cap() {
        let c = parse_catalogue(FIXTURE);
        let p = pool().await;
        coins(&p, A, 1_000_000).await;
        for i in 0..MAX_OWNED {
            assert_eq!(code(buy_in(&c, &p, A, "small-a", i % 4, NOW).await), StatusCode::OK, "#{i}");
        }
        assert_eq!(code(buy_in(&c, &p, A, "small-a", 0, NOW).await), StatusCode::CONFLICT, "garage full");
        assert_eq!(balance(&p, A).await, 1_000_000 - 1000 * MAX_OWNED);
    }

    #[tokio::test]
    async fn only_the_owner_parks_it() {
        let p = pool().await;
        let (v, _) = buy(&p, A, "bmw-g-310-r", 0, NOW).await.unwrap_or_else(|_| panic!("buys"));
        let id = v["id"].as_str().unwrap();
        assert_eq!(mine(&p, A).await.unwrap()[0]["parked"], Value::Null, "a new vehicle is in its garage");
        let out = Spot::Out("claude-hq@2".into(), 1.0, 2.0, 0.5);
        assert_eq!(code(park(&p, B, id, &out).await), StatusCode::NOT_FOUND);
        park(&p, A, id, &out).await.unwrap_or_else(|_| panic!("parks"));
        assert_eq!(mine(&p, A).await.unwrap()[0]["parked"], json!({"world": "claude-hq@2", "x": 1.0, "z": 2.0, "yaw": 0.5}));
        park(&p, A, id, &Spot::Garage).await.unwrap_or_else(|_| panic!("goes home"));
        assert_eq!(mine(&p, A).await.unwrap()[0]["parked"], Value::Null, "back in the garage");
    }
}
