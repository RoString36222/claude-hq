//! The puzzle word race.
//!
//! Ported from backend/app/valley.py (mark(), class Race, RACE_WORDS). STUB: the shared layer in `super` is finished and this
//! file is not. See the "WHAT IS NOT HERE YET" note at the top of
//! `backend-rs/src/valley.rs` for the contract.

use super::{Ctx, Left, Out, RoomValley};
use serde_json::Value;

/// The game key on the wire.
pub const GAME: &str = "race";

/// Per-room state. One field of [`RoomValley`], in Python's `__init__` order.
#[derive(Default)]
pub struct Race {}

/// The join snapshot: Python's tail of the join arm for this game, pushed after
/// the shared `lobby` event.
pub fn joined(v: &mut RoomValley, cx: &mut Ctx, out: &mut Out) {
    let _ = (v, cx, out);
}

/// This game's ops. Reached only past the lobby gate. An unrecognised op must
/// produce NOTHING, as Python's `else`-less if/elif chains do.
pub fn op(v: &mut RoomValley, cx: &mut Ctx, op: &str, msg: &Value, out: &mut Out) {
    let _ = (v, cx, op, msg, out);
}

/// Someone left this game's lobby, by `leave` or by a dropped socket. Return
/// [`Left::Away`] only to suppress the `left` field, which today only duel does.
pub fn dropped(
    v: &mut RoomValley, uid: &str, who: &Value, out: &mut Out, t: f64, disconnected: bool,
) -> Left {
    let _ = (v, uid, who, out, t, disconnected);
    Left::Notice
}
