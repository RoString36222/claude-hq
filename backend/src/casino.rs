//! The Casino (HQ 3.7): Poke Coins in at the cage, chips on the floor, every game decided here.
//!
//!   GET  /v1/casino/me                          -> {chips, coins, rate, min_bet, max_bet, tables, stats, hand}
//!   POST /v1/casino/cage {dir: "buy"|"cash", n} -> {ok, chips, coins}
//!   POST /v1/casino/play {game, bet, pick?}     -> {ok, game, bet, payout, chips, result, streak}
//!   POST /v1/casino/blackjack {action, bet?}    -> {ok, done, player, dealer, ..., chips, streak}
//!   GET  /v1/casino/duels                       -> {open: [{id, game, bet, by, mine, age}], mine: [settled, newest first]}
//!   POST /v1/casino/duel {action: "open", game, bet, move?} | {action: "join", id, move?} | {action: "cancel", id}
//!
//! Duels (player against player): a challenger opens one (their stake held), anyone else can take it (theirs held),
//! and it is settled there and then: high card, a dice duel, a coin duel or rock-paper-scissors (hidden moves; a draw
//! hands both stakes back). The winner takes the pot less [`DUEL_RAKE_PM`]. A challenge nobody takes is refunded after
//! [`DUEL_TTL`]; the challenger may cancel it before then. Names are the players' own display names.
//!
//! Chips are a `poke_balances` item ("chips"), bought at the cage for Poke Coins ([`CHIPS_PER_COIN`] a coin)
//! and cashed back the same way, never past the wallet's [`crate::pantry::COIN_CAP`]: a win too big for the
//! wallet stays on the chip rack instead of vanishing. Every outcome is drawn here from the thread's CSPRNG
//! (ChaCha, seeded by the OS), before the transaction; the page only animates what it is told. The house edge
//! is a few percent on every game (see [`rtp`] and the tests, which compute it exactly where they can).
//!
//! The games: slots (three reels), roulette (single zero), horses (six runners at fixed odds), plinko (twelve
//! rows), the Lucky Wheel (fifty segments), rocket (pick a cash-out; it crashes where it crashes), dice (two:
//! over, under, seven, doubles), a scratch card (match three), the coin, and blackjack (dealer stands on all
//! 17s, blackjack pays 3:2, double on the first two cards; one hand at a time, kept in `casino_hand`).
//!
//! Errors: 422 a bad body; 402 not enough chips (or coins at the cage); 409 a full chip rack or wallet, a hand
//! already open (or none to play); 429 too many plays at once.
//!
//! PRIVACY: game names, numbers and the fixed horse names only.

