// Headless media/Web Audio doubles: no browser or desktop control.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAudioRestorer } from '../src/audio.js';

const flush = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function setup(t, { captured = false, contextState = 'running', metadata = true, decoding, muted = false, play, mirror = false, syncConfidence = 500 } = {}) {
  const counts = { fetch: 0, decode: 0, urls: 0, captures: 0, contexts: 0 };
  const elements = [], revoked = [], reports = [], traces = [], gains = [], steps = [];
  let playBehavior = play;
  class AudioElement extends EventTarget {
    constructor() {
      super();
      Object.assign(this, { dataset: {}, src: '', readyState: 0, paused: true, muted: false,
        volume: 1, playbackRate: 1, duration: NaN, playCalls: 0, loadCalls: 0, removed: false, time: 0 });
    }
    get currentTime() { return this.time; }
    set currentTime(value) {
      if (this.readyState < 1) throw new DOMException('metadata not ready', 'InvalidStateError');
      this.time = value;
    }
    load() {
      this.loadCalls++;
      if (!this.src) { this.readyState = 0; return; }
      const source = this.src;
      if (metadata) queueMicrotask(() => {
        if (this.removed || this.src !== source) return;
        this.readyState = 4; this.duration = 120;
        this.dispatchEvent(new Event('loadedmetadata'));
        this.dispatchEvent(new Event('canplay'));
      });
    }
    play() {
      this.playCalls++;
      if (playBehavior) return playBehavior(this);
      this.paused = false;
      return Promise.resolve();
    }
    pause() { this.paused = true; }
    removeAttribute(name) { if (name === 'src') this.src = ''; }
    remove() { this.removed = true; }
  }
  const video = Object.assign(new EventTarget(), { currentTime: 7, paused: false, ended: false,
    seeking: false, readyState: 4, volume: 0.8, playbackRate: 1 });
  let wantedMute = muted;
  Object.defineProperty(video, 'muted', {
    get: () => wantedMute,
    set: (value) => {
      if (wantedMute === value) return;
      wantedMute = value;
      queueMicrotask(() => video.dispatchEvent(new Event('volumechange')));
    },
  });
  const document = Object.assign(new EventTarget(), { createElement: (name) => {
    assert.equal(name, 'audio');
    const audio = new AudioElement(); elements.push(audio); return audio;
  } });
  const attached = new WeakSet();
  const decoded = { numberOfChannels: 2, getChannelData: () => new Float32Array(100) };
  const overrides = {
    document,
    navigator: { userActivation: { hasBeenActive: captured } },
    AudioContext: class {
      constructor() { counts.contexts++; this.state = contextState; this.destination = {}; }
      createGain() { const gain = { gain: { value: 1 }, connect: (node) => node }; gains.push(gain); return gain; }
      createMediaElementSource(element) {
        if (attached.has(element)) throw new Error('media element captured twice');
        attached.add(element); counts.captures++;
        return { connect: (gain) => gain };
      }
      resume() { this.state = 'running'; return Promise.resolve(); }
      close() { this.state = 'closed'; return Promise.resolve(); }
    },
    OfflineAudioContext: class { decodeAudioData() { counts.decode++; return decoding?.promise ?? Promise.resolve(decoded); } },
    fetch: async () => { counts.fetch++; return { ok: true, arrayBuffer: async () => new ArrayBuffer(10) }; },
    URL: { createObjectURL: () => `blob:test-${++counts.urls}`, revokeObjectURL: (url) => revoked.push(url) },
  };
  const originals = new Map();
  for (const [key, value] of Object.entries(overrides)) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const handle = createAudioRestorer({ video, blockMs: 250, mirror, host: { append() {} },
    locate: async () => 'https://example.invalid/audio.m4s',
    report: (state, text) => reports.push({ state, text }), trace: (event, details) => traces.push({ event, details }),
    findAudioGrid: (_, { mirrored }) => { steps.push(['grid', mirrored]); return { start: 49024, confidence: 3 }; },
    findAudioSync: () => { steps.push(['sync']); return { start: 49024, confidence: syncConfidence }; },
    reverseAudioBlocks: (_, { start }) => { steps.push(['reverse', start]); },
    mirrorAudioSpectrumAsync: async (_, { anchor, signal }) => { steps.push(['mirror', anchor, signal.aborted]); },
    encodeWav: (_, __, { offset }) => { steps.push(['wav', offset]); return new Uint8Array(32); },
  });
  t.after(() => {
    handle.destroy();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  return { video, document, handle, counts, elements, revoked, reports, traces, gains, decoded, steps,
    setPlay: (behavior) => { playBehavior = behavior; } };
}

test('a mirrored upload is located by its chirp (grid search as fallback), mirrored back, then reversed', async (t) => {
  for (const [mirror, syncConfidence] of [[false, 500], [true, 500], [true, 1]]) {
    const r = setup(t, { mirror, syncConfidence });
    await flush(); await flush();
    // 49024 = one second plus the 1024 AAC priming samples; 12000-sample blocks.
    const locate = !mirror ? [['grid', false]] : syncConfidence >= 20 ? [['sync']] : [['sync'], ['grid', true]];
    assert.deepEqual(r.steps, [
      ...locate, ...(mirror ? [['mirror', 49024, false]] : []), ['reverse', 49024 % 12000], ['wav', 1024],
    ]);
    assert.equal(r.handle.mirror, mirror);
    assert.match(r.reports.at(-1).text, mirror ? /频谱翻转/ : /^(?!.*频谱翻转)/);
    r.handle.destroy();
  }
});

for (const captured of [false, true]) {
  test(`off/on reuses one audio element and WAV (${captured ? 'Web Audio capture' : 'muted fallback'})`, async (t) => {
    const r = setup(t, { captured });
    await flush();
    const audio = r.elements[0];
    assert.equal(audio.paused, false);
    assert.equal(audio.currentTime, 7);
    for (let i = 0; i < 3; i++) {
      r.handle.disable();
      r.handle.disable();
      await flush();
      assert.equal(audio.paused, true);
      assert.equal(r.video.muted, false);
      if (captured) assert.equal(r.gains[0].gain.value, 1);
      r.video.currentTime += 5;
      r.handle.enable();
      await flush();
      assert.equal(audio.paused, false);
      assert.equal(audio.currentTime, r.video.currentTime);
      assert.equal(audio.muted, false);
      if (captured) assert.equal(r.gains[0].gain.value, 0);
      else assert.equal(r.video.muted, true);
    }
    assert.equal(r.counts.fetch, 1);
    assert.equal(r.counts.decode, 1);
    assert.equal(r.counts.urls, 1);
    assert.equal(r.elements.length, 1);
    assert.equal(r.revoked.length, 0);
    assert.equal(r.counts.captures, captured ? 1 : 0);
    assert.ok(r.traces.some((entry) => entry.event === 'enabled' && entry.details.cacheHit));
    r.handle.destroy(); r.handle.destroy();
    assert.deepEqual(r.revoked, ['blob:test-1']);
    assert.equal(r.video.muted, false);
    assert.equal(audio.removed, true);
  });
}

test('metadata readiness is awaited before seeking or starting audio', async (t) => {
  const r = setup(t, { metadata: false });
  await flush();
  const audio = r.elements[0];
  assert.equal(audio.playCalls, 0);
  assert.equal(r.video.muted, false, 'keep the original while metadata is pending');
  assert.equal(audio.currentTime, 0);
  assert.match(r.reports.at(-1).text, /等待音频播放器就绪/);
  audio.readyState = 4; audio.duration = 120;
  audio.dispatchEvent(new Event('loadedmetadata'));
  await flush();
  assert.equal(audio.currentTime, 7);
  assert.equal(audio.paused, false);
});

test('finishing decode while disabled never remutes or starts playback', async (t) => {
  const decoding = deferred();
  const r = setup(t, { decoding });
  await flush();
  r.handle.disable();
  const count = r.reports.length;
  decoding.resolve(r.decoded);
  await flush();
  assert.equal(r.video.muted, false);
  assert.equal(r.elements[0].playCalls, 0);
  assert.equal(r.reports.length, count);
  r.video.currentTime = 12;
  r.handle.enable();
  await flush();
  assert.equal(r.elements[0].currentTime, 12);
  assert.equal(r.elements[0].paused, false);
  assert.equal(r.counts.decode, 1);
});

test('destroy during decode suppresses stale completion and URL creation', async (t) => {
  const decoding = deferred();
  const r = setup(t, { decoding });
  await flush();
  r.handle.destroy();
  const count = r.reports.length;
  decoding.resolve(r.decoded);
  await flush();
  assert.equal(r.counts.urls, 0);
  assert.equal(r.elements[0].playCalls, 0);
  assert.equal(r.video.muted, false);
  assert.equal(r.reports.length, count);
});

test('autoplay rejection is explicit and does not repeatedly add play attempts', async (t) => {
  const r = setup(t, { play: () => Promise.reject(new DOMException('gesture needed', 'NotAllowedError')) });
  await flush();
  const audio = r.elements[0];
  assert.equal(r.reports.at(-1).state, 'blocked');
  assert.equal(r.video.muted, false, 'autoplay rejection must leave original sound available');
  for (let i = 0; i < 5; i++) r.video.dispatchEvent(new Event('timeupdate'));
  await flush();
  assert.equal(audio.playCalls, 1);
  r.setPlay(null);
  r.document.dispatchEvent(new Event('pointerdown'));
  await flush();
  assert.equal(audio.playCalls, 2);
  assert.equal(audio.paused, false);
  assert.ok(r.traces.some((entry) => entry.event === 'play-rejected' && entry.details.error.name === 'NotAllowedError'));
});

test('a real playback error is not mislabeled as autoplay blocking', async (t) => {
  const r = setup(t, { play: () => Promise.reject(new DOMException('bad media', 'NotSupportedError')) });
  await flush();
  assert.equal(r.reports.at(-1).state, 'error');
  assert.equal(r.video.muted, false);
  assert.match(r.reports.at(-1).text, /NotSupportedError/);
  r.handle.disable();
  r.setPlay(null);
  r.handle.enable();
  await flush();
  assert.equal(r.elements[0].paused, false);
  assert.equal(r.counts.fetch, 1, 'reload the cached WAV, not the network track');
});

test('an old rejected play promise does not overwrite a later successful activation', async (t) => {
  const pending = deferred();
  const r = setup(t, { play: () => pending.promise });
  await flush();
  r.handle.disable();
  r.setPlay(null);
  r.handle.enable();
  await flush();
  const count = r.reports.length;
  pending.reject(new DOMException('old activation', 'NotAllowedError'));
  await flush();
  assert.equal(r.reports.length, count);
  assert.equal(r.elements[0].paused, false);
});

test('a late successful play is paused again if restoration was turned off', async (t) => {
  const pending = deferred();
  const r = setup(t, { play: (audio) => pending.promise.then(() => { audio.paused = false; }) });
  await flush();
  r.handle.disable();
  pending.resolve();
  await flush();
  assert.equal(r.elements[0].paused, true);
  assert.equal(r.video.muted, false);
});

test('the original mute intent and current volume survive repeated toggles', async (t) => {
  const r = setup(t, { muted: true });
  await flush();
  assert.equal(r.elements[0].muted, true);
  r.handle.disable();
  assert.equal(r.video.muted, true);
  r.video.muted = false;
  r.video.volume = 0.4;
  r.handle.enable();
  await flush();
  assert.equal(r.elements[0].muted, false);
  assert.equal(r.elements[0].volume, 0.4);
});

for (const captured of [false, true]) {
  test(`decode failure retains original output and permits retry (capture=${captured})`, async (t) => {
    const decoding = deferred();
    const r = setup(t, { captured, decoding });
    await flush();
    assert.equal(r.video.muted, false);
    assert.equal(r.counts.captures, 0, 'never reroute the original during preparation');
    decoding.reject(new DOMException('bad audio data', 'EncodingError'));
    await flush();
    assert.equal(r.video.muted, false);
    assert.equal(r.counts.captures, 0);
    assert.equal(r.reports.at(-1).state, 'error');
    assert.match(r.reports.at(-1).text, /已恢复原声（未还原）.*EncodingError/);
    assert.ok(r.traces.some(({ event, details }) => event === 'prepare-error' && details.stage === 'decode'));
    decoding.promise = Promise.resolve(r.decoded);
    r.handle.enable();
    await flush();
    assert.equal(r.counts.decode, 2);
    assert.equal(r.elements[0].paused, false);
    assert.equal(r.handle.mode, captured ? 'captured' : 'muted');
  });

  test(`media error hands back original and explicit retry reuses WAV (capture=${captured})`, async (t) => {
    const r = setup(t, { captured });
    await flush();
    const audio = r.elements[0];
    audio.error = { code: 3, message: 'decode failed' };
    audio.dispatchEvent(new Event('error'));
    await flush();
    assert.equal(audio.paused, true);
    assert.equal(r.video.muted, false);
    if (captured) assert.equal(r.gains[0].gain.value, 1);
    assert.match(r.reports.at(-1).text, /已恢复原声/);
    for (let i = 0; i < 4; i++) r.video.dispatchEvent(new Event('timeupdate'));
    await flush();
    assert.equal(audio.playCalls, 1);
    audio.error = null;
    r.handle.enable();
    await flush();
    assert.equal(audio.paused, false);
    assert.equal(r.counts.decode, 1);
    assert.equal(r.counts.fetch, 1);
  });
}

test('handoff waits for the replacement play promise, not just a prepared WAV', async (t) => {
  const pending = deferred();
  const r = setup(t, { play: (audio) => pending.promise.then(() => { audio.paused = false; }) });
  await flush();
  assert.equal(r.video.muted, false);
  assert.equal(r.handle.mode, 'inactive');
  pending.resolve();
  await flush();
  assert.equal(r.video.muted, true);
  assert.equal(r.elements[0].muted, false);
  assert.equal(r.handle.mode, 'muted');
});

test('suspended Web Audio context falls back without capturing the video clock', async (t) => {
  const r = setup(t, { captured: true, contextState: 'suspended' });
  await flush();
  assert.equal(r.counts.captures, 0);
  assert.equal(r.handle.mode, 'muted');
  assert.equal(r.elements[0].paused, false);
  r.handle.disable();
  assert.equal(r.video.muted, false);
});

test('decode failure preserves an intentionally muted original', async (t) => {
  const decoding = deferred();
  const r = setup(t, { decoding, muted: true });
  await flush();
  decoding.reject(new DOMException('bad audio data', 'EncodingError'));
  await flush();
  assert.equal(r.video.muted, true);
  assert.equal(r.elements[0].playCalls, 0);
});
