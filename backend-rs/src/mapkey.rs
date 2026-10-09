//! Content keys for user-made maps: same kind + same canonical data => same key.
use serde_json::Value;
use sha2::{Digest, Sha256};

/// "c-" + first 12 hex of sha256("<kind>:" + compact JSON of CANONICAL `data` (as returned by <game>::validate_custom)).
#[allow(dead_code)]
pub fn content_key(kind: &str, data: &Value) -> String {
    let body = serde_json::to_string(data).unwrap_or_default();
    let mut h = Sha256::new();
    h.update(kind.as_bytes());
    h.update(b":");
    h.update(body.as_bytes());
    let hex = hex::encode(h.finalize());
    format!("c-{}", &hex[..12])
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_same_input_gives_the_same_key() {
        let d = json!({"tiles": "FSSRSSRSSRSR", "scenery": "forest"});
        assert_eq!(content_key("kart", &d), content_key("kart", &d.clone()));
        assert_ne!(content_key("kart", &d), content_key("plat", &d));
    }

    #[test]
    fn the_key_is_c_dash_twelve_hex() {
        let k = content_key("fps", &json!({}));
        assert_eq!(k.len(), 14);
        assert!(k.starts_with("c-"));
        assert!(k[2..].bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)));
    }
}
