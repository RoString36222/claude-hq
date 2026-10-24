//! The phone's Messages (HQ 3.15, docs/plans/transport-revamp.md D6 and 5.11): text messages between any two
//! players, online or offline.
//!
//! - Sending needs the sender's one-time opt-in (`sms_optin`, from Settings); receiving needs nothing.
//! - A message is 1..=[`TEXT_MAX`] printable characters (rooms::py_printable), trimmed; a control or invisible
//!   format character anywhere is refused, never silently cleaned, so what you typed is what they read.
//! - [`PER_MINUTE`] a minute and [`PER_DAY`] a day per sender, counted from the rows themselves (429).
//! - Kept at most [`KEEP_MS`] (7 days); older rows are pruned on every send and every inbox read.
//! - Acknowledging (`/v1/sms/ack`) stamps `delivered_at` and blanks the text: the words leave the server once the
//!   recipient has them; the row stays only for the sender's ticks and the rate limits until the prune.
//! - Blocking is silent: a send to someone who blocked you answers `{ok: true, id}` exactly as any other (the row
//!   is kept as `dropped`, so it still counts against your limits and never ticks "delivered") -- no block oracle.
//!   The directory never lists someone who blocked you.
//! - Yourself, an unknown id and a deactivated account answer the same 404.
//! - A recipient with a socket open anywhere also gets `{type: "sms", id, from: {id, name, handle}, text, at}` on
//!   it (rooms::deliver_to_user); otherwise their page drains `/v1/sms/inbox`.
//!
//! Privacy: only the text a player typed into Messages and the two user ids. Nothing from a transcript.

