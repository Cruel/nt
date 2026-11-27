import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const icon = fileURLToPath(new URL('../../editor/branding/windows/icon.ico', import.meta.url));

test('Windows packaging uses a complete native multi-resolution ICO', () => {
  const config = readFileSync(new URL('../../editor/electron-builder.config.mjs', import.meta.url), 'utf8');
  assert.match(config, /win: \{[\s\S]*?icon: path\.join\(buildResourcesRoot, 'windows', 'icon\.ico'\)/);
  const bytes = readFileSync(icon);
  assert.equal(bytes.readUInt32LE(0), 0x00010000);
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  assert.equal(bytes.readUInt16LE(4), sizes.length);
  let offset = 6 + sizes.length * 16;
  for (const [i, size] of sizes.entries()) {
    const entry = 6 + i * 16;
    assert.equal(bytes[entry] || 256, size);
    assert.equal(bytes[entry + 1] || 256, size);
    assert.equal(bytes.readUInt16LE(entry + 6), 32);
    assert.equal(bytes.readUInt32LE(entry + 12), offset);
    const length = bytes.readUInt32LE(entry + 8);
    assert.ok(length > 40 && offset + length <= bytes.length);
    if (size === 256) {
      assert.equal(bytes.subarray(offset, offset + 8).toString('hex'), '89504e470d0a1a0a');
      assert.equal(bytes.readUInt32BE(offset + 16), size);
      assert.equal(bytes.readUInt32BE(offset + 20), size);
    } else {
      assert.equal(bytes.readUInt32LE(offset), 40);
      assert.equal(bytes.readInt32LE(offset + 4), size);
      assert.equal(bytes.readInt32LE(offset + 8), size * 2);
      assert.equal(length, 40 + size * size * 4 + Math.ceil(size / 32) * 4 * size);
    }
    offset += length;
  }
  assert.equal(offset, bytes.length);
});

test('pinned Electron Builder accepts the ICO directly without launching icon conversion', async () => {
  const require = createRequire(new URL('../../editor/package.json', import.meta.url));
  const builderRequire = createRequire(require.resolve('electron-builder/package.json'));
  const builderRoot = path.dirname(builderRequire.resolve('app-builder-lib/package.json'));
  const { convertIcon } = require(path.join(builderRoot, 'out/util/iconConverter.js'));
  const root = mkdtempSync(path.join(tmpdir(), 'nt-windows-icon-'));
  try {
    const outDir = path.join(root, 'conversion-output');
    const result = await convertIcon({ sources: [icon], fallbackSources: [], roots: [root], format: 'ico', outDir });
    assert.deepEqual(result, { icons: [{ file: icon, size: 256 }], isFallback: false });
    assert.equal(existsSync(outDir), false, 'No conversion work should run for the native ICO');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
