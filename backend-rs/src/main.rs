//! Arena backend in Rust — a parallel implementation of `backend/`.
//!
//! Serves the same endpoints against the same SQLite file, so it can be run
//! alongside the Python one and swapped by changing which port Caddy proxies.

mod auth;
mod config;
mod db;
mod rooms;
mod schemas;
mod scoring;
mod service;

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, Query, Request, State,
    },
    http::{header, StatusCode},
    middleware::{self, Next},
    response::{Html, IntoResponse, Redirect, Response},
    routing::{get, post},
    Json, Router,
};
use rooms::{Member, RoomManager};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{Row, SqlitePool};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};

#[derive(Clone)]
struct AppState {
    pool: SqlitePool,
    cfg: Arc<config::Settings>,
    rooms: RoomManager,
    conn_seq: Arc<AtomicU64>,
}

/// The authenticated caller, resolved from the bearer token on every request.
#[derive(Clone, Debug)]
struct Caller {
    user_id: String,
    device_id: String,
    handle: String,
    display_name: String,
    trainer_name: String,
    avatar_url: String,
    device_label: String,
}

fn err(code: StatusCode, msg: &str) -> Response {
    (code, Json(json!({ "detail": msg }))).into_response()
}

/// Middleware: resolve the bearer token to a Caller and stash it on the request.
/// Rejecting here rather than in each handler means a new endpoint cannot
/// accidentally be public.
async fn require_device(State(st): State<AppState>, mut req: Request, next: Next) -> Response {
    let token = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer ").or_else(|| v.strip_prefix("bearer ")))
        .map(str::trim)
        .unwrap_or("");
    if token.is_empty() {
        return err(StatusCode::UNAUTHORIZED, "missing bearer token");
    }

    let row = sqlx::query(
        "SELECT d.id AS device_id, d.label, u.id AS user_id, u.handle,
                u.display_name, u.trainer_name, u.avatar_url
         FROM devices d JOIN users u ON u.id = d.user_id
         WHERE d.token_hash = ?1 AND d.revoked = 0 AND u.is_active = 1",
    )
    .bind(auth::hash_token(token))
    .fetch_optional(&st.pool)
    .await;

    match row {
        Ok(Some(r)) => {
            let caller = Caller {
                user_id: r.get("user_id"),
                device_id: r.get("device_id"),
                handle: r.get("handle"),
                display_name: r.get("display_name"),
                trainer_name: r.get("trainer_name"),
                avatar_url: r.get("avatar_url"),
                device_label: r.get("label"),
            };
            let _ = sqlx::query("UPDATE devices SET last_seen_at = datetime('now') WHERE id = ?1")
                .bind(&caller.device_id)
                .execute(&st.pool)
                .await;
            req.extensions_mut().insert(caller);
            next.run(req).await
        }
        Ok(None) => err(StatusCode::UNAUTHORIZED, "unknown or revoked device"),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, &format!("db error: {e}")),
    }
}

async fn health(State(st): State<AppState>) -> Response {
    match sqlx::query("PRAGMA journal_mode").fetch_one(&st.pool).await {
        Ok(r) => {
            let mode: String = r.try_get(0).unwrap_or_else(|_| "?".into());
            Json(json!({"ok": true, "service": "claude-hq-arena",
                        "impl": "rust", "db": format!("sqlite (journal_mode={mode})")}))
                .into_response()
        }
        Err(e) => Json(json!({"ok": false, "service": "claude-hq-arena",
                              "impl": "rust", "db": format!("unreachable: {e}")}))
            .into_response(),
    }
}

async fn me(req: Request) -> Response {
    let c = req.extensions().get::<Caller>().expect("caller set by middleware").clone();
    Json(json!({
        "handle": c.handle,
        "displayName": if c.display_name.is_empty() { c.handle.clone() } else { c.display_name },
        "trainerName": c.trainer_name,
        "avatarUrl": c.avatar_url,
        "deviceLabel": c.device_label,
    }))
    .into_response()
}

