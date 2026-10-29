//! City Gen v5 (generator version 4, docs/plans/city-gen-v5.md): the planned city, built alongside @3.

use super::*;

/// The planned Commons fills its island: a downtown grid, a grid in every sector between the avenues, its blocks and
/// lots out past @3's 480 m town, and nothing the validator holds hard is broken.
#[test]
fn the_planned_commons_fills_its_island() {
    let w = generate("claude-hq@4", &[]).unwrap();
    let l = &w.layers;
    assert!(l.blocks.len() >= 120, "{} blocks", l.blocks.len());
    assert!(l.lots.len() >= 800, "{} lots", l.lots.len());
    let far = l.lots.iter().filter(|q| (q.x * q.x + q.z * q.z) > 60_000i64 * 60_000).count();
    assert!(far >= 200, "{far} lots past 600 m");
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
