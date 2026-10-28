//! Movable HQ garages (City Gen v4 phase 10, HQ 3.33): where a user's car-lift
//! garage bay sits inside their own HQ lot, stored per user and shown to
//! visitors next to the rest of their HQ.
//!
//!   GET    /v1/hq/me/garage                  -> {"garage": {lot, x, z, r} | null}
//!   PUT    /v1/hq/me/garage {lot, x, z, r}   -> {"garage": {lot, x, z, r}}
//!   DELETE /v1/hq/me/garage                  -> {"garage": null}   (back to the default spot)
//!
//! A spot is four small integers: `lot` the HQ lot's rank (archipelago.rs's
//! Commons lot assignment), `x` / `z` decimetres in the lot's own frame (x
//! across the lot, z towards its street front; |x| <= [`X_MAX`], |z| <=
//! [`Z_MAX`]) and `r` quarter turns 0..=3. The footprints live in the page, so
//! only the page decides whether a spot fits a lot; every page falls back to
//! its default spot when a stored one doesn't, so this checks shape and ranges
//! only. Strict on the way in, like HQ Studio: anything but exactly those four
//! integer keys in range is a 422.
//!
//! PRIVACY: four integers about the caller's own lot. No free text at all.

use axum::{
    extract::{Request, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{Row, SqlitePool};
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

/// `|x| <= X_MAX` decimetres (across the lot).
pub(crate) const X_MAX: i64 = 400;
/// `|z| <= Z_MAX` decimetres (towards the street front).
pub(crate) const Z_MAX: i64 = 300;
/// Quarter turns, `0..=R_MAX`.
pub(crate) const R_MAX: i64 = 3;
/// Four integers; anything larger is not a body we would accept.
const MAX_BODY: usize = 1024;
/// Saves per user per window, as HQ Studio: the editor saves on drop, so this only stops a loop.
const SAVE_BURST: u32 = 20;
const SAVE_WINDOW: Duration = Duration::from_secs(10);

/// One garage spot. Field order is the wire's key order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct GarageSpot {
    pub lot: u32,
    pub x: i32,
    pub z: i32,
    pub r: u8,
}

// --- validation -----------------------------------------------------------

fn int_in(o: &serde_json::Map<String, Value>, k: &str, lo: i64, hi: i64) -> Result<i64, String> {
    match o.get(k) {
        None => Err(format!("garage.{k}: required")),
        Some(v) => match v.as_i64() {
            Some(n) if (lo..=hi).contains(&n) => Ok(n),
            Some(_) => Err(format!("garage.{k}: out of range ({lo}..={hi})")),
            // u64 above i64::MAX is out of range too; floats, strings, null are not integers
            None if v.is_u64() => Err(format!("garage.{k}: out of range ({lo}..={hi})")),
            None => Err(format!("garage.{k}: must be an integer")),
        },
    }
}

/// A spot from any JSON value: an object with exactly `lot`, `x`, `z`, `r`,
/// each an integer in range.
pub(crate) fn validate(v: &Value) -> Result<GarageSpot, String> {
    let o = v.as_object().ok_or_else(|| "garage: must be an object".to_string())?;
    if let Some(k) = o.keys().find(|k| !matches!(k.as_str(), "lot" | "x" | "z" | "r")) {
        return Err(format!("garage: unknown key {k:?} (only lot, x, z, r)"));
    }
    Ok(GarageSpot {
        lot: int_in(o, "lot", 0, i64::from(u32::MAX))? as u32,
        x: int_in(o, "x", -X_MAX, X_MAX)? as i32,
        z: int_in(o, "z", -Z_MAX, Z_MAX)? as i32,
        r: int_in(o, "r", 0, R_MAX)? as u8,
    })
}

/// A PUT body (`{lot, x, z, r}`) off the wire.
pub(crate) fn parse_put(bytes: &[u8]) -> Result<GarageSpot, String> {
    let body: Value = serde_json::from_slice(bytes).map_err(|_| "body must be JSON".to_string())?;
    validate(&body)
}

// --- storage --------------------------------------------------------------

/// A stored row back out. Rows were validated on the way in; one a later rule
/// would refuse reads as the default spot rather than a 500.
fn from_row(r: &sqlx::sqlite::SqliteRow) -> Option<GarageSpot> {
    let v = json!({"lot": r.get::<i64, _>("lot"), "x": r.get::<i64, _>("x"), "z": r.get::<i64, _>("z"), "r": r.get::<i64, _>("r")});
    validate(&v).ok()
}

pub(crate) async fn load(pool: &SqlitePool, uid: &str) -> Result<Option<GarageSpot>, sqlx::Error> {
    let row = sqlx::query("SELECT lot, x, z, r FROM hq_garage WHERE user_id = ?1")
        .bind(uid)
        .fetch_optional(pool)
        .await?;
    Ok(row.as_ref().and_then(from_row))
}

/// Spots for many users in one query, with no visibility filter: callers have
/// already decided who may be shown (the open list, a visit).
pub(crate) async fn load_many(pool: &SqlitePool, ids: &[String]) -> Result<HashMap<String, GarageSpot>, sqlx::Error> {
    let mut out = HashMap::new();
    if ids.is_empty() {
        return Ok(out);
    }
    let ph = (1..=ids.len()).map(|i| format!("?{i}")).collect::<Vec<_>>().join(",");
    let sql = format!("SELECT user_id, lot, x, z, r FROM hq_garage WHERE user_id IN ({ph})");
    let mut q = sqlx::query(&sql);
    for id in ids {
        q = q.bind(id.as_str());
    }
    for r in q.fetch_all(pool).await? {
        if let Some(s) = from_row(&r) {
            out.insert(r.get("user_id"), s);
        }
    }
    Ok(out)
}

/// Store (or with `None`, delete) the caller's own row. A save that changes
/// nothing leaves `updated_at` alone.
pub(crate) async fn save(pool: &SqlitePool, uid: &str, spot: Option<&GarageSpot>) -> Result<(), sqlx::Error> {
    match spot {
        None => {
            sqlx::query("DELETE FROM hq_garage WHERE user_id = ?1").bind(uid).execute(pool).await?;
        }
        Some(s) => {
            sqlx::query(
                "INSERT INTO hq_garage (user_id, lot, x, z, r, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, datetime('now'))
                 ON CONFLICT(user_id) DO UPDATE SET lot = excluded.lot, x = excluded.x, z = excluded.z, r = excluded.r,
                     updated_at = excluded.updated_at
                 WHERE (hq_garage.lot, hq_garage.x, hq_garage.z, hq_garage.r)
                    IS NOT (excluded.lot, excluded.x, excluded.z, excluded.r)",
            )
            .bind(uid)
            .bind(i64::from(s.lot))
            .bind(i64::from(s.x))
            .bind(i64::from(s.z))
            .bind(i64::from(s.r))
            .execute(pool)
            .await?;
        }
    }
    Ok(())
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
        Ok(s) => Json(json!({ "garage": s })).into_response(),
        Err(e) => db500(e),
    }
}

