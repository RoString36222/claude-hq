use super::*;
use rand::{rngs::StdRng, Rng, SeedableRng};
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};

const A: &str = "aaaaaaaa-0000-4000-8000-000000000001";
const B: &str = "bbbbbbbb-0000-4000-8000-000000000002";
const C: &str = "cccccccc-0000-4000-8000-000000000003";
const GONE: &str = "dddddddd-0000-4000-8000-000000000004";

/// A file-backed temp database (WAL, 4 connections) that deletes itself.
struct Db {
    pool: SqlitePool,
    path: std::path::PathBuf,
}

impl Drop for Db {
    fn drop(&mut self) {
        for ext in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{ext}", self.path.display()));
        }
    }
}

async fn db() -> Db {
    let path = std::env::temp_dir().join(format!("cities-test-{}.db", uuid::Uuid::new_v4().simple()));
    let opts = SqliteConnectOptions::new()
        .filename(&path)
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .busy_timeout(std::time::Duration::from_secs(10))
        .foreign_keys(true);
    let pool = SqlitePoolOptions::new().max_connections(4).connect_with(opts).await.unwrap();
    crate::db::migrate(&pool).await.unwrap();
    for (i, (id, active)) in [(A, 1), (B, 1), (C, 1), (GONE, 0)].iter().enumerate() {
        sqlx::query(
            "INSERT INTO users (id, github_id, handle, display_name, avatar_url, trainer_name, is_active, created_at)
             VALUES (?1, ?2, ?3, '', '', '', ?4, datetime('now'))",
        )
        .bind(id)
        .bind(i as i64 + 1)
        .bind(format!("h{i}"))
        .bind(active)
        .execute(&pool)
        .await
        .unwrap();
    }
    Db { pool, path }
}

/// 2026-10-19 12:00:00 UTC.
const NOW: i64 = 1_792_411_200;

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

async fn seen(p: &SqlitePool, uid: &str, at: i64) {
    sqlx::query(
        "INSERT INTO devices (id, user_id, token_hash, label, created_at, last_seen_at, revoked)
         VALUES (?1, ?2, ?3, 'x', datetime(?4, 'unixepoch'), datetime(?4, 'unixepoch'), 0)",
    )
    .bind(uuid::Uuid::new_v4().to_string())
    .bind(uid)
    .bind(uuid::Uuid::new_v4().to_string())
    .bind(at)
    .execute(p)
    .await
    .unwrap();
}

async fn set_coins(p: &SqlitePool, uid: &str, n: i64) {
    sqlx::query(
        "INSERT INTO poke_balances (id, user_id, item, qty) VALUES (?1, ?2, 'coins', ?3)
         ON CONFLICT (user_id, item) DO UPDATE SET qty = excluded.qty",
    )
    .bind(uuid::Uuid::new_v4().to_string())
    .bind(uid)
    .bind(n)
    .execute(p)
    .await
    .unwrap();
}

async fn coins(p: &SqlitePool, uid: &str) -> i64 {
    held(&mut p.acquire().await.unwrap(), uid, "coins").await.unwrap()
}

async fn treasury(p: &SqlitePool, owner: &str) -> i64 {
    sqlx::query_scalar("SELECT treasury FROM city WHERE owner = ?1").bind(owner).fetch_optional(p).await.unwrap().unwrap_or(0)
}

/// Fund a treasury through the ledger, as an op the property test can't reach.
async fn fund(p: &SqlitePool, owner: &str, n: i64) {
    let mut conn = p.acquire().await.unwrap();
    ensure_city(&mut conn, owner, NOW).await.unwrap();
    post_entry(&mut conn, owner, "tax", n, "test", NOW).await.unwrap();
}

/// The invariant: for every city, the ledger sums to the treasury and its
/// last row's balance_after is the treasury.
async fn assert_ledgers_balance(p: &SqlitePool) {
    let rows: Vec<(String, i64, i64, Option<i64>)> = sqlx::query_as(
        "SELECT c.owner, c.treasury,
                (SELECT COALESCE(SUM(amount), 0) FROM city_ledger l WHERE l.owner = c.owner),
                (SELECT balance_after FROM city_ledger l WHERE l.owner = c.owner ORDER BY id DESC LIMIT 1)
           FROM city c",
    )
    .fetch_all(p)
    .await
    .unwrap();
    for (owner, t, sum, last) in rows {
        assert!(t >= 0, "{owner}: {t}");
        assert_eq!(t, sum, "{owner}: treasury {t}, ledger sums to {sum}");
        assert_eq!(last.unwrap_or(0), t, "{owner}: last balance_after");
    }
}

