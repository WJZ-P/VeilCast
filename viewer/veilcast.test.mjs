// Run with: node --test viewer/*.test.mjs
// The known-answer vectors are shared with tests/permutation.rs; both sides
// must agree or the browser cannot restore what the Rust side scrambled.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  encodeIntroHeader, encodeWav, findAudioGrid, findAudioSync, mirrorAudioSpectrum, mirrorAudioSpectrumAsync,
  parseIntroHeader, planGeometry, reverseAudioBlocks, seedFromText, seededPermutation, SYNC_CHIRP_LEAD, syncChirp,
} from './veilcast.js';

test('known-answer vectors match veilcast_core', () => {
  assert.deepEqual(seededPermutation(16, 1), [2, 11, 10, 6, 7, 13, 14, 0, 12, 5, 15, 9, 3, 8, 4, 1]);
  assert.deepEqual(seededPermutation(12, 20260916), [7, 9, 10, 5, 1, 0, 2, 11, 3, 6, 4, 8]);
  assert.deepEqual(seededPermutation(0, 7), []);
  assert.deepEqual(seededPermutation(1, 7), [0]);
});

test('seeds beyond 2^53 are handled as full 64-bit values', () => {
  assert.notDeepEqual(seededPermutation(64, 0n), seededPermutation(64, 2n ** 63n));
  assert.deepEqual(seededPermutation(64, '20260916'), seededPermutation(64, 20260916));
});

test('every size yields a permutation', () => {
  for (const tileCount of [2, 3, 64, 3600]) {
    const permutation = seededPermutation(tileCount, 42);
    assert.equal(new Set(permutation).size, tileCount);
    assert.ok(permutation.every((tile) => tile >= 0 && tile < tileCount));
  }
});

test('plan geometry matches the desktop fit() and ShufflePlan::scrambled_layout', () => {
  assert.deepEqual(planGeometry({ width: 720, height: 1280, tile: 16, margin: 4 }), {
    columns: 45,
    rows: 80,
    block: 24,
    workWidth: 720,
    workHeight: 1280,
    uploadWidth: 1080,
    uploadHeight: 1920,
  });
  // 1078 rows pad up to 1080 for tile 40, exactly like fit() in the app.
  assert.deepEqual(planGeometry({ width: 1920, height: 1078, tile: 40, margin: 0 }), {
    columns: 48,
    rows: 27,
    block: 40,
    workWidth: 1920,
    workHeight: 1080,
    uploadWidth: 1920,
    uploadHeight: 1080,
  });
  assert.throws(() => planGeometry({ width: 720, height: 1280, tile: 0, margin: 0 }), /positive/);
});

test('text seeds match veilcast_core::seed_from_text', () => {
  assert.equal(seedFromText('20260916'), 20260916n);
  assert.equal(seedFromText('007'), 7n);
  assert.equal(seedFromText('+007'), 7n);
  assert.equal(seedFromText('+18446744073709551615'), 2n ** 64n - 1n);
  for (const text of ['1\n', '1\r', ' 1', '1 ', '+', '+1\n']) {
    assert.notEqual(seedFromText(text), 1n);
  }
  assert.equal(seedFromText('18446744073709551615'), 2n ** 64n - 1n);
  assert.equal(seedFromText(''), 0xcbf29ce484222325n);
  assert.equal(seedFromText('a'), 0xaf63dc4c8601ec8cn);
  assert.equal(seedFromText('veilcast'), 0x88d44f40babc4fa2n);
  assert.equal(seedFromText('密码'), 0x0e4025f70675fc15n);
  assert.equal(seedFromText('-1'), 0x07d00b07b497d12bn);
  assert.equal(seedFromText('18446744073709551616'), 0xedf2aa6b38fc416dn);
});

test('plan geometry rejects unsafe integer dimensions and derived overflow', () => {
  assert.throws(() => planGeometry({ width: 2 ** 53, height: 2, tile: 2, margin: 0 }), /safe integer/);
  assert.throws(() => planGeometry({ width: 2, height: 2, tile: 2, margin: Number.MAX_SAFE_INTEGER }), /safe integer/);
});

