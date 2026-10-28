//! Road classes (City Gen v4): the eleven classes of the plan, each with a tram version,
//! their lanes, widths, design speeds, capacities and curves, and the rules for changing
//! from one to the next. Phase 2 paves the town's streets by them (organic/widen.rs, each
//! edge's `v4`, `lanes` and `median`); `legacy` names what a road without one would be.
//!
//! Widths are IRC:86, FHWA and Manual for Streets figures (the plan's table), in cm:
//!
//!   class        lanes/way  lane  median           footpath/side       total  km/h
//!   shared       1 shared   2.75  -                2.0                   9.5  20
//!   lane         1          3.0   -                1.5                   9.0  20-30
//!   local        1          3.25  -                2.0                  10.5  30
//!   collector    1          3.5   -                2.5                  12.0  50
//!   avenue       2          3.5   2.0              3.0                  22.0  60
//!   boulevard    3          3.5   7.5 planted      4.0                  36.5  60
//!   service      1          3.25  -                2.0                  10.5  30
//!   expressway   3          3.5   3.0 barrier      2.5 shoulder         29.0  80
//!   highway      4          3.65  1.0 + 2x1.2      3.0 shoulder         38.6  100
//!   ramp         1 (one way) 4.0  -                2.0 shoulder          8.0  40-65
//!   flyover      as carried 3.5   as carried       0.225 parapet     7.45 for 2  as carried

/// One road class.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Class {
    pub name: &'static str,
    /// Lanes each way (a ramp's one way; a shared street's one lane is shared).
    pub lanes: u8,
    /// Both ways (a ramp has one direction only).
    pub two_way: bool,
    pub lane_cm: i64,
    pub median_cm: i64,
    /// Footpath, or shoulder or parapet where there is no footpath, each side.
    pub side_cm: i64,
    /// Footpaths (else the sides are shoulders or parapets).
    pub walk: bool,
    pub total_cm: i64,
    /// Design speed (km/h): the lowest and the highest.
    pub kmh: (i64, i64),
    /// Its tram version: the added width (cm) and how the track is laid.
    pub tram: Option<Tram>,
}

/// A class's tram version.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Tram {
    pub added_cm: i64,
    pub layout: Layout,
}

/// How a tram version lays its track.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Layout {
    /// One track set in the paving or the lane, trams sharing it with traffic.
    SharedSingle,
    /// Two tracks in the traffic lanes, the lanes widened for a 2.65 m tram.
    SharedDouble,
    /// Two tracks in a raised (150 mm), kerbed bed: cars never drive on it.
    CentreBed,
    /// One track each side of a boulevard's planted median (the piers stay in it).
    SideOfMedian,
    /// Two tracks in a widened median behind barriers.
    BehindBarriers,
    /// A tram deck beside the road deck, 3.6 m a track.
    Deck,
}

impl Layout {
    /// Its name in the world doc (`Edge::tram`).
    pub fn name(self) -> &'static str {
        match self {
            Layout::SharedSingle => "shared-single",
            Layout::SharedDouble => "shared-double",
            Layout::CentreBed => "centre-bed",
            Layout::SideOfMedian => "side-of-median",
            Layout::BehindBarriers => "behind-barriers",
            Layout::Deck => "deck",
        }
    }
}

#[allow(clippy::too_many_arguments)] // one per column of the table
const fn c(name: &'static str, lanes: u8, two_way: bool, lane_cm: i64, median_cm: i64, side_cm: i64, walk: bool, total_cm: i64, kmh: (i64, i64), tram: Option<Tram>) -> Class {
    Class { name, lanes, two_way, lane_cm, median_cm, side_cm, walk, total_cm, kmh, tram }
}

const fn t(added_cm: i64, layout: Layout) -> Option<Tram> {
    Some(Tram { added_cm, layout })
}

/// The classes, narrowest first. A flyover's lanes and median are its carried road's;
/// here it is the two-lane deck.
pub const CLASSES: [Class; 11] = [
    // a shared street's one lane runs both ways (counted as one each way for capacity)
    c("shared", 1, true, 275, 0, 200, true, 950, (20, 20), t(0, Layout::SharedSingle)),
    c("lane", 1, true, 300, 0, 150, true, 900, (20, 30), t(120, Layout::SharedSingle)),
    c("local", 1, true, 325, 0, 200, true, 1_050, (30, 30), t(80, Layout::SharedDouble)),
    c("collector", 1, true, 350, 0, 250, true, 1_200, (50, 50), t(720, Layout::CentreBed)),
    c("avenue", 2, true, 350, 200, 300, true, 2_200, (60, 60), t(720, Layout::CentreBed)),
    c("boulevard", 3, true, 350, 750, 400, true, 3_650, (60, 60), t(720, Layout::SideOfMedian)),
    c("service", 1, true, 325, 0, 200, true, 1_050, (30, 30), t(120, Layout::SharedSingle)),
    c("expressway", 3, true, 350, 300, 250, false, 2_900, (80, 80), t(800, Layout::BehindBarriers)),
    // 1.0 m barrier and two 1.2 m inner shoulders
    c("highway", 4, true, 365, 340, 300, false, 3_860, (100, 100), t(800, Layout::BehindBarriers)),
    // trams never use a car ramp: they get their own beside it
    c("ramp", 1, false, 400, 0, 200, false, 800, (40, 65), None),
    c("flyover", 1, true, 350, 0, 23, false, 745, (20, 100), t(720, Layout::Deck)),
];

