//! Personal cities (HQ 3.x, docs/plans/cities-build-spec.md): every user has
//! one, grown automatically from their XP, plus the Commons (owner `commons`).
//!
//!   GET  /v1/city/:owner                 CityState; 404 if hidden from the caller
//!   POST /v1/city/:owner/build     {upgrade}                 owner only
//!   POST /v1/city/:owner/transfer  {amount, dir:"in"|"out"}  owner only
//!   POST /v1/city/:owner/privacy   {mode:"arena"|"friends"|"closed"}  owner only
//!   POST /v1/city/:owner/fare      {kind:"bus"|"tram"|"fast"}  the rider pays
//!
//! `:owner` is a user id, `me`, or `commons`. Every POST answers
//! `{city: CityState, coins: <the caller's Poke Coins>}`.
//!
//! Money: a city's treasury is apart from its owner's Poke Coins (the
//! `poke_balances` "coins" row). Every treasury change is one append-only
//! `city_ledger` row written by [`post_entry`] in the same transaction, so the
//! ledger always sums to the treasury. Tax accrues lazily on read and from an
//! hourly job, both through [`accrue`]:
//!
//! ```text
//! coins/hour = population × tax_pm × district multiplier / 1000
//! ```
//!
//! paid only up to 24 h past the owner's last sign of life (a device seen), so
//! an abandoned city stops earning. 2% of every accrual goes to the Commons.
//! Moving coins between wallet and treasury costs 10% each way, paid to the
//! Commons; fares (2 bus or tram, 1 fast travel) go from the rider's wallet to
//! the city's treasury.
//!
//! Visibility ([`can_view`]): the owner always; "arena" (the default) anyone
//! paired with this Arena, which is the arena the owner is in; "friends" the
//! owner's crew (the Arena has no friends list, a crew is the closest thing);
//! "closed" the owner only. The Commons is open to everyone.
//!
//! PRIVACY: nothing here reads or returns transcript data. A CityState holds
//! the owner's XP and name, the same figures every board shows.

use std::collections::BTreeMap;