use axum::{
    extract::{Query, Request, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{Row, SqlitePool};

/// The longest message, in characters.
pub const TEXT_MAX: usize = 160;
/// Sends a sender may make in any minute, and in any day.
pub const PER_MINUTE: i64 = 10;
pub const PER_DAY: i64 = 100;
/// How long an undelivered message (and any row) is kept.
pub const KEEP_MS: i64 = 7 * 24 * 3600 * 1000;
/// The most messages one inbox read hands out (the rest come on the next read).
pub const INBOX_MAX: i64 = 200;
/// The most ids one status read looks at.
pub const STATUS_MAX: usize = 100;
/// The directory: the shortest prefix and the most people it answers with.
pub const DIR_MIN: usize = 2;
pub const DIR_MAX: i64 = 10;
/// Reports one person may file a day (more are answered ok and not stored).
pub const REPORTS_PER_DAY: i64 = 30;
/// A request body never needs more than this.
const MAX_BODY: usize = 4 * 1024;

const NOT_OPTED: &str = "turn on sending in Settings first";
const NO_SUCH: &str = "no such person";

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// A user id (or a message id) as the Arena makes them: 1..=64 ASCII letters, digits, `-` or `_`.
pub fn id_ok(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64 && s.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}

/// Trim, then refuse anything empty, longer than `max` characters, or holding a character Python's
/// `str.isprintable()` rejects (control characters, the exotic spaces, bidi overrides, zero-width ones).
pub fn clean_text(raw: &str, max: usize) -> Result<String, &'static str> {
    let t = raw.trim();
    if t.is_empty() {
        return Err("empty message");
    }
    if t.chars().count() > max {
        return Err("message too long");
    }
    if !t.chars().all(crate::rooms::py_printable) {
        return Err("message has characters that cannot be shown");
    }
    Ok(t.to_string())
}

/// Why a send failed: a status and the body's detail.
#[derive(Debug, PartialEq)]
pub struct Fail(pub StatusCode, pub &'static str);

fn db(_: sqlx::Error) -> Fail {
    Fail(StatusCode::INTERNAL_SERVER_ERROR, "database error")
}

/// A sent message: its id, and whether it is for delivery (false when the recipient blocked the sender).
#[derive(Debug)]
pub struct Sent {
    pub id: String,
    pub live: bool,
    pub at: i64,
    pub text: String,
}

pub async fn prune(pool: &SqlitePool, now: i64) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM sms_message WHERE at < ?1").bind(now - KEEP_MS).execute(pool).await?;
    Ok(())
}

pub async fn opted(pool: &SqlitePool, uid: &str) -> Result<bool, sqlx::Error> {
    Ok(sqlx::query("SELECT 1 FROM sms_optin WHERE user_id = ?1").bind(uid).fetch_optional(pool).await?.is_some())
}

pub async fn set_optin(pool: &SqlitePool, uid: &str, on: bool, now: i64) -> Result<bool, sqlx::Error> {
    if on {
        sqlx::query("INSERT OR IGNORE INTO sms_optin (user_id, on_at) VALUES (?1, ?2)")
            .bind(uid).bind(now).execute(pool).await?;
    } else {
        sqlx::query("DELETE FROM sms_optin WHERE user_id = ?1").bind(uid).execute(pool).await?;
    }
    opted(pool, uid).await
}

/// Whom `uid` blocks, oldest first.
pub async fn blocks(pool: &SqlitePool, uid: &str) -> Result<Vec<String>, sqlx::Error> {
    let rows = sqlx::query("SELECT blocked FROM sms_block WHERE user_id = ?1 ORDER BY at, blocked")
        .bind(uid).fetch_all(pool).await?;
    Ok(rows.iter().map(|r| r.get::<String, _>(0)).collect())
}

pub async fn set_block(pool: &SqlitePool, uid: &str, other: &str, on: bool, now: i64) -> Result<Vec<String>, sqlx::Error> {
    if on && other != uid {
        sqlx::query("INSERT OR IGNORE INTO sms_block (user_id, blocked, at) VALUES (?1, ?2, ?3)")
            .bind(uid).bind(other).bind(now).execute(pool).await?;
    } else if !on {
        sqlx::query("DELETE FROM sms_block WHERE user_id = ?1 AND blocked = ?2").bind(uid).bind(other).execute(pool).await?;
    }
    blocks(pool, uid).await
}

pub async fn unread(pool: &SqlitePool, uid: &str, now: i64) -> Result<i64, sqlx::Error> {
    let r = sqlx::query("SELECT COUNT(*) FROM sms_message WHERE recipient = ?1 AND delivered_at IS NULL AND dropped = 0 AND at >= ?2")
        .bind(uid).bind(now - KEEP_MS).fetch_one(pool).await?;
    Ok(r.get(0))
}

/// Send `text` from `from` to `to` at `now`. The order of the checks is the contract: opt-in (409), the text
/// (400), the recipient (404, the same for yourself, nobody and a deactivated account), the limits (429), then
/// the block (silently kept as dropped).
pub async fn send(pool: &SqlitePool, from: &str, to: &str, raw: &str, now: i64) -> Result<Sent, Fail> {
    if !opted(pool, from).await.map_err(db)? {
        return Err(Fail(StatusCode::CONFLICT, NOT_OPTED));
    }
    let text = clean_text(raw, TEXT_MAX).map_err(|m| Fail(StatusCode::BAD_REQUEST, m))?;
    if to == from || !id_ok(to) {
        return Err(Fail(StatusCode::NOT_FOUND, NO_SUCH));
    }
    let _ = prune(pool, now).await;
    // IMMEDIATE: the two counts and the insert must not interleave with another send from the same person.
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
    let found = sqlx::query("SELECT 1 FROM users WHERE id = ?1 AND is_active = 1")
        .bind(to).fetch_optional(&mut *tx).await.map_err(db)?;
    if found.is_none() {
        return Err(Fail(StatusCode::NOT_FOUND, NO_SUCH));
    }
    let count = |since: i64| sqlx::query("SELECT COUNT(*) FROM sms_message WHERE sender = ?1 AND at > ?2").bind(from).bind(since);
    let minute: i64 = count(now - 60_000).fetch_one(&mut *tx).await.map_err(db)?.get(0);
    if minute >= PER_MINUTE {
        return Err(Fail(StatusCode::TOO_MANY_REQUESTS, "slow down: at most 10 messages a minute"));
    }
    let day: i64 = count(now - 86_400_000).fetch_one(&mut *tx).await.map_err(db)?.get(0);
    if day >= PER_DAY {
        return Err(Fail(StatusCode::TOO_MANY_REQUESTS, "that is 100 messages today: try again tomorrow"));
    }
    let blocked = sqlx::query("SELECT 1 FROM sms_block WHERE user_id = ?1 AND blocked = ?2")
        .bind(to).bind(from).fetch_optional(&mut *tx).await.map_err(db)?.is_some();
    let id = uuid::Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO sms_message (id, sender, recipient, text, at, delivered_at, dropped) VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6)")
        .bind(&id).bind(from).bind(to).bind(if blocked { "" } else { text.as_str() }).bind(now).bind(blocked as i64)
        .execute(&mut *tx).await.map_err(db)?;
    tx.commit().await.map_err(db)?;
    Ok(Sent { id, live: !blocked, at: now, text })
}

/// The (at, id) of one of `uid`'s incoming messages, the cursor `since` / `upto` name.
async fn cursor(pool: &SqlitePool, uid: &str, id: &str) -> Result<Option<(i64, String)>, sqlx::Error> {
    if !id_ok(id) {
        return Ok(None);
    }
    let r = sqlx::query("SELECT at, id FROM sms_message WHERE id = ?1 AND recipient = ?2")
        .bind(id).bind(uid).fetch_optional(pool).await?;
    Ok(r.map(|r| (r.get(0), r.get(1))))
}

