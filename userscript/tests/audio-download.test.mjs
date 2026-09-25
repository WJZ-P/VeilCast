import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchAudioFile, inspectAudioBytes } from '../src/audio.js';

const join = (...parts) => Buffer.concat(parts);
function box(type, ...parts) {
  const body = join(...parts);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length);
  head.write(type, 4, 4, 'ascii');
  return join(head, body);
}
const arrayBuffer = (buffer) => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
const full = join(box('ftyp'), box('moov', box('trak', box('mdia', box('minf', box('stbl',
  box('stsd', Buffer.alloc(8), box('mp4a', Buffer.alloc(28)))))))), box('moof'), box('mdat', Buffer.alloc(12)));
const fragment = join(box('moof'), box('mdat', Buffer.alloc(12)));
function response(bytes, { status = 200, type = 'audio/mp4', range } = {}) {
  return new Response(bytes, { status, headers: { 'content-type': type, ...(range ? { 'content-range': range } : {}) } });
}

test('container inspection finds MP4 init, fragments and audio codec without exposing payload', () => {
  const info = inspectAudioBytes(arrayBuffer(full));
  assert.deepEqual(info, { format: 'mp4', bytes: full.length, boxes: ['ftyp', 'moov', 'moof', 'mdat'],
    codecs: ['mp4a'], hasMoov: true, hasMoof: true, truncated: false, limitedInspection: false, fragmentWithoutInit: false });
  assert.equal(inspectAudioBytes(arrayBuffer(fragment)).fragmentWithoutInit, true);
  assert.equal(inspectAudioBytes(arrayBuffer(full.subarray(0, -1))).truncated, true);
  assert.equal(inspectAudioBytes(new ArrayBuffer(0)).format, 'unknown');
});

test('handles extended box size, to-end size and malformed box lengths', () => {
  const extended = Buffer.alloc(16);
  extended.writeUInt32BE(1); extended.write('moov', 4); extended.writeUInt32BE(16, 12);
  assert.equal(inspectAudioBytes(arrayBuffer(extended)).hasMoov, true);
  extended.writeUInt32BE(0xffffffff, 8);
  assert.equal(inspectAudioBytes(arrayBuffer(extended)).truncated, true);
  const toEnd = box('mdat', Buffer.alloc(16)); toEnd.writeUInt32BE(0);
  assert.equal(inspectAudioBytes(arrayBuffer(toEnd)).truncated, false);
  toEnd.writeUInt32BE(4);
  assert.equal(inspectAudioBytes(arrayBuffer(toEnd)).truncated, true);
});

test('inspection has a bounded box budget rather than declaring uninspected data incomplete', () => {
  const many = join(...Array.from({ length: 520 }, () => box('free')), full);
  const info = inspectAudioBytes(arrayBuffer(many));
  assert.equal(info.limitedInspection, true);
  assert.equal(info.truncated, false);
  assert.ok(info.boxes.length <= 16);
});

test('complete 200 and full-file 206 responses need only one request', async () => {
  for (const status of [200, 206]) {
    const requests = [];
    const bytes = await fetchAudioFile('https://example.invalid/audio', { request: async (...args) => {
      requests.push(args);
      return response(full, { status, range: `bytes 0-${full.length - 1}/${full.length}` });
    } });
    assert.equal(requests.length, 1);
    assert.deepEqual(Buffer.from(bytes), full);
  }
});

test('partial response retries once with an open-ended range', async () => {
  const requests = [], events = [];
  const bytes = await fetchAudioFile('https://example.invalid/audio', { trace: (event) => events.push(event),
    request: async (url, options) => {
      requests.push(options);
      return requests.length === 1 ? response(fragment, { status: 206, range: `bytes 40-${39 + fragment.length}/500` }) : response(full);
    } });
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1].headers, { Range: 'bytes=0-' });
  assert.ok(events.includes('download-full-retry'));
  assert.deepEqual(Buffer.from(bytes), full);
});

test('rejects repeated partial response even if those bytes contain valid MP4 boxes', async () => {
  let calls = 0;
  await assert.rejects(fetchAudioFile('fixture', { request: async () => {
    calls++;
    return response(full, { status: 206, range: `bytes 0-${full.length - 1}/${full.length + 100}` });
  } }), /不完整/);
  assert.equal(calls, 2);
});

test('fragment without init and truncated 200 responses get one retry then a useful error', async () => {
  for (const bytes of [fragment, full.subarray(0, -3)]) {
    let calls = 0;
    await assert.rejects(fetchAudioFile('fixture', { request: async () => { calls++; return response(bytes); } }), /初始化信息|不完整/);
    assert.equal(calls, 2);
  }
});

test('hidden Content-Range triggers one retry but does not prove a complete container is bad', async () => {
  let calls = 0;
  const bytes = await fetchAudioFile('fixture', { request: async () => { calls++; return response(full, { status: 206 }); } });
  assert.equal(calls, 2);
  assert.deepEqual(Buffer.from(bytes), full);
});

test('HTTP errors and server error pages fail without feeding them to the decoder', async () => {
  for (const options of [{ status: 403 }, { type: 'text/html' }, { type: 'application/json' }]) {
    let calls = 0;
    await assert.rejects(fetchAudioFile('fixture', { request: async () => { calls++; return response('{}', options); } }), /HTTP 403|非音频内容/);
    assert.equal(calls, 1);
  }
});

test('aborts before requesting and during download without a retry', async () => {
  const before = new AbortController(); before.abort();
  await assert.rejects(fetchAudioFile('fixture', { signal: before.signal, request: () => assert.fail('must not fetch') }), { name: 'AbortError' });
  const during = new AbortController();
  let calls = 0;
  await assert.rejects(fetchAudioFile('fixture', { signal: during.signal, request: async (url, options) => {
    calls++;
    assert.equal(options.signal, during.signal);
    return { ok: true, status: 200, arrayBuffer: async () => { during.abort(); return arrayBuffer(full); } };
  } }), { name: 'AbortError' });
  assert.equal(calls, 1);
});

test('diagnostic sink failure does not break a successful download', async () => {
  const bytes = await fetchAudioFile('fixture', { trace() { throw new Error('console failure'); }, request: async () => response(full) });
  assert.deepEqual(Buffer.from(bytes), full);
});
