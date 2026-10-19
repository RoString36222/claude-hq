//! Integer value noise. Fixed point (Q16) all the way, no floats and no trig,
//! so the same seed gives the same terrain on every platform.

use super::rng::mix64;

/// 1.0 in Q16.
pub const ONE: i64 = 1 << 16;

/// A lattice value in -32768..=32767.
fn lattice(seed: u64, ix: i64, iz: i64) -> i64 {
    let h = mix64(seed ^ (ix as u64).wrapping_mul(0x9e37_79b9_7f4a_7c15) ^ (iz as u64).wrapping_mul(0xc2b2_ae3d_27d4_eb4f));
    (h >> 48) as i64 - 32768
}

/// 3f^2 - 2f^3 for f in 0..=ONE.
pub fn smoothstep(f: i64) -> i64 {
    let f = f.clamp(0, ONE);
    let f2 = f * f / ONE;
    let f3 = f2 * f / ONE;
    3 * f2 - 2 * f3
}

/// Value noise at (x, z) cm, lattice spacing `cell` cm: -32768..=32767.
pub fn value(seed: u64, x: i64, z: i64, cell: i64) -> i64 {
    let (ix, iz) = (x.div_euclid(cell), z.div_euclid(cell));
    let fx = smoothstep(x.rem_euclid(cell) * ONE / cell);
    let fz = smoothstep(z.rem_euclid(cell) * ONE / cell);
    let a = lattice(seed, ix, iz);
    let b = lattice(seed, ix + 1, iz);
    let c = lattice(seed, ix, iz + 1);
    let d = lattice(seed, ix + 1, iz + 1);
    let ab = a + (b - a) * fx / ONE;
    let cd = c + (d - c) * fx / ONE;
    ab + (cd - ab) * fz / ONE
}

/// A fractal sum of octaves, each `(cell cm, amplitude cm)`. Returns cm.
pub fn fbm(seed: u64, x: i64, z: i64, octaves: &[(i64, i64)]) -> i64 {
    octaves
        .iter()
        .enumerate()
        .map(|(i, &(cell, amp))| value(seed.wrapping_add((i as u64).wrapping_mul(0x632b_e59b_d9b4_e019)), x, z, cell) * amp / 32768)
        .sum()
}

/// Floor integer square root.
pub fn isqrt(n: i64) -> i64 {
    if n <= 0 {
        return 0;
    }
    let mut r = (n as f64).sqrt() as i64; // IEEE sqrt is exact-rounded; the loops fix the edge
    while r * r > n {
        r -= 1;
    }
    while (r + 1) * (r + 1) <= n {
        r += 1;
    }
    r
}