// ------------------------------------------------------------- tiers --

#[test]
fn the_tier_comes_from_the_xp_thresholds() {
    let t = SEED_TIERS;
    for (xp, tier) in [(0, 1), (1_999, 1), (2_000, 2), (9_999, 2), (10_000, 3), (40_000, 4), (119_999, 4), (120_000, 5), (9_000_000, 5)] {
        assert_eq!(tier_of(xp, &t), tier, "{xp} XP");
    }
    assert_eq!(grow_of(0, 1, &t), 0);
    assert_eq!(grow_of(1_000, 1, &t), 500);
    assert_eq!(grow_of(25_000, 3, &t), 500);
    assert_eq!(grow_of(500_000, 5, &t), 1000);
    assert_eq!(population(1, 0, &t), 50);
    assert_eq!(population(1, 500, &t), 125);
    assert_eq!(population(5, 1000, &t), 2_000);
}

#[test]
fn population_grows_smoothly_across_tier_boundaries() {
    let t = SEED_TIERS;
    let pop = |xp: i64| {
        let tier = tier_of(xp, &t);
        population(tier, grow_of(xp, tier, &t), &t)
    };
    let mut last = pop(0);
    for xp in (0..=130_000).step_by(10) {
        let p = pop(xp);
        assert!(p >= last && p - last <= 1, "{xp}: {last} -> {p}");
        last = p;
    }
    assert_eq!(pop(130_000), 2_000);
}

#[tokio::test]
async fn the_city_tier_reads_the_owners_xp_and_the_table() {
    let d = db().await;
    prompts(&d.pool, A, 200).await; // 2,000 XP
    let s = city_state(&d.pool, A, NOW).await.unwrap().unwrap();
    assert_eq!((s.tier, s.xp, s.grow, s.population), (2, 2_000, 0, 200));
    assert_eq!(s.tier_xp, [0, 2_000, 10_000, 40_000, 120_000]);
    assert_eq!(s.world, format!("user:{A}@2"));
    assert_eq!((s.privacy.as_str(), s.treasury, s.tax_pm), ("arena", 0, TAX_PM));
    // Retuning the table moves the city without a deploy.
    sqlx::query("UPDATE city_tiers SET xp = 2001 WHERE tier = 2").execute(&d.pool).await.unwrap();
    assert_eq!(city_state(&d.pool, A, NOW).await.unwrap().unwrap().tier, 1);
    // No such user, or not an active one: no city.
    assert!(city_state(&d.pool, GONE, NOW).await.unwrap().is_none());
    let commons = city_state(&d.pool, COMMONS, NOW).await.unwrap().unwrap();
    assert_eq!((commons.tier, commons.world.as_str(), commons.name.as_str()), (5, "claude-hq@2", "The Commons"));
}

// ----------------------------------------------------------- accrual --

#[test]
fn accrual_pays_at_most_a_day_past_the_owner_last_seen() {
    let rate = 3 * MICRO; // 3 coins an hour
    // An hour, owner around: 3 coins less the levy, the rest carried.
    let a = accrue_pure(rate, NOW - 3600, NOW, NOW, 0);
    assert_eq!(a.owner_coins * MICRO + a.owner_carry + a.levy_micro, 3 * MICRO);
    // Three days since the last accrual, owner gone as long: only 24 h is paid.
    let a = accrue_pure(rate, NOW - 3 * 86_400, NOW - 3 * 86_400, NOW, 0);
    assert_eq!(a.owner_coins * MICRO + a.owner_carry + a.levy_micro, 72 * MICRO);
    assert_eq!(a.last, NOW);
    // Owner around, but the server was down three days: still a day at most.
    let b = accrue_pure(rate, NOW - 3 * 86_400, NOW, NOW, 0);
    assert_eq!(b, a);
    // Owner gone 5 days, accrued 2 days ago: nothing is owed, the clock moves on.
    let c = accrue_pure(rate, NOW - 2 * 86_400, NOW - 5 * 86_400, NOW, 7);
    assert_eq!((c.owner_coins, c.owner_carry, c.levy_micro, c.last), (0, 7, 0, NOW));
}

