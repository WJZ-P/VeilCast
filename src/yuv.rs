use crate::{Error, FrameLayout, PixelFormat, ShufflePlan};

/// Planar 4:2:0 frame geometry: a full-resolution luma plane and two
/// half-resolution chroma planes, in I420 order (Y, U, V).
///
/// Width and height must be even. Strides are in bytes; a contiguous buffer
/// holds the planes back to back, each `stride × plane height` bytes long.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Yuv420Layout {
    luma: FrameLayout,
    chroma: FrameLayout,
    buffer_len: usize,
}

impl Yuv420Layout {
    pub fn new(
        width: usize,
        height: usize,
        luma_stride: usize,
        chroma_stride: usize,
    ) -> Result<Self, Error> {
        check_even("width", width)?;
        check_even("height", height)?;
        let luma = FrameLayout::new(width, height, PixelFormat::Gray8, luma_stride)?;
        let chroma = FrameLayout::new(width / 2, height / 2, PixelFormat::Gray8, chroma_stride)?;
        // Each plane is already bounded by isize::MAX, so doubling chroma cannot overflow.
        let buffer_len = luma
            .buffer_len()
            .checked_add(chroma.buffer_len() * 2)
            .filter(|&len| len <= isize::MAX as usize)
            .ok_or(Error::SizeOverflow)?;
        Ok(Self {
            luma,
            chroma,
            buffer_len,
        })
    }

    /// Tightly packed planes, as produced by ffmpeg's `-f rawvideo -pix_fmt yuv420p`.
    pub fn packed(width: usize, height: usize) -> Result<Self, Error> {
        Self::new(width, height, width, width / 2)
    }

    pub const fn width(self) -> usize {
        self.luma.width()
    }

    pub const fn height(self) -> usize {
        self.luma.height()
    }

    pub const fn luma(self) -> FrameLayout {
        self.luma
    }

    /// Layout shared by the U and V planes.
    pub const fn chroma(self) -> FrameLayout {
        self.chroma
    }

    /// Minimum length of a contiguous buffer holding all three planes.
    pub const fn buffer_len(self) -> usize {
        self.buffer_len
    }

    /// Splits a contiguous I420 buffer into its Y, U and V planes.
    pub fn split(self, buffer: &[u8]) -> Result<[&[u8]; 3], Error> {
        check_len("yuv420p", buffer.len(), self.buffer_len)?;
        let (y, rest) = buffer.split_at(self.luma.buffer_len());
        let (u, rest) = rest.split_at(self.chroma.buffer_len());
        Ok([y, u, &rest[..self.chroma.buffer_len()]])
    }

    /// Mutable counterpart of [`Self::split`].
    pub fn split_mut(self, buffer: &mut [u8]) -> Result<[&mut [u8]; 3], Error> {
        check_len("yuv420p", buffer.len(), self.buffer_len)?;
        let (y, rest) = buffer.split_at_mut(self.luma.buffer_len());
        let (u, rest) = rest.split_at_mut(self.chroma.buffer_len());
        Ok([y, u, &mut rest[..self.chroma.buffer_len()]])
    }
}

/// [`ShufflePlan`] applied to every plane of a 4:2:0 frame.
///
/// The chroma planes reuse the luma permutation with tile size and margin
/// halved, so each chroma sample travels with its luma. Tile dimensions and
/// margin must therefore be even. Scrambling in the codec's native format
/// avoids a lossy RGB round trip and halves the bytes per frame.
#[derive(Debug, Clone)]
pub struct Yuv420Plan {
    luma: ShufflePlan,
    chroma: ShufflePlan,
    original: Yuv420Layout,
    scrambled: Yuv420Layout,
}

impl Yuv420Plan {
    pub fn new(
        layout: Yuv420Layout,
        tile_width: usize,
        tile_height: usize,
        margin: usize,
        permutation: &[usize],
    ) -> Result<Self, Error> {
        check_even("tile width", tile_width)?;
        check_even("tile height", tile_height)?;
        check_even("margin", margin)?;
        let luma =
            ShufflePlan::with_margin(layout.luma, tile_width, tile_height, margin, permutation)?;
        let chroma = ShufflePlan::with_margin(
            layout.chroma,
            tile_width / 2,
            tile_height / 2,
            margin / 2,
            permutation,
        )?;
        let scrambled_luma = luma.scrambled_layout();
        let scrambled = Yuv420Layout::new(
            scrambled_luma.width(),
            scrambled_luma.height(),
            scrambled_luma.stride(),
            chroma.scrambled_layout().stride(),
        )?;
        Ok(Self {
            luma,
            chroma,
            original: layout,
            scrambled,
        })
    }

    pub const fn original_layout(&self) -> Yuv420Layout {
        self.original
    }

    pub const fn scrambled_layout(&self) -> Yuv420Layout {
        self.scrambled
    }

    /// Scrambles the Y, U and V planes. All six buffers are validated before
    /// any plane is written; see [`ShufflePlan::scramble`] for the per-plane contract.
    pub fn scramble(&self, original: [&[u8]; 3], scrambled: [&mut [u8]; 3]) -> Result<(), Error> {
        check_planes(&original, ORIGINAL_PLANES, self.original)?;
        check_planes(&scrambled, SCRAMBLED_PLANES, self.scrambled)?;
        let [y, u, v] = original;
        let [sy, su, sv] = scrambled;
        self.luma.scramble(y, sy)?;
        self.chroma.scramble(u, su)?;
        self.chroma.scramble(v, sv)
    }

    /// Restores the Y, U and V planes; the inverse of [`Self::scramble`].
    pub fn restore(&self, scrambled: [&[u8]; 3], original: [&mut [u8]; 3]) -> Result<(), Error> {
        check_planes(&scrambled, SCRAMBLED_PLANES, self.scrambled)?;
        check_planes(&original, ORIGINAL_PLANES, self.original)?;
        let [sy, su, sv] = scrambled;
        let [y, u, v] = original;
        self.luma.restore(sy, y)?;
        self.chroma.restore(su, u)?;
        self.chroma.restore(sv, v)
    }
}

const ORIGINAL_PLANES: [&str; 3] = ["original Y", "original U", "original V"];
const SCRAMBLED_PLANES: [&str; 3] = ["scrambled Y", "scrambled U", "scrambled V"];

fn check_planes<T: AsRef<[u8]>>(
    planes: &[T; 3],
    names: [&'static str; 3],
    layout: Yuv420Layout,
) -> Result<(), Error> {
    let required = [
        layout.luma.buffer_len(),
        layout.chroma.buffer_len(),
        layout.chroma.buffer_len(),
    ];
    for ((plane, name), required) in planes.iter().zip(names).zip(required) {
        check_len(name, plane.as_ref().len(), required)?;
    }
    Ok(())
}

fn check_len(buffer: &'static str, actual: usize, required: usize) -> Result<(), Error> {
    if actual < required {
        return Err(Error::BufferTooSmall {
            buffer,
            required,
            actual,
        });
    }
    Ok(())
}

fn check_even(name: &'static str, actual: usize) -> Result<(), Error> {
    if actual % 2 != 0 {
        return Err(Error::NotEven { name, actual });
    }
    Ok(())
}
