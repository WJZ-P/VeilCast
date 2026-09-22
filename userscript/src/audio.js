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
function silence(video) {
  if (navigator.userActivation?.hasBeenActive) {
    try {
      let capture = captures.get(video);
      if (!capture) {
        const context = new AudioContext();
        const gain = context.createGain();
        context.createMediaElementSource(video).connect(gain).connect(context.destination);
        capture = { context, gain };
        captures.set(video, capture);
      }
      capture.context.resume().catch(() => {});
      capture.gain.gain.value = 0;
      return {
        mode: 'captured',
        muted: () => video.muted,
        restore() {
          capture.gain.gain.value = 1;
          capture.context.resume().catch(() => {});
        },
      };
    } catch {
      // Captured by the page itself; fall back to muting.
    }
  }
  let wanted = video.muted;
  video.muted = true;
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
    restore() { video.muted = wanted; },
  };
}

/**
 * Starts restoring the audio of `video`, whose blocks of `blockMs` begin
 * `introSeconds` into the media (the intro QR second). `report(state, text)`
 * receives 'loading' | 'ready' | 'error' with a message. The returned handle's
 * destroy() stops playback and hands the sound back to the page.
 */
export function createAudioRestorer({ video, blockMs, introSeconds = 1, host, locate, report, findAudioGrid, reverseAudioBlocks, encodeWav }) {
  const abort = new AbortController();
  const silenced = silence(video);
  const audio = document.createElement('audio');
  audio.dataset.veilcastAudio = '';
  audio.preload = 'auto';
  host.append(audio);
  let objectUrl = null;
  let ready = false;

  function follow() {
    // Before anything else, so an unmute in the player never lets the
    // scrambled track through, even while the restored one is loading.
    const muted = silenced.muted();
    if (!ready) return;
    audio.volume = video.volume;
    audio.muted = muted;
    if (video.paused || video.ended || video.seeking || video.readyState < 3) {
      audio.playbackRate = video.playbackRate;
      audio.pause();
      // Keep the position too, so scrubbing while paused resumes in step.
      if (Math.abs(audio.currentTime - video.currentTime) > 0.01) audio.currentTime = video.currentTime;
      return;
    }
    // Drift is pulled in by running fast or slow in proportion to it, at most
    // 10% (pitch is preserved, so it goes unnoticed); only a jump such as a
    // seek resyncs hard, since every hard resync restarts the audio late.
    const lag = video.currentTime - audio.currentTime;
    if (Math.abs(lag) > 0.25) {
      audio.currentTime = video.currentTime;
      audio.playbackRate = video.playbackRate;
    } else {
      const nudge = Math.abs(lag) > 0.015 ? Math.max(-0.1, Math.min(0.1, lag)) : 0;
      audio.playbackRate = video.playbackRate * (1 + nudge);
    }
    if (audio.paused) {
      audio.play().catch(() => {
        report('ready', '音频已还原，但浏览器拦截了自动播放：点击页面任意处即可听到。');
        document.addEventListener('pointerdown', follow, { once: true, capture: true, signal: abort.signal });
      });
    }
  }
  const events = ['play', 'playing', 'pause', 'waiting', 'seeking', 'seeked', 'ratechange', 'volumechange', 'timeupdate', 'ended'];
  for (const name of events) video.addEventListener(name, follow, { signal: abort.signal });

  (async () => {
    try {
      report('loading', '音频：正在查找音轨…');
      const url = await locate(abort.signal);
      report('loading', '音频：正在下载音轨…');
      const response = await fetch(url, { signal: abort.signal });
      if (!response.ok) throw new Error(`下载音轨失败：HTTP ${response.status}`);
      const bytes = await response.arrayBuffer();
      report('loading', '音频：正在解码并还原…');
      const decoded = await new OfflineAudioContext(1, 1, AUDIO_RATE).decodeAudioData(bytes);
      if (abort.signal.aborted) return;
      const channels = Array.from({ length: decoded.numberOfChannels }, (_, i) => decoded.getChannelData(i));
      const nominal = Math.round(introSeconds * AUDIO_RATE);
      const grid = findAudioGrid(channels, { sampleRate: AUDIO_RATE, blockMs, nominalStart: nominal });
      // Nothing to lock onto (e.g. a silent track): trust the nominal grid.
      const start = grid.confidence >= 2 ? grid.start : nominal;
      // Blocks are reversed from the first grid point in the file; those
      // inside the intro only hold silence, so reversing them is harmless and
      // keeps a missing intro from leaving the first blocks backwards.
      const block = Math.round((AUDIO_RATE * blockMs) / 1000);
      reverseAudioBlocks(channels, { sampleRate: AUDIO_RATE, blockMs, start: ((start % block) + block) % block });
      const wav = encodeWav(channels, AUDIO_RATE, { offset: start - nominal });
      if (abort.signal.aborted) return;
      objectUrl = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
      audio.src = objectUrl;
      ready = true;
      const shift = ((start - nominal) / AUDIO_RATE) * 1000;
      report('ready', `音频已还原 · 块长 ${blockMs} ms · 对齐 ${shift >= 0 ? '+' : ''}${shift.toFixed(1)} ms`);
      follow();
    } catch (error) {
      if (abort.signal.aborted) return;
      // The page's own track is scrambled, so it stays silent: noise would not help.
      report('error', `音频还原失败，原声保持静音：${error.message ?? error}`);
    }
  })();

  return {
    blockMs,
    mode: silenced.mode,
    destroy() {
      abort.abort();
      audio.pause();
      audio.removeAttribute('src');
      audio.remove();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      silenced.restore();
    },
  };
}
