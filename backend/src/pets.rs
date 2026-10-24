//! Pets (HQ 3.14): the dogs, cats, dragons, dinosaurs and sea serpents players adopt at
//! the City's Pet shop, and walk round the HQ, the City and B1 with.
//!
//!   GET  /v1/pets/mine                       -> {pets, max, active_max, level, coins}
//!   POST /v1/pets/adopt {species, variant, name} -> {ok, pet, coins, paid}
//!   POST /v1/pets/:id/edit {name?, variant?, acc?, active?, home?} -> {ok, pet}
//!   POST /v1/pets/:id/care {kind}            -> {ok, affection, gained}
//!   POST /v1/pets/:id/release                -> {ok}
//!   GET  /v1/pets/home/:user_id              -> {pets: [{species, variant, acc, name, stage}]}
//!
//! The roster is [`SPECIES`], index for index the browser's `games/hqpets.js` SPECIES
//! (tests/test_hqpets.py checks the two agree): presence names a species by its index.
//!
//! Adoption: the common pets (dogs and cats) are free from level 1. Each rarer one has a
//! level (`min_level`, the caller's HQ level, cosmetics::hq_level) at which it is free,
//! or can be adopted sooner for `price` Poke Coins (paid from poke_balances in the same
//! transaction as the owned_pets row). At most [`MAX_OWNED`] pets; at most [`MAX_ACTIVE`]
//! out at once. Names: 1..=[`NAME_MAX`] characters of letters, digits, spaces, `-` and
//! `'`, run through a light word filter ([`clean_name`]).
//!
//! Affection grows with care (petting 1, fetch 2, a trick 1), at most [`CARE_PER_DAY`]
//! per pet per UTC day, up to [`AFFECTION_MAX`]; a dragon or a sea serpent grows with it
//! ([`stage_of`]).
//!
//! Errors: 422 a bad body; 404 an unknown species, or a pet that is not yours; 409 too
//! many pets or too many out, or a saddle on a pet too small for one; 402 not enough coins
//! (before its level).
//!
//! PRIVACY: species ids, small numbers and the name the user typed for their pet only.

