// Create a synthetic, Rust-scrambled fixture. No user media is read.
import { mkdir, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = new URL('../../', import.meta.url);
const build = spawnSync('cargo', ['build', '-p', 'veilcast-core', '--example', 'raw_pipe', '--offline'], {
  cwd: fileURLToPath(root), stdio: 'inherit', windowsHide: true,
});
if (build.status !== 0) throw new Error('raw_pipe build failed');
const params = { width: 78, height: 46, tile: 16, margin: 4, seed: '20260916' };
const workWidth = 80;
const workHeight = 48;
const pixels = Buffer.alloc(workWidth * workHeight * 3);
for (let y = 0; y < workHeight; y++) {
  for (let x = 0; x < workWidth; x++) {
    const sx = Math.min(x, params.width - 1);
    const sy = Math.min(y, params.height - 1);
    const offset = (y * workWidth + x) * 3;
    pixels[offset] = 20 + sx * 2;
    pixels[offset + 1] = 20 + sy * 4;
    pixels[offset + 2] = 30 + (Math.floor(sx / 16) + Math.floor(sy / 16) * 5) * 12;
  }
}
const binary = new URL(`target/debug/examples/raw_pipe${process.platform === 'win32' ? '.exe' : ''}`, root);
const result = spawnSync(fileURLToPath(binary), ['scramble', String(workWidth), String(workHeight),
  String(params.tile), String(params.margin), params.seed, 'rgb24'], {
  input: pixels, maxBuffer: 16 * 1024 * 1024, windowsHide: true,
});
if (result.status !== 0) throw new Error(result.stderr.toString());
const uploadWidth = 120;
const uploadHeight = 72;
if (result.stdout.length !== uploadWidth * uploadHeight * 3) throw new Error('Unexpected fixture length');
const folder = new URL('target/userscript-smoke/', root);
await mkdir(folder, { recursive: true });
await writeFile(new URL('original.rgb', folder), pixels);
await writeFile(new URL('scrambled.rgb', folder), result.stdout);
await writeFile(new URL('fixture.json', folder), JSON.stringify({ params, workWidth, workHeight, uploadWidth, uploadHeight }));

// Exercise the SAME Rust limited-range YUV inversion as Tauri, then use a
// real H.264 video rather than a JS-negated canvas for browser verification.
const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
let ffmpeg = process.env.VEILCAST_FFMPEG_DIR
  ? join(process.env.VEILCAST_FFMPEG_DIR, exe)
  : fileURLToPath(new URL(`tools/ffmpeg/${exe}`, root));
try { await access(ffmpeg); } catch { ffmpeg = exe; }
function run(program, args, input) {
  const child = spawnSync(program, args, { input, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
  if (child.status !== 0) throw new Error(child.error?.message ?? child.stderr.toString());
  return child.stdout;
}
const yuv = run(ffmpeg, ['-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${workWidth}x${workHeight}`,
  '-i', '-', '-vf', 'scale=out_range=tv', '-pix_fmt', 'yuv420p', '-f', 'rawvideo', '-'], pixels);
const negative = run(fileURLToPath(binary), ['scramble', String(workWidth), String(workHeight),
  String(params.tile), String(params.margin), params.seed, 'yuv420p', '--invert'], yuv);
run(ffmpeg, ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-s', `${uploadWidth}x${uploadHeight}`,
  '-framerate', '10', '-i', '-', '-c:v', 'libx264', '-crf', '16', '-pix_fmt', 'yuv420p', '-color_range', 'tv',
  '-colorspace', 'smpte170m', '-movflags', '+faststart', fileURLToPath(new URL('inverted.mp4', folder))],
  Buffer.concat(Array.from({ length: 10 }, () => negative)));
console.log('Rust fixture ready. Serve the repository and open /userscript/tests/browser.html');
