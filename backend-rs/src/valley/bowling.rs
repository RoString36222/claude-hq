//! Bowling (HQ 2.5): a placeholder engine until the bowling builder lands its
//! referee. Every op answers an error, so the registry (lobby, protocol,
//! results, boards) can ship without a half-built game behind it.

use super::{Ctx, Left, Out, RoomValley};
use serde_json::{json, Value};

/// The game key on the wire.
pub const GAME: &str = "bowl";
pub const ERR_SOON: &str = "bowling is not refereed by this Arena yet";

/// The engine's state. Empty until the referee lands.
#[derive(Default)]
pub struct Bowling {}

pub fn joined(v: &mut RoomValley, cx: &mut Ctx, out: &mut Out) {
    let _ = &v.bowl;
    out.to(cx.conn, "bowl", json!({"bowl": {"phase": "idle"}}));
}

pub fn op(v: &mut RoomValley, cx: &mut Ctx, op: &str, msg: &Value, out: &mut Out) {
    let _ = (&v.bowl, op, msg);
    out.err(cx.conn, ERR_SOON);
}

pub fn dropped(
    v: &mut RoomValley, uid: &str, who: &Value, out: &mut Out, t: f64, disconnected: bool,
) -> Left {
    let _ = (&v.bowl, uid, who, out, t, disconnected);
    Left::Notice
}
