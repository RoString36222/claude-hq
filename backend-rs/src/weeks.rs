//! ISO weeks in UTC, the one copy every weekly feature (map of the week, cups,
//! the world boss) uses, so "this week" can never mean two things.
//!
//! A week is named "YYYY-Www" (ISO 8601: Monday first, week 1 holds the year's
//! first Thursday) and spans Monday 00:00:00 to Sunday 23:59:59.999999 UTC. The
//! bounds are strings in the database's own timestamp form, so a column written
//! as CURRENT_TIMESTAMP ("YYYY-MM-DD HH:MM:SS") or as "%Y-%m-%d %H:%M:%S%.6f"
//! compares correctly against them as plain text.

use chrono::{Datelike, NaiveDate, NaiveDateTime, Weekday};

/// Parse the leading date/time of a timestamp string ("YYYY-MM-DD", with an
/// optional " HH:MM:SS[.ffffff]" or "T..." and an optional zone suffix that is
/// ignored: every stamp here is UTC). Garbage falls back to the epoch.
fn parse_ts(ts: &str) -> NaiveDateTime {
    let t = ts.trim();
    let date = t.get(..10).and_then(|d| NaiveDate::parse_from_str(d, "%Y-%m-%d").ok());
    let Some(date) = date else {
        return NaiveDate::from_ymd_opt(1970, 1, 1).unwrap_or_default().and_hms_opt(0, 0, 0)
            .unwrap_or_default();
    };
    let time = t.get(11..19).and_then(|s| chrono::NaiveTime::parse_from_str(s, "%H:%M:%S").ok());
    date.and_time(time.unwrap_or_default())
}

/// The ISO week of a UTC timestamp string, as "YYYY-Www".
pub fn iso_week(ts: &str) -> String {
    let w = parse_ts(ts).date().iso_week();
    format!("{:04}-W{:02}", w.year(), w.week())
}

/// Monday 00:00:00 and Sunday 23:59:59.999999 (UTC) of a "YYYY-Www" week. A
/// malformed name answers the bounds of the epoch's week rather than panicking.
pub fn week_bounds(week: &str) -> (String, String) {
    let parsed = week.split_once("-W").and_then(|(y, w)| {
        let y: i32 = y.parse().ok()?;
        let w: u32 = w.parse().ok()?;
        NaiveDate::from_isoywd_opt(y, w, Weekday::Mon)
    });
    let mon = parsed.unwrap_or_else(|| {
        NaiveDate::from_isoywd_opt(1970, 1, Weekday::Mon).unwrap_or_default()
    });
    let sun = mon + chrono::Duration::days(6);
    (format!("{} 00:00:00", mon.format("%Y-%m-%d")),
     format!("{} 23:59:59.999999", sun.format("%Y-%m-%d")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sunday_night_and_monday_morning_are_different_weeks() {
        // 2026-10-11 is a Sunday, 2026-10-12 the Monday after.
        assert_eq!(iso_week("2026-10-11 23:59:59"), "2026-W41");
        assert_eq!(iso_week("2026-10-11 23:59:59.999999"), "2026-W41");
        assert_eq!(iso_week("2026-10-12 00:00:00"), "2026-W42");
        let (a, b) = week_bounds("2026-W41");
        assert_eq!(a, "2026-10-05 00:00:00");
        assert_eq!(b, "2026-10-11 23:59:59.999999");
        // Both stored timestamp forms sort inside the bounds as text.
        assert!("2026-10-11 23:59:59" <= b.as_str() && "2026-10-05 00:00:00" >= a.as_str());
        assert!("2026-10-11 23:59:59.5" <= b.as_str());
        assert!("2026-10-12 00:00:00" > b.as_str());
    }

    #[test]
    fn the_year_boundary_follows_iso() {
        // 2026 has 53 ISO weeks: 2027-01-01 (a Friday) is still 2026-W53.
        assert_eq!(iso_week("2027-01-01 12:00:00"), "2026-W53");
        assert_eq!(iso_week("2027-01-04 00:00:00"), "2027-W01");
        assert_eq!(week_bounds("2026-W53").0, "2026-12-28 00:00:00");
        assert_eq!(week_bounds("2027-W01").0, "2027-01-04 00:00:00");
    }

    #[test]
    fn garbage_never_panics() {
        assert_eq!(iso_week(""), "1970-W01");
        assert_eq!(iso_week("nope"), "1970-W01");
        let _ = week_bounds("2026-W99");
        let _ = week_bounds("x");
    }
}
