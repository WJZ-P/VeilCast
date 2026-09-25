/** Browser integration only. The renderer and desktop defaults are injected by the build. */
export function installUserscript({ createRestorer, scanIntro, decodeQr, createIntroReader, audio, defaults, validateSettings, querySettings, descriptionSettings, videoPageKey, pageSettings, rememberPageSettings, forgetPageSettings, storage, menu, iconUrl, diagnostics, introVideoState, scriptVersion = 'unknown' }) {
  const SELECTOR = '.bpx-player-primary-area video';
  const TOOLBAR_SELECTOR = '#arc_toolbar_report .video-toolbar-left-main';
  const STORAGE_KEY = 'veilcast.bilibili.settings.v1';
  // Per-video memory, keyed by BVID and part: what the intro QR said, plus
  // whatever the viewer corrected by hand on that page.
  const PAGES_KEY = 'veilcast.bilibili.pages.v1';
  const log = (event, details = {}, level = 'info') => diagnostics?.log(event, details, level);
  const mediaState = (video) => introVideoState?.(video) ?? { currentTime: video.currentTime, readyState: video.readyState };
  let mountSequence = 0;
  log('install.start', { scriptVersion, documentReady: document.readyState, documentHidden: document.hidden, decoderAvailable: typeof decodeQr === 'function' });
  let settings;
  let settingsNotice = '';
  let enabled = false;
  let active = null;
  let scanHandle = null;
  let pageKey = videoPageKey(location.href);
  let disposed = false;
  // Audio files the player fetched; only those requested after the current
  // video was navigated to can belong to it.
  const audioUrls = audio?.watchAudioUrls();
  let navigatedAt = 0;

  /** This page's remembered plan, ignored when it no longer validates. */
  function pageMemory() {
    let entry;
    try {
      entry = pageSettings(storage.get(PAGES_KEY, {}), pageKey);
    } catch { return null; }
    if (!entry) return null;
    try {
      validateSettings(entry.settings, defaults);
    } catch { return null; }
    return entry;
  }
  function rememberPage(values, source) {
    if (!pageKey) return;
    try {
      storage.set(PAGES_KEY, rememberPageSettings(storage.get(PAGES_KEY, {}), pageKey, values, source));
    } catch { /* Memory is a convenience; this session still works without it. */ }
  }
  function forgetPage() {
    if (!pageKey) return;
    try {
      storage.set(PAGES_KEY, forgetPageSettings(storage.get(PAGES_KEY, {}), pageKey));
    } catch { /* As above. */ }
  }
  /** Only a page whose intro QR we verified restores by itself. */
  function autoEnabled() {
    return Boolean(settings.autoIntro && pageMemory()?.source === 'intro');
  }

  function loadSettings() {
    settingsNotice = '';
    // This page's memory beats the last-used values; an explicit URL still wins.
    const remembered = pageMemory()?.settings ?? {};
    try {
      const saved = storage.get(STORAGE_KEY, {});
      return validateSettings({ ...saved, ...remembered, ...querySettings(location.search) }, defaults);
    } catch (error) {
      settingsNotice = `参数读取失败，已恢复默认值：${error.message}`;
      return validateSettings({}, defaults);
    }
  }
  settings = loadSettings();
  enabled = autoEnabled();

  function mount(video, toolbar) {
    const mountId = ++mountSequence;
    const mountedPageKey = pageKey;
    log('player.mount', { mountId, candidates: document.querySelectorAll(SELECTOR).length, ...mediaState(video) });
    const area = video.closest('.bpx-player-primary-area');
    const wrapper = video.parentElement;
    const listeners = new AbortController();
    const positioned = [];
    for (const element of [wrapper]) {
      if (getComputedStyle(element).position === 'static') {
        positioned.push([element, element.style.position]);
        element.style.position = 'relative';
      }
    }

    const canvas = document.createElement('canvas');
    canvas.dataset.veilcastRestored = '';
    canvas.setAttribute('aria-hidden', 'true');
    // Stay inside the video layer: danmaku and player controls remain above us.
    canvas.style.cssText = 'position:absolute;pointer-events:none;z-index:1;background:#000;object-fit:contain;visibility:hidden;';
    wrapper.append(canvas);
    const ui = document.createElement('div');
    ui.id = 'veilcast-userscript-ui';
    ui.style.cssText = 'display:inline-flex;align-items:center;position:relative;flex-shrink:0;margin-left:16px;pointer-events:auto;';
    const shadow = ui.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host { font: 13px/1.5 system-ui,sans-serif; text-align: left; }
        * { box-sizing: border-box; }
        [hidden] { display: none !important; }
        button, input { font: inherit; color: inherit; }
        button { border: 1px solid #46516b; background: #20293c; border-radius: 7px; padding: 6px 10px; cursor: pointer; }
        button:hover { background: #334362; }
        button:focus-visible, input:focus-visible, summary:focus-visible { outline: 2px solid #95b9ff; outline-offset: 2px; }
        #open { display: inline-flex; align-items: center; gap: 7px; height: 28px; padding: 0 4px;
          white-space: nowrap; background: transparent; border: 0; color: var(--text2, #9499a0); font-size: 14px; }
        #open:hover, #open[aria-expanded=true], :host([data-enabled=true]) #open { color: #00aeec; }
        #open img { display: block; width: 20px; height: 20px; object-fit: contain; flex-shrink: 0; }
        dialog { position: fixed; margin: 0; width: min(360px, calc(100vw - 24px)); max-width: none;
          padding: 16px; overflow-y: auto; border: 1px solid #46516b; border-radius: 12px;
          background: #141b2a; color: #ecf0f8; color-scheme: dark; box-shadow: 0 10px 36px #0007; }
        dialog::backdrop { background: #0003; }
        form { margin: 0; }
        header, .row { display: flex; align-items: center; gap: 8px; }
        header { justify-content: space-between; margin-bottom: 10px; }
        header strong { font-size: 14px; }
        #build-version { font-size: 11px; font-weight: normal; color: #95a7c6; }
        label { display: flex; flex: 1; flex-direction: column; gap: 4px; min-width: 0; margin-bottom: 10px; }
        input { width: 100%; min-width: 0; padding: 6px 8px; border: 1px solid #46516b; border-radius: 6px; background: #0c1220; }
        .check { flex-direction: row; align-items: center; gap: 8px; }
        .check input { width: 16px; height: 16px; margin: 0; accent-color: #00aeec; }
        #from-description, #scan-intro, #copy-diagnostics { padding: 4px 8px; margin-bottom: 10px; font-size: 12px; }
        #intro-status { margin: 0 0 10px; }
        #log-details { margin-top: 10px; }
        #log-details summary { cursor: pointer; }
        #diagnostic-log { width: 100%; height: 160px; margin-top: 6px; background: #0c1220; color: #b7c9e9;
          border: 1px solid #46516b; border-radius: 6px; font: 11px/1.4 monospace; resize: vertical; }
        p { margin: 8px 0 0; color: #b4c1d8; overflow-wrap: anywhere; }
        #toggle { flex: 1; background: #245b9c; }
        [role=status][data-error=true] { color: #ffb3b3; }
        small { display: block; color: #95a7c6; margin-bottom: 10px; }
      </style>
      <button id="open" type="button" aria-haspopup="dialog" aria-expanded="false" aria-controls="panel">
        <img id="brand-icon" width="20" height="20" alt="" aria-hidden="true" draggable="false">
        <span id="button-label">VeilCast · 关</span>
      </button>
      <dialog id="panel" aria-labelledby="panel-title">
      <form>
        <header><strong id="panel-title">VeilCast · 画面还原 <span id="build-version"></span></strong><button id="close" type="button" aria-label="关闭设置">关闭</button></header>
        <label>seed（数字或文字）<input name="seed" type="text" maxlength="4096" autocomplete="off" spellcheck="false"></label>
        <div class="row">
          <label>tile / tail（偶数）<input name="tile" type="number" min="2" max="16384" step="2" required></label>
          <label>margin（偶数）<input name="margin" type="number" min="0" max="16384" step="2" required></label>
        </div>
        <div class="row">
          <label>原始宽度<input name="width" type="number" min="1" max="16384" step="1" required></label>
          <label>原始高度<input name="height" type="number" min="1" max="16384" step="1" required></label>
        </div>
        <small>填写加密前的尺寸，而非当前播放清晰度；五项参数需与加密端一致。</small>
        <label>音频块长 ms（0 = 不处理音频）<input name="audioMs" type="number" min="0" max="9999" step="1" required></label>
        <label class="check"><input name="invert" type="checkbox">反色（与加密端保持一致）</label>
        <label class="check"><input name="autoIntro" type="checkbox">自动读取片头二维码并启用还原</label>
        <button id="from-description" type="button">读取简介参数</button>
        <button id="scan-intro" type="button">识别当前二维码</button>
        <p id="intro-status" role="status" aria-live="polite"></p>
        <div class="row"><button id="toggle" type="button">启用还原</button><button type="submit">应用参数</button><button id="reset" type="button">默认</button></div>
        <p id="status" role="status" aria-live="polite"></p>
        <p id="audio-status" role="status" aria-live="polite" hidden></p>
        <button id="copy-diagnostics" type="button">复制诊断日志</button>
        <p id="log-status" role="status" aria-live="polite"></p>
        <details id="log-details"><summary>查看诊断日志（本地，已脱敏）</summary>
          <textarea id="diagnostic-log" readonly spellcheck="false" aria-label="VeilCast 诊断日志"></textarea>
        </details>
        <small>音频块长大于 0 时一并还原声音；弹幕和播放控制保留。</small>
      </form></dialog>`;
    const brandIcon = shadow.getElementById('brand-icon');
    shadow.getElementById('build-version').textContent = `v${scriptVersion}`;
    if (iconUrl) brandIcon.src = iconUrl;
    else brandIcon.hidden = true;
    toolbar.after(ui);
    const form = shadow.querySelector('form');
    const dialog = shadow.getElementById('panel');
    const status = shadow.getElementById('status');
    const toggle = shadow.getElementById('toggle');
    const openButton = shadow.getElementById('open');
    let gl = null;
    let restorer = null;
    let frameHandle = null;
    let frameKind = null;
    let hasDrawn = false;
    let dead = false;

    const on = (target, name, callback, options = {}) => target.addEventListener(name, callback, { ...options, signal: listeners.signal });
    function message(text, error = false) {
      status.textContent = text;
      status.dataset.error = String(error);
    }
    function positionDialog() {
      if (!dialog.open) return;
      const anchor = openButton.getBoundingClientRect();
      const width = Math.min(360, window.innerWidth - 24);
      // Prefer directly below the button; keep a usable scroll area on very short viewports.
      const top = Math.max(12, Math.min(anchor.bottom + 8, window.innerHeight - 172));
      dialog.style.left = `${Math.max(12, Math.min(anchor.left, window.innerWidth - width - 12))}px`;
      dialog.style.top = `${top}px`;
      dialog.style.maxHeight = `${Math.max(80, window.innerHeight - top - 12)}px`;
    }
    function open(show = true) {
      if (show && !dialog.open && ui.isConnected) {
        const anchor = openButton.getBoundingClientRect();
        if (anchor.top < 0 || anchor.bottom > window.innerHeight) {
          ui.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
        }
        dialog.showModal();
        // Make room below the toolbar instead of hiding the enable button
        // below a tiny scroll area when the player nearly fills the viewport.
        const desiredHeight = Math.min(dialog.scrollHeight + 2, window.innerHeight - 100);
        const shortfall = openButton.getBoundingClientRect().bottom + 8 + desiredHeight + 12 - window.innerHeight;
        if (shortfall > 0) window.scrollBy({ top: shortfall, behavior: 'instant' });
        positionDialog();
      } else if (!show && dialog.open) {
        dialog.close();
      }
      openButton.setAttribute('aria-expanded', String(dialog.open));
    }
    function fill(values = settings) {
      for (const name of ['seed', 'tile', 'margin', 'width', 'height', 'audioMs']) form.elements.namedItem(name).value = values[name];
      form.elements.namedItem('invert').checked = values.invert;
      form.elements.namedItem('autoIntro').checked = values.autoIntro;
    }
    // The first second of a VeilCast upload is a QR code carrying the plan.
    // Read it while the playhead is still inside that window, then apply and
    // switch the restorer on: only our own header parses, so nothing happens
    // on ordinary videos.
    let introReader = null;
    const scanButton = shadow.getElementById('scan-intro');
    function introReport(state, error) {
      const label = shadow.getElementById('intro-status');
      ui.dataset.intro = state;
      label.dataset.error = String(state === 'error');
      scanButton.textContent = state === 'scanning' ? '识别中…（点击重试）' : '识别当前二维码';
      label.textContent = {
        off: '二维码自动识别已关闭，可手动识别当前画面。',
        waiting: '二维码：等待片头画面；从中途进入可拖回开头。',
        scanning: '二维码：等待视频帧并识别中…',
        found: '二维码：参数已读取并应用（含音频块长）。',
        missing: '二维码：本轮未识别到有效参数。可暂停在二维码处，点击「识别当前二维码」重试。',
        error: `二维码读取或应用失败：${error?.message ?? error ?? '未知原因'}。若含跨域限制提示，请保留错误信息。`,
      }[state];
    }
    function initializeIntroReader() {
      if (introReader) return true;
      const components = { createIntroReader: typeof createIntroReader, scanIntro: typeof scanIntro, decodeQr: typeof decodeQr };
      log('qr.reader-init', { mountId, ...components, ...mediaState(video) });
      try {
        if (Object.values(components).some((type) => type !== 'function')) throw new Error('二维码识别组件未加载完整');
        introReader = createIntroReader(video, {
          scan: scanIntro, decode: decodeQr, enabled: () => settings.autoIntro,
          isCurrent: () => !dead && video.isConnected && videoPageKey(location.href) === mountedPageKey,
          onHeader: applyIntroHeader, report: introReport, signal: listeners.signal,
          trace: (event, details) => log(`qr.${event}`, { mountId, documentHidden: document.hidden, ...mediaState(video), ...details },
            event.includes('error') || event.includes('failed') ? 'error' : event.includes('rejected') || event.includes('discarded') ? 'warn' : 'info'),
        });
        log('qr.reader-ready', { mountId });
        return true;
      } catch (error) {
        log('qr.reader-init-failed', { mountId, error }, 'error');
        introReport('error', error);
        return false;
      }
    }
    function applyIntroHeader(header) {
      if (dead) return false;
      fill({
        ...settings,
        width: header.width,
        height: header.height,
        tile: header.tile,
        margin: header.margin,
        invert: header.invert,
        audioMs: header.audioMs,
        seed: header.seed === null ? settings.seed : String(header.seed),
      });
      if (!apply()) { log('qr.settings-rejected', { mountId }, 'warn'); return false; }
      if (!enabled) {
        enabled = true;
        startRenderer();
        updateToggle();
      }
      if (!enabled) { log('qr.renderer-not-enabled', { mountId }, 'warn'); return false; }
      rememberPage(settings, 'intro');
      message(header.seed === null
        ? '已从片头二维码读取尺寸、tile、margin 和反色（片头不含 seed，沿用当前 seed）并启用还原，参数已记住。'
        : '已从片头二维码读取全部参数（含 seed）并启用还原，参数已记住。');
      return true;
    }
    const audioStatus = shadow.getElementById('audio-status');
    let audioRestorer = null;
    let audioSource = '';
    function audioReport(state, text) {
      log('audio.state', { mountId, state, message: text }, state === 'error' ? 'error' : 'info');
      ui.dataset.audio = state;
      if (audioRestorer) ui.dataset.audioMode = audioRestorer.mode;
      audioStatus.textContent = text;
      audioStatus.hidden = !text;
      audioStatus.dataset.error = String(state === 'error');
    }
    /** Keeps the audio restorer in line with `enabled` and the block length. */
    function syncAudio() {
      const wanted = !dead && enabled && settings.audioMs > 0 && Boolean(audio);
      const source = video.currentSrc || video.src || '';
      if (audioRestorer && (audioRestorer.blockMs !== settings.audioMs || audioSource !== source)) {
        audioRestorer.destroy();
        audioRestorer = null;
      }
      if (!wanted) {
        audioRestorer?.disable();
        audioReport('off', '');
        delete ui.dataset.audioMode;
        return;
      }
      const since = navigatedAt;
      try {
        if (audioRestorer) {
          audioRestorer.enable();
          ui.dataset.audioMode = audioRestorer.mode;
          return;
        }
        audioSource = source;
        audioRestorer = audio.createAudioRestorer({
          video,
          blockMs: settings.audioMs,
          host: shadow,
          locate: (signal) => audio.locateAudio(video, audioUrls, { since, signal }),
          report: audioReport,
          trace: (event, details) => log(`audio.${event}`, { mountId, ...details },
            /error|rejected/.test(event) ? 'warn' : 'info'),
        });
        ui.dataset.audioMode = audioRestorer.mode;
      } catch (error) {
        log('audio.init-failed', { mountId, error }, 'error');
        audioReport('error', `音频初始化失败：${error.message ?? error}`);
      }
    }
    function updateToggle() {
      toggle.textContent = enabled ? '停用还原' : '启用还原';
      shadow.getElementById('button-label').textContent = enabled ? 'VeilCast · 开' : 'VeilCast · 关';
      ui.dataset.enabled = String(enabled);
    }
    function cancelFrame() {
      if (frameHandle === null) return;
      if (frameKind === 'video') video.cancelVideoFrameCallback(frameHandle);
      else cancelAnimationFrame(frameHandle);
      frameHandle = null;
    }
    function stopRenderer() {
      cancelFrame();
      canvas.style.visibility = 'hidden';
      restorer?.destroy();
      restorer = null;
      hasDrawn = false;
    }
    function fail(error) {
      log('renderer.error', { mountId, error }, 'error');
      enabled = false;
      stopRenderer();
      updateToggle();
      syncAudio();
      message(`还原已停止，保留原画面：${error.message ?? error}。请检查参数、WebGL 或视频跨域限制。`, true);
      open();
    }
    function syncBox() {
      const bounds = video.getBoundingClientRect();
      const parent = wrapper.getBoundingClientRect();
      const scaleX = wrapper.offsetWidth ? parent.width / wrapper.offsetWidth : 1;
      const scaleY = wrapper.offsetHeight ? parent.height / wrapper.offsetHeight : 1;
      if (!scaleX || !scaleY) return;
      canvas.style.left = `${(bounds.left - parent.left) / scaleX - wrapper.clientLeft + wrapper.scrollLeft}px`;
      canvas.style.top = `${(bounds.top - parent.top) / scaleY - wrapper.clientTop + wrapper.scrollTop}px`;
      canvas.style.width = `${bounds.width / scaleX}px`;
      canvas.style.height = `${bounds.height / scaleY}px`;
    }
    function scheduleFrame() {
      if (frameHandle !== null || dead || !enabled || !restorer || video.paused || video.ended || document.hidden) return;
      const callback = () => { frameHandle = null; render(); };
      frameKind = typeof video.requestVideoFrameCallback === 'function' ? 'video' : 'animation';
      frameHandle = frameKind === 'video' ? video.requestVideoFrameCallback(callback) : requestAnimationFrame(callback);
    }
    function render() {
      if (dead || !enabled || !restorer || document.hidden) return;
      if (video.readyState >= 2 && !video.seeking && video.videoWidth && video.videoHeight) {
        try {
          restorer.draw(video);
          if (!hasDrawn) {
            if (gl.getError() !== gl.NO_ERROR) throw new Error('视频纹理上传失败');
            hasDrawn = true;
            const memory = pageMemory()?.source === 'intro' ? ' · 已记住本视频的参数' : '';
            message(`还原中 · ${settings.width}×${settings.height} · 反色${settings.invert ? '开' : '关'} · 视频 ${video.videoWidth}×${video.videoHeight}${memory}${settingsNotice ? ` · ${settingsNotice}` : ''}`);
          }
          canvas.style.visibility = 'visible';
        } catch (error) { fail(error); return; }
      }
      scheduleFrame();
    }
    function startRenderer() {
      stopRenderer();
      if (!enabled) return;
      try {
        gl ??= canvas.getContext('webgl2', { alpha: false, antialias: false, premultipliedAlpha: false });
        if (!gl || gl.isContextLost()) throw new Error('WebGL2 暂不可用');
        const maximum = gl.getParameter(gl.MAX_RENDERBUFFER_SIZE);
        if (settings.width > maximum || settings.height > maximum) throw new Error('原始尺寸超过 GPU 画布上限');
        canvas.width = settings.width;
        canvas.height = settings.height;
        restorer = createRestorer(gl, settings);
        syncBox();
        message('等待视频帧…');
        render();
      } catch (error) { fail(error); return; }
      updateToggle();
      syncAudio();
    }
    function apply() {
      if (!form.reportValidity()) {
        log('settings.form-invalid', { mountId, fields: [...form.elements]
          .filter((element) => element.validity && !element.validity.valid).map((element) => element.name) }, 'warn');
        return false;
      }
      const previousAutoIntro = settings.autoIntro;
      try {
        const values = Object.fromEntries(new FormData(form));
        values.invert = form.elements.namedItem('invert').checked;
        values.autoIntro = form.elements.namedItem('autoIntro').checked;
        values.audioMs = form.elements.namedItem('audioMs').value;
        settings = validateSettings(values, defaults);
      } catch (error) { log('settings.validation-failed', { mountId, error }, 'warn'); message(error.message, true); return false; }
      settingsNotice = '';
      try { storage.set(STORAGE_KEY, settings); }
      catch { settingsNotice = '设置保存失败，本次会话仍有效'; }
      // A seed the intro could not carry belongs to this video, not to the next one.
      rememberPage(settings, 'manual');
      if (enabled) startRenderer();
      else {
        message(`参数已应用；还原处于关闭状态。${settingsNotice}`);
        syncAudio();
      }
      if (settings.autoIntro !== previousAutoIntro) {
        introReader?.reset();
        void introReader?.request();
      }
      return true;
    }

    on(openButton, 'click', () => open(!dialog.open));
    on(shadow.getElementById('close'), 'click', () => open(false));
    on(dialog, 'cancel', (event) => { event.preventDefault(); open(false); });
    on(dialog, 'close', () => {
      if (dialog.open) return; // A toolbar remount may have already reopened the same dialog.
      openButton.setAttribute('aria-expanded', 'false');
      if (ui.isConnected && !dead) openButton.focus({ preventScroll: true });
    });
    on(dialog, 'click', (event) => {
      if (event.target !== dialog) return;
      const bounds = dialog.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) open(false);
    });
    on(shadow.getElementById('from-description'), 'click', () => {
      try {
        const description = document.querySelector('#v_desc');
        // innerText preserves <br> boundaries between the seed and later prose.
        const text = description?.innerText ?? description?.textContent ?? '';
        const imported = validateSettings(descriptionSettings(text), defaults);
        fill(imported);
        message('已填入简介中的五项参数；点击「应用参数」或「启用还原」生效。');
      } catch (error) { message(error.message, true); }
    });
    on(form, 'submit', (event) => { event.preventDefault(); apply(); });
    on(scanButton, 'click', async () => {
      log('qr.manual-click', { mountId, readerReady: Boolean(introReader), dead,
        pageMatches: videoPageKey(location.href) === mountedPageKey, ...mediaState(video) });
      // A click must respond even if a different component failed during mount.
      introReport('scanning');
      if (!initializeIntroReader()) return;
      try {
        const applied = await introReader.request({ manual: true });
        log('qr.manual-complete', { mountId, applied, state: ui.dataset.intro });
        if (!applied && ui.dataset.intro === 'scanning') introReport('error', new Error('识别任务提前结束，请复制诊断日志查看原因。'));
      } catch (error) {
        log('qr.manual-failed', { mountId, error }, 'error');
        introReport('error', error);
      }
    });
    const logDetails = shadow.getElementById('log-details');
    const logText = shadow.getElementById('diagnostic-log');
    const readLogs = () => diagnostics?.dump() ?? `VeilCast ${scriptVersion}: 诊断组件未加载，请检查控制台。`;
    on(logDetails, 'toggle', () => { if (logDetails.open) logText.value = readLogs(); });
    on(shadow.getElementById('copy-diagnostics'), 'click', async () => {
      log('diagnostics.copy', { mountId });
      const text = readLogs();
      logText.value = text;
      try {
        if (!navigator.clipboard?.writeText) throw new Error('Clipboard API not available');
        await navigator.clipboard.writeText(text);
        shadow.getElementById('log-status').textContent = '诊断日志已复制。';
      } catch {
        logDetails.open = true;
        logText.focus();
        logText.select();
        shadow.getElementById('log-status').textContent = '请按 Ctrl+C 复制下方已选中的日志。';
      }
    });
    on(toggle, 'click', () => {
      if (enabled) {
        enabled = false;
        stopRenderer();
        updateToggle();
        syncAudio();
        message('还原已关闭，显示原画面。');
      } else if (apply()) {
        enabled = true;
        startRenderer();
      }
    });
    on(shadow.getElementById('reset'), 'click', () => {
      settings = validateSettings({}, defaults);
      fill();
      apply();
      // "Default" also drops this video's memory, so it stops restoring by itself.
      forgetPage();
      introReader?.reset();
    });
    // Do not let the player's shortcuts intercept typing or buttons in the panel.
    for (const name of ['keydown', 'keyup', 'keypress', 'pointerdown', 'click', 'dblclick']) {
      on(ui, name, (event) => event.stopPropagation());
    }
    for (const name of ['play', 'playing', 'loadeddata', 'seeked']) on(video, name, render);
    for (const name of ['pause', 'ended']) on(video, name, () => { cancelFrame(); render(); });
    for (const name of ['loadstart', 'emptied']) on(video, name, () => {
      audioRestorer?.destroy();
      audioRestorer = null;
      cancelFrame();
      hasDrawn = false;
      canvas.style.visibility = 'hidden';
      if (enabled) message('视频源切换中…');
    });
    on(video, 'loadeddata', syncAudio);
    on(video, 'seeking', () => { canvas.style.visibility = 'hidden'; });
    for (const name of ['loadedmetadata', 'resize']) on(video, name, () => {
      hasDrawn = false;
      syncBox();
      render();
    });
    on(video, 'error', () => { if (enabled) fail(new Error('原视频加载失败')); });
    on(document, 'visibilitychange', () => { if (document.hidden) cancelFrame(); else render(); });
    on(document, 'fullscreenchange', () => { open(false); syncBox(); render(); });
    on(window, 'resize', () => { syncBox(); positionDialog(); });
    on(document, 'scroll', positionDialog, { capture: true, passive: true });
    on(canvas, 'webglcontextlost', (event) => {
      event.preventDefault();
      fail(new Error('WebGL 上下文丢失，恢复后可重新启用'));
    });
    on(canvas, 'webglcontextrestored', () => message('WebGL 已恢复，可重新启用。'));
    const resizeObserver = new ResizeObserver(syncBox);
    resizeObserver.observe(video);
    resizeObserver.observe(wrapper);
    fill();
    updateToggle();
    message(settingsNotice || '还原未启用；请核对 seed、tile、margin 和原始宽高，再点击「启用还原」。', Boolean(settingsNotice));
    if (settingsNotice) open();
    log('ui.handlers-ready', { mountId, autoIntro: settings.autoIntro, restorationEnabled: enabled });
    // Bind QR actions before starting optional media components. A synchronous
    // audio initialization failure must not leave a visible but inert QR button.
    initializeIntroReader();
    if (enabled) startRenderer();
    else syncAudio();

    return {
      video, wrapper, area, ui, canvas, open,
      place(anchor) {
        if (anchor.nextElementSibling === ui) return;
        const reopen = dialog.open;
        open(false);
        anchor.after(ui);
        if (reopen) open();
      },
      dispose() {
        log('player.dispose', { mountId });
        dead = true;
        open(false);
        listeners.abort();
        audioRestorer?.destroy();
        audioRestorer = null;
        resizeObserver.disconnect();
        stopRenderer();
        gl?.getExtension('WEBGL_lose_context')?.loseContext();
        canvas.remove();
        ui.remove();
        for (const [element, position] of positioned) {
          if (element.style.position === 'relative') element.style.position = position;
        }
      },
    };
  }

  function scan() {
    scanHandle = null;
    if (disposed) return;
    const nextKey = videoPageKey(location.href);
    if (nextKey !== pageKey) {
      pageKey = nextKey;
      navigatedAt = performance.now();
      active?.dispose();
      active = null;
      settings = loadSettings();
      // A different BVID or part never inherits the previous video's state; it
      // restores only on its own verified memory.
      enabled = autoEnabled();
    }
    if (!pageKey) return;
    const toolbar = document.querySelector(TOOLBAR_SELECTOR);
    const candidates = [...document.querySelectorAll(SELECTOR)].filter((video) => video.getClientRects().length);
    candidates.sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight);
    const video = candidates[0] ?? null;
    if (toolbar && active?.video === video && active.wrapper === video?.parentElement &&
        active.area === video?.closest('.bpx-player-primary-area') && active.canvas.isConnected) {
      active.place(toolbar);
      return;
    }
    active?.dispose();
    active = video && toolbar ? mount(video, toolbar) : null;
  }
  function queueScan() {
    if (scanHandle === null && !disposed) scanHandle = requestAnimationFrame(scan);
  }
  const observer = new MutationObserver((records) => {
    if (active && (!active.video.isConnected || !active.ui.isConnected || !active.canvas.isConnected)) queueScan();
    for (const record of records) {
      for (const node of record.addedNodes) {
        const relevant = 'video, .bpx-player-primary-area, #arc_toolbar_report, .video-toolbar-left-main';
        if (node.nodeType === 1 && (node.matches(relevant) || node.querySelector(relevant))) queueScan();
      }
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  // URL changes from history.pushState have no native event. Also recover when
  // a preloaded player becomes visible without replacing its video node.
  const timer = setInterval(queueScan, 1000);
  const menuId = menu.register('VeilCast：还原参数', () => { scan(); active?.open(); });
  const lifetime = new AbortController();
  window.addEventListener('pageshow', queueScan, { signal: lifetime.signal });
  window.addEventListener('pagehide', (event) => { if (!event.persisted) dispose(); }, { signal: lifetime.signal });
  function dispose() {
    if (disposed) return;
    disposed = true;
    lifetime.abort();
    observer.disconnect();
    audioUrls?.stop();
    clearInterval(timer);
    if (scanHandle !== null) cancelAnimationFrame(scanHandle);
    active?.dispose();
    active = null;
    if (menuId !== undefined) menu.unregister(menuId);
  }
  scan();
  return { dispose };
}
