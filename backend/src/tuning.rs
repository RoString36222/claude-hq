//! Tuning (HQ 3.13, the Tuning shop): how each owned vehicle is tuned, and the short code
//! presence carries so other players see it.
//!
//!   GET  /v1/vehicles/:id/tuning                 -> {tuning, paint, code}
//!   POST /v1/vehicles/:id/tuning {tuning, paint?} -> {ok, tuning, paint, code}
//!
//! Owner only (another player's vehicle, or a non-uuid id, is a 404). `tuning` is validated
//! against fixed enums for the vehicle's kind (a car or a bike, from its catalogue class), colours
//! as `#rrggbb`, the rim design / size step / tint inside their ranges and the plate text against
//! [`plate_ok`]; the server stores its own canonical JSON (vehicle_tuning, 0020_vehicle_tuning.sql),
//! never the client's bytes. A stock tuning deletes the row. `paint` (optional) is a new index into
//! the vehicle's catalogue paints, saved in the same transaction (presence's `vp`).
//! GET /v1/vehicles/mine and GET /v1/garages/mine carry each vehicle's tuning too.
//!
//! Presence ("tuning" capability, backend/src/protocol.rs): while driving (a = 5 / 6) a page may
//! send `vt`, [`code`] of its tuning (at most [`CODE_MAX`] characters); valley/hq.rs keeps it only if
//! [`parse_code`] accepts it, and lists it beside `v` / `vp`. Starter vehicles (never server rows)
//! use the same code from the page's localStorage.
//!
//! Tuning is free: every catalogue price is 0 for now, and the shop charges nothing.
//!
//! PRIVACY: enum values, colours, small numbers and up to 8 plate characters the user typed.

