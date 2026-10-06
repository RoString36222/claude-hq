//! Websocket rooms: presence, broadcast, shared state.
//!
//! The Python keeps a dict guarded by an asyncio lock. Here a `broadcast`
//! channel does the fan-out and the compiler enforces that shared state is
//! only touched behind the mutex -- the data race the Python version avoids
//! by convention is not expressible.
//!
//! Besides the room-wide broadcast, every connection that joins through
//! [`RoomManager::join_direct`] gets its own bounded mpsc queue, so the Valley
//! games can address one socket, one user's sockets or a lobby (the Python
//! iterates `room.members` and writes to each websocket). A socket whose queue
//! is full drops the message, the counterpart of the Python's per-send timeout:
//! one slow player never holds up the others.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{broadcast, mpsc, Mutex};

pub const MAX_ROOM_MEMBERS: usize = 32;
pub const MAX_STATE_BYTES: usize = 64 * 1024;
/// Messages one connection's direct queue holds before new ones are dropped.
pub const DIRECT_QUEUE: usize = 256;

#[derive(Clone, Debug)]
pub struct Member {
    pub user_id: String,
    pub handle: String,
    pub display_name: String,
    pub avatar_url: String,
}

impl Member {
    pub fn public(&self) -> Value {
        json!({
            "userId": self.user_id, "handle": self.handle,
            "displayName": self.display_name, "avatarUrl": self.avatar_url,
        })
    }
}

pub struct Room {
    pub tx: broadcast::Sender<String>,
    pub members: Vec<(u64, Member)>,
    pub state: Value,
    /// conn_id -> that socket's direct queue (only for join_direct connections).
    pub direct: HashMap<u64, mpsc::Sender<String>>,
}

#[derive(Clone, Default)]
pub struct RoomManager {
    rooms: Arc<Mutex<HashMap<String, Room>>>,
}

