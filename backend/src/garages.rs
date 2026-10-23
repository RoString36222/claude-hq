//! Garages (HQ 3.4, Basement Garage): which garage each owned vehicle calls home.
//!
//!   GET  /v1/garages/mine               -> {homes: {<id>: {home, bay}}, basement: {max, used, level, next_at, cap},
//!                                           tuning: {<id>: tuning}}   (HQ 3.13: tuned vehicles only, tuning.rs)
//!   POST /v1/vehicles/:id/home {home, bay?} -> {ok, home: {home, bay}, basement: {max, used, level, next_at, cap}}
//!
//! Every owned vehicle lives either in its owner's private basement garage (B1,
//! under their HQ, in a numbered bay) or in the city's common multi-storey carpark.
//! A vehicle with no `vehicle_homes` row lives in the carpark (every vehicle bought
//! before 3.4 does). Starter vehicles are never server rows and never transfer.
//!
//! The basement grows with the owner's HQ level (cosmetics::hq_level, the level the
//! Trainer card shows): [`basement_max`] bays, 4 at level 0, one more every 5
//! levels, at most [`BASEMENT_CAP`]. A bay already given stays given if the cap is
//! ever lower than it (levels only go up, but the formula may change).
//!
//! Moving a vehicle home (either garage) also brings it in from the street: its
//! `parked_*` columns are cleared in the same transaction, so a transfer is what
//! the valet does with a vehicle left out on a trip.
//!
//! Errors: 422 a bad body (unknown field, bad home, bay outside 0..11, a bay for the
//! carpark); 404 an unknown vehicle, not yours, or a non-uuid id; 403 a caller with
//! no linked user; 409 "basement full" or "bay taken" (also a bay at or past max).
//!
//! PRIVACY: owned-vehicle ids, garage names, bay numbers and a level only.

use axum::{
    extract::{Path, Request, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde_json::{json, Map, Value};
use sqlx::{Row, SqlitePool};

use crate::cities::{self, Refuse};

/// Most bays a basement ever has (the CHECK on vehicle_homes.bay agrees).
pub const BASEMENT_CAP: i64 = 12;
/// Bays every basement starts with.
pub const BASEMENT_BASE: i64 = 4;
/// Levels per extra bay.
pub const LEVELS_PER_BAY: i64 = 5;

/// Bays an HQ at `level` has: min(12, 4 + floor(level / 5)).
pub fn basement_max(level: i64) -> i64 {
    (BASEMENT_BASE + level.max(0) / LEVELS_PER_BAY).min(BASEMENT_CAP)
}

/// The level the next bay unlocks at, or None at the cap.
pub fn next_bay_at(level: i64) -> Option<i64> {
    let max = basement_max(level);
    (max < BASEMENT_CAP).then(|| (max - BASEMENT_BASE + 1) * LEVELS_PER_BAY)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Home {
    Basement,
    Carpark,
}

impl Home {
    fn as_str(self) -> &'static str {
        match self {
            Home::Basement => "basement",
            Home::Carpark => "carpark",
        }
    }
}

/// `{home, bay?}` from a home body: strict (unknown key, bad home, bay outside
/// 0..11 or a bay for the carpark are errors; `bay: null` means "any").
pub(crate) fn parse_home(bytes: &[u8]) -> Result<(Home, Option<i64>), String> {
    let Ok(Value::Object(o)) = serde_json::from_slice::<Value>(bytes) else {
        return Err("body must be a JSON object".into());
    };
    parse_home_obj(&o)
}

fn parse_home_obj(o: &Map<String, Value>) -> Result<(Home, Option<i64>), String> {
    if let Some(k) = o.keys().find(|k| !matches!(k.as_str(), "home" | "bay")) {
        return Err(format!("unknown field {k:?}"));
    }
    let home = match o.get("home").and_then(Value::as_str) {
        Some("basement") => Home::Basement,
        Some("carpark") => Home::Carpark,
        _ => return Err("home must be basement or carpark".into()),
    };
    let bay = match o.get("bay") {
        None | Some(Value::Null) => None,
        Some(b) => Some(
            b.as_i64()
                .filter(|n| (0..BASEMENT_CAP).contains(n))
                .ok_or_else(|| format!("bay must be an integer from 0 to {}", BASEMENT_CAP - 1))?,
        ),
    };
    if home == Home::Carpark && bay.is_some() {
        return Err("only the basement has numbered bays".into());
    }
    Ok((home, bay))
}

fn basement_json(level: i64, used: i64) -> Value {
    json!({"max": basement_max(level), "used": used, "level": level.max(0),
           "next_at": next_bay_at(level), "cap": BASEMENT_CAP})
}

async fn used_in(conn: &mut sqlx::SqliteConnection, uid: &str) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar("SELECT COUNT(*) FROM vehicle_homes WHERE user_id = ?1 AND home = 'basement'")
        .bind(uid)
        .fetch_one(conn)
        .await
}

/// Every vehicle `uid` owns and its home (carpark/null when it has no row), with
/// the basement's size at `level`.
pub(crate) async fn mine(pool: &SqlitePool, uid: &str, level: i64) -> Result<Value, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT v.id AS id, COALESCE(h.home, 'carpark') AS home, h.bay AS bay
         FROM owned_vehicles v LEFT JOIN vehicle_homes h ON h.vehicle_id = v.id AND h.user_id = v.user_id
         WHERE v.user_id = ?1 ORDER BY v.bought_at, v.id",
    )
    .bind(uid)
    .fetch_all(pool)
    .await?;
    let mut homes = Map::new();
    let mut used = 0;
    for r in &rows {
        let home: String = r.get("home");
        let bay: Option<i64> = if home == "basement" { r.get("bay") } else { None };
        used += i64::from(home == "basement");
        homes.insert(r.get("id"), json!({"home": home, "bay": bay}));
    }
    let tuning = crate::tuning::mine(pool, uid).await?;
    Ok(json!({"homes": homes, "basement": basement_json(level, used), "tuning": tuning}))
}

