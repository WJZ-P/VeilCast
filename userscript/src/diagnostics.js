/** Local-only, bounded diagnostics. Never persist or transmit media, seeds or URLs. */
export function createDiagnostics({ version = 'unknown', sink = console, capacity = 250, now = () => new Date().toISOString() } = {}) {
  const entries = [];
  let sequence = 0;
  const limit = Math.max(1, Math.min(1000, Math.trunc(capacity) || 250));
  const secret = /^(seed|token|cookie|authorization|rawValue|rawText|payload|url|src|currentSrc|href|pixels|imageData)$/i;
  const cleanText = (value) => String(value)
    .replace(/(?:https?:\/\/|blob:|data:)\S+/gi, '[URL]')
    .replace(/[0-9]{20,}/g, '[long numeric payload]')
    .slice(0, 500);
  function snapshot(value, depth = 0) {
    if (depth > 4) return '[depth limit]';
    if (value instanceof Error || (value && typeof value === 'object' && typeof value.name === 'string' && typeof value.message === 'string')) {
      return { name: cleanText(value.name), message: cleanText(value.message) };
    }
    if (typeof value === 'string') return cleanText(value);
    if (typeof value === 'bigint') return '[bigint]';
    if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
    if (value == null || typeof value === 'boolean') return value;
    if (Array.isArray(value)) return value.slice(0, 20).map((item) => snapshot(item, depth + 1));
    if (typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 40)
      .map(([key, item]) => [key, secret.test(key) ? '[redacted]' : snapshot(item, depth + 1)]));
    return `[${typeof value}]`;
  }
  return {
    log(event, details = {}, level = 'info') {
      const entry = { sequence: ++sequence, time: now(), level, event: cleanText(event), details: snapshot(details) };
      entries.push(entry);
      if (entries.length > limit) entries.shift();
      const method = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info';
      // Log a string snapshot, not live references which DevTools may expand later.
      try { sink?.[method]?.(`[VeilCast ${version}] #${entry.sequence} ${entry.event}`, JSON.stringify(entry.details)); }
      catch { /* Console failures must not change playback or decoding. */ }
    },
    dump() {
      return `VeilCast ${version} diagnostics (local, redacted)\n${entries.map((entry) => JSON.stringify(entry)).join('\n')}`;
    },
  };
}

/** A media snapshot with no source URL or pixel data. */
export function introVideoState(video) {
  const source = video.currentSrc || video.src || '';
  return {
    currentTime: video.currentTime, readyState: video.readyState, networkState: video.networkState,
    paused: video.paused, seeking: video.seeking, ended: video.ended,
    videoWidth: video.videoWidth, videoHeight: video.videoHeight, connected: video.isConnected,
    crossOrigin: video.crossOrigin ?? null,
    sourceKind: video.srcObject ? 'stream' : source.startsWith('blob:') ? 'blob' : source.startsWith('data:') ? 'data' : source ? 'url' : 'empty',
  };
}