/// The class named `name`.
pub fn class(name: &str) -> Option<&'static Class> {
    CLASSES.iter().find(|c| c.name == name)
}

impl Class {
    /// Its carriageway (cm): the lanes both ways, no median, no footpaths.
    pub fn carriageway_cm(&self) -> i64 {
        self.total_cm - self.median_cm - 2 * self.side_cm
    }

    /// Lanes counted for capacity, both ways.
    pub fn lanes_total(&self) -> i64 {
        self.lanes as i64 * if self.two_way { 2 } else { 1 }
    }

    /// Its width with tram tracks (cm), if it has a tram version.
    pub fn tram_total_cm(&self) -> Option<i64> {
        self.tram.map(|t| self.total_cm + t.added_cm)
    }

    /// The design speed it is laid out for (the higher of its range).
    pub fn design_kmh(&self) -> i64 {
        self.kmh.1
    }

    /// The tightest centre-line radius (cm) at its design speed; 25 m at least with tram
    /// tracks (the tram's minimum).
    pub fn min_radius_cm(&self, tram: bool) -> i64 {
        let r = min_radius_cm(self.design_kmh());
        if tram { r.max(TRAM_MIN_RADIUS_CM) } else { r }
    }

    /// The hard cap on a segment `len_cm` long: one vehicle per 7.5 m of lane.
    pub fn cap(&self, len_cm: i64) -> i64 {
        self.lanes_total() * len_cm / CAR_SPACING_CM
    }

    /// The vehicles the traffic slider (per mille, 0 to 1000) puts on a segment `len_cm`
    /// long: level of service D, 22 a km a lane at 100 %, never above the cap.
    pub fn target(&self, slider_pm: i64, len_cm: i64) -> i64 {
        (slider_pm.clamp(0, 1000) * self.lanes_total() * len_cm * LOS_D_PER_KM / (1000 * 100_000)).min(self.cap(len_cm))
    }
}

/// HCM level of service D: vehicles per km per lane.
pub const LOS_D_PER_KM: i64 = 22;
/// One vehicle per 7.5 m of lane (between FHWA's 6 m queue and 8.5 m jam spacing).
pub const CAR_SPACING_CM: i64 = 750;
/// A tram counts as this many cars where it shares a lane.
pub const TRAM_AS_CARS: i64 = 3;
pub const TRAM_MIN_RADIUS_CM: i64 = 2_500;

/// The tightest centre-line radius (cm) for a design speed (km/h): R = V^2 / 127(e + f),
/// 4 % superelevation, the plan's table (to be confirmed against IRC:86 in phase 2).
pub fn min_radius_cm(kmh: i64) -> i64 {
    match kmh {
        ..=20 => 1_500,
        21..=30 => 3_000,
        31..=50 => 9_000,
        51..=60 => 15_000,
        61..=80 => 28_000,
        _ => 49_000,
    }
}

/// The length (cm) of a taper that changes a road's width by `dw_cm` at `kmh`: W V^2 / 155
/// up to 60 km/h, 0.62 W V from 70 (MUTCD, metric). Avenue to boulevard at 60: 163 m.
pub fn taper_cm(dw_cm: i64, kmh: i64) -> i64 {
    let w = dw_cm.abs();
    if kmh <= 60 { w * kmh * kmh / 155 } else { w * kmh * 62 / 100 }
}

/// The one-step ladder a road changes class along: each may only become its neighbour.
pub const LADDER: [&str; 7] = ["lane", "local", "collector", "avenue", "boulevard", "expressway", "highway"];

/// May a road change from class `a` to class `b` directly (the same, or one step on the
/// ladder)? A shared street joins a lane or a local street; a service road runs beside a
/// boulevard or expressway and joins local streets and collectors; ramps and flyovers join
/// what they carry, so the generator decides those, not this.
pub fn one_step(a: &str, b: &str) -> bool {
    if a == b {
        return true;
    }
    let at = |n: &str| LADDER.iter().position(|&x| x == n);
    if let (Some(i), Some(j)) = (at(a), at(b)) {
        return i.abs_diff(j) == 1;
    }
    let pair = |x: &str, y: &str| (a == x && b == y) || (a == y && b == x);
    pair("shared", "lane") || pair("shared", "local") || pair("service", "local") || pair("service", "collector")
}