use axum::{
    extract::{Path, Request, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::Serialize;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use sqlx::{SqliteConnection, SqlitePool};

use crate::market;
use crate::{err, AppState, Caller};

/// The Commons' treasury row; never a user id (those are uuids).
pub(crate) const COMMONS: &str = "commons";
const COMMONS_WORLD: &str = "claude-hq@2";
/// Offline income stops this long after the owner was last seen.
const CAP_SECS: i64 = 24 * 3600;
const LEVY_PCT: i64 = 2;
const FEE_PCT: i64 = 10;
/// Tax is computed in millionths of a coin; the remainder carries over.
const MICRO: i64 = 1_000_000;
const TAX_PM: i64 = 50;
const TRANSFER_MAX: i64 = 100_000;
const FARE_BUS: i64 = 2;
const FARE_FAST: i64 = 1;
const BUS_TIER: i64 = 2;
const TRAM_TIER: i64 = 4;
const MAX_BODY: usize = 1024;
const PRIVACY: [&str; 3] = ["arena", "friends", "closed"];

// ------------------------------------------------------------- tiers --

/// `city_tiers`: the XP a tier starts at and the population it starts with.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Tiers {
    pub(crate) xp: [i64; 5],
    pub(crate) pop: [i64; 5],
}

/// The seeded values, used for any tier the table is missing.
pub(crate) const SEED_TIERS: Tiers =
    Tiers { xp: [0, 2_000, 10_000, 40_000, 120_000], pop: [50, 200, 600, 1_200, 2_000] };

pub(crate) async fn tiers(conn: &mut SqliteConnection) -> Result<Tiers, sqlx::Error> {
    let rows: Vec<(i64, i64, i64)> =
        sqlx::query_as("SELECT tier, xp, population FROM city_tiers WHERE tier BETWEEN 1 AND 5")
            .fetch_all(conn)
            .await?;
    let mut t = SEED_TIERS;
    for (tier, xp, pop) in rows {
        t.xp[tier as usize - 1] = xp;
        t.pop[tier as usize - 1] = pop;
    }
    Ok(t)
}

/// 1..=5: the highest tier whose threshold the XP has reached.
pub(crate) fn tier_of(xp: i64, t: &Tiers) -> i64 {
    (1..=5).rev().find(|&i| xp >= t.xp[i as usize - 1]).unwrap_or(1)
}

/// Per-mille through the current tier; a tier-5 city is fully grown.
pub(crate) fn grow_of(xp: i64, tier: i64, t: &Tiers) -> i64 {
    if tier >= 5 {
        return 1000;
    }
    let (lo, hi) = (t.xp[tier as usize - 1], t.xp[tier as usize]);
    ((xp - lo) * 1000 / (hi - lo).max(1)).clamp(0, 1000)
}

/// The tier's population, moving smoothly toward the next tier's as it grows.
pub(crate) fn population(tier: i64, grow: i64, t: &Tiers) -> i64 {
    let lo = t.pop[tier as usize - 1];
    if tier >= 5 {
        return lo;
    }
    lo + (t.pop[tier as usize] - lo) * grow / 1000
}

// ---------------------------------------------------------- upgrades --

pub(crate) struct Upgrade {
    pub(crate) key: &'static str,
    /// The first city tier that may build it.
    pub(crate) tier: i64,
    /// The treasury cost of each level, in order; its length is the max level.
    pub(crate) costs: &'static [i64],
}

/// tax_office: +10% tax per level. workshop: +25% specialty output per level.
/// depot: +250 market stock room per level.
pub(crate) const UPGRADES: [Upgrade; 3] = [
    Upgrade { key: "tax_office", tier: 1, costs: &[150, 600, 2_400] },
    Upgrade { key: "workshop", tier: 2, costs: &[300, 1_200, 4_800] },
    Upgrade { key: "depot", tier: 2, costs: &[400, 2_000] },
];

/// District multiplier (per-mille) with the tax office applied.
pub(crate) fn tax_mult_pm(district_pm: i64, tax_office: i64) -> i64 {
    district_pm * (1000 + 100 * tax_office) / 1000
}

// -------------------------------------------------------------- rows --

#[derive(Clone, Debug)]
pub(crate) struct CityRow {
    pub(crate) owner: String,
    pub(crate) seed: String,
    pub(crate) treasury: i64,
    pub(crate) tax_pm: i64,
    pub(crate) specialty: String,
    pub(crate) privacy: String,
    pub(crate) created: i64,
    pub(crate) last_accrual: i64,
    pub(crate) carry: i64,
}

type RowTuple = (String, String, i64, i64, String, String, i64, i64, i64);

fn row_of(r: RowTuple) -> CityRow {
    CityRow {
        owner: r.0,
        seed: r.1,
        treasury: r.2,
        tax_pm: r.3,
        specialty: r.4,
        privacy: r.5,
        created: r.6,
        last_accrual: r.7,
        carry: r.8,
    }
}

pub(crate) async fn city_row(conn: &mut SqliteConnection, owner: &str) -> Result<Option<CityRow>, sqlx::Error> {
    let r: Option<RowTuple> = sqlx::query_as(
        "SELECT owner, seed, treasury, tax_pm, specialty, privacy, created, last_accrual, accrual_carry
           FROM city WHERE owner = ?1",
    )
    .bind(owner)
    .fetch_optional(conn)
    .await?;
    Ok(r.map(row_of))
}

/// A user's city, or the Commons, created on first use. `None` when the owner
/// is not an active user.
pub(crate) async fn ensure_city(conn: &mut SqliteConnection, owner: &str, now: i64) -> Result<Option<CityRow>, sqlx::Error> {
    if let Some(r) = city_row(conn, owner).await? {
        return Ok(Some(r));
    }
    let seed = if owner == COMMONS {
        COMMONS_WORLD.to_string()
    } else {
        let active: Option<i64> = sqlx::query_scalar("SELECT 1 FROM users WHERE id = ?1 AND is_active = 1")
            .bind(owner)
            .fetch_optional(&mut *conn)
            .await?;
        if active.is_none() {
            return Ok(None);
        }
        format!("user:{owner}@2")
    };
    let tax = if owner == COMMONS { 0 } else { TAX_PM };
    let specialty = market::specialty_for(&seed).await;
    sqlx::query(
        "INSERT OR IGNORE INTO city (owner, seed, treasury, tax_pm, specialty, privacy, created, last_accrual)
         VALUES (?1, ?2, 0, ?3, ?4, 'arena', ?5, ?5)",
    )
    .bind(owner)
    .bind(&seed)
    .bind(tax)
    .bind(specialty)
    .bind(now)
    .execute(&mut *conn)
    .await?;
    city_row(conn, owner).await
}

/// Every catalogue upgrade with its built level, 0 when unbuilt, so a client
/// learns the keys it may POST to /build from CityState alone.
pub(crate) async fn upgrades(conn: &mut SqliteConnection, owner: &str) -> Result<BTreeMap<String, i64>, sqlx::Error> {
    let rows: Vec<(String, i64)> = sqlx::query_as("SELECT upgrade, level FROM city_upgrade WHERE owner = ?1")
        .bind(owner)
        .fetch_all(conn)
        .await?;
    let mut out: BTreeMap<String, i64> = UPGRADES.iter().map(|u| (u.key.to_string(), 0)).collect();
    out.extend(rows);
    Ok(out)
}

// ------------------------------------------------------------- money --

#[derive(Debug)]
pub(crate) enum Refuse {
    Say(StatusCode, String),
    Db(sqlx::Error),
}

impl From<sqlx::Error> for Refuse {
    fn from(e: sqlx::Error) -> Self {
        Refuse::Db(e)
    }
}

impl Refuse {
    pub(crate) fn say(code: StatusCode, msg: impl Into<String>) -> Self {
        Refuse::Say(code, msg.into())
    }

    pub(crate) fn response(self) -> Response {
        match self {
            Refuse::Say(code, m) => err(code, &m),
            Refuse::Db(e) => err(StatusCode::INTERNAL_SERVER_ERROR, &format!("db error: {e}")),
        }
    }
}

/// Move `amount` (signed) into `owner`'s treasury and append its ledger row.
/// The guard is the WHERE clause: a treasury never goes below zero.
pub(crate) async fn post_entry(
    conn: &mut SqliteConnection,
    owner: &str,
    kind: &str,
    amount: i64,
    refr: &str,
    at: i64,
) -> Result<i64, Refuse> {
    let bal: Option<i64> = sqlx::query_scalar(
        "UPDATE city SET treasury = treasury + ?2 WHERE owner = ?1 AND treasury + ?2 >= 0 RETURNING treasury",
    )
    .bind(owner)
    .bind(amount)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(bal) = bal else {
        return Err(Refuse::say(StatusCode::CONFLICT, "not enough in the treasury"));
    };
    sqlx::query("INSERT INTO city_ledger (owner, at, kind, amount, balance_after, ref) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
        .bind(owner)
        .bind(at)
        .bind(kind)
        .bind(amount)
        .bind(bal)
        .bind(refr)
        .execute(&mut *conn)
        .await?;
    Ok(bal)
}

/// A `poke_balances` quantity, 0 when there is no row.
pub(crate) async fn held(conn: &mut SqliteConnection, uid: &str, item: &str) -> Result<i64, sqlx::Error> {
    Ok(sqlx::query_scalar("SELECT qty FROM poke_balances WHERE user_id = ?1 AND item = ?2")
        .bind(uid)
        .bind(item)
        .fetch_optional(conn)
        .await?
        .unwrap_or(0))
}

/// Take n of an item, or false. The same conditional UPDATE as pantry's debit.
pub(crate) async fn wallet_debit(conn: &mut SqliteConnection, uid: &str, item: &str, n: i64) -> Result<bool, sqlx::Error> {
    let res = sqlx::query(
        "UPDATE poke_balances SET qty = qty - ?3, updated_at = datetime('now')
         WHERE user_id = ?1 AND item = ?2 AND qty >= ?3",
    )
    .bind(uid)
    .bind(item)
    .bind(n)
    .execute(conn)
    .await?;
    Ok(res.rows_affected() == 1)
}

/// Add n of an item without passing cap, or false. Pantry's credit: update the
/// row, else insert one when none exists and n fits.
pub(crate) async fn wallet_credit(conn: &mut SqliteConnection, uid: &str, item: &str, n: i64, cap: i64) -> Result<bool, sqlx::Error> {
    let res = sqlx::query(
        "UPDATE poke_balances SET qty = qty + ?3, updated_at = datetime('now')
         WHERE user_id = ?1 AND item = ?2 AND qty + ?3 <= ?4",
    )
    .bind(uid)
    .bind(item)
    .bind(n)
    .bind(cap)
    .execute(&mut *conn)
    .await?;
    if res.rows_affected() == 1 {
        return Ok(true);
    }
    if n > cap {
        return Ok(false);
    }
    let ins = sqlx::query(
        "INSERT INTO poke_balances (id, user_id, item, qty)
         SELECT ?1, ?2, ?3, ?4 WHERE NOT EXISTS
           (SELECT 1 FROM poke_balances WHERE user_id = ?2 AND item = ?3)",
    )
    .bind(uuid::Uuid::new_v4().to_string())
    .bind(uid)
    .bind(item)
    .bind(n)
    .execute(conn)
    .await?;
    Ok(ins.rows_affected() == 1)
}

/// The 10% fee on a transfer of `amount`, rounded up so no transfer is free.
pub(crate) fn fee_of(amount: i64) -> i64 {
    (amount * FEE_PCT + 99) / 100
}

// ----------------------------------------------------------- accrual --

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Accrued {
    /// Whole coins for the owner's treasury, after the levy.
    pub(crate) owner_coins: i64,
    pub(crate) owner_carry: i64,
    /// The levy, in millionths of a coin, for the Commons' carry.
    pub(crate) levy_micro: i64,
    pub(crate) last: i64,
}

/// Pure. Tax from `last` to `now` at `rate` millionths of a coin an hour, paid
/// only up to `CAP_SECS` past `seen` (and never more than `CAP_SECS` in one
/// go); time past that is forfeited, not owed. 2% of the gross is the levy.
pub(crate) fn accrue_pure(rate: i64, last: i64, seen: i64, now: i64, carry: i64) -> Accrued {
    let end = now.min(seen + CAP_SECS);
    let secs = (end - last).clamp(0, CAP_SECS);
    let gross = rate * secs / 3600;
    let levy = gross * LEVY_PCT / 100;
    let total = carry + gross - levy;
    Accrued { owner_coins: total / MICRO, owner_carry: total % MICRO, levy_micro: levy, last: now.max(last) }
}

/// What a city is right now: its row plus everything derived from its owner.
#[derive(Clone, Debug)]
pub(crate) struct Snapshot {
    pub(crate) row: CityRow,
    pub(crate) tiers: Tiers,
    pub(crate) xp: i64,
    pub(crate) tier: i64,
    pub(crate) grow: i64,
    pub(crate) population: i64,
    pub(crate) upgrades: BTreeMap<String, i64>,
}

impl Snapshot {
    pub(crate) fn level(&self, key: &str) -> i64 {
        self.upgrades.get(key).copied().unwrap_or(0)
    }

    /// Millionths of a coin an hour.
    fn tax_rate(&self) -> i64 {
        let district = market::district_pm(&self.row.specialty, self.tier);
        self.population * self.row.tax_pm * tax_mult_pm(district, self.level("tax_office"))
    }
}

/// Load (creating on first use) a city and derive its tier from the owner's
/// XP, the same figure GET /v1/progress/me shows. The Commons is tier 5.
pub(crate) async fn snapshot(pool: &SqlitePool, owner: &str, now: i64) -> Result<Option<Snapshot>, sqlx::Error> {
    let mut conn = pool.acquire().await?;
    let Some(row) = ensure_city(&mut conn, owner, now).await? else {
        return Ok(None);
    };
    let tiers = tiers(&mut conn).await?;
    let upgrades = upgrades(&mut conn, owner).await?;
    drop(conn);
    let (xp, tier, grow) = if owner == COMMONS {
        (0, 5, 1000)
    } else {
        let xp = crate::progress::progress(pool, &[owner]).await?.get(owner).map(|p| p.xp).unwrap_or(0);
        let tier = tier_of(xp, &tiers);
        (xp, tier, grow_of(xp, tier, &tiers))
    };
    Ok(Some(Snapshot { population: population(tier, grow, &tiers), row, tiers, xp, tier, grow, upgrades }))
}

/// The owner's last sign of life: their latest live device, else the city's birth.
async fn last_seen(conn: &mut SqliteConnection, owner: &str, created: i64) -> Result<i64, sqlx::Error> {
    let seen: Option<i64> = sqlx::query_scalar(
        "SELECT CAST(strftime('%s', MAX(last_seen_at)) AS INTEGER) FROM devices WHERE user_id = ?1 AND revoked = 0",
    )
    .bind(owner)
    .fetch_one(&mut *conn)
    .await?;
    Ok(seen.unwrap_or(created).max(created))
}

/// Pay a city its tax up to `now`, and the Commons its levy. Safe to call any
/// number of times: it reads last_accrual under the write lock.
pub(crate) async fn accrue(pool: &SqlitePool, snap: &Snapshot, now: i64) -> Result<(), Refuse> {
    if snap.row.owner == COMMONS {
        return Ok(());
    }
    let owner = snap.row.owner.as_str();
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let Some(row) = city_row(&mut tx, owner).await? else {
        return Ok(());
    };
    let seen = last_seen(&mut tx, owner, row.created).await?;
    let a = accrue_pure(snap.tax_rate(), row.last_accrual, seen, now, row.carry);
    sqlx::query("UPDATE city SET last_accrual = ?2, accrual_carry = ?3 WHERE owner = ?1")
        .bind(owner)
        .bind(a.last)
        .bind(a.owner_carry)
        .execute(&mut *tx)
        .await?;
    if a.owner_coins > 0 {
        post_entry(&mut tx, owner, "tax", a.owner_coins, "", now).await?;
    }
    if a.levy_micro > 0 {
        let commons = ensure_city(&mut tx, COMMONS, now).await?.expect("the Commons always exists");
        let total = commons.carry + a.levy_micro;
        sqlx::query("UPDATE city SET accrual_carry = ?2 WHERE owner = ?1")
            .bind(COMMONS)
            .bind(total % MICRO)
            .execute(&mut *tx)
            .await?;
        if total / MICRO > 0 {
            post_entry(&mut tx, COMMONS, "levy", total / MICRO, owner, now).await?;
        }
    }
    tx.commit().await?;
    Ok(())
}

/// The hourly job: accrue every city and tick every market. A city whose
/// owner is gone is skipped, and one city's failure does not stop the rest.
pub(crate) async fn hourly(pool: &SqlitePool, now: i64) -> Result<(), Refuse> {
    let owners: Vec<String> = sqlx::query_scalar("SELECT owner FROM city ORDER BY owner").fetch_all(pool).await?;
    for owner in owners {
        let res: Result<(), Refuse> = async {
            let Some(snap) = snapshot(pool, &owner, now).await? else { return Ok(()) };
            accrue(pool, &snap, now).await?;
            market::catch_up(pool, &snap, now).await?;
            Ok(())
        }
        .await;
        if let Err(r) = res {
            tracing::warn!("cities: hourly job skipped {owner}: {r:?}");
        }
    }
    Ok(())
}

pub fn spawn_hourly(pool: SqlitePool) {
    tokio::spawn(async move {
        let mut every = tokio::time::interval(std::time::Duration::from_secs(3600));
        every.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            every.tick().await;
            if let Err(r) = hourly(&pool, now_secs()).await {
                tracing::warn!("cities: hourly job failed: {r:?}");
            }
        }
    });
}

// -------------------------------------------------------- visibility --

/// Pure: may this viewer see the city? Friends are the owner's crew, and a
/// crewmate is always in the arena too.
pub(crate) fn visible(privacy: &str, is_owner: bool, in_arena: bool, same_crew: bool) -> bool {
    is_owner
        || match privacy {
            "arena" => in_arena,
            "friends" => in_arena && same_crew,
            _ => false,
        }
}

/// May `viewer` see `owner`'s city (and so its market and island)? Fails
/// closed: a database error is a no. An owner who is not an active user has no
/// city to see. Every user paired with this Arena is in its arena.
pub(crate) async fn can_view(pool: &SqlitePool, owner: &str, viewer: &str) -> bool {
    can_view_q(pool, owner, viewer).await.unwrap_or(false)
}

async fn active(pool: &SqlitePool, id: &str) -> Result<bool, sqlx::Error> {
    let r: Option<i64> = sqlx::query_scalar("SELECT 1 FROM users WHERE id = ?1 AND is_active = 1").bind(id).fetch_optional(pool).await?;
    Ok(r.is_some())
}

async fn can_view_q(pool: &SqlitePool, owner: &str, viewer: &str) -> Result<bool, sqlx::Error> {
    let viewer_in = active(pool, viewer).await?;
    if owner == COMMONS {
        return Ok(viewer_in);
    }
    if !active(pool, owner).await? {
        return Ok(false);
    }
    if owner == viewer {
        return Ok(true);
    }
    let privacy: Option<String> = sqlx::query_scalar("SELECT privacy FROM city WHERE owner = ?1")
        .bind(owner)
        .fetch_optional(pool)
        .await?;
    let same_crew: Option<i64> = sqlx::query_scalar(
        "SELECT 1 FROM crew_members a JOIN crew_members b ON a.crew_id = b.crew_id
          WHERE a.user_id = ?1 AND b.user_id = ?2",
    )
    .bind(owner)
    .bind(viewer)
    .fetch_optional(pool)
    .await?;
    Ok(visible(privacy.as_deref().unwrap_or("arena"), false, viewer_in, same_crew.is_some()))
}

// ------------------------------------------------------------- state --

#[derive(Debug, Serialize)]
pub(crate) struct CityState {
    pub(crate) owner: String,
    pub(crate) name: String,
    pub(crate) world: String,
    pub(crate) tier: i64,
    pub(crate) xp: i64,
    pub(crate) tier_xp: [i64; 5],
    pub(crate) grow: i64,
    pub(crate) treasury: i64,
    pub(crate) tax_pm: i64,
    pub(crate) specialty: String,
    pub(crate) upgrades: BTreeMap<String, i64>,
    pub(crate) privacy: String,
    pub(crate) population: i64,
}

/// Accrue, then describe. `None` when there is no such city.
pub(crate) async fn city_state(pool: &SqlitePool, owner: &str, now: i64) -> Result<Option<CityState>, Refuse> {
    let Some(snap) = snapshot(pool, owner, now).await? else {
        return Ok(None);
    };
    accrue(pool, &snap, now).await?;
    let mut conn = pool.acquire().await?;
    let row = city_row(&mut conn, owner).await?.unwrap_or(snap.row.clone());
    let name = name_of(&mut conn, owner).await?;
    Ok(Some(CityState {
        owner: owner.to_string(),
        name,
        world: row.seed,
        tier: snap.tier,
        xp: snap.xp,
        tier_xp: snap.tiers.xp,
        grow: snap.grow,
        treasury: row.treasury,
        tax_pm: row.tax_pm,
        specialty: row.specialty,
        upgrades: snap.upgrades,
        privacy: row.privacy,
        population: snap.population,
    }))
}

/// A city's display name: the owner's display name, else their handle.
async fn name_of(conn: &mut SqliteConnection, owner: &str) -> Result<String, sqlx::Error> {
    if owner == COMMONS {
        return Ok("The Commons".to_string());
    }
    let n: Option<(String, String)> = sqlx::query_as("SELECT handle, display_name FROM users WHERE id = ?1")
        .bind(owner)
        .fetch_optional(&mut *conn)
        .await?;
    Ok(n.map(|(h, d)| if d.is_empty() { h } else { d }).unwrap_or_default())
}

/// The name and tier the archipelago lists for a city, the same figures
/// CityState shows, without creating the city or accruing its tax.
pub(crate) async fn name_and_tier(pool: &SqlitePool, owner: &str) -> Result<(String, u8), sqlx::Error> {
    let mut conn = pool.acquire().await?;
    let name = name_of(&mut conn, owner).await?;
    if owner == COMMONS {
        return Ok((name, 5));
    }
    let tiers = tiers(&mut conn).await?;
    drop(conn);
    let xp = crate::progress::progress(pool, &[owner]).await?.get(owner).map(|p| p.xp).unwrap_or(0);
    Ok((name, tier_of(xp, &tiers).clamp(1, 5) as u8))
}

// ------------------------------------------------------------ bodies --

/// A lowercase hyphenated uuid, the only shape a user id has.
pub(crate) fn is_uuid(s: &str) -> bool {
    s.len() == 36
        && s.bytes().enumerate().all(|(i, b)| {
            if matches!(i, 8 | 13 | 18 | 23) {
                b == b'-'
            } else {
                b.is_ascii_digit() || (b'a'..=b'f').contains(&b)
            }
        })
}

/// `:owner` -> a city owner: `me` is the caller, `commons` the Commons, else
/// a user id. Anything else is refused before it reaches a query.
pub(crate) fn owner_param(raw: &str, caller: &str) -> Option<String> {
    match raw {
        "me" => Some(caller.to_string()),
        COMMONS => Some(COMMONS.to_string()),
        s if is_uuid(s) => Some(s.to_string()),
        _ => None,
    }
}

/// A JSON object with only `keys`, each present.
pub(crate) fn body_obj(bytes: &[u8], keys: &[&str]) -> Result<Map<String, Value>, String> {
    let Ok(Value::Object(o)) = serde_json::from_slice::<Value>(bytes) else {
        return Err("body must be a JSON object".into());
    };
    if let Some(k) = o.keys().find(|k| !keys.contains(&k.as_str())) {
        return Err(format!("unknown field {k:?}"));
    }
    if let Some(k) = keys.iter().find(|k| !o.contains_key(**k)) {
        return Err(format!("missing field {k:?}"));
    }
    Ok(o)
}

pub(crate) fn str_field<'a>(o: &'a Map<String, Value>, k: &str, allowed: &[&str]) -> Result<&'a str, String> {
    o.get(k)
        .and_then(Value::as_str)
        .filter(|s| allowed.contains(s))
        .ok_or_else(|| format!("{k} must be one of {}", allowed.join(", ")))
}

