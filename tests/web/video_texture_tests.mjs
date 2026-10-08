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
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.evaluate((bytes) => {
    const memory = new ArrayBuffer(512 * 1024);
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
      globalThis.start = value.nt_web_video_start;
      globalThis.dispose = value.nt_web_video_dispose;
    };
  }, [...media]);
  await page.addScriptTag({ content: library });
  const length = media.length;
  const ids = await page.evaluate((length) => {
    const one = start(1024, length, 750.5, 96, 64, 32768, 16, 128, 512);
    const two = start(1024, length, 1750, 96, 64, 65536, 20, 640, 256);
    const queued = start(1024, length, 16, 96, 64, 98304, 24, 896, 128);
    dispose(queued);
    return { one, two, created: mediaUrls.created };
  }, length);
  assert.equal(ids.created, 2);
  await page.waitForFunction(() => HEAP32[4] !== 0 && HEAP32[5] !== 0);
  const result = await page.evaluate(() => ({
    states: [HEAP32[4], HEAP32[5], HEAP32[6]],
    green: [...HEAPU8.slice(32768, 32772)],
    blue: [...HEAPU8.slice(65536, 65540)],
    urls: { ...mediaUrls },
  }));
  assert.deepEqual(result.states, [1, 1, 0]);
  assert.equal(result.urls.live, 0);
  assert.equal(result.urls.maximum, 2);
  assert.equal(result.urls.created, 2);
  assert.ok(result.green[1] > 80 && result.green[0] < 30 && result.green[2] < 30);
  assert.ok(result.blue[2] > 200 && result.blue[0] < 30 && result.blue[1] < 30);
  await page.evaluate(({ one, two }) => { dispose(one); dispose(two); }, ids);

  // Disposal revokes interest before an asynchronous browser callback can touch freed WASM memory.
  await page.evaluate((length) => {
    const id = start(1024, length, 1750, 96, 64, 98304, 24, 896, 128);
    dispose(id);
  }, length);
  await page.waitForTimeout(100);
  assert.deepEqual(await page.evaluate(() => [HEAP32[6], mediaUrls.live]), [0, 0]);

  const failed = await page.evaluate(() => start(1024, 4, 16, 96, 64, 98304, 24, 896, 128));
  await page.waitForFunction(() => HEAP32[6] !== 0);
  assert.equal(await page.evaluate(() => HEAP32[6]), -1);
  const error = await page.evaluate(() => new TextDecoder().decode(HEAPU8.slice(896, 1024)).split('\0')[0]);
  assert.match(error, /cannot decode/u);
  await page.evaluate((id) => { dispose(id); HEAP32[6] = 0; }, failed);

  const mismatch = await page.evaluate((length) => start(1024, length, 16, 95, 64, 98304, 24, 896, 128), length);
  await page.waitForFunction(() => HEAP32[6] !== 0);
  assert.equal(await page.evaluate(() => HEAP32[6]), -1);
  await page.evaluate((id) => dispose(id), mismatch);
  assert.equal(await page.evaluate(() => mediaUrls.live), 0);
  console.log('[web-video-texture] directed decode, independent samples, bounded queue, cancellation and typed failure passed');
} finally {
  await browser.close();
}
