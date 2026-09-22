// Browser-side restore for VeilCast tile scrambling.
//
// Mirrors veilcast_core: `seededPermutation` is `seeded_permutation` (splitmix64
// + Fisher-Yates) and `createRestorer` is `ShufflePlan::restore` as a WebGL2
// fragment shader. Sampling is done in normalised coordinates of the uploaded
// frame, so a platform that rescales the video does not break the tile grid.

const MASK64 = (1n << 64n) - 1n;
const GOLDEN = 0x9e3779b97f4a7c15n;
const MIX1 = 0xbf58476d1ce4e5b9n;
const MIX2 = 0x94d049bb133111ebn;

/** `permutation[block] = tile`; identical to the Rust implementation for the same seed. */
export function seededPermutation(tileCount, seed) {
  let state = BigInt(seed) & MASK64;
  const next = () => {
    state = (state + GOLDEN) & MASK64;
    let z = state;
    z = ((z ^ (z >> 30n)) * MIX1) & MASK64;
    z = ((z ^ (z >> 27n)) * MIX2) & MASK64;
    return z ^ (z >> 31n);
  };
  const order = Array.from({ length: tileCount }, (_, i) => i);
  for (let i = tileCount - 1; i >= 1; i--) {
    const j = Number(next() % BigInt(i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

/**
 * `seed_from_text`: a plain decimal number within 64 bits is used verbatim,
 * anything else is hashed with 64-bit FNV-1a over its UTF-8 bytes.
 */
export function seedFromText(text) {
  // Rust accepts a leading '+', but no whitespace. Compare the complete
  // match because JavaScript's '$' can also match before a trailing newline.
  if (/^\+?[0-9]+$/.exec(text)?.[0] === text) {
    const number = BigInt(text);
    if (number <= MASK64) return number;
  }
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(text)) {
    hash = ((hash ^ BigInt(byte)) * 0x100000001b3n) & MASK64;
  }
  return hash;
}

/**
 * Tile grid and scrambled-frame geometry for a plan. `width`/`height` are the
 * source size; like the desktop app, the grid runs on the source padded up to
 * a tile multiple (`workWidth`/`workHeight`) and only the source area is shown.
 */
export function planGeometry({ width, height, tile, margin }) {
  for (const [name, value] of Object.entries({ width, height, tile, margin })) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer`);
  }
  if (tile === 0 || width === 0 || height === 0) throw new Error("tile, width and height must be positive");
  const columns = Math.ceil(width / tile);
  const rows = Math.ceil(height / tile);
  const block = tile + 2 * margin;
  if (![block, columns * tile, rows * tile, columns * block, rows * block, columns * rows]
    .every(Number.isSafeInteger)) throw new Error('plan geometry exceeds the safe integer range');
  return {
    columns,
    rows,
    block,
    workWidth: columns * tile,
    workHeight: rows * tile,
    uploadWidth: columns * block,
    uploadHeight: rows * block,
  };
}

/** Layout version of the numeric intro header; mirrors veilcast_core::HEADER_VERSION. */
export const HEADER_VERSION = 1;

function headerChecksum(digits) {
  let r = 0;
  for (const ch of digits) r = (r * 10 + Number(ch)) % 97;
  return String(r).padStart(2, "0");
}

function validateHeaderFields({ width, height, tile, margin, audioMs }) {
  if (!Number.isInteger(width) || width < 1 || width > 9999) throw new Error("header field width is out of range");
  if (!Number.isInteger(height) || height < 1 || height > 9999) throw new Error("header field height is out of range");
  if (!Number.isInteger(tile) || tile < 2 || tile > 998 || tile % 2 !== 0) throw new Error("header field tile is out of range");
  if (!Number.isInteger(margin) || margin < 0 || margin > 98 || margin % 2 !== 0) throw new Error("header field margin is out of range");
  if (!Number.isInteger(audioMs) || audioMs < 0 || audioMs > 9999) throw new Error("header field audio is out of range");
}

/**
 * Digit string of the intro header, identical to IntroHeader::encode in Rust:
 * version(2) width(4) height(4) tile(3) margin(2) flags(1) audio(4) [seed(20)] check(2).
 * `audioMs` is the audio block length (0 = audio untouched). `seed` is the
 * numeric seed (bigint/number) or null; the text a user typed goes through
 * seedFromText first.
 */
export function encodeIntroHeader({ width, height, tile, margin, invert = false, audioMs = 0, seed = null }) {
  validateHeaderFields({ width, height, tile, margin, audioMs });
  const pad = (value, digits) => String(value).padStart(digits, "0");
  let digits = pad(HEADER_VERSION, 2) + pad(width, 4) + pad(height, 4) + pad(tile, 3) + pad(margin, 2) + (invert ? "1" : "0") + pad(audioMs, 4);
  if (seed !== null && seed !== undefined) {
    const value = BigInt(seed);
    if (value < 0n || value > MASK64) throw new Error("header field seed is out of range");
    digits += pad(value, 20);
  }
  return digits + headerChecksum(digits);
}

/** Parses a digit string produced by encodeIntroHeader / IntroHeader::encode; throws on anything invalid. */
export function parseIntroHeader(text) {
  if (typeof text !== "string" || !/^[0-9]*$/.test(text)) throw new Error("header must contain only decimal digits");
  if (text.length !== 22 && text.length !== 42) throw new Error(`header must be 22 or 42 digits, got ${text.length}`);
  const version = Number(text.slice(0, 2));
  if (version !== HEADER_VERSION) throw new Error(`unknown header version ${version}`);
  if (text.slice(-2) !== headerChecksum(text.slice(0, -2))) throw new Error("header checksum mismatch");
  const flags = Number(text[15]);
  if (flags > 1) throw new Error("header field flags is out of range");
  let seed = null;
  if (text.length === 42) {
    seed = BigInt(text.slice(20, 40));
    if (seed > MASK64) throw new Error("header field seed is out of range");
  }
  const header = {
    width: Number(text.slice(2, 6)),
    height: Number(text.slice(6, 10)),
    tile: Number(text.slice(10, 13)),
    margin: Number(text.slice(13, 15)),
    invert: flags === 1,
    audioMs: Number(text.slice(16, 20)),
    seed,
  };
  validateHeaderFields(header);
  return header;
}

/**
 * Reads the intro header from a playing <video>: grabs frames at
 * `intervalMs` while the playhead is before `untilSeconds`, hands each to
 * `decode(imageData) -> string | null` (e.g. jsQR), and resolves with the
 * first parseable header, or null when the intro window passes without one.
 * Frames are downscaled to `maxWidth` before decoding; QR readers prefer
 * modest resolutions and it keeps the cost to a few milliseconds per frame.
 */
export function scanIntro(video, { decode, untilSeconds = 1.5, intervalMs = 100, maxWidth = 640, maxMillis = 5000, signal } = {}) {
  if (typeof decode !== "function") throw new Error("scanIntro needs a decode(imageData) function");
  // A paused playhead inside the intro window never advances past it, so the
  // poll also needs a wall-clock bound to end on ordinary videos.
  const startedAt = Date.now();
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { willReadFrequently: true });
  return new Promise((resolve, reject) => {
    let timer = 0;
    const stop = (value) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const onAbort = () => stop(null);
    signal?.addEventListener("abort", onAbort, { once: true });
    const attempt = () => {
      try {
        if (video.readyState >= 2 && video.videoWidth > 0) {
          const scale = Math.min(1, maxWidth / video.videoWidth);
          canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
          canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
          context.drawImage(video, 0, 0, canvas.width, canvas.height);
          const text = decode(context.getImageData(0, 0, canvas.width, canvas.height));
          if (text) {
            try {
              return stop(parseIntroHeader(text.trim()));
            } catch {
              // A QR code that is not ours; keep looking until the window closes.
            }
          }
        }
        if (video.ended || video.currentTime > untilSeconds || Date.now() - startedAt >= maxMillis) {
          return stop(null);
        }
        timer = setTimeout(attempt, intervalMs);
      } catch (error) {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        reject(error);
      }
    };
    attempt();
  });
}

const VERTEX_SHADER = `#version 300 es
const vec2 corners[3] = vec2[3](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
out vec2 vUv;
void main() {
  vec2 p = corners[gl_VertexID];
  gl_Position = vec4(p, 0.0, 1.0);
  // Texture row 0 is the top of the video, so flip y from clip space.
  vUv = vec2(p.x, -p.y) * 0.5 + 0.5;
}`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
uniform sampler2D uVideo;
uniform usampler2D uBlockOfTile;
uniform ivec2 uGrid;
uniform int uTile;
uniform int uMargin;
uniform bool uInvert;
uniform vec2 uOriginal;
uniform vec2 uUpload;
in vec2 vUv;
out vec4 outColor;
void main() {
  vec2 p = vUv * uOriginal;
  ivec2 t = min(ivec2(p) / uTile, uGrid - 1);
  uint block = texelFetch(uBlockOfTile, t, 0).r;
  ivec2 b = ivec2(int(block) % uGrid.x, int(block) / uGrid.x);
  vec2 within = p - vec2(t * uTile);
  float blockSize = float(uTile + 2 * uMargin);
  vec2 src = vec2(b) * blockSize + float(uMargin) + within;
  vec4 color = texture(uVideo, src / uUpload);
  outColor = vec4(uInvert ? vec3(1.0) - color.rgb : color.rgb, color.a);
}`;

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('WebGL shader allocation failed');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(message);
  }
  return shader;
}

/**
 * Builds a restorer on a WebGL2 context. `draw(video)` uploads the current
 * frame of an HTMLVideoElement (or any TexImageSource showing the scrambled
 * frame) and renders the restored picture over the whole viewport.
 */
export function createRestorer(gl, params) {
  const { width, height, tile, margin, seed, invert = false } = params;
  if (typeof invert !== 'boolean') throw new Error('invert must be a boolean');
  const geometry = planGeometry(params);
  const { columns, rows } = geometry;

  const maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  if (columns > maxTexture || rows > maxTexture) throw new Error('tile grid exceeds the GPU texture limit');

  const permutation = seededPermutation(columns * rows, seedFromText(String(seed)));
  const blockOfTile = new Uint32Array(columns * rows);
  permutation.forEach((tileIndex, block) => {
    blockOfTile[tileIndex] = block;
  });

  const program = gl.createProgram();
  if (!program) throw new Error('WebGL program allocation failed');
  const shaders = [];
  try {
    shaders.push(compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER));
    shaders.push(compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER));
    for (const shader of shaders) gl.attachShader(program, shader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program));
    }
  } catch (error) {
    gl.deleteProgram(program);
    throw error;
  } finally {
    for (const shader of shaders) {
      // Deleting attached shaders only marks them for deletion until the
      // program is destroyed; detaching frees them immediately after linking.
      if (gl.isProgram(program)) gl.detachShader(program, shader);
      gl.deleteShader(shader);
    }
  }
  gl.useProgram(program);

  const uniform = (name) => gl.getUniformLocation(program, name);
  gl.uniform1i(uniform('uVideo'), 0);
  gl.uniform1i(uniform('uBlockOfTile'), 1);
  gl.uniform2i(uniform('uGrid'), columns, rows);
  gl.uniform1i(uniform('uTile'), tile);
  gl.uniform1i(uniform('uMargin'), margin);
  gl.uniform1i(uniform('uInvert'), invert ? 1 : 0);
  gl.uniform2f(uniform('uOriginal'), width, height);
  gl.uniform2f(uniform('uUpload'), geometry.uploadWidth, geometry.uploadHeight);

  const videoTexture = gl.createTexture();
  const mapTexture = gl.createTexture();
  if (!videoTexture || !mapTexture) {
    gl.deleteTexture(videoTexture);
    gl.deleteTexture(mapTexture);
    gl.useProgram(null);
    gl.deleteProgram(program);
    throw new Error('WebGL texture allocation failed');
  }
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, videoTexture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, mapTexture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32UI, columns, rows, 0, gl.RED_INTEGER, gl.UNSIGNED_INT, blockOfTile);

  if (gl.getError() !== gl.NO_ERROR) {
    gl.deleteTexture(videoTexture);
    gl.deleteTexture(mapTexture);
    gl.useProgram(null);
    gl.deleteProgram(program);
    throw new Error('WebGL tile map upload failed');
  }

  let destroyed = false;
  return {
    geometry,
    draw(source) {
      if (destroyed) throw new Error('restorer has been destroyed');
      if ((source.videoWidth ?? source.width) > maxTexture ||
          (source.videoHeight ?? source.height) > maxTexture) {
        throw new Error('video exceeds the GPU texture limit');
      }
      gl.useProgram(program);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, mapTexture);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, videoTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      gl.deleteTexture(videoTexture);
      gl.deleteTexture(mapTexture);
      if (gl.getParameter(gl.CURRENT_PROGRAM) === program) gl.useProgram(null);
      gl.deleteProgram(program);
    },
  };
}
