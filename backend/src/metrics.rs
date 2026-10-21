//! Prometheus metrics for the Arena: `GET /metrics` in the text exposition
//! format, on its OWN listener (`ARENA_METRICS_BIND`, e.g. `0.0.0.0:9091`).
//!
//! The main router never serves it, so Caddy (which proxies only app:8080)
//! never exposes it to the internet: only Prometheus on the compose network
//! can scrape it. Unset `ARENA_METRICS_BIND` and nothing listens.
//!
//! Counts, never who. Labels are the HTTP method, the ROUTE TEMPLATE
//! (`/v1/rooms/:room_id/ws`, from axum's `MatchedPath`, never the raw path)
//! and the status code, so no room id, user id or handle ever becomes a label
//! and the series count stays bounded. Room figures are aggregates, as in
//! server_stats.rs.
//!
//! Hand-rolled rather than a crate: a few counters, one histogram and some
//! gauges read at scrape time.

use axum::{
    extract::{MatchedPath, Request, State},
    http::header,
    middleware::Next,
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use serde_json::Value;
use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

/// Request latency buckets (seconds): API calls sit in the first few, world
/// generation and big list queries in the middle, anything past 5 s is a stall.
const BUCKETS: [f64; 12] = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0];

#[derive(Default, Clone)]
struct Hist {
    /// Per bucket (not cumulative); rendered cumulatively.
    counts: [u64; BUCKETS.len()],
    sum: f64,
    n: u64,
}

impl Hist {
    fn observe(&mut self, v: f64) {
        if let Some(i) = BUCKETS.iter().position(|&b| v <= b) {
            self.counts[i] += 1;
        }
        self.sum += v;
        self.n += 1;
    }
}

#[derive(Default)]
struct Http {
    /// (method, route, status) -> requests
    reqs: BTreeMap<(&'static str, String, u16), u64>,
    /// (method, route) -> latency
    lat: BTreeMap<(&'static str, String), Hist>,
}

static HTTP: LazyLock<Mutex<Http>> = LazyLock::new(Default::default);
static IN_FLIGHT: AtomicI64 = AtomicI64::new(0);
static WS_OPEN: AtomicI64 = AtomicI64::new(0);
static WS_TOTAL: AtomicU64 = AtomicU64::new(0);
/// Process start, forced in [`init`] so uptime counts from boot.
static STARTED: LazyLock<(Instant, f64)> = LazyLock::new(|| {
    (Instant::now(), SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0))
});

/// Call once at boot.
pub fn init() {
    LazyLock::force(&STARTED);
}

/// A fixed set, so a client cannot mint label values with made-up methods.
fn method_label(m: &axum::http::Method) -> &'static str {
    match m.as_str() {
        "GET" => "GET",
        "POST" => "POST",
        "PUT" => "PUT",
        "PATCH" => "PATCH",
        "DELETE" => "DELETE",
        "HEAD" => "HEAD",
        "OPTIONS" => "OPTIONS",
        _ => "OTHER",
    }
}

fn record(method: &'static str, route: &str, status: u16, secs: f64) {
    let mut h = HTTP.lock().expect("metrics mutex");
    *h.reqs.entry((method, route.to_owned(), status)).or_default() += 1;
    h.lat.entry((method, route.to_owned())).or_default().observe(secs);
}

/// Decrements the in-flight gauge even when the handler's future is dropped.
struct InFlight;
impl Drop for InFlight {
    fn drop(&mut self) {
        IN_FLIGHT.fetch_sub(1, Ordering::Relaxed);
    }
}

/// Middleware for the whole router (`Router::layer`, so `MatchedPath` is set).
/// The time is to the response head: a websocket upgrade or the board's
/// event stream counts its handshake, not its lifetime.
pub async fn track(req: Request, next: Next) -> Response {
    let method = method_label(req.method());
    let route = req.extensions().get::<MatchedPath>()
        .map(|p| p.as_str().to_owned())
        .unwrap_or_else(|| "unmatched".into());
    IN_FLIGHT.fetch_add(1, Ordering::Relaxed);
    let _g = InFlight;
    let t = Instant::now();
    let res = next.run(req).await;
    record(method, &route, res.status().as_u16(), t.elapsed().as_secs_f64());
    res
}

