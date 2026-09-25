import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createIntroReader } from '../src/intro.js';

const header = { width: 2560, height: 1370, tile: 32, margin: 0, invert: false, audioMs: 250, seed: null };
const flush = () => new Promise((resolve) => setImmediate(resolve));

function setup(t, { time = 20, auto = true, accept = () => true, signal } = {}) {
  const video = Object.assign(new EventTarget(), { currentTime: time, readyState: 1, seeking: false, paused: true });
  const calls = [];
  const applied = [];
  const states = [];
  let current = true;
  const reader = createIntroReader(video, {
    enabled: () => auto, isCurrent: () => current, decode: () => null, signal,
    scan: (_video, options) => new Promise((resolve, reject) => calls.push({ options, resolve, reject })),
    onHeader: (value) => { applied.push(value); return accept(value); },
    report: (state, error) => states.push({ state, error }),
  });
  t.after(() => reader.stop());
  return { video, calls, applied, states, reader,
    emit: (name) => video.dispatchEvent(new Event(name)),
    setAuto: (value) => { auto = value; },
    setCurrent: (value) => { current = value; },
  };
}

test('join midway, rewind with HAVE_METADATA, then decode without another loadeddata', async (t) => {
  const r = setup(t);
  r.emit('play');
  assert.equal(r.calls.length, 0);
  r.video.currentTime = 0;
  r.video.seeking = true;
  r.emit('seeking');
  r.video.seeking = false;
  r.emit('seeked');
  assert.equal(r.video.readyState, 1);
  assert.equal(r.calls.length, 1, 'start a bounded scanner while waiting for frame data');
  r.video.readyState = 2;
  r.emit('canplay');
  r.emit('playing');
  r.emit('timeupdate');
  assert.equal(r.calls.length, 1, 'coalesce the readiness event burst');
  assert.equal(r.calls[0].options.signal.aborted, false);
  r.calls[0].resolve(header);
  await flush();
  assert.deepEqual(r.applied, [header]);
  assert.equal(r.states.at(-1).state, 'found');
  assert.equal(r.video.currentTime, 0, 'never move the playhead');
});

test('canplay alone can start scanning after buffering at the intro', async (t) => {
  const r = setup(t);
  r.video.currentTime = 0.2;
  r.video.readyState = 2;
  r.emit('canplay');
  assert.equal(r.calls.length, 1);
  r.calls[0].resolve(header);
  await flush();
  assert.equal(r.applied.length, 1);
});

test('a no-result visit stops polling but frame readiness and a rewind allow retry', async (t) => {
  const r = setup(t, { time: 0 });
  r.calls[0].resolve(null);
  await flush();
  for (let i = 0; i < 10; i++) r.emit('timeupdate');
  assert.equal(r.calls.length, 1);
  r.video.readyState = 2;
  r.emit('canplay');
  assert.equal(r.calls.length, 2, 'buffering outlasting the scanner deadline is recoverable');
  r.calls[1].resolve(null);
  await flush();
  r.emit('seeking');
  r.emit('seeked');
  assert.equal(r.calls.length, 3);
  r.calls[2].resolve(header);
  await flush();
  assert.equal(r.applied.length, 1);
});

test('seeking away cancels and stale scan results never override a later run', async (t) => {
  const r = setup(t, { time: 0 });
  r.video.currentTime = 8;
  r.emit('seeking');
  r.emit('seeked');
  assert.equal(r.calls[0].options.signal.aborted, true);
  r.video.currentTime = 0;
  r.emit('seeking');
  r.emit('seeked');
  assert.equal(r.calls.length, 2);
  r.calls[0].resolve({ ...header, seed: 123n });
  await flush();
  assert.equal(r.applied.length, 0);
  r.calls[1].resolve(header);
  await flush();
  assert.deepEqual(r.applied, [header]);
});

