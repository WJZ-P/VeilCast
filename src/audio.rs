use std::fmt;

/// Invalid block geometry, or a buffer that does not hold whole frames.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AudioError {
    EmptyFrame,
    EmptyBlock,
    SizeOverflow,
    Truncated { frame_bytes: usize, actual: usize },
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
        }
    }
}

impl std::error::Error for AudioError {}

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