/// Held for a room websocket's lifetime (main.rs `handle_socket`).
pub struct WsConn;
impl Drop for WsConn {
    fn drop(&mut self) {
        WS_OPEN.fetch_sub(1, Ordering::Relaxed);
    }
}
pub fn ws_open() -> WsConn {
    WS_OPEN.fetch_add(1, Ordering::Relaxed);
    WS_TOTAL.fetch_add(1, Ordering::Relaxed);
    WsConn
}

/// A label value, escaped per the exposition format.
fn esc(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"").replace('\n', "\\n")
}

fn head(out: &mut String, name: &str, kind: &str, help: &str) {
    let _ = writeln!(out, "# HELP {name} {help}");
    let _ = writeln!(out, "# TYPE {name} {kind}");
}

fn render_http(out: &mut String) {
    let h = HTTP.lock().expect("metrics mutex");
    head(out, "arena_http_requests_total", "counter", "HTTP requests by method, route template and status.");
    for ((m, r, s), n) in &h.reqs {
        let _ = writeln!(out, "arena_http_requests_total{{method=\"{m}\",route=\"{}\",status=\"{s}\"}} {n}", esc(r));
    }
    head(out, "arena_http_request_duration_seconds", "histogram", "Time to the response head, by method and route template.");
    for ((m, r), hist) in &h.lat {
        let r = esc(r);
        let mut acc = 0;
        for (i, b) in BUCKETS.iter().enumerate() {
            acc += hist.counts[i];
            let _ = writeln!(out, "arena_http_request_duration_seconds_bucket{{method=\"{m}\",route=\"{r}\",le=\"{b}\"}} {acc}");
        }
        let _ = writeln!(out, "arena_http_request_duration_seconds_bucket{{method=\"{m}\",route=\"{r}\",le=\"+Inf\"}} {}", hist.n);
        let _ = writeln!(out, "arena_http_request_duration_seconds_sum{{method=\"{m}\",route=\"{r}\"}} {}", hist.sum);
        let _ = writeln!(out, "arena_http_request_duration_seconds_count{{method=\"{m}\",route=\"{r}\"}} {}", hist.n);
    }
    drop(h);
    head(out, "arena_http_requests_in_flight", "gauge", "HTTP requests being handled now.");
    let _ = writeln!(out, "arena_http_requests_in_flight {}", IN_FLIGHT.load(Ordering::Relaxed));
    head(out, "arena_ws_connections", "gauge", "Open room websockets.");
    let _ = writeln!(out, "arena_ws_connections {}", WS_OPEN.load(Ordering::Relaxed));
    head(out, "arena_ws_connections_total", "counter", "Room websockets opened since start.");
    let _ = writeln!(out, "arena_ws_connections_total {}", WS_TOTAL.load(Ordering::Relaxed));
}

/// Rooms and the people in them, split public/private (aggregates only).
fn rooms(snapshot: &[Value]) -> [(usize, u64); 2] {
    let mut r = [(0, 0); 2];
    for room in snapshot {
        let k = room["roomId"].as_str().unwrap_or("").starts_with(crate::server_stats::PRIVATE_PREFIX) as usize;
        r[k].0 += 1;
        r[k].1 += room["members"].as_u64().unwrap_or(0);
    }
    r
}

/// `/proc/self/status` field `key:` as its first number (kB for VmRSS).
fn proc_status(status: &str, key: &str) -> Option<f64> {
    status.lines().find_map(|l| l.strip_prefix(key))?.split_whitespace().next()?.parse().ok()
}