/// `uid`'s undelivered messages, oldest first, after `since` (a message id; unknown = from the start).
pub async fn inbox(pool: &SqlitePool, uid: &str, since: Option<&str>, now: i64) -> Result<Vec<Value>, sqlx::Error> {
    let _ = prune(pool, now).await;
    let (at0, id0) = match since {
        Some(s) => cursor(pool, uid, s).await?.unwrap_or((i64::MIN, String::new())),
        None => (i64::MIN, String::new()),
    };
    let rows = sqlx::query(
        "SELECT m.id, m.sender, m.text, m.at, u.handle, u.display_name FROM sms_message m
           JOIN users u ON u.id = m.sender
          WHERE m.recipient = ?1 AND m.delivered_at IS NULL AND m.dropped = 0
            AND (m.at > ?2 OR (m.at = ?2 AND m.id > ?3))
          ORDER BY m.at, m.id LIMIT ?4")
        .bind(uid).bind(at0).bind(&id0).bind(INBOX_MAX).fetch_all(pool).await?;
    Ok(rows.iter().map(|r| {
        let handle: String = r.get(4);
        let name: String = r.get(5);
        json!({"id": r.get::<String, _>(0),
               "from": {"id": r.get::<String, _>(1), "name": if name.is_empty() { handle.clone() } else { name }, "handle": handle},
               "text": r.get::<String, _>(2), "at": r.get::<i64, _>(3)})
    }).collect())
}

/// Mark every one of `uid`'s messages up to and including `upto` delivered and blank their text. Returns how many.
pub async fn ack(pool: &SqlitePool, uid: &str, upto: &str, now: i64) -> Result<u64, sqlx::Error> {
    let Some((at, id)) = cursor(pool, uid, upto).await? else { return Ok(0) };
    let r = sqlx::query(
        "UPDATE sms_message SET delivered_at = ?1, text = '' WHERE recipient = ?2 AND delivered_at IS NULL
            AND dropped = 0 AND (at < ?3 OR (at = ?3 AND id <= ?4))")
        .bind(now).bind(uid).bind(at).bind(&id).execute(pool).await?;
    Ok(r.rows_affected())
}

/// Of `ids`, the ones `uid` sent that have been delivered (the sender's ticks).
pub async fn status(pool: &SqlitePool, uid: &str, ids: &[String]) -> Result<Vec<String>, sqlx::Error> {
    let mut out = Vec::new();
    for id in ids.iter().filter(|i| id_ok(i)).take(STATUS_MAX) {
        let r = sqlx::query("SELECT 1 FROM sms_message WHERE id = ?1 AND sender = ?2 AND delivered_at IS NOT NULL")
            .bind(id).bind(uid).fetch_optional(pool).await?;
        if r.is_some() && !out.contains(id) {
            out.push(id.clone());
        }
    }
    Ok(out)
}

pub async fn report(pool: &SqlitePool, reporter: &str, sender: &str, msg_id: &str, now: i64) -> Result<bool, sqlx::Error> {
    let n: i64 = sqlx::query("SELECT COUNT(*) FROM sms_report WHERE reporter = ?1 AND at > ?2")
        .bind(reporter).bind(now - 86_400_000).fetch_one(pool).await?.get(0);
    if n >= REPORTS_PER_DAY {
        return Ok(false);
    }
    sqlx::query("INSERT INTO sms_report (id, reporter, sender, msg_id, at) VALUES (?1, ?2, ?3, ?4, ?5)")
        .bind(uuid::Uuid::new_v4().to_string()).bind(reporter).bind(sender).bind(msg_id).bind(now)
        .execute(pool).await?;
    Ok(true)
}

/// Active people whose handle starts with `q` (at least [`DIR_MIN`] characters, case-blind for ASCII), at most
/// [`DIR_MAX`], never the caller and never anyone who blocked the caller.
pub async fn directory(pool: &SqlitePool, uid: &str, q: &str) -> Result<Vec<Value>, sqlx::Error> {
    let q = q.trim();
    if q.chars().count() < DIR_MIN || q.chars().count() > 64 {
        return Ok(Vec::new());
    }
    let mut pat = String::new();
    for c in q.chars() {
        if matches!(c, '%' | '_' | '\\') {
            pat.push('\\');
        }
        pat.push(c);
    }
    pat.push('%');
    let rows = sqlx::query(
        "SELECT u.id, u.handle, u.display_name FROM users u
          WHERE u.is_active = 1 AND u.id != ?1 AND u.handle LIKE ?2 ESCAPE '\\'
            AND NOT EXISTS (SELECT 1 FROM sms_block b WHERE b.user_id = u.id AND b.blocked = ?1)
          ORDER BY u.handle, u.id LIMIT ?3")
        .bind(uid).bind(&pat).bind(DIR_MAX).fetch_all(pool).await?;
    Ok(rows.iter().map(|r| {
        let handle: String = r.get(1);
        let name: String = r.get(2);
        json!({"id": r.get::<String, _>(0), "name": if name.is_empty() { handle.clone() } else { name }, "handle": handle})
    }).collect())
}

// --- HTTP ------------------------------------------------------------------

fn caller(req: &Request) -> crate::Caller {
    req.extensions().get::<crate::Caller>().expect("caller set by middleware").clone()
}

fn fail(f: Fail) -> Response {
    crate::err(f.0, f.1)
}

fn dberr(_: sqlx::Error) -> Response {
    crate::err(StatusCode::INTERNAL_SERVER_ERROR, "database error")
}

/// The JSON object body, or the 400 to answer (boxed: a Response is large).
async fn body_of(req: Request) -> Result<serde_json::Map<String, Value>, Box<Response>> {
    let (_, body) = req.into_parts();
    let bytes = axum::body::to_bytes(body, MAX_BODY).await
        .map_err(|_| Box::new(crate::err(StatusCode::BAD_REQUEST, "body too large")))?;
    match serde_json::from_slice::<Value>(&bytes) {
        Ok(Value::Object(m)) => Ok(m),
        _ => Err(Box::new(crate::err(StatusCode::BAD_REQUEST, "body must be a JSON object"))),
    }
}

fn str_field<'a>(m: &'a serde_json::Map<String, Value>, k: &str) -> Option<&'a str> {
    m.get(k).and_then(Value::as_str)
}

async fn post_optin(State(st): State<crate::AppState>, req: Request) -> Response {
    let c = caller(&req);
    let m = match body_of(req).await { Ok(m) => m, Err(r) => return *r };
    let Some(on) = m.get("on").and_then(Value::as_bool) else {
        return crate::err(StatusCode::BAD_REQUEST, "on must be true or false");
    };
    match set_optin(&st.pool, &c.user_id, on, now_ms()).await {
        Ok(on) => Json(json!({"on": on})).into_response(),
        Err(e) => dberr(e),
    }
}

async fn get_me(State(st): State<crate::AppState>, req: Request) -> Response {
    let c = caller(&req);
    let now = now_ms();
    let (Ok(on), Ok(b), Ok(n)) = (opted(&st.pool, &c.user_id).await, blocks(&st.pool, &c.user_id).await,
                                  unread(&st.pool, &c.user_id, now).await)
    else { return crate::err(StatusCode::INTERNAL_SERVER_ERROR, "database error") };
    Json(json!({"on": on, "blocks": b, "unread": n})).into_response()
}

async fn post_send(State(st): State<crate::AppState>, req: Request) -> Response {
    let c = caller(&req);
    let m = match body_of(req).await { Ok(m) => m, Err(r) => return *r };
    let (Some(to), Some(text)) = (str_field(&m, "to"), str_field(&m, "text")) else {
        return crate::err(StatusCode::BAD_REQUEST, "to and text must be strings");
    };
    let sent = match send(&st.pool, &c.user_id, to, text, now_ms()).await {
        Ok(s) => s,
        Err(f) => return fail(f),
    };
    if sent.live {
        // Best effort, after the commit: the row is the delivery; the live copy only makes it instant.
        let name = if c.display_name.is_empty() { c.handle.clone() } else { c.display_name.clone() };
        let live = json!({"type": "sms", "id": sent.id, "from": {"id": c.user_id, "name": name, "handle": c.handle},
                          "text": sent.text, "at": sent.at});
        st.rooms.deliver_to_user(to, live.to_string()).await;
    }
    Json(json!({"ok": true, "id": sent.id})).into_response()
}

#[derive(Deserialize)]
struct SinceQ {
    #[serde(default)]
    since: Option<String>,
}

async fn get_inbox(State(st): State<crate::AppState>, Query(q): Query<SinceQ>, req: Request) -> Response {
    let c = caller(&req);
    match inbox(&st.pool, &c.user_id, q.since.as_deref().filter(|s| !s.is_empty()), now_ms()).await {
        Ok(ms) => Json(json!({"messages": ms})).into_response(),
        Err(e) => dberr(e),
    }
}

async fn post_ack(State(st): State<crate::AppState>, req: Request) -> Response {
    let c = caller(&req);
    let m = match body_of(req).await { Ok(m) => m, Err(r) => return *r };
    let Some(upto) = str_field(&m, "upto") else { return crate::err(StatusCode::BAD_REQUEST, "upto must be a message id") };
    match ack(&st.pool, &c.user_id, upto, now_ms()).await {
        Ok(_) => Json(json!({"ok": true})).into_response(),
        Err(e) => dberr(e),
    }
}

#[derive(Deserialize)]
struct IdsQ {
    #[serde(default)]
    ids: String,
}

async fn get_status(State(st): State<crate::AppState>, Query(q): Query<IdsQ>, req: Request) -> Response {
    let c = caller(&req);
    let ids: Vec<String> = q.ids.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).take(STATUS_MAX).collect();
    match status(&st.pool, &c.user_id, &ids).await {
        Ok(d) => Json(json!({"delivered": d})).into_response(),
        Err(e) => dberr(e),
    }
}