/// Move `uid`'s vehicle `id` to `home` (in `bay`, or its current bay, or the lowest
/// free one). `level` sets the basement's size. Returns the new home and the basement.
pub(crate) async fn set_home(
    pool: &SqlitePool,
    uid: &str,
    id: &str,
    home: Home,
    bay: Option<i64>,
    level: i64,
    now: i64,
) -> Result<Value, Refuse> {
    if uid.is_empty() {
        return Err(Refuse::say(StatusCode::FORBIDDEN, "link this device to an account first"));
    }
    if !cities::is_uuid(id) {
        return Err(Refuse::say(StatusCode::NOT_FOUND, "no such vehicle"));
    }
    let max = basement_max(level);
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let owned: Option<String> = sqlx::query_scalar("SELECT id FROM owned_vehicles WHERE id = ?1 AND user_id = ?2")
        .bind(id)
        .bind(uid)
        .fetch_optional(&mut *tx)
        .await?;
    if owned.is_none() {
        return Err(Refuse::say(StatusCode::NOT_FOUND, "no such vehicle"));
    }
    let current: Option<i64> = sqlx::query_scalar(
        "SELECT bay FROM vehicle_homes WHERE vehicle_id = ?1 AND user_id = ?2 AND home = 'basement'",
    )
    .bind(id)
    .bind(uid)
    .fetch_optional(&mut *tx)
    .await?
    .flatten();
    let new_bay = match home {
        Home::Carpark => None,
        Home::Basement => {
            if current.is_none() && used_in(&mut tx, uid).await? >= max {
                return Err(Refuse::say(StatusCode::CONFLICT, "basement full"));
            }
            let taken: Vec<i64> = sqlx::query_scalar(
                "SELECT bay FROM vehicle_homes WHERE user_id = ?1 AND home = 'basement' AND vehicle_id != ?2",
            )
            .bind(uid)
            .bind(id)
            .fetch_all(&mut *tx)
            .await?;
            Some(match (bay, current) {
                (Some(b), Some(c)) if b == c => c,
                (Some(b), _) if b >= max || taken.contains(&b) => {
                    return Err(Refuse::say(StatusCode::CONFLICT, "bay taken"));
                }
                (Some(b), _) => b,
                (None, Some(c)) => c,
                (None, None) => (0..max)
                    .find(|b| !taken.contains(b))
                    .ok_or_else(|| Refuse::say(StatusCode::CONFLICT, "basement full"))?,
            })
        }
    };
    sqlx::query(
        "INSERT INTO vehicle_homes (vehicle_id, user_id, home, bay, moved_at) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(vehicle_id) DO UPDATE SET home = excluded.home, bay = excluded.bay, moved_at = excluded.moved_at",
    )
    .bind(id)
    .bind(uid)
    .bind(home.as_str())
    .bind(new_bay)
    .bind(now)
    .execute(&mut *tx)
    .await?;
    // Storing a vehicle is what brings it home from the street.
    sqlx::query(
        "UPDATE owned_vehicles SET parked_world = NULL, parked_x = NULL, parked_z = NULL, parked_yaw = NULL
         WHERE id = ?1 AND user_id = ?2",
    )
    .bind(id)
    .bind(uid)
    .execute(&mut *tx)
    .await?;
    let used = used_in(&mut tx, uid).await?;
    tx.commit().await?;
    Ok(json!({"ok": true, "home": {"home": home.as_str(), "bay": new_bay}, "basement": basement_json(level, used)}))
}

