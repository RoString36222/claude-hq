use super::*;
use sqlx::sqlite::SqlitePoolOptions;

const A: &str = "aaaaaaaa-0000-4000-8000-0000000000a1"; // open HQ
const B: &str = "bbbbbbbb-0000-4000-8000-0000000000b2"; // closed HQ
const C: &str = "cccccccc-0000-4000-8000-0000000000c3"; // open HQ, disabled account
const D: &str = "dddddddd-0000-4000-8000-0000000000d4"; // no HQ row

fn spot(lot: u32, x: i32, z: i32, r: u8) -> GarageSpot {
    GarageSpot { lot, x, z, r }
}

fn no(j: Value) -> String {
    validate(&j).expect_err(&format!("accepted {j}"))
}

#[test]
fn good_spots_and_the_range_edges() {
    assert_eq!(validate(&json!({"lot": 3, "x": -12, "z": 40, "r": 1})), Ok(spot(3, -12, 40, 1)));
    assert_eq!(validate(&json!({"r": 3, "z": -300, "x": 400, "lot": 0})), Ok(spot(0, 400, -300, 3)));
    assert_eq!(validate(&json!({"lot": 4294967295u64, "x": -400, "z": 300, "r": 0})), Ok(spot(u32::MAX, -400, 300, 0)));
    // key order out is the wire's: lot, x, z, r
    assert_eq!(serde_json::to_string(&spot(7, 1, 2, 3)).unwrap(), r#"{"lot":7,"x":1,"z":2,"r":3}"#);
}

#[test]
fn strict_rejections() {
    // shape
    assert!(no(json!(null)).contains("must be an object"));
    no(json!([3, 0, 0, 0]));
    no(json!("3,0,0,0"));
    // unknown and missing keys
    assert!(no(json!({"lot": 3, "x": 0, "z": 0, "r": 0, "y": 0})).contains("unknown key"));
    assert!(no(json!({"lot": 3, "x": 0, "z": 0, "r": 0, "name": "hi"})).contains("unknown key"));
    assert!(no(json!({"lot": 3, "x": 0, "z": 0})).contains("garage.r: required"));
    no(json!({}));
    // ranges
    assert!(no(json!({"lot": 3, "x": 0, "z": 0, "r": 4})).contains("garage.r: out of range"));
    no(json!({"lot": 3, "x": 0, "z": 0, "r": -1}));
    no(json!({"lot": 3, "x": 401, "z": 0, "r": 0}));
    no(json!({"lot": 3, "x": -401, "z": 0, "r": 0}));
    no(json!({"lot": 3, "x": 0, "z": 301, "r": 0}));
    no(json!({"lot": 3, "x": 0, "z": -301, "r": 0}));
    no(json!({"lot": -1, "x": 0, "z": 0, "r": 0}));
    no(json!({"lot": 4294967296u64, "x": 0, "z": 0, "r": 0}));
    assert!(no(json!({"lot": u64::MAX, "x": 0, "z": 0, "r": 0})).contains("out of range"));
    // not integers
    assert!(no(json!({"lot": 3, "x": 1.5, "z": 0, "r": 0})).contains("garage.x: must be an integer"));
    no(json!({"lot": 3, "x": 1.0, "z": 0, "r": 0}));
    no(json!({"lot": "3", "x": 0, "z": 0, "r": 0}));
    no(json!({"lot": 3, "x": 0, "z": null, "r": 0}));
    no(json!({"lot": 3, "x": 0, "z": 0, "r": true}));
    // the wire
    assert!(parse_put(b"not json").is_err());
    assert_eq!(parse_put(br#"{"lot":1,"x":2,"z":3,"r":0}"#), Ok(spot(1, 2, 3, 0)));
}

#[test]
fn saves_are_rate_limited_per_user() {
    let t = Instant::now();
    let u = "garage-rate-test-user";
    for _ in 0..SAVE_BURST {
        assert!(save_allowed(u, t));
    }
    assert!(!save_allowed(u, t));
    assert!(save_allowed("garage-rate-test-other", t));
    assert!(save_allowed(u, t + SAVE_WINDOW));
}

// --- the database ---------------------------------------------------------

async fn pool() -> SqlitePool {
    let pool = SqlitePoolOptions::new().max_connections(1).connect("sqlite::memory:").await.unwrap();
    crate::db::migrate(&pool).await.unwrap();
    for (i, (id, active, open)) in [(A, 1, Some(1)), (B, 1, Some(0)), (C, 0, Some(1)), (D, 1, None)].iter().enumerate() {
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
        if let Some(o) = open {
            sqlx::query("INSERT INTO hq_profiles (user_id, open, look, crew) VALUES (?1, ?2, '{}', '{}')")
                .bind(id)
                .bind(o)
                .execute(&pool)
                .await
                .unwrap();
        }
    }
    pool
}

#[tokio::test]
async fn the_migration_creates_the_table() {
    let p = pool().await;
    let cols: Vec<String> = sqlx::query_scalar("SELECT name FROM pragma_table_info('hq_garage')")
        .fetch_all(&p)
        .await
        .unwrap();
    assert_eq!(cols, ["user_id", "lot", "x", "z", "r", "updated_at"]);
}

#[tokio::test]
async fn save_load_reset_and_many() {
    let p = pool().await;
    assert_eq!(load(&p, A).await.unwrap(), None);
    save(&p, A, Some(&spot(3, 10, -20, 1))).await.unwrap();
    save(&p, B, Some(&spot(4, 0, 0, 2))).await.unwrap();
    assert_eq!(load(&p, A).await.unwrap(), Some(spot(3, 10, -20, 1)));
    save(&p, A, Some(&spot(3, 11, -20, 1))).await.unwrap();
    assert_eq!(load(&p, A).await.unwrap(), Some(spot(3, 11, -20, 1)));
    assert_eq!(load(&p, B).await.unwrap(), Some(spot(4, 0, 0, 2)), "one user's save never touches another's");
    let ids: Vec<String> = [A, B, D].iter().map(|s| s.to_string()).collect();
    let m = load_many(&p, &ids).await.unwrap();
    assert_eq!((m.len(), m[A], m[B]), (2, spot(3, 11, -20, 1), spot(4, 0, 0, 2)));
    assert!(load_many(&p, &[]).await.unwrap().is_empty());
    save(&p, A, None).await.unwrap();
    assert_eq!(load(&p, A).await.unwrap(), None);
    // a stored row out of range reads as the default spot, not a 500
    sqlx::query("UPDATE hq_garage SET r = 9 WHERE user_id = ?1").bind(B).execute(&p).await.unwrap();
    assert_eq!(load(&p, B).await.unwrap(), None);
    assert!(load_many(&p, &ids).await.unwrap().is_empty());
}

#[tokio::test]
async fn an_unchanged_save_keeps_updated_at() {
    let p = pool().await;
    save(&p, A, Some(&spot(1, 2, 3, 0))).await.unwrap();
    sqlx::query("UPDATE hq_garage SET updated_at = '2000-01-01 00:00:00'").execute(&p).await.unwrap();
    save(&p, A, Some(&spot(1, 2, 3, 0))).await.unwrap();
    let at: String = sqlx::query_scalar("SELECT updated_at FROM hq_garage").fetch_one(&p).await.unwrap();
    assert_eq!(at, "2000-01-01 00:00:00");
    save(&p, A, Some(&spot(1, 2, 3, 1))).await.unwrap();
    let at: String = sqlx::query_scalar("SELECT updated_at FROM hq_garage").fetch_one(&p).await.unwrap();
    assert_ne!(at, "2000-01-01 00:00:00");
}

// --- over HTTP, behind the real device middleware -------------------------

async fn serve(pool: SqlitePool) -> String {
    use std::sync::{atomic::AtomicU64, Arc};
    let rooms = crate::rooms::RoomManager::new();
    let registry = crate::realtime::Registry::new(crate::realtime::MAX_TICKERS);
    let clock: crate::realtime::Clock = Arc::new(|| 1000.0);
    let rec = crate::results::Recorder::new(pool.clone());
    let st = crate::AppState {
        pool: pool.clone(),
        cfg: Arc::new(crate::config::Settings::from_env()),
        kart: crate::kart::KartHub::new(rooms.clone(), registry.clone(), clock.clone(), rec.clone()),
        plat: crate::platformer::PlatHub::new(rooms.clone(), registry.clone(), clock.clone(), rec.clone()),
        fps: crate::fps::FpsHub::new(rooms.clone(), registry.clone(), clock.clone(), rec.clone()),
        strike: crate::strike::StrikeHub::new(rooms.clone(), registry.clone(), clock.clone(), rec.clone()),
        rally: crate::rally::RallyHub::new(rooms.clone(), registry.clone(), clock.clone(), rec.clone()),
        valley: crate::valley::ValleyHub::new(
            rooms.clone(), registry, clock, crate::valley::system_wall(), crate::valley::entropy_dice(), rec, None,
        ),
        rooms,
        music: crate::music::MusicHub::default(),
        conn_seq: Arc::new(AtomicU64::new(1)),
    };
    let app = crate::hq::routes()
        .layer(axum::middleware::from_fn_with_state(st.clone(), crate::require_device))
        .with_state(st);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    format!("http://{addr}")
}

async fn device(p: &SqlitePool, user: &str) -> String {
    let token = format!("tok-{user}");
    sqlx::query("INSERT INTO devices (id, user_id, token_hash, label, created_at, revoked) VALUES (?1, ?2, ?3, 't', datetime('now'), 0)")
        .bind(uuid::Uuid::new_v4().to_string())
        .bind(user)
        .bind(crate::auth::hash_token(&token))
        .execute(p)
        .await
        .unwrap();
    token
}

#[tokio::test]
async fn the_routes_over_http() {
    let p = pool().await;
    let base = serve(p.clone()).await;
    let (ta, tb) = (device(&p, A).await, device(&p, B).await);
    let c = reqwest::Client::new();
    let url = format!("{base}/v1/hq/me/garage");
    let get = |path: &str, tok: Option<&str>| {
        let mut r = c.get(format!("{base}{path}"));
        if let Some(t) = tok {
            r = r.bearer_auth(t);
        }
        r.send()
    };
    let put = |tok: &str, body: Value| c.put(&url).bearer_auth(tok.to_string()).json(&body).send();

    // no device (or an unknown one): 401 on all three, nothing stored
    assert_eq!(get("/v1/hq/me/garage", None).await.unwrap().status(), 401);
    assert_eq!(c.put(&url).json(&json!({"lot": 1, "x": 0, "z": 0, "r": 0})).send().await.unwrap().status(), 401);
    assert_eq!(c.delete(&url).send().await.unwrap().status(), 401);
    assert_eq!(put("tok-nobody", json!({"lot": 1, "x": 0, "z": 0, "r": 0})).await.unwrap().status(), 401);
    assert_eq!(load(&p, A).await.unwrap(), None);

    // nothing yet
    let r: Value = get("/v1/hq/me/garage", Some(&ta)).await.unwrap().json().await.unwrap();
    assert_eq!(r, json!({"garage": null}));

    // PUT stores and answers the stored spot; GET reads it back
    let r = put(&ta, json!({"lot": 5, "x": -120, "z": 75, "r": 3})).await.unwrap();
    assert_eq!(r.status(), 200);
    let want = json!({"garage": {"lot": 5, "x": -120, "z": 75, "r": 3}});
    assert_eq!(r.json::<Value>().await.unwrap(), want);
    let r: Value = get("/v1/hq/me/garage", Some(&ta)).await.unwrap().json().await.unwrap();
    assert_eq!(r, want);
    assert_eq!(put(&tb, json!({"lot": 6, "x": 0, "z": 0, "r": 0})).await.unwrap().status(), 200);
    assert_eq!(load(&p, A).await.unwrap(), Some(spot(5, -120, 75, 3)), "B's PUT left A alone");

    // 422 {"detail": "..."}, and nothing stored
    for (body, has) in [
        (json!({"lot": 5, "x": 0, "z": 0, "r": 0, "y": 1}), "unknown key"),
        (json!({"lot": 5, "x": 401, "z": 0, "r": 0}), "garage.x: out of range"),
        (json!({"lot": 5, "x": 0, "z": -301, "r": 0}), "garage.z: out of range"),
        (json!({"lot": 5, "x": 0.5, "z": 0, "r": 0}), "garage.x: must be an integer"),
        (json!({"lot": 5, "x": 0, "z": "1", "r": 0}), "garage.z: must be an integer"),
        (json!({"lot": 5, "x": 0, "z": 0, "r": 4}), "garage.r: out of range"),
        (json!({"lot": -1, "x": 0, "z": 0, "r": 0}), "garage.lot: out of range"),
        (json!({"lot": 5, "x": 0, "z": 0}), "garage.r: required"),
        (json!(null), "must be an object"),
    ] {
        let r = put(&ta, body.clone()).await.unwrap();
        assert_eq!(r.status(), 422, "{body}");
        let d: Value = r.json().await.unwrap();
        assert!(d["detail"].as_str().unwrap().contains(has), "{body}: {d}");
    }
    let r = c.put(&url).bearer_auth(&ta).body("lot=5").send().await.unwrap();
    assert_eq!(r.status(), 422);
    let r = c.put(&url).bearer_auth(&ta).body(vec![b' '; 4096]).send().await.unwrap();
    assert_eq!(r.status(), 413);
    assert_eq!(load(&p, A).await.unwrap(), Some(spot(5, -120, 75, 3)));
    // a wrong method is a 405
    assert_eq!(c.post(&url).bearer_auth(&ta).send().await.unwrap().status(), 405);

    // the HQ listing carries it last; the open list, a visit and /me
    let r: Value = get("/v1/hq/open", Some(&tb)).await.unwrap().json().await.unwrap();
    let hqs = r["hqs"].as_array().unwrap();
    assert_eq!(hqs.len(), 1, "only A is open and active");
    assert_eq!(hqs[0]["garage"], want["garage"]);
    let raw = get("/v1/hq/open", Some(&tb)).await.unwrap().text().await.unwrap();
    assert!(raw.contains(r#""cos":{},"garage":{"lot":5,"x":-120,"z":75,"r":3}}"#), "garage is the last key: {raw}");
    // ... and after style when both are set
    crate::hqstyle::save(&p, A, Some(&crate::hqstyle::normalize(&json!({"v": 1})).unwrap())).await.unwrap();
    let raw = get("/v1/hq/open", Some(&tb)).await.unwrap().text().await.unwrap();
    assert!(raw.contains(r#"}},"garage":{"lot":5,"x":-120,"z":75,"r":3}}"#), "after style: {raw}");
    assert!(raw.find(r#""style""#) < raw.find(r#""garage""#), "{raw}");
    let r: Value = get(&format!("/v1/hq/{A}"), Some(&tb)).await.unwrap().json().await.unwrap();
    assert_eq!(r["garage"], want["garage"]);
    let r: Value = get("/v1/hq/me", Some(&tb)).await.unwrap().json().await.unwrap();
    assert_eq!(r["garage"], json!({"lot": 6, "x": 0, "z": 0, "r": 0}));
    // a closed HQ's garage is not visitable; the route did not swallow /v1/hq/:user_id
    assert_eq!(get(&format!("/v1/hq/{B}"), Some(&ta)).await.unwrap().status(), 404);
    // a user with no garage has no key at all
    let r: Value = get("/v1/hq/me", Some(&device(&p, D).await)).await.unwrap().json().await.unwrap();
    assert!(r.get("garage").is_none(), "{r}");

    // DELETE: back to the default spot, and the key is gone from the listing
    let r = c.delete(&url).bearer_auth(&ta).send().await.unwrap();
    assert_eq!(r.status(), 200);
    assert_eq!(r.json::<Value>().await.unwrap(), json!({"garage": null}));
    let r: Value = get("/v1/hq/me/garage", Some(&ta)).await.unwrap().json().await.unwrap();
    assert_eq!(r, json!({"garage": null}));
    let r: Value = get("/v1/hq/me", Some(&ta)).await.unwrap().json().await.unwrap();
    assert!(r.get("garage").is_none(), "{r}");
    let r: Value = get("/v1/hq/open", Some(&tb)).await.unwrap().json().await.unwrap();
    assert!(r["hqs"][0].get("garage").is_none());
    assert!(r["hqs"][0].get("style").is_some());
    // deleting again is fine
    assert_eq!(c.delete(&url).bearer_auth(&ta).send().await.unwrap().status(), 200);
    let _ = C;
}
