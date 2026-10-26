//! HQ 3.22 Arena play (games/playarena.js, the "cityplay" capability in protocol.rs): the one directed frame the City's
//! Arena games need beyond presence (valley/hq.rs `pk` / `pi` / `pj` / `pq`).
//!
//!   {type: "ghost", to, r, g, t}   a race ghost for ONE player in the same hq room: `r` the route id (1..=ROUTE_MAX of
//!                                  [A-Za-z0-9:_-]), `g` the encoded ghost (games/playraces.js encodeGhost: "g1:" then
//!                                  base-36 deltas, [0-9a-z,-] only, at most GHOST_MAX characters) and `t` its time in
//!                                  centiseconds (1..=T_MAX). Relayed as {type: "ghost", from, r, g, t} to the target's
//!                                  sockets in this room only, GHOST_PER_MIN a minute per socket, acknowledged with
//!                                  {type: "ghost_ack", to, delivered}. Never stored, never broadcast.
//!
//! A ghost is the sender's own run through the City's streets (positions and headings every 0.2 s): nothing from
//! their sessions. The page sends one only to someone who accepted a ghost race with them, and takes one only from them.

use crate::rooms::{Member, RoomManager};
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::time::Instant;

pub const ROUTE_MAX: usize = 40;
pub const GHOST_MAX: usize = 12_000;
pub const T_MAX: i64 = 360_000;
pub const GHOST_PER_MIN: usize = 6;

/// A sliding one-minute window.
#[derive(Default)]
pub struct Limits(VecDeque<Instant>);

impl Limits {
    pub fn allow(&mut self, now: Instant) -> bool {
        while self.0.front().is_some_and(|t| now.duration_since(*t).as_secs_f64() >= 60.0) {
            self.0.pop_front();
        }
        if self.0.len() >= GHOST_PER_MIN {
            return false;
        }
        self.0.push_back(now);
        true
    }
}

fn uid_ok(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

pub fn route_ok(s: &str) -> bool {
    !s.is_empty() && s.len() <= ROUTE_MAX && s.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b':' | b'_' | b'-'))
}

pub fn ghost_ok(s: &str) -> bool {
    s.len() <= GHOST_MAX
        && s.strip_prefix("g1:").is_some_and(|b| b.bytes().all(|c| c.is_ascii_digit() || c.is_ascii_lowercase() || c == b',' || c == b'-'))
}

/// The frame's target, route, ghost and time when every one is good, else None.
pub fn read(me: &str, v: &Value) -> Option<(String, String, String, i64)> {
    let to = v.get("to")?.as_str().filter(|t| uid_ok(t) && *t != me)?;
    let r = v.get("r")?.as_str().filter(|r| route_ok(r))?;
    let g = v.get("g")?.as_str().filter(|g| ghost_ok(g))?;
    let t = v.get("t")?.as_i64().filter(|t| (1..=T_MAX).contains(t))?;
    Some((to.to_string(), r.to_string(), g.to_string(), t))
}

async fn error(rooms: &RoomManager, rid: &str, conn: u64, e: &str) {
    rooms.send_conn(rid, conn, json!({"type": "error", "error": e}).to_string()).await;
}

