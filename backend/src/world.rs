//! Serving generated worlds (HQ 3.0, see worldgen/).
//!
//!   GET  /v1/world/:id            the WorldDoc as JSON; ETag = the world's fingerprint
//!   POST /v1/world/:id/preview    {edits:[...]} -> the WorldDoc with them applied   (dev only)
//!   GET  /dev/world               the 2D viewer, tools/worldgen_view.html           (dev only)
//!
//! Read-only: a world holds no one's data. Outside dev only the live worlds are
//! served, because generating any seed on request would let anyone spend the
//! server's CPU; with ARENA_WORLD_PREVIEW=1 (a local Arena) any seed goes, edits
//! can be previewed (never stored), and the viewer is served.
//!
//! The live worlds: Arena City (claude-hq@1, frozen) and the Commons
//! (claude-hq@3 since HQ 3.15, archipelago::LIVE_V; claude-hq@2 still served for
//! older clients), public; and every member's island, user:<uuid>@3 (or @2). An island
//! needs a device token (the route is public, so the check is made here) and is
//! served only to someone who may see that city (cities::can_view) while its
//! owner is active. Anyone else gets the same 404, so the route says nothing
//! about who is a member. The cache holds the fixed worlds for good and the
//! most recently used islands; one request generates a world however many ask.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, OnceLock};

use tokio::sync::OnceCell;

use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;

use crate::cities;
use crate::worldgen;

/// The fixed worlds a production Arena serves (plus the islands, see `live`):
/// Arena City, the Commons at @2 (older clients) and the live Commons.
const LIVE: [&str; 3] = ["claude-hq@1", crate::archipelago::COMMONS_V2, crate::archipelago::COMMONS];
/// Generated worlds kept in memory (each ~1 MB of JSON). The fixed worlds are
/// never evicted; islands share what is left.
const CACHE_MAX: usize = 8;

/// What a live id names.
#[derive(Debug, PartialEq)]
enum Live<'a> {
    Fixed,
    Island(&'a str),
}

/// Which kind of live world `id` names, if any: a fixed world, or user:<uuid>@3
/// (the live island) or user:<uuid>@2 (older clients) with a uuid matching
/// UUID_RE (36 hex digits and hyphens, as the dashboard checks).
fn live_kind(id: &str) -> Option<Live<'_>> {
    if LIVE.contains(&id) {
        return Some(Live::Fixed);
    }
    let rest = id.strip_prefix("user:")?;
    let uuid = rest.strip_suffix("@3").or_else(|| rest.strip_suffix("@2"))?;
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
/// A world being generated or generated: every request for it awaits the same cell.
type Cell = Arc<OnceCell<Cached>>;

/// The cached worlds, each with the tick it was last asked for.
#[derive(Default)]
struct Cache {
    worlds: BTreeMap<String, (Cell, u64)>,
    tick: u64,
}

impl Cache {
    /// The cell for `id`, made (and the least recently used island or dev seed
    /// evicted to fit it) when it is new. The fixed worlds are never evicted.
    fn cell(&mut self, id: &str) -> Cell {
        self.tick += 1;
        let tick = self.tick;
        if let Some((cell, used)) = self.worlds.get_mut(id) {
            *used = tick;
            return cell.clone();
        }
        if self.worlds.len() >= CACHE_MAX {
            let oldest = self.worlds.iter().filter(|(k, _)| !LIVE.contains(&k.as_str())).min_by_key(|(_, (_, used))| *used);
            if let Some(k) = oldest.map(|(k, _)| k.clone()) {
                self.worlds.remove(&k);
            }
        }
        let cell = Cell::default();
        self.worlds.insert(id.to_string(), (cell.clone(), tick));
        cell
    }

    /// Drop `id`'s cell if it is still `cell` (its generation failed).
    fn forget(&mut self, id: &str, cell: &Cell) {
        if self.worlds.get(id).is_some_and(|(c, _)| Arc::ptr_eq(c, cell)) {
            self.worlds.remove(id);
        }
    }
}

fn cache() -> &'static Mutex<Cache> {
    static C: OnceLock<Mutex<Cache>> = OnceLock::new();
    C.get_or_init(Mutex::default)
}

