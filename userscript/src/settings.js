/**
 * The userscript's defaults from the desktop app's settings file. The desktop
 * keeps a block length even while its audio switch is off; here 0 means off.
 */
export function userscriptDefaults(app) {
  const { width, height, tile, margin, seed, invert, autoIntro = true, audio = false, audioMs = 0, audioMirror = false } = app;
  return { width, height, tile, margin, seed, invert, autoIntro, audioMs: audio ? audioMs : 0, audioMirror: audio && audioMirror };
}

/** Validate desktop-compatible YUV420 parameters. Seed text is never trimmed. */
export function validateSettings(input, defaults) {
  const settings = {};
  for (const name of ['width', 'height', 'tile', 'margin']) {
    const value = input[name] ?? (name === 'tile' ? input.tail : undefined) ?? defaults[name];
    if ((typeof value !== 'string' && typeof value !== 'number') || String(value).trim() === '') {
      throw new Error(`${name} 需要整数`);
    }
    settings[name] = Number(value);
    const minimum = name === 'margin' ? 0 : 1;
    if (!Number.isSafeInteger(settings[name]) || settings[name] < minimum || settings[name] > 16384) {
      throw new Error(`${name} 需要 ${minimum}–16384 范围内的整数`);
    }
  }
  if (settings.tile % 2 || settings.margin % 2) throw new Error('tile 和 margin 需要偶数，与 Tauri 一致');
  const count = Math.ceil(settings.width / settings.tile) * Math.ceil(settings.height / settings.tile);
  if (count > 262144) throw new Error('方块数量超过 262144，请增大 tile');
  if (settings.width * settings.height > 7680 * 4320) throw new Error('原始画面像素总量超过 8K 上限');
  const seed = input.seed ?? defaults.seed;
  if (typeof seed !== 'string') throw new Error('seed 需要文本，避免大整数精度丢失');
  if (seed.length > 4096) throw new Error('seed 最长 4096 个字符');
  settings.seed = seed;
  settings.invert = parseInvert(input.invert ?? defaults.invert ?? false);
  settings.autoIntro = parseInvert(input.autoIntro ?? defaults.autoIntro ?? true);
  const audioMs = input.audioMs ?? defaults.audioMs ?? 0;
  settings.audioMs = typeof audioMs === 'string' && audioMs.trim() === '' ? 0 : Number(audioMs);
  if (!Number.isSafeInteger(settings.audioMs) || settings.audioMs < 0 || settings.audioMs > 9999) {
    throw new Error('音频块长需要 0–9999 的整数（0 表示不处理音频）');
  }
  // Settings saved before the mirror existed describe reversal-only uploads.
  settings.audioMirror = parseFlag(input.audioMirror ?? defaults.audioMirror ?? false, '频谱翻转');
  return settings;
}

/** No truthiness conversion: the URL string "false" must stay false. */
export function parseInvert(value) {
  return parseFlag(value, 'invert');
}

function parseFlag(value, name) {
  if (value === true || value === 'true' || value === '1') return true;
  if (value === false || value === 'false' || value === '0') return false;
  throw new Error(`${name} 需要 true/false 或 1/0`);
}

/** Explicit URL overrides only; avoid colliding with the site's own query fields. */
export function querySettings(search) {
  const query = new URLSearchParams(search);
  const settings = {};
  for (const name of ['width', 'height', 'tile', 'margin', 'seed', 'invert']) {
    const value = query.get(`vc_${name}`) ?? (name === 'tile' ? query.get('vc_tail') : null);
    if (value !== null) settings[name] = value;
  }
  return settings;
}

/** Explicit, user-triggered import of labelled fields; never infer dimensions from playback resolution. */
export function descriptionSettings(text) {
  const patterns = {
    width: /(?:原始\s*)?(?:宽度|宽)\s*[:：=]?\s*([0-9]+)/u,
    height: /(?:原始\s*)?(?:高度|高)\s*[:：=]?\s*([0-9]+)/u,
    tile: /\b(?:tile|tail)\s*[:：=]?\s*([0-9]+)/iu,
    margin: /\bmargin\s*[:：=]?\s*([0-9]+)/iu,
    seed: /\bseed\s*[:：=]?\s*([^\s，,；;]+)/iu,
  };
  const values = {};
  for (const [name, pattern] of Object.entries(patterns)) {
    const match = pattern.exec(text);
    if (!match) throw new Error(`简介缺少明确的 ${name} 参数，请手动填写。`);
    values[name] = match[1];
  }
  const invert = /(?:\binvert\b|反色)\s*[:：=]?\s*(true|false|1|0)(?!\w)/iu.exec(text);
  if (/(?:\binvert\b|反色)/iu.test(text) && !invert) throw new Error('简介中的 invert 需要 true/false 或 1/0');
  values.invert = invert ? parseInvert(invert[1].toLowerCase()) : false;
  return values;
}

/** What a remembered page holds: the plan, never the global preferences. */
const PLAN_FIELDS = ['width', 'height', 'tile', 'margin', 'seed', 'invert', 'audioMs', 'audioMirror'];

/** One page's remembered plan, or null when it is absent or unusable. */
export function pageSettings(pages, key) {
  const entry = pages && key && typeof pages === 'object' ? pages[key] : null;
  if (!entry || typeof entry !== 'object' || !entry.settings || typeof entry.settings !== 'object') return null;
  const settings = {};
  for (const name of PLAN_FIELDS) {
    if (entry.settings[name] !== undefined) settings[name] = entry.settings[name];
  }
  if (Object.keys(settings).length === 0) return null;
  // Remembered before the mirror existed: that upload was reversed only.
  if (settings.audioMs !== undefined && settings.audioMirror === undefined) settings.audioMirror = false;
  // Only 'intro' means a checksummed header proved this page is a VeilCast upload.
  return { settings, source: entry.source === 'intro' ? 'intro' : 'manual', savedAt: Number(entry.savedAt) || 0 };
}

/** Remembers one page's plan, oldest entries evicted first. Returns a new store. */
export function rememberPageSettings(pages, key, settings, source, { limit = 50, now = Date.now() } = {}) {
  const store = pages && typeof pages === 'object' ? { ...pages } : {};
  if (!key) return store;
  const plan = {};
  for (const name of PLAN_FIELDS) plan[name] = settings[name];
  const previous = pageSettings(store, key);
  store[key] = {
    settings: plan,
    // Hand-corrected values (a seed the intro did not carry) keep the page verified.
    source: source === 'intro' || previous?.source === 'intro' ? 'intro' : 'manual',
    savedAt: now,
  };
  const keys = Object.keys(store);
  if (keys.length > limit) {
    keys.sort((a, b) => (pageSettings(store, a)?.savedAt ?? 0) - (pageSettings(store, b)?.savedAt ?? 0));
    for (const stale of keys.slice(0, keys.length - limit)) delete store[stale];
  }
  return store;
}

/** Drops one page's remembered plan. Returns a new store. */
export function forgetPageSettings(pages, key) {
  const store = pages && typeof pages === 'object' ? { ...pages } : {};
  delete store[key];
  return store;
}

/** BVID/path and multi-part index identify a video; quality changes do not. */
export function videoPageKey(href) {
  const url = new URL(href);
  return url.pathname.startsWith('/video/') ? `${url.pathname}?p=${url.searchParams.get('p') ?? '1'}` : null;
}