pub fn routes() -> Router<crate::AppState> {
    Router::new()
        .route("/v1/garages/mine", get(get_mine))
        .route("/v1/vehicles/:id/home", post(post_home))
}

async fn get_mine(State(st): State<crate::AppState>, req: Request) -> Response {
    let c = cities::caller(&req);
    if c.user_id.is_empty() {
        return crate::err(StatusCode::FORBIDDEN, "link this device to an account first");
    }
    let level = match crate::cosmetics::hq_level(&st.pool, &c.user_id).await {
        Ok(l) => l,
        Err(e) => return Refuse::Db(e).response(),
    };
    match mine(&st.pool, &c.user_id, level).await {
        Ok(v) => Json(v).into_response(),
        Err(e) => Refuse::Db(e).response(),
    }
}

async fn post_home(State(st): State<crate::AppState>, Path(id): Path<String>, req: Request) -> Response {
    let c = cities::caller(&req);
    if c.user_id.is_empty() {
        return crate::err(StatusCode::FORBIDDEN, "link this device to an account first");
    }
    if !cities::is_uuid(&id) {
        return crate::err(StatusCode::NOT_FOUND, "no such vehicle");
    }
    let bytes = match cities::read_body(req).await {
        Ok(b) => b,
        Err(r) => return r.response(),
    };
    let (home, bay) = match parse_home(&bytes) {
        Ok(v) => v,
        Err(m) => return crate::err(StatusCode::UNPROCESSABLE_ENTITY, &m),
    };
    // The level walk reads the pool: done before BEGIN IMMEDIATE takes the writer.
    let level = match crate::cosmetics::hq_level(&st.pool, &c.user_id).await {
        Ok(l) => l,
        Err(e) => return Refuse::Db(e).response(),
    };
    match set_home(&st.pool, &c.user_id, &id, home, bay, level, cities::now_secs()).await {
        Ok(v) => Json(v).into_response(),
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

    async fn own(p: &SqlitePool, uid: &str, n: usize) -> Vec<String> {
        let mut ids = Vec::new();
        for i in 0..n {
            let (v, _) = crate::vehicles::buy(p, uid, "bmw-g-310-r", 0, NOW + i as i64)
                .await
                .unwrap_or_else(|_| panic!("claims #{i}"));
            ids.push(v["id"].as_str().unwrap().to_string());
        }
        ids
    }

    fn code(r: &Result<Value, Refuse>) -> StatusCode {
        match r {
            Err(Refuse::Say(c, _)) => *c,
            Err(Refuse::Db(e)) => panic!("db error {e}"),
            Ok(_) => StatusCode::OK,
        }
    }

    fn msg(r: &Result<Value, Refuse>) -> &str {
        match r {
            Err(Refuse::Say(_, m)) => m,
            _ => "",
        }
    }

    #[test]
    fn the_basement_grows_with_level_up_to_twelve() {
        assert_eq!(basement_max(0), 4);
        assert_eq!(basement_max(-3), 4, "a nonsense level is level 0");
        assert_eq!(basement_max(4), 4);
        assert_eq!(basement_max(5), 5);
        assert_eq!(basement_max(19), 7);
        assert_eq!(basement_max(40), 12);
        assert_eq!(basement_max(10_000), BASEMENT_CAP);
        assert_eq!(next_bay_at(0), Some(5));
        assert_eq!(next_bay_at(7), Some(10));
        assert_eq!(next_bay_at(40), None);
        for l in 0..60 {
            assert!(basement_max(l) <= basement_max(l + 1), "never shrinks");
            if let Some(n) = next_bay_at(l) {
                assert!(n > l && basement_max(n) == basement_max(l) + 1 && basement_max(n - 1) == basement_max(l));
            }
        }
    }

    #[test]
    fn home_bodies_are_strict() {
        assert_eq!(parse_home(br#"{"home":"basement"}"#), Ok((Home::Basement, None)));
        assert_eq!(parse_home(br#"{"home":"basement","bay":11}"#), Ok((Home::Basement, Some(11))));
        assert_eq!(parse_home(br#"{"home":"basement","bay":null}"#), Ok((Home::Basement, None)));
        assert_eq!(parse_home(br#"{"home":"carpark"}"#), Ok((Home::Carpark, None)));
        for bad in [
            &br#"{"home":"basement","owner":"x"}"#[..],
            br#"{"home":"garage"}"#,
            br#"{"home":"BASEMENT"}"#,
            br#"{}"#,
            br#"{"home":"basement","bay":12}"#,
            br#"{"home":"basement","bay":-1}"#,
            br#"{"home":"basement","bay":1.5}"#,
            br#"{"home":"basement","bay":"3"}"#,
            br#"{"home":"carpark","bay":2}"#,
            br#"["home","basement"]"#,
            b"not json",
        ] {
            assert!(parse_home(bad).is_err(), "{}", String::from_utf8_lossy(bad));
        }
    }

    #[tokio::test]
    async fn no_row_is_the_carpark_and_mine_lists_every_vehicle() {
        let p = pool().await;
        let ids = own(&p, A, 3).await;
        own(&p, B, 1).await;
        let m = mine(&p, A, 0).await.unwrap();
        let homes = m["homes"].as_object().unwrap();
        assert_eq!(homes.len(), 3, "A's vehicles only");
        for id in &ids {
            assert_eq!(homes[id], json!({"home": "carpark", "bay": null}));
        }
        assert_eq!(m["basement"], json!({"max": 4, "used": 0, "level": 0, "next_at": 5, "cap": 12}));
        assert_eq!(mine(&p, B, 0).await.unwrap()["homes"].as_object().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn the_basement_fills_lowest_bay_first_then_409s() {
        let p = pool().await;
        let ids = own(&p, A, 6).await;
        // an explicit bay first, then the lowest free ones around it
        let r = set_home(&p, A, &ids[0], Home::Basement, Some(2), 0, NOW).await;
        assert_eq!(r.as_ref().unwrap()["home"], json!({"home": "basement", "bay": 2}));
        let mut bays = Vec::new();
        for id in &ids[1..4] {
            bays.push(set_home(&p, A, id, Home::Basement, None, 0, NOW).await.unwrap()["home"]["bay"].as_i64().unwrap());
        }
        assert_eq!(bays, vec![0, 1, 3]);
        let full = set_home(&p, A, &ids[4], Home::Basement, None, 0, NOW).await;
        assert_eq!((code(&full), msg(&full)), (StatusCode::CONFLICT, "basement full"));
        // level 5: a fifth bay; a taken bay and one past max are refused
        let taken = set_home(&p, A, &ids[4], Home::Basement, Some(1), 5, NOW).await;
        assert_eq!((code(&taken), msg(&taken)), (StatusCode::CONFLICT, "bay taken"));
        let past = set_home(&p, A, &ids[4], Home::Basement, Some(7), 5, NOW).await;
        assert_eq!((code(&past), msg(&past)), (StatusCode::CONFLICT, "bay taken"));
        let ok = set_home(&p, A, &ids[4], Home::Basement, None, 5, NOW).await.unwrap();
        assert_eq!(ok["home"]["bay"], 4);
        assert_eq!(ok["basement"]["used"], 5);
        // re-storing keeps the bay; moving within the basement to a free bay works
        assert_eq!(set_home(&p, A, &ids[0], Home::Basement, None, 5, NOW).await.unwrap()["home"]["bay"], 2);
        assert_eq!(set_home(&p, A, &ids[0], Home::Basement, Some(2), 5, NOW).await.unwrap()["home"]["bay"], 2);
        // out to the carpark frees bay 2 for the next one in
        let out = set_home(&p, A, &ids[0], Home::Carpark, None, 5, NOW).await.unwrap();
        assert_eq!((out["home"].clone(), out["basement"]["used"].clone()), (json!({"home": "carpark", "bay": null}), json!(4)));
        assert_eq!(set_home(&p, A, &ids[5], Home::Basement, None, 5, NOW).await.unwrap()["home"]["bay"], 2);
        // a resident moves to another free bay after a level-up
        assert_eq!(set_home(&p, A, &ids[5], Home::Basement, Some(5), 10, NOW).await.unwrap()["home"]["bay"], 5);
        let m = mine(&p, A, 10).await.unwrap();
        assert_eq!(m["homes"][&ids[0]], json!({"home": "carpark", "bay": null}));
        assert_eq!(m["basement"]["used"], 5);
        assert_eq!(m["basement"]["max"], 6);
    }

    #[tokio::test]
    async fn only_the_owner_moves_it() {
        let p = pool().await;
        let ids = own(&p, A, 1).await;
        let r = set_home(&p, B, &ids[0], Home::Basement, None, 0, NOW).await;
        assert_eq!(code(&r), StatusCode::NOT_FOUND);
        assert_eq!(code(&set_home(&p, A, "../etc", Home::Basement, None, 0, NOW).await), StatusCode::NOT_FOUND);
        assert_eq!(code(&set_home(&p, A, "AAAAAAAA-0000-4000-8000-000000000001", Home::Carpark, None, 0, NOW).await), StatusCode::NOT_FOUND);
        assert_eq!(code(&set_home(&p, "", &ids[0], Home::Basement, None, 0, NOW).await), StatusCode::FORBIDDEN);
        assert_eq!(mine(&p, A, 0).await.unwrap()["homes"][&ids[0]]["home"], "carpark", "nothing moved");
        let none: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM vehicle_homes").fetch_one(&p).await.unwrap();
        assert_eq!(none, 0);
    }

    #[tokio::test]
    async fn bays_are_per_owner() {
        let p = pool().await;
        let a = own(&p, A, 1).await;
        let b = own(&p, B, 1).await;
        assert_eq!(set_home(&p, A, &a[0], Home::Basement, Some(0), 0, NOW).await.unwrap()["home"]["bay"], 0);
        assert_eq!(set_home(&p, B, &b[0], Home::Basement, Some(0), 0, NOW).await.unwrap()["home"]["bay"], 0);
    }

    #[tokio::test]
    async fn going_home_clears_parked_and_delete_cascades() {
        let p = pool().await;
        let ids = own(&p, A, 2).await;
        let out = crate::vehicles::Spot::Out("claude-hq@2".into(), 10.0, -4.0, 1.0);
        for id in &ids {
            crate::vehicles::park(&p, A, id, &out).await.unwrap_or_else(|_| panic!("parks"));
        }
        set_home(&p, A, &ids[0], Home::Basement, None, 0, NOW).await.unwrap();
        set_home(&p, A, &ids[1], Home::Carpark, None, 0, NOW).await.unwrap();
        for v in crate::vehicles::mine(&p, A).await.unwrap() {
            assert_eq!(v["parked"], Value::Null, "{}", v["id"]);
        }
        sqlx::query("DELETE FROM owned_vehicles WHERE id = ?1").bind(&ids[0]).execute(&p).await.unwrap();
        let left: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM vehicle_homes").fetch_one(&p).await.unwrap();
        assert_eq!(left, 1, "the deleted vehicle's home went with it");
        sqlx::query("DELETE FROM users WHERE id = ?1").bind(A).execute(&p).await.unwrap();
        let left: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM vehicle_homes").fetch_one(&p).await.unwrap();
        assert_eq!(left, 0, "and a deleted user's homes");
    }

    #[tokio::test]
    async fn the_schema_backs_the_rules() {
        let p = pool().await;
        let ids = own(&p, A, 2).await;
        let ins = |id: &str, home: &str, bay: Option<i64>| {
            sqlx::query("INSERT INTO vehicle_homes (vehicle_id, user_id, home, bay, moved_at) VALUES (?1, ?2, ?3, ?4, 0)")
                .bind(id.to_string())
                .bind(A)
                .bind(home.to_string())
                .bind(bay)
        };
        assert!(ins(&ids[0], "basement", Some(12)).execute(&p).await.is_err(), "bay < 12");
        assert!(ins(&ids[0], "attic", None).execute(&p).await.is_err(), "home CHECK");
        assert!(ins(&ids[0], "basement", None).execute(&p).await.is_err(), "basement needs a bay");
        assert!(ins(&ids[0], "carpark", Some(1)).execute(&p).await.is_err(), "carpark has none");
        ins(&ids[0], "basement", Some(3)).execute(&p).await.unwrap();
        assert!(ins(&ids[1], "basement", Some(3)).execute(&p).await.is_err(), "one vehicle per bay");
    }
}
