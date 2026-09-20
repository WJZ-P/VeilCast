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
  return settings;
}

/** No truthiness conversion: the URL string "false" must stay false. */
export function parseInvert(value) {
  if (value === true || value === 'true' || value === '1') return true;
  if (value === false || value === 'false' || value === '0') return false;
  throw new Error('invert 需要 true/false 或 1/0');
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

/** BVID/path and multi-part index identify a video; quality changes do not. */
export function videoPageKey(href) {
  const url = new URL(href);
  return url.pathname.startsWith('/video/') ? `${url.pathname}?p=${url.searchParams.get('p') ?? '1'}` : null;
}
