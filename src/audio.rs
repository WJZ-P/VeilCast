use std::fmt;

/// Invalid block geometry, or a buffer that does not hold whole frames.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AudioError {
    EmptyFrame,
    EmptyBlock,
    SizeOverflow,
    Truncated {
        frame_bytes: usize,
        actual: usize,
    },
    /// Interleaved input that is not a whole number of frames.
    PartialFrame {
        channels: usize,
        samples: usize,
    },
}

impl fmt::Display for AudioError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyFrame => write!(f, "a frame must be at least one byte wide"),
            Self::EmptyBlock => write!(f, "a block must hold at least one frame"),
            Self::SizeOverflow => write!(f, "block size exceeds the addressable range"),
            Self::Truncated {
                frame_bytes,
                actual,
            } => write!(
                f,
                "{actual} bytes is not a whole number of {frame_bytes}-byte frames"
            ),
            Self::PartialFrame { channels, samples } => write!(
                f,
                "{samples} samples is not a whole number of {channels}-channel frames"
            ),
        }
    }
}

impl std::error::Error for AudioError {}

/// Samples from the start of [`sync_chirp`] to the first content sample.
pub const SYNC_CHIRP_LEAD: usize = 36_000;

/// The 48 kHz sync marker a mirrored upload carries in its silent intro
/// second, ending 0.25 s before the content: a 0.5 s linear sweep from 1 kHz
/// to 8 kHz at −40 dBFS with 10 ms fades.
///
/// Mirrored audio hides the block grid from blind search (the energy near
/// 10 kHz makes every sample step large, and a lossy codec buries the jumps),
/// so a viewer cross-correlates this instead: it pins the content start to
/// the sample through AAC at 64 kbit/s. `viewer/veilcast.js` has the same formula.
pub fn sync_chirp() -> Vec<f32> {
    const LENGTH: usize = 24_000;
    const FADE: f64 = 480.0;
    let duration = LENGTH as f64 / 48_000.0;
    (0..LENGTH)
        .map(|n| {
            let t = n as f64 / 48_000.0;
            let fade = (n as f64 / FADE).min((LENGTH - n) as f64 / FADE).min(1.0);
            let phase = 1_000.0 * t + 7_000.0 * t * t / (2.0 * duration);
            (0.01 * fade * (2.0 * std::f64::consts::PI * phase).sin()) as f32
        })
        .collect()
}

/// Frames per block for a block length in milliseconds.
///
/// A *frame* is one sample for every channel, so this is independent of the
/// channel count and of the sample format.
pub fn block_frames(block_ms: u32, sample_rate: u32) -> usize {
    (u64::from(sample_rate) * u64::from(block_ms) / 1000) as usize
}

/// Reverses the frame order inside every whole block of interleaved PCM, in place.
///
/// Only whole frames move and no sample value is ever altered, so the
/// transform is exactly its own inverse: scrambling and restoring are the same
/// call, and the round trip is lossless whatever the sample format. Blocks are
/// counted from the start of the buffer, which makes the grid a function of
/// time alone — never of a frame rate or a codec's own framing.
///
/// A trailing partial block is left untouched. A re-encoded copy that gained or
/// lost a few samples at the end therefore still restores everywhere a whole
/// block survived, instead of smearing the error across the tail.
///
/// Returns the number of blocks reversed.
pub fn reverse_blocks(
    pcm: &mut [u8],
    frame_bytes: usize,
    block_frames: usize,
) -> Result<usize, AudioError> {
    if frame_bytes == 0 {
        return Err(AudioError::EmptyFrame);
    }
    if block_frames == 0 {
        return Err(AudioError::EmptyBlock);
    }
    if pcm.len() % frame_bytes != 0 {
        return Err(AudioError::Truncated {
            frame_bytes,
            actual: pcm.len(),
        });
    }
    let block_bytes = block_frames
        .checked_mul(frame_bytes)
        .ok_or(AudioError::SizeOverflow)?;

    let mut blocks = 0;
    for block in pcm.chunks_exact_mut(block_bytes) {
        for index in 0..block_frames / 2 {
            let mirror = block_frames - 1 - index;
            for byte in 0..frame_bytes {
                block.swap(index * frame_bytes + byte, mirror * frame_bytes + byte);
            }
        }
        blocks += 1;
    }
    Ok(blocks)
}
