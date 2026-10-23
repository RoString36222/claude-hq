//! HQ Studio (3.15): a user's customised building and interiors, stored per
//! user and shown to visitors next to the rest of their HQ.
//!
//! The document is a closed vocabulary: enum keys, `#rrggbb` colours, a few
//! booleans and a grid of furniture -- no free text at all, so nothing a
//! transcript said can ride along. Everything is driven by `data/hqstyle.json`
//! (byte-identical to `games/hqstyle/schema.json`, which the page reads), so a
//! new option is a data change and the two sides cannot drift.
//!
//! Strict on the way in (any unknown key or value is a 422, never a stored
//! surprise) and fully normalized on the way out: every `ext` key, every
//! group in `int`, both floors' themes, colours lowercased.

use axum::{
    extract::{Request, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::{json, Map, Value};
use sqlx::{Row, SqlitePool};
use std::collections::{HashMap, HashSet};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

/// A PUT body is `{"style": <doc>}`; the doc itself is capped at
/// `schema.maxBytes`, this only bounds what is read off the socket (a
/// pretty-printed doc can be larger than its compact form).
const MAX_BODY: usize = 32 * 1024;
/// `GET /v1/hq/styles?ids=` takes at most this many ids.
pub(crate) const IDS_MAX: usize = 100;
/// Saves per user per window; the editor debounces, so this only stops a loop.
const SAVE_BURST: u32 = 20;
const SAVE_WINDOW: Duration = Duration::from_secs(10);

// --- the schema -----------------------------------------------------------

#[derive(Debug)]
enum Field {
    Enum(Vec<String>, String),
    Color(String),
    Set(Vec<String>, usize, Vec<String>),
    Bool(bool),
}

/// An ordered object of fields (`ext`, one floor's theme, `int.lobby`, ...).
type Group = Vec<(String, Field)>;

#[derive(Debug)]
pub(crate) struct Schema {
    v: i64,
    max_bytes: usize,
    ext: Group,
    floors: Vec<String>,
    theme: Group,
    /// Every other object-of-fields under `int` (today: `lobby`), in file order.
    int_groups: Vec<(String, Group)>,
    kinds: Vec<String>,
    items_max: usize,
    per_floor: usize,
    grid: i64,
    rot: i64,
}

fn strs(v: &Value) -> Vec<String> {
    v.as_array().map(|a| a.iter().filter_map(|s| s.as_str().map(str::to_string)).collect()).unwrap_or_default()
}

fn parse_field(spec: &Value) -> Option<Field> {
    let def = spec.get("def")?;
    if spec.get("color").and_then(Value::as_bool) == Some(true) {
        return Some(Field::Color(def.as_str()?.to_ascii_lowercase()));
    }
    if spec.get("bool").and_then(Value::as_bool) == Some(true) {
        return Some(Field::Bool(def.as_bool()?));
    }
    if let Some(set) = spec.get("set") {
        let max = spec.get("max").and_then(Value::as_u64)? as usize;
        return Some(Field::Set(strs(set), max, strs(def)));
    }
    let e = strs(spec.get("enum")?);
    Some(Field::Enum(e, def.as_str()?.to_string()))
}

/// `Some` only when every entry of `v` is a field spec.
fn parse_group(v: &Value) -> Option<Group> {
    let o = v.as_object()?;
    o.iter().map(|(k, spec)| parse_field(spec).map(|f| (k.clone(), f))).collect()
}

pub(crate) fn parse_schema(text: &str) -> Schema {
    let s: Value = serde_json::from_str(text).expect("hqstyle.json is JSON");
    let int = &s["int"];
    let items = &int["items"];
    let n = |v: &Value| v.as_u64().expect("hqstyle.json: a number") as usize;
    let int_groups = int
        .as_object()
        .expect("hqstyle.json: int")
        .iter()
        .filter(|(k, _)| !matches!(k.as_str(), "floors" | "theme" | "items" | "themes"))
        .map(|(k, v)| (k.clone(), parse_group(v).unwrap_or_else(|| panic!("hqstyle.json: int.{k}"))))
        .collect();
    Schema {
        v: s["v"].as_i64().expect("hqstyle.json: v"),
        max_bytes: n(&s["maxBytes"]),
        ext: parse_group(&s["ext"]).expect("hqstyle.json: ext"),
        floors: strs(&int["floors"]),
        theme: parse_group(&int["theme"]).expect("hqstyle.json: int.theme"),
        int_groups,
        kinds: strs(&items["kinds"]),
        items_max: n(&items["max"]),
        per_floor: n(&items["maxPerFloor"]),
        grid: items["grid"].as_i64().expect("hqstyle.json: grid"),
        rot: items["rot"].as_i64().expect("hqstyle.json: rot"),
    }
}

pub(crate) static SCHEMA: LazyLock<Schema> = LazyLock::new(|| parse_schema(include_str!("../data/hqstyle.json")));

// --- validation -----------------------------------------------------------

/// `^#[0-9a-fA-F]{6}$`, the schema's `colorRe`.
fn is_colour(s: &str) -> bool {
    s.len() == 7 && s.starts_with('#') && s.bytes().skip(1).all(|b| b.is_ascii_hexdigit())
}

fn bad(path: &str, what: &str) -> String {
    format!("style.{path}: {what}")
}

fn obj<'a>(v: &'a Value, path: &str) -> Result<&'a Map<String, Value>, String> {
    v.as_object().ok_or_else(|| bad(path, "must be an object"))
}