use axum::{
    extract::{Path, Request, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde_json::{json, Map, Value};
use sqlx::SqlitePool;

use crate::cities::{self, Refuse};

pub const FINISHES: [&str; 5] = ["gloss", "matte", "metallic", "pearl", "chrome"];
pub const TWO_TONES: [&str; 4] = ["none", "roof", "stripe", "livery"];
pub const WINGS: [&str; 4] = ["none", "lip", "ducktail", "gt"];
pub const CAR_EXHAUSTS: [&str; 4] = ["stock", "sport", "quad", "titanium"];
pub const BIKE_EXHAUSTS: [&str; 4] = ["stock", "slipon", "underseat", "endcan"];
/// Rim designs 0..RIMS (0: the vehicle's own).
pub const RIMS: i64 = 6;
/// The rim size step: smaller (-1) .. stock (0) .. two sizes up (2); the tyre's outside stays put.
pub const RIM_SIZE: (i64, i64) = (-1, 2);
/// Window tint 0 (stock) .. 3 (limo).
pub const TINTS: i64 = 4;
pub const PLATE_MAX: usize = 8;
/// The longest presence code: 7 digits, 3 colours of 6, a plate of 8.
pub const CODE_MAX: usize = 7 + 3 * 6 + PLATE_MAX;
/// Words a plate may not spell (after 0->O, 1->I, 3->E, 4->A, 5->S, 7->T, 8->B and without spaces or
/// dashes). A light filter, the same list as games/hqtuning.js (tests/test_hqtuning.py checks).
pub const BANNED: [&str; 28] = [
    "FUCK", "FUK", "FCUK", "SHIT", "CUNT", "DICK", "COCK", "PUSSY", "BITCH", "NIGG", "NIGA", "FAG", "SLUT", "WHORE",
    "NAZI", "TWAT", "WANK", "PENIS", "ASSHOLE", "TITS", "PORN", "SEX", "HITLER", "KKK", "DILDO", "JIZZ", "PRICK", "BASTARD",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Car,
    Bike,
}

impl Kind {
    fn exhausts(self) -> &'static [&'static str; 4] {
        match self {
            Kind::Car => &CAR_EXHAUSTS,
            Kind::Bike => &BIKE_EXHAUSTS,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Tuning {
    pub finish: u8,
    pub color: Option<u32>,
    pub two_tone: u8,
    pub color2: Option<u32>,
    pub rim: u8,
    pub rim_color: Option<u32>,
    pub rim_size: i8,
    pub tint: u8,
    pub wing: u8,
    pub exhaust: u8,
    pub plate: String,
}

impl Tuning {
    pub fn is_stock(&self) -> bool {
        *self == Tuning::default()
    }
}

/// A plate's text: A-Z, 0-9, space and dash, at most 8, no space at either end, nothing [`BANNED`].
pub fn plate_ok(s: &str) -> Result<(), &'static str> {
    if s.chars().count() > PLATE_MAX {
        return Err("plate: at most 8 characters");
    }
    if !s.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b' ' || b == b'-') {
        return Err("plate: only A-Z, 0-9, space and dash");
    }
    if s.starts_with(' ') || s.ends_with(' ') || s.contains("  ") {
        return Err("plate: no space at the ends or two in a row");
    }
    let squashed: String = s
        .chars()
        .filter(|c| *c != ' ' && *c != '-')
        .map(|c| match c {
            '0' => 'O',
            '1' => 'I',
            '3' => 'E',
            '4' => 'A',
            '5' => 'S',
            '7' => 'T',
            '8' => 'B',
            c => c,
        })
        .collect();
    if BANNED.iter().any(|w| squashed.contains(w)) {
        return Err("plate: pick other letters");
    }
    Ok(())
}

fn hex_of(v: &Value, what: &str) -> Result<Option<u32>, String> {
    match v {
        Value::Null => Ok(None),
        Value::String(s) if s.len() == 7 && s.starts_with('#') && s[1..].bytes().all(|b| b.is_ascii_hexdigit()) => {
            Ok(Some(u32::from_str_radix(&s[1..], 16).map_err(|_| format!("{what} must be #rrggbb"))?))
        }
        _ => Err(format!("{what} must be #rrggbb or null")),
    }
}

fn pick(v: Option<&Value>, list: &[&str], what: &str) -> Result<u8, String> {
    match v {
        None => Ok(0),
        Some(Value::String(s)) => list.iter().position(|x| x == s).map(|i| i as u8).ok_or_else(|| format!("{what} must be one of {}", list.join(", "))),
        Some(_) => Err(format!("{what} must be one of {}", list.join(", "))),
    }
}

fn int_in(v: Option<&Value>, lo: i64, hi: i64, what: &str) -> Result<i64, String> {
    match v {
        None => Ok(0.clamp(lo, hi)),
        Some(n) => n.as_i64().filter(|n| (lo..=hi).contains(n)).ok_or_else(|| format!("{what} must be a whole number from {lo} to {hi}")),
    }
}

const KEYS: [&str; 11] = ["finish", "color", "two_tone", "color2", "rim", "rim_color", "rim_size", "tint", "wing", "exhaust", "plate"];

/// A tuning object for a vehicle of `kind`: strict (an unknown key, a value off its list or out of
/// range is an error; a missing key is stock).
pub fn parse_json(kind: Kind, v: &Value) -> Result<Tuning, String> {
    let Value::Object(o) = v else { return Err("tuning must be an object".into()) };
    if let Some(k) = o.keys().find(|k| !KEYS.contains(&k.as_str())) {
        return Err(format!("unknown tuning field {k:?}"));
    }
    let null = Value::Null;
    let t = Tuning {
        finish: pick(o.get("finish"), &FINISHES, "finish")?,
        color: hex_of(o.get("color").unwrap_or(&null), "color")?,
        two_tone: pick(o.get("two_tone"), &TWO_TONES, "two_tone")?,
        color2: hex_of(o.get("color2").unwrap_or(&null), "color2")?,
        rim: int_in(o.get("rim"), 0, RIMS - 1, "rim")? as u8,
        rim_color: hex_of(o.get("rim_color").unwrap_or(&null), "rim_color")?,
        rim_size: int_in(o.get("rim_size"), RIM_SIZE.0, RIM_SIZE.1, "rim_size")? as i8,
        tint: int_in(o.get("tint"), 0, TINTS - 1, "tint")? as u8,
        wing: pick(o.get("wing"), &WINGS, "wing")?,
        exhaust: pick(o.get("exhaust"), kind.exhausts(), "exhaust")?,
        plate: match o.get("plate") {
            None | Some(Value::Null) => String::new(),
            Some(Value::String(s)) => s.clone(),
            Some(_) => return Err("plate must be text".into()),
        },
    };
    plate_ok(&t.plate).map_err(str::to_string)?;
    if kind == Kind::Bike && t.wing != 0 {
        return Err("a bike has no wing".into());
    }
    if kind == Kind::Bike && t.two_tone == 1 {
        return Err("a bike has no roof".into());
    }
    if t.two_tone != 0 && t.color2.is_none() {
        return Err("two_tone needs color2".into());
    }
    Ok(t)
}

fn hex(c: Option<u32>) -> Value {
    c.map_or(Value::Null, |c| json!(format!("#{c:06x}")))
}

/// The canonical JSON (what the database keeps and every response carries).
pub fn to_json(kind: Kind, t: &Tuning) -> Value {
    json!({"finish": FINISHES[t.finish as usize], "color": hex(t.color), "two_tone": TWO_TONES[t.two_tone as usize],
           "color2": hex(t.color2), "rim": t.rim, "rim_color": hex(t.rim_color), "rim_size": t.rim_size, "tint": t.tint,
           "wing": WINGS[t.wing as usize], "exhaust": kind.exhausts()[t.exhaust as usize], "plate": t.plate})
}

/// The presence code: digits for finish, two-tone, rim, rim size + 1, tint, wing, exhaust; then
/// colour, second colour and rim colour (6 lowercase hex digits, or `-` for none); then the plate
/// with `_` for a space. Kind-free: wing and exhaust are indexes into the kind's lists.
pub fn code(t: &Tuning) -> String {
    let mut s = format!("{}{}{}{}{}{}{}", t.finish, t.two_tone, t.rim, t.rim_size + 1, t.tint, t.wing, t.exhaust);
    for c in [t.color, t.color2, t.rim_color] {
        match c {
            Some(c) => s.push_str(&format!("{c:06x}")),
            None => s.push('-'),
        }
    }
    s.push_str(&t.plate.replace(' ', "_"));
    s
}

/// A presence code back to a tuning: None for anything [`code`] would not write.
pub fn parse_code(s: &str) -> Option<Tuning> {
    if s.len() > CODE_MAX || s.len() < 10 || !s.is_ascii() {
        return None;
    }
    let b = s.as_bytes();
    let dig = |i: usize, max: u8| -> Option<u8> { b[i].is_ascii_digit().then(|| b[i] - b'0').filter(|d| *d < max) };
    let mut t = Tuning {
        finish: dig(0, FINISHES.len() as u8)?,
        two_tone: dig(1, TWO_TONES.len() as u8)?,
        rim: dig(2, RIMS as u8)?,
        rim_size: dig(3, (RIM_SIZE.1 - RIM_SIZE.0 + 1) as u8)? as i8 + RIM_SIZE.0 as i8,
        tint: dig(4, TINTS as u8)?,
        wing: dig(5, WINGS.len() as u8)?,
        exhaust: dig(6, 4)?,
        ..Tuning::default()
    };
    let mut i = 7;
    let mut cols = [None; 3];
    for c in cols.iter_mut() {
        if b.get(i) == Some(&b'-') {
            i += 1;
        } else {
            let h = s.get(i..i + 6)?;
            if !h.bytes().all(|x| x.is_ascii_digit() || (b'a'..=b'f').contains(&x)) {
                return None;
            }
            *c = Some(u32::from_str_radix(h, 16).ok()?);
            i += 6;
        }
    }
    [t.color, t.color2, t.rim_color] = cols;
    let plate = s.get(i..)?;
    if plate.contains(' ') {
        return None;
    }
    t.plate = plate.replace('_', " ");
    plate_ok(&t.plate).ok()?;
    if t.two_tone != 0 && t.color2.is_none() {
        return None;
    }
    Some(t)
}

/// The vehicle's kind from its catalogue class ("bike.*" is a bike, anything else a car).
pub(crate) fn kind_of(vehicle_id: &str) -> Kind {
    match crate::vehicles::class_of(vehicle_id) {
        Some(c) if c.starts_with("bike.") => Kind::Bike,
        _ => Kind::Car,
    }
}

/// Each of `uid`'s tuned vehicles: owned id -> canonical tuning JSON (stock vehicles are absent).
pub(crate) async fn mine(pool: &SqlitePool, uid: &str) -> Result<Map<String, Value>, sqlx::Error> {
    let rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT t.vehicle_id, t.tuning FROM vehicle_tuning t JOIN owned_vehicles v ON v.id = t.vehicle_id AND v.user_id = t.user_id
         WHERE t.user_id = ?1",
    )
    .bind(uid)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().filter_map(|(id, j)| Some((id, serde_json::from_str::<Value>(&j).ok()?))).collect())
}

