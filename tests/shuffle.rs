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
    assert_eq!(plan.original_layout(), small_layout());
    assert_eq!(plan.scrambled_layout(), small_layout());
    assert_eq!(plan.margin(), 0);
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
fn margin_replicates_frame_edges_and_is_discarded_on_restore() {
    // 4×2 frame, 2×1 tiles, identity mapping, one pixel of margin:
    // every block becomes 4×3 and the scrambled frame 8×6.
    let plan = ShufflePlan::with_margin(small_layout(), 2, 1, 1, &[0, 1, 2, 3]).unwrap();
    let scrambled_layout = plan.scrambled_layout();
    assert_eq!(
        scrambled_layout,
        FrameLayout::new(8, 6, PixelFormat::Gray8, 8).unwrap()
    );

    let original = [0, 1, 2, 3, 4, 5, 6, 7];
    let mut scrambled = [0xcc; 48];
    plan.scramble(&original, &mut scrambled).unwrap();
    #[rustfmt::skip]
    let expected = [
        0, 0, 1, 2,  1, 2, 3, 3, // tile 0 and tile 1, row above the frame clamped to row 0
        0, 0, 1, 2,  1, 2, 3, 3,
        4, 4, 5, 6,  5, 6, 7, 7,
        0, 0, 1, 2,  1, 2, 3, 3, // tile 2 and tile 3
        4, 4, 5, 6,  5, 6, 7, 7,
        4, 4, 5, 6,  5, 6, 7, 7, // row below the frame clamped to row 1
    ];
    assert_eq!(scrambled, expected);

    let mut restored = [0xee; 8];
    plan.restore(&scrambled, &mut restored).unwrap();
    assert_eq!(restored, original);
}

#[test]
fn formats_tile_sizes_strides_and_margins_match_a_pixel_reference() {
    for format in [PixelFormat::Gray8, PixelFormat::Rgb24, PixelFormat::Rgba32] {
        for (tile_width, tile_height) in [(1, 1), (2, 2), (4, 3), (8, 6)] {
            for padding in [0, 5] {
                for margin in [0, 3] {
                    check_against_reference(format, tile_width, tile_height, padding, margin);
                }
            }
        }
    }
}

fn check_against_reference(
    format: PixelFormat,
    tile_width: usize,
    tile_height: usize,
    padding: usize,
    margin: usize,
) {
    let (width, height) = (8, 6);
    let bpp = format.bytes_per_pixel();
    let stride = width * bpp + padding;
    let layout = FrameLayout::new(width, height, format, stride).unwrap();
    let columns = width / tile_width;
    let rows = height / tile_height;
    let tile_count = columns * rows;
    let mut permutation: Vec<_> = (0..tile_count).collect();
    permutation.rotate_left(tile_count / 3);
    permutation.reverse();
    let plan =
        ShufflePlan::with_margin(layout, tile_width, tile_height, margin, &permutation).unwrap();

    let block_width = tile_width + 2 * margin;
    let block_height = tile_height + 2 * margin;
    let scrambled_layout = plan.scrambled_layout();
    assert_eq!(scrambled_layout.width(), columns * block_width);
    assert_eq!(scrambled_layout.height(), rows * block_height);
    assert_eq!(scrambled_layout.format(), format);
    assert_eq!(
        scrambled_layout.stride(),
        columns * block_width * bpp + padding
    );
    let scrambled_stride = scrambled_layout.stride();

    // Reuse both the plan and destination buffers across distinct frames.
    let mut scrambled = vec![0xcc; scrambled_layout.buffer_len() + 7];
    let mut restored = vec![0xee; layout.buffer_len() + 7];
    for frame in 0..2 {
        let source: Vec<u8> = (0..layout.buffer_len())
            .map(|i| ((i * 37 + frame * 19) % 251) as u8)
            .collect();
        // Independent per-pixel reference, including all channels and edge clamping.
        let mut expected = vec![0xcc; scrambled_layout.buffer_len() + 7];
        for by in 0..scrambled_layout.height() {
            for bx in 0..scrambled_layout.width() {
                let block = (by / block_height) * columns + bx / block_width;
                let tile = permutation[block];
                let ox =
                    ((tile % columns) * tile_width + bx % block_width) as isize - margin as isize;
                let oy =
                    ((tile / columns) * tile_height + by % block_height) as isize - margin as isize;
                let ox = ox.clamp(0, width as isize - 1) as usize;
                let oy = oy.clamp(0, height as isize - 1) as usize;
                for channel in 0..bpp {
                    expected[by * scrambled_stride + bx * bpp + channel] =
                        source[oy * stride + ox * bpp + channel];
                }
            }
        }
        plan.scramble(&source, &mut scrambled).unwrap();
        assert_eq!(
            scrambled, expected,
            "{format:?} {tile_width}x{tile_height} pad {padding} margin {margin}"
        );

        plan.restore(&scrambled, &mut restored).unwrap();
        for row in 0..height {
            let start = row * stride;
            assert_eq!(
                &restored[start..start + width * bpp],
                &source[start..start + width * bpp]
            );
            assert!(
                restored[start + width * bpp..start + stride]
                    .iter()
                    .all(|&b| b == 0xee)
            );
        }
        assert!(restored[layout.buffer_len()..].iter().all(|&b| b == 0xee));
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
    for margin in [usize::MAX, usize::MAX / 2, isize::MAX as usize / 8] {
        assert_eq!(
            ShufflePlan::with_margin(small_layout(), 2, 1, margin, &[0, 1, 2, 3]).unwrap_err(),
            Error::SizeOverflow
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
    for (transform, input, output) in [
        (
            ShufflePlan::scramble as fn(&ShufflePlan, &[u8], &mut [u8]) -> Result<(), Error>,
            "original",
            "scrambled",
        ),
        (ShufflePlan::restore, "scrambled", "original"),
    ] {
        let mut destination = [0xcc; 8];
        assert_eq!(
            transform(&plan, &[0; 7], &mut destination),
            Err(Error::BufferTooSmall {
                buffer: input,
                required: 8,
                actual: 7
            })
        );
        assert_eq!(destination, [0xcc; 8]);

        let mut short_destination = [0xcc; 7];
        assert_eq!(
            transform(&plan, &[0; 8], &mut short_destination),
            Err(Error::BufferTooSmall {
                buffer: output,
                required: 8,
                actual: 7
            })
        );
        assert_eq!(short_destination, [0xcc; 7]);
    }
}

#[test]
fn margin_plans_check_each_buffer_against_its_own_layout() {
    let plan = ShufflePlan::with_margin(small_layout(), 2, 1, 1, &[2, 0, 3, 1]).unwrap();
    let mut scrambled = [0xcc; 47];
    assert_eq!(
        plan.scramble(&[0; 8], &mut scrambled),
        Err(Error::BufferTooSmall {
            buffer: "scrambled",
            required: 48,
            actual: 47
        })
    );
    assert!(scrambled.iter().all(|&b| b == 0xcc));

    let mut original = [0xcc; 8];
    assert_eq!(
        plan.restore(&[0; 47], &mut original),
        Err(Error::BufferTooSmall {
            buffer: "scrambled",
            required: 48,
            actual: 47
        })
    );
    assert_eq!(original, [0xcc; 8]);
}
