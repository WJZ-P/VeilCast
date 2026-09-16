//! Spatial tile permutation for decoded, packed video frames.
//!
//! A [`ShufflePlan`] validates the layout and permutation once, then reuses
//! precomputed byte offsets across frames without allocating in the frame loop.
//! The caller owns both frame buffers; in-place processing is not supported.
//!
//! This is reversible scrambling, not cryptographic encryption. Key derivation,
//! permutation generation, codecs, and audio are outside this crate's current scope.

mod error;
mod frame;
mod shuffle;

pub use error::Error;
pub use frame::{FrameLayout, PixelFormat};
pub use shuffle::ShufflePlan;