pub(crate) fn int_field(o: &Map<String, Value>, k: &str, lo: i64, hi: i64) -> Result<i64, String> {
    o.get(k)
        .and_then(Value::as_i64)
        .filter(|n| (lo..=hi).contains(n))
        .ok_or_else(|| format!("{k} must be an integer from {lo} to {hi}"))
}

pub(crate) async fn read_body(req: Request) -> Result<axum::body::Bytes, Refuse> {
    let (_, body) = req.into_parts();
    axum::body::to_bytes(body, MAX_BODY).await.map_err(|_| Refuse::say(StatusCode::PAYLOAD_TOO_LARGE, "body too large"))
}

pub(crate) fn now_secs() -> i64 {
    chrono::Utc::now().timestamp()
}

pub(crate) fn caller(req: &Request) -> Caller {
    req.extensions().get::<Caller>().expect("caller set by middleware").clone()
}

fn upgrade_key(o: &Map<String, Value>) -> Result<&'static Upgrade, String> {
    let k = o.get("upgrade").and_then(Value::as_str).unwrap_or("");
    UPGRADES.iter().find(|u| u.key == k).ok_or_else(|| "unknown upgrade".to_string())
}

/// Hash a seed to a u64 (the first 8 bytes of its sha256).
pub(crate) fn seed_hash(seed: &str) -> u64 {
    let d = Sha256::digest(seed.as_bytes());
    u64::from_be_bytes(d[..8].try_into().expect("8 bytes"))
}

