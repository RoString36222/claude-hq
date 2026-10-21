//! Seeded randomness. Integer-only, so a world is byte-identical on every
//! platform the server (or CI) runs on: FNV-1a turns the seed string into a
//! number, SplitMix64 derives a sub-seed per stage and drives each stream.

/// FNV-1a, 64-bit.
pub fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        h ^= *b as u64;
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    h
}

/// SplitMix64's finaliser: a good 64-bit mix of any input.
pub fn mix64(z: u64) -> u64 {
    let mut z = z.wrapping_add(0x9e37_79b9_7f4a_7c15);
    z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    z ^ (z >> 31)
}

/// A stage's own seed, from the world seed, the stage's name and two integers
/// (a chunk, an index). Stages never share a stream, so improving one stage
/// does not reshuffle the others.
pub fn sub(seed: u64, stage: &str, a: i64, b: i64) -> u64 {
    mix64(seed ^ fnv1a64(stage.as_bytes()) ^ mix64(a as u64) ^ mix64(b as u64).rotate_left(32))
}

/// A SplitMix64 stream.
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Rng(seed)
    }

    pub fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        mix64(self.0.wrapping_sub(0x9e37_79b9_7f4a_7c15))
    }

    /// Uniform in `lo..=hi`. (The modulo bias is far below anything a map can show.)
    pub fn range(&mut self, lo: i64, hi: i64) -> i64 {
        if hi <= lo {
            return lo;
        }
        lo + (self.next_u64() % (hi - lo + 1) as u64) as i64
    }

    /// True `per_mille` times in a thousand.
    pub fn chance(&mut self, per_mille: u32) -> bool {
        self.next_u64() % 1000 < per_mille as u64
    }

    /// Fisher-Yates, in place.
    pub fn shuffle<T>(&mut self, xs: &mut [T]) {
        for i in (1..xs.len()).rev() {
            let j = self.range(0, i as i64) as usize;
            xs.swap(i, j);
        }
    }
}
