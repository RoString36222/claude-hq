use super::*;
use rand::{rngs::StdRng, SeedableRng};
use sqlx::sqlite::SqlitePoolOptions;

const A: &str = "aaaaaaaa-0000-4000-8000-000000000001";
const NOW: i64 = 1_792_411_200;

async fn pool() -> SqlitePool {
    let pool = SqlitePoolOptions::new().max_connections(1).connect("sqlite::memory:").await.unwrap();
    crate::db::migrate(&pool).await.unwrap();
    sqlx::query(
        "INSERT INTO users (id, github_id, handle, display_name, avatar_url, trainer_name, is_active, created_at)
         VALUES (?1, 1, 'h', '', '', '', 1, datetime('now'))",
    )
    .bind(A)
    .execute(&pool)
    .await
    .unwrap();
    pool
}

async fn give(pool: &SqlitePool, item: &str, n: i64) {
    let mut c = pool.acquire().await.unwrap();
    assert!(wallet_credit(&mut c, A, item, n, i64::MAX).await.unwrap());
}

async fn bal(pool: &SqlitePool, item: &str) -> i64 {
    let mut c = pool.acquire().await.unwrap();
    held(&mut c, A, item).await.unwrap()
}

// ------------------------------------------------------------- the tables --

#[test]
fn every_game_keeps_a_small_house_edge() {
    for g in GAMES {
        let r = rtp(g);
        assert!((0.93..0.98).contains(&r), "{g}: return to player {r}");
    }
}

#[test]
fn played_games_pay_what_the_tables_say() {
    // many seeded rounds of each: the money returned matches the exact return to player
    let mut rng = StdRng::seed_from_u64(7);
    for g in GAMES {
        let pick = match g {
            "roulette" => Some("red"),
            "horses" => Some("2"),
            "rocket" => Some("150"),
            "dice" => Some("over"),
            "coin" => Some("heads"),
            _ => None,
        };
        let n = 400_000;
        let back: i64 = (0..n).map(|_| play(g, 100, pick, &mut rng).payout).sum();
        let got = back as f64 / (100.0 * n as f64);
        let want = match g {
            "horses" => HORSES[2].1 as f64 / 1000.0 * HORSES[2].2 as f64 / 10.0,
            "rocket" => 0.96,
            "dice" => 15.0 / 36.0 * 2.3,
            _ => rtp(g),
        };
        assert!((got - want).abs() < 0.03, "{g}: returned {got}, want {want}");
    }
}

#[test]
fn a_scratch_card_shows_its_prize_three_times_and_nothing_else_three_times() {
    let mut rng = StdRng::seed_from_u64(3);
    for tier in 0..=SCRATCH.len() {
        for _ in 0..200 {
            let g = scratch_grid(tier, &mut rng);
            assert_eq!(g.len(), 9);
            for s in SCRATCH.iter().map(|s| s.0).chain([SCRATCH_DUD]) {
                let k = g.iter().filter(|&&c| c == s).count();
                if tier < SCRATCH.len() && s == SCRATCH[tier].0 {
                    assert_eq!(k, 3, "{s}");
                } else {
                    assert!(k <= 2, "{s} x{k} on tier {tier}");
                }
            }
        }
    }
}

#[test]
fn roulette_pays_the_standard_odds() {
    assert_eq!(roulette_pays("n:17", 17), 36);
    assert_eq!(roulette_pays("n:0", 0), 36);
    assert_eq!(roulette_pays("red", 0), 0);
    assert_eq!(roulette_pays("red", 1), 2);
    assert_eq!(roulette_pays("black", 2), 2);
    assert_eq!(roulette_pays("dozen2", 13), 3);
    assert_eq!(roulette_pays("col3", 36), 3);
    assert_eq!(roulette_pays("high", 18), 0);
    assert_eq!((1..=36).filter(|&n| red(n)).count(), 18);
}