use axum::{
    extract::{Path, Request, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde_json::{json, Map, Value};
use sqlx::{Row, SqlitePool};

use crate::cities::{self, Refuse};

/// Most pets one player may own, and have out with them at once.
pub const MAX_OWNED: i64 = 6;
pub const MAX_ACTIVE: i64 = 2;
/// A pet's name, in characters.
pub const NAME_MAX: usize = 12;
/// Colour / pattern variants per species (0..VARIANTS).
pub const VARIANTS: i64 = 4;
/// Accessory bits: collar 1, bandana 2, hat 4, saddle 8 (only where `saddle`), bow 16.
pub const ACC_MAX: i64 = 31;
pub const ACC_SADDLE: i64 = 8;
pub const AFFECTION_MAX: i64 = 1000;
/// Affection a pet may gain per UTC day.
pub const CARE_PER_DAY: i64 = 40;
/// Affection at which a grower reaches stage 1 and 2. Since 3.14.1 nothing here reads it (stage_of grows every pet
/// from adoption); kept as the page's twin (games/hqpets.js STAGE_AT, tests/test_hqpets.py checks they agree).
#[allow(dead_code)]
pub const STAGE_AT: [i64; 2] = [150, 400];

/// One species: its id, the HQ level from which it is free, its price in Poke Coins
/// before that level (0: free from `min_level`, which is 1 for the common pets), whether
/// it is big enough for a saddle, and whether it grows with affection.
pub struct Species {
    pub id: &'static str,
    pub min_level: i64,
    pub price: i64,
    pub saddle: bool,
    pub grows: bool,
}

const fn sp(id: &'static str, min_level: i64, price: i64, saddle: bool, grows: bool) -> Species {
    Species { id, min_level, price, saddle, grows }
}

/// The roster, in presence order (append only: an index is what presence sends).
pub const SPECIES: &[Species] = &[
    sp("shiba", 1, 0, false, false),
    sp("retriever", 1, 0, false, false),
    sp("corgi", 1, 0, false, false),
    sp("husky", 1, 0, false, false),
    sp("dachshund", 1, 0, false, false),
    sp("tabby", 1, 0, false, false),
    sp("siamese", 1, 0, false, false),
    sp("mainecoon", 1, 0, false, false),
    sp("blackcat", 1, 0, false, false),
    sp("wyvern", 6, 400, false, true),
    sp("firedragon", 10, 800, true, true),
    sp("icedragon", 10, 800, true, true),
    sp("stormdragon", 15, 1500, true, true),
    sp("trex", 5, 300, true, false),
    sp("triceratops", 5, 300, true, false),
    sp("raptor", 5, 300, false, false),
    sp("brachio", 10, 800, true, false),
    sp("stego", 5, 300, true, false),
    sp("crystaldragon", 25, 3000, true, true),
    sp("shadowdragon", 20, 2500, true, true),
    sp("golddragon", 30, 5000, true, true),
    sp("seaserpent", 18, 2000, false, true),
];

pub fn species(id: &str) -> Option<&'static Species> {
    SPECIES.iter().find(|s| s.id == id)
}

/// The big dinosaurs you can ride (they do not grow; the page asks for the grown mark's affection).
pub const RIDE_DINO: &[&str] = &["trex", "triceratops", "brachio", "stego"];

/// Whether a pet as presence shows it (`pt`: species index, stage) can carry a rider (HQ 3.14, "petride"): a grown
/// grower (the dragons, the sea serpent) or one of the big dinosaurs (games/hqpetride.js rideKind / grown).
pub fn rideable(species_index: u8, stage: u8) -> bool {
    SPECIES.get(usize::from(species_index)).is_some_and(|s| if s.grows { stage == 2 } else { RIDE_DINO.contains(&s.id) })
}

/// A grower's stage (0 hatchling, 1 young, 2 grown); 0 for everyone else. Since 3.14 a dragon or the sea
/// serpent comes fully grown (ready to ride) from adoption, whatever its `affection` (STAGE_AT is kept for
/// the record and for tricks' pacing).
pub fn stage_of(s: &Species, _affection: i64) -> i64 {
    if !s.grows {
        0
    } else {
        2
    }
}

/// Words a pet's name may not contain (a light filter: lowercased, common look-alike
/// digits read as letters, everything but letters dropped first). The browser keeps the
/// same list (games/hqpets.js BAD_WORDS).
pub const BAD_WORDS: &[&str] = &[
    "fuck", "shit", "cunt", "bitch", "dick", "cock", "pussy", "nigg", "fag", "slut", "whore", "rape", "nazi",
    "twat", "wank", "porn", "penis", "vagin", "asshole", "bastard", "hitler", "retard",
];

fn letters(s: &str) -> String {
    s.chars()
        .filter_map(|c| {
            let c = c.to_ascii_lowercase();
            let c = match c {
                '0' => 'o',
                '1' | '!' => 'i',
                '3' => 'e',
                '4' | '@' => 'a',
                '5' | '$' => 's',
                '7' => 't',
                c => c,
            };
            c.is_ascii_lowercase().then_some(c)
        })
        .collect()
}

/// A pet's name as it is kept: trimmed, runs of spaces made one, 1..=NAME_MAX characters
/// of ASCII letters, digits, spaces, `-` and `'`, with a letter or digit in it and none of
/// [`BAD_WORDS`]. None for anything else.
pub fn clean_name(raw: &str) -> Option<String> {
    let s = raw.split(' ').filter(|w| !w.is_empty()).collect::<Vec<_>>().join(" ");
    let n = s.chars().count();
    if n == 0 || n > NAME_MAX {
        return None;
    }
    if !s.chars().all(|c| c.is_ascii_alphanumeric() || c == ' ' || c == '-' || c == '\'') {
        return None;
    }
    if !s.chars().any(|c| c.is_ascii_alphanumeric()) {
        return None;
    }
    let l = letters(&s);
    if BAD_WORDS.iter().any(|w| l.contains(w)) {
        return None;
    }
    Some(s)
}

/// Accessories for a species: within ACC_MAX, a saddle only where it fits.
pub fn acc_ok(s: &Species, acc: i64) -> bool {
    (0..=ACC_MAX).contains(&acc) && (s.saddle || acc & ACC_SADDLE == 0)
}

pub fn routes() -> Router<crate::AppState> {
    Router::new()
        .route("/v1/pets/mine", get(get_mine))
        .route("/v1/pets/adopt", post(post_adopt))
        .route("/v1/pets/home/:user_id", get(get_home))
        .route("/v1/pets/:id/edit", post(post_edit))
        .route("/v1/pets/:id/care", post(post_care))
        .route("/v1/pets/:id/release", post(post_release))
}

fn object(bytes: &[u8], keys: &[&str]) -> Result<Map<String, Value>, String> {
    let Ok(Value::Object(o)) = serde_json::from_slice::<Value>(bytes) else {
        return Err("body must be a JSON object".into());
    };
    if let Some(k) = o.keys().find(|k| !keys.contains(&k.as_str())) {
        return Err(format!("unknown field {k:?}"));
    }
    Ok(o)
}

fn name_field(o: &Map<String, Value>) -> Result<String, String> {
    o.get("name")
        .and_then(Value::as_str)
        .and_then(clean_name)
        .ok_or_else(|| format!("name must be 1 to {NAME_MAX} letters, digits, spaces, - or ', and kind"))
}

fn variant_field(o: &Map<String, Value>) -> Result<i64, String> {
    match o.get("variant") {
        None => Ok(0),
        Some(v) => v.as_i64().filter(|n| (0..VARIANTS).contains(n)).ok_or_else(|| format!("variant must be 0 to {}", VARIANTS - 1)),
    }
}

/// {species, variant, name} from an adopt body.
pub(crate) fn parse_adopt(bytes: &[u8]) -> Result<(String, i64, String), String> {
    let o = object(bytes, &["species", "variant", "name"])?;
    let id = o.get("species").and_then(Value::as_str).filter(|s| s.len() <= 24 && s.bytes().all(|b| b.is_ascii_lowercase())).ok_or("species must be a species id")?;
    Ok((id.to_string(), variant_field(&o)?, name_field(&o)?))
}

/// An edit: each field optional, at least one.
#[derive(Debug, Default, PartialEq)]
pub(crate) struct Edit {
    pub name: Option<String>,
    pub variant: Option<i64>,
    pub acc: Option<i64>,
    pub active: Option<bool>,
    pub home: Option<bool>,
}

pub(crate) fn parse_edit(bytes: &[u8]) -> Result<Edit, String> {
    let o = object(bytes, &["name", "variant", "acc", "active", "home"])?;
    if o.is_empty() {
        return Err("nothing to change".into());
    }
    let flag = |k: &str| -> Result<Option<bool>, String> {
        match o.get(k) {
            None => Ok(None),
            Some(Value::Bool(b)) => Ok(Some(*b)),
            Some(_) => Err(format!("{k} must be true or false")),
        }
    };
    Ok(Edit {
        name: if o.contains_key("name") { Some(name_field(&o)?) } else { None },
        variant: if o.contains_key("variant") { Some(variant_field(&o)?) } else { None },
        acc: match o.get("acc") {
            None => None,
            Some(v) => Some(v.as_i64().filter(|n| (0..=ACC_MAX).contains(n)).ok_or_else(|| format!("acc must be 0 to {ACC_MAX}"))?),
        },
        active: flag("active")?,
        home: flag("home")?,
    })
}

/// Affection a kind of care earns.
pub(crate) fn parse_care(bytes: &[u8]) -> Result<i64, String> {
    let o = object(bytes, &["kind"])?;
    match o.get("kind").and_then(Value::as_str) {
        Some("pet") | Some("trick") => Ok(1),
        Some("fetch") => Ok(2),
        _ => Err("kind must be pet, fetch or trick".into()),
    }
}

fn row_json(r: &sqlx::sqlite::SqliteRow) -> Value {
    let id: String = r.get("species");
    let aff: i64 = r.get("affection");
    let stage = species(&id).map_or(0, |s| stage_of(s, aff));
    json!({"id": r.get::<String, _>("id"), "species": id, "variant": r.get::<i64, _>("variant"),
           "name": r.get::<String, _>("name"), "acc": r.get::<i64, _>("acc"), "affection": aff, "stage": stage,
           "active": r.get::<i64, _>("active") == 1, "home": r.get::<i64, _>("home") == 1,
           "adopted_at": r.get::<i64, _>("adopted_at")})
}

const COLS: &str = "id, species, variant, name, acc, affection, active, home, adopted_at";

pub(crate) async fn mine(pool: &SqlitePool, uid: &str) -> Result<Vec<Value>, sqlx::Error> {
    let rows = sqlx::query(&format!("SELECT {COLS} FROM owned_pets WHERE user_id = ?1 ORDER BY adopted_at, id"))
        .bind(uid)
        .fetch_all(pool)
        .await?;
    Ok(rows.iter().map(row_json).collect())
}

async fn one(conn: &mut sqlx::SqliteConnection, uid: &str, id: &str) -> Result<Option<sqlx::sqlite::SqliteRow>, sqlx::Error> {
    sqlx::query(&format!("SELECT {COLS}, care_day, care_n FROM owned_pets WHERE id = ?1 AND user_id = ?2"))
        .bind(id)
        .bind(uid)
        .fetch_optional(conn)
        .await
}

async fn coins_of(conn: &mut sqlx::SqliteConnection, uid: &str) -> Result<i64, sqlx::Error> {
    Ok(sqlx::query_scalar("SELECT qty FROM poke_balances WHERE user_id = ?1 AND item = 'coins'")
        .bind(uid)
        .fetch_optional(conn)
        .await?
        .unwrap_or(0))
}

/// `uid` adopts a `species` pet. Returns (the pet, coins left, coins paid).
pub(crate) async fn adopt(pool: &SqlitePool, uid: &str, species_id: &str, variant: i64, name: &str, now: i64) -> Result<(Value, i64, i64), Refuse> {
    let s = species(species_id).ok_or_else(|| Refuse::say(StatusCode::NOT_FOUND, "no such pet"))?;
    let level = if s.min_level > 1 { crate::cosmetics::hq_level(pool, uid).await? } else { 1 };
    // free from its level; before that, for its price (when it has one)
    let price = if level >= s.min_level { 0 } else { s.price };
    if level < s.min_level && price == 0 {
        return Err(Refuse::say(StatusCode::FORBIDDEN, format!("this pet needs level {} (you're level {level})", s.min_level)));
    }
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let owned: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM owned_pets WHERE user_id = ?1").bind(uid).fetch_one(&mut *tx).await?;
    if owned >= MAX_OWNED {
        return Err(Refuse::say(StatusCode::CONFLICT, format!("you have {MAX_OWNED} pets already: rehome one first")));
    }
    if price > 0 {
        let paid = sqlx::query(
            "UPDATE poke_balances SET qty = qty - ?1, updated_at = CURRENT_TIMESTAMP
             WHERE user_id = ?2 AND item = 'coins' AND qty >= ?1",
        )
        .bind(price)
        .bind(uid)
        .execute(&mut *tx)
        .await?
        .rows_affected()
            == 1;
        if !paid {
            let have = coins_of(&mut tx, uid).await?;
            return Err(Refuse::say(
                StatusCode::PAYMENT_REQUIRED,
                format!("free at level {}, or {price} Poke Coins now (you have {have})", s.min_level),
            ));
        }
    }
    // the first two come out with you; the rest wait at home
    let active: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM owned_pets WHERE user_id = ?1 AND active = 1").bind(uid).fetch_one(&mut *tx).await?;
    let id = uuid::Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO owned_pets (id, user_id, species, variant, name, acc, affection, active, home, price, adopted_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 1, 0, ?6, 1, ?7, ?8)",
    )
    .bind(&id)
    .bind(uid)
    .bind(s.id)
    .bind(variant)
    .bind(name)
    .bind(i64::from(active < MAX_ACTIVE))
    .bind(price)
    .bind(now)
    .execute(&mut *tx)
    .await?;
    let row = one(&mut tx, uid, &id).await?.ok_or(sqlx::Error::RowNotFound)?;
    let coins = coins_of(&mut tx, uid).await?;
    tx.commit().await?;
    Ok((row_json(&row), coins, price))
}

