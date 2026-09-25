import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { Script } from 'node:vm';
import {
  validateSettings, querySettings, descriptionSettings, videoPageKey,
  pageSettings, rememberPageSettings, forgetPageSettings, userscriptDefaults,
} from '../src/settings.js';
import { pickAudioUrl } from '../src/audio.js';

const defaults = userscriptDefaults(JSON.parse(await readFile(new URL('../../app/src/default-settings.json', import.meta.url), 'utf8')));

test('defaults come from the same JSON as the Tauri app', async () => {
  const params = validateSettings({}, defaults);
  assert.deepEqual(params, { width: 720, height: 1280, tile: 40, margin: 0, seed: '20040821', invert: false, autoIntro: true, audioMs: 0, audioMirror: false });
  const app = await readFile(new URL('../../app/src/App.tsx', import.meta.url), 'utf8');
  assert.match(app, /import defaultSettings from "\.\/default-settings\.json"/);
});

test('tail is a tile alias; explicit tile wins', () => {
  assert.equal(validateSettings({ tail: '16' }, defaults).tile, 16);
  assert.equal(validateSettings({ tile: 40, tail: 16 }, defaults).tile, 40);
  assert.deepEqual(querySettings('?seed=other&vc_seed=%2B007&vc_tail=16&vc_margin=4'), { seed: '+007', tile: '16', margin: '4' });
  assert.deepEqual(querySettings('?vc_tile=40&vc_tail=16'), { tile: '40' });
  assert.equal(validateSettings({ ...defaults, ...querySettings('?vc_tail=16') }, defaults).tile, 16);
});

test('text seeds keep whitespace, Unicode, empty values and full u64 precision', () => {
  for (const seed of ['', ' 密码\n', '18446744073709551615', '+007']) {
    assert.equal(validateSettings({ seed }, defaults).seed, seed);
  }
  assert.throws(() => validateSettings({ seed: 2 ** 64 }, defaults), /文本/);
  assert.throws(() => validateSettings({ seed: 'x'.repeat(4097) }, defaults), /4096/);
});

test('reject malformed and excessive geometry before allocating GPU data', () => {
  for (const value of ['', '  ', 'not a number', Infinity, NaN, -1, 0.5, true, [], {}, 2 ** 53]) {
    assert.throws(() => validateSettings({ tile: value }, defaults));
  }
  for (const params of [{ tile: 0 }, { tile: 3 }, { margin: 1 }, { width: 0 }, { margin: 16385 },
    { width: 4096, height: 4096, tile: 2 }, { width: 16384, height: 16384 }]) {
    assert.throws(() => validateSettings(params, defaults));
  }
  // Original sizes can require padding; tile and margin remain even.
  assert.equal(validateSettings({ width: 1366, height: 767 }, defaults).height, 767);
});

test('page identity changes for a new video or part, not a quality setting', () => {
  assert.equal(videoPageKey('https://www.bilibili.com/video/BVtest/?qn=80'), '/video/BVtest/?p=1');
  assert.equal(videoPageKey('https://www.bilibili.com/video/BVtest/?p=2'), '/video/BVtest/?p=2');
  assert.equal(videoPageKey('https://www.bilibili.com/'), null);
});

test('explicit description import matches the supplied video parameters', () => {
  const text = '原始宽2560，高1370 tile 16 margin 4 seed 20260916\n混淆前6M，混淆后60M，解码后19M';
  assert.deepEqual(validateSettings(descriptionSettings(text), defaults), {
    width: 2560, height: 1370, tile: 16, margin: 4, seed: '20260916', invert: false, autoIntro: true, audioMs: 0, audioMirror: false,
  });
  assert.equal(descriptionSettings('原始宽度: 720 高度：1280 tail=40 margin=0 seed=+007').seed, '+007');
});

