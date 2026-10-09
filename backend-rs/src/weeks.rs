//! ISO weeks in UTC: the one copy maps, cups and boss share.
//!
//! SHIM: the scaffold (feat/25-scaffold) owns this file. This copy follows its
//! contract (`iso_week`, `week_bounds`) so world-boss can build before the
//! scaffold lands; the rebase onto the scaffold drops it.

use chrono::{Datelike, Duration, NaiveDate, NaiveDateTime, Weekday};

/// "YYYY-Www" (ISO 8601) for a UTC timestamp string ("YYYY-MM-DD..." -- only
/// the date part is read). An unparseable string gives "".
pub fn iso_week(ts: &str) -> String {
    let Some(d) = ts.get(..10).and_then(|s| NaiveDate::parse_from_str(s, "%Y-%m-%d").ok()) else {
        return String::new();
    };
    let w = d.iso_week();
    format!("{}-W{:02}", w.year(), w.week())
}

/// Monday 00:00:00 .. Sunday 23:59:59.999999 UTC of an ISO week, in the
/// "%Y-%m-%d %H:%M:%S%.6f" form the Arena stores. A bad week gives ("", "").
pub fn week_bounds(week: &str) -> (String, String) {
    let parsed = week
        .split_once("-W")
        .and_then(|(y, w)| Some((y.parse::<i32>().ok()?, w.parse::<u32>().ok()?)))
        .and_then(|(y, w)| NaiveDate::from_isoywd_opt(y, w, Weekday::Mon));
    let Some(mon) = parsed else { return (String::new(), String::new()) };
    let start: NaiveDateTime = mon.and_hms_opt(0, 0, 0).expect("midnight");
    let end = start + Duration::days(7) - Duration::microseconds(1);
    let f = "%Y-%m-%d %H:%M:%S%.6f";
    (start.format(f).to_string(), end.format(f).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sunday_night_and_monday_morning_are_different_weeks() {
        assert_eq!(iso_week("2026-10-11 23:59:59"), "2026-W41");
        assert_eq!(iso_week("2026-10-12 00:00:00"), "2026-W42");
        assert_eq!(iso_week("2027-01-01 12:00:00"), "2026-W53");
        assert_eq!(iso_week("2027-01-04"), "2027-W01");
        assert_eq!(iso_week("nope"), "");
    }

    #[test]
    fn bounds_cover_monday_to_sunday() {
        let (a, b) = week_bounds("2026-W41");
        assert_eq!(a, "2026-10-05 00:00:00.000000");
        assert_eq!(b, "2026-10-11 23:59:59.999999");
        assert_eq!(week_bounds("x"), (String::new(), String::new()));
    }
}