pub(crate) async fn edit(pool: &SqlitePool, uid: &str, id: &str, e: &Edit) -> Result<Value, Refuse> {
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let row = one(&mut tx, uid, id).await?.ok_or_else(|| Refuse::say(StatusCode::NOT_FOUND, "no such pet"))?;
    let s = species(&row.get::<String, _>("species")).ok_or_else(|| Refuse::say(StatusCode::NOT_FOUND, "no such pet"))?;
    if let Some(acc) = e.acc {
        if !acc_ok(s, acc) {
            return Err(Refuse::say(StatusCode::CONFLICT, "a saddle only fits the big ones"));
        }
    }
    if e.active == Some(true) && row.get::<i64, _>("active") == 0 {
        let out: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM owned_pets WHERE user_id = ?1 AND active = 1").bind(uid).fetch_one(&mut *tx).await?;
        if out >= MAX_ACTIVE {
            return Err(Refuse::say(StatusCode::CONFLICT, format!("{MAX_ACTIVE} pets are out already: leave one at home first")));
        }
    }
    sqlx::query(
        "UPDATE owned_pets SET name = COALESCE(?1, name), variant = COALESCE(?2, variant), acc = COALESCE(?3, acc),
         active = COALESCE(?4, active), home = COALESCE(?5, home) WHERE id = ?6 AND user_id = ?7",
    )
    .bind(e.name.as_deref())
    .bind(e.variant)
    .bind(e.acc)
    .bind(e.active.map(i64::from))
    .bind(e.home.map(i64::from))
    .bind(id)
    .bind(uid)
    .execute(&mut *tx)
    .await?;
    let row = one(&mut tx, uid, id).await?.ok_or(sqlx::Error::RowNotFound)?;
    tx.commit().await?;
    Ok(row_json(&row))
}