use axum::{
    extract::{Request, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use rand::{Rng, SeedableRng};
use serde_json::{json, Map, Value};
use sqlx::{SqliteConnection, SqlitePool};

use crate::cities::{self, wallet_credit, wallet_debit, held, Refuse};
use crate::pantry::COIN_CAP;

pub const CHIPS_PER_COIN: i64 = 10;
pub const CHIP_CAP: i64 = 1_000_000;
pub const MIN_BET: i64 = 1;
pub const MAX_BET: i64 = 500;
/// Plays one player may make within RATE_SECS (a game's animation takes longer than this anyway).
const RATE_N: i64 = 6;
const RATE_SECS: i64 = 2;
/// An open blackjack hand older than this is forfeit when you deal again (its stake was already taken).
const HAND_STALE: i64 = 3600;

pub const GAMES: [&str; 9] = ["slots", "roulette", "horses", "plinko", "wheel", "rocket", "dice", "scratch", "coin"];

/* ---------- the tables (pure) ---------- */

/// Slots: the same weighted strip on every reel, and what three of a kind pays (times the bet, stake included).
pub const SLOT_SYMS: [(&str, u32, i64); 7] =
    [("cherry", 8, 8), ("lemon", 7, 10), ("bell", 6, 15), ("bar", 5, 25), ("star", 3, 60), ("gem", 2, 150), ("seven", 1, 500)];
/// Exactly two cherries anywhere pays this.
pub const SLOT_TWO_CHERRIES: i64 = 3;

/// The runners: (name, chance in per-mille, payout in tenths of the bet).
pub const HORSES: [(&str, u32, i64); 6] = [
    ("Null Pointer", 280, 33),
    ("Merge Conflict", 220, 43),
    ("Hot Reload", 180, 52),
    ("Off By One", 140, 67),
    ("Tabs Not Spaces", 100, 95),
    ("Segfault Sally", 80, 118),
];

/// Plinko: twelve rows, thirteen bins, each bin's payout in per-mille of the bet.
pub const PLINKO_ROWS: u32 = 12;
pub const PLINKO: [i64; 13] = [10_000, 3_000, 1_600, 1_300, 1_100, 950, 500, 950, 1_100, 1_300, 1_600, 3_000, 10_000];

/// The Lucky Wheel's fifty segments, in order round the wheel, each its payout in tenths of the bet.
pub fn wheel() -> Vec<i64> {
    // 30 blanks, 9 x1.5, 5 x2, 3 x3, 2 x5, 1 x6, spread so the big ones sit among blanks
    let pattern: [i64; 50] = [
        0, 15, 0, 20, 0, 15, 0, 30, 0, 15, 0, 50, 0, 15, 0, 20, 0, 0, 15, 0, 30, 0, 60, 0, 15,
        0, 20, 0, 0, 15, 0, 50, 0, 15, 0, 30, 0, 20, 0, 0, 15, 0, 0, 20, 0, 0, 0, 0, 0, 0,
    ];
    pattern.to_vec()
}

/// Rocket: the crash point is EDGE_PM/1000 / U (U uniform on (0, 1]), so it reaches m with chance 0.96/m.
pub const ROCKET_EDGE_PM: i64 = 960;
pub const ROCKET_MIN: i64 = 101;          // cash-out targets in hundredths: 1.01x ..
pub const ROCKET_MAX: i64 = 10_000;       // .. 100x

/// Dice: two of them. (pick, payout in tenths).
pub const DICE: [(&str, i64); 4] = [("over", 23), ("under", 23), ("seven", 57), ("doubles", 57)];

/// Scratch card: (symbol, chance in per-100k, payout times the bet); the rest of the cards win nothing.
pub const SCRATCH: [(&str, u32, i64); 5] =
    [("coin", 15_000, 1), ("clover", 8_000, 2), ("horseshoe", 4_500, 5), ("diamond", 1_800, 20), ("crown", 50, 100)];
pub const SCRATCH_DUD: &str = "skull";

/// The coin pays this, in per-mille.
pub const COIN_PM: i64 = 1_940;

/// A roulette pocket's colour (European wheel).
pub fn red(n: u32) -> bool {
    matches!(n, 1 | 3 | 5 | 7 | 9 | 12 | 14 | 16 | 18 | 19 | 21 | 23 | 25 | 27 | 30 | 32 | 34 | 36)
}

/// What a roulette bet pays on a pocket (times the bet, stake included), 0 when it loses.
pub fn roulette_pays(pick: &str, n: u32) -> i64 {
    if let Some(k) = pick.strip_prefix("n:") {
        return if k.parse::<u32>().ok() == Some(n) { 36 } else { 0 };
    }
    if n == 0 {
        return 0;
    }
    let win = match pick {
        "red" => red(n),
        "black" => !red(n),
        "odd" => n % 2 == 1,
        "even" => n.is_multiple_of(2),
        "low" => n <= 18,
        "high" => n >= 19,
        "dozen1" => n <= 12,
        "dozen2" => (13..=24).contains(&n),
        "dozen3" => n >= 25,
        "col1" => n % 3 == 1,
        "col2" => n % 3 == 2,
        "col3" => n.is_multiple_of(3),
        _ => false,
    };
    match (win, pick.starts_with("dozen") || pick.starts_with("col")) {
        (false, _) => 0,
        (true, true) => 3,
        (true, false) => 2,
    }
}

/// A valid pick for a game, or why not.
pub fn check_pick(game: &str, pick: Option<&Value>) -> Result<Option<String>, String> {
    let s = pick.and_then(Value::as_str);
    let n = pick.and_then(Value::as_i64);
    let ok = |v: &str| Ok(Some(v.to_string()));
    match game {
        "slots" | "plinko" | "wheel" | "scratch" => Ok(None),
        "roulette" => match s {
            Some(p) if ["red", "black", "odd", "even", "low", "high", "dozen1", "dozen2", "dozen3", "col1", "col2", "col3"].contains(&p) => ok(p),
            Some(p) if p.strip_prefix("n:").and_then(|k| k.parse::<u32>().ok()).is_some_and(|k| k <= 36 && p == format!("n:{k}")) => ok(p),
            _ => Err("pick must be red, black, odd, even, low, high, dozen1-3, col1-3 or n:0..36".into()),
        },
        "horses" => match n {
            Some(k) if (0..HORSES.len() as i64).contains(&k) => Ok(Some(k.to_string())),
            _ => Err("pick must be a horse from 0 to 5".into()),
        },
        "rocket" => match n {
            Some(k) if (ROCKET_MIN..=ROCKET_MAX).contains(&k) => Ok(Some(k.to_string())),
            _ => Err(format!("pick must be a cash-out from {ROCKET_MIN} to {ROCKET_MAX} (hundredths)")),
        },
        "dice" => match s {
            Some(p) if DICE.iter().any(|d| d.0 == p) => ok(p),
            _ => Err("pick must be over, under, seven or doubles".into()),
        },
        "coin" => match s {
            Some(p @ ("heads" | "tails")) => ok(p),
            _ => Err("pick must be heads or tails".into()),
        },
        _ => Err("no such game".into()),
    }
}

/// One play's outcome: what comes back (stake included; 0 lost it all) and what the page draws.
#[derive(Debug, Clone, PartialEq)]
pub struct Outcome {
    pub payout: i64,
    pub result: Value,
}

fn weighted<R: Rng + ?Sized>(rng: &mut R, w: &[u32]) -> usize {
    let total: u32 = w.iter().sum();
    let mut x = rng.gen_range(0..total);
    for (i, &k) in w.iter().enumerate() {
        if x < k {
            return i;
        }
        x -= k;
    }
    w.len() - 1
}

/// Play one round of a one-shot game. `pick` was checked by [`check_pick`].
pub fn play<R: Rng + ?Sized>(game: &str, bet: i64, pick: Option<&str>, rng: &mut R) -> Outcome {
    match game {
        "slots" => {
            let w: Vec<u32> = SLOT_SYMS.iter().map(|s| s.1).collect();
            let reels: Vec<usize> = (0..3).map(|_| weighted(rng, &w)).collect();
            let cherries = reels.iter().filter(|&&r| r == 0).count();
            let (mult, line) = if reels[0] == reels[1] && reels[1] == reels[2] {
                (SLOT_SYMS[reels[0]].2, "three")
            } else if cherries == 2 {
                (SLOT_TWO_CHERRIES, "cherries")
            } else {
                (0, "none")
            };
            Outcome { payout: bet * mult, result: json!({"reels": reels.iter().map(|&r| SLOT_SYMS[r].0).collect::<Vec<_>>(), "line": line, "mult": mult}) }
        }
        "roulette" => {
            let n = rng.gen_range(0..37u32);
            let p = pick.unwrap_or("red");
            Outcome { payout: bet * roulette_pays(p, n), result: json!({"pocket": n, "color": if n == 0 { "green" } else if red(n) { "red" } else { "black" }, "pick": p}) }
        }
        "horses" => {
            // the finishing order: the winner by its chance, then the rest the same way among those left
            let mut left: Vec<usize> = (0..HORSES.len()).collect();
            let mut order = Vec::new();
            while !left.is_empty() {
                let w: Vec<u32> = left.iter().map(|&i| HORSES[i].1).collect();
                order.push(left.remove(weighted(rng, &w)));
            }
            let mine: usize = pick.and_then(|p| p.parse().ok()).unwrap_or(0);
            let payout = if order[0] == mine { bet * HORSES[mine].2 / 10 } else { 0 };
            Outcome { payout, result: json!({"order": order, "pick": mine, "seed": rng.gen::<u32>()}) }
        }
        "plinko" => {
            let path: Vec<u8> = (0..PLINKO_ROWS).map(|_| rng.gen_range(0..2u8)).collect();
            let bin = path.iter().filter(|&&b| b == 1).count();
            Outcome { payout: bet * PLINKO[bin] / 1000, result: json!({"path": path, "bin": bin, "pm": PLINKO[bin]}) }
        }
        "wheel" => {
            let segs = wheel();
            let i = rng.gen_range(0..segs.len());
            Outcome { payout: bet * segs[i] / 10, result: json!({"segment": i, "tenths": segs[i]}) }
        }
        "rocket" => {
            let target: i64 = pick.and_then(|p| p.parse().ok()).unwrap_or(200);
            // U in (0, 1]: the crash point in hundredths, floored, never below 1.00x
            let u = 1.0 - rng.gen::<f64>();
            let crash = ((ROCKET_EDGE_PM as f64 / 10.0 / u).floor() as i64).clamp(100, 1_000_000);
            let payout = if crash >= target { bet * target / 100 } else { 0 };
            Outcome { payout, result: json!({"crash": crash, "target": target}) }
        }
        "dice" => {
            let (a, b) = (rng.gen_range(1..=6u32), rng.gen_range(1..=6u32));
            let p = pick.unwrap_or("over");
            let win = match p {
                "over" => a + b > 7,
                "under" => a + b < 7,
                "seven" => a + b == 7,
                _ => a == b,
            };
            let tenths = DICE.iter().find(|d| d.0 == p).map(|d| d.1).unwrap_or(0);
            Outcome { payout: if win { bet * tenths / 10 } else { 0 }, result: json!({"dice": [a, b], "pick": p}) }
        }
        "scratch" => {
            let mut w: Vec<u32> = SCRATCH.iter().map(|s| s.1).collect();
            w.push(100_000 - w.iter().sum::<u32>());
            let tier = weighted(rng, &w);
            Outcome { payout: if tier < SCRATCH.len() { bet * SCRATCH[tier].2 } else { 0 }, result: json!({"grid": scratch_grid(tier, rng), "prize": SCRATCH.get(tier).map(|s| s.0)}) }
        }
        _ => {
            let side = if rng.gen::<bool>() { "heads" } else { "tails" };
            let p = pick.unwrap_or("heads");
            Outcome { payout: if side == p { bet * COIN_PM / 1000 } else { 0 }, result: json!({"side": side, "pick": p}) }
        }
    }
}

/// A scratch card's nine cells: three of the prize's symbol when `tier` is a prize, and never three of
/// anything else (a losing card is all near misses).
pub fn scratch_grid<R: Rng + ?Sized>(tier: usize, rng: &mut R) -> Vec<&'static str> {
    let mut syms: Vec<&'static str> = SCRATCH.iter().map(|s| s.0).collect();
    syms.push(SCRATCH_DUD);
    let mut cells: Vec<&'static str> = Vec::new();
    if tier < SCRATCH.len() {
        cells.extend([SCRATCH[tier].0; 3]);
    }
    let mut count = std::collections::HashMap::new();
    for c in &cells {
        *count.entry(*c).or_insert(0) += 1;
    }
    while cells.len() < 9 {
        let s = syms[rng.gen_range(0..syms.len())];
        let k = count.entry(s).or_insert(0);
        if (tier < SCRATCH.len() && s == SCRATCH[tier].0) || *k >= 2 {
            continue;
        }
        *k += 1;
        cells.push(s);
    }
    for i in (1..cells.len()).rev() {
        cells.swap(i, rng.gen_range(0..=i));
    }
    cells
}

/// The return to player of each one-shot game, exactly (per-mille), where the tables make it a sum.
pub fn rtp(game: &str) -> f64 {
    match game {
        "slots" => {
            let t: f64 = SLOT_SYMS.iter().map(|s| s.1 as f64).sum();
            let three: f64 = SLOT_SYMS.iter().map(|s| (s.1 as f64 / t).powi(3) * s.2 as f64).sum();
            let pc = SLOT_SYMS[0].1 as f64 / t;
            three + 3.0 * pc * pc * (1.0 - pc) * SLOT_TWO_CHERRIES as f64
        }
        "roulette" => 36.0 / 37.0,
        "horses" => HORSES.iter().map(|h| h.1 as f64 / 1000.0 * h.2 as f64 / 10.0).sum::<f64>() / HORSES.len() as f64,
        "plinko" => {
            let n = PLINKO_ROWS as usize;
            let mut c = vec![1f64; n + 1];
            for k in 1..=n {
                c[k] = c[k - 1] * (n + 1 - k) as f64 / k as f64;
            }
            (0..=n).map(|k| c[k] / 2f64.powi(n as i32) * PLINKO[k] as f64 / 1000.0).sum()
        }
        "wheel" => {
            let s = wheel();
            s.iter().sum::<i64>() as f64 / 10.0 / s.len() as f64
        }
        "rocket" => ROCKET_EDGE_PM as f64 / 1000.0,
        "dice" => (15.0 / 36.0 * 2.3 + 15.0 / 36.0 * 2.3 + 6.0 / 36.0 * 5.7 + 6.0 / 36.0 * 5.7) / 4.0,
        "scratch" => SCRATCH.iter().map(|s| s.1 as f64 / 100_000.0 * s.2 as f64).sum(),
        "coin" => COIN_PM as f64 / 1000.0 / 2.0,
        _ => 0.0,
    }
}

/* ---------- blackjack (pure) ---------- */

/// A card 0..51: its rank 0..12 (0 the ace, 9..12 ten to king) and suit c / 13.
pub fn card_value(c: i64) -> i64 {
    match c.rem_euclid(13) {
        0 => 11,
        r if r >= 9 => 10,
        r => r + 1,
    }
}

/// A hand's best total, and whether it is soft (an ace still counted as 11).
pub fn total(cards: &[i64]) -> (i64, bool) {
    let mut t: i64 = cards.iter().map(|&c| card_value(c)).sum();
    let mut aces = cards.iter().filter(|&&c| c.rem_euclid(13) == 0).count();
    while t > 21 && aces > 0 {
        t -= 10;
        aces -= 1;
    }
    (t, aces > 0)
}

pub fn blackjack(cards: &[i64]) -> bool {
    cards.len() == 2 && total(cards).0 == 21
}

/// How a finished hand settles: (what comes back, the outcome's name). `stake` is everything put in.
pub fn settle(player: &[i64], dealer: &[i64], stake: i64) -> (i64, &'static str) {
    let (p, d) = (total(player).0, total(dealer).0);
    let (pb, db) = (blackjack(player), blackjack(dealer));
    if p > 21 {
        (0, "bust")
    } else if pb && db {
        (stake, "push")
    } else if pb {
        (stake + stake * 3 / 2, "blackjack")
    } else if db {
        (0, "dealer_blackjack")
    } else if d > 21 {
        (stake * 2, "dealer_bust")
    } else if p > d {
        (stake * 2, "win")
    } else if p == d {
        (stake, "push")
    } else {
        (0, "lose")
    }
}

/* ---------- storage ---------- */

async fn record(conn: &mut SqliteConnection, uid: &str, game: &str, bet: i64, payout: i64, result: &Value, now: i64) -> Result<(), sqlx::Error> {
    sqlx::query("INSERT INTO casino_play (user_id, at, game, bet, payout, result) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
        .bind(uid)
        .bind(now)
        .bind(game)
        .bind(bet)
        .bind(payout)
        .bind(result.to_string())
        .execute(&mut *conn)
        .await?;
    Ok(())
}

/// Plays settled in a row that returned less than they cost (the page has opinions about this).
async fn streak(conn: &mut SqliteConnection, uid: &str) -> Result<i64, sqlx::Error> {
    let rows: Vec<(i64, i64)> = sqlx::query_as("SELECT bet, payout FROM casino_play WHERE user_id = ?1 ORDER BY id DESC LIMIT 50")
        .bind(uid)
        .fetch_all(&mut *conn)
        .await?;
    Ok(rows.iter().take_while(|(b, p)| p < b).count() as i64)
}

async fn too_fast(conn: &mut SqliteConnection, uid: &str, now: i64) -> Result<bool, sqlx::Error> {
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM casino_play WHERE user_id = ?1 AND at > ?2")
        .bind(uid)
        .bind(now - RATE_SECS)
        .fetch_one(&mut *conn)
        .await?;
    Ok(n >= RATE_N)
}

fn say(code: StatusCode, m: &str) -> Refuse {
    Refuse::say(code, m)
}

/// Take a stake in chips, or why not.
async fn take(conn: &mut SqliteConnection, uid: &str, bet: i64) -> Result<(), Refuse> {
    if !wallet_debit(conn, uid, "chips", bet).await? {
        return Err(say(StatusCode::PAYMENT_REQUIRED, "not enough chips: the cage sells them for Poke Coins"));
    }
    Ok(())
}

async fn pay(conn: &mut SqliteConnection, uid: &str, n: i64) -> Result<(), Refuse> {
    if n > 0 && !wallet_credit(conn, uid, "chips", n, CHIP_CAP).await? {
        return Err(say(StatusCode::CONFLICT, "your chip rack is full: cash some out at the cage"));
    }
    Ok(())
}

/// The cage: `buy` n Poke Coins' worth of chips, or `cash` n chips (a multiple of the rate) into Poke Coins.
pub(crate) async fn cage(pool: &SqlitePool, uid: &str, dir: &str, n: i64) -> Result<(i64, i64), Refuse> {
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    if dir == "buy" {
        if !wallet_debit(&mut tx, uid, "coins", n).await? {
            return Err(say(StatusCode::PAYMENT_REQUIRED, "not enough Poke Coins"));
        }
        if !wallet_credit(&mut tx, uid, "chips", n * CHIPS_PER_COIN, CHIP_CAP).await? {
            return Err(say(StatusCode::CONFLICT, "your chip rack is full"));
        }
    } else {
        if n % CHIPS_PER_COIN != 0 {
            return Err(say(StatusCode::UNPROCESSABLE_ENTITY, "cash chips in tens"));
        }
        if !wallet_debit(&mut tx, uid, "chips", n).await? {
            return Err(say(StatusCode::PAYMENT_REQUIRED, "not enough chips"));
        }
        if !wallet_credit(&mut tx, uid, "coins", n / CHIPS_PER_COIN, COIN_CAP).await? {
            return Err(say(StatusCode::CONFLICT, &format!("your wallet holds at most {COIN_CAP} Poke Coins")));
        }
    }
    let (chips, coins) = (held(&mut tx, uid, "chips").await?, held(&mut tx, uid, "coins").await?);
    tx.commit().await?;
    Ok((chips, coins))
}

/// One round of a one-shot game: the outcome is drawn first, then the stake taken and the winnings paid in one
/// transaction. -> (outcome, chips after, losing streak)
pub(crate) async fn play_once(pool: &SqlitePool, uid: &str, game: &str, bet: i64, pick: Option<&str>, now: i64) -> Result<(Outcome, i64, i64), Refuse> {
    let out = play(game, bet, pick, &mut rand::thread_rng());
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    if too_fast(&mut tx, uid, now).await? {
        return Err(say(StatusCode::TOO_MANY_REQUESTS, "easy, high roller: one game at a time"));
    }
    take(&mut tx, uid, bet).await?;
    pay(&mut tx, uid, out.payout).await?;
    record(&mut tx, uid, game, bet, out.payout, &out.result, now).await?;
    let (chips, st) = (held(&mut tx, uid, "chips").await?, streak(&mut tx, uid).await?);
    tx.commit().await?;
    Ok((out, chips, st))
}

#[derive(Debug, Clone)]
struct Hand {
    bet: i64,
    doubled: bool,
    player: Vec<i64>,
    dealer: Vec<i64>,
    at: i64,
}

async fn open_hand(conn: &mut SqliteConnection, uid: &str) -> Result<Option<Hand>, sqlx::Error> {
    let row: Option<(i64, i64, String, String, i64)> = sqlx::query_as("SELECT bet, doubled, player, dealer, at FROM casino_hand WHERE user_id = ?1")
        .bind(uid)
        .fetch_optional(&mut *conn)
        .await?;
    Ok(row.map(|(bet, d, p, q, at)| Hand {
        bet,
        doubled: d != 0,
        player: serde_json::from_str(&p).unwrap_or_default(),
        dealer: serde_json::from_str(&q).unwrap_or_default(),
        at,
    }))
}

async fn save_hand(conn: &mut SqliteConnection, uid: &str, h: &Hand) -> Result<(), sqlx::Error> {
    sqlx::query("INSERT INTO casino_hand (user_id, bet, doubled, player, dealer, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(user_id) DO UPDATE SET bet = ?2, doubled = ?3, player = ?4, dealer = ?5, at = ?6")
        .bind(uid)
        .bind(h.bet)
        .bind(h.doubled as i64)
        .bind(serde_json::to_string(&h.player).unwrap_or_default())
        .bind(serde_json::to_string(&h.dealer).unwrap_or_default())
        .bind(h.at)
        .execute(&mut *conn)
        .await?;
    Ok(())
}

/// What the page sees of a hand: the dealer's hole card stays face down (-1) until the hand is done.
fn hand_view(h: &Hand, done: bool) -> Value {
    let dealer: Vec<i64> = if done { h.dealer.clone() } else { vec![h.dealer[0], -1] };
    json!({"bet": h.bet * if h.doubled { 2 } else { 1 }, "player": h.player, "dealer": dealer, "ptotal": total(&h.player).0,
           "dtotal": if done { total(&h.dealer).0 } else { card_value(h.dealer[0]) },
           "can_double": !done && h.player.len() == 2 && !h.doubled})
}

/// A blackjack move. deal: a new hand for `bet`; hit, stand, double: the open hand.
pub(crate) async fn blackjack_move(pool: &SqlitePool, uid: &str, action: &str, bet: i64, now: i64) -> Result<Value, Refuse> {
    // every card this move could need, drawn before the transaction
    let mut deck: Vec<i64> = {
        let mut rng = rand::thread_rng();
        (0..24).map(|_| rng.gen_range(0..52)).collect()
    };
    let mut draw = move || deck.pop().unwrap_or(0);
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let mut h = match (action, open_hand(&mut tx, uid).await?) {
        ("deal", Some(h)) if now - h.at < HAND_STALE => return Err(say(StatusCode::CONFLICT, "finish the hand on the table first")),
        ("deal", _) => {
            if too_fast(&mut tx, uid, now).await? {
                return Err(say(StatusCode::TOO_MANY_REQUESTS, "easy, high roller: one game at a time"));
            }
            take(&mut tx, uid, bet).await?;
            Hand { bet, doubled: false, player: vec![draw(), draw()], dealer: vec![draw(), draw()], at: now }
        }
        (_, None) => return Err(say(StatusCode::CONFLICT, "no hand on the table: deal first")),
        (_, Some(h)) => h,
    };
    let mut done = action == "deal" && (blackjack(&h.player) || blackjack(&h.dealer));
    match action {
        "hit" => {
            h.player.push(draw());
            done = total(&h.player).0 >= 21;
        }
        "double" => {
            if h.player.len() != 2 || h.doubled {
                return Err(say(StatusCode::CONFLICT, "you can double only on your first two cards"));
            }
            take(&mut tx, uid, h.bet).await?;
            h.doubled = true;
            h.player.push(draw());
            done = true;
        }
        "stand" => done = true,
        _ => {}
    }
    let mut out = json!({"ok": true, "done": done});
    if done {
        if total(&h.player).0 <= 21 && !blackjack(&h.player) && !(action == "deal" && blackjack(&h.dealer)) {
            // the dealer plays out: draws to 17 and stands on every 17
            while total(&h.dealer).0 < 17 {
                h.dealer.push(draw());
            }
        }
        let stake = h.bet * if h.doubled { 2 } else { 1 };
        let (payout, how) = settle(&h.player, &h.dealer, stake);
        pay(&mut tx, uid, payout).await?;
        sqlx::query("DELETE FROM casino_hand WHERE user_id = ?1").bind(uid).execute(&mut *tx).await?;
        let view = hand_view(&h, true);
        record(&mut tx, uid, "blackjack", stake, payout, &json!({"player": h.player, "dealer": h.dealer, "outcome": how}), now).await?;
        let o = out.as_object_mut().unwrap();
        o.insert("hand".into(), view);
        o.insert("outcome".into(), json!(how));
        o.insert("payout".into(), json!(payout));
        o.insert("streak".into(), json!(streak(&mut tx, uid).await?));
    } else {
        save_hand(&mut tx, uid, &h).await?;
        out.as_object_mut().unwrap().insert("hand".into(), hand_view(&h, false));
    }
    let chips = held(&mut tx, uid, "chips").await?;
    out.as_object_mut().unwrap().insert("chips".into(), json!(chips));
    tx.commit().await?;
    Ok(out)
}

/// The tables the page draws from (so it never disagrees with what is paid), your chips and coins, your stats.
pub(crate) async fn me(pool: &SqlitePool, uid: &str, now: i64) -> Result<Value, Refuse> {
    let mut conn = pool.acquire().await?;
    let (chips, coins) = (held(&mut conn, uid, "chips").await?, held(&mut conn, uid, "coins").await?);
    let (plays, wagered, returned, best): (i64, i64, i64, i64) =
        sqlx::query_as("SELECT COUNT(*), COALESCE(SUM(bet), 0), COALESCE(SUM(payout), 0), COALESCE(MAX(payout - bet), 0) FROM casino_play WHERE user_id = ?1")
            .bind(uid)
            .fetch_one(&mut *conn)
            .await?;
    let st = streak(&mut conn, uid).await?;
    let hand = open_hand(&mut conn, uid).await?.filter(|h| now - h.at < HAND_STALE).map(|h| hand_view(&h, false));
    Ok(json!({
        "chips": chips, "coins": coins, "coin_cap": COIN_CAP, "chip_cap": CHIP_CAP, "rate": CHIPS_PER_COIN, "min_bet": MIN_BET, "max_bet": MAX_BET,
        "tables": {
            "slots": {"symbols": SLOT_SYMS.iter().map(|s| json!({"sym": s.0, "pays": s.2})).collect::<Vec<_>>(), "two_cherries": SLOT_TWO_CHERRIES},
            "horses": HORSES.iter().map(|h| json!({"name": h.0, "tenths": h.2})).collect::<Vec<_>>(),
            "plinko": PLINKO, "wheel": wheel(), "rocket": {"min": ROCKET_MIN, "max": ROCKET_MAX},
            "dice": DICE.iter().map(|d| json!({"pick": d.0, "tenths": d.1})).collect::<Vec<_>>(),
            "scratch": SCRATCH.iter().map(|s| json!({"sym": s.0, "pays": s.2})).collect::<Vec<_>>(), "coin_pm": COIN_PM,
            "rtp": GAMES.iter().map(|g| (g.to_string(), json!((rtp(g) * 1000.0).round() / 10.0))).collect::<Map<String, Value>>(),
        },
        "stats": {"plays": plays, "wagered": wagered, "returned": returned, "best": best, "streak": st},
        "hand": hand,
    }))
}

/* ---------- duels ---------- */

pub const DUEL_GAMES: [&str; 4] = ["highcard", "dice", "coin", "rps"];
pub const RPS: [&str; 3] = ["rock", "paper", "scissors"];
/// The house's cut of a settled duel's pot, per mille.
pub const DUEL_RAKE_PM: i64 = 50;
/// An untaken challenge's life (s); one player may have this many open at once.
pub const DUEL_TTL: i64 = 1800;
const DUEL_OPEN_MAX: i64 = 3;

/// A high card's strength: aces high.
fn card_rank(c: i64) -> i64 {
    (c.rem_euclid(13) + 12) % 13
}

/// Settle a chance duel: who wins (true: the challenger) and what each drew. Ties draw again.
pub fn duel_draw<R: Rng + ?Sized>(game: &str, rng: &mut R) -> (bool, Value) {
    loop {
        match game {
            "highcard" => {
                let (a, b) = (rng.gen_range(0..52i64), rng.gen_range(0..52i64));
                if card_rank(a) != card_rank(b) {
                    return (card_rank(a) > card_rank(b), json!({"owner": [a], "taker": [b]}));
                }
            }
            "dice" => {
                let a = [rng.gen_range(1..=6i64), rng.gen_range(1..=6i64)];
                let b = [rng.gen_range(1..=6i64), rng.gen_range(1..=6i64)];
                if a[0] + a[1] != b[0] + b[1] {
                    return (a[0] + a[1] > b[0] + b[1], json!({"owner": a, "taker": b}));
                }
            }
            _ => {
                let heads = rng.gen::<bool>();
                return (heads, json!({"side": if heads { "heads" } else { "tails" }}));
            }
        }
    }
}

/// Rock-paper-scissors: Some(true) the challenger wins, Some(false) the taker, None a draw.
pub fn rps_beats(a: &str, b: &str) -> Option<bool> {
    if a == b {
        return None;
    }
    Some(matches!((a, b), ("rock", "scissors") | ("paper", "rock") | ("scissors", "paper")))
}

/// What the winner of a pot takes.
pub fn duel_prize(bet: i64) -> i64 {
    let pot = bet * 2;
    pot - pot * DUEL_RAKE_PM / 1000
}

/// Refund every challenge older than DUEL_TTL that nobody took.
async fn expire(conn: &mut SqliteConnection, now: i64) -> Result<(), Refuse> {
    let old: Vec<(String, String, i64)> = sqlx::query_as("SELECT id, owner, bet FROM casino_duel WHERE state = 'open' AND created <= ?1")
        .bind(now - DUEL_TTL)
        .fetch_all(&mut *conn)
        .await?;
    for (id, owner, bet) in old {
        sqlx::query("UPDATE casino_duel SET state = 'expired', settled = ?2 WHERE id = ?1 AND state = 'open'").bind(&id).bind(now).execute(&mut *conn).await?;
        let _ = wallet_credit(conn, &owner, "chips", bet, CHIP_CAP).await?;
    }
    Ok(())
}

/// A duel move. -> what the page shows (the duel as settled, or the open challenge).
#[allow(clippy::too_many_arguments)]
pub(crate) async fn duel_move(pool: &SqlitePool, uid: &str, action: &str, game: &str, bet: i64, id: &str, mv: Option<&str>, now: i64) -> Result<Value, Refuse> {
    let (owner_wins, drawn) = duel_draw(game, &mut rand::thread_rng());
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    expire(&mut tx, now).await?;
    let out = match action {
        "open" => {
            let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM casino_duel WHERE owner = ?1 AND state = 'open'").bind(uid).fetch_one(&mut *tx).await?;
            if n >= DUEL_OPEN_MAX {
                return Err(say(StatusCode::CONFLICT, "you already have three challenges waiting"));
            }
            if game == "rps" && mv.is_none() {
                return Err(say(StatusCode::UNPROCESSABLE_ENTITY, "pick rock, paper or scissors"));
            }
            take(&mut tx, uid, bet).await?;
            let id = uuid::Uuid::new_v4().to_string();
            sqlx::query("INSERT INTO casino_duel (id, owner, game, bet, owner_move, created) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
                .bind(&id).bind(uid).bind(game).bind(bet).bind(if game == "rps" { mv } else { None }).bind(now)
                .execute(&mut *tx).await?;
            json!({"ok": true, "id": id, "state": "open", "game": game, "bet": bet})
        }
        "cancel" => {
            let row: Option<(i64,)> = sqlx::query_as("SELECT bet FROM casino_duel WHERE id = ?1 AND owner = ?2 AND state = 'open'").bind(id).bind(uid).fetch_optional(&mut *tx).await?;
            let Some((b,)) = row else { return Err(say(StatusCode::CONFLICT, "that challenge is no longer open")) };
            sqlx::query("UPDATE casino_duel SET state = 'cancelled', settled = ?2 WHERE id = ?1").bind(id).bind(now).execute(&mut *tx).await?;
            pay(&mut tx, uid, b).await?;
            json!({"ok": true, "id": id, "state": "cancelled"})
        }
        _ => {
            let row: Option<(String, String, i64, Option<String>)> = sqlx::query_as("SELECT owner, game, bet, owner_move FROM casino_duel WHERE id = ?1 AND state = 'open'")
                .bind(id).fetch_optional(&mut *tx).await?;
            let Some((owner, g, b, om)) = row else { return Err(say(StatusCode::CONFLICT, "someone beat you to it: that challenge is gone")) };
            if owner == uid {
                return Err(say(StatusCode::CONFLICT, "you can't take your own challenge"));
            }
            if g == "rps" && mv.is_none() {
                return Err(say(StatusCode::UNPROCESSABLE_ENTITY, "pick rock, paper or scissors"));
            }
            take(&mut tx, uid, b).await?;
            // the draw was made for `game` from the body; a chance duel is settled with its own game's draw
            let (ow, res) = if g == "rps" {
                let (a, t) = (om.clone().unwrap_or_default(), mv.unwrap_or("rock").to_string());
                (rps_beats(&a, &t), json!({"owner": a, "taker": t}))
            } else if g == game {
                (Some(owner_wins), drawn.clone())
            } else {
                let (w2, d2) = duel_draw(&g, &mut rand::rngs::StdRng::from_entropy());
                (Some(w2), d2)
            };
            let winner = ow.map(|o| if o { owner.clone() } else { uid.to_string() });
            match &winner {
                Some(w) => pay(&mut tx, w, duel_prize(b)).await?,
                None => {
                    pay(&mut tx, &owner, b).await?;
                    pay(&mut tx, uid, b).await?;
                }
            }
            sqlx::query("UPDATE casino_duel SET state = 'settled', taker = ?2, taker_move = ?3, winner = ?4, result = ?5, settled = ?6 WHERE id = ?1")
                .bind(id).bind(uid).bind(if g == "rps" { mv } else { None }).bind(&winner).bind(res.to_string()).bind(now)
                .execute(&mut *tx).await?;
            let mine = winner.as_deref() == Some(uid);
            record(&mut tx, uid, "duel", b, if winner.is_none() { b } else if mine { duel_prize(b) } else { 0 }, &json!({"duel": id, "game": g}), now).await?;
            json!({"ok": true, "id": id, "state": "settled", "game": g, "bet": b, "result": res, "draw": winner.is_none(), "won": mine,
                   "prize": duel_prize(b), "by": name_of(&mut tx, &owner).await?})
        }
    };
    let chips = held(&mut tx, uid, "chips").await?;
    tx.commit().await?;
    let mut out = out;
    out.as_object_mut().unwrap().insert("chips".into(), json!(chips));
    Ok(out)
}

async fn name_of(conn: &mut SqliteConnection, uid: &str) -> Result<String, sqlx::Error> {
    let n: Option<String> = sqlx::query_scalar("SELECT COALESCE(NULLIF(trainer_name, ''), NULLIF(display_name, ''), handle) FROM users WHERE id = ?1")
        .bind(uid).fetch_optional(&mut *conn).await?;
    Ok(n.unwrap_or_else(|| "a player".into()))
}

/// The open challenges (newest first, yours marked) and your last settled duels.
pub(crate) async fn duels(pool: &SqlitePool, uid: &str, now: i64) -> Result<Value, Refuse> {
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    expire(&mut tx, now).await?;
    let open: Vec<(String, String, String, i64, i64, String)> = sqlx::query_as(
        "SELECT d.id, d.owner, d.game, d.bet, d.created, COALESCE(NULLIF(u.trainer_name, ''), NULLIF(u.display_name, ''), u.handle)
           FROM casino_duel d JOIN users u ON u.id = d.owner WHERE d.state = 'open' ORDER BY d.created DESC LIMIT 30")
        .fetch_all(&mut *tx).await?;
    let mine: Vec<(String, String, i64, String, Option<String>, Option<String>, String, Option<i64>, String)> = sqlx::query_as(
        "SELECT d.id, d.game, d.bet, d.state, d.winner, d.taker, d.result, d.settled, d.owner FROM casino_duel d
          WHERE (d.owner = ?1 OR d.taker = ?1) AND d.state != 'open' ORDER BY COALESCE(d.settled, d.created) DESC LIMIT 10")
        .bind(uid).fetch_all(&mut *tx).await?;
    let mut list = Vec::new();
    for (id, game, bet, state, winner, taker, result, settled, owner) in mine {
        let other = if owner == uid { taker.clone() } else { Some(owner.clone()) };
        let vs = match &other { Some(o) => name_of(&mut tx, o).await?, None => String::new() };
        list.push(json!({"id": id, "game": game, "bet": bet, "state": state, "won": winner.as_deref() == Some(uid), "draw": state == "settled" && winner.is_none(),
                         "vs": vs, "mine": owner == uid, "result": serde_json::from_str::<Value>(&result).unwrap_or(json!({})), "at": settled}));
    }
    tx.commit().await?;
    Ok(json!({
        "open": open.into_iter().map(|(id, o, g, b, c, n)| json!({"id": id, "game": g, "bet": b, "by": n, "mine": o == uid, "age": now - c})).collect::<Vec<_>>(),
        "mine": list, "rake_pm": DUEL_RAKE_PM, "ttl": DUEL_TTL,
    }))
}

/* ---------- routes ---------- */

fn obj(bytes: &[u8], allowed: &[&str]) -> Result<Map<String, Value>, String> {
    let Ok(Value::Object(o)) = serde_json::from_slice::<Value>(bytes) else {
        return Err("body must be a JSON object".into());
    };
    if let Some(k) = o.keys().find(|k| !allowed.contains(&k.as_str())) {
        return Err(format!("unknown field {k:?}"));
    }
    Ok(o)
}

/// A play's body: `{game, bet, pick?}` checked against the game.
pub(crate) fn parse_play(bytes: &[u8]) -> Result<(String, i64, Option<String>), String> {
    let o = obj(bytes, &["game", "bet", "pick"])?;
    let game = cities::str_field(&o, "game", &GAMES)?.to_string();
    let bet = cities::int_field(&o, "bet", MIN_BET, MAX_BET)?;
    let pick = check_pick(&game, o.get("pick"))?;
    Ok((game, bet, pick))
}

async fn get_me(State(st): State<crate::AppState>, req: Request) -> Response {
    let c = cities::caller(&req);
    match me(&st.pool, &c.user_id, cities::now_secs()).await {
        Ok(v) => Json(v).into_response(),
        Err(r) => r.response(),
    }
}

async fn post_cage(State(st): State<crate::AppState>, req: Request) -> Response {
    let c = cities::caller(&req);
    let bytes = match cities::read_body(req).await {
        Ok(b) => b,
        Err(r) => return r.response(),
    };
    let parsed = cities::body_obj(&bytes, &["dir", "n"]).and_then(|o| {
        let dir = cities::str_field(&o, "dir", &["buy", "cash"])?.to_string();
        let n = if dir == "buy" { cities::int_field(&o, "n", 1, COIN_CAP)? } else { cities::int_field(&o, "n", CHIPS_PER_COIN, CHIP_CAP)? };
        Ok((dir, n))
    });
    let (dir, n) = match parsed {
        Ok(v) => v,
        Err(m) => return crate::err(StatusCode::UNPROCESSABLE_ENTITY, &m),
    };
    match cage(&st.pool, &c.user_id, &dir, n).await {
        Ok((chips, coins)) => Json(json!({"ok": true, "chips": chips, "coins": coins})).into_response(),
        Err(r) => r.response(),
    }
}

async fn post_play(State(st): State<crate::AppState>, req: Request) -> Response {
    let c = cities::caller(&req);
    let bytes = match cities::read_body(req).await {
        Ok(b) => b,
        Err(r) => return r.response(),
    };
    let (game, bet, pick) = match parse_play(&bytes) {
        Ok(v) => v,
        Err(m) => return crate::err(StatusCode::UNPROCESSABLE_ENTITY, &m),
    };
    match play_once(&st.pool, &c.user_id, &game, bet, pick.as_deref(), cities::now_secs()).await {
        Ok((out, chips, st)) => Json(json!({"ok": true, "game": game, "bet": bet, "payout": out.payout, "chips": chips, "result": out.result, "streak": st})).into_response(),
        Err(r) => r.response(),
    }
}

pub(crate) fn parse_duel(bytes: &[u8]) -> Result<(String, String, i64, String, Option<String>), String> {
    let o = obj(bytes, &["action", "game", "bet", "id", "move"])?;
    let action = cities::str_field(&o, "action", &["open", "join", "cancel"])?.to_string();
    let mv = match o.get("move") {
        None | Some(Value::Null) => None,
        Some(_) => Some(cities::str_field(&o, "move", &RPS)?.to_string()),
    };
    if action == "open" {
        let game = cities::str_field(&o, "game", &DUEL_GAMES)?.to_string();
        let bet = cities::int_field(&o, "bet", MIN_BET, MAX_BET)?;
        let mv = if game == "rps" { mv } else { None };
        return Ok((action, game, bet, String::new(), mv));
    }
    let id = o.get("id").and_then(Value::as_str).filter(|s| cities::is_uuid(s)).ok_or("id must be a duel's id")?.to_string();
    Ok((action, "highcard".into(), 0, id, mv))
}

async fn get_duels(State(st): State<crate::AppState>, req: Request) -> Response {
    let c = cities::caller(&req);
    match duels(&st.pool, &c.user_id, cities::now_secs()).await {
        Ok(v) => Json(v).into_response(),
        Err(r) => r.response(),
    }
}

async fn post_duel(State(st): State<crate::AppState>, req: Request) -> Response {
    let c = cities::caller(&req);
    let bytes = match cities::read_body(req).await {
        Ok(b) => b,
        Err(r) => return r.response(),
    };
    let (action, game, bet, id, mv) = match parse_duel(&bytes) {
        Ok(v) => v,
        Err(m) => return crate::err(StatusCode::UNPROCESSABLE_ENTITY, &m),
    };
    match duel_move(&st.pool, &c.user_id, &action, &game, bet, &id, mv.as_deref(), cities::now_secs()).await {
        Ok(v) => Json(v).into_response(),
        Err(r) => r.response(),
    }
}

async fn post_blackjack(State(st): State<crate::AppState>, req: Request) -> Response {
    let c = cities::caller(&req);
    let bytes = match cities::read_body(req).await {
        Ok(b) => b,
        Err(r) => return r.response(),
    };
    let parsed = obj(&bytes, &["action", "bet"]).and_then(|o| {
        let action = cities::str_field(&o, "action", &["deal", "hit", "stand", "double"])?.to_string();
        let bet = if action == "deal" { cities::int_field(&o, "bet", MIN_BET, MAX_BET)? } else { 0 };
        Ok((action, bet))
    });
    let (action, bet) = match parsed {
        Ok(v) => v,
        Err(m) => return crate::err(StatusCode::UNPROCESSABLE_ENTITY, &m),
    };
    match blackjack_move(&st.pool, &c.user_id, &action, bet, cities::now_secs()).await {
        Ok(v) => Json(v).into_response(),
        Err(r) => r.response(),
    }
}

/// Only this group's routes; main.rs puts them behind `require_device`.
pub fn routes() -> Router<crate::AppState> {
    Router::new()
        .route("/v1/casino/me", get(get_me))
        .route("/v1/casino/cage", post(post_cage))
        .route("/v1/casino/play", post(post_play))
        .route("/v1/casino/blackjack", post(post_blackjack))
        .route("/v1/casino/duels", get(get_duels))
        .route("/v1/casino/duel", post(post_duel))
}

#[cfg(test)]
mod tests;
