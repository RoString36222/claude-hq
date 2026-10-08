//! The shared farm. The only Valley game that touches the database.
//!
//! Ported from backend/app/valley.py (_farm_load, _water, _farm_view, farm_op, CROPS). STUB: the shared layer in `super` is finished and this
//! file is not. See the "WHAT IS NOT HERE YET" note at the top of
//! `backend-rs/src/valley.rs` for the contract.

use super::{Out, ValleyHub};
use crate::rooms::Member;
use serde_json::Value;

/// The game key on the wire.
pub const GAME: &str = "farm";

/// Python's `await farm_op(room_id, member, msg, out, rng)`. Runs with the state
/// guard DROPPED, so it may await: it keeps no [`super::RoomValley`] state and
/// does the whole op -- load, mutate, commit, view -- against `hub.pool()`.
pub async fn run(
    hub: &ValleyHub, room_id: &str, conn: u64, member: &Member, msg: &Value, out: &mut Out,
) {
    let _ = (hub, room_id, conn, member, msg, out);
}
