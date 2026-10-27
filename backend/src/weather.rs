//! HQ 3.23 live weather: what it is doing in Koramangala, Bengaluru, now, for the 3D City's sky.
//!
//! Once at start-up and then at the start of every hour (UTC), the Arena asks Zomato's Weather Union
//! (`get_weather_data` by latitude and longitude) for one place's reading and keeps the latest in memory. Koramangala's
//! own station is a rain gauge (device_type 2: rain only), so a second call to the nearest full station (Domlur,
//! device_type 1: temperature, humidity, wind) fills in what the gauge leaves null: two calls an hour, 48 a day. Nothing
//! about any player goes out: the request carries only the fixed coordinates and the Arena's own key
//! (`WEATHERUNION_API_KEY`, from the server's env file; never logged, never sent to a player). Without a key the
//! fetch never runs and the City keeps its own made-up forecast (games/hqweather.js).
//!
//! Every number Weather Union reports (`locality_weather_data`: temperature, humidity, wind_speed,
//! wind_direction, rain_intensity, rain_accumulation, aqi_pm_10, aqi_pm_2_point_5, and any field it adds later) is
//! passed through as it came, a null as null; games/hqweather.js turns them into the sky.
//!
//! Env: WEATHERUNION_API_KEY (off without it), ARENA_WEATHER_LAT / ARENA_WEATHER_LON (default Koramangala),
//! ARENA_WEATHER_FILL_LAT / ARENA_WEATHER_FILL_LON (the full station that fills the gaps; default Domlur),
//! ARENA_WEATHER_PLACE (the name shown), ARENA_WEATHER_URL (the endpoint; tests point it elsewhere).
//!
//! Route (behind `require_device`):
//! - GET /v1/weather -> {ok: true, source, place, at (unix s of the reading), data: {field: number | null}},
//!   or {ok: false} (no key, or no reading yet)

use axum::{response::IntoResponse, routing::get, Json, Router};
use serde_json::{json, Map, Value};
use std::sync::{LazyLock, RwLock};

use crate::AppState;

const DEFAULT_URL: &str = "https://www.weatherunion.com/gw/weather/external/v0/get_weather_data";
/// Koramangala, Bengaluru.
const DEFAULT_LAT: &str = "12.9352";
const DEFAULT_LON: &str = "77.6245";
const DEFAULT_PLACE: &str = "Koramangala, Bengaluru";
/// The nearest full weather station (Domlur, about 2 km away).
const DEFAULT_FILL_LAT: &str = "12.9500";
const DEFAULT_FILL_LON: &str = "77.6400";
/// A reading older than this is not served (a stalled fetch falls back to the made-up forecast).
const STALE_SECS: i64 = 3 * 3600;
/// The most fields passed on (Weather Union sends eight today).
const MAX_FIELDS: usize = 24;

#[derive(Clone, Debug, PartialEq)]
pub struct Reading {
    pub at: i64,
    pub data: Map<String, Value>,
}

static LATEST: LazyLock<RwLock<Option<Reading>>> = LazyLock::new(|| RwLock::new(None));

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).ok().filter(|v| !v.trim().is_empty()).unwrap_or_else(|| default.to_string())
}

fn key() -> Option<String> {
    std::env::var("WEATHERUNION_API_KEY").ok().map(|k| k.trim().to_string()).filter(|k| !k.is_empty())
}

fn place() -> String {
    env_or("ARENA_WEATHER_PLACE", DEFAULT_PLACE)
}

/// Pure: the reading in a Weather Union reply: every field of `locality_weather_data` that is a number or null,
/// under a sane name (`[a-z0-9_]`, at most 40 characters), at most MAX_FIELDS of them. None when the reply is not a
/// success (`status` 200) or has no numbers at all.
pub fn parse(body: &Value) -> Option<Map<String, Value>> {
    let ok = match body.get("status") {
        Some(Value::Number(n)) => n.as_i64() == Some(200),
        Some(Value::String(s)) => s == "200",
        None => true,
        _ => false,
    };
    if !ok {
        return None;
    }
    let src = body.get("locality_weather_data")?.as_object()?;
    let mut out = Map::new();
    for (k, v) in src {
        if out.len() >= MAX_FIELDS {
            break;
        }
        let name_ok = !k.is_empty() && k.len() <= 40 && k.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_');
        if !name_ok {
            continue;
        }
        match v {
            Value::Number(n) if n.as_f64().is_some_and(|f| f.is_finite()) => {
                out.insert(k.clone(), v.clone());
            }
            Value::Null => {
                out.insert(k.clone(), Value::Null);
            }
            _ => {}
        }
    }
    if out.values().any(|v| v.is_number()) {
        Some(out)
    } else {
        None
    }
}

