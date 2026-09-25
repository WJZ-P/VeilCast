// Browser-side restore for VeilCast tile scrambling.
//
// Mirrors veilcast_core: `seededPermutation` is `seeded_permutation` (splitmix64
// + Fisher-Yates) and `createRestorer` is `ShufflePlan::restore` as a WebGL2
// fragment shader. Sampling is done in normalised coordinates of the uploaded
// frame, so a platform that rescales the video does not break the tile grid.

const MASK64 = (1n << 64n) - 1n;
const GOLDEN = 0x9e3779b97f4a7c15n;
const MIX1 = 0xbf58476d1ce4e5b9n;
const MIX2 = 0x94d049bb133111ebn;

/** `permutation[block] = tile`; identical to the Rust implementation for the same seed. */
export function seededPermutation(tileCount, seed) {
  let state = BigInt(seed) & MASK64;
  const next = () => {
    state = (state + GOLDEN) & MASK64;
    let z = state;
    z = ((z ^ (z >> 30n)) * MIX1) & MASK64;
    z = ((z ^ (z >> 27n)) * MIX2) & MASK64;
    return z ^ (z >> 31n);
  };
  const order = Array.from({ length: tileCount }, (_, i) => i);
  for (let i = tileCount - 1; i >= 1; i--) {
    const j = Number(next() % BigInt(i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

/**
 * `seed_from_text`: a plain decimal number within 64 bits is used verbatim,
 * anything else is hashed with 64-bit FNV-1a over its UTF-8 bytes.
 */
export function seedFromText(text) {
  // Rust accepts a leading '+', but no whitespace. Compare the complete
  // match because JavaScript's '$' can also match before a trailing newline.
  if (/^\+?[0-9]+$/.exec(text)?.[0] === text) {
    const number = BigInt(text);
    if (number <= MASK64) return number;
  }
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(text)) {
    hash = ((hash ^ BigInt(byte)) * 0x100000001b3n) & MASK64;
  }
  return hash;
}

/**
 * Tile grid and scrambled-frame geometry for a plan. `width`/`height` are the
 * source size; like the desktop app, the grid runs on the source padded up to
 * a tile multiple (`workWidth`/`workHeight`) and only the source area is shown.
 */
export function planGeometry({ width, height, tile, margin }) {
  for (const [name, value] of Object.entries({ width, height, tile, margin })) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer`);
  }
  if (tile === 0 || width === 0 || height === 0) throw new Error("tile, width and height must be positive");
  const columns = Math.ceil(width / tile);
  const rows = Math.ceil(height / tile);
  const block = tile + 2 * margin;
  if (![block, columns * tile, rows * tile, columns * block, rows * block, columns * rows]
    .every(Number.isSafeInteger)) throw new Error('plan geometry exceeds the safe integer range');
  return {
    columns,
    rows,
    block,
    workWidth: columns * tile,
    workHeight: rows * tile,
    uploadWidth: columns * block,
    uploadHeight: rows * block,
  };
}

/** Layout version of the numeric intro header; mirrors veilcast_core::HEADER_VERSION. */
export const HEADER_VERSION = 1;

function headerChecksum(digits) {
  let r = 0;
  for (const ch of digits) r = (r * 10 + Number(ch)) % 97;
  return String(r).padStart(2, "0");
}

function validateHeaderFields({ width, height, tile, margin, audioMs, audioMirror = false }) {
  if (!Number.isInteger(width) || width < 1 || width > 9999) throw new Error("header field width is out of range");
  if (!Number.isInteger(height) || height < 1 || height > 9999) throw new Error("header field height is out of range");
  if (!Number.isInteger(tile) || tile < 2 || tile > 998 || tile % 2 !== 0) throw new Error("header field tile is out of range");
  if (!Number.isInteger(margin) || margin < 0 || margin > 98 || margin % 2 !== 0) throw new Error("header field margin is out of range");
  if (!Number.isInteger(audioMs) || audioMs < 0 || audioMs > 9999) throw new Error("header field audio is out of range");
  if (audioMirror && audioMs === 0) throw new Error("header field flags is out of range");
}

/**
 * Digit string of the intro header, identical to IntroHeader::encode in Rust:
 * version(2) width(4) height(4) tile(3) margin(2) flags(1) audio(4) [seed(20)] check(2).
 * Flags: bit 0 invert, bit 1 audio spectrum mirror (only with audio).
 * `audioMs` is the audio block length (0 = audio untouched). `seed` is the
 * numeric seed (bigint/number) or null; the text a user typed goes through
 * seedFromText first.
 */
export function encodeIntroHeader({ width, height, tile, margin, invert = false, audioMs = 0, audioMirror = false, seed = null }) {
  validateHeaderFields({ width, height, tile, margin, audioMs, audioMirror });
  const pad = (value, digits) => String(value).padStart(digits, "0");
  const flags = (invert ? 1 : 0) | (audioMirror ? 2 : 0);
  let digits = pad(HEADER_VERSION, 2) + pad(width, 4) + pad(height, 4) + pad(tile, 3) + pad(margin, 2) + flags + pad(audioMs, 4);
  if (seed !== null && seed !== undefined) {
    const value = BigInt(seed);
    if (value < 0n || value > MASK64) throw new Error("header field seed is out of range");
    digits += pad(value, 20);
  }
  return digits + headerChecksum(digits);
}

/** Parses current and historical version-1 digit strings; validates the original checksum before interpreting fields. */
export function parseIntroHeader(text) {
  if (typeof text !== "string" || !/^[0-9]*$/.test(text)) throw new Error("header must contain only decimal digits");
  // Early version-1 videos omitted audio(4). They were already in use when
  // the field was added without a version bump; keep those 18/38-digit codes readable.
  const legacy = text.length === 18 || text.length === 38;
  if (!legacy && text.length !== 22 && text.length !== 42) throw new Error(`header must be 18, 22, 38 or 42 digits, got ${text.length}`);
  const version = Number(text.slice(0, 2));
  if (version !== HEADER_VERSION) throw new Error(`unknown header version ${version}`);
  if (text.slice(-2) !== headerChecksum(text.slice(0, -2))) throw new Error("header checksum mismatch");
  const flags = Number(text[15]);
  if (flags > 3) throw new Error("header field flags is out of range");
  let seed = null;
  if (text.length === 38 || text.length === 42) {
    const seedOffset = legacy ? 16 : 20;
    seed = BigInt(text.slice(seedOffset, seedOffset + 20));
    if (seed > MASK64) throw new Error("header field seed is out of range");
  }
  const header = {
    width: Number(text.slice(2, 6)),
    height: Number(text.slice(6, 10)),
    tile: Number(text.slice(10, 13)),
    margin: Number(text.slice(13, 15)),
    invert: (flags & 1) === 1,
    audioMs: legacy ? 0 : Number(text.slice(16, 20)),
    audioMirror: (flags & 2) === 2,
    seed,
  };
  validateHeaderFields(header);
  return header;
}

/**
 * Reads the intro header from a playing <video>: grabs frames at
 * `intervalMs` while the playhead is before `untilSeconds`, hands each to
 * `decode(imageData) -> string | null` (e.g. jsQR), and resolves with the
 * first parseable header, or null when the intro window passes without one.
 * Frames are downscaled to `maxWidth` before decoding; QR readers prefer
 * modest resolutions and it keeps the cost to a few milliseconds per frame.
 */
export function scanIntro(video, { decode, untilSeconds = 1.5, intervalMs = 100, maxWidth = 640, maxMillis = 5000, signal, onProgress } = {}) {
  if (typeof decode !== "function") throw new Error("scanIntro needs a decode(imageData) function");
  const emit = (event, details) => { try { onProgress?.(event, details); } catch { /* Diagnostic callbacks are nonessential. */ } };
  if (signal?.aborted) {
    emit('stop', { reason: 'already-aborted', frames: 0 });
    return Promise.resolve(null);
  }
  // A paused playhead inside the intro window never advances past it, so the
  // poll also needs a wall-clock bound to end on ordinary videos.
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    let timer = null;
    let settled = false;
    let attempts = 0;
    let frames = 0;
    let qrHits = 0;
    let invalidHeaders = 0;
    let lastWait = '';
    let stage = 'create-canvas';
    let canvas;
    let context;
    const summary = () => ({ attempts, frames, qrHits, invalidHeaders, elapsedMs: Date.now() - startedAt });
    const cleanup = () => {
      if (timer !== null) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const stop = (value, reason) => {
      if (settled) return;
      settled = true;
      cleanup();
      emit('stop', { reason, ...summary() });
      resolve(value);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      emit('error', { stage, ...summary(), errorName: error.name, errorMessage: error.message });
      reject(error);
    };
    const onAbort = () => stop(null, 'aborted');
    signal?.addEventListener("abort", onAbort, { once: true });
    emit('begin', { untilSeconds: Number.isFinite(untilSeconds) ? untilSeconds : 'current-frame', maxWidth, intervalMs, maxMillis });
    try {
      canvas = document.createElement("canvas");
      context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) throw new Error('二维码识别需要可用的 Canvas 2D 上下文。');
    } catch (error) { fail(error); return; }
    const attempt = () => {
      if (settled) return;
      attempts++;
      try {
        // Check the visit BEFORE sampling: a stale frame after seeking away
        // must not apply an intro belonging to an obsolete scan.
        if (signal?.aborted) return stop(null, 'aborted');
        if (video.currentTime > untilSeconds) return stop(null, 'outside-intro-window');
        if (Date.now() - startedAt >= maxMillis) return stop(null, 'timeout');
        if (!video.seeking && video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) {
          frames++;
          lastWait = '';
          const scale = Math.min(1, maxWidth / video.videoWidth);
          canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
          canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
          stage = 'draw-video';
          context.drawImage(video, 0, 0, canvas.width, canvas.height);
          stage = 'read-pixels';
          const image = context.getImageData(0, 0, canvas.width, canvas.height);
          if (frames <= 2 || frames % 10 === 0) {
            const bytes = image.data;
            const stride = Math.max(4, Math.floor(bytes.length / 128 / 4) * 4);
            let low = 255, high = 0, total = 0, count = 0;
            for (let at = 0; at + 2 < bytes.length; at += stride) {
              const luma = (bytes[at] + bytes[at + 1] + bytes[at + 2]) / 3;
              low = Math.min(low, luma); high = Math.max(high, luma); total += luma; count++;
            }
            emit('frame-read', { frame: frames, canvasWidth: canvas.width, canvasHeight: canvas.height,
              sampleMin: Math.round(low), sampleMax: Math.round(high), sampleMean: count ? Math.round(total / count) : null });
          }
          stage = 'decode-qr';
          const beforeDecode = Date.now();
          const text = decode(image);
          if (text) {
            qrHits++;
            if (qrHits <= 2 || qrHits % 10 === 0) emit('qr-detected', { length: typeof text === 'string' ? text.length : null,
              numeric: typeof text === 'string' && /^[0-9]+$/.test(text.trim()), decodeMs: Date.now() - beforeDecode });
            stage = 'parse-header';
            try {
              const header = parseIntroHeader(text.trim());
              emit('header-valid', { format: [18, 38].includes(text.trim().length) ? 'v1-legacy' : 'v1-audio', width: header.width, height: header.height, tile: header.tile,
                margin: header.margin, invert: header.invert, audioMs: header.audioMs, audioMirror: header.audioMirror, hasSeed: header.seed !== null });
              return stop(header, 'found');
            } catch (error) {
              invalidHeaders++;
              if (invalidHeaders <= 2 || invalidHeaders % 10 === 0) emit('header-rejected', { reason: error.message, length: text.length });
              // A QR code that is not ours; keep looking until the window closes.
            }
          } else if (frames <= 2 || frames % 10 === 0) {
            emit('no-qr', { frame: frames, decodeMs: Date.now() - beforeDecode });
          }
        } else {
          const reason = video.seeking ? 'seeking' : video.readyState < 2 ? 'frame-not-ready' : 'empty-video-size';
          if (reason !== lastWait || attempts % 10 === 0) emit('waiting-frame', { reason, ...summary() });
          lastWait = reason;
        }
        if (video.ended) return stop(null, 'ended');
        timer = setTimeout(attempt, intervalMs);
      } catch (error) {
        fail(error);
      }
    };
    attempt();
  });
}

/** Samples per audio block; the desktop pins audio to 48 kHz, so 48 per ms there. */
function audioBlockSamples(sampleRate, blockMs) {
  const block = Math.round((sampleRate * blockMs) / 1000);
  if (!Number.isSafeInteger(block) || block < 1) throw new Error("audio block must hold at least one sample");
  return block;
}

/**
 * Reverses time inside every whole block of planar audio, in place: the
 * browser mirror of veilcast_core::reverse_blocks, and like it its own
 * inverse. Blocks start at sample `start`; samples before it and a trailing
 * partial block are left alone. `channels` is an array of Float32Array
 * (AudioBuffer.getChannelData). Returns the number of blocks reversed.
 */
export function reverseAudioBlocks(channels, { sampleRate, blockMs, start = 0 }) {
  const block = audioBlockSamples(sampleRate, blockMs);
  if (!Number.isSafeInteger(start) || start < 0) throw new Error("audio block start must be a non-negative integer");
  const length = channels[0]?.length ?? 0;
  let blocks = 0;
  for (let at = start; at + block <= length; at += block, blocks++) {
    for (const data of channels) data.subarray(at, at + block).reverse();
  }
  return blocks;
}

// Spectrum mirror geometry, shared with veilcast_core::SpectrumMirror: a
// 16384-point STFT (2.93 Hz bins at 48 kHz) with sqrt-Hann windows at half
// overlap, mirroring bins 56..=3416 (164 Hz–10 kHz) onto each other, bin
// k <-> MIRROR_CENTER - k. Long frames keep the band edges sharp; with 2048
// points the edges leak enough to cost ~15 dB of round-trip SNR.
const MIRROR_SIZE = 16384;
const MIRROR_HOP = MIRROR_SIZE / 2;
const MIRROR_LOW = 56;
const MIRROR_HIGH = 3416;
const MIRROR_CENTER = MIRROR_LOW + MIRROR_HIGH;
let mirrorTables = null;

function mirrorFft() {
  if (mirrorTables) return mirrorTables;
  const n = MIRROR_SIZE;
  const bits = Math.log2(n);
  const reversed = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    reversed[i] = r;
  }
  const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos((2 * Math.PI * i) / n); sin[i] = -Math.sin((2 * Math.PI * i) / n); }
  const window = Float64Array.from({ length: n }, (_, m) => Math.sin((Math.PI * m) / n));
  // In place, forward (e^-i); the inverse runs it on the conjugate.
  const transform = (re, im) => {
    for (let i = 0; i < n; i++) {
      const j = reversed[i];
      if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1, step = n / len;
      for (let i = 0; i < n; i += len) {
        for (let k = 0; k < half; k++) {
          const wr = cos[k * step], wi = sin[k * step];
          const a = i + k, b = a + half;
          const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        }
      }
    }
  };
  return (mirrorTables = { window, transform });
}

/**
 * Mirrors one packed frame spectrum (two real channels as re + i·im) in
 * place: bin k takes e^{iφ}·Z[N-(C-k)] and bin N-k takes e^{-iφ}·Z[C-k].
 * On a real channel that is exactly a 2·cos carrier at C bins followed by
 * the band limit, i.e. f -> C·fs/N - f; applying it twice is the identity.
 */
function mirrorFrame(re, im, phase, scratch) {
  const n = MIRROR_SIZE;
  const c = Math.cos(phase), s = Math.sin(phase);
  for (let k = MIRROR_LOW; k <= MIRROR_HIGH; k++) {
    scratch[4 * k] = re[k]; scratch[4 * k + 1] = im[k];
    scratch[4 * k + 2] = re[n - k]; scratch[4 * k + 3] = im[n - k];
  }
  for (let k = MIRROR_LOW; k <= MIRROR_HIGH; k++) {
    const j = MIRROR_CENTER - k;
    const nr = scratch[4 * j + 2], ni = scratch[4 * j + 3]; // Z[N - j]
    const pr = scratch[4 * j], pi = scratch[4 * j + 1]; // Z[j]
    re[k] = c * nr - s * ni; im[k] = s * nr + c * ni;
    re[n - k] = c * pr + s * pi; im[n - k] = c * pi - s * pr;
  }
}

function* mirrorSteps(channels, anchor, sliceFrames) {
  const scratch = new Float64Array(4 * (MIRROR_HIGH + 1));
  yield* stftSteps(channels, sliceFrames, (re, im, start) => {
    // Carrier phase at this frame's first sample, measured from the anchor.
    const offset = (((start - anchor) % MIRROR_SIZE) + MIRROR_SIZE) % MIRROR_SIZE;
    mirrorFrame(re, im, (2 * Math.PI * ((MIRROR_CENTER * offset) % MIRROR_SIZE)) / MIRROR_SIZE, scratch);
  });
}

/** In place, planar channels: each frame's packed spectrum goes through `edit(re, im, start)`. */
function* stftSteps(channels, sliceFrames, edit) {
  const { window, transform } = mirrorFft();
  const n = MIRROR_SIZE, hop = MIRROR_HOP;
  const length = channels[0]?.length ?? 0;
  const re = new Float64Array(n), im = new Float64Array(n);
  let frames = 0;
  for (let pair = 0; pair < channels.length; pair += 2) {
    const a = channels[pair], b = channels[pair + 1];
    const tailA = new Float64Array(hop), tailB = new Float64Array(hop);
    // Frames start one hop before the data so every sample sees two windows.
    for (let start = -hop; start < length; start += hop) {
      for (let m = 0; m < n; m++) {
        const at = start + m;
        const inside = at >= 0 && at < length;
        re[m] = inside ? a[at] * window[m] : 0;
        im[m] = inside && b ? b[at] * window[m] : 0;
      }
      transform(re, im);
      edit(re, im, start);
      for (let m = 0; m < n; m++) im[m] = -im[m];
      transform(re, im);
      // Samples [start, start + hop) now have both window contributions; the
      // next frame reads from start + hop on, so they can be written in place.
      for (let m = 0; m < hop; m++) {
        const at = start + m;
        const valueA = tailA[m] + (re[m] / n) * window[m];
        const valueB = tailB[m] - (im[m] / n) * window[m];
        tailA[m] = (re[m + hop] / n) * window[m + hop];
        tailB[m] = -(im[m + hop] / n) * window[m + hop];
        if (at >= 0 && at < length) {
          a[at] = valueA;
          if (b) b[at] = valueB;
        }
      }
      if (++frames % sliceFrames === 0) yield;
    }
  }
}

/**
 * Mirrors the 164 Hz–10 kHz band of planar audio in place (f -> 10172 Hz - f),
 * the browser counterpart of veilcast_core::SpectrumMirror; like it, its own
 * inverse up to window-edge rounding. Bass and treble outside the band pass
 * through. `anchor` is the sample where the carrier phase is zero: the
 * content start, so that both ends agree on it after any container offset.
 * 48 kHz only. `channels` is an array of Float32Array.
 */
export function mirrorAudioSpectrum(channels, { anchor = 0 } = {}) {
  if (!Number.isSafeInteger(anchor)) throw new Error("mirror anchor must be an integer");
  for (const _ of mirrorSteps(channels, anchor, Infinity)) { /* runs to completion */ }
}

/** mirrorAudioSpectrum that yields to the event loop between slices; rejects with AbortError when `signal` aborts. */
export async function mirrorAudioSpectrumAsync(channels, { anchor = 0, signal, sliceFrames = 64 } = {}) {
  if (!Number.isSafeInteger(anchor)) throw new Error("mirror anchor must be an integer");
  for (const _ of mirrorSteps(channels, anchor, sliceFrames)) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (signal?.aborted) throw new DOMException("mirror aborted", "AbortError");
  }
}

/** Samples from the start of the sync chirp to the first content sample; veilcast_core::SYNC_CHIRP_LEAD. */
export const SYNC_CHIRP_LEAD = 36000;
let syncChirpCache = null;

/** veilcast_core::sync_chirp: 0.5 s, 1→8 kHz, −40 dBFS, 10 ms fades, 48 kHz. */
export function syncChirp() {
  if (syncChirpCache) return syncChirpCache;
  const length = 24000, fade = 480, duration = length / 48000;
  return (syncChirpCache = Float32Array.from({ length }, (_, n) => {
    const t = n / 48000;
    const phase = 1000 * t + (7000 * t * t) / (2 * duration);
    return 0.01 * Math.min(n / fade, (length - n) / fade, 1) * Math.sin(2 * Math.PI * phase);
  }));
}

/**
 * Locates the content start of a mirrored upload by the sync chirp in its
 * intro, searching `searchMs` either side of `nominalStart`. `confidence` is
 * the normalised correlation peak over its mean magnitude: a few hundred for
 * a real chirp, near 1 when there is none.
 */
export function findAudioSync(channels, { sampleRate, nominalStart, searchMs = 100 }) {
  if (sampleRate !== 48000) throw new Error("the sync chirp is defined at 48 kHz");
  const chirp = syncChirp();
  const length = channels[0]?.length ?? 0;
  const mono = new Float64Array(length);
  for (const data of channels) for (let i = 0; i < length; i++) mono[i] += data[i];
  let chirpEnergy = 0;
  for (const v of chirp) chirpEnergy += v * v;
  const reach = Math.round((sampleRate * searchMs) / 1000);
  const expected = nominalStart - SYNC_CHIRP_LEAD;
  let best = nominalStart, bestScore = -Infinity, total = 0, candidates = 0;
  for (let lag = -reach; lag <= reach; lag++) {
    const at = expected + lag;
    if (at < 0 || at + chirp.length > length) continue;
    let dot = 0, energy = 0;
    for (let n = 0; n < chirp.length; n++) { const v = mono[at + n]; dot += v * chirp[n]; energy += v * v; }
    const score = energy > 0 ? dot / Math.sqrt(chirpEnergy * energy) : 0;
    total += Math.abs(score);
    candidates++;
    if (score > bestScore) { bestScore = score; best = at + SYNC_CHIRP_LEAD; }
  }
  const mean = total / Math.max(1, candidates);
  return { start: best, offset: best - nominalStart, confidence: mean > 0 ? bestScore / mean : 0 };
}

/**
 * Finds where the reversed blocks really start in a decoded track.
 *
 * Containers and codecs shift audio by up to tens of milliseconds — browsers
 * do not trim AAC priming from fragmented MP4, for one — so the grid cannot
 * be taken on trust. Reversal leaves a jump between unrelated samples at
 * every block boundary, and lossy codecs smear that jump symmetrically, so
 * the true grid is where the summed squared sample-to-sample step over many
 * boundaries peaks. Candidates cover `searchMs` either side of
 * `nominalStart`, capped below half a block because the grid repeats every
 * block. `confidence` is the peak over the mean score: near 1 means there
 * was nothing to find (silence, or audio that was never reversed).
 *
 * `mirrored`: the reversed content was spectrum-mirrored afterwards. Its
 * energy then sits near 10 kHz, every sample step is large and the boundary
 * jumps no longer stand out, so the search runs on a copy of the first
 * `mirrorProbeSeconds` mirrored back with the nominal anchor instead. An
 * anchor that is off by the unknown offset only rotates the phase of the
 * whole probe, which leaves the reversal's jumps where they are.
 */
export function findAudioGrid(channels, { sampleRate, blockMs, nominalStart, searchMs = 100, maxBlocks = 400, mirrored = false, mirrorProbeSeconds = 30 }) {
  if (mirrored) {
    const end = Math.min(channels[0]?.length ?? 0, nominalStart + Math.round(sampleRate * mirrorProbeSeconds));
    const probe = channels.map((data) => data.slice(0, end));
    mirrorAudioSpectrum(probe, { anchor: nominalStart });
    channels = probe;
  }
  const block = audioBlockSamples(sampleRate, blockMs);
  const length = channels[0]?.length ?? 0;
  const reach = Math.min(Math.round((sampleRate * searchMs) / 1000), Math.floor((block - 1) / 2));
  let best = nominalStart;
  let bestScore = -1;
  let total = 0;
  let candidates = 0;
  for (let start = nominalStart - reach; start <= nominalStart + reach; start++) {
    let score = 0;
    let at = start;
    for (let k = 0; k < maxBlocks && at + block <= length; k++, at += block) {
      if (at < 1) continue;
      for (const data of channels) {
        const step = data[at] - data[at - 1];
        score += step * step;
      }
    }
    total += score;
    candidates++;
    if (score > bestScore) {
      bestScore = score;
      best = start;
    }
  }
  const mean = total / Math.max(1, candidates);
  return { start: best, offset: best - nominalStart, confidence: mean > 0 ? bestScore / mean : 0 };
}

/**
 * 16-bit PCM WAV of planar float audio. Output sample i is input sample
 * i + offset (silence where that falls outside the input), which is how a
 * decoded track that runs early or late is put back on the media timeline.
 */
export function encodeWav(channels, sampleRate, { offset = 0 } = {}) {
  const channelCount = channels.length;
  const length = channels[0]?.length ?? 0;
  const frames = Math.max(0, length - offset);
  const dataBytes = frames * channelCount * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const text = (at, value) => { for (let i = 0; i < value.length; i++) view.setUint8(at + i, value.charCodeAt(i)); };
  text(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channelCount * 2, true);
  view.setUint16(32, channelCount * 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, dataBytes, true);
  // Every browser is little-endian, which is what WAV wants.
  const pcm = new Int16Array(buffer, 44, frames * channelCount);
  let out = 0;
  for (let i = 0; i < frames; i++) {
    const source = i + offset;
    for (let c = 0; c < channelCount; c++, out++) {
      const value = source >= 0 && source < length ? Math.max(-1, Math.min(1, channels[c][source])) : 0;
      pcm[out] = value < 0 ? value * 0x8000 : value * 0x7fff;
    }
  }
  return buffer;
}

const VERTEX_SHADER = `#version 300 es
const vec2 corners[3] = vec2[3](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
out vec2 vUv;
void main() {
  vec2 p = corners[gl_VertexID];
  gl_Position = vec4(p, 0.0, 1.0);
  // Texture row 0 is the top of the video, so flip y from clip space.
  vUv = vec2(p.x, -p.y) * 0.5 + 0.5;
}`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
uniform sampler2D uVideo;
uniform usampler2D uBlockOfTile;
uniform ivec2 uGrid;
uniform int uTile;
uniform int uMargin;
uniform bool uInvert;
uniform vec2 uOriginal;
uniform vec2 uUpload;
in vec2 vUv;
out vec4 outColor;
void main() {
  vec2 p = vUv * uOriginal;
  ivec2 t = min(ivec2(p) / uTile, uGrid - 1);
  uint block = texelFetch(uBlockOfTile, t, 0).r;
  ivec2 b = ivec2(int(block) % uGrid.x, int(block) / uGrid.x);
  vec2 within = p - vec2(t * uTile);
  float blockSize = float(uTile + 2 * uMargin);
  vec2 src = vec2(b) * blockSize + float(uMargin) + within;
  vec4 color = texture(uVideo, src / uUpload);
  outColor = vec4(uInvert ? vec3(1.0) - color.rgb : color.rgb, color.a);
}`;

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('WebGL shader allocation failed');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(message);
  }
  return shader;
}

/**
 * Builds a restorer on a WebGL2 context. `draw(video)` uploads the current
 * frame of an HTMLVideoElement (or any TexImageSource showing the scrambled
 * frame) and renders the restored picture over the whole viewport.
 */
export function createRestorer(gl, params) {
  const { width, height, tile, margin, seed, invert = false } = params;
  if (typeof invert !== 'boolean') throw new Error('invert must be a boolean');
  const geometry = planGeometry(params);
  const { columns, rows } = geometry;

  const maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  if (columns > maxTexture || rows > maxTexture) throw new Error('tile grid exceeds the GPU texture limit');

  const permutation = seededPermutation(columns * rows, seedFromText(String(seed)));
  const blockOfTile = new Uint32Array(columns * rows);
  permutation.forEach((tileIndex, block) => {
    blockOfTile[tileIndex] = block;
  });

  const program = gl.createProgram();
  if (!program) throw new Error('WebGL program allocation failed');
  const shaders = [];
  try {
    shaders.push(compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER));
    shaders.push(compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER));
    for (const shader of shaders) gl.attachShader(program, shader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program));
    }
  } catch (error) {
    gl.deleteProgram(program);
    throw error;
  } finally {
    for (const shader of shaders) {
      // Deleting attached shaders only marks them for deletion until the
      // program is destroyed; detaching frees them immediately after linking.
      if (gl.isProgram(program)) gl.detachShader(program, shader);
      gl.deleteShader(shader);
    }
  }
  gl.useProgram(program);

  const uniform = (name) => gl.getUniformLocation(program, name);
  gl.uniform1i(uniform('uVideo'), 0);
  gl.uniform1i(uniform('uBlockOfTile'), 1);
  gl.uniform2i(uniform('uGrid'), columns, rows);
  gl.uniform1i(uniform('uTile'), tile);
  gl.uniform1i(uniform('uMargin'), margin);
  gl.uniform1i(uniform('uInvert'), invert ? 1 : 0);
  gl.uniform2f(uniform('uOriginal'), width, height);
  gl.uniform2f(uniform('uUpload'), geometry.uploadWidth, geometry.uploadHeight);

  const videoTexture = gl.createTexture();
  const mapTexture = gl.createTexture();
  if (!videoTexture || !mapTexture) {
    gl.deleteTexture(videoTexture);
    gl.deleteTexture(mapTexture);
    gl.useProgram(null);
    gl.deleteProgram(program);
    throw new Error('WebGL texture allocation failed');
  }
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, videoTexture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, mapTexture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32UI, columns, rows, 0, gl.RED_INTEGER, gl.UNSIGNED_INT, blockOfTile);

  if (gl.getError() !== gl.NO_ERROR) {
    gl.deleteTexture(videoTexture);
    gl.deleteTexture(mapTexture);
    gl.useProgram(null);
    gl.deleteProgram(program);
    throw new Error('WebGL tile map upload failed');
  }

  let destroyed = false;
  return {
    geometry,
    draw(source) {
      if (destroyed) throw new Error('restorer has been destroyed');
      if ((source.videoWidth ?? source.width) > maxTexture ||
          (source.videoHeight ?? source.height) > maxTexture) {
        throw new Error('video exceeds the GPU texture limit');
      }
      gl.useProgram(program);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, mapTexture);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, videoTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      gl.deleteTexture(videoTexture);
      gl.deleteTexture(mapTexture);
      if (gl.getParameter(gl.CURRENT_PROGRAM) === program) gl.useProgram(null);
      gl.deleteProgram(program);
    },
  };
}
