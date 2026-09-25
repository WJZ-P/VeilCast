import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDiagnostics, introVideoState } from '../src/diagnostics.js';

test('diagnostics are versioned, bounded snapshots, not live objects', () => {
  const output = [];
  const logger = createDiagnostics({ version: 'test', capacity: 2, now: () => 'fixed', sink: { info: (...args) => output.push(args) } });
  const details = { readyState: 1 };
  logger.log('first', details);
  details.readyState = 4;
  assert.ok(logger.dump().includes('"readyState":1'));
  logger.log('second');
  logger.log('third');
  assert.ok(!logger.dump().includes('"event":"first"'));
  assert.ok(logger.dump().includes('"sequence":3'));
  assert.match(output[0][0], /VeilCast test/);
  assert.equal(JSON.parse(output[0][1]).readyState, 1);
});

test('seeds, QR payloads, signed URLs and media buffers are redacted', () => {
  const logger = createDiagnostics({ sink: {} });
  logger.log('failure', {
    seed: 'private-seed', hasSeed: true,
    nested: { token: 'private-token', rawText: '01234567890123456789012345678901234567890123' },
    src: 'blob:https://example.com/private', imageData: [1, 2, 3],
    error: new Error('Fetch https://cdn.example.com/audio.m4s?token=private-url failed'),
  });
  const dump = logger.dump();
  for (const forbidden of ['private-seed', 'private-token', 'private-url', 'cdn.example.com', '0123456789']) assert.ok(!dump.includes(forbidden));
  assert.ok(dump.includes('"hasSeed":true'));
  assert.ok(dump.includes('[redacted]'));
});

test('console failures do not affect caller control flow', () => {
  const logger = createDiagnostics({ sink: { info: () => { throw new Error('console blocked'); } } });
  assert.doesNotThrow(() => logger.log('still-recorded'));
  assert.ok(logger.dump().includes('still-recorded'));
});

test('media snapshots identify the source kind but never expose its URL', () => {
  const state = introVideoState({ currentSrc: 'blob:https://example.com/private', currentTime: 0.5,
    readyState: 2, paused: true, seeking: false, videoWidth: 1920, videoHeight: 1080, isConnected: true });
  assert.equal(state.sourceKind, 'blob');
  assert.equal(state.readyState, 2);
  assert.ok(!JSON.stringify(state).includes('example.com'));
});
