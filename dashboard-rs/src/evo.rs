//! Evolution picks (which branch / Mega form a session's Pokemon becomes),
//! kept server-side in evo-choices.json (0600, git-ignored, never leaves the
//! machine) so the notch and every browser agree. They ride in /api/sessions
//! as `creature.evo`. The allowed values are read from
//! ui/app/06-trainer-packs.js itself (POKE_EVO / POKE_BRANCH / MEGA_FORMS), so
//! the server and the page cannot disagree on what is valid.

use crate::app::{is_uuid, App};
use crate::creature::session_hash_mod;
use crate::py::{self, Obj};
use crate::state;
use regex::Regex;
use serde_json::{Map, Value};
use std::collections::{BTreeSet, HashMap};
use std::sync::LazyLock;

/// Sessions kept (the oldest picks drop beyond this).
pub const EVO_MAX: usize = 2000;

/// ({species: final dexes it may become}, {final dex: mega slugs}).
#[derive(Default, Debug)]
pub struct EvoTables {
    pub finals: HashMap<i64, BTreeSet<i64>>,
    pub megas: HashMap<i64, BTreeSet<String>>,
}

static BRANCH_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(\d+):\[(\{.*?\})\]").unwrap());
static MEGA_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(\d+):\[(\{name:.*?\})\]").unwrap());
static DEX_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"dex:(\d+)").unwrap());
static SLUG_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"slug:"([a-z0-9-]+)""#).unwrap());

/// Parse the tables out of the page's 06-trainer-packs.js source. Like the
/// Python, a POKE_EVO that is not JSON leaves both tables empty.
pub fn parse_evo_tables(js: &str) -> EvoTables {
    let var = |name: &str| -> String {
        let re = Regex::new(&format!(r"(?s)var {}=(.*?);\n", regex::escape(name))).unwrap();
        re.captures(js).map(|c| c[1].to_string()).unwrap_or_default()
    };
    let mut t = EvoTables::default();
    let evo = var("POKE_EVO");
    let Ok(Value::Array(lines)) = serde_json::from_str::<Value>(if evo.is_empty() { "[]" } else { &evo }) else { return t };
    for (i, line) in lines.iter().enumerate() {
        if let Some(last) = line.as_array().and_then(|a| a.last()) {
            let Some(d) = py::py_int(last) else { return t };
            t.finals.insert(i as i64, BTreeSet::from([d]));
        }
    }
    for c in BRANCH_RE.captures_iter(&var("POKE_BRANCH")) {
        let Ok(idx) = c[1].parse::<i64>() else { continue };
        let set = t.finals.entry(idx).or_default();
        set.extend(DEX_RE.captures_iter(&c[2]).filter_map(|d| d[1].parse::<i64>().ok()));
    }
    for c in MEGA_RE.captures_iter(&var("MEGA_FORMS")) {
        let Ok(key) = c[1].parse::<i64>() else { continue };
        t.megas.insert(key, SLUG_RE.captures_iter(&c[2]).map(|s| s[1].to_string()).collect());
    }
    t
}

impl App {
    /// The tables, parsed once from ui/app/06-trainer-packs.js.
    pub fn evo_tables(&self) -> &EvoTables {
        self.evo_tables.get_or_init(|| {
            let js = std::fs::read(self.paths.ui_dir.join("app").join("06-trainer-packs.js"))
                .ok()
                .and_then(|b| String::from_utf8(b).ok())
                .unwrap_or_default();
            parse_evo_tables(&js)
        })
    }

    /// This session's pick, keeping only what is valid for its species:
    /// {branchDex?, megaSlug?}; empty when nothing in it is.
    pub fn clean_evo_choice(&self, sid: &str, entry: &Value) -> Obj {
        let mut out = Map::new();
        let Value::Object(entry) = entry else { return out };
        if !is_uuid(sid) {
            return out;
        }
        let t = self.evo_tables();
        let empty = BTreeSet::new();
        let allowed = t.finals.get(&(session_hash_mod(sid, 48) as i64)).unwrap_or(&empty);
        if let Some(b) = entry.get("branchDex").and_then(py::strict_int) {
            if allowed.contains(&b) && allowed.len() > 1 {
                out.insert("branchDex".into(), Value::from(b));
            }
        }
        // a Mega must belong to the chosen final, or (no branch picked) to any final it may become
        let finals_now: Vec<i64> = match out.get("branchDex").and_then(|v| v.as_i64()) {
            Some(b) => vec![b],
            None => allowed.iter().copied().collect(),
        };
        let in_pool = |m: &str| finals_now.iter().any(|d| t.megas.get(d).map(|s| s.contains(m)).unwrap_or(false));
        if let Some(Value::String(m)) = entry.get("megaSlug") {
            if in_pool(m) {
                out.insert("megaSlug".into(), Value::from(m.clone()));
            }
        }
        out
    }

