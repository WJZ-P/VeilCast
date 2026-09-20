use crate::{Error, FrameLayout, Yuv420Layout};

/// Inverts nominal-range, 8-bit SDR I420 pixels in place, without allocating.
///
/// `Y' = 251 - Y`, `U' = 256 - U`, `V' = 256 - V`: this preserves neutral
/// chroma (128) and corresponds to complementing decoded RGB components.
/// Callers must normalize full-range sources to limited range first.
/// Values outside Y=16..235 / UV=16..240 are clamped before inversion; two
/// applications are lossless only for samples inside those nominal ranges.
/// Row padding and extra trailing bytes are unchanged. Short buffers fail
/// validation before any sample is modified.
pub fn invert_yuv420_limited(layout: Yuv420Layout, buffer: &mut [u8]) -> Result<(), Error> {
    let [y, u, v] = layout.split_mut(buffer)?;
    invert_plane(y, layout.luma(), 16, 235);
    invert_plane(u, layout.chroma(), 16, 240);
    invert_plane(v, layout.chroma(), 16, 240);
    Ok(())
}

fn invert_plane(bytes: &mut [u8], layout: FrameLayout, minimum: u8, maximum: u8) {
    let sum = u16::from(minimum) + u16::from(maximum);
    for row in bytes.chunks_exact_mut(layout.stride()) {
        for value in &mut row[..layout.width()] {
            *value = (sum - u16::from((*value).clamp(minimum, maximum))) as u8;
        }
    }
}
