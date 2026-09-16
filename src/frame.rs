use crate::Error;

/// Interleaved, eight-bit pixel formats. Planar formats such as YUV are excluded.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PixelFormat {
    Gray8,
    Rgb24,
    Rgba32,
}

impl PixelFormat {
    pub const fn bytes_per_pixel(self) -> usize {
        match self {
            Self::Gray8 => 1,
            Self::Rgb24 => 3,
            Self::Rgba32 => 4,
        }
    }
}

/// Validated top-down frame geometry shared by source and destination buffers.
///
/// Stride is measured in bytes and includes any padding at the end of each row.
/// Buffers must contain `stride * height` bytes, including final-row padding.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FrameLayout {
    width: usize,
    height: usize,
    format: PixelFormat,
    stride: usize,
    buffer_len: usize,
}

impl FrameLayout {
    pub fn new(
        width: usize,
        height: usize,
        format: PixelFormat,
        stride: usize,
    ) -> Result<Self, Error> {
        if width == 0 || height == 0 {
            return Err(Error::EmptyFrame);
        }
        let row_bytes = width
            .checked_mul(format.bytes_per_pixel())
            .ok_or(Error::SizeOverflow)?;
        if stride < row_bytes {
            return Err(Error::InvalidStride {
                minimum: row_bytes,
                actual: stride,
            });
        }
        let buffer_len = stride.checked_mul(height).ok_or(Error::SizeOverflow)?;
        // Rust slices cannot span more than isize::MAX bytes.
        if buffer_len > isize::MAX as usize {
            return Err(Error::SizeOverflow);
        }
        Ok(Self {
            width,
            height,
            format,
            stride,
            buffer_len,
        })
    }

    pub const fn width(self) -> usize {
        self.width
    }

    pub const fn height(self) -> usize {
        self.height
    }

    pub const fn format(self) -> PixelFormat {
        self.format
    }

    pub const fn stride(self) -> usize {
        self.stride
    }

    /// Minimum buffer length, including padding after every row.
    pub const fn buffer_len(self) -> usize {
        self.buffer_len
    }
}
