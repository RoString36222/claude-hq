//! Ported from tests/test_pantry_proxy.py NotifyTests: nudges ping, gifts
//! arrive silently, and the AppleScript literal keeps emoji and cannot be
//! broken out of. One test in its own binary, because it points PATH at a fake
//! `osascript` that records the script instead of showing a notification.

use claudehq::actions::{applescript_str, notify};

#[test]
fn notify_scripts_and_applescript_literals() {
    // The real osascript parses an emoji title back unchanged (`return` shows
    // nothing on screen).
    let title = "\u{1F381} Gary \"G\" sent you a gift \\ é";
    if cfg!(target_os = "macos") && std::path::Path::new("/usr/bin/osascript").exists() {
        let out = std::process::Command::new("/usr/bin/osascript").args(["-e", &format!("return {}", applescript_str(title))]).output().unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim_end_matches('\n'), title, "{}", String::from_utf8_lossy(&out.stderr));
    }

    let dir = tempfile::tempdir().unwrap();
    let log = dir.path().join("argv.txt");
    let fake = dir.path().join("osascript");
    std::fs::write(&fake, format!("#!/bin/sh\nprintf '%s\\n' \"$2\" >> '{}'\n", log.display())).unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
    std::env::set_var("PATH", dir.path());

    notify("\u{1F44B} Ash nudged you", "Ash nudged you: hi", true).unwrap();
    notify("\u{1F381} Gary sent you a gift", "2 Poke Coins", false).unwrap();
    let text = std::fs::read_to_string(&log).unwrap();
    let lines: Vec<&str> = text.lines().collect();
    assert_eq!(lines.len(), 2, "{:?}", lines);
    let (loud, quiet) = (lines[0], lines[1]);
    assert!(loud.ends_with(" sound name \"Ping\""), "{}", loud);
    assert!(!quiet.contains("sound name"), "{}", quiet);
    assert!(quiet.contains("\u{1F381} Gary sent you a gift"));
    assert!(!format!("{}{}", loud, quiet).contains("\\u"));
}