test('success is latched only after settings are accepted', async (t) => {
  let valid = false;
  const r = setup(t, { time: 0, accept: () => valid });
  r.calls[0].resolve(header);
  await flush();
  assert.equal(r.states.at(-1).state, 'error');
  valid = true;
  r.emit('seeked');
  r.calls[1].resolve(header);
  await flush();
  r.emit('canplay');
  r.emit('seeked');
  assert.equal(r.calls.length, 2, 'accepted headers are not repeatedly applied');
});

test('source replacement clears success and aborted work, even on the same video', async (t) => {
  const r = setup(t, { time: 0 });
  r.calls[0].resolve(header);
  await flush();
  r.emit('emptied');
  r.emit('loadeddata');
  assert.equal(r.calls.length, 2);
  r.emit('loadstart');
  assert.equal(r.calls[1].options.signal.aborted, true);
  r.emit('canplay');
  assert.equal(r.calls.length, 3);
  r.calls[1].resolve({ ...header, seed: 999n });
  r.calls[2].resolve(header);
  await flush();
  assert.deepEqual(r.applied, [header, header]);
});

test('manual retry scans the displayed frame even with auto disabled or outside the intro', async (t) => {
  const r = setup(t, { auto: false, time: 30 });
  r.emit('canplay');
  assert.equal(r.calls.length, 0);
  const done = r.reader.request({ manual: true });
  assert.equal(r.calls[0].options.untilSeconds, Infinity);
  r.emit('timeupdate');
  r.emit('playing');
  assert.equal(r.states.at(-1).state, 'scanning', 'auto-off events do not hide a manual scan');
  r.calls[0].resolve(header);
  assert.equal(await done, true);
  assert.deepEqual(r.applied, [header]);
  assert.equal(r.video.currentTime, 30);
});

test('turning off automatic scanning cancels in-flight auto work', async (t) => {
  const r = setup(t, { time: 0 });
  r.setAuto(false);
  r.reader.reset();
  await r.reader.request();
  assert.equal(r.calls[0].options.signal.aborted, true);
  r.calls[0].resolve(header);
  await flush();
  assert.equal(r.applied.length, 0);
  assert.equal(r.states.at(-1).state, 'off');
});

test('page changes and disposal discard late results', async (t) => {
  const r = setup(t, { time: 0 });
  r.setCurrent(false);
  r.calls[0].resolve(header);
  await flush();
  assert.equal(r.applied.length, 0);
  r.setCurrent(true);
  r.emit('seeked');
  r.reader.stop();
  r.calls[1].resolve(header);
  await flush();
  r.emit('seeked');
  assert.equal(r.calls.length, 2);
  assert.equal(r.applied.length, 0);
});

test('parent cancellation removes event listeners and prevents applying a header', async (t) => {
  const controller = new AbortController();
  const r = setup(t, { time: 0, signal: controller.signal });
  controller.abort();
  assert.equal(r.calls[0].options.signal.aborted, true);
  r.calls[0].resolve(header);
  await flush();
  r.emit('canplay');
  assert.equal(r.applied.length, 0);
  assert.equal(r.calls.length, 1);
});

test('an already-cancelled owner never starts scanning or registers live callbacks', (t) => {
  const controller = new AbortController();
  controller.abort();
  const r = setup(t, { time: 0, signal: controller.signal });
  r.emit('canplay');
  assert.equal(r.calls.length, 0);
});

test('manual retry supersedes a pending scan without applying its late result', async (t) => {
  const r = setup(t, { time: 0 });
  const done = r.reader.request({ manual: true });
  assert.equal(r.calls[0].options.signal.aborted, true);
  r.calls[0].resolve({ ...header, seed: 99n });
  r.calls[1].resolve(header);
  assert.equal(await done, true);
  assert.deepEqual(r.applied, [header]);
});

test('scanner errors are reported rather than silently ignored', async (t) => {
  const r = setup(t, { time: 0 });
  const error = new Error('Canvas read blocked by CORS');
  r.calls[0].reject(error);
  await flush();
  assert.equal(r.states.at(-1).state, 'error');
  assert.equal(r.states.at(-1).error, error);
  const done = r.reader.request({ manual: true });
  r.calls[1].resolve(header);
  assert.equal(await done, true);
});
