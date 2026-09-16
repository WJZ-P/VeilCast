use veilcast_core::{Error, FrameLayout, PixelFormat, ShufflePlan, Yuv420Layout, Yuv420Plan};

fn packed_8x4() -> Yuv420Layout {
    Yuv420Layout::packed(8, 4).unwrap()
}

/// Y plane 8×4, U and V planes 4×2, each byte tagged by plane and position.
fn frame_8x4() -> Vec<u8> {
    let luma = (0..32).map(|i| i as u8);
    let u = (0..8).map(|i| 0x40 + i as u8);
    let v = (0..8).map(|i| 0x80 + i as u8);
    luma.chain(u).chain(v).collect()
}

#[test]
fn packed_layout_describes_i420_planes() {
    let layout = packed_8x4();
    assert_eq!(layout.width(), 8);
    assert_eq!(layout.height(), 4);
    assert_eq!(
        layout.luma(),
        FrameLayout::new(8, 4, PixelFormat::Gray8, 8).unwrap()
    );
    assert_eq!(
        layout.chroma(),
        FrameLayout::new(4, 2, PixelFormat::Gray8, 4).unwrap()
    );
    assert_eq!(layout.buffer_len(), 32 + 8 + 8);

    let frame = frame_8x4();
    let [y, u, v] = layout.split(&frame).unwrap();
    assert_eq!(y, &frame[..32]);
    assert_eq!(u, &frame[32..40]);
    assert_eq!(v, &frame[40..48]);

    let mut writable = vec![0; 48 + 3];
    let [y, u, v] = layout.split_mut(&mut writable).unwrap();
    assert_eq!((y.len(), u.len(), v.len()), (32, 8, 8));
    assert_eq!(
        layout.split(&frame[..47]).unwrap_err(),
        Error::BufferTooSmall {
            buffer: "yuv420p",
            required: 48,
            actual: 47
        }
    );
}

#[test]
fn rejects_odd_dimensions_tiles_and_margins() {
    assert_eq!(
        Yuv420Layout::packed(7, 4).unwrap_err(),
        Error::NotEven {
            name: "width",
            actual: 7
        }
    );
    assert_eq!(
        Yuv420Layout::packed(8, 3).unwrap_err(),
        Error::NotEven {
            name: "height",
            actual: 3
        }
    );
    let layout = packed_8x4();
    assert_eq!(
        Yuv420Plan::new(layout, 3, 2, 0, &[]).unwrap_err(),
        Error::NotEven {
            name: "tile width",
            actual: 3
        }
    );
    assert_eq!(
        Yuv420Plan::new(layout, 4, 1, 0, &[]).unwrap_err(),
        Error::NotEven {
            name: "tile height",
            actual: 1
        }
    );
    assert_eq!(
        Yuv420Plan::new(layout, 4, 2, 1, &[]).unwrap_err(),
        Error::NotEven {
            name: "margin",
            actual: 1
        }
    );
}

#[test]
fn planes_follow_the_luma_permutation_at_half_resolution() {
    let layout = packed_8x4();
    let permutation = [2, 0, 3, 1];
    let plan = Yuv420Plan::new(layout, 4, 2, 2, &permutation).unwrap();
    assert_eq!(plan.original_layout(), layout);
    // Luma blocks are 8×6 in a 2×2 grid; chroma blocks 4×3.
    assert_eq!(
        plan.scrambled_layout(),
        Yuv420Layout::packed(16, 12).unwrap()
    );

    let frame = frame_8x4();
    let mut scrambled = vec![0xcc; plan.scrambled_layout().buffer_len()];
    plan.scramble(
        layout.split(&frame).unwrap(),
        plan.scrambled_layout().split_mut(&mut scrambled).unwrap(),
    )
    .unwrap();

    // Each plane must equal the single-plane plan with tile and margin halved.
    let luma_plan = ShufflePlan::with_margin(layout.luma(), 4, 2, 2, &permutation).unwrap();
    let chroma_plan = ShufflePlan::with_margin(layout.chroma(), 2, 1, 1, &permutation).unwrap();
    let [y, u, v] = layout.split(&frame).unwrap();
    let mut expected_y = vec![0; 16 * 12];
    let mut expected_u = vec![0; 8 * 6];
    let mut expected_v = vec![0; 8 * 6];
    luma_plan.scramble(y, &mut expected_y).unwrap();
    chroma_plan.scramble(u, &mut expected_u).unwrap();
    chroma_plan.scramble(v, &mut expected_v).unwrap();
    let [sy, su, sv] = plan.scrambled_layout().split(&scrambled).unwrap();
    assert_eq!(sy, expected_y);
    assert_eq!(su, expected_u);
    assert_eq!(sv, expected_v);

    let mut restored = vec![0xee; layout.buffer_len()];
    plan.restore(
        plan.scrambled_layout().split(&scrambled).unwrap(),
        layout.split_mut(&mut restored).unwrap(),
    )
    .unwrap();
    assert_eq!(restored, frame);
}

#[test]
fn validates_every_plane_before_writing_any() {
    let layout = packed_8x4();
    let plan = Yuv420Plan::new(layout, 4, 2, 0, &[2, 0, 3, 1]).unwrap();
    let frame = frame_8x4();
    let mut y = [0xcc; 32];
    let mut u = [0xcc; 8];
    let mut v = [0xcc; 7];
    assert_eq!(
        plan.scramble(layout.split(&frame).unwrap(), [&mut y, &mut u, &mut v]),
        Err(Error::BufferTooSmall {
            buffer: "scrambled V",
            required: 8,
            actual: 7
        })
    );
    assert!(y.iter().all(|&b| b == 0xcc));
    assert!(u.iter().all(|&b| b == 0xcc));

    let mut restored = vec![0xee; layout.buffer_len()];
    assert_eq!(
        plan.restore(
            [&frame[..32], &frame[32..40], &frame[40..47]],
            layout.split_mut(&mut restored).unwrap()
        ),
        Err(Error::BufferTooSmall {
            buffer: "scrambled V",
            required: 8,
            actual: 7
        })
    );
    assert!(restored.iter().all(|&b| b == 0xee));
}
