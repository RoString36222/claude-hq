//! HQ growth (HQ 3.37): an HQ's township grows with its owner's Claude work.
//!
//!   GET /v1/hq/me/work                                        -> {"build": Build | null}
//!   PUT /v1/hq/me/work {"days": [{"day": "YYYY-MM-DD", "hours": n}, ...]} -> {"build": Build}
//!
//! The HQ app reports, for today and yesterday (UTC), its owner's Claude
//! worker-hours: how many (session, hour) pairs had activity that day, counted
//! on their own machine, a whole number at most [`DAY_CAP`]. A day's stored
//! count only ever goes up. Their sum (capped at [`PTS_MAX`]) is the HQ's build
//! points, and [`growth`] turns those into the township's size and stages:
//! every HQ starts on its one lot; at [`UNLOCK`]`[0]` points the first
//! neighbouring lot (the generator's `annex` plots beside each township) is
//! added at bare ground and climbs [`STAGES`] at [`STAGE_AT`] points past its
//! unlock; when it reaches its landmark the second opens and climbs the same.
//! Fair and capped: at most 24 points a day, and everyone tops out at the same
//! two neighbouring lots.
//!
//! The listing (`/v1/hq/open`, a visit, `/v1/hq/me`) carries `build` next to
//! `crew`, whose live session count is the township's builders.
//!
//! PRIVACY: whole numbers per UTC day about the caller's own work. No session
//! ids, titles, paths or text; unknown keys are a 422.

