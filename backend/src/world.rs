//! Serving generated worlds (HQ 3.0, see worldgen/).
//!
//!   GET  /v1/world/:id            the WorldDoc as JSON; ETag = the world's fingerprint
//!   POST /v1/world/:id/preview    {edits:[...]} -> the WorldDoc with them applied   (dev only)
//!   GET  /dev/world               the 2D viewer, tools/worldgen_view.html           (dev only)
//!
//! Public and read-only: a world holds no one's data. Outside dev only the live
//! worlds are served, because generating any seed on request would let anyone
//! spend the server's CPU; with ARENA_WORLD_PREVIEW=1 (a local Arena) any seed
//! goes, edits can be previewed (never stored), and the viewer is served.
//!
//! The live worlds: Arena City (claude-hq@1, frozen), the Commons (claude-hq@2)
//! and every member's island, user:<uuid>@2. An island is served only for the
//! uuid of an active user, so the id space stays as small as the Arena.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, OnceLock};

use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;

use crate::worldgen;

/// The fixed worlds a production Arena serves (plus the islands, see `live`).
const LIVE: [&str; 2] = ["claude-hq@1", "claude-hq@2"];
/// Generated worlds kept in memory (each ~1 MB of JSON). The fixed worlds are
/// never evicted; islands share what is left.
const CACHE_MAX: usize = 8;

/// What a live id names.
#[derive(Debug, PartialEq)]
enum Live<'a> {
    Fixed,
    Island(&'a str),
}

/// Which kind of live world `id` names, if any: a fixed world, or user:<uuid>@2
/// with a uuid matching UUID_RE (36 hex digits and hyphens, as the dashboard checks).
fn live_kind(id: &str) -> Option<Live<'_>> {
    if LIVE.contains(&id) {
        return Some(Live::Fixed);
    }
    let uuid = id.strip_prefix("user:")?.strip_suffix("@2")?;
    (uuid.len() == 36 && uuid.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')).then_some(Live::Island(uuid))
}

/// Whether a production Arena serves `id`: a fixed world, or the island of an active user.
async fn live(pool: &sqlx::SqlitePool, id: &str) -> Result<bool, sqlx::Error> {
    match live_kind(id) {
        Some(Live::Fixed) => Ok(true),
        Some(Live::Island(uuid)) => {
            let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users WHERE id = ?1 AND is_active = 1")
                .bind(uuid)
                .fetch_one(pool)
                .await?;
            Ok(n > 0)
        }
        None => Ok(false),
    }
}

fn preview_enabled() -> bool {
    std::env::var("ARENA_WORLD_PREVIEW").as_deref() == Ok("1")
}

pub fn public_routes() -> Router<crate::AppState> {
    let r = Router::new().route("/v1/world/:id", get(get_world));
    if preview_enabled() {
        return r.route("/v1/world/:id/preview", post(preview)).route("/dev/world", get(viewer));
    }
    r
}

/// (JSON, fingerprint) of a generated world.
type Cached = Arc<(String, String)>;

fn cache() -> &'static Mutex<BTreeMap<String, Cached>> {
    static C: OnceLock<Mutex<BTreeMap<String, Cached>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(BTreeMap::new()))
}

fn error(status: StatusCode, msg: impl Into<String>) -> Response {
    (status, Json(json!({"detail": msg.into()}))).into_response()
}

async fn generate(id: String, edits: Vec<worldgen::Edit>) -> Result<Cached, (StatusCode, String)> {
    tokio::task::spawn_blocking(move || {
        worldgen::generate(&id, &edits).map(|w| Arc::new((serde_json::to_string(&w).expect("a world serialises"), w.hashes.world)))
    })
    .await
    .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "world generation failed".to_string()))?
    .map_err(|e| (StatusCode::UNPROCESSABLE_ENTITY, e))
}

fn send(w: &Cached, headers: &HeaderMap) -> Response {
    let etag = format!("\"{}\"", w.1);
    let cache_control = "public, max-age=300";
    if headers.get(header::IF_NONE_MATCH).and_then(|v| v.to_str().ok()) == Some(etag.as_str()) {
        return (StatusCode::NOT_MODIFIED, [(header::ETAG, etag), (header::CACHE_CONTROL, cache_control.into())]).into_response();
    }
    (
        [(header::CONTENT_TYPE, "application/json".to_string()), (header::ETAG, etag), (header::CACHE_CONTROL, cache_control.into())],
        w.0.clone(),
    )
        .into_response()
}

async fn get_world(State(st): State<crate::AppState>, Path(id): Path<String>, headers: HeaderMap) -> Response {
    serve_world(&st.pool, id, &headers).await
}

async fn serve_world(pool: &sqlx::SqlitePool, id: String, headers: &HeaderMap) -> Response {
    if let Err(e) = worldgen::parse_id(&id) {
        return error(StatusCode::BAD_REQUEST, e);
    }
    if !preview_enabled() {
        match live(pool, &id).await {
            Ok(true) => {}
            Ok(false) => return error(StatusCode::NOT_FOUND, "no such world"),
            Err(e) => return error(StatusCode::INTERNAL_SERVER_ERROR, format!("db error: {e}")),
        }
    }
    if let Some(w) = cache().lock().unwrap().get(&id).cloned() {
        return send(&w, headers);
    }
    let w = match generate(id.clone(), Vec::new()).await {
        Ok(w) => w,
        Err((status, e)) => return error(status, e),
    };
    let mut c = cache().lock().unwrap();
    if c.len() >= CACHE_MAX && !c.contains_key(&id) {
        // islands (or a dev Arena's seeds) filled it: drop them, keep the fixed worlds
        c.retain(|k, _| LIVE.contains(&k.as_str()));
    }
    c.insert(id, w.clone());
    send(&w, headers)
}

