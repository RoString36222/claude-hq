//! Ported from tests/test_worksignals.py: classify_entry on a bare day bucket,
//! junk input, the no-transcripts zero report, and the privacy boundary (the
//! per-file aggregate holds only day -> known key -> integer count).

use claudehq::{scan, worksignals};
use serde_json::{json, Value};

const DAY: &str = "2026-09-01";

fn use_(tid: &str, name: &str, inp: Value, t: &str) -> Value {
    json!({"type": "assistant", "timestamp": t, "message": {"content": [{"type": "tool_use", "id": tid, "name": name, "input": inp}]}})
}

fn result(tid: &str, out: &str, t: &str) -> Value {
    json!({"type": "user", "timestamp": t, "message": {"content": [{"type": "tool_result", "tool_use_id": tid, "content": out}]}})
}

fn tests_trio() -> Vec<Value> {
    vec![
        use_("t1", "Bash", json!({"command": "cd app && python3 -m pytest -q"}), "2026-09-01T10:00:00.000Z"),
        result("t1", "12 passed in 0.4s", "2026-09-01T10:00:05.000Z"),
        use_("t2", "Bash", json!({"command": "cargo test"}), "2026-09-01T10:01:00.000Z"),
        result("t2", "test result: FAILED. 3 passed; 1 failed", "2026-09-01T10:01:09.000Z"),
        use_("t3", "Edit", json!({"file_path": "/r/tests/test_x.py", "old_string": "a", "new_string": "b"}), "2026-09-01T10:02:00.000Z"),
        result("t3", "ok", "2026-09-01T10:02:01.000Z"),
    ]
}

#[test]
fn classify_entry_on_a_bare_day_bucket_and_junk_never_panics() {
    let mut days = worksignals::WsDays::new();
    let mut st = worksignals::WsState::default();
    for r in tests_trio() {
        worksignals::classify_entry(&r, DAY, &mut days, &mut st);
    }
    assert_eq!((days[DAY]["tests"], days[DAY]["tests_green"]), (3, 1));
    for junk in [
        Value::Null,
        json!(3),
        json!("x"),
        json!({"type": "assistant", "message": {"content": "hi"}}),
        json!({"type": "assistant", "message": {"content": [{"type": "tool_use", "input": 5}]}}),
        json!({"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": 7, "content": {"x": 1}}]}}),
    ] {
        worksignals::classify_entry(&junk, DAY, &mut days, &mut st);
        let mut none = None;
        worksignals::observe(&junk, &mut none, &mut st);
    }
    assert_eq!(days[DAY]["tests"], 3);
}

#[test]
fn no_transcripts_is_all_zero() {
    let got = worksignals::merge_days(std::iter::empty(), &[DAY.to_string()]);
    assert_eq!(got.len(), 1);
    assert_eq!(got[DAY].keys().cloned().collect::<Vec<_>>(), worksignals::KEYS.iter().map(|k| k.to_string()).collect::<Vec<_>>());
    assert!(got[DAY].values().all(|n| *n == 0));
}

#[test]
fn the_aggregate_holds_only_day_key_count() {
    let d = tempfile::tempdir().unwrap();
    let p = d.path().join("22222222-2222-4222-8222-222222222222.jsonl");
    let mut recs = tests_trio();
    recs.push(use_("s1", "Write", json!({"file_path": "/Users/x/SECRET/README.md", "content": "sk-SECRET"}), "2026-09-01T10:03:00.000Z"));
    recs.push(result("s1", "Traceback SECRET", "2026-09-01T10:03:01.000Z"));
    std::fs::write(&p, recs.iter().map(|r| format!("{}\n", r)).collect::<String>()).unwrap();
    let agg = scan::scan_claude(&p);
    let ws = agg.ws_days.expect("ws_days");
    let day_re = regex::Regex::new(r"^\d{4}-\d{2}-\d{2}$").unwrap();
    for (day, counts) in &ws {
        assert!(day_re.is_match(day), "{}", day);
        for (k, n) in counts {
            assert!(worksignals::KEYS.contains(&k.as_str()), "{}", k);
            assert!(*n > 0);
        }
    }
    let blob = format!("{:?}", ws);
    for leak in ["SECRET", "README", "pytest", "/r/", ".py", "Traceback", "cargo"] {
        assert!(!blob.contains(leak), "{}", leak);
    }
    // What leaves the machine: exactly the seven categories, clamped integers.
    let merged = worksignals::merge_days(std::iter::once(Some(&ws)), &[DAY.to_string()]);
    for c in worksignals::report_counts(&merged).values() {
        assert_eq!(c.keys().cloned().collect::<Vec<_>>(), worksignals::SKILL_CATS.iter().map(|k| k.to_string()).collect::<Vec<_>>());
        assert!(c.values().all(|n| (0..=worksignals::MAX_N).contains(n)));
    }
}
