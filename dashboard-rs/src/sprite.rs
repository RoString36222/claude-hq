//! Local disk cache for the Pokémon sprite hotlinks (`GET /api/sprite?u=<url>`).
//!
//! The page used to hotlink every sprite on every load. Now it asks this route, which serves
//! `<HQ root>/.sprite-cache/<sha256(url)>.<gif|png|webp>` and fills it from upstream on a miss.
//! The folder is gitignored: the sprites are third-party art and never enter the repo.
//!
//! Not an open proxy: only `https://` URLs under four fixed sprite-library prefixes, a path made
//! of `[A-Za-z0-9._/-]` (no query, fragment, userinfo, port, `%`, `..` or `//`), ending in an
//! image extension; redirects are never followed. The URL carries only a species slug or Pokédex
//! number, exactly what the `<img src>` hotlink already sent.

use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Condvar, Mutex, RwLock};
use std::time::{Duration, SystemTime};

/// The sprite libraries the page hotlinks (Showdown, pkparaiso, PokeAPI via jsDelivr / GitHub raw).
pub const ALLOWED_PREFIXES: [&str; 4] = [
    "https://play.pokemonshowdown.com/sprites/",
    "https://www.pkparaiso.com/imagenes/",
    "https://cdn.jsdelivr.net/gh/PokeAPI/sprites@",
    "https://raw.githubusercontent.com/PokeAPI/sprites/",
];
const EXTS: [&str; 3] = ["gif", "png", "webp"];
pub const MAX_BODY: usize = 2 * 1024 * 1024;
pub const CAP_BYTES: u64 = 200 * 1024 * 1024;
pub const NEG_TTL: Duration = Duration::from_secs(7 * 24 * 3600);
const FETCH_TIMEOUT: Duration = Duration::from_secs(10);
/// Run the size sweep on the first store and then every this many stores.
const SWEEP_EVERY: u32 = 25;

/// What an upstream fetch produced.
#[derive(Debug, Clone, PartialEq)]
pub enum Fetched {
    Ok { ctype: String, body: Vec<u8> },
    NotFound,
    Fail,
}

/// What the route answers.
#[derive(Debug, PartialEq)]
pub enum Sprite {
    Hit { ctype: &'static str, body: Vec<u8> },
    Bad,
    NotFound,
    Fail,
}

pub type FetchFn = Arc<dyn Fn(&str) -> Fetched + Send + Sync>;

/// True for a URL this route may fetch (see the module doc).
pub fn allowed(url: &str) -> bool {
    let Some(prefix) = ALLOWED_PREFIXES.iter().find(|p| url.starts_with(**p)) else { return false };
    let rest = &url[prefix.len()..];
    !rest.is_empty()
        && url.len() <= 400
        && rest.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_./".contains(&b))
        && !rest.contains("..")
        && !url["https://".len()..].contains("//")
        && ext_of(rest).is_some()
}

fn ext_of(url: &str) -> Option<&'static str> {
    let ext = url.rsplit_once('.')?.1;
    EXTS.iter().copied().find(|e| *e == ext)
}

fn ctype_of(ext: &str) -> &'static str {
    match ext {
        "gif" => "image/gif",
        "png" => "image/png",
        _ => "image/webp",
    }
}

/// The image format from the bytes themselves; anything else is refused.
pub fn sniff(body: &[u8]) -> Option<&'static str> {
    if body.starts_with(b"GIF87a") || body.starts_with(b"GIF89a") {
        Some("gif")
    } else if body.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("png")
    } else if body.len() >= 12 && &body[..4] == b"RIFF" && &body[8..12] == b"WEBP" {
        Some("webp")
    } else {
        None
    }
}

/// The real upstream GET: 10 s timeout, no redirects, at most 2 MB, image content-type only.
pub fn http_fetch(url: &str) -> Fetched {
    let agent = ureq::AgentBuilder::new().timeout(FETCH_TIMEOUT).redirects(0).build();
    let ua = format!("ClaudeHQ/{} sprite-cache", crate::app::APP_VERSION);
    match agent.get(url).set("User-Agent", &ua).set("Accept", "image/*").call() {
        Ok(r) if r.status() == 200 => {
            let ctype = r.content_type().to_ascii_lowercase();
            if !ctype.starts_with("image/") {
                return Fetched::Fail;
            }
            let mut body = Vec::new();
            if r.into_reader().take(MAX_BODY as u64 + 1).read_to_end(&mut body).is_err() || body.len() > MAX_BODY {
                return Fetched::Fail;
            }
            Fetched::Ok { ctype, body }
        }
        Ok(_) => Fetched::Fail, // 3xx (redirects are not followed) or another non-200 success
        Err(ureq::Error::Status(404 | 410, _)) => Fetched::NotFound,
        Err(_) => Fetched::Fail,
    }
}

