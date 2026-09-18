// Run with: node --test viewer/*.test.mjs
// The known-answer vectors are shared with tests/permutation.rs; both sides
// must agree or the browser cannot restore what the Rust side scrambled.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { planGeometry, seedFromText, seededPermutation } from './veilcast.js';

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
  assert.equal(seedFromText('18446744073709551615'), 2n ** 64n - 1n);
  assert.equal(seedFromText(''), 0xcbf29ce484222325n);
  assert.equal(seedFromText('a'), 0xaf63dc4c8601ec8cn);
  assert.equal(seedFromText('veilcast'), 0x88d44f40babc4fa2n);
  assert.equal(seedFromText('密码'), 0x0e4025f70675fc15n);
  assert.equal(seedFromText('-1'), 0x07d00b07b497d12bn);
  assert.equal(seedFromText('18446744073709551616'), 0xedf2aa6b38fc416dn);
});