#[test]
fn the_levy_is_two_percent_of_every_accrual() {
    let a = accrue_pure(100 * MICRO, 0, 0, 3600, 0);
    assert_eq!((a.owner_coins, a.owner_carry, a.levy_micro), (98, 0, 2 * MICRO));
    // Fractions carry rather than vanish.
    let a = accrue_pure(MICRO, 0, 0, 3600, 990_000);
    assert_eq!((a.owner_coins, a.owner_carry, a.levy_micro), (1, 970_000, 20_000));
}

#[tokio::test]
async fn an_absent_owner_earns_a_day_and_the_commons_its_levy() {
    let d = db().await;
    seen(&d.pool, A, NOW - 3 * 86_400).await;
    {
        let mut conn = d.pool.acquire().await.unwrap();
        ensure_city(&mut conn, A, NOW - 3 * 86_400).await.unwrap();
    }
    let s = city_state(&d.pool, A, NOW).await.unwrap().unwrap();
    // Tier 1, population 50, tax 50 per mille, x1: 2.5 coins an hour, 60 a day.
    let rate = 50 * TAX_PM * market::district_pm(&s.specialty, 1);
    let gross = rate * 24;
    assert_eq!(s.treasury, (gross - gross * LEVY_PCT / 100) / MICRO);
    assert_eq!(treasury(&d.pool, COMMONS).await, gross * LEVY_PCT / 100 / MICRO);
    // Reading again pays nothing more, and neither does the hourly job.
    assert_eq!(city_state(&d.pool, A, NOW).await.unwrap().unwrap().treasury, s.treasury);
    hourly(&d.pool, NOW + 3600).await.unwrap();
    assert_eq!(treasury(&d.pool, A).await, s.treasury);
    // Back online: an hour later the owner earns again.
    seen(&d.pool, A, NOW + 2 * 3600).await;
    hourly(&d.pool, NOW + 2 * 3600).await.unwrap();
    assert!(treasury(&d.pool, A).await > s.treasury);
    assert_ledgers_balance(&d.pool).await;
}

// ------------------------------------------------------------- money --

#[tokio::test]
async fn transfers_cost_ten_percent_each_way_to_the_commons() {
    let d = db().await;
    set_coins(&d.pool, A, 30).await;
    transfer(&d.pool, A, 20, true, NOW).await.unwrap();
    assert_eq!((coins(&d.pool, A).await, treasury(&d.pool, A).await, treasury(&d.pool, COMMONS).await), (10, 18, 2));
    transfer(&d.pool, A, 15, false, NOW).await.unwrap();
    // 15 leaves the treasury, the fee rounds up to 2, 13 arrive.
    assert_eq!((coins(&d.pool, A).await, treasury(&d.pool, A).await, treasury(&d.pool, COMMONS).await), (23, 3, 4));
    assert_eq!(fee_of(1), 1);
    assert_eq!(fee_of(10), 1);
    assert_eq!(fee_of(11), 2);
    assert_eq!(fee_of(100), 10);

    // Refusals change nothing: too little, too much, a full wallet.
    for (amount, dir_in, code) in [(1, true, StatusCode::UNPROCESSABLE_ENTITY), (24, true, StatusCode::CONFLICT), (4, false, StatusCode::CONFLICT)] {
        match transfer(&d.pool, A, amount, dir_in, NOW).await {
            Err(Refuse::Say(c, _)) => assert_eq!(c, code, "{amount} {dir_in}"),
            other => panic!("{amount} {dir_in}: {other:?}"),
        }
    }
    fund(&d.pool, A, 100).await;
    set_coins(&d.pool, A, 25).await;
    match transfer(&d.pool, A, 10, false, NOW).await {
        Err(Refuse::Say(StatusCode::CONFLICT, m)) => assert_eq!(m, "wallet full"),
        other => panic!("{other:?}"),
    }
    assert_eq!((coins(&d.pool, A).await, treasury(&d.pool, A).await), (25, 103));
    assert_ledgers_balance(&d.pool).await;
}

