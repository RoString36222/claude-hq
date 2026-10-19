//! City markets (HQ 3.x, docs/plans/cities-build-spec.md): every city trades
//! every good; it produces only its specialty, chosen by its seed.
//!
//!   GET  /v1/market/:owner                -> [{good, price, stock, held}]
//!   POST /v1/market/:owner/trade {good, qty, side:"buy"|"sell"}
//!                                         -> {good, price, stock, held, coins}
//!
//! `price` is in coins (three decimals); `held` is how many the caller holds.
//! Visible to whoever may see the city (`cities::can_view`); anyone but the
//! owner may trade. A buyer's coins go to the city's treasury and a seller is
//! paid from it, so the market is a ledgered treasury flow like any other.
//! The owner may not trade in their own market: buying and selling back would
//! move coins between wallet and treasury around the 10% transfer fee.
//!
//! Each hour (lazily on read, and from the hourly job), in order:
//!
//! ```text
//! output   = (2 + population/100) × (100 + 25 × workshop)/100     the specialty
//!            needing (output+1)/2 of each input in stock, else output × 25%
//! demand   = (1 + population/400) × 24          a day's need, every good
//! price   += clamp(5% × price × (demand − stock)/demand, ±5% × price)
//!            kept within [0.5, 2.0] × base
//! stock   -= min(stock, 1 + population/400)     the city consumes
//! ```
//!
//! Goods held by players are `poke_balances` rows `mkt:<good>`.

use axum::{
    extract::{Path, Request, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::Serialize;
use serde_json::json;
use sqlx::{SqliteConnection, SqlitePool};

use crate::cities::{self, held, post_entry, wallet_credit, wallet_debit, Refuse, Snapshot};
use crate::{err, AppState};

pub(crate) struct Good {
    pub(crate) key: &'static str,
    /// The tier its district appears at; the district multiplier applies from then.
    pub(crate) gate: i64,
    /// Coins.
    pub(crate) base: i64,
    pub(crate) inputs: &'static [&'static str],
    /// The district's tax multiplier, per-mille.
    pub(crate) mult_pm: i64,
}

/// One good per district kind that makes something (the comment names it).
pub(crate) const GOODS: [Good; 9] = [
    Good { key: "grain", gate: 1, base: 2, inputs: &[], mult_pm: 1000 }, // farm
    Good { key: "fish", gate: 1, base: 2, inputs: &[], mult_pm: 1000 }, // water
    Good { key: "crates", gate: 2, base: 3, inputs: &[], mult_pm: 1100 }, // logistics
    Good { key: "reports", gate: 3, base: 5, inputs: &["crates"], mult_pm: 1150 }, // office
    Good { key: "chips", gate: 3, base: 8, inputs: &["crates"], mult_pm: 1300 }, // tech
    Good { key: "medicine", gate: 4, base: 9, inputs: &["grain"], mult_pm: 1250 }, // biotech
    Good { key: "news", gate: 4, base: 6, inputs: &["chips"], mult_pm: 1150 }, // media
    Good { key: "films", gate: 4, base: 12, inputs: &["chips"], mult_pm: 1200 }, // studio
    Good { key: "bonds", gate: 4, base: 10, inputs: &["reports"], mult_pm: 1300 }, // finance
];

/// Prices are kept in thousandths of a coin.
const MILLI: i64 = 1000;
const STEP_PM: i64 = 50;
const FLOOR_PM: i64 = 500;
const CEIL_PM: i64 = 2000;
const SLOW_PCT: i64 = 25;
const STOCK_CAP: i64 = 500;
const DEPOT_ROOM: i64 = 250;
const OPENING_STOCK: i64 = 50;
/// Missed ticks replayed at most (a day); older ones are skipped.
const MAX_CATCH_UP: i64 = 24;
const TRADE_MAX: i64 = 100;
/// Most of one good a player may hold.
const HOLD_CAP: i64 = 999;

pub(crate) fn good(key: &str) -> Option<&'static Good> {
    GOODS.iter().find(|g| g.key == key)
}

/// The specialty a seed gets; the same seed always gets the same good.
pub(crate) fn specialty_for(seed: &str) -> &'static str {
    GOODS[(cities::seed_hash(seed) % GOODS.len() as u64) as usize].key
}

/// The tax multiplier of the city's specialty district, once it has one.
pub(crate) fn district_pm(specialty: &str, tier: i64) -> i64 {
    good(specialty).filter(|g| tier >= g.gate).map(|g| g.mult_pm).unwrap_or(1000)
}