async fn post_block(State(st): State<crate::AppState>, req: Request) -> Response {
    let c = caller(&req);
    let m = match body_of(req).await { Ok(m) => m, Err(r) => return *r };
    let (Some(user), Some(on)) = (str_field(&m, "user").filter(|u| id_ok(u)), m.get("on").and_then(Value::as_bool)) else {
        return crate::err(StatusCode::BAD_REQUEST, "user must be a user id and on true or false");
    };
    match set_block(&st.pool, &c.user_id, user, on, now_ms()).await {
        Ok(b) => Json(json!({"blocks": b})).into_response(),
        Err(e) => dberr(e),
    }
}

async fn post_report(State(st): State<crate::AppState>, req: Request) -> Response {
    let c = caller(&req);
    let m = match body_of(req).await { Ok(m) => m, Err(r) => return *r };
    let Some(user) = str_field(&m, "user").filter(|u| id_ok(u)) else {
        return crate::err(StatusCode::BAD_REQUEST, "user must be a user id");
    };
    let msg = match m.get("id") {
        None | Some(Value::Null) => "",
        Some(Value::String(s)) if s.is_empty() || id_ok(s) => s.as_str(),
        _ => return crate::err(StatusCode::BAD_REQUEST, "id must be a message id"),
    };
    match report(&st.pool, &c.user_id, user, msg, now_ms()).await {
        Ok(_) => Json(json!({"ok": true})).into_response(),
        Err(e) => dberr(e),
    }
}

#[derive(Deserialize)]
struct DirQ {
    #[serde(default)]
    q: String,
}