fn render_process(out: &mut String) {
    let (t0, wall0) = *STARTED;
    head(out, "process_start_time_seconds", "gauge", "Start time of the process since the Unix epoch.");
    let _ = writeln!(out, "process_start_time_seconds {}", wall0.floor());
    head(out, "arena_uptime_seconds", "gauge", "Seconds since the Arena started.");
    let _ = writeln!(out, "arena_uptime_seconds {}", t0.elapsed().as_secs());
    // Linux only (production); a macOS dev box just leaves these out.
    if let Ok(st) = std::fs::read_to_string("/proc/self/status") {
        if let Some(kb) = proc_status(&st, "VmRSS:") {
            head(out, "process_resident_memory_bytes", "gauge", "Resident memory size in bytes.");
            let _ = writeln!(out, "process_resident_memory_bytes {}", kb * 1024.0);
        }
        if let Some(n) = proc_status(&st, "Threads:") {
            head(out, "process_threads", "gauge", "OS threads in the process.");
            let _ = writeln!(out, "process_threads {n}");
        }
    }
    if let Some(cpu) = std::fs::read_to_string("/proc/self/stat").ok().and_then(|s| crate::server_stats::parse_cpu_ticks(&s)) {
        head(out, "process_cpu_seconds_total", "counter", "Total user and system CPU time spent in seconds.");
        let _ = writeln!(out, "process_cpu_seconds_total {cpu}");
    }
    if let Ok(fds) = std::fs::read_dir("/proc/self/fd") {
        head(out, "process_open_fds", "gauge", "Open file descriptors.");
        let _ = writeln!(out, "process_open_fds {}", fds.count());
    }
}

/// The whole exposition, read at scrape time.
pub async fn render(st: &crate::AppState) -> String {
    let mut out = String::with_capacity(16 * 1024);
    head(&mut out, "arena_build_info", "gauge", "The running Arena's version (always 1).");
    let _ = writeln!(out, "arena_build_info{{version=\"{}\"}} 1",
                     esc(&std::env::var("ARENA_VERSION").unwrap_or_else(|_| "dev".into())));
    render_http(&mut out);

    let snapshot = st.rooms.summary().await;
    let [public, private] = rooms(&snapshot);
    head(&mut out, "arena_rooms", "gauge", "Live rooms.");
    let _ = writeln!(out, "arena_rooms{{kind=\"public\"}} {}", public.0);
    let _ = writeln!(out, "arena_rooms{{kind=\"private\"}} {}", private.0);
    head(&mut out, "arena_room_members", "gauge", "People in rooms (one person in two rooms counts twice).");
    let _ = writeln!(out, "arena_room_members{{kind=\"public\"}} {}", public.1);
    let _ = writeln!(out, "arena_room_members{{kind=\"private\"}} {}", private.1);

    // One registry serves every real-time game (see server_stats.rs).
    let rt = st.kart.registry().stats();
    let overruns: u64 = rt["rooms"].as_object()
        .map(|m| m.values().map(|r| r["overruns"].as_u64().unwrap_or(0)).sum())
        .unwrap_or(0);
    head(&mut out, "arena_game_loops", "gauge", "Real-time game loops running.");
    let _ = writeln!(out, "arena_game_loops {}", rt["running"].as_u64().unwrap_or(0));
    head(&mut out, "arena_game_loops_max", "gauge", "The game loop budget.");
    let _ = writeln!(out, "arena_game_loops_max {}", rt["max"].as_u64().unwrap_or(0));
    head(&mut out, "arena_game_loop_overruns", "gauge", "Tick overruns summed over the running game loops.");
    let _ = writeln!(out, "arena_game_loop_overruns {overruns}");

    head(&mut out, "arena_db_pool_connections", "gauge", "SQLite pool connections by state.");
    let (size, idle) = (st.pool.size() as usize, st.pool.num_idle());
    let _ = writeln!(out, "arena_db_pool_connections{{state=\"idle\"}} {idle}");
    let _ = writeln!(out, "arena_db_pool_connections{{state=\"busy\"}} {}", size.saturating_sub(idle));
    // "sqlite+aiosqlite:////data/arena.db" (compose) or "sqlite:./arena.db" (local runs)
    let path = crate::server_stats::sqlite_path(&st.cfg.database_url);
    let path = path.strip_prefix("sqlite:").unwrap_or(path);
    head(&mut out, "arena_db_size_bytes", "gauge", "SQLite file sizes (main file and write-ahead log).");
    for (file, p) in [("main", path.to_owned()), ("wal", format!("{path}-wal"))] {
        if let Ok(m) = std::fs::metadata(&p) {
            let _ = writeln!(out, "arena_db_size_bytes{{file=\"{file}\"}} {}", m.len());
        }
    }
    render_process(&mut out);
    out
}

