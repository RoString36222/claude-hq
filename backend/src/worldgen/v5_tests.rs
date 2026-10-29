//! City Gen v5 (generator version 4, docs/plans/city-gen-v5.md): the city planned in a volume, as the doc's layers.

use super::*;

/// The planned Commons fills its island and breaks nothing the validator holds hard.
#[test]
fn the_planned_commons_fills_its_island() {
    let w = generate("claude-hq@4", &[]).unwrap();
    let l = &w.layers;
    assert!(l.lots.len() >= 300, "{} lots", l.lots.len());
    let far = l.lots.iter().filter(|q| (q.x * q.x + q.z * q.z) > 50_000i64 * 50_000).count();
    assert!(far >= 50, "{far} lots past 500 m");
    let v = validate::hard(l);
    assert!(v.is_empty(), "{}", validate::report(&v));
}

/// A personal island at v5 generates and breaks no hard rule.
#[test]
fn a_planned_island_generates() {
    let w = generate("user:11111111-1111-1111-1111-111111111111@4", &[]).unwrap();
    let v = validate::hard(&w.layers);
    assert!(v.is_empty(), "{}", validate::report(&v));
}