#[tokio::test]
async fn a_new_city_lists_every_upgrade_at_level_zero() {
    let d = db().await;
    let s = city_state(&d.pool, A, NOW).await.unwrap().unwrap();
    let keys: Vec<&str> = s.upgrades.keys().map(String::as_str).collect();
    let mut want: Vec<&str> = UPGRADES.iter().map(|u| u.key).collect();
    want.sort();
    assert_eq!(keys, want);
    assert!(s.upgrades.values().all(|&l| l == 0));
    let json = serde_json::to_value(&s).unwrap();
    assert_eq!(json["upgrades"]["depot"], 0);
}

#[tokio::test]
async fn upgrades_cost_their_level_and_respect_tier_and_max() {
    let d = db().await;
    fund(&d.pool, A, 10_000).await;
    build(&d.pool, A, "tax_office", NOW).await.unwrap();
    build(&d.pool, A, "tax_office", NOW).await.unwrap();
    assert_eq!(treasury(&d.pool, A).await, 10_000 - 150 - 600);
    build(&d.pool, A, "tax_office", NOW).await.unwrap();
    assert!(matches!(build(&d.pool, A, "tax_office", NOW).await, Err(Refuse::Say(StatusCode::CONFLICT, _))));
    // The workshop needs tier 2.
    assert!(matches!(build(&d.pool, A, "workshop", NOW).await, Err(Refuse::Say(StatusCode::CONFLICT, _))));
    prompts(&d.pool, A, 200).await;
    build(&d.pool, A, "workshop", NOW).await.unwrap();
    let s = city_state(&d.pool, A, NOW).await.unwrap().unwrap();
    assert_eq!(s.upgrades.get("tax_office"), Some(&3));
    assert_eq!(s.upgrades.get("workshop"), Some(&1));
    assert_eq!(s.upgrades.get("depot"), Some(&0));
    assert_eq!(s.treasury, 10_000 - 150 - 600 - 2_400 - 300);
    // Too poor.
    assert!(matches!(build(&d.pool, B, "tax_office", NOW).await, Err(Refuse::Say(StatusCode::CONFLICT, _))));
    assert_eq!(tax_mult_pm(1000, 3), 1300);
    assert_ledgers_balance(&d.pool).await;
}

#[tokio::test]
async fn fares_go_from_the_rider_to_the_city() {
    let d = db().await;
    set_coins(&d.pool, B, 10).await;
    // A tier-1 city has no buses, and no tram before tier 4; fast travel is 1.
    assert!(matches!(fare(&d.pool, A, B, "bus", NOW).await, Err(Refuse::Say(StatusCode::CONFLICT, _))));
    assert_eq!(fare(&d.pool, A, B, "fast", NOW).await.unwrap(), 1);
    prompts(&d.pool, A, 200).await;
    assert_eq!(fare(&d.pool, A, B, "bus", NOW).await.unwrap(), 2);
    assert!(matches!(fare(&d.pool, A, B, "tram", NOW).await, Err(Refuse::Say(StatusCode::CONFLICT, _))));
    assert_eq!(fare(&d.pool, COMMONS, B, "tram", NOW).await.unwrap(), 2);
    assert_eq!((coins(&d.pool, B).await, treasury(&d.pool, A).await, treasury(&d.pool, COMMONS).await), (5, 3, 2));
    // The owner rides free.
    set_coins(&d.pool, A, 1).await;
    assert_eq!(fare(&d.pool, A, A, "bus", NOW).await.unwrap(), 0);
    assert_eq!(coins(&d.pool, A).await, 1);
    set_coins(&d.pool, B, 1).await;
    assert!(matches!(fare(&d.pool, A, B, "bus", NOW).await, Err(Refuse::Say(StatusCode::CONFLICT, _))));
    assert_ledgers_balance(&d.pool).await;
}