fn field(f: &Field, v: Option<&Value>, path: &str) -> Result<Value, String> {
    let Some(v) = v else {
        return Ok(match f {
            Field::Enum(_, d) | Field::Color(d) => json!(d),
            Field::Set(_, _, d) => json!(d),
            Field::Bool(d) => json!(d),
        });
    };
    match f {
        Field::Enum(e, _) => match v.as_str() {
            Some(s) if e.iter().any(|x| x == s) => Ok(json!(s)),
            _ => Err(bad(path, "not an allowed value")),
        },
        Field::Color(_) => match v.as_str() {
            Some(s) if is_colour(s) => Ok(json!(s.to_ascii_lowercase())),
            _ => Err(bad(path, "must be a #rrggbb colour")),
        },
        Field::Bool(_) => v.as_bool().map(Value::Bool).ok_or_else(|| bad(path, "must be true or false")),
        Field::Set(set, max, _) => {
            let a = v.as_array().ok_or_else(|| bad(path, "must be a list"))?;
            if a.len() > *max {
                return Err(bad(path, "too many entries"));
            }
            let mut seen = HashSet::new();
            for x in a {
                match x.as_str() {
                    Some(s) if set.iter().any(|y| y == s) => {
                        if !seen.insert(s) {
                            return Err(bad(path, "repeats an entry"));
                        }
                    }
                    _ => return Err(bad(path, "not an allowed value")),
                }
            }
            Ok(Value::Array(a.clone()))
        }
    }
}

/// One group: unknown keys refused, missing keys filled, schema order out.
fn group(g: &Group, v: Option<&Value>, path: &str) -> Result<Value, String> {
    let empty = Map::new();
    let o = match v {
        Some(v) => obj(v, path)?,
        None => &empty,
    };
    if o.keys().any(|k| !g.iter().any(|(n, _)| n == k)) {
        return Err(bad(path, "unknown key"));
    }
    let mut out = Map::new();
    for (k, f) in g {
        out.insert(k.clone(), field(f, o.get(k), &format!("{path}.{k}"))?);
    }
    Ok(Value::Object(out))
}

fn int_in(v: &Value, lo: i64, hi: i64, path: &str) -> Result<i64, String> {
    match v.as_i64() {
        Some(n) if (lo..=hi).contains(&n) => Ok(n),
        Some(_) => Err(bad(path, "out of range")),
        None => Err(bad(path, "must be an integer")),
    }
}

fn items(s: &Schema, v: Option<&Value>) -> Result<Value, String> {
    let Some(v) = v else { return Ok(json!([])) };
    let a = v.as_array().ok_or_else(|| bad("int.items", "must be a list"))?;
    if a.len() > s.items_max {
        return Err(bad("int.items", &format!("at most {} items", s.items_max)));
    }
    let mut per_floor: HashMap<&str, usize> = HashMap::new();
    let mut cells: HashSet<(&str, i64, i64)> = HashSet::new();
    let mut out = Vec::with_capacity(a.len());
    for (i, it) in a.iter().enumerate() {
        let p = format!("int.items[{i}]");
        let o = obj(it, &p)?;
        if o.keys().any(|k| !matches!(k.as_str(), "k" | "f" | "x" | "z" | "r")) {
            return Err(bad(&p, "unknown key"));
        }
        let k = o.get("k").and_then(Value::as_str).filter(|k| s.kinds.iter().any(|x| x == k));
        let k = k.ok_or_else(|| bad(&format!("{p}.k"), "not an allowed value"))?;
        let f = o.get("f").and_then(Value::as_str).filter(|f| s.floors.iter().any(|x| x == f));
        let f = f.ok_or_else(|| bad(&format!("{p}.f"), "not an allowed value"))?;
        let need = |key: &str| o.get(key).ok_or_else(|| bad(&format!("{p}.{key}"), "required"));
        let x = int_in(need("x")?, -s.grid, s.grid, &format!("{p}.x"))?;
        let z = int_in(need("z")?, -s.grid, s.grid, &format!("{p}.z"))?;
        let r = match o.get("r") {
            Some(r) => int_in(r, 0, s.rot, &format!("{p}.r"))?,
            None => 0,
        };
        let n = per_floor.entry(f).or_default();
        *n += 1;
        if *n > s.per_floor {
            return Err(bad("int.items", &format!("at most {} items on one floor", s.per_floor)));
        }
        if !cells.insert((f, x, z)) {
            return Err(bad(&p, "two items on one cell"));
        }
        out.push(json!({"k": k, "f": f, "x": x, "z": z, "r": r}));
    }
    Ok(Value::Array(out))
}