test('description import requires every labelled field and validates before application', () => {
  for (const text of ['', '1920x1080 20260916', '原始宽720 高1280 tile40 margin0']) {
    assert.throws(() => descriptionSettings(text), /缺少明确/);
  }
  const oddTile = descriptionSettings('原始宽720 高1280 tile3 margin0 seed密码');
  assert.throws(() => validateSettings(oddTile, defaults), /偶数/);
});

test('installable artifact is standalone, scoped and contains current defaults', async () => {
  const bundle = await readFile(new URL('../veilcast.user.js', import.meta.url), 'utf8');
  new Script(bundle);
  assert.match(bundle, /@match\s+https:\/\/www\.bilibili\.com\/video\/\*/);
  assert.match(bundle, /@noframes/);
  assert.doesNotMatch(bundle, /@require|GM_xmlhttpRequest|unsafeWindow/);
  assert.ok(bundle.includes(`defaults: ${JSON.stringify(defaults)}`));
  assert.match(bundle, /createAudioRestorer/);
  // The QR decoder is bundled under a local shim, not exposed on the page.
  assert.ok(bundle.includes("const jsQR = (() => {"));
  assert.match(bundle, /scanIntro, decodeQr/);
});

test('inversion defaults to off and URL false is not truthy', () => {
  assert.equal(validateSettings({}, { ...defaults, invert: undefined }).invert, false);
  for (const [raw, expected] of [['1', true], ['true', true], ['0', false], ['false', false]]) {
    assert.equal(validateSettings(querySettings(`?vc_invert=${raw}`), defaults).invert, expected);
  }
  assert.equal(validateSettings({ invert: true }, defaults).invert, true);
  for (const invert of ['on', '', 'no', 1, 0, []]) assert.throws(() => validateSettings({ invert }, defaults), /invert/);
});

test('description inversion is optional; explicit invalid values are rejected', () => {
  const description = '宽720 高1280 tile40 margin0 seed42';
  assert.equal(descriptionSettings(description).invert, false);
  assert.equal(descriptionSettings(`${description} invert=1`).invert, true);
  assert.equal(descriptionSettings(`${description} 反色: true`).invert, true);
  assert.equal(descriptionSettings(`${description} invert=false`).invert, false);
  assert.throws(() => descriptionSettings(`${description} invert=2`), /invert/);
});

test('a page remembers only the plan, and the intro source is sticky', () => {
  const plan = { width: 720, height: 1280, tile: 40, margin: 0, seed: '9859592623650262946', invert: false, autoIntro: true };
  const key = '/video/BV1xx/?p=1';
  let pages = rememberPageSettings({}, key, plan, 'intro', { now: 1000 });
  assert.deepEqual(pageSettings(pages, key), {
    settings: { width: 720, height: 1280, tile: 40, margin: 0, seed: '9859592623650262946', invert: false },
    source: 'intro',
    savedAt: 1000,
  });
  // A seed typed by hand for the same video must not demote it to unverified.
  pages = rememberPageSettings(pages, key, { ...plan, seed: 'typed' }, 'manual', { now: 2000 });
  assert.deepEqual(pageSettings(pages, key), {
    settings: { width: 720, height: 1280, tile: 40, margin: 0, seed: 'typed', invert: false },
    source: 'intro',
    savedAt: 2000,
  });
  assert.equal(pageSettings(forgetPageSettings(pages, key), key), null);
  assert.deepEqual(rememberPageSettings({}, null, plan, 'intro'), {}, 'a non-video page stores nothing');
});

test('page memory is bounded and rejects unusable entries', () => {
  let pages = {};
  for (let i = 0; i < 60; i++) {
    pages = rememberPageSettings(pages, `/video/BV${i}/?p=1`, { width: 720, height: 1280, tile: 40, margin: 0, seed: String(i), invert: false }, 'manual', { limit: 50, now: i });
  }
  assert.equal(Object.keys(pages).length, 50);
  assert.equal(pageSettings(pages, '/video/BV9/?p=1'), null, 'oldest entries are evicted');
  assert.equal(pageSettings(pages, '/video/BV59/?p=1').settings.seed, '59');
  for (const broken of [null, {}, { '/video/BV1/?p=1': 7 }, { '/video/BV1/?p=1': { settings: {} } }]) {
    assert.equal(pageSettings(broken, '/video/BV1/?p=1'), null);
  }
  assert.equal(pageSettings({ a: { settings: { tile: 40 } } }, null), null);
  // An unknown source is never trusted as a verified page.
  assert.equal(pageSettings({ a: { settings: { tile: 40 }, source: 'guess' } }, 'a').source, 'manual');
});

