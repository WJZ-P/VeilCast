/** Media-event coordination, separate from DOM UI so seek/buffering races are testable. */
export function createIntroReader(video, {
  scan, decode, enabled, onHeader, report = () => {}, isCurrent = () => true,
  untilSeconds = 1.5, signal, trace = () => {},
}) {
  const lifetime = new AbortController();
  let stopped = false;
  let accepted = false;
  let attempted = false;
  let pending = null;
  let scanId = 0;
  let lastSkip = '';

  const note = (event, details = {}) => {
    try { trace(event, { currentTime: video.currentTime, readyState: video.readyState, seeking: video.seeking, paused: video.paused, ...details }); }
    catch { /* Diagnostics must not interrupt the reader. */ }
  };
  const state = (value, error) => {
    note('state', { state: value, scanId: pending?.id, error });
    try { report(value, error); } catch (failure) { note('report-failed', { error: failure }); }
  };
  function skip(reason, manual) {
    if (manual || lastSkip !== reason) note('request-skipped', { reason, manual });
    lastSkip = reason;
    if (manual) state('error', new Error(reason === 'stopped'
      ? '二维码读码器已停止，请重新打开设置窗口。'
      : '当前视频绑定已过期，请重新打开设置窗口或刷新页面。'));
    return false;
  }

  function cancel(reason = 'cancelled') {
    const old = pending;
    pending = null; // Invalidate a decoder that ignores cancellation, too.
    if (old) note('scan-cancelled', { scanId: old.id, reason });
    old?.controller.abort();
  }

  function reset() {
    cancel();
    accepted = false;
    attempted = false;
    if (!stopped) state(enabled() ? 'waiting' : 'off');
  }

  async function request({ manual = false, retry = false } = {}) {
    if (manual) note('manual-request', { stopped, retry, pendingScanId: pending?.id });
    if (stopped) return skip('stopped', manual);
    if (!isCurrent()) return skip('stale-video-binding', manual);
    if (!manual && pending?.manual) return skip('manual-scan-running', false);
    if (!manual && !enabled()) {
      if (pending && !pending.manual) cancel();
      if (lastSkip !== 'auto-disabled') state('off');
      skip('auto-disabled', false);
      return false;
    }
    if (!manual && video.currentTime > untilSeconds) {
      if (pending && !pending.manual) cancel('left-intro-window');
      attempted = false;
      return skip('outside-intro-window', false);
    }
    if (!manual && (accepted || pending || (attempted && !retry))) {
      return skip(accepted ? 'already-applied' : pending ? 'scan-running' : 'visit-attempt-finished', false);
    }
    if (manual) cancel('manual-retry');

    // Start even at HAVE_METADATA: scan() waits for a usable, non-seeking frame.
    const run = { controller: new AbortController(), manual, id: ++scanId };
    pending = run;
    attempted = true;
    lastSkip = '';
    note('scan-start', { scanId: run.id, manual, untilSeconds: manual ? 'current-frame' : untilSeconds });
    state('scanning');
    try {
      const header = await scan(video, {
        decode, signal: run.controller.signal,
        untilSeconds: manual ? Infinity : untilSeconds,
        onProgress: (event, details) => {
          if (pending !== run) return;
          note(`scanner.${event}`, { scanId: run.id, ...details });
        },
      });
      if (stopped || pending !== run || run.controller.signal.aborted || !isCurrent()) {
        note('result-discarded', { scanId: run.id, stopped, superseded: pending !== run, aborted: run.controller.signal.aborted, currentBinding: isCurrent() });
        if (manual && !stopped && pending === run) state('error', new Error('识别期间视频绑定发生变化，请重新识别。'));
        return false;
      }
      if (!manual && (!enabled() || video.currentTime > untilSeconds)) {
        note('result-discarded', { scanId: run.id, reason: 'auto-disabled-or-left-intro' });
        return false;
      }
      if (!header) {
        state('missing');
        return false;
      }
      // This callback is synchronous. Latch only AFTER the UI accepts the plan.
      note('apply-start', { scanId: run.id, width: header.width, height: header.height, tile: header.tile,
        margin: header.margin, invert: header.invert, audioMs: header.audioMs, audioMirror: header.audioMirror, hasSeed: header.seed !== null });
      if (onHeader(header) === false) {
        note('apply-rejected', { scanId: run.id });
        state('error', new Error('片头参数未成功应用，请检查设置后重试。'));
        return false;
      }
      accepted = true;
      note('apply-complete', { scanId: run.id });
      state('found');
      return true;
    } catch (error) {
      if (!stopped && pending === run && !run.controller.signal.aborted) {
        note('scan-error', { scanId: run.id, error });
        state('error', error);
      }
      return false;
    } finally {
      if (pending === run) { note('scan-finished', { scanId: run.id, accepted }); pending = null; }
    }
  }

  const on = (name, callback) => video.addEventListener(name, callback, { signal: lifetime.signal });
  for (const name of ['loadstart', 'emptied']) on(name, () => { note('media-event', { type: name }); reset(); });
  on('seeking', () => {
    note('media-event', { type: 'seeking' });
    cancel('seeking');
    attempted = false;
    if (!accepted && enabled()) state('waiting');
  });
  // A new frame after seek may arrive through canplay/playing without another
  // loadeddata event. Event bursts share one in-flight scan rather than aborting it.
  for (const name of ['loadeddata', 'canplay', 'playing', 'play', 'seeked']) {
    on(name, () => { note('media-event', { type: name }); void request({ retry: true }); });
  }
  // Backstop for a player which changes time without a normal seek event pair.
  // Failed attempts are not restarted on every timeupdate while paused at zero.
  on('timeupdate', () => { void request(); });

  function stop() {
    if (stopped) return;
    stopped = true;
    cancel('disposed');
    lifetime.abort();
    signal?.removeEventListener('abort', stop);
  }
  if (signal?.aborted) stop();
  else {
    signal?.addEventListener('abort', stop, { once: true });
    state(enabled() ? 'waiting' : 'off');
    void request();
  }
  return { request, reset, stop };
}
