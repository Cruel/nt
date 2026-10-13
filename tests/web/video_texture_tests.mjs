import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const requestBuildArgument = process.argv.indexOf('--request-build-dir');
if (requestBuildArgument !== -1) {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const cmakeFiles = path.resolve(root, process.argv[requestBuildArgument + 1], 'CMakeFiles');
  const version = (await fs.readdir(cmakeFiles)).filter((name) => /^\d+\.\d+/u.test(name)).sort().at(-1);
  const metadata = await fs.readFile(path.join(cmakeFiles, version, 'CMakeCXXCompiler.cmake'), 'utf8');
  const compiler = metadata.match(/set\(CMAKE_CXX_COMPILER "([^"]+)"\)/u)?.[1];
  assert.ok(compiler && path.basename(compiler) === 'em++', 'Expected a configured Emscripten build');
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-video-request-'));
  try {
    const output = path.join(temporary, 'request.js');
    const compiled = spawnSync(compiler, ['-std=c++20', '-fno-exceptions', '-fno-rtti',
      '-Iengine/include', 'tests/web/prepared_video_texture_tests.cpp',
      'engine/src/assets/prepared_video_texture.cpp', '-sENVIRONMENT=node', '-o', output], {
      cwd: root, stdio: 'inherit',
      env: { ...process.env, EMCC_CORES: process.env.CMAKE_BUILD_PARALLEL_LEVEL || '1' },
    });
    assert.equal(compiled.status, 0, 'Web request test compilation failed');
    assert.equal(spawnSync(process.execPath, [output], { stdio: 'inherit' }).status, 0);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

const library = await fs.readFile(new URL('../../web/video_texture.js', import.meta.url), 'utf8');
const media = await fs.readFile(new URL('./fixtures/opaque-colors.webm', import.meta.url));
const browser = await chromium.launch({ headless: true,
  args: process.env.NOVELTEA_WEB_SMOKE_ANGLE_BACKEND
    ? ['--use-gl=angle', `--use-angle=${process.env.NOVELTEA_WEB_SMOKE_ANGLE_BACKEND}`] : [],
});
try {
  const page = await browser.newPage();
  await page.route('http://localhost:7777/', (route) => route.fulfill({
    contentType: 'text/html', body: '<!doctype html><body></body>',
    headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' },
  }));
  await page.goto('http://localhost:7777/');
  await page.evaluate((bytes) => {
    const memory = new SharedArrayBuffer(512 * 1024);
    globalThis.HEAPU8 = new Uint8Array(memory);
    globalThis.HEAP32 = new Int32Array(memory);
    HEAPU8.set(bytes, 1024);
    globalThis.mediaUrls = { live: 0, maximum: 0, created: 0 };
    const create = URL.createObjectURL;
    const revoke = URL.revokeObjectURL;
    URL.createObjectURL = (blob) => {
      mediaUrls.created++;
      mediaUrls.maximum = Math.max(mediaUrls.maximum, ++mediaUrls.live);
      return create(blob);
    };
    URL.revokeObjectURL = (url) => { mediaUrls.live--; revoke(url); };
    globalThis.stringToUTF8 = (text, address, capacity) => {
      const encoded = new TextEncoder().encode(text).slice(0, capacity - 1);
      HEAPU8.set(encoded, address);
      HEAPU8[address + encoded.length] = 0;
    };
    globalThis.addToLibrary = (value) => {
      globalThis.NTVideoTextures = value.$NTVideoTextures;
      for (const name of ['create', 'sample', 'upload', 'cancel', 'dispose'])
        globalThis[name] = value[`nt_web_video_${name}`];
    };
    CanvasRenderingContext2D.prototype.getImageData = () => { throw new Error('CPU video readback is forbidden'); };
    const canvas = document.createElement('canvas');
    canvas.width = 96;
    canvas.height = 64;
    document.body.append(canvas);
    globalThis.GLctx = canvas.getContext('webgl2');
    if (!GLctx) throw new Error('WebGL2 is unavailable');
    globalThis.GL = { textures: [null] };
    for (let i = 0; i < 3; ++i) {
      const texture = GLctx.createTexture();
      GL.textures.push(texture);
      GLctx.bindTexture(GLctx.TEXTURE_2D, texture);
      GLctx.texImage2D(GLctx.TEXTURE_2D, 0, GLctx.RGBA, 96, 64, 0, GLctx.RGBA, GLctx.UNSIGNED_BYTE, null);
    }
    // Read back only the certification pixel from the actual GPU texture, never decoder memory.
    globalThis.pixel = (id) => {
      const fbo = GLctx.createFramebuffer();
      GLctx.bindFramebuffer(GLctx.FRAMEBUFFER, fbo);
      GLctx.framebufferTexture2D(GLctx.FRAMEBUFFER, GLctx.COLOR_ATTACHMENT0, GLctx.TEXTURE_2D, GL.textures[id], 0);
      const value = new Uint8Array(4);
      GLctx.readPixels(48, 32, 1, 1, GLctx.RGBA, GLctx.UNSIGNED_BYTE, value);
      GLctx.bindFramebuffer(GLctx.FRAMEBUFFER, null);
      GLctx.deleteFramebuffer(fbo);
      return [...value];
    };
  }, [...media]);
  await page.addScriptTag({ content: library });
  const ids = await page.evaluate((length) => [create(1024, length, 96, 64), create(1024, length, 96, 64)], media.length);
  await page.evaluate(([one, two]) => {
    sample(one, 750.5, 16, 128, 256);
    sample(two, 1750, 20, 384, 256);
  }, ids);
  await page.waitForFunction(() => HEAP32[4] !== 0 && HEAP32[5] !== 0);
  const result = await page.evaluate(([one, two]) => ({
    states: [...HEAP32.slice(4, 6)],
    uploaded: [upload(one, 1, 128, 256), upload(two, 2, 384, 256)],
    green: pixel(1), blue: pixel(2), urls: { ...mediaUrls },
    errors: [128, 384].map((start) => new TextDecoder().decode(HEAPU8.slice(start, start + 256)).split('\0')[0]),
    gpu: { contextLost: GLctx.isContextLost(), textureSlots: GL.textures.map(Boolean),
      contextStatus: GLctx.getError() },
  }), ids);
  assert.deepEqual(result.states, [1, 1]);
  assert.deepEqual(result.uploaded, [1, 1], JSON.stringify(result));
  assert.ok(result.green[1] > 80 && result.green[0] < 30 && result.green[2] < 30, `Expected green: ${result.green}`);
  assert.ok(result.blue[2] > 200 && result.blue[0] < 30 && result.blue[1] < 30, `Expected blue: ${result.blue}`);
  assert.equal(result.urls.live, 2);
  // Rewinds, endpoints and repeated holds reuse the two independent decoders and textures.
  for (let round = 0; round < 12; ++round) {
    if (round > 0) {
      await page.evaluate(([one, two]) => {
        sample(one, 750.5, 16, 128, 256);
        sample(two, 1750, 20, 384, 256);
      }, ids);
      await page.waitForFunction(() => HEAP32[4] !== 0 && HEAP32[5] !== 0);
      assert.deepEqual(await page.evaluate(([one, two]) => [upload(one, 1, 128, 256), upload(two, 2, 384, 256)], ids), [1, 1]);
    }
    const started = Date.now();
    await page.evaluate(([one, two]) => {
      sample(one, 0, 16, 128, 256);
      sample(two, 2000, 20, 384, 256);
    }, ids);
    await page.waitForFunction(() => HEAP32[4] !== 0 && HEAP32[5] !== 0);
    const held = await page.evaluate(([one, two]) => {
      const original = GLctx.texSubImage2D;
      let uploads = 0;
      GLctx.texSubImage2D = function(...args) { uploads++; return original.apply(this, args); };
      const uploaded = [upload(one, 1, 128, 256), upload(two, 2, 384, 256)];
      for (let tick = 0; tick < 60; ++tick) upload(one, 1, 128, 256);
      GLctx.texSubImage2D = original;
      return { uploaded, uploads, red: pixel(1), blue: pixel(2), created: mediaUrls.created };
    }, ids);
    assert.deepEqual(held.uploaded, [1, 1]);
    assert.equal(held.uploads, 2, 'Held samples must not upload on render ticks');
    assert.equal(held.created, 2, 'Seeks must retain decoder/source ownership');
    assert.ok(held.red[0] > 200 && held.red[1] < 30 && held.red[2] < 30, `Expected red: ${held.red}`);
    assert.ok(held.blue[2] > 200 && held.blue[0] < 30 && held.blue[1] < 30, `Expected endpoint blue: ${held.blue}`);
    assert.ok(Date.now() - started < 5000, 'Tiny fixture directed seek exceeded the certification latency bound');
  }
  // A hidden/obsolete seek may be canceled while the decoder remains live. Its callbacks
  // must not write a reclaimed status slot or poison the next directed sample.
  await page.evaluate(([one]) => {
    sample(one, 1750, 16, 128, 256);
    cancel(one);
    HEAP32[4] = 43;
    sample(one, 750.5, 16, 128, 256);
  }, ids);
  await page.waitForFunction(() => HEAP32[4] !== 0 && HEAP32[4] !== 43);
  assert.equal(await page.evaluate(() => HEAP32[4]), 1);
  const resumed = await page.evaluate(([one]) => ({
    uploaded: upload(one, 1, 128, 256), color: pixel(1), created: mediaUrls.created,
  }), ids);
  assert.equal(resumed.uploaded, 1);
  assert.ok(resumed.color[1] > 80 && resumed.color[0] < 30 && resumed.color[2] < 30);
  assert.equal(resumed.created, 2);
  await page.evaluate((ids) => { for (const id of ids) dispose(id); }, ids);
  assert.equal(await page.evaluate(() => mediaUrls.live), 0);

  const queuedIds = await page.evaluate((length) => {
    mediaUrls.created = mediaUrls.maximum = 0;
    const ids = Array.from({ length: 4 }, () => create(1024, length, 96, 64));
    ids.forEach((id, index) => sample(id, 750.5, 16 + index * 4, 128 + index * 128, 128));
    dispose(ids.pop());
    return ids;
  }, media.length);
  await page.waitForFunction(() => [...HEAP32.slice(4, 7)].every((state) => state !== 0));
  assert.deepEqual(await page.evaluate(() => [...HEAP32.slice(4, 8)]), [1, 1, 1, 0]);
  assert.equal(await page.evaluate(() => mediaUrls.created), 3, 'Queued cancellation must not create a decoder');
  await page.evaluate((ids) => { for (const id of ids) dispose(id); }, queuedIds);

  await page.evaluate((length) => {
    const id = create(1024, length, 96, 64);
    sample(id, 1750, 16, 128, 256);
    cancel(id);
    // The task's status storage may be reused immediately after cancellation.
    HEAP32[4] = 42;
    dispose(id);
  }, media.length);
  await page.waitForTimeout(100);
  assert.deepEqual(await page.evaluate(() => [HEAP32[4], mediaUrls.live]), [42, 0]);

  for (const [length, width, expected] of [[4, 96, /cannot decode/u], [media.length, 95, /dimensions/u]]) {
    const id = await page.evaluate(({ length, width }) => {
      const id = create(1024, length, width, 64);
      sample(id, 0, 16, 128, 256);
      return id;
    }, { length, width });
    await page.waitForFunction(() => HEAP32[4] !== 0);
    assert.equal(await page.evaluate(() => HEAP32[4]), -1);
    assert.match(await page.evaluate(() => new TextDecoder().decode(HEAPU8.slice(128, 384)).split('\0')[0]), expected);
    await page.evaluate((id) => dispose(id), id);
  }

  const unsupported = await page.evaluate((length) => {
    const id = create(1024, length, 96, 64);
    sample(id, 0, 16, 128, 256);
    return id;
  }, media.length);
  await page.waitForFunction(() => HEAP32[4] !== 0);
  assert.equal(await page.evaluate((id) => upload(id, 9999, 128, 256), unsupported), 0);
  assert.match(await page.evaluate(() => new TextDecoder().decode(HEAPU8.slice(128, 384)).split('\0')[0]), /GPU texture path/u);
  await page.evaluate((id) => dispose(id), unsupported);
  assert.equal(await page.evaluate(() => mediaUrls.live), 0);
  console.log('[web-video-texture] persistent independent GPU samples, held uploads, seeks, queue, cancellation and failures passed');
} finally {
  await browser.close();
}
