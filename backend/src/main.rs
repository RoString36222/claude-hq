//! Arena backend in Rust — a parallel implementation of `backend/`.
//!
//! Serves the same endpoints against the same SQLite file, so it can be run
//! alongside the Python one and swapped by changing which port Caddy proxies.

mod accounts;
mod archipelago;
mod auth;
mod boardstream;
mod boss;
mod cali;
mod cities;
mod cityplay; // HQ 3.22 Arena play's ghost frame
mod config;
mod cosmetics;
mod crews;
mod cups;
mod db;
mod fps;
mod strike;
mod hq;
mod hqstyle;
mod kart;
mod loot;
mod mapkey;
mod maps;
mod metrics;
mod market;
mod music;
mod nudges;
mod pantry;
mod platformer;
mod portraits;
mod prestige;
mod privrooms;
mod progress;
mod protocol;
mod quickplay;
mod rail;
mod rally;
mod realtime;
mod results;
mod rooms;
mod schemas;
mod scoring;
mod server_stats;
mod service;
mod skate;
mod skills;
mod sms; // HQ 3.15 the phone's Messages
mod sounds;
#[cfg(test)]
mod story_check;
mod valley;
mod vehicles;
mod casino; // HQ 3.7
mod garages; // [basement 3.4]
mod tuning; // HQ 3.13 the Tuning shop
mod pets; // HQ 3.14
mod weeks;
mod world;
// The world generator (HQ 3.0), served by world.rs. Parts (queries the City
// and server checks will use) have no caller yet.
#[allow(dead_code)]
mod worldgen;

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
use chrono::{SecondsFormat, Utc};
use rooms::{Member, RoomManager};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{Row, SqlitePool};
use std::collections::VecDeque;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};
use std::time::Instant;

#[derive(Clone)]
pub(crate) struct AppState {
    pub(crate) pool: SqlitePool,
    pub(crate) cfg: Arc<config::Settings>,
    pub(crate) rooms: RoomManager,
    pub(crate) kart: kart::KartHub,
    pub(crate) plat: platformer::PlatHub,
    pub(crate) fps: fps::FpsHub,
    pub(crate) strike: strike::StrikeHub,
    /// Valley Rally (Rust-only): its own lobby, referee and stage loop.
    pub(crate) rally: rally::RallyHub,
    /// The other eight Valley games plus Party Mode, behind one dispatcher.
    pub(crate) valley: valley::ValleyHub,
    /// Now Playing and listen-along rooms (memory only).
    pub(crate) music: music::MusicHub,
    pub(crate) conn_seq: Arc<AtomicU64>,
}

/// The authenticated caller, resolved from the bearer token on every request.
#[derive(Clone, Debug)]
pub(crate) struct Caller {
    pub(crate) user_id: String,
    pub(crate) device_id: String,
    pub(crate) handle: String,
    pub(crate) display_name: String,
    pub(crate) trainer_name: String,
    pub(crate) avatar_url: String,
    pub(crate) device_label: String,
}