test('intro header vectors match veilcast_core (tests/header.rs)', () => {
  const sample = { width: 2560, height: 1370, tile: 40, margin: 0, invert: true, audioMs: 0, audioMirror: false };
  assert.equal(encodeIntroHeader(sample), '0125601370040001000017');
  assert.equal(
    encodeIntroHeader({ ...sample, seed: 0x88d44f40babc4fa2n }),
    '012560137004000100000985959262365026294677',
  );
  assert.equal(encodeIntroHeader({ ...sample, audioMs: 250 }), '0125601370040001025073');
  assert.equal(
    encodeIntroHeader({ ...sample, audioMs: 250, seed: 0x88d44f40babc4fa2n }),
    '012560137004000102500985959262365026294691',
  );
  assert.equal(
    encodeIntroHeader({ width: 720, height: 1280, tile: 16, margin: 4, invert: false }),
    '0107201280016040000016',
  );
  assert.equal(encodeIntroHeader({ ...sample, audioMs: 250, audioMirror: true }), '0125601370040003025091');
  assert.equal(
    encodeIntroHeader({ ...sample, audioMs: 250, audioMirror: true, seed: 0x88d44f40babc4fa2n }),
    '012560137004000302500985959262365026294647',
  );
  assert.equal(
    encodeIntroHeader({ width: 720, height: 1280, tile: 16, margin: 4, audioMs: 250, audioMirror: true }),
    '0107201280016042025090',
  );
  assert.deepEqual(parseIntroHeader('0107201280016042025090'), {
    width: 720, height: 1280, tile: 16, margin: 4, invert: false, audioMs: 250, audioMirror: true, seed: null,
  });
  assert.deepEqual(parseIntroHeader('0125601370040001000017'), { ...sample, seed: null });
  assert.deepEqual(parseIntroHeader('012560137004000102500985959262365026294691'), {
    ...sample,
    audioMs: 250,
    seed: 0x88d44f40babc4fa2n,
  });
  for (const header of [
    { ...sample, seed: 2n ** 64n - 1n },
    { ...sample, seed: 0n, invert: false },
    { width: 1, height: 9999, tile: 998, margin: 98, invert: true, audioMs: 9999, audioMirror: true, seed: 1n },
    { ...sample, invert: false, audioMs: 50, audioMirror: true, seed: null },
  ]) {
    assert.deepEqual(parseIntroHeader(encodeIntroHeader(header)), header);
  }
});

test('intro header parser rejects the same strings as Rust', () => {
  assert.throws(() => parseIntroHeader('012560137004000100001'), /18, 22, 38 or 42 digits, got 21/);
  assert.throws(() => parseIntroHeader('01256013700400014'), /18, 22, 38 or 42 digits, got 17/);
  assert.throws(() => parseIntroHeader('012560137004000100001x'), /only decimal digits/);
  assert.throws(() => parseIntroHeader('0125601370040001000018'), /checksum/);
  assert.throws(() => parseIntroHeader('0225601370040001000009'), /unknown header version 2/);
  assert.throws(() => parseIntroHeader('0125601370040002000026'), /flags/);
  assert.throws(() => parseIntroHeader('0125601370040004025003'), /flags/);
  assert.throws(() => encodeIntroHeader({ width: 1, height: 1, tile: 40, margin: 0, audioMirror: true }), /flags/);
  assert.throws(() => parseIntroHeader('012560137004000100001844674407370955161641'), /seed/);
  assert.throws(() => encodeIntroHeader({ width: 1, height: 1, tile: 40, margin: 0, audioMs: 10000 }), /audio/);
  assert.throws(() => encodeIntroHeader({ width: 0, height: 1, tile: 40, margin: 0 }), /width/);
  assert.throws(() => encodeIntroHeader({ width: 1, height: 1, tile: 41, margin: 0 }), /tile/);
});

