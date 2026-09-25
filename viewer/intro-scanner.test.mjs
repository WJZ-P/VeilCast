import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scanIntro } from './veilcast.js';

const digits = '0125601370040001025073';

function setup(t, { contextMissing = false, readError = null } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const calls = { canvases: 0, draws: 0, decodes: 0 };
  const context = {
    drawImage: (video) => { assert.equal(video.seeking, false); calls.draws++; },
    getImageData: () => { if (readError) throw readError; return { data: new Uint8ClampedArray(4), width: 1, height: 1 }; },
  };
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    createElement: () => { calls.canvases++; return { getContext: () => contextMissing ? null : context }; },
  } });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'document', previous);
    else delete globalThis.document;
  });
  return {
    calls,
    video: { currentTime: 0, readyState: 1, videoWidth: 640, videoHeight: 360, seeking: false, ended: false, paused: true },
    decode: () => { calls.decodes++; return digits; },
  };
}

test('waits for a readable frame after seek, including while paused', async (t) => {
  const r = setup(t);
  const result = scanIntro(r.video, { decode: r.decode });
  assert.equal(r.calls.draws, 0);
  t.mock.timers.tick(100);
  assert.equal(r.calls.draws, 0);
  r.video.readyState = 2;
  t.mock.timers.tick(100);
  assert.equal((await result).audioMs, 250);
  assert.equal(r.calls.draws, 1);
});

test('never decodes the previous frame while video.seeking is true', async (t) => {
  const r = setup(t);
  r.video.readyState = 2;
  r.video.seeking = true;
  const result = scanIntro(r.video, { decode: r.decode });
  t.mock.timers.tick(200);
  assert.equal(r.calls.draws, 0);
  r.video.seeking = false;
  t.mock.timers.tick(100);
  assert.equal((await result).width, 2560);
});

test('pre-aborted scans allocate no canvas and do not decode', async (t) => {
  const r = setup(t);
  const controller = new AbortController();
  controller.abort();
  assert.equal(await scanIntro(r.video, { decode: r.decode, signal: controller.signal }), null);
  assert.equal(r.calls.canvases, 0);
});

test('abort stops the retry timer, even if a new frame becomes ready later', async (t) => {
  const r = setup(t);
  const controller = new AbortController();
  const result = scanIntro(r.video, { decode: r.decode, signal: controller.signal });
  controller.abort();
  r.video.readyState = 2;
  t.mock.timers.tick(6000);
  assert.equal(await result, null);
  assert.equal(r.calls.decodes, 0);
});

test('outside-intro frames are rejected before drawing, manual scanning can opt in', async (t) => {
  const r = setup(t);
  r.video.readyState = 2;
  r.video.currentTime = 30;
  assert.equal(await scanIntro(r.video, { decode: r.decode }), null);
  assert.equal(r.calls.draws, 0);
  assert.equal((await scanIntro(r.video, { decode: r.decode, untilSeconds: Infinity })).audioMs, 250);
});

test('no-frame buffering and ordinary QR codes have a bounded deadline', async (t) => {
  const r = setup(t);
  const buffered = scanIntro(r.video, { decode: r.decode });
  t.mock.timers.tick(5000);
  assert.equal(await buffered, null);
  assert.equal(r.calls.draws, 0);
  r.video.readyState = 2;
  const ordinary = scanIntro(r.video, { decode: () => 'https://example.com/' });
  t.mock.timers.tick(5000);
  assert.equal(await ordinary, null);
});

test('Canvas/CORS failures reject with a diagnosable error', async (t) => {
  const error = new Error('Canvas read blocked');
  const r = setup(t, { readError: error });
  r.video.readyState = 2;
  await assert.rejects(scanIntro(r.video, { decode: r.decode }), error);
  t.mock.timers.tick(5000);
  assert.equal(r.calls.draws, 1);
});

test('missing Canvas 2D context reports a clear error', async (t) => {
  const r = setup(t, { contextMissing: true });
  await assert.rejects(scanIntro(r.video, { decode: r.decode }), /Canvas 2D/);
});

test('progress distinguishes readable pixels, QR detection and a valid header without raw data', async (t) => {
  const r = setup(t);
  r.video.readyState = 2;
  const events = [];
  const payload = '012560137004000102500985959262365026294691';
  await scanIntro(r.video, { decode: () => payload, onProgress: (event, details) => events.push({ event, details }) });
  for (const event of ['begin', 'frame-read', 'qr-detected', 'header-valid', 'stop']) assert.ok(events.some((entry) => entry.event === event), event);
  assert.equal(events.at(-1).details.reason, 'found');
  assert.ok(!JSON.stringify(events).includes(payload));
  assert.ok(!JSON.stringify(events).includes('9859592623650262946'));
});

test('timeout diagnostics distinguish missing QR from an invalid header', async (t) => {
  const r = setup(t);
  r.video.readyState = 2;
  const events = [];
  const scan = scanIntro(r.video, { decode: () => 'not-a-veilcast-header', onProgress: (event, details) => events.push({ event, details }) });
  t.mock.timers.tick(5000);
  await scan;
  assert.ok(events.some((entry) => entry.event === 'header-rejected'));
  assert.equal(events.at(-1).details.reason, 'timeout');
  assert.equal(events.at(-1).details.invalidHeaders, 1);
});

test('pixel read errors identify the failing stage', async (t) => {
  const r = setup(t, { readError: new Error('tainted canvas') });
  r.video.readyState = 2;
  const events = [];
  await assert.rejects(scanIntro(r.video, { decode: r.decode, onProgress: (event, details) => events.push({ event, details }) }));
  assert.equal(events.at(-1).event, 'error');
  assert.equal(events.at(-1).details.stage, 'read-pixels');
});

test('a failing progress listener never changes decoding results', async (t) => {
  const r = setup(t);
  r.video.readyState = 2;
  const header = await scanIntro(r.video, { decode: r.decode, onProgress: () => { throw new Error('diagnostic failure'); } });
  assert.equal(header.width, 2560);
});

test('a paused legacy QR is accepted and its layout is identified in diagnostics', async (t) => {
  const r = setup(t);
  r.video.readyState = 2;
  const events = [];
  const header = await scanIntro(r.video, { decode: () => '012560137004000145', onProgress: (event, details) => events.push({ event, details }) });
  assert.equal(header.audioMs, 0);
  assert.equal(events.find((entry) => entry.event === 'header-valid').details.format, 'v1-legacy');
});