pub(crate) fn err(code: StatusCode, msg: &str) -> Response {
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

/// Stamped into the image by ops/release.sh (a date + commit, e.g. 2026.10.07-76ee057).
fn arena_version() -> String {
    std::env::var("ARENA_VERSION").unwrap_or_else(|_| "dev".into())
}

/// `arena --health`: the container healthcheck. Asks this process's own /health
/// over plain TCP (the runtime image has no curl or python) and exits 0 only on
/// a 200 that says ok.
fn health_probe() -> i32 {
    use std::io::{Read, Write};
    let port = std::env::var("ARENA_BIND_PORT").unwrap_or_else(|_| "8081".into());
    let Ok(mut s) = std::net::TcpStream::connect(format!("127.0.0.1:{port}")) else { return 1 };
    let _ = s.set_read_timeout(Some(std::time::Duration::from_secs(5)));
    if s.write_all(b"GET /health HTTP/1.0\r\nHost: localhost\r\n\r\n").is_err() {
        return 1;
    }
    let mut body = String::new();
    let _ = s.read_to_string(&mut body);
    let ok = body.starts_with("HTTP/1.") && body.contains(" 200 ") && body.contains("\"ok\":true");
    if ok { 0 } else { 1 }
}

async fn health(State(st): State<AppState>) -> Response {
    match sqlx::query("PRAGMA journal_mode").fetch_one(&st.pool).await {
        Ok(r) => {
            let mode: String = r.try_get(0).unwrap_or_else(|_| "?".into());
            Json(json!({"ok": true, "service": "claude-hq-arena", "impl": "rust",
                        "version": arena_version(), "db": format!("sqlite (journal_mode={mode})")}))
                .into_response()
        }
        Err(e) => Json(json!({"ok": false, "service": "claude-hq-arena", "impl": "rust",
                              "version": arena_version(), "db": format!("unreachable: {e}")}))
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
        Ok(r) => {
            // Wake every open /v1/board/stream so a publish lands on friends'
            // boards immediately, instead of waiting out the 25s heartbeat.
            // Python does this from events.board_hub on the same condition.
            boardstream::publish_if_accepted(r.accepted);
            Json(r).into_response()
        }
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

    // ---- admission ---------------------------------------------------------
    // Everything below mirrors routes/rooms.py. Until now this was missing
    // entirely: a valid ticket got you into ANY room, so private-room
    // passwords, membership and bans were all bypassed. The guards existed in
    // privrooms/quickplay and were simply never called.
    //
    // Close-before-accept vs accept-then-close is deliberate and copied from
    // the Python: a close before accept surfaces as an HTTP rejection, while
    // Quick Play accepts first so the page reads 4403 instead of a bare 1006.

    // Someone's HQ: the owner, or anyone while the owner keeps it open.
    // hq_city (Arena City) is the one hq_ room open to anyone paired.
    if room_id.starts_with("hq_") && room_id != "hq_city" {
        let owner = &room_id[3..];
        let open: Option<(i64,)> = sqlx::query_as(
            "SELECT open FROM hq_profiles WHERE user_id = ?1")
            .bind(owner)
            .fetch_optional(&st.pool)
            .await
            .unwrap_or(None);
        let is_open = open.map(|o| o.0 != 0).unwrap_or(false);
        if owner != user_id && !is_open {
            return err(StatusCode::FORBIDDEN, "that HQ is closed to visitors");
        }
    }

    if room_id.starts_with("qp_") && !quickplay::admits(&room_id, &user_id) {
        // Accept, then close 4403 -- the page distinguishes this from a drop.
        return ws.on_upgrade(move |socket| async move {
            close_with(socket, 4403, "that Quick Play match isn't yours").await;
        });
    }

    // The page only opens a private room once the welcome says which one it is
    // (name, and your role for the owner controls); without it the room reads as
    // "this Arena is too old for rooms" and the page falls back to the Lobby.
    let mut room_info = Value::Null;
    if privrooms::is_private_id(&room_id) {
        match privrooms::admission(&st.pool, &room_id, &user_id).await {
            Ok(None) => return err(StatusCode::NOT_FOUND, "no such room"),
            Ok(Some((name, role))) => {
                let ok = matches!(role.as_deref(), Some("owner") | Some("member"));
                if !ok {
                    return err(StatusCode::FORBIDDEN, "join this room first");
                }
                room_info = json!({"kind": "private", "id": room_id, "name": name,
                                   "role": role.unwrap_or_default()});
            }
            Err(_) => return err(StatusCode::INTERNAL_SERVER_ERROR, "room lookup failed"),
        }
    }

    // Worn cosmetics ride along on the member so the roster can draw them.
    let cos = cosmetics::equipped_one(&st.pool, &user_id).await;

    let member = Member {
        user_id,
        display_name: if display.is_empty() { handle.clone() } else { display },
        handle,
        avatar_url: r.get("avatar_url"),
        cos,
    };
    ws.on_upgrade(move |socket| handle_socket(socket, st, room_id, member, room_info))
}

/// Accept the upgrade only to close it with a specific code, the way Starlette
/// does when a route accepts before refusing.
async fn close_with(socket: WebSocket, code: u16, reason: &'static str) {
    use futures::SinkExt;
    let (mut tx, _rx) = {
        use futures::StreamExt;
        socket.split()
    };
    let _ = tx
        .send(Message::Close(Some(axum::extract::ws::CloseFrame {
            code,
            reason: reason.into(),
        })))
        .await;
}

async fn handle_socket(socket: WebSocket, st: AppState, room_id: String, member: Member,
                       room_info: Value) {
    use futures::{SinkExt, StreamExt};
    let conn_id = st.conn_seq.fetch_add(1, Ordering::Relaxed);
    let _ws = metrics::ws_open();
    let Some((mut rx, mut direct, roster, state)) =
        st.rooms.join_direct(&room_id, conn_id, member.clone()).await
    else {
        return;
    };
    let (mut tx, mut recv) = socket.split();

    let welcome = json!({"type": "welcome", "room": room_id, "you": member.public(),
                         // Python sends roomInfo for qp_ rooms and null elsewhere;
                         // the page reads it to label the match.
                         "roomInfo": if room_id.starts_with("qp_") {
                             quickplay::room_info(&room_id).unwrap_or(Value::Null)
                         } else { room_info },
                         "members": roster, "state": state,
                         // Recent lobby chat, oldest first, so a joiner catches up.
                         "chat": st.rooms.chat_history(&room_id).await,
                         "arena": protocol::arena_info()});
    if tx.send(Message::Text(welcome.to_string())).await.is_err() {
        st.rooms.leave(&room_id, conn_id).await;
        return;
    }

    // One task pumps the room broadcast and this socket's direct queue (game
    // events for one socket, one user or a lobby) out; the main loop reads input.
    let mut out = tokio::spawn(async move {
        loop {
            let msg = tokio::select! {
                m = rx.recv() => match m { Ok(m) => m, Err(_) => break },
                Some(m) = direct.recv() => m,
            };
            if tx.send(Message::Text(msg)).await.is_err() {
                break;
            }
        }
    });

    let rooms = st.rooms.clone();
    let rid = room_id.clone();
    let me = member.clone();
    let games = st.kart.clone();
    let plat = st.plat.clone();
    let arena = st.fps.clone();
    let strike = st.strike.clone();
    let rally = st.rally.clone();
    let valley = st.valley.clone();
    let music = st.music.clone();
    let phone_valley = st.valley.clone();
    let mut inbound = tokio::spawn(async move {
        let mut music_lim = music::ConnLimits::new();
        let mut chat_times: VecDeque<Instant> = VecDeque::with_capacity(rooms::CHAT_RATE_COUNT);
        let mut phone_lim = phone::Limits::default();
        let mut ghost_lim = cityplay::Limits::default();
        while let Some(Ok(msg)) = recv.next().await {
            let Message::Text(text) = msg else { continue };
            // Both rejections are answered, not dropped: a client sending frames
            // into silence has no way to tell a server that hates its message
            // from one that has gone away. Python answers both too.
            //
            // The cap counts characters, as Python's `len(raw)` over a str does,
            // and only bothers counting when the byte length is already over --
            // under it there cannot be more characters than bytes.
            if text.len() > rooms::MAX_FRAME_CHARS
                && text.chars().count() > rooms::MAX_FRAME_CHARS
            {
                rooms.send_conn(&rid, conn_id,
                    json!({"type": "error", "error": "frame too large"}).to_string()).await;
                continue;
            }
            let v = match serde_json::from_str::<Value>(&text) {
                Ok(v) => v,
                Err(_) => {
                    rooms.send_conn(&rid, conn_id,
                        json!({"type": "error", "error": "malformed json"}).to_string()).await;
                    continue;
                }
            };
            // HQ 3.15 the phone: nearby chat and call ringing (hq rooms only), before the generic arms.
            let kind = v.get("type").and_then(|t| t.as_str());
            let near_say = kind == Some("say")
                && v.get("data").and_then(|d| d.get("kind")).and_then(|k| k.as_str()) == Some("near");
            if near_say || matches!(kind, Some("near_on") | Some("ring") | Some("ring_ans")) {
                let pv = phone_valley.clone();
                let r2 = rid.clone();
                phone::handle(&rooms, &rid, conn_id, &me, &v, &mut phone_lim, &mut chat_times,
                              move || pv.with_room(&r2, |rv| rv.hq.positions()).unwrap_or_default()).await;
                continue;
            }
            // HQ 3.22 Arena play: a race ghost for one player in this hq room (cityplay.rs)
            if kind == Some("ghost") {
                cityplay::handle(&rooms, &rid, conn_id, &me, &v, &mut ghost_lim).await;
                continue;
            }
            match kind {
                Some("say") => {
                    let data = v.get("data");
                    // Lobby chat rides the generic "say" relay as {kind: "chat", text},
                    // so pages that predate chat keep talking to pages that have it.
                    // Only here does the server clean the text, clip it, rate-limit the
                    // connection and keep it for whoever joins next.
                    if data.and_then(|d| d.get("kind")).and_then(|k| k.as_str()) == Some("chat") {
                        let Some(raw) = data.and_then(|d| d.get("text")).and_then(|t| t.as_str())
                        else {
                            rooms.send_conn(&rid, conn_id,
                                json!({"type": "error",
                                       "error": "chat: text must be a string"}).to_string()).await;
                            continue;
                        };
                        // Anything str.isprintable() rejects -- control characters, the
                        // exotic spaces, and invisible format characters such as bidi
                        // overrides and zero-width spaces -- becomes a space; runs of
                        // whitespace fold to one.
                        let cleaned: String = raw
                            .chars()
                            .map(|c| if rooms::py_printable(c) { c } else { ' ' })
                            .collect();
                        let text: String = cleaned
                            .split_whitespace()
                            .collect::<Vec<_>>()
                            .join(" ")
                            .chars()
                            .take(rooms::CHAT_MAX_CHARS)
                            .collect();
                        if text.is_empty() {
                            rooms.send_conn(&rid, conn_id,
                                json!({"type": "error",
                                       "error": "chat: empty message"}).to_string()).await;
                            continue;
                        }
                        // Sliding-window flood guard, per socket like the Python's
                        // Member.chat_times -- two tabs get two allowances.
                        let now = Instant::now();
                        let fresh = chat_times.len() < rooms::CHAT_RATE_COUNT
                            || now.duration_since(chat_times[0]).as_secs_f64()
                                >= rooms::CHAT_RATE_WINDOW;
                        if !fresh {
                            rooms.send_conn(&rid, conn_id,
                                json!({"type": "error",
                                       "error": format!(
                                           "chat: slow down \u{2014} at most {} messages every {} seconds",
                                           rooms::CHAT_RATE_COUNT,
                                           rooms::CHAT_RATE_WINDOW as i64)}).to_string()).await;
                            continue;
                        }
                        if chat_times.len() == rooms::CHAT_RATE_COUNT {
                            chat_times.pop_front();
                        }
                        chat_times.push_back(now);
                        rooms.chat_say(&rid, json!({
                            "type": "say", "from": me.public(),
                            "data": {"kind": "chat", "text": text},
                            "id": hex::encode(rand::random::<[u8; 6]>()),
                            "at": Utc::now().to_rfc3339_opts(SecondsFormat::Secs, false),
                        })).await;
                        continue;
                    }
                    rooms.broadcast(&rid, json!({"type": "say", "from": me.public(),
                                                 "data": data}).to_string()).await;
                }
                // Python answers a bad patch rather than dropping it.
                Some("state") => {
                    let Some(patch) = v.get("patch").filter(|p| p.is_object()) else {
                        rooms.send_conn(&rid, conn_id, json!({"type": "error",
                            "error": "patch must be an object"}).to_string()).await;
                        continue;
                    };
                    match rooms.patch_state(&rid, patch).await {
                        Some(merged) => {
                            rooms.broadcast(&rid, json!({"type": "state", "state": merged,
                                                         "by": me.public()}).to_string()).await;
                        }
                        None => {
                            rooms.send_conn(&rid, conn_id, json!({"type": "error",
                                "error": "state too large"}).to_string()).await;
                        }
                    }
                }
                // Listen-along: the room's shared queue and clock, and the DJ's spectrum.
                Some("music") => {
                    music.handle(&rooms, &rid, conn_id, &me, &mut music_lim, &v).await
                }
                // Python answers the one socket that asked, not the whole room.
                Some("ping") => {
                    rooms.send_conn(&rid, conn_id, json!({"type": "pong"}).to_string()).await;
                }
                Some("game") if v.get("g").and_then(|g| g.as_str()) == Some(platformer::GAME) => {
                    plat.handle(&rid, conn_id, &me, &v).await
                }
                Some("game") if v.get("g").and_then(|g| g.as_str()) == Some(fps::GAME) => {
                    arena.handle(&rid, conn_id, &me, &v).await
                }
                Some("game") if v.get("g").and_then(|g| g.as_str()) == Some(strike::GAME) => {
                    strike.handle(&rid, conn_id, &me, &v).await
                }
                Some("game") if v.get("g").and_then(|g| g.as_str()) == Some(rally::GAME) => {
                    rally.handle(&rid, conn_id, &me, &v).await
                }
                // A directed "come look at the Arena" ping. Carries no URL and no
                // command by design -- only who it is from and a short note -- so a
                // nudge can never make the recipient's machine open or do anything.
                // The recipient's client just shows a toast.
                Some("nudge") => {
                    let target = match v.get("to").and_then(|t| t.as_str()) {
                        Some(t) if !t.is_empty() => t.to_string(),
                        _ => {
                            rooms.send_conn(&rid, conn_id,
                                json!({"type": "error",
                                       "error": "nudge needs a target userId"}).to_string()).await;
                            continue;
                        }
                    };
                    let note: String = v.get("note").and_then(|n| n.as_str()).unwrap_or("")
                        .chars().filter(|c| rooms::py_printable(*c)).collect::<String>()
                        .trim().chars().take(120).collect();
                    let delivered = rooms.send_where_except(
                        &rid, conn_id, |m| m.user_id == target,
                        json!({"type": "nudge", "from": me.public(),
                               "note": note}).to_string()).await;
                    rooms.send_conn(&rid, conn_id,
                        json!({"type": "nudge_ack", "to": target,
                               "delivered": delivered}).to_string()).await;
                }

                // WebRTC setup for lobby voice: an offer / answer / ICE candidate for
                // ONE member, relayed only to that member's sockets and never
                // broadcast -- SDP and ICE candidates carry IP addresses, so only the
                // people you are actually talking to see yours. The payload is opaque
                // here; the 16 KiB frame cap bounds it. The audio itself never touches
                // this server: it flows browser to browser.
                Some("signal") => {
                    let target = match v.get("to").and_then(|t| t.as_str()) {
                        Some(t) if !t.is_empty() => t.to_string(),
                        _ => {
                            rooms.send_conn(&rid, conn_id,
                                json!({"type": "error",
                                       "error": "signal needs a target userId"}).to_string()).await;
                            continue;
                        }
                    };
                    let Some(data) = v.get("data").filter(|d| d.is_object()) else {
                        rooms.send_conn(&rid, conn_id,
                            json!({"type": "error",
                                   "error": "signal data must be an object"}).to_string()).await;
                        continue;
                    };
                    rooms.send_where_except(
                        &rid, conn_id, |m| m.user_id == target,
                        json!({"type": "signal", "from": me.public(),
                               "data": data}).to_string()).await;
                }

                Some("game") if v.get("g").and_then(|g| g.as_str()) == Some(kart::GAME) => {
                    games.handle(&rid, conn_id, &me, &v).await
                }
                // Every other game, and Party Mode, and the "unknown game"
                // answer for a `g` nothing runs. Python has one dispatcher for
                // all eleven; here the three real-time hubs still own theirs,
                // so this arm is what is left after kart, plat and fps.
                Some("game") => valley.handle(&rid, conn_id, &me, &v).await,
                // Python answers unknown types rather than dropping them, so a
                // client talking to an Arena that is too old finds out why.
                other => {
                    let shown = match other {
                        Some(k) => format!("'{k}'"),
                        None => "None".to_string(),
                    };
                    rooms.send_conn(&rid, conn_id,
                        json!({"type": "error",
                               "error": format!("unknown message type: {shown}")}).to_string()).await;
                }
            }
        }
    });

    tokio::select! {
        _ = &mut out => inbound.abort(),
        _ = &mut inbound => out.abort(),
    }
    // Games first: leave the lobby (a blip) while the room can still tell the others.
    st.kart.on_disconnect(&room_id, conn_id, &member).await;
    st.plat.on_disconnect(&room_id, conn_id, &member).await;
    st.fps.on_disconnect(&room_id, conn_id, &member).await;
    st.strike.on_disconnect(&room_id, conn_id, &member).await;
    st.rally.on_disconnect(&room_id, conn_id, &member).await;
    st.valley.on_disconnect(&room_id, conn_id, &member).await;
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
            // With a 3D portrait the shown avatar stays the portrait; the GitHub
            // picture is refreshed in its keeping place instead (portraits.rs).
            if portraits::keep_github_avatar(&st.pool, &id, &avatar).await {
                let _ = sqlx::query("UPDATE users SET handle=?1, display_name=?2 WHERE id=?3")
                    .bind(&login).bind(&name).bind(&id).execute(&st.pool).await;
            } else {
                let _ = sqlx::query("UPDATE users SET handle=?1, display_name=?2, avatar_url=?3 WHERE id=?4")
                    .bind(&login).bind(&name).bind(&avatar).bind(&id).execute(&st.pool).await;
            }
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

    let Some(code) = mint_pair_code(&st.pool, &user_id, st.cfg.pair_code_ttl_secs).await else {
        return err(StatusCode::INTERNAL_SERVER_ERROR, "could not mint a pairing code");
    };

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

/// A fresh one-use pairing code for `user_id`, valid for `ttl_secs`. The GitHub
/// callback and the dev login both hand one out; `/v1/auth/pair` redeems it.
async fn mint_pair_code(pool: &SqlitePool, user_id: &str, ttl_secs: i64) -> Option<String> {
    let code = auth::new_pair_code();
    let expires = chrono::Utc::now() + chrono::Duration::seconds(ttl_secs);
    sqlx::query("INSERT INTO pair_codes (code, user_id, expires_at) VALUES (?1,?2,?3)")
        .bind(&code).bind(user_id).bind(expires.format("%Y-%m-%d %H:%M:%S").to_string())
        .execute(pool).await.ok()?;
    Some(code)
}

// --- dev login (local runs only) --------------------------------------------
//
// POST /v1/auth/dev-login mints a pairing code for a local test user without
// GitHub, so a dashboard can pair to a local Arena headlessly. The route exists
// ONLY when ARENA_DEV_LOGIN=1 AND the Arena binds a loopback address; anywhere
// else axum answers 404. Never set in the Dockerfile or compose.

/// FNV-1a, 32-bit.
fn fnv1a32(s: &str) -> u32 {
    s.bytes().fold(0x811c_9dc5u32, |h, b| (h ^ u32::from(b)).wrapping_mul(0x0100_0193))
}

/// A dev user's GitHub id: negative, so it never collides with a real one, and
/// distinct per handle, so `ix_users_github_id` keeps one row per handle.
fn dev_github_id(handle: &str) -> i64 {
    -(1 + i64::from(fnv1a32(handle) % 2_147_483_647))
}

/// The flag must be exactly "1" and the bind a loopback address.
fn dev_login_allowed(flag: Option<&str>, bind: &str) -> bool {
    flag == Some("1") && matches!(bind, "127.0.0.1" | "localhost" | "::1")
}

/// `[a-z0-9-]{1,32}`.
fn dev_handle_ok(h: &str) -> bool {
    (1..=32).contains(&h.len()) && h.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// The user row for a dev handle, created on first use (one row per handle).
async fn dev_user(pool: &SqlitePool, handle: &str) -> Option<String> {
    let gh_id = dev_github_id(handle);
    let row = sqlx::query("SELECT id FROM users WHERE github_id = ?1")
        .bind(gh_id).fetch_optional(pool).await.ok()?;
    if let Some(r) = row {
        return Some(r.get("id"));
    }
    let id = uuid::Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO users (id, github_id, handle, display_name, avatar_url,
                 trainer_name, is_active, created_at)
                 VALUES (?1,?2,?3,?3,'','',1,datetime('now'))")
        .bind(&id).bind(gh_id).bind(handle).execute(pool).await.ok()?;
    Some(id)
}

#[derive(Clone)]
struct DevLogin {
    pool: SqlitePool,
    ttl_secs: i64,
    /// ARENA_DEV_HANDLE, default "dev": the handle of a body-less request.
    default_handle: String,
}

/// The dev-login route, or no route at all when not `allowed`.
fn dev_routes<S: Clone + Send + Sync + 'static>(allowed: bool, dl: DevLogin) -> Router<S> {
    if !allowed {
        return Router::new();
    }
    Router::new().route("/v1/auth/dev-login", post(dev_login)).with_state(dl)
}

/// Raw bytes, not axum's `Json`, which answers 415 to a body-less POST.
async fn dev_login(State(dl): State<DevLogin>, body: axum::body::Bytes) -> Response {
    let handle = if body.iter().all(u8::is_ascii_whitespace) {
        dl.default_handle.clone()
    } else {
        match serde_json::from_slice::<Value>(&body) {
            Ok(Value::Object(m)) => match m.get("handle") {
                None => dl.default_handle.clone(),
                Some(Value::String(h)) => h.clone(),
                Some(_) => return err(StatusCode::BAD_REQUEST, "handle must be [a-z0-9-]{1,32}"),
            },
            _ => return err(StatusCode::BAD_REQUEST, "body must be a JSON object"),
        }
    };
    if !dev_handle_ok(&handle) {
        return err(StatusCode::BAD_REQUEST, "handle must be [a-z0-9-]{1,32}");
    }
    let Some(user_id) = dev_user(&dl.pool, &handle).await else {
        return err(StatusCode::INTERNAL_SERVER_ERROR, "could not create user");
    };
    let Some(code) = mint_pair_code(&dl.pool, &user_id, dl.ttl_secs).await else {
        return err(StatusCode::INTERNAL_SERVER_ERROR, "could not mint a pairing code");
    };
    Json(json!({"code": code, "handle": handle, "expiresInSecs": dl.ttl_secs})).into_response()
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
        .bind(auth::hash_token(&token)).bind(label.chars().take(64).collect::<String>())
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

fn main() -> anyhow::Result<()> {
    if std::env::args().any(|a| a == "--health") {
        std::process::exit(health_probe());
    }
    tokio::runtime::Builder::new_multi_thread().enable_all().build()?.block_on(serve())
}

async fn serve() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env()
            .add_directive("arena=info".parse()?))
        .init();

    let cfg = config::Settings::from_env();
    let pool = db::connect(&cfg.database_url).await?;

    // Schema ownership lives here now, not in Alembic. Applying migrations
    // before anything binds a port means a database this binary cannot serve
    // stops the process rather than producing confusing 500s at runtime.
    if let Err(e) = db::migrate(&pool).await {
        eprintln!("arena: {e}");
        std::process::exit(1);
    }

    let port: u16 = std::env::var("ARENA_BIND_PORT").ok()
        .and_then(|p| p.parse().ok()).unwrap_or(8081);
    let bind = format!("{}:{}", cfg.bind, port);

    let rooms = RoomManager::new();
    let started = std::time::Instant::now();
    // One budget of game loops for the whole process, shared by every real-time game.
    let registry = realtime::Registry::new(realtime::MAX_TICKERS);
    // A monotonic game clock in seconds (the Python's time.monotonic()).
    let clock: realtime::Clock = Arc::new(move || 1000.0 + started.elapsed().as_secs_f64());
    // Every game the Arena referees writes its results down through this.
    let rec = results::Recorder::new(pool.clone());
    let kart = kart::KartHub::new(rooms.clone(), registry.clone(), clock.clone(), rec.clone());
    let plat = platformer::PlatHub::new(rooms.clone(), registry.clone(), clock.clone(), rec.clone());
    let fps = fps::FpsHub::new(rooms.clone(), registry.clone(), clock.clone(), rec.clone());
    let strike = strike::StrikeHub::new(rooms.clone(), registry.clone(), clock.clone(), rec.clone());
    let rally = rally::RallyHub::new(rooms.clone(), registry.clone(), clock.clone(), rec.clone());
    // Some(pool): the farm is the only Valley game that persists anything, and
    // with None it would run and silently forget every seed, plant and harvest.
    let valley = valley::ValleyHub::new(
        rooms.clone(), registry, clock, valley::system_wall(), valley::entropy_dice(), rec,
        Some(pool.clone()),
    );
    // City tax and market ticks (HQ 3.x); reads also catch up lazily.
    cities::spawn_hourly(pool.clone());
    let state = AppState {
        pool,
        cfg: Arc::new(cfg),
        rooms,
        kart,
        plat,
        fps,
        strike,
        rally,
        valley,
        music: music::MusicHub::default(),
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
        .merge(boss::routes())
        .merge(cali::routes())
        .merge(cities::routes())
        .merge(cosmetics::routes())
        .merge(accounts::routes())
        .merge(archipelago::routes())
        .merge(rail::routes())
        .merge(crews::routes())
        .merge(cups::routes())
        .merge(hq::routes())
        .merge(loot::routes())
        .merge(maps::routes())
        .merge(market::routes())
        .merge(music::routes())
        .merge(portraits::routes())
        .merge(nudges::routes())
        .merge(pantry::routes())
        .merge(privrooms::routes())
        .merge(prestige::routes())
        .merge(progress::routes())
        .merge(quickplay::routes())
        .merge(server_stats::routes())
        .merge(skate::routes())
        .merge(skills::routes())
        .merge(sms::routes()) // HQ 3.15 the phone's Messages
        .merge(sounds::routes())
        .merge(vehicles::routes())
        .merge(casino::routes())
        .merge(garages::routes()) // [basement 3.4]
        .merge(tuning::routes()) // HQ 3.13
        .merge(pets::routes()) // HQ 3.14
        .layer(middleware::from_fn_with_state(state.clone(), require_device));

    let public = Router::new()
        .route("/health", get(health))
        .route("/v1/auth/github/start", get(github_start))
        .route("/v1/auth/github/callback", get(github_callback))
        .route("/v1/auth/pair", post(pair))
        .route("/v1/rooms/:room_id/ws", get(room_ws))
        .merge(boardstream::routes())
        // Unauthenticated, and only when ARENA_EXPOSE_REALTIME_STATS=1.
        .merge(server_stats::public_routes())
        .merge(portraits::public_routes())
        // GET /v1/world/:id; the preview and viewer only when ARENA_WORLD_PREVIEW=1.
        .merge(world::public_routes());

    let dev = dev_login_allowed(std::env::var("ARENA_DEV_LOGIN").ok().as_deref(), &state.cfg.bind);
    if dev {
        tracing::warn!("ARENA_DEV_LOGIN=1: POST /v1/auth/dev-login mints pairing codes without GitHub (local runs only)");
    }
    let dev_state = DevLogin {
        pool: state.pool.clone(),
        ttl_secs: state.cfg.pair_code_ttl_secs,
        default_handle: std::env::var("ARENA_DEV_HANDLE").unwrap_or_else(|_| "dev".into()),
    };
    if dev && !dev_handle_ok(&dev_state.default_handle) {
        anyhow::bail!("ARENA_DEV_HANDLE must match [a-z0-9-]{{1,32}}, got {:?}", dev_state.default_handle);
    }

    // Prometheus metrics on their own listener (never routed by Caddy); off when unset.
    metrics::init();
    if let Some(mb) = std::env::var("ARENA_METRICS_BIND").ok().filter(|v| !v.is_empty()) {
        let ml = tokio::net::TcpListener::bind(&mb).await?;
        let mr = metrics::router(state.clone());
        tracing::info!("metrics on {mb}/metrics");
        tokio::spawn(async move {
            if let Err(e) = axum::serve(ml, mr).await { tracing::error!("metrics listener: {e}"); }
        });
    }

    let app = Router::new().merge(public).merge(guarded).merge(dev_routes(dev, dev_state))
        .with_state(state)
        .layer(middleware::from_fn(metrics::track));

    tracing::info!("arena-rs listening on {bind}");
    let listener = tokio::net::TcpListener::bind(&bind).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

/// HQ 3.15 the phone over the room socket (docs/plans/transport-revamp.md 5.11), in hq rooms only (`hq_<owner>`
/// and `hq_city`), the "phone" capability in protocol.rs:
///   {type: "near_on", on}                       nearby chat on or off for THIS socket (rooms::set_near)
///   {type: "say", data: {kind: "near", text}}   to the sockets in the room that turned nearby on and whose person
///                                               stands on the sender's floor within NEAR_CM (valley/hq.rs
///                                               positions); at most NEAR_MAX_CHARS, under the lobby chat's rate
///                                               limit, never kept in the room's chat history
///   {type: "ring", to, id} / {type: "ring_ans", to, id, ok}   to the target's sockets in this room only; RING_PER_MIN
///                                               rings a minute per socket; the call itself is WebRTC set up over
///                                               the existing {type: "signal"} and flows browser to browser
/// Nothing here is stored. The text is what a player typed into Nearby.
mod phone {
    use crate::rooms::{self, Member, RoomManager};
    use chrono::{SecondsFormat, Utc};
    use serde_json::{json, Value};
    use std::collections::VecDeque;
    use std::time::Instant;

    /// Nearby means the same floor and within 40 m (cm).
    pub const NEAR_CM: i64 = 4_000;
    pub const NEAR_MAX_CHARS: usize = 200;
    pub const RING_PER_MIN: usize = 6;
    pub const RING_ANS_PER_MIN: usize = 12;

    /// A sliding one-minute window.
    #[derive(Default)]
    pub struct Window(VecDeque<Instant>);

    impl Window {
        pub fn allow(&mut self, now: Instant, max: usize) -> bool {
            while self.0.front().is_some_and(|t| now.duration_since(*t).as_secs_f64() >= 60.0) {
                self.0.pop_front();
            }
            if self.0.len() >= max {
                return false;
            }
            self.0.push_back(now);
            true
        }
    }

    /// One socket's phone allowances.
    #[derive(Default)]
    pub struct Limits {
        pub ring: Window,
        pub ans: Window,
    }

    /// The lobby chat's flood guard (main.rs "say" kind "chat"), shared so nearby and lobby chat spend one allowance.
    pub fn chat_allow(times: &mut VecDeque<Instant>, now: Instant) -> bool {
        let fresh = times.len() < rooms::CHAT_RATE_COUNT
            || now.duration_since(times[0]).as_secs_f64() >= rooms::CHAT_RATE_WINDOW;
        if !fresh {
            return false;
        }
        if times.len() == rooms::CHAT_RATE_COUNT {
            times.pop_front();
        }
        times.push_back(now);
        true
    }

    /// The lobby chat's cleaning (unprintables become spaces, runs of whitespace fold), cut at NEAR_MAX_CHARS.
    pub fn clean_near(raw: &str) -> Option<String> {
        let cleaned: String = raw.chars().map(|c| if rooms::py_printable(c) { c } else { ' ' }).collect();
        let text: String = cleaned.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(NEAR_MAX_CHARS).collect();
        (!text.is_empty()).then_some(text)
    }

    /// Who hears `from`: everyone else on the same floor within NEAR_CM, with the distance in whole metres. None
    /// when the sender has no known position (they never sent one).
    pub fn audience(pos: &[(String, String, i64, i64)], from: &str) -> Option<Vec<(String, i64)>> {
        let (_, w, x, z) = pos.iter().find(|p| p.0 == from)?;
        Some(pos.iter().filter(|p| p.0 != from && p.1 == *w).filter_map(|p| {
            let (dx, dz) = ((p.2 - x) as f64, (p.3 - z) as f64);
            let d = (dx * dx + dz * dz).sqrt();
            (d <= NEAR_CM as f64).then(|| (p.0.clone(), (d / 100.0).round() as i64))
        }).collect())
    }

    fn call_id_ok(s: &str) -> bool {
        !s.is_empty() && s.len() <= 40 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    }

    async fn error(rooms: &RoomManager, rid: &str, conn: u64, e: &str) {
        rooms.send_conn(rid, conn, json!({"type": "error", "error": e}).to_string()).await;
    }

    #[allow(clippy::too_many_arguments)] // the socket's own context, passed through from handle_socket
    pub async fn handle(rooms: &RoomManager, rid: &str, conn: u64, me: &Member, v: &Value, lim: &mut Limits,
                        chat_times: &mut VecDeque<Instant>, positions: impl FnOnce() -> Vec<(String, String, i64, i64)>) {
        if !rid.starts_with("hq_") {
            return error(rooms, rid, conn, "phone: only in an HQ or the City").await;
        }
        let now = Instant::now();
        match v.get("type").and_then(Value::as_str) {
            Some("near_on") => {
                let on = v.get("on").and_then(Value::as_bool).unwrap_or(false);
                rooms.set_near(rid, conn, on).await;
                rooms.send_conn(rid, conn, json!({"type": "near_on", "on": on}).to_string()).await;
            }
            Some("say") => {
                if !rooms.near_on(rid, conn).await {
                    return error(rooms, rid, conn, "nearby: turn on Nearby first").await;
                }
                let Some(raw) = v.get("data").and_then(|d| d.get("text")).and_then(Value::as_str) else {
                    return error(rooms, rid, conn, "nearby: text must be a string").await;
                };
                let Some(text) = clean_near(raw) else { return error(rooms, rid, conn, "nearby: empty message").await };
                if !chat_allow(chat_times, now) {
                    return error(rooms, rid, conn, &format!("chat: slow down \u{2014} at most {} messages every {} seconds",
                                                            rooms::CHAT_RATE_COUNT, rooms::CHAT_RATE_WINDOW as i64)).await;
                }
                let Some(who) = audience(&positions(), &me.user_id) else {
                    return error(rooms, rid, conn, "nearby: walk into the City first").await;
                };
                let id = hex::encode(rand::random::<[u8; 6]>());
                let at = Utc::now().to_rfc3339_opts(SecondsFormat::Secs, false);
                let mut reached = 0;
                for (uid, d) in &who {
                    let msg = json!({"type": "say", "from": me.public(), "data": {"kind": "near", "text": text, "d": d},
                                     "id": id, "at": at});
                    reached += rooms.send_near(rid, conn, |m| m.user_id == *uid, msg.to_string()).await;
                }
                rooms.send_conn(rid, conn, json!({"type": "near_ack", "id": id, "n": reached}).to_string()).await;
            }
            Some(k @ ("ring" | "ring_ans")) => {
                let to = v.get("to").and_then(Value::as_str).filter(|t| !t.is_empty() && *t != me.user_id);
                let id = v.get("id").and_then(Value::as_str).filter(|i| call_id_ok(i));
                let (Some(to), Some(id)) = (to, id) else {
                    return error(rooms, rid, conn, &format!("{k} needs a target userId and a call id")).await;
                };
                let ring = k == "ring";
                let ok = v.get("ok").and_then(Value::as_bool);
                if !ring && ok.is_none() {
                    return error(rooms, rid, conn, "ring_ans: ok must be true or false").await;
                }
                let allowed = if ring { lim.ring.allow(now, RING_PER_MIN) } else { lim.ans.allow(now, RING_ANS_PER_MIN) };
                if !allowed {
                    return error(rooms, rid, conn, "calls: slow down \u{2014} at most 6 calls a minute").await;
                }
                let msg = if ring {
                    json!({"type": "ring", "from": me.public(), "id": id})
                } else {
                    json!({"type": "ring_ans", "from": me.public(), "id": id, "ok": ok})
                };
                let n = rooms.send_where_except(rid, conn, |m| m.user_id == to, msg.to_string()).await;
                if ring {
                    rooms.send_conn(rid, conn, json!({"type": "ring_ack", "to": to, "id": id, "delivered": n}).to_string()).await;
                }
            }
            _ => {}
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn member(id: &str) -> Member {
            Member { user_id: id.into(), handle: id.into(), display_name: id.into(), avatar_url: String::new(), cos: Value::Null }
        }

        fn p(u: &str, w: &str, x: i64, z: i64) -> (String, String, i64, i64) {
            (u.into(), w.into(), x, z)
        }

        fn drain(rx: &mut tokio::sync::mpsc::Receiver<String>) -> Vec<Value> {
            let mut out = Vec::new();
            while let Ok(m) = rx.try_recv() {
                out.push(serde_json::from_str(&m).unwrap());
            }
            out
        }

        #[test]
        fn who_is_near() {
            let w = "city3d:claude-hq@3";
            let pos = vec![p("a", w, 0, 0), p("b", w, 3000, 2600), p("c", w, 4000, 0), p("d", w, 4001, 0),
                           p("e", "city3d:claude-hq@2", 10, 0), p("f", w, -100, 0)];
            assert_eq!(audience(&pos, "a").unwrap(), vec![("b".into(), 40), ("c".into(), 40), ("f".into(), 1)]);
            assert!(audience(&pos, "zed").is_none());
            assert_eq!(audience(&[p("a", w, 0, 0)], "a").unwrap(), vec![]);
        }

        #[test]
        fn the_text_and_the_windows() {
            assert_eq!(clean_near("  hi\u{202e}  there\n").unwrap(), "hi there");
            assert!(clean_near(" \u{200b} ").is_none());
            assert_eq!(clean_near(&"x".repeat(500)).unwrap().chars().count(), NEAR_MAX_CHARS);
            let t0 = Instant::now();
            let mut w = Window::default();
            for _ in 0..RING_PER_MIN {
                assert!(w.allow(t0, RING_PER_MIN));
            }
            assert!(!w.allow(t0 + std::time::Duration::from_secs(59), RING_PER_MIN));
            assert!(w.allow(t0 + std::time::Duration::from_secs(60), RING_PER_MIN));
            let mut ct = VecDeque::new();
            for _ in 0..rooms::CHAT_RATE_COUNT {
                assert!(chat_allow(&mut ct, t0));
            }
            assert!(!chat_allow(&mut ct, t0));
            assert!(chat_allow(&mut ct, t0 + std::time::Duration::from_secs(11)));
        }

        #[tokio::test]
        async fn nearby_goes_to_opted_in_people_within_forty_metres_and_is_not_kept() {
            let r = RoomManager::new();
            let rid = "hq_city";
            let (_, mut a, _, _) = r.join_direct(rid, 1, member("ann")).await.unwrap();
            let (_, mut b, _, _) = r.join_direct(rid, 2, member("bob")).await.unwrap();
            let (_, mut c, _, _) = r.join_direct(rid, 3, member("cat")).await.unwrap();
            let (_, mut d, _, _) = r.join_direct(rid, 4, member("dan")).await.unwrap();
            let w = "city3d:claude-hq@3";
            let pos = move || vec![p("ann", w, 0, 0), p("bob", w, 1000, 0), p("cat", w, 9000, 0), p("dan", w, 500, 0)];
            let (mut lim, mut ct) = (Limits::default(), VecDeque::new());
            let say = json!({"type": "say", "data": {"kind": "near", "text": " hello  there "}});
            // not opted in: refused
            handle(&r, rid, 1, &member("ann"), &say, &mut lim, &mut ct, pos).await;
            assert_eq!(drain(&mut a)[0]["error"], "nearby: turn on Nearby first");
            for conn in [1, 2, 3] {
                handle(&r, rid, conn, &member(["ann", "bob", "cat"][conn as usize - 1]), &json!({"type": "near_on", "on": true}),
                       &mut lim, &mut ct, pos).await;
            }
            assert_eq!(drain(&mut a), vec![json!({"type": "near_on", "on": true})]);
            drain(&mut b);
            drain(&mut c);
            handle(&r, rid, 1, &member("ann"), &say, &mut lim, &mut ct, pos).await;
            let got = drain(&mut b);
            assert_eq!(got.len(), 1);
            assert_eq!(got[0]["type"], "say");
            assert_eq!(got[0]["data"], json!({"kind": "near", "text": "hello there", "d": 10}));
            assert_eq!(got[0]["from"]["userId"], "ann");
            assert!(drain(&mut c).is_empty(), "cat is 90 m away");
            assert!(drain(&mut d).is_empty(), "dan is near but never turned nearby on");
            let ack = drain(&mut a);
            assert_eq!(ack[0]["type"], "near_ack");
            assert_eq!(ack[0]["n"], 1);
            assert_eq!(r.chat_history(rid).await, json!([]), "never kept in the room's chat");
            // the shared chat allowance runs dry
            for _ in 0..rooms::CHAT_RATE_COUNT {
                handle(&r, rid, 1, &member("ann"), &say, &mut lim, &mut ct, pos).await;
            }
            let last = drain(&mut a);
            assert!(last.last().unwrap()["error"].as_str().unwrap().starts_with("chat: slow down"));
            // outside an hq room: refused
            let (_, mut q, _, _) = r.join_direct("lobby", 9, member("ann")).await.unwrap();
            handle(&r, "lobby", 9, &member("ann"), &json!({"type": "near_on", "on": true}), &mut lim, &mut ct, Vec::new).await;
            assert_eq!(drain(&mut q)[0]["error"], "phone: only in an HQ or the City");
        }

        #[tokio::test]
        async fn rings_reach_only_the_target_in_the_room_six_a_minute() {
            let r = RoomManager::new();
            let rid = "hq_ann";
            let (_, mut a, _, _) = r.join_direct(rid, 1, member("ann")).await.unwrap();
            let (_, mut b, _, _) = r.join_direct(rid, 2, member("bob")).await.unwrap();
            let (_, mut c, _, _) = r.join_direct(rid, 3, member("cat")).await.unwrap();
            let (_, mut b_elsewhere, _, _) = r.join_direct("hq_city", 4, member("bob")).await.unwrap();
            let mut lim = Limits::default();
            let mut ct = VecDeque::new();
            let ring = json!({"type": "ring", "to": "bob", "id": "call-1"});
            handle(&r, rid, 1, &member("ann"), &ring, &mut lim, &mut ct, Vec::new).await;
            assert_eq!(drain(&mut b), vec![json!({"type": "ring", "from": member("ann").public(), "id": "call-1"})]);
            assert!(drain(&mut c).is_empty() && drain(&mut b_elsewhere).is_empty());
            assert_eq!(drain(&mut a), vec![json!({"type": "ring_ack", "to": "bob", "id": "call-1", "delivered": 1})]);
            let mut blim = Limits::default();
            handle(&r, rid, 2, &member("bob"), &json!({"type": "ring_ans", "to": "ann", "id": "call-1", "ok": true}),
                   &mut blim, &mut ct, Vec::new).await;
            assert_eq!(drain(&mut a), vec![json!({"type": "ring_ans", "from": member("bob").public(), "id": "call-1", "ok": true})]);
            assert!(drain(&mut b).is_empty() && drain(&mut c).is_empty());
            // bad frames
            for bad in [json!({"type": "ring", "to": "bob"}), json!({"type": "ring", "id": "x"}), json!({"type": "ring", "to": "ann", "id": "x"}),
                        json!({"type": "ring", "to": "bob", "id": "a b"}), json!({"type": "ring_ans", "to": "ann", "id": "x"})] {
                handle(&r, rid, 1, &member("ann"), &bad, &mut Limits::default(), &mut ct, Vec::new).await;
                assert!(drain(&mut a)[0]["error"].is_string(), "{bad}");
                assert!(drain(&mut b).is_empty());
            }
            // six a minute (one went already)
            for i in 0..5 {
                handle(&r, rid, 1, &member("ann"), &json!({"type": "ring", "to": "cat", "id": format!("c{i}")}), &mut lim, &mut ct, Vec::new).await;
            }
            assert_eq!(drain(&mut c).len(), 5);
            drain(&mut a);
            handle(&r, rid, 1, &member("ann"), &json!({"type": "ring", "to": "cat", "id": "c9"}), &mut lim, &mut ct, Vec::new).await;
            assert!(drain(&mut c).is_empty());
            assert!(drain(&mut a)[0]["error"].as_str().unwrap().contains("6 calls"));
        }
    }
}

#[cfg(test)]
mod dev_login_tests {
    use super::*;

    async fn pool() -> SqlitePool {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        db::migrate(&pool).await.unwrap();
        pool
    }

    /// The router on a real loopback port; returns its base URL.
    async fn serve(allowed: bool, pool: SqlitePool) -> String {
        let dl = DevLogin { pool, ttl_secs: 600, default_handle: "dev".into() };
        let app: Router = Router::new().route("/health", get(|| async { "ok" }))
            .merge(dev_routes(allowed, dl));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        format!("http://{addr}")
    }

    fn code_ok(c: &str) -> bool {
        // ^HQ-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$
        let ok = |p: &str| p.len() == 4 && p.bytes().all(|b| matches!(b, b'A'..=b'H' | b'J'..=b'N' | b'P'..=b'Z' | b'2'..=b'9'));
        let parts: Vec<&str> = c.split('-').collect();
        parts.len() == 3 && parts[0] == "HQ" && ok(parts[1]) && ok(parts[2])
    }

    #[test]
    fn the_allow_matrix() {
        for bind in ["127.0.0.1", "localhost", "::1"] {
            assert!(dev_login_allowed(Some("1"), bind), "{bind}");
            assert!(!dev_login_allowed(None, bind));
            for flag in ["0", "", "true", "yes", " 1", "1 "] {
                assert!(!dev_login_allowed(Some(flag), bind), "{flag:?} {bind}");
            }
        }
        for bind in ["0.0.0.0", "::", "192.168.1.5", "127.0.0.2", "LOCALHOST", ""] {
            assert!(!dev_login_allowed(Some("1"), bind), "{bind}");
        }
    }

    #[test]
    fn dev_github_ids_are_negative_and_distinct() {
        let (a, b) = (dev_github_id("dev"), dev_github_id("dev2"));
        assert!(a < 0 && b < 0 && a != b);
        assert_eq!(a, dev_github_id("dev"));
        // the extremes stay in range
        assert!((-2_147_483_647..=-1).contains(&a));
        assert_eq!(fnv1a32(""), 0x811c_9dc5);
        assert_eq!(fnv1a32("a"), 0xe40c_292c);
        assert!(dev_handle_ok("dev-2") && dev_handle_ok(&"a".repeat(32)));
        for bad in ["", "Dev", "a_b", "a b", "é", &"a".repeat(33)] {
            assert!(!dev_handle_ok(bad), "{bad:?}");
        }
    }

    #[tokio::test]
    async fn dev_user_is_one_row_per_handle() {
        let pool = pool().await;
        let a1 = dev_user(&pool, "dev").await.unwrap();
        let a2 = dev_user(&pool, "dev").await.unwrap();
        assert_eq!(a1, a2);
        let b = dev_user(&pool, "b").await.unwrap();
        assert_ne!(a1, b);
        let rows = sqlx::query("SELECT handle, github_id FROM users ORDER BY handle")
            .fetch_all(&pool).await.unwrap();
        let got: Vec<(String, i64)> = rows.iter().map(|r| (r.get("handle"), r.get("github_id"))).collect();
        assert_eq!(got, vec![("b".to_string(), dev_github_id("b")), ("dev".to_string(), dev_github_id("dev"))]);
        assert!(got.iter().all(|(_, g)| *g < 0));
    }

    #[tokio::test]
    async fn mint_pair_code_leaves_an_unused_row() {
        let pool = pool().await;
        let uid = dev_user(&pool, "dev").await.unwrap();
        let code = mint_pair_code(&pool, &uid, 600).await.unwrap();
        assert!(code_ok(&code), "{code}");
        let r = sqlx::query("SELECT user_id, used_at FROM pair_codes WHERE code = ?1")
            .bind(&code).fetch_one(&pool).await.unwrap();
        assert_eq!(r.get::<String, _>("user_id"), uid);
        assert!(r.get::<Option<String>, _>("used_at").is_none());
    }

    #[tokio::test]
    async fn the_route_takes_an_empty_body_or_a_handle() {
        let pool = pool().await;
        let base = serve(true, pool.clone()).await;
        let c = reqwest::Client::new();
        let url = format!("{base}/v1/auth/dev-login");
        // No body, no content type: the default handle (not a 415).
        let r = c.post(&url).send().await.unwrap();
        assert_eq!(r.status(), 200);
        let v: Value = r.json().await.unwrap();
        assert_eq!(v["handle"], "dev");
        assert_eq!(v["expiresInSecs"], 600);
        assert!(code_ok(v["code"].as_str().unwrap()), "{v}");
        let r = c.post(&url).header("Content-Type", "application/json").body(r#"{"handle":"b"}"#)
            .send().await.unwrap();
        assert_eq!(r.status(), 200);
        let w: Value = r.json().await.unwrap();
        assert_eq!(w["handle"], "b");
        assert_ne!(w["code"], v["code"]);
        assert_eq!(c.post(&url).body("{}").send().await.unwrap().status(), 200);
        for bad in [r#"{"handle":"Bad"}"#, r#"{"handle":""}"#, r#"{"handle":7}"#, "[1]", "nope"] {
            assert_eq!(c.post(&url).body(bad).send().await.unwrap().status(), 400, "{bad}");
        }
        let n: i64 = sqlx::query("SELECT COUNT(*) AS n FROM users").fetch_one(&pool).await.unwrap().get("n");
        assert_eq!(n, 2);
    }

    #[tokio::test]
    async fn the_route_is_absent_unless_allowed() {
        let pool = pool().await;
        let base = serve(false, pool.clone()).await;
        let c = reqwest::Client::new();
        assert_eq!(c.get(format!("{base}/health")).send().await.unwrap().status(), 200);
        let r = c.post(format!("{base}/v1/auth/dev-login")).body(r#"{"handle":"b"}"#).send().await.unwrap();
        assert_eq!(r.status(), 404);
        let n: i64 = sqlx::query("SELECT COUNT(*) AS n FROM pair_codes").fetch_one(&pool).await.unwrap().get("n");
        assert_eq!(n, 0);
    }
}