impl RoomManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// Returns the receiver, the roster and current state for a late joiner.
    #[cfg_attr(not(test), allow(dead_code))] // handle_socket uses join_direct
    pub async fn join(
        &self,
        room_id: &str,
        conn_id: u64,
        member: Member,
    ) -> Option<(broadcast::Receiver<String>, Value, Value)> {
        self.join_inner(room_id, conn_id, member, None).await
    }

    /// `join`, plus a direct queue for messages addressed to this connection only.
    pub async fn join_direct(
        &self,
        room_id: &str,
        conn_id: u64,
        member: Member,
    ) -> Option<(broadcast::Receiver<String>, mpsc::Receiver<String>, Value, Value)> {
        let (dtx, drx) = mpsc::channel(DIRECT_QUEUE);
        let (rx, roster, state) = self.join_inner(room_id, conn_id, member, Some(dtx)).await?;
        Some((rx, drx, roster, state))
    }

    async fn join_inner(
        &self,
        room_id: &str,
        conn_id: u64,
        member: Member,
        direct: Option<mpsc::Sender<String>>,
    ) -> Option<(broadcast::Receiver<String>, Value, Value)> {
        let mut rooms = self.rooms.lock().await;
        let room = rooms.entry(room_id.to_string()).or_insert_with(|| Room {
            tx: broadcast::channel(256).0,
            members: Vec::new(),
            state: json!({}),
            direct: HashMap::new(),
        });
        if room.members.len() >= MAX_ROOM_MEMBERS {
            return None;
        }
        room.members.push((conn_id, member.clone()));
        if let Some(d) = direct {
            room.direct.insert(conn_id, d);
        }
        let roster = Self::roster(room);
        let state = room.state.clone();
        // Announce BEFORE subscribing, so the joiner does not receive its own
        // join event -- the Python skips the joining socket explicitly, and a
        // client that sees itself arrive would double-count presence.
        let _ = room.tx.send(
            json!({"type": "join", "member": member.public(), "members": roster}).to_string(),
        );
        let rx = room.tx.subscribe();
        Some((rx, roster, state))
    }

    pub async fn leave(&self, room_id: &str, conn_id: u64) {
        let mut rooms = self.rooms.lock().await;
        let Some(room) = rooms.get_mut(room_id) else { return };
        let Some(pos) = room.members.iter().position(|(c, _)| *c == conn_id) else { return };
        let (_, member) = room.members.remove(pos);
        room.direct.remove(&conn_id);
        if room.members.is_empty() {
            rooms.remove(room_id);
            return;
        }
        let roster = Self::roster(room);
        let _ = room.tx.send(
            json!({"type": "leave", "member": member.public(), "members": roster}).to_string(),
        );
    }

    pub async fn broadcast(&self, room_id: &str, msg: String) {
        if let Some(room) = self.rooms.lock().await.get(room_id) {
            let _ = room.tx.send(msg);
        }
    }

    pub async fn exists(&self, room_id: &str) -> bool {
        self.rooms.lock().await.contains_key(room_id)
    }

    /// Send to one connection. False if it is gone or its queue is full.
    pub async fn send_conn(&self, room_id: &str, conn_id: u64, msg: String) -> bool {
        let rooms = self.rooms.lock().await;
        let Some(d) = rooms.get(room_id).and_then(|r| r.direct.get(&conn_id)) else { return false };
        d.try_send(msg).is_ok()
    }

    /// Send to every connection in the room whose user passes `pick`, through
    /// the direct queues (so it stays in order with the other direct messages).
    /// Returns how many sockets it reached.
    pub async fn send_where(&self, room_id: &str, pick: impl Fn(&Member) -> bool, msg: String) -> usize {
        let rooms = self.rooms.lock().await;
        let Some(room) = rooms.get(room_id) else { return 0 };
        Self::fan_out(room, &pick, &msg)
    }

    /// Every socket of `user_id` in every room (game invites). Returns how many.
    pub async fn deliver_to_user(&self, user_id: &str, msg: String) -> usize {
        let rooms = self.rooms.lock().await;
        rooms.values().map(|r| Self::fan_out(r, &|m: &Member| m.user_id == user_id, &msg)).sum()
    }

    /// How many sockets in the room belong to users passing `pick`.
    pub async fn count_where(&self, room_id: &str, pick: impl Fn(&Member) -> bool) -> usize {
        let rooms = self.rooms.lock().await;
        rooms.get(room_id).map(|r| r.members.iter().filter(|(_, m)| pick(m)).count()).unwrap_or(0)
    }

    /// Does the room hold a socket other than `conn_id` passing `pick`?
    pub async fn other_conn(&self, room_id: &str, conn_id: u64, pick: impl Fn(&Member) -> bool) -> bool {
        let rooms = self.rooms.lock().await;
        rooms.get(room_id)
            .map(|r| r.members.iter().any(|(c, m)| *c != conn_id && pick(m)))
            .unwrap_or(false)
    }

    fn fan_out(room: &Room, pick: &dyn Fn(&Member) -> bool, msg: &str) -> usize {
        room.members
            .iter()
            .filter(|(_, m)| pick(m))
            .filter_map(|(c, _)| room.direct.get(c))
            .filter(|d| d.try_send(msg.to_string()).is_ok())
            .count()
    }

    /// Merge a patch into shared state. Returns the merged state, or None if
    /// it would exceed the size cap.
    pub async fn patch_state(&self, room_id: &str, patch: &Value) -> Option<Value> {
        let mut rooms = self.rooms.lock().await;
        let room = rooms.get_mut(room_id)?;
        let mut merged = room.state.clone();
        if let (Some(m), Some(p)) = (merged.as_object_mut(), patch.as_object()) {
            for (k, v) in p {
                m.insert(k.clone(), v.clone());
            }
        }
        if merged.to_string().len() > MAX_STATE_BYTES {
            return None;
        }
        room.state = merged.clone();
        Some(merged)
    }

    pub async fn summary(&self) -> Vec<Value> {
        self.rooms
            .lock()
            .await
            .iter()
            .map(|(id, r)| json!({"roomId": id, "members": Self::roster(r).as_array().map(|a| a.len()).unwrap_or(0)}))
            .collect()
    }

    /// One entry per person, not per socket -- a laptop and a desktop are one player.
    fn roster(room: &Room) -> Value {
        let mut seen: Vec<String> = Vec::new();
        let mut out: Vec<Value> = Vec::new();
        for (_, m) in &room.members {
            if !seen.contains(&m.user_id) {
                seen.push(m.user_id.clone());
                out.push(m.public());
            }
        }
        Value::Array(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn member(id: &str) -> Member {
        Member { user_id: id.into(), handle: id.into(),
                 display_name: id.into(), avatar_url: String::new() }
    }

    #[tokio::test]
    async fn late_joiners_receive_current_state() {
        let m = RoomManager::new();
        m.join("lobby", 1, member("ash")).await.unwrap();
        m.patch_state("lobby", &json!({"round": 1})).await.unwrap();
        let (_, roster, state) = m.join("lobby", 2, member("gary")).await.unwrap();
        assert_eq!(state["round"], 1);
        assert_eq!(roster.as_array().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn one_person_on_two_devices_counts_once() {
        let m = RoomManager::new();
        m.join("lobby", 1, member("ash")).await.unwrap();
        let (_, roster, _) = m.join("lobby", 2, member("ash")).await.unwrap();
        assert_eq!(roster.as_array().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn a_joiner_does_not_receive_its_own_join_event() {
        let m = RoomManager::new();
        let (mut rx, _, _) = m.join("lobby", 1, member("ash")).await.unwrap();
        // Nothing queued for the joiner yet.
        assert!(rx.try_recv().is_err());
        // But it does see the next person arrive.
        m.join("lobby", 2, member("gary")).await.unwrap();
        let msg: serde_json::Value = serde_json::from_str(&rx.recv().await.unwrap()).unwrap();
        assert_eq!(msg["type"], "join");
        assert_eq!(msg["member"]["handle"], "gary");
    }

    #[tokio::test]
    async fn empty_rooms_are_reaped() {
        let m = RoomManager::new();
        m.join("ephemeral", 1, member("ash")).await.unwrap();
        assert_eq!(m.summary().await.len(), 1);
        m.leave("ephemeral", 1).await;
        assert_eq!(m.summary().await.len(), 0);
    }

    #[tokio::test]
    async fn oversized_state_is_refused() {
        let m = RoomManager::new();
        m.join("big", 1, member("ash")).await.unwrap();
        let huge = json!({"blob": "x".repeat(MAX_STATE_BYTES + 10)});
        assert!(m.patch_state("big", &huge).await.is_none());
    }

    #[tokio::test]
    async fn direct_queues_reach_one_socket_or_one_user() {
        let m = RoomManager::new();
        let (_, mut a1, _, _) = m.join_direct("r", 1, member("ash")).await.unwrap();
        let (_, mut a2, _, _) = m.join_direct("r", 2, member("ash")).await.unwrap();
        let (_, mut g, _, _) = m.join_direct("r", 3, member("gary")).await.unwrap();
        assert!(m.send_conn("r", 2, "one".into()).await);
        assert_eq!(a2.try_recv().unwrap(), "one");
        assert!(a1.try_recv().is_err() && g.try_recv().is_err());
        assert_eq!(m.send_where("r", |x| x.user_id == "ash", "both".into()).await, 2);
        assert_eq!((a1.try_recv().unwrap(), a2.try_recv().unwrap()), ("both".into(), "both".into()));
        assert!(g.try_recv().is_err());
        assert_eq!(m.deliver_to_user("gary", "hi".into()).await, 1);
        assert_eq!(g.try_recv().unwrap(), "hi");
        assert!(m.other_conn("r", 1, |x| x.user_id == "ash").await);
        m.leave("r", 2).await;
        assert!(!m.other_conn("r", 1, |x| x.user_id == "ash").await);
        assert!(!m.send_conn("r", 2, "gone".into()).await);
    }

    #[tokio::test]
    async fn a_full_direct_queue_drops_instead_of_blocking() {
        let m = RoomManager::new();
        let (_, _rx, _, _) = m.join_direct("q", 1, member("ash")).await.unwrap();
        for _ in 0..DIRECT_QUEUE {
            assert!(m.send_conn("q", 1, "x".into()).await);
        }
        assert!(!m.send_conn("q", 1, "x".into()).await);
    }

    #[tokio::test]
    async fn rooms_are_full_at_the_cap() {
        let m = RoomManager::new();
        for i in 0..MAX_ROOM_MEMBERS as u64 {
            assert!(m.join("full", i, member(&format!("u{i}"))).await.is_some());
        }
        assert!(m.join("full", 999, member("late")).await.is_none());
    }
}