#[tokio::test]
async fn a_park_pass_is_bought_once_a_day() {
    let d = db().await;
    set_coins(&d.pool, B, 25).await;
    // Any tier sells one; the price goes to that city's treasury, and the pass is recorded.
    assert_eq!(fare(&d.pool, A, B, "park", NOW).await.unwrap(), 10);
    assert_eq!((coins(&d.pool, B).await, treasury(&d.pool, A).await), (15, 10));
    let mut c = d.pool.acquire().await.unwrap();
    assert!(has_pass(&mut c, A, B, NOW).await.unwrap());
    // Bought again the same UTC day (a retry, another device): still good, nothing charged.
    assert_eq!(fare(&d.pool, A, B, "park", NOW + 3600).await.unwrap(), 0);
    assert_eq!(coins(&d.pool, B).await, 15);
    // It is that city's pass only, and it ends with the day.
    assert!(!has_pass(&mut c, COMMONS, B, NOW).await.unwrap());
    let tomorrow = (NOW.div_euclid(86_400) + 1) * 86_400;
    assert!(!has_pass(&mut c, A, B, tomorrow).await.unwrap());
    assert_eq!(fare(&d.pool, A, B, "park", tomorrow).await.unwrap(), 10);
    // An owner walks into their own park free, and holds a pass without buying one.
    assert!(has_pass(&mut c, A, A, NOW).await.unwrap());
    assert_eq!(fare(&d.pool, A, A, "park", NOW).await.unwrap(), 0);
    // Too few coins: refused, nothing written, no pass.
    set_coins(&d.pool, B, 9).await;
    assert!(matches!(fare(&d.pool, COMMONS, B, "park", NOW).await, Err(Refuse::Say(StatusCode::CONFLICT, _))));
    assert!(!has_pass(&mut c, COMMONS, B, NOW).await.unwrap());
    assert_eq!(coins(&d.pool, B).await, 9);
    drop(c);
    assert_ledgers_balance(&d.pool).await;
}

#[tokio::test]
async fn the_ledger_is_append_only() {
    let d = db().await;
    fund(&d.pool, A, 5).await;
    assert!(sqlx::query("UPDATE city_ledger SET amount = 500").execute(&d.pool).await.is_err());
    assert!(sqlx::query("DELETE FROM city_ledger").execute(&d.pool).await.is_err());
    assert_ledgers_balance(&d.pool).await;
}

/// Property: whatever happens, in whatever order, every ledger sums to its
/// treasury. Random sequences of every operation, refusals included.
#[tokio::test]
async fn the_ledger_always_sums_to_the_treasury() {
    let d = db().await;
    let p = &d.pool;
    prompts(p, A, 1_200).await; // tier 3
    prompts(p, B, 250).await; // tier 2
    for (i, u) in [A, B, C].iter().enumerate() {
        seen(p, u, NOW + i as i64 * 7_200).await;
    }
    let users = [A, B, C];
    let cities_ = [A, B, C, COMMONS];
    for seed in 0..6u64 {
        let mut rng = StdRng::seed_from_u64(seed);
        let mut now = NOW + seed as i64 * 400_000;
        for u in users {
            set_coins(p, u, 30).await;
        }
        for _ in 0..60 {
            now += rng.gen_range(0..5_000);
            let who = users[rng.gen_range(0..3)];
            let city = cities_[rng.gen_range(0..4)];
            match rng.gen_range(0..7) {
                0 => {
                    city_state(p, city, now).await.unwrap();
                }
                1 => {
                    let _ = transfer(p, who, rng.gen_range(1..40), rng.gen_bool(0.5), now).await;
                }
                2 => {
                    let _ = build(p, who, UPGRADES[rng.gen_range(0..UPGRADES.len())].key, now).await;
                }
                3 => {
                    let _ = fare(p, city, who, ["bus", "tram", "fast"][rng.gen_range(0..3)], now).await;
                }
                4 => {
                    let g = market::GOODS[rng.gen_range(0..market::GOODS.len())].key;
                    let _ = market::trade(p, city, who, g, rng.gen_range(1..8), rng.gen_bool(0.6), now).await;
                }
                5 => hourly(p, now).await.unwrap(),
                _ => {
                    if rng.gen_bool(0.3) {
                        set_coins(p, who, rng.gen_range(0..31)).await;
                    }
                }
            }
            assert_ledgers_balance(p).await;
        }
    }
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM city_ledger").fetch_one(p).await.unwrap();
    assert!(n > 50, "the sequence should have moved money ({n} ledger rows)");
}

// -------------------------------------------------------------- market --