test('audio block length: 0 is off, the desktop switch maps onto it', () => {
  assert.equal(validateSettings({ audioMs: '250' }, defaults).audioMs, 250);
  assert.equal(validateSettings({ audioMs: '' }, defaults).audioMs, 0);
  for (const bad of [-1, 10000, 2.5, 'x']) assert.throws(() => validateSettings({ audioMs: bad }, defaults), /音频块长/);
  const app = { width: 720, height: 1280, tile: 40, margin: 0, seed: 's', invert: false, audio: false, audioMs: 250 };
  assert.equal(userscriptDefaults(app).audioMs, 0);
  assert.equal(userscriptDefaults({ ...app, audio: true }).audioMs, 250);
  // A page remembers its block length with the rest of the plan.
  const pages = rememberPageSettings({}, '/video/BV1/?p=1', validateSettings({ audioMs: 250 }, defaults), 'intro');
  assert.equal(pageSettings(pages, '/video/BV1/?p=1').settings.audioMs, 250);
});

test('the audio mirror is a strict boolean; anything saved before it existed was reversal only', () => {
  const app = { width: 720, height: 1280, tile: 40, margin: 0, seed: 's', invert: false, audio: true, audioMs: 250, audioMirror: true };
  assert.equal(userscriptDefaults(app).audioMirror, true);
  assert.equal(userscriptDefaults({ ...app, audio: false }).audioMirror, false);
  assert.equal(validateSettings({ audioMirror: 'true' }, defaults).audioMirror, true);
  assert.equal(validateSettings({ audioMirror: false }, { ...defaults, audioMirror: true }).audioMirror, false);
  for (const bad of ['on', 1, 'yes']) assert.throws(() => validateSettings({ audioMirror: bad }, defaults), /频谱翻转/);
  const mirrored = rememberPageSettings({}, '/video/BV2/?p=1', validateSettings({ audioMs: 250, audioMirror: true }, defaults), 'intro');
  assert.equal(pageSettings(mirrored, '/video/BV2/?p=1').settings.audioMirror, true);
  const legacy = { '/video/BV3/?p=1': { settings: { width: 720, height: 1280, tile: 40, margin: 0, seed: 's', invert: false, audioMs: 50 }, source: 'intro' } };
  assert.equal(pageSettings(legacy, '/video/BV3/?p=1').settings.audioMirror, false);
});

test('the audio track is the latest Bilibili audio request since navigation', () => {
  const entry = (name, startTime) => ({ name, startTime });
  const entries = [
    entry('https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/1/2/111/111-1-30280.m4s?e=old', 100),
    entry('https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/1/2/111/111-1-30080.m4s?e=video', 150),
    entry('https://xy1x2x3x4xy.mcdn.bilivideo.cn:4483/upgcxcode/3/4/222/222-1-30232.m4s?e=new', 900),
    entry('https://s1.hdslb.com/bfs/static/player/main.js', 950),
  ];
  assert.match(pickAudioUrl(entries), /222-1-30232\.m4s/);
  assert.match(pickAudioUrl(entries, { since: 0 }), /e=new/);
  assert.equal(pickAudioUrl(entries, { since: 1000 }), null, 'nothing fetched since navigating');
  assert.match(pickAudioUrl(entries.slice(0, 2)), /111-1-30280/, 'video streams never match');
  assert.equal(pickAudioUrl([entry('https://example.com/a-30280.m4s.bak', 1)]), null);
});
