const results = document.getElementById('results');
const summary = document.getElementById('summary');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function assert(condition, message) { if (!condition) throw new Error(message); }
async function until(check, label) {
  for (let i = 0; i < 160; i++) { if (check()) return; await sleep(50); }
  throw new Error(`timeout: ${label}`);
}
function pass(message) {
  const item = document.createElement('li');
  item.dataset.result = 'pass';
  item.textContent = message;
  results.append(item);
}
const panel = () => document.getElementById('veilcast-userscript-ui')?.shadowRoot;
const restored = () => document.querySelector('canvas[data-veilcast-restored]');
const isEnabled = () => document.getElementById('veilcast-userscript-ui')?.dataset.enabled === 'true';
const toolbarMarkup = '<div class="video-toolbar-left-main"><button>点赞</button><button>投币</button><button>收藏</button><button>分享</button></div><div class="video-owner-state">编辑 · 更多</div>';
let video;
let source;
let stream;
let tick;

try {
  const info = await fetch('/target/userscript-smoke/fixture.json').then((r) => r.json());
  const scrambled = new Uint8Array(await fetch('/target/userscript-smoke/scrambled.rgb').then((r) => r.arrayBuffer()));
  const original = new Uint8Array(await fetch('/target/userscript-smoke/original.rgb').then((r) => r.arrayBuffer()));
  source = document.createElement('canvas');
  source.width = info.uploadWidth;
  source.height = info.uploadHeight;
  const context = source.getContext('2d');
  const image = context.createImageData(source.width, source.height);
  for (let i = 0; i < scrambled.length / 3; i++) {
    image.data.set(scrambled.subarray(i * 3, i * 3 + 3), i * 4);
    image.data[i * 4 + 3] = 255;
  }
  const paint = () => context.putImageData(image, 0, 0);
  paint();
  stream = source.captureStream(10);
  tick = setInterval(paint, 100);
  document.getElementById('fixture').innerHTML = `
    <div class="bpx-player-primary-area"><div class="bpx-player-video-area"><div class="bpx-player-video-perch">
      <div class="bpx-player-video-wrap"><video muted playsinline></video></div>
    </div></div><div class="controls"><button id="playback">播放 / 暂停</button> <button id="fullscreen">全屏验证</button></div></div>`;
  video = document.querySelector('video');
  video.srcObject = stream;
  await video.play();
  await until(() => video.readyState >= 2, 'video frames');
  assert(!panel(), 'no legacy button inside the video before the toolbar exists');
  document.getElementById('fixture').insertAdjacentHTML('beforeend',
    `<div id="arc_toolbar_report"><div class="video-toolbar-left">${toolbarMarkup}</div></div>
     <div id="v_desc">原始宽${info.params.width}，高${info.params.height} tile ${info.params.tile} margin ${info.params.margin} seed ${info.params.seed}<br>混淆前6M，混淆后60M，解码后19M</div>`);
  await until(() => panel() && video.readyState >= 2, 'late player discovery');
  assert(document.querySelector('.video-toolbar-left-main').nextElementSibling.id === 'veilcast-userscript-ui', 'button immediately after share group');
  assert(!document.querySelector('.bpx-player-primary-area #veilcast-userscript-ui'), 'no settings UI covering the player');
  assert(!isEnabled() && restored().style.visibility === 'hidden', 'must start disabled');
  assert(!panel().querySelector('[name=invert]').checked, 'legacy defaults keep inversion off');
  for (const [name, value] of Object.entries({ seed: '20040821', tile: '40', margin: '0', width: '720', height: '1280' })) {
    assert(panel().querySelector(`[name=${name}]`).value === value, `default ${name}`);
  }
  pass('延迟插入的 video / 工具栏自动定位；按钮位于分享右侧，默认参数与 Tauri 一致');
  panel().getElementById('open').click();
  assert(panel().getElementById('panel').matches(':modal'), 'native modal dialog');
  const popupBounds = panel().getElementById('panel').getBoundingClientRect();
  const buttonBounds = panel().getElementById('open').getBoundingClientRect();
  assert(popupBounds.top >= buttonBounds.bottom, 'dialog below the button');
  assert(popupBounds.left >= 0 && popupBounds.right <= innerWidth, 'dialog within viewport');
  panel().getElementById('panel').dispatchEvent(new Event('cancel', { cancelable: true }));
  assert(!panel().getElementById('panel').open, 'cancel closes dialog');
  panel().getElementById('open').click();
  const outside = panel().getElementById('panel').getBoundingClientRect();
  panel().getElementById('panel').dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: outside.left - 2, clientY: outside.top - 2 }));
  assert(!panel().getElementById('panel').open, 'outside click closes dialog');
  panel().getElementById('open').click();
  pass('设置以原生模态窗口显示在按钮下方，越过工具栏 overflow 裁剪并支持取消/外部点击关闭');
  panel().getElementById('from-description').click();
  for (const [name, value] of Object.entries(info.params)) {
    assert(panel().querySelector(`[name=${name}]`).value === String(value), `description import ${name}`);
  }
  assert(!isEnabled(), 'import only fills the form');
  pass('读取简介只填入明确参数，不擅自启用或覆盖当前播放状态');
  panel().getElementById('toggle').click();
  await until(() => isEnabled() && restored().style.visibility === 'visible', 'first restored frame');

  function comparePixels(tolerance) {
    // Render and read in one task before the compositor discards the drawing buffer.
    video.dispatchEvent(new Event('seeked'));
    const canvas = restored();
    const gl = canvas.getContext('webgl2');
    const pixels = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    let maxError = 0;
    for (let y = 3; y < info.params.height - 2; y += 5) {
      for (let x = 3; x < info.params.width - 2; x += 5) {
        if (x % 16 < 2 || x % 16 > 13 || y % 16 < 2 || y % 16 > 13) continue;
        for (let c = 0; c < 3; c++) {
          const actual = pixels[((canvas.height - 1 - y) * canvas.width + x) * 4 + c];
          const expected = original[(y * info.workWidth + x) * 3 + c];
          maxError = Math.max(maxError, Math.abs(actual - expected));
        }
      }
    }
    assert(maxError <= tolerance, `pixel error ${maxError} > ${tolerance}`);
    return maxError;
  }
  pass(`真实 Rust margin=4 扰乱数据经 video→WebGL 还原及补齐裁剪，RGB 最大误差 ${comparePixels(8)}`);
  // This file was inverted by Rust in limited-range YUV and encoded by ffmpeg.
  video.srcObject = null;
  video.src = '/target/userscript-smoke/inverted.mp4';
  video.loop = true;
  await video.play();
  await until(() => video.readyState >= 2, 'inverted H264 video');
  panel().querySelector('[name=invert]').checked = true;
  panel().querySelector('form').requestSubmit();
  await new Promise((resolve) => video.requestVideoFrameCallback(resolve));
  pass(`Rust YUV 反色 → H.264 → 浏览器 shader 还原，RGB 最大误差 ${comparePixels(12)}`);
  assert(saved.get('veilcast.bilibili.settings.v1').invert === true, 'persist inversion as a boolean');
  video.removeAttribute('src');
  video.srcObject = stream;
  video.loop = false;
  await video.play();
  panel().querySelector('[name=invert]').checked = false;
  panel().querySelector('form').requestSubmit();
  await new Promise((resolve) => video.requestVideoFrameCallback(resolve));
  comparePixels(8);
  assert(saved.get('veilcast.bilibili.settings.v1').invert === false, 'unchecked state must be saved as false');
  pass('反色开关保存布尔值；取消勾选后恢复旧视频的正常还原');
  const existingCanvas = restored();
  const existingUi = document.getElementById('veilcast-userscript-ui');
  panel().querySelector('[name=seed]').value = 'unsaved draft';
  document.querySelector('.video-toolbar-left').innerHTML = toolbarMarkup;
  await until(() => document.querySelector('.video-toolbar-left-main').nextElementSibling === existingUi, 'toolbar replacement');
  assert(panel().getElementById('panel').matches(':modal'), 'dialog reopened after toolbar remount');
  assert(panel().querySelector('[name=seed]').value === 'unsaved draft', 'draft preserved');
  assert(restored() === existingCanvas && isEnabled(), 'renderer preserved during toolbar remount');
  panel().querySelector('[name=seed]').value = info.params.seed;
  pass('工具栏被页面重建后自动归位，保留未保存输入、弹窗及现有还原画布');
  const originalSrc = video.srcObject;
  video.pause();
  panel().getElementById('toggle').click();
  assert(!isEnabled() && restored().style.visibility === 'hidden', 'disable overlay');
  assert(video.srcObject === originalSrc && video.paused, 'do not mutate video source or playback');
  panel().getElementById('toggle').click();
  await until(() => restored().style.visibility === 'visible', 'paused redraw');
  comparePixels(8);
  pass('暂停时启用/停用及 seeked 重绘有效；原视频源与播放状态保持不变');

  clearInterval(tick);
  const smaller = document.createElement('canvas');
  smaller.width = source.width / 2;
  smaller.height = source.height / 2;
  const smallContext = smaller.getContext('2d');
  const paintSmall = () => smallContext.drawImage(source, 0, 0, smaller.width, smaller.height);
  paintSmall();
  const smallStream = smaller.captureStream(10);
  tick = setInterval(paintSmall, 100);
  video.srcObject = smallStream;
  await video.play();
  await until(() => video.videoWidth === smaller.width && restored().style.visibility === 'visible', 'resolution switch');
  pass(`同一 video 切至半分辨率后网格仍一致，RGB 最大误差 ${comparePixels(12)}`);

  const oldCanvas = restored();
  const oldVideo = video;
  video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  // Exercise the requestAnimationFrame compatibility path on the replacement.
  Object.defineProperty(video, 'requestVideoFrameCallback', { value: undefined });
  oldVideo.replaceWith(video);
  video.srcObject = smallStream;
  await video.play();
  await until(() => restored() !== oldCanvas && restored()?.style.visibility === 'visible', 'replacement video');
  assert(!oldCanvas.isConnected, 'old canvas removed');
  assert(document.querySelectorAll('#veilcast-userscript-ui').length === 1, 'one panel');
  assert(document.querySelectorAll('canvas[data-veilcast-restored]').length === 1, 'one canvas');
  comparePixels(12);
  pass('播放器更换 video 后重绑并清理旧画布；rAF 兼容路径通过');

  const extension = restored().getContext('webgl2').getExtension('WEBGL_lose_context');
  extension.loseContext();
  await until(() => !isEnabled(), 'context loss fallback');
  assert(restored().style.visibility === 'hidden', 'context loss hides canvas');
  await sleep(150);
  extension.restoreContext();
  await until(() => panel().getElementById('status').textContent.includes('WebGL 已恢复'), 'context restored');
  panel().getElementById('toggle').click();
  await until(() => isEnabled() && restored().style.visibility === 'visible', 're-enable restored context');
  comparePixels(12);
  pass('WebGL 上下文丢失时保留原画面，恢复后可重新启用');

  history.pushState({}, '', '/video/veilcast-local-fixture/?p=2');
  await until(() => !isEnabled(), 'SPA part change');
  assert(restored().style.visibility === 'hidden', 'new page remains original');
  assert(panel().querySelector('[name=tile]').value === '16', 'saved configuration retained');
  pass('SPA / 分 P 切换自动关闭还原并保留参数，避免误处理普通视频');

  panel().getElementById('open').click();
  panel().getElementById('toggle').click();
  await until(() => restored().style.visibility === 'visible', 'final frame');
  panel().getElementById('close').click();
  document.getElementById('playback').onclick = () => video.paused ? video.play() : video.pause();
  document.getElementById('fullscreen').onclick = () => document.querySelector('.bpx-player-primary-area').requestFullscreen();
  summary.dataset.result = 'pass';
  summary.textContent = `${results.children.length} 项浏览器集成检查通过；可继续点击播放/全屏人工检查。`;
  window.addEventListener('pagehide', () => {
    clearInterval(tick);
    for (const track of [...stream.getTracks(), ...smallStream.getTracks()]) track.stop();
  }, { once: true });
} catch (error) {
  clearInterval(tick);
  summary.dataset.result = 'fail';
  summary.textContent = `FAIL: ${error.stack ?? error}`;
}
