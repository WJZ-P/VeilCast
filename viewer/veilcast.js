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
  if (/^\d+$/.test(text)) {
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
    if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  }
  if (tile === 0 || width === 0 || height === 0) throw new Error("tile, width and height must be positive");
  const columns = Math.ceil(width / tile);
  const rows = Math.ceil(height / tile);
  const block = tile + 2 * margin;
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
  outColor = texture(uVideo, src / uUpload);
}`;

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(shader));
  }
  return shader;
}

/**
 * Builds a restorer on a WebGL2 context. `draw(video)` uploads the current
 * frame of an HTMLVideoElement (or any TexImageSource showing the scrambled
 * frame) and renders the restored picture over the whole viewport.
 */
export function createRestorer(gl, params) {
  const { width, height, tile, margin, seed } = params;
  const geometry = planGeometry(params);
  const { columns, rows } = geometry;

  const permutation = seededPermutation(columns * rows, seedFromText(String(seed)));
  const blockOfTile = new Uint32Array(columns * rows);
  permutation.forEach((tileIndex, block) => {
    blockOfTile[tileIndex] = block;
  });

  const program = gl.createProgram();
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program));
  }
  gl.useProgram(program);

  const uniform = (name) => gl.getUniformLocation(program, name);
  gl.uniform1i(uniform('uVideo'), 0);
  gl.uniform1i(uniform('uBlockOfTile'), 1);
  gl.uniform2i(uniform('uGrid'), columns, rows);
  gl.uniform1i(uniform('uTile'), tile);
  gl.uniform1i(uniform('uMargin'), margin);
  gl.uniform2f(uniform('uOriginal'), width, height);
  gl.uniform2f(uniform('uUpload'), geometry.uploadWidth, geometry.uploadHeight);

  const videoTexture = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, videoTexture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  const mapTexture = gl.createTexture();
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, mapTexture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32UI, columns, rows, 0, gl.RED_INTEGER, gl.UNSIGNED_INT, blockOfTile);

  return {
    geometry,
    draw(source) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, videoTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
    destroy() {
      gl.deleteTexture(videoTexture);
      gl.deleteTexture(mapTexture);
      gl.deleteProgram(program);
    },
  };
}