/// How high a class stands, narrowest first: the ladder, a shared street beside a lane and
/// a service road beside a local street.
pub fn rank(name: &str) -> usize {
    ["lane", "shared", "local", "service", "collector", "avenue", "boulevard", "expressway", "highway"].iter().position(|&x| x == name).unwrap_or(0)
}

/// The class one step up the ladder from `name` (a shared street's is a local street, a
/// service road's a collector); the top, a highway, stays.
pub fn step_up(name: &str) -> &'static str {
    let name = match name {
        "shared" => "lane",
        "service" => "local",
        n => n,
    };
    let i = LADDER.iter().position(|&x| x == name).unwrap_or(0);
    LADDER[(i + 1).min(LADDER.len() - 1)]
}

/// How two roads meet (the plan's table, by road pair).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Junction {
    /// Give way (a mini roundabout, 13-25 m, at five arms).
    Priority,
    /// A single-lane roundabout (30-40 m), or signals where the main road is busy.
    RoundaboutOrSignals,
    Signals,
    /// Signals or a double-lane roundabout (45-55 m); grade separated over 10,000 PCU/h.
    SignalsOrBigRoundabout,
    /// Diamond (about 28,000 m2) or single-point.
    Diamond,
    /// Cloverleaf (73,000 m2) or trumpet (44,000 m2).
    Interchange,
    /// One crosses the other on a flyover or underpass: no access.
    Crossing,
    /// They never meet: a bridge over, or the lesser road ends at a service road.
    Never,
}

/// The junction where roads of classes `a` and `b` meet.
pub fn junction(a: &str, b: &str) -> Junction {
    let rank = |n: &str| match n {
        "shared" | "lane" | "local" | "service" => 0,
        "collector" => 1,
        "avenue" => 2,
        "boulevard" => 3,
        "expressway" => 4,
        _ => 5, // highway
    };
    let (lo, hi) = (rank(a).min(rank(b)), rank(a).max(rank(b)));
    match (lo, hi) {
        (5, 5) | (4, 5) => Junction::Interchange,
        (_, 5) => Junction::Crossing,
        (0 | 1, 4) => Junction::Never,
        (_, 4) => Junction::Diamond,
        (3, 3) => Junction::SignalsOrBigRoundabout,
        // (a side street onto a main road gives way: the plan pairs it with nothing grander)
        (0, _) => Junction::Priority,
        (1, 1 | 2) => Junction::RoundaboutOrSignals,
        // avenues and boulevards, and anything smaller onto a boulevard
        _ => Junction::Signals,
    }
}

/// The plan's minimum spacings (cm).
pub mod spacing {
    /// Junctions on the same side of a local street (Manual for Streets).
    pub const SAME_SIDE_LOCAL: i64 = 6_000;
    /// Staggered T-junctions (IRC:SP:41).
    pub const STAGGERED_T: i64 = 4_500;
    /// Signals along a boulevard (FHWA access management).
    pub const BOULEVARD_SIGNALS: i64 = 80_000;
    /// Highway interchanges in the city (IRC:92, Green Book).
    pub const INTERCHANGES: i64 = 160_000;
    /// An on-ramp's taper end to the next ramp (NCHRP 687).
    pub const RAMP_TO_RAMP: i64 = 8_200;
    /// Block length inside neighbourhoods (UN-Habitat, Manual for Streets): from, to.
    pub const BLOCK: (i64, i64) = (8_000, 15_000);
    /// Arterial grid (IRC:86, UN-Habitat): from, to.
    pub const ARTERIAL_GRID: (i64, i64) = (80_000, 150_000);
}