// -------------------------------------------------------------- tick --

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Row {
    pub(crate) good: &'static str,
    pub(crate) price: i64,
    pub(crate) stock: i64,
}

/// What a tick needs to know about the city.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Economy<'a> {
    pub(crate) specialty: &'a str,
    pub(crate) population: i64,
    pub(crate) workshop: i64,
    pub(crate) depot: i64,
}

impl Economy<'_> {
    pub(crate) fn of(s: &Snapshot) -> Economy<'_> {
        Economy { specialty: &s.row.specialty, population: s.population, workshop: s.level("workshop"), depot: s.level("depot") }
    }

    fn output(&self) -> i64 {
        (2 + self.population / 100) * (100 + 25 * self.workshop) / 100
    }

    fn consumption(&self) -> i64 {
        1 + self.population / 400
    }

    pub(crate) fn stock_cap(&self) -> i64 {
        STOCK_CAP + DEPOT_ROOM * self.depot
    }
}

/// One step of a price toward where demand and supply meet: 5% of the price
/// per demand's worth of shortfall, at most 5% either way, inside the band.
pub(crate) fn step_price(price: i64, base: i64, demand: i64, supply: i64) -> i64 {
    let cap = price * STEP_PM / 1000;
    let raw = price * STEP_PM * (demand - supply) / (1000 * demand.max(1));
    (price + raw.clamp(-cap, cap)).clamp(base * MILLI * FLOOR_PM / 1000, base * MILLI * CEIL_PM / 1000)
}

/// The specialty's output this tick: full when every input is in stock (and
/// consumed), else a quarter.
pub(crate) fn produce(rows: &mut [Row], e: &Economy) -> i64 {
    let Some(g) = good(e.specialty) else { return 0 };
    let out = e.output();
    let need = (out + 1) / 2;
    let ok = g.inputs.iter().all(|i| rows.iter().any(|r| r.good == *i && r.stock >= need));
    let made = if ok {
        for r in rows.iter_mut().filter(|r| g.inputs.contains(&r.good)) {
            r.stock -= need;
        }
        out
    } else {
        out * SLOW_PCT / 100
    };
    let cap = e.stock_cap();
    if let Some(r) = rows.iter_mut().find(|r| r.good == g.key) {
        r.stock = (r.stock + made).min(cap.max(r.stock));
    }
    made
}

/// One hourly tick: produce, move prices, consume.
pub(crate) fn tick(rows: &mut [Row], e: &Economy) {
    produce(rows, e);
    let use_ = e.consumption();
    for r in rows.iter_mut() {
        let base = good(r.good).map(|g| g.base).unwrap_or(1);
        r.price = step_price(r.price, base, use_ * 24, r.stock);
        r.stock -= r.stock.min(use_);
    }
}

/// A fresh market: base prices, and opening stock of the specialty.
pub(crate) fn opening(specialty: &str) -> Vec<Row> {
    GOODS
        .iter()
        .map(|g| Row { good: g.key, price: g.base * MILLI, stock: if g.key == specialty { OPENING_STOCK } else { 0 } })
        .collect()
}

// -------------------------------------------------------------- rows --

/// The market's rows (in GOODS order) and the time of its last tick; created
/// on first use.
async fn load(conn: &mut SqliteConnection, owner: &str, specialty: &str, now: i64) -> Result<(Vec<Row>, i64), sqlx::Error> {
    let have: Vec<(String, i64, i64, i64)> =
        sqlx::query_as("SELECT good, price, stock, updated FROM market_price WHERE owner = ?1")
            .bind(owner)
            .fetch_all(&mut *conn)
            .await?;
    let updated = have.iter().map(|h| h.3).min().unwrap_or(now);
    let mut rows = opening(specialty);
    for r in rows.iter_mut() {
        match have.iter().find(|h| h.0 == r.good) {
            Some(h) => {
                r.price = h.1;
                r.stock = h.2;
            }
            None => {
                sqlx::query("INSERT INTO market_price (owner, good, price, stock, updated) VALUES (?1, ?2, ?3, ?4, ?5)")
                    .bind(owner)
                    .bind(r.good)
                    .bind(r.price)
                    .bind(r.stock)
                    .bind(updated)
                    .execute(&mut *conn)
                    .await?;
            }
        }
    }
    Ok((rows, updated))
}

