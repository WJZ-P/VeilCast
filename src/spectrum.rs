use std::f64::consts::PI;

use crate::audio::AudioError;

/// The only sample rate the mirror geometry is defined for.
pub const MIRROR_SAMPLE_RATE: u32 = 48_000;

// A 16384-point STFT (2.93 Hz bins at 48 kHz) with sqrt-Hann windows at half
// overlap. Bins LOW..=HIGH (164 Hz–10 kHz) swap with CENTER - k. Long frames
// keep the band edges sharp; with 2048 points the edges leak enough to cost
// ~15 dB of round-trip SNR. `viewer/veilcast.js` uses the same constants.
const SIZE: usize = 16_384;
const HOP: usize = SIZE / 2;
const LOW: usize = 56;
const HIGH: usize = 3_416;
const CENTER: usize = LOW + HIGH;

/// Mirrors the 164 Hz–10 kHz band of 48 kHz audio onto itself,
/// f → 10171.875 Hz − f, streaming over interleaved samples.
///
/// Pitch and formants land somewhere else entirely, so a voice's identity
/// does not survive, which time-domain scrambling such as
/// [`crate::reverse_blocks`] cannot achieve: reversal keeps the magnitude
/// spectrum. Bass below and treble above the band pass through untouched.
///
/// Per frame this is exactly a 2·cos carrier followed by the band limit, and
/// applying it twice is the identity. The carrier phase is zero at the first
/// sample fed in, so both ends must start at the same content sample; the
/// frame grid itself need not match (a restore on a shifted grid still
/// reaches ~30 dB SNR). Output lags input by half a frame; [`Self::finish`]
/// flushes it, and the total output length always equals the input length.
pub struct SpectrumMirror {
    channels: usize,
    /// Per channel, samples from stream position `start` on.
    pending: Vec<Vec<f64>>,
    /// Per channel, the previous frame's second half, awaiting its overlap.
    tails: Vec<Vec<f64>>,
    /// Per channel, the finished half frame being emitted.
    finished: Vec<Vec<f64>>,
    start: i64,
    received: i64,
    fft: Fft,
    re: Vec<f64>,
    im: Vec<f64>,
    scratch: Vec<f64>,
}

impl SpectrumMirror {
    pub fn new(channels: usize) -> Result<Self, AudioError> {
        if channels == 0 {
            return Err(AudioError::EmptyFrame);
        }
        Ok(Self {
            channels,
            // Frames start one hop before the data so every sample sees two windows.
            pending: vec![vec![0.0; HOP]; channels],
            tails: vec![vec![0.0; HOP]; channels],
            finished: vec![vec![0.0; HOP]; channels],
            start: -(HOP as i64),
            received: 0,
            fft: Fft::new(),
            re: vec![0.0; SIZE],
            im: vec![0.0; SIZE],
            scratch: vec![0.0; 4 * (HIGH + 1)],
        })
    }

    /// Feeds interleaved samples and appends every sample that is final to `output`.
    pub fn process(&mut self, input: &[f32], output: &mut Vec<f32>) -> Result<(), AudioError> {
        if input.len() % self.channels != 0 {
            return Err(AudioError::PartialFrame {
                channels: self.channels,
                samples: input.len(),
            });
        }
        for frame in input.chunks_exact(self.channels) {
            for (pending, &sample) in self.pending.iter_mut().zip(frame) {
                pending.push(f64::from(sample));
            }
        }
        self.received += (input.len() / self.channels) as i64;
        while self.pending[0].len() >= SIZE {
            self.step(output, i64::MAX);
        }
        Ok(())
    }

    /// Flushes the samples still held back.
    pub fn finish(mut self, output: &mut Vec<f32>) {
        let end = self.received;
        while self.start < end {
            for pending in &mut self.pending {
                pending.resize(SIZE, 0.0);
            }
            self.step(output, end);
        }
    }