/// The v4 class one of today's roads is nearest to, by its class and paved width (cm):
/// what the validator reports until phase 2 lays roads by class.
pub fn legacy(class: &str, width_cm: i64) -> &'static str {
    match class {
        "highway" => "expressway",
        "ring" => "expressway",
        "arterial" | "avenue" if width_cm >= 3_000 => "boulevard",
        "arterial" | "avenue" => "avenue",
        _ if width_cm >= 1_150 => "collector",
        _ if width_cm >= 1_000 => "local",
        _ => "lane",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_class_adds_up_to_its_width() {
        for c in CLASSES.iter().filter(|c| c.name != "flyover") {
            let lanes = c.lanes as i64 * if c.two_way { 2 } else { 1 };
            // a shared street's single lane is shared both ways
            let lanes = if c.name == "shared" { 2 } else { lanes };
            assert_eq!(lanes * c.lane_cm + c.median_cm + 2 * c.side_cm, c.total_cm, "{}", c.name);
        }
        // a two-lane flyover deck: 2 x 3.5 m and a 0.225 m parapet each side (7.45 m, rounded)
        let f = class("flyover").unwrap();
        assert_eq!(2 * f.lane_cm + 2 * f.side_cm, 746);
    }

    #[test]
    fn the_tram_versions_are_the_plans_widths() {
        let want = [("shared", 950), ("lane", 1_020), ("local", 1_130), ("collector", 1_920), ("avenue", 2_920), ("boulevard", 4_370), ("service", 1_170), ("expressway", 3_700), ("highway", 4_660)];
        for (n, w) in want {
            assert_eq!(class(n).unwrap().tram_total_cm(), Some(w), "{n}");
        }
        assert_eq!(class("ramp").unwrap().tram, None, "trams get their own ramp");
    }

    #[test]
    fn capacity_is_one_car_per_7_5_m_and_the_slider_stops_at_level_of_service_d() {
        let km = 100_000;
        let (local, avenue, boulevard, highway) = (class("local").unwrap(), class("avenue").unwrap(), class("boulevard").unwrap(), class("highway").unwrap());
        assert_eq!([local.cap(km), avenue.cap(km), boulevard.cap(km), highway.cap(km)], [266, 533, 800, 1_066]);
        assert_eq!([local.target(1000, km), avenue.target(1000, km), boulevard.target(1000, km), highway.target(1000, km)], [44, 88, 132, 176]);
        assert_eq!(boulevard.target(500, km), 66);
        assert_eq!(local.target(0, km), 0);
        // never above the cap, whatever the slider says
        assert!(CLASSES.iter().all(|c| c.target(5_000, 1_234) <= c.cap(1_234)));
    }

    #[test]
    fn curves_and_tapers_follow_the_design_speed() {
        assert_eq!(class("shared").unwrap().min_radius_cm(false), 1_500);
        assert_eq!(class("shared").unwrap().min_radius_cm(true), 2_500, "a tram needs 25 m");
        assert_eq!(class("highway").unwrap().min_radius_cm(false), 49_000);
        assert_eq!(class("expressway").unwrap().min_radius_cm(false), 28_000);
        // avenue to boulevard at 60 km/h adds 7 m of lanes: a 163 m taper
        assert_eq!(taper_cm(700, 60) / 100, 162);
        assert_eq!(taper_cm(700, 80), 34_720);
    }

    #[test]
    fn roads_change_class_one_step_at_a_time() {
        assert!(one_step("local", "collector") && one_step("boulevard", "expressway") && one_step("avenue", "avenue"));
        assert!(!one_step("local", "avenue") && !one_step("collector", "highway"));
        assert!(one_step("shared", "local") && one_step("service", "collector") && !one_step("service", "highway"));
    }

    #[test]
    fn a_class_steps_up_one_at_a_time() {
        assert_eq!(step_up("avenue"), "boulevard");
        assert_eq!(step_up("boulevard"), "expressway");
        assert_eq!(step_up("shared"), "local");
        assert!(one_step("shared", step_up("shared")) && one_step("service", step_up("service")));
        assert_eq!(step_up("highway"), "highway");
        assert!(LADDER.iter().all(|&c| one_step(c, step_up(c))));
    }

    #[test]
    fn the_junction_comes_from_the_road_pair() {
        assert_eq!(junction("local", "lane"), Junction::Priority);
        assert_eq!(junction("local", "avenue"), Junction::Priority);
        assert_eq!(junction("collector", "avenue"), Junction::RoundaboutOrSignals);
        assert_eq!(junction("avenue", "boulevard"), Junction::Signals);
        assert_eq!(junction("collector", "collector"), Junction::RoundaboutOrSignals);
        assert_eq!(junction("boulevard", "boulevard"), Junction::SignalsOrBigRoundabout);
        assert_eq!(junction("expressway", "avenue"), Junction::Diamond);
        assert_eq!(junction("highway", "expressway"), Junction::Interchange);
        assert_eq!(junction("highway", "boulevard"), Junction::Crossing);
        assert_eq!(junction("local", "expressway"), Junction::Never);
    }

    #[test]
    fn todays_roads_map_onto_a_class() {
        assert_eq!(legacy("local", 1_100), "local");
        assert_eq!(legacy("local", 1_600), "collector");
        assert_eq!(legacy("arterial", 1_950), "avenue");
        assert_eq!(legacy("ring", 1_200), "expressway");
        assert!(["lane", "local", "collector", "avenue", "boulevard", "expressway"].iter().all(|n| class(n).is_some()));
    }
}