/// Pure: the place's own reading, with every field it leaves null (or lacks) filled from the full station's.
pub fn merge(own: Option<Map<String, Value>>, fill: Option<Map<String, Value>>) -> Option<Map<String, Value>> {
    match (own, fill) {
        (None, None) => None,
        (Some(o), None) => Some(o),
        (None, Some(f)) => Some(f),
        (Some(mut o), Some(f)) => {
            for (k, v) in f {
                if o.len() >= MAX_FIELDS && !o.contains_key(&k) {
                    continue;
                }
                if o.get(&k).is_none_or(|x| x.is_null()) {
                    o.insert(k, v);
                }
            }
            Some(o)
        }
    }
}

/// Pure: seconds from `now` (unix s) to the next start of an hour (UTC), never zero.
pub fn to_next_hour(now: i64) -> u64 {
    let into = now.rem_euclid(3600);
    (3600 - into) as u64
}

/// Pure: the reply to GET /v1/weather.
pub fn reply(r: Option<&Reading>, now: i64, place: &str) -> Value {
    match r {
        Some(r) if now - r.at <= STALE_SECS => {
            json!({"ok": true, "source": "weatherunion", "place": place, "at": r.at, "data": Value::Object(r.data.clone())})
        }
        _ => json!({"ok": false}),
    }
}

async fn fetch_at(client: &reqwest::Client, key: &str, lat: String, lon: String) -> anyhow::Result<Map<String, Value>> {
    let url = env_or("ARENA_WEATHER_URL", DEFAULT_URL);
    let res = client
        .get(&url)
        .query(&[("latitude", lat), ("longitude", lon)])
        .header("x-zomato-api-key", key)
        .send()
        .await?;
    let status = res.status();
    if !status.is_success() {
        anyhow::bail!("weather: HTTP {}", status.as_u16());
    }
    let body: Value = res.json().await?;
    parse(&body).ok_or_else(|| anyhow::anyhow!("weather: no reading in the reply (status {:?})", body.get("status")))
}

/// The place's reading, filled in from the full station (either alone when the other fails).
async fn fetch_once(client: &reqwest::Client, key: &str) -> anyhow::Result<Map<String, Value>> {
    let own = fetch_at(client, key, env_or("ARENA_WEATHER_LAT", DEFAULT_LAT), env_or("ARENA_WEATHER_LON", DEFAULT_LON)).await;
    let fill = fetch_at(client, key, env_or("ARENA_WEATHER_FILL_LAT", DEFAULT_FILL_LAT), env_or("ARENA_WEATHER_FILL_LON", DEFAULT_FILL_LON)).await;
    if let Err(e) = &own {
        tracing::warn!("weather: the place's own reading failed: {e}");
    }
    if let Err(e) = &fill {
        tracing::warn!("weather: the full station's reading failed: {e}");
    }
    merge(own.ok(), fill.ok()).ok_or_else(|| anyhow::anyhow!("weather: no reading from either station"))
}

fn now_secs() -> i64 {
    chrono::Utc::now().timestamp()
}

/// At start-up, then at the start of every hour: fetch, and keep the reading. Off without a key.
pub fn spawn_hourly() {
    let Some(k) = key() else {
        tracing::info!("weather: no WEATHERUNION_API_KEY, live weather off");
        return;
    };
    tokio::spawn(async move {
        let client = match reqwest::Client::builder().timeout(std::time::Duration::from_secs(15)).build() {
            Ok(c) => c,
            Err(e) => {
                tracing::warn!("weather: no HTTP client: {e}");
                return;
            }
        };
        loop {
            match fetch_once(&client, &k).await {
                Ok(data) => {
                    tracing::info!("weather: reading with {} fields", data.len());
                    if let Ok(mut w) = LATEST.write() {
                        *w = Some(Reading { at: now_secs(), data });
                    }
                }
                // (the error never carries the key: it is only ever a header)
                Err(e) => tracing::warn!("weather: fetch failed: {e}"),
            }
            tokio::time::sleep(std::time::Duration::from_secs(to_next_hour(now_secs()) + 5)).await;
        }
    });
}

