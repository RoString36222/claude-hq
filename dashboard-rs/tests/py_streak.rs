//! Ported from tests/test_streak.py. The fixed cases live in
//! src/payload.rs::flexible_streak. ArenaParityTests compared this streak with
//! the Python Arena server's copy; that server is now backend-rs, whose copy
//! (progress.rs::flex_streak) is private, so parity is checked here as: the
//! same tuning constants, and both agreeing with one spec oracle on random
//! histories (the oracle below is the rule, written independently of the walk).

use chrono::{Duration, NaiveDate};
use claudehq::payload::flex_streak;
use rand::{rngs::StdRng, Rng, SeedableRng};
use std::collections::HashSet;

const WINDOW: usize = 7;
const MAX_MISSES: usize = 2;
const LOOKBACK: usize = 400;

/// The rule: walking back from today (yesterday if today is not yet active),
/// take the longest stretch in which no run of WINDOW days holds more than
/// MAX_MISSES misses; the streak is its first active day to its last.
fn oracle(active: &HashSet<NaiveDate>, end: NaiveDate) -> i64 {
    let start = if active.contains(&end) { end } else { end - Duration::days(1) };
    let days: Vec<bool> = (0..LOOKBACK as i64).map(|i| active.contains(&(start - Duration::days(i)))).collect();
    let ok = |n: usize| (0..n).all(|i| days[i.saturating_sub(WINDOW - 1)..=i].iter().filter(|a| !**a).count() <= MAX_MISSES);
    let n = (0..=LOOKBACK).rev().find(|n| ok(*n)).unwrap_or(0);
    let on: Vec<usize> = (0..n).filter(|i| days[*i]).collect();
    match (on.first(), on.last()) {
        (Some(a), Some(b)) => (b - a + 1) as i64,
        _ => 0,
    }
}

#[test]
fn agrees_with_the_rule_on_random_histories() {
    let t = NaiveDate::from_ymd_opt(2026, 10, 6).unwrap();
    let mut rnd = StdRng::seed_from_u64(7);
    for _ in 0..400 {
        let p = [0.5, 0.7, 0.85, 0.95][rnd.gen_range(0..4)];
        let active: HashSet<NaiveDate> = (0..60).filter(|_| rnd.gen::<f64>() < p).map(|i| t - Duration::days(i)).collect();
        let mut sorted: Vec<_> = active.iter().collect();
        sorted.sort();
        assert_eq!(flex_streak(&active, t), oracle(&active, t), "{:?}", sorted);
    }
}

#[test]
fn the_arena_server_uses_the_same_rule() {
    // backend-rs keeps its own flex_streak; drift in its constants or in which
    // function the leaderboard calls would split the two streaks.
    let src = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../backend-rs/src/progress.rs")).unwrap();
    let konst = |name: &str| -> usize {
        let line = src.lines().find(|l| l.trim_start().starts_with(&format!("const {}:", name))).unwrap_or_else(|| panic!("no {}", name));
        line.split('=').nth(1).unwrap().trim().trim_end_matches(';').parse().unwrap()
    };
    assert_eq!((konst("STREAK_WINDOW"), konst("STREAK_MAX_MISSES"), konst("STREAK_LOOKBACK")), (WINDOW, MAX_MISSES, LOOKBACK));
    assert!(src.contains("let streak = flex_streak(&active, today);"));
}
