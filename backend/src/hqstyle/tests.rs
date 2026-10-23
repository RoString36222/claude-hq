use super::*;
use sqlx::sqlite::SqlitePoolOptions;

const A: &str = "aaaaaaaa-0000-4000-8000-0000000000a1"; // open HQ
const B: &str = "bbbbbbbb-0000-4000-8000-0000000000b2"; // closed HQ
const C: &str = "cccccccc-0000-4000-8000-0000000000c3"; // open HQ, disabled account
const D: &str = "dddddddd-0000-4000-8000-0000000000d4"; // no HQ row

fn ok(j: Value) -> Value {
    normalize(&j).unwrap_or_else(|e| panic!("{e}: {j}"))
}

fn no(j: Value) -> String {
    normalize(&j).expect_err(&format!("accepted {j}"))
}

fn item(k: &str, f: &str, x: i64, z: i64) -> Value {
    json!({"k": k, "f": f, "x": x, "z": z, "r": 0})
}

#[test]
fn the_schema_parses() {
    let s = &*SCHEMA;
    assert_eq!((s.v, s.max_bytes, s.items_max, s.per_floor, s.grid, s.rot), (1, 8192, 48, 32, 13, 3));
    assert_eq!(s.floors, ["lobby", "mission"]);
    assert!(s.int_groups.iter().any(|(k, _)| k == "lobby"));
}

