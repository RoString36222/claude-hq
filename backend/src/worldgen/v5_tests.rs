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
    // the layers the client reads (v5/doc.rs)
    assert!(l.lots.iter().filter(|x| x.kind == "hq").count() > 10, "an HQ pool");
    assert!(l.sites.iter().any(|s| s.kind == "spawn"));
    assert!(l.sites.iter().any(|s| s.kind == "airport" && s.runway.as_ref().is_some_and(|r| r.len == v5::airport::RUNWAY_CM)));
    let m = l.metro.as_ref().unwrap();
    assert!(m.lines.len() >= 3 && m.entrances.len() >= 2 * m.stations.len());
    let rl = l.rail.as_ref().unwrap();
    assert!(rl.lines.len() == 2 && rl.lines.iter().all(|x| x.kinds.len() + 1 == x.path.len()));
    for n in &l.roads.nodes {
        assert!(l.roads.edges.iter().any(|e| e.a == n.id || e.b == n.id), "node {} on no road", n.id);
    }
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
