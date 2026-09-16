use veilcast_core::{Error, FrameLayout, PixelFormat, ShufflePlan};

fn small_layout() -> FrameLayout {
    FrameLayout::new(4, 2, PixelFormat::Gray8, 4).unwrap()
}

#[test]
fn known_mapping_has_the_documented_direction() {
    // Four-cycle, deliberately different from its inverse.
    let plan = ShufflePlan::new(small_layout(), 2, 1, &[2, 0, 3, 1]).unwrap();
    let original = [0, 1, 2, 3, 4, 5, 6, 7];
    let mut scrambled = [0; 8];
    let mut restored = [0; 8];

    plan.scramble(&original, &mut scrambled).unwrap();
    assert_eq!(scrambled, [4, 5, 0, 1, 6, 7, 2, 3]);
    plan.restore(&scrambled, &mut restored).unwrap();
    assert_eq!(restored, original);
    assert_eq!(plan.layout(), small_layout());
}

#[test]
fn identity_keeps_visible_pixels() {
    let plan = ShufflePlan::new(small_layout(), 2, 1, &[0, 1, 2, 3]).unwrap();
    let original = [0, 1, 2, 3, 4, 5, 6, 7];
    let mut output = [0; 8];
    plan.scramble(&original, &mut output).unwrap();
    assert_eq!(output, original);
}

#[test]
fn formats_tile_sizes_and_strides_match_a_pixel_reference() {
    for format in [PixelFormat::Gray8, PixelFormat::Rgb24, PixelFormat::Rgba32] {
        for (tile_width, tile_height) in [(1, 1), (2, 2), (4, 3), (8, 6)] {
            for padding in [0, 5] {
                let bpp = format.bytes_per_pixel();
                let stride = 8 * bpp + padding;
                let layout = FrameLayout::new(8, 6, format, stride).unwrap();
                let columns = 8 / tile_width;
                let tile_count = columns * (6 / tile_height);
                let mut permutation: Vec<_> = (0..tile_count).collect();
                permutation.rotate_left(tile_count / 3);
                permutation.reverse();
                let plan = ShufflePlan::new(layout, tile_width, tile_height, &permutation).unwrap();

                // Reuse both the plan and destination buffers across distinct frames.
                let mut scrambled = vec![0xcc; layout.buffer_len() + 7];
                let mut restored = vec![0xee; layout.buffer_len() + 7];
                for frame in 0..2 {
                    let source: Vec<u8> = (0..layout.buffer_len())
                        .map(|i| ((i * 37 + frame * 19) % 251) as u8)
                        .collect();
                    let mut expected = vec![0xcc; layout.buffer_len() + 7];
                    // Independent per-pixel reference, including all channels.
                    for y in 0..6 {
                        for x in 0..8 {
                            let destination_tile = (y / tile_height) * columns + x / tile_width;
                            let source_tile = permutation[destination_tile];
                            let sx = (source_tile % columns) * tile_width + x % tile_width;
                            let sy = (source_tile / columns) * tile_height + y % tile_height;
                            for channel in 0..bpp {
                                expected[y * stride + x * bpp + channel] =
                                    source[sy * stride + sx * bpp + channel];
                            }
                        }
                    }
                    plan.scramble(&source, &mut scrambled).unwrap();
                    assert_eq!(scrambled, expected);
                    plan.restore(&scrambled, &mut restored).unwrap();
                    for row in 0..6 {
                        let start = row * stride;
                        assert_eq!(
                            &restored[start..start + 8 * bpp],
                            &source[start..start + 8 * bpp]
                        );
                        assert!(
                            restored[start + 8 * bpp..start + stride]
                                .iter()
                                .all(|&b| b == 0xee)
                        );
                    }
                    assert!(restored[layout.buffer_len()..].iter().all(|&b| b == 0xee));
                }
            }
        }
    }
}

#[test]
fn rejects_empty_frames_and_short_strides() {
    for (width, height) in [(0, 2), (4, 0)] {
        assert_eq!(
            FrameLayout::new(width, height, PixelFormat::Gray8, 4),
            Err(Error::EmptyFrame)
        );
    }
    assert_eq!(
        FrameLayout::new(4, 2, PixelFormat::Rgb24, 11),
        Err(Error::InvalidStride {
            minimum: 12,
            actual: 11
        })
    );
}

#[test]
fn rejects_size_overflow_before_allocating() {
    for (width, height, format, stride) in [
        (usize::MAX, 1, PixelFormat::Rgba32, usize::MAX),
        (1, 2, PixelFormat::Gray8, usize::MAX),
        (1, 1, PixelFormat::Gray8, isize::MAX as usize + 1),
    ] {
        assert_eq!(
            FrameLayout::new(width, height, format, stride),
            Err(Error::SizeOverflow)
        );
    }
}

#[test]
fn rejects_empty_or_unaligned_tiles() {
    for (width, height) in [(0, 1), (2, 0)] {
        assert_eq!(
            ShufflePlan::new(small_layout(), width, height, &[]).unwrap_err(),
            Error::EmptyTile
        );
    }
    for (width, height) in [(3, 1), (2, 3), (8, 1)] {
        assert_eq!(
            ShufflePlan::new(small_layout(), width, height, &[]).unwrap_err(),
            Error::UnalignedTileGrid
        );
    }
}

#[test]
fn rejects_wrong_permutation_length() {
    assert_eq!(
        ShufflePlan::new(small_layout(), 2, 1, &[0, 1, 2]).unwrap_err(),
        Error::PermutationLength {
            expected: 4,
            actual: 3
        }
    );
}

#[test]
fn rejects_duplicate_tiles() {
    assert_eq!(
        ShufflePlan::new(small_layout(), 2, 1, &[0, 1, 1, 3]).unwrap_err(),
        Error::DuplicateTile { index: 1 }
    );
}

#[test]
fn rejects_out_of_range_tiles() {
    assert_eq!(
        ShufflePlan::new(small_layout(), 2, 1, &[0, 1, 2, usize::MAX]).unwrap_err(),
        Error::TileOutOfRange {
            index: usize::MAX,
            tile_count: 4
        }
    );
}

#[test]
fn buffer_errors_leave_destination_unchanged_in_both_directions() {
    let plan = ShufflePlan::new(small_layout(), 2, 1, &[2, 0, 3, 1]).unwrap();
    for transform in [ShufflePlan::scramble, ShufflePlan::restore] {
        let mut destination = [0xcc; 8];
        assert_eq!(
            transform(&plan, &[0; 7], &mut destination),
            Err(Error::BufferTooSmall {
                buffer: "source",
                required: 8,
                actual: 7
            })
        );
        assert_eq!(destination, [0xcc; 8]);

        let mut short_destination = [0xcc; 7];
        assert_eq!(
            transform(&plan, &[0; 8], &mut short_destination),
            Err(Error::BufferTooSmall {
                buffer: "destination",
                required: 8,
                actual: 7
            })
        );
        assert_eq!(short_destination, [0xcc; 7]);
    }
}