    /// Transforms the frame at `start`, emits [start, start + HOP) below `end`, advances a hop.
    fn step(&mut self, output: &mut Vec<f32>, end: i64) {
        let offset = self.start.rem_euclid(SIZE as i64) as usize;
        let phase = 2.0 * PI * ((CENTER * offset) % SIZE) as f64 / SIZE as f64;
        let window = &self.fft.window;
        let scale = 1.0 / SIZE as f64;
        for first in (0..self.channels).step_by(2) {
            let second = (first + 1 < self.channels).then_some(first + 1);
            for (m, &w) in window.iter().enumerate() {
                self.re[m] = self.pending[first][m] * w;
                self.im[m] = second.map_or(0.0, |c| self.pending[c][m] * w);
            }
            self.fft.forward(&mut self.re, &mut self.im);
            mirror_frame(&mut self.re, &mut self.im, phase, &mut self.scratch);
            // Inverse transform as the conjugate of a forward one.
            for value in &mut self.im {
                *value = -*value;
            }
            self.fft.forward(&mut self.re, &mut self.im);
            for m in 0..HOP {
                let (head, tail) = (window[m] * scale, window[m + HOP] * scale);
                self.finished[first][m] = self.tails[first][m] + self.re[m] * head;
                self.tails[first][m] = self.re[m + HOP] * tail;
                if let Some(c) = second {
                    self.finished[c][m] = self.tails[c][m] - self.im[m] * head;
                    self.tails[c][m] = -self.im[m + HOP] * tail;
                }
            }
        }
        for m in 0..HOP {
            let position = self.start + m as i64;
            if position >= 0 && position < end {
                output.extend(self.finished.iter().map(|channel| channel[m] as f32));
            }
        }
        for pending in &mut self.pending {
            pending.drain(..HOP);
        }
        self.start += HOP as i64;
    }
}

/// Mirrors one packed frame spectrum (two real channels as re + i·im) in
/// place: bin k takes e^{iφ}·Z[N−(C−k)] and bin N−k takes e^{−iφ}·Z[C−k].
fn mirror_frame(re: &mut [f64], im: &mut [f64], phase: f64, scratch: &mut [f64]) {
    let (s, c) = phase.sin_cos();
    for k in LOW..=HIGH {
        scratch[4 * k] = re[k];
        scratch[4 * k + 1] = im[k];
        scratch[4 * k + 2] = re[SIZE - k];
        scratch[4 * k + 3] = im[SIZE - k];
    }
    for k in LOW..=HIGH {
        let j = CENTER - k;
        let (pr, pi) = (scratch[4 * j], scratch[4 * j + 1]);
        let (nr, ni) = (scratch[4 * j + 2], scratch[4 * j + 3]);
        re[k] = c * nr - s * ni;
        im[k] = s * nr + c * ni;
        re[SIZE - k] = c * pr + s * pi;
        im[SIZE - k] = c * pi - s * pr;
    }
}

/// In-place radix-2 forward FFT of length SIZE, and the analysis window.
struct Fft {
    reversed: Vec<usize>,
    cos: Vec<f64>,
    sin: Vec<f64>,
    window: Vec<f64>,
}

impl Fft {
    fn new() -> Self {
        let bits = SIZE.trailing_zeros();
        let reversed = (0..SIZE)
            .map(|i| i.reverse_bits() >> (usize::BITS - bits))
            .collect();
        let angle = |i: usize| 2.0 * PI * i as f64 / SIZE as f64;
        Self {
            reversed,
            cos: (0..SIZE / 2).map(|i| angle(i).cos()).collect(),
            sin: (0..SIZE / 2).map(|i| -angle(i).sin()).collect(),
            window: (0..SIZE)
                .map(|m| (PI * m as f64 / SIZE as f64).sin())
                .collect(),
        }
    }

    fn forward(&self, re: &mut [f64], im: &mut [f64]) {
        for i in 0..SIZE {
            let j = self.reversed[i];
            if i < j {
                re.swap(i, j);
                im.swap(i, j);
            }
        }
        let mut len = 2;
        while len <= SIZE {
            let half = len / 2;
            let step = SIZE / len;
            for base in (0..SIZE).step_by(len) {
                for k in 0..half {
                    let (wr, wi) = (self.cos[k * step], self.sin[k * step]);
                    let (a, b) = (base + k, base + k + half);
                    let tr = re[b] * wr - im[b] * wi;
                    let ti = re[b] * wi + im[b] * wr;
                    re[b] = re[a] - tr;
                    im[b] = im[a] - ti;
                    re[a] += tr;
                    im[a] += ti;
                }
            }
            len *= 2;
        }
    }
}
