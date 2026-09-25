use veilcast_core::{AudioError, SYNC_CHIRP_LEAD, block_frames, reverse_blocks, sync_chirp};

#[test]
fn the_sync_chirp_matches_the_viewer() {
    // viewer/veilcast.test.mjs pins the same samples.
    let chirp = sync_chirp();
    assert_eq!((chirp.len(), SYNC_CHIRP_LEAD), (24_000, 36_000));
    for (index, expected) in [
        (0, 0.0),
        (240, 0.004_455_032_8),
        (1_000, -0.007_223_64),
        (23_999, -0.000_018_042),
    ] {
        assert!(
            (chirp[index] - expected).abs() < 1e-7,
            "sample {index}: {}",
            chirp[index]
        );
    }
    let peak = chirp.iter().fold(0.0f32, |peak, v| peak.max(v.abs()));
    assert!((0.0099..=0.01).contains(&peak), "peak {peak}");
}

/// Two interleaved 16-bit channels: frames are `[left, right]` little-endian.
fn stereo(frames: &[(i16, i16)]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(frames.len() * 4);
    for (left, right) in frames {
        bytes.extend_from_slice(&left.to_le_bytes());
        bytes.extend_from_slice(&right.to_le_bytes());
    }
    bytes
}

#[test]
fn whole_blocks_reverse_and_the_tail_stays_put() {
    let frames: Vec<(i16, i16)> = (0..11).map(|n| (n, -n)).collect();
    let mut pcm = stereo(&frames);
    assert_eq!(reverse_blocks(&mut pcm, 4, 4), Ok(2));

    let mut expected: Vec<(i16, i16)> = Vec::new();
    expected.extend([(3, -3), (2, -2), (1, -1), (0, 0)]);
    expected.extend([(7, -7), (6, -6), (5, -5), (4, -4)]);
    expected.extend([(8, -8), (9, -9), (10, -10)]); // partial block, untouched
    assert_eq!(pcm, stereo(&expected));
}

#[test]
fn reversing_twice_restores_every_sample() {
    let frames: Vec<(i16, i16)> = (0..1000).map(|n| (n, i16::MAX - n)).collect();
    let original = stereo(&frames);
    let mut pcm = original.clone();
    for _ in 0..2 {
        assert_eq!(reverse_blocks(&mut pcm, 4, 48), Ok(20));
    }
    assert_eq!(pcm, original, "the transform must be its own inverse");
}

#[test]
fn channels_keep_their_order_and_the_format_does_not_matter() {
    // A 24-bit three-channel frame is nine bytes wide; nothing inside it moves.
    let mut pcm: Vec<u8> = (0..18).collect();
    assert_eq!(reverse_blocks(&mut pcm, 9, 2), Ok(1));
    assert_eq!(
        pcm,
        [9, 10, 11, 12, 13, 14, 15, 16, 17, 0, 1, 2, 3, 4, 5, 6, 7, 8]
    );

    // An odd block length leaves its middle frame where it is.
    let mut mono: Vec<u8> = (0..5).collect();
    assert_eq!(reverse_blocks(&mut mono, 1, 5), Ok(1));
    assert_eq!(mono, [4, 3, 2, 1, 0]);
}

#[test]
fn a_buffer_shorter_than_one_block_is_left_alone() {
    let mut pcm = stereo(&[(1, 2), (3, 4)]);
    let untouched = pcm.clone();
    assert_eq!(reverse_blocks(&mut pcm, 4, 12_000), Ok(0));
    assert_eq!(pcm, untouched);
    assert_eq!(reverse_blocks(&mut [], 4, 4), Ok(0));
}

#[test]
fn invalid_geometry_is_rejected_before_any_sample_moves() {
    let mut pcm = stereo(&[(1, 2), (3, 4)]);
    assert_eq!(reverse_blocks(&mut pcm, 0, 4), Err(AudioError::EmptyFrame));
    assert_eq!(reverse_blocks(&mut pcm, 4, 0), Err(AudioError::EmptyBlock));
    assert_eq!(
        reverse_blocks(&mut pcm, 4, usize::MAX),
        Err(AudioError::SizeOverflow)
    );
    assert_eq!(
        reverse_blocks(&mut pcm[..7], 4, 2),
        Err(AudioError::Truncated {
            frame_bytes: 4,
            actual: 7,
        })
    );
    assert_eq!(
        pcm,
        stereo(&[(1, 2), (3, 4)]),
        "a rejected call changes nothing"
    );
}

#[test]
fn block_length_follows_the_clock_not_the_channel_count() {
    assert_eq!(block_frames(250, 48_000), 12_000);
    assert_eq!(block_frames(250, 44_100), 11_025);
    assert_eq!(block_frames(1000, 48_000), 48_000);
    assert_eq!(block_frames(0, 48_000), 0);
}