/// Care for a pet: `gain` affection, within today's allowance. Returns (affection, gained).
pub(crate) async fn care(pool: &SqlitePool, uid: &str, id: &str, gain: i64, now: i64) -> Result<(i64, i64), Refuse> {
    let day = now.div_euclid(86_400);
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let row = one(&mut tx, uid, id).await?.ok_or_else(|| Refuse::say(StatusCode::NOT_FOUND, "no such pet"))?;
    let aff: i64 = row.get("affection");
    let used = if row.get::<i64, _>("care_day") == day { row.get::<i64, _>("care_n") } else { 0 };
    let got = gain.min(CARE_PER_DAY - used).min(AFFECTION_MAX - aff).max(0);
    sqlx::query("UPDATE owned_pets SET affection = ?1, care_day = ?2, care_n = ?3 WHERE id = ?4 AND user_id = ?5")
        .bind(aff + got)
        .bind(day)
        .bind(used + got)
        .bind(id)
        .bind(uid)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok((aff + got, got))
}

pub(crate) async fn release(pool: &SqlitePool, uid: &str, id: &str) -> Result<(), Refuse> {
    let r = sqlx::query("DELETE FROM owned_pets WHERE id = ?1 AND user_id = ?2").bind(id).bind(uid).execute(pool).await?;
    if r.rows_affected() == 0 {
        return Err(Refuse::say(StatusCode::NOT_FOUND, "no such pet"));
    }
    Ok(())
}