pub struct SpriteCache {
    pub dir: PathBuf,
    pub cap_bytes: u64,
    /// Replaces the upstream fetch (tests).
    pub fetch_hook: RwLock<Option<FetchFn>>,
    inflight: Mutex<HashSet<String>>,
    inflight_cv: Condvar,
    stores: AtomicU32,
}

/// Releases a key's in-flight slot (and wakes waiters) however the fetch ends.
struct Slot<'a> {
    cache: &'a SpriteCache,
    key: String,
}

impl Drop for Slot<'_> {
    fn drop(&mut self) {
        if let Ok(mut s) = self.cache.inflight.lock() {
            s.remove(&self.key);
        }
        self.cache.inflight_cv.notify_all();
    }
}

fn age(p: &Path) -> Option<Duration> {
    let m = std::fs::metadata(p).ok()?.modified().ok()?;
    Some(SystemTime::now().duration_since(m).unwrap_or_default())
}

fn touch(p: &Path) {
    if let Ok(f) = std::fs::File::options().write(true).open(p) {
        let _ = f.set_modified(SystemTime::now());
    }
}

/// tmp file in the same folder + rename, so a reader never sees half a sprite.
fn write_atomic(dir: &Path, name: &str, body: &[u8]) -> std::io::Result<()> {
    let tmp = dir.join(format!(".{}.{}.tmp", name, crate::py::token_hex(4)));
    std::fs::write(&tmp, body)?;
    std::fs::rename(&tmp, dir.join(name)).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })
}

impl SpriteCache {
    pub fn new(dir: PathBuf) -> SpriteCache {
        SpriteCache {
            dir,
            cap_bytes: CAP_BYTES,
            fetch_hook: RwLock::new(None),
            inflight: Mutex::new(HashSet::new()),
            inflight_cv: Condvar::new(),
            stores: AtomicU32::new(0),
        }
    }

    pub fn key(url: &str) -> String {
        hex::encode(Sha256::digest(url.as_bytes()))
    }

    fn cached(&self, key: &str) -> Option<Sprite> {
        for ext in EXTS {
            let p = self.dir.join(format!("{}.{}", key, ext));
            if let Ok(body) = std::fs::read(&p) {
                touch(&p);
                return Some(Sprite::Hit { ctype: ctype_of(ext), body });
            }
        }
        let neg = self.dir.join(format!("{}.404", key));
        match age(&neg) {
            Some(a) if a < NEG_TTL => Some(Sprite::NotFound),
            Some(_) => {
                let _ = std::fs::remove_file(&neg);
                None
            }
            None => None,
        }
    }