async fn owned(pool: &SqlitePool, uid: &str, id: &str) -> Result<(String, i64), Refuse> {
    if uid.is_empty() {
        return Err(Refuse::say(StatusCode::FORBIDDEN, "link this device to an account first"));
    }
    if !cities::is_uuid(id) {
        return Err(Refuse::say(StatusCode::NOT_FOUND, "no such vehicle"));
    }
    sqlx::query_as("SELECT vehicle_id, paint FROM owned_vehicles WHERE id = ?1 AND user_id = ?2")
        .bind(id)
        .bind(uid)
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| Refuse::say(StatusCode::NOT_FOUND, "no such vehicle"))
}

/// `uid`'s vehicle `id`: its tuning (stock when it has no row), paint and code.
pub(crate) async fn read(pool: &SqlitePool, uid: &str, id: &str) -> Result<Value, Refuse> {
    let (vid, paint) = owned(pool, uid, id).await?;
    let kind = kind_of(&vid);
    let row: Option<String> = sqlx::query_scalar("SELECT tuning FROM vehicle_tuning WHERE vehicle_id = ?1 AND user_id = ?2")
        .bind(id)
        .bind(uid)
        .fetch_optional(pool)
        .await?;
    // re-validated on the way out: a row a later rule would refuse reads as stock
    let t = row
        .and_then(|j| serde_json::from_str::<Value>(&j).ok())
        .and_then(|v| parse_json(kind, &v).ok())
        .unwrap_or_default();
    Ok(json!({"tuning": to_json(kind, &t), "paint": paint, "code": code(&t)}))
}

