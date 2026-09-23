import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const root = new URL('../../', import.meta.url);
const read = (path) => readFile(new URL(path, root));
const signature = Buffer.from('89504e470d0a1a0a', 'hex');

function pngSize(bytes) {
  assert.deepEqual(bytes.subarray(0, 8), signature, 'PNG signature');
  assert.equal(bytes.toString('ascii', 12, 16), 'IHDR');
  assert.equal(bytes[25], 6, 'RGBA format retains transparency');
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

test('the icon master preserves the selected v2 artwork unchanged', async () => {
  const master = await read('assets/branding/veilcast-icon.png');
  assert.deepEqual(master, await read('assets/branding/veilcast-icon-concept-v2.png'));
  const [width, height] = pngSize(master);
  assert.equal(width, height);
  assert.ok(width >= 512);
});

test('desktop PNG variants have the expected sizes and alpha channel', async () => {
  const sizes = {
    '32x32.png': 32, '64x64.png': 64, '128x128.png': 128, '128x128@2x.png': 256,
    'Square30x30Logo.png': 30, 'Square44x44Logo.png': 44, 'Square71x71Logo.png': 71,
    'Square89x89Logo.png': 89, 'Square107x107Logo.png': 107, 'Square142x142Logo.png': 142,
    'Square150x150Logo.png': 150, 'Square284x284Logo.png': 284, 'Square310x310Logo.png': 310,
    'StoreLogo.png': 50,
  };
  for (const [name, size] of Object.entries(sizes)) {
    assert.deepEqual(pngSize(await read(`app/src-tauri/icons/${name}`)), [size, size], name);
  }
  const [width, height] = pngSize(await read('app/src-tauri/icons/icon.png'));
  assert.equal(width, height);
  assert.ok(width >= 256);
});

test('ICO and ICNS contain valid bounded image entries', async () => {
  const ico = await read('app/src-tauri/icons/icon.ico');
  assert.equal(ico.readUInt16LE(0), 0);
  assert.equal(ico.readUInt16LE(2), 1);
  const count = ico.readUInt16LE(4);
  assert.ok(count > 1);
  const sizes = [];
  for (let i = 0; i < count; i++) {
    const offset = 6 + i * 16;
    const width = ico[offset] || 256;
    assert.equal(width, ico[offset + 1] || 256);
    const length = ico.readUInt32LE(offset + 8);
    const start = ico.readUInt32LE(offset + 12);
    assert.ok(length > 0 && start >= 6 + count * 16 && start + length <= ico.length);
    sizes.push(width);
  }
  for (const size of [16, 32, 256]) assert.ok(sizes.includes(size), `ICO includes ${size}px`);

  const icns = await read('app/src-tauri/icons/icon.icns');
  assert.equal(icns.toString('ascii', 0, 4), 'icns');
  assert.equal(icns.readUInt32BE(4), icns.length);
  let offset = 8;
  while (offset < icns.length) {
    const length = icns.readUInt32BE(offset + 4);
    assert.ok(length >= 8 && offset + length <= icns.length);
    offset += length;
  }
  assert.equal(offset, icns.length);
});

test('the app favicon and title use the same icon as the script toolbar', async () => {
  const icon = await read('app/src-tauri/icons/64x64.png');
  assert.deepEqual(await read('app/public/icon.png'), icon);
  assert.match((await read('app/index.html')).toString(), /rel="icon"[^>]+href="\/icon\.png"/);
  assert.match((await read('app/src/App.tsx')).toString(), /<img src="\/icon\.png"/);
});

test('userscript metadata and toolbar embed the generated PNGs without a remote URL', async () => {
  const bundle = (await read('userscript/veilcast.user.js')).toString();
  for (const [field, file, size] of [['icon', '32x32.png', 32], ['icon64', '64x64.png', 64]]) {
    const match = bundle.match(new RegExp(`^// @${field}\\s+(data:image/png;base64,([A-Za-z0-9+/=]+))\\r?$`, 'm'));
    assert.ok(match, field);
    const bytes = Buffer.from(match[2], 'base64');
    assert.deepEqual(pngSize(bytes), [size, size]);
    assert.deepEqual(bytes, await read(`app/src-tauri/icons/${file}`));
    if (field === 'icon64') assert.ok(bundle.includes(`iconUrl: ${JSON.stringify(match[1])}`));
  }
  const main = (await read('userscript/src/main.js')).toString();
  assert.match(main, /<img id="brand-icon"/);
  assert.match(main, /brandIcon\.src = iconUrl/);
});

test('every icon in the Tauri configuration exists', async () => {
  const config = JSON.parse(await read('app/src-tauri/tauri.conf.json'));
  for (const path of config.bundle.icon) assert.ok((await read(`app/src-tauri/${path}`)).length > 0, path);
});
