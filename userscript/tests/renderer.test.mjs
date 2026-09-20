import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRestorer } from '../../viewer/veilcast.js';

function mockGl({ compileFailure = 0, linkFailure = false, textureFailure = 0, uploadFailure = false } = {}) {
  const shaders = new Set();
  const programs = new Set();
  const textures = new Set();
  const uniforms = new Map();
  let shaderCount = 0;
  let textureCount = 0;
  let currentProgram = null;
  const methods = {
    resources: { shaders, programs, textures },
    uniforms,
    getUniformLocation: (_program, name) => name,
    uniform1i: (name, value) => uniforms.set(name, value),
    createShader: () => { const s = { id: ++shaderCount }; shaders.add(s); return s; },
    getShaderParameter: (s) => s.id !== compileFailure,
    getShaderInfoLog: () => 'compile failed',
    deleteShader: (s) => shaders.delete(s),
    createProgram: () => { const p = {}; programs.add(p); return p; },
    isProgram: (p) => programs.has(p),
    getProgramParameter: () => !linkFailure,
    getProgramInfoLog: () => 'link failed',
    deleteProgram: (p) => programs.delete(p),
    useProgram: (p) => { currentProgram = p; },
    getParameter: (name) => name === 'CURRENT_PROGRAM' ? currentProgram : 16384,
    createTexture: () => {
      if (++textureCount === textureFailure) return null;
      const t = {}; textures.add(t); return t;
    },
    deleteTexture: (t) => textures.delete(t),
    getError: () => uploadFailure ? 'ERROR' : 'NO_ERROR',
  };
  return new Proxy(methods, {
    get: (object, key) => key in object ? object[key] : /^[A-Z0-9_]+$/.test(key) ? key : () => {},
  });
}

const params = { width: 8, height: 8, tile: 4, margin: 2, seed: '+007' };

test('linked shaders are freed; destroy is idempotent and releases GPU objects', () => {
  const gl = mockGl();
  for (let i = 0; i < 3; i++) {
    const renderer = createRestorer(gl, params);
    assert.equal(gl.resources.shaders.size, 0);
    assert.equal(gl.resources.programs.size, 1);
    assert.equal(gl.resources.textures.size, 2);
    renderer.destroy();
    renderer.destroy();
    assert.equal(gl.resources.programs.size, 0);
    assert.equal(gl.resources.textures.size, 0);
    assert.throws(() => renderer.draw({ width: 8, height: 8 }), /destroyed/);
  }
});

test('initialization failures clean up shaders, programs and textures', () => {
  for (const failure of [{ compileFailure: 1 }, { compileFailure: 2 }, { linkFailure: true },
    { textureFailure: 1 }, { textureFailure: 2 }, { uploadFailure: true }]) {
    const gl = mockGl(failure);
    assert.throws(() => createRestorer(gl, params));
    for (const resources of Object.values(gl.resources)) assert.equal(resources.size, 0);
  }
});

test('shader inversion is opt-in and sets its uniform explicitly', () => {
  for (const invert of [undefined, false, true]) {
    const gl = mockGl();
    const renderer = createRestorer(gl, { ...params, invert });
    assert.equal(gl.uniforms.get('uInvert'), invert ? 1 : 0);
    renderer.destroy();
  }
  assert.throws(() => createRestorer(mockGl(), { ...params, invert: 'false' }), /boolean/);
});
