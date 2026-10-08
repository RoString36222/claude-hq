//! Party Mode: a playlist of the room's games with one combined score.
//!
//! Ported from backend/app/party.py. STUB: the shared layer in `super` is finished and this
//! file is not. See the "WHAT IS NOT HERE YET" note at the top of
//! `backend-rs/src/valley.rs` for the contract.

use super::Out;
use crate::rooms::Member;
use serde_json::Value;

/// Not a [`super::GAMES`] member: Python short-circuits party ahead of every
/// other check in `handle`, and its state is module-level, like party.py's
/// `_parties` -- not a [`super::RoomValley`] field.
pub const GAME: &str = "party";

/// Python's `partymod.op(room_id, member, op, out)`.
pub fn op(room_id: &str, member: &Member, op: &str, out: &mut Out) {
    let _ = (room_id, member, op, out);
}

/// Python's `partymod.on_done(room_id, g, payload, members)`: the message the
/// flush appends after a game's results are kept, or None.
pub fn on_done(room_id: &str, g: &str, payload: &Value, members: &Value) -> Option<Value> {
    let _ = (room_id, g, payload, members);
    None
}
