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
//! [`reverse_blocks`] is the audio counterpart: it reverses time inside fixed
//! blocks of interleaved PCM, which is its own inverse and leaves every sample
//! value untouched.
//!
//! This is reversible scrambling, not cryptographic encryption. Key derivation
//! and codecs are outside this crate's scope.

mod audio;
mod error;
mod frame;
mod header;
mod invert;
mod permutation;
mod shuffle;
mod yuv;

pub use audio::{AudioError, block_frames, reverse_blocks};
pub use error::Error;
pub use frame::{FrameLayout, PixelFormat};
pub use header::{HEADER_VERSION, HeaderError, IntroHeader};
pub use invert::invert_yuv420_limited;
pub use permutation::{seed_from_text, seeded_permutation};
pub use shuffle::ShufflePlan;
pub use yuv::{Yuv420Layout, Yuv420Plan};
