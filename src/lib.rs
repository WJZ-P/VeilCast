//! Spatial tile permutation for decoded video frames.
//!
//! A [`ShufflePlan`] validates the layout and permutation once, then reuses
//! precomputed byte offsets across frames without allocating in the frame loop.
//! Blocks may carry a margin of neighbouring pixels so that compression
//! artefacts at block edges are discarded on restore. [`Yuv420Plan`] applies
//! the same plan to planar 4:2:0 frames, and [`seeded_permutation`] derives a
//! permutation from a seed so both ends can rebuild it independently.
//! The caller owns all frame buffers; in-place processing is not supported.
//!
//! This is reversible scrambling, not cryptographic encryption. Key derivation,
//! codecs, and audio are outside this crate's scope.

mod error;
mod frame;
mod permutation;
mod shuffle;
mod yuv;

pub use error::Error;
pub use frame::{FrameLayout, PixelFormat};
pub use permutation::seeded_permutation;
pub use shuffle::ShufflePlan;
pub use yuv::{Yuv420Layout, Yuv420Plan};
