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

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, OnceLock};

use axum::extract::Path;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;

use crate::worldgen;

/// The worlds a production Arena serves.
const LIVE: [&str; 1] = ["claude-hq@1"];
/// Generated worlds kept in memory (each ~1 MB of JSON).
const CACHE_MAX: usize = 8;

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

async fn get_world(Path(id): Path<String>, headers: HeaderMap) -> Response {
    if let Err(e) = worldgen::parse_id(&id) {
        return error(StatusCode::BAD_REQUEST, e);
    }
    if !LIVE.contains(&id.as_str()) && !preview_enabled() {
        return error(StatusCode::NOT_FOUND, "no such world");
    }
    if let Some(w) = cache().lock().unwrap().get(&id).cloned() {
        return send(&w, &headers);
    }
    let w = match generate(id.clone(), Vec::new()).await {
        Ok(w) => w,
        Err((status, e)) => return error(status, e),
    };
    let mut c = cache().lock().unwrap();
    if c.len() >= CACHE_MAX && !c.contains_key(&id) {
        c.clear(); // a dev Arena trying seeds; production only ever holds the live worlds
    }
    c.insert(id, w.clone());
    send(&w, &headers)
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