// ---------------------------------------------------------- handlers --

async fn reply(pool: &SqlitePool, owner: &str, uid: &str, now: i64) -> Response {
    let state = match city_state(pool, owner, now).await {
        Ok(Some(s)) => s,
        Ok(None) => return err(StatusCode::NOT_FOUND, "no such city"),
        Err(r) => return r.response(),
    };
    let mut conn = match pool.acquire().await {
        Ok(c) => c,
        Err(e) => return Refuse::Db(e).response(),
    };
    match held(&mut conn, uid, "coins").await {
        Ok(coins) => Json(json!({"city": state, "coins": coins})).into_response(),
        Err(e) => Refuse::Db(e).response(),
    }
}

/// The caller's view of `:owner`, or the response that refuses it: 400 for a
/// malformed id, 404 for a city that is missing or hidden (indistinguishable).
pub(crate) async fn visible_owner(pool: &SqlitePool, raw: &str, c: &Caller) -> Result<String, Refuse> {
    let Some(owner) = owner_param(raw, &c.user_id) else {
        return Err(Refuse::say(StatusCode::BAD_REQUEST, "bad city owner"));
    };
    if !can_view(pool, &owner, &c.user_id).await {
        return Err(Refuse::say(StatusCode::NOT_FOUND, "no such city"));
    }
    Ok(owner)
}