/// Validate a style document against [`SCHEMA`] and return it normalized.
pub(crate) fn normalize(doc: &Value) -> Result<Value, String> {
    normalize_with(&SCHEMA, doc)
}

fn normalize_with(s: &Schema, doc: &Value) -> Result<Value, String> {
    let o = doc.as_object().ok_or_else(|| "style: must be an object".to_string())?;
    if serde_json::to_string(doc).map_or(usize::MAX, |t| t.len()) > s.max_bytes {
        return Err(format!("style: larger than {} bytes", s.max_bytes));
    }
    if o.keys().any(|k| !matches!(k.as_str(), "v" | "ext" | "int")) {
        return Err("style: unknown key".into());
    }
    if o.get("v").and_then(Value::as_i64) != Some(s.v) {
        return Err(format!("style.v: must be {}", s.v));
    }
    let ext = group(&s.ext, o.get("ext"), "ext")?;

    let empty = Map::new();
    let int = match o.get("int") {
        Some(v) => obj(v, "int")?,
        None => &empty,
    };
    let allowed = |k: &str| matches!(k, "themes" | "items") || s.int_groups.iter().any(|(n, _)| n == k);
    if int.keys().any(|k| !allowed(k)) {
        return Err(bad("int", "unknown key"));
    }
    let themes_in = match int.get("themes") {
        Some(v) => obj(v, "int.themes")?,
        None => &empty,
    };
    if themes_in.keys().any(|k| !s.floors.contains(k)) {
        return Err(bad("int.themes", "unknown floor"));
    }
    let mut themes = Map::new();
    for f in &s.floors {
        themes.insert(f.clone(), group(&s.theme, themes_in.get(f), &format!("int.themes.{f}"))?);
    }
    let mut int_out = Map::new();
    int_out.insert("themes".into(), Value::Object(themes));
    int_out.insert("items".into(), items(s, int.get("items"))?);
    for (k, g) in &s.int_groups {
        int_out.insert(k.clone(), group(g, int.get(k), &format!("int.{k}"))?);
    }
    Ok(json!({"v": s.v, "ext": ext, "int": Value::Object(int_out)}))
}

/// A stored row back out. Rows were normalized on the way in; one an older
/// schema accepted and this one would not reads as no style rather than a 500.
fn from_stored(text: &str) -> Option<Value> {
    serde_json::from_str::<Value>(text).ok().and_then(|v| normalize(&v).ok())
}

// --- storage --------------------------------------------------------------

pub(crate) async fn load(pool: &SqlitePool, uid: &str) -> Result<Option<Value>, sqlx::Error> {
    let t: Option<String> = sqlx::query_scalar("SELECT style FROM hq_custom WHERE user_id = ?1")
        .bind(uid)
        .fetch_optional(pool)
        .await?;
    Ok(t.as_deref().and_then(from_stored))
}

/// Styles for many users in one query, with no visibility filter: callers have
/// already decided who may be shown (the open list, a visit).
pub(crate) async fn load_many(pool: &SqlitePool, ids: &[String]) -> Result<HashMap<String, Value>, sqlx::Error> {
    let mut out = HashMap::new();
    if ids.is_empty() {
        return Ok(out);
    }
    let ph = (1..=ids.len()).map(|i| format!("?{i}")).collect::<Vec<_>>().join(",");
    let sql = format!("SELECT user_id, style FROM hq_custom WHERE user_id IN ({ph})");
    let mut q = sqlx::query(&sql);
    for id in ids {
        q = q.bind(id.as_str());
    }
    for r in q.fetch_all(pool).await? {
        let t: String = r.get("style");
        if let Some(v) = from_stored(&t) {
            out.insert(r.get("user_id"), v);
        }
    }
    Ok(out)
}

