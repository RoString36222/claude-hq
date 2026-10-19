//! Ported from tests/test_meals.py: the cases not already in src/app.rs
//! (meals_are_idempotent_private_and_bounded, meal_caps_keep_the_fatigue_window).
//! The meal ledger is written only after the Arena confirmed a snack, so it
//! must be idempotent, atomic, private (0600) and bounded. Temp dirs only.

use claudehq::app::{App, Paths, MEALS_MAX, MEALS_PER_SID};
use claudehq::{fatigue, py, pyjson};
use serde_json::{json, Value};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::sync::{Arc, Barrier};

const SID_A: &str = "11111111-1111-4111-8111-111111111111";
const SID_B: &str = "22222222-2222-4222-8222-222222222222";
const NOW: f64 = 1790000000.0;

fn rid(n: usize) -> String {
    format!("req-{:016}", n)
}

fn app() -> (tempfile::TempDir, Arc<App>) {
    let d = tempfile::tempdir().unwrap();
    let p = Paths::new(d.path(), &d.path().join("home"));
    (d, Arc::new(App::new(p)))
}

fn raw(app: &App) -> Value {
    serde_json::from_str(&fs::read_to_string(&app.paths.meals).unwrap()).unwrap()
}

fn temps(d: &tempfile::TempDir) -> Vec<String> {
    fs::read_dir(d.path())
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|n| n.starts_with(".meals-") && n.ends_with(".tmp"))
        .collect()
}

#[test]
fn idempotent_by_request_id_leaves_one_raw_entry() {
    let (_d, app) = app();
    let first = app.record_meal(&rid(1), SID_A, "berry", NOW - 10.0, Some(NOW)).unwrap();
    app.record_meal(&rid(1), SID_B, "bento", NOW - 5.0, Some(NOW)).unwrap();
    assert_eq!(raw(&app)["meals"], json!([first.to_json()]));
}

#[test]
fn find_meal() {
    let (_d, app) = app();
    assert!(app.find_meal(&rid(1)).is_none());
    app.record_meal(&rid(1), SID_A, "riceball", py::now_ts() - 5.0, None).unwrap();
    assert_eq!(app.find_meal(&rid(1)).unwrap().session_id, SID_A);
    assert!(app.find_meal(&rid(2)).is_none());
}

#[test]
fn file_is_valid_private_json_with_no_temp_left() {
    let (d, app) = app();
    for i in 0..3 {
        app.record_meal(&rid(i), SID_A, "berry", NOW - i as f64, Some(NOW)).unwrap();
        let data = raw(&app);
        assert_eq!(data["version"], 1);
        assert_eq!(data["meals"].as_array().unwrap().len(), i + 1);
        assert_eq!(fs::metadata(&app.paths.meals).unwrap().permissions().mode() & 0o777, 0o600);
        assert!(temps(&d).is_empty());
    }
    let data = raw(&app);
    let keys: Vec<&String> = data["meals"][0].as_object().unwrap().keys().collect();
    assert_eq!(keys, ["requestId", "sessionId", "kind", "at"]);
}

#[test]
fn failed_write_leaves_the_old_file_intact() {
    let (d, app) = app();
    app.record_meal(&rid(1), SID_A, "berry", NOW - 10.0, Some(NOW)).unwrap();
    let before = raw(&app);
    // No temp file can be created: the write fails before touching meals.json.
    fs::set_permissions(d.path(), fs::Permissions::from_mode(0o500)).unwrap();
    let r = app.record_meal(&rid(2), SID_A, "bento", NOW - 5.0, Some(NOW));
    fs::set_permissions(d.path(), fs::Permissions::from_mode(0o700)).unwrap();
    assert!(r.is_err());
    assert_eq!(raw(&app), before);
    assert!(temps(&d).is_empty());
}

#[test]
fn missing_or_corrupt_file_reads_empty() {
    let (_d, app) = app();
    assert!(app.load_meals(Some(NOW)).is_empty());
    fs::write(&app.paths.meals, "{not json").unwrap();
    assert!(app.load_meals(Some(NOW)).is_empty());
    fs::write(&app.paths.meals, pyjson::dumps(&json!({"version": 1, "meals": "nope"}))).unwrap();
    assert!(app.load_meals(Some(NOW)).is_empty());
}