async fn metrics(State(st): State<crate::AppState>) -> Response {
    ([(header::CONTENT_TYPE, "text/plain; version=0.0.4; charset=utf-8")], render(&st).await).into_response()
}

/// The metrics listener's router: `/metrics` and nothing else.
pub fn router(st: crate::AppState) -> Router {
    Router::new().route("/metrics", get(metrics)).with_state(st)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{middleware, routing::get};

    #[test]
    fn histogram_buckets_are_cumulative_when_rendered() {
        let mut h = Hist::default();
        for v in [0.001, 0.02, 0.02, 3.0, 99.0] {
            h.observe(v);
        }
        assert_eq!(h.n, 5);
        assert_eq!(h.counts[0], 1); // <= 5 ms
        assert_eq!(h.counts[2], 2); // <= 25 ms
        assert_eq!(h.counts[9], 1); // <= 5 s
        assert_eq!(h.counts.iter().sum::<u64>(), 4, "99 s lands only in +Inf");
    }

    #[test]
    fn methods_are_a_fixed_set() {
        assert_eq!(method_label(&axum::http::Method::GET), "GET");
        assert_eq!(method_label(&axum::http::Method::from_bytes(b"BREW").unwrap()), "OTHER");
    }

    #[test]
    fn labels_are_escaped() {
        assert_eq!(esc("a\"b\\c\nd"), "a\\\"b\\\\c\\nd");
    }

    #[test]
    fn rooms_split_public_and_private() {
        let s = vec![
            serde_json::json!({"roomId": "lobby", "members": 3}),
            serde_json::json!({"roomId": "r_secret", "members": 2}),
            serde_json::json!({"roomId": "qp_1", "members": 1}),
        ];
        assert_eq!(rooms(&s), [(2, 4), (1, 2)]);
    }

    #[test]
    fn proc_status_reads_the_first_number() {
        let s = "Name:\tarena\nVmRSS:\t  20480 kB\nThreads:\t9\n";
        assert_eq!(proc_status(s, "VmRSS:"), Some(20480.0));
        assert_eq!(proc_status(s, "Threads:"), Some(9.0));
        assert_eq!(proc_status(s, "VmSwap:"), None);
    }

    /// The label is the route template, never the raw path; unknown paths
    /// share one "unmatched" series.
    #[tokio::test]
    async fn middleware_labels_by_route_template() {
        let app: Router = Router::new()
            .route("/t/rooms/:room_id/ws", get(|| async { "ok" }))
            .layer(middleware::from_fn(track));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        for uri in ["/t/rooms/r_private-123/ws", "/t/rooms/abc/ws", "/t/nope/zzz"] {
            reqwest::get(format!("http://{addr}{uri}")).await.unwrap();
        }
        let mut out = String::new();
        render_http(&mut out);
        assert!(out.contains(r#"arena_http_requests_total{method="GET",route="/t/rooms/:room_id/ws",status="200"} 2"#), "{out}");
        assert!(out.contains(r#"route="unmatched",status="404""#), "{out}");
        assert!(!out.contains("r_private-123"), "a raw path never becomes a label");
        assert!(out.contains(r#"arena_http_request_duration_seconds_bucket{method="GET",route="/t/rooms/:room_id/ws",le="+Inf"} 2"#));
        assert_eq!(IN_FLIGHT.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn ws_gauge_follows_the_guard() {
        let before = WS_OPEN.load(Ordering::Relaxed);
        let g = ws_open();
        assert_eq!(WS_OPEN.load(Ordering::Relaxed), before + 1);
        drop(g);
        assert_eq!(WS_OPEN.load(Ordering::Relaxed), before);
    }
}
