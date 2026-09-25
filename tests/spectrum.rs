use std::f64::consts::PI;

use veilcast_core::{AudioError, MIRROR_SAMPLE_RATE, SpectrumMirror};

const RATE: f64 = MIRROR_SAMPLE_RATE as f64;
/// The mirror's carrier: 3472 bins of a 16384-point frame at 48 kHz.
const CARRIER_HZ: f64 = 10_171.875;

fn mirror(input: &[f32], channels: usize, chunk: usize) -> Vec<f32> {
    let mut mirror = SpectrumMirror::new(channels).unwrap();
    let mut output = Vec::new();
    for piece in input.chunks(chunk * channels) {
        mirror.process(piece, &mut output).unwrap();
    }
    mirror.finish(&mut output);
    output
}

fn tone(hz: f64, frames: usize) -> Vec<f32> {
    (0..frames)
        .map(|n| (0.5 * (2.0 * PI * hz * n as f64 / RATE).cos()) as f32)
        .collect()
}

/// Deterministic broadband test signal.
fn noise(samples: usize, seed: u64) -> Vec<f32> {
    let mut state = seed;
    (0..samples)
        .map(|_| {
            state = state
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            ((state >> 40) as f32 / (1u64 << 24) as f32 - 0.5) * 0.5
        })
        .collect()
}

fn snr_db(reference: &[f32], actual: &[f32]) -> f64 {
    let (mut signal, mut error) = (0.0, 0.0);
    for (&r, &a) in reference.iter().zip(actual) {
        signal += f64::from(r) * f64::from(r);
        error += (f64::from(r) - f64::from(a)).powi(2);
    }
    10.0 * (signal / error).log10()
}

#[test]
fn a_tone_moves_to_the_carrier_minus_its_frequency_with_zero_phase_at_the_first_sample() {
    // viewer/veilcast.test.mjs checks the same expectation for the JS port.
    let frames = 96_000;
    let output = mirror(&tone(1_000.0, frames), 1, 4_096);
    assert_eq!(output.len(), frames);
    let expected = tone(CARRIER_HZ - 1_000.0, frames);
    let worst = (20_000..76_000)
        .map(|n| (output[n] - expected[n]).abs())
        .fold(0.0f32, f32::max);
    assert!(worst < 1e-3, "worst deviation {worst}");
}

#[test]
fn bass_and_treble_outside_the_band_pass_through() {
    let frames = 96_000;
    for hz in [60.0, 14_000.0] {
        let input = tone(hz, frames);
        let output = mirror(&input, 1, 10_000);
        let snr = snr_db(&input[20_000..76_000], &output[20_000..76_000]);
        assert!(snr > 60.0, "{hz} Hz: {snr:.1} dB");
    }
}

#[test]
fn mirroring_twice_restores_the_signal() {
    let input = noise(240_000, 7);
    let once = mirror(&input, 2, 4_800);
    assert!(
        snr_db(&input, &once) < 1.0,
        "the mirrored signal must be unlike the input"
    );
    let snr = snr_db(&input, &mirror(&once, 2, 4_800));
    assert!(snr > 30.0, "round trip {snr:.1} dB");
}

#[test]
fn channels_are_independent_and_chunking_does_not_change_the_result() {
    let frames = 50_000;
    let left = noise(frames, 1);
    let right = tone(2_500.0, frames);
    let third = noise(frames, 3);
    let interleaved: Vec<f32> = (0..frames)
        .flat_map(|n| [left[n], right[n], third[n]])
        .collect();
    let together = mirror(&interleaved, 3, 1_000);
    assert_eq!(together.len(), interleaved.len());
    assert_eq!(together, mirror(&interleaved, 3, 17_777));
    for (channel, source) in [&left, &right, &third].into_iter().enumerate() {
        let alone = mirror(source, 1, 5_000);
        let extracted: Vec<f32> = together.iter().skip(channel).step_by(3).copied().collect();
        let worst = alone
            .iter()
            .zip(&extracted)
            .map(|(a, b)| (a - b).abs())
            .fold(0.0f32, f32::max);
        assert!(worst < 1e-5, "channel {channel} differs by {worst}");
    }
}

#[test]
fn short_and_empty_streams_keep_their_length() {
    for frames in [0, 1, 100, 8_191, 8_192, 8_193, 16_385] {
        assert_eq!(mirror(&noise(frames * 2, 5), 2, 333).len(), frames * 2);
    }
}

#[test]
fn rejects_zero_channels_and_partial_frames() {
    assert!(matches!(
        SpectrumMirror::new(0),
        Err(AudioError::EmptyFrame)
    ));
    let mut mirror = SpectrumMirror::new(2).unwrap();
    assert_eq!(
        mirror.process(&[0.0; 3], &mut Vec::new()).unwrap_err(),
        AudioError::PartialFrame {
            channels: 2,
            samples: 3
        }
    );
}
