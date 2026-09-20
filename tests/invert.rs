use veilcast_core::{Yuv420Layout, Yuv420Plan, invert_yuv420_limited, seeded_permutation};

#[test]
fn black_white_and_neutral_chroma_have_the_expected_complement() {
    let layout = Yuv420Layout::packed(2, 2).unwrap();
    let mut frame = [16, 235, 100, 151, 128, 128];
    invert_yuv420_limited(layout, &mut frame).unwrap();
    assert_eq!(frame, [235, 16, 151, 100, 128, 128]);
}

#[test]
fn two_applications_restore_all_nominal_values() {
    let layout = Yuv420Layout::packed(256, 4).unwrap();
    let mut frame = vec![0; layout.buffer_len()];
    let [y, u, v] = layout.split_mut(&mut frame).unwrap();
    for (i, sample) in y.iter_mut().enumerate() {
        *sample = 16 + (i % 220) as u8;
    }
    for (i, (u, v)) in u.iter_mut().zip(v).enumerate() {
        *u = 16 + (i % 225) as u8;
        *v = 240 - (i % 225) as u8;
    }
    let original = frame.clone();
    invert_yuv420_limited(layout, &mut frame).unwrap();
    invert_yuv420_limited(layout, &mut frame).unwrap();
    assert_eq!(frame, original);
}

#[test]
fn padding_and_trailing_bytes_are_untouched() {
    let layout = Yuv420Layout::new(2, 2, 3, 2).unwrap();
    let mut frame = [16, 235, 7, 16, 235, 8, 16, 9, 240, 10, 11];
    invert_yuv420_limited(layout, &mut frame).unwrap();
    assert_eq!(frame, [235, 16, 7, 235, 16, 8, 240, 9, 16, 10, 11]);
}

#[test]
fn out_of_range_values_clip_instead_of_wrapping() {
    let layout = Yuv420Layout::packed(2, 2).unwrap();
    let mut frame = [0, 255, 15, 236, 0, 255];
    invert_yuv420_limited(layout, &mut frame).unwrap();
    assert_eq!(frame, [235, 16, 235, 16, 240, 16]);
    let mut short = [128; 5];
    assert!(invert_yuv420_limited(layout, &mut short).is_err());
    assert_eq!(short, [128; 5]);
}

#[test]
fn inversion_round_trips_with_margin_and_permutation() {
    let layout = Yuv420Layout::packed(8, 4).unwrap();
    let plan = Yuv420Plan::new(layout, 2, 2, 2, &seeded_permutation(8, 42)).unwrap();
    let original: Vec<u8> = (0..layout.buffer_len())
        .map(|i| 16 + (i % 200) as u8)
        .collect();
    let mut scrambled = vec![0; plan.scrambled_layout().buffer_len()];
    let mut restored = vec![0; layout.buffer_len()];
    plan.scramble(
        layout.split(&original).unwrap(),
        plan.scrambled_layout().split_mut(&mut scrambled).unwrap(),
    )
    .unwrap();
    invert_yuv420_limited(plan.scrambled_layout(), &mut scrambled).unwrap();
    plan.restore(
        plan.scrambled_layout().split(&scrambled).unwrap(),
        layout.split_mut(&mut restored).unwrap(),
    )
    .unwrap();
    invert_yuv420_limited(layout, &mut restored).unwrap();
    assert_eq!(restored, original);
}