/// The pets that live in `host`'s lobby (home, not out), for a visitor: only while their
/// HQ is open to visitors (or it is your own). None: not open (one answer for every cause).
pub(crate) async fn home_of(pool: &SqlitePool, viewer: &str, host: &str) -> Result<Option<Vec<Value>>, sqlx::Error> {
    let active: Option<i64> = sqlx::query_scalar("SELECT is_active FROM users WHERE id = ?1").bind(host).fetch_optional(pool).await?;
    if active.unwrap_or(0) == 0 {
        return Ok(None);
    }
    if viewer != host {
        let open: Option<i64> = sqlx::query_scalar("SELECT open FROM hq_profiles WHERE user_id = ?1").bind(host).fetch_optional(pool).await?;
        if open.unwrap_or(0) == 0 {
            return Ok(None);
        }
    }
    let rows = sqlx::query("SELECT species, variant, acc, name, affection FROM owned_pets WHERE user_id = ?1 AND home = 1 AND active = 0 ORDER BY adopted_at, id LIMIT 6")
        .bind(host)
        .fetch_all(pool)
        .await?;
    Ok(Some(
        rows.iter()
            .filter_map(|r| {
                let s = species(&r.get::<String, _>("species"))?;
                Some(json!({"species": s.id, "variant": r.get::<i64, _>("variant"), "acc": r.get::<i64, _>("acc"),
                            "name": r.get::<String, _>("name"), "stage": stage_of(s, r.get("affection"))}))
            })
            .collect(),
    ))
}

async fn get_mine(State(st): State<crate::AppState>, req: Request) -> Response {
    let c = cities::caller(&req);
    let res = async {
        let pets = mine(&st.pool, &c.user_id).await?;
        let level = crate::cosmetics::hq_level(&st.pool, &c.user_id).await?;
        let mut conn = st.pool.acquire().await?;
        let coins = coins_of(&mut conn, &c.user_id).await?;
        Ok::<_, sqlx::Error>((pets, level, coins))
    }
    .await;
    match res {
        Ok((pets, level, coins)) => Json(json!({"pets": pets, "max": MAX_OWNED, "active_max": MAX_ACTIVE, "level": level, "coins": coins})).into_response(),
        Err(e) => Refuse::Db(e).response(),
    }
}

async fn post_adopt(State(st): State<crate::AppState>, req: Request) -> Response {
    let c = cities::caller(&req);
    let bytes = match cities::read_body(req).await {
        Ok(b) => b,
        Err(r) => return r.response(),
    };
    let (sid, variant, name) = match parse_adopt(&bytes) {
        Ok(v) => v,
        Err(m) => return crate::err(StatusCode::UNPROCESSABLE_ENTITY, &m),
    };
    match adopt(&st.pool, &c.user_id, &sid, variant, &name, cities::now_secs()).await {
        Ok((pet, coins, paid)) => Json(json!({"ok": true, "pet": pet, "coins": coins, "paid": paid})).into_response(),
        Err(r) => r.response(),
    }
}

async fn post_edit(State(st): State<crate::AppState>, Path(id): Path<String>, req: Request) -> Response {
    let c = cities::caller(&req);
    if !cities::is_uuid(&id) {
        return crate::err(StatusCode::NOT_FOUND, "no such pet");
    }
    let bytes = match cities::read_body(req).await {
        Ok(b) => b,
        Err(r) => return r.response(),
    };
    let e = match parse_edit(&bytes) {
        Ok(v) => v,
        Err(m) => return crate::err(StatusCode::UNPROCESSABLE_ENTITY, &m),
    };
    match edit(&st.pool, &c.user_id, &id, &e).await {
        Ok(pet) => Json(json!({"ok": true, "pet": pet})).into_response(),
        Err(r) => r.response(),
    }
}

