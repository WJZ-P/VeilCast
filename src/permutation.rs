/// Deterministic tile permutation for a 64-bit seed.
///
/// Both ends of a pipeline rebuild the same permutation from the seed alone,
/// so the mapping itself never has to be transmitted. The algorithm is fixed
/// so that other implementations (for example the browser-side restorer) can
/// reproduce it exactly:
///
/// 1. `state = seed`, advanced by splitmix64: add `0x9E3779B97F4A7C15`, then
///    `z ^= z >> 30; z *= 0xBF58476D1CE4E5B9; z ^= z >> 27;
///    z *= 0x94D049BB133111EB; z ^= z >> 31`, all modulo 2^64.
/// 2. Fisher-Yates over `0..tile_count`: for `i` from `tile_count - 1` down to
///    `1`, swap `order[i]` with `order[next() % (i + 1)]`.
///
/// The modulo bias is irrelevant at video tile counts. This is obfuscation,
/// not encryption: anyone holding the seed can restore the frames.
pub fn seeded_permutation(tile_count: usize, seed: u64) -> Vec<usize> {
    let mut order: Vec<usize> = (0..tile_count).collect();
    let mut state = seed;
    for i in (1..tile_count).rev() {
        let j = (splitmix64(&mut state) % (i as u64 + 1)) as usize;
        order.swap(i, j);
    }
    order
}

//  一个非常经典的伪随机数生成算法
fn splitmix64(state: &mut u64) -> u64 {
    *state = state.wrapping_add(0x9E37_79B9_7F4A_7C15);
    let mut z = *state;
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

/// Turns user-entered text into a seed for [`seeded_permutation`].
///
/// Text that is a plain decimal number within `u64` is used as that number,
/// so a numeric seed round-trips through a text field exactly. Anything else
/// is hashed with 64-bit FNV-1a over its UTF-8 bytes (offset basis
/// `0xcbf29ce484222325`, prime `0x100000001b3`). Fixed for the same reason
/// as the permutation itself: the browser side must produce the same seed.
pub fn seed_from_text(text: &str) -> u64 {
    if let Ok(number) = text.parse::<u64>() {
        return number;
    }
    text.bytes().fold(0xcbf2_9ce4_8422_2325u64, |hash, byte| {
        (hash ^ u64::from(byte)).wrapping_mul(0x0000_0100_0000_01b3)
    })
}