async fn get_directory(State(st): State<crate::AppState>, Query(q): Query<DirQ>, req: Request) -> Response {
    let c = caller(&req);
    match directory(&st.pool, &c.user_id, &q.q).await {
        Ok(u) => Json(json!({"users": u})).into_response(),
        Err(e) => dberr(e),
    }
}

pub fn routes() -> Router<crate::AppState> {
    Router::new()
        .route("/v1/sms/optin", post(post_optin))
        .route("/v1/sms/me", get(get_me))
        .route("/v1/sms/send", post(post_send))
        .route("/v1/sms/inbox", get(get_inbox))
        .route("/v1/sms/ack", post(post_ack))
        .route("/v1/sms/status", get(get_status))
        .route("/v1/sms/block", post(post_block))
        .route("/v1/sms/report", post(post_report))
        .route("/v1/sms/directory", get(get_directory))
}

#[cfg(test)]
mod tests {
    use super::*;

    const T0: i64 = 1_800_000_000_000;

    async fn pool() -> SqlitePool {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        crate::db::migrate(&pool).await.unwrap();
        for (i, (id, h, active)) in [("ann", "ann", 1), ("bob", "bobby", 1), ("cat", "bobcat", 1), ("dead", "bobdead", 0), ("eve", "eve", 1)].into_iter().enumerate() {
            sqlx::query("INSERT INTO users (id, github_id, handle, display_name, avatar_url, trainer_name, is_active, created_at)
                         VALUES (?1, ?2, ?3, '', '', '', ?4, datetime('now'))")
                .bind(id).bind(i as i64 + 1).bind(h).bind(active).execute(&pool).await.unwrap();
        }
        pool
    }

    #[test]
    fn the_text_rules() {
        assert_eq!(clean_text("  hi there \u{1F44B} ", 160).unwrap(), "hi there \u{1F44B}");
        assert_eq!(clean_text("   ", 160), Err("empty message"));
        assert_eq!(clean_text("", 160), Err("empty message"));
        assert!(clean_text(&"x".repeat(160), 160).is_ok());
        assert_eq!(clean_text(&"x".repeat(161), 160), Err("message too long"));
        // counted in characters, not bytes
        assert!(clean_text(&"\u{1F44B}".repeat(160), 160).is_ok());
        for bad in ["a\u{7}b", "a\nb", "a\u{202e}b", "a\u{200b}b", "a\tb"] {
            assert!(clean_text(bad, 160).is_err(), "{bad:?}");
        }
        assert!(id_ok("0b8e4c1a-3f2d-4e5b-9a6c-7d8e9f0a1b2c") && !id_ok("") && !id_ok("a/b") && !id_ok(&"a".repeat(65)));
    }

    #[tokio::test]
    async fn sending_needs_the_senders_opt_in_and_receiving_needs_nothing() {
        let p = pool().await;
        assert_eq!(send(&p, "ann", "bob", "hi", T0).await.unwrap_err(), Fail(StatusCode::CONFLICT, NOT_OPTED));
        assert!(set_optin(&p, "ann", true, T0).await.unwrap());
        assert!(set_optin(&p, "ann", true, T0).await.unwrap()); // twice is fine
        // bob never opted in and still receives
        let s = send(&p, "ann", "bob", " hi bob ", T0).await.unwrap();
        assert!(s.live);
        assert_eq!(s.text, "hi bob");
        let ib = inbox(&p, "bob", None, T0 + 1).await.unwrap();
        assert_eq!(ib.len(), 1);
        assert_eq!(ib[0]["text"], "hi bob");
        assert_eq!(ib[0]["from"], json!({"id": "ann", "name": "ann", "handle": "ann"}));
        assert_eq!(ib[0]["id"], s.id);
        assert_eq!(ib[0]["at"], T0);
        // bob cannot answer until he opts in
        assert_eq!(send(&p, "bob", "ann", "yo", T0).await.unwrap_err().0, StatusCode::CONFLICT);
        assert!(!set_optin(&p, "ann", false, T0).await.unwrap());
        assert_eq!(send(&p, "ann", "bob", "hi", T0).await.unwrap_err().0, StatusCode::CONFLICT);
    }

    #[tokio::test]
    async fn caps_and_who_you_can_message() {
        let p = pool().await;
        set_optin(&p, "ann", true, T0).await.unwrap();
        assert_eq!(send(&p, "ann", "bob", &"x".repeat(161), T0).await.unwrap_err(), Fail(StatusCode::BAD_REQUEST, "message too long"));
        assert_eq!(send(&p, "ann", "bob", "  ", T0).await.unwrap_err().0, StatusCode::BAD_REQUEST);
        assert_eq!(send(&p, "ann", "bob", "a\u{0}b", T0).await.unwrap_err().0, StatusCode::BAD_REQUEST);
        // yourself, nobody and a deactivated account: the same 404
        let me = send(&p, "ann", "ann", "hi", T0).await.unwrap_err();
        let nobody = send(&p, "ann", "zed", "hi", T0).await.unwrap_err();
        let dead = send(&p, "ann", "dead", "hi", T0).await.unwrap_err();
        assert_eq!(me, Fail(StatusCode::NOT_FOUND, NO_SUCH));
        assert_eq!(me, nobody);
        assert_eq!(me, dead);
        assert_eq!(send(&p, "ann", "../x", "hi", T0).await.unwrap_err(), me);
        let n: i64 = sqlx::query("SELECT COUNT(*) FROM sms_message").fetch_one(&p).await.unwrap().get(0);
        assert_eq!(n, 0);
    }

    #[tokio::test]
    async fn ten_a_minute_and_a_hundred_a_day() {
        let p = pool().await;
        set_optin(&p, "ann", true, T0).await.unwrap();
        for i in 0..10 {
            send(&p, "ann", "bob", "hi", T0 + i).await.unwrap();
        }
        assert_eq!(send(&p, "ann", "cat", "hi", T0 + 10).await.unwrap_err().0, StatusCode::TOO_MANY_REQUESTS);
        // a minute on, ten more
        let mut t = T0 + 70_000;
        let mut sent = 10;
        while sent < 100 {
            for _ in 0..10 {
                send(&p, "ann", "bob", "hi", t).await.unwrap();
                sent += 1;
                t += 1;
            }
            t += 70_000;
        }
        let e = send(&p, "ann", "bob", "hi", t).await.unwrap_err();
        assert_eq!(e.0, StatusCode::TOO_MANY_REQUESTS);
        assert!(e.1.contains("100"));
        // the next day it opens again
        assert!(send(&p, "ann", "bob", "hi", t + 86_400_000).await.is_ok());
    }

    #[tokio::test]
    async fn a_block_is_silent_counts_and_never_ticks() {
        let p = pool().await;
        set_optin(&p, "ann", true, T0).await.unwrap();
        assert_eq!(set_block(&p, "bob", "ann", true, T0).await.unwrap(), vec!["ann".to_string()]);
        assert_eq!(set_block(&p, "bob", "bob", true, T0).await.unwrap(), vec!["ann".to_string()]); // never yourself
        let s = send(&p, "ann", "bob", "are you there", T0).await.unwrap();
        assert!(!s.live, "nothing is pushed to someone who blocked you");
        assert!(id_ok(&s.id));
        assert!(inbox(&p, "bob", None, T0).await.unwrap().is_empty());
        assert_eq!(unread(&p, "bob", T0).await.unwrap(), 0);
        // the words were never kept
        let t: String = sqlx::query("SELECT text FROM sms_message WHERE id = ?1").bind(&s.id).fetch_one(&p).await.unwrap().get(0);
        assert_eq!(t, "");
        // it still counts against the sender's limits, like any send (no oracle from the 429 either)
        for i in 1..10 {
            send(&p, "ann", "bob", "x", T0 + i).await.unwrap();
        }
        assert_eq!(send(&p, "ann", "cat", "x", T0 + 20).await.unwrap_err().0, StatusCode::TOO_MANY_REQUESTS);
        assert!(status(&p, "ann", std::slice::from_ref(&s.id)).await.unwrap().is_empty());
        // unblocked: new messages flow again
        assert!(set_block(&p, "bob", "ann", false, T0).await.unwrap().is_empty());
        let s2 = send(&p, "ann", "bob", "hello?", T0 + 120_000).await.unwrap();
        assert!(s2.live);
        assert_eq!(inbox(&p, "bob", None, T0 + 120_000).await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn kept_seven_days_then_pruned() {
        let p = pool().await;
        set_optin(&p, "ann", true, T0).await.unwrap();
        send(&p, "ann", "bob", "old", T0).await.unwrap();
        send(&p, "ann", "bob", "new", T0 + KEEP_MS - 1000).await.unwrap();
        assert_eq!(inbox(&p, "bob", None, T0 + KEEP_MS - 1).await.unwrap().len(), 2);
        let ib = inbox(&p, "bob", None, T0 + KEEP_MS + 1).await.unwrap();
        assert_eq!(ib.len(), 1);
        assert_eq!(ib[0]["text"], "new");
        let n: i64 = sqlx::query("SELECT COUNT(*) FROM sms_message").fetch_one(&p).await.unwrap().get(0);
        assert_eq!(n, 1, "the old row is gone, not hidden");
        // a send prunes too
        send(&p, "ann", "cat", "later", T0 + 2 * KEEP_MS).await.unwrap();
        let n: i64 = sqlx::query("SELECT COUNT(*) FROM sms_message").fetch_one(&p).await.unwrap().get(0);
        assert_eq!(n, 1);
    }

    #[tokio::test]
    async fn the_directory_by_handle_prefix() {
        let p = pool().await;
        let ids = |v: Vec<Value>| v.iter().map(|u| u["id"].as_str().unwrap().to_string()).collect::<Vec<_>>();
        // active only, by prefix, sorted by handle; "dead" is deactivated
        assert_eq!(ids(directory(&p, "ann", "bob").await.unwrap()), ["bob", "cat"]);
        assert_eq!(ids(directory(&p, "ann", "BOB").await.unwrap()), ["bob", "cat"]);
        assert_eq!(directory(&p, "ann", "bobc").await.unwrap()[0], json!({"id": "cat", "name": "bobcat", "handle": "bobcat"}));
        // at least two characters
        assert!(directory(&p, "ann", "b").await.unwrap().is_empty());
        assert!(directory(&p, "ann", " ").await.unwrap().is_empty());
        // never yourself
        assert!(directory(&p, "ann", "an").await.unwrap().is_empty());
        // LIKE's wildcards are literal
        assert!(directory(&p, "ann", "b%").await.unwrap().is_empty());
        assert!(directory(&p, "ann", "__").await.unwrap().is_empty());
        // someone who blocked you is not listed
        set_block(&p, "cat", "ann", true, T0).await.unwrap();
        assert_eq!(ids(directory(&p, "ann", "bob").await.unwrap()), ["bob"]);
        assert_eq!(ids(directory(&p, "eve", "bob").await.unwrap()), ["bob", "cat"]);
        // at most ten
        for i in 0..14 {
            let id = format!("zz{i}");
            sqlx::query("INSERT INTO users (id, github_id, handle, display_name, avatar_url, trainer_name, is_active, created_at)
                         VALUES (?1, ?2, ?1, 'Zed', '', '', 1, datetime('now'))").bind(&id).bind(9000 + i).execute(&p).await.unwrap();
        }
        let z = directory(&p, "ann", "zz").await.unwrap();
        assert_eq!(z.len(), 10);
        assert_eq!(z[0]["name"], "Zed");
    }

    #[tokio::test]
    async fn the_inbox_drains_by_ack_and_the_sender_sees_ticks() {
        let p = pool().await;
        set_optin(&p, "ann", true, T0).await.unwrap();
        let a = send(&p, "ann", "bob", "one", T0).await.unwrap();
        let b = send(&p, "ann", "bob", "two", T0).await.unwrap(); // the same ms: ordered by id after at
        let c = send(&p, "ann", "bob", "three", T0 + 5).await.unwrap();
        let all = inbox(&p, "bob", None, T0 + 10).await.unwrap();
        assert_eq!(all.len(), 3);
        assert_eq!(unread(&p, "bob", T0 + 10).await.unwrap(), 3);
        let first = all[0]["id"].as_str().unwrap().to_string();
        // since: only what came after
        let after = inbox(&p, "bob", Some(&first), T0 + 10).await.unwrap();
        assert_eq!(after.len(), 2);
        assert_eq!(after[1]["text"], "three");
        // an unknown since starts from the beginning
        assert_eq!(inbox(&p, "bob", Some("nope"), T0 + 10).await.unwrap().len(), 3);
        // nobody else's ack touches them
        assert_eq!(ack(&p, "cat", &c.id, T0 + 11).await.unwrap(), 0);
        assert!(status(&p, "ann", &[a.id.clone(), b.id.clone(), c.id.clone()]).await.unwrap().is_empty());
        // ack up to the second one
        let second = all[1]["id"].as_str().unwrap().to_string();
        assert_eq!(ack(&p, "bob", &second, T0 + 12).await.unwrap(), 2);
        let left = inbox(&p, "bob", None, T0 + 13).await.unwrap();
        assert_eq!(left.len(), 1);
        assert_eq!(left[0]["text"], "three");
        let mut ticks = status(&p, "ann", &[a.id.clone(), b.id.clone(), c.id.clone(), "x".into()]).await.unwrap();
        ticks.sort();
        let mut want = vec![a.id.clone(), b.id.clone()];
        want.sort();
        assert_eq!(ticks, want);
        // only the sender sees their ticks
        assert!(status(&p, "bob", std::slice::from_ref(&a.id)).await.unwrap().is_empty());
        // the words are gone from the server once delivered
        let t: String = sqlx::query("SELECT text FROM sms_message WHERE id = ?1").bind(&a.id).fetch_one(&p).await.unwrap().get(0);
        assert_eq!(t, "");
        assert_eq!(ack(&p, "bob", &c.id, T0 + 14).await.unwrap(), 1);
        assert!(inbox(&p, "bob", None, T0 + 15).await.unwrap().is_empty());
        assert_eq!(unread(&p, "bob", T0 + 15).await.unwrap(), 0);
    }

    #[tokio::test]
    async fn reports_are_stored_and_capped() {
        let p = pool().await;
        assert!(report(&p, "bob", "ann", "m1", T0).await.unwrap());
        let r = sqlx::query("SELECT reporter, sender, msg_id FROM sms_report").fetch_one(&p).await.unwrap();
        assert_eq!((r.get::<String, _>(0), r.get::<String, _>(1), r.get::<String, _>(2)), ("bob".into(), "ann".into(), "m1".into()));
        for i in 1..REPORTS_PER_DAY {
            assert!(report(&p, "bob", "ann", "", T0 + i).await.unwrap());
        }
        assert!(!report(&p, "bob", "ann", "", T0 + 100).await.unwrap());
    }

    // --- over HTTP, behind the real device middleware, with a live socket ----

    async fn serve(pool: SqlitePool) -> (String, crate::rooms::RoomManager) {
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
            rooms: rooms.clone(),
            music: crate::music::MusicHub::default(),
            conn_seq: Arc::new(AtomicU64::new(1)),
        };
        let app = routes()
            .layer(axum::middleware::from_fn_with_state(st.clone(), crate::require_device))
            .with_state(st);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (format!("http://{addr}"), rooms)
    }

    async fn device(p: &SqlitePool, user: &str) -> String {
        let token = format!("tok-{user}");
        sqlx::query("INSERT INTO devices (id, user_id, token_hash, label, created_at, revoked) VALUES (?1, ?2, ?3, 't', datetime('now'), 0)")
            .bind(uuid::Uuid::new_v4().to_string()).bind(user).bind(crate::auth::hash_token(&token))
            .execute(p).await.unwrap();
        token
    }

    #[tokio::test]
    async fn the_routes_over_http_and_the_live_push() {
        let p = pool().await;
        let (base, rooms) = serve(p.clone()).await;
        let (ta, tb) = (device(&p, "ann").await, device(&p, "bob").await);
        let c = reqwest::Client::new();
        let post = |path: &str, tok: &str, body: Value| c.post(format!("{base}{path}")).bearer_auth(tok.to_string()).json(&body).send();
        let get = |path: &str, tok: &str| c.get(format!("{base}{path}")).bearer_auth(tok.to_string()).send();

        assert_eq!(c.get(format!("{base}/v1/sms/me")).send().await.unwrap().status(), 401);
        let me: Value = get("/v1/sms/me", &ta).await.unwrap().json().await.unwrap();
        assert_eq!(me, json!({"on": false, "blocks": [], "unread": 0}));
        let r = post("/v1/sms/send", &ta, json!({"to": "bob", "text": "hi"})).await.unwrap();
        assert_eq!(r.status(), 409);
        assert_eq!(r.json::<Value>().await.unwrap()["detail"], NOT_OPTED);
        assert_eq!(post("/v1/sms/optin", &ta, json!({"on": "yes"})).await.unwrap().status(), 400);
        let r: Value = post("/v1/sms/optin", &ta, json!({"on": true})).await.unwrap().json().await.unwrap();
        assert_eq!(r, json!({"on": true}));

        // bob has a socket open in some room: the message is pushed there as well as queued
        let (_, mut drx, _, _) = rooms.join_direct("hq_city", 7, crate::rooms::Member {
            user_id: "bob".into(), handle: "bobby".into(), display_name: "Bob".into(), avatar_url: String::new(), cos: Value::Null,
        }).await.unwrap();
        let r = post("/v1/sms/send", &ta, json!({"to": "bob", "text": " hello "})).await.unwrap();
        assert_eq!(r.status(), 200);
        let r: Value = r.json().await.unwrap();
        assert_eq!(r["ok"], true);
        let id = r["id"].as_str().unwrap().to_string();
        let live: Value = serde_json::from_str(&drx.try_recv().unwrap()).unwrap();
        assert_eq!(live["type"], "sms");
        assert_eq!(live["id"], id.as_str());
        assert_eq!(live["text"], "hello");
        assert_eq!(live["from"], json!({"id": "ann", "name": "ann", "handle": "ann"}));
        for bad in [json!({"to": "bob"}), json!({"to": 5, "text": "x"}), json!([1])] {
            assert_eq!(post("/v1/sms/send", &ta, bad).await.unwrap().status(), 400);
        }
        assert_eq!(post("/v1/sms/send", &ta, json!({"to": "zed", "text": "x"})).await.unwrap().status(), 404);

        let me: Value = get("/v1/sms/me", &tb).await.unwrap().json().await.unwrap();
        assert_eq!(me["unread"], 1);
        let ib: Value = get("/v1/sms/inbox?since=", &tb).await.unwrap().json().await.unwrap();
        assert_eq!(ib["messages"][0]["id"], id.as_str());
        let st: Value = get(&format!("/v1/sms/status?ids={id},nope"), &ta).await.unwrap().json().await.unwrap();
        assert_eq!(st, json!({"delivered": []}));
        let r: Value = post("/v1/sms/ack", &tb, json!({"upto": id})).await.unwrap().json().await.unwrap();
        assert_eq!(r, json!({"ok": true}));
        let st: Value = get(&format!("/v1/sms/status?ids={id}"), &ta).await.unwrap().json().await.unwrap();
        assert_eq!(st, json!({"delivered": [id]}));
        let ib: Value = get("/v1/sms/inbox", &tb).await.unwrap().json().await.unwrap();
        assert_eq!(ib, json!({"messages": []}));

        // block: silent for the sender, nothing pushed
        let r: Value = post("/v1/sms/block", &tb, json!({"user": "ann", "on": true})).await.unwrap().json().await.unwrap();
        assert_eq!(r, json!({"blocks": ["ann"]}));
        let r = post("/v1/sms/send", &ta, json!({"to": "bob", "text": "again"})).await.unwrap();
        assert_eq!(r.status(), 200);
        assert_eq!(r.json::<Value>().await.unwrap()["ok"], true);
        assert!(drx.try_recv().is_err());
        assert_eq!(post("/v1/sms/block", &tb, json!({"user": "a/b", "on": true})).await.unwrap().status(), 400);

        let d: Value = get("/v1/sms/directory?q=bo", &ta).await.unwrap().json().await.unwrap();
        assert_eq!(d["users"].as_array().unwrap().len(), 1, "bob blocked ann, so only bobcat: {d}");
        assert_eq!(d["users"][0]["id"], "cat");
        let r: Value = post("/v1/sms/report", &tb, json!({"user": "ann", "id": id})).await.unwrap().json().await.unwrap();
        assert_eq!(r, json!({"ok": true}));
        assert_eq!(post("/v1/sms/report", &tb, json!({"user": "ann", "id": 3})).await.unwrap().status(), 400);
    }
}