async fn post_care(State(st): State<crate::AppState>, Path(id): Path<String>, req: Request) -> Response {
    let c = cities::caller(&req);
    if !cities::is_uuid(&id) {
        return crate::err(StatusCode::NOT_FOUND, "no such pet");
    }
    let bytes = match cities::read_body(req).await {
        Ok(b) => b,
        Err(r) => return r.response(),
    };
    let gain = match parse_care(&bytes) {
        Ok(v) => v,
        Err(m) => return crate::err(StatusCode::UNPROCESSABLE_ENTITY, &m),
    };
    match care(&st.pool, &c.user_id, &id, gain, cities::now_secs()).await {
        Ok((aff, got)) => Json(json!({"ok": true, "affection": aff, "gained": got})).into_response(),
        Err(r) => r.response(),
    }
}

async fn post_release(State(st): State<crate::AppState>, Path(id): Path<String>, req: Request) -> Response {
    let c = cities::caller(&req);
    if !cities::is_uuid(&id) {
        return crate::err(StatusCode::NOT_FOUND, "no such pet");
    }
    match release(&st.pool, &c.user_id, &id).await {
        Ok(()) => Json(json!({"ok": true})).into_response(),
        Err(r) => r.response(),
    }
}

async fn get_home(State(st): State<crate::AppState>, Path(host): Path<String>, req: Request) -> Response {
    let c = cities::caller(&req);
    if !cities::is_uuid(&host) {
        return crate::err(StatusCode::NOT_FOUND, "that HQ is not open to visitors");
    }
    match home_of(&st.pool, &c.user_id, &host).await {
        Ok(Some(pets)) => Json(json!({"pets": pets})).into_response(),
        Ok(None) => crate::err(StatusCode::NOT_FOUND, "that HQ is not open to visitors"),
        Err(e) => Refuse::Db(e).response(),
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

    async fn prompts(p: &SqlitePool, uid: &str, n: i64) {
        sqlx::query(
            "INSERT INTO daily_stats (id, user_id, stat_date, prompts, tools, artifacts, replies,
             tokens_input, tokens_output, tokens_cache_read, tokens_cache_creation)
             VALUES (?1, ?2, '2026-10-01', ?3, 0, 0, 0, 0, 0, 0, 0)",
        )
        .bind(uuid::Uuid::new_v4().to_string())
        .bind(uid)
        .bind(n)
        .execute(p)
        .await
        .unwrap();
    }

    async fn coins(p: &SqlitePool, uid: &str, n: i64) {
        sqlx::query("INSERT OR REPLACE INTO poke_balances (id, user_id, item, qty) VALUES (?1, ?2, 'coins', ?3)")
            .bind(uuid::Uuid::new_v4().to_string())
            .bind(uid)
            .bind(n)
            .execute(p)
            .await
            .unwrap();
    }

    async fn balance(p: &SqlitePool, uid: &str) -> i64 {
        sqlx::query_scalar("SELECT qty FROM poke_balances WHERE user_id = ?1 AND item = 'coins'").bind(uid).fetch_optional(p).await.unwrap().unwrap_or(0)
    }

    fn code<T>(r: Result<T, Refuse>) -> StatusCode {
        match r {
            Err(Refuse::Say(c, _)) => c,
            Err(Refuse::Db(e)) => panic!("db error {e}"),
            Ok(_) => StatusCode::OK,
        }
    }

    #[test]
    fn the_roster_is_unique_and_the_common_pets_are_free() {
        let mut ids: Vec<&str> = SPECIES.iter().map(|s| s.id).collect();
        assert_eq!(ids.len(), 22);
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), SPECIES.len(), "unique ids");
        for s in &SPECIES[..9] {
            assert_eq!((s.min_level, s.price), (1, 0), "{}: dogs and cats are free", s.id);
        }
        let gold = species("golddragon").unwrap();
        assert!(SPECIES.iter().all(|s| s.id == "golddragon" || (s.min_level < gold.min_level && s.price < gold.price)), "the golden dragon is the rarest");
        assert!(species("icedragon").is_some_and(|s| s.grows && s.saddle));
        assert!(species("seaserpent").is_some_and(|s| s.grows && !s.saddle));
        // [3.14] who carries a rider: a grown dragon or serpent, a big dinosaur; never a dog, a hatchling or the raptor
        let ix = |id: &str| SPECIES.iter().position(|s| s.id == id).unwrap() as u8;
        assert!(rideable(ix("firedragon"), 2) && rideable(ix("seaserpent"), 2) && rideable(ix("wyvern"), 2));
        assert!(!rideable(ix("firedragon"), 1) && !rideable(ix("seaserpent"), 0));
        assert!(rideable(ix("triceratops"), 0) && rideable(ix("brachio"), 0) && rideable(ix("stego"), 0) && rideable(ix("trex"), 0));
        assert!(!rideable(ix("raptor"), 0) && !rideable(ix("shiba"), 0) && !rideable(99, 2));
    }

    #[test]
    fn names_are_short_plain_and_kind() {
        assert_eq!(clean_name("  Rex  "), Some("Rex".into()));
        assert_eq!(clean_name("Sir  Barks-a-lot"), None, "too long");
        assert_eq!(clean_name("Mr  Biscuit"), Some("Mr Biscuit".into()));
        assert_eq!(clean_name("O'Malley"), Some("O'Malley".into()));
        assert_eq!(clean_name("R2-D2"), Some("R2-D2".into()));
        for bad in ["", "   ", "--", "<b>hi</b>", "Zoë", "a\nb", "x".repeat(13).as_str(), "Sh1tz", "fUcK", "b1tch", "a$$hole"] {
            assert_eq!(clean_name(bad), None, "{bad:?}");
        }
        assert_eq!(clean_name("Scunthorpe"), None, "a light filter errs on the safe side");
    }

    #[test]
    fn bodies_are_strict() {
        assert_eq!(parse_adopt(br#"{"species":"shiba","variant":2,"name":"Mochi"}"#), Ok(("shiba".into(), 2, "Mochi".into())));
        assert_eq!(parse_adopt(br#"{"species":"shiba","name":"Mochi"}"#), Ok(("shiba".into(), 0, "Mochi".into())));
        for bad in [&br#"{"species":"shiba","variant":4,"name":"M"}"#[..], br#"{"species":"Shiba","name":"M"}"#, br#"{"species":"shiba"}"#,
                    br#"{"species":"shiba","name":"M","price":0}"#, br#"{"species":"../x","name":"M"}"#, b"[]"] {
            assert!(parse_adopt(bad).is_err(), "{}", String::from_utf8_lossy(bad));
        }
        assert_eq!(parse_edit(br#"{"acc":9,"active":true}"#), Ok(Edit { acc: Some(9), active: Some(true), ..Edit::default() }));
        assert_eq!(parse_edit(br#"{"home":false,"name":" Bo "}"#), Ok(Edit { home: Some(false), name: Some("Bo".into()), ..Edit::default() }));
        for bad in [&br#"{}"#[..], br#"{"acc":32}"#, br#"{"active":1}"#, br#"{"name":"<x>"}"#, br#"{"affection":1000}"#, br#"{"variant":-1}"#] {
            assert!(parse_edit(bad).is_err(), "{}", String::from_utf8_lossy(bad));
        }
        assert_eq!((parse_care(br#"{"kind":"pet"}"#), parse_care(br#"{"kind":"fetch"}"#)), (Ok(1), Ok(2)));
        assert!(parse_care(br#"{"kind":"feed","n":1000}"#).is_err());
    }

    #[test]
    fn growers_come_fully_grown() {
        let ice = species("icedragon").unwrap();
        assert_eq!([0, 149, 150, 399, 400, 1000].map(|a| stage_of(ice, a)), [2, 2, 2, 2, 2, 2]);
        assert_eq!(stage_of(species("corgi").unwrap(), 1000), 0);
        assert!(acc_ok(ice, 31) && !acc_ok(species("corgi").unwrap(), ACC_SADDLE) && !acc_ok(ice, 32) && !acc_ok(ice, -1));
    }

    #[tokio::test]
    async fn free_pets_level_gates_and_coins() {
        let p = pool().await;
        let (pet, left, paid) = adopt(&p, A, "corgi", 1, "Waffles", NOW).await.unwrap_or_else(|_| panic!("adopts"));
        assert_eq!((pet["species"].as_str(), pet["name"].as_str(), pet["active"].as_bool(), pet["home"].as_bool(), left, paid),
                   (Some("corgi"), Some("Waffles"), Some(true), Some(true), 0, 0));
        assert_eq!(code(adopt(&p, A, "unicorn", 0, "X", NOW).await), StatusCode::NOT_FOUND);
        // a rare one before its level: its price, else 402 and nothing changes
        assert_eq!(code(adopt(&p, A, "icedragon", 0, "Frost", NOW).await), StatusCode::PAYMENT_REQUIRED);
        coins(&p, A, 1000).await;
        let (pet, left, paid) = adopt(&p, A, "icedragon", 3, "Frost", NOW).await.unwrap_or_else(|_| panic!("buys"));
        assert_eq!((pet["variant"].as_i64(), left, paid, balance(&p, A).await), (Some(3), 200, 800, 200));
        // at its level it is free
        prompts(&p, A, 900).await; // level 10
        let (_, left, paid) = adopt(&p, A, "firedragon", 0, "Ember", NOW).await.unwrap_or_else(|_| panic!("free at 10"));
        assert_eq!((left, paid), (200, 0));
        let pets = mine(&p, A).await.unwrap();
        assert_eq!(pets.iter().filter(|x| x["active"] == json!(true)).count(), 2, "only two come out");
        assert!(mine(&p, B).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn six_pets_at_most_and_two_out() {
        let p = pool().await;
        let mut ids = vec![];
        for i in 0..MAX_OWNED {
            let (pet, _, _) = adopt(&p, A, "tabby", i % VARIANTS, &format!("Cat {i}"), NOW + i).await.unwrap_or_else(|_| panic!("#{i}"));
            ids.push(pet["id"].as_str().unwrap().to_string());
        }
        assert_eq!(code(adopt(&p, A, "tabby", 0, "Seven", NOW).await), StatusCode::CONFLICT);
        // a third out: refused until one goes home
        assert_eq!(code(edit(&p, A, &ids[2], &Edit { active: Some(true), ..Edit::default() }).await), StatusCode::CONFLICT);
        edit(&p, A, &ids[0], &Edit { active: Some(false), ..Edit::default() }).await.unwrap_or_else(|_| panic!("home"));
        let v = edit(&p, A, &ids[2], &Edit { active: Some(true), name: Some("Pixel".into()), acc: Some(3), ..Edit::default() }).await.unwrap_or_else(|_| panic!("out"));
        assert_eq!((v["active"].as_bool(), v["name"].as_str(), v["acc"].as_i64()), (Some(true), Some("Pixel"), Some(3)));
        assert_eq!(code(edit(&p, A, &ids[2], &Edit { acc: Some(ACC_SADDLE), ..Edit::default() }).await), StatusCode::CONFLICT, "no saddle on a cat");
        // only the owner edits, cares for or rehomes it
        assert_eq!(code(edit(&p, B, &ids[2], &Edit { home: Some(false), ..Edit::default() }).await), StatusCode::NOT_FOUND);
        assert_eq!(code(care(&p, B, &ids[2], 1, NOW).await), StatusCode::NOT_FOUND);
        assert_eq!(code(release(&p, B, &ids[2]).await), StatusCode::NOT_FOUND);
        release(&p, A, &ids[5]).await.unwrap_or_else(|_| panic!("rehomed"));
        assert_eq!(mine(&p, A).await.unwrap().len(), 5);
    }

    #[tokio::test]
    async fn care_is_capped_per_day_and_dragons_grow() {
        let p = pool().await;
        coins(&p, A, 1000).await;
        let (pet, _, _) = adopt(&p, A, "icedragon", 0, "Frost", NOW).await.unwrap_or_else(|_| panic!("adopts"));
        let id = pet["id"].as_str().unwrap();
        let mut total = 0;
        for _ in 0..30 {
            total += care(&p, A, id, 2, NOW).await.unwrap_or_else(|_| panic!("cares")).1;
        }
        assert_eq!(total, CARE_PER_DAY, "capped per day");
        assert_eq!(care(&p, A, id, 2, NOW + 86_400).await.unwrap_or_else(|_| panic!("next day")).1, 2);
        sqlx::query("UPDATE owned_pets SET affection = 999 WHERE id = ?1").bind(id).execute(&p).await.unwrap();
        assert_eq!(care(&p, A, id, 2, NOW + 2 * 86_400).await.unwrap_or_else(|_| panic!("max")).0, AFFECTION_MAX);
        assert_eq!(mine(&p, A).await.unwrap()[0]["stage"], json!(2), "grown");
    }

    #[tokio::test]
    async fn a_visitor_sees_the_lobby_pets_only_of_an_open_hq() {
        let p = pool().await;
        for (i, sp) in ["shiba", "tabby", "corgi"].iter().enumerate() {
            adopt(&p, A, sp, 0, &format!("P{i}"), NOW + i as i64).await.unwrap_or_else(|_| panic!("adopts"));
        }
        // the first two are out with A; only the third is in the lobby
        assert_eq!(home_of(&p, A, A).await.unwrap().map(|v| v.len()), Some(1));
        assert_eq!(home_of(&p, B, A).await.unwrap(), None, "closed HQ");
        sqlx::query("INSERT INTO hq_profiles (user_id, open, look, crew, updated_at) VALUES (?1, 1, '{}', '{}', datetime('now'))").bind(A).execute(&p).await.unwrap();
        let pets = home_of(&p, B, A).await.unwrap().unwrap();
        assert_eq!(pets, vec![json!({"species": "corgi", "variant": 0, "acc": 1, "name": "P2", "stage": 0})]);
        assert_eq!(home_of(&p, A, "cccccccc-0000-4000-8000-000000000003").await.unwrap(), None);
    }
}
