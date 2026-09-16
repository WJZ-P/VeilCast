use veilcast_core::{FrameLayout, PixelFormat, ShufflePlan};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let layout = FrameLayout::new(8, 4, PixelFormat::Rgb24, 8 * 3)?;
    let plan = ShufflePlan::new(layout, 4, 2, &[2, 0, 3, 1])?;
    let mut scrambled = vec![0; layout.buffer_len()];
    let mut restored = vec![0; layout.buffer_len()];

    for frame_index in 0..2 {
        // Synthetic decoded RGB frames; no codec or input file is required.
        let original: Vec<u8> = (0..layout.buffer_len())
            .map(|i| ((i + frame_index * 17) % 256) as u8)
            .collect();
        plan.scramble(&original, &mut scrambled)?;
        plan.restore(&scrambled, &mut restored)?;
        assert_eq!(restored, original);
    }

    println!("Verified: 2 RGB frames restored byte-for-byte with one reusable plan.");
    Ok(())
}