#[test]
fn picks_are_checked_against_the_game() {
    assert_eq!(check_pick("roulette", Some(&json!("n:36"))), Ok(Some("n:36".into())));
    for bad in [json!("n:37"), json!("n:07"), json!("purple"), json!(3)] {
        assert!(check_pick("roulette", Some(&bad)).is_err(), "{bad}");
    }
    assert!(check_pick("horses", Some(&json!(6))).is_err());
    assert!(check_pick("rocket", Some(&json!(100))).is_err());
    assert!(check_pick("rocket", Some(&json!(10_001))).is_err());
    assert_eq!(check_pick("slots", Some(&json!("anything"))), Ok(None));
    assert!(check_pick("coin", None).is_err());
    assert!(parse_play(br#"{"game":"slots","bet":1}"#).is_ok());
    for bad in [&br#"{"game":"slots","bet":0}"#[..], br#"{"game":"slots","bet":501}"#, br#"{"game":"poker","bet":5}"#, br#"{"game":"slots","bet":5,"payout":9}"#, br#"[]"#] {
        assert!(parse_play(bad).is_err(), "{}", String::from_utf8_lossy(bad));
    }
}

#[test]
fn blackjack_counts_like_a_casino() {
    // ace = 0, ten = 9, king = 12 (any suit: + 13k)
    assert_eq!(total(&[0, 12]), (21, true));
    assert!(blackjack(&[13, 22]));
    assert_eq!(total(&[0, 0, 8]), (21, true));      // A A 9
    assert_eq!(total(&[0, 8, 9]), (20, false));     // A 9 10: the ace drops to 1
    assert_eq!(total(&[12, 11, 1]), (22, false));
    assert_eq!(settle(&[0, 12], &[9, 8], 10), (25, "blackjack"));
    assert_eq!(settle(&[0, 12], &[0, 11], 10), (10, "push"));
    assert_eq!(settle(&[9, 8], &[0, 11], 10), (0, "dealer_blackjack"));
    assert_eq!(settle(&[9, 8, 5], &[9, 8], 10), (0, "bust"));
    assert_eq!(settle(&[9, 8], &[9, 5, 8], 10), (20, "dealer_bust"));
    assert_eq!(settle(&[9, 8], &[9, 7], 10), (20, "win"));
    assert_eq!(settle(&[9, 7], &[9, 7], 10), (10, "push"));
}

// ------------------------------------------------------------- the money --

#[tokio::test]
async fn the_cage_swaps_coins_and_chips_and_respects_the_wallet() {
    let p = pool().await;
    give(&p, "coins", 20).await;
    assert_eq!(cage(&p, A, "buy", 5).await.unwrap(), (50, 15));
    assert!(matches!(cage(&p, A, "buy", 16).await, Err(Refuse::Say(StatusCode::PAYMENT_REQUIRED, _))));
    assert!(matches!(cage(&p, A, "cash", 15).await, Err(Refuse::Say(StatusCode::UNPROCESSABLE_ENTITY, _))));
    assert_eq!(cage(&p, A, "cash", 30).await.unwrap(), (20, 18));
    // the wallet tops out at COIN_CAP: a win too big for it stays on the rack, nothing is lost
    give(&p, "chips", 1000).await;
    assert!(matches!(cage(&p, A, "cash", 200).await, Err(Refuse::Say(StatusCode::CONFLICT, _))));
    assert_eq!((bal(&p, "chips").await, bal(&p, "coins").await), (1020, 18));
    assert_eq!(cage(&p, A, "cash", 120).await.unwrap(), (900, 30));
}

#[tokio::test]
async fn a_play_takes_the_stake_and_pays_what_it_drew() {
    let p = pool().await;
    give(&p, "chips", 300).await;
    let mut spent = 0;
    let mut back = 0;
    for i in 0..5 {
        let (out, chips, _) = play_once(&p, A, "coin", 10, Some("heads"), NOW + i * 10).await.unwrap();
        spent += 10;
        back += out.payout;
        assert!(out.payout == 0 || out.payout == 19, "{out:?}");
        assert_eq!(chips, 300 - spent + back);
    }
    let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM casino_play").fetch_one(&p).await.unwrap();
    assert_eq!(rows, 5);
    // too few chips: refused, nothing taken
    assert!(matches!(play_once(&p, A, "slots", 500, None, NOW + 100).await, Err(Refuse::Say(StatusCode::PAYMENT_REQUIRED, _))));
    assert_eq!(bal(&p, "chips").await, 300 - spent + back);
}

#[tokio::test]
async fn one_game_at_a_time() {
    let p = pool().await;
    give(&p, "chips", 1000).await;
    for _ in 0..RATE_N {
        play_once(&p, A, "dice", 1, Some("over"), NOW).await.unwrap();
    }
    assert!(matches!(play_once(&p, A, "dice", 1, Some("over"), NOW).await, Err(Refuse::Say(StatusCode::TOO_MANY_REQUESTS, _))));
    assert!(play_once(&p, A, "dice", 1, Some("over"), NOW + RATE_SECS + 1).await.is_ok());
}

#[tokio::test]
async fn a_blackjack_hand_is_played_out_and_settled_once() {
    let p = pool().await;
    give(&p, "chips", 10_000).await;
    let mut t = NOW;
    for _ in 0..40 {
        t += 60;
        let before = bal(&p, "chips").await;
        let mut v = blackjack_move(&p, A, "deal", 100, t).await.unwrap();
        // the hole card is face down while the hand is open; a second deal is refused
        if v["done"] == json!(false) {
            assert_eq!(v["hand"]["dealer"][1], json!(-1));
            assert!(matches!(blackjack_move(&p, A, "deal", 100, t).await, Err(Refuse::Say(StatusCode::CONFLICT, _))));
        }
        let mut moves = 0;
        while v["done"] == json!(false) {
            let act = if v["hand"]["ptotal"].as_i64().unwrap() < 15 { "hit" } else { "stand" };
            v = blackjack_move(&p, A, act, 0, t).await.unwrap();
            moves += 1;
            assert!(moves < 12);
        }
        let stake = v["hand"]["bet"].as_i64().unwrap();
        let payout = v["payout"].as_i64().unwrap();
        assert_eq!(bal(&p, "chips").await, before - stake + payout, "{v}");
        assert_eq!(v["hand"]["dealer"].as_array().unwrap().iter().filter(|c| **c == json!(-1)).count(), 0);
        let dt = v["hand"]["dtotal"].as_i64().unwrap();
        let pt = v["hand"]["ptotal"].as_i64().unwrap();
        if pt <= 21 && v["outcome"] != json!("blackjack") && v["outcome"] != json!("dealer_blackjack") {
            assert!(dt >= 17, "{v}");
        }
        assert!(matches!(blackjack_move(&p, A, "stand", 0, t).await, Err(Refuse::Say(StatusCode::CONFLICT, _))));
    }
    let open: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM casino_hand").fetch_one(&p).await.unwrap();
    assert_eq!(open, 0);
}

#[tokio::test]
async fn doubling_takes_a_second_stake_and_ends_the_hand() {
    let p = pool().await;
    give(&p, "chips", 10_000).await;
    let mut t = NOW;
    loop {
        t += 60;
        let v = blackjack_move(&p, A, "deal", 50, t).await.unwrap();
        if v["done"] == json!(true) {
            continue;
        }
        let before = bal(&p, "chips").await;
        let d = blackjack_move(&p, A, "double", 0, t).await.unwrap();
        assert_eq!(d["done"], json!(true));
        assert_eq!(d["hand"]["bet"], json!(100));
        assert_eq!(d["hand"]["player"].as_array().unwrap().len(), 3);
        assert_eq!(bal(&p, "chips").await, before - 50 + d["payout"].as_i64().unwrap());
        break;
    }
}

#[tokio::test]
async fn me_carries_the_tables_the_page_draws() {
    let p = pool().await;
    give(&p, "chips", 77).await;
    let v = me(&p, A, NOW).await.unwrap();
    assert_eq!(v["chips"], json!(77));
    assert_eq!(v["tables"]["wheel"].as_array().unwrap().len(), 50);
    assert_eq!(v["tables"]["plinko"].as_array().unwrap().len(), 13);
    assert_eq!(v["tables"]["horses"].as_array().unwrap().len(), 6);
    assert_eq!(v["stats"]["plays"], json!(0));
    assert_eq!(v["hand"], Value::Null);
}

// ------------------------------------------------------------- duels --

const B: &str = "bbbbbbbb-0000-4000-8000-000000000002";

async fn two() -> SqlitePool {
    let p = pool().await;
    sqlx::query("INSERT INTO users (id, github_id, handle, display_name, avatar_url, trainer_name, is_active, created_at) VALUES (?1, 2, 'bee', '', '', 'Bea', 1, datetime('now'))")
        .bind(B).execute(&p).await.unwrap();
    let mut c = p.acquire().await.unwrap();
    for u in [A, B] {
        assert!(wallet_credit(&mut c, u, "chips", 1000, i64::MAX).await.unwrap());
    }
    p
}
async fn chips_of(p: &SqlitePool, u: &str) -> i64 {
    let mut c = p.acquire().await.unwrap();
    held(&mut c, u, "chips").await.unwrap()
}

#[test]
fn rock_paper_scissors_and_the_prize() {
    assert_eq!(rps_beats("rock", "scissors"), Some(true));
    assert_eq!(rps_beats("rock", "paper"), Some(false));
    assert_eq!(rps_beats("paper", "paper"), None);
    assert_eq!(duel_prize(100), 190);
    let mut rng = StdRng::seed_from_u64(5);
    let wins = (0..20_000).filter(|_| duel_draw("highcard", &mut rng).0).count() as f64 / 20_000.0;
    assert!((wins - 0.5).abs() < 0.02, "{wins}");
}

#[tokio::test]
async fn a_duel_holds_both_stakes_and_pays_the_winner_less_the_rake() {
    let p = two().await;
    for g in ["highcard", "dice", "coin"] {
        let (a0, b0) = (chips_of(&p, A).await, chips_of(&p, B).await);
        let o = duel_move(&p, A, "open", g, 100, "", None, NOW).await.unwrap();
        assert_eq!(chips_of(&p, A).await, a0 - 100);
        let id = o["id"].as_str().unwrap().to_string();
        let open = duels(&p, B, NOW + 5).await.unwrap();
        assert_eq!(open["open"][0]["by"], json!("h"));
        assert_eq!(open["open"][0]["mine"], json!(false));
        let r = duel_move(&p, B, "join", "highcard", 0, &id, None, NOW + 10).await.unwrap();
        assert_eq!(r["game"], json!(g));
        let (a1, b1) = (chips_of(&p, A).await, chips_of(&p, B).await);
        assert_eq!(a1 + b1, a0 + b0 - 10, "{r}");
        assert!(a1 == a0 + 90 || b1 == b0 + 90, "{r}");
        // it is gone: nobody can take it again
        assert!(matches!(duel_move(&p, B, "join", "highcard", 0, &id, None, NOW + 11).await, Err(Refuse::Say(StatusCode::CONFLICT, _))));
        let mine = duels(&p, A, NOW + 12).await.unwrap();
        assert_eq!(mine["mine"][0]["vs"], json!("Bea"));
    }
}

#[tokio::test]
async fn rock_paper_scissors_keeps_moves_hidden_and_a_draw_refunds_both() {
    let p = two().await;
    assert!(duel_move(&p, A, "open", "rps", 50, "", None, NOW).await.is_err());
    let o = duel_move(&p, A, "open", "rps", 50, "", Some("rock"), NOW).await.unwrap();
    let open = duels(&p, B, NOW + 1).await.unwrap();
    assert!(!open["open"][0].to_string().contains("rock"), "{open}");
    let r = duel_move(&p, B, "join", "highcard", 0, o["id"].as_str().unwrap(), Some("rock"), NOW + 2).await.unwrap();
    assert_eq!(r["draw"], json!(true));
    assert_eq!((chips_of(&p, A).await, chips_of(&p, B).await), (1000, 1000));
    let o2 = duel_move(&p, A, "open", "rps", 50, "", Some("paper"), NOW + 3).await.unwrap();
    duel_move(&p, B, "join", "highcard", 0, o2["id"].as_str().unwrap(), Some("scissors"), NOW + 4).await.unwrap();
    assert_eq!((chips_of(&p, A).await, chips_of(&p, B).await), (950, 1045));
}

#[tokio::test]
async fn challenges_are_cancelled_or_expire_with_their_stake_back() {
    let p = two().await;
    let o = duel_move(&p, A, "open", "coin", 200, "", None, NOW).await.unwrap();
    let id = o["id"].as_str().unwrap().to_string();
    assert!(matches!(duel_move(&p, A, "join", "highcard", 0, &id, None, NOW + 1).await, Err(Refuse::Say(StatusCode::CONFLICT, _))));
    assert!(matches!(duel_move(&p, B, "cancel", "highcard", 0, &id, None, NOW + 1).await, Err(Refuse::Say(StatusCode::CONFLICT, _))));
    duel_move(&p, A, "cancel", "highcard", 0, &id, None, NOW + 2).await.unwrap();
    assert_eq!(chips_of(&p, A).await, 1000);
    for i in 0..3 {
        duel_move(&p, A, "open", "dice", 10, "", None, NOW + 10 + i).await.unwrap();
    }
    assert!(matches!(duel_move(&p, A, "open", "dice", 10, "", None, NOW + 20).await, Err(Refuse::Say(StatusCode::CONFLICT, _))));
    assert_eq!(chips_of(&p, A).await, 970);
    let d = duels(&p, B, NOW + 20 + DUEL_TTL).await.unwrap();
    assert_eq!(d["open"].as_array().unwrap().len(), 0);
    assert_eq!(chips_of(&p, A).await, 1000);
    assert!(parse_duel(br#"{"action":"open","game":"poker","bet":5}"#).is_err());
    assert!(parse_duel(br#"{"action":"join","id":"../x"}"#).is_err());
    assert!(parse_duel(br#"{"action":"open","game":"rps","bet":5,"move":"lizard"}"#).is_err());
}
