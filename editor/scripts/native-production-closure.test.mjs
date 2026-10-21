import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { verifyNativeProductionClosure } from './native-production-closure.mjs';

async function fixture(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'noveltea-native-closure-'));
  try {
    const electron = path.join(root, 'dist-electron');
    const island = path.join(root, 'dist-scriptc-island');
    await mkdir(path.join(electron, 'main'), { recursive: true });
    await mkdir(island, { recursive: true });
    return await run({ electron, island });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('clean emitted Electron and ScriptC production closure is accepted', async () => {
  await fixture(async ({ electron, island }) => {
    await writeFile(
      path.join(electron, 'main', 'main.cjs'),
      '//#region src/main/services/native-editor-session-controller.ts\nmodule.exports = {};\n',
    );
    await writeFile(
      path.join(island, 'noveltea-scriptc-island.mjs'),
      '//#region scripts/noveltea-scriptc-island.ts\nexport const native = true;\n',
    );
    assert.deepEqual(await verifyNativeProductionClosure([electron, island]), []);
  });
});

test('retired workspace authority is rejected from a renamed Electron chunk using its source map', async () => {
  await fixture(async ({ electron, island }) => {
    const target = path.join(electron, 'main', 'main.cjs');
    await writeFile(target, 'module.exports = { native: true };\n');
    await writeFile(
      `${target}.map`,
      JSON.stringify({
        version: 3,
        sources: [
          '../../src/shared/project-workspace/project-workspace-service.ts',
          '../../src/main/services/native-authoring-worker.ts',
        ],
        mappings: '',
      }),
    );
    await writeFile(
      path.join(island, 'island.mjs'),
      '//#region scripts/noveltea-scriptc-island.ts\nexport {};\n',
    );
    assert.match(
      (await verifyNativeProductionClosure([electron, island])).join('\n'),
      /main\/main\.cjs.*project-workspace-service\.ts/,
    );
  });
});

test('retired source analysis is rejected from emitted ScriptC chunks without maps', async () => {
  await fixture(async ({ electron, island }) => {
    await writeFile(
      path.join(electron, 'main', 'main.cjs'),
      '//#region src/main.ts\nmodule.exports = {};\n',
    );
    await writeFile(
      path.join(island, 'unexpected.mjs'),
      '//#region src/shared/authoring-dependency-graph.ts\nexport const oldGraph = true;\n',
    );
    assert.match(
      (await verifyNativeProductionClosure([electron, island])).join('\n'),
      /unexpected\.mjs.*authoring-dependency-graph\.ts/,
    );
  });
});

test('missing build output and untraceable bundled code fail closed', async () => {
  await fixture(async ({ electron, island }) => {
    await writeFile(path.join(electron, 'main', 'main.cjs'), 'module.exports = 42;');
    assert.match(
      (await verifyNativeProductionClosure([electron, island])).join('\n'),
      /no module provenance.*main\/main\.cjs/,
    );
    assert.match(
      (await verifyNativeProductionClosure([electron, path.join(island, 'missing')])).join('\n'),
      /missing production output/,
    );
  });
});

test('pure emitted ESM forwarding chunks do not need redundant provenance', async () => {
  await fixture(async ({ electron, island }) => {
    await writeFile(
      path.join(electron, 'main', 'main.cjs'),
      '//#region src/main.ts\nmodule.exports = {};\n',
    );
    await writeFile(
      path.join(island, 'forwarder.mjs'),
      'import "./safe.mjs";\nimport { n as native } from "./safe.mjs";\nexport { native };\n',
    );
    await writeFile(
      path.join(island, 'safe.mjs'),
      '//#region src/cli/native-project-reads-cli.ts\nexport const n = 1;\n',
    );
    assert.deepEqual(await verifyNativeProductionClosure([electron, island]), []);
  });
});

test('production module manifests certify minified chunks without source maps', async () => {
  await fixture(async ({ electron, island }) => {
    const code = '(()=>{const a=1;globalThis.example=a})()';
    const emitted = path.join(electron, 'main', 'main.cjs');
    await writeFile(emitted, code);
    await writeFile(
      path.join(electron, 'native-production-provenance.json'),
      JSON.stringify({
        version: 1,
        chunks: {
          'main/main.cjs': {
            sha256: createHash('sha256').update(code).digest('hex'),
            modules: ['src/main.ts', 'src/main/services/native-editor-session-controller.ts'],
          },
        },
      }),
    );
    await writeFile(
      path.join(island, 'scriptc.mjs'),
      '//#region scripts/noveltea-scriptc-island.ts\nexport {};\n',
    );
    assert.deepEqual(await verifyNativeProductionClosure([electron, island]), []);
    await writeFile(emitted, `${code}\n// modified after the manifest was generated`);
    assert.match(
      (await verifyNativeProductionClosure([electron, island])).join('\n'),
      /hash mismatch.*main\/main\.cjs/,
    );
  });
});

test('production manifests reject hidden retired modules and missing chunks', async () => {
  await fixture(async ({ electron, island }) => {
    const code = 'export const value=1;';
    await writeFile(path.join(island, 'island.mjs'), code);
    await writeFile(
      path.join(island, 'native-production-provenance.json'),
      JSON.stringify({
        version: 1,
        chunks: {
          'island.mjs': {
            sha256: createHash('sha256').update(code).digest('hex'),
            modules: ['src/shared/project-workspace/resident-project-workspace-session.ts'],
          },
        },
      }),
    );
    await writeFile(
      path.join(electron, 'main', 'main.cjs'),
      '//#region src/main.ts\nmodule.exports={};',
    );
    let failures = (await verifyNativeProductionClosure([electron, island])).join('\n');
    assert.match(failures, /island\.mjs.*resident-project-workspace-session\.ts/);
    await writeFile(path.join(island, 'second.mjs'), 'export const native = true;');
    failures = (await verifyNativeProductionClosure([electron, island])).join('\n');
    assert.match(failures, /missing manifest entry.*second\.mjs/);
  });
});

test('a manifest may identify an emitted forwarding-only chunk without owning modules', async () => {
  await fixture(async ({ electron, island }) => {
    await writeFile(
      path.join(electron, 'main', 'main.cjs'),
      '//#region src/main.ts\nmodule.exports = {};',
    );
    const forwarder = 'import "./native.mjs";\n';
    const native = 'export const native = true;\n';
    await writeFile(path.join(island, 'forwarder.mjs'), forwarder);
    await writeFile(path.join(island, 'native.mjs'), native);
    const hash = (text) => createHash('sha256').update(text).digest('hex');
    await writeFile(
      path.join(island, 'native-production-provenance.json'),
      JSON.stringify({
        version: 1,
        chunks: {
          'forwarder.mjs': { sha256: hash(forwarder), modules: [] },
          'native.mjs': { sha256: hash(native), modules: ['src/cli/native-project-reads-cli.ts'] },
        },
      }),
    );
    assert.deepEqual(await verifyNativeProductionClosure([electron, island]), []);
  });
});
