/** Browser integration only. The renderer and desktop defaults are injected by the build. */
export function installUserscript({ createRestorer, scanIntro, decodeQr, defaults, validateSettings, querySettings, descriptionSettings, videoPageKey, storage, menu }) {
  const SELECTOR = '.bpx-player-primary-area video';
  const TOOLBAR_SELECTOR = '#arc_toolbar_report .video-toolbar-left-main';
  const STORAGE_KEY = 'veilcast.bilibili.settings.v1';
  let settings;
  let settingsNotice = '';
  let enabled = false;
  let active = null;
  let scanHandle = null;
  let pageKey = videoPageKey(location.href);
  let disposed = false;

  function loadSettings() {
    settingsNotice = '';
    try {
      const saved = storage.get(STORAGE_KEY, {});
      return validateSettings({ ...saved, ...querySettings(location.search) }, defaults);
    } catch (error) {
      settingsNotice = `参数读取失败，已恢复默认值：${error.message}`;
      return validateSettings({}, defaults);
    }
  }
  settings = loadSettings();

  function mount(video, toolbar) {
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
        #open svg { width: 20px; height: 20px; flex-shrink: 0; }
        dialog { position: fixed; margin: 0; width: min(360px, calc(100vw - 24px)); max-width: none;
          padding: 16px; overflow-y: auto; border: 1px solid #46516b; border-radius: 12px;
          background: #141b2a; color: #ecf0f8; color-scheme: dark; box-shadow: 0 10px 36px #0007; }
        dialog::backdrop { background: #0003; }
        form { margin: 0; }
        header, .row { display: flex; align-items: center; gap: 8px; }
        header { justify-content: space-between; margin-bottom: 10px; }
        header strong { font-size: 14px; }
        label { display: flex; flex: 1; flex-direction: column; gap: 4px; min-width: 0; margin-bottom: 10px; }
        input { width: 100%; min-width: 0; padding: 6px 8px; border: 1px solid #46516b; border-radius: 6px; background: #0c1220; }
        .check { flex-direction: row; align-items: center; gap: 8px; }
        .check input { width: 16px; height: 16px; margin: 0; accent-color: #00aeec; }
        #from-description { padding: 4px 8px; margin-bottom: 10px; font-size: 12px; }
        p { margin: 8px 0 0; color: #b4c1d8; overflow-wrap: anywhere; }
        #toggle { flex: 1; background: #245b9c; }
        #status[data-error=true] { color: #ffb3b3; }
        small { display: block; color: #95a7c6; margin-bottom: 10px; }
      </style>
      <button id="open" type="button" aria-haspopup="dialog" aria-expanded="false" aria-controls="panel">
        <svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><path d="M3 3h7v7H3zm11 0h7v7h-7zM3 14h7v7H3zm11 0h7v7h-7z"/></svg>
        <span id="button-label">VeilCast · 关</span>
      </button>
      <dialog id="panel" aria-labelledby="panel-title">
      <form>
        <header><strong id="panel-title">VeilCast · 画面还原</strong><button id="close" type="button" aria-label="关闭设置">关闭</button></header>
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
        <label class="check"><input name="invert" type="checkbox">反色（与加密端保持一致）</label>
        <label class="check"><input name="autoIntro" type="checkbox">自动读取片头二维码并启用还原</label>
        <button id="from-description" type="button">读取简介参数</button>
        <div class="row"><button id="toggle" type="button">启用还原</button><button type="submit">应用参数</button><button id="reset" type="button">默认</button></div>
        <p id="status" role="status" aria-live="polite"></p>
        <small>只处理画面；声音、弹幕和播放控制仍由原播放器负责。</small>
      </form></dialog>`;
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
      for (const name of ['seed', 'tile', 'margin', 'width', 'height']) form.elements.namedItem(name).value = values[name];
      form.elements.namedItem('invert').checked = values.invert;
      form.elements.namedItem('autoIntro').checked = values.autoIntro;
    }
    // The first second of a VeilCast upload is a QR code carrying the plan.
    // Read it while the playhead is still inside that window, then apply and
    // switch the restorer on: only our own header parses, so nothing happens
    // on ordinary videos.
    let introScan = null;
    async function readIntroHeader() {
      if (dead || !settings.autoIntro || !scanIntro || !decodeQr) return;
      if (video.currentTime > 1.5 || video.readyState < 2) return;
      introScan?.abort();
      introScan = new AbortController();
      const signal = AbortSignal.any ? AbortSignal.any([introScan.signal, listeners.signal]) : introScan.signal;
      let header;
      try { header = await scanIntro(video, { decode: decodeQr, signal }); }
      catch { return; }
      if (!header || dead) return;
      fill({
        ...settings,
        width: header.width,
        height: header.height,
        tile: header.tile,
        margin: header.margin,
        invert: header.invert,
        seed: header.seed === null ? settings.seed : String(header.seed),
      });
      if (!apply()) return;
      if (!enabled) {
        enabled = true;
        startRenderer();
        updateToggle();
      }
      message(header.seed === null
        ? '已从片头二维码读取尺寸、tile、margin 和反色（片头不含 seed，沿用当前 seed）并启用还原。'
        : '已从片头二维码读取全部参数（含 seed）并启用还原。');
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
      enabled = false;
      stopRenderer();
      updateToggle();
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
            message(`还原中 · ${settings.width}×${settings.height} · 反色${settings.invert ? '开' : '关'} · 视频 ${video.videoWidth}×${video.videoHeight}${settingsNotice ? ` · ${settingsNotice}` : ''}`);
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
      } catch (error) { fail(error); }
      updateToggle();
    }
    function apply() {
      if (!form.reportValidity()) return false;
      try {
        const values = Object.fromEntries(new FormData(form));
        values.invert = form.elements.namedItem('invert').checked;
        values.autoIntro = form.elements.namedItem('autoIntro').checked;
        settings = validateSettings(values, defaults);
      } catch (error) { message(error.message, true); return false; }
      settingsNotice = '';
      try { storage.set(STORAGE_KEY, settings); }
      catch { settingsNotice = '设置保存失败，本次会话仍有效'; }
      if (enabled) startRenderer();
      else message(`参数已应用；还原处于关闭状态。${settingsNotice}`);
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
    on(toggle, 'click', () => {
      if (enabled) {
        enabled = false;
        stopRenderer();
        updateToggle();
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
    });
    // Do not let the player's shortcuts intercept typing or buttons in the panel.
    for (const name of ['keydown', 'keyup', 'keypress', 'pointerdown', 'click', 'dblclick']) {
      on(ui, name, (event) => event.stopPropagation());
    }
    for (const name of ['play', 'playing', 'loadeddata', 'seeked']) on(video, name, render);
    on(video, 'loadeddata', () => { readIntroHeader(); });
    if (video.readyState >= 2) readIntroHeader();
    for (const name of ['pause', 'ended']) on(video, name, () => { cancelFrame(); render(); });
    for (const name of ['loadstart', 'emptied']) on(video, name, () => {
      cancelFrame();
      hasDrawn = false;
      canvas.style.visibility = 'hidden';
      if (enabled) message('视频源切换中…');
    });
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
    if (enabled) startRenderer();

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
        dead = true;
        open(false);
        listeners.abort();
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
      enabled = false; // Never silently restore a different BVID or multi-part video.
      active?.dispose();
      active = null;
      settings = loadSettings();
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
    clearInterval(timer);
    if (scanHandle !== null) cancelAnimationFrame(scanHandle);
    active?.dispose();
    active = null;
    if (menuId !== undefined) menu.unregister(menuId);
  }
  scan();
  return { dispose };
}