/// The body of a POST: {tuning, paint?}.
pub(crate) fn parse_body(kind: Kind, bytes: &[u8]) -> Result<(Tuning, Option<i64>), String> {
    let Ok(Value::Object(o)) = serde_json::from_slice::<Value>(bytes) else {
        return Err("body must be a JSON object".into());
    };
    if let Some(k) = o.keys().find(|k| !matches!(k.as_str(), "tuning" | "paint")) {
        return Err(format!("unknown field {k:?}"));
    }
    let t = parse_json(kind, o.get("tuning").ok_or("tuning is required")?)?;
    let paint = match o.get("paint") {
        None | Some(Value::Null) => None,
        Some(p) => Some(p.as_i64().filter(|n| (0..64).contains(n)).ok_or("paint must be an index into the vehicle's paints")?),
    };
    Ok((t, paint))
}

/// Save `uid`'s vehicle `id`'s tuning (and paint, when given) from a POST body.
pub(crate) async fn set(pool: &SqlitePool, uid: &str, id: &str, bytes: &[u8], now: i64) -> Result<Value, Refuse> {
    let (vid, old_paint) = owned(pool, uid, id).await?;
    let kind = kind_of(&vid);
    let (t, paint) = parse_body(kind, bytes).map_err(|m| Refuse::say(StatusCode::UNPROCESSABLE_ENTITY, m))?;
    if let Some(p) = paint {
        if p as usize >= crate::vehicles::paints_of(&vid) {
            return Err(Refuse::say(StatusCode::UNPROCESSABLE_ENTITY, "no such paint for that vehicle"));
        }
    }
    let canon = to_json(kind, &t);
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    if t.is_stock() {
        sqlx::query("DELETE FROM vehicle_tuning WHERE vehicle_id = ?1 AND user_id = ?2")
            .bind(id)
            .bind(uid)
            .execute(&mut *tx)
            .await?;
    } else {
        sqlx::query(
            "INSERT INTO vehicle_tuning (vehicle_id, user_id, tuning, updated_at) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(vehicle_id) DO UPDATE SET tuning = excluded.tuning, updated_at = excluded.updated_at",
        )
        .bind(id)
        .bind(uid)
        .bind(canon.to_string())
        .bind(now)
        .execute(&mut *tx)
        .await?;
    }
    if let Some(p) = paint {
        sqlx::query("UPDATE owned_vehicles SET paint = ?1 WHERE id = ?2 AND user_id = ?3")
            .bind(p)
            .bind(id)
            .bind(uid)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(json!({"ok": true, "tuning": canon, "paint": paint.unwrap_or(old_paint), "code": code(&t)}))
}

pub fn routes() -> Router<crate::AppState> {
    Router::new().route("/v1/vehicles/:id/tuning", get(get_tuning).post(post_tuning))
}

async fn get_tuning(State(st): State<crate::AppState>, Path(id): Path<String>, req: Request) -> Response {
    let c = cities::caller(&req);
    match read(&st.pool, &c.user_id, &id).await {
        Ok(v) => Json(v).into_response(),
        Err(r) => r.response(),
    }
}

async fn post_tuning(State(st): State<crate::AppState>, Path(id): Path<String>, req: Request) -> Response {
    let c = cities::caller(&req);
    let bytes = match cities::read_body(req).await {
        Ok(b) => b,
        Err(r) => return r.response(),
    };
    match set(&st.pool, &c.user_id, &id, &bytes, cities::now_secs()).await {
        Ok(v) => Json(v).into_response(),
        Err(r) => r.response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    const A: &str = "aaaaaaaa-0000-4000-8000-000000000001";
    const B: &str = "bbbbbbbb-0000-4000-8000-000000000002";
    const NOW: i64 = 1_792_411_200;

    async fn pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new().max_connections(1).connect("sqlite::memory:").await.unwrap();
        crate::db::migrate(&pool).await.unwrap();
        for (i, id) in [A, B].iter().enumerate() {
            sqlx::query(
                "INSERT INTO users (id, github_id, handle, display_name, avatar_url, trainer_name, is_active, created_at)
                 VALUES (?1, ?2, ?3, '', '', '', 1, datetime('now'))",
            )
            .bind(id)
            .bind(i as i64 + 1)
            .bind(format!("h{i}"))
            .execute(&pool)
            .await
            .unwrap();
        }
        pool
    }

    fn code_of<T: std::fmt::Debug>(r: Result<T, Refuse>) -> StatusCode {
        match r {
            Err(Refuse::Say(c, _)) => c,
            Err(Refuse::Db(e)) => panic!("db error {e}"),
            Ok(_) => StatusCode::OK,
        }
    }

    fn full() -> Value {
        json!({"finish": "pearl", "color": "#12ab9F", "two_tone": "stripe", "color2": "#ffffff", "rim": 5, "rim_color": "#c9a227",
               "rim_size": 2, "tint": 3, "wing": "gt", "exhaust": "titanium", "plate": "HQ 42-X"})
    }

    #[test]
    fn plates_are_short_plain_and_polite() {
        for ok in ["", "HQ", "HQ 42-X", "ABCD1234", "A-B C-D"] {
            assert_eq!(plate_ok(ok), Ok(()), "{ok}");
        }
        for bad in ["ABCDEFGHI", "hq", "HQ!", " HQ", "HQ ", "H  Q", "ÄBC", "FUCK", "SH1T", "B1-TCH", "5EX", "N4Z1"] {
            assert!(plate_ok(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn json_is_strict_and_canonical() {
        let t = parse_json(Kind::Car, &full()).unwrap();
        assert_eq!(to_json(Kind::Car, &t)["color"], json!("#12ab9f"), "colours come back lower case");
        assert_eq!(parse_json(Kind::Car, &to_json(Kind::Car, &t)), Ok(t.clone()), "round trip");
        assert!(parse_json(Kind::Car, &json!({})).unwrap().is_stock());
        let bad = |k: &str, v: Value| {
            let mut o = full();
            o[k] = v;
            parse_json(Kind::Car, &o)
        };
        for (k, v) in [("finish", json!("satin")), ("color", json!("red")), ("color", json!("#12345")), ("rim", json!(6)), ("rim", json!(-1)),
                       ("rim_size", json!(3)), ("rim_size", json!(-2)), ("tint", json!(4)), ("tint", json!(1.5)), ("wing", json!("huge")),
                       ("exhaust", json!("slipon")), ("plate", json!("WAY TOO LONG")), ("plate", json!(7)), ("color2", json!(null))] {
            assert!(bad(k, v.clone()).is_err(), "{k} = {v}");
        }
        assert!(parse_json(Kind::Car, &json!({"turbo": true})).is_err(), "unknown keys");
        assert!(parse_json(Kind::Car, &json!([1])).is_err());
        // a bike: its own exhausts, no wing, no roof
        assert!(parse_json(Kind::Bike, &json!({"exhaust": "underseat", "two_tone": "livery", "color2": "#000000"})).is_ok());
        assert!(parse_json(Kind::Bike, &json!({"exhaust": "quad"})).is_err());
        assert!(parse_json(Kind::Bike, &json!({"wing": "lip"})).is_err());
        assert!(parse_json(Kind::Bike, &json!({"two_tone": "roof", "color2": "#000000"})).is_err());
    }

    #[test]
    fn the_presence_code_is_short_and_round_trips() {
        let t = parse_json(Kind::Car, &full()).unwrap();
        let c = code(&t);
        assert!(c.len() <= CODE_MAX && CODE_MAX <= 33, "{c}");
        assert_eq!(c, "325333312ab9fffffffc9a227HQ_42-X");
        assert_eq!(parse_code(&c), Some(t));
        assert_eq!(code(&Tuning::default()), "0001000---");
        assert_eq!(parse_code("0001000---"), Some(Tuning::default()));
        for bad in ["", "0001000--", "9001000---", "0001000---TOOLONGPLATE", "0001000--x", "0001000---hq", "0001000---A B",
                    "0201000---", "0001000---FUCK", "0001000-ABCDEF--", "0004000---"] {
            assert_eq!(parse_code(bad), None, "{bad}");
        }
    }

    #[tokio::test]
    async fn only_the_owner_reads_and_tunes_and_stock_clears_the_row() {
        let p = pool().await;
        let (v, _) = crate::vehicles::buy(&p, A, "bmw-m3-competition", 0, NOW).await.unwrap_or_else(|_| panic!("claims"));
        let id = v["id"].as_str().unwrap().to_string();
        let got = read(&p, A, &id).await.unwrap_or_else(|_| panic!("reads"));
        assert_eq!((got["tuning"]["finish"].clone(), got["code"].clone()), (json!("gloss"), json!("0001000---")));
        let body = json!({"tuning": full(), "paint": 1}).to_string();
        assert_eq!(code_of(set(&p, B, &id, body.as_bytes(), NOW).await), StatusCode::NOT_FOUND, "not yours");
        assert_eq!(code_of(read(&p, B, &id).await), StatusCode::NOT_FOUND);
        assert_eq!(code_of(read(&p, A, "../x").await), StatusCode::NOT_FOUND);
        assert_eq!(code_of(set(&p, "", &id, body.as_bytes(), NOW).await), StatusCode::FORBIDDEN);
        let r = set(&p, A, &id, body.as_bytes(), NOW).await.unwrap_or_else(|_| panic!("tunes"));
        assert_eq!((r["paint"].clone(), r["tuning"]["wing"].clone()), (json!(1), json!("gt")));
        assert_eq!(crate::vehicles::mine(&p, A).await.unwrap()[0]["paint"], json!(1), "the paint index moved with it");
        assert_eq!(mine(&p, A).await.unwrap()[&id]["plate"], json!("HQ 42-X"));
        assert_eq!(crate::vehicles::mine(&p, A).await.unwrap()[0]["tuning"]["wing"], json!("gt"), "GET /v1/vehicles/mine carries it");
        assert_eq!(crate::garages::mine(&p, A, 0).await.unwrap()["tuning"][&id]["finish"], json!("pearl"), "and GET /v1/garages/mine");
        assert!(mine(&p, B).await.unwrap().is_empty());
        // bad bodies change nothing
        for bad in [json!({"tuning": {"finish": "satin"}}), json!({"tuning": full(), "paint": 99}), json!({"tuning": full(), "price": 0}),
                    json!({"paint": 0}), json!({"tuning": {"exhaust": "slipon"}})] {
            assert_eq!(code_of(set(&p, A, &id, bad.to_string().as_bytes(), NOW).await), StatusCode::UNPROCESSABLE_ENTITY, "{bad}");
        }
        assert_eq!(read(&p, A, &id).await.unwrap_or_else(|_| panic!("reads"))["tuning"]["plate"], json!("HQ 42-X"));
        // back to stock: no row
        set(&p, A, &id, json!({"tuning": {}}).to_string().as_bytes(), NOW).await.unwrap_or_else(|_| panic!("resets"));
        let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM vehicle_tuning").fetch_one(&p).await.unwrap();
        assert_eq!(n, 0);
        // a bike is validated as a bike; the row goes with the vehicle
        let (b, _) = crate::vehicles::buy(&p, A, "ktm-390-duke", 0, NOW).await.unwrap_or_else(|_| panic!("claims"));
        let bid = b["id"].as_str().unwrap().to_string();
        assert_eq!(code_of(set(&p, A, &bid, json!({"tuning": {"wing": "gt"}}).to_string().as_bytes(), NOW).await), StatusCode::UNPROCESSABLE_ENTITY);
        set(&p, A, &bid, json!({"tuning": {"exhaust": "endcan"}}).to_string().as_bytes(), NOW).await.unwrap_or_else(|_| panic!("tunes the bike"));
        sqlx::query("DELETE FROM owned_vehicles WHERE id = ?1").bind(&bid).execute(&p).await.unwrap();
        assert!(mine(&p, A).await.unwrap().is_empty(), "the tuning went with the vehicle");
    }
}