async fn save(conn: &mut SqliteConnection, owner: &str, rows: &[Row], updated: i64) -> Result<(), sqlx::Error> {
    for r in rows {
        sqlx::query("UPDATE market_price SET price = ?3, stock = ?4, updated = ?5 WHERE owner = ?1 AND good = ?2")
            .bind(owner)
            .bind(r.good)
            .bind(r.price)
            .bind(r.stock)
            .bind(updated)
            .execute(&mut *conn)
            .await?;
    }
    Ok(())
}

/// Replay the ticks missed since the last one (at most a day's), inside the
/// caller's transaction. Returns the market as of now.
async fn caught_up(conn: &mut SqliteConnection, snap: &Snapshot, now: i64) -> Result<Vec<Row>, sqlx::Error> {
    let owner = snap.row.owner.as_str();
    let (mut rows, updated) = load(conn, owner, &snap.row.specialty, now).await?;
    let due = (now - updated).max(0) / 3600;
    if due > 0 {
        let e = Economy::of(snap);
        for _ in 0..due.min(MAX_CATCH_UP) {
            tick(&mut rows, &e);
        }
        let at = if due > MAX_CATCH_UP { now } else { updated + due * 3600 };
        save(conn, owner, &rows, at).await?;
    }
    Ok(rows)
}

pub(crate) async fn catch_up(pool: &SqlitePool, snap: &Snapshot, now: i64) -> Result<Vec<Row>, sqlx::Error> {
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let rows = caught_up(&mut tx, snap, now).await?;
    tx.commit().await?;
    Ok(rows)
}

// ------------------------------------------------------------- trade --

fn item(good: &str) -> String {
    format!("mkt:{good}")
}

/// The cost of buying (rounded up) or the pay for selling (rounded down) qty.
pub(crate) fn trade_value(price: i64, qty: i64, buy: bool) -> i64 {
    let v = price * qty;
    if buy { (v + MILLI - 1) / MILLI } else { v / MILLI }
}

#[derive(Debug, Serialize)]
pub(crate) struct Line {
    good: &'static str,
    price: f64,
    stock: i64,
    held: i64,
}

fn coins(milli: i64) -> f64 {
    milli as f64 / MILLI as f64
}

/// Buy or sell at the current price, from a visitor's wallet and holdings.
pub(crate) async fn trade(
    pool: &SqlitePool,
    owner: &str,
    uid: &str,
    key: &str,
    qty: i64,
    buy: bool,
    now: i64,
) -> Result<Line, Refuse> {
    if owner == uid {
        return Err(Refuse::say(StatusCode::FORBIDDEN, "trade in other cities' markets"));
    }
    let g = good(key).ok_or_else(|| Refuse::say(StatusCode::UNPROCESSABLE_ENTITY, "unknown good"))?;
    let snap = cities::snapshot(pool, owner, now).await?.ok_or_else(|| Refuse::say(StatusCode::NOT_FOUND, "no such city"))?;
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let mut rows = caught_up(&mut tx, &snap, now).await?;
    let r = rows.iter_mut().find(|r| r.good == g.key).expect("every good has a row");
    let value = trade_value(r.price, qty, buy);
    let refr = format!("{}:{qty}", g.key);
    if buy {
        if qty > r.stock {
            return Err(Refuse::say(StatusCode::CONFLICT, format!("only {} {} in stock", r.stock, g.key)));
        }
        if !wallet_debit(&mut tx, uid, "coins", value).await? {
            return Err(Refuse::say(StatusCode::CONFLICT, format!("that costs {value} Poke Coins")));
        }
        if !wallet_credit(&mut tx, uid, &item(g.key), qty, HOLD_CAP).await? {
            return Err(Refuse::say(StatusCode::CONFLICT, format!("you can carry at most {HOLD_CAP} {}", g.key)));
        }
        r.stock -= qty;
        if value > 0 {
            post_entry(&mut tx, owner, "sale", value, &refr, now).await?;
        }
    } else {
        if r.stock + qty > Economy::of(&snap).stock_cap() {
            return Err(Refuse::say(StatusCode::CONFLICT, "the market has no room for that many"));
        }
        if !wallet_debit(&mut tx, uid, &item(g.key), qty).await? {
            return Err(Refuse::say(StatusCode::CONFLICT, format!("you don't have {qty} {}", g.key)));
        }
        r.stock += qty;
        if value > 0 {
            post_entry(&mut tx, owner, "purchase", -value, &refr, now)
                .await
                .map_err(|e| match e {
                    Refuse::Say(..) => Refuse::say(StatusCode::CONFLICT, "this city can't afford that"),
                    db => db,
                })?;
            if !wallet_credit(&mut tx, uid, "coins", value, crate::pantry::COIN_CAP).await? {
                return Err(Refuse::say(StatusCode::CONFLICT, "wallet full"));
            }
        }
    }
    let (price, stock) = (r.price, r.stock);
    sqlx::query("UPDATE market_price SET stock = ?3 WHERE owner = ?1 AND good = ?2")
        .bind(owner)
        .bind(g.key)
        .bind(stock)
        .execute(&mut *tx)
        .await?;
    let held = held(&mut tx, uid, &item(g.key)).await?;
    tx.commit().await?;
    Ok(Line { good: g.key, price: coins(price), stock, held })
}