    /// Wait for any other request fetching this key, then claim it.
    fn claim(&self, key: &str) -> Slot<'_> {
        let mut set = self.inflight.lock().unwrap_or_else(|e| e.into_inner());
        while set.contains(key) {
            let (s, t) = self.inflight_cv.wait_timeout(set, FETCH_TIMEOUT * 2).unwrap_or_else(|e| e.into_inner());
            set = s;
            if t.timed_out() {
                break; // a wedged fetch: go ahead (the atomic rename keeps a double write safe)
            }
        }
        set.insert(key.to_string());
        Slot { cache: self, key: key.to_string() }
    }

    pub fn get(&self, url: &str) -> Sprite {
        if !allowed(url) {
            return Sprite::Bad;
        }
        let key = Self::key(url);
        if let Some(s) = self.cached(&key) {
            return s;
        }
        let _slot = self.claim(&key);
        if let Some(s) = self.cached(&key) {
            return s; // filled while we waited
        }
        let hook = self.fetch_hook.read().ok().and_then(|h| h.clone());
        let got = match hook {
            Some(f) => f(url),
            None => http_fetch(url),
        };
        let _ = std::fs::create_dir_all(&self.dir);
        match got {
            Fetched::Ok { ctype, body } => {
                let Some(ext) = sniff(&body).filter(|_| ctype.starts_with("image/") && body.len() <= MAX_BODY) else {
                    return Sprite::Fail;
                };
                if write_atomic(&self.dir, &format!("{}.{}", key, ext), &body).is_ok() {
                    let _ = std::fs::remove_file(self.dir.join(format!("{}.404", key)));
                    if self.stores.fetch_add(1, Ordering::Relaxed).is_multiple_of(SWEEP_EVERY) {
                        self.sweep();
                    }
                }
                Sprite::Hit { ctype: ctype_of(ext), body }
            }
            Fetched::NotFound => {
                let _ = write_atomic(&self.dir, &format!("{}.404", key), b"");
                Sprite::NotFound
            }
            Fetched::Fail => Sprite::Fail,
        }
    }

    /// Drop expired 404 markers and stale tmp files; if the sprites exceed the cap, delete the
    /// least recently used (oldest mtime; hits touch it) until they fit in 90% of it.
    pub fn sweep(&self) {
        let Ok(rd) = std::fs::read_dir(&self.dir) else { return };
        let mut files: Vec<(SystemTime, u64, PathBuf)> = Vec::new();
        let mut total = 0u64;
        for e in rd.flatten() {
            let p = e.path();
            let Ok(md) = e.metadata() else { continue };
            if !md.is_file() {
                continue;
            }
            let name = e.file_name().to_string_lossy().into_owned();
            let a = age(&p).unwrap_or_default();
            if name.ends_with(".tmp") {
                if a > Duration::from_secs(3600) {
                    let _ = std::fs::remove_file(&p);
                }
                continue;
            }
            if name.ends_with(".404") {
                if a >= NEG_TTL {
                    let _ = std::fs::remove_file(&p);
                }
                continue;
            }
            total += md.len();
            files.push((md.modified().unwrap_or(SystemTime::UNIX_EPOCH), md.len(), p));
        }
        if total <= self.cap_bytes {
            return;
        }
        files.sort();
        let target = self.cap_bytes / 10 * 9;
        for (_, len, p) in files {
            if total <= target {
                break;
            }
            if std::fs::remove_file(&p).is_ok() {
                total -= len;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::sync::atomic::AtomicUsize;

    const SD: &str = "https://play.pokemonshowdown.com/sprites/ani/pikachu.gif";
    const GIF: &[u8] = b"GIF89a\x01\x00\x01\x00tiny";

    fn cache_with(f: impl Fn(&str) -> Fetched + Send + Sync + 'static) -> (tempfile::TempDir, SpriteCache) {
        let d = tempfile::tempdir().unwrap();
        let c = SpriteCache::new(d.path().join(".sprite-cache"));
        *c.fetch_hook.write().unwrap() = Some(Arc::new(f));
        (d, c)
    }

    #[test]
    fn allowlist_accepts_the_page_sprite_urls() {
        for u in [
            SD,
            "https://play.pokemonshowdown.com/sprites/ani-shiny/charizard-megax.gif",
            "https://play.pokemonshowdown.com/sprites/ani-back-shiny/mr.mime.gif",
            "https://www.pkparaiso.com/imagenes/xy/sprites/animados/pikachu.gif",
            "https://www.pkparaiso.com/imagenes/rubi-omega-zafiro-alfa/sprites/animados-shiny/salamence-mega.gif",
            "https://cdn.jsdelivr.net/gh/PokeAPI/sprites@master/sprites/pokemon/versions/generation-v/black-white/animated/shiny/25.gif",
            "https://cdn.jsdelivr.net/gh/PokeAPI/sprites@master/sprites/pokemon/other/home/shiny/25.png",
            "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/25.png",
        ] {
            assert!(allowed(u), "{}", u);
        }
    }

    #[test]
    fn allowlist_rejects_other_hosts_schemes_and_tricks() {
        for u in [
            "",
            "http://play.pokemonshowdown.com/sprites/ani/pikachu.gif",
            "HTTPS://play.pokemonshowdown.com/sprites/ani/pikachu.gif",
            "https://evil.example/sprites/ani/pikachu.gif",
            "https://play.pokemonshowdown.com/ani/pikachu.gif",
            "https://play.pokemonshowdown.com.evil.example/sprites/ani/pikachu.gif",
            "https://play.pokemonshowdown.com@evil.example/sprites/ani/pikachu.gif",
            "https://user@play.pokemonshowdown.com/sprites/ani/pikachu.gif",
            "https://play.pokemonshowdown.com:8443/sprites/ani/pikachu.gif",
            "https://play.pokemonshowdown.com/sprites/ani/pikachu.gif?x=1",
            "https://play.pokemonshowdown.com/sprites/ani/pikachu.gif#a",
            "https://play.pokemonshowdown.com/sprites/../../etc/passwd.gif",
            "https://play.pokemonshowdown.com/sprites//evil.example/a.gif",
            "https://play.pokemonshowdown.com/sprites/%2e%2e/a.gif",
            "https://play.pokemonshowdown.com/sprites/a%40evil.example.gif",
            "https://play.pokemonshowdown.com/sprites/ani\\@evil.example/a.gif",
            "https://play.pokemonshowdown.com/sprites/ani/pikachu.svg",
            "https://play.pokemonshowdown.com/sprites/ani/pikachu.html",
            "https://play.pokemonshowdown.com/sprites/",
            "https://cdn.jsdelivr.net/gh/someone-else/repo@main/a.png",
            "https://cdn.jsdelivr.net/npm/x/a.png",
            "https://raw.githubusercontent.com/attacker/sprites/a.png",
            "file:///etc/passwd.png",
            "https://play.pokemonshowdown.com/sprites/ani/pika chu.gif",
        ] {
            assert!(!allowed(u), "{}", u);
        }
        let (_d, c) = cache_with(|_| panic!("a rejected URL must never be fetched"));
        assert_eq!(c.get("https://127.0.0.1/sprites/a.gif"), Sprite::Bad);
    }

    #[test]
    fn miss_stores_then_hits_from_disk() {
        let n = Arc::new(AtomicUsize::new(0));
        let n2 = n.clone();
        let (_d, c) = cache_with(move |_| {
            n2.fetch_add(1, Ordering::SeqCst);
            Fetched::Ok { ctype: "image/gif".into(), body: GIF.to_vec() }
        });
        assert_eq!(c.get(SD), Sprite::Hit { ctype: "image/gif", body: GIF.to_vec() });
        assert_eq!(c.get(SD), Sprite::Hit { ctype: "image/gif", body: GIF.to_vec() });
        assert_eq!(n.load(Ordering::SeqCst), 1);
        assert!(c.dir.join(format!("{}.gif", SpriteCache::key(SD))).is_file());
        // no tmp files left behind
        assert_eq!(std::fs::read_dir(&c.dir).unwrap().count(), 1);
    }

    #[test]
    fn non_images_and_failures_are_not_cached() {
        let (_d, c) = cache_with(|u| {
            if u.ends_with("html.gif") {
                Fetched::Ok { ctype: "text/html".into(), body: GIF.to_vec() }
            } else if u.ends_with("lie.gif") {
                Fetched::Ok { ctype: "image/gif".into(), body: b"<svg onload=x>".to_vec() }
            } else {
                Fetched::Fail
            }
        });
        for slug in ["html", "lie", "down"] {
            let u = format!("https://play.pokemonshowdown.com/sprites/ani/{}.gif", slug);
            assert_eq!(c.get(&u), Sprite::Fail);
        }
        assert!(std::fs::read_dir(&c.dir).map(|r| r.count()).unwrap_or(0) == 0);
    }

    #[test]
    fn upstream_404_is_negative_cached_then_expires() {
        let n = Arc::new(AtomicUsize::new(0));
        let n2 = n.clone();
        let (_d, c) = cache_with(move |_| {
            n2.fetch_add(1, Ordering::SeqCst);
            Fetched::NotFound
        });
        assert_eq!(c.get(SD), Sprite::NotFound);
        assert_eq!(c.get(SD), Sprite::NotFound);
        assert_eq!(n.load(Ordering::SeqCst), 1);
        // age the marker past the TTL: the next request asks upstream again
        let neg = c.dir.join(format!("{}.404", SpriteCache::key(SD)));
        let f = std::fs::File::options().write(true).open(&neg).unwrap();
        f.set_modified(SystemTime::now() - NEG_TTL - Duration::from_secs(60)).unwrap();
        assert_eq!(c.get(SD), Sprite::NotFound);
        assert_eq!(n.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn concurrent_misses_fetch_once() {
        let n = Arc::new(AtomicUsize::new(0));
        let n2 = n.clone();
        let (_d, c) = cache_with(move |_| {
            n2.fetch_add(1, Ordering::SeqCst);
            std::thread::sleep(Duration::from_millis(150));
            Fetched::Ok { ctype: "image/gif".into(), body: GIF.to_vec() }
        });
        let c = Arc::new(c);
        let hs: Vec<_> = (0..6)
            .map(|_| {
                let c = c.clone();
                std::thread::spawn(move || c.get(SD))
            })
            .collect();
        for h in hs {
            assert!(matches!(h.join().unwrap(), Sprite::Hit { .. }));
        }
        assert_eq!(n.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn sweep_evicts_least_recently_used_over_the_cap() {
        let body = |k: u8| {
            let mut b = GIF.to_vec();
            b.extend(std::iter::repeat_n(k, 1000));
            b
        };
        let (_d, mut c) = cache_with(move |u| {
            let k = u.as_bytes()[u.len() - 5];
            Fetched::Ok { ctype: "image/gif".into(), body: body(k) }
        });
        c.cap_bytes = 3000; // room for two ~1 KB sprites after the sweep's 90% target
        let url = |k: char| format!("https://play.pokemonshowdown.com/sprites/ani/{}.gif", k);
        let path = |k: char| c.dir.join(format!("{}.gif", SpriteCache::key(&url(k))));
        let t0 = SystemTime::now() - Duration::from_secs(1000);
        for (i, k) in ['a', 'b', 'c', 'd'].into_iter().enumerate() {
            assert!(matches!(c.get(&url(k)), Sprite::Hit { .. }));
            let f = std::fs::File::options().write(true).open(path(k)).unwrap();
            f.set_modified(t0 + Duration::from_secs(i as u64 * 10)).unwrap();
        }
        // a hit refreshes 'a', so 'b' and 'c' are now the oldest
        assert!(matches!(c.get(&url('a')), Sprite::Hit { .. }));
        c.sweep();
        assert!(path('a').is_file() && path('d').is_file());
        assert!(!path('b').is_file() && !path('c').is_file());
    }

    /// The real fetcher against a local one-shot HTTP server (the route itself never allows
    /// a local URL; this checks the fetcher's own rules).
    fn one_shot(resp: Vec<u8>) -> String {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        std::thread::spawn(move || {
            if let Ok((mut s, _)) = l.accept() {
                let mut buf = [0u8; 2048];
                let _ = s.read(&mut buf);
                let _ = s.write_all(&resp);
            }
        });
        format!("http://127.0.0.1:{}/a.gif", port)
    }

    fn resp(status: &str, extra: &str, body: &[u8]) -> Vec<u8> {
        let mut r = format!("HTTP/1.1 {}\r\n{}Content-Length: {}\r\nConnection: close\r\n\r\n", status, extra, body.len()).into_bytes();
        r.extend_from_slice(body);
        r
    }

    #[test]
    fn real_fetch_ok_404_redirect_non_image_and_oversize() {
        let u = one_shot(resp("200 OK", "Content-Type: image/gif\r\n", GIF));
        assert_eq!(http_fetch(&u), Fetched::Ok { ctype: "image/gif".into(), body: GIF.to_vec() });
        assert_eq!(http_fetch(&one_shot(resp("404 Not Found", "", b"nope"))), Fetched::NotFound);
        let redirect = resp("302 Found", "Location: https://evil.example/a.gif\r\n", b"");
        assert_eq!(http_fetch(&one_shot(redirect)), Fetched::Fail);
        assert_eq!(http_fetch(&one_shot(resp("200 OK", "Content-Type: text/html\r\n", b"<p>"))), Fetched::Fail);
        let big = vec![b'x'; MAX_BODY + 10];
        assert_eq!(http_fetch(&one_shot(resp("200 OK", "Content-Type: image/png\r\n", &big))), Fetched::Fail);
        assert_eq!(http_fetch(&one_shot(resp("500 Oops", "", b""))), Fetched::Fail);
        assert_eq!(http_fetch("http://127.0.0.1:1/a.gif"), Fetched::Fail);
    }
}
