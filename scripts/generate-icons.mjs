// Convert the selected master without redrawing it. This only generates image
// assets; it never builds an application bundle or an installer.
import { access, copyFile, mkdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const master = new URL('assets/branding/veilcast-icon.png', root);
const cli = new URL('app/node_modules/@tauri-apps/cli/tauri.js', root);
const scratch = new URL('target/branding-icons/', root);
const desktop = new URL('desktop/', scratch);
await access(master);
await access(cli);
await mkdir(scratch, { recursive: true });

function generate(output) {
  const result = spawnSync(process.execPath, [fileURLToPath(cli), 'icon', fileURLToPath(master),
    '--output', fileURLToPath(output)], {
    cwd: fileURLToPath(new URL('app/', root)), stdio: 'inherit', windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Icon generation failed: ${result.status}`);
}

generate(desktop);

const files = [
  '32x32.png', '64x64.png', '128x128.png', '128x128@2x.png', 'icon.png', 'icon.ico', 'icon.icns',
  'Square30x30Logo.png', 'Square44x44Logo.png', 'Square71x71Logo.png', 'Square89x89Logo.png',
  'Square107x107Logo.png', 'Square142x142Logo.png', 'Square150x150Logo.png',
  'Square284x284Logo.png', 'Square310x310Logo.png', 'StoreLogo.png',
];
// Validate the complete output before replacing the tracked desktop assets.
for (const name of files) await access(new URL(name, desktop));
const small = new URL('64x64.png', desktop);
const png = await readFile(small);
if (png.readUInt32BE(16) !== 64 || png.readUInt32BE(20) !== 64) throw new Error('Expected a 64x64 web icon');

const icons = new URL('app/src-tauri/icons/', root);
const publicFolder = new URL('app/public/', root);
await mkdir(icons, { recursive: true });
await mkdir(publicFolder, { recursive: true });
for (const name of files) await copyFile(new URL(name, desktop), new URL(name, icons));
await copyFile(small, new URL('icon.png', publicFolder));
console.log('Updated Tauri PNG/ICO/ICNS assets and the app web icon. Rebuild the userscript to embed them.');
