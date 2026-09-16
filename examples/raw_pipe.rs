//! Raw-frame filter for the ffmpeg pipeline experiments in `scripts/experiment/`.
//!
//! Reads packed frames from stdin, applies one plan to every frame, and writes
//! the result to stdout. The permutation is derived from the seed so the
//! restore side can rebuild it without any side channel. With a margin the
//! scrambled frames are larger than the originals; the caller must size the
//! downstream ffmpeg accordingly.
//!
//! Usage: raw_pipe <scramble|restore|identity> <width> <height> <tile> <margin> <seed> <rgb24|yuv420p>

use std::io::{self, BufReader, BufWriter, Read, Write};
use std::process::ExitCode;

use veilcast_core::{
    Error, FrameLayout, PixelFormat, ShufflePlan, Yuv420Layout, Yuv420Plan, seeded_permutation,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mode {
    Scramble,
    Restore,
    Identity,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Format {
    Rgb24,
    Yuv420p,
}

struct Args {
    mode: Mode,
    width: usize,
    height: usize,
    tile: usize,
    margin: usize,
    seed: u64,
    format: Format,
}

const USAGE: &str = "usage: raw_pipe <scramble|restore|identity> <width> <height> <tile> <margin> <seed> <rgb24|yuv420p>";

fn parse_args() -> Result<Args, String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [mode, width, height, tile, margin, seed, format] = args.as_slice() else {
        return Err(USAGE.into());
    };
    let mode = match mode.as_str() {
        "scramble" => Mode::Scramble,
        "restore" => Mode::Restore,
        "identity" => Mode::Identity,
        other => return Err(format!("unknown mode {other:?}")),
    };
    let format = match format.as_str() {
        "rgb24" => Format::Rgb24,
        "yuv420p" => Format::Yuv420p,
        other => return Err(format!("unknown pixel format {other:?}")),
    };
    let number = |name: &str, value: &str| {
        value
            .parse::<usize>()
            .map_err(|e| format!("invalid {name} {value:?}: {e}"))
    };
    Ok(Args {
        mode,
        width: number("width", width)?,
        height: number("height", height)?,
        tile: number("tile", tile)?,
        margin: number("margin", margin)?,
        seed: seed
            .parse::<u64>()
            .map_err(|e| format!("invalid seed {seed:?}: {e}"))?,
        format,
    })
}

enum Plan {
    Packed(ShufflePlan),
    Planar(Box<Yuv420Plan>),
}

impl Plan {
    fn new(args: &Args, permutation: &[usize]) -> Result<Self, Error> {
        match args.format {
            Format::Rgb24 => {
                let layout =
                    FrameLayout::new(args.width, args.height, PixelFormat::Rgb24, args.width * 3)?;
                ShufflePlan::with_margin(layout, args.tile, args.tile, args.margin, permutation)
                    .map(Self::Packed)
            }
            Format::Yuv420p => {
                let layout = Yuv420Layout::packed(args.width, args.height)?;
                Yuv420Plan::new(layout, args.tile, args.tile, args.margin, permutation)
                    .map(|plan| Self::Planar(Box::new(plan)))
            }
        }
    }

    /// (original, scrambled) frame sizes in bytes.
    fn frame_lens(&self) -> (usize, usize) {
        match self {
            Self::Packed(plan) => (
                plan.original_layout().buffer_len(),
                plan.scrambled_layout().buffer_len(),
            ),
            Self::Planar(plan) => (
                plan.original_layout().buffer_len(),
                plan.scrambled_layout().buffer_len(),
            ),
        }
    }

    fn scrambled_size(&self) -> (usize, usize) {
        match self {
            Self::Packed(plan) => {
                let layout = plan.scrambled_layout();
                (layout.width(), layout.height())
            }
            Self::Planar(plan) => {
                let layout = plan.scrambled_layout();
                (layout.width(), layout.height())
            }
        }
    }

    fn apply(&self, mode: Mode, input: &[u8], output: &mut [u8]) -> Result<(), Error> {
        match (self, mode) {
            (Self::Packed(plan), Mode::Scramble | Mode::Identity) => plan.scramble(input, output),
            (Self::Packed(plan), Mode::Restore) => plan.restore(input, output),
            (Self::Planar(plan), Mode::Scramble | Mode::Identity) => plan.scramble(
                plan.original_layout().split(input)?,
                plan.scrambled_layout().split_mut(output)?,
            ),
            (Self::Planar(plan), Mode::Restore) => plan.restore(
                plan.scrambled_layout().split(input)?,
                plan.original_layout().split_mut(output)?,
            ),
        }
    }
}

/// Fills `frame` completely, or returns `Ok(false)` on a clean end of stream.
fn read_frame(reader: &mut impl Read, frame: &mut [u8]) -> io::Result<bool> {
    let mut filled = 0;
    while filled < frame.len() {
        let n = reader.read(&mut frame[filled..])?;
        if n == 0 {
            if filled == 0 {
                return Ok(false);
            }
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                format!("truncated frame: {filled} of {} bytes", frame.len()),
            ));
        }
        filled += n;
    }
    Ok(true)
}

fn run(args: Args) -> Result<(), Box<dyn std::error::Error>> {
    let tile_count = (args.width / args.tile) * (args.height / args.tile);
    let permutation = match args.mode {
        Mode::Identity => (0..tile_count).collect(),
        Mode::Scramble | Mode::Restore => seeded_permutation(tile_count, args.seed),
    };
    let plan = Plan::new(&args, &permutation)?;
    let (original_len, scrambled_len) = plan.frame_lens();
    let (input_len, output_len) = match args.mode {
        Mode::Scramble | Mode::Identity => (original_len, scrambled_len),
        Mode::Restore => (scrambled_len, original_len),
    };

    let mut input = vec![0u8; input_len];
    let mut output = vec![0u8; output_len];
    let mut reader = BufReader::with_capacity(1 << 20, io::stdin().lock());
    let mut writer = BufWriter::with_capacity(1 << 20, io::stdout().lock());

    let mut frames = 0usize;
    while read_frame(&mut reader, &mut input)? {
        plan.apply(args.mode, &input, &mut output)?;
        writer.write_all(&output)?;
        frames += 1;
    }
    writer.flush()?;
    let (scrambled_width, scrambled_height) = plan.scrambled_size();
    eprintln!(
        "raw_pipe: {:?} {:?} {frames} frames, {tile_count} tiles of {}x{} margin {}, scrambled {scrambled_width}x{scrambled_height}",
        args.mode, args.format, args.tile, args.tile, args.margin
    );
    Ok(())
}

fn main() -> ExitCode {
    let args = match parse_args() {
        Ok(args) => args,
        Err(message) => {
            eprintln!("{message}");
            return ExitCode::from(2);
        }
    };
    match run(args) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("raw_pipe: {error}");
            ExitCode::FAILURE
        }
    }
}
