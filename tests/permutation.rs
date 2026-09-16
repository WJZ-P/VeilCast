use std::collections::HashSet;

use veilcast_core::seeded_permutation;

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