// ---------------------------------------------------------- handlers --

pub(crate) async fn lines(pool: &SqlitePool, owner: &str, uid: &str, now: i64) -> Result<Option<Vec<Line>>, sqlx::Error> {
    let Some(snap) = cities::snapshot(pool, owner, now).await? else {
        return Ok(None);
    };
    let rows = catch_up(pool, &snap, now).await?;
    let mut conn = pool.acquire().await?;
    let mut out = Vec::with_capacity(rows.len());
    for r in rows {
        let held = held(&mut conn, uid, &item(r.good)).await?;
        out.push(Line { good: r.good, price: coins(r.price), stock: r.stock, held });
    }
    Ok(Some(out))
}

async fn get_market(State(st): State<AppState>, Path(raw): Path<String>, req: Request) -> Response {
    let c = cities::caller(&req);
    let owner = match cities::visible_owner(&st.pool, &raw, &c).await {
        Ok(o) => o,
        Err(r) => return r.response(),
    };
    match lines(&st.pool, &owner, &c.user_id, cities::now_secs()).await {
        Ok(Some(l)) => Json(l).into_response(),
        Ok(None) => err(StatusCode::NOT_FOUND, "no such city"),
        Err(e) => Refuse::Db(e).response(),
    }
}

async fn post_trade(State(st): State<AppState>, Path(raw): Path<String>, req: Request) -> Response {
    let c = cities::caller(&req);
    let owner = match cities::visible_owner(&st.pool, &raw, &c).await {
        Ok(o) => o,
        Err(r) => return r.response(),
    };
    let bytes = match cities::read_body(req).await {
        Ok(b) => b,
        Err(r) => return r.response(),
    };
    let keys: Vec<&str> = GOODS.iter().map(|g| g.key).collect();
    let parsed = cities::body_obj(&bytes, &["good", "qty", "side"]).and_then(|o| {
        Ok((
            cities::str_field(&o, "good", &keys)?.to_string(),
            cities::int_field(&o, "qty", 1, TRADE_MAX)?,
            cities::str_field(&o, "side", &["buy", "sell"])? == "buy",
        ))
    });
    let (key, qty, buy) = match parsed {
        Ok(v) => v,
        Err(m) => return err(StatusCode::UNPROCESSABLE_ENTITY, &m),
    };
    let line = match trade(&st.pool, &owner, &c.user_id, &key, qty, buy, cities::now_secs()).await {
        Ok(l) => l,
        Err(r) => return r.response(),
    };
    let mut conn = match st.pool.acquire().await {
        Ok(c) => c,
        Err(e) => return Refuse::Db(e).response(),
    };
    match held(&mut conn, &c.user_id, "coins").await {
        Ok(coins) => Json(json!({"good": line.good, "price": line.price, "stock": line.stock,
                                 "held": line.held, "coins": coins}))
            .into_response(),
        Err(e) => Refuse::Db(e).response(),
    }
}