    /// evo-choices.json -> {sessionId: {branchDex?, megaSlug?}} (validated).
    pub fn load_evo_choices(&self) -> Obj {
        let mut out = Map::new();
        if let Some(Value::Object(raw)) = state::load_json_guarded(&self.paths.evo_choices) {
            for (sid, entry) in raw {
                let e = self.clean_evo_choice(&sid, &entry);
                if !e.is_empty() {
                    out.insert(sid, Value::Object(e));
                }
            }
        }
        out
    }

    /// Merge a pick into this session's entry (a null field clears it),
    /// persist, return the entry. Err(Bad) for a bad session id or a pick that
    /// is not valid for this session's Pokemon (nothing is written then).
    pub fn save_evo_choice(&self, sid: Option<&Value>, patch: &Value) -> Result<Obj, EvoError> {
        let sid = match sid {
            Some(Value::String(s)) if is_uuid(s) => s.as_str(),
            _ => return Err(EvoError::Bad("invalid sessionId".into())),
        };
        let Value::Object(patch) = patch else { return Err(EvoError::Bad("bad pick".into())) };
        let _g = self.evo_lock.lock().unwrap();
        let mut data = self.load_evo_choices();
        let mut cur = data.get(sid).and_then(|v| v.as_object()).cloned().unwrap_or_default();
        for k in ["branchDex", "megaSlug"] {
            match patch.get(k) {
                Some(Value::Null) => {
                    cur.shift_remove(k);
                }
                Some(v) => {
                    cur.insert(k.into(), v.clone());
                }
                None => {}
            }
        }
        let entry = self.clean_evo_choice(sid, &Value::Object(cur));
        for k in ["branchDex", "megaSlug"] {
            let want = patch.get(k).filter(|v| !v.is_null());
            if want.is_some() && entry.get(k) != want {
                return Err(EvoError::Bad(format!("{} is not a valid pick for this session's Pokemon", k)));
            }
        }
        data.shift_remove(sid);
        if !entry.is_empty() {
            data.insert(sid.to_string(), Value::Object(entry.clone())); // newest last, so a trim keeps it
        }
        if data.len() > EVO_MAX {
            let skip = data.len() - EVO_MAX;
            data = data.into_iter().skip(skip).collect();
        }
        state::atomic_write_json(&self.paths.evo_choices, &Value::Object(data), 0o600).map_err(EvoError::Io)?;
        Ok(entry)
    }
}

pub enum EvoError {
    Bad(String),
    Io(std::io::Error),
}

