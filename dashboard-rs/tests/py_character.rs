//! Ported from tests/test_character.py: the portrait upload is a registered
//! state-changing route (its validation is arena::tests::portraits, the
//! character config is app::tests::character_and_trainer_specs).

#[test]
fn portrait_is_a_registered_post_path() {
    assert!(claudehq::server::post_paths().contains(&"/api/arena/portrait"));
}