#[tokio::test]
async fn a_trade_moves_coins_through_the_treasury() {
    let d = db().await;
    let spec = {
        let mut conn = d.pool.acquire().await.unwrap();
        ensure_city(&mut conn, A, NOW).await.unwrap().unwrap().specialty
    };
    let g = market::good(&spec).unwrap();
    set_coins(&d.pool, B, 30).await;
    let line = market::trade(&d.pool, A, B, g.key, 2, true, NOW).await.unwrap();
    let cost = 2 * g.base;
    assert_eq!((coins(&d.pool, B).await, treasury(&d.pool, A).await), (30 - cost, cost));
    assert_eq!(serde_json::to_value(&line).unwrap()["held"], 2);
    market::trade(&d.pool, A, B, g.key, 1, false, NOW).await.unwrap();
    assert_eq!((coins(&d.pool, B).await, treasury(&d.pool, A).await), (30 - cost + g.base, cost - g.base));
    // The owner can't trade at home; nobody sells what they don't hold.
    assert!(matches!(market::trade(&d.pool, A, A, g.key, 1, true, NOW).await, Err(Refuse::Say(StatusCode::FORBIDDEN, _))));
    assert!(matches!(market::trade(&d.pool, A, B, g.key, 5, false, NOW).await, Err(Refuse::Say(StatusCode::CONFLICT, _))));
    // A poor city can't buy.
    let other = market::GOODS.iter().find(|x| x.key != g.key).unwrap();
    {
        let mut conn = d.pool.acquire().await.unwrap();
        assert!(wallet_credit(&mut conn, C, &format!("mkt:{}", other.key), 10, 999).await.unwrap());
    }
    set_coins(&d.pool, C, 0).await;
    match market::trade(&d.pool, A, C, other.key, 10, false, NOW).await {
        Err(Refuse::Say(StatusCode::CONFLICT, m)) => assert_eq!(m, "this city can't afford that"),
        other => panic!("{other:?}"),
    }
    assert_ledgers_balance(&d.pool).await;
}

#[tokio::test]
async fn markets_tick_hourly_and_catch_up_lazily() {
    let d = db().await;
    let lines = market::lines(&d.pool, A, B, NOW).await.unwrap().unwrap();
    assert_eq!(lines.len(), market::GOODS.len());
    let snap = snapshot(&d.pool, A, NOW).await.unwrap().unwrap();
    // Three hours later the lazy read replays three ticks of the pure model.
    let mut want = market::opening(&snap.row.specialty);
    let e = market::Economy::of(&snap);
    for _ in 0..3 {
        market::tick(&mut want, &e);
    }
    let got = market::catch_up(&d.pool, &snap, NOW + 3 * 3600 + 59).await.unwrap();
    assert_eq!(got, want);
    // Within the same hour nothing moves.
    assert_eq!(market::catch_up(&d.pool, &snap, NOW + 3 * 3600 + 3000).await.unwrap(), want);
}

// ---------------------------------------------------------- visibility --

#[test]
fn visibility_follows_the_privacy_mode() {
    for (privacy, in_arena, crew, want) in [
        ("arena", true, false, true),
        ("arena", false, false, false),
        ("friends", true, false, false),
        ("friends", true, true, true),
        ("closed", true, true, false),
        ("nonsense", true, true, false),
    ] {
        assert_eq!(visible(privacy, false, in_arena, crew), want, "{privacy} {in_arena} {crew}");
        assert!(visible(privacy, true, in_arena, crew), "the owner always sees it");
    }
}

#[tokio::test]
async fn can_view_checks_arena_crew_and_closed() {
    let d = db().await;
    let p = &d.pool;
    // Default (no city row yet): arena, so any active member.
    assert!(can_view(p, A, B).await);
    assert!(can_view(p, A, A).await);
    assert!(!can_view(p, A, GONE).await, "an inactive account is not in the arena");
    assert!(!can_view(p, GONE, A).await, "an inactive owner has no city");
    assert!(!can_view(p, "eeeeeeee-0000-4000-8000-000000000005", A).await);
    assert!(can_view(p, COMMONS, C).await);

    sqlx::query("INSERT INTO crews (id, name, tag, color, code, owner_id) VALUES ('k1', 'K', 'K', '#000000', 'CODE1', ?1)")
        .bind(A)
        .execute(p)
        .await
        .unwrap();
    for u in [A, B] {
        sqlx::query("INSERT INTO crew_members (user_id, crew_id) VALUES (?1, 'k1')").bind(u).execute(p).await.unwrap();
    }
    {
        let mut conn = p.acquire().await.unwrap();
        ensure_city(&mut conn, A, NOW).await.unwrap();
    }
    sqlx::query("UPDATE city SET privacy = 'friends' WHERE owner = ?1").bind(A).execute(p).await.unwrap();
    assert!(can_view(p, A, B).await, "a crewmate");
    assert!(!can_view(p, A, C).await, "not in the crew");
    sqlx::query("UPDATE city SET privacy = 'closed' WHERE owner = ?1").bind(A).execute(p).await.unwrap();
    assert!(!can_view(p, A, B).await);
    assert!(can_view(p, A, A).await);
}