#[derive(Deserialize)]
struct WindowQ {
    #[serde(default)]
    window: Option<String>,
}

async fn board(State(st): State<AppState>, Query(q): Query<WindowQ>, req: Request) -> Response {
    let c = req.extensions().get::<Caller>().expect("caller").clone();
    let window = q.window.unwrap_or_else(|| "season".into());
    if !service::WINDOWS.contains(&window.as_str()) {
        return err(StatusCode::BAD_REQUEST,
                   &format!("window must be one of {}", service::WINDOWS.join(", ")));
    }
    match service::build_board(&st.pool, &window, Some(&c.user_id)).await {
        Ok(b) => Json(b).into_response(),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, &format!("{e}")),
    }
}

async fn post_stats(State(st): State<AppState>, req: Request) -> Response {
    let c = req.extensions().get::<Caller>().expect("caller").clone();
    let (_, body) = req.into_parts();
    let bytes = match axum::body::to_bytes(body, 8 * 1024 * 1024).await {
        Ok(b) => b,
        Err(_) => return err(StatusCode::BAD_REQUEST, "body too large"),
    };
    // deny_unknown_fields lives on the struct, so an unexpected field fails here.
    let payload: schemas::StatPayload = match serde_json::from_slice(&bytes) {
        Ok(p) => p,
        Err(e) => return err(StatusCode::UNPROCESSABLE_ENTITY, &format!("{e}")),
    };
    if payload.schema_version != 1 {
        return err(StatusCode::UNPROCESSABLE_ENTITY, "unsupported schemaVersion");
    }
    match service::ingest(&st.pool, &c.user_id, &c.device_id, &payload,
                          st.cfg.max_daily_prompts, st.cfg.max_daily_tools,
                          st.cfg.max_backfill_days).await {
        Ok(r) => Json(r).into_response(),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, &format!("{e}")),
    }
}

async fn ticket(State(st): State<AppState>, req: Request) -> Response {
    let c = req.extensions().get::<Caller>().expect("caller").clone();
    Json(json!({
        "ticket": auth::issue_ws_ticket(&st.cfg.secret_key, &c.user_id, st.cfg.ws_ticket_ttl_secs),
        "expiresIn": st.cfg.ws_ticket_ttl_secs,
    }))
    .into_response()
}

async fn list_rooms(State(st): State<AppState>) -> Response {
    Json(json!({ "rooms": st.rooms.summary().await })).into_response()
}

// --- websocket ------------------------------------------------------------

#[derive(Deserialize)]
struct TicketQ {
    ticket: String,
}