/// Owner-only routes: the caller's own city and nobody else's (the Commons has no owner).
async fn own_city(pool: &SqlitePool, raw: &str, c: &Caller) -> Result<String, Refuse> {
    let owner = visible_owner(pool, raw, c).await?;
    if owner != c.user_id {
        return Err(Refuse::say(StatusCode::FORBIDDEN, "only the owner can do that"));
    }
    Ok(owner)
}

async fn get_city(State(st): State<AppState>, Path(raw): Path<String>, req: Request) -> Response {
    let c = caller(&req);
    let owner = match visible_owner(&st.pool, &raw, &c).await {
        Ok(o) => o,
        Err(r) => return r.response(),
    };
    match city_state(&st.pool, &owner, now_secs()).await {
        Ok(Some(s)) => Json(s).into_response(),
        Ok(None) => err(StatusCode::NOT_FOUND, "no such city"),
        Err(r) => r.response(),
    }
}

/// Buy the next level of an upgrade from the treasury.
pub(crate) async fn build(pool: &SqlitePool, owner: &str, key: &str, now: i64) -> Result<(), Refuse> {
    let up = UPGRADES.iter().find(|u| u.key == key).ok_or_else(|| Refuse::say(StatusCode::UNPROCESSABLE_ENTITY, "unknown upgrade"))?;
    let snap = snapshot(pool, owner, now).await?.ok_or_else(|| Refuse::say(StatusCode::NOT_FOUND, "no such city"))?;
    if snap.tier < up.tier {
        return Err(Refuse::say(StatusCode::CONFLICT, format!("{key} needs a tier {} city", up.tier)));
    }
    accrue(pool, &snap, now).await?;
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let level = upgrades(&mut tx, owner).await?.get(key).copied().unwrap_or(0);
    let Some(&cost) = up.costs.get(level as usize) else {
        return Err(Refuse::say(StatusCode::CONFLICT, format!("{key} is fully built")));
    };
    post_entry(&mut tx, owner, "upgrade", -cost, &format!("{key}:{}", level + 1), now).await?;
    sqlx::query(
        "INSERT INTO city_upgrade (owner, upgrade, level, updated) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (owner, upgrade) DO UPDATE SET level = excluded.level, updated = excluded.updated",
    )
    .bind(owner)
    .bind(key)
    .bind(level + 1)
    .bind(now)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}

