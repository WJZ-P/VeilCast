use std::fmt;

/// Invalid frame layouts, permutations, or frame buffers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    EmptyFrame,
    SizeOverflow,
    InvalidStride {
        minimum: usize,
        actual: usize,
    },
    EmptyTile,
    UnalignedTileGrid,
    PermutationLength {
        expected: usize,
        actual: usize,
    },
    TileOutOfRange {
        index: usize,
        tile_count: usize,
    },
    DuplicateTile {
        index: usize,
    },
    BufferTooSmall {
        buffer: &'static str,
        required: usize,
        actual: usize,
    },
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyFrame => write!(f, "frame width and height must be nonzero"),
            Self::SizeOverflow => write!(f, "frame size exceeds the addressable range"),
            Self::InvalidStride { minimum, actual } => {
                write!(f, "stride must be at least {minimum} bytes, got {actual}")
            }
            Self::EmptyTile => write!(f, "tile width and height must be nonzero"),
            Self::UnalignedTileGrid => {
                write!(f, "frame dimensions must be divisible by tile dimensions")
            }
            Self::PermutationLength { expected, actual } => {
                write!(f, "permutation must have {expected} entries, got {actual}")
            }
            Self::TileOutOfRange { index, tile_count } => {
                write!(f, "tile index {index} is outside 0..{tile_count}")
            }
            Self::DuplicateTile { index } => write!(f, "tile index {index} occurs more than once"),
            Self::BufferTooSmall {
                buffer,
                required,
                actual,
            } => write!(f, "{buffer} buffer needs {required} bytes, got {actual}"),
        }
    }
}

impl std::error::Error for Error {}