/// The user a request's device token belongs to (the same check as main.rs's
/// require_device, which the public world route does not sit behind).
async fn bearer_user(pool: &sqlx::SqlitePool, headers: &HeaderMap) -> Result<Option<String>, sqlx::Error> {
    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer ").or_else(|| v.strip_prefix("bearer ")))
        .map(str::trim)
        .unwrap_or("");
    if token.is_empty() {
        return Ok(None);
    }
    sqlx::query_scalar(
        "SELECT u.id FROM devices d JOIN users u ON u.id = d.user_id
         WHERE d.token_hash = ?1 AND d.revoked = 0 AND u.is_active = 1",
    )
    .bind(crate::auth::hash_token(token))
    .fetch_optional(pool)
    .await
}

/// Why the caller may not have island `id` of `owner`, or None when they may:
/// 401 without a device token; 404 alike for no such member, a disabled one,
/// and a city the caller may not see.
async fn refuse_island(pool: &sqlx::SqlitePool, id: &str, owner: &str, headers: &HeaderMap) -> Option<Response> {
    let seen = async {
        let Some(viewer) = bearer_user(pool, headers).await? else { return Ok(None) };
        Ok(Some(live(pool, id).await? && cities::can_view(pool, owner, &viewer).await))
    };
    match seen.await {
        Ok(Some(true)) => None,
        Ok(Some(false)) => Some(error(StatusCode::NOT_FOUND, "no such world")),
        Ok(None) => Some(error(StatusCode::UNAUTHORIZED, "missing bearer token")),
        Err::<_, sqlx::Error>(e) => Some(error(StatusCode::INTERNAL_SERVER_ERROR, format!("db error: {e}"))),
    }
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

/// The world with its ETag; `private` keeps an island out of shared caches.
fn send(w: &Cached, headers: &HeaderMap, private: bool) -> Response {
    let etag = format!("\"{}\"", w.1);
    let cache_control = if private { "private, max-age=300" } else { "public, max-age=300" };
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
    let island = live_kind(&id).and_then(|k| match k {
        Live::Island(owner) => Some(owner),
        Live::Fixed => None,
    });
    if let (Some(owner), false) = (island, preview_enabled()) {
        // before anything else, so a stranger learns nothing from the answer
        if let Some(r) = refuse_island(pool, &id, owner, headers).await {
            return r;
        }
    }
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
    let private = island.is_some();
    let cell = cache().lock().unwrap().cell(&id);
    match cell.get_or_try_init(|| generate(id.clone(), Vec::new())).await {
        Ok(w) => send(w, headers, private),
        Err((status, e)) => {
            cache().lock().unwrap().forget(&id, &cell);
            error(status, e)
        }
    }
}

#[derive(Deserialize)]
struct PreviewIn {
    #[serde(default)]
    edits: Vec<worldgen::Edit>,
}

async fn preview(Path(id): Path<String>, Json(body): Json<PreviewIn>) -> Response {
    match generate(id, body.edits).await {
        Ok(w) => send(&w, &HeaderMap::new(), false),
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
        assert_eq!(live_kind("claude-hq@3"), Some(Live::Fixed));
        assert_eq!(live_kind(&format!("user:{U}@2")), Some(Live::Island(U)));
        assert_eq!(live_kind(&format!("user:{U}@3")), Some(Live::Island(U)));
        assert!(live_kind("user:0B8E4C1A-3F2D-4E5B-9A6C-7D8E9F0A1B2C@2").is_some());
        assert!(live_kind("user:0B8E4C1A-3F2D-4E5B-9A6C-7D8E9F0A1B2C@3").is_some());
        for bad in [
            "claude-hq@4".to_string(),
            "claude-hq@0".into(),
            "claude-hq".into(),
            "other@1".into(),
            "other@3".into(),
            format!("user:{U}@1"),                         // islands are @2 or @3 only
            format!("user:{U}@4"),
            format!("user:{U}@3@2"),
            format!("user:{U}@2@3"),
            format!("user:{U}@3x"),
            "user:../../../../../../../../../../../../x@3".into(),
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
        assert!(live(&p, "claude-hq@3").await.unwrap());
        assert!(live(&p, &format!("user:{U}@2")).await.unwrap());
        assert!(live(&p, &format!("user:{U}@3")).await.unwrap());
        assert!(!live(&p, "user:11111111-2222-3333-4444-555555555555@2").await.unwrap(), "no such user");
        assert!(!live(&p, "user:11111111-2222-3333-4444-555555555555@3").await.unwrap(), "no such user");
        sqlx::query("UPDATE users SET is_active = 0").execute(&p).await.unwrap();
        assert!(!live(&p, &format!("user:{U}@2")).await.unwrap(), "a disabled account");
        assert!(!live(&p, &format!("user:{U}@3")).await.unwrap(), "a disabled account");
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
        assert_eq!(serve_world(&p, format!("user:{U}@5"), &h).await.status(), StatusCode::BAD_REQUEST, "no such generator");
    }

    #[tokio::test]
    async fn a_live_island_at_3_is_gated_like_one_at_2() {
        let p = pool().await;
        let other = "11111111-2222-3333-4444-555555555555";
        for v in ["@2", "@3"] {
            let mine = format!("user:{U}{v}");
            // no token: 401 before anything else, for a member's island and for no one's
            assert_eq!(serve_world(&p, mine.clone(), &HeaderMap::new()).await.status(), StatusCode::UNAUTHORIZED, "{v}");
            assert_eq!(serve_world(&p, format!("user:{other}{v}"), &HeaderMap::new()).await.status(), StatusCode::UNAUTHORIZED, "{v}");
        }
        // a member: an unknown uuid is the same 404 at either version
        let h = device(&p, U, "tok-v3").await;
        for v in ["@2", "@3"] {
            assert_eq!(serve_world(&p, format!("user:{other}{v}"), &h).await.status(), StatusCode::NOT_FOUND, "{v}");
        }
        // the island the owner may see at @3 generates when this server has a @3 generator
        if worldgen::VERSION.contains(&3) {
            assert_eq!(serve_world(&p, format!("user:{U}@3"), &h).await.status(), StatusCode::OK);
            assert_eq!(serve_world(&p, "claude-hq@3".into(), &HeaderMap::new()).await.status(), StatusCode::OK);
        }
    }

    /// A device for `user`; the headers that carry its token.
    async fn device(pool: &sqlx::SqlitePool, user: &str, token: &str) -> HeaderMap {
        sqlx::query("INSERT INTO devices (id, user_id, token_hash, label, revoked) VALUES (?1, ?2, ?3, 'test', 0)")
            .bind(token)
            .bind(user)
            .bind(crate::auth::hash_token(token))
            .execute(pool)
            .await
            .unwrap();
        let mut h = HeaderMap::new();
        h.insert(header::AUTHORIZATION, format!("Bearer {token}").parse().unwrap());
        h
    }

    #[tokio::test]
    async fn an_island_needs_a_device_and_says_nothing_to_strangers() {
        let p = pool().await;
        let other = "11111111-2222-3333-4444-555555555555";
        let mine = format!("user:{U}@2");
        let nobody = format!("user:{other}@2");
        // no token: the same 401 for a member's island and for no one's
        for id in [&mine, &nobody] {
            assert_eq!(serve_world(&p, id.clone(), &HeaderMap::new()).await.status(), StatusCode::UNAUTHORIZED, "{id}");
        }
        let mut forged = HeaderMap::new();
        forged.insert(header::AUTHORIZATION, "Bearer not-a-device".parse().unwrap());
        assert_eq!(serve_world(&p, mine.clone(), &forged).await.status(), StatusCode::UNAUTHORIZED);

        // a member of the Arena gets past the gate to the generator
        let h = device(&p, U, "tok-u").await;
        assert_eq!(serve_world(&p, mine.clone(), &h).await.status(), StatusCode::OK);
        // an unknown uuid and a disabled owner are the same 404
        assert_eq!(serve_world(&p, nobody.clone(), &h).await.status(), StatusCode::NOT_FOUND);
        sqlx::query(
            "INSERT INTO users (id, github_id, handle, display_name, avatar_url, trainer_name, is_active)
             VALUES (?1, 2, 'o', '', '', '', 0)",
        )
        .bind(other)
        .execute(&p)
        .await
        .unwrap();
        assert_eq!(serve_world(&p, nobody, &h).await.status(), StatusCode::NOT_FOUND);
        // a revoked device is no device
        sqlx::query("UPDATE devices SET revoked = 1").execute(&p).await.unwrap();
        assert_eq!(serve_world(&p, mine, &h).await.status(), StatusCode::UNAUTHORIZED);
        // the fixed worlds stay public
        assert_eq!(serve_world(&p, "claude-hq@1".into(), &HeaderMap::new()).await.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn a_closed_island_is_the_same_404_to_a_member_it_refuses() {
        let p = pool().await;
        let other = "11111111-2222-3333-4444-555555555555";
        sqlx::query(
            "INSERT INTO users (id, github_id, handle, display_name, avatar_url, trainer_name, is_active)
             VALUES (?1, 2, 'o', '', '', '', 1)",
        )
        .bind(other)
        .execute(&p)
        .await
        .unwrap();
        let mine = format!("user:{U}@2");
        let me = device(&p, U, "tok-u").await;
        let them = device(&p, other, "tok-o").await;
        assert_eq!(serve_world(&p, mine.clone(), &them).await.status(), StatusCode::OK, "arena: members may visit");
        for mode in ["closed", "friends"] {
            sqlx::query(
                "INSERT OR REPLACE INTO city (owner, seed, treasury, tax_pm, specialty, privacy, created, last_accrual)
                 VALUES (?1, ?2, 0, 50, 'tech', ?3, 0, 0)",
            )
            .bind(U)
            .bind(&mine)
            .bind(mode)
            .execute(&p)
            .await
            .unwrap();
            assert_eq!(serve_world(&p, mine.clone(), &them).await.status(), StatusCode::NOT_FOUND, "{mode}: refused");
            assert_eq!(serve_world(&p, mine.clone(), &me).await.status(), StatusCode::OK, "{mode}: the owner");
        }
    }

    #[test]
    fn an_island_is_kept_out_of_shared_caches() {
        let w: Cached = Arc::new(("{}".into(), "f".into()));
        let cc = |r: Response| r.headers().get(header::CACHE_CONTROL).unwrap().to_str().unwrap().to_string();
        assert_eq!(cc(send(&w, &HeaderMap::new(), true)), "private, max-age=300");
        assert_eq!(cc(send(&w, &HeaderMap::new(), false)), "public, max-age=300");
    }

    fn island(i: usize) -> String {
        format!("user:00000000-0000-0000-0000-{i:012}@3")
    }

    #[test]
    fn a_full_cache_evicts_only_the_least_recently_used_island() {
        let mut c = Cache::default();
        for k in LIVE {
            c.cell(k);
        }
        for i in 0..CACHE_MAX - LIVE.len() {
            c.cell(&island(i));
        }
        c.cell(&island(0)); // asked for again: now the most recent
        c.cell(&island(100));
        assert_eq!(c.worlds.len(), CACHE_MAX);
        assert!(!c.worlds.contains_key(&island(1)), "the least recently used island goes");
        for k in ["claude-hq@1".to_string(), "claude-hq@2".into(), "claude-hq@3".into(), island(0), island(2), island(100)] {
            assert!(c.worlds.contains_key(&k), "{k} kept");
        }
        // cycling through more islands than fit never touches the fixed worlds,
        // and each miss costs exactly one island
        for i in 200..230 {
            c.cell(&island(i));
            assert_eq!(c.worlds.len(), CACHE_MAX);
            assert!(LIVE.iter().all(|k| c.worlds.contains_key(*k)), "the fixed worlds stay");
            assert!(i == 200 || c.worlds.contains_key(&island(i - 1)), "the previous island survives the next miss");
        }
    }

    #[tokio::test]
    async fn concurrent_requests_for_a_world_generate_it_once() {
        let mut c = Cache::default();
        let a = c.cell(&island(1));
        let b = c.cell(&island(1));
        assert!(Arc::ptr_eq(&a, &b), "one cell per id");
        let runs = std::sync::atomic::AtomicUsize::new(0);
        let gen = || async {
            runs.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            tokio::task::yield_now().await;
            Ok::<Cached, ()>(Arc::new(("{}".into(), "f".into())))
        };
        let (x, y) = tokio::join!(a.get_or_try_init(gen), b.get_or_try_init(gen));
        assert!(Arc::ptr_eq(x.unwrap(), y.unwrap()));
        assert_eq!(runs.load(std::sync::atomic::Ordering::SeqCst), 1);
        // a failed generation is forgotten, but only if the cell is still its own
        let stale = c.cell(&island(2));
        c.forget(&island(2), &a);
        assert!(c.worlds.contains_key(&island(2)));
        c.forget(&island(2), &stale);
        assert!(!c.worlds.contains_key(&island(2)));
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