#[test]
fn a_bare_document_normalizes_to_every_default() {
    let n = ok(json!({"v": 1}));
    let s = &*SCHEMA;
    let ext = n["ext"].as_object().unwrap();
    assert_eq!(ext.keys().cloned().collect::<Vec<_>>(), s.ext.iter().map(|(k, _)| k.clone()).collect::<Vec<_>>());
    assert_eq!(n["ext"]["preset"], "glass");
    assert_eq!(n["ext"]["roof"], json!(["antennas", "beacon"]));
    assert_eq!(n["ext"]["balcony"], true);
    for f in ["lobby", "mission"] {
        assert_eq!(n["int"]["themes"][f], json!({"wall": "slate", "floor": "stone", "mood": "warm", "furn": "standard"}));
    }
    assert_eq!(n["int"]["items"], json!([]));
    assert_eq!(n["int"]["lobby"]["preset"], "atrium");
    assert_eq!(n["int"]["lobby"].as_object().unwrap().len(), 9);
    // Key order is the wire's: v, ext, int{themes, items, lobby}.
    let t = n.to_string();
    assert!(t.starts_with(r#"{"v":1,"ext":{"preset":"glass","facade":"glass""#), "{t}");
    assert!(t.contains(r#""int":{"themes":{"lobby":"#), "{t}");
    // Normalizing is idempotent.
    assert_eq!(ok(n.clone()), n);
}

#[test]
fn colours_are_lowercased_and_values_kept() {
    let n = ok(json!({"v": 1,
        "ext": {"body": "#AABBCC", "tint": "gold", "roof": ["solar"], "balcony": false},
        "int": {"themes": {"mission": {"wall": "oak"}}, "lobby": {"rug": "persian"},
                "items": [{"k": "piano", "f": "mission", "x": -13, "z": 13, "r": 3}, {"k": "plant", "f": "lobby", "x": 0, "z": 0}]}}));
    assert_eq!(n["ext"]["body"], "#aabbcc");
    assert_eq!(n["ext"]["trim"], "#ffb347");
    assert_eq!((n["ext"]["tint"].as_str(), n["ext"]["balcony"].as_bool()), (Some("gold"), Some(false)));
    assert_eq!(n["ext"]["roof"], json!(["solar"]));
    assert_eq!(n["int"]["themes"]["mission"]["wall"], "oak");
    assert_eq!(n["int"]["themes"]["mission"]["floor"], "stone");
    assert_eq!(n["int"]["themes"]["lobby"]["wall"], "slate");
    assert_eq!(n["int"]["lobby"]["rug"], "persian");
    // items keep input order; a missing r is 0
    assert_eq!(n["int"]["items"], json!([
        {"k": "piano", "f": "mission", "x": -13, "z": 13, "r": 3},
        {"k": "plant", "f": "lobby", "x": 0, "z": 0, "r": 0}]));
    assert_eq!(ok(json!({"v": 1, "ext": {"roof": []}}))["ext"]["roof"], json!([]));
}

#[test]
fn strict_rejections() {
    // shape and version
    no(json!([]));
    no(json!({}));
    no(json!({"v": 2}));
    no(json!({"v": "1"}));
    no(json!({"v": 1.0}));
    no(json!({"v": 1, "x": 1}));
    // unknown keys anywhere
    no(json!({"v": 1, "ext": {"title": "hi"}}));
    no(json!({"v": 1, "int": {"notes": []}}));
    no(json!({"v": 1, "int": {"themes": {"attic": {}}}}));
    no(json!({"v": 1, "int": {"themes": {"lobby": {"wall": "oak", "paint": "x"}}}}));
    no(json!({"v": 1, "int": {"lobby": {"jukebox": "jazz"}}}));
    no(json!({"v": 1, "int": {"items": [{"k": "plant", "f": "lobby", "x": 0, "z": 0, "name": "fern"}]}}));
    // bad enums / types
    no(json!({"v": 1, "ext": {"preset": "gothic"}}));
    no(json!({"v": 1, "ext": {"preset": 3}}));
    no(json!({"v": 1, "int": {"themes": {"lobby": {"mood": "dark"}}}}));
    no(json!({"v": 1, "int": {"lobby": {"ceiling": "sky"}}}));
    no(json!({"v": 1, "ext": {"balcony": "yes"}}));
    no(json!({"v": 1, "ext": {"roof": ["solar", "solar"]}}));
    no(json!({"v": 1, "ext": {"roof": ["moat"]}}));
    no(json!({"v": 1, "ext": {"roof": "solar"}}));
    no(json!({"v": 1, "ext": {"roof": ["antennas", "tank", "garden", "solar", "beacon", "antennas"]}}));
    // bad colours
    for c in ["#abc", "abcdef", "#abcdeg", "#abcdef0", "red", "#ABCDEF ", ""] {
        no(json!({"v": 1, "ext": {"night": c}}));
    }
    no(json!({"v": 1, "ext": {"night": null}}));
}

#[test]
fn item_rules() {
    let with = |items: Vec<Value>| json!({"v": 1, "int": {"items": items}});
    no(with(vec![item("throne", "lobby", 0, 0)]));
    no(with(vec![item("plant", "roof", 0, 0)]));
    no(with(vec![item("plant", "lobby", 14, 0)]));
    no(with(vec![item("plant", "lobby", 0, -14)]));
    no(with(vec![json!({"k": "plant", "f": "lobby", "x": 1.5, "z": 0})]));
    no(with(vec![json!({"k": "plant", "f": "lobby", "x": 1.0, "z": 0})]));
    no(with(vec![json!({"k": "plant", "f": "lobby", "x": "1", "z": 0})]));
    no(with(vec![json!({"k": "plant", "f": "lobby", "z": 0})]));
    no(with(vec![json!({"k": "plant", "f": "lobby", "x": 0, "z": 0, "r": 4})]));
    no(with(vec![json!({"k": "plant", "f": "lobby", "x": 0, "z": 0, "r": -1})]));
    no(with(vec![json!("plant")]));
    // the same cell twice on one floor; the same cell on two floors is fine
    no(with(vec![item("plant", "lobby", 2, 3), item("sofa", "lobby", 2, 3)]));
    ok(with(vec![item("plant", "lobby", 2, 3), item("sofa", "mission", 2, 3)]));
    // pet furniture is data, nothing special
    ok(with(vec![item("cattree", "lobby", 1, 1)]));
    // per-floor and total caps
    let cells = |f: &str, n: usize, off: i64| -> Vec<Value> {
        (0..n).map(|i| item("lamp", f, (i as i64 % 20) - 10, (i as i64 / 20) + off)).collect()
    };
    ok(with(cells("lobby", 32, 0)));
    assert!(no(with(cells("lobby", 33, 0))).contains("one floor"));
    let mut both = cells("lobby", 24, 0);
    both.extend(cells("mission", 24, 0));
    ok(with(both.clone()));
    both.push(item("lamp", "mission", 12, 12));
    assert!(no(with(both)).contains("at most 48"));
}

#[test]
fn an_oversize_document_is_refused() {
    // Measured on the compact serialization, before anything else is checked.
    let mut doc = json!({"v": 1, "ext": {}});
    let big: Vec<Value> = (0..1000).map(|_| json!("antennas")).collect();
    doc["ext"]["roof"] = json!(big);
    assert!(no(doc).contains("larger than 8192"));
}

#[test]
fn put_bodies_and_id_lists() {
    assert_eq!(parse_put(br#"{"style": null}"#), Ok(None));
    assert!(parse_put(br#"{"style": {"v": 1}}"#).unwrap().is_some());
    assert!(parse_put(br#"{}"#).is_err());
    assert!(parse_put(br#"{"style": null, "v": 1}"#).is_err());
    assert!(parse_put(br#"not json"#).is_err());
    assert!(parse_put(br#"{"style": "x"}"#).is_err());

    assert_eq!(parse_ids(Some(&format!("ids={A},{B},{A}"))), Ok(vec![A.to_string(), B.to_string()]));
    assert_eq!(parse_ids(Some(&format!("x=1&ids={A}%2C{B}"))).unwrap().len(), 2);
    assert_eq!(parse_ids(Some("ids=")), Ok(vec![]));
    assert!(parse_ids(None).is_err());
    assert!(parse_ids(Some("ids=me")).is_err());
    assert!(parse_ids(Some(&format!("ids={}", A.to_uppercase()))).is_err());
    assert!(parse_ids(Some("ids=../../etc")).is_err());
    let many: Vec<String> = (0..101).map(|i| format!("aaaaaaaa-0000-4000-8000-{i:012}")).collect();
    assert!(parse_ids(Some(&format!("ids={}", many.join(",")))).is_err());
    assert_eq!(parse_ids(Some(&format!("ids={}", many[..100].join(",")))).unwrap().len(), 100);
}

#[test]
fn saves_are_rate_limited_per_user() {
    let t = Instant::now();
    let u = "rate-test-user";
    for _ in 0..SAVE_BURST {
        assert!(save_allowed(u, t));
    }
    assert!(!save_allowed(u, t));
    assert!(save_allowed("rate-test-other", t));
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

fn styled(tint: &str) -> Value {
    ok(json!({"v": 1, "ext": {"tint": tint}}))
}

#[tokio::test]
async fn the_migration_creates_the_table() {
    let p = pool().await;
    let cols: Vec<String> = sqlx::query_scalar("SELECT name FROM pragma_table_info('hq_custom')")
        .fetch_all(&p)
        .await
        .unwrap();
    assert_eq!(cols, ["user_id", "style", "updated_at"]);
}

#[tokio::test]
async fn save_load_reset_and_visibility() {
    let p = pool().await;
    assert_eq!(load(&p, A).await.unwrap(), None);
    for (u, t) in [(A, "gold"), (B, "rose"), (C, "grey"), (D, "green")] {
        save(&p, u, Some(&styled(t))).await.unwrap();
    }
    assert_eq!(load(&p, A).await.unwrap(), Some(styled("gold")));
    save(&p, A, Some(&styled("bronze"))).await.unwrap();
    assert_eq!(load(&p, A).await.unwrap(), Some(styled("bronze")));
    assert_eq!(load(&p, B).await.unwrap(), Some(styled("rose")), "one user's save never touches another's");

    let ids: Vec<String> = [A, B, C, D].iter().map(|s| s.to_string()).collect();
    // B looks: A is open; B is itself (closed, still shown); C is disabled; D has no HQ row.
    let seen = visible(&p, B, &ids).await.unwrap();
    assert_eq!(seen.keys().cloned().collect::<HashSet<_>>(), [A, B].iter().map(|s| s.to_string()).collect());
    assert_eq!(seen[A], styled("bronze"));
    // D sees itself without an HQ row.
    assert!(visible(&p, D, &ids).await.unwrap().contains_key(D));

    // reset
    save(&p, A, None).await.unwrap();
    assert_eq!(load(&p, A).await.unwrap(), None);
    assert!(!visible(&p, B, &ids).await.unwrap().contains_key(A));

    // a stored row a newer schema would refuse reads as no style, not a 500
    sqlx::query("UPDATE hq_custom SET style = '{\"v\":1,\"ext\":{\"tint\":\"plaid\"}}' WHERE user_id = ?1")
        .bind(B).execute(&p).await.unwrap();
    assert_eq!(load(&p, B).await.unwrap(), None);
}

#[tokio::test]
async fn an_unchanged_save_keeps_updated_at() {
    let p = pool().await;
    save(&p, A, Some(&styled("gold"))).await.unwrap();
    sqlx::query("UPDATE hq_custom SET updated_at = '2000-01-01 00:00:00'").execute(&p).await.unwrap();
    save(&p, A, Some(&styled("gold"))).await.unwrap();
    let at: String = sqlx::query_scalar("SELECT updated_at FROM hq_custom").fetch_one(&p).await.unwrap();
    assert_eq!(at, "2000-01-01 00:00:00");
    save(&p, A, Some(&styled("rose"))).await.unwrap();
    let at: String = sqlx::query_scalar("SELECT updated_at FROM hq_custom").fetch_one(&p).await.unwrap();
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
    let get = |path: &str, tok: Option<&str>| {
        let mut r = c.get(format!("{base}{path}"));
        if let Some(t) = tok {
            r = r.bearer_auth(t);
        }
        r.send()
    };

    // no device: 401, as everywhere else
    assert_eq!(get("/v1/hq/me/style", None).await.unwrap().status(), 401);
    assert_eq!(get(&format!("/v1/hq/styles?ids={A}"), None).await.unwrap().status(), 401);
    assert_eq!(c.put(format!("{base}/v1/hq/me/style")).json(&json!({"style": null})).send().await.unwrap().status(), 401);

    // nothing yet
    let r: Value = get("/v1/hq/me/style", Some(&ta)).await.unwrap().json().await.unwrap();
    assert_eq!(r, json!({"style": null}));

    // a PUT writes the caller's row and answers normalized
    let put = |tok: &str, body: Value| c.put(format!("{base}/v1/hq/me/style")).bearer_auth(tok.to_string()).json(&body).send();
    let r = put(&ta, json!({"style": {"v": 1, "ext": {"body": "#ABCDEF"}}})).await.unwrap();
    assert_eq!(r.status(), 200);
    let r: Value = r.json().await.unwrap();
    assert_eq!(r["style"]["ext"]["body"], "#abcdef");
    assert_eq!(r["style"]["int"]["themes"]["mission"]["mood"], "warm");
    let r = put(&tb, json!({"style": {"v": 1, "ext": {"tint": "rose"}}})).await.unwrap();
    assert_eq!(r.status(), 200);
    assert_eq!(load(&p, A).await.unwrap().unwrap()["ext"]["body"], "#abcdef", "B's PUT left A alone");

    // a bad document: 422 {"detail": "..."}
    let r = put(&ta, json!({"style": {"v": 1, "ext": {"tint": "plaid"}}})).await.unwrap();
    assert_eq!(r.status(), 422);
    let d: Value = r.json().await.unwrap();
    assert!(d["detail"].as_str().unwrap().contains("ext.tint"), "{d}");
    // an oversize body
    let r = c.put(format!("{base}/v1/hq/me/style")).bearer_auth(&ta).body(vec![b' '; 40_000]).send().await.unwrap();
    assert_eq!(r.status(), 413);

    // the batch: A open, B (closed) only for B itself, bad ids 422
    let r: Value = get(&format!("/v1/hq/styles?ids={A},{B},{C}"), Some(&ta)).await.unwrap().json().await.unwrap();
    assert_eq!(r["styles"].as_object().unwrap().keys().collect::<Vec<_>>(), [A]);
    let r: Value = get(&format!("/v1/hq/styles?ids={A},{B}"), Some(&tb)).await.unwrap().json().await.unwrap();
    assert_eq!(r["styles"].as_object().unwrap().len(), 2);
    assert_eq!(get("/v1/hq/styles?ids=nope", Some(&ta)).await.unwrap().status(), 422);
    assert_eq!(get("/v1/hq/styles", Some(&ta)).await.unwrap().status(), 422);

    // the HQ projection carries it last; a user without one has no key at all
    let r: Value = get("/v1/hq/open", Some(&tb)).await.unwrap().json().await.unwrap();
    let hqs = r["hqs"].as_array().unwrap();
    assert_eq!(hqs.len(), 1, "only A is open and active");
    assert_eq!(hqs[0]["style"]["ext"]["body"], "#abcdef");
    let raw = get("/v1/hq/open", Some(&tb)).await.unwrap().text().await.unwrap();
    assert!(raw.contains(r#""cos":{},"style":{"v":1"#), "style is the last key: {raw}");
    let r: Value = get(&format!("/v1/hq/{A}"), Some(&tb)).await.unwrap().json().await.unwrap();
    assert_eq!(r["style"]["ext"]["body"], "#abcdef");
    let r: Value = get("/v1/hq/me", Some(&tb)).await.unwrap().json().await.unwrap();
    assert_eq!(r["style"]["ext"]["tint"], "rose");
    // the routes did not swallow /v1/hq/:user_id
    assert_eq!(get(&format!("/v1/hq/{B}"), Some(&ta)).await.unwrap().status(), 404);

    // reset with null
    let r: Value = put(&ta, json!({"style": null})).await.unwrap().json().await.unwrap();
    assert_eq!(r, json!({"style": null}));
    let r: Value = get("/v1/hq/me", Some(&ta)).await.unwrap().json().await.unwrap();
    assert!(r.get("style").is_none(), "{r}");
    let r: Value = get("/v1/hq/open", Some(&tb)).await.unwrap().json().await.unwrap();
    assert!(r["hqs"][0].get("style").is_none());
}