async fn post_build(State(st): State<AppState>, Path(raw): Path<String>, req: Request) -> Response {
    let c = caller(&req);
    let owner = match own_city(&st.pool, &raw, &c).await {
        Ok(o) => o,
        Err(r) => return r.response(),
    };
    let bytes = match read_body(req).await {
        Ok(b) => b,
        Err(r) => return r.response(),
    };
    let up = match body_obj(&bytes, &["upgrade"]).and_then(|o| upgrade_key(&o)) {
        Ok(u) => u,
        Err(m) => return err(StatusCode::UNPROCESSABLE_ENTITY, &m),
    };
    let now = now_secs();
    if let Err(r) = build(&st.pool, &owner, up.key, now).await {
        return r.response();
    }
    reply(&st.pool, &owner, &c.user_id, now).await
}

/// Wallet <-> treasury, 10% to the Commons either way. `amount` is what leaves
/// the source; the destination gets it less the fee.
pub(crate) async fn transfer(pool: &SqlitePool, owner: &str, amount: i64, dir_in: bool, now: i64) -> Result<(), Refuse> {
    let fee = fee_of(amount);
    let net = amount - fee;
    if net <= 0 {
        return Err(Refuse::say(StatusCode::UNPROCESSABLE_ENTITY, "transfer at least 2 coins"));
    }
    let snap = snapshot(pool, owner, now).await?.ok_or_else(|| Refuse::say(StatusCode::NOT_FOUND, "no such city"))?;
    accrue(pool, &snap, now).await?;
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    ensure_city(&mut tx, COMMONS, now).await?;
    if dir_in {
        if !wallet_debit(&mut tx, owner, "coins", amount).await? {
            let have = held(&mut tx, owner, "coins").await?;
            return Err(Refuse::say(StatusCode::CONFLICT, format!("not enough Poke Coins (need {amount}, you have {have})")));
        }
        post_entry(&mut tx, owner, "transfer_in", net, "", now).await?;
    } else {
        post_entry(&mut tx, owner, "transfer_out", -amount, "", now).await?;
        if !wallet_credit(&mut tx, owner, "coins", net, crate::pantry::COIN_CAP).await? {
            return Err(Refuse::say(StatusCode::CONFLICT, "wallet full"));
        }
    }
    post_entry(&mut tx, COMMONS, "fee", fee, owner, now).await?;
    tx.commit().await?;
    Ok(())
}

