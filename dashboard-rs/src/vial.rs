//! Overflow Vial: past Apex a creature's session keeps earning XP no one
//! spends, so half of that surplus drips into a shared bank with a 24 h fuse.
//! The ledger is per-deposit (each drop expires on its own clock) and a spend
//! CONSUMES deposits oldest-first, rewriting the ledger -- so an expired
//! deposit can never drag a spend onto fresh XP.
//!
//! vial.json: {"version": 1, "deposits": [{at, xp}], "spent": [{at, xp, sid, stage}], "seenPrompts": n}
//!   - balance(t) = sum of the live deposits
//!   - "spent" is a pure audit log; it never feeds the balance.

use crate::app::{is_uuid, App};
use crate::state;
use serde_json::{json, Value};

/// A deposit dies one UTC day after it lands.
pub const VIAL_WINDOW: f64 = 86400.0;
/// Hard ceiling so a forgotten bank can't grow forever.
pub const VIAL_MAX: i64 = 10000;
/// Cost to lift a creature one stage from stage i (the "half-efficiency tax").
pub const VIAL_STAGE_COST: [i64; 4] = [30, 90, 180, 400];

#[derive(Clone, Debug, PartialEq)]
pub struct Deposit {
    pub at: f64,
    pub xp: i64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Spent {
    pub at: f64,
    pub xp: i64,
    pub sid: Value,
    pub stage: i64,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct VialState {
    pub deposits: Vec<Deposit>,
    pub spent: Vec<Spent>,
    pub seen_prompts: i64,
}

/// isinstance(v, (int, float)) -- a bool counts, as in Python.
fn num(v: Option<&Value>) -> Option<f64> {
    match v? {
        Value::Bool(b) => Some(*b as i64 as f64),
        Value::Number(n) => n.as_f64(),
        _ => None,
    }
}

/// int(x) of a number that passed num().
fn trunc(v: Option<&Value>) -> i64 {
    match v {
        Some(Value::Number(n)) if n.is_i64() => n.as_i64().unwrap(),
        _ => num(v).map(|f| f.trunc() as i64).unwrap_or(0),
    }
}

impl VialState {
    fn to_json(&self) -> Value {
        json!({
            "version": 1,
            "deposits": self.deposits.iter().map(|d| json!({"at": d.at, "xp": d.xp})).collect::<Vec<_>>(),
            "spent": self.spent.iter().map(|s| json!({"at": s.at, "xp": s.xp, "sid": s.sid, "stage": s.stage})).collect::<Vec<_>>(),
            "seenPrompts": self.seen_prompts,
        })
    }

    /// Effective XP in the vial: the sum of the live deposits.
    pub fn balance(&self) -> i64 {
        self.deposits.iter().map(|d| d.xp).sum()
    }

    /// Live deposits as {xp, ttl} rows (ttl = seconds until this drop dies),
    /// last expiry first.
    pub fn sources(&self, now: f64) -> Vec<Value> {
        let mut rows: Vec<(f64, i64)> = self.deposits.iter().map(|d| ((d.at + VIAL_WINDOW - now).max(0.0), d.xp)).collect();
        rows.sort_by(|a, b| b.0.total_cmp(&a.0));
        rows.into_iter().map(|(ttl, xp)| json!({"xp": xp, "ttl": ttl})).collect()
    }
}

/// Trim the deposit ledger to VIAL_MAX total XP, oldest-first (in place).
fn vial_cap(deposits: &mut Vec<Deposit>) {
    let mut total: i64 = deposits.iter().map(|d| d.xp).sum();
    while total > VIAL_MAX && !deposits.is_empty() {
        let old = deposits[0].clone();
        if old.xp <= total - VIAL_MAX {
            total -= old.xp;
            deposits.remove(0);
        } else {
            deposits[0] = Deposit { at: old.at, xp: old.xp - (total - VIAL_MAX) };
            total = VIAL_MAX;
        }
    }
}

impl App {
    /// The ledger with only live entries; a missing/corrupt file is an empty vial.
    pub fn vial_read(&self, now: f64) -> VialState {
        let Some(Value::Object(raw)) = state::load_json_plain(&self.paths.vial) else { return VialState::default() };
        let mut out = VialState::default();
        if num(raw.get("seenPrompts")).map(|s| s >= 0.0).unwrap_or(false) {
            out.seen_prompts = trunc(raw.get("seenPrompts"));
        }
        let live = |o: &serde_json::Map<String, Value>| -> bool {
            let (Some(xp), Some(at)) = (num(o.get("xp")), num(o.get("at"))) else { return false };
            0.0 < xp && xp <= VIAL_MAX as f64 && now - VIAL_WINDOW < at && at <= now + 60.0
        };
        if let Some(Value::Array(dep)) = raw.get("deposits") {
            for d in dep {
                if let Value::Object(d) = d {
                    if live(d) {
                        out.deposits.push(Deposit { at: num(d.get("at")).unwrap(), xp: trunc(d.get("xp")) });
                    }
                }
            }
        }
        if let Some(Value::Array(sp)) = raw.get("spent") {
            for s in sp {
                if let Value::Object(s) = s {
                    if live(s) {
                        let sid = s.get("sid").filter(|v| crate::py::truthy(v)).cloned().unwrap_or_else(|| json!(""));
                        let stage = s.get("stage").filter(|v| crate::py::truthy(v)).and_then(crate::py::py_int).unwrap_or(0);
                        out.spent.push(Spent { at: num(s.get("at")).unwrap(), xp: trunc(s.get("xp")), sid, stage });
                    }
                }
            }
        }
        out.deposits.sort_by(|a, b| a.at.total_cmp(&b.at));
        out.spent.sort_by(|a, b| a.at.total_cmp(&b.at));
        out
    }

    fn vial_write(&self, st: &VialState) -> std::io::Result<()> {
        state::atomic_write_json(&self.paths.vial, &st.to_json(), 0o600)
    }

    /// Expire old deposits & spends on disk (a no-op if nothing aged out) and
    /// return the live balance. Runs on every payload build.
    pub fn vial_tick(&self, now: f64) -> i64 {
        let _g = self.vial_lock.lock().unwrap();
        let st = self.vial_read(now);
        let live_n = st.deposits.len() + st.spent.len();
        let rewrite = match state::load_json_plain(&self.paths.vial) {
            Some(Value::Object(raw)) => {
                let len = |k: &str| match raw.get(k) {
                    None => 0,
                    Some(Value::Array(a)) => a.len(),
                    Some(Value::Object(o)) => o.len(),
                    Some(Value::String(s)) => s.chars().count(),
                    Some(_) => 0,
                };
                len("deposits") + len("spent") != live_n
            }
            _ => true,
        };
        if rewrite {
            let _ = self.vial_write(&st);
        }
        st.balance()
    }

    /// Deposit XP.
    pub fn vial_grant(&self, xp: i64, at: f64) {
        if xp <= 0 {
            return;
        }
        let _g = self.vial_lock.lock().unwrap();
        let mut st = self.vial_read(at);
        st.deposits.push(Deposit { at, xp });
        vial_cap(&mut st.deposits);
        let _ = self.vial_write(&st);
    }

    /// Turn prompts past the Apex threshold into half-XP deposits, exactly
    /// once (the seenPrompts watermark). Returns the XP just deposited.
    pub fn vial_drip(&self, surplus_prompts: i64, at: f64) -> i64 {
        if surplus_prompts <= 0 {
            return 0;
        }
        let _g = self.vial_lock.lock().unwrap();
        let mut st = self.vial_read(at);
        let seen = st.seen_prompts;
        if surplus_prompts <= seen {
            return 0;
        }
        let delta = ((surplus_prompts - seen) * 10).div_euclid(2);
        if delta != 0 {
            st.deposits.push(Deposit { at, xp: delta });
            vial_cap(&mut st.deposits);
        }
        st.seen_prompts = surplus_prompts;
        if self.vial_write(&st).is_err() {
            return 0;
        }
        delta
    }

    /// Spend from the vial to lift a creature one stage: {ok, cost, balance}
    /// or {ok: false, error, ...} on a short vial, Apex or a bad id.
    pub fn vial_spend(&self, sid: &Value, from_stage: &Value, at: f64) -> Value {
        if !matches!(sid, Value::String(s) if is_uuid(s)) {
            return json!({"ok": false, "error": "bad session id"});
        }
        let Some(stage) = crate::py::strict_int(from_stage).filter(|s| (0..=3).contains(s)) else {
            return json!({"ok": false, "error": "already Apex"});
        };
        let cost = VIAL_STAGE_COST[stage as usize];
        let _g = self.vial_lock.lock().unwrap();
        let mut st = self.vial_read(at);
        if st.balance() < cost {
            return json!({"ok": false, "error": "the vial is short", "cost": cost, "balance": st.balance()});
        }
        // consume oldest-first (the same fuse order the deposits expire in)
        let mut need = cost;
        while need > 0 && !st.deposits.is_empty() {
            let old = st.deposits[0].clone();
            if old.xp <= need {
                need -= old.xp;
                st.deposits.remove(0);
            } else {
                st.deposits[0] = Deposit { at: old.at, xp: old.xp - need };
                need = 0;
            }
        }
        st.spent.push(Spent { at, xp: cost, sid: sid.clone(), stage: stage + 1 });
        if self.vial_write(&st).is_err() {
            return json!({"ok": false, "error": "the vial ledger is unwritable"});
        }
        self.invalidate_payload_memo();
        json!({"ok": true, "cost": cost, "balance": st.balance()})
    }

    /// Drip this build's Apex surplus, tick the fuse, stamp each session's
    /// lifetime pour, and return the payload's `vial` object.
    pub fn vial_for_payload(&self, sessions: &mut [Value]) -> Value {
        let apex = crate::creature::STAGE_THRESHOLDS[crate::creature::STAGE_THRESHOLDS.len() - 1];
        let surplus = |s: &Value| (s.get("promptCount").and_then(crate::py::py_int).unwrap_or(0) - apex).max(0);
        let now = crate::py::now_ts();
        let total: i64 = sessions.iter().map(surplus).sum();
        self.vial_drip(total, now);
        let xp = self.vial_tick(now);
        for s in sessions.iter_mut() {
            let poured = surplus(s) * 5;
            if let Value::Object(o) = s {
                o.insert("vialPoured".into(), json!(poured));
            }
        }
        let st = {
            let _g = self.vial_lock.lock().unwrap();
            self.vial_read(now)
        };
        json!({
            "xp": xp, "expiresIn": VIAL_WINDOW,
            "costs": {"0": VIAL_STAGE_COST[0], "1": VIAL_STAGE_COST[1], "2": VIAL_STAGE_COST[2], "3": VIAL_STAGE_COST[3]},
            "src": st.sources(now),
        })
    }
}

/// Only for tests: the raw file, pretty.
#[cfg(test)]
fn raw(app: &App) -> Value {
    serde_json::from_str(&std::fs::read_to_string(&app.paths.vial).unwrap()).unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::testutil::app;
    use crate::pyjson;

    const SID: &str = "11111111-1111-4111-8111-111111111111";
    const NOW: f64 = 1790000000.0;

    fn spend(app: &App, stage: Value, at: f64) -> Value {
        app.vial_spend(&json!(SID), &stage, at)
    }

    #[test]
    fn missing_file_is_an_empty_vial() {
        let (_d, app) = app();
        assert_eq!(app.vial_tick(NOW), 0);
        assert_eq!(app.vial_read(NOW), VialState::default());
    }

    #[test]
    fn grant_deposits_and_balance_is_the_live_sum() {
        let (_d, app) = app();
        app.vial_grant(50, NOW - 10.0);
        app.vial_grant(30, NOW - 5.0);
        assert_eq!(app.vial_tick(NOW), 80);
    }

    #[test]
    fn a_deposit_dies_exactly_one_window_after_it_lands() {
        let (_d, app) = app();
        app.vial_grant(100, NOW - VIAL_WINDOW + 1.0);
        assert_eq!(app.vial_tick(NOW), 100);
        assert_eq!(app.vial_tick(NOW + 1.0), 0);
    }

    #[test]
    fn spend_consumes_oldest_first_and_leaves_the_split() {
        let (_d, app) = app();
        app.vial_grant(50, NOW - 20.0);
        app.vial_grant(50, NOW - 5.0);
        let r = spend(&app, json!(1), NOW);
        assert_eq!(r, json!({"ok": true, "cost": 90, "balance": 10}));
        let st = app.vial_read(NOW);
        assert_eq!(st.deposits, vec![Deposit { at: NOW - 5.0, xp: 10 }]);
        assert_eq!((st.spent[0].sid.clone(), st.spent[0].stage), (json!(SID), 2));
    }

    #[test]
    fn an_expired_deposit_never_drags_a_spend_onto_fresh_xp() {
        let (_d, app) = app();
        app.vial_grant(40, NOW - VIAL_WINDOW + 2.0);
        app.vial_grant(100, NOW - 1.0);
        let r = spend(&app, json!(0), NOW);
        assert_eq!(r["balance"], 110);
        assert_eq!(app.vial_tick(NOW + 3.0), 100);
    }

    #[test]
    fn spend_refused_when_the_vial_is_short() {
        let (_d, app) = app();
        app.vial_grant(20, NOW);
        let r = spend(&app, json!(0), NOW);
        assert_eq!(r, json!({"ok": false, "error": "the vial is short", "cost": 30, "balance": 20}));
        assert!(app.vial_read(NOW).spent.is_empty());
    }

    #[test]
    fn apex_and_bad_ids_are_refused() {
        let (_d, app) = app();
        app.vial_grant(5000, NOW);
        assert_eq!(spend(&app, json!(4), NOW)["ok"], false);
        assert_eq!(app.vial_spend(&json!("../etc/passwd"), &json!(1), NOW)["ok"], false);
        assert_eq!(spend(&app, json!(true), NOW)["ok"], false);
        assert_eq!(app.vial_tick(NOW), 5000);
    }

    #[test]
    fn ledger_ceiling_trims_the_oldest_deposits() {
        let (_d, app) = app();
        app.vial_grant(VIAL_MAX - 10, NOW - 50.0);
        app.vial_grant(20, NOW);
        assert_eq!(app.vial_tick(NOW), VIAL_MAX);
        let st = app.vial_read(NOW);
        assert_eq!(st.balance(), VIAL_MAX);
        assert_eq!(st.deposits, vec![Deposit { at: NOW - 50.0, xp: VIAL_MAX - 20 }, Deposit { at: NOW, xp: 20 }]);
    }

    #[test]
    fn file_is_valid_private_json_with_no_temp_left() {
        let (d, app) = app();
        app.vial_grant(10, NOW);
        let data = raw(&app);
        assert_eq!(data["version"], 1);
        assert_eq!(data["deposits"], json!([{"at": NOW, "xp": 10}]));
        assert_eq!(data["seenPrompts"], 0);
        // byte-identical to Python's json.dumps(indent=2)
        assert_eq!(
            std::fs::read_to_string(&app.paths.vial).unwrap(),
            "{\n  \"version\": 1,\n  \"deposits\": [\n    {\n      \"at\": 1790000000.0,\n      \"xp\": 10\n    }\n  ],\n  \"spent\": [],\n  \"seenPrompts\": 0\n}"
        );
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(&app.paths.vial).unwrap().permissions().mode() & 0o777, 0o600);
        let names: Vec<String> = std::fs::read_dir(d.path()).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        assert!(!names.iter().any(|n| n.starts_with(".vial") && n.ends_with(".tmp")));
    }

    #[test]
    fn corrupt_file_reads_empty_and_bad_entries_are_dropped() {
        let (_d, app) = app();
        std::fs::write(&app.paths.vial, "{not json").unwrap();
        assert_eq!(app.vial_tick(NOW), 0);
        let body = json!({"version": 1, "deposits": [
            {"at": NOW, "xp": 10}, {"at": NOW, "xp": -5}, {"at": NOW, "xp": 1e300},
            {"at": NOW - VIAL_WINDOW - 1.0, "xp": 10}, "not a dict",
        ], "spent": [{"at": NOW, "xp": 3, "sid": SID, "stage": 1}, {"at": true, "xp": 3}], "seenPrompts": -4});
        std::fs::write(&app.paths.vial, pyjson::dumps(&body)).unwrap();
        let st = app.vial_read(NOW);
        assert_eq!(st.deposits, vec![Deposit { at: NOW, xp: 10 }]);
        assert_eq!(st.spent.len(), 1);
        assert_eq!(st.seen_prompts, 0);
    }

    #[test]
    fn surplus_drips_in_once() {
        let (_d, app) = app();
        assert_eq!(app.vial_drip(5, NOW), 25);
        assert_eq!(app.vial_tick(NOW + 1.0), 25);
        assert_eq!(app.vial_drip(5, NOW + 2.0), 0);
        assert_eq!(app.vial_tick(NOW + 3.0), 25);
    }

    #[test]
    fn only_the_fresh_surplus_lands() {
        let (_d, app) = app();
        assert_eq!(app.vial_drip(5, NOW), 25);
        assert_eq!(app.vial_drip(15, NOW + 1.0), 50);
        assert_eq!(app.vial_tick(NOW + 2.0), 75);
    }

    #[test]
    fn no_surplus_no_deposit() {
        let (_d, app) = app();
        assert_eq!(app.vial_drip(0, NOW), 0);
        assert_eq!(app.vial_drip(-3, NOW), 0);
        assert_eq!(app.vial_tick(NOW + 1.0), 0);
        assert_eq!(app.vial_read(NOW).seen_prompts, 0);
    }

    #[test]
    fn watermark_survives_the_round_trip() {
        let (_d, app) = app();
        app.vial_drip(5, NOW);
        let st = app.vial_read(NOW + 1.0);
        assert_eq!(st.seen_prompts, 5);
        assert_eq!(st.deposits, vec![Deposit { at: NOW, xp: 25 }]);
    }

    #[test]
    fn spend_debits_the_ledger_and_invalidates_the_payload() {
        let (_d, app) = app();
        app.vial_grant(200, NOW);
        app.invalidate_payload_memo();
        let gen0 = app.payload_memo.lock().unwrap().gen;
        assert_eq!(spend(&app, json!(0), NOW), json!({"ok": true, "cost": 30, "balance": 170}));
        assert!(app.payload_memo.lock().unwrap().gen > gen0);
        assert!(crate::server::post_paths().contains(&"/api/vial/spend"));
        assert_eq!(VIAL_STAGE_COST, [30, 90, 180, 400]);
    }

    #[test]
    fn sources_list_the_live_drops_last_expiry_first() {
        let (_d, app) = app();
        app.vial_grant(50, NOW - 82800.0);
        app.vial_grant(400, NOW - 7200.0);
        app.vial_grant(200, NOW - 3600.0);
        app.vial_drip(6, NOW);
        let src = app.vial_read(NOW).sources(NOW);
        assert_eq!(src.iter().map(|r| r["xp"].as_i64().unwrap()).collect::<Vec<_>>(), vec![30, 200, 400, 50]);
        assert_eq!(src.iter().map(|r| r["ttl"].as_f64().unwrap()).collect::<Vec<_>>(), vec![86400.0, 82800.0, 79200.0, 3600.0]);
        assert_eq!(src.iter().map(|r| r["xp"].as_i64().unwrap()).sum::<i64>(), 680);
    }

    #[test]
    fn a_partial_spend_keeps_the_die_time_of_the_leftover() {
        let (_d, app) = app();
        app.vial_grant(100, NOW - 3600.0);
        spend(&app, json!(0), NOW);
        let src = app.vial_read(NOW).sources(NOW);
        assert_eq!(src, vec![json!({"xp": 70, "ttl": 82800.0})]);
    }
}