/// The styles a viewer may see among `ids`: open HQs of active users, and
/// always the viewer's own.
pub(crate) async fn visible(pool: &SqlitePool, viewer: &str, ids: &[String]) -> Result<Map<String, Value>, sqlx::Error> {
    let mut out = Map::new();
    if ids.is_empty() {
        return Ok(out);
    }
    let ph = (2..=ids.len() + 1).map(|i| format!("?{i}")).collect::<Vec<_>>().join(",");
    let sql = format!(
        "SELECT s.user_id AS user_id, s.style AS style
         FROM hq_custom s JOIN users u ON u.id = s.user_id
         LEFT JOIN hq_profiles p ON p.user_id = s.user_id
         WHERE s.user_id IN ({ph}) AND (s.user_id = ?1 OR (p.open = 1 AND u.is_active = 1))"
    );
    let mut q = sqlx::query(&sql).bind(viewer);
    for id in ids {
        q = q.bind(id.as_str());
    }
    for r in q.fetch_all(pool).await? {
        let t: String = r.get("style");
        if let Some(v) = from_stored(&t) {
            out.insert(r.get("user_id"), v);
        }
    }
    Ok(out)
}

/// Store (or with `None`, delete) the caller's own row. A save that changes
/// nothing leaves `updated_at` alone.
pub(crate) async fn save(pool: &SqlitePool, uid: &str, style: Option<&Value>) -> Result<(), sqlx::Error> {
    match style {
        None => {
            sqlx::query("DELETE FROM hq_custom WHERE user_id = ?1").bind(uid).execute(pool).await?;
        }
        Some(v) => {
            let text = v.to_string();
            sqlx::query(
                "INSERT INTO hq_custom (user_id, style, updated_at) VALUES (?1, ?2, datetime('now'))
                 ON CONFLICT(user_id) DO UPDATE SET style = excluded.style, updated_at = excluded.updated_at
                 WHERE hq_custom.style <> excluded.style",
            )
            .bind(uid)
            .bind(text)
            .execute(pool)
            .await?;
        }
    }
    Ok(())
}

// --- the wire -------------------------------------------------------------

/// `{"style": <doc>|null}` -> `Ok(None)` for a reset, `Ok(Some(normalized))`.
pub(crate) fn parse_put(bytes: &[u8]) -> Result<Option<Value>, String> {
    let body: Value = serde_json::from_slice(bytes).map_err(|_| "body must be JSON".to_string())?;
    let o = body.as_object().ok_or_else(|| "body must be an object".to_string())?;
    if o.keys().any(|k| k != "style") {
        return Err("body: unknown key".into());
    }
    match o.get("style") {
        None => Err("body.style: required (null resets)".into()),
        Some(Value::Null) => Ok(None),
        Some(v) => normalize(v).map(Some),
    }
}

/// `ids=a,b,c` from a query string: each a lowercase uuid, at most [`IDS_MAX`],
/// duplicates dropped.
pub(crate) fn parse_ids(query: Option<&str>) -> Result<Vec<String>, String> {
    let raw = query
        .unwrap_or("")
        .split('&')
        .find_map(|kv| kv.strip_prefix("ids="))
        .ok_or_else(|| "ids: required".to_string())?;
    let raw = raw.replace("%2C", ",").replace("%2c", ",");
    let mut out: Vec<String> = Vec::new();
    for id in raw.split(',').filter(|s| !s.is_empty()) {
        if !crate::cities::is_uuid(id) {
            return Err("ids: each must be a user id".into());
        }
        if !out.iter().any(|x| x == id) {
            out.push(id.to_string());
        }
    }
    if out.len() > IDS_MAX {
        return Err(format!("ids: at most {IDS_MAX}"));
    }
    Ok(out)
}

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
        Ok(s) => Json(json!({ "style": s })).into_response(),
        Err(e) => db500(e),
    }
}

pub(crate) async fn put_mine(State(st): State<crate::AppState>, req: Request) -> Response {
    let c = crate::cities::caller(&req);
    let (_, body) = req.into_parts();
    let Ok(bytes) = axum::body::to_bytes(body, MAX_BODY).await else {
        return crate::err(StatusCode::PAYLOAD_TOO_LARGE, "body too large");
    };
    let style = match parse_put(&bytes) {
        Ok(s) => s,
        Err(m) => return crate::err(StatusCode::UNPROCESSABLE_ENTITY, &m),
    };
    if !save_allowed(&c.user_id, Instant::now()) {
        return crate::err(StatusCode::TOO_MANY_REQUESTS, "slow down");
    }
    match save(&st.pool, &c.user_id, style.as_ref()).await {
        Ok(()) => Json(json!({ "style": style })).into_response(),
        Err(e) => db500(e),
    }
}

pub(crate) async fn get_many(State(st): State<crate::AppState>, req: Request) -> Response {
    let c = crate::cities::caller(&req);
    let ids = match parse_ids(req.uri().query()) {
        Ok(ids) => ids,
        Err(m) => return crate::err(StatusCode::UNPROCESSABLE_ENTITY, &m),
    };
    match visible(&st.pool, &c.user_id, &ids).await {
        Ok(m) => Json(json!({ "styles": m })).into_response(),
        Err(e) => db500(e),
    }
}

#[cfg(test)]
mod tests;