async fn post_transfer(State(st): State<AppState>, Path(raw): Path<String>, req: Request) -> Response {
    let c = caller(&req);
    let owner = match own_city(&st.pool, &raw, &c).await {
        Ok(o) => o,
        Err(r) => return r.response(),
    };
    let bytes = match read_body(req).await {
        Ok(b) => b,
        Err(r) => return r.response(),
    };
    let parsed = body_obj(&bytes, &["amount", "dir"]).and_then(|o| {
        Ok((int_field(&o, "amount", 1, TRANSFER_MAX)?, str_field(&o, "dir", &["in", "out"])? == "in"))
    });
    let (amount, dir_in) = match parsed {
        Ok(v) => v,
        Err(m) => return err(StatusCode::UNPROCESSABLE_ENTITY, &m),
    };
    let now = now_secs();
    if let Err(r) = transfer(&st.pool, &owner, amount, dir_in, now).await {
        return r.response();
    }
    reply(&st.pool, &owner, &c.user_id, now).await
}

async fn post_privacy(State(st): State<AppState>, Path(raw): Path<String>, req: Request) -> Response {
    let c = caller(&req);
    let owner = match own_city(&st.pool, &raw, &c).await {
        Ok(o) => o,
        Err(r) => return r.response(),
    };
    let bytes = match read_body(req).await {
        Ok(b) => b,
        Err(r) => return r.response(),
    };
    let mode = match body_obj(&bytes, &["mode"]).and_then(|o| str_field(&o, "mode", &PRIVACY).map(String::from)) {
        Ok(m) => m,
        Err(m) => return err(StatusCode::UNPROCESSABLE_ENTITY, &m),
    };
    let now = now_secs();
    let res = async {
        let mut conn = st.pool.acquire().await?;
        ensure_city(&mut conn, &owner, now).await?;
        sqlx::query("UPDATE city SET privacy = ?2 WHERE owner = ?1").bind(&owner).bind(&mode).execute(&mut *conn).await
    }
    .await;
    if let Err(e) = res {
        return Refuse::Db(e).response();
    }
    reply(&st.pool, &owner, &c.user_id, now).await
}