#[test]
fn only_well_formed_owners_reach_a_query() {
    assert_eq!(owner_param("me", A).as_deref(), Some(A));
    assert_eq!(owner_param("commons", A).as_deref(), Some(COMMONS));
    assert_eq!(owner_param(B, A).as_deref(), Some(B));
    for bad in ["", "ME", "../etc", "AAAAAAAA-0000-4000-8000-000000000001", "aaaaaaaa-0000-4000-8000-00000000000", "aaaaaaaa_0000-4000-8000-000000000001", "x' OR 1=1 --"] {
        assert_eq!(owner_param(bad, A), None, "{bad}");
    }
}

#[test]
fn bodies_take_only_their_fields() {
    assert!(body_obj(br#"{"amount": 5, "dir": "in"}"#, &["amount", "dir"]).is_ok());
    assert!(body_obj(br#"{"amount": 5}"#, &["amount", "dir"]).is_err());
    assert!(body_obj(br#"{"amount": 5, "dir": "in", "x": 1}"#, &["amount", "dir"]).is_err());
    assert!(body_obj(b"[]", &["amount"]).is_err());
    let o = body_obj(br#"{"amount": 5.5, "dir": "sideways"}"#, &["amount", "dir"]).unwrap();
    assert!(int_field(&o, "amount", 1, 10).is_err());
    assert!(str_field(&o, "dir", &["in", "out"]).is_err());
}

fn as_caller(uid: &str) -> Caller {
    Caller {
        user_id: uid.into(),
        device_id: String::new(),
        handle: String::new(),
        display_name: String::new(),
        trainer_name: String::new(),
        avatar_url: String::new(),
        device_label: String::new(),
    }
}

fn code_of(r: Result<String, Refuse>) -> StatusCode {
    match r {
        Ok(_) => StatusCode::OK,
        Err(Refuse::Say(c, _)) => c,
        Err(Refuse::Db(e)) => panic!("{e}"),
    }
}

#[tokio::test]
async fn a_hidden_city_is_a_404_and_only_its_owner_may_change_it() {
    let d = db().await;
    let p = &d.pool;
    {
        let mut conn = p.acquire().await.unwrap();
        ensure_city(&mut conn, A, NOW).await.unwrap();
    }
    assert_eq!(code_of(visible_owner(p, A, &as_caller(B)).await), StatusCode::OK);
    assert_eq!(code_of(own_city(p, A, &as_caller(B)).await), StatusCode::FORBIDDEN);
    assert_eq!(code_of(own_city(p, "me", &as_caller(A)).await), StatusCode::OK);
    assert_eq!(code_of(own_city(p, COMMONS, &as_caller(A)).await), StatusCode::FORBIDDEN, "the Commons has no owner");
    assert_eq!(code_of(visible_owner(p, "../x", &as_caller(B)).await), StatusCode::BAD_REQUEST);
    sqlx::query("UPDATE city SET privacy = 'closed' WHERE owner = ?1").bind(A).execute(p).await.unwrap();
    // Hidden and missing read the same.
    assert_eq!(code_of(visible_owner(p, A, &as_caller(B)).await), StatusCode::NOT_FOUND);
    assert_eq!(code_of(visible_owner(p, GONE, &as_caller(B)).await), StatusCode::NOT_FOUND);
    assert_eq!(code_of(own_city(p, A, &as_caller(A)).await), StatusCode::OK);
}

#[test]
fn the_routes_register_without_conflicts() {
    let _: Router<AppState> = routes().merge(market::routes());
}
