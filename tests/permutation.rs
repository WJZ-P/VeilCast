use std::collections::HashSet;

use veilcast_core::{seed_from_text, seeded_permutation};

#[test]
fn known_answer_vectors_pin_the_algorithm() {
    // Any other implementation (e.g. the browser restorer) must reproduce these.
    assert_eq!(
        seeded_permutation(16, 1),
        [2, 11, 10, 6, 7, 13, 14, 0, 12, 5, 15, 9, 3, 8, 4, 1]
    );
    assert_eq!(
        seeded_permutation(12, 20260916),
        [7, 9, 10, 5, 1, 0, 2, 11, 3, 6, 4, 8]
    );
}

#[test]
fn produces_a_permutation_for_every_size() {
    for tile_count in [0, 1, 2, 3, 64, 3600] {
        let permutation = seeded_permutation(tile_count, 42);
        assert_eq!(permutation.len(), tile_count);
        let distinct: HashSet<_> = permutation.iter().copied().collect();
        assert_eq!(distinct.len(), tile_count);
        assert!(permutation.iter().all(|&tile| tile < tile_count));
    }
}

#[test]
fn seeds_are_deterministic_and_distinct() {
    assert_eq!(seeded_permutation(256, 9), seeded_permutation(256, 9));
    assert_ne!(seeded_permutation(256, 9), seeded_permutation(256, 10));
    assert_ne!(
        seeded_permutation(256, 0),
        seeded_permutation(256, u64::MAX)
    );
}

#[test]
fn text_seeds_use_numbers_verbatim_and_fnv1a_otherwise() {
    assert_eq!(seed_from_text("20260916"), 20260916);
    assert_eq!(seed_from_text("007"), 7);
    assert_eq!(seed_from_text("18446744073709551615"), u64::MAX);
    // Standard FNV-1a 64 vectors.
    assert_eq!(seed_from_text(""), 0xcbf2_9ce4_8422_2325);
    assert_eq!(seed_from_text("a"), 0xaf63_dc4c_8601_ec8c);
    // Pinned for the browser implementation.
    assert_eq!(seed_from_text("veilcast"), 0x88d4_4f40_babc_4fa2);
    assert_eq!(seed_from_text("密码"), 0x0e40_25f7_0675_fc15);
    assert_eq!(seed_from_text("-1"), 0x07d0_0b07_b497_d12b);
    assert_eq!(
        seed_from_text("18446744073709551616"),
        0xedf2_aa6b_38fc_416d
    );
}