pub(crate) async fn put_mine(State(st): State<crate::AppState>, req: Request) -> Response {
    let c = crate::cities::caller(&req);
    let (_, body) = req.into_parts();
    let Ok(bytes) = axum::body::to_bytes(body, MAX_BODY).await else {
        return crate::err(StatusCode::PAYLOAD_TOO_LARGE, "body too large");
    };
    let spot = match parse_put(&bytes) {
        Ok(s) => s,
        Err(m) => return crate::err(StatusCode::UNPROCESSABLE_ENTITY, &m),
    };
    if !save_allowed(&c.user_id, Instant::now()) {
        return crate::err(StatusCode::TOO_MANY_REQUESTS, "slow down");
    }
    match save(&st.pool, &c.user_id, Some(&spot)).await {
        Ok(()) => Json(json!({ "garage": spot })).into_response(),
        Err(e) => db500(e),
    }
}

pub(crate) async fn delete_mine(State(st): State<crate::AppState>, req: Request) -> Response {
    let c = crate::cities::caller(&req);
    if !save_allowed(&c.user_id, Instant::now()) {
        return crate::err(StatusCode::TOO_MANY_REQUESTS, "slow down");
    }
    match save(&st.pool, &c.user_id, None).await {
        Ok(()) => Json(json!({ "garage": null })).into_response(),
        Err(e) => db500(e),
    }
}

#[cfg(test)]
mod tests;
