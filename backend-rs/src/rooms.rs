//! Websocket rooms: presence, broadcast, shared state.
//!
//! The Python keeps a dict guarded by an asyncio lock. Here a `broadcast`
//! channel does the fan-out and the compiler enforces that shared state is
//! only touched behind the mutex -- the data race the Python version avoids
//! by convention is not expressible.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{broadcast, Mutex};

pub const MAX_ROOM_MEMBERS: usize = 32;
pub const MAX_STATE_BYTES: usize = 64 * 1024;

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
    pub async fn join(
        &self,
        room_id: &str,
        conn_id: u64,
        member: Member,
    ) -> Option<(broadcast::Receiver<String>, Value, Value)> {
        let mut rooms = self.rooms.lock().await;
        let room = rooms.entry(room_id.to_string()).or_insert_with(|| Room {
            tx: broadcast::channel(256).0,
            members: Vec::new(),
            state: json!({}),
        });
        if room.members.len() >= MAX_ROOM_MEMBERS {
            return None;
        }
        room.members.push((conn_id, member.clone()));
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
    async fn rooms_are_full_at_the_cap() {
        let m = RoomManager::new();
        for i in 0..MAX_ROOM_MEMBERS as u64 {
            assert!(m.join("full", i, member(&format!("u{i}"))).await.is_some());
        }
        assert!(m.join("full", 999, member("late")).await.is_none());
    }
}