/// Only this group's routes; main.rs puts them behind `require_device`.
pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/v1/market/:owner", get(get_market))
        .route("/v1/market/:owner/trade", post(post_trade))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn econ(specialty: &str, population: i64) -> Economy<'_> {
        Economy { specialty, population, workshop: 0, depot: 0 }
    }

    #[test]
    fn a_price_steps_at_most_five_percent_a_tick() {
        // Nothing in stock: a full step up. A glut: a full step down.
        assert_eq!(step_price(4000, 4, 24, 0), 4200);
        assert_eq!(step_price(4000, 4, 24, 10_000), 3800);
        // Balanced: no move. Half the demand short: half a step.
        assert_eq!(step_price(4000, 4, 24, 24), 4000);
        assert_eq!(step_price(4000, 4, 24, 12), 4100);
        for supply in [0, 1, 5, 24, 100, 10_000] {
            for price in [2000, 4000, 7999] {
                let next = step_price(price, 4, 24, supply);
                assert!((next - price).abs() <= price * STEP_PM / 1000, "{price} -> {next}");
            }
        }
    }

    #[test]
    fn a_price_stays_inside_half_to_double_its_base() {
        let mut up = 4000;
        let mut down = 4000;
        for _ in 0..200 {
            up = step_price(up, 4, 24, 0);
            down = step_price(down, 4, 24, 10_000);
            assert!((2000..=8000).contains(&up) && (2000..=8000).contains(&down));
        }
        assert_eq!((up, down), (8000, 2000));
    }

    #[test]
    fn production_without_its_inputs_runs_at_a_quarter() {
        // chips need crates. Population 600: output 8, needing 4 crates.
        let e = econ("chips", 600);
        let mut starved = opening("chips");
        let before = starved.iter().find(|r| r.good == "chips").unwrap().stock;
        assert_eq!(produce(&mut starved, &e), 2);
        assert_eq!(starved.iter().find(|r| r.good == "chips").unwrap().stock, before + 2);

        let mut fed = opening("chips");
        fed.iter_mut().find(|r| r.good == "crates").unwrap().stock = 10;
        assert_eq!(produce(&mut fed, &e), 8);
        assert_eq!(fed.iter().find(|r| r.good == "crates").unwrap().stock, 6);
        assert_eq!(fed.iter().find(|r| r.good == "chips").unwrap().stock, before + 8);

        // Short by one crate is still short.
        let mut short = opening("chips");
        short.iter_mut().find(|r| r.good == "crates").unwrap().stock = 3;
        assert_eq!(produce(&mut short, &e), 2);
        assert_eq!(short.iter().find(|r| r.good == "crates").unwrap().stock, 3);
    }

    #[test]
    fn a_raw_good_needs_nothing_and_the_workshop_adds_a_quarter() {
        let mut rows = opening("grain");
        assert_eq!(produce(&mut rows, &econ("grain", 600)), 8);
        let e = Economy { specialty: "grain", population: 600, workshop: 2, depot: 0 };
        assert_eq!(produce(&mut rows, &e), 12);
    }

    #[test]
    fn stock_never_passes_the_cap() {
        let e = econ("fish", 2000);
        let mut rows = opening("fish");
        for _ in 0..500 {
            tick(&mut rows, &e);
        }
        assert!(rows.iter().all(|r| r.stock <= e.stock_cap() && r.stock >= 0));
        // A glut of its specialty sits at the floor; what it never makes, at the ceiling.
        let fish = rows.iter().find(|r| r.good == "fish").unwrap();
        let films = rows.iter().find(|r| r.good == "films").unwrap();
        assert_eq!(fish.price, 2 * MILLI * FLOOR_PM / 1000);
        assert_eq!(films.price, 12 * MILLI * CEIL_PM / 1000);
    }

    #[test]
    fn the_specialty_follows_the_seed() {
        let a = specialty_for("user:00000000-0000-4000-8000-000000000001@2");
        assert_eq!(a, specialty_for("user:00000000-0000-4000-8000-000000000001@2"));
        let all: std::collections::BTreeSet<&str> =
            (0..200).map(|i| specialty_for(&format!("user:{i}@2"))).collect();
        assert_eq!(all.len(), GOODS.len(), "every good is someone's specialty");
        assert_eq!(district_pm("chips", 2), 1000);
        assert_eq!(district_pm("chips", 3), 1300);
    }

    #[test]
    fn buying_rounds_up_and_selling_rounds_down() {
        assert_eq!(trade_value(2100, 3, true), 7);
        assert_eq!(trade_value(2100, 3, false), 6);
        assert_eq!(trade_value(2000, 3, true), 6);
    }

    #[test]
    fn every_input_is_a_good() {
        for g in &GOODS {
            assert!(g.inputs.iter().all(|i| good(i).is_some()), "{}", g.key);
            assert!(item(g.key).len() <= 16, "poke_balances.item is VARCHAR(16)");
        }
    }
}