test('legacy 18/38-digit intro headers from earlier releases remain readable', () => {
  const sample = { width: 2560, height: 1370, tile: 40, margin: 0, invert: true, audioMs: 0, audioMirror: false, seed: null };
  assert.deepEqual(parseIntroHeader('012560137004000145'), sample);
  assert.deepEqual(parseIntroHeader('01256013700400010985959262365026294684'), { ...sample, seed: 0x88d44f40babc4fa2n });
  assert.deepEqual(parseIntroHeader('010720128001604088'), {
    width: 720, height: 1280, tile: 16, margin: 4, invert: false, audioMs: 0, audioMirror: false, seed: null,
  });
  assert.equal(encodeIntroHeader(parseIntroHeader('012560137004000145')), '0125601370040001000017');
});

test('legacy headers still reject bad checksums, versions, flags and oversized seeds', () => {
  assert.throws(() => parseIntroHeader('012560137004000146'), /checksum/);
  assert.throws(() => parseIntroHeader('022560137004000148'), /version/);
  assert.throws(() => parseIntroHeader('012560137004000246'), /flags/);
  assert.throws(() => parseIntroHeader('01256013700400011844674407370955161648'), /seed/);
});

test('audio blocks reverse from the start sample and leave the rest alone', () => {
  const ramp = (n) => Float32Array.from({ length: n }, (_, i) => i);
  // 1 kHz sample rate so 4 ms is a 4-sample block.
  const left = ramp(15);
  const right = ramp(15).map((v) => -v);
  assert.equal(reverseAudioBlocks([left, right], { sampleRate: 1000, blockMs: 4, start: 2 }), 3);
  assert.deepEqual([...left], [0, 1, 5, 4, 3, 2, 9, 8, 7, 6, 13, 12, 11, 10, 14]);
  assert.deepEqual([...right], [...left].map((v) => -v));
  // Its own inverse.
  reverseAudioBlocks([left, right], { sampleRate: 1000, blockMs: 4, start: 2 });
  assert.deepEqual([...left], [...ramp(15)]);
  assert.equal(reverseAudioBlocks([ramp(3)], { sampleRate: 1000, blockMs: 4 }), 0);
  assert.throws(() => reverseAudioBlocks([ramp(3)], { sampleRate: 1000, blockMs: 0 }), /at least one sample/);
  assert.throws(() => reverseAudioBlocks([ramp(3)], { sampleRate: 1000, blockMs: 4, start: -1 }), /non-negative/);
});

test('the block grid is found where the reversal left its jumps', () => {
  // Five seconds of band-limited "music" after one second of silence, like
  // an upload with its intro; the decoder shifted it by 1024 priming samples.
  const rate = 48000;
  const priming = 1024;
  const length = priming + rate * 6;
  let state = 12345;
  const random = () => ((state = (state * 1103515245 + 12345) % 2147483648) / 2147483648);
  const partials = Array.from({ length: 24 }, () => ({ f: 60 + random() * 3000, p: random() * 6.283, a: random() }));
  const channel = () => {
    const data = new Float32Array(length);
    for (let i = priming + rate; i < length; i++) {
      const t = i / rate;
      let v = 0;
      for (const { f, p, a } of partials) v += a * Math.sin(6.283185 * f * t + p) * (0.6 + 0.4 * Math.sin(t * 3 + p));
      data[i] = v / 12;
    }
    return data;
  };
  const left = channel();
  const right = channel();
  reverseAudioBlocks([left, right], { sampleRate: rate, blockMs: 250, start: priming + rate });
  // A lossy codec smears each jump over a few samples, symmetrically: the
  // decoder adds no delay of its own beyond the priming already modelled.
  for (const data of [left, right]) {
    const copy = data.slice();
    for (let i = 1; i < length - 1; i++) data[i] = (copy[i - 1] + 2 * copy[i] + copy[i + 1]) / 4;
  }
  const grid = findAudioGrid([left, right], { sampleRate: rate, blockMs: 250, nominalStart: rate });
  assert.ok(Math.abs(grid.offset - priming) <= 1, `offset ${grid.offset}`);
  assert.ok(grid.confidence > 3, `confidence ${grid.confidence}`);

  const silent = findAudioGrid([new Float32Array(rate * 3)], { sampleRate: rate, blockMs: 250, nominalStart: rate });
  assert.equal(silent.confidence, 0, 'silence has no grid to find');
});