#[derive(Deserialize)]
struct PreviewIn {
    #[serde(default)]
    edits: Vec<worldgen::Edit>,
}

async fn preview(Path(id): Path<String>, Json(body): Json<PreviewIn>) -> Response {
    match generate(id, body.edits).await {
        Ok(w) => send(&w, &HeaderMap::new()),
        Err((status, e)) => error(status, e),
    }
}

async fn viewer() -> Response {
    // read at request time: dev only, and the page lives outside the image's build context
    match std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../tools/worldgen_view.html")) {
        Ok(page) => Html(page).into_response(),
        Err(_) => error(StatusCode::NOT_FOUND, "tools/worldgen_view.html is not next to this Arena"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    const U: &str = "0b8e4c1a-3f2d-4e5b-9a6c-7d8e9f0a1b2c";

    async fn pool() -> sqlx::SqlitePool {
        // one connection: each sqlite::memory: connection is its own database
        let pool = SqlitePoolOptions::new().max_connections(1).connect("sqlite::memory:").await.unwrap();
        crate::db::migrate(&pool).await.unwrap();
        sqlx::query(
            "INSERT INTO users (id, github_id, handle, display_name, avatar_url, trainer_name, is_active)
             VALUES (?1, 1, 'u', '', '', '', 1)",
        )
        .bind(U)
        .execute(&pool)
        .await
        .unwrap();
        pool
    }

    #[test]
    fn live_ids_are_the_fixed_worlds_and_well_formed_islands() {
        assert_eq!(live_kind("claude-hq@1"), Some(Live::Fixed));
        assert_eq!(live_kind("claude-hq@2"), Some(Live::Fixed));
        assert_eq!(live_kind(&format!("user:{U}@2")), Some(Live::Island(U)));
        assert!(live_kind("user:0B8E4C1A-3F2D-4E5B-9A6C-7D8E9F0A1B2C@2").is_some());
        for bad in [
            "claude-hq@3".to_string(),
            "claude-hq".into(),
            "other@1".into(),
            format!("user:{U}@1"),                         // islands are @2 only
            format!("user:{U}@2x"),
            format!("user:{U}0@2"),                        // 37 characters
            "user:0b8e4c1a-3f2d-4e5b-9a6c-7d8e9f0a1b2@2".into(),  // 35
            "user:0b8e4c1a-3f2d-4e5b-9a6c-7d8e9f0a1b2g@2".into(), // not hex
            "user:0b8e4c1a/3f2d-4e5b-9a6c-7d8e9f0a1b2c@2".into(), // a path
            "user:../../../../../../../../../../../../x@2".into(),
            format!("user:{U}\n@2"),
            format!("USER:{U}@2"),
            "user:@2".into(),
        ] {
            assert_eq!(live_kind(&bad), None, "{bad:?} must not be live");
        }
    }

    #[tokio::test]
    async fn an_island_is_live_only_for_an_active_user() {
        let p = pool().await;
        assert!(live(&p, "claude-hq@1").await.unwrap());
        assert!(live(&p, "claude-hq@2").await.unwrap());
        assert!(live(&p, &format!("user:{U}@2")).await.unwrap());
        assert!(!live(&p, "user:11111111-2222-3333-4444-555555555555@2").await.unwrap(), "no such user");
        sqlx::query("UPDATE users SET is_active = 0").execute(&p).await.unwrap();
        assert!(!live(&p, &format!("user:{U}@2")).await.unwrap(), "a disabled account");
    }

    #[tokio::test]
    async fn bad_ids_are_refused_before_any_generation() {
        let p = pool().await;
        let h = HeaderMap::new();
        // malformed: 400 from parse_id
        assert_eq!(serve_world(&p, "no-version".into(), &h).await.status(), StatusCode::BAD_REQUEST);
        assert_eq!(serve_world(&p, "user:a/b@1".into(), &h).await.status(), StatusCode::BAD_REQUEST);
        // well formed but not live: 404, nothing generated
        assert_eq!(serve_world(&p, "elsewhere@1".into(), &h).await.status(), StatusCode::NOT_FOUND);
        assert_eq!(serve_world(&p, format!("user:{U}@1"), &h).await.status(), StatusCode::NOT_FOUND);
        assert_eq!(serve_world(&p, "user:not-a-uuid@1".into(), &h).await.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn the_live_world_keeps_its_etag() {
        let p = pool().await;
        let r = serve_world(&p, "claude-hq@1".into(), &HeaderMap::new()).await;
        assert_eq!(r.status(), StatusCode::OK);
        let etag = r.headers().get(header::ETAG).unwrap().clone();
        let mut h = HeaderMap::new();
        h.insert(header::IF_NONE_MATCH, etag.clone());
        let again = serve_world(&p, "claude-hq@1".into(), &h).await;
        assert_eq!(again.status(), StatusCode::NOT_MODIFIED);
        assert_eq!(again.headers().get(header::ETAG), Some(&etag));
    }
}
