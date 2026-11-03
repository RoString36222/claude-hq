use super::*;
use sqlx::sqlite::SqlitePoolOptions;

const A: &str = "aaaaaaaa-0000-4000-8000-0000000000a1";
const B: &str = "bbbbbbbb-0000-4000-8000-0000000000b2";

fn day(s: &str) -> NaiveDate {
    NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
}

#[test]
fn growth_starts_on_one_lot_at_bare_ground() {
    assert_eq!(growth(0), Build { pts: 0, lots: 1, stages: [-1, -1] });
    assert_eq!(growth(UNLOCK[0] - 1).lots, 1);
    // the first neighbouring lot comes at UNLOCK[0], bare ground
    assert_eq!(growth(UNLOCK[0]), Build { pts: UNLOCK[0], lots: 2, stages: [0, -1] });
}

#[test]
fn each_lot_climbs_its_five_stages_then_the_next_lot_opens() {
    let names = ["bare ground", "foundations", "buildings", "amenities", "landmark"];
    assert_eq!(STAGES, names);
    for k in 0..ANNEXES {
        for (s, at) in STAGE_AT.iter().enumerate() {
            let p = UNLOCK[k] + at;
            assert_eq!(growth(p).stages[k], s as i8, "lot {} stage {s} at {p}", k + 2);
            if *at > 0 {
                assert_eq!(growth(p - 1).stages[k], s as i8 - 1, "lot {} below stage {s}", k + 2);
            }
        }
    }
    // the second annex opens exactly when the first reaches its landmark
    assert_eq!(UNLOCK[1], UNLOCK[0] + STAGE_AT[4]);
    assert_eq!(growth(UNLOCK[1]), Build { pts: UNLOCK[1], lots: 3, stages: [4, 0] });
    // and the top: everything finished, more points change nothing but pts (capped)
    let top = UNLOCK[1] + STAGE_AT[4];
    assert_eq!(growth(top).stages, [4, 4]);
    assert_eq!(growth(top * 10), Build { pts: PTS_MAX, lots: 3, stages: [4, 4] });
    assert!(PTS_MAX >= top);
    // never down as points go up
    let mut last = growth(0);
    for p in 0..=PTS_MAX + 5 {
        let g = growth(p);
        assert!(g.lots >= last.lots && g.stages[0] >= last.stages[0] && g.stages[1] >= last.stages[1], "at {p}");
        last = g;
    }
    assert_eq!(growth(-5), growth(0));
}

#[test]
fn bodies_are_strict_and_only_recent_days_count() {
    let today = day("2026-11-02");
    let ok = parse(br#"{"days":[{"day":"2026-11-01","hours":7},{"day":"2026-11-02","hours":24}]}"#, today).unwrap();
    assert_eq!(ok, vec![(day("2026-11-01"), 7), (day("2026-11-02"), 24)]);
    // days other than today and yesterday are dropped, not refused (a clock either side of midnight)
    let some = parse(br#"{"days":[{"day":"2026-10-20","hours":5},{"day":"2026-11-03","hours":5},{"day":"2026-11-02","hours":3}]}"#, today).unwrap();
    assert_eq!(some, vec![(day("2026-11-02"), 3)]);
    for bad in [
        &br#"not json"#[..],
        br#"[]"#,
        br#"{}"#,
        br#"{"days":{}}"#,
        br#"{"days":[],"title":"x"}"#,
        br#"{"days":[{"day":"2026-11-02","hours":25}]}"#,
        br#"{"days":[{"day":"2026-11-02","hours":-1}]}"#,
        br#"{"days":[{"day":"2026-11-02","hours":1.5}]}"#,
        br#"{"days":[{"day":"2026-11-02","hours":"3"}]}"#,
        br#"{"days":[{"day":"2026-11-02"}]}"#,
        br#"{"days":[{"day":"yesterday","hours":3}]}"#,
        br#"{"days":[{"day":"2026-11-02","hours":3,"session":"abc"}]}"#,
        br#"{"days":[1,2,3,4]}"#,
    ] {
        assert!(parse(bad, today).is_err(), "accepted {}", String::from_utf8_lossy(bad));
    }
    // at most four days in one body
    let many = format!("{{\"days\":[{}]}}", [r#"{"day":"2026-11-02","hours":1}"#; 5].join(","));
    assert!(parse(many.as_bytes(), today).is_err());
}

#[test]
fn reports_are_rate_limited_per_user() {
    let t = Instant::now();
    let u = "work-rate-test-user";
    for _ in 0..SAVE_BURST {
        assert!(save_allowed(u, t));
    }
    assert!(!save_allowed(u, t));
    assert!(save_allowed("work-rate-test-other", t));
    assert!(save_allowed(u, t + SAVE_WINDOW));
}

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

#[tokio::test]
async fn a_days_hours_only_go_up_and_the_sum_is_the_build() {
    let p = pool().await;
    assert_eq!(load(&p, A).await.unwrap(), None, "no rows: no build shown");
    record(&p, A, &[(day("2026-11-01"), 6), (day("2026-11-02"), 3)]).await.unwrap();
    assert_eq!(load(&p, A).await.unwrap(), Some(growth(9)));
    // a later, smaller report for the same day never takes hours back; a bigger one replaces it
    record(&p, A, &[(day("2026-11-02"), 1)]).await.unwrap();
    assert_eq!(load(&p, A).await.unwrap(), Some(growth(9)));
    record(&p, A, &[(day("2026-11-02"), 8)]).await.unwrap();
    assert_eq!(load(&p, A).await.unwrap(), Some(growth(14)));
    record(&p, B, &[(day("2026-11-02"), 24)]).await.unwrap();
    let ids: Vec<String> = [A, B, "nobody"].iter().map(|s| s.to_string()).collect();
    let m = load_many(&p, &ids).await.unwrap();
    assert_eq!(m.len(), 2);
    assert_eq!(m[A], growth(14));
    assert_eq!(m[B], growth(24));
}

#[tokio::test]
async fn a_row_over_the_cap_counts_the_cap() {
    let p = pool().await;
    sqlx::query("INSERT INTO hq_work (user_id, day, hours) VALUES (?1, '2026-11-01', 500)").bind(A).execute(&p).await.unwrap();
    assert_eq!(load(&p, A).await.unwrap(), Some(growth(DAY_CAP)));
}

#[tokio::test]
async fn the_migration_creates_the_table() {
    let p = pool().await;
    let cols: Vec<String> = sqlx::query_scalar("SELECT name FROM pragma_table_info('hq_work')").fetch_all(&p).await.unwrap();
    assert_eq!(cols, ["user_id", "day", "hours", "updated_at"]);
}

#[test]
fn the_wire_shape() {
    assert_eq!(serde_json::to_string(&growth(UNLOCK[0])).unwrap(), r#"{"pts":10,"lots":2,"stages":[0,-1]}"#);
}