/// The fare for a ride, or why there is no such ride here.
pub(crate) fn fare_of(kind: &str, tier: i64) -> Result<i64, &'static str> {
    match kind {
        "bus" if tier >= BUS_TIER => Ok(FARE_BUS),
        "bus" => Err("this city has no buses yet"),
        "tram" if tier >= TRAM_TIER => Ok(FARE_BUS),
        "tram" => Err("this city has no tram yet"),
        _ => Ok(FARE_FAST),
    }
}

/// The rider pays the city. An owner rides their own city free (otherwise a
/// fare would be a fee-free way into the treasury). Returns what was paid.
pub(crate) async fn fare(pool: &SqlitePool, owner: &str, rider: &str, kind: &str, now: i64) -> Result<i64, Refuse> {
    let snap = snapshot(pool, owner, now).await?.ok_or_else(|| Refuse::say(StatusCode::NOT_FOUND, "no such city"))?;
    let price = fare_of(kind, snap.tier).map_err(|m| Refuse::say(StatusCode::CONFLICT, m))?;
    if owner == rider {
        return Ok(0);
    }
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    if !wallet_debit(&mut tx, rider, "coins", price).await? {
        return Err(Refuse::say(StatusCode::CONFLICT, format!("the fare is {price} Poke Coins")));
    }
    post_entry(&mut tx, owner, "fare", price, kind, now).await?;
    tx.commit().await?;
    Ok(price)
}

async fn post_fare(State(st): State<AppState>, Path(raw): Path<String>, req: Request) -> Response {
    let c = caller(&req);
    let owner = match visible_owner(&st.pool, &raw, &c).await {
        Ok(o) => o,
        Err(r) => return r.response(),
    };
    let bytes = match read_body(req).await {
        Ok(b) => b,
        Err(r) => return r.response(),
    };
    let kind = match body_obj(&bytes, &["kind"]).and_then(|o| str_field(&o, "kind", &["bus", "tram", "fast"]).map(String::from)) {
        Ok(k) => k,
        Err(m) => return err(StatusCode::UNPROCESSABLE_ENTITY, &m),
    };
    let now = now_secs();
    if let Err(r) = fare(&st.pool, &owner, &c.user_id, &kind, now).await {
        return r.response();
    }
    reply(&st.pool, &owner, &c.user_id, now).await
}

/// Only this group's routes; main.rs puts them behind `require_device`.
pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/v1/city/:owner", get(get_city))
        .route("/v1/city/:owner/build", post(post_build))
        .route("/v1/city/:owner/transfer", post(post_transfer))
        .route("/v1/city/:owner/privacy", post(post_privacy))
        .route("/v1/city/:owner/fare", post(post_fare))
}

#[cfg(test)]
mod tests;
