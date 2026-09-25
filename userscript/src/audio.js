/**
 * Audio restoration for the userscript: the page plays the uploaded track,
 * whose time runs backwards inside every block, so the script fetches that
 * same track, turns the blocks back, and plays the result from a hidden
 * <audio> element kept in step with the video.
 *
 * The whole track is decoded up front, which removes any need for look-ahead
 * and lets the block grid be found in the signal itself; the price is
 * memory: about 190 KB per second of stereo while playing, several times that
 * briefly while decoding.
 */

const AUDIO_RATE = 48000;
// Bilibili DASH audio stream ids: AAC 64k/132k/192k, Dolby, Hi-Res.
const BILIBILI_AUDIO = /-(?:30216|30232|30280|30250|30251)\.m4s(?:[?#]|$)/;
// Media elements can be captured by Web Audio only once in their lifetime.
const captures = new WeakMap();

/** Inspect container structure only. No audio samples, URLs or arbitrary payload text are returned. */
export function inspectAudioBytes(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const tag = (at) => String.fromCharCode(...bytes.subarray(at, at + 4));
  const result = { format: 'unknown', bytes: bytes.length };
  if (bytes.length >= 12 && tag(0) === 'RIFF' && tag(8) === 'WAVE') return { ...result, format: 'wav' };
  if (tag(0) === 'fLaC') return { ...result, format: 'flac' };
  if (tag(0) === 'OggS') return { ...result, format: 'ogg' };
  if (tag(0).startsWith('ID3')) return { ...result, format: 'mp3' };
  const topTypes = new Set(['ftyp', 'styp', 'moov', 'moof', 'mdat', 'sidx', 'free', 'skip', 'wide', 'mfra']);
  if (bytes.length < 8 || !topTypes.has(tag(4))) return result;
  Object.assign(result, { format: 'mp4', boxes: [], codecs: [], hasMoov: false, hasMoof: false, truncated: false, limitedInspection: false });
  const containers = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl']);
  const codecs = new Set(['mp4a', 'ac-3', 'ec-3', 'Opus', 'fLaC', 'alac', 'enca', 'avc1', 'hvc1', 'hev1', 'av01', 'vp09']);
  let count = 0;
  function walk(start, end, depth) {
    let at = start;
    while (at < end) {
      if (++count > 512 || depth > 8) { result.limitedInspection = true; return; }
      if (at + 8 > end) { result.truncated = true; return; }
      const type = tag(at + 4);
      let size = view.getUint32(at);
      let header = 8;
      if (size === 1) {
        if (at + 16 > end) { result.truncated = true; return; }
        size = view.getUint32(at + 8) * 4294967296 + view.getUint32(at + 12);
        header = 16;
      } else if (size === 0) size = end - at;
      if (!Number.isSafeInteger(size) || size < header || at + size > end) { result.truncated = true; return; }
      if (depth === 0) {
        if (result.boxes.length < 16) result.boxes.push(topTypes.has(type) ? type : 'other');
        if (type === 'moov') result.hasMoov = true;
        if (type === 'moof') result.hasMoof = true;
      }
      if (codecs.has(type) && !result.codecs.includes(type)) result.codecs.push(type);
      if (containers.has(type)) walk(at + header, at + size, depth + 1);
      if (type === 'stsd' && size >= header + 8) walk(at + header + 8, at + size, depth + 1);
      at += size;
    }
  }
  walk(0, bytes.length, 0);
  result.fragmentWithoutInit = !result.limitedInspection && result.hasMoof && !result.hasMoov;
  return result;
}

/** Retry a provably partial response once using an open-ended byte range. */
export async function fetchAudioFile(url, { signal, trace = () => {}, request = fetch } = {}) {
  const note = (event, details) => { try { trace(event, details); } catch { /* Optional diagnostics. */ } };
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const response = await request(url, { signal, ...(attempt === 2 ? { headers: { Range: 'bytes=0-' } } : {}) });
    const type = response.headers?.get?.('content-type')?.split(';')[0] ?? null;
    const rawRange = response.headers?.get?.('content-range') ?? '';
    const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/i.exec(rawRange);
    const range = match ? { start: Number(match[1]), end: Number(match[2]), total: match[3] === '*' ? null : Number(match[3]) } : null;
    note('download-response', { attempt, httpStatus: response.status, contentType: type, range });
    if (!response.ok) throw new Error('下载音轨失败：HTTP ' + response.status);
    if (type === 'text/html' || type === 'application/json') throw new Error('音轨请求返回了非音频内容：' + type);
    const buffer = await response.arrayBuffer();
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const info = inspectAudioBytes(buffer);
    note('download-inspected', { attempt, ...info });
    const partial = response.status === 206 && (!range || range.start !== 0 || range.total === null || range.end + 1 !== range.total || buffer.byteLength !== range.total);
    const incomplete = info.truncated || info.fragmentWithoutInit;
    if (attempt === 1 && (partial || incomplete)) {
      note('download-full-retry', { partialResponse: partial, incompleteContainer: Boolean(incomplete) });
      continue;
    }
    // A hidden Content-Range alone is not proof of truncation after retry.
    const provenPartial = response.status === 206 && range && (range.start !== 0 ||
      (range.total !== null && (range.end + 1 !== range.total || buffer.byteLength !== range.total)));
    if (provenPartial || incomplete) {
      throw new Error(info.fragmentWithoutInit ? '下载结果缺少 MP4 初始化信息（moov），不是完整音轨。'
        : '下载结果仍是不完整的音轨，请复制 download-response / download-inspected 日志。');
    }
    return buffer;
  }
}

/** The most recent audio request at or after `since` (ms, performance time). */
export function pickAudioUrl(entries, { since = 0, pattern = BILIBILI_AUDIO } = {}) {
  let latest = null;
  for (const entry of entries) {
    if (entry.startTime >= since && pattern.test(entry.name) && (!latest || entry.startTime >= latest.startTime)) {
      latest = entry;
    }
  }
  return latest?.name ?? null;
}

/**
 * Remembers the audio files the page's player fetches. Bilibili plays DASH
 * through Media Source Extensions, so the element itself only has a blob:
 * URL; the separate audio .m4s shows up in resource timing instead.
 */
export function watchAudioUrls() {
  const entries = [];
  let observer = null;
  try {
    observer = new PerformanceObserver((list) => { entries.push(...list.getEntries()); });
    observer.observe({ type: 'resource', buffered: true });
  } catch {
    entries.push(...performance.getEntriesByType('resource'));
  }
  return {
    latest: (since) => pickAudioUrl(entries, { since }),
    stop: () => observer?.disconnect(),
  };
}

/** Where the audio of `video` can be fetched: its own URL, or the page's audio track. */
export async function locateAudio(video, watcher, { since = 0, timeoutMs = 20000, signal } = {}) {
  const started = Date.now();
  for (;;) {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    if (/^https?:/i.test(video.currentSrc)) return video.currentSrc;
    const url = watcher.latest(since);
    if (url) return url;
    if (Date.now() - started > timeoutMs) throw new Error('找不到这个视频的音轨地址');
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/**
 * Silences the page's own output for `video`. Returns the mode, the mute
 * state the restored track should follow, and a function that hands the
 * sound back.
 *
 * Preferred: route the element through Web Audio at zero gain, which leaves
 * its mute state and the player's controls alone. Routing moves the element's
 * clock onto the audio graph, though, so the graph must run or the video
 * itself stops; an AudioContext can only start after a user gesture on the
 * page. Without one (or when the element is already captured elsewhere) the
 * element is muted instead, which never touches its clock.
 */
function silence(video, trace = () => {}) {
  if (navigator.userActivation?.hasBeenActive) {
    let unusedContext = null;
    let attached = false;
    try {
      let capture = captures.get(video);
      if (!capture) {
        const context = new AudioContext();
        unusedContext = context;
        // Do not attach a video to a suspended graph: that can stall its clock.
        if (context.state !== 'running') throw new Error('Web Audio context is not running; use mute fallback');
        const gain = context.createGain();
        const source = context.createMediaElementSource(video);
        attached = true;
        source.connect(gain).connect(context.destination);
        capture = { context, gain };
        captures.set(video, capture);
      }
      const resume = () => {
        capture.context.resume().catch((error) => trace('capture-resume-error', { error, contextState: capture.context.state }));
      };
      resume();
      capture.gain.gain.value = 0;
      trace('original-silenced', { mode: 'captured', contextState: capture.context.state });
      let restored = false;
      return {
        mode: 'captured',
        muted: () => video.muted,
        resume,
        contextState: () => capture.context.state,
        restore() {
          if (restored) return;
          restored = true;
          capture.gain.gain.value = 1;
          resume();
        },
      };
    } catch (error) {
      // Captured by the page itself; fall back to muting.
      trace('capture-unavailable', { error });
      if (unusedContext && !attached) unusedContext.close().catch(() => {});
    }
  }
  let wanted = video.muted;
  video.muted = true;
  trace('original-silenced', { mode: 'muted', wantedMuted: wanted });
  let restored = false;
  return {
    mode: 'muted',
    // The player shows "muted" throughout; unmuting there means "let me hear
    // it", so the restored track unmutes and the page's own stays silent.
    muted() {
      if (!video.muted) {
        wanted = false;
        video.muted = true;
      }
      return wanted;
    },
    restore() { if (!restored) { restored = true; video.muted = wanted; } },
  };
}

/**
 * Starts restoring the audio of `video`, whose blocks of `blockMs` begin
 * `introSeconds` into the media (the intro QR second); with `mirror` the
 * reversed content was spectrum-mirrored afterwards. `report(state, text)`
 * receives 'loading' | 'ready' | 'blocked' | 'error' with a message.
 * disable()/enable() hand sound back and reuse the prepared WAV and media
 * element. destroy() additionally cancels work and releases the cached URL.
 */
export function createAudioRestorer({ video, blockMs, mirror = false, introSeconds = 1, host, locate, report, findAudioGrid, findAudioSync,
  reverseAudioBlocks, mirrorAudioSpectrumAsync, encodeWav, trace = () => {} }) {
  const abort = new AbortController();
  const audio = document.createElement('audio');
  audio.dataset.veilcastAudio = '';
  audio.preload = 'auto';
  host.append(audio);
  let objectUrl = null;
  let prepared = false;
  let active = false;
  let destroyed = false;
  let silenced = null;
  let preparation = null;
  let epoch = 0;
  let playPending = null;
  let playBlocked = false;
  let playFailed = false;
  let mediaFailed = false;
  let needsAlignment = true;
  let lastState = '';
  let loadingText = '音频：正在查找音轨，当前播放原声…';
  let readyText = '';

  const note = (event, details = {}) => {
    try { trace(event, { active, epoch, prepared, blockMs, videoTime: video.currentTime,
      videoPaused: video.paused, videoReadyState: video.readyState, originalMuted: video.muted,
      audioTime: audio.currentTime, audioReadyState: audio.readyState, audioPaused: audio.paused,
      audioMuted: audio.muted, volume: video.volume, mode: silenced?.mode,
      contextState: silenced?.contextState?.(), ...details }); } catch { /* Diagnostics are optional. */ }
  };
  function status(state, text) {
    if (destroyed || !active || lastState === state + ':' + text) return;
    lastState = state + ':' + text;
    try { report(state, text); } catch (error) { note('report-error', { error }); }
  }
  function pauseAudio() {
    playPending = null;
    audio.pause();
  }
  function restoreOriginal(reason) {
    pauseAudio();
    const previous = silenced;
    silenced = null;
    previous?.restore();
    note('original-restored', { reason });
  }
  function startPlayback() {
    if (playPending || playBlocked || playFailed || !audio.paused) return;
    const attempt = { epoch };
    playPending = attempt;
    note('play-request');
    let result;
    try { result = audio.play(); }
    catch (error) { result = Promise.reject(error); }
    Promise.resolve(result).then(() => {
      if (destroyed || !active) { audio.pause(); return; }
      if (attempt.epoch !== epoch || playPending !== attempt) return;
      // Hand over only after the replacement media has actually started.
      if (!silenced) silenced = silence(video, note);
      audio.muted = silenced.muted();
      audio.volume = video.volume;
      note('play-started');
      status('ready', readyText + ' · 播放中');
    }).catch((error) => {
      if (destroyed || !active || attempt.epoch !== epoch || playPending !== attempt) return;
      note('play-rejected', { error });
      restoreOriginal('play-rejected');
      if (error.name === 'AbortError') return;
      if (error.name === 'NotAllowedError') {
        playBlocked = true;
        status('blocked', '还原音轨播放被浏览器拦截，已恢复原声（未还原）；点击页面或再次应用参数重试。');
      } else {
        playFailed = true;
        mediaFailed = error.name === 'NotSupportedError';
        status('error', '还原音轨播放失败，已恢复原声（未还原）：' + (error.name ?? 'Error') + '：' + (error.message ?? error));
      }
    }).finally(() => { if (playPending === attempt) playPending = null; });
  }

  function follow() {
    if (destroyed || !active || playBlocked || playFailed) return;
    const muted = silenced ? silenced.muted() : video.muted;
    audio.volume = video.volume;
    audio.muted = muted;
    // Source assignment is not proof that the media element can seek yet.
    // loadedmetadata/canplay will resume synchronization when it becomes ready.
    if (!prepared) return;
    if (audio.readyState < 1) {
      if (!mediaFailed) status('loading', '音轨已还原，等待音频播放器就绪…');
      return;
    }
    if (video.paused || video.ended || video.seeking || video.readyState < 3) {
      audio.playbackRate = video.playbackRate;
      pauseAudio();
      needsAlignment = true;
      if (Math.abs(audio.currentTime - video.currentTime) > 0.01) audio.currentTime = video.currentTime;
      status('ready', readyText + (video.paused ? ' · 跟随视频暂停' : ' · 等待视频就绪'));
      return;
    }
    if (Number.isFinite(audio.duration) && audio.duration > 0 && video.currentTime >= audio.duration) {
      pauseAudio();
      status('ready', readyText + ' · 当前进度已到音轨末尾');
      return;
    }
    const lag = video.currentTime - audio.currentTime;
    if (needsAlignment || Math.abs(lag) > 0.25) {
      audio.currentTime = video.currentTime;
      audio.playbackRate = video.playbackRate;
      needsAlignment = false;
      note('aligned');
    } else {
      const nudge = Math.abs(lag) > 0.015 ? Math.max(-0.1, Math.min(0.1, lag)) : 0;
      audio.playbackRate = video.playbackRate * (1 + nudge);
    }
    startPlayback();
  }
  const events = ['play', 'playing', 'canplay', 'pause', 'waiting', 'seeking', 'seeked', 'ratechange', 'volumechange', 'timeupdate', 'ended'];
  for (const name of events) video.addEventListener(name, follow, { signal: abort.signal });
  for (const name of ['loadedmetadata', 'loadeddata', 'canplay', 'seeked']) {
    audio.addEventListener(name, () => { note('media-ready', { event: name }); follow(); }, { signal: abort.signal });
  }
  audio.addEventListener('error', () => {
    if (destroyed) return;
    playFailed = true;
    mediaFailed = true;
    note('media-error', { code: audio.error?.code, message: audio.error?.message });
    restoreOriginal('media-error');
    status('error', '还原音轨加载失败，已恢复原声（未还原）：' + (audio.error?.message || '媒体错误 ' + (audio.error?.code ?? '?')));
  }, { signal: abort.signal });
  // One listener per handle, rather than one per rejected play() call.
  document.addEventListener('pointerdown', () => {
    if (!active || destroyed || !playBlocked) return;
    note('gesture-retry');
    playBlocked = false;
    silenced?.resume?.();
    follow();
  }, { capture: true, signal: abort.signal });

  async function prepare() {
    let stage = 'locate';
    try {
      loadingText = '音频：正在查找音轨，当前播放原声…';
      status('loading', loadingText);
      note('locate-start');
      const url = await locate(abort.signal);
      if (destroyed) return;
      stage = 'download';
      loadingText = '音频：正在下载音轨，当前播放原声…';
      status('loading', loadingText);
      note('download-start');
      const bytes = await fetchAudioFile(url, { signal: abort.signal, trace: note });
      if (destroyed) return;
      note('download-complete', { bytes: bytes.byteLength });
      stage = 'decode';
      loadingText = '音频：正在解码并还原，当前播放原声…';
      status('loading', loadingText);
      const decoded = await new OfflineAudioContext(1, 1, AUDIO_RATE).decodeAudioData(bytes);
      if (destroyed) return;
      stage = 'restore';
      const channels = Array.from({ length: decoded.numberOfChannels }, (_, i) => decoded.getChannelData(i));
      const nominal = Math.round(introSeconds * AUDIO_RATE);
      // A mirrored upload marks its content start with a chirp in the intro; the blind grid search is the fallback.
      const sync = mirror ? findAudioSync(channels, { sampleRate: AUDIO_RATE, nominalStart: nominal }) : null;
      const grid = sync?.confidence >= 20 ? sync
        : findAudioGrid(channels, { sampleRate: AUDIO_RATE, blockMs, nominalStart: nominal, mirrored: mirror });
      const start = grid.confidence >= 2 ? grid.start : nominal;
      const block = Math.round((AUDIO_RATE * blockMs) / 1000);
      // Undone in the opposite order: the mirror ran after the reversal, anchored at the content start.
      if (mirror) await mirrorAudioSpectrumAsync(channels, { anchor: start, signal: abort.signal });
      if (destroyed) return;
      reverseAudioBlocks(channels, { sampleRate: AUDIO_RATE, blockMs, start: ((start % block) + block) % block });
      // The intro second (QR picture, sync chirp) stays silent.
      if (mirror) for (const data of channels) data.fill(0, 0, Math.max(0, start));
      const wav = encodeWav(channels, AUDIO_RATE, { offset: start - nominal });
      if (destroyed) return;
      objectUrl = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
      prepared = true;
      const shift = ((start - nominal) / AUDIO_RATE) * 1000;
      readyText = '音频已还原' + (mirror ? ' · 频谱翻转' : '') + ' · 块长 ' + blockMs + ' ms · 对齐 ' + (shift >= 0 ? '+' : '') + shift.toFixed(1) + ' ms';
      audio.src = objectUrl;
      audio.load();
      note('prepared', { channels: decoded.numberOfChannels, offsetMs: shift, mirror, syncConfidence: sync?.confidence, gridConfidence: grid.confidence });
      status('ready', readyText);
      follow();
    } catch (error) {
      if (destroyed) return;
      note('prepare-error', { stage, error });
      restoreOriginal('prepare-error');
      status('error', '音频还原失败，已恢复原声（未还原）：' + (error.name ?? 'Error') + '：' + (error.message ?? error));
    }
  }

  function enable() {
    if (destroyed) return;
    if (!active) {
      active = true;
      epoch++;
      needsAlignment = true;
    }
    lastState = '';
    playBlocked = false;
    playFailed = false;
    silenced?.resume?.();
    note('enabled', { cacheHit: prepared });
    if (prepared) {
      if (mediaFailed) {
        mediaFailed = false;
        audio.load();
      }
      status('ready', readyText + ' · 复用已还原音轨');
      follow(); // Ready cached media can play inside the user's enable click.
    } else {
      status('loading', loadingText);
      if (!preparation) preparation = prepare().finally(() => { preparation = null; });
    }
  }
  function disable() {
    if (destroyed || !active) return;
    active = false;
    epoch++;
    restoreOriginal('disabled');
    note('disabled', { cacheRetained: prepared });
  }
  function destroy() {
    if (destroyed) return;
    disable();
    destroyed = true;
    abort.abort();
    pauseAudio();
    audio.removeAttribute('src');
    audio.load();
    audio.remove();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = null;
    note('destroyed');
  }
  try { enable(); } catch (error) { destroy(); throw error; }
  return { blockMs, mirror, get mode() { return silenced?.mode ?? 'inactive'; }, enable, disable, destroy };
}