const MIRROR_CARRIER_HZ = 10171.875;
const tone = (hz, length, from = 0) => Float32Array.from({ length }, (_, n) => (n < from ? 0 : 0.5 * Math.cos((2 * Math.PI * hz * (n - from)) / 48000)));
const snrDb = (reference, actual) => {
  let signal = 0, error = 0;
  for (let i = 0; i < reference.length; i++) { signal += reference[i] ** 2; error += (reference[i] - actual[i]) ** 2; }
  return 10 * Math.log10(signal / error);
};
const noise = (length, seed) => {
  let state = seed;
  return Float32Array.from({ length }, () => ((state = (state * 1103515245 + 12345) % 2147483648) / 2147483648 - 0.5) * 0.5);
};

test('the spectrum mirror moves a tone to carrier minus frequency, phase zero at the anchor (tests/spectrum.rs)', () => {
  const data = tone(1000, 96000);
  mirrorAudioSpectrum([data]);
  const expected = tone(MIRROR_CARRIER_HZ - 1000, 96000);
  let worst = 0;
  for (let n = 20000; n < 76000; n++) worst = Math.max(worst, Math.abs(data[n] - expected[n]));
  assert.ok(worst < 1e-3, `worst deviation ${worst}`);

  // The anchor, not the buffer start, is where the carrier phase is zero.
  const late = tone(1000, 96000, 1234);
  mirrorAudioSpectrum([late], { anchor: 1234 });
  const lateExpected = tone(MIRROR_CARRIER_HZ - 1000, 96000, 1234);
  worst = 0;
  for (let n = 20000; n < 76000; n++) worst = Math.max(worst, Math.abs(late[n] - lateExpected[n]));
  assert.ok(worst < 1e-3, `anchored worst deviation ${worst}`);

  for (const hz of [60, 14000]) {
    const outside = tone(hz, 96000);
    mirrorAudioSpectrum([outside]);
    assert.ok(snrDb(tone(hz, 96000).subarray(20000, 76000), outside.subarray(20000, 76000)) > 60, `${hz} Hz passes through`);
  }
});

test('mirroring twice restores, also on another frame grid, and the async form matches', async () => {
  const left = noise(120000, 1), right = noise(120000, 2), third = noise(120000, 3);
  const channels = [left.slice(), right.slice(), third.slice()];
  mirrorAudioSpectrum(channels);
  assert.ok(snrDb(left, channels[0]) < 1, 'the mirrored signal must be unlike the input');
  const viaAsync = [left.slice(), right.slice(), third.slice()];
  await mirrorAudioSpectrumAsync(viaAsync, { sliceFrames: 3 });
  for (const [index, data] of viaAsync.entries()) assert.deepEqual(data, channels[index], `async channel ${index}`);
  // A restore whose buffer starts 777 samples earlier, anchored at the content.
  const shifted = channels.map((data) => { const out = new Float32Array(data.length + 777); out.set(data, 777); return out; });
  mirrorAudioSpectrum(shifted, { anchor: 777 });
  mirrorAudioSpectrum(channels);
  for (const [index, original] of [left, right, third].entries()) {
    assert.ok(snrDb(original, channels[index]) > 30, `channel ${index} same grid`);
    assert.ok(snrDb(original, shifted[index].subarray(777)) > 28, `channel ${index} shifted grid`);
  }
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(mirrorAudioSpectrumAsync([noise(48000, 4)], { signal: controller.signal, sliceFrames: 1 }), { name: 'AbortError' });
});