#[test]
fn invalid_entries_the_app_test_skips_are_dropped() {
    let (_d, app) = app();
    let good = json!({"requestId": rid(1), "sessionId": SID_A, "kind": "berry", "at": NOW - 60.0});
    let mut list = vec![good.clone(), json!("not a dict")];
    let mut x = good.clone();
    x["requestId"] = json!(rid(5));
    x["kind"] = json!(["berry"]);
    list.push(x);
    let mut x = good.clone();
    x["requestId"] = json!("has a space in it!!");
    list.push(x);
    fs::write(&app.paths.meals, pyjson::dumps(&json!({"version": 1, "meals": list}))).unwrap();
    let meals = app.load_meals(Some(NOW));
    assert_eq!(meals.len(), 1);
    assert_eq!(meals[SID_A], vec![(NOW - 60.0, "berry".to_string())]);
    // NaN / Infinity (valid for Python's json) never reach the walk: the
    // strict parser rejects the file, so nothing non-finite is ever loaded.
    let text = format!(
        "{{\"version\": 1, \"meals\": [{}, {{\"requestId\": \"{}\", \"sessionId\": \"{}\", \"kind\": \"berry\", \"at\": NaN}}, {{\"requestId\": \"{}\", \"sessionId\": \"{}\", \"kind\": \"berry\", \"at\": Infinity}}]}}",
        good,
        rid(10),
        SID_A,
        rid(11),
        SID_A
    );
    fs::write(&app.paths.meals, text).unwrap();
    assert!(app.load_meals(Some(NOW)).values().flatten().all(|(at, _)| at.is_finite()));
}

#[test]
fn the_total_cap_keeps_the_file_in_time_order() {
    let (_d, app) = app();
    let many: Vec<Value> = (0..600)
        .map(|i| json!({"requestId": rid(1000 + i), "sessionId": format!("{:08}-0000-4000-8000-000000000000", i), "kind": "berry", "at": NOW - 600.0 + i as f64}))
        .collect();
    fs::write(&app.paths.meals, pyjson::dumps(&json!({"version": 1, "meals": many}))).unwrap();
    app.record_meal(&rid(5000), SID_B, "tonic", NOW, Some(NOW)).unwrap();
    let data = raw(&app);
    let ats: Vec<f64> = data["meals"].as_array().unwrap().iter().map(|m| m["at"].as_f64().unwrap()).collect();
    assert_eq!(ats.len(), MEALS_MAX);
    let mut sorted = ats.clone();
    sorted.sort_by(f64::total_cmp);
    assert_eq!(ats, sorted);
}

#[test]
fn a_snack_never_leaves_the_creature_worse_off() {
    // A 12-h working day: a Revive Tonic at the 4-h faint, then a Berry every
    // 20 min whenever the eat gate allows one. Pruning the tonic would bring
    // the faint back the moment the 21st meal lands.
    let (_d, app) = app();
    let base = NOW - NOW % 900.0 - 12.0 * 3600.0;
    let spans = [[base, base + 12.0 * 3600.0]];
    let fz = |now: f64| {
        let meals = app.load_meals(Some(now)).remove(SID_A).unwrap_or_default();
        fatigue::fatigue_for(SID_A, &spans, now, None, &meals)
    };
    let mut now = base + 4.0 * 3600.0;
    assert_eq!(fz(now)["state"], "unconscious");
    app.record_meal(&rid(0), SID_A, "tonic", now, Some(now)).unwrap();
    assert_eq!(fz(now)["state"], "tired");
    let mut eaten = 1;
    for k in 1..MEALS_PER_SID + 5 {
        now += 20.0 * 60.0;
        let before = fz(now);
        if before["state"] != "tired" && before["state"] != "fatigued" {
            continue;
        }
        app.record_meal(&rid(k), SID_A, "berry", now, Some(now)).unwrap();
        eaten += 1;
        let after = fz(now);
        assert_ne!(after["state"], "unconscious", "meal {}", k);
        assert!(after["loadMins"].as_i64() <= before["loadMins"].as_i64(), "meal {}", k);
    }
    assert!(eaten > MEALS_PER_SID);
    assert_eq!(app.load_meals(Some(now))[SID_A].len(), eaten);
}

#[test]
fn concurrent_records_both_land() {
    let (_d, app) = app();
    let start = Arc::new(Barrier::new(2));
    let hs: Vec<_> = [(1usize, SID_A), (2, SID_B)]
        .into_iter()
        .map(|(i, sid)| {
            let (app, start) = (app.clone(), start.clone());
            std::thread::spawn(move || {
                start.wait();
                app.record_meal(&rid(i), sid, "berry", NOW - i as f64, Some(NOW)).unwrap();
            })
        })
        .collect();
    for h in hs {
        h.join().unwrap();
    }
    let mut ids: Vec<String> = raw(&app)["meals"].as_array().unwrap().iter().map(|m| m["requestId"].as_str().unwrap().to_string()).collect();
    ids.sort();
    assert_eq!(ids, [rid(1), rid(2)]);
}
