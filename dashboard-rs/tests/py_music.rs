//! Ported from tests/test_music.py: what src/music.rs's own tests don't cover
//! (a JSON-escaped search title, and the local-audio prepare() gate order).

use claudehq::music::{self, MusicState};
use serde_json::json;
use std::os::unix::fs::PermissionsExt;
use std::sync::Arc;

#[test]
fn search_titles_are_json_unescaped() {
    let html = concat!(
        r#"..."videoRenderer":{"videoId":"Uu43993zDMA","thumbnail":{},"title":{"runs":[{"text":"F3miii - FROM YOUR EYES & more"}]},"#,
        r#""ownerText":{"runs":[{"text":"f3miii"}]},"lengthText":{"accessibility":{"accessibilityData":{"label":"2 minutes"}},"simpleText":"2:37"}}"#,
        r#"..."videoRenderer":{"videoId":"Uu43993zDMA"}..."#
    );
    assert_eq!(
        music::parse_search(html, 6),
        vec![json!({"v": "Uu43993zDMA", "title": "F3miii - FROM YOUR EYES & more", "author": "f3miii", "length": "2:37"})]
    );
}

/// The only test in this file that touches PATH/HOME (each integration test
/// file is its own process, and nothing else here reads them).
#[test]
fn prepare_checks_the_tool_then_the_id_then_the_cache() {
    let cache = tempfile::tempdir().unwrap();
    std::fs::write(cache.path().join("dQw4w9WgXcQ.m4a"), b"xxxxxxxxxx").unwrap();
    let m = Arc::new(MusicState::default());

    // A stub yt-dlp on PATH: a cached song is ready, a bad id never reaches the disk.
    let bin = tempfile::tempdir().unwrap();
    let stub = bin.path().join("yt-dlp");
    std::fs::write(&stub, "#!/bin/sh\nexit 0\n").unwrap();
    std::fs::set_permissions(&stub, std::fs::Permissions::from_mode(0o755)).unwrap();
    let home = tempfile::tempdir().unwrap();
    std::env::set_var("HOME", home.path());
    std::env::set_var("PATH", bin.path());
    assert_eq!(serde_json::Value::Object(m.prepare(cache.path(), "dQw4w9WgXcQ", None)), json!({"state": "ready", "ext": "m4a"}));
    assert_eq!(serde_json::Value::Object(m.prepare(cache.path(), "../x", None)), json!({"state": "error", "error": "bad video id"}));

    // No yt-dlp anywhere: "unavailable" comes before the id check. Only
    // assertable where the fixed install dirs (/opt/homebrew/bin, /usr/local/bin)
    // don't hold one either.
    let empty = tempfile::tempdir().unwrap();
    std::env::set_var("PATH", empty.path());
    if music::tool("yt-dlp").is_none() {
        assert_eq!(serde_json::Value::Object(m.prepare(cache.path(), "-", None)), json!({"state": "unavailable"}));
        assert_eq!(serde_json::Value::Object(m.prepare(cache.path(), "dQw4w9WgXcQ", None)), json!({"state": "unavailable"}));
    }
}

#[test]
fn music_config_defaults() {
    let c = claudehq::app::default_config();
    assert_eq!(c["musicShare"], json!(true));
    assert_eq!(c["musicCookies"], json!(""));
}