/// Put each session's pick on its creature as `creature.evo` (only where one
/// exists, so every other session's payload is unchanged).
pub fn merge_evo_choices(sessions: &mut [Value], evo: &Obj) {
    for s in sessions.iter_mut() {
        let Some(sid) = s.get("sessionId").and_then(|v| v.as_str()).map(String::from) else { continue };
        let Some(pick) = evo.get(&sid) else { continue };
        if let Some(Value::Object(c)) = s.get_mut("creature") {
            c.insert("evo".into(), pick.clone());
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::app::testutil::app;
    use serde_json::json;

    /// A session id whose Pokemon is this species (species = sha256(sid) % 48),
    /// found the same way tests/test_evo_choice.py does.
    pub fn sid_for(species: u64) -> String {
        let mut i: u128 = 0;
        loop {
            let n = i.wrapping_mul(2654435761);
            let h = format!("{:032x}", n);
            let sid = format!("{}-{}-{}-{}-{}", &h[..8], &h[8..12], &h[12..16], &h[16..20], &h[20..]);
            if session_hash_mod(&sid, 48) == species {
                return sid;
            }
            i += 1;
        }
    }

    fn with_page() -> (tempfile::TempDir, std::sync::Arc<App>) {
        let (d, app) = app();
        let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../ui/app/06-trainer-packs.js");
        std::fs::create_dir_all(app.paths.ui_dir.join("app")).unwrap();
        std::fs::copy(src, app.paths.ui_dir.join("app/06-trainer-packs.js")).unwrap();
        (d, app)
    }

    fn o(v: Value) -> Obj {
        v.as_object().unwrap().clone()
    }

    #[test]
    fn tables_come_from_the_page() {
        let (_d, app) = with_page();
        let t = app.evo_tables();
        assert_eq!(t.finals.len(), 48);
        assert_eq!(t.finals[&4], BTreeSet::from([134, 135, 136, 196, 197, 470, 471, 700])); // Eevee's eight
        assert_eq!(t.finals[&1], BTreeSet::from([6])); // Charizard's line
        assert_eq!(t.megas[&6], BTreeSet::from(["charizard-megax".to_string(), "charizard-megay".to_string()]));
    }

    #[test]
    fn clean() {
        let (_d, app) = with_page();
        let (eevee, zard, pika) = (sid_for(4), sid_for(1), sid_for(0));
        let c = |s: &str, v: Value| Value::Object(app.clean_evo_choice(s, &v));
        assert_eq!(c(&eevee, json!({"branchDex": 197})), json!({"branchDex": 197}));
        assert_eq!(c(&eevee, json!({"branchDex": 25})), json!({}));
        assert_eq!(c(&eevee, json!({"branchDex": true})), json!({}));
        assert_eq!(c(&eevee, json!({"branchDex": 197.0})), json!({}));
        assert_eq!(c(&zard, json!({"megaSlug": "charizard-megay"})), json!({"megaSlug": "charizard-megay"}));
        assert_eq!(c(&zard, json!({"megaSlug": "gengar-mega"})), json!({}));
        assert_eq!(c(&zard, json!({"branchDex": 6})), json!({})); // no branch to pick
        assert_eq!(c(&pika, json!({"megaSlug": "charizard-megax"})), json!({}));
        assert_eq!(c("not-a-uuid", json!({"branchDex": 197})), json!({}));
        assert_eq!(c(&eevee, json!("x")), json!({}));
    }

    #[test]
    fn round_trip_and_clear() {
        let (_d, app) = with_page();
        let eevee = sid_for(4);
        let s = json!(eevee);
        assert_eq!(app.save_evo_choice(Some(&s), &json!({"branchDex": 197})).ok(), Some(o(json!({"branchDex": 197}))));
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(&app.paths.evo_choices).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(app.load_evo_choices(), o(json!({eevee.clone(): {"branchDex": 197}})));
        assert_eq!(app.save_evo_choice(Some(&s), &json!({"branchDex": 700})).ok(), Some(o(json!({"branchDex": 700}))));
        assert_eq!(app.save_evo_choice(Some(&s), &json!({"branchDex": null})).ok(), Some(Map::new()));
        assert_eq!(app.load_evo_choices(), Map::new());
    }

    #[test]
    fn a_bad_pick_writes_nothing() {
        let (_d, app) = with_page();
        let (eevee, zard) = (sid_for(4), sid_for(1));
        assert!(app.save_evo_choice(Some(&json!(zard)), &json!({"megaSlug": "charizard-megax"})).is_ok());
        for (sid, patch) in [(json!(zard), json!({"megaSlug": "nope"})), (json!(eevee), json!({"branchDex": 1})), (json!("x"), json!({"branchDex": 197}))] {
            assert!(matches!(app.save_evo_choice(Some(&sid), &patch), Err(EvoError::Bad(_))));
        }
        assert_eq!(app.load_evo_choices(), o(json!({zard: {"megaSlug": "charizard-megax"}})));
    }

    #[test]
    fn a_tampered_file_is_cleaned_on_read() {
        let (_d, app) = with_page();
        let (eevee, zard) = (sid_for(4), sid_for(1));
        let raw = json!({eevee: {"branchDex": 25}, zard.clone(): {"megaSlug": "charizard-megay", "x": 1}, "junk": {}});
        std::fs::write(&app.paths.evo_choices, crate::pyjson::dumps(&raw)).unwrap();
        assert_eq!(app.load_evo_choices(), o(json!({zard: {"megaSlug": "charizard-megay"}})));
    }

    #[test]
    fn payload_carries_it_only_where_picked() {
        let (eevee, pika) = (sid_for(4), sid_for(0));
        let mut sessions = vec![json!({"sessionId": eevee, "creature": {"species": 4}}), json!({"sessionId": pika, "creature": {"species": 0}})];
        merge_evo_choices(&mut sessions, &o(json!({eevee: {"branchDex": 197}})));
        assert_eq!(sessions[0]["creature"]["evo"], json!({"branchDex": 197}));
        assert!(sessions[1]["creature"].get("evo").is_none());
    }
}