pub async fn handle(rooms: &RoomManager, rid: &str, conn: u64, me: &Member, v: &Value, lim: &mut Limits) {
    if !rid.starts_with("hq_") {
        return error(rooms, rid, conn, "ghost: only in an HQ or the City").await;
    }
    let Some((to, r, g, t)) = read(&me.user_id, v) else {
        return error(rooms, rid, conn, "ghost needs a target userId, a route, a ghost and a time").await;
    };
    if !lim.allow(Instant::now()) {
        return error(rooms, rid, conn, "ghost: slow down \u{2014} at most 6 a minute").await;
    }
    let msg = json!({"type": "ghost", "from": me.public(), "r": r, "g": g, "t": t});
    let n = rooms.send_where_except(rid, conn, |m| m.user_id == to, msg.to_string()).await;
    rooms.send_conn(rid, conn, json!({"type": "ghost_ack", "to": to, "delivered": n}).to_string()).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn member(id: &str) -> Member {
        Member { user_id: id.into(), handle: id.into(), display_name: id.into(), avatar_url: String::new(), cos: Value::Null }
    }

    fn drain(rx: &mut tokio::sync::mpsc::Receiver<String>) -> Vec<Value> {
        let mut out = Vec::new();
        while let Ok(m) = rx.try_recv() {
            out.push(serde_json::from_str(&m).unwrap());
        }
        out
    }

    #[test]
    fn a_ghost_frame_is_checked_field_by_field() {
        let ok = json!({"type": "ghost", "to": "bob", "r": "sprint-1a2b", "g": "g1:a,-b,0,1,2,3", "t": 8350});
        assert_eq!(read("ann", &ok), Some(("bob".into(), "sprint-1a2b".into(), "g1:a,-b,0,1,2,3".into(), 8350)));
        assert!(read("ann", &json!({"to": "bob", "r": "x", "g": "g1:", "t": T_MAX})).is_some());
        assert!(read("ann", &json!({"to": "bob", "r": "x".repeat(ROUTE_MAX), "g": format!("g1:{}", "1".repeat(GHOST_MAX - 3)), "t": 1})).is_some());
        let base = ok.as_object().unwrap().clone();
        for (k, bad) in [("to", json!("ann")), ("to", json!("")), ("to", json!("a b")), ("to", json!(7)), ("to", json!("x".repeat(65))),
                         ("r", json!("")), ("r", json!("a/b")), ("r", json!("x".repeat(ROUTE_MAX + 1))), ("r", json!(3)),
                         ("g", json!("g2:1")), ("g", json!("1,2")), ("g", json!("g1:A")), ("g", json!("g1:<b>")), ("g", json!("g1:1 2")),
                         ("g", json!(format!("g1:{}", "1".repeat(GHOST_MAX - 2)))), ("g", json!(["g1:"])),
                         ("t", json!(0)), ("t", json!(-5)), ("t", json!(T_MAX + 1)), ("t", json!(1.5)), ("t", json!("100"))] {
            let mut m = base.clone();
            m.insert(k.into(), bad.clone());
            assert!(read("ann", &Value::Object(m)).is_none(), "{k} {bad}");
        }
        for k in ["to", "r", "g", "t"] {
            let mut m = base.clone();
            m.remove(k);
            assert!(read("ann", &Value::Object(m)).is_none(), "{k} missing");
        }
    }

    #[tokio::test]
    async fn a_ghost_reaches_only_its_target_in_the_room_six_a_minute() {
        let r = RoomManager::new();
        let rid = "hq_city";
        let (_, mut a, _, _) = r.join_direct(rid, 1, member("ann")).await.unwrap();
        let (_, mut b, _, _) = r.join_direct(rid, 2, member("bob")).await.unwrap();
        let (_, mut c, _, _) = r.join_direct(rid, 3, member("cat")).await.unwrap();
        let (_, mut b2, _, _) = r.join_direct("hq_ann", 4, member("bob")).await.unwrap();
        let mut lim = Limits::default();
        let f = json!({"type": "ghost", "to": "bob", "r": "sprint-1", "g": "g1:1,2,3", "t": 4200});
        handle(&r, rid, 1, &member("ann"), &f, &mut lim).await;
        assert_eq!(drain(&mut b), vec![json!({"type": "ghost", "from": member("ann").public(), "r": "sprint-1", "g": "g1:1,2,3", "t": 4200})]);
        assert!(drain(&mut c).is_empty() && drain(&mut b2).is_empty(), "nobody else, and not bob's other room");
        assert_eq!(drain(&mut a), vec![json!({"type": "ghost_ack", "to": "bob", "delivered": 1})]);
        // a bad frame is answered and goes nowhere
        handle(&r, rid, 1, &member("ann"), &json!({"type": "ghost", "to": "bob", "r": "sprint-1", "g": "<script>", "t": 4200}), &mut lim).await;
        assert!(drain(&mut a)[0]["error"].is_string());
        assert!(drain(&mut b).is_empty());
        // six a minute (one went already)
        for _ in 0..5 {
            handle(&r, rid, 1, &member("ann"), &f, &mut lim).await;
        }
        assert_eq!(drain(&mut b).len(), 5);
        drain(&mut a);
        handle(&r, rid, 1, &member("ann"), &f, &mut lim).await;
        assert!(drain(&mut b).is_empty());
        assert!(drain(&mut a)[0]["error"].as_str().unwrap().contains("6 a minute"));
        // outside an hq room: refused
        let (_, mut q, _, _) = r.join_direct("lobby", 9, member("ann")).await.unwrap();
        handle(&r, "lobby", 9, &member("ann"), &f, &mut Limits::default()).await;
        assert_eq!(drain(&mut q)[0]["error"], "ghost: only in an HQ or the City");
    }
}