async fn room_ws(
    State(st): State<AppState>,
    Path(room_id): Path<String>,
    Query(q): Query<TicketQ>,
    ws: WebSocketUpgrade,
) -> Response {
    let Some(user_id) = auth::read_ws_ticket(&st.cfg.secret_key, &q.ticket) else {
        return err(StatusCode::UNAUTHORIZED, "invalid or expired ticket");
    };
    let room_id = room_id.chars().take(64).collect::<String>();
    if room_id.is_empty() {
        return err(StatusCode::BAD_REQUEST, "bad room id");
    }
    let row = sqlx::query("SELECT handle, display_name, avatar_url FROM users
                           WHERE id = ?1 AND is_active = 1")
        .bind(&user_id)
        .fetch_optional(&st.pool)
        .await;
    let Ok(Some(r)) = row else {
        return err(StatusCode::FORBIDDEN, "account disabled");
    };
    let handle: String = r.get("handle");
    let display: String = r.get("display_name");
    let member = Member {
        user_id,
        display_name: if display.is_empty() { handle.clone() } else { display },
        handle,
        avatar_url: r.get("avatar_url"),
    };
    ws.on_upgrade(move |socket| handle_socket(socket, st, room_id, member))
}

async fn handle_socket(socket: WebSocket, st: AppState, room_id: String, member: Member) {
    use futures::{SinkExt, StreamExt};
    let conn_id = st.conn_seq.fetch_add(1, Ordering::Relaxed);
    let Some((mut rx, roster, state)) = st.rooms.join(&room_id, conn_id, member.clone()).await
    else {
        return;
    };
    let (mut tx, mut recv) = socket.split();

    let welcome = json!({"type": "welcome", "room": room_id, "you": member.public(),
                         "members": roster, "state": state});
    if tx.send(Message::Text(welcome.to_string())).await.is_err() {
        st.rooms.leave(&room_id, conn_id).await;
        return;
    }

    // One task pumps the broadcast channel out; the main loop reads input.
    let mut out = tokio::spawn(async move {
        while let Ok(msg) = rx.recv().await {
            if tx.send(Message::Text(msg)).await.is_err() {
                break;
            }
        }
    });

    let rooms = st.rooms.clone();
    let rid = room_id.clone();
    let me = member.clone();
    let mut inbound = tokio::spawn(async move {
        while let Some(Ok(msg)) = recv.next().await {
            let Message::Text(text) = msg else { continue };
            if text.len() > 16 * 1024 {
                continue;
            }
            let Ok(v) = serde_json::from_str::<Value>(&text) else { continue };
            match v.get("type").and_then(|t| t.as_str()) {
                Some("say") => {
                    rooms.broadcast(&rid, json!({"type": "say", "from": me.public(),
                                                 "data": v.get("data")}).to_string()).await;
                }
                Some("state") => {
                    if let Some(patch) = v.get("patch").filter(|p| p.is_object()) {
                        if let Some(merged) = rooms.patch_state(&rid, patch).await {
                            rooms.broadcast(&rid, json!({"type": "state", "state": merged,
                                                         "by": me.public()}).to_string()).await;
                        }
                    }
                }
                Some("ping") => {
                    rooms.broadcast(&rid, json!({"type": "pong"}).to_string()).await;
                }
                _ => {}
            }
        }
    });

    tokio::select! {
        _ = &mut out => inbound.abort(),
        _ = &mut inbound => out.abort(),
    }
    st.rooms.leave(&room_id, conn_id).await;
}

// --- oauth ----------------------------------------------------------------

async fn github_start(State(st): State<AppState>) -> Response {
    if st.cfg.github_client_id.is_empty() {
        return err(StatusCode::SERVICE_UNAVAILABLE, "GitHub OAuth is not configured");
    }
    let state = auth::issue_ws_ticket(&st.cfg.secret_key, "oauth", 600);
    Redirect::temporary(&format!(
        "https://github.com/login/oauth/authorize?client_id={}&redirect_uri={}/v1/auth/github/callback&scope=read:user&state={}",
        st.cfg.github_client_id, st.cfg.public_base_url, state
    ))
    .into_response()
}

#[derive(Deserialize)]
struct CallbackQ {
    code: String,
    #[serde(default)]
    state: String,
}

async fn github_callback(State(st): State<AppState>, Query(q): Query<CallbackQ>) -> Response {
    if auth::read_ws_ticket(&st.cfg.secret_key, &q.state).as_deref() != Some("oauth") {
        return err(StatusCode::BAD_REQUEST, "invalid or expired state");
    }
    let client = reqwest::Client::new();
    let tok: Value = match client
        .post("https://github.com/login/oauth/access_token")
        .header("Accept", "application/json")
        .form(&[
            ("client_id", st.cfg.github_client_id.as_str()),
            ("client_secret", st.cfg.github_client_secret.as_str()),
            ("code", q.code.as_str()),
            ("redirect_uri", &format!("{}/v1/auth/github/callback", st.cfg.public_base_url)),
        ])
        .send().await.and_then(|r| r.error_for_status())
    {
        Ok(r) => r.json().await.unwrap_or_else(|_| json!({})),
        Err(e) => return err(StatusCode::BAD_GATEWAY, &format!("github unreachable: {e}")),
    };
    let Some(access) = tok.get("access_token").and_then(|v| v.as_str()) else {
        // Pass GitHub's own reason through -- "incorrect_client_credentials"
        // names the fix, where a flat failure message does not.
        let reason = tok.get("error_description").or_else(|| tok.get("error"))
            .and_then(|v| v.as_str()).unwrap_or("unknown reason");
        return err(StatusCode::BAD_REQUEST,
                   &format!("GitHub refused the token exchange: {reason}"));
    };
    let profile: Value = match client
        .get("https://api.github.com/user")
        .header("Authorization", format!("Bearer {access}"))
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "claude-hq-arena")
        .send().await
    {
        Ok(r) => r.json().await.unwrap_or_else(|_| json!({})),
        Err(e) => return err(StatusCode::BAD_GATEWAY, &format!("github unreachable: {e}")),
    };
    let Some(gh_id) = profile.get("id").and_then(|v| v.as_i64()) else {
        return err(StatusCode::BAD_REQUEST, "GitHub profile had no id");
    };
    let login: String = profile.get("login").and_then(|v| v.as_str()).unwrap_or("").into();
    let login: String = login.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').collect();
    let name = profile.get("name").and_then(|v| v.as_str()).unwrap_or(&login).to_string();
    let avatar = profile.get("avatar_url").and_then(|v| v.as_str()).unwrap_or("").to_string();

    let existing = sqlx::query("SELECT id FROM users WHERE github_id = ?1")
        .bind(gh_id).fetch_optional(&st.pool).await.ok().flatten();
    let user_id = match existing {
        Some(r) => {
            let id: String = r.get("id");
            let _ = sqlx::query("UPDATE users SET handle=?1, display_name=?2, avatar_url=?3 WHERE id=?4")
                .bind(&login).bind(&name).bind(&avatar).bind(&id).execute(&st.pool).await;
            id
        }
        None => {
            let id = uuid::Uuid::new_v4().to_string();
            if sqlx::query("INSERT INTO users (id, github_id, handle, display_name, avatar_url,
                            trainer_name, is_active, created_at)
                            VALUES (?1,?2,?3,?4,?5,'',1,datetime('now'))")
                .bind(&id).bind(gh_id).bind(&login).bind(&name).bind(&avatar)
                .execute(&st.pool).await.is_err()
            {
                return err(StatusCode::INTERNAL_SERVER_ERROR, "could not create user");
            }
            id
        }
    };

    let code = auth::new_pair_code();
    let expires = chrono::Utc::now() + chrono::Duration::seconds(st.cfg.pair_code_ttl_secs);
    if sqlx::query("INSERT INTO pair_codes (code, user_id, expires_at) VALUES (?1,?2,?3)")
        .bind(&code).bind(&user_id).bind(expires.format("%Y-%m-%d %H:%M:%S").to_string())
        .execute(&st.pool).await.is_err()
    {
        return err(StatusCode::INTERNAL_SERVER_ERROR, "could not mint a pairing code");
    }

    let mins = st.cfg.pair_code_ttl_secs / 60;
    Html(format!(
        r#"<!doctype html><meta charset="utf-8"><title>Claude HQ Arena &middot; pairing code</title>
<style>:root{{color-scheme:dark}}body{{margin:0;min-height:100vh;display:grid;place-items:center;
background:#0e1117;color:#e6edf3;font:15px/1.5 ui-sans-serif,-apple-system,Segoe UI,sans-serif}}
.card{{max-width:30rem;padding:2rem;text-align:center}}
code{{display:block;margin:1.5rem 0;padding:1rem;border-radius:.6rem;background:#161b22;
border:1px solid #30363d;color:#7ee787;font:600 1.6rem/1 ui-monospace,Menlo,monospace;
letter-spacing:.12em}}p{{color:#8b949e}}</style>
<div class="card"><h1>Signed in as {login}</h1>
<p>Paste this code into the <strong>&#127942; Arena</strong> tab in Claude HQ:</p>
<code>{code}</code><p>It expires in {mins} minutes and can be used once.</p></div>"#
    ))
    .into_response()
}

#[derive(Deserialize)]
struct PairReq {
    code: String,
    #[serde(default)]
    label: String,
}

async fn pair(State(st): State<AppState>, Json(req): Json<PairReq>) -> Response {
    let code = req.code.trim().to_uppercase();
    let row = sqlx::query("SELECT user_id, expires_at, used_at FROM pair_codes WHERE code = ?1")
        .bind(&code).fetch_optional(&st.pool).await.ok().flatten();
    let Some(r) = row else {
        return err(StatusCode::BAD_REQUEST, "pairing code is invalid, used, or expired");
    };
    if r.try_get::<Option<String>, _>("used_at").ok().flatten().is_some() {
        return err(StatusCode::BAD_REQUEST, "pairing code is invalid, used, or expired");
    }
    let expires: String = r.get("expires_at");
    let exp = chrono::NaiveDateTime::parse_from_str(&expires, "%Y-%m-%d %H:%M:%S")
        .or_else(|_| chrono::NaiveDateTime::parse_from_str(&expires, "%Y-%m-%dT%H:%M:%S%.f"));
    if exp.map(|e| e < chrono::Utc::now().naive_utc()).unwrap_or(true) {
        return err(StatusCode::BAD_REQUEST, "pairing code is invalid, used, or expired");
    }
    let user_id: String = r.get("user_id");

    let _ = sqlx::query("UPDATE pair_codes SET used_at = datetime('now') WHERE code = ?1")
        .bind(&code).execute(&st.pool).await;

    let token = auth::new_device_token();
    let label = if req.label.is_empty() { "claude-hq".to_string() } else { req.label };
    if sqlx::query("INSERT INTO devices (id, user_id, token_hash, label, created_at, revoked)
                    VALUES (?1,?2,?3,?4,datetime('now'),0)")
        .bind(uuid::Uuid::new_v4().to_string()).bind(&user_id)
        .bind(auth::hash_token(&token)).bind(&label.chars().take(64).collect::<String>())
        .execute(&st.pool).await.is_err()
    {
        return err(StatusCode::INTERNAL_SERVER_ERROR, "could not register the device");
    }

    let u = sqlx::query("SELECT handle, display_name, avatar_url FROM users WHERE id = ?1")
        .bind(&user_id).fetch_one(&st.pool).await;
    let (handle, display, avatar) = match u {
        Ok(r) => (r.get::<String, _>("handle"), r.get::<String, _>("display_name"),
                  r.get::<String, _>("avatar_url")),
        Err(_) => (String::new(), String::new(), String::new()),
    };
    Json(json!({"token": token, "handle": handle,
                "displayName": if display.is_empty() { handle.clone() } else { display },
                "avatarUrl": avatar}))
        .into_response()
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env()
            .add_directive("arena=info".parse()?))
        .init();

    let cfg = config::Settings::from_env();
    let pool = db::connect(&cfg.database_url).await?;
    let port: u16 = std::env::var("ARENA_BIND_PORT").ok()
        .and_then(|p| p.parse().ok()).unwrap_or(8081);
    let bind = format!("{}:{}", cfg.bind, port);

    let state = AppState {
        pool,
        cfg: Arc::new(cfg),
        rooms: RoomManager::new(),
        conn_seq: Arc::new(AtomicU64::new(1)),
    };

    // Routes needing a device token sit behind the middleware; everything
    // else is explicitly public.
    let guarded = Router::new()
        .route("/v1/stats", post(post_stats))
        .route("/v1/board", get(board))
        .route("/v1/me", get(me))
        .route("/v1/rooms", get(list_rooms))
        .route("/v1/auth/ticket", post(ticket))
        .layer(middleware::from_fn_with_state(state.clone(), require_device));

    let public = Router::new()
        .route("/health", get(health))
        .route("/v1/auth/github/start", get(github_start))
        .route("/v1/auth/github/callback", get(github_callback))
        .route("/v1/auth/pair", post(pair))
        .route("/v1/rooms/:room_id/ws", get(room_ws));

    let app = Router::new().merge(public).merge(guarded).with_state(state);

    tracing::info!("arena-rs listening on {bind}");
    let listener = tokio::net::TcpListener::bind(&bind).await?;
    axum::serve(listener, app).await?;
    Ok(())
}