test('the grid of a mirrored upload is found on the mirrored-back copy; undoing both restores', () => {
  const rate = 48000, priming = 1024, length = priming + rate * 6;
  let state = 99;
  const random = () => ((state = (state * 1103515245 + 12345) % 2147483648) / 2147483648);
  const partials = Array.from({ length: 24 }, () => ({ f: 200 + random() * 2000, p: random() * 6.283, a: random() }));
  const original = Float32Array.from({ length: rate * 5 }, (_, i) => {
    let v = 0;
    for (const { f, p, a } of partials) v += a * Math.sin((6.283185 * f * i) / rate + p) * (0.6 + 0.4 * Math.sin((i / rate) * 3 + p));
    return v / 12;
  });
  // Scrambled as the desktop does: reverse, then mirror, anchored at the content start.
  const content = original.slice();
  reverseAudioBlocks([content], { sampleRate: rate, blockMs: 250 });
  mirrorAudioSpectrum([content]);
  const upload = new Float32Array(length);
  upload.set(content, priming + rate);
  const grid = findAudioGrid([upload], { sampleRate: rate, blockMs: 250, nominalStart: rate, mirrored: true });
  assert.ok(Math.abs(grid.offset - priming) <= 1, `offset ${grid.offset}`);
  assert.ok(grid.confidence > 3, `confidence ${grid.confidence}`);
  mirrorAudioSpectrum([upload], { anchor: grid.start });
  reverseAudioBlocks([upload], { sampleRate: rate, blockMs: 250, start: grid.start });
  assert.ok(snrDb(original, upload.subarray(grid.start, grid.start + original.length)) > 30);
});

test('the sync chirp matches veilcast_core and pins the content start through an offset', () => {
  // tests/audio.rs pins the same samples.
  const chirp = syncChirp();
  assert.equal(chirp.length, 24000);
  assert.equal(SYNC_CHIRP_LEAD, 36000);
  for (const [index, expected] of [[0, 0], [240, 0.0044550328], [1000, -0.00722364], [23999, -0.000018042]]) {
    assert.ok(Math.abs(chirp[index] - expected) < 1e-7, `sample ${index}: ${chirp[index]}`);
  }
  // Intro second with the chirp, then loud noise; decoded 1024 samples late.
  const rate = 48000, priming = 1024;
  const track = new Float32Array(priming + rate * 3);
  track.set(chirp, priming + rate - SYNC_CHIRP_LEAD);
  track.set(noise(rate * 2, 5).map((v) => v * 3), priming + rate);
  const found = findAudioSync([track, track], { sampleRate: rate, nominalStart: rate });
  assert.equal(found.offset, priming);
  assert.equal(found.start, priming + rate);
  assert.ok(found.confidence > 100, `confidence ${found.confidence}`);
  const none = findAudioSync([noise(rate * 3, 6)], { sampleRate: rate, nominalStart: rate });
  assert.ok(none.confidence < 20, `no chirp, confidence ${none.confidence}`);
});

test('WAV output is 16-bit PCM shifted onto the media timeline', () => {
  const left = Float32Array.from([0.5, -0.5, 1.5, -1.5]);
  const right = Float32Array.from([0, 0.25, -0.25, 1]);
  const bytes = encodeWav([left, right], 48000);
  const view = new DataView(bytes);
  const text = (at) => String.fromCharCode(...new Uint8Array(bytes, at, 4));
  assert.equal(text(0), 'RIFF');
  assert.equal(text(8), 'WAVE');
  assert.equal(view.getUint16(20, true), 1);
  assert.equal(view.getUint16(22, true), 2);
  assert.equal(view.getUint32(24, true), 48000);
  assert.equal(view.getUint32(40, true), 16);
  assert.deepEqual([...new Int16Array(bytes, 44)], [16383, 0, -16384, 8191, 32767, -8192, -32768, 32767]);
  // A track decoded two samples late drops them; one decoded early gains silence.
  assert.deepEqual([...new Int16Array(encodeWav([left], 8000, { offset: 2 }), 44)], [32767, -32768]);
  assert.deepEqual([...new Int16Array(encodeWav([left], 8000, { offset: -1 }), 44)], [0, 16383, -16384, 32767, -32768]);
});