use axum::{
    extract::{Request, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use chrono::NaiveDate;
use serde::Serialize;
use serde_json::{json, Value};
use sqlx::{Row, SqlitePool};
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

/// Worker-hours one day can count (24 sessions-hours: three sessions all day long, or one round the clock).
pub(crate) const DAY_CAP: i64 = 24;
/// The neighbouring lots a township can add (the generator reserves this many beside each one).
pub(crate) const ANNEXES: usize = 2;
/// The build stages each added lot climbs, in order.
#[allow(dead_code)] // the names, for the docs and the tests (the page draws them)
pub(crate) const STAGES: [&str; 5] = ["bare ground", "foundations", "buildings", "amenities", "landmark"];
/// Points (past its unlock) at which an added lot reaches each stage.
pub(crate) const STAGE_AT: [i64; 5] = [0, 15, 45, 90, 140];
/// Points at which each neighbouring lot is added: the first early, the second when the first has its landmark.
pub(crate) const UNLOCK: [i64; ANNEXES] = [10, 150];
/// Points past this change nothing: both added lots at their landmarks.
pub(crate) const PTS_MAX: i64 = UNLOCK[1] + STAGE_AT[4];
/// At most this many days in one report (today and yesterday, with room for a retry).
const DAYS_MAX: usize = 4;
const MAX_BODY: usize = 1024;
/// Reports per user per window: the HQ heartbeat sends one every two minutes, so this only stops a loop.
const SAVE_BURST: u32 = 20;
const SAVE_WINDOW: Duration = Duration::from_secs(60);

/// A township's growth. Field order is the wire's key order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub(crate) struct Build {
    /// Build points (worker-hours, capped).
    pub pts: i64,
    /// Lots the township stands on: 1 + its added neighbouring lots.
    pub lots: u8,
    /// Each neighbouring lot's stage (an index into [`STAGES`]), -1 while not yet added.
    pub stages: [i8; ANNEXES],
}

/// The township's growth at `pts` build points.
pub(crate) fn growth(pts: i64) -> Build {
    let pts = pts.clamp(0, PTS_MAX);
    let mut stages = [-1i8; ANNEXES];
    for (k, s) in stages.iter_mut().enumerate() {
        if pts >= UNLOCK[k] {
            *s = STAGE_AT.iter().filter(|&&at| pts - UNLOCK[k] >= at).count() as i8 - 1;
        }
    }
    Build { pts, lots: 1 + stages.iter().filter(|&&s| s >= 0).count() as u8, stages }
}

// --- validation -----------------------------------------------------------

/// A report off the wire: `{"days": [{"day", "hours"}]}`, strict (exactly those keys, a real date, whole hours
/// 0..=DAY_CAP, at most DAYS_MAX days). Days other than `today` and the day before are dropped, not refused: the
/// reporting machine's clock may sit either side of midnight.
pub(crate) fn parse(bytes: &[u8], today: NaiveDate) -> Result<Vec<(NaiveDate, i64)>, String> {
    let body: Value = serde_json::from_slice(bytes).map_err(|_| "body must be JSON".to_string())?;
    let o = body.as_object().ok_or("body must be an object")?;
    if let Some(k) = o.keys().find(|k| k.as_str() != "days") {
        return Err(format!("unknown key {k:?} (only days)"));
    }
    let days = o.get("days").and_then(Value::as_array).ok_or("days: required, a list")?;
    if days.len() > DAYS_MAX {
        return Err(format!("days: at most {DAYS_MAX}"));
    }
    let mut out = Vec::new();
    for d in days {
        let e = d.as_object().ok_or("days[]: must be an object")?;
        if let Some(k) = e.keys().find(|k| !matches!(k.as_str(), "day" | "hours")) {
            return Err(format!("days[]: unknown key {k:?} (only day, hours)"));
        }
        let day = e.get("day").and_then(Value::as_str).and_then(|s| NaiveDate::parse_from_str(s, "%Y-%m-%d").ok()).ok_or("days[].day: a YYYY-MM-DD date")?;
        let hours = match e.get("hours").and_then(Value::as_i64) {
            Some(n) if (0..=DAY_CAP).contains(&n) => n,
            _ => return Err(format!("days[].hours: a whole number 0..={DAY_CAP}")),
        };
        if day == today || today.pred_opt() == Some(day) {
            out.push((day, hours));
        }
    }
    Ok(out)
}

// --- storage --------------------------------------------------------------

/// Store a report: each day's count only ever goes up.
pub(crate) async fn record(pool: &SqlitePool, uid: &str, days: &[(NaiveDate, i64)]) -> Result<(), sqlx::Error> {
    for (day, hours) in days {
        sqlx::query(
            "INSERT INTO hq_work (user_id, day, hours, updated_at) VALUES (?1, ?2, ?3, datetime('now'))
             ON CONFLICT(user_id, day) DO UPDATE SET hours = excluded.hours, updated_at = excluded.updated_at
             WHERE excluded.hours > hq_work.hours",
        )
        .bind(uid)
        .bind(day.format("%Y-%m-%d").to_string())
        .bind((*hours).clamp(0, DAY_CAP))
        .execute(pool)
        .await?;
    }
    Ok(())
}

/// The caller's build, None before their first report (the page then shows a township on its one lot).
pub(crate) async fn load(pool: &SqlitePool, uid: &str) -> Result<Option<Build>, sqlx::Error> {
    let ids = [uid.to_string()];
    Ok(load_many(pool, &ids).await?.remove(uid))
}

/// Builds for many users in one query, with no visibility filter: callers have already decided who may be shown.
pub(crate) async fn load_many(pool: &SqlitePool, ids: &[String]) -> Result<HashMap<String, Build>, sqlx::Error> {
    let mut out = HashMap::new();
    if ids.is_empty() {
        return Ok(out);
    }
    let ph = (1..=ids.len()).map(|i| format!("?{i}")).collect::<Vec<_>>().join(",");
    let sql = format!(
        "SELECT user_id, SUM(MIN(MAX(hours, 0), {DAY_CAP})) AS pts FROM hq_work WHERE user_id IN ({ph}) GROUP BY user_id"
    );
    let mut q = sqlx::query(&sql);
    for id in ids {
        q = q.bind(id.as_str());
    }
    for r in q.fetch_all(pool).await? {
        out.insert(r.get("user_id"), growth(r.get::<i64, _>("pts")));
    }
    Ok(out)
}

// --- the wire -------------------------------------------------------------

static SAVES: LazyLock<Mutex<HashMap<String, (Instant, u32)>>> = LazyLock::new(Default::default);

fn save_allowed(uid: &str, now: Instant) -> bool {
    let mut m = SAVES.lock().unwrap_or_else(|e| e.into_inner());
    if m.len() > 10_000 {
        m.retain(|_, (t, _)| now.duration_since(*t) < SAVE_WINDOW);
    }
    let e = m.entry(uid.to_string()).or_insert((now, 0));
    if now.duration_since(e.0) >= SAVE_WINDOW {
        *e = (now, 0);
    }
    e.1 += 1;
    e.1 <= SAVE_BURST
}

fn db500(e: sqlx::Error) -> Response {
    crate::err(StatusCode::INTERNAL_SERVER_ERROR, &format!("db error: {e}"))
}

pub(crate) async fn get_mine(State(st): State<crate::AppState>, req: Request) -> Response {
    let c = crate::cities::caller(&req);
    match load(&st.pool, &c.user_id).await {
        Ok(b) => Json(json!({ "build": b })).into_response(),
        Err(e) => db500(e),
    }
}

pub(crate) async fn put_mine(State(st): State<crate::AppState>, req: Request) -> Response {
    let c = crate::cities::caller(&req);
    let (_, body) = req.into_parts();
    let Ok(bytes) = axum::body::to_bytes(body, MAX_BODY).await else {
        return crate::err(StatusCode::PAYLOAD_TOO_LARGE, "body too large");
    };
    let days = match parse(&bytes, chrono::Utc::now().date_naive()) {
        Ok(d) => d,
        Err(m) => return crate::err(StatusCode::UNPROCESSABLE_ENTITY, &m),
    };
    if !save_allowed(&c.user_id, Instant::now()) {
        return crate::err(StatusCode::TOO_MANY_REQUESTS, "slow down");
    }
    if let Err(e) = record(&st.pool, &c.user_id, &days).await {
        return db500(e);
    }
    match load(&st.pool, &c.user_id).await {
        Ok(b) => Json(json!({ "build": b.unwrap_or_else(|| growth(0)) })).into_response(),
        Err(e) => db500(e),
    }
}

#[cfg(test)]
mod tests;