pub fn routes() -> Router<AppState> {
    Router::new().route("/v1/weather", get(latest))
}

async fn latest() -> impl IntoResponse {
    let r = LATEST.read().ok().and_then(|g| g.clone());
    Json(reply(r.as_ref(), now_secs(), &place()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_every_number_and_nothing_else() {
        let body = json!({"status": 200, "message": "", "device_type": 1, "locality_weather_data": {
            "temperature": 24.5, "humidity": 81.2, "wind_speed": 3.1, "wind_direction": 245.0,
            "rain_intensity": 4.2, "rain_accumulation": 12.0, "aqi_pm_10": null, "aqi_pm_2_point_5": 41,
            "note": "hello", "Bad-Key": 3, "nested": {"x": 1}}});
        let d = parse(&body).unwrap();
        let keys: Vec<&str> = d.keys().map(|k| k.as_str()).collect();
        assert_eq!(keys, ["temperature", "humidity", "wind_speed", "wind_direction", "rain_intensity", "rain_accumulation", "aqi_pm_10", "aqi_pm_2_point_5"]);
        assert_eq!(d["aqi_pm_10"], Value::Null);
        assert_eq!(d["rain_intensity"], json!(4.2));
    }

    #[test]
    fn refuses_a_failure_or_an_empty_reading() {
        assert!(parse(&json!({"status": 401, "locality_weather_data": {"temperature": 20}})).is_none());
        assert!(parse(&json!({"status": 200, "locality_weather_data": {"temperature": null}})).is_none());
        assert!(parse(&json!({"status": 200})).is_none());
        assert!(parse(&json!({"status": "200", "locality_weather_data": {"humidity": 50}})).is_some());
    }

    #[test]
    fn caps_the_fields() {
        let mut m = Map::new();
        for i in 0..40 {
            m.insert(format!("f{i}"), json!(i));
        }
        assert_eq!(parse(&json!({"status": 200, "locality_weather_data": Value::Object(m)})).unwrap().len(), MAX_FIELDS);
    }

    #[test]
    fn fills_the_rain_gauge_from_the_full_station() {
        let gauge = parse(&json!({"status": "200", "device_type": 2, "locality_weather_data": {"temperature": null, "humidity": null,
            "wind_speed": null, "wind_direction": null, "rain_intensity": 0, "rain_accumulation": 1.4, "aqi_pm_10": null, "aqi_pm_2_point_5": null}}));
        let full = parse(&json!({"status": "200", "device_type": 1, "locality_weather_data": {"temperature": 23.84, "humidity": 68.81,
            "wind_speed": 0, "wind_direction": 134.9, "rain_intensity": 2.5, "rain_accumulation": 3.2, "aqi_pm_10": null, "aqi_pm_2_point_5": null}}));
        let m = merge(gauge.clone(), full.clone()).unwrap();
        assert_eq!(m["rain_intensity"], json!(0), "the place's own rain wins");
        assert_eq!(m["rain_accumulation"], json!(1.4));
        assert_eq!(m["temperature"], json!(23.84));
        assert_eq!(m["wind_direction"], json!(134.9));
        assert_eq!(m["aqi_pm_10"], Value::Null);
        assert_eq!(merge(None, full.clone()), full);
        assert_eq!(merge(gauge.clone(), None), gauge);
        assert_eq!(merge(None, None), None);
    }

    #[test]
    fn wakes_at_the_start_of_the_hour() {
        assert_eq!(to_next_hour(7200), 3600);
        assert_eq!(to_next_hour(7201), 3599);
        assert_eq!(to_next_hour(10799), 1);
    }

    #[test]
    fn serves_a_fresh_reading_only() {
        let r = Reading { at: 1000, data: parse(&json!({"status": 200, "locality_weather_data": {"rain_intensity": 2.0}})).unwrap() };
        let v = reply(Some(&r), 1000 + 3600, "Koramangala, Bengaluru");
        assert_eq!(v["ok"], json!(true));
        assert_eq!(v["data"]["rain_intensity"], json!(2.0));
        assert_eq!(v["place"], json!("Koramangala, Bengaluru"));
        assert!(v.get("key").is_none());
        assert_eq!(reply(Some(&r), 1000 + STALE_SECS + 1, "x"), json!({"ok": false}));
        assert_eq!(reply(None, 0, "x"), json!({"ok": false}));
    }
}
